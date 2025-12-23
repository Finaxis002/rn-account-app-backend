// controllers/receiptController.js
const mongoose = require("mongoose");
const ReceiptEntry = require("../models/ReceiptEntry");
const Company = require("../models/Company");
const Party = require("../models/Party");
const User = require("../models/User")
const { getEffectivePermissions } = require("../services/effectivePermissions");
const { getFromCache, setToCache } = require('../RedisCache');
const { deleteReceiptEntryCache, deleteReceiptEntryCacheByUser, flushAllCache } = require("../utils/cacheHelpers");

const { createNotification } = require("./notificationController");
const { resolveActor, findAdminUser } = require("../utils/actorUtils");

// privileged roles that can skip allowedCompanies checks
const PRIV_ROLES = new Set(["master", "client", "admin"]);

function userIsPrivForCompanyAccess(req) {
  // Only master and client should bypass company restrictions
  return req.auth?.role === "master" || req.auth?.role === "client";
}

// NEW: Function for client data access
function userCanAccessAllClientData(req) {
  // Only master should access all clients' data
  return req.auth?.role === "master";
}

async function adjustBalanceGuarded({ partyId, clientId, companyId, delta, session }) {
  if (delta < 0) {
    // deducting → require enough balance for the specific company
    const updated = await Party.findOneAndUpdate(
      { _id: partyId, createdByClient: clientId, [`balances.${companyId}`]: { $gte: -delta } },
      { $inc: { [`balances.${companyId}`]: delta } }, // delta is negative, so it deducts
      { new: true, session, select: { _id: 1, [`balances.${companyId}`]: 1 } }
    );
    return updated; // null if guard failed
  } else {
    // adding back / reducing receipt → always allowed
    return Party.findOneAndUpdate(
      { _id: partyId, createdByClient: clientId },
      { $inc: { [`balances.${companyId}`]: delta } },
      { new: true, session, select: { _id: 1, [`balances.${companyId}`]: 1 } }
    );
  }
}
function sameTenant(a, b) {
  return String(a) === String(b);
}

function userIsPriv(req) {
  return PRIV_ROLES.has(req.auth?.role);
}


async function ensureAuthCaps(req) {
  // Normalize: support stacks still setting req.user
  if (!req.auth && req.user) {
    req.auth = {
      clientId: req.user.id,
      userId: req.user.userId || req.user.id,
      role: req.user.role,
      caps: req.user.caps,
      allowedCompanies: req.user.allowedCompanies,
      // ❌ don't default to "Unknown" — let resolver do the right thing
      userName: req.user.userName,        // may be undefined for clients
      clientName: req.user.contactName,   // if your auth layer provides it for clients
    };
  }
  if (!req.auth) throw new Error("Unauthorized (no auth context)");

  if (!req.auth.caps || !Array.isArray(req.auth.allowedCompanies)) {
    const { caps, allowedCompanies } = await getEffectivePermissions({
      clientId: req.auth.clientId,
      userId: req.auth.userId,
    });
    if (!req.auth.caps) req.auth.caps = caps;
    if (!req.auth.allowedCompanies) req.auth.allowedCompanies = allowedCompanies;
  }

  // Only backfill staff names (not clients)
  if (req.auth.role !== "client" && !req.auth.userName && req.auth.userId) {
    const userDoc = await User.findById(req.auth.userId)
      .select("displayName fullName name userName username email")
      .lean();
    req.auth.userName =
      userDoc?.displayName ||
      userDoc?.fullName ||
      userDoc?.name ||
      userDoc?.userName ||
      userDoc?.username ||
      userDoc?.email ||
      undefined; // no "Unknown"
  }
}


// Build message text per action (receipt wording)
function buildReceiptNotificationMessage(action, { actorName, customerName, oldAmount, newAmount }) {
  const cName = customerName || "Unknown Customer";
  switch (action) {
    case "create":
      return `New receipt entry created by ${actorName} for customer ${cName} of amount ₹${newAmount}.`;
    case "update":
      return `Receipt entry updated by ${actorName} for customer ${cName}. Amount changed from ₹${oldAmount} to ₹${newAmount}.`;
    case "delete":
      return `Receipt entry deleted by ${actorName} for customer ${cName}. Amount ₹${oldAmount} was refunded.`;
    default:
      return `Receipt entry ${action} by ${actorName} for customer ${cName}.`;
  }
}

// Unified notifier for receipt module
async function notifyAdminOnReceiptAction({ req, action, customerName, entryId, companyId, oldAmount, newAmount }) {
  const actor = await resolveActor(req);
  const adminUser = await findAdminUser(companyId);
  if (!adminUser) {
    console.warn("notifyAdminOnReceiptAction: no admin user found");
    return;
  }

  const message = buildReceiptNotificationMessage(action, {
    actorName: actor.name,
    customerName,
    oldAmount,
    newAmount,
  });

  await createNotification(
    message,
    adminUser._id,     // recipient (admin)
    actor.id,          // actor id (user OR client)
    action,            // "create" | "update" | "delete"
    "receipt",         // category for receipt entries
    entryId,           // receipt _id
    req.auth.clientId
  );
}


function companyAllowedForUser(req, companyId) {
  if (userIsPriv(req)) return true;
  const allowed = Array.isArray(req.auth.allowedCompanies)
    ? req.auth.allowedCompanies.map(String)
    : [];
  return allowed.length === 0 || allowed.includes(String(companyId));
}

exports.createReceipt = async (req, res) => {
  try {
    await ensureAuthCaps(req);

    const { party, date, amount, description, paymentMethod, referenceNumber, company: companyId } = req.body;

    if (!party || !companyId) {
      return res.status(400).json({ message: "party and company are required" });
    }
    
    const amt = Number(amount || 0);
    if (!(amt > 0)) {
      return res.status(400).json({ message: "Amount must be > 0" });
    }
    
    if (!companyAllowedForUser(req, companyId)) {
      return res.status(403).json({ message: "You are not allowed to use this company" });
    }

     if (paymentMethod && !["Cash", "UPI", "Bank Transfer", "Cheque"].includes(paymentMethod)) {
      return res.status(400).json({ message: "Invalid payment method" });
    }
    // Ensure company & party belong to this tenant
    const [companyDoc, partyDoc] = await Promise.all([
      Company.findOne({ _id: companyId, client: req.auth.clientId }),
      Party.findOne({ _id: party, createdByClient: req.auth.clientId }).select({ balance: 1, name: 1 }),
    ]);
    
    if (!companyDoc) return res.status(400).json({ message: "Invalid company selected" });
    if (!partyDoc) return res.status(400).json({ message: "Customer not found or unauthorized" });

    // DEBUG: Log current state
    console.log('Creating receipt:', {
      party: partyDoc._id,
      currentBalance: partyDoc.balance,
      amount: amt,
      expectedNewBalance: partyDoc.balance - amt
    });

    let session;
    let receipt;
    let updatedParty;

    try {
      // Try transaction approach first
      session = await mongoose.startSession();
      session.startTransaction();

      // 1) Deduct amount from party balance for specific company
      updatedParty = await Party.findOneAndUpdate(
        { _id: party, createdByClient: req.auth.clientId },
        { $inc: { [`balances.${companyDoc._id}`]: -amt } },
        { new: true, session }
      );

      if (!updatedParty) {
        throw new Error("Failed to update party balance");
      }

      // 2) Create receipt
      [receipt] = await ReceiptEntry.create([{
        party: partyDoc._id,
        date,
        amount: amt,
        description,
        referenceNumber,
        paymentMethod,
        company: companyDoc._id,
        client: req.auth.clientId,
        createdByUser: req.auth.userId,
        type: "receipt",
      }], { session });

      await session.commitTransaction();
      
      console.log('Transaction successful. New balance:', updatedParty.balance);

    } catch (txErr) {
      console.error('Transaction failed, trying fallback:', txErr);
      
      if (session) {
        try { await session.abortTransaction(); } catch (abortErr) {}
        try { session.endSession(); } catch (endErr) {}
      }

      // Fallback: Non-transaction approach
      updatedParty = await Party.findOneAndUpdate(
        { _id: party, createdByClient: req.auth.clientId },
        { $inc: { balance: -amt } },
        { new: true }
      );

      if (!updatedParty) {
        return res.status(400).json({ message: "Failed to update party balance" });
      }

      receipt = await ReceiptEntry.create({
        party: partyDoc._id,
        date,
        amount: amt,
        description,
        referenceNumber,
        paymentMethod,
        company: companyDoc._id,
        client: req.auth.clientId,
        createdByUser: req.auth.userId,
        type: "receipt",
      });

      console.log('Fallback successful. New balance:', updatedParty.balance);
    } finally {
      if (session) {
        try { session.endSession(); } catch (e) {}
      }
    }

    // NEW: Add notification for receipt creation
    await notifyAdminOnReceiptAction({
      req,
      action: "create",
      customerName: partyDoc?.name || partyDoc?.partyName || partyDoc?.customerName,
      entryId: receipt._id,
      companyId: companyDoc._id.toString(),
      newAmount: amt,
    });

    // After successful receipt creation, add:
    // await deleteReceiptEntryCache(req.auth.clientId, companyId);
    // Send response
    return res.status(201).json({
      message: "Receipt entry created",
      receipt,
      updatedBalance: updatedParty.balance,
      balanceContext: updatedParty.balance < 0 
    ? `Customer has credit of ₹${Math.abs(updatedParty.balance)}`
    : `Customer owes ₹${updatedParty.balance}`
    });

  } catch (err) {
    console.error("createReceipt error:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
};

exports.getReceipts = async (req, res) => {
  try {
    await ensureAuthCaps(req); // Ensure auth context is loaded
    
    const filter = {};

    if (!req.auth) return res.status(401).json({ message: "Unauthorized" });

    // Set the client filter based on the authenticated user
    if (req.auth.role === "client") {
      filter.client = req.auth.clientId;
    }

    // Add company filter if provided - WITH VALIDATION
    if (req.query.companyId) {
      const companyId = req.query.companyId;
      
      // Check if user is allowed to access this company
      if (!companyAllowedForUser(req, companyId)) {
        return res.status(403).json({ 
          success: false, 
          message: "Access denied to this company" 
        });
      }
      
      filter.company = companyId;
    } else {
      // If no companyId specified, show only companies the user is allowed to access
      // Use the NEW function that excludes admin from company privilege
      if (!userIsPrivForCompanyAccess(req) && Array.isArray(req.auth.allowedCompanies)) {
        filter.company = { $in: req.auth.allowedCompanies };
      }
    }

    // ... rest of your function remains the same
    const perPage = Math.min(Number(req.query.limit) || 100, 500);
    const skip = (Number(req.query.page) - 1) * perPage;

    const query = ReceiptEntry.find(filter)
      .sort({ date: -1 })
      .skip(skip)
      .limit(perPage)
      .populate({ path: "party", select: "name" })
      .populate({ path: "company", select: "businessName" });

    const [data, total] = await Promise.all([query.lean(), ReceiptEntry.countDocuments(filter)]);

    res.status(200).json({
      success: true,
      total,
      page: Number(req.query.page),
      limit: perPage,
      data,
    });
  } catch (err) {
    console.error("getReceipts error:", err.message);
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
};


exports.updateReceipt = async (req, res) => {
  try {
    await ensureAuthCaps(req);

    const receipt = await ReceiptEntry.findById(req.params.id);
    if (!receipt) return res.status(404).json({ message: "Receipt not found" });

    if (!userIsPriv(req) && !sameTenant(receipt.client, req.auth.clientId)) {
      return res.status(403).json({ message: "Not authorized" });
    }

    const { party, company: newCompanyId, amount, date, description, paymentMethod, referenceNumber } = req.body;
    const newAmount = amount != null ? Number(amount) : undefined;
    if (newAmount != null && !(newAmount > 0)) {
      return res.status(400).json({ message: "Amount must be > 0" });
    }

    // Validate paymentMethod if provided
    if (paymentMethod && !["Cash", "UPI", "Bank Transfer", "Cheque"].includes(paymentMethod)) {
      return res.status(400).json({ message: "Invalid payment method" });
    }

    // Validate company move
    if (newCompanyId) {
      if (!companyAllowedForUser(req, newCompanyId)) {
        return res.status(403).json({ message: "You are not allowed to use this company" });
      }
      const companyDoc = await Company.findOne({ _id: newCompanyId, client: req.auth.clientId });
      if (!companyDoc) return res.status(400).json({ message: "Invalid company selected" });
      receipt.company = companyDoc._id;
    }

    // Validate party move and get party info for notification
    let partyDoc;
    if (party) {
      partyDoc = await Party.findOne({ _id: party, createdByClient: req.auth.clientId });
      if (!partyDoc) return res.status(400).json({ message: "Customer not found or unauthorized" });
      receipt.party = partyDoc._id;
    } else {
      // Get party info for notification if not changing
      partyDoc = await Party.findById(receipt.party);
    }

    // Compute delta - SIMPLIFIED: Apply full delta like create controller
    const oldAmount = Number(receipt.amount || 0);
    const finalAmount = newAmount != null ? newAmount : oldAmount;
    const delta = finalAmount - oldAmount; // >0 means more deduction, <0 means refund

    let session;
    try {
      session = await mongoose.startSession();
      session.startTransaction();

      // Apply full delta to maintain consistency with create logic
      if (delta !== 0) {
        const updatedParty = await adjustBalanceGuarded({
          partyId: receipt.party,
          clientId: req.auth.clientId,
          delta: -delta, // Apply full delta (negative for receipts)
          session,
        });
        if (!updatedParty) {
          throw new Error("Failed to update party balance");
        }
      }

      // Update receipt with new values
      if (newAmount != null) receipt.amount = finalAmount;
      if (date != null) receipt.date = new Date(date);
      if (description !== undefined) receipt.description = description;
      if (paymentMethod !== undefined) receipt.paymentMethod = paymentMethod;
      if (referenceNumber !== undefined) receipt.referenceNumber = referenceNumber;

      await receipt.save({ session });

      await notifyAdminOnReceiptAction({
        req,
        action: "update",
        customerName: partyDoc?.name || partyDoc?.partyName || partyDoc?.customerName,
        entryId: receipt._id,
        companyId: receipt.company.toString(),
        oldAmount: oldAmount,
        newAmount: finalAmount,
      });

      await session.commitTransaction();
      session.endSession();

      const companyId = receipt.company.toString();
      // await deleteReceiptEntryCache(req.auth.clientId, companyId);

      // Get updated party balance for response
      const currentParty = await Party.findById(receipt.party);
      
      return res.json({ 
        message: "Receipt updated successfully", 
        receipt,
        oldAmount,
        newAmount: finalAmount,
        balanceChange: -delta,
        updatedBalance: currentParty.balance,
        balanceContext: currentParty.balance < 0 
          ? `Customer has credit of ₹${Math.abs(currentParty.balance)}`
          : `Customer owes ₹${currentParty.balance}`
      });

    } catch (txErr) {
      if (session) { 
        try { await session.abortTransaction(); session.endSession(); } catch (_) { } 
      }
      return res.status(400).json({ message: txErr.message || "Failed to update receipt" });
    }
  } catch (err) {
    console.error("updateReceipt error:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
};

/** DELETE */
exports.deleteReceipt = async (req, res) => {
  try {
    await ensureAuthCaps(req);

    const receipt = await ReceiptEntry.findById(req.params.id);
    if (!receipt) return res.status(404).json({ message: "Receipt not found" });

    if (!userIsPriv(req) && !sameTenant(receipt.client, req.auth.clientId)) {
      return res.status(403).json({ message: "Not authorized" });
    }

    const amt = Number(receipt.amount || 0);

    // NEW: Get party info before deletion for notification
    const partyDoc = await Party.findById(receipt.party);

    let session;
    try {
      session = await mongoose.startSession();
      session.startTransaction();

      // 1) Delete
      await ReceiptEntry.deleteOne({ _id: receipt._id }).session(session);

      // 2) Add back to balance
      const updatedParty = await adjustBalanceGuarded({
        partyId: receipt.party,
        clientId: req.auth.clientId,
        delta: +amt,  // add back
        session,
      });

      await notifyAdminOnReceiptAction({
        req,
        action: "delete",
        customerName: partyDoc?.name || partyDoc?.partyName || partyDoc?.customerName,
        entryId: receipt._id,
        companyId: receipt.company.toString(),
        oldAmount: amt,
      });


      await session.commitTransaction();
      session.endSession();

      const companyId = receipt.company.toString();

      // Call the cache deletion function
      // await deleteReceiptEntryCache(req.auth.clientId, companyId);

      return res.json({
        message: "Receipt deleted",
        updatedBalance: Number(updatedParty?.balance ?? 0),
      });
    } catch (txErr) {
      if (session) { try { await session.abortTransaction(); session.endSession(); } catch (_) { } }

      // Fallback
      try {
        await ReceiptEntry.deleteOne({ _id: receipt._id });

        const updatedParty = await adjustBalanceGuarded({
          partyId: receipt.party,
          clientId: req.auth.clientId,
          delta: +amt,
          session: undefined,
        });

        await notifyAdminOnReceiptAction({
          req,
          action: "delete",
          customerName: partyDoc?.name || partyDoc?.partyName || partyDoc?.customerName,
          entryId: receipt._id,
          companyId: receipt.company.toString(),
          oldAmount: amt,
        });


        return res.json({
          message: "Receipt deleted",
          updatedBalance: Number(updatedParty?.balance ?? 0),
        });
      } catch (fallbackErr) {
        return res.status(400).json({ message: fallbackErr.message || "Failed to delete receipt" });
      }
    }
  } catch (err) {
    console.error("deleteReceipt error:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
};


/** ADMIN: list by client (with optional company, pagination) */
exports.getReceiptsByClient = async (req, res) => {
  try {
    await ensureAuthCaps(req);
    if (!userIsPriv(req)) {
      return res.status(403).json({ message: "Not authorized" });
    }

    const { clientId } = req.params;
    const { companyId, page = 1, limit = 100 } = req.query;

    const filter = { client: clientId };
    if (companyId) filter.company = companyId;

    const perPage = Math.min(Number(limit) || 100, 500);
    const skip = (Number(page) - 1) * perPage;

    // // Construct a cache key based on the filter
    // const cacheKey = `receiptEntriesByClient:${JSON.stringify({ clientId, companyId })}`;

    // // Check if the data is cached in Redis
    // const cachedEntries = await getFromCache(cacheKey);
    // if (cachedEntries) {
    //   // If cached, return the data directly
    //   return res.status(200).json({
    //     success: true,
    //     count: cachedEntries.length,
    //     data: cachedEntries,
    //   });
    // }

    // Fetch the data from the database if not cached
    const query = ReceiptEntry.find(filter)
      .sort({ date: -1 })
      .skip(skip)
      .limit(perPage)
      .populate({ path: "party", select: "name" })
      .populate({ path: "company", select: "businessName" });

    // Fetch data and total count simultaneously
    const [data, total] = await Promise.all([query.lean(), ReceiptEntry.countDocuments(filter)]);

    // Cache the fetched data in Redis for future requests
    // await setToCache(cacheKey, data);

    // Return the data in a consistent format
    res.status(200).json({
      success: true,
      total,
      page: Number(page),
      limit: perPage,
      data,
    });
  } catch (err) {
    console.error("getReceiptsByClient error:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
};


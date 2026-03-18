// controllers/receiptController.js
const mongoose = require("mongoose");
const ReceiptEntry = require("../models/ReceiptEntry");
const Company = require("../models/Company");
const Party = require("../models/Party");
const User = require("../models/User")
const { getEffectivePermissions } = require("../services/effectivePermissions");
const { deleteReceiptEntryCache, deleteReceiptEntryCacheByUser, flushAllCache } = require("../utils/cacheHelpers");

const { createNotification } = require("./notificationController");
const { resolveActor, findAdminUser } = require("../utils/actorUtils");

// privileged roles that can skip allowedCompanies checks
const PRIV_ROLES = new Set(["master", "client", "admin"]);

function userIsPrivForCompanyAccess(req) {
  // Only master and client should bypass company r`estrictions
  return req.auth?.role === "master" || req.auth?.role === "client";
}

// NEW: Function for client data access
function userCanAccessAllClientData(req) {
  // Only master should access all clients' data
  return req.auth?.role === "master";
}

async function adjustBalanceGuarded({ partyId, clientId, companyId, delta, session }) {
  // console.log('adjustBalanceGuarded called with:', { partyId, clientId, companyId, delta });
  if (delta < 0) {
    // deducting → allow even if balance is insufficient
    const updated = await Party.findOneAndUpdate(
      { _id: partyId, createdByClient: clientId },
      { $inc: { [`balances.${companyId}`]: delta } }, // delta is negative, so it deducts
      { new: true, session, select: { _id: 1, [`balances.${companyId}`]: 1 } }
    );
    // console.log('adjustBalanceGuarded result:', updated);
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
  if (req.auth?.role === "master" || req.auth?.role === "client") return true;
  const allowed = Array.isArray(req.auth.allowedCompanies)
    ? req.auth.allowedCompanies.map(String)
    : [];
  return allowed.includes(String(companyId));
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

    try {
      if (global.io) {
        console.log('📡 Emitting transaction-update (create receipt)...');
        
        const socketPayload = {
          message: 'New Receipt Created',
          type: 'receipt', // Frontend is type ko check karega
          action: 'create',
          entryId: receipt._id,
          amount: amt,
          partyName: partyDoc?.name || "Unknown Party"
        };

        // 1. Emit to Client Room
        global.io.to(`client-${req.auth.clientId}`).emit('transaction-update', socketPayload);

        // 2. Emit to Global/Admin Room
        global.io.to('all-transactions-updates').emit('transaction-update', {
          ...socketPayload,
          clientId: req.auth.clientId
        });
      }
    } catch (socketError) {
      console.error("⚠️ Socket Emit Failed (Receipt Create):", socketError.message);
    }

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


// exports.getReceipts = async (req, res) => {
//   try {
//     await ensureAuthCaps(req);
    
//     const filter = {};
//     const user = req.user || req.auth;

//     console.log("User role:", user.role);
//     console.log("User ID:", user.id);
//     console.log("Query companyId:", req.query.companyId);

//     // --- Client filtering ---
//     if (user.role === "client") {
//       filter.client = user.id;
//     }

//     // --- Company filtering ---
//     if (req.query.companyId) {
//       if (!companyAllowedForUser(req, req.query.companyId)) {
//         return res.status(403).json({ 
//           success: false, 
//           message: "Access denied to this company" 
//         });
//       }
//       filter.company = req.query.companyId;
//     } else {
//       const allowedCompanies = user.allowedCompanies || [];
//       if (allowedCompanies.length > 0 && user.role === "user") {
//         filter.company = { $in: allowedCompanies };
//       } else if (user.role === "user") {
//         return res.status(200).json({
//           success: true,
//           count: 0,
//           data: [],
//         });
//       }
//     }

//     // --- Date range filtering ---
//     if (req.query.dateFrom || req.query.dateTo) {
//       filter.date = {};
//       if (req.query.dateFrom) filter.date.$gte = new Date(req.query.dateFrom);
//       if (req.query.dateTo) filter.date.$lte = new Date(req.query.dateTo);
//     }

//     // --- Search filtering ---
//     if (req.query.q) {
//       const searchTerm = String(req.query.q);
//       filter.$or = [
//         { description: { $regex: searchTerm, $options: "i" } },
//         { referenceNumber: { $regex: searchTerm, $options: "i" } },
//       ];
//     }

//     console.log("Final filter for receipt entries:", JSON.stringify(filter, null, 2));

//     // --- SMART PAGINATION APPROACH ---
//     const page = parseInt(req.query.page) || 1;
//     let limit = parseInt(req.query.limit) || 1000; // Default to 1000, not 500
    
//     // Calculate total count first
//     const total = await ReceiptEntry.countDocuments(filter);
    
//     // Auto-detect large datasets and adjust limit
//     if (total > 10000) {
//       console.warn(`Large dataset detected: ${total} receipts. Using pagination.`);
      
//       // If no explicit limit provided, cap it for large datasets
//       if (!req.query.limit) {
//         limit = Math.min(limit, 2000); // Max 2000 for large datasets without explicit limit
//       } else {
//         // Allow user to set any limit, but warn if too high
//         if (limit > 5000) {
//           console.warn(`High limit requested: ${limit}. Consider using smaller pages.`);
//         }
//       }
//     }
    
//     const skip = (page - 1) * limit;
//     const totalPages = Math.ceil(total / limit);

//     // Build query
//     const query = ReceiptEntry.find(filter)
//       .sort({ date: -1 })
//       .populate({ path: "party", select: "name" })
//       .populate({ path: "company", select: "businessName" });

//     // Apply pagination only if dataset is large or page/limit specified
//     let data;
//     if (total <= 10000 && !req.query.page && !req.query.limit) {
//       // Small dataset, no pagination params = return all
//       data = await query.lean();
//     } else {
//       // Large dataset or explicit pagination = use pagination
//       data = await query.skip(skip).limit(limit).lean();
//     }

//     // Add performance metadata
//     const performanceData = {
//       totalRecords: total,
//       returnedRecords: data.length,
//       queryTime: Date.now(), // You could measure actual query time
//       hasMore: total > (skip + data.length),
//       recommendation: total > 10000 ? 
//         "Large dataset detected. Consider using date filters or smaller page sizes." : 
//         "Dataset size is optimal"
//     };

//     res.status(200).json({
//       success: true,
//       count: data.length,
//       total,
//       page: total <= 10000 && !req.query.page ? 1 : page,
//       limit: total <= 10000 && !req.query.limit ? total : limit,
//       totalPages,
//       performance: performanceData,
//       data,
//     });
//   } catch (err) {
//     console.error("getReceipts error:", err.message);
//     res.status(500).json({
//       success: false,
//       error: err.message,
//     });
//   }
// };

// controllers/receiptController.js
exports.getReceipts = async (req, res) => {
  try {
    await ensureAuthCaps(req);
    
    const filter = {};
    const user = req.auth;
    const { role, allowedCompanies, caps, userId } = req.auth;

    // console.log("🔍 RECEIPT - User role:", role);
    // console.log("🔍 RECEIPT - User ID:", userId);
    // console.log("🔍 RECEIPT - Query companyId:", req.query.companyId);
    // console.log("🔍 RECEIPT - Full caps object:", JSON.stringify(caps, null, 2));
    // console.log("🔍 RECEIPT - canShowReceiptEntries value:", caps?.canShowReceiptEntries);

   
    if (role === "user") {
      const canShowAllReceipts = caps?.canShowReceiptEntries === true;
      
      console.log("🔍 RECEIPT - canShowAllReceipts result:", canShowAllReceipts);
      
      if (!canShowAllReceipts) {
        // console.log("🔍 RECEIPT - User can only see their own entries. Adding filter:", userId);
        filter.createdByUser = userId;
      } else {
        console.log("🔍 RECEIPT - User can see ALL receipt entries - no filter added");
      }
    }

    filter.client = req.auth.clientId;

    // --- Company filtering ---
    if (req.query.companyId && req.query.companyId !== "all" && req.query.companyId !== "undefined") {
      if (!companyAllowedForUser(req, req.query.companyId)) {
        return res.status(403).json({ 
          success: false, 
          message: "Access denied to this company" 
        });
      }
      filter.company = req.query.companyId;
    } else {
      const allowedCompanies = user.allowedCompanies || [];

      if (user.role !== "client" && user.role !== "master") {
        if (allowedCompanies.length > 0) {
          filter.company = { $in: allowedCompanies };
        } else {
          return res.status(200).json({
            success: true,
            total: 0,
            count: 0,
            page: 1,
            limit: 20,
            totalPages: 0,
            data: [],
          });
        }
      }
    }

    // --- Date range filtering ---
    const { startDate, endDate, dateFrom, dateTo } = req.query;
    const finalStart = startDate || dateFrom;
    const finalEnd = endDate || dateTo;

    if (finalStart || finalEnd) {
      filter.date = {};
      if (finalStart) {
        filter.date.$gte = new Date(`${finalStart}T00:00:00`);
      }
      if (finalEnd) {
        filter.date.$lte = new Date(`${finalEnd}T23:59:59`);
      }
    }

    // --- Search filtering ---
    if (req.query.q) {
      const searchTerm = String(req.query.q);
      filter.$or = [
        { description: { $regex: searchTerm, $options: "i" } },
        { referenceNumber: { $regex: searchTerm, $options: "i" } },
        { receiptNumber: { $regex: searchTerm, $options: "i" } }
      ];
    }

    // console.log("🔍 RECEIPT - Final filter:", JSON.stringify(filter, null, 2));

    // --- ENHANCED PAGINATION ---
    const page = parseInt(req.query.page) || 1;
    let limit = parseInt(req.query.limit) || 20; // Default to 20 for frontend pagination
    
    // Validate pagination parameters
    if (page < 1) {
      return res.status(400).json({
        success: false,
        message: "Page must be at least 1"
      });
    }
    
    if (limit < 1 || limit > 5000) {
      return res.status(400).json({
        success: false,
        message: "Limit must be between 1 and 5000"
      });
    }
    
    // Calculate total count
    const total = await ReceiptEntry.countDocuments(filter);
    
    // Auto-adjust limit for large datasets
    let effectiveLimit = limit;
    if (total > 10000 && !req.query.limit) {
      console.log(`Large dataset detected: ${total} receipts. Auto-adjusting limit to 200.`);
      effectiveLimit = Math.min(200, limit);
    }
    
    const skip = (page - 1) * effectiveLimit;
    const totalPages = Math.ceil(total / effectiveLimit);
    
    // Ensure page doesn't exceed total pages
    if (page > totalPages && totalPages > 0) {
      return res.status(400).json({
        success: false,
        message: `Page ${page} exceeds total pages (${totalPages})`
      });
    }

    // Build query with proper population
    const query = ReceiptEntry.find(filter)
      .sort({ date: -1, createdAt: -1, _id: -1 })
      .populate({ 
        path: "party", 
        select: "name email phoneNumber address" 
      })
      .populate({ 
        path: "company", 
        select: "businessName address gstin phoneNumber email" 
      })
      .populate({
        path: "items.product",
        select: "name unitType hsn",
        strictPopulate: false
      })
      .populate({
        path: "items.service",
        select: "serviceName sac",
        strictPopulate: false
      });

    // Execute query with pagination
    let data;
    if (total <= 10000 && !req.query.page && !req.query.limit) {
      // Small dataset without explicit pagination - return all
      data = await query.lean();
    } else {
      // Apply pagination
      data = await query.skip(skip).limit(effectiveLimit).lean();
    }
    // console.log(`🔍 RECEIPT - Found ${data.length} entries out of ${total} total`);

    // Add transaction type for frontend
    const typedData = data.map(entry => ({ 
      ...entry, 
      type: "receipt"
    }));

    res.status(200).json({
      success: true,
      total,
      count: typedData.length,
      page,
      limit: effectiveLimit,
      totalPages,
      hasMore: skip + typedData.length < total,
      data: typedData,
      performance: {
        datasetSize: total,
        queryFiltered: Object.keys(filter).length > 0,
        recommendation: total > 10000 ? 
          "Consider using date filters or smaller page sizes for better performance" : 
          "Dataset size is optimal"
      }
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

    console.log('updateReceipt delta calculation:', { oldAmount, finalAmount, delta });

    let session;
    try {
      session = await mongoose.startSession();
      session.startTransaction();

      // Apply full delta to maintain consistency with create logic
      if (delta !== 0) {
        const companyId = receipt.company.toString();
        console.log('Calling adjustBalanceGuarded with:', { partyId: receipt.party, clientId: req.auth.clientId, companyId, delta: -delta });
        const updatedParty = await adjustBalanceGuarded({
          partyId: receipt.party,
          clientId: req.auth.clientId,
          companyId: companyId,
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

      try {
        if (global.io) {
          console.log('📡 Emitting transaction-update (update receipt)...');

          const socketPayload = {
            message: 'Receipt Updated',
            type: 'receipt',
            action: 'update',
            entryId: receipt._id,
            amount: finalAmount,
            partyName: partyDoc?.name
          };

          // 1. Emit to Client Room
          global.io.to(`client-${req.auth.clientId}`).emit('transaction-update', socketPayload);

          // 2. Emit to Global Room
          global.io.to('all-transactions-updates').emit('transaction-update', {
            ...socketPayload,
            clientId: req.auth.clientId
          });
        }
      } catch (socketError) {
        console.error("⚠️ Socket Emit Failed (Receipt Update):", socketError.message);
      }

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
        companyId: receipt.company.toString(),
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

      try {
        if (global.io) {
          console.log('📡 Emitting transaction-update (delete receipt)...');
          const socketPayload = {
            message: 'Receipt Deleted',
            type: 'receipt',
            action: 'delete',
            entryId: receipt._id
          };
          global.io.to(`client-${req.auth.clientId}`).emit('transaction-update', socketPayload);
          global.io.to('all-transactions-updates').emit('transaction-update', {
            ...socketPayload,
            clientId: req.auth.clientId
          });
        }
      } catch (socketError) { console.error("⚠️ Socket Emit Failed:", socketError.message); }

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
          companyId: receipt.company.toString(),
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
// exports.getReceiptsByClient = async (req, res) => {
//   try {
//     await ensureAuthCaps(req);
//     if (!userIsPriv(req)) {
//       return res.status(403).json({ message: "Not authorized" });
//     }

//     const { clientId } = req.params;
//     const { companyId, page = 1, limit = 100 } = req.query;

//     const filter = { client: clientId };
//     if (companyId) filter.company = companyId;

//     const perPage = Math.min(Number(limit) || 100, 500);
//     const skip = (Number(page) - 1) * perPage;

//     // // Construct a cache key based on the filter
//     // const cacheKey = `receiptEntriesByClient:${JSON.stringify({ clientId, companyId })}`;

//     // // Check if the data is cached in Redis
//     // const cachedEntries = await getFromCache(cacheKey);
//     // if (cachedEntries) {
//     //   // If cached, return the data directly
//     //   return res.status(200).json({
//     //     success: true,
//     //     count: cachedEntries.length,
//     //     data: cachedEntries,
//     //   });
//     // }

//     // Fetch the data from the database if not cached
//     const query = ReceiptEntry.find(filter)
//       .sort({ date: -1 })
//       .skip(skip)
//       .limit(perPage)
//       .populate({ path: "party", select: "name" })
//       .populate({ path: "company", select: "businessName" });

//     // Fetch data and total count simultaneously
//     const [data, total] = await Promise.all([query.lean(), ReceiptEntry.countDocuments(filter)]);

//     // Cache the fetched data in Redis for future requests
//     // await setToCache(cacheKey, data);

//     // Return the data in a consistent format
//     res.status(200).json({
//       success: true,
//       total,
//       page: Number(page),
//       limit: perPage,
//       data,
//     });
//   } catch (err) {
//     console.error("getReceiptsByClient error:", err);
//     res.status(500).json({ message: "Server error", error: err.message });
//   }
// };

/** ADMIN: list by client (with optional company, pagination) */
exports.getReceiptsByClient = async (req, res) => {
  try {
    await ensureAuthCaps(req);
    if (!userIsPriv(req)) {
      return res.status(403).json({ message: "Not authorized" });
    }

    const { clientId } = req.params;
    const { companyId } = req.query;

    const filter = { client: clientId };
    if (companyId) filter.company = companyId;

    // --- SMART PAGINATION (same as getReceipts) ---
    const page = parseInt(req.query.page) || 1;
    let limit = parseInt(req.query.limit) || 1000;
    
    // Calculate total count
    const total = await ReceiptEntry.countDocuments(filter);
    
    // Auto-detect large datasets
    if (total > 10000) {
      console.warn(`Large dataset detected in admin view: ${total} receipts for client ${clientId}.`);
      
      if (!req.query.limit) {
        limit = Math.min(limit, 2000);
      } else if (limit > 5000) {
        console.warn(`High limit requested in admin view: ${limit}.`);
      }
    }
    
    const skip = (page - 1) * limit;
    const totalPages = Math.ceil(total / limit);

    // Build query
    let query = ReceiptEntry.find(filter)
      .sort({ date: -1, createdAt: -1, _id: -1 })
      .populate({ path: "party", select: "name" })
      .populate({ path: "company", select: "businessName" });

    // Apply pagination logic
    let data;
    if (total <= 10000 && !req.query.page && !req.query.limit) {
      data = await query.lean();
    } else {
      data = await query.skip(skip).limit(limit).lean();
    }

    res.status(200).json({
      success: true,
      total,
      count: data.length,
      page: total <= 10000 && !req.query.page ? 1 : page,
      limit: total <= 10000 && !req.query.limit ? total : limit,
      totalPages,
      data,
    });
  } catch (err) {
    console.error("getReceiptsByClient error:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
};

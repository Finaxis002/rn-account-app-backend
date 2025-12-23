// controllers/proformaController.js
const mongoose = require("mongoose");
const ProformaEntry = require("../models/ProformaEntry");
const Company = require("../models/Company");
const Party = require("../models/Party");
const User = require("../models/User");
const BankDetail = require("../models/BankDetail");
const normalizeProducts = require("../utils/normalizeProducts");
const normalizeServices = require("../utils/normalizeServices");
const IssuedInvoiceNumber = require("../models/IssuedInvoiceNumber");
const { issueProformaInvoiceNumber } = require("../services/proformaInvoiceIssuer");
const { getFromCache, setToCache } = require("../RedisCache");
const {
  deleteSalesEntryCache,
  deleteSalesEntryCacheByUser,
} = require("../utils/cacheHelpers");
// at top of controllers/proformaController.js
const { getEffectivePermissions } = require("../services/effectivePermissions");
const { createNotification } = require("./notificationController");
const { resolveActor, findAdminUser } = require("../utils/actorUtils");

const PRIV_ROLES = new Set(["master", "client", "admin"]);

async function ensureAuthCaps(req) {
  // Normalize: support old middlewares that used req.user
  if (!req.auth && req.user)
    req.auth = {
      clientId: req.user.id,
      userId: req.user.userId || req.user.id,
      role: req.user.role,
      caps: req.user.caps,
      allowedCompanies: req.user.allowedCompanies,
      userName: req.user.userName || "Unknown", // Ensure userName is set here
      clientName: req.user.contactName,
    };

  // If there's no auth context, throw error
  if (!req.auth) throw new Error("Unauthorized (no auth context)");

  // If caps or allowedCompanies are missing, load them
  if (!req.auth.caps || !Array.isArray(req.auth.allowedCompanies)) {
    const { caps, allowedCompanies } = await getEffectivePermissions({
      clientId: req.auth.clientId,
      userId: req.auth.userId,
    });
    req.auth.caps = req.auth.caps || caps;
    req.auth.allowedCompanies = req.auth.allowedCompanies || allowedCompanies;
  }

  // If userName is still not set, query the database for user details
  // if (!req.auth.userName) {
  //   const user = await User.findById(req.auth.userId);  // Assuming the userId is correct
  //   req.auth.userName = user ? user.userName : 'Unknown';  // Fallback to 'Unknown' if user is not found
  // }

  // updated: only for staff (non-client) logins
  if (req.auth.role !== "client" && !req.auth.userName && req.auth.userId) {
    const user = await User.findById(req.auth.userId)
      .select("displayName fullName name userName username email")
      .lean();
    req.auth.userName =
      user?.displayName ||
      user?.fullName ||
      user?.name ||
      user?.userName ||
      user?.username ||
      user?.email ||
      undefined; // no "Unknown" fallback here
  }
}

function userIsPriv(req) {
  return PRIV_ROLES.has(req.auth.role);
}

function companyAllowedForUser(req, companyId) {
  if (userIsPriv(req)) return true;
  const allowed = Array.isArray(req.auth.allowedCompanies)
    ? req.auth.allowedCompanies.map(String)
    : [];
  return allowed.length === 0 || allowed.includes(String(companyId));
}



// Build message text per action
function buildProformaNotificationMessage(
  action,
  { actorName, partyName, invoiceNumber, amount }
) {
  const pName = partyName || "Unknown Party";
  switch (action) {
    case "create":
      return (
        `New proforma entry created by ${actorName} for party ${pName}` +
        (amount != null ? ` of ₹${amount}.` : ".")
      );
    case "update":
      return `Proforma entry updated by ${actorName} for party ${pName}.`;
    case "delete":
      return `Proforma entry deleted by ${actorName} for party ${pName}.`;
    default:
      return `Proforma entry ${action} by ${actorName} for party ${pName}.`;
  }
}

// Unified notifier for proforma module
async function notifyAdminOnProformaAction({
  req,
  action,
  partyName,
  entryId,
  companyId,
  amount,
}) {
  const actor = await resolveActor(req);
  const adminUser = await findAdminUser(companyId);
  if (!adminUser) {
    console.warn("notifyAdminOnProformaAction: no admin user found");
    return;
  }

  const message = buildProformaNotificationMessage(action, {
    actorName: actor.name,
    partyName,
    amount,
  });

  await createNotification(
    message,
    adminUser._id, // recipient (admin)
    actor.id, // actor id (user OR client)
    action, // "create" | "update" | "delete"
    "proforma", // entry type / category
    entryId, // proforma entry id
    req.auth.clientId
  );
}

// In your getProformaEntries controller
// exports.getProformaEntries = async (req, res) => {
//   try {
//     const filter = {};

//     if (!req.user) return res.status(401).json({ message: "Unauthorized" });
//     if (req.user.role === "client") {
//       filter.client = req.user.id;
//     }
//     if (req.query.companyId) {
//       filter.company = req.query.companyId;
//     }

//     // Construct a cache key based on the filter
//     const cacheKey = `proformaEntries:${JSON.stringify(filter)}`;

//     // Check if the data is cached in Redis
//     // const cachedEntries = await getFromCache(cacheKey);
//     // if (cachedEntries) {
//     //   // If cached, return the data directly
//     //   return res.status(200).json({
//     //     success: true,
//     //     count: cachedEntries.length,
//     //     data: cachedEntries,
//     //   });
//     // }

//     // If not cached, fetch the data from the database
//     const entries = await ProformaEntry.find(filter)
//       .populate("party", "name")
//       .populate("products.product", "name")
//       .populate({
//         path: "services.service",
//         select: "serviceName",
//         strictPopulate: false,
//       }) // ✅
//       .populate("company", "businessName")
//       .populate("shippingAddress")
//       .populate("bank")
//       .sort({ date: -1 });
//     // Return consistent format

//     // Cache the fetched data in Redis for future requests
//     // await setToCache(cacheKey, entries);

//     res.status(200).json({
//       success: true,
//       count: entries.length,
//       data: entries, // Use consistent key
//     });
//   } catch (err) {
//     console.error("Error fetching proforma entries:", err.message);
//     res.status(500).json({
//       success: false,
//       error: err.message,
//     });
//   }
// };

exports.getProformaEntries = async (req, res) => {
  try {

    await ensureAuthCaps(req); // Ensure auth context is loaded
    
    const filter = {};

    if (!req.auth) return res.status(401).json({ message: "Unauthorized" });
    
    // For client users, restrict to their client ID AND allowed companies
    if (req.auth.role === "client") {
      filter.client = req.auth.clientId;
    }
    
    // If companyId is provided, validate the user has access to it
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
      if (!userIsPriv(req) && Array.isArray(req.auth.allowedCompanies)) {
        filter.company = { $in: req.auth.allowedCompanies };

      }
    }

    // Construct a SECURE cache key based on user context
    const cacheKey = `proformaEntries:${req.auth.userId}:${JSON.stringify(filter)}`;

    // Check if the data is cached in Redis
    // const cachedEntries = await getFromCache(cacheKey);
    // if (cachedEntries) {
    //   return res.status(200).json({
    //     success: true,
    //     count: cachedEntries.length,
    //     data: cachedEntries,
    //   });
    // }

    // If not cached, fetch the data from the database
    const entries = await ProformaEntry.find(filter)
      .populate("party", "name")
      .populate("products.product", "name")
      .populate({
        path: "services.service",
        select: "serviceName",
        strictPopulate: false,
      })
      .populate("company", "businessName")
      .populate("shippingAddress")
      .populate("bank")
      .sort({ date: -1 });

    // Cache the fetched data in Redis for future requests
    // await setToCache(cacheKey, entries);

    res.status(200).json({
      success: true,
      count: entries.length,
      data: entries,
    });
  } catch (err) {
    console.error("Error fetching proforma entries:", err.message);
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
};


// GET Proforma Entries by clientId (for master admin)
exports.getProformaEntriesByClient = async (req, res) => {
  try {
    const { clientId } = req.params;

    // Construct a cache key based on clientId
    const cacheKey = `proformaEntriesByClient:${clientId}`;

    // Check if the data is cached in Redis
    // const cachedEntries = await getFromCache(cacheKey);
    // if (cachedEntries) {
    //   // If cached, return the data directly
    //   return res.status(200).json({
    //     success: true,
    //     count: cachedEntries.length,
    //     data: cachedEntries,
    //   });
    // }

    // Fetch data from database if not cached
    const entries = await ProformaEntry.find({ client: clientId })
      .populate("party", "name")
      .populate("products.product", "name")
      .populate({
        path: "services.service",
        select: "serviceName",
        strictPopulate: false,
      })
      .populate("company", "businessName")
      .populate("shippingAddress")
      .populate("bank")
      .sort({ date: -1 });

    // Cache the fetched data in Redis for future requests
    // await setToCache(cacheKey, entries);

    // Return the fetched data
    res.status(200).json({ entries });
  } catch (err) {
    res
      .status(500)
      .json({ message: "Failed to fetch entries", error: err.message });
  }
};




exports.createProformaEntry = async (req, res) => {
  const session = await mongoose.startSession();
  let entry, companyDoc, partyDoc, selectedBank;

  try {
    // Ensure the user has permission
    await ensureAuthCaps(req);
    if (!userIsPriv(req) && !req.auth.caps?.canCreateSaleEntries) {
      return res
        .status(403)
        .json({ message: "Not allowed to create proforma entries" });
    }

    // Destructure the request body
    const {
      company: companyId,
      paymentMethod,
      party,
      totalAmount,
      bank,
      shippingAddress,
    } = req.body;

    if (!party) {
      return res.status(400).json({ message: "Customer ID is required" });
    }

    if (!companyAllowedForUser(req, companyId)) {
      return res
        .status(403)
        .json({ message: "You are not allowed to use this company" });
    }

    await session.withTransaction(async () => {
      // Handle transaction logic here
      const {
        party,
        company: companyId,
        date,
        dueDate,
        products,
        services,
        totalAmount,
        description,
        referenceNumber,
        gstRate,
        discountPercentage,
        invoiceType,
        taxAmount: taxAmountIn,
        invoiceTotal: invoiceTotalIn,
        notes,
        shippingAddress,
        bank,
      } = req.body;

      companyDoc = await Company.findOne({
        _id: companyId,
        client: req.auth.clientId,
      }).session(session);
      if (!companyDoc) throw new Error("Invalid company selected");

      partyDoc = await Party.findOne({
        _id: party,
        createdByClient: req.auth.clientId,
      }).session(session);
      if (!partyDoc) throw new Error("Customer not found or unauthorized");

      // Normalize products with GST calculations
      let normalizedProducts = [],
        productsTotal = 0,
        productsTax = 0;
      if (Array.isArray(products) && products.length > 0) {
        const { items, computedTotal, computedTax } = await normalizeProducts(
          products,
          req.auth.clientId,
          req.auth.userId
        );
        normalizedProducts = items;
        productsTotal = computedTotal;
        productsTax = computedTax;
      }

      // Normalize services with GST calculations
      let normalizedServices = [],
        servicesTotal = 0,
        servicesTax = 0;
      if (Array.isArray(services) && services.length > 0) {
        const { items, computedTotal, computedTax } = await normalizeServices(
          services,
          req.auth.clientId
        );
        normalizedServices = items;
        servicesTotal = computedTotal;
        servicesTax = computedTax;
      }

      const computedSubtotal = (productsTotal || 0) + (servicesTotal || 0);
      const computedTaxAmount = (productsTax || 0) + (servicesTax || 0);

      const finalTotal =
        typeof totalAmount === "number"
          ? totalAmount
          : typeof invoiceTotalIn === "number"
          ? invoiceTotalIn
          : +(computedSubtotal + computedTaxAmount).toFixed(2);

      const finalTaxAmount =
        typeof taxAmountIn === "number" ? taxAmountIn : computedTaxAmount;

      const atDate = date ? new Date(date) : new Date();

      let attempts = 0;
      while (true) {
        attempts++;
        const { invoiceNumber, yearYY, seq, prefix } =
          await issueProformaInvoiceNumber(companyDoc._id, atDate, { session });

        try {
          const docs = await ProformaEntry.create(
            [
              {
                party: partyDoc._id,
                company: companyDoc._id,
                client: req.auth.clientId,
                date,
                dueDate,
                products: normalizedProducts,
                services: normalizedServices,
                totalAmount: finalTotal,
                taxAmount: finalTaxAmount, // NEW: Save total tax amount
                subTotal: computedSubtotal, // NEW: Save subtotal
                description,
                referenceNumber,
                gstPercentage:
                  computedTaxAmount > 0
                    ? +((computedTaxAmount / computedSubtotal) * 100).toFixed(2)
                    : 0,
                discountPercentage,
                invoiceType,
                gstin: companyDoc.gstin || null,
                invoiceNumber,
                invoiceYearYY: yearYY,
                paymentMethod,
                createdByUser: req.auth.userId,
                notes: notes || "",
                shippingAddress: shippingAddress,
                bank: bank,
              },
            ],
            { session }
          );

          entry = docs[0];

          // Ensure only one response is sent
          if (!res.headersSent) {
            // After proforma entry is created, notify the admin

            // Notify admin AFTER entry created (and before response)
            await notifyAdminOnProformaAction({
              req,
              action: "create",
              partyName: partyDoc?.name,
              entryId: entry._id,
              companyId: companyDoc?._id?.toString(),
              amount: entry?.totalAmount,
            });

            await IssuedInvoiceNumber.create(
              [
                {
                  company: companyDoc._id,
                  series: "proforma",
                  invoiceNumber,
                  yearYY,
                  seq,
                  prefix,
                },
              ],
              { session }
            );

            // Send response after notification creation
            return res
              .status(201)
              .json({ message: "Proforma entry created successfully", entry });
          }
        } catch (e) {
          if (e?.code === 11000 && attempts < 20) continue;
          throw e;
        }
      }
    });

    const clientId = entry.client.toString(); // Retrieve clientId from the entry

    // Call the reusable cache deletion function
    await deleteSalesEntryCache(clientId, companyId);
  } catch (err) {
    console.error("createProformaEntry error:", err);
    return res
      .status(500)
      .json({ message: "Something went wrong", error: err.message });
  } finally {
    session.endSession();
  }
};

const sameTenant = (entryClientId, userClientId) => {
  return entryClientId.toString() === userClientId.toString();
};

// UPDATE a proforma entry
exports.updateProformaEntry = async (req, res) => {
  const session = await mongoose.startSession();

  try {
    // Ensure the user has permission
    await ensureAuthCaps(req);
    if (!userIsPriv(req) && !req.auth.caps?.canCreateSaleEntries) {
      return res.status(403).json({ message: "Not allowed to update proforma entries" });
    }

    // Find the proforma entry by ID
    const entry = await ProformaEntry.findById(req.params.id);
    if (!entry)
      return res.status(404).json({ message: "Proforma entry not found" });

    // Tenant auth: allow privileged roles or same tenant only
    if (!userIsPriv(req) && !sameTenant(entry.client, req.auth.clientId)) {
      return res.status(403).json({ message: "Unauthorized" });
    }

    const { products, services, paymentMethod, totalAmount, party, shippingAddress, bank, ...otherUpdates } = req.body;

    // Store original values for credit adjustment
    const originalPaymentMethod = entry.paymentMethod;
    const originalTotalAmount = entry.totalAmount;
    const originalPartyId = entry.party.toString();

    // If company is being changed, check permission + existence
    if (otherUpdates.company) {
      if (!companyAllowedForUser(req, otherUpdates.company)) {
        return res
          .status(403)
          .json({ message: "You are not allowed to use this company" });
      }
      const company = await Company.findOne({
        _id: otherUpdates.company,
        client: req.auth.clientId,
      });
      if (!company) {
        return res.status(400).json({ message: "Invalid company selected" });
      }
    }

    // If party is being changed, validate it belongs to the same tenant
    let partyDoc = null;
    if (otherUpdates.party) {
      partyDoc = await Party.findOne({
        _id: otherUpdates.party,
        createdByClient: req.auth.clientId,
      });
      if (!partyDoc) {
        return res
          .status(400)
          .json({ message: "Customer not found or unauthorized" });
      }
    }

    let productsTotal = 0;
    let servicesTotal = 0;

    // Normalize product lines only if provided (Array.isArray allows clearing with [])
    if (Array.isArray(products)) {
      const { items: normalizedProducts, computedTotal } =
        await normalizeProducts(products, req.auth.clientId);
      entry.products = normalizedProducts;
      productsTotal = computedTotal;
    }

    // Normalize service lines only if provided (Array.isArray allows clearing with [])
    if (Array.isArray(services)) {
      const { items: normalizedServices, computedTotal } =
        await normalizeServices(services, req.auth.clientId);
      entry.services = normalizedServices;
      servicesTotal = computedTotal;
    }

    // Don't allow changing invoiceNumber/year from payload
    const { invoiceNumber, invoiceYearYY, gstRate, notes, ...rest } = otherUpdates;
    if (typeof gstRate === "number") {
      entry.gstPercentage = gstRate;
    }
    if (notes !== undefined) {
      entry.notes = notes;
    }
    if (shippingAddress !== undefined) {
      entry.shippingAddress = shippingAddress;
    }
    if (bank !== undefined) {
      entry.bank = bank;
    }
    Object.assign(entry, rest);

    // Handle payment method and party changes for credit adjustment
    if (paymentMethod !== undefined) {
      entry.paymentMethod = paymentMethod;
    }

    if (party !== undefined) {
      entry.party = party;
    }

    // Recalculate total if not explicitly provided
    if (typeof totalAmount === "number") {
      entry.totalAmount = totalAmount;
    } else {
      const sumProducts =
        productsTotal ||
        (Array.isArray(entry.products)
          ? entry.products.reduce((s, it) => s + (Number(it.amount) || 0), 0)
          : 0);
      const sumServices =
        servicesTotal ||
        (Array.isArray(entry.services)
          ? entry.services.reduce((s, it) => s + (Number(it.amount) || 0), 0)
          : 0);
      entry.totalAmount = sumProducts + sumServices;
    }

    await notifyAdminOnProformaAction({
      req,
      action: "update",
      partyName: (partyDoc ? partyDoc.name : null) || (entry?.party?.name) || "Unknown Party",
      entryId: entry._id,
      companyId: entry.company?.toString(),
    });

    await entry.save();

    // Retrieve companyId and clientId from the proforma entry to delete related cache
    const companyId = entry.company.toString();
    const clientId = entry.client.toString();

    // Call the reusable cache deletion function
    await deleteSalesEntryCache(clientId, companyId);

    res.json({ message: "Proforma entry updated successfully", entry });
  } catch (err) {
    console.error("Error updating proforma entry:", err);
    res.status(500).json({ error: err.message });
  } finally {
    session.endSession();
  }
};

// exports.deleteProformaEntry = async (req, res) => {
//   const session = await mongoose.startSession();

//   try {
//     await ensureAuthCaps(req);
//     // Find the proforma entry by ID
//     const entry = await ProformaEntry.findById(req.params.id);

//     if (!entry) {
//       return res.status(404).json({ message: "Proforma entry not found" });
//     }

//     // Only allow clients to delete their own entries
//     if (req.user.role === "client" && entry.client.toString() !== req.user.id) {
//       return res.status(403).json({ message: "Unauthorized" });
//     }

//     // Fetch the party document
//     const partyDoc = await Party.findById(entry.party);
//     if (!partyDoc) {
//       console.error("Party not found");
//       return res.status(400).json({ message: "Party not found" });
//     }

//     // Start the transaction
//     await session.withTransaction(async () => {
//       // Delete the proforma entry
//       await entry.deleteOne();

//       // Retrieve companyId and clientId from the proforma entry to delete related cache
//       const companyId = entry.company.toString();
//       const clientId = entry.client.toString(); // Retrieve clientId from the entry

//       await notifyAdminOnProformaAction({
//         req,
//         action: "delete",
//         partyName: partyDoc?.name,
//         entryId: entry._id,
//         companyId,
//       });
//       // Invalidate cache next
//       await deleteSalesEntryCache(clientId, companyId);
//       // Respond
//       res.status(200).json({ message: "Proforma entry deleted successfully" });
//     });
//   } catch (err) {
//     console.error("Error deleting proforma entry:", err);
//     res.status(500).json({ error: err.message });
//   } finally {
//     session.endSession();
//   }
// };

exports.deleteProformaEntry = async (req, res) => {
  const session = await mongoose.startSession();

  try {
    await ensureAuthCaps(req);
    
    // Find the proforma entry by ID
    const entry = await ProformaEntry.findById(req.params.id);
    if (!entry) {
      return res.status(404).json({ 
        success: false,
        message: "Proforma entry not found" 
      });
    }


    // Enhanced authorization check using auth context
    if (!userIsPriv(req) && !sameTenant(entry.client, req.auth.clientId)) {
      return res.status(403).json({ 
        success: false,
        message: "Unauthorized" 
      });

    }

    // Fetch the party document for notification
    const partyDoc = await Party.findById(entry.party);
    if (!partyDoc) {
      console.error("Party not found");
      return res.status(400).json({ 
        success: false,
        message: "Party not found" 
      });
    }

    // Start the transaction
    await session.withTransaction(async () => {
      // Delete the proforma entry
      await ProformaEntry.deleteOne({ _id: entry._id }).session(session);

      // Notify admin
      await notifyAdminOnProformaAction({
        req,
        action: "delete",
        partyName: partyDoc?.name,
        entryId: entry._id,
        companyId: entry.company?.toString(),
      });

      // Invalidate cache
      const companyId = entry.company.toString();
      const clientId = entry.client.toString();
      await deleteSalesEntryCache(clientId, companyId);

      // Respond
      res.status(200).json({ 
        success: true,
        message: "Proforma entry deleted successfully" 
      });
    });
  } catch (err) {
    console.error("Error deleting proforma entry:", err);
    res.status(500).json({ 
      success: false,
      error: err.message 
    });
  } finally {
    session.endSession();
  }
};
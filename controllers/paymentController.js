// controllers/paymentController.js
const PaymentEntry = require("../models/PaymentEntry");
const Company = require("../models/Company");
const Vendor = require("../models/Vendor");
const PaymentExpense = require("../models/PaymentExpense");
const User = require("../models/User");
const { getEffectivePermissions } = require("../services/effectivePermissions");
const { createNotification } = require("./notificationController");
const { resolveActor, findAdminUser } = require("../utils/actorUtils");
const { updateDailyLedgerForExpense } = require("./ledger/updateDailyLedgerForExpense");


// roles that can bypass allowedCompanies restrictions
const PRIV_ROLES = new Set(["master", "client", "admin"]);

function sameTenant(a, b) {
  return String(a) === String(b);
}

function userIsPriv(req) {
  return PRIV_ROLES.has(req.auth?.role);
}

async function ensureAuthCaps(req) {
  // Normalize legacy req.user into req.auth
  if (!req.auth && req.user) {
    req.auth = {
      clientId: req.user.id,
      userId: req.user.userId || req.user.id,
      role: req.user.role,
      caps: req.user.caps,
      allowedCompanies: req.user.allowedCompanies,
      userName: req.user.userName,       // may be undefined for clients
      clientName: req.user.contactName,
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
      undefined; // no "Unknown" fallback
  }
}

// ---------- Helpers: actor + admin notification (payment) ----------

// Build message per action (payment wording)
function buildPaymentNotificationMessage(action, { actorName, vendorName, amount }) {
  const vName = vendorName || "Unknown Vendor";
  switch (action) {
    case "create":
      return `New payment entry created by ${actorName} for vendor ${vName}` +
        (amount != null ? ` of ₹${amount}.` : ".");
    case "update":
      return `Payment entry updated by ${actorName} for vendor ${vName}.`;
    case "delete":
      return `Payment entry deleted by ${actorName} for vendor ${vName}.`;
    default:
      return `Payment entry ${action} by ${actorName} for vendor ${vName}.`;
  }
}

// Unified notifier
async function notifyAdminOnPaymentAction({ req, action, vendorName, entryId, companyId, amount }) {
  const actor = await resolveActor(req);
  const adminUser = await findAdminUser(companyId);
  if (!adminUser) {
    console.warn("notifyAdminOnPaymentAction: no admin user found");
    return;
  }

  const message = buildPaymentNotificationMessage(action, {
    actorName: actor.name,
    vendorName,
    amount,
  });

  await createNotification(
    message,
    adminUser._id,   // recipient (admin)
    actor.id,        // actor id (user OR client)
    action,          // "create" | "update" | "delete"
    "payment",       // category
    entryId,         // payment _id
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

/** CREATE */
exports.createPayment = async (req, res) => {
  try {
    await ensureAuthCaps(req);

    if (!userIsPriv(req) && !req.auth.caps?.canCreatePaymentEntries) {
      return res.status(403).json({ message: "Not allowed to create payment entries" });
    }

    const { vendor, expense, isExpense, date, amount, description, paymentMethod, referenceNumber, company: companyId } = req.body;

    if (!companyAllowedForUser(req, companyId)) {
      return res.status(403).json({ message: "You are not allowed to use this company" });
    }

    if (paymentMethod && !["Cash", "UPI", "Bank Transfer", "Cheque"].includes(paymentMethod)) {
      return res.status(400).json({ message: "Invalid payment method" });
    }

    // Validate expense vs vendor logic
    if (isExpense && !expense) {
      return res.status(400).json({ message: "Expense is required when isExpense is true" });
    }
    if (!isExpense && !vendor) {
      return res.status(400).json({ message: "Vendor is required when not an expense" });
    }
    if (isExpense && vendor) {
      return res.status(400).json({ message: "Cannot specify both expense and vendor" });
    }

    // Tenant ownership checks
    const companyDoc = await Company.findOne({ _id: companyId, client: req.auth.clientId });
    if (!companyDoc) return res.status(400).json({ message: "Invalid company selected" });

    let vendorDoc = null;
    let expenseDoc = null;

    if (!isExpense) {
      vendorDoc = await Vendor.findOne({ _id: vendor, createdByClient: req.auth.clientId });
      if (!vendorDoc) return res.status(400).json({ message: "Vendor not found or unauthorized" });
    } else {
      expenseDoc = await PaymentExpense.findOne({ _id: expense, client: req.auth.clientId });
      if (!expenseDoc) return res.status(400).json({ message: "Expense not found or unauthorized" });
    }

    const payment = await PaymentEntry.create({
      vendor: vendorDoc?._id,
      expense: expenseDoc?._id,
      isExpense: isExpense || false,
      date,
      amount,
      description,
      paymentMethod,
      referenceNumber,
      company: companyDoc._id,
      client: req.auth.clientId,
      createdByUser: req.auth.userId, // optional if your schema has it
    });

    // Handle vendor balance for payments (reduce what we owe - make balance less negative)
    // Only update vendor balance if this is not an expense payment
    if (vendorDoc) {
      // Update company-specific balance
      if (!vendorDoc.balances) vendorDoc.balances = new Map();
      const currentBalance = vendorDoc.balances.get(companyId.toString()) || 0;
      vendorDoc.balances.set(companyId.toString(), currentBalance + Number(amount));
      await vendorDoc.save();
    }

    // Notify admin AFTER creation succeeds
    const entityName = isExpense
      ? (expenseDoc?.name || "Unknown Expense")
      : (vendorDoc?.name || vendorDoc?.vendorName || vendorDoc?.title || "Unknown Vendor");

    await notifyAdminOnPaymentAction({
      req,
      action: "create",
      vendorName: entityName,
      entryId: payment._id,
      companyId: companyDoc?._id?.toString(),
      amount,
    });


if (isExpense) {
  try {
    await updateDailyLedgerForExpense({
      companyId: companyDoc._id,
      clientId: req.auth.clientId,
      date,
      expenseHeadId: expenseDoc._id,
      amountDelta: Number(amount)
    });
  } catch (ledgerError) {
    // Log the error but don't fail the payment creation
    console.error('⚠️ Ledger update failed, but payment created:', ledgerError.message);
    // Payment will still be created successfully
  }
}

try {
      if (global.io) {
        console.log('📡 Emitting transaction-update (create payment)...');
        
        const socketPayload = {
          message: 'New Payment Created',
          type: 'payment', // Frontend is type ko check karega
          action: 'create',
          entryId: payment._id,
          amount: amount,
          vendorName: entityName // Payment ka naam (Vendor ya Expense)
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
      console.error("⚠️ Socket Emit Failed (Payment Create):", socketError.message);
    }

    // Access clientId and companyId after creation
    const clientId = payment.client.toString();

    // Call the cache deletion function
    // await deletePaymentEntryCache(clientId, companyId);
    // await deletePaymentEntryCacheByUser(clientId, companyId);

    res.status(201).json({ message: "Payment entry created", payment });
  } catch (err) {
    console.error("createPayment error:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
};



/** LIST (tenant-scoped, supports q/date/company filters + pagination) */
// exports.getPayments = async (req, res) => {
//   try {
//     await ensureAuthCaps(req);

//     const {
//       q,
//       companyId,
//       dateFrom,
//       dateTo,
//       page = 1,
//       limit = 10000,
//     } = req.query;

//     const clientId = req.auth.clientId;

//     // --- RESTORE ORIGINAL COMPANY FILTERING LOGIC ---
//     const where = {
//       client: clientId,
//     };

//     // Apply company filtering EXACTLY as original
//     if (companyAllowedForUser(req, companyId)) {
//       if (companyId) {
//         where.company = companyId;
//       }
//       // If companyId not provided, don't filter by company (original behavior)
//     } else {
//       // User not allowed for this company = return empty
//       where.company = { $in: [] };
//     }

//     // --- RESTORE ORIGINAL DATE FILTERING ---
//     if (dateFrom || dateTo) {
//       where.date = {};
//       if (dateFrom) where.date.$gte = new Date(dateFrom);
//       if (dateTo) where.date.$lte = new Date(dateTo);
//     }

//     // --- RESTORE ORIGINAL SEARCH FILTERING ---
//     if (q) {
//       where.$or = [
//         { description: { $regex: String(q), $options: "i" } },
//         { referenceNumber: { $regex: String(q), $options: "i" } },
//       ];
//     }

//     console.log("Final filter for payment entries:", JSON.stringify(where, null, 2));

//     // --- SMART PAGINATION WITH ORIGINAL DEFAULTS ---
//     const pageNum = parseInt(page) || 1;
//     let limitNum = parseInt(limit) || 10000; // Keep original default
    
//     // Calculate total count first
//     const total = await PaymentEntry.countDocuments(where);
    
//     // Auto-detect large datasets and adjust
//     if (total > 10000) {
//       console.warn(`Large payment dataset detected: ${total} payments.`);
      
//       // If no explicit limit provided, use smarter default
//       if (!req.query.limit) {
//         limitNum = Math.min(limitNum, 2000); // Smarter default for large datasets
//       } else if (limitNum > 5000) {
//         console.warn(`High limit requested: ${limitNum}.`);
//       }
//     }
    
//     const skip = (pageNum - 1) * limitNum;
//     const totalPages = Math.ceil(total / limitNum);

//     // Build query (same as original)
//     const query = PaymentEntry.find(where)
//       .sort({ date: -1 })
//       .populate({ path: "vendor", select: "vendorName" })
//       .populate({ path: "expense", select: "name" })
//       .populate({ path: "company", select: "businessName" });

//     // Apply pagination logic
//     let data;
//     if (total <= 10000 && !req.query.page && !req.query.limit) {
//       // Small dataset, no pagination params = return all (like sales controller)
//       data = await query.lean();
//     } else {
//       // Large dataset or explicit pagination = use pagination
//       data = await query.skip(skip).limit(limitNum).lean();
//     }

//     // Keep original response structure but add smart metadata
//     res.status(200).json({
//       success: true,
//       total,
//       page: pageNum,
//       limit: limitNum,
//       totalPages,
//       hasMore: total > (skip + data.length),
//       data,
//     });
//   } catch (err) {
//     console.error("getPayments error:", err.message);
//     res.status(500).json({
//       success: false,
//       error: err.message,
//     });
//   }
// };

exports.getPayments = async (req, res) => {
  try {
    await ensureAuthCaps(req);

    const filter = {};
    const user = req.user || req.auth;
    const { role, allowedCompanies, clientId: authClientId, caps, userId } = req.auth;

    // console.log("🔍 PAYMENT - User role:", role);
    // console.log("🔍 PAYMENT - User ID:", userId);
    // console.log("🔍 PAYMENT - Query companyId:", req.query.companyId);
    // console.log("🔍 PAYMENT - Full caps object:", JSON.stringify(caps, null, 2));
    // console.log("🔍 PAYMENT - canShowPaymentEntries value:", caps?.canShowPaymentEntries);

    if (role === "user") {
      const canShowAllPayments = caps?.canShowPaymentEntries === true;
      
      console.log("🔍 PAYMENT - canShowAllPayments result:", canShowAllPayments);
      
      if (!canShowAllPayments) {
        // console.log("🔍 PAYMENT - User can only see their own entries. Adding filter:", userId);
        filter.createdByUser = userId;
      } else {
        console.log("🔍 PAYMENT - User can see ALL payment entries - no filter added");
      }
    }

    if (role === "client") {
      filter.client = user.id;
    } else {
      filter.client = authClientId; 
    }

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
      if (role === "user" || role === "admin") {
        if (allowedCompanies && allowedCompanies.length > 0) {
          filter.company = { $in: allowedCompanies.map(String) };
        } else {
          return res.status(200).json({
            success: true,
            total: 0,
            count: 0,
            page: 1,
            limit: 20,
            totalPages: 0,
            data: [],
            message: "No companies assigned to this user" 
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
        { paymentNumber: { $regex: searchTerm, $options: "i" } }
      ];
    }

    // console.log("🔍 PAYMENT - Final filter:", JSON.stringify(filter, null, 2));

    // --- ENHANCED PAGINATION ---
    const page = parseInt(req.query.page) || 1;
    let limit = parseInt(req.query.limit) || 20; 
    
    if (page < 1) return res.status(400).json({ success: false, message: "Page must be at least 1" });
    
    const total = await PaymentEntry.countDocuments(filter);
    
    let effectiveLimit = limit;
    if (total > 10000 && !req.query.limit) {
      effectiveLimit = Math.min(200, limit);
    }
    
    const skip = (page - 1) * effectiveLimit;
    const totalPages = Math.ceil(total / effectiveLimit) || 1;

    const query = PaymentEntry.find(filter)
      .sort({ date: -1, createdAt: -1, _id: -1 })
      .populate({ 
        path: "vendor", 
        select: "vendorName contactPerson phoneNumber email address" 
      })
      .populate({ 
        path: "expense", 
        select: "name category description",
        strictPopulate: false 
      })
      .populate({ 
        path: "company", 
        select: "businessName address gstin phoneNumber email" 
      });

    let data;
    if (total <= 10000 && !req.query.page && !req.query.limit) {
      data = await query.lean();
    } else {
      data = await query.skip(skip).limit(effectiveLimit).lean();
    }

    console.log(`🔍 PAYMENT - Found ${data.length} entries out of ${total} total`);

    const typedData = data.map(entry => ({ 
      ...entry, 
      type: "payment"
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
      metadata: {
        datasetSize: total,
        filtered: Object.keys(filter).length > 0
      }
    });
  } catch (err) {
    console.error("getPayments error:", err.message);
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
};

/** ADMIN / MASTER: list by client (optional company + pagination) */
// exports.getPaymentsByClient = async (req, res) => {
//   try {
//     await ensureAuthCaps(req);
//     if (!userIsPriv(req)) {
//       return res.status(403).json({ message: "Not authorized" });
//     }

//     const { clientId } = req.params;
//     const { companyId, page = 1, limit = 100 } = req.query;

//     // only master/admin can query arbitrary clients; client can only query self
//     if (req.auth.role === "client" && String(clientId) !== String(req.auth.clientId)) {
//       return res.status(403).json({ message: "Not authorized" });
//     }
//     if (!PRIV_ROLES.has(req.auth.role)) {
//       return res.status(403).json({ message: "Not authorized" });
//     }

//     const where = { client: clientId };
//     if (companyId) where.company = companyId;

//     const perPage = Math.min(Number(limit) || 100, 500);
//     const skip = (Number(page) - 1) * perPage;

//     // // Construct a cache key based on clientId and query parameters
//     // const cacheKey = `paymentEntriesByClient:${JSON.stringify({ client: clientId, company: companyId })}`;

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

//     const [entries, total] = await Promise.all([
//       PaymentEntry.find(where)
//         .sort({ date: -1 })
//         .skip(skip)
//         .limit(perPage)
//         .populate({ path: "vendor", select: "vendorName" })
//         .populate({ path: "expense", select: "name" })
//         .populate({ path: "company", select: "businessName" })
//         .lean(),
//       PaymentEntry.countDocuments(where),
//     ]);

//     // Cache the fetched data in Redis for future requests
//     // await setToCache(cacheKey, entries);

//     res.status(200).json({ entries, total, page: Number(page), limit: perPage });
//   } catch (err) {
//     console.error("getPaymentsByClient error:", err);
//     res.status(500).json({ error: err.message });
//   }
// };
exports.getPaymentsByClient = async (req, res) => {
  try {
    await ensureAuthCaps(req);
    if (!userIsPriv(req)) {
      return res.status(403).json({ message: "Not authorized" });
    }

    const { clientId } = req.params;
    const { companyId, page = 1, limit = 100 } = req.query;

    // --- RESTORE ORIGINAL AUTHORIZATION CHECKS ---
    // only master/admin can query arbitrary clients; client can only query self
    if (req.auth.role === "client" && String(clientId) !== String(req.auth.clientId)) {
      return res.status(403).json({ message: "Not authorized" });
    }
    if (!PRIV_ROLES.has(req.auth.role)) {
      return res.status(403).json({ message: "Not authorized" });
    }

    const where = { client: clientId };
    if (companyId) where.company = companyId;

    // --- SMART PAGINATION WITH ORIGINAL DEFAULTS ---
    const pageNum = parseInt(page) || 1;
    let limitNum = parseInt(limit) || 100; // Original default
    
    const total = await PaymentEntry.countDocuments(where);
    
    // Auto-adjust for large datasets
    if (total > 10000) {
      console.warn(`Large admin payment dataset: ${total} payments for client ${clientId}`);
      
      if (!req.query.limit) {
        limitNum = Math.min(limitNum, 2000); // Better default
      } else if (limitNum > 5000) {
        console.warn(`High admin limit requested: ${limitNum}`);
      }
    }
    
    const skip = (pageNum - 1) * limitNum;
    const totalPages = Math.ceil(total / limitNum);

    // Build query (same as original)
    const query = PaymentEntry.find(where)
      .sort({ date: -1, createdAt: -1, _id: -1 })
      .populate({ path: "vendor", select: "vendorName" })
      .populate({ path: "expense", select: "name" })
      .populate({ path: "company", select: "businessName" });

    let entries;
    if (total <= 10000 && !req.query.page && !req.query.limit) {
      entries = await query.lean();
    } else {
      entries = await query.skip(skip).limit(limitNum).lean();
    }

    // Keep original response structure
    res.status(200).json({ 
      entries, 
      total, 
      page: pageNum, 
      limit: limitNum,
      totalPages 
    });
  } catch (err) {
    console.error("getPaymentsByClient error:", err);
    res.status(500).json({ error: err.message });
  }
};


/** UPDATE */
exports.updatePayment = async (req, res) => {
  try {
    await ensureAuthCaps(req);

    const payment = await PaymentEntry.findById(req.params.id);
    if (!payment) return res.status(404).json({ message: "Payment not found" });

    if (!userIsPriv(req) && !sameTenant(payment.client, req.auth.clientId)) {
      return res.status(403).json({ message: "Not authorized" });
    }

    const { vendor, expense, isExpense, company: newCompanyId, paymentMethod, ...rest } = req.body;

    if (paymentMethod && !["Cash", "UPI", "Bank Transfer", "Cheque"].includes(paymentMethod)) {
      return res.status(400).json({ message: "Invalid payment method" });
    }

    // Company move check
    if (newCompanyId) {
      if (!companyAllowedForUser(req, newCompanyId)) {
        return res.status(403).json({ message: "You are not allowed to use this company" });
      }
      const companyDoc = await Company.findOne({ _id: newCompanyId, client: req.auth.clientId });
      if (!companyDoc) return res.status(400).json({ message: "Invalid company selected" });
      payment.company = companyDoc._id;
    }

    // Vendor/Expense move check
    let vendorDoc;
    let expenseDoc;
    if (isExpense !== undefined) {
      payment.isExpense = isExpense;
    }

    if (isExpense) {
      if (expense) {
        expenseDoc = await PaymentExpense.findOne({ _id: expense, client: req.auth.clientId });
        if (!expenseDoc) return res.status(400).json({ message: "Expense not found or unauthorized" });
        payment.expense = expenseDoc._id;
        payment.vendor = undefined; // Clear vendor when it's an expense
      } else {
        // Get expense info for notification if not changing
        expenseDoc = await PaymentExpense.findById(payment.expense);
      }
    } else {
      if (vendor) {
        vendorDoc = await Vendor.findOne({ _id: vendor, createdByClient: req.auth.clientId });
        if (!vendorDoc) return res.status(400).json({ message: "Vendor not found or unauthorized" });
        payment.vendor = vendorDoc._id;
        payment.expense = undefined; // Clear expense when it's a vendor payment
      } else {
        // Get vendor info for notification if not changing
        vendorDoc = await Vendor.findById(payment.vendor);
      }
    }

    // Update payment method if provided
    if (paymentMethod !== undefined) {
      payment.paymentMethod = paymentMethod;
    }

    // Store original amount for balance adjustment
    const originalAmount = Number(payment.amount);
    const newAmount = rest.amount != null ? Number(rest.amount) : originalAmount;

    Object.assign(payment, rest);
    await payment.save();


    // ---- DAILY LEDGER ADJUSTMENTS (EXPENSE) ----
const oldIsExpense = payment.isExpense;
const oldExpenseId = payment.expense?.toString();
const oldAmount = Number(payment.amount);
const oldDate = payment.date;
const oldCompanyId = payment.company.toString();

const newIsExpense = payment.isExpense;
const newExpenseId = payment.expense?.toString();
// const newAmount = Number(payment.amount);
const newDate = payment.date;
// const newCompanyId = payment.company.toString();

// CASE A: WAS expense → NOW not expense
if (oldIsExpense && !newIsExpense) {
  await updateDailyLedgerForExpense({
    companyId: oldCompanyId,
    clientId: req.auth.clientId,
    date: oldDate,
    expenseHeadId: oldExpenseId,
    amountDelta: -oldAmount
  });
}

// CASE B: NOW expense → WAS not expense
else if (!oldIsExpense && newIsExpense) {
  await updateDailyLedgerForExpense({
    companyId: newCompanyId,
    clientId: req.auth.clientId,
    date: newDate,
    expenseHeadId: newExpenseId,
    amountDelta: newAmount
  });
}

// CASE C: Both are expense → compare details
else if (oldIsExpense && newIsExpense) {

  // 1. Expense Head changed
  if (oldExpenseId !== newExpenseId) {
    // remove old head
    await updateDailyLedgerForExpense({
      companyId: oldCompanyId,
      clientId: req.auth.clientId,
      date: oldDate,
      expenseHeadId: oldExpenseId,
      amountDelta: -oldAmount
    });

    // add new head
    await updateDailyLedgerForExpense({
      companyId: newCompanyId,
      clientId: req.auth.clientId,
      date: newDate,
      expenseHeadId: newExpenseId,
      amountDelta: newAmount
    });
  }

  // 2. Amount changed
  else if (oldAmount !== newAmount) {
    const delta = newAmount - oldAmount;

    await updateDailyLedgerForExpense({
      companyId: newCompanyId,
      clientId: req.auth.clientId,
      date: newDate,
      expenseHeadId: newExpenseId,
      amountDelta: delta
    });
  }

  // 3. Date or Company changed
  else if (oldDate.toString() !== newDate.toString() || oldCompanyId !== newCompanyId) {
    await updateDailyLedgerForExpense({
      companyId: oldCompanyId,
      clientId: req.auth.clientId,
      date: oldDate,
      expenseHeadId: oldExpenseId,
      amountDelta: -oldAmount
    });

    await updateDailyLedgerForExpense({
      companyId: newCompanyId,
      clientId: req.auth.clientId,
      date: newDate,
      expenseHeadId: newExpenseId,
      amountDelta: newAmount
    });
  }
}


    // Handle vendor balance adjustment for amount changes (only for vendor payments)
    if (!payment.isExpense) {
      const amountDifference = newAmount - originalAmount;
      if (amountDifference !== 0) {
        const currentVendorDoc = await Vendor.findById(payment.vendor);
        if (currentVendorDoc) {
          // Update company-specific balance
          if (!currentVendorDoc.balances) currentVendorDoc.balances = new Map();
          const companyIdStr = payment.company.toString();
          const currentBalance = currentVendorDoc.balances.get(companyIdStr) || 0;
          currentVendorDoc.balances.set(companyIdStr, currentBalance + Number(amountDifference));
          await currentVendorDoc.save();
        }
      }
    }

    const companyId = payment.company.toString();
    const entityName = payment.isExpense
      ? (expenseDoc?.name || "Unknown Expense")
      : (vendorDoc?.name || vendorDoc?.vendorName || vendorDoc?.title || "Unknown Vendor");

    await notifyAdminOnPaymentAction({
      req,
      action: "update",
      vendorName: entityName,
      entryId: payment._id,
      companyId,
    });

    try {
      if (global.io) {
        console.log('📡 Emitting transaction-update (update payment)...');

        const socketPayload = {
          message: 'Payment Updated',
          type: 'payment',
          action: 'update',
          entryId: payment._id,
          amount: newAmount,
          vendorName: entityName
        };

        // Emit to Client Room
        global.io.to(`client-${req.auth.clientId}`).emit('transaction-update', socketPayload);

        // Emit to Global Room
        global.io.to('all-transactions-updates').emit('transaction-update', {
          ...socketPayload,
          clientId: req.auth.clientId
        });
      }
    } catch (socketError) {
      console.error("⚠️ Socket Emit Failed (Payment Update):", socketError.message);
    }

    // Invalidate cache
    // await deletePaymentEntryCache(payment.client.toString(), companyId);

    res.json({ message: "Payment updated", payment });

  } catch (err) {
    console.error("updatePayment error:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
};

/** GET BY ID */
exports.getPaymentById = async (req, res) => {
  try {
    await ensureAuthCaps(req);

    const payment = await PaymentEntry.findById(req.params.id)
      .populate({ path: "vendor", select: "vendorName" })
      .populate({ path: "expense", select: "name" })
      .populate({ path: "company", select: "businessName" });

    if (!payment) return res.status(404).json({ message: "Payment not found" });

    if (!userIsPriv(req) && !sameTenant(payment.client, req.auth.clientId)) {
      return res.status(403).json({ message: "Not authorized" });
    }

    res.json({ payment });
  } catch (err) {
    console.error("getPaymentById error:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
};

/** DELETE */
exports.deletePayment = async (req, res) => {
  try {
    await ensureAuthCaps(req);

    const payment = await PaymentEntry.findById(req.params.id);
    if (!payment) return res.status(404).json({ message: "Payment not found" });

    if (!userIsPriv(req) && !sameTenant(payment.client, req.auth.clientId)) {
      return res.status(403).json({ message: "Not authorized" });
    }
    // Get entity info before deletion for notification
    let entityDoc;
    if (payment.isExpense) {
      entityDoc = await PaymentExpense.findById(payment.expense);
    } else {
      entityDoc = await Vendor.findById(payment.vendor);
    }

    // Handle vendor balance reversal for payment deletion (only for vendor payments)
    if (!payment.isExpense && entityDoc) {
      // Update company-specific balance
      if (!entityDoc.balances) entityDoc.balances = new Map();
      const companyIdStr = payment.company.toString();
      const currentBalance = entityDoc.balances.get(companyIdStr) || 0;
      entityDoc.balances.set(companyIdStr, currentBalance - Number(payment.amount));
      await entityDoc.save();
    }

    await payment.deleteOne();

    // ---- DAILY LEDGER REVERSE FOR EXPENSE ----
if (payment.isExpense) {
  try {
    await updateDailyLedgerForExpense({
      companyId: payment.company.toString(),
      clientId: payment.client.toString(),
      date: payment.date,
      expenseHeadId: payment.expense.toString(),
      amountDelta: -Number(payment.amount)
    });
  } catch (ledgerError) {
    console.error('⚠️ Daily ledger reversal failed (payment still deleted):', ledgerError.message);
    // Payment deletion continues successfully
  }
}


    const entityName = payment.isExpense
      ? (entityDoc?.name || "Unknown Expense")
      : (entityDoc?.name || entityDoc?.vendorName || entityDoc?.title || "Unknown Vendor");

    await notifyAdminOnPaymentAction({
      req,
      action: "delete",
      vendorName: entityName,
      entryId: payment._id,                 // ok to reference deleted id
      companyId: payment.company.toString(),
    });

    try {
      if (global.io) {
        console.log('📡 Emitting transaction-update (delete payment)...');

        const socketPayload = {
          message: 'Payment Deleted',
          type: 'payment',
          action: 'delete',
          entryId: payment._id,
          vendorName: entityName
        };

        // Emit to Client Room
        global.io.to(`client-${req.auth.clientId}`).emit('transaction-update', socketPayload);

        // Emit to Global Room
        global.io.to('all-transactions-updates').emit('transaction-update', {
          ...socketPayload,
          clientId: req.auth.clientId
        });
      }
    } catch (socketError) {
      console.error("⚠️ Socket Emit Failed (Payment Delete):", socketError.message);
    }
    
    // Invalidate cache
    const companyId = payment.company.toString();
    // await deletePaymentEntryCache(payment.client.toString(), companyId);

    res.json({ message: "Payment deleted" });

  } catch (err) {
    console.error("deletePayment error:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
};


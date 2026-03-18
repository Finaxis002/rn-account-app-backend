
// controllers/salesController.js
const mongoose = require("mongoose");
const SalesEntry = require("../models/SalesEntry");
const Company = require("../models/Company");
const Party = require("../models/Party");
const User = require("../models/User");
const BankDetail = require("../models/BankDetail");
const normalizeProducts = require("../utils/normalizeProducts");
const normalizeServices = require("../utils/normalizeServices");
const IssuedInvoiceNumber = require("../models/IssuedInvoiceNumber");
const { issueSalesInvoiceNumber } = require("../services/invoiceIssuer");
// at top of controllers/salesController.js..
const { getEffectivePermissions } = require("../services/effectivePermissions");
const { sendCreditReminderEmail } = require("../services/emailService");
const { createNotification } = require("./notificationController");
const { resolveActor, findAdminUser } = require("../utils/actorUtils");
const Product = require("../models/Product");
const StockBatch = require("../models/StockBatch");
const DailyStockLedger = require("../models/DailyStockLedger");
const additionalServiceSchema = require("../models/AdditionalService");

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
  if (req.auth?.role === "master" || req.auth?.role === "client") return true;
  const allowed = Array.isArray(req.auth.allowedCompanies)
    ? req.auth.allowedCompanies.map(String)
    : [];
  return allowed.includes(String(companyId));
}



// Build message text per action
function buildSalesNotificationMessage(
  action,
  { actorName, partyName, invoiceNumber, amount }
) {
  const pName = partyName || "Unknown Party";
  switch (action) {
    case "create":
      return (
        `New sales entry created by ${actorName} for customer ${pName}` +
        (amount != null ? ` of ₹${amount}.` : ".")
      );
    case "update":
      return `Sales entry updated by ${actorName} for customer ${pName}.`;
    case "delete":
      return `Sales entry deleted by ${actorName} for customer ${pName}.`;
    default:
      return `Sales entry ${action} by ${actorName} for customer ${pName}.`;
  }
}

// Unified notifier for sales module
async function notifyAdminOnSalesAction({
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
    console.warn("notifyAdminOnSalesAction: no admin user found");
    return;
  }

  const message = buildSalesNotificationMessage(action, {
    actorName: actor.name,
    partyName,
    amount,
  });

  await createNotification(
    message,
    adminUser._id, // recipient (admin)
    actor.id, // actor id (user OR client)
    action, // "create" | "update" | "delete"
    "sales", // entry type / category
    entryId, // sales entry id
    req.auth.clientId
  );
}

/**
 * Consume stock from batches for sales (FIFO) with Legacy Stock Fallback
 * * NOTE: This function relies on Mongoose models: StockBatch, Product
 */
async function consumeStockForSales(salesEntry, products, session = null) {
  try {
    const consumptionResults = [];
    let totalCOGS = 0;

    for (const item of products) {
      const productId = item.product;
      const quantityToConsume = Number(item.quantity) || 0;

      if (!quantityToConsume) continue;
      // 1. Attempt to consume from active Stock Batches (FIFO)
      const activeBatches = await StockBatch.find({
        product: productId,
        companyId: salesEntry.company,
        clientId: salesEntry.client,
        status: { $in: ["active", "partial", "sold"] }, // Include sold/partial for remainingQty > 0 logic
        remainingQuantity: { $gt: 0 }
      })
        .sort({ purchaseDate: 1 })
        .session(session);
      let remainingQty = quantityToConsume;
      const consumedBatches = [];
      let itemCOGS = 0;

      // --- Consume from existing batches ---
      for (const batch of activeBatches) {
        if (remainingQty <= 0) break;
        const consumeQty = Math.min(remainingQty, batch.remainingQuantity);
        if (consumeQty <= 0) continue;

        batch.remainingQuantity -= consumeQty;
        remainingQty -= consumeQty;
        const batchCOGS = consumeQty * batch.costPrice;
        itemCOGS += batchCOGS;
        totalCOGS += batchCOGS;
        // push log into batch
        batch.consumedBySales.push({
          salesEntry: salesEntry._id,
          consumedQty: consumeQty,
          consumedAt: new Date()
        });

        consumedBatches.push({
          batchId: batch._id,
          consumedQty: consumeQty,
          costPrice: batch.costPrice,
          cogs: batchCOGS
        });

        if (batch.remainingQuantity === 0) {
          batch.status = "sold";
          batch.isActive = false;
        }

        await batch.save({ session });
      }
      // 2.  LEGACY STOCK FALLBACK (CRITICAL FIX) 
      if (remainingQty > 0) {
        // Get product master stock
        const productMaster = await Product.findById(productId).session(session);
        const masterStock = (productMaster && productMaster.stocks) || 0;

        // Calculate the quantity already consumed from *anywhere* (master or batches)
        const consumedPrior = quantityToConsume - remainingQty;
        // Calculate stock remaining in Product Master that hasn't been tracked by batches yet
        const availableInBatches = activeBatches.reduce((sum, batch) => sum + batch.remainingQuantity, 0) + consumedPrior;

        const currentBatchedStock = activeBatches.reduce((sum, batch) => sum + batch.remainingQuantity, 0);



        // Allow negative stock - consume even if masterStock is less than quantityToConsume
        const neededFromLegacy = remainingQty;
        const costPrice = productMaster.costPrice || 0;

        const newLegacyBatch = await StockBatch.create([{
          product: productId,
          companyId: salesEntry.company,
          clientId: salesEntry.client,
          remainingQuantity: 0,
          initialQuantity: neededFromLegacy,
          costPrice: costPrice,
          purchaseDate: new Date("2000-01-01"),
          type: 'LEGACY_MIGRATION',
          status: 'sold',
          isActive: false
        }], { session });

        const batchCOGS = neededFromLegacy * costPrice;
        itemCOGS += batchCOGS;
        totalCOGS += batchCOGS;

        // Add consumption log
        newLegacyBatch[0].consumedBySales.push({
          salesEntry: salesEntry._id,
          consumedQty: neededFromLegacy,
          consumedAt: new Date()
        });
        await newLegacyBatch[0].save({ session });

        // Mark consumption complete
        remainingQty = 0;

        consumedBatches.push({
          batchId: newLegacyBatch[0]._id,
          consumedQty: neededFromLegacy,
          costPrice: costPrice,
          cogs: batchCOGS
        });
        console.log(`[SUCCESS LEGACY] Consumed ${neededFromLegacy} units via new LEGACY batch creation. Master Stock was ${masterStock}.`);
      }
      // 3. --- No error thrown for negative stock - allow it ---
      // If remainingQty > 0, it means we need to allow negative stock
      if (remainingQty > 0) {
        console.log(`🟠 Allowing negative stock: Available: ${masterStock}, Requested: ${quantityToConsume}, Shortage: ${remainingQty}`);
        // The shortage will be handled by the product stock going negative
      }
      // 4. --- Update Product Master Stock (allow negative values) ---
      const product = await Product.findById(productId).session(session);
      if (product) {
        product.stocks = (product.stocks || 0) - quantityToConsume;
        await product.save({ session });
      }
      consumptionResults.push({
        productId,
        quantity: quantityToConsume,
        cogs: itemCOGS,
        batches: consumedBatches
      });
    }
    return { consumptionResults, totalCOGS };
  } catch (error) {
    console.error("Error consuming stock for sales:", error);
    throw error;
  }
}



async function updateDailyStockLedgerForSales(salesEntry, products, currentSaleCOGS, session = null) {
  try {
    const salesDate = new Date(salesEntry.date);
    salesDate.setUTCHours(18, 30, 0, 0);

    // 1. Calculate Totals for THIS specific sale
    const salesQuantity = products.reduce((sum, item) => sum + item.quantity, 0);
    const salesAmount = products.reduce((sum, item) => sum + (item.quantity * item.pricePerUnit), 0);

    // 2. Fetch Latest Ledger (Opening Stock ke liye) - regardless of date gap
    const latestLedger = await DailyStockLedger.findOne({
      companyId: salesEntry.company,
      clientId: salesEntry.client,
      date: { $lt: salesDate }   // Any date before sales date
    })
      .sort({ date: -1 })           // Sort by date descending to get latest
      .session(session);

    const openingStockDefaults = latestLedger ? latestLedger.closingStock : { quantity: 0, amount: 0 };

    // ------------------------------------------------------------------
    // STEP 1: FIND OR CREATE LEDGER (FIXED FOR UNIQUE INDEX)
    // ------------------------------------------------------------------

    // First, try to find existing ledger using the unique index fields
    let ledger = await DailyStockLedger.findOne({
      companyId: salesEntry.company,
      clientId: salesEntry.client,
      date: salesDate
    }).session(session);

    if (!ledger) {
      // Create new ledger document
      ledger = new DailyStockLedger({
        clientId: salesEntry.client,
        companyId: salesEntry.company,
        date: salesDate,
        openingStock: openingStockDefaults,
        totalPurchaseOfTheDay: { quantity: 0, amount: 0 },
        totalSalesOfTheDay: { quantity: 0, amount: 0 },
        totalCOGS: 0,
        closingStock: { quantity: 0, amount: 0 }
      });
      await ledger.save({ session });
    }

    // ------------------------------------------------------------------
    // STEP 2: UPDATE THE LEDGER VALUES
    // ------------------------------------------------------------------

    // Update with simple increments
    ledger.totalSalesOfTheDay.quantity += salesQuantity;
    ledger.totalSalesOfTheDay.amount += salesAmount;
    ledger.totalCOGS += currentSaleCOGS;

    // ------------------------------------------------------------------
    // STEP 3: RECALCULATE CLOSING STOCK
    // ------------------------------------------------------------------

    const totalOpeningQty = ledger.openingStock.quantity;
    const totalOpeningAmt = ledger.openingStock.amount;

    const totalPurchaseQty = ledger.totalPurchaseOfTheDay.quantity;
    const totalPurchaseAmt = ledger.totalPurchaseOfTheDay.amount;

    const totalSalesQty = ledger.totalSalesOfTheDay.quantity;
    const totalCOGS = ledger.totalCOGS;

    // Calculation Formula: (Opening + Purchase) - Sales/COGS
    const finalClosingQty = (totalOpeningQty + totalPurchaseQty) - totalSalesQty;
    const finalClosingAmt = (totalOpeningAmt + totalPurchaseAmt) - totalCOGS;

    // Allow negative values for closing stock
    ledger.closingStock.quantity = finalClosingQty;
    ledger.closingStock.amount = finalClosingAmt;

    // Save final state
    await ledger.save({ session });

    console.log('✅ Daily Stock Ledger Updated Successfully');
    console.log('   Closing Stock:', ledger.closingStock.quantity, 'units');

    return ledger;

  } catch (error) {
    console.error('Error updating daily stock ledger:', error);
    throw error;
  }
}




async function reverseStockForSales(salesEntry, session = null) {
  try {
    const saleId = salesEntry._id.toString();
    const stockImpact = Array.isArray(salesEntry.stockImpact)
      ? salesEntry.stockImpact
      : [];

    if (!stockImpact.length) {
      console.log(
        `ℹ️ No stockImpact stored for sale entry ${saleId}. Skipping stock reversal.`
      );
      return { hadStockImpact: false, originalCOGS: 0 };
    }

    let originalCOGS = 0;
    const qtyByProduct = new Map();

    for (const impact of stockImpact) {
      const productId =
        (impact.productId && impact.productId.toString()) ||
        (impact.product && impact.product.toString());

      for (const b of impact.batches || []) {
        const batchId = b.batchId || b._id;
        const qty = Number(b.consumedQty) || 0;
        if (!batchId || !qty) continue;

        const batch = await StockBatch.findById(batchId).session(session);
        if (!batch) continue;

        batch.remainingQuantity = (batch.remainingQuantity || 0) + qty;

        // clean logs for this sale
        batch.consumedBySales = (batch.consumedBySales || []).filter(
          log =>
            !(
              log.salesEntry &&
              log.salesEntry.toString() === saleId &&
              Number(log.consumedQty) === qty
            )
        );

        if (batch.remainingQuantity > 0 && batch.status === "sold") {
          batch.status = "active";
          batch.isActive = true;
        }

        await batch.save({ session });

        originalCOGS += qty * (b.costPrice || batch.costPrice || 0);

        if (productId) {
          qtyByProduct.set(
            productId,
            (qtyByProduct.get(productId) || 0) + qty
          );
        }

        console.log(
          `🔁 Reversed batch ${batch._id}: +${qty} units @ ₹${b.costPrice || batch.costPrice
          }`
        );
      }
    }

    // restore product.stocks
    for (const [productId, qty] of qtyByProduct.entries()) {
      const product = await Product.findById(productId).session(session);
      if (product) {
        product.stocks = (product.stocks || 0) + qty;
        await product.save({ session });
        console.log(
          `🔁 Restored product stock: ${product.name} += ${qty} → ${product.stocks}`
        );
      }
    }

    console.log(
      `✅ Stock reversal done for sale entry ${saleId}. Restored COGS: ₹${originalCOGS}`
    );

    return { hadStockImpact: true, originalCOGS };
  } catch (error) {
    console.error("Error reversing stock for sales:", error);
    throw error;
  }
}




/**
 * Reverse the daily stock ledger impact for a sales entry
 * using the ORIGINAL products & ORIGINAL COGS.
 */
async function reverseDailyStockLedgerForSales(
  salesEntry,
  originalProducts,
  originalSaleCOGS,
  session = null
) {
  if (!Array.isArray(originalProducts) || !originalProducts.length) {
    console.log("ℹ️ No original products to reverse in ledger.");
    return;
  }

  // Build "negative" products so updateDailyStockLedgerForSales subtracts them
  const reversedProducts = originalProducts.map(p => {
    const obj = p.toObject ? p.toObject() : p;
    const qty = Number(obj.quantity) || 0;

    let pricePerUnit = 0;
    if (obj.pricePerUnit != null) {
      pricePerUnit = Number(obj.pricePerUnit) || 0;
    } else if (qty !== 0 && obj.amount != null) {
      pricePerUnit = (Number(obj.amount) || 0) / qty;
    }

    return {
      quantity: -Math.abs(qty),
      pricePerUnit
    };
  });

  const negativeCOGS = -Math.abs(originalSaleCOGS || 0);

  console.log(
    `🔁 Reversing ledger for sale ${salesEntry._id} with negative qty and COGS: ₹${negativeCOGS}`
  );

  return updateDailyStockLedgerForSales(
    salesEntry,
    reversedProducts,
    negativeCOGS,
    session
  );
}




// exports.getSalesEntries = async (req, res) => {
//   try {
//     await ensureAuthCaps(req);

//     const filter = {};
//     const user = req.user;

//     console.log("User role:", user.role);
//     console.log("User ID:", user.id);
//     console.log("Query companyId:", req.query.companyId);

//     // Handle company filtering properly
//     if (req.query.companyId) {
//       // Validate company access
//       if (!companyAllowedForUser(req, req.query.companyId)) {
//         return res.status(403).json({
//           success: false,
//           message: "Access denied to this company"
//         });
//       }
//       filter.company = req.query.companyId;
//     } else {
//       // If no specific company requested, filter by user's accessible companies
//       if (req.auth.allowedCompanies && req.auth.allowedCompanies.length > 0) {
//         filter.company = { $in: req.auth.allowedCompanies };
//       } else if (user.role === "user") {
//         // Regular users should only see data from their assigned companies
//         return res.status(200).json({
//           success: true,
//           count: 0,
//           data: [],
//         });
//       }
//       // For master/admin, no company filter = see all data
//     }

//     // For client users, also filter by client ID
//     if (user.role === "client") {
//       filter.client = user.id;
//     }

//     console.log("Final filter for sales entries:", JSON.stringify(filter, null, 2));

//     const entries = await SalesEntry.find(filter)
//       .populate("party", "name")
//       .populate("products.product", "name")
//       .populate({
//         path: "services.service",
//         select: "serviceName",
//         strictPopulate: false,
//       })
//       .populate("company", "businessName")
//       .populate("shippingAddress")
//       .populate("bank")
//       .sort({ date: -1 });

//     console.log(`Found ${entries.length} sales entries for user ${user.role}/${user.id}`);

//     res.status(200).json({
//       success: true,
//       count: entries.length,
//       data: entries,
//     });
//   } catch (err) {
//     console.error("Error fetching sales entries:", err.message);
//     res.status(500).json({
//       success: false,
//       error: err.message,
//     });
//   }
// };


exports.getSalesEntriesByClient = async (req, res) => {
  try {
    const { clientId } = req.params;

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
    // Fetch data from database if not cached
    const entries = await SalesEntry.find({ client: clientId })
      .populate("party", "name")
      .populate("products.product", "name")
      .populate({
        path: "services.service",
        select: "serviceName",
        strictPopulate: false,
      })
      .populate({
        path: "additionalServices.service",
        select: "serviceName",
        strictPopulate: false,
      })
      .populate("company", "businessName")
      .populate("shippingAddress")
      .populate("bank")
      .sort({ date: -1 });

    res.status(200).json({ entries });
  } catch (err) {
    res
      .status(500)
      .json({ message: "Failed to fetch entries", error: err.message });
  }
};


exports.getSalesEntries = async (req, res) => {
  try {
    await ensureAuthCaps(req);

    const filter = {};
    const user = req.user;
    const { clientId, role, allowedCompanies, caps, userId } = req.auth;
    console.log("User role:", user.role);
    console.log("User ID:", user.id);
    console.log("Query companyId:", req.query.companyId);

   
    if (role === "user") {
      
      const canShowAllSales = caps?.canShowSaleEntries === true;
      
      console.log("User permissions - canShowAllSales:", canShowAllSales);
      console.log("User caps:", caps);
      
      if (!canShowAllSales) {
       
        // console.log("User can only see their own entries. User ID:", userId);
        filter.createdByUser = userId;
      } else {
        console.log("User can see ALL sales entries");
      }
      
    }

    // --- Company Filter Logic ---
    if (req.query.companyId && req.query.companyId !== "all") {
      if (!companyAllowedForUser(req, req.query.companyId)) {
        return res.status(403).json({
          success: false,
          message: "Access denied"
        });
      }
      filter.company = req.query.companyId;
    } else {
      if (role === "admin" || role === "user") {
        if (allowedCompanies && allowedCompanies.length > 0) {
          filter.company = { $in: allowedCompanies.map(String) };
        } else {
          return res.status(200).json({
            success: true,
            count: 0,
            data: []
          });
        }
      }
    }

    if (req.auth.clientId) {
      filter.client = req.auth.clientId;
    }

    // Date filters
    const { startDate, endDate } = req.query;
    if (startDate || endDate) {
      filter.date = {};
      if (startDate) filter.date.$gte = new Date(`${startDate}T00:00:00`);
      if (endDate) filter.date.$lte = new Date(`${endDate}T23:59:59`);
    }

    // --- Dashboard Logic (no pagination) ---
    const isDashboard = req.query.isDashboard === 'true';

    if (isDashboard) {
      const entries = await SalesEntry.find(filter)
        .populate("party", "name")
        .populate("products.product", "name productName") 
        .populate("party", "name")
        .sort({ date: -1, createdAt: -1, _id: -1 });

      return res.status(200).json({
        success: true,
        count: entries.length,
        data: entries,
      });
    }

    // --- Normal Pagination Logic ---
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    // Get total count
    const totalCount = await SalesEntry.countDocuments(filter);

    // Get paginated data
    const entries = await SalesEntry.find(filter)
      .skip(skip)
      .limit(limit)
      .populate("party", "name")
      .populate("products.product", "name")
      .populate({
        path: "services.service",
        select: "serviceName",
        strictPopulate: false,
      })
      .populate({
        path: "additionalServices.service",
        select: "serviceName",
        strictPopulate: false,
      })
      .populate("additionalServices.service", "serviceName")
      .populate("company", "businessName")
      .populate("shippingAddress")
      .populate("bank")
      .sort({ date: -1, createdAt: -1, _id: -1 });

    const totalPages = Math.ceil(totalCount / limit);
    // console.log(`Found ${entries.length} entries. Filter used:`, JSON.stringify(filter));

    return res.status(200).json({
      success: true,
      count: entries.length,
      total: totalCount,
      data: entries,
      pagination: {
        page,
        limit,
        totalPages,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1,
      }
    });
  } catch (err) {
    console.error("Error fetching sales entries:", err.message);
    return res.status(500).json({
      success: false,
      error: err.message,
    });
  }
};
 // 
 
// GET Sales Entries by clientId (for master admin)
exports.getSalesEntriesByClient = async (req, res) => {
  try {
    const { clientId } = req.params;

    // // Construct a cache key based on clientId
    // const cacheKey = `salesEntriesByClient:${clientId}`;

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

    // Fetch data from database if not cached
    const entries = await SalesEntry.find({ client: clientId })
      .populate("party", "name")
      .populate("products.product", "name")
      .populate({
        path: "services.service",
        select: "serviceName",
        strictPopulate: false,
      })
      .populate("additionalServices.service", "serviceName")
      .populate("company", "businessName")
      .populate("shippingAddress")
      .populate("bank")
      .sort({ date: -1, createdAt: -1, _id: -1 });

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


exports.createSalesEntry = async (req, res) => {
  const session = await mongoose.startSession();
  let entry, companyDoc, partyDoc;

  try {
    // Ensure the user has permission
    await ensureAuthCaps(req);
    if (!userIsPriv(req) && !req.auth.caps?.canCreateSaleEntries) {
      return res
        .status(403)
        .json({ message: "Not allowed to create sales entries" });
    }

    // Destructure the request body
    const { company: companyId, paymentMethod, party } = req.body;

    // Normalize paymentMethod to handle empty strings
    const normalizedPaymentMethod = paymentMethod || undefined;

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
        additionalServices,
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
         advanceReceived,
  extraDiscount,
   extraDiscountType,
  customRemark,
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

      // Normalize services with GST calculations (supports additional services)
      let normalizedServices = [],
        servicesTotal = 0,
        servicesTax = 0;
      if (Array.isArray(services) && services.length > 0) {
        const { items, computedTotal, computedTax } = await normalizeServices(
          services,
          req.auth.clientId
        );
        normalizedServices = items.map((item, i) => ({
          ...item,
          isAdditionalService: !!services[i]?.isAdditionalService,
          serviceModel: services[i]?.isAdditionalService ? "AdditionalService" : "Service",
          travelDate: services[i]?.travelDate
            ? new Date(services[i].travelDate)
            : services[i]?.serviceStartDate
              ? new Date(services[i].serviceStartDate)
              : item.travelDate,
          travelFrom: services[i]?.travelFrom ?? item.travelFrom ?? "",
          travelTo: services[i]?.travelTo ?? item.travelTo ?? "",
          vehicleType: services[i]?.vehicleType ?? item.vehicleType ?? "",
          vehicleNumber: services[i]?.vehicleNumber ?? item.vehicleNumber ?? "",
          variableUnit:
            services[i]?.variableUnit ?? item.variableUnit ?? item.unitType ?? "Km",
          fixedCharges:
            services[i]?.fixedCharges !== undefined
              ? Number(services[i].fixedCharges) || 0
              : Number(item.fixedCharges ?? services[i]?.pricePerUnit ?? 0) ||
                0,
          variableQty:
            services[i]?.variableQty !== undefined
              ? Number(services[i].variableQty) || 0
              : Number(item.variableQty ?? 0) || 0,
          variableRate:
            services[i]?.variableRate !== undefined
              ? Number(services[i].variableRate) || 0
              : Number(item.variableRate ?? 0) || 0,
          variableCharges:
            services[i]?.variableCharges !== undefined
              ? Number(services[i].variableCharges) || 0
              : item.variableCharges ?? 0,
          quantity: Number(services[i]?.quantity) || item.quantity || 1,
          unitType: services[i]?.unitType || item.unitType || "Hours",
          pricePerUnit:
            Number(services[i]?.pricePerUnit) ||
            item.pricePerUnit ||
            Number(services[i]?.fixedCharges) ||
            0,
          serviceStartDate:
            services[i]?.serviceStartDate || services[i]?.travelDate
              ? new Date(services[i]?.serviceStartDate || services[i]?.travelDate)
              : item.serviceStartDate,
          serviceDueDate: services[i]?.serviceDueDate
            ? new Date(services[i].serviceDueDate)
            : item.serviceDueDate,
        }));
        servicesTotal = computedTotal;
        servicesTax = computedTax;
      }

      const normalizedAdditionalServices = normalizedServices.filter(
        (s) => s.isAdditionalService,
      );
      const normalizedRegularServices = normalizedServices.filter(
        (s) => !s.isAdditionalService,
      );



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
          await issueSalesInvoiceNumber(companyDoc._id, atDate, { session });

        try {
          const docs = await SalesEntry.create(
            [
              {
                party: partyDoc._id,
                company: companyDoc._id,
                client: req.auth.clientId,
                date,
              dueDate,
                products: normalizedProducts,
                services: normalizedRegularServices,
                additionalServices: normalizedAdditionalServices.map((s) => ({
                  service: s.service,
                  serviceName: s.serviceName,
                  amount: s.amount,
                  description: s.description,
                  serviceStartDate: s.serviceStartDate || s.travelDate || null,
                  serviceDueDate: s.serviceDueDate || null,
                })),
                totalAmount: finalTotal,
                taxAmount: finalTaxAmount, // NEW: Save total tax amount
                subTotal: computedSubtotal, // NEW: Save subtotal
                discountType: req.body.discountType || "fixed",
                discountValue: Number(req.body.discountValue) || 0,
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
                paymentMethod: normalizedPaymentMethod,
                createdByUser: req.auth.userId,
                notes: notes || "",
                shippingAddress: shippingAddress,
                bank: bank,
                  advanceReceived: Number(advanceReceived) || 0,
                  extraDiscount: Number(extraDiscount) || 0,   
      extraDiscountType: extraDiscountType || "fixed",
netPayable: (() => {
  const base = finalTotal;
  const amt = extraDiscountType === "percentage"
    ? +(base * (Number(extraDiscount) / 100)).toFixed(2)
    : Number(extraDiscount) || 0;
  return +(base - amt).toFixed(2);
})(),
      customRemark: customRemark || "",
      // invoiceTotal: finalTotal, // ← invoiceTotal = finalTotal
              },
            ],
            { session }
          );

          entry = docs[0];

          if (normalizedProducts && normalizedProducts.length > 0) {
            try {
              // Consume stock from batches (FIFO) - get both results and COGS
              // Consume stock and get exact batch-wise impact
              const { consumptionResults, totalCOGS } = await consumeStockForSales(entry, normalizedProducts, session);

              // 🔥 SAVE THE IMPACT SO UPDATE CAN REVERSE IT PERFECTLY
              entry.stockImpact = consumptionResults;
              await entry.save({ session });

              // Update daily stock ledger AFTER stockImpact is saved
              await updateDailyStockLedgerForSales(entry, normalizedProducts, totalCOGS, session);


              console.log(`✅ Stock consumed for sales: ${consumptionResults.length} products, Total COGS: ₹${totalCOGS}`);


              // Socket emit for sale creation
              try {
                if (global.io) {
                  console.log('📡 Emitting transaction-update (create sale)...');

                  const customerName = partyDoc?.name || 'Unknown Customer';

                  const socketPayload = {
                    message: 'New Sale Entry',
                    type: 'sale',
                    action: 'create',
                    entryId: entry._id,
                    amount: entry.totalAmount,
                    customerName: customerName
                  };

                  // Emit to Client Room
                  global.io.to(`client-${req.auth.clientId}`).emit('transaction-update', socketPayload);

                  // Emit to Global/Admin Room
                  global.io.to('all-transactions-updates').emit('transaction-update', {
                    ...socketPayload,
                    clientId: req.auth.clientId
                  });

                  // Optional: Emit for inventory updates
                  if (entry.company) {
                    global.io.to(`company-${entry.company.toString()}`).emit('inventory-update', {
                      message: 'Sale entry created',
                      entryId: entry._id,
                      companyId: entry.company.toString(),
                      clientId: req.auth.clientId,
                      type: 'sale'
                    });
                  }
                }
              } catch (socketError) {
                console.error("⚠️ Socket Emit Failed (Sale Create):", socketError.message);
              }

            } catch (stockError) {
              console.error('Error in stock consumption:', stockError);
              throw new Error(`Stock consumption failed: ${stockError.message}`);
            }
          }

          // ✅ ADD THIS: UPDATE PARTY BALANCE FOR COMPANY
          if (normalizedPaymentMethod === "Credit") {
            await Party.findByIdAndUpdate(
              partyDoc._id,
              {
                $inc: {
                  // Update company-specific balance
                  [`balances.${companyDoc._id}`]: entry.totalAmount
                }
              },
              { session }
            );
            console.log(`✅ Updated party balance for company ${companyDoc._id}: +${entry.totalAmount}`);
          }

          // Ensure only one response is sent
          if (!res.headersSent) {
            // After sales entry is created, notify the admin

            // Notify admin AFTER entry created (and before response)
            await notifyAdminOnSalesAction({
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
                  series: "sales",
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
              .json({ message: "Sales entry created successfully", entry });
          }
        } catch (e) {
          if (e?.code === 11000 && attempts < 20) continue;
          throw e;
        }
      }
    });

    const clientId = entry.client.toString(); // Retrieve clientId from the entry

    // Call the reusable cache deletion function
    // await deleteSalesEntryCache(clientId, companyId);
  } catch (err) {
    console.error("createSalesEntry error:", err);
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



// exports.updateSalesEntry = async (req, res) => {
//   const session = await mongoose.startSession();

//   try {
//     // Ensure the user has permission
//     await ensureAuthCaps(req);
//     if (!userIsPriv(req) && !req.auth.caps?.canCreateSaleEntries) {
//       return res.status(403).json({ message: "Not allowed to update sales entries" });
//     }

//     // Find the sales entry by ID
//     const entry = await SalesEntry.findById(req.params.id);
//     if (!entry)
//       return res.status(404).json({ message: "Sales entry not found" });

//     // Tenant auth: allow privileged roles or same tenant only
//     if (!userIsPriv(req) && !sameTenant(entry.client, req.auth.clientId)) {
//       return res.status(403).json({ message: "Unauthorized" });
//     }

//     const { products, services, paymentMethod, totalAmount, party, shippingAddress, bank, ...otherUpdates } = req.body;

//     // Normalize paymentMethod
//     const normalizedPaymentMethod = paymentMethod || undefined;

//     // Store original values for credit adjustment
//     const originalPaymentMethod = entry.paymentMethod;
//     const originalTotalAmount = entry.totalAmount;
//     const originalPartyId = entry.party.toString();
//     const originalCompanyId = entry.company.toString(); // Store original company ID

//     // If company is being changed, check permission + existence
//     if (otherUpdates.company) {
//       if (!companyAllowedForUser(req, otherUpdates.company)) {
//         return res
//           .status(403)
//           .json({ message: "You are not allowed to use this company" });
//       }
//       const company = await Company.findOne({
//         _id: otherUpdates.company,
//         client: req.auth.clientId,
//       });
//       if (!company) {
//         return res.status(400).json({ message: "Invalid company selected" });
//       }
//     }

//     // If party is being changed, validate it belongs to the same tenant
//     let partyDoc = null;
//     if (otherUpdates.party) {
//       partyDoc = await Party.findOne({
//         _id: otherUpdates.party,
//         createdByClient: req.auth.clientId,
//       });
//       if (!partyDoc) {
//         return res
//           .status(400)
//           .json({ message: "Customer not found or unauthorized" });
//       }
//     }

//     let productsTotal = 0;
//     let servicesTotal = 0;

//     // Normalize product lines only if provided (Array.isArray allows clearing with [])
//     if (Array.isArray(products)) {
//       const { items: normalizedProducts, computedTotal } =
//         await normalizeProducts(products, req.auth.clientId);
//       entry.products = normalizedProducts;
//       productsTotal = computedTotal;
//     }

//     // Normalize service lines only if provided (Array.isArray allows clearing with [])
//     if (Array.isArray(services)) {
//       const { items: normalizedServices, computedTotal } =
//         await normalizeServices(services, req.auth.clientId);
//       entry.services = normalizedServices;
//       servicesTotal = computedTotal;
//     }

//     // Don't allow changing invoiceNumber/year from payload
//     const { invoiceNumber, invoiceYearYY, gstRate, notes, ...rest } = otherUpdates;
//     if (typeof gstRate === "number") {
//       entry.gstPercentage = gstRate;
//     }
//     if (notes !== undefined) {
//       entry.notes = notes;
//     }
//     if (shippingAddress !== undefined) {
//       entry.shippingAddress = shippingAddress;
//     }
//     if (bank !== undefined) {
//       entry.bank = bank;
//     }
//     Object.assign(entry, rest);

//     // Handle payment method and party changes for credit adjustment
//     if (paymentMethod !== undefined) {
//       entry.paymentMethod = normalizedPaymentMethod;
//     }

//     if (party !== undefined) {
//       entry.party = party;
//     }

//     // Recalculate total if not explicitly provided
//     if (typeof totalAmount === "number") {
//       entry.totalAmount = totalAmount;
//     } else {
//       const sumProducts =
//         productsTotal ||
//         (Array.isArray(entry.products)
//           ? entry.products.reduce((s, it) => s + (Number(it.amount) || 0), 0)
//           : 0);
//       const sumServices =
//         servicesTotal ||
//         (Array.isArray(entry.services)
//           ? entry.services.reduce((s, it) => s + (Number(it.amount) || 0), 0)
//           : 0);
//       entry.totalAmount = sumProducts + sumServices;
//     }

//     // CREDIT BALANCE ADJUSTMENT LOGIC - UPDATED FOR COMPANY-SPECIFIC BALANCES
//     await session.withTransaction(async () => {
//       const currentPartyId = party || originalPartyId;
//       const currentPaymentMethod = normalizedPaymentMethod || originalPaymentMethod;
//       const currentTotalAmount = entry.totalAmount;
//       const currentCompanyId = otherUpdates.company || originalCompanyId; // Use updated company if changed

//       // Handle credit balance adjustments using company-specific balances
//       if (originalPaymentMethod === "Credit" && currentPaymentMethod === "Credit") {
//         // Both old and new are Credit - adjust the company-specific balance by the difference
//         if (originalPartyId === currentPartyId && originalCompanyId === currentCompanyId) {
//           // Same party and same company - adjust balance by amount difference
//           const amountDifference = currentTotalAmount - originalTotalAmount;
//           await Party.findByIdAndUpdate(
//             currentPartyId,
//             { 
//               $inc: { 
//                 [`balances.${currentCompanyId}`]: amountDifference
//               } 
//             },
//             { session }
//           );
//           console.log(`✅ Updated party balance for same company: ${currentCompanyId}, difference: ${amountDifference}`);
//         } else {
//           // Different parties or different companies - complex adjustment needed

//           // Remove from original party's company balance
//           await Party.findByIdAndUpdate(
//             originalPartyId,
//             { 
//               $inc: { 
//                 [`balances.${originalCompanyId}`]: -originalTotalAmount
//               } 
//             },
//             { session }
//           );
//           console.log(`✅ Removed from original party/company: ${originalPartyId}/${originalCompanyId}, amount: -${originalTotalAmount}`);

//           // Add to current party's company balance
//           await Party.findByIdAndUpdate(
//             currentPartyId,
//             { 
//               $inc: { 
//                 [`balances.${currentCompanyId}`]: currentTotalAmount
//               } 
//             },
//             { session }
//           );
//           console.log(`✅ Added to current party/company: ${currentPartyId}/${currentCompanyId}, amount: +${currentTotalAmount}`);
//         }
//       } else if (originalPaymentMethod === "Credit" && currentPaymentMethod !== "Credit") {
//         // Changed from Credit to non-Credit - remove from original party's company balance
//         await Party.findByIdAndUpdate(
//           originalPartyId,
//           { 
//             $inc: { 
//               [`balances.${originalCompanyId}`]: -originalTotalAmount
//             } 
//           },
//           { session }
//         );
//         console.log(`✅ Removed credit balance (changed to non-credit): ${originalPartyId}/${originalCompanyId}, amount: -${originalTotalAmount}`);
//       } else if (originalPaymentMethod !== "Credit" && currentPaymentMethod === "Credit") {
//         // Changed from non-Credit to Credit - add to current party's company balance
//         await Party.findByIdAndUpdate(
//           currentPartyId,
//           { 
//             $inc: { 
//               [`balances.${currentCompanyId}`]: currentTotalAmount
//             } 
//           },
//           { session }
//         );
//         console.log(`✅ Added credit balance (changed to credit): ${currentPartyId}/${currentCompanyId}, amount: +${currentTotalAmount}`);
//       } else {
//         // Both are non-Credit, no balance adjustment needed
//         console.log(`ℹ️ No balance adjustment needed - both payment methods are non-credit`);
//       }
//     });

//     // Fetch party name for notification
//     let partyName = "Unknown Party";
//     if (partyDoc) {
//       partyName = partyDoc.name;
//     } else {
//       const fetchedParty = await Party.findById(entry.party);
//       if (fetchedParty) partyName = fetchedParty.name;
//     }

//     await notifyAdminOnSalesAction({
//       req,
//       action: "update",
//       partyName,
//       entryId: entry._id,
//       companyId: entry.company?.toString(),
//     });

//     await entry.save();

//     // Retrieve companyId and clientId from the sales entry to delete related cache
//     const companyId = entry.company.toString();
//     const clientId = entry.client.toString();

//     // Call the reusable cache deletion function
//     // await deleteSalesEntryCache(clientId, companyId);

//     res.json({ message: "Sales entry updated successfully", entry });
//   } catch (err) {
//     console.error("Error updating sales entry:", err);
//     res.status(500).json({ error: err.message });
//   } finally {
//     session.endSession();
//   }
// };


exports.updateSalesEntry = async (req, res) => {
  const session = await mongoose.startSession();
  let updatedEntry;

  try {
    // Ensure the user has permission
    await ensureAuthCaps(req);
    if (!userIsPriv(req) && !req.auth.caps?.canCreateSaleEntries) {
      return res
        .status(403)
        .json({ message: "Not allowed to update sales entries" });
    }

    // Find the sales entry by ID (outside transaction, basic auth checks)
    const existingEntry = await SalesEntry.findById(req.params.id);
    if (!existingEntry) {
      return res.status(404).json({ message: "Sales entry not found" });
    }

    // Tenant auth: allow privileged roles or same tenant only
    if (!userIsPriv(req) && !sameTenant(existingEntry.client, req.auth.clientId)) {
      return res.status(403).json({ message: "Unauthorized" });
    }

    // Snapshot original data for reversal
    const originalProducts = Array.isArray(existingEntry.products)
      ? existingEntry.products.map(p =>
        p.toObject ? p.toObject() : { ...p }
      )
      : [];

    const {
      products,
      services,
      additionalServices,
      paymentMethod,
      totalAmount,
      party,
      shippingAddress,
      bank,
      discountType,  
  discountValue,
      ...otherUpdates
    } = req.body;

    // Normalize paymentMethod
    const normalizedPaymentMethod = paymentMethod || undefined;

    // Store original values for credit adjustment
    const originalPaymentMethod = existingEntry.paymentMethod;
    const originalTotalAmount = existingEntry.totalAmount;
    const originalPartyId = existingEntry.party.toString();
    const originalCompanyId = existingEntry.company.toString();

    // If company is being changed, check permission + existence
    if (otherUpdates.company) {
      if (!companyAllowedForUser(req, otherUpdates.company)) {
        return res
          .status(403)
          .json({ message: "You are not allowed to use this company" });
      }
      const company = await Company.findOne({
        _id: otherUpdates.company,
        client: req.auth.clientId
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
        createdByClient: req.auth.clientId
      });
      if (!partyDoc) {
        return res
          .status(400)
          .json({ message: "Customer not found or unauthorized" });
      }
    }

    await session.withTransaction(async () => {
      // Reload entry under this session to ensure transactional writes
      const entry = await SalesEntry.findById(req.params.id).session(session);
      if (!entry) {
        throw new Error("Sales entry not found during transactional update");
      }

      // 1️⃣ REVERSE OLD STOCK + LEDGER (use only existing data)
      let originalCOGS = 0;
      const { hadStockImpact, originalCOGS: restoredCOGS } =
        await reverseStockForSales(entry, session);

      if (hadStockImpact && originalProducts.length > 0) {
        originalCOGS = restoredCOGS;
        await reverseDailyStockLedgerForSales(
          entry,
          originalProducts,
          originalCOGS,
          session
        );
      }

      // 2️⃣ APPLY NEW LINE ITEMS (products/services) & OTHER FIELDS
      let productsTotal = 0;
      let servicesTotal = 0;

      // Normalize product lines only if provided
      if (Array.isArray(products)) {
        const { items: normalizedProducts, computedTotal } =
          await normalizeProducts(products, req.auth.clientId);
        entry.products = normalizedProducts;
        productsTotal = computedTotal;
      }

      // Normalize service lines only if provided
    // In updateSalesEntry function, find this section:
if (Array.isArray(services)) {
  const { items: normalizedServices, computedTotal } =
    await normalizeServices(services, req.auth.clientId);
  const expandedServices = normalizedServices.map((item, i) => ({
    ...item,
    isAdditionalService: !!services[i]?.isAdditionalService,
    serviceModel: services[i]?.isAdditionalService ? "AdditionalService" : "Service",
    travelDate: services[i]?.travelDate
      ? new Date(services[i].travelDate)
      : services[i]?.serviceStartDate
      ? new Date(services[i].serviceStartDate)
      : item.travelDate,
    travelFrom: services[i]?.travelFrom ?? item.travelFrom ?? "",
    travelTo: services[i]?.travelTo ?? item.travelTo ?? "",
    vehicleType: services[i]?.vehicleType ?? item.vehicleType ?? "",
    vehicleNumber: services[i]?.vehicleNumber ?? item.vehicleNumber ?? "",
    variableUnit:
      services[i]?.variableUnit ?? item.variableUnit ?? item.unitType ?? "Km",
    fixedCharges:
      services[i]?.fixedCharges !== undefined
        ? Number(services[i].fixedCharges) || 0
        : Number(item.fixedCharges ?? services[i]?.pricePerUnit ?? 0) ||
          0,
    variableQty:
      services[i]?.variableQty !== undefined
        ? Number(services[i].variableQty) || 0
        : Number(item.variableQty ?? 0) || 0,
    variableRate:
      services[i]?.variableRate !== undefined
        ? Number(services[i].variableRate) || 0
        : Number(item.variableRate ?? 0) || 0,
    variableCharges:
      services[i]?.variableCharges !== undefined
        ? Number(services[i].variableCharges) || 0
        : item.variableCharges ?? 0,
    quantity: Number(services[i]?.quantity) || item.quantity || 1,
    unitType: services[i]?.unitType || item.unitType || "Hours",
    pricePerUnit:
      Number(services[i]?.pricePerUnit) ||
      item.pricePerUnit ||
      Number(services[i]?.fixedCharges) ||
      0,
    serviceStartDate:
      services[i]?.serviceStartDate || services[i]?.travelDate
        ? new Date(services[i]?.serviceStartDate || services[i]?.travelDate)
        : item.serviceStartDate,
    serviceDueDate: services[i]?.serviceDueDate
      ? new Date(services[i].serviceDueDate)
      : item.serviceDueDate,
  }));
  
  // Split into regular and additional services
  entry.services = expandedServices.filter((s) => !s.isAdditionalService);
  
  // 🔴 FIX: Include serviceName when mapping additional services
  entry.additionalServices = expandedServices
    .filter((s) => s.isAdditionalService)
    .map((s) => ({
      service: s.service,
      serviceName: s.serviceName, // Add this field
      amount: s.amount,
      description: s.description,
      serviceCost: s.serviceCost,
      serviceStartDate: s.serviceStartDate || s.travelDate || null,
      serviceDueDate: s.serviceDueDate || null,
    }));
  servicesTotal = computedTotal;
}

      // Don't allow changing invoiceNumber/year from payload
      const { invoiceNumber, invoiceYearYY, gstRate, notes, ...rest } =
        otherUpdates;

      if (typeof gstRate === "number") {
        entry.gstPercentage = gstRate;
      }
      if (discountType) entry.discountType = discountType;   
if (discountValue !== undefined) entry.discountValue = discountValue; 
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
        entry.paymentMethod = normalizedPaymentMethod;
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
            ? entry.products.reduce(
              (s, it) => s + (Number(it.amount) || 0),
              0
            )
            : 0);
        const sumServices =
          servicesTotal ||
          (Array.isArray(entry.services)
            ? entry.services.reduce(
              (s, it) => s + (Number(it.amount) || 0),
              0
            )
            : 0);
        entry.totalAmount = sumProducts + sumServices;
      }

      // 3️⃣ CONSUME NEW STOCK + UPDATE LEDGER FOR NEW STATE
      let newCOGS = 0;
      if (Array.isArray(entry.products) && entry.products.length > 0) {
        const { consumptionResults, totalCOGS } = await consumeStockForSales(
          entry,
          entry.products,
          session
        );

        // 🔐 Save fresh stock impact for this updated sale
        entry.stockImpact = consumptionResults;
        newCOGS = totalCOGS || 0;

        await updateDailyStockLedgerForSales(
          entry,
          entry.products,
          newCOGS,
          session
        );
      } else {
        // no products → clear any old impact
        entry.stockImpact = [];
      }


      // 4️⃣ CREDIT BALANCE ADJUSTMENT (company-specific balances) INSIDE SAME TXN
      const currentPartyId = party || originalPartyId;
      const currentPaymentMethod =
        normalizedPaymentMethod || originalPaymentMethod;
      const currentTotalAmount = entry.totalAmount;
      const currentCompanyId = otherUpdates.company || originalCompanyId;

      if (
        originalPaymentMethod === "Credit" &&
        currentPaymentMethod === "Credit"
      ) {
        // Both old and new are Credit
        if (
          originalPartyId === currentPartyId &&
          originalCompanyId === currentCompanyId
        ) {
          // Same party and same company - adjust balance by amount difference
          const amountDifference = currentTotalAmount - originalTotalAmount;
          await Party.findByIdAndUpdate(
            currentPartyId,
            {
              $inc: {
                [`balances.${currentCompanyId}`]: amountDifference
              }
            },
            { session }
          );
          console.log(
            `✅ Updated party balance for same company: ${currentCompanyId}, difference: ${amountDifference}`
          );
        } else {
          // Different parties or different companies
          await Party.findByIdAndUpdate(
            originalPartyId,
            {
              $inc: {
                [`balances.${originalCompanyId}`]: -originalTotalAmount
              }
            },
            { session }
          );
          console.log(
            `✅ Removed from original party/company: ${originalPartyId}/${originalCompanyId}, amount: -${originalTotalAmount}`
          );

          await Party.findByIdAndUpdate(
            currentPartyId,
            {
              $inc: {
                [`balances.${currentCompanyId}`]: currentTotalAmount
              }
            },
            { session }
          );
          console.log(
            `✅ Added to current party/company: ${currentPartyId}/${currentCompanyId}, amount: +${currentTotalAmount}`
          );
        }
      } else if (
        originalPaymentMethod === "Credit" &&
        currentPaymentMethod !== "Credit"
      ) {
        // Credit → non-credit
        await Party.findByIdAndUpdate(
          originalPartyId,
          {
            $inc: {
              [`balances.${originalCompanyId}`]: -originalTotalAmount
            }
          },
          { session }
        );
        console.log(
          `✅ Removed credit balance (changed to non-credit): ${originalPartyId}/${originalCompanyId}, amount: -${originalTotalAmount}`
        );
      } else if (
        originalPaymentMethod !== "Credit" &&
        currentPaymentMethod === "Credit"
      ) {
        // non-credit → Credit
        await Party.findByIdAndUpdate(
          currentPartyId,
          {
            $inc: {
              [`balances.${currentCompanyId}`]: currentTotalAmount
            }
          },
          { session }
        );
        console.log(
          `✅ Added credit balance (changed to credit): ${currentPartyId}/${currentCompanyId}, amount: +${currentTotalAmount}`
        );
      } else {
        console.log(
          `ℹ️ No balance adjustment needed - both payment methods are non-credit`
        );
      }

      await entry.save({ session });
      updatedEntry = entry;

      // Socket emit for sale update
      try {
        if (global.io) {
          console.log('📡 Emitting transaction-update (update sale)...');

          // Get customer name
          const customerDoc = await Party.findById(updatedEntry.party);
          const customerName = customerDoc?.name || 'Unknown Customer';

          const socketPayload = {
            message: 'Sale Entry Updated',
            type: 'sale',
            action: 'update',
            entryId: updatedEntry._id,
            amount: updatedEntry.totalAmount,
            customerName: customerName
          };

          global.io.to(`client-${req.auth.clientId}`).emit('transaction-update', socketPayload);
          global.io.to('all-transactions-updates').emit('transaction-update', {
            ...socketPayload,
            clientId: req.auth.clientId
          });
        }
      } catch (socketError) {
        console.error("⚠️ Socket Emit Failed (Sale Update):", socketError.message);
      }
    });

    // OUTSIDE TRANSACTION: notifications, cache, response

    // Fetch party name for notification
    let partyName = "Unknown Party";
    if (partyDoc) {
      partyName = partyDoc.name;
    } else {
      const fetchedParty = await Party.findById(updatedEntry.party);
      if (fetchedParty) partyName = fetchedParty.name;
    }

    await notifyAdminOnSalesAction({
      req,
      action: "update",
      partyName,
      entryId: updatedEntry._id,
      companyId: updatedEntry.company?.toString()
    });

    const companyId = updatedEntry.company.toString();
    const clientId = updatedEntry.client.toString();

    // await deleteSalesEntryCache(clientId, companyId);

    res.json({
      message: "Sales entry updated successfully",
      entry: updatedEntry
    });
  } catch (err) {
    console.error("Error updating sales entry:", err);
    res.status(500).json({ error: err.message });
  } finally {
    session.endSession();
  }
};



exports.deleteSalesEntry = async (req, res) => {
  const session = await mongoose.startSession();

  try {
    await ensureAuthCaps(req);
    // Find the sales entry by ID
    const entry = await SalesEntry.findById(req.params.id);

    if (!entry) {
      return res.status(404).json({ message: "Sales entry not found" });
    }

    // Only allow clients to delete their own entries
    if (req.user.role === "client" && entry.client.toString() !== req.user.id) {
      return res.status(403).json({ message: "Unauthorized" });
    }

    // Fetch the party document
    const partyDoc = await Party.findById(entry.party);
    if (!partyDoc) {
      console.error("Party not found");
      return res.status(400).json({ message: "Party not found" });
    }

    // Store values for reversal
    const companyId = entry.company.toString();
    const paymentMethod = entry.paymentMethod;
    const totalAmount = entry.totalAmount;

    // Start the transaction
    await session.withTransaction(async () => {
      // 🟢🟢🟢 ADD FIFO STOCK REVERSAL LOGIC HERE 🟢🟢🟢
      if (entry.stockImpact && entry.stockImpact.length > 0) {

        console.log("🟡 Starting FIFO stock reversal for DELETE using stockImpact...");

        // Reverse exact batch-wise consumption
        const { hadStockImpact, originalCOGS } = await reverseStockForSales(entry, session);

        if (hadStockImpact) {
          // Build original products WITH NEGAIVE QUANTITIES from stockImpact
          const originalProducts = entry.stockImpact.map(p => ({
            quantity: p.quantity, // this is original consumed qty
            pricePerUnit: p.cogs / p.quantity
          }));

          await reverseDailyStockLedgerForSales(
            entry,
            entry.products,   // <-- use the real sales line items
            originalCOGS,
            session
          );

        }

        console.log("✅ Stock & ledger reversal successful for DELETE.");
      }
            // Retrieve companyId and clientId from the sales entry to delete related cache
      const companyId = entry.company.toString();

      // 🟢🟢🟢 REVERSE CREDIT BALANCE IF PAYMENT WAS CREDIT 🟢🟢🟢
      if (paymentMethod === "Credit") {
        try {
          await Party.findByIdAndUpdate(
            entry.party,
            {
              $inc: {
                [`balances.${companyId}`]: -totalAmount
              }
            },
            { session }
          );
          console.log(`✅ Reversed credit balance for customer ${entry.party}: -${totalAmount}`);
        } catch (creditError) {
          console.error("❌ Error reversing credit balance:", creditError);
          throw creditError; // Re-throw to ensure transaction rolls back
        }
      }

      // Delete the sales entry
      await entry.deleteOne();



      // Socket emit for sale deletion
      try {
        if (global.io) {
          console.log('📡 Emitting transaction-update (delete sale)...');

          const customerDoc = await Party.findById(entry.party);
          const customerName = customerDoc?.name || 'Unknown Customer';

          const socketPayload = {
            message: 'Sale Entry Deleted',
            type: 'sale',
            action: 'delete',
            entryId: entry._id,
            customerName: customerName
          };

          global.io.to(`client-${req.auth.clientId}`).emit('transaction-update', socketPayload);
          global.io.to('all-transactions-updates').emit('transaction-update', {
            ...socketPayload,
            clientId: req.auth.clientId
          });
        }
      } catch (socketError) {
        console.error("⚠️ Socket Emit Failed (Sale Delete):", socketError.message);
      }

      // ⬆️⬆️⬆️ END OF ADDED CODE ⬆️⬆️⬆️



      await notifyAdminOnSalesAction({
        req,
        action: "delete",
        partyName: partyDoc?.name,
        entryId: entry._id,
        companyId,
      });
      // Invalidate cache next
      // await deleteSalesEntryCache(clientId, companyId);
      // Respond
      res.status(200).json({ message: "Sales entry deleted successfully" });
    });
  } catch (err) {
    console.error("Error deleting sales entry:", err);
    res.status(500).json({ error: err.message });
  } finally {
    session.endSession();
  }
};



exports.getSalesEntryById = async (req, res) => {
  try {
    await ensureAuthCaps(req);

    const entry = await SalesEntry.findById(req.params.id)
      .populate({ path: "party", select: "name" })
      .populate({ path: "products.product", select: "name unitType" })
      .populate({ path: "services.service", select: "serviceName" })
      .populate({ path: "services.service", select: "serviceName", strictPopulate: false })
      .populate({ path: "company", select: "businessName" });

    if (!entry) return res.status(404).json({ message: "Sales entry not found" });

    if (!userIsPriv(req) && !sameTenant(entry.client, req.auth.clientId)) {
      return res.status(403).json({ message: "Unauthorized" });
    }

    res.json({ entry });
  } catch (err) {
    console.error("getSalesEntryById error:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
};

exports.sendCreditReminder = async (req, res) => {
  try {
    const {
      transactionId,
      partyId,
      daysOverdue,
      pendingAmount,
      emailSubject,
      emailContent,
      isHtml = false
    } = req.body;

    // Get transaction details with populated data
    const transaction = await SalesEntry.findById(transactionId)
      .populate('party', 'name email contactNumber')
      .populate('company', 'businessName emailId owner')
      .populate('client');

    if (!transaction) {
      return res.status(404).json({ message: 'Transaction not found' });
    }

    // Get party details
    const party = await Party.findById(partyId);
    if (!party) {
      return res.status(404).json({ message: 'Party not found' });
    }

    // Check if party has email
    if (!party.email) {
      return res.status(400).json({
        message: 'Customer does not have an email address'
      });
    }

    // Use custom content if provided, otherwise generate default
    const subject = emailSubject || `Payment Reminder - Invoice ${transaction.invoiceNumber}`;
    const content = emailContent || generateDefaultEmailContent(transaction, party, daysOverdue, pendingAmount);

    // Determine the client ID for sending email
    let senderClientId = null;

    // 1. Try to get from company owner
    if (transaction.company?.owner) {
      senderClientId = transaction.company.owner;
      console.log('🔧 Using company owner as sender client:', senderClientId);
    }
    // 2. Fallback to authenticated client
    else if (req.auth?.clientId) {
      senderClientId = req.auth.clientId;
      console.log('🔧 Using authenticated client as sender:', senderClientId);
    }
    // 3. Fallback to transaction client
    else if (transaction.client) {
      senderClientId = transaction.client._id || transaction.client;
      console.log('🔧 Using transaction client as sender:', senderClientId);
    }

    if (!senderClientId) {
      return res.status(400).json({
        message: 'Unable to determine sender. Please connect Gmail integration.'
      });
    }

    // Send credit reminder email using client's Gmail
    await sendCreditReminderEmail({
      to: party.email,
      customerName: party.name,
      companyName: transaction.company.businessName,
      invoiceNumber: transaction.invoiceNumber || transaction.referenceNumber || 'N/A',
      invoiceDate: transaction.date,
      daysOverdue: daysOverdue,
      pendingAmount: pendingAmount,
      companyEmail: transaction.company.emailId,
      companyId: transaction.company?._id, // Pass company ID
      clientId: senderClientId, // Pass determined client ID
      customSubject: subject,
      customContent: content,
      isHtml: isHtml
    });

    // Create notification for the reminder
    // await createNotification(
    //   `Credit reminder sent to ${party.name} for ₹${pendingAmount} (Invoice: ${transaction.invoiceNumber})`,
    //   req.auth.userId,
    //   req.auth.userId,
    //   'reminder',
    //   'sales',
    //   transactionId,
    //   req.auth.clientId
    // );

    res.json({
      message: 'Credit reminder sent successfully',
      sentTo: party.email,
      customerName: party.name,
      amount: pendingAmount,
      sentFrom: 'Client Gmail' // Indicate it was sent from client's email
    });

    console.log(`✅ Credit reminder sent from client Gmail to ${party.email} for ${party.name}`);

  } catch (error) {
    console.error('Error in sendCreditReminder:', error);

    // Handle specific Gmail connection errors
    if (error.message.includes('Gmail is not connected') ||
      error.message.includes('No client Gmail available') ||
      error.message.includes('Gmail access was revoked')) {
      return res.status(400).json({
        message: 'Gmail not connected. Please connect your Gmail account in settings to send emails.',
        error: error.message
      });
    }

    res.status(500).json({
      message: 'Failed to send credit reminder',
      error: error.message
    });
  }
};

function generateDefaultEmailContent(transaction, party, daysOverdue, pendingAmount) {
  const invoiceNumber = transaction.invoiceNumber || transaction.referenceNumber || 'N/A';
  const invoiceDate = new Date(transaction.date).toLocaleDateString();
  const formattedAmount = new Intl.NumberFormat('en-IN').format(pendingAmount);

  const overdueNotice = daysOverdue > 30
    ? `<p style="color: #d32f2f; font-weight: bold;">This invoice is ${daysOverdue - 30} days overdue. Please process the payment immediately to avoid any disruption in services.</p>`
    : '<p>Please process this payment at your earliest convenience.</p>';

  return `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { 
      font-family: Arial, sans-serif; 
      line-height: 1.6; 
      color: #333; 
      max-width: 600px; 
      margin: 0 auto; 
      padding: 20px;
      background-color: #f9f9f9;
    }
    .container {
      background: white;
      padding: 30px;
      border-radius: 8px;
      box-shadow: 0 2px 10px rgba(0,0,0,0.1);
    }
    .header {
      border-bottom: 2px solid #4CAF50;
      padding-bottom: 15px;
      margin-bottom: 20px;
    }
    .amount {
      font-size: 24px;
      font-weight: bold;
      color: #d32f2f;
      margin: 15px 0;
    }
    .footer {
      margin-top: 30px;
      padding-top: 20px;
      border-top: 1px solid #ddd;
      color: #666;
      font-size: 14px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h2>Payment Reminder</h2>
    </div>
    
    <p>Dear <strong>${party.name}</strong>,</p>
    
    <p>This is a friendly reminder regarding your outstanding payment. The following invoice is currently pending:</p>
    
    <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
      <tr>
        <td style="padding: 8px; border-bottom: 1px solid #eee;"><strong>Invoice Number:</strong></td>
        <td style="padding: 8px; border-bottom: 1px solid #eee;">${invoiceNumber}</td>
      </tr>
      <tr>
        <td style="padding: 8px; border-bottom: 1px solid #eee;"><strong>Invoice Date:</strong></td>
        <td style="padding: 8px; border-bottom: 1px solid #eee;">${invoiceDate}</td>
      </tr>
      <tr>
        <td style="padding: 8px; border-bottom: 1px solid #eee;"><strong>Days Outstanding:</strong></td>
        <td style="padding: 8px; border-bottom: 1px solid #eee;">${daysOverdue} days</td>
      </tr>
      <tr>
        <td style="padding: 8px;"><strong>Pending Amount:</strong></td>
        <td style="padding: 8px;" class="amount">₹${formattedAmount}</td>
      </tr>
    </table>
    
    ${overdueNotice}
    
    <p>If you have already made the payment, please disregard this reminder. For any queries regarding this invoice, please contact us.</p>
    
    <p>Thank you for your business!</p>
    
    <div class="footer">
      <p><strong>Best regards,</strong><br>
      ${transaction.company.businessName}<br>
      ${transaction.company.emailId ? `Email: ${transaction.company.emailId}` : ''}</p>
    </div>
  </div>
</body>a
</html>`;
}

const mongoose = require("mongoose");
const PurchaseEntry = require("../models/PurchaseEntry");
const Company = require("../models/Company");
const Vendor = require("../models/Vendor");
const BankDetail = require("../models/BankDetail");
const User = require("../models/User");
const normalizePurchaseProducts = require("../utils/normalizePurchaseProducts");
const normalizePurchaseServices = require("../utils/normalizePurchaseServices");

const Product = require("../models/Product");
const StockBatch = require("../models/StockBatch");
const DailyStockLedger = require("../models/DailyStockLedger");

// load effective caps if middleware didn’t attach them
const { getEffectivePermissions } = require("../services/effectivePermissions");

const { createNotification } = require("./notificationController");
const { resolveActor, findAdminUser } = require("../utils/actorUtils");



// --- helpers -----------------------------------------------------

const PRIV_ROLES = new Set(["master", "client", "admin"]);

async function ensureAuthCaps(req) {
  // Support older code paths that put auth on req.user
  if (!req.auth && req.user) {
    req.auth = {
      clientId: req.user.id,
      userId: req.user.userId || req.user.id,
      role: req.user.role,
      caps: req.user.caps,
      allowedCompanies: req.user.allowedCompanies,
      userName: req.user.userName || 'Unknown',
      clientName: req.user.contactName,
    };
  }
  if (!req.auth) throw new Error("Unauthorized (no auth context)");

  if (!req.auth.caps || !Array.isArray(req.auth.allowedCompanies)) {
    const { caps, allowedCompanies } = await getEffectivePermissions({
      clientId: req.auth.clientId,
      userId: req.auth.userId,
    });
    req.auth.caps = req.auth.caps || caps;
    req.auth.allowedCompanies = req.auth.allowedCompanies || allowedCompanies;
  }

  // NEW: Ensure userName is always set
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
      undefined; // no "Unknown" here
  }
}

function userIsPriv(req) {
  return PRIV_ROLES.has(req.auth.role);
}

function sameTenant(a, b) {
  return String(a) === String(b);
}

function companyAllowedForUser(req, companyId) {
  if (!companyId) return true;
  if (userIsPriv(req)) return true;
  const allowed = Array.isArray(req.auth.allowedCompanies)
    ? req.auth.allowedCompanies.map(String)
    : [];
  return allowed.length === 0 || allowed.includes(String(companyId));
}


// ---------- Helpers: actor + admin notification (purchase) ----------

// Build message per action (purchase wording)
function buildPurchaseNotificationMessage(action, { actorName, vendorName, amount }) {
  const vName = vendorName || "Unknown Vendor";
  switch (action) {
    case "create":
      return `New purchase entry created by ${actorName} for vendor ${vName}` +
        (amount != null ? ` of ₹${amount}.` : ".");
    case "update":
      return `Purchase entry updated by ${actorName} for vendor ${vName}.`;
    case "delete":
      return `Purchase entry deleted by ${actorName} for vendor ${vName}.`;
    default:
      return `Purchase entry ${action} by ${actorName} for vendor ${vName}.`;
  }
}

// Unified notifier for purchase module
async function notifyAdminOnPurchaseAction({ req, action, vendorName, entryId, companyId, amount }) {
  const actor = await resolveActor(req);
  const adminUser = await findAdminUser(companyId);
  if (!adminUser) {
    console.warn("notifyAdminOnPurchaseAction: no admin user found");
    return;
  }

  const message = buildPurchaseNotificationMessage(action, {
    actorName: actor.name,
    vendorName,
    amount,
  });

  await createNotification(
    message,
    adminUser._id,       // recipient (admin)
    actor.id,            // actor id (user OR client)
    action,              // "create" | "update" | "delete"
    "purchase",          // category
    entryId,             // purchase entry id
    req.auth.clientId
  );
}


// 🔄 FIFO HELPER FUNCTIONS

/**
 * Update Product stocks and cost price (weighted average)
 */
async function updateProductStockAndCostPrice(productId, newQuantity, newCostPrice, session = null) {
  const product = await Product.findById(productId).session(session);
  if (!product) throw new Error(`Product not found: ${productId}`);

  // Calculate weighted average cost price
  const currentTotalValue = product.stocks * product.costPrice;
  const newTotalValue = newQuantity * newCostPrice;
  const totalQuantity = product.stocks + newQuantity;

  const weightedAverageCost = totalQuantity > 0
    ? (currentTotalValue + newTotalValue) / totalQuantity
    : newCostPrice;

  // Update product
  product.stocks = totalQuantity;
  product.costPrice = weightedAverageCost;

  await product.save({ session });
  return product;
}

/**
 * Create StockBatch entries for each product in purchase
 */
async function createStockBatches(purchaseEntry, products, session = null) {
  const batchPromises = products.map(async (item) => {
    const batch = new StockBatch({
      product: item.product,
      purchaseEntry: purchaseEntry._id,
      companyId: purchaseEntry.company,
      clientId: purchaseEntry.client,
      purchaseDate: purchaseEntry.date,
      costPrice: item.pricePerUnit,
      initialQuantity: item.quantity,
      remainingQuantity: item.quantity,
      status: "active"
    });

    return await batch.save({ session });
  });

  return await Promise.all(batchPromises);
}

// async function updateDailyStockLedgerForPurchase(purchaseEntry, products, session = null) {
//   const purchaseDate = new Date(purchaseEntry.date);
//   purchaseDate.setUTCHours(18, 30, 0, 0); // IST 00:00

//   // Find or create daily ledger
//   let ledger = await DailyStockLedger.findOne({
//     companyId: purchaseEntry.company,
//     clientId: purchaseEntry.client,
//     date: purchaseDate
//   }).session(session);

//   // ✅ Calculate new purchase values ONCE
//   const newPurchaseQuantity = products.reduce((sum, item) => sum + item.quantity, 0);
//   const newPurchaseAmount = products.reduce((sum, item) => sum + (item.quantity * item.pricePerUnit), 0);

//   console.log('🔴 DEBUG PURCHASE LEDGER UPDATE:');
//   console.log('  New Purchase:', newPurchaseQuantity, 'units, ₹', newPurchaseAmount);

//   if (!ledger) {
//     // Get previous day's closing stock
//     const previousDay = new Date(purchaseDate);
//     previousDay.setDate(previousDay.getDate() - 1);
//     previousDay.setUTCHours(18, 30, 0, 0);

//     const previousLedger = await DailyStockLedger.findOne({
//       companyId: purchaseEntry.company,
//       clientId: purchaseEntry.client,
//       date: previousDay
//     }).session(session);

//     const openingStock = previousLedger ? {
//       quantity: Math.max(0, previousLedger.closingStock.quantity),
//       amount: Math.max(0, previousLedger.closingStock.amount)
//     } : { quantity: 0, amount: 0 };

//     // ✅ Create new ledger with initial purchase values
//     ledger = new DailyStockLedger({
//       companyId: purchaseEntry.company,
//       clientId: purchaseEntry.client,
//       date: purchaseDate,
//       openingStock: openingStock,
//       closingStock: {
//         quantity: openingStock.quantity + newPurchaseQuantity,
//         amount: openingStock.amount + newPurchaseAmount
//       },
//       totalPurchaseOfTheDay: { quantity: newPurchaseQuantity, amount: newPurchaseAmount },
//       totalSalesOfTheDay: { quantity: 0, amount: 0 },
//       totalCOGS: 0
//     });

//     console.log('🟢 NEW LEDGER CREATED:');
//     console.log('  Opening Stock:', openingStock.quantity, 'units, ₹', openingStock.amount);
//     console.log('  Purchase:', newPurchaseQuantity, 'units, ₹', newPurchaseAmount);
//     console.log('  Closing Stock:', ledger.closingStock.quantity, 'units, ₹', ledger.closingStock.amount);

//   } else {
//     // ✅ LEDGER EXISTS: Update purchase values and recalculate closing
//     ledger.totalPurchaseOfTheDay.quantity += newPurchaseQuantity;
//     ledger.totalPurchaseOfTheDay.amount += newPurchaseAmount;

//     // ✅ Calculate closing stock quantity
//     const newClosingQuantity = Math.max(0, ledger.openingStock.quantity +
//       ledger.totalPurchaseOfTheDay.quantity -
//       ledger.totalSalesOfTheDay.quantity);

//     // ✅ Calculate closing stock value from ACTUAL FIFO batches
//     const newClosingAmount = await calculateClosingStockValue(
//       purchaseEntry.company,
//       purchaseEntry.client,
//       session
//     );

//     // ✅ Calculate COGS properly
//     const totalAvailableValue = ledger.openingStock.amount + ledger.totalPurchaseOfTheDay.amount;
//     const totalCOGS = Math.max(0, totalAvailableValue - newClosingAmount);

//     // ✅ Update ledger with correct values
//     ledger.closingStock.quantity = newClosingQuantity;
//     ledger.closingStock.amount = newClosingAmount;
//     ledger.totalCOGS = totalCOGS;

//     console.log('🟢 EXISTING LEDGER UPDATED:');
//     console.log('  Total Available:', ledger.openingStock.quantity + ledger.totalPurchaseOfTheDay.quantity, 
//                 'units, ₹', totalAvailableValue);
//     console.log('  Closing Stock:', newClosingQuantity, 'units, ₹', newClosingAmount);
//     console.log('  COGS: ₹', totalCOGS);
//   }

//   await ledger.save({ session });
//   return ledger;
// }

async function updateDailyStockLedgerForPurchase(purchaseEntry, products, session = null) {
  try {
    const purchaseDate = new Date(purchaseEntry.date);
    purchaseDate.setUTCHours(18, 30, 0, 0); // IST logic

    // 1. Calculate New Purchase Totals
    const newPurchaseQuantity = products.reduce((sum, item) => sum + item.quantity, 0);
    const newPurchaseAmount = products.reduce((sum, item) => sum + (item.quantity * item.pricePerUnit), 0);

    // 2. Fetch Previous Day's Ledger (For Opening Stock)
    const previousDay = new Date(purchaseDate);
    previousDay.setDate(previousDay.getDate() - 1);
    previousDay.setUTCHours(18, 30, 0, 0);

    const previousLedger = await DailyStockLedger.findOne({
      companyId: purchaseEntry.company,
      // Note: No clientId/vendorId here
      date: previousDay
    }).session(session);

    const openingStockDefaults = previousLedger ? previousLedger.closingStock : { quantity: 0, amount: 0 };

    // ------------------------------------------------------------------
    // STEP 1: ATOMIC UPDATE (Safe Upsert)
    // ------------------------------------------------------------------
    // Ye step database mein Purchase add karega aur agar ledger nahi hai to banayega.
    // Hum yahan Closing Stock calculate nahi karenge taaki conflict na ho.
    let ledger = await DailyStockLedger.findOneAndUpdate(
      {
        companyId: purchaseEntry.company, // Only Company
        date: purchaseDate                // And Date
      },
      {
        $inc: {
          "totalPurchaseOfTheDay.quantity": newPurchaseQuantity,
          "totalPurchaseOfTheDay.amount": newPurchaseAmount
          // Purchase mein COGS change nahi hota
        },
        $setOnInsert: {
          openingStock: openingStockDefaults,
          totalSalesOfTheDay: { quantity: 0, amount: 0 },
          totalCOGS: 0
          // clientId store kar sakte hain reference ke liye par search mein use na karein
        }
      },
      { 
        upsert: true, 
        new: true, 
        session: session,
        setDefaultsOnInsert: true
      }
    );

    // ------------------------------------------------------------------
    // STEP 2: RECALCULATE CLOSING STOCK (In Memory)
    // ------------------------------------------------------------------
    
    // Get latest values from the updated ledger
    const totalOpeningQty = ledger.openingStock.quantity;
    const totalOpeningAmt = ledger.openingStock.amount;
    
    const totalPurchaseQty = ledger.totalPurchaseOfTheDay.quantity;
    const totalPurchaseAmt = ledger.totalPurchaseOfTheDay.amount;
    
    const totalSalesQty = ledger.totalSalesOfTheDay.quantity;
    const totalCOGS = ledger.totalCOGS; // Use actual COGS, not Sales Amount

    // ✅ Formula: Opening + Purchase - Sales
    const finalClosingQty = (totalOpeningQty + totalPurchaseQty) - totalSalesQty;
    
    // ✅ Formula: OpeningVal + PurchaseVal - COGS (Cost of goods sold)
    // Note: Sales Amount minus nahi karte, kyunki usme profit juda hota hai.
    const finalClosingAmt = (totalOpeningAmt + totalPurchaseAmt) - totalCOGS;

    // Apply Math.max to prevent negative values
    ledger.closingStock.quantity = Math.max(0, finalClosingQty);
    ledger.closingStock.amount = Math.max(0, finalClosingAmt);

    // Final Save
    await ledger.save({ session });

    console.log('✅ Purchase Ledger Updated Successfully');
    console.log('  Opening:', totalOpeningQty, '+ Purchase:', totalPurchaseQty, '- Sales:', totalSalesQty);
    console.log('  New Closing Stock:', ledger.closingStock.quantity, 'units');

    return ledger;

  } catch (error) {
    console.error('Error updating purchase ledger:', error);
    throw error;
  }
}

/**
 * Reverse StockBatch entries and product stock for a purchase
 */
async function reversePurchaseStockUpdates(purchaseEntry, products = null, session = null) {
  const productsToReverse = products || purchaseEntry.products;

  // Find all stock batches for this purchase
  const batches = await StockBatch.find({
    purchaseEntry: purchaseEntry._id
  }).session(session);

  // Reverse product stock updates
  // const reverseUpdates = productsToReverse.map(async (item) => {
  //   const product = await Product.findById(item.product).session(session);
  //   if (product) {
  //     product.stocks = Math.max(0, product.stocks - item.quantity);
  //     // Note: We don't reverse costPrice as it's complex to calculate
  //     await product.save({ session });
  //   }
  // });
  // await Promise.all(reverseUpdates);

  // Deactivate or delete stock batches
  const batchUpdates = batches.map(batch => {
    batch.isActive = false;
    batch.status = "cancelled";
    return batch.save({ session });
  });
  await Promise.all(batchUpdates);

  return batches;
}



async function calculateClosingStockValue(companyId, clientId, session = null) {
  const activeBatches = await StockBatch.find({
    companyId: companyId,
    clientId: clientId,
    status: "active",
    remainingQuantity: { $gt: 0 }
  }).session(session);

  return activeBatches.reduce((sum, batch) =>
    sum + (batch.remainingQuantity * batch.costPrice), 0);
}
/**
 * CORRECTED: Reverse Daily Stock Ledger for purchase deletion
 */
async function reverseDailyStockLedgerForPurchase(purchaseEntry, products = null, date = null, session = null) {
  const productsToReverse = products || purchaseEntry.products;
  const purchaseDate = new Date(date || purchaseEntry.date);
  purchaseDate.setUTCHours(18, 30, 0, 0);

  const ledger = await DailyStockLedger.findOne({
    companyId: purchaseEntry.company,
    clientId: purchaseEntry.client,
    date: purchaseDate
  }).session(session);

  if (ledger) {
    // Calculate values to reverse
    const purchaseQuantity = productsToReverse.reduce((sum, item) => sum + item.quantity, 0);
    const purchaseAmount = productsToReverse.reduce((sum, item) => sum + (item.quantity * item.pricePerUnit), 0);

    // Reverse purchase values
    ledger.totalPurchaseOfTheDay.quantity = Math.max(0, ledger.totalPurchaseOfTheDay.quantity - purchaseQuantity);
    ledger.totalPurchaseOfTheDay.amount = Math.max(0, ledger.totalPurchaseOfTheDay.amount - purchaseAmount);

    // ✅ CORRECTED: Recalculate closing stock value from FIFO batches
    const newClosingAmount = await calculateClosingStockValue(
      purchaseEntry.company,
      purchaseEntry.client,
      session
    );

    // ✅ CORRECTED: Recalculate COGS
    const totalCOGS = ledger.totalSalesOfTheDay.amount; // Or calculate from actual sales transactions

    ledger.closingStock.quantity = Math.max(0, ledger.openingStock.quantity +
      ledger.totalPurchaseOfTheDay.quantity -
      ledger.totalSalesOfTheDay.quantity);
    ledger.closingStock.amount = newClosingAmount;
    ledger.totalCOGS = totalCOGS;

    await ledger.save({ session });
  }
}

/**
 * Reverse product stock updates for purchase deletion
 */
async function reverseProductStocksForDeletion(purchaseEntry, session = null) {
  const productUpdates = purchaseEntry.products.map(async (item) => {
    const product = await Product.findById(item.product).session(session);
    if (product) {
      // Reduce stock by the purchased quantity
      product.stocks = Math.max(0, product.stocks - item.quantity);
      await product.save({ session });
      console.log(`✅ Reduced stock for ${product.name}: -${item.quantity} units`);
    }
  });

  await Promise.all(productUpdates);
}
// --- CREATE ------------------------------------------------------
exports.createPurchaseEntry = async (req, res) => {
  const session = await mongoose.startSession();
  const txnOpts = {
    readPreference: "primary",
    readConcern: { level: "snapshot" },
    writeConcern: { w: "majority" },
  };

  try {
    await ensureAuthCaps(req);
    if (!userIsPriv(req) && !req.auth.caps?.canCreatePurchaseEntries) {
      return res.status(403).json({ message: "Not allowed to create purchase entries" });
    }
    const { company: companyId, bank } = req.body;  // Make sure companyId is properly initialized here
    if (!companyAllowedForUser(req, companyId)) {
      return res.status(403).json({ message: "You are not allowed to use this company" });
    }

    let entry;
    let vendorDoc, companyDoc;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        await session.withTransaction(async () => {
          const {
            vendor, company: _companyId, date, products, services,
            totalAmount, description, referenceNumber, gstPercentage, invoiceType, paymentMethod,
          } = req.body;

          // Make sure companyId is defined here
          companyDoc = await Company.findOne({ _id: companyId, client: req.auth.clientId }).session(session);
          if (!companyDoc) throw new Error("Invalid company selected");

          vendorDoc = await Vendor.findOne({ _id: vendor, createdByClient: req.auth.clientId }).session(session);
          if (!vendorDoc) throw new Error("Vendor not found or unauthorized");

          // Validate the bank field - make sure the bank belongs to the company (optional)
          let selectedBank = null;
          if (bank && mongoose.Types.ObjectId.isValid(bank)) {
            selectedBank = await BankDetail.findById(bank);
            if (!selectedBank || !selectedBank.company.equals(companyId)) {
              selectedBank = null; // Invalid bank, set to null
            }
          }

          let normalizedProducts = [], productsTotal = 0;
          if (Array.isArray(products) && products.length > 0) {
            const { items, computedTotal } = await normalizePurchaseProducts(
              products,
              req.auth.clientId,
              req.auth.userId /* pass session if normalize funcs use db */
            );
            normalizedProducts = items; productsTotal = computedTotal;
          }

          let normalizedServices = [], servicesTotal = 0;
          if (Array.isArray(services) && services.length > 0) {
            const { items, computedTotal } = await normalizePurchaseServices(
              services,
              req.auth.clientId /* pass session if normalize funcs use db */
            );
            normalizedServices = items; servicesTotal = computedTotal;
          }

          const finalTotal = (typeof totalAmount === "number")
            ? totalAmount
            : (productsTotal + servicesTotal);

          const docs = await PurchaseEntry.create([{
            vendor: vendorDoc._id,
            company: companyDoc._id,
            client: req.auth.clientId,
            createdByUser: req.auth.userId,
            date,
            products: normalizedProducts,
            services: normalizedServices,
            totalAmount: finalTotal,
            description,
            referenceNumber,
            gstPercentage,
            invoiceType,
            gstin: companyDoc.gstin || null,
            bank: bank && mongoose.Types.ObjectId.isValid(bank) ? bank : null,
            paymentMethod,
          }], { session });
          entry = docs[0];


          // FIFO IMPLEMENTATION - Only for products (not services)
          if (normalizedProducts.length > 0) {
            // Update Product stocks and cost prices
            const productUpdates = normalizedProducts.map(item =>
              updateProductStockAndCostPrice(
                item.product,
                item.quantity,
                item.pricePerUnit,
                session
              )
            );
            await Promise.all(productUpdates);

            // Create StockBatch entries
            const createdBatches = await createStockBatches(entry, normalizedProducts, session);

            // Update Daily Stock Ledger
            await updateDailyStockLedgerForPurchase(entry, normalizedProducts, session);

            console.log(`✅ Created ${createdBatches.length} stock batches for purchase`);
          }


          // Handle vendor balance for credit purchases
          if (paymentMethod === "Credit") {
            // Update company-specific balance
            if (!vendorDoc.balances) vendorDoc.balances = new Map();
            const currentBalance = vendorDoc.balances.get(companyId.toString()) || 0;
            vendorDoc.balances.set(companyId.toString(), currentBalance - finalTotal); // Negative balance means we owe the vendor
            await vendorDoc.save({ session });
          }



        }, txnOpts);

        // Access clientId and companyId after creation
        const clientId = entry.client.toString();
        const companyIdStr = companyId?.toString?.() || companyId;

        // Notify admin (outside the transaction, after success)
        const vendorName = vendorDoc?.name || vendorDoc?.vendorName || vendorDoc?.title || "Unknown Vendor";
        await notifyAdminOnPurchaseAction({
          req,
          action: "create",
          vendorName,
          entryId: entry._id,
          companyId: companyIdStr,
          amount: entry?.totalAmount,
        });

        // Invalidate cache
        // await deletePurchaseEntryCache(clientId, companyIdStr);

        return res.status(201).json({ message: "Purchase entry created successfully", entry });


      } catch (e) {
        const labels = new Set(e?.errorLabels || e?.errorLabelSet || []);
        if (labels.has("TransientTransactionError") || e?.code === 112 || e?.code === 11000) {
          // small backoff then retry
          await new Promise(r => setTimeout(r, 30 * (attempt + 1)));
          continue;
        }
        throw e;
      }
    }

    return res.status(500).json({ message: "Failed to create purchase entry after retries" });
  } catch (err) {
    console.error("createPurchaseEntry error:", err);
    return res.status(500).json({ message: "Failed to create purchase entry", error: err.message });
  } finally {
    session.endSession();
  }
};
// --- LIST / SEARCH / PAGINATE -----------------------------------
exports.getPurchaseEntries = async (req, res) => {
  try {
    await ensureAuthCaps(req);

    const {
      q,
      companyId,
      dateFrom,
      dateTo,
      page = 1,
      limit = 10000,
    } = req.query;

    const clientId = req.auth.clientId;  // Extract clientId correctly

    const where = {
      client: clientId,
      ...(companyAllowedForUser(req, companyId) ? { ...(companyId && { company: companyId }) } : { company: { $in: [] } }),
    };

    if (dateFrom || dateTo) {
      where.date = {};
      if (dateFrom) where.date.$gte = new Date(dateFrom);
      if (dateTo) where.date.$lte = new Date(dateTo);
    }

    if (q) {
      where.$or = [
        { description: { $regex: String(q), $options: "i" } },
        { referenceNumber: { $regex: String(q), $options: "i" } },
      ];
    }

    const perPage = Math.min(Number(limit) || 10000, 10000);
    const skip = (Number(page) - 1) * perPage;

    // Construct a cache key based on the query parameters
    const cacheKey = `purchaseEntries:${JSON.stringify({ clientId, companyId })}`;

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

    // If not cached, fetch the data from the database
    const query = PurchaseEntry.find(where)
      .sort({ date: -1 })
      .skip(skip)
      .limit(perPage)
      .populate({ path: "vendor", select: "vendorName" })
      .populate({ path: "products.product", select: "name unitType" })
      .populate({ path: "services.serviceName", select: "serviceName" })
      .populate({ path: "services.service", select: "serviceName", strictPopulate: false })
      .populate({ path: "company", select: "businessName" });

    const [entries, total] = await Promise.all([
      query.lean(),
      PurchaseEntry.countDocuments(where),
    ]);

    // Cache the fetched data in Redis for future requests
    // await setToCache(cacheKey, entries);

    res.status(200).json({
      success: true,
      total,
      page: Number(page),
      limit: perPage,
      data: entries,
    });
  } catch (err) {
    console.error("getPurchaseEntries error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
};


// --- ADMIN: LIST BY CLIENT --------------------------------------
exports.getPurchaseEntriesByClient = async (req, res) => {
  try {
    await ensureAuthCaps(req);

    const { clientId } = req.params;
    const { companyId, page = 1, limit = 100 } = req.query;

    // only master/admin can query arbitrary clients; client can only query self
    if (req.auth.role === "client" && String(clientId) !== String(req.auth.clientId)) {
      return res.status(403).json({ message: "Not authorized" });
    }
    if (!PRIV_ROLES.has(req.auth.role)) {
      return res.status(403).json({ message: "Not authorized" });
    }

    const where = { client: clientId };
    if (companyId) where.company = companyId;

    const perPage = Math.min(Number(limit) || 100, 500);
    const skip = (Number(page) - 1) * perPage;

    // Construct a cache key based on clientId and query parameters
    const cacheKey = `purchaseEntriesByClient:${JSON.stringify({ client: clientId, company: companyId })}`;

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

    const [entries, total] = await Promise.all([
      PurchaseEntry.find(where)
        .sort({ date: -1 })
        .skip(skip)
        .limit(perPage)
        .populate({ path: "vendor", select: "vendorName" })
        .populate({ path: "products.product", select: "name unitType" })
        .populate({ path: "services.serviceName", select: "serviceName" })
        .populate({ path: "services.service", select: "serviceName", strictPopulate: false })
        .populate({ path: "company", select: "businessName" })
        .lean(),
      PurchaseEntry.countDocuments(where),
    ]);

    // await setToCache(cacheKey, entries);

    res.status(200).json({ entries, total, page: Number(page), limit: perPage });
  } catch (err) {
    console.error("getPurchaseEntriesByClient error:", err);
    res.status(500).json({ error: err.message });
  }
};

// CORRECTED: Helper function to update daily stock ledger for purchase updates
async function updateDailyStockLedgerForPurchaseUpdate(purchaseEntry, oldProducts, oldDate, session = null) {
  const newDate = new Date(purchaseEntry.date);
  newDate.setUTCHours(18, 30, 0, 0);
  oldDate.setUTCHours(18, 30, 0, 0);

  // Calculate old values
  const oldPurchaseQuantity = oldProducts.reduce((sum, item) => sum + item.quantity, 0);
  const oldPurchaseAmount = oldProducts.reduce((sum, item) => sum + (item.quantity * item.pricePerUnit), 0);

  // Calculate new values
  const newPurchaseQuantity = purchaseEntry.products.reduce((sum, item) => sum + item.quantity, 0);
  const newPurchaseAmount = purchaseEntry.products.reduce((sum, item) => sum + (item.quantity * item.pricePerUnit), 0);

  // If date changed, update both old and new date ledgers
  if (oldDate.getTime() !== newDate.getTime()) {
    // Remove from old date
    const oldLedger = await DailyStockLedger.findOne({
      companyId: purchaseEntry.company,
      clientId: purchaseEntry.client,
      date: oldDate
    }).session(session);

    if (oldLedger) {
      oldLedger.totalPurchaseOfTheDay.quantity = Math.max(0, oldLedger.totalPurchaseOfTheDay.quantity - oldPurchaseQuantity);
      oldLedger.totalPurchaseOfTheDay.amount = Math.max(0, oldLedger.totalPurchaseOfTheDay.amount - oldPurchaseAmount);

      // ✅ CORRECTED: Calculate closing stock value from FIFO batches
      const newClosingAmount = await calculateClosingStockValue(
        purchaseEntry.company,
        purchaseEntry.client,
        session
      );
      
      // ✅ CORRECTED: Calculate COGS properly
     const totalCOGS = ledger.totalSalesOfTheDay.amount; // Or calculate from actual sales transactions

      const newClosingQuantity = Math.max(0, oldLedger.openingStock.quantity +
        oldLedger.totalPurchaseOfTheDay.quantity -
        oldLedger.totalSalesOfTheDay.quantity);

      oldLedger.closingStock.quantity = newClosingQuantity;
      oldLedger.closingStock.amount = newClosingAmount;
      oldLedger.totalCOGS = totalCOGS;
      await oldLedger.save({ session });
    }

    // Add to new date
    let newLedger = await DailyStockLedger.findOne({
      companyId: purchaseEntry.company,
      clientId: purchaseEntry.client,
      date: newDate
    }).session(session);

    if (!newLedger) {
      // Get previous day's closing stock
      const previousDay = new Date(newDate);
      previousDay.setDate(previousDay.getDate() - 1);
      previousDay.setUTCHours(18, 30, 0, 0);

      const previousLedger = await DailyStockLedger.findOne({
        companyId: purchaseEntry.company,
        clientId: purchaseEntry.client,
        date: previousDay
      }).session(session);

      newLedger = new DailyStockLedger({
        companyId: purchaseEntry.company,
        clientId: purchaseEntry.client,
        date: newDate,
        openingStock: previousLedger ? {
          quantity: Math.max(0, previousLedger.closingStock.quantity),
          amount: Math.max(0, previousLedger.closingStock.amount)
        } : { quantity: 0, amount: 0 },
        closingStock: previousLedger ? {
          quantity: Math.max(0, previousLedger.closingStock.quantity),
          amount: Math.max(0, previousLedger.closingStock.amount)
        } : { quantity: 0, amount: 0 },
        totalPurchaseOfTheDay: { quantity: 0, amount: 0 },
        totalSalesOfTheDay: { quantity: 0, amount: 0 },
        totalCOGS: 0
      });
    }

    newLedger.totalPurchaseOfTheDay.quantity += newPurchaseQuantity;
    newLedger.totalPurchaseOfTheDay.amount += newPurchaseAmount;

    // ✅ CORRECTED: Calculate closing stock value from FIFO batches
    const newClosingAmount = await calculateClosingStockValue(
      purchaseEntry.company,
      purchaseEntry.client,
      session
    );
    
    // ✅ CORRECTED: Calculate COGS properly
   const totalCOGS = ledger.totalSalesOfTheDay.amount; // Or calculate from actual sales transactions

    const newClosingQuantity = Math.max(0, newLedger.openingStock.quantity +
      newLedger.totalPurchaseOfTheDay.quantity -
      newLedger.totalSalesOfTheDay.quantity);

    newLedger.closingStock.quantity = newClosingQuantity;
    newLedger.closingStock.amount = newClosingAmount;
    newLedger.totalCOGS = totalCOGS;
    await newLedger.save({ session });
  } else {
    // Same date, just update the difference
    const ledger = await DailyStockLedger.findOne({
      companyId: purchaseEntry.company,
      clientId: purchaseEntry.client,
      date: newDate
    }).session(session);

    if (ledger) {
      const quantityDiff = newPurchaseQuantity - oldPurchaseQuantity;
      const amountDiff = newPurchaseAmount - oldPurchaseAmount;

      ledger.totalPurchaseOfTheDay.quantity += quantityDiff;
      ledger.totalPurchaseOfTheDay.amount += amountDiff;

      // ✅ CORRECTED: Calculate closing stock value from FIFO batches
      const newClosingAmount = await calculateClosingStockValue(
        purchaseEntry.company,
        purchaseEntry.client,
        session
      );
      
      // ✅ CORRECTED: Calculate COGS properly
     const totalCOGS = ledger.totalSalesOfTheDay.amount; // Or calculate from actual sales transactions

      const newClosingQuantity = Math.max(0, ledger.openingStock.quantity +
        ledger.totalPurchaseOfTheDay.quantity -
        ledger.totalSalesOfTheDay.quantity);

      ledger.closingStock.quantity = newClosingQuantity;
      ledger.closingStock.amount = newClosingAmount;
      ledger.totalCOGS = totalCOGS;
      await ledger.save({ session });
    }
  }
}

// --- UPDATE ------------------------------------------------------
exports.updatePurchaseEntry = async (req, res) => {
  try {
    await ensureAuthCaps(req);

    const entry = await PurchaseEntry.findById(req.params.id);
    if (!entry) return res.status(404).json({ message: "Purchase entry not found" });

    if (!userIsPriv(req) && !sameTenant(entry.client, req.auth.clientId)) {
      return res.status(403).json({ message: "Unauthorized" });
    }

    // Store original values BEFORE any modifications
    const originalPaymentMethod = entry.paymentMethod;
    const originalTotalAmount = entry.totalAmount;
    const originalVendorId = entry.vendor.toString();
    const oldDate = entry.date;

    const { products, services, ...otherUpdates } = req.body;

    // Store old products before updating (for FIFO calculations)
    const oldProducts = entry.products ? JSON.parse(JSON.stringify(entry.products)) : [];

    // Company change checks
    if (otherUpdates.company) {
      if (!companyAllowedForUser(req, otherUpdates.company)) {
        return res.status(403).json({ message: "You are not allowed to use this company" });
      }
      const company = await Company.findOne({ _id: otherUpdates.company, client: req.auth.clientId });
      if (!company) return res.status(400).json({ message: "Invalid company selected" });
    }

    // Vendor change check
    if (otherUpdates.vendor) {
      const vendorDoc = await Vendor.findOne({ _id: otherUpdates.vendor, createdByClient: req.auth.clientId });
      if (!vendorDoc) return res.status(400).json({ message: "Vendor not found or unauthorized" });
    }

    let productsTotal = 0;
    let servicesTotal = 0;

    if (Array.isArray(products)) {
      const { items: normalizedProducts, computedTotal } =
        await normalizePurchaseProducts(products, req.auth.clientId);
      entry.products = normalizedProducts;
      productsTotal = computedTotal;
    }

    if (Array.isArray(services)) {
      const { items: normalizedServices, computedTotal } =
        await normalizePurchaseServices(services, req.auth.clientId);
      entry.services = normalizedServices;
      servicesTotal = computedTotal;
    }

    // ⛔ invoice fields no longer special; just apply updates normally
    Object.assign(entry, otherUpdates);

    // compute total if not explicitly provided
    if (typeof otherUpdates.totalAmount === "number") {
      entry.totalAmount = otherUpdates.totalAmount;
    } else {
      const sumProducts =
        productsTotal ||
        (Array.isArray(entry.products) ? entry.products.reduce((s, it) => s + (Number(it.amount) || 0), 0) : 0);
      const sumServices =
        servicesTotal ||
        (Array.isArray(entry.services) ? entry.services.reduce((s, it) => s + (Number(it.amount) || 0), 0) : 0);
      entry.totalAmount = sumProducts + sumServices;
    }

    // Handle vendor balance adjustments for payment method changes
    const newPaymentMethod = otherUpdates.paymentMethod || originalPaymentMethod;
    const newTotalAmount = entry.totalAmount; // after update

    if (originalPaymentMethod === "Credit" && newPaymentMethod === "Credit") {
      // Both credit - adjust by difference (negative means we owe more)
      const amountDifference = newTotalAmount - originalTotalAmount;
      const vendorDoc = await Vendor.findById(entry.vendor);
      if (vendorDoc) {
        // Update company-specific balance
        if (!vendorDoc.balances) vendorDoc.balances = new Map();
        const companyIdStr = entry.company.toString();
        const currentBalance = vendorDoc.balances.get(companyIdStr) || 0;
        vendorDoc.balances.set(companyIdStr, currentBalance - amountDifference);
        await vendorDoc.save();
      }
    } else if (originalPaymentMethod === "Credit" && newPaymentMethod !== "Credit") {
      // Changed from credit to non-credit - add back to balance (owe less)
      const vendorDoc = await Vendor.findById(entry.vendor);
      if (vendorDoc) {
        // Update company-specific balance
        if (!vendorDoc.balances) vendorDoc.balances = new Map();
        const companyIdStr = entry.company.toString();
        const currentBalance = vendorDoc.balances.get(companyIdStr) || 0;
        vendorDoc.balances.set(companyIdStr, currentBalance + originalTotalAmount);
        await vendorDoc.save();
      }
    } else if (originalPaymentMethod !== "Credit" && newPaymentMethod === "Credit") {
      // Changed from non-credit to credit - subtract from balance (owe more)
      const vendorDoc = await Vendor.findById(entry.vendor);
      if (vendorDoc) {
        // Update company-specific balance
        if (!vendorDoc.balances) vendorDoc.balances = new Map();
        const companyIdStr = entry.company.toString();
        const currentBalance = vendorDoc.balances.get(companyIdStr) || 0;
        vendorDoc.balances.set(companyIdStr, currentBalance - newTotalAmount);
        await vendorDoc.save();
      }
    }
    // If both non-credit, no change needed

    // FIFO IMPLEMENTATION FOR UPDATE - Only if products changed
    if (Array.isArray(products) && entry.products.length > 0) {
      try {
        // Find and update existing stock batches instead of creating new ones
        const existingBatches = await StockBatch.find({
          purchaseEntry: entry._id
        });

        // Update existing batches with new values
        const batchUpdates = existingBatches.map(async (batch, index) => {
          if (entry.products[index]) {
            const newProduct = entry.products[index];

            // Calculate quantity difference for ledger adjustment
            const quantityDiff = newProduct.quantity - batch.initialQuantity;
            const amountDiff = (newProduct.quantity * newProduct.pricePerUnit) -
              (batch.initialQuantity * batch.costPrice);

            // Update the batch
            batch.initialQuantity = newProduct.quantity;
            batch.remainingQuantity = Math.max(0, batch.remainingQuantity + quantityDiff);
            batch.costPrice = newProduct.pricePerUnit;
            batch.purchaseDate = entry.date;

            await batch.save();

            return { quantityDiff, amountDiff };
          }
          return { quantityDiff: 0, amountDiff: 0 };
        });

        await Promise.all(batchUpdates);

        // Update Product stocks for the changes
        const productUpdates = entry.products.map(async (newItem, index) => {
          const oldItem = oldProducts[index];
          if (oldItem && newItem.product.toString() === oldItem.product.toString()) {
            const quantityDiff = newItem.quantity - oldItem.quantity;
            if (quantityDiff !== 0) {
              await updateProductStockAndCostPrice(
                newItem.product,
                quantityDiff,
                newItem.pricePerUnit
              );
            }
          } else if (newItem) {
            // New product added
            await updateProductStockAndCostPrice(
              newItem.product,
              newItem.quantity,
              newItem.pricePerUnit
            );
          }
        });
        await Promise.all(productUpdates);

        // Update Daily Stock Ledger for the changes
        await updateDailyStockLedgerForPurchaseUpdate(entry, oldProducts, oldDate);

        console.log(`✅ Updated ${existingBatches.length} existing stock batches for purchase`);

      } catch (error) {
        console.error("Error in FIFO update:", error);
        // Don't fail the entire update, but log the error
      }
    }

    // Save the updated purchase entry
    await entry.save();

    // Notify after save
    const companyId = entry.company.toString();
    const clientId = entry.client.toString();

    const vendorDoc = await Vendor.findById(entry.vendor).select("vendorName name title").lean();
    const vendorName = vendorDoc?.name || vendorDoc?.vendorName || vendorDoc?.title || "Unknown Vendor";

    await notifyAdminOnPurchaseAction({
      req,
      action: "update",
      vendorName,
      entryId: entry._id,
      companyId,
    });

    // clear cache
    // await deletePurchaseEntryCache(clientId, companyId);
    return res.json({ message: "Purchase entry updated successfully", entry });

  } catch (err) {
    console.error("updatePurchaseEntry error:", err);
    res.status(500).json({ error: err.message });
  }
};


// --- GET BY ID ---------------------------------------------------
exports.getPurchaseEntryById = async (req, res) => {
  try {
    await ensureAuthCaps(req);

    const entry = await PurchaseEntry.findById(req.params.id)
      .populate({ path: "vendor", select: "vendorName" })
      .populate({ path: "products.product", select: "name unitType" })
      .populate({ path: "services.serviceName", select: "serviceName" })
      .populate({ path: "services.service", select: "serviceName", strictPopulate: false })
      .populate({ path: "company", select: "businessName" });

    if (!entry) return res.status(404).json({ message: "Purchase entry not found" });

    if (!userIsPriv(req) && !sameTenant(entry.client, req.auth.clientId)) {
      return res.status(403).json({ message: "Not authorized" });
    }

    res.json({ entry });
  } catch (err) {
    console.error("getPurchaseEntryById error:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
};

// --- DELETE ------------------------------------------------------
exports.deletePurchaseEntry = async (req, res) => {
  try {
    await ensureAuthCaps(req);

    const entry = await PurchaseEntry.findById(req.params.id);
    if (!entry) return res.status(404).json({ message: "Purchase not found" });

    if (!userIsPriv(req) && !sameTenant(entry.client, req.auth.clientId)) {
      return res.status(403).json({ message: "Not authorized" });
    }

    // NEW: Get vendor info before deletion for notification
    const vendorDoc = await Vendor.findById(entry.vendor);

    // DEBUG: Look up the user document to get the actual userName
    const userDoc = await User.findById(req.auth.userId);
    console.log("User document found for delete:", userDoc);

    // FIX: Use multiple fallback options for userName
    const userName = userDoc?.userName || userDoc?.name ||
      userDoc?.username || req.auth.userName ||
      req.auth.name || 'Unknown User';

    // FIX: Use multiple fallback options for vendorName
    const vendorName = vendorDoc?.name || vendorDoc?.vendorName ||
      vendorDoc?.title || 'Unknown Vendor';

    console.log("Final values - UserName:", userName, "VendorName:", vendorName);

    // Handle vendor balance reversal for credit purchases
    if (entry.paymentMethod === "Credit") {
      if (vendorDoc) {
        // Update company-specific balance
        if (!vendorDoc.balances) vendorDoc.balances = new Map();
        const companyIdStr = entry.company.toString();
        const currentBalance = vendorDoc.balances.get(companyIdStr) || 0;
        vendorDoc.balances.set(companyIdStr, currentBalance + entry.totalAmount);
        await vendorDoc.save();
      }
    }


    // FIFO IMPLEMENTATION FOR DELETE - Reverse stock updates
    if (entry.products && entry.products.length > 0) {
      try {
        await reverseProductStocksForDeletion(entry);
        // Reverse stock batches and product updates
        const reversedBatches = await reversePurchaseStockUpdates(entry);
        await reverseDailyStockLedgerForPurchase(entry);

        console.log(`✅ Reversed ${reversedBatches.length} stock batches for deleted purchase`);
      } catch (error) {
        console.error("Error in FIFO delete:", error);
        // Don't fail the entire delete, but log the error
      }
    }

    await entry.deleteOne();

    const clientId = entry.client.toString();
    const companyId = entry.company.toString();


    await notifyAdminOnPurchaseAction({
      req,
      action: "delete",
      vendorName,
      entryId: entry._id,
      companyId,
    });

    // Invalidate cache
    // await deletePurchaseEntryCache(clientId, companyId);

    return res.json({ message: "Purchase deleted" });

  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
};
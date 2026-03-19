// controllers/profitLossController.js
const mongoose = require("mongoose");
const SalesEntry = require("../models/SalesEntry");
const ReceiptEntry = require("../models/ReceiptEntry");
const PaymentEntry = require("../models/PaymentEntry");
const DailyStockLedger = require("../models/DailyStockLedger");
const { getEffectivePermissions } = require("../services/effectivePermissions");

const PRIV_ROLES = new Set(["master", "client", "admin"]);

async function ensureAuthCaps(req) {
  if (!req.auth && req.user) {
    req.auth = {
      clientId: req.user.id,
      userId: req.user.userId || req.user.id,
      role: req.user.role,
      caps: req.user.caps,
      allowedCompanies: req.user.allowedCompanies,
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

  console.log('req.auth:', req.auth);
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

// // ✅ UPDATED: Get sales breakdown - Credit goes to credit side, rest to cash side
// async function getSalesBreakdownByPaymentMethod(clientId, companyId, startDate, endDate) {
//   try {
//     // Build base filter
//     const baseFilter = {
//       date: { $gte: new Date(startDate), $lte: new Date(endDate) },
//       client: new mongoose.Types.ObjectId(clientId)
//     };

//     // Add company filter if specified
//     if (companyId) {
//       baseFilter.company = new mongoose.Types.ObjectId(companyId);
//     }

//     console.log('🔍 Getting sales breakdown with filter:', baseFilter);

//     // Aggregate sales by payment method
//     const salesBreakdown = await SalesEntry.aggregate([
//       { $match: baseFilter },
//       {
//         $group: {
//           _id: "$paymentMethod",
//           totalAmount: { $sum: "$totalAmount" },
//           count: { $sum: 1 }
//         }
//       }
//     ]);

//     console.log('📊 Raw sales breakdown:', salesBreakdown);

//     // Initialize breakdown structure - SIMPLIFIED: only cash and credit
//     const breakdown = {
//       cash: 0,      // All non-credit payments (Cash, UPI, Bank Transfer, Cheque, Others)
//       credit: 0,    // Only Credit payments
//       total: 0,
//       count: 0
//     };

//     // Process each payment method
//     salesBreakdown.forEach(item => {
//       const method = (item._id || 'other').toLowerCase();
//       const amount = item.totalAmount || 0;
//       const count = item.count || 0;

//       if (method === 'credit') {
//         // Only Credit goes to credit side
//         breakdown.credit += amount;
//       } else {
//         // Everything else (Cash, UPI, Bank Transfer, Cheque, Others) goes to cash side
//         breakdown.cash += amount;
//       }

//       breakdown.total += amount;
//       breakdown.count += count;
//     });

//     console.log('✅ Final sales breakdown (Cash vs Credit):', breakdown);
//     return breakdown;

//   } catch (error) {
//     console.error("Error getting sales breakdown:", error);
//     // Return default structure in case of error
//     return {
//       cash: 0,
//       credit: 0,
//       total: 0,
//       count: 0
//     };
//   }
// }

// ✅ FIXED: Get sales breakdown separating products vs services WITH POPULATION
async function getSalesBreakdownByPaymentMethod(clientId, companyId, startDate, endDate) {
  try {
    const baseFilter = {
      date: { $gte: new Date(startDate), $lte: new Date(endDate) },
      client: new mongoose.Types.ObjectId(clientId)
    };

    if (companyId) {
      baseFilter.company = new mongoose.Types.ObjectId(companyId);
    }

    console.log('🔍 Getting sales breakdown with filter:', baseFilter);

    const salesEntries = await SalesEntry.find(baseFilter)
      .populate('products.product')
      .populate('services.service')
      .select('totalAmount paymentMethod products services date invoiceNumber')
      .lean();

    console.log(`📊 Found ${salesEntries.length} sales entries`);
    
    const breakdown = {
      // TRADING ACCOUNT (Products only)
      trading: {
        cash: 0,
        credit: 0,
        total: 0,
        count: 0
      },
      // P&L ACCOUNT (Services only)  
      services: {
        cash: 0,
        credit: 0,
        total: 0,
        count: 0
      },
      // OVERALL TOTAL
      overall: {
        cash: 0,
        credit: 0,
        total: 0,
        count: 0
      }
    };

    // Process each sales entry
    salesEntries.forEach(entry => {
      const method = (entry.paymentMethod || 'other').toLowerCase();
      const amount = entry.totalAmount || 0;

      // Check if this sale has products vs services
      const hasProducts = entry.products && entry.products.length > 0;
      const hasServices = entry.services && entry.services.length > 0;

      console.log(`📄 Invoice ${entry.invoiceNumber}: Products: ${hasProducts}, Services: ${hasServices}`);

      if (hasProducts && !hasServices) {
        // PURE PRODUCT SALE → Trading Account
        if (method === 'credit') {
          breakdown.trading.credit += amount;
        } else {
          breakdown.trading.cash += amount;
        }
        breakdown.trading.total += amount;
        breakdown.trading.count += 1;
        console.log(`  → Pure Product Sale: ₹${amount} (${method})`);
      } else if (hasServices && !hasProducts) {
        // PURE SERVICE SALE → P&L Account
        if (method === 'credit') {
          breakdown.services.credit += amount;
        } else {
          breakdown.services.cash += amount;
        }
        breakdown.services.total += amount;
        breakdown.services.count += 1;
        console.log(`  → Pure Service Sale: ₹${amount} (${method})`);
      } else if (hasProducts && hasServices) {
        // MIXED SALE → Split based on ACTUAL amounts
        const productAmount = entry.products.reduce((sum, p) => sum + (p.lineTotal || p.amount || 0), 0);
        const serviceAmount = entry.services.reduce((sum, s) => sum + (s.lineTotal || s.amount || 0), 0);

        console.log(`  → Mixed Sale: Products ₹${productAmount}, Services ₹${serviceAmount}, Total: ₹${amount}`);

        if (method === 'credit') {
          breakdown.trading.credit += productAmount;
          breakdown.services.credit += serviceAmount;
        } else {
          breakdown.trading.cash += productAmount;
          breakdown.services.cash += serviceAmount;
        }
        breakdown.trading.total += productAmount;
        breakdown.services.total += serviceAmount;
        breakdown.trading.count += 1;
        breakdown.services.count += 1;
      }

      // Overall totals
      if (method === 'credit') {
        breakdown.overall.credit += amount;
      } else {
        breakdown.overall.cash += amount;
      }
      breakdown.overall.total += amount;
      breakdown.overall.count += 1;
    });

    console.log('✅ Sales breakdown:', breakdown);
    return breakdown;

  } catch (error) {
    console.error("Error getting sales breakdown:", error);
    return {
      trading: { cash: 0, credit: 0, total: 0, count: 0 },
      services: { cash: 0, credit: 0, total: 0, count: 0 },
      overall: { cash: 0, credit: 0, total: 0, count: 0 }
    };
  }
}

// ✅ UPDATED: Get opening stock from Daily Stock Ledger - USE IST DATES
async function getOpeningStock(clientId, companyId, startDate) {
  try {
    // Convert to IST standardized date (18:30 UTC)
    const standardizedDate = new Date(startDate);
    standardizedDate.setUTCHours(18, 30, 0, 0);

    console.log('🔍 Looking for opening stock on IST date:', standardizedDate.toISOString());

    // First try to find document for the exact date
    const openingStockLedger = await DailyStockLedger.findOne({
      clientId: new mongoose.Types.ObjectId(clientId),
      companyId: companyId ? new mongoose.Types.ObjectId(companyId) : { $exists: true },
      date: standardizedDate
    });

    if (openingStockLedger && openingStockLedger.openingStock) {
      console.log('✅ Found opening stock for IST date:', openingStockLedger.openingStock.amount);
      return openingStockLedger.openingStock.amount || 0;
    }

    // If no document found for exact date, find the most recent document before the requested date
    console.log('❌ No opening stock found for exact IST date, looking for previous document');
    const previousStockLedger = await DailyStockLedger.findOne({
      clientId: new mongoose.Types.ObjectId(clientId),
      companyId: companyId ? new mongoose.Types.ObjectId(companyId) : { $exists: true },
      date: { $lt: standardizedDate }
    }).sort({ date: -1 }); // Sort by date descending to get the most recent

    if (previousStockLedger && previousStockLedger.closingStock) {
      console.log('✅ Found previous document, using its closing stock as opening stock:', previousStockLedger.closingStock.amount);
      return previousStockLedger.closingStock.amount || 0;
    }

    console.log('❌ No previous document found, using 0');
    return 0;

  } catch (error) {
    console.error("Error getting opening stock from ledger:", error);
    return 0;
  }
}



async function getClosingStock(clientId, companyId, endDate) {
  try {
    // Convert to IST standardized date (18:30 UTC)
    const standardizedDate = new Date(endDate);
    standardizedDate.setUTCHours(18, 30, 0, 0);

    console.log('🔍 Looking for closing stock on IST date:', standardizedDate.toISOString());

    // First try to find document for the exact date
    const closingStockLedger = await DailyStockLedger.findOne({
      clientId: new mongoose.Types.ObjectId(clientId),
      companyId: companyId ? new mongoose.Types.ObjectId(companyId) : { $exists: true },
      date: standardizedDate
    });

    if (closingStockLedger && closingStockLedger.closingStock) {
      console.log('✅ Found closing stock for IST date:', closingStockLedger.closingStock.amount);
      return closingStockLedger.closingStock.amount || 0;
    }

    // If no document found for exact date, find the most recent document before the requested date
    console.log('❌ No closing stock found for exact IST date, looking for previous document');
    const previousStockLedger = await DailyStockLedger.findOne({
      clientId: new mongoose.Types.ObjectId(clientId),
      companyId: companyId ? new mongoose.Types.ObjectId(companyId) : { $exists: true },
      date: { $lt: standardizedDate }
    }).sort({ date: -1 }); // Sort by date descending to get the most recent

    if (previousStockLedger && previousStockLedger.closingStock) {
      console.log('✅ Found previous document, using its closing stock:', previousStockLedger.closingStock.amount);
      return previousStockLedger.closingStock.amount || 0;
    }

    console.log('❌ No previous document found, using 0');
    return 0;

  } catch (error) {
    console.error("Error getting closing stock from ledger:", error);
    return 0;
  }
}

async function getPurchasesFromLedger(clientId, companyId, startDate, endDate) {
  try {
    // Convert dates to IST format
    const startDateIST = new Date(startDate);
    startDateIST.setUTCHours(18, 30, 0, 0);

    const endDateIST = new Date(endDate);
    endDateIST.setUTCHours(18, 30, 0, 0);

    const ledgers = await DailyStockLedger.find({
      clientId: new mongoose.Types.ObjectId(clientId),
      companyId: companyId ? new mongoose.Types.ObjectId(companyId) : { $exists: true },
      date: { $gte: startDateIST, $lte: endDateIST }
    });

    const totalPurchases = ledgers.reduce((total, ledger) => {
      return total + (ledger.totalPurchaseOfTheDay?.amount || 0);
    }, 0);

    console.log('📦 Total purchases from ledger:', totalPurchases);
    return totalPurchases;

  } catch (error) {
    console.error("Error getting purchases from ledger:", error);
    return 0;
  }
}

// ✅ NEW: Get total sales from Daily Stock Ledger for the period
async function getSalesFromLedger(clientId, companyId, startDate, endDate) {
  try {
    // Convert dates to IST format
    const startDateIST = new Date(startDate);
    startDateIST.setUTCHours(18, 30, 0, 0);

    const endDateIST = new Date(endDate);
    endDateIST.setUTCHours(18, 30, 0, 0);

    const ledgers = await DailyStockLedger.find({
      clientId: new mongoose.Types.ObjectId(clientId),
      companyId: companyId ? new mongoose.Types.ObjectId(companyId) : { $exists: true },
      date: { $gte: startDateIST, $lte: endDateIST }
    });

    const totalSales = ledgers.reduce((total, ledger) => {
      return total + (ledger.totalSalesOfTheDay?.amount || 0);
    }, 0);

    console.log('💰 Total sales from ledger:', totalSales);
    return totalSales;

  } catch (error) {
    console.error("Error getting sales from ledger:", error);
    return 0;
  }
}

// ✅ UPDATED: Main function now accepts clientId from query for admin access
exports.getProfitLossStatement = async (req, res) => {
  try {
    await ensureAuthCaps(req);

    // ✅ KEY CHANGE: Allow admin to pass clientId in query
    const { companyId, fromDate, toDate, clientId: queryClientId } = req.query;

    // ✅ Determine which clientId to use
    // If admin passes clientId, use that; otherwise use authenticated user's clientId
    const effectiveClientId = userIsPriv(req) && queryClientId 
      ? queryClientId 
      : req.auth.clientId;

    // Validate date range
    if (!fromDate || !toDate) {
      return res.status(400).json({
        success: false,
        message: "fromDate and toDate are required"
      });
    }

    const startDate = new Date(fromDate);
    const endDate = new Date(toDate);

    if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
      return res.status(400).json({
        success: false,
        message: "Invalid date format"
      });
    }

    // Set end date to end of day
    endDate.setHours(23, 59, 59, 999);
    // ✅ UPDATED: Use effectiveClientId for all queries
    const [openingStock, closingStock, ledgerPurchases, ledgerSales, salesBreakdown] = await Promise.all([
      getOpeningStock(effectiveClientId, companyId, startDate),
      getClosingStock(effectiveClientId, companyId, endDate),
      getPurchasesFromLedger(effectiveClientId, companyId, startDate, endDate),
      getSalesFromLedger(effectiveClientId, companyId, startDate, endDate),
      getSalesBreakdownByPaymentMethod(effectiveClientId, companyId, startDate, endDate)
    ]);

    console.log('📊 Stock Values from Ledger:', {
      openingStock,
      closingStock,
      ledgerPurchases,
      ledgerSales
    });

    // Build base filter for other transactions - use effectiveClientId
    const baseFilter = {
      date: { $gte: startDate, $lte: endDate },
      client: new mongoose.Types.ObjectId(effectiveClientId)
    };

    if (companyId) {
      baseFilter.company = new mongoose.Types.ObjectId(companyId);
    }

    const [
      receiptResult,
      paymentResult
    ] = await Promise.all([
      ReceiptEntry.aggregate([
        { $match: baseFilter },
        { $group: { _id: null, total: { $sum: "$amount" }, count: { $sum: 1 } } }
      ]),

      PaymentEntry.aggregate([
        { $match: baseFilter },
        {
          $lookup: {
            from: 'paymentexpenses',
            localField: 'expense',
            foreignField: '_id',
            as: 'expenseDetails'
          }
        },
        {
          $unwind: {
            path: '$expenseDetails',
            preserveNullAndEmptyArrays: true
          }
        },
        {
          $group: {
            _id: {
              isExpense: "$isExpense",
              expenseName: { $ifNull: ["$expenseDetails.name", "Vendor Payment"] }
            },
            total: { $sum: "$amount" },
            count: { $sum: 1 }
          }
        }
      ])
    ]);

    console.log('💰 Other Financial Data:', { receiptResult, paymentResult });

    const totalReceipts = receiptResult[0]?.total || 0;

    // 1. Current Values nikalo
    const rawCredit = salesBreakdown.trading.credit || 0;
    const rawCash = salesBreakdown.trading.cash || 0;

    // 2. Adjustment calculate karo
    const adjustmentAmount = Math.min(rawCredit, totalReceipts);

    // 3. Values update kar do (Memory mein, Database mein nahi)
    salesBreakdown.trading.credit = rawCredit - adjustmentAmount;
    salesBreakdown.trading.cash = rawCash + adjustmentAmount;

    console.log(`✅ Logic Applied: Moved ${adjustmentAmount} from Credit to Cash based on Receipts`);

    const vendorPaymentsTotal = paymentResult
      .filter(p => p._id.isExpense === false)
      .reduce((sum, p) => sum + (p.total || 0), 0);

    const expensePaymentsBreakdown = paymentResult
      .filter(p => p._id.isExpense === true)
      .map(p => ({
        amount: p.total || 0,
        label: p._id.expenseName,
        count: p.count || 0
      }));

    const totalExpensePayments = expensePaymentsBreakdown.reduce((sum, exp) => sum + exp.amount, 0);

    const costOfGoodsSold = openingStock + ledgerPurchases - closingStock;
    const grossProfit = ledgerSales - costOfGoodsSold;

    const totalIncome = ledgerSales + totalReceipts;
    const totalExpenses = costOfGoodsSold + vendorPaymentsTotal + totalExpensePayments;
    const netProfit = totalIncome - totalExpenses;

    const profitMargin = ledgerSales > 0 ? (grossProfit / ledgerSales) * 100 : 0;
    const netMargin = totalIncome > 0 ? (netProfit / totalIncome) * 100 : 0;
    const expenseRatio = totalIncome > 0 ? (totalExpenses / totalIncome) * 100 : 0;

    const profitLossData = {
      success: true,
      period: {
        from: startDate.toISOString().split('T')[0],
        to: endDate.toISOString().split('T')[0],
        company: companyId || 'All Companies'
      },

      trading: {
        openingStock: openingStock,
        purchases: ledgerPurchases,
        closingStock: closingStock,
        costOfGoodsSold: costOfGoodsSold,
        grossProfit: grossProfit,
        grossLoss: grossProfit < 0 ? Math.abs(grossProfit) : 0,
        sales: {
          total: salesBreakdown.trading.total,
          breakdown: salesBreakdown.trading
        }
      },
      // Two-side P&L structure
      income: {
        total: totalIncome,
        breakdown: {
          productSales: {
            amount: salesBreakdown.trading.total,
            label: "Product Sales",
            count: salesBreakdown.trading.count,
            paymentMethods: salesBreakdown.trading
          },
          serviceIncome: {
            amount: salesBreakdown.services.total,
            label: "Service Income",
            count: salesBreakdown.services.count,
            paymentMethods: salesBreakdown.services
          },
          receipts: {
            amount: totalReceipts,
            label: "Receipts",
            count: receiptResult[0]?.count || 0
          }
        }
      },

      expenses: {
        total: totalExpenses,
        breakdown: {
          costOfGoodsSold: {
            amount: costOfGoodsSold,
            label: "Cost of Goods Sold",
            components: {
              openingStock: openingStock,
              purchases: ledgerPurchases,
              closingStock: closingStock
            }
          },
          vendorPayments: {
            amount: vendorPaymentsTotal,
            label: "Vendor Payments",
            count: paymentResult.filter(p => p._id.isExpense === false).reduce((sum, p) => sum + (p.count || 0), 0)
          },
          expenseBreakdown: expensePaymentsBreakdown
        }
      },

      summary: {
        grossProfit,
        netProfit,
        totalIncome,
        totalExpenses,
        profitMargin: Math.round(profitMargin * 100) / 100,
        netMargin: Math.round(netMargin * 100) / 100,
        expenseRatio: Math.round(expenseRatio * 100) / 100,
        isProfitable: netProfit > 0
      },

      dataSource: {
        stockData: "daily_stock_ledger",
        financialData: "transaction_entries",
        lastUpdated: new Date().toISOString()
      }
    };

    console.log('✅ Final P&L Data:', {
      grossProfit,
      netProfit,
      totalIncome,
      totalExpenses
    });

    res.status(200).json(profitLossData);

  } catch (err) {
    console.error("getProfitLossStatement error:", err);
    res.status(500).json({
      success: false,
      message: "Failed to generate profit & loss statement",
      error: err.message
    });
  }
};

exports.getProfitLossSummary = async (req, res) => {
  try {
    await ensureAuthCaps(req);

    const { companyId, fromDate, toDate, clientId: queryClientId } = req.query;

    // ✅ Same logic for summary
    const effectiveClientId = userIsPriv(req) && queryClientId 
      ? queryClientId 
      : req.auth.clientId;

    const startDate = fromDate ? new Date(fromDate) : new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const endDate = toDate ? new Date(toDate) : new Date();
    endDate.setHours(23, 59, 59, 999);

    console.log('📊 P&L Summary Period:', { startDate, endDate, companyId, effectiveClientId });

    const [openingStock, closingStock, ledgerPurchases, ledgerSales] = await Promise.all([
      getOpeningStock(effectiveClientId, companyId, startDate),
      getClosingStock(effectiveClientId, companyId, endDate),
      getPurchasesFromLedger(effectiveClientId, companyId, startDate, endDate),
      getSalesFromLedger(effectiveClientId, companyId, startDate, endDate)
    ]);

    const baseFilter = {
      date: { $gte: startDate, $lte: endDate },
      client: effectiveClientId
    };

    if (companyId) {
      baseFilter.company = companyId;
    }

    const [
      receiptResult,
      paymentResult
    ] = await Promise.all([
      ReceiptEntry.aggregate([
        { $match: baseFilter },
        { $group: { _id: null, total: { $sum: "$amount" } } }
      ]),
      PaymentEntry.aggregate([
        { $match: baseFilter },
        { $group: { _id: null, total: { $sum: "$amount" } } }
      ])
    ]);

    const totalReceipts = receiptResult[0]?.total || 0;
    const totalPayments = paymentResult[0]?.total || 0;

    const costOfGoodsSold = openingStock + ledgerPurchases - closingStock;
    const totalIncome = ledgerSales + totalReceipts;
    const totalExpenses = costOfGoodsSold + totalPayments;
    const netProfit = totalIncome - totalExpenses;

    res.status(200).json({
      success: true,
      data: {
        totalIncome,
        totalExpenses,
        netProfit,
        grossProfit: ledgerSales - costOfGoodsSold,
        period: {
          from: startDate.toISOString().split('T')[0],
          to: endDate.toISOString().split('T')[0]
        },
        isProfitable: netProfit > 0,
        dataSource: "daily_stock_ledger"
      }
    });

  } catch (err) {
    console.error("getProfitLossSummary error:", err);
    res.status(500).json({
      success: false,
      message: "Failed to generate profit & loss summary",
      error: err.message
    });
  }
};
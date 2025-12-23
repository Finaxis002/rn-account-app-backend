// controllers/ledgerController.js
const PurchaseEntry = require("../models/PurchaseEntry");
const PaymentEntry = require("../models/PaymentEntry");
const Vendor = require("../models/Vendor");
const PaymentExpense = require("../models/PaymentExpense");

const PRIV_ROLES = new Set(["master", "client", "admin"]);

function userIsPriv(req) {
  return PRIV_ROLES.has(req.auth?.role);
}

function sameTenant(a, b) {
  return String(a) === String(b);
}

// Get payables ledger data
exports.getPayablesLedger = async (req, res) => {
  try {
    const clientId = req.auth.clientId;
    const { companyId } = req.query;

    // Build company filter
    const companyFilter = companyId ? { company: companyId } : {};

    // Get all purchase entries (debit side - what we owe)
    const purchaseEntries = await PurchaseEntry.find({
      client: clientId,
      paymentMethod: "Credit", // Only credit purchases create payables
      ...companyFilter
    })
    .populate("vendor", "vendorName")
    .populate("company", "companyName")
    .sort({ date: 1 })
    .lean();

    // Get all payment entries (credit side - what we've paid)
    const paymentEntries = await PaymentEntry.find({
      client: clientId,
      ...companyFilter
    })
    .populate("vendor", "vendorName")
    .populate("company", "companyName")
    .sort({ date: 1 })
    .lean();

    // Format debit entries (purchases/invoices)
    const debitEntries = purchaseEntries.map(entry => ({
      id: entry._id,
      date: entry.date,
      type: "Purchase",
      description: entry.description || `Purchase from ${entry.vendor?.vendorName || "Unknown Vendor"}`,
      vendorName: entry.vendor?.vendorName || "Unknown Vendor",
      invoiceNo: entry.invoiceNumber,
      amount: entry.totalAmount,
      company: entry.company?.companyName || "Unknown Company",
      referenceNumber: entry.referenceNumber
    }));

    // Format credit entries (payments)
    const creditEntries = paymentEntries.map(entry => ({
      id: entry._id,
      date: entry.date,
      type: "Payment",
      description: entry.description || `Payment to ${entry.vendor?.vendorName || "Unknown Vendor"}`,
      vendorName: entry.vendor?.vendorName || "Unknown Vendor",
      paymentMethod: entry.paymentMethod,
      amount: entry.amount,
      company: entry.company?.companyName || "Unknown Company",
      referenceNumber: entry.referenceNumber
    }));

    // Calculate totals (credit - debit: negative = payable, positive = advance)
    const totalDebit = debitEntries.reduce((sum, entry) => sum + (entry.amount || 0), 0);
    const totalCredit = creditEntries.reduce((sum, entry) => sum + (entry.amount || 0), 0);
    const balance = totalCredit - totalDebit;

    res.json({
      debit: debitEntries,
      credit: creditEntries,
      totals: {
        debit: totalDebit,
        credit: totalCredit,
        balance: balance
      }
    });

  } catch (error) {
    console.error("Error fetching payables ledger:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }

};


// Get vendor-specific payables ledger data
exports.getVendorPayablesLedger = async (req, res) => {
  try {
    const clientId = req.auth.clientId;
    const { vendorId, fromDate, toDate, companyId } = req.query;

    if (!vendorId) {
      return res.status(400).json({ message: "Vendor ID is required" });
    }

    // Build date filter
    const dateFilter = {};
    if (fromDate) {
      // Set to start of day
      const fromDateObj = new Date(fromDate);
      fromDateObj.setHours(0, 0, 0, 0);
      dateFilter.$gte = fromDateObj;
    }
    if (toDate) {
      // Set to end of day
      const toDateObj = new Date(toDate);
      toDateObj.setHours(23, 59, 59, 999);
      dateFilter.$lte = toDateObj;
    }

    // Build company filter
    const companyFilter = companyId ? { company: companyId } : {};

    // Get all purchase entries for the vendor (debit side - all purchases)
    const purchaseQuery = {
      client: clientId,
      vendor: vendorId,
      ...companyFilter
    };

    if (Object.keys(dateFilter).length > 0) {
      purchaseQuery.date = dateFilter;
    }

    const purchaseEntries = await PurchaseEntry.find(purchaseQuery)
    .populate("vendor", "vendorName")
    .populate("company", "companyName")
    .sort({ date: 1 })
    .lean();

    // Get all payment entries for the vendor (credit side - payments except credit payments)
    const paymentQuery = {
      client: clientId,
      vendor: vendorId,
      paymentMethod: { $ne: "Credit" }, // Exclude credit payments
      ...companyFilter
    };

    if (Object.keys(dateFilter).length > 0) {
      paymentQuery.date = dateFilter;
    }

    const paymentEntries = await PaymentEntry.find(paymentQuery)
    .populate("vendor", "vendorName")
    .populate("company", "companyName")
    .sort({ date: 1 })
    .lean();

    // Format debit entries (purchases/invoices)
    const debitEntries = purchaseEntries.map(entry => ({
      id: entry._id,
      date: entry.date,
      type: "Purchase",
      description: entry.description || `Purchase from ${entry.vendor?.vendorName || "Unknown Vendor"}`,
      vendorName: entry.vendor?.vendorName || "Unknown Vendor",
      invoiceNo: entry.invoiceNumber,
      paymentMethod: entry.paymentMethod,
      amount: entry.totalAmount,
      company: entry.company?.companyName || "Unknown Company",
      referenceNumber: entry.referenceNumber
    }));

    // Format credit entries (payments)
    const creditEntries = paymentEntries.map(entry => ({
      id: entry._id,
      date: entry.date,
      type: "Payment",
      description: entry.description || `Payment to ${entry.vendor?.vendorName || "Unknown Vendor"}`,
      vendorName: entry.vendor?.vendorName || "Unknown Vendor",
      paymentMethod: entry.paymentMethod,
      amount: entry.amount,
      company: entry.company?.companyName || "Unknown Company",
      referenceNumber: entry.referenceNumber
    }));

    // Calculate totals (credit - debit: negative = payable, positive = advance)
    const totalDebit = debitEntries.reduce((sum, entry) => sum + (entry.amount || 0), 0);
    const totalCredit = creditEntries.reduce((sum, entry) => sum + (entry.amount || 0), 0);
    const balance = totalCredit - totalDebit;

    res.json({
      debit: debitEntries,
      credit: creditEntries,
      totals: {
        debit: totalDebit,
        credit: totalCredit,
        balance: balance
      }
    });

  } catch (error) {
    console.error("Error fetching vendor payables ledger:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

// Get expense-specific payables ledger data
exports.getExpensePayablesLedger = async (req, res) => {
  try {
    const clientId = req.auth.clientId;
    const { expenseId, fromDate, toDate, companyId } = req.query;

    if (!expenseId) {
      return res.status(400).json({ message: "Expense ID is required" });
    }

    // Build date filter
    const dateFilter = {};
    if (fromDate) {
      // Set to start of day
      const fromDateObj = new Date(fromDate);
      fromDateObj.setHours(0, 0, 0, 0);
      dateFilter.$gte = fromDateObj;
    }
    if (toDate) {
      // Set to end of day
      const toDateObj = new Date(toDate);
      toDateObj.setHours(23, 59, 59, 999);
      dateFilter.$lte = toDateObj;
    }

    // Build company filter
    const companyFilter = companyId ? { company: companyId } : {};

    // Get all payment entries for the expense (these are the "payments" - credit side)
    const expenseQuery = {
      client: clientId,
      expense: expenseId,
      isExpense: true,
      ...companyFilter
    };

    if (Object.keys(dateFilter).length > 0) {
      expenseQuery.date = dateFilter;
    }

    const expensePaymentEntries = await PaymentEntry.find(expenseQuery)
    .populate("expense", "name")
    .populate("company", "companyName")
    .sort({ date: 1 })
    .lean();

    // For expenses, debit side is typically empty (no outstanding amounts to pay)
    const debitEntries = [];

    // Format credit entries (expense payments - these are the actual payments made)
    const creditEntries = expensePaymentEntries.map(entry => ({
      id: entry._id,
      date: entry.date,
      type: "Expense Payment",
      description: entry.description || `Expense payment for ${entry.expense?.name || "Unknown Expense"}`,
      vendorName: entry.expense?.name || "Unknown Expense",
      paymentMethod: entry.paymentMethod,
      amount: entry.amount,
      company: entry.company?.companyName || "Unknown Company",
      referenceNumber: entry.referenceNumber
    }));

    // Calculate totals (credit - debit: negative = payable, positive = advance)
    const totalDebit = debitEntries.reduce((sum, entry) => sum + (entry.amount || 0), 0);
    const totalCredit = creditEntries.reduce((sum, entry) => sum + (entry.amount || 0), 0);
    const balance = totalCredit - totalDebit;

    res.json({
      debit: debitEntries,
      credit: creditEntries,
      totals: {
        debit: totalDebit,
        credit: totalCredit,
        balance: balance
      }
    });

  } catch (error) {
    console.error("Error fetching expense payables ledger:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};
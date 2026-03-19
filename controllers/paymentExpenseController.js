const PaymentExpense = require("../models/PaymentExpense");
const Company = require("../models/Company");
const { getEffectivePermissions } = require("../services/effectivePermissions");
const { resolveActor, findAdminUser } = require("../utils/actorUtils");
const { createNotification } = require("./notificationController");
const mongoose = require('mongoose');
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
      userName: req.user.userName,
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
}

function companyAllowedForUser(req, companyId) {
  if (userIsPriv(req)) return true;
  const allowed = Array.isArray(req.auth.allowedCompanies)
    ? req.auth.allowedCompanies.map(String)
    : [];
  return allowed.length === 0 || allowed.includes(String(companyId));
}

// Create payment expense
exports.createPaymentExpense = async (req, res) => {
  try {
    await ensureAuthCaps(req);

    const { name, description, company: companyId } = req.body;

    if (!companyId || !mongoose.Types.ObjectId.isValid(companyId)) {
      return res.status(400).json({ message: "Invalid company ID" });
    }

    if (!companyAllowedForUser(req, companyId)) {
      return res.status(403).json({ message: "You are not allowed to use this company" });
    }

    // Check if company exists and belongs to client
    const companyDoc = await Company.findOne({ _id: companyId, client: req.auth.clientId });
    if (!companyDoc) {
      return res.status(400).json({ message: "Invalid company selected" });
    }

    // Check if expense name already exists for this company
    const existingExpense = await PaymentExpense.findOne({
      name: { $regex: new RegExp(`^${name}$`, 'i') },
      company: companyId
    });

    if (existingExpense) {
      return res.status(400).json({ message: "Expense name already exists for this company" });
    }

    const expense = await PaymentExpense.create({
      name,
      description,
      company: companyDoc ? companyDoc._id : null,
      client: req.auth.clientId,
      createdByUser: req.auth.userId,
    });

    res.status(201).json({ message: "Payment expense created", expense });
  } catch (err) {
    console.error("createPaymentExpense error:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
};

// Get payment expenses for a client (not company-specific)
exports.getPaymentExpenses = async (req, res) => {
  try {
    await ensureAuthCaps(req);

    const { q } = req.query;

    const where = {
      client: req.auth.clientId,
    };

    if (q) {
      where.name = { $regex: String(q), $options: "i" };
    }

    const expenses = await PaymentExpense.find(where)
      .sort({ name: 1 })
      .lean();

    // console.log("Fetched payment expenses:", expenses);

    res.status(200).json({
      success: true,
      data: expenses,
    });
  } catch (err) {
    console.error("getPaymentExpenses error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
};

// Update payment expense
exports.updatePaymentExpense = async (req, res) => {
  try {
    await ensureAuthCaps(req);

    const expense = await PaymentExpense.findById(req.params.id);
    if (!expense) {
      return res.status(404).json({ message: "Payment expense not found" });
    }

    if (!sameTenant(expense.client, req.auth.clientId)) {
      return res.status(403).json({ message: "Not authorized" });
    }

    const { name, description, company: newCompanyId } = req.body;

    // If changing company, validate permissions
    if (newCompanyId && newCompanyId !== expense.company.toString()) {
      if (!mongoose.Types.ObjectId.isValid(newCompanyId)) {
        return res.status(400).json({ message: "Invalid company ID" });
      }
      if (!companyAllowedForUser(req, newCompanyId)) {
        return res.status(403).json({ message: "You are not allowed to use this company" });
      }
      const companyDoc = await Company.findOne({ _id: newCompanyId, client: req.auth.clientId });
      if (!companyDoc) {
        return res.status(400).json({ message: "Invalid company selected" });
      }
      expense.company = companyDoc._id;
    }

    // Check for duplicate name if name is being changed
    if (name && name !== expense.name) {
      const existingExpense = await PaymentExpense.findOne({
        name: { $regex: new RegExp(`^${name}$`, 'i') },
        company: expense.company,
        _id: { $ne: expense._id }
      });

      if (existingExpense) {
        return res.status(400).json({ message: "Expense name already exists for this company" });
      }
    }

    if (name) expense.name = name;
    if (description !== undefined) expense.description = description;

    await expense.save();

    res.json({ message: "Payment expense updated", expense });
  } catch (err) {
    console.error("updatePaymentExpense error:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
};

// Delete payment expense
exports.deletePaymentExpense = async (req, res) => {
  try {
    await ensureAuthCaps(req);

    const expense = await PaymentExpense.findById(req.params.id);
    if (!expense) {
      return res.status(404).json({ message: "Payment expense not found" });
    }

    if (!sameTenant(expense.client, req.auth.clientId)) {
      return res.status(403).json({ message: "Not authorized" });
    }

    await expense.deleteOne();

    res.json({ message: "Payment expense deleted" });
  } catch (err) {
    console.error("deletePaymentExpense error:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
};
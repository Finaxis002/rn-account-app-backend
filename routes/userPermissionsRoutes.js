// routes/user-permissions.routes.js
const express = require("express");
const mongoose = require("mongoose");
const UserPermission = require("../models/UserPermission");
const Company = require("../models/Company");
const {
  getEffectivePermissions,
} = require("../services/effectivePermissions");
const verifyUser = require("../middleware/verifyUser");
const verifyClientOrAdmin = require("../middleware/verifyClientOrAdmin");

const router = express.Router();

/** Only the keys that exist on UserPermission (overrideable) */
const USER_OVERRIDE_KEYS = new Set([
  "canCreateInventory",
  "canCreateCustomers",
  "canCreateVendors",
  "canCreateCompanies",
  "canUpdateCompanies",
  "canSendInvoiceEmail",
  "canSendInvoiceWhatsapp",
  "canCreateSaleEntries",
  "canCreatePurchaseEntries",
  "canCreateJournalEntries",
  "canCreateReceiptEntries",
  "canCreatePaymentEntries",
  "canShowCustomers",
  "canShowVendors",
]);

function pickOverrideFlags(body) {
  const out = {};
  for (const k of Object.keys(body || {})) {
    if (!USER_OVERRIDE_KEYS.has(k)) continue;
    const v = body[k];
    if (v === true || v === false || v === null) out[k] = v;
  }
  return out;
}

async function validateCompanyScope(clientId, ids = []) {
  if (!Array.isArray(ids) || ids.length === 0) return true;
  const list = await Company
    .find({ _id: { $in: ids }, client: clientId })
    .select("_id")
    .lean();
  return list.length === ids.length;
}

// 🔒 All routes require user to be verified. Also create a tiny shim so legacy code can read req.user.*
router.use(
  verifyClientOrAdmin,
  (req, _res, next) => {
    if (!req.user) {
      const a = req.auth || {};
      req.user = {
        id: a.id,
        _id: a.id,
        createdByClient: a.clientId,
      };
    }
    next();
  }
);

/** ✔️ NEW: current user's EFFECTIVE permissions (caps + limits) */
router.get("/me/effective",verifyUser, async (req, res) => {
  try {
    const clientId = req.auth.clientId;
    const userId = req.auth.id;
    const eff = await getEffectivePermissions({ clientId, userId });
    // Return just what the FE needs to gate UI (flatten caps+limits):
    return res.json({ ...eff.caps, ...eff.limits });
  } catch (e) {
    return res.status(500).json({ message: e.message });
  }
});

/** ✔️ Optional: current user's raw overrides (may be 404 if not created) */
router.get("/me", async (req, res) => {
  try {
    const clientId = req.auth.clientId;
    const userId = req.auth.id;
    const doc = await UserPermission.findOne({ client: clientId, user: userId }).lean();
    if (!doc) return res.status(404).json({ message: "Not found" });
    res.json(doc);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

/** GET: read overrides for a user (raw overrides, not effective) */
router.get("/:userId",verifyClientOrAdmin, async (req, res) => {
  try {
    const clientId = req.user.createdByClient || req.user.id;
    const { userId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ message: "Invalid userId" });
    }
    const doc = await UserPermission.findOne({ client: clientId, user: userId }).lean();
    if (!doc) return res.status(404).json({ message: "Not found" });
    res.json(doc);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

/** GET: effective permissions for a user (merged tenant + overrides) */
router.get("/:userId/effective", async (req, res) => {
  try {
    const clientId = req.user.createdByClient || req.user.id;
    const { userId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ message: "Invalid userId" });
    }
    const eff = await getEffectivePermissions({ clientId, userId });
    res.json(eff);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

/** POST: create overrides for a user (idempotent: 409 if exists) */
router.post("/", async (req, res) => {
  try {
    const clientId = req.user.createdByClient || req.user.id;
    const { user, allowedCompanies, ...flags } = req.body;

    if (!mongoose.Types.ObjectId.isValid(user)) {
      return res.status(400).json({ message: "user is required and must be a valid id" });
    }

    if (!(await validateCompanyScope(clientId, allowedCompanies))) {
      return res.status(400).json({ message: "Invalid allowedCompanies" });
    }

    const update = {
      client: clientId,
      user,
      ...(Array.isArray(allowedCompanies) ? { allowedCompanies } : {}),
      ...pickOverrideFlags(flags),
      updatedBy: req.auth.id, // 🔧 use req.auth.id
    };

    const doc = await UserPermission.create(update);
    res.status(201).json(doc);
  } catch (e) {
    if (e.code === 11000) {
      return res.status(409).json({ message: "Overrides already exist for this user" });
    }
    res.status(500).json({ message: e.message });
  }
});

/** PATCH: update overrides for a user (partial) */
router.patch("/:userId",verifyClientOrAdmin, async (req, res) => {
  try {
    const clientId = req.user.createdByClient || req.user.id;
    const { userId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ message: "Invalid userId" });
    }

    const set = pickOverrideFlags(req.body);
    const update = { ...set, updatedBy: req.auth.id }; // 🔧

    if (req.body.allowedCompanies) {
      if (!(await validateCompanyScope(clientId, req.body.allowedCompanies))) {
        return res.status(400).json({ message: "Invalid allowedCompanies" });
      }
      update.allowedCompanies = req.body.allowedCompanies;
    }

    const doc = await UserPermission.findOneAndUpdate(
      { client: clientId, user: userId },
      { $set: update },
      { new: true }
    );

    if (!doc) return res.status(404).json({ message: "Not found" });
    res.json(doc);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

module.exports = router;

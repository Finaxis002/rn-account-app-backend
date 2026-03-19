// middleware/attachAuthContext.js
const User = require("../models/User");
const Role = require("../models/Role");
const Permission = require("../models/Permission");
const { CAP_KEYS } = require("../models/Role");

function computeRoleCaps(role, userExtraCaps = []) {
  const capSet = new Set();
  const roleCaps = Array.isArray(role?.defaultPermissions) ? role.defaultPermissions : [];

  if (roleCaps.includes("*")) {
    CAP_KEYS.forEach(k => capSet.add(k));
  } else {
    roleCaps.forEach(k => capSet.add(k));
  }
  userExtraCaps.forEach(k => {
    if (k === "*" || CAP_KEYS.includes(k)) capSet.add(k);
  });
  return capSet;
}

function applyTenantFlags(capSet, tenantPerm) {
  if (!tenantPerm) return capSet;
  const removeIfFalse = (flag, key) => {
    if (tenantPerm[flag] === false) capSet.delete(key);
  };

  removeIfFalse("canCreateInventory", "canCreateInventory");
  removeIfFalse("canCreateProducts", "canCreateProducts");
  removeIfFalse("canCreateCustomers", "canCreateCustomers");
  removeIfFalse("canCreateVendors", "canCreateVendors");
  removeIfFalse("canCreateCompanies", "canCreateCompanies");
  removeIfFalse("canUpdateCompanies", "canUpdateCompanies");
  removeIfFalse("canSendInvoiceEmail", "canSendInvoiceEmail");
  removeIfFalse("canSendInvoiceWhatsapp", "canSendInvoiceWhatsapp");
  removeIfFalse("canCreateSaleEntries", "canCreateSaleEntries");
  removeIfFalse("canCreatePurchaseEntries", "canCreatePurchaseEntries");
  removeIfFalse("canCreateJournalEntries", "canCreateJournalEntries");
  removeIfFalse("canCreateReceiptEntries", "canCreateReceiptEntries");
  removeIfFalse("canCreatePaymentEntries", "canCreatePaymentEntries");

  return capSet;
}

module.exports = async function attachAuthContext(req, res, next) {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: "Unauthenticated" });

    // Load user with role + tenant (client)
    const user = await User.findById(userId)
      .populate("role")               // role: ObjectId -> Role
      .select("+client +role +companyIds +extraPermissions") // adjust to your schema
      .lean();

    if (!user) return res.status(401).json({ error: "User not found" });

    const clientId = user.client || req.user.clientId;

    // Tenant permission flags (plan & limits)
    const tenantPerm = clientId
      ? await Permission.findOne({ client: clientId }).lean()
      : null;

    const roleCaps = computeRoleCaps(user.role, user.extraPermissions || []);
    const effectiveCaps = applyTenantFlags(roleCaps, tenantPerm);

    const isMaster = user.role?.name === "master";
    const isClient = user.role?.name === "client";

    req.auth = {
      userId: user._id,
      clientId,
      roleName: user.role?.name,
      caps: Array.from(effectiveCaps),
      limits: {
        planCode: tenantPerm?.planCode || "FREE",
        maxCompanies: tenantPerm?.maxCompanies ?? 1,
        maxUsers: tenantPerm?.maxUsers ?? 1,
        maxInventories: tenantPerm?.maxInventories ?? 0,
      },
      flags: {
        // If you need raw booleans on frontend:
        canCreateInventory: effectiveCaps.has("canCreateInventory"),
        canCreateProducts: effectiveCaps.has("canCreateProducts"),
        canCreateCustomers: effectiveCaps.has("canCreateCustomers"),
        canCreateVendors: effectiveCaps.has("canCreateVendors"),
        canCreateCompanies: effectiveCaps.has("canCreateCompanies"),
        canUpdateCompanies: effectiveCaps.has("canUpdateCompanies"),
        canSendInvoiceEmail: effectiveCaps.has("canSendInvoiceEmail"),
        canSendInvoiceWhatsapp: effectiveCaps.has("canSendInvoiceWhatsapp"),
        canCreateSaleEntries: effectiveCaps.has("canCreateSaleEntries"),
        canCreatePurchaseEntries: effectiveCaps.has("canCreatePurchaseEntries"),
        canCreateJournalEntries: effectiveCaps.has("canCreateJournalEntries"),
        canCreateReceiptEntries: effectiveCaps.has("canCreateReceiptEntries"),
        canCreatePaymentEntries: effectiveCaps.has("canCreatePaymentEntries"),
      },
      isMaster,
      isClient,
      user, // optional: if your controllers need more
    };

    next();
  } catch (e) {
    console.error("attachAuthContext error:", e);
    res.status(500).json({ error: "Failed to build auth context" });
  }
};

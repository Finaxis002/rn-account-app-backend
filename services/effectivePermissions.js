// services/effectivePermissions.js
const Permission = require("../models/Permission");
const UserPermission = require("../models/UserPermission");
const Company = require("../models/Company");

// All capability keys your UI/back-end care about.
// (Some exist only on tenant Permission, some also on UserPermission.)
const CAP_KEYS = [           // tenant-only
  "canCreateInventory",          // tenant-only
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
];

// keys that are allowed to be overridden at the user level
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

/**
 * Merge order:
 *   base = tenant Permission (booleans)
 *   override = UserPermission[key] (true|false|null)
 *   effective = base && (override == null ? true : override)
 * I.e., tenant flags are the ceiling: when tenant=false → effective=false.
 */
async function getEffectivePermissions({ clientId, userId }) {
  const [tenant, userPerm] = await Promise.all([
    Permission.findOne({ client: clientId }).lean(),
    UserPermission.findOne({ client: clientId, user: userId }).lean(),
  ]);

  const caps = {};
  for (const key of CAP_KEYS) {
    const base = tenant?.[key] ?? true; // default to true if not defined
    const override = USER_OVERRIDE_KEYS.has(key) ? userPerm?.[key] : undefined;

    // If tenant base is false → effective false
    if (base === false) {
      caps[key] = false;
      continue;
    }
    // If tenant base is true
    // null/undefined = inherit; otherwise use explicit override
    caps[key] = (override == null) ? true : !!override;
  }

  const limits = {
    planCode: tenant?.planCode || "FREE",
    maxCompanies: tenant?.maxCompanies ?? 1,
    maxUsers: tenant?.maxUsers ?? 1,
    maxInventories: tenant?.maxInventories ?? 0,
  };

  const allowedCompanies = Array.isArray(userPerm?.allowedCompanies)
    ? userPerm.allowedCompanies.map(String)
    : [];

  return { caps, limits, allowedCompanies, clientId, userId };
}

/**
 * Validates that provided company ids belong to this tenant.
 * Returns sanitized array of ObjectIds (as strings).
 */
async function sanitizeAllowedCompanies(clientId, companyIds = []) {
  if (!Array.isArray(companyIds) || companyIds.length === 0) return [];
  const rows = await Company.find({ client: clientId, _id: { $in: companyIds } })
    .select("_id")
    .lean();
  return rows.map((r) => String(r._id));
}

module.exports = {
  CAP_KEYS,
  USER_OVERRIDE_KEYS,
  getEffectivePermissions,
  sanitizeAllowedCompanies,
};

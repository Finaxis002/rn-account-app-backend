const mongoose = require("mongoose");

const CAP_KEYS = [
  "canCreateInventory",
  "canCreateProducts",
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
];

const roleSchema = new mongoose.Schema(
  {
    // machine name/slug: "admin", "client", "user", "auditor", etc.
    name: { type: String, required: true, unique: true, trim: true, lowercase: true },

    // store capability keys (or "*" to grant all caps)
    defaultPermissions: {
      type: [String],
      default: [],
      validate: {
        validator(vals) {
          return vals.every((v) => v === "*" || CAP_KEYS.includes(v));
        },
        message: "defaultPermissions contains unknown capability key",
      },
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Role", roleSchema);
module.exports.CAP_KEYS = CAP_KEYS;

// models/UserPermission.js
const mongoose = require("mongoose");

const userPermissionSchema = new mongoose.Schema(
  {
    // multi-tenant context
    client: { type: mongoose.Schema.Types.ObjectId, ref: "Client", required: true, index: true },

    // the user these overrides apply to
    user:   { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },

    // --- capability flags (null = inherit from client Permission) ---
    canCreateInventory:       { type: Boolean, default: false },
    canCreateCustomers:       { type: Boolean, default: false },
    canCreateVendors:         { type: Boolean, default: false },
    canCreateCompanies:       { type: Boolean, default: false },
    canUpdateCompanies:       { type: Boolean, default: false },
    canSendInvoiceEmail:      { type: Boolean, default: false },
    canSendInvoiceWhatsapp:   { type: Boolean, default: false },
    canCreateSaleEntries:     { type: Boolean, default: false },
    canCreatePurchaseEntries: { type: Boolean, default: false },
    canCreateJournalEntries:  { type: Boolean, default: false },
    canCreateReceiptEntries:  { type: Boolean, default: false },
    canCreatePaymentEntries:  { type: Boolean, default: false },
    canShowCustomers:         { type: Boolean, default: false }, // New field for showing customers in the sales section
    canShowVendors:           { type: Boolean, default: false }, 

    // optional scoping
    allowedCompanies: [{ type: mongoose.Schema.Types.ObjectId, ref: "Company" }],

    // audit
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true, optimisticConcurrency: true }
);

// Ensure one doc per (client,user)
userPermissionSchema.index({ client: 1, user: 1 }, { unique: true });

module.exports = mongoose.model("UserPermission", userPermissionSchema);

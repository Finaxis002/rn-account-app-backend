// models/Permission.js
const mongoose = require("mongoose");

const permissionSchema = new mongoose.Schema(
  {
    client: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Client",
      required: true,
      unique: true,
      index: true,
    },

    // Feature flags
    canCreateUsers: { type: Boolean, default: true },
    canCreateInventory: { type: Boolean, default: true },

    // Split products & inventory
    canCreateProducts: { type: Boolean, default: true },
    // Parties / Customers & Vendors
    canCreateCustomers: { type: Boolean, default: true },   // ✅ new
    canCreateVendors: { type: Boolean, default: true },

    canCreateCompanies: { type: Boolean, default: false },
    canUpdateCompanies: { type: Boolean, default: false },

    canSendInvoiceEmail: { type: Boolean, default: false },
    canSendInvoiceWhatsapp: { type: Boolean, default: false },

    // Usage limits
    maxCompanies: { type: Number, default: 1, min: 0 },
    maxUsers: { type: Number, default: 1, min: 0 },

    // NEW: inventory limit (only applies if canCreateInventory = true)
    maxInventories: { type: Number, default: 20, min: 0 },

    // Optional: tie to plan
    planCode: { type: String, default: "FREE" },

    // Audit
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true, optimisticConcurrency: true }
);

// Optional guard: if inventory creation is disabled, force limit to 0
permissionSchema.pre("save", function (next) {
  if (!this.canCreateInventory) this.maxInventories = 0;
  next();
});
permissionSchema.pre("findOneAndUpdate", function (next) {
  const update = this.getUpdate() || {};
  const $set = update.$set || update;
  if ($set && $set.canCreateInventory === false) {
    // when disabling, also zero out limit
    if (!update.$set) update.$set = {};
    update.$set.maxInventories = 0;
  }
  next();
});

module.exports = mongoose.model("Permission", permissionSchema);

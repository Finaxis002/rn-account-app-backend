// models/StockTracking.js
const mongoose = require("mongoose");

const stockTrackingSchema = new mongoose.Schema(
  {
    product: { 
      type: mongoose.Schema.Types.ObjectId, 
      ref: "Product", 
      required: true 
    },
    company: { 
      type: mongoose.Schema.Types.ObjectId, 
      ref: "Company", 
      required: true 
    },
    financialYear: {
      type: String,
      required: true // Format: "2024-2025"
    },
    openingStock: {
      quantity: { type: Number, default: 0, min: 0 },
      amount: { type: Number, default: 0, min: 0 } // Manual entry for accounting
    },
    closingStock: {
      quantity: { type: Number, default: 0, min: 0 },
      amount: { type: Number, default: 0, min: 0 } // Calculated automatically
    },
    createdByClient: { 
      type: mongoose.Schema.Types.ObjectId, 
      ref: "Client", 
      required: true 
    },
    createdByUser: { 
      type: mongoose.Schema.Types.ObjectId, 
      ref: "User", 
      required: true 
    }
  },
  { timestamps: true }
);

// Compound unique index for product-company-financialYear combination
stockTrackingSchema.index(
  { product: 1, company: 1, financialYear: 1, createdByClient: 1 }, 
  { unique: true }
);

module.exports = mongoose.model("StockTracking", stockTrackingSchema);
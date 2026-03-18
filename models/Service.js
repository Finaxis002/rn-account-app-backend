const mongoose = require("mongoose");

const serviceSchema = new mongoose.Schema(
  {
    serviceName: {
      type: String,
      required: true,
     
      trim: true,
    },
    quantity: {
      type: Number,
      default: 1,
      min: 1,
    },
    unitType: { 
      type: String, 
      default: "Hours" 
    },
    pricePerUnit: { 
      type: Number,
      default: 0,
      min: 0,
    },
    amount: {
      type: Number,
      default: 0,
      min: 0,
    },
    description: {
      type: String,
      trim: true,
    },
    sac: { type: String, trim: true },
    // Legacy single-company mapping (kept for backward compatibility).
    company: { type: mongoose.Schema.Types.ObjectId, ref: "Company" },
    // New multi-company mapping. Empty/missing means global (all companies).
    companies: [{ type: mongoose.Schema.Types.ObjectId, ref: "Company" }],
    createdByClient: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Client",
      required: true,
    },
    createdByUser:   { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true }
);

// Unique per client
serviceSchema.index({ serviceName: 1, createdByClient: 1 }, { unique: true });

module.exports = mongoose.model("Service", serviceSchema);

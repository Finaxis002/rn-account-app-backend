const mongoose = require("mongoose");

const additionalServiceSchema = new mongoose.Schema(
  {
    serviceName: {
      type: String,
      required: true,
      trim: true,
    },
    serviceCost: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },
    additionalCharges: {
      type: Number,
      default: 0,
      min: 0,
    },
    totalAmount: {
      type: Number,
      default: 0,
      min: 0,
    },
    description: {
      type: String,
      trim: true,
    },
    // Legacy single-company mapping (kept for backward compatibility).
    company: { type: mongoose.Schema.Types.ObjectId, ref: "Company" },
    // Multi-company mapping. Empty/missing means global (all companies).
    companies: [{ type: mongoose.Schema.Types.ObjectId, ref: "Company" }],
    createdByClient: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Client",
      required: true,
    },
    createdByUser: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  { timestamps: true }
);

additionalServiceSchema.pre("validate", function additionalServicePreValidate(next) {
  const serviceCost = Number(this.serviceCost) || 0;
  const additionalCharges = Number(this.additionalCharges) || 0;
  this.totalAmount = Number((Math.max(0, serviceCost) + Math.max(0, additionalCharges)).toFixed(2));
  next();
});

module.exports = mongoose.model("AdditionalService", additionalServiceSchema);


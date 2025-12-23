const mongoose = require("mongoose");

const serviceSchema = new mongoose.Schema(
  {
    serviceName: {
      type: String,
      required: true,
     
      trim: true,
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

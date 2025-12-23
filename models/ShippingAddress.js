const mongoose = require("mongoose");

const shippingAddressSchema = new mongoose.Schema(
  {
    party: { type: mongoose.Schema.Types.ObjectId, ref: "Party", required: true },
    label: { type: String, required: true, trim: true }, // e.g., "Home", "Office", "Warehouse"
    address: { type: String, required: true, trim: true },
    city: { type: String, required: true, trim: true },
    state: { type: String, required: true, trim: true },
    pincode: { type: String, trim: true },
    contactNumber: { type: String, trim: true },
    createdByClient: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Client",
      required: true,
    },
    createdByUser: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true }
);

// Ensure label + party combo is unique
shippingAddressSchema.index({ label: 1, party: 1 }, { unique: true });

module.exports = mongoose.model("ShippingAddress", shippingAddressSchema);
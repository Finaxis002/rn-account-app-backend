// models/AccountValidity.js
const mongoose = require("mongoose");
const { Schema } = mongoose;

const AccountValiditySchema = new Schema(
  {
    client: { type: Schema.Types.ObjectId, ref: "Client", required: true, unique: true, index: true },
    startAt: { type: Date, required: true, default: () => new Date() }, // UTC
    expiresAt: { type: Date, required: true, index: true },             // UTC
    status: { type: String, enum: ["active", "expired", "disabled"], default: "active", index: true },
    notes: { type: String },
  },
  { timestamps: true }
);

// convenience: compute remaining ms
AccountValiditySchema.virtual("remainingMs").get(function () {
  return Math.max(0, (this.expiresAt?.getTime() || 0) - Date.now());
});

module.exports = mongoose.model("AccountValidity", AccountValiditySchema);

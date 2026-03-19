// models/EmailIntegration.js
const mongoose = require("mongoose");

const emailIntegrationSchema = new mongoose.Schema(
  {
    client: { type: mongoose.Schema.Types.ObjectId, ref: "Client", required: true, unique: true, index: true },
    provider: { type: String, enum: ["gmail"], default: "gmail" },
    connected: { type: Boolean, default: false },
    email: { type: String, default: null },
    termsAcceptedAt: { type: Date, default: null },

    // Only keep the refresh token. Encrypt at rest in production.
    refreshToken: { type: String, default: null, select: true },
    // 🔴 NEW: why we are disconnected + when we noticed
    reason: { type: String, enum: ["token_expired", "revoked", "unknown", null], default: null },
    lastFailureAt: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model("EmailIntegration", emailIntegrationSchema);

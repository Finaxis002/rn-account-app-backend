const mongoose = require("mongoose");
const unitSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    createdByClient: { type: mongoose.Schema.Types.ObjectId, ref: "Client", required: true },
    createdByUser: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true }
);

// Compound unique index per client, case-insensitive
unitSchema.index({ createdByClient: 1, name: 1 }, { unique: true, collation: { locale: "en", strength: 2 } });

module.exports = mongoose.model("Unit", unitSchema);
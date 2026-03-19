// models/IssuedInvoiceNumber.js
const mongoose = require("mongoose");

const IssuedInvoiceNumberSchema = new mongoose.Schema({
  company: { type: mongoose.Schema.Types.ObjectId, ref: "Company", index: true, required: true },
  series:  { type: String, enum: ["sales", "purchase", "proforma"], index: true, required: true },
  invoiceNumber: { type: String, index: true, required: true },
  yearYY:  { type: Number, index: true, required: true },
  seq:     { type: Number, required: true },
  prefix:  { type: String, required: true },
}, { timestamps: true });

// Ensure no duplicates within a series
IssuedInvoiceNumberSchema.index({ company: 1, series: 1, yearYY: 1, seq: 1 }, { unique: true });

module.exports = mongoose.models.IssuedInvoiceNumber || mongoose.model("IssuedInvoiceNumber", IssuedInvoiceNumberSchema);

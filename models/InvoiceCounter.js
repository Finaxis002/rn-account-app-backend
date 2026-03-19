// models/InvoiceCounter.js
const mongoose = require("mongoose");

const InvoiceCounterSchema = new mongoose.Schema({
 company: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true },
  yearYY: { type: Number, required: true },
  series: { type: String, default: "sales", required: true }, // Add series field
  seq: { type: Number, default: 0 }
}, { timestamps: true });

// One counter per (company, series, year)
InvoiceCounterSchema.index({ company: 1, series: 1, yearYY: 1 }, { unique: true });

module.exports = mongoose.models.InvoiceCounter || mongoose.model("InvoiceCounter", InvoiceCounterSchema);

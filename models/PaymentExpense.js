const mongoose = require("mongoose");

const paymentExpenseSchema = new mongoose.Schema({
  name: { type: String, required: true },
  description: { type: String },
  company: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true },
  client: { type: mongoose.Schema.Types.ObjectId, ref: "Client", required: true },
  createdByUser: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
}, { timestamps: true });

// Ensure unique expense names per company
paymentExpenseSchema.index({ name: 1, company: 1 }, { unique: true });

module.exports = mongoose.model("PaymentExpense", paymentExpenseSchema);
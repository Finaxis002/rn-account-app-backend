const mongoose = require("mongoose");

const paymentSchema = new mongoose.Schema({
  vendor: { type: mongoose.Schema.Types.ObjectId, ref: "Vendor", required: false },
  expense: { type: mongoose.Schema.Types.ObjectId, ref: "PaymentExpense", required: false },
  isExpense: { type: Boolean, default: false },
  date: { type: Date, required: false },
  amount: { type: Number, required: false },
//   mode: { type: String, enum: ["Cash", "Bank", "UPI", "Cheque"], required: false },
  description: { type: String },
  paymentMethod: {
    type: String,
    enum: ["Cash", "UPI", "Bank Transfer", "Cheque"]
  },
  referenceNumber: { type: String },
  company: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: false },
  client: { type: mongoose.Schema.Types.ObjectId, ref: "Client", required: false },
   createdByUser:   { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  type: { type: String, enum: ["payment"], default: "payment" }
}, { timestamps: true });

module.exports = mongoose.model("PaymentEntry", paymentSchema);

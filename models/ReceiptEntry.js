const mongoose = require("mongoose");

const receiptSchema = new mongoose.Schema({
  party: { type: mongoose.Schema.Types.ObjectId, ref: "Party", required: false },
  date: { type: Date, required: false },
  amount: { type: Number, required: false },
  description: { type: String },
  paymentMethod: {
    type: String,
    enum: ["Cash", "UPI", "Bank Transfer", "Cheque"]
  },
  referenceNumber: { type: String }, 
  company: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: false },
  client: { type: mongoose.Schema.Types.ObjectId, ref: "Client", required: false },
  createdByUser: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  type: { type: String, enum: ["receipt"], default: "receipt" }
}, { timestamps: true });

module.exports = mongoose.model("ReceiptEntry", receiptSchema);

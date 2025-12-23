const mongoose = require("mongoose");

const journalSchema = new mongoose.Schema({
  debitAccount: { type: String, required: false },
  creditAccount: { type: String, required: false },
  date: { type: Date, required: false },
  amount: { type: Number, required: false },
  narration: { type: String },
  company: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: false },
  client: { type: mongoose.Schema.Types.ObjectId, ref: "Client", required: false },
  createdByUser: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  type: { type: String, enum: ["journal"], default: "journal" }
}, { timestamps: true });

module.exports = mongoose.model("JournalEntry", journalSchema);

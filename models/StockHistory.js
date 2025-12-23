// models/StockHistory.js
const mongoose = require("mongoose");

const stockHistorySchema = new mongoose.Schema(
  {
    product: { 
      type: mongoose.Schema.Types.ObjectId, 
      ref: "Product", 
      required: true 
    },
    company: { 
      type: mongoose.Schema.Types.ObjectId, 
      ref: "Company", 
      required: true 
    },
    financialYear: {
      type: String,
      required: true
    },
    date: { 
      type: Date, 
      required: true 
    },
    type: {
      type: String,
      enum: ["opening", "purchase", "sale", "adjustment", "closing"],
      required: true
    },
    quantity: { 
      type: Number, 
      required: true 
    },
    amount: { 
      type: Number, 
      default: 0 
    },
    reference: {
      type: mongoose.Schema.Types.ObjectId,
      refPath: 'referenceModel'
    },
    referenceModel: {
      type: String,
      enum: ['SalesEntry', 'Purchase', 'StockAdjustment']
    },
    createdByClient: { 
      type: mongoose.Schema.Types.ObjectId, 
      ref: "Client", 
      required: true 
    },
    createdByUser: { 
      type: mongoose.Schema.Types.ObjectId, 
      ref: "User", 
      required: true 
    }
  },
  { timestamps: true }
);

stockHistorySchema.index({ product: 1, company: 1, financialYear: 1, date: 1 });
stockHistorySchema.index({ reference: 1, referenceModel: 1 });

module.exports = mongoose.model("StockHistory", stockHistorySchema);
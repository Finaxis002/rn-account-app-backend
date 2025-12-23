// models/StockBatch.js
const mongoose = require('mongoose');

const stockBatchSchema = new mongoose.Schema({
  product: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product',
    required: true
  },
  purchaseEntry: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'PurchaseEntry',
  },
  companyId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: true
  },
  clientId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Client',
    required: true
  },
  purchaseDate: {
    type: Date,
    required: true
  },
  costPrice: {
    type: Number,
    required: true,
    min: 0
  },
  initialQuantity: {
    type: Number,
    required: true,
    min: 0
  },
  remainingQuantity: {
    type: Number,
    required: true,
    min: 0
  },
  status: {
    type: String,
    enum: ['active', 'sold', 'cancelled'],
    default: 'active'
  },
  isActive: {
    type: Boolean,
    default: true
  },
  consumedBySales: [{
    saleEntry: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'SaleEntry'
    },
    quantity: {
      type: Number,
      min: 0
    },
    consumedAt: {
      type: Date,
      default: Date.now
    }
  }]
}, {
  timestamps: true
});


module.exports = mongoose.model('StockBatch', stockBatchSchema);
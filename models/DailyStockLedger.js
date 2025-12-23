// models/DailyStockLedger.js
const mongoose = require('mongoose');

const dailyStockLedgerSchema = new mongoose.Schema({
  clientId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Client',
    required: true
  },
  companyId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: true
  },
  date: {
    type: Date,
    required: true
  },
  openingStock: {
    quantity: {
      type: Number,
      default: 0,
      min: 0
    },
    amount: {
      type: Number,
      default: 0,
      min: 0
    }
  },
  closingStock: {
    quantity: {
      type: Number,
      default: 0,
      min: 0
    },
    amount: {
      type: Number,
      default: 0,
      min: 0
    }
  },
  totalPurchaseOfTheDay: {
    quantity: {
      type: Number,
      default: 0,
      min: 0
    },
    amount: {
      type: Number,
      default: 0,
      min: 0
    }
  },
  totalSalesOfTheDay: {
    quantity: {
      type: Number,
      default: 0,
      min: 0
    },
    amount: {
      type: Number,
      default: 0,
      min: 0
    }
  },
  totalCOGS: {
    type: Number,
    default: 0,
    min: 0
  },
  expenseSummary: [
    {
      expenseHead: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'PaymentExpense',   // dynamic head like "Petrol", "Packing", etc.
        required: true,
      },
      amount: {
        type: Number,
        required: true,
        min: 0,
      },
      // optional metadata (if you ever need it)
      // count: { type: Number, default: 0, min: 0 }, // number of vouchers
    },
  ],

totalExpenses: {
    type: Number,
    default: 0,
    min: 0,
  },

}, {
  timestamps: true
});

dailyStockLedgerSchema.index(
  { clientId: 1, companyId: 1, date: 1 },
  { unique: true }
);

module.exports = mongoose.model('DailyStockLedger', dailyStockLedgerSchema);
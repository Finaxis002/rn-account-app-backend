const mongoose = require("mongoose");

const UNIT_TYPES = ["Kg", "Litre", "Piece", "Box", "Meter", "Dozen", "Pack", "Other"];

const salesItemSchema = new mongoose.Schema({
  product: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
  quantity: { type: Number, required: true, min: 1 },
  pricePerUnit: { type: Number, required: true, min: 0 },
  unitType: { type: String, enum: UNIT_TYPES, default: "Piece" },
  otherUnit : {type: String},
  amount: { type: Number, required: true, min: 0 },
    // New fields to store GST-related information
  gstPercentage: { type: Number, default: 18 },  // Default GST percentage can be set here
  lineTax: { type: Number, required: true, min: 0 }, // GST amount for this product line
  lineTotal: { type: Number, required: true, min: 0 }, // Final total with GST
  hsn: { type: String, trim: true },
}, { _id: false });

const salesServiceSchema = new mongoose.Schema({
  service: { type: mongoose.Schema.Types.ObjectId, ref: "Service", required: true },
  amount: { type: Number, required: true, min: 1 },
  description: { type: String },

  // New fields to store GST-related information for services
  gstPercentage: { type: Number, default: 18 },  // Default GST percentage for services
  lineTax: { type: Number, required: true, min: 0 }, // GST amount for this service line
  lineTotal: { type: Number, required: true, min: 0 }, // Final total with GST for the service
  sac: { type: String, trim: true },
}, { _id: false });


const salesSchema = new mongoose.Schema({
  party: { type: mongoose.Schema.Types.ObjectId, ref: "Party", required: true },
  company: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true },
  client: { type: mongoose.Schema.Types.ObjectId, ref: "Client", required: true },
  createdByUser: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  date: { type: Date, required: true },
  dueDate: { type: Date },

  bank: { type: mongoose.Schema.Types.ObjectId, ref: "BankDetail"},
  shippingAddress: { type: mongoose.Schema.Types.ObjectId, ref: "ShippingAddress" },

  products: {
    type: [salesItemSchema],
    required: false,
    validate: {
      validator: function () {
        const p = Array.isArray(this.products) ? this.products.length : 0;
        const s = Array.isArray(this.services) ? this.services.length : 0;
        return !(p === 0 && s === 0);
      },
      message: "At least one product or service is required",
    },
  },

  // ✅ top-level array is plural: services
  services: {
    type: [salesServiceSchema],
    required: false,
    validate: {
      validator: function () {
        const p = Array.isArray(this.products) ? this.products.length : 0;
        const s = Array.isArray(this.services) ? this.services.length : 0;
        return !(p === 0 && s === 0);
      },
      message: "At least one product or service is required",
    },
  },

  totalAmount: { type: Number, required: true, min: 0 },

  description: { type: String },
  referenceNumber: { type: String },

  gstPercentage: { type: Number },
  discountPercentage: { type: Number },
  invoiceType: { type: String, enum: ["Tax", "Invoice"] },
  gstin: { type: String },
  invoiceNumber: { type: String, index: true },
  invoiceYearYY: { type: Number, index: true },
  paymentMethod: {
    type: String,
    enum: ["Cash", "Credit", "UPI", "Bank Transfer", "Cheque", "Others"]
  },
  notes: {
    type: String,
    default: ""
  },

  stockImpact: [
    {
      productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product" },
      quantity: { type: Number, required: true }, // total qty consumed for this product
      cogs: { type: Number, required: true },     // COGS for this product line
      batches: [
        {
          batchId: { type: mongoose.Schema.Types.ObjectId, ref: "StockBatch" },
          consumedQty: { type: Number, required: true },
          costPrice: { type: Number, required: true },
          cogs: { type: Number, required: true }
        }
      ]
    }
  ]
}, { timestamps: true });

// Unique per company + year + number (ignore when not set)
salesSchema.index(
  { company: 1, invoiceYearYY: 1, invoiceNumber: 1 },
  { unique: true, partialFilterExpression: { invoiceNumber: { $exists: true, $type: "string" } } }
);

module.exports = mongoose.model("SalesEntry", salesSchema);

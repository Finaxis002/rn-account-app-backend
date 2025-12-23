const mongoose = require("mongoose");

const UNIT_TYPES = ["Kg", "Litre", "Piece", "Box", "Meter", "Dozen", "Pack", "Other"];

const purchaseItemSchema = new mongoose.Schema({
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
}, { _id: false });

const purchaseServiceSchema = new mongoose.Schema({
  serviceName: { type: mongoose.Schema.Types.ObjectId, ref: "Service", required: true },
  amount: { type: Number, required: true, min: 1 },
  description: { type: String },
    // New fields to store GST-related information for services
  gstPercentage: { type: Number, default: 18 },  // Default GST percentage for services
  lineTax: { type: Number, required: true, min: 0 }, // GST amount for this service line
  lineTotal: { type: Number, required: true, min: 0 }, // Final total with GST for the service
}, { _id: false });

const purchaseSchema = new mongoose.Schema({
  vendor: { type: mongoose.Schema.Types.ObjectId, ref: "Vendor", required: true },
  company: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true },
  client: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  createdByUser: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  date: { type: Date, required: true },
  bank: { type: mongoose.Schema.Types.ObjectId, ref: "BankDetail"},
  products: {
    type: [purchaseItemSchema],
    required: false
  },
  services: {
    type: [purchaseServiceSchema],
    required: false
  },
  totalAmount: { type: Number, required: true, min: 0 },
  description: { type: String },
  referenceNumber: { type: String },
  gstPercentage: { type: Number },
  invoiceType: { type: String, enum: ["Tax", "Invoice"] },
  gstin: { type: String },
  invoiceNumber: { type: String, index: true },
  invoiceYearYY: { type: Number, index: true },
  paymentMethod: {
    type: String,
    enum: ["Cash", "Credit", "UPI", "Bank Transfer", "Cheque","Others"]
  },
}, {
  timestamps: true,
  // Add document-level validation here
  validate: {
    validator: function () {
      const p = Array.isArray(this.products) ? this.products.length : 0;
      const s = Array.isArray(this.services) ? this.services.length : 0;
      return p + s > 0;
    },
    message: 'At least one product or service is required'
  }
});

module.exports = mongoose.model("PurchaseEntry", purchaseSchema);
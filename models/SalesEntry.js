const mongoose = require("mongoose");

const UNIT_TYPES = ["Kg", "Litre", "Piece", "Box", "Meter", "Dozen", "Pack", "Other"];

const salesItemSchema = new mongoose.Schema({
  product: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
  quantity: { type: Number, required: true, min: 1 },
  pricePerUnit: { type: Number, required: true, min: 0 },
  discountType: { type: String, enum: ["fixed", "percentage"], default: "fixed" },
  discountValue: { type: Number, default: 0 },
  unitType: { type: String, enum: UNIT_TYPES, default: "Piece" },
  otherUnit: { type: String },
  amount: { type: Number, required: true, min: 0 },
  // New fields to store GST-related information..
  gstPercentage: { type: Number, default: 18 },  // Default GST percentage can be set here
  lineTax: { type: Number, required: true, min: 0 }, // GST amount for this product line
  lineTotal: { type: Number, required: true, min: 0 }, // Final total with GST
  hsn: { type: String, trim: true },
}, { _id: false });

const salesServiceSchema = new mongoose.Schema({
  service: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    refPath: "serviceModel",
  },
  serviceModel: {
    type: String,
    enum: ["Service", "AdditionalService"],
    default: "Service",
  },
  isAdditionalService: { type: Boolean, default: false },
  quantity: { type: Number, default: 1, min: 0 },        // ✅ ADD
  unitType: { type: String, default: "Hours" },           // ✅ ADD
  pricePerUnit: { type: Number, default: 0, min: 0 },     // ✅ ADD
  amount: { type: Number, required: true, min: 1 },
  description: { type: String },
  discountType: { type: String, enum: ["fixed", "percentage"], default: "fixed" },
  discountValue: { type: Number, default: 0 },
  // New fields to store GST-related information for services
  gstPercentage: { type: Number, default: 18 },  // Default GST percentage for services
  lineTax: { type: Number, required: true, min: 0 }, // GST amount for this service line
  lineTotal: { type: Number, required: true, min: 0 }, // Final total with GST for the service
  sac: { type: String, trim: true },
  serviceStartDate: { type: Date },
  serviceDueDate: { type: Date },
  travelDate: { type: Date },
  travelFrom: { type: String, trim: true, default: "" },
  travelTo: { type: String, trim: true, default: "" },
  vehicleType: { type: String, trim: true, default: "" },
  vehicleNumber: { type: String, trim: true, default: "" },
  fixedCharges: { type: Number, default: 0, min: 0 },
  variableQty: { type: Number, default: 0, min: 0 },
  variableUnit: { type: String, trim: true, default: "Km" },
  variableRate: { type: Number, default: 0, min: 0 },
  variableCharges: { type: Number, default: 0, min: 0 },
}, { _id: false });


// Minimal stored shape for additional services on a sales entry
const additionalServiceLineSchema = new mongoose.Schema(
  {
    service: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AdditionalService",
      required: true,
    },
    serviceName: { type: String, required: true }, // Store name for easy access without population
    amount: { type: Number, required: true, min: 0 },
    description: { type: String, trim: true },
    serviceStartDate: { type: Date },
    serviceDueDate: { type: Date },
    travelDate: { type: Date },
  },
  { _id: false },
);


const salesSchema = new mongoose.Schema({
  party: { type: mongoose.Schema.Types.ObjectId, ref: "Party", required: true },
  company: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true },
  client: { type: mongoose.Schema.Types.ObjectId, ref: "Client", required: true },
  createdByUser: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  date: { type: Date, required: true },
  dueDate: { type: Date },
  discountType: { type: String, enum: ["fixed", "percentage"], default: "fixed" },
  discountValue: { type: Number, default: 0 },
  bank: { type: mongoose.Schema.Types.ObjectId, ref: "BankDetail" },
  shippingAddress: { type: mongoose.Schema.Types.ObjectId, ref: "ShippingAddress" },

  products: {
    type: [salesItemSchema],
    required: false,
  },

  // ✅ top-level array is plural: services....
  services: {
    type: [salesServiceSchema],
    required: false,
  },

  // Additional services (separate from normal services)
  additionalServices: {
    type: [additionalServiceLineSchema],
    required: false,
    default: [],
  },

  totalAmount: { type: Number, required: true, min: 0 },

  advanceReceived: {
    type: Number,
    default: 0,
    min: 0
  },
  extraDiscount: {
    type: Number,
    default: 0
  },
  extraDiscountType: {
    type: String,
    enum: ["fixed", "percentage"],
    default: "fixed"
  },
  netPayable: {
    type: Number,
    default: 0
  },
  customRemark: {
    type: String,
    trim: true
  },
  invoiceTotal: {
    type: Number,
    required: true,
    default: 0
  },
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

// Ensure at least one line item across products/services/additionalServices
salesSchema.pre("validate", function (next) {
  const p = Array.isArray(this.products) ? this.products.length : 0;
  const s = Array.isArray(this.services) ? this.services.length : 0;
  const a = Array.isArray(this.additionalServices) ? this.additionalServices.length : 0;
  if (p + s + a === 0) {
    return next(new Error("At least one product, service, or additional service is required"));
  }
  next();
});

module.exports = mongoose.model("SalesEntry", salesSchema);

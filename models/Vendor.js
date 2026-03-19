const mongoose = require("mongoose");

const vendorSchema = new mongoose.Schema(
  {
    vendorName: { type: String, required: true, trim: true },
    address: { type: String, trim: true },
    city: { type: String, trim: true },
    state: { type: String, trim: true },
    gstin: { type: String, uppercase: true, trim: true },
    gstRegistrationType: {
      type: String,
      enum: ["Regular", "Composition", "Unregistered", "Consumer", "Overseas", "Special Economic Zone", "Unknown"],
      default: "Unregistered",
    },
    pan: { type: String, uppercase: true, trim: true },
    isTDSApplicable: { type: Boolean, default: false },
    contactNumber: { type: String, trim: true,  sparse: true },
    email: { type: String, lowercase: true, trim: true, sparse: true},
    createdByClient: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Client",
      required: true,
    },
     createdByUser:   { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
         company: [{ 
        type: mongoose.Schema.Types.ObjectId, 
        ref: "Company" 
     }],
     balances: { type: Map, of: Number, default: {} }, // companyId -> balance
  },
  { timestamps: true }
);

vendorSchema.index(
  { contactNumber: 1, createdByClient: 1 },
  { unique: true, sparse: true }
);
vendorSchema.index(
  { email: 1, createdByClient: 1 },
  { unique: true, sparse: true }
);

module.exports = mongoose.model("Vendor", vendorSchema);

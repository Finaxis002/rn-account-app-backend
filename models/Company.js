const mongoose = require("mongoose");

const companySchema = new mongoose.Schema({
  registrationNumber: { type: String, required: true, unique: true },
  businessName: { type: String, required: true },
  businessType: {
    type: String,
    required: true
  },
  address: { type: String },
  City: { type: String },
  addressState: { type: String },
  Country: { type: String },
  Pincode: { type: String },
  Telephone: { type: String },
  mobileNumber: { type: String, required: true },
  emailId: { type: String, default: null },
  Website: { type: String, default: null },
  PANNumber: { type: String, default: null },
  IncomeTaxLoginPassword: { type: String, default: null },
  gstin: { type: String, default: null },
  gstState: { type: String, default: null },
  RegistrationType: { type: String, default: null },
  PeriodicityofGSTReturns: { type: String, default: null },
  GSTUsername: { type: String, default: null },
  GSTPassword: { type: String, default: null },
  ewayBillApplicable: { type: Boolean },
  EWBBillUsername: { type: String, default: null },
  EWBBillPassword: { type: String, default: null },
  TANNumber: { type: String, default: null },
  TAXDeductionCollectionAcc: { type: String, default: null },
  DeductorType: { type: String, default: null },
  TDSLoginUsername: { type: String, default: null },
  TDSLoginPassword: { type: String, default: null },


  client: { type: mongoose.Schema.Types.ObjectId, ref: "Client", required: true },
  // NEW: Assigned client
  selectedClient: { type: mongoose.Schema.Types.ObjectId, ref: "Client", default: null },
  logo: { type: String, default: null }, // URL of the logo
}, { timestamps: true });

module.exports = mongoose.model("Company", companySchema);

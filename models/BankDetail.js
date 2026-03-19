// models/BankDetail.js
const mongoose = require("mongoose");
const { Schema } = mongoose;

const IFSC_REGEX = /^[A-Z]{4}0[A-Z0-9]{6}$/; // RBI format: 4 letters + 0 + 6 alnum

const BankDetailSchema = new Schema(
  {
    // Relations (optional but recommended for your app’s data model)
    client: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Client",
      required: true,
    }, // assign to client
     user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    }, // assign to client
    
    company: { type: Schema.Types.ObjectId, ref: "Company" },               // optional link to Company

    // Denormalized text labels (for easy UI display / filters)
    clientName: { type: String, trim: true },        // from your "Client Name" input (if not selecting by id)
    businessName: { type: String, trim: true },      // from your "Business Name" input

    // Form fields
    bankName: { type: String, required: true, trim: true },
    // managerName: { type: String, required: true, trim: true },
    // contactNumber: {
    //   type: String,
    //   required: true,
    //   trim: true,
    //   validate: {
    //     validator: (v) => /^\d{10}$/.test(String(v || "")), // India 10-digit
    //     message: "Enter a valid 10-digit contact number",
    //   },
    // },
    // post: { type: String, trim: true }, // designation
    // email: {
    //   type: String,
    //   trim: true,
    //   lowercase: true,
    //   validate: {
    //     validator: (v) =>
    //       !v || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), // optional but validate if present
    //     message: "Enter a valid email",
    //   },
    // },
    city: { type: String, required: true, trim: true },
    accountNo: { type: String, required: true, trim: true },
    ifscCode: {
      type: String,

    },
    branchAddress: { type: String, trim: true },
    upiDetails: {
      upiId: { type: String, trim: true },
      upiName: { type: String, trim: true },
      upiMobile: { type: String, trim: true },
    },
    qrCode: { type: String, trim: true }, // Path to uploaded QR code image

    // Auditing
    createdByUser: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

// Useful indexes
BankDetailSchema.index({ client: 1, bankName: 1, city: 1 });
BankDetailSchema.index({
  bankName: "text",
  // managerName: "text",
  city: "text",
  branchAddress: "text",
  businessName: "text",
  clientName: "text",
});

// Optional “near-duplicate” guard (same client, bank, IFSC, and branch address)
BankDetailSchema.index(
  { client: 1, bankName: 1, ifscCode: 1, branchAddress: 1 },
  { unique: false } // set to true only if you're sure you want to enforce strict uniqueness
);

module.exports = mongoose.model("BankDetail", BankDetailSchema);

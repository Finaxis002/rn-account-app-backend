// scripts/seedRoles.js
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") }); // load ../.env

const mongoose = require("mongoose");
const Role = require("../models/Role"); // your Role model with CAP_KEYS-based defaults

const MONGO_URI =
  process.env.MONGO_URI ||
  process.env.MONGODB_URI ||
  process.env.DATABASE_URL ||
  "";

if (!MONGO_URI) {
  console.error(
    "❌ No Mongo URI found. Set MONGO_URI (or MONGODB_URI / DATABASE_URL) in .env"
  );
  process.exit(1);
}

const ROLES = [
  { name: "master", defaultPermissions: ["*"] },
  {
    name: "admin",
    defaultPermissions: [
      "canCreateInventory",
      "canCreateProducts",
      "canCreateCustomers",
      "canCreateVendors",
      "canCreateCompanies",
      "canUpdateCompanies",
      "canSendInvoiceEmail",
      "canSendInvoiceWhatsapp",
      "canCreateSaleEntries",
      "canCreatePurchaseEntries",
      "canCreateJournalEntries",
      "canCreateReceiptEntries",
      "canCreatePaymentEntries",
    ],
  },
  {
    name: "user",
    defaultPermissions: ["canCreateProducts", "canCreateSaleEntries"],
  },
  { name: "auditor", defaultPermissions: [] },
];

async function main() {
  console.log("Connecting to:", MONGO_URI.replace(/\/\/.*@/, "//***@"));
  await mongoose.connect(MONGO_URI);
  for (const r of ROLES) {
    await Role.updateOne({ name: r.name }, { $set: r }, { upsert: true });
    console.log(`✓ seeded role: ${r.name}`);
  }
  await mongoose.disconnect();
  console.log("✅ Done.");
}

main().catch(async (err) => {
  console.error("❌ Seed failed:", err);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});

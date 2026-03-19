// scripts/cleanupEmptyDSL.js
const mongoose = require("mongoose");
const dotenv = require("dotenv");
dotenv.config();

const DailyStockLedger = require("../models/DailyStockLedger");

async function cleanupEmptyDSL() {
  try {
    await mongoose.connect(process.env.MONGO_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });

    console.log("✅ Connected to MongoDB");

    // Query for empty DSL rows
    const emptyDSL = await DailyStockLedger.find({
      "openingStock.quantity": 0,
      "openingStock.amount": 0,
      "closingStock.quantity": 0,
      "closingStock.amount": 0,
      "totalPurchaseOfTheDay.quantity": 0,
      "totalPurchaseOfTheDay.amount": 0,
      "totalSalesOfTheDay.quantity": 0,
      "totalSalesOfTheDay.amount": 0,
      totalCOGS: 0
    });

    console.log(`📦 Found ${emptyDSL.length} empty DSL rows to delete`);

    if (emptyDSL.length === 0) {
      console.log("✨ No empty DSL rows found");
      process.exit(0);
    }

    // Delete them
    const result = await DailyStockLedger.deleteMany({
      _id: { $in: emptyDSL.map(d => d._id) }
    });

    console.log(`🗑 Deleted ${result.deletedCount} empty DSL rows successfully`);

    process.exit(0);

  } catch (error) {
    console.error("❌ Error cleaning DSL:", error);
    process.exit(1);
  }
}

cleanupEmptyDSL();

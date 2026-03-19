// scripts/dropProductNameIndex.js
const mongoose = require("mongoose");
require("dotenv").config();

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  try {
    await mongoose.connection.collection("products").dropIndex("name_1");
  } catch (e) {
    console.log("Index name_1 not found or already removed:", e.message);
  }
  console.log("Done.");
  process.exit(0);
})();

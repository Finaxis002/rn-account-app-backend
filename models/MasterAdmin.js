const mongoose = require("mongoose");

const masterAdminSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  role: { type: String, default: "master" }
}, { timestamps: true });

module.exports = mongoose.model("MasterAdmin", masterAdminSchema);

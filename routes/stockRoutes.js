// routes/stockRoutes.js
const express = require("express");
const router = express.Router();
const stockController = require("../controllers/stockController");
const auth = require("../middleware/auth");

// Set opening stock (manual entry)
router.post("/opening-stock", auth, stockController.setOpeningStock);

// Update closing stock (manual override if needed)
router.post("/closing-stock", auth, stockController.updateClosingStock);

// Auto-calculate closing stock for all products
router.post("/calculate-closing", auth, stockController.calculateClosingStock);

// Get stock summary for P&L statement
router.get("/summary", auth, stockController.getStockSummary);

// Get stock history for a product
router.get("/history", auth, stockController.getStockHistory);

module.exports = router;
// routes/transactions.js
const express = require("express");
const router = express.Router();
const verifyClientOrAdmin = require("../middleware/verifyClientOrAdmin");
const transactionsController = require("../controllers/transactionsController");

// Cross-module search endpoint
router.get("/search", verifyClientOrAdmin, transactionsController.searchTransactions);

// Main endpoint for all transactions
router.get("/all", verifyClientOrAdmin, transactionsController.getAllTransactions);

// Alternative aggregation endpoint
router.get("/all/aggregated", verifyClientOrAdmin, transactionsController.getAllTransactionsAggregated);

// Test endpoint
router.get("/test", verifyClientOrAdmin, transactionsController.testTransactions);

module.exports = router;

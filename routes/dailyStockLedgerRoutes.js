// routes/dailyStockLedgerRoutes.js
const express = require('express');
const router = express.Router();
const DailyStockLedgerController = require('../controllers/dailyStockLedgerController');
const verifyClientOrAdmin = require("../middleware/verifyClientOrAdmin");

// All routes require authentication
router.use(verifyClientOrAdmin);

// GET /api/daily-stock-ledger - Get stock ledger with date range
router.get('/', DailyStockLedgerController.getStockLedger);

// GET /api/daily-stock-ledger/summary - Get summary statistics
router.get('/summary', DailyStockLedgerController.getStockSummary);

// GET /api/daily-stock-ledger/today - Get today's stock
router.get('/today', DailyStockLedgerController.getTodayStock);

// GET /api/daily-stock-ledger/current-status - Get current stock across companies
router.get('/current-status', DailyStockLedgerController.getCurrentStockStatus);

// POST /api/daily-stock-ledger/fix-carried-forward - Manual fix
router.post('/fix-carried-forward', DailyStockLedgerController.fixCarryForward);

module.exports = router;
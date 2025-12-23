// routes/profitLossRoutes.js
const express = require('express');
const router = express.Router();
const profitLossController = require('../controllers/profitLossController');
const DailyStockLedgerService = require('../services/stockLedgerService');
const verifyClientOrAdmin = require("../middleware/verifyClientOrAdmin");

// ✅ FIXED: Handle duplicate key error gracefully
const ensureTodayLedger = async (req, res, next) => {
  try {
    const { companyId } = req.query;
    if (companyId === "all") {
      console.log('📊 Consolidated data requested for all companies');
      return next();
    }
    if (!companyId) {
      console.log('📊 Consolidated data requested for all allowed companies');
      return next();
    }
    try {
      await DailyStockLedgerService.ensureTodayLedgerExists(companyId, req.auth.clientId);
      console.log('✅ Today\'s ledger verified for company:', companyId);
    } catch (error) {
      if (error.code === 11000) {
        console.log('ℹ️ Today\'s ledger already exists (duplicate key), continuing...');
        return next();
      }
      throw error;
    }

    next();
  } catch (error) {
    console.error('❌ Ensure today ledger middleware error:', error);
    console.log('⚠️ Continuing request despite ledger initialization error');
    next();
  }
};

// ✅ ADD AUTHENTICATION MIDDLEWARE to all routes
router.use(verifyClientOrAdmin);

// Profit & Loss statement with detailed breakdown
router.get('/statement', ensureTodayLedger, profitLossController.getProfitLossStatement);

// Simplified P&L summary for dashboards
router.get('/summary', ensureTodayLedger, profitLossController.getProfitLossSummary);

module.exports = router;
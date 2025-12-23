const express = require("express");
const router = express.Router();
const ledgerController = require("../controllers/ledgerController");
const verifyClientOrAdmin = require("../middleware/verifyClientOrAdmin");

router.get("/payables", verifyClientOrAdmin, ledgerController.getPayablesLedger);
router.get("/vendor-payables", verifyClientOrAdmin, ledgerController.getVendorPayablesLedger);
router.get("/expense-payables", verifyClientOrAdmin, ledgerController.getExpensePayablesLedger);

module.exports = router;
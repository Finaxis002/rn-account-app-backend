const express = require("express");
const router = express.Router();
const verifyClientOrAdmin = require("../middleware/verifyClientOrAdmin");
const verifyMasterAdmin = require("../middleware/verifyMasterAdmin");
const salesController = require("../controllers/salesController");

// Create Sales Entry
router.post("/", verifyClientOrAdmin, salesController.createSalesEntry);

// Get All Sales Entries of Logged-in Client
router.get("/", verifyClientOrAdmin, salesController.getSalesEntries);
router.delete("/:id", verifyClientOrAdmin, salesController.deleteSalesEntry);
router.put("/:id", verifyClientOrAdmin, salesController.updateSalesEntry);
router.get("/by-client/:clientId", verifyMasterAdmin, salesController.getSalesEntriesByClient);
router.put("/", verifyClientOrAdmin, salesController.updateSalesEntry);
router.post("/send-credit-reminder", verifyClientOrAdmin, salesController.sendCreditReminder);
router.get("/:id", verifyClientOrAdmin, salesController.getSalesEntryById);

module.exports = router;

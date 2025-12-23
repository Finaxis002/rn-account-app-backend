const express = require("express");
const router = express.Router();
const receiptController = require("../controllers/receiptController");
const verifyClientOrAdmin = require("../middleware/verifyClientOrAdmin");
const verifyMasterAdmin = require("../middleware/verifyMasterAdmin");

router.post("/", verifyClientOrAdmin, receiptController.createReceipt);
router.get("/", verifyClientOrAdmin, receiptController.getReceipts);
router.put("/:id", verifyClientOrAdmin, receiptController.updateReceipt);
router.delete("/:id", verifyClientOrAdmin, receiptController.deleteReceipt);
router.get("/by-client/:clientId", verifyMasterAdmin, receiptController.getReceiptsByClient);

module.exports = router;

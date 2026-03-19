const express = require("express");
const router = express.Router();
const paymentController = require("../controllers/paymentController");
const verifyClientOrAdmin = require("../middleware/verifyClientOrAdmin");
const verifyMasterAdmin = require("../middleware/verifyMasterAdmin");

router.post("/", verifyClientOrAdmin, paymentController.createPayment);
router.get("/", verifyClientOrAdmin, paymentController.getPayments);
router.get("/:id", verifyClientOrAdmin, paymentController.getPaymentById);
router.put("/:id", verifyClientOrAdmin, paymentController.updatePayment);
router.delete("/:id", verifyClientOrAdmin, paymentController.deletePayment);
router.get("/by-client/:clientId", verifyMasterAdmin, paymentController.getPaymentsByClient);

module.exports = router;

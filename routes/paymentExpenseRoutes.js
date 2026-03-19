const express = require("express");
const router = express.Router();
const paymentExpenseController = require("../controllers/paymentExpenseController");
const verifyClientOrAdmin = require("../middleware/verifyClientOrAdmin");
const verifyMasterAdmin = require("../middleware/verifyMasterAdmin");

router.post("/", verifyClientOrAdmin, paymentExpenseController.createPaymentExpense);
router.get("/", verifyClientOrAdmin, paymentExpenseController.getPaymentExpenses);
router.put("/:id", verifyClientOrAdmin, paymentExpenseController.updatePaymentExpense);
router.delete("/:id", verifyClientOrAdmin, paymentExpenseController.deletePaymentExpense);

module.exports = router;
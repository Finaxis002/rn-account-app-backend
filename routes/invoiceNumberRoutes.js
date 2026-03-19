// routes/invoiceNumberRoutes.js
const express = require("express");
const router = express.Router();
const verifyClientOrAdmin = require("../middleware/verifyClientOrAdmin");
const { issueNumberCtrl } = require("../controllers/invoiceNumberController");

router.post("/issue-number", verifyClientOrAdmin, issueNumberCtrl);

module.exports = router;
// mount: app.use("/api/invoices", require("./routes/invoiceNumberRoutes"));

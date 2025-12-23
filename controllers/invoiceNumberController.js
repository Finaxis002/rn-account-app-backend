// controllers/invoiceNumberController.js
const mongoose = require("mongoose");
const { issueInvoiceNumber } = require("../services/invoiceIssuer");

exports.issueNumberCtrl = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const { companyId, date, series = "sales" } = req.body; // POST
    if (!companyId) return res.status(400).json({ message: "companyId is required" });

    let result;
    await session.withTransaction(async () => {
      const atDate = date ? new Date(date) : new Date();
      result = await issueInvoiceNumber(companyId, atDate, { session, series });
    });

    res.json(result); // { invoiceNumber, yearYY, seq }
  } catch (e) {
    res.status(500).json({ message: e.message });
  } finally {
    session.endSession();
  }
};

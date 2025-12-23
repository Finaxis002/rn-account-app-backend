// proforma-invoice-number.js
const ProformaEntry = require("../models/ProformaEntry");
const Company = require("../models/Company");
const InvoiceCounter = require("../models/InvoiceCounter");
const { deriveThreeLetterPrefix } = require("../utils/prefix");

function yearYYFromDate(atDate = new Date()) {
  return Number(String(atDate.getFullYear()).slice(-2));
}

function buildProformaNumber(prefix, yearYY, seq) {
  return `${prefix}P${String(yearYY).padStart(2, "0")}${String(seq).padStart(4, "0")}`;
}

async function getNextProformaInvoiceNumber(companyId, atDate, { session }) {
  if (!session) throw new Error("session is required");

  const company = await Company.findById(companyId).lean().session(session);
  if (!company) throw new Error("Company not found");

  const prefix = deriveThreeLetterPrefix(company.businessName || company.name || "");
  const yearYY = yearYYFromDate(atDate);

  // Try multiple times in the same txn to skip legacy collisions
  for (let tries = 0; tries < 20; tries++) {
    const counter = await InvoiceCounter.findOneAndUpdate(
      { company: companyId, yearYY },
      { $inc: { seq: 1 }, $setOnInsert: { company: companyId, yearYY } },
      { upsert: true, new: true, session }
    );

    const seq = counter.seq;
    const invoiceNumber = buildProformaNumber(prefix, yearYY, seq);

    // ⬇️ Skip if an older proforma already used this number
    const exists = await ProformaEntry.exists({
      company: companyId,
      invoiceYearYY: yearYY,
      invoiceNumber
    }).session(session);

    if (exists) continue;

    return { invoiceNumber, yearYY, seq, prefix };
  }

  throw new Error("Allocator: exhausted retries while skipping duplicates");
}

exports.issueProformaInvoiceNumber = (companyId, atDate = new Date(), { session } = {}) =>
  getNextProformaInvoiceNumber(companyId, atDate, { session });
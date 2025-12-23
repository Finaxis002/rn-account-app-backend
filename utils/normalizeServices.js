// utils/normalizeServices.js
const Service = require("../models/Service");

module.exports = async function normalizeServices(rows, clientId) {
  const items = [];
  let computedTotal = 0;
  let computedTax = 0;

  for (const r of rows || []) {
    const id = r.service;
    if (!id) continue;

    const svc = await Service.findOne({
      _id: id,
      createdByClient: clientId
    }).select("_id gstPercentage sac").lean();
    
    if (!svc) continue;

    const amount = Number(r.amount) || 0;
    if (amount <= 0) continue; // Skip services with non-positive amount

    const description = r.description || "";

    // Get GST percentage from the request or use service default
    const gstPercentage = Number(r.gstPercentage ?? svc.gstPercentage ?? 18);
    
    // Calculate tax and total for this line
    const lineTax = +(amount * gstPercentage / 100).toFixed(2);
    const lineTotal = +(amount + lineTax).toFixed(2);

    items.push({
      service: svc._id,
      amount,
      description,
      gstPercentage, // NEW: Save GST percentage
      lineTax,       // NEW: Save calculated tax
      lineTotal,     // NEW: Save line total (amount + tax)
      sac: svc.sac
    });

    computedTotal += amount;
    computedTax += lineTax;
  }

  return { items, computedTotal, computedTax };
};
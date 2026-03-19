// utils/normalizeServices.js
const Service = require("../models/Service");
const AdditionalService = require("../models/AdditionalService");

module.exports = async function normalizeServices(rows, clientId) {
  const items = [];
  let computedTotal = 0;
  let computedTax = 0;

  for (const r of rows || []) {
    const id = r.service;
    if (!id) continue;

    const isAdditionalService = !!r.isAdditionalService;

    let svc = null;
    if (isAdditionalService) {
      svc = await AdditionalService.findOne({
        _id: id,
        createdByClient: clientId,
      })
        .select(
          "_id serviceName serviceCost additionalCharges totalAmount description",
        )
        .lean();
    } else {
      svc = await Service.findOne({
        _id: id,
        createdByClient: clientId,
      })
        .select("_id gstPercentage sac")
        .lean();
    }

    if (!svc) continue;

    const baseAmountFromAdditional = isAdditionalService
      ? Number(
          r.amount ??
            r.fixedCharges ??
            svc.totalAmount ??
            Number(svc.serviceCost || 0) + Number(svc.additionalCharges || 0),
        ) || 0
      : 0;

    const fixedCharges =
      baseAmountFromAdditional ||
      Number(r.fixedCharges ?? r.pricePerUnit ?? 0) ||
      0;
    const variableQty = Number(r.variableQty ?? 0) || 0;
    const variableUnit = String(r.variableUnit || r.unitType || "Km");
    const variableRate = Number(r.variableRate ?? 0) || 0;
    const computedVariableTotal = Number(
      (variableQty * variableRate).toFixed(2),
    );
    const variableCharges =
      r.variableCharges !== undefined && r.variableCharges !== null
        ? Number(r.variableCharges) || 0
        : computedVariableTotal;
    const requestedAmount = Number(r.amount);
    const amount =
      Number.isFinite(requestedAmount) && requestedAmount > 0
        ? requestedAmount
        : Number((fixedCharges + variableCharges).toFixed(2));
    if (amount <= 0) continue; // Skip services with non-positive amount

    const description =
      r.description || (isAdditionalService ? svc.description || "" : "");
    // Respect explicit null to clear dates
    const rawTravelDate = r.travelDate;
    const rawStartDate = r.serviceStartDate;

    // Get GST percentage from the request or use service default
    const gstPercentage = Number(
      r.gstPercentage ?? (!isAdditionalService ? svc.gstPercentage : 0) ?? 0,
    );
    const lineTax = +((amount * gstPercentage) / 100).toFixed(2);
    const lineTotal = +(amount + lineTax).toFixed(2);

    items.push({
      service: svc._id,
      serviceModel: isAdditionalService ? "AdditionalService" : "Service",
      isAdditionalService,
      amount, // ✅ discounted amount
      serviceName: isAdditionalService
        ? r.serviceName || svc.serviceName || ""
        : r.serviceName || "",
      description,
      gstPercentage, // NEW: Save GST percentage
      lineTax, // NEW: Save calculated tax
      lineTotal, // NEW: Save line total (amount + tax)
      sac: isAdditionalService ? undefined : svc.sac,
      quantity: Number(r.quantity) || 1,
      unitType: r.unitType || "Hours",
      pricePerUnit: Number(r.pricePerUnit ?? fixedCharges) || 0,
      discountType: r.discountType || "fixed",
      discountValue: Number(r.discountValue) || 0,
      serviceStartDate:
        rawStartDate !== undefined
          ? rawStartDate
            ? new Date(rawStartDate)
            : null
          : rawTravelDate
            ? new Date(rawTravelDate)
            : undefined,
      serviceDueDate:
        r.serviceDueDate !== undefined
          ? r.serviceDueDate
            ? new Date(r.serviceDueDate)
            : null
          : undefined,
      travelDate:
        rawTravelDate !== undefined
          ? rawTravelDate
            ? new Date(rawTravelDate)
            : null
          : rawStartDate
            ? new Date(rawStartDate)
            : undefined,
      travelFrom: r.travelFrom || "",
      travelTo: r.travelTo || "",
      vehicleType: r.vehicleType || "",
      vehicleNumber: r.vehicleNumber || "",
      fixedCharges,
      variableQty,
      variableUnit,
      variableRate,
      variableCharges,
    });

    computedTotal += amount;
    computedTax += lineTax;
  }

  return { items, computedTotal, computedTax };
};

// utils/normalizePurchaseServices.js
const Service = require("../models/Service");

module.exports = async (rawServices = [], clientId) => {
  if (!Array.isArray(rawServices)) {
    throw new Error("Services must be an array");
  }

  const items = [];
  let computedTotal = 0;

  for (const item of rawServices) {
    // Check both service and serviceName for compatibility
    const serviceId = item.service || item.serviceName;
    
    if (!serviceId) {
      throw new Error("Service ID is required for each service item");
    }

    const service = await Service.findOne({ 
      _id: serviceId, 
      createdByClient: clientId 
    });
    
    if (!service) {
      throw new Error(`Service not found or unauthorized: ${serviceId}`);
    }

    const fixedCharges = Number(item.fixedCharges ?? item.pricePerUnit ?? 0) || 0;
    const variableQty = Number(item.variableQty ?? 0) || 0;
    const variableUnit = String(item.variableUnit || item.unitType || "Km");
    const variableRate = Number(item.variableRate ?? 0) || 0;
    const computedVariableTotal = Number((variableQty * variableRate).toFixed(2));
    const variableCharges =
      item.variableCharges !== undefined && item.variableCharges !== null
        ? Number(item.variableCharges) || 0
        : computedVariableTotal;
    const requestedAmount = Number(item.amount ?? service.amount ?? 0);
    const amount =
      Number.isFinite(requestedAmount) && requestedAmount > 0
        ? requestedAmount
        : Number((fixedCharges + variableCharges).toFixed(2));
    if (isNaN(amount)) throw new Error("Invalid amount");
    const travelDate = item.travelDate || item.serviceStartDate || undefined;
    // Get GST percentage from the request or use service default
    const gstPercentage = Number(item.gstPercentage ?? service.gstPercentage ?? 18);

    // Calculate tax and total for this line
    const lineTax = +(amount * gstPercentage / 100).toFixed(2);
    const lineTotal = +(amount + lineTax).toFixed(2);

    items.push({
      serviceName: service._id,
      amount,
      description: item.description || service.description,
      quantity: Number(item.quantity) || 1,
      unitType: item.unitType || "Hours",
      pricePerUnit: Number(item.pricePerUnit ?? fixedCharges) || 0,
      discountType: item.discountType || "fixed",
      discountValue: Number(item.discountValue) || 0,
      serviceStartDate: travelDate ? new Date(travelDate) : undefined,
      serviceDueDate: item.serviceDueDate ? new Date(item.serviceDueDate) : undefined,
      travelDate: travelDate ? new Date(travelDate) : undefined,
      travelFrom: item.travelFrom || "",
      travelTo: item.travelTo || "",
      vehicleType: item.vehicleType || "",
      vehicleNumber: item.vehicleNumber || "",
      fixedCharges,
      variableQty,
      variableUnit,
      variableRate,
      variableCharges,
      gstPercentage, // NEW: Save GST percentage
      lineTax,       // NEW: Save calculated tax
      lineTotal      // NEW: Save line total (amount + tax)
    });

    computedTotal += amount;
  }

  return { items, computedTotal };
};

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

    const amount = Number(item.amount ?? service.amount ?? 0);
    if (isNaN(amount)) throw new Error("Invalid amount");
    // Get GST percentage from the request or use service default
    const gstPercentage = Number(item.gstPercentage ?? service.gstPercentage ?? 18);

    // Calculate tax and total for this line
    const lineTax = +(amount * gstPercentage / 100).toFixed(2);
    const lineTotal = +(amount + lineTax).toFixed(2);

    items.push({
      serviceName: service._id,
      amount,
      description: item.description || service.description,
      gstPercentage, // NEW: Save GST percentage
      lineTax,       // NEW: Save calculated tax
      lineTotal      // NEW: Save line total (amount + tax)
    });

    computedTotal += amount;
  }

  return { items, computedTotal };
};
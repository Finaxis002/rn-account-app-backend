// utils/normalizeProducts.js
const Product = require("../models/Product");
const Unit = require("../models/Unit");
const { deleteFromCache } = require("../RedisCache");

// Map to normalize unitType case
const unitTypeMap = {
  "kg": "Kg",
  "litre": "Litre",
  "piece": "Piece",
  "box": "Box",
  "meter": "Meter",
  "dozen": "Dozen",
  "pack": "Pack",
  "other": "Other"
};

const normalizeUnitType = (unitType) => {
  if (!unitType) return "Piece";
  const lower = unitType.toLowerCase();
  return unitTypeMap[lower] || "Other"; // custom units become "Other"
};

module.exports = async (rawProducts = [], clientId, userId) => {
  if (!Array.isArray(rawProducts)) {
    throw new Error("Products must be an array");
  }

  // Get existing unit names for this client (lowercase for comparison)
  const existingUnits = await Unit.find({ createdByClient: clientId }).select('name').lean();
  const existingUnitNames = new Set(existingUnits.map(u => u.name.toLowerCase()));

  const items = [];
  let computedTotal = 0;
  let computedTax = 0;

  for (const item of rawProducts) {
    const product = await Product.findOne({
      _id: item.product,
      createdByClient: clientId
    });

    if (!product) throw new Error(`Product not found or unauthorized: ${item.product}`);

    const quantity = Number(item.quantity ?? 1);
    if (isNaN(quantity)) throw new Error("Invalid quantity");

    const pricePerUnit = Number(item.pricePerUnit ?? product.price);
    if (isNaN(pricePerUnit)) throw new Error("Invalid price");

    const amount = Number(item.amount ?? quantity * pricePerUnit);
    if (amount < 0) continue; // Skip products with negative amount

    // Get GST percentage from the request or use product default
    const gstPercentage = Number(item.gstPercentage ?? product.gstPercentage ?? 18);

    // Calculate tax and total for this line
    const lineTax = +(amount * gstPercentage / 100).toFixed(2);
    const lineTotal = +(amount + lineTax).toFixed(2);

    // Handle the 'Other' unitType - extract otherUnit from the request
    let rawUnitType = item.unitType || product.unitType || "Piece";
    let otherUnit = undefined;

    const unitType = normalizeUnitType(rawUnitType);

    if (unitType === "Other") {
      if (rawUnitType === "Other") {
        // User selected "Other" and typed custom unit
        otherUnit = item.otherUnit;
        if (item.otherUnit) {
          const customUnitLower = item.otherUnit.trim().toLowerCase();
          if (!existingUnitNames.has(customUnitLower)) {
            // Create new unit
            await Unit.create({
              name: customUnitLower,
              createdByClient: clientId,
              createdByUser: userId,
            });
            existingUnitNames.add(customUnitLower);
            // Invalidate cache
            const unitsCacheKey = `units:client:${clientId}`;
            await deleteFromCache(unitsCacheKey);
          }
        }
      } else {
        // Custom unit from product.unit
        otherUnit = rawUnitType;
      }
    }

    items.push({
      product: product._id,
      quantity,
      pricePerUnit,
      unitType,
      otherUnit, // ✅ This was missing - now included
      amount,
      gstPercentage,
      lineTax,
      lineTotal,
      hsn: product.hsn
    });

    computedTotal += amount;
    computedTax += lineTax;
  }

  return { items, computedTotal, computedTax };
};
// utils/normalizePurchaseProducts.js
const Product = require("../models/Product");
const Unit = require("../models/Unit");


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

  // Merge duplicates by product, summing quantities
  const productMap = new Map();
  for (const item of rawProducts) {
    const productId = item.product;
    const qty = Number(item.quantity ?? 1);
    if (!productId || !Number.isFinite(qty) || qty <= 0) {
      throw new Error("Invalid item");
    }
    if (productMap.has(productId)) {
      productMap.get(productId).quantity += qty;
    } else {
      productMap.set(productId, {
        product: productId,
        quantity: qty,
        pricePerUnit: Number(item.pricePerUnit ?? 0),
        unitType: item.unitType,
        otherUnit: item.otherUnit,
        gstPercentage: item.gstPercentage,
        amount: Number(item.amount ?? 0)
      });
    }
  }

  const items = [];
  let computedTotal = 0;

  for (const [productId, item] of productMap.entries()) {
    const product = await Product.findOne({ _id: productId, createdByClient: clientId });
    if (!product) throw new Error(`Product not found or unauthorized: ${productId}`);

    const quantity = item.quantity;
    const pricePerUnit = item.pricePerUnit || product.costPrice;
    if (isNaN(pricePerUnit)) throw new Error("Invalid price");

    const amount = item.amount || quantity * pricePerUnit;

     // Get GST percentage from the request or use product default
    const gstPercentage = Number(item.gstPercentage ?? product.gstPercentage ?? 18);

    // Calculate tax and total for this line
    const lineTax = +(amount * gstPercentage / 100).toFixed(2);
    const lineTotal = +(amount + lineTax).toFixed(2);

    // Handle the 'Other' unitType and ensure 'otherUnit' exists
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
      otherUnit,
      amount,
       gstPercentage, // NEW: Save GST percentage
      lineTax,       // NEW: Save calculated tax
      lineTotal      // NEW: Save line total (amount + tax)
    });

    computedTotal += amount;
  }

  return { items, computedTotal };
};
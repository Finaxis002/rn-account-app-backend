// const Product = require("../models/Product");

// exports.normalizeItems = async (rawItems = [], clientId) => {
//   if (!Array.isArray(rawItems) || rawItems.length === 0) {
//     throw new Error("At least one item is required.");
//   }
//   const items = [];
//   let computedTotal = 0;

//   for (const it of rawItems) {
//     const prod = await Product.findOne({ _id: it.product, createdByClient: clientId });
//     if (!prod) throw new Error("Product not found or unauthorized");

//     const quantity = Number(it.quantity) || 0;
//     const pricePerUnit = Number(it.pricePerUnit) || 0;
//     const amount = Number(it.amount ?? quantity * pricePerUnit);

//     items.push({
//       product: prod._id,
//       quantity,
//       pricePerUnit,
//       unitType: it.unitType || "Piece",
//       amount,
//     });

//     computedTotal += amount;
//   }

//   return { items, computedTotal };
// };








// utils/normalizeItems.js
const Product = require("../models/Product");
const Service = require("../models/Service");

/**
 * Normalize mixed product/service items for a sales entry.
 * - Validates ownership (createdByClient === clientId)
 * - Computes amount if not provided
 * - Flexible input keys: product/service OR { type, id }
 */
exports.normalizeItems = async (rawItems = [], clientId) => {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw new Error("At least one item is required.");
  }

  const items = [];
  let computedTotal = 0;

  for (const it of rawItems) {
    // --- determine kind & id
    let kind = null;
    let refId = null;

    if (it.product) {
      kind = "product";
      refId = it.product;
    } else if (it.service) {
      kind = "service";
      refId = it.service;
    } else if (it.type && it.id) {
      const t = String(it.type).toLowerCase();
      if (t !== "product" && t !== "service") throw new Error("Invalid item type");
      kind = t;
      refId = it.id;
    } else {
      throw new Error("Each item must specify a product or service id.");
    }

    // --- fetch doc with ownership check
    let doc;
    if (kind === "product") {
      doc = await Product.findOne({ _id: refId, createdByClient: clientId });
      if (!doc) throw new Error("Product not found or unauthorized");
    } else {
      doc = await Service.findOne({ _id: refId, createdByClient: clientId });
      if (!doc) throw new Error("Service not found or unauthorized");
    }

    // --- numbers & defaults
    const quantity = Number(it.quantity ?? 1);
    if (!Number.isFinite(quantity) || quantity < 0) {
      throw new Error("Quantity must be a non-negative number.");
    }

    // For services: if no pricePerUnit provided, fallback to DB service.amount
    let pricePerUnit = Number(
      it.pricePerUnit ??
      (kind === "service" ? doc.amount : 0)
    );
    if (!Number.isFinite(pricePerUnit) || pricePerUnit < 0) {
      pricePerUnit = 0;
    }

    // amount = explicit amount OR computed
    let amount = Number(it.amount ?? quantity * pricePerUnit);
    if (!Number.isFinite(amount) || amount < 0) amount = 0;

    const unitType =
      it.unitType ||
      (kind === "product" ? "Piece" : "service"); // simple default

    // --- push normalized line
    items.push({
      ...(kind === "product" ? { product: doc._id } : { service: doc._id }),
      quantity,
      pricePerUnit,
      unitType,
      amount,
    });

    computedTotal += amount;
  }

  // Round to 2 decimals to avoid float noise
  computedTotal = Math.round(computedTotal * 100) / 100;

  return { items, computedTotal };
};

// utils/ensurePartyAndProduct.js
const Party = require("../models/Party");
const Product = require("../models/Product");
const Vendor = require("../models/Vendor");

exports.ensurePartyAndProduct = async (partyName, productName, clientId) => {
  // Ensure Party
  let party = await Party.findOne({ name: partyName, createdByClient: clientId });
  if (!party) {
    party = new Party({ name: partyName, createdByClient: clientId });
    await party.save();
  }

  // Ensure Product
  let product = await Product.findOne({ name: productName, createdByClient: clientId });
  if (!product) {
    product = new Product({ name: productName, createdByClient: clientId });
    await product.save();
  }

  return { party, product };
};


exports.ensureVendorAndProduct = async (vendorName, productName, clientId) => {
  let vendor = null;

  if (vendorName) {
    vendor = await Vendor.findOne({ vendorName: vendorName.toLowerCase(), createdByClient: clientId });
    if (!vendor) {
      vendor = new Vendor({ vendorName, createdByClient: clientId });
      await vendor.save();
    }
  }

  let product = null;

  if (productName) {
    product = await Product.findOne({ name: productName, createdByClient: clientId });
    if (!product) {
      product = new Product({ name: productName, createdByClient: clientId });
      await product.save();
    }
  }

  return { vendor, product };
};


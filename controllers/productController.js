const Product = require("../models/Product");
const Unit = require("../models/Unit");
const { createNotification } = require("./notificationController");
const { resolveActor, findAdminUser } = require("../utils/actorUtils");
const XLSX = require("xlsx");
const DailyStockLedgerService = require("../services/stockLedgerService");
const StockBatch = require("../models/StockBatch");

// Build message text per action
function buildProductNotificationMessage(action, { actorName, productName }) {
  const pName = productName || "Unknown Product";
  switch (action) {
    case "create":
      return `New product created by ${actorName}: ${pName}`;
    case "update":
      return `Product updated by ${actorName}: ${pName}`;
    case "delete":
      return `Product deleted by ${actorName}: ${pName}`;
    default:
      return `Product ${action} by ${actorName}: ${pName}`;
  }
}

// Unified notifier for product module
async function notifyAdminOnProductAction({ req, action, productName, entryId }) {
  const actor = await resolveActor(req);
  const adminUser = await findAdminUser();
  if (!adminUser) {
    console.warn("notifyAdminOnProductAction: no admin user found");
    return;
  }

  const message = buildProductNotificationMessage(action, {
    actorName: actor.name,
    productName,
  });

  await createNotification(
    message,
    adminUser._id, // recipient (admin)
    actor.id, // actor id (user OR client)
    action, // "create" | "update" | "delete"
    "product", // entry type / category
    entryId, // product id
    req.auth.clientId
  );
}


/**
 * Create initial stock batch for product creation/import
 */
async function createInitialStockBatch(product, quantity, costPrice) {
  try {
    const stockBatch = new StockBatch({
      product: product._id,
      companyId: product.company,
      clientId: product.createdByClient,
      purchaseDate: new Date(),
      costPrice: costPrice,
      initialQuantity: quantity,
      remainingQuantity: quantity,
      status: "active",
      isInitialStock: true // Flag to identify initial stock batches
    });

    await stockBatch.save();
    console.log(`✅ Created initial stock batch for ${product.name}: ${quantity} units`);
    return stockBatch;
  } catch (error) {
    console.error('Error creating initial stock batch:', error);
    throw error;
  }
}


/**
 * Update stock batch for manual stock adjustments
 */
async function updateStockBatchForManualAdjustment(product, oldStocks, newStocks, costPrice) {
  try {
    const stockDifference = newStocks - oldStocks;
    
    if (stockDifference === 0) return;

    if (stockDifference > 0) {
      // Stock increased - create new stock batch
      const stockBatch = new StockBatch({
        product: product._id,
        companyId: product.company,
        clientId: product.createdByClient,
        purchaseDate: new Date(),
        costPrice: costPrice,
        initialQuantity: stockDifference,
        remainingQuantity: stockDifference,
        status: "active",
        isManualAdjustment: true
      });
      await stockBatch.save();
      console.log(`✅ Created adjustment stock batch for ${product.name}: +${stockDifference} units`);
    } else {
      // Stock decreased - consume from existing batches (FIFO)
      const quantityToReduce = Math.abs(stockDifference);
      await consumeFromStockBatches(product._id, quantityToReduce);
      console.log(`✅ Reduced stock from batches for ${product.name}: -${quantityToReduce} units`);
    }
  } catch (error) {
    console.error('Error updating stock batch for manual adjustment:', error);
    throw error;
  }
}

/**
 * Consume stock from existing batches (FIFO)
 */
async function consumeFromStockBatches(productId, quantityToReduce) {
  const batches = await StockBatch.find({
    product: productId,
    status: "active",
    remainingQuantity: { $gt: 0 }
  }).sort({ purchaseDate: 1 }); // FIFO: oldest first

  let remainingQty = quantityToReduce;
  
  for (const batch of batches) {
    if (remainingQty <= 0) break;

    const consumeQty = Math.min(batch.remainingQuantity, remainingQty);
    batch.remainingQuantity -= consumeQty;
    remainingQty -= consumeQty;

    if (batch.remainingQuantity === 0) {
      batch.status = "consumed";
    }

    await batch.save();
  }

  if (remainingQty > 0) {
    console.warn(`⚠️ Could not fully reduce ${quantityToReduce} units from batches. Remaining: ${remainingQty}`);
  }
}

// POST /api/products
exports.createProduct = async (req, res) => {
  try {
    const { name, stocks, unit, hsn, sellingPrice, costPrice, company } = req.body;

    if (!company || company.trim() === "") {
      return res.status(400).json({ message: "Company is required" });
    }

    // console.log('Creating product:', { name, stocks, unit, clientId: req.auth.clientId });

    // Check if product already exists for this client
    const existingProduct = await Product.findOne({
      name: name.trim(),
      createdByClient: req.auth.clientId,
      company: company
    });

    if (existingProduct) {
      console.log('Product already exists:', existingProduct);
      return res.status(400).json({ message: "Product already exists for this client" });
    }

    let normalizedUnit = null;
    if (unit && typeof unit === 'string' && unit.trim()) {
      normalizedUnit = unit.trim().toLowerCase();

      // Check if unit exists for this client (case-insensitive)
      let existingUnit = await Unit.findOne({
        createdByClient: req.auth.clientId,
        name: { $regex: new RegExp(`^${normalizedUnit}$`, 'i') }
      });

      if (!existingUnit) {
        // Create new unit
        existingUnit = await Unit.create({
          name: normalizedUnit,
          createdByClient: req.auth.clientId,
          createdByUser: req.auth.userId,
        });
      }
    }

    // ✅ ALWAYS use tenant from token and also track the actor
    try {
      const product = await Product.create({
        name: name.trim(),
        stocks,
        unit: normalizedUnit,
        hsn,
        sellingPrice,
        costPrice,
        createdByClient: req.auth.clientId, // tenant id
        createdByUser: req.auth.userId,   // who created it
        company: company,
      });

      // Populate company before returning
      await product.populate('company');

      // ⬇️ UPDATE DAILY STOCK LEDGER ⬇️
      if (stocks > 0 && costPrice > 0) {
        await DailyStockLedgerService.handleProductCreation({
          companyId: company,
          clientId: req.auth.clientId,
          stocks: stocks,
          costPrice: costPrice
        });

         await createInitialStockBatch(product, stocks, costPrice);
      }

      // console.log('Product created successfully:', product);

      // Notify admin after product created
      await notifyAdminOnProductAction({
        req,
        action: "create",
        productName: product.name,
        entryId: product._id,
      });

      return res.status(201).json({ message: "Product created", product });
    } catch (productErr) {
      console.error('Error creating product:', productErr);
      if (productErr.code === 11000) {
        // because of compound unique {createdByClient, name}
        return res.status(400).json({ message: "Product already exists for this client" });
      }
      return res.status(500).json({ message: "Server error", error: productErr.message });
    }
  } catch (err) {
    console.error('Error creating unit or other:', err);
    if (err.code === 11000) {
      // Unit duplicate error
      return res.status(400).json({ message: "Unit already exists for this client" });
    }
    return res.status(500).json({ message: "Server error", error: err.message });
  }
};

// GET /api/products
exports.getProducts = async (req, res) => {
 try {

  const requestedClientId = req.query.clientId || req.auth.clientId;
 const { company } = req.query; 
 const isPrivileged = ["master", "admin"].includes(req.auth.role);
 if (!isPrivileged && requestedClientId !== req.auth.clientId) {
 return res.status(403).json({ message: "Not authorized to view this client's data." });
 }
const filter = { createdByClient: requestedClientId };
 if (company) {
 filter.company = company;
 }
 const products = await Product.find(filter)
.populate('company') 
 .sort({ createdAt: -1 })
 .lean();
 return res.json(products);
 } catch (err) {
 return res.status(500).json({ message: "Server error", error: err.message });
 }
};
// PATCH /api/products/:id
exports.updateProducts = async (req, res) => {
  try {
    const productId = req.params.id;
    const { name, stocks, unit, hsn, sellingPrice, costPrice, company } = req.body;

    if (company !== undefined && (!company || company.trim() === "")) {
      return res.status(400).json({ message: "Company is required" });
    }

    const product = await Product.findById(productId);
    if (!product) return res.status(404).json({ message: "Product not found" });

    // ✅ authorize by tenant (optionally allow privileged roles)
    const sameTenant = product.createdByClient.toString() === req.auth.clientId;
    const privileged = ["master", "client", "admin"].includes(req.auth.role);
    if (!sameTenant && !privileged) {
      return res.status(403).json({ message: "Not authorized to update this product" });
    }

    const oldStocks = product.stocks;
    const oldCostPrice = product.costPrice;

    if (name) product.name = name;
    if (typeof stocks === "number" && stocks >= 0) product.stocks = stocks;
    if (hsn !== undefined) product.hsn = hsn;
    if (typeof sellingPrice === "number" && sellingPrice >= 0) product.sellingPrice = sellingPrice;
    if (typeof costPrice === "number" && costPrice >= 0) product.costPrice = costPrice;
    if (company !== undefined) product.company = company;

    if (unit !== undefined) {
      let normalizedUnit = null;
      if (unit && typeof unit === 'string' && unit.trim()) {
        normalizedUnit = unit.trim().toLowerCase();

        // Check if unit exists for this client (case-insensitive)
        let existingUnit = await Unit.findOne({
          createdByClient: req.auth.clientId,
          name: { $regex: new RegExp(`^${normalizedUnit}$`, 'i') }
        });

        if (!existingUnit) {
          // Create new unit
          existingUnit = await Unit.create({
            name: normalizedUnit,
            createdByClient: req.auth.clientId,
            createdByUser: req.auth.userId,
          });
        }
      }
      product.unit = normalizedUnit;
    }

    // Ensure required fields are set for legacy products
    if (!product.createdByUser) {
      product.createdByUser = req.auth.userId;
    }
    if (!product.createdByClient) {
      product.createdByClient = req.auth.clientId;
    }

    await product.save();

  
    // Populate company before returning
    await product.populate('company');
    const currentCostPrice = costPrice || oldCostPrice;
    if (stocks !== undefined && stocks !== oldStocks && currentCostPrice > 0) {
      await DailyStockLedgerService.handleProductUpdate({
        companyId: company || product.company,
        clientId: req.auth.clientId,
        oldStocks: oldStocks,
        newStocks: stocks,
        costPrice: currentCostPrice
      });


       await updateStockBatchForManualAdjustment(product, oldStocks, stocks, currentCostPrice);
    }
    // Notify admin after product updated
    await notifyAdminOnProductAction({
      req,
      action: "update",
      productName: product.name,
      entryId: product._id,
    });

    return res.status(200).json({ message: "Product updated", product });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(400).json({ message: "Duplicate product details" });
    }
    return res.status(500).json({ message: "Server error", error: err.message });
  }
};

// DELETE /api/products/:id
exports.deleteProducts = async (req, res) => {
  try {
    const productId = req.params.id;

    const product = await Product.findById(productId);
    if (!product) return res.status(404).json({ message: "Product not found" });

    // ✅ authorize by tenant (optionally allow privileged roles)
    const sameTenant = product.createdByClient.toString() === req.auth.clientId;
    const privileged = ["master", "client", "admin"].includes(req.auth.role);
    if (!sameTenant && !privileged) {
      return res.status(403).json({ message: "Not authorized to delete this product" });
    }

    // ⬇️ UPDATE DAILY STOCK LEDGER ⬇️
   if (product.stocks > 0 && product.costPrice > 0) {
  await DailyStockLedgerService.handleProductDeletion({
    companyId: product.company,
    clientId: req.auth.clientId,
    stocks: product.stocks,
    costPrice: product.costPrice
  });
}

// ✅ NEW: DELETE STOCK BATCHES FOR THIS PRODUCT
    await StockBatch.deleteMany({
      product: productId,
      clientId: req.auth.clientId
    });
    console.log(`✅ Deleted stock batches for product: ${product.name}`);

    // Notify admin before deleting
    await notifyAdminOnProductAction({
      req,
      action: "delete",
      productName: product.name,
      entryId: product._id,
    });

    await product.deleteOne();
    return res.status(200).json({ message: "Product deleted successfully" });
  } catch (err) {
    return res.status(500).json({ message: "Server error", error: err.message });
  }
};

// DELETE /api/products/bulk-delete
exports.bulkDeleteProducts = async (req, res) => {
  try {
    const { productIds } = req.body;

    if (!Array.isArray(productIds) || productIds.length === 0) {
      return res.status(400).json({ message: "Product IDs array is required" });
    }

    // ✅ authorize by tenant - fetch only this tenant's products
    const products = await Product.find({
      _id: { $in: productIds },
      createdByClient: req.auth.clientId,
    });

    // Check if all requested products belong to this tenant
    if (products.length !== productIds.length) {
      return res.status(403).json({ message: "Some products not found or not authorized to delete" });
    }

     // ✅ NEW: DELETE STOCK BATCHES FOR ALL PRODUCTS
    await StockBatch.deleteMany({
      product: { $in: productIds },
      clientId: req.auth.clientId
    });
    console.log(`✅ Deleted stock batches for ${productIds.length} products`);

    // Delete the products
    const result = await Product.deleteMany({
      _id: { $in: productIds },
      createdByClient: req.auth.clientId,
    });

    return res.status(200).json({
      message: `${result.deletedCount} products deleted successfully`,
      deletedCount: result.deletedCount
    });
  } catch (err) {
    return res.status(500).json({ message: "Server error", error: err.message });
  }
};

// POST /api/products/update-stock-bulk
exports.updateStockBulk = async (req, res) => {
  try {
    const { items = [], action = "decrease" } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: "Items array is required." });
    }

    // merge duplicate lines and normalize keys
    const qtyById = new Map();
    for (const raw of items) {
      const productId = String(raw.product || raw.productId || "");
      const qty = Number(raw.quantity);
      if (!productId || !Number.isFinite(qty) || qty <= 0) {
        return res.status(400).json({ message: "Each item needs product id and positive quantity." });
      }
      qtyById.set(productId, (qtyById.get(productId) || 0) + qty);
    }

    // ✅ fetch only this tenant's products
    const ids = [...qtyById.keys()];
    const products = await Product.find({
      _id: { $in: ids },
      createdByClient: req.auth.clientId,
    });

    // ensure all requested ids belong to this tenant
    const productMap = new Map(products.map(p => [String(p._id), p]));
    for (const id of ids) {
      if (!productMap.has(id)) {
        return res.status(404).json({ message: `Product not found or unauthorized: ${id}` });
      }
    }

    // compute new stocks (allow negatives for sales)
    const sign = action === "increase" ? 1 : -1;
    for (const [id, qty] of qtyById.entries()) {
      const p = productMap.get(id);
      const current = Number(p.stocks || 0);
      const next = current + sign * qty;
      p.stocks = next;
    }

    // persist with bulkWrite
    const ops = products.map(p => ({
      updateOne: { filter: { _id: p._id }, update: { $set: { stocks: p.stocks } } },
    }));
    await Product.bulkWrite(ops, { ordered: true });

    return res.json({
      message: "Stock updated",
      updated: products.map(p => ({ id: p._id, name: p.name, stocks: p.stocks })),
    });
  } catch (err) {
    return res.status(500).json({ message: "Server error", error: err.message });
  }
};


exports.importProductsFromFile = async (req, res) => {
  const file = req.file;
  const { company } = req.body;

  if (!file) {
    return res.status(400).json({ message: "No file uploaded." });
  }

  if (!company) {
    return res.status(400).json({ message: "Company is required for import." });
  }

  try {
    const workbook = XLSX.read(file.buffer, { type: "buffer" });
    const worksheet = workbook.Sheets[workbook.SheetNames[0]];
    const jsonData = XLSX.utils.sheet_to_json(worksheet);

    // Validate required fields
    const productsToCreate = [];
    const errors = [];

    for (const [index, item] of jsonData.entries()) {
      const rowNumber = index + 2; // +2 because header is row 1

      if (!item["Item Name"]) {
        errors.push(`Row ${rowNumber}: "Item Name" is required`);
        continue;
      }

      // Check for duplicates before processing
      const existingProduct = await Product.findOne({
        name: item["Item Name"].toString().trim(),
        createdByClient: req.auth.clientId,
        company: company
      });

      if (existingProduct) {
        errors.push(`Row ${rowNumber}: Product "${item["Item Name"]}" already exists`);
        continue;
      }

      // Handle unit creation/lookup
      let normalizedUnit = null;
      if (item["Unit"] && item["Unit"].toString().trim()) {
        normalizedUnit = item["Unit"].toString().trim().toLowerCase();

        let existingUnit = await Unit.findOne({
          createdByClient: req.auth.clientId,
          name: { $regex: new RegExp(`^${normalizedUnit}$`, 'i') }
        });

        if (!existingUnit) {
          existingUnit = await Unit.create({
            name: normalizedUnit,
            createdByClient: req.auth.clientId,
            createdByUser: req.auth.userId,
          });
        }
      }

      productsToCreate.push({
        name: item["Item Name"].toString().trim(),
        stocks: Number(item["Stock"]) || 0,
        unit: normalizedUnit,
        hsn: item["HSN"] ? item["HSN"].toString() : "",
        sellingPrice: Number(item["Selling Price"]) || 0,
        costPrice: Number(item["Cost Price"]) || 0,
        company: company,
        createdByClient: req.auth.clientId,
        createdByUser: req.auth.userId,
      });
    }

    if (errors.length > 0) {
      return res.status(400).json({
        message: "Validation errors found",
        errors
      });
    }

    if (productsToCreate.length === 0) {
      return res.status(400).json({ message: "No valid products to import" });
    }

    // Use bulk insert for better performance
    const createdProducts = await Product.insertMany(productsToCreate);

    for (const product of createdProducts) {
      if (product.stocks > 0 && product.costPrice > 0) {
        await DailyStockLedgerService.handleProductCreation({
          companyId: product.company,
          clientId: req.auth.clientId,
          stocks: product.stocks,
          costPrice: product.costPrice
        });
      }
    }

    // Send notifications for each created product
    for (const product of createdProducts) {
      await notifyAdminOnProductAction({
        req,
        action: "create",
        productName: product.name,
        entryId: product._id,
      });
    }

    return res.status(200).json({
      message: `${createdProducts.length} products imported successfully`,
      importedCount: createdProducts.length
    });

  } catch (error) {
    console.error("Error importing products:", error);

    if (error.code === 11000) {
      return res.status(400).json({
        message: "Duplicate products found during import"
      });
    }

    return res.status(500).json({
      message: "Error importing products",
      error: error.message
    });
  }
};
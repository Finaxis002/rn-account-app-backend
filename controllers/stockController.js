// controllers/stockController.js
const StockTracking = require("../models/StockTracking");
const Product = require("../models/Product");
const StockHistory = require("../models/StockHistory");
const SalesEntry = require("../models/SalesEntry");
const mongoose = require("mongoose");

// Get current financial year
const getFinancialYear = (date = new Date()) => {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  
  // Indian financial year: April to March
  if (month >= 4) {
    return `${year}-${year + 1}`;
  } else {
    return `${year - 1}-${year}`;
  }
};

// Get financial year from date
const getFinancialYearFromDate = (date) => {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  
  if (month >= 4) {
    return `${year}-${year + 1}`;
  } else {
    return `${year - 1}-${year}`;
  }
};

// Initialize Stock Tracking for a product-company combination
exports.initializeStockTracking = async (productId, companyId, clientId, userId) => {
  try {
    const financialYear = getFinancialYear();
    
    let stockTracking = await StockTracking.findOne({
      product: productId,
      company: companyId,
      financialYear: financialYear,
      createdByClient: clientId
    });

    if (!stockTracking) {
      const product = await Product.findById(productId);
      const currentStock = product?.stocks || 0;

      stockTracking = new StockTracking({
        product: productId,
        company: companyId,
        financialYear: financialYear,
        openingStock: {
          quantity: currentStock,
          amount: 0 // Will be set manually later
        },
        closingStock: { 
          quantity: currentStock, 
          amount: 0 // Will be calculated automatically
        },
        createdByClient: clientId,
        createdByUser: userId
      });

      await stockTracking.save();
    }

    return stockTracking;
  } catch (error) {
    console.error("Error initializing stock tracking:", error);
    throw error;
  }
};

// Set Opening Stock (Manual Entry)
exports.setOpeningStock = async (req, res) => {
  try {
    const { productId, companyId, quantity, amount } = req.body;
    
    const financialYearToUse = getFinancialYear();
    const clientId = req.user.clientId;
    const userId = req.user.userId;

    // Initialize stock tracking if not exists
    await this.initializeStockTracking(productId, companyId, clientId, userId);

    let stockTracking = await StockTracking.findOne({
      product: productId,
      company: companyId,
      financialYear: financialYearToUse,
      createdByClient: clientId
    });

    // Update opening stock with manual amount
    stockTracking.openingStock = {
      quantity: quantity,
      amount: amount
    };

    // For new setup, closing stock starts same as opening
    if (stockTracking.closingStock.quantity === 0) {
      stockTracking.closingStock = {
        quantity: quantity,
        amount: amount
      };
    }

    await stockTracking.save();

    // Update product current stock quantity
    await Product.findByIdAndUpdate(productId, {
      stocks: quantity
    });

    // Add to stock history
    await StockHistory.create({
      product: productId,
      company: companyId,
      financialYear: financialYearToUse,
      date: new Date(),
      type: "opening",
      quantity: quantity,
      amount: amount,
      createdByClient: clientId,
      createdByUser: userId
    });

    res.status(200).json({
      success: true,
      message: "Opening stock set successfully",
      data: stockTracking
    });

  } catch (error) {
    console.error("Error setting opening stock:", error);
    res.status(500).json({
      success: false,
      message: "Error setting opening stock",
      error: error.message
    });
  }
};

// Update stock when sales are made
exports.updateStockOnSale = async (saleEntry) => {
  try {
    const { products, company, date, client, createdByUser } = saleEntry;
    
    if (!products || products.length === 0) return;

    const financialYear = getFinancialYearFromDate(new Date(date));

    for (const item of products) {
      const { product: productId, quantity } = item;

      // Initialize stock tracking if not exists
      await this.initializeStockTracking(productId, company, client, createdByUser);

      // Update product stock quantity
      await Product.findByIdAndUpdate(productId, {
        $inc: { stocks: -quantity }
      });

      // Update stock history
      await StockHistory.create({
        product: productId,
        company: company,
        financialYear: financialYear,
        date: date,
        type: "sale",
        quantity: -quantity, // Negative for sales
        amount: 0, // Amount doesn't matter for sales, we'll recalculate closing stock
        reference: saleEntry._id,
        referenceModel: 'SalesEntry',
        createdByClient: client,
        createdByUser: createdByUser
      });

      // Recalculate closing stock for the financial year
      await this.recalculateClosingStock(productId, company, client, financialYear);
    }

  } catch (error) {
    console.error("Error updating stock on sale:", error);
    throw error;
  }
};

// Recalculate closing stock based on opening stock and transactions
exports.recalculateClosingStock = async (productId, companyId, clientId, financialYear) => {
  try {
    const stockTracking = await StockTracking.findOne({
      product: productId,
      company: companyId,
      financialYear: financialYear,
      createdByClient: clientId
    });

    if (!stockTracking) return;

    // Get current product quantity from Product model
    const product = await Product.findById(productId);
    const currentQuantity = product?.stocks || 0;

    // Calculate closing stock amount based on proportion
    // (Closing Quantity / Opening Quantity) * Opening Amount
    let closingAmount = 0;
    
    if (stockTracking.openingStock.quantity > 0) {
      const proportion = currentQuantity / stockTracking.openingStock.quantity;
      closingAmount = stockTracking.openingStock.amount * proportion;
    }

    stockTracking.closingStock = {
      quantity: currentQuantity,
      amount: closingAmount
    };

    await stockTracking.save();

    return stockTracking;
  } catch (error) {
    console.error("Error recalculating closing stock:", error);
    throw error;
  }
};

// Update Closing Stock (Manual override if needed)
exports.updateClosingStock = async (req, res) => {
  try {
    const { productId, companyId, quantity, amount } = req.body;
    
    const financialYearToUse = getFinancialYear();
    const clientId = req.user.clientId;
    const userId = req.user.userId;

    const stockTracking = await StockTracking.findOne({
      product: productId,
      company: companyId,
      financialYear: financialYearToUse,
      createdByClient: clientId
    });

    if (!stockTracking) {
      return res.status(404).json({
        success: false,
        message: "Stock tracking record not found. Set opening stock first."
      });
    }

    stockTracking.closingStock = {
      quantity: quantity,
      amount: amount
    };

    await stockTracking.save();

    // Update product current stock
    await Product.findByIdAndUpdate(productId, {
      stocks: quantity
    });

    res.status(200).json({
      success: true,
      message: "Closing stock updated successfully",
      data: stockTracking
    });

  } catch (error) {
    console.error("Error updating closing stock:", error);
    res.status(500).json({
      success: false,
      message: "Error updating closing stock",
      error: error.message
    });
  }
};

// Auto-calculate closing stock for all products in a company
exports.calculateClosingStock = async (req, res) => {
  try {
    const { companyId } = req.body;
    const financialYearToUse = getFinancialYear();
    const clientId = req.user.clientId;

    // Get all products for the company
    const products = await Product.find({
      company: companyId,
      createdByClient: clientId
    });

    const results = [];

    for (const product of products) {
      // Initialize stock tracking if not exists
      await this.initializeStockTracking(product._id, companyId, clientId, req.user.userId);
      
      // Recalculate closing stock
      const updatedTracking = await this.recalculateClosingStock(
        product._id, 
        companyId, 
        clientId, 
        financialYearToUse
      );
      
      if (updatedTracking) {
        results.push(updatedTracking);
      }
    }

    res.status(200).json({
      success: true,
      message: "Closing stock calculated successfully",
      data: results
    });

  } catch (error) {
    console.error("Error calculating closing stock:", error);
    res.status(500).json({
      success: false,
      message: "Error calculating closing stock",
      error: error.message
    });
  }
};

// Get Stock Summary for P&L Statement
exports.getStockSummary = async (req, res) => {
  try {
    const { companyId, financialYear } = req.query;
    const financialYearToUse = financialYear || getFinancialYear();
    const clientId = req.user.clientId;

    const stockSummary = await StockTracking.aggregate([
      {
        $match: {
          company: new mongoose.Types.ObjectId(companyId),
          financialYear: financialYearToUse,
          createdByClient: new mongoose.Types.ObjectId(clientId)
        }
      },
      {
        $group: {
          _id: "$company",
          totalOpeningStock: { $sum: "$openingStock.amount" },
          totalClosingStock: { $sum: "$closingStock.amount" },
          productsCount: { $sum: 1 }
        }
      }
    ]);

    const summary = stockSummary.length > 0 ? stockSummary[0] : {
      totalOpeningStock: 0,
      totalClosingStock: 0,
      productsCount: 0
    };

    res.status(200).json({
      success: true,
      data: summary
    });

  } catch (error) {
    console.error("Error getting stock summary:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching stock summary",
      error: error.message
    });
  }
};

// Get Stock History for a Product
exports.getStockHistory = async (req, res) => {
  try {
    const { productId, companyId } = req.query;
    const clientId = req.user.clientId;

    const history = await StockHistory.find({
      product: productId,
      company: companyId,
      createdByClient: clientId
    })
    .populate('product', 'name sellingPrice')
    .populate('company', 'name')
    .sort({ date: -1 });

    res.status(200).json({
      success: true,
      data: history
    });

  } catch (error) {
    console.error("Error getting stock history:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching stock history",
      error: error.message
    });
  }
};
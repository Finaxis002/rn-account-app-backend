// services/dailyStockLedgerService.js
const DailyStockLedger = require("../models/DailyStockLedger");
const Product = require("../models/Product");

class DailyStockLedgerService {
  /**
   * Get standardized date (IST 00:00 as UTC)
   */
  static getStandardizedDate(date = new Date()) {
    const standardized = new Date(date);
    standardized.setUTCHours(18, 30, 0, 0); // IST 00:00
    return standardized;
  }

  /**
   * Update daily stock ledger when products are added/updated
   */
  static async updateStockLedgerOnProductChange({ 
    companyId, 
    clientId, 
    oldStocks, 
    newStocks, 
    costPrice, 
    date = new Date()
  }) {
    try {
      const standardizedDate = this.getStandardizedDate(date);

      // Calculate stock difference and value difference
      const stockDifference = newStocks - oldStocks;
      const valueDifference = stockDifference * costPrice;

      // If no change in stock, do nothing
      if (stockDifference === 0) {
        return;
      }

      // Find or create ledger for the standardized date
      let ledger = await DailyStockLedger.findOne({
        companyId: companyId,
        clientId: clientId,
        date: standardizedDate
      });

      if (!ledger) {
        // Get previous day's closing stock
        const previousDay = new Date(standardizedDate);
        previousDay.setDate(previousDay.getDate() - 1);
        previousDay.setUTCHours(18, 30, 0, 0); // IST 00:00
        
        const previousLedger = await DailyStockLedger.findOne({
          companyId: companyId,
          clientId: clientId,
          date: previousDay
        });

        ledger = new DailyStockLedger({
          companyId: companyId,
          clientId: clientId,
          date: standardizedDate,
          openingStock: previousLedger ? { 
            quantity: previousLedger.closingStock.quantity, 
            amount: previousLedger.closingStock.amount 
          } : { quantity: 0, amount: 0 },
          closingStock: previousLedger ? { 
            quantity: previousLedger.closingStock.quantity, 
            amount: previousLedger.closingStock.amount 
          } : { quantity: 0, amount: 0 },
          totalPurchaseOfTheDay: { quantity: 0, amount: 0 },
          totalSalesOfTheDay: { quantity: 0, amount: 0 }
        });
      }

      // Update opening stock (for direct product edits)
      ledger.openingStock.quantity += stockDifference;
      ledger.openingStock.amount += valueDifference;
      
      // Also update closing stock to maintain consistency
      ledger.closingStock.quantity += stockDifference;
      ledger.closingStock.amount += valueDifference;

      await ledger.save();
      console.log(`Stock ledger updated for ${standardizedDate}: ${stockDifference} units`);
      return ledger;
    } catch (error) {
      console.error('Error updating daily stock ledger:', error);
      throw error;
    }
  }

  /**
   * Handle product creation with opening stock
   */
  static async handleProductCreation({ companyId, clientId, stocks, costPrice }) {
    if (stocks > 0 && costPrice > 0) {
      return await this.updateStockLedgerOnProductChange({
        companyId,
        clientId,
        oldStocks: 0,
        newStocks: stocks,
        costPrice,
        date: new Date()
      });
    }
  }

  /**
   * Handle product stock update
   */
  static async handleProductUpdate({ companyId, clientId, oldStocks, newStocks, costPrice }) {
    return await this.updateStockLedgerOnProductChange({
      companyId,
      clientId,
      oldStocks,
      newStocks,
      costPrice,
      date: new Date()
    });
  }

  /**
   * Handle product deletion (remove stock from ledger)
   */
  static async handleProductDeletion({ companyId, clientId, stocks, costPrice }) {
    if (stocks > 0 && costPrice > 0) {
      return await this.updateStockLedgerOnProductChange({
        companyId,
        clientId,
        oldStocks: stocks,
        newStocks: 0,
        costPrice,
        date: new Date()
      });
    }
  }


  static async ensureTodayLedgerExists(companyId, clientId) {
    try {
      const today = this.getStandardizedDate(); // Today at IST 00:00
      
      // Check if today's ledger already exists
      let ledger = await DailyStockLedger.findOne({
        companyId: companyId,
        clientId: clientId,
        date: today
      });

      if (ledger) {
        console.log('✅ Today\'s ledger already exists');
        return ledger;
      }

      console.log('📊 Creating today\'s ledger...');
      
      // Get previous day's closing stock
      const previousDay = new Date(today);
      previousDay.setDate(previousDay.getDate() - 1);
      previousDay.setUTCHours(18, 30, 0, 0);
      
      const previousLedger = await DailyStockLedger.findOne({
        companyId: companyId,
        clientId: clientId,
        date: previousDay
      });

      // Check if this is the VERY FIRST ledger for this client+company
      const existingLedgerCount = await DailyStockLedger.countDocuments({
        companyId: companyId,
        clientId: clientId
      });

      let openingStock, closingStock;

      if (existingLedgerCount === 0) {
        // 🆕 FIRST TIME SETUP - Calculate from current products
        const currentProducts = await Product.find({
          company: companyId,
          createdByClient: clientId
        });
        
        const totalQuantity = currentProducts.reduce((sum, p) => sum + (p.stocks || 0), 0);
        const totalAmount = currentProducts.reduce((sum, p) => sum + ((p.stocks || 0) * (p.costPrice || 0)), 0);

        openingStock = { quantity: totalQuantity, amount: totalAmount };
        closingStock = { quantity: totalQuantity, amount: totalAmount };
        
        console.log(`🆕 First ledger created with ${totalQuantity} units worth ₹${totalAmount}`);
      } else {
        // 🔄 NORMAL CASE - Use previous day's closing
        openingStock = previousLedger ? { 
          quantity: previousLedger.closingStock.quantity, 
          amount: previousLedger.closingStock.amount 
        } : { quantity: 0, amount: 0 };
        
        closingStock = previousLedger ? { 
          quantity: previousLedger.closingStock.quantity, 
          amount: previousLedger.closingStock.amount 
        } : { quantity: 0, amount: 0 };
        
        console.log(`📅 Normal ledger created from previous day: ${closingStock.quantity} units`);
      }

      // Create the new ledger
      ledger = new DailyStockLedger({
        companyId: companyId,
        clientId: clientId,
        date: today,
        openingStock: openingStock,
        closingStock: closingStock,
        totalPurchaseOfTheDay: { quantity: 0, amount: 0 },
        totalSalesOfTheDay: { quantity: 0, amount: 0 },
        totalCOGS: 0
      });

      await ledger.save();
      console.log('✅ Today\'s ledger created successfully');
      return ledger;

    } catch (error) {
      console.error('❌ Error ensuring today\'s ledger:', error);
      throw error;
    }
  }
}

module.exports = DailyStockLedgerService;
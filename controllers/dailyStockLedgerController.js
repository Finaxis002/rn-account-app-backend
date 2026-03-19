// controllers/dailyStockLedgerController.js
const DailyStockLedger = require("../models/DailyStockLedger");
const StockCarryForwardService = require("../services/stockCarryForwardService");

class DailyStockLedgerController {
  /**
   * GET /api/daily-stock-ledger
   * Get stock ledger for a date range with pagination
   */
  static async getStockLedger(req, res) {
    try {
      const { clientId } = req.auth;
      const { 
        companyId, 
        startDate, 
        endDate, 
        page = 1, 
        limit = 30,
        sortBy = 'date',
        sortOrder = 'desc'
      } = req.query;

      if (!companyId) {
        return res.status(400).json({ message: "Company ID is required" });
      }

      if (!startDate || !endDate) {
        return res.status(400).json({ message: "Start date and end date are required" });
      }

      // Convert dates to IST format (18:30 UTC)
      const startDateIST = new Date(startDate);
      startDateIST.setUTCHours(18, 30, 0, 0);
      
      const endDateIST = new Date(endDate);
      endDateIST.setUTCHours(18, 30, 0, 0);

      // Build filter
      const filter = {
        clientId: clientId,
        companyId: companyId,
        date: {
          $gte: startDateIST,
          $lte: endDateIST
        }
      };

      // Calculate pagination
      const skip = (page - 1) * limit;
      const sort = { [sortBy]: sortOrder === 'desc' ? -1 : 1 };

      // Execute query with pagination
      const [ledgers, totalCount] = await Promise.all([
        DailyStockLedger.find(filter)
          .populate('companyId', 'name businessName')
          .sort(sort)
          .skip(skip)
          .limit(parseInt(limit))
          .lean(),
        DailyStockLedger.countDocuments(filter)
      ]);

      // Calculate summary statistics
      const summary = await this.calculateSummary(filter);

      return res.json({
        message: "Stock ledger retrieved successfully",
        data: {
          ledgers,
          pagination: {
            currentPage: parseInt(page),
            totalPages: Math.ceil(totalCount / limit),
            totalRecords: totalCount,
            hasNext: page * limit < totalCount,
            hasPrev: page > 1
          },
          summary,
          dateRange: {
            startDate: startDateIST,
            endDate: endDateIST,
            days: totalCount
          }
        }
      });

    } catch (error) {
      console.error('Error getting stock ledger:', error);
      return res.status(500).json({ message: "Server error", error: error.message });
    }
  }

  /**
   * GET /api/daily-stock-ledger/summary
   * Get summary statistics for a date range
   */
  static async getStockSummary(req, res) {
    try {
      const { clientId } = req.auth;
      const { companyId, startDate, endDate } = req.query;

      if (!companyId || !startDate || !endDate) {
        return res.status(400).json({ 
          message: "Company ID, start date and end date are required" 
        });
      }

      // Convert dates to IST format
      const startDateIST = new Date(startDate);
      startDateIST.setUTCHours(18, 30, 0, 0);
      
      const endDateIST = new Date(endDate);
      endDateIST.setUTCHours(18, 30, 0, 0);

      const filter = {
        clientId: clientId,
        companyId: companyId,
        date: {
          $gte: startDateIST,
          $lte: endDateIST
        }
      };

      const summary = await this.calculateSummary(filter);

      return res.json({
        message: "Stock summary retrieved successfully",
        data: summary
      });

    } catch (error) {
      console.error('Error getting stock summary:', error);
      return res.status(500).json({ message: "Server error", error: error.message });
    }
  }

  /**
   * GET /api/daily-stock-ledger/today
   * Get today's stock ledger (with automatic carry forward)
   */
  static async getTodayStock(req, res) {
    try {
      const { clientId } = req.auth;
      const { companyId } = req.query;

      if (!companyId) {
        return res.status(400).json({ message: "Company ID is required" });
      }

      // Ensure carry forward is done for today
      await StockCarryForwardService.ensureCarryForward({
        companyId,
        clientId,
        date: new Date()
      });

      // Get today's ledger
      const todayIST = new Date();
      todayIST.setUTCHours(18, 30, 0, 0);

      const todayLedger = await DailyStockLedger.findOne({
        clientId: clientId,
        companyId: companyId,
        date: todayIST
      }).populate('companyId', 'name businessName');

      if (!todayLedger) {
        return res.status(404).json({ message: "Today's stock ledger not found" });
      }

      return res.json({
        message: "Today's stock ledger retrieved successfully",
        data: todayLedger
      });

    } catch (error) {
      console.error('Error getting today stock:', error);
      return res.status(500).json({ message: "Server error", error: error.message });
    }
  }

  /**
   * GET /api/daily-stock-ledger/current-status
   * Get current stock status across all companies
   */
  static async getCurrentStockStatus(req, res) {
    try {
      const { clientId } = req.auth;

      // Get the most recent ledger for each company
      const currentStatus = await DailyStockLedger.aggregate([
        {
          $match: {
            clientId: new mongoose.Types.ObjectId(clientId)
          }
        },
        {
          $sort: { date: -1 }
        },
        {
          $group: {
            _id: "$companyId",
            latestRecord: { $first: "$$ROOT" },
            lastUpdated: { $first: "$updatedAt" }
          }
        },
        {
          $lookup: {
            from: "companies",
            localField: "_id",
            foreignField: "_id",
            as: "company"
          }
        },
        {
          $unwind: "$company"
        },
        {
          $project: {
            companyId: "$_id",
            companyName: "$company.businessName",
            closingStock: "$latestRecord.closingStock",
            date: "$latestRecord.date",
            lastUpdated: 1
          }
        }
      ]);

      // Calculate totals
      const totals = currentStatus.reduce((acc, item) => ({
        quantity: acc.quantity + (item.closingStock?.quantity || 0),
        amount: acc.amount + (item.closingStock?.amount || 0)
      }), { quantity: 0, amount: 0 });

      return res.json({
        message: "Current stock status retrieved successfully",
        data: {
          companies: currentStatus,
          totals
        }
      });

    } catch (error) {
      console.error('Error getting current stock status:', error);
      return res.status(500).json({ message: "Server error", error: error.message });
    }
  }

  /**
   * POST /api/daily-stock-ledger/fix-carried-forward
   * Manual trigger to fix carry forward for a date range
   */
  static async fixCarryForward(req, res) {
    try {
      const { clientId } = req.auth;
      const { companyId, startDate, endDate } = req.body;

      if (!companyId || !startDate || !endDate) {
        return res.status(400).json({ 
          message: "Company ID, start date and end date are required" 
        });
      }

      const results = await StockCarryForwardService.fixMissingCarryForwards({
        companyId,
        clientId,
        fromDate: startDate,
        toDate: endDate
      });

      return res.json({
        message: "Carry forward fix completed",
        data: results
      });

    } catch (error) {
      console.error('Error fixing carry forward:', error);
      return res.status(500).json({ message: "Server error", error: error.message });
    }
  }

  /**
   * Helper method to calculate summary statistics
   */
  static async calculateSummary(filter) {
    const summary = await DailyStockLedger.aggregate([
      { $match: filter },
      {
        $group: {
          _id: null,
          totalOpeningQuantity: { $sum: "$openingStock.quantity" },
          totalOpeningAmount: { $sum: "$openingStock.amount" },
          totalClosingQuantity: { $sum: "$closingStock.quantity" },
          totalClosingAmount: { $sum: "$closingStock.amount" },
          totalPurchaseQuantity: { $sum: "$totalPurchaseOfTheDay.quantity" },
          totalPurchaseAmount: { $sum: "$totalPurchaseOfTheDay.amount" },
          totalSalesQuantity: { $sum: "$totalSalesOfTheDay.quantity" },
          totalSalesAmount: { $sum: "$totalSalesOfTheDay.amount" },
          averageOpeningValue: { $avg: "$openingStock.amount" },
          averageClosingValue: { $avg: "$closingStock.amount" },
          dayCount: { $sum: 1 }
        }
      }
    ]);

    if (summary.length === 0) {
      return {
        totalOpeningQuantity: 0,
        totalOpeningAmount: 0,
        totalClosingQuantity: 0,
        totalClosingAmount: 0,
        totalPurchaseQuantity: 0,
        totalPurchaseAmount: 0,
        totalSalesQuantity: 0,
        totalSalesAmount: 0,
        averageOpeningValue: 0,
        averageClosingValue: 0,
        dayCount: 0,
        netStockChange: 0,
        netValueChange: 0
      };
    }

    const result = summary[0];
    result.netStockChange = result.totalClosingQuantity - result.totalOpeningQuantity;
    result.netValueChange = result.totalClosingAmount - result.totalOpeningAmount;

    return result;
  }
}

module.exports = DailyStockLedgerController;
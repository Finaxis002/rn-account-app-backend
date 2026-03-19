const moment = require('moment-timezone');
const DailyStockLedger = require("../models/DailyStockLedger");
const { ledgerDateFromIST } = require('../helpers/dateHelper');

class StockCarryForwardService {

  // Convert a JS date into 00:00 IST (stored as UTC)
  static getStartOfDayISTAsDate(inputDate = new Date()) {
    return moment.tz(inputDate, "Asia/Kolkata").startOf("day").toDate();
  }

  static getTodayIST(date = new Date()) {
    return this.getStartOfDayISTAsDate(date);
  }

  static getYesterdayIST(date = new Date()) {
    return moment
      .tz(date, "Asia/Kolkata")
      .startOf("day")
      .subtract(1, "day")
      .toDate();
  }

  // NEW — clean Ledger Date mapping
  static getLedgerDatesIST() {
    const now = new Date();

    const todayIST_str = now.toISOString().slice(0, 10); // "2025-11-25"
    const y = new Date(now);
    y.setDate(now.getDate() - 1);
    const yesterdayIST_str = y.toISOString().slice(0, 10);

    return {
      todayLedgerDate: ledgerDateFromIST(todayIST_str),
      yesterdayLedgerDate: ledgerDateFromIST(yesterdayIST_str)
    };
  }

  // ==========================
  // CARRY FORWARD LOGIC
  // ==========================
  static async carryForwardStock({ companyId, clientId, date = new Date() }) {
    try {
      const TodayIST = this.getTodayIST(date);

      console.log(
        "carryForwardStock — todayIST:",
        TodayIST.toISOString()
      );

      // Find the most recent ledger before today (regardless of date gap)
      const latestLedger = await DailyStockLedger.findOne({
        companyId,
        clientId,
        date: { $lt: TodayIST }   // Any date before today
      })
        .sort({ date: -1 })           // Sort by date descending to get latest
        .limit(1);                     // Get only the most recent one

      let openingStock = { quantity: 0, amount: 0 };

      if (latestLedger) {
        openingStock = {
          quantity: latestLedger.closingStock.quantity,
          amount: latestLedger.closingStock.amount,
        };
        console.log(
          "Found latest ledger from:",
          latestLedger.date.toISOString(),
          "with closing stock:",
          openingStock
        );
      } else {
        console.log("No previous ledger found, using default opening stock: 0");
      }

      // Prevent duplicates
      const exists = await DailyStockLedger.findOne({
        companyId,
        clientId,
        date: TodayIST,
      });

      if (exists) {
        console.log("today ledger already exists:", TodayIST.toISOString());
        return exists;
      }

      const todayLedger = new DailyStockLedger({
        companyId,
        clientId,
        date: TodayIST,
        openingStock,
        closingStock: openingStock,
        totalPurchaseOfTheDay: { quantity: 0, amount: 0 },
        totalSalesOfTheDay: { quantity: 0, amount: 0 },
        totalCOGS: 0,
      });

      await todayLedger.save();
      console.log("✨ DSL Created for:", TodayIST.toISOString());

      return todayLedger;
    } catch (err) {
      console.error("❌ carryForwardStock error:", err);
      throw err;
    }
  }

  // ==========================
  // INITIAL DSL CREATION
  // ==========================
  static async createInitialDailyLedger({ companyId, clientId, date = new Date() }) {
    const TodayIST = this.getTodayIST(date);

    const exists = await DailyStockLedger.findOne({
      companyId,
      clientId,
      date: TodayIST,
    });

    if (exists) return exists;

    return await DailyStockLedger.create({
      companyId,
      clientId,
      date: TodayIST,
      openingStock: { quantity: 0, amount: 0 },
      closingStock: { quantity: 0, amount: 0 },
      totalPurchaseOfTheDay: { quantity: 0, amount: 0 },
      totalSalesOfTheDay: { quantity: 0, amount: 0 },
      totalCOGS: 0,
    });
  }

  // ==========================
  // VERIFY CARRY FORWARD
  // ==========================
  static async verifyCarryForward({ companyId, clientId }) {
    const { todayLedgerDate } = this.getLedgerDatesIST();
    const todayIST = this.getTodayIST();

    // Find the most recent ledger before today (regardless of date gap)
    const latestDoc = await DailyStockLedger.findOne({
      companyId,
      clientId,
      date: { $lt: todayIST }   // Any date before today
    })
      .sort({ date: -1 })           // Sort by date descending to get latest
      .limit(1);                     // Get only the most recent one

    const todayDoc = await DailyStockLedger.findOne({
      companyId,
      clientId,
      date: todayIST,
    });

    return {
      latestExists: !!latestDoc,
      latestClosing: latestDoc?.closingStock || null,
      latestDate: latestDoc?.date || null,
      todayExists: !!todayDoc,
      todayOpening: todayDoc?.openingStock || null,
      todayLedgerDate
    };
  }
}

module.exports = StockCarryForwardService;

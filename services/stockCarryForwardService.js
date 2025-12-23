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
      const YesterdayIST = this.getYesterdayIST(date);

      console.log(
        "carryForwardStock — yesterdayIST:",
        YesterdayIST.toISOString(),
        "todayIST:",
        TodayIST.toISOString()
      );

      // Find yesterday ledger
      const yesterdayLedger = await DailyStockLedger.findOne({
        companyId,
        clientId,
        date: YesterdayIST,
      });

      let openingStock = { quantity: 0, amount: 0 };

      if (yesterdayLedger) {
        openingStock = {
          quantity: yesterdayLedger.closingStock.quantity,
          amount: yesterdayLedger.closingStock.amount,
        };
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
    const { todayLedgerDate, yesterdayLedgerDate } = this.getLedgerDatesIST();

    const yesterdayDoc = await DailyStockLedger.findOne({
      companyId,
      clientId,
      date: yesterdayLedgerDate,
    });

    const todayDoc = await DailyStockLedger.findOne({
      companyId,
      clientId,
      date: todayLedgerDate,
    });

    return {
      yesterdayExists: !!yesterdayDoc,
      yesterdayClosing: yesterdayDoc?.closingStock || null,
      todayExists: !!todayDoc,
      todayOpening: todayDoc?.openingStock || null,
      todayLedgerDate,
      yesterdayLedgerDate
    };
  }
}

module.exports = StockCarryForwardService;

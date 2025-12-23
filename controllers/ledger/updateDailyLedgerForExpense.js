// controllers/ledger/updateDailyLedgerForExpense.js
const DailyStockLedger = require("../../models/DailyStockLedger");
const mongoose = require("mongoose");

/**
 * Normalize ledger date to 18:30 UTC (midnight IST)
 */
function normalizeDateToIST(date) {
  const d = new Date(date);
  d.setUTCHours(18, 30, 0, 0);
  return d;
}

/**
 * Update Daily Ledger for a new/edited/deleted expense.
 */
exports.updateDailyLedgerForExpense = async function ({
  companyId,
  clientId,
  date,
  expenseHeadId,
  amountDelta
}, session = null) {
  try {
    const ledgerDate = normalizeDateToIST(date);

    // 🔥 SOLUTION: First try to find existing, if not found then create
    let ledger = await DailyStockLedger.findOne({
      clientId,
      companyId,
      date: ledgerDate
    }).session(session);

    if (ledger) {
      // ✅ Ledger exists - just update it
      ledger.totalExpenses = (ledger.totalExpenses || 0) + amountDelta;

      // Update expense summary
      const existingHeadIndex = ledger.expenseSummary.findIndex(
        (e) => e.expenseHead.toString() === expenseHeadId.toString()
      );

      if (existingHeadIndex >= 0) {
        ledger.expenseSummary[existingHeadIndex].amount += amountDelta;
        
        if (ledger.expenseSummary[existingHeadIndex].amount <= 0) {
          ledger.expenseSummary.splice(existingHeadIndex, 1);
        }
      } else if (amountDelta > 0) {
        ledger.expenseSummary.push({
          expenseHead: expenseHeadId,
          amount: amountDelta,
        });
      }

      await ledger.save({ session });
      return ledger;

    } else {
      // ✅ Ledger doesn't exist - create new with updateOne + upsert
      // This avoids race condition better than findOneAndUpdate
      await DailyStockLedger.updateOne(
        {
          clientId,
          companyId,
          date: ledgerDate
        },
        {
          $setOnInsert: {
            clientId,
            companyId,
            date: ledgerDate,
            openingStock: { quantity: 0, amount: 0 },
            closingStock: { quantity: 0, amount: 0 },
            totalPurchaseOfTheDay: { quantity: 0, amount: 0 },
            totalSalesOfTheDay: { quantity: 0, amount: 0 },
            totalCOGS: 0,
            totalExpenses: amountDelta,
            expenseSummary: [{
              expenseHead: expenseHeadId,
              amount: amountDelta
            }]
          }
        },
        {
          upsert: true,
          session
        }
      );

      // Fetch the newly created document
      ledger = await DailyStockLedger.findOne({
        clientId,
        companyId,
        date: ledgerDate
      }).session(session);

      return ledger;
    }

  } catch (err) {
    // 🔥 If still duplicate key error, it means entry was just created
    // by another concurrent request - retry once
    if (err.code === 11000) {
      console.warn('⚠️ Duplicate key detected, retrying...');
      
      // Wait a bit and retry
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // Fetch the existing entry and update it
      const existingLedger = await DailyStockLedger.findOne({
        clientId,
        companyId,
        date: normalizeDateToIST(date)
      }).session(session);

      if (existingLedger) {
        existingLedger.totalExpenses = (existingLedger.totalExpenses || 0) + amountDelta;

        const existingHeadIndex = existingLedger.expenseSummary.findIndex(
          (e) => e.expenseHead.toString() === expenseHeadId.toString()
        );

        if (existingHeadIndex >= 0) {
          existingLedger.expenseSummary[existingHeadIndex].amount += amountDelta;
          
          if (existingLedger.expenseSummary[existingHeadIndex].amount <= 0) {
            existingLedger.expenseSummary.splice(existingHeadIndex, 1);
          }
        } else if (amountDelta > 0) {
          existingLedger.expenseSummary.push({
            expenseHead: expenseHeadId,
            amount: amountDelta,
          });
        }

        await existingLedger.save({ session });
        console.log('✅ Updated via retry logic');
        return existingLedger;
      }
    }

    console.error("Error updating daily ledger for expense:", err);
    throw err;
  }
};
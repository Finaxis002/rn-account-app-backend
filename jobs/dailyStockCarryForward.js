// jobs/dailyStockCarryForward.js
const cron = require('node-cron');
const mongoose = require('mongoose');
const StockCarryForwardService = require('../services/stockCarryForwardService');
const DailyStockLedger = require('../models/DailyStockLedger');
const moment = require('moment-timezone');


async function runDailyCarryForward() {
  try {
    console.log('🔄 Starting daily stock carry forward job...', new Date().toISOString());

    // Build the "today" anchor in IST
    const todayISTDate = StockCarryForwardService.getTodayIST(new Date());

    console.log('📅 Processing carry forward for IST date (stored value):', todayISTDate.toISOString());

    const combinations = await getActiveCompanyClientCombinations();

    for (const combo of combinations) {
      try {
        console.log(`🔍 Processing company: ${combo.companyId}, client: ${combo.clientId}`);

        // Use the same date object for all ops
        const yesterdayIST = StockCarryForwardService.getYesterdayIST(todayISTDate);
        const todayIST = StockCarryForwardService.getTodayIST(todayISTDate);

        const yesterdayLedger = await DailyStockLedger.findOne({
          companyId: combo.companyId,
          clientId: combo.clientId,
          date: yesterdayIST
        });

        if (!yesterdayLedger) {
          console.log("🆕 No DSL history. Creating FIRST Daily Ledger with zero opening stock");
          await StockCarryForwardService.createInitialDailyLedger({
            companyId: combo.companyId,
            clientId: combo.clientId,
            date: todayISTDate
          });
        } else {
          console.log("➡ Carrying forward yesterday closing into today's opening");
          await StockCarryForwardService.carryForwardStock({
            companyId: combo.companyId,
            clientId: combo.clientId,
            date: todayISTDate
          });
        }

        console.log(`✅ Carry forward completed for company: ${combo.companyId}`);
      } catch (err) {
        console.error(`❌ Carry forward failed for ${combo.companyId}:`, err);
      }
    }

    console.log('✅ Daily stock carry forward job completed');
  } catch (error) {
    console.error('❌ Daily stock carry forward job failed:', error);
  }
}

async function getActiveCompanyClientCombinations() {
  try {
    const Company = mongoose.model('Company');

    const activeCompanies = await Company.find({})
      .select('_id client clientId selectedClient')
      .lean();


    return activeCompanies.map(company => {
      const resolvedClientId =
        company.clientId || company.client || company.selectedClient || null;

      return {
        companyId: company._id.toString(),
        clientId: resolvedClientId ? resolvedClientId.toString() : null,
      };
    });

  } catch (error) {
    console.error('❌ Error fetching active companies:', error);

    // Fallback - Get from existing carry forward records
    try {
      const StockCarryForward = mongoose.model('StockCarryForward');
      const uniqueCombinations = await StockCarryForward.aggregate([
        {
          $group: {
            _id: {
              companyId: "$companyId",
              clientId: "$clientId"
            }
          }
        },
        {
          $project: {
            companyId: "$_id.companyId",
            clientId: "$_id.clientId",
            _id: 0
          }
        }
      ]);

      console.log('🔍 Fallback: Found combinations from existing records:', uniqueCombinations.length);
      return uniqueCombinations;

    } catch (fallbackError) {
      console.error('❌ Fallback also failed:', fallbackError);
      return [];
    }
  }
}


// Manual trigger for testing
async function manualRun() {
  console.log('🔄 Manually triggering carry forward job...');
  await runDailyCarryForward();
}

// Schedule to run every day at 00:05 AM
cron.schedule('05 00 * * *', runDailyCarryForward, {
  timezone: "Asia/Kolkata"
});

console.log('⏰ Daily stock carry forward cron job scheduled (00:05 IST)');

module.exports = {
  runDailyCarryForward,
  getActiveCompanyClientCombinations,
  manualRun
};
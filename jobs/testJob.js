// testJob.js
const { runDailyCarryForward } = require('./jobs/dailyStockCarryForward');

async function testJob() {
  console.log('🧪 Testing carry forward job...');
  await runDailyCarryForward();
}

testJob();
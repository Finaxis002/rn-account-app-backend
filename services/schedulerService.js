// services/schedulerService.js
const cron = require('node-cron');
const { generateDailyReport, generateMonthlyReport, formatReportToHTML } = require('./reportService');
const { sendReportEmail } = require('./emailService');
const Client = require('../models/Client');
const TIMEZONE = 'Asia/Kolkata';

async function sendDailyReports() {
  try {
    const today = new Date();
    const clients = await Client.find({}).select('email companyName');

    for (const client of clients) {
      try {
        const report = await generateDailyReport(client._id, today);
        const htmlContent = formatReportToHTML(report, 'daily');
        
        await sendReportEmail(
          client.email,
          `Daily Sales Report - ${today.toDateString()}`,
          htmlContent
        );
        
        console.log(`Daily report sent to ${client.email}`);
      } catch (error) {
        console.error(`Failed to send daily report to ${client.email}:`, error);
      }
    }
  } catch (error) {
    console.error('Daily report scheduling error:', error);
  }
}

async function sendMonthlyReports() {
  try {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;
    
    const clients = await Client.find({}).select('email companyName');

    for (const client of clients) {
      try {
        const report = await generateMonthlyReport(client._id, year, month);
        const htmlContent = formatReportToHTML(report, 'monthly');
        
        await sendReportEmail(
          client.email,
          `Monthly Sales Report - ${month}/${year}`,
          htmlContent
        );
        
        console.log(`Monthly report sent to ${client.email}`);
      } catch (error) {
        console.error(`Failed to send monthly report to ${client.email}:`, error);
      }
    }
  } catch (error) {
    console.error('Monthly report scheduling error:', error);
  }
}

function startSchedulers() {
  // Schedule daily at 9 PM (21:00)
  cron.schedule('0 21 * * *', async () => {
    console.log('Running daily sales report job...');
    await sendDailyReports();
  }, {
    scheduled: true,
    timezone: TIMEZONE
  });

  // Schedule on 30th/31st at 9 PM
  cron.schedule('0 21 30,31 * *', async () => {
    console.log('Running monthly sales report job...');
    await sendMonthlyReports();
  }, {
    scheduled: true,
    timezone: TIMEZONE
  });

  console.log('Sales report schedulers started');
}

// Manual trigger functions for testing
async function triggerDailyReport(clientId) {
  const today = new Date();
  const report = await generateDailyReport(clientId, today);
  return formatReportToHTML(report, 'daily');
}

async function triggerMonthlyReport(clientId, year, month) {
  const report = await generateMonthlyReport(clientId, year, month);
  return formatReportToHTML(report, 'monthly');
}

async function testReportImmediately() {
  try {
    console.log('Testing report system immediately...');
    await sendDailyReports();
    console.log('Immediate test completed');
  } catch (error) {
    console.error('Immediate test failed:', error);
  }
}


module.exports = {
  startSchedulers,
  sendDailyReports,
  sendMonthlyReports,
  triggerDailyReport,
  triggerMonthlyReport,
  testReportImmediately 
};
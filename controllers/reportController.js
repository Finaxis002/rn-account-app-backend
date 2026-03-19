// controllers/reportController.js
const { triggerDailyReport, triggerMonthlyReport } = require('../services/schedulerService');

async function getDailyReport(req, res) {
  try {
    const html = await triggerDailyReport(req.auth.clientId);
    res.set('Content-Type', 'text/html');
    res.send(html);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

async function getMonthlyReport(req, res) {
  try {
    const { year, month } = req.query;
    const html = await triggerMonthlyReport(
      req.auth.clientId, 
      parseInt(year) || new Date().getFullYear(),
      parseInt(month) || new Date().getMonth() + 1
    );
    res.set('Content-Type', 'text/html');
    res.send(html);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

module.exports = {
  getDailyReport,
  getMonthlyReport
};
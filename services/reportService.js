// services/reportService.js
const SalesEntry = require("../models/SalesEntry");
const Client = require("../models/Client");
const Company = require("../models/Company");
const Party = require("../models/Party");

// Format currency for reports
const INR = new Intl.NumberFormat("en-IN", { 
  style: "currency", 
  currency: "INR",
  minimumFractionDigits: 0,
  maximumFractionDigits: 0
});

const money = (n) => INR.format(Number(n || 0));

// Generate daily sales report
async function generateDailyReport(clientId, date = new Date()) {
  try {
    const startOfDay = new Date(date);
    startOfDay.setHours(0, 0, 0, 0);
    
    const endOfDay = new Date(date);
    endOfDay.setHours(23, 59, 59, 999);

    const sales = await SalesEntry.find({
      client: clientId,
      date: {
        $gte: startOfDay,
        $lte: endOfDay
      }
    })
    .populate("party", "name email")
    .populate("company", "businessName gstin address")
    .populate("products.product", "name hsn")
    .populate("services.service", "serviceName sac")
    .sort({ date: 1 });

    const totalSales = sales.reduce((sum, entry) => sum + (entry.totalAmount || 0), 0);
    const totalTransactions = sales.length;
    const totalTax = sales.reduce((sum, entry) => sum + (entry.taxAmount || 0), 0);

    // Group by payment method
    const paymentMethods = {};
    sales.forEach(entry => {
      const method = entry.paymentMethod || 'Unknown';
      if (!paymentMethods[method]) {
        paymentMethods[method] = { total: 0, count: 0 };
      }
      paymentMethods[method].total += entry.totalAmount || 0;
      paymentMethods[method].count += 1;
    });

    // Group by company
    const companyWise = {};
    sales.forEach(entry => {
      const companyName = entry.company?.businessName || 'Unknown Company';
      if (!companyWise[companyName]) {
        companyWise[companyName] = { total: 0, count: 0 };
      }
      companyWise[companyName].total += entry.totalAmount || 0;
      companyWise[companyName].count += 1;
    });

    return {
      date: date.toDateString(),
      sales,
      summary: {
        totalSales,
        totalTransactions,
        totalTax,
        averageTransaction: totalTransactions > 0 ? totalSales / totalTransactions : 0,
        paymentMethods,
        companyWise
      }
    };
  } catch (error) {
    throw new Error(`Failed to generate daily report: ${error.message}`);
  }
}

// Generate monthly sales report
async function generateMonthlyReport(clientId, year, month) {
  try {
    const startOfMonth = new Date(year, month - 1, 1);
    const endOfMonth = new Date(year, month, 0, 23, 59, 59, 999);

    const sales = await SalesEntry.find({
      client: clientId,
      date: {
        $gte: startOfMonth,
        $lte: endOfMonth
      }
    })
    .populate("party", "name email")
    .populate("company", "businessName gstin address")
    .populate("products.product", "name hsn")
    .populate("services.service", "serviceName sac")
    .sort({ date: 1 });

    const totalSales = sales.reduce((sum, entry) => sum + (entry.totalAmount || 0), 0);
    const totalTransactions = sales.length;
    const totalTax = sales.reduce((sum, entry) => sum + (entry.taxAmount || 0), 0);

    // Group by day for daily breakdown
    const dailyBreakdown = {};
    sales.forEach(entry => {
      const day = entry.date.getDate();
      if (!dailyBreakdown[day]) {
        dailyBreakdown[day] = { total: 0, count: 0, date: entry.date.toDateString() };
      }
      dailyBreakdown[day].total += entry.totalAmount || 0;
      dailyBreakdown[day].count += 1;
    });

    // Group by payment method
    const paymentMethods = {};
    sales.forEach(entry => {
      const method = entry.paymentMethod || 'Unknown';
      if (!paymentMethods[method]) {
        paymentMethods[method] = { total: 0, count: 0 };
      }
      paymentMethods[method].total += entry.totalAmount || 0;
      paymentMethods[method].count += 1;
    });

    // Group by company
    const companyWise = {};
    sales.forEach(entry => {
      const companyName = entry.company?.businessName || 'Unknown Company';
      if (!companyWise[companyName]) {
        companyWise[companyName] = { total: 0, count: 0 };
      }
      companyWise[companyName].total += entry.totalAmount || 0;
      companyWise[companyName].count += 1;
    });

    return {
      period: `${month}/${year}`,
      sales,
      summary: {
        totalSales,
        totalTransactions,
        totalTax,
        averageTransaction: totalTransactions > 0 ? totalSales / totalTransactions : 0,
        dailyBreakdown,
        paymentMethods,
        companyWise
      }
    };
  } catch (error) {
    throw new Error(`Failed to generate monthly report: ${error.message}`);
  }
}

// Format report to HTML (similar to your invoice template style)
function formatReportToHTML(report, reportType) {
  const isDaily = reportType === 'daily';
  
  let html = `
    <!doctype html>
    <html>
    <head>
      <style>
        body { font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; margin: 20px; background: #f8fafc; color: #111827; }
        .header { background: #ffffff; padding: 24px; border-radius: 12px; border: 1px solid #e5e7eb; margin-bottom: 20px; }
        .summary { background: #e8f4f8; padding: 20px; border-radius: 8px; margin: 20px 0; }
        table { width: 100%; border-collapse: collapse; margin: 20px 0; background: #ffffff; border-radius: 8px; overflow: hidden; }
        th, td { border: 1px solid #e5e7eb; padding: 12px; text-align: left; }
        th { background-color: #f1f5f9; font-weight: 600; }
        .total-row { font-weight: bold; background-color: #e8f4f8; }
        .section { margin: 24px 0; }
        .section-title { font-size: 18px; font-weight: 600; margin-bottom: 12px; color: #1f2937; }
      </style>
    </head>
    <body>
      <div class="header">
        <h1>${isDaily ? 'Daily' : 'Monthly'} Sales Report</h1>
        <p>${isDaily ? `Date: ${report.date}` : `Period: ${report.period}`}</p>
      </div>
  `;

  // Summary section
  html += `
    <div class="summary">
      <h2>Summary</h2>
      <p><strong>Total Sales:</strong> ${money(report.summary.totalSales)}</p>
      <p><strong>Total Transactions:</strong> ${report.summary.totalTransactions}</p>
      <p><strong>Total Tax:</strong> ${money(report.summary.totalTax)}</p>
      <p><strong>Average Transaction:</strong> ${money(report.summary.averageTransaction)}</p>
  `;

  if (!isDaily) {
    html += `<h3>Daily Breakdown</h3>`;
    Object.entries(report.summary.dailyBreakdown).forEach(([day, data]) => {
      html += `<p>${data.date}: ${money(data.total)} (${data.count} transactions)</p>`;
    });
  }

  html += `</div>`;

  // Payment methods breakdown
  html += `
    <div class="section">
      <div class="section-title">Payment Methods</div>
      <table>
        <thead>
          <tr>
            <th>Payment Method</th>
            <th>Total Amount</th>
            <th>Transaction Count</th>
          </tr>
        </thead>
        <tbody>
  `;

  Object.entries(report.summary.paymentMethods).forEach(([method, data]) => {
    html += `
      <tr>
        <td>${method}</td>
        <td>${money(data.total)}</td>
        <td>${data.count}</td>
      </tr>
    `;
  });

  html += `
        </tbody>
      </table>
    </div>
  `;

  // Company-wise breakdown
  html += `
    <div class="section">
      <div class="section-title">Company-wise Sales</div>
      <table>
        <thead>
          <tr>
            <th>Company</th>
            <th>Total Amount</th>
            <th>Transaction Count</th>
          </tr>
        </thead>
        <tbody>
  `;

  Object.entries(report.summary.companyWise).forEach(([company, data]) => {
    html += `
      <tr>
        <td>${company}</td>
        <td>${money(data.total)}</td>
        <td>${data.count}</td>
      </tr>
    `;
  });

  html += `
        </tbody>
      </table>
    </div>
  `;

  // Detailed transactions
  html += `
    <div class="section">
      <div class="section-title">Detailed Transactions</div>
      <table>
        <thead>
          <tr>
            <th>Invoice #</th>
            <th>Date</th>
            <th>Customer</th>
            <th>Company</th>
            <th>Amount</th>
            <th>Payment Method</th>
          </tr>
        </thead>
        <tbody>
  `;

  report.sales.forEach(entry => {
    html += `
      <tr>
        <td>${entry.invoiceNumber || 'N/A'}</td>
        <td>${entry.date.toLocaleDateString()}</td>
        <td>${entry.party?.name || 'N/A'}</td>
        <td>${entry.company?.businessName || 'N/A'}</td>
        <td>${money(entry.totalAmount || 0)}</td>
        <td>${entry.paymentMethod || 'N/A'}</td>
      </tr>
    `;
  });

  html += `
        </tbody>
      </table>
    </div>
  `;

  html += `
    </body>
    </html>
  `;

  return html;
}

module.exports = {
  generateDailyReport,
  generateMonthlyReport,
  formatReportToHTML,
  money
};
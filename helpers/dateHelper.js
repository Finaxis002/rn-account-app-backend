// Convert IST calendar date → UTC timestamp used in DailyStockLedger
function ledgerDateFromIST(dateStr) {
  const d = new Date(dateStr);       // UI / today's IST date (e.g., "2025-11-25")

  // subtract 1 day because DB stores D-1 at 18:30 UTC
  d.setUTCDate(d.getUTCDate() - 1);

  // set UTC to 18:30 (which = IST 00:00 next day)
  d.setUTCHours(18, 30, 0, 0);

  return d;
}

module.exports = { ledgerDateFromIST };

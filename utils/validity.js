// utils/validity.js
exports.computeExpiry = (startAt, { years = 0, months = 0, days = 0 } = {}) => {
  const d = new Date(startAt || Date.now());
  d.setFullYear(d.getFullYear() + Number(years || 0));
  d.setMonth(d.getMonth() + Number(months || 0));
  d.setDate(d.getDate() + Number(days || 0));
  return d;
};

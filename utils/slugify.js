module.exports = function slugifyUsername(u = "") {
  return String(u).trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
};

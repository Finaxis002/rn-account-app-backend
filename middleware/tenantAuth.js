
//for client specific login

const jwt = require("jsonwebtoken");

module.exports = function tenantAuth(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ message: "No token provided" });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;

    const urlSlug = req.params.slug;
    if (!urlSlug) return res.status(400).json({ message: "Missing tenant slug in URL" });

    if (decoded.role !== "client") {
      return res.status(403).json({ message: "Not authorized as client" });
    }
    if (decoded.slug !== urlSlug) {
      return res.status(403).json({ message: "Tenant mismatch: not allowed" });
    }
    next();
  } catch (err) {
    return res.status(400).json({ message: "Invalid token" });
  }
};

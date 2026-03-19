const jwt = require("jsonwebtoken");

const verifyMasterAdmin = (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1]; // Bearer <token>

  if (!token) return res.status(401).json({ message: "Access denied. No token provided." });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.role !== "master") {
      return res.status(403).json({ message: "Forbidden. Not master admin." });
    }

    req.user = decoded;
    next();
  } catch (err) {
    return res.status(400).json({ message: "Invalid token." });
  }
};

module.exports = verifyMasterAdmin;

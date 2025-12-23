const jwt = require("jsonwebtoken");

const authenticate = (roles = []) => {
  return (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      console.log("Missing or malformed auth header");
      return res.status(401).json({ message: "No token provided" });
    }

    const token = authHeader.split(" ")[1];
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      // Role check
      if (roles.length && !roles.includes(decoded.role)) {
        console.log("Forbidden. Not authorized. Role:", decoded.role);
        return res.status(403).json({ message: "Not authorized" });
      }

      req.user = decoded;
      next();
    } catch (err) {
      console.log("JWT error:", err.message);
      return res.status(401).json({ message: "Invalid token" });
    }
  };
};

module.exports = authenticate;

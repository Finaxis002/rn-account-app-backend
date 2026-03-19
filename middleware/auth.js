const jwt = require("jsonwebtoken");

exports.authenticateToken = async (req, res, next) => {
  // 1. Extract token
  const authHeader = req.headers["authorization"];
  const token = authHeader?.startsWith("Bearer ") ? authHeader.split(" ")[1] : null;

  if (!token) {
    console.log("🚫 No token provided");
    return res.status(401).json({ 
      error: "Authentication required",
      solution: "Include valid JWT token in Authorization header"
    });
  }

  // 2. Verify token (with async/await)
  try {
    const decoded = await new Promise((resolve, reject) => {
      jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
        if (err) reject(err);
        else resolve(decoded);
      });
    });

    // 3. Attach user to request
    req.user = decoded;
    // console.log(`🔑 Authenticated as ${decoded.role} (ID: ${decoded.id})`);
    next();

  } catch (err) {
    console.error("❌ Token verification failed:", err.name);
    
    const response = {
      error: "Invalid token",
      vercelTip: "Check JWT_SECRET matches between local and production"
    };

    if (err.name === "TokenExpiredError") {
      response.error = "Token expired";
      response.solution = "Generate a new login token";
      return res.status(401).json(response);
    }

    if (err.name === "JsonWebTokenError") {
      response.error = "Malformed token";
      return res.status(400).json(response);
    }

    return res.status(403).json(response);
  }
};
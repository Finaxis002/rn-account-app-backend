const jwt = require("jsonwebtoken");

// const verifyClientOrAdmin = (req, res, next) => {
//   const token = req.headers.authorization?.split(" ")[1];

//   if (!token) return res.status(401).json({ message: "No token provided" });

//   try {
//     const decoded = jwt.verify(token, process.env.JWT_SECRET);
//     if (decoded.role !== "client" && decoded.role !== "master" && decoded.role !== "user" && decoded.role !== "manager" && decoded.role !== "admin") {
//       return res.status(403).json({ message: "Access denied" });
//     }

//     req.user = decoded;
//     next();
//   } catch (err) {
//     return res.status(400).json({ message: "Invalid token" });
//   }
// };


const verifyClientOrAdmin = async (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ message: "No token provided" });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // allow these roles (adjust as you like)
    const role = (decoded.role || "").toLowerCase();
    const allowed = ["master", "client", "admin", "manager", "user"];
    if (!allowed.includes(role)) {
      return res.status(403).json({ message: "Access denied" });
    }

    // keep existing
    req.user = decoded;

    // 🔑 normalize IDs for everyone
    const userId =
      decoded.id || decoded._id || decoded.sub; // who is acting
    const clientId =
      decoded.clientId || decoded.createdByClient || userId; // tenant id (for master/client it's themselves; for users it should be createdByClient)

    // For non-master roles, we need to ensure we have a valid userId
    // If userId is not found in token, try to look up user by other means
    let finalUserId = userId;
    let finalClientId = clientId;

    if (!finalUserId && role !== "master") {
      // Try to find user by email or other identifier if available
      const User = require("../models/User");
      let userQuery = {};

      if (decoded.email) {
        userQuery.email = decoded.email;
      } else if (decoded.username) {
        userQuery.clientUsername = decoded.username;
      }

      if (Object.keys(userQuery).length > 0) {
        const user = await User.findOne(userQuery).select('_id client').lean();
        if (user) {
          finalUserId = user._id;
          finalClientId = user.client || finalClientId;
        }
      }
    }

    // Ensure we have required IDs
    if (!finalUserId) {
      return res.status(401).json({ message: "User authentication failed - no user ID found" });
    }
    if (!finalClientId) {
      return res.status(401).json({ message: "Client authentication failed - no client ID found" });
    }

    req.auth = { userId: finalUserId, clientId: finalClientId, role };
    next();
  } catch (err) {
    return res.status(400).json({ message: "Invalid token" });
  }
};

module.exports = verifyClientOrAdmin;

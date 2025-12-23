// middleware/verifyUser.js
const jwt = require("jsonwebtoken");
const { getEffectivePermissions } = require("../services/effectivePermissions");

// MAIN: verify JWT, attach tenant/user info + effective permissions
async function verifyUser(req, res, next) {
  try {
    const auth = req.headers.authorization || "";
    const [scheme, token] = auth.split(" ");
    if (scheme !== "Bearer" || !token) {
      return res.status(401).json({ message: "Authorization token missing or malformed" });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const { id, role, clientId, client, createdByClient, slug, ...rest } = decoded;
    if (!id) return res.status(401).json({ message: "Invalid token payload" });

    const tenantId = clientId || client || createdByClient;
    if (!tenantId) return res.status(401).json({ message: "No client/tenant on token" });

    // attach identity
    req.auth = { id, role, clientId: tenantId, slug, ...rest };

    // attach effective permissions (Client Permission ⭢ UserPermission overrides)
    req.acl = await getEffectivePermissions({ clientId: tenantId, userId: id });

    return next();
  } catch (err) {
    const code = /TokenExpiredError|JsonWebTokenError/.test(err.name) ? 401 : 500;
    return res.status(code).json({ message: err.message || "Unauthorized" });
  }
}

/**
 * Gate by capabilities you defined in Permission/UserPermission.
 * Usage: requireCaps({ all: ["canCreateSaleEntries"] })
 *        requireCaps({ any: ["canCreateProducts","canCreateInventory"] })
 */
function requireCaps({ all = [], any = [] } = {}) {
  return function (req, res, next) {
    const caps = req.acl?.caps || {};
    if (all.length && !all.every(k => caps[k])) {
      return res.status(403).json({ message: "Forbidden: missing required capabilities" });
    }
    if (any.length && !any.some(k => caps[k])) {
      return res.status(403).json({ message: "Forbidden: none of the allowed capabilities present" });
    }
    return next();
  };
}

/**
 * Optional: keep a simple role gate if you still want it on some routes.
 * Usage: requireRoles(["user","admin"])
 */
function requireRoles(allowed = []) {
  const set = new Set(allowed.map(r => String(r).toLowerCase()));
  return function (req, res, next) {
    const role = String(req.auth?.role || "").toLowerCase();
    if (set.size && !set.has(role)) {
      return res.status(403).json({ message: "Forbidden: role not allowed" });
    }
    next();
  };
}

// Backward-compatible exports:
//   const verifyUser = require("./verifyUser")
//   const { requireCaps } = require("./verifyUser")
module.exports = verifyUser;
module.exports.requireCaps = requireCaps;
module.exports.requireRoles = requireRoles;

// controllers/permissionController.js
const Permission = require("../models/Permission");
const UserPermission = require("../models/UserPermission");
const { CAP_KEYS, USER_OVERRIDE_KEYS, getEffectivePermissions, sanitizeAllowedCompanies } =
  require("../services/effectivePermissions");

/**
 * GET /api/permissions/my
 * Current user's effective permissions + limits.
 */
exports.getMyEffectivePermissions = async (req, res) => {
  try {
    const clientId = req.auth?.clientId;
    const userId = req.auth?.id;
    if (!clientId || !userId) {
      return res.status(401).json({ message: "Unauthenticated" });
    }

    const data = await getEffectivePermissions({ clientId, userId });
    // Shape that your FE PermissionProvider expects:
    // { canCreateUsers, canCreateProducts, ... , maxCompanies, maxUsers, maxInventories }
    const flat = {
      ...data.caps,
      ...data.limits,
    };
    return res.json(flat);
  } catch (e) {
    console.error("getMyEffectivePermissions error:", e);
    res.status(500).json({ message: "Failed to load permissions" });
  }
};

/**
 * GET /api/permissions/client
 * Return tenant Permission doc (owner-only, optional).
 */
exports.getClientPermission = async (req, res) => {
  try {
    const clientId = req.auth?.clientId || req.auth?.id; // client/master
    if (!clientId) return res.status(401).json({ message: "Unauthenticated" });

    const doc = await Permission.findOne({ client: clientId }).lean();
    if (!doc) return res.status(404).json({ message: "Permission doc not found" });

    return res.json(doc);
  } catch (e) {
    console.error("getClientPermission error:", e);
    res.status(500).json({ message: "Failed to load client permission" });
  }
};

/**
 * GET /api/permissions/users/:userId
 * Return a user's override doc (owner-only).
 */
exports.getUserOverrides = async (req, res) => {
  try {
    const clientId = req.auth?.clientId;
    const { userId } = req.params;
    const doc = await UserPermission.findOne({ client: clientId, user: userId }).lean();
    if (!doc) return res.status(404).json({ message: "No overrides found" });
    return res.json(doc);
  } catch (e) {
    console.error("getUserOverrides error:", e);
    res.status(500).json({ message: "Failed to load user overrides" });
  }
};

/**
 * PUT /api/permissions/users/:userId
 * Upsert per-user overrides.
 * Body: { overrides: {capKey: true|false|null}, allowedCompanies?: [ids] }
 */
exports.upsertUserOverrides = async (req, res) => {
  try {
    const clientId = req.auth?.clientId;
    const adminId = req.auth?.id;
    const { userId } = req.params;
    const { overrides = {}, allowedCompanies } = req.body || {};

    // keep only overrideable keys; coerce to true/false/null
    const set = {};
    for (const [k, v] of Object.entries(overrides)) {
      if (!USER_OVERRIDE_KEYS.has(k)) continue;
      if (v === null || v === "null") set[k] = null;
      else if (v === true || v === "true") set[k] = true;
      else if (v === false || v === "false") set[k] = false;
    }

    const cleanedAllowed = await sanitizeAllowedCompanies(clientId, allowedCompanies);

    const doc = await UserPermission.findOneAndUpdate(
      { client: clientId, user: userId },
      {
        $setOnInsert: { client: clientId, user: userId },
        $set: { ...set, updatedBy: adminId, ...(cleanedAllowed ? { allowedCompanies: cleanedAllowed } : {}) },
      },
      { upsert: true, new: true }
    );

    return res.json({ message: "User overrides saved", userPermission: doc });
  } catch (e) {
    console.error("upsertUserOverrides error:", e);
    res.status(500).json({ message: "Failed to save overrides" });
  }
};

/**
 * DELETE /api/permissions/users/:userId
 * Remove a user's override doc (falls back to tenant defaults).
 */
exports.clearUserOverrides = async (req, res) => {
  try {
    const clientId = req.auth?.clientId;
    const { userId } = req.params;
    await UserPermission.deleteOne({ client: clientId, user: userId });
    return res.json({ message: "User overrides cleared" });
  } catch (e) {
    console.error("clearUserOverrides error:", e);
    res.status(500).json({ message: "Failed to clear overrides" });
  }
};

const User = require("../models/User");
const Role = require("../models/Role");
const Client = require("../models/Client");

// ---- Actor resolver: supports staff users and clients ----
async function resolveActor(req) {
  // Fast path: use names from JWT if present
  const claimName =
    req.auth?.displayName ||
    req.auth?.fullName ||
    req.auth?.name ||
    req.auth?.userName ||
    req.auth?.username ||
    req.auth?.clientName || // if you add this in JWT for clients
    null;

  const role = req.auth?.role;

  // If the claim has a string, return with best-effort id as well
  if (claimName && String(claimName).trim()) {
    return {
      id:
        req.auth?.userId ||
        req.auth?.id ||
        req.user?.id ||
        req.auth?.clientId ||
        null,
      name: String(claimName).trim(),
      role,
      kind: role === "client" ? "client" : "user",
    };
  }

  // If actor is a client, fetch from Client model
  if (role === "client") {
    const clientId = req.auth?.clientId;
    if (!clientId)
      return { id: null, name: "Unknown User", role, kind: "client" };

    const clientDoc = await Client.findById(clientId)
      .select("contactName clientUsername email phone")
      .lean();

    const name =
      clientDoc?.contactName ||
      clientDoc?.clientUsername ||
      clientDoc?.email ||
      clientDoc?.phone ||
      "Unknown User";

    return { id: clientId, name: String(name).trim(), role, kind: "client" };
  }

  // Otherwise treat as internal user
  const userId =
    req.auth?.userId || req.auth?.id || req.user?.id || req.user?._id;
  if (!userId) return { id: null, name: "Unknown User", role, kind: "user" };

  const userDoc = await User.findById(userId)
    .select("displayName fullName name userName username email")
    .lean();

  const name =
    userDoc?.displayName ||
    userDoc?.fullName ||
    userDoc?.name ||
    userDoc?.userName ||
    userDoc?.username ||
    userDoc?.email ||
    "Unknown User";

  return { id: userId, name: String(name).trim(), role, kind: "user" };
}

// Optionally find an admin scoped to a company; fallback to any admin
async function findAdminUser(companyId) {
  const adminRole = await Role.findOne({ name: "admin" }).select("_id");
  if (!adminRole) return null;

  // First try admin mapped to this company (if you store it in "companies")
  let adminUser = null;
  if (companyId) {
    adminUser = await User.findOne({
      role: adminRole._id,
      companies: companyId,
    }).select("_id");
  }
  // Fallback: any admin
  if (!adminUser) {
    adminUser = await User.findOne({ role: adminRole._id }).select("_id");
  }
  return adminUser;
}

module.exports = {
  resolveActor,
  findAdminUser,
};
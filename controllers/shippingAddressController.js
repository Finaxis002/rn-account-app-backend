const ShippingAddress = require("../models/ShippingAddress");
const { getEffectivePermissions } = require("../services/effectivePermissions");
const { createNotification } = require("./notificationController");
const { resolveActor, findAdminUser } = require("../utils/actorUtils");

const PRIV_ROLES = new Set(["master", "client", "admin"]);

function userIsPriv(req) {
  return PRIV_ROLES.has(req.auth?.role);
}

async function ensureAuthCaps(req) {
  if (!req.auth && req.user) {
    req.auth = {
      clientId: req.user.id,
      userId: req.user.userId || req.user.id,
      role: req.user.role,
      caps: req.user.caps,
      allowedCompanies: req.user.allowedCompanies,
      userName: req.user.userName,
      clientName: req.user.contactName,
    };
  }
  if (!req.auth) throw new Error("Unauthorized (no auth context)");

  if (!req.auth.caps || !Array.isArray(req.auth.allowedCompanies)) {
    const { caps, allowedCompanies } = await getEffectivePermissions({
      clientId: req.auth.clientId,
      userId: req.auth.userId,
    });
    if (!req.auth.caps) req.auth.caps = caps;
    if (!req.auth.allowedCompanies) req.auth.allowedCompanies = allowedCompanies;
  }
}

exports.createShippingAddress = async (req, res) => {
  try {
    await ensureAuthCaps(req);

    if (!PRIV_ROLES.has(req.auth.role) && !req.auth.caps?.canCreateCustomers) {
      return res.status(403).json({ message: "Not allowed to create shipping addresses" });
    }

    const {
      party,
      label,
      address,
      city,
      state,
      pincode,
      contactNumber,
    } = req.body;

    const shippingAddress = await ShippingAddress.create({
      party,
      label,
      address,
      city,
      state,
      pincode,
      contactNumber,
      createdByClient: req.auth.clientId,
      createdByUser: req.auth.userId,
    });

    res.status(201).json({ message: "Shipping address created", shippingAddress });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(400).json({ message: "Shipping address with this label already exists for this party" });
    }
    res.status(500).json({ message: "Server error", error: err.message });
  }
};

exports.getShippingAddresses = async (req, res) => {
  try {
    await ensureAuthCaps(req);

    const { partyId } = req.params;

    const where = {
      createdByClient: req.auth.clientId,
      party: partyId
    };

    const shippingAddresses = await ShippingAddress.find(where).sort({ createdAt: -1 }).lean();

    res.json({ shippingAddresses });
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
};

exports.updateShippingAddress = async (req, res) => {
  try {
    await ensureAuthCaps(req);

    const doc = await ShippingAddress.findById(req.params.id);
    if (!doc) return res.status(404).json({ message: "Shipping address not found" });

    const sameTenant = String(doc.createdByClient) === req.auth.clientId;
    if (!PRIV_ROLES.has(req.auth.role) && !sameTenant) {
      return res.status(403).json({ message: "Not authorized" });
    }

    Object.assign(doc, req.body);
    await doc.save();

    res.json({ message: "Shipping address updated", shippingAddress: doc });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(400).json({ message: "Shipping address with this label already exists for this party" });
    }
    res.status(500).json({ message: "Server error", error: err.message });
  }
};

exports.deleteShippingAddress = async (req, res) => {
  try {
    await ensureAuthCaps(req);

    const doc = await ShippingAddress.findById(req.params.id);
    if (!doc) return res.status(404).json({ message: "Shipping address not found" });

    const sameTenant = String(doc.createdByClient) === req.auth.clientId;
    if (!PRIV_ROLES.has(req.auth.role) && !sameTenant) {
      return res.status(403).json({ message: "Not authorized" });
    }

    await doc.deleteOne();

    res.json({ message: "Shipping address deleted successfully" });
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
};
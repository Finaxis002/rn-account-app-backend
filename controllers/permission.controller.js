const mongoose = require("mongoose");
const Permission = require("../models/Permission");
const Client = require("../models/Client");
const { broadcastToClient } = require("../websocketServer");

const { isValidObjectId } = mongoose;

const pickAllowed = (payload = {}) => {
  const allowed = [
    "canCreateUsers",
    "canCreateProducts",
    "canCreateCustomers",
    "canCreateVendors",
    "canSendInvoiceEmail",
    "canSendInvoiceWhatsapp",
    "maxCompanies",
    "maxInventories",
    "maxUsers",
    "planCode",
    "canCreateCompanies",
    "canUpdateCompanies", // Make sure this is included
    "canCreateInventory", // You seem to have this in model but not in pickAllowed
  ];
  return Object.fromEntries(
    Object.entries(payload).filter(([k]) => allowed.includes(k))
  );
};
exports.getClientPermissions = async (req, res) => {
  try {
    const { clientId } = req.params;

    if (!isValidObjectId(clientId)) {
      return res.status(400).json({ message: "Invalid clientId" });
    }

    const exists = await Client.exists({ _id: clientId });
    if (!exists) return res.status(404).json({ message: "Client not found" });

    const doc = await Permission.findOne({ client: clientId }).lean();
    if (!doc) return res.status(404).json({ message: "Permissions not set" });

    return res.json(doc);
  } catch (err) {
    console.error(err);
    return res
      .status(500)
      .json({ message: "Server error", detail: err.message });
  }
};

exports.upsertClientPermissions = async (req, res) => {
  try {
    const { clientId } = req.params;
    const byUser = req.user?._id;

    if (!isValidObjectId(clientId)) {
      return res.status(400).json({ message: "Invalid clientId" });
    }

    const exists = await Client.exists({ _id: clientId });
    if (!exists) return res.status(404).json({ message: "Client not found" });

    // AFTER — merge validated over body, so missing keys from the validator aren’t dropped
    const source =
      req.validated && Object.keys(req.validated).length
        ? { ...req.body, ...req.validated }
        : req.body;

    const update = {
      ...pickAllowed(source),
      updatedBy: byUser || undefined,
    };

    const doc = await Permission.findOneAndUpdate(
      { client: clientId },
      { $set: update, $setOnInsert: { client: clientId } },
      { new: true, upsert: true, runValidators: true }
    ).lean();

    // Emit the updated permissions to all connected clients of this client
    broadcastToClient(clientId, { type: 'PERMISSION_UPDATE', data: doc });

    return res.json(doc);
  } catch (err) {
    console.error(err);
    return res
      .status(500)
      .json({ message: "Server error", detail: err.message });
  }
};

exports.patchClientPermissions = async (req, res) => {
  try {
    const { clientId } = req.params;
    const byUser = req.user?._id;

    if (!isValidObjectId(clientId)) {
      return res.status(400).json({ message: "Invalid clientId" });
    }

    const exists = await Client.exists({ _id: clientId });
    if (!exists) return res.status(404).json({ message: "Client not found" });
    console.log("Incoming payload:", req.body); // Add this

    const update = {
      ...pickAllowed(req.validated ?? req.body),
      updatedBy: byUser || undefined,
    };
    console.log("Filtered update:", update); // Add this

    const doc = await Permission.findOneAndUpdate(
      { client: clientId },
      { $set: update },
      { new: true, runValidators: true }
    ).lean();

    if (!doc) {
      const created = await Permission.create({ client: clientId, ...update });
      // Emit the updated permissions to all connected clients of this client
      broadcastToClient(clientId, { type: 'PERMISSION_UPDATE', data: created });
      return res.json(created);
    }

    // Emit the updated permissions to all connected clients of this client
    broadcastToClient(clientId, { type: 'PERMISSION_UPDATE', data: doc });

    return res.json(doc);
  } catch (err) {
    console.error(err);
    return res
      .status(500)
      .json({ message: "Server error", detail: err.message });
  }
};

exports.deleteClientPermissions = async (req, res) => {
  try {
    const { clientId } = req.params;

    if (!isValidObjectId(clientId)) {
      return res.status(400).json({ message: "Invalid clientId" });
    }

    await Permission.deleteOne({ client: clientId });
    return res.json({ success: true });
  } catch (err) {
    console.error(err);
    return res
      .status(500)
      .json({ message: "Server error", detail: err.message });
  }
};

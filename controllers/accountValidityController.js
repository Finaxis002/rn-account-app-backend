// controllers/accountValidityController.js
const AccountValidity = require("../models/AccountValidity");
const { computeExpiry } = require("../utils/validity");

exports.setValidity = async (req, res) => {
  try {
    const { clientId } = req.params;
    const { years = 0, months = 0, days = 0, startAt, notes } = req.body;

    const start = startAt ? new Date(startAt) : new Date();
    const expiresAt = computeExpiry(start, { years, months, days });
    if (!(expiresAt instanceof Date) || isNaN(expiresAt.getTime()) || expiresAt <= start) {
      return res.status(400).json({ message: "Invalid validity duration." });
    }

    const doc = await AccountValidity.findOneAndUpdate(
      { client: clientId },
      { $set: { client: clientId, startAt: start, expiresAt, status: "active", notes } },
      { upsert: true, new: true, runValidators: true }
    );

    return res.json({ ok: true, validity: doc });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

exports.getValidity = async (req, res) => {
  try {
    const { clientId } = req.params;
    const v = await AccountValidity.findOne({ client: clientId });
    if (!v) return res.status(404).json({ message: "No validity set." });
    return res.json({ ok: true, validity: v });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

exports.disableValidity = async (req, res) => {
  try {
    const { clientId } = req.params;
    const v = await AccountValidity.findOneAndUpdate(
      { client: clientId },
      { $set: { status: "disabled" } },
      { new: true }
    );
    if (!v) return res.status(404).json({ message: "No validity set." });
    return res.json({ ok: true, validity: v });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};



exports.updateValidityPartial = async (req, res) => {
  try {
    const { clientId } = req.params;
    const { status, years, months, days, startAt, notes, expiresAt } = req.body;

    // Build an update doc only with provided fields
    const $set = {};
    if (typeof notes === "string") $set.notes = notes;
    if (status) $set.status = status; // "active" | "expired" | "suspended" | "unlimited" | "disabled"

    // Allow direct expiresAt OR compute from duration+startAt
    if (expiresAt) {
      const dt = new Date(expiresAt);
      if (isNaN(dt.getTime())) return res.status(400).json({ message: "Invalid expiresAt" });
      $set.expiresAt = dt;
    } else if (years != null || months != null || days != null) {
      const start = startAt ? new Date(startAt) : new Date();
      const exp = require("../utils/validity").computeExpiry(start, {
        years: years ?? 0, months: months ?? 0, days: days ?? 0,
      });
      if (!(exp instanceof Date) || isNaN(exp.getTime()) || exp <= start) {
        return res.status(400).json({ message: "Invalid validity duration." });
      }
      $set.startAt = start;
      $set.expiresAt = exp;
      // If we’re extending, it’s usually “active”
      if (!status) $set.status = "active";
    }

    if (Object.keys($set).length === 0) {
      return res.status(400).json({ message: "No valid fields to update." });
    }

    const doc = await AccountValidity.findOneAndUpdate(
      { client: clientId },
      { $set },
      { new: true, upsert: false } // PATCH doesn't create; use PUT for create
    );

    if (!doc) return res.status(404).json({ message: "No validity set." });
    return res.json({ ok: true, validity: doc });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// In controllers/accountValidityController.js - update getMyValidity function
exports.getMyValidity = async (req, res) => {
  try {
    // Get client ID from verifyClientOrAdmin middleware (from req.auth)
    const clientId = req.auth.userId; // Use req.auth.userId from verifyClientOrAdmin
    console.log("Client checking own validity:", clientId);
    
    const v = await AccountValidity.findOne({ client: clientId });
    if (!v) return res.status(404).json({ message: "No validity set." });
    return res.json({ ok: true, validity: v });
  } catch (err) {
    console.error("Error in getMyValidity:", err);
    return res.status(500).json({ message: err.message });
  }
};
// routes/roleRoutes.js
const express = require("express");
const router = express.Router();
const Role = require("../models/Role");
// If you want to restrict, add your requirePermission middleware here.

router.get("/", async (req, res) => {
  const isMaster = String(req.user?.role || "").toLowerCase() === "master";
  const filter = isMaster ? {} : { name: { $ne: "master" } };
  const roles = await Role.find(filter).sort({ rank: -1 }).lean();
  res.json(roles);
});

router.post("/", async (req, res) => {
  try {
    const rawName = String(req.body.name || "");
    if (!rawName) return res.status(400).json({ message: "name is required" });

    const name = rawName.toLowerCase().trim();
    if (["master", "master-admin", "superadmin"].includes(name)) {
      return res.status(403).json({ message: "Creating 'master' is not allowed" });
    }

    const defaultPermissions = Array.isArray(req.body.defaultPermissions)
      ? req.body.defaultPermissions
      : [];

    const role = await Role.create({ name, defaultPermissions });
    res.status(201).json(role);
  } catch (e) {
    if (e.code === 11000) return res.status(400).json({ message: "Role name already exists" });
    res.status(500).json({ message: e.message });
  }
});


module.exports = router;

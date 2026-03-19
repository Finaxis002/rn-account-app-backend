const Unit = require("../models/Unit");


// POST /api/units
exports.createUnit = async (req, res) => {
  try {
    const { name } = req.body;
    const normalizedName = name.trim().toLowerCase();

    // ✅ ALWAYS use tenant from token and also track the actor
    const unit = await Unit.create({
      name: normalizedName,
      createdByClient: req.auth.clientId, // tenant id
      createdByUser: req.auth.userId,   // who created it
    });





    return res.status(201).json({ message: "Unit created", unit });
  } catch (err) {
    if (err.code === 11000) {
      // duplicate name
      return res.status(400).json({ message: "Unit already exists for this client" });
    }
    return res.status(500).json({ message: "Server error", error: err.message });
  }
};

// GET /api/units
exports.getUnits = async (req, res) => {
  try {
    // ✅ scope by tenant
    const clientId = req.auth.clientId;
    const cacheKey = `units:client:${clientId}`;








    const units = await Unit.find({ createdByClient: clientId })
      .sort({ createdAt: -1 })
      .lean();





    return res.json(units);
  } catch (err) {
    return res.status(500).json({ message: "Server error", error: err.message });
  }
};

// DELETE /api/units/:id
exports.deleteUnit = async (req, res) => {
  try {
    const unitId = req.params.id;

    const unit = await Unit.findById(unitId);
    if (!unit) return res.status(404).json({ message: "Unit not found" });

    // ✅ authorize by tenant
    const sameTenant = unit.createdByClient.toString() === req.auth.clientId;
    const privileged = ["master", "client", "admin"].includes(req.auth.role);
    if (!sameTenant && !privileged) {
      return res.status(403).json({ message: "Not authorized to delete this unit" });
    }

    // Check if unit is used by any products
    const Product = require("../models/Product");
    const productsUsingUnit = await Product.find({ createdByClient: req.auth.clientId, unit: unit.name });
    if (productsUsingUnit.length > 0) {
      return res.status(400).json({ message: "Cannot delete unit that is being used by products" });
    }

    await unit.deleteOne();





    return res.status(200).json({ message: "Unit deleted successfully" });
  } catch (err) {
    return res.status(500).json({ message: "Server error", error: err.message });
  }
};
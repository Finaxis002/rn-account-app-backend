const express = require("express");
const router = express.Router();
const unitController = require("../controllers/unitController");
const verifyClientOrAdmin = require("../middleware/verifyClientOrAdmin");

router.post("/", verifyClientOrAdmin, unitController.createUnit);
router.get("/", verifyClientOrAdmin, unitController.getUnits);
router.delete("/:id", verifyClientOrAdmin, unitController.deleteUnit);

module.exports = router;
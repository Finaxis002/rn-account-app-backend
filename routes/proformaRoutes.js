const express = require("express");
const router = express.Router();
const verifyClientOrAdmin = require("../middleware/verifyClientOrAdmin");
const verifyMasterAdmin = require("../middleware/verifyMasterAdmin");
const proformaController = require("../controllers/proformaController");

// Create Proforma Entry
router.post("/", verifyClientOrAdmin, proformaController.createProformaEntry);

// Get All Proforma Entries of Logged-in Client
router.get("/", verifyClientOrAdmin, proformaController.getProformaEntries);
router.delete("/:id", verifyClientOrAdmin, proformaController.deleteProformaEntry);
router.put("/:id", verifyClientOrAdmin, proformaController.updateProformaEntry);
router.get("/by-client/:clientId", verifyMasterAdmin, proformaController.getProformaEntriesByClient);
router.put("/", verifyClientOrAdmin, proformaController.updateProformaEntry);

module.exports = router;
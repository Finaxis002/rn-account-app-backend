const express = require("express");
const router = express.Router();
const verifyClientOrAdmin = require("../middleware/verifyClientOrAdmin");
const vendorController = require("../controllers/vendorController");
const { route } = require("./userRoutes");
const multer = require("multer");

// Multer config
const storage = multer.memoryStorage(); // Ya diskStorage agar file save karni ho
const upload = multer({ storage });
// Create Product
router.post("/", verifyClientOrAdmin, vendorController.createVendor);
router.get("/", verifyClientOrAdmin, vendorController.getVendors);
router.get("/:vendorId/balance", verifyClientOrAdmin, vendorController.getVendorBalance);
router.get("/balances", verifyClientOrAdmin, vendorController.getVendorBalancesBulk); // bulk
router.get("/:id", verifyClientOrAdmin, vendorController.getVendor);
router.put("/:id", verifyClientOrAdmin, vendorController.updateVendor);
router.delete("/:id", verifyClientOrAdmin, vendorController.deleteVendor);
//  IMPORT TEMPLATE ROUTE
router.get("/import/template",verifyClientOrAdmin,vendorController.downloadImportTemplate);

//  IMPORT FILE ROUTE 
router.post("/import",verifyClientOrAdmin,upload.single("file"), vendorController.importVendors);

module.exports = router;

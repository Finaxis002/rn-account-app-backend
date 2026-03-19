// routes/whatsapp.routes.js
const express = require("express");
const router = express.Router();
const verifyClientOrAdmin = require("../middleware/verifyClientOrAdmin");
const whatsappController = require("../controllers/whatsapp.controller");

// Initialize WhatsApp session and get QR code
router.post("/initialize", verifyClientOrAdmin, whatsappController.initializeWhatsApp);

// Get current session status
router.get("/status", verifyClientOrAdmin, whatsappController.getSessionStatus);

// Send message to vendor (automated for staff, manual for owner)
router.post("/send-message", verifyClientOrAdmin, whatsappController.sendMessage);
// Send bulk messages to multiple vendors
router.post("/send-bulk-messages", verifyClientOrAdmin, whatsappController.sendBulkVendorMessages);

// Logout from WhatsApp
router.post("/logout", verifyClientOrAdmin, whatsappController.logoutWhatsApp);

// routes/whatsapp.routes.js
router.get("/debug-state", verifyClientOrAdmin, whatsappController.debugServiceState);

module.exports = router;
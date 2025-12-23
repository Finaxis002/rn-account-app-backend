const express = require("express");
const router = express.Router();
const verifyClientOrAdmin = require("../middleware/verifyClientOrAdmin");
const whatsappController = require("../controllers/whatsappController");

// Route to send WhatsApp messages
router.post("/send-whatsapp", verifyClientOrAdmin, whatsappController.sendMessage);

module.exports = router;

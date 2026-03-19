// routes/whatsappConnectionRoutes.js
const express = require('express');
const router = express.Router();
const whatsappConnectionController = require('../controllers/whatsappConnectionController');
const verifyClientOrAdmin = require('../middleware/verifyClientOrAdmin');

// Apply authentication to all routes
router.use(verifyClientOrAdmin);

// @desc    Get active WhatsApp connection for client
// @route   GET /api/whatsapp/connection
// @access  Private (All authenticated users in client)
router.get('/connection', whatsappConnectionController.getClientConnection);

// @desc    Check connection status
// @route   GET /api/whatsapp/connection/status
// @access  Private (All authenticated users in client)
router.get('/connection/status', whatsappConnectionController.checkConnectionStatus);

// @desc    Create or update WhatsApp connection
// @route   POST /api/whatsapp/connection
// @access  Private (Customer role only - boss/admin)
router.post('/connection', whatsappConnectionController.createConnection);

// @desc    Delete (deactivate) WhatsApp connection
// @route   DELETE /api/whatsapp/connection
// @access  Private (Customer role only - boss/admin)
router.delete('/connection', whatsappConnectionController.deleteConnection);

// @desc    Get connection history
// @route   GET /api/whatsapp/connection/history
// @access  Private (Customer role only - boss/admin)
router.get('/connection/history', whatsappConnectionController.getConnectionHistory);

module.exports = router;
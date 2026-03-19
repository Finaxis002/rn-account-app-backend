const express = require("express");
const router = express.Router();
const updateNotificationController = require("../controllers/updateNotificationController");

const verifyMasterAdmin = require("../middleware/verifyMasterAdmin");
const auth = require("../middleware/auth");

// Create a new update notification (only master admin can create)
router.post("/", verifyMasterAdmin, updateNotificationController.createUpdateNotification);

// Get update notifications for a specific master admin
router.get("/master/:masterId", verifyMasterAdmin, updateNotificationController.getUpdateNotificationsForMaster);

// Mark a section as explored
router.patch("/explore-section", auth.authenticateToken, updateNotificationController.markSectionAsExplored);

// Dismiss an update notification
router.patch("/dismiss/:notificationId", auth.authenticateToken, updateNotificationController.dismissUpdateNotification);

// Propagate update notification to clients
router.post("/propagate/:notificationId", verifyMasterAdmin, updateNotificationController.propagateToClients);

// Propagate to all users (clients and their users)
router.post("/propagate-all/:notificationId", verifyMasterAdmin, updateNotificationController.propagateToAllUsers);

// Propagate to admins only (clients only, not their users)
router.post("/propagate-admins/:notificationId", verifyMasterAdmin, updateNotificationController.propagateToAdminsOnly);

// Get update notifications for users (propagated notifications)
router.get("/user/:userId", auth.authenticateToken, updateNotificationController.getUpdateNotificationsForUser);

// Get all update notifications (for admin dashboard)
router.get("/", verifyMasterAdmin, updateNotificationController.getAllUpdateNotifications);

module.exports = router;
const express = require("express");
const router = express.Router();
const notificationController = require("../controllers/notificationController");

const verifyMasterAdmin = require("../middleware/verifyMasterAdmin")

// Route to create a new notification
router.post("/", notificationController.createNotification);

// Route to fetch all notifications (for admins/master users)
router.get("/", notificationController.getAllNotifications);

// Route to fetch notifications for a specific client
router.get("/client/:clientId", notificationController.getClientNotifications);

router.get("/user/:userId", notificationController.getUserNotifications);

router.get("/master/:clientId",verifyMasterAdmin, notificationController.getClientNotificationsByMaster);


// Route to mark a notification as read
router.patch("/mark-as-read/:notificationId", notificationController.markNotificationAsRead);

// Route to mark all notifications as read for a user
router.patch("/mark-all-read", notificationController.markAllNotificationsAsRead);

module.exports = router;
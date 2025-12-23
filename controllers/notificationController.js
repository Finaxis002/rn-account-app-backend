const Notification = require("../models/Notification");
const User = require("../models/User");
const Client = require("../models/Client");

// Create a new notification
exports.createNotification = async (message, recipientId, senderId, actionType, entryType, entryId, clientId) => {
  try {
    const notification = new Notification({
      title: `${actionType.charAt(0).toUpperCase() + actionType.slice(1)} - ${entryType}`,
      message: message,
      type: entryType,
      action: actionType,
      entityId: entryId,
      entityType: entryType,
      recipient: recipientId,
      triggeredBy: senderId,
      client: clientId,
      read: false,
    });

    await notification.save();

    // Emit real-time notification to connected clients
    if (global.io) {
      console.log('📡 Emitting notification to rooms:', `user-${recipientId}`, clientId ? `client-${clientId}` : 'no client');
      // Emit to user-specific room
      global.io.to(`user-${recipientId}`).emit('notification', {
        _id: notification._id,
        title: notification.title,
        message: notification.message,
        type: notification.type,
        action: notification.action,
        entityId: notification.entityId,
        entityType: notification.entityType,
        recipient: notification.recipient,
        triggeredBy: notification.triggeredBy,
        client: notification.client,
        read: notification.read,
        metadata: {
          createdAt: notification.createdAt,
          updatedAt: notification.updatedAt,
        },
        createdAt: notification.createdAt,
      });

      // Also emit to client room if clientId is provided
      if (clientId) {
        global.io.to(`client-${clientId}`).emit('notification', {
          _id: notification._id,
          title: notification.title,
          message: notification.message,
          type: notification.type,
          action: notification.action,
          entityId: notification.entityId,
          entityType: notification.entityType,
          recipient: notification.recipient,
          triggeredBy: notification.triggeredBy,
          client: notification.client,
          read: notification.read,
          metadata: {
            createdAt: notification.createdAt,
            updatedAt: notification.updatedAt,
          },
          createdAt: notification.createdAt,
        });
      }
    }

    return notification;
  } catch (err) {
    console.error("Error creating notification:", err);
    throw new Error("Failed to create notification");
  }
};

// Fetch all notifications (for admins)
exports.getAllNotifications = async (req, res) => {
  try {
    const notifications = await Notification.find({})
      .populate("triggeredBy", "userName email")
      .populate("recipient", "userName email")
      .populate("client", "businessName")
      .sort({ createdAt: -1 })
      .lean();
    
    res.status(200).json({ notifications });
  } catch (err) {
    console.error("Error fetching all notifications:", err);
    res.status(500).json({ message: "Failed to fetch notifications" });
  }
};

// Fetch notifications for a specific client (by client ID)
exports.getClientNotifications = async (req, res) => {
  try {
    const { clientId } = req.params;
    const notifications = await Notification.find({ client: clientId })
      .populate("triggeredBy", "userName email")
      .populate("recipient", "userName email")
      .sort({ createdAt: -1 })
      .lean();
    
    res.status(200).json({ notifications });
  } catch (err) {
    console.error("Error fetching client notifications:", err);
    res.status(500).json({ message: "Failed to fetch client notifications" });
  }
};

// NEW: Fetch notifications for a specific user (by user ID)
exports.getUserNotifications = async (req, res) => {
  try {
    const { userId } = req.params;
    const notifications = await Notification.find({ recipient: userId })
      .populate("triggeredBy", "userName email")
      .populate("client", "businessName")
      .sort({ createdAt: -1 })
      .lean();
    
    res.status(200).json({ notifications });
  } catch (err) {
    console.error("Error fetching user notifications:", err);
    res.status(500).json({ message: "Failed to fetch user notifications" });
  }
};

// Mark notification as read
exports.markNotificationAsRead = async (req, res) => {
  try {
    const { notificationId } = req.params;
    const notification = await Notification.findByIdAndUpdate(
      notificationId, 
      { read: true }, 
      { new: true }
    );
    
    res.status(200).json({ notification });
  } catch (err) {
    console.error("Error marking notification as read:", err);
    res.status(500).json({ message: "Failed to mark notification as read" });
  }
};

// Mark all notifications as read for a user
exports.markAllNotificationsAsRead = async (req, res) => {
  try {
    const { userId } = req.body;
    await Notification.updateMany(
      { recipient: userId, read: false },
      { read: true }
    );
    
    res.status(200).json({ message: "All notifications marked as read" });
  } catch (err) {
    console.error("Error marking all notifications as read:", err);
    res.status(500).json({ message: "Failed to mark all notifications as read" });
  }
};


// Fetch notifications for a specific client, only accessible by master-admin
// Fetch notifications for a specific client, only accessible by master-admin
exports.getClientNotificationsByMaster = async (req, res) => {
  try {
    // Use req.user from middleware
    if (!req.user || req.user.role !== 'master') {
      return res.status(403).json({ message: 'Unauthorized access' });
    }

    const { clientId } = req.params;

    const notifications = await Notification.find({ client: clientId })
      .populate("triggeredBy", "userName email")
      .populate("recipient", "userName email")
      .populate("client", "businessName")
      .sort({ createdAt: -1 })
      .lean();

    if (!notifications || notifications.length === 0) {
      return res.status(404).json({ message: `No notifications found for client ${clientId}` });
    }

    res.status(200).json({ notifications });
  } catch (err) {
    console.error("Error fetching client notifications by master-admin:", err);
    res.status(500).json({ message: "Failed to fetch client notifications" });
  }
};

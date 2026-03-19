const UpdateNotification = require("../models/UpdateNotification");
const MasterAdmin = require("../models/MasterAdmin");
const Client = require("../models/Client");
const User = require("../models/User");
const Notification = require("../models/Notification"); // For propagating to clients

// Create a new update notification for master admins
exports.createUpdateNotification = async (req, res) => {
  try {
    const { title, description, version, features } = req.body;

    // Validate required fields
    if (!title || !description || !version || !features || !Array.isArray(features)) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    // Get all master admins
    const masterAdmins = await MasterAdmin.find({});

    if (masterAdmins.length === 0) {
      return res.status(404).json({ message: "No master admins found" });
    }

    // Create notification for each master admin
    const notifications = [];
    for (const admin of masterAdmins) {
      const notification = new UpdateNotification({
        title,
        description,
        version,
        features,
        recipient: admin._id
      });
      await notification.save();
      notifications.push(notification);
    }

    // Emit real-time update via WebSocket (assuming io is available globally)
    if (global.io) {
      for (const admin of masterAdmins) {
        global.io.to(`master-${admin._id}`).emit('newUpdateNotification', {
          message: 'New update available',
          notification: notifications.find(n => n.recipient.toString() === admin._id.toString())
        });
      }
    }

    res.status(201).json({
      message: `Update notification created for ${notifications.length} master admin(s)`,
      notifications
    });
  } catch (err) {
    console.error("Error creating update notification:", err);
    res.status(500).json({ message: "Failed to create update notification" });
  }
};

// Get update notifications for a specific master admin
exports.getUpdateNotificationsForMaster = async (req, res) => {
  try {
    const { masterId } = req.params;

    const notifications = await UpdateNotification.find({
      recipient: masterId,
      dismissed: false
    })
    .sort({ createdAt: -1 })
    .lean();

    res.status(200).json({ notifications });
  } catch (err) {
    console.error("Error fetching update notifications:", err);
    res.status(500).json({ message: "Failed to fetch update notifications" });
  }
};

// Mark a section as explored
exports.markSectionAsExplored = async (req, res) => {
  try {
    const { notificationId, sectionUrl } = req.body;

    const notification = await UpdateNotification.findById(notificationId);

    if (!notification) {
      return res.status(404).json({ message: "Update notification not found" });
    }

    // Check if section exists in features
    const featureExists = notification.features.some(f => f.sectionUrl === sectionUrl);
    if (!featureExists) {
      return res.status(400).json({ message: "Invalid section URL" });
    }

    // Add to explored sections if not already there
    if (!notification.exploredSections.includes(sectionUrl)) {
      notification.exploredSections.push(sectionUrl);
      await notification.save();
    }

    // Check if fully explored and auto-dismiss
    if (notification.isFullyExplored && !notification.dismissed) {
      notification.dismissed = true;
      await notification.save();

      // Emit dismissal event
      if (global.io) {
        global.io.to(`master-${notification.recipient}`).emit('updateNotificationDismissed', {
          notificationId: notification._id
        });
      }
    }

    res.status(200).json({ notification });
  } catch (err) {
    console.error("Error marking section as explored:", err);
    res.status(500).json({ message: "Failed to mark section as explored" });
  }
};

// Manually dismiss an update notification
exports.dismissUpdateNotification = async (req, res) => {
  try {
    const { notificationId } = req.params;

    const notification = await UpdateNotification.findByIdAndUpdate(
      notificationId,
      { dismissed: true },
      { new: true }
    );

    if (!notification) {
      return res.status(404).json({ message: "Update notification not found" });
    }

    // Emit dismissal event
    if (global.io) {
      global.io.to(`master-${notification.recipient}`).emit('updateNotificationDismissed', {
        notificationId: notification._id
      });
    }

    res.status(200).json({ notification });
  } catch (err) {
    console.error("Error dismissing update notification:", err);
    res.status(500).json({ message: "Failed to dismiss update notification" });
  }
};

// Propagate update notification to clients and their users
exports.propagateToClients = async (req, res) => {
  try {
    const { notificationId } = req.params;

    const updateNotification = await UpdateNotification.findById(notificationId);

    if (!updateNotification) {
      return res.status(404).json({ message: "Update notification not found" });
    }

    if (updateNotification.propagatedToClients) {
      return res.status(400).json({ message: "Already propagated to clients" });
    }

    // Get all clients
    const clients = await Client.find({});

    // Create regular notifications for each client and their users
    const propagatedNotifications = [];

    for (const client of clients) {
      // Create notification for the client
      const clientNotification = new Notification({
        title: `New Update Available: ${updateNotification.title}`,
        message: `Version ${updateNotification.version} is now available. Check out the new features!`,
        type: 'system',
        action: 'update',
        entityId: updateNotification._id,
        entityType: 'UpdateNotification',
        recipient: client._id, // Assuming client can receive notifications
        triggeredBy: updateNotification.recipient, // Master admin who propagated
        client: client._id,
        read: false,
        metadata: {
          updateVersion: updateNotification.version,
          featuresCount: updateNotification.features.length
        }
      });
      await clientNotification.save();
      propagatedNotifications.push(clientNotification);

      // Also notify users of this client
      const users = await User.find({ client: client._id });
      for (const user of users) {
        const userNotification = new Notification({
          title: `New Update Available: ${updateNotification.title}`,
          message: `Version ${updateNotification.version} is now available for your account.`,
          type: 'system',
          action: 'update',
          entityId: updateNotification._id,
          entityType: 'UpdateNotification',
          recipient: user._id,
          triggeredBy: updateNotification.recipient,
          client: client._id,
          read: false,
          metadata: {
            updateVersion: updateNotification.version,
            featuresCount: updateNotification.features.length
          }
        });
        await userNotification.save();
        propagatedNotifications.push(userNotification);
      }
    }

    // Mark as propagated
    updateNotification.propagatedToClients = true;
    updateNotification.propagatedAt = new Date();
    await updateNotification.save();

    // Emit propagation event to clients
    if (global.io) {
      for (const notification of propagatedNotifications) {
        global.io.to(`client-${notification.client}`).emit('newNotification', {
          message: 'New update notification',
          notification
        });
        global.io.to(`user-${notification.recipient}`).emit('newNotification', {
          message: 'New update notification',
          notification
        });
      }
    }

    res.status(200).json({
      message: `Propagated to ${propagatedNotifications.length} recipients`,
      propagatedCount: propagatedNotifications.length
    });
  } catch (err) {
    console.error("Error propagating to clients:", err);
    res.status(500).json({ message: "Failed to propagate to clients" });
  }
};

// Propagate update notification to all users (clients and their users) - alias for propagateToClients
exports.propagateToAllUsers = async (req, res) => {
  try {
    const { notificationId } = req.params;

    const updateNotification = await UpdateNotification.findById(notificationId);

    if (!updateNotification) {
      return res.status(404).json({ message: "Update notification not found" });
    }

    if (updateNotification.propagatedToClients) {
      return res.status(400).json({ message: "Already propagated to clients" });
    }

    // Get all clients
    const clients = await Client.find({});

    // Create regular notifications for each client and their users
    const propagatedNotifications = [];

    for (const client of clients) {
      // Create notification for the client
      const clientNotification = new Notification({
        title: `New Update Available: ${updateNotification.title}`,
        message: `Version ${updateNotification.version} is now available. Check out the new features!`,
        type: 'system',
        action: 'update',
        entityId: updateNotification._id,
        entityType: 'UpdateNotification',
        recipient: client._id, // Assuming client can receive notifications
        triggeredBy: updateNotification.recipient, // Master admin who propagated
        client: client._id,
        read: false,
        metadata: {
          updateVersion: updateNotification.version,
          featuresCount: updateNotification.features.length
        }
      });
      await clientNotification.save();
      propagatedNotifications.push(clientNotification);

      // Also notify users of this client
      const users = await User.find({ client: client._id });
      for (const user of users) {
        const userNotification = new Notification({
          title: `New Update Available: ${updateNotification.title}`,
          message: `Version ${updateNotification.version} is now available for your account.`,
          type: 'system',
          action: 'update',
          entityId: updateNotification._id,
          entityType: 'UpdateNotification',
          recipient: user._id,
          triggeredBy: updateNotification.recipient,
          client: client._id,
          read: false,
          metadata: {
            updateVersion: updateNotification.version,
            featuresCount: updateNotification.features.length
          }
        });
        await userNotification.save();
        propagatedNotifications.push(userNotification);
      }
    }

    // Mark as propagated
    updateNotification.propagatedToClients = true;
    updateNotification.propagatedAt = new Date();
    updateNotification.visibility = 'all';
    await updateNotification.save();

    // Emit propagation event to clients
    if (global.io) {
      for (const notification of propagatedNotifications) {
        global.io.to(`client-${notification.client}`).emit('newNotification', {
          message: 'New update notification',
          notification
        });
        global.io.to(`user-${notification.recipient}`).emit('newNotification', {
          message: 'New update notification',
          notification
        });
      }
    }

    res.status(200).json({
      message: `Propagated to ${propagatedNotifications.length} recipients (all users)`,
      propagatedCount: propagatedNotifications.length
    });
  } catch (err) {
    console.error("Error propagating to all users:", err);
    res.status(500).json({ message: "Failed to propagate to all users" });
  }
};

// Propagate update notification to admins only (clients only, not their users)
exports.propagateToAdminsOnly = async (req, res) => {
  try {
    const { notificationId } = req.params;

    const updateNotification = await UpdateNotification.findById(notificationId);

    if (!updateNotification) {
      return res.status(404).json({ message: "Update notification not found" });
    }

    if (updateNotification.propagatedToClients) {
      return res.status(400).json({ message: "Already propagated to clients" });
    }

    // Get all clients
    const clients = await Client.find({});

    // Create regular notifications for each client only (not their users)
    const propagatedNotifications = [];

    for (const client of clients) {
      // Create notification for the client only
      const clientNotification = new Notification({
        title: `New Update Available: ${updateNotification.title}`,
        message: `Version ${updateNotification.version} is now available. Check out the new features!`,
        type: 'system',
        action: 'update',
        entityId: updateNotification._id,
        entityType: 'UpdateNotification',
        recipient: client._id, // Assuming client can receive notifications
        triggeredBy: updateNotification.recipient, // Master admin who propagated
        client: client._id,
        read: false,
        metadata: {
          updateVersion: updateNotification.version,
          featuresCount: updateNotification.features.length
        }
      });
      await clientNotification.save();
      propagatedNotifications.push(clientNotification);
    }

    // Mark as propagated
    updateNotification.propagatedToClients = true;
    updateNotification.propagatedAt = new Date();
    updateNotification.visibility = 'admins';
    await updateNotification.save();

    // Emit propagation event to clients only
    if (global.io) {
      for (const notification of propagatedNotifications) {
        global.io.to(`client-${notification.client}`).emit('newNotification', {
          message: 'New update notification',
          notification
        });
      }
    }

    res.status(200).json({
      message: `Propagated to ${propagatedNotifications.length} recipients (admins only)`,
      propagatedCount: propagatedNotifications.length
    });
  } catch (err) {
    console.error("Error propagating to admins only:", err);
    res.status(500).json({ message: "Failed to propagate to admins only" });
  }
};

// Get update notifications for users (propagated notifications)
exports.getUpdateNotificationsForUser = async (req, res) => {
  try {
    const { userId } = req.params;

    // For users, return all update notifications that have been propagated
    const notifications = await UpdateNotification.find({
      propagatedToClients: true,
      dismissed: false
    })
    .sort({ createdAt: -1 })
    .lean();

    res.status(200).json({ notifications });
  } catch (err) {
    console.error("Error fetching update notifications for user:", err);
    res.status(500).json({ message: "Failed to fetch update notifications" });
  }
};

// Get all update notifications (for admin dashboard)
exports.getAllUpdateNotifications = async (req, res) => {
  try {
    const notifications = await UpdateNotification.find({})
      .populate('recipient', 'userName email')
      .sort({ createdAt: -1 })
      .lean();

    res.status(200).json({ notifications });
  } catch (err) {
    console.error("Error fetching all update notifications:", err);
    res.status(500).json({ message: "Failed to fetch update notifications" });
  }
};
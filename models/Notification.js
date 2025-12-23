// // models/Notification.js
// const mongoose = require("mongoose");

// const notificationSchema = new mongoose.Schema({
//   message: {
//     type: String,
//     required: true,
//   },
//   recipient: {
//     type: mongoose.Schema.Types.ObjectId,
//     ref: "Client",  // Assuming Client model
//     required: true,
//   },
//   sender: {
//     type: mongoose.Schema.Types.ObjectId,
//     ref: "User",  // Assuming User model for the person who triggered the action
//     required: true,
//   },
//   actionType: {
//     type: String,
//     enum: ["create", "update", "delete"],
//     required: true,
//   },
//   entryType: {
//     type: String,
//     enum: ["transaction", "company", "user"], // You can extend this to other entry types
//     required: true,
//   },
//   entryId: {
//     type: mongoose.Schema.Types.ObjectId,
//     refPath: "entryType",
//     required: true,
//   },
//   read: {
//     type: Boolean,
//     default: false,
//   },
//   createdAt: {
//     type: Date,
//     default: Date.now,
//   },
// });

// const Notification = mongoose.model("Notification", notificationSchema);

// module.exports = Notification;




// models/Notification.js
const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true
  },
  message: {
    type: String,
    required: true
  },
  type: {
    type: String,
    enum: ['sales', 'purchase', 'journal', 'system', 'user' , 'payment', 'receipt', 'party', 'vendor', 'product', 'service', 'proforma'],
    required: true
  },
  action: {
    type: String,
    enum: ['create', 'update', 'delete', 'other'],
    required: true
  },
  // Reference to the entity that triggered the notification
  entityId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true
  },
  entityType: {
    type: String,
    required: true
  },
  // Who should receive this notification
  recipient: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  // Who triggered this notification
  triggeredBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  // Client context
  client: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Client',
    required: true
  },
  read: {
    type: Boolean,
    default: false
  },
  metadata: {
    type: Map,
    of: mongoose.Schema.Types.Mixed,
    default: {}
  }
}, {
  timestamps: true
});

// Index for efficient querying
notificationSchema.index({ recipient: 1, read: 1, createdAt: -1 });
notificationSchema.index({ client: 1, createdAt: -1 });

module.exports = mongoose.model('Notification', notificationSchema);
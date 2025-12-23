const mongoose = require('mongoose');

const updateNotificationSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true
  },
  description: {
    type: String,
    required: true
  },
  version: {
    type: String,
    required: true // e.g., "v1.2.3"
  },
  features: [{
    name: {
      type: String,
      required: true
    },
    sectionUrl: {
      type: String,
      required: true // URL path to redirect to, e.g., "/app/transactions"
    },
    gifUrl: {
      type: String,
      required: true // URL to the demonstration GIF
    },
    description: {
      type: String,
      required: true
    }
  }],
  recipient: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'MasterAdmin',
    required: true
  },
  exploredSections: [{
    type: String, // Array of section URLs that have been visited
    default: []
  }],
  dismissed: {
    type: Boolean,
    default: false
  },
  propagatedToClients: {
    type: Boolean,
    default: false
  },
  propagatedAt: {
    type: Date
  },
  visibility: {
    type: String,
    enum: ['all', 'admins'],
    default: 'all' // 'all' means clients + users, 'admins' means clients only
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
updateNotificationSchema.index({ recipient: 1, dismissed: 1, createdAt: -1 });

// Virtual to check if all sections are explored
updateNotificationSchema.virtual('isFullyExplored').get(function() {
  return this.exploredSections.length === this.features.length;
});

// Pre-save middleware to auto-dismiss when fully explored
updateNotificationSchema.pre('save', function(next) {
  if (this.isFullyExplored && !this.dismissed) {
    this.dismissed = true;
  }
  next();
});

module.exports = mongoose.model('UpdateNotification', updateNotificationSchema);
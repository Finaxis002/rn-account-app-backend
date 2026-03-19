// models/WhatsappSession.js
const mongoose = require('mongoose');

const whatsappSessionSchema = new mongoose.Schema({
  clientId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Client',
    required: true,
    index: true
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  sessionId: {
    type: String,
    required: true,
    unique: true
  },
  status: {
    type: String,
    enum: ['authenticating', 'authenticated', 'disconnected', 'error'],
    default: 'authenticating'
  },
  qrCode: String,
  phoneNumber: String,
  profileName: String,
  lastActivity: Date,
  isActive: {
    type: Boolean,
    default: true
  },
  metadata: {
    browserVersion: String,
    platform: String,
    connectedAt: Date
  }
}, {
  timestamps: true
});

// Compound index for active sessions per client
whatsappSessionSchema.index({ clientId: 1, isActive: 1 });

module.exports = mongoose.model('WhatsappSession', whatsappSessionSchema);
// models/WhatsappConnection.js
const mongoose = require("mongoose");

const whatsappConnectionSchema = new mongoose.Schema({
  client_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Client",
    required: true,
    index: true
  },
  phone_number: {
    type: String,
    required: true,
    trim: true
  },
  connected_by: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true
  },
  connected_by_name: {
    type: String,
    required: true,
    trim: true
  },
  connection_data: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  is_active: {
    type: Boolean,
    default: true,
    index: true
  },
  last_connected: {
    type: Date,
    default: Date.now
  },
  shared_with_users: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: "User"
  }],
  deactivated_by: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User"
  },
  deactivated_at: {
    type: Date
  }
}, {
  timestamps: true
});

// Compound index to ensure one active connection per client
whatsappConnectionSchema.index(
  { client_id: 1, is_active: 1 }, 
  { 
    unique: true, 
    partialFilterExpression: { is_active: true } 
  }
);

// Index for better query performance
whatsappConnectionSchema.index({ client_id: 1, createdAt: -1 });
whatsappConnectionSchema.index({ connected_by: 1 });

// Virtual for connection age
whatsappConnectionSchema.virtual('connectionAge').get(function() {
  return Date.now() - this.last_connected.getTime();
});

// Instance method to check if connection is expired (30 days)
whatsappConnectionSchema.methods.isExpired = function() {
  const thirtyDays = 30 * 24 * 60 * 60 * 1000; // 30 days in milliseconds
  return (Date.now() - this.last_connected.getTime()) > thirtyDays;
};

// Static method to get active connection by client ID
whatsappConnectionSchema.statics.findActiveByClientId = function(clientId) {
  return this.findOne({ client_id: clientId, is_active: true })
    .populate('connected_by', 'name email');
};

// Static method to deactivate all connections for a client
whatsappConnectionSchema.statics.deactivateAllForClient = function(clientId, deactivatedBy = null) {
  return this.updateMany(
    { client_id: clientId, is_active: true },
    { 
      is_active: false, 
      deactivated_by: deactivatedBy,
      deactivated_at: new Date()
    }
  );
};

module.exports = mongoose.model("WhatsappConnection", whatsappConnectionSchema);
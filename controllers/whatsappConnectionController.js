// controllers/whatsappConnectionController.js
const WhatsappConnection = require('../models/WhatsappConnection');
const { getEffectivePermissions } = require("../services/effectivePermissions");

const PRIV_ROLES = new Set(["master", "client", "admin"]);

function userIsPriv(req) {
  return PRIV_ROLES.has(req.auth?.role);
}

async function ensureAuthCaps(req) {
  // normalize legacy req.user → req.auth
  if (!req.auth && req.user) {
    req.auth = {
      clientId: req.user.id,
      userId: req.user.userId || req.user.id,
      role: req.user.role,
      caps: req.user.caps,
      allowedCompanies: req.user.allowedCompanies,
      userName: req.user.userName,
      clientName: req.user.contactName,
    };
  }
  if (!req.auth) throw new Error("Unauthorized (no auth context)");

  if (!req.auth.caps || !Array.isArray(req.auth.allowedCompanies)) {
    const { caps, allowedCompanies } = await getEffectivePermissions({
      clientId: req.auth.clientId,
      userId: req.auth.userId,
    });
    if (!req.auth.caps) req.auth.caps = caps;
    if (!req.auth.allowedCompanies) req.auth.allowedCompanies = allowedCompanies;
  }
}

// Get active WhatsApp connection for client
// exports.getClientConnection = async (req, res) => {
//   try {
//     await ensureAuthCaps(req);

//     const connection = await WhatsappConnection.findOne({
//       client_id: req.auth.clientId,
//       is_active: true
//     }).populate('connected_by', 'name email');

//     res.status(200).json({
//       success: true,
//       connection: connection || null
//     });
//   } catch (error) {
//     console.error('Error fetching WhatsApp connection:', error);
//     res.status(500).json({
//       success: false,
//       message: 'Failed to fetch WhatsApp connection',
//       error: error.message
//     });
//   }
// };

// controllers/whatsappConnectionController.js - UPDATED all methods
exports.getClientConnection = async (req, res) => {
  try {
    await ensureAuthCaps(req);

    const connection = await WhatsappConnection.findOne({
      client_id: req.auth.clientId,
      is_active: true,
      shared_with_users: req.auth.userId // Check if current user has access
    }).populate('connected_by', 'name email');

    console.log('🔍 Connection access check:', {
      userId: req.auth.userId,
      clientId: req.auth.clientId,
      hasConnection: !!connection,
      sharedWithUser: connection ? connection.shared_with_users.includes(req.auth.userId) : false
    });

    res.status(200).json({
      success: true,
      connection: connection || null,
      hasAccess: !!connection // Explicit access indicator
    });
  } catch (error) {
    console.error('Error fetching WhatsApp connection:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch WhatsApp connection',
      error: error.message
    });
  }
};

exports.checkConnectionStatus = async (req, res) => {
  try {
    await ensureAuthCaps(req);

    const connection = await WhatsappConnection.findOne({
      client_id: req.auth.clientId,
      is_active: true,
      shared_with_users: req.auth.userId // Check if current user has access
    });

    const hasActiveConnection = !!connection;
    const hasAccess = !!connection;

    console.log('🔍 Status check:', {
      userId: req.auth.userId,
      hasActiveConnection,
      hasAccess
    });

    res.status(200).json({
      success: true,
      hasActiveConnection,
      hasAccess,
      connection: connection || null,
      message: hasActiveConnection ? 
        (hasAccess ? 'Active WhatsApp connection found' : 'Connection exists but you do not have access') : 
        'No active WhatsApp connection'
    });
  } catch (error) {
    console.error('Error checking connection status:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to check connection status',
      error: error.message
    });
  }
};

// Create or update WhatsApp connection
// exports.createConnection = async (req, res) => {
//   try {
//     await ensureAuthCaps(req);

//     // permission gate (non-privileged must have explicit capability)
//     if (!PRIV_ROLES.has(req.auth.role) && !req.auth.caps?.canManageWhatsapp) {
//       return res.status(403).json({
//         success: false,
//         message: 'Access denied. Only customer (admin) users can manage WhatsApp connections.'
//       });
//     }

//     const { phoneNumber, connectionData } = req.body;

//     if (!phoneNumber) {
//       return res.status(400).json({
//         success: false,
//         message: 'Phone number is required'
//       });
//     }

//     // Deactivate any existing connection
//     await WhatsappConnection.updateMany(
//       { client_id: req.auth.clientId, is_active: true },
//       { is_active: false, updatedAt: new Date() }
//     );

//     // Create new connection
//     const newConnection = new WhatsappConnection({
//       client_id: req.auth.clientId,
//       phone_number: phoneNumber,
//       connected_by: req.auth.userId,
//       connected_by_name: req.auth.userName || 'System User',
//       connection_data: connectionData || {},
//       is_active: true,
//       shared_with_users: [req.auth.userId]
//     });

//     await newConnection.save();

//     // Populate the created connection
//     const populatedConnection = await WhatsappConnection.findById(newConnection._id)
//       .populate('connected_by', 'name email');

//     res.status(201).json({
//       success: true,
//       message: 'WhatsApp connection created successfully',
//       connection: populatedConnection
//     });
    
//   } catch (error) {
//     console.error('Error creating WhatsApp connection:', error);
    
//     // Handle duplicate key error (unique index violation)
//     if (error.code === 11000) {
//       return res.status(400).json({
//         success: false,
//         message: 'An active WhatsApp connection already exists for this client'
//       });
//     }

//     res.status(500).json({
//       success: false,
//       message: 'Failed to create WhatsApp connection',
//       error: error.message
//     });
//   }
// };

// controllers/whatsappConnectionController.js - FIXED
exports.createConnection = async (req, res) => {
  try {
    await ensureAuthCaps(req);

    // permission gate (non-privileged must have explicit capability)
    if (!PRIV_ROLES.has(req.auth.role) && !req.auth.caps?.canManageWhatsapp) {
      return res.status(403).json({
        success: false,
        message: 'Access denied. Only customer (admin) users can manage WhatsApp connections.'
      });
    }

    const { phoneNumber, connectionData } = req.body;

    if (!phoneNumber) {
      return res.status(400).json({
        success: false,
        message: 'Phone number is required'
      });
    }

    // Deactivate any existing connection
    await WhatsappConnection.updateMany(
      { client_id: req.auth.clientId, is_active: true },
      { is_active: false, updatedAt: new Date() }
    );

    // FIX: Get ALL users from this client using createdByClient field
    const User = require('../models/User');
    const clientUsers = await User.find({ 
      createdByClient: req.auth.clientId // Use createdByClient instead of client_id
    }).select('_id');

    console.log('🔍 Found users to share with:', {
      clientId: req.auth.clientId,
      userCount: clientUsers.length,
      users: clientUsers.map(u => u._id)
    });

    const sharedUserIds = clientUsers.map(user => user._id);

    // If no users found (shouldn't happen), at least include the current user
    if (sharedUserIds.length === 0) {
      sharedUserIds.push(req.auth.userId);
      console.log('⚠️ No other users found, sharing only with creator:', req.auth.userId);
    }

    // Create new connection - share with ALL client users
    const newConnection = new WhatsappConnection({
      client_id: req.auth.clientId,
      phone_number: phoneNumber,
      connected_by: req.auth.userId,
      connected_by_name: req.auth.userName || 'System User',
      connection_data: connectionData || {},
      is_active: true,
      shared_with_users: sharedUserIds // Share with ALL users in client
    });

    await newConnection.save();

    console.log('✅ Connection created with sharing:', {
      connectionId: newConnection._id,
      sharedWithCount: sharedUserIds.length,
      sharedWith: sharedUserIds
    });

    // Populate the created connection
    const populatedConnection = await WhatsappConnection.findById(newConnection._id)
      .populate('connected_by', 'name email');

    res.status(201).json({
      success: true,
      message: 'WhatsApp connection created and shared with team',
      connection: populatedConnection,
      sharedWith: sharedUserIds.length
    });
    
  } catch (error) {
    console.error('Error creating WhatsApp connection:', error);
    
    if (error.code === 11000) {
      return res.status(400).json({
        success: false,
        message: 'An active WhatsApp connection already exists for this client'
      });
    }

    res.status(500).json({
      success: false,
      message: 'Failed to create WhatsApp connection',
      error: error.message
    });
  }
};

// Delete (deactivate) WhatsApp connection
exports.deleteConnection = async (req, res) => {
  try {
    await ensureAuthCaps(req);

    // permission gate (non-privileged must have explicit capability)
    if (!PRIV_ROLES.has(req.auth.role) && !req.auth.caps?.canManageWhatsapp) {
      return res.status(403).json({
        success: false,
        message: 'Access denied. Only customer (admin) users can delete WhatsApp connections.'
      });
    }

    // Deactivate the connection (soft delete)
    const result = await WhatsappConnection.updateMany(
      { client_id: req.auth.clientId, is_active: true },
      { 
        is_active: false, 
        updatedAt: new Date(),
        deactivated_by: req.auth.userId,
        deactivated_at: new Date()
      }
    );

    if (result.modifiedCount === 0) {
      return res.status(404).json({
        success: false,
        message: 'No active WhatsApp connection found'
      });
    }

    res.status(200).json({
      success: true,
      message: 'WhatsApp connection deactivated successfully'
    });
  } catch (error) {
    console.error('Error deleting WhatsApp connection:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete WhatsApp connection',
      error: error.message
    });
  }
};

// Get connection history for client
exports.getConnectionHistory = async (req, res) => {
  try {
    await ensureAuthCaps(req);

    // permission gate (non-privileged must have explicit capability)
    if (!PRIV_ROLES.has(req.auth.role) && !req.auth.caps?.canManageWhatsapp) {
      return res.status(403).json({
        success: false,
        message: 'Access denied. Only customer (admin) users can view connection history.'
      });
    }

    const connections = await WhatsappConnection.find({
      client_id: req.auth.clientId
    })
    .populate('connected_by', 'name email')
    .populate('deactivated_by', 'name email')
    .sort({ createdAt: -1 });

    res.status(200).json({
      success: true,
      connections,
      count: connections.length
    });
  } catch (error) {
    console.error('Error fetching connection history:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch connection history',
      error: error.message
    });
  }
};

// Check if client has active connection
// exports.checkConnectionStatus = async (req, res) => {
//   try {
//     await ensureAuthCaps(req);

//     const connection = await WhatsappConnection.findOne({
//       client_id: req.auth.clientId,
//       is_active: true
//     });

//     const hasActiveConnection = !!connection;

//     res.status(200).json({
//       success: true,
//       hasActiveConnection,
//       connection: connection || null,
//       message: hasActiveConnection ? 
//         'Active WhatsApp connection found' : 
//         'No active WhatsApp connection'
//     });
//   } catch (error) {
//     console.error('Error checking connection status:', error);
//     res.status(500).json({
//       success: false,
//       message: 'Failed to check connection status',
//       error: error.message
//     });
//   }
// };
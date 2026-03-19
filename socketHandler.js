/**
 * Socket.IO Handler - Centralized socket connection and room management
 * This module handles all socket-related logic for better organization and maintainability
 */

/**
 * Setup socket event handlers for a given Socket.IO instance
 * @param {import('socket.io').Server} io - Socket.IO server instance
 */
function setupSocketHandlers(io) {
  console.log('🔌 Setting up Socket.IO handlers...');

  io.on('connection', (socket) => {
    console.log('🔌 User connected:', socket.id);

    // Join user-specific rooms for targeted notifications
    socket.on('joinRoom', (data) => {
      try {
        const { userId, role, clientId, room } = data;
        
        console.log('📋 Join room request:', { userId, role, clientId, room });
        
        // Handle direct room joins (e.g., "all-inventory-updates")
        if (room) {
          socket.join(room);
          console.log(`👤 User ${userId} joined direct room: ${room}`);
          return;
        }
        
        // Handle role-based room joins
        if (role === 'master') {
          socket.join(`master-${userId}`);
          socket.join('all-masters');
          socket.join('all-inventory-updates');
          socket.join('all-transactions-updates'); // 👇 NEW: Masters get transaction updates
          console.log(`👤 Master ${userId} joined: master-${userId}, all-masters, all-inventory-updates, all-transactions-updates`);
        } else if (['admin', 'client', 'user', 'customer'].includes(role)) {
          socket.join(`client-${clientId}`);
          socket.join(`user-${userId}`);
          socket.join('all-inventory-updates');
          socket.join('all-transactions-updates'); // 👇 NEW: Admins, clients, and users get transaction updates
          console.log(`👤 ${role} ${userId} joined: client-${clientId}, user-${userId}, all-inventory-updates, all-transactions-updates`);
        } else {
          console.warn(`🤔 Unknown role '${role}' for user ${userId}`);
        }
        
        console.log(`✅ User ${userId} successfully joined rooms`);
        
      } catch (error) {
        console.error('❌ Error in joinRoom:', error);
      }
    });

    socket.on('disconnect', () => {
      console.log('🔌 User disconnected:', socket.id);
    });

    // Add more socket event handlers here as needed
    // For example: private messaging, presence, etc.
  });

  console.log('✅ Socket.IO handlers setup complete');
}

/**
 * Get all sockets in a specific room
 * @param {import('socket.io').Server} io - Socket.IO server instance
 * @param {string} room - Room name
 * @returns {import('socket.io').Socket[]} Array of sockets in the room
 */
function getSocketsInRoom(io, room) {
  const sockets = [];
  const roomSockets = io.sockets.adapter.rooms.get(room);
  
  if (roomSockets) {
    roomSockets.forEach((socketId) => {
      const socket = io.sockets.sockets.get(socketId);
      if (socket) {
        sockets.push(socket);
      }
    });
  }
  
  return sockets;
}

/**
 * Broadcast to a specific room
 * @param {import('socket.io').Server} io - Socket.IO server instance
 * @param {string} room - Room name
 * @param {string} event - Event name
 * @param {any} data - Data to send
 */
function broadcastToRoom(io, room, event, data) {
  console.log(`📡 Broadcasting ${event} to room ${room}:`, data);
  io.to(room).emit(event, data);
}

module.exports = {
  setupSocketHandlers,
  getSocketsInRoom,
  broadcastToRoom
};
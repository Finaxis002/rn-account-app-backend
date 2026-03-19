// Use Socket.IO instead of native WebSocket to avoid conflicts
// The Socket.IO server is already integrated with the main HTTP server

// Store client connections by userId and clientId for targeted messaging
const clientsByUser = new Map(); // userId -> Set of Socket.IO connections
const clientsByClient = new Map(); // clientId -> Set of Socket.IO connections

function setupWebSocketServer(io) {
  console.log('WebSocket server using Socket.IO');

  io.on('connection', (socket) => {
    console.log('New WebSocket client connected via Socket.IO');

    // Handle authentication/identification message
    socket.on('IDENTIFY', (data) => {
      try {
        const { userId, clientId } = data;
        
        // Add to user-specific connections
        if (!clientsByUser.has(userId)) {
          clientsByUser.set(userId, new Set());
        }
        clientsByUser.get(userId).add(socket);
        
        // Add to client-specific connections
        if (!clientsByClient.has(clientId)) {
          clientsByClient.set(clientId, new Set());
        }
        clientsByClient.get(clientId).add(socket);
        
        console.log(`Client identified: userId=${userId}, clientId=${clientId}`);
      } catch (err) {
        console.error('Error processing IDENTIFY message:', err);
      }
    });

    socket.on('disconnect', () => {
      console.log('WebSocket client disconnected');
      // Cleanup: remove this connection from all sets
      clientsByUser.forEach((connections, userId) => {
        if (connections.has(socket)) {
          connections.delete(socket);
          if (connections.size === 0) {
            clientsByUser.delete(userId);
          }
        }
      });
      
      clientsByClient.forEach((connections, clientId) => {
        if (connections.has(socket)) {
          connections.delete(socket);
          if (connections.size === 0) {
            clientsByClient.delete(clientId);
          }
        }
      });
    });
  });
}

// Function to broadcast to specific user
function broadcastToUser(userId, message) {
  const connections = clientsByUser.get(userId);
  if (connections && connections.size > 0) {
    console.log(`Broadcasting to user ${userId}, connections: ${connections.size}`);
    connections.forEach((client) => {
      if (client.connected) {
        console.log(`Sending message to user ${userId}:`, message);
        client.emit('PERMISSION_UPDATE', message);
      }
    });
  } else {
    console.log(`No active connections for user ${userId}`);
  }
}

// Function to broadcast to specific client (all users of that client)
function broadcastToClient(clientId, message) {
  const connections = clientsByClient.get(clientId);
  if (connections && connections.size > 0) {
    console.log(`Broadcasting to client ${clientId}, connections: ${connections.size}`);
    connections.forEach((client) => {
      if (client.connected) {
        console.log(`Sending message to client ${clientId}:`, message);
        client.emit('PERMISSION_UPDATE', message);
      }
    });
  } else {
    console.log(`No active connections for client ${clientId}`);
  }
}

// Function to broadcast to all clients
function broadcastToAll(message) {
  // This would need access to the io instance, but for now we'll implement it
  // when we have the io instance available
  console.log(`Broadcast to all clients not implemented yet for Socket.IO`);
}

module.exports = {
  setupWebSocketServer,
  broadcastToUser,
  broadcastToClient,
  broadcastToAll,
  get wss() {
    return wss;
  }
};
/**
 * NDI Bridge Cloud Rendezvous Service
 *
 * Zero-configuration NAT traversal service for NDI Bridge
 * Enables remote connections without port forwarding or firewall config
 *
 * Features:
 * - Simple 6-character join codes
 * - WebSocket signaling for NAT traversal
 * - Session management
 * - Connection stats
 */

const express = require('express');
const WebSocket = require('ws');
const cors = require('cors');
const { customAlphabet } = require('nanoid');
const dgram = require('dgram');

const app = express();
const PORT = process.env.PORT || 3000;
const UDP_PORT = process.env.UDP_PORT || 3478; // STUN standard port

// Generate readable join codes (uppercase letters + numbers, no ambiguous chars)
const generateCode = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 6);

// Middleware
app.use(cors());
app.use(express.json());

// In-memory session storage (use Redis for production scaling)
const sessions = new Map();
const connections = new Map();

// Session cleanup - remove expired sessions (30 min timeout)
setInterval(() => {
  const now = Date.now();
  for (const [code, session] of sessions.entries()) {
    if (now - session.createdAt > 30 * 60 * 1000) {
      console.log(`🧹 Cleaning up expired session: ${code}`);
      sessions.delete(code);
    }
  }
}, 5 * 60 * 1000); // Check every 5 minutes

// REST API Routes

app.get('/', (req, res) => {
  res.json({
    service: 'NDI Bridge Rendezvous',
    version: '1.0.0',
    status: 'online',
    activeSessions: sessions.size,
    activeConnections: connections.size
  });
});

// Create a new hosting session
app.post('/api/session/create', (req, res) => {
  const { hostId, bridgeName, sources } = req.body;

  const code = generateCode();

  const session = {
    code,
    hostId,
    bridgeName,
    sources: sources || [],
    host: null,
    clients: [],
    createdAt: Date.now(),
    status: 'waiting' // waiting, active, closed
  };

  sessions.set(code, session);

  console.log(`✅ Session created: ${code} by ${bridgeName}`);

  res.json({
    success: true,
    code,
    message: 'Session created successfully'
  });
});

// Join an existing session
app.post('/api/session/join', (req, res) => {
  const { code, clientId, clientName } = req.body;

  const session = sessions.get(code);

  if (!session) {
    return res.status(404).json({
      success: false,
      message: 'Session not found. Please check the code.'
    });
  }

  console.log(`🔗 Client joining session: ${code}`);

  res.json({
    success: true,
    session: {
      code: session.code,
      bridgeName: session.bridgeName,
      sources: session.sources,
      hostConnected: !!session.host
    }
  });
});

// Get session info
app.get('/api/session/:code', (req, res) => {
  const session = sessions.get(req.params.code);

  if (!session) {
    return res.status(404).json({
      success: false,
      message: 'Session not found'
    });
  }

  res.json({
    success: true,
    session: {
      code: session.code,
      bridgeName: session.bridgeName,
      sources: session.sources,
      hostConnected: !!session.host,
      clientCount: session.clients.length,
      status: session.status
    }
  });
});

// Stats endpoint
app.get('/api/stats', (req, res) => {
  res.json({
    activeSessions: sessions.size,
    activeConnections: connections.size,
    uptime: process.uptime()
  });
});

// Start HTTP server
const server = app.listen(PORT, () => {
  console.log(`🚀 NDI Bridge Rendezvous Service`);
  console.log(`📡 HTTP API listening on port ${PORT}`);
  console.log(`🌐 WebSocket signaling ready`);
});

// WebSocket Server for Real-time Signaling
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
  const connectionId = Math.random().toString(36).substring(7);
  connections.set(connectionId, { ws, role: null, sessionCode: null });

  console.log(`🔌 New WebSocket connection: ${connectionId}`);

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      handleSignal(ws, connectionId, data);
    } catch (error) {
      console.error('❌ Invalid message:', error);
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid message format' }));
    }
  });

  ws.on('close', () => {
    handleDisconnect(connectionId);
  });

  ws.on('error', (error) => {
    console.error(`❌ WebSocket error for ${connectionId}:`, error);
  });
});

// Handle WebSocket signaling messages
function handleSignal(ws, connectionId, data) {
  const { type, code, role } = data;
  const connection = connections.get(connectionId);

  switch (type) {
    case 'register':
      // Register as host or client
      connection.role = role;
      connection.sessionCode = code;

      const session = sessions.get(code);
      if (!session) {
        ws.send(JSON.stringify({
          type: 'error',
          message: 'Session not found'
        }));
        return;
      }

      if (role === 'host') {
        session.host = connectionId;
        session.status = 'active';
        console.log(`🏠 Host registered for session ${code}`);

        // Notify all clients that host is online
        session.clients.forEach(clientId => {
          const client = connections.get(clientId);
          if (client?.ws) {
            client.ws.send(JSON.stringify({
              type: 'host_online',
              message: 'Host is now available'
            }));
          }
        });
      } else if (role === 'client') {
        session.clients.push(connectionId);
        console.log(`👤 Client registered for session ${code}`);

        // Notify host about new client
        if (session.host) {
          const host = connections.get(session.host);
          if (host?.ws) {
            host.ws.send(JSON.stringify({
              type: 'client_joined',
              clientId: connectionId
            }));
          }
        }
      }

      ws.send(JSON.stringify({
        type: 'registered',
        role,
        code
      }));
      break;

    case 'offer':
    case 'answer':
    case 'ice-candidate':
      // Forward WebRTC signaling between host and clients
      forwardSignal(connectionId, data);
      break;

    case 'connection_info':
      // Share direct connection information
      forwardSignal(connectionId, data);
      break;

    case 'ping':
      ws.send(JSON.stringify({ type: 'pong' }));
      break;

    default:
      console.log(`⚠️ Unknown message type: ${type}`);
  }
}

// Forward signaling messages between peers
function forwardSignal(fromId, data) {
  const fromConnection = connections.get(fromId);
  if (!fromConnection) return;

  const session = sessions.get(fromConnection.sessionCode);
  if (!session) return;

  const { targetId } = data;

  if (targetId) {
    // Send to specific peer
    const targetConnection = connections.get(targetId);
    if (targetConnection?.ws) {
      targetConnection.ws.send(JSON.stringify({
        ...data,
        fromId
      }));
    }
  } else {
    // Broadcast to all peers in session
    const peerId = fromConnection.role === 'host'
      ? session.clients
      : [session.host];

    peerId.forEach(id => {
      const peer = connections.get(id);
      if (peer?.ws && id !== fromId) {
        peer.ws.send(JSON.stringify({
          ...data,
          fromId
        }));
      }
    });
  }
}

// Handle disconnections
function handleDisconnect(connectionId) {
  const connection = connections.get(connectionId);

  if (connection?.sessionCode) {
    const session = sessions.get(connection.sessionCode);

    if (session) {
      if (connection.role === 'host') {
        console.log(`🏠 Host disconnected from session ${connection.sessionCode}`);
        session.host = null;
        session.status = 'waiting';

        // Notify clients
        session.clients.forEach(clientId => {
          const client = connections.get(clientId);
          if (client?.ws) {
            client.ws.send(JSON.stringify({
              type: 'host_offline',
              message: 'Host disconnected'
            }));
          }
        });
      } else if (connection.role === 'client') {
        console.log(`👤 Client disconnected from session ${connection.sessionCode}`);
        session.clients = session.clients.filter(id => id !== connectionId);

        // Notify host
        if (session.host) {
          const host = connections.get(session.host);
          if (host?.ws) {
            host.ws.send(JSON.stringify({
              type: 'client_left',
              clientId: connectionId
            }));
          }
        }
      }
    }
  }

  connections.delete(connectionId);
  console.log(`🔌 Connection closed: ${connectionId}`);
}

// UDP Server for STUN-like NAT discovery
const udpServer = dgram.createSocket('udp4');

udpServer.on('message', (msg, rinfo) => {
  try {
    const data = JSON.parse(msg.toString());

    if (data.type === 'stun_request') {
      // Respond with client's public IP and port
      const response = {
        type: 'stun_response',
        publicIP: rinfo.address,
        publicPort: rinfo.port,
        sessionCode: data.sessionCode
      };

      const responseBuffer = Buffer.from(JSON.stringify(response));
      udpServer.send(responseBuffer, rinfo.port, rinfo.address, (err) => {
        if (err) {
          console.error('❌ Failed to send STUN response:', err);
        } else {
          console.log(`🔍 STUN response sent to ${rinfo.address}:${rinfo.port}`);
        }
      });

      // Also broadcast this info to other peers in the session via WebSocket
      if (data.sessionCode) {
        const session = sessions.get(data.sessionCode);
        if (session) {
          const udpInfo = {
            type: 'peer_udp_info',
            peerId: data.peerId,
            publicIP: rinfo.address,
            publicPort: rinfo.port
          };

          // Notify all peers in session
          const allPeers = [session.host, ...session.clients].filter(Boolean);
          allPeers.forEach(peerId => {
            const peer = connections.get(peerId);
            if (peer?.ws && peerId !== data.peerId) {
              peer.ws.send(JSON.stringify(udpInfo));
            }
          });
        }
      }
    }
  } catch (error) {
    console.error('❌ UDP message error:', error);
  }
});

udpServer.on('listening', () => {
  const address = udpServer.address();
  console.log(`📡 UDP STUN server listening on ${address.address}:${address.port}`);
});

udpServer.on('error', (err) => {
  console.error('❌ UDP server error:', err);
  udpServer.close();
});

// Start UDP server (Railway binds UDP dynamically, fallback to 3478 locally)
const bindUDP = () => {
  try {
    udpServer.bind(UDP_PORT);
  } catch (err) {
    console.error('⚠️ Failed to bind UDP port, STUN disabled');
  }
};

bindUDP();

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('⏹️ SIGTERM received, closing servers...');
  udpServer.close();
  server.close(() => {
    console.log('✅ Servers closed');
    process.exit(0);
  });
});

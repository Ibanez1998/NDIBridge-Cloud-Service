/**
 * NDI Bridge Cloud Rendezvous Service
 *
 * Zero-configuration NAT traversal service for NDI Bridge
 * Enables remote connections without port forwarding or firewall config
 *
 * Features:
 * - Auto-discovery of available NDI hosts (no join codes needed!)
 * - Host registry with heartbeat-based presence
 * - P2P UDP connection coordination
 * - Session management for active connections
 */

const express = require('express');
const WebSocket = require('ws');
const cors = require('cors');
const { customAlphabet } = require('nanoid');
const dgram = require('dgram');

const app = express();
const PORT = process.env.PORT || 3000;
const UDP_PORT = process.env.UDP_PORT || 3478; // STUN standard port

// Generate readable codes (uppercase letters + numbers, no ambiguous chars)
const generateCode = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 6);
const generateHostId = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 16);

// Middleware
app.use(cors());
app.use(express.json());

// In-memory storage (use Redis for production scaling)
const sessions = new Map();
const connections = new Map();
const hosts = new Map();  // Host registry for auto-discovery

// Host timeout - remove hosts that haven't sent heartbeat in 45 seconds
const HOST_TIMEOUT_MS = 45000;

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

// Host cleanup - remove hosts that haven't sent heartbeat
setInterval(() => {
  const now = Date.now();
  for (const [hostId, host] of hosts.entries()) {
    if (now - host.lastHeartbeat > HOST_TIMEOUT_MS) {
      console.log(`🧹 Removing stale host: ${host.computerName} (${hostId})`);
      hosts.delete(hostId);
    }
  }
}, 15000); // Check every 15 seconds

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
    activeHosts: hosts.size,
    uptime: process.uptime()
  });
});

// ===== HOST REGISTRY API (Auto-Discovery) =====

// Helper to get client IP from request (handles proxies like Railway)
function getClientIP(req) {
  // Railway and other proxies set X-Forwarded-For header
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    // X-Forwarded-For can contain multiple IPs, first one is the client
    return forwarded.split(',')[0].trim();
  }
  // Fall back to direct connection IP
  return req.ip || req.connection?.remoteAddress || null;
}

// Register a host with its available NDI sources
app.post('/api/hosts/register', (req, res) => {
  const { hostId, computerName, sources, publicIP, publicPort } = req.body;

  if (!computerName || !sources || !Array.isArray(sources)) {
    return res.status(400).json({
      success: false,
      message: 'computerName and sources array required'
    });
  }

  // Generate hostId if not provided (first registration)
  const id = hostId || generateHostId();

  // Auto-detect public IP from HTTP request if not provided
  const detectedIP = publicIP || getClientIP(req);

  const host = {
    hostId: id,
    computerName,
    sources,  // Array of { name: "NDI Source Name", enabled: true/false }
    publicIP: detectedIP,
    publicPort: publicPort || 5961,  // Default NDI port
    registeredAt: hosts.has(id) ? hosts.get(id).registeredAt : Date.now(),
    lastHeartbeat: Date.now(),
    connectedClients: []
  };

  hosts.set(id, host);

  const enabledSources = sources.filter(s => s.enabled);
  console.log(`📡 Host registered: ${computerName} with ${enabledSources.length} sources (${id}) - IP: ${detectedIP}`);

  res.json({
    success: true,
    hostId: id,
    publicIP: detectedIP,
    message: 'Host registered successfully'
  });
});

// Host heartbeat - keeps host in registry and updates endpoint
app.post('/api/hosts/heartbeat/:hostId', (req, res) => {
  const { hostId } = req.params;
  const { publicIP, publicPort, sources } = req.body;

  const host = hosts.get(hostId);
  if (!host) {
    return res.status(404).json({
      success: false,
      message: 'Host not found. Please re-register.'
    });
  }

  // Update host info
  host.lastHeartbeat = Date.now();
  // Update IP - prefer explicit, then auto-detect from request
  const detectedIP = publicIP || getClientIP(req);
  if (detectedIP) host.publicIP = detectedIP;
  if (publicPort) host.publicPort = publicPort;
  if (sources) host.sources = sources;

  // Return any pending client connection requests
  const pendingClients = host.connectedClients.filter(c => !c.acknowledged);

  res.json({
    success: true,
    pendingClients: pendingClients.map(c => ({
      clientId: c.clientId,
      clientName: c.clientName,
      publicIP: c.publicIP,
      publicPort: c.publicPort,
      requestedSource: c.requestedSource
    }))
  });
});

// Host goes offline
app.delete('/api/hosts/:hostId', (req, res) => {
  const { hostId } = req.params;

  if (hosts.has(hostId)) {
    const host = hosts.get(hostId);
    console.log(`👋 Host unregistered: ${host.computerName} (${hostId})`);
    hosts.delete(hostId);
  }

  res.json({ success: true });
});

// Get list of all available hosts (for clients to browse)
app.get('/api/hosts', (req, res) => {
  const now = Date.now();
  const availableHosts = [];

  for (const [hostId, host] of hosts.entries()) {
    // Only include hosts with recent heartbeat
    if (now - host.lastHeartbeat < HOST_TIMEOUT_MS) {
      const enabledSources = host.sources.filter(s => s.enabled);
      if (enabledSources.length > 0) {
        availableHosts.push({
          hostId,
          computerName: host.computerName,
          sources: enabledSources.map(s => s.name),
          online: true,
          lastSeen: host.lastHeartbeat
        });
      }
    }
  }

  console.log(`📋 Host list requested: ${availableHosts.length} hosts available`);

  res.json({
    success: true,
    hosts: availableHosts
  });
});

// Client requests to connect to a specific host/source
app.post('/api/hosts/:hostId/connect', (req, res) => {
  const { hostId } = req.params;
  const { clientId, clientName, sourceName, publicIP, publicPort } = req.body;

  const host = hosts.get(hostId);
  if (!host) {
    return res.status(404).json({
      success: false,
      message: 'Host not found or offline'
    });
  }

  // Check if source exists and is enabled
  const source = host.sources.find(s => s.name === sourceName && s.enabled);
  if (!source) {
    return res.status(404).json({
      success: false,
      message: 'Source not found or not shared'
    });
  }

  // Add client to host's pending connections
  const connectionRequest = {
    clientId: clientId || generateCode(),
    clientName: clientName || 'Unknown Client',
    requestedSource: sourceName,
    publicIP,
    publicPort,
    requestedAt: Date.now(),
    acknowledged: false
  };

  host.connectedClients.push(connectionRequest);

  console.log(`🔗 Connection request: ${clientName} -> ${host.computerName}/${sourceName}`);

  res.json({
    success: true,
    clientId: connectionRequest.clientId,
    hostEndpoint: {
      publicIP: host.publicIP,
      publicPort: host.publicPort
    },
    message: 'Connection request sent to host'
  });
});

// Client polls for connection status
app.get('/api/hosts/:hostId/status/:clientId', (req, res) => {
  const { hostId, clientId } = req.params;

  const host = hosts.get(hostId);
  if (!host) {
    return res.status(404).json({
      success: false,
      message: 'Host not found or offline'
    });
  }

  const client = host.connectedClients.find(c => c.clientId === clientId);
  if (!client) {
    return res.status(404).json({
      success: false,
      message: 'Connection request not found'
    });
  }

  res.json({
    success: true,
    hostOnline: (Date.now() - host.lastHeartbeat) < HOST_TIMEOUT_MS,
    hostEndpoint: {
      publicIP: host.publicIP,
      publicPort: host.publicPort
    },
    acknowledged: client.acknowledged
  });
});

// Host acknowledges a client connection
app.post('/api/hosts/:hostId/acknowledge/:clientId', (req, res) => {
  const { hostId, clientId } = req.params;

  const host = hosts.get(hostId);
  if (!host) {
    return res.status(404).json({ success: false, message: 'Host not found' });
  }

  const client = host.connectedClients.find(c => c.clientId === clientId);
  if (client) {
    client.acknowledged = true;
    console.log(`✅ Connection acknowledged: ${client.clientName} -> ${host.computerName}`);
  }

  res.json({ success: true });
});

// Log upload endpoint
const uploadedLogs = new Map(); // Store logs in memory (use database for production)

app.post('/api/logs/upload', (req, res) => {
  const { deviceName, timestamp, logContents, platform, appVersion } = req.body;

  if (!logContents) {
    return res.status(400).json({ success: false, message: 'No log contents provided' });
  }

  // Generate unique log ID
  const logId = generateCode();

  const logEntry = {
    logId,
    deviceName: deviceName || 'Unknown',
    timestamp: timestamp || new Date().toISOString(),
    platform: platform || 'Unknown',
    appVersion: appVersion || 'Unknown',
    logContents,
    uploadedAt: Date.now()
  };

  uploadedLogs.set(logId, logEntry);

  console.log(`📤 Log uploaded from ${deviceName} [${logId}]`);

  res.json({
    success: true,
    logId,
    message: 'Logs uploaded successfully'
  });
});

// Get uploaded log by ID
app.get('/api/logs/:logId', (req, res) => {
  const { logId } = req.params;
  const log = uploadedLogs.get(logId);

  if (!log) {
    return res.status(404).json({ success: false, message: 'Log not found' });
  }

  res.json({
    success: true,
    log
  });
});

// List all uploaded logs
app.get('/api/logs', (req, res) => {
  const logs = Array.from(uploadedLogs.values())
    .sort((a, b) => b.uploadedAt - a.uploadedAt)
    .map(log => ({
      logId: log.logId,
      deviceName: log.deviceName,
      timestamp: log.timestamp,
      platform: log.platform,
      appVersion: log.appVersion,
      uploadedAt: log.uploadedAt,
      size: log.logContents.length
    }));

  res.json({
    success: true,
    count: logs.length,
    logs
  });
});

// Delete old logs (cleanup) - remove logs older than 24 hours
setInterval(() => {
  const now = Date.now();
  for (const [logId, log] of uploadedLogs.entries()) {
    if (now - log.uploadedAt > 24 * 60 * 60 * 1000) {
      console.log(`🧹 Cleaning up old log: ${logId}`);
      uploadedLogs.delete(logId);
    }
  }
}, 60 * 60 * 1000); // Check every hour

// ===== HTTP POLLING ENDPOINTS (WebSocket Alternative) =====

// Host updates its UDP endpoint
app.post('/api/host/endpoint/:code', (req, res) => {
  const { code } = req.params;
  const { publicIP, publicPort, peerId } = req.body;

  const session = sessions.get(code);
  if (!session) {
    return res.status(404).json({ success: false, message: 'Session not found' });
  }

  session.hostEndpoint = { publicIP, publicPort, peerId, updatedAt: Date.now() };
  console.log(`🏠 Host endpoint updated for ${code}: ${publicIP}:${publicPort}`);

  res.json({ success: true });
});

// Client updates its UDP endpoint
app.post('/api/client/endpoint/:code', (req, res) => {
  const { code } = req.params;
  const { publicIP, publicPort, peerId, clientName } = req.body;

  const session = sessions.get(code);
  if (!session) {
    return res.status(404).json({ success: false, message: 'Session not found' });
  }

  // Store or update client endpoint
  const existingIndex = session.clientEndpoints?.findIndex(c => c.peerId === peerId);
  const endpoint = { publicIP, publicPort, peerId, clientName, updatedAt: Date.now() };

  if (!session.clientEndpoints) session.clientEndpoints = [];

  if (existingIndex >= 0) {
    session.clientEndpoints[existingIndex] = endpoint;
  } else {
    session.clientEndpoints.push(endpoint);
  }

  console.log(`👤 Client endpoint updated for ${code}: ${publicIP}:${publicPort}`);

  res.json({ success: true });
});

// Host polls for client connections
app.get('/api/host/poll/:code', (req, res) => {
  const { code } = req.params;
  const session = sessions.get(code);

  if (!session) {
    return res.status(404).json({ success: false, message: 'Session not found' });
  }

  // Return list of connected clients with their UDP endpoints
  const clients = (session.clientEndpoints || []).map(c => ({
    peerId: c.peerId,
    clientName: c.clientName,
    publicIP: c.publicIP,
    publicPort: c.publicPort,
    connected: (Date.now() - c.updatedAt) < 30000 // Active if updated in last 30s
  }));

  res.json({
    success: true,
    clients,
    hostEndpoint: session.hostEndpoint || null
  });
});

// Client polls for host status and endpoint
app.get('/api/client/poll/:code', (req, res) => {
  const { code } = req.params;
  const session = sessions.get(code);

  if (!session) {
    return res.status(404).json({ success: false, message: 'Session not found' });
  }

  const hostAvailable = session.hostEndpoint && (Date.now() - session.hostEndpoint.updatedAt) < 30000;

  res.json({
    success: true,
    bridgeName: session.bridgeName,
    sources: session.sources,
    hostAvailable,
    hostEndpoint: hostAvailable ? {
      publicIP: session.hostEndpoint.publicIP,
      publicPort: session.hostEndpoint.publicPort,
      peerId: session.hostEndpoint.peerId
    } : null,
    // Also return other clients in case of peer-to-peer mesh
    otherClients: (session.clientEndpoints || [])
      .filter(c => (Date.now() - c.updatedAt) < 30000)
      .map(c => ({
        peerId: c.peerId,
        clientName: c.clientName,
        publicIP: c.publicIP,
        publicPort: c.publicPort
      }))
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
    case 'udp_endpoint':
      // Share direct connection information and UDP endpoints
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

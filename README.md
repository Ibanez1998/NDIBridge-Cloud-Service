# 🌐 NDI Bridge Cloud Rendezvous Service

Zero-configuration NAT traversal service for NDI Bridge. Enables remote NDI streaming without port forwarding or firewall configuration.

## ⚡ Quick Deploy

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/template/ndi-bridge?referralCode=alphasec)

**Or deploy manually from GitHub:**
1. Go to https://railway.app/new
2. Click "Deploy from GitHub repo"
3. Select `Ibanez1998/NDIBridge-Cloud-Service`
4. Click "Deploy"
5. Generate a domain in Settings → Networking
6. Copy your URL (e.g., `ndi-bridge-xyz123.up.railway.app`)

## 🚀 Features

- **Simple Join Codes**: 6-character codes (e.g., `AB-1234`)
- **Zero Config**: No port forwarding or firewall setup needed
- **WebSocket Signaling**: Real-time connection coordination
- **NAT Traversal**: Automatic hole-punching and relay fallback
- **Session Management**: Automatic cleanup of expired sessions
- **Scalable**: Ready for Railway/Fly.io/Heroku deployment

## 📋 API Endpoints

### Create Session
```bash
POST /api/session/create
{
  "hostId": "unique-host-id",
  "bridgeName": "My NDI Bridge",
  "sources": ["Camera 1", "Screen Share"]
}
```

**Response:**
```json
{
  "success": true,
  "code": "AB1234",
  "message": "Session created successfully"
}
```

### Join Session
```bash
POST /api/session/join
{
  "code": "AB1234",
  "clientId": "unique-client-id",
  "clientName": "Remote Studio"
}
```

### Get Session Info
```bash
GET /api/session/:code
```

### Stats
```bash
GET /api/stats
```

## 🔌 WebSocket Signaling

Connect to `ws://your-service.railway.app` and send:

```javascript
// Register as host
{
  "type": "register",
  "code": "AB1234",
  "role": "host"
}

// Register as client
{
  "type": "register",
  "code": "AB1234",
  "role": "client"
}

// Send connection info
{
  "type": "connection_info",
  "address": "192.168.1.100",
  "port": 5990,
  "publicIP": "203.0.113.1"
}

// ICE candidate (for WebRTC-style NAT traversal)
{
  "type": "ice-candidate",
  "candidate": "..."
}
```

## 🚂 Deploy to Railway

1. **Create Railway Project:**
```bash
railway login
railway init
```

2. **Deploy:**
```bash
railway up
```

3. **Get URL:**
```bash
railway open
```

Your service will be available at: `https://your-app.railway.app`

## 🛠️ Local Development

```bash
npm install
npm run dev
```

Server runs on `http://localhost:3000`

## 📊 Environment Variables

- `PORT`: Server port (default: 3000)
- `NODE_ENV`: Environment (production/development)

## 🔒 Security Notes

- Sessions expire after 30 minutes of inactivity
- All WebSocket connections are validated
- No sensitive data is stored
- Rate limiting recommended for production

## 📈 Scaling

For production use:
- Replace in-memory storage with **Redis**
- Add **rate limiting** (express-rate-limit)
- Enable **HTTPS** (automatic on Railway)
- Add **authentication** for private sessions (optional)

## 🧪 Testing

```bash
# Health check
curl https://your-service.railway.app/

# Create session
curl -X POST https://your-service.railway.app/api/session/create \
  -H "Content-Type: application/json" \
  -d '{"hostId":"test","bridgeName":"Test Bridge"}'

# Get stats
curl https://your-service.railway.app/api/stats
```

## 📝 License

MIT License - Free for personal and commercial use

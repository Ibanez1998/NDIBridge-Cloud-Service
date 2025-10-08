# Deploy NDI Bridge Cloud Service to Railway

## Quick Deploy via Railway Dashboard

1. **Go to Railway Dashboard**
   - Visit: https://railway.app/new
   - Click "Deploy from GitHub repo"

2. **Connect Repository**
   - Select this repository: `NDIBridge-Cloud-Service`
   - Or use "Deploy from local directory"

3. **Configure Service**
   - Service Name: `ndi-bridge-rendezvous`
   - Start Command: `node server.js` (already in Procfile)
   - Port: Will auto-detect from code (PORT env var)

4. **Generate Domain**
   - Go to Settings → Networking
   - Click "Generate Domain"
   - Copy the domain (e.g., `ndi-bridge-rendezvous.up.railway.app`)

5. **Update CloudConnectionManager.swift**
   - Replace `https://your-service.railway.app` with your domain
   - Replace `wss://your-service.railway.app` with `wss://your-domain.up.railway.app`

## Alternative: Deploy via CLI (Manual Steps)

```bash
# 1. Link to a new Railway project
railway link

# 2. Deploy
railway up

# 3. Get the URL
railway domain

# 4. Copy the URL to update CloudConnectionManager.swift
```

## Verify Deployment

Once deployed, test the service:

```bash
# Check status
curl https://your-domain.up.railway.app/

# Should return:
# {
#   "service": "NDI Bridge Rendezvous",
#   "version": "1.0.0",
#   "status": "online",
#   "activeSessions": 0,
#   "activeConnections": 0
# }
```

## Next Steps

After deployment:
1. Copy the Railway URL
2. Update `CloudConnectionManager.swift` lines 16-17
3. Rebuild the Swift app
4. Test join code functionality

# OpenTTD WebSocket Proxy

This proxy server allows the OpenTTD web version to connect to standard OpenTTD game servers by translating WebSocket connections to raw TCP connections.

It also fetches the public server list from the Game Coordinator and exposes it via an HTTP API.

## How it works

```
[Browser] --WebSocket--> [Proxy Server] --TCP--> [OpenTTD Server]

[Browser] --HTTP GET /servers--> [Proxy] --TCP--> [Game Coordinator]
```

1. The web client connects to the proxy via WebSocket
2. The proxy establishes a TCP connection to the target OpenTTD server
3. Data is forwarded bidirectionally between the two connections
4. The `/servers` endpoint queries the Game Coordinator for the public server list

## Installation

```bash
cd web/proxy
npm install
```

## Usage

### Start the proxy

```bash
npm start
# or with a custom port:
node websocket-proxy.js 9000
```

### Endpoints

- **WebSocket**: `ws://localhost:8080/connect/<host>/<port>` - Connect to a game server
- **HTTP GET**: `http://localhost:8080/servers` - Get public server list as JSON
- **HTTP GET**: `http://localhost:8080/health` - Health check

### Configure the web client

Before starting OpenTTD in the browser, set the proxy URL in the browser console or in your HTML:

```javascript
// For local development (HTTP)
window.openttd_websocket_proxy = 'ws://localhost:8080';

// For production (HTTPS) - proxy must have SSL certificate
window.openttd_websocket_proxy = 'wss://your-proxy.example.com';
```

When configured, the web client will:
1. Automatically fetch the server list from `/servers` and populate the multiplayer menu
2. Route all game connections through the proxy

### Connect to a server

In OpenTTD's multiplayer menu, enter the server address as usual (e.g., `game.example.com:3979`). The web client will automatically route the connection through the proxy.

## Server List API

The `/servers` endpoint returns a JSON array of public servers:

```json
[
  {
    "connection_string": "123.45.67.89:3979",
    "name": "My OpenTTD Server",
    "version": "14.1",
    "clients_on": 5,
    "clients_max": 15,
    "companies_on": 3,
    "companies_max": 15,
    "map_width": 512,
    "map_height": 512,
    "landscape": "Temperate",
    "password": false,
    "dedicated": true
  }
]
```

The server list is cached for 60 seconds to reduce load on the Game Coordinator.

## Security

The proxy includes basic security measures:

- **Port allowlist**: Only ports 3979 (game) and 3978 (content) are allowed by default
- **Server allowlist**: Optionally restrict which servers can be connected to
- **CORS headers**: Allows cross-origin requests from any origin

Edit `websocket-proxy.js` to customize these settings:

```javascript
// Allow additional ports
const ALLOWED_PORTS = [3979, 3978, 3980];

// Restrict to specific servers only
const ALLOWED_SERVERS = [
  'trusted-server.example.com',
  'another-server.com',
];
```

## Production deployment

For production use, you should:

1. Run the proxy behind a reverse proxy (nginx, Caddy) with SSL
2. Configure the `ALLOWED_SERVERS` list to prevent abuse
3. Add rate limiting
4. Monitor connections and logs

### Example nginx configuration

```nginx
server {
    listen 443 ssl;
    server_name openttd-proxy.example.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://localhost:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 3600s;
    }
}
```

## Testing

Test the Game Coordinator client directly:

```bash
node game-coordinator.js
```

This will fetch and display the current public server list.

## Limitations

- Each client requires a separate TCP connection through the proxy
- Server list refresh requires manual action in the game (the list doesn't auto-update)

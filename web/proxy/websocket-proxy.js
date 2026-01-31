/**
 * OpenTTD WebSocket to TCP Proxy
 *
 * This proxy allows web browsers to connect to OpenTTD game servers
 * by translating WebSocket connections to raw TCP connections.
 *
 * It also provides an HTTP API to fetch the public server list from
 * the Game Coordinator.
 *
 * Usage:
 *   node websocket-proxy.js [port]
 *
 * Default port: 8080
 *
 * Endpoints:
 *   WebSocket: ws://proxy:8080/connect/<host>/<port>
 *   HTTP GET:  http://proxy:8080/servers - Get public server list as JSON
 */

import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import net from 'net';
import { fetchServerList } from './game-coordinator.js';

const PROXY_PORT = parseInt(process.argv[2]) || 8080;

// Security: List of allowed ports (OpenTTD default ports)
const ALLOWED_PORTS = [3979, 3978]; // Game server, content server

// Security: Optional allowlist of servers (empty = allow all)
const ALLOWED_SERVERS = [
  // Add specific servers here, or leave empty to allow any
  // 'game.example.com',
];

// Cache for server list (refresh every 60 seconds)
let serverListCache = null;
let serverListCacheTime = 0;
const CACHE_TTL = 60000; // 60 seconds

// Create HTTP server
const httpServer = createServer(async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'GET' && req.url === '/servers') {
    try {
      const now = Date.now();

      // Check cache
      if (serverListCache && (now - serverListCacheTime) < CACHE_TTL) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(serverListCache));
        return;
      }

      // Fetch fresh list
      console.log('Fetching server list from Game Coordinator...');
      const servers = await fetchServerList();
      console.log(`Got ${servers.length} servers`);

      // Update cache
      serverListCache = servers;
      serverListCacheTime = now;

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(servers));
    } catch (err) {
      console.error('Error fetching server list:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  // 404 for other HTTP requests
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

// Create WebSocket server attached to HTTP server
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws, req) => {
  // Parse the URL to get target host and port
  // Format: /connect/<host>/<port>
  const urlParts = req.url.split('/');

  if (urlParts.length < 4 || urlParts[1] !== 'connect') {
    console.log('Invalid connection URL:', req.url);
    ws.close(1008, 'Invalid URL format. Use /connect/<host>/<port>');
    return;
  }

  const targetHost = urlParts[2];
  const targetPort = parseInt(urlParts[3]);

  // Security checks
  if (!targetHost || isNaN(targetPort)) {
    ws.close(1008, 'Invalid host or port');
    return;
  }

  if (!ALLOWED_PORTS.includes(targetPort)) {
    console.log(`Rejected connection to port ${targetPort} (not in allowed list)`);
    ws.close(1008, 'Port not allowed');
    return;
  }

  if (ALLOWED_SERVERS.length > 0 && !ALLOWED_SERVERS.includes(targetHost)) {
    console.log(`Rejected connection to ${targetHost} (not in allowed list)`);
    ws.close(1008, 'Server not in allowlist');
    return;
  }

  console.log(`New connection request: ${targetHost}:${targetPort}`);

  // Create TCP connection to the OpenTTD server
  const tcpSocket = net.createConnection({
    host: targetHost,
    port: targetPort,
  });

  let connected = false;

  tcpSocket.on('connect', () => {
    connected = true;
    console.log(`Connected to ${targetHost}:${targetPort}`);
  });

  // Forward data from TCP to WebSocket
  tcpSocket.on('data', (data) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(data);
    }
  });

  tcpSocket.on('error', (err) => {
    console.log(`TCP error for ${targetHost}:${targetPort}:`, err.message);
    if (ws.readyState === ws.OPEN) {
      ws.close(1011, `TCP error: ${err.message}`);
    }
  });

  tcpSocket.on('close', () => {
    console.log(`TCP connection closed: ${targetHost}:${targetPort}`);
    if (ws.readyState === ws.OPEN) {
      ws.close(1000, 'TCP connection closed');
    }
  });

  // Forward data from WebSocket to TCP
  ws.on('message', (data) => {
    if (connected && !tcpSocket.destroyed) {
      tcpSocket.write(data);
    }
  });

  ws.on('close', () => {
    console.log(`WebSocket closed for ${targetHost}:${targetPort}`);
    tcpSocket.destroy();
  });

  ws.on('error', (err) => {
    console.log('WebSocket error:', err.message);
    tcpSocket.destroy();
  });
});

// Start server
httpServer.listen(PROXY_PORT, () => {
  console.log(`OpenTTD WebSocket Proxy listening on port ${PROXY_PORT}`);
  console.log(`  WebSocket: ws://localhost:${PROXY_PORT}/connect/<host>/<port>`);
  console.log(`  Server List: http://localhost:${PROXY_PORT}/servers`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down proxy...');
  httpServer.close(() => {
    process.exit(0);
  });
});

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
 *   LOG_LEVEL=debug node websocket-proxy.js [port]
 *
 * Default port: 8081
 *
 * Endpoints:
 *   WebSocket: ws://proxy:8081/connect/<host>/<port> - Direct TCP connection
 *   HTTP GET:  http://proxy:8081/servers - Get public server list as JSON
 *   HTTP GET:  http://proxy:8081/health - Health check
 */

import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import net from 'net';
import { fetchServerList } from './game-coordinator.js';

const PROXY_PORT = parseInt(process.argv[2]) || 8081;

// Log levels: 'error' (prod), 'info' (default), 'debug' (dev)
const LOG_LEVEL = process.env.LOG_LEVEL || 'error';
const LOG_LEVELS = { error: 0, info: 1, debug: 2 };

/**
 * Log a message with timestamp and category
 * @param {string} category - Log category (HTTP, PROXY, WS, SERVER)
 * @param {string} message - Log message
 * @param {*} data - Optional data to log
 * @param {string} level - Log level (error, info, debug)
 */
function log(category, message, data = null, level = 'info') {
  if (LOG_LEVELS[level] > LOG_LEVELS[LOG_LEVEL]) return;

  const timestamp = new Date().toISOString().substring(11, 23);
  const prefix = `[${timestamp}] [${category}]`;
  if (data !== null) {
    console.log(`${prefix} ${message}`, data);
  } else {
    console.log(`${prefix} ${message}`);
  }
}

// Security: List of allowed ports (OpenTTD default ports)
// 3973-3974 = TURN, 3975 = STUN, 3976 = Coordinator, 3978 = Content, 3979-3989 = Game servers
const ALLOWED_PORTS = [
  3973, 3974, 3975, 3976, 3978,              // Infrastructure
  3979, 3980, 3981, 3982, 3983, 3984, 3985,  // Game server ports
  3986, 3987, 3988, 3989,                    // TURN and additional game ports
  2979, 
  1742, 1979, 4000, 4001, 4002, 4003, 4004, 4005,
  5010, 5020, 5030, 5040, 5050, 5060, 5070, 5080, 5090, 5100, 5110, 5120, 5130, // ottd.top
  25520, 56111,
];

// Security: Optional allowlist of servers (empty = allow all)
const ALLOWED_SERVERS = [];

// Cache for server list (refresh every 60 seconds)
let serverListCache = null;
let serverListCacheTime = 0;
const CACHE_TTL = 60000;

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

  // GET /servers - Return cached server list from Game Coordinator
  if (req.method === 'GET' && req.url === '/servers') {
    try {
      const now = Date.now();

      // Return cached list if fresh
      if (serverListCache && (now - serverListCacheTime) < CACHE_TTL) {
        log('HTTP', 'Returning cached server list', null, 'debug');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(serverListCache));
        return;
      }

      // Fetch fresh list from Game Coordinator
      log('HTTP', 'Fetching server list from Game Coordinator...');
      const servers = await fetchServerList();
      log('HTTP', `Got ${servers.length} servers`);

      // Update cache
      serverListCache = servers;
      serverListCacheTime = now;

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(servers));
    } catch (err) {
      log('HTTP', `Error fetching server list: ${err.message}`, null, 'error');
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // GET /health - Health check endpoint
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  // 404 for other requests
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

// Max buffer before applying backpressure (64KB)
const MAX_WS_BUFFER = 64 * 1024;

/**
 * Handle WebSocket to TCP connection relay
 * @param {WebSocket} ws - WebSocket connection from client
 * @param {string} targetHost - Target TCP host
 * @param {number} targetPort - Target TCP port
 */
function handleConnection(ws, targetHost, targetPort) {
  const target = `${targetHost}:${targetPort}`;
  log('PROXY', `Connecting to ${target}`, null, 'debug');

  const tcpSocket = net.createConnection({
    host: targetHost,
    port: targetPort,
  });

  // Timeout for connection attempt (10 seconds)
  const connectTimeout = setTimeout(() => {
    if (!connected) {
      log('PROXY', `Connection timeout to ${target}`, null, 'error');
      tcpSocket.destroy();
      if (ws.readyState === ws.OPEN) {
        ws.close(1011, 'Connection timeout');
      }
    }
  }, 10000);

  let connected = false;
  let pendingMessages = [];  // Buffer messages until TCP connected

  tcpSocket.on('connect', () => {
    clearTimeout(connectTimeout);
    connected = true;
    log('PROXY', `Connected to ${target}`, null, 'debug');

    // Flush any messages that arrived before TCP connected
    for (const msg of pendingMessages) {
      log('PROXY', `WS->TCP ${target}: ${msg.length} bytes (flushed)`, null, 'debug');
      tcpSocket.write(msg);
    }
    pendingMessages = [];
  });

  tcpSocket.on('data', (data) => {
    log('PROXY', `TCP->WS ${target}: ${data.length} bytes`, null, 'debug');
    if (ws.readyState === ws.OPEN) {
      ws.send(data);
      // Backpressure: pause TCP if WS buffer is full
      if (ws.bufferedAmount > MAX_WS_BUFFER) {
        tcpSocket.pause();
      }
    }
  });

  // Resume TCP when WS drains
  ws.on('drain', () => {
    if (!tcpSocket.destroyed) tcpSocket.resume();
  });

  tcpSocket.on('error', (err) => {
    clearTimeout(connectTimeout);
    log('PROXY', `TCP error (${target}): ${err.message}`, null, 'error');
    if (ws.readyState === ws.OPEN) {
      ws.close(1011, `TCP error: ${err.message}`);
    }
  });

  tcpSocket.on('close', () => {
    log('PROXY', `Disconnected from ${target}`, null, 'debug');
    if (ws.readyState === ws.OPEN) {
      ws.close(1000, 'TCP connection closed');
    }
  });

  ws.on('message', (data) => {
    log('PROXY', `WS->TCP ${target}: ${data.length} bytes`, null, 'debug');

    // Buffer messages until TCP is connected
    if (!connected) {
      pendingMessages.push(data);
      return;
    }

    if (!tcpSocket.destroyed) {
      // Backpressure: pause WS if TCP buffer is full
      const canWrite = tcpSocket.write(data);
      if (!canWrite) {
        ws._socket.pause();
        tcpSocket.once('drain', () => {
          if (ws.readyState === ws.OPEN) ws._socket.resume();
        });
      }
    }
  });

  ws.on('close', () => {
    log('PROXY', `Client disconnected from ${target}`, null, 'debug');
    tcpSocket.destroy();
  });

  ws.on('error', (err) => {
    log('PROXY', `WebSocket error: ${err.message}`, null, 'error');
    tcpSocket.destroy();
  });
}

// Create WebSocket server attached to HTTP server
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws, req) => {
  const urlParts = req.url.split('/');

  // Handle connections: /connect/<host>/<port>
  if (urlParts.length < 4 || urlParts[1] !== 'connect') {
    log('WS', `Invalid URL: ${req.url}`, null, 'error');
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
    log('WS', `Rejected: port ${targetPort} not allowed`, null, 'error');
    ws.close(1008, 'Port not allowed');
    return;
  }

  if (ALLOWED_SERVERS.length > 0 && !ALLOWED_SERVERS.includes(targetHost)) {
    log('WS', `Rejected: ${targetHost} not in allowlist`, null, 'error');
    ws.close(1008, 'Server not in allowlist');
    return;
  }

  handleConnection(ws, targetHost, targetPort);
});

// Start server
httpServer.listen(PROXY_PORT, () => {
  log('SERVER', `OpenTTD WebSocket Proxy listening on port ${PROXY_PORT} (LOG_LEVEL=${LOG_LEVEL})`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  log('SERVER', 'Shutting down...');
  httpServer.close(() => {
    process.exit(0);
  });
});

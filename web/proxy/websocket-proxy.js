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
 *   WebSocket: ws://proxy:8080/connect/<host>/<port> - Direct TCP connection
 *   WebSocket: ws://proxy:8080/turn/<host>/<port>/<ticket> - TURN relay connection
 *   HTTP GET:  http://proxy:8080/servers - Get public server list as JSON
 *   HTTP GET:  http://proxy:8080/resolve/<invite_code> - Resolve invite code
 */

// TURN protocol constants
const NETWORK_COORDINATOR_VERSION = 6;
const PACKET_TURN_TURN_ERROR = 0;
const PACKET_TURN_SERCLI_CONNECT = 1;
const PACKET_TURN_TURN_CONNECTED = 2;

import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import net from 'net';
import { fetchServerList, resolveInviteCode } from './game-coordinator.js';

const PROXY_PORT = parseInt(process.argv[2]) || 8080;

// Logging helper with timestamp and category
function log(category, message, data = null) {
  const timestamp = new Date().toISOString().substring(11, 23); // HH:MM:SS.mmm
  const prefix = `[${timestamp}] [${category}]`;
  if (data !== null) {
    console.log(`${prefix} ${message}`, data);
  } else {
    console.log(`${prefix} ${message}`);
  }
}

// Security: List of allowed ports (OpenTTD default ports)
// 3975 = STUN, 3976 = Coordinator, 3978 = Content, 3979-3989 = Game servers, 3986-3987 = TURN
const ALLOWED_PORTS = [
  3973, 3974, 3975, 3976, 3978,              // Infrastructure
  3979, 3980, 3981, 3982, 3983, 3984, 3985,  // Game server ports
  3986, 3987, 3988, 3989,                    // TURN and additional game ports
  1742, 1979, 4000, 4003, 
  5010, 5020, 5030, 5040, 5050, 5060, 5070, 5080, 5090, 5100, 5110, 5120,  // ottd.top
  25520, 
  56111, // ?
];         

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
      log('HTTP', 'Fetching server list from Game Coordinator...');
      const servers = await fetchServerList();
      log('HTTP', `Got ${servers.length} servers`);

      // Update cache
      serverListCache = servers;
      serverListCacheTime = now;

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(servers));
    } catch (err) {
      log('HTTP', `Error fetching server list: ${err.message}`);
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

  // Resolve invite code to direct address
  // Format: /resolve/<invite_code> (with or without leading +)
  if (req.method === 'GET' && req.url.startsWith('/resolve/')) {
    try {
      const inviteCode = decodeURIComponent(req.url.substring('/resolve/'.length));
      if (!inviteCode) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing invite code' }));
        return;
      }

      log('HTTP', `Resolving invite code: ${inviteCode}`);
      const result = await resolveInviteCode(inviteCode);
      log('HTTP', `Resolved ${inviteCode} -> ${result.hostname}:${result.port} (${result.type})`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      log('HTTP', `Error resolving invite code: ${err.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // 404 for other HTTP requests
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

/**
 * Create a TURN SERCLI_CONNECT packet
 */
function createTurnConnectPacket(ticket) {
  const ticketBytes = Buffer.from(ticket + '\0', 'utf8');
  const payloadSize = 1 + ticketBytes.length; // version + ticket
  const packetSize = 3 + payloadSize; // header (2 bytes size + 1 byte type) + payload

  const packet = Buffer.alloc(packetSize);
  let offset = 0;

  // Packet header
  packet.writeUInt16LE(packetSize, offset); offset += 2;
  packet.writeUInt8(PACKET_TURN_SERCLI_CONNECT, offset); offset += 1;

  // Payload
  packet.writeUInt8(NETWORK_COORDINATOR_VERSION, offset); offset += 1;
  ticketBytes.copy(packet, offset);

  return packet;
}

/**
 * Handle TURN connection - connects to TURN server and relays traffic
 */
function handleTurnConnection(ws, turnHost, turnPort, ticket) {
  log('TURN', `Connecting to ${turnHost}:${turnPort}`);
  log('TURN', `Ticket: ${ticket}`);

  const tcpSocket = net.createConnection({
    host: turnHost,
    port: turnPort,
  });

  let turnConnected = false;
  let buffer = Buffer.alloc(0);

  tcpSocket.on('connect', () => {
    log('TURN', `TCP connected, sending SERCLI_CONNECT...`);
    const connectPacket = createTurnConnectPacket(ticket);
    log('TURN', `Sending packet (${connectPacket.length} bytes): ${connectPacket.toString('hex')}`);
    tcpSocket.write(connectPacket);
  });

  tcpSocket.on('data', (data) => {
    log('TURN', `Received ${data.length} bytes: ${data.toString('hex').substring(0, 60)}...`);

    if (!turnConnected) {
      buffer = Buffer.concat([buffer, data]);
      log('TURN', `Buffer: ${buffer.length} bytes`);

      while (buffer.length >= 3) {
        const packetSize = buffer.readUInt16LE(0);
        log('TURN', `Packet size: ${packetSize}`);

        if (buffer.length < packetSize) {
          log('TURN', `Waiting for more data (have ${buffer.length}, need ${packetSize})`);
          break;
        }

        const packetType = buffer.readUInt8(2);
        const payload = buffer.subarray(3, packetSize);
        log('TURN', `Packet type: ${packetType}, payload: ${payload.length} bytes`);

        if (packetType === PACKET_TURN_TURN_ERROR) {
          log('TURN', `ERROR from server! Payload: ${payload.toString('hex')}`);
          ws.close(1011, 'TURN server error');
          tcpSocket.destroy();
          return;
        }

        if (packetType === PACKET_TURN_TURN_CONNECTED) {
          let peerHost = '';
          for (let i = 0; i < payload.length && payload[i] !== 0; i++) {
            peerHost += String.fromCharCode(payload[i]);
          }
          log('TURN', `Connected! Peer: ${peerHost}`);
          turnConnected = true;

          buffer = buffer.subarray(packetSize);
          if (buffer.length > 0 && ws.readyState === ws.OPEN) {
            log('TURN', `Forwarding ${buffer.length} remaining bytes to WS`);
            ws.send(buffer);
            buffer = Buffer.alloc(0);
          }
          return;
        }

        log('TURN', `Unknown packet type ${packetType}, skipping`);
        buffer = buffer.subarray(packetSize);
      }
    } else {
      log('TURN', `Relay TCP->WS: ${data.length} bytes`);
      if (ws.readyState === ws.OPEN) {
        ws.send(data);
      }
    }
  });

  tcpSocket.on('error', (err) => {
    log('TURN', `TCP error: ${err.message}`);
    if (ws.readyState === ws.OPEN) {
      ws.close(1011, `TURN error: ${err.message}`);
    }
  });

  tcpSocket.on('close', () => {
    log('TURN', `TCP closed`);
    if (ws.readyState === ws.OPEN) {
      ws.close(1000, 'TURN connection closed');
    }
  });

  ws.on('message', (data) => {
    if (turnConnected && !tcpSocket.destroyed) {
      log('TURN', `Relay WS->TCP: ${data.length} bytes`);
      tcpSocket.write(data);
    } else {
      log('TURN', `Dropping ${data.length} bytes (not connected)`);
    }
  });

  ws.on('close', () => {
    log('TURN', `WebSocket closed`);
    tcpSocket.destroy();
  });

  ws.on('error', (err) => {
    log('TURN', `WebSocket error: ${err.message}`);
    tcpSocket.destroy();
  });
}

/**
 * Handle direct TCP connection to game server
 */
function handleDirectConnection(ws, targetHost, targetPort) {
  const target = `${targetHost}:${targetPort}`;
  const isCoordinator = targetHost.includes('coordinator');
  log('DIRECT', `Connecting to ${target}${isCoordinator ? ' (Coordinator)' : ''}`);

  const tcpSocket = net.createConnection({
    host: targetHost,
    port: targetPort,
  });

  let connected = false;
  let bytesFromServer = 0;
  let bytesToServer = 0;

  tcpSocket.on('connect', () => {
    connected = true;
    log('DIRECT', `Connected to ${target}`);
  });

  tcpSocket.on('data', (data) => {
    bytesFromServer += data.length;
    if (ws.readyState === ws.OPEN) {
      ws.send(data);
    }
  });

  tcpSocket.on('error', (err) => {
    log('DIRECT', `TCP error (${target}): ${err.message}`);
    if (ws.readyState === ws.OPEN) {
      ws.close(1011, `TCP error: ${err.message}`);
    }
  });

  tcpSocket.on('close', () => {
    log('DIRECT', `TCP closed (${target}) - sent: ${bytesToServer}, received: ${bytesFromServer}`);
    if (ws.readyState === ws.OPEN) {
      ws.close(1000, 'TCP connection closed');
    }
  });

  ws.on('message', (data) => {
    if (connected && !tcpSocket.destroyed) {
      bytesToServer += data.length;
      tcpSocket.write(data);
    }
  });

  ws.on('close', () => {
    log('DIRECT', `WebSocket closed (${target}) - sent: ${bytesToServer}, received: ${bytesFromServer}`);
    tcpSocket.destroy();
  });

  ws.on('error', (err) => {
    log('DIRECT', `WebSocket error: ${err.message}`);
    tcpSocket.destroy();
  });
}

/**
 * Handle invite code connection - resolves and connects via appropriate method
 */
async function handleInviteConnection(ws, inviteCode) {
  log('INVITE', `Resolving ${inviteCode}...`);

  try {
    const result = await resolveInviteCode(inviteCode);
    log('INVITE', `Resolved -> ${result.hostname}:${result.port} (${result.type})`);
    log('INVITE', `Full result:`, result);

    if (result.type === 'turn' && result.ticket) {
      log('INVITE', `Using TURN relay`);
      handleTurnConnection(ws, result.hostname, result.port, result.ticket);
    } else {
      log('INVITE', `Using direct connection`);
      handleDirectConnection(ws, result.hostname, result.port);
    }
  } catch (err) {
    log('INVITE', `Failed to resolve: ${err.message}`);
    log('INVITE', `Error details:`, err);
    ws.close(1011, `Failed to resolve invite code: ${err.message}`);
  }
}

// Create WebSocket server attached to HTTP server
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws, req) => {
  log('WS', `New connection: ${req.url}`);

  const urlParts = req.url.split('/');

  // Handle invite code connections: /invite/<invite_code>
  if (urlParts.length >= 3 && urlParts[1] === 'invite') {
    const inviteCode = decodeURIComponent(urlParts.slice(2).join('/'));
    log('WS', `Invite code: "${inviteCode}"`);
    if (!inviteCode) {
      log('WS', `Invalid invite code, closing`);
      ws.close(1008, 'Invalid invite code');
      return;
    }
    handleInviteConnection(ws, inviteCode);
    return;
  }

  // Handle TURN connections: /turn/<host>/<port>/<ticket>
  if (urlParts.length >= 5 && urlParts[1] === 'turn') {
    const turnHost = urlParts[2];
    const turnPort = parseInt(urlParts[3]);
    const ticket = decodeURIComponent(urlParts.slice(4).join('/'));

    if (!turnHost || isNaN(turnPort) || !ticket) {
      ws.close(1008, 'Invalid TURN parameters');
      return;
    }

    handleTurnConnection(ws, turnHost, turnPort, ticket);
    return;
  }

  // Handle direct connections: /connect/<host>/<port>
  if (urlParts.length < 4 || urlParts[1] !== 'connect') {
    log('WS', `Invalid URL: ${req.url}`);
    ws.close(1008, 'Invalid URL format. Use /connect/<host>/<port>, /turn/<host>/<port>/<ticket>, or /invite/<code>');
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
    log('WS', `Rejected: port ${targetPort} not allowed`);
    ws.close(1008, 'Port not allowed');
    return;
  }

  if (ALLOWED_SERVERS.length > 0 && !ALLOWED_SERVERS.includes(targetHost)) {
    log('WS', `Rejected: ${targetHost} not in allowlist`);
    ws.close(1008, 'Server not in allowlist');
    return;
  }

  handleDirectConnection(ws, targetHost, targetPort);
});

// Start server
httpServer.listen(PROXY_PORT, () => {
  log('SERVER', `OpenTTD WebSocket Proxy listening on port ${PROXY_PORT}`);
  log('SERVER', `Endpoints:`);
  log('SERVER', `  ws://localhost:${PROXY_PORT}/connect/<host>/<port>`);
  log('SERVER', `  ws://localhost:${PROXY_PORT}/turn/<host>/<port>/<ticket>`);
  log('SERVER', `  ws://localhost:${PROXY_PORT}/invite/<invite_code>`);
  log('SERVER', `  http://localhost:${PROXY_PORT}/servers`);
  log('SERVER', `  http://localhost:${PROXY_PORT}/resolve/<invite_code>`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  log('SERVER', 'Shutting down...');
  httpServer.close(() => {
    process.exit(0);
  });
});

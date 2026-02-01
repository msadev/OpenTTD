/**
 * OpenTTD Game Coordinator Client
 *
 * Queries the Game Coordinator to get the list of public servers.
 * Also resolves invite codes to direct connection addresses.
 * The Game Coordinator uses a custom binary protocol over TCP.
 */

import net from 'net';

// Game Coordinator settings
const COORDINATOR_HOST = 'coordinator.openttd.org';
const COORDINATOR_PORT = 3976;
const NETWORK_COORDINATOR_VERSION = 6;
const NETWORK_GAME_INFO_VERSION = 7;
const OPENTTD_REVISION = '14.1'; // Pretend to be a recent stable version

// Packet types
const PACKET_COORDINATOR_GC_ERROR = 0;
const PACKET_COORDINATOR_CLIENT_LISTING = 4;
const PACKET_COORDINATOR_GC_LISTING = 5;
const PACKET_COORDINATOR_CLIENT_CONNECT = 6;
const PACKET_COORDINATOR_GC_CONNECTING = 7;
const PACKET_COORDINATOR_GC_CONNECT_FAILED = 9;
const PACKET_COORDINATOR_GC_DIRECT_CONNECT = 11;
const PACKET_COORDINATOR_GC_STUN_REQUEST = 12;
const PACKET_COORDINATOR_GC_NEWGRF_LOOKUP = 15;
const PACKET_COORDINATOR_GC_TURN_CONNECT = 16;

// Landscape types
const LANDSCAPE_NAMES = ['Temperate', 'Arctic', 'Tropical', 'Toyland'];

/**
 * Fetch the list of public servers from the Game Coordinator
 * @returns {Promise<Array>} List of server objects
 */
export async function fetchServerList() {
  return new Promise((resolve, reject) => {
    const servers = [];
    const newgrfLookup = new Map();
    let buffer = Buffer.alloc(0);
    let timeout;

    const socket = net.createConnection({
      host: COORDINATOR_HOST,
      port: COORDINATOR_PORT,
    });

    socket.setTimeout(10000);

    socket.on('connect', () => {
      // Send CLIENT_LISTING packet
      const packet = createListingPacket();
      socket.write(packet);

      // Set timeout for response
      timeout = setTimeout(() => {
        socket.destroy();
        resolve(servers);
      }, 5000);
    });

    socket.on('data', (data) => {
      buffer = Buffer.concat([buffer, data]);

      // Process complete packets
      while (buffer.length >= 3) {
        // Packet format: 2 bytes size (little-endian) + 1 byte type + payload
        const packetSize = buffer.readUInt16LE(0);

        if (buffer.length < packetSize) {
          break; // Wait for more data
        }

        const packetType = buffer.readUInt8(2);
        const payload = buffer.subarray(3, packetSize);

        if (packetType === PACKET_COORDINATOR_GC_NEWGRF_LOOKUP) {
          parseNewGRFLookup(payload, newgrfLookup);
        } else if (packetType === PACKET_COORDINATOR_GC_LISTING) {
          const result = parseListingPacket(payload, newgrfLookup);
          if (result.servers.length === 0) {
            // End of list
            clearTimeout(timeout);
            socket.end();
            resolve(servers);
            return;
          }
          servers.push(...result.servers);
        }

        buffer = buffer.subarray(packetSize);
      }
    });

    socket.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    socket.on('timeout', () => {
      clearTimeout(timeout);
      socket.destroy();
      resolve(servers);
    });

    socket.on('close', () => {
      clearTimeout(timeout);
      resolve(servers);
    });
  });
}

/**
 * Create a CLIENT_LISTING packet
 */
function createListingPacket() {
  // Calculate packet size
  const revisionBytes = Buffer.from(OPENTTD_REVISION + '\0', 'utf8');
  const payloadSize = 1 + 1 + revisionBytes.length + 4; // version + game_info_version + revision + cursor
  const packetSize = 3 + payloadSize; // header (2 bytes size + 1 byte type) + payload

  const packet = Buffer.alloc(packetSize);
  let offset = 0;

  // Packet header
  packet.writeUInt16LE(packetSize, offset); offset += 2;
  packet.writeUInt8(PACKET_COORDINATOR_CLIENT_LISTING, offset); offset += 1;

  // Payload
  packet.writeUInt8(NETWORK_COORDINATOR_VERSION, offset); offset += 1;
  packet.writeUInt8(NETWORK_GAME_INFO_VERSION, offset); offset += 1;
  revisionBytes.copy(packet, offset); offset += revisionBytes.length;
  packet.writeUInt32LE(0, offset); // NewGRF lookup cursor (0 = request full table)

  return packet;
}

/**
 * Parse a GC_NEWGRF_LOOKUP packet
 */
function parseNewGRFLookup(payload, lookupTable) {
  let offset = 0;

  // Skip cookie (4 bytes)
  offset += 4;

  // Read number of NewGRFs
  const count = payload.readUInt16LE(offset);
  offset += 2;

  for (let i = 0; i < count; i++) {
    if (offset >= payload.length) break;

    // Read lookup index
    const index = payload.readUInt32LE(offset);
    offset += 4;

    // Read GRF ID
    const grfId = payload.readUInt32LE(offset);
    offset += 4;

    // Read MD5 (16 bytes)
    const md5 = payload.subarray(offset, offset + 16).toString('hex');
    offset += 16;

    // Read name (null-terminated string)
    let nameEnd = offset;
    while (nameEnd < payload.length && payload[nameEnd] !== 0) {
      nameEnd++;
    }
    const name = payload.subarray(offset, nameEnd).toString('utf8');
    offset = nameEnd + 1;

    lookupTable.set(index, { grfId, md5, name });
  }
}

/**
 * Parse a GC_LISTING packet
 */
function parseListingPacket(payload, newgrfLookup) {
  const servers = [];
  let offset = 0;

  // Read server count
  const serverCount = payload.readUInt16LE(offset);
  offset += 2;

  if (serverCount === 0) {
    return { servers: [], done: true };
  }

  for (let i = 0; i < serverCount; i++) {
    try {
      const server = {};

      // Read connection string (null-terminated)
      let strEnd = offset;
      while (strEnd < payload.length && payload[strEnd] !== 0) {
        strEnd++;
      }
      server.connection_string = payload.subarray(offset, strEnd).toString('utf8');
      offset = strEnd + 1;

      // Parse NetworkGameInfo
      // Version
      const infoVersion = payload.readUInt8(offset);
      offset += 1;

      // Ticks playing (version 7+)
      if (infoVersion >= 7) {
        server.ticks_playing = Number(payload.readBigUInt64LE(offset));
        offset += 8;
      }

      // NewGRF storage type (version 6+)
      let newgrfType = 0;
      if (infoVersion >= 6) {
        newgrfType = payload.readUInt8(offset);
        offset += 1;
      }

      // Game Script (version 5+)
      if (infoVersion >= 5) {
        server.gamescript_version = payload.readInt32LE(offset);
        offset += 4;

        let gsEnd = offset;
        while (gsEnd < payload.length && payload[gsEnd] !== 0) {
          gsEnd++;
        }
        server.gamescript_name = payload.subarray(offset, gsEnd).toString('utf8');
        offset = gsEnd + 1;
      }

      // NewGRFs (version 4+)
      server.newgrfs = [];
      if (infoVersion >= 4) {
        const grfCount = payload.readUInt8(offset);
        offset += 1;

        for (let g = 0; g < grfCount; g++) {
          if (newgrfType === 2) {
            // Lookup table index
            const lookupIndex = payload.readUInt32LE(offset);
            offset += 4;
            const grf = newgrfLookup.get(lookupIndex);
            if (grf) {
              server.newgrfs.push(grf.name);
            }
          } else {
            // GRF ID + MD5
            offset += 4; // GRF ID
            offset += 16; // MD5
            if (newgrfType === 1) {
              // Also has name
              let nameEnd = offset;
              while (nameEnd < payload.length && payload[nameEnd] !== 0) {
                nameEnd++;
              }
              server.newgrfs.push(payload.subarray(offset, nameEnd).toString('utf8'));
              offset = nameEnd + 1;
            }
          }
        }
      }

      // Date info (version 3+)
      if (infoVersion >= 3) {
        server.calendar_date = payload.readInt32LE(offset);
        offset += 4;
        server.calendar_start = payload.readInt32LE(offset);
        offset += 4;
      }

      // Company info (version 2+)
      if (infoVersion >= 2) {
        server.companies_max = payload.readUInt8(offset);
        offset += 1;
        server.companies_on = payload.readUInt8(offset);
        offset += 1;
        server.spectators_max = payload.readUInt8(offset);
        offset += 1;
      }

      // Basic info (version 1+)
      // Server name
      let nameEnd = offset;
      while (nameEnd < payload.length && payload[nameEnd] !== 0) {
        nameEnd++;
      }
      server.name = payload.subarray(offset, nameEnd).toString('utf8');
      offset = nameEnd + 1;

      // Server revision
      let revEnd = offset;
      while (revEnd < payload.length && payload[revEnd] !== 0) {
        revEnd++;
      }
      server.version = payload.subarray(offset, revEnd).toString('utf8');
      offset = revEnd + 1;

      // Skip language for version 1-5
      if (infoVersion <= 5) {
        offset += 1;
      }

      // Password
      server.password = payload.readUInt8(offset) === 1;
      offset += 1;

      // Client counts
      server.clients_max = payload.readUInt8(offset);
      offset += 1;
      server.clients_on = payload.readUInt8(offset);
      offset += 1;
      server.spectators_on = payload.readUInt8(offset);
      offset += 1;

      // Skip old date format for version 1-2
      if (infoVersion <= 2) {
        offset += 4; // 2x uint16
      }

      // Skip map name for version 1-5
      if (infoVersion <= 5) {
        let mapEnd = offset;
        while (mapEnd < payload.length && payload[mapEnd] !== 0) {
          mapEnd++;
        }
        offset = mapEnd + 1;
      }

      // Map size
      server.map_width = payload.readUInt16LE(offset);
      offset += 2;
      server.map_height = payload.readUInt16LE(offset);
      offset += 2;

      // Landscape
      const landscapeType = payload.readUInt8(offset);
      server.landscape = LANDSCAPE_NAMES[landscapeType] || 'Unknown';
      offset += 1;

      // Dedicated
      server.dedicated = payload.readUInt8(offset) === 1;
      offset += 1;

      servers.push(server);
    } catch (e) {
      // Skip malformed server entry
      break;
    }
  }

  return { servers, done: false };
}

/**
 * Resolve an invite code to a direct connection address
 * @param {string} inviteCode The invite code (with or without leading +)
 * @returns {Promise<{hostname: string, port: number}>} The resolved address
 */
export async function resolveInviteCode(inviteCode) {
  // Ensure invite code starts with +
  if (!inviteCode.startsWith('+')) {
    inviteCode = '+' + inviteCode;
  }

  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    let timeout;
    let token = null;

    const socket = net.createConnection({
      host: COORDINATOR_HOST,
      port: COORDINATOR_PORT,
    });

    socket.setTimeout(15000);

    socket.on('connect', () => {
      // Send CLIENT_CONNECT packet
      const packet = createConnectPacket(inviteCode);
      socket.write(packet);

      // Set timeout for response
      timeout = setTimeout(() => {
        socket.destroy();
        reject(new Error('Timeout waiting for coordinator response'));
      }, 10000);
    });

    socket.on('data', (data) => {
      buffer = Buffer.concat([buffer, data]);

      // Process complete packets
      while (buffer.length >= 3) {
        const packetSize = buffer.readUInt16LE(0);

        if (buffer.length < packetSize) {
          break; // Wait for more data
        }

        const packetType = buffer.readUInt8(2);
        const payload = buffer.subarray(3, packetSize);

        if (packetType === PACKET_COORDINATOR_GC_ERROR) {
          clearTimeout(timeout);
          socket.destroy();
          const errorType = payload.readUInt8(0);
          const detail = readString(payload, 1);
          reject(new Error(`Coordinator error ${errorType}: ${detail}`));
          return;
        }

        if (packetType === PACKET_COORDINATOR_GC_CONNECTING) {
          // Store token for tracking
          token = readString(payload, 0);
          console.log(`[Coordinator] Got token: ${token}`);
        }

        if (packetType === PACKET_COORDINATOR_GC_DIRECT_CONNECT) {
          clearTimeout(timeout);
          // Parse: token (string), tracking_number (uint8), hostname (string), port (uint16)
          let offset = 0;
          const responseToken = readString(payload, offset);
          offset += responseToken.length + 1;
          const trackingNumber = payload.readUInt8(offset);
          offset += 1;
          const hostname = readString(payload, offset);
          offset += hostname.length + 1;
          const port = payload.readUInt16LE(offset);

          console.log(`[Coordinator] Direct connect: ${hostname}:${port}`);
          socket.end();
          resolve({ hostname, port, type: 'direct' });
          return;
        }

        if (packetType === PACKET_COORDINATOR_GC_STUN_REQUEST) {
          // Server requires STUN - we can't do that from the proxy
          // But we can still wait for a possible TURN fallback
          console.log(`[Coordinator] Server requires STUN, waiting for TURN fallback...`);
        }

        if (packetType === PACKET_COORDINATOR_GC_TURN_CONNECT) {
          clearTimeout(timeout);
          // Parse: token (string), tracking_number (uint8), ticket (string), connection_string (string)
          let offset = 0;
          const responseToken = readString(payload, offset);
          offset += responseToken.length + 1;
          const trackingNumber = payload.readUInt8(offset);
          offset += 1;
          const ticket = readString(payload, offset);
          offset += ticket.length + 1;
          const connectionString = readString(payload, offset);

          console.log(`[Coordinator] TURN connect: ${connectionString} (ticket: ${ticket})`);
          socket.end();
          // Parse connection string (host:port format)
          const [turnHost, turnPort] = connectionString.split(':');
          resolve({
            hostname: turnHost,
            port: parseInt(turnPort) || 3979,
            type: 'turn',
            ticket
          });
          return;
        }

        if (packetType === PACKET_COORDINATOR_GC_CONNECT_FAILED) {
          clearTimeout(timeout);
          socket.destroy();
          reject(new Error('Connection failed - server may be offline or unreachable'));
          return;
        }

        buffer = buffer.subarray(packetSize);
      }
    });

    socket.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    socket.on('timeout', () => {
      clearTimeout(timeout);
      socket.destroy();
      reject(new Error('Connection timeout'));
    });

    socket.on('close', () => {
      clearTimeout(timeout);
    });
  });
}

/**
 * Create a CLIENT_CONNECT packet
 */
function createConnectPacket(inviteCode) {
  const inviteCodeBytes = Buffer.from(inviteCode + '\0', 'utf8');
  const payloadSize = 1 + inviteCodeBytes.length; // version + invite_code
  const packetSize = 3 + payloadSize; // header + payload

  const packet = Buffer.alloc(packetSize);
  let offset = 0;

  // Packet header
  packet.writeUInt16LE(packetSize, offset); offset += 2;
  packet.writeUInt8(PACKET_COORDINATOR_CLIENT_CONNECT, offset); offset += 1;

  // Payload
  packet.writeUInt8(NETWORK_COORDINATOR_VERSION, offset); offset += 1;
  inviteCodeBytes.copy(packet, offset);

  return packet;
}

/**
 * Read a null-terminated string from buffer
 */
function readString(buffer, offset) {
  let end = offset;
  while (end < buffer.length && buffer[end] !== 0) {
    end++;
  }
  return buffer.subarray(offset, end).toString('utf8');
}

// CLI test
if (process.argv[1].endsWith('game-coordinator.js')) {
  const testInviteCode = process.argv[2];

  if (testInviteCode) {
    console.log(`Resolving invite code: ${testInviteCode}...`);
    resolveInviteCode(testInviteCode)
      .then((result) => {
        console.log(`Resolved to: ${result.hostname}:${result.port} (${result.type})`);
        if (result.ticket) {
          console.log(`TURN ticket: ${result.ticket}`);
        }
      })
      .catch((err) => {
        console.error('Error:', err.message);
      });
  } else {
    console.log('Fetching server list from Game Coordinator...');
    fetchServerList()
      .then((servers) => {
        console.log(`Found ${servers.length} servers:\n`);
        servers.forEach((server, i) => {
          console.log(`${i + 1}. ${server.name}`);
          console.log(`   Address: ${server.connection_string}`);
          console.log(`   Version: ${server.version}`);
          console.log(`   Players: ${server.clients_on}/${server.clients_max}`);
          console.log(`   Map: ${server.map_width}x${server.map_height} (${server.landscape})`);
          console.log(`   Password: ${server.password ? 'Yes' : 'No'}`);
          console.log('');
        });
      })
      .catch((err) => {
        console.error('Error:', err);
      });
  }
}

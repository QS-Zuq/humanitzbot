const net = require('net');
const config = require('./config');

/**
 * Custom RCON client for HumanitZ.
 *
 * HumanitZ's RCON doesn't follow standard Source RCON response conventions.
 * This implementation is very lenient — after authenticating, it sends a command
 * and accepts ANY data that comes back as the response.
 */

const SERVERDATA_AUTH = 3;
const SERVERDATA_EXECCOMMAND = 2;

class RconManager {
  constructor() {
    this.socket = null;
    this.connected = false;
    this.authenticated = false;
    this.reconnectTimeout = null;
    this.cache = new Map();
    this.requestId = 100; // start higher to avoid confusion with auth IDs
    this._responseBuffer = Buffer.alloc(0);
    this._commandCallback = null; // only one command at a time
    this._authCallback = null;
    this._commandQueue = Promise.resolve(); // serialize commands via promise chain
  }

  /**
   * Connect and authenticate to the RCON server.
   */
  async connect() {
    if (this.connected && this.authenticated) return;

    this._cleanup();

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this._cleanup();
        reject(new Error('Connection timeout'));
      }, 15000);

      this.socket = new net.Socket();

      this.socket.connect(config.rconPort, config.rconHost, () => {
        this.connected = true;
        console.log(`[RCON] TCP connected to ${config.rconHost}:${config.rconPort}`);

        // Send auth packet
        this._sendPacket(1, SERVERDATA_AUTH, config.rconPassword);

        const authTimeout = setTimeout(() => {
          clearTimeout(timeout);
          this._cleanup();
          reject(new Error('Authentication timeout'));
        }, 10000);

        this._authCallback = (id) => {
          this._authCallback = null;
          clearTimeout(authTimeout);
          clearTimeout(timeout);
          if (id === -1) {
            this._cleanup();
            reject(new Error('Authentication failed — wrong RCON password'));
          } else {
            this.authenticated = true;
            console.log('[RCON] Authenticated successfully');
            resolve();
          }
        };
      });

      this.socket.on('data', (data) => this._onData(data));

      this.socket.on('error', (err) => {
        console.error('[RCON] Socket error:', err.message);
        clearTimeout(timeout);
        this._cleanup();
        this._scheduleReconnect();
      });

      this.socket.on('close', () => {
        if (this.connected) {
          console.log('[RCON] Connection closed');
          this._cleanup();
          this._scheduleReconnect();
        }
      });
    });
  }

  /**
   * Send an RCON command and return the response string.
   * Commands are serialized — only one at a time.
   */
  async send(command) {
    // Serialize commands via promise chain (no busy-wait polling)
    return new Promise((resolve, reject) => {
      this._commandQueue = this._commandQueue.then(async () => {
        try {
          if (!this.connected || !this.authenticated) {
            await this.connect();
          }

          if (!this.connected || !this.authenticated) {
            throw new Error('RCON not connected');
          }

          const result = await this._sendCommand(command);
          resolve(result);
        } catch (err) {
          reject(err);
        }
      });
    });
  }

  _sendCommand(command) {
    return new Promise((resolve, reject) => {
      const id = this._nextId();
      let responseData = '';
      let resolved = false;
      let dataTimer = null;

      // Absolute timeout — if nothing comes back at all
      const hardTimeout = setTimeout(() => {
        this._commandCallback = null;
        if (!resolved) {
          resolved = true;
          if (responseData) {
            resolve(responseData);
          } else {
            console.error(`[RCON] No response for: ${command}`);
            reject(new Error(`No response for command: ${command}`));
          }
        }
      }, 10000);

      // Accept ANY incoming packet body as response data
      this._commandCallback = (body) => {
        responseData += body;

        // Reset the collection timer — wait for more data
        if (dataTimer) clearTimeout(dataTimer);
        dataTimer = setTimeout(() => {
          clearTimeout(hardTimeout);
          this._commandCallback = null;
          if (!resolved) {
            resolved = true;
            console.log(`[RCON] Response for "${command}": ${responseData.substring(0, 200)}`);
            resolve(responseData);
          }
        }, 1000); // wait 1s after last data packet
      };

      try {
        this._sendPacket(id, SERVERDATA_EXECCOMMAND, command);
        console.log(`[RCON] Sent command: ${command} (id=${id})`);
      } catch (err) {
        clearTimeout(hardTimeout);
        if (dataTimer) clearTimeout(dataTimer);
        this._commandCallback = null;
        this.connected = false;
        this.authenticated = false;
        reject(err);
      }
    });
  }

  /**
   * Send a command with caching.
   */
  async sendCached(command, ttl = config.statusCacheTtl) {
    const cached = this.cache.get(command);
    if (cached && Date.now() - cached.timestamp < ttl) {
      return cached.data;
    }

    // Evict stale cache entries to prevent unbounded growth
    if (this.cache.size > 50) {
      const now = Date.now();
      for (const [key, entry] of this.cache) {
        if (now - entry.timestamp > ttl * 2) this.cache.delete(key);
      }
    }

    const data = await this.send(command);
    this.cache.set(command, { data, timestamp: Date.now() });
    return data;
  }

  /**
   * Disconnect from the RCON server.
   */
  async disconnect() {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    this._cleanup();
  }

  // ── Private ──────────────────────────────────────────────

  _nextId() {
    return this.requestId++;
  }

  _sendPacket(id, type, body) {
    const bodyBuf = Buffer.from(body, 'utf8');
    const size = 4 + 4 + bodyBuf.length + 1 + 1;
    const packet = Buffer.alloc(4 + size);
    packet.writeInt32LE(size, 0);
    packet.writeInt32LE(id, 4);
    packet.writeInt32LE(type, 8);
    bodyBuf.copy(packet, 12);
    packet.writeInt8(0, 12 + bodyBuf.length);
    packet.writeInt8(0, 13 + bodyBuf.length);
    this.socket.write(packet);
  }

  _onData(data) {
    this._responseBuffer = Buffer.concat([this._responseBuffer, data]);

    while (this._responseBuffer.length >= 12) {
      const size = this._responseBuffer.readInt32LE(0);

      // Sanity check — if size is nonsensical, try treating raw data as text
      if (size < 10 || size > 65536) {
        console.log(`[RCON] Non-standard packet (size=${size}), treating as raw text`);
        const rawText = this._responseBuffer.toString('utf8');
        this._responseBuffer = Buffer.alloc(0);
        if (this._commandCallback) {
          this._commandCallback(rawText);
        }
        return;
      }

      if (this._responseBuffer.length < 4 + size) {
        break; // wait for more data
      }

      const id = this._responseBuffer.readInt32LE(4);
      const type = this._responseBuffer.readInt32LE(8);

      // Body is between offset 12 and (4 + size - 2), excluding 2 null terminators
      const bodyEnd = Math.max(12, 4 + size - 2);
      const body = this._responseBuffer.toString('utf8', 12, bodyEnd);

      // Consume packet
      this._responseBuffer = this._responseBuffer.slice(4 + size);

      console.log(`[RCON] Packet: id=${id} type=${type} bodyLen=${body.length} body="${body.substring(0, 100)}"`);

      // During auth phase — type 2 with id matching auth (1) or id -1
      if (this._authCallback && !this.authenticated) {
        if (type === 2 || type === 0) {
          // Some servers send an empty type 0 before the type 2 auth response — skip it
          if (type === 0 && body === '' && id === 1) continue;
          this._authCallback(id);
          continue;
        }
      }

      // After auth — any packet body goes to the command callback
      if (this._commandCallback && this.authenticated) {
        if (body !== '') {
          this._commandCallback(body);
        }
      }
    }
  }

  _cleanup() {
    this.connected = false;
    this.authenticated = false;
    this._commandQueue = Promise.resolve();
    this._commandCallback = null;
    this._authCallback = null;
    if (this.socket) {
      try { this.socket.destroy(); } catch (_) {}
      this.socket = null;
    }
    this._responseBuffer = Buffer.alloc(0);
  }

  _scheduleReconnect() {
    if (this.reconnectTimeout) return;
    console.log('[RCON] Reconnecting in 15 seconds...');
    this.reconnectTimeout = setTimeout(async () => {
      this.reconnectTimeout = null;
      try {
        await this.connect();
      } catch (err) {
        console.error('[RCON] Reconnect failed:', err.message);
      }
    }, 15000);
  }
}

module.exports = new RconManager();

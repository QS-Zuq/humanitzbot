import net from 'node:net';
import { EventEmitter } from 'node:events';
import config from '../config/index.js';
import { createLogger, type Logger } from '../utils/log.js';
import { ReconnectBackoff, formatReconnectDelay } from './reconnect-backoff.js';

const SERVERDATA_AUTH = 3;
const SERVERDATA_EXECCOMMAND = 2;

interface RconOptions {
  host?: string;
  port?: number;
  password?: string;
  label?: string;
  cacheTtl?: number;
  Socket?: typeof net.Socket;
}

interface CacheEntry {
  data: string;
  timestamp: number;
}

class RconManager extends EventEmitter {
  socket: net.Socket | null;
  connected: boolean;
  authenticated: boolean;
  reconnectTimeout: ReturnType<typeof setTimeout> | null;
  cache: Map<string, CacheEntry>;
  requestId: number;
  _responseBuffer: Buffer;
  _commandCallback: ((body: string) => void) | null;
  _authCallback: ((id: number) => void) | null;
  _commandQueue: Promise<void>;
  _host: string | null;
  _port: number | null;
  _password: string | null;
  _log: Logger;
  _cacheTtl: number | null;
  _Socket: typeof net.Socket;
  _reconnectBackoff: ReconnectBackoff;
  /** True after first successful connect — distinguishes initial connection from reconnects. */
  _everConnected: boolean;
  /** Timestamp of last disconnect (for uptime reporting). */
  _disconnectedAt: number | null;

  constructor(options: RconOptions = {}) {
    super();
    this.socket = null;
    this.connected = false;
    this.authenticated = false;
    this.reconnectTimeout = null;
    this.cache = new Map();
    this.requestId = 100; // start higher to avoid confusion with auth IDs
    this._responseBuffer = Buffer.alloc(0);
    this._commandCallback = null; // only one command at a time
    this._authCallback = null;
    this._commandQueue = Promise.resolve();
    // Per-instance overrides (for multi-server support)
    this._host = options.host ?? null;
    this._port = options.port ?? null;
    this._password = options.password ?? null;
    this._log = createLogger(options.label, 'RCON');
    this._cacheTtl = options.cacheTtl ?? null;
    this._Socket = options.Socket ?? net.Socket;
    this._reconnectBackoff = new ReconnectBackoff();
    this._everConnected = false;
    this._disconnectedAt = null;
  }

  async connect(): Promise<void> {
    if (this.connected && this.authenticated) return;

    this._cleanup();

    return new Promise((resolve, reject) => {
      let settled = false;
      let authTimeout: ReturnType<typeof setTimeout> | null = null;

      const clearConnectTimers = () => {
        clearTimeout(timeout);
        if (authTimeout) {
          clearTimeout(authTimeout);
          authTimeout = null;
        }
      };

      const failConnect = (err: Error) => {
        clearConnectTimers();
        if (!settled) {
          settled = true;
          reject(err);
        }
      };

      const resolveConnect = () => {
        clearConnectTimers();
        if (!settled) {
          settled = true;
          resolve();
        }
      };

      const timeout = setTimeout(() => {
        this._cleanup();
        failConnect(new Error('Connection timeout'));
      }, 15000);

      const socket = new this._Socket();
      this.socket = socket;

      const host = this._host ?? config.rconHost ?? 'localhost';
      const port = this._port ?? config.rconPort;
      const password = this._password ?? config.rconPassword ?? '';

      socket.connect(port, host, () => {
        this.connected = true;
        this._log.info(`TCP connected to ${host}:${String(port)}`);

        // Send auth packet
        this._sendPacket(1, SERVERDATA_AUTH, password);

        authTimeout = setTimeout(() => {
          this._cleanup();
          failConnect(new Error('Authentication timeout'));
        }, 10000);

        this._authCallback = (id) => {
          this._authCallback = null;
          if (id === -1) {
            this._cleanup();
            failConnect(new Error('Authentication failed — wrong RCON password'));
          } else {
            this._handleAuthSuccess(resolveConnect);
          }
        };
      });

      socket.on('data', (data: Buffer) => {
        this._onData(data);
      });

      socket.on('error', (err: Error) => {
        this._log.error('Socket error:', err.message);
        if (this._everConnected && !this._disconnectedAt) {
          this._disconnectedAt = Date.now();
          this.emit('disconnect', { reason: err.message });
        }
        this._cleanup();
        failConnect(new Error(err.message));
        this._scheduleReconnect();
      });

      socket.on('close', () => {
        const connectingSocketClosed = this.socket === socket && !settled;
        if (this.connected || connectingSocketClosed) {
          this._log.info('Connection closed');
          if (this._everConnected && !this._disconnectedAt) {
            this._disconnectedAt = Date.now();
            this.emit('disconnect', { reason: 'Connection closed' });
          }
          this._cleanup();
          failConnect(new Error('Connection closed'));
          this._scheduleReconnect();
        }
      });
    });
  }

  async send(command: string): Promise<string> {
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
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    });
  }

  _sendCommand(command: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const id = this._nextId();
      let responseData = '';
      let resolved = false;
      let dataTimer: ReturnType<typeof setTimeout> | null = null;

      // Absolute timeout — if nothing comes back at all
      const hardTimeout = setTimeout(() => {
        this._commandCallback = null;
        if (!resolved) {
          resolved = true;
          if (responseData) {
            resolve(responseData);
          } else {
            this._log.error(`No response for: ${command}`);
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
            resolve(responseData);
          }
        }, 1000); // wait 1s after last data packet
      };

      try {
        this._sendPacket(id, SERVERDATA_EXECCOMMAND, command);
      } catch (err) {
        clearTimeout(hardTimeout);
        // dataTimer cannot be set yet — _sendPacket is synchronous
        this._commandCallback = null;
        this.connected = false;
        this.authenticated = false;
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  async sendCached(command: string, ttl: number | null = null): Promise<string> {
    const effectiveTtl = ttl ?? this._cacheTtl ?? config.statusCacheTtl;
    const cached = this.cache.get(command);
    if (cached && Date.now() - cached.timestamp < effectiveTtl) {
      return cached.data;
    }

    // Evict stale cache entries to prevent unbounded growth
    if (this.cache.size > 50) {
      const now = Date.now();
      for (const [key, entry] of this.cache) {
        if (now - entry.timestamp > effectiveTtl * 2) this.cache.delete(key);
      }
    }

    const data = await this.send(command);
    this.cache.set(command, { data, timestamp: Date.now() });
    return data;
  }

  disconnect(): void {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    this._reconnectBackoff.reset();
    this._cleanup();
  }

  // ── Private ──────────────────────────────────────────────

  _nextId(): number {
    this.requestId = (this.requestId + 1) & 0x7fffffff;
    return this.requestId;
  }

  _handleAuthSuccess(resolveConnect: () => void): void {
    this.authenticated = true;
    this._reconnectBackoff.reset();
    this._log.info('Authenticated successfully');
    // Emit reconnect event (after first initial connect, subsequent connects are reconnects)
    if (this._everConnected) {
      const downtime = this._disconnectedAt ? Date.now() - this._disconnectedAt : null;
      this.emit('reconnect', { downtime });
    }
    this._everConnected = true;
    this._disconnectedAt = null;
    resolveConnect();
  }

  _sendPacket(id: number, type: number, body: string): void {
    const bodyBuf = Buffer.from(body, 'utf8');
    const size = 4 + 4 + bodyBuf.length + 1 + 1;
    const packet = Buffer.alloc(4 + size);
    packet.writeInt32LE(size, 0);
    packet.writeInt32LE(id, 4);
    packet.writeInt32LE(type, 8);
    bodyBuf.copy(packet, 12);
    packet.writeInt8(0, 12 + bodyBuf.length);
    packet.writeInt8(0, 13 + bodyBuf.length);
    // socket is always set when _sendPacket is called (after connect)
    (this.socket as net.Socket).write(packet);
  }

  _onData(data: Buffer): void {
    this._responseBuffer = Buffer.concat([this._responseBuffer, data]);

    while (this._responseBuffer.length >= 12) {
      const size = this._responseBuffer.readInt32LE(0);

      // Sanity check — if size is nonsensical, try treating raw data as text
      if (size < 10 || size > 65536) {
        this._log.info(`Non-standard packet (size=${String(size)}), treating as raw text`);
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
      this._responseBuffer = this._responseBuffer.subarray(4 + size);

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

  _cleanup(): void {
    this.connected = false;
    this.authenticated = false;
    this._commandQueue = Promise.resolve();
    this._commandCallback = null;
    this._authCallback = null;
    if (this.socket) {
      try {
        this.socket.destroy();
      } catch (_) {
        /* ignore */
      }
      this.socket = null;
    }
    this._responseBuffer = Buffer.alloc(0);
  }

  _scheduleReconnect(): void {
    if (this.reconnectTimeout) return;
    const delayMs = this._reconnectBackoff.nextDelayMs();
    this._log.info(`Reconnecting in ${formatReconnectDelay(delayMs)}...`);
    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      this.connect().catch((err: unknown) => {
        this._log.error('Reconnect failed:', err instanceof Error ? err.message : String(err));
        this._scheduleReconnect();
      });
    }, delayMs);
  }
}

const _singleton = new RconManager();
export default _singleton;
export { RconManager };

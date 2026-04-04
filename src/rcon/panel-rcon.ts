/**
 * WebSocket-based RCON transport for Pterodactyl-hosted game servers.
 *
 * Drop-in alternative to RconManager when the game server is hosted on a
 * Pterodactyl panel (BisectHosting, Bloom.host, etc.).  Uses the panel's
 * WebSocket console endpoint to send game commands and receive responses.
 *
 * The Pterodactyl WebSocket console forwards input to the game process's stdin
 * and streams stdout back.  For HumanitZ, this means RCON-style commands
 * (`info`, `Players`, `admin`, etc.) work identically — the game server
 * doesn't know the difference between a TCP RCON packet and a stdin line.
 *
 * Interface matches RconManager so callers (server-info.ts, chat-relay.js,
 * multi-server.js) can use either transport transparently:
 *
 *   const rcon = new PanelRcon({ panelApi });
 *   await rcon.connect();
 *   const info = await rcon.send('info');
 *   const cached = await rcon.sendCached('Players', 30000);
 *
 * Lifecycle:
 *   1. connect()  → gets JWT from panel API → opens WSS → authenticates
 *   2. send(cmd)  → queues command → waits for output lines → resolves
 *   3. Token refresh: panel JWTs expire after ~10 min; the server sends a
 *      "token expiring" event at ~7 min.  We request a new JWT and send
 *      an "auth" message to keep the connection alive.
 *   4. disconnect() → closes WebSocket, clears timers
 *
 * Events (EventEmitter):
 *   - 'reconnect'  { downtime }  — re-established after drop
 *   - 'disconnect' { reason }    — connection lost
 *   - 'output'     string        — raw console output line
 */

import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { createLogger, type Logger } from '../utils/log.js';

interface PanelApi {
  available: boolean;
  getWebsocketAuth(): Promise<{ token?: string; socket?: string }>;
}

interface CacheEntry {
  data: string;
  timestamp: number;
}

interface PanelRconOptions {
  panelApi?: PanelApi;
  label?: string;
  cacheTtl?: number;
  WebSocket?: typeof WebSocket;
  silenceMs?: number;
}

interface WsMessage {
  event?: string;
  args?: string[];
}

class PanelRcon extends EventEmitter {
  _panelApi: PanelApi | null;
  _log: Logger;
  _cacheTtl: number | null;
  _WebSocket: typeof WebSocket;
  _silenceMs: number;

  // WebSocket state
  _ws: WebSocket | null;
  _wsUrl: string | null;
  _token: string | null;

  // Connection flags (match RconManager interface)
  connected: boolean;
  authenticated: boolean;
  cache: Map<string, CacheEntry>;

  // Command queue — sequential, one at a time (match RconManager)
  _commandQueue: Promise<void>;

  // Reconnect
  _reconnectTimeout: ReturnType<typeof setTimeout> | null;
  _connectPromise: Promise<void> | null;
  _everConnected: boolean;
  _disconnectedAt: number | null;

  // Token refresh
  _tokenRefreshTimer: ReturnType<typeof setTimeout> | null;

  // Output buffer — collects lines between command send and response
  _outputBuffer: string[];
  _outputCallback: ((line: string) => void) | null;

  constructor(options: PanelRconOptions = {}) {
    super();
    this._panelApi = options.panelApi ?? null;
    this._log = createLogger(options.label, 'PANEL-RCON');
    this._cacheTtl = options.cacheTtl ?? null;
    this._WebSocket = options.WebSocket ?? WebSocket;
    this._silenceMs = options.silenceMs ?? 1500;

    // WebSocket state
    this._ws = null;
    this._wsUrl = null;
    this._token = null;

    // Connection flags (match RconManager interface)
    this.connected = false;
    this.authenticated = false;
    this.cache = new Map();

    // Command queue — sequential, one at a time (match RconManager)
    this._commandQueue = Promise.resolve();

    // Reconnect
    this._reconnectTimeout = null;
    this._connectPromise = null;
    this._everConnected = false;
    this._disconnectedAt = null;

    // Token refresh
    this._tokenRefreshTimer = null;

    // Output buffer — collects lines between command send and response
    this._outputBuffer = [];
    this._outputCallback = null;
  }

  // ── Connection lifecycle ────────────────────────────────────

  async connect(): Promise<void> {
    if (this.connected && this.authenticated) return;

    // Prevent concurrent connect attempts — wait for existing one
    if (this._connectPromise) return this._connectPromise;

    this._connectPromise = this._doConnect().finally(() => {
      this._connectPromise = null;
    });
    return this._connectPromise;
  }

  async _doConnect(): Promise<void> {
    this._cleanup();

    if (!this._panelApi) {
      try {
        this._panelApi = (await import('../server/panel-api.js')).default as unknown as PanelApi;
      } catch {
        throw new Error('Panel API module not available');
      }
    }

    if (!this._panelApi.available) {
      throw new Error('Panel API not configured (PANEL_SERVER_URL + PANEL_API_KEY required)');
    }

    // Get fresh JWT + WSS URL
    const auth = await this._panelApi.getWebsocketAuth();
    if (!auth.token || !auth.socket) {
      throw new Error('Failed to get WebSocket credentials from panel API');
    }

    this._token = auth.token;
    this._wsUrl = auth.socket;

    // Capture locally so TypeScript knows they're non-null inside the Promise
    const wsUrl = auth.socket;
    const token = auth.token;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this._cleanup();
        reject(new Error('WebSocket connection timeout'));
      }, 15000);

      const ws = new this._WebSocket(wsUrl, {
        headers: { Origin: 'https://games.bisecthosting.com' },
      });
      this._ws = ws;

      ws.on('open', () => {
        // Authenticate with the JWT
        try {
          ws.send(
            JSON.stringify({
              event: 'auth',
              args: [token],
            }),
          );
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          this._log.error('Auth send failed:', error.message);
          clearTimeout(timeout);
          reject(error);
          this._cleanup();
        }
      });

      ws.on('message', (raw: WebSocket.RawData) => {
        let msg: WsMessage;
        try {
          // raw is Buffer | ArrayBuffer | Buffer[] — convert to string safely
          const rawStr = Buffer.isBuffer(raw)
            ? raw.toString('utf8')
            : Array.isArray(raw)
              ? Buffer.concat(raw).toString('utf8')
              : Buffer.from(raw).toString('utf8');
          msg = JSON.parse(rawStr) as WsMessage;
        } catch {
          return;
        }

        this._handleMessage(msg, resolve, timeout);
      });

      ws.on('error', (err: Error) => {
        this._log.error('WebSocket error:', err.message);
        clearTimeout(timeout);
        if (this._everConnected && !this._disconnectedAt) {
          this._disconnectedAt = Date.now();
          this.emit('disconnect', { reason: err.message });
        }
        if (!this.connected) {
          reject(err);
        }
        this._cleanup();
        this._scheduleReconnect();
      });

      ws.on('close', (code: number, reason: Buffer) => {
        const reasonStr = reason.length > 0 ? reason.toString() : `code ${String(code)}`;
        if (this.connected) {
          this._log.info(`WebSocket closed: ${reasonStr}`);
          if (this._everConnected && !this._disconnectedAt) {
            this._disconnectedAt = Date.now();
            this.emit('disconnect', { reason: reasonStr });
          }
          this._cleanup();
          this._scheduleReconnect();
        }
      });
    });
  }

  /**
   * Handle incoming WebSocket messages from the Pterodactyl daemon.
   */
  _handleMessage(msg: WsMessage, connectResolve: () => void, connectTimeout: ReturnType<typeof setTimeout>): void {
    const { event, args } = msg;

    switch (event) {
      case 'auth success':
        this.connected = true;
        this.authenticated = true;
        this._log.info('WebSocket authenticated');
        if (this._everConnected) {
          const downtime = this._disconnectedAt ? Date.now() - this._disconnectedAt : null;
          this.emit('reconnect', { downtime });
        }
        this._everConnected = true;
        this._disconnectedAt = null;
        clearTimeout(connectTimeout);
        connectResolve();
        break;

      case 'token expiring':
        // JWT about to expire — refresh it
        this._refreshToken().catch(() => {
          /* handled inside */
        });
        break;

      case 'token expired':
        // JWT expired — force reconnect
        this._log.warn('Token expired, reconnecting...');
        this._cleanup();
        this._scheduleReconnect();
        break;

      case 'console output':
      case 'install output': {
        const line = (args && args[0]) ?? '';
        this.emit('output', line);

        // Feed to any waiting command callback
        if (this._outputCallback) {
          this._outputCallback(line);
        }
        break;
      }

      case 'status':
        // Server status change (e.g., 'running', 'starting', 'stopping', 'offline')
        if (args?.[0]) {
          this.emit('status', args[0]);
        }
        break;

      case 'stats':
        // Resource stats (CPU, RAM, etc.)
        if (args?.[0]) {
          try {
            this.emit('stats', JSON.parse(args[0]));
          } catch {
            /* ignore parse errors */
          }
        }
        break;

      // Daemon messages we don't need to act on
      case 'daemon message':
      case 'install started':
      case 'install completed':
      case 'backup completed':
      case 'backup restore completed':
      case 'transfer logs':
      case 'transfer status':
        break;

      default:
        // Unknown event — log for debugging
        if (event) {
          this._log.info(`Unhandled WS event: ${event}`);
        }
        break;
    }
  }

  /**
   * Refresh the JWT token without dropping the WebSocket connection.
   */
  async _refreshToken(): Promise<void> {
    try {
      const panelApi = this._panelApi;
      if (!panelApi) return;
      const auth = await panelApi.getWebsocketAuth();
      if (auth.token && this._ws && this._ws.readyState === this._WebSocket.OPEN) {
        this._token = auth.token;
        this._ws.send(
          JSON.stringify({
            event: 'auth',
            args: [this._token],
          }),
        );
        this._log.info('Token refreshed');
      }
    } catch (err: unknown) {
      this._log.warn('Token refresh failed:', err instanceof Error ? err.message : String(err));
    }
  }

  // ── Command interface (matches RconManager) ─────────────────

  /**
   * Send a command and wait for the response.
   * Commands are queued sequentially — only one at a time.
   * @param command - Game command to send (e.g. 'info', 'Players')
   * @returns Command output
   */
  async send(command: string): Promise<string> {
    return new Promise((resolve, reject) => {
      this._commandQueue = this._commandQueue
        .then(async () => {
          try {
            if (!this.connected || !this.authenticated) {
              await this.connect();
            }

            const result = await this._sendCommand(command);
            resolve(result);
          } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        })
        .catch(() => {
          /* Prevent unhandled rejection on queue chain — caller gets the error via reject() */
        });
    });
  }

  /**
   * Internal: send command via WebSocket and collect output lines.
   *
   * The Pterodactyl WebSocket console is a stream — there's no request/response
   * correlation.  We send the command, then collect output lines until we see a
   * "quiet period" (no new output for 1.5s), similar to how the TCP RconManager
   * collects multi-packet responses.
   *
   * Output processing:
   *   - The game echoes the sent command as the first line — we skip it.
   *   - Response lines are prefixed with `[RCON]: ` — we strip that prefix.
   */
  _sendCommand(command: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const ws = this._ws;
      if (!ws || ws.readyState !== this._WebSocket.OPEN) {
        reject(new Error('WebSocket not connected'));
        return;
      }

      const responseLines: string[] = [];
      let resolved = false;
      let dataTimer: ReturnType<typeof setTimeout> | null = null;
      let seenEcho = false;

      // Hard timeout — if nothing comes back at all
      const hardTimeout = setTimeout(() => {
        this._outputCallback = null;
        if (!resolved) {
          resolved = true;
          // Return whatever we have (may be empty for fire-and-forget commands)
          resolve(responseLines.join('\n'));
        }
      }, 10000);

      // Collect output lines
      this._outputCallback = (line) => {
        // Strip the ANSI escape codes and Pterodactyl formatting
        let clean = stripAnsi(line);

        // Skip empty lines and pure whitespace
        if (!clean.trim()) return;

        // The game echoes the sent command as the first line — skip it
        if (!seenEcho && clean.trim() === command.trim()) {
          seenEcho = true;
          return;
        }

        // Strip the [RCON]: prefix that the game adds to all output
        const rconPrefix = /^\[RCON\]:\s*/;
        if (rconPrefix.test(clean)) {
          clean = clean.replace(rconPrefix, '');
        }

        responseLines.push(clean);

        // Reset the quiet timer — wait for more output
        if (dataTimer) clearTimeout(dataTimer);
        dataTimer = setTimeout(() => {
          clearTimeout(hardTimeout);
          this._outputCallback = null;
          if (!resolved) {
            resolved = true;
            resolve(responseLines.join('\n'));
          }
        }, this._silenceMs); // quiet period (default 1.5s, slightly longer than TCP RCON's 1s
        // because WebSocket has more latency + daemon buffering)
      };

      // Send the command
      try {
        ws.send(
          JSON.stringify({
            event: 'send command',
            args: [command],
          }),
        );
      } catch (err) {
        clearTimeout(hardTimeout);
        // dataTimer cannot be set yet — ws.send is synchronous
        this._outputCallback = null;
        this.connected = false;
        this.authenticated = false;
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * Send a command with response caching.
   * @param command
   * @param ttl - Cache TTL in ms
   * @returns
   */
  async sendCached(command: string, ttl: number | null = null): Promise<string> {
    const effectiveTtl = ttl ?? this._cacheTtl ?? 30000;
    const cached = this.cache.get(command);
    if (cached && Date.now() - cached.timestamp < effectiveTtl) {
      return cached.data;
    }

    // Evict stale entries
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
    if (this._reconnectTimeout) {
      clearTimeout(this._reconnectTimeout);
      this._reconnectTimeout = null;
    }
    this._cleanup();
  }

  // ── Private helpers ─────────────────────────────────────────

  _cleanup(): void {
    this.connected = false;
    this.authenticated = false;
    this._commandQueue = Promise.resolve();
    this._outputCallback = null;
    this._outputBuffer = [];

    if (this._tokenRefreshTimer) {
      clearTimeout(this._tokenRefreshTimer);
      this._tokenRefreshTimer = null;
    }

    if (this._ws) {
      try {
        this._ws.terminate();
      } catch (_) {
        /* ignore */
      }
      this._ws = null;
    }
  }

  _scheduleReconnect(): void {
    if (this._reconnectTimeout) return;
    this._log.info('Reconnecting in 15 seconds...');
    this._reconnectTimeout = setTimeout(() => {
      this._reconnectTimeout = null;
      this.connect().catch((err: unknown) => {
        this._log.error('Reconnect failed:', err instanceof Error ? err.message : String(err));
      });
    }, 15000);
  }
}

/**
 * Strip ANSI escape codes from a string.
 * Pterodactyl daemon wraps some output in ANSI color codes.
 */
function stripAnsi(str: string): string {
  return str.replace(new RegExp(String.fromCharCode(0x1b) + '\\[[0-9;]*[a-zA-Z]', 'g'), '').replace(/\r/g, '');
}

export { PanelRcon };

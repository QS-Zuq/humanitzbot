/**
 * Pterodactyl Panel API client.
 *
 * Optional module — only active when PANEL_SERVER_URL + PANEL_API_KEY are set.
 * Works with any Pterodactyl-based host (BisectHosting, Bloom.host, etc.).
 *
 * Provides:
 *   - Server resources (CPU, RAM, disk, uptime, state)
 *   - Power management (start, stop, restart, kill)
 *   - Console commands (fire-and-forget)
 *   - Backup management (list, create, delete, download URL)
 *   - File access (read, write, list)
 *   - Server details (name, limits, allocations)
 *
 * Exports a singleton instance, the PanelApi class, a createPanelApi() factory,
 * and bound wrappers for all methods (for destructured imports).
 * Methods throw when panel is not configured; use the `available` getter to check first.
 */

const config = require('../config');

// ── URL parsing ─────────────────────────────────────────────
// PANEL_SERVER_URL is the full browser URL, e.g.:
//   https://games.bisecthosting.com/server/a1b2c3d4
// We extract the API base URL and server identifier from it.

/**
 * Parse a Pterodactyl panel URL into base URL and server identifier.
 * @param {string} rawUrl - Full panel URL (e.g. https://games.bisecthosting.com/server/a1b2c3d4)
 * @returns {{ baseUrl: string, serverId: string } | null}
 */
function _parseUrl(rawUrl) {
  const raw = (rawUrl || '').replace(/\/+$/, '');
  if (!raw) return null;

  // Require http(s):// scheme and /server/{serverId} at the end
  const match = raw.match(/^(https?:\/\/.+)\/server\/([a-zA-Z0-9]+)$/);
  if (!match) return null;

  return { baseUrl: match[1], serverId: match[2] };
}

/** Map raw Pterodactyl allocation to a clean shape. */
function _mapAllocation(raw) {
  const a = raw.attributes || raw;
  return {
    id: a.id,
    ip: a.ip || '',
    ip_alias: a.ip_alias || null,
    port: a.port || 0,
    is_default: a.is_default ?? false,
  };
}
// ── PanelApi class ──────────────────────────────────────────

class PanelApi {
  constructor(opts) {
    if (opts && opts.serverUrl && opts.apiKey) {
      // Configured mode: opts provided (e.g. via createPanelApi()), parse URL and set credentials immediately
      const parsed = _parseUrl(opts.serverUrl);
      if (!parsed) throw new Error('Invalid panel server URL');
      this._baseUrl = parsed.baseUrl;
      this._serverId = parsed.serverId;
      this._apiKey = opts.apiKey;
      this._available = true;
    } else {
      // Unconfigured mode: lazy-parse from config on first use
      this._baseUrl = null;
      this._serverId = null;
      this._apiKey = null;
      this._available = null;
    }
  }

  /** Whether the panel API is configured and the module can be used. */
  get available() {
    if (this._available === null) {
      this._ensureParsed();
      this._available = !!(this._baseUrl && this._serverId && this._apiKey);
    }
    return this._available;
  }

  /** @returns {'pterodactyl'|null} */
  get backend() {
    return this.available ? 'pterodactyl' : null;
  }

  /**
   * Lazy-parse URL and credentials from config.
   * No-op when _baseUrl is already set (i.e. constructed with opts, or already called).
   */
  _ensureParsed() {
    if (this._baseUrl !== null) return; // already parsed
    const parsed = _parseUrl(config.panelServerUrl);
    if (!parsed) return;
    this._baseUrl = parsed.baseUrl;
    this._serverId = parsed.serverId;
    this._apiKey = config.panelApiKey;
  }

  /**
   * Make an authenticated request to the Pterodactyl client API.
   * @param {string} endpoint - Path after /api/client/servers/{id}/ (or absolute if starting with /)
   * @param {object} [options] - fetch options override
   * @returns {Promise<object|null>} Parsed JSON body, or null for 204/empty responses
   */
  async _request(endpoint, options = {}) {
    this._ensureParsed();
    if (!this._baseUrl || !this._serverId || !this._apiKey) {
      throw new Error('Panel API not configured (PANEL_SERVER_URL + PANEL_API_KEY required)');
    }

    const path = endpoint.startsWith('/') ? endpoint : `/api/client/servers/${this._serverId}/${endpoint}`;

    const url = `${this._baseUrl}${path}`;

    const res = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${this._apiKey}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Panel API ${res.status} ${res.statusText}: ${body.substring(0, 200)}`);
    }

    // 204 No Content (e.g. power, command)
    if (res.status === 204) return null;

    const text = await res.text();
    if (!text) return null;
    return JSON.parse(text);
  }
}

// ── API methods ─────────────────────────────────────────────

Object.assign(PanelApi.prototype, {
  // ── Resource monitoring ─────────────────────────────────────

  /**
   * Get current server resource usage + power state.
   * @returns {Promise<{cpu: number, memUsed: number, memTotal: number, memPercent: number,
   *           diskUsed: number, diskTotal: number, diskPercent: number, uptime: number,
   *           state: string}>}
   */
  async getResources() {
    const data = await this._request('resources');
    const attrs = data?.attributes || data || {};
    const r = attrs.resources || attrs;

    return {
      cpu: r.cpu_absolute != null ? Math.round(r.cpu_absolute * 10) / 10 : null,
      memUsed: r.memory_bytes ?? null,
      memTotal: r.memory_limit_bytes ?? null,
      memPercent:
        r.memory_bytes != null && r.memory_limit_bytes > 0
          ? Math.round((r.memory_bytes / r.memory_limit_bytes) * 1000) / 10
          : null,
      diskUsed: r.disk_bytes ?? null,
      diskTotal: r.disk_limit_bytes ?? null,
      diskPercent:
        r.disk_bytes != null && r.disk_limit_bytes > 0
          ? Math.round((r.disk_bytes / r.disk_limit_bytes) * 1000) / 10
          : null,
      uptime: r.uptime != null ? Math.floor(r.uptime / 1000) : null, // ms → s
      state: attrs.current_state || null, // running, starting, stopping, offline
    };
  },

  // ── Power management ────────────────────────────────────────

  /**
   * Send a power signal to the server.
   * @param {'start'|'stop'|'restart'|'kill'} signal
   */
  async sendPowerAction(signal) {
    const valid = ['start', 'stop', 'restart', 'kill'];
    if (!valid.includes(signal)) throw new Error(`Invalid power signal: ${signal}`);
    await this._request('power', {
      method: 'POST',
      body: JSON.stringify({ signal }),
    });
  },

  // ── Console command ─────────────────────────────────────────

  /**
   * Send a console command via the panel API. Fire-and-forget — no response body.
   * For commands that need a response, use RCON instead.
   * @param {string} command
   */
  async sendCommand(command) {
    await this._request('command', {
      method: 'POST',
      body: JSON.stringify({ command }),
    });
  },

  // ── Server details ──────────────────────────────────────────

  /**
   * Get server details (name, description, limits, allocations, etc.)
   * @returns {Promise<object>}
   */
  async getServerDetails() {
    const data = await this._request(`/api/client/servers/${this._serverId}`);
    return data?.attributes || data || {};
  },

  // ── Backups ─────────────────────────────────────────────────

  /**
   * List all backups for this server.
   * @returns {Promise<Array<{uuid: string, name: string, bytes: number, created_at: string,
   *           completed_at: string, is_successful: boolean, is_locked: boolean}>>}
   */
  async listBackups() {
    const data = await this._request('backups');
    const items = data?.data || [];
    return items.map((b) => {
      const a = b.attributes || b;
      return {
        uuid: a.uuid,
        name: a.name,
        bytes: a.bytes || 0,
        created_at: a.created_at,
        completed_at: a.completed_at,
        is_successful: a.is_successful ?? true,
        is_locked: a.is_locked ?? false,
      };
    });
  },

  /**
   * Create a new backup.
   * @param {string} [name] - Backup name (auto-generated if empty)
   * @returns {Promise<object>} Created backup attributes
   */
  async createBackup(name) {
    const data = await this._request('backups', {
      method: 'POST',
      body: JSON.stringify({ name: name || '' }),
    });
    return data?.attributes || data || {};
  },

  /**
   * Delete a backup by UUID.
   * @param {string} uuid
   */
  async deleteBackup(uuid) {
    await this._request(`backups/${uuid}`, { method: 'DELETE' });
  },

  /**
   * Get the download URL for a backup.
   * @param {string} uuid
   * @returns {Promise<string>} Signed download URL
   */
  async getBackupDownloadUrl(uuid) {
    const data = await this._request(`backups/${uuid}/download`);
    return data?.attributes?.url || null;
  },

  // ── File management ─────────────────────────────────────────

  /**
   * List files in a directory.
   * @param {string} [dir='/'] - Directory path
   * @returns {Promise<Array<{name: string, mode: string, size: number, is_file: boolean, modified_at: string}>>}
   */
  async listFiles(dir = '/') {
    const data = await this._request(`files/list?directory=${encodeURIComponent(dir)}`);
    const items = data?.data || [];
    return items.map((f) => {
      const a = f.attributes || f;
      return {
        name: a.name,
        mode: a.mode,
        size: a.size || 0,
        is_file: a.is_file ?? true,
        modified_at: a.modified_at,
      };
    });
  },

  /**
   * Read the contents of a file.
   * @param {string} filePath - Absolute path on the server (e.g. /HumanitZServer/GameServerSettings.ini)
   * @returns {Promise<string>} File contents as text
   */
  async readFile(filePath) {
    this._ensureParsed();
    if (!this._baseUrl || !this._serverId || !this._apiKey) {
      throw new Error('Panel API not configured');
    }

    // Try files/contents first (fast, text-based)
    const url = `${this._baseUrl}/api/client/servers/${this._serverId}/files/contents?file=${encodeURIComponent(filePath)}`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this._apiKey}`,
        Accept: 'text/plain',
      },
    });

    if (res.ok) return res.text();

    // Some hosts disable files/contents (405) — fall back to signed download URL
    if (res.status === 405 || res.status === 403) {
      const buf = await this.downloadFile(filePath);
      return buf.toString('utf-8');
    }

    throw new Error(`Panel file read ${res.status}: ${res.statusText}`);
  },

  /**
   * Write content to a file on the server.
   * @param {string} filePath - Absolute path on the server
   * @param {string} content - File contents to write
   */
  async writeFile(filePath, content) {
    this._ensureParsed();
    if (!this._baseUrl || !this._serverId || !this._apiKey) {
      throw new Error('Panel API not configured');
    }

    const url = `${this._baseUrl}/api/client/servers/${this._serverId}/files/write?file=${encodeURIComponent(filePath)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this._apiKey}`,
        'Content-Type': 'text/plain',
      },
      body: content,
    });

    if (!res.ok) {
      throw new Error(`Panel file write ${res.status}: ${res.statusText}`);
    }
  },

  // ── File download ───────────────────────────────────────────

  /**
   * Get a signed download URL for a file.
   * The URL is temporary and can be used with a simple HTTP GET (no auth header needed).
   * @param {string} filePath - Absolute path on the server (e.g. /HumanitZServer/Saved/SaveGames/SaveList/Default/Save_DedicatedSaveMP.sav)
   * @returns {Promise<string>} Signed download URL
   */
  async getFileDownloadUrl(filePath) {
    const data = await this._request(`files/download?file=${encodeURIComponent(filePath)}`);
    return data?.attributes?.url || null;
  },

  /**
   * Download a file as a Buffer.
   * Uses the Panel API to get a signed URL, then fetches the file content.
   * Ideal for binary files like save files where readFile() (text-based) won't work.
   * @param {string} filePath - Absolute path on the server
   * @returns {Promise<Buffer>} File contents as a Buffer
   */
  async downloadFile(filePath) {
    const url = await this.getFileDownloadUrl(filePath);
    if (!url) throw new Error(`No download URL returned for: ${filePath}`);

    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`File download failed ${res.status}: ${res.statusText}`);
    }

    const arrayBuf = await res.arrayBuffer();
    return Buffer.from(arrayBuf);
  },

  // ── WebSocket auth ──────────────────────────────────────────

  /**
   * Get WebSocket credentials for real-time console/stats.
   * @returns {Promise<{token: string, socket: string}>}
   */
  async getWebsocketAuth() {
    const data = await this._request('websocket');
    return data?.data || {};
  },

  // ── Schedules ───────────────────────────────────────────────

  /**
   * List all schedules for this server.
   * @returns {Promise<Array>}
   */
  async listSchedules() {
    const data = await this._request('schedules');
    const items = data?.data || [];
    return items.map((s) => s.attributes || s);
  },

  /**
   * Create a new schedule.
   * @param {object} params - { name, minute, hour, day_of_week, day_of_month, month, is_active, only_when_online }
   * @returns {Promise<object>} Created schedule
   */
  async createSchedule(params) {
    const data = await this._request('schedules', {
      method: 'POST',
      body: JSON.stringify(params),
    });
    return data?.attributes || data || {};
  },

  /**
   * Delete a schedule by ID.
   * @param {number} scheduleId
   */
  async deleteSchedule(scheduleId) {
    await this._request(`schedules/${scheduleId}`, { method: 'DELETE' });
  },

  // ── Network allocations ─────────────────────────────────────

  /**
   * List all network allocations for this server.
   * Returns IPs and ports assigned to the server (primary + additional).
   * @returns {Promise<Array<{id: number, ip: string, ip_alias: string|null, port: number, is_default: boolean}>>}
   */
  async listAllocations() {
    const data = await this._request('network/allocations');
    const items = data?.data || [];
    return items.map(_mapAllocation);
  },

  // ── List all servers ────────────────────────────────────────

  /**
   * List all servers accessible with this API key.
   * Uses the /api/client endpoint (no server ID needed).
   * Useful for auto-discovery — find game server + bot server from a single API key.
   * @returns {Promise<Array<{identifier: string, uuid: string, name: string, description: string, node: string,
   *           sftp_details: {ip: string, port: number}, allocations: Array}>>}
   */
  async listServers() {
    this._ensureParsed();
    if (!this._baseUrl || !this._apiKey) {
      throw new Error('Panel API not configured (PANEL_SERVER_URL + PANEL_API_KEY required)');
    }

    const allServers = [];
    let page = 1;
    let totalPages = 1;

    while (page <= totalPages) {
      const url = `${this._baseUrl}/api/client?page=${page}`;
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${this._apiKey}`,
          Accept: 'application/json',
        },
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Panel API ${res.status} ${res.statusText}: ${body.substring(0, 200)}`);
      }
      const data = await res.json();
      const items = data?.data || [];
      for (const item of items) {
        const a = item.attributes || item;
        allServers.push({
          identifier: a.identifier || '',
          uuid: a.uuid || '',
          name: a.name || '',
          description: a.description || '',
          node: a.node || '',
          sftp_details: a.sftp_details || {},
          allocations: (a.relationships?.allocations?.data || []).map(_mapAllocation),
          egg: a.egg || 0,
          docker_image: a.docker_image || '',
          limits: a.limits || {},
        });
      }
      totalPages = data?.meta?.pagination?.total_pages || 1;
      page++;
    }

    return allServers;
  },

  // ── Startup variables ───────────────────────────────────────

  /**
   * List all startup variables for this server.
   * Pterodactyl returns env vars like SERVER_NAME, MAX_PLAYERS, RCON_PASSWORD, etc.
   * @returns {Promise<Array<{env_variable: string, server_value: string, default_value: string, name: string, description: string}>>}
   */
  async getStartupVariables() {
    const data = await this._request('startup');
    const items = data?.data || [];
    return items.map((v) => {
      const a = v.attributes || v;
      return {
        env_variable: a.env_variable,
        server_value: a.server_value ?? a.default_value ?? '',
        default_value: a.default_value ?? '',
        name: a.name || a.env_variable || '',
        description: a.description || '',
      };
    });
  },

  /**
   * Update a startup variable (e.g. SERVER_NAME, MAX_PLAYERS).
   * Bisect/Pterodactyl passes these as command-line args, overriding INI values.
   * @param {string} key - Environment variable name (e.g. 'SERVER_NAME')
   * @param {string} value - New value
   * @returns {Promise<object>} Updated variable attributes
   */
  async updateStartupVariable(key, value) {
    const data = await this._request('startup/variable', {
      method: 'PUT',
      body: JSON.stringify({ key, value }),
    });
    return data?.attributes || data || {};
  },
});

// ── Per-server instance factory ─────────────────────────────

/**
 * Create a standalone PanelApi instance for a specific server.
 * Used by multi-server to give each managed server its own panel credentials.
 *
 * Unlike the singleton (which lazy-reads from the global config singleton on first use),
 * this creates a fully isolated instance with its own URL, server ID, and API key.
 *
 * @param {object} options
 * @param {string} options.serverUrl - Full panel URL (e.g. https://games.bisecthosting.com/server/a1b2c3d4)
 * @param {string} options.apiKey    - Panel API key
 * @returns {PanelApi|null} Standalone instance, or null if inputs are missing/invalid
 */
function createPanelApi({ serverUrl, apiKey } = {}) {
  if (!serverUrl || !apiKey) return null;
  try {
    return new PanelApi({ serverUrl, apiKey });
  } catch {
    return null;
  }
}

// ── Exports ─────────────────────────────────────────────────

const instance = new PanelApi();

module.exports = instance;
module.exports.PanelApi = PanelApi;
module.exports.createPanelApi = createPanelApi;
// Individual function exports as bound wrappers for destructured use
const _BOUND_METHODS = [
  'getResources',
  'sendPowerAction',
  'sendCommand',
  'getServerDetails',
  'listBackups',
  'createBackup',
  'deleteBackup',
  'getBackupDownloadUrl',
  'getFileDownloadUrl',
  'downloadFile',
  'listFiles',
  'readFile',
  'writeFile',
  'getWebsocketAuth',
  'listSchedules',
  'createSchedule',
  'deleteSchedule',
  'getStartupVariables',
  'updateStartupVariable',
  'listAllocations',
  'listServers',
];
for (const method of _BOUND_METHODS) {
  if (typeof instance[method] !== 'function') {
    throw new Error(`PanelApi: _BOUND_METHODS contains unknown method '${method}'`);
  }
  module.exports[method] = instance[method].bind(instance);
}

// ── Test escape hatch ───────────────────────────────────────
module.exports._test = { _parseUrl };

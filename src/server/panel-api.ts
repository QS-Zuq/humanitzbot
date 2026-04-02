/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment,
   @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return,
   @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call,
   @typescript-eslint/no-unnecessary-condition */
/**
 * Pterodactyl Panel API client.
 *
 * Optional module — only active when PANEL_SERVER_URL + PANEL_API_KEY are set.
 * Works with any Pterodactyl-based host (BisectHosting, Bloom.host, etc.).
 */

import _defaultConfig from '../config/index.js';

// ── URL parsing ─────────────────────────────────────────────

function _parseUrl(rawUrl: string | undefined): { baseUrl: string; serverId: string } | null {
  const raw = (rawUrl || '').replace(/\/+$/, '');
  if (!raw) return null;
  const match = raw.match(/^(https?:\/\/.+)\/server\/([a-zA-Z0-9]+)$/);
  if (!match) return null;
  return { baseUrl: match[1] as string, serverId: match[2] as string };
}

function _mapAllocation(raw: any): {
  id: number;
  ip: string;
  ip_alias: string | null;
  port: number;
  is_default: boolean;
} {
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
  _baseUrl: string | null;
  _serverId: string | null;
  _apiKey: string | null;
  _available: boolean | null;

  constructor(opts?: { serverUrl?: string; apiKey?: string }) {
    if (opts && opts.serverUrl && opts.apiKey) {
      const parsed = _parseUrl(opts.serverUrl);
      if (!parsed) throw new Error('Invalid panel server URL');
      this._baseUrl = parsed.baseUrl;
      this._serverId = parsed.serverId;
      this._apiKey = opts.apiKey;
      this._available = true;
    } else {
      this._baseUrl = null;
      this._serverId = null;
      this._apiKey = null;
      this._available = null;
    }
  }

  get available(): boolean {
    if (this._available === null) {
      this._ensureParsed();
      this._available = !!(this._baseUrl && this._serverId && this._apiKey);
    }
    return this._available;
  }

  get backend(): 'pterodactyl' | null {
    return this.available ? 'pterodactyl' : null;
  }

  _ensureParsed(): void {
    if (this._baseUrl !== null) return;
    const parsed = _parseUrl((_defaultConfig as any).panelServerUrl);
    if (!parsed) return;
    this._baseUrl = parsed.baseUrl;
    this._serverId = parsed.serverId;
    this._apiKey = (_defaultConfig as any).panelApiKey;
  }

  async _request(endpoint: string, options: RequestInit = {}): Promise<any> {
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
        ...(options.headers as Record<string, string> | undefined),
      },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Panel API ${String(res.status)} ${res.statusText}: ${body.substring(0, 200)}`);
    }

    if (res.status === 204) return null;

    const text = await res.text();
    if (!text) return null;
    return JSON.parse(text);
  }
}

// ── API methods ─────────────────────────────────────────────

Object.assign(PanelApi.prototype, {
  async getResources(this: PanelApi) {
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
      uptime: r.uptime != null ? Math.floor(r.uptime / 1000) : null,
      state: attrs.current_state || null,
    };
  },

  async sendPowerAction(this: PanelApi, signal: string) {
    const valid = ['start', 'stop', 'restart', 'kill'];
    if (!valid.includes(signal)) throw new Error(`Invalid power signal: ${signal}`);
    await this._request('power', {
      method: 'POST',
      body: JSON.stringify({ signal }),
    });
  },

  async sendCommand(this: PanelApi, command: string) {
    await this._request('command', {
      method: 'POST',
      body: JSON.stringify({ command }),
    });
  },

  async getServerDetails(this: PanelApi) {
    const data = await this._request(`/api/client/servers/${this._serverId as string}`);
    return data?.attributes || data || {};
  },

  async listBackups(this: PanelApi) {
    const data = await this._request('backups');
    const items = data?.data || [];
    return items.map((b: any) => {
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

  async createBackup(this: PanelApi, name?: string) {
    const data = await this._request('backups', {
      method: 'POST',
      body: JSON.stringify({ name: name || '' }),
    });
    return data?.attributes || data || {};
  },

  async deleteBackup(this: PanelApi, uuid: string) {
    await this._request(`backups/${uuid}`, { method: 'DELETE' });
  },

  async getBackupDownloadUrl(this: PanelApi, uuid: string) {
    const data = await this._request(`backups/${uuid}/download`);
    return data?.attributes?.url || null;
  },

  async listFiles(this: PanelApi, dir = '/') {
    const data = await this._request(`files/list?directory=${encodeURIComponent(dir)}`);
    const items = data?.data || [];
    return items.map((f: any) => {
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

  async readFile(this: PanelApi, filePath: string) {
    this._ensureParsed();
    if (!this._baseUrl || !this._serverId || !this._apiKey) {
      throw new Error('Panel API not configured');
    }

    const url = `${this._baseUrl}/api/client/servers/${this._serverId}/files/contents?file=${encodeURIComponent(filePath)}`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this._apiKey}`,
        Accept: 'text/plain',
      },
    });

    if (res.ok) return res.text();

    if (res.status === 405 || res.status === 403) {
      const buf: Buffer = await (this as any).downloadFile(filePath);
      return buf.toString('utf-8');
    }

    throw new Error(`Panel file read ${String(res.status)}: ${res.statusText}`);
  },

  async writeFile(this: PanelApi, filePath: string, content: string) {
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
      throw new Error(`Panel file write ${String(res.status)}: ${res.statusText}`);
    }
  },

  async getFileDownloadUrl(this: PanelApi, filePath: string) {
    const data = await this._request(`files/download?file=${encodeURIComponent(filePath)}`);
    return data?.attributes?.url || null;
  },

  async downloadFile(this: PanelApi, filePath: string) {
    const url = await (this as any).getFileDownloadUrl(filePath);
    if (!url) throw new Error(`No download URL returned for: ${filePath}`);

    const res = await fetch(url as string);
    if (!res.ok) {
      throw new Error(`File download failed ${String(res.status)}: ${res.statusText}`);
    }

    const arrayBuf = await res.arrayBuffer();
    return Buffer.from(arrayBuf);
  },

  async getWebsocketAuth(this: PanelApi) {
    const data = await this._request('websocket');
    return data?.data || {};
  },

  async listSchedules(this: PanelApi) {
    const data = await this._request('schedules');
    const items = data?.data || [];
    return items.map((s: any) => s.attributes || s);
  },

  async createSchedule(this: PanelApi, params: Record<string, unknown>) {
    const data = await this._request('schedules', {
      method: 'POST',
      body: JSON.stringify(params),
    });
    return data?.attributes || data || {};
  },

  async deleteSchedule(this: PanelApi, scheduleId: number) {
    await this._request(`schedules/${String(scheduleId)}`, { method: 'DELETE' });
  },

  async listAllocations(this: PanelApi) {
    const data = await this._request('network/allocations');
    const items = data?.data || [];
    return items.map(_mapAllocation);
  },

  async listServers(this: PanelApi) {
    this._ensureParsed();
    if (!this._baseUrl || !this._apiKey) {
      throw new Error('Panel API not configured (PANEL_SERVER_URL + PANEL_API_KEY required)');
    }

    const allServers: any[] = [];
    let page = 1;
    let totalPages = 1;

    while (page <= totalPages) {
      const url = `${this._baseUrl}/api/client?page=${String(page)}`;
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${this._apiKey}`,
          Accept: 'application/json',
        },
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Panel API ${String(res.status)} ${res.statusText}: ${body.substring(0, 200)}`);
      }
      const data = await res.json();
      const items = (data as any)?.data || [];
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
      totalPages = (data as any)?.meta?.pagination?.total_pages || 1;
      page++;
    }

    return allServers;
  },

  async getStartupVariables(this: PanelApi) {
    const data = await this._request('startup');
    const items = data?.data || [];
    return items.map((v: any) => {
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

  async updateStartupVariable(this: PanelApi, key: string, value: string) {
    const data = await this._request('startup/variable', {
      method: 'PUT',
      body: JSON.stringify({ key, value }),
    });
    return data?.attributes || data || {};
  },
});

// ── Per-server instance factory ─────────────────────────────

function createPanelApi(opts?: { serverUrl?: string; apiKey?: string }): PanelApi | null {
  if (!opts?.serverUrl || !opts?.apiKey) return null;
  try {
    return new PanelApi({ serverUrl: opts.serverUrl, apiKey: opts.apiKey });
  } catch {
    return null;
  }
}

// ── Exports ─────────────────────────────────────────────────

const instance = new PanelApi();
export default instance;

export { PanelApi, createPanelApi };

const _mod = module as { exports: any };
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
_mod.exports = instance;
_mod.exports.PanelApi = PanelApi;
_mod.exports.createPanelApi = createPanelApi;
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
  if (typeof (instance as any)[method] !== 'function') {
    throw new Error(`PanelApi: _BOUND_METHODS contains unknown method '${method}'`);
  }
  _mod.exports[method] = ((instance as any)[method] as (...args: any[]) => any).bind(instance);
}

// ── Test escape hatch ───────────────────────────────────────
_mod.exports._test = { _parseUrl };
/* eslint-enable @typescript-eslint/no-unsafe-member-access */

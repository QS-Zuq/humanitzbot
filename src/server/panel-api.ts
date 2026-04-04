/**
 * Pterodactyl Panel API client.
 *
 * Optional module — only active when PANEL_SERVER_URL + PANEL_API_KEY are set.
 * Works with any Pterodactyl-based host (BisectHosting, Bloom.host, etc.).
 */

import _defaultConfig from '../config/index.js';

// Pterodactyl API responses are external JSON — typed via helper and narrowed per-method

/** Shorthand: cast parsed JSON to a record for safe property access. */
type ApiRecord = Record<string, unknown>;

function _rec(val: unknown): ApiRecord {
  if (val && typeof val === 'object') return val as ApiRecord;
  return {};
}

function _num(val: unknown): number {
  return typeof val === 'number' ? val : 0;
}

function _str(val: unknown): string {
  return typeof val === 'string' ? val : '';
}

// ── URL parsing ─────────────────────────────────────────────

function _parseUrl(rawUrl: string | undefined): { baseUrl: string; serverId: string } | null {
  const raw = (rawUrl || '').replace(/\/+$/, '');
  if (!raw) return null;
  const match = raw.match(/^(https?:\/\/.+)\/server\/([a-zA-Z0-9]+)$/);
  if (!match) return null;
  return { baseUrl: match[1] as string, serverId: match[2] as string };
}

interface AllocationInfo {
  id: number;
  ip: string;
  ip_alias: string | null;
  port: number;
  is_default: boolean;
}

function _mapAllocation(raw: unknown): AllocationInfo {
  const obj = _rec(raw);
  const a = _rec(obj['attributes'] ?? raw);
  return {
    id: _num(a['id']),
    ip: _str(a['ip']),
    ip_alias: typeof a['ip_alias'] === 'string' ? a['ip_alias'] : null,
    port: _num(a['port']),
    is_default: (a['is_default'] as boolean | undefined) ?? false,
  };
}

export interface PanelResourceResult {
  cpu: number | null;
  memUsed: number | null;
  memTotal: number | null;
  memPercent: number | null;
  diskUsed: number | null;
  diskTotal: number | null;
  diskPercent: number | null;
  uptime: number | null;
  state: string | null;
}

export interface PanelBackup {
  uuid: string;
  name: string;
  bytes: number;
  created_at: string | null;
  completed_at: string | null;
  is_successful: boolean;
  is_locked: boolean;
}

export interface PanelSchedule {
  name?: string;
  is_active?: boolean;
  only_when_online?: boolean;
  last_run_at?: string | null;
  next_run_at?: string | null;
  cron?: {
    minute?: string;
    hour?: string;
    day_of_month?: string;
    month?: string;
    day_of_week?: string;
  };
  [key: string]: unknown;
}

export interface PanelStartupVar {
  env_variable: unknown;
  server_value: unknown;
  default_value: unknown;
  name: string;
  description: string;
}

export interface PanelServerDetails {
  name?: string;
  node?: string;
  limits?: { memory?: number; disk?: number; cpu?: number };
  feature_limits?: { databases?: number; allocations?: number; backups?: number };
  [key: string]: unknown;
}

// ── PanelApi class ──────────────────────────────────────────

class PanelApi {
  _baseUrl: string | null;
  _serverId: string | null;
  _apiKey: string | null;
  _available: boolean | null;

  // Prototype-mixed methods — declared here, assigned via Object.assign below
  declare getResources: () => Promise<PanelResourceResult>;
  declare sendPowerAction: (signal: string) => Promise<void>;
  declare sendCommand: (command: string) => Promise<void>;
  declare getServerDetails: () => Promise<PanelServerDetails>;
  declare listBackups: () => Promise<PanelBackup[]>;
  declare createBackup: (name?: string) => Promise<ApiRecord>;
  declare deleteBackup: (uuid: string) => Promise<void>;
  declare getBackupDownloadUrl: (uuid: string) => Promise<string | null>;
  declare listFiles: (dir?: string) => Promise<ApiRecord[]>;
  declare readFile: (filePath: string) => Promise<string>;
  declare writeFile: (filePath: string, content: string) => Promise<void>;
  declare getFileDownloadUrl: (filePath: string) => Promise<string | null>;
  declare downloadFile: (filePath: string) => Promise<Buffer>;
  declare getWebsocketAuth: () => Promise<ApiRecord>;
  declare listSchedules: () => Promise<PanelSchedule[]>;
  declare createSchedule: (params: Record<string, unknown>) => Promise<ApiRecord>;
  declare deleteSchedule: (scheduleId: number) => Promise<void>;
  declare listAllocations: () => Promise<AllocationInfo[]>;
  declare listServers: () => Promise<ApiRecord[]>;
  declare getStartupVariables: () => Promise<PanelStartupVar[]>;
  declare updateStartupVariable: (key: string, value: string) => Promise<ApiRecord>;

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
    const cfg = _defaultConfig;
    const parsed = _parseUrl(cfg.panelServerUrl);
    if (!parsed) return;
    this._baseUrl = parsed.baseUrl;
    this._serverId = parsed.serverId;
    this._apiKey = cfg.panelApiKey;
  }

  async _request(endpoint: string, options: RequestInit = {}): Promise<unknown> {
    this._ensureParsed();
    if (!this._baseUrl || !this._serverId || !this._apiKey) {
      throw new Error('Panel API not configured (PANEL_SERVER_URL + PANEL_API_KEY required)');
    }

    const reqPath = endpoint.startsWith('/') ? endpoint : `/api/client/servers/${this._serverId}/${endpoint}`;
    const url = `${this._baseUrl}${reqPath}`;

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
    return JSON.parse(text) as unknown;
  }
}

// ── API methods ─────────────────────────────────────────────

Object.assign(PanelApi.prototype, {
  async getResources(this: PanelApi): Promise<PanelResourceResult> {
    const data = _rec(await this._request('resources'));
    const attrs = _rec(data['attributes'] ?? data);
    const r = _rec(attrs['resources'] ?? attrs);
    return {
      cpu: r['cpu_absolute'] != null ? Math.round(_num(r['cpu_absolute']) * 10) / 10 : null,
      memUsed: (r['memory_bytes'] as number | undefined) ?? null,
      memTotal: (r['memory_limit_bytes'] as number | undefined) ?? null,
      memPercent:
        r['memory_bytes'] != null && _num(r['memory_limit_bytes']) > 0
          ? Math.round((_num(r['memory_bytes']) / _num(r['memory_limit_bytes'])) * 1000) / 10
          : null,
      diskUsed: (r['disk_bytes'] as number | undefined) ?? null,
      diskTotal: (r['disk_limit_bytes'] as number | undefined) ?? null,
      diskPercent:
        r['disk_bytes'] != null && _num(r['disk_limit_bytes']) > 0
          ? Math.round((_num(r['disk_bytes']) / _num(r['disk_limit_bytes'])) * 1000) / 10
          : null,
      uptime: r['uptime'] != null ? Math.floor(_num(r['uptime']) / 1000) : null,
      state: (attrs['current_state'] as string | undefined) || null,
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

  async getServerDetails(this: PanelApi): Promise<PanelServerDetails> {
    const data = _rec(await this._request(`/api/client/servers/${this._serverId as string}`));
    return _rec(data['attributes'] ?? data) as PanelServerDetails;
  },

  async listBackups(this: PanelApi): Promise<PanelBackup[]> {
    const data = _rec(await this._request('backups'));
    const items = (data['data'] as unknown[] | undefined) ?? [];
    return items.map((b: unknown) => {
      const obj = _rec(b);
      const a = _rec(obj['attributes'] ?? b);
      return {
        uuid: _str(a['uuid']),
        name: _str(a['name']),
        bytes: _num(a['bytes']),
        created_at: (a['created_at'] as string | null) ?? null,
        completed_at: (a['completed_at'] as string | null) ?? null,
        is_successful: (a['is_successful'] as boolean | undefined) ?? true,
        is_locked: (a['is_locked'] as boolean | undefined) ?? false,
      };
    });
  },

  async createBackup(this: PanelApi, name?: string) {
    const data = _rec(
      await this._request('backups', {
        method: 'POST',
        body: JSON.stringify({ name: name || '' }),
      }),
    );
    return _rec(data['attributes'] ?? data);
  },

  async deleteBackup(this: PanelApi, uuid: string) {
    await this._request(`backups/${uuid}`, { method: 'DELETE' });
  },

  async getBackupDownloadUrl(this: PanelApi, uuid: string): Promise<string | null> {
    const data = _rec(await this._request(`backups/${uuid}/download`));
    const attrs = _rec(data['attributes']);
    return _str(attrs['url']) || null;
  },

  async listFiles(this: PanelApi, dir = '/') {
    const data = _rec(await this._request(`files/list?directory=${encodeURIComponent(dir)}`));
    const items = (data['data'] as unknown[] | undefined) ?? [];
    return items.map((f: unknown) => {
      const obj = _rec(f);
      const a = _rec(obj['attributes'] ?? f);
      return {
        name: a['name'],
        mode: a['mode'],
        size: _num(a['size']),
        is_file: (a['is_file'] as boolean | undefined) ?? true,
        modified_at: a['modified_at'],
      };
    });
  },

  async readFile(this: PanelApi, filePath: string): Promise<string> {
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
      const buf: Buffer = await this.downloadFile(filePath);
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

  async getFileDownloadUrl(this: PanelApi, filePath: string): Promise<string | null> {
    const data = _rec(await this._request(`files/download?file=${encodeURIComponent(filePath)}`));
    const attrs = _rec(data['attributes']);
    return _str(attrs['url']) || null;
  },

  async downloadFile(this: PanelApi, filePath: string): Promise<Buffer> {
    const url = await this.getFileDownloadUrl(filePath);
    if (!url) throw new Error(`No download URL returned for: ${filePath}`);

    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`File download failed ${String(res.status)}: ${res.statusText}`);
    }

    const arrayBuf = await res.arrayBuffer();
    return Buffer.from(arrayBuf);
  },

  async getWebsocketAuth(this: PanelApi) {
    const data = _rec(await this._request('websocket'));
    return _rec(data['data']);
  },

  async listSchedules(this: PanelApi): Promise<PanelSchedule[]> {
    const data = _rec(await this._request('schedules'));
    const items = (data['data'] as unknown[] | undefined) ?? [];
    return items.map((s: unknown) => {
      const obj = _rec(s);
      return _rec(obj['attributes'] ?? s) as PanelSchedule;
    });
  },

  async createSchedule(this: PanelApi, params: Record<string, unknown>) {
    const data = _rec(
      await this._request('schedules', {
        method: 'POST',
        body: JSON.stringify(params),
      }),
    );
    return _rec(data['attributes'] ?? data);
  },

  async deleteSchedule(this: PanelApi, scheduleId: number) {
    await this._request(`schedules/${String(scheduleId)}`, { method: 'DELETE' });
  },

  async listAllocations(this: PanelApi) {
    const data = _rec(await this._request('network/allocations'));
    const items = (data['data'] as unknown[] | undefined) ?? [];
    return items.map(_mapAllocation);
  },

  async listServers(this: PanelApi) {
    this._ensureParsed();
    if (!this._baseUrl || !this._apiKey) {
      throw new Error('Panel API not configured (PANEL_SERVER_URL + PANEL_API_KEY required)');
    }

    const allServers: ApiRecord[] = [];
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
      const data = _rec(await res.json());
      const items = (data['data'] as unknown[] | undefined) ?? [];
      for (const item of items) {
        const obj = _rec(item);
        const a = _rec(obj['attributes'] ?? item);
        const rels = _rec(a['relationships']);
        const allocData = _rec(rels['allocations']);
        const allocItems = (allocData['data'] as unknown[] | undefined) ?? [];
        allServers.push({
          identifier: _str(a['identifier']),
          uuid: _str(a['uuid']),
          name: _str(a['name']),
          description: _str(a['description']),
          node: _str(a['node']),
          sftp_details: a['sftp_details'] ?? {},
          allocations: allocItems.map(_mapAllocation),
          egg: _num(a['egg']),
          docker_image: _str(a['docker_image']),
          limits: a['limits'] ?? {},
        });
      }
      const meta = _rec(data['meta']);
      const pagination = _rec(meta['pagination']);
      totalPages = _num(pagination['total_pages']) || 1;
      page++;
    }

    return allServers;
  },

  async getStartupVariables(this: PanelApi): Promise<PanelStartupVar[]> {
    const data = _rec(await this._request('startup'));
    const items = (data['data'] as unknown[] | undefined) ?? [];
    return items.map((v: unknown) => {
      const obj = _rec(v);
      const a = _rec(obj['attributes'] ?? v);
      return {
        env_variable: a['env_variable'],
        server_value: a['server_value'] ?? a['default_value'] ?? '',
        default_value: a['default_value'] ?? '',
        name: _str(a['name']) || _str(a['env_variable']),
        description: _str(a['description']),
      };
    });
  },

  async updateStartupVariable(this: PanelApi, key: string, value: string) {
    const data = _rec(
      await this._request('startup/variable', {
        method: 'PUT',
        body: JSON.stringify({ key, value }),
      }),
    );
    return _rec(data['attributes'] ?? data);
  },
});

// ── Per-server instance factory ─────────────────────────────

function createPanelApi(opts?: { serverUrl?: string; apiKey?: string }): PanelApi | null {
  if (!opts?.serverUrl || !opts.apiKey) return null;
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

// ── Test escape hatch ───────────────────────────────────────
export const _test = { _parseUrl };

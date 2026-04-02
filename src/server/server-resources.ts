/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call,
   @typescript-eslint/no-explicit-any,
   @typescript-eslint/prefer-promise-reject-errors, @typescript-eslint/no-require-imports */
/**
 * Server resource monitoring — CPU, RAM, disk usage.
 *
 * Supports two backends (configured via .env):
 *   1. Pterodactyl API  — PANEL_SERVER_URL + PANEL_API_KEY (via panel-api.js)
 *   2. SSH shell         — Reuses SFTP_HOST/SFTP_PORT/SFTP_USER/SFTP_PASSWORD
 */

import _defaultConfig from '../config/index.js';
const panelApi = require('./panel-api') as import('./panel-api.js').PanelApi;

// ── Result shape ────────────────────────────────────────────

interface ResourceResult {
  cpu: number | null;
  memUsed: number | null;
  memTotal: number | null;
  memPercent: number | null;
  diskUsed: number | null;
  diskTotal: number | null;
  diskPercent: number | null;
  uptime: number | null;
  source: 'pterodactyl' | 'ssh' | null;
}

function _emptyResult(): ResourceResult {
  return {
    cpu: null,
    memUsed: null,
    memTotal: null,
    memPercent: null,
    diskUsed: null,
    diskTotal: null,
    diskPercent: null,
    uptime: null,
    source: null,
  };
}

// ── Formatting helpers ──────────────────────────────────────

function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || isNaN(bytes)) return '--';
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(2)} GB`;
}

function formatUptime(seconds: number | null | undefined): string | null {
  if (seconds == null || isNaN(seconds)) return null;
  const s = Math.floor(seconds);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const parts: string[] = [];
  if (d > 0) parts.push(`${String(d)}d`);
  if (h > 0 || d > 0) parts.push(`${String(h)}h`);
  parts.push(`${String(m)}m`);
  return parts.join(' ');
}

// ── Pterodactyl API backend ─────────────────────────────────

async function _fetchPterodactyl(): Promise<ResourceResult> {
  const result = _emptyResult();
  result.source = 'pterodactyl';
  const r: any = await (panelApi as any).getResources();
  if (r.cpu != null) result.cpu = r.cpu;
  if (r.memUsed != null) result.memUsed = r.memUsed;
  if (r.memTotal != null) result.memTotal = r.memTotal;
  if (r.memPercent != null) result.memPercent = r.memPercent;
  if (r.diskUsed != null) result.diskUsed = r.diskUsed;
  if (r.diskTotal != null) result.diskTotal = r.diskTotal;
  if (r.diskPercent != null) result.diskPercent = r.diskPercent;
  if (r.uptime != null) result.uptime = r.uptime;
  return result;
}

// ── SSH shell backend ───────────────────────────────────────

function parseSshOutput(output: string): ResourceResult {
  const result = _emptyResult();
  result.source = 'ssh';
  if (!output) return result;

  const cpuMatch = output.match(/^cpu\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/m);
  if (cpuMatch) {
    const nums = cpuMatch.slice(1).map(Number);
    const [user, nice, system, idle, iowait, irq, softirq, steal] = nums;
    const total =
      (user ?? 0) +
      (nice ?? 0) +
      (system ?? 0) +
      (idle ?? 0) +
      (iowait ?? 0) +
      (irq ?? 0) +
      (softirq ?? 0) +
      (steal ?? 0);
    const busy = total - (idle ?? 0) - (iowait ?? 0);
    if (total > 0) result.cpu = Math.round((busy / total) * 1000) / 10;
  }

  const memTotal = output.match(/MemTotal:\s+(\d+)\s+kB/);
  const memAvail = output.match(/MemAvailable:\s+(\d+)\s+kB/);
  if (memTotal?.[1]) {
    result.memTotal = parseInt(memTotal[1], 10) * 1024;
    if (memAvail?.[1]) {
      const avail = parseInt(memAvail[1], 10) * 1024;
      result.memUsed = result.memTotal - avail;
      result.memPercent = Math.round((result.memUsed / result.memTotal) * 1000) / 10;
    }
  }

  const dfLines = output.split('\n').filter((l: string) => /^\S+\s+\d/.test(l));
  const gamePath: string = (_defaultConfig as any).sftpBasePath || '/';
  let bestLine: string[] | null = null;
  let bestMountLen = 0;
  for (const line of dfLines) {
    const parts = line.trim().split(/\s+/);
    const mount = parts[5] || '/';
    if (gamePath.startsWith(mount) && mount.length > bestMountLen) {
      bestLine = parts;
      bestMountLen = mount.length;
    }
  }
  if (!bestLine && dfLines.length > 0) {
    bestLine = (dfLines[0] ?? '').trim().split(/\s+/);
  }
  if (bestLine && bestLine.length >= 4) {
    const totalKB = parseInt(bestLine[1] ?? '', 10);
    const usedKB = parseInt(bestLine[2] ?? '', 10);
    if (!isNaN(totalKB) && !isNaN(usedKB)) {
      result.diskTotal = totalKB * 1024;
      result.diskUsed = usedKB * 1024;
      result.diskPercent = result.diskTotal > 0 ? Math.round((result.diskUsed / result.diskTotal) * 1000) / 10 : null;
    }
  }

  if (output.includes('/proc/uptime') || /^\d+\.\d+\s+\d+\.\d+$/m.test(output)) {
    const upMatch = output.match(/^(\d+\.\d+)\s+\d+\.\d+$/m);
    if (upMatch?.[1]) result.uptime = Math.floor(parseFloat(upMatch[1]));
  }

  return result;
}

async function _fetchSsh(): Promise<ResourceResult> {
  const { Client } = require('ssh2') as { Client: any };

  return new Promise((resolve, reject) => {
    const conn = new Client();
    const timeout = setTimeout(() => {
      conn.end();
      reject(new Error('SSH command timed out'));
    }, 15000);

    conn.on('ready', () => {
      const cmd =
        'cat /proc/stat 2>/dev/null; echo "---MEMINFO---"; cat /proc/meminfo 2>/dev/null; echo "---DF---"; df -k 2>/dev/null; echo "---UPTIME---"; cat /proc/uptime 2>/dev/null';

      conn.exec(cmd, (err: any, stream: any) => {
        if (err) {
          clearTimeout(timeout);
          conn.end();
          reject(err);
          return;
        }
        let data = '';
        stream.on('data', (chunk: Buffer) => {
          data += chunk.toString();
        });
        stream.stderr.on('data', () => {
          /* ignore stderr */
        });
        stream.on('close', () => {
          clearTimeout(timeout);
          conn.end();
          try {
            resolve(parseSshOutput(data));
          } catch (e) {
            reject(e);
          }
        });
      });
    });

    conn.on('error', (err: any) => {
      clearTimeout(timeout);
      reject(err);
    });

    const sftpCfg = (_defaultConfig as any).sftpConnectConfig();
    conn.connect({
      host: sftpCfg.host,
      port: (_defaultConfig as any).sshPort || sftpCfg.port,
      username: sftpCfg.username,
      password: sftpCfg.password,
      privateKey: sftpCfg.privateKey,
      passphrase: sftpCfg.passphrase,
    });
  });
}

// ── Singleton with caching ──────────────────────────────────

class ServerResources {
  private _cache: ResourceResult | null;
  private _cacheTime: number;
  private _ttl: number;
  private _backend: 'pterodactyl' | 'ssh' | null;

  constructor() {
    this._cache = null;
    this._cacheTime = 0;
    this._ttl = parseInt(String((_defaultConfig as any).resourceCacheTtl), 10) || 30000;
    this._backend = this._detectBackend();
  }

  private _detectBackend(): 'pterodactyl' | 'ssh' | null {
    if ((panelApi as any).available) return 'pterodactyl';
    if (
      (_defaultConfig as any).enableSshResources &&
      (_defaultConfig as any).sftpHost &&
      (_defaultConfig as any).sftpUser
    )
      return 'ssh';
    return null;
  }

  get backend(): 'pterodactyl' | 'ssh' | null {
    return this._backend;
  }

  async getResources(): Promise<ResourceResult | null> {
    if (!this._backend) return null;
    const now = Date.now();
    if (this._cache && now - this._cacheTime < this._ttl) return this._cache;
    try {
      this._cache = this._backend === 'pterodactyl' ? await _fetchPterodactyl() : await _fetchSsh();
      this._cacheTime = now;
      return this._cache;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[RESOURCES] ${this._backend} fetch failed:`, msg);
      return this._cache || null;
    }
  }
}

const instance = new ServerResources();

export { ServerResources, parseSshOutput, formatBytes, formatUptime, _fetchPterodactyl, _emptyResult };

const _mod = module as { exports: any };
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
_mod.exports = instance;
_mod.exports.ServerResources = ServerResources;
_mod.exports.parseSshOutput = parseSshOutput;
_mod.exports.formatBytes = formatBytes;
_mod.exports.formatUptime = formatUptime;
_mod.exports._fetchPterodactyl = _fetchPterodactyl;
_mod.exports._emptyResult = _emptyResult;
/* eslint-enable @typescript-eslint/no-unsafe-member-access */

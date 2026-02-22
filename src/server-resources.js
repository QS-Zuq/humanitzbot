/**
 * Server resource monitoring — CPU, RAM, disk usage.
 *
 * Supports two backends (configured via .env):
 *   1. Pterodactyl API  — PANEL_SERVER_URL + PANEL_API_KEY (via panel-api.js)
 *   2. SSH shell         — Reuses FTP_HOST/FTP_PORT/FTP_USER/FTP_PASSWORD
 *
 * Exports a singleton with `getResources()` → { cpu, memUsed, memTotal, memPercent, diskUsed, diskTotal, diskPercent }
 * Values are null when unavailable. Cached for `RESOURCE_CACHE_TTL` ms (default 30 s).
 */

const config = require('./config');
const panelApi = require('./panel-api');

// ── Result shape ────────────────────────────────────────────
// All numeric values in human-friendly units (%, MB/GB).
function _emptyResult() {
  return {
    cpu: null,          // percent (0-100+)
    memUsed: null,      // bytes
    memTotal: null,     // bytes
    memPercent: null,   // percent
    diskUsed: null,     // bytes
    diskTotal: null,    // bytes
    diskPercent: null,  // percent
    uptime: null,       // seconds
    source: null,       // 'pterodactyl' | 'ssh'
  };
}

// ── Formatting helpers ──────────────────────────────────────

/** Bytes → human-readable string (e.g. 2147483648 → "2.00 GB") */
function formatBytes(bytes) {
  if (bytes == null || isNaN(bytes)) return '--';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(2)} GB`;
}

/** Seconds → "2d 5h 12m" */
function formatUptime(seconds) {
  if (seconds == null || isNaN(seconds)) return null;
  const s = Math.floor(seconds);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const parts = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0 || d > 0) parts.push(`${h}h`);
  parts.push(`${m}m`);
  return parts.join(' ');
}

// ── Pterodactyl API backend ─────────────────────────────────

async function _fetchPterodactyl() {
  const result = _emptyResult();
  result.source = 'pterodactyl';

  const r = await panelApi.getResources();

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

/**
 * Parse the combined output of `cat /proc/stat`, `cat /proc/meminfo`, and `df /`.
 * Exported for testing.
 */
function parseSshOutput(output) {
  const result = _emptyResult();
  result.source = 'ssh';

  if (!output) return result;

  // ── CPU from /proc/stat  (first "cpu" line) ──
  //   cpu  user nice system idle iowait irq softirq steal
  const cpuMatch = output.match(/^cpu\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/m);
  if (cpuMatch) {
    const [, user, nice, system, idle, iowait, irq, softirq, steal] = cpuMatch.map(Number);
    const total = user + nice + system + idle + iowait + irq + softirq + steal;
    const busy = total - idle - iowait;
    if (total > 0) result.cpu = Math.round((busy / total) * 1000) / 10;
  }

  // ── Memory from /proc/meminfo ──
  const memTotal = output.match(/MemTotal:\s+(\d+)\s+kB/);
  const memAvail = output.match(/MemAvailable:\s+(\d+)\s+kB/);
  if (memTotal) {
    result.memTotal = parseInt(memTotal[1], 10) * 1024;  // kB → bytes
    if (memAvail) {
      const avail = parseInt(memAvail[1], 10) * 1024;
      result.memUsed = result.memTotal - avail;
      result.memPercent = Math.round((result.memUsed / result.memTotal) * 1000) / 10;
    }
  }

  // ── Disk from `df` output ──
  // Filesystem  1K-blocks  Used  Available  Use%  Mounted
  const dfLines = output.split('\n').filter(l => /^\S+\s+\d/.test(l));
  // Try to find the mount for the game server path, fall back to "/"
  const gamePath = config.ftpBasePath || '/';
  let bestLine = null;
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
    bestLine = dfLines[0].trim().split(/\s+/);
  }
  if (bestLine && bestLine.length >= 4) {
    const totalKB = parseInt(bestLine[1], 10);
    const usedKB = parseInt(bestLine[2], 10);
    if (!isNaN(totalKB) && !isNaN(usedKB)) {
      result.diskTotal = totalKB * 1024;
      result.diskUsed = usedKB * 1024;
      result.diskPercent = result.diskTotal > 0
        ? Math.round((result.diskUsed / result.diskTotal) * 1000) / 10
        : null;
    }
  }

  // ── Uptime from /proc/uptime ──
  const uptimeMatch = output.match(/^(\d+(?:\.\d+)?)\s+/m);
  // Only grab if it looks like the /proc/uptime line (two floats)
  if (output.includes('/proc/uptime') || /^\d+\.\d+\s+\d+\.\d+$/m.test(output)) {
    const upMatch = output.match(/^(\d+\.\d+)\s+\d+\.\d+$/m);
    if (upMatch) result.uptime = Math.floor(parseFloat(upMatch[1]));
  }

  return result;
}

async function _fetchSsh() {
  // ssh2 ships inside ssh2-sftp-client — use it directly
  const { Client } = require('ssh2');

  return new Promise((resolve, reject) => {
    const conn = new Client();
    const timeout = setTimeout(() => {
      conn.end();
      reject(new Error('SSH command timed out'));
    }, 15000);

    conn.on('ready', () => {
      // Combine commands to minimise round-trips
      const cmd = 'cat /proc/stat 2>/dev/null; echo "---MEMINFO---"; cat /proc/meminfo 2>/dev/null; echo "---DF---"; df -k 2>/dev/null; echo "---UPTIME---"; cat /proc/uptime 2>/dev/null';

      conn.exec(cmd, (err, stream) => {
        if (err) { clearTimeout(timeout); conn.end(); return reject(err); }

        let data = '';
        stream.on('data', chunk => { data += chunk.toString(); });
        stream.stderr.on('data', () => {}); // ignore stderr
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

    conn.on('error', err => {
      clearTimeout(timeout);
      reject(err);
    });

    conn.connect({
      host: config.ftpHost,
      port: config.sshPort || config.ftpPort,
      username: config.ftpUser,
      password: config.ftpPassword,
    });
  });
}

// ── Singleton with caching ──────────────────────────────────

class ServerResources {
  constructor() {
    this._cache = null;
    this._cacheTime = 0;
    this._ttl = parseInt(config.resourceCacheTtl, 10) || 30000;
    this._backend = this._detectBackend();
  }

  _detectBackend() {
    if (panelApi.available) {
      return 'pterodactyl';
    }
    if (config.enableSshResources && config.ftpHost && config.ftpUser) {
      return 'ssh';
    }
    return null;
  }

  /** @returns {'pterodactyl'|'ssh'|null} */
  get backend() {
    return this._backend;
  }

  /** Fetch (or return cached) resource metrics. Returns null if no backend configured. */
  async getResources() {
    if (!this._backend) return null;

    const now = Date.now();
    if (this._cache && (now - this._cacheTime) < this._ttl) {
      return this._cache;
    }

    try {
      if (this._backend === 'pterodactyl') {
        this._cache = await _fetchPterodactyl();
      } else {
        this._cache = await _fetchSsh();
      }
      this._cacheTime = now;
      return this._cache;
    } catch (err) {
      console.error(`[RESOURCES] ${this._backend} fetch failed:`, err.message);
      // Return stale cache if available
      return this._cache || null;
    }
  }
}

const instance = new ServerResources();

module.exports = instance;
module.exports.ServerResources = ServerResources;
module.exports.parseSshOutput = parseSshOutput;
module.exports.formatBytes = formatBytes;
module.exports.formatUptime = formatUptime;
module.exports._fetchPterodactyl = _fetchPterodactyl;
module.exports._emptyResult = _emptyResult;

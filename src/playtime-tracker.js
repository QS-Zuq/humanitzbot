const fs = require('fs');
const path = require('path');
const _defaultConfig = require('./config');

const DEFAULT_DATA_DIR = path.join(__dirname, '..', 'data');
const SAVE_INTERVAL = 60000; // save to disk every 60s

class PlaytimeTracker {
  /**
   * @param {object} [options]
   * @param {string} [options.dataDir]  Custom data directory (for multi-server)
   * @param {object} [options.config]   Custom config object
   * @param {string} [options.label]    Log prefix for identification
   */
  constructor(options = {}) {
    this._data = null;
    this._activeSessions = new Map(); // id → login timestamp
    this._saveTimer = null;
    this._dirty = false;
    this._currentOnlineCount = 0;
    // Per-instance overrides (for multi-server support)
    this._dataDir = options.dataDir || DEFAULT_DATA_DIR;
    this._dataFile = path.join(this._dataDir, 'playtime.json');
    this._config = options.config || _defaultConfig;
    this._label = options.label || 'PLAYTIME';
  }

  init() {
    if (this._data) return; // already initialised
    this._load();
    this._cleanGhostEntries();
    this._backfillUniqueDayPeak();
    // Periodic save so we don't lose data on crash
    this._saveTimer = setInterval(() => this._autoSave(), SAVE_INTERVAL);
    console.log(`[${this._label}] Tracking since ${this._data.trackingSince}`);
    console.log(`[${this._label}] ${Object.keys(this._data.players).length} player(s) in database`);
  }

  stop() {
    // Close all active sessions before saving
    const now = Date.now();
    for (const [id, loginTime] of this._activeSessions) {
      this._addPlaytime(id, now - loginTime);
    }
    this._activeSessions.clear();
    this._save();
    if (this._saveTimer) clearInterval(this._saveTimer);
    console.log(`[${this._label}] Saved and stopped.`);
  }

  playerJoin(id, name, timestamp) {
    // Only accept SteamID keys — reject name-based keys
    if (!/^\d{17}$/.test(id)) return;
    this._ensureInit();

    const now = timestamp ? timestamp.getTime() : Date.now();

    // If already in an active session, flush accumulated time (don't lose it)
    const existingSession = this._activeSessions.get(id);
    if (existingSession) {
      this._addPlaytime(id, now - existingSession, timestamp);
    }

    this._activeSessions.set(id, now);

    // Ensure player record exists
    if (!this._data.players[id]) {
      this._data.players[id] = {
        name,
        totalMs: 0,
        sessions: 0,
        firstSeen: new Date(now).toISOString(),
        lastLogin: null,
        lastSeen: null,
      };
    }

    // Update name (in case it changed) and login time
    this._data.players[id].name = name;
    this._data.players[id].lastLogin = new Date(now).toISOString();
    // Only increment session count for genuinely new sessions (not duplicate joins)
    if (!existingSession) {
      this._data.players[id].sessions += 1;
    }
    this._dirty = true;

    console.log(`[${this._label}] ${name} (${id}) session started`);
  }

  playerLeave(id, timestamp) {
    const loginTime = this._activeSessions.get(id);
    if (loginTime) {
      const now = timestamp ? timestamp.getTime() : Date.now();
      const duration = now - loginTime;
      this._addPlaytime(id, duration, timestamp);
      this._activeSessions.delete(id);

      const record = this._data.players[id];
      const name = record ? record.name : id;
      console.log(`[${this._label}] ${name} (${id}) session ended — ${this._formatDuration(duration)}`);
    }
  }

  _ensureInit() {
    if (!this._data) this.init();
  }

  getPlaytime(id) {
    this._ensureInit();
    const record = this._data.players[id];
    if (!record) return null;

    let totalMs = record.totalMs;

    // Add current session time if they're online right now
    const loginTime = this._activeSessions.get(id);
    if (loginTime) {
      totalMs += Date.now() - loginTime;
    }

    return {
      name: record.name,
      totalMs,
      totalFormatted: this._formatDuration(totalMs),
      sessions: record.sessions,
      isReturning: record.sessions > 1 || record.totalMs > 0,
      firstSeen: record.firstSeen,
      lastSeen: record.lastSeen,
      lastLogin: record.lastLogin,
    };
  }

  hasHistory(id) {
    return !!this._data.players[id];
  }

  getLeaderboard() {
    this._ensureInit();
    const entries = [];
    for (const [id, record] of Object.entries(this._data.players)) {
      let totalMs = record.totalMs;
      const loginTime = this._activeSessions.get(id);
      if (loginTime) totalMs += Date.now() - loginTime;

      entries.push({
        id,
        name: record.name,
        totalMs,
        totalFormatted: this._formatDuration(totalMs),
        sessions: record.sessions,
      });
    }
    entries.sort((a, b) => b.totalMs - a.totalMs);
    return entries;
  }

  getTrackingSince() {
    this._ensureInit();
    return this._data.trackingSince;
  }

  recordPlayerCount(count) {
    this._ensureInit();
    this._currentOnlineCount = count;
    this._ensurePeaks();

    const today = this._config.getToday();

    // Day rollover — snapshot yesterday's unique count before resetting
    if (this._data.peaks.todayDate !== today) {
      this._snapshotYesterdayUnique();
      this._data.peaks.todayPeak = 0;
      this._data.peaks.todayDate = today;
      this._data.peaks.uniqueToday = [];
    }

    // Update peaks
    if (count > this._data.peaks.allTimePeak) {
      this._data.peaks.allTimePeak = count;
      this._data.peaks.allTimePeakDate = new Date().toISOString();
    }
    if (count > this._data.peaks.todayPeak) {
      this._data.peaks.todayPeak = count;
    }

    this._dirty = true;
  }

  recordUniqueToday(id) {
    this._ensureInit();
    this._ensurePeaks();
    const today = this._config.getToday();

    // Day rollover — snapshot yesterday's unique count before resetting
    if (this._data.peaks.todayDate !== today) {
      this._snapshotYesterdayUnique();
      this._data.peaks.todayPeak = 0;
      this._data.peaks.todayDate = today;
      this._data.peaks.uniqueToday = [];
    }

    if (!id || this._data.peaks.uniqueToday.includes(id)) return;
    this._data.peaks.uniqueToday.push(id);

    // Update unique-day peak (best day by unique player count)
    const uniqueCount = this._data.peaks.uniqueToday.length;
    if (uniqueCount > (this._data.peaks.uniqueDayPeak || 0)) {
      this._data.peaks.uniqueDayPeak = uniqueCount;
      this._data.peaks.uniqueDayPeakDate = new Date().toISOString();
    }

    this._dirty = true;
  }

  getPeaks() {
    this._ensureInit();
    const peaks = this._data.peaks || {};
    return {
      allTimePeak: peaks.allTimePeak || 0,
      allTimePeakDate: peaks.allTimePeakDate || null,
      todayPeak: peaks.todayPeak || 0,
      uniqueToday: (peaks.uniqueToday || []).length,
      uniqueDayPeak: peaks.uniqueDayPeak || 0,
      uniqueDayPeakDate: peaks.uniqueDayPeakDate || null,
      yesterdayUnique: peaks.yesterdayUnique || 0,
      totalUniquePlayers: Object.keys(this._data.players).length,
    };
  }

  /**
   * Snapshot yesterday's unique player count before the daily reset.
   * Also updates the unique-day peak if yesterday was a record day.
   */
  _snapshotYesterdayUnique() {
    const uniqueCount = (this._data.peaks.uniqueToday || []).length;
    this._data.peaks.yesterdayUnique = uniqueCount;
    if (uniqueCount > (this._data.peaks.uniqueDayPeak || 0)) {
      this._data.peaks.uniqueDayPeak = uniqueCount;
      this._data.peaks.uniqueDayPeakDate = new Date().toISOString();
    }
  }

  /**
   * Ensure peaks sub-object exists (migration for old data).
   */
  _ensurePeaks() {
    if (!this._data.peaks) {
      this._data.peaks = {
        allTimePeak: 0,
        allTimePeakDate: null,
        todayPeak: 0,
        todayDate: this._config.getToday(),
        uniqueToday: [],
        uniqueDayPeak: 0,
        uniqueDayPeakDate: null,
        yesterdayUnique: 0,
      };
    }
  }

  // ── Private ────────────────────────────────────────────────

  _cleanGhostEntries() {
    const toDelete = [];
    for (const key of Object.keys(this._data.players)) {
      if (/^\d{17}$/.test(key)) continue; // valid SteamID — keep

      // Try to find a SteamID entry with the same name
      const ghost = this._data.players[key];
      let merged = false;
      for (const [sid, record] of Object.entries(this._data.players)) {
        if (!/^\d{17}$/.test(sid)) continue;
        if (record.name === ghost.name || record.name === key) {
          // Merge playtime into the SteamID entry
          record.totalMs = Math.max(record.totalMs, ghost.totalMs);
          record.sessions = Math.max(record.sessions, ghost.sessions);
          if (ghost.firstSeen && (!record.firstSeen || ghost.firstSeen < record.firstSeen)) {
            record.firstSeen = ghost.firstSeen;
          }
          console.log(`[${this._label}] Merged ghost "${key}" into ${sid} (${record.name})`);
          merged = true;
          break;
        }
      }
      if (!merged) {
        console.log(`[${this._label}] Removing orphan ghost entry "${key}" (no SteamID match)`);
      }
      toDelete.push(key);
    }
    if (toDelete.length > 0) {
      for (const key of toDelete) delete this._data.players[key];
      // Also clean uniqueToday of any name-based entries
      if (this._data.peaks && Array.isArray(this._data.peaks.uniqueToday)) {
        this._data.peaks.uniqueToday = this._data.peaks.uniqueToday.filter(id => /^\d{17}$/.test(id));
      }
      this._dirty = true;
      console.log(`[${this._label}] Cleaned ${toDelete.length} ghost entries`);
    }
  }

  /**
   * One-time migration: if uniqueDayPeak is 0, scan the local
   * PlayerConnectedLog.txt to compute the best-unique-day from history.
   */
  _backfillUniqueDayPeak() {
    this._ensurePeaks();
    if (this._data.peaks.uniqueDayPeak > 0) return; // already populated

    const logPath = path.join(this._dataDir, 'PlayerConnectedLog.txt');
    if (!fs.existsSync(logPath)) return;

    try {
      const text = fs.readFileSync(logPath, 'utf8');
      const dayMap = new Map(); // 'D/M/YYYY' → Set of steamIds
      // Format: Player Connected Name NetID(76561198055916841_+_|...) (13/2/2026 11:13)
      const RE = /Player Connected .+ NetID\((\d{17})_\+_\|[^)]+\) \((\d{1,2}\/\d{1,2}\/\d{4}) /;

      for (const line of text.split('\n')) {
        const m = line.match(RE);
        if (!m) continue;
        const [, steamId, dateStr] = m;
        if (!dayMap.has(dateStr)) dayMap.set(dateStr, new Set());
        dayMap.get(dateStr).add(steamId);
      }

      let bestCount = 0;
      let bestDate = null;
      for (const [dateStr, ids] of dayMap) {
        if (ids.size > bestCount) {
          bestCount = ids.size;
          bestDate = dateStr;
        }
      }

      if (bestCount > 0) {
        this._data.peaks.uniqueDayPeak = bestCount;
        // Parse D/M/YYYY → ISO date
        const parts = bestDate.split('/');
        this._data.peaks.uniqueDayPeakDate = new Date(
          parseInt(parts[2]), parseInt(parts[1]) - 1, parseInt(parts[0]), 12, 0, 0
        ).toISOString();
        this._dirty = true;
        console.log(`[${this._label}] Backfilled uniqueDayPeak: ${bestCount} on ${bestDate}`);
      }
    } catch (err) {
      console.warn(`[${this._label}] Could not backfill uniqueDayPeak:`, err.message);
    }
  }

  _addPlaytime(id, durationMs, timestamp) {
    if (!this._data.players[id]) return;
    this._data.players[id].totalMs += durationMs;
    this._data.players[id].lastSeen = (timestamp || new Date()).toISOString();
    this._dirty = true;
  }

  _formatDuration(ms) {
    if (ms < 1000) return '0m';
    const totalSeconds = Math.floor(ms / 1000);
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);

    const parts = [];
    if (days > 0) parts.push(`${days} Day${days !== 1 ? 's' : ''}`);
    if (hours > 0) parts.push(`${hours} Hour${hours !== 1 ? 's' : ''}`);
    if (minutes > 0 || parts.length === 0) parts.push(`${minutes} Minute${minutes !== 1 ? 's' : ''}`);
    return parts.join(', ');
  }

  _load() {
    try {
      if (fs.existsSync(this._dataFile)) {
        const raw = fs.readFileSync(this._dataFile, 'utf8');
        const parsed = JSON.parse(raw);
        // Validate: must be an object with a players property
        if (!parsed || typeof parsed !== 'object' || !parsed.players || typeof parsed.players !== 'object') {
          console.error(`[${this._label}] playtime.json is corrupt (missing players object) — creating fresh`);
          // Backup the corrupt file for inspection
          const corruptBackup = this._dataFile.replace('.json', `-corrupt-${Date.now()}.json`);
          fs.copyFileSync(this._dataFile, corruptBackup);
          console.log(`[${this._label}] Corrupt file backed up to ${path.basename(corruptBackup)}`);
          this._createFresh();
          return;
        }
        this._data = parsed;
        console.log(`[${this._label}] Loaded existing data from playtime.json`);
      } else {
        this._createFresh();
      }
    } catch (err) {
      console.error(`[${this._label}] Failed to load data, creating fresh:`, err.message);
      this._createFresh();
    }
  }

  _createFresh() {
    this._data = {
      trackingSince: new Date().toISOString(),
      players: {},
      peaks: {
        allTimePeak: 0,
        allTimePeakDate: null,
        todayPeak: 0,
        todayDate: this._config.getToday(),
        uniqueToday: [],
        uniqueDayPeak: 0,
        uniqueDayPeakDate: null,
        yesterdayUnique: 0,
      },
    };
    this._save();
    console.log(`[${this._label}] Created fresh playtime.json`);
  }

  _save(doBackup = false) {
    try {
      if (!this._data || typeof this._data !== 'object') {
        console.warn(`[${this._label}] Not saving: _data is null or invalid`);
        return false;
      }
      if (!fs.existsSync(this._dataDir)) {
        fs.mkdirSync(this._dataDir, { recursive: true });
      }
      // Atomic write: write to temp file then rename
      const tmpFile = this._dataFile + '.tmp';
      fs.writeFileSync(tmpFile, JSON.stringify(this._data, null, 2), 'utf8');
      fs.renameSync(tmpFile, this._dataFile);
      this._dirty = false;
      // Backup logic
      if (doBackup) {
        const ts = Date.now();
        const backupFile = path.join(this._dataDir, `playtime-backup-${ts}.json`);
        fs.copyFileSync(this._dataFile, backupFile);
        // Prune old backups (keep last 5)
        const files = fs.readdirSync(this._dataDir)
          .filter(f => f.startsWith('playtime-backup-') && f.endsWith('.json'))
          .map(f => ({ f, t: parseInt(f.split('-')[2]) }))
          .filter(x => !isNaN(x.t))
          .sort((a, b) => b.t - a.t);
        for (let i = 5; i < files.length; ++i) {
          try { fs.unlinkSync(path.join(this._dataDir, files[i].f)); } catch {}
        }
      }
      return true;
    } catch (err) {
      console.error(`[${this._label}] Failed to save:`, err.message);
      return false;
    }
  }

  _autoSave() {
    // If no active sessions, just save if dirty
    if (this._activeSessions.size === 0) {
      if (this._dirty) this._save();
      return;
    }

    // Flush active sessions' running time into records
    const now = Date.now();
    const sessionDeltas = new Map();
    const oldLastSeen = new Map();
    for (const [id, loginTime] of this._activeSessions) {
      const delta = now - loginTime;
      sessionDeltas.set(id, delta);
      if (this._data.players[id]) {
        oldLastSeen.set(id, this._data.players[id].lastSeen);
      }
      this._addPlaytime(id, delta);
    }

    // Every 15 minutes, do a backup
    const doBackup = (now % (15 * 60 * 1000)) < SAVE_INTERVAL;
    const saved = this._save(doBackup);
    if (saved !== false) {
      // Save succeeded — reset session starts so time isn't double-counted
      for (const [id] of sessionDeltas) {
        this._activeSessions.set(id, now);
      }
    } else {
      // Save failed — rollback totalMs and lastSeen
      for (const [id, delta] of sessionDeltas) {
        if (this._data.players[id]) {
          this._data.players[id].totalMs -= delta;
          const prevSeen = oldLastSeen.get(id);
          if (prevSeen !== undefined) {
            this._data.players[id].lastSeen = prevSeen;
          }
        }
      }
    }
  }
}

// Singleton — shared across the bot
const _singleton = new PlaytimeTracker();
module.exports = _singleton;
module.exports.PlaytimeTracker = PlaytimeTracker;

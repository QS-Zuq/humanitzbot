const fs = require('fs');
const path = require('path');
const config = require('./config');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'playtime.json');
const SAVE_INTERVAL = 60000; // save to disk every 60s

class PlaytimeTracker {
  constructor() {
    this._data = null;
    this._activeSessions = new Map(); // id → login timestamp
    this._saveTimer = null;
    this._dirty = false;
    this._currentOnlineCount = 0;
  }

  init() {
    if (this._data) return; // already initialised
    this._load();
    this._cleanGhostEntries();
    // Periodic save so we don't lose data on crash
    this._saveTimer = setInterval(() => this._autoSave(), SAVE_INTERVAL);
    console.log(`[PLAYTIME] Tracking since ${this._data.trackingSince}`);
    console.log(`[PLAYTIME] ${Object.keys(this._data.players).length} player(s) in database`);
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
    console.log('[PLAYTIME] Saved and stopped.');
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

    console.log(`[PLAYTIME] ${name} (${id}) session started`);
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
      console.log(`[PLAYTIME] ${name} (${id}) session ended — ${this._formatDuration(duration)}`);
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

    // Ensure peaks object exists (migration for old data)
    if (!this._data.peaks) {
      this._data.peaks = {
        allTimePeak: 0,
        allTimePeakDate: null,
        todayPeak: 0,
        todayDate: config.getToday(),
        uniqueToday: [],
      };
    }

    const today = config.getToday();

    // Reset daily stats if the date changed
    if (this._data.peaks.todayDate !== today) {
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
    if (!this._data.peaks) return;
    const today = config.getToday();
    if (this._data.peaks.todayDate !== today) {
      this._data.peaks.todayPeak = 0;
      this._data.peaks.todayDate = today;
      this._data.peaks.uniqueToday = [];
    }
    if (!this._data.peaks.uniqueToday.includes(id)) {
      this._data.peaks.uniqueToday.push(id);
      this._dirty = true;
    }
  }

  getPeaks() {
    this._ensureInit();
    const peaks = this._data.peaks || {};
    return {
      allTimePeak: peaks.allTimePeak || 0,
      allTimePeakDate: peaks.allTimePeakDate || null,
      todayPeak: peaks.todayPeak || 0,
      uniqueToday: (peaks.uniqueToday || []).length,
      totalUniquePlayers: Object.keys(this._data.players).length,
    };
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
          console.log(`[PLAYTIME] Merged ghost "${key}" into ${sid} (${record.name})`);
          merged = true;
          break;
        }
      }
      if (!merged) {
        console.log(`[PLAYTIME] Removing orphan ghost entry "${key}" (no SteamID match)`);
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
      console.log(`[PLAYTIME] Cleaned ${toDelete.length} ghost entries`);
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
      if (fs.existsSync(DATA_FILE)) {
        const raw = fs.readFileSync(DATA_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        // Validate: must be an object with a players property
        if (!parsed || typeof parsed !== 'object' || !parsed.players || typeof parsed.players !== 'object') {
          console.error('[PLAYTIME] playtime.json is corrupt (missing players object) — creating fresh');
          // Backup the corrupt file for inspection
          const corruptBackup = DATA_FILE.replace('.json', `-corrupt-${Date.now()}.json`);
          fs.copyFileSync(DATA_FILE, corruptBackup);
          console.log(`[PLAYTIME] Corrupt file backed up to ${path.basename(corruptBackup)}`);
          this._createFresh();
          return;
        }
        this._data = parsed;
        console.log('[PLAYTIME] Loaded existing data from playtime.json');
      } else {
        this._createFresh();
      }
    } catch (err) {
      console.error('[PLAYTIME] Failed to load data, creating fresh:', err.message);
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
        todayDate: config.getToday(),
        uniqueToday: [],
      },
    };
    this._save();
    console.log('[PLAYTIME] Created fresh playtime.json');
  }

  _save(doBackup = false) {
    try {
      if (!this._data || typeof this._data !== 'object') {
        console.warn('[PLAYTIME] Not saving: _data is null or invalid');
        return false;
      }
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      // Atomic write: write to temp file then rename
      const tmpFile = DATA_FILE + '.tmp';
      fs.writeFileSync(tmpFile, JSON.stringify(this._data, null, 2), 'utf8');
      fs.renameSync(tmpFile, DATA_FILE);
      this._dirty = false;
      // Backup logic
      if (doBackup) {
        const ts = Date.now();
        const backupFile = path.join(DATA_DIR, `playtime-backup-${ts}.json`);
        fs.copyFileSync(DATA_FILE, backupFile);
        // Prune old backups (keep last 5)
        const files = fs.readdirSync(DATA_DIR)
          .filter(f => f.startsWith('playtime-backup-') && f.endsWith('.json'))
          .map(f => ({ f, t: parseInt(f.split('-')[2]) }))
          .filter(x => !isNaN(x.t))
          .sort((a, b) => b.t - a.t);
        for (let i = 5; i < files.length; ++i) {
          try { fs.unlinkSync(path.join(DATA_DIR, files[i].f)); } catch {}
        }
      }
      return true;
    } catch (err) {
      console.error('[PLAYTIME] Failed to save:', err.message);
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
module.exports = new PlaytimeTracker();

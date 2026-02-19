const fs = require('fs');
const path = require('path');

/**
 * PlaytimeTracker — persists per-player session and cumulative playtime
 * to a JSON file. Tracks login/logout timestamps and accumulates totals.
 *
 * Data format (playtime.json):
 * {
 *   "trackingSince": "2026-02-18T00:00:00.000Z",
 *   "players": {
 *     "76561198000000000": {
 *       "name": "PlayerName",
 *       "totalMs": 123456,
 *       "sessions": 5,
 *       "lastLogin": "2026-02-18T12:00:00.000Z",
 *       "lastSeen": "2026-02-18T14:30:00.000Z"
 *     }
 *   }
 * }
 */

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

  /**
   * Load data from disk (or create fresh).
   */
  init() {
    this._load();
    this._cleanGhostEntries();
    // Periodic save so we don't lose data on crash
    this._saveTimer = setInterval(() => this._autoSave(), SAVE_INTERVAL);
    console.log(`[PLAYTIME] Tracking since ${this._data.trackingSince}`);
    console.log(`[PLAYTIME] ${Object.keys(this._data.players).length} player(s) in database`);
  }

  /**
   * Stop the tracker and save final state.
   */
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

  /**
   * Called when a player joins the server.
   * @param {string} id - SteamID or player name
   * @param {string} name - Display name
   */
  playerJoin(id, name) {
    // Only accept SteamID keys — reject name-based keys
    if (!/^\d{17}$/.test(id)) return;

    const now = Date.now();
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
    this._data.players[id].sessions += 1;
    this._dirty = true;

    console.log(`[PLAYTIME] ${name} (${id}) session started`);
  }

  /**
   * Called when a player leaves the server.
   * @param {string} id - SteamID or player name
   */
  playerLeave(id) {
    const loginTime = this._activeSessions.get(id);
    if (loginTime) {
      const duration = Date.now() - loginTime;
      this._addPlaytime(id, duration);
      this._activeSessions.delete(id);

      const record = this._data.players[id];
      const name = record ? record.name : id;
      console.log(`[PLAYTIME] ${name} (${id}) session ended — ${this._formatDuration(duration)}`);
    }
  }

  /**
   * Get a player's total playtime (including current active session).
   * @param {string} id - SteamID or player name
   * @returns {{ name, totalMs, totalFormatted, sessions, isReturning, firstSeen } | null}
   */
  getPlaytime(id) {
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
    };
  }

  /**
   * Check if a player has any history.
   * @param {string} id
   * @returns {boolean}
   */
  hasHistory(id) {
    return !!this._data.players[id];
  }

  /**
   * Get all players sorted by playtime descending.
   * @returns {Array<{ id, name, totalMs, totalFormatted, sessions }>}
   */
  getLeaderboard() {
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

  /**
   * Get the tracking start date string.
   */
  getTrackingSince() {
    return this._data.trackingSince;
  }

  /**
   * Update the current online count and record peaks.
   * Call this whenever the player count is known.
   * @param {number} count
   */
  recordPlayerCount(count) {
    this._currentOnlineCount = count;

    // Ensure peaks object exists (migration for old data)
    if (!this._data.peaks) {
      this._data.peaks = {
        allTimePeak: 0,
        allTimePeakDate: null,
        todayPeak: 0,
        todayDate: new Date().toISOString().split('T')[0],
        uniqueToday: [],
      };
    }

    const today = new Date().toISOString().split('T')[0];

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

  /**
   * Record a unique player for today's stats.
   * @param {string} id
   */
  recordUniqueToday(id) {
    if (!this._data.peaks) return;
    const today = new Date().toISOString().split('T')[0];
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

  /**
   * Get peak statistics.
   * @returns {{ allTimePeak, allTimePeakDate, todayPeak, uniqueToday, totalUniquePlayers }}
   */
  getPeaks() {
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

  /**
   * Remove ghost entries keyed by player name instead of SteamID.
   * These were created when RCON returned players without a parseable SteamID.
   * If a matching SteamID entry exists, merge the playtime into it.
   */
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

  _addPlaytime(id, durationMs) {
    if (!this._data.players[id]) return;
    this._data.players[id].totalMs += durationMs;
    this._data.players[id].lastSeen = new Date().toISOString();
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
        this._data = JSON.parse(raw);
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
        todayDate: new Date().toISOString().split('T')[0],
        uniqueToday: [],
      },
    };
    this._save();
    console.log('[PLAYTIME] Created fresh playtime.json');
  }

  _save() {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      fs.writeFileSync(DATA_FILE, JSON.stringify(this._data, null, 2), 'utf8');
      this._dirty = false;
      return true;
    } catch (err) {
      console.error('[PLAYTIME] Failed to save:', err.message);
      return false;
    }
  }

  _autoSave() {
    // Also flush active sessions' running time into records
    const now = Date.now();
    const sessionDeltas = new Map();
    for (const [id, loginTime] of this._activeSessions) {
      sessionDeltas.set(id, now - loginTime);
      this._addPlaytime(id, now - loginTime);
    }

    if (this._dirty) {
      const saved = this._save();
      if (saved !== false) {
        // Only reset session starts if save succeeded
        for (const [id] of sessionDeltas) {
          this._activeSessions.set(id, now);
        }
      } else {
        // Rollback: subtract the deltas we just added so they aren't double-counted
        for (const [id, delta] of sessionDeltas) {
          if (this._data.players[id]) {
            this._data.players[id].totalMs -= delta;
          }
        }
      }
    } else {
      // No dirty data to save, but still reset session starts
      for (const [id] of this._activeSessions) {
        this._activeSessions.set(id, now);
      }
    }
  }
}

// Singleton — shared across the bot
module.exports = new PlaytimeTracker();

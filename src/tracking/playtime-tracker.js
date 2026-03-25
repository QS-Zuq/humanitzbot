const fs = require('fs');
const path = require('path');
const _defaultConfig = require('../config');
const { createLogger } = require('../utils/log');

const DEFAULT_DATA_DIR = path.join(__dirname, '..', '..', 'data');

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
    this._currentOnlineCount = 0;
    this._db = options.db || null; // optional HumanitZDB for playtime syncing
    // Per-instance overrides (for multi-server support)
    this._dataDir = options.dataDir || DEFAULT_DATA_DIR;
    this._config = options.config || _defaultConfig;
    this._log = createLogger(options.label, 'PLAYTIME');
  }

  init() {
    if (this._data) return; // already initialised
    this._loadFromDb(); // load from DB
    if (!this._data) {
      // DB has nothing yet — create empty structure
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
    }
    this._cleanGhostEntries();
    this._backfillUniqueDayPeak();
    this._log.info(`Tracking since ${this._data.trackingSince}`);
    this._log.info(`${Object.keys(this._data.players).length} player(s) in database`);
  }

  stop() {
    // Close all active sessions before stopping
    const now = Date.now();
    for (const [id, loginTime] of this._activeSessions) {
      this._addPlaytime(id, now - loginTime);
    }
    this._activeSessions.clear();
    this._log.info('Stopped.');
  }

  /** Attach a HumanitZDB instance for unified playtime + alias syncing. */
  setDb(db) {
    this._db = db;
    // If init() already ran with no DB (empty data), reload from DB now.
    // This prevents the scenario where empty in-memory data overwrites
    // real DB values on the next _persistPlaytime() call.
    if (this._data && db) {
      try {
        const rows = db.getAllPlayerPlaytime();
        if (rows && rows.length > 0) {
          let reloaded = 0;
          for (const row of rows) {
            const sid = row.steam_id;
            const dbMs = (row.playtime_seconds || 0) * 1000;
            const memMs = this._data.players[sid]?.totalMs || 0;
            // Only take DB value if it's higher (never reduce playtime)
            if (dbMs > memMs) {
              this._data.players[sid] = {
                name: row.name || this._data.players[sid]?.name || sid,
                totalMs: dbMs,
                sessions: Math.max(row.session_count || 0, this._data.players[sid]?.sessions || 0),
                firstSeen: row.playtime_first_seen || this._data.players[sid]?.firstSeen || null,
                lastLogin: row.playtime_last_login || this._data.players[sid]?.lastLogin || null,
                lastSeen: row.playtime_last_seen || this._data.players[sid]?.lastSeen || null,
              };
              reloaded++;
            } else if (!this._data.players[sid] && row.playtime_seconds > 0) {
              // Player exists in DB but not in memory at all
              this._data.players[sid] = {
                name: row.name || sid,
                totalMs: dbMs,
                sessions: row.session_count || 0,
                firstSeen: row.playtime_first_seen || null,
                lastLogin: row.playtime_last_login || null,
                lastSeen: row.playtime_last_seen || null,
              };
              reloaded++;
            }
          }
          if (reloaded > 0) {
            this._log.info(`Reloaded ${reloaded} player(s) from DB after late setDb()`);
            this._leaderboardCache = null;
          }
        }
      } catch (err) {
        this._log.warn('DB reload on setDb() failed:', err.message);
      }
    }
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
    this._leaderboardCache = null;
    this._persistPlaytime(id);

    // Register alias in unified identity DB
    if (this._db) {
      try {
        this._db.registerAlias(id, name, 'playtime');
      } catch (_) {}
    }

    this._log.info(`${name} (${id}) session started`);
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
      this._log.info(`${name} (${id}) session ended — ${this._formatDuration(duration)}`);
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

  /** Return active sessions as { playerName: loginTimestamp, ... } */
  getActiveSessions() {
    this._ensureInit();
    const result = {};
    for (const [id, loginTime] of this._activeSessions) {
      const record = this._data.players[id];
      const name = record ? record.name : id;
      result[name] = loginTime;
    }
    return result;
  }

  hasHistory(id) {
    return !!this._data.players[id];
  }

  getLeaderboard() {
    this._ensureInit();
    // Return cached result when no active sessions (cache invalidated on mutations)
    if (this._leaderboardCache && this._activeSessions.size === 0) {
      return this._leaderboardCache;
    }
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
    this._leaderboardCache = entries;
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
      this._uniqueTodaySet = new Set();
    }

    // Update peaks
    if (count > this._data.peaks.allTimePeak) {
      this._data.peaks.allTimePeak = count;
      this._data.peaks.allTimePeakDate = new Date().toISOString();
    }
    if (count > this._data.peaks.todayPeak) {
      this._data.peaks.todayPeak = count;
    }

    this._persistPeaks();
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
      this._uniqueTodaySet = new Set();
    }

    if (!id) return;
    // Lazily build the Set from the array (e.g. after a load from disk)
    if (!this._uniqueTodaySet) {
      this._uniqueTodaySet = new Set(this._data.peaks.uniqueToday || []);
    }
    if (this._uniqueTodaySet.has(id)) return;
    this._uniqueTodaySet.add(id);
    this._data.peaks.uniqueToday.push(id);

    // Update unique-day peak (best day by unique player count)
    const uniqueCount = this._data.peaks.uniqueToday.length;
    if (uniqueCount > (this._data.peaks.uniqueDayPeak || 0)) {
      this._data.peaks.uniqueDayPeak = uniqueCount;
      this._data.peaks.uniqueDayPeakDate = new Date().toISOString();
    }

    this._persistPeaks();
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

  // ── DB-first helpers ────────────────────────────────────

  /** Load player playtime from DB into the in-memory cache. */
  _loadFromDb() {
    if (!this._db) return;
    try {
      const rows = this._db.getAllPlayerPlaytime();
      if (!rows || rows.length === 0) return; // DB empty — fall through to JSON

      // Load peaks from server_peaks table
      const peaksData = this._db.getAllServerPeaks();
      const peaks = {
        allTimePeak: parseInt(peaksData.all_time_peak || '0', 10),
        allTimePeakDate: peaksData.all_time_peak_date || null,
        todayPeak: parseInt(peaksData.today_peak || '0', 10),
        todayDate: peaksData.today_date || this._config.getToday(),
        uniqueToday: this._parseJson(peaksData.unique_today, []),
        uniqueDayPeak: parseInt(peaksData.unique_day_peak || '0', 10),
        uniqueDayPeakDate: peaksData.unique_day_peak_date || null,
        yesterdayUnique: parseInt(peaksData.yesterday_unique || '0', 10),
      };

      this._data = {
        trackingSince: peaksData.tracking_since || new Date().toISOString(),
        players: {},
        peaks,
      };

      for (const row of rows) {
        this._data.players[row.steam_id] = {
          name: row.name || row.steam_id,
          totalMs: (row.playtime_seconds || 0) * 1000,
          sessions: row.session_count || 0,
          firstSeen: row.playtime_first_seen || null,
          lastLogin: row.playtime_last_login || null,
          lastSeen: row.playtime_last_seen || null,
        };
      }
      this._log.info(`Loaded ${rows.length} player(s) from database`);
    } catch (err) {
      this._log.error('DB load failed:', err.message);
      this._data = null;
    }
  }

  /** Persist a single player's playtime to the DB. */
  _persistPlaytime(steamId) {
    if (!this._db || !/^\d{17}$/.test(steamId)) return;
    const record = this._data.players[steamId];
    if (!record) return;
    try {
      this._db.upsertFullPlaytime(steamId, {
        name: record.name || '',
        totalMs: record.totalMs || 0,
        sessions: record.sessions || 0,
        firstSeen: record.firstSeen || null,
        lastLogin: record.lastLogin || null,
        lastSeen: record.lastSeen || null,
      });
    } catch (err) {
      if (!this._persistWarnLogged) {
        this._log.warn('DB persist failed (will suppress further):', err.message);
        this._persistWarnLogged = true;
      }
    }
  }

  /** Persist peak data to the DB. */
  _persistPeaks() {
    if (!this._db || !this._data.peaks) return;
    try {
      const p = this._data.peaks;
      this._db.setServerPeak('all_time_peak', String(p.allTimePeak || 0));
      this._db.setServerPeak('all_time_peak_date', p.allTimePeakDate || '');
      this._db.setServerPeak('today_peak', String(p.todayPeak || 0));
      this._db.setServerPeak('today_date', p.todayDate || '');
      this._db.setServerPeak('unique_today', JSON.stringify(p.uniqueToday || []));
      this._db.setServerPeak('unique_day_peak', String(p.uniqueDayPeak || 0));
      this._db.setServerPeak('unique_day_peak_date', p.uniqueDayPeakDate || '');
      this._db.setServerPeak('yesterday_unique', String(p.yesterdayUnique || 0));
    } catch (_err) {
      // Non-critical
    }
  }

  /** Parse a JSON string safely, returning fallback on failure. */
  _parseJson(str, fallback) {
    if (!str) return fallback;
    try {
      return JSON.parse(str);
    } catch {
      return fallback;
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
          this._log.info(`Merged ghost "${key}" into ${sid} (${record.name})`);
          merged = true;
          break;
        }
      }
      if (!merged) {
        this._log.info(`Removing orphan ghost entry "${key}" (no SteamID match)`);
      }
      toDelete.push(key);
    }
    if (toDelete.length > 0) {
      for (const key of toDelete) delete this._data.players[key];
      // Also clean uniqueToday of any name-based entries
      if (this._data.peaks && Array.isArray(this._data.peaks.uniqueToday)) {
        this._data.peaks.uniqueToday = this._data.peaks.uniqueToday.filter((id) => /^\d{17}$/.test(id));
      }
      this._log.info(`Cleaned ${toDelete.length} ghost entries`);
    }
  }

  /**
   * One-time migration: if uniqueDayPeak is 0, scan the local
   * PlayerConnectedLog.txt to compute the best-unique-day from history.
   */
  _backfillUniqueDayPeak() {
    this._ensurePeaks();
    if (this._data.peaks.uniqueDayPeak > 0) return; // already populated

    const logPath = path.join(this._dataDir, 'logs', 'PlayerConnectedLog.txt');
    if (!fs.existsSync(logPath)) return;

    try {
      const text = fs.readFileSync(logPath, 'utf8');
      const dayMap = new Map(); // 'D/M/YYYY' → Set of steamIds
      // Format: Player Connected Name NetID(76561198000000001_+_|...) (13/2/2026 11:13)
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
          parseInt(parts[2]),
          parseInt(parts[1]) - 1,
          parseInt(parts[0]),
          12,
          0,
          0,
        ).toISOString();
        this._log.info(`Backfilled uniqueDayPeak: ${bestCount} on ${bestDate}`);
      }
    } catch (err) {
      this._log.warn('Could not backfill uniqueDayPeak:', err.message);
    }
  }

  _addPlaytime(id, durationMs, timestamp) {
    if (!this._data.players[id]) return;
    this._data.players[id].totalMs += durationMs;
    this._data.players[id].lastSeen = (timestamp || new Date()).toISOString();
    this._leaderboardCache = null;
    this._persistPlaytime(id);
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

  /**
   * Flush active sessions' accumulated playtime to the DB.
   * Call this periodically (e.g. every 60s) to prevent data loss on crash.
   * Unlike the old _autoSave(), this writes directly to DB — no JSON involved.
   */
  flushActiveSessions() {
    if (!this._data || this._activeSessions.size === 0) return;
    const now = Date.now();
    for (const [id, loginTime] of this._activeSessions) {
      const delta = now - loginTime;
      this._addPlaytime(id, delta);
      this._activeSessions.set(id, now); // reset start so time isn't double-counted
    }
  }
}

// Singleton — shared across the bot
const _singleton = new PlaytimeTracker();
module.exports = _singleton;
module.exports.PlaytimeTracker = PlaytimeTracker;

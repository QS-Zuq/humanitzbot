import fs from 'node:fs';
import path from 'node:path';
import config from '../config/index.js';
import { createLogger, type Logger } from '../utils/log.js';
import { getDirname } from '../utils/paths.js';

type ConfigType = typeof config;

const __dirname = getDirname(import.meta.url);
const DEFAULT_DATA_DIR = path.join(__dirname, '..', '..', 'data');

interface PlayerRecord {
  name: string;
  totalMs: number;
  sessions: number;
  firstSeen: string | null;
  lastLogin: string | null;
  lastSeen: string | null;
}

interface PeaksData {
  allTimePeak: number;
  allTimePeakDate: string | null;
  todayPeak: number;
  todayDate: string;
  uniqueToday: string[];
  uniqueDayPeak: number;
  uniqueDayPeakDate: string | null;
  yesterdayUnique: number;
}

interface TrackerData {
  trackingSince: string;
  players: Record<string, PlayerRecord>;
  peaks: PeaksData;
}

interface PlaytimeResult {
  name: string;
  totalMs: number;
  totalFormatted: string;
  sessions: number;
  isReturning: boolean;
  firstSeen: string | null;
  lastSeen: string | null;
  lastLogin: string | null;
}

interface LeaderboardEntry {
  id: string;
  name: string;
  totalMs: number;
  totalFormatted: string;
  sessions: number;
}

interface PeaksSummary {
  allTimePeak: number;
  allTimePeakDate: string | null;
  todayPeak: number;
  uniqueToday: number;
  uniqueDayPeak: number;
  uniqueDayPeakDate: string | null;
  yesterdayUnique: number;
  totalUniquePlayers: number;
}

export interface PlaytimeTrackerOptions {
  dataDir?: string;
  config?: ConfigType;
  label?: string;
  db?: HumanitZDB | null;
}

// Minimal DB interface (src/db not yet migrated)
interface HumanitZDB {
  getAllPlayerPlaytime(): DbPlaytimeRow[];
  getAllServerPeaks(): DbPeaksRow;
  upsertFullPlaytime(steamId: string, data: UpsertPlaytimeData): void;
  setServerPeak(key: string, value: string): void;
  registerAlias(steamId: string, name: string, source: string): void;
}

interface DbPlaytimeRow {
  steam_id: string;
  name?: string;
  playtime_seconds?: number;
  session_count?: number;
  playtime_first_seen?: string | null;
  playtime_last_login?: string | null;
  playtime_last_seen?: string | null;
}

interface DbPeaksRow {
  all_time_peak?: string;
  all_time_peak_date?: string | null;
  today_peak?: string;
  today_date?: string;
  unique_today?: string;
  unique_day_peak?: string;
  unique_day_peak_date?: string | null;
  yesterday_unique?: string;
  tracking_since?: string;
}

interface UpsertPlaytimeData {
  name: string;
  totalMs: number;
  sessions: number;
  firstSeen: string | null;
  lastLogin: string | null;
  lastSeen: string | null;
}

export class PlaytimeTracker {
  private _data: TrackerData | null = null;
  private _activeSessions: Map<string, number> = new Map(); // id → login timestamp
  private _db: HumanitZDB | null;
  private _dataDir: string;
  private _config: ConfigType;
  private _log: Logger;
  private _leaderboardCache: LeaderboardEntry[] | null = null;
  private _uniqueTodaySet: Set<string> | null = null;
  private _persistWarnLogged: boolean = false;

  /**
   * @param options
   * @param options.dataDir  Custom data directory (for multi-server)
   * @param options.config   Custom config object
   * @param options.label    Log prefix for identification
   */
  constructor(options: PlaytimeTrackerOptions = {}) {
    this._db = options.db ?? null;
    this._dataDir = options.dataDir ?? DEFAULT_DATA_DIR;
    this._config = options.config ?? config;
    this._log = createLogger(options.label, 'PLAYTIME');
  }

  /** Safe accessor for data — guaranteed non-null after init. */
  private _state(): TrackerData {
    if (!this._data) this.init();
    return this._data as TrackerData;
  }

  init(): void {
    if (this._data) return; // already initialised
    this._loadFromDb(); // load from DB
    // _loadFromDb may leave _data null if DB is empty or absent.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- _loadFromDb may leave _data null at runtime
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
    this._log.info(`Tracking since ${this._state().trackingSince}`);
    this._log.info(`${String(Object.keys(this._state().players).length)} player(s) in database`);
  }

  stop(): void {
    // Close all active sessions before stopping
    const now = Date.now();
    for (const [id, loginTime] of this._activeSessions) {
      this._addPlaytime(id, now - loginTime);
    }
    this._activeSessions.clear();
    this._log.info('Stopped.');
  }

  /** Attach a HumanitZDB instance for unified playtime + alias syncing. */
  setDb(db: HumanitZDB): void {
    this._db = db;
    // If init() already ran with no DB (empty data), reload from DB now.
    // This prevents the scenario where empty in-memory data overwrites
    // real DB values on the next _persistPlaytime() call.
    if (this._data) {
      try {
        const rows = db.getAllPlayerPlaytime();
        if (rows.length > 0) {
          let reloaded = 0;
          for (const row of rows) {
            const sid = row.steam_id;
            const dbMs = (row.playtime_seconds ?? 0) * 1000;
            const memMs = this._data.players[sid]?.totalMs ?? 0;
            // Only take DB value if it's higher (never reduce playtime)
            if (dbMs > memMs) {
              this._data.players[sid] = {
                name: row.name || this._data.players[sid]?.name || sid,
                totalMs: dbMs,
                sessions: Math.max(row.session_count ?? 0, this._data.players[sid]?.sessions ?? 0),
                firstSeen: row.playtime_first_seen ?? this._data.players[sid]?.firstSeen ?? null,
                lastLogin: row.playtime_last_login ?? this._data.players[sid]?.lastLogin ?? null,
                lastSeen: row.playtime_last_seen ?? this._data.players[sid]?.lastSeen ?? null,
              };
              reloaded++;
            } else if (!this._data.players[sid] && (row.playtime_seconds ?? 0) > 0) {
              // Player exists in DB but not in memory at all
              this._data.players[sid] = {
                name: row.name || sid,
                totalMs: dbMs,
                sessions: row.session_count ?? 0,
                firstSeen: row.playtime_first_seen ?? null,
                lastLogin: row.playtime_last_login ?? null,
                lastSeen: row.playtime_last_seen ?? null,
              };
              reloaded++;
            }
          }
          if (reloaded > 0) {
            this._log.info(`Reloaded ${String(reloaded)} player(s) from DB after late setDb()`);
            this._leaderboardCache = null;
          }
        }
      } catch (err) {
        this._log.warn('DB reload on setDb() failed:', (err as Error).message);
      }
    }
  }

  playerJoin(id: string, name: string, timestamp?: Date): void {
    // Only accept SteamID keys — reject name-based keys
    if (!/^\d{17}$/.test(id)) return;
    this._ensureInit();
    const st = this._state();

    const now = timestamp ? timestamp.getTime() : Date.now();

    // If already in an active session, flush accumulated time (don't lose it)
    const existingSession = this._activeSessions.get(id);
    if (existingSession !== undefined) {
      this._addPlaytime(id, now - existingSession, timestamp);
    }

    this._activeSessions.set(id, now);

    // Ensure player record exists — use let so we have a typed reference
    let player = st.players[id];
    if (!player) {
      player = {
        name,
        totalMs: 0,
        sessions: 0,
        firstSeen: new Date(now).toISOString(),
        lastLogin: null,
        lastSeen: null,
      };
      st.players[id] = player;
    }

    // Update name (in case it changed) and login time
    player.name = name;
    player.lastLogin = new Date(now).toISOString();
    // Only increment session count for genuinely new sessions (not duplicate joins)
    if (existingSession === undefined) {
      player.sessions += 1;
    }
    this._leaderboardCache = null;
    this._persistPlaytime(id);

    // Register alias in unified identity DB
    if (this._db) {
      try {
        this._db.registerAlias(id, name, 'playtime');
      } catch (_) {
        /* non-critical */
      }
    }

    this._log.info(`${name} (${id}) session started`);
  }

  playerLeave(id: string, timestamp?: Date): void {
    const loginTime = this._activeSessions.get(id);
    if (loginTime !== undefined) {
      const now = timestamp ? timestamp.getTime() : Date.now();
      const duration = now - loginTime;
      this._addPlaytime(id, duration, timestamp);
      this._activeSessions.delete(id);

      const record = this._data?.players[id];
      const name = record ? record.name : id;
      this._log.info(`${name} (${id}) session ended — ${this._formatDuration(duration)}`);
    }
  }

  private _ensureInit(): void {
    if (!this._data) this.init();
  }

  getPlaytime(id: string): PlaytimeResult | null {
    this._ensureInit();
    const record = this._state().players[id];
    if (!record) return null;

    let totalMs = record.totalMs;

    // Add current session time if they're online right now
    const loginTime = this._activeSessions.get(id);
    if (loginTime !== undefined) {
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
  getActiveSessions(): Record<string, number> {
    this._ensureInit();
    const result: Record<string, number> = {};
    for (const [id, loginTime] of this._activeSessions) {
      const record = this._state().players[id];
      const name = record ? record.name : id;
      result[name] = loginTime;
    }
    return result;
  }

  hasHistory(id: string): boolean {
    return !!this._data?.players[id];
  }

  getLeaderboard(): LeaderboardEntry[] {
    this._ensureInit();
    // Return cached result when no active sessions (cache invalidated on mutations)
    if (this._leaderboardCache && this._activeSessions.size === 0) {
      return this._leaderboardCache;
    }
    const entries: LeaderboardEntry[] = [];
    for (const [id, record] of Object.entries(this._state().players)) {
      let totalMs = record.totalMs;
      const loginTime = this._activeSessions.get(id);
      if (loginTime !== undefined) totalMs += Date.now() - loginTime;

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

  getTrackingSince(): string {
    this._ensureInit();
    return this._state().trackingSince;
  }

  recordPlayerCount(count: number): void {
    this._ensureInit();
    this._ensurePeaks();
    const st = this._state();

    const today = this._config.getToday();

    // Day rollover — snapshot yesterday's unique count before resetting
    if (st.peaks.todayDate !== today) {
      this._snapshotYesterdayUnique();
      st.peaks.todayPeak = 0;
      st.peaks.todayDate = today;
      st.peaks.uniqueToday = [];
      this._uniqueTodaySet = new Set();
    }

    // Update peaks
    if (count > st.peaks.allTimePeak) {
      st.peaks.allTimePeak = count;
      st.peaks.allTimePeakDate = new Date().toISOString();
    }
    if (count > st.peaks.todayPeak) {
      st.peaks.todayPeak = count;
    }

    this._persistPeaks();
  }

  recordUniqueToday(id: string): void {
    this._ensureInit();
    this._ensurePeaks();
    const st = this._state();
    const today = this._config.getToday();

    // Day rollover — snapshot yesterday's unique count before resetting
    if (st.peaks.todayDate !== today) {
      this._snapshotYesterdayUnique();
      st.peaks.todayPeak = 0;
      st.peaks.todayDate = today;
      st.peaks.uniqueToday = [];
      this._uniqueTodaySet = new Set();
    }

    if (!id) return;
    // Lazily build the Set from the array (e.g. after a load from disk)
    if (!this._uniqueTodaySet) {
      this._uniqueTodaySet = new Set(st.peaks.uniqueToday);
    }
    if (this._uniqueTodaySet.has(id)) return;
    this._uniqueTodaySet.add(id);
    st.peaks.uniqueToday.push(id);

    // Update unique-day peak (best day by unique player count)
    const uniqueCount = st.peaks.uniqueToday.length;
    if (uniqueCount > st.peaks.uniqueDayPeak) {
      st.peaks.uniqueDayPeak = uniqueCount;
      st.peaks.uniqueDayPeakDate = new Date().toISOString();
    }

    this._persistPeaks();
  }

  getPeaks(): PeaksSummary {
    this._ensureInit();
    const peaks = this._state().peaks;
    return {
      allTimePeak: peaks.allTimePeak,
      allTimePeakDate: peaks.allTimePeakDate,
      todayPeak: peaks.todayPeak,
      uniqueToday: peaks.uniqueToday.length,
      uniqueDayPeak: peaks.uniqueDayPeak,
      uniqueDayPeakDate: peaks.uniqueDayPeakDate,
      yesterdayUnique: peaks.yesterdayUnique,
      totalUniquePlayers: Object.keys(this._state().players).length,
    };
  }

  /**
   * Snapshot yesterday's unique player count before the daily reset.
   * Also updates the unique-day peak if yesterday was a record day.
   */
  private _snapshotYesterdayUnique(): void {
    const st = this._state();
    const uniqueCount = st.peaks.uniqueToday.length;
    st.peaks.yesterdayUnique = uniqueCount;
    if (uniqueCount > st.peaks.uniqueDayPeak) {
      st.peaks.uniqueDayPeak = uniqueCount;
      st.peaks.uniqueDayPeakDate = new Date().toISOString();
    }
  }

  /**
   * Ensure peaks sub-object exists (migration for old data).
   */
  private _ensurePeaks(): void {
    // peaks is always present in TrackerData — this is a no-op migration guard
    // kept for documentation; actual init is in init()
  }

  // ── DB-first helpers ────────────────────────────────────

  /** Load player playtime from DB into the in-memory cache. */
  private _loadFromDb(): void {
    if (!this._db) return;
    try {
      const rows = this._db.getAllPlayerPlaytime();
      if (rows.length === 0) return; // DB empty — fall through to JSON

      // Load peaks from server_peaks table
      const peaksData = this._db.getAllServerPeaks();
      const peaks: PeaksData = {
        allTimePeak: parseInt(peaksData.all_time_peak ?? '0', 10),
        allTimePeakDate: peaksData.all_time_peak_date ?? null,
        todayPeak: parseInt(peaksData.today_peak ?? '0', 10),
        todayDate: peaksData.today_date ?? this._config.getToday(),
        uniqueToday: this._parseJson<string[]>(peaksData.unique_today, []),
        uniqueDayPeak: parseInt(peaksData.unique_day_peak ?? '0', 10),
        uniqueDayPeakDate: peaksData.unique_day_peak_date ?? null,
        yesterdayUnique: parseInt(peaksData.yesterday_unique ?? '0', 10),
      };

      this._data = {
        trackingSince: peaksData.tracking_since ?? new Date().toISOString(),
        players: {},
        peaks,
      };

      for (const row of rows) {
        this._data.players[row.steam_id] = {
          name: row.name || row.steam_id,
          totalMs: (row.playtime_seconds ?? 0) * 1000,
          sessions: row.session_count ?? 0,
          firstSeen: row.playtime_first_seen ?? null,
          lastLogin: row.playtime_last_login ?? null,
          lastSeen: row.playtime_last_seen ?? null,
        };
      }
      this._log.info(`Loaded ${String(rows.length)} player(s) from database`);
    } catch (err) {
      this._log.error('DB load failed:', (err as Error).message);
      this._data = null;
    }
  }

  /** Persist a single player's playtime to the DB. */
  private _persistPlaytime(steamId: string): void {
    if (!this._db || !/^\d{17}$/.test(steamId)) return;
    const record = this._data?.players[steamId];
    if (!record) return;
    try {
      this._db.upsertFullPlaytime(steamId, {
        name: record.name || '',
        totalMs: record.totalMs,
        sessions: record.sessions,
        firstSeen: record.firstSeen,
        lastLogin: record.lastLogin,
        lastSeen: record.lastSeen,
      });
    } catch (err) {
      if (!this._persistWarnLogged) {
        this._log.warn('DB persist failed (will suppress further):', (err as Error).message);
        this._persistWarnLogged = true;
      }
    }
  }

  /** Persist peak data to the DB. */
  private _persistPeaks(): void {
    if (!this._db) return;
    const peaks = this._data?.peaks;
    if (!peaks) return;
    try {
      this._db.setServerPeak('all_time_peak', String(peaks.allTimePeak));
      this._db.setServerPeak('all_time_peak_date', peaks.allTimePeakDate ?? '');
      this._db.setServerPeak('today_peak', String(peaks.todayPeak));
      this._db.setServerPeak('today_date', peaks.todayDate);
      this._db.setServerPeak('unique_today', JSON.stringify(peaks.uniqueToday));
      this._db.setServerPeak('unique_day_peak', String(peaks.uniqueDayPeak));
      this._db.setServerPeak('unique_day_peak_date', peaks.uniqueDayPeakDate ?? '');
      this._db.setServerPeak('yesterday_unique', String(peaks.yesterdayUnique));
    } catch (_err) {
      // Non-critical
    }
  }

  /** Parse a JSON string safely, returning fallback on failure. */
  private _parseJson<T>(str: string | null | undefined, fallback: T): T {
    if (!str) return fallback;
    try {
      return JSON.parse(str) as T;
    } catch {
      return fallback;
    }
  }

  // ── Private ────────────────────────────────────────────────

  private _cleanGhostEntries(): void {
    const st = this._state();
    const toDelete: string[] = [];
    for (const key of Object.keys(st.players)) {
      if (/^\d{17}$/.test(key)) continue; // valid SteamID — keep

      // Try to find a SteamID entry with the same name
      const ghost = st.players[key] as PlayerRecord;
      let merged = false;
      for (const [sid, record] of Object.entries(st.players)) {
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
      for (const key of toDelete) {
        Reflect.deleteProperty(st.players, key);
      }
      // Also clean uniqueToday of any name-based entries
      st.peaks.uniqueToday = st.peaks.uniqueToday.filter((id) => /^\d{17}$/.test(id));
      this._log.info(`Cleaned ${String(toDelete.length)} ghost entries`);
    }
  }

  /**
   * One-time migration: if uniqueDayPeak is 0, scan the local
   * PlayerConnectedLog.txt to compute the best-unique-day from history.
   */
  private _backfillUniqueDayPeak(): void {
    this._ensurePeaks();
    const st = this._state();
    if (st.peaks.uniqueDayPeak > 0) return; // already populated

    const logPath = path.join(this._dataDir, 'logs', 'PlayerConnectedLog.txt');
    if (!fs.existsSync(logPath)) return;

    try {
      const text = fs.readFileSync(logPath, 'utf8');
      const dayMap = new Map<string, Set<string>>(); // 'D/M/YYYY' → Set of steamIds
      // Format: Player Connected Name NetID(76561198000000001_+_|...) (13/2/2026 11:13)
      const RE = /Player Connected .+ NetID\((\d{17})_\+_\|[^)]+\) \((\d{1,2}\/\d{1,2}\/\d{4}) /;

      for (const line of text.split('\n')) {
        const m = line.match(RE);
        if (!m) continue;
        const steamId = m[1] as string;
        const dateStr = m[2] as string;
        if (!dayMap.has(dateStr)) dayMap.set(dateStr, new Set());
        (dayMap.get(dateStr) as Set<string>).add(steamId);
      }

      let bestCount = 0;
      let bestDate: string | null = null;
      for (const [dateStr, ids] of dayMap) {
        if (ids.size > bestCount) {
          bestCount = ids.size;
          bestDate = dateStr;
        }
      }

      if (bestCount > 0 && bestDate) {
        st.peaks.uniqueDayPeak = bestCount;
        // Parse D/M/YYYY → ISO date
        const parts = bestDate.split('/');
        st.peaks.uniqueDayPeakDate = new Date(
          parseInt(parts[2] as string),
          parseInt(parts[1] as string) - 1,
          parseInt(parts[0] as string),
          12,
          0,
          0,
        ).toISOString();
        this._log.info(`Backfilled uniqueDayPeak: ${String(bestCount)} on ${bestDate}`);
      }
    } catch (err) {
      this._log.warn('Could not backfill uniqueDayPeak:', (err as Error).message);
    }
  }

  private _addPlaytime(id: string, durationMs: number, timestamp?: Date): void {
    const record = this._data?.players[id];
    if (!record) return;
    record.totalMs += durationMs;
    record.lastSeen = (timestamp ?? new Date()).toISOString();
    this._leaderboardCache = null;
    this._persistPlaytime(id);
  }

  private _formatDuration(ms: number): string {
    if (ms < 1000) return '0m';
    const totalSeconds = Math.floor(ms / 1000);
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);

    const parts: string[] = [];
    if (days > 0) parts.push(`${String(days)} Day${days !== 1 ? 's' : ''}`);
    if (hours > 0) parts.push(`${String(hours)} Hour${hours !== 1 ? 's' : ''}`);
    if (minutes > 0 || parts.length === 0) parts.push(`${String(minutes)} Minute${minutes !== 1 ? 's' : ''}`);
    return parts.join(', ');
  }

  /**
   * Flush active sessions' accumulated playtime to the DB.
   * Call this periodically (e.g. every 60s) to prevent data loss on crash.
   * Unlike the old _autoSave(), this writes directly to DB — no JSON involved.
   */
  flushActiveSessions(): void {
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
export default _singleton;

// CJS compat — consumed by non-migrated .js modules via require()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _mod = module as { exports: any };
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
_mod.exports = _singleton;
_mod.exports.PlaytimeTracker = PlaytimeTracker;
/* eslint-enable @typescript-eslint/no-unsafe-member-access */

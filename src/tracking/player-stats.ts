import fs from 'node:fs';
import path from 'node:path';
import playtimeSingleton from './playtime-tracker.js';
import type { PlaytimeTracker } from './playtime-tracker.js';
import { classifyDamageLabel } from './damage-classifier.js';
import type { HumanitZDB } from '../db/database.js';
import { createLogger, type Logger } from '../utils/log.js';
import { getDirname } from '../utils/paths.js';
import { errMsg } from '../utils/error.js';

type PlaytimeTrackerType = InstanceType<typeof PlaytimeTracker>;

const __dirname = getDirname(import.meta.url);
const DEFAULT_DATA_DIR = path.join(__dirname, '..', '..', 'data');

export interface NameHistoryEntry {
  name: string;
  until: string;
}

export interface CheatFlag {
  type: string;
  timestamp: string;
}

export interface PlayerRecord {
  name: string;
  nameHistory: NameHistoryEntry[];
  deaths: number;
  builds: number;
  buildItems: Record<string, number>;
  raidsOut: number;
  raidsIn: number;
  destroyedOut: number;
  destroyedIn: number;
  containersLooted: number;
  damageTaken: Record<string, number>;
  killedBy: Record<string, number>;
  pvpKills: number;
  pvpDeaths: number;
  connects: number;
  disconnects: number;
  adminAccess: number;
  cheatFlags: CheatFlag[];
  lastEvent: string | null;
}

export interface PlayerStatEntry extends PlayerRecord {
  id: string;
}

interface TrackerData {
  players: Record<string, PlayerRecord>;
}

interface DbLogStatRow {
  steam_id: string;
  name?: string;
  log_deaths?: number;
  log_builds?: number;
  log_build_items?: string;
  log_raids_out?: number;
  log_raids_in?: number;
  log_destroyed_out?: number;
  log_destroyed_in?: number;
  log_loots?: number;
  log_damage_detail?: string;
  log_damage_taken?: number;
  log_killed_by?: string;
  log_pvp_kills?: number;
  log_pvp_deaths?: number;
  log_connects?: number;
  log_disconnects?: number;
  log_admin_access?: number;
  log_cheat_flags?: string;
  log_last_event?: string | null;
}

interface IdMapEntry {
  steamId: string;
  name: string;
}

export interface PlayerStatsOptions {
  dataDir?: string;
  playtime?: PlaytimeTrackerType | null;
  label?: string;
  db?: HumanitZDB | null;
}

export class PlayerStats {
  private _data: TrackerData | null = null;
  private _idMap: Map<string, string> | null = null; // Map<lowerName, steamId> from PlayerIDMapped.txt
  private _nameIndex: Map<string, string> = new Map(); // lowerName → id for O(1) lookups
  private _db: HumanitZDB | null;
  private _dataDir: string;
  private _playtime: PlaytimeTrackerType;
  private _log: Logger;
  private _persistWarnLogged: boolean = false;

  /**
   * @param options
   * @param options.dataDir    Custom data directory (for multi-server)
   * @param options.playtime   Custom PlaytimeTracker instance
   * @param options.label      Log prefix for identification
   */
  constructor(options: PlayerStatsOptions = {}) {
    this._db = options.db ?? null;
    this._dataDir = options.dataDir ?? DEFAULT_DATA_DIR;
    this._playtime = options.playtime ?? playtimeSingleton;
    this._log = createLogger(options.label, 'PLAYER STATS');
  }

  init(): void {
    if (this._data) return; // already initialised
    this._loadFromDb(); // load from DB
    if (!(this._data as TrackerData | null)) this._data = { players: {} }; // empty if DB has nothing yet
    this._buildNameIndex();
    this._loadLocalIdMap(); // seed name→SteamID from cached PlayerIDMapped.txt
    const count = Object.keys(this._players()).length;
    this._log.info(`Loaded ${String(count)} player(s) from database`);
  }

  stop(): void {
    this._log.info('Stopped.');
  }

  /** Attach a HumanitZDB instance for unified alias registration. */
  setDb(db: HumanitZDB): void {
    this._db = db;
  }

  /** @internal Wire in a custom PlaytimeTracker (used by multi-server setup). */
  setPlaytime(tracker: PlaytimeTrackerType): void {
    this._playtime = tracker;
  }

  private _ensureInit(): void {
    if (!this._data) this.init();
  }

  /** Safe accessor for players map — guaranteed non-null after init. */
  private _players(): Record<string, PlayerRecord> {
    if (!this._data) this.init();
    return (this._data as TrackerData).players;
  }

  loadIdMap(entries: IdMapEntry[]): void {
    this._idMap = new Map();
    for (const { steamId, name } of entries) {
      this._idMap.set(name.toLowerCase(), steamId);

      // Detect and log name changes for known players
      const record = this._data?.players[steamId];
      if (record) {
        if (record.name !== name && record.name.toLowerCase() !== name.toLowerCase()) {
          const alreadyLogged = record.nameHistory.some((h) => h.name.toLowerCase() === record.name.toLowerCase());
          if (!alreadyLogged) {
            record.nameHistory.push({ name: record.name, until: new Date().toISOString() });
            this._log.info(`Name change detected via ID map: "${record.name}" → "${name}" (${steamId})`);
          }
          record.name = name;
        }
      }
    }

    // Bulk-register in unified identity DB
    if (this._db) {
      try {
        this._db.player.importIdMap(entries);
      } catch (_) {
        /* non-critical */
      }
    }
  }

  private _loadLocalIdMap(): void {
    try {
      const filePath = path.join(this._dataDir, 'PlayerIDMapped.txt');
      if (!fs.existsSync(filePath)) return;
      const raw = fs.readFileSync(filePath, 'utf8');
      const entries: IdMapEntry[] = [];
      for (const line of raw.split(/\r?\n/)) {
        const m = line.trim().match(/^(\d{17})_\+_\|[^@]+@(.+)$/);
        if (m) entries.push({ steamId: m[1] as string, name: m[2] as string });
      }
      if (entries.length) {
        this.loadIdMap(entries);
        this._log.info(`Loaded ${String(entries.length)} name(s) from cached PlayerIDMapped.txt`);
      }
    } catch (err) {
      this._log.error('Failed to load cached ID map:', errMsg(err));
    }
  }

  // ─── DB-first helpers ────────────────────────────────────

  /** Load player log stats from DB into the in-memory cache. */
  private _loadFromDb(): void {
    if (!this._db) return;
    try {
      const rows = this._db.player.getAllPlayerLogStats() as unknown as DbLogStatRow[]; // SAFETY: DB row shape validated by schema
      if (rows.length === 0) return; // DB empty — fall through to JSON
      this._data = { players: {} };
      for (const row of rows) {
        const damageTaken = this._parseJson<Record<string, number>>(row.log_damage_detail, {});
        const damageTakenTotal = Object.values(damageTaken).reduce((a, b) => a + b, 0);
        // Sanity check: if DB has aggregate but no detail, use aggregate
        const dtTotal = damageTakenTotal || row.log_damage_taken || 0;
        // Keep dtTotal consistent (unused but guard against old aggregate-only data)
        void dtTotal;
        this._data.players[row.steam_id] = {
          name: row.name || row.steam_id,
          nameHistory: [],
          deaths: row.log_deaths ?? 0,
          builds: row.log_builds ?? 0,
          buildItems: this._parseJson<Record<string, number>>(row.log_build_items, {}),
          raidsOut: row.log_raids_out ?? 0,
          raidsIn: row.log_raids_in ?? 0,
          destroyedOut: row.log_destroyed_out ?? 0,
          destroyedIn: row.log_destroyed_in ?? 0,
          containersLooted: row.log_loots ?? 0,
          damageTaken,
          killedBy: this._parseJson<Record<string, number>>(row.log_killed_by, {}),
          pvpKills: row.log_pvp_kills ?? 0,
          pvpDeaths: row.log_pvp_deaths ?? 0,
          connects: row.log_connects ?? 0,
          disconnects: row.log_disconnects ?? 0,
          adminAccess: row.log_admin_access ?? 0,
          cheatFlags: this._parseJson<CheatFlag[]>(row.log_cheat_flags, []),
          lastEvent: row.log_last_event ?? null,
        };
      }
      this._log.info(`Loaded ${String(rows.length)} player(s) from database`);
    } catch (err) {
      this._log.warn('DB load failed, falling back to JSON:', errMsg(err));
      this._data = null; // ensure fallback triggers
    }
  }

  /** Find the key (steamId or name:X) for a given record in _data.players. */
  private _getKeyForRecord(record: PlayerRecord): string | null {
    for (const [key, rec] of Object.entries(this._players())) {
      if (rec === record) return key;
    }
    return null;
  }

  /** Persist a single player record to the DB (called after every mutation). */
  private _persistRecord(key: string | null, record: PlayerRecord): void {
    if (!this._db || !key || key.startsWith('name:') || !/^\d{17}$/.test(key)) return;
    try {
      this._db.player.upsertFullLogStats(key, {
        name: record.name || '',
        deaths: record.deaths,
        pvpKills: record.pvpKills,
        pvpDeaths: record.pvpDeaths,
        builds: record.builds,
        containersLooted: record.containersLooted,
        damageTakenTotal: Object.values(record.damageTaken).reduce((a, b) => a + b, 0),
        raidsOut: record.raidsOut,
        raidsIn: record.raidsIn,
        connects: record.connects,
        disconnects: record.disconnects,
        adminAccess: record.adminAccess,
        destroyedOut: record.destroyedOut,
        destroyedIn: record.destroyedIn,
        buildItems: record.buildItems,
        killedBy: record.killedBy,
        damageTaken: record.damageTaken,
        cheatFlags: record.cheatFlags,
        lastEvent: record.lastEvent,
      });
    } catch (err) {
      // Non-critical: in-memory cache is still correct
      if (!this._persistWarnLogged) {
        this._log.warn('DB persist failed (will suppress further):', errMsg(err));
        this._persistWarnLogged = true;
      }
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

  // ─── Recording methods (called by LogWatcher) ────────────

  recordDeath(playerName: string, timestamp: Date | null, cause: string | null): void {
    this._ensureInit();
    const record = this._getOrCreateByName(playerName);
    record.deaths++;
    if (cause) {
      record.killedBy[cause] = (record.killedBy[cause] ?? 0) + 1;
    }
    record.lastEvent = (timestamp ?? new Date()).toISOString();
    this._persistRecord(this._getKeyForRecord(record), record);
  }

  recordPvpKill(killerName: string, victimName: string, timestamp: Date | null): void {
    this._ensureInit();
    const ts = (timestamp ?? new Date()).toISOString();

    const killer = this._getOrCreateByName(killerName);
    killer.pvpKills++;
    killer.lastEvent = ts;

    const victim = this._getOrCreateByName(victimName);
    victim.pvpDeaths++;
    victim.lastEvent = ts;

    this._persistRecord(this._getKeyForRecord(killer), killer);
    this._persistRecord(this._getKeyForRecord(victim), victim);
  }

  recordBuild(playerName: string, steamId: string, itemName: string, timestamp: Date | null): void {
    this._ensureInit();
    const record = this._getOrCreate(steamId, playerName);
    record.builds++;
    record.buildItems[itemName] = (record.buildItems[itemName] ?? 0) + 1;
    record.lastEvent = (timestamp ?? new Date()).toISOString();
    this._persistRecord(steamId, record);
  }

  recordRaid(
    attackerName: string,
    attackerSteamId: string | null,
    ownerSteamId: string,
    destroyed: boolean,
    timestamp: Date | null,
  ): void {
    this._ensureInit();
    const ts = (timestamp ?? new Date()).toISOString();
    // Attacker stats
    if (attackerSteamId) {
      const attacker = this._getOrCreate(attackerSteamId, attackerName);
      attacker.raidsOut++;
      if (destroyed) attacker.destroyedOut++;
      attacker.lastEvent = ts;
      this._persistRecord(attackerSteamId, attacker);
    }
    // Owner/victim stats
    const owner = this._getById(ownerSteamId);
    if (owner) {
      owner.raidsIn++;
      if (destroyed) owner.destroyedIn++;
      owner.lastEvent = ts;
      this._persistRecord(ownerSteamId, owner);
    }
  }

  recordLoot(playerName: string, steamId: string, ownerSteamId: string, timestamp: Date | null): void {
    this._ensureInit();
    // Only count looting others' containers
    if (steamId === ownerSteamId) return;
    const record = this._getOrCreate(steamId, playerName);
    record.containersLooted++;
    record.lastEvent = (timestamp ?? new Date()).toISOString();
    this._persistRecord(steamId, record);
  }

  recordDamageTaken(playerName: string, source: string, timestamp: Date | null): void {
    this._ensureInit();
    const record = this._getOrCreateByName(playerName);
    const cleanSource = this._classifyDamageSource(source);
    record.damageTaken[cleanSource] = (record.damageTaken[cleanSource] ?? 0) + 1;
    record.lastEvent = (timestamp ?? new Date()).toISOString();
    this._persistRecord(this._getKeyForRecord(record), record);
  }

  recordConnect(playerName: string, steamId: string, timestamp: Date | null): void {
    this._ensureInit();
    const record = this._getOrCreate(steamId, playerName);
    record.connects++;
    record.lastEvent = (timestamp ?? new Date()).toISOString();
    this._persistRecord(steamId, record);
  }

  recordDisconnect(playerName: string, steamId: string, timestamp: Date | null): void {
    this._ensureInit();
    const record = this._getOrCreate(steamId, playerName);
    record.disconnects++;
    record.lastEvent = (timestamp ?? new Date()).toISOString();
    this._persistRecord(steamId, record);
  }

  recordAdminAccess(playerName: string, timestamp: Date | null): void {
    this._ensureInit();
    const record = this._getOrCreateByName(playerName);
    record.adminAccess++;
    record.lastEvent = (timestamp ?? new Date()).toISOString();
    this._persistRecord(this._getKeyForRecord(record), record);
  }

  recordCheatFlag(playerName: string, steamId: string, type: string, timestamp: Date | null): void {
    this._ensureInit();
    const record = this._getOrCreate(steamId, playerName);
    record.cheatFlags.push({
      type,
      timestamp: (timestamp ?? new Date()).toISOString(),
    });
    record.lastEvent = (timestamp ?? new Date()).toISOString();
    this._persistRecord(steamId, record);
  }

  // ─── Query methods ───────────────────────────────────────

  getStats(steamId: string): PlayerStatEntry | null {
    this._ensureInit();
    const record = this._players()[steamId];
    if (!record) return null;
    return { id: steamId, ...record };
  }

  getStatsByName(name: string): PlayerStatEntry | null {
    this._ensureInit();
    const lower = name.toLowerCase();
    const players = this._players();

    // O(1) exact match via name index (covers current + historical names)
    const exactId = this._nameIndex.get(lower);
    if (exactId) {
      const rec = players[exactId];
      if (rec) return { id: exactId, ...rec };
    }

    // Fallback: partial match by current name
    for (const [id, record] of Object.entries(players)) {
      if (record.name.toLowerCase().includes(lower)) return { id, ...record };
    }
    // Fallback: partial match by name history
    for (const [id, record] of Object.entries(players)) {
      if (record.nameHistory.some((h) => h.name.toLowerCase().includes(lower))) {
        return { id, ...record };
      }
    }
    return null;
  }

  getNameForId(steamId: string): string {
    // 1. Known player in stats DB
    const record = this._data?.players[steamId];
    if (record?.name && !record.name.startsWith('name:') && !/^\d{17}$/.test(record.name)) {
      return record.name;
    }
    // 2. Reverse lookup from ID map
    if (this._idMap) {
      for (const [nameLower, id] of this._idMap) {
        if (id === steamId) return nameLower.charAt(0).toUpperCase() + nameLower.slice(1); // rough title-case
      }
    }
    // 3. Playtime tracker
    try {
      const pt = this._playtime.getPlaytime(steamId);
      if (pt?.name && !/^\d{17}$/.test(pt.name)) return pt.name;
    } catch (_) {
      /* non-critical */
    }
    // 4. Unified identity DB
    if (this._db) {
      try {
        const name = this._db.player.resolveSteamIdToName(steamId);
        if (name && name !== steamId) return name;
      } catch (_) {
        /* non-critical */
      }
    }
    return steamId;
  }

  getIdMap(): Map<string, string> | null {
    return this._idMap;
  }

  /** Look up a SteamID64 by player name (case-insensitive). */
  getSteamId(name: string): string | null {
    if (!this._idMap || !name) return null;
    return this._idMap.get(name.toLowerCase()) ?? null;
  }

  getAllPlayers(): PlayerStatEntry[] {
    this._ensureInit();
    const entries: PlayerStatEntry[] = [];
    for (const [id, record] of Object.entries(this._players())) {
      entries.push({ id, ...record });
    }
    // Sort by total activity descending
    entries.sort((a, b) => {
      const actA = a.deaths + a.builds + a.raidsOut + a.containersLooted;
      const actB = b.deaths + b.builds + b.raidsOut + b.containersLooted;
      return actB - actA;
    });
    return entries;
  }

  // ─── Internal ─────────────────────────────────────────────

  private _getOrCreate(steamId: string, name: string): PlayerRecord {
    const players = this._players();
    if (!players[steamId]) {
      players[steamId] = this._newRecord(name);
      this._nameIndex.set(name.toLowerCase(), steamId);

      // Check if there's an orphaned name: record to merge in
      const nameLower = name.toLowerCase();
      for (const key of Object.keys(players)) {
        if (!key.startsWith('name:')) continue;
        const rec = players[key];
        if (rec && rec.name.toLowerCase() === nameLower) {
          this._mergeInto(steamId, key);
          break;
        }
      }
    } else {
      // Track name changes in history
      // players[steamId] is guaranteed non-null here (we're in the else of !players[steamId])
      const record = players[steamId];
      if (record.name !== name && record.name.toLowerCase() !== name.toLowerCase()) {
        const alreadyLogged = record.nameHistory.some((h) => h.name.toLowerCase() === record.name.toLowerCase());
        if (!alreadyLogged) {
          record.nameHistory.push({ name: record.name, until: new Date().toISOString() });
          this._log.info(`Name change detected: "${record.name}" → "${name}" (${steamId})`);
        }
      }
      // Update to current name
      record.name = name;
      this._nameIndex.set(name.toLowerCase(), steamId);
    }

    // Register in unified identity DB
    if (this._db) {
      try {
        this._db.player.registerAlias(steamId, name, 'log');
      } catch (_) {
        /* non-critical */
      }
    }

    // players[steamId] is always set above (either branch)
    return players[steamId];
  }

  private _getById(steamId: string): PlayerRecord | null {
    return this._players()[steamId] ?? null;
  }

  private _getOrCreateByName(name: string): PlayerRecord {
    const nameLower = name.toLowerCase();
    const players = this._players();

    // 0. Check the authoritative ID map (from PlayerIDMapped.txt)
    if (this._idMap) {
      const steamId = this._idMap.get(nameLower);
      if (steamId) {
        return this._getOrCreate(steamId, name);
      }
    }

    // 1. O(1) lookup via name index
    const indexedId = this._nameIndex.get(nameLower);
    const indexedRecord = indexedId ? players[indexedId] : undefined;
    if (indexedId && indexedRecord) {
      if (indexedId.startsWith('name:')) {
        const steamId = this._resolveNameToSteamId(nameLower);
        const steamRecord = steamId ? players[steamId] : undefined;
        if (steamId && steamRecord) {
          this._mergeInto(steamId, indexedId);
          return steamRecord;
        }
      }
      return indexedRecord;
    }

    // 2. Search name history (old names) across all records
    for (const [id, record] of Object.entries(players)) {
      if (id.startsWith('name:')) continue;
      if (record.nameHistory.some((h) => h.name.toLowerCase() === nameLower)) {
        return record;
      }
    }

    // 3. Cross-reference playtime tracker to resolve name → SteamID
    const steamId = this._resolveNameToSteamId(nameLower);
    if (steamId) {
      return this._getOrCreate(steamId, name);
    }

    // 4. Cross-reference unified identity DB
    if (this._db) {
      try {
        const resolved = this._db.player.resolveNameToSteamId(name);
        if (resolved && /^\d{17}$/.test(String(resolved.steamId))) {
          return this._getOrCreate(String(resolved.steamId), name);
        }
      } catch (_) {
        /* non-critical */
      }
    }

    // 5. Fallback: create with name as key
    const nameKey = `name:${name}`;
    if (!players[nameKey]) {
      players[nameKey] = this._newRecord(name);
    }
    this._nameIndex.set(nameLower, nameKey);
    return players[nameKey];
  }

  private _resolveNameToSteamId(nameLower: string): string | null {
    try {
      const leaderboard = this._playtime.getLeaderboard();
      for (const entry of leaderboard) {
        if (entry.name.toLowerCase() === nameLower && !entry.id.startsWith('name:')) {
          return entry.id;
        }
      }
    } catch (_) {
      // Playtime tracker may not be initialized yet
    }
    return null;
  }

  private _mergeInto(steamId: string, nameKey: string): void {
    const players = this._players();
    const source = players[nameKey];
    const target = players[steamId];
    if (!source || !target) return;

    target.deaths += source.deaths;
    target.builds += source.builds;
    for (const [item, count] of Object.entries(source.buildItems)) {
      target.buildItems[item] = (target.buildItems[item] ?? 0) + count;
    }
    target.raidsOut += source.raidsOut;
    target.raidsIn += source.raidsIn;
    target.destroyedOut += source.destroyedOut;
    target.destroyedIn += source.destroyedIn;
    target.containersLooted += source.containersLooted;
    target.connects += source.connects;
    target.disconnects += source.disconnects;
    target.adminAccess += source.adminAccess;
    target.pvpKills += source.pvpKills;
    target.pvpDeaths += source.pvpDeaths;
    if (source.cheatFlags.length > 0) {
      target.cheatFlags.push(...source.cheatFlags);
    }
    if (source.nameHistory.length > 0) {
      target.nameHistory.push(...source.nameHistory);
    }
    for (const [src, count] of Object.entries(source.damageTaken)) {
      target.damageTaken[src] = (target.damageTaken[src] ?? 0) + count;
    }

    // Keep the more recent lastEvent
    if (source.lastEvent && (!target.lastEvent || source.lastEvent > target.lastEvent)) {
      target.lastEvent = source.lastEvent;
    }

    Reflect.deleteProperty(players, nameKey);
    this._log.info(`Merged name-keyed record "${source.name}" into SteamID ${steamId}`);
  }

  private _buildNameIndex(): void {
    this._nameIndex = new Map();
    for (const [id, record] of Object.entries(this._players())) {
      this._nameIndex.set(record.name.toLowerCase(), id);
      for (const h of record.nameHistory) {
        // Don't overwrite current-name entries with historical ones
        if (!this._nameIndex.has(h.name.toLowerCase())) {
          this._nameIndex.set(h.name.toLowerCase(), id);
        }
      }
    }
  }

  private _newRecord(name: string): PlayerRecord {
    return {
      name,
      nameHistory: [],
      deaths: 0,
      builds: 0,
      buildItems: {},
      raidsOut: 0,
      raidsIn: 0,
      destroyedOut: 0,
      destroyedIn: 0,
      containersLooted: 0,
      damageTaken: {},
      killedBy: {},
      pvpKills: 0,
      pvpDeaths: 0,
      connects: 0,
      disconnects: 0,
      adminAccess: 0,
      cheatFlags: [],
      lastEvent: null,
    };
  }

  private _classifyDamageSource(source: string): string {
    return classifyDamageLabel(source);
  }
}

const _singleton = new PlayerStats();
export default _singleton;

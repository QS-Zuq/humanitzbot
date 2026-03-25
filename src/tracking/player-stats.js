const fs = require('fs');
const path = require('path');
const _defaultPlaytime = require('./playtime-tracker');
const { classifyDamageLabel } = require('./damage-classifier');
const { createLogger } = require('../utils/log');

const DEFAULT_DATA_DIR = path.join(__dirname, '..', '..', 'data');

class PlayerStats {
  /**
   * @param {object} [options]
   * @param {string} [options.dataDir]    Custom data directory (for multi-server)
   * @param {object} [options.playtime]   Custom PlaytimeTracker instance
   * @param {string} [options.label]      Log prefix for identification
   */
  constructor(options = {}) {
    this._data = null;
    this._idMap = null; // Map<lowerName, steamId> from PlayerIDMapped.txt
    this._nameIndex = new Map(); // lowerName → id for O(1) lookups
    this._db = options.db || null; // optional HumanitZDB for alias registration
    // Per-instance overrides (for multi-server support)
    this._dataDir = options.dataDir || DEFAULT_DATA_DIR;
    this._playtime = options.playtime || _defaultPlaytime;
    this._log = createLogger(options.label, 'PLAYER STATS');
  }

  init() {
    if (this._data) return; // already initialised
    this._loadFromDb(); // load from DB
    if (!this._data) this._data = { players: {} }; // empty if DB has nothing yet
    this._buildNameIndex();
    this._loadLocalIdMap(); // seed name→SteamID from cached PlayerIDMapped.txt
    const count = Object.keys(this._data.players).length;
    this._log.info(`Loaded ${count} player(s) from database`);
  }

  stop() {
    this._log.info('Stopped.');
  }

  /** Attach a HumanitZDB instance for unified alias registration. */
  setDb(db) {
    this._db = db;
  }

  _ensureInit() {
    if (!this._data) this.init();
  }

  loadIdMap(entries) {
    this._idMap = new Map();
    for (const { steamId, name } of entries) {
      this._idMap.set(name.toLowerCase(), steamId);

      // Detect and log name changes for known players
      if (this._data && this._data.players[steamId]) {
        const record = this._data.players[steamId];
        if (record.name !== name && record.name.toLowerCase() !== name.toLowerCase()) {
          if (!record.nameHistory) record.nameHistory = [];
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
        this._db.importIdMap(entries);
      } catch (_) {
        /* non-critical */
      }
    }
  }

  _loadLocalIdMap() {
    try {
      const filePath = path.join(this._dataDir, 'PlayerIDMapped.txt');
      if (!fs.existsSync(filePath)) return;
      const raw = fs.readFileSync(filePath, 'utf8');
      const entries = [];
      for (const line of raw.split(/\r?\n/)) {
        const m = line.trim().match(/^(\d{17})_\+_\|[^@]+@(.+)$/);
        if (m) entries.push({ steamId: m[1], name: m[2] });
      }
      if (entries.length) {
        this.loadIdMap(entries);
        this._log.info(`Loaded ${entries.length} name(s) from cached PlayerIDMapped.txt`);
      }
    } catch (err) {
      this._log.error('Failed to load cached ID map:', err.message);
    }
  }

  // ─── DB-first helpers ────────────────────────────────────

  /** Load player log stats from DB into the in-memory cache. */
  _loadFromDb() {
    if (!this._db) return;
    try {
      const rows = this._db.getAllPlayerLogStats();
      if (!rows || rows.length === 0) return; // DB empty — fall through to JSON
      this._data = { players: {} };
      for (const row of rows) {
        const damageTaken = this._parseJson(row.log_damage_detail, {});
        const damageTakenTotal = Object.values(damageTaken).reduce((a, b) => a + b, 0);
        // Sanity check: if DB has aggregate but no detail, use aggregate
        const dtTotal = damageTakenTotal || row.log_damage_taken || 0;
        this._data.players[row.steam_id] = {
          name: row.name || row.steam_id,
          nameHistory: [],
          deaths: row.log_deaths || 0,
          builds: row.log_builds || 0,
          buildItems: this._parseJson(row.log_build_items, {}),
          raidsOut: row.log_raids_out || 0,
          raidsIn: row.log_raids_in || 0,
          destroyedOut: row.log_destroyed_out || 0,
          destroyedIn: row.log_destroyed_in || 0,
          containersLooted: row.log_loots || 0,
          damageTaken,
          killedBy: this._parseJson(row.log_killed_by, {}),
          pvpKills: row.log_pvp_kills || 0,
          pvpDeaths: row.log_pvp_deaths || 0,
          connects: row.log_connects || 0,
          disconnects: row.log_disconnects || 0,
          adminAccess: row.log_admin_access || 0,
          cheatFlags: this._parseJson(row.log_cheat_flags, []),
          lastEvent: row.log_last_event || null,
        };
        // Keep dtTotal consistent (unused but guard against old aggregate-only data)
        void dtTotal;
      }
      this._log.info(`Loaded ${rows.length} player(s) from database`);
    } catch (err) {
      this._log.warn('DB load failed, falling back to JSON:', err.message);
      this._data = null; // ensure fallback triggers
    }
  }

  /** Find the key (steamId or name:X) for a given record in _data.players. */
  _getKeyForRecord(record) {
    for (const [key, rec] of Object.entries(this._data.players)) {
      if (rec === record) return key;
    }
    return null;
  }

  /** Persist a single player record to the DB (called after every mutation). */
  _persistRecord(key, record) {
    if (!this._db || !key || key.startsWith('name:') || !/^\d{17}$/.test(key)) return;
    try {
      this._db.upsertFullLogStats(key, {
        name: record.name || '',
        deaths: record.deaths || 0,
        pvpKills: record.pvpKills || 0,
        pvpDeaths: record.pvpDeaths || 0,
        builds: record.builds || 0,
        containersLooted: record.containersLooted || 0,
        damageTakenTotal: Object.values(record.damageTaken || {}).reduce((a, b) => a + b, 0),
        raidsOut: record.raidsOut || 0,
        raidsIn: record.raidsIn || 0,
        connects: record.connects || 0,
        disconnects: record.disconnects || 0,
        adminAccess: record.adminAccess || 0,
        destroyedOut: record.destroyedOut || 0,
        destroyedIn: record.destroyedIn || 0,
        buildItems: record.buildItems || {},
        killedBy: record.killedBy || {},
        damageTaken: record.damageTaken || {},
        cheatFlags: record.cheatFlags || [],
        lastEvent: record.lastEvent || null,
      });
    } catch (err) {
      // Non-critical: in-memory cache is still correct
      if (!this._persistWarnLogged) {
        this._log.warn('DB persist failed (will suppress further):', err.message);
        this._persistWarnLogged = true;
      }
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

  // ─── Recording methods (called by LogWatcher) ────────────

  recordDeath(playerName, timestamp, cause) {
    this._ensureInit();
    const record = this._getOrCreateByName(playerName);
    record.deaths++;
    if (cause) {
      if (!record.killedBy) record.killedBy = {};
      record.killedBy[cause] = (record.killedBy[cause] || 0) + 1;
    }
    record.lastEvent = (timestamp || new Date()).toISOString();
    this._persistRecord(this._getKeyForRecord(record), record);
  }

  recordPvpKill(killerName, victimName, timestamp) {
    this._ensureInit();
    const ts = (timestamp || new Date()).toISOString();

    const killer = this._getOrCreateByName(killerName);
    if (!killer.pvpKills) killer.pvpKills = 0;
    killer.pvpKills++;
    killer.lastEvent = ts;

    const victim = this._getOrCreateByName(victimName);
    if (!victim.pvpDeaths) victim.pvpDeaths = 0;
    victim.pvpDeaths++;
    victim.lastEvent = ts;

    this._persistRecord(this._getKeyForRecord(killer), killer);
    this._persistRecord(this._getKeyForRecord(victim), victim);
  }

  recordBuild(playerName, steamId, itemName, timestamp) {
    this._ensureInit();
    const record = this._getOrCreate(steamId, playerName);
    record.builds++;
    record.buildItems[itemName] = (record.buildItems[itemName] || 0) + 1;
    record.lastEvent = (timestamp || new Date()).toISOString();
    this._persistRecord(steamId, record);
  }

  recordRaid(attackerName, attackerSteamId, ownerSteamId, destroyed, timestamp) {
    this._ensureInit();
    const ts = (timestamp || new Date()).toISOString();
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

  recordLoot(playerName, steamId, ownerSteamId, timestamp) {
    this._ensureInit();
    // Only count looting others' containers
    if (steamId === ownerSteamId) return;
    const record = this._getOrCreate(steamId, playerName);
    record.containersLooted++;
    record.lastEvent = (timestamp || new Date()).toISOString();
    this._persistRecord(steamId, record);
  }

  recordDamageTaken(playerName, source, timestamp) {
    this._ensureInit();
    const record = this._getOrCreateByName(playerName);
    const cleanSource = this._classifyDamageSource(source);
    record.damageTaken[cleanSource] = (record.damageTaken[cleanSource] || 0) + 1;
    record.lastEvent = (timestamp || new Date()).toISOString();
    this._persistRecord(this._getKeyForRecord(record), record);
  }

  recordConnect(playerName, steamId, timestamp) {
    this._ensureInit();
    const record = this._getOrCreate(steamId, playerName);
    record.connects++;
    record.lastEvent = (timestamp || new Date()).toISOString();
    this._persistRecord(steamId, record);
  }

  recordDisconnect(playerName, steamId, timestamp) {
    this._ensureInit();
    const record = this._getOrCreate(steamId, playerName);
    record.disconnects++;
    record.lastEvent = (timestamp || new Date()).toISOString();
    this._persistRecord(steamId, record);
  }

  recordAdminAccess(playerName, timestamp) {
    this._ensureInit();
    const record = this._getOrCreateByName(playerName);
    record.adminAccess++;
    record.lastEvent = (timestamp || new Date()).toISOString();
    this._persistRecord(this._getKeyForRecord(record), record);
  }

  recordCheatFlag(playerName, steamId, type, timestamp) {
    this._ensureInit();
    const record = this._getOrCreate(steamId, playerName);
    record.cheatFlags.push({
      type,
      timestamp: (timestamp || new Date()).toISOString(),
    });
    record.lastEvent = (timestamp || new Date()).toISOString();
    this._persistRecord(steamId, record);
  }

  // ─── Query methods ───────────────────────────────────────

  getStats(steamId) {
    this._ensureInit();
    const record = this._data.players[steamId];
    if (!record) return null;
    return { id: steamId, ...record };
  }

  getStatsByName(name) {
    this._ensureInit();
    const lower = name.toLowerCase();

    // O(1) exact match via name index (covers current + historical names)
    const exactId = this._nameIndex.get(lower);
    if (exactId && this._data.players[exactId]) {
      return { id: exactId, ...this._data.players[exactId] };
    }

    // Fallback: partial match by current name
    for (const [id, record] of Object.entries(this._data.players)) {
      if (record.name.toLowerCase().includes(lower)) return { id, ...record };
    }
    // Fallback: partial match by name history
    for (const [id, record] of Object.entries(this._data.players)) {
      if (record.nameHistory && record.nameHistory.some((h) => h.name.toLowerCase().includes(lower))) {
        return { id, ...record };
      }
    }
    return null;
  }

  getNameForId(steamId) {
    // 1. Known player in stats DB
    const record = this._data?.players?.[steamId];
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
    } catch (_) {}
    // 4. Unified identity DB
    if (this._db) {
      try {
        const name = this._db.resolveSteamIdToName(steamId);
        if (name && name !== steamId) return name;
      } catch (_) {}
    }
    return steamId;
  }

  getIdMap() {
    return this._idMap;
  }

  /** Look up a SteamID64 by player name (case-insensitive). */
  getSteamId(name) {
    if (!this._idMap || !name) return null;
    return this._idMap.get(name.toLowerCase()) || null;
  }

  getAllPlayers() {
    this._ensureInit();
    const entries = [];
    for (const [id, record] of Object.entries(this._data.players)) {
      entries.push({ id, ...record });
    }
    // Sort by total activity descending
    entries.sort((a, b) => {
      const actA = a.deaths + a.builds + a.raidsOut + a.containersLooted;
      const actB = b.deaths + b.builds + b.raidsOut + b.containersLooted;
      return actB - actA;
    });
    this._allPlayersCache = entries;
    return entries;
  }

  // ─── Internal ─────────────────────────────────────────────

  _getOrCreate(steamId, name) {
    if (!this._data.players[steamId]) {
      this._data.players[steamId] = this._newRecord(name);
      this._nameIndex.set(name.toLowerCase(), steamId);

      // Check if there's an orphaned name: record to merge in
      const nameLower = name.toLowerCase();
      for (const key of Object.keys(this._data.players)) {
        if (!key.startsWith('name:')) continue;
        const rec = this._data.players[key];
        if (rec.name.toLowerCase() === nameLower) {
          this._mergeInto(steamId, key);
          break;
        }
      }
    } else {
      // Track name changes in history
      const record = this._data.players[steamId];
      if (record.name !== name && record.name.toLowerCase() !== name.toLowerCase()) {
        if (!record.nameHistory) record.nameHistory = [];
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
        this._db.registerAlias(steamId, name, 'log');
      } catch (_) {
        /* non-critical */
      }
    }

    return this._data.players[steamId];
  }

  _getById(steamId) {
    return this._data.players[steamId] || null;
  }

  _getOrCreateByName(name) {
    const nameLower = name.toLowerCase();

    // 0. Check the authoritative ID map (from PlayerIDMapped.txt)
    if (this._idMap) {
      const steamId = this._idMap.get(nameLower);
      if (steamId) {
        return this._getOrCreate(steamId, name);
      }
    }

    // 1. O(1) lookup via name index
    const indexedId = this._nameIndex.get(nameLower);
    if (indexedId && this._data.players[indexedId]) {
      const record = this._data.players[indexedId];
      if (indexedId.startsWith('name:')) {
        const steamId = this._resolveNameToSteamId(nameLower);
        if (steamId && this._data.players[steamId]) {
          this._mergeInto(steamId, indexedId);
          return this._data.players[steamId];
        }
      }
      return record;
    }

    // 2. Search name history (old names) across all records
    for (const [id, record] of Object.entries(this._data.players)) {
      if (!record.nameHistory || id.startsWith('name:')) continue;
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
        const resolved = this._db.resolveNameToSteamId(name);
        if (resolved && /^\d{17}$/.test(resolved.steamId)) {
          return this._getOrCreate(resolved.steamId, name);
        }
      } catch (_) {
        /* non-critical */
      }
    }

    // 5. Fallback: create with name as key
    if (!this._data.players[`name:${name}`]) {
      this._data.players[`name:${name}`] = this._newRecord(name);
    }
    this._nameIndex.set(nameLower, `name:${name}`);
    return this._data.players[`name:${name}`];
  }

  _resolveNameToSteamId(nameLower) {
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

  _mergeInto(steamId, nameKey) {
    const source = this._data.players[nameKey];
    const target = this._data.players[steamId];
    if (!source || !target) return;

    target.deaths += source.deaths;
    target.builds += source.builds;
    for (const [item, count] of Object.entries(source.buildItems)) {
      target.buildItems[item] = (target.buildItems[item] || 0) + count;
    }
    target.raidsOut += source.raidsOut;
    target.raidsIn += source.raidsIn;
    target.destroyedOut += source.destroyedOut;
    target.destroyedIn += source.destroyedIn;
    target.containersLooted += source.containersLooted;
    target.connects += source.connects || 0;
    target.disconnects += source.disconnects || 0;
    target.adminAccess += source.adminAccess || 0;
    target.pvpKills += source.pvpKills || 0;
    target.pvpDeaths += source.pvpDeaths || 0;
    if (source.cheatFlags && source.cheatFlags.length > 0) {
      target.cheatFlags.push(...source.cheatFlags);
    }
    if (source.nameHistory && source.nameHistory.length > 0) {
      if (!target.nameHistory) target.nameHistory = [];
      target.nameHistory.push(...source.nameHistory);
    }
    for (const [src, count] of Object.entries(source.damageTaken)) {
      target.damageTaken[src] = (target.damageTaken[src] || 0) + count;
    }

    // Keep the more recent lastEvent
    if (source.lastEvent && (!target.lastEvent || source.lastEvent > target.lastEvent)) {
      target.lastEvent = source.lastEvent;
    }

    delete this._data.players[nameKey];
    this._log.info(`Merged name-keyed record "${source.name}" into SteamID ${steamId}`);
  }

  _buildNameIndex() {
    this._nameIndex = new Map();
    for (const [id, record] of Object.entries(this._data.players)) {
      this._nameIndex.set(record.name.toLowerCase(), id);
      if (record.nameHistory) {
        for (const h of record.nameHistory) {
          // Don't overwrite current-name entries with historical ones
          if (!this._nameIndex.has(h.name.toLowerCase())) {
            this._nameIndex.set(h.name.toLowerCase(), id);
          }
        }
      }
    }
  }

  _newRecord(name) {
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

  _classifyDamageSource(source) {
    return classifyDamageLabel(source);
  }

  // ─── Persistence ──────────────────────────────────────────
}

const _singleton = new PlayerStats();
module.exports = _singleton;
module.exports.PlayerStats = PlayerStats;

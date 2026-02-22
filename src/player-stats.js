const fs = require('fs');
const path = require('path');
const _defaultPlaytime = require('./playtime-tracker');

const DEFAULT_DATA_DIR = path.join(__dirname, '..', 'data');
const SAVE_INTERVAL = 60000;

class PlayerStats {
  /**
   * @param {object} [options]
   * @param {string} [options.dataDir]    Custom data directory (for multi-server)
   * @param {object} [options.playtime]   Custom PlaytimeTracker instance
   * @param {string} [options.label]      Log prefix for identification
   */
  constructor(options = {}) {
    this._data = null;
    this._saveTimer = null;
    this._dirty = false;
    this._idMap = null; // Map<lowerName, steamId> from PlayerIDMapped.txt
    this._nameIndex = new Map(); // lowerName → id for O(1) lookups
    // Per-instance overrides (for multi-server support)
    this._dataDir = options.dataDir || DEFAULT_DATA_DIR;
    this._dataFile = path.join(this._dataDir, 'player-stats.json');
    this._playtime = options.playtime || _defaultPlaytime;
    this._label = options.label || 'PLAYER STATS';
  }

  init() {
    if (this._data) return; // already initialised
    this._load();
    this._buildNameIndex();
    this._loadLocalIdMap(); // seed name→SteamID from cached PlayerIDMapped.txt
    this._saveTimer = setInterval(() => this._autoSave(), SAVE_INTERVAL);
    const count = Object.keys(this._data.players).length;
    console.log(`[${this._label}] Loaded ${count} player(s) from database`);
  }

  stop() {
    this._save();
    if (this._saveTimer) clearInterval(this._saveTimer);
    console.log(`[${this._label}] Saved and stopped.`);
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
          const alreadyLogged = record.nameHistory.some(h => h.name.toLowerCase() === record.name.toLowerCase());
          if (!alreadyLogged) {
            record.nameHistory.push({ name: record.name, until: new Date().toISOString() });
            console.log(`[PLAYER STATS] Name change detected via ID map: "${record.name}" → "${name}" (${steamId})`);
          }
          record.name = name;
          this._dirty = true;
        }
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
        console.log(`[${this._label}] Loaded ${entries.length} name(s) from cached PlayerIDMapped.txt`);
      }
    } catch (err) {
      console.error('[PLAYER STATS] Failed to load cached ID map:', err.message);
    }
  }

  // ─── Recording methods (called by LogWatcher) ────────────

  recordDeath(playerName, timestamp) {
    this._ensureInit();
    const record = this._getOrCreateByName(playerName);
    record.deaths++;
    record.lastEvent = (timestamp || new Date()).toISOString();
    this._dirty = true;
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

    this._dirty = true;
  }

  recordBuild(playerName, steamId, itemName, timestamp) {
    this._ensureInit();
    const record = this._getOrCreate(steamId, playerName);
    record.builds++;
    record.buildItems[itemName] = (record.buildItems[itemName] || 0) + 1;
    record.lastEvent = (timestamp || new Date()).toISOString();
    this._dirty = true;
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
    }
    // Owner/victim stats
    const owner = this._getById(ownerSteamId);
    if (owner) {
      owner.raidsIn++;
      if (destroyed) owner.destroyedIn++;
      owner.lastEvent = ts;
    }
    this._dirty = true;
  }

  recordLoot(playerName, steamId, ownerSteamId, timestamp) {
    this._ensureInit();
    // Only count looting others' containers
    if (steamId === ownerSteamId) return;
    const record = this._getOrCreate(steamId, playerName);
    record.containersLooted++;
    record.lastEvent = (timestamp || new Date()).toISOString();
    this._dirty = true;
  }

  recordDamageTaken(playerName, source, timestamp) {
    this._ensureInit();
    const record = this._getOrCreateByName(playerName);
    const cleanSource = this._classifyDamageSource(source);
    record.damageTaken[cleanSource] = (record.damageTaken[cleanSource] || 0) + 1;
    record.lastEvent = (timestamp || new Date()).toISOString();
    this._dirty = true;
  }

  recordConnect(playerName, steamId, timestamp) {
    this._ensureInit();
    const record = this._getOrCreate(steamId, playerName);
    record.connects++;
    record.lastEvent = (timestamp || new Date()).toISOString();
    this._dirty = true;
  }

  recordDisconnect(playerName, steamId, timestamp) {
    this._ensureInit();
    const record = this._getOrCreate(steamId, playerName);
    record.disconnects++;
    record.lastEvent = (timestamp || new Date()).toISOString();
    this._dirty = true;
  }

  recordAdminAccess(playerName, timestamp) {
    this._ensureInit();
    const record = this._getOrCreateByName(playerName);
    record.adminAccess++;
    record.lastEvent = (timestamp || new Date()).toISOString();
    this._dirty = true;
  }

  recordCheatFlag(playerName, steamId, type, timestamp) {
    this._ensureInit();
    const record = this._getOrCreate(steamId, playerName);
    record.cheatFlags.push({
      type,
      timestamp: (timestamp || new Date()).toISOString(),
    });
    record.lastEvent = (timestamp || new Date()).toISOString();
    this._dirty = true;
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
      if (record.nameHistory && record.nameHistory.some(h => h.name.toLowerCase().includes(lower))) {
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
    return steamId;
  }

  getIdMap() {
    return this._idMap;
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
        const alreadyLogged = record.nameHistory.some(h => h.name.toLowerCase() === record.name.toLowerCase());
        if (!alreadyLogged) {
          record.nameHistory.push({ name: record.name, until: new Date().toISOString() });
          console.log(`[PLAYER STATS] Name change detected: "${record.name}" → "${name}" (${steamId})`);
        }
        this._dirty = true;
      }
      // Update to current name
      record.name = name;
      this._nameIndex.set(name.toLowerCase(), steamId);
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
      if (record.nameHistory.some(h => h.name.toLowerCase() === nameLower)) {
        return record;
      }
    }

    // 3. Cross-reference playtime tracker to resolve name → SteamID
    const steamId = this._resolveNameToSteamId(nameLower);
    if (steamId) {
      return this._getOrCreate(steamId, name);
    }

    // 4. Fallback: create with name as key
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
    this._dirty = true;
    console.log(`[PLAYER STATS] Merged name-keyed record "${source.name}" into SteamID ${steamId}`);
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
    // Specific zombie variants first (before generic Zombie catch-all)
    if (/Dogzombie/i.test(source)) return 'Dog Zombie';
    if (/ZombieBear/i.test(source)) return 'Zombie Bear';
    if (/Mutant/i.test(source)) return 'Mutant';
    if (/Runner.*Brute|Brute.*Runner|RunnerBrute/i.test(source)) return 'Runner Brute';
    if (/Runner/i.test(source)) return 'Runner';
    if (/Brute/i.test(source)) return 'Brute';
    if (/Pudge|BellyToxic/i.test(source)) return 'Bloater';
    if (/Police|Cop|MilitaryArmoured|Camo|Hazmat/i.test(source)) return 'Armoured';
    if (/Zombie/i.test(source)) return 'Zombie';
    if (/KaiHuman/i.test(source)) return 'Bandit';
    if (/Wolf/i.test(source)) return 'Wolf';
    if (/Bear/i.test(source)) return 'Bear';
    if (/Deer/i.test(source)) return 'Deer';
    if (/Snake/i.test(source)) return 'Snake';
    if (/Spider/i.test(source)) return 'Spider';
    if (/Human/i.test(source)) return 'NPC';
    // If it's a player name (no BP_ prefix), treat as PvP
    if (!source.startsWith('BP_')) return 'Player';
    return 'Other';
  }

  // ─── Persistence ──────────────────────────────────────────

  _load() {
    try {
      if (fs.existsSync(this._dataFile)) {
        const raw = fs.readFileSync(this._dataFile, 'utf8');
        const parsed = JSON.parse(raw);
        // Validate: must be an object with a players property
        if (!parsed || typeof parsed !== 'object' || !parsed.players || typeof parsed.players !== 'object') {
          console.error(`[${this._label}] player-stats.json is corrupt (missing players object) — creating fresh`);
          // Backup the corrupt file for inspection
          const corruptBackup = this._dataFile.replace('.json', `-corrupt-${Date.now()}.json`);
          fs.copyFileSync(this._dataFile, corruptBackup);
          console.log(`[${this._label}] Corrupt file backed up to ${path.basename(corruptBackup)}`);
          this._createFresh();
          return;
        }
        this._data = parsed;
        // Migration: ensure all records have new fields
        for (const record of Object.values(this._data.players)) {
          if (!record.buildItems) record.buildItems = {};
          if (!record.damageTaken) record.damageTaken = {};
          if (record.containersLooted === undefined) record.containersLooted = 0;
          if (record.destroyedOut === undefined) record.destroyedOut = 0;
          if (record.destroyedIn === undefined) record.destroyedIn = 0;
          if (record.connects === undefined) record.connects = 0;
          if (record.disconnects === undefined) record.disconnects = 0;
          if (record.adminAccess === undefined) record.adminAccess = 0;
          if (!Array.isArray(record.cheatFlags)) record.cheatFlags = [];
          if (!Array.isArray(record.nameHistory)) record.nameHistory = [];
          if (record.pvpKills === undefined) record.pvpKills = 0;
          if (record.pvpDeaths === undefined) record.pvpDeaths = 0;
        }
      } else {
        this._createFresh();
      }
    } catch (err) {
      console.error(`[${this._label}] Failed to load data, creating fresh:`, err.message);
      this._createFresh();
    }
  }

  _createFresh() {
    this._data = { players: {} };
    this._save();
    console.log(`[${this._label}] Created fresh player-stats.json`);
  }

  _save(doBackup = false) {
    try {
      if (!this._data || typeof this._data !== 'object') {
        console.warn(`[${this._label}] Not saving: _data is null or invalid`);
        return false;
      }
      if (!fs.existsSync(this._dataDir)) fs.mkdirSync(this._dataDir, { recursive: true });
      // Atomic write: write to temp file then rename
      const tmpFile = this._dataFile + '.tmp';
      fs.writeFileSync(tmpFile, JSON.stringify(this._data, null, 2), 'utf8');
      fs.renameSync(tmpFile, this._dataFile);
      this._dirty = false;
      // Backup logic
      if (doBackup) {
        const ts = Date.now();
        const backupFile = path.join(this._dataDir, `player-stats-backup-${ts}.json`);
        fs.copyFileSync(this._dataFile, backupFile);
        // Prune old backups (keep last 5)
        const files = fs.readdirSync(this._dataDir)
          .filter(f => f.startsWith('player-stats-backup-') && f.endsWith('.json'))
          .map(f => ({ f, t: parseInt(f.split('-')[3]) }))
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
    // Every 15 minutes, do a backup
    const now = Date.now();
    const doBackup = (now % (15 * 60 * 1000)) < SAVE_INTERVAL;
    if (this._dirty) this._save(doBackup);
  }
}

const _singleton = new PlayerStats();
module.exports = _singleton;
module.exports.PlayerStats = PlayerStats;

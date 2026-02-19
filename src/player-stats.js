const fs = require('fs');
const path = require('path');
const playtime = require('./playtime-tracker');

/**
 * PlayerStats — master per-player data tracker derived from all server log files.
 *
 * Tracks every actionable event:
 *   - Deaths, builds (with item breakdown)
 *   - Raids in/out, structures destroyed in/out
 *   - Containers looted (others' containers only)
 *   - Damage taken (classified by source: Zombie, Wolf, Bear, Player, etc.)
 *   - Connects / disconnects (session count)
 *   - Admin access grants
 *   - Anti-cheat flags (stack limit, odd behavior, cheat detection)
 *
 * Sources:
 *   - HMZLog.log — deaths, builds, damage, looting, raiding, admin, anti-cheat
 *   - PlayerConnectedLog.txt — connects, disconnects
 *
 * Data format (player-stats.json):
 * {
 *   "players": {
 *     "76561198000000000": {
 *       "name": "PlayerName",
 *       "nameHistory": [{ "name": "OldName", "until": "2026-02-18T..." }],
 *       "deaths": 3,
 *       "builds": 12,
 *       "buildItems": { "Campfire": 2, "Rain Collector": 1 },
 *       "raidsOut": 0,
 *       "raidsIn": 0,
 *       "destroyedOut": 0,
 *       "destroyedIn": 0,
 *       "containersLooted": 0,
 *       "damageTaken": { "Zombie": 5, "Wolf": 2 },
 *       "connects": 34,
 *       "disconnects": 33,
 *       "adminAccess": 2,
 *       "cheatFlags": [ { "type": "Stack limit", "timestamp": "..." } ],
 *       "lastEvent": "2026-02-18T21:44:00.000Z"
 *     }
 *   }
 * }
 */

const DATA_DIR = path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'player-stats.json');
const SAVE_INTERVAL = 60000;

class PlayerStats {
  constructor() {
    this._data = null;
    this._saveTimer = null;
    this._dirty = false;
    this._idMap = null; // Map<lowerName, steamId> from PlayerIDMapped.txt
  }

  init() {
    this._load();
    this._saveTimer = setInterval(() => this._autoSave(), SAVE_INTERVAL);
    const count = Object.keys(this._data.players).length;
    console.log(`[PLAYER STATS] Loaded ${count} player(s) from database`);
  }

  stop() {
    this._save();
    if (this._saveTimer) clearInterval(this._saveTimer);
    console.log('[PLAYER STATS] Saved and stopped.');
  }

  /**
   * Load an authoritative name→SteamID map from parsed PlayerIDMapped.txt.
   * This is called by LogWatcher on each poll cycle.
   * @param {Array<{ steamId: string, name: string }>} entries
   */
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

  // ─── Recording methods (called by LogWatcher) ────────────

  /**
   * Record a player death.
   * @param {string} playerName
   * @param {Date} [timestamp] - log timestamp (falls back to now)
   */
  recordDeath(playerName, timestamp) {
    const record = this._getOrCreateByName(playerName);
    record.deaths++;
    record.lastEvent = (timestamp || new Date()).toISOString();
    this._dirty = true;
  }

  /**
   * Record a building completion.
   * @param {string} playerName
   * @param {string} steamId
   * @param {string} itemName - cleaned item name
   * @param {Date} [timestamp] - log timestamp (falls back to now)
   */
  recordBuild(playerName, steamId, itemName, timestamp) {
    const record = this._getOrCreate(steamId, playerName);
    record.builds++;
    record.buildItems[itemName] = (record.buildItems[itemName] || 0) + 1;
    record.lastEvent = (timestamp || new Date()).toISOString();
    this._dirty = true;
  }

  /**
   * Record a raiding event (attacker damaged/destroyed another player's structure).
   * @param {string} attackerName
   * @param {string|null} attackerSteamId
   * @param {string} ownerSteamId
   * @param {boolean} destroyed
   * @param {Date} [timestamp] - log timestamp (falls back to now)
   */
  recordRaid(attackerName, attackerSteamId, ownerSteamId, destroyed, timestamp) {
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

  /**
   * Record a container loot event.
   * @param {string} playerName
   * @param {string} steamId
   * @param {string} ownerSteamId
   * @param {Date} [timestamp] - log timestamp (falls back to now)
   */
  recordLoot(playerName, steamId, ownerSteamId, timestamp) {
    // Only count looting others' containers
    if (steamId === ownerSteamId) return;
    const record = this._getOrCreate(steamId, playerName);
    record.containersLooted++;
    record.lastEvent = (timestamp || new Date()).toISOString();
    this._dirty = true;
  }

  /**
   * Record damage taken by a player.
   * @param {string} playerName
   * @param {string} source - raw damage source (e.g. BP_PawnZombie2_C_123)
   * @param {Date} [timestamp] - log timestamp (falls back to now)
   */
  recordDamageTaken(playerName, source, timestamp) {
    const record = this._getOrCreateByName(playerName);
    const cleanSource = this._classifyDamageSource(source);
    record.damageTaken[cleanSource] = (record.damageTaken[cleanSource] || 0) + 1;
    record.lastEvent = (timestamp || new Date()).toISOString();
    this._dirty = true;
  }

  /**
   * Record a player connection.
   * @param {string} playerName
   * @param {string} steamId
   * @param {Date} [timestamp]
   */
  recordConnect(playerName, steamId, timestamp) {
    const record = this._getOrCreate(steamId, playerName);
    record.connects++;
    record.lastEvent = (timestamp || new Date()).toISOString();
    this._dirty = true;
  }

  /**
   * Record a player disconnection.
   * @param {string} playerName
   * @param {string} steamId
   * @param {Date} [timestamp]
   */
  recordDisconnect(playerName, steamId, timestamp) {
    const record = this._getOrCreate(steamId, playerName);
    record.disconnects++;
    record.lastEvent = (timestamp || new Date()).toISOString();
    this._dirty = true;
  }

  /**
   * Record an admin access grant event.
   * @param {string} playerName
   * @param {Date} [timestamp]
   */
  recordAdminAccess(playerName, timestamp) {
    const record = this._getOrCreateByName(playerName);
    record.adminAccess++;
    record.lastEvent = (timestamp || new Date()).toISOString();
    this._dirty = true;
  }

  /**
   * Record an anti-cheat flag.
   * @param {string} playerName
   * @param {string} steamId
   * @param {string} type - e.g. "Stack limit", "Odd behavior Drop amount Cheat"
   * @param {Date} [timestamp]
   */
  recordCheatFlag(playerName, steamId, type, timestamp) {
    const record = this._getOrCreate(steamId, playerName);
    record.cheatFlags.push({
      type,
      timestamp: (timestamp || new Date()).toISOString(),
    });
    record.lastEvent = (timestamp || new Date()).toISOString();
    this._dirty = true;
  }

  // ─── Query methods ───────────────────────────────────────

  /**
   * Get stats for a specific player by steam ID.
   * @param {string} steamId
   * @returns {object|null}
   */
  getStats(steamId) {
    const record = this._data.players[steamId];
    if (!record) return null;
    return { id: steamId, ...record };
  }

  /**
   * Get stats for a player by name (partial match).
   * @param {string} name
   * @returns {object|null}
   */
  getStatsByName(name) {
    const lower = name.toLowerCase();
    // Search by current name (exact)
    for (const [id, record] of Object.entries(this._data.players)) {
      if (record.name.toLowerCase() === lower) return { id, ...record };
    }
    // Search by name history (exact)
    for (const [id, record] of Object.entries(this._data.players)) {
      if (record.nameHistory && record.nameHistory.some(h => h.name.toLowerCase() === lower)) {
        return { id, ...record };
      }
    }
    // Search by current name (partial)
    for (const [id, record] of Object.entries(this._data.players)) {
      if (record.name.toLowerCase().includes(lower)) return { id, ...record };
    }
    // Search by name history (partial)
    for (const [id, record] of Object.entries(this._data.players)) {
      if (record.nameHistory && record.nameHistory.some(h => h.name.toLowerCase().includes(lower))) {
        return { id, ...record };
      }
    }
    return null;
  }

  /**
   * Get all players sorted by total activity (deaths + builds + raids).
   * @returns {Array<{ id, name, deaths, builds, raidsOut, raidsIn, ... }>}
   */
  getAllPlayers() {
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
    }
    return this._data.players[steamId];
  }

  _getById(steamId) {
    return this._data.players[steamId] || null;
  }

  /**
   * Find or create a record by name only (for death events that don't include SteamID).
   * Searches existing records first, cross-references the playtime tracker for SteamID
   * resolution, and falls back to creating a name-keyed entry.
   */
  _getOrCreateByName(name) {
    const nameLower = name.toLowerCase();

    // 0. Check the authoritative ID map (from PlayerIDMapped.txt)
    if (this._idMap) {
      const steamId = this._idMap.get(nameLower);
      if (steamId) {
        return this._getOrCreate(steamId, name);
      }
    }

    // 1. Search existing stats records by current name
    for (const [id, record] of Object.entries(this._data.players)) {
      if (record.name.toLowerCase() === nameLower) {
        // If we found a name: key but there's also a SteamID record, merge now
        if (id.startsWith('name:')) {
          const steamId = this._resolveNameToSteamId(nameLower);
          if (steamId && this._data.players[steamId]) {
            this._mergeInto(steamId, id);
            return this._data.players[steamId];
          }
        }
        return record;
      }
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
    return this._data.players[`name:${name}`];
  }

  /**
   * Resolve a player name to a SteamID by checking the playtime tracker.
   * @param {string} nameLower - lowercased player name
   * @returns {string|null} SteamID or null
   */
  _resolveNameToSteamId(nameLower) {
    try {
      const leaderboard = playtime.getLeaderboard();
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

  /**
   * Merge a name-keyed record into a SteamID-keyed record.
   * @param {string} steamId - target SteamID key
   * @param {string} nameKey - source name: key to merge and delete
   */
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
      connects: 0,
      disconnects: 0,
      adminAccess: 0,
      cheatFlags: [],
      lastEvent: null,
    };
  }

  /**
   * Classify a raw UE damage source into a human-readable category.
   * BP_PawnZombie2_C_123 → Zombie
   * BP_Wolf_C_456 → Wolf
   * BP_Bear_C_789 → Bear
   */
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
      if (fs.existsSync(DATA_FILE)) {
        const raw = fs.readFileSync(DATA_FILE, 'utf8');
        this._data = JSON.parse(raw);
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
        }
      } else {
        this._createFresh();
      }
    } catch (err) {
      console.error('[PLAYER STATS] Failed to load data, creating fresh:', err.message);
      this._createFresh();
    }
  }

  _createFresh() {
    this._data = { players: {} };
    this._save();
    console.log('[PLAYER STATS] Created fresh player-stats.json');
  }

  _save() {
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(DATA_FILE, JSON.stringify(this._data, null, 2), 'utf8');
      this._dirty = false;
    } catch (err) {
      console.error('[PLAYER STATS] Failed to save:', err.message);
    }
  }

  _autoSave() {
    if (this._dirty) this._save();
  }
}

module.exports = new PlayerStats();

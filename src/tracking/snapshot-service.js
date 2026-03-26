/**
 * Snapshot Service — captures full world state on each save poll cycle.
 *
 * Records temporal data (player positions, AI spawns, vehicles, structures,
 * houses, companions, backpacks, weather) to timeline_* DB tables. This
 * enables time-scroll playback on the live map and historical analytics.
 *
 * Hooks into the save poll cycle via `recordSnapshot(saveData)` — called
 * by PlayerStatsChannel after each successful save parse.
 *
 * @module snapshot-service
 */

const { cleanName } = require('../parsers/ue4-names');
const { createLogger } = require('../utils/log');

// ── AI type → display name mapping ──────────────────────────

const AI_DISPLAY_NAMES = {
  // Zombies
  ZombieDefault: 'Zombie',
  ZombieDefault2: 'Zombie',
  ZombieFemale: 'Female Zombie',
  ZombieFemale2: 'Female Zombie',
  ZombieUrban: 'Urban Zombie',
  ZombieRunner: 'Runner',
  ZombieBrute: 'Brute',
  ZombieFatty: 'Bloater',
  ZombieBellyToxic: 'Bloater',
  ZombieMutant: 'Mutant',
  ZombieCop: 'Police Zombie',
  ZombiePolice1: 'Police Zombie',
  ZombiePolice2: 'Police Zombie',
  ZombiePoliceArmor: 'Police Armoured',
  ZombieMilitaryArmor: 'Military Armoured',
  ZombieMilitaryArmorV2: 'Military Armoured V2',
  ZombieCamo: 'Camo Zombie',
  ZombieHazmat: 'Hazmat Zombie',
  ZombieMedic: 'Medic Zombie',
  ZombieBruteRunner: 'Runner Brute',
  ZombieBruteComp: 'Brute',
  ZombieBruteCop: 'Riot Brute',

  // Zombie animals
  AnimalZDog: 'Dog Zombie',
  AnimalZBear: 'Zombie Bear',
  AnimalZStag: 'Zombie Stag',

  // Animals
  AnimalWold: 'Wolf', // typo in game data
  AnimalBear: 'Bear',
  AnimalRabbit: 'Rabbit',
  AnimalPig: 'Pig',
  AnimalStag: 'Stag',
  AnimalDoe: 'Doe',
  AnimalChicken: 'Chicken',

  // Bandits
  BanditPistol: 'Bandit (Pistol)',
  BanditMelee: 'Bandit (Melee)',
  BanditShotgun: 'Bandit (Shotgun)',
  BanditRifle: 'Bandit (Rifle)',
  BanditSniper: 'Bandit (Sniper)',
};

class SnapshotService {
  /**
   * @param {object} db - HumanitZDB instance
   * @param {object} [options]
   * @param {string} [options.label] - Log prefix
   * @param {number} [options.retentionDays] - How many days to keep timeline data (default: 14)
   * @param {boolean} [options.trackStructures] - Track structures in timeline (can be large, default: true)
   * @param {boolean} [options.trackHouses] - Track house state in timeline (default: true)
   * @param {boolean} [options.trackBackpacks] - Track dropped backpacks (default: true)
   */
  constructor(db, options = {}) {
    this._db = db;
    this._log = createLogger(options.label, 'TIMELINE');
    this._retentionDays = options.retentionDays || 14;
    this._trackStructures = options.trackStructures !== false;
    this._trackHouses = options.trackHouses !== false;
    this._trackBackpacks = options.trackBackpacks !== false;
    this._lastSnapshotId = null;
    this._snapshotCount = 0;
    this._pruneCounter = 0;
  }

  /**
   * Record a complete world snapshot from parsed save data.
   * Called after each successful save poll.
   *
   * @param {object} saveData - The full parsed save object (from save-cache.json or parseSave())
   * @param {Map|object} saveData.players - Player data (Map or object keyed by steamId)
   * @param {object} saveData.worldState - World state object
   * @param {object} saveData.vehicles - Vehicle data (object keyed by id)
   * @param {object} saveData.structures - Structure data (object keyed by id)
   * @param {object} saveData.containers - Container data
   * @param {object} saveData.companions - Companion data
   * @param {object} saveData.horses - Horse data
   * @param {object} [options]
   * @param {Set} [options.onlinePlayers] - Set of currently online player names (lowercase)
   * @returns {number|null} The snapshot ID, or null if failed
   */
  recordSnapshot(saveData, options = {}) {
    if (!this._db || !saveData) return null;

    try {
      const ws = saveData.worldState || {};
      const players = this._normalizeToArray(saveData.players);
      const vehicles = this._normalizeToArray(saveData.vehicles);
      const structures = this._normalizeToArray(saveData.structures);
      const containers = this._normalizeToArray(saveData.containers);
      const aiSpawns = ws.aiSpawns || [];
      const houses = ws.houses || [];
      const backpacks = ws.droppedBackpacks || [];
      const companions = this._normalizeToArray(saveData.companions);
      const horses = this._normalizeToArray(saveData.horses);
      const onlineSet = options.onlinePlayers || new Set();

      // Build snapshot header
      const snapshot = {
        gameDay: ws.totalDaysElapsed || ws.timeOfDay?.day || 0,
        gameTime: ws.timeOfDay?.time || ws.timeOfDay || 0,
        playerCount: players.length,
        onlineCount: onlineSet.size || players.filter((p) => onlineSet.has((p.name || '').toLowerCase())).length,
        aiCount: aiSpawns.length,
        structureCount: structures.length,
        vehicleCount: vehicles.length,
        containerCount: containers.length,
        worldItemCount: (ws.lodPickups || []).length,
        weatherType: this._resolveWeather(ws.weatherState),
        season: this._resolveSeason(ws),
        airdropActive: !!(ws.airdrop && ws.airdrop.uid),
        airdropX: ws.airdrop?.x ?? null,
        airdropY: ws.airdrop?.y ?? null,
        airdropAiAlive: ws.airdrop?.aiAlive || 0,
        summary: {
          gameDifficulty: ws.gameDifficulty || {},
          heliCrash: ws.heliCrashData || [],
          destroyedSleepers: ws.destroyedSleepers?.length || 0,
          destroyedRandCars: ws.destroyedRandCars?.length || 0,
          explodableBarrels: ws.explodableBarrels?.length || 0,
          buildingDecayCount: ws.buildingDecayCount || 0,
        },
      };

      // Build entity arrays
      const timelinePlayers = players.map((p) => ({
        steamId: p.steamId || p.steam_id || '',
        name: p.name || '',
        online: onlineSet.has((p.name || '').toLowerCase()) ? 1 : 0,
        x: p.x ?? p.pos_x ?? null,
        y: p.y ?? p.pos_y ?? null,
        z: p.z ?? p.pos_z ?? null,
        health: p.health || 0,
        maxHealth: p.maxHealth || p.max_health || 100,
        hunger: p.hunger || 0,
        thirst: p.thirst || 0,
        infection: p.infection || 0,
        stamina: p.stamina || 0,
        level: p.level || 0,
        zeeksKilled: p.zeeksKilled || p.zeeks_killed || 0,
        daysSurvived: p.daysSurvived || p.days_survived || 0,
        lifetimeKills: p.lifetimeKills || p.lifetime_kills || 0,
      }));

      // Filter out dead AI (graveTimeMinutes > 0 means killed, waiting to respawn)
      const aliveAI = aiSpawns.filter((a) => !a.graveTimeMinutes || a.graveTimeMinutes <= 0);
      const timelineAI = aliveAI.map((a) => ({
        aiType: a.type || 'Unknown',
        category: a.category || this._classifyAICategory(a.type),
        displayName: AI_DISPLAY_NAMES[a.type] || cleanName(a.type) || a.type,
        nodeUid: a.nodeUid || '',
        x: a.x ?? null,
        y: a.y ?? null,
        z: a.z ?? null,
      }));

      const timelineVehicles = vehicles.map((v) => ({
        class: v.class || '',
        displayName: v.displayName || cleanName(v.class) || '',
        x: v.x ?? v.pos_x ?? null,
        y: v.y ?? v.pos_y ?? null,
        z: v.z ?? v.pos_z ?? null,
        health: v.health || 0,
        maxHealth: v.maxHealth || v.max_health || 0,
        fuel: v.fuel || 0,
        itemCount: (v.inventory || []).length,
      }));

      const timelineStructures = this._trackStructures
        ? structures.map((s) => ({
            actorClass: s.actorClass || s.actor_class || '',
            displayName: s.displayName || s.display_name || cleanName(s.actorClass || s.actor_class) || '',
            ownerSteamId: s.ownerSteamId || s.owner_steam_id || '',
            x: s.x ?? s.pos_x ?? null,
            y: s.y ?? s.pos_y ?? null,
            z: s.z ?? s.pos_z ?? null,
            currentHealth: s.currentHealth || s.current_health || 0,
            maxHealth: s.maxHealth || s.max_health || 0,
            upgradeLevel: s.upgradeLevel || s.upgrade_level || 0,
          }))
        : [];

      const timelineHouses = this._trackHouses
        ? houses.map((h) => ({
            uid: h.uid || '',
            name: h.name || '',
            windowsOpen: h.windowsOpen || 0,
            windowsTotal: h.windowsTotal || 0,
            doorsOpen: h.doorsOpen || 0,
            doorsLocked: h.doorsLocked || 0,
            doorsTotal: h.doorsTotal || 0,
            destroyedFurniture: h.destroyedFurniture || 0,
            hasGenerator: !!h.hasGenerator,
            sleepers: h.floatData?.Sleepers || h.sleepers || 0,
            clean: h.floatData?.Clean || h.clean || 0,
            x: null, // houses don't have positions in save data
            y: null,
          }))
        : [];

      // Merge companions + horses into one timeline array
      const timelineCompanions = [
        ...companions.map((c) => ({
          entityType: c.type || 'dog',
          actorName: c.actorName || c.actor_name || '',
          displayName: cleanName(c.actorName || c.actor_name) || c.type || 'Companion',
          ownerSteamId: c.ownerSteamId || c.owner_steam_id || '',
          x: c.x ?? c.pos_x ?? null,
          y: c.y ?? c.pos_y ?? null,
          z: c.z ?? c.pos_z ?? null,
          health: c.health || 0,
          extra: c.extra || {},
        })),
        ...horses.map((h) => ({
          entityType: 'horse',
          actorName: h.actorName || h.actor_name || '',
          displayName: h.horseName || h.horse_name || h.displayName || h.display_name || 'Horse',
          ownerSteamId: h.ownerSteamId || h.owner_steam_id || '',
          x: h.x ?? h.pos_x ?? null,
          y: h.y ?? h.pos_y ?? null,
          z: h.z ?? h.pos_z ?? null,
          health: h.health || 0,
          extra: {
            energy: h.energy || 0,
            stamina: h.stamina || 0,
            saddle: h.extra?.Saddle || 0,
          },
        })),
      ];

      const timelineBackpacks = this._trackBackpacks
        ? backpacks.map((b) => ({
            class: b.class || '',
            x: b.x ?? null,
            y: b.y ?? null,
            z: b.z ?? null,
            itemCount: (b.items || []).length,
            items: (b.items || []).slice(0, 10).map((i) => ({
              item: i.item || '',
              amount: i.amount || 1,
            })),
          }))
        : [];

      // Write to DB
      const snapId = this._db.insertTimelineSnapshot({
        snapshot,
        players: timelinePlayers,
        ai: timelineAI,
        vehicles: timelineVehicles,
        structures: timelineStructures,
        houses: timelineHouses,
        companions: timelineCompanions,
        backpacks: timelineBackpacks,
      });

      this._lastSnapshotId = snapId;
      this._snapshotCount++;

      // Periodic pruning (every 12 snapshots ≈ 1 hour at 5-min intervals)
      this._pruneCounter++;
      if (this._pruneCounter >= 12) {
        this._pruneCounter = 0;
        this._pruneOldData();
      }

      const entityCount =
        timelinePlayers.length +
        timelineAI.length +
        timelineVehicles.length +
        timelineStructures.length +
        timelineHouses.length +
        timelineCompanions.length +
        timelineBackpacks.length;
      this._log.info(`Snapshot #${this._snapshotCount} recorded (${entityCount} entities, id=${snapId})`);

      return snapId;
    } catch (err) {
      this._log.error('Failed to record snapshot:', err.message);
      return null;
    }
  }

  /** Get the most recent snapshot ID. */
  get lastSnapshotId() {
    return this._lastSnapshotId;
  }

  /** Get total snapshots recorded this session. */
  get snapshotCount() {
    return this._snapshotCount;
  }

  // ── Internal helpers ───────────────────────────────────────

  /** Convert Map or object to array of values. */
  _normalizeToArray(data) {
    if (!data) return [];
    if (Array.isArray(data)) return data;
    if (data instanceof Map) return [...data.values()];
    return Object.values(data);
  }

  /** Classify AI type into category. */
  _classifyAICategory(type) {
    if (!type) return 'unknown';
    if (/^Bandit/i.test(type)) return 'bandit';
    if (/^Animal(?!Z)/i.test(type)) return 'animal';
    return 'zombie';
  }

  /** Resolve weather type from UDS weather state. */
  _resolveWeather(weatherState) {
    if (!weatherState || !Array.isArray(weatherState)) return '';
    const udw = weatherState.find((w) => w.name === 'UDWRandomWeatherState');
    if (!udw || !udw.children) return '';
    const current = udw.children.find((c) => c.name === 'CurrentRandomWeatherType');
    if (!current) return '';
    // Map UDS enumerator to human name
    const weatherMap = {
      'UDS_WeatherTypes::NewEnumerator0': 'Clear',
      'UDS_WeatherTypes::NewEnumerator1': 'Partly Cloudy',
      'UDS_WeatherTypes::NewEnumerator2': 'Cloudy',
      'UDS_WeatherTypes::NewEnumerator3': 'Overcast',
      'UDS_WeatherTypes::NewEnumerator4': 'Light Rain',
      'UDS_WeatherTypes::NewEnumerator5': 'Rain',
      'UDS_WeatherTypes::NewEnumerator6': 'Thunderstorm',
      'UDS_WeatherTypes::NewEnumerator7': 'Light Snow',
      'UDS_WeatherTypes::NewEnumerator8': 'Snow',
      'UDS_WeatherTypes::NewEnumerator9': 'Blizzard',
      'UDS_WeatherTypes::NewEnumerator10': 'Fog',
    };
    return weatherMap[current.value] || current.value || '';
  }

  /** Resolve current season from world state. */
  _resolveSeason(ws) {
    // Check for season in weather state
    if (ws.weatherState && Array.isArray(ws.weatherState)) {
      const _sim = ws.weatherState.find((w) => w.name === 'SimulationDate');
      // Could derive season from SimulationDate, but for now return
      // the dedicated season field if present
    }
    // Check direct season field
    if (ws.currentSeason) return ws.currentSeason;
    // Derive from total days (roughly 30-day seasons)
    const days = ws.totalDaysElapsed || 0;
    const seasonIdx = Math.floor((days % 120) / 30);
    return ['Spring', 'Summer', 'Autumn', 'Winter'][seasonIdx] || 'Unknown';
  }

  /** Prune old timeline data beyond retention period. */
  _pruneOldData() {
    try {
      const result = this._db.purgeOldTimeline(`-${this._retentionDays} days`);
      if (result.changes > 0) {
        this._log.info(`Pruned ${result.changes} old timeline snapshots (>${this._retentionDays}d)`);
      }
    } catch (err) {
      this._log.warn('Failed to prune timeline:', err.message);
    }
  }
}

module.exports = SnapshotService;

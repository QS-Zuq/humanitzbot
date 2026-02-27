/**
 * Web Map Server — Interactive Leaflet-based player map served via Express.
 *
 * Features:
 * - 4K game map as tile layer
 * - Live player positions from save data
 * - Hover/click for player stats, inventory, vitals
 * - Admin actions: kick/ban via RCON
 * - Calibration mode for coordinate mapping
 *
 * Integrates with: save-parser, player-stats, playtime-tracker, rcon
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const config = require('../config');
const { parseSave, PERK_MAP } = require('../parsers/save-parser');
const { AFFLICTION_MAP } = require('../parsers/game-data');
const { cleanName: cleanActorName, cleanItemName, cleanItemArray, isHexGuid } = require('../parsers/ue4-names');
const playerStats = require('../tracking/player-stats');
const playtime = require('../tracking/playtime-tracker');
const rcon = require('../rcon/rcon');
const { setupAuth, requireTier } = require('./auth');
const serverResources = require('../server/server-resources');
const { formatBytes, formatUptime } = require('../server/server-resources');

// ── Rate limiter (simple in-memory, per-IP) ──
const _rateBuckets = new Map();
function rateLimit(windowMs, maxReqs) {
  return (req, res, next) => {
    const key = req.ip + ':' + req.path;
    const now = Date.now();
    let bucket = _rateBuckets.get(key);
    if (!bucket || now - bucket.start > windowMs) {
      bucket = { start: now, count: 0 };
      _rateBuckets.set(key, bucket);
    }
    bucket.count++;
    if (bucket.count > maxReqs) {
      return res.status(429).json({ error: 'Too many requests, try again later' });
    }
    next();
  };
}
// Prune stale rate buckets every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of _rateBuckets) {
    if (now - bucket.start > 300000) _rateBuckets.delete(key);
  }
}, 300000).unref();

/** Sanitize error messages for client responses — strip file paths and stack traces */
function safeError(err) {
  const msg = (err && err.message) || 'Internal server error';
  // Strip absolute paths
  return msg.replace(/\/[\w/.-]+/g, '[path]').substring(0, 200);
}

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const SERVERS_DIR = path.join(DATA_DIR, 'servers');
const SERVERS_FILE = path.join(DATA_DIR, 'servers.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const CALIBRATION_FILE = path.join(DATA_DIR, 'map-calibration.json');

class WebMapServer {
  constructor(client, opts = {}) {
    this._client = client;
    this._app = express();
    this._app.set('trust proxy', 'loopback'); // Trust Caddy reverse proxy on localhost
    this._server = null;
    this._port = parseInt(process.env.WEB_MAP_PORT, 10) || 3000;
    this._db = opts.db || null;
    this._scheduler = opts.scheduler || null;
    this._saveService = opts.saveService || null;

    // World coordinate bounds — loaded from calibration file or defaults
    this._worldBounds = this._loadCalibration();

    // Cache: last parsed save data
    this._playerCache = new Map();
    this._lastParse = 0;
    this._idMap = {};

    // Security headers
    this._app.use((_req, res, next) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('X-XSS-Protection', '1; mode=block');
      res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
      res.removeHeader('X-Powered-By');
      next();
    });

    // Set up Express
    this._setupRoutes();
  }

  /** Load calibration data from file, or return defaults. */
  _loadCalibration() {
    try {
      if (fs.existsSync(CALIBRATION_FILE)) {
        const data = JSON.parse(fs.readFileSync(CALIBRATION_FILE, 'utf8'));
        console.log('[WEB MAP] Loaded calibration from file');
        return data;
      }
    } catch (err) {
      console.error('[WEB MAP] Failed to load calibration:', err.message);
    }

    // Defaults — UE4 X = North (up), Y = East (right)
    // These map world coordinates to the [0, 4096] pixel space of the map image.
    // xMin = world X at the BOTTOM of the map, xMax = world X at the TOP
    // yMin = world Y at the LEFT of the map, yMax = world Y at the RIGHT
    // Source: developer-provided values — Width: 395900, Offset X=201200 Y=-200600
    return {
      xMin: 3250,      // south edge (bottom of map)
      xMax: 399150,    // north edge (top of map)
      yMin: -398550,   // west edge (left of map)
      yMax: -2650,     // east edge (right of map)
    };
  }

  /** Save calibration to file. */
  _saveCalibration(bounds) {
    this._worldBounds = bounds;
    try {
      fs.writeFileSync(CALIBRATION_FILE, JSON.stringify(bounds, null, 2));
      console.log('[WEB MAP] Saved calibration:', JSON.stringify(bounds));
    } catch (err) {
      console.error('[WEB MAP] Failed to save calibration:', err.message);
    }
  }

  /** Load player ID map from file. */
  _loadIdMap() {
    try {
      const raw = fs.readFileSync(path.join(DATA_DIR, 'logs', 'PlayerIDMapped.txt'), 'utf8');
      const map = {};
      for (const line of raw.split('\n')) {
        const m = line.trim().match(/^(\d{17})_\+_\|[^@]+@(.+)$/);
        if (m) map[m[1]] = m[2].trim();
      }
      this._idMap = map;
    } catch (err) {
      console.error('[WEB MAP] Failed to load ID map:', err.message);
    }
  }

  // ── Multi-server helpers ──────────────────────────────────

  /** Load the list of additional servers from servers.json. */
  _loadServerList() {
    try {
      if (fs.existsSync(SERVERS_FILE)) {
        return JSON.parse(fs.readFileSync(SERVERS_FILE, 'utf8'));
      }
    } catch (err) {
      console.error('[WEB MAP] Failed to load servers.json:', err.message);
    }
    return [];
  }

  /** Get data directory for a server id (or primary). */
  _getServerDataDir(serverId) {
    if (!serverId || serverId === 'primary') return DATA_DIR;
    // Sanitize to prevent path traversal
    const safe = serverId.replace(/[^a-zA-Z0-9_-]/g, '');
    const dir = path.join(SERVERS_DIR, safe);
    return fs.existsSync(dir) ? dir : null;
  }

  /** Load player ID map from a specific data directory. */
  _loadIdMapFrom(dataDir) {
    const map = {};
    try {
      const raw = fs.readFileSync(path.join(dataDir, 'logs', 'PlayerIDMapped.txt'), 'utf8');
      for (const line of raw.split('\n')) {
        const m = line.trim().match(/^(\d{17})_\+_\|[^@]+@(.+)$/);
        if (m) map[m[1]] = m[2].trim();
      }
    } catch { /* file may not exist for this server */ }
    return map;
  }

  /**
   * Load player-stats.json from a data directory.
   * Returns a { getStats(steamId), getStatsByName(name) } interface.
   */
  _loadLogStatsFrom(dataDir) {
    try {
      const raw = fs.readFileSync(path.join(dataDir, 'player-stats.json'), 'utf8');
      const data = JSON.parse(raw);
      const players = data.players || {};
      return {
        getStats(steamId) { return players[steamId] || null; },
        getStatsByName(name) {
          const lower = (name || '').toLowerCase();
          for (const rec of Object.values(players)) {
            if ((rec.name || '').toLowerCase() === lower) return rec;
          }
          return null;
        },
      };
    } catch { return { getStats() { return null; }, getStatsByName() { return null; } }; }
  }

  /** Load playtime.json from a data directory. */
  _loadPlaytimeFrom(dataDir) {
    try {
      const raw = fs.readFileSync(path.join(dataDir, 'playtime.json'), 'utf8');
      const data = JSON.parse(raw);
      const players = data.players || {};
      return {
        getPlaytime(steamId) {
          const p = players[steamId];
          if (!p) return null;
          return { totalMs: p.totalMs || 0, lastSeen: p.lastSeen || null };
        },
      };
    } catch { return { getPlaytime() { return null; } }; }
  }

  /**
   * Parse save data for a specific server.
   * Tries (in order): save-cache.json, humanitz-cache.json, raw .sav files.
   */
  _parseSaveDataForServer(dataDir) {
    // 1. Try save-cache.json (written by PlayerStatsChannel)
    try {
      const cachePath = path.join(dataDir, 'save-cache.json');
      if (fs.existsSync(cachePath)) {
        const stat = fs.statSync(cachePath);
        // Use cache if less than 10 minutes old
        if (Date.now() - stat.mtimeMs < 600000) {
          const data = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
          const map = new Map();
          for (const [steamId, pData] of Object.entries(data.players || {})) {
            map.set(steamId, pData);
          }
          return map;
        }
      }
    } catch { /* fall through */ }

    // 2. Try humanitz-cache.json (agent output)
    try {
      const agentPath = path.join(dataDir, 'humanitz-cache.json');
      if (fs.existsSync(agentPath)) {
        const data = JSON.parse(fs.readFileSync(agentPath, 'utf8'));
        const map = new Map();
        for (const [steamId, pData] of Object.entries(data.players || {})) {
          map.set(steamId, pData);
        }
        return map;
      }
    } catch { /* fall through */ }

    // 3. Try raw .sav files
    const saveFiles = [
      path.join(dataDir, 'Save_DedicatedSaveMP_NEW.sav'),
      path.join(dataDir, 'Save_DedicatedSaveMP_LIVE.sav'),
      path.join(dataDir, 'Save_DedicatedSaveMP.sav'),
    ];
    for (const savePath of saveFiles) {
      try {
        if (!fs.existsSync(savePath)) continue;
        const buf = fs.readFileSync(savePath);
        return parseSave(buf).players;
      } catch { /* try next */ }
    }

    return new Map();
  }

  /** Parse save file and cache results. Uses save-cache.json when available. */
  _parseSaveData() {
    const now = Date.now();
    // Cache for 30s
    if (now - this._lastParse < 30000 && this._playerCache.size > 0) {
      return this._playerCache;
    }

    // Try save-cache.json first (written by bot's PlayerStatsChannel — fast, no .sav parsing)
    const cached = this._parseSaveDataForServer(DATA_DIR);
    if (cached.size > 0) {
      this._playerCache = cached;
      this._lastParse = now;
      this._loadIdMap();
      return this._playerCache;
    }

    // Fallback: try raw .sav files
    const saveFiles = [
      path.join(DATA_DIR, 'Save_DedicatedSaveMP_NEW.sav'),
      path.join(DATA_DIR, 'Save_DedicatedSaveMP_LIVE.sav'),
      path.join(DATA_DIR, 'Save_DedicatedSaveMP.sav'),
    ];

    for (const savePath of saveFiles) {
      try {
        if (!fs.existsSync(savePath)) continue;
        const buf = fs.readFileSync(savePath);
        this._playerCache = parseSave(buf).players;
        this._lastParse = now;
        this._loadIdMap();
        return this._playerCache;
      } catch (err) {
        console.error(`[WEB MAP] Failed to parse ${path.basename(savePath)}:`, err.message);
      }
    }
    return this._playerCache;
  }

  /** Convert world coords to Leaflet [lat, lng] for CRS.Simple. */
  _worldToLeaflet(worldX, worldY) {
    const b = this._worldBounds;
    // lat (vertical) = maps UE4 X (north/south) — X+ is up
    const lat = ((worldX - b.xMin) / (b.xMax - b.xMin)) * 4096;
    // lng (horizontal) = maps UE4 Y (east/west) — Y+ is right
    const lng = ((worldY - b.yMin) / (b.yMax - b.yMin)) * 4096;
    return [lat, lng];
  }

  /** Return SHOW_* toggles for the frontend to conditionally display sections. */
  _getToggles() {
    return {
      showVitals: config.showVitals,
      showHealth: config.showHealth,
      showHunger: config.showHunger,
      showThirst: config.showThirst,
      showStamina: config.showStamina,
      showImmunity: config.showImmunity,
      showBattery: config.showBattery,
      showStatusEffects: config.showStatusEffects,
      showPlayerStates: config.showPlayerStates,
      showBodyConditions: config.showBodyConditions,
      showInfectionBuildup: config.showInfectionBuildup,
      showFatigue: config.showFatigue,
      showInventory: config.showInventory,
      showEquipment: config.showEquipment,
      showQuickSlots: config.showQuickSlots,
      showPockets: config.showPockets,
      showBackpack: config.showBackpack,
      showRecipes: config.showRecipes,
      showCraftingRecipes: config.showCraftingRecipes,
      showBuildingRecipes: config.showBuildingRecipes,
      showLore: config.showLore,
      showCoordinates: config.showCoordinates,
      showRaidStats: config.showRaidStats,
      showPvpKills: config.showPvpKills,
      showConnections: config.showConnections,
    };
  }

  /** Set up Express routes. */
  _setupRoutes() {
    const app = this._app;

    // Discord OAuth2 authentication (must be registered before static/API routes)
    // Returns no-op middleware if DISCORD_OAUTH_SECRET / WEB_MAP_CALLBACK_URL are not set
    const authMiddleware = setupAuth(app);
    app.use(authMiddleware);

    // ── Root page → panel.html (must come before static middleware) ──
    app.get('/', (req, res) => {
      res.sendFile(path.join(PUBLIC_DIR, 'panel.html'));
    });

    // Serve static files (HTML, JS, CSS, map images)
    app.use(express.static(PUBLIC_DIR));
    app.use(express.json());

    // ── API: List available servers (multi-server support) ──
    app.get('/api/servers', requireTier('survivor'), (req, res) => {
      const servers = [{ id: 'primary', name: config.serverName || 'Primary Server' }];
      const additional = this._loadServerList();
      for (const s of additional) {
        const dir = this._getServerDataDir(s.id);
        if (dir) servers.push({ id: s.id, name: s.name || s.id });
      }
      res.json({ servers, multiServer: additional.length > 0 });
    });

    // ── API: Calibration data — all entity positions for map alignment ──
    app.get('/api/calibration-data', requireTier('admin'), (req, res) => {
      try {
        const cachePath = path.join(DATA_DIR, 'save-cache.json');
        if (!fs.existsSync(cachePath)) return res.json([]);
        const data = JSON.parse(fs.readFileSync(cachePath, 'utf8'));

        const points = [];
        const add = (arr, type) => {
          if (!arr) return;
          for (const item of arr) {
            const x = item.x ?? item.worldX ?? null;
            const y = item.y ?? item.worldY ?? null;
            if (x !== null && y !== null && !(x === 0 && y === 0)) points.push([x, y, type]);
          }
        };

        // Players
        for (const [, p] of Object.entries(data.players || {})) {
          if (p.x != null && !(p.x === 0 && p.y === 0)) points.push([p.x, p.y, 'P']);
        }

        // World entities
        const ws = data.worldState || {};
        add(ws.preBuildActors, 'p');
        add(ws.droppedBackpacks, 'b');
        add(ws.explodableBarrelPositions, 'e');
        add(ws.destroyedRandCarPositions, 'd');
        add(ws.savedActors, 'A');
        add(ws.aiSpawns, 'a');

        // LOD pickups (positions extracted)
        if (ws.lodPickups) {
          for (const p of ws.lodPickups) {
            if (p.x != null && !(p.x === 0 && p.y === 0)) points.push([p.x, p.y, 'l']);
          }
        }

        // Houses
        if (ws.houses) {
          for (const h of ws.houses) {
            if (h.x != null && !(h.x === 0 && h.y === 0)) points.push([h.x, h.y, 'H']);
          }
        }

        // Global containers
        if (ws.globalContainers) {
          for (const c of ws.globalContainers) {
            if (c.x != null && !(c.x === 0 && c.y === 0)) points.push([c.x, c.y, 'c']);
          }
        }

        console.log(`[WEB MAP] Calibration data: ${points.length} positions`);
        res.json(points);
      } catch (err) {
        console.error('[WEB MAP] Calibration data error:', err.message);
        res.status(500).json({ error: safeError(err) });
      }
    });

    // ── API: Get all player positions ──
    app.get('/api/players', requireTier('survivor'), async (req, res) => {
      const serverId = req.query.server || 'primary';
      const isPrimary = !serverId || serverId === 'primary';

      // Resolve data sources based on server
      let players, idMap, logStatsProvider, playtimeProvider;
      if (isPrimary) {
        players = this._parseSaveData();
        idMap = this._idMap;
        logStatsProvider = playerStats;
        playtimeProvider = playtime;
      } else {
        const dataDir = this._getServerDataDir(serverId);
        if (!dataDir) return res.status(404).json({ error: 'Server not found' });
        players = this._parseSaveDataForServer(dataDir);
        idMap = this._loadIdMapFrom(dataDir);
        logStatsProvider = this._loadLogStatsFrom(dataDir);
        playtimeProvider = this._loadPlaytimeFrom(dataDir);
      }

      // Query RCON for online players (non-blocking — if it fails, all show offline)
      let onlineSteamIds = new Set();
      if (isPrimary) {
        try {
          const { getPlayerList } = require('../rcon/server-info');
          const list = await getPlayerList();
          const playerArr = list?.players || (Array.isArray(list) ? list : []);
          for (const p of playerArr) {
            if (p.steamId) onlineSteamIds.add(p.steamId);
          }
        } catch { /* RCON unavailable — all players show offline */ }
      }

      // Build clan membership lookup from DB
      let clanLookup = {}; // steamId → { clanName, rank }
      if (isPrimary && this._db) {
        try {
          const clans = this._db.getAllClans?.() || [];
          for (const clan of clans) {
            for (const m of (clan.members || [])) {
              clanLookup[m.steam_id] = { clanName: clan.name, rank: m.rank };
            }
          }
        } catch { /* clan data unavailable */ }
      }

      const result = [];

      for (const [steamId, data] of players) {
        const hasPosition = data.x !== null && !(data.x === 0 && data.y === 0 && data.z === 0);

        const name = idMap[steamId] || steamId;
        let lat = null, lng = null;
        if (hasPosition) {
          [lat, lng] = this._worldToLeaflet(data.x, data.y);
        }

        // Get log-based stats
        const logStats = logStatsProvider.getStats(steamId) || logStatsProvider.getStatsByName(name);

        // Get playtime
        const ptData = playtimeProvider.getPlaytime(steamId);

        // Resolve profession display name from enum code
        const professionName = PERK_MAP[data.startingPerk] || data.startingPerk || 'Unknown';

        result.push({
          steamId,
          name,
          hasPosition,
          lat,
          lng,
          worldX: hasPosition ? Math.round(data.x) : null,
          worldY: hasPosition ? Math.round(data.y) : null,
          worldZ: hasPosition ? Math.round(data.z) : null,
          isOnline: onlineSteamIds.has(steamId),

          // Character
          male: data.male,
          profession: professionName,
          affliction: AFFLICTION_MAP[data.affliction] || 'Unknown',
          unlockedProfessions: (data.unlockedProfessions || []).map(p => PERK_MAP[p] || p),

          // Current-life kill stats
          zeeksKilled: data.zeeksKilled || 0,
          headshots: data.headshots || 0,
          meleeKills: data.meleeKills || 0,
          gunKills: data.gunKills || 0,
          blastKills: data.blastKills || 0,
          fistKills: data.fistKills || 0,
          takedownKills: data.takedownKills || 0,
          vehicleKills: data.vehicleKills || 0,

          // Lifetime kill stats
          lifetimeKills: data.lifetimeKills || 0,
          lifetimeHeadshots: data.lifetimeHeadshots || 0,
          lifetimeMeleeKills: data.lifetimeMeleeKills || 0,
          lifetimeGunKills: data.lifetimeGunKills || 0,
          lifetimeBlastKills: data.lifetimeBlastKills || 0,
          lifetimeFistKills: data.lifetimeFistKills || 0,
          lifetimeTakedownKills: data.lifetimeTakedownKills || 0,
          lifetimeVehicleKills: data.lifetimeVehicleKills || 0,
          lifetimeDaysSurvived: data.lifetimeDaysSurvived || 0,
          hasExtendedStats: data.hasExtendedStats || false,

          // Survival
          daysSurvived: data.daysSurvived || 0,
          timesBitten: data.timesBitten || 0,
          fishCaught: data.fishCaught || 0,
          fishCaughtPike: data.fishCaughtPike || 0,
          exp: data.exp || 0,
          level: data.level || 0,
          expCurrent: data.expCurrent || 0,
          expRequired: data.expRequired || 0,
          skillsPoint: data.skillsPoint || 0,

          // Vitals
          health: data.health,
          maxHealth: data.maxHealth,
          hunger: data.hunger,
          maxHunger: data.maxHunger,
          thirst: data.thirst,
          maxThirst: data.maxThirst,
          stamina: data.stamina,
          maxStamina: data.maxStamina,
          infection: data.infection,
          maxInfection: data.maxInfection,
          battery: data.battery,
          fatigue: data.fatigue,
          infectionBuildup: data.infectionBuildup,

          // Status effects (cleaned)
          playerStates: (data.playerStates || []).map(s => cleanItemName(s)),
          bodyConditions: (data.bodyConditions || []).map(s => cleanItemName(s)),

          // Inventory (server-side cleaned)
          equipment: _cleanInventorySlots(data.equipment),
          quickSlots: _cleanInventorySlots(data.quickSlots),
          inventory: _cleanInventorySlots(data.inventory),
          backpackItems: _cleanInventorySlots(data.backpackItems),

          // Recipes & skills (cleaned)
          craftingRecipes: (data.craftingRecipes || []).map(r => cleanItemName(r)),
          buildingRecipes: (data.buildingRecipes || []).map(r => cleanItemName(r)),
          unlockedSkills: (data.unlockedSkills || []).map(s => cleanItemName(s)),

          // Lore
          lore: data.lore || [],
          uniqueLoots: cleanItemArray(data.uniqueLoots || []),
          craftedUniques: cleanItemArray(data.craftedUniques || []),

          // Companions (cleaned)
          companionData: (data.companionData || []).map(c =>
            typeof c === 'object' ? { ...c, type: cleanItemName(c.type || '') } : cleanItemName(c)
          ),
          horses: data.horses || [],

          // Log-derived stats
          deaths: logStats?.deaths || 0,
          pvpKills: logStats?.pvpKills || 0,
          pvpDeaths: logStats?.pvpDeaths || 0,
          builds: logStats?.builds || 0,
          containersLooted: logStats?.containersLooted || 0,
          raidsOut: logStats?.raidsOut || 0,
          raidsIn: logStats?.raidsIn || 0,
          connects: logStats?.connects || 0,

          // Clan
          clanName: clanLookup[steamId]?.clanName || null,
          clanRank: clanLookup[steamId]?.rank || null,

          // Playtime
          totalPlaytime: ptData ? Math.floor(ptData.totalMs / 60000) : 0,
          lastSeen: ptData?.lastSeen || null,
        });
      }

      res.json({
        server: serverId,
        players: result,
        worldBounds: this._worldBounds,
        toggles: this._getToggles(),
        lastUpdated: new Date().toISOString(),
      });
    });

    // ── API: Get single player detail ──
    app.get('/api/players/:steamId', requireTier('survivor'), (req, res) => {
      const players = this._parseSaveData();
      const data = players.get(req.params.steamId);
      if (!data) return res.status(404).json({ error: 'Player not found' });

      const name = this._idMap[req.params.steamId] || req.params.steamId;
      const hasPosition = data.x !== null && !(data.x === 0 && data.y === 0 && data.z === 0);
      let lat = null, lng = null;
      if (hasPosition) {
        [lat, lng] = this._worldToLeaflet(data.x, data.y);
      }

      // Resolve display names
      const professionName = PERK_MAP[data.startingPerk] || data.startingPerk || 'Unknown';
      const logStats = playerStats.getStats(req.params.steamId) || playerStats.getStatsByName(name);
      const ptData = playtime.getPlaytime(req.params.steamId);

      res.json({
        steamId: req.params.steamId,
        name,
        hasPosition,
        lat, lng,
        worldX: data.x, worldY: data.y, worldZ: data.z,
        profession: professionName,
        affliction: AFFLICTION_MAP[data.affliction] || 'Unknown',
        unlockedProfessions: (data.unlockedProfessions || []).map(p => PERK_MAP[p] || p),
        ...data,
        // Override raw enum values with resolved names
        startingPerk: professionName,
        // Log-derived
        deaths: logStats?.deaths || 0,
        pvpKills: logStats?.pvpKills || 0,
        pvpDeaths: logStats?.pvpDeaths || 0,
        builds: logStats?.builds || 0,
        containersLooted: logStats?.containersLooted || 0,
        raidsOut: logStats?.raidsOut || 0,
        raidsIn: logStats?.raidsIn || 0,
        connects: logStats?.connects || 0,
        // Playtime
        totalPlaytime: ptData ? Math.floor(ptData.totalMs / 60000) : 0,
        lastSeen: ptData?.lastSeen || null,
        // Toggles for conditional display
        toggles: this._getToggles(),
      });
    });

    // ── API: Get world bounds / calibration ──
    app.get('/api/calibration', requireTier('admin'), (req, res) => {
      res.json(this._worldBounds);
    });

    // ── API: Save calibration ──
    app.post('/api/calibration', requireTier('admin'), (req, res) => {
      const { xMin, xMax, yMin, yMax } = req.body;
      if ([xMin, xMax, yMin, yMax].some(v => typeof v !== 'number' || isNaN(v))) {
        return res.status(400).json({ error: 'Invalid bounds — need xMin, xMax, yMin, yMax as numbers' });
      }
      this._saveCalibration({ xMin, xMax, yMin, yMax });
      res.json({ ok: true, bounds: this._worldBounds });
    });

    // ── API: Calibrate from two reference points ──
    app.post('/api/calibrate-from-points', requireTier('admin'), (req, res) => {
      // Each point: { worldX, worldY, pixelX, pixelY } where pixel is 0-4096
      const { point1, point2 } = req.body;
      if (!point1 || !point2) {
        return res.status(400).json({ error: 'Need point1 and point2' });
      }

      // Solve: pixelLat = ((worldX - xMin) / (xMax - xMin)) * 4096
      //        pixelLng = ((worldY - yMin) / (yMax - yMin)) * 4096
      // Given 2 points we can solve for xMin/xMax and yMin/yMax

      // For X axis (vertical / lat):
      // lat1 = ((wx1 - xMin) / xSpan) * 4096
      // lat2 = ((wx2 - xMin) / xSpan) * 4096
      // lat1/4096 * xSpan + xMin = wx1
      // lat2/4096 * xSpan + xMin = wx2
      // → xSpan = (wx2 - wx1) / ((lat2 - lat1) / 4096)
      // → xMin = wx1 - (lat1/4096) * xSpan

      const lat1 = point1.pixelY; // pixel Y from bottom = lat
      const lat2 = point2.pixelY;
      const lng1 = point1.pixelX;
      const lng2 = point2.pixelX;

      if (Math.abs(lat2 - lat1) < 1 || Math.abs(lng2 - lng1) < 1) {
        return res.status(400).json({ error: 'Points too close together — need distinct positions' });
      }

      const xSpan = (point2.worldX - point1.worldX) / ((lat2 - lat1) / 4096);
      const xMin = point1.worldX - (lat1 / 4096) * xSpan;
      const xMax = xMin + xSpan;

      const ySpan = (point2.worldY - point1.worldY) / ((lng2 - lng1) / 4096);
      const yMin = point1.worldY - (lng1 / 4096) * ySpan;
      const yMax = yMin + ySpan;

      const bounds = {
        xMin: Math.round(xMin),
        xMax: Math.round(xMax),
        yMin: Math.round(yMin),
        yMax: Math.round(yMax),
      };

      this._saveCalibration(bounds);
      res.json({ ok: true, bounds });
    });

    // ── API: Admin action — kick ──
    app.post('/api/admin/kick', requireTier('mod'), rateLimit(5000, 5), async (req, res) => {
      const { steamId } = req.body;
      if (!steamId || typeof steamId !== 'string') return res.status(400).json({ error: 'Missing steamId' });
      // Validate steam ID format
      if (!/^\d{17}$/.test(steamId)) return res.status(400).json({ error: 'Invalid steamId format' });
      try {
        const result = await rcon.send(`kick ${steamId}`);
        res.json({ ok: true, result });
      } catch (err) {
        res.status(500).json({ error: safeError(err) });
      }
    });

    // ── API: Admin action — ban ──
    app.post('/api/admin/ban', requireTier('admin'), rateLimit(5000, 3), async (req, res) => {
      const { steamId } = req.body;
      if (!steamId || typeof steamId !== 'string') return res.status(400).json({ error: 'Missing steamId' });
      if (!/^\d{17}$/.test(steamId)) return res.status(400).json({ error: 'Invalid steamId format' });
      try {
        const result = await rcon.send(`ban ${steamId}`);
        res.json({ ok: true, result });
      } catch (err) {
        res.status(500).json({ error: safeError(err) });
      }
    });

    // ── API: RCON send message ──
    app.post('/api/admin/message', requireTier('mod'), rateLimit(3000, 5), async (req, res) => {
      const { message } = req.body;
      if (!message || typeof message !== 'string') return res.status(400).json({ error: 'Missing message' });
      if (message.length > 500) return res.status(400).json({ error: 'Message too long' });
      try {
        const result = await rcon.send(`say ${message}`);
        res.json({ ok: true, result });
      } catch (err) {
        res.status(500).json({ error: safeError(err) });
      }
    });

    // ── API: Get RCON player list (online status) ──
    app.get('/api/online', requireTier('survivor'), async (req, res) => {
      try {
        const { getPlayerList } = require('../rcon/server-info');
        const list = await getPlayerList();
        res.json({ players: list });
      } catch (err) {
        res.status(500).json({ error: safeError(err) });
      }
    });

    // ═══════════════════════════════════════════════════════
    // Public Landing API — no auth required
    // ═══════════════════════════════════════════════════════

    /**
     * Returns server status, connect info, and multi-server data for the
     * public landing page. No authentication needed.
     */
    app.get('/api/landing', rateLimit(30000, 20), async (req, res) => {
      const result = {
        primary: {
          name: config.serverName || 'HumanitZ Server',
          host: config.publicHost || '',
          gamePort: config.gamePort || '',
          status: 'unknown',
          onlineCount: 0,
          maxPlayers: null,
          totalPlayers: 0,
          gameDay: null,
          season: null,
          gameTime: null,
          timezone: config.botTimezone || 'UTC',
        },
        servers: [],
        schedule: null,
      };

      // Primary server status via RCON
      try {
        const { getServerInfo, getPlayerList } = require('../rcon/server-info');
        const info = await getServerInfo();
        if (info) {
          result.primary.status = 'online';
          result.primary.maxPlayers = info.maxPlayers || null;
          result.primary.gameDay = info.day || null;
          if (info.season) result.primary.season = info.season;
          if (info.name) result.primary.rconName = info.name;
          if (info.time) result.primary.gameTime = info.time;
        }
        const list = await getPlayerList();
        const playerArr = list?.players || (Array.isArray(list) ? list : []);
        result.primary.onlineCount = playerArr.length;
      } catch {
        result.primary.status = 'offline';
      }

      // Total players from save data + extract game day from save-cache
      const players = this._parseSaveData();
      result.primary.totalPlayers = players.size;

      // Game day from save-cache (RCON doesn't return Day)
      if (!result.primary.gameDay) {
        try {
          const cachePath = path.join(DATA_DIR, 'save-cache.json');
          if (fs.existsSync(cachePath)) {
            const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
            if (cache.worldState?.daysPassed != null) {
              result.primary.gameDay = cache.worldState.daysPassed;
            }
          }
        } catch { /* save-cache unavailable */ }
      }

      // World state from DB (fallback for game day / season)
      if (this._db) {
        try {
          const ws = this._db.getAllWorldState?.() || {};
          if (!result.primary.gameDay && ws.day) result.primary.gameDay = ws.day;
          if (!result.primary.season && ws.season) result.primary.season = ws.season;
        } catch { /* db unavailable */ }
      }

      // Scheduler info (public)
      if (this._scheduler && this._scheduler.isActive()) {
        try {
          result.schedule = this._scheduler.getStatus();
        } catch { /* scheduler unavailable */ }
      }

      // Multi-server status
      const additional = this._loadServerList();
      for (const s of additional) {
        const dir = this._getServerDataDir(s.id);
        if (!dir) continue;
        const serverInfo = {
          id: s.id,
          name: s.name || s.id,
          host: s.publicHost || s.host || config.publicHost || '',
          gamePort: s.gamePort || '',
          status: 'unknown',
          onlineCount: 0,
          totalPlayers: 0,
        };

        // Try to get player count from save cache
        try {
          const saveData = this._parseSaveDataForServer(dir);
          serverInfo.totalPlayers = saveData?.size || 0;
        } catch { /* non-critical */ }

        // Multi-server RCON is not queried from landing — too expensive
        // Status comes from save cache freshness
        const cacheFile = path.join(dir, 'save-cache.json');
        try {
          if (fs.existsSync(cacheFile)) {
            const age = Date.now() - fs.statSync(cacheFile).mtimeMs;
            serverInfo.status = age < 600_000 ? 'online' : 'stale';
          }
        } catch { /* non-critical */ }

        result.servers.push(serverInfo);
      }

      // Discord invite link
      result.primary.discordInvite = config.discordInviteLink || '';

      res.json(result);
    });

    // ═══════════════════════════════════════════════════════
    // Panel API routes — server management, activity, chat, RCON console, settings
    // ═══════════════════════════════════════════════════════

    // ── Panel: Server status (RCON info + resources) ──
    app.get('/api/panel/status', requireTier('survivor'), async (req, res) => {
      const result = { serverState: 'unknown', uptime: null, maxPlayers: null, onlineCount: 0, fps: null, gameDay: null, season: null, gameTime: null, timezone: config.botTimezone || 'UTC', resources: null };

      // RCON server info
      try {
        const { getServerInfo, getPlayerList } = require('../rcon/server-info');
        const info = await getServerInfo();
        if (info) {
          result.serverState = 'running';
          result.fps = info.fps || null;
          result.gameDay = info.day || null;
          result.maxPlayers = info.maxPlayers || null;
          if (info.season) result.season = info.season;
          if (info.time) result.gameTime = info.time;
        }
        const list = await getPlayerList();
        const playerArr = list?.players || (Array.isArray(list) ? list : []);
        result.onlineCount = playerArr.length;
      } catch {
        result.serverState = 'offline';
      }

      // System resources (SSH or Pterodactyl)
      try {
        const resources = await serverResources.getResources();
        if (resources) {
          result.resources = {
            cpu: resources.cpu,
            memPercent: resources.memPercent,
            memFormatted: resources.memUsed != null && resources.memTotal != null
              ? `${formatBytes(resources.memUsed)} / ${formatBytes(resources.memTotal)}`
              : null,
            diskPercent: resources.diskPercent,
            diskFormatted: resources.diskUsed != null && resources.diskTotal != null
              ? `${formatBytes(resources.diskUsed)} / ${formatBytes(resources.diskTotal)}`
              : null,
          };
          if (resources.uptime != null) {
            result.uptime = formatUptime(resources.uptime);
          }
        }
      } catch { /* resources unavailable */ }

      // Game day from save-cache (RCON doesn't return Day)
      if (!result.gameDay) {
        try {
          const cachePath = path.join(DATA_DIR, 'save-cache.json');
          if (fs.existsSync(cachePath)) {
            const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
            if (cache.worldState?.daysPassed != null) {
              result.gameDay = cache.worldState.daysPassed;
            }
          }
        } catch { /* save-cache unavailable */ }
      }

      // Season from RCON (already set above), then DB fallback
      if (this._db) {
        try {
          const ws = this._db.getAllWorldState?.() || {};
          if (!result.gameDay && ws.day) result.gameDay = ws.day;
          if (!result.season && ws.season) result.season = ws.season;
        } catch { /* db unavailable */ }
      }

      res.json(result);
    });

    // ── Panel: Quick stats ──
    app.get('/api/panel/stats', requireTier('survivor'), async (req, res) => {
      const result = { totalPlayers: 0, onlinePlayers: 0, eventsToday: 0, chatsToday: 0 };

      // Player count from save data
      const players = this._parseSaveData();
      result.totalPlayers = players.size;

      // Online count from RCON
      try {
        const { getPlayerList } = require('../rcon/server-info');
        const list = await getPlayerList();
        const playerArr = list?.players || (Array.isArray(list) ? list : []);
        result.onlinePlayers = playerArr.length;
      } catch { /* RCON unavailable */ }

      // DB counts for today (timezone-aware using BOT_TIMEZONE)
      if (this._db) {
        try {
          const tz = config.botTimezone || 'UTC';
          const nowStr = new Date().toLocaleDateString('en-CA', { timeZone: tz }); // YYYY-MM-DD
          const todayMidnight = new Date(`${nowStr}T00:00:00`);
          // Convert to UTC by accounting for timezone offset
          const tzDate = new Date(todayMidnight.toLocaleString('en-US', { timeZone: 'UTC' }));
          const localDate = new Date(todayMidnight.toLocaleString('en-US', { timeZone: tz }));
          const offsetMs = tzDate - localDate;
          const todayIso = new Date(todayMidnight.getTime() + offsetMs).toISOString();
          const activities = this._db.getActivitySince?.(todayIso) || [];
          result.eventsToday = activities.length;
          const chats = this._db.getChatSince?.(todayIso) || [];
          result.chatsToday = chats.length;
        } catch { /* db unavailable */ }
      }

      res.json(result);
    });

    // ── Panel: Activity feed from DB ──
    app.get('/api/panel/activity', requireTier('survivor'), (req, res) => {
      if (!this._db) return res.json({ events: [] });

      const limit = Math.min(parseInt(req.query.limit, 10) || 50, 500);
      const type = req.query.type || '';
      const actor = req.query.actor || '';

      try {
        let events;
        if (actor) {
          events = this._db.getActivityByActor(actor, limit);
        } else if (type) {
          events = this._db.getActivityByCategory(type, limit);
        } else {
          events = this._db.getRecentActivity(limit);
        }

        // Resolve steam IDs to player names + clean UE4 blueprint names
        const resolved = (events || []).map(e => {
          const out = { ...e };
          // Resolve actor: prefer actor_name, fall back to idMap lookup on steam_id or actor
          if (!out.actor_name && out.steam_id && this._idMap[out.steam_id]) {
            out.actor_name = this._idMap[out.steam_id];
          } else if (!out.actor_name && out.actor && this._idMap[out.actor]) {
            out.actor_name = this._idMap[out.actor];
          }
          // Resolve target: prefer target_name, fall back to idMap
          if (!out.target_name && out.target_steam_id && this._idMap[out.target_steam_id]) {
            out.target_name = this._idMap[out.target_steam_id];
          }
          // Clean UE4 blueprint names from item/actor fields
          if (out.item) out.item = cleanActorName(out.item);
          if (out.actor && !out.actor_name) out.actor_name = cleanActorName(out.actor);
          return out;
        });

        res.json({ events: resolved });
      } catch (err) {
        res.status(500).json({ error: safeError(err) });
      }
    });

    // ── Panel: Clans from DB ──
    app.get('/api/panel/clans', requireTier('survivor'), (req, res) => {
      if (!this._db) return res.json({ clans: [] });

      try {
        const clans = this._db.getAllClans?.() || [];
        res.json({ clans });
      } catch (err) {
        res.status(500).json({ error: safeError(err) });
      }
    });

    // ── Panel: Map world data (structures, vehicles, containers, companions, dead bodies) ──
    app.get('/api/panel/mapdata', requireTier('survivor'), (req, res) => {
      if (!this._db) return res.json({ structures: [], vehicles: [], containers: [], companions: [], deadBodies: [] });

      const layers = (req.query.layers || 'all').split(',');
      const showAll = layers.includes('all');
      const result = {};

      try {
        if (showAll || layers.includes('structures')) {
          const rows = this._db.db.prepare('SELECT id, display_name, actor_class, owner_steam_id, pos_x, pos_y, pos_z, current_health, max_health, upgrade_level, inventory FROM structures WHERE pos_x IS NOT NULL').all();
          result.structures = rows.map(r => {
            const [lat, lng] = this._worldToLeaflet(r.pos_x, r.pos_y);
            let itemCount = 0;
            try { const items = JSON.parse(r.inventory || '[]'); itemCount = items.filter(i => i && i !== 'Empty' && i !== 'None').length; } catch {}
            return { id: r.id, name: r.display_name || cleanActorName(r.actor_class), owner: r.owner_steam_id, lat, lng, health: r.current_health, maxHealth: r.max_health, upgrade: r.upgrade_level, itemCount };
          });
        }

        if (showAll || layers.includes('vehicles')) {
          const rows = this._db.db.prepare('SELECT id, display_name, class, pos_x, pos_y, pos_z, health, max_health, fuel FROM vehicles WHERE pos_x IS NOT NULL').all();
          result.vehicles = rows.map(r => {
            const [lat, lng] = this._worldToLeaflet(r.pos_x, r.pos_y);
            return { id: r.id, name: r.display_name || cleanActorName(r.class), lat, lng, health: r.health, maxHealth: r.max_health, fuel: Math.round(r.fuel * 10) / 10 };
          });
        }

        if (showAll || layers.includes('containers')) {
          const rows = this._db.db.prepare('SELECT actor_name, pos_x, pos_y, pos_z, items, locked FROM containers WHERE pos_x IS NOT NULL AND pos_x != 0').all();
          result.containers = rows.map(r => {
            const [lat, lng] = this._worldToLeaflet(r.pos_x, r.pos_y);
            let itemCount = 0;
            try { const items = JSON.parse(r.items || '[]'); itemCount = items.filter(i => i && i.item && i.item !== 'None' && i.item !== 'Empty').length; } catch {}
            return { name: cleanActorName(r.actor_name), lat, lng, locked: !!r.locked, itemCount };
          });
        }

        if (showAll || layers.includes('companions')) {
          const rows = this._db.db.prepare('SELECT id, type, actor_name, owner_steam_id, pos_x, pos_y, pos_z, health, extra FROM companions WHERE pos_x IS NOT NULL').all();
          result.companions = rows.map(r => {
            const [lat, lng] = this._worldToLeaflet(r.pos_x, r.pos_y);
            return { id: r.id, type: r.type, owner: r.owner_steam_id, lat, lng, health: r.health };
          });
        }

        if (showAll || layers.includes('deadBodies')) {
          const rows = this._db.db.prepare('SELECT actor_name, pos_x, pos_y, pos_z FROM dead_bodies WHERE pos_x IS NOT NULL').all();
          result.deadBodies = rows.map(r => {
            const [lat, lng] = this._worldToLeaflet(r.pos_x, r.pos_y);
            return { name: r.actor_name, lat, lng };
          });
        }

        // AI layers from latest timeline snapshot
        const wantAI = showAll || layers.includes('zombies') || layers.includes('animals') || layers.includes('bandits');
        if (wantAI) {
          try {
            const latestSnap = this._db.db.prepare('SELECT id FROM timeline_snapshots ORDER BY created_at DESC LIMIT 1').get();
            if (latestSnap) {
              const aiRows = this._db.db.prepare('SELECT ai_type, category, display_name, pos_x, pos_y FROM timeline_ai WHERE snapshot_id = ? AND pos_x IS NOT NULL').all(latestSnap.id);
              const zombies = [], animals = [], bandits = [];
              for (const r of aiRows) {
                if (r.pos_x === 0 && r.pos_y === 0) continue;
                const [lat, lng] = this._worldToLeaflet(r.pos_x, r.pos_y);
                const entry = { name: r.display_name || cleanActorName(r.ai_type), lat, lng, type: r.ai_type };
                if (r.category === 'zombie') zombies.push(entry);
                else if (r.category === 'animal') animals.push(entry);
                else if (r.category === 'bandit') bandits.push(entry);
              }
              if (showAll || layers.includes('zombies')) result.zombies = zombies;
              if (showAll || layers.includes('animals')) result.animals = animals;
              if (showAll || layers.includes('bandits')) result.bandits = bandits;
            }
          } catch { /* timeline_ai may not exist yet */ }
        }

        // Build steam_id → name lookup for owner resolution
        const nameMap = {};
        const nameRows = this._db.db.prepare('SELECT steam_id, name FROM players').all();
        for (const nr of nameRows) nameMap[nr.steam_id] = nr.name;
        result.nameMap = nameMap;

        res.json(result);
      } catch (err) {
        res.status(500).json({ error: safeError(err) });
      }
    });

    // ── Panel: Item Tracking API ──

    // GET /api/panel/items — All tracked items (instances + groups), with filters
    app.get('/api/panel/items', requireTier('admin'), (req, res) => {
      if (!this._db) return res.json({ instances: [], groups: [], total: 0 });
      try {
        const search = req.query.search || '';
        const locationType = req.query.locationType || '';
        const locationId = req.query.locationId || '';
        const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);

        let instances, groups;

        if (search) {
          instances = this._db.searchItemInstances(search, limit);
          groups = this._db.searchItemGroups(search, limit);
        } else if (locationType && locationId) {
          instances = this._db.getItemInstancesByLocation(locationType, locationId);
          groups = this._db.getItemGroupsByLocation(locationType, locationId);
        } else {
          instances = this._db.getActiveItemInstances();
          groups = this._db.getActiveItemGroups();
        }

        // Parse attachments JSON
        for (const inst of instances) {
          try { inst.attachments = JSON.parse(inst.attachments); } catch { inst.attachments = []; }
        }
        for (const grp of groups) {
          try { grp.attachments = JSON.parse(grp.attachments); } catch { grp.attachments = []; }
        }

        // Build location summary for sidebar
        const locationSummary = {};
        for (const inst of instances) {
          const key = `${inst.location_type}|${inst.location_id}`;
          if (!locationSummary[key]) locationSummary[key] = { type: inst.location_type, id: inst.location_id, instanceCount: 0, groupCount: 0, totalItems: 0 };
          locationSummary[key].instanceCount++;
          locationSummary[key].totalItems += inst.amount || 1;
        }
        for (const grp of groups) {
          const key = `${grp.location_type}|${grp.location_id}`;
          if (!locationSummary[key]) locationSummary[key] = { type: grp.location_type, id: grp.location_id, instanceCount: 0, groupCount: 0, totalItems: 0 };
          locationSummary[key].groupCount++;
          locationSummary[key].totalItems += grp.quantity * (grp.stack_size || 1);
        }

        res.json({
          instances,
          groups,
          locations: Object.values(locationSummary),
          counts: {
            instances: this._db.getItemInstanceCount(),
            groups: this._db.getItemGroupCount(),
          },
        });
      } catch (err) {
        res.status(500).json({ error: safeError(err) });
      }
    });

    // GET /api/panel/items/:id/movements — Movement history for an instance
    app.get('/api/panel/items/:id/movements', requireTier('admin'), (req, res) => {
      if (!this._db) return res.json({ movements: [] });
      try {
        const id = parseInt(req.params.id, 10);
        const instance = this._db.getItemInstance(id);
        if (!instance) return res.status(404).json({ error: 'Instance not found' });

        const movements = this._db.getItemMovements(id);
        res.json({ instance, movements });
      } catch (err) {
        res.status(500).json({ error: safeError(err) });
      }
    });

    // GET /api/panel/groups/:id — Group detail with movement history
    app.get('/api/panel/groups/:id', requireTier('admin'), (req, res) => {
      if (!this._db) return res.json({ group: null, movements: [] });
      try {
        const id = parseInt(req.params.id, 10);
        const group = this._db.getItemGroup(id);
        if (!group) return res.status(404).json({ error: 'Group not found' });
        try { group.attachments = JSON.parse(group.attachments); } catch { group.attachments = []; }

        const movements = this._db.getItemMovementsByGroup(id);
        res.json({ group, movements });
      } catch (err) {
        res.status(500).json({ error: safeError(err) });
      }
    });

    // GET /api/panel/movements — Recent item movements across all items
    app.get('/api/panel/movements', requireTier('admin'), (req, res) => {
      if (!this._db) return res.json({ movements: [] });
      try {
        const limit = Math.min(parseInt(req.query.limit, 10) || 50, 500);
        const steamId = req.query.steamId || '';
        const locationType = req.query.locationType || '';
        const locationId = req.query.locationId || '';

        let movements;
        if (steamId) {
          movements = this._db.getItemMovementsByPlayer(steamId, limit);
        } else if (locationType && locationId) {
          movements = this._db.getItemMovementsByLocation(locationType, locationId, limit);
        } else {
          movements = this._db.getRecentItemMovements(limit);
        }

        res.json({ movements });
      } catch (err) {
        res.status(500).json({ error: safeError(err) });
      }
    });

    // GET /api/panel/items/lookup — Look up item instance/group by name + fingerprint data
    // Used by item popups across the entire UI to bridge save data → item tracking DB
    app.get('/api/panel/items/lookup', requireTier('survivor'), (req, res) => {
      if (!this._db) return res.json({ match: null, movements: [] });
      try {
        const { fingerprint, item: itemName, steamId } = req.query;
        if (!fingerprint && !itemName) return res.status(400).json({ error: 'Need fingerprint or item name' });

        let match = null;
        let movements = [];
        let matchType = null; // 'instance' or 'group'

        // Try exact fingerprint match first
        if (fingerprint) {
          // Check instances
          const instances = this._db.findItemsByFingerprint(fingerprint);
          if (instances.length > 0) {
            // If steamId provided, prefer the instance at that player's location
            if (steamId) {
              match = instances.find(i => i.location_type === 'player' && i.location_id === steamId) || instances[0];
            } else {
              match = instances[0];
            }
            matchType = 'instance';
            try { match.attachments = JSON.parse(match.attachments); } catch { match.attachments = []; }
            movements = this._db.getItemMovements(match.id);
          }

          // Check groups if no instance match
          if (!match) {
            const groups = this._db.findActiveGroupsByFingerprint?.(fingerprint) || [];
            if (groups.length > 0) {
              if (steamId) {
                match = groups.find(g => g.location_type === 'player' && g.location_id === steamId) || groups[0];
              } else {
                match = groups[0];
              }
              matchType = 'group';
              try { match.attachments = JSON.parse(match.attachments); } catch { match.attachments = []; }
              movements = this._db.getItemMovementsByGroup(match.id);
            }
          }
        }

        // Fall back to item name search if no fingerprint match
        if (!match && itemName) {
          const instances = this._db.getItemInstancesByItem(itemName);
          if (instances.length > 0) {
            if (steamId) {
              match = instances.find(i => i.location_type === 'player' && i.location_id === steamId) || instances[0];
            } else {
              match = instances[0];
            }
            matchType = 'instance';
            try { match.attachments = JSON.parse(match.attachments); } catch { match.attachments = []; }
            movements = this._db.getItemMovements(match.id);
          }
        }

        // Resolve player names in movements
        const nameCache = {};
        const resolveName = (sid) => {
          if (!sid) return null;
          if (nameCache[sid]) return nameCache[sid];
          const name = this._idMap[sid] || sid;
          nameCache[sid] = name;
          return name;
        };

        // Enrich movement data with resolved names
        const enrichedMovements = movements.map(m => ({
          ...m,
          from_name: m.from_type === 'player' ? resolveName(m.from_id) : null,
          to_name: m.to_type === 'player' ? resolveName(m.to_id) : null,
          attributed_name: m.attributed_name || resolveName(m.attributed_steam_id),
        }));

        // Build ownership chain — unique players who have held this item
        const ownershipChain = [];
        const seenOwners = new Set();
        for (const m of movements) {
          if (m.to_type === 'player' && m.to_id && !seenOwners.has(m.to_id)) {
            seenOwners.add(m.to_id);
            ownershipChain.push({ steamId: m.to_id, name: resolveName(m.to_id), at: m.created_at });
          }
        }

        res.json({
          match,
          matchType,
          movements: enrichedMovements,
          ownershipChain,
          totalMovements: movements.length,
        });
      } catch (err) {
        res.status(500).json({ error: safeError(err) });
      }
    });

    // ── Panel: Comprehensive DB query (admin only) ──
    app.get('/api/panel/db/:table', requireTier('admin'), (req, res) => {
      if (!this._db) return res.json({ rows: [], columns: [] });

      const table = req.params.table;
      const limit = Math.min(parseInt(req.query.limit, 10) || 50, 1000);
      const search = req.query.search || '';

      // Whitelist of queryable tables
      const ALLOWED = new Set([
        'activity_log', 'chat_log', 'players', 'player_aliases',
        'clans', 'clan_members', 'world_state', 'structures',
        'vehicles', 'companions', 'world_horses', 'dead_bodies',
        'containers', 'loot_actors', 'quests', 'server_settings',
        'snapshots', 'game_items', 'game_professions', 'game_afflictions',
        'game_skills', 'game_challenges', 'game_recipes',
        'item_instances', 'item_movements', 'item_groups', 'world_drops',
        // v11 reference tables
        'game_buildings', 'game_loot_pools', 'game_loot_pool_items',
        'game_vehicles_ref', 'game_animals', 'game_crops',
        'game_car_upgrades', 'game_ammo_types', 'game_repair_data',
        'game_furniture', 'game_traps', 'game_sprays',
        'game_quests', 'game_lore', 'game_loading_tips',
        'game_spawn_locations', 'game_server_setting_defs',
      ]);

      if (!ALLOWED.has(table)) {
        return res.status(400).json({ error: `Table '${table}' not queryable` });
      }

      try {
        const db = this._db.db;

        // Get column names
        const pragma = db.prepare(`PRAGMA table_info("${table}")`).all();
        const columns = pragma.map(c => c.name);

        // Build query with optional search
        let query = `SELECT * FROM "${table}"`;
        const params = [];

        if (search) {
          // Search across text columns
          const textCols = pragma.filter(c =>
            c.type.toUpperCase().includes('TEXT') || c.type === '' || c.type.toUpperCase().includes('VARCHAR')
          );
          if (textCols.length > 0) {
            const clauses = textCols.map(c => `"${c.name}" LIKE ?`);
            query += ` WHERE ${clauses.join(' OR ')}`;
            for (let i = 0; i < textCols.length; i++) params.push(`%${search}%`);
          }
        }

        // Order by most recent first if created_at or updated_at exists
        if (columns.includes('created_at')) query += ' ORDER BY created_at DESC';
        else if (columns.includes('updated_at')) query += ' ORDER BY updated_at DESC';
        else if (columns.includes('id')) query += ' ORDER BY id DESC';

        query += ` LIMIT ?`;
        params.push(limit);

        const rows = db.prepare(query).all(...params);

        // Resolve steam IDs in player-related tables
        if (columns.includes('steam_id') || columns.includes('owner_steam_id')) {
          for (const row of rows) {
            const sid = row.steam_id || row.owner_steam_id;
            if (sid && this._idMap[sid] && !row.name && !row.actor_name && !row.player_name) {
              row._resolved_name = this._idMap[sid];
            }
          }
        }

        res.json({ table, columns, rows, total: rows.length });
      } catch (err) {
        res.status(500).json({ error: safeError(err) });
      }
    });

    // ── Panel: Chat log from DB ──
    app.get('/api/panel/chat', requireTier('survivor'), (req, res) => {
      if (!this._db) return res.json({ messages: [] });

      const limit = Math.min(parseInt(req.query.limit, 10) || 100, 1000);

      try {
        const messages = this._db.getRecentChat(limit);
        res.json({ messages: messages || [] });
      } catch (err) {
        res.status(500).json({ error: safeError(err) });
      }
    });

    // ── Panel: RCON command execution ──
    app.post('/api/panel/rcon', requireTier('admin'), rateLimit(10000, 10), async (req, res) => {
      const { command } = req.body;
      if (!command || typeof command !== 'string') return res.status(400).json({ error: 'Missing command' });
      if (command.length > 500) return res.status(400).json({ error: 'Command too long' });

      // Safety: block dangerous commands
      const cmd = command.trim().toLowerCase();
      const blocked = ['exit', 'quit', 'shutdown', 'destroyall', 'destroy_all', 'wipe', 'reset'];
      if (blocked.some(b => cmd.startsWith(b))) {
        return res.status(403).json({ error: 'Command blocked for safety' });
      }

      try {
        const response = await rcon.send(command);
        res.json({ ok: true, response });
      } catch (err) {
        res.status(500).json({ ok: false, error: safeError(err) });
      }
    });

    // POST /api/panel/refresh-snapshot — Force game save + re-poll save file + record fresh snapshot
    app.post('/api/panel/refresh-snapshot', requireTier('mod'), rateLimit(30000, 2), async (req, res) => {
      if (!this._saveService) return res.status(503).json({ error: 'Save service not available' });

      try {
        // Step 1: Tell the game server to save
        try {
          await rcon.send('save');
        } catch { /* RCON may not be connected — continue anyway, save file may still be recent */ }

        // Step 2: Wait briefly for the save to flush to disk
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Step 3: Force save service to re-poll (downloads .sav, parses, syncs DB, emits 'sync' → snapshot recorded)
        await this._saveService._poll(true);

        res.json({ ok: true, message: 'Snapshot refreshed' });
      } catch (err) {
        res.status(500).json({ ok: false, error: safeError(err) });
      }
    });

    // ── Panel: Server power controls ──
    // Supports Docker CLI (VPS), Pterodactyl API, or SSH-based controls
    app.post('/api/panel/power', requireTier('admin'), rateLimit(30000, 3), async (req, res) => {
      const { action } = req.body;
      const valid = ['start', 'stop', 'restart', 'backup'];
      if (!valid.includes(action)) return res.status(400).json({ error: `Invalid action: ${action}` });

      // Try Pterodactyl API first
      const panelApi = require('../server/panel-api');
      if (panelApi.available) {
        try {
          if (action === 'backup') {
            await panelApi.createBackup();
            return res.json({ ok: true, message: 'Backup initiated via panel API' });
          }
          await panelApi.sendPowerAction(action);
          return res.json({ ok: true, message: `Server ${action} sent via panel API` });
        } catch (err) {
          return res.status(500).json({ ok: false, error: safeError(err) });
        }
      }

      // Fall back to Docker CLI (VPS setup)
      const { execFile } = require('child_process');
      // Sanitize container name — alphanumeric, hyphens, underscores only
      const dockerContainer = (process.env.DOCKER_CONTAINER || 'hzserver').replace(/[^a-zA-Z0-9_.-]/g, '');

      if (action === 'backup') {
        const backupDir = path.join(DATA_DIR, 'backups', new Date().toISOString().replace(/[:.]/g, '-'));
        execFile('docker', ['cp', `${dockerContainer}:/home/steam/hzserver/serverfiles/HumanitZServer/Saved`, backupDir], { timeout: 30000 }, (err) => {
          if (err) return res.status(500).json({ ok: false, error: 'Backup failed' });
          res.json({ ok: true, message: 'Backup created' });
        });
        return;
      }

      execFile('docker', [action, dockerContainer], { timeout: 30000 }, (err, _stdout, stderr) => {
        if (err) {
          return res.status(500).json({ ok: false, error: 'Docker command failed' });
        }
        res.json({ ok: true, message: `Server ${action} executed` });
      });
    });

    // Sensitive keys that should never be exposed via API
    const HIDDEN_SETTINGS = new Set(['AdminPass', 'RCONPass', 'Password', 'RConPort', 'RCONEnabled']);
    function filterSettings(settings) {
      const filtered = {};
      for (const [k, v] of Object.entries(settings)) {
        if (!HIDDEN_SETTINGS.has(k) && !k.startsWith('_')) filtered[k] = v;
      }
      return filtered;
    }

    // ── Panel: Game server settings (read) ──
    app.get('/api/panel/settings', requireTier('admin'), async (req, res) => {
      // Try loading from cached file first
      const settingsFile = path.join(DATA_DIR, 'server-settings.json');
      try {
        if (fs.existsSync(settingsFile)) {
          const data = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
          return res.json({ settings: filterSettings(data) });
        }
      } catch { /* fall through to SFTP */ }

      // Try reading via SFTP
      if (config.ftpHost && config.ftpUser) {
        try {
          const SftpClient = require('ssh2-sftp-client');
          const sftp = new SftpClient();
          await sftp.connect(config.sftpConnectConfig());
          const content = await sftp.get(config.ftpSettingsPath);
          await sftp.end();

          const settings = {};
          const lines = content.toString().split('\n');
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('[') || trimmed.startsWith(';')) continue;
            const eq = trimmed.indexOf('=');
            if (eq > 0) {
              settings[trimmed.substring(0, eq).trim()] = trimmed.substring(eq + 1).trim();
            }
          }
          // Cache for next time
          fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
          res.json({ settings: filterSettings(settings) });
        } catch (err) {
          res.status(500).json({ error: `Failed to read settings: ${safeError(err)}` });
        }
      } else {
        res.status(404).json({ error: 'No settings available (SFTP not configured)' });
      }
    });

    // ── Panel: Game server settings (write) ──
    app.post('/api/panel/settings', requireTier('admin'), rateLimit(30000, 5), async (req, res) => {
      const { settings } = req.body;
      if (!settings || typeof settings !== 'object') {
        return res.status(400).json({ error: 'Missing settings object' });
      }

      if (!config.ftpHost || !config.ftpUser) {
        return res.status(400).json({ error: 'SFTP not configured' });
      }

      try {
        const SftpClient = require('ssh2-sftp-client');
        const sftp = new SftpClient();
        await sftp.connect(config.sftpConnectConfig());

        // Read current file
        const content = (await sftp.get(config.ftpSettingsPath)).toString();
        const lines = content.split('\n');

        // Update values in-place
        const updated = new Set();
        const newLines = lines.map(line => {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('[') || trimmed.startsWith(';')) return line;
          const eq = trimmed.indexOf('=');
          if (eq <= 0) return line;
          const key = trimmed.substring(0, eq).trim();
          if (key in settings) {
            updated.add(key);
            return `${key}=${settings[key]}`;
          }
          return line;
        });

        // Write back
        await sftp.put(Buffer.from(newLines.join('\n')), config.ftpSettingsPath);
        await sftp.end();

        // Update local cache
        const settingsFile = path.join(DATA_DIR, 'server-settings.json');
        try {
          let cached = {};
          if (fs.existsSync(settingsFile)) cached = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
          Object.assign(cached, settings);
          fs.writeFileSync(settingsFile, JSON.stringify(cached, null, 2));
        } catch { /* cache update failed, not critical */ }

        res.json({ ok: true, updated: [...updated] });
      } catch (err) {
        res.status(500).json({ error: `Failed to save settings: ${safeError(err)}` });
      }
    });

    // ── API: Server scheduler status ──
    app.get('/api/panel/scheduler', requireTier('survivor'), (req, res) => {
      // This will be populated by the bot when it passes the scheduler instance
      if (this._scheduler) {
        res.json(this._scheduler.getStatus());
      } else {
        res.json({ active: false });
      }
    });

    // ══════════════════════════════════════════════════════════════════
    //  Timeline API — time-scroll playback, entity history, death causes
    // ══════════════════════════════════════════════════════════════════

    /** GET /api/timeline/bounds — earliest/latest snapshot timestamps + count */
    app.get('/api/timeline/bounds', requireTier('survivor'), (req, res) => {
      if (!this._db) return res.json({ earliest: null, latest: null, count: 0 });
      try {
        const bounds = this._db.getTimelineBounds();
        res.json(bounds || { earliest: null, latest: null, count: 0 });
      } catch (err) {
        res.status(500).json({ error: safeError(err) });
      }
    });

    /** GET /api/timeline/snapshots?from=&to=&limit= — snapshot list (metadata only) */
    app.get('/api/timeline/snapshots', requireTier('survivor'), (req, res) => {
      if (!this._db) return res.json([]);
      try {
        const { from, to, limit } = req.query;
        let snapshots;
        if (from && to) {
          snapshots = this._db.getTimelineSnapshotRange(from, to);
        } else {
          snapshots = this._db.getTimelineSnapshots(parseInt(limit, 10) || 50);
        }
        res.json(snapshots);
      } catch (err) {
        res.status(500).json({ error: safeError(err) });
      }
    });

    /** GET /api/timeline/snapshot/:id — full snapshot data (all entities with map coords) */
    app.get('/api/timeline/snapshot/:id', requireTier('survivor'), (req, res) => {
      if (!this._db) return res.status(404).json({ error: 'Database not available' });
      try {
        const id = parseInt(req.params.id, 10);
        if (isNaN(id)) return res.status(400).json({ error: 'Invalid snapshot ID' });

        const full = this._db.getTimelineSnapshotFull(id);
        if (!full) return res.status(404).json({ error: 'Snapshot not found' });

        // Convert world coordinates to leaflet coordinates for all entities
        const convert = (item) => {
          if (item.pos_x != null && item.pos_y != null && !(item.pos_x === 0 && item.pos_y === 0)) {
            const [lat, lng] = this._worldToLeaflet(item.pos_x, item.pos_y);
            return { ...item, lat, lng };
          }
          return { ...item, lat: null, lng: null };
        };

        full.players = (full.players || []).map(convert);
        full.ai = (full.ai || []).map(convert);
        full.vehicles = (full.vehicles || []).map(convert);
        full.structures = (full.structures || []).map(convert);
        full.companions = (full.companions || []).map(convert);
        full.backpacks = (full.backpacks || []).map(convert);

        // Build name map for owner resolution
        const nameMap = {};
        try {
          const rows = this._db.db.prepare('SELECT steam_id, name FROM players').all();
          for (const r of rows) nameMap[r.steam_id] = r.name;
        } catch { /* */ }
        full.nameMap = nameMap;

        res.json(full);
      } catch (err) {
        res.status(500).json({ error: safeError(err) });
      }
    });

    /** GET /api/timeline/player/:steamId/trail?from=&to= — player position history */
    app.get('/api/timeline/player/:steamId/trail', requireTier('survivor'), (req, res) => {
      if (!this._db) return res.json([]);
      try {
        const { steamId } = req.params;
        const { from, to } = req.query;
        if (!from || !to) return res.status(400).json({ error: 'from and to are required' });

        const positions = this._db.getPlayerPositionHistory(steamId, from, to);
        // Convert to map coordinates
        const trail = positions.map(p => {
          if (p.pos_x != null && p.pos_y != null && !(p.pos_x === 0 && p.pos_y === 0)) {
            const [lat, lng] = this._worldToLeaflet(p.pos_x, p.pos_y);
            return { lat, lng, health: p.health, online: p.online, time: p.created_at, gameDay: p.game_day };
          }
          return null;
        }).filter(Boolean);

        res.json(trail);
      } catch (err) {
        res.status(500).json({ error: safeError(err) });
      }
    });

    /** GET /api/timeline/ai/population?from=&to= — AI population over time */
    app.get('/api/timeline/ai/population', requireTier('survivor'), (req, res) => {
      if (!this._db) return res.json([]);
      try {
        const { from, to } = req.query;
        if (!from || !to) return res.status(400).json({ error: 'from and to are required' });
        const data = this._db.getAIPopulationHistory(from, to);
        res.json(data);
      } catch (err) {
        res.status(500).json({ error: safeError(err) });
      }
    });

    /** GET /api/timeline/deaths?limit=&player= — recent death causes */
    app.get('/api/timeline/deaths', requireTier('survivor'), (req, res) => {
      if (!this._db) return res.json([]);
      try {
        const { limit, player } = req.query;
        let deaths;
        if (player) {
          deaths = this._db.getDeathCausesByPlayer(player, parseInt(limit, 10) || 50);
        } else {
          deaths = this._db.getDeathCauses(parseInt(limit, 10) || 50);
        }
        // Add map coordinates
        deaths = deaths.map(d => {
          if (d.pos_x != null && d.pos_y != null && !(d.pos_x === 0 && d.pos_y === 0)) {
            const [lat, lng] = this._worldToLeaflet(d.pos_x, d.pos_y);
            return { ...d, lat, lng };
          }
          return { ...d, lat: null, lng: null };
        });
        res.json(deaths);
      } catch (err) {
        res.status(500).json({ error: safeError(err) });
      }
    });

    /** GET /api/timeline/deaths/stats — death cause breakdown */
    app.get('/api/timeline/deaths/stats', requireTier('survivor'), (req, res) => {
      if (!this._db) return res.json([]);
      try {
        const stats = this._db.getDeathCauseStats();
        res.json(stats);
      } catch (err) {
        res.status(500).json({ error: safeError(err) });
      }
    });
  }

  /** Start the Express server. */
  _addErrorHandler() {
    // Global error handler — catch unhandled errors in routes
    this._app.use((err, _req, res, _next) => {
      console.error('[WEB MAP] Unhandled route error:', err.message);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error' });
      }
    });
  }

  start() {
    this._addErrorHandler();
    return new Promise((resolve, reject) => {
      this._server = this._app.listen(this._port, () => {
        console.log(`[WEB MAP] Interactive map running at http://localhost:${this._port}`);
        resolve();
      });
      this._server.on('error', (err) => {
        console.error('[WEB MAP] Server error:', err.message);
        reject(err);
      });
    });
  }

  /** Stop the server. */
  stop() {
    if (this._server) {
      this._server.close();
      this._server = null;
      console.log('[WEB MAP] Server stopped');
    }
  }
}

const { generateFingerprint } = require('../db/item-fingerprint');

/**
 * Clean inventory slot items — applies cleanItemName to each item object.
 * Filters out empty/None items, cleans names, preserves durability/ammo.
 * Now also generates item fingerprints for tracking system integration.
 * @param {Array} slots - Array of { item, amount, durability, ammo } or strings
 * @returns {Array}
 */
function _cleanInventorySlots(slots) {
  if (!Array.isArray(slots)) return [];
  return slots.map(slot => {
    if (!slot) return slot;
    if (typeof slot === 'string') {
      if (slot === 'Empty' || slot === 'None') return slot;
      return cleanItemName(slot);
    }
    if (typeof slot === 'object' && slot.item) {
      const cleaned = { ...slot, item: cleanItemName(slot.item) };
      // Generate fingerprint for item tracking integration
      // Uses the RAW item name for fingerprint (before cleaning) since
      // that's what the item tracker uses
      const fp = generateFingerprint(slot);
      if (fp) cleaned.fingerprint = fp;
      return cleaned;
    }
    return slot;
  });
}

module.exports = WebMapServer;

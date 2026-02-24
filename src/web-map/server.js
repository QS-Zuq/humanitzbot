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
 * Integrates with: save-parser, player-stats, playtime-tracker, rcon, player-map
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const config = require('../config');
const { parseSave, PERK_MAP } = require('../save-parser');
const { AFFLICTION_MAP } = require('../game-data');
const playerStats = require('../player-stats');
const playtime = require('../playtime-tracker');
const rcon = require('../rcon');
const { setupAuth } = require('./auth');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const SERVERS_DIR = path.join(DATA_DIR, 'servers');
const SERVERS_FILE = path.join(DATA_DIR, 'servers.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const CALIBRATION_FILE = path.join(DATA_DIR, 'map-calibration.json');

class WebMapServer {
  constructor(client, opts = {}) {
    this._client = client;
    this._app = express();
    this._server = null;
    this._port = parseInt(process.env.WEB_MAP_PORT, 10) || 3000;

    // World coordinate bounds — loaded from calibration file or defaults
    this._worldBounds = this._loadCalibration();

    // Cache: last parsed save data
    this._playerCache = new Map();
    this._lastParse = 0;
    this._idMap = {};

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
    return {
      xMin: -10000,    // south edge (bottom of map)
      xMax: 300000,    // north edge (top of map)
      yMin: -400000,   // west edge (left of map)
      yMax: 10000,     // east edge (right of map)
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
      const raw = fs.readFileSync(path.join(DATA_DIR, 'PlayerIDMapped.txt'), 'utf8');
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
      const raw = fs.readFileSync(path.join(dataDir, 'PlayerIDMapped.txt'), 'utf8');
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

    // Serve static files (HTML, JS, CSS, map images)
    app.use(express.static(PUBLIC_DIR));
    app.use(express.json());

    // ── API: List available servers (multi-server support) ──
    app.get('/api/servers', (req, res) => {
      const servers = [{ id: 'primary', name: config.serverName || 'Primary Server' }];
      const additional = this._loadServerList();
      for (const s of additional) {
        const dir = this._getServerDataDir(s.id);
        if (dir) servers.push({ id: s.id, name: s.name || s.id });
      }
      res.json({ servers, multiServer: additional.length > 0 });
    });

    // ── API: Get all player positions ──
    app.get('/api/players', (req, res) => {
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

          // Status effects
          playerStates: data.playerStates || [],
          bodyConditions: data.bodyConditions || [],

          // Inventory
          equipment: data.equipment || [],
          quickSlots: data.quickSlots || [],
          inventory: data.inventory || [],
          backpackItems: data.backpackItems || [],

          // Recipes & skills
          craftingRecipes: data.craftingRecipes || [],
          buildingRecipes: data.buildingRecipes || [],
          unlockedSkills: data.unlockedSkills || [],

          // Lore
          lore: data.lore || [],
          uniqueLoots: data.uniqueLoots || [],
          craftedUniques: data.craftedUniques || [],

          // Companions
          companionData: data.companionData || [],
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
    app.get('/api/players/:steamId', (req, res) => {
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
    app.get('/api/calibration', (req, res) => {
      res.json(this._worldBounds);
    });

    // ── API: Save calibration ──
    app.post('/api/calibration', (req, res) => {
      const { xMin, xMax, yMin, yMax } = req.body;
      if ([xMin, xMax, yMin, yMax].some(v => typeof v !== 'number' || isNaN(v))) {
        return res.status(400).json({ error: 'Invalid bounds — need xMin, xMax, yMin, yMax as numbers' });
      }
      this._saveCalibration({ xMin, xMax, yMin, yMax });
      res.json({ ok: true, bounds: this._worldBounds });
    });

    // ── API: Calibrate from two reference points ──
    app.post('/api/calibrate-from-points', (req, res) => {
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
    app.post('/api/admin/kick', async (req, res) => {
      const { steamId } = req.body;
      if (!steamId) return res.status(400).json({ error: 'Missing steamId' });
      try {
        const result = await rcon.send(`kick ${steamId}`);
        res.json({ ok: true, result });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // ── API: Admin action — ban ──
    app.post('/api/admin/ban', async (req, res) => {
      const { steamId } = req.body;
      if (!steamId) return res.status(400).json({ error: 'Missing steamId' });
      try {
        const result = await rcon.send(`ban ${steamId}`);
        res.json({ ok: true, result });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // ── API: RCON send message ──
    app.post('/api/admin/message', async (req, res) => {
      const { message } = req.body;
      if (!message) return res.status(400).json({ error: 'Missing message' });
      try {
        const result = await rcon.send(`say ${message}`);
        res.json({ ok: true, result });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    // ── API: Get RCON player list (online status) ──
    app.get('/api/online', async (req, res) => {
      try {
        const { getPlayerList } = require('../server-info');
        const list = await getPlayerList();
        res.json({ players: list });
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });
  }

  /** Start the Express server. */
  start() {
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

module.exports = WebMapServer;

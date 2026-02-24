/**
 * Player Map Tracker — tracks player positions from save file data,
 * persists location history, generates map overlay images with player markers
 * and activity heatmaps.
 *
 * Data source: save-parser.js outputs x/y/z per player each poll cycle.
 * Output: PNG images via @napi-rs/canvas for Discord embed attachments.
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');

const DATA_DIR = path.join(__dirname, '..', 'data');
const LOCATIONS_FILE = path.join(DATA_DIR, 'player-locations.json');
const MAP_CACHE_FILE = path.join(DATA_DIR, 'map-image.png');

// Default map world bounds (UE4 centimeters) — configurable via env
const DEFAULT_WORLD = {
  xMin: parseFloat(process.env.MAP_WORLD_X_MIN) || -20000,
  xMax: parseFloat(process.env.MAP_WORLD_X_MAX) || 260000,
  yMin: parseFloat(process.env.MAP_WORLD_Y_MIN) || -370000,
  yMax: parseFloat(process.env.MAP_WORLD_Y_MAX) || 20000,
};

// Heatmap grid resolution
const HEATMAP_GRID = parseInt(process.env.MAP_HEATMAP_GRID, 10) || 50;

// Max history entries per player
const MAX_HISTORY = parseInt(process.env.MAP_MAX_HISTORY, 10) || 500;

// Map image URL (the game's island map)
const MAP_IMAGE_URL = process.env.MAP_IMAGE_URL || 'https://static.wikia.nocookie.net/humanitz/images/c/cb/HZ_TheIsland_%280.912.C%29_Compressed.png/revision/latest';

class PlayerMapTracker {
  constructor() {
    this._locations = {
      players: {},    // steamID → { name, lastX, lastY, lastZ, lastYaw, lastSeen, online, history: [{x,y,z,ts}] }
      heatmap: {},    // "gridX,gridY" → count
      lastUpdated: null,
    };
    this._mapImageBuffer = null;
    this._dirty = false;
    this._saveTimer = null;
    this._loaded = false;
  }

  /** Load persisted location data. */
  _load() {
    if (this._loaded) return;
    this._loaded = true;
    try {
      if (fs.existsSync(LOCATIONS_FILE)) {
        const raw = JSON.parse(fs.readFileSync(LOCATIONS_FILE, 'utf8'));
        if (raw.players) this._locations.players = raw.players;
        if (raw.heatmap) this._locations.heatmap = raw.heatmap;
        if (raw.lastUpdated) this._locations.lastUpdated = raw.lastUpdated;
        console.log(`[PLAYER MAP] Loaded ${Object.keys(this._locations.players).length} player locations`);
      }
    } catch (err) {
      console.error('[PLAYER MAP] Failed to load locations:', err.message);
    }
    // Auto-save every 60s if dirty
    this._saveTimer = setInterval(() => { if (this._dirty) this._save(); }, 60000);
  }

  /** Persist location data. */
  _save() {
    try {
      fs.writeFileSync(LOCATIONS_FILE, JSON.stringify(this._locations, null, 2));
      this._dirty = false;
    } catch (err) {
      console.error('[PLAYER MAP] Failed to save locations:', err.message);
    }
  }

  /**
   * Update player positions from a save parse result.
   * @param {Map<string, object>} playersMap — output of parseSave()
   * @param {Set<string>} [onlineSteamIds] — currently online player IDs
   * @param {Map<string, string>} [nameMap] — steamID → display name override
   */
  updateFromSave(playersMap, onlineSteamIds = new Set(), nameMap = new Map()) {
    this._load();
    const now = new Date().toISOString();

    for (const [steamID, data] of playersMap) {
      // Skip players at origin (0,0,0) — haven't spawned yet
      if (data.x === null || data.x === 0 && data.y === 0 && data.z === 0) continue;

      const existing = this._locations.players[steamID] || {
        name: nameMap.get(steamID) || steamID,
        lastX: null, lastY: null, lastZ: null, lastYaw: null,
        lastSeen: null, online: false,
        history: [],
      };

      // Update name if available
      if (nameMap.has(steamID)) existing.name = nameMap.get(steamID);

      // Only add to history if position actually changed (moved > 100 UE4 units = 1m)
      const dx = existing.lastX !== null ? data.x - existing.lastX : Infinity;
      const dy = existing.lastY !== null ? data.y - existing.lastY : Infinity;
      const moved = Math.sqrt(dx * dx + dy * dy) > 100;

      if (moved || existing.lastX === null) {
        existing.history.push({
          x: Math.round(data.x),
          y: Math.round(data.y),
          z: Math.round(data.z),
          ts: now,
        });

        // Trim history
        if (existing.history.length > MAX_HISTORY) {
          existing.history = existing.history.slice(-MAX_HISTORY);
        }

        // Update heatmap grid
        const gx = Math.floor((data.x - DEFAULT_WORLD.xMin) / ((DEFAULT_WORLD.xMax - DEFAULT_WORLD.xMin) / HEATMAP_GRID));
        const gy = Math.floor((data.y - DEFAULT_WORLD.yMin) / ((DEFAULT_WORLD.yMax - DEFAULT_WORLD.yMin) / HEATMAP_GRID));
        const key = `${Math.max(0, Math.min(HEATMAP_GRID - 1, gx))},${Math.max(0, Math.min(HEATMAP_GRID - 1, gy))}`;
        this._locations.heatmap[key] = (this._locations.heatmap[key] || 0) + 1;
      }

      existing.lastX = data.x;
      existing.lastY = data.y;
      existing.lastZ = data.z;
      existing.lastYaw = data.rotationYaw;
      existing.lastSeen = now;
      existing.online = onlineSteamIds.has(steamID);

      this._locations.players[steamID] = existing;
    }

    // Mark offline players
    for (const [steamID, loc] of Object.entries(this._locations.players)) {
      if (!onlineSteamIds.has(steamID)) loc.online = false;
    }

    this._locations.lastUpdated = now;
    this._dirty = true;
  }

  /** Get all tracked player locations. */
  getLocations() {
    this._load();
    return this._locations.players;
  }

  /** Get location for a specific player. */
  getPlayerLocation(steamID) {
    this._load();
    return this._locations.players[steamID] || null;
  }

  /** Get heatmap grid data. */
  getHeatmapData() {
    this._load();
    return this._locations.heatmap;
  }

  /**
   * Download and cache the game map image.
   * @returns {Promise<Buffer|null>}
   */
  async _getMapImage() {
    if (this._mapImageBuffer) return this._mapImageBuffer;

    // Check local cache
    if (fs.existsSync(MAP_CACHE_FILE)) {
      this._mapImageBuffer = fs.readFileSync(MAP_CACHE_FILE);
      return this._mapImageBuffer;
    }

    // Download from URL
    try {
      console.log('[PLAYER MAP] Downloading map image...');
      const response = await fetch(MAP_IMAGE_URL, {
        headers: { 'User-Agent': 'HumanitZBot/1.0' },
        redirect: 'follow',
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const buf = Buffer.from(await response.arrayBuffer());
      fs.writeFileSync(MAP_CACHE_FILE, buf);
      this._mapImageBuffer = buf;
      console.log(`[PLAYER MAP] Map image cached (${(buf.length / 1024).toFixed(0)} KB)`);
      return buf;
    } catch (err) {
      console.error('[PLAYER MAP] Failed to download map image:', err.message);
      return null;
    }
  }

  /**
   * Convert world coordinates to map pixel coordinates.
   * @param {number} worldX - UE4 X coordinate
   * @param {number} worldY - UE4 Y coordinate
   * @param {number} imgW - Image width in pixels
   * @param {number} imgH - Image height in pixels
   * @returns {{ px: number, py: number }}
   */
  _worldToPixel(worldX, worldY, imgW, imgH) {
    const nx = (worldX - DEFAULT_WORLD.xMin) / (DEFAULT_WORLD.xMax - DEFAULT_WORLD.xMin);
    // Y is inverted in UE4 (negative = south, map image has origin top-left)
    const ny = 1 - (worldY - DEFAULT_WORLD.yMin) / (DEFAULT_WORLD.yMax - DEFAULT_WORLD.yMin);
    return {
      px: Math.round(nx * imgW),
      py: Math.round(ny * imgH),
    };
  }

  /**
   * Generate a player positions map overlay.
   * @param {object} [opts]
   * @param {boolean} [opts.showOffline=true] - Include offline players
   * @param {boolean} [opts.showNames=true] - Show player names
   * @param {number}  [opts.width=1024] - Output image width
   * @returns {Promise<Buffer|null>} PNG buffer
   */
  async generateMapOverlay(opts = {}) {
    const { showOffline = true, showNames = true, width = 1024 } = opts;
    this._load();

    let canvas, loadImage;
    try {
      ({ createCanvas: canvas, loadImage } = require('@napi-rs/canvas'));
    } catch {
      // Fallback if canvas function naming differs
      const canvasModule = require('@napi-rs/canvas');
      canvas = canvasModule.createCanvas;
      loadImage = canvasModule.loadImage;
    }

    const mapBuf = await this._getMapImage();
    if (!mapBuf) return null;

    const mapImg = await loadImage(mapBuf);
    const aspect = mapImg.height / mapImg.width;
    const imgW = width;
    const imgH = Math.round(width * aspect);

    const cvs = canvas(imgW, imgH);
    const ctx = cvs.getContext('2d');

    // Draw base map
    ctx.drawImage(mapImg, 0, 0, imgW, imgH);

    // Draw player markers
    const players = Object.entries(this._locations.players);
    const onlinePlayers = players.filter(([, p]) => p.online);
    const offlinePlayers = players.filter(([, p]) => !p.online);

    // Draw offline first (dimmer), then online on top
    const toDraw = [];
    if (showOffline) {
      for (const [, p] of offlinePlayers) {
        if (p.lastX === null) continue;
        toDraw.push({ ...p, isOnline: false });
      }
    }
    for (const [, p] of onlinePlayers) {
      if (p.lastX === null) continue;
      toDraw.push({ ...p, isOnline: true });
    }

    for (const p of toDraw) {
      const { px, py } = this._worldToPixel(p.lastX, p.lastY, imgW, imgH);
      if (px < 0 || px > imgW || py < 0 || py > imgH) continue;

      const radius = p.isOnline ? 8 : 5;
      const color = p.isOnline ? '#00FF44' : '#888888';
      const borderColor = p.isOnline ? '#004411' : '#333333';

      // Glow effect for online players
      if (p.isOnline) {
        ctx.beginPath();
        ctx.arc(px, py, radius + 4, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(0, 255, 68, 0.25)';
        ctx.fill();
      }

      // Marker dot
      ctx.beginPath();
      ctx.arc(px, py, radius, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = borderColor;
      ctx.lineWidth = 2;
      ctx.stroke();

      // Name label
      if (showNames) {
        ctx.font = `bold ${p.isOnline ? 12 : 10}px sans-serif`;
        ctx.fillStyle = p.isOnline ? '#FFFFFF' : '#AAAAAA';
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.7)';
        ctx.lineWidth = 3;
        const name = p.name.length > 15 ? p.name.substring(0, 14) + '…' : p.name;
        ctx.strokeText(name, px + radius + 4, py + 4);
        ctx.fillText(name, px + radius + 4, py + 4);
      }
    }

    // Legend
    const legendY = imgH - 40;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.fillRect(8, legendY - 4, 260, 36);

    ctx.font = 'bold 11px sans-serif';
    // Online
    ctx.beginPath(); ctx.arc(20, legendY + 10, 5, 0, Math.PI * 2); ctx.fillStyle = '#00FF44'; ctx.fill();
    ctx.fillStyle = '#FFFFFF'; ctx.fillText(`Online (${onlinePlayers.length})`, 30, legendY + 14);
    // Offline
    if (showOffline) {
      ctx.beginPath(); ctx.arc(130, legendY + 10, 4, 0, Math.PI * 2); ctx.fillStyle = '#888888'; ctx.fill();
      ctx.fillStyle = '#AAAAAA'; ctx.fillText(`Offline (${offlinePlayers.length})`, 139, legendY + 14);
    }

    // Timestamp
    ctx.font = '10px sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.fillText(`Updated: ${new Date().toLocaleString('en-GB', { timeZone: config.botTimezone })}`, imgW - 200, imgH - 8);

    return cvs.toBuffer('image/png');
  }

  /**
   * Generate a heatmap overlay showing player activity density.
   * @param {object} [opts]
   * @param {number} [opts.width=1024] - Output image width
   * @returns {Promise<Buffer|null>} PNG buffer
   */
  async generateHeatmap(opts = {}) {
    const { width = 1024 } = opts;
    this._load();

    let canvas, loadImage;
    try {
      ({ createCanvas: canvas, loadImage } = require('@napi-rs/canvas'));
    } catch {
      const canvasModule = require('@napi-rs/canvas');
      canvas = canvasModule.createCanvas;
      loadImage = canvasModule.loadImage;
    }

    const mapBuf = await this._getMapImage();
    if (!mapBuf) return null;

    const mapImg = await loadImage(mapBuf);
    const aspect = mapImg.height / mapImg.width;
    const imgW = width;
    const imgH = Math.round(width * aspect);

    const cvs = canvas(imgW, imgH);
    const ctx = cvs.getContext('2d');

    // Draw base map (dimmed)
    ctx.drawImage(mapImg, 0, 0, imgW, imgH);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
    ctx.fillRect(0, 0, imgW, imgH);

    const heatmap = this._locations.heatmap;
    if (Object.keys(heatmap).length === 0) {
      ctx.font = 'bold 20px sans-serif';
      ctx.fillStyle = '#FFFFFF';
      ctx.fillText('No activity data yet', imgW / 2 - 100, imgH / 2);
      return cvs.toBuffer('image/png');
    }

    // Find max value for normalization
    const maxVal = Math.max(...Object.values(heatmap));
    const cellW = imgW / HEATMAP_GRID;
    const cellH = imgH / HEATMAP_GRID;

    // Draw heatmap cells
    for (const [key, count] of Object.entries(heatmap)) {
      const [gx, gy] = key.split(',').map(Number);
      const intensity = count / maxVal;

      // Color gradient: blue → green → yellow → red
      let r, g, b;
      if (intensity < 0.25) {
        r = 0; g = Math.round(intensity * 4 * 255); b = 255;
      } else if (intensity < 0.5) {
        r = 0; g = 255; b = Math.round((1 - (intensity - 0.25) * 4) * 255);
      } else if (intensity < 0.75) {
        r = Math.round((intensity - 0.5) * 4 * 255); g = 255; b = 0;
      } else {
        r = 255; g = Math.round((1 - (intensity - 0.75) * 4) * 255); b = 0;
      }

      const alpha = Math.min(0.7, 0.15 + intensity * 0.55);
      // Note: Y is inverted for the heatmap grid (grid origin matches world origin)
      const px = gx * cellW;
      const py = (HEATMAP_GRID - 1 - gy) * cellH;

      ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${alpha})`;
      ctx.fillRect(px, py, cellW + 1, cellH + 1);
    }

    // Title and legend
    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.fillRect(8, 8, 200, 30);
    ctx.font = 'bold 14px sans-serif';
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText('Player Activity Heatmap', 16, 28);

    // Color scale
    const scaleY = imgH - 30;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.fillRect(8, scaleY - 4, 200, 28);
    ctx.font = '10px sans-serif';
    ctx.fillStyle = '#AAAAAA';
    ctx.fillText('Low', 14, scaleY + 14);
    ctx.fillText('High', 170, scaleY + 14);

    // Draw gradient bar
    const barStart = 40;
    const barEnd = 165;
    for (let x = barStart; x < barEnd; x++) {
      const t = (x - barStart) / (barEnd - barStart);
      let r, g, b;
      if (t < 0.25) { r = 0; g = Math.round(t * 4 * 255); b = 255; }
      else if (t < 0.5) { r = 0; g = 255; b = Math.round((1 - (t - 0.25) * 4) * 255); }
      else if (t < 0.75) { r = Math.round((t - 0.5) * 4 * 255); g = 255; b = 0; }
      else { r = 255; g = Math.round((1 - (t - 0.75) * 4) * 255); b = 0; }
      ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
      ctx.fillRect(x, scaleY + 2, 1, 12);
    }

    return cvs.toBuffer('image/png');
  }

  /**
   * Generate a movement trail image for a specific player.
   * @param {string} steamID
   * @param {object} [opts]
   * @param {number} [opts.width=1024]
   * @param {number} [opts.maxPoints=100] - Max trail points to show
   * @returns {Promise<Buffer|null>}
   */
  async generatePlayerTrail(steamID, opts = {}) {
    const { width = 1024, maxPoints = 100 } = opts;
    this._load();

    const player = this._locations.players[steamID];
    if (!player || !player.history || player.history.length < 2) return null;

    let canvas, loadImage;
    try {
      ({ createCanvas: canvas, loadImage } = require('@napi-rs/canvas'));
    } catch {
      const canvasModule = require('@napi-rs/canvas');
      canvas = canvasModule.createCanvas;
      loadImage = canvasModule.loadImage;
    }

    const mapBuf = await this._getMapImage();
    if (!mapBuf) return null;

    const mapImg = await loadImage(mapBuf);
    const aspect = mapImg.height / mapImg.width;
    const imgW = width;
    const imgH = Math.round(width * aspect);

    const cvs = canvas(imgW, imgH);
    const ctx = cvs.getContext('2d');

    // Draw base map
    ctx.drawImage(mapImg, 0, 0, imgW, imgH);

    const points = player.history.slice(-maxPoints);

    // Draw trail line (older = more transparent)
    for (let i = 1; i < points.length; i++) {
      const prev = this._worldToPixel(points[i - 1].x, points[i - 1].y, imgW, imgH);
      const curr = this._worldToPixel(points[i].x, points[i].y, imgW, imgH);
      const alpha = 0.2 + (i / points.length) * 0.8;

      ctx.beginPath();
      ctx.moveTo(prev.px, prev.py);
      ctx.lineTo(curr.px, curr.py);
      ctx.strokeStyle = `rgba(0, 150, 255, ${alpha})`;
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // Draw points (start = blue circle, end = green circle)
    if (points.length > 0) {
      const start = this._worldToPixel(points[0].x, points[0].y, imgW, imgH);
      ctx.beginPath(); ctx.arc(start.px, start.py, 6, 0, Math.PI * 2);
      ctx.fillStyle = '#0066FF'; ctx.fill();
      ctx.strokeStyle = '#003388'; ctx.lineWidth = 2; ctx.stroke();

      const end = this._worldToPixel(points[points.length - 1].x, points[points.length - 1].y, imgW, imgH);
      ctx.beginPath(); ctx.arc(end.px, end.py, 8, 0, Math.PI * 2);
      ctx.fillStyle = '#00FF44'; ctx.fill();
      ctx.strokeStyle = '#004411'; ctx.lineWidth = 2; ctx.stroke();
    }

    // Title
    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.fillRect(8, 8, 280, 30);
    ctx.font = 'bold 14px sans-serif';
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText(`Movement Trail: ${player.name} (${points.length} points)`, 16, 28);

    return cvs.toBuffer('image/png');
  }

  /** Clear all tracking data. */
  reset() {
    this._locations = { players: {}, heatmap: {}, lastUpdated: null };
    this._dirty = true;
    this._save();
  }

  /** Get a summary of tracking data. */
  getSummary() {
    this._load();
    const players = Object.values(this._locations.players);
    const online = players.filter(p => p.online).length;
    const withHistory = players.filter(p => p.history && p.history.length > 1).length;
    const totalPoints = players.reduce((s, p) => s + (p.history?.length || 0), 0);
    const heatmapCells = Object.keys(this._locations.heatmap).length;
    return {
      totalPlayers: players.length,
      online,
      offline: players.length - online,
      withHistory,
      totalPoints,
      heatmapCells,
      lastUpdated: this._locations.lastUpdated,
    };
  }

  /** Cleanup timer on shutdown. */
  destroy() {
    if (this._saveTimer) {
      clearInterval(this._saveTimer);
      this._saveTimer = null;
    }
    if (this._dirty) this._save();
  }
}

// Singleton
module.exports = new PlayerMapTracker();

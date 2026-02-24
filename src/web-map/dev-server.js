#!/usr/bin/env node
// Dev server for web map with SFTP live position fetching
const express = require('express');
const path = require('path');
const fs = require('fs');
const { parseSave: _parseSaveFull } = require('../save-parser');
function parseSave(buf) { return _parseSaveFull(buf).players; }
const Client = require('ssh2-sftp-client');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const CAL_FILE = path.join(DATA_DIR, 'map-calibration.json');

// Load .env if not already loaded (dev-server can run standalone)
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const SFTP_CONFIG = {
  host: process.env.FTP_HOST,
  port: parseInt(process.env.FTP_PORT, 10) || 2022,
  username: process.env.FTP_USER,
  password: process.env.FTP_PASSWORD,
};
const REMOTE_SAVE = '/HumanitZServer/Saved/SaveGames/SaveList/Default/Save_DedicatedSaveMP.sav';
const REMOTE_IDMAP = '/HumanitZServer/PlayerIDMapped.txt';
const REMOTE_CONNLOG = '/HumanitZServer/PlayerConnectedLog.txt';

const app = express();
app.use(express.static(PUBLIC_DIR));
app.use(express.json());

let bounds = JSON.parse(fs.readFileSync(CAL_FILE, 'utf8'));
console.log('Calibration:', bounds);

function loadIdMap() {
  const idMap = {};
  try {
    const raw = fs.readFileSync(path.join(DATA_DIR, 'PlayerIDMapped.txt'), 'utf8');
    for (const line of raw.split('\n')) {
      const m = line.trim().match(/^(\d{17})_\+_\|[^@]+@(.+)$/);
      if (m) idMap[m[1]] = m[2].trim();
    }
  } catch (e) { /* ignore */ }
  return idMap;
}

let idMap = loadIdMap();
console.log('ID map:', Object.keys(idMap).length, 'entries');
for (const [id, name] of Object.entries(idMap).slice(0, 3)) {
  console.log('  ', id, '->', name);
}

// Parse PlayerConnectedLog.txt to get last-seen dates per steamId
function parseLastSeen() {
  const lastSeen = {};
  try {
    const raw = fs.readFileSync(path.join(DATA_DIR, 'PlayerConnectedLog.txt'), 'utf8');
    for (const line of raw.split('\n')) {
      const m = line.trim().match(/^Player (?:Connected|Disconnected) .+ NetID\((\d{17})_\+_\|[^)]+\) \((\d+)\/(\d+)\/(\d+) (\d+):(\d+)\)/);
      if (m) {
        const [, steamId, day, month, year, hour, minute] = m;
        const date = new Date(+year, +month - 1, +day, +hour, +minute);
        if (!lastSeen[steamId] || date > lastSeen[steamId]) {
          lastSeen[steamId] = date;
        }
      }
    }
  } catch (e) { /* ignore */ }
  return lastSeen;
}

let lastSeenMap = parseLastSeen();
console.log('Last-seen entries:', Object.keys(lastSeenMap).length);

function getBestSave() {
  const candidates = [
    'Save_DedicatedSaveMP_CAL.sav',
    'Save_DedicatedSaveMP_FRESH2.sav',
    'Save_DedicatedSaveMP_FRESH.sav',
    'Save_DedicatedSaveMP_NE.sav',
    'Save_DedicatedSaveMP.sav',
  ];
  for (const f of candidates) {
    const p = path.join(DATA_DIR, f);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// Online players cache (refreshed via SFTP)
let onlineSteamIds = new Set();
let onlineLastFetch = 0;
const ONLINE_CACHE_MS = 15000; // 15 seconds

const REMOTE_CONNECTED = '/HumanitZServer/F_ConnectedPlayers.txt';

async function fetchOnlinePlayers() {
  if (Date.now() - onlineLastFetch < ONLINE_CACHE_MS) return onlineSteamIds;
  const sftp = new Client();
  try {
    await sftp.connect(SFTP_CONFIG);
    const buf = await sftp.get(REMOTE_CONNECTED);
    await sftp.end();
    const ids = new Set();
    for (const line of buf.toString().split('\n')) {
      const m = line.trim().match(/\|NETID\|(\d{17})_\+_\|/);
      if (m) ids.add(m[1]);
    }
    onlineSteamIds = ids;
    onlineLastFetch = Date.now();
    console.log('[SFTP] Online players:', ids.size, [...ids].join(', '));
  } catch (err) {
    console.error('[SFTP] Failed to fetch online players:', err.message);
    try { await sftp.end(); } catch (e) { /* ignore */ }
  }
  return onlineSteamIds;
}

// Build player list from current local data (no SFTP)
function buildPlayerList() {
  const savePath = getBestSave();
  if (!savePath) return [];

  const players = parseSave(fs.readFileSync(savePath));
  try { bounds = JSON.parse(fs.readFileSync(CAL_FILE, 'utf8')); } catch (e) { /* keep current */ }
  idMap = loadIdMap();
  lastSeenMap = parseLastSeen();

  const result = [];
  for (const [steamId, data] of players) {
    const name = idMap[steamId] || steamId;
    const hasPosition = data.x !== null && !(data.x === 0 && data.y === 0 && data.z === 0);
    const lat = hasPosition ? ((data.x - bounds.xMin) / (bounds.xMax - bounds.xMin)) * 4096 : null;
    const lng = hasPosition ? ((data.y - bounds.yMin) / (bounds.yMax - bounds.yMin)) * 4096 : null;
    const lastSeen = lastSeenMap[steamId] ? lastSeenMap[steamId].toISOString() : null;
    result.push({
      steamId, name, lat, lng,
      isOnline: onlineSteamIds.has(steamId),
      hasPosition, lastSeen,
      worldX: hasPosition ? Math.round(data.x) : null,
      worldY: hasPosition ? Math.round(data.y) : null,
      worldZ: hasPosition ? Math.round(data.z) : null,
      // Save parser field mapping
      kills: data.lifetimeKills || data.zeeksKilled || 0,
      headshots: data.lifetimeHeadshots || data.headshots || 0,
      meleeKills: data.lifetimeMeleeKills || data.meleeKills || 0,
      gunKills: data.lifetimeGunKills || data.gunKills || 0,
      daysSurvived: data.daysSurvived || data.lifetimeDaysSurvived || 0,
      health: data.health, hunger: data.hunger, thirst: data.thirst,
      stamina: data.stamina, immunity: data.infection,
      battery: data.battery,
      fatigue: data.fatigue,
      profession: data.startingPerk || 'Unknown',
      equipment: data.equipment || [],
      quickSlots: data.quickSlots || [],
      inventory: data.inventory || [],
      backpack: data.backpackItems || [],
      unlockedSkills: data.unlockedSkills || [],
      craftingRecipes: (data.craftingRecipes || []).length,
      buildingRecipes: (data.buildingRecipes || []).length,
    });
  }
  // Sort: online first, then by name
  result.sort((a, b) => (b.isOnline - a.isOnline) || a.name.localeCompare(b.name));
  return result;
}

// Regular endpoint — uses cached/local data (fast)
app.get('/api/players', async (req, res) => {
  // Quick online status refresh (cached 15s)
  await fetchOnlinePlayers();
  const result = buildPlayerList();
  res.json({ players: result, worldBounds: bounds });
});

// SSE refresh endpoint — downloads fresh data from SFTP with progress
app.get('/api/refresh', async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  function sendEvent(type, message, data) {
    res.write(`data: ${JSON.stringify({ type, message, ...data })}\n\n`);
  }

  const sftp = new Client();
  try {
    sendEvent('progress', 'Connecting to server...');
    await sftp.connect(SFTP_CONFIG);

    // 1. Download online players
    sendEvent('progress', 'Downloading online players...');
    try {
      const connBuf = await sftp.get(REMOTE_CONNECTED);
      const ids = new Set();
      for (const line of connBuf.toString().split('\n')) {
        const m = line.trim().match(/\|NETID\|(\d{17})_\+_\|/);
        if (m) ids.add(m[1]);
      }
      onlineSteamIds = ids;
      onlineLastFetch = Date.now();
      sendEvent('progress', `Found ${ids.size} online player${ids.size !== 1 ? 's' : ''}`);
    } catch (err) {
      sendEvent('progress', 'Online players: ' + err.message);
    }

    // 2. Download connection log (for last-seen dates)
    sendEvent('progress', 'Downloading connection log...');
    try {
      await sftp.get(REMOTE_CONNLOG, path.join(DATA_DIR, 'PlayerConnectedLog.txt'));
      lastSeenMap = parseLastSeen();
    } catch (err) {
      sendEvent('progress', 'Connection log: ' + err.message);
    }

    // 3. Download save data
    sendEvent('progress', 'Downloading save data (this may take a moment)...');
    const localSave = path.join(DATA_DIR, 'Save_DedicatedSaveMP_CAL.sav');
    await sftp.get(REMOTE_SAVE, localSave);
    const size = fs.statSync(localSave).size;
    sendEvent('progress', `Save downloaded (${(size / 1024 / 1024).toFixed(1)} MB)`);

    // 4. Download ID map
    sendEvent('progress', 'Downloading player ID map...');
    await sftp.get(REMOTE_IDMAP, path.join(DATA_DIR, 'PlayerIDMapped.txt'));
    idMap = loadIdMap();

    await sftp.end();

    // 5. Build and send player data
    sendEvent('progress', 'Processing player data...');
    const players = buildPlayerList();
    sendEvent('done', `Loaded ${players.length} players`);
  } catch (err) {
    console.error('[SFTP refresh] Error:', err.message);
    sendEvent('error', 'SFTP error: ' + err.message);
    try { await sftp.end(); } catch (e) { /* ignore */ }
  } finally {
    res.end();
  }
});

app.get('/api/calibration', (req, res) => {
  try { bounds = JSON.parse(fs.readFileSync(CAL_FILE, 'utf8')); } catch (e) { /* keep */ }
  res.json(bounds);
});

// Live SFTP fetch for calibration
app.get('/api/fetch-position/:steamId', async (req, res) => {
  const { steamId } = req.params;
  console.log('[SFTP] Fetching fresh save for', steamId);
  const sftp = new Client();
  const localSave = path.join(DATA_DIR, 'Save_DedicatedSaveMP_CAL.sav');

  try {
    await sftp.connect(SFTP_CONFIG);
    await sftp.get(REMOTE_SAVE, localSave);
    await sftp.get(REMOTE_IDMAP, path.join(DATA_DIR, 'PlayerIDMapped.txt'));
    await sftp.end();

    console.log('[SFTP] Downloaded', fs.statSync(localSave).size, 'bytes');
    idMap = loadIdMap();

    const players = parseSave(fs.readFileSync(localSave));
    const p = players.get(steamId);
    if (!p || p.x === null) {
      return res.json({ error: 'Player not found in save or has no position' });
    }

    const name = idMap[steamId] || steamId;
    console.log('[SFTP]', name, ': X=' + p.x.toFixed(2), 'Y=' + p.y.toFixed(2));
    res.json({ steamId, name, worldX: Math.round(p.x), worldY: Math.round(p.y), worldZ: Math.round(p.z) });
  } catch (err) {
    console.error('[SFTP] Error:', err.message);
    try { await sftp.end(); } catch (e) { /* ignore */ }
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/calibrate-from-points', (req, res) => {
  const { point1, point2 } = req.body;
  if (!point1 || !point2) return res.status(400).json({ error: 'Need 2 points' });

  const xSpan = (point2.worldX - point1.worldX) / ((point2.pixelY - point1.pixelY) / 4096);
  const xMin = Math.round(point1.worldX - (point1.pixelY / 4096) * xSpan);
  const xMax = Math.round(xMin + xSpan);

  const ySpan = (point2.worldY - point1.worldY) / ((point2.pixelX - point1.pixelX) / 4096);
  const yMin = Math.round(point1.worldY - (point1.pixelX / 4096) * ySpan);
  const yMax = Math.round(yMin + ySpan);

  bounds = { xMin, xMax, yMin, yMax };
  fs.writeFileSync(CAL_FILE, JSON.stringify(bounds, null, 2));
  console.log('Calibration saved:', bounds);
  res.json({ ok: true, bounds });
});

app.post('/api/admin/kick', (req, res) => {
  console.log('[ADMIN] Kick:', req.body.steamId);
  res.json({ ok: true, result: 'dev mode — kick command logged' });
});
app.post('/api/admin/ban', (req, res) => {
  console.log('[ADMIN] Ban:', req.body.steamId);
  res.json({ ok: true, result: 'dev mode — ban command logged' });
});
app.post('/api/admin/message', (req, res) => {
  console.log('[ADMIN] Message:', req.body.message);
  res.json({ ok: true, result: 'dev mode — message logged' });
});

const PORT = process.env.MAP_PORT || 3000;
app.listen(PORT, () => {
  console.log('===========================================');
  console.log(`  HumanitZ Web Map: http://localhost:${PORT}`);
  console.log('  With LIVE SFTP position fetching');
  console.log('  Calibration:', JSON.stringify(bounds));
  console.log('===========================================');
});

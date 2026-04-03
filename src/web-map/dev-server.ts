/**
 * Dev server for web map with SFTP live position fetching
 */

import express from 'express';
import path from 'path';
import fs from 'fs';
import { parseSave as _parseSaveFull } from '../parsers/save-parser.js';
import { getDirname } from '../utils/paths.js';
import expressRateLimit from 'express-rate-limit';

const __dirname = getDirname(import.meta.url);

function parseSave(buf: Buffer): Map<string, any> {
  return (_parseSaveFull(buf) as any).players;
}

import Client from 'ssh2-sftp-client';

function rateLimit(windowMs: number, maxReqs: number) {
  return expressRateLimit({
    windowMs,
    max: maxReqs,
    standardHeaders: false,
    legacyHeaders: false,
    keyGenerator: (req) => (req.ip || '') + ':' + req.path,
  });
}

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const CAL_FILE = path.join(DATA_DIR, 'map-calibration.json');

// Load .env if not already loaded (dev-server can run standalone)
import dotenv from 'dotenv';
dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });

const SFTP_CONFIG = {
  host: process.env.SFTP_HOST || process.env.FTP_HOST,
  port: parseInt(process.env.SFTP_PORT || process.env.FTP_PORT || '2022', 10) || 2022,
  username: process.env.SFTP_USER || process.env.FTP_USER,
  password: process.env.SFTP_PASSWORD || process.env.FTP_PASSWORD,
};
const REMOTE_SAVE = '/HumanitZServer/Saved/SaveGames/SaveList/Default/Save_DedicatedSaveMP.sav';
const REMOTE_IDMAP = '/HumanitZServer/PlayerIDMapped.txt';
const REMOTE_CONNLOG = '/HumanitZServer/PlayerConnectedLog.txt';

const app = express();
app.use(express.static(PUBLIC_DIR));
app.use(express.json());

let bounds: any = JSON.parse(fs.readFileSync(CAL_FILE, 'utf8'));
console.log('Calibration:', bounds);

function loadIdMap(): Record<string, string> {
  const idMap: Record<string, string> = {};
  try {
    const raw = fs.readFileSync(path.join(DATA_DIR, 'logs', 'PlayerIDMapped.txt'), 'utf8');
    for (const line of raw.split('\n')) {
      const m = line.trim().match(/^(\d{17})_\+_\|[^@]+@(.+)$/);
      if (m?.[1] && m[2]) idMap[m[1]] = m[2].trim();
    }
  } catch {
    /* ignore */
  }
  return idMap;
}

let idMap = loadIdMap();
console.log('ID map:', Object.keys(idMap).length, 'entries');
for (const [id, name] of Object.entries(idMap).slice(0, 3)) {
  console.log('  ', id, '->', name);
}

function parseLastSeen(): Record<string, Date> {
  const lastSeen: Record<string, Date> = {};
  try {
    const raw = fs.readFileSync(path.join(DATA_DIR, 'logs', 'PlayerConnectedLog.txt'), 'utf8');
    for (const line of raw.split('\n')) {
      const m = line
        .trim()
        .match(
          /^Player (?:Connected|Disconnected) .+ NetID\((\d{17})_\+_\|[^)]+\) \((\d+)\/(\d+)\/(\d+) (\d+):(\d+)\)/,
        );
      if (m?.[1]) {
        const [, steamId, day, month, year, hour, minute] = m;
        const date = new Date(+(year ?? 0), +(month ?? 1) - 1, +(day ?? 1), +(hour ?? 0), +(minute ?? 0));
        if (!steamId) continue;
        if (!lastSeen[steamId] || date > lastSeen[steamId]) {
          lastSeen[steamId] = date;
        }
      }
    }
  } catch {
    /* ignore */
  }
  return lastSeen;
}

let lastSeenMap = parseLastSeen();
console.log('Last-seen entries:', Object.keys(lastSeenMap).length);

function getBestSave(): string | null {
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

let onlineSteamIds = new Set<string>();
let onlineLastFetch = 0;
const ONLINE_CACHE_MS = 15000;

const REMOTE_CONNECTED = '/HumanitZServer/F_ConnectedPlayers.txt';

async function fetchOnlinePlayers(): Promise<Set<string>> {
  if (Date.now() - onlineLastFetch < ONLINE_CACHE_MS) return onlineSteamIds;
  const sftp = new Client();
  try {
    await sftp.connect(SFTP_CONFIG);
    const buf = (await sftp.get(REMOTE_CONNECTED)) as Buffer;
    await sftp.end();
    const ids = new Set<string>();
    for (const line of buf.toString().split('\n')) {
      const m = line.trim().match(/\|NETID\|(\d{17})_\+_\|/);
      if (m?.[1]) ids.add(m[1]);
    }
    onlineSteamIds = ids;
    onlineLastFetch = Date.now();
    console.log('[SFTP] Online players:', ids.size, [...ids].join(', '));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[SFTP] Failed to fetch online players:', msg);
    try {
      await sftp.end();
    } catch {
      /* ignore */
    }
  }
  return onlineSteamIds;
}

function buildPlayerList(): any[] {
  const savePath = getBestSave();
  if (!savePath) return [];

  const players: Map<string, any> = parseSave(fs.readFileSync(savePath));
  try {
    bounds = JSON.parse(fs.readFileSync(CAL_FILE, 'utf8'));
  } catch {
    /* keep current */
  }
  idMap = loadIdMap();
  lastSeenMap = parseLastSeen();

  const result: any[] = [];
  for (const [steamId, data] of players) {
    const name = idMap[steamId] || steamId;
    const hasPosition = data.x !== null && !(data.x === 0 && data.y === 0 && data.z === 0);
    const lat = hasPosition ? ((data.x - bounds.xMin) / (bounds.xMax - bounds.xMin)) * 4096 : null;
    const lng = hasPosition ? ((data.y - bounds.yMin) / (bounds.yMax - bounds.yMin)) * 4096 : null;
    const lastSeen = lastSeenMap[steamId] ? lastSeenMap[steamId].toISOString() : null;
    result.push({
      steamId,
      name,
      lat,
      lng,
      isOnline: onlineSteamIds.has(steamId),
      hasPosition,
      lastSeen,
      worldX: hasPosition ? Math.round(data.x) : null,
      worldY: hasPosition ? Math.round(data.y) : null,
      worldZ: hasPosition ? Math.round(data.z) : null,
      kills: data.lifetimeKills || data.zeeksKilled || 0,
      headshots: data.lifetimeHeadshots || data.headshots || 0,
      meleeKills: data.lifetimeMeleeKills || data.meleeKills || 0,
      gunKills: data.lifetimeGunKills || data.gunKills || 0,
      daysSurvived: data.daysSurvived || data.lifetimeDaysSurvived || 0,
      health: data.health,
      hunger: data.hunger,
      thirst: data.thirst,
      stamina: data.stamina,
      immunity: data.infection,
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
  result.sort(
    (a, b) => (b.isOnline as number) - (a.isOnline as number) || (a.name as string).localeCompare(b.name as string),
  );
  return result;
}

app.get('/api/players', async (_req, res) => {
  await fetchOnlinePlayers();
  const result = buildPlayerList();
  res.json({ players: result, worldBounds: bounds });
});

app.get('/api/refresh', async (_req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  function sendEvent(type: string, message: string, data?: Record<string, unknown>): void {
    res.write(`data: ${JSON.stringify({ type, message, ...data })}\n\n`);
  }

  const sftp = new Client();
  try {
    sendEvent('progress', 'Connecting to server...');
    await sftp.connect(SFTP_CONFIG);

    sendEvent('progress', 'Downloading online players...');
    try {
      const connBuf = (await sftp.get(REMOTE_CONNECTED)) as Buffer;
      const ids = new Set<string>();
      for (const line of connBuf.toString().split('\n')) {
        const m = line.trim().match(/\|NETID\|(\d{17})_\+_\|/);
        if (m?.[1]) ids.add(m[1]);
      }
      onlineSteamIds = ids;
      onlineLastFetch = Date.now();
      sendEvent('progress', `Found ${String(ids.size)} online player${ids.size !== 1 ? 's' : ''}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      sendEvent('progress', 'Online players: ' + msg);
    }

    sendEvent('progress', 'Downloading connection log...');
    try {
      await sftp.get(REMOTE_CONNLOG, path.join(DATA_DIR, 'logs', 'PlayerConnectedLog.txt'));
      lastSeenMap = parseLastSeen();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      sendEvent('progress', 'Connection log: ' + msg);
    }

    sendEvent('progress', 'Downloading save data (this may take a moment)...');
    const localSave = path.join(DATA_DIR, 'Save_DedicatedSaveMP_CAL.sav');
    await sftp.get(REMOTE_SAVE, localSave);
    const size = fs.statSync(localSave).size;
    sendEvent('progress', `Save downloaded (${(size / 1024 / 1024).toFixed(1)} MB)`);

    sendEvent('progress', 'Downloading player ID map...');
    await sftp.get(REMOTE_IDMAP, path.join(DATA_DIR, 'logs', 'PlayerIDMapped.txt'));
    idMap = loadIdMap();

    await sftp.end();

    sendEvent('progress', 'Processing player data...');
    const players = buildPlayerList();
    sendEvent('done', `Loaded ${String(players.length)} players`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[SFTP refresh] Error:', msg);
    sendEvent('error', 'SFTP error: ' + msg);
    try {
      await sftp.end();
    } catch {
      /* ignore */
    }
  } finally {
    res.end();
  }
});

app.get('/api/calibration', rateLimit(10000, 10), (_req, res) => {
  try {
    bounds = JSON.parse(fs.readFileSync(CAL_FILE, 'utf8'));
  } catch {
    /* keep */
  }
  res.json(bounds);
});

app.get('/api/fetch-position/:steamId', async (req, res) => {
  const { steamId } = req.params;
  console.log('[SFTP] Fetching fresh save for', steamId);
  const sftp = new Client();
  const localSave = path.join(DATA_DIR, 'Save_DedicatedSaveMP_CAL.sav');

  try {
    await sftp.connect(SFTP_CONFIG);
    await sftp.get(REMOTE_SAVE, localSave);
    await sftp.get(REMOTE_IDMAP, path.join(DATA_DIR, 'logs', 'PlayerIDMapped.txt'));
    await sftp.end();

    console.log('[SFTP] Downloaded', fs.statSync(localSave).size, 'bytes');
    idMap = loadIdMap();

    const players: Map<string, any> = parseSave(fs.readFileSync(localSave));
    const p = players.get(steamId);
    if (!p || p.x === null) {
      return res.json({ error: 'Player not found in save or has no position' });
    }

    const name = idMap[steamId] || steamId;
    console.log('[SFTP]', name, ': X=' + (p.x as number).toFixed(2), 'Y=' + (p.y as number).toFixed(2));
    res.json({ steamId, name, worldX: Math.round(p.x), worldY: Math.round(p.y), worldZ: Math.round(p.z) });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[SFTP] Error:', msg);
    try {
      await sftp.end();
    } catch {
      /* ignore */
    }
    res.status(500).json({ error: msg });
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

const PORT = process.env.WEB_MAP_PORT || process.env.MAP_PORT || 3000;
app.listen(PORT, () => {
  console.log('===========================================');
  console.log(`  HumanitZ Web Map: http://localhost:${String(PORT)}`);
  console.log('  With LIVE SFTP position fetching');
  console.log('  Calibration:', JSON.stringify(bounds));
  console.log('===========================================');
});

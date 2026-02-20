#!/usr/bin/env node
/**
 * setup.js — Unified setup, import, and validation utility for HumanitZ Bot.
 *
 *
 * Modes:
 *   node setup.js               Full first-run: download logs via SFTP, import all data
 *   node setup.js --find        Explore SFTP directory structure to locate files
 *   node setup.js --validate    Download logs via SFTP, compare against existing data
 *   node setup.js --fix         Same as default — download and rebuild all data files
 *   node setup.js --local       Use previously downloaded files in data/ (skip SFTP)
 *
 * Requires a configured .env file with FTP_* settings for SFTP access.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const SftpClient = require('ssh2-sftp-client');

// ── Constants ─────────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, 'data');
const STATS_FILE = path.join(DATA_DIR, 'player-stats.json');
const PLAYTIME_FILE = path.join(DATA_DIR, 'playtime.json');
const LOG_CACHE = path.join(DATA_DIR, 'HMZLog-downloaded.log');
const CONNECTED_LOG_CACHE = path.join(DATA_DIR, 'PlayerConnectedLog.txt');
const ID_MAP_CACHE = path.join(DATA_DIR, 'PlayerIDMapped.txt');

const ftpConfig = {
  host: process.env.FTP_HOST,
  port: parseInt(process.env.FTP_PORT, 10) || 8821,
  username: process.env.FTP_USER,
  password: process.env.FTP_PASSWORD,
};
const ftpLogPath = process.env.FTP_LOG_PATH || '/HumanitZServer/HMZLog.log';
const ftpConnectLogPath = process.env.FTP_CONNECT_LOG_PATH || '/HumanitZServer/PlayerConnectedLog.txt';
const ftpIdMapPath = process.env.FTP_ID_MAP_PATH || '/HumanitZServer/PlayerIDMapped.txt';

// ── CLI Args ──────────────────────────────────────────────────
const args = process.argv.slice(2);
const MODE_FIND = args.includes('--find');
const MODE_VALIDATE = args.includes('--validate');
const MODE_LOCAL = args.includes('--local');

// ── Shared Helpers ────────────────────────────────────────────

function formatDuration(ms) {
  const hours = Math.floor(ms / 3600000);
  const mins = Math.floor((ms % 3600000) / 60000);
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function cleanName(name) {
  return name.trim();
}

function classifyDamageSource(source) {
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
  if (!source.startsWith('BP_')) return 'Player';
  return 'Other';
}

function simplifyBlueprintName(rawName) {
  return rawName
    .replace(/^BP_/, '')
    .replace(/_C_\d+.*$/, '')
    .replace(/_C$/, '')
    .replace(/_/g, ' ')
    .trim();
}

function newRecord(name) {
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

function backupAndSave(filePath, data, label) {
  if (fs.existsSync(filePath)) {
    const backup = filePath.replace('.json', `-backup-${Date.now()}.json`);
    fs.copyFileSync(filePath, backup);
    console.log(`  Backed up ${label} → ${path.basename(backup)}`);
  }
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  console.log(`  Saved ${label}`);
}

// ── SFTP: Explore Directories ─────────────────────────────────

async function exploreDirectories() {
  if (!ftpConfig.host || !ftpConfig.username) {
    console.error('Missing FTP credentials in .env (FTP_HOST, FTP_USER, FTP_PASSWORD).');
    process.exit(1);
  }

  const sftp = new SftpClient();
  try {
    await sftp.connect(ftpConfig);
    console.log('Connected! Listing root directory...\n');

    const root = await sftp.list('/');
    console.log('/ contents:');
    for (const item of root) {
      console.log(`  ${item.type === 'd' ? '[DIR]' : '[FILE]'} ${item.name}${item.type !== 'd' ? ` (${item.size} bytes)` : ''}`);
    }

    const pathsToTry = [
      '/HumanitZ', '/humanitz', '/HumanitZServer',
      '/HumanitZServer/Saved', '/HumanitZServer/Saved/SaveGames',
      '/Saved', '/Logs', '/home', '/server', '/game',
    ];

    for (const p of pathsToTry) {
      try {
        const items = await sftp.list(p);
        console.log(`\n${p}/ contents:`);
        for (const item of items) {
          console.log(`  ${item.type === 'd' ? '[DIR]' : '[FILE]'} ${item.name}${item.type !== 'd' ? ` (${item.size} bytes)` : ''}`);
        }
      } catch (_) {}
    }

    console.log('\n--- Searching for .log, .txt, .sav files (3 levels deep) ---');
    await searchFiles(sftp, '/', 0, 3);
  } catch (err) {
    console.error('SFTP Error:', err.message);
  } finally {
    await sftp.end().catch(() => {});
  }
}

async function searchFiles(sftp, dir, depth, maxDepth) {
  if (depth >= maxDepth) return;
  try {
    const items = await sftp.list(dir);
    for (const item of items) {
      const fullPath = dir === '/' ? `/${item.name}` : `${dir}/${item.name}`;
      if (item.type === 'd') {
        await searchFiles(sftp, fullPath, depth + 1, maxDepth);
      } else if (/\.(log|txt|sav)$/i.test(item.name)) {
        console.log(`  ${fullPath} (${(item.size / 1024).toFixed(1)} KB)`);
      }
    }
  } catch (_) {}
}

// ── SFTP: Download Files ──────────────────────────────────────

/**
 * Download HMZLog.log, PlayerConnectedLog.txt, and PlayerIDMapped.txt via SFTP.
 * Returns { hmzLog, connectedLog, idMapRaw } as strings (null if not found).
 */
async function downloadFiles() {
  if (!ftpConfig.host || !ftpConfig.username) {
    console.error('Missing FTP credentials in .env. Use --find to explore, or --local for cached files.');
    process.exit(1);
  }

  const sftp = new SftpClient();
  let hmzLog = null, connectedLog = null, idMapRaw = null;

  try {
    console.log(`Connecting to ${ftpConfig.host}:${ftpConfig.port}...`);
    await sftp.connect(ftpConfig);
    console.log('Connected!\n');

    // HMZLog.log
    try {
      const buf = await sftp.get(ftpLogPath);
      hmzLog = buf.toString('utf8');
      fs.writeFileSync(LOG_CACHE, hmzLog, 'utf8');
      console.log(`  HMZLog.log — ${(hmzLog.length / 1024).toFixed(1)} KB`);
    } catch (err) {
      console.warn(`  HMZLog.log — not found: ${err.message}`);
    }

    // PlayerConnectedLog.txt
    try {
      const buf = await sftp.get(ftpConnectLogPath);
      connectedLog = buf.toString('utf8');
      fs.writeFileSync(CONNECTED_LOG_CACHE, connectedLog, 'utf8');
      console.log(`  PlayerConnectedLog.txt — ${(connectedLog.length / 1024).toFixed(1)} KB`);
    } catch (err) {
      console.warn(`  PlayerConnectedLog.txt — not found: ${err.message}`);
    }

    // PlayerIDMapped.txt
    try {
      const buf = await sftp.get(ftpIdMapPath);
      idMapRaw = buf.toString('utf8');
      fs.writeFileSync(ID_MAP_CACHE, idMapRaw, 'utf8');
      console.log(`  PlayerIDMapped.txt — ${(idMapRaw.length / 1024).toFixed(1)} KB`);
    } catch (err) {
      console.warn(`  PlayerIDMapped.txt — not found: ${err.message}`);
    }

    await sftp.end();
  } catch (err) {
    console.error('SFTP connection error:', err.message);
    await sftp.end().catch(() => {});

    // Fall back to cached files
    if (fs.existsSync(LOG_CACHE)) {
      console.log('\nFalling back to cached files...');
      return loadLocalFiles();
    }
  }

  return { hmzLog, connectedLog, idMapRaw };
}

/** Load previously downloaded files from data/ */
function loadLocalFiles() {
  console.log('Loading cached files from data/...\n');
  let hmzLog = null, connectedLog = null, idMapRaw = null;

  if (fs.existsSync(LOG_CACHE)) {
    hmzLog = fs.readFileSync(LOG_CACHE, 'utf8');
    console.log(`  HMZLog-downloaded.log — ${(hmzLog.length / 1024).toFixed(1)} KB`);
  } else if (fs.existsSync(path.join(DATA_DIR, 'HMZLog.log'))) {
    hmzLog = fs.readFileSync(path.join(DATA_DIR, 'HMZLog.log'), 'utf8');
    console.log(`  HMZLog.log — ${(hmzLog.length / 1024).toFixed(1)} KB`);
  } else {
    console.warn('  HMZLog.log — not found in data/');
  }

  if (fs.existsSync(CONNECTED_LOG_CACHE)) {
    connectedLog = fs.readFileSync(CONNECTED_LOG_CACHE, 'utf8');
    console.log(`  PlayerConnectedLog.txt — ${(connectedLog.length / 1024).toFixed(1)} KB`);
  } else {
    console.warn('  PlayerConnectedLog.txt — not found in data/');
  }

  if (fs.existsSync(ID_MAP_CACHE)) {
    idMapRaw = fs.readFileSync(ID_MAP_CACHE, 'utf8');
    console.log(`  PlayerIDMapped.txt — ${(idMapRaw.length / 1024).toFixed(1)} KB`);
  } else {
    console.warn('  PlayerIDMapped.txt — not found in data/');
  }

  return { hmzLog, connectedLog, idMapRaw };
}

// ── Parsers ───────────────────────────────────────────────────

/**
 * Parse PlayerIDMapped.txt into a name→steamId map.
 * Format: 76561198000000000_+_|<guid>@PlayerName
 */
function parseIdMap(content) {
  const map = new Map();
  if (!content) return map;
  for (const line of content.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const m = line.trim().match(/^(\d{17})_\+_\|[^@]+@(.+)$/);
    if (m) map.set(m[2].trim().toLowerCase(), m[1]);
  }
  return map;
}

/**
 * Parse HMZLog.log into structured player data.
 * Returns { players, nameOnly, counts, earliestEvent, totalEvents }.
 */
function parseFullLog(content) {
  const result = {
    players: {},     // steamId → full record
    nameOnly: {},    // name → partial record (deaths, damage — no SteamID in log)
    totalEvents: 0,
    earliestEvent: null,
    counts: { deaths: 0, builds: 0, damage: 0, loots: 0, raids: 0, admin: 0, cheat: 0, skipped: 0 },
  };

  function getOrCreate(steamId, name) {
    if (!result.players[steamId]) result.players[steamId] = newRecord(name);
    else result.players[steamId].name = name;
    return result.players[steamId];
  }

  function getOrCreateByName(name) {
    const lower = name.toLowerCase();
    for (const r of Object.values(result.players)) {
      if (r.name.toLowerCase() === lower) return r;
    }
    if (!result.nameOnly[name]) {
      result.nameOnly[name] = { deaths: 0, damageTaken: {}, adminAccess: 0, lastEvent: null };
    }
    return result.nameOnly[name];
  }

  for (const rawLine of content.split('\n')) {
    const line = rawLine.replace(/^\uFEFF/, '').trim();
    if (!line) continue;

    const lm = line.match(/^\((\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{1,2})\)\s+(.+)$/);
    if (!lm) { result.counts.skipped++; continue; }

    const [, day, month, year, hour, min, body] = lm;
    const ts = new Date(
      `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}T${hour.padStart(2, '0')}:${min.padStart(2, '0')}:00Z`
    ).toISOString();

    if (!result.earliestEvent || ts < result.earliestEvent) result.earliestEvent = ts;
    result.totalEvents++;

    let m;

    // ── Player death ──
    m = body.match(/^Player died \((.+)\)$/);
    if (m) {
      const r = getOrCreateByName(m[1].trim());
      r.deaths++;
      r.lastEvent = ts;
      result.counts.deaths++;
      continue;
    }

    // ── Build completed ──
    m = body.match(/^(.+?)\((\d{17})[^)]*\)\s*finished building\s+(.+)$/);
    if (m) {
      const r = getOrCreate(m[2], m[1].trim());
      const item = simplifyBlueprintName(m[3].trim());
      r.builds++;
      r.buildItems[item] = (r.buildItems[item] || 0) + 1;
      r.lastEvent = ts;
      result.counts.builds++;
      continue;
    }

    // ── Damage taken ──
    m = body.match(/^(.+?)\s+took\s+([\d.]+)\s+damage from\s+(.+)$/);
    if (m) {
      if (parseFloat(m[2]) > 0) {
        const r = getOrCreateByName(m[1].trim());
        const src = classifyDamageSource(m[3].trim());
        r.damageTaken[src] = (r.damageTaken[src] || 0) + 1;
        r.lastEvent = ts;
        result.counts.damage++;
      }
      continue;
    }

    // ── Container looted ──
    m = body.match(/^(.+?)\s*\((\d{17})[^)]*\)\s*looted a container\s*\([^)]+\)\s*owner by\s*(\d{17})/);
    if (m) {
      if (m[2] !== m[3]) {
        const r = getOrCreate(m[2], m[1].trim());
        r.containersLooted++;
        r.lastEvent = ts;
        result.counts.loots++;
      }
      continue;
    }

    // ── Raid (building damage by another player) ──
    m = body.match(
      /^Building \(([^)]+)\) owned by \((\d{17}[^)]*)\) damaged \([\d.]+\) by (.+?)(?:\((\d{17})[^)]*\))?(\s*\(Destroyed\))?$/
    );
    if (m) {
      const ownerSteamId = m[2].match(/^(\d{17})/)?.[1];
      const attackerRaw = m[3].trim();
      const attackerSteamId = m[4];
      const destroyed = !!m[5];

      if (attackerRaw === 'Decayfalse' || attackerRaw === 'Zeek') continue;
      if (attackerSteamId && ownerSteamId && attackerSteamId === ownerSteamId) continue;
      if (!ownerSteamId) continue;

      if (attackerSteamId) {
        const a = getOrCreate(attackerSteamId, attackerRaw);
        a.raidsOut++;
        if (destroyed) a.destroyedOut++;
        a.lastEvent = ts;
      }
      const o = result.players[ownerSteamId];
      if (o) { o.raidsIn++; if (destroyed) o.destroyedIn++; o.lastEvent = ts; }
      result.counts.raids++;
      continue;
    }

    // ── Admin access ──
    m = body.match(/^(.+?)\s+gained admin access!$/);
    if (m) {
      const r = getOrCreateByName(m[1].trim());
      r.adminAccess = (r.adminAccess || 0) + 1;
      r.lastEvent = ts;
      result.counts.admin++;
      continue;
    }

    // ── Anti-cheat flags ──
    m = body.match(/^(Stack limit detected in drop function|Odd behavior.*?Cheat)\s*\((.+?)\s*-\s*(\d{17})/);
    if (m) {
      const r = getOrCreate(m[3], m[2].trim());
      if (!r.cheatFlags) r.cheatFlags = [];
      r.cheatFlags.push({ type: m[1].trim(), timestamp: ts });
      r.lastEvent = ts;
      result.counts.cheat++;
      continue;
    }
  }

  return result;
}

/**
 * Parse PlayerConnectedLog.txt into playtime data + connect/disconnect counts.
 * Format: Player Connected PlayerName NetID(steamId_+_|...) (DD/MM/YYYY HH:MM)
 */
function parseConnectedLog(content) {
  const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/).filter(l => l.trim());
  const events = [];

  for (const line of lines) {
    const m = line.match(
      /^Player (Connected|Disconnected)\s+(.+?)\s+NetID\((\d{17})[^)]*\)\s*\((\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{1,2})\)/
    );
    if (!m) continue;
    const [, action, name, steamId, day, month, year, hour, min] = m;
    const ts = new Date(
      `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}T${hour.padStart(2, '0')}:${min.padStart(2, '0')}:00Z`
    );
    events.push({ action, name: name.trim(), steamId, ts });
  }

  // Build sessions
  const players = {};       // steamId → { name, sessions[] }
  const activeSessions = {}; // steamId → start Date
  const connectCounts = {};  // steamId → { connects, disconnects }

  for (const evt of events) {
    if (!players[evt.steamId]) players[evt.steamId] = { name: evt.name, sessions: [] };
    players[evt.steamId].name = evt.name;

    if (!connectCounts[evt.steamId]) connectCounts[evt.steamId] = { connects: 0, disconnects: 0 };

    if (evt.action === 'Connected') {
      activeSessions[evt.steamId] = evt.ts;
      connectCounts[evt.steamId].connects++;
    } else {
      connectCounts[evt.steamId].disconnects++;
      const start = activeSessions[evt.steamId];
      if (start) {
        const duration = evt.ts.getTime() - start.getTime();
        if (duration > 0) {
          players[evt.steamId].sessions.push({
            start: start.getTime(),
            end: evt.ts.getTime(),
            durationMs: duration,
          });
        }
        delete activeSessions[evt.steamId];
      }
    }
  }

  // Close any still-open sessions at the last event time
  if (events.length > 0) {
    const lastTs = events[events.length - 1].ts;
    for (const [steamId, start] of Object.entries(activeSessions)) {
      if (players[steamId]) {
        const duration = lastTs.getTime() - start.getTime();
        if (duration > 0) {
          players[steamId].sessions.push({
            start: start.getTime(),
            end: lastTs.getTime(),
            durationMs: duration,
          });
        }
      }
    }
  }

  // Build playtime.json structure
  let earliest = Infinity;
  for (const evt of events) {
    if (evt.ts.getTime() < earliest) earliest = evt.ts.getTime();
  }

  // Preserve existing peaks if available
  let existingPeaks = null;
  try {
    if (fs.existsSync(PLAYTIME_FILE)) {
      const existing = JSON.parse(fs.readFileSync(PLAYTIME_FILE, 'utf8'));
      existingPeaks = existing.peaks;
    }
  } catch (_) {}

  const playtimeData = {
    trackingSince: earliest < Infinity ? new Date(earliest).toISOString() : new Date().toISOString(),
    players: {},
    peaks: existingPeaks || {
      allTimePeak: 0,
      allTimePeakDate: null,
      todayPeak: 0,
      todayDate: new Date().toISOString().split('T')[0],
      uniqueToday: [],
    },
  };

  for (const [steamId, info] of Object.entries(players)) {
    const totalMs = info.sessions.reduce((s, sess) => s + sess.durationMs, 0);
    const firstSeen = info.sessions.length > 0
      ? new Date(Math.min(...info.sessions.map(s => s.start))).toISOString()
      : null;
    const lastSeen = info.sessions.length > 0
      ? new Date(Math.max(...info.sessions.map(s => s.end))).toISOString()
      : null;
    const lastLogin = info.sessions.length > 0
      ? new Date(info.sessions[info.sessions.length - 1].start).toISOString()
      : null;

    playtimeData.players[steamId] = {
      name: cleanName(info.name),
      totalMs,
      sessions: info.sessions.length,
      firstSeen,
      lastLogin,
      lastSeen,
    };
  }

  return { playtimeData, connectCounts, eventCount: events.length };
}

/**
 * Estimate playtime from HMZLog.log activity events (fallback).
 * Groups events into sessions by 30-min gap, adds 15-min buffer per session.
 */
function estimatePlaytimeFromLog(content) {
  const SESSION_GAP = 30 * 60 * 1000;
  const SESSION_BUFFER = 15 * 60 * 1000;
  const playerEvents = {}; // steamId → { name, timestamps }

  for (const rawLine of content.split('\n')) {
    const line = rawLine.replace(/^\uFEFF/, '').trim();
    if (!line) continue;

    const lm = line.match(/^\((\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{1,2})\)\s+(.+)$/);
    if (!lm) continue;

    const [, day, month, year, hour, min, body] = lm;
    const ts = new Date(
      `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}T${hour.padStart(2, '0')}:${min.padStart(2, '0')}:00Z`
    );

    let m;
    // Build events
    m = body.match(/^(.+?)\((\d{17})[^)]*\)\s*finished building/);
    if (m) { addEvt(m[2], m[1].trim(), ts); continue; }
    // Loot events
    m = body.match(/^(.+?)\s*\((\d{17})[^)]*\)\s*looted a container/);
    if (m) { addEvt(m[2], m[1].trim(), ts); continue; }
    // Raid events (attacker)
    m = body.match(/damaged \([\d.]+\) by (.+?)\((\d{17})[^)]*\)/);
    if (m && !body.includes('Decayfalse')) { addEvt(m[2], m[1].trim(), ts); continue; }
  }

  function addEvt(steamId, name, ts) {
    if (!playerEvents[steamId]) playerEvents[steamId] = { name, timestamps: [] };
    playerEvents[steamId].name = name;
    playerEvents[steamId].timestamps.push(ts.getTime());
  }

  let earliest = Infinity;
  for (const info of Object.values(playerEvents)) {
    for (const t of info.timestamps) {
      if (t < earliest) earliest = t;
    }
  }

  // Preserve existing peaks
  let existingPeaks = null;
  try {
    if (fs.existsSync(PLAYTIME_FILE)) {
      const existing = JSON.parse(fs.readFileSync(PLAYTIME_FILE, 'utf8'));
      existingPeaks = existing.peaks;
    }
  } catch (_) {}

  const playtimeData = {
    trackingSince: earliest < Infinity ? new Date(earliest).toISOString() : new Date().toISOString(),
    players: {},
    peaks: existingPeaks || {
      allTimePeak: 0,
      allTimePeakDate: null,
      todayPeak: 0,
      todayDate: new Date().toISOString().split('T')[0],
      uniqueToday: [],
    },
  };

  for (const [steamId, info] of Object.entries(playerEvents)) {
    const timestamps = info.timestamps.sort((a, b) => a - b);
    if (timestamps.length === 0) continue;

    const sessions = [];
    let sStart = timestamps[0], sEnd = timestamps[0];
    for (let i = 1; i < timestamps.length; i++) {
      if (timestamps[i] - sEnd > SESSION_GAP) {
        sessions.push({ start: sStart, end: sEnd });
        sStart = timestamps[i];
      }
      sEnd = timestamps[i];
    }
    sessions.push({ start: sStart, end: sEnd });

    let totalMs = 0;
    for (const s of sessions) totalMs += (s.end - s.start) + SESSION_BUFFER;

    playtimeData.players[steamId] = {
      name: cleanName(info.name),
      totalMs,
      sessions: sessions.length,
      firstSeen: new Date(timestamps[0]).toISOString(),
      lastLogin: new Date(timestamps[timestamps.length - 1]).toISOString(),
      lastSeen: new Date(timestamps[timestamps.length - 1]).toISOString(),
    };
  }

  return { playtimeData, connectCounts: {}, eventCount: 0 };
}

// ── Name Resolution ───────────────────────────────────────────

/**
 * Merge name-only records (deaths, damage without SteamIDs) into SteamID records
 * using all available name→ID sources.
 */
function mergeNameRecords(parsed, idMap, playtimeData) {
  // Build comprehensive name→SteamID map
  const nameToId = new Map(idMap);
  for (const [steamId, info] of Object.entries(parsed.players)) {
    nameToId.set(info.name.toLowerCase(), steamId);
  }
  if (playtimeData) {
    for (const [id, rec] of Object.entries(playtimeData.players)) {
      if (!id.startsWith('name:')) nameToId.set(rec.name.toLowerCase(), id);
    }
  }

  let merged = 0;
  for (const [name, srcRec] of Object.entries({ ...parsed.nameOnly })) {
    const steamId = nameToId.get(name.toLowerCase());
    if (!steamId) continue;

    let target = parsed.players[steamId];
    if (!target) {
      target = newRecord(name);
      parsed.players[steamId] = target;
    }

    target.deaths += srcRec.deaths || 0;
    target.adminAccess = (target.adminAccess || 0) + (srcRec.adminAccess || 0);
    for (const [src, count] of Object.entries(srcRec.damageTaken || {})) {
      target.damageTaken[src] = (target.damageTaken[src] || 0) + count;
    }
    if (srcRec.lastEvent && (!target.lastEvent || srcRec.lastEvent > target.lastEvent)) {
      target.lastEvent = srcRec.lastEvent;
    }

    delete parsed.nameOnly[name];
    merged++;
  }

  return merged;
}

// ── Validation ────────────────────────────────────────────────

function validateData(parsed) {
  let existingStats = { players: {} };
  try {
    if (fs.existsSync(STATS_FILE)) existingStats = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
  } catch (_) {}

  console.log('\n--- Validation ---\n');

  // Orphaned name: keys
  const orphans = Object.keys(existingStats.players).filter(k => k.startsWith('name:'));
  if (orphans.length > 0) {
    console.log(`  Orphaned name: records: ${orphans.length}`);
    for (const k of orphans) {
      console.log(`    ${k} (${existingStats.players[k].name})`);
    }
  } else {
    console.log('  No orphaned name: records');
  }

  // Per-player comparison
  let discrepancies = 0;
  for (const [steamId, fresh] of Object.entries(parsed.players)) {
    const existing = existingStats.players[steamId];
    if (!existing) {
      console.log(`  MISSING: ${fresh.name} (${steamId})`);
      discrepancies++;
      continue;
    }
    const diffs = [];
    if (existing.deaths !== fresh.deaths) diffs.push(`deaths: ${existing.deaths} vs ${fresh.deaths}`);
    if (existing.builds !== fresh.builds) diffs.push(`builds: ${existing.builds} vs ${fresh.builds}`);
    if (existing.raidsOut !== fresh.raidsOut) diffs.push(`raidsOut: ${existing.raidsOut} vs ${fresh.raidsOut}`);
    if (existing.containersLooted !== fresh.containersLooted) diffs.push(`loots: ${existing.containersLooted} vs ${fresh.containersLooted}`);
    if (diffs.length > 0) {
      console.log(`  DIFF ${fresh.name}: ${diffs.join(', ')}`);
      discrepancies++;
    }
  }

  if (discrepancies === 0) {
    console.log('  All player stats match the log data');
  } else {
    console.log(`\n  ${discrepancies} discrepancy(ies) found`);
    console.log('  Run without --validate to rebuild data files.');
  }

  return discrepancies;
}

// ── Main ──────────────────────────────────────────────────────

async function main() {
  console.log('=== HumanitZ Bot Setup ===\n');

  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  // --find mode: just explore SFTP directories
  if (MODE_FIND) {
    await exploreDirectories();
    return;
  }

  // Step 1: Get files (via SFTP or local cache)
  console.log('--- Downloading Files ---\n');
  let hmzLog, connectedLog, idMapRaw;
  if (MODE_LOCAL) {
    ({ hmzLog, connectedLog, idMapRaw } = loadLocalFiles());
  } else {
    ({ hmzLog, connectedLog, idMapRaw } = await downloadFiles());
  }

  if (!hmzLog) {
    console.error('\nNo log file available. Run with --find to locate files on the server.');
    process.exit(1);
  }

  // Step 2: Parse ID map
  const idMap = parseIdMap(idMapRaw);
  if (idMap.size > 0) console.log(`\n  ID map: ${idMap.size} player(s)`);

  // Step 3: Parse game log
  console.log('\n--- Parsing HMZLog.log ---\n');
  const parsed = parseFullLog(hmzLog);
  console.log(`  Events:     ${parsed.totalEvents}`);
  console.log(`  Deaths:     ${parsed.counts.deaths}`);
  console.log(`  Builds:     ${parsed.counts.builds}`);
  console.log(`  Damage:     ${parsed.counts.damage}`);
  console.log(`  Loots:      ${parsed.counts.loots}`);
  console.log(`  Raids:      ${parsed.counts.raids}`);
  console.log(`  Admin:      ${parsed.counts.admin}`);
  console.log(`  Anti-cheat: ${parsed.counts.cheat}`);
  console.log(`  Players:    ${Object.keys(parsed.players).length} (with SteamID)`);
  console.log(`  Name-only:  ${Object.keys(parsed.nameOnly).length}`);

  // Step 4: Parse connected log for playtime
  let playtimeResult;
  if (connectedLog) {
    console.log('\n--- Parsing PlayerConnectedLog.txt ---\n');
    playtimeResult = parseConnectedLog(connectedLog);
    console.log(`  Events:  ${playtimeResult.eventCount}`);
    console.log(`  Players: ${Object.keys(playtimeResult.playtimeData.players).length}`);
  } else {
    console.log('\n--- Estimating Playtime from Log Events ---\n');
    playtimeResult = estimatePlaytimeFromLog(hmzLog);
    console.log(`  Players: ${Object.keys(playtimeResult.playtimeData.players).length}`);
    console.log('  (Estimated — for accurate playtime, ensure PlayerConnectedLog.txt is available)');
  }

  // Step 5: Merge name-only records using all ID sources
  const merged = mergeNameRecords(parsed, idMap, playtimeResult.playtimeData);
  if (merged > 0) console.log(`\n  Merged ${merged} name-only record(s) into SteamID records`);
  const remaining = Object.keys(parsed.nameOnly).length;
  if (remaining > 0) {
    console.log(`  Unresolved name-only records: ${remaining}`);
    for (const [name, rec] of Object.entries(parsed.nameOnly)) {
      console.log(`    "${name}" — deaths: ${rec.deaths}`);
    }
  }

  // Step 6: Merge connect/disconnect counts into stats
  for (const [steamId, counts] of Object.entries(playtimeResult.connectCounts)) {
    if (parsed.players[steamId]) {
      parsed.players[steamId].connects = counts.connects;
      parsed.players[steamId].disconnects = counts.disconnects;
    } else {
      const ptPlayer = playtimeResult.playtimeData.players[steamId];
      parsed.players[steamId] = newRecord(ptPlayer?.name || steamId);
      parsed.players[steamId].connects = counts.connects;
      parsed.players[steamId].disconnects = counts.disconnects;
    }
  }

  // Normalize all records
  for (const record of Object.values(parsed.players)) {
    if (!record.nameHistory) record.nameHistory = [];
    if (!record.connects) record.connects = 0;
    if (!record.disconnects) record.disconnects = 0;
    if (!record.adminAccess) record.adminAccess = 0;
    if (!record.cheatFlags) record.cheatFlags = [];
  }

  // --validate mode: compare only
  if (MODE_VALIDATE) {
    validateData(parsed);
    return;
  }

  // Step 7: Save data files
  console.log('\n--- Saving Data Files ---\n');

  // player-stats.json
  const statsData = { players: {} };
  for (const [steamId, rec] of Object.entries(parsed.players)) {
    statsData.players[steamId] = rec;
  }
  // Keep unresolved name-only records
  for (const [name, rec] of Object.entries(parsed.nameOnly)) {
    statsData.players[`name:${name}`] = { ...newRecord(name), ...rec };
  }
  backupAndSave(STATS_FILE, statsData, 'player-stats.json');

  // playtime.json
  backupAndSave(PLAYTIME_FILE, playtimeResult.playtimeData, 'playtime.json');

  // Playtime summary
  let totalPlaytime = 0;
  const ptPlayers = Object.values(playtimeResult.playtimeData.players);
  for (const p of ptPlayers) totalPlaytime += p.totalMs;

  // Sort by playtime for display
  const sorted = ptPlayers.sort((a, b) => b.totalMs - a.totalMs);
  if (sorted.length > 0) {
    console.log('\n  Playtime Leaderboard:');
    for (const p of sorted.slice(0, 10)) {
      console.log(`    ${p.name.padEnd(20)} ${formatDuration(p.totalMs).padStart(10)}  (${p.sessions} sessions)`);
    }
    if (sorted.length > 10) console.log(`    ... and ${sorted.length - 10} more`);
  }

  // Summary
  console.log('\n--- Setup Complete ---\n');
  console.log(`  Players (stats):    ${Object.keys(statsData.players).length}`);
  console.log(`  Players (playtime): ${Object.keys(playtimeResult.playtimeData.players).length}`);
  console.log(`  Total playtime:     ${formatDuration(totalPlaytime)}`);
  if (parsed.earliestEvent) {
    console.log(`  Data since:         ${new Date(parsed.earliestEvent).toLocaleDateString('en-GB')}`);
  }
  console.log(`\n  Start the bot with: npm start`);
}

// Allow import from index.js OR direct execution
if (require.main === module) {
  main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}

module.exports = { main };

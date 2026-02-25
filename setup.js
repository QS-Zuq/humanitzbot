#!/usr/bin/env node
/**
 * setup.js — Unified setup, import, and validation utility for HumanitZ Bot.
 *
 *
 * Modes:
 *   node setup.js               Full first-run: auto-discover paths, download logs via SFTP, import all data + backfill activity log
 *   node setup.js --find        Auto-discover file paths on server & update .env
 *   node setup.js --validate    Download logs via SFTP, compare against existing data
 *   node setup.js --fix         Same as default — download and rebuild all data files
 *   node setup.js --local       Use previously downloaded files in data/ (skip SFTP)
 *   node setup.js --backfill    Replay historical log events into activity_log DB table only
 *
 * Auto-discovery: On first run, the bot connects via SFTP and searches for
 * HMZLog.log, PlayerConnectedLog.txt, PlayerIDMapped.txt, and the save file.
 * Discovered paths are written back to .env so manual path config is not needed.
 * Only FTP_HOST, FTP_PORT, FTP_USER, FTP_PASSWORD are required.
 */

require('dotenv').config();

// ── Timestamped console logging ──────────────────────────────
const _origLog   = console.log;
const _origError = console.error;
const _origWarn  = console.warn;
function _ts() { return new Date().toLocaleTimeString('en-GB', { hour12: false }); }
console.log   = (...args) => _origLog(`[${_ts()}]`, ...args);
console.error = (...args) => _origError(`[${_ts()}]`, ...args);
console.warn  = (...args) => _origWarn(`[${_ts()}]`, ...args);

const fs = require('fs');
const path = require('path');
const SftpClient = require('ssh2-sftp-client');
const config = require('./src/config');

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

// Add SSH private key support if configured
if (process.env.FTP_PRIVATE_KEY_PATH) {
  try {
    ftpConfig.privateKey = require('fs').readFileSync(process.env.FTP_PRIVATE_KEY_PATH, 'utf8');
  } catch (err) {
    console.warn(`[SETUP] Could not read SSH private key at ${process.env.FTP_PRIVATE_KEY_PATH}:`, err.message);
  }
}

const ftpBasePath = (process.env.FTP_BASE_PATH || '').replace(/\/+$/, '');  // strip trailing slash
let ftpLogPath = process.env.FTP_LOG_PATH || '/HumanitZServer/HMZLog.log';
let ftpConnectLogPath = process.env.FTP_CONNECT_LOG_PATH || '/HumanitZServer/PlayerConnectedLog.txt';
let ftpIdMapPath = process.env.FTP_ID_MAP_PATH || '/HumanitZServer/PlayerIDMapped.txt';
let ftpSavePath = process.env.FTP_SAVE_PATH || '/HumanitZServer/Saved/SaveGames/SaveList/Default/Save_DedicatedSaveMP.sav';
let ftpSettingsPath = process.env.FTP_SETTINGS_PATH || '/HumanitZServer/GameServerSettings.ini';
let ftpWelcomePath = process.env.FTP_WELCOME_PATH || '/HumanitZServer/WelcomeMessage.txt';

// Prepend base path if configured and paths are relative (don't start with /)
if (ftpBasePath) {
  if (ftpLogPath && !ftpLogPath.startsWith('/')) ftpLogPath = ftpBasePath + '/' + ftpLogPath;
  if (ftpConnectLogPath && !ftpConnectLogPath.startsWith('/')) ftpConnectLogPath = ftpBasePath + '/' + ftpConnectLogPath;
  if (ftpIdMapPath && !ftpIdMapPath.startsWith('/')) ftpIdMapPath = ftpBasePath + '/' + ftpIdMapPath;
  if (ftpSavePath && !ftpSavePath.startsWith('/')) ftpSavePath = ftpBasePath + '/' + ftpSavePath;
  if (ftpSettingsPath && !ftpSettingsPath.startsWith('/')) ftpSettingsPath = ftpBasePath + '/' + ftpSettingsPath;
  if (ftpWelcomePath && !ftpWelcomePath.startsWith('/')) ftpWelcomePath = ftpBasePath + '/' + ftpWelcomePath;
}

// ── CLI Args ──────────────────────────────────────────────────
const args = process.argv.slice(2);
const MODE_FIND = args.includes('--find');
const MODE_VALIDATE = args.includes('--validate');
const MODE_LOCAL = args.includes('--local');
const MODE_BACKFILL = args.includes('--backfill');

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
    pvpKills: 0,
    pvpDeaths: 0,
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

// ── SFTP: Auto-Discovery ──────────────────────────────────────

// Target filenames to locate on the server
const DISCOVERY_TARGETS = {
  'HMZLog.log':              'FTP_LOG_PATH',
  'PlayerConnectedLog.txt':  'FTP_CONNECT_LOG_PATH',
  'PlayerIDMapped.txt':      'FTP_ID_MAP_PATH',
  'Save_DedicatedSaveMP.sav':'FTP_SAVE_PATH',
  'GameServerSettings.ini':  'FTP_SETTINGS_PATH',
  'WelcomeMessage.txt':      'FTP_WELCOME_PATH',
};

/**
 * Recursively search an SFTP server for the target files.
 * Returns a Map<filename, remotePath>.
 */
async function discoverFiles(sftp, dir, depth, maxDepth, found) {
  if (depth >= maxDepth) return;
  let items;
  try { items = await sftp.list(dir); } catch { return; }
  for (const item of items) {
    const fullPath = dir === '/' ? `/${item.name}` : `${dir}/${item.name}`;
    if (item.type === 'd') {
      // Skip obviously irrelevant directories for faster discovery
      if (/^(\.|node_modules|__pycache__|Engine|proc|sys|dev|run|tmp|lost\+found|snap|boot|usr)$/i.test(item.name)) continue;
      // Prioritize game server directories (check them first)
      const isPriority = /^(data|serverfiles|home|opt|root|app)/i.test(item.name);
      if (isPriority || depth < 4) {
        await discoverFiles(sftp, fullPath, depth + 1, maxDepth, found);
      }
    } else if (DISCOVERY_TARGETS[item.name] && !found.has(item.name)) {
      found.set(item.name, fullPath);
      console.log(`  Found ${item.name} → ${fullPath}`);
    }
    // Early exit if all targets found
    if (found.size >= Object.keys(DISCOVERY_TARGETS).length) return;
  }
}

/**
 * Auto-discover file paths on the SFTP server and update .env accordingly.
 * Returns { ftpLogPath, ftpConnectLogPath, ftpIdMapPath, ftpSavePath }.
 */
async function autoDiscoverPaths(sftp) {
  console.log('\n--- Auto-Discovering File Paths on Server ---\n');
  const found = new Map();

  // First: try the currently configured paths (fast check)
  const quickChecks = [
    { name: 'HMZLog.log',              path: ftpLogPath },
    { name: 'PlayerConnectedLog.txt',  path: ftpConnectLogPath },
    { name: 'PlayerIDMapped.txt',      path: ftpIdMapPath },
    { name: 'Save_DedicatedSaveMP.sav', path: ftpSavePath },
    { name: 'GameServerSettings.ini',  path: ftpSettingsPath },
    { name: 'WelcomeMessage.txt',      path: ftpWelcomePath },
  ];
  for (const { name, path: p } of quickChecks) {
    try {
      const stat = await sftp.stat(p);
      if (stat) {
        found.set(name, p);
        console.log(`  ✓ ${name} — confirmed at ${p}`);
      }
    } catch { /* not there, will search */ }
  }

  // Search for any files we didn't find at the default locations
  if (found.size < Object.keys(DISCOVERY_TARGETS).length) {
    const missing = Object.keys(DISCOVERY_TARGETS).filter(n => !found.has(n));
    console.log(`  Searching for: ${missing.join(', ')}`);
    await discoverFiles(sftp, '/', 0, 8, found);
  }

  // Report results
  const results = {
    ftpLogPath:        found.get('HMZLog.log')              || ftpLogPath,
    ftpConnectLogPath: found.get('PlayerConnectedLog.txt')  || ftpConnectLogPath,
    ftpIdMapPath:      found.get('PlayerIDMapped.txt')      || ftpIdMapPath,
    ftpSavePath:       found.get('Save_DedicatedSaveMP.sav') || ftpSavePath,
    ftpSettingsPath:   found.get('GameServerSettings.ini')  || ftpSettingsPath,
    ftpWelcomePath:    found.get('WelcomeMessage.txt')      || ftpWelcomePath,
  };

  const notFound = Object.keys(DISCOVERY_TARGETS).filter(n => !found.has(n));
  if (notFound.length > 0) {
    console.log(`\n  ⚠️  Could not locate: ${notFound.join(', ')}`);
    console.log('  Using default paths for missing files. You can set them manually in .env.');
  } else {
    console.log('\n  ✓ All files located!');
  }

  // Auto-detect FTP_BASE_PATH from discovered paths (find common parent directory)
  if (found.size > 0) {
    const discoveredPaths = Array.from(found.values());
    const commonParent = findCommonParent(discoveredPaths);
    if (commonParent && commonParent !== '/') {
      results.ftpBasePath = commonParent;
      console.log(`\n  → Auto-detected FTP_BASE_PATH: ${commonParent}`);
    }
  }

  // Update .env with discovered paths
  updateEnvFile(results);

  // Apply to runtime variables
  ftpLogPath = results.ftpLogPath;
  ftpConnectLogPath = results.ftpConnectLogPath;
  ftpIdMapPath = results.ftpIdMapPath;
  ftpSavePath = results.ftpSavePath;
  ftpSettingsPath = results.ftpSettingsPath;
  ftpWelcomePath = results.ftpWelcomePath;

  return results;
}

/**
 * Find common parent directory from an array of absolute paths.
 * Returns the deepest common directory, or '/' if no common parent.
 */
function findCommonParent(paths) {
  if (paths.length === 0) return '/';
  if (paths.length === 1) return path.dirname(paths[0]);

  // Split all paths into segments
  const segments = paths.map(p => p.split('/').filter(Boolean));
  
  // Find common prefix
  let commonDepth = 0;
  const minLength = Math.min(...segments.map(s => s.length));
  
  for (let i = 0; i < minLength; i++) {
    const first = segments[0][i];
    if (segments.every(s => s[i] === first)) {
      commonDepth = i + 1;
    } else {
      break;
    }
  }

  if (commonDepth === 0) return '/';
  return '/' + segments[0].slice(0, commonDepth).join('/');
}

/**
 * Write discovered paths back to the .env file.
 * Only updates FTP_*_PATH keys that have changed.
 */
function updateEnvFile(paths) {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) {
    console.log('  (No .env file found — skipping auto-update)');
    return;
  }

  let envContent = fs.readFileSync(envPath, 'utf8');
  let updated = 0;

  const mapping = {
    FTP_BASE_PATH:        paths.ftpBasePath,
    FTP_LOG_PATH:         paths.ftpLogPath,
    FTP_CONNECT_LOG_PATH: paths.ftpConnectLogPath,
    FTP_ID_MAP_PATH:      paths.ftpIdMapPath,
    FTP_SAVE_PATH:        paths.ftpSavePath,
    FTP_SETTINGS_PATH:    paths.ftpSettingsPath,
    FTP_WELCOME_PATH:     paths.ftpWelcomePath,
  };

  for (const [key, value] of Object.entries(mapping)) {
    // Check if the key is already set in .env (commented or uncommented)
    const regex = new RegExp(`^#?\\s*${key}\\s*=.*$`, 'm');
    if (regex.test(envContent)) {
      const current = envContent.match(regex)[0];
      const newLine = `${key}=${value}`;
      if (current !== newLine) {
        envContent = envContent.replace(regex, newLine);
        updated++;
      }
    } else {
      // Key doesn't exist — append it after FTP_PASSWORD
      const ftpSection = /^#?\s*FTP_PASSWORD\s*=.*$/m;
      if (ftpSection.test(envContent)) {
        envContent = envContent.replace(ftpSection, `$&\n${key}=${value}`);
      } else {
        envContent += `\n${key}=${value}\n`;
      }
      updated++;
    }
  }

  // Also set FIRST_RUN=false after successful discovery
  const firstRunRegex = /^#?\s*FIRST_RUN\s*=.*$/m;
  if (firstRunRegex.test(envContent)) {
    const current = envContent.match(firstRunRegex)[0];
    if (current !== 'FIRST_RUN=false') {
      envContent = envContent.replace(firstRunRegex, 'FIRST_RUN=false');
      updated++;
    }
  }

  if (updated > 0) {
    fs.writeFileSync(envPath, envContent, 'utf8');
    console.log(`\n  Updated .env (${updated} value${updated > 1 ? 's' : ''} written)`);
    console.log('  → FIRST_RUN set to false — paths are saved for future starts.');
  }
}

// ── SFTP: Download Files ──────────────────────────────────────

/**
 * Download HMZLog.log, PlayerConnectedLog.txt, and PlayerIDMapped.txt via SFTP.
 * Runs auto-discovery first to locate files if the configured paths are wrong.
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

    // Auto-discover correct paths (verifies defaults, searches if needed, updates .env)
    await autoDiscoverPaths(sftp);

    console.log('\n--- Downloading Files ---\n');

    // HMZLog.log
    try {
      const buf = await sftp.get(ftpLogPath);
      hmzLog = buf.toString('utf8');
      fs.writeFileSync(LOG_CACHE, hmzLog, 'utf8');
      console.log(`  HMZLog.log — ${(hmzLog.length / 1024).toFixed(1)} KB`);
    } catch (err) {
      console.warn(`  HMZLog.log — not found at ${ftpLogPath}: ${err.message}`);
    }

    // PlayerConnectedLog.txt
    try {
      const buf = await sftp.get(ftpConnectLogPath);
      connectedLog = buf.toString('utf8');
      fs.writeFileSync(CONNECTED_LOG_CACHE, connectedLog, 'utf8');
      console.log(`  PlayerConnectedLog.txt — ${(connectedLog.length / 1024).toFixed(1)} KB`);
    } catch (err) {
      console.warn(`  PlayerConnectedLog.txt — not found at ${ftpConnectLogPath}: ${err.message}`);
    }

    // PlayerIDMapped.txt
    try {
      const buf = await sftp.get(ftpIdMapPath);
      idMapRaw = buf.toString('utf8');
      fs.writeFileSync(ID_MAP_CACHE, idMapRaw, 'utf8');
      console.log(`  PlayerIDMapped.txt — ${(idMapRaw.length / 1024).toFixed(1)} KB`);
    } catch (err) {
      console.warn(`  PlayerIDMapped.txt — not found at ${ftpIdMapPath}: ${err.message}`);
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

  // Flexible timestamp: (DD/MM/YYYY HH:MM) or (DD/MM/YYYY HH:MM:SS)
  // Also handles - and . separators in the date portion, and comma in year (2,026)
  const tsRegex = /^\((\d{1,2})[/\-.](\d{1,2})[/\-.](\d{1,2},?\d{3})\s+(\d{1,2}):(\d{1,2})(?::\d{1,2})?\)\s+(.+)$/;

  const sampleLines = []; // collect first non-empty lines for diagnostics

  for (const rawLine of content.split('\n')) {
    const line = rawLine.replace(/^\uFEFF/, '').trim();
    if (!line) continue;

    if (sampleLines.length < 5) sampleLines.push(line);

    const lm = line.match(tsRegex);
    if (!lm) { result.counts.skipped++; continue; }

    const [, day, month, rawYear, hour, min, body] = lm;
    const year = rawYear.replace(',', '');
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

  result._sampleLines = sampleLines;
  return result;
}

/**
 * Parse PlayerConnectedLog.txt into playtime data + connect/disconnect counts.
 * Format: Player Connected PlayerName NetID(steamId_+_|...) (DD/MM/YYYY HH:MM)
 */
function parseConnectedLog(content) {
  const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/).filter(l => l.trim());
  const events = [];

  // Flexible: handle optional seconds, alternative date separators, and comma in year (2,026)
  const connectRegex = /^Player (Connected|Disconnected)\s+(.+?)\s+NetID\((\d{17})[^)]*\)\s*\((\d{1,2})[/\-.](\d{1,2})[/\-.](\d{1,2},?\d{3})\s+(\d{1,2}):(\d{1,2})(?::\d{1,2})?\)/;

  for (const line of lines) {
    const m = line.match(connectRegex);
    if (!m) continue;
    const [, action, name, steamId, day, month, rawYear, hour, min] = m;
    const year = rawYear.replace(',', '');
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
      todayDate: config.getToday(),
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

  // Flexible timestamp: handles optional seconds, alternative date separators, and comma in year (2,026)
  const tsRegex2 = /^\((\d{1,2})[/\-.](\d{1,2})[/\-.](\d{1,2},?\d{3})\s+(\d{1,2}):(\d{1,2})(?::\d{1,2})?\)\s+(.+)$/;

  for (const rawLine of content.split('\n')) {
    const line = rawLine.replace(/^\uFEFF/, '').trim();
    if (!line) continue;

    const lm = line.match(tsRegex2);
    if (!lm) continue;

    const [, day, month, rawYear, hour, min, body] = lm;
    const year = rawYear.replace(',', '');
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
      todayDate: config.getToday(),
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

// ── Activity Log Backfill ─────────────────────────────────────

/**
 * Parse HMZLog.log + PlayerConnectedLog.txt into activity_log entries with original timestamps.
 * Returns an array of { type, category, actor, actorName, item, amount, details, createdAt }.
 * Skips damage events (too numerous — would bloat the DB with millions of low-value rows).
 */
function buildActivityEntries(hmzLog, connectedLog) {
  const entries = [];

  // ── HMZLog events ──
  const tsRegex = /^\((\d{1,2})[/\-.](\d{1,2})[/\-.](\d{1,2},?\d{3})\s+(\d{1,2}):(\d{1,2})(?::\d{1,2})?\)\s+(.+)$/;

  if (hmzLog) {
    for (const rawLine of hmzLog.split('\n')) {
      const line = rawLine.replace(/^\uFEFF/, '').trim();
      if (!line) continue;
      const lm = line.match(tsRegex);
      if (!lm) continue;
      const [, day, month, rawYear, hour, min, body] = lm;
      const year = rawYear.replace(',', '');
      const ts = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}T${hour.padStart(2, '0')}:${min.padStart(2, '0')}:00.000Z`;
      let m;

      // Player death
      m = body.match(/^Player died \((.+)\)$/);
      if (m) { entries.push({ type: 'player_death', category: 'death', actorName: m[1].trim(), item: 'Unknown', createdAt: ts }); continue; }

      // Build
      m = body.match(/^(.+?)\((\d{17})[^)]*\)\s*finished building\s+(.+)$/);
      if (m) { entries.push({ type: 'player_build', category: 'build', actor: m[2], actorName: m[1].trim(), item: simplifyBlueprintName(m[3].trim()), createdAt: ts }); continue; }

      // Container looted (skip self-loot)
      m = body.match(/^(.+?)\s*\((\d{17})[^)]*\)\s*looted a container\s*\(([^)]+)\)\s*owner by\s*(\d{17})/);
      if (m && m[2] !== m[4]) { entries.push({ type: 'container_looted', category: 'loot', actor: m[2], actorName: m[1].trim(), item: m[3], details: { owner: m[4] }, createdAt: ts }); continue; }

      // Raid
      m = body.match(/^Building \(([^)]+)\) owned by \((\d{17}[^)]*)\) damaged \([\d.]+\) by (.+?)(?:\((\d{17})[^)]*\))?(\s*\(Destroyed\))?$/);
      if (m) {
        const ownerId = m[2].match(/^(\d{17})/)?.[1];
        const atkRaw = m[3].trim();
        const atkId = m[4];
        const destroyed = !!m[5];
        if (atkRaw !== 'Decayfalse' && atkRaw !== 'Zeek' && ownerId && !(atkId && atkId === ownerId)) {
          entries.push({ type: destroyed ? 'raid_destroy' : 'raid_hit', category: 'raid', actor: atkId || '', actorName: atkRaw, item: simplifyBlueprintName(m[1]), details: { owner: ownerId }, createdAt: ts });
        }
        continue;
      }

      // Admin access
      m = body.match(/^(.+?)\s+gained admin access!$/);
      if (m) { entries.push({ type: 'admin_access', category: 'admin', actorName: m[1].trim(), createdAt: ts }); continue; }

      // Anti-cheat
      m = body.match(/^(Stack limit detected in drop function|Odd behavior.*?Cheat)\s*\((.+?)\s*-\s*(\d{17})/);
      if (m) { entries.push({ type: 'cheat_flag', category: 'admin', actor: m[3], actorName: m[2].trim(), item: m[1].trim(), createdAt: ts }); continue; }
    }
  }

  // ── Connected log events ──
  if (connectedLog) {
    const connectRegex = /^Player (Connected|Disconnected)\s+(.+?)\s+NetID\((\d{17})[^)]*\)\s*\((\d{1,2})[/\-.](\d{1,2})[/\-.](\d{1,2},?\d{3})\s+(\d{1,2}):(\d{1,2})(?::\d{1,2})?\)/;
    for (const rawLine of connectedLog.split('\n')) {
      const line = rawLine.replace(/^\uFEFF/, '').trim();
      if (!line) continue;
      const cm = line.match(connectRegex);
      if (!cm) continue;
      const [, action, name, steamId, day, month, rawYear, hour, min] = cm;
      const year = rawYear.replace(',', '');
      const ts = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}T${hour.padStart(2, '0')}:${min.padStart(2, '0')}:00.000Z`;
      entries.push({
        type: action === 'Connected' ? 'player_connect' : 'player_disconnect',
        category: 'player',
        actor: steamId,
        actorName: name.trim(),
        createdAt: ts,
      });
    }
  }

  // Sort chronologically
  entries.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return entries;
}

/**
 * Backfill activity_log table from parsed log files.
 * Opens the DB, clears existing activity entries, inserts all historical events.
 */
function backfillActivityLog(hmzLog, connectedLog) {
  const HumanitZDB = require('./src/db/database');
  const db = new HumanitZDB();
  db.init();

  try {
    const entries = buildActivityEntries(hmzLog, connectedLog);
    console.log(`\n--- Backfilling Activity Log ---\n`);
    console.log(`  Events to insert: ${entries.length}`);

    // Count by category
    const cats = {};
    for (const e of entries) { cats[e.category] = (cats[e.category] || 0) + 1; }
    for (const [cat, count] of Object.entries(cats)) {
      console.log(`    ${cat}: ${count}`);
    }

    // Clear existing and insert
    db.clearActivityLog();
    console.log('  Cleared existing activity log entries');

    // Insert in batches of 500
    const BATCH = 500;
    for (let i = 0; i < entries.length; i += BATCH) {
      db.insertActivitiesAt(entries.slice(i, i + BATCH));
    }

    const count = db.getActivityCount();
    console.log(`  Inserted: ${count} activity log entries`);
    console.log('  Activity log backfill complete!');
  } finally {
    db.close();
  }
}

// ── Main ──────────────────────────────────────────────────────

async function main() {
  console.log('=== HumanitZ Bot Setup ===\n');

  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  // --find mode: auto-discover paths and explore SFTP directories
  if (MODE_FIND) {
    if (!ftpConfig.host || !ftpConfig.username) {
      console.error('Missing FTP credentials in .env (FTP_HOST, FTP_USER, FTP_PASSWORD).');
      process.exit(1);
    }
    const sftp = new SftpClient();
    try {
      await sftp.connect(ftpConfig);
      await autoDiscoverPaths(sftp);
      console.log('\n--- Full Directory Listing ---\n');
      // Still show the full explore for debugging
      const root = await sftp.list('/');
      console.log('/ contents:');
      for (const item of root) {
        console.log(`  ${item.type === 'd' ? '[DIR]' : '[FILE]'} ${item.name}${item.type !== 'd' ? ` (${item.size} bytes)` : ''}`);
      }
    } catch (err) {
      console.error('SFTP Error:', err.message);
    } finally {
      await sftp.end().catch(() => {});
    }
    return;
  }

  // Step 1: Get files (via SFTP or local cache)
  let hmzLog, connectedLog, idMapRaw;
  if (MODE_LOCAL) {
    console.log('--- Loading Local Files ---\n');
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
  if (parsed.totalEvents === 0 && parsed.counts.skipped > 0) {
    console.log(`\n  ⚠️  No events matched! (${parsed.counts.skipped} lines skipped)`);
    console.log('  First lines of HMZLog.log:');
    for (const s of parsed._sampleLines || []) console.log(`    ${s.substring(0, 120)}`);
    console.log('  If the timestamp format looks different, please report this as a bug.');
  }

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

  // Step 8: Backfill activity log (always runs during setup/nuke — historical data is free)
  if (hmzLog || connectedLog) {
    try {
      backfillActivityLog(hmzLog, connectedLog);
    } catch (err) {
      console.warn('  Activity log backfill failed (non-critical):', err.message);
    }
  }
}

// --backfill standalone mode: just replay logs into activity_log
if (MODE_BACKFILL && require.main === module) {
  (async () => {
    console.log('=== Activity Log Backfill ===\n');
    if (!fs.existsSync(DATA_DIR)) { console.error('data/ directory not found.'); process.exit(1); }
    let hmzLog, connectedLog;
    if (MODE_LOCAL) {
      ({ hmzLog, connectedLog } = loadLocalFiles());
    } else {
      ({ hmzLog, connectedLog } = await downloadFiles());
    }
    if (!hmzLog && !connectedLog) { console.error('No log files available.'); process.exit(1); }
    backfillActivityLog(hmzLog, connectedLog);
  })().catch(err => { console.error('Fatal error:', err); process.exit(1); });
} else if (require.main === module) {
  main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}

module.exports = { main };

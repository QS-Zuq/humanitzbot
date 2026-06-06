/**
 * Agent builder — generates a self-contained parser script for the game server.
 *
 * The agent is a single .js file with zero npm dependencies that:
 *   1. Reads the save file locally (no network transfer)
 *   2. Parses it with the full GVAS parser
 *   3. Reads per-player save files locally when present
 *   4. Writes a JSON cache for the bot to download
 *   5. Optionally watches for changes and re-parses automatically
 *
 * The agent is dynamically generated from the actual parser source files
 * (gvas-reader.ts + save-parser.ts) so it always stays in sync — no
 * duplicate code to maintain.
 *
 * Usage:
 *   const { buildAgentScript } = require('./agent-builder');
 *   const script = buildAgentScript();
 *   // Upload `script` to game server via SFTP, then execute via SSH
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { transformSync } from 'esbuild';
import { getDirname } from '../utils/paths.js';

const __dirname = getDirname(import.meta.url);

const GVAS_READER_PATH = path.join(__dirname, 'gvas-reader.ts');
const SAVE_PARSER_PATH = path.join(__dirname, 'save-parser.ts');

const AGENT_VERSION = 3;

// ─── Agent CLI template (prepended) ────────────────────────────────────────

const AGENT_HEADER = `#!/usr/bin/env node
/**
 * HumanitZ Save Parser Agent v${String(AGENT_VERSION)}
 * Auto-generated — do not edit manually.
 * Regenerate via: node -e "require('./src/parsers/agent-builder').writeAgent()"
 *
 * Parses Save_DedicatedSaveMP.sav and per-player save files on the
 * game server, then writes humanitz-cache.json for the bot to download.
 *
 * Usage:
 *   node humanitz-agent.js                       # auto-discover save, parse once
 *   node humanitz-agent.js --save /path/to/save  # explicit path
 *   node humanitz-agent.js --player-dir /path     # explicit per-player save dir
 *   node humanitz-agent.js --watch                # watch mode (re-parse on change)
 *   node humanitz-agent.js --watch --interval 30  # custom poll interval (seconds)
 *   node humanitz-agent.js --help                 # show usage
 *
 * Output: humanitz-cache.json in the same directory as the save file.
 *
 * Requirements: Node.js 16+ (no npm packages needed)
 */
'use strict';
const _fs = require('fs');
const _path = require('path');
`;

// ─── Agent CLI template (appended) ─────────────────────────────────────────

const AGENT_CLI = `

// ═══════════════════════════════════════════════════════════════════════════
//  Agent CLI
// ═══════════════════════════════════════════════════════════════════════════

const CACHE_FILENAME = 'humanitz-cache.json';
const SAVE_FILENAME = 'Save_DedicatedSaveMP.sav';
const CLAN_FILENAME = 'Save_ClanData.sav';
const ID_MAP_FILENAME = 'PlayerIDMapped.txt';
const AGENT_VERSION_VALUE = ${String(AGENT_VERSION)};
const PARSER_SIGNATURE = 'agent-v' + AGENT_VERSION_VALUE;

// ── Argument parsing ──

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    save: '',
    output: '',
    idMap: '',
    playerDir: '',
    watch: false,
    interval: 30,
    help: false,
    discover: false,
    pretty: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--watch' || arg === '-w') opts.watch = true;
    else if (arg === '--pretty' || arg === '-p') opts.pretty = true;
    else if (arg === '--discover') opts.discover = true;
    else if ((arg === '--save' || arg === '-s') && args[i + 1]) opts.save = args[++i];
    else if ((arg === '--output' || arg === '-o') && args[i + 1]) opts.output = args[++i];
    else if (arg === '--id-map' && args[i + 1]) opts.idMap = args[++i];
    else if (arg === '--player-dir' && args[i + 1]) opts.playerDir = args[++i];
    else if ((arg === '--interval' || arg === '-i') && args[i + 1]) opts.interval = parseInt(args[++i], 10) || 30;
    else if (!arg.startsWith('-')) opts.save = arg;  // positional = save path
  }

  return opts;
}

function showHelp() {
  console.log(\`
HumanitZ Save Parser Agent

Usage: node humanitz-agent.js [options] [save-path]

Options:
  --save, -s <path>      Path to Save_DedicatedSaveMP.sav
  --output, -o <path>    Output path for cache JSON
  --id-map <path>        Path to PlayerIDMapped.txt
  --player-dir <path>    Path to per-player save directory
  --watch, -w            Watch mode: re-parse when save changes
  --interval, -i <sec>   Poll interval in seconds (default: 30)
  --pretty, -p           Pretty-print JSON output (human-readable)
  --discover             Search for save file in common locations
  --help, -h             Show this help

If no save path is given, searches current directory and common locations.
Output defaults to humanitz-cache.json next to the save file.
\`);
}

function parseIdMapText(text) {
  const idMap = {};
  let count = 0;
  for (const line of text.split(/\\r?\\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^(\\d{17})_\\+_\\|[^@]+@(.+)$/);
    if (!match) continue;
    const steamId = match[1];
    const name = match[2].trim();
    if (!name) continue;
    idMap[steamId] = name;
    count++;
  }
  return { idMap, count };
}

function findIdMapPath(savePath, explicitPath) {
  if (explicitPath) {
    try {
      if (_fs.existsSync(explicitPath)) return explicitPath;
    } catch { /* skip */ }
    return '';
  }

  const candidates = [];
  const seen = new Set();
  function addCandidate(p) {
    if (!p || seen.has(p)) return;
    seen.add(p);
    candidates.push(p);
  }

  let dir = _path.dirname(savePath);
  for (let depth = 0; depth < 8; depth++) {
    addCandidate(_path.join(dir, ID_MAP_FILENAME));
    const parent = _path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  addCandidate(_path.join(process.cwd(), ID_MAP_FILENAME));

  for (const p of candidates) {
    try {
      if (_fs.existsSync(p)) return p;
    } catch { /* skip */ }
  }
  return '';
}

function readIdMap(savePath, explicitPath) {
  const idMapPath = findIdMapPath(savePath, explicitPath);
  if (!idMapPath) return { path: '', mtime: null, idMap: {}, count: 0 };

  try {
    const text = _fs.readFileSync(idMapPath, 'utf8');
    const parsed = parseIdMapText(text);
    const stat = _fs.statSync(idMapPath);
    return {
      path: idMapPath,
      mtime: stat.mtimeMs,
      idMap: parsed.idMap,
      count: parsed.count,
    };
  } catch (err) {
    console.error('[Agent] PlayerIDMapped parse warning:', err.message);
    return { path: idMapPath, mtime: null, idMap: {}, count: 0 };
  }
}

// ── Auto-discovery ──

function discoverSave(startDir) {
  // Common locations on various hosts
  const searchPaths = [
    _path.join(startDir, SAVE_FILENAME),
    _path.join(startDir, 'Saved', 'SaveGames', 'SaveList', 'Default', SAVE_FILENAME),
    _path.join(startDir, 'HumanitZServer', 'Saved', 'SaveGames', 'SaveList', 'Default', SAVE_FILENAME),
    _path.join(startDir, 'HumanitZ', 'Saved', 'SaveGames', 'SaveList', 'Default', SAVE_FILENAME),
    // Pterodactyl / containerised
    _path.join('/home/container', 'HumanitZServer', 'Saved', 'SaveGames', 'SaveList', 'Default', SAVE_FILENAME),
    _path.join('/home/container', 'Saved', 'SaveGames', 'SaveList', 'Default', SAVE_FILENAME),
    // Windows defaults
    'C:\\\\HumanitZServer\\\\Saved\\\\SaveGames\\\\SaveList\\\\Default\\\\' + SAVE_FILENAME,
  ];

  for (const p of searchPaths) {
    try { if (_fs.existsSync(p)) return p; } catch { /* skip */ }
  }

  // Recursive search (max 3 levels deep)
  return _deepSearch(startDir, SAVE_FILENAME, 0, 3);
}

function _deepSearch(dir, target, depth, maxDepth) {
  if (depth > maxDepth) return null;
  try {
    const entries = _fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isFile() && e.name === target) return _path.join(dir, e.name);
    }
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') {
        const found = _deepSearch(_path.join(dir, e.name), target, depth + 1, maxDepth);
        if (found) return found;
      }
    }
  } catch { /* permission denied, etc */ }
  return null;
}

// ── Per-player save discovery / manifest ──

function _fileStatInfo(filePath) {
  try {
    const stat = _fs.statSync(filePath);
    return { exists: true, mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return { exists: false, mtimeMs: 0, size: 0 };
  }
}

function _stableHash(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function _playerDirNameFromSave(savePath) {
  const base = _path.basename(savePath).replace(/\\.sav$/i, '');
  const withoutPrefix = base.replace(/^Save_/i, '');
  return withoutPrefix || 'DedicatedSaveMP';
}

function discoverPlayerSaveDir(savePath, explicitDir) {
  if (explicitDir) {
    try {
      if (_fs.existsSync(explicitDir) && _fs.statSync(explicitDir).isDirectory()) return explicitDir;
    } catch { /* skip */ }
    return '';
  }

  const saveDir = _path.dirname(savePath);
  const derived = _playerDirNameFromSave(savePath);
  const candidates = [
    _path.join(saveDir, derived),
    _path.join(saveDir, 'DedicatedSaveMP'),
  ];
  const seen = new Set();
  for (const dir of candidates) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    try {
      if (_fs.existsSync(dir) && _fs.statSync(dir).isDirectory()) return dir;
    } catch { /* skip */ }
  }
  return '';
}

function scanPlayerSaveFiles(playerDir) {
  const scan = {
    files: [],
    complete: true,
    candidates: 0,
    errors: 0,
  };
  if (!playerDir) return scan;
  let entries = [];
  try {
    entries = _fs.readdirSync(playerDir, { withFileTypes: true });
  } catch (err) {
    scan.complete = false;
    scan.errors++;
    console.error('[Agent] Player directory read warning:', err && err.message ? err.message : String(err));
    return scan;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const fileName = entry.name;
    if (fileName.startsWith('.') || fileName.endsWith('.tmp')) continue;
    const match = fileName.match(/^(\\d{17})(?:@.*)?\\.sav$/i);
    if (!match) continue;
    scan.candidates++;
    const filePath = _path.join(playerDir, fileName);
    try {
      const stat = _fs.statSync(filePath);
      scan.files.push({
        steamId: match[1],
        fileName,
        path: filePath,
        relPath: fileName,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
      });
    } catch (err) {
      scan.complete = false;
      scan.errors++;
      console.error(
        '[Agent] Player file stat warning (' + fileName + '):',
        err && err.message ? err.message : String(err),
      );
    }
  }
  scan.files.sort((a, b) => a.fileName.localeCompare(b.fileName));
  return scan;
}

function listPlayerSaveFiles(playerDir) {
  return scanPlayerSaveFiles(playerDir).files;
}

function _playerFingerprint(file) {
  return [
    file.relPath,
    String(file.mtimeMs),
    String(file.size),
    String(AGENT_VERSION_VALUE),
    PARSER_SIGNATURE,
  ].join('|');
}

function _readPreviousCache(outputPath) {
  try {
    if (!_fs.existsSync(outputPath)) return null;
    return JSON.parse(_fs.readFileSync(outputPath, 'utf8'));
  } catch {
    return null;
  }
}

function _parsePlayerSaveFile(file) {
  const buf = _fs.readFileSync(file.path);
  const result = parseSave(buf);
  if (result.players && result.players.has(file.steamId)) {
    return result.players.get(file.steamId);
  }
  if (result.players && result.players.size === 1) {
    return Array.from(result.players.values())[0];
  }
  throw new Error('No player snapshot found in ' + file.fileName);
}

function _buildPlayerDirSignature(playerDir, files, scan) {
  if (!playerDir) {
    return { path: '', count: 0, newestMtimeMs: 0, totalSize: 0, listHash: '', complete: true, errors: 0 };
  }
  let newestMtimeMs = 0;
  let totalSize = 0;
  const parts = [];
  for (const file of files) {
    newestMtimeMs = Math.max(newestMtimeMs, file.mtimeMs);
    totalSize += file.size;
    parts.push(file.relPath + ':' + file.mtimeMs + ':' + file.size);
  }
  return {
    path: playerDir,
    count: files.length,
    newestMtimeMs,
    totalSize,
    listHash: _stableHash(parts.join('|')),
    complete: !scan || scan.complete !== false,
    errors: scan && scan.errors ? scan.errors : 0,
  };
}

function _buildWatchSignature(savePath, playerDir, explicitIdMapPath) {
  const saveStat = _fileStatInfo(savePath);
  const scan = scanPlayerSaveFiles(playerDir);
  const idMapPath = findIdMapPath(savePath, explicitIdMapPath);
  const idMapStat = idMapPath ? _fileStatInfo(idMapPath) : { exists: false, mtimeMs: 0, size: 0 };
  return JSON.stringify({
    mainSave: { mtimeMs: saveStat.mtimeMs, size: saveStat.size },
    playerDir: _buildPlayerDirSignature(playerDir, scan.files, scan),
    idMap: { path: idMapPath || '', mtimeMs: idMapStat.mtimeMs, size: idMapStat.size },
    agentVersion: AGENT_VERSION_VALUE,
    parserSignature: PARSER_SIGNATURE,
  });
}

function buildPlayersFromPlayerFiles(savePath, outputPath, explicitPlayerDir, mainPlayers) {
  const startedAt = Date.now();
  const playerDir = discoverPlayerSaveDir(savePath, explicitPlayerDir);
  const previousCache = _readPreviousCache(outputPath);
  const previousManifest = previousCache && previousCache.playerManifest && previousCache.playerManifest.files
    ? previousCache.playerManifest.files
    : {};
  const previousPlayers = previousCache && previousCache.players ? previousCache.players : {};
  const players = Object.assign({}, mainPlayers);
  const manifestFiles = {};
  const removed = [];
  const stats = {
    mode: playerDir ? 'per-player' : 'legacy-main-save',
    dir: playerDir,
    discovered: 0,
    parsed: 0,
    reused: 0,
    removed: 0,
    errors: 0,
    elapsedMs: 0,
  };

  if (!playerDir) {
    console.error('[Agent] Per-player save directory not found; using legacy main-save players only');
    stats.elapsedMs = Date.now() - startedAt;
    return {
      players,
      playerManifest: {
        v: 1,
        dir: '',
        parserSignature: PARSER_SIGNATURE,
        files: manifestFiles,
        removed,
      },
      playerCacheStats: stats,
    };
  }

  const scan = scanPlayerSaveFiles(playerDir);
  const files = scan.files;
  stats.discovered = files.length;
  stats.scanCandidates = scan.candidates;
  stats.scanErrors = scan.errors;
  stats.scanComplete = scan.complete;
  if (!scan.complete) {
    console.error(
      '[Agent] Warning: per-player scan incomplete (' +
        scan.errors +
        ' error(s)); preserving previous cached entries until a clean scan',
    );
  }
  const seenSteamIds = new Set();

  for (const file of files) {
    const fingerprint = _playerFingerprint(file);
    const previousEntry = previousManifest[file.steamId];
    const canReuse = previousEntry
      && previousEntry.fingerprint === fingerprint
      && previousEntry.status !== 'error'
      && previousPlayers[file.steamId];

    seenSteamIds.add(file.steamId);
    if (canReuse) {
      players[file.steamId] = previousPlayers[file.steamId];
      manifestFiles[file.steamId] = Object.assign({}, previousEntry, {
        status: 'reused',
      });
      stats.reused++;
      continue;
    }

    try {
      players[file.steamId] = _parsePlayerSaveFile(file);
      manifestFiles[file.steamId] = {
        steamId: file.steamId,
        fileName: file.fileName,
        relPath: file.relPath,
        mtimeMs: file.mtimeMs,
        size: file.size,
        fingerprint,
        status: 'parsed',
        parsedAt: new Date().toISOString(),
      };
      stats.parsed++;
    } catch (err) {
      delete players[file.steamId];
      manifestFiles[file.steamId] = {
        steamId: file.steamId,
        fileName: file.fileName,
        relPath: file.relPath,
        mtimeMs: file.mtimeMs,
        size: file.size,
        fingerprint,
        status: 'error',
        error: err && err.message ? err.message : String(err),
      };
      stats.errors++;
      console.error('[Agent] Player parse warning (' + file.fileName + '):', manifestFiles[file.steamId].error);
    }
  }

  for (const steamId of Object.keys(previousManifest)) {
    if (seenSteamIds.has(steamId)) continue;
    const oldEntry = previousManifest[steamId] || {};
    if (!scan.complete) {
      if (oldEntry.status === 'removed') {
        manifestFiles[steamId] = oldEntry;
        continue;
      }
      if (previousPlayers[steamId]) {
        players[steamId] = previousPlayers[steamId];
        stats.reused++;
      }
      manifestFiles[steamId] = Object.assign({}, oldEntry, {
        steamId,
        status: 'scan_skipped',
        scanWarning: 'scan incomplete; preserved from previous cache',
      });
      continue;
    }
    removed.push(steamId);
    manifestFiles[steamId] = Object.assign({}, oldEntry, {
      steamId,
      status: 'removed',
    });
    delete players[steamId];
    stats.removed++;
  }

  if (files.length > 0 && Object.keys(players).length === 0) {
    console.error('[Agent] Warning: per-player directory has ' + files.length + ' files but cache has 0 players');
  }

  stats.elapsedMs = Date.now() - startedAt;
  return {
    players,
    playerManifest: {
      v: 1,
      dir: playerDir,
      parserSignature: PARSER_SIGNATURE,
      aggregate: _buildPlayerDirSignature(playerDir, files, scan),
      files: manifestFiles,
      removed,
    },
    playerCacheStats: stats,
  };
}

// ── Parse and write cache ──

function parseAndWrite(savePath, outputPath, pretty, idMapPath, playerDirPath) {
  const startTime = Date.now();

  const buf = _fs.readFileSync(savePath);
  const result = parseSave(buf);
  const idMapInfo = readIdMap(savePath, idMapPath);

  // Convert players Map to plain object for JSON serialisation
  const playersObj = {};
  for (const [steamId, data] of result.players) {
    playersObj[steamId] = data;
  }
  const playerCache = buildPlayersFromPlayerFiles(savePath, outputPath, playerDirPath, playersObj);
  const mergedPlayers = playerCache.players;

  // Parse clan data if Save_ClanData.sav exists alongside the main save
  let clans = [];
  const clanPath = _path.join(_path.dirname(savePath), CLAN_FILENAME);
  try {
    if (_fs.existsSync(clanPath)) {
      const clanBuf = _fs.readFileSync(clanPath);
      clans = parseClanData(clanBuf);
    }
  } catch (err) {
    console.error('[Agent] Clan parse warning:', err.message);
  }

  const cache = {
    v: ${String(AGENT_VERSION)},
    ts: new Date().toISOString(),
    mtime: _fs.statSync(savePath).mtimeMs,
    idMap: idMapInfo.idMap,
    idMapCount: idMapInfo.count,
    idMapPath: idMapInfo.path,
    idMapMtime: idMapInfo.mtime,
    players: mergedPlayers,
    playerManifest: playerCache.playerManifest,
    playerCacheStats: playerCache.playerCacheStats,
    worldState: result.worldState,
    structures: result.structures,
    vehicles: result.vehicles,
    companions: result.companions,
    deadBodies: result.deadBodies,
    containers: result.containers,
    lootActors: result.lootActors,
    quests: result.quests,
    horses: result.horses,
    clans: clans,
  };

  const json = pretty ? JSON.stringify(cache, null, 2) : JSON.stringify(cache);

  // Atomic write: write to temp file then rename to prevent the bot
  // from reading a partially-written cache during an FTP download
  const tmpPath = outputPath + '.tmp';
  _fs.writeFileSync(tmpPath, json);
  _fs.renameSync(tmpPath, outputPath);

  const elapsed = Date.now() - startTime;
  const sizeMB = (json.length / 1024 / 1024).toFixed(2);
  const playerCount = Object.keys(mergedPlayers).length;
  const clanInfo = clans.length ? ', ' + clans.length + ' clans' : '';
  const idMapInfoText = idMapInfo.count ? ', ' + idMapInfo.count + ' names' : '';
  const playerCacheInfo = playerCache.playerCacheStats
    ? ', discovered ' + playerCache.playerCacheStats.discovered
      + ' player files, parsed ' + playerCache.playerCacheStats.parsed
      + ', reused ' + playerCache.playerCacheStats.reused
      + ', removed ' + playerCache.playerCacheStats.removed
      + ', errors ' + playerCache.playerCacheStats.errors
    : '';
  console.log('[Agent] Parsed ' + playerCount + ' players, '
    + result.structures.length + ' structures, '
    + result.vehicles.length + ' vehicles'
    + idMapInfoText
    + playerCacheInfo
    + clanInfo + ' → '
    + sizeMB + 'MB cache (' + elapsed + 'ms)');

  return cache;
}

// ── Watch mode ──

function watchMode(savePath, outputPath, intervalSec, pretty, idMapPath, playerDirPath) {
  const explicitPlayerDir = playerDirPath || '';
  let lastSignature = '';
  let lastPlayerDir = null;

  function resolveCurrentPlayerDir() {
    return discoverPlayerSaveDir(savePath, explicitPlayerDir);
  }

  function check() {
    try {
      const currentPlayerDir = resolveCurrentPlayerDir();
      if (currentPlayerDir && currentPlayerDir !== lastPlayerDir) {
        console.log('[Agent] Watching player dir: ' + currentPlayerDir);
      }
      lastPlayerDir = currentPlayerDir;
      const signature = _buildWatchSignature(savePath, currentPlayerDir, idMapPath);
      if (signature !== lastSignature) {
        lastSignature = signature;
        parseAndWrite(savePath, outputPath, pretty, idMapPath, currentPlayerDir);
      }
    } catch (err) {
      console.error('[Agent] Error:', err.message);
    }
  }

  console.log('[Agent] Watching ' + savePath + ' (poll every ' + intervalSec + 's)');
  console.log('[Agent] Output: ' + outputPath);
  console.log('[Agent] Press Ctrl+C to stop');

  check(); // immediate first parse
  setInterval(check, intervalSec * 1000);
}

// ── Main ──

function main() {
  const opts = parseArgs();

  if (opts.help) { showHelp(); process.exit(0); }

  // Resolve save path
  let savePath = opts.save;
  if (!savePath) {
    savePath = discoverSave(process.cwd());
    if (!savePath) {
      console.error('[Agent] Could not find ' + SAVE_FILENAME);
      console.error('[Agent] Use --save <path> to specify the save file location');
      process.exit(1);
    }
    console.log('[Agent] Found save: ' + savePath);
  }

  if (!_fs.existsSync(savePath)) {
    console.error('[Agent] Save file not found: ' + savePath);
    process.exit(1);
  }

  // Resolve output path
  const outputPath = opts.output || _path.join(_path.dirname(savePath), CACHE_FILENAME);

  if (opts.watch) {
    watchMode(savePath, outputPath, opts.interval, opts.pretty, opts.idMap, opts.playerDir);
  } else {
    parseAndWrite(savePath, outputPath, opts.pretty, opts.idMap, opts.playerDir);
  }
}

main();
`;

// ═══════════════════════════════════════════════════════════════════════════
//  Builder
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build the self-contained agent script from the parser source files.
 * Returns the full JS source as a string.
 */
function buildAgentScript(): string {
  const gvasSource = fs.readFileSync(GVAS_READER_PATH, 'utf-8');
  const parserSource = fs.readFileSync(SAVE_PARSER_PATH, 'utf-8');

  /**
   * Transpile TypeScript source to plain JS using esbuild, then strip
   * module-level constructs (imports/exports/require/CJS compat) so the
   * code can be inlined into the self-contained agent script.
   */
  function transpileAndStrip(src: string): string {
    // 1. Use esbuild to reliably strip all TypeScript syntax
    const { code } = transformSync(src, {
      loader: 'ts',
      format: 'esm', // keeps import/export as-is for regex removal below
      target: 'node16',
      treeShaking: false,
      sourcemap: false,
    });

    // 2. Strip module constructs (imports, exports, require, CJS compat)
    //    These are simple line-level patterns — much more reliable than
    //    the previous approach of stripping TS syntax with regex.
    return code
      .replace(/^\/\*\*[\s\S]*?\*\/\s*\n/, '') // top docblock
      .replace(/^import\s+.*$/gm, '') // import statements
      .replace(/^\}\s*from\s+['"][^'"]+['"];?\s*$/gm, '') // multi-line import continuation
      .replace(/^export\s*\{[\s\S]*?\};?\s*$/gm, '') // export { ... } blocks
      .replace(/^export\s+/gm, '') // export prefix on declarations
      .replace(/^\/\/\s*CJS compatibility.*$/gm, '') // CJS compat comments
      .replace(/const _mod[\s\S]*$/, '') // CJS compat block at end
      .replace(/\nmodule\.exports\s*=\s*\{[\s\S]*\};\s*$/, '\n') // module.exports
      .replace(/\n{3,}/g, '\n\n'); // collapse blank lines
  }

  const gvasBody = transpileAndStrip(gvasSource);
  const parserBody = transpileAndStrip(parserSource);

  return [
    AGENT_HEADER,
    '// ═══════════════════════════════════════════════════════════════════════════',
    '//  GVAS Binary Reader (auto-bundled from gvas-reader.ts)',
    '// ═══════════════════════════════════════════════════════════════════════════\n',
    gvasBody.trim(),
    '\n\n// ═══════════════════════════════════════════════════════════════════════════',
    '//  Save Parser (auto-bundled from save-parser.ts)',
    '// ═══════════════════════════════════════════════════════════════════════════\n',
    parserBody.trim(),
    AGENT_CLI,
  ].join('\n');
}

/**
 * Write the agent script to a file.
 */
function writeAgent(outputPath?: string): string {
  const target = outputPath ?? path.join(__dirname, '..', 'game-server', 'humanitz-agent.js');
  const script = buildAgentScript();
  fs.writeFileSync(target, script, 'utf-8');

  // Format with Prettier so the generated file follows project style.
  try {
    const prettierBin = path.join(__dirname, '..', '..', 'node_modules', '.bin', 'prettier');
    execFileSync(prettierBin, ['--write', target], { stdio: 'ignore' });
  } catch {
    // Prettier not installed (e.g. on game server) — skip silently
  }

  const finalSize = fs.statSync(target).size;
  console.log(`[AgentBuilder] Wrote ${(finalSize / 1024).toFixed(1)}KB → ${target}`);
  return target;
}

export { buildAgentScript, writeAgent, AGENT_VERSION };

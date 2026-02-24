/**
 * Agent builder — generates a self-contained parser script for the game server.
 *
 * The agent is a single .js file with zero npm dependencies that:
 *   1. Reads the save file locally (no network transfer)
 *   2. Parses it with the full GVAS parser
 *   3. Writes a compact JSON cache (~200-500KB vs 60MB .sav)
 *   4. Optionally watches for changes and re-parses automatically
 *
 * The bot then downloads only the small JSON via SFTP.
 *
 * The agent is dynamically generated from the actual parser source files
 * (gvas-reader.js + save-parser.js) so it always stays in sync — no
 * duplicate code to maintain.
 *
 * Usage:
 *   const { buildAgentScript } = require('./agent-builder');
 *   const script = buildAgentScript();
 *   // Upload `script` to game server via SFTP, then execute via SSH
 */

const fs = require('fs');
const path = require('path');

const GVAS_READER_PATH = path.join(__dirname, 'gvas-reader.js');
const SAVE_PARSER_PATH = path.join(__dirname, 'save-parser.js');

const AGENT_VERSION = 1;

// ─── Agent CLI template (prepended) ────────────────────────────────────────

const AGENT_HEADER = `#!/usr/bin/env node
/**
 * HumanitZ Save Parser Agent v${AGENT_VERSION}
 * Auto-generated — do not edit manually.
 * Regenerate via: node -e "require('./src/parsers/agent-builder').writeAgent()"
 *
 * Parses Save_DedicatedSaveMP.sav on the game server and writes
 * a compact humanitz-cache.json for the bot to download.
 *
 * Usage:
 *   node humanitz-agent.js                       # auto-discover save, parse once
 *   node humanitz-agent.js --save /path/to/save  # explicit path
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

// ── Argument parsing ──

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { save: '', output: '', watch: false, interval: 30, help: false, discover: false };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--watch' || arg === '-w') opts.watch = true;
    else if (arg === '--discover') opts.discover = true;
    else if ((arg === '--save' || arg === '-s') && args[i + 1]) opts.save = args[++i];
    else if ((arg === '--output' || arg === '-o') && args[i + 1]) opts.output = args[++i];
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
  --watch, -w            Watch mode: re-parse when save changes
  --interval, -i <sec>   Poll interval in seconds (default: 30)
  --discover             Search for save file in common locations
  --help, -h             Show this help

If no save path is given, searches current directory and common locations.
Output defaults to humanitz-cache.json next to the save file.
\`);
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

// ── Parse and write cache ──

function parseAndWrite(savePath, outputPath) {
  const startTime = Date.now();

  const buf = _fs.readFileSync(savePath);
  const result = parseSave(buf);

  // Convert players Map to plain object for JSON serialisation
  const playersObj = {};
  for (const [steamId, data] of result.players) {
    playersObj[steamId] = data;
  }

  const cache = {
    v: ${AGENT_VERSION},
    ts: new Date().toISOString(),
    mtime: _fs.statSync(savePath).mtimeMs,
    players: playersObj,
    worldState: result.worldState,
    structures: result.structures,
    vehicles: result.vehicles,
    companions: result.companions,
    deadBodies: result.deadBodies,
    containers: result.containers,
    lootActors: result.lootActors,
    quests: result.quests,
  };

  const json = JSON.stringify(cache);
  _fs.writeFileSync(outputPath, json);

  const elapsed = Date.now() - startTime;
  const sizeMB = (json.length / 1024 / 1024).toFixed(2);
  const playerCount = Object.keys(playersObj).length;
  console.log('[Agent] Parsed ' + playerCount + ' players, '
    + result.structures.length + ' structures, '
    + result.vehicles.length + ' vehicles → '
    + sizeMB + 'MB cache (' + elapsed + 'ms)');

  return cache;
}

// ── Watch mode ──

function watchMode(savePath, outputPath, intervalSec) {
  let lastMtime = 0;

  function check() {
    try {
      const stat = _fs.statSync(savePath);
      if (stat.mtimeMs !== lastMtime) {
        lastMtime = stat.mtimeMs;
        parseAndWrite(savePath, outputPath);
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
    watchMode(savePath, outputPath, opts.interval);
  } else {
    parseAndWrite(savePath, outputPath);
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
function buildAgentScript() {
  const gvasSource = fs.readFileSync(GVAS_READER_PATH, 'utf-8');
  const parserSource = fs.readFileSync(SAVE_PARSER_PATH, 'utf-8');

  // Strip the top docblock and module.exports from gvas-reader
  const gvasBody = gvasSource
    .replace(/^\/\*\*[\s\S]*?\*\/\s*\n/, '')
    .replace(/\nmodule\.exports\s*=\s*\{[\s\S]*\};\s*$/, '\n');

  // Strip require(), top docblock, and module.exports from save-parser
  const parserBody = parserSource
    .replace(/^\/\*\*[\s\S]*?\*\/\s*\n/, '')
    .replace(/const\s*\{[^}]+\}\s*=\s*require\(['"][^'"]+['"]\);\s*\n/g, '')
    .replace(/\nmodule\.exports\s*=\s*\{[\s\S]*\};\s*$/, '\n');

  return [
    AGENT_HEADER,
    '// ═══════════════════════════════════════════════════════════════════════════',
    '//  GVAS Binary Reader (auto-bundled from gvas-reader.js)',
    '// ═══════════════════════════════════════════════════════════════════════════\n',
    gvasBody.trim(),
    '\n\n// ═══════════════════════════════════════════════════════════════════════════',
    '//  Save Parser (auto-bundled from save-parser.js)',
    '// ═══════════════════════════════════════════════════════════════════════════\n',
    parserBody.trim(),
    AGENT_CLI,
  ].join('\n');
}

/**
 * Write the agent script to a file.
 * @param {string} [outputPath] - Default: project root / humanitz-agent.js
 * @returns {string} The path written to
 */
function writeAgent(outputPath) {
  const target = outputPath || path.join(__dirname, '..', 'game-server', 'humanitz-agent.js');
  const script = buildAgentScript();
  fs.writeFileSync(target, script, 'utf-8');
  console.log(`[AgentBuilder] Wrote ${(script.length / 1024).toFixed(1)}KB → ${target}`);
  return target;
}

module.exports = { buildAgentScript, writeAgent, AGENT_VERSION };

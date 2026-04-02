/**
 * Agent builder — generates a self-contained parser script for the game server.
 *
 * The agent is a single .js file with zero npm dependencies that:
 *   1. Reads the save file locally (no network transfer)
 *   2. Parses it with the full GVAS parser
 *   3. Writes a compact JSON cache (~200-500KB vs 60MB .sav)
 *   4. Optionally watches for changes and re-parses automatically
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

import fs from 'node:fs';
import path from 'node:path';
import { getDirname } from '../utils/paths.js';

const __dirname = getDirname(import.meta.url);

const GVAS_READER_PATH = path.join(__dirname, 'gvas-reader.ts');
const SAVE_PARSER_PATH = path.join(__dirname, 'save-parser.ts');

const AGENT_VERSION = 2;

// ─── Agent CLI template (prepended) ────────────────────────────────────────

const AGENT_HEADER = `#!/usr/bin/env node
/**
 * HumanitZ Save Parser Agent v${String(AGENT_VERSION)}
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
const CLAN_FILENAME = 'Save_ClanData.sav';

// ── Argument parsing ──

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { save: '', output: '', watch: false, interval: 30, help: false, discover: false, pretty: false };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--watch' || arg === '-w') opts.watch = true;
    else if (arg === '--pretty' || arg === '-p') opts.pretty = true;
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
  --pretty, -p           Pretty-print JSON output (human-readable)
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

function parseAndWrite(savePath, outputPath, pretty) {
  const startTime = Date.now();

  const buf = _fs.readFileSync(savePath);
  const result = parseSave(buf);

  // Convert players Map to plain object for JSON serialisation
  const playersObj = {};
  for (const [steamId, data] of result.players) {
    playersObj[steamId] = data;
  }

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
    players: playersObj,
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
  const playerCount = Object.keys(playersObj).length;
  const clanInfo = clans.length ? ', ' + clans.length + ' clans' : '';
  console.log('[Agent] Parsed ' + playerCount + ' players, '
    + result.structures.length + ' structures, '
    + result.vehicles.length + ' vehicles'
    + clanInfo + ' → '
    + sizeMB + 'MB cache (' + elapsed + 'ms)');

  return cache;
}

// ── Watch mode ──

function watchMode(savePath, outputPath, intervalSec, pretty) {
  let lastMtime = 0;

  function check() {
    try {
      const stat = _fs.statSync(savePath);
      if (stat.mtimeMs !== lastMtime) {
        lastMtime = stat.mtimeMs;
        parseAndWrite(savePath, outputPath, pretty);
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
    watchMode(savePath, outputPath, opts.interval, opts.pretty);
  } else {
    parseAndWrite(savePath, outputPath, opts.pretty);
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
   * Strip TypeScript syntax from source to produce valid JS.
   * Handles: imports, exports, interfaces, type aliases, type annotations,
   * type assertions, generics, eslint directives, CJS compat block.
   */
  function stripTS(src: string): string {
    return (
      src
        // Remove top docblock
        .replace(/^\/\*\*[\s\S]*?\*\/\s*\n/, '')
        // Remove multi-line import statements: import { ... } from '...'
        .replace(/^import\s+[\s\S]*?from\s+['"][^'"]+['"];?\s*\n/gm, '')
        // Remove single-line import statements
        .replace(/^import\s+.*$/gm, '')
        // Remove multi-line export { ... } statements
        .replace(/^export\s*\{[\s\S]*?\}.*$/gm, '')
        // Remove single-line export prefix
        .replace(/^export\s+/gm, '')
        // Remove `} from '...'` leftover fragments
        .replace(/^\}\s*from\s+['"][^'"]+['"];?\s*$/gm, '')
        // Remove require() lines (will be inlined)
        .replace(/const\s*\{[^}]+\}\s*=\s*require\(['"][^'"]+['"]\);\s*\n/g, '')
        .replace(/^\/\/\s*eslint-disable-next-line.*\n\s*const\s+\w+\s*=\s*require\(.*\n/gm, '')
        // Remove interface/type blocks (multi-line)
        .replace(/^(?:export\s+)?interface\s+\w+[\s\S]*?^}\s*\n/gm, '')
        .replace(/^(?:export\s+)?type\s+\w+\s*=[\s\S]*?;\s*\n/gm, '')
        // Remove eslint directive comments
        .replace(/\/\/\s*eslint-disable.*$/gm, '')
        .replace(/\/\*\s*eslint-.*?\*\//g, '')
        // Remove type annotations — only where safe (declarations, not ternary colons).
        // Matches: `const x: Type =`, `param: Type,`, `param: Type)`, `): ReturnType {`
        // Uses negative lookbehind to avoid stripping ternary `: value` expressions
        .replace(
          /(?<=(?:const|let|var|,|\()\s*[\w$]+)\s*:\s*(?:readonly\s+)?(?:[\w.]+(?:<[^>]*>)?(?:\[\])*(?:\s*\|\s*(?:\{(?:[^{}]|\{[^{}]*\})*\}|[\w.]+(?:<[^>]*>)?)(?:\[\])*)*)\s*(?=[,)=;{\n])/g,
          '',
        )
        // Remove return type annotations: `): Type {` or `): Type =>`
        .replace(/\):\s*(?:[\w.]+(?:<[^>]*>)?(?:\[\])*(?:\s*\|\s*[\w.]+(?:<[^>]*>)?(?:\[\])*)*)\s*(?=[{=])/g, ') ')
        // Remove `as Type` assertions (handles nested braces, generics, unions, multiline)
        // First collapse multi-line `as ... | Type` onto one line
        .replace(/\bas\s*\n\s*/g, 'as ')
        // Match `as` + optional leading `|` + type expression (handles unions)
        .replace(
          /\s+as\s+\|?\s*(?:\{(?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*\}|[\w.]+(?:<[^>]*>)?)(?:\[\])*(?:\s*\|\s*(?:\{(?:[^{}]|\{[^{}]*\})*\}|[\w.]+(?:<[^>]*>)?)(?:\[\])*)*/g,
          '',
        )
        // Remove generic type parameters on functions: `function foo<T>(` → `function foo(`
        .replace(/(<[\w\s,]+>)\s*\(/g, '(')
        // Remove non-null assertions: `expr!.` or `expr!)` or `expr!;` (not `!==` or `!=`)
        .replace(/([\w\])])\s*!(?=[.);,\s\n])/g, '$1')
        // Remove `type X` import specifiers (leftover from multi-line imports)
        .replace(/^\s*type\s+\w+,?\s*$/gm, '')
        // Remove stray lines that are just braces/semicolons from stripped blocks
        .replace(/^\s*\{\s*$/gm, '')
        // Remove CJS compat comments
        .replace(/^\/\/\s*CJS compatibility.*$/gm, '')
        // Remove CJS compat block at end
        .replace(/const _mod[\s\S]*$/, '')
        // Remove module.exports
        .replace(/\nmodule\.exports\s*=\s*\{[\s\S]*\};\s*$/, '\n')
        // Clean up blank lines
        .replace(/\n{3,}/g, '\n\n')
    );
  }

  const gvasBody = stripTS(gvasSource);
  const parserBody = stripTS(parserSource);

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
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { execFileSync } = require('child_process') as typeof import('child_process');
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

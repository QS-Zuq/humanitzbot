/**
 * Tests for the save-agent system (agent-builder + updated save-service).
 *
 * Covers:
 *   - agent-builder.js — script generation, syntax validity, source bundling
 *   - save-service.js — agent mode flow, cache reading, agent-only failure handling
 *   - humanitz-agent.js — end-to-end agent parsing (generated script)
 *
 * Run:  npm test test/agent.test.ts
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { execFileSync } from 'child_process';

// ─── Modules under test ─────────────────────────────────────────────────────

import * as _agent_builder from '../src/parsers/agent-builder.js';
import * as _save_parser from '../src/parsers/save-parser.js';
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- Test intentionally keeps private module export access loosely typed.
const { buildAgentScript, writeAgent, AGENT_VERSION } = _agent_builder as any;

// ─── Test data ──────────────────────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, '..', 'data');
const SAV_FILE = path.join(DATA_DIR, 'Save_DedicatedSaveMP_LIVE.sav');
const SAV_EXISTS = fs.existsSync(SAV_FILE);
const TEMP_AGENT = path.join(DATA_DIR, '_test-agent.js');
const TEMP_CACHE = path.join(DATA_DIR, '_test-cache.json');
const TEMP_ID_MAP = path.join(DATA_DIR, '_test-PlayerIDMapped.txt');
const TEMP_PLAYER_ROOT = path.join(DATA_DIR, '_test-agent-player-root');
const require = createRequire(import.meta.url);

function loadAgentInternals(script: string, parseSaveOverride: (buf: Buffer) => unknown, errorLog: string[] = []) {
  const instrumented = script.replace(
    /\nmain\(\);\s*$/,
    `
parseSave = globalThis.__parseSaveOverride || parseSave;
globalThis.__agentInternals = {
  discoverPlayerSaveDir,
  listPlayerSaveFiles,
  buildPlayersFromPlayerFiles,
  _buildWatchSignature,
};
`,
  );
  const context: Record<string, unknown> = {
    require,
    Buffer,
    console: {
      log() {},
      error(...args: unknown[]) {
        errorLog.push(args.map(String).join(' '));
      },
    },
    process: { argv: ['node', 'humanitz-agent.js'], cwd: () => TEMP_PLAYER_ROOT },
    globalThis: null,
    __parseSaveOverride: parseSaveOverride,
  };
  context.globalThis = context;
  new vm.Script(instrumented.replace(/^#!.*\n/, ''), { filename: 'humanitz-agent-internals.js' }).runInNewContext(
    context,
  );
  return context.__agentInternals as {
    discoverPlayerSaveDir(savePath: string, explicitDir?: string): string;
    listPlayerSaveFiles(playerDir: string): Array<{ steamId: string; fileName: string }>;
    buildPlayersFromPlayerFiles(
      savePath: string,
      outputPath: string,
      explicitPlayerDir: string,
      mainPlayers: Record<string, unknown>,
    ): {
      players: Record<string, Record<string, unknown>>;
      playerManifest: { files: Record<string, { status: string; fingerprint: string }> };
      playerCacheStats: {
        mode?: string;
        discovered: number;
        parsed: number;
        reused: number;
        removed: number;
        errors: number;
        scanCandidates?: number;
        scanErrors?: number;
        scanComplete?: boolean;
      };
    };
    _buildWatchSignature(savePath: string, playerDir: string, explicitIdMapPath?: string): string;
  };
}

// ═══════════════════════════════════════════════════════════════════════════
//  Agent Builder
// ═══════════════════════════════════════════════════════════════════════════

describe('agent-builder', () => {
  let script: string;

  before(() => {
    script = buildAgentScript();
  });

  after(() => {
    // Clean up temp files
    try {
      fs.unlinkSync(TEMP_AGENT);
    } catch {}
    try {
      fs.unlinkSync(TEMP_CACHE);
    } catch {}
    try {
      fs.rmSync(TEMP_PLAYER_ROOT, { recursive: true, force: true });
    } catch {}
  });

  it('generates a non-empty string', () => {
    assert.ok(typeof script === 'string');
    assert.ok(script.length > 10000, `Expected >10KB, got ${script.length} bytes`);
  });

  it('includes the shebang line', () => {
    assert.ok(script.startsWith('#!/usr/bin/env node'));
  });

  it('includes bundled GVAS reader code', () => {
    assert.ok(script.includes('function createReader('), 'Missing createReader');
    assert.ok(script.includes('function readProperty('), 'Missing readProperty');
  });

  it('includes bundled save parser code', () => {
    assert.ok(script.includes('function parseSave('), 'Missing parseSave');
    assert.ok(script.includes('PERK_MAP'), 'Missing PERK_MAP');
    assert.ok(script.includes('SEASON_MAP'), 'Missing SEASON_MAP');
  });

  it('does NOT contain require("./gvas-reader")', () => {
    assert.ok(!script.includes("require('./gvas-reader')"), 'Should not require gvas-reader');
    assert.ok(!script.includes('require("./gvas-reader")'), 'Should not require gvas-reader');
  });

  it('does NOT contain module.exports from source files', () => {
    // The agent should NOT export anything (it's a CLI script)
    // Count occurrences — there should be zero
    const matches = script.match(/module\.exports/g);
    assert.equal(matches, null, 'Should not have module.exports');
  });

  it('includes agent CLI code', () => {
    assert.ok(script.includes('function parseAndWrite('), 'Missing parseAndWrite');
    assert.ok(script.includes('function parseIdMapText('), 'Missing parseIdMapText');
    assert.ok(script.includes('function main('), 'Missing main');
    assert.ok(script.includes('function discoverSave('), 'Missing discoverSave');
    assert.ok(script.includes('function discoverPlayerSaveDir('), 'Missing discoverPlayerSaveDir');
    assert.ok(script.includes('function listPlayerSaveFiles('), 'Missing listPlayerSaveFiles');
    assert.ok(script.includes('function buildPlayersFromPlayerFiles('), 'Missing buildPlayersFromPlayerFiles');
    assert.ok(script.includes('function _buildWatchSignature('), 'Missing _buildWatchSignature');
    assert.ok(script.includes('function watchMode('), 'Missing watchMode');
    assert.ok(script.includes('humanitz-cache.json'), 'Missing cache filename');
    assert.ok(script.includes('PlayerIDMapped.txt'), 'Missing id map filename');
    assert.ok(script.includes('playerManifest'), 'Missing player manifest cache field');
    assert.ok(script.includes('playerCacheStats'), 'Missing player cache stats field');
    assert.ok(script.includes('--player-dir'), 'Missing player dir CLI option');
  });

  it('has valid JavaScript syntax', () => {
    // Compile the generated script without executing it.
    fs.writeFileSync(TEMP_AGENT, script);
    new vm.Script(script.replace(/^#!.*\n/, ''), { filename: TEMP_AGENT });
    assert.ok(true, 'Syntax check passed');
  });

  it('writeAgent() creates a file', () => {
    const target = writeAgent(TEMP_AGENT);
    assert.equal(target, TEMP_AGENT);
    assert.ok(fs.existsSync(TEMP_AGENT));
    const content = fs.readFileSync(TEMP_AGENT, 'utf-8');
    assert.ok(content.length > 10000);
  });

  it('exports AGENT_VERSION', () => {
    const version: number = AGENT_VERSION;
    assert.ok(Number.isInteger(version));
    assert.ok(version >= 1);
  });

  it('discovers per-player saves and filters unrelated files', () => {
    fs.rmSync(TEMP_PLAYER_ROOT, { recursive: true, force: true });
    const savePath = path.join(TEMP_PLAYER_ROOT, 'Save_DedicatedSaveMP.sav');
    const playerDir = path.join(TEMP_PLAYER_ROOT, 'DedicatedSaveMP');
    fs.mkdirSync(playerDir, { recursive: true });
    fs.writeFileSync(savePath, 'main-save');
    fs.writeFileSync(path.join(playerDir, '76561198000000001@abc.sav'), '76561198000000001');
    fs.writeFileSync(path.join(playerDir, 'not-a-player.sav'), 'ignored');
    fs.writeFileSync(path.join(playerDir, '76561198000000002@tmp.sav.tmp'), 'ignored');

    const internals = loadAgentInternals(script, (buf) => ({
      players: new Map([[buf.toString('utf8'), { health: 85 }]]),
    }));

    assert.equal(internals.discoverPlayerSaveDir(savePath), playerDir);
    assert.deepEqual(Array.from(internals.listPlayerSaveFiles(playerDir).map((file) => file.steamId)), [
      '76561198000000001',
    ]);
  });

  it('skips transient player-file stat failures without clearing valid cached players', () => {
    fs.rmSync(TEMP_PLAYER_ROOT, { recursive: true, force: true });
    const savePath = path.join(TEMP_PLAYER_ROOT, 'Save_DedicatedSaveMP.sav');
    const cachePath = path.join(TEMP_PLAYER_ROOT, 'humanitz-cache.json');
    const playerDir = path.join(TEMP_PLAYER_ROOT, 'DedicatedSaveMP');
    const stableSteamId = '76561198000000001';
    const vanishedSteamId = '76561198000000002';
    const vanishedFile = `${vanishedSteamId}@abc.sav`;
    fs.mkdirSync(playerDir, { recursive: true });
    fs.writeFileSync(savePath, 'main-save');
    fs.writeFileSync(path.join(playerDir, `${stableSteamId}@abc.sav`), stableSteamId);
    fs.writeFileSync(path.join(playerDir, vanishedFile), vanishedSteamId);

    const internals = loadAgentInternals(script, (buf) => {
      const steamId = buf.toString('utf8');
      return { players: new Map([[steamId, { health: steamId === stableSteamId ? 85 : 55 }]]) };
    });
    const first = internals.buildPlayersFromPlayerFiles(savePath, cachePath, '', {});
    fs.writeFileSync(
      cachePath,
      JSON.stringify({ players: first.players, playerManifest: first.playerManifest }),
      'utf8',
    );

    const mutableFs = require('fs') as Omit<typeof fs, 'statSync'> & { statSync: typeof fs.statSync };
    const originalStatSync = mutableFs.statSync;
    const errorLog: string[] = [];
    try {
      mutableFs.statSync = ((target: fs.PathLike, options?: fs.StatSyncOptions) => {
        if (String(target).endsWith(vanishedFile)) {
          throw new Error('vanished during scan');
        }
        return originalStatSync.call(fs, target, options);
      }) as typeof fs.statSync;
      const failingInternals = loadAgentInternals(
        script,
        (buf) => {
          const steamId = buf.toString('utf8');
          return { players: new Map([[steamId, { health: 99 }]]) };
        },
        errorLog,
      );
      const second = failingInternals.buildPlayersFromPlayerFiles(savePath, cachePath, '', {});

      assert.ok(second.players[stableSteamId]);
      assert.equal(second.players[stableSteamId].health, 85);
      assert.ok(second.players[vanishedSteamId]);
      assert.equal(second.players[vanishedSteamId].health, 55);
      assert.equal(second.playerCacheStats.reused, 2);
      assert.equal(second.playerCacheStats.removed, 0);
      assert.equal(second.playerCacheStats.scanComplete, false);
      const skippedEntry = second.playerManifest.files[vanishedSteamId];
      assert.ok(skippedEntry);
      assert.equal(skippedEntry.status, 'scan_skipped');
      assert.match(errorLog.join('\n'), /Player file stat warning .*vanished during scan/);
      assert.match(errorLog.join('\n'), /per-player scan incomplete/);
    } finally {
      mutableFs.statSync = originalStatSync;
    }
  });

  it('preserves all previous cached players when a scan stat race hides every file', () => {
    fs.rmSync(TEMP_PLAYER_ROOT, { recursive: true, force: true });
    const savePath = path.join(TEMP_PLAYER_ROOT, 'Save_DedicatedSaveMP.sav');
    const cachePath = path.join(TEMP_PLAYER_ROOT, 'humanitz-cache.json');
    const playerDir = path.join(TEMP_PLAYER_ROOT, 'DedicatedSaveMP');
    const firstSteamId = '76561198000000001';
    const secondSteamId = '76561198000000002';
    const steamIds = [firstSteamId, secondSteamId];
    fs.mkdirSync(playerDir, { recursive: true });
    fs.writeFileSync(savePath, 'main-save');
    for (const steamId of steamIds) {
      fs.writeFileSync(path.join(playerDir, `${steamId}@abc.sav`), steamId);
    }

    const internals = loadAgentInternals(script, (buf) => {
      const steamId = buf.toString('utf8');
      return { players: new Map([[steamId, { health: steamId.endsWith('1') ? 81 : 82 }]]) };
    });
    const first = internals.buildPlayersFromPlayerFiles(savePath, cachePath, '', {});
    fs.writeFileSync(
      cachePath,
      JSON.stringify({ players: first.players, playerManifest: first.playerManifest }),
      'utf8',
    );

    const mutableFs = require('fs') as Omit<typeof fs, 'statSync'> & { statSync: typeof fs.statSync };
    const originalStatSync = mutableFs.statSync;
    const errorLog: string[] = [];
    try {
      mutableFs.statSync = ((target: fs.PathLike, options?: fs.StatSyncOptions) => {
        if (String(target).startsWith(playerDir) && String(target).endsWith('.sav')) {
          throw new Error('all vanished during scan');
        }
        return originalStatSync.call(fs, target, options);
      }) as typeof fs.statSync;
      const failingInternals = loadAgentInternals(
        script,
        () => {
          throw new Error('parse should not run for stat-hidden files');
        },
        errorLog,
      );
      const second = failingInternals.buildPlayersFromPlayerFiles(savePath, cachePath, '', {});

      for (const steamId of steamIds) {
        assert.ok(second.players[steamId]);
        const skippedEntry = second.playerManifest.files[steamId];
        assert.ok(skippedEntry);
        assert.equal(skippedEntry.status, 'scan_skipped');
      }
      const firstPreserved = second.players[firstSteamId];
      const secondPreserved = second.players[secondSteamId];
      assert.ok(firstPreserved);
      assert.ok(secondPreserved);
      assert.equal(firstPreserved.health, 81);
      assert.equal(secondPreserved.health, 82);
      assert.equal(second.playerCacheStats.reused, 2);
      assert.equal(second.playerCacheStats.removed, 0);
      assert.equal(second.playerCacheStats.scanErrors, 2);
      assert.equal(second.playerCacheStats.scanComplete, false);
      assert.match(errorLog.join('\n'), /per-player scan incomplete/);
    } finally {
      mutableFs.statSync = originalStatSync;
    }
  });

  it('builds per-player cache stats and reuses unchanged manifest entries', () => {
    fs.rmSync(TEMP_PLAYER_ROOT, { recursive: true, force: true });
    const savePath = path.join(TEMP_PLAYER_ROOT, 'Save_DedicatedSaveMP.sav');
    const cachePath = path.join(TEMP_PLAYER_ROOT, 'humanitz-cache.json');
    const playerDir = path.join(TEMP_PLAYER_ROOT, 'DedicatedSaveMP');
    fs.mkdirSync(playerDir, { recursive: true });
    fs.writeFileSync(savePath, 'main-save');
    fs.writeFileSync(path.join(playerDir, '76561198000000001@abc.sav'), '76561198000000001');

    let parseCount = 0;
    const internals = loadAgentInternals(script, (buf) => {
      parseCount++;
      const steamId = buf.toString('utf8');
      return { players: new Map([[steamId, { health: 85, lifetimeKills: 466 }]]) };
    });

    const first = internals.buildPlayersFromPlayerFiles(savePath, cachePath, '', {});
    assert.equal(parseCount, 1);
    assert.equal(first.playerCacheStats.discovered, 1);
    assert.equal(first.playerCacheStats.parsed, 1);
    const firstPlayer = first.players['76561198000000001'];
    const firstManifest = first.playerManifest.files['76561198000000001'];
    assert.ok(firstPlayer);
    assert.ok(firstManifest);
    assert.equal(firstPlayer.health, 85);
    assert.equal(firstManifest.status, 'parsed');

    fs.writeFileSync(
      cachePath,
      JSON.stringify({ players: first.players, playerManifest: first.playerManifest }),
      'utf8',
    );
    parseCount = 0;
    const second = internals.buildPlayersFromPlayerFiles(savePath, cachePath, '', {});
    assert.equal(parseCount, 0);
    assert.equal(second.playerCacheStats.parsed, 0);
    assert.equal(second.playerCacheStats.reused, 1);
    const secondPlayer = second.players['76561198000000001'];
    const secondManifest = second.playerManifest.files['76561198000000001'];
    assert.ok(secondPlayer);
    assert.ok(secondManifest);
    assert.equal(secondPlayer.lifetimeKills, 466);
    assert.equal(secondManifest.status, 'reused');
  });

  it('reparses changed files and invalidates old-version manifest entries', () => {
    fs.rmSync(TEMP_PLAYER_ROOT, { recursive: true, force: true });
    const savePath = path.join(TEMP_PLAYER_ROOT, 'Save_DedicatedSaveMP.sav');
    const cachePath = path.join(TEMP_PLAYER_ROOT, 'humanitz-cache.json');
    const playerDir = path.join(TEMP_PLAYER_ROOT, 'DedicatedSaveMP');
    const playerPath = path.join(playerDir, '76561198000000001@abc.sav');
    fs.mkdirSync(playerDir, { recursive: true });
    fs.writeFileSync(savePath, 'main-save');
    fs.writeFileSync(playerPath, '76561198000000001');

    let parseCount = 0;
    const internals = loadAgentInternals(script, (buf) => {
      parseCount++;
      return { players: new Map([['76561198000000001', { health: buf.length }]]) };
    });

    const first = internals.buildPlayersFromPlayerFiles(savePath, cachePath, '', {});
    assert.equal(parseCount, 1);

    const oldVersionManifest = JSON.parse(JSON.stringify(first.playerManifest)) as {
      files: Record<string, { fingerprint: string }>;
    };
    const oldVersionEntry = oldVersionManifest.files['76561198000000001'];
    assert.ok(oldVersionEntry);
    oldVersionEntry.fingerprint = 'old-version-fingerprint';
    fs.writeFileSync(cachePath, JSON.stringify({ players: first.players, playerManifest: oldVersionManifest }), 'utf8');

    parseCount = 0;
    const afterVersionChange = internals.buildPlayersFromPlayerFiles(savePath, cachePath, '', {});
    assert.equal(parseCount, 1);
    assert.equal(afterVersionChange.playerCacheStats.parsed, 1);
    assert.equal(afterVersionChange.playerCacheStats.reused, 0);

    fs.writeFileSync(
      cachePath,
      JSON.stringify({ players: afterVersionChange.players, playerManifest: afterVersionChange.playerManifest }),
      'utf8',
    );
    fs.writeFileSync(playerPath, '76561198000000001-changed-content');

    parseCount = 0;
    const afterFileChange = internals.buildPlayersFromPlayerFiles(savePath, cachePath, '', {});
    assert.equal(parseCount, 1);
    assert.equal(afterFileChange.playerCacheStats.parsed, 1);
    assert.equal(afterFileChange.playerCacheStats.reused, 0);
    const changedPlayer = afterFileChange.players['76561198000000001'];
    assert.ok(changedPlayer);
    assert.equal(changedPlayer.health, '76561198000000001-changed-content'.length);
  });

  it('removes deleted player files from the current cache manifest', () => {
    fs.rmSync(TEMP_PLAYER_ROOT, { recursive: true, force: true });
    const savePath = path.join(TEMP_PLAYER_ROOT, 'Save_DedicatedSaveMP.sav');
    const cachePath = path.join(TEMP_PLAYER_ROOT, 'humanitz-cache.json');
    const playerDir = path.join(TEMP_PLAYER_ROOT, 'DedicatedSaveMP');
    const playerPath = path.join(playerDir, '76561198000000001@abc.sav');
    fs.mkdirSync(playerDir, { recursive: true });
    fs.writeFileSync(savePath, 'main-save');
    fs.writeFileSync(playerPath, '76561198000000001');

    const internals = loadAgentInternals(script, () => ({
      players: new Map([['76561198000000001', { health: 85 }]]),
    }));
    const first = internals.buildPlayersFromPlayerFiles(savePath, cachePath, '', {});
    fs.writeFileSync(
      cachePath,
      JSON.stringify({ players: first.players, playerManifest: first.playerManifest }),
      'utf8',
    );
    fs.unlinkSync(playerPath);

    const second = internals.buildPlayersFromPlayerFiles(savePath, cachePath, '', {});
    assert.equal(second.players['76561198000000001'], undefined);
    assert.equal(second.playerCacheStats.removed, 1);
    const removedEntry = second.playerManifest.files['76561198000000001'];
    assert.ok(removedEntry);
    assert.equal(removedEntry.status, 'removed');
  });

  it('isolates parse errors without reusing stale changed-player cache entries', () => {
    fs.rmSync(TEMP_PLAYER_ROOT, { recursive: true, force: true });
    const savePath = path.join(TEMP_PLAYER_ROOT, 'Save_DedicatedSaveMP.sav');
    const cachePath = path.join(TEMP_PLAYER_ROOT, 'humanitz-cache.json');
    const playerDir = path.join(TEMP_PLAYER_ROOT, 'DedicatedSaveMP');
    const playerPath = path.join(playerDir, '76561198000000001@abc.sav');
    fs.mkdirSync(playerDir, { recursive: true });
    fs.writeFileSync(savePath, 'main-save');
    fs.writeFileSync(playerPath, '76561198000000001');

    const firstInternals = loadAgentInternals(script, () => ({
      players: new Map([['76561198000000001', { health: 85 }]]),
    }));
    const first = firstInternals.buildPlayersFromPlayerFiles(savePath, cachePath, '', {});
    fs.writeFileSync(
      cachePath,
      JSON.stringify({ players: first.players, playerManifest: first.playerManifest }),
      'utf8',
    );
    fs.writeFileSync(playerPath, '76561198000000001-corrupt');

    const errorLog: string[] = [];
    const failingInternals = loadAgentInternals(
      script,
      () => {
        throw new Error('bad player save');
      },
      errorLog,
    );
    const second = failingInternals.buildPlayersFromPlayerFiles(savePath, cachePath, '', {});

    assert.equal(second.players['76561198000000001'], undefined);
    assert.equal(second.playerCacheStats.errors, 1);
    const errorEntry = second.playerManifest.files['76561198000000001'];
    assert.ok(errorEntry);
    assert.equal(errorEntry.status, 'error');
    assert.match(errorLog.join('\n'), /bad player save/);
  });

  it('records legacy and suspicious empty-player warning states', () => {
    fs.rmSync(TEMP_PLAYER_ROOT, { recursive: true, force: true });
    const savePath = path.join(TEMP_PLAYER_ROOT, 'Save_DedicatedSaveMP.sav');
    const cachePath = path.join(TEMP_PLAYER_ROOT, 'humanitz-cache.json');
    fs.mkdirSync(TEMP_PLAYER_ROOT, { recursive: true });
    fs.writeFileSync(savePath, 'main-save');

    const missingDirLog: string[] = [];
    const legacyInternals = loadAgentInternals(script, () => ({ players: new Map() }), missingDirLog);
    const legacy = legacyInternals.buildPlayersFromPlayerFiles(savePath, cachePath, '', {
      '76561198000000001': { health: 85 },
    });
    assert.equal(legacy.playerCacheStats.mode, 'legacy-main-save');
    const legacyPlayer = legacy.players['76561198000000001'];
    assert.ok(legacyPlayer);
    assert.equal(legacyPlayer.health, 85);
    assert.match(missingDirLog.join('\n'), /Per-player save directory not found/);

    const playerDir = path.join(TEMP_PLAYER_ROOT, 'DedicatedSaveMP');
    fs.mkdirSync(playerDir, { recursive: true });
    fs.writeFileSync(path.join(playerDir, '76561198000000002@abc.sav'), '76561198000000002');
    const suspiciousLog: string[] = [];
    const suspiciousInternals = loadAgentInternals(script, () => ({ players: new Map() }), suspiciousLog);
    const suspicious = suspiciousInternals.buildPlayersFromPlayerFiles(savePath, cachePath, '', {});
    assert.equal(suspicious.playerCacheStats.mode, 'per-player');
    assert.equal(suspicious.playerCacheStats.discovered, 1);
    assert.match(suspiciousLog.join('\n'), /per-player directory has 1 files but cache has 0 players/);
  });

  it('watch signature changes when player files or id map change', () => {
    fs.rmSync(TEMP_PLAYER_ROOT, { recursive: true, force: true });
    const savePath = path.join(TEMP_PLAYER_ROOT, 'Save_DedicatedSaveMP.sav');
    const idMapPath = path.join(TEMP_PLAYER_ROOT, 'PlayerIDMapped.txt');
    const playerDir = path.join(TEMP_PLAYER_ROOT, 'DedicatedSaveMP');
    const playerPath = path.join(playerDir, '76561198000000001@abc.sav');
    fs.mkdirSync(playerDir, { recursive: true });
    fs.writeFileSync(savePath, 'main-save');
    fs.writeFileSync(idMapPath, '76561198000000001_+_|abc@Alice\n');
    fs.writeFileSync(playerPath, '76561198000000001');

    const internals = loadAgentInternals(script, (buf) => ({
      players: new Map([[buf.toString('utf8'), { health: 85 }]]),
    }));

    const before = internals._buildWatchSignature(savePath, playerDir, idMapPath);
    fs.writeFileSync(savePath, 'main-save-changed');
    const afterMainSaveChange = internals._buildWatchSignature(savePath, playerDir, idMapPath);
    assert.notEqual(afterMainSaveChange, before);

    fs.writeFileSync(playerPath, '76561198000000001-changed');
    const afterPlayerChange = internals._buildWatchSignature(savePath, playerDir, idMapPath);
    assert.notEqual(afterPlayerChange, afterMainSaveChange);

    fs.writeFileSync(idMapPath, '76561198000000001_+_|abc@Alice 2\n');
    const afterIdMapChange = internals._buildWatchSignature(savePath, playerDir, idMapPath);
    assert.notEqual(afterIdMapChange, afterPlayerChange);
  });

  it('watch signature can discover a player directory that appears after startup', () => {
    fs.rmSync(TEMP_PLAYER_ROOT, { recursive: true, force: true });
    const savePath = path.join(TEMP_PLAYER_ROOT, 'Save_DedicatedSaveMP.sav');
    const idMapPath = path.join(TEMP_PLAYER_ROOT, 'PlayerIDMapped.txt');
    const playerDir = path.join(TEMP_PLAYER_ROOT, 'DedicatedSaveMP');
    fs.mkdirSync(TEMP_PLAYER_ROOT, { recursive: true });
    fs.writeFileSync(savePath, 'main-save');
    fs.writeFileSync(idMapPath, '76561198000000001_+_|abc@Alice\n');

    const internals = loadAgentInternals(script, (buf) => ({
      players: new Map([[buf.toString('utf8'), { health: 85 }]]),
    }));

    assert.equal(internals.discoverPlayerSaveDir(savePath), '');
    const before = internals._buildWatchSignature(savePath, '', idMapPath);

    fs.mkdirSync(playerDir, { recursive: true });
    fs.writeFileSync(path.join(playerDir, '76561198000000001@abc.sav'), '76561198000000001');

    const rediscovered = internals.discoverPlayerSaveDir(savePath);
    assert.equal(rediscovered, playerDir);
    const after = internals._buildWatchSignature(savePath, rediscovered, idMapPath);
    assert.notEqual(after, before);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  Agent execution (against real .sav files)
// ═══════════════════════════════════════════════════════════════════════════

describe('agent execution', () => {
  before(() => {
    // Write the agent to temp location
    writeAgent(TEMP_AGENT);
  });

  after(() => {
    try {
      fs.unlinkSync(TEMP_AGENT);
    } catch {}
    try {
      fs.unlinkSync(TEMP_CACHE);
    } catch {}
    try {
      fs.unlinkSync(TEMP_ID_MAP);
    } catch {}
  });

  if (!SAV_EXISTS) {
    it('skipped — no LIVE .sav file', () => {
      assert.ok(true);
    });
    return;
  }

  it('parses a real save file and writes valid JSON cache', () => {
    const stdout = execFileSync('node', [TEMP_AGENT, '--save', SAV_FILE, '--output', TEMP_CACHE], {
      encoding: 'utf-8',
      timeout: 30000,
    });

    assert.ok(stdout.includes('[Agent]'), 'Should produce agent output');
    assert.ok(fs.existsSync(TEMP_CACHE), 'Cache file should exist');

    const cache = JSON.parse(fs.readFileSync(TEMP_CACHE, 'utf-8'));
    assert.equal(cache.v, AGENT_VERSION);
    assert.ok(cache.ts, 'Should have timestamp');
    assert.ok(cache.mtime, 'Should have save file mtime');
    assert.ok(typeof cache.players === 'object', 'Should have players object');
    assert.ok(Object.keys(cache.players).length > 0, 'Should have at least one player');
    assert.ok(Array.isArray(cache.structures), 'Should have structures array');
    assert.ok(Array.isArray(cache.vehicles), 'Should have vehicles array');
    assert.ok(typeof cache.worldState === 'object', 'Should have worldState');
  });

  it('cache has complete player data', () => {
    const cache = JSON.parse(fs.readFileSync(TEMP_CACHE, 'utf-8'));
    const steamIds = Object.keys(cache.players);
    assert.ok(steamIds.length > 0);

    // Validate first player has expected fields
    const firstId = steamIds[0];
    assert.ok(firstId, 'Expected at least one steam ID');
    const player = cache.players[firstId];
    assert.ok('zeeksKilled' in player || 'health' in player, 'Player should have stats');
  });

  it('cache includes PlayerIDMapped.txt names when provided', () => {
    const baseCache = JSON.parse(fs.readFileSync(TEMP_CACHE, 'utf-8'));
    const steamId = Object.keys(baseCache.players)[0];
    assert.ok(steamId, 'Expected at least one steam ID');

    const idMapText = `${steamId}_+_|00025b68ba6543f69d754e96177205c6@Agent Mapped Alice\n`;
    fs.writeFileSync(TEMP_ID_MAP, idMapText, 'utf8');

    execFileSync('node', [TEMP_AGENT, '--save', SAV_FILE, '--output', TEMP_CACHE, '--id-map', TEMP_ID_MAP], {
      encoding: 'utf-8',
      timeout: 30000,
    });

    const cache = JSON.parse(fs.readFileSync(TEMP_CACHE, 'utf-8'));
    assert.equal(cache.idMap[steamId], 'Agent Mapped Alice');
    assert.equal(cache.idMapCount, 1);
    assert.equal(cache.idMapPath, TEMP_ID_MAP);
  });

  it('cache worldState has expected fields', () => {
    const cache = JSON.parse(fs.readFileSync(TEMP_CACHE, 'utf-8'));
    assert.ok(cache.worldState.currentSeason, 'Should have currentSeason');
    assert.ok(typeof cache.worldState.totalPlayers === 'number', 'Should have totalPlayers');
  });

  it('cache is significantly smaller than .sav', () => {
    const savSize = fs.statSync(SAV_FILE).size;
    const cacheSize = fs.statSync(TEMP_CACHE).size;
    const ratio = cacheSize / savSize;
    assert.ok(ratio < 0.1, `Cache should be <10% of .sav size, got ${(ratio * 100).toFixed(1)}%`);
  });

  it('--help works without crashing', () => {
    const stdout = execFileSync('node', [TEMP_AGENT, '--help'], {
      encoding: 'utf-8',
      timeout: 5000,
    });
    assert.ok(stdout.includes('Usage:'));
    assert.ok(stdout.includes('--save'));
    assert.ok(stdout.includes('--id-map'));
    assert.ok(stdout.includes('--player-dir'));
    assert.ok(stdout.includes('--watch'));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  SaveService — agent mode unit tests
// ═══════════════════════════════════════════════════════════════════════════

describe('SaveService agent mode', () => {
  // We test the logic without actual SFTP/SSH connections

  let SaveService: any;
  let HumanitZDB: any;
  let db: any;

  before(async () => {
    SaveService = (await import('../src/parsers/save-service')).default;
    HumanitZDB = (await import('../src/db/database')).default;
    db = new HumanitZDB({ memory: true, label: 'AgentTest' });
    db.init();
  });

  after(() => {
    db.close();
  });

  it('constructor accepts agent mode options', () => {
    const svc = new SaveService(db, {
      agentMode: 'auto',
      agentNodePath: '/usr/bin/node',
      agentRemoteDir: '/home/container',
      agentIdMapPath: '/HumanitZServer/PlayerIDMapped.txt',
      agentTimeout: 60000,
    });
    assert.equal(svc._agentMode, 'auto');
    assert.equal(svc._agentNodePath, '/usr/bin/node');
    assert.equal(svc._agentRemoteDir, '/home/container');
    assert.equal(svc._agentIdMapPath, '/HumanitZServer/PlayerIDMapped.txt');
    assert.equal(svc._agentTimeout, 60000);
  });

  it('defaults agent mode to auto', () => {
    const svc = new SaveService(db);
    assert.equal(svc._agentMode, 'auto');
  });

  it('_resolvePaths derives cache path from save path', () => {
    const svc = new SaveService(db, {
      savePath: '/HumanitZServer/Saved/SaveGames/SaveList/Default/Save_DedicatedSaveMP.sav',
    });
    svc._resolvePaths();
    assert.equal(svc._cachePath, '/HumanitZServer/Saved/SaveGames/SaveList/Default/humanitz-cache.json');
    assert.equal(svc._agentPath, '/HumanitZServer/Saved/SaveGames/SaveList/Default/humanitz-agent.js');
  });

  it('_resolvePaths uses custom agentCachePath', () => {
    const svc = new SaveService(db, {
      savePath: '/some/path/Save_DedicatedSaveMP.sav',
      agentCachePath: '/bisect/data/humanitz-cache.json',
    });
    svc._resolvePaths();
    assert.equal(svc._cachePath, '/bisect/data/humanitz-cache.json');
    assert.equal(svc._agentPath, '/some/path/humanitz-agent.js');
  });

  it('_resolvePaths uses custom agentRemoteDir', () => {
    const svc = new SaveService(db, {
      savePath: '/some/path/Save_DedicatedSaveMP.sav',
      agentRemoteDir: '/custom/dir',
    });
    svc._resolvePaths();
    assert.equal(svc._cachePath, '/custom/dir/humanitz-cache.json');
    assert.equal(svc._agentPath, '/custom/dir/humanitz-agent.js');
  });

  it('_generateRunScript passes the configured PlayerIDMapped.txt path', () => {
    const svc = new SaveService(db, {
      savePath: '/HumanitZServer/Saved/SaveGames/SaveList/Default/Save_DedicatedSaveMP.sav',
      agentNodePath: '/usr/bin/node',
      agentIdMapPath: '/HumanitZServer/PlayerIDMapped.txt',
    });
    svc._resolvePaths();

    const script = svc._generateRunScript();

    assert.ok(script.includes("--id-map '/HumanitZServer/PlayerIDMapped.txt'"));
  });

  it('_buildSshConfig derives from SFTP config', () => {
    const svc = new SaveService(db, {
      sftpConfig: { host: '10.0.0.1', port: 8821, username: 'user', password: 'pass' },
    });
    const ssh = svc._buildSshConfig();
    assert.equal(ssh.host, '10.0.0.1');
    assert.equal(ssh.port, 8821);
    assert.equal(ssh.username, 'user');
    assert.equal(ssh.password, 'pass');
  });

  it('_buildSshConfig uses sshPort when available', () => {
    const svc = new SaveService(db, {
      sftpConfig: { host: 'x', port: 8821, username: 'u', password: 'p', sshPort: 22 },
    });
    const ssh = svc._buildSshConfig();
    assert.equal(ssh.port, 22);
  });

  it('_buildSshConfig returns null without sftp config', () => {
    const svc = new SaveService(db);
    assert.equal(svc._buildSshConfig(), null);
  });

  it('stats includes agent fields', () => {
    const svc = new SaveService(db, { agentMode: 'agent', agentTrigger: 'panel' });
    const stats = svc.stats;
    assert.equal(stats.mode, 'agent');
    assert.equal(stats.agentDeployed, false);
    assert.equal(stats.agentCapable, null);
    assert.equal(stats.panelCapable, null);
    assert.equal(stats.trigger, 'panel');
  });

  it('startup mode label avoids ambiguous agent-capable unknown wording', () => {
    const svc = new SaveService(db, {
      agentMode: 'auto',
      agentTrigger: 'rcon',
      savePath: '/HumanitZServer/Saved/SaveGames/SaveList/Default/Save_DedicatedSaveMP.sav',
      agentIdMapPath: '/HumanitZServer/PlayerIDMapped.txt',
    });
    svc._resolvePaths();

    const label = svc._getStartupModeLabel();

    assert.equal(label, 'auto (cache: pending, trigger: rcon, idMap: configured)');
    assert.equal(label.includes('unknown'), false);
    assert.equal(label.includes('agent-capable'), false);
  });

  it('_syncFromCache works with valid cache data', async () => {
    if (!SAV_EXISTS) return;

    // Generate a cache from a real save
    writeAgent(TEMP_AGENT);
    execFileSync('node', [TEMP_AGENT, '--save', SAV_FILE, '--output', TEMP_CACHE], {
      encoding: 'utf-8',
      timeout: 30000,
    });
    const cache = JSON.parse(fs.readFileSync(TEMP_CACHE, 'utf-8'));
    try {
      fs.unlinkSync(TEMP_AGENT);
    } catch {}
    try {
      fs.unlinkSync(TEMP_CACHE);
    } catch {}

    const svc = new SaveService(db);
    let emitted = false;
    svc.on('sync', (result: any) => {
      emitted = true;
      assert.ok(result.playerCount > 0);
      assert.ok(result.structureCount >= 0);
    });

    await svc._syncFromCache(cache);
    assert.ok(emitted, 'Should have emitted sync event');

    // Verify data made it to the DB
    const players = db.player.getAllPlayers();
    assert.ok(players.length > 0, 'Should have players in DB after cache sync');
  });

  it('_syncFromCache stores player detail metadata from cache manifest', async () => {
    const steamId = '76561198000000991';
    const svc = new SaveService(db);

    await svc._syncFromCache({
      v: 3,
      ts: new Date().toISOString(),
      idMap: {},
      idMapCount: 0,
      players: {
        [steamId]: {
          name: 'Cache Detail Player',
          health: 83,
          lifetimeKills: 12,
          inventory: [{ item: 'Axe', amount: 1 }],
          unmappedFullField: { fromCache: true },
        },
      },
      playerManifest: {
        parserSignature: 'agent-v3',
        files: {
          [steamId]: {
            fileName: `${steamId}@abc.sav`,
            relPath: `${steamId}@abc.sav`,
            mtimeMs: 1234,
            size: 5678,
            status: 'parsed',
          },
        },
      },
      playerCacheStats: { discovered: 1, parsed: 1, reused: 0, removed: 0, errors: 0 },
      worldState: {},
      structures: [],
      vehicles: [],
      companions: [],
      containers: [],
      horses: [],
    });

    const player = db.player.getPlayer(steamId);
    assert.ok(player);
    assert.equal(player.has_save_snapshot, true);
    assert.equal(player.health, 83);

    const detail = db.player.getPlayerDetail(steamId);
    assert.ok(detail);
    assert.equal(detail.source_file, `${steamId}@abc.sav`);
    assert.equal(detail.source_mtime_ms, 1234);
    assert.equal(detail.source_size, 5678);
    assert.equal(detail.cache_version, 3);
    assert.equal(detail.agent_version, 3);
    assert.equal(detail.parser_signature, 'agent-v3');
    assert.deepEqual((detail.snapshot as Record<string, unknown>).unmappedFullField, { fromCache: true });
  });

  it('direct mode skips agent logic', async () => {
    if (!SAV_EXISTS) return;

    const svc = new SaveService(db, {
      localPath: SAV_FILE,
      agentMode: 'direct',
    });

    let emitted = false;
    svc.on('sync', () => {
      emitted = true;
    });
    await svc._poll(true);
    assert.ok(emitted, 'Direct mode should sync');
  });

  // ── Trigger strategy tests ──

  it('defaults agentTrigger to auto', () => {
    const svc = new SaveService(db);
    assert.equal(svc._agentTrigger, 'auto');
  });

  it('accepts panel trigger options', () => {
    const svc = new SaveService(db, {
      agentTrigger: 'panel',
      agentPanelCommand: 'custom-parse',
      agentPanelDelay: 3000,
    });
    assert.equal(svc._agentTrigger, 'panel');
    assert.equal(svc._agentPanelCommand, 'custom-parse');
    assert.equal(svc._agentPanelDelay, 3000);
  });

  it('_resolveTrigger returns panel when explicitly set', async () => {
    const svc = new SaveService(db, { agentTrigger: 'panel' });
    const trigger = await svc._resolveTrigger();
    assert.equal(trigger, 'panel');
    assert.equal(svc._resolvedTrigger, 'panel');
  });

  it('_resolveTrigger returns none when explicitly set', async () => {
    const svc = new SaveService(db, { agentTrigger: 'none' });
    const trigger = await svc._resolveTrigger();
    assert.equal(trigger, 'none');
  });

  it('_resolveTrigger caches result', async () => {
    const svc = new SaveService(db, { agentTrigger: 'none' });
    await svc._resolveTrigger();
    assert.equal(svc._resolvedTrigger, 'none');
    // Second call should return cached value
    const trigger2 = await svc._resolveTrigger();
    assert.equal(trigger2, 'none');
  });

  it('_checkPanelAvailable returns false without panel API', () => {
    const svc = new SaveService(db);
    // No panelApi injected, require will load the real one which has no config
    const result = svc._checkPanelAvailable();
    assert.equal(typeof result, 'boolean');
  });

  it('_checkPanelAvailable uses injected panelApi', () => {
    const fakePanelApi = { available: true, sendCommand: async () => {} };
    const svc = new SaveService(db, { panelApi: fakePanelApi });
    assert.equal(svc._checkPanelAvailable(), true);
    assert.equal(svc._panelCapable, true);
  });

  it('_checkPanelAvailable returns false for unavailable panel', () => {
    const fakePanelApi = { available: false };
    const svc = new SaveService(db, { panelApi: fakePanelApi });
    assert.equal(svc._checkPanelAvailable(), false);
    assert.equal(svc._panelCapable, false);
  });

  it('_resolveTrigger auto does NOT auto-select panel', async () => {
    const fakePanelApi = { available: true, sendCommand: async () => {} };
    const svc = new SaveService(db, { agentTrigger: 'auto', panelApi: fakePanelApi });
    const trigger = await svc._resolveTrigger();
    // Panel must be explicitly set — auto skips it
    assert.equal(trigger, 'none');
  });

  it('_resolveTrigger auto falls to none when nothing available', async () => {
    const fakePanelApi = { available: false };
    const svc = new SaveService(db, {
      agentTrigger: 'auto',
      panelApi: fakePanelApi,
      // No SSH config → checkNodeAvailable will fail
    });
    const trigger = await svc._resolveTrigger();
    assert.equal(trigger, 'none');
  });

  it('_resolveTrigger auto does NOT select rcon without Panel API (VPS fix)', async () => {
    // Simulate VPS: RCON connected, but no Panel API (not Pterodactyl/Bisect)
    const fakeRcon = { connected: true, send: async () => {} };
    const svc = new SaveService(db, { agentTrigger: 'auto' });
    svc._rcon = fakeRcon; // inject fake connected RCON
    // No panelApi configured → _checkPanelAvailable returns false
    const trigger = await svc._resolveTrigger();
    // Must NOT pick 'rcon' — createHZSocket is Bisect-only
    assert.notEqual(trigger, 'rcon', 'auto should not select rcon without Panel API');
    assert.equal(trigger, 'none'); // no SSH available either → none
  });

  it('_resolveTrigger auto selects rcon when RCON + Panel API both available (Bisect)', async () => {
    const fakeRcon = { connected: true, send: async () => {} };
    const fakePanelApi = { available: true, sendCommand: async () => {} };
    const svc = new SaveService(db, { agentTrigger: 'auto', panelApi: fakePanelApi });
    svc._rcon = fakeRcon;
    const trigger = await svc._resolveTrigger();
    assert.equal(trigger, 'rcon', 'auto should select rcon when Panel API confirms Pterodactyl host');
  });

  it('_triggerViaPanel calls sendCommand on panelApi', async () => {
    let called = false;
    let sentCmd = '';
    const fakePanelApi = {
      available: true,
      sendCommand: async (cmd: string) => {
        called = true;
        sentCmd = cmd;
      },
    };
    const svc = new SaveService(db, {
      panelApi: fakePanelApi,
      agentPanelCommand: 'test-parse',
      agentPanelDelay: 0, // no delay for tests
    });
    await svc._triggerViaPanel();
    assert.ok(called, 'Should have called sendCommand');
    assert.equal(sentCmd, 'test-parse');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  Agent output matches direct parse
// ═══════════════════════════════════════════════════════════════════════════

describe('agent output consistency', () => {
  if (!SAV_EXISTS) {
    it('skipped — no LIVE .sav file', () => {
      assert.ok(true);
    });
    return;
  }

  let cache: any;

  before(() => {
    // Generate a fresh cache for consistency comparison
    writeAgent(TEMP_AGENT);
    execFileSync('node', [TEMP_AGENT, '--save', SAV_FILE, '--output', TEMP_CACHE], {
      encoding: 'utf-8',
      timeout: 30000,
    });
    cache = JSON.parse(fs.readFileSync(TEMP_CACHE, 'utf-8'));
  });

  after(() => {
    try {
      fs.unlinkSync(TEMP_AGENT);
    } catch {}
    try {
      fs.unlinkSync(TEMP_CACHE);
    } catch {}
  });

  it('agent JSON has same player count as direct parse', () => {
    const { parseSave } = _save_parser as any;
    const buf = fs.readFileSync(SAV_FILE);
    const direct = parseSave(buf);

    const agentPlayerCount = Object.keys(cache.players).length;

    assert.equal(agentPlayerCount, direct.players.size, `Agent: ${agentPlayerCount}, Direct: ${direct.players.size}`);
  });

  it('agent JSON has same structure count as direct parse', () => {
    const { parseSave } = _save_parser as any;
    const buf = fs.readFileSync(SAV_FILE);
    const direct = parseSave(buf);

    assert.equal(cache.structures.length, direct.structures.length);
  });

  it('agent JSON has same vehicle count as direct parse', () => {
    const { parseSave } = _save_parser as any;
    const buf = fs.readFileSync(SAV_FILE);
    const direct = parseSave(buf);

    assert.equal(cache.vehicles.length, direct.vehicles.length);
  });

  it('agent JSON preserves player steam IDs', () => {
    const { parseSave } = _save_parser as any;
    const buf = fs.readFileSync(SAV_FILE);
    const direct = parseSave(buf);

    const directIds = [...direct.players.keys()].sort();
    const agentIds = Object.keys(cache.players).sort();

    assert.deepEqual(agentIds, directIds, 'Steam IDs should match');
  });

  it('agent JSON preserves world state', () => {
    const { parseSave } = _save_parser as any;
    const buf = fs.readFileSync(SAV_FILE);
    const direct = parseSave(buf);

    assert.equal(cache.worldState.currentSeason, direct.worldState.currentSeason);
    assert.equal(cache.worldState.totalPlayers, direct.worldState.totalPlayers);
    assert.equal(cache.worldState.totalStructures, direct.worldState.totalStructures);
  });
});

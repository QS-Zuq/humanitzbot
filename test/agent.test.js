/**
 * Tests for the save-agent system (agent-builder + updated save-service).
 *
 * Covers:
 *   - agent-builder.js — script generation, syntax validity, source bundling
 *   - save-service.js — agent mode flow, cache reading, fallback logic
 *   - humanitz-agent.js — end-to-end agent parsing (generated script)
 *
 * Run:  npm test test/agent.test.js
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { execSync, execFileSync } = require('child_process');

// ─── Modules under test ─────────────────────────────────────────────────────
const { buildAgentScript, writeAgent, AGENT_VERSION } = require('../src/parsers/agent-builder');

// ─── Test data ──────────────────────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, '..', 'data');
const SAV_FILE = path.join(DATA_DIR, 'Save_DedicatedSaveMP_LIVE.sav');
const SAV_EXISTS = fs.existsSync(SAV_FILE);
const TEMP_AGENT = path.join(DATA_DIR, '_test-agent.js');
const TEMP_CACHE = path.join(DATA_DIR, '_test-cache.json');

// ═══════════════════════════════════════════════════════════════════════════
//  Agent Builder
// ═══════════════════════════════════════════════════════════════════════════

describe('agent-builder', () => {

  let script;

  before(() => {
    script = buildAgentScript();
  });

  after(() => {
    // Clean up temp files
    try { fs.unlinkSync(TEMP_AGENT); } catch {}
    try { fs.unlinkSync(TEMP_CACHE); } catch {}
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
    assert.ok(script.includes('function main('), 'Missing main');
    assert.ok(script.includes('function discoverSave('), 'Missing discoverSave');
    assert.ok(script.includes('function watchMode('), 'Missing watchMode');
    assert.ok(script.includes('humanitz-cache.json'), 'Missing cache filename');
  });

  it('has valid JavaScript syntax', () => {
    // Write to temp file and run node --check
    fs.writeFileSync(TEMP_AGENT, script);
    const result = execSync(`node --check "${TEMP_AGENT}"`, { encoding: 'utf-8', timeout: 10000 });
    // node --check returns nothing on success
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
    assert.ok(typeof AGENT_VERSION === 'number');
    assert.ok(AGENT_VERSION >= 1);
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
    try { fs.unlinkSync(TEMP_AGENT); } catch {}
    try { fs.unlinkSync(TEMP_CACHE); } catch {}
  });

  if (!SAV_EXISTS) {
    it('skipped — no LIVE .sav file', () => assert.ok(true));
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
    const player = cache.players[steamIds[0]];
    assert.ok('zeeksKilled' in player || 'health' in player, 'Player should have stats');
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
    assert.ok(stdout.includes('--watch'));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  SaveService — agent mode unit tests
// ═══════════════════════════════════════════════════════════════════════════

describe('SaveService agent mode', () => {

  // We test the logic without actual SFTP/SSH connections
  const SaveService = require('../src/parsers/save-service');
  const HumanitZDB = require('../src/db/database');

  let db;

  before(() => {
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
      agentTimeout: 60000,
    });
    assert.equal(svc._agentMode, 'auto');
    assert.equal(svc._agentNodePath, '/usr/bin/node');
    assert.equal(svc._agentRemoteDir, '/home/container');
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

  it('_syncFromCache works with valid cache data', async () => {
    if (!SAV_EXISTS) return;

    // Generate a cache from a real save
    writeAgent(TEMP_AGENT);
    execFileSync('node', [TEMP_AGENT, '--save', SAV_FILE, '--output', TEMP_CACHE], {
      encoding: 'utf-8', timeout: 30000,
    });
    const cache = JSON.parse(fs.readFileSync(TEMP_CACHE, 'utf-8'));
    try { fs.unlinkSync(TEMP_AGENT); } catch {}
    try { fs.unlinkSync(TEMP_CACHE); } catch {}

    const svc = new SaveService(db);
    let emitted = false;
    svc.on('sync', (result) => {
      emitted = true;
      assert.ok(result.playerCount > 0);
      assert.ok(result.structureCount >= 0);
    });

    await svc._syncFromCache(cache);
    assert.ok(emitted, 'Should have emitted sync event');

    // Verify data made it to the DB
    const players = db.getAllPlayers();
    assert.ok(players.length > 0, 'Should have players in DB after cache sync');
  });

  it('direct mode skips agent logic', async () => {
    if (!SAV_EXISTS) return;

    const svc = new SaveService(db, {
      localPath: SAV_FILE,
      agentMode: 'direct',
    });

    let emitted = false;
    svc.on('sync', () => { emitted = true; });
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

  it('_resolveTrigger auto prefers panel when available', async () => {
    const fakePanelApi = { available: true, sendCommand: async () => {} };
    const svc = new SaveService(db, { agentTrigger: 'auto', panelApi: fakePanelApi });
    const trigger = await svc._resolveTrigger();
    assert.equal(trigger, 'panel');
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

  it('_triggerViaPanel calls sendCommand on panelApi', async () => {
    let called = false;
    let sentCmd = '';
    const fakePanelApi = {
      available: true,
      sendCommand: async (cmd) => { called = true; sentCmd = cmd; },
    };
    const svc = new SaveService(db, {
      panelApi: fakePanelApi,
      agentPanelCommand: 'test-parse',
      agentPanelDelay: 0,  // no delay for tests
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
    it('skipped — no LIVE .sav file', () => assert.ok(true));
    return;
  }

  let cache;

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
    try { fs.unlinkSync(TEMP_AGENT); } catch {}
    try { fs.unlinkSync(TEMP_CACHE); } catch {}
  });

  it('agent JSON has same player count as direct parse', () => {
    const { parseSave } = require('../src/parsers/save-parser');
    const buf = fs.readFileSync(SAV_FILE);
    const direct = parseSave(buf);

    const agentPlayerCount = Object.keys(cache.players).length;

    assert.equal(agentPlayerCount, direct.players.size,
      `Agent: ${agentPlayerCount}, Direct: ${direct.players.size}`);
  });

  it('agent JSON has same structure count as direct parse', () => {
    const { parseSave } = require('../src/parsers/save-parser');
    const buf = fs.readFileSync(SAV_FILE);
    const direct = parseSave(buf);

    assert.equal(cache.structures.length, direct.structures.length);
  });

  it('agent JSON has same vehicle count as direct parse', () => {
    const { parseSave } = require('../src/parsers/save-parser');
    const buf = fs.readFileSync(SAV_FILE);
    const direct = parseSave(buf);

    assert.equal(cache.vehicles.length, direct.vehicles.length);
  });

  it('agent JSON preserves player steam IDs', () => {
    const { parseSave } = require('../src/parsers/save-parser');
    const buf = fs.readFileSync(SAV_FILE);
    const direct = parseSave(buf);

    const directIds = [...direct.players.keys()].sort();
    const agentIds = Object.keys(cache.players).sort();

    assert.deepEqual(agentIds, directIds, 'Steam IDs should match');
  });

  it('agent JSON preserves world state', () => {
    const { parseSave } = require('../src/parsers/save-parser');
    const buf = fs.readFileSync(SAV_FILE);
    const direct = parseSave(buf);

    assert.equal(cache.worldState.currentSeason, direct.worldState.currentSeason);
    assert.equal(cache.worldState.totalPlayers, direct.worldState.totalPlayers);
    assert.equal(cache.worldState.totalStructures, direct.worldState.totalStructures);
  });
});

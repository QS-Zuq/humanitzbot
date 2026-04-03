/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-floating-promises, @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/unbound-method */
/**
 * Tests for stdin-console.js — interactive CLI for headless hosts.
 *
 * Covers:
 *   - Command dispatch (help, players, player, online, search, etc.)
 *   - Read-only safety (state.set, state.delete, SQL mutations blocked without writable)
 *   - Writable mode allows mutations
 *   - RCON forwarding
 *   - SQL query execution
 *   - Edge cases (no DB, no RCON, unknown commands)
 *
 * Run:  npm test test/stdin-console.test.js
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import _database from '../src/db/database.js';
const HumanitZDB = _database as any;

import _stdin_console from '../src/stdin-console.js';
const StdinConsole = _stdin_console as any;

// Capture stdout writes from the console
function captureOutput(_console: unknown, fn: () => unknown): string[] | Promise<string[]> {
  const lines: string[] = [];
  const origWrite = process.stdout.write;
  process.stdout.write = (chunk: unknown) => {
    lines.push(String(chunk).replace(/\n$/, ''));
    return true;
  };
  try {
    const result = fn();
    // Handle async
    if (result && typeof (result as Promise<unknown>).then === 'function') {
      return (result as Promise<unknown>)
        .then(() => {
          process.stdout.write = origWrite;
          return lines;
        })
        .catch((err: unknown) => {
          process.stdout.write = origWrite;
          throw err;
        });
    }
    process.stdout.write = origWrite;
    return lines;
  } catch (err) {
    process.stdout.write = origWrite;
    throw err;
  }
}

describe('StdinConsole', () => {
  let db: typeof HumanitZDB;
  let sc: typeof StdinConsole;

  before(() => {
    db = new HumanitZDB({ memory: true });
    db.init();
    // Seed some test data
    db.upsertPlayer('76561198000000001', {
      name: 'TestPlayer',
      level: 15,
      zeeksKilled: 42,
      headshots: 10,
      daysSurvived: 5,
      health: 80,
      maxHealth: 100,
      hunger: 60,
      thirst: 70,
      infection: 0,
    });
    db.upsertPlayer('76561198000000002', {
      name: 'AnotherPlayer',
      level: 8,
      zeeksKilled: 100,
      headshots: 30,
      daysSurvived: 12,
      health: 100,
      maxHealth: 100,
    });
    db.setPlayerOnline('76561198000000001', true);
    db.setState('test_key', 'test_value');
    db.setStateJSON('json_key', { hello: 'world' });
  });

  after(() => {
    if (db) db.close();
  });

  beforeEach(() => {
    sc = new StdinConsole({ db, writable: false });
  });

  // ── help ────────────────────────────────────────────────────

  it('help command lists available commands', async () => {
    const lines = await captureOutput(sc, () => sc._dispatch('help'));
    const joined = (lines as string[]).join('\n');
    assert.ok(joined.includes('players'), 'Should mention players command');
    assert.ok(joined.includes('sql'), 'Should mention sql command');
    assert.ok(joined.includes('state.get'), 'Should mention state.get');
  });

  // ── players ─────────────────────────────────────────────────

  it('players command lists players', async () => {
    const lines = await captureOutput(sc, () => sc._dispatch('players'));
    const joined = (lines as string[]).join('\n');
    assert.ok(joined.includes('TestPlayer'), 'Should list TestPlayer');
    assert.ok(joined.includes('AnotherPlayer'), 'Should list AnotherPlayer');
    assert.ok(joined.includes('76561198000000001'), 'Should show steam ID');
  });

  it('players with limit', async () => {
    const lines = await captureOutput(sc, () => sc._dispatch('players 1'));
    const joined = (lines as string[]).join('\n');
    // Should show header + separator + 1 player + the count line
    assert.ok(joined.includes('Players (1/2)'), 'Should show 1 of 2');
  });

  // ── player ──────────────────────────────────────────────────

  it('player shows detailed info', async () => {
    const lines = await captureOutput(sc, () => sc._dispatch('player 76561198000000001'));
    const joined = (lines as string[]).join('\n');
    assert.ok(joined.includes('TestPlayer'), 'Should show name');
    assert.ok(joined.includes('76561198000000001'), 'Should show steam ID');
    assert.ok(joined.includes('15'), 'Should show level');
    assert.ok(joined.includes('42'), 'Should show kills');
    assert.ok(joined.includes('Online:'), 'Should show online status');
  });

  it('player with unknown steamId', async () => {
    const lines = await captureOutput(sc, () => sc._dispatch('player 99999999999999999'));
    const joined = (lines as string[]).join('\n');
    assert.ok(joined.includes('not found'), 'Should say not found');
  });

  it('player with no args shows usage', async () => {
    const lines = await captureOutput(sc, () => sc._dispatch('player'));
    const joined = (lines as string[]).join('\n');
    assert.ok(joined.includes('Usage'), 'Should show usage');
  });

  // ── online ──────────────────────────────────────────────────

  it('online shows online players', async () => {
    const lines = await captureOutput(sc, () => sc._dispatch('online'));
    const joined = (lines as string[]).join('\n');
    assert.ok(joined.includes('TestPlayer'), 'Should show online player');
    assert.ok(joined.includes('1'), 'Should show count');
  });

  // ── search ──────────────────────────────────────────────────

  it('search finds players by name', async () => {
    const lines = await captureOutput(sc, () => sc._dispatch('search Test'));
    const joined = (lines as string[]).join('\n');
    assert.ok(joined.includes('TestPlayer') || joined.includes('test'), 'Should find TestPlayer');
  });

  it('search with no args shows usage', async () => {
    const lines = await captureOutput(sc, () => sc._dispatch('search'));
    const joined = (lines as string[]).join('\n');
    assert.ok(joined.includes('Usage'), 'Should show usage');
  });

  // ── state ───────────────────────────────────────────────────

  it('state.list shows all state entries', async () => {
    const lines = await captureOutput(sc, () => sc._dispatch('state.list'));
    const joined = (lines as string[]).join('\n');
    assert.ok(joined.includes('test_key'), 'Should show test_key');
    assert.ok(joined.includes('json_key'), 'Should show json_key');
  });

  it('state.get shows a value', async () => {
    const lines = await captureOutput(sc, () => sc._dispatch('state.get test_key'));
    const joined = (lines as string[]).join('\n');
    assert.ok(joined.includes('test_value'), 'Should show value');
  });

  it('state.get with JSON pretty-prints', async () => {
    const lines = await captureOutput(sc, () => sc._dispatch('state.get json_key'));
    const joined = (lines as string[]).join('\n');
    assert.ok(joined.includes('"hello"'), 'Should pretty-print JSON');
    assert.ok(joined.includes('"world"'), 'Should pretty-print value');
  });

  it('state.get with unknown key says not found', async () => {
    const lines = await captureOutput(sc, () => sc._dispatch('state.get nonexistent'));
    const joined = (lines as string[]).join('\n');
    assert.ok(joined.includes('not found'), 'Should say not found');
  });

  it('state alone acts as state.list', async () => {
    const lines = await captureOutput(sc, () => sc._dispatch('state'));
    const joined = (lines as string[]).join('\n');
    assert.ok(joined.includes('test_key'), 'state alone should list entries');
  });

  it('state <key> acts as state.get', async () => {
    const lines = await captureOutput(sc, () => sc._dispatch('state test_key'));
    const joined = (lines as string[]).join('\n');
    assert.ok(joined.includes('test_value'), 'state <key> should show value');
  });

  // ── state.set (read-only mode) ─────────────────────────────

  it('state.set blocked in read-only mode', async () => {
    const lines = await captureOutput(sc, () => sc._dispatch('state.set foo bar'));
    const joined = (lines as string[]).join('\n');
    assert.ok(joined.includes('Write operations disabled'), 'Should block write');
  });

  it('state.delete blocked in read-only mode', async () => {
    const lines = await captureOutput(sc, () => sc._dispatch('state.delete test_key'));
    const joined = (lines as string[]).join('\n');
    assert.ok(joined.includes('Write operations disabled'), 'Should block delete');
  });

  // ── state.set (writable mode) ──────────────────────────────

  it('state.set works in writable mode', async () => {
    const wsc = new StdinConsole({ db, writable: true });
    const lines = await captureOutput(wsc, () => wsc._dispatch('state.set new_key new_value'));
    const joined = (lines as string[]).join('\n');
    assert.ok(joined.includes('Set'), 'Should confirm set');
    assert.equal(db.getState('new_key'), 'new_value');
    // Cleanup
    db.deleteState('new_key');
  });

  it('state.delete works in writable mode', async () => {
    db.setState('temp_key', 'temp');
    const wsc = new StdinConsole({ db, writable: true });
    const lines = await captureOutput(wsc, () => wsc._dispatch('state.delete temp_key'));
    const joined = (lines as string[]).join('\n');
    assert.ok(joined.includes('Deleted'), 'Should confirm delete');
    assert.equal(db.getState('temp_key'), null);
  });

  // ── stats ───────────────────────────────────────────────────

  it('stats shows table row counts', async () => {
    const lines = await captureOutput(sc, () => sc._dispatch('stats'));
    const joined = (lines as string[]).join('\n');
    assert.ok(joined.includes('players'), 'Should show players table');
    assert.ok(joined.includes('bot_state'), 'Should show bot_state table');
    assert.ok(joined.includes('TOTAL'), 'Should show total');
  });

  // ── tables ──────────────────────────────────────────────────

  it('tables lists all tables', async () => {
    const lines = await captureOutput(sc, () => sc._dispatch('tables'));
    const joined = (lines as string[]).join('\n');
    assert.ok(joined.includes('players'), 'Should list players');
    assert.ok(joined.includes('activity_log'), 'Should list activity_log');
    assert.ok(joined.includes('bot_state'), 'Should list bot_state');
  });

  // ── sql ─────────────────────────────────────────────────────

  it('sql executes read-only queries', async () => {
    const lines = await captureOutput(sc, () => sc._dispatch('sql SELECT COUNT(*) as cnt FROM players'));
    const joined = (lines as string[]).join('\n');
    assert.ok(joined.includes('2'), 'Should show 2 players');
    assert.ok(joined.includes('cnt'), 'Should show column name');
  });

  it('sql blocks mutations in read-only mode', async () => {
    const lines = await captureOutput(sc, () => sc._dispatch("sql DELETE FROM players WHERE steam_id = 'x'"));
    const joined = (lines as string[]).join('\n');
    assert.ok(joined.includes('Only SELECT'), 'Should block mutation');
  });

  it('sql allows mutations in writable mode', async () => {
    const wsc = new StdinConsole({ db, writable: true });
    // Insert a temp row, then delete it
    db.setState('sql_test', 'y');
    const lines = await captureOutput(wsc, () => wsc._dispatch("sql DELETE FROM bot_state WHERE key = 'sql_test'"));
    const joined = (lines as string[]).join('\n');
    assert.ok(joined.includes('OK'), 'Should allow mutation');
    assert.ok(joined.includes('1 row'), 'Should report rows affected');
  });

  it('sql shows (no rows) for empty result', async () => {
    const lines = await captureOutput(sc, () =>
      sc._dispatch("sql SELECT * FROM players WHERE steam_id = 'nonexistent'"),
    );
    const joined = (lines as string[]).join('\n');
    assert.ok(joined.includes('(no rows)'), 'Should show no rows');
  });

  it('sql shows error for bad query', async () => {
    const lines = await captureOutput(sc, () => sc._dispatch('sql SELECT * FROM nonexistent_table'));
    const joined = (lines as string[]).join('\n');
    assert.ok(joined.includes('SQL error'), 'Should show error');
  });

  // ── unknown command ─────────────────────────────────────────

  it('unknown command shows error', async () => {
    const lines = await captureOutput(sc, () => sc._dispatch('foobar'));
    const joined = (lines as string[]).join('\n');
    assert.ok(joined.includes('Unknown command'), 'Should say unknown');
    assert.ok(joined.includes('foobar'), 'Should echo the command');
  });

  // ── no database ─────────────────────────────────────────────

  it('commands work gracefully without DB', async () => {
    const noDb = new StdinConsole({ db: null });
    const cmds = [
      'players',
      'player 123',
      'online',
      'search x',
      'stats',
      'tables',
      'state.list',
      'state.get x',
      'activity',
      'chat',
      'world',
      'clans',
      'vehicles',
    ];
    for (const cmd of cmds) {
      const lines = await captureOutput(noDb, () => noDb._dispatch(cmd));
      const joined = (lines as string[]).join('\n');
      assert.ok(joined.includes('No database') || joined.includes('not available'), `${cmd} should handle no DB`);
    }
  });

  // ── world ───────────────────────────────────────────────────

  it('world shows world state', async () => {
    db.setWorldState('day_count', '42');
    const lines = await captureOutput(sc, () => sc._dispatch('world'));
    const joined = (lines as string[]).join('\n');
    assert.ok(joined.includes('day_count') || joined.includes('42'), 'Should show world state');
  });

  // ── constructor / lifecycle ─────────────────────────────────

  it('stop is safe to call without start', () => {
    const c = new StdinConsole({ db });
    c.stop(); // should not throw
  });

  it('start/stop lifecycle', () => {
    const c = new StdinConsole({ db });
    // We can't easily test start() since it reads from real stdin,
    // but we can verify the object initializes correctly
    assert.equal(c._started, false);
    assert.equal(c._writable, false);
    assert.ok(c._db);
  });
});

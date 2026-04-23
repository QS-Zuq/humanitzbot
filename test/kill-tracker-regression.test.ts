/**
 * Regression tests for KillTracker.load() bad-record handling.
 *
 * P1-C: load() migrate block must DELETE invalid player records (null / array /
 * non-object) so that:
 *   1. accumulate() does not crash on record.lastSnapshot access for that sid
 *   2. save() / setStateJSONValidated is not blocked by normalizer validation error
 *      caused by the bad record still being in this._data.players
 *
 * All tests use node:test + node:assert/strict.
 * No vitest. afterEach clears botStateEvents listeners, mode env, and mock state.
 */

import { afterEach, before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { BotStateRepository } from '../src/db/repositories/bot-state-repository.js';
import { botStateEvents } from '../src/state/bot-state-events.js';
import { reloadSchemaMode } from '../src/state/bot-state-mode.js';
import { KillTracker } from '../src/tracking/kill-tracker.js';

// ─── In-memory DB setup ────────────────────────────────────────────────────

let handle: InstanceType<typeof Database>;
let repo: BotStateRepository;

before(() => {
  handle = new Database(':memory:');
  handle.exec(`
    CREATE TABLE bot_state (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  repo = new BotStateRepository(handle);
});

after(() => {
  handle.close();
});

afterEach(() => {
  botStateEvents.removeAllListeners('parse-error');
  botStateEvents.removeAllListeners('shape-invalid');
  botStateEvents.removeAllListeners('migration-failed');
  handle.exec('DELETE FROM bot_state');
  delete process.env.BOT_STATE_SCHEMA_MODE;
  reloadSchemaMode();
});

// ─── Helpers ───────────────────────────────────────────────────────────────

function setRaw(key: string, value: unknown): void {
  handle.prepare('INSERT OR REPLACE INTO bot_state (key, value) VALUES (?, ?)').run(key, JSON.stringify(value));
}

function getRaw(key: string): unknown {
  const row = handle.prepare('SELECT value FROM bot_state WHERE key = ?').get(key) as { value: string } | undefined;
  if (!row?.value) return null;
  return JSON.parse(row.value) as unknown;
}

function validPlayerRecord() {
  const emptyKill = {
    zeeksKilled: 0,
    headshots: 0,
    meleeKills: 0,
    gunKills: 0,
    blastKills: 0,
    fistKills: 0,
    takedownKills: 0,
    vehicleKills: 0,
  };
  const survival = { daysSurvived: 0 };
  return {
    cumulative: { ...emptyKill },
    lastSnapshot: { ...emptyKill },
    survivalCumulative: { ...survival },
    survivalSnapshot: { ...survival },
    hasExtendedStats: false,
    deathCheckpoint: null,
    lastKnownDeaths: 0,
    lifetimeSnapshot: null,
    survivalLifetimeSnapshot: null,
    lastLifetimeSnapshot: null,
    lastSurvivalLifetimeSnapshot: null,
    activitySnapshot: {},
    activityArraySnapshot: {},
    challengeSnapshot: {},
  };
}

function makePlayerStatsStub() {
  return {
    getStats: (_id: string) => null,
    getNameForId: (id: string) => id,
    getStatsByName: (_name: string) => null,
  } as unknown as import('../src/tracking/player-stats.js').PlayerStats;
}

function makePlaytimeStub() {
  return {
    getPlaytime: (_id: string) => null,
  } as unknown as import('../src/tracking/playtime-tracker.js').PlaytimeTracker;
}

function makeConfigStub() {
  return {
    getToday: () => '2025-01-01',
  } as unknown as typeof import('../src/config/index.js').default;
}

function makeDb(): { botState: BotStateRepository } {
  return { botState: repo };
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('KillTracker.load() bad-record cleanup (P1-C regression)', () => {
  it('Test A: mode=off — null sibling does not block save() for healthy player', () => {
    process.env.BOT_STATE_SCHEMA_MODE = 'off';
    reloadSchemaMode();

    setRaw('kill_tracker', {
      players: {
        steam_bad: null,
        steam_ok: validPlayerRecord(),
      },
      lastPollDate: null,
    });

    const tracker = new KillTracker({
      db: makeDb() as unknown as import('../src/db/database.js').HumanitZDB,
      playerStats: makePlayerStatsStub(),
      playtime: makePlaytimeStub(),
      config: makeConfigStub(),
      label: 'test-a',
    });

    assert.doesNotThrow(() => {
      tracker.load();
    }, 'load() must not throw');
    assert.equal(
      (tracker.players as Record<string, unknown>)['steam_bad'],
      undefined,
      'steam_bad must be removed after load()',
    );
    assert.ok((tracker.players as Record<string, unknown>)['steam_ok'] !== undefined, 'steam_ok must survive load()');

    const saveData = new Map<string, Record<string, unknown>>([
      [
        'steam_ok',
        {
          zeeksKilled: 5,
          headshots: 1,
          meleeKills: 0,
          gunKills: 5,
          blastKills: 0,
          fistKills: 0,
          takedownKills: 0,
          vehicleKills: 0,
          daysSurvived: 1,
          hasExtendedStats: false,
        },
      ],
    ]);
    assert.doesNotThrow(() => {
      tracker.accumulate(saveData as unknown as Map<string, Record<string, unknown>>);
    }, 'accumulate() must not crash after load()');

    assert.doesNotThrow(() => {
      tracker.save();
    }, 'save() must not throw');

    const stored = getRaw('kill_tracker') as { players: Record<string, unknown> } | null;
    assert.ok(stored !== null, 'kill_tracker row must exist in DB after save()');
    const storedPlayers = (stored as { players: Record<string, unknown> }).players;
    assert.equal(storedPlayers['steam_bad'], undefined, 'DB must not contain steam_bad after save()');
    assert.ok(storedPlayers['steam_ok'] !== undefined, 'DB must contain steam_ok after save()');
  });

  it('Test B: array record does not crash accumulate() — bad record dropped', () => {
    process.env.BOT_STATE_SCHEMA_MODE = 'off';
    reloadSchemaMode();

    setRaw('kill_tracker', {
      players: {
        steam_arr: [1, 2, 3],
        steam_ok: validPlayerRecord(),
      },
      lastPollDate: null,
    });

    const tracker = new KillTracker({
      db: makeDb() as unknown as import('../src/db/database.js').HumanitZDB,
      playerStats: makePlayerStatsStub(),
      playtime: makePlaytimeStub(),
      config: makeConfigStub(),
      label: 'test-b',
    });

    assert.doesNotThrow(() => {
      tracker.load();
    }, 'load() must not throw for array record');

    assert.equal(
      (tracker.players as Record<string, unknown>)['steam_arr'],
      undefined,
      'steam_arr (array) must be removed after load()',
    );

    const saveData = new Map<string, Record<string, unknown>>([
      ['steam_arr', { zeeksKilled: 3, daysSurvived: 0, hasExtendedStats: false }],
      [
        'steam_ok',
        {
          zeeksKilled: 2,
          headshots: 0,
          meleeKills: 0,
          gunKills: 2,
          blastKills: 0,
          fistKills: 0,
          takedownKills: 0,
          vehicleKills: 0,
          daysSurvived: 1,
          hasExtendedStats: false,
        },
      ],
    ]);
    assert.doesNotThrow(() => {
      tracker.accumulate(saveData as unknown as Map<string, Record<string, unknown>>);
    }, 'accumulate() must not crash for array record path');
  });

  it('Test C: all players bad — players becomes {} — save() does not throw', () => {
    process.env.BOT_STATE_SCHEMA_MODE = 'off';
    reloadSchemaMode();

    setRaw('kill_tracker', {
      players: {
        a: null,
        b: [],
        c: 'bad',
      },
      lastPollDate: null,
    });

    const tracker = new KillTracker({
      db: makeDb() as unknown as import('../src/db/database.js').HumanitZDB,
      playerStats: makePlayerStatsStub(),
      playtime: makePlaytimeStub(),
      config: makeConfigStub(),
      label: 'test-c',
    });

    assert.doesNotThrow(() => {
      tracker.load();
    }, 'load() must not throw when all records are bad');
    assert.deepEqual(tracker.players, {}, 'players must be empty after all bad records dropped');

    tracker.accumulate(new Map());
    assert.doesNotThrow(() => {
      tracker.save();
    }, 'save() must not throw with empty players');
  });

  it('Test D: mode=dry-run — bad records dropped, save succeeds', () => {
    process.env.BOT_STATE_SCHEMA_MODE = 'dry-run';
    reloadSchemaMode();

    setRaw('kill_tracker', {
      players: {
        steam_bad: null,
        steam_ok: validPlayerRecord(),
      },
      lastPollDate: null,
    });

    const tracker = new KillTracker({
      db: makeDb() as unknown as import('../src/db/database.js').HumanitZDB,
      playerStats: makePlayerStatsStub(),
      playtime: makePlaytimeStub(),
      config: makeConfigStub(),
      label: 'test-d',
    });

    assert.doesNotThrow(() => {
      tracker.load();
    }, 'load() must not throw in dry-run mode');
    assert.equal(
      (tracker.players as Record<string, unknown>)['steam_bad'],
      undefined,
      'steam_bad must be removed in dry-run mode',
    );

    tracker.accumulate(
      new Map([
        [
          'steam_ok',
          {
            zeeksKilled: 1,
            headshots: 0,
            meleeKills: 0,
            gunKills: 1,
            blastKills: 0,
            fistKills: 0,
            takedownKills: 0,
            vehicleKills: 0,
            daysSurvived: 0,
            hasExtendedStats: false,
          } as unknown as Record<string, unknown>,
        ],
      ]),
    );
    assert.doesNotThrow(() => {
      tracker.save();
    }, 'save() must not throw in dry-run mode');
  });
});

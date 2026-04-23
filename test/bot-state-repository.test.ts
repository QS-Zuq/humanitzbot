/**
 * Unit tests for BotStateRepository.getStateJSONValidated / setStateJSONValidated
 * and the bot-state-mode.ts mode lifecycle.
 *
 * All tests use node:test + node:assert/strict.
 * No vitest (vi.mock / vi.fn) — only node:test mock API.
 *
 * Convention (C6):
 *   afterEach must call botStateEvents.removeAllListeners(...) + mock.restoreAll()
 *   to prevent cross-test listener leakage.
 */

import { after, afterEach, before, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { BotStateRepository } from '../src/db/repositories/bot-state-repository.js';
import { botStateEvents } from '../src/state/bot-state-events.js';
import { getSchemaMode, reloadSchemaMode } from '../src/state/bot-state-mode.js';
import {
  KILL_TRACKER_DEFAULT,
  normalizeKillTracker,
  normalizeGithubTracker,
  type KillTrackerShape,
  type GithubTrackerShape,
} from '../src/state/bot-state-schemas.js';

// ─── Test DB setup ─────────────────────────────────────────────────────────

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
  // C6 convention: clean up listeners + mocks after every test
  botStateEvents.removeAllListeners('parse-error');
  botStateEvents.removeAllListeners('shape-invalid');
  botStateEvents.removeAllListeners('migration-failed');
  mock.restoreAll();
  // Reset any rows written during the test
  handle.exec('DELETE FROM bot_state');
  // Restore mode env vars
  delete process.env.BOT_STATE_SCHEMA_MODE;
  reloadSchemaMode();
});

// ─── Helpers ───────────────────────────────────────────────────────────────

function setRaw(key: string, value: string): void {
  handle.prepare('INSERT OR REPLACE INTO bot_state (key, value) VALUES (?, ?)').run(key, value);
}

function getRaw(key: string): string | null {
  const row = handle.prepare('SELECT value FROM bot_state WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

// A minimal valid kill_tracker with one player
function validKillTracker(): KillTrackerShape {
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
    players: {
      steam_123: {
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
      },
    },
  };
}

// ─── getStateJSONValidated tests ───────────────────────────────────────────

describe('BotStateRepository.getStateJSONValidated', () => {
  it('happy path — valid JSON + schema match returns parsed value', () => {
    process.env.BOT_STATE_SCHEMA_MODE = 'enforce';
    reloadSchemaMode();
    const kt = validKillTracker();
    setRaw('kill_tracker', JSON.stringify(kt));
    const events: string[] = [];
    botStateEvents.on('shape-invalid', (e) => events.push(e.key));

    const result = repo.getStateJSONValidated('kill_tracker', normalizeKillTracker, KILL_TRACKER_DEFAULT);
    assert.equal(result.players['steam_123']?.hasExtendedStats, false);
    assert.equal(events.length, 0, 'no shape-invalid event for valid shape');
  });

  it('parse failure emits parse-error event and returns defaultVal, DB row preserved', () => {
    process.env.BOT_STATE_SCHEMA_MODE = 'enforce';
    reloadSchemaMode();
    setRaw('kill_tracker', '{"broken');
    const parseErrors: { key: string; error: string }[] = [];
    botStateEvents.on('parse-error', (e) => parseErrors.push(e));

    const result = repo.getStateJSONValidated('kill_tracker', normalizeKillTracker, KILL_TRACKER_DEFAULT);
    assert.deepEqual(result, KILL_TRACKER_DEFAULT);
    assert.equal(parseErrors.length, 1);
    const parseErr = parseErrors[0];
    assert.ok(parseErr !== undefined);
    assert.equal(parseErr.key, 'kill_tracker');
    // DB row must NOT be overwritten
    assert.equal(getRaw('kill_tracker'), '{"broken');
  });

  it('shape invalid emits shape-invalid, returns shape (enforce), DB row preserved', () => {
    process.env.BOT_STATE_SCHEMA_MODE = 'enforce';
    reloadSchemaMode();
    const badRaw = JSON.stringify({ players: null });
    setRaw('kill_tracker', badRaw);
    const shapeEvents: { key: string; issues: string[] }[] = [];
    botStateEvents.on('shape-invalid', (e) => shapeEvents.push(e));

    const result = repo.getStateJSONValidated('kill_tracker', normalizeKillTracker, KILL_TRACKER_DEFAULT);
    assert.equal(shapeEvents.length, 1);
    const shapeEvt = shapeEvents[0];
    assert.ok(shapeEvt !== undefined);
    assert.equal(shapeEvt.key, 'kill_tracker');
    assert.ok(shapeEvt.issues.length > 0, 'issues array non-empty');
    // enforce: returns partial-recovery shape (players === {})
    assert.deepEqual(result.players, {});
    // DB row must NOT be overwritten
    assert.equal(getRaw('kill_tracker'), badRaw);
  });

  it('mode=off does not emit events and behaves like getStateJSON', () => {
    process.env.BOT_STATE_SCHEMA_MODE = 'off';
    reloadSchemaMode();
    setRaw('kill_tracker', '{"broken');
    const events: string[] = [];
    botStateEvents.on('parse-error', (e) => events.push(e.key));
    botStateEvents.on('shape-invalid', (e) => events.push(e.key));

    const result = repo.getStateJSONValidated('kill_tracker', normalizeKillTracker, KILL_TRACKER_DEFAULT);
    assert.deepEqual(result, KILL_TRACKER_DEFAULT);
    assert.equal(events.length, 0, 'mode=off must not emit events');
  });

  it('mode=dry-run emits shape-invalid but returns raw parsed value', () => {
    process.env.BOT_STATE_SCHEMA_MODE = 'dry-run';
    reloadSchemaMode();
    const badRaw = { players: null, lastPollDate: '2025-01-01' };
    setRaw('kill_tracker', JSON.stringify(badRaw));
    const shapeEvents: { key: string }[] = [];
    botStateEvents.on('shape-invalid', (e) => shapeEvents.push(e));

    const result = repo.getStateJSONValidated('kill_tracker', normalizeKillTracker, KILL_TRACKER_DEFAULT);
    assert.equal(shapeEvents.length, 1, 'dry-run must emit shape-invalid');
    // dry-run: returns the raw parsed value, not shape or defaultVal
    const rawResult = result as unknown as { players: unknown; lastPollDate: unknown };
    assert.equal(rawResult.players, null);
    assert.equal(rawResult.lastPollDate, '2025-01-01');
  });

  it('mode=enforce shape-invalid returns partial-recovery shape', () => {
    process.env.BOT_STATE_SCHEMA_MODE = 'enforce';
    reloadSchemaMode();
    setRaw('kill_tracker', JSON.stringify({ players: null }));
    const shapeEvents: { key: string }[] = [];
    botStateEvents.on('shape-invalid', (e) => shapeEvents.push(e));

    const result = repo.getStateJSONValidated('kill_tracker', normalizeKillTracker, KILL_TRACKER_DEFAULT);
    assert.equal(shapeEvents.length, 1);
    assert.deepEqual(result.players, {});
  });

  it('each failure emits exactly 1 event (no double-emit)', () => {
    process.env.BOT_STATE_SCHEMA_MODE = 'enforce';
    reloadSchemaMode();
    setRaw('kill_tracker', '{"broken');
    let count = 0;
    botStateEvents.on('parse-error', () => count++);

    repo.getStateJSONValidated('kill_tracker', normalizeKillTracker, KILL_TRACKER_DEFAULT);
    assert.equal(count, 1);
  });

  it('missing key returns defaultVal without emitting any event', () => {
    process.env.BOT_STATE_SCHEMA_MODE = 'enforce';
    reloadSchemaMode();
    const events: string[] = [];
    botStateEvents.on('parse-error', (e) => events.push(e.key));
    botStateEvents.on('shape-invalid', (e) => events.push(e.key));

    const result = repo.getStateJSONValidated('nonexistent_key_xyz', normalizeKillTracker, KILL_TRACKER_DEFAULT);
    assert.deepEqual(result, KILL_TRACKER_DEFAULT);
    assert.equal(events.length, 0);
  });
});

// ─── setStateJSONValidated tests ───────────────────────────────────────────

describe('BotStateRepository.setStateJSONValidated', () => {
  it('valid value is written to DB without throwing', () => {
    const kt = validKillTracker();
    repo.setStateJSONValidated('kill_tracker', normalizeKillTracker, kt);
    const raw = getRaw('kill_tracker');
    assert.ok(raw !== null, 'row should exist after valid write');
    assert.equal((JSON.parse(raw) as KillTrackerShape).players['steam_123']?.hasExtendedStats, false);
  });

  it('invalid value throws and DB row is NOT written', () => {
    const badVal = { players: null } as unknown as KillTrackerShape;
    assert.throws(() => {
      repo.setStateJSONValidated('kill_tracker', normalizeKillTracker, badVal);
    }, /bot_state\.kill_tracker failed validation/);
    assert.equal(getRaw('kill_tracker'), null);
  });

  it('github_tracker valid value round-trip', () => {
    const gt: GithubTrackerShape = {
      'owner/repo': { seenPrIds: [1, 2, 3], bootstrapped: true },
    };
    repo.setStateJSONValidated('github_tracker', normalizeGithubTracker, gt);
    const raw = getRaw('github_tracker');
    assert.ok(raw !== null);
    assert.deepEqual((JSON.parse(raw) as GithubTrackerShape)['owner/repo']?.seenPrIds, [1, 2, 3]);
  });

  // P1-3 regression: normalizer must emit issues for substituted fields (hasExtendedStats, etc.)
  it('P1-3: invalid hasExtendedStats produces issues → normalizeKillTracker issues.length > 0 → setStateJSONValidated throws', () => {
    // Build a kill tracker with a player whose hasExtendedStats is not a boolean
    const kt = validKillTracker();
    // Force hasExtendedStats to a non-boolean to simulate a corrupted write
    const playerRecord = kt.players['steam_123'] as unknown as Record<string, unknown>;
    playerRecord['hasExtendedStats'] = 'yes'; // wrong type

    const { issues } = normalizeKillTracker(kt as unknown);
    assert.ok(
      issues.length > 0,
      `normalizer must report issue for bad hasExtendedStats, got: ${JSON.stringify(issues)}`,
    );
    assert.ok(
      issues.some((i) => i.includes('hasExtendedStats')),
      `issues must mention hasExtendedStats, got: ${JSON.stringify(issues)}`,
    );

    assert.throws(
      () => {
        repo.setStateJSONValidated('kill_tracker', normalizeKillTracker, kt as unknown as KillTrackerShape);
      },
      /bot_state\.kill_tracker failed validation/,
      'setStateJSONValidated must throw when normalizer reports issues',
    );
    assert.equal(getRaw('kill_tracker'), null, 'DB row must not be written on throw');
  });

  it('P1-3: invalid activitySnapshot produces issues → setStateJSONValidated throws', () => {
    const kt = validKillTracker();
    const playerRecord = kt.players['steam_123'] as unknown as Record<string, unknown>;
    playerRecord['activitySnapshot'] = 'not-an-object'; // wrong type

    const { issues } = normalizeKillTracker(kt as unknown);
    assert.ok(issues.length > 0, 'normalizer must report issue for bad activitySnapshot');

    assert.throws(() => {
      repo.setStateJSONValidated('kill_tracker', normalizeKillTracker, kt as unknown as KillTrackerShape);
    }, /bot_state\.kill_tracker failed validation/);
  });
});

// ─── T1: Downstream defensive test (S7 dry-run mitigation) ────────────────

describe('T1 downstream defensive — dry-run + bad raw caller guard', () => {
  it('caller WITHOUT guard crashes on dry-run bad shape; with guard is safe', () => {
    process.env.BOT_STATE_SCHEMA_MODE = 'dry-run';
    reloadSchemaMode();
    setRaw('kill_tracker', JSON.stringify({ players: null }));

    const result = repo.getStateJSONValidated('kill_tracker', normalizeKillTracker, KILL_TRACKER_DEFAULT);

    // Non-defensive access: Object.keys(null) throws
    let crashedWithoutGuard = false;
    try {
      Object.keys((result as unknown as KillTrackerShape).players);
    } catch {
      crashedWithoutGuard = true;
    }
    assert.ok(crashedWithoutGuard, 'non-defensive access DOES crash in dry-run — docstring warning is necessary');

    // Defensive access pattern: typeof guard prevents crash
    let crashedWithGuard = false;
    try {
      const players = (result as unknown as KillTrackerShape).players;
      if (typeof players === 'object') {
        // players is a non-null object here (typeof object guard satisfied)
        Object.keys(Object.assign({}, players));
      }
    } catch {
      crashedWithGuard = true;
    }
    assert.ok(!crashedWithGuard, 'defensive access must not crash');
  });
});

// ─── P1-B: kill_tracker corrupt player records ────────────────────────────

describe('P1-B kill_tracker corrupt player records (load migration guard)', () => {
  it('players: { steam_abc: null } — normalizer returns shape with empty players', () => {
    process.env.BOT_STATE_SCHEMA_MODE = 'enforce';
    reloadSchemaMode();
    setRaw('kill_tracker', JSON.stringify({ players: { steam_abc: null } }));

    const result = repo.getStateJSONValidated('kill_tracker', normalizeKillTracker, KILL_TRACKER_DEFAULT);
    // normalizer should produce an empty players object (null entry stripped)
    assert.ok(typeof result.players === 'object', 'players must be a non-null object');
    assert.ok(!('steam_abc' in result.players), 'null player record must not survive normalization');
  });

  it('players: { steam_abc: [] } — normalizer returns shape without crashing', () => {
    process.env.BOT_STATE_SCHEMA_MODE = 'enforce';
    reloadSchemaMode();
    setRaw('kill_tracker', JSON.stringify({ players: { steam_abc: [] } }));

    assert.doesNotThrow(() => {
      repo.getStateJSONValidated('kill_tracker', normalizeKillTracker, KILL_TRACKER_DEFAULT);
    }, 'getStateJSONValidated must not throw for array-valued player record');
  });

  it('healthy sibling player is preserved when one record is null', () => {
    process.env.BOT_STATE_SCHEMA_MODE = 'enforce';
    reloadSchemaMode();
    const valid = validKillTracker();
    const mixed = { players: { ...valid.players, steam_bad: null } };
    setRaw('kill_tracker', JSON.stringify(mixed));

    const result = repo.getStateJSONValidated('kill_tracker', normalizeKillTracker, KILL_TRACKER_DEFAULT);
    // The valid steam_123 entry must still be present
    assert.ok('steam_123' in result.players, 'valid sibling player steam_123 must be preserved');
  });
});

// ─── P1-B: weekly_baseline players null/bad guard ─────────────────────────

describe('P1-B weekly_baseline players null/bad guard (dry-run defensive)', () => {
  it('weekly_baseline players: null — caller guard produces safe empty object', () => {
    process.env.BOT_STATE_SCHEMA_MODE = 'dry-run';
    reloadSchemaMode();
    const badBaseline = { weekStart: '2025-01-01T00:00:00.000Z', players: null };
    setRaw('weekly_baseline', JSON.stringify(badBaseline));

    const result: unknown = repo.getStateJSONValidated(
      'weekly_baseline',
      // minimal normalizer stub that always passes (dry-run returns raw)
      (_raw: unknown) => ({ shape: _raw, issues: [] }),
      { weekStart: null, players: {} },
    );

    // Defensive caller pattern from kill-tracker fix
    const rawPlayers = (result as { players?: unknown }).players;
    const safePlayers =
      rawPlayers !== null && typeof rawPlayers === 'object' && !Array.isArray(rawPlayers)
        ? (rawPlayers as Record<string, unknown>)
        : {};

    assert.doesNotThrow(() => {
      Object.keys(safePlayers);
    }, 'defensive guard must produce safe iterable object when players is null');
    assert.deepEqual(Object.keys(safePlayers), [], 'fallback must be empty object');
  });

  it('weekly_baseline players: "bad" string — caller guard produces safe empty object', () => {
    process.env.BOT_STATE_SCHEMA_MODE = 'dry-run';
    reloadSchemaMode();
    const badBaseline = { weekStart: '2025-01-01T00:00:00.000Z', players: 'bad' };
    setRaw('weekly_baseline', JSON.stringify(badBaseline));

    const result: unknown = repo.getStateJSONValidated(
      'weekly_baseline',
      (_raw: unknown) => ({ shape: _raw, issues: [] }),
      { weekStart: null, players: {} },
    );

    const rawPlayers = (result as { players?: unknown }).players;
    const safePlayers =
      rawPlayers !== null && typeof rawPlayers === 'object' && !Array.isArray(rawPlayers)
        ? (rawPlayers as Record<string, unknown>)
        : {};

    assert.doesNotThrow(() => {
      Object.keys(safePlayers);
    }, 'defensive guard must produce safe iterable object when players is a string');
    assert.deepEqual(Object.keys(safePlayers), [], 'fallback must be empty object');
  });
});

// ─── T2: Mode lifecycle (startup-frozen) ──────────────────────────────────

describe('T2 mode lifecycle (startup-frozen cache)', () => {
  it('cached mode ignores env change until reloadSchemaMode is called', () => {
    process.env.BOT_STATE_SCHEMA_MODE = 'enforce';
    reloadSchemaMode();
    assert.equal(getSchemaMode(), 'enforce');

    // Mutate env — must NOT take effect without explicit reload
    process.env.BOT_STATE_SCHEMA_MODE = 'off';
    assert.equal(getSchemaMode(), 'enforce', 'cached value must not change');

    // After reload, updated env is picked up
    reloadSchemaMode();
    assert.equal(getSchemaMode(), 'off', 'after reloadSchemaMode, new env must be used');
  });

  it('NODE_ENV=test with no explicit override defaults to enforce', () => {
    delete process.env.BOT_STATE_SCHEMA_MODE;
    // NODE_ENV is 'test' (set by .env.test + test/setup.ts)
    reloadSchemaMode();
    assert.equal(getSchemaMode(), 'enforce');
  });
});

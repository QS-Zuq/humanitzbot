/**
 * E2E regression tests for GitHubTracker._loadState() raw-return path cleanup.
 *
 * P2-1: When BotStateRepository.getStateJSONValidated() returns the **raw** parsed
 * value (mode=off bypasses normalizer entirely; mode=dry-run returns raw on issues),
 * _loadState must still apply the Reflect.deleteProperty cleanup loop so that
 * non-plain-object repo entries (string / array / number) are dropped before
 * _bootstrapRepo / _pollRepo can crash on them.
 *
 * These tests use a real BotStateRepository backed by :memory: SQLite so that
 * the actual getStateJSONValidated() code path (including mode branching) is
 * exercised — NOT a mock that always returns the normalizer's shape.
 *
 * All tests use node:test + node:assert/strict (no vitest).
 */

import { afterEach, before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { BotStateRepository } from '../src/db/repositories/bot-state-repository.js';
import { botStateEvents } from '../src/state/bot-state-events.js';
import { reloadSchemaMode } from '../src/state/bot-state-mode.js';

import * as _github_tracker from '../src/modules/github-tracker.js';

const GitHubTracker = (_github_tracker as unknown as { default: new (client: unknown, deps: object) => GhTrackerStub })
  .default;

// ── Minimal stub types ────────────────────────────────────────────────────────

interface RepoStateEntry {
  seenPrIds?: number[];
  closedPrIds?: number[];
  seenCommitShas?: string[];
  bootstrapped?: boolean;
  _bootstrapAttempts?: number;
}

interface GhTrackerStub {
  _state: Record<string, unknown>;
  _log: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
  _db: unknown;
  _loadState: () => Record<string, RepoStateEntry>;
  _saveState: () => void;
  _repoState: (repo: string) => RepoStateEntry;
}

// ── In-memory DB setup ────────────────────────────────────────────────────────

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

// ── Helpers ───────────────────────────────────────────────────────────────────

function setRaw(key: string, value: unknown): void {
  handle.prepare('INSERT OR REPLACE INTO bot_state (key, value) VALUES (?, ?)').run(key, JSON.stringify(value));
}

function makeTracker(): GhTrackerStub {
  const tracker = new GitHubTracker(null, { db: { botState: repo } });
  tracker._log = {
    info: (..._a: unknown[]) => {},
    warn: (..._a: unknown[]) => {},
    error: (..._a: unknown[]) => {},
  };
  return tracker;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GitHubTracker._loadState() raw-return path cleanup (P2-1 regression)', () => {
  describe('Test H: mode=off — raw bad entries are cleaned by Reflect.deleteProperty in _loadState', () => {
    it('drops string/array entries and preserves valid repo; DB bypasses normalizer in off mode', () => {
      process.env.BOT_STATE_SCHEMA_MODE = 'off';
      reloadSchemaMode();

      // Insert raw JSON with bad entries directly into DB — bypassing normalizer
      setRaw('github_tracker', {
        'tracked/repo': { seenPrIds: [1, 2], closedPrIds: [], seenCommitShas: [], bootstrapped: true },
        'bad/repo': 'corrupt',
        'arr/repo': [1, 2, 3],
      });

      const tracker = makeTracker();
      const state = tracker._loadState();

      // mode=off: getStateJSONValidated returns the raw parsed value (no normalizer),
      // so the Reflect.deleteProperty loop in _loadState is the ONLY cleanup path.
      assert.equal(state['bad/repo'], undefined, 'bad/repo (string) must be dropped in mode=off');
      assert.equal(state['arr/repo'], undefined, 'arr/repo (array) must be dropped in mode=off');
      assert.ok(state['tracked/repo'] !== undefined, 'tracked/repo must survive in mode=off');
      assert.deepEqual(state['tracked/repo'].seenPrIds, [1, 2], 'seenPrIds must be preserved');
    });
  });

  describe('Test I: mode=dry-run — raw bad entries are cleaned by Reflect.deleteProperty in _loadState', () => {
    it('drops string/array entries and preserves valid repo; dry-run returns raw on issues', () => {
      process.env.BOT_STATE_SCHEMA_MODE = 'dry-run';
      reloadSchemaMode();

      // Insert raw JSON with bad entries directly into DB
      setRaw('github_tracker', {
        'tracked/repo': { seenPrIds: [3, 4], closedPrIds: [], seenCommitShas: [], bootstrapped: true },
        'bad/repo': 'corrupt',
        'arr/repo': [1, 2, 3],
      });

      const tracker = makeTracker();
      const state = tracker._loadState();

      // mode=dry-run: getStateJSONValidated returns the **raw** parsed value when issues
      // are found (not the normalizer's partial-recovery shape), so the
      // Reflect.deleteProperty loop in _loadState must still remove the bad entries.
      assert.equal(state['bad/repo'], undefined, 'bad/repo (string) must be dropped in mode=dry-run');
      assert.equal(state['arr/repo'], undefined, 'arr/repo (array) must be dropped in mode=dry-run');
      assert.ok(state['tracked/repo'] !== undefined, 'tracked/repo must survive in mode=dry-run');
      assert.deepEqual(state['tracked/repo'].seenPrIds, [3, 4], 'seenPrIds must be preserved');
    });
  });

  describe('Test J: mode=off — mixed bad+good entries; _saveState persists only clean state', () => {
    it('save after cleanup does not re-introduce bad entries into DB', () => {
      process.env.BOT_STATE_SCHEMA_MODE = 'off';
      reloadSchemaMode();

      setRaw('github_tracker', {
        'tracked/repo': { seenPrIds: [5], closedPrIds: [], seenCommitShas: [], bootstrapped: true },
        'stale/bad': 'corrupt',
      });

      const tracker = makeTracker();
      const loaded = tracker._loadState();

      assert.equal(loaded['stale/bad'], undefined, 'stale/bad must not appear after _loadState');
      assert.ok(loaded['tracked/repo'] !== undefined, 'tracked/repo must survive');

      tracker._state = loaded as Record<string, unknown>;

      // Simulate a state update on the healthy repo
      const repoState = tracker._repoState('tracked/repo');
      repoState.seenPrIds = [5, 6];

      assert.doesNotThrow(() => {
        tracker._saveState();
      }, '_saveState must not throw after cleanup');

      // Verify DB: only tracked/repo present, stale/bad absent
      const row = handle.prepare('SELECT value FROM bot_state WHERE key = ?').get('github_tracker') as
        | { value: string }
        | undefined;
      assert.ok(row !== undefined, 'DB must have github_tracker row after save');
      const saved = JSON.parse(row.value) as Record<string, unknown>;
      assert.equal(saved['stale/bad'], undefined, 'stale/bad must not be in saved DB row');
      assert.ok(saved['tracked/repo'] !== undefined, 'tracked/repo must be in saved DB row');
      const trackedRepo = saved['tracked/repo'] as RepoStateEntry;
      assert.ok(
        Array.isArray(trackedRepo.seenPrIds) && trackedRepo.seenPrIds.includes(6),
        'seenPrIds must include updated value 6',
      );
    });
  });
});

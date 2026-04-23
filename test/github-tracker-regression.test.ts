/**
 * Regression tests for GitHubTracker bad repo-entry handling.
 *
 * P1-D: _loadState must DROP non-plain-object repo entries (string / number /
 * array) so that:
 *   1. _bootstrapRepo does not crash with "Cannot create property on string"
 *   2. _saveState is not blocked by normalizer throwing on a stale corrupt entry
 *
 * _repoState also has a defense-in-depth guard for entries mutated at runtime.
 *
 * All tests use node:test + node:assert/strict (no vitest).
 */

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeGithubTracker } from '../src/state/bot-state-schemas.js';

import * as _github_tracker from '../src/modules/github-tracker.js';
const GitHubTracker = (_github_tracker as unknown as { default: new (client: unknown, deps: object) => GhTrackerStub })
  .default;

// ─── Minimal stub types ───────────────────────────────────────────────────────

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
  _bootstrapRepo: (repo: string) => Promise<void>;
  _ghFetch: (path: string) => Promise<Response>;
  _polling: boolean;
}

// ─── Mock DB helper ───────────────────────────────────────────────────────────

function mockDb(initialGithubTrackerState: Record<string, unknown>) {
  const store = new Map<string, string>();
  store.set('github_tracker', JSON.stringify(initialGithubTrackerState));

  return {
    botState: {
      getStateJSON(key: string, def: unknown = null): unknown {
        const raw = store.get(key);
        if (raw == null) return def;
        try {
          return JSON.parse(raw) as unknown;
        } catch {
          return def;
        }
      },
      setStateJSON(key: string, value: unknown): void {
        store.set(key, JSON.stringify(value));
      },
      getStateJSONValidated(
        key: string,
        normalize: (raw: unknown) => { shape: unknown; issues: string[] },
        def: unknown,
      ): unknown {
        const raw = store.get(key);
        if (raw == null) return def;
        try {
          const parsed = JSON.parse(raw) as unknown;
          const { shape } = normalize(parsed);
          return shape;
        } catch {
          return def;
        }
      },
      setStateJSONValidated(
        key: string,
        normalize: (raw: unknown) => { shape: unknown; issues: string[] },
        value: unknown,
      ): void {
        const { issues } = normalize(value);
        if (issues.length > 0) {
          throw new Error(`bot_state.${key} failed validation: ${issues.join('; ')}`);
        }
        store.set(key, JSON.stringify(value));
      },
    },
    _store: store,
    getStateJSON(key: string): unknown {
      const raw = store.get(key);
      if (raw == null) return null;
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        return null;
      }
    },
  };
}

function makeTracker(db: ReturnType<typeof mockDb>): GhTrackerStub {
  const tracker = new GitHubTracker(null, { db });
  // Suppress log output in tests
  tracker._log = {
    info: (..._a: unknown[]) => {},
    warn: (..._a: unknown[]) => {},
    error: (..._a: unknown[]) => {},
  };
  return tracker;
}

// ─── afterEach cleanup ────────────────────────────────────────────────────────

afterEach(() => {
  // No global state to clean up for these tests
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('GitHubTracker P1-D regression: bad repo-level entry handling', () => {
  describe('Test A: tracked repo with primitive string value does not crash', () => {
    it('_loadState drops string entry; _repoState returns plain object; _bootstrapAttempts settable', () => {
      const db = mockDb({ 'owner/repo': 'bad' });
      const tracker = makeTracker(db);

      // load clears the bad entry
      const state = tracker._loadState();
      assert.equal(state['owner/repo'], undefined, '_loadState must drop string entry "bad"');

      // After load, set _state to the loaded result (simulating start())
      tracker._state = state as Record<string, unknown>;

      // _repoState must return a plain object (not crash)
      const repoState = tracker._repoState('owner/repo');
      assert.ok(typeof repoState === 'object' && !Array.isArray(repoState), 'repoState must be a plain object');

      // Setting _bootstrapAttempts must not throw TypeError
      assert.doesNotThrow(() => {
        repoState._bootstrapAttempts = 1;
      }, 'Cannot create property on string must not occur');

      assert.equal(repoState._bootstrapAttempts, 1);
    });
  });

  describe('Test B: stale untracked repo with corrupt entry does not block save of healthy tracked repo', () => {
    it('_saveState succeeds and DB has latest tracked/repo state after stale bad entry is cleaned', () => {
      const db = mockDb({
        'tracked/repo': { seenPrIds: [1], closedPrIds: [], seenCommitShas: [], bootstrapped: true },
        'stale/bad': 'corrupt',
      });
      const tracker = makeTracker(db);

      // Load state — stale/bad must be dropped
      const loaded = tracker._loadState();
      assert.equal(loaded['stale/bad'], undefined, 'stale/bad must be dropped by _loadState');
      assert.ok(
        typeof loaded['tracked/repo'] === 'object' && !Array.isArray(loaded['tracked/repo']),
        'tracked/repo must survive _loadState',
      );

      tracker._state = loaded as Record<string, unknown>;

      // Simulate a poll update on the tracked repo
      const repoState = tracker._repoState('tracked/repo');
      repoState.seenPrIds = [1, 2];

      // _saveState must not throw
      assert.doesNotThrow(() => {
        tracker._saveState();
      }, '_saveState must not throw when stale corrupt entry is absent');

      // DB must have updated tracked/repo state
      const saved = db.getStateJSON('github_tracker') as Record<string, Record<string, unknown>> | null;
      assert.ok(saved !== null, 'DB must have github_tracker row after save');
      const trackedRepo = saved['tracked/repo'];
      assert.ok(
        Array.isArray(trackedRepo?.seenPrIds) && (trackedRepo.seenPrIds as number[]).includes(2),
        'DB must have updated seenPrIds for tracked/repo',
      );
      assert.equal(saved['stale/bad'], undefined, 'stale/bad must not appear in saved state');
    });
  });

  describe('Test C: array repo entry is dropped by _loadState', () => {
    it('_loadState removes array-valued repo entry', () => {
      const db = mockDb({ 'arr/repo': [1, 2, 3] });
      const tracker = makeTracker(db);

      const state = tracker._loadState();
      assert.equal(state['arr/repo'], undefined, '_loadState must drop array entry [1,2,3]');
    });
  });

  describe('Test D: number repo entry is dropped by _loadState', () => {
    it('_loadState removes number-valued repo entry', () => {
      const db = mockDb({ 'num/repo': 42 });
      const tracker = makeTracker(db);

      const state = tracker._loadState();
      assert.equal(state['num/repo'], undefined, '_loadState must drop number entry 42');
    });
  });

  describe('Test E: _repoState defense-in-depth replaces runtime-mutated primitive', () => {
    it('does not throw when _state[repo] is a string at runtime', () => {
      const db = mockDb({});
      const tracker = makeTracker(db);
      tracker._state = {};
      // Simulate entry mutated to a primitive after load
      tracker._state['live/repo'] = 'mutated';

      const repoState = tracker._repoState('live/repo');
      assert.ok(
        typeof repoState === 'object' && !Array.isArray(repoState),
        'repoState must be a plain object after runtime defense',
      );

      assert.doesNotThrow(() => {
        repoState._bootstrapAttempts = 1;
      }, 'property assignment must not throw after _repoState defense-in-depth');

      assert.equal(repoState._bootstrapAttempts, 1);
    });
  });

  describe('Test F: healthy repo entries survive alongside dropped bad entries', () => {
    it('good entries preserved while multiple bad entries (string/array/number) are dropped', () => {
      const db = mockDb({
        'good/repo1': { seenPrIds: [10, 20], bootstrapped: true },
        'bad/string': 'broken',
        'good/repo2': { seenCommitShas: ['abc'], bootstrapped: true },
        'bad/array': [1, 2],
        'bad/number': 99,
      });
      const tracker = makeTracker(db);

      const state = tracker._loadState();

      assert.ok(state['good/repo1'] !== undefined, 'good/repo1 must survive');
      assert.ok(state['good/repo2'] !== undefined, 'good/repo2 must survive');
      assert.equal(state['bad/string'], undefined, 'bad/string must be dropped');
      assert.equal(state['bad/array'], undefined, 'bad/array must be dropped');
      assert.equal(state['bad/number'], undefined, 'bad/number must be dropped');

      assert.deepEqual(state['good/repo1'].seenPrIds, [10, 20], 'good/repo1 seenPrIds must be preserved');
    });
  });

  describe('Test G: normalizeGithubTracker reference check (schema used by mockDb)', () => {
    it('normalizeGithubTracker skips non-object repo entries and returns issues', () => {
      const { shape, issues } = normalizeGithubTracker({ 'x/y': 'bad', 'a/b': { seenPrIds: [1] } });
      assert.equal(shape['x/y'], undefined, 'bad entry must be skipped by normalizer');
      assert.ok(shape['a/b'] !== undefined, 'good entry must survive normalizer');
      assert.ok(
        issues.some((i) => i.includes('[x/y]')),
        'normalizer must record issue for x/y',
      );
    });
  });
});

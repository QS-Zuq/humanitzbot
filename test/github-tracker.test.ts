'use strict';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';

import * as _github_tracker from '../src/modules/github-tracker.js';
const GitHubTracker = (_github_tracker as any).default;

// ── Minimal mocks ────────────────────────────────────────────────────────────

function mockDb(initialState: Record<string, any> = {}) {
  const store = new Map<string, string>();
  if (Object.keys(initialState).length > 0) {
    store.set('github_tracker', JSON.stringify(initialState));
  }
  const stateAccessors = {
    getStateJSON(key: string, def: any = null) {
      const raw = store.get(key);
      if (raw == null) return def;
      try {
        return JSON.parse(raw);
      } catch {
        return def;
      }
    },
    setStateJSON(key: string, value: any) {
      store.set(key, JSON.stringify(value));
    },
    // Stage 2: validated variants — delegate to normalize + getStateJSON for tests
    getStateJSONValidated(key: string, normalize: (raw: unknown) => { shape: any; issues: string[] }, def: any) {
      const raw = store.get(key);
      if (raw == null) return def;
      try {
        const parsed = JSON.parse(raw);
        const { shape } = normalize(parsed);
        return shape;
      } catch {
        return def;
      }
    },
    setStateJSONValidated(key: string, normalize: (raw: unknown) => { shape: any; issues: string[] }, value: any) {
      const { issues } = normalize(value);
      if (issues.length > 0) {
        throw new Error('bot_state.' + key + ' failed validation: ' + issues.join('; '));
      }
      store.set(key, JSON.stringify(value));
    },
  };
  return {
    botState: stateAccessors,
    _store: store,
  };
}

function mockConfig(overrides: Record<string, any> = {}) {
  return {
    githubToken: '',
    githubRepos: ['owner/repo'],
    githubChannelId: '111',
    githubPollInterval: 60_000,
    botLocale: 'en',
    ...overrides,
  };
}

function mockThread(name = 'gh: owner/repo') {
  const sent: any[] = [];
  return {
    name,
    archived: false,
    send: async (payload: any) => {
      sent.push(payload);
      return payload;
    },
    setArchived: async () => {},
    _sent: sent,
  };
}

function mockChannel(threads: ReturnType<typeof mockThread>[] = []) {
  const sent: any[] = [];
  return {
    id: '111',
    name: 'github-updates',
    threads: {
      fetchActive: async () => ({ threads: new Map(threads.map((t) => [t.name, t])) }),
      fetchArchived: async () => ({ threads: new Map() }),
    },
    send: async (payload: any) => {
      const msg = { ...payload, startThread: async (opts: any) => mockThread(opts.name), _payload: payload };
      sent.push(msg);
      return msg;
    },
    _sent: sent,
  };
}

function mockClient(channel: ReturnType<typeof mockChannel>) {
  return {
    channels: {
      fetch: async () => channel,
    },
  };
}

// ── Fake GitHub API response builders ────────────────────────────────────────

function makePr(overrides: Record<string, any> = {}) {
  return {
    number: 1,
    title: 'Test PR',
    state: 'open',
    html_url: 'https://github.com/owner/repo/pull/1',
    body: 'PR body',
    updated_at: new Date().toISOString(),
    user: { login: 'alice', avatar_url: '' },
    head: { ref: 'feature/test' },
    labels: [],
    ...overrides,
  };
}

function makeCommit(overrides: Record<string, any> = {}) {
  return {
    sha: 'abc1234def',
    html_url: 'https://github.com/owner/repo/commit/abc1234def',
    commit: {
      message: 'fix: something\n\nmore details',
      author: { name: 'bob', date: new Date().toISOString() },
    },
    author: { login: 'bob', avatar_url: '' },
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GitHubTracker', () => {
  describe('_repoState', () => {
    it('creates empty state for an unseen repo', () => {
      const tracker = new GitHubTracker(mockClient(mockChannel()), { config: mockConfig(), db: mockDb() });
      const state = tracker._repoState('owner/repo');
      assert.deepEqual(state, {});
    });

    it('returns the same object on repeated calls', () => {
      const tracker = new GitHubTracker(mockClient(mockChannel()), { config: mockConfig(), db: mockDb() });
      const a = tracker._repoState('owner/repo');
      const b = tracker._repoState('owner/repo');
      assert.equal(a, b);
    });
  });

  describe('_threadName', () => {
    it('prepends "gh: " to the repo slug', () => {
      const tracker = new GitHubTracker(mockClient(mockChannel()), { config: mockConfig() });
      assert.equal(tracker._threadName('owner/repo'), 'gh: owner/repo');
    });

    it('truncates very long repo names to 100 chars', () => {
      const tracker = new GitHubTracker(mockClient(mockChannel()), { config: mockConfig() });
      const long = 'a'.repeat(120);
      assert.equal(tracker._threadName(long).length, 100);
    });
  });

  describe('_loadState / _saveState', () => {
    it('returns empty object when DB has no state', () => {
      const tracker = new GitHubTracker(mockClient(mockChannel()), { config: mockConfig(), db: mockDb() });
      tracker._state = tracker._loadState();
      assert.deepEqual(tracker._state, {});
    });

    it('loads existing state from DB', () => {
      const initial = { 'owner/repo': { bootstrapped: true, seenPrIds: [1, 2] } };
      const tracker = new GitHubTracker(mockClient(mockChannel()), { config: mockConfig(), db: mockDb(initial) });
      tracker._state = tracker._loadState();
      assert.deepEqual(tracker._state['owner/repo'].seenPrIds, [1, 2]);
    });

    it('persists state to DB', () => {
      const db = mockDb();
      const tracker = new GitHubTracker(mockClient(mockChannel()), { config: mockConfig(), db });
      tracker._state = { 'owner/repo': { seenPrIds: [42] } };
      tracker._saveState();
      const saved = db.botState.getStateJSON('github_tracker', null);
      assert.deepEqual(saved['owner/repo'].seenPrIds, [42]);
    });

    it('does not throw when DB is absent', () => {
      const tracker = new GitHubTracker(mockClient(mockChannel()), { config: mockConfig(), db: null });
      assert.doesNotThrow(() => tracker._saveState());
      assert.deepEqual(tracker._loadState(), {});
    });
  });

  describe('_buildPrEmbed', () => {
    it('builds an embed for an open PR with green colour', () => {
      const tracker = new GitHubTracker(mockClient(mockChannel()), { config: mockConfig() });
      const embed = tracker._buildPrEmbed('owner/repo', makePr());
      assert.equal(embed.data.color, 0x238636);
      assert.ok(embed.data.title.includes('#1'));
      assert.ok(embed.data.title.includes('Test PR'));
    });

    it('uses purple colour for merged PRs', () => {
      const tracker = new GitHubTracker(mockClient(mockChannel()), { config: mockConfig() });
      const pr = makePr({ state: 'closed', merged_at: new Date().toISOString() });
      const embed = tracker._buildPrEmbed('owner/repo', pr);
      assert.equal(embed.data.color, 0x8957e5);
    });

    it('uses red colour for closed (non-merged) PRs', () => {
      const tracker = new GitHubTracker(mockClient(mockChannel()), { config: mockConfig() });
      const pr = makePr({ state: 'closed' });
      const embed = tracker._buildPrEmbed('owner/repo', pr);
      assert.equal(embed.data.color, 0xe74c3c);
    });

    it('truncates long PR bodies', () => {
      const tracker = new GitHubTracker(mockClient(mockChannel()), { config: mockConfig() });
      const pr = makePr({ body: 'x'.repeat(500) });
      const embed = tracker._buildPrEmbed('owner/repo', pr);
      assert.ok(embed.data.description.length <= 304); // 300 + '…'
    });
  });

  describe('_buildCommitEmbed', () => {
    it('builds an embed with short SHA in title', () => {
      const tracker = new GitHubTracker(mockClient(mockChannel()), { config: mockConfig() });
      const embed = tracker._buildCommitEmbed('owner/repo', makeCommit());
      assert.ok(embed.data.title.includes('abc1234'));
    });

    it('uses only the first line of the commit message as title', () => {
      const tracker = new GitHubTracker(mockClient(mockChannel()), { config: mockConfig() });
      const embed = tracker._buildCommitEmbed('owner/repo', makeCommit());
      assert.ok(!embed.data.title.includes('more details'));
    });

    it('puts the remaining commit message lines into description', () => {
      const tracker = new GitHubTracker(mockClient(mockChannel()), { config: mockConfig() });
      const embed = tracker._buildCommitEmbed('owner/repo', makeCommit());
      assert.equal(embed.data.description, 'more details');
    });
  });

  describe('_pollPRs', () => {
    it('skips PRs that are already in seenPrIds', async () => {
      const thread = mockThread();
      const channel = mockChannel([thread]);
      const db = mockDb({ 'owner/repo': { bootstrapped: true, seenPrIds: [1], closedPrIds: [] } });
      const tracker = new GitHubTracker(mockClient(channel), { config: mockConfig(), db });
      tracker._state = tracker._loadState();
      tracker._threads.set('owner/repo', thread);

      // Simulate GitHub returning PR #1 (already seen)
      tracker._ghFetch = async () => ({
        ok: true,
        json: async () => [makePr({ number: 1 })],
      });

      await tracker._pollPRs('owner/repo');
      assert.equal(thread._sent.length, 0);
    });

    it('posts new PRs that are not in seenPrIds', async () => {
      const thread = mockThread();
      const channel = mockChannel([thread]);
      const db = mockDb({ 'owner/repo': { bootstrapped: true, seenPrIds: [], closedPrIds: [] } });
      const tracker = new GitHubTracker(mockClient(channel), { config: mockConfig(), db });
      tracker._state = tracker._loadState();
      tracker._threads.set('owner/repo', thread);

      tracker._ghFetch = async () => ({
        ok: true,
        json: async () => [makePr({ number: 2 })],
      });

      await tracker._pollPRs('owner/repo');
      assert.equal(thread._sent.length, 1);

      const state = tracker._repoState('owner/repo');
      assert.ok(state.seenPrIds.includes(2));
    });

    it('posts close events for newly-closed PRs', async () => {
      const thread = mockThread();
      const channel = mockChannel([thread]);
      const db = mockDb({ 'owner/repo': { bootstrapped: true, seenPrIds: [5], closedPrIds: [] } });
      const tracker = new GitHubTracker(mockClient(channel), { config: mockConfig(), db });
      tracker._state = tracker._loadState();
      tracker._threads.set('owner/repo', thread);

      tracker._ghFetch = async () => ({
        ok: true,
        json: async () => [makePr({ number: 5, state: 'closed' })],
      });

      await tracker._pollPRs('owner/repo');
      assert.equal(thread._sent.length, 1, 'Should post close event');

      const state = tracker._repoState('owner/repo');
      assert.ok(state.closedPrIds.includes(5));
    });
  });

  describe('_pollPushes', () => {
    it('skips commits that are already in seenCommitShas', async () => {
      const thread = mockThread();
      const channel = mockChannel([thread]);
      const db = mockDb({ 'owner/repo': { bootstrapped: true, seenCommitShas: ['abc1234def'] } });
      const tracker = new GitHubTracker(mockClient(channel), { config: mockConfig(), db });
      tracker._state = tracker._loadState();
      tracker._threads.set('owner/repo', thread);

      tracker._ghFetch = async () => ({
        ok: true,
        json: async () => [makeCommit({ sha: 'abc1234def' })],
      });

      await tracker._pollPushes('owner/repo');
      assert.equal(thread._sent.length, 0);
    });

    it('posts new commits and records their SHAs', async () => {
      const thread = mockThread();
      const channel = mockChannel([thread]);
      const db = mockDb({ 'owner/repo': { bootstrapped: true, seenCommitShas: [] } });
      const tracker = new GitHubTracker(mockClient(channel), { config: mockConfig(), db });
      tracker._state = tracker._loadState();
      tracker._threads.set('owner/repo', thread);

      tracker._ghFetch = async () => ({
        ok: true,
        json: async () => [makeCommit({ sha: 'newsha0001' })],
      });

      await tracker._pollPushes('owner/repo');
      assert.equal(thread._sent.length, 1);

      const state = tracker._repoState('owner/repo');
      assert.ok(state.seenCommitShas.includes('newsha0001'));
    });

    it('caps seenCommitShas at 200 entries (Stage 3 trim)', async () => {
      const thread = mockThread();
      const channel = mockChannel([thread]);
      const existingShas = Array.from({ length: 210 }, (_, i) => `sha${String(i).padStart(6, '0')}`);
      const db = mockDb({ 'owner/repo': { bootstrapped: true, seenCommitShas: existingShas } });
      const tracker = new GitHubTracker(mockClient(channel), { config: mockConfig(), db });
      tracker._state = tracker._loadState();
      tracker._threads.set('owner/repo', thread);

      tracker._ghFetch = async () => ({
        ok: true,
        json: async () => [makeCommit({ sha: 'brandnewsha' })],
      });

      await tracker._pollPushes('owner/repo');
      const state = tracker._repoState('owner/repo');
      assert.ok(
        state.seenCommitShas.length <= 200,
        `seenCommitShas must not exceed 200, got ${state.seenCommitShas.length}`,
      );
    });
  });

  describe('_pollPRs trim 200 (Stage 3)', () => {
    it('trims seenPrIds to the latest 200 PR numbers after saturation', async () => {
      const thread = mockThread();
      const channel = mockChannel([thread]);
      // Start with 250 already-seen PR IDs
      const existingIds = Array.from({ length: 250 }, (_, i) => i + 1);
      const db = mockDb({ 'owner/repo': { bootstrapped: true, seenPrIds: existingIds, closedPrIds: [] } });
      const tracker = new GitHubTracker(mockClient(channel), { config: mockConfig(), db });
      tracker._state = tracker._loadState();
      tracker._threads.set('owner/repo', thread);

      // GitHub returns 25 new PRs (IDs 251-275)
      const newPrs = Array.from({ length: 25 }, (_, i) => makePr({ number: 251 + i }));
      tracker._ghFetch = async () => ({
        ok: true,
        json: async () => newPrs,
      });

      await tracker._pollPRs('owner/repo');
      const state = tracker._repoState('owner/repo');
      assert.equal(state.seenPrIds.length, 200, `seenPrIds must contain exactly 200 IDs after saturation`);
      assert.equal(Math.min(...state.seenPrIds), 76, 'seenPrIds must keep the latest 200 IDs');
      assert.equal(Math.max(...state.seenPrIds), 275, 'seenPrIds must include the newest PR ID');
    });

    it('trims closedPrIds to the latest 200 closed PR numbers after saturation', async () => {
      const thread = mockThread();
      const channel = mockChannel([thread]);
      const seenIds = Array.from({ length: 275 }, (_, i) => i + 1);
      const closedIds = Array.from({ length: 250 }, (_, i) => i + 1);
      const db = mockDb({ 'owner/repo': { bootstrapped: true, seenPrIds: seenIds, closedPrIds: closedIds } });
      const tracker = new GitHubTracker(mockClient(channel), { config: mockConfig(), db });
      tracker._state = tracker._loadState();
      tracker._threads.set('owner/repo', thread);

      const newlyClosed = Array.from({ length: 25 }, (_, i) => makePr({ number: 251 + i, state: 'closed' }));
      tracker._ghFetch = async () => ({
        ok: true,
        json: async () => newlyClosed,
      });

      await tracker._pollPRs('owner/repo');
      const state = tracker._repoState('owner/repo');
      assert.equal(state.closedPrIds.length, 200, 'closedPrIds must contain exactly 200 IDs after saturation');
      assert.equal(Math.min(...state.closedPrIds), 76, 'closedPrIds must keep the latest 200 IDs');
      assert.equal(Math.max(...state.closedPrIds), 275, 'closedPrIds must include the newest closed PR ID');
    });

    it('deduplicates repeated PR IDs before trimming seenPrIds', async () => {
      const thread = mockThread();
      const channel = mockChannel([thread]);
      const repeatedIds = [...Array.from({ length: 210 }, (_, i) => i + 1), 199, 200, 210];
      const db = mockDb({ 'owner/repo': { bootstrapped: true, seenPrIds: repeatedIds, closedPrIds: [] } });
      const tracker = new GitHubTracker(mockClient(channel), { config: mockConfig(), db });
      tracker._state = tracker._loadState();
      tracker._threads.set('owner/repo', thread);

      tracker._ghFetch = async () => ({
        ok: true,
        json: async () => Array.from({ length: 15 }, (_, i) => makePr({ number: 211 + i })),
      });

      await tracker._pollPRs('owner/repo');
      const state = tracker._repoState('owner/repo');
      assert.equal(new Set(state.seenPrIds).size, state.seenPrIds.length, 'seenPrIds must be unique after trim');
      assert.equal(state.seenPrIds.length, 200, 'seenPrIds must stay capped at 200 after dedup');
      assert.equal(Math.max(...state.seenPrIds), 225, 'seenPrIds must include the newest deduped PR ID');
    });

    it('single _pollRepo cycle calls _saveState exactly once (Stage 3 race fix)', async () => {
      const thread = mockThread();
      const channel = mockChannel([thread]);
      const db = mockDb({ 'owner/repo': { bootstrapped: true, seenPrIds: [], closedPrIds: [], seenCommitShas: [] } });
      const tracker = new GitHubTracker(mockClient(channel), { config: mockConfig(), db });
      tracker._state = tracker._loadState();
      tracker._threads.set('owner/repo', thread);
      tracker._channel = channel as any;

      // Count _saveState calls
      let saveCount = 0;
      const origSave = tracker._saveState.bind(tracker);
      tracker._saveState = () => {
        saveCount++;
        origSave();
      };

      tracker._ghFetch = async (path: string) => {
        if (path.includes('/pulls')) {
          return { ok: true, json: async () => [] } as any;
        }
        return { ok: true, json: async () => [] } as any;
      };

      await tracker._pollRepo('owner/repo');
      assert.equal(saveCount, 1, `_pollRepo post-bootstrap must call _saveState exactly once, got ${saveCount}`);
    });

    it('keeps _pollPRs and _pollPushes concurrent while converging to one save', async () => {
      const db = mockDb({ 'owner/repo': { bootstrapped: true, seenPrIds: [], closedPrIds: [], seenCommitShas: [] } });
      const tracker = new GitHubTracker(mockClient(mockChannel()), { config: mockConfig(), db });
      tracker._state = tracker._loadState();

      let saveCount = 0;
      tracker._saveState = () => {
        saveCount++;
      };
      tracker._pollPRs = async () => {
        await sleep(100);
      };
      tracker._pollPushes = async () => {
        await sleep(100);
      };

      const started = Date.now();
      await tracker._pollRepo('owner/repo');
      const elapsed = Date.now() - started;

      assert.equal(saveCount, 1, 'concurrent post-bootstrap poll must still save exactly once');
      assert.ok(elapsed < 180, `_pollRepo should run PR/push polls concurrently, elapsed=${String(elapsed)}ms`);
    });
  });

  describe('P1-2: _pollRepo Promise.allSettled — partial progress persisted on single-side throw', () => {
    it('seenCommitShas is saved even when _pollPRs throws', async () => {
      const thread = mockThread();
      const channel = mockChannel([thread]);
      const db = mockDb({ 'owner/repo': { bootstrapped: true, seenPrIds: [], closedPrIds: [], seenCommitShas: [] } });
      const tracker = new GitHubTracker(mockClient(channel), { config: mockConfig(), db });
      tracker._state = tracker._loadState();
      tracker._threads.set('owner/repo', thread);
      tracker._channel = channel as any;

      // _pollPRs always throws; _pollPushes succeeds and adds a new SHA
      tracker._pollPRs = async () => {
        throw new Error('simulated PR poll failure');
      };
      tracker._pollPushes = async (repo: string) => {
        const repoState = tracker._repoState(repo);
        repoState.seenCommitShas = [
          ...(Array.isArray(repoState.seenCommitShas) ? repoState.seenCommitShas : []),
          'new-sha-001',
        ];
      };

      // _pollRepo should throw (re-propagates the PR failure) but still call _saveState
      let saveCount = 0;
      const origSave = tracker._saveState.bind(tracker);
      tracker._saveState = () => {
        saveCount++;
        origSave();
      };

      await assert.rejects(
        () => tracker._pollRepo('owner/repo'),
        /simulated PR poll failure/,
        '_pollRepo must rethrow the failure from _pollPRs',
      );

      assert.equal(saveCount, 1, '_saveState must be called exactly once even when _pollPRs throws');

      // seenCommitShas from _pollPushes must have been persisted
      const saved = db.botState.getStateJSON('github_tracker', {});
      assert.ok(
        Array.isArray(saved?.['owner/repo']?.seenCommitShas) &&
          saved['owner/repo'].seenCommitShas.includes('new-sha-001'),
        'seenCommitShas from _pollPushes must be persisted even when _pollPRs threw',
      );
    });
  });

  describe('stop', () => {
    it('clears the poll timer', () => {
      const tracker = new GitHubTracker(mockClient(mockChannel()), { config: mockConfig() });
      tracker._pollTimer = setInterval(() => {}, 99999);
      tracker.stop();
      assert.equal(tracker._pollTimer, null);
    });
  });

  describe('P1-A: _pollPRs closedPrIds corrupt-shape guard', () => {
    it('does not throw TypeError when closedPrIds is {} (object not array)', async () => {
      const thread = mockThread();
      const channel = mockChannel([thread]);
      const db = mockDb({ 'owner/repo': { bootstrapped: true, seenPrIds: [10], closedPrIds: {} } });
      const tracker = new GitHubTracker(mockClient(channel), { config: mockConfig(), db });
      tracker._state = tracker._loadState();
      // Force closedPrIds to a plain object to simulate corruption
      (tracker._state['owner/repo'] as Record<string, unknown>).closedPrIds = {};
      tracker._threads.set('owner/repo', thread);

      tracker._ghFetch = async () => ({
        ok: true,
        json: async () => [makePr({ number: 10, state: 'closed' })],
      });

      await assert.doesNotReject(
        () => tracker._pollPRs('owner/repo'),
        'must not throw TypeError when closedPrIds is a plain object',
      );
    });

    it('does not throw TypeError when closedPrIds is a string (corrupt)', async () => {
      const thread = mockThread();
      const channel = mockChannel([thread]);
      const db = mockDb({ 'owner/repo': { bootstrapped: true, seenPrIds: [11], closedPrIds: [] } });
      const tracker = new GitHubTracker(mockClient(channel), { config: mockConfig(), db });
      tracker._state = tracker._loadState();
      // Force closedPrIds to a string to simulate corruption
      (tracker._state['owner/repo'] as Record<string, unknown>).closedPrIds = 'corrupt';
      tracker._threads.set('owner/repo', thread);

      tracker._ghFetch = async () => ({
        ok: true,
        json: async () => [makePr({ number: 11, state: 'closed' })],
      });

      await assert.doesNotReject(
        () => tracker._pollPRs('owner/repo'),
        'must not throw TypeError when closedPrIds is a string',
      );
    });
  });
});

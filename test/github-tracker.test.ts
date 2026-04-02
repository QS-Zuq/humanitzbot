/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any, @typescript-eslint/no-require-imports, @typescript-eslint/no-floating-promises, @typescript-eslint/require-await */
'use strict';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const GitHubTracker = require('../src/modules/github-tracker');

// ── Minimal mocks ────────────────────────────────────────────────────────────

function mockDb(initialState: Record<string, any> = {}) {
  const store = new Map<string, string>();
  if (Object.keys(initialState).length > 0) {
    store.set('github_tracker', JSON.stringify(initialState));
  }
  return {
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
      const saved = db.getStateJSON('github_tracker', null);
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

    it('caps seenCommitShas at 100 entries', async () => {
      const thread = mockThread();
      const channel = mockChannel([thread]);
      const existingShas = Array.from({ length: 99 }, (_, i) => `sha${String(i).padStart(6, '0')}`);
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
      assert.ok(state.seenCommitShas.length <= 100);
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
});

/**
 * Regression: github-tracker bootstrap used to mark repos as bootstrapped even
 * when GitHub fetches failed, which caused Discord re-announcement spam once
 * the fetch recovered. PR1 switches to a strict policy: bootstrapped only when
 * both PR and commit fetches succeed. _pollRepo gates on bootstrapped so normal
 * polling never runs with partial seed state. Warnings throttle after 5 failures
 * to avoid log spam, but bootstrap retry continues until it eventually succeeds.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import GitHubTrackerModule from '../src/modules/github-tracker.js';

const GitHubTracker = GitHubTrackerModule as unknown as new (client: unknown, deps: object) => GhTrackerStub;

interface GhTrackerStub {
  _ghFetch: (path: string) => Promise<Response>;
  _log: {
    label: string;
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
  _state: Record<
    string,
    {
      seenPrIds?: number[];
      closedPrIds?: number[];
      seenCommitShas?: string[];
      bootstrapped?: boolean;
      _bootstrapAttempts?: number;
    }
  >;
  _bootstrapRepo: (repo: string) => Promise<void>;
  _pollRepo: (repo: string) => Promise<void>;
  _pollPRs: (repo: string) => Promise<void>;
  _pollPushes: (repo: string) => Promise<void>;
  _repoState: (repo: string) => {
    seenPrIds?: number[];
    closedPrIds?: number[];
    seenCommitShas?: string[];
    bootstrapped?: boolean;
    _bootstrapAttempts?: number;
  };
}

type FetchImpl = (path: string) => Promise<Response>;

function makeTracker(fetchImpl: FetchImpl): GhTrackerStub {
  const tracker = new GitHubTracker(null, {});
  tracker._ghFetch = fetchImpl;
  const warnings: string[] = [];
  tracker._log = {
    label: 'TEST',
    info: (..._a: unknown[]) => {
      /* noop */
    },
    warn: (...a: unknown[]) => {
      warnings.push(a.map(String).join(' '));
    },
    error: (..._a: unknown[]) => {
      /* noop */
    },
  };
  tracker._state = {};
  // Attach warnings buffer for tests that want to assert log throttling.
  (tracker as unknown as { _warnings: string[] })._warnings = warnings;
  return tracker;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('github-tracker bootstrap failure handling', () => {
  it('does NOT mark bootstrapped when PR fetch rejects', async () => {
    const tracker = makeTracker(() => Promise.reject(new Error('network down')));
    await tracker._bootstrapRepo('foo/bar');
    const state = tracker._repoState('foo/bar');
    assert.equal(state.bootstrapped, undefined);
    assert.equal(state._bootstrapAttempts, 1);
  });

  it('does NOT mark bootstrapped when PR fetch returns non-ok', async () => {
    const tracker = makeTracker(() => Promise.resolve(jsonResponse({ message: 'not found' }, 404)));
    await tracker._bootstrapRepo('foo/bar');
    const state = tracker._repoState('foo/bar');
    assert.equal(state.bootstrapped, undefined);
    assert.equal(state._bootstrapAttempts, 1);
  });

  it('does NOT mark bootstrapped when commit fetch fails but PR succeeds', async () => {
    let call = 0;
    const tracker = makeTracker(() => {
      call += 1;
      if (call === 1) return Promise.resolve(jsonResponse([{ number: 1, state: 'open' }]));
      return Promise.reject(new Error('commit api down'));
    });
    await tracker._bootstrapRepo('foo/bar');
    const state = tracker._repoState('foo/bar');
    assert.equal(state.bootstrapped, undefined);
    assert.equal(state._bootstrapAttempts, 1);
    // PR state was still seeded (best-effort for when bootstrap finally completes)
    assert.deepEqual(state.seenPrIds, [1]);
  });

  it('increments _bootstrapAttempts across repeated failures', async () => {
    const tracker = makeTracker(() => Promise.reject(new Error('network')));
    await tracker._bootstrapRepo('foo/bar');
    await tracker._bootstrapRepo('foo/bar');
    await tracker._bootstrapRepo('foo/bar');
    const state = tracker._repoState('foo/bar');
    assert.equal(state.bootstrapped, undefined);
    assert.equal(state._bootstrapAttempts, 3);
  });

  it('does NOT force bootstrapped=true after 5 failed attempts (prevents spam on recovery)', async () => {
    const tracker = makeTracker(() => Promise.reject(new Error('network')));
    for (let i = 0; i < 8; i++) {
      await tracker._bootstrapRepo('foo/bar');
    }
    const state = tracker._repoState('foo/bar');
    assert.equal(state.bootstrapped, undefined);
    assert.equal(state._bootstrapAttempts, 8);
  });

  it('throttles warning logs after 5 failed attempts', async () => {
    const tracker = makeTracker(() => Promise.reject(new Error('network')));
    const warnings = (tracker as unknown as { _warnings: string[] })._warnings;

    // Attempts 1-5: each produces 2 fetch-failure warnings (pr + commit) = 10.
    // Attempt 5 also emits the one-time "further warnings silenced" notice.
    for (let i = 0; i < 5; i++) {
      await tracker._bootstrapRepo('foo/bar');
    }
    const snapshotAfter5 = warnings.length;
    assert.equal(snapshotAfter5, 11, `after 5 attempts expected 11 warnings, got ${String(snapshotAfter5)}`);
    const silencedNotices = warnings.filter((w) => /silenced/.test(w));
    assert.equal(silencedNotices.length, 1);

    // Attempts 6-10: bootstrap still fails, but warnings are silenced.
    for (let i = 0; i < 5; i++) {
      await tracker._bootstrapRepo('foo/bar');
    }
    assert.equal(warnings.length, snapshotAfter5, 'attempts 6-10 must not add new warnings');
  });

  it('does NOT mark bootstrapped when GitHub returns non-array JSON body', async () => {
    const tracker = makeTracker(() =>
      Promise.resolve(jsonResponse({ message: 'rate limit', documentation_url: 'https://...' })),
    );
    await tracker._bootstrapRepo('foo/bar');
    const state = tracker._repoState('foo/bar');
    assert.equal(state.bootstrapped, undefined);
    assert.equal(state._bootstrapAttempts, 1);
  });

  it('marks bootstrapped when both fetches succeed', async () => {
    let call = 0;
    const tracker = makeTracker(() => {
      call += 1;
      if (call === 1) {
        return Promise.resolve(
          jsonResponse([
            { number: 1, state: 'open' },
            { number: 2, state: 'closed' },
          ]),
        );
      }
      return Promise.resolve(jsonResponse([{ sha: 'abc' }, { sha: 'def' }]));
    });
    await tracker._bootstrapRepo('foo/bar');
    const state = tracker._repoState('foo/bar');
    assert.equal(state.bootstrapped, true);
    assert.equal(state._bootstrapAttempts, 0);
    assert.deepEqual(state.seenPrIds, [1, 2]);
    assert.deepEqual(state.closedPrIds, [2]);
    assert.deepEqual(state.seenCommitShas, ['abc', 'def']);
  });

  it('does nothing when already bootstrapped', async () => {
    let fetched = false;
    const tracker = makeTracker(() => {
      fetched = true;
      return Promise.resolve(jsonResponse([]));
    });
    tracker._state['foo/bar'] = { bootstrapped: true };
    await tracker._bootstrapRepo('foo/bar');
    assert.equal(fetched, false);
  });

  it('recovers: failed attempts reset to 0 after successful bootstrap', async () => {
    let shouldFail = true;
    let call = 0;
    const tracker = makeTracker(() => {
      if (shouldFail) return Promise.reject(new Error('network'));
      call += 1;
      if (call === 1) return Promise.resolve(jsonResponse([{ number: 1, state: 'open' }]));
      return Promise.resolve(jsonResponse([{ sha: 'abc' }]));
    });

    await tracker._bootstrapRepo('foo/bar');
    await tracker._bootstrapRepo('foo/bar');
    assert.equal(tracker._repoState('foo/bar')._bootstrapAttempts, 2);

    shouldFail = false;
    await tracker._bootstrapRepo('foo/bar');
    const state = tracker._repoState('foo/bar');
    assert.equal(state.bootstrapped, true);
    assert.equal(state._bootstrapAttempts, 0);
  });
});

describe('github-tracker _pollRepo gate on bootstrapped', () => {
  it('does NOT enter normal poll when not yet bootstrapped', async () => {
    let prPollCalled = false;
    let pushPollCalled = false;
    // Bootstrap fails on every call — keeps bootstrapped=undefined.
    const tracker = makeTracker(() => Promise.reject(new Error('network')));
    tracker._pollPRs = async (_repo: string) => {
      prPollCalled = true;
    };
    tracker._pollPushes = async (_repo: string) => {
      pushPollCalled = true;
    };

    await tracker._pollRepo('foo/bar');

    assert.equal(prPollCalled, false);
    assert.equal(pushPollCalled, false);
    // Bootstrap retried once.
    assert.equal(tracker._repoState('foo/bar')._bootstrapAttempts, 1);
  });

  it('does NOT enter normal poll when only PR bootstrap succeeded (partial seed)', async () => {
    let prPollCalled = false;
    let pushPollCalled = false;
    const tracker = makeTracker((url: string) => {
      if (url.includes('/pulls')) {
        return Promise.resolve(jsonResponse([{ number: 1, state: 'open' }]));
      }
      return Promise.reject(new Error('commit api down'));
    });
    tracker._pollPRs = async (_repo: string) => {
      prPollCalled = true;
    };
    tracker._pollPushes = async (_repo: string) => {
      pushPollCalled = true;
    };

    await tracker._pollRepo('foo/bar');

    // Commit fetch failed → bootstrapped still false → normal poll blocked.
    assert.equal(prPollCalled, false);
    assert.equal(pushPollCalled, false);
    assert.equal(tracker._repoState('foo/bar').bootstrapped, undefined);
  });

  it('enters normal poll after successful bootstrap', async () => {
    let prPollCalled = false;
    let pushPollCalled = false;
    let call = 0;
    const tracker = makeTracker(() => {
      call += 1;
      if (call === 1) return Promise.resolve(jsonResponse([{ number: 1, state: 'open' }]));
      return Promise.resolve(jsonResponse([{ sha: 'abc' }]));
    });
    tracker._pollPRs = async (_repo: string) => {
      prPollCalled = true;
    };
    tracker._pollPushes = async (_repo: string) => {
      pushPollCalled = true;
    };

    // First call bootstraps → no normal poll yet.
    await tracker._pollRepo('foo/bar');
    assert.equal(tracker._repoState('foo/bar').bootstrapped, true);
    assert.equal(prPollCalled, false);
    assert.equal(pushPollCalled, false);

    // Second call: now bootstrapped → normal poll runs.
    await tracker._pollRepo('foo/bar');
    assert.equal(prPollCalled, true);
    assert.equal(pushPollCalled, true);
  });
});

import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

import { ServerResources, type ResourceResult } from '../src/server/server-resources.js';

afterEach(() => {
  mock.restoreAll();
});

describe('ServerResources cache stale signal', () => {
  function resource(overrides: Partial<ResourceResult> = {}): ResourceResult {
    return {
      cpu: 12,
      memUsed: null,
      memTotal: null,
      memPercent: null,
      diskUsed: null,
      diskTotal: null,
      diskPercent: null,
      uptime: null,
      source: 'pterodactyl',
      ...overrides,
    };
  }

  function deferredReject<T>() {
    let reject!: (err: Error) => void;
    const promise = new Promise<T>((_resolve, rejectFn) => {
      reject = rejectFn;
    });
    return { promise, reject };
  }

  it('returns a fresh result and reuses it inside the TTL', async () => {
    let now = 1_000;
    let calls = 0;
    const resources = new ServerResources({
      backend: 'pterodactyl',
      ttl: 1_000,
      now: () => now,
      fetchResource: async () => {
        calls += 1;
        return resource();
      },
    });

    const fresh = await resources.getResources();
    now = 1_500;
    const cached = await resources.getResources();

    assert.equal(calls, 1);
    assert.equal(fresh, cached);
    assert.equal(cached?.stale, undefined);
    assert.equal(cached?.cacheAgeMs, undefined);
  });

  it('marks expired cached resources as stale when refresh fails', async () => {
    mock.method(console, 'error', () => {});
    let now = 1_000;
    let calls = 0;
    const resources = new ServerResources({
      backend: 'pterodactyl',
      ttl: 1_000,
      now: () => now,
      fetchResource: async () => {
        calls += 1;
        if (calls > 1) throw new Error('panel unavailable');
        return resource({ cpu: 42, uptime: 60 });
      },
    });

    await resources.getResources();
    now = 2_500;
    const stale = await resources.getResources();

    assert.equal(calls, 2);
    assert.ok(stale);
    assert.equal(stale.cpu, 42);
    assert.equal(stale.uptime, 60);
    assert.equal(stale.stale, true);
    assert.equal(stale.cacheAgeMs, 1_500);
    assert.equal(stale.cachedAt, '1970-01-01T00:00:01.000Z');
  });

  it('deduplicates concurrent refreshes when cached resources expire', async () => {
    mock.method(console, 'error', () => {});
    let now = 1_000;
    let calls = 0;
    const refresh = deferredReject<ResourceResult>();
    const resources = new ServerResources({
      backend: 'pterodactyl',
      ttl: 1_000,
      now: () => now,
      fetchResource: async () => {
        calls += 1;
        if (calls === 1) return resource({ cpu: 42 });
        return refresh.promise;
      },
    });

    await resources.getResources();
    now = 2_500;
    const first = resources.getResources();
    const second = resources.getResources();

    assert.equal(calls, 2);
    refresh.reject(new Error('panel unavailable'));
    const [firstStale, secondStale] = await Promise.all([first, second]);

    assert.deepEqual(firstStale, secondStale);
    assert.ok(firstStale);
    assert.equal(firstStale.stale, true);
    assert.equal(firstStale.cacheAgeMs, 1_500);
  });

  it('returns null when refresh fails before any cache exists', async () => {
    mock.method(console, 'error', () => {});
    const resources = new ServerResources({
      backend: 'pterodactyl',
      ttl: 1_000,
      now: () => 1_000,
      fetchResource: async () => {
        throw new Error('panel unavailable');
      },
    });

    assert.equal(await resources.getResources(), null);
  });
});

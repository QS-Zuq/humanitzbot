import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import _server_status from '../src/modules/server-status.js';
const ServerStatus = _server_status as any;

import * as _mock_db from './helpers/mock-db.js';
const { mockDb: createMockDb } = _mock_db as any;

import * as _factories from './helpers/factories.js';
const { mockClient, mockConfig } = _factories as any;

function config(overrides: Record<string, unknown> = {}) {
  return mockConfig({
    serverStatusInterval: 30_000,
    statusCacheTtl: 60_000,
    showHostResources: false,
    ...overrides,
  });
}

function dbWithCache(cache: unknown) {
  return createMockDb({
    state: {
      server_status_cache: cache,
    },
  });
}

describe('ServerStatus bot_state cache hydration', () => {
  it('hydrates fresh server_status_cache state', () => {
    const db = dbWithCache({
      onlineSince: new Date(Date.now() - 10_000).toISOString(),
      offlineSince: null,
      lastOnline: true,
      lastInfo: { name: 'HumanitZ' },
      lastPlayerList: { players: ['Alice'] },
      savedAt: new Date(Date.now() - 1_000).toISOString(),
    });

    const status = new ServerStatus(mockClient(), { db, config: config() });

    assert.equal(status._lastOnline, true);
    assert.equal(status._lastInfo.name, 'HumanitZ');
    assert.deepEqual(status._lastPlayerList.players, [{ name: 'Alice', steamId: 'N/A' }]);
    assert.ok(status._onlineSince instanceof Date);
  });

  it('does not hydrate stale server_status_cache state', () => {
    const db = dbWithCache({
      onlineSince: new Date(Date.now() - 120_000).toISOString(),
      lastOnline: true,
      lastInfo: { name: 'Stale' },
      lastPlayerList: { players: ['Alice'] },
      savedAt: new Date(Date.now() - 120_000).toISOString(),
    });

    const status = new ServerStatus(mockClient(), { db, config: config({ statusCacheTtl: 30_000 }) });

    assert.equal(status._lastOnline, null);
    assert.equal(status._lastInfo, null);
    assert.equal(status._lastPlayerList, null);
    assert.equal(status._onlineSince, null);
  });

  it('does not hydrate future-dated server_status_cache state', () => {
    const db = dbWithCache({
      onlineSince: new Date(Date.now() - 1_000).toISOString(),
      lastOnline: true,
      lastInfo: { name: 'Future' },
      savedAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const status = new ServerStatus(mockClient(), { db, config: config() });

    assert.equal(status._lastOnline, null);
    assert.equal(status._lastInfo, null);
  });

  it('guards raw dry-run style invalid values without throwing', () => {
    const db = {
      botState: {
        getStateJSONValidated() {
          return 'bad';
        },
      },
    };

    assert.doesNotThrow(() => {
      const status = new ServerStatus(mockClient(), { db, config: config() });
      assert.equal(status._lastInfo, null);
    });
  });

  it('normalizes raw mode=off/dry-run cache shape before hydration', () => {
    const db = {
      botState: {
        getStateJSONValidated() {
          return {
            savedAt: new Date(Date.now() - 1_000).toISOString(),
            lastOnline: 'yes',
            lastInfo: 'bad',
            lastPlayerList: { players: ['Alice'] },
          };
        },
      },
    };

    const status = new ServerStatus(mockClient(), { db, config: config() });

    assert.equal(status._lastOnline, null);
    assert.equal(status._lastInfo, null);
    assert.deepEqual(status._lastPlayerList.players, [{ name: 'Alice', steamId: 'N/A' }]);
  });

  it('does not hydrate empty object cache payloads', () => {
    const db = dbWithCache({
      savedAt: new Date(Date.now() - 1_000).toISOString(),
      lastInfo: {},
      lastPlayerList: {},
    });

    const status = new ServerStatus(mockClient(), { db, config: config() });

    assert.equal(status._lastInfo, null);
    assert.equal(status._lastPlayerList, null);
  });
});

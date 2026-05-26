import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import _database from '../src/db/database.js';
const HumanitZDB = _database as any;

import _webMapServer from '../src/web-map/server.js';
const WebMapServer = _webMapServer as any;

import * as _route_helpers from './helpers/route-helpers.js';
const { extractHandler } = _route_helpers as any;

let db: any;

function mockRes() {
  let _status = 200;
  let _body: unknown = null;
  const res = {
    status(code: number) {
      _status = code;
      return res;
    },
    json(data: unknown) {
      _body = data;
    },
    get statusCode() {
      return _status;
    },
    get body() {
      return _body;
    },
    headersSent: false,
  };
  return res;
}

function makeSrv(overrides: Record<string, unknown> = {}) {
  return {
    serverId: 'primary',
    isPrimary: true,
    db: null,
    rcon: null,
    config: { botTimezone: 'UTC', serverName: 'Test' },
    playerStats: { getStats: () => null, getStatsByName: () => null },
    playtime: { getPlaytime: () => null },
    playerNameMap: {},
    dataDir: '/tmp/hmz-item-tracker-test',
    getPlayerList: async () => ({ players: [] }),
    getServerInfo: async () => null,
    sendAdminMessage: async () => '',
    panelApi: null,
    scheduler: null,
    ...overrides,
  };
}

function makeItemRepo(overrides: Record<string, unknown> = {}) {
  return {
    getActiveItemInstancesPage: () => [],
    getActiveItemGroupsPage: () => [],
    getItemLocationSummaryPage: () => [],
    getItemInstanceCount: () => 0,
    getItemGroupCount: () => 0,
    ...overrides,
  };
}

function makeDbWithItemRepo(itemRepo: Record<string, unknown>) {
  return { item: makeItemRepo(itemRepo) };
}

function seedInstance(overrides: Record<string, unknown> = {}) {
  return Number(
    db.item.createItemInstance({
      fingerprint: 'fp-' + Math.random().toString(16).slice(2),
      item: 'Nails',
      locationType: 'player',
      locationId: 'steam1',
      locationSlot: 'inventory',
      amount: 1,
      ...overrides,
    }),
  );
}

function seedGroup(overrides: Record<string, unknown> = {}) {
  return db.item.upsertItemGroup({
    fingerprint: 'grp-' + Math.random().toString(16).slice(2),
    item: 'Wood',
    locationType: 'container',
    locationId: 'crate1',
    locationSlot: 'items',
    quantity: 5,
    stackSize: 50,
    ...overrides,
  });
}

describe('Item tracker paginated data access', () => {
  beforeEach(() => {
    db = new HumanitZDB({ memory: true, label: 'item-tracker-page-performance' });
    db.init();
  });

  afterEach(() => {
    if (!db) return;
    db.close();
    db = null;
  });

  it('returns a projected page of active item instances without large JSON columns', () => {
    seedInstance({ fingerprint: 'fp-wrench', item: 'Wrench', locationType: 'container', locationId: 'crate1' });
    seedInstance({ fingerprint: 'fp-apple', item: 'Apple', locationType: 'player', locationId: 'steam1' });
    seedInstance({ fingerprint: 'fp-nails', item: 'Nails', locationType: 'player', locationId: 'steam1' });
    const lostId = seedInstance({
      fingerprint: 'fp-lost',
      item: 'Battery',
      locationType: 'player',
      locationId: 'steam1',
    });
    db.item.markItemLost(lostId);

    const rows = db.item.getActiveItemInstancesPage({ limit: 2, offset: 0 }) as Array<Record<string, unknown>>;

    assert.deepEqual(
      rows.map((row) => row.item),
      ['Apple', 'Nails'],
    );
    assert.equal(rows.length, 2);
    assert.equal(Object.prototype.hasOwnProperty.call(rows[0], 'attachments'), false);
    assert.equal(
      rows.some((row) => row.item === 'Battery'),
      false,
    );
  });

  it('supports search and location filters for item instance and group pages', () => {
    seedInstance({ fingerprint: 'fp-nails-player', item: 'Nails', locationType: 'player', locationId: 'steam1' });
    seedInstance({ fingerprint: 'fp-nails-crate', item: 'Nails', locationType: 'container', locationId: 'crate1' });
    seedGroup({ fingerprint: 'grp-nails-player', item: 'Nails', locationType: 'player', locationId: 'steam1' });
    seedGroup({ fingerprint: 'grp-wood-player', item: 'Wood', locationType: 'player', locationId: 'steam1' });

    const instanceRows = db.item.getActiveItemInstancesPage({
      limit: 10,
      offset: 0,
      search: 'Nail',
      locationType: 'player',
      locationId: 'steam1',
    }) as Array<Record<string, unknown>>;
    const groupRows = db.item.getActiveItemGroupsPage({
      limit: 10,
      offset: 0,
      search: 'Nail',
      locationType: 'player',
      locationId: 'steam1',
    }) as Array<Record<string, unknown>>;

    assert.deepEqual(
      instanceRows.map((row) => row.fingerprint),
      ['fp-nails-player'],
    );
    assert.deepEqual(
      groupRows.map((row) => row.fingerprint),
      ['grp-nails-player'],
    );
  });

  it('returns a bounded location summary for lazy filter options', () => {
    seedInstance({ item: 'Apple', locationType: 'player', locationId: 'steam1', amount: 2 });
    seedInstance({ item: 'Axe', locationType: 'player', locationId: 'steam1', amount: 1 });
    seedGroup({ item: 'Nails', locationType: 'container', locationId: 'crate1', quantity: 50 });
    seedGroup({ item: 'Wood', locationType: 'container', locationId: 'crate1', quantity: 5 });
    seedGroup({ item: 'Rope', locationType: 'vehicle', locationId: 'truck1', quantity: 3 });

    const rows = db.item.getItemLocationSummaryPage({ limit: 2, offset: 0 }) as Array<Record<string, unknown>>;

    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((row) => `${row.type as string}:${row.id as string}`),
      ['container:crate1', 'player:steam1'],
    );
    assert.deepEqual(rows[0], {
      type: 'container',
      id: 'crate1',
      instanceCount: 0,
      groupCount: 2,
      totalItems: 55,
    });
  });
});

describe('Item tracker panel routes', () => {
  const client = { channels: { cache: new Map() } };
  const server = new WebMapServer(client, {});
  const GET = (routePath: string) => extractHandler(server._app, 'get', routePath);

  it('returns a paginated item page and omits locations by default', () => {
    const calls: Array<{ method: string; options?: Record<string, unknown> }> = [];
    const itemRepo = makeItemRepo({
      getActiveItemInstancesPage: (options: Record<string, unknown>) => {
        calls.push({ method: 'instances', options });
        return [{ id: 1 }, { id: 2 }, { id: 3 }];
      },
      getActiveItemGroupsPage: (options: Record<string, unknown>) => {
        calls.push({ method: 'groups', options });
        return [{ id: 'g1' }, { id: 'g2' }, { id: 'g3' }];
      },
      getItemLocationSummaryPage: () => {
        throw new Error('locations should be lazy-loaded');
      },
      getItemInstanceCount: () => 42,
      getItemGroupCount: () => 7,
    });
    const handler = GET('/api/panel/items');
    const res = mockRes();

    handler(
      {
        srv: makeSrv({ db: makeDbWithItemRepo(itemRepo) }),
        query: { limit: '2', offset: '4', search: 'Nail', view: 'all' },
      },
      res,
    );

    const body = res.body as Record<string, any>;
    assert.equal(res.statusCode, 200);
    assert.deepEqual(body.instances, [{ id: 1 }, { id: 2 }]);
    assert.deepEqual(body.groups, [{ id: 'g1' }, { id: 'g2' }]);
    assert.deepEqual(body.locations, []);
    assert.deepEqual(body.counts, { instances: 42, groups: 7 });
    assert.deepEqual(body.pagination, {
      limit: 2,
      offset: 4,
      nextOffset: 6,
      hasMoreInstances: true,
      hasMoreGroups: true,
    });
    assert.deepEqual(calls, [
      {
        method: 'instances',
        options: { limit: 3, offset: 4, search: 'Nail', locationType: '', locationId: '' },
      },
      {
        method: 'groups',
        options: { limit: 3, offset: 4, search: 'Nail', locationType: '', locationId: '' },
      },
    ]);
  });

  it('respects view and location filters', () => {
    let instanceCalled = false;
    const calls: Array<Record<string, unknown>> = [];
    const itemRepo = makeItemRepo({
      getActiveItemInstancesPage: () => {
        instanceCalled = true;
        return [];
      },
      getActiveItemGroupsPage: (options: Record<string, unknown>) => {
        calls.push(options);
        return [{ id: 'g1' }];
      },
    });
    const handler = GET('/api/panel/items');
    const res = mockRes();

    handler(
      {
        srv: makeSrv({ db: makeDbWithItemRepo(itemRepo) }),
        query: { view: ['groups'], locationType: 'player', locationId: 'steam1' },
      },
      res,
    );

    assert.equal(instanceCalled, false);
    assert.deepEqual(calls, [{ limit: 101, offset: 0, search: '', locationType: 'player', locationId: 'steam1' }]);
  });

  it('returns safe empty item payloads when the database is unavailable', () => {
    const handler = GET('/api/panel/items');
    const res = mockRes();

    handler({ srv: makeSrv(), query: { limit: '2', offset: '4' } }, res);

    assert.deepEqual(res.body, {
      instances: [],
      groups: [],
      locations: [],
      counts: { instances: 0, groups: 0 },
      pagination: { limit: 2, offset: 4, nextOffset: 4, hasMoreInstances: false, hasMoreGroups: false },
    });
  });

  it('returns lazy location pages separately from the item list payload', () => {
    const itemRepo = makeItemRepo({
      getItemLocationSummaryPage: (options: Record<string, unknown>) => {
        assert.deepEqual(options, { limit: 3, offset: 0, search: 'crate' });
        return [{ id: 'crate1' }, { id: 'crate2' }, { id: 'crate3' }];
      },
    });
    const handler = GET('/api/panel/items/locations');
    const res = mockRes();

    handler({ srv: makeSrv({ db: makeDbWithItemRepo(itemRepo) }), query: { limit: '2', search: 'crate' } }, res);

    assert.deepEqual(res.body, {
      locations: [{ id: 'crate1' }, { id: 'crate2' }],
      pagination: { limit: 2, offset: 0, nextOffset: 2, hasMore: true },
    });
  });

  it('reports item route failures with a structured 500 response', () => {
    const itemRepo = makeItemRepo({
      getActiveItemInstancesPage: () => {
        throw new Error('boom');
      },
    });
    const handler = GET('/api/panel/items');
    const res = mockRes();

    handler({ srv: makeSrv({ db: makeDbWithItemRepo(itemRepo) }), query: {} }, res);

    assert.equal(res.statusCode, 500);
    assert.equal((res.body as Record<string, unknown>).ok, false);
    assert.equal((res.body as Record<string, unknown>).code, 'INTERNAL_SERVER_ERROR');
  });
});

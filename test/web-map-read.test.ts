/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-require-imports, @typescript-eslint/no-floating-promises, @typescript-eslint/require-await, @typescript-eslint/no-non-null-assertion */
'use strict';

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const WebMapServer = require('../src/web-map/server');

const { extractHandler } = require('./helpers/route-helpers');

/** Create a mock response that captures status code and JSON body. */
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
    type() {
      return res;
    },
    send() {},
    sendFile() {},
    setHeader() {
      return res;
    },
    removeHeader() {},
    getHeader() {},
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

/** Create a mock server context (req.srv). */
function makeSrv(overrides: Record<string, unknown> = {}) {
  return {
    serverId: 'primary',
    isPrimary: true,
    db: null,
    rcon: null,
    config: { botTimezone: 'UTC', serverName: 'Test' },
    playerStats: { getStats: () => null, getStatsByName: () => null },
    playtime: { getPlaytime: () => null },
    idMap: {},
    dataDir: '/tmp/hmztest',
    getPlayerList: async () => ({ players: [] }),
    getServerInfo: async () => null,
    scheduler: null,
    ...overrides,
  };
}

function makeMockDb(overrides: Record<string, unknown> = {}) {
  return {
    getAllClans: () => [],
    getRecentActivity: () => [],
    getActivityByCategory: () => [],
    getActivityByActor: () => [],
    getRecentChat: () => [],
    searchChat: () => [],
    getTimelineBounds: () => ({ earliest: null, latest: null, count: 0 }),
    getTimelineSnapshots: () => [],
    getTimelineSnapshotRange: () => [],
    getTimelineSnapshotFull: () => null,
    getPlayerPositionHistory: () => [],
    getAIPopulationHistory: () => [],
    getDeathCauses: () => [],
    getDeathCausesByPlayer: () => [],
    getDeathCauseStats: () => [],
    db: { prepare: () => ({ all: () => [], get: () => null }) },
    ...overrides,
  };
}

function makeSqlMock(tables: Record<string, unknown[]> = {}) {
  return {
    prepare: (sql: string) => {
      if (sql.includes('sqlite_master')) {
        return { all: () => Object.keys(tables).map((name) => ({ name })) };
      }
      if (/COUNT\(\*\)/i.test(sql)) {
        const m = sql.match(/FROM\s+"?(\w+)"?/i);
        const rows = tables[m?.[1] ?? ''] || [];
        return { get: () => ({ c: rows.length, cnt: rows.length, total: rows.length }) };
      }
      if (/PRAGMA\s+table_info/i.test(sql)) {
        const m = sql.match(/"(\w+)"/);
        const rows = tables[m?.[1] ?? ''] || [];
        if (!rows.length) return { all: () => [] };
        return {
          all: () =>
            Object.keys(rows[0] as Record<string, unknown>).map((name, i) => ({
              name,
              type: 'TEXT',
              pk: i === 0 ? 1 : 0,
              notnull: 0,
            })),
        };
      }
      // Default SELECT
      const m = sql.match(/FROM\s+"?(\w+)"?/i);
      const t = m?.[1];
      return {
        all: () => (t ? tables[t] || [] : []),
        get: () => (t ? (tables[t] || [])[0] || null : null),
      };
    },
  };
}

// ── Server instance (no HTTP listen) ─────────────────────────────────────────

const client = { channels: { cache: new Map() } };
const server = new WebMapServer(client, {});
const app = server._app;
const GET = (routePath: string) => extractHandler(app, 'get', routePath);

// ══════════════════════════════════════════════════════════════════════════════
// Tests
// ══════════════════════════════════════════════════════════════════════════════

describe('Web Map Read Endpoints', () => {
  beforeEach(() => {
    server._responseCache.clear();
    server._playerCache = new Map();
    server._lastParse = 0;
    server._idMap = {};
    // Restore any instance-level overrides back to prototype
    delete server._parseSaveData;
    delete server._buildLandingData;
    delete server._buildStatusCache;
    delete server._buildStatsCache;
  });

  // ── GET /api/players ─────────────────────────────────────

  describe('GET /api/players', () => {
    it('returns players from pre-populated cache', async () => {
      server._playerCache = new Map([['76561198000000001', { x: 1000, y: -2000, z: 50, male: true }]]);
      server._lastParse = Date.now();

      const handler = GET('/api/players');
      const res = mockRes();
      await handler({ srv: makeSrv({ idMap: { '76561198000000001': 'Alice' } }), query: {} }, res);

      assert.ok(res.body);
      assert.ok(Array.isArray((res.body as Record<string, unknown>).players));
      assert.equal(((res.body as Record<string, unknown>).players as unknown[]).length, 1);
      assert.equal(
        ((res.body as Record<string, unknown>).players as Record<string, unknown>[])[0]!.steamId,
        '76561198000000001',
      );
      assert.equal(((res.body as Record<string, unknown>).players as Record<string, unknown>[])[0]!.name, 'Alice');
      assert.equal((res.body as Record<string, unknown>).server, 'primary');
      assert.ok('worldBounds' in (res.body as Record<string, unknown>));
      assert.ok('toggles' in (res.body as Record<string, unknown>));
      assert.ok('lastUpdated' in (res.body as Record<string, unknown>));
    });

    it('returns empty players array when no save data', async () => {
      server._parseSaveData = () => new Map();

      const handler = GET('/api/players');
      const res = mockRes();
      await handler({ srv: makeSrv(), query: {} }, res);

      assert.ok(res.body);
      assert.deepEqual((res.body as Record<string, unknown>).players, []);
    });
  });

  // ── GET /api/players/:steamId ────────────────────────────

  describe('GET /api/players/:steamId', () => {
    it('returns player detail when steamId found', () => {
      server._playerCache = new Map([['76561198000000001', { x: 500, y: -1000, z: 10, male: false }]]);
      server._lastParse = Date.now();

      const handler = GET('/api/players/:steamId');
      const res = mockRes();
      handler(
        {
          srv: makeSrv({ idMap: { '76561198000000001': 'Bob' } }),
          params: { steamId: '76561198000000001' },
          query: {},
        },
        res,
      );

      assert.ok(res.body);
      assert.equal((res.body as Record<string, unknown>).steamId, '76561198000000001');
      assert.equal((res.body as Record<string, unknown>).name, 'Bob');
      assert.ok('toggles' in (res.body as Record<string, unknown>));
      assert.ok('profession' in (res.body as Record<string, unknown>));
    });

    it('returns 404 for unknown steamId', () => {
      server._parseSaveData = () => new Map();

      const handler = GET('/api/players/:steamId');
      const res = mockRes();
      handler({ srv: makeSrv(), params: { steamId: '76561198999999999' }, query: {} }, res);

      assert.equal(res.statusCode, 404);
      assert.equal((res.body as Record<string, unknown>).code, 'PLAYER_NOT_FOUND');
    });
  });

  // ── GET /api/online ──────────────────────────────────────

  describe('GET /api/online', () => {
    it('returns cached online data when available', async () => {
      const onlineData = [{ steamId: '76561198000000001', name: 'Alice' }];
      server._setCache('online', 'primary', onlineData);

      const handler = GET('/api/online');
      const res = mockRes();
      await handler({ srv: makeSrv(), query: {} }, res);

      assert.deepEqual(res.body, { players: onlineData });
    });

    it('falls back to getPlayerList on cache miss', async () => {
      const mockList = [{ steamId: '76561198000000002', name: 'Carol' }];

      const handler = GET('/api/online');
      const res = mockRes();
      await handler({ srv: makeSrv({ getPlayerList: async () => mockList }), query: {} }, res);

      assert.deepEqual(res.body, { players: mockList });
    });
  });

  // ── GET /api/landing ─────────────────────────────────────

  describe('GET /api/landing', () => {
    it('returns cached landing data', async () => {
      const landingData = { primary: { name: 'TestServer', status: 'online' }, servers: [] };
      server._setCache('landing', 'global', landingData);

      const handler = GET('/api/landing');
      const res = mockRes();
      await handler({ srv: makeSrv(), query: {} }, res);

      assert.deepEqual(res.body, landingData);
    });

    it('returns fallback structure on cache miss', async () => {
      server._buildLandingData = async () => {}; // no-op to avoid RCON/file reads

      const handler = GET('/api/landing');
      const res = mockRes();
      await handler({ srv: makeSrv(), query: {} }, res);

      assert.ok((res.body as Record<string, unknown>).primary);
      assert.equal(((res.body as Record<string, unknown>).primary as Record<string, unknown>).status, 'unknown');
      assert.ok(Array.isArray((res.body as Record<string, unknown>).servers));
    });
  });

  // ── GET /api/panel/status ────────────────────────────────

  describe('GET /api/panel/status', () => {
    it('returns cached status data', async () => {
      const statusData = { serverState: 'online', onlineCount: 5, timezone: 'UTC' };
      server._setCache('status', 'primary', statusData);

      const handler = GET('/api/panel/status');
      const res = mockRes();
      await handler({ srv: makeSrv(), query: {} }, res);

      assert.deepEqual(res.body, statusData);
    });

    it('returns fallback when no cache', async () => {
      server._buildStatusCache = async () => {}; // no-op

      const handler = GET('/api/panel/status');
      const res = mockRes();
      await handler({ srv: makeSrv(), query: {} }, res);

      assert.equal((res.body as Record<string, unknown>).serverState, 'unknown');
      assert.equal((res.body as Record<string, unknown>).onlineCount, 0);
    });
  });

  // ── GET /api/panel/stats ─────────────────────────────────

  describe('GET /api/panel/stats', () => {
    it('returns cached stats data', async () => {
      const statsData = { totalPlayers: 42, onlinePlayers: 3, eventsToday: 100, chatsToday: 20 };
      server._setCache('stats', 'primary', statsData);

      const handler = GET('/api/panel/stats');
      const res = mockRes();
      await handler({ srv: makeSrv(), query: {} }, res);

      assert.deepEqual(res.body, statsData);
    });

    it('returns fallback when no cache', async () => {
      server._buildStatsCache = async () => {}; // no-op

      const handler = GET('/api/panel/stats');
      const res = mockRes();
      await handler({ srv: makeSrv(), query: {} }, res);

      assert.equal((res.body as Record<string, unknown>).totalPlayers, 0);
      assert.equal((res.body as Record<string, unknown>).onlinePlayers, 0);
    });
  });

  // ── GET /api/panel/capabilities ──────────────────────────

  describe('GET /api/panel/capabilities', () => {
    it('returns capabilities reflecting db presence', () => {
      const handler = GET('/api/panel/capabilities');
      const res = mockRes();
      handler({ srv: makeSrv({ db: makeMockDb() }), query: {} }, res);

      assert.equal((res.body as Record<string, unknown>).db, true);
      assert.equal((res.body as Record<string, unknown>).isPrimary, true);
      assert.equal((res.body as Record<string, unknown>).serverId, 'primary');
    });

    it('returns db=false when no database', () => {
      const handler = GET('/api/panel/capabilities');
      const res = mockRes();
      handler({ srv: makeSrv({ db: null }), query: {} }, res);

      assert.equal((res.body as Record<string, unknown>).db, false);
    });
  });

  // ── GET /api/panel/activity ──────────────────────────────

  describe('GET /api/panel/activity', () => {
    it('returns events from db', () => {
      const events = [
        { type: 'player_connect', steam_id: '76561198000000001', timestamp: '2026-01-01T00:00:00Z' },
        { type: 'player_death', steam_id: '76561198000000002', timestamp: '2026-01-01T01:00:00Z' },
      ];
      const db = makeMockDb({ getRecentActivity: () => events });

      const handler = GET('/api/panel/activity');
      const res = mockRes();
      handler({ srv: makeSrv({ db }), query: {} }, res);

      assert.ok(Array.isArray((res.body as Record<string, unknown>).events));
      assert.equal(((res.body as Record<string, unknown>).events as unknown[]).length, 2);
      assert.equal(
        ((res.body as Record<string, unknown>).events as Record<string, unknown>[])[0]!.type,
        'player_connect',
      );
    });

    it('returns empty events when no db', () => {
      const handler = GET('/api/panel/activity');
      const res = mockRes();
      handler({ srv: makeSrv(), query: {} }, res);

      assert.deepEqual(res.body, { events: [] });
    });

    it('filters by type query param', () => {
      const db = makeMockDb({
        getActivityByCategory: (type: string) => [{ type, steam_id: '123', timestamp: 'now' }],
      });

      const handler = GET('/api/panel/activity');
      const res = mockRes();
      handler({ srv: makeSrv({ db }), query: { type: 'player_connect' } }, res);

      assert.equal(((res.body as Record<string, unknown>).events as unknown[]).length, 1);
      assert.equal(
        ((res.body as Record<string, unknown>).events as Record<string, unknown>[])[0]!.type,
        'player_connect',
      );
    });

    it('filters by actor query param', () => {
      const db = makeMockDb({
        getActivityByActor: (actor: string) => [{ type: 'player_build', actor, timestamp: 'now' }],
      });

      const handler = GET('/api/panel/activity');
      const res = mockRes();
      handler({ srv: makeSrv({ db }), query: { actor: 'Alice' } }, res);

      assert.equal(((res.body as Record<string, unknown>).events as unknown[]).length, 1);
      assert.equal(((res.body as Record<string, unknown>).events as Record<string, unknown>[])[0]!.actor, 'Alice');
    });
  });

  // ── GET /api/panel/clans ─────────────────────────────────

  describe('GET /api/panel/clans', () => {
    it('returns clans from db', () => {
      const clans = [{ name: 'TestClan', members: [{ steam_id: '123', rank: 'leader' }] }];
      const db = makeMockDb({ getAllClans: () => clans });

      const handler = GET('/api/panel/clans');
      const res = mockRes();
      handler({ srv: makeSrv({ db }), query: {} }, res);

      assert.deepEqual(res.body, { clans });
    });

    it('returns empty clans when no db', () => {
      const handler = GET('/api/panel/clans');
      const res = mockRes();
      handler({ srv: makeSrv(), query: {} }, res);

      assert.deepEqual(res.body, { clans: [] });
    });
  });

  // ── GET /api/panel/chat ──────────────────────────────────

  describe('GET /api/panel/chat', () => {
    it('returns messages from db', () => {
      const messages = [{ id: 1, player_name: 'Alice', message: 'hello', timestamp: 'now' }];
      const db = makeMockDb({ getRecentChat: () => messages });

      const handler = GET('/api/panel/chat');
      const res = mockRes();
      handler({ srv: makeSrv({ db }), query: {} }, res);

      assert.deepEqual(res.body, { messages });
    });

    it('returns empty messages when no db', () => {
      const handler = GET('/api/panel/chat');
      const res = mockRes();
      handler({ srv: makeSrv(), query: {} }, res);

      assert.deepEqual(res.body, { messages: [] });
    });

    it('uses searchChat when search param provided', () => {
      let searchedTerm: string | null = null;
      const db = makeMockDb({
        searchChat: (term: string) => {
          searchedTerm = term;
          return [{ id: 2, message: 'found it' }];
        },
      });

      const handler = GET('/api/panel/chat');
      const res = mockRes();
      handler({ srv: makeSrv({ db }), query: { search: 'hello' } }, res);

      assert.equal(searchedTerm, 'hello');
      assert.equal(((res.body as Record<string, unknown>).messages as unknown[]).length, 1);
    });
  });

  // ── GET /api/panel/db/tables ─────────────────────────────

  describe('GET /api/panel/db/tables', () => {
    it('returns whitelisted tables with row counts', () => {
      const rawDb = makeSqlMock({
        players: [{ steam_id: '123', name: 'Alice' }],
        clans: [{ id: 1, name: 'TestClan' }],
        secret_internal: [{ x: 1 }], // not in whitelist — should be filtered out
      });
      const db = makeMockDb({ db: rawDb });

      const handler = GET('/api/panel/db/tables');
      const res = mockRes();
      handler({ srv: makeSrv({ db }), query: {} }, res);

      assert.ok(Array.isArray((res.body as Record<string, unknown>).tables));
      const names = ((res.body as Record<string, unknown>).tables as Record<string, unknown>[]).map((t) => t.name);
      assert.ok(names.includes('players'));
      assert.ok(names.includes('clans'));
      assert.ok(!names.includes('secret_internal'), 'non-whitelisted table should be filtered');
      const playersTable = ((res.body as Record<string, unknown>).tables as Record<string, unknown>[]).find(
        (t) => t.name === 'players',
      );
      assert.equal((playersTable as Record<string, unknown>).rowCount, 1);
      assert.ok(Array.isArray((playersTable as Record<string, unknown>).columns));
    });

    it('returns empty tables when no db', () => {
      const handler = GET('/api/panel/db/tables');
      const res = mockRes();
      handler({ srv: makeSrv(), query: {} }, res);

      assert.deepEqual(res.body, { tables: [] });
    });
  });

  // ── GET /api/panel/db/:table ─────────────────────────────

  describe('GET /api/panel/db/:table', () => {
    it('returns rows from a whitelisted table', () => {
      const rawDb = makeSqlMock({
        players: [
          { steam_id: '76561198000000001', name: 'Alice' },
          { steam_id: '76561198000000002', name: 'Bob' },
        ],
      });
      const db = makeMockDb({ db: rawDb });

      const handler = GET('/api/panel/db/:table');
      const res = mockRes();
      handler({ srv: makeSrv({ db }), params: { table: 'players' }, query: {} }, res);

      assert.equal((res.body as Record<string, unknown>).table, 'players');
      assert.ok(Array.isArray((res.body as Record<string, unknown>).rows));
      assert.ok(Array.isArray((res.body as Record<string, unknown>).columns));
      assert.equal(((res.body as Record<string, unknown>).rows as unknown[]).length, 2);
    });

    it('rejects non-whitelisted table name', () => {
      const db = makeMockDb();

      const handler = GET('/api/panel/db/:table');
      const res = mockRes();
      handler({ srv: makeSrv({ db }), params: { table: 'secret_data' }, query: {} }, res);

      assert.equal(res.statusCode, 400);
      assert.equal((res.body as Record<string, unknown>).code, 'TABLE_NOT_QUERYABLE');
    });

    it('rejects table name with SQL injection characters', () => {
      const db = makeMockDb();

      const handler = GET('/api/panel/db/:table');
      const res = mockRes();
      handler({ srv: makeSrv({ db }), params: { table: "'; DROP TABLE--" }, query: {} }, res);

      assert.equal(res.statusCode, 400);
      assert.equal((res.body as Record<string, unknown>).code, 'INVALID_TABLE_NAME');
    });

    it('returns empty when no db', () => {
      const handler = GET('/api/panel/db/:table');
      const res = mockRes();
      handler({ srv: makeSrv(), params: { table: 'players' }, query: {} }, res);

      assert.deepEqual(res.body, { rows: [], columns: [] });
    });
  });

  // ── GET /api/timeline/bounds ─────────────────────────────

  describe('GET /api/timeline/bounds', () => {
    it('returns bounds from db', () => {
      const bounds = { earliest: '2026-01-01T00:00:00Z', latest: '2026-03-01T00:00:00Z', count: 100 };
      const db = makeMockDb({ getTimelineBounds: () => bounds });

      const handler = GET('/api/timeline/bounds');
      const res = mockRes();
      handler({ srv: makeSrv({ db }), query: {} }, res);

      assert.deepEqual(res.body, bounds);
    });

    it('returns empty bounds when no db', () => {
      const handler = GET('/api/timeline/bounds');
      const res = mockRes();
      handler({ srv: makeSrv(), query: {} }, res);

      assert.deepEqual(res.body, { earliest: null, latest: null, count: 0 });
    });
  });

  // ── GET /api/timeline/snapshots ──────────────────────────

  describe('GET /api/timeline/snapshots', () => {
    it('returns snapshot list from db', () => {
      const snapshots = [
        { id: 1, created_at: '2026-01-01T00:00:00Z', player_count: 5 },
        { id: 2, created_at: '2026-01-01T01:00:00Z', player_count: 8 },
      ];
      const db = makeMockDb({ getTimelineSnapshots: () => snapshots });

      const handler = GET('/api/timeline/snapshots');
      const res = mockRes();
      handler({ srv: makeSrv({ db }), query: {} }, res);

      assert.deepEqual(res.body, snapshots);
    });

    it('returns empty array when no db', () => {
      const handler = GET('/api/timeline/snapshots');
      const res = mockRes();
      handler({ srv: makeSrv(), query: {} }, res);

      assert.deepEqual(res.body, []);
    });

    it('uses range query when from and to provided', () => {
      let calledFrom: string | null = null;
      let calledTo: string | null = null;
      const db = makeMockDb({
        getTimelineSnapshotRange: (from: string, to: string) => {
          calledFrom = from;
          calledTo = to;
          return [{ id: 3 }];
        },
      });

      const handler = GET('/api/timeline/snapshots');
      const res = mockRes();
      handler({ srv: makeSrv({ db }), query: { from: '2026-01-01', to: '2026-01-31' } }, res);

      assert.equal(calledFrom, '2026-01-01');
      assert.equal(calledTo, '2026-01-31');
      assert.deepEqual(res.body, [{ id: 3 }]);
    });
  });

  // ── GET /api/timeline/snapshot/:id ───────────────────────

  describe('GET /api/timeline/snapshot/:id', () => {
    it('returns full snapshot data with map coordinates', () => {
      const rawDb = makeSqlMock({ players: [{ steam_id: '123', name: 'Alice' }] });
      const full = {
        id: 1,
        players: [{ steam_id: '123', pos_x: 1000, pos_y: -2000 }],
        ai: [],
        vehicles: [],
        structures: [],
        companions: [],
        backpacks: [],
      };
      const db = makeMockDb({ getTimelineSnapshotFull: () => full, db: rawDb });

      const handler = GET('/api/timeline/snapshot/:id');
      const res = mockRes();
      handler({ srv: makeSrv({ db }), params: { id: '1' }, query: {} }, res);

      assert.ok(res.body);
      const players = (res.body as { players: Record<string, unknown>[] }).players;
      const firstPlayer = players[0]!;
      assert.ok('lat' in firstPlayer, 'should have lat coordinate');
      assert.ok('lng' in firstPlayer, 'should have lng coordinate');
      assert.ok((res.body as Record<string, unknown>).nameMap, 'should include nameMap');
    });

    it('returns 400 for non-numeric snapshot id', () => {
      const db = makeMockDb();

      const handler = GET('/api/timeline/snapshot/:id');
      const res = mockRes();
      handler({ srv: makeSrv({ db }), params: { id: 'abc' }, query: {} }, res);

      assert.equal(res.statusCode, 400);
      assert.equal((res.body as Record<string, unknown>).code, 'INVALID_SNAPSHOT_ID');
    });

    it('returns 404 when snapshot not found', () => {
      const db = makeMockDb({ getTimelineSnapshotFull: () => null });

      const handler = GET('/api/timeline/snapshot/:id');
      const res = mockRes();
      handler({ srv: makeSrv({ db }), params: { id: '999' }, query: {} }, res);

      assert.equal(res.statusCode, 404);
      assert.equal((res.body as Record<string, unknown>).code, 'SNAPSHOT_NOT_FOUND');
    });

    it('returns 404 when no db', () => {
      const handler = GET('/api/timeline/snapshot/:id');
      const res = mockRes();
      handler({ srv: makeSrv(), params: { id: '1' }, query: {} }, res);

      assert.equal(res.statusCode, 404);
      assert.equal((res.body as Record<string, unknown>).code, 'DATABASE_NOT_AVAILABLE');
    });
  });

  // ── GET /api/timeline/player/:steamId/trail ──────────────

  describe('GET /api/timeline/player/:steamId/trail', () => {
    it('returns trail positions with map coordinates', () => {
      const positions = [{ pos_x: 1000, pos_y: -2000, health: 100, online: 1, created_at: '2026-01-01', game_day: 5 }];
      const db = makeMockDb({ getPlayerPositionHistory: () => positions });

      const handler = GET('/api/timeline/player/:steamId/trail');
      const res = mockRes();
      handler({ srv: makeSrv({ db }), params: { steamId: '76561198000000001' }, query: { from: 'a', to: 'b' } }, res);

      assert.ok(Array.isArray(res.body));
      assert.equal((res.body as unknown[]).length, 1);
      assert.ok('lat' in (res.body as Record<string, unknown>[])[0]!);
      assert.ok('lng' in (res.body as Record<string, unknown>[])[0]!);
    });

    it('returns 400 when from/to params missing', () => {
      const db = makeMockDb();

      const handler = GET('/api/timeline/player/:steamId/trail');
      const res = mockRes();
      handler({ srv: makeSrv({ db }), params: { steamId: '123' }, query: {} }, res);

      assert.equal(res.statusCode, 400);
      assert.equal((res.body as Record<string, unknown>).code, 'FROM_AND_TO_REQUIRED');
    });
  });

  // ── GET /api/timeline/ai/population ──────────────────────

  describe('GET /api/timeline/ai/population', () => {
    it('returns population data from db', () => {
      const data = [{ time: '2026-01-01', count: 50 }];
      const db = makeMockDb({ getAIPopulationHistory: () => data });

      const handler = GET('/api/timeline/ai/population');
      const res = mockRes();
      handler({ srv: makeSrv({ db }), query: { from: 'a', to: 'b' } }, res);

      assert.deepEqual(res.body, data);
    });

    it('returns 400 when from/to params missing', () => {
      const db = makeMockDb();

      const handler = GET('/api/timeline/ai/population');
      const res = mockRes();
      handler({ srv: makeSrv({ db }), query: {} }, res);

      assert.equal(res.statusCode, 400);
      assert.equal((res.body as Record<string, unknown>).code, 'FROM_AND_TO_REQUIRED');
    });
  });

  // ── GET /api/timeline/deaths ─────────────────────────────

  describe('GET /api/timeline/deaths', () => {
    it('returns deaths from db', () => {
      const deaths = [{ steam_id: '123', cause: 'zombie', pos_x: 1000, pos_y: -2000 }];
      const db = makeMockDb({ getDeathCauses: () => deaths });

      const handler = GET('/api/timeline/deaths');
      const res = mockRes();
      handler({ srv: makeSrv({ db }), query: {} }, res);

      assert.ok(Array.isArray(res.body));
      assert.equal((res.body as unknown[]).length, 1);
      // Should have map coordinates added
      assert.ok('lat' in (res.body as Record<string, unknown>[])[0]!);
      assert.ok('lng' in (res.body as Record<string, unknown>[])[0]!);
    });

    it('returns empty array when no db', () => {
      const handler = GET('/api/timeline/deaths');
      const res = mockRes();
      handler({ srv: makeSrv(), query: {} }, res);

      assert.deepEqual(res.body, []);
    });

    it('filters by player query param', () => {
      let calledPlayer: string | null = null;
      const db = makeMockDb({
        getDeathCausesByPlayer: (player: string) => {
          calledPlayer = player;
          return [{ steam_id: player, cause: 'fall' }];
        },
      });

      const handler = GET('/api/timeline/deaths');
      const res = mockRes();
      handler({ srv: makeSrv({ db }), query: { player: '76561198000000001' } }, res);

      assert.equal(calledPlayer, '76561198000000001');
      assert.equal((res.body as unknown[]).length, 1);
    });
  });

  // ── GET /api/timeline/deaths/stats ───────────────────────

  describe('GET /api/timeline/deaths/stats', () => {
    it('returns death cause stats from db', () => {
      const stats = [
        { cause: 'zombie', count: 50 },
        { cause: 'fall', count: 10 },
      ];
      const db = makeMockDb({ getDeathCauseStats: () => stats });

      const handler = GET('/api/timeline/deaths/stats');
      const res = mockRes();
      handler({ srv: makeSrv({ db }), query: {} }, res);

      assert.deepEqual(res.body, stats);
    });

    it('returns empty array when no db', () => {
      const handler = GET('/api/timeline/deaths/stats');
      const res = mockRes();
      handler({ srv: makeSrv(), query: {} }, res);

      assert.deepEqual(res.body, []);
    });
  });

  // ── GET /api/panel/scheduler ─────────────────────────────

  describe('GET /api/panel/scheduler', () => {
    it('returns scheduler status when scheduler exists', () => {
      const status = { active: true, nextRestart: '2026-01-01T12:00:00Z', profile: 'default' };
      const srv = makeSrv({ scheduler: { getStatus: () => status } });

      const handler = GET('/api/panel/scheduler');
      const res = mockRes();
      handler({ srv, query: {} }, res);

      assert.deepEqual(res.body, status);
    });

    it('returns inactive when no scheduler', () => {
      const handler = GET('/api/panel/scheduler');
      const res = mockRes();
      handler({ srv: makeSrv(), query: {} }, res);

      assert.deepEqual(res.body, { active: false });
    });
  });
});

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-floating-promises */
'use strict';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import * as _mock_db from './helpers/mock-db.js';
const { mockDb } = _mock_db as any;

import * as _api_errors from '../src/web-map/api-errors.js';
const { API_ERRORS } = _api_errors as any;

import _webMapServer from '../src/web-map/server.js';
const WebMapServer = _webMapServer as any;

import * as _route_helpers from './helpers/route-helpers.js';
const { extractHandler: _extractHandler } = _route_helpers as any;

// ── Mock configRepo ──────────────────────────────────────────────────────────

function mockConfigRepo(initial: Record<string, unknown> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    get(key: string) {
      return store.get(key) || null;
    },
    set(key: string, value: unknown) {
      store.set(key, value);
    },
    update(key: string, patch: Record<string, unknown>) {
      const existing = (store.get(key) || {}) as Record<string, unknown>;
      store.set(key, { ...existing, ...patch });
    },
    delete(key: string) {
      store.delete(key);
    },
    loadAll() {
      const entries: [string, { data: unknown }][] = [];
      for (const [scope, data] of store) {
        entries.push([scope, { data }]);
      }
      return entries;
    },
    _store: store,
  };
}

// ── Shared helpers ───────────────────────────────────────────────────────────

function mockRes() {
  const res: Record<string, unknown> = {
    _status: 200,
    _json: null,
    _headers: {} as Record<string, unknown>,
    status(code: number) {
      res._status = code;
      return res;
    },
    json(data: unknown) {
      res._json = data;
      return res;
    },
    setHeader(k: string, v: unknown) {
      (res._headers as Record<string, unknown>)[k] = v;
    },
    type() {
      return res;
    },
    send() {
      return res;
    },
    redirect() {},
  };
  return res;
}

function mockReq(overrides: Record<string, unknown> = {}) {
  return {
    body: {},
    query: {},
    params: {},
    path: '/',
    headers: {},
    tier: 'admin',
    tierLevel: 3,
    session: { username: 'TestAdmin' },
    ip: '127.0.0.1',
    ...overrides,
  };
}

// ── Create two WebMapServer instances: one with configRepo, one without ──────

const client = { channels: { cache: new Map() } };

const _configRepo = mockConfigRepo({
  'server:srv1': {
    id: 'srv1',
    name: 'Server 1',
    autoMessages: {
      enableWelcomeMsg: false,
      linkText: 'hello',
    },
  },
});

const _serverWithRepo = new WebMapServer(client, {
  db: mockDb(),
  configRepo: _configRepo,
});

const _serverNoRepo = new WebMapServer(client, {
  db: mockDb(),
  // no configRepo
});

function getHandler(server: typeof WebMapServer, method: string, routePath: string) {
  return _extractHandler(server._app, method.toLowerCase(), routePath);
}

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/status/modules
// ══════════════════════════════════════════════════════════════════════════════

describe('GET /api/status/modules', () => {
  it('回傳 { modules: {...} } 當有 moduleStatus', async () => {
    const handler = getHandler(_serverWithRepo, 'GET', '/api/status/modules');
    const status = { core: 'running', tracker: 'idle' };
    _serverWithRepo.setModuleStatus(status);

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    assert.equal(res._status, 200);
    assert.deepEqual((res._json as Record<string, unknown>).modules, status);
  });

  it('回傳 { modules: {} } 當沒有 moduleStatus', async () => {
    const server = new WebMapServer(client, { db: mockDb() });
    const handler = getHandler(server, 'GET', '/api/status/modules');

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    assert.equal(res._status, 200);
    assert.deepEqual((res._json as Record<string, unknown>).modules, {});
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/panel/settings-schema
// ══════════════════════════════════════════════════════════════════════════════

describe('GET /api/panel/settings-schema', () => {
  it('回傳 { categories: [...] } 且 categories 非空', async () => {
    const handler = getHandler(_serverWithRepo, 'GET', '/api/panel/settings-schema');

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    assert.equal(res._status, 200);
    assert.ok(Array.isArray((res._json as Record<string, unknown>).categories), 'categories 應為陣列');
    assert.ok(((res._json as Record<string, unknown>).categories as unknown[]).length > 0, 'categories 不應為空');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/panel/servers/:id/auto-messages
// ══════════════════════════════════════════════════════════════════════════════

describe('GET /api/panel/servers/:id/auto-messages', () => {
  it('回傳預設值合併 stored 資料', async () => {
    const handler = getHandler(_serverWithRepo, 'GET', '/api/panel/servers/:id/auto-messages');

    const req = mockReq({ params: { id: 'srv1' } });
    const res = mockRes();
    await handler(req, res);

    assert.equal(res._status, 200);
    assert.equal((res._json as Record<string, unknown>).ok, true);
    // stored 覆蓋 default
    assert.equal((res._json as Record<string, unknown>).enableWelcomeMsg, false);
    assert.equal((res._json as Record<string, unknown>).linkText, 'hello');
    // default 補齊
    assert.equal(typeof (res._json as Record<string, unknown>).enableWelcomeFile, 'boolean');
    assert.equal(typeof (res._json as Record<string, unknown>).enableAutoMsgLink, 'boolean');
  });

  it('回傳預設值當 server 沒有 autoMessages', async () => {
    const repo = mockConfigRepo({
      'server:srv_empty': { id: 'srv_empty', name: 'Empty' },
    });
    const server = new WebMapServer(client, { db: mockDb(), configRepo: repo });
    const handler = getHandler(server, 'GET', '/api/panel/servers/:id/auto-messages');

    const req = mockReq({ params: { id: 'srv_empty' } });
    const res = mockRes();
    await handler(req, res);

    assert.equal(res._status, 200);
    assert.equal((res._json as Record<string, unknown>).ok, true);
    assert.equal((res._json as Record<string, unknown>).enableWelcomeMsg, true);
    assert.equal((res._json as Record<string, unknown>).enableWelcomeFile, false);
    assert.equal((res._json as Record<string, unknown>).enableAutoMsgLink, true);
    assert.equal((res._json as Record<string, unknown>).enableAutoMsgPromo, true);
    assert.equal((res._json as Record<string, unknown>).linkText, '');
  });

  it('回傳 503 當 configRepo 為 null', async () => {
    const handler = getHandler(_serverNoRepo, 'GET', '/api/panel/servers/:id/auto-messages');

    const req = mockReq({ params: { id: 'srv1' } });
    const res = mockRes();
    await handler(req, res);

    assert.equal(res._status, 503);
    assert.equal((res._json as Record<string, unknown>).code, API_ERRORS.NO_DATABASE);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// POST /api/panel/servers/:id/auto-messages
// ══════════════════════════════════════════════════════════════════════════════

describe('POST /api/panel/servers/:id/auto-messages', () => {
  it('成功儲存回傳 { ok: true, saved: true, requiresRestart: true }', async () => {
    const repo = mockConfigRepo({
      'server:srv2': { id: 'srv2', name: 'Server 2' },
    });
    const server = new WebMapServer(client, { db: mockDb(), configRepo: repo });
    const handler = getHandler(server, 'POST', '/api/panel/servers/:id/auto-messages');

    const req = mockReq({
      params: { id: 'srv2' },
      body: {
        enableWelcomeMsg: true,
        enableWelcomeFile: false,
        enableAutoMsgLink: true,
        enableAutoMsgPromo: false,
        linkText: 'https://example.com',
        promoText: 'Join now!',
        discordLink: 'https://discord.gg/test',
      },
    });
    const res = mockRes();
    await handler(req, res);

    assert.equal(res._status, 200);
    assert.equal((res._json as Record<string, unknown>).ok, true);
    assert.equal((res._json as Record<string, unknown>).saved, true);
    assert.equal((res._json as Record<string, unknown>).requiresRestart, true);
  });

  it('configRepo 為 null 時回傳 503', async () => {
    const handler = getHandler(_serverNoRepo, 'POST', '/api/panel/servers/:id/auto-messages');

    const req = mockReq({
      params: { id: 'srv1' },
      body: { enableWelcomeMsg: true },
    });
    const res = mockRes();
    await handler(req, res);

    assert.equal(res._status, 503);
    assert.equal((res._json as Record<string, unknown>).code, API_ERRORS.NO_DATABASE);
  });
});

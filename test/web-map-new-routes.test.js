'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// ── Env stubs (must come before any source requires) ──
process.env.DISCORD_TOKEN = 'test';
process.env.DISCORD_CLIENT_ID = '123';
process.env.DISCORD_GUILD_ID = '456';

const { mockDb } = require('./helpers/mock-db');
const { API_ERRORS } = require('../src/web-map/api-errors');
const WebMapServer = require('../src/web-map/server');
const { extractHandler: _extractHandler } = require('./helpers/route-helpers');

// ── Mock configRepo ──────────────────────────────────────────────────────────

function mockConfigRepo(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    get(key) {
      return store.get(key) || null;
    },
    set(key, value) {
      store.set(key, value);
    },
    update(key, patch) {
      const existing = store.get(key) || {};
      store.set(key, { ...existing, ...patch });
    },
    delete(key) {
      store.delete(key);
    },
    loadAll() {
      const entries = [];
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
  const res = {
    _status: 200,
    _json: null,
    _headers: {},
    status(code) {
      res._status = code;
      return res;
    },
    json(data) {
      res._json = data;
      return res;
    },
    setHeader(k, v) {
      res._headers[k] = v;
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

function mockReq(overrides = {}) {
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

function getHandler(server, method, routePath) {
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
    assert.deepEqual(res._json.modules, status);
  });

  it('回傳 { modules: {} } 當沒有 moduleStatus', async () => {
    const server = new WebMapServer(client, { db: mockDb() });
    const handler = getHandler(server, 'GET', '/api/status/modules');

    const req = mockReq();
    const res = mockRes();
    await handler(req, res);

    assert.equal(res._status, 200);
    assert.deepEqual(res._json.modules, {});
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
    assert.ok(Array.isArray(res._json.categories), 'categories 應為陣列');
    assert.ok(res._json.categories.length > 0, 'categories 不應為空');
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
    assert.equal(res._json.ok, true);
    // stored 覆蓋 default
    assert.equal(res._json.enableWelcomeMsg, false);
    assert.equal(res._json.linkText, 'hello');
    // default 補齊
    assert.equal(typeof res._json.enableWelcomeFile, 'boolean');
    assert.equal(typeof res._json.enableAutoMsgLink, 'boolean');
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
    assert.equal(res._json.ok, true);
    assert.equal(res._json.enableWelcomeMsg, true);
    assert.equal(res._json.enableWelcomeFile, false);
    assert.equal(res._json.enableAutoMsgLink, true);
    assert.equal(res._json.enableAutoMsgPromo, true);
    assert.equal(res._json.linkText, '');
  });

  it('回傳 503 當 configRepo 為 null', async () => {
    const handler = getHandler(_serverNoRepo, 'GET', '/api/panel/servers/:id/auto-messages');

    const req = mockReq({ params: { id: 'srv1' } });
    const res = mockRes();
    await handler(req, res);

    assert.equal(res._status, 503);
    assert.equal(res._json.code, API_ERRORS.NO_DATABASE);
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
    assert.equal(res._json.ok, true);
    assert.equal(res._json.saved, true);
    assert.equal(res._json.requiresRestart, true);
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
    assert.equal(res._json.code, API_ERRORS.NO_DATABASE);
  });
});

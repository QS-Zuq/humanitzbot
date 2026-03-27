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
const { extractHandler: _extractHandler, extractMiddleware: _extractMiddleware } = require('./helpers/route-helpers');

// ── Create WebMapServer instance ────────────────────────────

const client = { channels: { cache: new Map() } };
const _server = new WebMapServer(client, { db: mockDb() });

function getHandler(method, routePath) {
  return _extractHandler(_server._app, method.toLowerCase(), routePath);
}

function getTierMiddleware(method, routePath) {
  return _extractMiddleware(_server._app, method.toLowerCase(), routePath, 0);
}

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
    path: '/api/panel/bot-actions/restart',
    headers: {},
    tier: 'admin',
    tierLevel: 3,
    session: { username: 'TestAdmin' },
    ip: '127.0.0.1',
    ...overrides,
  };
}

// ── Mock BotControlService ──────────────────────────────────

function mockBotControl(overrides = {}) {
  return {
    restart(meta) {
      return { action: 'restart', scheduledAt: '2026-03-26T00:00:00.000Z', ...meta };
    },
    reimport(meta) {
      return { action: 'reimport', scheduledAt: '2026-03-26T00:00:00.000Z', ...meta };
    },
    factoryReset(meta) {
      return { action: 'factory_reset', scheduledAt: '2026-03-26T00:00:00.000Z', ...meta };
    },
    envSync() {
      return { action: 'env_sync', needed: false };
    },
    ...overrides,
  };
}

// ── Shared handler (module-level for use in helpers) ────────
const handler = getHandler('POST', '/api/panel/bot-actions/:action');

/**
 * Shared helper — register tests asserting an action captures meta and returns ok.
 * @param {string} action - Route action name (e.g. 'restart')
 * @param {string} method - BotControlService method name
 * @param {object} [extraReq] - Extra mockReq overrides (e.g. body for factory_reset)
 */
function describeActionCapture(action, method, extraReq = {}) {
  it(`calls botControl.${method} with web source and session username`, async () => {
    let captured = null;
    _server.setBotControl(
      mockBotControl({
        [method](meta) {
          captured = meta;
          return { action, scheduledAt: '2026-03-26T00:00:00.000Z' };
        },
      }),
    );
    const req = mockReq({ params: { action }, ...extraReq });
    const res = mockRes();
    await handler(req, res);
    assert.deepEqual(captured, { source: 'web', user: 'TestAdmin' });
  });

  it(`returns { ok: true, action: "${action}" }`, async () => {
    _server.setBotControl(mockBotControl());
    const req = mockReq({ params: { action }, ...extraReq });
    const res = mockRes();
    await handler(req, res);
    assert.equal(res._json.ok, true);
    assert.equal(res._json.action, action);
  });
}

// ══════════════════════════════════════════════════════════════
// POST /api/panel/bot-actions/:action
// ══════════════════════════════════════════════════════════════

describe('POST /api/panel/bot-actions/:action', () => {
  // ── Auth ────────────────────────────────────────────────────

  describe('auth', () => {
    it('requireTier middleware is set to admin', () => {
      const mw = getTierMiddleware('POST', '/api/panel/bot-actions/:action');
      const req = mockReq({ tier: 'public', tierLevel: 0 });
      const res = mockRes();
      let nextCalled = false;
      mw(req, res, () => {
        nextCalled = true;
      });
      assert.equal(nextCalled, false);
      assert.equal(res._status, 401);
    });

    it('allows admin tier through', () => {
      const mw = getTierMiddleware('POST', '/api/panel/bot-actions/:action');
      const req = mockReq({ tier: 'admin', tierLevel: 3 });
      const res = mockRes();
      let nextCalled = false;
      mw(req, res, () => {
        nextCalled = true;
      });
      assert.equal(nextCalled, true);
    });
  });

  // ── Validation ─────────────────────────────────────────────

  describe('validation', () => {
    it('returns 400 for invalid action', async () => {
      _server.setBotControl(mockBotControl());
      const req = mockReq({ params: { action: 'invalid' } });
      const res = mockRes();
      await handler(req, res);
      assert.equal(res._status, 400);
      assert.equal(res._json.code, API_ERRORS.INVALID_BOT_ACTION);
    });

    it('returns 500 when botControl is not available', async () => {
      _server.setBotControl(null);
      const req = mockReq({ params: { action: 'restart' } });
      const res = mockRes();
      await handler(req, res);
      assert.equal(res._status, 500);
      assert.equal(res._json.code, API_ERRORS.BOT_CONTROL_NOT_AVAILABLE);
    });
  });

  // ── restart ────────────────────────────────────────────────

  describe('restart', () => {
    describeActionCapture('restart', 'restart');
  });

  // ── reimport ───────────────────────────────────────────────

  describe('reimport', () => {
    describeActionCapture('reimport', 'reimport');
  });

  // ── factory_reset ──────────────────────────────────────────

  describe('factory_reset', () => {
    it('returns 400 when confirm !== "NUKE"', async () => {
      _server.setBotControl(mockBotControl());
      const req = mockReq({ params: { action: 'factory_reset' }, body: {} });
      const res = mockRes();
      await handler(req, res);
      assert.equal(res._status, 400);
      assert.equal(res._json.code, API_ERRORS.CONFIRM_NUKE_REQUIRED);
    });

    it('returns 400 when confirm is wrong value', async () => {
      _server.setBotControl(mockBotControl());
      const req = mockReq({ params: { action: 'factory_reset' }, body: { confirm: 'wrong' } });
      const res = mockRes();
      await handler(req, res);
      assert.equal(res._status, 400);
      assert.equal(res._json.code, API_ERRORS.CONFIRM_NUKE_REQUIRED);
    });

    it('calls botControl.factoryReset when confirm === "NUKE"', async () => {
      let captured = null;
      _server.setBotControl(
        mockBotControl({
          factoryReset(meta) {
            captured = meta;
            return { action: 'factory_reset', scheduledAt: '2026-03-26T00:00:00.000Z' };
          },
        }),
      );
      const req = mockReq({ params: { action: 'factory_reset' }, body: { confirm: 'NUKE' } });
      const res = mockRes();
      await handler(req, res);
      assert.deepEqual(captured, { source: 'web', user: 'TestAdmin' });
      assert.equal(res._json.ok, true);
      assert.equal(res._json.action, 'factory_reset');
    });
  });

  // ── env_sync ───────────────────────────────────────────────

  describe('env_sync', () => {
    it('returns { ok: true, needed: false } when not needed', async () => {
      _server.setBotControl(mockBotControl());
      const req = mockReq({ params: { action: 'env_sync' } });
      const res = mockRes();
      await handler(req, res);
      assert.equal(res._json.ok, true);
      assert.equal(res._json.needed, false);
    });

    it('returns { ok: true, needed: true, added, deprecated } when needed', async () => {
      _server.setBotControl(
        mockBotControl({
          envSync() {
            return { action: 'env_sync', needed: true, added: 2, deprecated: 1, currentVer: '4', targetVer: '5' };
          },
        }),
      );
      const req = mockReq({ params: { action: 'env_sync' } });
      const res = mockRes();
      await handler(req, res);
      assert.equal(res._json.ok, true);
      assert.equal(res._json.needed, true);
      assert.equal(res._json.added, 2);
      assert.equal(res._json.deprecated, 1);
    });
  });

  // ── Error handling ─────────────────────────────────────────

  describe('error handling', () => {
    it('returns 409 when another action is already pending', async () => {
      _server.setBotControl(
        mockBotControl({
          restart() {
            const err = new Error('Another action is already pending: factory_reset');
            err.code = 'BOT_ACTION_PENDING';
            throw err;
          },
        }),
      );
      const req = mockReq({ params: { action: 'restart' } });
      const res = mockRes();
      await handler(req, res);
      assert.equal(res._status, 409);
      assert.equal(res._json.code, API_ERRORS.BOT_ACTION_PENDING);
    });

    it('returns 500 for unexpected errors', async () => {
      _server.setBotControl(
        mockBotControl({
          restart() {
            throw new Error('Unexpected filesystem error');
          },
        }),
      );
      const req = mockReq({ params: { action: 'restart' } });
      const res = mockRes();
      await handler(req, res);
      assert.equal(res._status, 500);
      assert.equal(res._json.code, API_ERRORS.INTERNAL_SERVER_ERROR);
    });
  });
});

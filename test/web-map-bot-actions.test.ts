/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-require-imports, @typescript-eslint/no-floating-promises */
'use strict';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { mockDb } = require('./helpers/mock-db');

const { API_ERRORS } = require('../src/web-map/api-errors');

const WebMapServer = require('../src/web-map/server');

const { extractHandler: _extractHandler, extractMiddleware: _extractMiddleware } = require('./helpers/route-helpers');

// ── Create WebMapServer instance ────────────────────────────

const client = { channels: { cache: new Map() } };
const _server = new WebMapServer(client, { db: mockDb() });

function getHandler(method: string, routePath: string) {
  return _extractHandler(_server._app, method.toLowerCase(), routePath);
}

function getTierMiddleware(method: string, routePath: string) {
  return _extractMiddleware(_server._app, method.toLowerCase(), routePath, 0);
}

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

function mockBotControl(overrides: Record<string, unknown> = {}) {
  return {
    restart(meta: unknown) {
      return { action: 'restart', scheduledAt: '2026-03-26T00:00:00.000Z', ...(meta as object) };
    },
    reimport(meta: unknown) {
      return { action: 'reimport', scheduledAt: '2026-03-26T00:00:00.000Z', ...(meta as object) };
    },
    factoryReset(meta: unknown) {
      return { action: 'factory_reset', scheduledAt: '2026-03-26T00:00:00.000Z', ...(meta as object) };
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
 */
function describeActionCapture(action: string, method: string, extraReq: Record<string, unknown> = {}) {
  it(`calls botControl.${method} with web source and session username`, async () => {
    let captured: unknown = null;
    _server.setBotControl(
      mockBotControl({
        [method](meta: unknown) {
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
    assert.equal((res._json as Record<string, unknown>).ok, true);
    assert.equal((res._json as Record<string, unknown>).action, action);
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
      assert.equal((res._json as Record<string, unknown>).code, API_ERRORS.INVALID_BOT_ACTION);
    });

    it('returns 500 when botControl is not available', async () => {
      _server.setBotControl(null);
      const req = mockReq({ params: { action: 'restart' } });
      const res = mockRes();
      await handler(req, res);
      assert.equal(res._status, 500);
      assert.equal((res._json as Record<string, unknown>).code, API_ERRORS.BOT_CONTROL_NOT_AVAILABLE);
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
      assert.equal((res._json as Record<string, unknown>).code, API_ERRORS.CONFIRM_NUKE_REQUIRED);
    });

    it('returns 400 when confirm is wrong value', async () => {
      _server.setBotControl(mockBotControl());
      const req = mockReq({ params: { action: 'factory_reset' }, body: { confirm: 'wrong' } });
      const res = mockRes();
      await handler(req, res);
      assert.equal(res._status, 400);
      assert.equal((res._json as Record<string, unknown>).code, API_ERRORS.CONFIRM_NUKE_REQUIRED);
    });

    it('calls botControl.factoryReset when confirm === "NUKE"', async () => {
      let captured: unknown = null;
      _server.setBotControl(
        mockBotControl({
          factoryReset(meta: unknown) {
            captured = meta;
            return { action: 'factory_reset', scheduledAt: '2026-03-26T00:00:00.000Z' };
          },
        }),
      );
      const req = mockReq({ params: { action: 'factory_reset' }, body: { confirm: 'NUKE' } });
      const res = mockRes();
      await handler(req, res);
      assert.deepEqual(captured, { source: 'web', user: 'TestAdmin' });
      assert.equal((res._json as Record<string, unknown>).ok, true);
      assert.equal((res._json as Record<string, unknown>).action, 'factory_reset');
    });
  });

  // ── env_sync ───────────────────────────────────────────────

  describe('env_sync', () => {
    it('returns { ok: true, needed: false } when not needed', async () => {
      _server.setBotControl(mockBotControl());
      const req = mockReq({ params: { action: 'env_sync' } });
      const res = mockRes();
      await handler(req, res);
      assert.equal((res._json as Record<string, unknown>).ok, true);
      assert.equal((res._json as Record<string, unknown>).needed, false);
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
      assert.equal((res._json as Record<string, unknown>).ok, true);
      assert.equal((res._json as Record<string, unknown>).needed, true);
      assert.equal((res._json as Record<string, unknown>).added, 2);
      assert.equal((res._json as Record<string, unknown>).deprecated, 1);
    });
  });

  // ── Error handling ─────────────────────────────────────────

  describe('error handling', () => {
    it('returns 409 when another action is already pending', async () => {
      _server.setBotControl(
        mockBotControl({
          restart() {
            const err = new Error('Another action is already pending: factory_reset') as Error & { code: string };
            err.code = 'BOT_ACTION_PENDING';
            throw err;
          },
        }),
      );
      const req = mockReq({ params: { action: 'restart' } });
      const res = mockRes();
      await handler(req, res);
      assert.equal(res._status, 409);
      assert.equal((res._json as Record<string, unknown>).code, API_ERRORS.BOT_ACTION_PENDING);
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
      assert.equal((res._json as Record<string, unknown>).code, API_ERRORS.INTERNAL_SERVER_ERROR);
    });
  });
});

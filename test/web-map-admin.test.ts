'use strict';

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import * as _mock_db from './helpers/mock-db.js';
const { mockDb } = _mock_db as any;

import * as _api_errors from '../src/web-map/api-errors.js';
const { API_ERRORS } = _api_errors as any;

import _webMapServer from '../src/web-map/server.js';
const WebMapServer = _webMapServer as any;

import RuntimeConfigApplier from '../src/config/runtime-config-applier.js';
import { registerExternalSourceRuntimeHandlers } from '../src/config/external-source-runtime.js';
import config from '../src/config/index.js';

import * as _route_helpers from './helpers/route-helpers.js';
const { extractHandler: _extractHandler, extractMiddleware: _extractMiddleware } = _route_helpers as any;

// ── Create WebMapServer instance and extract route handlers ────────────────

const client = { channels: { cache: new Map() } };
const _server = new WebMapServer(client, { db: mockDb() });

function getHandler(method: string, routePath: string) {
  return _extractHandler(_server._app, method.toLowerCase(), routePath);
}

function getTierMiddleware(method: string, routePath: string) {
  return _extractMiddleware(_server._app, method.toLowerCase(), routePath, 0);
}

function getHandlerFromServer(server: { _app: unknown }, method: string, routePath: string) {
  return _extractHandler(server._app, method.toLowerCase(), routePath);
}

function mockSrv(overrides: Record<string, unknown> = {}) {
  return {
    serverId: 'primary',
    isPrimary: true,
    db: mockDb({
      extras: {
        chatLog: { insertChat: () => {} },
        antiCheat: { updateAcFlagStatus: () => {} },
        db: {
          prepare: () => ({
            all: () => [],
            get: () => ({ count: 0 }),
          }),
        },
      },
    }),
    rcon: { send: async () => '' },
    config: {
      sftpHost: 'localhost',
      sftpUser: 'user',
      sftpSettingsPath: '/game/settings.ini',
      sftpConnectConfig: () => ({}),
      dockerContainer: 'hzserver',
    },
    panelApi: {
      available: true,
      sendPowerAction: async () => ({}),
      createBackup: async () => ({}),
    },
    scheduler: null,
    dataDir: '/tmp/test-data',
    ...overrides,
  };
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

function mockConfigRepo(initial: Record<string, Record<string, unknown>> = {}) {
  const docs: Record<string, Record<string, unknown>> = {};
  for (const [scope, data] of Object.entries(initial)) {
    docs[scope] = { ...data };
  }

  return {
    docs,
    get(scope: string) {
      return docs[scope];
    },
    set(scope: string, data: Record<string, unknown>) {
      docs[scope] = { ...data };
    },
    update(scope: string, patch: Record<string, unknown>) {
      docs[scope] = { ...(docs[scope] || {}), ...patch };
    },
    delete(scope: string) {
      Reflect.deleteProperty(docs, scope);
    },
    loadAll() {
      return Object.entries(docs).map(([scope, data]) => [scope, { data }] as const);
    },
  };
}

function mockReq(overrides: Record<string, unknown> = {}) {
  return {
    body: {},
    query: {},
    params: {},
    path: '/api/test',
    headers: {},
    tier: 'admin',
    tierLevel: 3,
    session: { username: 'TestAdmin' },
    srv: mockSrv(),
    ip: '127.0.0.1',
    ...overrides,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
//  Tests
// ══════════════════════════════════════════════════════════════════════════════

describe('Web Map Admin — POST endpoints', () => {
  // ── POST /api/admin/kick ──────────────────────────────────────────────────

  describe('POST /api/admin/kick', () => {
    const handler = getHandler('POST', '/api/admin/kick');

    it('requires mod tier', () => {
      const mw = getTierMiddleware('POST', '/api/admin/kick');
      const req = mockReq({ tier: 'public', tierLevel: 0, path: '/api/admin/kick' });
      const res = mockRes();
      let nextCalled = false;
      mw(req, res, () => {
        nextCalled = true;
      });
      assert.equal(nextCalled, false);
      assert.equal(res._status, 401);
    });

    it('allows mod tier through', () => {
      const mw = getTierMiddleware('POST', '/api/admin/kick');
      const req = mockReq({ tier: 'mod', tierLevel: 2, path: '/api/admin/kick' });
      const res = mockRes();
      let nextCalled = false;
      mw(req, res, () => {
        nextCalled = true;
      });
      assert.equal(nextCalled, true);
    });

    it('returns 400 when steamId is missing', async () => {
      const req = mockReq({ body: {} });
      const res = mockRes();
      await handler(req, res);
      assert.equal(res._status, 400);
      assert.equal((res._json as Record<string, unknown>).code, API_ERRORS.MISSING_STEAM_ID);
    });

    it('returns 400 for non-string steamId', async () => {
      const req = mockReq({ body: { steamId: 12345 } });
      const res = mockRes();
      await handler(req, res);
      assert.equal(res._status, 400);
      assert.equal((res._json as Record<string, unknown>).code, API_ERRORS.MISSING_STEAM_ID);
    });

    it('returns 400 for invalid steamId format (not 17 digits)', async () => {
      const req = mockReq({ body: { steamId: '1234' } });
      const res = mockRes();
      await handler(req, res);
      assert.equal(res._status, 400);
      assert.equal((res._json as Record<string, unknown>).code, API_ERRORS.INVALID_STEAM_ID_FORMAT);
    });

    it('returns 400 for steamId with letters', async () => {
      const req = mockReq({ body: { steamId: '7656119800000abc' } });
      const res = mockRes();
      await handler(req, res);
      assert.equal(res._status, 400);
      assert.equal((res._json as Record<string, unknown>).code, API_ERRORS.INVALID_STEAM_ID_FORMAT);
    });

    it('sends correct RCON command on valid steamId', async () => {
      let rconCmd: string | null = null;
      const srv = mockSrv({
        rcon: {
          send: async (cmd: string) => {
            rconCmd = cmd;
            return 'OK';
          },
        },
      });
      const req = mockReq({ body: { steamId: '76561198000000001' }, srv });
      const res = mockRes();
      await handler(req, res);
      assert.equal((res._json as Record<string, unknown>).ok, true);
      assert.equal(rconCmd, 'kick 76561198000000001');
    });

    it('returns 500 when RCON throws', async () => {
      const srv = mockSrv({
        rcon: {
          send: async () => {
            throw new Error('connection lost');
          },
        },
      });
      const req = mockReq({ body: { steamId: '76561198000000001' }, srv });
      const res = mockRes();
      await handler(req, res);
      assert.equal(res._status, 500);
      assert.equal((res._json as Record<string, unknown>).code, API_ERRORS.INTERNAL_SERVER_ERROR);
    });
  });

  // ── POST /api/admin/ban ───────────────────────────────────────────────────

  describe('POST /api/admin/ban', () => {
    const handler = getHandler('POST', '/api/admin/ban');

    it('requires admin tier (not mod)', () => {
      const mw = getTierMiddleware('POST', '/api/admin/ban');
      const req = mockReq({ tier: 'mod', tierLevel: 2, path: '/api/admin/ban' });
      const res = mockRes();
      let nextCalled = false;
      mw(req, res, () => {
        nextCalled = true;
      });
      assert.equal(nextCalled, false);
      assert.equal(res._status, 403);
    });

    it('returns 400 when steamId is missing', async () => {
      const req = mockReq({ body: {} });
      const res = mockRes();
      await handler(req, res);
      assert.equal(res._status, 400);
      assert.equal((res._json as Record<string, unknown>).code, API_ERRORS.MISSING_STEAM_ID);
    });

    it('returns 400 for invalid steamId format', async () => {
      const req = mockReq({ body: { steamId: '123456789012345678' } });
      const res = mockRes();
      await handler(req, res);
      assert.equal(res._status, 400);
      assert.equal((res._json as Record<string, unknown>).code, API_ERRORS.INVALID_STEAM_ID_FORMAT);
    });

    it('sends correct RCON ban command', async () => {
      let rconCmd: string | null = null;
      const srv = mockSrv({
        rcon: {
          send: async (cmd: string) => {
            rconCmd = cmd;
            return 'Banned';
          },
        },
      });
      const req = mockReq({ body: { steamId: '76561198000000001' }, srv });
      const res = mockRes();
      await handler(req, res);
      assert.equal((res._json as Record<string, unknown>).ok, true);
      assert.equal(rconCmd, 'ban 76561198000000001');
    });
  });

  // ── POST /api/admin/message ───────────────────────────────────────────────

  describe('POST /api/admin/message', () => {
    const handler = getHandler('POST', '/api/admin/message');

    it('requires mod tier', () => {
      const mw = getTierMiddleware('POST', '/api/admin/message');
      const req = mockReq({ tier: 'survivor', tierLevel: 1, path: '/api/admin/message' });
      const res = mockRes();
      let nextCalled = false;
      mw(req, res, () => {
        nextCalled = true;
      });
      assert.equal(nextCalled, false);
      assert.equal(res._status, 403);
    });

    it('returns 400 when message is missing', async () => {
      const req = mockReq({ body: {} });
      const res = mockRes();
      await handler(req, res);
      assert.equal(res._status, 400);
      assert.equal((res._json as Record<string, unknown>).code, API_ERRORS.MISSING_MESSAGE);
    });

    it('returns 400 when message is not a string', async () => {
      const req = mockReq({ body: { message: 42 } });
      const res = mockRes();
      await handler(req, res);
      assert.equal(res._status, 400);
      assert.equal((res._json as Record<string, unknown>).code, API_ERRORS.MISSING_MESSAGE);
    });

    it('returns 400 when message exceeds 500 chars', async () => {
      const req = mockReq({ body: { message: 'x'.repeat(501) } });
      const res = mockRes();
      await handler(req, res);
      assert.equal(res._status, 400);
      assert.equal((res._json as Record<string, unknown>).code, API_ERRORS.MESSAGE_TOO_LONG);
    });

    it('returns 400 when message is empty after sanitization', async () => {
      const req = mockReq({ body: { message: '\x01\x02\x03' } });
      const res = mockRes();
      await handler(req, res);
      assert.equal(res._status, 400);
      assert.equal((res._json as Record<string, unknown>).code, API_ERRORS.MESSAGE_EMPTY_AFTER_SANITIZATION);
    });

    it('sends correct RCON admin message', async () => {
      let rconCmd: string | null = null;
      const srv = mockSrv({
        rcon: {
          send: async (cmd: string) => {
            rconCmd = cmd;
            return '';
          },
        },
      });
      const req = mockReq({ body: { message: 'Hello world' }, srv });
      const res = mockRes();
      await handler(req, res);
      assert.equal((res._json as Record<string, unknown>).ok, true);
      const cmd = rconCmd as unknown as string;
      assert.ok(cmd, 'rconCmd should be set');
      assert.ok(cmd.startsWith('admin '));
      assert.ok(cmd.includes('Hello world'));
    });

    it('logs to DB insertChat when db is available', async () => {
      let chatInserted = false;
      const srv = mockSrv({
        rcon: { send: async () => '' },
      });
      srv.db.chatLog = {
        insertChat: () => {
          chatInserted = true;
        },
      };
      const req = mockReq({ body: { message: 'Test msg' }, srv });
      const res = mockRes();
      await handler(req, res);
      assert.equal(chatInserted, true);
    });
  });

  // ── POST /api/panel/rcon ──────────────────────────────────────────────────

  describe('POST /api/panel/rcon', () => {
    const handler = getHandler('POST', '/api/panel/rcon');

    it('requires admin tier', () => {
      const mw = getTierMiddleware('POST', '/api/panel/rcon');
      const req = mockReq({ tier: 'mod', tierLevel: 2, path: '/api/panel/rcon' });
      const res = mockRes();
      let nextCalled = false;
      mw(req, res, () => {
        nextCalled = true;
      });
      assert.equal(nextCalled, false);
    });

    it('returns 400 when command is missing', async () => {
      const req = mockReq({ body: {} });
      const res = mockRes();
      await handler(req, res);
      assert.equal(res._status, 400);
      assert.equal((res._json as Record<string, unknown>).code, API_ERRORS.MISSING_COMMAND);
    });

    it('returns 400 when command is not a string', async () => {
      const req = mockReq({ body: { command: 123 } });
      const res = mockRes();
      await handler(req, res);
      assert.equal(res._status, 400);
      assert.equal((res._json as Record<string, unknown>).code, API_ERRORS.MISSING_COMMAND);
    });

    it('returns 400 when command exceeds 500 chars', async () => {
      const req = mockReq({ body: { command: 'x'.repeat(501) } });
      const res = mockRes();
      await handler(req, res);
      assert.equal(res._status, 400);
      assert.equal((res._json as Record<string, unknown>).code, API_ERRORS.COMMAND_TOO_LONG);
    });

    it('returns 400 when command is empty after sanitization', async () => {
      const req = mockReq({ body: { command: '\x01\x02' } });
      const res = mockRes();
      await handler(req, res);
      assert.equal(res._status, 400);
      assert.equal((res._json as Record<string, unknown>).code, API_ERRORS.COMMAND_EMPTY_AFTER_SANITIZATION);
    });

    for (const blocked of [
      'exit',
      'quit',
      'shutdown',
      'destroyall',
      'destroy_all',
      'wipe',
      'reset',
      'restartnow',
      'quickrestart',
      'cancelrestart',
    ]) {
      it(`blocks dangerous command: ${blocked}`, async () => {
        const req = mockReq({ body: { command: blocked } });
        const res = mockRes();
        await handler(req, res);
        assert.equal(res._status, 403);
        assert.equal((res._json as Record<string, unknown>).code, API_ERRORS.COMMAND_BLOCKED_FOR_SAFETY);
      });
    }

    it('blocks dangerous command with args (e.g. "shutdown now")', async () => {
      const req = mockReq({ body: { command: 'shutdown now' } });
      const res = mockRes();
      await handler(req, res);
      assert.equal(res._status, 403);
      assert.equal((res._json as Record<string, unknown>).code, API_ERRORS.COMMAND_BLOCKED_FOR_SAFETY);
    });

    it('allows safe RCON commands', async () => {
      let rconCmd: string | null = null;
      const srv = mockSrv({
        rcon: {
          send: async (cmd: string) => {
            rconCmd = cmd;
            return 'response';
          },
        },
      });
      const req = mockReq({ body: { command: 'listplayers' }, srv });
      const res = mockRes();
      await handler(req, res);
      assert.equal((res._json as Record<string, unknown>).ok, true);
      assert.equal(rconCmd, 'listplayers');
    });

    it('strips control chars from command before sending', async () => {
      let rconCmd: string | null = null;
      const srv = mockSrv({
        rcon: {
          send: async (cmd: string) => {
            rconCmd = cmd;
            return '';
          },
        },
      });
      const req = mockReq({ body: { command: 'list\x01players' }, srv });
      const res = mockRes();
      await handler(req, res);
      assert.equal(rconCmd, 'listplayers');
    });
  });

  // ── POST /api/panel/db/query ──────────────────────────────────────────────

  describe('POST /api/panel/db/query', () => {
    const handler = getHandler('POST', '/api/panel/db/query');

    it('requires admin tier', () => {
      const mw = getTierMiddleware('POST', '/api/panel/db/query');
      const req = mockReq({ tier: 'survivor', tierLevel: 1, path: '/api/panel/db/query' });
      const res = mockRes();
      let nextCalled = false;
      mw(req, res, () => {
        nextCalled = true;
      });
      assert.equal(nextCalled, false);
    });

    it('returns 400 when sql is missing', () => {
      const req = mockReq({ body: {} });
      const res = mockRes();
      handler(req, res);
      assert.equal(res._status, 400);
      assert.equal((res._json as Record<string, unknown>).code, API_ERRORS.NO_SQL_PROVIDED);
    });

    it('returns 400 when sql is empty string', () => {
      const req = mockReq({ body: { sql: '   ' } });
      const res = mockRes();
      handler(req, res);
      assert.equal(res._status, 400);
      assert.equal((res._json as Record<string, unknown>).code, API_ERRORS.NO_SQL_PROVIDED);
    });

    it('rejects non-SELECT statements (INSERT)', () => {
      const req = mockReq({ body: { sql: "INSERT INTO players VALUES ('a')" } });
      const res = mockRes();
      handler(req, res);
      assert.equal(res._status, 400);
      assert.equal((res._json as Record<string, unknown>).code, API_ERRORS.ONLY_SELECT_ALLOWED);
    });

    it('rejects non-SELECT statements (DROP)', () => {
      const req = mockReq({ body: { sql: 'DROP TABLE players' } });
      const res = mockRes();
      handler(req, res);
      assert.equal(res._status, 400);
      assert.equal((res._json as Record<string, unknown>).code, API_ERRORS.ONLY_SELECT_ALLOWED);
    });

    it('rejects SELECT with embedded DROP keyword', () => {
      const req = mockReq({ body: { sql: 'SELECT 1; DROP TABLE players' } });
      const res = mockRes();
      handler(req, res);
      assert.equal(res._status, 400);
      assert.equal((res._json as Record<string, unknown>).code, API_ERRORS.QUERY_CONTAINS_DISALLOWED_KEYWORDS);
    });

    it('rejects SELECT with embedded DELETE', () => {
      const req = mockReq({ body: { sql: 'SELECT * FROM (DELETE FROM players)' } });
      const res = mockRes();
      handler(req, res);
      assert.equal(res._status, 400);
      assert.equal((res._json as Record<string, unknown>).code, API_ERRORS.QUERY_CONTAINS_DISALLOWED_KEYWORDS);
    });

    it('rejects SELECT with ATTACH keyword (prevent DB attach injection)', () => {
      const req = mockReq({ body: { sql: "SELECT 1; ATTACH DATABASE '/tmp/evil.db' AS evil" } });
      const res = mockRes();
      handler(req, res);
      assert.equal(res._status, 400);
      assert.equal((res._json as Record<string, unknown>).code, API_ERRORS.QUERY_CONTAINS_DISALLOWED_KEYWORDS);
    });

    it('rejects comment-obfuscated non-SELECT', () => {
      const req = mockReq({ body: { sql: '/* comment */ UPDATE players SET name = "x"' } });
      const res = mockRes();
      handler(req, res);
      assert.equal(res._status, 400);
      assert.equal((res._json as Record<string, unknown>).code, API_ERRORS.ONLY_SELECT_ALLOWED);
    });

    it('executes valid SELECT query and returns rows', () => {
      const mockRows = [{ id: 1, name: 'Alice' }];
      const srv = mockSrv();
      srv.db.db = {
        prepare: () => ({
          all: () => mockRows,
        }),
      };
      const req = mockReq({ body: { sql: 'SELECT * FROM players' }, srv });
      const res = mockRes();
      handler(req, res);
      assert.deepEqual((res._json as Record<string, unknown>).rows, mockRows);
      assert.deepEqual((res._json as Record<string, unknown>).columns, ['id', 'name']);
      assert.equal((res._json as Record<string, unknown>).count, 1);
    });

    it('returns error when db is not available', () => {
      const srv = mockSrv({ db: null });
      const req = mockReq({ body: { sql: 'SELECT 1' }, srv });
      const res = mockRes();
      handler(req, res);
      assert.equal((res._json as Record<string, unknown>).ok, false);
      assert.equal((res._json as Record<string, unknown>).code, API_ERRORS.NO_DATABASE);
    });
  });

  // ── POST /api/panel/power ─────────────────────────────────────────────────

  describe('POST /api/panel/power', () => {
    const handler = getHandler('POST', '/api/panel/power');

    it('requires admin tier', () => {
      const mw = getTierMiddleware('POST', '/api/panel/power');
      const req = mockReq({ tier: 'mod', tierLevel: 2, path: '/api/panel/power' });
      const res = mockRes();
      let nextCalled = false;
      mw(req, res, () => {
        nextCalled = true;
      });
      assert.equal(nextCalled, false);
    });

    it('returns 400 for invalid action', async () => {
      const req = mockReq({ body: { action: 'destroy' } });
      const res = mockRes();
      await handler(req, res);
      assert.equal(res._status, 400);
      assert.equal((res._json as Record<string, unknown>).code, API_ERRORS.INVALID_ACTION);
    });

    it('accepts valid power actions via panel API', async () => {
      for (const action of ['start', 'stop', 'restart']) {
        let sentAction: string | null = null;
        const srv = mockSrv({
          panelApi: {
            available: true,
            sendPowerAction: async (a: string) => {
              sentAction = a;
            },
          },
        });
        const req = mockReq({ body: { action }, srv });
        const res = mockRes();
        await handler(req, res);
        assert.equal((res._json as Record<string, unknown>).ok, true, `action ${action} should succeed`);
        assert.equal(sentAction, action, `should have sent ${action} to panel API`);
      }
    });

    it('handles backup action via panel API', async () => {
      let backupCalled = false;
      const srv = mockSrv({
        panelApi: {
          available: true,
          createBackup: async () => {
            backupCalled = true;
          },
        },
      });
      const req = mockReq({ body: { action: 'backup' }, srv });
      const res = mockRes();
      await handler(req, res);
      assert.equal((res._json as Record<string, unknown>).ok, true);
      assert.equal(backupCalled, true);
    });

    it('returns 500 when panel API throws', async () => {
      const srv = mockSrv({
        panelApi: {
          available: true,
          sendPowerAction: async () => {
            throw new Error('panel down');
          },
        },
      });
      const req = mockReq({ body: { action: 'restart' }, srv });
      const res = mockRes();
      await handler(req, res);
      assert.equal(res._status, 500);
    });
  });

  // ── POST /api/panel/refresh-snapshot ───────────────────────────────────────

  describe('POST /api/panel/refresh-snapshot', () => {
    const handler = getHandler('POST', '/api/panel/refresh-snapshot');

    it('requires mod tier', () => {
      const mw = getTierMiddleware('POST', '/api/panel/refresh-snapshot');
      const req = mockReq({ tier: 'survivor', tierLevel: 1, path: '/api/panel/refresh-snapshot' });
      const res = mockRes();
      let nextCalled = false;
      mw(req, res, () => {
        nextCalled = true;
      });
      assert.equal(nextCalled, false);
    });

    it('returns 503 when save service is not available', async () => {
      const req = mockReq();
      const res = mockRes();
      await handler(req, res);
      assert.equal(res._status, 503);
      assert.equal((res._json as Record<string, unknown>).code, API_ERRORS.SAVE_SERVICE_NOT_AVAILABLE);
    });
  });

  // ── POST /api/panel/settings ──────────────────────────────────────────────

  describe('POST /api/panel/settings', () => {
    const handler = getHandler('POST', '/api/panel/settings');

    it('requires admin tier', () => {
      const mw = getTierMiddleware('POST', '/api/panel/settings');
      const req = mockReq({ tier: 'mod', tierLevel: 2, path: '/api/panel/settings' });
      const res = mockRes();
      let nextCalled = false;
      mw(req, res, () => {
        nextCalled = true;
      });
      assert.equal(nextCalled, false);
    });

    it('returns 400 when settings is missing', async () => {
      const req = mockReq({ body: {} });
      const res = mockRes();
      await handler(req, res);
      assert.equal(res._status, 400);
      assert.equal((res._json as Record<string, unknown>).code, API_ERRORS.MISSING_SETTINGS_OBJECT);
    });

    it('returns 400 when settings is not an object', async () => {
      const req = mockReq({ body: { settings: 'string' } });
      const res = mockRes();
      await handler(req, res);
      assert.equal(res._status, 400);
      assert.equal((res._json as Record<string, unknown>).code, API_ERRORS.MISSING_SETTINGS_OBJECT);
    });

    it('returns 403 when writing to protected key (AdminPass)', async () => {
      const req = mockReq({ body: { settings: { AdminPass: 'hacked' } } });
      const res = mockRes();
      await handler(req, res);
      assert.equal(res._status, 403);
      assert.equal((res._json as Record<string, unknown>).code, API_ERRORS.CANNOT_WRITE_PROTECTED_SETTINGS);
    });

    it('returns 403 when writing to hidden key starting with _', async () => {
      const req = mockReq({ body: { settings: { _internal: 'value' } } });
      const res = mockRes();
      await handler(req, res);
      assert.equal(res._status, 403);
      assert.equal((res._json as Record<string, unknown>).code, API_ERRORS.CANNOT_WRITE_PROTECTED_SETTINGS);
    });

    it('returns 400 when value contains newlines (INI injection)', async () => {
      const req = mockReq({ body: { settings: { ServerName: 'evil\n[Section]' } } });
      const res = mockRes();
      await handler(req, res);
      assert.equal(res._status, 400);
      assert.equal((res._json as Record<string, unknown>).code, API_ERRORS.INVALID_VALUE_CONTAINS_ILLEGAL_CHARACTERS);
    });

    it('returns 400 when value starts with [ (INI section injection)', async () => {
      const req = mockReq({ body: { settings: { ServerName: '[EvilSection]' } } });
      const res = mockRes();
      await handler(req, res);
      assert.equal(res._status, 400);
      assert.equal((res._json as Record<string, unknown>).code, API_ERRORS.INVALID_VALUE_CONTAINS_ILLEGAL_CHARACTERS);
    });

    it('returns 400 when SFTP is not configured', async () => {
      const srv = mockSrv();
      (srv.config as Record<string, unknown>).sftpHost = '';
      (srv.config as Record<string, unknown>).sftpUser = '';
      const req = mockReq({ body: { settings: { ServerName: 'Valid' } }, srv });
      const res = mockRes();
      await handler(req, res);
      assert.equal(res._status, 400);
      assert.equal((res._json as Record<string, unknown>).code, API_ERRORS.SFTP_NOT_CONFIGURED);
    });
  });

  // ── POST /api/panel/bot-config ────────────────────────────────────────────

  describe('POST /api/panel/bot-config', () => {
    const handler = getHandler('POST', '/api/panel/bot-config');
    let savedConfig: Record<string, unknown>;

    beforeEach(() => {
      savedConfig = {
        showVitals: config.showVitals,
        rconHost: config.rconHost,
        rconPort: config.rconPort,
        rconPassword: config.rconPassword,
        enableStatusChannels: config.enableStatusChannels,
        enableServerStatus: config.enableServerStatus,
        enableChatRelay: config.enableChatRelay,
        enablePlayerStats: config.enablePlayerStats,
        serverStatusInterval: config.serverStatusInterval,
        statusCacheTtl: config.statusCacheTtl,
        resourceCacheTtl: config.resourceCacheTtl,
        discordInviteLink: config.discordInviteLink,
        enableAutoMsgLink: config.enableAutoMsgLink,
        autoMsgLinkText: config.autoMsgLinkText,
        enablePvpKillFeed: config.enablePvpKillFeed,
        pvpKillWindow: config.pvpKillWindow,
        deathLoopThreshold: config.deathLoopThreshold,
        botLocale: config.botLocale,
        panelServerUrl: config.panelServerUrl,
        panelApiKey: config.panelApiKey,
        sftpHost: config.sftpHost,
        sftpPort: config.sftpPort,
        sftpUser: config.sftpUser,
        sftpPassword: config.sftpPassword,
        sftpPrivateKeyPath: config.sftpPrivateKeyPath,
        sftpLogPath: config.sftpLogPath,
        sftpConnectLogPath: config.sftpConnectLogPath,
        agentMode: config.agentMode,
        agentTrigger: config.agentTrigger,
        agentNodePath: config.agentNodePath,
        agentRemoteDir: config.agentRemoteDir,
        agentCachePath: config.agentCachePath,
        agentPanelCommand: config.agentPanelCommand,
        savePollInterval: config.savePollInterval,
        agentPollInterval: config.agentPollInterval,
        hzmodServerId: config.hzmodServerId,
        hzmodSocketPath: config.hzmodSocketPath,
        hzmodStatusPath: config.hzmodStatusPath,
      };
      config.showVitals = true;
      config.rconHost = '127.0.0.1';
      config.rconPort = 14541;
      config.rconPassword = 'before-rcon-secret';
      config.enableStatusChannels = true;
      config.enableServerStatus = true;
      config.enableChatRelay = true;
      config.enablePlayerStats = true;
      config.serverStatusInterval = 30_000;
      config.statusCacheTtl = 30_000;
      config.resourceCacheTtl = 30_000;
      config.discordInviteLink = 'https://discord.gg/before';
      config.enableAutoMsgLink = true;
      config.autoMsgLinkText = '';
      config.enablePvpKillFeed = true;
      config.pvpKillWindow = 60_000;
      config.deathLoopThreshold = 3;
      config.botLocale = 'en';
      config.panelServerUrl = 'https://panel.before.test/server/before';
      config.panelApiKey = 'before-secret';
      config.sftpHost = 'old-sftp.example.test';
      config.sftpPort = 2022;
      config.sftpUser = 'old-user';
      config.sftpPassword = 'old-sftp-secret';
      config.sftpPrivateKeyPath = '';
      config.sftpLogPath = '/old/HMZLog.log';
      config.sftpConnectLogPath = '/old/PlayerConnectedLog.txt';
      config.agentMode = 'auto';
      config.agentTrigger = 'auto';
      config.agentNodePath = 'node';
      config.agentRemoteDir = '/old/agent';
      config.agentCachePath = '/old/cache.json';
      config.agentPanelCommand = 'createHZSocket';
      config.savePollInterval = 300_000;
      config.agentPollInterval = 90_000;
      config.hzmodServerId = 'vps_dev';
      config.hzmodSocketPath = '/old/hzmod.sock';
      config.hzmodStatusPath = '/old/status.json';
    });

    afterEach(() => {
      config.showVitals = savedConfig.showVitals as boolean;
      config.rconHost = savedConfig.rconHost as string | undefined;
      config.rconPort = savedConfig.rconPort as number;
      config.rconPassword = savedConfig.rconPassword as string;
      config.enableStatusChannels = savedConfig.enableStatusChannels as boolean;
      config.enableServerStatus = savedConfig.enableServerStatus as boolean;
      config.enableChatRelay = savedConfig.enableChatRelay as boolean;
      config.enablePlayerStats = savedConfig.enablePlayerStats as boolean;
      config.serverStatusInterval = savedConfig.serverStatusInterval as number;
      config.statusCacheTtl = savedConfig.statusCacheTtl as number;
      config.resourceCacheTtl = savedConfig.resourceCacheTtl as number;
      config.discordInviteLink = savedConfig.discordInviteLink as string;
      config.enableAutoMsgLink = savedConfig.enableAutoMsgLink as boolean;
      config.autoMsgLinkText = savedConfig.autoMsgLinkText as string;
      config.enablePvpKillFeed = savedConfig.enablePvpKillFeed as boolean;
      config.pvpKillWindow = savedConfig.pvpKillWindow as number;
      config.deathLoopThreshold = savedConfig.deathLoopThreshold as number;
      config.botLocale = savedConfig.botLocale as string;
      config.panelServerUrl = savedConfig.panelServerUrl as string;
      config.panelApiKey = savedConfig.panelApiKey as string;
      config.sftpHost = savedConfig.sftpHost as string;
      config.sftpPort = savedConfig.sftpPort as number;
      config.sftpUser = savedConfig.sftpUser as string;
      config.sftpPassword = savedConfig.sftpPassword as string;
      config.sftpPrivateKeyPath = savedConfig.sftpPrivateKeyPath as string;
      config.sftpLogPath = savedConfig.sftpLogPath as string;
      config.sftpConnectLogPath = savedConfig.sftpConnectLogPath as string;
      config.agentMode = savedConfig.agentMode as string;
      config.agentTrigger = savedConfig.agentTrigger as string;
      config.agentNodePath = savedConfig.agentNodePath as string;
      config.agentRemoteDir = savedConfig.agentRemoteDir as string;
      config.agentCachePath = savedConfig.agentCachePath as string;
      config.agentPanelCommand = savedConfig.agentPanelCommand as string;
      config.savePollInterval = savedConfig.savePollInterval as number;
      config.agentPollInterval = savedConfig.agentPollInterval as number;
      config.hzmodServerId = savedConfig.hzmodServerId as string;
      config.hzmodSocketPath = savedConfig.hzmodSocketPath as string;
      config.hzmodStatusPath = savedConfig.hzmodStatusPath as string;
    });

    function makePanelCredentialApplier(onInvalidate: () => void): RuntimeConfigApplier {
      const applier = new RuntimeConfigApplier();
      applier.registerConnectionReconnect('PANEL_SERVER_URL', (context) => {
        config.panelServerUrl = context.value as string;
        onInvalidate();
      });
      applier.registerConnectionReconnect('PANEL_API_KEY', (context) => {
        config.panelApiKey = context.value as string;
        onInvalidate();
      });
      return applier;
    }

    function makeBatchApplier(envKeys: string[], onApply: (contexts: Array<Record<string, unknown>>) => void) {
      const applier = new RuntimeConfigApplier();
      applier.registerConnectionReconnectGroup(envKeys, (contexts) => {
        onApply(contexts as unknown as Array<Record<string, unknown>>);
      });
      return applier;
    }

    function makeExternalSourceApplier(options: {
      saveService?: { reconfigure(options: Record<string, unknown>): void } | null;
      reconfigureHzmod?: (next: Record<string, unknown>, previous: Record<string, unknown>) => void | Promise<void>;
    }) {
      const applier = new RuntimeConfigApplier();
      registerExternalSourceRuntimeHandlers({
        runtimeConfigApplier: applier,
        config,
        getSaveService: () => options.saveService as any,
        reconfigureHzmod: options.reconfigureHzmod as any,
      });
      return applier;
    }

    it('requires admin tier', () => {
      const mw = getTierMiddleware('POST', '/api/panel/bot-config');
      const req = mockReq({ tier: 'mod', tierLevel: 2, path: '/api/panel/bot-config' });
      const res = mockRes();
      let nextCalled = false;
      mw(req, res, () => {
        nextCalled = true;
      });
      assert.equal(nextCalled, false);
    });

    it('returns 400 when changes is missing', () => {
      const req = mockReq({ body: {} });
      const res = mockRes();
      handler(req, res);
      assert.equal(res._status, 400);
      assert.equal((res._json as Record<string, unknown>).code, API_ERRORS.MISSING_CHANGES_OBJECT);
    });

    it('returns 400 when changes is an array', () => {
      const req = mockReq({ body: { changes: ['a'] } });
      const res = mockRes();
      handler(req, res);
      assert.equal(res._status, 400);
      assert.equal((res._json as Record<string, unknown>).code, API_ERRORS.MISSING_CHANGES_OBJECT);
    });

    it('returns 403 when modifying read-only key (ENV_SCHEMA_VERSION)', () => {
      const req = mockReq({ body: { changes: { ENV_SCHEMA_VERSION: '99' } } });
      const res = mockRes();
      handler(req, res);
      assert.equal(res._status, 403);
      assert.equal((res._json as Record<string, unknown>).code, API_ERRORS.CANNOT_MODIFY_READ_ONLY_KEYS);
    });

    it('returns 403 when modifying bootstrap-only key (WEB_MAP_SESSION_SECRET)', () => {
      const req = mockReq({ body: { changes: { WEB_MAP_SESSION_SECRET: 'x'.repeat(64) } } });
      const res = mockRes();
      handler(req, res);
      assert.equal(res._status, 403);
      assert.equal((res._json as Record<string, unknown>).code, API_ERRORS.CANNOT_MODIFY_READ_ONLY_KEYS);
    });

    it('returns reload strategy metadata for primary bot-config keys', () => {
      const repo = mockConfigRepo();
      const server = new WebMapServer(client, { db: mockDb(), configRepo: repo });
      const getBotConfigHandler = getHandlerFromServer(server, 'GET', '/api/panel/bot-config');
      const req = mockReq();
      const res = mockRes();

      getBotConfigHandler(req, res);

      const sections = (
        res._json as {
          sections: Array<{
            keys: Array<{
              key: string;
              reloadStrategy?: string;
              reloadStrategyReason?: string;
              readOnly?: boolean;
              sensitive?: boolean;
              value?: string;
            }>;
          }>;
        }
      ).sections;
      const keys = new Map(sections.flatMap((section) => section.keys).map((entry) => [entry.key, entry]));

      assert.equal(keys.get('SHOW_VITALS')?.reloadStrategy, 'live');
      assert.equal(keys.get('ENABLE_STATUS_CHANNELS')?.reloadStrategy, 'module-restart');
      assert.equal(keys.get('SESSION_STORE')?.reloadStrategy, 'bot-restart');
      assert.match(keys.get('SESSION_STORE')?.reloadStrategyReason ?? '', /startup|session/);

      const sessionSecret = keys.get('WEB_MAP_SESSION_SECRET');
      assert.ok(sessionSecret);
      assert.equal(sessionSecret.reloadStrategy, 'bot-restart');
      assert.equal(sessionSecret.readOnly, true);
      assert.equal(sessionSecret.sensitive, true);
      assert.equal(sessionSecret.value, '');
      assert.match(sessionSecret.reloadStrategyReason ?? '', /session signing secret/);
    });

    it('returns 400 when value contains newline', () => {
      const req = mockReq({ body: { changes: { SERVER_NAME: 'line1\nline2' } } });
      const res = mockRes();
      handler(req, res);
      assert.equal(res._status, 400);
      assert.equal((res._json as Record<string, unknown>).code, API_ERRORS.INVALID_VALUE_CONTAINS_NEWLINE);
    });

    it('returns 400 when value exceeds 2000 chars', () => {
      const req = mockReq({ body: { changes: { WELCOME_MSG: 'x'.repeat(2001) } } });
      const res = mockRes();
      handler(req, res);
      assert.equal(res._status, 400);
      assert.equal((res._json as Record<string, unknown>).code, API_ERRORS.VALUE_TOO_LONG);
    });

    it('applies explicit live settings to config memory and DB without restartRequired', async () => {
      const repo = mockConfigRepo();
      const server = new WebMapServer(client, { db: mockDb(), configRepo: repo });
      const liveHandler = getHandlerFromServer(server, 'POST', '/api/panel/bot-config');
      const req = mockReq({ body: { changes: { SHOW_VITALS: 'false' } } });
      const res = mockRes();

      await liveHandler(req, res);

      assert.equal(res._status, 200);
      assert.equal((res._json as Record<string, unknown>).restartRequired, false);
      assert.deepEqual((res._json as Record<string, unknown>).updated, ['SHOW_VITALS']);
      assert.deepEqual((res._json as Record<string, unknown>).appliedLive, ['SHOW_VITALS']);
      assert.deepEqual((res._json as Record<string, unknown>).pendingReconnect, []);
      assert.equal(config.showVitals, false);
      assert.equal(repo.docs.app?.showVitals, false);
    });

    it('keeps connection settings pending and does not mutate active config memory', async () => {
      const repo = mockConfigRepo();
      const server = new WebMapServer(client, { db: mockDb(), configRepo: repo });
      const pendingHandler = getHandlerFromServer(server, 'POST', '/api/panel/bot-config');
      const req = mockReq({ body: { changes: { RCON_HOST: '10.0.0.99' } } });
      const res = mockRes();

      await pendingHandler(req, res);

      assert.equal(res._status, 200);
      assert.equal((res._json as Record<string, unknown>).restartRequired, true);
      assert.deepEqual((res._json as Record<string, unknown>).appliedLive, []);
      assert.deepEqual((res._json as Record<string, unknown>).pendingReconnect, ['RCON_HOST']);
      assert.equal(config.rconHost, '127.0.0.1');
      assert.equal(repo.docs['server:primary']?.rconHost, '10.0.0.99');
    });

    it('applies registered RCON reconnect settings as appliedReconnect without leaking secrets', async () => {
      const repo = mockConfigRepo();
      const applier = makeBatchApplier(['RCON_HOST', 'RCON_PORT', 'RCON_PASSWORD'], (contexts) => {
        for (const context of contexts) {
          (config as unknown as Record<string, unknown>)[String(context.cfgKey)] = context.value;
        }
      });
      const server = new WebMapServer(client, { db: mockDb(), configRepo: repo, runtimeConfigApplier: applier });
      const rconHandler = getHandlerFromServer(server, 'POST', '/api/panel/bot-config');
      const nextSecret = 'new-rcon-secret';
      const req = mockReq({
        body: { changes: { RCON_HOST: '10.0.0.99', RCON_PORT: '14542', RCON_PASSWORD: nextSecret } },
      });
      const res = mockRes();

      await rconHandler(req, res);

      assert.equal(res._status, 200);
      assert.equal((res._json as Record<string, unknown>).restartRequired, false);
      assert.deepEqual((res._json as Record<string, unknown>).appliedReconnect, [
        'RCON_HOST',
        'RCON_PORT',
        'RCON_PASSWORD',
      ]);
      assert.deepEqual((res._json as Record<string, unknown>).pendingReconnect, []);
      assert.equal(config.rconHost, '10.0.0.99');
      assert.equal(config.rconPort, 14542);
      assert.equal(config.rconPassword, nextSecret);
      assert.equal(JSON.stringify(res._json).includes(nextSecret), false);
    });

    it('rejects invalid RCON port values before DB save or runtime reconnect', async () => {
      const repo = mockConfigRepo();
      const applier = makeBatchApplier(['RCON_HOST', 'RCON_PORT'], () => {
        throw new Error('runtime reconnect should not run');
      });
      const server = new WebMapServer(client, { db: mockDb(), configRepo: repo, runtimeConfigApplier: applier });
      const rconHandler = getHandlerFromServer(server, 'POST', '/api/panel/bot-config');
      const req = mockReq({ body: { changes: { RCON_HOST: '10.0.0.99', RCON_PORT: 'not-a-port' } } });
      const res = mockRes();

      await rconHandler(req, res);

      assert.equal(res._status, 400);
      assert.equal((res._json as Record<string, unknown>).code, API_ERRORS.INVALID_BOT_CONFIG_VALUE);
      assert.deepEqual((res._json as Record<string, unknown>).details, {
        key: 'RCON_PORT',
        reason: 'Port must be an integer between 1 and 65535',
      });
      assert.equal(repo.docs['server:primary']?.rconPort, undefined);
      assert.equal(config.rconPort, 14541);
    });

    it('reports RCON reconnect failures as errors without leaking the raw password', async () => {
      const repo = mockConfigRepo();
      const applier = makeBatchApplier(['RCON_HOST', 'RCON_PASSWORD'], () => {
        throw new Error('rcon refused');
      });
      const server = new WebMapServer(client, { db: mockDb(), configRepo: repo, runtimeConfigApplier: applier });
      const rconHandler = getHandlerFromServer(server, 'POST', '/api/panel/bot-config');
      const rawSecret = 'bad-rcon-secret';
      const req = mockReq({ body: { changes: { RCON_HOST: '10.0.0.99', RCON_PASSWORD: rawSecret } } });
      const res = mockRes();

      await rconHandler(req, res);

      assert.equal(res._status, 200);
      assert.equal((res._json as Record<string, unknown>).restartRequired, true);
      assert.deepEqual((res._json as Record<string, unknown>).appliedReconnect, []);
      assert.deepEqual((res._json as Record<string, unknown>).pendingReconnect, []);
      assert.equal(config.rconHost, '127.0.0.1');
      assert.equal(config.rconPassword, 'before-rcon-secret');
      assert.equal(JSON.stringify(res._json).includes(rawSecret), false);
      assert.deepEqual(
        (res._json as { errors: Array<{ key: string; message: string }> }).errors.map((error) => error.key),
        ['RCON_HOST', 'RCON_PASSWORD'],
      );
    });

    it('applies registered SFTP reconnect settings without leaking secrets', async () => {
      const repo = mockConfigRepo();
      const applier = makeBatchApplier(['SFTP_HOST', 'SFTP_PASSWORD', 'SFTP_LOG_PATH'], (contexts) => {
        for (const context of contexts) {
          (config as unknown as Record<string, unknown>)[String(context.cfgKey)] = context.value;
        }
      });
      const server = new WebMapServer(client, { db: mockDb(), configRepo: repo, runtimeConfigApplier: applier });
      const sftpHandler = getHandlerFromServer(server, 'POST', '/api/panel/bot-config');
      const rawSecret = 'new-sftp-secret';
      const req = mockReq({
        body: {
          changes: { SFTP_HOST: 'new-sftp.example.test', SFTP_PASSWORD: rawSecret, SFTP_LOG_PATH: '/new/HMZLog.log' },
        },
      });
      const res = mockRes();

      await sftpHandler(req, res);

      assert.equal(res._status, 200);
      assert.equal((res._json as Record<string, unknown>).restartRequired, false);
      assert.deepEqual((res._json as Record<string, unknown>).appliedReconnect, [
        'SFTP_HOST',
        'SFTP_PASSWORD',
        'SFTP_LOG_PATH',
      ]);
      assert.deepEqual((res._json as Record<string, unknown>).pendingReconnect, []);
      assert.equal(config.sftpHost, 'new-sftp.example.test');
      assert.equal(config.sftpPassword, rawSecret);
      assert.equal(config.sftpLogPath, '/new/HMZLog.log');
      assert.equal(JSON.stringify(res._json).includes(rawSecret), false);
    });

    it('keeps PR8-owned connection keys pending when PR7 handlers are absent', async () => {
      const repo = mockConfigRepo();
      const server = new WebMapServer(client, {
        db: mockDb(),
        configRepo: repo,
        runtimeConfigApplier: new RuntimeConfigApplier(),
      });
      const pendingHandler = getHandlerFromServer(server, 'POST', '/api/panel/bot-config');
      const req = mockReq({
        body: {
          changes: {
            AGENT_MODE: 'agent',
            AGENT_TRIGGER: 'ssh',
            HZMOD_SOCKET_PATH: '/tmp/hzmod.sock',
            PUBLIC_HOST: 'public.example.test',
          },
        },
      });
      const res = mockRes();

      await pendingHandler(req, res);

      assert.equal(res._status, 200);
      assert.deepEqual((res._json as Record<string, unknown>).appliedReconnect, []);
      assert.deepEqual((res._json as Record<string, unknown>).pendingReconnect, [
        'AGENT_MODE',
        'AGENT_TRIGGER',
        'HZMOD_SOCKET_PATH',
        'PUBLIC_HOST',
      ]);
      assert.equal((res._json as Record<string, unknown>).restartRequired, true);
    });

    it('applies registered Agent source reconnect settings without restartRequired', async () => {
      const repo = mockConfigRepo();
      const saveCalls: Record<string, unknown>[] = [];
      const applier = makeExternalSourceApplier({
        saveService: {
          reconfigure(options) {
            saveCalls.push(options);
          },
        },
      });
      const server = new WebMapServer(client, { db: mockDb(), configRepo: repo, runtimeConfigApplier: applier });
      const agentHandler = getHandlerFromServer(server, 'POST', '/api/panel/bot-config');
      const req = mockReq({
        body: {
          changes: {
            AGENT_MODE: 'direct',
            AGENT_TRIGGER: 'panel',
            AGENT_NODE_PATH: '/usr/bin/node',
          },
        },
      });
      const res = mockRes();

      await agentHandler(req, res);

      assert.equal(res._status, 200);
      assert.equal((res._json as Record<string, unknown>).restartRequired, false);
      assert.deepEqual((res._json as Record<string, unknown>).appliedReconnect, [
        'AGENT_MODE',
        'AGENT_TRIGGER',
        'AGENT_NODE_PATH',
      ]);
      assert.deepEqual((res._json as Record<string, unknown>).pendingReconnect, []);
      assert.equal(config.agentMode, 'direct');
      assert.equal(config.agentTrigger, 'panel');
      assert.equal(config.agentNodePath, '/usr/bin/node');
      assert.equal(repo.docs.app?.agentMode, 'direct');
      assert.deepEqual(saveCalls, [
        {
          pollInterval: 300_000,
          agentMode: 'direct',
          agentTrigger: 'panel',
          agentNodePath: '/usr/bin/node',
          agentRemoteDir: '/old/agent',
          agentCachePath: '/old/cache.json',
          agentPanelCommand: 'createHZSocket',
        },
      ]);
    });

    it('reports Agent source reconnect failures while keeping active runtime config old', async () => {
      const repo = mockConfigRepo();
      const applier = makeExternalSourceApplier({
        saveService: {
          reconfigure() {
            throw new Error('save source refused');
          },
        },
      });
      const server = new WebMapServer(client, { db: mockDb(), configRepo: repo, runtimeConfigApplier: applier });
      const agentHandler = getHandlerFromServer(server, 'POST', '/api/panel/bot-config');
      const req = mockReq({ body: { changes: { AGENT_MODE: 'direct', AGENT_TRIGGER: 'panel' } } });
      const res = mockRes();

      await agentHandler(req, res);

      assert.equal(res._status, 200);
      assert.equal((res._json as Record<string, unknown>).restartRequired, true);
      assert.deepEqual((res._json as Record<string, unknown>).appliedReconnect, []);
      assert.deepEqual((res._json as Record<string, unknown>).pendingReconnect, []);
      assert.equal(config.agentMode, 'auto');
      assert.equal(config.agentTrigger, 'auto');
      assert.equal(repo.docs.app?.agentMode, 'direct', 'DB value remains saved for the next restart');
      assert.deepEqual((res._json as { errors: Array<{ key: string; strategy: string; message: string }> }).errors, [
        { key: 'AGENT_MODE', strategy: 'connection-reconnect', message: 'save source refused' },
        { key: 'AGENT_TRIGGER', strategy: 'connection-reconnect', message: 'save source refused' },
      ]);
    });

    it('applies registered HZMod source reconnect settings', async () => {
      const repo = mockConfigRepo();
      const rebinds: Array<{ next: Record<string, unknown>; previous: Record<string, unknown> }> = [];
      const applier = makeExternalSourceApplier({
        reconfigureHzmod(next, previous) {
          rebinds.push({ next, previous });
        },
      });
      const server = new WebMapServer(client, { db: mockDb(), configRepo: repo, runtimeConfigApplier: applier });
      const hzmodHandler = getHandlerFromServer(server, 'POST', '/api/panel/bot-config');
      const req = mockReq({
        body: {
          changes: {
            HZMOD_SERVER_ID: 'vps_live',
            HZMOD_SOCKET_PATH: '/new/hzmod.sock',
            HZMOD_STATUS_PATH: '/new/status.json',
          },
        },
      });
      const res = mockRes();

      await hzmodHandler(req, res);

      assert.equal(res._status, 200);
      assert.equal((res._json as Record<string, unknown>).restartRequired, false);
      assert.deepEqual((res._json as Record<string, unknown>).appliedReconnect, [
        'HZMOD_SERVER_ID',
        'HZMOD_SOCKET_PATH',
        'HZMOD_STATUS_PATH',
      ]);
      assert.equal(config.hzmodServerId, 'vps_live');
      assert.equal(config.hzmodSocketPath, '/new/hzmod.sock');
      assert.equal(config.hzmodStatusPath, '/new/status.json');
      assert.equal(repo.docs.app?.hzmodServerId, 'vps_live');
      assert.equal(rebinds.length, 1);
      assert.equal(rebinds[0]?.previous.hzmodSocketPath, '/old/hzmod.sock');
      assert.equal(rebinds[0].next.hzmodSocketPath, '/new/hzmod.sock');
    });

    it('keeps unrelated reconnect keys pending when mixed with registered PR8 handlers', async () => {
      const repo = mockConfigRepo();
      const applier = makeExternalSourceApplier({ reconfigureHzmod() {} });
      const server = new WebMapServer(client, { db: mockDb(), configRepo: repo, runtimeConfigApplier: applier });
      const mixedHandler = getHandlerFromServer(server, 'POST', '/api/panel/bot-config');
      const req = mockReq({
        body: {
          changes: {
            HZMOD_SOCKET_PATH: '/new/hzmod.sock',
            PUBLIC_HOST: 'public.example.test',
          },
        },
      });
      const res = mockRes();

      await mixedHandler(req, res);

      assert.equal(res._status, 200);
      assert.deepEqual((res._json as Record<string, unknown>).appliedReconnect, ['HZMOD_SOCKET_PATH']);
      assert.deepEqual((res._json as Record<string, unknown>).pendingReconnect, ['PUBLIC_HOST']);
      assert.equal((res._json as Record<string, unknown>).restartRequired, true);
      assert.equal(config.hzmodSocketPath, '/new/hzmod.sock');
      assert.notEqual(config.publicHost, 'public.example.test');
    });

    it('applies registered Panel API URL reconnect settings without restartRequired', async () => {
      const repo = mockConfigRepo();
      let invalidations = 0;
      const applier = makePanelCredentialApplier(() => {
        invalidations += 1;
      });
      const server = new WebMapServer(client, { db: mockDb(), configRepo: repo, runtimeConfigApplier: applier });
      const panelHandler = getHandlerFromServer(server, 'POST', '/api/panel/bot-config');
      const nextUrl = 'https://panel.after.test/server/after';
      const req = mockReq({ body: { changes: { PANEL_SERVER_URL: nextUrl } } });
      const res = mockRes();

      await panelHandler(req, res);

      assert.equal(res._status, 200);
      assert.equal((res._json as Record<string, unknown>).restartRequired, false);
      assert.deepEqual((res._json as Record<string, unknown>).appliedReconnect, ['PANEL_SERVER_URL']);
      assert.deepEqual((res._json as Record<string, unknown>).pendingReconnect, []);
      assert.equal(config.panelServerUrl, nextUrl);
      assert.equal(repo.docs['server:primary']?.panelServerUrl, nextUrl);
      assert.equal(invalidations >= 1, true);
    });

    it('applies registered Panel API key reconnect settings without leaking the raw secret', async () => {
      const repo = mockConfigRepo();
      let invalidations = 0;
      const applier = makePanelCredentialApplier(() => {
        invalidations += 1;
      });
      const server = new WebMapServer(client, { db: mockDb(), configRepo: repo, runtimeConfigApplier: applier });
      const panelHandler = getHandlerFromServer(server, 'POST', '/api/panel/bot-config');
      const nextSecret = 'new-secret-key';
      const req = mockReq({ body: { changes: { PANEL_API_KEY: nextSecret } } });
      const res = mockRes();

      await panelHandler(req, res);

      assert.equal(res._status, 200);
      assert.equal((res._json as Record<string, unknown>).restartRequired, false);
      assert.deepEqual((res._json as Record<string, unknown>).appliedReconnect, ['PANEL_API_KEY']);
      assert.deepEqual((res._json as Record<string, unknown>).pendingReconnect, []);
      assert.equal(config.panelApiKey, nextSecret);
      assert.equal(repo.docs['server:primary']?.panelApiKey, nextSecret);
      assert.equal(invalidations >= 1, true);
      assert.equal(JSON.stringify(res._json).includes(nextSecret), false);
    });

    it('applies both Panel API credentials and keeps their secret response safe', async () => {
      const repo = mockConfigRepo();
      let invalidations = 0;
      const applier = makePanelCredentialApplier(() => {
        invalidations += 1;
      });
      const server = new WebMapServer(client, { db: mockDb(), configRepo: repo, runtimeConfigApplier: applier });
      const panelHandler = getHandlerFromServer(server, 'POST', '/api/panel/bot-config');
      const nextUrl = 'https://panel.after.test/server/after';
      const nextSecret = 'new-secret-key';
      const req = mockReq({ body: { changes: { PANEL_SERVER_URL: nextUrl, PANEL_API_KEY: nextSecret } } });
      const res = mockRes();

      await panelHandler(req, res);

      assert.equal(res._status, 200);
      assert.equal((res._json as Record<string, unknown>).restartRequired, false);
      assert.deepEqual((res._json as Record<string, unknown>).appliedReconnect, ['PANEL_SERVER_URL', 'PANEL_API_KEY']);
      assert.deepEqual((res._json as Record<string, unknown>).pendingReconnect, []);
      assert.equal(config.panelServerUrl, nextUrl);
      assert.equal(config.panelApiKey, nextSecret);
      assert.equal(invalidations >= 1, true);
      assert.equal(JSON.stringify(res._json).includes(nextSecret), false);
    });

    it('reports mixed Panel API reconnect and pending RCON reconnect truthfully', async () => {
      const repo = mockConfigRepo();
      const applier = makePanelCredentialApplier(() => {});
      const server = new WebMapServer(client, { db: mockDb(), configRepo: repo, runtimeConfigApplier: applier });
      const mixedHandler = getHandlerFromServer(server, 'POST', '/api/panel/bot-config');
      const nextUrl = 'https://panel.after.test/server/after';
      const req = mockReq({ body: { changes: { PANEL_SERVER_URL: nextUrl, RCON_HOST: '10.0.0.99' } } });
      const res = mockRes();

      await mixedHandler(req, res);

      assert.equal(res._status, 200);
      assert.equal((res._json as Record<string, unknown>).restartRequired, true);
      assert.deepEqual((res._json as Record<string, unknown>).appliedReconnect, ['PANEL_SERVER_URL']);
      assert.deepEqual((res._json as Record<string, unknown>).pendingReconnect, ['RCON_HOST']);
      assert.equal(config.panelServerUrl, nextUrl);
      assert.equal(config.rconHost, '127.0.0.1');
      assert.match(String((res._json as Record<string, unknown>).message), /applied reconnect/);
      assert.match(String((res._json as Record<string, unknown>).message), /pending reconnect/);
    });

    it('reports Panel API reconnect handler failures as errors without marking the key applied', async () => {
      const repo = mockConfigRepo();
      const applier = new RuntimeConfigApplier();
      applier.registerConnectionReconnect('PANEL_SERVER_URL', () => {
        throw new Error('panel refused');
      });
      const server = new WebMapServer(client, { db: mockDb(), configRepo: repo, runtimeConfigApplier: applier });
      const failingHandler = getHandlerFromServer(server, 'POST', '/api/panel/bot-config');
      const nextUrl = 'https://panel.after.test/server/after';
      const req = mockReq({ body: { changes: { PANEL_SERVER_URL: nextUrl } } });
      const res = mockRes();

      await failingHandler(req, res);

      assert.equal(res._status, 200);
      assert.equal((res._json as Record<string, unknown>).restartRequired, true);
      assert.deepEqual((res._json as Record<string, unknown>).appliedReconnect, []);
      assert.deepEqual((res._json as Record<string, unknown>).pendingReconnect, []);
      const [error] = (res._json as { errors: Array<{ key: string; strategy: string; message: string }> }).errors;
      assert.ok(error);
      assert.equal(error.key, 'PANEL_SERVER_URL');
      assert.equal(error.strategy, 'connection-reconnect');
      assert.equal(error.message, 'panel refused');
      assert.equal(repo.docs['server:primary']?.panelServerUrl, nextUrl);
    });

    it('reports mixed live and pending changes truthfully', async () => {
      const repo = mockConfigRepo();
      const server = new WebMapServer(client, { db: mockDb(), configRepo: repo });
      const mixedHandler = getHandlerFromServer(server, 'POST', '/api/panel/bot-config');
      const req = mockReq({ body: { changes: { SHOW_VITALS: 'false', RCON_HOST: '10.0.0.99' } } });
      const res = mockRes();

      await mixedHandler(req, res);

      assert.equal(res._status, 200);
      assert.equal((res._json as Record<string, unknown>).restartRequired, true);
      assert.deepEqual((res._json as Record<string, unknown>).appliedLive, ['SHOW_VITALS']);
      assert.deepEqual((res._json as Record<string, unknown>).pendingReconnect, ['RCON_HOST']);
      assert.equal(config.showVitals, false);
      assert.equal(config.rconHost, '127.0.0.1');
      assert.match(String((res._json as Record<string, unknown>).message), /pending reconnect/);
    });

    it('applies registered module-reconfigure settings without restartRequired', async () => {
      const repo = mockConfigRepo();
      const applier = new RuntimeConfigApplier();
      const applied: unknown[] = [];
      applier.registerModuleReconfigure('SERVER_STATUS_INTERVAL', (context) => {
        applied.push(context);
        config.serverStatusInterval = context.value as number;
      });
      const server = new WebMapServer(client, { db: mockDb(), configRepo: repo, runtimeConfigApplier: applier });
      const reconfigureHandler = getHandlerFromServer(server, 'POST', '/api/panel/bot-config');
      const req = mockReq({ body: { changes: { SERVER_STATUS_INTERVAL: '45000' } } });
      const res = mockRes();

      await reconfigureHandler(req, res);

      assert.equal(res._status, 200);
      assert.equal((res._json as Record<string, unknown>).restartRequired, false);
      assert.deepEqual((res._json as Record<string, unknown>).appliedModuleReconfigure, ['SERVER_STATUS_INTERVAL']);
      assert.deepEqual((res._json as Record<string, unknown>).pendingModuleReconfigure, []);
      assert.deepEqual(applied, [{ envKey: 'SERVER_STATUS_INTERVAL', cfgKey: 'serverStatusInterval', value: 45_000 }]);
      assert.equal(config.serverStatusInterval, 45_000);
      assert.equal(repo.docs.app?.serverStatusInterval, 45_000);
    });

    it('applies registered PR9 low-risk module-reconfigure settings', async () => {
      const repo = mockConfigRepo();
      const applier = new RuntimeConfigApplier();
      applier.registerModuleReconfigure('DISCORD_INVITE_LINK', (context) => {
        config.discordInviteLink = context.value as string;
      });
      applier.registerModuleReconfigure('ENABLE_AUTO_MSG_LINK', (context) => {
        config.enableAutoMsgLink = context.value as boolean;
      });
      applier.registerModuleReconfigure('AUTO_MSG_LINK_TEXT', (context) => {
        config.autoMsgLinkText = context.value as string;
      });
      applier.registerModuleReconfigure('ENABLE_PVP_KILL_FEED', (context) => {
        config.enablePvpKillFeed = context.value as boolean;
      });
      applier.registerModuleReconfigure('PVP_KILL_WINDOW', (context) => {
        config.pvpKillWindow = context.value as number;
      });
      applier.registerModuleReconfigure('DEATH_LOOP_THRESHOLD', (context) => {
        config.deathLoopThreshold = context.value as number;
      });
      applier.registerModuleReconfigure('STATUS_CACHE_TTL', (context) => {
        config.statusCacheTtl = context.value as number;
      });
      applier.registerModuleReconfigure('RESOURCE_CACHE_TTL', (context) => {
        config.resourceCacheTtl = context.value as number;
      });
      const server = new WebMapServer(client, { db: mockDb(), configRepo: repo, runtimeConfigApplier: applier });
      const reconfigureHandler = getHandlerFromServer(server, 'POST', '/api/panel/bot-config');
      const changes = {
        DISCORD_INVITE_LINK: 'https://discord.gg/after',
        ENABLE_AUTO_MSG_LINK: 'false',
        AUTO_MSG_LINK_TEXT: 'Join us',
        ENABLE_PVP_KILL_FEED: 'false',
        PVP_KILL_WINDOW: '90000',
        DEATH_LOOP_THRESHOLD: '4',
        STATUS_CACHE_TTL: '45000',
        RESOURCE_CACHE_TTL: '60000',
      };
      const req = mockReq({ body: { changes } });
      const res = mockRes();

      await reconfigureHandler(req, res);

      const body = res._json as Record<string, unknown>;
      assert.equal(res._status, 200);
      assert.equal(body.restartRequired, false);
      assert.deepEqual([...(body.appliedModuleReconfigure as string[])].sort(), Object.keys(changes).sort());
      assert.deepEqual(body.pendingModuleReconfigure, []);
      assert.equal(config.discordInviteLink, 'https://discord.gg/after');
      assert.equal(config.enableAutoMsgLink, false);
      assert.equal(config.autoMsgLinkText, 'Join us');
      assert.equal(config.enablePvpKillFeed, false);
      assert.equal(config.pvpKillWindow, 90_000);
      assert.equal(config.deathLoopThreshold, 4);
      assert.equal(config.statusCacheTtl, 45_000);
      assert.equal(config.resourceCacheTtl, 60_000);
      assert.equal(repo.docs.app?.autoMsgLinkText, 'Join us');
    });

    it('applies registered module-restart settings without restartRequired', async () => {
      const repo = mockConfigRepo();
      const applier = new RuntimeConfigApplier();
      const applied: unknown[] = [];
      applier.registerModuleRestart('ENABLE_STATUS_CHANNELS', async (context) => {
        applied.push(context);
        config.enableStatusChannels = context.value as boolean;
      });
      applier.registerModuleRestart('ENABLE_SERVER_STATUS', async (context) => {
        applied.push(context);
        config.enableServerStatus = context.value as boolean;
      });
      applier.registerModuleRestart('ENABLE_PLAYER_STATS', async (context) => {
        applied.push(context);
        config.enablePlayerStats = context.value as boolean;
      });
      const server = new WebMapServer(client, { db: mockDb(), configRepo: repo, runtimeConfigApplier: applier });
      const restartHandler = getHandlerFromServer(server, 'POST', '/api/panel/bot-config');
      const req = mockReq({
        body: {
          changes: {
            ENABLE_STATUS_CHANNELS: 'false',
            ENABLE_SERVER_STATUS: 'false',
            ENABLE_PLAYER_STATS: 'false',
          },
        },
      });
      const res = mockRes();

      await restartHandler(req, res);

      const body = res._json as Record<string, unknown>;
      assert.equal(res._status, 200);
      assert.equal(body.restartRequired, false);
      assert.deepEqual([...(body.appliedModuleRestart as string[])].sort(), [
        'ENABLE_PLAYER_STATS',
        'ENABLE_SERVER_STATUS',
        'ENABLE_STATUS_CHANNELS',
      ]);
      assert.deepEqual(body.pendingModuleRestart, []);
      assert.deepEqual(applied, [
        { envKey: 'ENABLE_STATUS_CHANNELS', cfgKey: 'enableStatusChannels', value: false },
        { envKey: 'ENABLE_SERVER_STATUS', cfgKey: 'enableServerStatus', value: false },
        { envKey: 'ENABLE_PLAYER_STATS', cfgKey: 'enablePlayerStats', value: false },
      ]);
      assert.equal(config.enableStatusChannels, false);
      assert.equal(config.enableServerStatus, false);
      assert.equal(config.enablePlayerStats, false);
      const appDoc = repo.docs.app;
      assert.ok(appDoc);
      assert.equal(appDoc.enableStatusChannels, false);
      assert.equal(appDoc.enableServerStatus, false);
      assert.equal(appDoc.enablePlayerStats, false);
    });

    it('applies connection-reconnect before module-restart settings in the same save', async () => {
      const repo = mockConfigRepo();
      const applier = new RuntimeConfigApplier();
      const events: string[] = [];
      const nextSecret = 'after-reconnect-secret';
      applier.registerConnectionReconnect('PANEL_API_KEY', (context) => {
        events.push(`reconnect:${context.envKey}`);
        config.panelApiKey = context.value as string;
      });
      applier.registerModuleRestart('ENABLE_PLAYER_STATS', async (context) => {
        events.push(`restart:${context.envKey}:${config.panelApiKey}`);
        config.enablePlayerStats = context.value as boolean;
      });
      const server = new WebMapServer(client, { db: mockDb(), configRepo: repo, runtimeConfigApplier: applier });
      const restartHandler = getHandlerFromServer(server, 'POST', '/api/panel/bot-config');
      const req = mockReq({
        body: { changes: { ENABLE_PLAYER_STATS: 'false', PANEL_API_KEY: nextSecret } },
      });
      const res = mockRes();

      await restartHandler(req, res);

      const body = res._json as Record<string, unknown>;
      assert.equal(res._status, 200);
      assert.equal(body.restartRequired, false);
      assert.deepEqual(body.appliedReconnect, ['PANEL_API_KEY']);
      assert.deepEqual(body.appliedModuleRestart, ['ENABLE_PLAYER_STATS']);
      assert.deepEqual(events, ['reconnect:PANEL_API_KEY', `restart:ENABLE_PLAYER_STATS:${nextSecret}`]);
      assert.equal(config.panelApiKey, nextSecret);
      assert.equal(config.enablePlayerStats, false);
      assert.equal(repo.docs['server:primary']?.panelApiKey, nextSecret);
      const appDoc = repo.docs.app;
      assert.ok(appDoc);
      assert.equal(appDoc.enablePlayerStats, false);
    });

    it('keeps module-reconfigure settings pending when no runtime handler is registered', async () => {
      const repo = mockConfigRepo();
      const server = new WebMapServer(client, {
        db: mockDb(),
        configRepo: repo,
        runtimeConfigApplier: new RuntimeConfigApplier(),
      });
      const pendingReconfigureHandler = getHandlerFromServer(server, 'POST', '/api/panel/bot-config');
      const req = mockReq({ body: { changes: { BOT_LOCALE: 'zh-TW' } } });
      const res = mockRes();

      await pendingReconfigureHandler(req, res);

      assert.equal(res._status, 200);
      assert.equal((res._json as Record<string, unknown>).restartRequired, true);
      assert.deepEqual((res._json as Record<string, unknown>).appliedModuleReconfigure, []);
      assert.deepEqual((res._json as Record<string, unknown>).pendingModuleReconfigure, ['BOT_LOCALE']);
      assert.equal(config.botLocale, 'en');
      assert.equal(repo.docs.app?.botLocale, 'zh-TW');
    });

    it('keeps PR9 module-reconfigure settings pending when no runtime owner is registered', async () => {
      const repo = mockConfigRepo();
      const server = new WebMapServer(client, {
        db: mockDb(),
        configRepo: repo,
        runtimeConfigApplier: new RuntimeConfigApplier(),
      });
      const pendingReconfigureHandler = getHandlerFromServer(server, 'POST', '/api/panel/bot-config');
      const req = mockReq({
        body: {
          changes: {
            DISCORD_INVITE_LINK: 'https://discord.gg/pending',
            ENABLE_PVP_KILL_FEED: 'false',
            RESOURCE_CACHE_TTL: '60000',
          },
        },
      });
      const res = mockRes();

      await pendingReconfigureHandler(req, res);

      assert.equal(res._status, 200);
      assert.equal((res._json as Record<string, unknown>).restartRequired, true);
      assert.deepEqual((res._json as Record<string, unknown>).appliedModuleReconfigure, []);
      assert.deepEqual((res._json as Record<string, unknown>).pendingModuleReconfigure, [
        'DISCORD_INVITE_LINK',
        'ENABLE_PVP_KILL_FEED',
        'RESOURCE_CACHE_TTL',
      ]);
      assert.equal(config.discordInviteLink, 'https://discord.gg/before');
      assert.equal(config.enablePvpKillFeed, true);
      assert.equal(config.resourceCacheTtl, 30_000);
      assert.equal(repo.docs.app?.discordInviteLink, 'https://discord.gg/pending');
    });

    it('keeps module-restart settings pending when no runtime owner is registered', async () => {
      const repo = mockConfigRepo();
      const server = new WebMapServer(client, {
        db: mockDb(),
        configRepo: repo,
        runtimeConfigApplier: new RuntimeConfigApplier(),
      });
      const pendingRestartHandler = getHandlerFromServer(server, 'POST', '/api/panel/bot-config');
      const req = mockReq({ body: { changes: { ENABLE_CHAT_RELAY: 'false' } } });
      const res = mockRes();

      await pendingRestartHandler(req, res);

      assert.equal(res._status, 200);
      assert.equal((res._json as Record<string, unknown>).restartRequired, true);
      assert.deepEqual((res._json as Record<string, unknown>).appliedModuleRestart, []);
      assert.deepEqual((res._json as Record<string, unknown>).pendingModuleRestart, ['ENABLE_CHAT_RELAY']);
      assert.equal(config.enableChatRelay, true);
      assert.equal(repo.docs.app?.enableChatRelay, false);
    });

    it('reports module-reconfigure handler failures as errors without marking pending as applied', async () => {
      const repo = mockConfigRepo();
      const applier = new RuntimeConfigApplier();
      applier.registerModuleReconfigure('SERVER_STATUS_INTERVAL', () => {
        throw new Error('timer refused');
      });
      const server = new WebMapServer(client, { db: mockDb(), configRepo: repo, runtimeConfigApplier: applier });
      const failingHandler = getHandlerFromServer(server, 'POST', '/api/panel/bot-config');
      const req = mockReq({ body: { changes: { SERVER_STATUS_INTERVAL: '45000' } } });
      const res = mockRes();

      await failingHandler(req, res);

      assert.equal(res._status, 200);
      assert.equal((res._json as Record<string, unknown>).restartRequired, true);
      assert.deepEqual((res._json as Record<string, unknown>).appliedModuleReconfigure, []);
      assert.deepEqual((res._json as Record<string, unknown>).pendingModuleReconfigure, []);
      const [error] = (res._json as { errors: Array<{ key: string; strategy: string; message: string }> }).errors;
      assert.ok(error);
      assert.equal(error.key, 'SERVER_STATUS_INTERVAL');
      assert.equal(error.strategy, 'module-reconfigure');
      assert.equal(error.message, 'timer refused');
      assert.equal(repo.docs.app?.serverStatusInterval, 45_000);
    });

    it('reports module-restart handler failures as errors without marking pending as applied', async () => {
      const repo = mockConfigRepo();
      const applier = new RuntimeConfigApplier();
      applier.registerModuleRestart('ENABLE_SERVER_STATUS', async () => {
        throw new Error('restart refused');
      });
      const server = new WebMapServer(client, { db: mockDb(), configRepo: repo, runtimeConfigApplier: applier });
      const failingHandler = getHandlerFromServer(server, 'POST', '/api/panel/bot-config');
      const req = mockReq({ body: { changes: { ENABLE_SERVER_STATUS: 'false' } } });
      const res = mockRes();

      await failingHandler(req, res);

      assert.equal(res._status, 200);
      assert.equal((res._json as Record<string, unknown>).restartRequired, true);
      assert.deepEqual((res._json as Record<string, unknown>).appliedModuleRestart, []);
      assert.deepEqual((res._json as Record<string, unknown>).pendingModuleRestart, []);
      const [error] = (res._json as { errors: Array<{ key: string; strategy: string; message: string }> }).errors;
      assert.ok(error);
      assert.equal(error.key, 'ENABLE_SERVER_STATUS');
      assert.equal(error.strategy, 'module-restart');
      assert.equal(error.message, 'restart refused');
      assert.equal(config.enableServerStatus, true);
      assert.equal(repo.docs.app?.enableServerStatus, false);
    });

    it('falls unknown primary settings back to pending bot restart without live apply', async () => {
      const repo = mockConfigRepo();
      const server = new WebMapServer(client, { db: mockDb(), configRepo: repo });
      const unknownHandler = getHandlerFromServer(server, 'POST', '/api/panel/bot-config');
      const req = mockReq({ body: { changes: { FUTURE_SETTING: 'enabled' } } });
      const res = mockRes();

      await unknownHandler(req, res);

      assert.equal(res._status, 200);
      assert.equal((res._json as Record<string, unknown>).restartRequired, true);
      assert.deepEqual((res._json as Record<string, unknown>).appliedLive, []);
      assert.deepEqual((res._json as Record<string, unknown>).pendingBotRestart, ['FUTURE_SETTING']);
      assert.equal(repo.docs.app?.FUTURE_SETTING, 'enabled');
    });

    it('shows pending DB value on primary bot-config GET before active config memory changes', async () => {
      const repo = mockConfigRepo();
      const server = new WebMapServer(client, { db: mockDb(), configRepo: repo });
      const postHandler = getHandlerFromServer(server, 'POST', '/api/panel/bot-config');
      const getBotConfigHandler = getHandlerFromServer(server, 'GET', '/api/panel/bot-config');
      const postReq = mockReq({ body: { changes: { RCON_HOST: '10.0.0.99' } } });
      const postRes = mockRes();

      await postHandler(postReq, postRes);

      const getReq = mockReq();
      const getRes = mockRes();
      getBotConfigHandler(getReq, getRes);

      const sections = (getRes._json as { sections: Array<{ keys: Array<{ key: string; value: string }> }> }).sections;
      const rconHost = sections.flatMap((section) => section.keys).find((entry) => entry.key === 'RCON_HOST');
      assert.equal(rconHost?.value, '10.0.0.99');
      assert.equal(config.rconHost, '127.0.0.1');
    });
  });

  // ── POST /api/panel/scheduler ─────────────────────────────────────────────

  describe('POST /api/panel/scheduler', () => {
    const handler = getHandler('POST', '/api/panel/scheduler');

    it('requires admin tier', async () => {
      const mw = getTierMiddleware('POST', '/api/panel/scheduler');
      const req = mockReq({ tier: 'mod', tierLevel: 2, path: '/api/panel/scheduler' });
      const res = mockRes();
      let nextCalled = false;
      mw(req, res, async () => {
        nextCalled = true;
      });
      assert.equal(nextCalled, false);
    });

    it('returns 400 when restartTimes is missing', async () => {
      const req = mockReq({ body: {} });
      const res = mockRes();
      await handler(req, res);
      assert.equal(res._status, 400);
      assert.equal((res._json as Record<string, unknown>).code, API_ERRORS.RESTART_TIMES_INVALID);
    });

    it('returns 400 when restartTimes is not an array', async () => {
      const req = mockReq({ body: { restartTimes: '08:00' } });
      const res = mockRes();
      await handler(req, res);
      assert.equal(res._status, 400);
      assert.equal((res._json as Record<string, unknown>).code, API_ERRORS.RESTART_TIMES_INVALID);
    });

    it('returns 400 for invalid time format', async () => {
      const req = mockReq({ body: { restartTimes: ['08:00', 'invalid'] } });
      const res = mockRes();
      await handler(req, res);
      assert.equal(res._status, 400);
      assert.equal((res._json as Record<string, unknown>).code, API_ERRORS.INVALID_TIME_FORMAT);
    });
  });

  // ── POST /api/panel/anticheat/flags/:id/review ────────────────────────────

  describe('POST /api/panel/anticheat/flags/:id/review', () => {
    const handler = getHandler('POST', '/api/panel/anticheat/flags/:id/review');

    it('requires admin tier', async () => {
      const mw = getTierMiddleware('POST', '/api/panel/anticheat/flags/:id/review');
      const req = mockReq({ tier: 'mod', tierLevel: 2, path: '/api/panel/anticheat/flags/1/review' });
      const res = mockRes();
      let nextCalled = false;
      mw(req, res, async () => {
        nextCalled = true;
      });
      assert.equal(nextCalled, false);
    });

    it('returns 500 when database is not available', async () => {
      const srv = mockSrv({ db: null });
      const req = mockReq({ params: { id: '1' }, body: { status: 'confirmed' }, srv });
      const res = mockRes();
      await handler(req, res);
      assert.equal(res._status, 500);
      assert.equal((res._json as Record<string, unknown>).code, API_ERRORS.DATABASE_NOT_AVAILABLE);
    });

    it('returns 400 for invalid (non-numeric) flag ID', async () => {
      const req = mockReq({ params: { id: 'abc' }, body: { status: 'confirmed' } });
      const res = mockRes();
      await handler(req, res);
      assert.equal(res._status, 400);
      assert.equal((res._json as Record<string, unknown>).code, API_ERRORS.INVALID_FLAG_ID);
    });

    it('returns 400 for missing status', async () => {
      const req = mockReq({ params: { id: '1' }, body: {} });
      const res = mockRes();
      await handler(req, res);
      assert.equal(res._status, 400);
      assert.equal((res._json as Record<string, unknown>).code, API_ERRORS.INVALID_STATUS);
    });

    it('returns 400 for invalid status value', async () => {
      const req = mockReq({ params: { id: '1' }, body: { status: 'approved' } });
      const res = mockRes();
      await handler(req, res);
      assert.equal(res._status, 400);
      assert.equal((res._json as Record<string, unknown>).code, API_ERRORS.INVALID_STATUS);
    });

    it('accepts "confirmed" status and calls db.updateAcFlagStatus', async () => {
      let updateArgs: unknown[] | null = null;
      const srv = mockSrv();
      srv.db.antiCheat = {
        updateAcFlagStatus: (...args: unknown[]) => {
          updateArgs = args;
        },
      };
      const req = mockReq({ params: { id: '42' }, body: { status: 'confirmed', notes: 'Cheater' }, srv });
      const res = mockRes();
      await handler(req, res);
      assert.equal((res._json as Record<string, unknown>).ok, true);
      assert.equal((res._json as Record<string, unknown>).flagId, 42);
      assert.equal((res._json as Record<string, unknown>).status, 'confirmed');
      assert.deepEqual(updateArgs, [42, 'confirmed', 'TestAdmin', 'Cheater']);
    });

    it('accepts "dismissed" status', async () => {
      const srv = mockSrv();
      srv.db.antiCheat = { updateAcFlagStatus: async () => {} };
      const req = mockReq({ params: { id: '1' }, body: { status: 'dismissed' }, srv });
      const res = mockRes();
      await handler(req, res);
      assert.equal((res._json as Record<string, unknown>).ok, true);
      assert.equal((res._json as Record<string, unknown>).status, 'dismissed');
    });

    it('accepts "whitelisted" status', async () => {
      const srv = mockSrv();
      srv.db.antiCheat = { updateAcFlagStatus: async () => {} };
      const req = mockReq({ params: { id: '1' }, body: { status: 'whitelisted' }, srv });
      const res = mockRes();
      await handler(req, res);
      assert.equal((res._json as Record<string, unknown>).ok, true);
      assert.equal((res._json as Record<string, unknown>).status, 'whitelisted');
    });
  });
});

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-require-imports, @typescript-eslint/no-floating-promises, @typescript-eslint/no-non-null-assertion, @typescript-eslint/require-await */
'use strict';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { mockDb } = require('./helpers/mock-db');

const { API_ERRORS } = require('../src/web-map/api-errors');

const WebMapServer = require('../src/web-map/server');

const { extractHandler: _extractHandler, extractMiddleware: _extractMiddleware } = require('./helpers/route-helpers');

// ── Create WebMapServer instance and extract route handlers ────────────────

const client = { channels: { cache: new Map() } };
const _server = new WebMapServer(client, { db: mockDb() });

function getHandler(method: string, routePath: string) {
  return _extractHandler(_server._app, method.toLowerCase(), routePath);
}

function getTierMiddleware(method: string, routePath: string) {
  return _extractMiddleware(_server._app, method.toLowerCase(), routePath, 0);
}

function mockSrv(overrides: Record<string, unknown> = {}) {
  return {
    serverId: 'primary',
    isPrimary: true,
    db: mockDb({
      extras: {
        insertChat: () => {},
        updateAcFlagStatus: () => {},
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
      assert.ok(rconCmd!.startsWith('admin '));
      assert.ok(rconCmd!.includes('Hello world'));
    });

    it('logs to DB insertChat when db is available', async () => {
      let chatInserted = false;
      const srv = mockSrv({
        rcon: { send: async () => '' },
      });
      srv.db.insertChat = () => {
        chatInserted = true;
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
  });

  // ── POST /api/panel/scheduler ─────────────────────────────────────────────

  describe('POST /api/panel/scheduler', () => {
    const handler = getHandler('POST', '/api/panel/scheduler');

    it('requires admin tier', () => {
      const mw = getTierMiddleware('POST', '/api/panel/scheduler');
      const req = mockReq({ tier: 'mod', tierLevel: 2, path: '/api/panel/scheduler' });
      const res = mockRes();
      let nextCalled = false;
      mw(req, res, () => {
        nextCalled = true;
      });
      assert.equal(nextCalled, false);
    });

    it('returns 400 when restartTimes is missing', () => {
      const req = mockReq({ body: {} });
      const res = mockRes();
      handler(req, res);
      assert.equal(res._status, 400);
      assert.equal((res._json as Record<string, unknown>).code, API_ERRORS.RESTART_TIMES_INVALID);
    });

    it('returns 400 when restartTimes is not an array', () => {
      const req = mockReq({ body: { restartTimes: '08:00' } });
      const res = mockRes();
      handler(req, res);
      assert.equal(res._status, 400);
      assert.equal((res._json as Record<string, unknown>).code, API_ERRORS.RESTART_TIMES_INVALID);
    });

    it('returns 400 for invalid time format', () => {
      const req = mockReq({ body: { restartTimes: ['08:00', 'invalid'] } });
      const res = mockRes();
      handler(req, res);
      assert.equal(res._status, 400);
      assert.equal((res._json as Record<string, unknown>).code, API_ERRORS.INVALID_TIME_FORMAT);
    });
  });

  // ── POST /api/panel/anticheat/flags/:id/review ────────────────────────────

  describe('POST /api/panel/anticheat/flags/:id/review', () => {
    const handler = getHandler('POST', '/api/panel/anticheat/flags/:id/review');

    it('requires admin tier', () => {
      const mw = getTierMiddleware('POST', '/api/panel/anticheat/flags/:id/review');
      const req = mockReq({ tier: 'mod', tierLevel: 2, path: '/api/panel/anticheat/flags/1/review' });
      const res = mockRes();
      let nextCalled = false;
      mw(req, res, () => {
        nextCalled = true;
      });
      assert.equal(nextCalled, false);
    });

    it('returns 500 when database is not available', () => {
      const srv = mockSrv({ db: null });
      const req = mockReq({ params: { id: '1' }, body: { status: 'confirmed' }, srv });
      const res = mockRes();
      handler(req, res);
      assert.equal(res._status, 500);
      assert.equal((res._json as Record<string, unknown>).code, API_ERRORS.DATABASE_NOT_AVAILABLE);
    });

    it('returns 400 for invalid (non-numeric) flag ID', () => {
      const req = mockReq({ params: { id: 'abc' }, body: { status: 'confirmed' } });
      const res = mockRes();
      handler(req, res);
      assert.equal(res._status, 400);
      assert.equal((res._json as Record<string, unknown>).code, API_ERRORS.INVALID_FLAG_ID);
    });

    it('returns 400 for missing status', () => {
      const req = mockReq({ params: { id: '1' }, body: {} });
      const res = mockRes();
      handler(req, res);
      assert.equal(res._status, 400);
      assert.equal((res._json as Record<string, unknown>).code, API_ERRORS.INVALID_STATUS);
    });

    it('returns 400 for invalid status value', () => {
      const req = mockReq({ params: { id: '1' }, body: { status: 'approved' } });
      const res = mockRes();
      handler(req, res);
      assert.equal(res._status, 400);
      assert.equal((res._json as Record<string, unknown>).code, API_ERRORS.INVALID_STATUS);
    });

    it('accepts "confirmed" status and calls db.updateAcFlagStatus', () => {
      let updateArgs: unknown[] | null = null;
      const srv = mockSrv();
      srv.db.updateAcFlagStatus = (...args: unknown[]) => {
        updateArgs = args;
      };
      const req = mockReq({ params: { id: '42' }, body: { status: 'confirmed', notes: 'Cheater' }, srv });
      const res = mockRes();
      handler(req, res);
      assert.equal((res._json as Record<string, unknown>).ok, true);
      assert.equal((res._json as Record<string, unknown>).flagId, 42);
      assert.equal((res._json as Record<string, unknown>).status, 'confirmed');
      assert.deepEqual(updateArgs, [42, 'confirmed', 'TestAdmin', 'Cheater']);
    });

    it('accepts "dismissed" status', () => {
      const srv = mockSrv();
      srv.db.updateAcFlagStatus = () => {};
      const req = mockReq({ params: { id: '1' }, body: { status: 'dismissed' }, srv });
      const res = mockRes();
      handler(req, res);
      assert.equal((res._json as Record<string, unknown>).ok, true);
      assert.equal((res._json as Record<string, unknown>).status, 'dismissed');
    });

    it('accepts "whitelisted" status', () => {
      const srv = mockSrv();
      srv.db.updateAcFlagStatus = () => {};
      const req = mockReq({ params: { id: '1' }, body: { status: 'whitelisted' }, srv });
      const res = mockRes();
      handler(req, res);
      assert.equal((res._json as Record<string, unknown>).ok, true);
      assert.equal((res._json as Record<string, unknown>).status, 'whitelisted');
    });
  });
});

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-floating-promises, @typescript-eslint/require-await, @typescript-eslint/no-unnecessary-type-assertion */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import * as _mock_db from './helpers/mock-db.js';
const { mockDb } = _mock_db as any;

import * as _api_errors from '../src/web-map/api-errors.js';
const { API_ERRORS } = _api_errors as any;

import _webMapServer from '../src/web-map/server.js';
const WebMapServer = _webMapServer as any;

import * as _route_helpers from './helpers/route-helpers.js';
const { extractHandler: _extractHandler, extractMiddleware: _extractMiddleware } = _route_helpers as any;

// ── Mock configRepo ─────────────────────────────────────────────────────────

function mockConfigRepo(initial: Record<string, any> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    get(key: string) {
      return store.get(key) || null;
    },
    set(key: string, value: any) {
      store.set(key, value);
    },
    update(key: string, patch: any) {
      const existing = store.get(key) || {};
      store.set(key, { ...existing, ...patch });
    },
    delete(key: string) {
      store.delete(key);
    },
    loadAll() {
      const entries: any[] = [];
      for (const [scope, data] of store) {
        entries.push([scope, { data }]);
      }
      return entries;
    },
    _store: store,
  };
}

// ── Create WebMapServer instance ────────────────────────────────────────────

const client = { channels: { cache: new Map() } };

const _configRepo = mockConfigRepo({
  'server:srv_test1': {
    id: 'srv_test1',
    name: 'Test Server 1',
    enabled: true,
    rcon: { host: '10.0.0.1', port: 14541, password: 'test-rcon-not-real' },
    sftp: { host: '10.0.0.1', port: 22, user: 'admin', password: 'test-sftp-not-real' },
  },
  'server:srv_test2': {
    id: 'srv_test2',
    name: 'Test Server 2',
    enabled: false,
    rcon: { host: '10.0.0.2', port: 14541, password: 'test-pw2-not-real' },
  },
});

const _server = new WebMapServer(client, {
  db: mockDb(),
  configRepo: _configRepo,
});

// ── Helpers ─────────────────────────────────────────────────────────────────

function getHandler(method: string, routePath: string) {
  return _extractHandler(_server._app, method.toLowerCase(), routePath);
}

function getTierMiddleware(method: string, routePath: string) {
  return _extractMiddleware(_server._app, method.toLowerCase(), routePath, 0);
}

function mockRes() {
  const res: any = {
    _status: 200,
    _json: null,
    _headers: {} as Record<string, any>,
    status(code: number) {
      res._status = code;
      return res;
    },
    json(data: any) {
      res._json = data;
      return res;
    },
    setHeader(k: string, v: any) {
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

function mockReq(overrides: Record<string, any> = {}) {
  return {
    body: {},
    query: {},
    params: {},
    path: '/api/test',
    headers: {},
    tier: 'admin',
    tierLevel: 3,
    session: { username: 'TestAdmin' },
    ip: '127.0.0.1',
    ...overrides,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
//  Tests
// ══════════════════════════════════════════════════════════════════════════════

// ── GET /api/panel/servers ──────────────────────────────────────────────────

describe('Multi-Server API — GET /api/panel/servers', () => {
  const handler = getHandler('GET', '/api/panel/servers');

  it('requires admin tier', () => {
    const mw = getTierMiddleware('GET', '/api/panel/servers');
    const req = mockReq({ tier: 'mod', tierLevel: 2, path: '/api/panel/servers' });
    const res = mockRes();
    let nextCalled = false;
    mw(req, res, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, false);
    assert.equal(res._status, 403);
  });

  it('allows admin tier through', () => {
    const mw = getTierMiddleware('GET', '/api/panel/servers');
    const req = mockReq({ tier: 'admin', tierLevel: 3, path: '/api/panel/servers' });
    const res = mockRes();
    let nextCalled = false;
    mw(req, res, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, true);
  });

  it('returns 200 with servers array', () => {
    const req = mockReq();
    const res = mockRes();
    handler.call(_server, req, res);
    assert.equal(res._status, 200);
    assert.ok(res._json.ok);
    assert.ok(Array.isArray(res._json.servers));
  });

  it('includes primary server', () => {
    const req = mockReq();
    const res = mockRes();
    handler.call(_server, req, res);
    const primary = res._json.servers.find((s: any) => s.id === 'primary');
    assert.ok(primary, 'should include primary server');
    assert.equal(primary.isPrimary, true);
    assert.equal(primary.enabled, true);
  });

  it('includes managed servers', () => {
    const req = mockReq();
    const res = mockRes();
    handler.call(_server, req, res);
    const managed = res._json.servers.filter((s: any) => !s.isPrimary);
    assert.ok(managed.length >= 2, 'should have at least 2 managed servers');
    const srv1 = managed.find((s: any) => s.id === 'srv_test1');
    assert.ok(srv1, 'should include srv_test1');
    assert.equal(srv1.name, 'Test Server 1');
  });

  it('does not expose raw passwords in server list', () => {
    const req = mockReq();
    const res = mockRes();
    handler.call(_server, req, res);
    for (const srv of res._json.servers) {
      if ((srv as any).rcon?.password) {
        assert.notEqual(
          typeof (srv as any).rcon.password,
          'string',
          `${(srv as any).id} rcon password should not be plain string`,
        );
      }
    }
  });

  it('has status field for each server', () => {
    const req = mockReq();
    const res = mockRes();
    handler.call(_server, req, res);
    for (const srv of res._json.servers) {
      assert.ok('status' in (srv as any), `${(srv as any).id} should have status`);
    }
  });

  it('has players field for each server', () => {
    const req = mockReq();
    const res = mockRes();
    handler.call(_server, req, res);
    for (const srv of res._json.servers) {
      assert.ok('players' in (srv as any), `${(srv as any).id} should have players`);
      assert.ok('current' in (srv as any).players, `${(srv as any).id} should have players.current`);
    }
  });
});

// ── POST /api/panel/servers ─────────────────────────────────────────────────

describe('Multi-Server API — POST /api/panel/servers', () => {
  const handler = getHandler('POST', '/api/panel/servers');

  it('requires admin tier', () => {
    const mw = getTierMiddleware('POST', '/api/panel/servers');
    const req = mockReq({ tier: 'mod', tierLevel: 2, path: '/api/panel/servers' });
    const res = mockRes();
    let nextCalled = false;
    mw(req, res, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, false);
    assert.equal(res._status, 403);
  });

  it('returns 400 when name is missing', async () => {
    const req = mockReq({ body: { rcon: { host: 'h', port: 1234, password: 'test-p-not-real' } } });
    const res = mockRes();
    await handler.call(_server, req, res);
    assert.equal(res._status, 400);
    assert.equal(res._json.code, API_ERRORS.MISSING_SERVER_NAME);
  });

  it('returns 400 when name is empty string', async () => {
    const req = mockReq({ body: { name: '   ', rcon: { host: 'h', port: 1234, password: 'test-p-not-real' } } });
    const res = mockRes();
    await handler.call(_server, req, res);
    assert.equal(res._status, 400);
    assert.equal(res._json.code, API_ERRORS.MISSING_SERVER_NAME);
  });

  it('returns 400 when name is not a string', async () => {
    const req = mockReq({ body: { name: 42, rcon: { host: 'h', port: 1234, password: 'test-p-not-real' } } });
    const res = mockRes();
    await handler.call(_server, req, res);
    assert.equal(res._status, 400);
    assert.equal(res._json.code, API_ERRORS.MISSING_SERVER_NAME);
  });

  it('returns 400 when rcon config is missing', async () => {
    const req = mockReq({ body: { name: 'New Server' } });
    const res = mockRes();
    await handler.call(_server, req, res);
    assert.equal(res._status, 400);
    assert.equal(res._json.code, API_ERRORS.MISSING_RCON_CONFIG);
  });

  it('returns 400 when rcon host is missing', async () => {
    const req = mockReq({ body: { name: 'New Server', rcon: { port: 14541, password: 'test-p-not-real' } } });
    const res = mockRes();
    await handler.call(_server, req, res);
    assert.equal(res._status, 400);
    assert.equal(res._json.code, API_ERRORS.MISSING_RCON_CONFIG);
  });

  it('returns 400 when rcon password is missing', async () => {
    const req = mockReq({ body: { name: 'New Server', rcon: { host: 'h', port: 14541 } } });
    const res = mockRes();
    await handler.call(_server, req, res);
    assert.equal(res._status, 400);
    assert.equal(res._json.code, API_ERRORS.MISSING_RCON_CONFIG);
  });

  it('returns 409 when name already exists', async () => {
    const req = mockReq({
      body: { name: 'Test Server 1', rcon: { host: 'h', port: 14541, password: 'test-p-not-real' } },
    });
    const res = mockRes();
    await handler.call(_server, req, res);
    assert.equal(res._status, 409);
    assert.equal(res._json.code, API_ERRORS.SERVER_NAME_EXISTS);
  });

  it('creates server with valid body and returns 201', async () => {
    const req = mockReq({
      body: { name: 'Brand New Server', rcon: { host: '10.0.0.99', port: 14541, password: 'test-pw-not-real' } },
    });
    const res = mockRes();
    await handler.call(_server, req, res);
    assert.equal(res._status, 201);
    assert.ok(res._json.ok);
    assert.ok(res._json.server.id, 'should return server id');
    assert.equal(res._json.server.name, 'Brand New Server');
    // Cleanup created server from configRepo
    _configRepo.delete(`server:${res._json.server.id}`);
  });

  it('stores server definition in configRepo', async () => {
    const req = mockReq({
      body: { name: 'Stored Server', rcon: { host: '10.0.0.50', port: 14541, password: 'test-pw-not-real' } },
    });
    const res = mockRes();
    await handler.call(_server, req, res);
    const id = res._json.server.id;
    const stored = _configRepo.get(`server:${id}`);
    assert.ok(stored, 'should be stored in configRepo');
    assert.equal(stored.name, 'Stored Server');
    assert.equal(stored.rcon.host, '10.0.0.50');
    // Cleanup
    _configRepo.delete(`server:${id}`);
  });

  it('includes SFTP config when provided', async () => {
    const req = mockReq({
      body: {
        name: 'SFTP Server',
        rcon: { host: 'h', port: 14541, password: 'test-p-not-real' },
        sftp: { host: '10.0.0.77', port: 2222, user: 'deploy', password: 'test-sftp-not-real' },
      },
    });
    const res = mockRes();
    await handler.call(_server, req, res);
    const id = res._json.server.id;
    const stored = _configRepo.get(`server:${id}`);
    assert.ok(stored.sftp, 'should have sftp config');
    assert.equal(stored.sftp.host, '10.0.0.77');
    assert.equal(stored.sftp.port, 2222);
    // Cleanup
    _configRepo.delete(`server:${id}`);
  });
});

// ── GET /api/panel/servers/:id ──────────────────────────────────────────────

describe('Multi-Server API — GET /api/panel/servers/:id', () => {
  const handler = getHandler('GET', '/api/panel/servers/:id');

  it('requires admin tier', () => {
    const mw = getTierMiddleware('GET', '/api/panel/servers/:id');
    const req = mockReq({ tier: 'survivor', tierLevel: 1, path: '/api/panel/servers/primary' });
    const res = mockRes();
    let nextCalled = false;
    mw(req, res, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, false);
  });

  it('returns primary server detail when id is "primary"', () => {
    const req = mockReq({ params: { id: 'primary' } });
    const res = mockRes();
    handler.call(_server, req, res);
    assert.equal(res._status, 200);
    assert.ok(res._json.ok);
    assert.equal(res._json.server.id, 'primary');
    assert.equal(res._json.server.isPrimary, true);
  });

  it('masks rcon password for primary server', () => {
    const req = mockReq({ params: { id: 'primary' } });
    const res = mockRes();
    handler.call(_server, req, res);
    const srv = res._json.server;
    assert.ok(typeof srv.rcon.password === 'object', 'rcon password should be masked object');
    assert.ok('hasValue' in srv.rcon.password, 'rcon password should have hasValue');
  });

  it('masks sftp password for primary server', () => {
    const req = mockReq({ params: { id: 'primary' } });
    const res = mockRes();
    handler.call(_server, req, res);
    const srv = res._json.server;
    assert.ok(typeof srv.sftp.password === 'object', 'sftp password should be masked object');
    assert.ok('hasValue' in srv.sftp.password, 'sftp password should have hasValue');
  });

  it('returns managed server detail', () => {
    const req = mockReq({ params: { id: 'srv_test1' } });
    const res = mockRes();
    handler.call(_server, req, res);
    assert.equal(res._status, 200);
    assert.ok(res._json.ok);
    assert.ok(res._json.server, 'should return server object');
  });

  it('masks rcon password for managed server', () => {
    const req = mockReq({ params: { id: 'srv_test1' } });
    const res = mockRes();
    handler.call(_server, req, res);
    const srv = res._json.server;
    assert.ok(typeof srv.rcon.password === 'object', 'rcon password should be masked');
    assert.ok('hasValue' in srv.rcon.password);
    assert.equal(srv.rcon.password.hasValue, true);
  });

  it('masks sftp password for managed server', () => {
    const req = mockReq({ params: { id: 'srv_test1' } });
    const res = mockRes();
    handler.call(_server, req, res);
    const srv = res._json.server;
    assert.ok(typeof srv.sftp.password === 'object', 'sftp password should be masked');
    assert.equal(srv.sftp.password.hasValue, true);
  });

  it('returns 404 for non-existent server', () => {
    const req = mockReq({ params: { id: 'srv_does_not_exist' } });
    const res = mockRes();
    handler.call(_server, req, res);
    assert.equal(res._status, 404);
    assert.equal(res._json.code, API_ERRORS.SERVER_NOT_FOUND);
  });

  it('includes status field', () => {
    const req = mockReq({ params: { id: 'primary' } });
    const res = mockRes();
    handler.call(_server, req, res);
    assert.ok('status' in res._json.server, 'should have status field');
  });

  it('includes players field', () => {
    const req = mockReq({ params: { id: 'primary' } });
    const res = mockRes();
    handler.call(_server, req, res);
    assert.ok('players' in res._json.server, 'should have players field');
    assert.ok('current' in res._json.server.players);
  });
});

// ── PATCH /api/panel/servers/:id ────────────────────────────────────────────

describe('Multi-Server API — PATCH /api/panel/servers/:id', () => {
  const handler = getHandler('PATCH', '/api/panel/servers/:id');

  it('requires admin tier', () => {
    const mw = getTierMiddleware('PATCH', '/api/panel/servers/:id');
    const req = mockReq({ tier: 'mod', tierLevel: 2, path: '/api/panel/servers/primary' });
    const res = mockRes();
    let nextCalled = false;
    mw(req, res, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, false);
    assert.equal(res._status, 403);
  });

  it('returns 400 when body is not an object', async () => {
    const req = mockReq({ params: { id: 'srv_test1' }, body: null });
    const res = mockRes();
    await handler.call(_server, req, res);
    assert.equal(res._status, 400);
    assert.equal(res._json.code, API_ERRORS.MISSING_CHANGES_OBJECT);
  });

  it('returns 404 for non-existent managed server', async () => {
    const req = mockReq({ params: { id: 'srv_nonexistent' }, body: { name: 'X' } });
    const res = mockRes();
    await handler.call(_server, req, res);
    assert.equal(res._status, 404);
    assert.equal(res._json.code, API_ERRORS.SERVER_NOT_FOUND);
  });

  it('updates primary server and returns restartRequired', async () => {
    const req = mockReq({ params: { id: 'primary' }, body: { rcon: { host: '10.0.0.5' } } });
    const res = mockRes();
    await handler.call(_server, req, res);
    assert.equal(res._status, 200);
    assert.ok(res._json.ok);
    assert.equal(res._json.restartRequired, true);
  });

  it('restartRequired is false when no rcon/sftp/paths changed', async () => {
    const req = mockReq({ params: { id: 'primary' }, body: { name: 'Updated Name' } });
    const res = mockRes();
    await handler.call(_server, req, res);
    assert.equal(res._status, 200);
    assert.equal(res._json.restartRequired, false);
  });

  it('updates managed server', async () => {
    const req = mockReq({ params: { id: 'srv_test1' }, body: { name: 'Updated Test 1' } });
    const res = mockRes();
    await handler.call(_server, req, res);
    assert.equal(res._status, 200);
    assert.ok(res._json.ok);
  });

  it('empty rcon password string keeps existing value', async () => {
    // First set a known password
    _configRepo.update('server:srv_test1', { rcon: { host: '10.0.0.1', port: 14541, password: 'test-rcon-not-real' } });
    const req = mockReq({
      params: { id: 'srv_test1' },
      body: { rcon: { host: '10.0.0.1', port: 14541, password: '' } },
    });
    const res = mockRes();
    await handler.call(_server, req, res);
    assert.equal(res._status, 200);
    const stored = _configRepo.get('server:srv_test1');
    assert.equal(stored.rcon.password, 'test-rcon-not-real', 'empty password should preserve existing value');
  });

  it('empty sftp password string keeps existing value', async () => {
    _configRepo.update('server:srv_test1', {
      sftp: { host: '10.0.0.1', port: 22, user: 'admin', password: 'test-sftp-not-real' },
    });
    const req = mockReq({
      params: { id: 'srv_test1' },
      body: { sftp: { password: '' } },
    });
    const res = mockRes();
    await handler.call(_server, req, res);
    assert.equal(res._status, 200);
    const stored = _configRepo.get('server:srv_test1');
    assert.equal(stored.sftp.password, 'test-sftp-not-real', 'empty sftp password should preserve existing value');
  });

  it('returns restartRequired true when rcon changes on managed server', async () => {
    const req = mockReq({
      params: { id: 'srv_test1' },
      body: { rcon: { host: '10.0.0.100', port: 14541, password: 'test-new-pw-not-real' } },
    });
    const res = mockRes();
    await handler.call(_server, req, res);
    assert.equal(res._json.restartRequired, true);
  });

  it('returns restartRequired true when sftp changes on managed server', async () => {
    const req = mockReq({
      params: { id: 'srv_test1' },
      body: { sftp: { host: '10.0.0.200' } },
    });
    const res = mockRes();
    await handler.call(_server, req, res);
    assert.equal(res._json.restartRequired, true);
  });

  it('returns restartRequired true when paths change on managed server', async () => {
    const req = mockReq({
      params: { id: 'srv_test1' },
      body: { paths: { logPath: '/new/log/path' } },
    });
    const res = mockRes();
    await handler.call(_server, req, res);
    assert.equal(res._json.restartRequired, true);
  });
});

// ── DELETE /api/panel/servers/:id ───────────────────────────────────────────

describe('Multi-Server API — DELETE /api/panel/servers/:id', () => {
  const handler = getHandler('DELETE', '/api/panel/servers/:id');

  it('requires admin tier', () => {
    const mw = getTierMiddleware('DELETE', '/api/panel/servers/:id');
    const req = mockReq({ tier: 'mod', tierLevel: 2, path: '/api/panel/servers/srv1' });
    const res = mockRes();
    let nextCalled = false;
    mw(req, res, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, false);
    assert.equal(res._status, 403);
  });

  it('returns 403 when trying to delete primary server', async () => {
    const req = mockReq({ params: { id: 'primary' }, query: { confirm: 'true' } });
    const res = mockRes();
    await handler.call(_server, req, res);
    assert.equal(res._status, 403);
    assert.equal(res._json.code, API_ERRORS.CANNOT_DELETE_PRIMARY);
  });

  it('returns 400 without confirm=true', async () => {
    const req = mockReq({ params: { id: 'srv_test2' }, query: {} });
    const res = mockRes();
    await handler.call(_server, req, res);
    assert.equal(res._status, 400);
    assert.equal(res._json.code, API_ERRORS.CONFIRM_REQUIRED);
  });

  it('returns 400 when confirm is not "true"', async () => {
    const req = mockReq({ params: { id: 'srv_test2' }, query: { confirm: 'yes' } });
    const res = mockRes();
    await handler.call(_server, req, res);
    assert.equal(res._status, 400);
    assert.equal(res._json.code, API_ERRORS.CONFIRM_REQUIRED);
  });

  it('returns 404 for non-existent server', async () => {
    const req = mockReq({ params: { id: 'srv_nonexistent' }, query: { confirm: 'true' } });
    const res = mockRes();
    await handler.call(_server, req, res);
    assert.equal(res._status, 404);
    assert.equal(res._json.code, API_ERRORS.SERVER_NOT_FOUND);
  });

  it('deletes existing managed server with confirm=true', async () => {
    // Add a server to delete
    _configRepo.set('server:srv_delete_me', {
      id: 'srv_delete_me',
      name: 'Delete Me',
      rcon: { host: 'h', port: 14541, password: 'test-p-not-real' },
    });
    const req = mockReq({ params: { id: 'srv_delete_me' }, query: { confirm: 'true' } });
    const res = mockRes();
    await handler.call(_server, req, res);
    assert.equal(res._status, 200);
    assert.ok(res._json.ok);
    // Verify it was removed
    assert.equal(_configRepo.get('server:srv_delete_me'), null);
  });
});

// ── POST /api/panel/servers/:id/actions/:action ─────────────────────────────

describe('Multi-Server API — POST /api/panel/servers/:id/actions/:action', () => {
  const handler = getHandler('POST', '/api/panel/servers/:id/actions/:action');

  it('requires admin tier', () => {
    const mw = getTierMiddleware('POST', '/api/panel/servers/:id/actions/:action');
    const req = mockReq({ tier: 'mod', tierLevel: 2, path: '/api/panel/servers/s/actions/start' });
    const res = mockRes();
    let nextCalled = false;
    mw(req, res, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, false);
    assert.equal(res._status, 403);
  });

  it('returns 400 for primary server', async () => {
    const req = mockReq({ params: { id: 'primary', action: 'start' } });
    const res = mockRes();
    await handler.call(_server, req, res);
    assert.equal(res._status, 400);
    assert.equal(res._json.code, API_ERRORS.CANNOT_CONTROL_PRIMARY);
  });

  it('returns 400 for invalid action', async () => {
    const req = mockReq({ params: { id: 'srv_test1', action: 'nuke' } });
    const res = mockRes();
    await handler.call(_server, req, res);
    assert.equal(res._status, 400);
    assert.equal(res._json.code, API_ERRORS.INVALID_LIFECYCLE_ACTION);
  });

  it('returns 500 when multiServerManager is not available', async () => {
    // Temporarily clear multiServerManager
    const orig = _server._multiServerManager;
    _server._multiServerManager = null;
    const req = mockReq({ params: { id: 'srv_test1', action: 'start' } });
    const res = mockRes();
    await handler.call(_server, req, res);
    assert.equal(res._status, 500);
    assert.equal(res._json.code, API_ERRORS.MULTI_SERVER_NOT_AVAILABLE);
    _server._multiServerManager = orig;
  });

  it('returns 404 when server definition not found', async () => {
    _server._multiServerManager = { getInstance: () => null };
    const req = mockReq({ params: { id: 'srv_ghost', action: 'start' } });
    const res = mockRes();
    await handler.call(_server, req, res);
    assert.equal(res._status, 404);
    assert.equal(res._json.code, API_ERRORS.SERVER_NOT_FOUND);
    _server._multiServerManager = null;
  });

  it('starts a stopped server', async () => {
    let startedId: string | null = null;
    _server._multiServerManager = {
      getInstance: () => ({ running: false }),
      startServer: async (id: string) => {
        startedId = id;
      },
    };
    const req = mockReq({ params: { id: 'srv_test1', action: 'start' } });
    const res = mockRes();
    await handler.call(_server, req, res);
    assert.equal(res._status, 200);
    assert.ok(res._json.ok);
    assert.equal(res._json.status, 'running');
    assert.equal(startedId, 'srv_test1');
    _server._multiServerManager = null;
  });

  it('returns 409 when starting already-running server', async () => {
    _server._multiServerManager = {
      getInstance: () => ({ running: true }),
      startServer: async () => {},
    };
    const req = mockReq({ params: { id: 'srv_test1', action: 'start' } });
    const res = mockRes();
    await handler.call(_server, req, res);
    assert.equal(res._status, 409);
    assert.equal(res._json.code, API_ERRORS.SERVER_ALREADY_IN_STATE);
    _server._multiServerManager = null;
  });

  it('stops a running server', async () => {
    let stoppedId: string | null = null;
    _server._multiServerManager = {
      getInstance: () => ({ running: true }),
      stopServer: async (id: string) => {
        stoppedId = id;
      },
    };
    const req = mockReq({ params: { id: 'srv_test1', action: 'stop' } });
    const res = mockRes();
    await handler.call(_server, req, res);
    assert.equal(res._status, 200);
    assert.ok(res._json.ok);
    assert.equal(res._json.status, 'stopped');
    assert.equal(stoppedId, 'srv_test1');
    _server._multiServerManager = null;
  });

  it('returns 409 when stopping already-stopped server', async () => {
    _server._multiServerManager = {
      getInstance: () => ({ running: false }),
      stopServer: async () => {},
    };
    const req = mockReq({ params: { id: 'srv_test1', action: 'stop' } });
    const res = mockRes();
    await handler.call(_server, req, res);
    assert.equal(res._status, 409);
    assert.equal(res._json.code, API_ERRORS.SERVER_ALREADY_IN_STATE);
    _server._multiServerManager = null;
  });

  it('restarts a running server (stop then start)', async () => {
    const calls: string[] = [];
    _server._multiServerManager = {
      getInstance: () => ({ running: true }),
      stopServer: async (id: string) => calls.push(`stop:${id}`),
      startServer: async (id: string) => calls.push(`start:${id}`),
    };
    const req = mockReq({ params: { id: 'srv_test1', action: 'restart' } });
    const res = mockRes();
    await handler.call(_server, req, res);
    assert.equal(res._status, 200);
    assert.equal(res._json.status, 'running');
    assert.deepEqual(calls, ['stop:srv_test1', 'start:srv_test1']);
    _server._multiServerManager = null;
  });

  it('restart on stopped server just starts it', async () => {
    const calls: string[] = [];
    _server._multiServerManager = {
      getInstance: () => ({ running: false }),
      stopServer: async (id: string) => calls.push(`stop:${id}`),
      startServer: async (id: string) => calls.push(`start:${id}`),
    };
    const req = mockReq({ params: { id: 'srv_test1', action: 'restart' } });
    const res = mockRes();
    await handler.call(_server, req, res);
    assert.equal(res._status, 200);
    assert.equal(res._json.status, 'running');
    assert.deepEqual(calls, ['start:srv_test1'], 'should only start, not stop');
    _server._multiServerManager = null;
  });
});

// ── POST /api/panel/servers/discover ────────────────────────────────────────

describe('Multi-Server API — POST /api/panel/servers/discover', () => {
  const handler = getHandler('POST', '/api/panel/servers/discover');

  it('requires admin tier', () => {
    const mw = getTierMiddleware('POST', '/api/panel/servers/discover');
    const req = mockReq({ tier: 'mod', tierLevel: 2, path: '/api/panel/servers/discover' });
    const res = mockRes();
    let nextCalled = false;
    mw(req, res, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, false);
    assert.equal(res._status, 403);
  });

  it('returns 400 when sftp config is missing', () => {
    const req = mockReq({ body: {} });
    const res = mockRes();
    handler.call(_server, req, res);
    assert.equal(res._status, 400);
    assert.equal(res._json.code, API_ERRORS.MISSING_SFTP_CONFIG);
  });

  it('returns 400 when sftp host is missing', () => {
    const req = mockReq({ body: { sftp: { user: 'admin', password: 'test-p-not-real' } } });
    const res = mockRes();
    handler.call(_server, req, res);
    assert.equal(res._status, 400);
    assert.equal(res._json.code, API_ERRORS.MISSING_SFTP_CONFIG);
  });

  it('returns 400 when sftp user is missing', () => {
    const req = mockReq({ body: { sftp: { host: '10.0.0.1', password: 'test-p-not-real' } } });
    const res = mockRes();
    handler.call(_server, req, res);
    assert.equal(res._status, 400);
    assert.equal(res._json.code, API_ERRORS.MISSING_SFTP_CONFIG);
  });

  it('returns 400 when sftp has neither password nor privateKeyPath', () => {
    const req = mockReq({ body: { sftp: { host: '10.0.0.1', user: 'admin' } } });
    const res = mockRes();
    handler.call(_server, req, res);
    assert.equal(res._status, 400);
    assert.equal(res._json.code, API_ERRORS.MISSING_SFTP_CONFIG);
  });
});

// ── GET /api/panel/servers/discover/:jobId ──────────────────────────────────

describe('Multi-Server API — GET /api/panel/servers/discover/:jobId', () => {
  const handler = getHandler('GET', '/api/panel/servers/discover/:jobId');

  it('requires admin tier', () => {
    const mw = getTierMiddleware('GET', '/api/panel/servers/discover/:jobId');
    const req = mockReq({ tier: 'mod', tierLevel: 2, path: '/api/panel/servers/discover/disc_1' });
    const res = mockRes();
    let nextCalled = false;
    mw(req, res, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, false);
    assert.equal(res._status, 403);
  });

  it('returns 404 for non-existent job ID', () => {
    const req = mockReq({ params: { jobId: 'disc_nonexistent' } });
    const res = mockRes();
    handler.call(_server, req, res);
    assert.equal(res._status, 404);
    assert.equal(res._json.code, API_ERRORS.DISCOVERY_JOB_NOT_FOUND);
  });
});

// ── POST /api/panel/servers/test-connection ─────────────────────────────────

describe('Multi-Server API — POST /api/panel/servers/test-connection', () => {
  const handler = getHandler('POST', '/api/panel/servers/test-connection');

  it('requires admin tier', () => {
    const mw = getTierMiddleware('POST', '/api/panel/servers/test-connection');
    const req = mockReq({ tier: 'mod', tierLevel: 2, path: '/api/panel/servers/test-connection' });
    const res = mockRes();
    let nextCalled = false;
    mw(req, res, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, false);
    assert.equal(res._status, 403);
  });

  it('returns 400 when both rcon and sftp are missing', async () => {
    const req = mockReq({ body: {} });
    const res = mockRes();
    await handler.call(_server, req, res);
    assert.equal(res._status, 400);
    assert.equal(res._json.code, API_ERRORS.MISSING_CONNECTION_CONFIG);
  });

  it('returns 400 when body is null', async () => {
    const req = mockReq({ body: null });
    const res = mockRes();
    await handler.call(_server, req, res);
    assert.equal(res._status, 400);
    assert.equal(res._json.code, API_ERRORS.MISSING_CONNECTION_CONFIG);
  });
});

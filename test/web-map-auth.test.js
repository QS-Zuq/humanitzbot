const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

// Stub config before requiring auth module
process.env.DISCORD_TOKEN = 'test';
process.env.DISCORD_CLIENT_ID = '123456789';
process.env.DISCORD_GUILD_ID = '987654321';

const { isAuthorised, isEnabled, _test } = require('../src/web-map/auth');
const { signSession, verifySession, parseCookies } = _test;

describe('Web Map Auth', () => {
  // ── isEnabled ──────────────────────────────────────────────

  describe('isEnabled()', () => {
    it('returns false when env vars are not set', () => {
      delete process.env.DISCORD_OAUTH_SECRET;
      delete process.env.WEB_MAP_CALLBACK_URL;
      assert.equal(isEnabled(), false);
    });

    it('returns false when only secret is set', () => {
      process.env.DISCORD_OAUTH_SECRET = 'test-secret';
      delete process.env.WEB_MAP_CALLBACK_URL;
      assert.equal(isEnabled(), false);
      delete process.env.DISCORD_OAUTH_SECRET;
    });

    it('returns false when only callback is set', () => {
      delete process.env.DISCORD_OAUTH_SECRET;
      process.env.WEB_MAP_CALLBACK_URL = 'http://localhost:3000/auth/callback';
      assert.equal(isEnabled(), false);
      delete process.env.WEB_MAP_CALLBACK_URL;
    });

    it('returns true when both are set', () => {
      process.env.DISCORD_OAUTH_SECRET = 'test-secret';
      process.env.WEB_MAP_CALLBACK_URL = 'http://localhost:3000/auth/callback';
      assert.equal(isEnabled(), true);
      delete process.env.DISCORD_OAUTH_SECRET;
      delete process.env.WEB_MAP_CALLBACK_URL;
    });
  });

  // ── Session signing / verification ─────────────────────────

  describe('signSession / verifySession', () => {
    const secret = 'my-test-secret-key';
    const sessionId = 'abc123def456';

    it('produces a signed string with a dot separator', () => {
      const signed = signSession(sessionId, secret);
      assert.ok(signed.includes('.'));
      assert.ok(signed.startsWith(sessionId + '.'));
    });

    it('verifies a valid signed session', () => {
      const signed = signSession(sessionId, secret);
      const result = verifySession(signed, secret);
      assert.equal(result, sessionId);
    });

    it('rejects a tampered session ID', () => {
      const signed = signSession(sessionId, secret);
      const tampered = 'tampered' + signed.slice(8);
      assert.equal(verifySession(tampered, secret), null);
    });

    it('rejects a tampered signature', () => {
      const signed = signSession(sessionId, secret);
      const tampered = signed.slice(0, -4) + 'xxxx';
      assert.equal(verifySession(tampered, secret), null);
    });

    it('rejects with wrong secret', () => {
      const signed = signSession(sessionId, secret);
      assert.equal(verifySession(signed, 'wrong-secret'), null);
    });

    it('rejects string without dot', () => {
      assert.equal(verifySession('noseparator', secret), null);
    });

    it('different session IDs produce different signatures', () => {
      const s1 = signSession('session-a', secret);
      const s2 = signSession('session-b', secret);
      assert.notEqual(s1, s2);
    });
  });

  // ── Cookie parsing ─────────────────────────────────────────

  describe('parseCookies', () => {
    it('parses a single cookie', () => {
      const result = parseCookies('hmz_session=abc123.sig');
      assert.deepEqual(result, { hmz_session: 'abc123.sig' });
    });

    it('parses multiple cookies', () => {
      const result = parseCookies('a=1; b=2; c=3');
      assert.deepEqual(result, { a: '1', b: '2', c: '3' });
    });

    it('handles cookies with = in value', () => {
      const result = parseCookies('token=abc=def=ghi');
      assert.deepEqual(result, { token: 'abc=def=ghi' });
    });

    it('returns empty object for null/undefined', () => {
      assert.deepEqual(parseCookies(null), {});
      assert.deepEqual(parseCookies(undefined), {});
      assert.deepEqual(parseCookies(''), {});
    });

    it('trims whitespace', () => {
      const result = parseCookies('  a = 1 ;  b = 2  ');
      assert.deepEqual(result, { a: '1', b: '2' });
    });
  });

  // ── isAuthorised ───────────────────────────────────────────

  describe('isAuthorised', () => {
    it('returns false for null member', () => {
      assert.equal(isAuthorised(null, []), false);
    });

    it('returns false for undefined member', () => {
      assert.equal(isAuthorised(undefined, ['123']), false);
    });

    describe('with allowed roles configured', () => {
      const allowedRoles = ['111', '222', '333'];

      it('returns true when member has one of the allowed roles', () => {
        const member = { roles: ['999', '222', '444'], permissions: '0' };
        assert.equal(isAuthorised(member, allowedRoles), true);
      });

      it('returns false when member has none of the allowed roles', () => {
        const member = { roles: ['999', '888'], permissions: '0' };
        assert.equal(isAuthorised(member, allowedRoles), false);
      });

      it('returns true even without admin permission if role matches', () => {
        const member = { roles: ['111'], permissions: '0' };
        assert.equal(isAuthorised(member, allowedRoles), true);
      });
    });

    describe('without allowed roles (admin-only mode)', () => {
      const noRoles = [];

      it('returns true for member with Administrator permission (0x8)', () => {
        // Administrator = 0x8 = 8
        const member = { roles: [], permissions: '8' };
        assert.equal(isAuthorised(member, noRoles), true);
      });

      it('returns true when admin bit is part of larger permission set', () => {
        // Some combination including 0x8
        const member = { roles: [], permissions: '2147483656' }; // includes 0x8
        assert.equal(isAuthorised(member, noRoles), true);
      });

      it('returns false for member without Administrator permission', () => {
        // ManageMessages = 0x2000, no admin
        const member = { roles: [], permissions: '8192' };
        assert.equal(isAuthorised(member, noRoles), false);
      });

      it('returns false for member with permissions = 0', () => {
        const member = { roles: [], permissions: '0' };
        assert.equal(isAuthorised(member, noRoles), false);
      });

      it('handles missing permissions field', () => {
        const member = { roles: [] };
        assert.equal(isAuthorised(member, noRoles), false);
      });
    });
  });

  // ── setupAuth ──────────────────────────────────────────────

  describe('setupAuth', () => {
    it('returns no-op middleware when OAuth is not configured', () => {
      delete process.env.DISCORD_OAUTH_SECRET;
      delete process.env.WEB_MAP_CALLBACK_URL;

      // Fresh require to pick up env changes — actually setupAuth reads env at call time
      const { setupAuth: setup } = require('../src/web-map/auth');

      // Minimal Express app mock
      const routes = {};
      const app = {
        get: (path, handler) => { routes[`GET ${path}`] = handler; },
        post: (path, handler) => { routes[`POST ${path}`] = handler; },
        use: () => {},
      };

      const middleware = setup(app);
      assert.equal(typeof middleware, 'function');

      // No-op middleware should call next()
      let nextCalled = false;
      middleware({}, {}, () => { nextCalled = true; });
      assert.equal(nextCalled, true);

      // No auth routes should be registered
      assert.equal(routes['GET /auth/login'], undefined);
    });

    it('registers auth routes when OAuth is configured', () => {
      process.env.DISCORD_OAUTH_SECRET = 'test-secret';
      process.env.WEB_MAP_CALLBACK_URL = 'http://localhost:3000/auth/callback';

      const { setupAuth: setup } = require('../src/web-map/auth');

      const routes = {};
      const app = {
        get: (path, handler) => { routes[`GET ${path}`] = handler; },
        post: (path, handler) => { routes[`POST ${path}`] = handler; },
        use: () => {},
      };

      const middleware = setup(app);
      assert.equal(typeof middleware, 'function');

      // Auth routes should be registered
      assert.ok(routes['GET /auth/login']);
      assert.ok(routes['GET /auth/callback']);
      assert.ok(routes['GET /auth/logout']);
      assert.ok(routes['GET /auth/me']);

      delete process.env.DISCORD_OAUTH_SECRET;
      delete process.env.WEB_MAP_CALLBACK_URL;
    });

    it('auth middleware skips /auth/ paths', () => {
      process.env.DISCORD_OAUTH_SECRET = 'test-secret';
      process.env.WEB_MAP_CALLBACK_URL = 'http://localhost:3000/auth/callback';

      const { setupAuth: setup } = require('../src/web-map/auth');
      const app = {
        get: () => {},
        post: () => {},
        use: () => {},
      };

      const middleware = setup(app);

      let nextCalled = false;
      middleware({ path: '/auth/login', headers: {} }, {}, () => { nextCalled = true; });
      assert.equal(nextCalled, true);

      delete process.env.DISCORD_OAUTH_SECRET;
      delete process.env.WEB_MAP_CALLBACK_URL;
    });

    it('auth middleware returns 401 for unauthenticated API requests', () => {
      process.env.DISCORD_OAUTH_SECRET = 'test-secret';
      process.env.WEB_MAP_CALLBACK_URL = 'http://localhost:3000/auth/callback';

      const { setupAuth: setup } = require('../src/web-map/auth');
      const app = {
        get: () => {},
        post: () => {},
        use: () => {},
      };

      const middleware = setup(app);

      let statusCode = null;
      let jsonBody = null;
      const res = {
        status: (code) => { statusCode = code; return res; },
        json: (body) => { jsonBody = body; },
        redirect: () => {},
      };

      middleware({ path: '/api/players', headers: {} }, res, () => {});
      assert.equal(statusCode, 401);
      assert.ok(jsonBody.error);

      delete process.env.DISCORD_OAUTH_SECRET;
      delete process.env.WEB_MAP_CALLBACK_URL;
    });

    it('auth middleware redirects unauthenticated browser requests', () => {
      process.env.DISCORD_OAUTH_SECRET = 'test-secret';
      process.env.WEB_MAP_CALLBACK_URL = 'http://localhost:3000/auth/callback';

      const { setupAuth: setup } = require('../src/web-map/auth');
      const app = {
        get: () => {},
        post: () => {},
        use: () => {},
      };

      const middleware = setup(app);

      let redirectUrl = null;
      const res = {
        status: () => res,
        json: () => {},
        redirect: (url) => { redirectUrl = url; },
      };

      middleware({ path: '/', headers: {} }, res, () => {});
      assert.equal(redirectUrl, '/auth/login');

      delete process.env.DISCORD_OAUTH_SECRET;
      delete process.env.WEB_MAP_CALLBACK_URL;
    });
  });
});

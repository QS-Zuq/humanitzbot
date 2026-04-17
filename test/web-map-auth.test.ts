import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const cjsRequire = createRequire(__filename);

// Stub config before requiring auth module

import * as _auth from '../src/web-map/auth.js';
const { isAuthorised, isEnabled, resolveTier, requireTier, TIER, _test } = _auth as any;
const { _parseCookies, getSessionSecret } = _test;

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

  // ── Cookie parsing ─────────────────────────────────────────

  describe('_parseCookies', () => {
    it('parses a single cookie', () => {
      const result = _parseCookies('hmz_session=abc123.sig');
      assert.deepEqual(result, { hmz_session: 'abc123.sig' });
    });

    it('parses multiple cookies', () => {
      const result = _parseCookies('a=1; b=2; c=3');
      assert.deepEqual(result, { a: '1', b: '2', c: '3' });
    });

    it('handles cookies with = in value', () => {
      const result = _parseCookies('token=abc=def=ghi');
      assert.deepEqual(result, { token: 'abc=def=ghi' });
    });

    it('returns empty object for null/undefined', () => {
      assert.deepEqual(_parseCookies(null), {});
      assert.deepEqual(_parseCookies(undefined), {});
      assert.deepEqual(_parseCookies(''), {});
    });

    it('trims whitespace', () => {
      const result = _parseCookies('  a = 1 ;  b = 2  ');
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
      const noRoles: string[] = [];

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

  // ── resolveTier ────────────────────────────────────────────

  describe('resolveTier', () => {
    const authCfg = {
      adminRoles: ['admin-role'],
      modRoles: ['mod-role'],
      survivorRoles: ['survivor-role'],
    };

    it('returns public for null member', () => {
      assert.equal(resolveTier(null, authCfg), 'public');
    });

    it('returns admin for Discord Administrator permission', () => {
      const member = { roles: [], permissions: '8' };
      assert.equal(resolveTier(member, authCfg), 'admin');
    });

    it('returns admin for admin role', () => {
      const member = { roles: ['admin-role'], permissions: '0' };
      assert.equal(resolveTier(member, authCfg), 'admin');
    });

    it('returns mod for mod role', () => {
      const member = { roles: ['mod-role'], permissions: '0' };
      assert.equal(resolveTier(member, authCfg), 'mod');
    });

    it('returns survivor for survivor role', () => {
      const member = { roles: ['survivor-role'], permissions: '0' };
      assert.equal(resolveTier(member, authCfg), 'survivor');
    });

    it('returns public for member without qualifying roles', () => {
      const member = { roles: ['random-role'], permissions: '0' };
      assert.equal(resolveTier(member, authCfg), 'public');
    });

    it('returns survivor for any guild member when no survivorRoles configured', () => {
      const noSurvivorCfg = { adminRoles: [], modRoles: [], survivorRoles: [] };
      const member = { roles: ['random-role'], permissions: '0' };
      assert.equal(resolveTier(member, noSurvivorCfg), 'survivor');
    });
  });

  // ── TIER ───────────────────────────────────────────────────

  describe('TIER', () => {
    it('has correct tier levels', () => {
      assert.equal(TIER.public, 0);
      assert.equal(TIER.survivor, 1);
      assert.equal(TIER.mod, 2);
      assert.equal(TIER.admin, 3);
    });
  });

  // ── setupAuth ──────────────────────────────────────────────

  describe('setupAuth', () => {
    it('disabled mode: sets public tier when OAuth is not configured', () => {
      delete process.env.DISCORD_OAUTH_SECRET;
      delete process.env.WEB_MAP_CALLBACK_URL;

      const { setupAuth: setup } = _auth as any;

      const routes: Record<string, unknown> = {};
      const app = {
        get: (path: string, handler: unknown) => {
          routes[`GET ${path}`] = handler;
        },
        post: (path: string, handler: unknown) => {
          routes[`POST ${path}`] = handler;
        },
        use: () => {},
      };

      const middleware = setup(app);
      assert.equal(typeof middleware, 'function');

      // Middleware should set public tier
      const req: Record<string, unknown> = {};
      let nextCalled = false;
      middleware(req, {}, () => {
        nextCalled = true;
      });
      assert.equal(nextCalled, true);
      assert.equal(req.tier, 'public');
      assert.equal(req.tierLevel, 0);

      // /auth/me should return authenticated: false + oauthNotConfigured
      let meResponse: Record<string, unknown> = {};
      const meHandler = routes['GET /auth/me'] as (req: unknown, res: unknown) => void;
      meHandler(
        {},
        {
          json: (data: Record<string, unknown>) => {
            meResponse = data;
          },
        },
      );
      assert.equal(meResponse.authenticated, false);
      assert.equal(meResponse.tier, 'public');
      assert.equal(meResponse.oauthNotConfigured, true);

      // Auth routes should still be registered
      assert.equal(typeof routes['GET /auth/login'], 'function');
    });

    // ── Partial OAuth config: both secret and callback URL must be set ──

    it('partial OAuth: only DISCORD_OAUTH_SECRET set → disabled mode', () => {
      process.env.DISCORD_OAUTH_SECRET = 'test-secret';
      delete process.env.WEB_MAP_CALLBACK_URL;

      try {
        const { setupAuth: setup } = _auth as any;

        const routes: Record<string, unknown> = {};
        const app = {
          get: (path: string, handler: unknown) => {
            routes[`GET ${path}`] = handler;
          },
          post: () => {},
          use: () => {},
        };

        const middleware = setup(app);
        const req: Record<string, unknown> = {};
        middleware(req, {}, () => {});
        assert.equal(req.tier, 'public');
        assert.equal(req.tierLevel, 0);

        let meResponse: Record<string, unknown> = {};
        const meHandler = routes['GET /auth/me'] as (req: unknown, res: unknown) => void;
        meHandler(
          {},
          {
            json: (data: Record<string, unknown>) => {
              meResponse = data;
            },
          },
        );
        assert.equal(meResponse.authenticated, false);
        assert.equal(meResponse.oauthNotConfigured, true);
      } finally {
        delete process.env.DISCORD_OAUTH_SECRET;
      }
    });

    it('partial OAuth: only WEB_MAP_CALLBACK_URL set → disabled mode', () => {
      delete process.env.DISCORD_OAUTH_SECRET;
      process.env.WEB_MAP_CALLBACK_URL = 'http://localhost:3000/auth/callback';

      try {
        const { setupAuth: setup } = _auth as any;

        const routes: Record<string, unknown> = {};
        const app = {
          get: (path: string, handler: unknown) => {
            routes[`GET ${path}`] = handler;
          },
          post: () => {},
          use: () => {},
        };

        const middleware = setup(app);
        const req: Record<string, unknown> = {};
        middleware(req, {}, () => {});
        assert.equal(req.tier, 'public');

        let meResponse: Record<string, unknown> = {};
        const meHandler = routes['GET /auth/me'] as (req: unknown, res: unknown) => void;
        meHandler(
          {},
          {
            json: (data: Record<string, unknown>) => {
              meResponse = data;
            },
          },
        );
        assert.equal(meResponse.authenticated, false);
        assert.equal(meResponse.oauthNotConfigured, true);
      } finally {
        delete process.env.WEB_MAP_CALLBACK_URL;
      }
    });

    // ── Stub session middleware ──

    type StubMiddleware = (req: unknown, res: unknown, next: () => void) => void;

    it('disabled mode: stub session middleware injects empty session with working save/destroy', () => {
      delete process.env.DISCORD_OAUTH_SECRET;
      delete process.env.WEB_MAP_CALLBACK_URL;

      const { setupAuth: setup } = _auth as any;

      const middlewares: StubMiddleware[] = [];
      const app = {
        get: () => {},
        post: () => {},
        use: (mw: StubMiddleware) => {
          middlewares.push(mw);
        },
      };

      setup(app);
      const stubSession = middlewares[0];
      assert.ok(stubSession, 'stub session middleware should be registered');

      const req: Record<string, unknown> = {};
      let nextCalled = false;
      stubSession(req, {}, () => {
        nextCalled = true;
      });
      assert.equal(nextCalled, true);

      const session = req.session as Record<string, unknown>;
      assert.ok(session, 'req.session should be injected');
      assert.equal(session.user, undefined, 'disabled mode leaves user undefined');
      assert.equal(typeof session.save, 'function');
      assert.equal(typeof session.destroy, 'function');

      let saveErr: unknown = 'unset';
      (session.save as (cb: (err: Error | null) => void) => void)((err) => {
        saveErr = err;
      });
      assert.equal(saveErr, null, 'stub save() invokes callback with null');

      let destroyErr: unknown = 'unset';
      (session.destroy as (cb: (err: Error | null) => void) => void)((err) => {
        destroyErr = err;
      });
      assert.equal(destroyErr, null, 'stub destroy() invokes callback with null');
    });

    // ── Integration: setupAuth middleware + requireTier ──

    it('landingOnly mode: tier injected by middleware is blocked by requireTier("survivor") on API', () => {
      delete process.env.DISCORD_OAUTH_SECRET;
      delete process.env.WEB_MAP_CALLBACK_URL;

      const { setupAuth: setup, requireTier: rt } = _auth as any;
      const app = { get: () => {}, post: () => {}, use: () => {} };
      const middleware = setup(app);

      const req: Record<string, unknown> = { path: '/api/players' };
      middleware(req, {}, () => {});

      const guard = rt('survivor');
      let statusCode: number | null = null;
      let jsonBody: unknown = null;
      const res = {
        status: (c: number) => {
          statusCode = c;
          return res;
        },
        json: (body: unknown) => {
          jsonBody = body;
        },
        redirect: () => {},
        send: () => {},
      };
      guard(req, res, () => {});
      assert.equal(statusCode, 401, 'public tier should be blocked from survivor API');
      assert.ok((jsonBody as Record<string, unknown>).error, 'response should carry an error message');
    });

    // ── /auth/login and /auth/logout redirect behaviour in no-OAuth modes ──

    it('disabled mode: /auth/login and /auth/logout redirect to /', () => {
      delete process.env.DISCORD_OAUTH_SECRET;
      delete process.env.WEB_MAP_CALLBACK_URL;

      const { setupAuth: setup } = _auth as any;
      const routes: Record<string, unknown> = {};
      const app = {
        get: (path: string, handler: unknown) => {
          routes[`GET ${path}`] = handler;
        },
        post: () => {},
        use: () => {},
      };
      setup(app);

      let loginRedirect: string | null = null;
      (routes['GET /auth/login'] as (req: unknown, res: unknown) => void)(
        {},
        {
          redirect: (t: string) => {
            loginRedirect = t;
          },
        },
      );
      assert.equal(loginRedirect, '/');

      let logoutRedirect: string | null = null;
      (routes['GET /auth/logout'] as (req: unknown, res: unknown) => void)(
        {},
        {
          redirect: (t: string) => {
            logoutRedirect = t;
          },
        },
      );
      assert.equal(logoutRedirect, '/');
    });

    it('registers auth routes when OAuth is configured', () => {
      process.env.DISCORD_OAUTH_SECRET = 'test-secret';
      process.env.WEB_MAP_CALLBACK_URL = 'http://localhost:3000/auth/callback';

      const { setupAuth: setup } = cjsRequire('../src/web-map/auth');

      const routes: Record<string, unknown> = {};
      const middlewares: unknown[] = [];
      const app = {
        get: (path: string, handler: unknown) => {
          routes[`GET ${path}`] = handler;
        },
        post: (path: string, handler: unknown) => {
          routes[`POST ${path}`] = handler;
        },
        use: (mw: unknown) => {
          middlewares.push(mw);
        },
      };

      const middleware = setup(app);
      assert.equal(typeof middleware, 'function');

      // Auth routes should be registered
      assert.ok(routes['GET /auth/login']);
      assert.ok(routes['GET /auth/callback']);
      assert.ok(routes['GET /auth/logout']);
      assert.ok(routes['GET /auth/me']);

      // express-session middleware should be registered via app.use
      assert.ok(middlewares.length > 0, 'express-session middleware should be registered');

      delete process.env.DISCORD_OAUTH_SECRET;
      delete process.env.WEB_MAP_CALLBACK_URL;
    });

    it('auth middleware skips /auth/ paths', () => {
      process.env.DISCORD_OAUTH_SECRET = 'test-secret';
      process.env.WEB_MAP_CALLBACK_URL = 'http://localhost:3000/auth/callback';

      const { setupAuth: setup } = cjsRequire('../src/web-map/auth');
      const app = {
        get: () => {},
        post: () => {},
        use: () => {},
      };

      const middleware = setup(app);

      let nextCalled = false;
      middleware({ path: '/auth/login', headers: {} }, {}, () => {
        nextCalled = true;
      });
      assert.equal(nextCalled, true);

      delete process.env.DISCORD_OAUTH_SECRET;
      delete process.env.WEB_MAP_CALLBACK_URL;
    });

    it('auth middleware sets public tier for unauthenticated requests and calls next()', () => {
      process.env.DISCORD_OAUTH_SECRET = 'test-secret';
      process.env.WEB_MAP_CALLBACK_URL = 'http://localhost:3000/auth/callback';

      const { setupAuth: setup } = cjsRequire('../src/web-map/auth');
      const app = {
        get: () => {},
        post: () => {},
        use: () => {},
      };

      const middleware = setup(app);

      let nextCalled = false;
      // req.session is set by express-session middleware (not present here → public tier)
      const req: Record<string, unknown> = { path: '/api/players', headers: {}, session: {} };
      const res = {
        status: () => res,
        json: () => {},
        redirect: () => {},
      };

      middleware(req, res, () => {
        nextCalled = true;
      });
      assert.equal(nextCalled, true);
      assert.equal(req.tier, 'public');
      assert.equal(req.tierLevel, 0);

      delete process.env.DISCORD_OAUTH_SECRET;
      delete process.env.WEB_MAP_CALLBACK_URL;
    });

    it('auth middleware reads tier from req.session.user', () => {
      process.env.DISCORD_OAUTH_SECRET = 'test-secret';
      process.env.WEB_MAP_CALLBACK_URL = 'http://localhost:3000/auth/callback';

      const { setupAuth: setup } = cjsRequire('../src/web-map/auth');
      const app = {
        get: () => {},
        post: () => {},
        use: () => {},
      };

      const middleware = setup(app);

      let nextCalled = false;
      const req: Record<string, unknown> = {
        path: '/api/players',
        headers: {},
        session: {
          user: {
            userId: 'user123',
            username: 'TestUser',
            tier: 'survivor',
            tierLevel: TIER.survivor,
            lastRoleCheck: Date.now(),
          },
          save: () => {},
        },
      };

      middleware(req, {}, () => {
        nextCalled = true;
      });
      assert.equal(nextCalled, true);
      assert.equal(req.tier, 'survivor');
      assert.equal(req.tierLevel, TIER.survivor);

      delete process.env.DISCORD_OAUTH_SECRET;
      delete process.env.WEB_MAP_CALLBACK_URL;
    });

    it('requireTier blocks unauthenticated API requests with 401', () => {
      const { requireTier: rt } = cjsRequire('../src/web-map/auth');
      const guard = rt('survivor');

      let statusCode: number | null = null;
      let jsonBody: unknown = null;
      const req = { path: '/api/players', tier: 'public', tierLevel: 0 };
      const res = {
        status: (code: number) => {
          statusCode = code;
          return res;
        },
        json: (body: unknown) => {
          jsonBody = body;
        },
        redirect: () => {},
      };

      guard(req, res, () => {});
      assert.equal(statusCode, 401);
      assert.ok((jsonBody as Record<string, unknown>).error);
    });

    it('middleware re-checks roles from guild cache when lastRoleCheck is stale', () => {
      process.env.DISCORD_OAUTH_SECRET = 'test-secret';
      process.env.WEB_MAP_CALLBACK_URL = 'http://localhost:3000/auth/callback';

      // Set guildId on the config singleton directly — env vars are only read at
      // module load time so process.env.DISCORD_GUILD_ID has no effect here.
      const config = cjsRequire('../src/config/index').default;
      const savedGuildId = config.guildId;
      config.guildId = '987654321';

      try {
        const { setupAuth: setup, TIER: T } = cjsRequire('../src/web-map/auth');

        // Build a mock bot client with a guild member cache
        const mockMember = {
          roles: { cache: { map: () => ['111'] } },
          permissions: { bitfield: 0n },
        };

        const mockGuild = {
          members: { cache: { get: () => mockMember } },
        };
        const mockClient = {
          guilds: { cache: { get: (id: string) => (id === '987654321' ? mockGuild : null) } },
        };

        const app = {
          get: () => {},
          post: () => {},
          use: () => {},
        };

        const middleware = setup(app, mockClient);

        // Mock session with stale lastRoleCheck (admin tier, but mock member has no admin role/permission)
        let saveCalled = false;
        const req: Record<string, unknown> = {
          path: '/api/players',
          headers: {},
          session: {
            user: {
              userId: 'user123',
              username: 'TestUser',
              displayName: 'Test',
              avatar: null,
              roles: ['999'], // old admin role
              tier: 'admin',
              tierLevel: T.admin,
              inGuild: true,
              lastRoleCheck: 0, // way in the past → triggers refresh
            },
            save: (cb: ((err: null) => void) | undefined) => {
              saveCalled = true;
              if (cb) cb(null);
            },
          },
        };

        let nextCalled = false;
        middleware(req, {}, () => {
          nextCalled = true;
        });
        assert.equal(nextCalled, true);

        // The mock member has no admin role/permission → tier should downgrade
        const user = (req.session as Record<string, unknown>).user as Record<string, unknown>;
        assert.notEqual(user.tier, 'admin', 'Tier should have been downgraded from admin');
        assert.ok((user.lastRoleCheck as number) > 0, 'lastRoleCheck should be updated');
        assert.ok(saveCalled, 'session.save() should be called after role mutation');
      } finally {
        delete process.env.DISCORD_OAUTH_SECRET;
        delete process.env.WEB_MAP_CALLBACK_URL;
        config.guildId = savedGuildId;
      }
    });

    // ── /auth/test-login (E2E / AI automation) ──

    const VALID_TOKEN = 'a'.repeat(64); // 64-char hex-like string, passes length check

    function setupWithTestToken(token: string | undefined, nodeEnv?: string) {
      if (token === undefined) delete process.env.WEB_PANEL_TEST_AUTH_TOKEN;
      else process.env.WEB_PANEL_TEST_AUTH_TOKEN = token;
      if (nodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = nodeEnv;
      process.env.DISCORD_OAUTH_SECRET = 'test-secret';
      process.env.WEB_MAP_CALLBACK_URL = 'http://localhost:3000/auth/callback';

      const routes: Record<string, unknown> = {};
      const app = {
        get: (path: string, handler: unknown) => {
          routes[`GET ${path}`] = handler;
        },
        post: () => {},
        use: () => {},
      };
      const { setupAuth: setup } = cjsRequire('../src/web-map/auth');
      setup(app);
      return routes;
    }

    function cleanupTestTokenEnv() {
      delete process.env.WEB_PANEL_TEST_AUTH_TOKEN;
      delete process.env.NODE_ENV;
      delete process.env.DISCORD_OAUTH_SECRET;
      delete process.env.WEB_MAP_CALLBACK_URL;
    }

    it('test-login: registers /auth/test-login when token is set and NODE_ENV is not production', () => {
      try {
        const routes = setupWithTestToken(VALID_TOKEN, 'development');
        assert.equal(typeof routes['GET /auth/test-login'], 'function');
      } finally {
        cleanupTestTokenEnv();
      }
    });

    it('test-login: does NOT register endpoint when NODE_ENV=production (security guard)', () => {
      try {
        const routes = setupWithTestToken(VALID_TOKEN, 'production');
        assert.equal(routes['GET /auth/test-login'], undefined);
      } finally {
        cleanupTestTokenEnv();
      }
    });

    it('test-login: does NOT register endpoint when token is shorter than 32 chars', () => {
      try {
        const routes = setupWithTestToken('short', 'development');
        assert.equal(routes['GET /auth/test-login'], undefined);
      } finally {
        cleanupTestTokenEnv();
      }
    });

    it('test-login: does NOT register endpoint when token is unset', () => {
      try {
        const routes = setupWithTestToken(undefined, 'development');
        assert.equal(routes['GET /auth/test-login'], undefined);
      } finally {
        cleanupTestTokenEnv();
      }
    });

    it('test-login: valid token creates synthetic admin session and redirects to /', () => {
      try {
        const routes = setupWithTestToken(VALID_TOKEN, 'development');
        const handler = routes['GET /auth/test-login'] as (req: unknown, res: unknown) => void;

        let redirectTarget: string | null = null;
        const session: Record<string, unknown> = {
          save(cb: (err: Error | null) => void) {
            cb(null);
          },
        };
        const req = { query: { token: VALID_TOKEN }, session };
        const res = {
          status: () => res,
          send: () => {},
          redirect: (t: string) => {
            redirectTarget = t;
          },
        };

        handler(req, res);

        assert.equal(redirectTarget, '/');
        const user = session.user as Record<string, unknown>;
        assert.ok(user, 'session.user should be populated');
        assert.equal(user.userId, 'e2e-test');
        assert.equal(user.username, 'E2E Test User');
        assert.equal(user.tier, 'admin');
        assert.equal(user.tierLevel, TIER.admin);
        assert.equal(user.inGuild, false, 'synthetic session should not claim guild membership');
        assert.equal(user.isTestSession, true, 'session should be flagged as test');
      } finally {
        cleanupTestTokenEnv();
      }
    });

    it('test-login: accepts tier query param when it is a valid tier', () => {
      try {
        const routes = setupWithTestToken(VALID_TOKEN, 'development');
        const handler = routes['GET /auth/test-login'] as (req: unknown, res: unknown) => void;

        const session: Record<string, unknown> = {
          save(cb: (err: Error | null) => void) {
            cb(null);
          },
        };
        const req = { query: { token: VALID_TOKEN, tier: 'survivor' }, session };
        const res = { status: () => res, send: () => {}, redirect: () => {} };
        handler(req, res);

        const user = session.user as Record<string, unknown>;
        assert.equal(user.tier, 'survivor');
        assert.equal(user.tierLevel, TIER.survivor);
      } finally {
        cleanupTestTokenEnv();
      }
    });

    it('test-login: falls back to admin tier when tier query param is invalid', () => {
      try {
        const routes = setupWithTestToken(VALID_TOKEN, 'development');
        const handler = routes['GET /auth/test-login'] as (req: unknown, res: unknown) => void;

        const session: Record<string, unknown> = {
          save(cb: (err: Error | null) => void) {
            cb(null);
          },
        };
        const req = { query: { token: VALID_TOKEN, tier: 'superuser' }, session };
        const res = { status: () => res, send: () => {}, redirect: () => {} };
        handler(req, res);

        const user = session.user as Record<string, unknown>;
        assert.equal(user.tier, 'admin', 'invalid tier should fall back to admin');
      } finally {
        cleanupTestTokenEnv();
      }
    });

    it('test-login: rejects wrong token with 401', () => {
      try {
        const routes = setupWithTestToken(VALID_TOKEN, 'development');
        const handler = routes['GET /auth/test-login'] as (req: unknown, res: unknown) => void;

        const wrongToken = 'b'.repeat(64); // same length, different content
        let statusCode: number | null = null;
        let sendBody: unknown = null;
        const req = { query: { token: wrongToken }, session: {} };
        const res = {
          status: (c: number) => {
            statusCode = c;
            return res;
          },
          send: (body: unknown) => {
            sendBody = body;
          },
          redirect: () => {},
        };
        handler(req, res);

        assert.equal(statusCode, 401);
        assert.equal(sendBody, 'Invalid token');
      } finally {
        cleanupTestTokenEnv();
      }
    });

    it('test-login: rejects different-length token without timingSafeEqual crash', () => {
      try {
        const routes = setupWithTestToken(VALID_TOKEN, 'development');
        const handler = routes['GET /auth/test-login'] as (req: unknown, res: unknown) => void;

        let statusCode: number | null = null;
        const req = { query: { token: 'tooshort' }, session: {} };
        const res = {
          status: (c: number) => {
            statusCode = c;
            return res;
          },
          send: () => {},
          redirect: () => {},
        };
        handler(req, res);
        assert.equal(statusCode, 401, 'different-length token should be rejected before timingSafeEqual');
      } finally {
        cleanupTestTokenEnv();
      }
    });

    it('test-login: rejects missing token with 401', () => {
      try {
        const routes = setupWithTestToken(VALID_TOKEN, 'development');
        const handler = routes['GET /auth/test-login'] as (req: unknown, res: unknown) => void;

        let statusCode: number | null = null;
        const req = { query: {}, session: {} };
        const res = {
          status: (c: number) => {
            statusCode = c;
            return res;
          },
          send: () => {},
          redirect: () => {},
        };
        handler(req, res);
        assert.equal(statusCode, 401);
      } finally {
        cleanupTestTokenEnv();
      }
    });
  });

  // ── getTestAuthToken ───────────────────────────────────────

  describe('getTestAuthToken', () => {
    const { getTestAuthToken } = _test;

    it('returns null when WEB_PANEL_TEST_AUTH_TOKEN is unset', () => {
      delete process.env.WEB_PANEL_TEST_AUTH_TOKEN;
      delete process.env.NODE_ENV;
      assert.equal(getTestAuthToken(), null);
    });

    it('returns null when NODE_ENV=production even with a valid token', () => {
      process.env.WEB_PANEL_TEST_AUTH_TOKEN = 'a'.repeat(64);
      process.env.NODE_ENV = 'production';
      try {
        assert.equal(getTestAuthToken(), null);
      } finally {
        delete process.env.WEB_PANEL_TEST_AUTH_TOKEN;
        delete process.env.NODE_ENV;
      }
    });

    it('returns null when token is shorter than 32 characters', () => {
      process.env.WEB_PANEL_TEST_AUTH_TOKEN = 'a'.repeat(31);
      delete process.env.NODE_ENV;
      try {
        assert.equal(getTestAuthToken(), null);
      } finally {
        delete process.env.WEB_PANEL_TEST_AUTH_TOKEN;
      }
    });

    it('returns the token when valid and NODE_ENV is not production', () => {
      const token = 'a'.repeat(32);
      process.env.WEB_PANEL_TEST_AUTH_TOKEN = token;
      process.env.NODE_ENV = 'development';
      try {
        assert.equal(getTestAuthToken(), token);
      } finally {
        delete process.env.WEB_PANEL_TEST_AUTH_TOKEN;
        delete process.env.NODE_ENV;
      }
    });
  });

  // ── getSessionSecret ───────────────────────────────────────

  describe('getSessionSecret', () => {
    it('returns a string', () => {
      const secret = getSessionSecret();
      assert.equal(typeof secret, 'string');
      assert.ok(secret.length > 0);
    });

    it('returns the same value on subsequent calls', () => {
      const s1 = getSessionSecret();
      const s2 = getSessionSecret();
      assert.equal(s1, s2);
    });
  });

  // ── requireTier ────────────────────────────────────────────

  describe('requireTier', () => {
    it('allows requests that meet the tier requirement', () => {
      const guard = requireTier('survivor');
      let nextCalled = false;
      const req = { path: '/api/players', tier: 'admin', tierLevel: TIER.admin };
      guard(req, {}, () => {
        nextCalled = true;
      });
      assert.equal(nextCalled, true);
    });

    it('returns 403 for logged-in users with insufficient tier', () => {
      const guard = requireTier('admin');
      let statusCode: number | null = null;
      let jsonBody: unknown = null;
      const req = { path: '/api/admin/settings', tier: 'survivor', tierLevel: TIER.survivor };
      const res = {
        status: (code: number) => {
          statusCode = code;
          return res;
        },
        json: (body: unknown) => {
          jsonBody = body;
        },
        send: () => {},
        redirect: () => {},
      };
      guard(req, res, () => {});
      assert.equal(statusCode, 403);
      assert.ok(((jsonBody as Record<string, unknown>).error as string).includes('admin'));
    });

    it('redirects non-API public requests to login', () => {
      const guard = requireTier('survivor');
      let redirectTarget: string | null = null;
      const req = { path: '/dashboard', tier: 'public', tierLevel: 0 };
      const res = {
        status: () => res,
        json: () => {},
        redirect: (target: string) => {
          redirectTarget = target;
        },
        send: () => {},
      };
      guard(req, res, () => {});
      assert.equal(redirectTarget, '/auth/login');
    });
  });
});

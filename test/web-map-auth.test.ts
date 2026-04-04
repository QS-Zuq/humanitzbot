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
    it('returns no-op middleware when OAuth is not configured', () => {
      delete process.env.DISCORD_OAUTH_SECRET;
      delete process.env.WEB_MAP_CALLBACK_URL;

      // Fresh require to pick up env changes — actually setupAuth reads env at call time

      const { setupAuth: setup } = _auth as any;

      // Minimal Express app mock
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

      // No-op middleware should call next()
      let nextCalled = false;
      middleware({}, {}, () => {
        nextCalled = true;
      });
      assert.equal(nextCalled, true);

      // Stub auth routes should still be registered (so frontend can function)
      assert.equal(typeof routes['GET /auth/login'], 'function');
      assert.equal(typeof routes['GET /auth/me'], 'function');
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

      delete process.env.DISCORD_OAUTH_SECRET;
      delete process.env.WEB_MAP_CALLBACK_URL;
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

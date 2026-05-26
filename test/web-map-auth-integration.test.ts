/**
 * Integration tests for the web panel auth flow.
 *
 * Unlike web-map-auth.test.ts (which mocks Express), these spin up a real
 * express app with real setupAuth middleware on an ephemeral port, then
 * exercise the endpoints via fetch. This catches wiring bugs that pure
 * unit tests miss (cookie propagation, middleware order, body parser
 * attachment, Set-Cookie on redirects, etc.).
 *
 * Does NOT cover the Discord OAuth round-trip (real code exchange and
 * user auth) — that requires a real Discord app + human interaction and
 * is left as a manual verification item.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';

// IMPORTANT: static import — forces `../src/web-map/auth` (and transitively
// `../src/config/index.ts`) to load NOW, which in turn runs dotenv.config()
// and populates process.env from the on-disk .env. Doing the import inside a
// test hook would let dotenv's side effect run AFTER our cleanAuthEnv(), so
// the "no OAuth" describe block would see OAuth env vars bleeding in from
// the developer's real .env. See commit history for the debugging trail.
import { setupAuth, requireTier } from '../src/web-map/auth.js';

interface Booted {
  url: string;
  close: () => Promise<void>;
}

async function bootTestApp(): Promise<Booted> {
  const app = express();
  const authMiddleware = (setupAuth as (app: express.Express, client: null, opts: object) => express.RequestHandler)(
    app,
    null,
    {},
  );
  app.use(authMiddleware);
  // Expose a guarded route so we can verify cookies authenticate subsequent requests.
  app.get(
    '/api/admin/ping',
    (requireTier as (tier: string) => express.RequestHandler)('admin'),
    (_req: unknown, res: express.Response) => {
      res.json({ ok: true });
    },
  );

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => {
      resolve(s);
    });
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}

function cleanAuthEnv(): void {
  delete process.env.DISCORD_OAUTH_SECRET;
  delete process.env.WEB_MAP_CALLBACK_URL;
  delete process.env.WEB_MAP_SESSION_SECRET;
  delete process.env.WEB_PANEL_TEST_AUTH_TOKEN;
  delete process.env.NODE_ENV;
}

// ══════════════════════════════════════════════════════════
// Item 1 — no OAuth configured: landing-only
// ══════════════════════════════════════════════════════════

describe('Integration: web panel with NO OAuth configured', () => {
  let booted: Booted;

  before(async () => {
    cleanAuthEnv();
    booted = await bootTestApp();
  });

  after(async () => {
    await booted.close();
    cleanAuthEnv();
  });

  it('GET /auth/me returns oauthNotConfigured:true', async () => {
    const res = await fetch(`${booted.url}/auth/me`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.authenticated, false);
    assert.equal(body.tier, 'public');
    assert.equal(body.tierLevel, 0);
    assert.equal(body.oauthNotConfigured, true);
  });

  it('GET /auth/login redirects to / (landing page, login disabled)', async () => {
    const res = await fetch(`${booted.url}/auth/login`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/');
  });

  it('GET /auth/logout redirects to /', async () => {
    const res = await fetch(`${booted.url}/auth/logout`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/');
  });

  it('POST /auth/test-login is NOT registered when token is unset', async () => {
    const res = await fetch(`${booted.url}/auth/test-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'whatever' }),
    });
    assert.equal(res.status, 404);
  });
});

// ══════════════════════════════════════════════════════════
// Item 2 — OAuth configured: /auth/login redirects to Discord with correct params
// ══════════════════════════════════════════════════════════

describe('Integration: OAuth /auth/login redirect URL', () => {
  let booted: Booted;

  before(async () => {
    cleanAuthEnv();
    process.env.DISCORD_OAUTH_SECRET = 'oauth-client-secret-dummy';
    process.env.WEB_MAP_CALLBACK_URL = 'http://127.0.0.1/auth/callback';
    process.env.WEB_MAP_SESSION_SECRET = 'x'.repeat(64);
    booted = await bootTestApp();
  });

  after(async () => {
    await booted.close();
    cleanAuthEnv();
  });

  it('redirects to https://discord.com/api/v10/oauth2/authorize with required query params', async () => {
    const res = await fetch(`${booted.url}/auth/login`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    const location = res.headers.get('location') ?? '';
    assert.ok(location.startsWith('https://discord.com/api/v10/oauth2/authorize?'), `Unexpected redirect: ${location}`);
    const params = new URL(location).searchParams;
    assert.equal(params.get('redirect_uri'), 'http://127.0.0.1/auth/callback');
    assert.equal(params.get('response_type'), 'code');
    assert.ok(params.get('scope')?.includes('identify'), 'scope should include identify');
    assert.ok(params.get('scope')?.includes('guilds'), 'scope should include guilds');
    assert.ok((params.get('state') ?? '').length >= 16, 'state should be a non-trivial random string');
  });

  it('sets hmz_oauth_state cookie on the redirect', async () => {
    const res = await fetch(`${booted.url}/auth/login`, { redirect: 'manual' });
    const setCookie = res.headers.get('set-cookie') ?? '';
    assert.match(setCookie, /hmz_oauth_state=[a-f0-9]+/);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Lax/);
  });
});

// ══════════════════════════════════════════════════════════
// Item 3 — OAuth + test-login coexistence: POST creates admin, OAuth still works
// ══════════════════════════════════════════════════════════

describe('Integration: OAuth + WEB_PANEL_TEST_AUTH_TOKEN coexistence', () => {
  const TOKEN = 'a'.repeat(64);
  let booted: Booted;

  before(async () => {
    cleanAuthEnv();
    process.env.DISCORD_OAUTH_SECRET = 'oauth-client-secret-dummy';
    process.env.WEB_MAP_CALLBACK_URL = 'http://127.0.0.1/auth/callback';
    process.env.WEB_MAP_SESSION_SECRET = 'y'.repeat(64);
    process.env.WEB_PANEL_TEST_AUTH_TOKEN = TOKEN;
    process.env.NODE_ENV = 'development';
    booted = await bootTestApp();
  });

  after(async () => {
    await booted.close();
    cleanAuthEnv();
  });

  it('POST /auth/test-login with correct token returns 200 + sets session cookie', async () => {
    const res = await fetch(`${booted.url}/auth/test-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: TOKEN, tier: 'admin' }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.ok, true);
    assert.equal(body.tier, 'admin');
    assert.equal(body.userId, 'e2e-test');
    const setCookie = res.headers.get('set-cookie') ?? '';
    assert.match(setCookie, /hmz_session=/);
  });

  it('test-login session cookie authenticates subsequent admin-guarded request', async () => {
    // Log in
    const login = await fetch(`${booted.url}/auth/test-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: TOKEN, tier: 'admin' }),
    });
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';

    const ping = await fetch(`${booted.url}/api/admin/ping`, { headers: { cookie } });
    assert.equal(ping.status, 200);

    // Sanity: without the cookie we must be rejected
    const noCookie = await fetch(`${booted.url}/api/admin/ping`);
    assert.equal(noCookie.status, 401);
  });

  it('OAuth /auth/login still redirects to Discord (test-login does not disable OAuth)', async () => {
    const res = await fetch(`${booted.url}/auth/login`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.ok((res.headers.get('location') ?? '').startsWith('https://discord.com/api/'));
  });

  it('POST /auth/test-login with wrong token returns 401 INVALID_TOKEN', async () => {
    const res = await fetch(`${booted.url}/auth/test-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'b'.repeat(64) }),
    });
    assert.equal(res.status, 401);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.error, 'INVALID_TOKEN');
  });
});

// ══════════════════════════════════════════════════════════
// Item 3b — NODE_ENV=production blocks test-login even when token is set
// ══════════════════════════════════════════════════════════

describe('Integration: NODE_ENV=production blocks /auth/test-login', () => {
  let booted: Booted;

  before(async () => {
    cleanAuthEnv();
    process.env.DISCORD_OAUTH_SECRET = 'oauth-client-secret-dummy';
    process.env.WEB_MAP_CALLBACK_URL = 'http://127.0.0.1/auth/callback';
    process.env.WEB_MAP_SESSION_SECRET = 'z'.repeat(64);
    process.env.WEB_PANEL_TEST_AUTH_TOKEN = 'a'.repeat(64);
    process.env.NODE_ENV = 'production';
    booted = await bootTestApp();
  });

  after(async () => {
    await booted.close();
    cleanAuthEnv();
  });

  it('POST /auth/test-login returns 404 (route not registered)', async () => {
    const res = await fetch(`${booted.url}/auth/test-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'a'.repeat(64) }),
    });
    assert.equal(res.status, 404);
  });
});

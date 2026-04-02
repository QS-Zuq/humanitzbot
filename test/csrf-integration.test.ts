/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-floating-promises, @typescript-eslint/no-non-null-assertion, @typescript-eslint/no-confusing-void-expression, @typescript-eslint/restrict-plus-operands */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import expressSession from 'express-session';
import cookieParser from 'cookie-parser';
import { doubleCsrf } from 'csrf-csrf';
import crypto from 'crypto';

// ── Test app setup ────────────────────────────────────────────────────────────

const testSecret = 'test-session-secret-for-csrf-tests';
const csrfSigningSecret = crypto.createHmac('sha256', testSecret).update('csrf-signing-key').digest('hex');

const { doubleCsrfProtection } = doubleCsrf({
  getSecret: () => csrfSigningSecret,
  getSessionIdentifier: (req: express.Request) => (req as any).sessionID || (req as any).session?.id || '',
  cookieName: 'hmz.csrf', // no __Host- prefix in test (not HTTPS)
  cookieOptions: {
    sameSite: 'strict',
    path: '/',
    secure: false, // test environment
    httpOnly: true,
  },
  size: 32,
  ignoredMethods: ['GET', 'HEAD', 'OPTIONS'],
  getCsrfTokenFromRequest: (req: express.Request) => req.headers['x-csrf-token'] as string,
});

function buildApp() {
  const app = express();

  app.use(
    expressSession({
      secret: testSecret,
      resave: false,
      saveUninitialized: true,
      cookie: { secure: false }, // lgtm[js/clear-text-cookie] -- test-only, no HTTPS in test env
    }),
  );

  app.use(cookieParser(testSecret));

  // Skip CSRF for /auth/callback (mirrors production config)
  app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (req.path === '/auth/callback') return next();
    doubleCsrfProtection(req, res, next);
  });

  // CSRF error handler
  app.use((err: any, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (err.code === 'EBADCSRFTOKEN') {
      return res.status(403).json({ ok: false, error: 'CSRF_REJECTED' });
    }
    next(err);
  });

  // GET /csrf-token — returns a token (also sets the CSRF cookie)
  app.get('/csrf-token', (req: express.Request, res: express.Response) => {
    res.json({ csrfToken: (req as any).csrfToken() });
  });

  // POST /test-action — protected by CSRF
  app.post('/test-action', (_req: express.Request, res: express.Response) => {
    res.json({ ok: true });
  });

  // POST /auth/callback — excluded from CSRF validation
  app.post('/auth/callback', (_req: express.Request, res: express.Response) => {
    res.json({ ok: true });
  });

  return app;
}

// ── HTTP helper ───────────────────────────────────────────────────────────────

interface RequestOpts {
  method: string;
  path: string;
  port: number;
  headers?: Record<string, string>;
}

function request(opts: RequestOpts): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port: opts.port, path: opts.path, method: opts.method, headers: opts.headers || {} },
      (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => {
          body += chunk;
        });
        res.on('end', () => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(body);
          } catch {
            parsed = body;
          }
          resolve({ status: res.statusCode!, headers: res.headers, body: parsed });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/**
 * Parse Set-Cookie headers and return a cookie string suitable for the Cookie header.
 * Also returns individual cookie values by name.
 */
function parseCookies(setCookieHeader: string | string[] | undefined): { header: string; map: Record<string, string> } {
  if (!setCookieHeader) return { header: '', map: {} };
  const entries = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  const map: Record<string, string> = {};
  for (const entry of entries) {
    const [pair] = entry.split(';');
    if (!pair) continue;
    const eqIdx = pair.indexOf('=');
    if (eqIdx === -1) continue;
    const name = pair.slice(0, eqIdx).trim();
    const value = pair.slice(eqIdx + 1).trim();
    map[name] = value;
  }
  const header = Object.entries(map)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
  return { header, map };
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('CSRF integration', () => {
  let server: http.Server;
  let port: number;

  before(
    () =>
      new Promise<void>((resolve) => {
        const app = buildApp();
        server = http.createServer(app);
        server.listen(0, '127.0.0.1', () => {
          port = (server.address() as any).port;
          resolve();
        });
      }),
  );

  after(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  );

  // ── 1. Token generation ─────────────────────────────────────────────────────

  it('GET /csrf-token returns a csrfToken and sets the CSRF cookie', async () => {
    const res = await request({ method: 'GET', path: '/csrf-token', port });

    assert.equal(res.status, 200);
    assert.ok(res.body.csrfToken, 'csrfToken field should be present');
    assert.equal(typeof res.body.csrfToken, 'string');
    assert.ok(res.body.csrfToken.length > 0);

    const setCookie = res.headers['set-cookie'];
    assert.ok(setCookie, 'Set-Cookie header should be present');
    const { map } = parseCookies(setCookie);
    assert.ok(map['hmz.csrf'], 'CSRF cookie hmz.csrf should be set');
  });

  // ── 2. Valid token accepted ─────────────────────────────────────────────────

  it('POST with valid X-CSRF-Token header and cookie returns 200', async () => {
    // Step 1: get a token + cookie
    const tokenRes = await request({ method: 'GET', path: '/csrf-token', port });
    assert.equal(tokenRes.status, 200);

    const { header: cookieHeader } = parseCookies(tokenRes.headers['set-cookie']);
    const csrfToken = tokenRes.body.csrfToken;

    // Step 2: POST with token + cookie
    const postRes = await request({
      method: 'POST',
      path: '/test-action',
      port,
      headers: {
        'x-csrf-token': csrfToken,
        Cookie: cookieHeader,
      },
    });

    assert.equal(postRes.status, 200);
    assert.equal(postRes.body.ok, true);
  });

  // ── 3. Missing token rejected ───────────────────────────────────────────────

  it('POST without X-CSRF-Token header returns 403 CSRF_REJECTED', async () => {
    // Get a valid session cookie first (so the request reaches CSRF validation)
    const tokenRes = await request({ method: 'GET', path: '/csrf-token', port });
    const { header: cookieHeader } = parseCookies(tokenRes.headers['set-cookie']);

    const postRes = await request({
      method: 'POST',
      path: '/test-action',
      port,
      headers: {
        Cookie: cookieHeader,
        // No x-csrf-token header
      },
    });

    assert.equal(postRes.status, 403);
    assert.equal(postRes.body.error, 'CSRF_REJECTED');
  });

  // ── 4. Wrong token rejected ─────────────────────────────────────────────────

  it('POST with wrong/mismatched CSRF token returns 403 CSRF_REJECTED', async () => {
    const tokenRes = await request({ method: 'GET', path: '/csrf-token', port });
    const { header: cookieHeader } = parseCookies(tokenRes.headers['set-cookie']);

    const postRes = await request({
      method: 'POST',
      path: '/test-action',
      port,
      headers: {
        'x-csrf-token': 'this-is-definitely-not-a-valid-token',
        Cookie: cookieHeader,
      },
    });

    assert.equal(postRes.status, 403);
    assert.equal(postRes.body.error, 'CSRF_REJECTED');
  });

  // ── 5. Callback exemption ───────────────────────────────────────────────────

  it('POST /auth/callback is not blocked by CSRF validation', async () => {
    // No CSRF token or cookie — should still succeed
    const postRes = await request({
      method: 'POST',
      path: '/auth/callback',
      port,
      headers: {},
    });

    assert.equal(postRes.status, 200);
    assert.equal(postRes.body.ok, true);
  });

  // ── 6. Token reuse (race condition regression) ──────────────────────────────

  it('same token works for 2 sequential POST requests (token reuse regression)', async () => {
    // Get a single token + cookie
    const tokenRes = await request({ method: 'GET', path: '/csrf-token', port });
    assert.equal(tokenRes.status, 200);

    const { header: cookieHeader } = parseCookies(tokenRes.headers['set-cookie']);
    const csrfToken = tokenRes.body.csrfToken;

    // First POST
    const first = await request({
      method: 'POST',
      path: '/test-action',
      port,
      headers: {
        'x-csrf-token': csrfToken,
        Cookie: cookieHeader,
      },
    });
    assert.equal(first.status, 200, 'First POST should succeed');

    // Second POST with same token — must also succeed (csrf-csrf is stateless, not one-time-use)
    const second = await request({
      method: 'POST',
      path: '/test-action',
      port,
      headers: {
        'x-csrf-token': csrfToken,
        Cookie: cookieHeader,
      },
    });
    assert.equal(second.status, 200, 'Second POST with same token should also succeed (token reuse must work)');
  });

  // ── 7. GET requests exempt ──────────────────────────────────────────────────

  it('GET requests succeed without any CSRF token', async () => {
    const res = await request({
      method: 'GET',
      path: '/csrf-token',
      port,
      headers: {}, // no cookie, no token
    });

    assert.equal(res.status, 200);
    assert.ok(res.body.csrfToken, 'csrfToken should be in response');
  });
});

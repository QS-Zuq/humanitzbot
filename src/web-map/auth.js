/**
 * Discord OAuth2 middleware for the web map server.
 *
 * Flow:
 *   1. Unauthenticated request → redirect to Discord OAuth2
 *   2. User authorises → Discord redirects to /auth/callback
 *   3. Server exchanges code for access token
 *   4. Server checks: user is in the guild AND has allowed role/permission
 *   5. Session stored in a signed cookie (HMAC-SHA256)
 *   6. Subsequent requests validated via cookie → in-memory session store
 *
 * No npm dependencies beyond Express — uses Node 18+ built-in fetch and crypto.
 */

const crypto = require('crypto');
const config = require('../config');

// ── Configuration ────────────────────────────────────────────────────────────

const DISCORD_API = 'https://discord.com/api/v10';
const OAUTH_SCOPES = 'identify guilds guilds.members.read';

// In-memory session store: sessionId → { userId, username, avatar, roles, expiresAt }
const sessions = new Map();
const SESSION_TTL = 24 * 60 * 60 * 1000; // 24 hours
const COOKIE_NAME = 'hmz_session';

// ── Helpers ──────────────────────────────────────────────────────────────────

function getAuthConfig() {
  return {
    clientId: config.clientId,
    clientSecret: process.env.DISCORD_OAUTH_SECRET || '',
    guildId: config.guildId,
    callbackUrl: process.env.WEB_MAP_CALLBACK_URL || '',
    sessionSecret: process.env.WEB_MAP_SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
    allowedRoles: (process.env.WEB_MAP_ALLOWED_ROLES || '').split(',').map(s => s.trim()).filter(Boolean),
  };
}

function signSession(sessionId, secret) {
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(sessionId);
  return sessionId + '.' + hmac.digest('hex');
}

function verifySession(signedValue, secret) {
  const dot = signedValue.lastIndexOf('.');
  if (dot === -1) return null;
  const sessionId = signedValue.substring(0, dot);
  const expected = signSession(sessionId, secret);
  // Constant-time comparison
  if (signedValue.length !== expected.length) return null;
  if (crypto.timingSafeEqual(Buffer.from(signedValue), Buffer.from(expected))) {
    return sessionId;
  }
  return null;
}

function parseCookies(header) {
  const cookies = {};
  if (!header) return cookies;
  for (const pair of header.split(';')) {
    const [name, ...rest] = pair.trim().split('=');
    if (name) cookies[name.trim()] = rest.join('=').trim();
  }
  return cookies;
}

function pruneExpiredSessions() {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (session.expiresAt < now) sessions.delete(id);
  }
}

// Prune every 10 minutes
setInterval(pruneExpiredSessions, 10 * 60 * 1000).unref();

// ── Discord API helpers ──────────────────────────────────────────────────────

async function exchangeCode(code, authCfg) {
  const body = new URLSearchParams({
    client_id: authCfg.clientId,
    client_secret: authCfg.clientSecret,
    grant_type: 'authorization_code',
    code,
    redirect_uri: authCfg.callbackUrl,
  });

  const res = await fetch(`${DISCORD_API}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }

  return res.json();
}

async function getUser(accessToken) {
  const res = await fetch(`${DISCORD_API}/users/@me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Failed to fetch user (${res.status})`);
  return res.json();
}

async function getGuildMember(accessToken, guildId) {
  const res = await fetch(`${DISCORD_API}/users/@me/guilds/${guildId}/member`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (res.status === 404) return null; // not in guild
  if (!res.ok) throw new Error(`Failed to fetch guild member (${res.status})`);
  return res.json();
}

// ── Authorization check ──────────────────────────────────────────────────────

/**
 * Check if a guild member is authorised to access the web map.
 *
 * Logic:
 *   1. If WEB_MAP_ALLOWED_ROLES is set → user must have at least one of those roles
 *   2. If WEB_MAP_ALLOWED_ROLES is empty → user must have Administrator permission
 *      (checks guild-level permissions via the member's roles' permission bits)
 *
 * @param {object} member - Discord guild member object
 * @param {string[]} allowedRoles - Role IDs from config
 * @returns {boolean}
 */
function isAuthorised(member, allowedRoles) {
  if (!member) return false;

  // If specific roles are configured, check those
  if (allowedRoles.length > 0) {
    return member.roles.some(roleId => allowedRoles.includes(roleId));
  }

  // Default: require Administrator permission
  // Discord permission bit 0x8 = Administrator
  const permissions = BigInt(member.permissions || '0');
  return (permissions & 0x8n) !== 0n;
}

// ── Middleware & Routes ──────────────────────────────────────────────────────

/**
 * Check if Discord OAuth2 is configured.
 * Returns true if the minimum required env vars are set.
 */
function isEnabled() {
  return !!(process.env.DISCORD_OAUTH_SECRET && process.env.WEB_MAP_CALLBACK_URL);
}

/**
 * Register auth routes and return the auth middleware.
 *
 * @param {import('express').Application} app
 * @returns {import('express').RequestHandler} middleware that gates all other routes
 */
function setupAuth(app) {
  const authCfg = getAuthConfig();

  if (!authCfg.clientSecret || !authCfg.callbackUrl) {
    console.warn('[WEB MAP AUTH] Discord OAuth not configured — DISCORD_OAUTH_SECRET and WEB_MAP_CALLBACK_URL are required');
    console.warn('[WEB MAP AUTH] All routes are UNPROTECTED. Set these env vars to enable authentication.');
    // Return a no-op middleware
    return (_req, _res, next) => next();
  }

  const authorizeUrl = `${DISCORD_API}/oauth2/authorize?` + new URLSearchParams({
    client_id: authCfg.clientId,
    redirect_uri: authCfg.callbackUrl,
    response_type: 'code',
    scope: OAUTH_SCOPES,
  }).toString();

  console.log(`[WEB MAP AUTH] Discord OAuth enabled — callback: ${authCfg.callbackUrl}`);
  if (authCfg.allowedRoles.length > 0) {
    console.log(`[WEB MAP AUTH] Allowed roles: ${authCfg.allowedRoles.join(', ')}`);
  } else {
    console.log(`[WEB MAP AUTH] No WEB_MAP_ALLOWED_ROLES set — requiring Administrator permission`);
  }

  // ── Auth routes (unprotected) ──

  app.get('/auth/login', (_req, res) => {
    res.redirect(authorizeUrl);
  });

  app.get('/auth/callback', async (req, res) => {
    const { code } = req.query;
    if (!code) return res.status(400).send('Missing authorization code');

    try {
      // Exchange code for token
      const tokenData = await exchangeCode(code, authCfg);
      const accessToken = tokenData.access_token;

      // Get user info
      const user = await getUser(accessToken);

      // Check guild membership + role/permission
      const member = await getGuildMember(accessToken, authCfg.guildId);
      if (!member) {
        return res.status(403).send(`
          <h2>Access Denied</h2>
          <p>You are not a member of the required Discord server.</p>
          <a href="/auth/login">Try again</a>
        `);
      }

      if (!isAuthorised(member, authCfg.allowedRoles)) {
        const requirement = authCfg.allowedRoles.length > 0
          ? 'a required Discord role'
          : 'the Administrator permission';
        return res.status(403).send(`
          <h2>Access Denied</h2>
          <p>You don't have ${requirement} in the Discord server.</p>
          <a href="/auth/login">Try again</a>
        `);
      }

      // Create session
      const sessionId = crypto.randomBytes(32).toString('hex');
      sessions.set(sessionId, {
        userId: user.id,
        username: user.username,
        avatar: user.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png` : null,
        roles: member.roles,
        expiresAt: Date.now() + SESSION_TTL,
      });

      // Set signed cookie
      const signed = signSession(sessionId, authCfg.sessionSecret);
      res.setHeader('Set-Cookie', `${COOKIE_NAME}=${signed}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL / 1000}`);
      res.redirect('/');

    } catch (err) {
      console.error('[WEB MAP AUTH] OAuth callback error:', err.message);
      res.status(500).send(`
        <h2>Authentication Error</h2>
        <p>${err.message}</p>
        <a href="/auth/login">Try again</a>
      `);
    }
  });

  app.get('/auth/logout', (_req, res) => {
    // Clear cookie
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
    res.send('<h2>Logged out</h2><a href="/auth/login">Log in again</a>');
  });

  app.get('/auth/me', (req, res) => {
    const session = getSession(req, authCfg.sessionSecret);
    if (!session) return res.status(401).json({ authenticated: false });
    res.json({
      authenticated: true,
      userId: session.userId,
      username: session.username,
      avatar: session.avatar,
    });
  });

  // ── Auth middleware (applied to all other routes) ──

  return (req, res, next) => {
    // Skip auth routes
    if (req.path.startsWith('/auth/')) return next();

    const session = getSession(req, authCfg.sessionSecret);
    if (!session) {
      // API requests get 401, browser requests get redirected
      if (req.path.startsWith('/api/')) {
        return res.status(401).json({ error: 'Not authenticated', login: '/auth/login' });
      }
      return res.redirect('/auth/login');
    }

    // Attach session to request for downstream use
    req.session = session;
    next();
  };
}

/**
 * Extract and validate session from request cookies.
 */
function getSession(req, secret) {
  const cookies = parseCookies(req.headers.cookie);
  const signed = cookies[COOKIE_NAME];
  if (!signed) return null;

  const sessionId = verifySession(signed, secret);
  if (!sessionId) return null;

  const session = sessions.get(sessionId);
  if (!session) return null;

  if (session.expiresAt < Date.now()) {
    sessions.delete(sessionId);
    return null;
  }

  return session;
}

module.exports = { setupAuth, isEnabled, isAuthorised, _test: { signSession, verifySession, parseCookies } };

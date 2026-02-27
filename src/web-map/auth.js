/**
 * Discord OAuth2 middleware for the web panel.
 *
 * Four access tiers:
 *   1. public   — No login required: landing page, Discord link, basic server stats
 *   2. survivor — Discord guild member with survivor role: community stats, leaderboards
 *   3. mod      — Mod role: kick, player locations, send messages
 *   4. admin    — Admin role or Administrator permission: everything (power, RCON, settings, DB)
 *
 * Role configuration via .env:
 *   WEB_PANEL_SURVIVOR_ROLES=role_id_1,role_id_2   (if empty, any guild member gets survivor)
 *   WEB_PANEL_MOD_ROLES=role_id_3
 *   WEB_PANEL_ADMIN_ROLES=role_id_4                 (if empty, falls back to Administrator permission)
 *
 * Flow:
 *   1. Unauthenticated request → public tier (landing page)
 *   2. User clicks "Login with Discord" → Discord OAuth2
 *   3. Server checks guild membership + roles → assigns highest tier
 *   4. Session stored in signed cookie (HMAC-SHA256)
 *   5. API routes check req.tier for access control
 */

const crypto = require('crypto');
const config = require('../config');

// ── Configuration ────────────────────────────────────────────────────────────

const DISCORD_API = 'https://discord.com/api/v10';
const OAUTH_SCOPES = 'identify guilds guilds.members.read';

// Access tier levels (higher = more access)
const TIER = { public: 0, survivor: 1, mod: 2, admin: 3 };

// In-memory session store: sessionId → { userId, username, avatar, roles, tier, expiresAt }
const sessions = new Map();
const SESSION_TTL = 24 * 60 * 60 * 1000; // 24 hours
const COOKIE_NAME = 'hmz_session';

// ── Helpers ──────────────────────────────────────────────────────────────────

// Persistent session secret — generated once per process lifetime if not configured.
// Falls back to env var, then generates a stable random secret for this process.
let _cachedSessionSecret;
function getSessionSecret() {
  if (_cachedSessionSecret) return _cachedSessionSecret;
  if (process.env.WEB_MAP_SESSION_SECRET) {
    _cachedSessionSecret = process.env.WEB_MAP_SESSION_SECRET;
  } else {
    console.warn('[WEB AUTH] WEB_MAP_SESSION_SECRET not set — generating random secret (sessions will not survive restarts)');
    _cachedSessionSecret = crypto.randomBytes(32).toString('hex');
  }
  return _cachedSessionSecret;
}

function getAuthConfig() {
  return {
    clientId: config.clientId,
    clientSecret: process.env.DISCORD_OAUTH_SECRET || '',
    guildId: config.guildId,
    callbackUrl: process.env.WEB_MAP_CALLBACK_URL || '',
    sessionSecret: getSessionSecret(),
    // Legacy single-tier role list (backwards compat)
    allowedRoles: (process.env.WEB_MAP_ALLOWED_ROLES || '').split(',').map(s => s.trim()).filter(Boolean),
    // Multi-tier role lists
    survivorRoles: (process.env.WEB_PANEL_SURVIVOR_ROLES || '').split(',').map(s => s.trim()).filter(Boolean),
    modRoles: (process.env.WEB_PANEL_MOD_ROLES || '').split(',').map(s => s.trim()).filter(Boolean),
    adminRoles: (process.env.WEB_PANEL_ADMIN_ROLES || '').split(',').map(s => s.trim()).filter(Boolean),
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
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Failed to fetch guild member (${res.status})`);
  return res.json();
}

// ── Tier Resolution ──────────────────────────────────────────────────────────

/**
 * Determine the highest access tier for a guild member.
 *
 * Priority: admin > mod > survivor > public
 *
 * - Admin: has adminRoles OR Administrator permission (0x8)
 * - Mod: has modRoles
 * - Survivor: has survivorRoles, OR if no survivorRoles configured, any guild member
 * - Public: not in guild or no qualifying roles
 */
function resolveTier(member, authCfg) {
  if (!member) return 'public';

  const memberRoles = member.roles || [];
  const permissions = BigInt(member.permissions || '0');
  const isDiscordAdmin = (permissions & 0x8n) !== 0n;

  // Check admin tier
  if (isDiscordAdmin) return 'admin';
  if (authCfg.adminRoles.length > 0 && memberRoles.some(r => authCfg.adminRoles.includes(r))) {
    return 'admin';
  }

  // Check mod tier
  if (authCfg.modRoles.length > 0 && memberRoles.some(r => authCfg.modRoles.includes(r))) {
    return 'mod';
  }

  // Check survivor tier
  if (authCfg.survivorRoles.length > 0) {
    if (memberRoles.some(r => authCfg.survivorRoles.includes(r))) return 'survivor';
    // Has specific survivor roles configured but user doesn't have them
    return 'public';
  }

  // No survivor roles configured — any guild member gets survivor
  return 'survivor';
}

// Legacy compatibility
function isAuthorised(member, allowedRoles) {
  if (!member) return false;
  if (allowedRoles.length > 0) {
    return member.roles.some(roleId => allowedRoles.includes(roleId));
  }
  const permissions = BigInt(member.permissions || '0');
  return (permissions & 0x8n) !== 0n;
}

// ── Middleware & Routes ──────────────────────────────────────────────────────

function isEnabled() {
  return !!(process.env.DISCORD_OAUTH_SECRET && process.env.WEB_MAP_CALLBACK_URL);
}

/**
 * Register auth routes and return the tier-aware middleware.
 * Public routes (landing page, basic stats) are always accessible.
 * Higher-tier routes require authentication + appropriate role.
 */
function setupAuth(app, client) {
  const authCfg = getAuthConfig();

  if (!authCfg.clientSecret || !authCfg.callbackUrl) {
    console.warn('[WEB AUTH] Discord OAuth not configured — all routes UNPROTECTED');
    // Still register /auth/me so the frontend can boot
    app.get('/auth/me', (_req, res) => {
      res.json({ authenticated: true, tier: 'admin', tierLevel: TIER.admin, username: 'Admin (no OAuth)', devMode: true });
    });
    app.get('/auth/login', (_req, res) => res.redirect('/'));
    app.get('/auth/logout', (_req, res) => res.redirect('/'));
    return (_req, _res, next) => {
      _req.tier = 'admin'; // no auth = full access (dev mode)
      _req.tierLevel = TIER.admin;
      next();
    };
  }

  console.log(`[WEB AUTH] Discord OAuth enabled — callback: ${authCfg.callbackUrl}`);
  if (authCfg.adminRoles.length > 0) console.log(`[WEB AUTH] Admin roles: ${authCfg.adminRoles.join(', ')}`);
  if (authCfg.modRoles.length > 0) console.log(`[WEB AUTH] Mod roles: ${authCfg.modRoles.join(', ')}`);
  if (authCfg.survivorRoles.length > 0) console.log(`[WEB AUTH] Survivor roles: ${authCfg.survivorRoles.join(', ')}`);
  else console.log(`[WEB AUTH] No survivor roles set — any guild member gets survivor access`);

  // ── Auth routes (always accessible) ──

  app.get('/auth/login', (_req, res) => {
    // Generate CSRF state parameter
    const state = crypto.randomBytes(16).toString('hex');
    // Store state in a short-lived cookie
    res.setHeader('Set-Cookie', `hmz_oauth_state=${state}; HttpOnly; SameSite=Lax; Path=/; Max-Age=300`);
    const url = `${DISCORD_API}/oauth2/authorize?` + new URLSearchParams({
      client_id: authCfg.clientId,
      redirect_uri: authCfg.callbackUrl,
      response_type: 'code',
      scope: OAUTH_SCOPES,
      state,
    }).toString();
    res.redirect(url);
  });

  app.get('/auth/callback', async (req, res) => {
    const { code, state } = req.query;
    if (!code) return res.status(400).send('Missing authorization code');

    // Verify CSRF state parameter (timing-safe comparison)
    const cookies = parseCookies(req.headers.cookie);
    const expectedState = cookies['hmz_oauth_state'];
    if (!state || !expectedState || state.length !== expectedState.length ||
        !crypto.timingSafeEqual(Buffer.from(state), Buffer.from(expectedState))) {
      return res.status(403).send('<h2>Invalid OAuth State</h2><p>Please try logging in again.</p><a href="/auth/login">Login</a>');
    }
    // Clear state cookie
    res.setHeader('Set-Cookie', 'hmz_oauth_state=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');

    try {
      const tokenData = await exchangeCode(code, authCfg);
      const accessToken = tokenData.access_token;
      const user = await getUser(accessToken);
      const member = await getGuildMember(accessToken, authCfg.guildId);

      const tier = resolveTier(member, authCfg);

      // Create session even for public tier (so we know they tried)
      const sessionId = crypto.randomBytes(32).toString('hex');
      sessions.set(sessionId, {
        userId: user.id,
        username: user.username,
        displayName: user.global_name || user.username,
        avatar: user.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png` : null,
        roles: member?.roles || [],
        tier,
        tierLevel: TIER[tier],
        inGuild: !!member,
        expiresAt: Date.now() + SESSION_TTL,
      });

      const signed = signSession(sessionId, authCfg.sessionSecret);
      const isSecure = authCfg.callbackUrl.startsWith('https');
      const cookieFlags = `HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL / 1000}` + (isSecure ? '; Secure' : '');
      res.setHeader('Set-Cookie', `${COOKIE_NAME}=${signed}; ${cookieFlags}`);
      res.redirect('/');

    } catch (err) {
      console.error('[WEB AUTH] OAuth callback error:', err.message);
      // Escape error message to prevent XSS
      const safeMsg = (err.message || 'Unknown error').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
      res.status(500).send(`<h2>Authentication Error</h2><p>${safeMsg}</p><a href="/auth/login">Try again</a>`);
    }
  });

  app.get('/auth/logout', (req, res) => {
    // Destroy session if present
    const cookies = parseCookies(req.headers.cookie);
    const signed = cookies[COOKIE_NAME];
    if (signed) {
      const sessionId = verifySession(signed, authCfg.sessionSecret);
      if (sessionId) sessions.delete(sessionId);
    }
    const isSecure = authCfg.callbackUrl.startsWith('https');
    const flags = `HttpOnly; SameSite=Lax; Path=/; Max-Age=0` + (isSecure ? '; Secure' : '');
    res.setHeader('Set-Cookie', [`${COOKIE_NAME}=; ${flags}`, `hmz_oauth_state=; ${flags}`]);
    res.redirect('/');
  });

  app.get('/auth/me', (req, res) => {
    const session = getSession(req, authCfg.sessionSecret);
    if (!session) {
      return res.json({ authenticated: false, tier: 'public', tierLevel: 0 });
    }
    res.json({
      authenticated: true,
      userId: session.userId,
      username: session.username,
      displayName: session.displayName,
      avatar: session.avatar,
      tier: session.tier,
      tierLevel: session.tierLevel,
      inGuild: session.inGuild,
    });
  });

  // Re-check guild membership via the bot client (no re-auth needed).
  // Used by the frontend to detect when a non-guild user joins the Discord server.
  app.get('/auth/refresh', async (req, res) => {
    const session = getSession(req, authCfg.sessionSecret);
    if (!session) {
      return res.json({ authenticated: false, tier: 'public', tierLevel: 0 });
    }
    // Only attempt refresh if we have the bot client and a guild ID
    if (client && authCfg.guildId && session.userId) {
      try {
        const guild = client.guilds?.cache?.get(authCfg.guildId);
        if (guild) {
          const member = await guild.members.fetch(session.userId).catch(() => null);
          if (member) {
            // Convert to the format resolveTier expects
            const memberData = {
              roles: member.roles.cache.map(r => r.id),
              permissions: member.permissions.bitfield.toString(),
            };
            const newTier = resolveTier(memberData, authCfg);
            session.tier = newTier;
            session.tierLevel = TIER[newTier];
            session.inGuild = true;
            session.roles = memberData.roles;
          }
        }
      } catch (err) {
        console.warn('[WEB AUTH] Refresh guild check failed:', err.message);
      }
    }
    res.json({
      authenticated: true,
      userId: session.userId,
      username: session.username,
      displayName: session.displayName,
      avatar: session.avatar,
      tier: session.tier,
      tierLevel: session.tierLevel,
      inGuild: session.inGuild,
    });
  });

  // ── Tier-aware middleware ──
  // Sets req.tier and req.tierLevel on every request.
  // Does NOT block public routes — individual routes check tier.

  return (req, _res, next) => {
    // Skip auth routes
    if (req.path.startsWith('/auth/')) return next();

    const session = getSession(req, authCfg.sessionSecret);
    if (session) {
      req.session = session;
      req.tier = session.tier;
      req.tierLevel = session.tierLevel;
    } else {
      req.tier = 'public';
      req.tierLevel = TIER.public;
    }
    next();
  };
}

/**
 * Express middleware factory: require minimum tier for a route.
 * Usage: app.get('/api/admin/kick', requireTier('mod'), handler)
 */
function requireTier(minTier) {
  const minLevel = TIER[minTier] || 0;
  return (req, res, next) => {
    const level = req.tierLevel || 0;
    if (level >= minLevel) return next();

    if (req.tier === 'public') {
      // Not logged in
      if (req.path.startsWith('/api/')) {
        return res.status(401).json({ error: 'Authentication required', login: '/auth/login' });
      }
      return res.redirect('/auth/login');
    }

    // Logged in but insufficient tier
    if (req.path.startsWith('/api/')) {
      return res.status(403).json({ error: `Requires ${minTier} access or higher` });
    }
    return res.status(403).send(`<h2>Access Denied</h2><p>You need <strong>${minTier}</strong> access or higher.</p><a href="/">Back</a>`);
  };
}

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

module.exports = { setupAuth, requireTier, isEnabled, isAuthorised, resolveTier, TIER, _test: { signSession, verifySession, parseCookies } };

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
 * Session management via express-session with pluggable stores (memory/sqlite/redis).
 *
 * Flow:
 *   1. Unauthenticated request → public tier (landing page)
 *   2. User clicks "Login with Discord" → Discord OAuth2
 *   3. Server checks guild membership + roles → assigns highest tier
 *   4. Session managed by express-session (cookie: hmz_session)
 *   5. API routes check req.tier for access control
 */

const crypto = require('crypto');
const expressSession = require('express-session');
const csrf = require('csurf');
const config = require('../config');
const { createSessionStore } = require('./session-store-factory');

// ── Configuration ────────────────────────────────────────────────────────────

const DISCORD_API = 'https://discord.com/api/v10';
const OAUTH_SCOPES = 'identify guilds guilds.members.read';

// Access tier levels (higher = more access)
const TIER = { public: 0, survivor: 1, mod: 2, admin: 3 };

const COOKIE_NAME = 'hmz_session';
const ROLE_REFRESH_INTERVAL = 5 * 60 * 1000; // Re-check Discord roles every 5 minutes

// ── Helpers ──────────────────────────────────────────────────────────────────

// Persistent session secret — generated once per process lifetime if not configured.
// Falls back to env var, then generates a stable random secret for this process.
let _cachedSessionSecret;
function getSessionSecret() {
  if (_cachedSessionSecret) return _cachedSessionSecret;
  if (process.env.WEB_MAP_SESSION_SECRET) {
    _cachedSessionSecret = process.env.WEB_MAP_SESSION_SECRET;
  } else {
    console.warn(
      '[AUTH] WEB_MAP_SESSION_SECRET not set — generating random secret (sessions will not survive restarts)',
    );
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
    allowedRoles: (process.env.WEB_MAP_ALLOWED_ROLES || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    // Multi-tier role lists
    survivorRoles: (process.env.WEB_PANEL_SURVIVOR_ROLES || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    modRoles: (process.env.WEB_PANEL_MOD_ROLES || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    adminRoles: (process.env.WEB_PANEL_ADMIN_ROLES || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

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
  if (authCfg.adminRoles.length > 0 && memberRoles.some((r) => authCfg.adminRoles.includes(r))) {
    return 'admin';
  }

  // Check mod tier
  if (authCfg.modRoles.length > 0 && memberRoles.some((r) => authCfg.modRoles.includes(r))) {
    return 'mod';
  }

  // Check survivor tier
  if (authCfg.survivorRoles.length > 0) {
    if (memberRoles.some((r) => authCfg.survivorRoles.includes(r))) return 'survivor';
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
    return member.roles.some((roleId) => allowedRoles.includes(roleId));
  }
  const permissions = BigInt(member.permissions || '0');
  return (permissions & 0x8n) !== 0n;
}

// ── Middleware & Routes ──────────────────────────────────────────────────────

function isEnabled() {
  return !!(process.env.DISCORD_OAUTH_SECRET && process.env.WEB_MAP_CALLBACK_URL);
}

/**
 * HTML-escape a string to prevent XSS in error pages.
 */
function escapeHtml(str) {
  return (str || 'Unknown error').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

/**
 * Register auth routes and return the tier-aware middleware.
 * Public routes (landing page, basic stats) are always accessible.
 * Higher-tier routes require authentication + appropriate role.
 *
 * @param {object} app - Express app
 * @param {object} [client] - Discord.js client (for role refresh from guild cache)
 * @param {object} [opts] - Options
 * @param {import('better-sqlite3').Database} [opts.db] - SQLite DB instance for session store
 */
function setupAuth(app, client, opts = {}) {
  const authCfg = getAuthConfig();

  if (!authCfg.clientSecret || !authCfg.callbackUrl) {
    console.warn('[AUTH] Discord OAuth not configured — all routes UNPROTECTED');
    // Still register /auth/me so the frontend can boot
    app.get('/auth/me', (_req, res) => {
      res.json({
        authenticated: true,
        tier: 'admin',
        tierLevel: TIER.admin,
        username: 'Admin (no OAuth)',
        devMode: true,
      });
    });
    app.get('/auth/login', (_req, res) => res.redirect('/'));
    app.get('/auth/logout', (_req, res) => res.redirect('/'));
    return (_req, _res, next) => {
      _req.tier = 'admin'; // no auth = full access (dev mode)
      _req.tierLevel = TIER.admin;
      next();
    };
  }

  // ── express-session setup ──
  const sessionTtl = config.sessionTtl || 604800; // seconds (default 7 days)
  const isSecure = authCfg.callbackUrl.startsWith('https');
  const store = createSessionStore(config, opts.db);

  app.use(
    expressSession({
      name: COOKIE_NAME,
      secret: authCfg.sessionSecret,
      store: store || undefined,
      resave: false,
      saveUninitialized: false,
      rolling: false,
      cookie: {
        httpOnly: true,
        secure: isSecure,
        sameSite: 'lax',
        maxAge: sessionTtl * 1000, // convert seconds → ms
        path: '/',
      },
    }),
  );

  // Same-origin enforcement for mutating requests (CSRF protection via Origin/Referer check)
  app.use((req, res, next) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
    if (req.path === '/auth/callback') return next();

    const origin = req.get('origin') || req.get('referer');
    if (!origin) return next();

    try {
      const requestOrigin = new URL(origin).origin;
      const appOrigin = new URL(authCfg.callbackUrl).origin;
      if (requestOrigin !== appOrigin) {
        return res.status(403).json({ ok: false, error: 'CSRF_REJECTED', message: 'Cross-origin request blocked' });
      }
    } catch (_) {
      return res.status(403).json({ ok: false, error: 'CSRF_REJECTED', message: 'Invalid origin header' });
    }
    next();
  });

  // CSRF token protection (csurf uses session to store the secret)
  const csrfProtection = csrf();
  app.use((req, res, next) => {
    if (req.path === '/auth/callback') return next();
    csrfProtection(req, res, next);
  });

  // CSRF validation error handler
  app.use((err, req, res, next) => {
    if (err.code === 'EBADCSRFTOKEN') {
      return res.status(403).json({ ok: false, error: 'CSRF_REJECTED', message: 'Invalid or missing CSRF token' });
    }
    next(err);
  });

  console.log(`[AUTH] Discord OAuth enabled — callback: ${authCfg.callbackUrl}`);
  console.log(`[AUTH] Session store: ${config.sessionStore || 'sqlite'}, TTL: ${sessionTtl}s`);
  if (authCfg.adminRoles.length > 0) console.log(`[AUTH] Admin roles: ${authCfg.adminRoles.join(', ')}`);
  if (authCfg.modRoles.length > 0) console.log(`[AUTH] Mod roles: ${authCfg.modRoles.join(', ')}`);
  if (authCfg.survivorRoles.length > 0) console.log(`[AUTH] Survivor roles: ${authCfg.survivorRoles.join(', ')}`);
  else console.log(`[AUTH] No survivor roles set — any guild member gets survivor access`);

  // ── Auth routes (always accessible) ──

  app.get('/auth/login', (req, res) => {
    // Generate CSRF state parameter and store in session
    const state = crypto.randomBytes(16).toString('hex');
    // Store state in a short-lived cookie (separate from session, works before session exists)
    res.setHeader('Set-Cookie', `hmz_oauth_state=${state}; HttpOnly; SameSite=Lax; Path=/; Max-Age=300`);
    const url =
      `${DISCORD_API}/oauth2/authorize?` +
      new URLSearchParams({
        client_id: authCfg.clientId,
        redirect_uri: authCfg.callbackUrl,
        response_type: 'code',
        scope: OAUTH_SCOPES,
        state,
      }).toString();
    res.redirect(url);
  });

  app.get('/auth/callback', async (req, res) => {
    const { code, state, error, error_description } = req.query;

    // Handle OAuth errors (e.g. user denied access, expired link)
    if (error) {
      // Clear state cookie on error
      res.setHeader('Set-Cookie', 'hmz_oauth_state=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
      if (error === 'access_denied') {
        // User clicked "Cancel" on Discord's authorization page — just redirect home
        return res.redirect('/');
      }
      const safeDesc = escapeHtml(error_description || error);
      return res.status(400).send(`<h2>Authorization Error</h2><p>${safeDesc}</p><a href="/auth/login">Try again</a>`);
    }
    if (!code) return res.status(400).send('Missing authorization code');

    // Verify CSRF state parameter (timing-safe comparison)
    const cookies = _parseCookies(req.headers.cookie);
    const expectedState = cookies['hmz_oauth_state'];
    if (
      !state ||
      !expectedState ||
      state.length !== expectedState.length ||
      !crypto.timingSafeEqual(Buffer.from(state), Buffer.from(expectedState))
    ) {
      return res
        .status(403)
        .send('<h2>Invalid OAuth State</h2><p>Please try logging in again.</p><a href="/auth/login">Login</a>');
    }
    // Clear state cookie
    res.setHeader('Set-Cookie', 'hmz_oauth_state=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');

    try {
      const tokenData = await exchangeCode(code, authCfg);
      const accessToken = tokenData.access_token;
      const user = await getUser(accessToken);
      const member = await getGuildMember(accessToken, authCfg.guildId);

      const tier = resolveTier(member, authCfg);

      // Store user data in express-session (no Discord tokens stored — security)
      req.session.user = {
        userId: user.id,
        username: user.username,
        displayName: user.global_name || user.username,
        avatar: user.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png` : null,
        roles: member?.roles || [],
        tier,
        tierLevel: TIER[tier],
        inGuild: !!member,
        lastRoleCheck: Date.now(),
      };

      // Explicitly save before redirect to ensure persistent stores have flushed
      req.session.save((err) => {
        if (err) console.error('[AUTH] Session save error after OAuth:', err.message);
        res.redirect('/');
      });
    } catch (err) {
      console.error('[AUTH] OAuth callback error:', err.message);
      const safeMsg = escapeHtml(err.message);
      res.status(500).send(`<h2>Authentication Error</h2><p>${safeMsg}</p><a href="/auth/login">Try again</a>`);
    }
  });

  app.get('/auth/logout', (req, res) => {
    req.session.destroy((err) => {
      if (err) console.error('[AUTH] Session destroy error:', err.message);
      const cookieOpts = { httpOnly: true, sameSite: 'lax', secure: isSecure, path: '/' };
      res.clearCookie(COOKIE_NAME, cookieOpts);
      res.clearCookie('hmz_oauth_state', cookieOpts);
      res.redirect('/');
    });
  });

  app.get('/auth/me', (req, res) => {
    const user = req.session?.user;
    if (!user) {
      return res.json({ authenticated: false, tier: 'public', tierLevel: 0, csrfToken: req.csrfToken() });
    }
    res.json({
      authenticated: true,
      userId: user.userId,
      username: user.username,
      displayName: user.displayName,
      avatar: user.avatar,
      tier: user.tier,
      tierLevel: user.tierLevel,
      inGuild: user.inGuild,
      csrfToken: req.csrfToken(),
    });
  });

  // Re-check guild membership via the bot client (no re-auth needed).
  // Used by the frontend to detect when a non-guild user joins the Discord server.
  app.get('/auth/refresh', async (req, res) => {
    const user = req.session?.user;
    if (!user) {
      return res.json({ authenticated: false, tier: 'public', tierLevel: 0, csrfToken: req.csrfToken() });
    }
    // Only attempt refresh if we have the bot client and a guild ID
    if (client && authCfg.guildId && user.userId) {
      try {
        const guild = client.guilds?.cache?.get(authCfg.guildId);
        if (guild) {
          const member = await guild.members.fetch(user.userId).catch(() => null);
          if (member) {
            // Convert to the format resolveTier expects
            const memberData = {
              roles: member.roles.cache.map((r) => r.id),
              permissions: member.permissions.bitfield.toString(),
            };
            const newTier = resolveTier(memberData, authCfg);
            user.tier = newTier;
            user.tierLevel = TIER[newTier];
            user.inGuild = true;
            user.roles = memberData.roles;
          } else {
            // Member left the server
            user.tier = 'public';
            user.tierLevel = TIER.public;
            user.inGuild = false;
          }
          user.lastRoleCheck = Date.now();
          // Save mutated session for persistent stores
          req.session.save((err) => {
            if (err) console.error('[AUTH] Session save error after refresh:', err.message);
          });
        }
      } catch (err) {
        console.warn('[AUTH] Refresh guild check failed:', err.message);
      }
    }
    res.json({
      authenticated: true,
      userId: user.userId,
      username: user.username,
      displayName: user.displayName,
      avatar: user.avatar,
      tier: user.tier,
      tierLevel: user.tierLevel,
      inGuild: user.inGuild,
      csrfToken: req.csrfToken(),
    });
  });

  // ── Tier-aware middleware ──
  // Sets req.tier and req.tierLevel on every request.
  // Does NOT block public routes — individual routes check tier.
  // Re-checks Discord roles every ROLE_REFRESH_INTERVAL via bot guild cache.

  return (req, _res, next) => {
    // Skip auth routes
    if (req.path.startsWith('/auth/')) return next();

    const user = req.session?.user;
    if (user) {
      // Periodically re-validate roles from the bot's guild cache (no Discord API call)
      if (client && authCfg.guildId && user.userId && Date.now() - (user.lastRoleCheck || 0) > ROLE_REFRESH_INTERVAL) {
        const guild = client.guilds?.cache?.get(authCfg.guildId);
        const member = guild?.members?.cache?.get(user.userId);
        if (member) {
          const memberData = {
            roles: member.roles.cache.map((r) => r.id),
            permissions: member.permissions.bitfield.toString(),
          };
          const newTier = resolveTier(memberData, authCfg);
          if (newTier !== user.tier) {
            console.log(`[AUTH] Role change detected for ${user.username}: ${user.tier} → ${newTier}`);
          }
          user.tier = newTier;
          user.tierLevel = TIER[newTier];
          user.roles = memberData.roles;
        } else if (guild) {
          // Member not in guild cache — they may have left the server
          user.tier = 'public';
          user.tierLevel = TIER.public;
          user.inGuild = false;
        }
        user.lastRoleCheck = Date.now();
        // Save mutated session for persistent stores
        req.session.save((err) => {
          if (err) console.error('[AUTH] Session save error after role check:', err.message);
        });
      }
      req.tier = user.tier;
      req.tierLevel = user.tierLevel;
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
    return res
      .status(403)
      .send(`<h2>Access Denied</h2><p>You need <strong>${minTier}</strong> access or higher.</p><a href="/">Back</a>`);
  };
}

// ── Internal: cookie parsing for CSRF state cookie ──────────────────────────
// express-session handles the session cookie, but we still parse the CSRF state cookie manually.

function _parseCookies(header) {
  const cookies = {};
  if (!header) return cookies;
  for (const pair of header.split(';')) {
    const [name, ...rest] = pair.trim().split('=');
    if (name) cookies[name.trim()] = rest.join('=').trim();
  }
  return cookies;
}

module.exports = {
  setupAuth,
  requireTier,
  isEnabled,
  isAuthorised,
  resolveTier,
  TIER,
  _test: { getSessionSecret, _parseCookies, getAuthConfig },
};

/**
 * Discord OAuth2 middleware for the web panel.
 */

import crypto from 'crypto';
import expressSession from 'express-session';
import { doubleCsrf } from 'csrf-csrf';
import cookieParser from 'cookie-parser';
import _defaultConfig from '../config/index.js';
import { createSessionStore } from './session-store-factory.js';

import type { Express, Request, Response, NextFunction } from 'express';

// ── Type augmentations for Express request ──────────────────────────────────

interface SessionUser {
  userId: string;
  username: string;
  displayName: string;
  avatar: string | null;
  roles: string[];
  tier: string;
  tierLevel: number | undefined;
  inGuild: boolean;
  lastRoleCheck: number;
}

interface HmzSession {
  user?: SessionUser;
  id?: string;
  save(cb: (err: Error | null) => void): void;
  destroy(cb: (err: Error | null) => void): void;
}

type HmzRequest = Request & {
  session: HmzSession & Request['session'];
  sessionID?: string;
  tier?: string;
  tierLevel?: number;
  csrfToken?: () => string;
};

// ── Configuration ────────────────────────────────────────────────────────────

const DISCORD_API = 'https://discord.com/api/v10';
const OAUTH_SCOPES = 'identify guilds guilds.members.read';

const TIER: Record<string, number> = { public: 0, survivor: 1, mod: 2, admin: 3 };

const COOKIE_NAME = 'hmz_session';
const ROLE_REFRESH_INTERVAL = 5 * 60 * 1000;

// ── Helpers ──────────────────────────────────────────────────────────────────

let _cachedSessionSecret: string | undefined;
function getSessionSecret(): string {
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

interface AuthConfig {
  clientId: string;
  clientSecret: string;
  guildId: string;
  callbackUrl: string;
  sessionSecret: string;
  allowedRoles: string[];
  survivorRoles: string[];
  modRoles: string[];
  adminRoles: string[];
}

function getAuthConfig(): AuthConfig {
  return {
    clientId: _defaultConfig.clientId ?? '',
    clientSecret: process.env.DISCORD_OAUTH_SECRET || '',
    guildId: _defaultConfig.guildId ?? '',
    callbackUrl: process.env.WEB_MAP_CALLBACK_URL || '',
    sessionSecret: getSessionSecret(),
    allowedRoles: (process.env.WEB_MAP_ALLOWED_ROLES || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
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

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token: string;
  scope: string;
}

interface DiscordUser {
  id: string;
  username: string;
  global_name?: string;
  avatar?: string;
}

interface GuildMember {
  roles: string[];
  permissions: string;
}

async function exchangeCode(code: string, authCfg: AuthConfig): Promise<TokenResponse> {
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
    throw new Error(`Token exchange failed (${String(res.status)}): ${text}`);
  }

  return res.json() as Promise<TokenResponse>;
}

async function getUser(accessToken: string): Promise<DiscordUser> {
  const res = await fetch(`${DISCORD_API}/users/@me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Failed to fetch user (${String(res.status)})`);
  return res.json() as Promise<DiscordUser>;
}

async function getGuildMember(accessToken: string, guildId: string): Promise<GuildMember | null> {
  const res = await fetch(`${DISCORD_API}/users/@me/guilds/${guildId}/member`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Failed to fetch guild member (${String(res.status)})`);
  return res.json() as Promise<GuildMember>;
}

// ── Tier Resolution ──────────────────────────────────────────────────────────

function resolveTier(member: GuildMember | null, authCfg: AuthConfig): string {
  if (!member) return 'public';

  const memberRoles: string[] = member.roles;
  const permissions = BigInt(member.permissions || '0');
  const isDiscordAdmin = (permissions & 0x8n) !== 0n;

  if (isDiscordAdmin) return 'admin';
  if (authCfg.adminRoles.length > 0 && memberRoles.some((r) => authCfg.adminRoles.includes(r))) {
    return 'admin';
  }

  if (authCfg.modRoles.length > 0 && memberRoles.some((r) => authCfg.modRoles.includes(r))) {
    return 'mod';
  }

  if (authCfg.survivorRoles.length > 0) {
    if (memberRoles.some((r) => authCfg.survivorRoles.includes(r))) return 'survivor';
    return 'public';
  }

  return 'survivor';
}

function isAuthorised(member: GuildMember | null, allowedRoles: string[]): boolean {
  if (!member) return false;
  if (allowedRoles.length > 0) {
    return member.roles.some((roleId: string) => allowedRoles.includes(roleId));
  }
  const permissions = BigInt(member.permissions || '0');
  return (permissions & 0x8n) !== 0n;
}

// ── Middleware & Routes ──────────────────────────────────────────────────────

function isEnabled(): boolean {
  return !!(process.env.DISCORD_OAUTH_SECRET && process.env.WEB_MAP_CALLBACK_URL);
}

function escapeHtml(str: string | undefined): string {
  const lookup: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return (str || 'Unknown error').replace(/[&<>"']/g, (c) => lookup[c] || c);
}

interface DiscordClient {
  guilds?: {
    cache?: {
      get(id: string): DiscordGuild | undefined;
    };
  };
}

interface DiscordGuild {
  members: {
    cache: {
      get(id: string): DiscordGuildMember | undefined;
    };
    fetch(id: string): Promise<DiscordGuildMember | null>;
  };
}

interface DiscordGuildMember {
  roles: {
    cache: { map<T>(fn: (r: { id: string }) => T): T[] };
  };
  permissions: {
    bitfield: bigint;
  };
}

function setupAuth(
  app: Express,
  client: DiscordClient | null,
  opts: { db?: unknown } = {},
): (req: Request, res: Response, next: NextFunction) => void {
  const authCfg = getAuthConfig();

  if (!authCfg.clientSecret || !authCfg.callbackUrl) {
    const allowNoAuth = !!process.env['WEB_PANEL_ALLOW_NO_AUTH'];

    if (allowNoAuth) {
      console.warn('[AUTH] Discord OAuth not configured — dev mode active (WEB_PANEL_ALLOW_NO_AUTH)');
      // Stub session so req.session.user/username don't crash in route handlers
      const devSession = {
        user: { displayName: 'Developer', username: 'Developer' },
        username: 'Developer',
        discordId: 'dev',
        save(_cb: (err: Error | null) => void) {
          _cb(null);
        },
        destroy(_cb: (err: Error | null) => void) {
          _cb(null);
        },
      };
      app.use((_req: Request, _res: Response, next: NextFunction) => {
        Object.assign(_req, { session: devSession });
        next();
      });
      app.get('/auth/me', (_req: Request, res: Response) => {
        res.json({
          authenticated: true,
          tier: 'admin',
          tierLevel: TIER['admin'],
          username: 'Developer',
          devMode: true,
        });
      });
      app.get('/auth/login', (_req: Request, res: Response) => {
        res.redirect('/');
      });
      app.get('/auth/logout', (_req: Request, res: Response) => {
        res.redirect('/');
      });
      return (_req: Request, _res: Response, next: NextFunction) => {
        const hmzReq = _req as HmzRequest;
        hmzReq.tier = 'admin';
        hmzReq.tierLevel = TIER['admin'];
        next();
      };
    }

    console.warn('[AUTH] Discord OAuth not configured — web panel login disabled');
    console.warn('[AUTH] Set DISCORD_OAUTH_SECRET + WEB_MAP_CALLBACK_URL in .env to enable');
    app.get('/auth/me', (_req: Request, res: Response) => {
      res.json({
        authenticated: false,
        tier: 'public',
        tierLevel: TIER['public'],
        oauthNotConfigured: true,
      });
    });
    app.get('/auth/login', (_req: Request, res: Response) => {
      res.redirect('/');
    });
    app.get('/auth/logout', (_req: Request, res: Response) => {
      res.redirect('/');
    });
    return (_req: Request, _res: Response, next: NextFunction) => {
      const hmzReq = _req as HmzRequest;
      hmzReq.tier = 'public';
      hmzReq.tierLevel = TIER['public'];
      next();
    };
  }

  // ── express-session setup ──
  const sessionTtl = _defaultConfig.sessionTtl || 604800;
  const isSecure = authCfg.callbackUrl.startsWith('https');
  const store = createSessionStore(_defaultConfig, opts.db);

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
        maxAge: sessionTtl * 1000,
        path: '/',
      },
    }),
  );

  // Same-origin enforcement for mutating requests
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      next();
      return;
    }
    if (req.path === '/auth/callback') {
      next();
      return;
    }

    const origin = req.get('origin') || req.get('referer');
    if (!origin) {
      next();
      return;
    }

    try {
      const requestOrigin = new URL(origin).origin;
      const appOrigin = new URL(authCfg.callbackUrl).origin;
      if (requestOrigin !== appOrigin) {
        return res.status(403).json({ ok: false, error: 'CSRF_REJECTED', message: 'Cross-origin request blocked' });
      }
    } catch {
      return res.status(403).json({ ok: false, error: 'CSRF_REJECTED', message: 'Invalid origin header' });
    }
    next();
  });

  // CSRF protection
  app.use(cookieParser(authCfg.sessionSecret));
  const csrfSigningSecret = crypto.createHmac('sha256', authCfg.sessionSecret).update('csrf-signing-key').digest('hex');
  const { doubleCsrfProtection } = doubleCsrf({
    getSecret: () => csrfSigningSecret,
    getSessionIdentifier: (req: Request) => {
      const hmzReq = req as HmzRequest;
      return hmzReq.sessionID || hmzReq.session.id || '';
    },
    cookieName: isSecure ? '__Host-hmz.csrf' : 'hmz.csrf',
    cookieOptions: {
      sameSite: 'strict',
      path: '/',
      secure: isSecure,
      httpOnly: true,
    },
    size: 32,
    ignoredMethods: ['GET', 'HEAD', 'OPTIONS'],
    getCsrfTokenFromRequest: (req: Request) => req.headers['x-csrf-token'] as string,
  });
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.path === '/auth/callback') {
      next();
      return;
    }
    doubleCsrfProtection(req, res, next);
  });
  app.use((err: Error & { code?: string }, req: Request, res: Response, next: NextFunction) => {
    if (err.code === 'EBADCSRFTOKEN') {
      console.warn(`[AUTH] CSRF rejected: ${req.method} ${req.originalUrl}`);
      return res.status(403).json({ ok: false, error: 'CSRF_REJECTED', message: 'Invalid or missing CSRF token' });
    }
    next(err);
  });

  console.log(`[AUTH] Discord OAuth enabled — callback: ${authCfg.callbackUrl}`);
  console.log(`[AUTH] Session store: ${_defaultConfig.sessionStore || 'sqlite'}, TTL: ${sessionTtl}s`);
  if (authCfg.adminRoles.length > 0) console.log(`[AUTH] Admin roles: ${authCfg.adminRoles.join(', ')}`);
  if (authCfg.modRoles.length > 0) console.log(`[AUTH] Mod roles: ${authCfg.modRoles.join(', ')}`);
  if (authCfg.survivorRoles.length > 0) console.log(`[AUTH] Survivor roles: ${authCfg.survivorRoles.join(', ')}`);
  else console.log(`[AUTH] No survivor roles set — any guild member gets survivor access`);

  // ── Auth routes ──
  app.get('/auth/login', (_req: Request, res: Response) => {
    const state = crypto.randomBytes(16).toString('hex');
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

  app.get('/auth/callback', async (req: Request, res: Response) => {
    const hmzReq = req as HmzRequest;
    const { code, state, error, error_description } = req.query;

    if (error) {
      res.setHeader('Set-Cookie', 'hmz_oauth_state=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
      if (error === 'access_denied') {
        res.redirect('/');
        return;
      }
      const safeDesc = escapeHtml(error_description as string | undefined);
      return res.status(400).send(`<h2>Authorization Error</h2><p>${safeDesc}</p><a href="/auth/login">Try again</a>`);
    }
    if (!code) return res.status(400).send('Missing authorization code');

    const cookies = _parseCookies(req.headers.cookie);
    const expectedState = cookies['hmz_oauth_state'];
    if (
      !state ||
      !expectedState ||
      typeof state !== 'string' ||
      typeof expectedState !== 'string' ||
      state.length !== expectedState.length ||
      !crypto.timingSafeEqual(Buffer.from(state), Buffer.from(expectedState))
    ) {
      return res
        .status(403)
        .send('<h2>Invalid OAuth State</h2><p>Please try logging in again.</p><a href="/auth/login">Login</a>');
    }
    res.setHeader('Set-Cookie', 'hmz_oauth_state=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');

    try {
      const tokenData = await exchangeCode(code as string, authCfg);
      const accessToken = tokenData.access_token;
      const user = await getUser(accessToken);
      const member = await getGuildMember(accessToken, authCfg.guildId);

      const tier = resolveTier(member, authCfg);

      hmzReq.session.user = {
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

      hmzReq.session.save((err: Error | null) => {
        if (err) console.error('[AUTH] Session save error after OAuth:', err.message);
        res.redirect('/');
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[AUTH] OAuth callback error:', msg);
      const safeMsg = escapeHtml(msg);
      res.status(500).send(`<h2>Authentication Error</h2><p>${safeMsg}</p><a href="/auth/login">Try again</a>`);
    }
  });

  app.get('/auth/logout', (req: Request, res: Response) => {
    const hmzReq = req as HmzRequest;
    hmzReq.session.destroy((err: Error | null) => {
      if (err) console.error('[AUTH] Session destroy error:', err.message);
      const cookieOpts = { httpOnly: true, sameSite: 'lax' as const, secure: isSecure, path: '/' };
      res.clearCookie(COOKIE_NAME, cookieOpts);
      res.clearCookie('hmz_oauth_state', cookieOpts);
      res.redirect('/');
    });
  });

  app.get('/auth/me', (req: Request, res: Response) => {
    const hmzReq = req as HmzRequest;
    const user = hmzReq.session.user;
    if (!user) {
      return res.json({ authenticated: false, tier: 'public', tierLevel: 0, csrfToken: hmzReq.csrfToken?.() });
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
      csrfToken: hmzReq.csrfToken?.(),
    });
  });

  app.get('/auth/refresh', async (req: Request, res: Response) => {
    const hmzReq = req as HmzRequest;
    const user = hmzReq.session.user;
    if (!user) {
      return res.json({ authenticated: false, tier: 'public', tierLevel: 0, csrfToken: hmzReq.csrfToken?.() });
    }
    if (client && authCfg.guildId && user.userId) {
      try {
        const guild = client.guilds?.cache?.get(authCfg.guildId);
        if (guild) {
          const member = await guild.members.fetch(user.userId).catch(() => null);
          if (member) {
            const memberData: GuildMember = {
              roles: member.roles.cache.map((r: { id: string }) => r.id),
              permissions: member.permissions.bitfield.toString(),
            };
            const newTier = resolveTier(memberData, authCfg);
            user.tier = newTier;
            user.tierLevel = TIER[newTier];
            user.inGuild = true;
            user.roles = memberData.roles;
          } else {
            user.tier = 'public';
            user.tierLevel = TIER['public'];
            user.inGuild = false;
          }
          user.lastRoleCheck = Date.now();
          hmzReq.session.save((err: Error | null) => {
            if (err) console.error('[AUTH] Session save error after refresh:', err.message);
          });
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn('[AUTH] Refresh guild check failed:', msg);
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
      csrfToken: hmzReq.csrfToken?.(),
    });
  });

  // ── Tier-aware middleware ──
  return (req: Request, _res: Response, next: NextFunction) => {
    if (req.path.startsWith('/auth/')) {
      next();
      return;
    }

    const hmzReq = req as HmzRequest;
    const user = hmzReq.session.user;
    if (user) {
      if (client && authCfg.guildId && user.userId && Date.now() - (user.lastRoleCheck || 0) > ROLE_REFRESH_INTERVAL) {
        const guild = client.guilds?.cache?.get(authCfg.guildId);
        const member = guild?.members.cache.get(user.userId);
        if (member) {
          const memberData: GuildMember = {
            roles: member.roles.cache.map((r: { id: string }) => r.id),
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
          user.tier = 'public';
          user.tierLevel = TIER['public'];
          user.inGuild = false;
        }
        user.lastRoleCheck = Date.now();
        hmzReq.session.save((err: Error | null) => {
          if (err) console.error('[AUTH] Session save error after role check:', err.message);
        });
      }
      hmzReq.tier = user.tier;
      hmzReq.tierLevel = user.tierLevel;
    } else {
      hmzReq.tier = 'public';
      hmzReq.tierLevel = TIER['public'];
    }
    next();
  };
}

function requireTier(minTier: string): (req: Request, res: Response, next: NextFunction) => void {
  const minLevel = TIER[minTier] || 0;
  return (req: Request, res: Response, next: NextFunction) => {
    const hmzReq = req as HmzRequest;
    const level = hmzReq.tierLevel || 0;
    if (level >= minLevel) {
      next();
      return;
    }

    if (hmzReq.tier === 'public') {
      if (req.path.startsWith('/api/')) {
        return res.status(401).json({ error: 'Authentication required', login: '/auth/login' });
      }
      res.redirect('/auth/login');
      return;
    }

    if (req.path.startsWith('/api/')) {
      return res.status(403).json({ error: `Requires ${minTier} access or higher` });
    }
    return res
      .status(403)
      .send(`<h2>Access Denied</h2><p>You need <strong>${minTier}</strong> access or higher.</p><a href="/">Back</a>`);
  };
}

// ── Internal: cookie parsing ──────────────────────────────────────────────

function _parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const pair of header.split(';')) {
    const [name, ...rest] = pair.trim().split('=');
    if (name) cookies[name.trim()] = rest.join('=').trim();
  }
  return cookies;
}

export { setupAuth, requireTier, isEnabled, isAuthorised, resolveTier, TIER };
export type { HmzRequest, SessionUser, DiscordClient };

// Exported for testing
const _test = { getSessionSecret, _parseCookies, getAuthConfig };
export { _test };

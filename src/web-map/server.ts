/**
 * Web Map Server — Interactive Leaflet-based player map served via Express.
 *
 * Features:
 * - 4K game map as tile layer
 * - Live player positions from save data
 * - Hover/click for player stats, inventory, vitals
 * - Admin actions: kick/ban via RCON
 * - Calibration mode for coordinate mapping
 *
 * Integrates with: save-parser, player-stats, playtime-tracker, rcon
 */

import express from 'express';
import path from 'path';
import fs from 'fs';
import config from '../config/index.js';
import { parseSave, PERK_MAP } from '../parsers/save-parser.js';
import { AFFLICTION_MAP } from '../parsers/game-data.js';
import { cleanName as cleanActorName, cleanItemName, cleanItemArray } from '../parsers/ue4-names.js';
import playerStats from '../tracking/player-stats.js';
import playtime from '../tracking/playtime-tracker.js';
import rcon from '../rcon/rcon.js';
import { setupAuth, requireTier } from './auth.js';
import { API_ERRORS, sendError, sendOk } from './api-errors.js';

import type { HumanitZDB } from '../db/database.js';
import type { SaveService } from '../parsers/save-service.js';
import type { ServerScheduler } from '../modules/server-scheduler.js';
import type MultiServerManager from '../server/multi-server.js';
import type { BotControlService } from '../server/bot-control.js';
import type { Client } from 'discord.js';
import type { PanelApi } from '../server/panel-api.js';

import serverResources, { formatBytes, formatUptime } from '../server/server-resources.js';
import { ENV_CATEGORIES, ENV_CATEGORY_GROUPS, GAME_SETTINGS_CATEGORIES } from '../modules/panel-constants.js';
import { buildMigrationMap, SERVER_SCOPED_KEYS, BOOTSTRAP_KEYS, _coerce } from '../db/config-migration.js';
import { readPrivateKey } from '../utils/security.js';
import {
  getPlayerList as _getPlayerList,
  getServerInfo as _getServerInfo,
  sendAdminMessage as _sendAdminMessage,
} from '../rcon/server-info.js';
import _panelApiInstance from '../server/panel-api.js';
import { discoverPaths as _discoverPaths } from '../server/multi-server.js';
import { errMsg } from '../utils/error.js';
import { getDirname } from '../utils/paths.js';

const __dirname = getDirname(import.meta.url);

// ── Server context injected by multi-server middleware ──────────────────────

/** Resolved per-request server context (primary or multi-server instance). */
interface ServerContext {
  db: HumanitZDB | null;
  rcon: typeof rcon | { send(cmd: string): Promise<string>; connected?: boolean };
  config: typeof config;
  playerStats: typeof playerStats;
  playtime: typeof playtime;
  getPlayerList: typeof _getPlayerList;
  getServerInfo: typeof _getServerInfo;
  sendAdminMessage: typeof _sendAdminMessage;
  panelApi: PanelApi | null;
  scheduler: Record<string, unknown> | null;
  dataDir: string;
  idMap: Record<string, string>;
  isPrimary: boolean;
  serverId: string;
}

// Augment Express Request with custom properties set by auth + multi-server middleware
declare module 'express-serve-static-core' {
  interface Request {
    srv: ServerContext;
  }
}
declare module 'express-session' {
  interface SessionData {
    user?: {
      userId: string;
      username: string;
      displayName: string;
      avatar: string | null;
      roles: string[];
      tier: string;
      tierLevel?: number;
      inGuild: boolean;
      lastRoleCheck: number;
    };
    username?: string;
    discordId?: string;
  }
}

/** Minimal interface for ConfigRepository (get/set/update config documents). */
interface ConfigRepo {
  get(doc: string): Record<string, unknown> | undefined;
  set(doc: string, data: Record<string, unknown>): void;
  update(doc: string, data: Record<string, unknown>): void;
  delete(doc: string): void;
  loadAll(): Iterable<[string, { data: Record<string, unknown> }]>;
}

/** Row shape returned by better-sqlite3 .get() / .all() */
type DbRow = Record<string, unknown>;

// ── Typed DB row interfaces (match CREATE TABLE schemas in db/schema.ts) ──

interface StructureRow {
  id: number;
  actor_class: string;
  display_name: string;
  owner_steam_id: string;
  pos_x: number;
  pos_y: number;
  pos_z: number;
  current_health: number;
  max_health: number;
  upgrade_level: number;
  inventory: string;
  attached_to_trailer: number;
  no_spawn: number;
  extra_data: string;
}

interface VehicleRow {
  id: number;
  class: string;
  display_name: string;
  pos_x: number;
  pos_y: number;
  pos_z: number;
  health: number;
  max_health: number;
  fuel: number;
  inventory: string;
  upgrades: string;
  extra: string;
}

interface ContainerRow {
  actor_name: string;
  items: string;
  quick_slots: string;
  locked: number;
  does_spawn_loot: number;
  alarm_off: number;
  crafting_content: string;
  pos_x: number;
  pos_y: number;
  pos_z: number;
  extra: string;
}

interface CompanionRow {
  id: number;
  type: string;
  actor_name: string;
  owner_steam_id: string;
  pos_x: number;
  pos_y: number;
  pos_z: number;
  health: number;
  extra: string;
}

interface DeadBodyRow {
  actor_name: string;
  pos_x: number;
  pos_y: number;
  pos_z: number;
}

interface ActivityRow {
  id: number;
  type: string;
  category: string;
  actor: string;
  actor_name: string;
  item: string;
  amount: number;
  details: string;
  pos_x: number;
  pos_y: number;
  pos_z: number;
  created_at: string;
  steam_id?: string;
  target_steam_id?: string;
  target_name?: string;
}

interface ItemInstanceRow {
  id: number;
  fingerprint: string;
  item: string;
  durability: number;
  ammo: number;
  attachments: string | string[];
  cap: number;
  max_dur: number;
  location_type: string;
  location_id: string;
  location_slot: string;
  pos_x: number;
  pos_y: number;
  pos_z: number;
  amount: number;
  active: number;
  created_at: string;
  updated_at: string;
}

interface ItemGroupRow {
  id: number;
  fingerprint: string;
  item: string;
  durability: number;
  ammo: number;
  attachments: string | string[];
  cap: number;
  max_dur: number;
  location_type: string;
  location_id: string;
  location_slot: string;
  pos_x: number;
  pos_y: number;
  pos_z: number;
  quantity: number;
  active: number;
  created_at: string;
  updated_at: string;
}

interface ItemMovementRow {
  id: number;
  instance_id: number;
  item: string;
  from_type: string;
  from_id: string;
  from_slot: string;
  to_type: string;
  to_id: string;
  to_slot: string;
  amount: number;
  attributed_steam_id: string;
  attributed_name: string;
  pos_x: number;
  pos_y: number;
  pos_z: number;
  created_at: string;
}

interface DeathCauseRow {
  id: number;
  victim_name: string;
  victim_steam_id: string;
  cause_type: string;
  cause_name: string;
  cause_raw: string;
  damage_total: number;
  pos_x: number | null;
  pos_y: number | null;
  pos_z: number | null;
  created_at: string;
}

interface ChatRow {
  id: number;
  type: string;
  player_name: string;
  steam_id: string;
  message: string;
  direction: string;
  discord_user: string;
  is_admin: number;
  created_at: string;
}

interface EnvEntry {
  type: 'section' | 'keyval' | 'commented' | 'empty';
  label?: string;
  key?: string;
  value?: string;
}

// ── Rate limiter (express-rate-limit, per-IP + path) ──
import expressRateLimit from 'express-rate-limit';
function rateLimit(windowMs: number, maxReqs: number) {
  return expressRateLimit({
    windowMs,
    max: maxReqs,
    standardHeaders: false,
    legacyHeaders: false,
    keyGenerator: (req) => {
      // Normalize IPv6-mapped IPv4 (::ffff:1.2.3.4 → 1.2.3.4) for consistent rate limiting
      const raw = req.ip ?? 'unknown';
      const ip = raw.startsWith('::ffff:') ? raw.slice(7) : raw;
      return ip + ':' + req.path;
    },
    validate: { keyGeneratorIpFallback: false },
    handler: (_req, res) => {
      sendError(res, API_ERRORS.RATE_LIMITED, 429);
    },
  });
}

// ── Discovery job tracking (multi-server SFTP auto-discovery) ──
const _discoveryJobs = new Map<
  string,
  { startTime: number; state?: string; result?: unknown; error?: string | null; currentStep?: string | null }
>();
setInterval(() => {
  const now = Date.now();
  for (const [jid, job] of _discoveryJobs) {
    if (now - job.startTime > 300000) _discoveryJobs.delete(jid);
  }
}, 300000).unref();

/** Sanitize error messages for client responses — strip file paths and stack traces */
function safeError(err: unknown): string {
  const msg = err ? errMsg(err) : 'Internal server error';
  // Strip absolute paths
  return msg.replace(/\/[\w/.-]+/g, '[path]').substring(0, 200);
}

function stripControlChars(value: unknown): string {
  const input =
    value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value as string | number | boolean);
  let out = '';
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    if ((code >= 0 && code <= 8) || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127) {
      continue;
    }
    out += input[i] ?? '';
  }
  return out;
}

function sendErrorWithData(
  res: import('express').Response,
  code: string,
  data: Record<string, unknown>,
  status = 400,
  details?: string,
): void {
  const originalJson = res.json.bind(res);
  res.json = ((payload: unknown) => {
    res.json = originalJson;
    return originalJson({ ...(payload as Record<string, unknown>), ...data });
  }) as typeof res.json;
  sendError(res, code, status, details);
}

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const SERVERS_DIR = path.join(DATA_DIR, 'servers');
const SERVERS_FILE = path.join(DATA_DIR, 'servers.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const CALIBRATION_FILE = path.join(DATA_DIR, 'map-calibration.json');

/**
 * Extract a curated subset of server settings for the landing page info panel.
 * Keeps the response small — only settings that make sense to display publicly.
 * @param {object} ss — Full server_settings object from bot_state
 * @returns {object} Curated settings for frontend rendering
 */
function _extractLandingSettings(ss: Record<string, string | undefined> | null): Record<string, unknown> | null {
  if (!ss) return null;
  const n = (k: string, fb: number) => {
    const v = parseFloat(ss[k] ?? '');
    return isNaN(v) ? fb : v;
  };
  const i = (k: string, fb: number) => {
    const v = parseInt(ss[k] ?? '', 10);
    return isNaN(v) ? fb : v;
  };
  return {
    // PvP & death
    pvp: i('PVP', 0),
    onDeath: i('OnDeath', 1),
    friendlyFire: i('FriendlyFire', 0),
    // Difficulty
    zombieHealth: i('ZombieDiffHealth', 2),
    zombieSpeed: i('ZombieDiffSpeed', 2),
    zombieDamage: i('ZombieDiffDamage', 2),
    zombieAmount: n('ZombieAmountMulti', 1),
    banditHealth: i('HumanDiffHealth', 2),
    banditDamage: i('HumanDiffDamage', 2),
    banditAmount: n('HumanAmountMulti', 1),
    aiEvents: i('AIEvent', 2),
    // Loot
    rarityFood: i('RarityFood', 2),
    rarityDrink: i('RarityDrink', 2),
    rarityMelee: i('RarityMelee', 2),
    rarityRanged: i('RarityRanged', 2),
    rarityAmmo: i('RarityAmmo', 2),
    rarityArmor: i('RarityArmor', 2),
    rarityResources: i('RarityResources', 2),
    // World
    xpMultiplier: n('XpMultiplier', 1),
    dayLength: i('DayLength', 40),
    nightLength: i('NightLength', 20),
    daysPerSeason: i('DaysPerSeason', 28),
    startSeason: i('StartSeason', 3),
    // Features
    lootRespawn: i('LootRespawn', 1),
    airDrops: i('AirDrop', 1),
    dogCompanion: i('DogEnabled', 1),
    weaponBreak: i('WeaponBreak', 1),
    foodDecay: n('FoodDecay', 1),
    buildingDecay: i('BuildingDecay', 14),
    maxVehicles: i('MaxVehiclePerPlayer', 2),
    // Enriched world stats (injected by save-service)
    worldStructures: i('hmz_totalStructures', 0) || undefined,
    worldVehicles: i('hmz_totalVehicles', 0) || undefined,
    worldCompanions: i('hmz_totalCompanions', 0) || undefined,
    totalKills: i('hmz_totalKills', 0) || undefined,
  };
}

class WebMapServer {
  _client: Client;
  _app: ReturnType<typeof express>;
  _server: import('http').Server | null;
  _port: number;
  _db: HumanitZDB | null;
  _scheduler: ServerScheduler | null;
  _saveService: SaveService | null;
  _multiServerManager: MultiServerManager | null;
  _plugins: Array<Record<string, unknown>>;
  _configRepo: ConfigRepo | null;
  _worldBounds: { xMin: number; xMax: number; yMin: number; yMax: number };
  _responseCache: Map<string, { data: unknown; ts: number }>;
  _playerCache: Map<string, unknown>;
  _lastParse: number;
  _idMap: Record<string, string>;
  _botControl: BotControlService | null = null;
  _moduleStatus: Record<string, string> | null = null;
  _pollTimer: ReturnType<typeof setInterval> | null = null;
  declare setScheduler: (scheduler: ServerScheduler) => void;
  declare setSaveService: (saveService: SaveService) => void;
  declare setMultiServerManager: (msm: MultiServerManager) => void;
  declare setBotControl: (bc: BotControlService) => void;
  declare setModuleStatus: (status: Record<string, string>) => void;

  constructor(
    client: Client,
    opts: {
      db?: HumanitZDB | null;
      scheduler?: ServerScheduler | null;
      saveService?: SaveService | null;
      multiServerManager?: MultiServerManager | null;
      configRepo?: unknown;
    } = {},
  ) {
    this._client = client;
    this._app = express();
    // Trust proxy — 'loopback' for local reverse proxy (Caddy/nginx),
    // '1' or 'uniquelocal' for Pterodactyl Docker networking (Bisect bot hosting).
    // Configurable via WEB_MAP_TRUST_PROXY env var.
    const trustProxy = config.webMapTrustProxy;
    this._app.set('trust proxy', /^\d+$/.test(trustProxy) ? parseInt(trustProxy, 10) : trustProxy);
    this._server = null;
    this._port = parseInt(process.env.WEB_MAP_PORT || '', 10) || 3000;
    this._db = opts.db || null;
    this._scheduler = opts.scheduler || null;
    this._saveService = opts.saveService || null;
    this._multiServerManager = opts.multiServerManager || null;
    this._plugins = []; // Registered plugins (private modules)
    this._configRepo = (opts.configRepo || config._configRepo || null) as ConfigRepo | null;

    // World coordinate bounds — loaded from calibration file or defaults
    this._worldBounds = this._loadCalibration();

    // Setter methods — allow late-binding of dependencies that start after the web panel
    /** @param {object} scheduler ServerScheduler instance */
    this.setScheduler = (scheduler: ServerScheduler) => {
      this._scheduler = scheduler;
    };
    /** @param {object} saveService SaveService instance */
    this.setSaveService = (saveService: SaveService) => {
      this._saveService = saveService;
    };
    /** @param {object} msm MultiServerManager instance */
    this.setMultiServerManager = (msm: MultiServerManager) => {
      this._multiServerManager = msm;
    };
    /** @param {import('../server/bot-control')} bc BotControlService instance */
    this.setBotControl = (bc: BotControlService) => {
      this._botControl = bc;
    };
    /** @param {object} status Module status map { moduleName: statusString } */
    this.setModuleStatus = (status: Record<string, string>) => {
      this._moduleStatus = status;
    };

    // Response cache — keyed by "endpoint:serverId", entries = { data, ts }
    this._responseCache = new Map();

    // Cache: last parsed save data
    this._playerCache = new Map();
    this._lastParse = 0;
    this._idMap = {} as Record<string, string>;

    // Security headers
    this._app.use((_req, res, next) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('X-XSS-Protection', '0'); // Disabled — modern browsers don't need it, can cause XSS in old ones
      res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
      res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
      res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
      // CSP: allow self + CDN scripts/styles + Google Fonts used by the panel frontend
      res.setHeader(
        'Content-Security-Policy',
        [
          "default-src 'self'",
          "script-src 'self' 'unsafe-inline' https://unpkg.com https://cdn.jsdelivr.net https://static.cloudflareinsights.com",
          "style-src 'self' 'unsafe-inline' https://unpkg.com https://fonts.googleapis.com",
          "img-src 'self' https://cdn.discordapp.com data: blob:",
          "connect-src 'self' https://unpkg.com https://cdn.jsdelivr.net https://static.cloudflareinsights.com",
          "font-src 'self' https://fonts.gstatic.com",
          "frame-ancestors 'none'",
          "base-uri 'self'",
          "form-action 'self'",
          "object-src 'none'",
        ].join('; '),
      );
      res.removeHeader('X-Powered-By');
      next();
    });

    // Set up Express
    this._setupRoutes();
  }

  /** Load calibration data from file, or return defaults. */
  _loadCalibration(): { xMin: number; xMax: number; yMin: number; yMax: number } {
    try {
      if (fs.existsSync(CALIBRATION_FILE)) {
        const data = JSON.parse(fs.readFileSync(CALIBRATION_FILE, 'utf8')) as {
          xMin: number;
          xMax: number;
          yMin: number;
          yMax: number;
        };
        console.log('[WEB MAP] Loaded calibration from file');
        return data;
      }
    } catch (err: unknown) {
      console.error('[WEB MAP] Failed to load calibration:', errMsg(err));
    }

    // Defaults — UE4 X = North (up), Y = East (right)
    // These map world coordinates to the [0, 4096] pixel space of the map image.
    // xMin = world X at the BOTTOM of the map, xMax = world X at the TOP
    // yMin = world Y at the LEFT of the map, yMax = world Y at the RIGHT
    // Source: developer-provided values — Width: 395900, Offset X=201200 Y=-200600
    return {
      xMin: 3250, // south edge (bottom of map)
      xMax: 399150, // north edge (top of map)
      yMin: -398550, // west edge (left of map)
      yMax: -2650, // east edge (right of map)
    };
  }

  /** Save calibration to file. */
  _saveCalibration(bounds: { xMin: number; xMax: number; yMin: number; yMax: number }): void {
    this._worldBounds = bounds;
    try {
      fs.writeFileSync(CALIBRATION_FILE, JSON.stringify(bounds, null, 2));
      console.log('[WEB MAP] Saved calibration:', JSON.stringify(bounds));
    } catch (err: unknown) {
      console.error('[WEB MAP] Failed to save calibration:', errMsg(err));
    }
  }

  /**
   * Server-side response cache — prevents repeated RCON/DB/file hits for the same data.
   * Keyed by "endpoint:serverId". Returns cached JSON or null if expired/missing.
   */
  _getCached(endpoint: string, serverId: string, maxAgeMs = 15000): unknown {
    const key = `${endpoint}:${serverId || 'primary'}`;
    const entry = this._responseCache.get(key);
    if (entry && Date.now() - entry.ts < maxAgeMs) return entry.data;
    return null;
  }

  /** Store a response in the cache. */
  _setCache(endpoint: string, serverId: string, data: unknown): void {
    const key = `${endpoint}:${serverId || 'primary'}`;
    this._responseCache.set(key, { data, ts: Date.now() });
  }

  /**
   * Register a plugin that provides routes, assets, and data hooks.
   * Private modules (e.g. howyagarn/web-plugin) call this to extend the panel.
   * @param {object} plugin — { name, css[], js[], dashboardHtml, registerRoutes(app, helpers), getLandingData() }
   */
  registerPlugin(plugin: Record<string, unknown>): void {
    if (!plugin.name) return;
    this._plugins.push(plugin);
    // If the server is already running, register routes immediately
    if (this._server && typeof plugin.registerRoutes === 'function') {
      try {
        (
          plugin.registerRoutes as (
            app: typeof this._app,
            helpers: { rateLimit: typeof rateLimit; requireTier: typeof requireTier },
          ) => void
        )(this._app, { rateLimit, requireTier });
      } catch (err: unknown) {
        console.error(`[WEB MAP] Plugin ${plugin.name as string} late route registration failed:`, errMsg(err));
      }
    }
    console.log(`[WEB MAP] Plugin registered: ${plugin.name as string}`);
  }

  /** Load player ID map from file. */
  _loadIdMap(): void {
    try {
      const raw = fs.readFileSync(path.join(DATA_DIR, 'logs', 'PlayerIDMapped.txt'), 'utf8');
      const map: Record<string, string> = {};
      for (const line of raw.split('\n')) {
        const m = line.trim().match(/^(\d{17})_\+_\|[^@]+@(.+)$/);
        if (m?.[1] && m[2]) map[m[1]] = m[2].trim();
      }
      this._idMap = map;
    } catch (err: unknown) {
      console.error('[WEB MAP] Failed to load ID map:', errMsg(err));
    }
  }

  // ── Multi-server helpers ──────────────────────────────────

  /** Load the list of additional (managed) servers. DB-first, fallback to servers.json. */
  _loadServerList(): Array<Record<string, unknown> & { id: string; name?: string }> {
    // DB-backed: read from config_documents
    if (this._configRepo) {
      try {
        const all = this._configRepo.loadAll();
        const servers = [];
        for (const [scope, { data }] of all) {
          if (!scope.startsWith('server:') || scope === 'server:primary') continue;
          if (data.id) servers.push(data as Record<string, unknown> & { id: string });
        }
        return servers;
      } catch (err: unknown) {
        console.error('[WEB MAP] Failed to load servers from DB:', errMsg(err));
      }
    }
    // Legacy fallback: read from servers.json
    try {
      if (fs.existsSync(SERVERS_FILE)) {
        return JSON.parse(fs.readFileSync(SERVERS_FILE, 'utf8')) as Array<
          Record<string, unknown> & { id: string; name?: string }
        >;
      }
    } catch (err: unknown) {
      console.error('[WEB MAP] Failed to load servers.json:', errMsg(err));
    }
    return [];
  }

  /** Get data directory for a server id (or primary). */
  _getServerDataDir(serverId: string): string | null {
    if (!serverId || serverId === 'primary') return DATA_DIR;
    // Sanitize to prevent path traversal
    const safe = serverId.replace(/[^a-zA-Z0-9_-]/g, '');
    const dir = path.join(SERVERS_DIR, safe);
    return fs.existsSync(dir) ? dir : null;
  }

  /**
   * Resolve all data sources for a given server ID.
   * Returns { db, rcon, config, playerStats, playtime, getPlayerList, getServerInfo,
   *           scheduler, dataDir, isPrimary, serverId } or null if server not found.
   */
  _resolveServer(serverId: string): ServerContext | null {
    const isPrimary = !serverId || serverId === 'primary';
    if (isPrimary) {
      return {
        db: this._db,
        rcon,
        config,
        playerStats,
        playtime,
        getPlayerList: _getPlayerList,
        getServerInfo: _getServerInfo,
        sendAdminMessage: _sendAdminMessage,
        panelApi: _panelApiInstance,
        scheduler: this._scheduler as unknown as Record<string, unknown>,
        dataDir: DATA_DIR,
        idMap: this._idMap,
        isPrimary: true,
        serverId: 'primary',
      };
    }
    // Look up multi-server instance
    if (!this._multiServerManager) return null;
    const instance = this._multiServerManager.getInstance(serverId);
    if (!instance || !instance.running) return null;
    return {
      db: instance.db,
      rcon: instance.rcon,
      config: instance.config,
      playerStats: instance.playerStats,
      playtime: instance.playtime,
      getPlayerList: instance.getPlayerList,
      getServerInfo: instance.getServerInfo,
      sendAdminMessage: instance.sendAdminMessage,
      panelApi: instance.panelApi || null,
      scheduler: ((instance._modules as Record<string, unknown> | undefined)?.serverScheduler ?? null) as Record<
        string,
        unknown
      > | null,
      dataDir: instance.dataDir,
      idMap: this._loadIdMapFrom(instance.dataDir, instance.db),
      isPrimary: false,
      serverId,
    };
  }

  /** Load player ID map from a specific data directory, falling back to DB names. */
  _loadIdMapFrom(dataDir: string, db: HumanitZDB | null): Record<string, string> {
    const map: Record<string, string> = {};
    try {
      const raw = fs.readFileSync(path.join(dataDir, 'logs', 'PlayerIDMapped.txt'), 'utf8');
      for (const line of raw.split('\n')) {
        const m = line.trim().match(/^(\d{17})_\+_\|[^@]+@(.+)$/);
        if (m?.[1] && m[2]) map[m[1]] = m[2].trim();
      }
    } catch {
      /* file may not exist for this server */
    }

    // Fall back to DB player names if file was empty/missing
    if (Object.keys(map).length === 0 && db) {
      try {
        const rows = (db._db?.prepare("SELECT steam_id, name FROM players WHERE name != ''").all() ?? []) as {
          steam_id: string;
          name: string;
        }[];
        for (const row of rows) {
          if (row.steam_id && row.name) map[row.steam_id] = row.name;
        }
      } catch {
        /* DB may not have players yet */
      }
    }
    return map;
  }

  /**
   * Load player-stats.json from a data directory.
   * Returns a { getStats(steamId), getStatsByName(name) } interface.
   */
  _loadLogStatsFrom(dataDir: string): {
    getStats(steamId: string): Record<string, unknown> | null;
    getStatsByName(name: string): Record<string, unknown> | null;
  } {
    try {
      const raw = fs.readFileSync(path.join(dataDir, 'player-stats.json'), 'utf8');
      const data = JSON.parse(raw) as { players?: Record<string, Record<string, unknown>> };
      const players: Record<string, Record<string, unknown>> = data.players ?? {};
      return {
        getStats(steamId: string) {
          return players[steamId] || null;
        },
        getStatsByName(name: string) {
          const lower = (name || '').toLowerCase();
          for (const rec of Object.values(players)) {
            if (((rec.name as string) || '').toLowerCase() === lower) return rec;
          }
          return null;
        },
      };
    } catch {
      return {
        getStats(_steamId?: string) {
          return null;
        },
        getStatsByName(_name?: string) {
          return null;
        },
      };
    }
  }

  /** Load playtime.json from a data directory. */
  _loadPlaytimeFrom(dataDir: string): { getPlaytime(steamId: string): Record<string, unknown> | null } {
    try {
      const raw = fs.readFileSync(path.join(dataDir, 'playtime.json'), 'utf8');
      const data = JSON.parse(raw) as { players?: Record<string, Record<string, unknown>> };
      const players: Record<string, Record<string, unknown>> = data.players ?? {};
      return {
        getPlaytime(steamId: string) {
          const p = players[steamId];
          if (!p) return null;
          return { totalMs: (p.totalMs as number) || 0, lastSeen: (p.lastSeen as string) || null };
        },
      };
    } catch {
      return {
        getPlaytime(_steamId?: string) {
          return null;
        },
      };
    }
  }

  /**
   * Parse save data for a specific server.
   * Tries (in order): save-cache.json, humanitz-cache.json, raw .sav files.
   */
  _parseSaveDataForServer(dataDir: string): Map<string, unknown> {
    // 1. Try save-cache.json (written by PlayerStatsChannel)
    try {
      const cachePath = path.join(dataDir, 'save-cache.json');
      if (fs.existsSync(cachePath)) {
        const stat = fs.statSync(cachePath);
        // Use cache if less than 10 minutes old
        if (Date.now() - stat.mtimeMs < 600000) {
          const data = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as { players?: Record<string, unknown> };
          const map = new Map<string, unknown>();
          for (const [steamId, pData] of Object.entries(data.players ?? {})) {
            map.set(steamId, pData);
          }
          return map;
        }
      }
    } catch {
      /* fall through */
    }

    // 2. Try humanitz-cache.json (agent output)
    try {
      const agentPath = path.join(dataDir, 'humanitz-cache.json');
      if (fs.existsSync(agentPath)) {
        const data = JSON.parse(fs.readFileSync(agentPath, 'utf8')) as { players?: Record<string, unknown> };
        const map = new Map<string, unknown>();
        for (const [steamId, pData] of Object.entries(data.players ?? {})) {
          map.set(steamId, pData);
        }
        return map;
      }
    } catch {
      /* fall through */
    }

    // 3. Try raw .sav files
    const saveFiles = [
      path.join(dataDir, 'Save_DedicatedSaveMP_NEW.sav'),
      path.join(dataDir, 'Save_DedicatedSaveMP_LIVE.sav'),
      path.join(dataDir, 'Save_DedicatedSaveMP.sav'),
    ];
    for (const savePath of saveFiles) {
      try {
        if (!fs.existsSync(savePath)) continue;
        const buf = fs.readFileSync(savePath);
        return parseSave(buf).players;
      } catch {
        /* try next */
      }
    }

    return new Map();
  }

  /** Parse save file and cache results. Uses save-cache.json when available. */
  _parseSaveData(): Map<string, unknown> {
    const now = Date.now();
    // Cache for 30s
    if (now - this._lastParse < 30000 && this._playerCache.size > 0) {
      return this._playerCache;
    }

    // Try save-cache.json first (written by bot's PlayerStatsChannel — fast, no .sav parsing)
    const cached = this._parseSaveDataForServer(DATA_DIR);
    if (cached.size > 0) {
      this._playerCache = cached;
      this._lastParse = now;
      this._loadIdMap();
      return this._playerCache;
    }

    // Fallback: try raw .sav files
    const saveFiles = [
      path.join(DATA_DIR, 'Save_DedicatedSaveMP_NEW.sav'),
      path.join(DATA_DIR, 'Save_DedicatedSaveMP_LIVE.sav'),
      path.join(DATA_DIR, 'Save_DedicatedSaveMP.sav'),
    ];

    for (const savePath of saveFiles) {
      try {
        if (!fs.existsSync(savePath)) continue;
        const buf = fs.readFileSync(savePath);
        this._playerCache = parseSave(buf).players;
        this._lastParse = now;
        this._loadIdMap();
        return this._playerCache;
      } catch (err: unknown) {
        console.error(`[WEB MAP] Failed to parse ${path.basename(savePath)}:`, errMsg(err));
      }
    }
    return this._playerCache;
  }

  /** Convert world coords to Leaflet [lat, lng] for CRS.Simple. */
  _worldToLeaflet(worldX: number, worldY: number): [number, number] {
    const b = this._worldBounds;
    // lat (vertical) = maps UE4 X (north/south) — X+ is up
    const lat = ((worldX - b.xMin) / (b.xMax - b.xMin)) * 4096;
    // lng (horizontal) = maps UE4 Y (east/west) — Y+ is right
    const lng = ((worldY - b.yMin) / (b.yMax - b.yMin)) * 4096;
    return [lat, lng];
  }

  /** Return SHOW_* toggles for the frontend to conditionally display sections. */
  _getToggles(): Record<string, unknown> {
    return {
      showVitals: config.showVitals,
      showHealth: config.showHealth,
      showHunger: config.showHunger,
      showThirst: config.showThirst,
      showStamina: config.showStamina,
      showImmunity: config.showImmunity,
      showBattery: config.showBattery,
      showStatusEffects: config.showStatusEffects,
      showPlayerStates: config.showPlayerStates,
      showBodyConditions: config.showBodyConditions,
      showInfectionBuildup: config.showInfectionBuildup,
      showFatigue: config.showFatigue,
      showInventory: config.showInventory,
      showEquipment: config.showEquipment,
      showQuickSlots: config.showQuickSlots,
      showPockets: config.showPockets,
      showBackpack: config.showBackpack,
      showRecipes: config.showRecipes,
      showCraftingRecipes: config.showCraftingRecipes,
      showBuildingRecipes: config.showBuildingRecipes,
      showLore: config.showLore,
      showCoordinates: config.showCoordinates,
      showRaidStats: config.showRaidStats,
      showPvpKills: config.showPvpKills,
      showConnections: config.showConnections,
    };
  }

  /** Set up Express routes. */
  _setupRoutes(): void {
    const app = this._app;
    const configRepo = this._configRepo;

    // Discord OAuth2 authentication (must be registered before static/API routes)
    // Returns no-op middleware if DISCORD_OAUTH_SECRET / WEB_MAP_CALLBACK_URL are not set
    const authMiddleware = setupAuth(app, this._client, { db: this._db?.db });
    app.use(authMiddleware);

    // ── Root page → panel.html (must come before static middleware) ──
    // If plugins are registered, inject their CSS/JS/HTML before serving

    app.get('/', (_req, res) => {
      if (!this._plugins.length) {
        res.sendFile(path.join(PUBLIC_DIR, 'panel.html'));
        return;
      }
      // Read panel.html and inject plugin assets
      let html;
      try {
        html = fs.readFileSync(path.join(PUBLIC_DIR, 'panel.html'), 'utf8');
      } catch {
        res.sendFile(path.join(PUBLIC_DIR, 'panel.html'));
        return;
      }
      const cssLinks = this._plugins
        .flatMap((p: Record<string, unknown>) =>
          ((p.css || []) as string[]).map((href: string) => `<link rel="stylesheet" href="${href}"`),
        )
        .join('\n    ');
      const jsScripts = this._plugins
        .flatMap((p: Record<string, unknown>) =>
          ((p.js || []) as string[]).map((src: string) => `<script src="${src}"></script>`),
        )
        .join('\n    ');
      const dashHtml = this._plugins
        .map((p: Record<string, unknown>) => (p.dashboardHtml as string) || '')
        .filter(Boolean)
        .join('\n            ');
      if (cssLinks) html = html.replace('</head>', `    ${cssLinks}\n  </head>`);
      if (jsScripts) html = html.replace('</body>', `    ${jsScripts}\n  </body>`);
      if (dashHtml) html = html.replace('<!-- plugin-dashboard-slot -->', dashHtml);
      res.type('text/html').send(html);
    });

    // Serve i18n locale files from project root locales/ directory
    app.use('/locales', express.static(path.join(__dirname, '../../locales')));

    // Serve static files (HTML, JS, CSS, map images)
    app.use(express.static(PUBLIC_DIR, { dotfiles: 'deny' }));
    app.use(express.json());

    // ── Multi-server context middleware ──
    // Resolves ?server=<id> query param into a server context object on req.srv
    // Falls back to primary server if not specified or not found
    app.use('/api', (req, _res, next) => {
      const serverId =
        (req.query.server as string | undefined) ??
        ((req.body as Record<string, unknown> | undefined)?.server as string | undefined) ??
        'primary';
      req.srv = (this._resolveServer(serverId) ?? this._resolveServer('primary')) as ServerContext;
      next();
    });

    // ── API: List available servers (multi-server support) ──
    app.get('/api/servers', requireTier('survivor'), (_req, res) => {
      const servers = [{ id: 'primary', name: config.serverName || 'Primary Server' }];
      const additional = this._loadServerList();
      for (const s of additional) {
        const dir = this._getServerDataDir(s.id);
        if (dir) servers.push({ id: s.id, name: s.name || s.id });
      }
      res.json({ servers, multiServer: additional.length > 0 });
    });

    // ── API: Calibration data — all entity positions for map alignment ──
    app.get('/api/calibration-data', requireTier('admin'), (req, res) => {
      try {
        const srv = req.srv;
        const cachePath = path.join(srv.dataDir, 'save-cache.json');
        if (!fs.existsSync(cachePath)) return res.json([]);
        const data = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as {
          players?: Record<string, DbRow>;
          worldState?: Record<string, DbRow[]>;
        };

        const points: (number | string)[][] = [];
        const add = (arr: DbRow[] | undefined, type: string) => {
          if (!arr) return;
          for (const item of arr) {
            const x = item.x ?? item.worldX ?? null;
            const y = item.y ?? item.worldY ?? null;
            if (x !== null && y !== null && !(x === 0 && y === 0)) points.push([x as number, y as number, type]);
          }
        };

        // Players
        for (const [, p] of Object.entries(data.players ?? {})) {
          if (p.x != null && !(p.x === 0 && p.y === 0)) points.push([p.x as number, p.y as number, 'P']);
        }

        // World entities
        const ws = data.worldState ?? {};
        add(ws.preBuildActors, 'p');
        add(ws.droppedBackpacks, 'b');
        add(ws.explodableBarrelPositions, 'e');
        add(ws.destroyedRandCarPositions, 'd');
        add(ws.savedActors, 'A');
        add(ws.aiSpawns, 'a');

        // LOD pickups (positions extracted)
        if (ws.lodPickups) {
          for (const p of ws.lodPickups) {
            if (p.x != null && !(p.x === 0 && p.y === 0)) points.push([p.x as number, p.y as number, 'l']);
          }
        }

        // Houses
        if (ws.houses) {
          for (const h of ws.houses) {
            if (h.x != null && !(h.x === 0 && h.y === 0)) points.push([h.x as number, h.y as number, 'H']);
          }
        }

        // Global containers
        if (ws.globalContainers) {
          for (const c of ws.globalContainers) {
            if (c.x != null && !(c.x === 0 && c.y === 0)) points.push([c.x as number, c.y as number, 'c']);
          }
        }

        console.log(`[WEB MAP] Calibration data: ${points.length} positions`);
        res.json(points);
      } catch (err: unknown) {
        console.error('[WEB MAP] Calibration data error:', errMsg(err));
        sendError(res, API_ERRORS.INTERNAL_SERVER_ERROR, 500, safeError(err));
      }
    });

    // ── API: Get all player positions ──
    app.get('/api/players', requireTier('survivor'), rateLimit(10000, 10), async (req, res) => {
      const srv = req.srv;

      // Resolve data sources based on server
      const players = srv.isPrimary ? this._parseSaveData() : this._parseSaveDataForServer(srv.dataDir);
      const idMap = srv.idMap;
      const logStatsProvider = srv.playerStats;
      const playtimeProvider = srv.playtime;

      // Query RCON for online players (non-blocking — if it fails, all show offline)
      const onlineSteamIds = new Set();
      try {
        const list = await srv.getPlayerList();
        const playerArr = list.players;
        for (const p of playerArr) {
          onlineSteamIds.add(p.steamId);
        }
      } catch {
        /* RCON unavailable — all players show offline */
      }

      // Build clan membership lookup from DB
      const clanLookup: Record<string, { clanName: string; rank: string }> = {}; // steamId → { clanName, rank }
      if (srv.db) {
        try {
          const clans = srv.db.getAllClans();
          for (const clan of clans as unknown as Array<{
            name: string;
            members?: Array<{ steam_id: string; rank: string }>;
          }>) {
            for (const m of clan.members || []) {
              clanLookup[m.steam_id] = { clanName: clan.name, rank: m.rank };
            }
          }
        } catch {
          /* clan data unavailable */
        }
      }

      const result = [];

      for (const [steamId, rawData] of players) {
        const data = rawData as Record<string, unknown>;
        const dx = data.x as number | null;
        const dy = data.y as number | null;
        const dz = data.z as number | null;
        const hasPosition = dx !== null && !(dx === 0 && dy === 0 && dz === 0);

        const name = idMap[steamId] || steamId;
        let lat = null,
          lng = null;
        if (hasPosition) {
          [lat, lng] = this._worldToLeaflet(dx, dy as number);
        }

        // Get log-based stats
        const logStats = logStatsProvider.getStats(steamId) || logStatsProvider.getStatsByName(name);

        // Get playtime
        const ptData = playtimeProvider.getPlaytime(steamId);

        // Resolve profession display name from enum code
        const professionName = PERK_MAP[data.startingPerk as string] || (data.startingPerk as string) || 'Unknown';

        result.push({
          steamId,
          name,
          hasPosition,
          lat,
          lng,
          worldX: hasPosition ? Math.round(dx) : null,
          worldY: hasPosition ? Math.round(dy as number) : null,
          worldZ: hasPosition ? Math.round(dz as number) : null,
          isOnline: onlineSteamIds.has(steamId),

          // Character
          male: data.male,
          profession: professionName,
          affliction: AFFLICTION_MAP[data.affliction as number] || 'Unknown',
          unlockedProfessions: ((data.unlockedProfessions as unknown[] | undefined) ?? []).map(
            (p: unknown) => PERK_MAP[p as string] || p,
          ),

          // Current-life kill stats
          zeeksKilled: data.zeeksKilled || 0,
          headshots: data.headshots || 0,
          meleeKills: data.meleeKills || 0,
          gunKills: data.gunKills || 0,
          blastKills: data.blastKills || 0,
          fistKills: data.fistKills || 0,
          takedownKills: data.takedownKills || 0,
          vehicleKills: data.vehicleKills || 0,

          // Lifetime kill stats
          lifetimeKills: data.lifetimeKills || 0,
          lifetimeHeadshots: data.lifetimeHeadshots || 0,
          lifetimeMeleeKills: data.lifetimeMeleeKills || 0,
          lifetimeGunKills: data.lifetimeGunKills || 0,
          lifetimeBlastKills: data.lifetimeBlastKills || 0,
          lifetimeFistKills: data.lifetimeFistKills || 0,
          lifetimeTakedownKills: data.lifetimeTakedownKills || 0,
          lifetimeVehicleKills: data.lifetimeVehicleKills || 0,
          lifetimeDaysSurvived: data.lifetimeDaysSurvived || 0,
          hasExtendedStats: data.hasExtendedStats || false,

          // Survival
          daysSurvived: data.daysSurvived || 0,
          timesBitten: data.timesBitten || 0,
          fishCaught: data.fishCaught || 0,
          fishCaughtPike: data.fishCaughtPike || 0,
          exp: data.exp || 0,
          level: data.level || 0,
          expCurrent: data.expCurrent || 0,
          expRequired: data.expRequired || 0,
          skillsPoint: data.skillsPoint || 0,

          // Vitals
          health: data.health,
          maxHealth: data.maxHealth,
          hunger: data.hunger,
          maxHunger: data.maxHunger,
          thirst: data.thirst,
          maxThirst: data.maxThirst,
          stamina: data.stamina,
          maxStamina: data.maxStamina,
          infection: data.infection,
          maxInfection: data.maxInfection,
          battery: data.battery,
          fatigue: data.fatigue,
          infectionBuildup: data.infectionBuildup,

          // Status effects (cleaned)
          playerStates: ((data.playerStates as unknown[] | undefined) ?? []).map((s: unknown) =>
            cleanItemName(s as string),
          ),
          bodyConditions: ((data.bodyConditions as unknown[] | undefined) ?? []).map((s: unknown) =>
            cleanItemName(s as string),
          ),

          // Inventory (server-side cleaned)
          equipment: _cleanInventorySlots((data.equipment as unknown[] | undefined) ?? []),
          quickSlots: _cleanInventorySlots((data.quickSlots as unknown[] | undefined) ?? []),
          inventory: _cleanInventorySlots((data.inventory as unknown[] | undefined) ?? []),
          backpackItems: _cleanInventorySlots((data.backpackItems as unknown[] | undefined) ?? []),

          // Recipes & skills (cleaned — cleanItemArray filters out hex GUIDs)
          craftingRecipes: cleanItemArray((data.craftingRecipes as unknown[] | undefined) ?? []),
          buildingRecipes: cleanItemArray((data.buildingRecipes as unknown[] | undefined) ?? []),
          unlockedSkills: cleanItemArray((data.unlockedSkills as unknown[] | undefined) ?? []),

          // Lore
          lore: (data.lore as unknown[] | undefined) ?? [],
          uniqueLoots: cleanItemArray((data.uniqueLoots as unknown[] | undefined) ?? []),
          craftedUniques: cleanItemArray((data.craftedUniques as unknown[] | undefined) ?? []),

          // Companions (cleaned)
          companionData: ((data.companionData as Record<string, unknown>[] | undefined) ?? []).map(
            (c: Record<string, unknown>) =>
              typeof c === 'object'
                ? { ...c, type: cleanItemName((c.type as string | undefined) ?? '') }
                : cleanItemName(c as string),
          ),
          horses: (data.horses as unknown[] | undefined) ?? [],

          // Log-derived stats
          deaths: logStats?.deaths || 0,
          pvpKills: logStats?.pvpKills || 0,
          pvpDeaths: logStats?.pvpDeaths || 0,
          builds: logStats?.builds || 0,
          containersLooted: logStats?.containersLooted || 0,
          raidsOut: logStats?.raidsOut || 0,
          raidsIn: logStats?.raidsIn || 0,
          connects: logStats?.connects || 0,

          // Clan
          clanName: clanLookup[steamId]?.clanName || null,
          clanRank: clanLookup[steamId]?.rank || null,

          // Playtime
          totalPlaytime: ptData ? Math.floor(ptData.totalMs / 60000) : 0,
          lastSeen: ptData?.lastSeen || null,
        });
      }

      res.json({
        server: srv.serverId,
        players: result,
        worldBounds: this._worldBounds,
        toggles: this._getToggles(),
        lastUpdated: new Date().toISOString(),
      });
    });

    // ── API: Get single player detail ──
    app.get('/api/players/:steamId', requireTier('survivor'), (req, res) => {
      const srv = req.srv;
      const steamId = req.params.steamId as string;
      const players = srv.isPrimary ? this._parseSaveData() : this._parseSaveDataForServer(srv.dataDir);
      const rawPlayerData = players.get(steamId);
      if (!rawPlayerData) {
        sendError(res, API_ERRORS.PLAYER_NOT_FOUND, 404);
        return;
      }
      const data = rawPlayerData as Record<string, unknown>;

      const name = srv.idMap[steamId] || steamId;
      const pdx = data.x as number | null;
      const pdy = data.y as number | null;
      const pdz = data.z as number | null;
      const hasPosition = pdx !== null && !(pdx === 0 && pdy === 0 && pdz === 0);
      let lat = null,
        lng = null;
      if (hasPosition) {
        [lat, lng] = this._worldToLeaflet(pdx, pdy as number);
      }

      // Resolve display names
      const professionName = PERK_MAP[data.startingPerk as string] || (data.startingPerk as string) || 'Unknown';
      const logStats = srv.playerStats.getStats(steamId) || srv.playerStats.getStatsByName(name);
      const ptData = srv.playtime.getPlaytime(steamId);

      res.json({
        steamId: req.params.steamId,
        name,
        hasPosition,
        lat,
        lng,
        worldX: pdx,
        worldY: pdy,
        worldZ: pdz,
        profession: professionName,
        affliction: AFFLICTION_MAP[data.affliction as number] || 'Unknown',
        unlockedProfessions: ((data.unlockedProfessions as unknown[] | undefined) ?? []).map(
          (p: unknown) => PERK_MAP[p as string] || p,
        ),
        ...data,
        // Override raw enum values with resolved names
        startingPerk: professionName,
        // Log-derived
        deaths: logStats?.deaths || 0,
        pvpKills: logStats?.pvpKills || 0,
        pvpDeaths: logStats?.pvpDeaths || 0,
        builds: logStats?.builds || 0,
        containersLooted: logStats?.containersLooted || 0,
        raidsOut: logStats?.raidsOut || 0,
        raidsIn: logStats?.raidsIn || 0,
        connects: logStats?.connects || 0,
        // Playtime
        totalPlaytime: ptData ? Math.floor(ptData.totalMs / 60000) : 0,
        lastSeen: ptData?.lastSeen || null,
        // Toggles for conditional display
        toggles: this._getToggles(),
      });
    });

    // ── API: Get world bounds / calibration ──

    app.get('/api/calibration', requireTier('admin'), (_req, res) => {
      res.json(this._worldBounds);
    });

    // ── API: Save calibration ──
    app.post('/api/calibration', requireTier('admin'), (req, res) => {
      const body1187 = req.body as { xMin: number; xMax: number; yMin: number; yMax: number };
      const { xMin, xMax, yMin, yMax } = body1187;
      if ([xMin, xMax, yMin, yMax].some((v) => typeof v !== 'number' || isNaN(v))) {
        sendError(res, API_ERRORS.INVALID_BOUNDS, 400);
        return;
      }
      this._saveCalibration({ xMin, xMax, yMin, yMax });
      res.json({ ok: true, bounds: this._worldBounds });
    });

    // ── API: Calibrate from two reference points ──
    app.post('/api/calibrate-from-points', requireTier('admin'), (req, res) => {
      // Each point: { worldX, worldY, pixelX, pixelY } where pixel is 0-4096
      const { point1, point2 } = req.body as {
        point1?: { worldX: number; worldY: number; pixelX: number; pixelY: number };
        point2?: { worldX: number; worldY: number; pixelX: number; pixelY: number };
      };
      if (!point1 || !point2) {
        sendError(res, API_ERRORS.MISSING_POINTS, 400);
        return;
      }

      // Solve: pixelLat = ((worldX - xMin) / (xMax - xMin)) * 4096
      //        pixelLng = ((worldY - yMin) / (yMax - yMin)) * 4096
      // Given 2 points we can solve for xMin/xMax and yMin/yMax

      // For X axis (vertical / lat):
      // lat1 = ((wx1 - xMin) / xSpan) * 4096
      // lat2 = ((wx2 - xMin) / xSpan) * 4096
      // lat1/4096 * xSpan + xMin = wx1
      // lat2/4096 * xSpan + xMin = wx2
      // → xSpan = (wx2 - wx1) / ((lat2 - lat1) / 4096)
      // → xMin = wx1 - (lat1/4096) * xSpan

      const lat1 = point1.pixelY; // pixel Y from bottom = lat
      const lat2 = point2.pixelY;
      const lng1 = point1.pixelX;
      const lng2 = point2.pixelX;

      if (Math.abs(lat2 - lat1) < 1 || Math.abs(lng2 - lng1) < 1) {
        sendError(res, API_ERRORS.POINTS_TOO_CLOSE, 400);
        return;
      }

      const xSpan = (point2.worldX - point1.worldX) / ((lat2 - lat1) / 4096);
      const xMin = point1.worldX - (lat1 / 4096) * xSpan;
      const xMax = xMin + xSpan;

      const ySpan = (point2.worldY - point1.worldY) / ((lng2 - lng1) / 4096);
      const yMin = point1.worldY - (lng1 / 4096) * ySpan;
      const yMax = yMin + ySpan;

      const bounds = {
        xMin: Math.round(xMin),
        xMax: Math.round(xMax),
        yMin: Math.round(yMin),
        yMax: Math.round(yMax),
      };

      this._saveCalibration(bounds);
      res.json({ ok: true, bounds });
    });

    // ── API: Admin action — kick ──
    app.post('/api/admin/kick', requireTier('mod'), rateLimit(5000, 5), async (req, res) => {
      const { steamId } = req.body as { steamId?: string };
      if (!steamId || typeof steamId !== 'string') {
        sendError(res, API_ERRORS.MISSING_STEAM_ID, 400);
        return;
      }
      // Validate steam ID format
      if (!/^\d{17}$/.test(steamId)) {
        sendError(res, API_ERRORS.INVALID_STEAM_ID_FORMAT, 400);
        return;
      }
      try {
        const result = await req.srv.rcon.send(`kick ${steamId}`);
        res.json({ ok: true, result });
      } catch (err: unknown) {
        sendError(res, API_ERRORS.INTERNAL_SERVER_ERROR, 500, safeError(err));
      }
    });

    // ── API: Admin action — ban ──
    app.post('/api/admin/ban', requireTier('admin'), rateLimit(5000, 3), async (req, res) => {
      const { steamId } = req.body as { steamId?: string };
      if (!steamId || typeof steamId !== 'string') {
        sendError(res, API_ERRORS.MISSING_STEAM_ID, 400);
        return;
      }
      if (!/^\d{17}$/.test(steamId)) {
        sendError(res, API_ERRORS.INVALID_STEAM_ID_FORMAT, 400);
        return;
      }
      try {
        const result = await req.srv.rcon.send(`ban ${steamId}`);
        res.json({ ok: true, result });
      } catch (err: unknown) {
        sendError(res, API_ERRORS.INTERNAL_SERVER_ERROR, 500, safeError(err));
      }
    });

    // ── API: RCON send message ──
    app.post('/api/admin/message', requireTier('mod'), rateLimit(3000, 5), async (req, res) => {
      const { message } = req.body as { message?: string };
      if (!message || typeof message !== 'string') {
        sendError(res, API_ERRORS.MISSING_MESSAGE, 400);
        return;
      }
      if (message.length > 500) {
        sendError(res, API_ERRORS.MESSAGE_TOO_LONG, 400);
        return;
      }
      // Sanitize: strip control chars and collapse newlines to prevent RCON injection
      const safe = stripControlChars(message)
        .replace(/[\r\n]+/g, ' ')
        .trim();
      if (!safe) {
        sendError(res, API_ERRORS.MESSAGE_EMPTY_AFTER_SANITIZATION, 400);
        return;
      }
      try {
        // Use 'admin' command — 'say' no longer returns a response as of game update March 2026.
        // Lead with </> to close default yellow, then <CL> for Discord-blue styling.
        const result = await req.srv.rcon.send(`admin </><CL>${safe}`);

        // Log to DB immediately so the web panel chat feed picks it up on next refresh
        // (don't rely on fetchchat polling — there's a race condition)
        if (req.srv.db) {
          try {
            req.srv.db.insertChat({
              type: 'panel_to_game',
              playerName: '',
              message: safe,
              direction: 'outbound',
              discordUser: req.session.user?.displayName || 'Panel',
              isAdmin: true,
            });
          } catch (_) {}
        }

        res.json({ ok: true, result });
      } catch (err: unknown) {
        sendError(res, API_ERRORS.INTERNAL_SERVER_ERROR, 500, safeError(err));
      }
    });

    // ── API: Get RCON player list (online status) ──
    app.get('/api/online', requireTier('survivor'), async (req, res) => {
      // Serve from background-polled player cache — instant response
      const cached = this._getCached('online', req.srv.serverId, 30000) as Record<string, unknown> | null;
      if (cached) return res.json({ players: cached });
      try {
        const list = await req.srv.getPlayerList();
        this._setCache('online', req.srv.serverId, list);
        res.json({ players: list });
      } catch (err: unknown) {
        sendError(res, API_ERRORS.INTERNAL_SERVER_ERROR, 500, safeError(err));
      }
    });

    // ═══════════════════════════════════════════════════════
    // Public Landing API — no auth required
    // ═══════════════════════════════════════════════════════

    /**
     * Returns server status, connect info, and multi-server data for the
     * public landing page. No authentication needed.
     */
    app.get('/api/landing', rateLimit(30000, 20), async (_req, res) => {
      // Serve from background-polled cache — instant response
      const cached = this._getCached('landing', 'global', 30000) as Record<string, unknown> | null;
      if (cached) return res.json(cached);
      // First request before background poller has run — build on demand
      try {
        const rconTimeout = (promise: Promise<unknown>) =>
          Promise.race([
            promise,
            new Promise((_, rej) =>
              setTimeout(() => {
                rej(new Error('RCON timeout'));
              }, 5000),
            ),
          ]);
        await this._buildLandingData(rconTimeout);
        const built = this._getCached('landing', 'global', 30000) as Record<string, unknown> | null;
        if (built) return res.json(built);
      } catch {
        /* build failed */
      }
      res.json({
        primary: {
          name: config.serverName || 'HumanitZ Server',
          status: 'unknown',
          onlineCount: 0,
          totalPlayers: 0,
        },
        servers: [],
      });
    });

    // Plugin-registered routes
    for (const plugin of this._plugins) {
      if (typeof plugin.registerRoutes === 'function') {
        try {
          (
            plugin.registerRoutes as (
              app: typeof this._app,
              helpers: { rateLimit: typeof rateLimit; requireTier: typeof requireTier },
            ) => void
          )(app, { rateLimit, requireTier });
        } catch (err: unknown) {
          console.error(`[WEB MAP] Plugin ${plugin.name as string} route registration failed:`, errMsg(err));
        }
      }
    }

    // ═══════════════════════════════════════════════════════
    // Panel API routes — server management, activity, chat, RCON console, settings
    // ═══════════════════════════════════════════════════════

    // ── Status: Module status ──
    app.get('/api/status/modules', requireTier('admin'), (_req, res) => {
      res.json({ modules: this._moduleStatus || {} });
    });

    // ── Panel: Server status (RCON info + resources) — served from background cache ──
    app.get('/api/panel/status', requireTier('survivor'), async (req, res) => {
      const srv = req.srv;
      // Serve from background-polled cache — instant response
      const cached = this._getCached('status', srv.serverId, 30000) as Record<string, unknown> | null;
      if (cached) return res.json(cached);
      // Fallback: build on demand if background poller hasn't run yet
      try {
        const rconTimeout = (promise: Promise<unknown>) =>
          Promise.race([
            promise,
            new Promise((_, rej) =>
              setTimeout(() => {
                rej(new Error('RCON timeout'));
              }, 5000),
            ),
          ]);
        await this._buildStatusCache(srv, rconTimeout);
        const built = this._getCached('status', srv.serverId, 30000) as Record<string, unknown> | null;
        if (built) return res.json(built);
      } catch {
        /* build failed */
      }
      res.json({ serverState: 'unknown', onlineCount: 0, timezone: srv.config.botTimezone || 'UTC' });
    });

    // ── Panel: Quick stats — served from background cache ──
    app.get('/api/panel/stats', requireTier('survivor'), async (req, res) => {
      const srv = req.srv;
      // Serve from background-polled cache — instant response
      const cached = this._getCached('stats', srv.serverId, 30000) as Record<string, unknown> | null;
      if (cached) return res.json(cached);
      // Fallback: build on demand if background poller hasn't run yet
      try {
        const rconTimeout = (promise: Promise<unknown>) =>
          Promise.race([
            promise,
            new Promise((_, rej) =>
              setTimeout(() => {
                rej(new Error('RCON timeout'));
              }, 5000),
            ),
          ]);
        await this._buildStatsCache(srv, rconTimeout);
        const built = this._getCached('stats', srv.serverId, 30000) as Record<string, unknown> | null;
        if (built) return res.json(built);
      } catch {
        /* build failed */
      }
      res.json({ totalPlayers: 0, onlinePlayers: 0, eventsToday: 0, chatsToday: 0 });
    });

    // ── Panel: Server capabilities — tells the client what this server has ──
    app.get('/api/panel/capabilities', requireTier('survivor'), (req, res) => {
      const srv = req.srv;
      const cached = this._getCached('caps', srv.serverId, 30000) as Record<string, unknown> | null;
      if (cached) return res.json(cached);

      const caps: Record<string, unknown> = {
        db: !!srv.db,
        rcon: !!srv.rcon,
        scheduler: !!(
          srv.scheduler && (srv.scheduler as Record<string, unknown> & { isActive?: () => boolean }).isActive?.()
        ),
        saveService: srv.isPrimary ? !!this._saveService : !!srv.db,
        resources: srv.isPrimary && !!serverResources,
        hasPlugin: this._plugins.some((p: Record<string, unknown>) => {
          // Check if this plugin is associated with this server
          if (srv.isPrimary) return false; // plugins are typically non-primary
          return !!p.name;
        }),
        isPrimary: srv.isPrimary,
        serverId: srv.serverId,
        serverName: srv.config.serverName || '',
      };
      // Check if this is the hzmod-enabled server
      for (const plugin of this._plugins) {
        if (plugin.name === 'hzmod') {
          // hzmod is registered with a serverId — only show on that server's dashboard
          const pluginSrv = plugin.serverId;
          if (!pluginSrv) {
            caps.hzmod = true;
            break;
          } // no serverId set → show everywhere
          if (pluginSrv === srv.serverId) {
            caps.hzmod = true;
          } // matches this server
          break;
        }
      }
      this._setCache('caps', srv.serverId, caps);
      res.json(caps);
    });

    // ── Panel: Activity feed from DB ──
    app.get('/api/panel/activity', requireTier('survivor'), rateLimit(10000, 20), (req, res) => {
      const srv = req.srv;
      if (!srv.db) return res.json({ events: [] });

      const limit = Math.min(parseInt((req.query.limit as string) || '', 10) || 50, 500);
      const offset = Math.max(parseInt((req.query.offset as string) || '0', 10) || 0, 0);
      const type = (req.query.type as string) || '';
      const actor = (req.query.actor as string) || '';

      try {
        let events;
        if (actor) {
          events = srv.db.getActivityByActor(actor, limit, offset);
        } else if (type) {
          events = srv.db.getActivityByCategory(type, limit, offset);
        } else {
          events = srv.db.getRecentActivity(limit, offset);
        }

        // Resolve steam IDs to player names + clean UE4 blueprint names
        const idMap = srv.idMap;
        const resolved = (events as unknown as ActivityRow[]).map((e) => {
          const out: ActivityRow & { actor_name?: string; target_name?: string; item?: string } = { ...e };
          if (!out.actor_name && out.steam_id && idMap[out.steam_id]) {
            out.actor_name = idMap[out.steam_id] as string;
          } else if (!out.actor_name && out.actor && idMap[out.actor]) {
            out.actor_name = idMap[out.actor] as string;
          }
          if (!out.target_name && out.target_steam_id && idMap[out.target_steam_id]) {
            out.target_name = idMap[out.target_steam_id] as string;
          }
          if (out.item) out.item = cleanActorName(out.item);
          if (out.actor && !out.actor_name) out.actor_name = cleanActorName(out.actor);
          return out;
        });

        res.json({ events: resolved });
      } catch (err: unknown) {
        sendError(res, API_ERRORS.INTERNAL_SERVER_ERROR, 500, safeError(err));
      }
    });

    // ── Panel: Activity stats (aggregated trends) ──
    app.get('/api/panel/activity-stats', requireTier('survivor'), rateLimit(15000, 10), (req, res) => {
      const srv = req.srv;
      if (!srv.db) return res.json({ categories: {}, hourly: [], daily: [], types: {} });

      try {
        const db = srv.db.db;
        if (!db) return res.json({ categories: {}, hourly: [], daily: [], types: {} });

        // Total count
        const totalRow = db.prepare('SELECT COUNT(*) as total FROM activity_log').get() as
          | { total: number }
          | undefined;

        // Count by type
        const typeCounts = db
          .prepare('SELECT type, COUNT(*) as count FROM activity_log GROUP BY type ORDER BY count DESC')
          .all() as { type: string; count: number }[];
        const types: Record<string, number> = {};
        for (const r of typeCounts) types[r.type] = r.count;

        // Count by category
        const categories: Record<string, number> = {};
        const catMap: Record<string, string[]> = {
          container: ['container_item_added', 'container_item_removed', 'container_loot', 'container_destroyed'],
          inventory: ['inventory_item_added', 'inventory_item_removed'],
          vehicle: [
            'vehicle_fuel_changed',
            'vehicle_health_changed',
            'vehicle_appeared',
            'vehicle_destroyed',
            'vehicle_change',
          ],
          session: ['player_connect', 'player_disconnect'],
          combat: ['player_death', 'player_death_pvp', 'damage_taken'],
          building: [
            'player_build',
            'structure_placed',
            'structure_destroyed',
            'structure_damaged',
            'building_destroyed',
            'raid_damage',
          ],
          horse: ['horse_appeared', 'horse_disappeared', 'horse_change'],
          admin: ['admin_access', 'anticheat_flag'],
        };
        for (const [cat, typesList] of Object.entries(catMap)) {
          let sum = 0;
          for (const t of typesList) sum += types[t] ?? 0;
          if (sum > 0) categories[cat] = sum;
        }

        // Hourly distribution (last 7 days)
        const hourly = db
          .prepare(
            `
          SELECT CAST(strftime('%H', created_at) AS INTEGER) as hour, COUNT(*) as count
          FROM activity_log
          WHERE created_at >= datetime('now', '-7 days')
          GROUP BY hour ORDER BY hour
        `,
          )
          .all() as { hour: number; count: number }[];

        // Daily totals (last 30 days)
        const daily = db
          .prepare(
            `
          SELECT date(created_at) as day, COUNT(*) as count
          FROM activity_log
          WHERE created_at >= datetime('now', '-30 days')
          GROUP BY day ORDER BY day
        `,
          )
          .all() as { day: string; count: number }[];

        // Daily by category (last 14 days, for stacked chart)
        const dailyByType = db
          .prepare(
            `
          SELECT date(created_at) as day, type, COUNT(*) as count
          FROM activity_log
          WHERE created_at >= datetime('now', '-14 days')
          GROUP BY day, type ORDER BY day
        `,
          )
          .all() as { day: string; type: string; count: number }[];

        // Top actors (last 7 days)
        const topActors = db
          .prepare(
            `
          SELECT COALESCE(actor_name, actor, steam_id) as actor, COUNT(*) as count
          FROM activity_log
          WHERE created_at >= datetime('now', '-7 days') AND actor IS NOT NULL AND actor != ''
          GROUP BY actor ORDER BY count DESC LIMIT 10
        `,
          )
          .all() as { actor: string; count: number }[];

        // Resolve actor names
        const idMap = srv.idMap;
        for (const a of topActors) {
          a.actor = idMap[a.actor] ?? cleanActorName(a.actor);
        }

        // Date range
        const range = db
          .prepare('SELECT MIN(created_at) as earliest, MAX(created_at) as latest FROM activity_log')
          .get() as { earliest: string | null; latest: string | null } | undefined;

        res.json({
          total: totalRow?.total || 0,
          types,
          categories,
          hourly,
          daily,
          dailyByType,
          topActors,
          dateRange: { earliest: range?.earliest, latest: range?.latest },
        });
      } catch (err: unknown) {
        sendError(res, API_ERRORS.INTERNAL_SERVER_ERROR, 500, safeError(err));
      }
    });

    // ── Panel: DB table list with row counts ──
    app.get('/api/panel/db/tables', requireTier('admin'), rateLimit(10000, 5), (req, res) => {
      const srv = req.srv;
      if (!srv.db) return res.json({ tables: [] });

      const ALLOWED = new Set([
        'activity_log',
        'chat_log',
        'players',
        'player_aliases',
        'clans',
        'clan_members',
        'world_state',
        'structures',
        'vehicles',
        'companions',
        'world_horses',
        'dead_bodies',
        'containers',
        'loot_actors',
        'quests',
        'server_settings',
        'snapshots',
        // 'game_items',
        'game_professions',
        'game_afflictions',
        'game_skills',
        'game_challenges',
        'game_recipes',
        'item_instances',
        'item_movements',
        'item_groups',
        'world_drops',
        'game_buildings',
        'game_loot_pools',
        'game_loot_pool_items',
        'game_vehicles_ref',
        'game_animals',
        'game_crops',
        'game_car_upgrades',
        'game_ammo_types',
        'game_repair_data',
        'game_furniture',
        'game_traps',
        'game_sprays',
        'game_quests',
        'game_lore',
        'game_loading_tips',
        'game_spawn_locations',
        'game_server_setting_defs',
      ]);

      try {
        const db = srv.db.db;
        if (!db) return res.json({ tables: [] });
        const allTables = db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
          .all() as Array<{ name: string }>;
        const tables = [];

        for (const t of allTables) {
          if (!ALLOWED.has(t.name)) continue;
          try {
            const row = db.prepare(`SELECT COUNT(*) as c FROM "${t.name}"`).get() as { c: number } | undefined;
            const cols = db.prepare(`PRAGMA table_info("${t.name}")`).all() as {
              name: string;
              type: string;
              pk: number;
              notnull: number;
            }[];
            tables.push({
              name: t.name,
              rowCount: row?.c || 0,
              columns: cols.map((c) => ({
                name: c.name,
                type: c.type,
                pk: c.pk === 1,
                nullable: c.notnull === 0,
              })),
            });
          } catch {
            /* skip inaccessible tables */
          }
        }

        res.json({ tables });
      } catch (err: unknown) {
        sendError(res, API_ERRORS.INTERNAL_SERVER_ERROR, 500, safeError(err));
      }
    });

    // ── Panel: Raw SQL query (SELECT only, admin) ──
    app.post('/api/panel/db/query', requireTier('admin'), rateLimit(10000, 5), (req, res) => {
      const srv = req.srv;
      if (!srv.db) {
        sendErrorWithData(res, API_ERRORS.NO_DATABASE, { rows: [], columns: [] });
        return;
      }

      const body = req.body as { sql?: string; limit?: string | number };
      const sql = (body.sql || '').trim();
      if (!sql) {
        sendError(res, API_ERRORS.NO_SQL_PROVIDED, 400);
        return;
      }

      // Only allow SELECT statements
      const upper = sql
        .replace(/\/\*[^*]*(?:\*(?!\/)[^*]*)*\*\//g, '')
        .replace(/--[^\n]*/g, '')
        .trim()
        .toUpperCase();
      if (!upper.startsWith('SELECT')) {
        sendError(res, API_ERRORS.ONLY_SELECT_ALLOWED, 400);
        return;
      }
      // Block dangerous keywords after SELECT
      if (/\b(DROP|DELETE|INSERT|UPDATE|ALTER|CREATE|ATTACH|DETACH|REPLACE|PRAGMA\s+\w+\s*=)\b/i.test(sql)) {
        sendError(res, API_ERRORS.QUERY_CONTAINS_DISALLOWED_KEYWORDS, 400);
        return;
      }

      const limit = Math.min(parseInt(String(body.limit ?? '200'), 10) || 200, 1000);

      try {
        const db = srv.db.db;
        if (!db) {
          sendErrorWithData(res, API_ERRORS.NO_DATABASE, { rows: [], columns: [] });
          return;
        }
        // Wrap in a limited query if no LIMIT clause
        let query = sql;
        if (!/\bLIMIT\b/i.test(sql)) {
          query = sql.replace(/;?\s*$/, '') + ' LIMIT ' + String(limit);
        }

        const rows = db.prepare(query).all() as Record<string, unknown>[];
        const columns = rows.length > 0 ? Object.keys(rows[0] ?? {}) : [];

        res.json({ rows, columns, count: rows.length });
      } catch (err: unknown) {
        sendError(res, API_ERRORS.INTERNAL_SERVER_ERROR, 400, safeError(err));
      }
    });

    // ── Panel: Clans from DB ──
    app.get('/api/panel/clans', requireTier('survivor'), (req, res) => {
      const srv = req.srv;
      if (!srv.db) return res.json({ clans: [] });

      try {
        const clans = srv.db.getAllClans();
        res.json({ clans });
      } catch (err: unknown) {
        sendError(res, API_ERRORS.INTERNAL_SERVER_ERROR, 500, safeError(err));
      }
    });

    // ── Panel: Map world data (structures, vehicles, containers, companions, dead bodies) ──
    app.get('/api/panel/mapdata', requireTier('survivor'), rateLimit(10000, 10), (req, res) => {
      const srv = req.srv;
      if (!srv.db) return res.json({ structures: [], vehicles: [], containers: [], companions: [], deadBodies: [] });

      const layers = ((req.query.layers as string) || 'all').split(',');
      const showAll = layers.includes('all');
      const result: Record<string, unknown> = {};

      try {
        const sdb = srv.db.db;
        if (!sdb) return res.json({ structures: [], vehicles: [], containers: [], companions: [], deadBodies: [] });

        if (showAll || layers.includes('structures')) {
          const rows = sdb
            .prepare(
              'SELECT id, display_name, actor_class, owner_steam_id, pos_x, pos_y, pos_z, current_health, max_health, upgrade_level, inventory FROM structures WHERE pos_x IS NOT NULL',
            )
            .all() as StructureRow[];
          result.structures = rows.map((r: StructureRow) => {
            const [lat, lng] = this._worldToLeaflet(r.pos_x, r.pos_y);
            let itemCount = 0;
            try {
              const items = JSON.parse(r.inventory || '[]') as unknown[];
              itemCount = items.filter((i: unknown) => i && i !== 'Empty' && i !== 'None').length;
            } catch {}
            return {
              id: r.id,
              name: r.display_name || cleanActorName(r.actor_class),
              owner: r.owner_steam_id,
              lat,
              lng,
              health: r.current_health,
              maxHealth: r.max_health,
              upgrade: r.upgrade_level,
              itemCount,
            };
          });
        }

        if (showAll || layers.includes('vehicles')) {
          const rows = sdb
            .prepare(
              'SELECT id, display_name, class, pos_x, pos_y, pos_z, health, max_health, fuel FROM vehicles WHERE pos_x IS NOT NULL',
            )
            .all() as VehicleRow[];
          result.vehicles = rows.map((r: VehicleRow) => {
            const [lat, lng] = this._worldToLeaflet(r.pos_x, r.pos_y);
            return {
              id: r.id,
              name: r.display_name || cleanActorName(r.class),
              lat,
              lng,
              health: r.health,
              maxHealth: r.max_health,
              fuel: Math.round(r.fuel * 10) / 10,
            };
          });
        }

        if (showAll || layers.includes('containers')) {
          const rows = sdb
            .prepare(
              'SELECT actor_name, pos_x, pos_y, pos_z, items, locked FROM containers WHERE pos_x IS NOT NULL AND pos_x != 0',
            )
            .all() as ContainerRow[];
          result.containers = rows.map((r: ContainerRow) => {
            const [lat, lng] = this._worldToLeaflet(r.pos_x, r.pos_y);
            let itemCount = 0;
            try {
              const items = JSON.parse(r.items || '[]') as unknown[];
              itemCount = items.filter(
                (i: unknown) =>
                  i &&
                  typeof i === 'object' &&
                  (i as Record<string, unknown>).item &&
                  (i as Record<string, unknown>).item !== 'None' &&
                  (i as Record<string, unknown>).item !== 'Empty',
              ).length;
            } catch {}
            return { name: cleanActorName(r.actor_name), lat, lng, locked: !!r.locked, itemCount };
          });
        }

        if (showAll || layers.includes('companions')) {
          const rows = sdb
            .prepare(
              'SELECT id, type, actor_name, owner_steam_id, pos_x, pos_y, pos_z, health, extra FROM companions WHERE pos_x IS NOT NULL',
            )
            .all() as CompanionRow[];
          result.companions = rows.map((r: CompanionRow) => {
            const [lat, lng] = this._worldToLeaflet(r.pos_x, r.pos_y);
            return { id: r.id, type: r.type, owner: r.owner_steam_id, lat, lng, health: r.health };
          });
        }

        if (showAll || layers.includes('deadBodies')) {
          const rows = sdb
            .prepare('SELECT actor_name, pos_x, pos_y, pos_z FROM dead_bodies WHERE pos_x IS NOT NULL')
            .all() as DeadBodyRow[];
          result.deadBodies = rows.map((r: DeadBodyRow) => {
            const [lat, lng] = this._worldToLeaflet(r.pos_x, r.pos_y);
            return { name: r.actor_name, lat, lng };
          });
        }

        // AI layers from latest timeline snapshot
        const wantAI =
          showAll || layers.includes('zombies') || layers.includes('animals') || layers.includes('bandits');
        if (wantAI) {
          try {
            const latestSnap = sdb
              .prepare('SELECT id FROM timeline_snapshots ORDER BY created_at DESC LIMIT 1')
              .get() as { id: number } | undefined;
            if (latestSnap) {
              const aiRows = sdb
                .prepare(
                  'SELECT ai_type, category, display_name, pos_x, pos_y FROM timeline_ai WHERE snapshot_id = ? AND pos_x IS NOT NULL',
                )
                .all(latestSnap.id) as Array<{
                ai_type: string;
                category: string;
                display_name: string;
                pos_x: number;
                pos_y: number;
              }>;
              const zombies = [],
                animals = [],
                bandits = [];
              for (const r of aiRows) {
                if (r.pos_x === 0 && r.pos_y === 0) continue;
                const [lat, lng] = this._worldToLeaflet(r.pos_x, r.pos_y);
                const entry = { name: r.display_name || cleanActorName(r.ai_type), lat, lng, type: r.ai_type };
                if (r.category === 'zombie') zombies.push(entry);
                else if (r.category === 'animal') animals.push(entry);
                else if (r.category === 'bandit') bandits.push(entry);
              }
              if (showAll || layers.includes('zombies')) result.zombies = zombies;
              if (showAll || layers.includes('animals')) result.animals = animals;
              if (showAll || layers.includes('bandits')) result.bandits = bandits;
            }
          } catch {
            /* timeline_ai may not exist yet */
          }
        }

        // Build steam_id → name lookup for owner resolution
        const nameMap: Record<string, string> = {};
        const nameRows = sdb.prepare('SELECT steam_id, name FROM players').all() as {
          steam_id: string;
          name: string;
        }[];
        for (const nr of nameRows) nameMap[nr.steam_id] = nr.name;
        result.nameMap = nameMap;

        res.json(result);
      } catch (err: unknown) {
        sendError(res, API_ERRORS.INTERNAL_SERVER_ERROR, 500, safeError(err));
      }
    });

    // ── Panel: Item Tracking API ──

    // GET /api/panel/items — All tracked items (instances + groups), with filters
    app.get('/api/panel/items', requireTier('admin'), rateLimit(10000, 15), (req, res) => {
      const srv = req.srv;
      if (!srv.db) return res.json({ instances: [], groups: [], total: 0 });
      try {
        const search = (req.query.search as string) || '';
        const locationType = (req.query.locationType as string) || '';
        const locationId = (req.query.locationId as string) || '';
        const limit = Math.min(parseInt((req.query.limit as string) || '', 10) || 100, 500);

        let instances: ItemInstanceRow[], groups: ItemGroupRow[];

        if (search) {
          instances = srv.db.searchItemInstances(search, limit) as ItemInstanceRow[];
          groups = srv.db.searchItemGroups(search, limit) as ItemGroupRow[];
        } else if (locationType && locationId) {
          instances = srv.db.getItemInstancesByLocation(locationType, locationId) as ItemInstanceRow[];
          groups = srv.db.getItemGroupsByLocation(locationType, locationId) as ItemGroupRow[];
        } else {
          instances = srv.db.getActiveItemInstances() as ItemInstanceRow[];
          groups = srv.db.getActiveItemGroups() as ItemGroupRow[];
        }

        // Parse attachments JSON
        for (const inst of instances) {
          try {
            inst.attachments = JSON.parse(inst.attachments as string) as string[];
          } catch {
            inst.attachments = [];
          }
        }
        for (const grp of groups) {
          try {
            grp.attachments = JSON.parse(grp.attachments as string) as string[];
          } catch {
            grp.attachments = [];
          }
        }

        // Build location summary for sidebar
        const locationSummary: Record<
          string,
          { type: string; id: string; instanceCount: number; groupCount: number; totalItems: number }
        > = {};
        for (const inst of instances) {
          const key = `${inst.location_type}|${inst.location_id}`;
          if (!locationSummary[key])
            locationSummary[key] = {
              type: inst.location_type,
              id: inst.location_id,
              instanceCount: 0,
              groupCount: 0,
              totalItems: 0,
            };
          locationSummary[key].totalItems += inst.amount || 1;
          locationSummary[key].instanceCount++;
        }
        for (const grp of groups) {
          const key = `${grp.location_type}|${grp.location_id}`;
          if (!locationSummary[key])
            locationSummary[key] = {
              type: grp.location_type,
              id: grp.location_id,
              instanceCount: 0,
              groupCount: 0,
              totalItems: 0,
            };
          locationSummary[key].groupCount++;
          locationSummary[key].totalItems += grp.quantity;
        }

        res.json({
          instances,
          groups,
          locations: Object.values(locationSummary),
          counts: {
            instances: srv.db.getItemInstanceCount(),
            groups: srv.db.getItemGroupCount(),
          },
        });
      } catch (err: unknown) {
        sendError(res, API_ERRORS.INTERNAL_SERVER_ERROR, 500, safeError(err));
      }
    });

    // GET /api/panel/items/:id/movements — Movement history for an instance
    app.get('/api/panel/items/:id/movements', requireTier('admin'), (req, res) => {
      const srv = req.srv;
      if (!srv.db) return res.json({ movements: [] });
      try {
        const id = parseInt(req.params.id as string, 10);
        const instance = srv.db.getItemInstance(id);
        if (!instance) {
          sendError(res, API_ERRORS.INSTANCE_NOT_FOUND, 404);
          return;
        }

        const movements = srv.db.getItemMovements(id) as ItemMovementRow[];
        res.json({ instance, movements });
      } catch (err: unknown) {
        sendError(res, API_ERRORS.INTERNAL_SERVER_ERROR, 500, safeError(err));
      }
    });

    // GET /api/panel/groups/:id — Group detail with movement history
    app.get('/api/panel/groups/:id', requireTier('admin'), (req, res) => {
      const srv = req.srv;
      if (!srv.db) return res.json({ group: null, movements: [] });
      try {
        const id = parseInt(req.params.id as string, 10);
        const group = srv.db.getItemGroup(id) as ItemGroupRow | undefined;
        if (!group) {
          sendError(res, API_ERRORS.GROUP_NOT_FOUND, 404);
          return;
        }
        let groupAttachments: unknown = group.attachments;
        try {
          groupAttachments = JSON.parse(group.attachments as string);
        } catch {
          groupAttachments = [];
        }
        const groupOut = { ...group, attachments: groupAttachments };

        const movements = srv.db.getItemMovementsByGroup(id) as ItemMovementRow[];
        res.json({ group: groupOut, movements });
      } catch (err: unknown) {
        sendError(res, API_ERRORS.INTERNAL_SERVER_ERROR, 500, safeError(err));
      }
    });

    // GET /api/panel/movements — Recent item movements across all items
    app.get('/api/panel/movements', requireTier('admin'), (req, res) => {
      const srv = req.srv;
      if (!srv.db) return res.json({ movements: [] });
      try {
        const limit = Math.min(parseInt((req.query.limit as string) || '', 10) || 50, 500);
        const steamId = (req.query.steamId as string) || '';
        const locationType = (req.query.locationType as string) || '';
        const locationId = (req.query.locationId as string) || '';

        let movements;
        if (steamId) {
          movements = srv.db.getItemMovementsByPlayer(steamId, limit) as ItemMovementRow[];
        } else if (locationType && locationId) {
          movements = srv.db.getItemMovementsByLocation(locationType, locationId, limit) as ItemMovementRow[];
        } else {
          movements = srv.db.getRecentItemMovements(limit) as ItemMovementRow[];
        }

        res.json({ movements });
      } catch (err: unknown) {
        sendError(res, API_ERRORS.INTERNAL_SERVER_ERROR, 500, safeError(err));
      }
    });

    // GET /api/panel/items/lookup — Look up item instance/group by name + fingerprint data
    // Used by item popups across the entire UI to bridge save data → item tracking DB
    app.get('/api/panel/items/lookup', requireTier('survivor'), (req, res) => {
      const srv = req.srv;
      if (!srv.db) return res.json({ match: null, movements: [] });
      try {
        const { fingerprint, item: itemName, steamId } = req.query;
        if (!fingerprint && !itemName) {
          sendError(res, API_ERRORS.NEED_FINGERPRINT_OR_ITEM_NAME, 400);
          return;
        }

        let match: ((ItemInstanceRow | ItemGroupRow) & { attachments?: unknown }) | null = null;
        let movements: ItemMovementRow[] = [];
        let matchType = null; // 'instance' or 'group'

        // Try exact fingerprint match first
        if (fingerprint) {
          // Check instances
          const instances = srv.db.findItemsByFingerprint(fingerprint as string) as ItemInstanceRow[];
          if (instances.length > 0) {
            // If steamId provided, prefer the instance at that player's location
            const inst = steamId
              ? (instances.find((i: ItemInstanceRow) => i.location_type === 'player' && i.location_id === steamId) ??
                instances[0])
              : instances[0];
            match = inst ?? null;
            matchType = 'instance';
            if (match) {
              try {
                match.attachments = JSON.parse(match.attachments as string) as string[];
              } catch {
                match.attachments = [];
              }
              movements = srv.db.getItemMovements(match.id) as ItemMovementRow[];
            }
          }

          // Check groups if no instance match
          if (!match) {
            const groups = srv.db.findActiveGroupsByFingerprint(fingerprint as string) as ItemGroupRow[];
            if (groups.length > 0) {
              const grp = steamId
                ? (groups.find((g: ItemGroupRow) => g.location_type === 'player' && g.location_id === steamId) ??
                  groups[0])
                : groups[0];
              match = grp ?? null;
              matchType = 'group';
              if (match) {
                try {
                  match.attachments = JSON.parse(match.attachments as string) as string[];
                } catch {
                  match.attachments = [];
                }
                movements = srv.db.getItemMovementsByGroup(match.id) as ItemMovementRow[];
              }
            }
          }
        }

        // Fall back to item name search if no fingerprint match
        if (!match && itemName) {
          const instances = srv.db.getItemInstancesByItem(itemName as string) as ItemInstanceRow[];
          if (instances.length > 0) {
            const inst = steamId
              ? (instances.find((i: ItemInstanceRow) => i.location_type === 'player' && i.location_id === steamId) ??
                instances[0])
              : instances[0];
            match = inst ?? null;
            matchType = 'instance';
            if (match) {
              try {
                match.attachments = JSON.parse(match.attachments as string) as string[];
              } catch {
                match.attachments = [];
              }
              movements = srv.db.getItemMovements(match.id) as ItemMovementRow[];
            }
          }
        }

        // Resolve player names in movements
        const nameCache: Record<string, string> = {};
        const resolveName = (sid: string) => {
          if (!sid) return null;
          if (nameCache[sid]) return nameCache[sid];
          const name = srv.idMap[sid] || sid;
          nameCache[sid] = name;
          return name;
        };

        // Enrich movement data with resolved names
        const enrichedMovements = movements.map((m: ItemMovementRow) => ({
          ...m,
          from_name: m.from_type === 'player' ? resolveName(m.from_id) : null,
          to_name: m.to_type === 'player' ? resolveName(m.to_id) : null,
          attributed_name: m.attributed_name || resolveName(m.attributed_steam_id),
        }));

        // Build ownership chain — unique players who have held this item
        const ownershipChain = [];
        const seenOwners = new Set();
        for (const m of movements) {
          if (m.to_type === 'player' && m.to_id && !seenOwners.has(m.to_id)) {
            seenOwners.add(m.to_id);
            ownershipChain.push({ steamId: m.to_id, name: resolveName(m.to_id), at: m.created_at });
          }
        }

        res.json({
          match,
          matchType,
          movements: enrichedMovements,
          ownershipChain,
          totalMovements: movements.length,
        });
      } catch (err: unknown) {
        sendError(res, API_ERRORS.INTERNAL_SERVER_ERROR, 500, safeError(err));
      }
    });

    // ── Panel: Entity lookup (survivor+) — lightweight reference data for info popups ──
    app.get('/api/panel/lookup/:type/:name', requireTier('survivor'), rateLimit(5000, 20), (req, res) => {
      const srv = req.srv;
      if (!srv.db) return res.json({ found: false });
      const type = req.params.type as string;
      const name = decodeURIComponent((req.params.name as string) || '');
      if (!name) return res.json({ found: false });

      const db = srv.db.db;
      if (!db) return res.json({ found: false });
      const result: Record<string, unknown> = { found: false, type, name, data: {} };

      try {
        // Route by type to appropriate reference/world table
        if (type === 'item') {
          const row = db.prepare('SELECT * FROM game_items WHERE name LIKE ? LIMIT 1').get(`%${name}%`);
          if (row) {
            result.found = true;
            result.data = row;
            result.refTable = 'game_items';
          }
        } else if (type === 'structure' || type === 'building') {
          const row = db.prepare('SELECT * FROM game_buildings WHERE name LIKE ? LIMIT 1').get(`%${name}%`);
          if (row) {
            result.found = true;
            result.data = row;
            result.refTable = 'game_buildings';
          }
          if (!result.found) {
            const wRow = db.prepare('SELECT * FROM structures WHERE type LIKE ? LIMIT 1').get(`%${name}%`);
            if (wRow) {
              result.found = true;
              result.data = wRow;
              result.refTable = 'structures';
            }
          }
        } else if (type === 'vehicle') {
          const row = db.prepare('SELECT * FROM game_vehicles_ref WHERE name LIKE ? LIMIT 1').get(`%${name}%`);
          if (row) {
            result.found = true;
            result.data = row;
            result.refTable = 'game_vehicles_ref';
          }
        } else if (type === 'animal') {
          const row = db.prepare('SELECT * FROM game_animals WHERE name LIKE ? LIMIT 1').get(`%${name}%`);
          if (row) {
            result.found = true;
            result.data = row;
            result.refTable = 'game_animals';
          }
        } else if (type === 'recipe') {
          const row = db.prepare('SELECT * FROM game_recipes WHERE name LIKE ? LIMIT 1').get(`%${name}%`);
          if (row) {
            result.found = true;
            result.data = row;
            result.refTable = 'game_recipes';
          }
        } else if (type === 'affliction') {
          const row = db.prepare('SELECT * FROM game_afflictions WHERE name LIKE ? LIMIT 1').get(`%${name}%`);
          if (row) {
            result.found = true;
            result.data = row;
            result.refTable = 'game_afflictions';
          }
        } else if (type === 'skill') {
          const row = db.prepare('SELECT * FROM game_skills WHERE name LIKE ? LIMIT 1').get(`%${name}%`);
          if (row) {
            result.found = true;
            result.data = row;
            result.refTable = 'game_skills';
          }
        } else if (type === 'container') {
          const row = db.prepare('SELECT * FROM containers WHERE type LIKE ? LIMIT 1').get(`%${name}%`);
          if (row) {
            result.found = true;
            result.data = row;
            result.refTable = 'containers';
          }
        }

        // Fallback: try game_items for anything not found
        if (!result.found) {
          const fallback = db.prepare('SELECT * FROM game_items WHERE name LIKE ? LIMIT 1').get(`%${name}%`);
          if (fallback) {
            result.found = true;
            result.data = fallback;
            result.refTable = 'game_items';
          }
        }

        // Count activity log references
        const actCount = db
          .prepare('SELECT COUNT(*) as c FROM activity_log WHERE details LIKE ? OR item LIKE ?')
          .get(`%${name}%`, `%${name}%`);
        result.activityCount = (actCount as Record<string, unknown>).c || 0;

        res.json(result);
      } catch (err: unknown) {
        sendError(res, API_ERRORS.INTERNAL_SERVER_ERROR, 500, safeError(err));
      }
    });

    // ── Panel: Comprehensive DB query (admin only) ──
    app.get('/api/panel/db/:table', requireTier('admin'), rateLimit(10000, 15), (req, res) => {
      const srv = req.srv;
      if (!srv.db) return res.json({ rows: [], columns: [] });

      const table = req.params.table as string;
      // Defense-in-depth: validate table name is alphanumeric + underscores only
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table)) {
        sendError(res, API_ERRORS.INVALID_TABLE_NAME, 400);
        return;
      }
      const limit = Math.min(parseInt((req.query.limit as string) || '', 10) || 50, 1000);
      const search = (req.query.search as string) || '';

      // Whitelist of queryable tables
      const ALLOWED = new Set([
        'activity_log',
        'chat_log',
        'players',
        'player_aliases',
        'clans',
        'clan_members',
        'world_state',
        'structures',
        'vehicles',
        'companions',
        'world_horses',
        'dead_bodies',
        'containers',
        'loot_actors',
        'quests',
        'server_settings',
        'snapshots',
        // 'game_items',
        'game_professions',
        'game_afflictions',
        'game_skills',
        'game_challenges',
        'game_recipes',
        'item_instances',
        'item_movements',
        'item_groups',
        'world_drops',
        // v11 reference tables
        'game_buildings',
        'game_loot_pools',
        'game_loot_pool_items',
        'game_vehicles_ref',
        'game_animals',
        'game_crops',
        'game_car_upgrades',
        'game_ammo_types',
        'game_repair_data',
        'game_furniture',
        'game_traps',
        'game_sprays',
        'game_quests',
        'game_lore',
        'game_loading_tips',
        'game_spawn_locations',
        'game_server_setting_defs',
      ]);

      if (!ALLOWED.has(table)) {
        sendError(res, API_ERRORS.TABLE_NOT_QUERYABLE, 400, table);
        return;
      }
      // Defense-in-depth: validate table name is a safe SQL identifier
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table)) {
        sendError(res, API_ERRORS.INVALID_TABLE_NAME, 400);
        return;
      }

      try {
        const db = srv.db.db;
        if (!db) return res.json({ rows: [], columns: [] });

        // Get column names
        const pragma = db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string; type: string }[];
        const columns = pragma.map((c) => c.name);

        // Build query with optional search
        let query = `SELECT * FROM "${table}"`;
        const params = [];

        if (search) {
          // Search across text columns
          const textCols = pragma.filter(
            (c) => c.type.toUpperCase().includes('TEXT') || c.type === '' || c.type.toUpperCase().includes('VARCHAR'),
          );
          if (textCols.length > 0) {
            const clauses = textCols.map((c) => `"${c.name}" LIKE ?`);
            query += ` WHERE ${clauses.join(' OR ')}`;
            for (let i = 0; i < textCols.length; i++) params.push(`%${search}%`);
          }
        }

        // Order by most recent first if created_at or updated_at exists
        if (columns.includes('created_at')) query += ' ORDER BY created_at DESC';
        else if (columns.includes('updated_at')) query += ' ORDER BY updated_at DESC';
        else if (columns.includes('id')) query += ' ORDER BY id DESC';

        query += ` LIMIT ?`;
        params.push(limit);

        const rows = db.prepare(query).all(...params);

        // Resolve steam IDs in player-related tables
        if (columns.includes('steam_id') || columns.includes('owner_steam_id')) {
          for (const row of rows as DbRow[]) {
            const sid = (row.steam_id || row.owner_steam_id) as string;
            if (sid && srv.idMap[sid] && !row.name && !row.actor_name && !row.player_name) {
              row._resolved_name = srv.idMap[sid];
            }
          }
        }

        res.json({ table, columns, rows, total: rows.length });
      } catch (err: unknown) {
        sendError(res, API_ERRORS.INTERNAL_SERVER_ERROR, 500, safeError(err));
      }
    });

    // ── Panel: Chat log from DB ──
    app.get('/api/panel/chat', requireTier('survivor'), (req, res) => {
      const srv = req.srv;
      if (!srv.db) return res.json({ messages: [] });

      const limit = Math.min(parseInt((req.query.limit as string) || '', 10) || 100, 1000);
      const search = ((req.query.search as string) || '').trim();

      try {
        let messages: ChatRow[];
        if (search) {
          messages = srv.db.searchChat(search, limit) as ChatRow[];
        } else {
          messages = srv.db.getRecentChat(limit) as ChatRow[];
        }
        res.json({ messages });
      } catch (err: unknown) {
        sendError(res, API_ERRORS.INTERNAL_SERVER_ERROR, 500, safeError(err));
      }
    });

    // ── Panel: RCON command execution ──
    app.post('/api/panel/rcon', requireTier('admin'), rateLimit(10000, 10), async (req, res) => {
      const { command } = req.body as { command?: string };
      if (!command || typeof command !== 'string') {
        sendError(res, API_ERRORS.MISSING_COMMAND, 400);
        return;
      }
      if (command.length > 500) {
        sendError(res, API_ERRORS.COMMAND_TOO_LONG, 400);
        return;
      }

      // Sanitize: strip control chars and newlines to prevent RCON protocol injection
      const sanitized = stripControlChars(command)
        .replace(/[\r\n]+/g, ' ')
        .trim();
      if (!sanitized) {
        sendError(res, API_ERRORS.COMMAND_EMPTY_AFTER_SANITIZATION, 400);
        return;
      }

      // Safety: block dangerous commands by first word (consolidated blocklist)
      const cmdWord = sanitized.toLowerCase().split(/\s+/)[0];
      const BLOCKED_RCON = new Set([
        'exit',
        'quit',
        'shutdown',
        'destroyall',
        'destroy_all',
        'wipe',
        'reset',
        'restartnow',
        'quickrestart',
        'cancelrestart',
      ]);
      if (cmdWord && BLOCKED_RCON.has(cmdWord)) {
        sendError(res, API_ERRORS.COMMAND_BLOCKED_FOR_SAFETY, 403, cmdWord);
        return;
      }

      try {
        const response = await req.srv.rcon.send(sanitized);
        res.json({ ok: true, response });
      } catch (err: unknown) {
        sendError(res, API_ERRORS.INTERNAL_SERVER_ERROR, 500, safeError(err));
      }
    });

    // POST /api/panel/refresh-snapshot — Force game save + re-poll save file + record fresh snapshot
    app.post('/api/panel/refresh-snapshot', requireTier('mod'), rateLimit(30000, 2), async (req, res) => {
      if (!this._saveService) {
        sendError(res, API_ERRORS.SAVE_SERVICE_NOT_AVAILABLE, 503);
        return;
      }

      try {
        // Step 1: Tell the game server to save
        try {
          await req.srv.rcon.send('save');
        } catch {
          /* RCON may not be connected — continue anyway, save file may still be recent */
        }

        // Step 2: Wait briefly for the save to flush to disk
        await new Promise((resolve) => setTimeout(resolve, 2000));

        // Step 3: Force save service to re-poll (downloads .sav, parses, syncs DB, emits 'sync' → snapshot recorded)
        await this._saveService._poll(true);

        sendOk(res, { message: 'Snapshot refreshed' });
      } catch (err: unknown) {
        sendError(res, API_ERRORS.INTERNAL_SERVER_ERROR, 500, safeError(err));
      }
    });

    // ── Panel: Server power controls ──
    // Supports Docker CLI (VPS), Pterodactyl API, or SSH-based controls
    app.post('/api/panel/power', requireTier('admin'), rateLimit(30000, 3), async (req, res) => {
      const { action } = req.body as { action?: string };
      const valid = ['start', 'stop', 'restart', 'backup', 'kill'];
      if (!action || !valid.includes(action)) {
        sendError(res, API_ERRORS.INVALID_ACTION, 400, action);
        return;
      }

      // Try Pterodactyl API first (per-server or primary singleton)
      const srvPanelApi = req.srv.panelApi;
      if (srvPanelApi && srvPanelApi.available) {
        try {
          if (action === 'backup') {
            await srvPanelApi.createBackup();
            sendOk(res, { message: 'Backup initiated via panel API' });
            return;
          }
          await srvPanelApi.sendPowerAction(action);
          sendOk(res, { message: `Server ${action} sent via panel API` });
          return;
        } catch (err: unknown) {
          sendError(res, API_ERRORS.INTERNAL_SERVER_ERROR, 500, safeError(err));
          return;
        }
      }

      // Fall back to Docker CLI (VPS setup)
      const { execFile } = await import('child_process');
      // Use server-specific container name, fall back to env
      const dockerContainer = (req.srv.config.dockerContainer || process.env.DOCKER_CONTAINER || 'hzserver').replace(
        /[^a-zA-Z0-9_.-]/g,
        '',
      );

      if (action === 'backup') {
        const backupDir = path.join(req.srv.dataDir, 'backups', new Date().toISOString().replace(/[:.]/g, '-'));
        execFile(
          'docker',
          ['cp', `${dockerContainer}:/home/steam/hzserver/serverfiles/HumanitZServer/Saved`, backupDir],
          { timeout: 30000 },
          (err: Error | null) => {
            if (err) {
              sendError(res, API_ERRORS.BACKUP_FAILED, 500);
              return;
            }
            sendOk(res, { message: 'Backup created' });
          },
        );
        return;
      }

      execFile(
        'docker',
        [action, dockerContainer],
        { timeout: 30000 },
        (err: Error | null, _stdout: string, _stderr: string) => {
          if (err) {
            sendError(res, API_ERRORS.DOCKER_COMMAND_FAILED, 500);
            return;
          }
          sendOk(res, { message: `Server ${action} executed` });
        },
      );
    });

    // ── Panel: List backups ──
    app.get('/api/panel/backups', requireTier('admin'), rateLimit(10000, 5), async (req, res) => {
      const backups = [];

      // Try Pterodactyl API first (per-server or primary singleton)
      try {
        const srvPanelApi = req.srv.panelApi;
        if (srvPanelApi && srvPanelApi.available) {
          const list = await srvPanelApi.listBackups();
          if (list.length) {
            for (const b of list) {
              backups.push({
                name: b.name || b.uuid,
                uuid: b.uuid,
                size: b.bytes || 0,
                created: b.created_at || b.completed_at,
                source: 'panel',
              });
            }
            return res.json({ backups });
          }
        }
      } catch (_e) {
        /* panel API unavailable — fall through */
      }

      // Fall back to local data/backups/ directory
      const backupsDir = path.join(req.srv.dataDir, 'backups');
      try {
        if (fs.existsSync(backupsDir)) {
          const entries = fs.readdirSync(backupsDir, { withFileTypes: true });
          for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const stat = fs.statSync(path.join(backupsDir, entry.name));
            backups.push({
              name: entry.name,
              uuid: entry.name,
              size: 0,
              created: stat.mtime.toISOString(),
              source: 'local',
            });
          }
          backups.sort(
            (a: Record<string, unknown>, b: Record<string, unknown>) =>
              new Date(b.created as string).getTime() - new Date(a.created as string).getTime(),
          );
        }
      } catch (_e) {
        /* directory not readable */
      }

      res.json({ backups });
    });

    // Sensitive keys that should never be exposed or written via API
    const HIDDEN_SETTINGS = new Set(['AdminPass', 'RCONPass', 'Password', 'RConPort', 'RCONEnabled']);
    function filterSettings(settings: Record<string, unknown>): Record<string, unknown> {
      const filtered: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(settings)) {
        if (!HIDDEN_SETTINGS.has(k) && !k.startsWith('_')) filtered[k] = v;
      }
      return filtered;
    }

    // ── Panel: Game server settings (read) ──
    app.get('/api/panel/settings', requireTier('admin'), async (req, res) => {
      const srv = req.srv;
      // Try loading from cached file first
      const settingsFile = path.join(srv.dataDir, 'server-settings.json');
      try {
        if (fs.existsSync(settingsFile)) {
          const data = JSON.parse(fs.readFileSync(settingsFile, 'utf8')) as Record<string, unknown>;
          return res.json({ settings: filterSettings(data) });
        }
      } catch {
        /* fall through to SFTP */
      }

      // Try reading via SFTP
      if (srv.config.sftpHost && srv.config.sftpUser) {
        try {
          const SftpClient = (await import('ssh2-sftp-client')).default;
          const sftp = new SftpClient();
          await sftp.connect(srv.config.sftpConnectConfig());
          const content = await sftp.get(srv.config.sftpSettingsPath);
          await sftp.end();

          const settings: Record<string, string> = {};
          const lines = (content as Buffer).toString().split('\n');
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('[') || trimmed.startsWith(';')) continue;
            const eq = trimmed.indexOf('=');
            if (eq > 0) {
              settings[trimmed.substring(0, eq).trim()] = trimmed.substring(eq + 1).trim();
            }
          }
          // Cache for next time
          fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
          res.json({ settings: filterSettings(settings) });
        } catch (err: unknown) {
          sendError(res, API_ERRORS.FAILED_TO_READ_SETTINGS, 500, safeError(err));
        }
      } else {
        sendError(res, API_ERRORS.NO_SETTINGS_AVAILABLE_SFTP_NOT_CONFIGURED, 404);
      }
    });

    // ── Panel: Game server settings (write) ──
    app.post('/api/panel/settings', requireTier('admin'), rateLimit(30000, 5), async (req, res) => {
      const { settings } = req.body as { settings?: Record<string, unknown> };
      if (!settings || typeof settings !== 'object') {
        sendError(res, API_ERRORS.MISSING_SETTINGS_OBJECT, 400);
        return;
      }

      // Block writes to sensitive keys — same set filtered on read, enforced on write
      const rejected = Object.keys(settings).filter((k) => HIDDEN_SETTINGS.has(k) || k.startsWith('_'));
      if (rejected.length > 0) {
        sendError(res, API_ERRORS.CANNOT_WRITE_PROTECTED_SETTINGS, 403, rejected.join(', '));
        return;
      }
      // Validate values: no newlines, no INI section injection
      for (const [key, value] of Object.entries(settings)) {
        const v = String(value);
        if (/[\r\n]/.test(v) || /^\[/.test(v.trim())) {
          sendError(res, API_ERRORS.INVALID_VALUE_CONTAINS_ILLEGAL_CHARACTERS, 400, key);
          return;
        }
      }

      if (!req.srv.config.sftpHost || !req.srv.config.sftpUser) {
        sendError(res, API_ERRORS.SFTP_NOT_CONFIGURED, 400);
        return;
      }

      try {
        const SftpClient = (await import('ssh2-sftp-client')).default;
        const sftp = new SftpClient();
        await sftp.connect(req.srv.config.sftpConnectConfig());

        // Read current file
        const content = ((await sftp.get(req.srv.config.sftpSettingsPath)) as Buffer).toString();
        const lines = content.split('\n');

        // Update values in-place
        const updated = new Set();
        const newLines = lines.map((line: string) => {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('[') || trimmed.startsWith(';')) return line;
          const eq = trimmed.indexOf('=');
          if (eq <= 0) return line;
          const key = trimmed.substring(0, eq).trim();
          if (key in settings) {
            updated.add(key);
            return `${key}=${String(settings[key])}`;
          }
          return line;
        });

        // Write back
        await sftp.put(Buffer.from(newLines.join('\n')), req.srv.config.sftpSettingsPath);
        await sftp.end();

        // Update local cache
        const settingsFile = path.join(req.srv.dataDir, 'server-settings.json');
        try {
          let cached: Record<string, string> = {};
          if (fs.existsSync(settingsFile))
            cached = JSON.parse(fs.readFileSync(settingsFile, 'utf8')) as Record<string, string>;
          Object.assign(cached, settings);
          fs.writeFileSync(settingsFile, JSON.stringify(cached, null, 2));
        } catch {
          /* cache update failed, not critical */
        }

        res.json({ ok: true, updated: [...updated] });
      } catch (err: unknown) {
        sendError(res, API_ERRORS.FAILED_TO_SAVE_SETTINGS, 500, safeError(err));
      }
    });

    // ── API: Server scheduler status ──
    app.get('/api/panel/scheduler', requireTier('survivor'), (req, res) => {
      // This will be populated by the bot when it passes the scheduler instance
      if (req.srv.scheduler) {
        res.json((req.srv.scheduler as Record<string, unknown> & { getStatus(): unknown }).getStatus());
      } else {
        res.json({ active: false });
      }
    });

    // ── Schedule Editor: save restart times, profiles, and per-profile settings ──
    app.post('/api/panel/scheduler', requireTier('admin'), rateLimit(30000, 3), (req, res) => {
      const { restartTimes, profiles, profileSettings, rotateDaily, serverNameTemplate } = req.body as {
        restartTimes?: string[];
        profiles?: string[];
        profileSettings?: Record<string, unknown>;
        rotateDaily?: boolean;
        serverNameTemplate?: string;
      };
      if (!restartTimes || !Array.isArray(restartTimes)) {
        sendError(res, API_ERRORS.RESTART_TIMES_INVALID, 400);
        return;
      }
      // Validate restart times format
      for (const t of restartTimes) {
        if (!/^\d{1,2}:\d{2}$/.test(t)) {
          sendError(res, API_ERRORS.INVALID_TIME_FORMAT, 400, t);
          return;
        }
      }
      // Validate profiles
      const profileList = Array.isArray(profiles)
        ? profiles.filter((p: unknown): p is string => typeof p === 'string' && !!p.trim())
        : [];
      const settings: Record<string, Record<string, unknown>> = profileSettings && typeof profileSettings === 'object'
        ? (profileSettings as Record<string, Record<string, unknown>>)
        : {};

      // Validate profile settings are JSON-safe objects
      for (const [name, val] of Object.entries(settings)) {
        if (typeof val !== 'object' || Array.isArray(val)) {
          sendError(res, API_ERRORS.PROFILE_SETTINGS_MUST_BE_OBJECT, 400, name);
          return;
        }
        // Ensure all values are strings (game server INI format)
        for (const [k, v] of Object.entries(val)) {
          if (typeof v !== 'string' && typeof v !== 'number') {
            sendError(res, API_ERRORS.INVALID_PROFILE_VALUE_TYPE, 400, `${name}.${k}`);
            return;
          }
        }
      }

      const timesStr = restartTimes.join(',');
      const profilesStr = profileList.map((p: string) => p.trim().toLowerCase()).join(',');

      // ── Non-primary: write to servers.json ──
      if (!req.srv.isPrimary) {
        try {
          const serverId = req.srv.serverId;
          const ok = _saveServerDef(serverId, (serverDef) => {
            serverDef.restartTimes = timesStr;
            serverDef.restartProfiles = profilesStr;
            serverDef.enableServerScheduler = restartTimes.length > 0;
            if (rotateDaily !== undefined) serverDef.restartRotateDaily = rotateDaily;
            if (typeof serverNameTemplate === 'string') serverDef.serverNameTemplate = serverNameTemplate;
            if (profileList.length > 0) {
              (serverDef.restartProfileSettings as Record<string, unknown>) = {};
              for (const name of profileList) {
                const key = name.trim().toLowerCase();
                if (settings[key]) (serverDef.restartProfileSettings as Record<string, unknown>)[key] = settings[key];
              }
            } else {
              Reflect.deleteProperty(serverDef, 'restartProfileSettings');
            }
          });
          if (!ok) {
            sendError(res, API_ERRORS.SERVER_NOT_FOUND, 404);
            return;
          }
          sendOk(res, {
            restartRequired: true,
            message: 'Schedule saved. Restart the bot for changes to take effect.',
          });
          return;
        } catch (err: unknown) {
          sendError(res, API_ERRORS.FAILED_TO_SAVE, 500, safeError(err));
          return;
        }
      }

      // ── Primary: write to .env ──
      try {
        const envPath = path.join(__dirname, '..', '..', '.env');
        if (!fs.existsSync(envPath)) {
          sendError(res, API_ERRORS.ENV_FILE_NOT_FOUND, 404);
          return;
        }

        const content = fs.readFileSync(envPath, 'utf8');
        const lines = content.split('\n');
        const updated = new Set();

        // Build the changes map
        const changes: Record<string, string> = {
          ENABLE_SERVER_SCHEDULER: restartTimes.length > 0 ? 'true' : 'false',
          RESTART_TIMES: timesStr,
          RESTART_PROFILES: profilesStr,
        };
        if (rotateDaily !== undefined) changes.RESTART_ROTATE_DAILY = rotateDaily ? 'true' : 'false';
        if (typeof serverNameTemplate === 'string') changes.SERVER_NAME_TEMPLATE = serverNameTemplate;

        // Add profile settings as RESTART_PROFILE_<NAME>=JSON
        for (const name of profileList) {
          const key = name.trim().toLowerCase();
          const envKey = `RESTART_PROFILE_${key.toUpperCase()}`;
          if (settings[key] && Object.keys(settings[key]).length > 0) {
            changes[envKey] = JSON.stringify(settings[key]);
          }
        }

        // Remove old RESTART_PROFILE_* that are no longer in the profile list
        const activeProfileKeys = new Set(profileList.map((p: string) => `RESTART_PROFILE_${p.trim().toUpperCase()}`));

        const newLines = lines.map((line: string) => {
          const trimmed = line.trim();
          const eq = trimmed.indexOf('=');
          if (eq > 0 && !trimmed.startsWith('#') && !trimmed.startsWith(';')) {
            const key = trimmed.substring(0, eq).trim();
            if (key in changes) {
              updated.add(key);
              return `${key}=${String(changes[key])}`;
            }
            // Comment out old profile keys that are no longer active
            if (key.startsWith('RESTART_PROFILE_') && !activeProfileKeys.has(key)) {
              updated.add(key);
              return `#${line}`;
            }
          }
          // Uncomment if it's a key we want to set
          if (trimmed.startsWith('#')) {
            const m = trimmed.match(/^#\s*([A-Z][A-Z0-9_]*)=(.*)/);
            if (m?.[1] && m[1] in changes) {
              updated.add(m[1]);
              return `${m[1]}=${String(changes[m[1]])}`;
            }
          }
          return line;
        });

        // Append any keys not found
        for (const key of Object.keys(changes)) {
          if (!updated.has(key) && String(changes[key]) !== '') {
            newLines.push(`${key}=${changes[key]}`);
            updated.add(key);
          }
        }

        const tmpPath = envPath + '.tmp';
        fs.writeFileSync(tmpPath, newLines.join('\n'));
        fs.renameSync(tmpPath, envPath);

        sendOk(res, {
          updated: [...updated],
          restartRequired: true,
          message: `Schedule saved (${updated.size} keys). Restart the bot for changes to take effect.`,
        });
      } catch (err: unknown) {
        sendError(res, API_ERRORS.FAILED_TO_SAVE_SCHEDULE, 500, safeError(err));
      }
    });

    // ══════════════════════════════════════════════════════════════════
    //  Bot Configuration API — read/write .env file (primary) or
    //  servers.json entry (non-primary / multi-server)
    // ══════════════════════════════════════════════════════════════════

    // Keys that contain credentials — values are NEVER sent to the client.
    // Write is allowed (masked placeholder is replaced only if user provides a real value).
    const ENV_SENSITIVE_KEYS = new Set([
      'DISCORD_TOKEN',
      'DISCORD_OAUTH_SECRET',
      'RCON_PASSWORD',
      'SFTP_PASSWORD',
      'SFTP_PRIVATE_KEY_PATH',
      'PANEL_API_KEY',
    ]);

    // Keys that are read-only (managed by the bot, not user-editable via web)
    const ENV_READONLY_KEYS = new Set(['ENV_SCHEMA_VERSION']);

    // ── Per-server bot config (servers.json) helpers ──────────────

    /**
     * Mapping from .env keys to servers.json nested paths.
     * Each entry: { jsonPath, sensitive?, readOnly?, label? }
     * jsonPath uses dot notation: 'rcon.host', 'channels.serverStatus', etc.
     */
    const ENV_TO_SERVERDEF: Record<
      string,
      { jsonPath: string; sensitive?: boolean; readOnly?: boolean; label?: string }
    > = {
      // Identity
      SERVER_NAME: { jsonPath: 'name' },
      PUBLIC_HOST: { jsonPath: 'publicHost' },
      GAME_PORT: { jsonPath: 'gamePort' },
      // RCON
      RCON_HOST: { jsonPath: 'rcon.host' },
      RCON_PORT: { jsonPath: 'rcon.port' },
      RCON_PASSWORD: { jsonPath: 'rcon.password', sensitive: true },
      // SFTP
      SFTP_HOST: { jsonPath: 'sftp.host' },
      SFTP_PORT: { jsonPath: 'sftp.port' },
      SFTP_USER: { jsonPath: 'sftp.user' },
      SFTP_PASSWORD: { jsonPath: 'sftp.password', sensitive: true },
      SFTP_PRIVATE_KEY_PATH: { jsonPath: 'sftp.privateKeyPath', sensitive: true },
      // Channels
      SERVER_STATUS_CHANNEL_ID: { jsonPath: 'channels.serverStatus' },
      PLAYER_STATS_CHANNEL_ID: { jsonPath: 'channels.playerStats' },
      CHAT_CHANNEL_ID: { jsonPath: 'channels.chat' },
      LOG_CHANNEL_ID: { jsonPath: 'channels.log' },
      ADMIN_CHANNEL_ID: { jsonPath: 'channels.admin' },
      // SFTP paths
      SFTP_LOG_PATH: { jsonPath: 'paths.logPath' },
      SFTP_CONNECT_LOG_PATH: { jsonPath: 'paths.connectLogPath' },
      SFTP_ID_MAP_PATH: { jsonPath: 'paths.idMapPath' },
      SFTP_SAVE_PATH: { jsonPath: 'paths.savePath' },
      SFTP_SETTINGS_PATH: { jsonPath: 'paths.settingsPath' },
      SFTP_WELCOME_PATH: { jsonPath: 'paths.welcomePath' },
      // Timezones
      BOT_TIMEZONE: { jsonPath: 'botTimezone' },
      LOG_TIMEZONE: { jsonPath: 'logTimezone' },
      // Docker / restart
      DOCKER_CONTAINER: { jsonPath: 'dockerContainer' },
      ENABLE_SERVER_SCHEDULER: { jsonPath: 'enableServerScheduler' },
      RESTART_TIMES: { jsonPath: 'restartTimes' },
      RESTART_PROFILES: { jsonPath: 'restartProfiles' },
      // PvP
      PVP_START_TIME: { jsonPath: 'pvpStartTime' },
      PVP_END_TIME: { jsonPath: 'pvpEndTime' },
      PVP_SETTINGS_OVERRIDES: { jsonPath: 'pvpSettingsOverrides' },
      // Auto messages
      ENABLE_WELCOME_MSG: { jsonPath: 'autoMessages.enableWelcomeMsg' },
      ENABLE_WELCOME_FILE: { jsonPath: 'autoMessages.enableWelcomeFile' },
      ENABLE_AUTO_MSG_LINK: { jsonPath: 'autoMessages.enableAutoMsgLink' },
      ENABLE_AUTO_MSG_PROMO: { jsonPath: 'autoMessages.enableAutoMsgPromo' },
      AUTO_MSG_LINK_TEXT: { jsonPath: 'autoMessages.linkText' },
      AUTO_MSG_PROMO_TEXT: { jsonPath: 'autoMessages.promoText' },
      DISCORD_INVITE_LINK: { jsonPath: 'autoMessages.discordLink' },
      // Panel API
      PANEL_SERVER_URL: { jsonPath: 'panel.serverUrl' },
      PANEL_API_KEY: { jsonPath: 'panel.apiKey', sensitive: true },
      // Module toggles (stored in modules.* in servers.json)
      ENABLE_SERVER_STATUS: { jsonPath: 'modules.serverStatus' },
      ENABLE_CHAT_RELAY: { jsonPath: 'modules.chatRelay' },
      ENABLE_LOG_WATCHER: { jsonPath: 'modules.logWatcher' },
      ENABLE_PLAYER_STATS: { jsonPath: 'modules.playerStats' },
      // Server enabled
      ENABLED: { jsonPath: 'enabled' },
    };

    /** Read a nested value from an object using dot-path: 'rcon.host' → obj.rcon.host */
    function _getNestedValue(obj: Record<string, unknown>, dotPath: string): unknown {
      const parts = dotPath.split('.');
      let cur: unknown = obj;
      for (const pk of parts) {
        if (cur == null || typeof cur !== 'object') return undefined;
        cur = (cur as Record<string, unknown>)[pk];
      }
      return cur;
    }

    /** Set a nested value on an object using dot-path, creating intermediary objects. */
    function _setNestedValue(obj: Record<string, unknown>, dotPath: string, value: unknown): void {
      const parts = dotPath.split('.');
      let cur: Record<string, unknown> = obj;
      for (let i = 0; i < parts.length - 1; i++) {
        const p = parts[i] as string;
        if (cur[p] == null || typeof cur[p] !== 'object') cur[p] = {};
        cur = cur[p] as Record<string, unknown>;
      }
      const lastKey = parts[parts.length - 1];
      if (lastKey !== undefined) cur[lastKey] = value;
    }

    /** Build categorized bot-config sections from a servers.json serverDef entry. */
    function _buildServerDefSections(serverDef: Record<string, unknown>): Record<string, unknown>[] {
      const categories = [
        { label: 'Server Identity', keys: ['SERVER_NAME', 'PUBLIC_HOST', 'GAME_PORT', 'ENABLED'] },
        { label: 'RCON', keys: ['RCON_HOST', 'RCON_PORT', 'RCON_PASSWORD'] },
        { label: 'SFTP', keys: ['SFTP_HOST', 'SFTP_PORT', 'SFTP_USER', 'SFTP_PASSWORD', 'SFTP_PRIVATE_KEY_PATH'] },
        {
          label: 'Channel IDs',
          keys: [
            'SERVER_STATUS_CHANNEL_ID',
            'PLAYER_STATS_CHANNEL_ID',
            'CHAT_CHANNEL_ID',
            'LOG_CHANNEL_ID',
            'ADMIN_CHANNEL_ID',
          ],
        },
        {
          label: 'SFTP File Paths',
          keys: [
            'SFTP_LOG_PATH',
            'SFTP_CONNECT_LOG_PATH',
            'SFTP_ID_MAP_PATH',
            'SFTP_SAVE_PATH',
            'SFTP_SETTINGS_PATH',
            'SFTP_WELCOME_PATH',
          ],
        },
        { label: 'Timezones', keys: ['BOT_TIMEZONE', 'LOG_TIMEZONE'] },
        {
          label: 'Server Scheduler',
          keys: ['ENABLE_SERVER_SCHEDULER', 'RESTART_TIMES', 'RESTART_PROFILES', 'DOCKER_CONTAINER'],
        },
        { label: 'PvP Scheduler', keys: ['PVP_START_TIME', 'PVP_END_TIME', 'PVP_SETTINGS_OVERRIDES'] },
        {
          label: 'Auto Messages',
          keys: [
            'ENABLE_WELCOME_MSG',
            'ENABLE_WELCOME_FILE',
            'ENABLE_AUTO_MSG_LINK',
            'ENABLE_AUTO_MSG_PROMO',
            'AUTO_MSG_LINK_TEXT',
            'AUTO_MSG_PROMO_TEXT',
            'DISCORD_INVITE_LINK',
          ],
        },
        {
          label: 'Module Toggles',
          keys: ['ENABLE_SERVER_STATUS', 'ENABLE_CHAT_RELAY', 'ENABLE_LOG_WATCHER', 'ENABLE_PLAYER_STATS'],
        },
        { label: 'Panel API', keys: ['PANEL_SERVER_URL', 'PANEL_API_KEY'] },
      ];

      const sections = [];
      for (const cat of categories as { label: string; keys: string[] }[]) {
        const keys: Record<string, unknown>[] = [];
        for (const envKey of cat.keys) {
          const mapping = ENV_TO_SERVERDEF[envKey];
          if (!mapping) continue;
          const raw = _getNestedValue(serverDef, mapping.jsonPath);
          const value =
            raw != null
              ? typeof raw === 'object'
                ? JSON.stringify(raw)
                : String(raw as string | number | boolean)
              : '';
          const isSensitive = Boolean(mapping.sensitive) || ENV_SENSITIVE_KEYS.has(envKey);
          keys.push({
            key: envKey,
            value: isSensitive ? '' : value,
            sensitive: isSensitive,
            readOnly: false,
            hasValue: isSensitive ? value.length > 0 : undefined,
            commented: !value && !isSensitive, // show as "not set" if empty
          });
        }
        if (keys.length) sections.push({ label: cat.label, keys });
      }
      return sections;
    }

    /** Find a server definition by id. DB-first, fallback to servers.json. */
    function _getServerDef(serverId: string): Record<string, unknown> | null {
      // DB-backed: read from config_documents
      if (configRepo) {
        try {
          const data = configRepo.get(`server:${serverId}`);
          if (data) return { data, source: 'database' };
        } catch (err: unknown) {
          console.warn('[WEB MAP] DB read failed for server, falling back to servers.json:', serverId, errMsg(err));
        }
      }
      // Legacy fallback: read from servers.json
      try {
        if (!fs.existsSync(SERVERS_FILE)) return null;
        const servers = JSON.parse(fs.readFileSync(SERVERS_FILE, 'utf8')) as Array<Record<string, unknown>>;
        const found = servers.find((s: Record<string, unknown>) => s.id === serverId) ?? null;
        return found ? { data: found, source: 'servers.json' } : null;
      } catch {
        return null;
      }
    }

    /** Write an updated server definition. DB-first, fallback to servers.json. */
    function _saveServerDef(serverId: string, updater: (def: Record<string, unknown>) => void): boolean {
      // DB-backed: read-update-write via configRepo
      if (configRepo) {
        try {
          const scope = `server:${serverId}`;
          const data = configRepo.get(scope);
          if (!data) return false;
          updater(data);
          configRepo.set(scope, data);
          return true;
        } catch (err: unknown) {
          console.error('[WEB MAP] Failed to save server def to DB:', serverId, errMsg(err));
          return false;
        }
      }
      // Legacy fallback: read/write servers.json
      if (!fs.existsSync(SERVERS_FILE)) return false;
      const servers = JSON.parse(fs.readFileSync(SERVERS_FILE, 'utf8')) as Array<Record<string, unknown>>;
      const idx = servers.findIndex((s: Record<string, unknown>) => s.id === serverId);
      if (idx < 0) return false;
      updater(servers[idx] as Record<string, unknown>);
      const tmpPath = SERVERS_FILE + '.tmp';
      fs.writeFileSync(tmpPath, JSON.stringify(servers, null, 2));
      fs.renameSync(tmpPath, SERVERS_FILE);
      return true;
    }

    /** Parse a .env file into structured entries preserving comments and order */
    function parseEnvFile(content: string): (EnvEntry | { type: string; raw?: string })[] {
      const entries = [];
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        const trimmed = (raw ?? '').trim();

        // Blank line
        if (!trimmed) {
          entries.push({ type: 'blank', raw });
          continue;
        }

        // Section header comment (e.g. "# ── Discord Bot ──")
        if (/^#\s*[─═]/.test(trimmed)) {
          entries.push({
            type: 'section',
            raw,
            label: trimmed
              .replace(/^#\s*[─═]+\s*/, '')
              .replace(/\s*[─═]+\s*$/, '')
              .trim(),
          });
          continue;
        }

        // Regular comment
        if (trimmed.startsWith('#')) {
          // Check if it's a commented-out key (e.g. #KEY=value)
          const commentedMatch = trimmed.match(/^#\s*([A-Z][A-Z0-9_]*)=(.*)/);
          if (commentedMatch) {
            entries.push({ type: 'commented', raw, key: commentedMatch[1], value: commentedMatch[2] });
          } else {
            entries.push({ type: 'comment', raw });
          }
          continue;
        }

        // Key=value line
        const eq = trimmed.indexOf('=');
        if (eq > 0) {
          const key = trimmed.substring(0, eq).trim();
          const value = trimmed.substring(eq + 1).trim();
          entries.push({ type: 'keyval', raw, key, value });
        } else {
          entries.push({ type: 'other', raw });
        }
      }
      return entries;
    }

    /** GET /api/panel/bot-config — read from DB (primary uses ENV_CATEGORIES, non-primary uses serverDef) */
    app.get('/api/panel/bot-config', requireTier('admin'), rateLimit(10000, 10), (req, res) => {
      try {
        // ── Non-primary: read from config_documents / servers.json ──
        if (!req.srv.isPrimary) {
          const result = _getServerDef(req.srv.serverId);
          if (!result) {
            sendError(res, API_ERRORS.SERVER_NOT_FOUND_IN_SERVERS_JSON, 404);
            return;
          }
          const sections = _buildServerDefSections(result.data as Record<string, unknown>);
          return res.json({ sections, groups: ENV_CATEGORY_GROUPS, source: result.source });
        }

        // ── Primary: read from config singleton + DB documents ──
        if (configRepo) {
          const appData = configRepo.get('app') || {};
          const serverData = configRepo.get('server:primary') || {};

          const sections: Record<string, unknown>[] = [];
          for (const cat of ENV_CATEGORIES) {
            const keys: Record<string, unknown>[] = [];
            for (const field of cat.fields) {
              const isSensitive =
                ('sensitive' in field && Boolean(field.sensitive)) || ENV_SENSITIVE_KEYS.has(field.env);
              const isReadOnly = ENV_READONLY_KEYS.has(field.env);

              // Resolve value: cfg-keyed → config singleton; env-keyed → DB document
              let rawValue;
              if (field.cfg) {
                rawValue = (config as unknown as Record<string, unknown>)[field.cfg];
              } else {
                // Fields without cfg are stored under their env key in DB
                const doc = SERVER_SCOPED_KEYS.has(field.env) ? serverData : appData;
                rawValue = doc[field.env];
              }
              const value =
                rawValue != null
                  ? typeof rawValue === 'object'
                    ? JSON.stringify(rawValue)
                    : String(rawValue as string | number | boolean)
                  : '';

              keys.push({
                key: field.env,
                value: isSensitive ? '' : value,
                sensitive: isSensitive,
                readOnly: isReadOnly,
                hasValue: isSensitive ? value.length > 0 && !value.startsWith('your_') : undefined,
                commented: !value && !isSensitive,
              });
            }
            if (keys.length) sections.push({ id: cat.id, label: cat.label, keys });
          }

          return res.json({ sections, groups: ENV_CATEGORY_GROUPS, source: 'database' });
        }

        // ── Legacy fallback: read from .env ──
        const envPath = path.join(__dirname, '..', '..', '.env');
        if (!fs.existsSync(envPath)) {
          sendError(res, API_ERRORS.ENV_FILE_NOT_FOUND, 404);
          return;
        }

        const content = fs.readFileSync(envPath, 'utf8');
        const entries = parseEnvFile(content);

        // Build categorized output
        const sections: Record<string, unknown>[] = [];
        let currentSection: { label: string | undefined; keys: Record<string, unknown>[] } = {
          label: 'General',
          keys: [],
        };

        for (const entry of entries) {
          if (entry.type === 'section') {
            // Start a new section if current has keys
            if (currentSection.keys.length > 0) sections.push(currentSection);
            currentSection = { label: (entry as EnvEntry).label, keys: [] };
            continue;
          }
          if (entry.type === 'keyval') {
            const entryKey = (entry as EnvEntry).key as string;
            const entryValue = (entry as EnvEntry).value as string;
            const isSensitive = ENV_SENSITIVE_KEYS.has(entryKey);
            const isReadOnly = ENV_READONLY_KEYS.has(entryKey);
            currentSection.keys.push({
              key: entryKey,
              value: isSensitive ? '' : entryValue,
              sensitive: isSensitive,
              readOnly: isReadOnly,
              hasValue: isSensitive ? entryValue.length > 0 && !entryValue.startsWith('your_') : undefined,
              commented: false,
            });
          } else if (entry.type === 'commented') {
            const entryKey = (entry as EnvEntry).key as string;
            const entryValue = (entry as EnvEntry).value as string;
            const isSensitive = ENV_SENSITIVE_KEYS.has(entryKey);
            currentSection.keys.push({
              key: entryKey,
              value: isSensitive ? '' : entryValue,
              sensitive: isSensitive,
              readOnly: false,
              hasValue: false,
              commented: true,
            });
          }
        }
        if (currentSection.keys.length > 0) sections.push(currentSection);

        res.json({ sections, groups: ENV_CATEGORY_GROUPS });
      } catch (err: unknown) {
        sendError(res, API_ERRORS.FAILED_TO_READ_BOT_CONFIG, 500, safeError(err));
      }
    });

    /** POST /api/panel/bot-config — update config in DB (primary) or serverDef (non-primary) */
    app.post('/api/panel/bot-config', requireTier('admin'), rateLimit(30000, 3), (req, res) => {
      const { changes } = req.body as { changes?: Record<string, unknown> };
      if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
        sendError(res, API_ERRORS.MISSING_CHANGES_OBJECT, 400);
        return;
      }

      // Block read-only keys
      const blocked = Object.keys(changes).filter((k) => ENV_READONLY_KEYS.has(k));
      if (blocked.length > 0) {
        sendError(res, API_ERRORS.CANNOT_MODIFY_READ_ONLY_KEYS, 403, blocked.join(', '));
        return;
      }

      // Validate values — no newlines, reasonable length
      for (const [key, value] of Object.entries(changes)) {
        const v = String(value);
        if (/[\r\n]/.test(v)) {
          sendError(res, API_ERRORS.INVALID_VALUE_CONTAINS_NEWLINE, 400, key);
          return;
        }
        if (v.length > 2000) {
          sendError(res, API_ERRORS.VALUE_TOO_LONG, 400, key);
          return;
        }
      }

      // ── Non-primary: write to serverDef via DB / servers.json ──
      if (!req.srv.isPrimary) {
        try {
          const serverId = req.srv.serverId;
          const updated = new Set();
          const ok = _saveServerDef(serverId, (serverDef) => {
            for (const [envKey, value] of Object.entries(changes)) {
              const mapping = ENV_TO_SERVERDEF[envKey];
              if (!mapping) continue; // ignore keys not in the mapping
              const val = String(value);
              // Convert booleans for boolean-like fields
              let coerced: string | boolean | number = val;
              if (val === 'true') coerced = true;
              else if (val === 'false') coerced = false;
              else if (
                /^\d+$/.test(val) &&
                !envKey.includes('ID') &&
                !envKey.includes('PATH') &&
                !envKey.includes('NAME') &&
                !envKey.includes('TEXT') &&
                !envKey.includes('HOST') &&
                !envKey.includes('USER') &&
                !envKey.includes('PASSWORD') &&
                !envKey.includes('KEY') &&
                !envKey.includes('LINK') &&
                !envKey.includes('URL') &&
                !envKey.includes('CONTAINER') &&
                !envKey.includes('TIMEZONE') &&
                !envKey.includes('OVERRIDES') &&
                !envKey.includes('PROFILES') &&
                !envKey.includes('TIMES')
              ) {
                coerced = parseInt(val, 10);
              }
              // Empty string → remove the key (so it falls through to primary defaults via prototype)
              if (val === '') {
                // Delete the nested key
                const parts = mapping.jsonPath.split('.');
                let cur: Record<string, unknown> = serverDef;
                for (let i = 0; i < parts.length - 1; i++) {
                  if (cur[parts[i] as string] == null) break;
                  cur = cur[parts[i] as string] as Record<string, unknown>;
                }
                if (typeof cur === 'object') {
                  const lastPart = parts[parts.length - 1];
                  if (lastPart !== undefined) {
                    Reflect.deleteProperty(cur, lastPart);
                  }
                }
              } else {
                _setNestedValue(serverDef, mapping.jsonPath, coerced);
              }
              updated.add(envKey);
            }
          });

          if (!ok) {
            sendError(res, API_ERRORS.SERVER_NOT_FOUND_IN_SERVERS_JSON, 404);
            return;
          }

          sendOk(res, {
            updated: [...updated],
            restartRequired: true,
            message: `Updated ${updated.size} setting${updated.size !== 1 ? 's' : ''}. Restart the bot for changes to take effect.`,
          });
          return;
        } catch (err: unknown) {
          sendError(res, API_ERRORS.FAILED_TO_SAVE_SERVER_CONFIG, 500, safeError(err));
          return;
        }
      }

      // ── Primary: write to DB via configRepo ──
      if (configRepo) {
        try {
          const migrationMap = buildMigrationMap();
          // Build envKey → restart lookup from ENV_CATEGORIES
          const restartByEnvKey = new Map();
          for (const cat of ENV_CATEGORIES) {
            for (const f of (cat as { fields: { env: string }[]; restart?: boolean }).fields)
              restartByEnvKey.set(f.env, (cat as { restart?: boolean }).restart);
          }
          const appPatch: Record<string, unknown> = {};
          const serverPatch: Record<string, unknown> = {};
          const updated = new Set();

          for (const [envKey, rawValue] of Object.entries(changes)) {
            // Skip bootstrap keys — they live in .env and can't be changed via web panel
            if (BOOTSTRAP_KEYS.has(envKey)) continue;

            const mapping = migrationMap[envKey];
            const val = String(rawValue);
            const targetKey = mapping?.cfgKey || envKey;
            const type = mapping?.type || 'string';
            const coerced = _coerce(val, type);
            const scope = mapping?.scope || (SERVER_SCOPED_KEYS.has(envKey) ? 'server:primary' : 'app');

            if (scope === 'server:primary') {
              serverPatch[targetKey] = coerced;
            } else {
              appPatch[targetKey] = coerced;
            }

            // Only live-apply to config singleton if the field's category does NOT require restart
            if (mapping?.cfgKey && !restartByEnvKey.get(envKey)) {
              (config as unknown as Record<string, unknown>)[mapping.cfgKey] = coerced;
            }

            updated.add(envKey);
          }

          if (Object.keys(appPatch).length > 0) configRepo.update('app', appPatch);
          if (Object.keys(serverPatch).length > 0) configRepo.update('server:primary', serverPatch);

          sendOk(res, {
            updated: [...updated],
            restartRequired: true,
            message: `Updated ${updated.size} setting${updated.size !== 1 ? 's' : ''}. Restart the bot for changes to take effect.`,
          });
          return;
        } catch (err: unknown) {
          sendError(res, API_ERRORS.FAILED_TO_SAVE_BOT_CONFIG, 500, safeError(err));
          return;
        }
      }

      // ── Legacy fallback: write to .env ──
      try {
        const envPath = path.join(__dirname, '..', '..', '.env');
        if (!fs.existsSync(envPath)) {
          sendError(res, API_ERRORS.ENV_FILE_NOT_FOUND, 404);
          return;
        }

        const content = fs.readFileSync(envPath, 'utf8');
        const lines = content.split('\n');
        const updated = new Set();

        const newLines = lines.map((line: string) => {
          const trimmed = line.trim();

          // Active key=value line
          const eq = trimmed.indexOf('=');
          if (eq > 0 && !trimmed.startsWith('#') && !trimmed.startsWith(';')) {
            const key = trimmed.substring(0, eq).trim();
            if (key in changes) {
              updated.add(key);
              return `${key}=${String(changes[key])}`;
            }
          }

          // Commented-out key — uncomment it if user is setting a value
          if (trimmed.startsWith('#')) {
            const commentedMatch = trimmed.match(/^#\s*([A-Z][A-Z0-9_]*)=(.*)/);
            if (commentedMatch?.[1] && commentedMatch[1] in changes) {
              const key = commentedMatch[1];
              updated.add(key);
              const val = String(changes[key]);
              // If setting to empty, re-comment it
              if (val === '') return `#${key}=`;
              return `${key}=${val}`;
            }
          }

          return line;
        });

        // Any keys not found in the file — append them at the end
        for (const key of Object.keys(changes)) {
          if (!updated.has(key) && String(changes[key]) !== '') {
            newLines.push(`${key}=${String(changes[key])}`);
            updated.add(key);
          }
        }

        // Write atomically — write to temp then rename
        const tmpPath = envPath + '.tmp';
        fs.writeFileSync(tmpPath, newLines.join('\n'));
        fs.renameSync(tmpPath, envPath);

        sendOk(res, {
          updated: [...updated],
          restartRequired: true,
          message: `Updated ${updated.size} setting${updated.size !== 1 ? 's' : ''}. Restart the bot for changes to take effect.`,
        });
      } catch (err: unknown) {
        sendError(res, API_ERRORS.FAILED_TO_SAVE_BOT_CONFIG, 500, safeError(err));
      }
    });

    // ══════════════════════════════════════════════════════════════════
    //  Welcome File Editor
    // ══════════════════════════════════════════════════════════════════

    /** GET /api/panel/welcome-file — read current welcome file from SFTP (fallback to config) */
    app.get('/api/panel/welcome-file', requireTier('admin'), rateLimit(10000, 10), async (req, res) => {
      const placeholders = [
        '{server_name}',
        '{day}',
        '{season}',
        '{weather}',
        '{pvp_schedule}',
        '{discord_link}',
        '{discord}',
      ];
      try {
        // Try reading the actual file from the game server via SFTP
        const welcomePath = req.srv.config.sftpWelcomePath;
        if (welcomePath) {
          const SftpClient = (await import('ssh2-sftp-client')).default;
          const sftp = new SftpClient();
          try {
            await sftp.connect(req.srv.config.sftpConnectConfig());
            const buf = (await sftp.get(welcomePath)) as Buffer;
            const content = buf.toString('utf8');
            sendOk(res, { content, placeholders, source: 'sftp' });
            return;
          } catch (sftpErr: unknown) {
            console.warn('[WelcomeFile] SFTP read failed, falling back to config:', errMsg(sftpErr));
          } finally {
            await sftp.end().catch(() => {});
          }
        }

        // Fallback: read from config (pipe-separated lines → newline-separated)
        const lines = (req.srv.config.welcomeFileLines as string[] | undefined) ?? [];
        const content = Array.isArray(lines) ? lines.join('\n') : String(lines);
        sendOk(res, { content, placeholders, source: content ? 'config' : 'empty' });
        return;
      } catch (err: unknown) {
        sendError(res, 'WELCOME_FILE_READ_FAILED', 500, safeError(err));
        return;
      }
    });

    /** POST /api/panel/welcome-file — save welcome file content + trigger SFTP upload */
    app.post('/api/panel/welcome-file', requireTier('admin'), rateLimit(30000, 3), async (req, res) => {
      try {
        const { content } = req.body as { content?: unknown };
        if (typeof content !== 'string') {
          sendError(res, 'INVALID_CONTENT', 400);
          return;
        }
        if (content.length > 10000) {
          sendError(res, 'CONTENT_TOO_LARGE', 400);
          return;
        }

        // Convert newlines to pipe-separated array
        const lines = content.split('\n');

        // Save to config
        const config = req.srv.config;
        config.welcomeFileLines = lines;

        if (configRepo) {
          configRepo.update('app', { welcomeFileLines: lines });
        } else {
          // Legacy .env fallback
          const envPath = path.join(__dirname, '..', '..', '.env');
          if (fs.existsSync(envPath)) {
            const envContent = fs.readFileSync(envPath, 'utf8');
            const envLines = envContent.split('\n');
            const pipeValue = lines.join('|');
            const hasKey = envLines.some((l: string) => l.startsWith('WELCOME_FILE_LINES='));
            const newEnvLines = envLines.map((l: string) => {
              if (l.startsWith('WELCOME_FILE_LINES=')) {
                return `WELCOME_FILE_LINES=${pipeValue}`;
              }
              return l;
            });
            if (!hasKey) newEnvLines.push(`WELCOME_FILE_LINES=${pipeValue}`);
            fs.writeFileSync(envPath, newEnvLines.join('\n'));
          }
        }

        // Upload directly via SFTP
        const welcomePath = config.sftpWelcomePath;
        if (welcomePath) {
          try {
            const SftpClient = (await import('ssh2-sftp-client')).default;
            const sftp = new SftpClient();
            await sftp.connect(config.sftpConnectConfig());
            await sftp.put(Buffer.from(content, 'utf8'), welcomePath);
            await sftp.end().catch(() => {});
            console.log('[WelcomeFile] Uploaded WelcomeMessage.txt via panel editor');
          } catch (sftpErr: unknown) {
            console.error('[WelcomeFile] SFTP upload failed:', errMsg(sftpErr));
            sendOk(res, {
              message: 'Welcome file saved to config but SFTP upload failed: ' + errMsg(sftpErr),
              lineCount: lines.length,
              uploaded: false,
            });
            return;
          }
        }
        sendOk(res, {
          message: welcomePath
            ? 'Welcome file saved and uploaded'
            : 'Welcome file saved to config (no SFTP path configured)',
          lineCount: lines.length,
          uploaded: !!welcomePath,
        });
        return;
      } catch (err: unknown) {
        sendError(res, 'WELCOME_FILE_SAVE_FAILED', 500, safeError(err));
        return;
      }
    });

    // ══════════════════════════════════════════════════════════════════
    //  Anticheat API — flag browser, risk scores, review
    // ══════════════════════════════════════════════════════════════════

    /** GET /api/panel/anticheat/flags — list flags with optional filters */
    app.get('/api/panel/anticheat/flags', requireTier('admin'), rateLimit(10000, 15), (req, res) => {
      const srv = req.srv;
      if (!srv.db) return res.json([]);
      try {
        const { status, severity, steam_id, detector, limit } = req.query;
        const maxRows = Math.min(parseInt(limit as string, 10) || 100, 500);
        let flags;

        if (steam_id) {
          flags = srv.db.getAcFlagsBySteam(steam_id as string, maxRows);
        } else if (detector) {
          flags = srv.db.getAcFlagsByDetector(detector as string, (status || 'open') as string, maxRows);
        } else if (status) {
          flags = srv.db.getAcFlags(status as string, maxRows);
        } else {
          flags = srv.db.getAcFlags('open', maxRows);
        }

        // Apply severity filter client-side if both status and severity are set
        if (severity) {
          flags = (flags as Record<string, unknown>[]).filter((f) => f.severity === severity);
        }

        // Resolve player names from players table
        const nameMap: Record<string, string> = {};
        try {
          const rows = (srv.db.db?.prepare('SELECT steam_id, name FROM players').all() ?? []) as {
            steam_id: string;
            name: string;
          }[];
          for (const r of rows) nameMap[r.steam_id] = r.name;
        } catch {
          /* */
        }

        flags = (flags as Record<string, unknown>[]).map((f) => ({
          ...f,
          player_name: (f.player_name as string | undefined) || nameMap[f.steam_id as string] || f.steam_id,
        }));

        res.json(flags);
      } catch (err: unknown) {
        sendError(res, API_ERRORS.INTERNAL_SERVER_ERROR, 500, safeError(err));
      }
    });

    /** GET /api/panel/anticheat/risk-scores — all player risk scores */
    app.get('/api/panel/anticheat/risk-scores', requireTier('admin'), rateLimit(10000, 10), (req, res) => {
      if (!req.srv.db) return res.json([]);
      try {
        const scores = req.srv.db.getAllRiskScores();
        res.json(scores);
      } catch (err: unknown) {
        sendError(res, API_ERRORS.INTERNAL_SERVER_ERROR, 500, safeError(err));
      }
    });

    /** POST /api/panel/anticheat/flags/:id/review — confirm, dismiss, or whitelist a flag */
    app.post('/api/panel/anticheat/flags/:id/review', requireTier('admin'), rateLimit(10000, 10), (req, res) => {
      if (!req.srv.db) {
        sendError(res, API_ERRORS.DATABASE_NOT_AVAILABLE, 500);
        return;
      }
      try {
        const flagId = parseInt(req.params.id as string, 10);
        if (isNaN(flagId)) {
          sendError(res, API_ERRORS.INVALID_FLAG_ID, 400);
          return;
        }

        const { status, notes } = req.body as { status?: string; notes?: string };
        if (!status || !['confirmed', 'dismissed', 'whitelisted'].includes(status)) {
          sendError(res, API_ERRORS.INVALID_STATUS, 400);
          return;
        }

        // Get reviewer identity from session
        const reviewedBy = req.session.username || req.session.discordId || 'admin';

        req.srv.db.updateAcFlagStatus(flagId, status, reviewedBy, notes ?? '');
        res.json({ ok: true, flagId, status });
      } catch (err: unknown) {
        sendError(res, API_ERRORS.INTERNAL_SERVER_ERROR, 500, safeError(err));
      }
    });

    /** GET /api/panel/anticheat/stats — summary counts for dashboard */
    app.get('/api/panel/anticheat/stats', requireTier('admin'), rateLimit(10000, 10), (req, res) => {
      if (!req.srv.db) return res.json({ open: 0, confirmed: 0, dismissed: 0, total: 0 });
      try {
        const srv = req.srv;
        const countByStatus = (s: string | null) => {
          try {
            if (!srv.db?.db) return 0;
            if (s)
              return (
                srv.db.db.prepare('SELECT COUNT(*) as count FROM anticheat_flags WHERE status = ?').get(s) as Record<
                  string,
                  unknown
                >
              ).count;
            return (srv.db.db.prepare('SELECT COUNT(*) as count FROM anticheat_flags').get() as Record<string, unknown>)
              .count;
          } catch {
            return 0;
          }
        };
        const open = countByStatus('open');
        const confirmed = countByStatus('confirmed');
        const dismissed = countByStatus('dismissed');
        const total = countByStatus(null);
        res.json({ open, confirmed, dismissed, total });
      } catch (err: unknown) {
        sendError(res, API_ERRORS.INTERNAL_SERVER_ERROR, 500, safeError(err));
      }
    });

    // ══════════════════════════════════════════════════════════════════
    //  Multi-Server Management API — fleet-wide CRUD, lifecycle, discovery
    // ══════════════════════════════════════════════════════════════════

    /** Mask sensitive fields in a server definition for API responses. */
    function _maskServerDef(def: Record<string, unknown>): Record<string, unknown> {
      const masked = JSON.parse(JSON.stringify(def)) as Record<string, Record<string, unknown>>;
      if (masked.rcon?.password != null) masked.rcon.password = { hasValue: !!masked.rcon.password };
      if (masked.sftp?.password != null) masked.sftp.password = { hasValue: !!masked.sftp.password };
      if (masked.sftp?.privateKeyPath != null) masked.sftp.privateKeyPath = { hasValue: !!masked.sftp.privateKeyPath };
      if (masked.panel?.apiKey != null) masked.panel.apiKey = { hasValue: !!masked.panel.apiKey };
      return masked as unknown as Record<string, unknown>;
    }

    /** Test RCON auth via raw Source RCON protocol. Resolves { ok, error? }. */
    async function _testRconAuth(
      host: string,
      port: number | string,
      password: string,
      timeout = 10000,
    ): Promise<{ ok: boolean; error?: string }> {
      // Validate host: must be hostname or IP, no URL schemes/paths/spaces
      if (typeof host !== 'string' || !/^[\w.:-]+$/.test(host) || host.includes('://')) {
        return Promise.resolve({ ok: false, error: 'Invalid host format' });
      }
      const numPort = Number(port);
      if (!Number.isInteger(numPort) || numPort < 1 || numPort > 65535) {
        return Promise.resolve({ ok: false, error: 'Invalid port (must be 1-65535)' });
      }
      console.log('[WebMap] RCON test: %s:%d by admin', host, numPort);
      const net = await import('net');
      return new Promise((resolve) => {
        const socket = new net.Socket();
        let resolved = false;
        let buf = Buffer.alloc(0);
        const done = (result: { ok: boolean; error?: string }) => {
          if (resolved) return;
          resolved = true;
          clearTimeout(timer);
          try {
            socket.destroy();
          } catch (cleanupErr: unknown) {
            console.warn('[WebMap] RCON test socket cleanup error:', errMsg(cleanupErr));
          }
          resolve(result);
        };
        const timer = setTimeout(() => {
          done({ ok: false, error: 'Connection timed out' });
        }, timeout);
        socket.connect(port as number, host, () => {
          const passLen = Buffer.byteLength(password, 'utf8');
          const bodyLen = 4 + 4 + passLen + 1 + 1;
          const pkt = Buffer.alloc(4 + bodyLen);
          pkt.writeInt32LE(bodyLen, 0);
          pkt.writeInt32LE(1, 4);
          pkt.writeInt32LE(3, 8); // SERVERDATA_AUTH
          pkt.write(password, 12, 'utf8');
          socket.write(pkt);
        });
        socket.on('data', (chunk: Buffer) => {
          buf = Buffer.concat([buf, chunk]);
          while (buf.length >= 12) {
            const pktSize = buf.readInt32LE(0);
            if (pktSize < 10 || pktSize > 4096) {
              done({ ok: false, error: 'Invalid RCON response' });
              return;
            }
            if (buf.length < 4 + pktSize) break;
            const id = buf.readInt32LE(4);
            const type = buf.readInt32LE(8);
            buf = buf.subarray(4 + pktSize);
            if (type === 2) {
              done(id === -1 ? { ok: false, error: 'Authentication failed' } : { ok: true });
              return;
            }
          }
        });
        socket.on('error', (err: NodeJS.ErrnoException | null) => {
          done({ ok: false, error: errMsg(err) });
        });
        socket.setTimeout(timeout);
        socket.on('timeout', () => {
          done({ ok: false, error: 'Connection timed out' });
        });
      });
    }

    /** Test SFTP auth + directory listing. Resolves { ok, error? }. */
    async function _testSftpAuth(
      sftpCfg: Record<string, unknown>,
      timeout = 10000,
    ): Promise<{ ok: boolean; error?: string }> {
      const SftpClient = (await import('ssh2-sftp-client')).default;
      const client = new SftpClient();
      try {
        const opts: Record<string, unknown> = {
          host: sftpCfg.host,
          port: sftpCfg.port || 22,
          username: sftpCfg.user,
          readyTimeout: timeout,
        };
        if (sftpCfg.password) opts.password = sftpCfg.password;
        if (sftpCfg.privateKeyPath) {
          try {
            opts.privateKey = readPrivateKey(sftpCfg.privateKeyPath as string);
          } catch (keyErr: unknown) {
            return { ok: false, error: 'Cannot read private key: ' + errMsg(keyErr) };
          }
        }
        await client.connect(opts as Parameters<typeof client.connect>[0]);
        await client.list('/');
        return { ok: true };
      } catch (err: unknown) {
        return { ok: false, error: (errMsg(err) || 'Connection failed').substring(0, 200) };
      } finally {
        try {
          await client.end();
        } catch (endErr: unknown) {
          console.warn('[WebMap] SFTP test client cleanup error:', errMsg(endErr));
        }
      }
    }

    /** GET /api/panel/servers — List all servers with status */
    app.get('/api/panel/servers', requireTier('admin'), rateLimit(10000, 10), (_req, res) => {
      try {
        const servers = [];

        // ── Primary server ──
        const primaryInfo = {
          id: 'primary',
          name: config.serverName || 'Primary Server',
          isPrimary: true,
          enabled: true,
          status: rcon.connected ? 'running' : 'offline',
          players: { current: 0, max: null },
          rcon: { host: config.rconHost || null, port: config.rconPort || null, connected: rcon.connected },
          sftp: { host: config.sftpHost || null, configured: !!(config.sftpHost && config.sftpUser) },
          lastSync: (() => {
            const ss = this._saveService;
            if (!ss) return null;
            const t =
              (ss as unknown as Record<string, unknown>)._lastMtime ||
              (ss as unknown as Record<string, unknown>)._lastCacheMtime;
            return t
              ? new Date(t as number).toISOString()
              : ((ss as unknown as Record<string, unknown>)._syncCount as number) > 0
                ? new Date().toISOString()
                : null;
          })(),
          modules: [],
        };
        const primaryStatusCache = this._getCached('status', 'primary', 30000) as Record<string, unknown> | null;
        if (primaryStatusCache) {
          primaryInfo.status = (primaryStatusCache.serverState as string) || 'unknown';
          primaryInfo.players.current = (primaryStatusCache.onlineCount as number) || 0;
          (primaryInfo as Record<string, unknown>).players = {
            ...((primaryInfo as Record<string, unknown>).players as Record<string, unknown>),
            max: (primaryStatusCache.maxPlayers as number) || null,
          };
        }
        const primaryMods: string[] = [];
        if (rcon.connected) primaryMods.push('rcon');
        if (this._db) primaryMods.push('db');
        if (this._saveService) primaryMods.push('sftp');
        if (
          this._scheduler &&
          ((this._scheduler as unknown as Record<string, unknown>).isActive as (() => boolean) | undefined)?.() === true
        )
          primaryMods.push('schedule');
        (primaryInfo as Record<string, unknown>).modules = primaryMods;
        servers.push(primaryInfo);

        // ── Managed servers ──
        const managed = this._loadServerList();
        const statuses: Record<string, unknown>[] = (this._multiServerManager?.getStatuses() || []) as Record<
          string,
          unknown
        >[];
        const statusMap = new Map(statuses.map((s) => [s.id as string, s]));

        for (const def of managed) {
          const st = statusMap.get(def.id);
          const inst = this._multiServerManager?.getInstance(def.id);
          const info: Record<string, unknown> = {
            id: def.id,
            name: def.name || def.id,
            isPrimary: false,
            enabled: def.enabled !== false,
            status: st?.running ? 'running' : 'stopped',
            players: { current: 0, max: null },
            rcon: {
              host: (def.rcon as Record<string, unknown> | undefined)?.host || null,
              port: (def.rcon as Record<string, unknown> | undefined)?.port || null,
              connected: !!(inst?.rcon && inst.rcon.connected),
            },
            sftp: {
              host: (def.sftp as Record<string, unknown> | undefined)?.host || null,
              configured: !!(
                (def.sftp as Record<string, unknown> | undefined)?.host &&
                (def.sftp as Record<string, unknown> | undefined)?.user
              ),
            },
            lastSync: null,
            modules: [] as string[],
          };
          const srvCache = this._getCached('status', def.id, 30000) as Record<string, unknown> | null;
          if (srvCache) {
            if (srvCache.serverState === 'running') info.status = 'running';
            (info.players as Record<string, unknown>).current = srvCache.onlineCount || 0;
            (info.players as Record<string, unknown>).max = srvCache.maxPlayers || null;
          }
          const mods: string[] = [];
          if (inst?.rcon && inst.rcon.connected) mods.push('rcon');
          if (inst?.db) mods.push('db');
          if (inst?.saveService || inst?.hasSftp) mods.push('sftp');
          if (
            (() => {
              try {
                const sc = (
                  inst as unknown as Record<string, Record<string, Record<string, (() => boolean) | undefined>>>
                )._modules?.serverScheduler;
                return sc?.isActive?.();
              } catch {
                return false;
              }
            })()
          )
            mods.push('schedule');
          if (inst?._modules && inst._modules.logWatcher) mods.push('logs');
          if (inst?._modules && inst._modules.chatRelay) mods.push('chat');
          info.modules = mods;
          servers.push(info);
        }

        sendOk(res, { servers });
      } catch (err: unknown) {
        sendError(res, API_ERRORS.INTERNAL_SERVER_ERROR, 500, safeError(err));
      }
    });

    /** POST /api/panel/servers — Create a new managed server */
    app.post('/api/panel/servers', requireTier('admin'), rateLimit(10000, 5), async (req, res) => {
      try {
        const {
          name,
          rcon: rconCfg,
          sftp,
          channels,
          enabled,
          startImmediately,
        } = req.body as {
          name?: string;
          rcon?: { host: string; port: number; password: string };
          sftp?: { host?: string; port?: number; user?: string; password?: string; privateKeyPath?: string };
          channels?: unknown;
          enabled?: boolean;
          startImmediately?: boolean;
        };
        if (!name || typeof name !== 'string' || !name.trim()) {
          sendError(res, API_ERRORS.MISSING_SERVER_NAME, 400);
          return;
        }
        if (!rconCfg || !rconCfg.host || !rconCfg.port || !rconCfg.password) {
          sendError(res, API_ERRORS.MISSING_RCON_CONFIG, 400);
          return;
        }

        // Check name uniqueness
        const existing = this._loadServerList();
        if (existing.some((s: { name?: string }) => s.name === name.trim())) {
          sendError(res, API_ERRORS.SERVER_NAME_EXISTS, 409);
          return;
        }

        const id = 'srv_' + Date.now().toString(36);
        const serverDef: Record<string, unknown> = {
          id,
          name: name.trim(),
          enabled: enabled !== false,
          rcon: {
            host: rconCfg.host,
            port: rconCfg.port || 27015,
            password: rconCfg.password,
          },
        };
        if (sftp) {
          serverDef.sftp = {
            host: sftp.host || '',
            port: Number(sftp.port) || 22,
            user: sftp.user || '',
            ...(sftp.password ? { password: sftp.password } : {}),
            ...(sftp.privateKeyPath ? { privateKeyPath: sftp.privateKeyPath } : {}),
          };
        }
        if (channels && typeof channels === 'object') serverDef.channels = channels;

        if (startImmediately && this._multiServerManager) {
          await this._multiServerManager.addServer(
            serverDef as unknown as Parameters<typeof this._multiServerManager.addServer>[0],
          );
        } else if (configRepo) {
          configRepo.set(`server:${id}`, serverDef);
        }

        res.status(201).json({ ok: true, server: { id, name: serverDef.name, status: 'stopped' } });
      } catch (err: unknown) {
        sendError(res, API_ERRORS.INTERNAL_SERVER_ERROR, 500, safeError(err));
      }
    });

    /** POST /api/panel/servers/discover — Start SFTP path discovery (202 + polling) */
    app.post('/api/panel/servers/discover', requireTier('admin'), rateLimit(30000, 3), (req, res) => {
      type SftpCfg = {
        host?: string;
        port?: number;
        user?: string;
        password?: string;
        privateKeyPath?: string;
        privateKey?: string;
        passphrase?: string;
      };
      let sftpCfg = (req.body as { sftp?: SftpCfg; useCurrentConfig?: boolean }).sftp;

      // Allow using the server's existing SFTP config (for settings page discover button)
      // Use sftpConnectConfig() to get fully resolved connect options
      // (reads private key from disk, handles passphrase fallback).
      if ((req.body as { useCurrentConfig?: boolean }).useCurrentConfig) {
        let connectOpts;
        try {
          const srvCfg = req.srv.config;
          connectOpts = srvCfg.sftpConnectConfig.call(srvCfg);
        } catch (err: unknown) {
          console.error('[DISCOVER] Failed to build SFTP config:', errMsg(err));
          sendError(res, API_ERRORS.MISSING_SFTP_CONFIG, 400);
          return;
        }
        sftpCfg = {
          host: connectOpts.host,
          port: connectOpts.port || 22,
          user: connectOpts.username,
          password: connectOpts.password,
          privateKey: connectOpts.privateKey as string | undefined,
          passphrase: connectOpts.passphrase,
        };
      }

      if (!sftpCfg || !sftpCfg.host || !sftpCfg.user) {
        sendError(res, API_ERRORS.MISSING_SFTP_CONFIG, 400);
        return;
      }
      if (!sftpCfg.password && !sftpCfg.privateKeyPath && !sftpCfg.privateKey) {
        sendError(res, API_ERRORS.MISSING_SFTP_CONFIG, 400);
        return;
      }

      // Max 3 concurrent jobs
      let activeCount = 0;
      for (const [, job] of _discoveryJobs) {
        if (job.state === 'pending' || job.state === 'running') activeCount++;
      }
      if (activeCount >= 3) {
        sendError(res, API_ERRORS.MAX_CONCURRENT_DISCOVERIES, 429);
        return;
      }

      // Cleanup stale jobs (> 5 min)
      const now = Date.now();
      for (const [jid] of _discoveryJobs) {
        const j = _discoveryJobs.get(jid);
        if (j && now - j.startTime > 300000) _discoveryJobs.delete(jid);
      }

      const jobId = 'disc_' + Date.now().toString(36);
      const job: {
        state: string;
        startTime: number;
        result: unknown;
        error: string | null;
        currentStep: string | null;
      } = { state: 'running', startTime: now, result: null, error: null, currentStep: 'connecting' };
      _discoveryJobs.set(jobId, job);

      // Run discovery in background
      const timeoutHandle = setTimeout(() => {
        if (job.state === 'running') {
          job.state = 'failed';
          job.error = 'Discovery timed out after 120 seconds';
          job.currentStep = null;
        }
      }, 120000);

      _discoverPaths(
        {
          host: sftpCfg.host,
          port: sftpCfg.port || 22,
          user: sftpCfg.user,
          password: sftpCfg.password,
          privateKey: sftpCfg.privateKey,
          privateKeyPath: sftpCfg.privateKeyPath,
          passphrase: sftpCfg.passphrase,
        },
        'WEB_DISCOVER',
      )
        .then((result: unknown) => {
          clearTimeout(timeoutHandle);
          if (job.state !== 'running') return;
          job.state = result ? 'completed' : 'failed';
          job.result = result;
          if (!result) job.error = 'No game files found';
          job.currentStep = null;
        })
        .catch((err: unknown) => {
          clearTimeout(timeoutHandle);
          if (job.state !== 'running') return;
          job.state = 'failed';
          job.error = (errMsg(err) || 'Discovery failed').substring(0, 200);
          job.currentStep = null;
        });

      res.status(202).json({ ok: true, jobId });
    });

    /** GET /api/panel/servers/discover/:jobId — Poll discovery job status */

    app.get('/api/panel/servers/discover/:jobId', requireTier('admin'), rateLimit(5000, 20), (req, res) => {
      const job = _discoveryJobs.get(req.params.jobId as string);
      if (!job) {
        sendError(res, API_ERRORS.DISCOVERY_JOB_NOT_FOUND, 404);
        return;
      }
      sendOk(res, {
        state: job.state,
        elapsed: Date.now() - job.startTime,
        ...(job.currentStep ? { currentStep: job.currentStep } : {}),
        ...(job.result ? { result: job.result } : {}),
        ...(job.error ? { error: job.error } : {}),
      });
    });

    /** POST /api/panel/servers/test-connection — Stateless connection validation */
    app.post('/api/panel/servers/test-connection', requireTier('admin'), rateLimit(10000, 5), async (req, res) => {
      try {
        const bodyConn = req.body as {
          rcon?: { host: string; port: number; password: string };
          sftp?: Record<string, unknown>;
        };
        const rconCfg = bodyConn.rcon;
        const sftpCfg = bodyConn.sftp;
        if (!rconCfg && !sftpCfg) {
          sendError(res, API_ERRORS.MISSING_CONNECTION_CONFIG, 400);
          return;
        }

        const result = {};
        const promises: Promise<void>[] = [];

        if (rconCfg) {
          promises.push(
            _testRconAuth(rconCfg.host, rconCfg.port || 27015, rconCfg.password || '', 10000).then((r) => {
              (result as Record<string, unknown>).rcon = r;
            }),
          );
        }
        if (sftpCfg) {
          promises.push(
            _testSftpAuth(sftpCfg, 10000).then((r) => {
              (result as Record<string, unknown>).sftp = r;
            }),
          );
        }

        await Promise.all(promises);
        sendOk(res, result as unknown as Record<string, unknown>);
      } catch (err: unknown) {
        sendError(res, API_ERRORS.INTERNAL_SERVER_ERROR, 500, safeError(err));
      }
    });

    /** GET /api/panel/servers/:id — Get server detail (passwords masked) */
    app.get('/api/panel/servers/:id', requireTier('admin'), rateLimit(10000, 10), (req, res) => {
      try {
        const id = req.params.id as string;

        if (id === 'primary') {
          const def: Record<string, unknown> = {
            id: 'primary',
            name: config.serverName || 'Primary Server',
            isPrimary: true,
            enabled: true,
            rcon: {
              host: config.rconHost || '',
              port: config.rconPort || 27015,
              password: { hasValue: !!config.rconPassword },
            },
            sftp: {
              host: config.sftpHost || '',
              port: config.sftpPort || 22,
              user: config.sftpUser || '',
              password: { hasValue: !!config.sftpPassword },
              privateKeyPath: { hasValue: !!config.sftpPrivateKeyPath },
            },
            paths: {
              logPath: config.sftpLogPath || '',
              connectLogPath: config.sftpConnectLogPath || '',
              idMapPath: config.sftpIdMapPath || '',
              savePath: config.sftpSavePath || '',
              settingsPath: config.sftpSettingsPath || '',
              welcomePath: config.sftpWelcomePath || '',
            },
            botTimezone: config.botTimezone || 'UTC',
            logTimezone: config.logTimezone || 'UTC',
          };
          const statusCache = this._getCached('status', 'primary', 30000) as Record<string, unknown> | null;
          if (statusCache) {
            def.status = statusCache.serverState || 'unknown';
            def.players = { current: statusCache.onlineCount || 0, max: statusCache.maxPlayers || null };
          } else {
            def.status = rcon.connected ? 'running' : 'offline';
            def.players = { current: 0, max: null };
          }
          sendOk(res, { server: def });
          return;
        }

        // Managed server
        const raw = configRepo?.get(`server:${id}`);
        if (!raw) {
          sendError(res, API_ERRORS.SERVER_NOT_FOUND, 404);
          return;
        }

        const masked = _maskServerDef(raw);
        const inst = this._multiServerManager?.getInstance(id);
        masked.status = inst?.running ? 'running' : 'stopped';
        const srvCache = this._getCached('status', id, 30000) as Record<string, unknown> | null;
        if (srvCache) {
          masked.players = { current: srvCache.onlineCount || 0, max: srvCache.maxPlayers || null };
        } else {
          masked.players = { current: 0, max: null };
        }

        sendOk(res, { server: masked });
      } catch (err: unknown) {
        sendError(res, API_ERRORS.INTERNAL_SERVER_ERROR, 500, safeError(err));
      }
    });

    /** PATCH /api/panel/servers/:id — Update server settings (partial) */
    app.patch('/api/panel/servers/:id', requireTier('admin'), rateLimit(10000, 5), async (req, res) => {
      try {
        const id = req.params.id as string;
        const updates: Record<string, unknown> = req.body as Record<string, unknown>;
        if (typeof updates !== 'object' || Array.isArray(updates)) {
          sendError(res, API_ERRORS.MISSING_CHANGES_OBJECT, 400);
          return;
        }

        if (id === 'primary') {
          if (configRepo) {
            const patch: Record<string, unknown> = { ...updates };
            // Empty-string sensitive fields = "keep existing"
            if (patch.rcon) {
              const rcon = { ...(patch.rcon as Record<string, unknown>) };
              if (rcon.password === '') delete rcon.password;
              patch.rcon = rcon;
            }
            if (patch.sftp) {
              const sftp = { ...(patch.sftp as Record<string, unknown>) };
              if (sftp.password === '') delete sftp.password;
              if (sftp.privateKeyPath === '') delete sftp.privateKeyPath;
              patch.sftp = sftp;
            }
            configRepo.update('server:primary', patch);
          }
          const restartRequired = !!(updates.rcon || updates.sftp || updates.paths);
          sendOk(res, { restartRequired });
          return;
        }

        // Managed server
        if (!configRepo) {
          sendError(res, API_ERRORS.INTERNAL_SERVER_ERROR, 500);
          return;
        }
        const existing: Record<string, unknown> = configRepo.get(`server:${id}`) ?? {};
        if (!Object.keys(existing).length) {
          sendError(res, API_ERRORS.SERVER_NOT_FOUND, 404);
          return;
        }

        // Deep-merge sub-objects; empty-string sensitive fields = keep existing
        const patch: Record<string, unknown> = { ...updates };
        if (patch.rcon) {
          const existRcon = (existing.rcon as Record<string, unknown> | undefined) ?? {};
          const rcon: Record<string, unknown> = { ...existRcon, ...(patch.rcon as Record<string, unknown>) };
          if (rcon.password === '') rcon.password = existRcon.password ?? '';
          patch.rcon = rcon;
        }
        if (patch.sftp) {
          const existSftp = (existing.sftp as Record<string, unknown> | undefined) ?? {};
          const sftp: Record<string, unknown> = { ...existSftp, ...(patch.sftp as Record<string, unknown>) };
          if (sftp.password === '') sftp.password = existSftp.password ?? '';
          if (sftp.privateKeyPath === '') sftp.privateKeyPath = existSftp.privateKeyPath ?? '';
          patch.sftp = sftp;
        }
        if (patch.panel) {
          const existPanel = (existing.panel as Record<string, unknown> | undefined) ?? {};
          const panel: Record<string, unknown> = { ...existPanel, ...(patch.panel as Record<string, unknown>) };
          if (panel.apiKey === '') panel.apiKey = existPanel.apiKey ?? '';
          patch.panel = panel;
        }
        if (patch.channels) {
          patch.channels = {
            ...((existing.channels as Record<string, unknown> | undefined) ?? {}),
            ...(patch.channels as Record<string, unknown>),
          };
        }
        if (patch.paths) {
          patch.paths = {
            ...((existing.paths as Record<string, unknown> | undefined) ?? {}),
            ...(patch.paths as Record<string, unknown>),
          };
        }

        configRepo.update(`server:${id}`, patch);

        // Hot-reload running instance if applicable
        if (this._multiServerManager?.getInstance(id)?.running) {
          try {
            await this._multiServerManager.updateServer(id, patch);
          } catch (hotReloadErr: unknown) {
            console.warn(
              '[WebMap] Hot-reload for server %s failed, will apply on next start:',
              id,
              errMsg(hotReloadErr),
            );
          }
        }

        const restartRequired = !!(updates.rcon || updates.sftp || updates.paths);
        sendOk(res, { restartRequired });
      } catch (err: unknown) {
        sendError(res, API_ERRORS.INTERNAL_SERVER_ERROR, 500, safeError(err));
      }
    });

    /** DELETE /api/panel/servers/:id — Remove a managed server */
    app.delete('/api/panel/servers/:id', requireTier('admin'), rateLimit(10000, 3), async (req, res) => {
      try {
        const id = req.params.id as string;
        if (id === 'primary') {
          sendError(res, API_ERRORS.CANNOT_DELETE_PRIMARY, 403);
          return;
        }
        if (req.query.confirm !== 'true') {
          sendError(res, API_ERRORS.CONFIRM_REQUIRED, 400);
          return;
        }

        if (configRepo) {
          const existing = configRepo.get(`server:${id}`);
          if (!existing) {
            sendError(res, API_ERRORS.SERVER_NOT_FOUND, 404);
            return;
          }
        }

        if (this._multiServerManager) {
          try {
            await this._multiServerManager.removeServer(id);
          } catch (removeErr: unknown) {
            console.warn('[WebMap] removeServer(%s) cleanup warning:', id, errMsg(removeErr));
          }
        }
        if (configRepo) {
          configRepo.delete(`server:${id}`);
        }

        sendOk(res);
      } catch (err: unknown) {
        sendError(res, API_ERRORS.INTERNAL_SERVER_ERROR, 500, safeError(err));
      }
    });

    /** POST /api/panel/servers/:id/actions/:action — Lifecycle control (start/stop/restart) */
    app.post('/api/panel/servers/:id/actions/:action', requireTier('admin'), rateLimit(10000, 5), async (req, res) => {
      try {
        const id = req.params.id as string;
        const action = req.params.action as string;
        if (id === 'primary') {
          sendError(res, API_ERRORS.CANNOT_CONTROL_PRIMARY, 400);
          return;
        }
        if (!['start', 'stop', 'restart'].includes(action)) {
          sendError(res, API_ERRORS.INVALID_LIFECYCLE_ACTION, 400);
          return;
        }
        if (!this._multiServerManager) {
          sendError(res, API_ERRORS.MULTI_SERVER_NOT_AVAILABLE, 500);
          return;
        }

        // Verify server definition exists
        const def = configRepo?.get(`server:${id}`);
        if (!def) {
          sendError(res, API_ERRORS.SERVER_NOT_FOUND, 404);
          return;
        }

        const inst = this._multiServerManager.getInstance(id);

        if (action === 'start') {
          if (inst?.running) {
            sendError(res, API_ERRORS.SERVER_ALREADY_IN_STATE, 409);
            return;
          }
          await this._multiServerManager.startServer(id);
          sendOk(res, { status: 'running' });
          return;
        }

        if (action === 'stop') {
          if (!inst?.running) {
            sendError(res, API_ERRORS.SERVER_ALREADY_IN_STATE, 409);
            return;
          }
          await this._multiServerManager.stopServer(id);
          sendOk(res, { status: 'stopped' });
          return;
        }

        // restart
        if (inst?.running) {
          await this._multiServerManager.stopServer(id);
        }
        await this._multiServerManager.startServer(id);
        sendOk(res, { status: 'running' });
      } catch (err: unknown) {
        sendError(res, API_ERRORS.INTERNAL_SERVER_ERROR, 500, safeError(err));
      }
    });

    // ── Panel: Settings Schema ──
    /** GET /api/panel/settings-schema — Return game settings category definitions */

    app.get('/api/panel/settings-schema', requireTier('admin'), (_req, res) => {
      res.json({ categories: GAME_SETTINGS_CATEGORIES });
    });

    // ── Panel: Per-Server Auto-Messages ──
    /** GET /api/panel/servers/:id/auto-messages — Read auto-messages config for a server */
    app.get('/api/panel/servers/:id/auto-messages', requireTier('admin'), rateLimit(10000, 10), (req, res) => {
      try {
        const id = req.params.id as string;
        const defaults = {
          enableWelcomeMsg: true,
          enableWelcomeFile: false,
          enableAutoMsgLink: true,
          enableAutoMsgPromo: true,
          linkText: '',
          promoText: '',
          discordLink: '',
        };
        if (!configRepo) {
          sendError(res, API_ERRORS.NO_DATABASE, 503, 'Config database not available');
          return;
        }
        const scope = `server:${id}`;
        if (id !== 'primary' && !configRepo.get(scope)) {
          sendError(res, API_ERRORS.SERVER_NOT_FOUND, 404);
          return;
        }
        const serverData = configRepo.get(scope) || {};
        const stored = serverData.autoMessages || null;
        const data = Object.assign({}, defaults, stored || {});
        sendOk(res, data);
      } catch (err: unknown) {
        sendError(res, API_ERRORS.INTERNAL_SERVER_ERROR, 500, safeError(err));
      }
    });

    /** POST /api/panel/servers/:id/auto-messages — Save auto-messages config for a server */
    app.post('/api/panel/servers/:id/auto-messages', requireTier('admin'), rateLimit(10000, 5), (req, res) => {
      try {
        const id = req.params.id as string;
        const {
          enableWelcomeMsg,
          enableWelcomeFile,
          enableAutoMsgLink,
          enableAutoMsgPromo,
          linkText,
          promoText,
          discordLink,
        } = req.body as {
          enableWelcomeMsg?: unknown;
          enableWelcomeFile?: unknown;
          enableAutoMsgLink?: unknown;
          enableAutoMsgPromo?: unknown;
          linkText?: unknown;
          promoText?: unknown;
          discordLink?: unknown;
        };

        const data = {
          enableWelcomeMsg: !!enableWelcomeMsg,
          enableWelcomeFile: !!enableWelcomeFile,
          enableAutoMsgLink: !!enableAutoMsgLink,
          enableAutoMsgPromo: !!enableAutoMsgPromo,
          linkText: typeof linkText === 'string' ? linkText.trim() : '',
          promoText: typeof promoText === 'string' ? promoText.trim() : '',
          discordLink: typeof discordLink === 'string' ? discordLink.trim() : '',
        };

        if (!configRepo) {
          sendError(res, API_ERRORS.NO_DATABASE, 503, 'Config database not available');
          return;
        }
        const scope = `server:${id}`;
        if (id !== 'primary' && !configRepo.get(scope)) {
          sendError(res, API_ERRORS.SERVER_NOT_FOUND, 404);
          return;
        }
        configRepo.update(scope, { autoMessages: data });
        sendOk(res, { saved: true, requiresRestart: true });
      } catch (err: unknown) {
        sendError(res, API_ERRORS.INTERNAL_SERVER_ERROR, 500, safeError(err));
      }
    });

    // ── Panel: Bot actions (restart, reimport, factory reset, env sync) ──
    /** POST /api/panel/bot-actions/:action — Bot lifecycle control */
    app.post('/api/panel/bot-actions/:action', requireTier('admin'), rateLimit(30000, 3), (req, res) => {
      try {
        const action = req.params.action as string;
        const validActions = ['restart', 'reimport', 'factory_reset', 'env_sync'];
        if (!validActions.includes(action)) {
          sendError(res, API_ERRORS.INVALID_BOT_ACTION, 400);
          return;
        }
        if (!this._botControl) {
          sendError(res, API_ERRORS.BOT_CONTROL_NOT_AVAILABLE, 500);
          return;
        }

        const meta = { source: 'web', user: req.session.username || 'unknown' };
        let result;

        switch (action) {
          case 'restart':
            result = this._botControl.restart(meta);
            break;
          case 'reimport':
            result = this._botControl.reimport(meta);
            break;
          case 'factory_reset': {
            const { confirm } = req.body as { confirm?: string };
            if (confirm !== 'NUKE') {
              sendError(res, API_ERRORS.CONFIRM_NUKE_REQUIRED, 400);
              return;
            }
            result = this._botControl.factoryReset(meta);
            break;
          }
          case 'env_sync':
            result = this._botControl.envSync();
            break;
        }

        sendOk(res, result as unknown as Record<string, unknown>);
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === 'BOT_ACTION_PENDING') {
          sendError(res, API_ERRORS.BOT_ACTION_PENDING, 409);
          return;
        }
        sendError(res, API_ERRORS.INTERNAL_SERVER_ERROR, 500, safeError(err));
      }
    });

    // ══════════════════════════════════════════════════════════════════
    //  Timeline API — time-scroll playback, entity history, death causes
    // ══════════════════════════════════════════════════════════════════

    /** GET /api/timeline/bounds — earliest/latest snapshot timestamps + count */
    app.get('/api/timeline/bounds', requireTier('survivor'), rateLimit(10000, 10), (req, res) => {
      if (!req.srv.db) return res.json({ earliest: null, latest: null, count: 0 });
      try {
        const bounds = req.srv.db.getTimelineBounds();
        res.json(bounds || { earliest: null, latest: null, count: 0 });
      } catch (err: unknown) {
        sendError(res, API_ERRORS.INTERNAL_SERVER_ERROR, 500, safeError(err));
      }
    });

    /** GET /api/timeline/snapshots?from=&to=&limit= — snapshot list (metadata only) */
    app.get('/api/timeline/snapshots', requireTier('survivor'), rateLimit(10000, 10), (req, res) => {
      if (!req.srv.db) return res.json([]);
      try {
        const { from, to, limit } = req.query;
        let snapshots;
        if (from && to) {
          snapshots = req.srv.db.getTimelineSnapshotRange(from as string, to as string);
        } else {
          snapshots = req.srv.db.getTimelineSnapshots(parseInt(limit as string, 10) || 50);
        }
        res.json(snapshots);
      } catch (err: unknown) {
        sendError(res, API_ERRORS.INTERNAL_SERVER_ERROR, 500, safeError(err));
      }
    });

    /** GET /api/timeline/snapshot/:id — full snapshot data (all entities with map coords) */
    app.get('/api/timeline/snapshot/:id', requireTier('survivor'), rateLimit(10000, 15), (req, res) => {
      if (!req.srv.db) {
        sendError(res, API_ERRORS.DATABASE_NOT_AVAILABLE, 404);
        return;
      }
      try {
        const id = parseInt(req.params.id as string, 10);
        if (isNaN(id)) {
          sendError(res, API_ERRORS.INVALID_SNAPSHOT_ID, 400);
          return;
        }

        const full = req.srv.db.getTimelineSnapshotFull(id);
        if (!full) {
          sendError(res, API_ERRORS.SNAPSHOT_NOT_FOUND, 404);
          return;
        }

        // Convert world coordinates to leaflet coordinates for all entities
        const convert = (item: Record<string, unknown>) => {
          if (item.pos_x != null && item.pos_y != null && !(item.pos_x === 0 && item.pos_y === 0)) {
            const [lat, lng] = this._worldToLeaflet(item.pos_x as number, item.pos_y as number);
            return { ...item, lat, lng };
          }
          return { ...item, lat: null, lng: null };
        };

        full.players = (full.players as Record<string, unknown>[]).map(convert);
        full.ai = (full.ai as Record<string, unknown>[]).map(convert);
        full.vehicles = (full.vehicles as Record<string, unknown>[]).map(convert);
        full.structures = (full.structures as Record<string, unknown>[]).map(convert);
        full.companions = (full.companions as Record<string, unknown>[]).map(convert);
        full.backpacks = (full.backpacks as Record<string, unknown>[]).map(convert);

        // Build name map for owner resolution
        const nameMap = {};
        try {
          const rows = (req.srv.db.db?.prepare('SELECT steam_id, name FROM players').all() ?? []) as Record<
            string,
            unknown
          >[];
          for (const r of rows) (nameMap as Record<string, string>)[r.steam_id as string] = r.name as string;
        } catch {
          /* */
        }
        (full as Record<string, unknown>).nameMap = nameMap;

        res.json(full);
      } catch (err: unknown) {
        sendError(res, API_ERRORS.INTERNAL_SERVER_ERROR, 500, safeError(err));
      }
    });

    /** GET /api/timeline/player/:steamId/trail?from=&to= — player position history */
    app.get('/api/timeline/player/:steamId/trail', requireTier('survivor'), rateLimit(10000, 10), (req, res) => {
      if (!req.srv.db) return res.json([]);
      try {
        const { steamId } = req.params;
        const { from, to } = req.query;
        if (!from || !to) {
          sendError(res, API_ERRORS.FROM_AND_TO_REQUIRED, 400);
          return;
        }

        const positions = req.srv.db.getPlayerPositionHistory(steamId as string, from as string, to as string);
        // Convert to map coordinates
        const trail = (positions as Record<string, unknown>[])
          .map((p) => {
            if (p.pos_x != null && p.pos_y != null && !(p.pos_x === 0 && p.pos_y === 0)) {
              const [lat, lng] = this._worldToLeaflet(p.pos_x as number, p.pos_y as number);
              return { lat, lng, health: p.health, online: p.online, time: p.created_at, gameDay: p.game_day };
            }
            return null;
          })
          .filter(Boolean);

        res.json(trail);
      } catch (err: unknown) {
        sendError(res, API_ERRORS.INTERNAL_SERVER_ERROR, 500, safeError(err));
      }
    });

    /** GET /api/timeline/ai/population?from=&to= — AI population over time */
    app.get('/api/timeline/ai/population', requireTier('survivor'), rateLimit(10000, 10), (req, res) => {
      if (!req.srv.db) return res.json([]);
      try {
        const { from, to } = req.query;
        if (!from || !to) {
          sendError(res, API_ERRORS.FROM_AND_TO_REQUIRED, 400);
          return;
        }
        const data = req.srv.db.getAIPopulationHistory(from as string, to as string);
        res.json(data);
      } catch (err: unknown) {
        sendError(res, API_ERRORS.INTERNAL_SERVER_ERROR, 500, safeError(err));
      }
    });

    /** GET /api/timeline/deaths?limit=&player= — recent death causes */
    app.get('/api/timeline/deaths', requireTier('survivor'), rateLimit(10000, 15), (req, res) => {
      if (!req.srv.db) return res.json([]);
      try {
        const { limit, player } = req.query;
        let deaths;
        if (player) {
          deaths = req.srv.db.getDeathCausesByPlayer(player as string, parseInt(limit as string, 10) || 50);
        } else {
          deaths = req.srv.db.getDeathCauses(parseInt(limit as string, 10) || 50);
        }
        // Add map coordinates
        deaths = (deaths as DeathCauseRow[]).map((d: DeathCauseRow) => {
          if (d.pos_x != null && d.pos_y != null && !(d.pos_x === 0 && d.pos_y === 0)) {
            const [lat, lng] = this._worldToLeaflet(d.pos_x, d.pos_y);
            return { ...d, lat, lng };
          }
          return { ...d, lat: null, lng: null };
        });
        res.json(deaths);
      } catch (err: unknown) {
        sendError(res, API_ERRORS.INTERNAL_SERVER_ERROR, 500, safeError(err));
      }
    });

    /** GET /api/timeline/deaths/stats — death cause breakdown */
    app.get('/api/timeline/deaths/stats', requireTier('survivor'), rateLimit(10000, 10), (req, res) => {
      if (!req.srv.db) return res.json([]);
      try {
        const stats = req.srv.db.getDeathCauseStats();
        res.json(stats);
      } catch (err: unknown) {
        sendError(res, API_ERRORS.INTERNAL_SERVER_ERROR, 500, safeError(err));
      }
    });
  }

  /** Start the Express server. */
  _addErrorHandler(): void {
    // Global error handler — catch unhandled errors in routes

    this._app.use(
      (
        err: unknown,
        _req: import('express').Request,
        res: import('express').Response,
        _next: import('express').NextFunction,
      ) => {
        console.error('[WEB MAP] Unhandled route error:', errMsg(err));
        if (!res.headersSent) {
          sendError(res, API_ERRORS.INTERNAL_SERVER_ERROR, 500);
        }
      },
    );
  }

  /**
   * Background polling — proactively builds cached responses for all endpoints.
   * Runs every 15s so client requests are always served from cache instantly.
   * All RCON calls for multiple servers run in parallel.
   */
  _startBackgroundPolling(): void {
    const POLL_INTERVAL = 15000;
    const RCON_TIMEOUT = 5000;
    const rconTimeout = (promise: Promise<unknown>) =>
      Promise.race([
        promise,
        new Promise((_, rej) =>
          setTimeout(() => {
            rej(new Error('RCON timeout'));
          }, RCON_TIMEOUT),
        ),
      ]);

    const poll = async (): Promise<void> => {
      try {
        // ── Build landing data (all servers in parallel) ──
        await this._buildLandingData(rconTimeout);

        // ── Build per-server status + stats caches ──
        const serverIds = ['primary'];
        const additional = this._loadServerList();
        for (const s of additional) serverIds.push(s.id);

        const statusPromises = serverIds.map(async (id) => {
          try {
            const srv = this._resolveServer(id === 'primary' ? '' : id);
            if (!srv) return;
            await this._buildStatusCache(srv, rconTimeout);
            await this._buildStatsCache(srv, rconTimeout);
          } catch {
            /* non-critical — individual server poll failure */
          }
        });
        await Promise.all(statusPromises);
      } catch (err: unknown) {
        console.error('[WEB MAP] Background poll error:', errMsg(err));
      }
    };

    // Initial poll (immediate, don't await — let server start)
    void poll();
    this._pollTimer = setInterval(() => void poll(), POLL_INTERVAL);
    this._pollTimer.unref();
    console.log(`[WEB MAP] Background polling started (every ${String(POLL_INTERVAL / 1000)}s)`);
  }

  /** Build and cache the landing page data. All RCON calls parallelised. */
  async _buildLandingData(rconTimeout: (p: Promise<unknown>) => Promise<unknown>): Promise<void> {
    const result: Record<string, unknown> & { primary: Record<string, unknown>; servers: Record<string, unknown>[] } = {
      primary: {
        name: config.serverName || 'HumanitZ Server',
        host: config.publicHost || '',
        gamePort: config.gamePort || '',
        status: 'unknown',
        onlineCount: 0,
        maxPlayers: null,
        totalPlayers: 0,
        gameDay: null,
        season: null,
        gameTime: null,
        timezone: config.botTimezone || 'UTC',
      },
      servers: [],
      schedule: null,
    };

    // Gather all RCON promises in parallel
    const additional = this._loadServerList();
    const primaryRcon = (async () => {
      try {
        const [infoRaw, listRaw] = await Promise.all([rconTimeout(_getServerInfo()), rconTimeout(_getPlayerList())]);
        const info = infoRaw as import('../rcon/server-info.js').ServerInfo | undefined;
        const list = listRaw as import('../rcon/server-info.js').PlayerList | undefined;
        if (info) {
          result.primary.status = 'online';
          result.primary.maxPlayers = info.maxPlayers || null;
          result.primary.gameDay = info.day || null;
          if (info.season) result.primary.season = info.season;
          if (info.name) result.primary.rconName = info.name;
          if (info.time) result.primary.gameTime = info.time;
        }
        const playerArr = list?.players || (Array.isArray(list) ? list : []);
        result.primary.onlineCount = playerArr.length;
      } catch {
        result.primary.status = 'offline';
      }
    })();

    const serverRcons = additional.map(async (s: Record<string, unknown>) => {
      const dir = this._getServerDataDir(s.id as string);
      if (!dir) return null;
      const serverInfo: Record<string, unknown> = {
        id: s.id,
        name: s.name || s.id,
        host: s.publicHost || s.host || config.publicHost || '',
        gamePort: s.gamePort || '',
        status: 'unknown',
        onlineCount: 0,
        totalPlayers: 0,
      };

      const srv = this._resolveServer(s.id as string);
      if (srv) {
        try {
          const [infoRaw, listRaw] = await Promise.all([
            rconTimeout(srv.getServerInfo()),
            rconTimeout(srv.getPlayerList()),
          ]);
          const info = infoRaw as import('../rcon/server-info.js').ServerInfo | undefined;
          const list = listRaw as import('../rcon/server-info.js').PlayerList | undefined;
          if (info) {
            serverInfo.status = 'online';
            serverInfo.maxPlayers = info.maxPlayers || null;
            serverInfo.gameDay = info.day || null;
            if (info.season) serverInfo.season = info.season;
            if (info.name) serverInfo.rconName = info.name;
            if (info.time) serverInfo.gameTime = info.time;
          }
          const playerArr = list?.players || (Array.isArray(list) ? list : []);
          serverInfo.onlineCount = playerArr.length;
        } catch {
          serverInfo.status = 'offline';
        }
      }

      // DB/file enrichment (fast, no RCON)
      if (srv?.db) {
        try {
          const cnt = srv.db.db?.prepare('SELECT COUNT(*) as cnt FROM players').get() as { cnt: number } | undefined;
          if (cnt?.cnt) serverInfo.totalPlayers = cnt.cnt;
          if (!serverInfo.maxPlayers) {
            const settingsRow = srv.db.db
              ?.prepare("SELECT value FROM bot_state WHERE key = 'server_settings'")
              .get() as { value: string } | undefined;
            if (settingsRow?.value) {
              const settings = JSON.parse(settingsRow.value) as Record<string, string | undefined>;
              if (settings.MaxPlayers) serverInfo.maxPlayers = parseInt(settings.MaxPlayers, 10) || null;
              if (settings.DaysPerSeason) serverInfo.daysPerSeason = parseInt(settings.DaysPerSeason, 10) || 28;
            }
          }
          if (!serverInfo.gameDay) {
            const ws = srv.db.getAllWorldState();
            if (ws.day) serverInfo.gameDay = ws.day;
            if (!serverInfo.season && ws.season) serverInfo.season = ws.season;
          }
        } catch {
          /* DB unavailable */
        }
      }
      if (!serverInfo.totalPlayers) {
        try {
          const saveData = this._parseSaveDataForServer(dir);
          serverInfo.totalPlayers = saveData.size || 0;
        } catch {
          /* non-critical */
        }
      }
      if (!serverInfo.gameDay) {
        const cacheFile = path.join(dir, 'save-cache.json');
        try {
          if (fs.existsSync(cacheFile)) {
            const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as { worldState?: { daysPassed?: unknown } };
            if (cache.worldState?.daysPassed != null) serverInfo.gameDay = cache.worldState.daysPassed;
            if (serverInfo.status === 'unknown') {
              const age = Date.now() - fs.statSync(cacheFile).mtimeMs;
              serverInfo.status = age < 600_000 ? 'online' : 'stale';
            }
          }
        } catch {
          /* non-critical */
        }
      }
      if (srv?.scheduler && (srv.scheduler.isActive as (() => boolean) | undefined)?.() === true) {
        try {
          serverInfo.schedule = (srv.scheduler.getStatus as () => Record<string, unknown>)();
        } catch {
          /* scheduler unavailable */
        }
      }
      if (srv?.db) {
        try {
          const settingsRow = srv.db.db?.prepare("SELECT value FROM bot_state WHERE key = 'server_settings'").get() as
            | DbRow
            | undefined;
          if (settingsRow?.value)
            serverInfo.settings = _extractLandingSettings(
              JSON.parse(settingsRow.value as string) as Record<string, string | undefined>,
            );
        } catch {
          /* non-critical */
        }
      }
      if (!serverInfo.settings) {
        try {
          const settingsFile = path.join(dir, 'server-settings.json');
          if (fs.existsSync(settingsFile))
            serverInfo.settings = _extractLandingSettings(
              JSON.parse(fs.readFileSync(settingsFile, 'utf8')) as Record<string, string | undefined>,
            );
        } catch {
          /* non-critical */
        }
      }
      if (srv) {
        const mods: string[] = [];
        if (srv.rcon.connected) mods.push('rcon');
        if (srv.db) mods.push('db');
        const inst = this._multiServerManager?.getInstance(s.id as string);
        if (inst?.saveService || inst?.hasSftp) mods.push('sftp');
        if (srv.scheduler && srv.scheduler.isActive && (srv.scheduler.isActive as () => boolean)())
          mods.push('schedule');
        if (inst?._modules.logWatcher) mods.push('logs');
        if (inst?._modules.chatRelay) mods.push('chat');
        const instRec = inst as unknown as Record<string, Record<string, Record<string, unknown>>> | undefined;
        if (instRec?._modules && (instRec._modules.anticheat as Record<string, unknown> | undefined)?.available)
          mods.push('anticheat');
        if (
          this._plugins.some(
            (p: Record<string, unknown>) =>
              p.name === 'hzmod' && (p.serverId === s.id || (!p.serverId && s.id === 'vps_dev')),
          )
        )
          mods.push('hzmod');
        serverInfo.modules = mods;
      }
      return serverInfo;
    });

    // Run ALL RCON calls in parallel
    const [, ...serverResults] = await Promise.all([primaryRcon, ...serverRcons]);
    for (const si of serverResults) {
      if (si) result.servers.push(si);
    }

    // Non-RCON enrichment for primary (fast)
    if (this._db) {
      try {
        const cnt = this._db.db?.prepare('SELECT COUNT(*) as cnt FROM players').get();
        if ((cnt as DbRow | undefined)?.cnt) result.primary.totalPlayers = (cnt as DbRow).cnt as number;
      } catch {
        /* db unavailable */
      }
    }
    if (!result.primary.totalPlayers) {
      const players = this._parseSaveData();
      result.primary.totalPlayers = players.size;
    }
    if (this._db) {
      try {
        if (!result.primary.maxPlayers) {
          const settingsRow = this._db.db?.prepare("SELECT value FROM bot_state WHERE key = 'server_settings'").get();
          const settingsVal = (settingsRow as DbRow | undefined)?.value;
          if (settingsVal) {
            const settings = JSON.parse(settingsVal as string) as Record<string, string | undefined>;
            if (settings.MaxPlayers) result.primary.maxPlayers = parseInt(settings.MaxPlayers, 10) || null;
            if (settings.DaysPerSeason) result.primary.daysPerSeason = parseInt(settings.DaysPerSeason, 10) || 28;
          }
        }
        const ws = this._db.getAllWorldState();
        if (!result.primary.gameDay && ws.day) result.primary.gameDay = ws.day;
        if (!result.primary.season && ws.season) result.primary.season = ws.season;
      } catch {
        /* db unavailable */
      }
    }
    if (!result.primary.maxPlayers) {
      try {
        const settingsFile = path.join(DATA_DIR, 'server-settings.json');
        if (fs.existsSync(settingsFile)) {
          const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8')) as Record<string, string | undefined>;
          if (settings.MaxPlayers) result.primary.maxPlayers = parseInt(settings.MaxPlayers, 10) || null;
        }
      } catch {
        /* ignore */
      }
    }
    if (!result.primary.gameDay) {
      try {
        const cachePath = path.join(DATA_DIR, 'save-cache.json');
        if (fs.existsSync(cachePath)) {
          const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as { worldState?: { daysPassed?: unknown } };
          if (cache.worldState?.daysPassed != null) result.primary.gameDay = cache.worldState.daysPassed;
        }
      } catch {
        /* save-cache unavailable */
      }
    }
    if (this._db) {
      try {
        const settingsRow = this._db.db?.prepare("SELECT value FROM bot_state WHERE key = 'server_settings'").get();
        const settingsRowVal = (settingsRow as DbRow | undefined)?.value;
        if (settingsRowVal)
          result.primary.settings = _extractLandingSettings(
            JSON.parse(settingsRowVal as string) as Record<string, string | undefined>,
          );
      } catch {
        /* non-critical */
      }
    }
    if (!result.primary.settings) {
      try {
        const settingsFile = path.join(DATA_DIR, 'server-settings.json');
        if (fs.existsSync(settingsFile))
          result.primary.settings = _extractLandingSettings(
            JSON.parse(fs.readFileSync(settingsFile, 'utf8')) as Record<string, string | undefined>,
          );
      } catch {
        /* non-critical */
      }
    }
    if (this._scheduler && this._scheduler.isActive()) {
      try {
        result.schedule = this._scheduler.getStatus();
      } catch {
        /* scheduler unavailable */
      }
    }
    {
      const mods: string[] = [];
      if (rcon.connected) mods.push('rcon');
      if (this._db) mods.push('db');
      if (this._saveService) mods.push('sftp');
      if (this._scheduler && this._scheduler.isActive()) mods.push('schedule');
      if (this._plugins.some((p: Record<string, unknown>) => p.name === 'hzmod')) mods.push('hzmod');
      result.primary.modules = mods;
    }
    result.primary.discordInvite = config.discordInviteLink || '';
    for (const plugin of this._plugins) {
      if (typeof plugin.getLandingData === 'function') {
        try {
          Object.assign(result, (plugin.getLandingData as () => Record<string, unknown> | null | undefined)() ?? {});
        } catch {
          /* plugin error */
        }
      }
    }
    this._setCache('landing', 'global', result);
  }

  /** Build and cache status data for a single server. */
  async _buildStatusCache(srv: ServerContext, rconTimeout: (p: Promise<unknown>) => Promise<unknown>): Promise<void> {
    const result: Record<string, unknown> = {
      serverState: 'unknown',
      uptime: null,
      maxPlayers: null,
      onlineCount: 0,
      fps: null,
      gameDay: null,
      season: null,
      gameTime: null,
      timezone: srv.config.botTimezone || 'UTC',
      resources: null,
    };
    try {
      const [infoRaw, listRaw] = await Promise.all([
        rconTimeout(srv.getServerInfo()),
        rconTimeout(srv.getPlayerList()),
      ]);
      const info = infoRaw as import('../rcon/server-info.js').ServerInfo | undefined;
      const list = listRaw as import('../rcon/server-info.js').PlayerList | undefined;
      if (info) {
        result.serverState = 'running';
        result.fps = info.fps || null;
        result.gameDay = info.day || null;
        result.maxPlayers = info.maxPlayers || null;
        if (info.season) result.season = info.season;
        if (info.time) result.gameTime = info.time;
      }
      const playerArr = list?.players || (Array.isArray(list) ? list : []);
      result.onlineCount = playerArr.length;
      // Also cache the player list for /api/online
      this._setCache('online', srv.serverId, list);
    } catch {
      result.serverState = 'offline';
    }
    if (!result.maxPlayers) {
      try {
        const settingsFile = path.join(srv.dataDir, 'server-settings.json');
        if (fs.existsSync(settingsFile)) {
          const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8')) as Record<string, string | undefined>;
          if (settings.MaxPlayers) result.maxPlayers = parseInt(settings.MaxPlayers, 10) || null;
        }
      } catch {
        /* ignore */
      }
    }
    if (srv.isPrimary) {
      try {
        const resources = await serverResources.getResources();
        if (resources) {
          result.resources = {
            cpu: resources.cpu,
            memPercent: resources.memPercent,
            memFormatted:
              resources.memUsed != null && resources.memTotal != null
                ? `${formatBytes(resources.memUsed)} / ${formatBytes(resources.memTotal)}`
                : null,
            diskPercent: resources.diskPercent,
            diskFormatted:
              resources.diskUsed != null && resources.diskTotal != null
                ? `${formatBytes(resources.diskUsed)} / ${formatBytes(resources.diskTotal)}`
                : null,
          };
          if (resources.uptime != null) result.uptime = formatUptime(resources.uptime);
        }
      } catch {
        /* resources unavailable */
      }
    }
    if (!result.gameDay) {
      try {
        const cachePath = path.join(srv.dataDir, 'save-cache.json');
        if (fs.existsSync(cachePath)) {
          const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as { worldState?: { daysPassed?: unknown } };
          if (cache.worldState?.daysPassed != null) result.gameDay = cache.worldState.daysPassed;
        }
      } catch {
        /* save-cache unavailable */
      }
    }
    if (srv.db) {
      try {
        const ws = srv.db.getAllWorldState();
        if (!result.gameDay && ws.day) result.gameDay = ws.day;
        if (!result.season && ws.season) result.season = ws.season;
      } catch {
        /* db unavailable */
      }
    }
    try {
      const settingsFile = path.join(srv.dataDir, 'server-settings.json');
      if (fs.existsSync(settingsFile)) {
        const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8')) as Record<string, string | undefined>;
        if (settings.DaysPerSeason) result.daysPerSeason = parseInt(settings.DaysPerSeason, 10) || 28;
      }
    } catch {
      /* ignore */
    }
    if (!result.daysPerSeason && srv.db) {
      try {
        const settingsRow = srv.db.db?.prepare("SELECT value FROM bot_state WHERE key = 'server_settings'").get() as
          | DbRow
          | undefined;
        if (settingsRow?.value) {
          const s = JSON.parse(settingsRow.value as string) as Record<string, string | undefined>;
          if (s.DaysPerSeason) result.daysPerSeason = parseInt(s.DaysPerSeason, 10) || 28;
        }
      } catch {
        /* db unavailable */
      }
    }
    this._setCache('status', srv.serverId, result);
  }

  /** Build and cache stats data for a single server. */
  async _buildStatsCache(srv: ServerContext, rconTimeout: (p: Promise<unknown>) => Promise<unknown>): Promise<void> {
    const result: Record<string, unknown> = { totalPlayers: 0, onlinePlayers: 0, eventsToday: 0, chatsToday: 0 };
    const players = srv.isPrimary ? this._parseSaveData() : this._parseSaveDataForServer(srv.dataDir);
    result.totalPlayers = players.size;
    if (!result.totalPlayers && srv.db) {
      try {
        const cnt = srv.db.db?.prepare('SELECT COUNT(*) as cnt FROM players').get() as { cnt: number } | undefined;
        if (cnt?.cnt) result.totalPlayers = cnt.cnt;
      } catch {
        /* db unavailable */
      }
    }
    // Use status cache for online count (already built)
    const statusCache = this._getCached('status', srv.serverId, 30000) as Record<string, unknown> | null;
    if (statusCache) {
      result.onlinePlayers = statusCache.onlineCount || 0;
    } else {
      try {
        const listRaw = await rconTimeout(srv.getPlayerList());
        const list = listRaw as import('../rcon/server-info.js').PlayerList | undefined;
        const playerArr = list?.players || (Array.isArray(listRaw) ? listRaw : []);
        result.onlinePlayers = (playerArr as unknown[]).length;
      } catch {
        /* RCON unavailable */
      }
    }
    if (srv.db) {
      try {
        const tz = srv.config.botTimezone || 'UTC';
        const nowStr = new Date().toLocaleDateString('en-CA', { timeZone: tz });
        const todayMidnight = new Date(`${nowStr}T00:00:00`);
        const tzDate = new Date(todayMidnight.toLocaleString('en-US', { timeZone: 'UTC' }));
        const localDate = new Date(todayMidnight.toLocaleString('en-US', { timeZone: tz }));
        const offsetMs = tzDate.getTime() - localDate.getTime();
        const todayIso = new Date(todayMidnight.getTime() + offsetMs).toISOString();
        const activities = srv.db.getActivitySince(todayIso);
        result.eventsToday = activities.length;
        const chats = srv.db.getChatSince(todayIso);
        result.chatsToday = chats.length;
      } catch {
        /* db unavailable */
      }
    }
    this._setCache('stats', srv.serverId, result);
  }

  start(): Promise<void> {
    this._addErrorHandler();
    return new Promise((resolve, reject) => {
      this._server = this._app.listen(this._port, () => {
        console.log(`[WEB MAP] Interactive map running at http://localhost:${this._port}`);
        this._startBackgroundPolling();
        resolve();
      });
      this._server.on('error', (err: Error) => {
        console.error('[WEB MAP] Server error:', errMsg(err));
        reject(err);
      });
    });
  }

  /** Stop the server. */
  stop(): void {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
    if (this._server) {
      this._server.close();
      this._server = null;
      console.log('[WEB MAP] Server stopped');
    }
  }
}

import { generateFingerprint } from '../db/item-fingerprint.js';

/**
 * Clean inventory slot items — applies cleanItemName to each item object.
 * Filters out empty/None items, cleans names, preserves durability/ammo.
 * Now also generates item fingerprints for tracking system integration.
 * @param {Array} slots - Array of { item, amount, durability, ammo } or strings
 * @returns {Array}
 */
function _cleanInventorySlots(slots: unknown[]): unknown[] {
  if (!Array.isArray(slots)) return [];
  return slots.map((slot) => {
    if (!slot) return slot;
    if (typeof slot === 'string') {
      if (slot === 'Empty' || slot === 'None') return slot;
      return cleanItemName(slot);
    }
    if (typeof slot === 'object' && (slot as Record<string, unknown>).item) {
      const s = slot as Record<string, unknown>;
      const cleaned: Record<string, unknown> = { ...s, item: cleanItemName(s.item as string) };
      // Generate fingerprint for item tracking integration
      // Uses the RAW item name for fingerprint (before cleaning) since
      // that's what the item tracker uses
      const fp = generateFingerprint(slot as Parameters<typeof generateFingerprint>[0]);
      if (fp) cleaned.fingerprint = fp;
      return cleaned;
    }
    return slot;
  });
}

export default WebMapServer;
export { WebMapServer };

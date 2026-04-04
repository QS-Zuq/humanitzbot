/**
 * Multi-Server Manager — manages additional game server instances.
 *
 * Each extra server gets its own:
 *   - RconManager (different host/port/password)
 *   - PlayerStats (separate data directory)
 *   - PlaytimeTracker (separate data directory)
 *   - ServerStatus, LogWatcher, ChatRelay, PlayerStatsChannel, etc.
 *
 * Server configs are stored in data/servers.json.
 * Primary server (from .env) is NOT managed here — only additional servers.
 */

import fs from 'fs';
import { createRequire } from 'node:module';
import path from 'path';
import type { Client } from 'discord.js';
import SftpClient from 'ssh2-sftp-client';
import _defaultConfig from '../config/index.js';
import { RconManager } from '../rcon/rcon.js';
import { PanelRcon } from '../rcon/panel-rcon.js';
import { createPanelApi, type PanelApi } from './panel-api.js';
import { PlayerStats } from '../tracking/player-stats.js';
import { PlaytimeTracker } from '../tracking/playtime-tracker.js';
import { getServerInfo, getPlayerList, sendAdminMessage } from '../rcon/server-info.js';
import { createLogger, type Logger } from '../utils/log.js';
import { errMsg } from '../utils/error.js';
import { readPrivateKey } from '../utils/security.js';
import { getDirname } from '../utils/paths.js';

const __dirname = getDirname(import.meta.url);

import HumanitZDB from '../db/database.js';
import { seed as gameReferenceSeed } from '../parsers/game-reference.js';
import SaveService from '../parsers/save-service.js';
import ServerStatus from '../modules/server-status.js';
import StatusChannels from '../modules/status-channels.js';
import ChatRelay from '../modules/chat-relay.js';
import PlayerPresenceTracker from '../modules/player-presence.js';
import AutoMessages from '../modules/auto-messages.js';
import LogWatcher from '../modules/log-watcher.js';
import PlayerStatsChannel from '../modules/player-stats-channel.js';
import PvpScheduler from '../modules/pvp-scheduler.js';
import ServerScheduler from '../modules/server-scheduler.js';
import ActivityLog from '../modules/activity-log.js';
import type { ConfigRepository } from '../db/config-repository.js';

type ConfigType = typeof _defaultConfig;

// ── Server definition interface (servers.json / config_documents) ────────
interface ServerDef {
  id: string;
  name?: string;
  enabled?: boolean;
  gamePort?: string;
  publicHost?: string;
  dockerContainer?: string;
  botTimezone?: string;
  logTimezone?: string;
  locale?: string;
  enableAnticheat?: boolean;
  enableServerScheduler?: boolean;
  agentMode?: string;
  agentTrigger?: string;
  agentNodePath?: string;
  agentCachePath?: string;
  rcon?: { host?: string; port?: number; password?: string };
  sftp?: {
    host?: string;
    port?: number;
    user?: string;
    password?: string;
    privateKey?: string;
    privateKeyPath?: string;
    passphrase?: string;
  };
  paths?: Record<string, string>;
  channels?: {
    serverStatus?: string;
    playerStats?: string;
    chat?: string;
    log?: string;
    admin?: string;
  };
  autoMessages?: {
    enableWelcomeMsg?: boolean;
    enableWelcomeFile?: boolean;
    enableAutoMsgLink?: boolean;
    enableAutoMsgPromo?: boolean;
    linkText?: string;
    promoText?: string;
    discordLink?: string;
  };
  panel?: { serverUrl?: string; apiKey?: string };
  restartTimes?: string | null;
  restartProfiles?: string | null;
  restartProfileSettings?: Record<string, unknown> | null;
  pvpSettingsOverrides?: Record<string, string> | null;
  pvpStartMinutes?: number | null;
  pvpEndMinutes?: number | null;
  pvpDayHours?: Map<number, { start: number; end: number }> | null;
}

interface SftpDiscoverConfig {
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  privateKey?: string;
  privateKeyPath?: string;
  passphrase?: string;
}

interface SftpFileEntry {
  name: string;
  type: string;
  modifyTime?: number;
}

type AnticheatModule =
  | (new (opts: Record<string, unknown>) => {
      start(): Promise<void>;
      available?: boolean;
      onSaveSync?(result: Record<string, unknown>): Promise<void>;
      stop?(): void;
    })
  | null;
let AnticheatIntegration: AnticheatModule = null;
try {
  const _require = createRequire(import.meta.url);
  const _acMod = _require('../modules/anticheat-integration') as Record<string, unknown>;
  AnticheatIntegration = (_acMod.default ?? _acMod) as AnticheatModule;
} catch {
  /* optional module */
}

const SERVERS_FILE = path.join(__dirname, '..', '..', 'data', 'servers.json');
const SERVERS_DIR = path.join(__dirname, '..', '..', 'data', 'servers');

// ═════════════════════════════════════════════════════════════
// Server config persistence
// ═════════════════════════════════════════════════════════════

function loadServers(): ServerDef[] {
  try {
    if (fs.existsSync(SERVERS_FILE)) {
      return JSON.parse(fs.readFileSync(SERVERS_FILE, 'utf8')) as ServerDef[];
    }
  } catch (err: unknown) {
    console.error('[MULTI] Failed to load servers.json:', errMsg(err));
  }
  return [];
}

function saveServers(servers: ServerDef[]): void {
  try {
    const dir = path.dirname(SERVERS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(SERVERS_FILE, JSON.stringify(servers, null, 2), 'utf8');
  } catch (err: unknown) {
    console.error('[MULTI] Failed to save servers.json:', errMsg(err));
  }
}

function generateId(): string {
  return `srv_${Date.now().toString(36)}`;
}

// ═════════════════════════════════════════════════════════════
// SFTP path auto-discovery
// ═════════════════════════════════════════════════════════════

/**
 * Extract SaveName from a GameServerSettings.ini text.
 * Returns the value (e.g. 'DedicatedSaveMP') or null if not found.
 * The game uses this to construct the save filename: Save_{SaveName}.sav
 */
function _extractSaveName(iniText: string): string | null {
  const match = iniText.match(/^\s*SaveName\s*=\s*"?([^"\r\n]+)"?\s*$/im);
  return match?.[1] ? match[1].trim() : null;
}

/** Target filenames to discover on the SFTP server. */
const DISCOVERY_TARGETS = [
  'HMZLog.log',
  'PlayerConnectedLog.txt',
  'PlayerIDMapped.txt',
  'GameServerSettings.ini',
  'WelcomeMessage.txt',
];

/**
 * Pattern for save files: matches Save_*.sav but NOT Save_ClanData.sav.
 * HumanitZ uses GameServerSettings.ini SaveName= to set the save file name.
 * Default is Save_DedicatedSaveMP.sav, but users can change it.
 */
const SAVE_FILE_PATTERN = /^Save_(?!ClanData)[\w]+\.sav$/i;

/** Directory names to discover (for per-restart rotated logs). */
const DISCOVERY_DIR_TARGETS = ['HZLogs'];

/** Total expected discoveries (exact targets + save file + dir targets). */
const MAX_DISCOVERIES = DISCOVERY_TARGETS.length + 1 + DISCOVERY_DIR_TARGETS.length;

/**
 * Recursively search an SFTP server for target files.
 * @param {SftpClient} sftp - connected SFTP client
 * @param {string} dir - directory to search
 * @param {number} depth - current depth
 * @param {number} maxDepth - max recursion depth
 * @param {Map<string,string>} found - results map (filename → remotePath)
 */
async function _discoverFiles(
  sftp: SftpClient,
  dir: string,
  depth: number,
  maxDepth: number,
  found: Map<string, string>,
): Promise<void> {
  if (depth >= maxDepth) return;
  let items: SftpFileEntry[];
  try {
    items = (await sftp.list(dir)) as SftpFileEntry[];
  } catch {
    return;
  }
  for (const item of items) {
    const fullPath = dir === '/' ? `/${item.name}` : `${dir}/${item.name}`;
    if (item.type === 'd') {
      // Track discovery-target directories (e.g. HZLogs)
      if (DISCOVERY_DIR_TARGETS.includes(item.name) && !found.has(item.name)) {
        found.set(item.name, fullPath);
      }
      if (
        /^(\.|node_modules|__pycache__|Engine|Content|Binaries|linux64|steamapps|proc|sys|run|tmp|lost\+found|snap|boot|usr)$/i.test(
          item.name,
        )
      )
        continue;
      await _discoverFiles(sftp, fullPath, depth + 1, maxDepth, found);
    } else if (DISCOVERY_TARGETS.includes(item.name) && !found.has(item.name)) {
      found.set(item.name, fullPath);
    } else if (!found.has('__save_file__') && SAVE_FILE_PATTERN.test(item.name)) {
      // Discover any Save_*.sav (supports custom SaveName in GameServerSettings.ini)
      found.set('__save_file__', fullPath);
    }
    if (found.size >= MAX_DISCOVERIES) return;
  }
}

/**
 * Auto-discover game file paths on an SFTP server.
 * Connects, searches recursively, returns a paths object suitable for servers.json.
 * Also discovers welcomePath by looking for WelcomeMessage.txt in parent directories.
 *
 * @param {{ host: string, port?: number, user: string, password: string }} sftpConfig
 * @param {string} label - server name for logging
 * @returns {Promise<object|null>} paths object or null if discovery fails
 */
async function discoverPaths(
  sftpConfig: SftpDiscoverConfig | undefined,
  rawLabel = 'DISCOVER',
): Promise<Record<string, string> | null> {
  if (
    !sftpConfig?.host ||
    !sftpConfig.user ||
    (!sftpConfig.password && !sftpConfig.privateKey && !sftpConfig.privateKeyPath)
  )
    return null;

  const log = createLogger(rawLabel, 'DISCOVER');

  const sftp = new SftpClient();
  try {
    const connectOpts: Record<string, string | number | Buffer> = {
      host: sftpConfig.host,
      port: sftpConfig.port ?? 22,
      username: sftpConfig.user,
    };
    if (sftpConfig.privateKey) {
      connectOpts.privateKey = sftpConfig.privateKey;
      if (sftpConfig.passphrase) connectOpts.passphrase = sftpConfig.passphrase;
    } else if (sftpConfig.privateKeyPath) {
      connectOpts.privateKey = readPrivateKey(sftpConfig.privateKeyPath);
      if (sftpConfig.password) connectOpts.passphrase = sftpConfig.password;
    } else {
      connectOpts.password = sftpConfig.password ?? '';
    }
    await sftp.connect(connectOpts);

    log.info('Auto-discovering file paths on', sftpConfig.host);
    const found = new Map<string, string>();
    await _discoverFiles(sftp, '/', 0, 8, found);

    if (found.size === 0) {
      await sftp.end().catch(() => {});
      log.info('No game files found on server');
      return null;
    }

    // If GameServerSettings.ini was found but no save file, try to derive save path
    // from the SaveName setting (users can rename saves from the default DedicatedSaveMP)
    if (!found.has('__save_file__') && found.has('GameServerSettings.ini')) {
      try {
        const iniPath = found.get('GameServerSettings.ini') ?? '';
        const iniBuf = (await sftp.get(iniPath)) as Buffer;
        const saveName = _extractSaveName(iniBuf.toString('utf8'));
        if (saveName) {
          // Search the SaveList directory for the custom-named save
          const iniDir = iniPath.replace(/[/\\][^/\\]+$/, '');
          const saveDir = iniDir + '/Saved/SaveGames/SaveList/Default';
          try {
            const items = (await sftp.list(saveDir)) as SftpFileEntry[];
            const saveFile = items.find((f) => f.name === `Save_${saveName}.sav`);
            if (saveFile) {
              found.set('__save_file__', `${saveDir}/${saveFile.name}`);
              log.info('Found custom save:', `Save_${saveName}.sav`, '(from GameServerSettings.ini SaveName)');
            }
          } catch {
            /* SaveList dir not at expected location — will use whatever was discovered */
          }
        }
      } catch {
        /* couldn't read settings — non-critical */
      }
    }

    await sftp.end().catch(() => {});

    // Build paths object
    const paths: Record<string, string> = {};
    if (found.has('HMZLog.log')) paths.logPath = found.get('HMZLog.log') ?? '';
    if (found.has('PlayerConnectedLog.txt')) paths.connectLogPath = found.get('PlayerConnectedLog.txt') ?? '';
    if (found.has('PlayerIDMapped.txt')) paths.idMapPath = found.get('PlayerIDMapped.txt') ?? '';
    if (found.has('__save_file__')) paths.savePath = found.get('__save_file__') ?? '';
    if (found.has('GameServerSettings.ini')) paths.settingsPath = found.get('GameServerSettings.ini') ?? '';
    if (found.has('WelcomeMessage.txt')) paths.welcomePath = found.get('WelcomeMessage.txt') ?? '';

    // If HZLogs found but no HMZLog.log (new server, only has per-restart logs),
    // derive ftpLogPath from HZLogs parent so LogWatcher can find the directory.
    if (found.has('HZLogs') && !found.has('HMZLog.log')) {
      const hzLogsDir = found.get('HZLogs') ?? '';
      const parentDir = hzLogsDir.substring(0, hzLogsDir.lastIndexOf('/'));
      paths.logPath = parentDir + '/HMZLog.log'; // LogWatcher derives HZLogs/ from this parent
      log.info('HZLogs directory found at', hzLogsDir, '— using per-restart log files');
    }

    const foundCount = Object.keys(paths).length;
    const fileNames = Object.values(paths).map((p) => path.basename(p));
    log.info('Discovered', foundCount, 'file(s):', fileNames.join(', '));
    return paths;
  } catch (err: unknown) {
    log.info('SFTP auto-discovery failed:', errMsg(err));
    try {
      await sftp.end();
    } catch {}
    return null;
  }
}

// ═════════════════════════════════════════════════════════════
// Merged config factory
// ═════════════════════════════════════════════════════════════

/**
 * Create a config-like object that inherits from the primary config
 * but overrides server-specific values.
 */
function createServerConfig(serverDef: ServerDef): ConfigType {
  // Prototype inherit all methods and defaults from primary config
  const merged = Object.create(_defaultConfig) as ConfigType;

  // RCON overrides
  if (serverDef.rcon) {
    merged.rconHost = serverDef.rcon.host || '';
    merged.rconPort = serverDef.rcon.port || 14541;
    merged.rconPassword = serverDef.rcon.password || '';
  }

  // Game port
  if (serverDef.gamePort) merged.gamePort = serverDef.gamePort;

  // SFTP overrides (falls back to primary if not set)
  if (serverDef.sftp) {
    if (serverDef.sftp.host) merged.sftpHost = serverDef.sftp.host;
    if (serverDef.sftp.port) merged.sftpPort = serverDef.sftp.port;
    if (serverDef.sftp.user) merged.sftpUser = serverDef.sftp.user;
    if (serverDef.sftp.password) merged.sftpPassword = serverDef.sftp.password;
    // Explicitly set privateKeyPath — if not provided, clear it so the merged
    // config doesn't inherit the primary server's SSH key via prototype chain
    merged.sftpPrivateKeyPath = serverDef.sftp.privateKeyPath || '';
  }

  // SFTP paths (falls back to primary defaults)
  if (serverDef.paths) {
    if (serverDef.paths.logPath) merged.sftpLogPath = serverDef.paths.logPath;
    if (serverDef.paths.connectLogPath) merged.sftpConnectLogPath = serverDef.paths.connectLogPath;
    if (serverDef.paths.idMapPath) merged.sftpIdMapPath = serverDef.paths.idMapPath;
    if (serverDef.paths.savePath) merged.sftpSavePath = serverDef.paths.savePath;
    if (serverDef.paths.settingsPath) merged.sftpSettingsPath = serverDef.paths.settingsPath;
    if (serverDef.paths.welcomePath) merged.sftpWelcomePath = serverDef.paths.welcomePath;
  }

  // Channel overrides
  if (serverDef.channels) {
    merged.serverStatusChannelId = serverDef.channels.serverStatus || '';
    merged.playerStatsChannelId = serverDef.channels.playerStats || '';
    merged.chatChannelId = serverDef.channels.chat || '';
    merged.logChannelId = serverDef.channels.log || '';
    merged.adminChannelId = serverDef.channels.admin || '';
  }

  // Public host for connect address in embeds (don't inherit primary's host)
  merged.publicHost = serverDef.publicHost || serverDef.rcon?.host || '';

  // Server name for thread labels and logging
  merged.serverName = serverDef.name || serverDef.id || '';

  // Timezone overrides (falls back to primary's BOT_TIMEZONE / LOG_TIMEZONE)
  if (serverDef.botTimezone) merged.botTimezone = serverDef.botTimezone;
  if (serverDef.logTimezone) merged.logTimezone = serverDef.logTimezone;

  // Locale override (falls back to primary's BOT_LOCALE)
  if (serverDef.locale) {
    merged.botLocale = serverDef.locale;
  }

  // Docker container name (for restart commands) — explicit to prevent
  // inheriting primary's container name and accidentally restarting it
  merged.dockerContainer = serverDef.dockerContainer || '';

  // Server scheduler overrides — explicitly break prototype chain so managed
  // servers don't inherit the primary server's schedule by default
  merged.restartTimes = serverDef.restartTimes ?? '';
  merged.restartProfiles = serverDef.restartProfiles ?? '';
  merged.enableServerScheduler = serverDef.enableServerScheduler ?? false;

  // Anticheat — per-server toggle (inherits from primary if not set)
  if (serverDef.enableAnticheat !== undefined) merged.enableAnticheat = serverDef.enableAnticheat;

  // PvP overrides — same pattern: don't inherit primary's PvP config
  merged.pvpSettingsOverrides = serverDef.pvpSettingsOverrides ?? null;
  merged.pvpStartMinutes = serverDef.pvpStartMinutes ?? 0;
  merged.pvpEndMinutes = serverDef.pvpEndMinutes ?? 0;
  merged.pvpDayHours = serverDef.pvpDayHours ?? null;

  // Auto-message overrides (per-server welcome + broadcast config)
  const am = serverDef.autoMessages;
  if (am) {
    if (am.enableWelcomeMsg !== undefined) merged.enableWelcomeMsg = am.enableWelcomeMsg;
    if (am.enableWelcomeFile !== undefined) merged.enableWelcomeFile = am.enableWelcomeFile;
    if (am.enableAutoMsgLink !== undefined) merged.enableAutoMsgLink = am.enableAutoMsgLink;
    if (am.enableAutoMsgPromo !== undefined) merged.enableAutoMsgPromo = am.enableAutoMsgPromo;
    if (am.linkText !== undefined) merged.autoMsgLinkText = am.linkText;
    if (am.promoText !== undefined) merged.autoMsgPromoText = am.promoText;
    if (am.discordLink) merged.discordInviteLink = am.discordLink;
  }

  // Panel API overrides (for Pterodactyl-hosted servers like Bisect)
  if (serverDef.panel) {
    if (serverDef.panel.serverUrl) merged.panelServerUrl = serverDef.panel.serverUrl;
    if (serverDef.panel.apiKey) merged.panelApiKey = serverDef.panel.apiKey;
  } else {
    // Explicitly break prototype chain — don't inherit primary's panel credentials
    merged.panelServerUrl = '';
    merged.panelApiKey = '';
  }

  // Agent/cache mode overrides — don't inherit primary's agent config
  // (each server may have different Node.js availability / trigger strategies)
  if (serverDef.agentMode) merged.agentMode = serverDef.agentMode;
  if (serverDef.agentTrigger) merged.agentTrigger = serverDef.agentTrigger;
  if (serverDef.agentNodePath) merged.agentNodePath = serverDef.agentNodePath;
  if (serverDef.agentCachePath) merged.agentCachePath = serverDef.agentCachePath;
  // If no agent config specified, default to direct (don't inherit primary's
  // agent settings — a VPS server with SSH doesn't match Bisect's RCON trigger)
  if (!serverDef.agentMode) merged.agentMode = 'direct';

  return merged;
}

// ═════════════════════════════════════════════════════════════
// ServerInstance — manages all modules for one extra server
// ═════════════════════════════════════════════════════════════

class ServerInstance {
  client: Client;
  id: string;
  name: string;
  def: ServerDef;
  running: boolean;
  _configRepo: ConfigRepository | null;
  dataDir: string;
  config: ConfigType;
  _log: Logger;
  db: HumanitZDB;
  panelApi: PanelApi | null;
  rcon: RconManager | PanelRcon;
  playerStats: PlayerStats;
  playtime: PlaytimeTracker;
  getServerInfo: () => ReturnType<typeof getServerInfo>;
  getPlayerList: () => ReturnType<typeof getPlayerList>;
  sendAdminMessage: (msg: string) => ReturnType<typeof sendAdminMessage>;
  _modules: Record<string, unknown>;
  saveService: SaveService | null;
  _playtimeFlushTimer: ReturnType<typeof setInterval> | null;

  constructor(client: Client, serverDef: ServerDef, deps: { configRepo?: ConfigRepository | null } = {}) {
    this.client = client;
    this.id = serverDef.id;
    this.name = serverDef.name ?? '';
    this.def = serverDef;
    this.running = false;
    this._configRepo = deps.configRepo ?? null;

    // Per-server data directory
    this.dataDir = path.join(SERVERS_DIR, this.id);
    if (!fs.existsSync(this.dataDir)) fs.mkdirSync(this.dataDir, { recursive: true });

    // Merged config
    this.config = createServerConfig(serverDef);

    // Per-server singletons
    this._log = createLogger('MULTI:' + (this.name || this.id), 'MULTI:SERVER');
    // Per-server SQLite database (isolated from primary)
    this.db = new HumanitZDB({
      dbPath: path.join(this.dataDir, 'humanitz.db'),
      label: 'DB:' + this._log.label,
    });
    this.db.init();
    try {
      gameReferenceSeed(this.db);
    } catch (err: unknown) {
      this._log.warn('Game reference seed failed:', errMsg(err));
    }

    // Per-server Panel API (if configured in server definition)
    this.panelApi = null;
    if (serverDef.panel?.serverUrl && serverDef.panel.apiKey) {
      this.panelApi = createPanelApi({
        serverUrl: serverDef.panel.serverUrl,
        apiKey: serverDef.panel.apiKey,
      });
      if (this.panelApi) {
        this._log.info('Panel API configured (Pterodactyl)');
      }
    }

    // RCON — use WebSocket transport if Panel API is available, TCP otherwise
    if (this.panelApi) {
      this.rcon = new PanelRcon({
        panelApi: this.panelApi,
        label: 'RCON:' + this._log.label,
      });
      this._log.info('Using WebSocket RCON (Panel API)');
    } else {
      this.rcon = new RconManager({
        host: this.config.rconHost,
        port: this.config.rconPort,
        password: this.config.rconPassword,
        label: 'RCON:' + this._log.label,
      });
    }

    this.playerStats = new PlayerStats({
      dataDir: this.dataDir,
      db: this.db,
      playtime: null, // set after playtime is created
      label: 'STATS:' + this._log.label,
    });

    this.playtime = new PlaytimeTracker({
      dataDir: this.dataDir,
      db: this.db,
      config: this.config,
      label: 'PLAYTIME:' + this._log.label,
    });

    // Wire up cross-reference
    (this.playerStats as unknown as { _playtime: PlaytimeTracker })._playtime = this.playtime;
    this.playerStats.setDb(this.db);
    this.playtime.setDb(this.db);

    // Bound server-info functions using this rcon
    this.getServerInfo = () => getServerInfo(this.rcon);
    this.getPlayerList = () => getPlayerList(this.rcon);
    this.sendAdminMessage = (msg: string) => sendAdminMessage(msg, this.rcon);

    // Module instances (created on start)
    this._modules = {};
    this.saveService = null;
    this._playtimeFlushTimer = null;
  }

  /** Whether SFTP is configured for this server. */
  get hasSftp() {
    return !!(
      this.config.sftpHost &&
      this.config.sftpUser &&
      (this.config.sftpPassword || this.config.sftpPrivateKeyPath)
    );
  }

  /** Common deps object for module constructors. */
  get _deps() {
    return {
      config: this.config,
      rcon: this.rcon,
      playerStats: this.playerStats,
      playtime: this.playtime,
      getServerInfo: this.getServerInfo,
      getPlayerList: this.getPlayerList,
      sendAdminMessage: this.sendAdminMessage,
      db: this.db,
      dataDir: this.dataDir,
      serverId: this.id,
      label: this._log.label,
      panelApi: this.panelApi,
      // Per-server panel API gets its own resource monitoring if available;
      // otherwise disable to prevent inheriting primary's Pterodactyl stats
      serverResources: this.panelApi ? { backend: 'pterodactyl' as const, panelApi: this.panelApi } : { backend: null },
    };
  }

  async start(): Promise<void> {
    if (this.running) return;
    this._log.info('Starting server');

    // ── Auto-discover SFTP paths if needed ──
    // If this server has its own SFTP but no explicit paths, discover them automatically.
    const hasOwnSftp = this.def.sftp?.host && this.def.sftp.host !== _defaultConfig.sftpHost;
    const hasExplicitPaths = this.def.paths != null && Object.keys(this.def.paths).length > 0;
    if (hasOwnSftp && !hasExplicitPaths) {
      this._log.info('No file paths configured — running auto-discovery...');
      const discovered = await discoverPaths(this.def.sftp, this._log.label);
      if (discovered) {
        // Apply discovered paths to runtime config
        if (discovered.logPath) this.config.sftpLogPath = discovered.logPath;
        if (discovered.connectLogPath) this.config.sftpConnectLogPath = discovered.connectLogPath;
        if (discovered.idMapPath) this.config.sftpIdMapPath = discovered.idMapPath;
        if (discovered.savePath) this.config.sftpSavePath = discovered.savePath;
        if (discovered.settingsPath) this.config.sftpSettingsPath = discovered.settingsPath;
        if (discovered.welcomePath) this.config.sftpWelcomePath = discovered.welcomePath;

        // Persist discovered paths so discovery only runs once
        try {
          if (this._configRepo) {
            this._configRepo.update('server:' + this.id, { paths: discovered });
            this._log.info('Paths saved to DB');
          } else {
            // Legacy fallback: write to servers.json
            const servers = loadServers();
            const idx = servers.findIndex((s) => s.id === this.id);
            const srv = idx !== -1 ? servers[idx] : undefined;
            if (srv) {
              srv.paths = discovered;
              saveServers(servers);
              this._log.info('Paths saved to servers.json');
            }
          }
        } catch (err: unknown) {
          this._log.info('Could not persist paths:', errMsg(err));
        }
      }
    }

    const deps = this._deps;

    // ── Save Service (needs SFTP or Panel API — populates DB with save file data) ──
    // This is independent of any Discord channel — it just parses the save and writes to DB.
    if (this.hasSftp || this.panelApi) {
      try {
        const sftpConfig = this.hasSftp ? this.config.sftpConnectConfig() : undefined;
        this.saveService = new SaveService(this.db, {
          sftpConfig,
          savePath: this.config.sftpSavePath,
          clanSavePath: (() => {
            const sp = this.config.sftpSavePath;
            if (!sp) return undefined;
            const idx = sp.indexOf('SaveList/');
            return idx !== -1 ? sp.slice(0, idx) + 'Save_ClanData.sav' : undefined;
          })(),
          pollInterval: this.config.getEffectiveSavePollInterval(),
          agentMode: (this.config.agentMode || 'direct') as 'auto' | 'agent' | 'direct',
          agentTrigger: this.config.agentTrigger as 'auto' | 'ssh' | 'rcon' | 'panel' | 'none' | undefined,
          agentNodePath: this.config.agentNodePath,
          agentCachePath: this.config.agentCachePath,
          panelApi: this.panelApi ?? undefined,
          dataDir: this.dataDir,
          label: 'SAVE:' + this._log.label,
        } as ConstructorParameters<typeof SaveService>[1]);
        this.saveService.on(
          'sync',
          (result: { playerCount: number; structureCount: number; mode: string; elapsed: number }) => {
            this._log.info(
              'Save sync:',
              result.playerCount,
              'players,',
              result.structureCount,
              'structures',
              `(${result.mode}, ${result.elapsed}ms)`,
            );
          },
        );
        this.saveService.on('error', (err: Error) => {
          this._log.error('Save error:', errMsg(err));
        });
        await this.saveService.start();
        this._log.info(
          'SaveService active',
          `(${(this.saveService as unknown as { stats?: { mode?: string } }).stats?.mode ?? 'direct'} mode)`,
        );
      } catch (err: unknown) {
        this._log.error('SaveService failed:', errMsg(err));
        this.saveService = null;
      }
    }

    // Server Status
    if (this.config.serverStatusChannelId && this.config.rconHost) {
      try {
        const mod = new ServerStatus(this.client, deps as unknown as ConstructorParameters<typeof ServerStatus>[1]);
        await mod.start();
        this._modules.serverStatus = mod;
        this._log.info('ServerStatus active');
      } catch (err: unknown) {
        this._log.error('ServerStatus failed:', errMsg(err));
      }
    }

    // Log Watcher (needs SFTP — can run headless without Discord channel for DB-only data collection)
    if (this.hasSftp) {
      try {
        const mod = new LogWatcher(this.client, deps as ConstructorParameters<typeof LogWatcher>[1]);
        if (_defaultConfig.nukeBot) mod._nukeActive = true;
        await mod.start();
        this._modules.logWatcher = mod;
        this._log.info('LogWatcher active');
      } catch (err: unknown) {
        this._log.error('LogWatcher failed:', errMsg(err));
      }
    }

    // ── Wire LogWatcher → SaveService ID map sharing ──
    // Without this, SaveService has no player names and the DB players table stays empty.
    if (this._modules.logWatcher && this.saveService) {
      const lw = this._modules.logWatcher as LogWatcher;
      const ss = this.saveService;
      lw._onIdMapRefresh = (idMap: Record<string, string>) => {
        ss.setIdMap(idMap);
      };
    }

    // Chat Relay (needs RCON — can run headless without Discord channel for DB-only data collection)
    if (this.config.rconHost) {
      try {
        const mod = new ChatRelay(this.client, deps as ConstructorParameters<typeof ChatRelay>[1]);
        if (_defaultConfig.nukeBot) mod._nukeActive = true;
        // Coordinate thread ordering with LogWatcher if both are active
        if (this._modules.logWatcher) {
          mod._awaitActivityThread = true;
          (this._modules.logWatcher as LogWatcher)._dayRolloverCb = async () => {
            try {
              await mod.createDailyThread();
            } catch (_) {}
          };
        }
        await mod.start();
        this._modules.chatRelay = mod;
        this._log.info('ChatRelay active');
      } catch (err: unknown) {
        this._log.error('ChatRelay failed:', errMsg(err));
      }
    }

    // Player Stats Channel (needs SFTP or Panel File API — can run headless for save-cache.json)
    if (this.hasSftp || this.panelApi) {
      try {
        const mod = new PlayerStatsChannel(
          this.client,
          (this._modules.logWatcher as LogWatcher | null) ?? null,
          deps as ConstructorParameters<typeof PlayerStatsChannel>[2],
        );
        await mod.start();
        this._modules.playerStatsChannel = mod;
        this._log.info('PlayerStatsChannel active');
      } catch (err: unknown) {
        this._log.error('PlayerStatsChannel failed:', errMsg(err));
      }
    }

    // Status Channels (voice channel names)
    if (this.config.guildId) {
      try {
        const categoryName = `\u{1F4CA} ${this.name || this.id}`;
        const mod = new StatusChannels(this.client, { ...deps, categoryName } as ConstructorParameters<
          typeof StatusChannels
        >[1]);
        await mod.start();
        this._modules.statusChannels = mod;
        this._log.info('StatusChannels active');
      } catch (err: unknown) {
        this._log.error('StatusChannels failed:', errMsg(err));
      }
    }

    if (this.config.rconHost) {
      try {
        const mod = new PlayerPresenceTracker({
          config: this.config,
          playtime: this.playtime,
          getPlayerList: deps.getPlayerList,
          label: 'PRESENCE:' + this._log.label,
        });
        await mod.start();
        this._modules.presenceTracker = mod;
        this._log.info('PresenceTracker active');
      } catch (err: unknown) {
        this._log.error('PresenceTracker failed:', errMsg(err));
      }
    }

    // Auto Messages
    const hasAnyAutoMsg =
      this.config.enableAutoMsgLink || this.config.enableAutoMsgPromo || this.config.enableWelcomeMsg;
    if (hasAnyAutoMsg && this.config.rconHost) {
      try {
        const mod = new AutoMessages({
          ...deps,
          presenceTracker: (this._modules.presenceTracker as PlayerPresenceTracker | undefined) ?? null,
        } as ConstructorParameters<typeof AutoMessages>[0]);
        // Note: start() is synchronous; if it ever returns Promise, callers must await
        mod.start();
        this._modules.autoMessages = mod;
        this._log.info('AutoMessages active');
      } catch (err: unknown) {
        this._log.error('AutoMessages failed:', errMsg(err));
      }
    } else if (!hasAnyAutoMsg) {
      this._log.info('AutoMessages skipped — all message features disabled');
    }

    // PvP Scheduler (needs SFTP + RCON)
    if (this.config.rconHost && this.hasSftp && this.config.pvpStartMinutes > 0) {
      try {
        const mod = new PvpScheduler(
          this.client,
          (this._modules.logWatcher as LogWatcher | null) ?? null,
          deps as ConstructorParameters<typeof PvpScheduler>[2],
        );
        await mod.start();
        this._modules.pvpScheduler = mod;
        this._log.info('PvpScheduler active');
      } catch (err: unknown) {
        this._log.error('PvpScheduler failed:', errMsg(err));
      }
    }

    // Server Scheduler (needs SFTP + RCON + restart times)
    if (this.config.enableServerScheduler && this.config.rconHost && this.hasSftp && this.config.restartTimes) {
      try {
        const mod = new ServerScheduler(
          this.client,
          (this._modules.logWatcher as LogWatcher | null) ?? null,
          deps as ConstructorParameters<typeof ServerScheduler>[2],
        );
        await mod.start();
        this._modules.serverScheduler = mod;
        this._log.info('ServerScheduler active');
      } catch (err: unknown) {
        this._log.error('ServerScheduler failed:', errMsg(err));
      }
    }

    // Activity Log — save-file change tracking feed to daily thread or dedicated channel
    if (this.saveService && this.config.enableActivityLog) {
      try {
        const mod = new ActivityLog(this.client, {
          db: this.db,
          saveService: this.saveService,
          logWatcher: this._modules.logWatcher || null,
          label: 'ActivityLog:' + this._log.label,
        });
        await mod.start();
        this._modules.activityLog = mod;
        this._log.info('ActivityLog active');
      } catch (err: unknown) {
        this._log.error('ActivityLog failed:', errMsg(err));
      }
    }

    // Anticheat — observation-only anomaly detection (optional private package)
    if (this.config.enableAnticheat && AnticheatIntegration) {
      try {
        const mod = new AnticheatIntegration({
          db: this.db,
          config: this.config,
          logWatcher: this._modules.logWatcher || null,
        });
        await mod.start();
        if (mod.available && this.saveService) {
          this.saveService.on('sync', (result: Record<string, unknown>) => {
            if (mod.onSaveSync) {
              void mod.onSaveSync(result).catch((syncErr: unknown) => {
                this._log.error('Anticheat save sync error:', errMsg(syncErr));
              });
            }
          });
        }
        this._modules.anticheat = mod;
        this._log.info('Anticheat', mod.available ? 'active' : 'shim only (package not installed)');
      } catch (err: unknown) {
        this._log.error('Anticheat failed:', errMsg(err));
      }
    }

    this.running = true;

    // Periodic flush of active playtime sessions to DB (crash protection)
    this._playtimeFlushTimer = setInterval(() => {
      try {
        this.playtime.flushActiveSessions();
      } catch (_) {}
    }, 60000);

    this._log.info('Server started with', Object.keys(this._modules).length, 'module(s)');
  }

  async stop(): Promise<void> {
    await Promise.resolve(); // ensure async for consistent API
    this._log.info('Stopping server');

    for (const [name, mod] of Object.entries(this._modules)) {
      try {
        if (mod != null && typeof (mod as { stop?: () => void }).stop === 'function') {
          (mod as { stop: () => void }).stop();
        }
      } catch (err: unknown) {
        this._log.error('Error stopping', name + ':', errMsg(err));
      }
    }
    this._modules = {};

    // Disconnect RCON
    try {
      if (typeof this.rcon.disconnect === 'function') this.rcon.disconnect();
    } catch {}

    // Save data
    if (this._playtimeFlushTimer) clearInterval(this._playtimeFlushTimer);
    try {
      if (this.saveService) this.saveService.stop();
    } catch {}
    try {
      this.playerStats.stop();
    } catch {}
    try {
      this.playtime.stop();
    } catch {}

    // Close per-server DB
    try {
      this.db.close();
    } catch {}

    this.running = false;
  }

  /** Get status summary for display. */
  getStatus() {
    return {
      id: this.id,
      name: this.name,
      running: this.running,
      modules: Object.keys(this._modules),
      hasSftp: this.hasSftp,
      hasRcon: !!this.config.rconHost,
    };
  }
}

// ═════════════════════════════════════════════════════════════
// MultiServerManager — orchestrates all extra server instances
// ═════════════════════════════════════════════════════════════

class MultiServerManager {
  client: Client;
  _instances: Map<string, ServerInstance>;
  _configRepo: ConfigRepository | null;

  constructor(client: Client, deps: { configRepo?: ConfigRepository | null } = {}) {
    this.client = client;
    this._instances = new Map();
    this._configRepo = deps.configRepo ?? null;
  }

  /**
   * Load server definitions: DB first, then legacy JSON fallback.
   * @returns {Array<object>} array of serverDef objects
   */
  _loadServerDefs(): ServerDef[] {
    if (this._configRepo) {
      try {
        const all = this._configRepo.loadAll();
        const defs: ServerDef[] = [];
        for (const [scope, { data }] of all) {
          if (scope.startsWith('server:') && scope !== 'server:primary') {
            const def = data as unknown as ServerDef;
            // Ensure id is present (scope is 'server:srv_xxx')
            if (!def.id) def.id = scope.slice(7);
            defs.push(def);
          }
        }
        if (defs.length > 0) return defs;
      } catch (err: unknown) {
        console.error('[MULTI] Failed to load servers from DB:', errMsg(err));
      }
    }
    // Legacy fallback
    return loadServers();
  }

  /**
   * Persist a server definition: DB first, then legacy JSON fallback.
   * @param {string} id - server ID
   * @param {object} serverDef - full server definition
   */
  _persistServer(id: string, serverDef: ServerDef) {
    if (this._configRepo) {
      this._configRepo.set('server:' + id, serverDef as unknown as Record<string, unknown>);
      return;
    }
    // Legacy fallback: read-modify-write servers.json
    const servers = loadServers();
    const idx = servers.findIndex((s) => s.id === id);
    if (idx !== -1) {
      servers[idx] = serverDef;
    } else {
      servers.push(serverDef);
    }
    saveServers(servers);
  }

  /**
   * Remove a server definition: DB first, then legacy JSON fallback.
   * @param {string} id - server ID to remove
   */
  _removeServerDef(id: string) {
    if (this._configRepo) {
      this._configRepo.delete('server:' + id);
      return;
    }
    // Legacy fallback
    const servers = loadServers();
    const filtered = servers.filter((s) => s.id !== id);
    saveServers(filtered);
  }

  /** Load configs and start all enabled servers. */
  async startAll() {
    const servers = this._loadServerDefs();
    const enabled = servers.filter((s) => s.enabled !== false);

    if (enabled.length === 0) {
      console.log('[MULTI] No additional servers configured');
      return;
    }

    console.log('[MULTI] Starting %d additional server(s)...', enabled.length);

    for (const serverDef of enabled) {
      try {
        const instance = new ServerInstance(this.client, serverDef, { configRepo: this._configRepo });
        this._instances.set(serverDef.id, instance);
        await instance.start();
      } catch (err: unknown) {
        console.error('[MULTI] Failed to start %s: %s', serverDef.name, errMsg(err));
      }
    }
  }

  /** Stop all running instances. */
  async stopAll() {
    for (const [, instance] of this._instances) {
      try {
        await instance.stop();
      } catch (err: unknown) {
        console.error('[MULTI] Error stopping %s: %s', instance.name, errMsg(err));
      }
    }
    this._instances.clear();
  }

  /** Add a new server definition, save it, and optionally start it. */
  async addServer(serverDef: ServerDef, autoStart = true) {
    // Assign ID if not present
    if (!serverDef.id) serverDef.id = generateId();
    serverDef.enabled = serverDef.enabled !== false;

    this._persistServer(serverDef.id, serverDef);

    if (autoStart && serverDef.enabled) {
      const instance = new ServerInstance(this.client, serverDef, { configRepo: this._configRepo });
      this._instances.set(serverDef.id, instance);
      await instance.start();
    }

    return serverDef;
  }

  /** Update an existing server definition. Restarts if running. */
  async updateServer(id: string, updates: Partial<ServerDef>) {
    const servers = this._loadServerDefs();
    const existing = servers.find((s) => s.id === id);
    if (!existing) throw new Error(`Server "${id}" not found`);

    // Deep merge updates
    if (updates.name !== undefined) existing.name = updates.name;
    if (updates.enabled !== undefined) existing.enabled = updates.enabled;
    if (updates.gamePort !== undefined) existing.gamePort = updates.gamePort;
    if (updates.rcon) existing.rcon = { ...(existing.rcon ?? {}), ...updates.rcon };
    if (updates.sftp) existing.sftp = { ...(existing.sftp ?? {}), ...updates.sftp };
    if (updates.paths !== undefined) {
      // Empty object = clear all paths (triggers auto-discovery on restart)
      existing.paths =
        Object.keys(updates.paths ?? {}).length > 0 ? { ...(existing.paths ?? {}), ...updates.paths } : {};
    }
    if (updates.channels) existing.channels = { ...(existing.channels ?? {}), ...updates.channels };
    if (updates.botTimezone !== undefined) existing.botTimezone = updates.botTimezone || undefined;
    if (updates.logTimezone !== undefined) existing.logTimezone = updates.logTimezone || undefined;

    this._persistServer(id, existing);

    // Restart if running
    const instance = this._instances.get(id);
    if (instance?.running) {
      await instance.stop();
      const newInstance = new ServerInstance(this.client, existing, { configRepo: this._configRepo });
      this._instances.set(id, newInstance);
      await newInstance.start();
    }

    return existing;
  }

  /** Remove a server and stop it if running. */
  async removeServer(id: string) {
    // Stop if running
    const instance = this._instances.get(id);
    if (instance) {
      await instance.stop();
      this._instances.delete(id);
    }

    // Remove from config
    this._removeServerDef(id);

    // Delete server data directory
    const dataDir = path.join(SERVERS_DIR, path.basename(id));
    if (dataDir.startsWith(SERVERS_DIR) && fs.existsSync(dataDir)) {
      try {
        fs.rmSync(dataDir, { recursive: true, force: true });
        console.log('[MULTI] Deleted data directory for %s', id);
      } catch (err: unknown) {
        console.warn('[MULTI] Could not delete data directory for %s: %s', id, errMsg(err));
      }
    }

    return true;
  }

  /** Start a specific server by ID. */
  async startServer(id: string) {
    const servers = this._loadServerDefs();
    const serverDef = servers.find((s) => s.id === id);
    if (!serverDef) throw new Error(`Server "${id}" not found`);

    // Stop existing if running
    const existing = this._instances.get(id);
    if (existing?.running) await existing.stop();

    const instance = new ServerInstance(this.client, serverDef, { configRepo: this._configRepo });
    this._instances.set(id, instance);
    await instance.start();
  }

  /** Stop a specific server by ID. */
  async stopServer(id: string) {
    const instance = this._instances.get(id);
    if (!instance) throw new Error(`Server "${id}" not running`);
    await instance.stop();
  }

  /** Get instance by ID. */
  getInstance(id: string) {
    return this._instances.get(id);
  }

  /** Get all server definitions (both running and not). */
  getAllServers() {
    return this._loadServerDefs();
  }

  /** Get status of all instances. */
  getStatuses() {
    const servers = this._loadServerDefs();
    return servers.map((s) => {
      const instance = this._instances.get(s.id);
      return {
        ...s,
        running: instance?.running || false,
        modules: instance ? Object.keys(instance._modules) : [],
      };
    });
  }
}

export default MultiServerManager;
export {
  MultiServerManager,
  ServerInstance,
  loadServers,
  saveServers,
  createServerConfig,
  discoverPaths,
  SERVERS_FILE,
  _extractSaveName,
  SAVE_FILE_PATTERN,
};

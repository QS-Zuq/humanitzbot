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

const fs = require('fs');
const path = require('path');
const SftpClient = require('ssh2-sftp-client');
const _defaultConfig = require('../config');
const { RconManager } = require('../rcon/rcon');
const { PanelRcon } = require('../rcon/panel-rcon');
const { createPanelApi } = require('./panel-api');
const { PlayerStats } = require('../tracking/player-stats');
const { PlaytimeTracker } = require('../tracking/playtime-tracker');
const { getServerInfo, getPlayerList, sendAdminMessage } = require('../rcon/server-info');

// Module classes
const HumanitZDB = require('../db/database');
const gameReference = require('../parsers/game-reference');
const SaveService = require('../parsers/save-service');
const ServerStatus = require('../modules/server-status');
const StatusChannels = require('../modules/status-channels');
const ChatRelay = require('../modules/chat-relay');
const AutoMessages = require('../modules/auto-messages');
const LogWatcher = require('../modules/log-watcher');
const PlayerStatsChannel = require('../modules/player-stats-channel');
const PvpScheduler = require('../modules/pvp-scheduler');
const ServerScheduler = require('../modules/server-scheduler');
const ActivityLog = require('../modules/activity-log');
let AnticheatIntegration;
try {
  AnticheatIntegration = require('../modules/anticheat-integration');
} catch {
  /* optional module */
}

const SERVERS_FILE = path.join(__dirname, '..', '..', 'data', 'servers.json');
const SERVERS_DIR = path.join(__dirname, '..', '..', 'data', 'servers');

// ═════════════════════════════════════════════════════════════
// Server config persistence
// ═════════════════════════════════════════════════════════════

function loadServers() {
  try {
    if (fs.existsSync(SERVERS_FILE)) {
      return JSON.parse(fs.readFileSync(SERVERS_FILE, 'utf8'));
    }
  } catch (err) {
    console.error('[MULTI] Failed to load servers.json:', err.message);
  }
  return [];
}

function saveServers(servers) {
  try {
    const dir = path.dirname(SERVERS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(SERVERS_FILE, JSON.stringify(servers, null, 2), 'utf8');
  } catch (err) {
    console.error('[MULTI] Failed to save servers.json:', err.message);
  }
}

function generateId() {
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
function _extractSaveName(iniText) {
  const match = iniText.match(/^\s*SaveName\s*=\s*"?([^"\r\n]+)"?\s*$/im);
  return match ? match[1].trim() : null;
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
async function _discoverFiles(sftp, dir, depth, maxDepth, found) {
  if (depth >= maxDepth) return;
  let items;
  try {
    items = await sftp.list(dir);
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
async function discoverPaths(sftpConfig, label = 'DISCOVER') {
  if (
    !sftpConfig?.host ||
    !sftpConfig?.user ||
    (!sftpConfig?.password && !sftpConfig?.privateKey && !sftpConfig?.privateKeyPath)
  )
    return null;

  const sftp = new SftpClient();
  try {
    const connectOpts = {
      host: sftpConfig.host,
      port: sftpConfig.port || 22,
      username: sftpConfig.user,
    };
    if (sftpConfig.privateKey) {
      connectOpts.privateKey = sftpConfig.privateKey;
      if (sftpConfig.passphrase) connectOpts.passphrase = sftpConfig.passphrase;
    } else if (sftpConfig.privateKeyPath) {
      connectOpts.privateKey = require('fs').readFileSync(sftpConfig.privateKeyPath);
      if (sftpConfig.password) connectOpts.passphrase = sftpConfig.password;
    } else {
      connectOpts.password = sftpConfig.password;
    }
    await sftp.connect(connectOpts);

    console.log(`[${label}] Auto-discovering file paths on ${sftpConfig.host}...`);
    const found = new Map();
    await _discoverFiles(sftp, '/', 0, 8, found);

    if (found.size === 0) {
      await sftp.end().catch(() => {});
      console.log(`[${label}] No game files found on server`);
      return null;
    }

    // If GameServerSettings.ini was found but no save file, try to derive save path
    // from the SaveName setting (users can rename saves from the default DedicatedSaveMP)
    if (!found.has('__save_file__') && found.has('GameServerSettings.ini')) {
      try {
        const iniBuf = await sftp.get(found.get('GameServerSettings.ini'));
        const saveName = _extractSaveName(iniBuf.toString('utf8'));
        if (saveName) {
          // Search the SaveList directory for the custom-named save
          const iniDir = found.get('GameServerSettings.ini').replace(/[/\\][^/\\]+$/, '');
          const saveDir = iniDir + '/Saved/SaveGames/SaveList/Default';
          try {
            const items = await sftp.list(saveDir);
            const saveFile = items.find((f) => f.name === `Save_${saveName}.sav`);
            if (saveFile) {
              found.set('__save_file__', `${saveDir}/${saveFile.name}`);
              console.log(`[${label}] Found custom save: Save_${saveName}.sav (from GameServerSettings.ini SaveName)`);
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
    const paths = {};
    if (found.has('HMZLog.log')) paths.logPath = found.get('HMZLog.log');
    if (found.has('PlayerConnectedLog.txt')) paths.connectLogPath = found.get('PlayerConnectedLog.txt');
    if (found.has('PlayerIDMapped.txt')) paths.idMapPath = found.get('PlayerIDMapped.txt');
    if (found.has('__save_file__')) paths.savePath = found.get('__save_file__');
    if (found.has('GameServerSettings.ini')) paths.settingsPath = found.get('GameServerSettings.ini');
    if (found.has('WelcomeMessage.txt')) paths.welcomePath = found.get('WelcomeMessage.txt');

    // If HZLogs found but no HMZLog.log (new server, only has per-restart logs),
    // derive ftpLogPath from HZLogs parent so LogWatcher can find the directory.
    if (found.has('HZLogs') && !found.has('HMZLog.log')) {
      const hzLogsDir = found.get('HZLogs');
      const parentDir = hzLogsDir.substring(0, hzLogsDir.lastIndexOf('/'));
      paths.logPath = parentDir + '/HMZLog.log'; // LogWatcher derives HZLogs/ from this parent
      console.log(`[${label}] HZLogs directory found at ${hzLogsDir} — using per-restart log files`);
    }

    const foundCount = Object.keys(paths).length;
    const fileNames = Object.values(paths).map((p) => path.basename(p));
    console.log(`[${label}] Discovered ${foundCount} file(s): ${fileNames.join(', ')}`);
    return paths;
  } catch (err) {
    console.log(`[${label}] SFTP auto-discovery failed: ${err.message}`);
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
function createServerConfig(serverDef) {
  // Prototype inherit all methods and defaults from primary config
  const merged = Object.create(_defaultConfig);

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
    if (serverDef.sftp.host) merged.ftpHost = serverDef.sftp.host;
    if (serverDef.sftp.port) merged.ftpPort = serverDef.sftp.port;
    if (serverDef.sftp.user) merged.ftpUser = serverDef.sftp.user;
    if (serverDef.sftp.password) merged.ftpPassword = serverDef.sftp.password;
    // Explicitly set privateKeyPath — if not provided, clear it so the merged
    // config doesn't inherit the primary server's SSH key via prototype chain
    merged.ftpPrivateKeyPath = serverDef.sftp.privateKeyPath || '';
  }

  // SFTP paths (falls back to primary defaults)
  if (serverDef.paths) {
    if (serverDef.paths.logPath) merged.ftpLogPath = serverDef.paths.logPath;
    if (serverDef.paths.connectLogPath) merged.ftpConnectLogPath = serverDef.paths.connectLogPath;
    if (serverDef.paths.idMapPath) merged.ftpIdMapPath = serverDef.paths.idMapPath;
    if (serverDef.paths.savePath) merged.ftpSavePath = serverDef.paths.savePath;
    if (serverDef.paths.settingsPath) merged.ftpSettingsPath = serverDef.paths.settingsPath;
    if (serverDef.paths.welcomePath) merged.ftpWelcomePath = serverDef.paths.welcomePath;
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
    merged.locale = serverDef.locale;
    merged.botLocale = serverDef.locale;
  }

  // Docker container name (for restart commands) — explicit to prevent
  // inheriting primary's container name and accidentally restarting it
  merged.dockerContainer = serverDef.dockerContainer || '';

  // Server scheduler overrides — explicitly break prototype chain so managed
  // servers don't inherit the primary server's schedule by default
  merged.restartTimes = serverDef.restartTimes || null;
  merged.restartProfiles = serverDef.restartProfiles || null;
  merged.restartProfileSettings = serverDef.restartProfileSettings || null;
  merged.enableServerScheduler = serverDef.enableServerScheduler ?? false;

  // Anticheat — per-server toggle (inherits from primary if not set)
  if (serverDef.enableAnticheat !== undefined) merged.enableAnticheat = serverDef.enableAnticheat;

  // PvP overrides — same pattern: don't inherit primary's PvP config
  merged.pvpSettingsOverrides = serverDef.pvpSettingsOverrides || null;
  merged.pvpStartMinutes = serverDef.pvpStartMinutes ?? null;
  merged.pvpEndMinutes = serverDef.pvpEndMinutes ?? null;
  merged.pvpDayHours = serverDef.pvpDayHours || null;

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
  constructor(client, serverDef, deps = {}) {
    this.client = client;
    this.id = serverDef.id;
    this.name = serverDef.name;
    this.def = serverDef;
    this.running = false;
    this._configRepo = deps.configRepo || null;

    // Per-server data directory
    this.dataDir = path.join(SERVERS_DIR, this.id);
    if (!fs.existsSync(this.dataDir)) fs.mkdirSync(this.dataDir, { recursive: true });

    // Merged config
    this.config = createServerConfig(serverDef);

    // Per-server singletons
    const label = this.name || this.id;

    // Per-server SQLite database (isolated from primary)
    this.db = new HumanitZDB({
      dbPath: path.join(this.dataDir, 'humanitz.db'),
      label: `DB:${label}`,
    });
    this.db.init();
    try {
      gameReference.seed(this.db);
    } catch (err) {
      console.warn(`[MULTI:${label}] Game reference seed failed:`, err.message);
    }

    // Per-server Panel API (if configured in server definition)
    this.panelApi = null;
    if (serverDef.panel && serverDef.panel.serverUrl && serverDef.panel.apiKey) {
      this.panelApi = createPanelApi({
        serverUrl: serverDef.panel.serverUrl,
        apiKey: serverDef.panel.apiKey,
      });
      if (this.panelApi) {
        console.log(`[MULTI:${label}] Panel API configured (Pterodactyl)`);
      }
    }

    // RCON — use WebSocket transport if Panel API is available, TCP otherwise
    if (this.panelApi) {
      this.rcon = new PanelRcon({
        panelApi: this.panelApi,
        label: `RCON:${label}`,
      });
      console.log(`[MULTI:${label}] Using WebSocket RCON (Panel API)`);
    } else {
      this.rcon = new RconManager({
        host: this.config.rconHost,
        port: this.config.rconPort,
        password: this.config.rconPassword,
        label: `RCON:${label}`,
      });
    }

    this.playerStats = new PlayerStats({
      dataDir: this.dataDir,
      db: this.db,
      playtime: null, // set after playtime is created
      label: `STATS:${label}`,
    });

    this.playtime = new PlaytimeTracker({
      dataDir: this.dataDir,
      db: this.db,
      config: this.config,
      label: `PLAYTIME:${label}`,
    });

    // Wire up cross-reference
    this.playerStats._playtime = this.playtime;
    this.playerStats.setDb(this.db);
    this.playtime.setDb(this.db);

    // Bound server-info functions using this rcon
    this.getServerInfo = () => getServerInfo(this.rcon);
    this.getPlayerList = () => getPlayerList(this.rcon);
    this.sendAdminMessage = (msg) => sendAdminMessage(msg, this.rcon);

    // Module instances (created on start)
    this._modules = {};
    this.saveService = null;
  }

  /** Whether SFTP is configured for this server. */
  get hasSftp() {
    return !!(this.config.ftpHost && this.config.ftpUser && (this.config.ftpPassword || this.config.ftpPrivateKeyPath));
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
      label: this.name || this.id,
      panelApi: this.panelApi,
      // Per-server panel API gets its own resource monitoring if available;
      // otherwise disable to prevent inheriting primary's Pterodactyl stats
      serverResources: this.panelApi ? { backend: 'pterodactyl', panelApi: this.panelApi } : { backend: null },
    };
  }

  async start() {
    if (this.running) return;
    const label = this.name || this.id;
    console.log(`[MULTI] Starting server: ${label}`);

    // ── Auto-discover SFTP paths if needed ──
    // If this server has its own SFTP but no explicit paths, discover them automatically.
    const hasOwnSftp = this.def.sftp?.host && this.def.sftp.host !== _defaultConfig.ftpHost;
    const hasExplicitPaths = this.def.paths && Object.keys(this.def.paths).length > 0;
    if (hasOwnSftp && !hasExplicitPaths) {
      console.log(`[MULTI:${label}] No file paths configured — running auto-discovery...`);
      const discovered = await discoverPaths(this.def.sftp, label);
      if (discovered) {
        // Apply discovered paths to runtime config
        if (discovered.logPath) this.config.ftpLogPath = discovered.logPath;
        if (discovered.connectLogPath) this.config.ftpConnectLogPath = discovered.connectLogPath;
        if (discovered.idMapPath) this.config.ftpIdMapPath = discovered.idMapPath;
        if (discovered.savePath) this.config.ftpSavePath = discovered.savePath;
        if (discovered.settingsPath) this.config.ftpSettingsPath = discovered.settingsPath;
        if (discovered.welcomePath) this.config.ftpWelcomePath = discovered.welcomePath;

        // Persist discovered paths so discovery only runs once
        try {
          if (this._configRepo) {
            this._configRepo.update('server:' + this.id, { paths: discovered });
            console.log(`[MULTI:${label}] Paths saved to DB`);
          } else {
            // Legacy fallback: write to servers.json
            const servers = loadServers();
            const idx = servers.findIndex((s) => s.id === this.id);
            if (idx !== -1) {
              servers[idx].paths = discovered;
              saveServers(servers);
              console.log(`[MULTI:${label}] Paths saved to servers.json`);
            }
          }
        } catch (err) {
          console.log(`[MULTI:${label}] Could not persist paths: ${err.message}`);
        }
      }
    }

    const deps = this._deps;

    // ── Save Service (needs SFTP or Panel API — populates DB with save file data) ──
    // This is independent of any Discord channel — it just parses the save and writes to DB.
    if (this.hasSftp || this.panelApi) {
      try {
        const sftpConfig = this.hasSftp ? this.config.sftpConnectConfig() : null;
        this.saveService = new SaveService(this.db, {
          sftpConfig,
          savePath: this.config.ftpSavePath,
          clanSavePath: this.config.ftpSavePath
            ? this.config.ftpSavePath.replace(/SaveList\/.*$/, 'Save_ClanData.sav')
            : null,
          pollInterval:
            typeof this.config.getEffectiveSavePollInterval === 'function'
              ? this.config.getEffectiveSavePollInterval()
              : this.config.savePollInterval || 300000,
          agentMode: this.config.agentMode || 'direct',
          agentTrigger: this.config.agentTrigger,
          agentNodePath: this.config.agentNodePath,
          agentCachePath: this.config.agentCachePath,
          panelApi: this.panelApi || null,
          dataDir: this.dataDir,
          label: `SAVE:${label}`,
        });
        this.saveService.on('sync', (result) => {
          console.log(
            `[MULTI:${label}] Save sync: ${result.playerCount} players, ${result.structureCount} structures (${result.mode}, ${result.elapsed}ms)`,
          );
        });
        this.saveService.on('error', (err) => {
          console.error(`[MULTI:${label}] Save error:`, err.message);
        });
        await this.saveService.start();
        console.log(`[MULTI:${label}] SaveService active (${this.saveService.stats?.mode || 'direct'} mode)`);
      } catch (err) {
        console.error(`[MULTI:${label}] SaveService failed:`, err.message);
        this.saveService = null;
      }
    }

    // Server Status
    if (this.config.serverStatusChannelId && this.config.rconHost) {
      try {
        const mod = new ServerStatus(this.client, deps);
        await mod.start();
        this._modules.serverStatus = mod;
        console.log(`[MULTI:${label}] ServerStatus active`);
      } catch (err) {
        console.error(`[MULTI:${label}] ServerStatus failed:`, err.message);
      }
    }

    // Log Watcher (needs SFTP — can run headless without Discord channel for DB-only data collection)
    if (this.hasSftp) {
      try {
        const mod = new LogWatcher(this.client, deps);
        if (_defaultConfig.nukeBot) mod._nukeActive = true;
        await mod.start();
        this._modules.logWatcher = mod;
        console.log(`[MULTI:${label}] LogWatcher active`);
      } catch (err) {
        console.error(`[MULTI:${label}] LogWatcher failed:`, err.message);
      }
    }

    // ── Wire LogWatcher → SaveService ID map sharing ──
    // Without this, SaveService has no player names and the DB players table stays empty.
    if (this._modules.logWatcher && this.saveService) {
      this._modules.logWatcher._onIdMapRefresh = (idMap) => this.saveService.setIdMap(idMap);
    }

    // Chat Relay (needs RCON — can run headless without Discord channel for DB-only data collection)
    if (this.config.rconHost) {
      try {
        const mod = new ChatRelay(this.client, deps);
        if (_defaultConfig.nukeBot) mod._nukeActive = true;
        // Coordinate thread ordering with LogWatcher if both are active
        if (this._modules.logWatcher) {
          mod._awaitActivityThread = true;
          this._modules.logWatcher._dayRolloverCb = async () => {
            try {
              await mod.createDailyThread();
            } catch (_) {}
          };
        }
        await mod.start();
        this._modules.chatRelay = mod;
        console.log(`[MULTI:${label}] ChatRelay active`);
      } catch (err) {
        console.error(`[MULTI:${label}] ChatRelay failed:`, err.message);
      }
    }

    // Player Stats Channel (needs SFTP or Panel File API — can run headless for save-cache.json)
    if (this.hasSftp || this.panelApi) {
      try {
        const mod = new PlayerStatsChannel(this.client, this._modules.logWatcher || null, deps);
        await mod.start();
        this._modules.playerStatsChannel = mod;
        console.log(`[MULTI:${label}] PlayerStatsChannel active`);
      } catch (err) {
        console.error(`[MULTI:${label}] PlayerStatsChannel failed:`, err.message);
      }
    }

    // Status Channels (voice channel names)
    if (this.config.guildId) {
      try {
        const categoryName = `\u{1F4CA} ${this.name || this.id}`;
        const mod = new StatusChannels(this.client, { ...deps, categoryName });
        await mod.start();
        this._modules.statusChannels = mod;
        console.log(`[MULTI:${label}] StatusChannels active`);
      } catch (err) {
        console.error(`[MULTI:${label}] StatusChannels failed:`, err.message);
      }
    }

    // Auto Messages
    if (this.config.rconHost) {
      try {
        const mod = new AutoMessages(deps);
        await mod.start();
        this._modules.autoMessages = mod;
        console.log(`[MULTI:${label}] AutoMessages active`);
      } catch (err) {
        console.error(`[MULTI:${label}] AutoMessages failed:`, err.message);
      }
    }

    // PvP Scheduler (needs SFTP + RCON)
    if (this.config.rconHost && this.hasSftp && this.config.pvpStartMinutes != null) {
      try {
        const mod = new PvpScheduler(this.client, this._modules.logWatcher || null, deps);
        await mod.start();
        this._modules.pvpScheduler = mod;
        console.log(`[MULTI:${label}] PvpScheduler active`);
      } catch (err) {
        console.error(`[MULTI:${label}] PvpScheduler failed:`, err.message);
      }
    }

    // Server Scheduler (needs SFTP + RCON + restart times)
    if (this.config.enableServerScheduler && this.config.rconHost && this.hasSftp && this.config.restartTimes) {
      try {
        const mod = new ServerScheduler(this.client, this._modules.logWatcher || null, deps);
        await mod.start();
        this._modules.serverScheduler = mod;
        console.log(`[MULTI:${label}] ServerScheduler active`);
      } catch (err) {
        console.error(`[MULTI:${label}] ServerScheduler failed:`, err.message);
      }
    }

    // Activity Log — save-file change tracking feed to daily thread or dedicated channel
    if (this.saveService && this.config.enableActivityLog !== false) {
      try {
        const mod = new ActivityLog(this.client, {
          db: this.db,
          saveService: this.saveService,
          logWatcher: this._modules.logWatcher || null,
          label: `ActivityLog:${label}`,
        });
        await mod.start();
        this._modules.activityLog = mod;
        console.log(`[MULTI:${label}] ActivityLog active`);
      } catch (err) {
        console.error(`[MULTI:${label}] ActivityLog failed:`, err.message);
      }
    }

    // Anticheat — observation-only anomaly detection (optional private package)
    if (this.config.enableAnticheat && AnticheatIntegration && this.db) {
      try {
        const mod = new AnticheatIntegration({
          db: this.db,
          config: this.config,
          logWatcher: this._modules.logWatcher || null,
        });
        await mod.start();
        if (mod.available && this.saveService) {
          this.saveService.on('sync', (result) => {
            mod.onSaveSync(result).catch((err) => {
              console.error(`[MULTI:${label}] Anticheat save sync error:`, err.message);
            });
          });
        }
        this._modules.anticheat = mod;
        console.log(`[MULTI:${label}] Anticheat ${mod.available ? 'active' : 'shim only (package not installed)'}`);
      } catch (err) {
        console.error(`[MULTI:${label}] Anticheat failed:`, err.message);
      }
    }

    this.running = true;

    // Periodic flush of active playtime sessions to DB (crash protection)
    this._playtimeFlushTimer = setInterval(() => {
      try {
        this.playtime.flushActiveSessions();
      } catch (_) {}
    }, 60000);

    console.log(`[MULTI] Server "${label}" started with ${Object.keys(this._modules).length} module(s)`);
  }

  async stop() {
    const label = this.name || this.id;
    console.log(`[MULTI] Stopping server: ${label}`);

    for (const [name, mod] of Object.entries(this._modules)) {
      try {
        if (typeof mod.stop === 'function') mod.stop();
      } catch (err) {
        console.error(`[MULTI:${label}] Error stopping ${name}:`, err.message);
      }
    }
    this._modules = {};

    // Disconnect RCON
    try {
      if (typeof this.rcon.disconnect === 'function') await this.rcon.disconnect();
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
      if (this.db) this.db.close();
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
  constructor(client, deps = {}) {
    this.client = client;
    this._instances = new Map(); // id → ServerInstance
    this._configRepo = deps.configRepo || null;
  }

  /**
   * Load server definitions: DB first, then legacy JSON fallback.
   * @returns {Array<object>} array of serverDef objects
   */
  _loadServerDefs() {
    if (this._configRepo) {
      try {
        const all = this._configRepo.loadAll();
        const defs = [];
        for (const [scope, { data }] of all) {
          if (scope.startsWith('server:') && scope !== 'server:primary' && data) {
            // Ensure id is present (scope is 'server:srv_xxx')
            if (!data.id) data.id = scope.slice(7);
            defs.push(data);
          }
        }
        if (defs.length > 0) return defs;
      } catch (err) {
        console.error('[MULTI] Failed to load servers from DB:', err.message);
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
  _persistServer(id, serverDef) {
    if (this._configRepo) {
      this._configRepo.set('server:' + id, serverDef);
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
  _removeServerDef(id) {
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

    console.log(`[MULTI] Starting ${enabled.length} additional server(s)...`);

    for (const serverDef of enabled) {
      try {
        const instance = new ServerInstance(this.client, serverDef, { configRepo: this._configRepo });
        this._instances.set(serverDef.id, instance);
        await instance.start();
      } catch (err) {
        console.error(`[MULTI] Failed to start "${serverDef.name}":`, err.message);
      }
    }
  }

  /** Stop all running instances. */
  async stopAll() {
    for (const [, instance] of this._instances) {
      try {
        await instance.stop();
      } catch (err) {
        console.error(`[MULTI] Error stopping "${instance.name}":`, err.message);
      }
    }
    this._instances.clear();
  }

  /** Add a new server definition, save it, and optionally start it. */
  async addServer(serverDef, autoStart = true) {
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
  async updateServer(id, updates) {
    const servers = this._loadServerDefs();
    const existing = servers.find((s) => s.id === id);
    if (!existing) throw new Error(`Server "${id}" not found`);

    // Deep merge updates
    if (updates.name !== undefined) existing.name = updates.name;
    if (updates.enabled !== undefined) existing.enabled = updates.enabled;
    if (updates.gamePort !== undefined) existing.gamePort = updates.gamePort;
    if (updates.rcon) existing.rcon = { ...existing.rcon, ...updates.rcon };
    if (updates.sftp) existing.sftp = { ...existing.sftp, ...updates.sftp };
    if (updates.paths !== undefined) {
      // Empty object = clear all paths (triggers auto-discovery on restart)
      existing.paths = Object.keys(updates.paths).length > 0 ? { ...existing.paths, ...updates.paths } : {};
    }
    if (updates.channels) existing.channels = { ...existing.channels, ...updates.channels };
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
  async removeServer(id) {
    // Stop if running
    const instance = this._instances.get(id);
    if (instance) {
      await instance.stop();
      this._instances.delete(id);
    }

    // Remove from config
    this._removeServerDef(id);

    // Delete server data directory
    const dataDir = path.join(SERVERS_DIR, id);
    if (fs.existsSync(dataDir)) {
      try {
        fs.rmSync(dataDir, { recursive: true, force: true });
        console.log(`[MULTI] Deleted data directory for ${id}`);
      } catch (err) {
        console.warn(`[MULTI] Could not delete data directory for ${id}:`, err.message);
      }
    }

    return true;
  }

  /** Start a specific server by ID. */
  async startServer(id) {
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
  async stopServer(id) {
    const instance = this._instances.get(id);
    if (!instance) throw new Error(`Server "${id}" not running`);
    await instance.stop();
  }

  /** Get instance by ID. */
  getInstance(id) {
    return this._instances.get(id);
  }

  /** Get all server definitions (both running and not). */
  getAllServers() {
    return loadServers();
  }

  /** Get status of all instances. */
  getStatuses() {
    const servers = loadServers();
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

module.exports = MultiServerManager;
module.exports.ServerInstance = ServerInstance;
module.exports.loadServers = loadServers;
module.exports.saveServers = saveServers;
module.exports.createServerConfig = createServerConfig;
module.exports.discoverPaths = discoverPaths;
module.exports.SERVERS_FILE = SERVERS_FILE;
module.exports._extractSaveName = _extractSaveName;
module.exports.SAVE_FILE_PATTERN = SAVE_FILE_PATTERN;

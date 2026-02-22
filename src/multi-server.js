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
const _defaultConfig = require('./config');
const { RconManager } = require('./rcon');
const { PlayerStats } = require('./player-stats');
const { PlaytimeTracker } = require('./playtime-tracker');
const { getServerInfo, getPlayerList, sendAdminMessage } = require('./server-info');

// Module classes
const ServerStatus = require('./server-status');
const StatusChannels = require('./status-channels');
const ChatRelay = require('./chat-relay');
const AutoMessages = require('./auto-messages');
const LogWatcher = require('./log-watcher');
const PlayerStatsChannel = require('./player-stats-channel');
const PvpScheduler = require('./pvp-scheduler');

const SERVERS_FILE = path.join(__dirname, '..', 'data', 'servers.json');
const SERVERS_DIR = path.join(__dirname, '..', 'data', 'servers');

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

/** Target filenames to discover on the SFTP server. */
const DISCOVERY_TARGETS = [
  'HMZLog.log',
  'PlayerConnectedLog.txt',
  'PlayerIDMapped.txt',
  'Save_DedicatedSaveMP.sav',
  'GameServerSettings.ini',
  'WelcomeMessage.txt',
];

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
  try { items = await sftp.list(dir); } catch { return; }
  for (const item of items) {
    const fullPath = dir === '/' ? `/${item.name}` : `${dir}/${item.name}`;
    if (item.type === 'd') {
      if (/^(\.|node_modules|__pycache__|Engine|Content|Binaries|linux64|steamapps)$/i.test(item.name)) continue;
      await _discoverFiles(sftp, fullPath, depth + 1, maxDepth, found);
    } else if (DISCOVERY_TARGETS.includes(item.name) && !found.has(item.name)) {
      found.set(item.name, fullPath);
    }
    if (found.size >= DISCOVERY_TARGETS.length) return;
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
  if (!sftpConfig?.host || !sftpConfig?.user || !sftpConfig?.password) return null;

  const sftp = new SftpClient();
  try {
    await sftp.connect({
      host: sftpConfig.host,
      port: sftpConfig.port || 22,
      username: sftpConfig.user,
      password: sftpConfig.password,
    });

    console.log(`[${label}] Auto-discovering file paths on ${sftpConfig.host}...`);
    const found = new Map();
    await _discoverFiles(sftp, '/', 0, 8, found);

    await sftp.end().catch(() => {});

    if (found.size === 0) {
      console.log(`[${label}] No game files found on server`);
      return null;
    }

    // Build paths object
    const paths = {};
    if (found.has('HMZLog.log'))              paths.logPath = found.get('HMZLog.log');
    if (found.has('PlayerConnectedLog.txt'))   paths.connectLogPath = found.get('PlayerConnectedLog.txt');
    if (found.has('PlayerIDMapped.txt'))        paths.idMapPath = found.get('PlayerIDMapped.txt');
    if (found.has('Save_DedicatedSaveMP.sav')) paths.savePath = found.get('Save_DedicatedSaveMP.sav');
    if (found.has('GameServerSettings.ini'))   paths.settingsPath = found.get('GameServerSettings.ini');
    if (found.has('WelcomeMessage.txt'))       paths.welcomePath = found.get('WelcomeMessage.txt');

    const foundCount = Object.keys(paths).length;
    const fileNames = Object.values(paths).map(p => path.basename(p));
    console.log(`[${label}] Discovered ${foundCount} file(s): ${fileNames.join(', ')}`);
    return paths;
  } catch (err) {
    console.log(`[${label}] SFTP auto-discovery failed: ${err.message}`);
    try { await sftp.end(); } catch {}
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

  // Server name for thread labels and logging
  merged.serverName = serverDef.name || serverDef.id || '';

  // Timezone overrides (falls back to primary's BOT_TIMEZONE / LOG_TIMEZONE)
  if (serverDef.botTimezone) merged.botTimezone = serverDef.botTimezone;
  if (serverDef.logTimezone) merged.logTimezone = serverDef.logTimezone;

  // Auto-message overrides (per-server welcome + broadcast config)
  const am = serverDef.autoMessages;
  if (am) {
    if (am.enableWelcomeMsg !== undefined)  merged.enableWelcomeMsg  = am.enableWelcomeMsg;
    if (am.enableWelcomeFile !== undefined) merged.enableWelcomeFile = am.enableWelcomeFile;
    if (am.enableAutoMsgLink !== undefined) merged.enableAutoMsgLink = am.enableAutoMsgLink;
    if (am.enableAutoMsgPromo !== undefined) merged.enableAutoMsgPromo = am.enableAutoMsgPromo;
    if (am.linkText !== undefined) merged.autoMsgLinkText = am.linkText;
    if (am.promoText !== undefined) merged.autoMsgPromoText = am.promoText;
    if (am.discordLink) merged.discordInviteLink = am.discordLink;
  }

  return merged;
}

// ═════════════════════════════════════════════════════════════
// ServerInstance — manages all modules for one extra server
// ═════════════════════════════════════════════════════════════

class ServerInstance {
  constructor(client, serverDef) {
    this.client = client;
    this.id = serverDef.id;
    this.name = serverDef.name;
    this.def = serverDef;
    this.running = false;

    // Per-server data directory
    this.dataDir = path.join(SERVERS_DIR, this.id);
    if (!fs.existsSync(this.dataDir)) fs.mkdirSync(this.dataDir, { recursive: true });

    // Merged config
    this.config = createServerConfig(serverDef);

    // Per-server singletons
    const label = this.name || this.id;
    this.rcon = new RconManager({
      host: this.config.rconHost,
      port: this.config.rconPort,
      password: this.config.rconPassword,
      label: `RCON:${label}`,
    });

    this.playerStats = new PlayerStats({
      dataDir: this.dataDir,
      playtime: null, // set after playtime is created
      label: `STATS:${label}`,
    });

    this.playtime = new PlaytimeTracker({
      dataDir: this.dataDir,
      config: this.config,
      label: `PLAYTIME:${label}`,
    });

    // Wire up cross-reference
    this.playerStats._playtime = this.playtime;

    // Bound server-info functions using this rcon
    this.getServerInfo = () => getServerInfo(this.rcon);
    this.getPlayerList = () => getPlayerList(this.rcon);
    this.sendAdminMessage = (msg) => sendAdminMessage(msg, this.rcon);

    // Module instances (created on start)
    this._modules = {};
  }

  /** Whether SFTP is configured for this server. */
  get hasSftp() {
    return !!(this.config.ftpHost && this.config.ftpUser && this.config.ftpPassword);
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
      dataDir: this.dataDir,
      serverId: this.id,
      label: this.name || this.id,
      // No panel API for additional servers — disable host resource queries
      // so they don't inherit the primary's Pterodactyl container stats
      serverResources: { backend: null },
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

        // Persist to servers.json so discovery only runs once
        try {
          const servers = loadServers();
          const idx = servers.findIndex(s => s.id === this.id);
          if (idx !== -1) {
            servers[idx].paths = discovered;
            saveServers(servers);
            console.log(`[MULTI:${label}] Paths saved to servers.json`);
          }
        } catch (err) {
          console.log(`[MULTI:${label}] Could not persist paths: ${err.message}`);
        }
      }
    }

    const deps = this._deps;

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

    // Log Watcher (needs SFTP)
    if (this.config.logChannelId && this.hasSftp) {
      try {
        const mod = new LogWatcher(this.client, deps);
        await mod.start();
        this._modules.logWatcher = mod;
        console.log(`[MULTI:${label}] LogWatcher active`);
      } catch (err) {
        console.error(`[MULTI:${label}] LogWatcher failed:`, err.message);
      }
    }

    // Chat Relay (needs RCON + chat or admin channel)
    if ((this.config.chatChannelId || this.config.adminChannelId) && this.config.rconHost) {
      try {
        const mod = new ChatRelay(this.client, deps);
        await mod.start();
        this._modules.chatRelay = mod;
        console.log(`[MULTI:${label}] ChatRelay active`);
      } catch (err) {
        console.error(`[MULTI:${label}] ChatRelay failed:`, err.message);
      }
    }

    // Player Stats Channel (needs SFTP + save file)
    if (this.config.playerStatsChannelId && this.hasSftp) {
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
        const mod = new StatusChannels(this.client, deps);
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

    this.running = true;
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
    try { this.playerStats.stop(); } catch {}
    try { this.playtime.stop(); } catch {}

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
  constructor(client) {
    this.client = client;
    this._instances = new Map(); // id → ServerInstance
  }

  /** Load configs and start all enabled servers. */
  async startAll() {
    const servers = loadServers();
    const enabled = servers.filter(s => s.enabled !== false);

    if (enabled.length === 0) {
      console.log('[MULTI] No additional servers configured');
      return;
    }

    console.log(`[MULTI] Starting ${enabled.length} additional server(s)...`);

    for (const serverDef of enabled) {
      try {
        const instance = new ServerInstance(this.client, serverDef);
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
    const servers = loadServers();

    // Assign ID if not present
    if (!serverDef.id) serverDef.id = generateId();
    serverDef.enabled = serverDef.enabled !== false;

    servers.push(serverDef);
    saveServers(servers);

    if (autoStart && serverDef.enabled) {
      const instance = new ServerInstance(this.client, serverDef);
      this._instances.set(serverDef.id, instance);
      await instance.start();
    }

    return serverDef;
  }

  /** Update an existing server definition. Restarts if running. */
  async updateServer(id, updates) {
    const servers = loadServers();
    const idx = servers.findIndex(s => s.id === id);
    if (idx === -1) throw new Error(`Server "${id}" not found`);

    // Deep merge updates
    const existing = servers[idx];
    if (updates.name !== undefined) existing.name = updates.name;
    if (updates.enabled !== undefined) existing.enabled = updates.enabled;
    if (updates.gamePort !== undefined) existing.gamePort = updates.gamePort;
    if (updates.rcon) existing.rcon = { ...existing.rcon, ...updates.rcon };
    if (updates.sftp) existing.sftp = { ...existing.sftp, ...updates.sftp };
    if (updates.paths !== undefined) {
      // Empty object = clear all paths (triggers auto-discovery on restart)
      existing.paths = Object.keys(updates.paths).length > 0
        ? { ...existing.paths, ...updates.paths }
        : {};
    }
    if (updates.channels) existing.channels = { ...existing.channels, ...updates.channels };
    if (updates.botTimezone !== undefined) existing.botTimezone = updates.botTimezone || undefined;
    if (updates.logTimezone !== undefined) existing.logTimezone = updates.logTimezone || undefined;

    saveServers(servers);

    // Restart if running
    const instance = this._instances.get(id);
    if (instance?.running) {
      await instance.stop();
      const newInstance = new ServerInstance(this.client, existing);
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
    const servers = loadServers();
    const filtered = servers.filter(s => s.id !== id);
    saveServers(filtered);

    return true;
  }

  /** Start a specific server by ID. */
  async startServer(id) {
    const servers = loadServers();
    const serverDef = servers.find(s => s.id === id);
    if (!serverDef) throw new Error(`Server "${id}" not found`);

    // Stop existing if running
    const existing = this._instances.get(id);
    if (existing?.running) await existing.stop();

    const instance = new ServerInstance(this.client, serverDef);
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
    return servers.map(s => {
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

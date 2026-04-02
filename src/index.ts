/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access,
   @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return,
   @typescript-eslint/no-explicit-any, @typescript-eslint/no-require-imports,
   @typescript-eslint/no-unsafe-argument, @typescript-eslint/restrict-template-expressions,
   @typescript-eslint/no-unnecessary-condition, @typescript-eslint/no-misused-promises, @typescript-eslint/no-floating-promises, @typescript-eslint/use-unknown-in-catch-callback-variable, @typescript-eslint/no-confusing-void-expression, @typescript-eslint/no-unnecessary-type-assertion */

import { Client, GatewayIntentBits, Collection, Events, REST, Routes, EmbedBuilder, MessageFlags } from 'discord.js';
import fs from 'node:fs';
import path from 'node:path';
import { getDirname } from './utils/paths.js';

const __dirname = getDirname(import.meta.url);

// ── Timestamped console logging ──────────────────────────────
// Patches console globally so every module gets [HH:MM:SS] prefixes
const _origLog = console.log;
const _origError = console.error;
const _origWarn = console.warn;
function _ts() {
  return new Date().toLocaleTimeString('en-GB', { hour12: false });
}
// Prepend timestamp to console output. If the first arg is a format string
// (contains %s/%d/%j/%o), merge the timestamp into it so util.format still works.
console.log = (...args: unknown[]) => {
  if (typeof args[0] === 'string') args[0] = `[${_ts()}] ${args[0]}`;
  else args.unshift(`[${_ts()}]`);
  _origLog(...args);
};
console.error = (...args: unknown[]) => {
  if (typeof args[0] === 'string') args[0] = `[${_ts()}] ${args[0]}`;
  else args.unshift(`[${_ts()}]`);
  _origError(...args);
};
console.warn = (...args: unknown[]) => {
  if (typeof args[0] === 'string') args[0] = `[${_ts()}] ${args[0]}`;
  else args.unshift(`[${_ts()}]`);
  _origWarn(...args);
};

const config: any = require('./config');
const { isAdminView } = require('./config') as { isAdminView: (member: any) => boolean };
const rcon: any = require('./rcon/rcon');
const { getServerInfo, getPlayerList, sendAdminMessage } = require('./rcon/server-info') as {
  getServerInfo: () => Promise<any>;
  getPlayerList: () => Promise<any>;
  sendAdminMessage: (...args: any[]) => Promise<any>;
};
const ChatRelay: any = require('./modules/chat-relay');
const StatusChannels: any = require('./modules/status-channels');
const ServerStatus: any = require('./modules/server-status');
const PlayerPresenceTracker: any = require('./modules/player-presence');
const AutoMessages: any = require('./modules/auto-messages');
const LogWatcher: any = require('./modules/log-watcher');
const playtime: any = require('./tracking/playtime-tracker');
const playerStats: any = require('./tracking/player-stats');
const PlayerStatsChannel: any = require('./modules/player-stats-channel');
const PvpScheduler: any = require('./modules/pvp-scheduler');
const ServerScheduler: any = require('./modules/server-scheduler');
const panelApi: any = require('./server/panel-api');

const MultiServerManager: any = require('./server/multi-server');
const { postAdminAlert } = require('./utils/admin-alert') as {
  postAdminAlert: (client: any, embed: any, opts: any) => Promise<void>;
};
const ActivityLog: any = require('./modules/activity-log');
const MilestoneTracker: any = require('./modules/milestone-tracker');
const RecapService: any = require('./modules/recap-service');
let AnticheatIntegration: any;
try {
  AnticheatIntegration = require('./modules/anticheat-integration');
} catch {
  /* optional module */
}
const HumanitZDB: any = require('./db/database');
const SaveService: any = require('./parsers/save-service');
const gameReference: any = require('./parsers/game-reference');
const { writeAgent } = require('./parsers/agent-builder') as { writeAgent: () => void };
const WebMapServer: any = require('./web-map/server');
const SnapshotService: any = require('./tracking/snapshot-service');
const StdinConsole: any = require('./stdin-console');
const { createBotStatusManager } = require('./utils/status') as {
  createBotStatusManager: (client: any, opts?: any) => any;
};
let hzmodWebPlugin: any;
try {
  hzmodWebPlugin = require('./modules/howyagarn/web-plugin');
} catch {
  /* optional module */
}
let HowyagarnManager: any;
try {
  ({ HowyagarnManager } = require('./modules/howyagarn/howyagarn-manager') as { HowyagarnManager: any });
} catch {
  /* optional module */
}
let HzmodIpcClient: any;
try {
  HzmodIpcClient = require('./modules/howyagarn/ipc-client');
} catch {
  /* optional module */
}

// ── Create Discord client ───────────────────────────────────
const intents: GatewayIntentBits[] = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages];
// Privileged intents — only request when needed (must be enabled in Developer Portal)
if (config.enableChatRelay) {
  intents.push(GatewayIntentBits.MessageContent); // needed for Discord → game chat bridge
}
if (config.adminRoleIds.length > 0) {
  intents.push(GatewayIntentBits.GuildMembers); // needed for ADMIN_ROLE_IDS resolution
}
const client = new Client({ intents });

// ── Load slash commands ─────────────────────────────────────
(client as any).commands = new Collection();
const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter((f) => f.endsWith('.js'));

for (const file of commandFiles) {
  const command: any = require(path.join(commandsPath, file));
  if (command.data && command.execute) {
    (client as any).commands.set(command.data.name, command);
    console.log(`[BOT] Loaded command: /${command.data.name}`);
  }
}

// Also load commands from subdirectories (e.g. src/commands/howyagarn/)
for (const entry of fs.readdirSync(commandsPath, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const subDir = path.join(commandsPath, entry.name);
  const subFiles = fs.readdirSync(subDir).filter((f) => f.endsWith('.js'));
  for (const file of subFiles) {
    const command: any = require(path.join(subDir, file));
    if (command.data && command.execute) {
      (client as any).commands.set(command.data.name, command);
      console.log(`[BOT] Loaded command: /${command.data.name} (${entry.name})`);
    }
  }
}

// ── Handle interactions ─────────────────────────────────────
client.on(Events.InteractionCreate, async (interaction) => {
  // ── Persistent select menu on the player-stats channel ──
  if (interaction.isStringSelectMenu() && interaction.customId.startsWith('playerstats_player_select')) {
    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    } catch (_deferErr) {
      // Interaction token expired (10062) or already acknowledged — skip silently
      console.log('[BOT] Player select interaction expired, ignoring');
      return;
    }

    const serverId = interaction.customId.split(':')[1] ?? '';
    const psc = serverId ? _findMultiServerModuleById(serverId, 'playerStatsChannel') : playerStatsChannel;
    if (!psc) {
      await interaction.editReply({ content: 'Player stats module is currently disabled.' });
      return;
    }

    const selectedId = interaction.values[0] ?? '';
    const isAdmin = isAdminView((interaction as any).member);
    const embed: any = psc.buildFullPlayerEmbed(selectedId, { isAdmin });
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  // ── Clan select menu on the player-stats channel ──
  if (interaction.isStringSelectMenu() && interaction.customId.startsWith('playerstats_clan_select')) {
    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    } catch (_deferErr) {
      // Interaction token expired (10062) or already acknowledged — skip silently
      console.log('[BOT] Clan select interaction expired, ignoring');
      return;
    }

    const serverId = interaction.customId.split(':')[1] ?? '';
    const psc = serverId ? _findMultiServerModuleById(serverId, 'playerStatsChannel') : playerStatsChannel;
    if (!psc) {
      await interaction.editReply({ content: 'Player stats module is currently disabled.' });
      return;
    }

    const clanName = (interaction.values[0] ?? '').replace(/^clan:/, '');
    const isAdmin = isAdminView((interaction as any).member);
    const embed: any = psc.buildClanEmbed(clanName, { isAdmin });
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  // ── Slash commands ──
  if (!interaction.isChatInputCommand()) return;

  const command: any = (client as any).commands.get(interaction.commandName);
  if (!command) return;

  try {
    await command.execute(interaction);
  } catch (err) {
    console.error(`[BOT] Error in /${interaction.commandName}:`, err);
    const replyOpts = {
      content: '❌ Something went wrong running that command.',
      flags: MessageFlags.Ephemeral,
    } as const;
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(replyOpts);
    } else {
      await interaction.reply(replyOpts);
    }
  }
});

// ── Bot ready ───────────────────────────────────────────────
let chatRelay: any;
let statusChannels: any;
let serverStatus: any;
let autoMessages: any;
let presenceTracker: any;
let logWatcher: any;
let playerStatsChannel: any;
let pvpScheduler: any;
let serverScheduler: any;

let multiServerManager: any;
let webMapServer: any; // Web map server instance
let hzmodPlugin: any; // Howyagarn web plugin result (for cleanup)
let db: any; // HumanitZDB instance
let configRepo: any; // ConfigRepository instance (DB-backed config)
let saveService: any; // SaveService instance
let playtimeFlushTimer: ReturnType<typeof setInterval> | undefined; // periodic playtime → DB flush
let snapshotService: any; // SnapshotService — timeline recording
let activityLog: any; // ActivityLog instance
let milestoneTracker: any; // MilestoneTracker instance
let recapService: any; // RecapService instance
let anticheatIntegration: any; // AnticheatIntegration instance
let botStatusManager: any; // Discord profile presence/status rotation
let howyagarnManager: any; // HowyagarnManager instance (MMO system)
let hzmodIpc: any; // Shared IPC client for hzmod plugin (used by manager + web plugin)
// Bot lifecycle embeds (online/offline) go to panel channel — game server status goes to activity thread
let stdinConsole: any; // interactive stdin console for headless hosts
const startedAt = new Date();

const moduleStatus: Record<string, string> = {};

function setStatus(name: string, status: string): void {
  moduleStatus[name] = status;
  if (botStatusManager) botStatusManager.refreshNow().catch(() => {});
}

function hasSftp(): boolean {
  return !!(config.sftpHost && config.sftpUser && (config.sftpPassword || config.sftpPrivateKeyPath));
}

/** Find a multi-server module by server ID (used for select menu routing). */
function _findMultiServerModuleById(serverId: string, moduleName: string): any {
  if (!multiServerManager) return null;
  const instance = multiServerManager._instances.get(serverId);
  return instance?._modules[moduleName] ?? null;
}

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`[BOT] Logged in as ${readyClient.user.tag}`);
  console.log(`[BOT] Serving guild: ${config.guildId}`);

  // Auto-sync .env with .env.example on startup
  try {
    const { needsSync, syncEnv, getVersion, getExampleVersion } = require('./env-sync') as {
      needsSync: () => boolean;
      syncEnv: () => { added: number; deprecated: number; updated: number; backupPath?: string };
      getVersion: () => string;
      getExampleVersion: () => string;
    };
    if (needsSync()) {
      const currentVersion = getVersion();
      const exampleVersion = getExampleVersion();
      console.log(`[BOT] .env schema outdated (v${currentVersion} → v${exampleVersion}), syncing...`);
      const result = syncEnv();
      console.log(
        `[BOT] .env synced: ${result.added} added, ${result.deprecated} deprecated, ${result.updated} updated`,
      );
      if (result.backupPath) {
        console.log(`[BOT] Backup saved: ${result.backupPath}`);
      }
    }
  } catch (err: any) {
    console.error('[BOT] .env auto-sync failed:', err.message);
  }

  // Auto-deploy slash commands on startup
  try {
    const rest = new REST({ version: '10' }).setToken(config.discordToken);
    const commandData = [...(client as any).commands.values()].map((c: any) => c.data.toJSON());
    await rest.put(Routes.applicationGuildCommands(config.clientId, config.guildId), { body: commandData });
    console.log(`[BOT] Registered ${commandData.length} slash commands with Discord`);
  } catch (err: any) {
    console.error('[BOT] Failed to register slash commands:', err.message);
  }

  console.log('[BOT] Ready!');

  // Initialize SQLite database + seed game reference data
  db = new HumanitZDB();
  db.init();
  gameReference.seed(db);

  // ── One-time config migration (.env + servers.json → config_documents) ──
  const ConfigRepository: any = require('./db/config-repository');
  configRepo = new ConfigRepository(db);

  if (!db.getState('config_migration_done')) {
    try {
      const { migrateEnvToDb, migrateServersJsonToDb, migrateDisplaySettings } = require('./db/config-migration') as {
        migrateEnvToDb: (env: any, repo: any) => { appKeys: number; serverKeys: number };
        migrateServersJsonToDb: (defs: any[], repo: any) => number;
        migrateDisplaySettings: (db: any, repo: any) => number;
      };

      // 1. Migrate .env values → DB (read from process.env, NOT the file —
      //    env-sync may have already commented out non-bootstrap keys)
      const envResult = migrateEnvToDb(process.env, configRepo);

      // 2. Migrate servers.json → DB (if exists)
      let serverCount = 0;
      const serversPath = path.join(__dirname, '..', 'data', 'servers.json');
      if (fs.existsSync(serversPath)) {
        try {
          const serverDefs: unknown = JSON.parse(fs.readFileSync(serversPath, 'utf8'));
          if (Array.isArray(serverDefs)) {
            serverCount = migrateServersJsonToDb(serverDefs, configRepo);
          }
        } catch (parseErr: any) {
          console.error('[BOT] CRITICAL: servers.json migration failed:', parseErr.message);
          throw parseErr; // Prevent marking migration as done
        }
      }

      // 3. Migrate display_settings → DB
      const displayCount = migrateDisplaySettings(db, configRepo);

      // Mark migration as done
      db.setState('config_migration_done', 'true');
      console.log(
        `[BOT] Config migrated to DB: ${envResult.appKeys} app, ${envResult.serverKeys} server, ${serverCount} managed servers, ${displayCount} display settings`,
      );
    } catch (err: any) {
      console.error('[BOT] Config migration failed:', err.message);
      // Non-fatal — continue with .env
    }
  }

  config.hydrate(configRepo);
  config.loadDisplayOverrides(db); // Legacy no-op — kept for backward compat

  console.log('[BOT] SQLite database initialised');

  // Initialize playtime tracker (must be before AutoMessages)
  if (config.enablePlaytime) {
    playtime.init();
  }

  // Initialize player stats tracker (must be before LogWatcher)
  playerStats.init();

  // Wire DB into singletons for unified identity + stats syncing
  playerStats.setDb(db);
  playtime.setDb(db);

  // Periodic flush of active playtime sessions to DB (crash protection)
  playtimeFlushTimer = setInterval(() => {
    try {
      playtime.flushActiveSessions();
    } catch {
      // ignore
    }
  }, 60000);

  // Connect to RCON (non-fatal — auto-reconnect handles recovery)
  if (!config.needsSetup) {
    try {
      await rcon.connect();
    } catch (err: any) {
      console.warn(`[BOT] Initial RCON connection failed: ${err.message} — will auto-reconnect`);
    }
  } else {
    console.log('[BOT] RCON not configured — skipping initial connection');
  }

  // ── RCON lifecycle events — log game server restarts ──
  rcon.on('disconnect', ({ reason }: { reason: string }) => {
    console.log(`[BOT] Game server disconnected: ${reason}`);
    if (botStatusManager) botStatusManager.refreshNow().catch(() => {});
    if (logWatcher) {
      const embed = new EmbedBuilder()
        .setDescription('🟡 Game server disconnected — RCON connection lost')
        .setColor(0xf39c12)
        .setTimestamp();
      logWatcher.sendToThread(embed).catch(() => {});
    }
  });
  rcon.on('reconnect', ({ downtime }: { downtime?: number }) => {
    const downtimeStr = downtime ? _formatUptime(downtime) : 'unknown';
    console.log(`[BOT] Game server reconnected (downtime: ${downtimeStr})`);
    if (botStatusManager) botStatusManager.refreshNow().catch(() => {});
    if (logWatcher) {
      const embed = new EmbedBuilder()
        .setDescription(`🟢 Game server reconnected (downtime: ${downtimeStr})`)
        .setColor(0x2ecc71)
        .setTimestamp();
      logWatcher.sendToThread(embed).catch(() => {});
    }
  });

  // Bot profile status (presence/activity) — rotates live players + feature highlights
  botStatusManager = createBotStatusManager(readyClient, {
    refreshMs: parseInt(process.env['BOT_PROFILE_STATUS_INTERVAL'] ?? '', 10) || 30000,
    getHasSftp: () => hasSftp(),
    getPanelAvailable: () => panelApi.available,
    getWebMapEnabled: () => !!parseInt(process.env['WEB_MAP_PORT'] ?? '', 10),
    getModuleStatus: () => moduleStatus,
  });
  botStatusManager.start();

  // Generate/update the standalone agent script so it's always fresh
  try {
    writeAgent();
  } catch (err: any) {
    console.warn('[BOT] Could not generate humanitz-agent.js:', err.message);
  }

  // ── Web panel — start EARLY so it's reachable while modules initialise ──
  const webMapPort = parseInt(process.env['WEB_MAP_PORT'] ?? '', 10);
  if (webMapPort) {
    if (!config.discordClientSecret && !process.env['WEB_PANEL_ALLOW_NO_AUTH']) {
      setStatus('WebMap', '⚠️ Requires Discord OAuth (set DISCORD_OAUTH_SECRET + WEB_MAP_CALLBACK_URL)');
      console.warn(
        '[BOT] Web panel requires Discord OAuth — set DISCORD_OAUTH_SECRET and WEB_MAP_CALLBACK_URL in .env',
      );
      console.warn('[BOT] To run without auth (dev only), set WEB_PANEL_ALLOW_NO_AUTH=true');
    } else {
      try {
        if (!config.discordClientSecret) {
          console.warn('[BOT] Web panel starting WITHOUT Discord OAuth — all routes unprotected (dev mode)');
        }
        webMapServer = new WebMapServer(readyClient, { db, configRepo });
        await webMapServer.start();
        setStatus('WebMap', `🟢 Running on http://localhost:${webMapPort}`);
        console.log(`[BOT] Web panel started: http://localhost:${webMapPort}`);
      } catch (err: any) {
        setStatus('WebMap', `⚠️ Failed to start: ${err.message}`);
        console.error('[BOT] Web panel failed to start:', err.message);
      }
    }
  } else {
    setStatus('WebMap', '⚫ Disabled (no WEB_MAP_PORT)');
    console.log('[BOT] Web panel disabled — set WEB_MAP_PORT in .env to enable');
  }

  // ── Wipe saved message IDs on FIRST_RUN ──
  //    Forces each module to re-create its embed from scratch.
  if (config.firstRun) {
    const dataDir = path.join(__dirname, '..', 'data');
    // Clear bot_state keys that hold transient/session data
    if (db) {
      const transientKeys = [
        'msg_id_server_status',
        'msg_id_player_stats',
        'msg_id_panel_bot',
        'msg_id_panel_server',
        'msg_id_panel_servers',
        'log_offsets',
        'day_counts',
        'pvp_kills',
        'welcome_stats',
        'bot_running',
      ];
      for (const key of transientKeys) {
        try {
          db.deleteState(key);
        } catch {
          // ignore
        }
      }
      console.log('[BOT] Cleared bot_state transient keys (FIRST_RUN)');
    }
    // Also clear legacy JSON files
    const msgIdFile = path.join(dataDir, 'message-ids.json');
    if (fs.existsSync(msgIdFile)) {
      fs.unlinkSync(msgIdFile);
      console.log('[BOT] Cleared message-ids.json (FIRST_RUN)');
    }
    const transientFiles = ['log-offsets.json', 'day-counts.json', 'pvp-kills.json', 'welcome-stats.json'];
    for (const f of transientFiles) {
      const fp = path.join(dataDir, f);
      if (fs.existsSync(fp)) {
        fs.unlinkSync(fp);
        console.log(`[BOT] Cleared ${f}`);
      }
    }
    // Also clear per-server message IDs and orphaned server data directories
    const serversDir = path.join(dataDir, 'servers');
    if (fs.existsSync(serversDir)) {
      const { loadServers } = require('./server/multi-server') as { loadServers: () => Array<{ id: string }> };
      const knownIds = new Set(loadServers().map((s) => s.id));
      for (const entry of fs.readdirSync(serversDir)) {
        const dir = path.join(serversDir, entry);
        const fp = path.join(dir, 'message-ids.json');
        if (fs.existsSync(fp)) {
          fs.unlinkSync(fp);
        }
        if (!knownIds.has(entry) && fs.statSync(dir).isDirectory()) {
          fs.rmSync(dir, { recursive: true, force: true });
          console.log(`[BOT] Removed orphaned server data: ${entry}`);
        } else {
          for (const f of transientFiles) {
            const sfp = path.join(dir, f);
            if (fs.existsSync(sfp)) {
              fs.unlinkSync(sfp);
            }
          }
        }
      }
    }
  }

  // ── NUKE_BOT: factory reset — wipe all bot content from Discord ──
  //    Cleans every configured channel BEFORE modules start, so all
  //    threads and embeds are recreated fresh in the correct order.
  if (config.nukeBot) {
    // Immediately clear NUKE_BOT in .env FIRST to prevent infinite nuke loops
    // if anything crashes during the wipe/rebuild process.
    try {
      const envPath = path.join(__dirname, '..', '.env');
      let envContent = fs.readFileSync(envPath, 'utf8');
      envContent = envContent.replace(/^NUKE_BOT\s*=\s*true$/m, 'NUKE_BOT=false');
      envContent = envContent.replace(/^NUKE_THREADS\s*=\s*true$/m, 'NUKE_THREADS=false');
      envContent = envContent.replace(/^FIRST_RUN\s*=\s*true$/m, 'FIRST_RUN=false');
      fs.writeFileSync(envPath, envContent, 'utf8');
      console.log('[NUKE] NUKE_BOT set to false in .env (prevents repeat nuke on crash)');
    } catch (err: any) {
      console.warn('[NUKE] Could not update .env:', err.message);
    }

    console.log('[NUKE] Wiping all bot content from Discord channels...');
    const channelsToClean = new Set<string>();
    // Primary server channels
    if (config.logChannelId) channelsToClean.add(config.logChannelId);
    if (config.adminChannelId) channelsToClean.add(config.adminChannelId);
    if (config.chatChannelId) channelsToClean.add(config.chatChannelId);
    if (config.serverStatusChannelId) channelsToClean.add(config.serverStatusChannelId);
    if (config.playerStatsChannelId) channelsToClean.add(config.playerStatsChannelId);

    if (config.activityLogChannelId) channelsToClean.add(config.activityLogChannelId);
    // Additional server channels (including any from removed servers still in servers.json)
    const { loadServers } = require('./server/multi-server') as {
      loadServers: () => Array<{ channels?: Record<string, string | undefined> }>;
    };
    const servers = loadServers();
    for (const sd of servers) {
      if (sd.channels?.['log']) channelsToClean.add(sd.channels['log']);
      if (sd.channels?.['chat']) channelsToClean.add(sd.channels['chat']);
      if (sd.channels?.['admin']) channelsToClean.add(sd.channels['admin']);
      if (sd.channels?.['status']) channelsToClean.add(sd.channels['status']);
      if (sd.channels?.['stats']) channelsToClean.add(sd.channels['stats']);
      if (sd.channels?.['panel']) channelsToClean.add(sd.channels['panel']);
    }

    const botId = readyClient.user?.id;
    for (const channelId of channelsToClean) {
      await _nukeChannel(readyClient, channelId, botId);
    }
    console.log(`[NUKE] Cleaned ${channelsToClean.size} channel(s)`);
  }

  // ── Start modules with dependency checks ──────────────────

  // Status Channels — voice channel dashboard
  if (config.enableStatusChannels) {
    const categoryHint = config.serverName ?? '';
    statusChannels = new StatusChannels(readyClient, { categoryName: categoryHint });
    await statusChannels.start();
    setStatus('Status Channels', '🟢 Active');
  } else {
    setStatus('Status Channels', '⚫ Disabled');
    console.log('[BOT] Status channels disabled via ENABLE_STATUS_CHANNELS=false');
  }

  // Server Status — live embed in a text channel
  if (config.enableServerStatus) {
    if (!config.serverStatusChannelId) {
      setStatus('Server Status', '🟡 Skipped (SERVER_STATUS_CHANNEL_ID not set)');
      console.log('[BOT] Server status skipped — SERVER_STATUS_CHANNEL_ID not configured');
    } else {
      serverStatus = new ServerStatus(readyClient, { db });
      await serverStatus.start();
      setStatus('Server Status', '🟢 Active');
    }
  } else {
    setStatus('Server Status', '⚫ Disabled');
    console.log('[BOT] Server status embed disabled via ENABLE_SERVER_STATUS=false');
  }

  // Log Watcher — SFTP log parsing + daily activity threads
  // Started BEFORE Chat Relay so activity thread appears first in channel
  if (config.enableLogWatcher) {
    if (!hasSftp()) {
      setStatus('Log Watcher', '🟡 Skipped (SFTP credentials not set)');
      console.log('[BOT] Log watcher skipped — SFTP_HOST/SFTP_USER/SFTP_PASSWORD not configured');
    } else if (!config.logChannelId) {
      setStatus('Log Watcher', '🟡 Skipped (LOG_CHANNEL_ID not set)');
      console.log('[BOT] Log watcher skipped — LOG_CHANNEL_ID not configured');
    } else {
      logWatcher = new LogWatcher(readyClient, {
        db,
        dataDir: path.resolve(__dirname, '..'),
        panelApi: panelApi.available ? panelApi : null,
      });
      await logWatcher.start();
      setStatus('Log Watcher', '🟢 Active');
    }
  } else {
    setStatus('Log Watcher', '⚫ Disabled');
    console.log('[BOT] Log watcher disabled via ENABLE_LOG_WATCHER=false');
  }

  // Chat Relay — bidirectional chat bridge
  if (config.enableChatRelay) {
    if (!config.adminChannelId && !config.chatChannelId) {
      setStatus('Chat Relay', '🟡 Skipped (CHAT_CHANNEL_ID / ADMIN_CHANNEL_ID not set)');
      console.log('[BOT] Chat relay skipped — neither CHAT_CHANNEL_ID nor ADMIN_CHANNEL_ID configured');
    } else {
      chatRelay = new ChatRelay(readyClient, { db });
      if (config.nukeBot) chatRelay._nukeActive = true;
      // If LogWatcher handles activity threads, coordinate day-rollover ordering
      if (logWatcher) {
        chatRelay._awaitActivityThread = true;
        logWatcher._dayRolloverCb = async () => {
          try {
            await chatRelay.createDailyThread();
          } catch (e: any) {
            console.warn('[BOT] Day-rollover chat thread error:', e.message);
          }
        };
      }
      await chatRelay.start();
      setStatus('Chat Relay', '🟢 Active');
    }
  } else {
    setStatus('Chat Relay', '⚫ Disabled');
    console.log('[BOT] Chat relay disabled via ENABLE_CHAT_RELAY=false');
  }

  // Player Presence Tracker — infrastructure (always-on: peak/unique stats, join/leave events)
  presenceTracker = new PlayerPresenceTracker({
    config,
    playtime,
    getPlayerList,
    label: 'PRESENCE',
  });
  try {
    await presenceTracker.start();
  } catch (err: any) {
    console.error('[PRESENCE] Failed to start player presence tracker:', err.message);
  }

  // Auto-Messages — periodic broadcasts + join welcome
  const hasAnyAutoMsg = config.enableAutoMsgLink || config.enableAutoMsgPromo || config.enableWelcomeMsg;
  if (hasAnyAutoMsg) {
    autoMessages = new AutoMessages({
      config,
      presenceTracker,
      playtime,
      playerStats,
      getServerInfo,
      sendAdminMessage,
      db,
      label: 'AUTO MSG',
    });
    await autoMessages.start();
    setStatus('Auto-Messages', '🟢 Active');
  } else {
    setStatus('Auto-Messages', '⚫ Disabled');
    console.log('[AUTO MSG] All message features disabled — skipping');
  }

  // Kill Feed — sub-feature of Log Watcher
  if (config.enableKillFeed) {
    if (!logWatcher) {
      setStatus('Kill Feed', '🟡 Skipped (requires Log Watcher)');
    } else {
      setStatus('Kill Feed', '🟢 Active');
    }
  } else {
    setStatus('Kill Feed', '⚫ Disabled');
  }

  // PvP Kill Feed — sub-feature of Log Watcher
  if (config.enablePvpKillFeed) {
    if (!logWatcher) {
      setStatus('PvP Kill Feed', '🟡 Skipped (requires Log Watcher)');
    } else {
      setStatus('PvP Kill Feed', '🟢 Active');
    }
  } else {
    setStatus('PvP Kill Feed', '⚫ Disabled');
  }

  // Save Service — save-file polling → SQLite sync (SFTP, Panel API, or agent)
  if (hasSftp() || panelApi.available) {
    saveService = new SaveService(db, {
      sftpConfig: hasSftp() ? config.sftpConnectConfig() : null,
      savePath: config.sftpSavePath,
      clanSavePath: config.sftpSavePath.replace(/SaveList\/.*$/, 'Save_ClanData.sav'),
      pollInterval: config.savePollInterval,
      agentMode: config.agentMode,
      agentNodePath: config.agentNodePath,
      agentRemoteDir: config.agentRemoteDir,
      agentCachePath: config.agentCachePath,
      agentTimeout: config.agentTimeout,
      agentTrigger: config.agentTrigger,
      agentPanelCommand: config.agentPanelCommand,
      agentPanelDelay: config.agentPanelDelay,
      panelApi: panelApi.available ? panelApi : null,
    });
    saveService.on('sync', (result: any) => {
      console.log(
        `[BOT] Save sync: ${result.playerCount} players, ${result.structureCount} structures (${result.mode}, ${result.elapsed}ms)`,
      );
      // save-cache.json is now written inside SaveService._syncParsedData()
    });
    saveService.on('error', (err: any) => {
      console.error('[BOT] Save service error:', err.message);
    });
    await saveService.start();
    if (webMapServer) webMapServer.setSaveService(saveService);
    const saveSource = hasSftp() ? '' : ' via Panel API';
    setStatus('Save Service', `🟢 Active (${saveService.stats.mode} mode${saveSource})`);

    // Wire LogWatcher → SaveService ID map sharing
    if (logWatcher) {
      logWatcher._onIdMapRefresh = (idMap: any) => saveService.setIdMap(idMap);
    }

    // ── Snapshot Service — timeline recording on every save sync ──
    snapshotService = new SnapshotService(db, {
      retentionDays: parseInt(process.env['TIMELINE_RETENTION_DAYS'] ?? '', 10) || 14,
      trackStructures: process.env['TIMELINE_TRACK_STRUCTURES'] !== 'false',
      trackHouses: process.env['TIMELINE_TRACK_HOUSES'] !== 'false',
      trackBackpacks: process.env['TIMELINE_TRACK_BACKPACKS'] !== 'false',
    });
    saveService.on('sync', async (result: any) => {
      if (!result.parsed) return;
      try {
        // Build online player set from RCON if available
        const onlinePlayers = new Set<string>();
        try {
          const { getPlayerList: _getPlayerList } = require('./rcon/server-info') as {
            getPlayerList: () => Promise<any>;
          };
          const list: any = await _getPlayerList();
          const arr: any[] = list?.players ?? (Array.isArray(list) ? list : []);
          for (const p of arr) {
            if (p.name) onlinePlayers.add(String(p.name).toLowerCase());
          }
        } catch {
          /* RCON unavailable — online player set will be empty for this snapshot */
        }

        snapshotService.recordSnapshot(
          {
            players: result.parsed.players,
            worldState: result.worldState,
            vehicles: result.parsed.vehicles,
            structures: result.parsed.structures,
            containers: result.parsed.containers,
            companions: result.parsed.companions,
            horses: result.parsed.horses,
          },
          { onlinePlayers },
        );
      } catch (err: any) {
        console.error('[BOT] Snapshot recording error:', err.message);
      }
    });
    setStatus('Timeline', '🟢 Active');
  } else {
    setStatus('Save Service', '🟡 Skipped (no SFTP credentials or Panel API)');
    setStatus('Timeline', '🟡 Skipped (requires Save Service)');
  }

  // Activity Log — save-file change tracking feed
  if (config.enableActivityLog) {
    if (!saveService) {
      setStatus('Activity Log', '🟡 Skipped (requires Save Service)');
    } else {
      activityLog = new ActivityLog(readyClient, { db, saveService, logWatcher });
      await activityLog.start();
      setStatus('Activity Log', '🟢 Active');
    }
  } else {
    setStatus('Activity Log', '⚫ Disabled');
  }

  // Milestone Tracker — player achievement announcements
  if (config.enableMilestones) {
    if (!db) {
      setStatus('Milestones', '🟡 Skipped (no database)');
    } else {
      milestoneTracker = new MilestoneTracker(readyClient, { db, logWatcher, config });
      // Check milestones on every save sync
      if (saveService) {
        saveService.on('sync', (result: any) => {
          milestoneTracker.check(result).catch((err: any) => {
            console.error('[BOT] Milestone check error:', err.message);
          });
        });
      }
      // Wire death events from LogWatcher to reset survival streaks
      if (logWatcher) {
        const origOnDeath = logWatcher._onDeath.bind(logWatcher);
        logWatcher._onDeath = function (playerName: string, timestamp: string) {
          origOnDeath(playerName, timestamp);
          const steamId = playerStats.getSteamId(playerName);
          if (steamId) milestoneTracker.onPlayerDeath(steamId);
        };
      }
      setStatus('Milestones', '🟢 Active');
    }
  } else {
    setStatus('Milestones', '⚫ Disabled');
    console.log('[BOT] Milestones disabled via ENABLE_MILESTONES=false');
  }

  // Recap Service — daily/weekly summary embeds
  if (config.enableRecaps) {
    if (!db) {
      setStatus('Recaps', '🟡 Skipped (no database)');
    } else {
      recapService = new RecapService(readyClient, { db, logWatcher, config, playtime });
      // Chain into LogWatcher day-rollover callback
      if (logWatcher) {
        const prevCb: (() => Promise<void>) | undefined = logWatcher._dayRolloverCb;
        logWatcher._dayRolloverCb = async () => {
          if (typeof prevCb === 'function') await prevCb();
          const yesterday: string = recapService._getYesterday();
          await recapService.onDayRollover(yesterday);
        };
      }
      setStatus('Recaps', '🟢 Active');
    }
  } else {
    setStatus('Recaps', '⚫ Disabled');
    console.log('[BOT] Recaps disabled via ENABLE_RECAPS=false');
  }

  // Anticheat — observation-only anomaly detection (optional private package)
  if (config.enableAnticheat && AnticheatIntegration) {
    if (!db) {
      setStatus('Anticheat', '🟡 Skipped (no database)');
    } else {
      anticheatIntegration = new AnticheatIntegration({ db, config, logWatcher });
      await anticheatIntegration.start();
      if (anticheatIntegration.available) {
        // Wire into save sync for real-time analysis
        if (saveService) {
          saveService.on('sync', (result: any) => {
            anticheatIntegration.onSaveSync(result).catch((err: any) => {
              console.error('[BOT] Anticheat save sync error:', err.message);
            });
          });
        }
        setStatus('Anticheat', '🟢 Active');
      } else {
        setStatus('Anticheat', '🟡 Package not installed');
      }
    }
  } else {
    setStatus('Anticheat', '⚫ Disabled');
  }

  // HOWYAGARN MMO — faction PvP / territory control system
  if (config.enableHowyagarn) {
    if (!HowyagarnManager) {
      setStatus('HOWYAGARN', '🟡 Skipped (module not installed)');
    } else if (!db) {
      setStatus('HOWYAGARN', '🟡 Skipped (no database)');
    } else {
      try {
        // Create shared IPC client for engine communication
        if (HzmodIpcClient && config.hzmodSocketPath) {
          hzmodIpc = new HzmodIpcClient(config.hzmodSocketPath);
          hzmodIpc.on('connect', () => console.log('[BOT] hzmod IPC connected'));
          hzmodIpc.on('disconnect', () => console.log('[BOT] hzmod IPC disconnected — will reconnect'));
          hzmodIpc.on('error', (err: any) => console.error('[BOT] hzmod IPC error:', err.message));
          hzmodIpc.connect();
          console.log(`[BOT] hzmod IPC client connecting to ${config.hzmodSocketPath}`);
        }

        howyagarnManager = new HowyagarnManager({
          db,
          client: readyClient,
          rcon,
          chatRelay,
          config,
          ipc: hzmodIpc ?? null,
        });
        howyagarnManager.init();

        // Expose on client so slash commands can access it via interaction.client._howyagarnManager
        (readyClient as any)._howyagarnManager = howyagarnManager;

        // Wire save-sync events
        if (saveService) {
          saveService.on('sync', (result: any) => {
            try {
              if (!result.parsed) return;
              const players: any[] = [];
              const playerMap: Map<string, any> =
                result.parsed.players instanceof Map
                  ? result.parsed.players
                  : new Map(Object.entries(result.parsed.players ?? {}));
              for (const [steamId, pData] of playerMap) {
                players.push({
                  steamId,
                  name: pData.name ?? pData.playerName ?? '',
                  x: pData.posX ?? pData.x ?? 0,
                  y: pData.posY ?? pData.y ?? 0,
                  deltaZeeksKilled: pData.deltaZeeksKilled ?? 0,
                  deltaNpcKills: pData.deltaNpcKills ?? 0,
                  deltaAnimalKills: pData.deltaAnimalKills ?? 0,
                  deltaFishCaught: pData.deltaFishCaught ?? 0,
                  deltaDaysSurvived: pData.deltaDaysSurvived ?? 0,
                });
              }
              const structures: any[] = Array.isArray(result.parsed.structures) ? result.parsed.structures : [];
              howyagarnManager.onSaveSync({ players, structures });
            } catch (err: any) {
              console.error('[BOT] HOWYAGARN save sync error:', err.message);
            }
          });
        }

        // Wire log events (PvP deaths, builds, looting)
        if (logWatcher) {
          const origLogEvent = logWatcher._logEvent?.bind(logWatcher);
          if (origLogEvent) {
            logWatcher._logEvent = function (type: string, data: any) {
              origLogEvent(type, data);
              try {
                howyagarnManager.onLogEvent(type, data);
              } catch (err: any) {
                console.error('[BOT] howyagarnManager.onLogEvent error:', err.message);
              }
            };
          }
          // Wire connect events
          const origOnConnect = logWatcher._onPlayerConnect?.bind(logWatcher);
          if (origOnConnect) {
            logWatcher._onPlayerConnect = function (playerName: string, steamId: string) {
              origOnConnect(playerName, steamId);
              try {
                howyagarnManager.onPlayerConnect(steamId, playerName);
              } catch (err: any) {
                console.error('[BOT] howyagarnManager.onPlayerConnect error:', err.message);
              }
            };
          }
        }

        setStatus('HOWYAGARN', '🟢 Active');
        console.log('[BOT] HOWYAGARN MMO system active');
      } catch (err: any) {
        setStatus('HOWYAGARN', `⚠️ Failed: ${err.message}`);
        console.error('[BOT] HOWYAGARN init failed:', err.message);
      }
    }
  } else {
    setStatus('HOWYAGARN', '⚫ Disabled');
  }

  // Player Stats — DB-first reads (SaveService populates DB, PSC reads it)
  if (config.enablePlayerStats) {
    if (!hasSftp() && !panelApi.available && !db) {
      setStatus('Player Stats', '🟡 Skipped (no SFTP, Panel API, or database)');
      console.log('[BOT] Player stats skipped — no SFTP, Panel API, or database available');
    } else if (!config.playerStatsChannelId) {
      setStatus('Player Stats', '🟡 Skipped (PLAYER_STATS_CHANNEL_ID not set)');
      console.log('[BOT] Player stats skipped — PLAYER_STATS_CHANNEL_ID not configured');
    } else {
      playerStatsChannel = new PlayerStatsChannel(readyClient, logWatcher, {
        db,
        panelApi: panelApi.available ? panelApi : null,
      });
      await playerStatsChannel.start();
      const mode = db ? 'DB-first' : 'SFTP legacy';
      setStatus('Player Stats', `🟢 Active (${mode})`);
      if (!logWatcher) {
        setStatus('Player Stats', `🟢 Active (${mode}, kill/survival feed unavailable — Log Watcher off)`);
      }
    }
  } else {
    setStatus('Player Stats', '⚫ Disabled');
    console.log('[BOT] Player stats disabled via ENABLE_PLAYER_STATS=false');
  }

  // PvP Scheduler — SFTP-based PvP toggling on a schedule
  if (config.enablePvpScheduler) {
    if (!hasSftp()) {
      setStatus('PvP Scheduler', '🟡 Skipped (SFTP credentials not set)');
      console.log('[BOT] PvP scheduler skipped — SFTP_HOST/SFTP_USER/SFTP_PASSWORD not configured');
    } else if (isNaN(config.pvpStartMinutes) || isNaN(config.pvpEndMinutes)) {
      setStatus('PvP Scheduler', '🟡 Skipped (PVP_START_TIME/PVP_END_TIME not set)');
      console.log('[BOT] PvP scheduler skipped — PVP_START_TIME/PVP_END_TIME not configured');
    } else {
      pvpScheduler = new PvpScheduler(readyClient, logWatcher);
      await pvpScheduler.start();
      setStatus('PvP Scheduler', '🟢 Active');
      if (!logWatcher) {
        setStatus('PvP Scheduler', '🟢 Active (activity log announcements unavailable — Log Watcher off)');
      }
    }
  } else {
    setStatus('PvP Scheduler', '⚫ Disabled');
    console.log('[BOT] PvP scheduler disabled via ENABLE_PVP_SCHEDULER=false');
  }

  // Server Scheduler — timed restarts with dynamic difficulty profiles
  if (config.enableServerScheduler) {
    if (!hasSftp()) {
      setStatus('Server Scheduler', '🟡 Skipped (SFTP credentials not set)');
      console.log('[BOT] Server scheduler skipped — SFTP_HOST/SFTP_USER/SFTP_PASSWORD not configured');
    } else {
      serverScheduler = new ServerScheduler(readyClient, logWatcher);
      await serverScheduler.start();
      if (webMapServer) webMapServer.setScheduler(serverScheduler);
      const status = serverScheduler.getStatus();
      const profileInfo = status.profiles.length > 1 ? ` (${status.profiles.join(' → ')})` : '';
      setStatus('Server Scheduler', `🟢 Active — ${status.restartTimes.join(', ')}${profileInfo}`);
    }
  } else {
    setStatus('Server Scheduler', '⚫ Disabled');
    console.log('[BOT] Server scheduler disabled via ENABLE_SERVER_SCHEDULER=false');
  }

  // ── Multi-server manager (independent of Panel) ──────────
  multiServerManager = new MultiServerManager(readyClient, { configRepo });
  await multiServerManager.startAll();
  if (webMapServer) {
    webMapServer.setMultiServerManager(multiServerManager);
    // Register hzmod web plugin now that multiServerManager is available
    if (hzmodWebPlugin) {
      try {
        hzmodPlugin = hzmodWebPlugin.register(webMapServer, config, { ipc: hzmodIpc ?? null });
        // Pass HowyagarnManager to web plugin for MMO API endpoints
        if (howyagarnManager) hzmodWebPlugin.setManager(howyagarnManager);
      } catch (err: any) {
        console.error('[BOT] hzmod plugin registration failed:', err.message);
      }
    }
  }

  // ── BotControlService (used by both Panel and Web) ───────
  const BotControlService: any = require('./server/bot-control');
  const botControl = new BotControlService({ exit: (code: number) => process.exit(code) });
  if (webMapServer) webMapServer.setBotControl(botControl);
  if (webMapServer) webMapServer.setModuleStatus(moduleStatus);

  // ── Panel API status (/qspanel command) ─────────────────────
  if (panelApi.available) {
    setStatus('Panel', '🟢 Active (/qspanel command)');
    console.log('[BOT] Panel API available — /qspanel command active');
  } else {
    setStatus('Panel', '🟡 Skipped (no PANEL_SERVER_URL/PANEL_API_KEY)');
  }

  // ── Stdin console (for headless hosts like Bisect) ──────────
  if (config.enableStdinConsole) {
    stdinConsole = new StdinConsole({ db, writable: config.stdinConsoleWritable });
    stdinConsole.start();
    setStatus('Console', '🟢 Active (stdin)');
    console.log(`[BOT] Stdin console active${config.stdinConsoleWritable ? ' (writable)' : ' (read-only)'}`);
  }

  // ── Write running flag + clean old lifecycle embeds + post online notification ──
  try {
    if (db) {
      try {
        db.setStateJSON('bot_running', { startedAt: startedAt.toISOString() });
      } catch {
        // ignore
      }
    }

    // Clean previous lifecycle embeds from admin alert channels
    let alertIds: string[] = config.adminAlertChannelIds;
    if (typeof alertIds === 'string') {
      alertIds = (alertIds as string)
        .split(',')
        .map((s: string) => s.trim())
        .filter(Boolean);
    }
    if (!alertIds?.length) alertIds = config.adminChannelId ? [config.adminChannelId] : [];
    for (const chId of alertIds) {
      try {
        const ch: any = await readyClient.channels.fetch(chId);
        if (!ch) continue;
        const messages: any = await ch.messages.fetch({ limit: 30 });
        const botId = readyClient.user?.id;
        const toDelete: any = messages.filter(
          (m: any) =>
            m.author.id === botId &&
            m.embeds.length > 0 &&
            m.embeds.some((e: any) => e.title === '🔴 Bot Offline' || e.title === '🟢 Bot Online'),
        );
        if (toDelete.size > 0) {
          try {
            await ch.bulkDelete(toDelete, true);
          } catch {
            for (const msg of toDelete.values()) {
              await (msg as any).delete().catch(() => {});
            }
          }
        }
      } catch (cleanErr: any) {
        console.warn(`[BOT] Could not clean lifecycle embeds in ${chId}:`, cleanErr.message);
      }
    }

    const onlineEmbed = new EmbedBuilder()
      .setTitle('🟢 Bot Online')
      .setDescription(`Started at ${startedAt.toISOString()}`)
      .setColor(0x2ecc71)
      .setTimestamp();
    await postAdminAlert(readyClient, onlineEmbed, {
      adminAlertChannelIds: config.adminAlertChannelIds,
      fallbackChannelId: config.adminChannelId,
    });
  } catch (err: any) {
    console.error('[BOT] Failed to post online notification:', err.message);
  }

  // ── NUKE_BOT phase 2: rebuild activity threads from log history ──
  if (config.nukeBot) {
    console.log('[NUKE] Rebuilding activity threads from log history...');
    try {
      const { rebuildThreads } = require('./commands/threads') as {
        rebuildThreads: (client: any, a?: any, b?: any) => Promise<any>;
      };
      // Primary server
      const result: any = await rebuildThreads(readyClient);
      if (result.error) {
        console.error('[NUKE] Thread rebuild failed:', result.error);
      } else {
        console.log(
          `[NUKE] Thread rebuild: ${result.created} created, ${result.deleted} replaced, ${result.preserved} preserved, ${result.cleaned} cleaned`,
        );
      }
      // Additional servers
      const { loadServers: _loadServers, createServerConfig } = require('./server/multi-server') as {
        loadServers: () => any[];
        createServerConfig: (def: any) => any;
      };
      const additionalServers: any[] = _loadServers();
      for (const serverDef of additionalServers) {
        const label: string = serverDef.name ?? serverDef.id;
        if (!serverDef.channels?.log) {
          console.log('[NUKE] Skipping %s thread rebuild (no log channel)', label);
          continue;
        }
        const serverConfig: any = createServerConfig(serverDef);
        console.log('[NUKE] Rebuilding threads for %s...', label);
        const srvResult: any = await rebuildThreads(readyClient, null, serverConfig);
        if (srvResult.error) {
          console.error('[NUKE] Thread rebuild for %s failed:', label, srvResult.error);
        } else {
          console.log(
            `[NUKE] ${label}: ${srvResult.created} created, ${srvResult.deleted} replaced, ${srvResult.preserved} preserved, ${srvResult.cleaned} cleaned`,
          );
        }
      }
    } catch (err: any) {
      console.error('[NUKE] Thread rebuild error:', err.message);
    }

    // Reset thread caches so modules pick up the newly rebuilt threads
    // Clear nuke suppression first so thread creation works normally again
    if (logWatcher) {
      logWatcher._nukeActive = false;
      logWatcher.resetThreadCache();
      // Send the startup notification that was deferred during nuke
      const thread: any = await logWatcher._getOrCreateDailyThread();
      const startEmbed = new EmbedBuilder()
        .setDescription('Log watcher connected. Monitoring game server activity.')
        .setColor(0x3498db)
        .setTimestamp();
      await thread.send({ embeds: [startEmbed] }).catch(() => {});
      console.log('[NUKE] LogWatcher thread cache reset');
    }
    if (chatRelay && typeof chatRelay.resetThreadCache === 'function') {
      chatRelay._nukeActive = false;
      chatRelay.resetThreadCache();
      // Re-create chat thread so it appears after rebuilt activity threads
      if (typeof chatRelay._getOrCreateChatThread === 'function') {
        await chatRelay
          ._getOrCreateChatThread()
          .catch((e: any) => console.warn('[NUKE] Could not re-create chat thread:', e.message));
      }
      console.log('[NUKE] ChatRelay thread cache reset + recreated');
    }
    if (multiServerManager) {
      for (const [, instance] of multiServerManager._instances) {
        if (instance._modules?.logWatcher) {
          instance._modules.logWatcher._nukeActive = false;
          instance._modules.logWatcher.resetThreadCache();
          console.log(`[NUKE] ${instance.name ?? instance.id} LogWatcher thread cache reset`);
        }
        if (instance._modules?.chatRelay && typeof instance._modules.chatRelay.resetThreadCache === 'function') {
          instance._modules.chatRelay._nukeActive = false;
          instance._modules.chatRelay.resetThreadCache();
          if (typeof instance._modules.chatRelay._getOrCreateChatThread === 'function') {
            await instance._modules.chatRelay._getOrCreateChatThread().catch(() => {});
          }
          console.log(`[NUKE] ${instance.name ?? instance.id} ChatRelay thread cache reset + recreated`);
        }
      }
    }

    // NUKE_BOT was already set to false at the start of the nuke process
    console.log('[NUKE] Factory reset complete!');
  }

  // Auto-set FIRST_RUN=false after successful startup
  if (config.firstRun && !config.nukeBot) {
    try {
      const envPath = path.join(__dirname, '..', '.env');
      let envContent = fs.readFileSync(envPath, 'utf8');
      envContent = envContent.replace(/^FIRST_RUN\s*=\s*true$/m, 'FIRST_RUN=false');
      fs.writeFileSync(envPath, envContent, 'utf8');
      console.log('[BOT] FIRST_RUN set back to false in .env');
    } catch {
      console.warn('[BOT] Could not update .env — please manually set FIRST_RUN=false');
    }
  }

  console.log('[BOT] Ready!');
});

// ── Lifecycle embed cleanup ─────────────────────────────────

// ── Graceful shutdown ───────────────────────────────────────
let shuttingDown = false;
async function shutdown(reason = 'Manual shutdown'): Promise<void> {
  if (shuttingDown) return; // prevent double-shutdown
  shuttingDown = true;
  console.log('\n[BOT] Shutting down...');

  // Stop all modules FIRST (some need DB for final persist)
  if (chatRelay) chatRelay.stop();
  if (statusChannels) statusChannels.stop();
  if (serverStatus) serverStatus.stop();
  if (autoMessages) autoMessages.stop();
  if (presenceTracker) presenceTracker.stop();
  if (pvpScheduler) pvpScheduler.stop();
  if (serverScheduler) serverScheduler.stop();
  if (webMapServer) webMapServer.stop();
  if (hzmodPlugin?.ipcClient) hzmodPlugin.ipcClient.destroy();
  if (hzmodIpc) hzmodIpc.destroy();
  if (logWatcher) logWatcher.stop();
  if (playerStatsChannel) playerStatsChannel.stop();
  if (activityLog) activityLog.stop();
  if (anticheatIntegration) await anticheatIntegration.stop();
  if (howyagarnManager) howyagarnManager.shutdown();
  if (saveService) saveService.stop();
  if (multiServerManager) await multiServerManager.stopAll();
  if (stdinConsole) stdinConsole.stop();
  if (botStatusManager) botStatusManager.stop();
  playerStats.stop();
  if (playtimeFlushTimer) clearInterval(playtimeFlushTimer);
  playtime.stop();

  // Close DB immediately after modules stop — before any async work.
  // node --watch sends SIGTERM and may spawn a new process quickly;
  // closing DB here ensures WAL is checkpointed before the new process opens it.
  if (db) {
    try {
      db.deleteState('bot_running');
    } catch (err: any) {
      console.warn('[BOT] Could not clear bot_running flag:', err.message);
    }
    db.close();
  }

  // Post offline notification to admin alert channels (best-effort; DB is already closed above)
  try {
    const uptime = _formatUptime(Date.now() - startedAt.getTime());
    const activeCount = Object.values(moduleStatus).filter((s) => s.startsWith('🟢')).length;
    const totalCount = Object.keys(moduleStatus).length;

    const embed = new EmbedBuilder()
      .setTitle('🔴 Bot Offline')
      .setDescription(reason)
      .addFields(
        { name: 'Uptime', value: uptime, inline: true },
        { name: 'Modules', value: `${activeCount}/${totalCount} active`, inline: true },
      )
      .setColor(0xe74c3c)
      .setTimestamp();

    await Promise.race([
      postAdminAlert(client, embed, {
        adminAlertChannelIds: config.adminAlertChannelIds,
        fallbackChannelId: config.adminChannelId,
      }),
      new Promise<void>((resolve) => setTimeout(resolve, 5000)),
    ]);
  } catch (err: any) {
    console.error('[BOT] Failed to post offline notification:', err.message);
  }

  await rcon.disconnect();
  client.destroy();
  process.exit(0);
}

function _formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  parts.push(`${mins}m`);
  return parts.join(' ');
}

process.on('SIGINT', () => {
  void shutdown('SIGINT received');
});
process.on('SIGTERM', () => {
  void shutdown('SIGTERM received');
});
process.on('uncaughtException', (err: any) => {
  console.error('[BOT] Uncaught exception:', err);

  // Discord API errors that are safe to ignore (don't crash)
  const recoverableCodes = [
    10062, // Unknown interaction (expired token — user clicked stale button/menu)
    10008, // Unknown Message (message was deleted)
    40060, // Interaction already acknowledged
  ];
  if (err.code && recoverableCodes.includes(err.code)) {
    console.log(`[BOT] Recoverable Discord error ${err.code} — continuing`);
    return; // do NOT crash
  }

  // Post to admin channel before shutting down
  _postErrorEmbed('Uncaught Exception', err).finally(() => {
    shutdown(`Uncaught exception: ${err.message}`).catch(() => process.exit(1));
  });
});
process.on('unhandledRejection', (reason) => {
  console.error('[BOT] Unhandled rejection:', reason);
  void _postErrorEmbed('Unhandled Rejection', reason);
  // Log but don't crash — unhandled rejections are often recoverable
});

/**
 * Post a hard-error embed to admin alert channels for visibility.
 * Silently ignores failures (client may not be ready yet).
 */
async function _postErrorEmbed(title: string, err: unknown): Promise<void> {
  if (!client?.isReady()) return;
  try {
    const raw = err instanceof Error ? (err.stack?.slice(0, 1000) ?? err.message) : String(err).slice(0, 1000);
    const embed = new EmbedBuilder()
      .setTitle(`\uD83D\uDD25 ${title}`)
      .setDescription(`\`\`\`\n${raw}\n\`\`\``)
      .setColor(0xff0000)
      .setTimestamp();
    await postAdminAlert(client, embed, {
      adminAlertChannelIds: config.adminAlertChannelIds,
      fallbackChannelId: config.adminChannelId,
    });
  } catch (embedErr: any) {
    console.warn('[BOT] Failed to post error embed:', embedErr.message);
  }
}

// ── Login ───────────────────────────────────────────────────

/**
 * Delete all bot-authored threads and messages from a channel.
 * Used by NUKE_BOT to factory-reset Discord state before modules start.
 */
async function _nukeChannel(discordClient: any, channelId: string, botId: string | undefined): Promise<void> {
  try {
    const ch: any = await discordClient.channels.fetch(channelId).catch(() => null);
    if (!ch) return;

    // Handle bot-authored threads (active + archived)
    // Delete ALL bot threads for a clean slate during nuke.
    if (ch.threads) {
      const active: any = await ch.threads.fetchActive().catch(() => ({ threads: new Map() }));
      const archived: any = await ch.threads.fetchArchived({ limit: 100 }).catch(() => ({ threads: new Map() }));
      const allThreads: any[] = [...active.threads.values(), ...archived.threads.values()];
      for (const thread of allThreads) {
        if (thread.ownerId !== botId) continue;
        await thread.delete('NUKE_BOT factory reset').catch(() => {});
        console.log(`[NUKE] Deleted thread "${thread.name}" from #${ch.name ?? channelId}`);
      }
    }

    // Delete bot-authored messages (scan up to 1000)
    let lastId: string | undefined;
    let deleted = 0;
    for (let page = 0; page < 10; page++) {
      const opts: any = { limit: 100 };
      if (lastId) opts.before = lastId;
      const batch: any = await ch.messages?.fetch(opts).catch(() => new Map());
      if (!batch || batch.size === 0) break;
      lastId = batch.last().id;
      for (const [, msg] of batch) {
        if ((msg as any).author?.id !== botId) continue;
        await (msg as any).delete().catch(() => {});
        deleted++;
      }
      if (batch.size < 100) break;
    }
    if (deleted > 0) console.log(`[NUKE] Deleted ${deleted} message(s) from #${ch.name ?? channelId}`);
  } catch (err: any) {
    console.warn(`[NUKE] Could not clean channel ${channelId}:`, err.message);
  }
}

void (async () => {
  // NUKE_BOT implies FIRST_RUN — wipe local data files first, then re-import
  // Log raw .env value for debugging — track unexpected NUKE_BOT=true
  const _nukeAuditMsg = `[${new Date().toISOString()}] STARTUP: NUKE_BOT=${process.env['NUKE_BOT']}, config.nukeBot=${config.nukeBot}, NUKE_THREADS=${process.env['NUKE_THREADS']}\n`;
  console.log(
    '[NUKE-AUDIT] process.env.NUKE_BOT=%s, config.nukeBot=%s, process.env.NUKE_THREADS=%s',
    process.env['NUKE_BOT'],
    config.nukeBot,
    process.env['NUKE_THREADS'],
  );
  try {
    fs.appendFileSync(path.join(__dirname, '..', 'data', 'nuke-audit.log'), _nukeAuditMsg);
  } catch {
    // ignore
  }
  if (config.nukeBot) {
    console.log('[NUKE] NUKE_BOT=true — factory reset starting...');
    const dataDir = path.join(__dirname, '..', 'data');
    // Wipe all transient data files (preserves map-calibration.json)
    const filesToWipe = [
      'message-ids.json',
      'player-stats.json',
      'playtime.json',
      'welcome-stats.json',
      'server-settings.json',
      'log-offsets.json',
      'day-counts.json',
      'pvp-kills.json',
      'humanitz.db',
      'humanitz.db-wal',
      'humanitz.db-shm',
      'kill-tracker.json',
      'player-locations.json',
      'map-image.png',
      'save-cache.json',
      'weekly-baseline.json',
    ];
    for (const f of filesToWipe) {
      const fp = path.join(dataDir, f);
      if (fs.existsSync(fp)) {
        fs.unlinkSync(fp);
        console.log(`[NUKE] Deleted ${f}`);
      }
    }
    // Wipe per-server data directories
    const serversDir = path.join(dataDir, 'servers');
    if (fs.existsSync(serversDir)) {
      fs.rmSync(serversDir, { recursive: true, force: true });
      console.log('[NUKE] Deleted servers/ directory');
    }
    // Wipe removed-server configs (servers.json)
    const serversJson = path.join(dataDir, 'servers.json');
    if (fs.existsSync(serversJson)) {
      fs.unlinkSync(serversJson);
      console.log('[NUKE] Deleted servers.json');
    }
  }

  // Run setup/import if FIRST_RUN=true or NUKE_BOT=true
  if (config.firstRun || config.nukeBot) {
    console.log(`[BOT] ${config.nukeBot ? 'NUKE_BOT' : 'FIRST_RUN'}=true — running data import...`);
    const setupPath = path.join(__dirname, '..', 'setup.js');
    try {
      fs.accessSync(setupPath);
    } catch {
      console.error(`[BOT] setup.js not found at: ${setupPath}`);
      console.error('[BOT] Upload setup.js to the root of your bot folder (next to package.json).');
      console.error('[BOT] Continuing with existing data files...');
    }
    try {
      const { main: runSetup } = require(setupPath) as { main: () => Promise<void> };
      await runSetup();
      console.log('[BOT] Data import complete.');
    } catch (err: any) {
      console.error('[BOT] Setup failed:', err.message);
      console.error('[BOT] Continuing with existing/empty data files...');
    }
  }
  client.login(config.discordToken).catch((err: any) => {
    if (/disallowed intents/i.test(err.message) || err.code === 4014) {
      const requested: string[] = [];
      if (config.enableChatRelay) requested.push('Message Content (ENABLE_CHAT_RELAY=true)');
      if (config.adminRoleIds.length > 0) requested.push('Server Members (ADMIN_ROLE_IDS set)');
      console.error('');
      console.error('══════════════════════════════════════════════════════════');
      console.error('  Discord rejected the bot — "disallowed intents"');
      console.error('');
      console.error('  Your bot is requesting privileged intents that must be');
      console.error('  enabled in the Discord Developer Portal:');
      console.error('    https://discord.com/developers/applications');
      console.error('');
      console.error('  Go to: Your Application → Bot → Privileged Gateway Intents');
      if (requested.length > 0) {
        console.error('  Enable:');
        requested.forEach((r) => {
          console.error('    ✦ ' + r);
        });
      } else {
        console.error('  Enable: Message Content Intent');
      }
      console.error('');
      console.error('  Or disable the feature that needs it:');
      console.error('    • Set ENABLE_CHAT_RELAY=false in .env to skip Message Content');
      console.error('    • Remove ADMIN_ROLE_IDS from .env to skip Server Members');
      console.error('══════════════════════════════════════════════════════════');
      console.error('');
    } else {
      console.error('[BOT] Login failed:', err.message);
    }
    process.exit(1);
  });
})();

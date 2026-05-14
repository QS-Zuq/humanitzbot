import { Client, GatewayIntentBits, Collection, Events, REST, Routes, EmbedBuilder, MessageFlags } from 'discord.js';
import type { ChatInputCommandInteraction, GuildMember, TextBasedChannel, ThreadChannel } from 'discord.js';
import type { BotStatusManager } from './utils/status.js';
import fs from 'node:fs';
import path from 'node:path';
import { getDirname } from './utils/paths.js';

const __dirname = getDirname(import.meta.url);

// ── Structured logging system ──────────────────────────────
// Initializes the global logger with console (human-readable) + file (JSON) transports.
// All modules using createLogger() automatically write to both outputs.
import { initLogger, shutdownLogger } from './logger/logger.js';
import { createLogger } from './utils/log.js';
import { errMsg } from './utils/error.js';
initLogger();

import config from './config/index.js';
import { isAdminView as _isAdminViewRaw } from './config/index.js';
import rcon from './rcon/rcon.js';
import { getServerInfo, getPlayerList, sendAdminMessage } from './rcon/server-info.js';
import ChatRelay from './modules/chat-relay.js';
import StatusChannels from './modules/status-channels.js';
import ServerStatus from './modules/server-status.js';
import PlayerPresenceTracker from './modules/player-presence.js';
import AutoMessages from './modules/auto-messages.js';
import LogWatcher, { type LogEventEntry } from './modules/log-watcher.js';
import playtime from './tracking/playtime-tracker.js';
import playerStats from './tracking/player-stats.js';
import PlayerStatsChannel from './modules/player-stats-channel.js';
import PvpScheduler from './modules/pvp-scheduler.js';
import ServerScheduler from './modules/server-scheduler.js';
import panelApi from './server/panel-api.js';
import MultiServerManager from './server/multi-server.js';
import { postAdminAlert } from './utils/admin-alert.js';
import ActivityLog from './modules/activity-log.js';
import MilestoneTracker from './modules/milestone-tracker.js';
import RecapService from './modules/recap-service.js';
import HumanitZDB from './db/database.js';
import SaveService from './parsers/save-service.js';
import { seed as seedGameReference } from './parsers/game-reference.js';
import { writeAgent } from './parsers/agent-builder.js';
import WebMapServer from './web-map/server.js';
import { planWebPanelStartup } from './web-map/startup-plan.js';
import SnapshotService from './tracking/snapshot-service.js';
import StdinConsole from './stdin-console.js';
import { createBotStatusManager } from './utils/status.js';
import { needsSync, syncEnv, getVersion, getExampleVersion } from './env-sync.js';
import ConfigRepository from './db/config-repository.js';
import { migrateEnvToDb, migrateServersJsonToDb, migrateDisplaySettings } from './db/config-migration.js';
import { loadServers, createServerConfig } from './server/multi-server.js';
import BotControlService from './server/bot-control.js';
import { rebuildThreads } from './commands/threads.js';
import {
  backupCriticalBotStateKeys,
  backupFirstRunKeys,
  cleanupBackupKeys,
  FIRST_RUN_TRANSIENT_KEYS,
} from './db/bot-state-backup.js';
import { attachBotStateListeners } from './state/bot-state-listeners.js';

// Convenience wrapper: isAdminView has 2-arg signature (permissions[], member).
function isAdminView(member: GuildMember | null): boolean {
  return _isAdminViewRaw(config.adminViewPermissions, member);
}

// ── Interfaces for dynamically loaded commands ────────────
interface SlashCommand {
  data: { name: string; toJSON: () => unknown };
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
}

// ── Interfaces for optional modules ───────────────────────
interface AnticheatInstance {
  start: () => Promise<void>;
  stop: () => Promise<void> | void;
  available: boolean;
  onSaveSync: (result: SaveSyncResult) => Promise<void>;
}

interface HowyagarnManagerInstance {
  init: () => void;
  shutdown: () => void;
  onSaveSync: (data: { players: HowyagarnPlayer[]; structures: unknown[] }) => void;
  onLogEvent: (type: string, data: unknown) => void;
  onPlayerConnect: (steamId: string, playerName: string) => void;
}

interface HowyagarnPlayer {
  steamId: string;
  name: string;
  x: number;
  y: number;
  deltaZeeksKilled: number;
  deltaNpcKills: number;
  deltaAnimalKills: number;
  deltaFishCaught: number;
  deltaDaysSurvived: number;
}

interface HzmodWebPluginModule {
  register: (
    server: WebMapServer,
    cfg: typeof config,
    opts: { ipc: IpcClientInstance | null },
  ) => { ipcClient?: { destroy: () => void } };
  setManager: (manager: HowyagarnManagerInstance) => void;
}

interface IpcClientInstance {
  connect: () => void;
  destroy: () => void;
  on: (event: string, handler: (...args: unknown[]) => void) => void;
}

// ── Server definition (from loadServers() / multi-server.ts) ──
interface ServerDef {
  id: string;
  name?: string;
  channels?: Record<string, string | undefined>;
  enabled?: boolean;
  [key: string]: unknown;
}

// ── Save sync result (emitted by SaveService 'sync' event) ──
interface SaveSyncResult {
  playerCount: number;
  structureCount: number;
  vehicleCount: number;
  companionCount: number;
  clanCount: number;
  horseCount: number;
  containerCount: number;
  activityEvents: number;
  itemTracking: Record<string, unknown>;
  worldState: unknown;
  elapsed: number;
  steamIds: string[];
  mode: string;
  diffEvents: unknown[];
  syncTime: Date;
  parsed: Record<string, unknown> & {
    players: Map<string, Record<string, unknown>> | Record<string, Record<string, unknown>>;
    structures: unknown[];
    vehicles: unknown[];
    companions: unknown[];
    horses: unknown[];
    containers: unknown[];
  };
}

// ── Optional modules (may not be installed) ────────────────
// Loaded asynchronously in loadOptionalModules() before client.login()

let AnticheatIntegration:
  | (new (opts: {
      db: HumanitZDB;
      config: typeof config;
      logWatcher: InstanceType<typeof LogWatcher> | undefined;
    }) => AnticheatInstance)
  | undefined;
let hzmodWebPlugin: HzmodWebPluginModule | undefined;
let HowyagarnManager: (new (opts: Record<string, unknown>) => HowyagarnManagerInstance) | undefined;
let HzmodIpcClient: (new (socketPath: string) => IpcClientInstance) | undefined;

async function loadOptionalModules(): Promise<void> {
  try {
    AnticheatIntegration = (
      (await import('./modules/anticheat-integration.js')) as unknown as { default: typeof AnticheatIntegration }
    ).default; // SAFETY: optional private module dynamic import
  } catch {
    /* optional module */
  }
  // howyagarn/* modules are optional private packages — path via variable bypasses static TSC resolution
  const _webPluginPath = './modules/howyagarn/web-plugin.js';
  const _managerPath = './modules/howyagarn/howyagarn-manager.js';
  const _ipcClientPath = './modules/howyagarn/ipc-client.js';
  try {
    hzmodWebPlugin = ((await import(/* @vite-ignore */ _webPluginPath)) as { default: HzmodWebPluginModule }).default;
  } catch {
    /* optional module */
  }
  try {
    ({ HowyagarnManager } = (await import(/* @vite-ignore */ _managerPath)) as {
      HowyagarnManager: typeof HowyagarnManager;
    });
  } catch {
    /* optional module */
  }
  try {
    HzmodIpcClient = ((await import(/* @vite-ignore */ _ipcClientPath)) as { default: typeof HzmodIpcClient }).default;
  } catch {
    /* optional module */
  }
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
const slashCommands = new Collection<string, SlashCommand>();

async function loadCommands(): Promise<void> {
  const commandsPath = path.join(__dirname, 'commands');
  const commandFiles = fs.readdirSync(commandsPath).filter((f) => f.endsWith('.js'));

  for (const file of commandFiles) {
    const command = (await import(path.join(commandsPath, file))) as Partial<SlashCommand> & {
      default?: Partial<SlashCommand>;
    };
    const cmd = command.default ?? command;
    if (cmd.data && cmd.execute) {
      slashCommands.set(cmd.data.name, cmd as SlashCommand);
      console.log(`[BOT] Loaded command: /${cmd.data.name}`);
    }
  }

  // Also load commands from subdirectories (e.g. src/commands/howyagarn/)
  for (const entry of fs.readdirSync(commandsPath, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const subDir = path.join(commandsPath, entry.name);
    const subFiles = fs.readdirSync(subDir).filter((f) => f.endsWith('.js'));
    for (const file of subFiles) {
      const command = (await import(path.join(subDir, file))) as Partial<SlashCommand> & {
        default?: Partial<SlashCommand>;
      };
      const cmd = command.default ?? command;
      if (cmd.data && cmd.execute) {
        slashCommands.set(cmd.data.name, cmd as SlashCommand);
        console.log(`[BOT] Loaded command: /${cmd.data.name} (${entry.name})`);
      }
    }
  }
}

// ── Handle interactions ─────────────────────────────────────
client.on(Events.InteractionCreate, (interaction) => {
  void (async () => {
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
      const psc = serverId ? _findMultiServerPlayerStatsChannelById(serverId) : playerStatsChannel;
      if (!psc) {
        await interaction.editReply({ content: 'Player stats module is currently disabled.' });
        return;
      }

      const selectedId = interaction.values[0] ?? '';
      const isAdmin = isAdminView(interaction.member as GuildMember | null);

      const embed: EmbedBuilder = (
        psc as unknown as { buildFullPlayerEmbed: (id: string, opts: { isAdmin: boolean }) => EmbedBuilder }
      ) // SAFETY: buildFullPlayerEmbed injected via mixin at runtime
        .buildFullPlayerEmbed(selectedId, { isAdmin });
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
      const psc = serverId ? _findMultiServerPlayerStatsChannelById(serverId) : playerStatsChannel;
      if (!psc) {
        await interaction.editReply({ content: 'Player stats module is currently disabled.' });
        return;
      }

      const clanName = (interaction.values[0] ?? '').replace(/^clan:/, '');
      const isAdmin = isAdminView(interaction.member as GuildMember | null);

      const embed: EmbedBuilder = (
        psc as unknown as { buildClanEmbed: (name: string, opts: { isAdmin: boolean }) => EmbedBuilder }
      ) // SAFETY: buildClanEmbed injected via mixin at runtime
        .buildClanEmbed(clanName, { isAdmin });
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    // ── Slash commands ──
    if (!interaction.isChatInputCommand()) return;

    const command = slashCommands.get(interaction.commandName);
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
  })();
});

// ── Bot ready ───────────────────────────────────────────────
let chatRelay: InstanceType<typeof ChatRelay> | undefined;
let statusChannels: InstanceType<typeof StatusChannels> | undefined;
let serverStatus: InstanceType<typeof ServerStatus> | undefined;
let autoMessages: InstanceType<typeof AutoMessages> | undefined;
let presenceTracker: InstanceType<typeof PlayerPresenceTracker> | undefined;
let logWatcher: InstanceType<typeof LogWatcher> | undefined;
let playerStatsChannel: InstanceType<typeof PlayerStatsChannel> | undefined;
let pvpScheduler: InstanceType<typeof PvpScheduler> | undefined;
let serverScheduler: InstanceType<typeof ServerScheduler> | undefined;

let multiServerManager: InstanceType<typeof MultiServerManager> | undefined;
let webMapServer: InstanceType<typeof WebMapServer> | undefined;

let hzmodPlugin: { ipcClient?: { destroy: () => void } } | undefined; // Howyagarn web plugin result
let db: InstanceType<typeof HumanitZDB> | undefined;
let configRepo: InstanceType<typeof ConfigRepository> | undefined;
let saveService: InstanceType<typeof SaveService> | undefined;
let playtimeFlushTimer: ReturnType<typeof setInterval> | undefined; // periodic playtime → DB flush
let snapshotService: InstanceType<typeof SnapshotService> | undefined;
let activityLog: InstanceType<typeof ActivityLog> | undefined;
let milestoneTracker: InstanceType<typeof MilestoneTracker> | undefined;
let recapService: InstanceType<typeof RecapService> | undefined;

let anticheatIntegration: AnticheatInstance | undefined;

let botStatusManager: BotStatusManager | undefined;

let howyagarnManager: HowyagarnManagerInstance | undefined;

let hzmodIpc: IpcClientInstance | undefined;
// Bot lifecycle embeds (online/offline) go to panel channel — game server status goes to activity thread
let stdinConsole: InstanceType<typeof StdinConsole> | undefined;
const startedAt = new Date();

const moduleStatus: Record<string, string> = {};

function setStatus(name: string, status: string): void {
  moduleStatus[name] = status;
  if (botStatusManager) botStatusManager.refreshNow().catch(() => {});
}

function hasSftp(): boolean {
  return !!(config.sftpHost && config.sftpUser && (config.sftpPassword || config.sftpPrivateKeyPath));
}

/** Find a multi-server PlayerStatsChannel by server ID (used for select menu routing). */
function _findMultiServerPlayerStatsChannelById(serverId: string): InstanceType<typeof PlayerStatsChannel> | null {
  if (!multiServerManager) return null;
  const instance = multiServerManager.getInstance(serverId);
  if (!instance) return null;
  return instance.getPlayerStatsChannel();
}

client.once(Events.ClientReady, (readyClient) => {
  void (async () => {
    console.log(`[BOT] Logged in as ${readyClient.user.tag}`);
    console.log(`[BOT] Serving guild: ${config.guildId}`);

    // Auto-sync .env with .env.example on startup
    try {
      if (needsSync()) {
        const currentVersion = getVersion();
        const exampleVersion = getExampleVersion();
        console.log(`[BOT] .env schema outdated (v${currentVersion} → v${exampleVersion}), syncing...`);
        const result = syncEnv() as ReturnType<typeof syncEnv> & { backupPath?: string };
        console.log(
          `[BOT] .env synced: ${result.added} added, ${result.deprecated} deprecated, ${result.updated} updated`,
        );
        if (result.backupPath) {
          console.log(`[BOT] Backup saved: ${result.backupPath}`);
        }
      }
    } catch (err: unknown) {
      console.error('[BOT] .env auto-sync failed:', errMsg(err));
    }

    // Auto-deploy slash commands on startup
    try {
      const rest = new REST({ version: '10' }).setToken(config.discordToken ?? '');
      const commandData = [...slashCommands.values()].map((c) => c.data.toJSON());
      await rest.put(Routes.applicationGuildCommands(config.clientId ?? '', config.guildId ?? ''), {
        body: commandData,
      });
      console.log(`[BOT] Registered ${commandData.length} slash commands with Discord`);
    } catch (err: unknown) {
      console.error('[BOT] Failed to register slash commands:', errMsg(err));
    }

    console.log('[BOT] Ready!');

    // Initialize SQLite database + seed game reference data
    db = new HumanitZDB();
    db.init();
    // db.init() guarantees db.db is non-null, but the type includes null
    seedGameReference(db);

    // Stage 6: attach bot_state event listeners (before any bot_state reads)
    attachBotStateListeners(createLogger('bot-state'), db);

    // Stage 4: TTL cleanup — remove backup rows older than 7 days
    cleanupBackupKeys(db);

    // ── One-time config migration (.env + servers.json → config_documents) ──
    configRepo = new ConfigRepository(db);

    if (!db.botState.getState('config_migration_done')) {
      try {
        // 1. Migrate .env values → DB (read from process.env, NOT the file —
        //    env-sync may have already commented out non-bootstrap keys)
        const envResult = migrateEnvToDb(process.env as Record<string, string>, configRepo);

        // 2. Migrate servers.json → DB (if exists)
        let serverCount = 0;
        const serversPath = path.join(__dirname, '..', 'data', 'servers.json');
        if (fs.existsSync(serversPath)) {
          try {
            const serverDefs: unknown = JSON.parse(fs.readFileSync(serversPath, 'utf8'));
            if (Array.isArray(serverDefs)) {
              serverCount = migrateServersJsonToDb(serverDefs as Array<Record<string, unknown>>, configRepo);
            }
          } catch (parseErr: unknown) {
            console.error('[BOT] CRITICAL: servers.json migration failed:', errMsg(parseErr));
            throw parseErr; // Prevent marking migration as done
          }
        }

        // 3. Migrate display_settings → DB
        const displayCount = migrateDisplaySettings(db, configRepo);

        // Mark migration as done
        db.botState.setState('config_migration_done', 'true');
        console.log(
          `[BOT] Config migrated to DB: ${envResult.appKeys} app, ${envResult.serverKeys} server, ${serverCount} managed servers, ${displayCount} display settings`,
        );
      } catch (err: unknown) {
        console.error('[BOT] Config migration failed:', errMsg(err));
        // Non-fatal — continue with .env
      }
    }

    // Stage 2b: canary backup — one-shot idempotent, before any schema validation
    backupCriticalBotStateKeys(db);

    config.hydrate(configRepo);
    config.loadDisplayOverrides(db); // Legacy no-op — kept for backward compat
    panelApi.invalidateConfig();

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
      } catch (err: unknown) {
        console.warn(`[BOT] Initial RCON connection failed: ${errMsg(err)} — will auto-reconnect`);
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
    } catch (err: unknown) {
      console.warn('[BOT] Could not generate humanitz-agent.js:', errMsg(err));
    }

    // ── Web panel — start EARLY so it's reachable while modules initialise ──
    const webPanelPlan = planWebPanelStartup(process.env, config);
    if (webPanelPlan.action === 'disabled') {
      setStatus('WebMap', '⚫ Disabled (no WEB_MAP_PORT)');
      console.log('[BOT] Web panel disabled — set WEB_MAP_PORT in .env to enable');
    } else {
      const { port, mode } = webPanelPlan;
      try {
        if (mode === 'landingOnly') {
          console.log('[BOT] Web panel starting without OAuth — landing page only (login disabled)');
          console.log('[BOT] Set DISCORD_OAUTH_SECRET + WEB_MAP_CALLBACK_URL in .env to enable login');
        }
        // Assign the module-level variable only after start() succeeds, so a failed
        // start doesn't leave a half-initialised server reachable to shutdown handlers.
        const server = new WebMapServer(readyClient, { db, configRepo });
        await server.start();
        webMapServer = server;
        const suffix = mode === 'oauth' ? '' : ' (no auth)';
        setStatus('WebMap', `🟢 Running on http://localhost:${port}${suffix}`);
        console.log(`[BOT] Web panel started: http://localhost:${port}`);
      } catch (err: unknown) {
        setStatus('WebMap', `⚠️ Failed to start: ${errMsg(err)}`);
        console.error('[BOT] Web panel failed to start:', errMsg(err));
      }
    }

    // ── Wipe saved message IDs on FIRST_RUN ──
    //    Forces each module to re-create its embed from scratch.
    if (config.firstRun) {
      const dataDir = path.join(__dirname, '..', 'data');
      // Clear bot_state keys that hold transient/session data (db is guaranteed set above)
      {
        // PR2: central contract lives in bot-state-backup.ts so tests can assert
        // that FIRST_RUN clears kill_tracker / weekly_baseline / recap_service
        // but does not clear self-seeding github_tracker or backfilled milestones.
        const transientKeys = FIRST_RUN_TRANSIENT_KEYS;
        // Stage 4: backup transient keys before deletion (idempotent)
        backupFirstRunKeys(db, transientKeys);
        for (const key of transientKeys) {
          try {
            db.botState.deleteState(key);
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
        const knownIds = new Set(loadServers().map((s: { id: string }) => s.id));
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
      } catch (err: unknown) {
        console.warn('[NUKE] Could not update .env:', errMsg(err));
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
      const servers = loadServers() as Array<{ channels?: Record<string, string | undefined> }>;
      for (const sd of servers) {
        if (sd.channels?.['log']) channelsToClean.add(sd.channels['log']);
        if (sd.channels?.['chat']) channelsToClean.add(sd.channels['chat']);
        if (sd.channels?.['admin']) channelsToClean.add(sd.channels['admin']);
        if (sd.channels?.['status']) channelsToClean.add(sd.channels['status']);
        if (sd.channels?.['stats']) channelsToClean.add(sd.channels['stats']);
        if (sd.channels?.['panel']) channelsToClean.add(sd.channels['panel']);
      }

      const botId = readyClient.user.id;
      for (const channelId of channelsToClean) {
        await _nukeChannel(readyClient, channelId, botId);
      }
      console.log(`[NUKE] Cleaned ${channelsToClean.size} channel(s)`);
    }

    // ── Start modules with dependency checks ──────────────────

    // Status Channels — voice channel dashboard
    if (config.enableStatusChannels) {
      const categoryHint = config.serverName;
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
        const _chatRelay = chatRelay;
        if (config.nukeBot) _chatRelay.setNukeActive(true);
        // If LogWatcher handles activity threads, coordinate day-rollover ordering
        if (logWatcher) {
          _chatRelay.setAwaitActivityThread(true);
          logWatcher.setDayRolloverCallback(async () => {
            try {
              await _chatRelay.createDailyThread();
            } catch (e: unknown) {
              console.warn('[BOT] Day-rollover chat thread error:', errMsg(e));
            }
          });
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
    } catch (err: unknown) {
      console.error('[PRESENCE] Failed to start player presence tracker:', errMsg(err));
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
      // Note: start() is synchronous; if it ever returns Promise, callers must await
      autoMessages.start();
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
        sftpConfig: hasSftp() ? config.sftpConnectConfig() : undefined,
        savePath: config.sftpSavePath,
        clanSavePath: config.sftpSavePath.replace(/SaveList\/.*$/, 'Save_ClanData.sav'),
        pollInterval: config.savePollInterval,
        agentMode: config.agentMode as 'agent' | 'auto' | 'direct' | undefined,
        agentNodePath: config.agentNodePath,
        agentRemoteDir: config.agentRemoteDir,
        agentCachePath: config.agentCachePath,
        agentTimeout: config.agentTimeout,
        agentTrigger: config.agentTrigger as 'auto' | 'ssh' | 'rcon' | 'panel' | 'none' | undefined,
        agentPanelCommand: config.agentPanelCommand,
        agentPanelDelay: config.agentPanelDelay,

        panelApi: panelApi.available ? panelApi : undefined,
      });
      saveService.on('sync', (result: SaveSyncResult) => {
        console.log(
          `[BOT] Save sync: ${result.playerCount} players, ${result.structureCount} structures (${result.mode}, ${result.elapsed}ms)`,
        );
        // save-cache.json is now written inside SaveService._syncParsedData()
      });
      saveService.on('error', (err: unknown) => {
        console.error('[BOT] Save service error:', errMsg(err));
      });
      await saveService.start();
      if (webMapServer) webMapServer.setSaveService(saveService);
      const saveSource = hasSftp() ? '' : ' via Panel API';

      setStatus('Save Service', `🟢 Active (${saveService.getSyncMode()} mode${saveSource})`);

      // Wire LogWatcher → SaveService ID map sharing
      if (logWatcher) {
        const _svc = saveService;

        logWatcher.setIdMapRefreshCallback((idMap) => {
          _svc.setIdMap(idMap);
        });
      }

      // ── Snapshot Service — timeline recording on every save sync ──
      snapshotService = new SnapshotService(db, {
        retentionDays: parseInt(process.env['TIMELINE_RETENTION_DAYS'] ?? '', 10) || 14,
        trackStructures: process.env['TIMELINE_TRACK_STRUCTURES'] !== 'false',
        trackHouses: process.env['TIMELINE_TRACK_HOUSES'] !== 'false',
        trackBackpacks: process.env['TIMELINE_TRACK_BACKPACKS'] !== 'false',
      });
      saveService.on('sync', (result: SaveSyncResult) => {
        void (async () => {
          if (!(result.parsed as unknown)) return;
          try {
            // Build online player set from RCON if available
            const onlinePlayers = new Set<string>();
            try {
              const list = await getPlayerList();
              // getPlayerList returns loosely typed data — defensive runtime access
              const raw = list as unknown as Record<string, unknown>; // SAFETY: getPlayerList returns loosely typed data
              const arr: unknown[] = Array.isArray(raw.players)
                ? raw.players
                : Array.isArray(list)
                  ? (list as unknown[])
                  : [];
              for (const p of arr) {
                const player = p as Record<string, unknown>;
                if (typeof player.name === 'string') onlinePlayers.add(player.name.toLowerCase());
              }
            } catch {
              /* RCON unavailable — online player set will be empty for this snapshot */
            }

            const _snapshot = snapshotService;
            if (_snapshot) {
              _snapshot.recordSnapshot(
                {
                  players: result.parsed.players,
                  worldState: result.worldState,
                  vehicles: result.parsed.vehicles,
                  structures: result.parsed.structures,
                  containers: result.parsed.containers,
                  companions: result.parsed.companions,
                  horses: result.parsed.horses,
                } as Parameters<InstanceType<typeof SnapshotService>['recordSnapshot']>[0],
                { onlinePlayers },
              );
            }
          } catch (err: unknown) {
            console.error('[BOT] Snapshot recording error:', errMsg(err));
          }
        })();
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
      milestoneTracker = new MilestoneTracker(readyClient, { db, logWatcher, config });
      const _milestone = milestoneTracker;
      // Check milestones on every save sync
      if (saveService) {
        saveService.on('sync', (result: SaveSyncResult) => {
          _milestone.check(result).catch((checkErr: unknown) => {
            console.error('[BOT] Milestone check error:', errMsg(checkErr));
          });
        });
      }
      // Wire death events from LogWatcher to reset survival streaks
      if (logWatcher) {
        logWatcher.wrapOnDeath((orig) => (playerName, timestamp) => {
          orig(playerName, timestamp);
          const steamId = playerStats.getSteamId(playerName);
          if (steamId) _milestone.onPlayerDeath(steamId);
        });
      }
      setStatus('Milestones', '🟢 Active');
    } else {
      setStatus('Milestones', '⚫ Disabled');
      console.log('[BOT] Milestones disabled via ENABLE_MILESTONES=false');
    }

    // Recap Service — daily/weekly summary embeds
    if (config.enableRecaps) {
      recapService = new RecapService(readyClient, { db, logWatcher, config, playtime });
      const _recap = recapService;
      // Chain into LogWatcher day-rollover callback
      if (logWatcher) {
        const prevCb = logWatcher.getDayRolloverCallback();
        logWatcher.setDayRolloverCallback(async () => {
          if (typeof prevCb === 'function') await prevCb();
          const yesterday: string = _recap.getYesterday();
          await _recap.onDayRollover(yesterday);
        });
      }
      setStatus('Recaps', '🟢 Active');
    } else {
      setStatus('Recaps', '⚫ Disabled');
      console.log('[BOT] Recaps disabled via ENABLE_RECAPS=false');
    }

    // Anticheat — observation-only anomaly detection (optional private package)
    if (config.enableAnticheat && AnticheatIntegration) {
      anticheatIntegration = new AnticheatIntegration({ db, config, logWatcher });
      await anticheatIntegration.start();
      const _anticheat = anticheatIntegration;
      if (_anticheat.available) {
        // Wire into save sync for real-time analysis
        if (saveService) {
          saveService.on('sync', (result: SaveSyncResult) => {
            _anticheat.onSaveSync(result).catch((syncErr: unknown) => {
              console.error('[BOT] Anticheat save sync error:', errMsg(syncErr));
            });
          });
        }
        setStatus('Anticheat', '🟢 Active');
      } else {
        setStatus('Anticheat', '🟡 Package not installed');
      }
    } else {
      setStatus('Anticheat', '⚫ Disabled');
    }

    // HOWYAGARN MMO — faction PvP / territory control system
    if (config.enableHowyagarn) {
      if (!HowyagarnManager) {
        setStatus('HOWYAGARN', '🟡 Skipped (module not installed)');
      } else {
        try {
          // Create shared IPC client for engine communication
          if (HzmodIpcClient && config.hzmodSocketPath) {
            hzmodIpc = new HzmodIpcClient(config.hzmodSocketPath);
            hzmodIpc.on('connect', () => {
              console.log('[BOT] hzmod IPC connected');
            });
            hzmodIpc.on('disconnect', () => {
              console.log('[BOT] hzmod IPC disconnected — will reconnect');
            });
            hzmodIpc.on('error', (ipcErr: unknown) => {
              console.error('[BOT] hzmod IPC error:', errMsg(ipcErr));
            });
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
          const _howyagarn = howyagarnManager;

          // Wire save-sync events
          if (saveService) {
            saveService.on('sync', (result: SaveSyncResult) => {
              try {
                if (!(result.parsed as unknown)) return;
                const players: HowyagarnPlayer[] = [];
                const playerMap: Map<string, Record<string, unknown>> = result.parsed.players instanceof Map
                  ? result.parsed.players
                  : new Map(Object.entries(result.parsed.players));
                for (const [steamId, pData] of playerMap) {
                  players.push({
                    steamId,
                    name: (pData['name'] ?? pData['playerName'] ?? '') as string,
                    x: (pData['posX'] ?? pData['x'] ?? 0) as number,
                    y: (pData['posY'] ?? pData['y'] ?? 0) as number,
                    deltaZeeksKilled: (pData['deltaZeeksKilled'] ?? 0) as number,
                    deltaNpcKills: (pData['deltaNpcKills'] ?? 0) as number,
                    deltaAnimalKills: (pData['deltaAnimalKills'] ?? 0) as number,
                    deltaFishCaught: (pData['deltaFishCaught'] ?? 0) as number,
                    deltaDaysSurvived: (pData['deltaDaysSurvived'] ?? 0) as number,
                  });
                }
                const structures: unknown[] = Array.isArray(result.parsed.structures) ? result.parsed.structures : [];
                _howyagarn.onSaveSync({ players, structures });
              } catch (err: unknown) {
                console.error('[BOT] HOWYAGARN save sync error:', errMsg(err));
              }
            });
          }

          // Wire log events (PvP deaths, builds, looting)
          if (logWatcher) {
            logWatcher.wrapLogEvent((orig) => (entry: LogEventEntry) => {
              orig(entry);
              try {
                _howyagarn.onLogEvent(entry.type, entry);
              } catch (err: unknown) {
                console.error('[BOT] howyagarnManager.onLogEvent error:', errMsg(err));
              }
              if (
                entry.type === 'player_connect' &&
                typeof entry.steamId === 'string' &&
                typeof entry.actorName === 'string'
              ) {
                try {
                  _howyagarn.onPlayerConnect(entry.steamId, entry.actorName);
                } catch (err: unknown) {
                  console.error('[BOT] howyagarnManager.onPlayerConnect error:', errMsg(err));
                }
              }
            });
          }

          setStatus('HOWYAGARN', '🟢 Active');
          console.log('[BOT] HOWYAGARN MMO system active');
        } catch (err: unknown) {
          setStatus('HOWYAGARN', `⚠️ Failed: ${errMsg(err)}`);
          console.error('[BOT] HOWYAGARN init failed:', errMsg(err));
        }
      }
    } else {
      setStatus('HOWYAGARN', '⚫ Disabled');
    }

    // Player Stats — DB-first reads (SaveService populates DB, PSC reads it)
    if (config.enablePlayerStats) {
      if (!hasSftp() && !panelApi.available) {
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
        const mode = 'DB-first';
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
        pvpScheduler = new PvpScheduler(
          readyClient,
          (logWatcher ?? null) as ConstructorParameters<typeof PvpScheduler>[1],
        );
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
        serverScheduler = new ServerScheduler(
          readyClient,
          (logWatcher ?? null) as ConstructorParameters<typeof ServerScheduler>[1],
        );
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
        } catch (err: unknown) {
          console.error('[BOT] hzmod plugin registration failed:', errMsg(err));
        }
      }
    }

    // ── BotControlService (used by both Panel and Web) ───────
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
      try {
        db.botState.setStateJSON('bot_running', { startedAt: startedAt.toISOString() });
      } catch {
        // ignore
      }

      // Clean previous lifecycle embeds from admin alert channels
      let alertIds: string[] = config.adminAlertChannelIds;
      if (typeof alertIds === 'string') {
        alertIds = (alertIds as string)
          .split(',')
          .map((s: string) => s.trim())
          .filter(Boolean);
      }
      if (!alertIds.length) alertIds = config.adminChannelId ? [config.adminChannelId] : [];
      const botUserId = readyClient.user.id;
      for (const chId of alertIds) {
        try {
          const ch = await readyClient.channels.fetch(chId).catch(() => null);
          if (!ch || !('messages' in ch)) continue;
          const textCh = ch as TextBasedChannel;
          const messages = await textCh.messages.fetch({ limit: 30 });
          const toDelete = messages.filter((m) => {
            return (
              m.author.id === botUserId &&
              m.embeds.length > 0 &&
              m.embeds.some((e) => e.title === '🔴 Bot Offline' || e.title === '🟢 Bot Online')
            );
          });
          if (toDelete.size > 0) {
            try {
              if ('bulkDelete' in textCh) await (textCh as import('discord.js').TextChannel).bulkDelete(toDelete, true);
            } catch {
              for (const msg of toDelete.values()) {
                await msg.delete().catch(() => {});
              }
            }
          }
        } catch (cleanErr: unknown) {
          console.warn(`[BOT] Could not clean lifecycle embeds in ${chId}:`, errMsg(cleanErr));
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
    } catch (err: unknown) {
      console.error('[BOT] Failed to post online notification:', errMsg(err));
    }

    // ── NUKE_BOT phase 2: rebuild activity threads from log history ──
    if (config.nukeBot) {
      console.log('[NUKE] Rebuilding activity threads from log history...');
      try {
        // Primary server
        const result = await rebuildThreads(readyClient);
        if (result.error) {
          console.error('[NUKE] Thread rebuild failed:', result.error);
        } else {
          console.log(
            `[NUKE] Thread rebuild: ${result.created} created, ${result.deleted} replaced, ${result.preserved} preserved, ${result.cleaned} cleaned`,
          );
        }
        // Additional servers

        const additionalServers = loadServers() as ServerDef[];
        for (const serverDef of additionalServers) {
          const label: string = serverDef.name ?? serverDef.id;
          if (!serverDef.channels?.['log']) {
            console.log('[NUKE] Skipping %s thread rebuild (no log channel)', label);
            continue;
          }

          const serverConfig = createServerConfig(serverDef) as unknown;
          console.log('[NUKE] Rebuilding threads for %s...', label);

          const srvResult = await rebuildThreads(
            readyClient,
            null,
            serverConfig as Parameters<typeof rebuildThreads>[2],
          );
          if (srvResult.error) {
            console.error('[NUKE] Thread rebuild for %s failed:', label, srvResult.error);
          } else {
            console.log(
              `[NUKE] ${label}: ${String(srvResult.created)} created, ${String(srvResult.deleted)} replaced, ${String(srvResult.preserved)} preserved, ${String(srvResult.cleaned)} cleaned`,
            );
          }
        }
      } catch (err: unknown) {
        console.error('[NUKE] Thread rebuild error:', errMsg(err));
      }

      // Reset thread caches so modules pick up the newly rebuilt threads
      // Clear nuke suppression first so thread creation works normally again
      if (logWatcher) {
        logWatcher.setNukeActive(false);
        logWatcher.resetThreadCache();
        // Send the startup notification that was deferred during nuke
        const thread = await logWatcher.getOrCreateDailyThread();
        const startEmbed = new EmbedBuilder()
          .setDescription('Log watcher connected. Monitoring game server activity.')
          .setColor(0x3498db)
          .setTimestamp();
        await thread?.send({ embeds: [startEmbed] }).catch(() => {});
        console.log('[NUKE] LogWatcher thread cache reset');
      }
      if (chatRelay) {
        chatRelay.setNukeActive(false);
        chatRelay.resetThreadCache();
        // Re-create chat thread so it appears after rebuilt activity threads
        await chatRelay.getOrCreateChatThread().catch((e: unknown) => {
          console.warn('[NUKE] Could not re-create chat thread:', errMsg(e));
        });
        console.log('[NUKE] ChatRelay thread cache reset + recreated');
      }
      for (const [, instance] of multiServerManager.getInstances()) {
        const lw = instance.getLogWatcher();
        if (lw) {
          lw.setNukeActive(false);
          lw.resetThreadCache();
          console.log(`[NUKE] ${instance.name || instance.id} LogWatcher thread cache reset`);
        }
        const cr = instance.getChatRelay();
        if (cr) {
          cr.setNukeActive(false);
          cr.resetThreadCache();
          await cr.getOrCreateChatThread().catch(() => {});
          console.log(`[NUKE] ${instance.name || instance.id} ChatRelay thread cache reset + recreated`);
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
  })();
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
      db.botState.deleteState('bot_running');
    } catch (err: unknown) {
      console.warn('[BOT] Could not clear bot_running flag:', errMsg(err));
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
  } catch (err: unknown) {
    console.error('[BOT] Failed to post offline notification:', errMsg(err));
  }

  rcon.disconnect();
  shutdownLogger();
  void client.destroy();
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
process.on('uncaughtException', (err: Error & { code?: number }) => {
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
  void _postErrorEmbed('Uncaught Exception', err).finally(() => {
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
  if (!client.isReady()) return;
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
  } catch (embedErr: unknown) {
    console.warn('[BOT] Failed to post error embed:', errMsg(embedErr));
  }
}

// ── Login ───────────────────────────────────────────────────

/**
 * Delete all bot-authored threads and messages from a channel.
 * Used by NUKE_BOT to factory-reset Discord state before modules start.
 */
async function _nukeChannel(discordClient: Client, channelId: string, botId: string | undefined): Promise<void> {
  try {
    const ch = await discordClient.channels.fetch(channelId).catch(() => null);
    if (!ch) return;

    // Handle bot-authored threads (active + archived)
    // Delete ALL bot threads for a clean slate during nuke.
    if ('threads' in ch) {
      const textCh = ch as import('discord.js').TextChannel;
      const active = await textCh.threads.fetchActive().catch(() => ({ threads: new Map<string, ThreadChannel>() }));
      const archived = await textCh.threads
        .fetchArchived({ limit: 100 })
        .catch(() => ({ threads: new Map<string, ThreadChannel>() }));
      const allThreads: ThreadChannel[] = [...active.threads.values(), ...archived.threads.values()];
      for (const thread of allThreads) {
        if (thread.ownerId !== botId) continue;
        await thread.delete('NUKE_BOT factory reset').catch(() => {});
        const chName = 'name' in ch ? String((ch as { name: unknown }).name) : channelId;
        console.log(`[NUKE] Deleted thread "${thread.name}" from #${chName}`);
      }
    }

    // Delete bot-authored messages (scan up to 1000)
    if (!('messages' in ch)) return;
    const textCh = ch as TextBasedChannel;
    let lastId: string | undefined;
    let deleted = 0;
    for (let page = 0; page < 10; page++) {
      const opts: { limit: number; before?: string } = { limit: 100 };
      if (lastId) opts.before = lastId;
      const batch = await textCh.messages.fetch(opts).catch(() => null);
      if (!batch || batch.size === 0) break;
      const lastMsg = batch.last();
      if (lastMsg) lastId = lastMsg.id;
      for (const [, msg] of batch) {
        if (msg.author.id !== botId) continue;
        await msg.delete().catch(() => {});
        deleted++;
      }
      if (batch.size < 100) break;
    }
    const chName = 'name' in ch ? String((ch as { name: unknown }).name) : channelId;
    if (deleted > 0) console.log(`[NUKE] Deleted ${deleted} message(s) from #${chName}`);
  } catch (err: unknown) {
    console.warn(`[NUKE] Could not clean channel ${channelId}:`, errMsg(err));
  }
}

void (async () => {
  // Load optional modules and slash commands (async import() requires async context)
  await loadOptionalModules();
  await loadCommands();

  // NUKE_BOT implies FIRST_RUN — wipe local data files first, then re-import
  // Log raw .env value for debugging — track unexpected NUKE_BOT=true
  const _nukeLog = createLogger(null, 'NUKE-AUDIT');
  _nukeLog.info(
    `STARTUP: NUKE_BOT=${String(process.env['NUKE_BOT'])}, config.nukeBot=${String(config.nukeBot)}, NUKE_THREADS=${String(process.env['NUKE_THREADS'])}`,
  );
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
      const { main: runSetup } = (await import(setupPath)) as { main: () => Promise<void> };
      await runSetup();
      console.log('[BOT] Data import complete.');
    } catch (err: unknown) {
      console.error('[BOT] Setup failed:', errMsg(err));
      console.error('[BOT] Continuing with existing/empty data files...');
    }
  }
  client.login(config.discordToken).catch((rawErr: unknown) => {
    const err = rawErr as Error & { code?: number };
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

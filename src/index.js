const { Client, GatewayIntentBits, Collection, Events, REST, Routes, EmbedBuilder } = require('discord.js');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { isAdminView } = require('./config');
const rcon = require('./rcon');
const ChatRelay = require('./chat-relay');
const StatusChannels = require('./status-channels');
const ServerStatus = require('./server-status');
const AutoMessages = require('./auto-messages');
const LogWatcher = require('./log-watcher');
const playtime = require('./playtime-tracker');
const playerStats = require('./player-stats');
const PlayerStatsChannel = require('./player-stats-channel');
const PvpScheduler = require('./pvp-scheduler');
const panelApi = require('./panel-api');
const PanelChannel = require('./panel-channel');
const MultiServerManager = require('./multi-server');
const HumanitZDB = require('./db/database');
const SaveService = require('./parsers/save-service');
const gameReference = require('./parsers/game-reference');
const { writeAgent } = require('./parsers/agent-builder');

// ── Create Discord client ───────────────────────────────────
const intents = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.MessageContent,  // needed for admin chat bridge
];
if (config.adminRoleIds.length > 0) {
  intents.push(GatewayIntentBits.GuildMembers); // privileged — enable in Developer Portal
}
const client = new Client({ intents });

// ── Load slash commands ─────────────────────────────────────
client.commands = new Collection();
const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(f => f.endsWith('.js'));

for (const file of commandFiles) {
  const command = require(path.join(commandsPath, file));
  if (command.data && command.execute) {
    client.commands.set(command.data.name, command);
    console.log(`[BOT] Loaded command: /${command.data.name}`);
  }
}

// ── Handle interactions ─────────────────────────────────────
client.on(Events.InteractionCreate, async (interaction) => {

  // ── Panel channel interactions (buttons, select menus, modals) ──
  if (panelChannel) {
    const isPanel = interaction.isButton()
      || interaction.isStringSelectMenu()
      || interaction.isModalSubmit();
    if (isPanel) {
      try {
        const handled = await panelChannel.handleInteraction(interaction);
        if (handled) return;
      } catch (err) {
        console.error('[BOT] Panel interaction error:', err.message);
      }
    }
  }

  // ── Persistent select menu on the player-stats channel ──
  if (interaction.isStringSelectMenu() && interaction.customId.startsWith('playerstats_player_select')) {
    const serverId = interaction.customId.split(':')[1] || '';
    const psc = serverId
      ? _findMultiServerModuleById(serverId, 'playerStatsChannel')
      : playerStatsChannel;
    if (!psc) {
      await interaction.reply({ content: 'Player stats module is currently disabled.', ephemeral: true });
      return;
    }
    const selectedId = interaction.values[0];
    const isAdmin = isAdminView(interaction.member);
    const embed = psc.buildFullPlayerEmbed(selectedId, { isAdmin });
    await interaction.reply({ embeds: [embed], ephemeral: true });
    return;
  }

  // ── Clan select menu on the player-stats channel ──
  if (interaction.isStringSelectMenu() && interaction.customId.startsWith('playerstats_clan_select')) {
    const serverId = interaction.customId.split(':')[1] || '';
    const psc = serverId
      ? _findMultiServerModuleById(serverId, 'playerStatsChannel')
      : playerStatsChannel;
    if (!psc) {
      await interaction.reply({ content: 'Player stats module is currently disabled.', ephemeral: true });
      return;
    }
    const clanName = interaction.values[0].replace(/^clan:/, '');
    const isAdmin = isAdminView(interaction.member);
    const embed = psc.buildClanEmbed(clanName, { isAdmin });
    await interaction.reply({ embeds: [embed], ephemeral: true });
    return;
  }

  // ── Slash commands ──
  if (!interaction.isChatInputCommand()) return;

  const command = client.commands.get(interaction.commandName);
  if (!command) return;

  try {
    await command.execute(interaction);
  } catch (err) {
    console.error(`[BOT] Error in /${interaction.commandName}:`, err);
    const reply = { content: '❌ Something went wrong running that command.', ephemeral: true };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(reply);
    } else {
      await interaction.reply(reply);
    }
  }
});

// ── Bot ready ───────────────────────────────────────────────
let chatRelay;
let statusChannels;
let serverStatus;
let autoMessages;
let logWatcher;
let playerStatsChannel;
let pvpScheduler;
let panelChannel;
let multiServerManager;
let db;           // HumanitZDB instance
let saveService;  // SaveService instance
let adminChannel; // cached for online/offline notifications
const startedAt = new Date();

const moduleStatus = {};

function setStatus(name, status) { moduleStatus[name] = status; }

function hasFtp() {
  return !!(config.ftpHost && config.ftpUser && config.ftpPassword);
}

/**
 * Find a module instance from an additional server by channel ID.
 * Returns the module if the channel belongs to an additional server, or null.
 */
function _findMultiServerModule(channelId, moduleName) {
  if (!multiServerManager) return null;
  for (const [, instance] of multiServerManager._instances) {
    const mod = instance._modules[moduleName];
    if (!mod) continue;
    // Check if this channel belongs to this server's config
    const ch = instance.config;
    if (channelId === ch.playerStatsChannelId ||
        channelId === ch.serverStatusChannelId ||
        channelId === ch.logChannelId ||
        channelId === ch.chatChannelId ||
        channelId === ch.adminChannelId) {
      return mod;
    }
  }
  return null;
}

/** Find a multi-server module by server ID (used for select menu routing). */
function _findMultiServerModuleById(serverId, moduleName) {
  if (!multiServerManager) return null;
  const instance = multiServerManager._instances.get(serverId);
  return instance?._modules[moduleName] || null;
}

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`[BOT] Logged in as ${readyClient.user.tag}`);
  console.log(`[BOT] Serving guild: ${config.guildId}`);

  // Auto-deploy slash commands on startup
  try {
    const rest = new REST({ version: '10' }).setToken(config.discordToken);
    const commandData = [...client.commands.values()].map(c => c.data.toJSON());
    await rest.put(
      Routes.applicationGuildCommands(config.clientId, config.guildId),
      { body: commandData },
    );
    console.log(`[BOT] Registered ${commandData.length} slash commands with Discord`);
  } catch (err) {
    console.error('[BOT] Failed to register slash commands:', err.message);
  }

  console.log('[BOT] Ready!');

  // Connect to RCON
  await rcon.connect();

  // ── RCON lifecycle events — log game server restarts ──
  rcon.on('disconnect', ({ reason }) => {
    console.log(`[BOT] Game server disconnected: ${reason}`);
    if (adminChannel) {
      const embed = new EmbedBuilder()
        .setTitle('🟡 Game Server Disconnected')
        .setDescription(reason || 'RCON connection lost')
        .setColor(0xf39c12)
        .setTimestamp();
      adminChannel.send({ embeds: [embed] }).catch(() => {});
    }
    // Also post to activity thread if available
    if (logWatcher) {
      const embed = new EmbedBuilder()
        .setDescription('🟡 Game server disconnected — RCON connection lost')
        .setColor(0xf39c12)
        .setTimestamp();
      logWatcher.sendToThread(embed).catch(() => {});
    }
  });
  rcon.on('reconnect', ({ downtime }) => {
    const downtimeStr = downtime ? _formatUptime(downtime) : 'unknown';
    console.log(`[BOT] Game server reconnected (downtime: ${downtimeStr})`);
    if (adminChannel) {
      const embed = new EmbedBuilder()
        .setTitle('🟢 Game Server Reconnected')
        .setDescription(`RCON connection restored after ${downtimeStr} downtime.`)
        .setColor(0x2ecc71)
        .setTimestamp();
      adminChannel.send({ embeds: [embed] }).catch(() => {});
    }
    if (logWatcher) {
      const embed = new EmbedBuilder()
        .setDescription(`🟢 Game server reconnected (downtime: ${downtimeStr})`)
        .setColor(0x2ecc71)
        .setTimestamp();
      logWatcher.sendToThread(embed).catch(() => {});
    }
  });

  // Initialize playtime tracker (must be before AutoMessages)
  if (config.enablePlaytime) {
    playtime.init();
  }

  // Initialize player stats tracker (must be before LogWatcher)
  playerStats.init();

  // Initialize SQLite database + seed game reference data
  db = new HumanitZDB();
  db.init();
  gameReference.seed(db);
  console.log('[BOT] SQLite database initialised');

  // Generate/update the standalone agent script so it's always fresh
  try {
    writeAgent();
  } catch (err) {
    console.warn('[BOT] Could not generate humanitz-agent.js:', err.message);
  }

  // ── Wipe saved message IDs on FIRST_RUN ──
  //    Forces each module to re-create its embed from scratch.
  if (config.firstRun) {
    const dataDir = path.join(__dirname, '..', 'data');
    const msgIdFile = path.join(dataDir, 'message-ids.json');
    if (fs.existsSync(msgIdFile)) {
      fs.unlinkSync(msgIdFile);
      console.log('[BOT] Cleared message-ids.json (FIRST_RUN)');
    }
    // Clear transient data files so stale state doesn't persist
    const transientFiles = ['log-offsets.json', 'day-counts.json', 'pvp-kills.json', 'welcome-stats.json'];
    for (const f of transientFiles) {
      const fp = path.join(dataDir, f);
      if (fs.existsSync(fp)) { fs.unlinkSync(fp); console.log(`[BOT] Cleared ${f}`); }
    }
    // Also clear per-server message IDs and orphaned server data directories
    const serversDir = path.join(dataDir, 'servers');
    if (fs.existsSync(serversDir)) {
      const { loadServers } = require('./multi-server');
      const knownIds = new Set(loadServers().map(s => s.id));
      for (const entry of fs.readdirSync(serversDir)) {
        const dir = path.join(serversDir, entry);
        const fp = path.join(dir, 'message-ids.json');
        if (fs.existsSync(fp)) { fs.unlinkSync(fp); }
        if (!knownIds.has(entry) && fs.statSync(dir).isDirectory()) {
          fs.rmSync(dir, { recursive: true, force: true });
          console.log(`[BOT] Removed orphaned server data: ${entry}`);
        } else {
          for (const f of transientFiles) {
            const sfp = path.join(dir, f);
            if (fs.existsSync(sfp)) { fs.unlinkSync(sfp); }
          }
        }
      }
    }
  }

  // ── NUKE_BOT: factory reset — wipe all bot content from Discord ──
  //    Cleans every configured channel BEFORE modules start, so all
  //    threads and embeds are recreated fresh in the correct order.
  if (config.nukeBot) {
    console.log('[NUKE] Wiping all bot content from Discord channels...');
    const channelsToClean = new Set();
    // Primary server channels
    if (config.logChannelId)           channelsToClean.add(config.logChannelId);
    if (config.adminChannelId)         channelsToClean.add(config.adminChannelId);
    if (config.chatChannelId)          channelsToClean.add(config.chatChannelId);
    if (config.serverStatusChannelId)  channelsToClean.add(config.serverStatusChannelId);
    if (config.playerStatsChannelId)   channelsToClean.add(config.playerStatsChannelId);
    if (config.panelChannelId)         channelsToClean.add(config.panelChannelId);
    // Additional server channels (including any from removed servers still in servers.json)
    const { loadServers } = require('./multi-server');
    const servers = loadServers();
    for (const sd of servers) {
      if (sd.channels?.log)    channelsToClean.add(sd.channels.log);
      if (sd.channels?.chat)   channelsToClean.add(sd.channels.chat);
      if (sd.channels?.admin)  channelsToClean.add(sd.channels.admin);
      if (sd.channels?.status) channelsToClean.add(sd.channels.status);
      if (sd.channels?.stats)  channelsToClean.add(sd.channels.stats);
      if (sd.channels?.panel)  channelsToClean.add(sd.channels.panel);
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
    statusChannels = new StatusChannels(readyClient);
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
      serverStatus = new ServerStatus(readyClient);
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
    if (!hasFtp()) {
      setStatus('Log Watcher', '🟡 Skipped (FTP credentials not set)');
      console.log('[BOT] Log watcher skipped — FTP_HOST/FTP_USER/FTP_PASSWORD not configured');
    } else if (!config.logChannelId) {
      setStatus('Log Watcher', '🟡 Skipped (LOG_CHANNEL_ID not set)');
      console.log('[BOT] Log watcher skipped — LOG_CHANNEL_ID not configured');
    } else {
      logWatcher = new LogWatcher(readyClient);
      await logWatcher.start();
      setStatus('Log Watcher', '🟢 Active');
    }
  } else {
    setStatus('Log Watcher', '⚫ Disabled');
    console.log('[BOT] Log watcher disabled via ENABLE_LOG_WATCHER=false');
  }

  // Chat Relay — bidirectional chat bridge
  if (config.enableChatRelay) {
    if (!config.adminChannelId) {
      setStatus('Chat Relay', '🟡 Skipped (ADMIN_CHANNEL_ID not set)');
      console.log('[BOT] Chat relay skipped — ADMIN_CHANNEL_ID not configured');
    } else {
      chatRelay = new ChatRelay(readyClient);
      if (config.nukeBot) chatRelay._nukeActive = true;
      // If LogWatcher handles activity threads, coordinate day-rollover ordering
      if (logWatcher) {
        chatRelay._awaitActivityThread = true;
        logWatcher._dayRolloverCb = async () => {
          try { await chatRelay.createDailyThread(); } catch (e) {
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

  // Auto-Messages — periodic broadcasts + join welcome
  if (config.enableAutoMessages) {
    autoMessages = new AutoMessages();
    await autoMessages.start();
    setStatus('Auto-Messages', '🟢 Active');
  } else {
    setStatus('Auto-Messages', '⚫ Disabled');
    console.log('[BOT] Auto-messages disabled via ENABLE_AUTO_MESSAGES=false');
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

  // Save Service — SFTP save-file polling → SQLite sync (agent or direct)
  if (hasFtp()) {
    saveService = new SaveService(db, {
      sftpConfig: {
        host: config.ftpHost,
        port: config.ftpPort,
        username: config.ftpUser,
        password: config.ftpPassword,
      },
      savePath: config.ftpSavePath,
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
    saveService.on('sync', (result) => {
      console.log(`[BOT] Save sync: ${result.playerCount} players, ${result.structureCount} structures (${result.mode}, ${result.elapsed}ms)`);
    });
    saveService.on('error', (err) => {
      console.error('[BOT] Save service error:', err.message);
    });
    await saveService.start();
    setStatus('Save Service', `🟢 Active (${saveService.stats.mode} mode)`);
  } else {
    setStatus('Save Service', '🟡 Skipped (FTP credentials not set)');
  }

  // Player Stats — save-file parsing with full stats embed
  if (config.enablePlayerStats) {
    if (!hasFtp()) {
      setStatus('Player Stats', '🟡 Skipped (FTP credentials not set)');
      console.log('[BOT] Player stats skipped — FTP_HOST/FTP_USER/FTP_PASSWORD not configured');
    } else if (!config.playerStatsChannelId) {
      setStatus('Player Stats', '🟡 Skipped (PLAYER_STATS_CHANNEL_ID not set)');
      console.log('[BOT] Player stats skipped — PLAYER_STATS_CHANNEL_ID not configured');
    } else {
      playerStatsChannel = new PlayerStatsChannel(readyClient, logWatcher);
      await playerStatsChannel.start();
      setStatus('Player Stats', '🟢 Active');
      if (!logWatcher) {
        setStatus('Player Stats', '🟢 Active (kill/survival feed unavailable — Log Watcher off)');
      }
    }
  } else {
    setStatus('Player Stats', '⚫ Disabled');
    console.log('[BOT] Player stats disabled via ENABLE_PLAYER_STATS=false');
  }

  // PvP Scheduler — SFTP-based PvP toggling on a schedule
  if (config.enablePvpScheduler) {
    if (!hasFtp()) {
      setStatus('PvP Scheduler', '🟡 Skipped (FTP credentials not set)');
      console.log('[BOT] PvP scheduler skipped — FTP_HOST/FTP_USER/FTP_PASSWORD not configured');
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

  // Panel — admin dashboard channel + /qspanel command
  if (config.enablePanel) {
    // Multi-server manager (before panel, so panel can reference it)
    multiServerManager = new MultiServerManager(readyClient);
    await multiServerManager.startAll();

    if (config.panelChannelId) {
      panelChannel = new PanelChannel(readyClient, { moduleStatus, startedAt, multiServerManager });
      await panelChannel.start();
    }
    if (panelApi.available) {
      const channelNote = config.panelChannelId ? 'channel + ' : '';
      setStatus('Panel', `🟢 Active (${channelNote}/qspanel command)`);
      console.log(`[BOT] Panel API available — ${channelNote}/qspanel command active`);
    } else if (config.panelChannelId) {
      setStatus('Panel', '🟢 Active (bot controls only — no panel API)');
      console.log('[BOT] Panel channel active (bot controls + env editor). Panel API not configured.');
    } else {
      setStatus('Panel', '🟡 Skipped (no PANEL_SERVER_URL/PANEL_API_KEY or PANEL_CHANNEL_ID)');
      console.log('[BOT] Panel skipped — no API credentials or channel configured');
    }
  } else {
    setStatus('Panel', '⚫ Disabled');
    console.log('[BOT] Panel disabled via ENABLE_PANEL=false');
  }

  // ── Post online notification to admin channel ──
  const SHUTDOWN_FLAG = path.join(__dirname, '..', 'data', 'bot-running.flag');
  try {
    if (config.adminChannelId) {
      adminChannel = await readyClient.channels.fetch(config.adminChannelId);
    }

    // Detect unclean shutdown: if the flag file exists from a previous run,
    // the bot crashed or was killed without running the shutdown handler.
    if (adminChannel && fs.existsSync(SHUTDOWN_FLAG)) {
      try {
        const flagData = JSON.parse(fs.readFileSync(SHUTDOWN_FLAG, 'utf8'));
        const lastStarted = flagData.startedAt ? new Date(flagData.startedAt) : null;
        const uptime = lastStarted ? _formatUptime(Date.now() - lastStarted.getTime()) : 'unknown';
        const offlineEmbed = new EmbedBuilder()
          .setTitle('🔴 Bot Offline')
          .setDescription('Unexpected shutdown (process was killed)')
          .addFields(
            { name: 'Uptime', value: uptime, inline: true },
          )
          .setColor(0xe74c3c)
          .setTimestamp(lastStarted || new Date());
        await adminChannel.send({ embeds: [offlineEmbed] }).catch(() => {});
      } catch (_) { /* ignore parse errors */ }
    }
    // Write flag file — removed on clean shutdown
    try {
      fs.writeFileSync(SHUTDOWN_FLAG, JSON.stringify({ startedAt: startedAt.toISOString() }));
    } catch (_) {}

    // Build status lines grouped by state
    const active   = [];
    const disabled = [];
    const skipped  = [];
    for (const [name, status] of Object.entries(moduleStatus)) {
      if (status.startsWith('🟢')) active.push(`🟢 ${name}`);
      else if (status.startsWith('⚫')) disabled.push(`⚫ ${name}`);
      else if (status.startsWith('🟡')) skipped.push(status.replace('🟡 Skipped', `🟡 ${name} — skipped`));
    }

    const statusLines = [];
    if (active.length)   statusLines.push(active.join('\n'));
    if (disabled.length) statusLines.push(disabled.join('\n'));
    if (skipped.length)  statusLines.push(skipped.join('\n'));

    const allGood = skipped.length === 0 && disabled.length === 0;
    const description = allGood
      ? 'All systems operational.'
      : skipped.length > 0
        ? 'Some modules were skipped due to missing configuration.'
        : 'Running with selected modules.';

    const embed = new EmbedBuilder()
      .setTitle('🟢 Bot Online')
      .setDescription(description)
      .addFields(
        { name: 'Module Status', value: statusLines.join('\n') || 'None', inline: false },
      )
      .setColor(0x2ecc71)
      .setTimestamp();

    // Post to admin channel only (not activity thread — keep threads for game events)
    if (adminChannel) {
      await adminChannel.send({ embeds: [embed] }).catch(err => {
        console.error('[BOT] Could not post online notification:', err.message);
      });
    }
  } catch (err) {
    console.error('[BOT] Failed to post online notification:', err.message);
  }

  // ── NUKE_BOT phase 2: rebuild activity threads from log history ──
  if (config.nukeBot) {
    console.log('[NUKE] Rebuilding activity threads from log history...');
    try {
      const { rebuildThreads } = require('./commands/threads');
      // Primary server
      const result = await rebuildThreads(readyClient);
      if (result.error) {
        console.error('[NUKE] Thread rebuild failed:', result.error);
      } else {
        console.log(`[NUKE] Thread rebuild: ${result.created} created, ${result.deleted} replaced, ${result.preserved} preserved, ${result.cleaned} cleaned`);
      }
      // Additional servers
      const { loadServers, createServerConfig } = require('./multi-server');
      const servers = loadServers();
      for (const serverDef of servers) {
        const label = serverDef.name || serverDef.id;
        if (!serverDef.channels?.log) {
          console.log(`[NUKE] Skipping ${label} thread rebuild (no log channel)`);
          continue;
        }
        const serverConfig = createServerConfig(serverDef);
        console.log(`[NUKE] Rebuilding threads for ${label}...`);
        const srvResult = await rebuildThreads(readyClient, null, serverConfig);
        if (srvResult.error) {
          console.error(`[NUKE] Thread rebuild for ${label} failed:`, srvResult.error);
        } else {
          console.log(`[NUKE] ${label}: ${srvResult.created} created, ${srvResult.deleted} replaced, ${srvResult.preserved} preserved, ${srvResult.cleaned} cleaned`);
        }
      }
    } catch (err) {
      console.error('[NUKE] Thread rebuild error:', err.message);
    }

    // Reset thread caches so modules pick up the newly rebuilt threads
    // Clear nuke suppression first so thread creation works normally again
    if (logWatcher) {
      logWatcher._nukeActive = false;
      logWatcher.resetThreadCache();
      // Send the startup notification that was deferred during nuke
      const thread = await logWatcher._getOrCreateDailyThread();
      const { EmbedBuilder } = require('discord.js');
      const startEmbed = new EmbedBuilder()
        .setDescription('📋 Log watcher connected. Monitoring game server activity.')
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
        await chatRelay._getOrCreateChatThread().catch(e =>
          console.warn('[NUKE] Could not re-create chat thread:', e.message));
      }
      console.log('[NUKE] ChatRelay thread cache reset + recreated');
    }
    if (multiServerManager) {
      for (const [, instance] of multiServerManager._instances) {
        if (instance._modules?.logWatcher) {
          instance._modules.logWatcher._nukeActive = false;
          instance._modules.logWatcher.resetThreadCache();
          console.log(`[NUKE] ${instance.name || instance.id} LogWatcher thread cache reset`);
        }
        if (instance._modules?.chatRelay && typeof instance._modules.chatRelay.resetThreadCache === 'function') {
          instance._modules.chatRelay._nukeActive = false;
          instance._modules.chatRelay.resetThreadCache();
          if (typeof instance._modules.chatRelay._getOrCreateChatThread === 'function') {
            await instance._modules.chatRelay._getOrCreateChatThread().catch(() => {});
          }
          console.log(`[NUKE] ${instance.name || instance.id} ChatRelay thread cache reset + recreated`);
        }
      }
    }

    // Set NUKE_BOT=false (and NUKE_THREADS + FIRST_RUN for completeness) in .env
    try {
      const envPath = path.join(__dirname, '..', '.env');
      let envContent = fs.readFileSync(envPath, 'utf8');
      envContent = envContent.replace(/^NUKE_BOT\s*=\s*true$/m, 'NUKE_BOT=false');
      envContent = envContent.replace(/^NUKE_THREADS\s*=\s*true$/m, 'NUKE_THREADS=false');
      envContent = envContent.replace(/^FIRST_RUN\s*=\s*true$/m, 'FIRST_RUN=false');
      fs.writeFileSync(envPath, envContent, 'utf8');
      console.log('[NUKE] NUKE_BOT + FIRST_RUN set back to false in .env');
    } catch (err) {
      console.warn('[NUKE] Could not update .env:', err.message);
      console.warn('[NUKE] Please manually set NUKE_BOT=false to prevent repeat reset.');
    }

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
    } catch (err) {
      console.warn('[BOT] Could not update .env — please manually set FIRST_RUN=false');
    }
  }

  console.log('[BOT] Ready!');
});

// ── Graceful shutdown ───────────────────────────────────────
let shuttingDown = false;
async function shutdown(reason = 'Manual shutdown') {
  if (shuttingDown) return; // prevent double-shutdown
  shuttingDown = true;
  console.log('\n[BOT] Shutting down...');

  // Post offline notification — try both thread AND admin channel for reliability
  try {
    const uptime = _formatUptime(Date.now() - startedAt.getTime());

    // Summarise module state
    const activeCount  = Object.values(moduleStatus).filter(s => s.startsWith('🟢')).length;
    const totalCount   = Object.keys(moduleStatus).length;

    const embed = new EmbedBuilder()
      .setTitle('🔴 Bot Offline')
      .setDescription(reason)
      .addFields(
        { name: 'Uptime', value: uptime, inline: true },
        { name: 'Modules', value: `${activeCount}/${totalCount} active`, inline: true },
      )
      .setColor(0xe74c3c)
      .setTimestamp();

    // Race the notification against a timeout so shutdown never hangs
    if (adminChannel) {
      await Promise.race([
        adminChannel.send({ embeds: [embed] }).catch(() => {}),
        new Promise(resolve => setTimeout(resolve, 5000)),
      ]);
    }
  } catch (err) {
    console.error('[BOT] Failed to post offline notification:', err.message);
  }

  if (chatRelay) chatRelay.stop();
  if (statusChannels) statusChannels.stop();
  if (serverStatus) serverStatus.stop();
  if (autoMessages) autoMessages.stop();
  if (pvpScheduler) pvpScheduler.stop();
  if (panelChannel) panelChannel.stop();
  if (logWatcher) logWatcher.stop();
  if (playerStatsChannel) playerStatsChannel.stop();
  if (saveService) saveService.stop();
  if (multiServerManager) await multiServerManager.stopAll();
  playerStats.stop();
  playtime.stop();
  if (db) db.close();
  await rcon.disconnect();

  // Remove running flag — signals clean shutdown
  try { fs.unlinkSync(path.join(__dirname, '..', 'data', 'bot-running.flag')); } catch (_) {}

  client.destroy();
  process.exit(0);
}

function _formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  parts.push(`${mins}m`);
  return parts.join(' ');
}

process.on('SIGINT', () => shutdown('SIGINT received'));
process.on('SIGTERM', () => shutdown('SIGTERM received'));
process.on('uncaughtException', (err) => {
  console.error('[BOT] Uncaught exception:', err);
  shutdown(`Uncaught exception: ${err.message}`).catch(() => process.exit(1));
});
process.on('unhandledRejection', (reason) => {
  console.error('[BOT] Unhandled rejection:', reason);
  // Log but don't crash — unhandled rejections are often recoverable
});

// ── Login ───────────────────────────────────────────────────

/**
 * Delete all bot-authored threads and messages from a channel.
 * Used by NUKE_BOT to factory-reset Discord state before modules start.
 */
async function _nukeChannel(client, channelId, botId) {
  try {
    const ch = await client.channels.fetch(channelId).catch(() => null);
    if (!ch) return;

    // Handle bot-authored threads (active + archived)
    // Chat log threads are preserved (archived with prefix); activity threads are deleted
    // since they get rebuilt from log history in nuke phase 2.
    if (ch.threads) {
      const active = await ch.threads.fetchActive().catch(() => ({ threads: new Map() }));
      const archived = await ch.threads.fetchArchived({ limit: 100 }).catch(() => ({ threads: new Map() }));
      const allThreads = [...active.threads.values(), ...archived.threads.values()];
      for (const thread of allThreads) {
        if (thread.ownerId !== botId) continue;
        // Preserve chat log threads — rename + archive them so history isn't lost
        if (thread.name.includes('Chat Log')) {
          try {
            const newName = thread.name.replace(/^💬\s*/, '📁 ');
            await thread.setName(newName).catch(() => {});
            if (!thread.archived) await thread.setArchived(true).catch(() => {});
            console.log(`[NUKE] Archived chat thread "${thread.name}" → "${newName}" in #${ch.name || channelId}`);
          } catch (e) {
            console.warn(`[NUKE] Could not archive chat thread "${thread.name}":`, e.message);
          }
        } else {
          await thread.delete('NUKE_BOT factory reset').catch(() => {});
          console.log(`[NUKE] Deleted thread "${thread.name}" from #${ch.name || channelId}`);
        }
      }
    }

    // Delete bot-authored messages (scan up to 1000)
    // Skip messages that have a preserved (archived) thread attached
    let lastId;
    let deleted = 0;
    for (let page = 0; page < 10; page++) {
      const opts = { limit: 100 };
      if (lastId) opts.before = lastId;
      const batch = await ch.messages?.fetch(opts).catch(() => new Map());
      if (!batch || batch.size === 0) break;
      lastId = batch.last().id;
      for (const [, msg] of batch) {
        if (msg.author?.id !== botId) continue;
        // Don't delete starter messages for preserved chat threads
        if (msg.hasThread) {
          try {
            const thread = await msg.thread?.fetch().catch(() => null);
            if (thread && thread.name.includes('Chat Log')) continue;
          } catch { /* thread already gone — safe to delete message */ }
        }
        await msg.delete().catch(() => {});
        deleted++;
      }
      if (batch.size < 100) break;
    }
    if (deleted > 0) console.log(`[NUKE] Deleted ${deleted} message(s) from #${ch.name || channelId}`);
  } catch (err) {
    console.warn(`[NUKE] Could not clean channel ${channelId}:`, err.message);
  }
}

(async () => {
  // NUKE_BOT implies FIRST_RUN — wipe local data files first, then re-import
  if (config.nukeBot) {
    console.log('[NUKE] NUKE_BOT=true — factory reset starting...');
    const dataDir = path.join(__dirname, '..', 'data');
    // Wipe all transient data files (preserves game reference data like dt-*.txt)
    const filesToWipe = [
      'message-ids.json', 'player-stats.json', 'playtime.json',
      'welcome-stats.json', 'server-settings.json', 'bot-running.flag',
      'log-offsets.json', 'day-counts.json', 'pvp-kills.json',
      'humanitz.db', 'humanitz.db-wal', 'humanitz.db-shm',
    ];
    for (const f of filesToWipe) {
      const fp = path.join(dataDir, f);
      if (fs.existsSync(fp)) { fs.unlinkSync(fp); console.log(`[NUKE] Deleted ${f}`); }
    }
    // Wipe per-server data directories
    const serversDir = path.join(dataDir, 'servers');
    if (fs.existsSync(serversDir)) {
      fs.rmSync(serversDir, { recursive: true, force: true });
      console.log('[NUKE] Deleted servers/ directory');
    }
    // Wipe removed-server configs (servers.json)
    const serversJson = path.join(dataDir, 'servers.json');
    if (fs.existsSync(serversJson)) { fs.unlinkSync(serversJson); console.log('[NUKE] Deleted servers.json'); }
  }

  // Run setup/import if FIRST_RUN=true or NUKE_BOT=true
  if (config.firstRun || config.nukeBot) {
    console.log(`[BOT] ${config.nukeBot ? 'NUKE_BOT' : 'FIRST_RUN'}=true — running data import...`);
    const setupPath = require('path').join(__dirname, '..', 'setup.js');
    try {
      require('fs').accessSync(setupPath);
    } catch {
      console.error(`[BOT] setup.js not found at: ${setupPath}`);
      console.error('[BOT] Upload setup.js to the root of your bot folder (next to package.json).');
      console.error('[BOT] Continuing with existing data files...');
    }
    try {
      const { main: runSetup } = require(setupPath);
      await runSetup();
      console.log('[BOT] Data import complete.');
    } catch (err) {
      console.error('[BOT] Setup failed:', err.message);
      console.error('[BOT] Continuing with existing/empty data files...');
    }
  }
  client.login(config.discordToken);
})();

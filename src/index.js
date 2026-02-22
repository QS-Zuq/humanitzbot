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

  // Initialize playtime tracker (must be before AutoMessages)
  if (config.enablePlaytime) {
    playtime.init();
  }

  // Initialize player stats tracker (must be before LogWatcher)
  playerStats.init();

  // ── Wipe saved message IDs on FIRST_RUN or NUKE_THREADS ──
  //    Forces each module to bulk-delete old bot messages in its channel.
  if (config.firstRun || config.nukeThreads) {
    const msgIdFile = path.join(__dirname, '..', 'data', 'message-ids.json');
    if (fs.existsSync(msgIdFile)) {
      fs.unlinkSync(msgIdFile);
      console.log('[BOT] Cleared message-ids.json (FIRST_RUN or NUKE_THREADS)');
    }
    // Also clear per-server message IDs
    const serversDir = path.join(__dirname, '..', 'data', 'servers');
    if (fs.existsSync(serversDir)) {
      for (const entry of fs.readdirSync(serversDir)) {
        const fp = path.join(serversDir, entry, 'message-ids.json');
        if (fs.existsSync(fp)) { fs.unlinkSync(fp); }
      }
    }
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

  // Chat Relay — bidirectional chat bridge
  if (config.enableChatRelay) {
    if (!config.adminChannelId) {
      setStatus('Chat Relay', '🟡 Skipped (ADMIN_CHANNEL_ID not set)');
      console.log('[BOT] Chat relay skipped — ADMIN_CHANNEL_ID not configured');
    } else {
      chatRelay = new ChatRelay(readyClient);
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

  // Log Watcher — SFTP log parsing + daily activity threads
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

  // ── NUKE_THREADS: one-shot thread rebuild on startup ─────────
  if (config.nukeThreads) {
    console.log('[BOT] NUKE_THREADS=true — rebuilding all activity threads...');
    try {
      const { rebuildThreads } = require('./commands/threads');
      // Primary server
      const result = await rebuildThreads(readyClient);
      if (result.error) {
        console.error('[BOT] Thread rebuild failed:', result.error);
      } else {
        console.log(`[BOT] Thread rebuild complete: ${result.created} created, ${result.deleted} replaced, ${result.preserved} messages preserved, ${result.cleaned} old messages cleaned`);
      }
      // Additional servers
      const { loadServers, createServerConfig } = require('./multi-server');
      const servers = loadServers();
      for (const serverDef of servers) {
        const label = serverDef.name || serverDef.id;
        if (!serverDef.channels?.log) {
          console.log(`[BOT] NUKE_THREADS: skipping ${label} (no log channel)`);
          continue;
        }
        const serverConfig = createServerConfig(serverDef);
        console.log(`[BOT] NUKE_THREADS: rebuilding threads for ${label}...`);
        const srvResult = await rebuildThreads(readyClient, null, serverConfig);
        if (srvResult.error) {
          console.error(`[BOT] Thread rebuild for ${label} failed:`, srvResult.error);
        } else {
          console.log(`[BOT] Thread rebuild for ${label}: ${srvResult.created} created, ${srvResult.deleted} replaced, ${srvResult.preserved} preserved, ${srvResult.cleaned} cleaned`);
        }
      }
    } catch (err) {
      console.error('[BOT] Thread rebuild error:', err.message);
    }

    // Invalidate thread caches so modules re-fetch the new threads
    if (logWatcher) {
      logWatcher.resetThreadCache();
      console.log('[BOT] Primary LogWatcher thread cache reset');
    }
    if (chatRelay && typeof chatRelay.resetThreadCache === 'function') {
      chatRelay.resetThreadCache();
      console.log('[BOT] Primary ChatRelay thread cache reset');
    }
    if (multiServerManager) {
      for (const [, instance] of multiServerManager._instances) {
        if (instance._modules?.logWatcher) {
          instance._modules.logWatcher.resetThreadCache();
          console.log(`[BOT] ${instance.name || instance.id} LogWatcher thread cache reset`);
        }
        if (instance._modules?.chatRelay && typeof instance._modules.chatRelay.resetThreadCache === 'function') {
          instance._modules.chatRelay.resetThreadCache();
          console.log(`[BOT] ${instance.name || instance.id} ChatRelay thread cache reset`);
        }
      }
    }

    // Set NUKE_THREADS=false in .env so it doesn't run again
    try {
      const envPath = path.join(__dirname, '..', '.env');
      let envContent = fs.readFileSync(envPath, 'utf8');
      envContent = envContent.replace(/^NUKE_THREADS\s*=\s*true$/m, 'NUKE_THREADS=false');
      fs.writeFileSync(envPath, envContent, 'utf8');
      console.log('[BOT] NUKE_THREADS set back to false in .env');
    } catch (err) {
      console.warn('[BOT] Could not update .env:', err.message);
      console.warn('[BOT] Please manually set NUKE_THREADS=false to prevent repeat rebuild.');
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
  if (multiServerManager) await multiServerManager.stopAll();
  playerStats.stop();
  playtime.stop();
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
(async () => {
  // Run setup/import if FIRST_RUN=true (downloads logs via SFTP and rebuilds data files)
  if (config.firstRun) {
    console.log('[BOT] FIRST_RUN=true — running data import before starting bot...');
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
      console.log('[BOT] Data import complete. Set FIRST_RUN=false in .env to skip next time.');
    } catch (err) {
      console.error('[BOT] Setup failed:', err.message);
      console.error('[BOT] Continuing with existing/empty data files...');
    }
  }
  client.login(config.discordToken);
})();

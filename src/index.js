const { Client, GatewayIntentBits, Collection, Events, REST, Routes, EmbedBuilder } = require('discord.js');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const rcon = require('./rcon');
const ChatRelay = require('./chat-relay');
const StatusChannels = require('./status-channels');
const ServerStatus = require('./server-status');
const AutoMessages = require('./auto-messages');
const LogWatcher = require('./log-watcher');
const playtime = require('./playtime-tracker');
const playerStats = require('./player-stats');
const PlayerStatsChannel = require('./player-stats-channel');

// ── Create Discord client ───────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,  // needed for admin chat bridge
  ],
});

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

  // ── Persistent select menu on the player-stats channel ──
  if (interaction.isStringSelectMenu() && interaction.customId === 'playerstats_player_select') {
    const selectedId = interaction.values[0];
    const isAdmin = interaction.member?.permissions?.has('Administrator') ?? false;
    const embed = playerStatsChannel.buildFullPlayerEmbed(selectedId, { isAdmin });
    await interaction.reply({ embeds: [embed], ephemeral: true });
    return;
  }

  // ── Clan select menu on the player-stats channel ──
  if (interaction.isStringSelectMenu() && interaction.customId === 'playerstats_clan_select') {
    const clanName = interaction.values[0].replace(/^clan:/, '');
    const embed = playerStatsChannel.buildClanEmbed(clanName);
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

  console.log(`successfully finished startup`);

  // Connect to RCON
  await rcon.connect();

  // Initialize playtime tracker (must be before AutoMessages)
  playtime.init();

  // Initialize player stats tracker (must be before LogWatcher)
  playerStats.init();

  // Start status channels (voice channel dashboard at top of server)
  statusChannels = new StatusChannels(readyClient);
  await statusChannels.start();

  // Start live server status text channel
  serverStatus = new ServerStatus(readyClient);
  await serverStatus.start();

  // Start admin chat bridge
  chatRelay = new ChatRelay(readyClient);
  await chatRelay.start();

  // Start auto-messages (periodic broadcasts + join welcome)
  autoMessages = new AutoMessages();
  await autoMessages.start();

  // Start log watcher (FTP-based game server log parsing)
  logWatcher = new LogWatcher(readyClient);
  await logWatcher.start();

  // Start player-stats channel (save-file parsing with full stats embed)
  playerStatsChannel = new PlayerStatsChannel(readyClient);
  await playerStatsChannel.start();

  console.log('[BOT] Ready!');
});

// ── Graceful shutdown ───────────────────────────────────────
async function shutdown() {
  console.log('\n[BOT] Shutting down...');
  if (chatRelay) chatRelay.stop();
  if (statusChannels) statusChannels.stop();
  if (serverStatus) serverStatus.stop();
  if (autoMessages) autoMessages.stop();
  if (logWatcher) logWatcher.stop();
  if (playerStatsChannel) playerStatsChannel.stop();
  playerStats.stop();
  playtime.stop();
  await rcon.disconnect();
  client.destroy();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ── Login ───────────────────────────────────────────────────
client.login(config.discordToken);

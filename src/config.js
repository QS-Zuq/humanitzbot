require('dotenv').config();

/** Read a boolean from .env with an explicit default */
function envBool(key, defaultValue) {
  const val = process.env[key];
  if (val === undefined || val === '') return defaultValue;
  return val === 'true';
}

const config = {
  // Discord
  discordToken: process.env.DISCORD_TOKEN,
  clientId: process.env.DISCORD_CLIENT_ID,
  guildId: process.env.DISCORD_GUILD_ID,
  adminChannelId: process.env.ADMIN_CHANNEL_ID,
  chatChannelId: process.env.CHAT_CHANNEL_ID || '',  // defaults to adminChannelId if empty
  serverStatusChannelId: process.env.SERVER_STATUS_CHANNEL_ID,

  // RCON
  rconHost: process.env.RCON_HOST,
  rconPort: parseInt(process.env.RCON_PORT, 10) || 27015,
  rconPassword: process.env.RCON_PASSWORD,

  // Behavior
  chatPollInterval: parseInt(process.env.CHAT_POLL_INTERVAL, 10) || 10000,
  statusCacheTtl: parseInt(process.env.STATUS_CACHE_TTL, 10) || 30000,
  statusChannelInterval: parseInt(process.env.STATUS_CHANNEL_INTERVAL, 10) || 300000, // 5 min default
  serverStatusInterval: parseInt(process.env.SERVER_STATUS_INTERVAL, 10) || 30000, // 30s default

  // Auto-messages
  discordInviteLink: process.env.DISCORD_INVITE_LINK || '',
  autoMsgLinkInterval: parseInt(process.env.AUTO_MSG_LINK_INTERVAL, 10) || 1800000,      // 30 min
  autoMsgPromoInterval: parseInt(process.env.AUTO_MSG_PROMO_INTERVAL, 10) || 2700000,    // 45 min
  autoMsgJoinCheckInterval: parseInt(process.env.AUTO_MSG_JOIN_CHECK, 10) || 10000,      // 10 sec

  // FTP Log Watcher
  ftpHost: process.env.FTP_HOST || '',
  ftpPort: parseInt(process.env.FTP_PORT, 10) || 8821,
  ftpUser: process.env.FTP_USER || '',
  ftpPassword: process.env.FTP_PASSWORD || '',
  ftpLogPath: process.env.FTP_LOG_PATH || '/HumanitZServer/HMZLog.log',
  ftpConnectLogPath: process.env.FTP_CONNECT_LOG_PATH || '/HumanitZServer/PlayerConnectedLog.txt',
  ftpIdMapPath: process.env.FTP_ID_MAP_PATH || '/HumanitZServer/PlayerIDMapped.txt',
  logPollInterval: parseInt(process.env.LOG_POLL_INTERVAL, 10) || 30000,   // 30 sec
  logChannelId: process.env.LOG_CHANNEL_ID || '',

  // Save-file parser
  ftpSavePath: process.env.FTP_SAVE_PATH || '/HumanitZServer/Saved/SaveGames/SaveList/Default/Save_DedicatedSaveMP.sav',
  savePollInterval: parseInt(process.env.SAVE_POLL_INTERVAL, 10) || 300000,  // 5 min default

  // Player-stats channel
  playerStatsChannelId: process.env.PLAYER_STATS_CHANNEL_ID || '',

  // Feature toggles — major modules (all on by default)
  enableStatusChannels: envBool('ENABLE_STATUS_CHANNELS', true),
  enableServerStatus: envBool('ENABLE_SERVER_STATUS', true),
  enableChatRelay: envBool('ENABLE_CHAT_RELAY', true),
  enableAutoMessages: envBool('ENABLE_AUTO_MESSAGES', true),
  enableLogWatcher: envBool('ENABLE_LOG_WATCHER', true),
  enablePlayerStats: envBool('ENABLE_PLAYER_STATS', true),
  enablePlaytime: envBool('ENABLE_PLAYTIME', true),

  // Feature toggles — log watcher sub-features
  enableKillFeed: envBool('ENABLE_KILL_FEED', true),   // post zombie kill batches to activity thread

  // Feature toggles — auto-message sub-features (all on by default)
  enableAutoMsgLink: envBool('ENABLE_AUTO_MSG_LINK', true),
  enableAutoMsgPromo: envBool('ENABLE_AUTO_MSG_PROMO', true),
  enableAutoMsgWelcome: envBool('ENABLE_AUTO_MSG_WELCOME', true),

  // Feature toggles — player stats embed sections
  showRaidStats: envBool('SHOW_RAID_STATS', false),       // default: off (PVE)
  showVitals: envBool('SHOW_VITALS', true),               // default: on
  showStatusEffects: envBool('SHOW_STATUS_EFFECTS', true), // default: on
  showInventory: envBool('SHOW_INVENTORY', true),          // default: on
  showRecipes: envBool('SHOW_RECIPES', true),              // default: on
  showLore: envBool('SHOW_LORE', true),                    // default: on
  showConnections: envBool('SHOW_CONNECTIONS', true),      // default: on
};

// Validate required values (only core Discord + RCON needed)
const required = ['discordToken', 'clientId', 'guildId', 'rconHost', 'rconPassword'];
for (const key of required) {
  if (!config[key] || config[key].startsWith('your_')) {
    console.error(`[CONFIG] Missing or placeholder value for: ${key}`);
    console.error(`         Please configure your .env file. See .env.example for reference.`);
    process.exit(1);
  }
}

module.exports = config;

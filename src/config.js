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

  // Feature toggles (set to 'true'/'false' in .env to override)
  showRaidStats: envBool('SHOW_RAID_STATS', false),       // default: off (PVE)
  showVitals: envBool('SHOW_VITALS', true),               // default: on
  showStatusEffects: envBool('SHOW_STATUS_EFFECTS', true), // default: on
  showInventory: envBool('SHOW_INVENTORY', true),          // default: on
  showRecipes: envBool('SHOW_RECIPES', true),              // default: on
  showLore: envBool('SHOW_LORE', true),                    // default: on
  showConnections: envBool('SHOW_CONNECTIONS', true),      // default: on
};

// Validate required values
const required = ['discordToken', 'clientId', 'guildId', 'adminChannelId', 'rconHost', 'rconPassword'];
for (const key of required) {
  if (!config[key] || config[key].startsWith('your_')) {
    console.error(`[CONFIG] Missing or placeholder value for: ${key}`);
    console.error(`         Please configure your .env file. See .env.example for reference.`);
    process.exit(1);
  }
}

module.exports = config;

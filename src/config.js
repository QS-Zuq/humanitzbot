require('dotenv').config();

/** Read a boolean from .env with an explicit default */
function envBool(key, defaultValue) {
  const val = process.env[key];
  if (val === undefined || val === '') return defaultValue;
  return val === 'true';
}

/** Parse a time string like "18", "18:00", or "18:30" into total minutes from midnight */
function envTime(key) {
  const val = process.env[key];
  if (val === undefined || val === '') return NaN;
  const parts = val.split(':');
  const h = parseInt(parts[0], 10);
  const m = parts.length > 1 ? parseInt(parts[1], 10) : 0;
  if (isNaN(h) || isNaN(m)) return NaN;
  return h * 60 + m;
}

const config = {
  // Discord
  discordToken: process.env.DISCORD_TOKEN,
  clientId: process.env.DISCORD_CLIENT_ID,
  guildId: process.env.DISCORD_GUILD_ID,
  adminChannelId: process.env.ADMIN_CHANNEL_ID,
  chatChannelId: process.env.CHAT_CHANNEL_ID || '',  // defaults to adminChannelId if empty
  serverStatusChannelId: process.env.SERVER_STATUS_CHANNEL_ID,
  adminUserIds: (process.env.ADMIN_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean),

  // RCON
  rconHost: process.env.RCON_HOST,
  rconPort: parseInt(process.env.RCON_PORT, 10) || 27015,
  rconPassword: process.env.RCON_PASSWORD,

  // Timezone for daily threads / summaries (IANA format, e.g. 'America/New_York', 'US/Eastern')
  botTimezone: process.env.BOT_TIMEZONE || process.env.PVP_TIMEZONE || 'UTC',

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

  // PvP scheduler
  enablePvpScheduler: envBool('ENABLE_PVP_SCHEDULER', false),
  pvpStartMinutes: envTime('PVP_START_TIME'),   // total minutes from midnight (supports "HH" or "HH:MM")
  pvpEndMinutes: envTime('PVP_END_TIME'),       // total minutes from midnight (supports "HH" or "HH:MM")
  // Legacy fallback: PVP_START_HOUR / PVP_END_HOUR still work (whole hours only)
  pvpStartHour: process.env.PVP_START_HOUR !== undefined ? parseInt(process.env.PVP_START_HOUR, 10) : NaN,
  pvpEndHour: process.env.PVP_END_HOUR !== undefined ? parseInt(process.env.PVP_END_HOUR, 10) : NaN,
  pvpTimezone: process.env.PVP_TIMEZONE || process.env.BOT_TIMEZONE || 'UTC',
  pvpRestartDelay: parseInt(process.env.PVP_RESTART_DELAY, 10) || 10,
  pvpUpdateServerName: envBool('PVP_UPDATE_SERVER_NAME', false),
  ftpSettingsPath: process.env.FTP_SETTINGS_PATH || '/HumanitZServer/GameServerSettings.ini',

  // First-run / data repair
  firstRun: envBool('FIRST_RUN', false),

  // Feature toggles — log watcher sub-features
  enableKillFeed: envBool('ENABLE_KILL_FEED', true),   // post zombie kill batches to activity thread
  enablePvpKillFeed: envBool('ENABLE_PVP_KILL_FEED', true), // post PvP kills to activity thread
  showPvpKills: envBool('SHOW_PVP_KILLS', false),            // show "Last 10 PvP Kills" on server stats embed
  pvpKillWindow: parseInt(process.env.PVP_KILL_WINDOW, 10) || 60000, // ms window to attribute a kill after damage (default 60s; log timestamps are minute-precision)

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

// ── Timezone-aware date helpers ─────────────────────────────
// All daily thread boundaries, summaries, and displayed times use BOT_TIMEZONE.

/**
 * Get today's date string ('YYYY-MM-DD') in the configured BOT_TIMEZONE.
 * Falls back to UTC if the timezone is invalid.
 */
config.getToday = function () {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: config.botTimezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date());
    const y = parts.find(p => p.type === 'year').value;
    const m = parts.find(p => p.type === 'month').value;
    const d = parts.find(p => p.type === 'day').value;
    return `${y}-${m}-${d}`;
  } catch {
    return new Date().toISOString().split('T')[0];
  }
};

/**
 * Get a human-readable date label (e.g. '20 Feb 2026') in the configured BOT_TIMEZONE.
 * @param {Date} [date] — defaults to now
 */
config.getDateLabel = function (date) {
  try {
    return (date || new Date()).toLocaleDateString('en-GB', {
      timeZone: config.botTimezone,
      day: 'numeric', month: 'short', year: 'numeric',
    });
  } catch {
    return (date || new Date()).toLocaleDateString('en-GB', {
      day: 'numeric', month: 'short', year: 'numeric',
    });
  }
};

/**
 * Format a Date into a short readable time string in the configured BOT_TIMEZONE.
 * e.g. 'Feb 20, 02:48 AM'
 */
config.formatTime = function (date) {
  try {
    return date.toLocaleString('en-US', {
      timeZone: config.botTimezone,
      month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: true,
    });
  } catch {
    return date.toLocaleString('en-US', {
      month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: true,
    });
  }
};

console.log(`[CONFIG] Timezone: ${config.botTimezone}`);

module.exports = config;

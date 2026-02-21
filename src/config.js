require('dotenv').config();

function envBool(key, defaultValue) {
  const val = process.env[key];
  if (val === undefined || val === '') return defaultValue;
  return val === 'true';
}

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
  adminAlertChannelIds: (process.env.ADMIN_ALERT_CHANNEL_IDS || '').split(',').map(s => s.trim()).filter(Boolean),

  // RCON
  rconHost: process.env.RCON_HOST,
  rconPort: parseInt(process.env.RCON_PORT, 10) || 27015,
  rconPassword: process.env.RCON_PASSWORD,

  // Timezone for daily threads / summaries (IANA format, e.g. 'America/New_York', 'US/Eastern')
  botTimezone: process.env.BOT_TIMEZONE || 'UTC',

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

  // SFTP file paths
  ftpHost: process.env.FTP_HOST || '',
  ftpPort: parseInt(process.env.FTP_PORT, 10) || 8821,
  ftpUser: process.env.FTP_USER || '',
  ftpPassword: process.env.FTP_PASSWORD || '',
  ftpLogPath: process.env.FTP_LOG_PATH || '/HumanitZServer/HMZLog.log',
  ftpConnectLogPath: process.env.FTP_CONNECT_LOG_PATH || '/HumanitZServer/PlayerConnectedLog.txt',
  ftpIdMapPath: process.env.FTP_ID_MAP_PATH || '/HumanitZServer/PlayerIDMapped.txt',
  ftpSavePath: process.env.FTP_SAVE_PATH || '/HumanitZServer/Saved/SaveGames/SaveList/Default/Save_DedicatedSaveMP.sav',
  ftpSettingsPath: process.env.FTP_SETTINGS_PATH || '/HumanitZServer/GameServerSettings.ini',
  ftpWelcomePath: process.env.FTP_WELCOME_PATH || '/HumanitZServer/WelcomeMessage.txt',
  logPollInterval: parseInt(process.env.LOG_POLL_INTERVAL, 10) || 30000,   // 30 sec
  logChannelId: process.env.LOG_CHANNEL_ID || '',

  // Save-file parser
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

  // Thread mode — when true (default), chat/activity go into daily threads.
  // When false, messages post directly to the channel.
  useChatThreads: envBool('USE_CHAT_THREADS', true),
  useActivityThreads: envBool('USE_ACTIVITY_THREADS', true),

  // PvP scheduler
  enablePvpScheduler: envBool('ENABLE_PVP_SCHEDULER', false),
  pvpStartMinutes: envTime('PVP_START_TIME'),   // total minutes from midnight (supports "HH" or "HH:MM")
  pvpEndMinutes: envTime('PVP_END_TIME'),       // total minutes from midnight (supports "HH" or "HH:MM")
  pvpTimezone: process.env.PVP_TIMEZONE || process.env.BOT_TIMEZONE || 'UTC',
  pvpRestartDelay: parseInt(process.env.PVP_RESTART_DELAY, 10) || 10,
  pvpUpdateServerName: envBool('PVP_UPDATE_SERVER_NAME', false),
  pvpDays: (() => {
    const val = process.env.PVP_DAYS;
    if (!val || val.trim() === '') return null; // null = every day
    const dayNames = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
                       sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
    const days = new Set();
    for (const part of val.split(',')) {
      const t = part.trim().toLowerCase();
      if (t in dayNames) days.add(dayNames[t]);
      else if (/^[0-6]$/.test(t)) days.add(parseInt(t, 10));
    }
    return days.size > 0 ? days : null;
  })(),

  // First-run / data repair
  firstRun: envBool('FIRST_RUN', false),

  // Feature toggles — log watcher sub-features
  enableKillFeed: envBool('ENABLE_KILL_FEED', true),   // post zombie kill batches to activity thread
  enablePvpKillFeed: envBool('ENABLE_PVP_KILL_FEED', true), // post PvP kills to activity thread
  pvpKillWindow: parseInt(process.env.PVP_KILL_WINDOW, 10) || 60000, // ms window to attribute a kill after damage (default 60s; log timestamps are minute-precision)

  // Feature toggles — auto-message sub-features (all on by default)
  enableAutoMsgLink: envBool('ENABLE_AUTO_MSG_LINK', true),
  enableAutoMsgPromo: envBool('ENABLE_AUTO_MSG_PROMO', true),
  enableWelcomeFile: envBool('ENABLE_WELCOME_FILE', true),          // SFTP-managed WelcomeMessage.txt
  welcomeFileLines: (process.env.WELCOME_FILE_LINES || '').split('|').map(s => s.trim()).filter(Boolean),

  // Feature toggles — player stats embed sections
  showRaidStats: envBool('SHOW_RAID_STATS', false),       // default: off (PVE)
  showPvpKills: envBool('SHOW_PVP_KILLS', false),         // "Last 10 PvP Kills" on overview embed
  showVitals: envBool('SHOW_VITALS', true),               // default: on
  showStatusEffects: envBool('SHOW_STATUS_EFFECTS', true), // default: on
  showInventory: envBool('SHOW_INVENTORY', true),          // default: on
  showRecipes: envBool('SHOW_RECIPES', true),              // default: on
  showLore: envBool('SHOW_LORE', true),                    // default: on
  showConnections: envBool('SHOW_CONNECTIONS', true),      // default: on

  // Feature toggles — server status embed sections
  showServerSettings: envBool('SHOW_SERVER_SETTINGS', true),     // server settings grid from GameServerSettings.ini
  showExtendedSettings: envBool('SHOW_EXTENDED_SETTINGS', true), // bandits, companions, territory, vehicles in settings grid
  showLootScarcity: envBool('SHOW_LOOT_SCARCITY', true),         // loot rarity breakdown
  showWeatherOdds: envBool('SHOW_WEATHER_ODDS', false),          // weather multiplier breakdown (off by default — niche)
  showServerVersion: envBool('SHOW_SERVER_VERSION', true),       // version from RCON info
  showServerPerformance: envBool('SHOW_SERVER_PERFORMANCE', true), // FPS + AI count from RCON info
  showServerDay: envBool('SHOW_SERVER_DAY', true),               // in-game day number
  showSeasonProgress: envBool('SHOW_SEASON_PROGRESS', true),     // day X/Y within current season

  // Feature toggles — player stats embed extras
  showChallengeDescriptions: envBool('SHOW_CHALLENGE_DESCRIPTIONS', true), // show challenge descriptions alongside progress

  // Feature toggles — log watcher: death loop detection
  enableDeathLoopDetection: envBool('ENABLE_DEATH_LOOP_DETECTION', true), // collapse rapid-fire death embeds
  deathLoopThreshold: parseInt(process.env.DEATH_LOOP_THRESHOLD, 10) || 3, // deaths within window to trigger
  deathLoopWindow: parseInt(process.env.DEATH_LOOP_WINDOW, 10) || 60000,   // time window in ms (default 60s)

  // Feature toggles — overview embed leaderboards
  showMostBitten: envBool('SHOW_MOST_BITTEN', true),             // most bitten leaderboard (from save)
  showMostFish: envBool('SHOW_MOST_FISH', true),                 // most fish caught leaderboard (from save)
  showWeeklyStats: envBool('SHOW_WEEKLY_STATS', true),           // weekly leaderboards alongside all-time
  weeklyResetDay: parseInt(process.env.WEEKLY_RESET_DAY, 10) || 1, // day to reset weekly baseline (0=Sun … 6=Sat, default 1=Mon)
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
module.exports._envBool = envBool;
module.exports._envTime = envTime;

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

/**
 * Check whether a section is visible for a given user.
 * Returns true when the toggle is enabled AND either the admin-only flag is off
 * or the user is a Discord admin.
 *
 * @param {string} toggleKey  - Config key for the section toggle (e.g. 'showVitals')
 * @param {boolean} isAdmin   - Whether the requesting user passes isAdminView()
 * @returns {boolean}
 */
function canShow(toggleKey, isAdmin = false) {
  if (!config[toggleKey]) return false;
  const adminOnlyKey = toggleKey + 'AdminOnly';
  if (config[adminOnlyKey] && !isAdmin) return false;
  return true;
}

/**
 * Check whether a Discord GuildMember has admin-view access.
 * Returns true if the member has ANY of the permissions listed in ADMIN_VIEW_PERMISSIONS.
 * Uses Discord's built-in permission system — no manual role config needed.
 *
 * @param {import('discord.js').GuildMember|null} member
 * @returns {boolean}
 */
function isAdminView(member) {
  if (!member?.permissions) return false;
  return config.adminViewPermissions.some(p => member.permissions.has(p));
}

/**
 * Add all configured admin users and role members to a Discord thread.
 * Resolves ADMIN_USER_IDS (explicit) + ADMIN_ROLE_IDS (fetches role members).
 * Requires GuildMembers intent for role member resolution.
 *
 * @param {import('discord.js').ThreadChannel} thread
 * @param {import('discord.js').Guild} guild
 */
async function addAdminMembers(thread, guild) {
  // Explicit user IDs
  for (const uid of config.adminUserIds) {
    thread.members.add(uid).catch(() => {});
  }
  // Role-based — requires GuildMembers privileged intent
  for (const roleId of config.adminRoleIds) {
    try {
      const role = guild.roles.cache.get(roleId) || await guild.roles.fetch(roleId);
      if (!role) continue;
      // Ensure members are cached
      if (guild.members.cache.size <= 1) await guild.members.fetch();
      for (const [uid] of role.members) {
        thread.members.add(uid).catch(() => {});
      }
    } catch (e) {
      if (e.code === 50001 || /disallowed intents|privileged/i.test(e.message)) {
        console.error(`[CONFIG] ADMIN_ROLE_IDS requires the "Server Members Intent" to be enabled in the Discord Developer Portal (Bot → Privileged Gateway Intents).`);
      } else {
        console.warn(`[CONFIG] Could not resolve role ${roleId}:`, e.message);
      }
    }
  }
}

const config = {
  // Discord
  discordToken: process.env.DISCORD_TOKEN,
  clientId: process.env.DISCORD_CLIENT_ID,
  guildId: process.env.DISCORD_GUILD_ID,
  adminChannelId: process.env.ADMIN_CHANNEL_ID,
  chatChannelId: process.env.CHAT_CHANNEL_ID || '',  // defaults to adminChannelId if empty
  serverStatusChannelId: process.env.SERVER_STATUS_CHANNEL_ID,
  panelChannelId: process.env.PANEL_CHANNEL_ID || '',
  adminUserIds: (process.env.ADMIN_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean),
  adminRoleIds: (process.env.ADMIN_ROLE_IDS || '').split(',').map(s => s.trim()).filter(Boolean),
  adminAlertChannelIds: (process.env.ADMIN_ALERT_CHANNEL_IDS || '').split(',').map(s => s.trim()).filter(Boolean),

  // Discord permissions that grant "admin view" for admin-only embed sections.
  // Comma-separated permission names from Discord.js PermissionFlagsBits.
  // Default: Administrator. Examples: ManageGuild, ManageChannels, ManageRoles
  adminViewPermissions: (process.env.ADMIN_VIEW_PERMISSIONS || 'Administrator').split(',').map(s => s.trim()).filter(Boolean),

  // RCON
  rconHost: process.env.RCON_HOST,
  rconPort: parseInt(process.env.RCON_PORT, 10) || 27015,
  rconPassword: process.env.RCON_PASSWORD,

  // Game server connection port (shown in server-status embed for direct connect)
  gamePort: process.env.GAME_PORT || '',

  // Short display name for this server (used in daily thread titles and summaries).
  // Multi-server instances use the 'name' field in servers.json instead.
  serverName: process.env.SERVER_NAME || '',

  // Timezone for daily threads / summaries (IANA format, e.g. 'America/New_York', 'US/Eastern')
  botTimezone: process.env.BOT_TIMEZONE || 'UTC',

  // Timezone the game server writes log timestamps in (IANA format, default UTC).
  // Most dedicated-server hosts (Bisect, Nitrado, etc.) run in UTC.
  logTimezone: process.env.LOG_TIMEZONE || 'UTC',

  // Behavior
  chatPollInterval: Math.max(parseInt(process.env.CHAT_POLL_INTERVAL, 10) || 10000, 5000),
  statusCacheTtl: Math.max(parseInt(process.env.STATUS_CACHE_TTL, 10) || 30000, 10000),
  statusChannelInterval: Math.max(parseInt(process.env.STATUS_CHANNEL_INTERVAL, 10) || 300000, 60000), // min 1 min
  serverStatusInterval: Math.max(parseInt(process.env.SERVER_STATUS_INTERVAL, 10) || 30000, 15000),

  // Auto-messages
  discordInviteLink: process.env.DISCORD_INVITE_LINK || '',
  autoMsgLinkInterval: Math.max(parseInt(process.env.AUTO_MSG_LINK_INTERVAL, 10) || 1800000, 60000),      // min 1 min
  autoMsgPromoInterval: Math.max(parseInt(process.env.AUTO_MSG_PROMO_INTERVAL, 10) || 2700000, 60000),    // min 1 min
  autoMsgJoinCheckInterval: Math.max(parseInt(process.env.AUTO_MSG_JOIN_CHECK, 10) || 10000, 5000),      // min 5 sec
  autoMsgLinkText: process.env.AUTO_MSG_LINK_TEXT || '',       // custom discord link broadcast (blank = default)
  autoMsgPromoText: process.env.AUTO_MSG_PROMO_TEXT || '',     // custom promo broadcast (blank = default)

  // SFTP file paths
  ftpHost: process.env.FTP_HOST || '',
  ftpPort: parseInt(process.env.FTP_PORT, 10) || 8821,
  ftpUser: process.env.FTP_USER || '',
  ftpPassword: process.env.FTP_PASSWORD || '',
  ftpBasePath: (process.env.FTP_BASE_PATH || '').replace(/\/+$/, ''),  // strip trailing slash
  ftpLogPath: process.env.FTP_LOG_PATH || '/HumanitZServer/HMZLog.log',
  ftpConnectLogPath: process.env.FTP_CONNECT_LOG_PATH || '/HumanitZServer/PlayerConnectedLog.txt',
  ftpIdMapPath: process.env.FTP_ID_MAP_PATH || '/HumanitZServer/PlayerIDMapped.txt',
  ftpSavePath: process.env.FTP_SAVE_PATH || '/HumanitZServer/Saved/SaveGames/SaveList/Default/Save_DedicatedSaveMP.sav',
  ftpSettingsPath: process.env.FTP_SETTINGS_PATH || '/HumanitZServer/GameServerSettings.ini',
  ftpWelcomePath: process.env.FTP_WELCOME_PATH || '/HumanitZServer/WelcomeMessage.txt',
  logPollInterval: Math.max(parseInt(process.env.LOG_POLL_INTERVAL, 10) || 30000, 10000),   // min 10 sec
  logChannelId: process.env.LOG_CHANNEL_ID || '',

  // Pterodactyl / panel API (CPU, RAM, disk monitoring)
  // PANEL_SERVER_URL is the full URL when viewing your server in the panel
  // e.g. https://games.bisecthosting.com/server/a1b2c3d4
  panelServerUrl: process.env.PANEL_SERVER_URL || '',
  panelApiKey: process.env.PANEL_API_KEY || '',

  // Enable the /panel slash command (power, console, backups, status)
  // Requires PANEL_SERVER_URL + PANEL_API_KEY to be set.
  enablePanel: envBool('ENABLE_PANEL', true),

  // SSH resource monitoring (reuses FTP_HOST/FTP_USER/FTP_PASSWORD)
  enableSshResources: envBool('ENABLE_SSH_RESOURCES', false),
  sshPort: parseInt(process.env.SSH_PORT, 10) || 0,   // 0 = use FTP_PORT

  // Cache TTL for resource metrics (default 30s)
  resourceCacheTtl: Math.max(parseInt(process.env.RESOURCE_CACHE_TTL, 10) || 30000, 10000),

  // Save-file parser
  savePollInterval: Math.max(parseInt(process.env.SAVE_POLL_INTERVAL, 10) || 300000, 60000),  // min 1 min

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

  // Per-day PvP hour overrides: PVP_HOURS_MON=18:00-22:00, etc.
  // Falls back to PVP_START_TIME / PVP_END_TIME when not set for a day.
  pvpDayHours: (() => {
    const dayKeys = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
    const map = new Map(); // dayNum → { start, end } (total minutes from midnight)
    for (let d = 0; d < 7; d++) {
      const val = process.env[`PVP_HOURS_${dayKeys[d]}`];
      if (!val || !val.includes('-')) continue;
      const [startStr, endStr] = val.split('-');
      const parseHM = (s) => { const p = s.trim().split(':'); return parseInt(p[0], 10) * 60 + (parseInt(p[1], 10) || 0); };
      const start = parseHM(startStr);
      const end = parseHM(endStr);
      if (!isNaN(start) && !isNaN(end)) map.set(d, { start, end });
    }
    return map.size > 0 ? map : null;
  })(),

  // First-run / data repair
  firstRun: envBool('FIRST_RUN', false),

  // Experimental — one-shot thread rebuild on startup
  nukeThreads: envBool('NUKE_THREADS', false),

  // Feature toggles — log watcher sub-features
  enableKillFeed: envBool('ENABLE_KILL_FEED', true),   // post zombie kill batches to activity thread
  enablePvpKillFeed: envBool('ENABLE_PVP_KILL_FEED', true), // post PvP kills to activity thread
  pvpKillWindow: parseInt(process.env.PVP_KILL_WINDOW, 10) || 60000, // ms window to attribute a kill after damage (default 60s; log timestamps are minute-precision)

  // Feature toggles — auto-message sub-features (all on by default)
  enableAutoMsgLink: envBool('ENABLE_AUTO_MSG_LINK', true),
  enableAutoMsgPromo: envBool('ENABLE_AUTO_MSG_PROMO', true),
  enableWelcomeMsg: envBool('ENABLE_WELCOME_MSG', true),            // RCON admin welcome on player join
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

  // Admin-only flags — when true, that section is only shown to Discord users
  // with the Administrator permission. Auto-detected from the server, no role config needed.
  showVitalsAdminOnly: envBool('SHOW_VITALS_ADMIN_ONLY', false),
  showStatusEffectsAdminOnly: envBool('SHOW_STATUS_EFFECTS_ADMIN_ONLY', false),
  showInventoryAdminOnly: envBool('SHOW_INVENTORY_ADMIN_ONLY', false),
  showRecipesAdminOnly: envBool('SHOW_RECIPES_ADMIN_ONLY', false),
  showLoreAdminOnly: envBool('SHOW_LORE_ADMIN_ONLY', false),
  showConnectionsAdminOnly: envBool('SHOW_CONNECTIONS_ADMIN_ONLY', false),
  showRaidStatsAdminOnly: envBool('SHOW_RAID_STATS_ADMIN_ONLY', false),
  showChallengeDescriptionsAdminOnly: envBool('SHOW_CHALLENGE_DESCRIPTIONS_ADMIN_ONLY', false),

  // Feature toggles — server status embed sections
  showServerSettings: envBool('SHOW_SERVER_SETTINGS', true),     // server settings grid from GameServerSettings.ini
  showExtendedSettings: envBool('SHOW_EXTENDED_SETTINGS', true), // bandits, companions, territory, vehicles in settings grid
  // Per-category toggles within the settings grid
  showSettingsGeneral: envBool('SHOW_SETTINGS_GENERAL', true),       // PvP, Max Players, On Death, etc.
  showSettingsTime: envBool('SHOW_SETTINGS_TIME', true),             // Day/Night/Season Length, Start Season
  showSettingsZombies: envBool('SHOW_SETTINGS_ZOMBIES', true),       // Zombie Health/Speed/Damage/Spawns/Respawn
  showSettingsItems: envBool('SHOW_SETTINGS_ITEMS', true),           // Weapon Break, Food Decay, Loot Respawn, Air Drops
  showSettingsBandits: envBool('SHOW_SETTINGS_BANDITS', true),       // Bandit stats + AI Events (requires SHOW_EXTENDED_SETTINGS)
  showSettingsCompanions: envBool('SHOW_SETTINGS_COMPANIONS', true), // Dog Companion, Companion HP/Dmg (requires SHOW_EXTENDED_SETTINGS)
  showSettingsBuilding: envBool('SHOW_SETTINGS_BUILDING', true),     // Building HP/Decay, Gen Fuel, Territory, Dismantle (requires SHOW_EXTENDED_SETTINGS)
  showSettingsVehicles: envBool('SHOW_SETTINGS_VEHICLES', true),     // Max Cars (requires SHOW_EXTENDED_SETTINGS)
  showSettingsAnimals: envBool('SHOW_SETTINGS_ANIMALS', true),       // Animal Spawns/Respawn (requires SHOW_EXTENDED_SETTINGS)
  showLootScarcity: envBool('SHOW_LOOT_SCARCITY', true),         // loot rarity breakdown
  showWeatherOdds: envBool('SHOW_WEATHER_ODDS', false),          // weather multiplier breakdown (off by default — niche)
  showServerVersion: envBool('SHOW_SERVER_VERSION', true),       // version from RCON info
  showServerPerformance: envBool('SHOW_SERVER_PERFORMANCE', true), // FPS + AI count from RCON info
  showHostResources: envBool('SHOW_HOST_RESOURCES', true),       // CPU/RAM/disk from panel API or SSH
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
  weeklyResetDay: (() => { const v = parseInt(process.env.WEEKLY_RESET_DAY, 10); return isNaN(v) ? 1 : v; })(), // day to reset weekly baseline (0=Sun … 6=Sat, default 1=Mon)
};

// Prepend FTP_BASE_PATH to all FTP file paths when set
if (config.ftpBasePath) {
  const prefix = config.ftpBasePath;
  const ftpKeys = ['ftpLogPath', 'ftpConnectLogPath', 'ftpIdMapPath', 'ftpSavePath', 'ftpSettingsPath', 'ftpWelcomePath'];
  for (const key of ftpKeys) {
    if (config[key] && !config[key].startsWith(prefix)) {
      config[key] = prefix + (config[key].startsWith('/') ? '' : '/') + config[key];
    }
  }
  console.log(`[CONFIG] FTP base path: ${prefix}`);
}

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

// ── Log-timestamp parser ────────────────────────────────────
// Converts a log timestamp (written in LOG_TIMEZONE) to a proper UTC Date.
// Components come straight from the regex match: all are strings.

function _tzOffsetMs(utcDate, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(utcDate);

  const y = parts.find(p => p.type === 'year').value;
  const m = parts.find(p => p.type === 'month').value;
  const d = parts.find(p => p.type === 'day').value;
  let h = parts.find(p => p.type === 'hour').value;
  if (h === '24') h = '00'; // midnight edge case
  const mn = parts.find(p => p.type === 'minute').value;
  const s = parts.find(p => p.type === 'second').value;

  const localAsUtc = new Date(`${y}-${m}-${d}T${h}:${mn}:${s}Z`);
  return localAsUtc.getTime() - utcDate.getTime();
}

config.parseLogTimestamp = function (year, month, day, hour, min) {
  const pad = n => String(n).padStart(2, '0');
  const iso = `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(min)}:00Z`;
  const asUtc = new Date(iso);

  const tz = config.logTimezone;
  if (tz === 'UTC') return asUtc;

  // First pass: compute offset at the "as-if-UTC" time
  const offset1 = _tzOffsetMs(asUtc, tz);
  const corrected = new Date(asUtc.getTime() - offset1);

  // Second pass: offset may differ at corrected time (DST edge)
  const offset2 = _tzOffsetMs(corrected, tz);
  if (offset2 !== offset1) {
    return new Date(asUtc.getTime() - offset2);
  }
  return corrected;
};

console.log(`[CONFIG] Timezone: ${config.botTimezone}, Log timezone: ${config.logTimezone}`);

module.exports = config;
module.exports.canShow = canShow;
module.exports.isAdminView = isAdminView;
module.exports.addAdminMembers = addAdminMembers;
module.exports._envBool = envBool;
module.exports._envTime = envTime;
module.exports._tzOffsetMs = _tzOffsetMs;

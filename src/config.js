const _cfgFs = require('fs');
const _cfgPath = require('path');

// ── Bootstrap: generate .env from template if missing ────────
const _envPath = _cfgPath.join(__dirname, '..', '.env');
const _examplePath = _cfgPath.join(__dirname, '..', '.env.example');
if (!_cfgFs.existsSync(_envPath)) {
  if (_cfgFs.existsSync(_examplePath)) {
    _cfgFs.copyFileSync(_examplePath, _envPath);
  }
  console.log('');
  console.log('══════════════════════════════════════════════════════════');
  console.log('  .env file created from template.');
  console.log('  Open .env and set your Discord credentials:');
  console.log('    DISCORD_TOKEN, DISCORD_CLIENT_ID, DISCORD_GUILD_ID');
  console.log('  Then set RCON and SFTP credentials for your game server.');
  console.log('  See .env.example comments for guidance.');
  console.log('══════════════════════════════════════════════════════════');
  console.log('');
  process.exit(0);
}

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
  discordClientSecret: process.env.DISCORD_OAUTH_SECRET || '',
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

  // Public IP for server-status embed (if different from rconHost for localhost setups)
  publicHost: process.env.PUBLIC_HOST || process.env.RCON_HOST,

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

  // Bot display language (en, zh-TW, zh-CN)
  botLocale: process.env.BOT_LOCALE || 'en',

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
  ftpPort: parseInt(process.env.FTP_PORT, 10) || 2022,
  ftpUser: process.env.FTP_USER || '',
  ftpPassword: process.env.FTP_PASSWORD || '',
  ftpPrivateKeyPath: process.env.FTP_PRIVATE_KEY_PATH || '',  // path to SSH private key (optional, replaces password auth)
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

  // Game settings editor in panel channel (requires SFTP credentials)
  enableGameSettingsEditor: envBool('ENABLE_GAME_SETTINGS_EDITOR', true),

  // SSH resource monitoring (reuses FTP_HOST/FTP_USER/FTP_PASSWORD)
  enableSshResources: envBool('ENABLE_SSH_RESOURCES', false),
  sshPort: parseInt(process.env.SSH_PORT, 10) || 0,   // 0 = use FTP_PORT

  // Trust proxy setting for the web panel Express app.
  // Default 'loopback' trusts Caddy/nginx on localhost.
  // Set to '1' or 'uniquelocal' for Pterodactyl Docker networking (Bisect bot hosting).
  // Set to a CIDR (e.g. '172.16.0.0/12') for specific Docker subnets.
  // See: https://expressjs.com/en/guide/behind-proxies.html
  webMapTrustProxy: process.env.WEB_MAP_TRUST_PROXY || 'loopback',

  // Interactive stdin console for headless hosts (Bisect, etc.)
  enableStdinConsole: envBool('ENABLE_STDIN_CONSOLE', false),
  stdinConsoleWritable: envBool('STDIN_CONSOLE_WRITABLE', false),

  // Cache TTL for resource metrics (default 30s)
  resourceCacheTtl: Math.max(parseInt(process.env.RESOURCE_CACHE_TTL, 10) || 30000, 10000),

  // Save-file parser
  savePollInterval: Math.max(parseInt(process.env.SAVE_POLL_INTERVAL, 10) || 300000, 60000),  // min 1 min

  // Agent mode — offloads save parsing to the game server for faster updates.
  // 'auto' = try agent first, fall back to direct .sav download
  // 'agent' = agent only (fail if unavailable)
  // 'direct' = always download full .sav (no agent)
  agentMode: (process.env.AGENT_MODE || 'auto').toLowerCase(),
  agentNodePath: process.env.AGENT_NODE_PATH || 'node',     // path to Node.js on game server
  agentRemoteDir: process.env.AGENT_REMOTE_DIR || '',        // where to upload agent (default: same dir as save)
  agentCachePath: process.env.AGENT_CACHE_PATH || '',        // explicit path to humanitz-cache.json (for host-managed agents)
  agentTimeout: Math.max(parseInt(process.env.AGENT_TIMEOUT, 10) || 120000, 10000),  // max wait for agent exec

  // Agent trigger — how the bot tells the game server to generate the cache.
  // 'auto'  = try RCON+Panel API (Pterodactyl/Bisect), then SSH, then skip
  // 'rcon'  = RCON/console command only (e.g. createHZSocket on Bisect Hosting)
  // 'panel' = Pterodactyl panel console command (sends via websocket console)
  // 'ssh'   = SSH exec only
  // 'none'  = don't trigger — assume host runs the agent externally
  agentTrigger: (process.env.AGENT_TRIGGER || 'auto').toLowerCase(),
  agentPanelCommand: process.env.AGENT_PANEL_COMMAND || 'createHZSocket',  // RCON/console command to trigger cache generation
  agentPanelDelay: Math.max(parseInt(process.env.AGENT_PANEL_DELAY, 10) || 3000, 500),  // ms to wait after sending command before checking for cache

  // Agent poll interval — used instead of SAVE_POLL_INTERVAL when agent mode is active.
  // Agent downloads a ~200-500KB cache vs the full ~60MB .sav, so faster polling is safe.
  // Default 90s, min 30s.  Set to 0 to use SAVE_POLL_INTERVAL for both modes.
  agentPollInterval: parseInt(process.env.AGENT_POLL_INTERVAL, 10) || 90000,

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
  enableMilestones: envBool('ENABLE_MILESTONES', false),
  enableRecaps: envBool('ENABLE_RECAPS', false),
  enableAnticheat: envBool('ENABLE_ANTICHEAT', false),
  anticheatAnalyzeInterval: parseInt(process.env.ANTICHEAT_ANALYZE_INTERVAL, 10) || 60_000,
  anticheatBaselineInterval: parseInt(process.env.ANTICHEAT_BASELINE_INTERVAL, 10) || 900_000,

  // Howyagarn — dev-only feature incubator (all default off)
  enableDidYouKnow: envBool('ENABLE_DID_YOU_KNOW', false),
  enablePlayerCards: envBool('ENABLE_PLAYER_CARDS', false),
  enableNewspaper: envBool('ENABLE_NEWSPAPER', false),

  // Howyagarn MMOlite — faction PvP / territory control system
  enableHowyagarn: envBool('ENABLE_HOWYAGARN', false),
  howyagarnChannelId: process.env.HOWYAGARN_CHANNEL_ID || '',

  // hzmod native plugin (private — howyagarn repo only)
  hzmodServerId: process.env.HZMOD_SERVER_ID || '',       // multi-server id the plugin belongs to
  hzmodSocketPath: process.env.HZMOD_SOCKET_PATH || '',   // Unix socket path for IPC
  hzmodStatusPath: process.env.HZMOD_STATUS_PATH || '',   // JSON status file written by plugin

  // Thread mode — when true (default), chat/activity go into daily threads.
  // When false, messages post directly to the channel.
  useChatThreads: envBool('USE_CHAT_THREADS', true),
  useActivityThreads: envBool('USE_ACTIVITY_THREADS', true),

  // PvP scheduler
  enablePvpScheduler: envBool('ENABLE_PVP_SCHEDULER', false),

  // Server scheduler — timed restarts with dynamic difficulty profiles
  enableServerScheduler: envBool('ENABLE_SERVER_SCHEDULER', false),
  restartTimes: process.env.RESTART_TIMES || '',          // comma-separated HH:MM times in BOT_TIMEZONE
  restartProfiles: process.env.RESTART_PROFILES || '',    // comma-separated profile names (cycle order)
  restartDelay: parseInt(process.env.RESTART_DELAY, 10) || 10, // countdown minutes before restart
  restartRotateDaily: envBool('RESTART_ROTATE_DAILY', true), // shift profile order each day
  dockerContainer: process.env.DOCKER_CONTAINER || '',    // Docker container name for restart commands
  serverNameTemplate: process.env.SERVER_NAME_TEMPLATE || '', // e.g. "[EU1] Howyagarn PVE | Current Mode: {mode} | Dynamic Difficulty"

  // Activity log — tracks item movements, horse changes, world events from save diffs
  enableActivityLog: envBool('ENABLE_ACTIVITY_LOG', true),
  activityLogChannelId: process.env.ACTIVITY_LOG_CHANNEL_ID || '',

  // Activity log sub-toggles
  enableContainerLog: envBool('ENABLE_CONTAINER_LOG', true),     // container item add/remove
  enableHorseLog: envBool('ENABLE_HORSE_LOG', true),             // horse appeared/disappeared/health
  enableVehicleLog: envBool('ENABLE_VEHICLE_LOG', true),         // vehicle trunk changes
  showInventoryLog: envBool('SHOW_INVENTORY_LOG', false),        // player inventory changes (off by default — sensitive)
  showInventoryLogAdminOnly: envBool('SHOW_INVENTORY_LOG_ADMIN_ONLY', true), // restrict inventory log to admins
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

  // Settings overrides when PvP is ON — JSON object of GameServerSettings.ini keys.
  // These values are applied when PvP enables and reverted when PvP disables.
  // Example: {"OnDeath":"0","VitalDrain":"1","ZombieDiffDamage":"3"}
  pvpSettingsOverrides: (() => {
    const raw = process.env.PVP_SETTINGS_OVERRIDES;
    if (!raw || !raw.trim()) return null;
    try { return JSON.parse(raw); } catch (e) {
      console.error('[CONFIG] Invalid PVP_SETTINGS_OVERRIDES JSON:', e.message);
      return null;
    }
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

  // Factory reset — wipes all bot messages from Discord, deletes local data,
  // re-imports from server logs, and rebuilds everything fresh.
  // Runs once on startup, then automatically sets itself back to false.
  nukeBot: envBool('NUKE_BOT', false) || envBool('NUKE_THREADS', false),  // backward compat

  // Feature toggles — log watcher sub-features
  enableKillFeed: envBool('ENABLE_KILL_FEED', true),   // post zombie kill batches to activity thread
  enablePvpKillFeed: envBool('ENABLE_PVP_KILL_FEED', true), // post PvP kills to activity thread
  pvpKillWindow: parseInt(process.env.PVP_KILL_WINDOW, 10) || 60000, // ms window to attribute a kill after damage (default 60s; log timestamps are minute-precision)

  // Save-based activity feeds — posted to activity thread from save-file diffs
  enableFishingFeed: envBool('ENABLE_FISHING_FEED', true),       // "Player caught 3 fish"
  enableRecipeFeed: envBool('ENABLE_RECIPE_FEED', true),         // "Player learned Firearm, Furnace"
  enableSkillFeed: envBool('ENABLE_SKILL_FEED', true),           // "Player unlocked Mechanic skill"
  enableProfessionFeed: envBool('ENABLE_PROFESSION_FEED', true), // "Player unlocked Mechanic"
  enableLoreFeed: envBool('ENABLE_LORE_FEED', true),             // "Player found 2 lore entries"
  enableUniqueFeed: envBool('ENABLE_UNIQUE_FEED', true),         // "Player found unique item"
  enableCompanionFeed: envBool('ENABLE_COMPANION_FEED', true),   // "Player tamed a companion"
  enableChallengeFeed: envBool('ENABLE_CHALLENGE_FEED', true),    // "Player completed Bear Hunter"
  enableWorldEventFeed: envBool('ENABLE_WORLD_EVENT_FEED', true), // season/day changes, airdrops

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
  showSkills: envBool('SHOW_SKILLS', true),                // default: on
  showConnections: envBool('SHOW_CONNECTIONS', true),      // default: on

  // Fine-grained sub-toggles (parent section must also be enabled)
  // Vitals sub-stats
  showHealth: envBool('SHOW_HEALTH', true),
  showHunger: envBool('SHOW_HUNGER', true),
  showThirst: envBool('SHOW_THIRST', true),
  showStamina: envBool('SHOW_STAMINA', true),
  showImmunity: envBool('SHOW_IMMUNITY', true),
  showBattery: envBool('SHOW_BATTERY', true),
  // Status effects sub-sections
  showPlayerStates: envBool('SHOW_PLAYER_STATES', true),
  showBodyConditions: envBool('SHOW_BODY_CONDITIONS', true),
  showInfectionBuildup: envBool('SHOW_INFECTION_BUILDUP', true),
  showFatigue: envBool('SHOW_FATIGUE', true),
  // Inventory sub-sections
  showEquipment: envBool('SHOW_EQUIPMENT', true),
  showQuickSlots: envBool('SHOW_QUICK_SLOTS', true),
  showPockets: envBool('SHOW_POCKETS', true),
  showBackpack: envBool('SHOW_BACKPACK', true),
  // Recipes sub-sections
  showCraftingRecipes: envBool('SHOW_CRAFTING_RECIPES', true),
  showBuildingRecipes: envBool('SHOW_BUILDING_RECIPES', true),
  // Connections sub-sections
  showConnectCount: envBool('SHOW_CONNECT_COUNT', true),
  showAdminAccess: envBool('SHOW_ADMIN_ACCESS', true),
  // Raid sub-sections
  showRaidsOut: envBool('SHOW_RAIDS_OUT', true),          // raids initiated
  showRaidsIn: envBool('SHOW_RAIDS_IN', true),            // raids received
  // Coordinates
  showCoordinates: envBool('SHOW_COORDINATES', false),    // default: off (sensitive)
  showCoordinatesAdminOnly: envBool('SHOW_COORDINATES_ADMIN_ONLY', true), // admin-only when shown

  // Container / horse display flags (for embeds and web map)
  showContainers: envBool('SHOW_CONTAINERS', true),              // show container info on player/world stats
  showContainersAdminOnly: envBool('SHOW_CONTAINERS_ADMIN_ONLY', true), // restrict to admins
  showHorses: envBool('SHOW_HORSES', true),                      // show horse info in world stats
  showHorsesAdminOnly: envBool('SHOW_HORSES_ADMIN_ONLY', false), // horse info is public by default

  // Admin-only flags — when true, that section is only shown to Discord users
  // with the Administrator permission. Auto-detected from the server, no role config needed.
  showVitalsAdminOnly: envBool('SHOW_VITALS_ADMIN_ONLY', false),
  showStatusEffectsAdminOnly: envBool('SHOW_STATUS_EFFECTS_ADMIN_ONLY', false),
  showInventoryAdminOnly: envBool('SHOW_INVENTORY_ADMIN_ONLY', false),
  showRecipesAdminOnly: envBool('SHOW_RECIPES_ADMIN_ONLY', false),
  showLoreAdminOnly: envBool('SHOW_LORE_ADMIN_ONLY', false),
  showSkillsAdminOnly: envBool('SHOW_SKILLS_ADMIN_ONLY', false),
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
  showWorldStats: envBool('SHOW_WORLD_STATS', true),             // structures, vehicles, zombie kills from save

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

// Prepend FTP_BASE_PATH to all FTP file paths when set (only for relative paths)
if (config.ftpBasePath) {
  const prefix = config.ftpBasePath;
  const ftpKeys = ['ftpLogPath', 'ftpConnectLogPath', 'ftpIdMapPath', 'ftpSavePath', 'ftpSettingsPath', 'ftpWelcomePath'];
  for (const key of ftpKeys) {
    // Only prepend if path doesn't start with / (relative path indicator)
    if (config[key] && !config[key].startsWith('/')) {
      config[key] = prefix + '/' + config[key];
    }
  }
  console.log(`[CONFIG] FTP base path: ${prefix}`);
}

// Validate required values — Discord credentials are always needed.
// RCON is optional: if missing, the bot starts in setup wizard mode so the user
// can configure everything through the panel channel's interactive wizard.
const required = ['discordToken', 'clientId', 'guildId'];
for (const key of required) {
  if (!config[key] || config[key].startsWith('your_')) {
    console.error(`[CONFIG] Missing or placeholder value for: ${key}`);
    console.error(`         Please configure your .env file. See .env.example for reference.`);
    process.exit(1);
  }
}

// Flag so modules know whether RCON/SFTP are ready
config.needsSetup = !config.rconHost || !config.rconPassword || config.rconHost.startsWith('your_') || config.rconPassword.startsWith('your_');

if (!config.panelChannelId) {
  console.warn('[CONFIG] PANEL_CHANNEL_ID not set — panel channel will be disabled.');
  console.warn('         The panel channel is the bot\'s admin dashboard. Set a channel ID in .env');
  console.warn('         to enable the setup wizard, server controls, and settings editor.');
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

// ── SFTP connection config helper ─────────────────────────
// Builds a connection object for ssh2-sftp-client.
// Supports both password and SSH key authentication.
// Used by: log-watcher, player-stats-channel, pvp-scheduler, multi-server

config.sftpConnectConfig = function () {
  // Use 'this' so multi-server merged configs resolve their own SFTP settings
  const self = this && this.ftpHost ? this : config;
  const cfg = {
    host: self.ftpHost,
    port: self.ftpPort,
    username: self.ftpUser,
  };
  if (self.ftpPrivateKeyPath) {
    try {
      cfg.privateKey = _cfgFs.readFileSync(self.ftpPrivateKeyPath);
      // If a password is also set, use it as the passphrase for the key
      if (self.ftpPassword) cfg.passphrase = self.ftpPassword;
    } catch (err) {
      console.error(`[CONFIG] Could not read SSH private key at ${self.ftpPrivateKeyPath}:`, err.message);
      // Fall back to password auth
      cfg.password = self.ftpPassword;
    }
  } else {
    cfg.password = self.ftpPassword;
  }
  return cfg;
};

/**
 * Get the effective save poll interval based on whether agent mode is active.
 * When agent mode is not 'direct' and AGENT_POLL_INTERVAL is set (non-zero),
 * use the faster agent interval since it only downloads a ~200-500KB cache.
 */
config.getEffectiveSavePollInterval = function () {
  if (config.agentMode !== 'direct' && config.agentPollInterval > 0) {
    return Math.max(config.agentPollInterval, 30000);  // min 30s
  }
  return config.savePollInterval;
};

// ── Display settings overlay (DB-backed) ────────────────────
// Display toggles and feed toggles are stored in bot_state so they're
// runtime-configurable via the panel channel without editing .env.
// On startup, loadDisplayOverrides() reads saved values from the DB
// and overlays them onto the config object. The .env values serve as
// initial defaults for first-run only.

/**
 * Load display setting overrides from the DB's bot_state table.
 * Called once after DB init in index.js.
 * @param {object} db - HumanitZDB instance
 */
config.loadDisplayOverrides = function (db) {
  if (!db) return;
  try {
    const overrides = db.getStateJSON('display_settings', null);
    if (!overrides || typeof overrides !== 'object') return;
    let count = 0;
    for (const [key, value] of Object.entries(overrides)) {
      if (key in config) {
        config[key] = value;
        count++;
      }
    }
    if (count > 0) {
      console.log(`[CONFIG] Loaded ${count} display setting override(s) from DB`);
    }
  } catch (err) {
    console.warn('[CONFIG] Could not load display overrides:', err.message);
  }
};

/**
 * Save a single display setting to the DB and update config in memory.
 * @param {object} db - HumanitZDB instance
 * @param {string} cfgKey - Config key (e.g. 'showVitals')
 * @param {*} value - New value
 */
config.saveDisplaySetting = function (db, cfgKey, value) {
  config[cfgKey] = value;
  if (!db) return;
  try {
    const overrides = db.getStateJSON('display_settings', {});
    overrides[cfgKey] = value;
    db.setStateJSON('display_settings', overrides);
  } catch (err) {
    console.warn('[CONFIG] Could not save display override:', err.message);
  }
};

/**
 * Save multiple display settings to the DB and update config in memory.
 * @param {object} db - HumanitZDB instance
 * @param {Object<string,*>} settings - Map of cfgKey → value
 */
config.saveDisplaySettings = function (db, settings) {
  for (const [key, value] of Object.entries(settings)) {
    config[key] = value;
  }
  if (!db) return;
  try {
    const overrides = db.getStateJSON('display_settings', {});
    Object.assign(overrides, settings);
    db.setStateJSON('display_settings', overrides);
  } catch (err) {
    console.warn('[CONFIG] Could not save display overrides:', err.message);
  }
};

module.exports = config;
module.exports.canShow = canShow;
module.exports.isAdminView = isAdminView;
module.exports.addAdminMembers = addAdminMembers;
module.exports._envBool = envBool;
module.exports._envTime = envTime;
module.exports._tzOffsetMs = _tzOffsetMs;

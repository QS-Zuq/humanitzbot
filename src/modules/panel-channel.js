/**
 * Panel Channel — unified admin dashboard.
 *
 * Single message with stacked embeds showing bot, primary server,
 * and any managed servers. A view selector switches which controls
 * are active. Admin-only channel. Requires PANEL_CHANNEL_ID.
 */

const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
  PermissionFlagsBits,
  MessageFlags,
} = require('discord.js');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const panelApi = require('../server/panel-api');
const SftpClient = require('ssh2-sftp-client');
const { formatBytes, formatUptime } = require('../server/server-resources');
const MultiServerManager = require('../server/multi-server');
const { loadServers, saveServers, createServerConfig } = require('../server/multi-server');
const { blockBar: _progressBar } = require('../server/server-display');

// ── State colour map ────────────────────────────────────────
const STATE_DISPLAY = {
  running:  { emoji: '🟢', label: 'Running',  color: 0x2ecc71 },
  starting: { emoji: '🟡', label: 'Starting', color: 0xf1c40f },
  stopping: { emoji: '🟠', label: 'Stopping', color: 0xe67e22 },
  offline:  { emoji: '🔴', label: 'Offline',  color: 0xe74c3c },
};

function _stateInfo(state) {
  return STATE_DISPLAY[state] || { emoji: '⚪', label: state || 'Unknown', color: 0x95a5a6 };
}

/** Find common parent directory from an array of absolute paths. */
function _findCommonParent(paths) {
  if (paths.length === 0) return '/';
  if (paths.length === 1) return path.dirname(paths[0]);
  const segments = paths.map(p => p.split('/').filter(Boolean));
  let depth = 0;
  const min = Math.min(...segments.map(s => s.length));
  for (let i = 0; i < min; i++) {
    if (segments.every(s => s[i] === segments[0][i])) depth = i + 1;
    else break;
  }
  return depth > 0 ? '/' + segments[0].slice(0, depth).join('/') : '/';
}

// ── Custom IDs ──────────────────────────────────────────────
const BTN = {
  START:        'panel_start',
  STOP:         'panel_stop',
  RESTART:      'panel_restart',
  BACKUP:       'panel_backup',
  KILL:         'panel_kill',
  BOT_RESTART:  'panel_bot_restart',
  NUKE:         'panel_nuke',
  REIMPORT:     'panel_reimport',
  ADD_SERVER:   'panel_add_server',
  WELCOME_EDIT: 'panel_welcome_edit',
  BROADCASTS:   'panel_broadcasts',
  DIAGNOSTICS:  'panel_diagnostics',
  ENV_SYNC:     'panel_env_sync',
};

const SELECT = {
  ENV:      'panel_env_select',
  ENV2:     'panel_env_select2',
  SETTINGS: 'panel_settings_select',
  SERVER:   'panel_server_select',
  VIEW:     'panel_view_select',
};

// ── Setup wizard custom IDs ─────────────────────────────────
const SETUP = {
  PROFILE_VPS:    'setup_profile_vps',
  PROFILE_BISECT: 'setup_profile_bisect',
  PROFILE_RCON:   'setup_profile_rcon',
  RCON_BTN:       'setup_rcon_btn',
  SFTP_BTN:       'setup_sftp_btn',
  CHANNELS_BTN:   'setup_channels_btn',
  APPLY_BTN:      'setup_apply',
  SKIP_SFTP_BTN:  'setup_skip_sftp',
  RCON_MODAL:     'setup_rcon_modal',
  SFTP_MODAL:     'setup_sftp_modal',
  CHANNELS_MODAL: 'setup_channels_modal',
};// ── Env categories ──────────────────────────────────────────
// Max 5 fields per category (Discord modal limit).
// `cfg` = config.js key for live apply. `type` = value parser.
// `restart` = true when bot restart is required for the change to take effect.
// `sensitive` = true hides the current value in the modal (passwords / API keys).
// `style` = 'paragraph' for multi-line TextInput.
// `group` = 1 (core settings select) or 2 (display / schedule select).

const ENV_CATEGORIES = [
  // ── Group 1: Core & Module Settings ────────────────────────
  {
    id: 'channels', label: 'Channel IDs', emoji: '📺', group: 1,
    description: 'Discord channel assignments (restart required)',
    restart: true,
    fields: [
      { env: 'ADMIN_CHANNEL_ID', label: 'Admin Channel', cfg: 'adminChannelId' },
      { env: 'CHAT_CHANNEL_ID', label: 'Chat Channel', cfg: 'chatChannelId' },
      { env: 'LOG_CHANNEL_ID', label: 'Log Channel', cfg: 'logChannelId' },
      { env: 'SERVER_STATUS_CHANNEL_ID', label: 'Server Status', cfg: 'serverStatusChannelId' },
      { env: 'PLAYER_STATS_CHANNEL_ID', label: 'Player Stats', cfg: 'playerStatsChannelId' },
    ],
  },
  {
    id: 'server_identity', label: 'Server & Identity', emoji: '🏷️', group: 1,
    description: 'Server name, panel channel, editor toggles (restart)',
    restart: true,
    fields: [
      { env: 'SERVER_NAME', label: 'Server Display Name', cfg: 'serverName' },
      { env: 'PANEL_CHANNEL_ID', label: 'Panel Channel', cfg: 'panelChannelId' },
      { env: 'GAME_PORT', label: 'Game Port (direct connect)', cfg: 'gamePort' },
      { env: 'ENABLE_GAME_SETTINGS_EDITOR', label: 'Settings Editor (true/false)', cfg: 'enableGameSettingsEditor', type: 'bool' },
      { env: 'ENABLE_SSH_RESOURCES', label: 'SSH Resources (true/false)', cfg: 'enableSshResources', type: 'bool' },
    ],
  },
  {
    id: 'admin', label: 'Admin Settings', emoji: '🛡️', group: 1,
    description: 'Admin users, roles, and alert channels (restart)',
    restart: true,
    fields: [
      { env: 'ADMIN_USER_IDS', label: 'Admin User IDs (comma-sep)' },
      { env: 'ADMIN_ROLE_IDS', label: 'Admin Role IDs (comma-sep)' },
      { env: 'ADMIN_ALERT_CHANNEL_IDS', label: 'Alert Channel IDs (comma-sep)' },
      { env: 'ADMIN_VIEW_PERMISSIONS', label: 'Admin View Perms (e.g. Administrator)' },
    ],
  },
  {
    id: 'credentials', label: 'RCON & Panel API', emoji: '🔑', group: 1,
    description: 'Connection credentials (restart required)',
    restart: true,
    fields: [
      { env: 'RCON_HOST', label: 'RCON Host', cfg: 'rconHost' },
      { env: 'RCON_PORT', label: 'RCON Port', cfg: 'rconPort', type: 'int' },
      { env: 'RCON_PASSWORD', label: 'RCON Password', sensitive: true },
      { env: 'PANEL_SERVER_URL', label: 'Panel Server URL' },
      { env: 'PANEL_API_KEY', label: 'Panel API Key', sensitive: true },
    ],
  },
  {
    id: 'sftp', label: 'SFTP Connection', emoji: '📂', group: 1,
    description: 'SFTP host, credentials, base path (restart)',
    restart: true,
    fields: [
      { env: 'FTP_HOST', label: 'SFTP Host', cfg: 'ftpHost' },
      { env: 'FTP_PORT', label: 'SFTP Port', cfg: 'ftpPort', type: 'int' },
      { env: 'FTP_USER', label: 'SFTP Username', cfg: 'ftpUser' },
      { env: 'FTP_PASSWORD', label: 'SFTP Password', sensitive: true },
      { env: 'FTP_BASE_PATH', label: 'Base Path Prefix', cfg: 'ftpBasePath' },
    ],
  },
  {
    id: 'sftp_paths', label: 'SFTP File Paths', emoji: '📁', group: 1,
    description: 'Auto-discovered paths — override if needed (restart)',
    restart: true,
    fields: [
      { env: 'FTP_LOG_PATH', label: 'Log File Path' },
      { env: 'FTP_CONNECT_LOG_PATH', label: 'Player Connect Log' },
      { env: 'FTP_ID_MAP_PATH', label: 'Player ID Map' },
      { env: 'FTP_SAVE_PATH', label: 'Save File Path' },
      { env: 'FTP_SETTINGS_PATH', label: 'Settings INI Path' },
    ],
  },
  {
    id: 'agent', label: 'Save Agent', emoji: '🤖', group: 1,
    description: 'Remote save-parser agent (restart required)',
    restart: true,
    fields: [
      { env: 'AGENT_MODE', label: 'Mode (auto/agent/direct)', cfg: 'agentMode' },
      { env: 'AGENT_TRIGGER', label: 'Trigger (auto/ssh/panel/none)', cfg: 'agentTrigger' },
      { env: 'AGENT_POLL_INTERVAL', label: 'Agent Poll Interval (ms)', cfg: 'agentPollInterval', type: 'int' },
      { env: 'AGENT_TIMEOUT', label: 'Timeout (ms)', cfg: 'agentTimeout', type: 'int' },
      { env: 'AGENT_NODE_PATH', label: 'Remote Node.js Path', cfg: 'agentNodePath' },
    ],
  },
  {
    id: 'features1', label: 'Module Toggles', emoji: '⚡', group: 1,
    description: 'Enable/disable core modules (restart required)',
    restart: true,
    fields: [
      { env: 'ENABLE_STATUS_CHANNELS', label: 'Status Channels (true/false)', cfg: 'enableStatusChannels', type: 'bool' },
      { env: 'ENABLE_SERVER_STATUS', label: 'Server Status (true/false)', cfg: 'enableServerStatus', type: 'bool' },
      { env: 'ENABLE_CHAT_RELAY', label: 'Chat Relay (true/false)', cfg: 'enableChatRelay', type: 'bool' },
      { env: 'ENABLE_AUTO_MESSAGES', label: 'Auto Messages (true/false)', cfg: 'enableAutoMessages', type: 'bool' },
      { env: 'ENABLE_LOG_WATCHER', label: 'Log Watcher (true/false)', cfg: 'enableLogWatcher', type: 'bool' },
    ],
  },
  {
    id: 'features2', label: 'Module Toggles 2', emoji: '⚡', group: 1,
    description: 'More toggles (restart required)',
    restart: true,
    fields: [
      { env: 'ENABLE_PLAYER_STATS', label: 'Player Stats (true/false)', cfg: 'enablePlayerStats', type: 'bool' },
      { env: 'ENABLE_PLAYTIME', label: 'Playtime (true/false)', cfg: 'enablePlaytime', type: 'bool' },
      { env: 'ENABLE_PVP_SCHEDULER', label: 'PvP Scheduler (true/false)', cfg: 'enablePvpScheduler', type: 'bool' },
      { env: 'ENABLE_PANEL', label: 'Panel (true/false)', cfg: 'enablePanel', type: 'bool' },
      { env: 'ENABLE_KILL_FEED', label: 'Kill Feed (true/false)', cfg: 'enableKillFeed', type: 'bool' },
    ],
  },
  {
    id: 'automsg', label: 'Auto Messages', emoji: '📢', group: 1,
    description: 'Broadcast & welcome toggles (restart required)',
    restart: true,
    fields: [
      { env: 'DISCORD_INVITE_LINK', label: 'Discord Invite Link', cfg: 'discordInviteLink' },
      { env: 'ENABLE_AUTO_MSG_LINK', label: 'Link Broadcast (true/false)', cfg: 'enableAutoMsgLink', type: 'bool' },
      { env: 'ENABLE_AUTO_MSG_PROMO', label: 'Promo Broadcast (true/false)', cfg: 'enableAutoMsgPromo', type: 'bool' },
      { env: 'ENABLE_WELCOME_MSG', label: 'RCON Welcome (true/false)', cfg: 'enableWelcomeMsg', type: 'bool' },
      { env: 'ENABLE_WELCOME_FILE', label: 'Welcome File SFTP (true/false)', cfg: 'enableWelcomeFile', type: 'bool' },
    ],
  },
  {
    id: 'automsg_custom', label: 'Custom Messages', emoji: '📝', group: 1,
    description: 'Custom broadcast text and welcome lines (restart)',
    restart: true,
    fields: [
      { env: 'AUTO_MSG_LINK_TEXT', label: 'Custom Link Broadcast', cfg: 'autoMsgLinkText' },
      { env: 'AUTO_MSG_PROMO_TEXT', label: 'Custom Promo Broadcast', cfg: 'autoMsgPromoText' },
      { env: 'WELCOME_FILE_LINES', label: 'Welcome Lines (pipe-separated)' },
      { env: 'FTP_WELCOME_PATH', label: 'Welcome File Path' },
    ],
  },
  {
    id: 'log_features', label: 'Log Features', emoji: '📋', group: 1,
    description: 'Kill feed & death loop (restart required)',
    restart: true,
    fields: [
      { env: 'ENABLE_PVP_KILL_FEED', label: 'PvP Kill Feed (true/false)', cfg: 'enablePvpKillFeed', type: 'bool' },
      { env: 'PVP_KILL_WINDOW', label: 'Kill Window (ms)', cfg: 'pvpKillWindow', type: 'int' },
      { env: 'ENABLE_DEATH_LOOP_DETECTION', label: 'Death Loop (true/false)', cfg: 'enableDeathLoopDetection', type: 'bool' },
      { env: 'DEATH_LOOP_THRESHOLD', label: 'Loop Threshold (count)', cfg: 'deathLoopThreshold', type: 'int' },
      { env: 'DEATH_LOOP_WINDOW', label: 'Loop Window (ms)', cfg: 'deathLoopWindow', type: 'int' },
    ],
  },
  {
    id: 'activity_feeds', label: 'Activity Feeds', emoji: '📰', group: 1,
    description: 'Save-based activity feed toggles (applies live)',
    restart: false,
    fields: [
      { env: 'ENABLE_FISHING_FEED', label: 'Fishing Feed (true/false)', cfg: 'enableFishingFeed', type: 'bool' },
      { env: 'ENABLE_RECIPE_FEED', label: 'Recipe Feed (true/false)', cfg: 'enableRecipeFeed', type: 'bool' },
      { env: 'ENABLE_SKILL_FEED', label: 'Skill Feed (true/false)', cfg: 'enableSkillFeed', type: 'bool' },
      { env: 'ENABLE_PROFESSION_FEED', label: 'Profession Feed (true/false)', cfg: 'enableProfessionFeed', type: 'bool' },
      { env: 'ENABLE_LORE_FEED', label: 'Lore Feed (true/false)', cfg: 'enableLoreFeed', type: 'bool' },
    ],
  },
  {
    id: 'activity_feeds2', label: 'Activity Feeds 2', emoji: '📰', group: 1,
    description: 'More save-based feeds (applies live)',
    restart: false,
    fields: [
      { env: 'ENABLE_UNIQUE_FEED', label: 'Unique Item Feed (true/false)', cfg: 'enableUniqueFeed', type: 'bool' },
      { env: 'ENABLE_COMPANION_FEED', label: 'Companion Feed (true/false)', cfg: 'enableCompanionFeed', type: 'bool' },
      { env: 'ENABLE_WORLD_EVENT_FEED', label: 'World Event Feed (true/false)', cfg: 'enableWorldEventFeed', type: 'bool' },
    ],
  },
  {
    id: 'intervals', label: 'Poll Intervals', emoji: '⏱️', group: 1,
    description: 'Update frequencies in ms (restart required)',
    restart: true,
    fields: [
      { env: 'SERVER_STATUS_INTERVAL', label: 'Status Refresh (ms)', cfg: 'serverStatusInterval', type: 'int' },
      { env: 'LOG_POLL_INTERVAL', label: 'Log Poll (ms)', cfg: 'logPollInterval', type: 'int' },
      { env: 'SAVE_POLL_INTERVAL', label: 'Save Poll (ms)', cfg: 'savePollInterval', type: 'int' },
      { env: 'CHAT_POLL_INTERVAL', label: 'Chat Poll (ms)', cfg: 'chatPollInterval', type: 'int' },
      { env: 'STATUS_CHANNEL_INTERVAL', label: 'Voice Channel (ms)', cfg: 'statusChannelInterval', type: 'int' },
    ],
  },
  {
    id: 'advanced', label: 'Advanced', emoji: '⚙️', group: 1,
    description: 'Cache TTLs, auto-msg intervals (restart required)',
    restart: true,
    fields: [
      { env: 'STATUS_CACHE_TTL', label: 'RCON Cache TTL (ms)', cfg: 'statusCacheTtl', type: 'int' },
      { env: 'RESOURCE_CACHE_TTL', label: 'Resource Cache TTL (ms)', cfg: 'resourceCacheTtl', type: 'int' },
      { env: 'AUTO_MSG_LINK_INTERVAL', label: 'Link Broadcast (ms)', cfg: 'autoMsgLinkInterval', type: 'int' },
      { env: 'AUTO_MSG_PROMO_INTERVAL', label: 'Promo Broadcast (ms)', cfg: 'autoMsgPromoInterval', type: 'int' },
      { env: 'AUTO_MSG_JOIN_CHECK', label: 'Join Check (ms)', cfg: 'autoMsgJoinCheckInterval', type: 'int' },
    ],
  },
  // ── Group 2: Display & Schedule Settings ───────────────────
  {
    id: 'display_player', label: 'Display: Player', emoji: '👤', group: 2,
    description: 'Player stats sections (applies live)',
    restart: false,
    fields: [
      { env: 'SHOW_VITALS', label: 'Vitals (true/false)', cfg: 'showVitals', type: 'bool' },
      { env: 'SHOW_STATUS_EFFECTS', label: 'Status Effects (true/false)', cfg: 'showStatusEffects', type: 'bool' },
      { env: 'SHOW_INVENTORY', label: 'Inventory (true/false)', cfg: 'showInventory', type: 'bool' },
      { env: 'SHOW_RECIPES', label: 'Recipes (true/false)', cfg: 'showRecipes', type: 'bool' },
      { env: 'SHOW_LORE', label: 'Lore (true/false)', cfg: 'showLore', type: 'bool' },
    ],
  },
  {
    id: 'sub_vitals', label: 'Sub: Vitals', emoji: '❤️', group: 2,
    description: 'Individual vital stats (parent: Vitals)',
    restart: false,
    fields: [
      { env: 'SHOW_HEALTH', label: 'Health (true/false)', cfg: 'showHealth', type: 'bool' },
      { env: 'SHOW_HUNGER', label: 'Hunger (true/false)', cfg: 'showHunger', type: 'bool' },
      { env: 'SHOW_THIRST', label: 'Thirst (true/false)', cfg: 'showThirst', type: 'bool' },
      { env: 'SHOW_STAMINA', label: 'Stamina (true/false)', cfg: 'showStamina', type: 'bool' },
      { env: 'SHOW_IMMUNITY', label: 'Immunity (true/false)', cfg: 'showImmunity', type: 'bool' },
    ],
  },
  {
    id: 'sub_status', label: 'Sub: Status Effects', emoji: '🩹', group: 2,
    description: 'Individual status effect types (parent: Status Effects)',
    restart: false,
    fields: [
      { env: 'SHOW_BATTERY', label: 'Battery (true/false)', cfg: 'showBattery', type: 'bool' },
      { env: 'SHOW_PLAYER_STATES', label: 'Player States (true/false)', cfg: 'showPlayerStates', type: 'bool' },
      { env: 'SHOW_BODY_CONDITIONS', label: 'Body Conditions (true/false)', cfg: 'showBodyConditions', type: 'bool' },
      { env: 'SHOW_INFECTION_BUILDUP', label: 'Infection % (true/false)', cfg: 'showInfectionBuildup', type: 'bool' },
      { env: 'SHOW_FATIGUE', label: 'Fatigue (true/false)', cfg: 'showFatigue', type: 'bool' },
    ],
  },
  {
    id: 'sub_inventory', label: 'Sub: Inventory', emoji: '🎒', group: 2,
    description: 'Individual inventory slots (parent: Inventory)',
    restart: false,
    fields: [
      { env: 'SHOW_EQUIPMENT', label: 'Equipment (true/false)', cfg: 'showEquipment', type: 'bool' },
      { env: 'SHOW_QUICK_SLOTS', label: 'Quick Slots (true/false)', cfg: 'showQuickSlots', type: 'bool' },
      { env: 'SHOW_POCKETS', label: 'Pockets (true/false)', cfg: 'showPockets', type: 'bool' },
      { env: 'SHOW_BACKPACK', label: 'Backpack (true/false)', cfg: 'showBackpack', type: 'bool' },
      { env: 'SHOW_COORDINATES', label: 'Coordinates (true/false)', cfg: 'showCoordinates', type: 'bool' },
    ],
  },
  {
    id: 'sub_misc', label: 'Sub: Recipes/Conn/Raid', emoji: '📋', group: 2,
    description: 'Recipes, connections, raid sub-toggles',
    restart: false,
    fields: [
      { env: 'SHOW_CRAFTING_RECIPES', label: 'Crafting Recipes (true/false)', cfg: 'showCraftingRecipes', type: 'bool' },
      { env: 'SHOW_BUILDING_RECIPES', label: 'Building Recipes (true/false)', cfg: 'showBuildingRecipes', type: 'bool' },
      { env: 'SHOW_CONNECT_COUNT', label: 'Connect Count (true/false)', cfg: 'showConnectCount', type: 'bool' },
      { env: 'SHOW_RAIDS_OUT', label: 'Raids Out (true/false)', cfg: 'showRaidsOut', type: 'bool' },
      { env: 'SHOW_RAIDS_IN', label: 'Raids In (true/false)', cfg: 'showRaidsIn', type: 'bool' },
    ],
  },
  {
    id: 'sub_access', label: 'Sub: Access/Lore', emoji: '🔐', group: 2,
    description: 'Admin access, coordinate privacy, lore/skills',
    restart: false,
    fields: [
      { env: 'SHOW_ADMIN_ACCESS', label: 'Admin Access (true/false)', cfg: 'showAdminAccess', type: 'bool' },
      { env: 'SHOW_COORDINATES_ADMIN_ONLY', label: 'Coords Admin-Only (true/false)', cfg: 'showCoordinatesAdminOnly', type: 'bool' },
      { env: 'SHOW_LORE', label: 'Lore (true/false)', cfg: 'showLore', type: 'bool' },
      { env: 'SHOW_SKILLS', label: 'Skills (true/false)', cfg: 'showSkills', type: 'bool' },
    ],
  },
  {
    id: 'display_server', label: 'Display: Server', emoji: '🖥️', group: 2,
    description: 'Server status sections (applies live)',
    restart: false,
    fields: [
      { env: 'SHOW_SERVER_SETTINGS', label: 'Server Settings (true/false)', cfg: 'showServerSettings', type: 'bool' },
      { env: 'SHOW_LOOT_SCARCITY', label: 'Loot Scarcity (true/false)', cfg: 'showLootScarcity', type: 'bool' },
      { env: 'SHOW_WEATHER_ODDS', label: 'Weather Odds (true/false)', cfg: 'showWeatherOdds', type: 'bool' },
      { env: 'SHOW_HOST_RESOURCES', label: 'Host Resources (true/false)', cfg: 'showHostResources', type: 'bool' },
      { env: 'SHOW_SERVER_PERFORMANCE', label: 'Performance (true/false)', cfg: 'showServerPerformance', type: 'bool' },
    ],
  },
  {
    id: 'display_extra', label: 'Display: Extra', emoji: '📊', group: 2,
    description: 'Additional display toggles (applies live)',
    restart: false,
    fields: [
      { env: 'SHOW_RAID_STATS', label: 'Raid Stats (true/false)', cfg: 'showRaidStats', type: 'bool' },
      { env: 'SHOW_PVP_KILLS', label: 'PvP Kills (true/false)', cfg: 'showPvpKills', type: 'bool' },
      { env: 'SHOW_CONNECTIONS', label: 'Connections (true/false)', cfg: 'showConnections', type: 'bool' },
      { env: 'SHOW_CHALLENGE_DESCRIPTIONS', label: 'Challenge Desc. (true/false)', cfg: 'showChallengeDescriptions', type: 'bool' },
      { env: 'SHOW_WEEKLY_STATS', label: 'Weekly Stats (true/false)', cfg: 'showWeeklyStats', type: 'bool' },
    ],
  },
  {
    id: 'display_more', label: 'Display: Status', emoji: '📺', group: 2,
    description: 'Server status extras (applies live)',
    restart: false,
    fields: [
      { env: 'SHOW_EXTENDED_SETTINGS', label: 'Extended Settings (true/false)', cfg: 'showExtendedSettings', type: 'bool' },
      { env: 'SHOW_SERVER_VERSION', label: 'Server Version (true/false)', cfg: 'showServerVersion', type: 'bool' },
      { env: 'SHOW_SERVER_DAY', label: 'In-Game Day (true/false)', cfg: 'showServerDay', type: 'bool' },
      { env: 'SHOW_SEASON_PROGRESS', label: 'Season Progress (true/false)', cfg: 'showSeasonProgress', type: 'bool' },
      { env: 'SHOW_MOST_BITTEN', label: 'Most Bitten Board (true/false)', cfg: 'showMostBitten', type: 'bool' },
    ],
  },
  {
    id: 'display_settings', label: 'Settings Grid', emoji: '🔧', group: 2,
    description: 'Per-category settings grid toggles (applies live)',
    restart: false,
    fields: [
      { env: 'SHOW_SETTINGS_GENERAL', label: 'General (true/false)', cfg: 'showSettingsGeneral', type: 'bool' },
      { env: 'SHOW_SETTINGS_TIME', label: 'Time & Seasons (true/false)', cfg: 'showSettingsTime', type: 'bool' },
      { env: 'SHOW_SETTINGS_ZOMBIES', label: 'Zombies (true/false)', cfg: 'showSettingsZombies', type: 'bool' },
      { env: 'SHOW_SETTINGS_ITEMS', label: 'Items & Loot (true/false)', cfg: 'showSettingsItems', type: 'bool' },
      { env: 'SHOW_SETTINGS_BANDITS', label: 'Bandits (true/false)', cfg: 'showSettingsBandits', type: 'bool' },
    ],
  },
  {
    id: 'display_settings2', label: 'Settings Grid 2', emoji: '🔧', group: 2,
    description: 'More settings grid toggles (applies live)',
    restart: false,
    fields: [
      { env: 'SHOW_SETTINGS_COMPANIONS', label: 'Companions (true/false)', cfg: 'showSettingsCompanions', type: 'bool' },
      { env: 'SHOW_SETTINGS_BUILDING', label: 'Building (true/false)', cfg: 'showSettingsBuilding', type: 'bool' },
      { env: 'SHOW_SETTINGS_VEHICLES', label: 'Vehicles (true/false)', cfg: 'showSettingsVehicles', type: 'bool' },
      { env: 'SHOW_SETTINGS_ANIMALS', label: 'Animals (true/false)', cfg: 'showSettingsAnimals', type: 'bool' },
    ],
  },
  {
    id: 'admin_only', label: 'Admin-Only Sections', emoji: '🔒', group: 2,
    description: 'Restrict sections to Discord admins (applies live)',
    restart: false,
    fields: [
      { env: 'SHOW_VITALS_ADMIN_ONLY', label: 'Vitals (true/false)', cfg: 'showVitalsAdminOnly', type: 'bool' },
      { env: 'SHOW_STATUS_EFFECTS_ADMIN_ONLY', label: 'Status Effects (true/false)', cfg: 'showStatusEffectsAdminOnly', type: 'bool' },
      { env: 'SHOW_INVENTORY_ADMIN_ONLY', label: 'Inventory (true/false)', cfg: 'showInventoryAdminOnly', type: 'bool' },
      { env: 'SHOW_RECIPES_ADMIN_ONLY', label: 'Recipes (true/false)', cfg: 'showRecipesAdminOnly', type: 'bool' },
      { env: 'SHOW_LORE_ADMIN_ONLY', label: 'Lore (true/false)', cfg: 'showLoreAdminOnly', type: 'bool' },
    ],
  },
  {
    id: 'admin_only2', label: 'Admin-Only 2', emoji: '🔒', group: 2,
    description: 'More admin-only restrictions (applies live)',
    restart: false,
    fields: [
      { env: 'SHOW_CONNECTIONS_ADMIN_ONLY', label: 'Connections (true/false)', cfg: 'showConnectionsAdminOnly', type: 'bool' },
      { env: 'SHOW_RAID_STATS_ADMIN_ONLY', label: 'Raid Stats (true/false)', cfg: 'showRaidStatsAdminOnly', type: 'bool' },
      { env: 'SHOW_CHALLENGE_DESCRIPTIONS_ADMIN_ONLY', label: 'Challenges (true/false)', cfg: 'showChallengeDescriptionsAdminOnly', type: 'bool' },
    ],
  },
  {
    id: 'timezone', label: 'Timezone', emoji: '🌐', group: 2,
    description: 'Time settings (restart required)',
    restart: true,
    fields: [
      { env: 'BOT_TIMEZONE', label: 'Bot Timezone (IANA)', cfg: 'botTimezone' },
      { env: 'LOG_TIMEZONE', label: 'Log Timezone (IANA)', cfg: 'logTimezone' },
    ],
  },
  {
    id: 'threads_misc', label: 'Threads & Misc', emoji: '🧵', group: 2,
    description: 'Thread mode, leaderboards, SSH (restart required)',
    restart: true,
    fields: [
      { env: 'USE_CHAT_THREADS', label: 'Chat in Threads (true/false)', cfg: 'useChatThreads', type: 'bool' },
      { env: 'USE_ACTIVITY_THREADS', label: 'Activity Threads (true/false)', cfg: 'useActivityThreads', type: 'bool' },
      { env: 'SHOW_MOST_FISH', label: 'Most Fish Board (true/false)', cfg: 'showMostFish', type: 'bool' },
      { env: 'WEEKLY_RESET_DAY', label: 'Weekly Reset (0=Sun,1=Mon..6=Sat)', cfg: 'weeklyResetDay', type: 'int' },
      { env: 'SSH_PORT', label: 'SSH Port (blank = FTP_PORT)', cfg: 'sshPort', type: 'int' },
    ],
  },
  {
    id: 'activity_log', label: 'Activity Log', emoji: '📋', group: 2,
    description: 'Save-diff activity log toggles (restart required)',
    restart: true,
    fields: [
      { env: 'ENABLE_ACTIVITY_LOG', label: 'Enable Activity Log (true/false)', cfg: 'enableActivityLog', type: 'bool' },
      { env: 'ENABLE_CONTAINER_LOG', label: 'Container Log (true/false)', cfg: 'enableContainerLog', type: 'bool' },
      { env: 'ENABLE_HORSE_LOG', label: 'Horse Log (true/false)', cfg: 'enableHorseLog', type: 'bool' },
      { env: 'ENABLE_VEHICLE_LOG', label: 'Vehicle Log (true/false)', cfg: 'enableVehicleLog', type: 'bool' },
      { env: 'SHOW_INVENTORY_LOG', label: 'Inventory Log (true/false)', cfg: 'showInventoryLog', type: 'bool' },
    ],
  },
  {
    id: 'pvp', label: 'PvP Schedule', emoji: '⚔️', group: 2,
    description: 'PvP times, delay, server name (restart required)',
    restart: true,
    fields: [
      { env: 'PVP_START_TIME', label: 'Default Start (HH:MM)' },
      { env: 'PVP_END_TIME', label: 'Default End (HH:MM)' },
      { env: 'PVP_RESTART_DELAY', label: 'Restart Delay (min)', cfg: 'pvpRestartDelay', type: 'int' },
      { env: 'PVP_UPDATE_SERVER_NAME', label: 'Update Name (true/false)', cfg: 'pvpUpdateServerName', type: 'bool' },
      { env: 'PVP_DAYS', label: 'Days (e.g. Mon,Wed,Fri)' },
    ],
  },
  {
    id: 'pvp_hours', label: 'PvP Daily Hours', emoji: '📅', group: 2,
    description: 'Per-day PvP hour overrides (restart required)',
    restart: true,
    fields: [
      { env: 'PVP_HOURS_MON', label: 'Monday (HH:MM-HH:MM)' },
      { env: 'PVP_HOURS_TUE', label: 'Tuesday (HH:MM-HH:MM)' },
      { env: 'PVP_HOURS_WED', label: 'Wednesday (HH:MM-HH:MM)' },
      { env: 'PVP_HOURS_THU', label: 'Thursday (HH:MM-HH:MM)' },
      { env: 'PVP_HOURS_FRI', label: 'Friday (HH:MM-HH:MM)' },
    ],
  },
  {
    id: 'pvp_extra', label: 'PvP Weekend & Overrides', emoji: '📅', group: 2,
    description: 'Weekend hours + settings override JSON (restart)',
    restart: true,
    fields: [
      { env: 'PVP_HOURS_SAT', label: 'Saturday (HH:MM-HH:MM)' },
      { env: 'PVP_HOURS_SUN', label: 'Sunday (HH:MM-HH:MM)' },
      { env: 'PVP_SETTINGS_OVERRIDES', label: 'Settings Override JSON', style: 'paragraph' },
    ],
  },

];

// ── Game settings categories ────────────────────────────────
// Each maps to GameServerSettings.ini keys.
// All game settings require a server restart to take effect.

const GAME_SETTINGS_CATEGORIES = [
  {
    id: 'general', label: 'General', emoji: '⚔️',
    settings: [
      { ini: 'PVP', label: 'PvP (0=Off, 1=On)' },
      { ini: 'MaxPlayers', label: 'Max Players' },
      { ini: 'OnDeath', label: 'On Death (0=BP, 1=+Pock, 2=All)' },
      { ini: 'PermaDeath', label: 'Perma Death (0=Off, 1=Ind, 2=All)' },
      { ini: 'VitalDrain', label: 'Vital Drain (0=Slow,1=Norm,2=Fast)' },
    ],
  },
  {
    id: 'time', label: 'Time & Seasons', emoji: '🕐',
    settings: [
      { ini: 'DayDur', label: 'Day Length (min)' },
      { ini: 'NightDur', label: 'Night Length (min)' },
      { ini: 'DaysPerSeason', label: 'Days Per Season' },
      { ini: 'StartingSeason', label: 'Season (0=Sum,1=Aut,2=Win,3=Spr)' },
      { ini: 'FreezeTime', label: 'Freeze When Empty (0/1)' },
    ],
  },
  {
    id: 'zombies', label: 'Zombies', emoji: '🧟',
    settings: [
      { ini: 'ZombieDiffHealth', label: 'Health (0=VEasy → 5=Nmre)' },
      { ini: 'ZombieDiffSpeed', label: 'Speed (0=VEasy → 5=Nmre)' },
      { ini: 'ZombieDiffDamage', label: 'Damage (0=VEasy → 5=Nmre)' },
      { ini: 'ZombieAmountMulti', label: 'Spawn Multiplier (0-2)' },
      { ini: 'ZombieRespawnTimer', label: 'Respawn Timer (min)' },
    ],
  },
  {
    id: 'items', label: 'Items & Loot', emoji: '🎒',
    settings: [
      { ini: 'WeaponBreak', label: 'Weapon Break (0=Off, 1=On)' },
      { ini: 'FoodDecay', label: 'Food Decay (0=Off, 1=On)' },
      { ini: 'LootRespawn', label: 'Loot Respawn (0=Off, 1=On)' },
      { ini: 'AirDrop', label: 'Air Drops (0=Off, 1=On)' },
      { ini: 'LootRespawnTimer', label: 'Loot Respawn Timer (min)' },
    ],
  },
  {
    id: 'bandits', label: 'Bandits', emoji: '🔫',
    settings: [
      { ini: 'HumanHealth', label: 'Health (0=VEasy → 5=Nmre)' },
      { ini: 'HumanSpeed', label: 'Speed (0=VEasy → 5=Nmre)' },
      { ini: 'HumanDamage', label: 'Damage (0=VEasy → 5=Nmre)' },
      { ini: 'HumanAmountMulti', label: 'Spawn Multiplier (0-2)' },
      { ini: 'AIEvent', label: 'AI Events (0=Off, 1=Low, 2=Default)' },
    ],
  },
  {
    id: 'building', label: 'Building & Territory', emoji: '🏗️',
    settings: [
      { ini: 'BuildingHealth', label: 'Building HP (0=Slow,1=Norm,2=Fast)' },
      { ini: 'BuildingDecay', label: 'Building Decay (0=Off, 1=On)' },
      { ini: 'GenFuel', label: 'Generator Fuel Rate' },
      { ini: 'Territory', label: 'Territory (0=Off, 1=On)' },
      { ini: 'MaxOwnedCars', label: 'Max Cars (0=Disabled)' },
    ],
  },
  {
    id: 'loot1', label: 'Loot Rarity 1', emoji: '🎲',
    settings: [
      { ini: 'RarityFood', label: 'Food (0=Scarce → 4=Abundant)' },
      { ini: 'RarityDrink', label: 'Drink (0=Scarce → 4=Abundant)' },
      { ini: 'RarityMelee', label: 'Melee (0=Scarce → 4=Abundant)' },
      { ini: 'RarityRanged', label: 'Ranged (0=Scarce → 4=Abundant)' },
      { ini: 'RarityAmmo', label: 'Ammo (0=Scarce → 4=Abundant)' },
    ],
  },
  {
    id: 'loot2', label: 'Loot Rarity 2', emoji: '🎲',
    settings: [
      { ini: 'RarityArmor', label: 'Armor (0=Scarce → 4=Abundant)' },
      { ini: 'RarityResources', label: 'Resources (0=Scarce → 4=Abundant)' },
      { ini: 'RarityOther', label: 'Other (0=Scarce → 4=Abundant)' },
    ],
  },
  {
    id: 'companions', label: 'Companions & Animals', emoji: '🐕',
    settings: [
      { ini: 'DogEnabled', label: 'Dog Companion (0=Off, 1=On)' },
      { ini: 'CompanionHealth', label: 'Companion HP (0=Low,1=Def,2=Hi)' },
      { ini: 'CompanionDmg', label: 'Companion Dmg (0=Low,1=Def,2=Hi)' },
      { ini: 'AnimalMulti', label: 'Animal Spawn Multiplier' },
      { ini: 'AnimalRespawnTimer', label: 'Animal Respawn (min)' },
    ],
  },
  {
    id: 'gameplay', label: 'Gameplay Toggles', emoji: '♻️',
    settings: [
      { ini: 'ClearInfection', label: 'Clear Infection on Respawn (0/1)' },
      { ini: 'EagleEye', label: 'Eagle Eye Skill (0/1)' },
      { ini: 'Voip', label: 'Voice Chat (0/1)' },
      { ini: 'MultiplayerSleep', label: 'Multiplayer Sleep (0/1)' },
      { ini: 'Sleep', label: 'Sleep Deprivation (0/1)' },
    ],
  },
  {
    id: 'spawns', label: 'Spawns & Perms', emoji: '🌍',
    settings: [
      { ini: 'LimitedSpawns', label: 'Limited Spawns (true/false)' },
      { ini: 'AllowDismantle', label: 'Allow Dismantle (0/1)' },
      { ini: 'AllowHouseDismantle', label: 'Dismantle Houses (0/1)' },
      { ini: 'RecruitDog', label: 'Recruit Dogs (0/1)' },
      { ini: 'XpMultiplier', label: 'XP Multiplier (e.g. 1, 2)' },
    ],
  },
  {
    id: 'timers2', label: 'Respawn Timers', emoji: '⏳',
    settings: [
      { ini: 'RespawnTimer', label: 'Player Respawn (sec, 0=instant)' },
      { ini: 'PickupRespawnTimer', label: 'Pickup Respawn (min)' },
      { ini: 'AirDropInterval', label: 'AirDrop Every X Days' },
      { ini: 'HumanRespawnTimer', label: 'Bandit Respawn (min)' },
      { ini: 'SaveIntervalSec', label: 'Auto-Save (sec, 0=off)' },
    ],
  },
  {
    id: 'decay', label: 'Decay & Cleanup', emoji: '🧹',
    settings: [
      { ini: 'Decay', label: 'Spawn Point Decay (real days)' },
      { ini: 'PickupCleanup', label: 'Pickup Cleanup (game days, 0=off)' },
      { ini: 'FakeBuildingCleanup', label: 'Blueprint Cleanup (min)' },
      { ini: 'ZombieDogMulti', label: 'Zombie Dog Multiplier' },
      { ini: 'DogNum', label: 'Max Wild Dogs' },
    ],
  },
  {
    id: 'weather1', label: 'Weather Odds 1', emoji: '🌤️',
    settings: [
      { ini: 'Weather_ClearSky', label: 'Clear Sky (multiplier)' },
      { ini: 'Weather_Cloudy', label: 'Cloudy (multiplier)' },
      { ini: 'Weather_Foggy', label: 'Foggy (multiplier)' },
      { ini: 'Weather_LightRain', label: 'Light Rain (multiplier)' },
      { ini: 'Weather_Rain', label: 'Rain (multiplier)' },
    ],
  },
  {
    id: 'weather2', label: 'Weather Odds 2', emoji: '⛈️',
    settings: [
      { ini: 'Weather_Thunderstorm', label: 'Thunderstorm (multiplier)' },
      { ini: 'Weather_LightSnow', label: 'Light Snow (multiplier)' },
      { ini: 'Weather_Snow', label: 'Snow (multiplier)' },
      { ini: 'Weather_Blizzard', label: 'Blizzard (multiplier)' },
    ],
  },
  {
    id: 'host', label: 'Host & Feedback', emoji: '📡',
    settings: [
      { ini: 'NoJoinFeedback', label: 'Hide Join/Leave (true/false)' },
      { ini: 'NoDeathFeedback', label: 'Hide Death Notices (0/1)' },
      { ini: 'Seg0', label: 'Spawn Seg0 (default 8)' },
      { ini: 'Seg1', label: 'Spawn Seg1 (default 12)' },
      { ini: 'Seg2', label: 'Spawn Seg2 (default 20)' },
    ],
  },
];

// ── .env file helpers ───────────────────────────────────────
const ENV_PATH = path.join(__dirname, '..', '..', '.env');

/** Read current value for an env field — process.env first, then config. */
function _getEnvValue(field) {
  const raw = process.env[field.env];
  if (raw !== undefined) return raw;
  if (field.cfg && config[field.cfg] !== undefined) return String(config[field.cfg]);
  return '';
}

/** Write key=value pairs to .env, preserving comments and formatting. */
let _envWriteLock = false;
function _writeEnvValues(updates) {
  if (_envWriteLock) throw new Error('.env write already in progress');
  _envWriteLock = true;
  try {
    let content;
    try { content = fs.readFileSync(ENV_PATH, 'utf8'); } catch { content = ''; }
    for (const [key, rawValue] of Object.entries(updates)) {
      // Sanitize: strip newlines/carriage returns to prevent env injection
      const value = String(rawValue).replace(/[\r\n]+/g, ' ');
      const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`^(#\\s*)?${escapedKey}\\s*=.*$`, 'm');
      if (regex.test(content)) {
        content = content.replace(regex, `${key}=${value}`);
      } else {
        content += `\n${key}=${value}`;
      }
      process.env[key] = value;
    }
    fs.writeFileSync(ENV_PATH, content, 'utf8');
  } finally {
    _envWriteLock = false;
  }
}

/** Apply a config value in memory for fields that support live updates. */
function _applyLiveConfig(field, value) {
  if (!field.cfg) return;
  if (field.type === 'bool') {
    config[field.cfg] = value === 'true';
  } else if (field.type === 'int') {
    const n = parseInt(value, 10);
    if (!isNaN(n)) config[field.cfg] = n;
  } else {
    config[field.cfg] = value;
  }
}

/** Read cached game server settings from bot_state. */
function _getCachedSettings(db) {
  try {
    if (db) {
      const data = db.getStateJSON('server_settings', null);
      if (data) return data;
    }
  } catch {}
  return {};
}

/** Safely build a modal title within Discord's 45-char limit. */
function _modalTitle(prefix, name, suffix) {
  const maxName = 45 - prefix.length - suffix.length;
  const truncated = name.length > maxName ? name.slice(0, maxName - 1) + '…' : name;
  return `${prefix}${truncated}${suffix}`;
}

/** Format milliseconds as "2d 5h 12m" */
function _formatBotUptime(ms) {
  const s = Math.floor(ms / 1000);
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0 || days > 0) parts.push(`${hours}h`);
  parts.push(`${mins}m`);
  return parts.join(' ');
}

// ═════════════════════════════════════════════════════════════
// PanelChannel class
// ═════════════════════════════════════════════════════════════

class PanelChannel {

  /**
   * @param {import('discord.js').Client} client
   * @param {object} opts
   * @param {object} opts.moduleStatus - reference to the moduleStatus object from index.js
   * @param {Date}   opts.startedAt    - bot startup timestamp
   */
  constructor(client, { moduleStatus = {}, startedAt = new Date(), multiServerManager = null, db = null, saveService = null, logWatcher = null } = {}) {
    this.client = client;
    this.channel = null;
    this.panelMessage = null;  // single unified panel message
    this.botMessage = null;    // alias kept for interaction handler compat (points to panelMessage)
    this._serverMessages = new Map(); // serverId → Discord message (kept for compat, unused in unified mode)
    this._lastServerKeys = new Map(); // serverId → content hash
    this.interval = null;
    this.updateIntervalMs = parseInt(config.serverStatusInterval, 10) || 30000;
    this._lastBotKey = null;
    this._lastPanelKey = null;
    this._lastState = null;
    this._backupLimit = null;
    this._activeView = 'bot'; // 'bot' | 'server' | serverId
    this.moduleStatus = moduleStatus;
    this.startedAt = startedAt;
    this.multiServerManager = multiServerManager;
    this._db = db;
    this._saveService = saveService;
    this._logWatcher = logWatcher;
    this._pendingServers = new Map(); // userId → { ...partial server config, _createdAt }
    // Setup wizard state (when config.needsSetup is true)
    this._setupWizard = null; // { profile, rcon: {host,port,password}, sftp: {host,port,user,password}, channels: {...}, step }
    // Clean up stale pending entries every 5 minutes
    this._pendingCleanupTimer = setInterval(() => {
      const cutoff = Date.now() - 10 * 60 * 1000; // 10-min TTL
      for (const [uid, data] of this._pendingServers) {
        if ((data._createdAt || 0) < cutoff) this._pendingServers.delete(uid);
      }
    }, 5 * 60 * 1000);
  }

  /** Whether SFTP credentials are configured (needed for game settings editor). */
  get _hasSftp() {
    return !!(config.ftpHost && config.ftpUser && (config.ftpPassword || config.ftpPrivateKeyPath));
  }

  /**
   * Check admin permission (synchronous). Returns true if admin, false if not.
   * Caller must handle defer/reply themselves.
   * Usage: `if (!this._isAdmin(interaction)) { await interaction.editReply('❌ Admin only'); return; }`
   */
  _isAdmin(interaction) {
    return interaction.member?.permissions?.has(PermissionFlagsBits.Administrator) || false;
  }

  /**
   * @deprecated Use _isAdmin() + manual editReply instead. This causes interaction timeout issues.
   * Check admin permission. Returns true if admin, false (with ephemeral reply) if not.
   * Usage: `if (!await this._requireAdmin(interaction, 'edit config')) return true;`
   */
  async _requireAdmin(interaction, action) {
    if (!interaction.member?.permissions?.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({ content: `❌ Only administrators can ${action}.`, flags: MessageFlags.Ephemeral });
      return false;
    }
    return true;
  }

  async start() {
    console.log('[PANEL CH] Module starting...');

    if (!config.panelChannelId) {
      console.log('[PANEL CH] No PANEL_CHANNEL_ID set, skipping.');
      return;
    }

    try {
      this.channel = await this.client.channels.fetch(config.panelChannelId);
      if (!this.channel) {
        console.error('[PANEL CH] Channel not found! Check PANEL_CHANNEL_ID.');
        return;
      }

      // ── Setup wizard mode ──
      if (config.needsSetup) {
        console.log('[PANEL CH] RCON not configured — launching setup wizard');
        await this._cleanOwnMessages();
        await this._startSetupWizard();
        return;
      }

      const features = [];
      features.push('bot controls');
      features.push('env editor');
      if (this._hasSftp && config.enableGameSettingsEditor) features.push('game settings (SFTP)');
      if (panelApi.available) features.push('server panel (API)');
      if (this.multiServerManager) {
        const count = this.multiServerManager.getAllServers().length;
        if (count > 0) features.push(`${count} managed server(s)`);
      }
      console.log(`[PANEL CH] Posting unified panel in #${this.channel.name} — ${features.join(', ')} (every ${this.updateIntervalMs / 1000}s)`);
      await this._cleanOwnMessages();

      // ── Single unified message with stacked embeds ──
      const { embeds, components } = await this._buildUnifiedPanel();
      this.panelMessage = await this.channel.send({ embeds, components });
      this.botMessage = this.panelMessage; // alias for interaction handler compat

      // Persist message ID
      this._saveMessageIds();

      // First real update
      await this._update(true);

      // Refresh loop
      this.interval = setInterval(() => this._update(), this.updateIntervalMs);
    } catch (err) {
      console.error('[PANEL CH] Failed to start:', err.message);
    }
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    if (this._pendingCleanupTimer) {
      clearInterval(this._pendingCleanupTimer);
      this._pendingCleanupTimer = null;
    }
  }

  // ═══════════════════════════════════════════════════════════
  // Setup Wizard — guided first-run configuration via Discord
  // ═══════════════════════════════════════════════════════════

  /**
   * Launch the setup wizard. Posts the initial profile selection embed.
   */
  async _startSetupWizard() {
    this._setupWizard = { step: 'profile', profile: null, rcon: null, sftp: null, channels: {} };

    const embed = new EmbedBuilder()
      .setTitle('🔧 HumanitZ Bot — Setup Wizard')
      .setColor(0x5865f2)
      .setDescription([
        'Welcome! This wizard will help you configure your bot.',
        '',
        '**How is your game server hosted?**',
        '',
        '🖥️ **VPS / Self-hosted** — Bot and game server on the same machine (localhost RCON + SFTP)',
        '🌐 **Bisect / Remote host** — Game server on a remote host (remote RCON + SFTP)',
        '📡 **RCON only** — No file access, basic features only (chat relay, status, commands)',
      ].join('\n'))
      .setFooter({ text: 'Step 1 of 4 — Hosting Profile' });

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(SETUP.PROFILE_VPS).setLabel('VPS / Self-hosted').setStyle(ButtonStyle.Primary).setEmoji('🖥️'),
      new ButtonBuilder().setCustomId(SETUP.PROFILE_BISECT).setLabel('Bisect / Remote').setStyle(ButtonStyle.Primary).setEmoji('🌐'),
      new ButtonBuilder().setCustomId(SETUP.PROFILE_RCON).setLabel('RCON Only').setStyle(ButtonStyle.Secondary).setEmoji('📡'),
    );

    this.panelMessage = await this.channel.send({ embeds: [embed], components: [row] });
    this.botMessage = this.panelMessage;
  }

  /**
   * Route all interactions while setup wizard is active.
   */
  async _handleSetupInteraction(interaction) {
    // ── Buttons ──
    if (interaction.isButton()) {
      const id = interaction.customId;
      // Profile selection
      if ([SETUP.PROFILE_VPS, SETUP.PROFILE_BISECT, SETUP.PROFILE_RCON].includes(id)) {
        return this._handleSetupProfile(interaction, id);
      }
      // Step buttons
      if (id === SETUP.RCON_BTN) return this._handleSetupRconButton(interaction);
      if (id === SETUP.SFTP_BTN) return this._handleSetupSftpButton(interaction);
      if (id === SETUP.SKIP_SFTP_BTN) return this._handleSetupSkipSftp(interaction);
      if (id === SETUP.CHANNELS_BTN) return this._handleSetupChannelsButton(interaction);
      if (id === SETUP.APPLY_BTN) return this._handleSetupApply(interaction);
    }
    // ── Modals ──
    if (interaction.isModalSubmit()) {
      if (interaction.customId === SETUP.RCON_MODAL) return this._handleSetupRconModal(interaction);
      if (interaction.customId === SETUP.SFTP_MODAL) return this._handleSetupSftpModal(interaction);
      if (interaction.customId === SETUP.CHANNELS_MODAL) return this._handleSetupChannelsModal(interaction);
    }
    return false;
  }

  /**
   * Handle profile selection (VPS / Bisect / RCON-only).
   */
  async _handleSetupProfile(interaction, id) {
    const profileMap = {
      [SETUP.PROFILE_VPS]: 'vps',
      [SETUP.PROFILE_BISECT]: 'bisect',
      [SETUP.PROFILE_RCON]: 'rcon-only',
    };
    this._setupWizard.profile = profileMap[id];

    // Set profile-appropriate defaults
    const defaults = {
      vps: { rconHost: '127.0.0.1', rconPort: '8888', ftpHost: '127.0.0.1', ftpPort: '22' },
      bisect: { rconHost: '', rconPort: '27015', ftpHost: '', ftpPort: '8821' },
      'rcon-only': { rconHost: '', rconPort: '27015' },
    };
    this._setupWizard.defaults = defaults[this._setupWizard.profile] || {};
    this._setupWizard.step = 'rcon';

    await this._updateSetupEmbed(interaction);
    return true;
  }

  /**
   * Show RCON credentials modal.
   */
  async _handleSetupRconButton(interaction) {
    const d = this._setupWizard.defaults || {};
    const modal = new ModalBuilder()
      .setCustomId(SETUP.RCON_MODAL)
      .setTitle('RCON Connection')
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('host')
            .setLabel('RCON Host')
            .setPlaceholder(d.rconHost || '127.0.0.1')
            .setValue(this._setupWizard.rcon?.host || d.rconHost || '')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('port')
            .setLabel('RCON Port')
            .setPlaceholder(d.rconPort || '27015')
            .setValue(this._setupWizard.rcon?.port || d.rconPort || '')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('password')
            .setLabel('RCON Password')
            .setPlaceholder('Your RCON password')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
        ),
      );
    await interaction.showModal(modal);
    return true;
  }

  /**
   * Handle RCON modal submission — test connection.
   */
  async _handleSetupRconModal(interaction) {
    await interaction.deferUpdate();

    const host = interaction.fields.getTextInputValue('host').trim();
    const port = interaction.fields.getTextInputValue('port').trim();
    const password = interaction.fields.getTextInputValue('password').trim();

    this._setupWizard.rcon = { host, port, password, status: 'testing' };
    await this._updateSetupEmbed(interaction);

    // Test RCON connection
    const net = require('net');
    try {
      await new Promise((resolve, reject) => {
        const socket = net.createConnection({ host, port: parseInt(port, 10), timeout: 8000 }, () => {
          socket.destroy();
          resolve();
        });
        socket.on('error', reject);
        socket.on('timeout', () => { socket.destroy(); reject(new Error('Connection timed out')); });
      });
      this._setupWizard.rcon.status = 'ok';
      this._setupWizard.step = this._setupWizard.profile === 'rcon-only' ? 'channels' : 'sftp';
    } catch (err) {
      this._setupWizard.rcon.status = 'error';
      this._setupWizard.rcon.error = err.message;
    }

    await this._updateSetupEmbed(interaction);
    return true;
  }

  /**
   * Show SFTP credentials modal.
   */
  async _handleSetupSftpButton(interaction) {
    const d = this._setupWizard.defaults || {};
    const modal = new ModalBuilder()
      .setCustomId(SETUP.SFTP_MODAL)
      .setTitle('SFTP Connection')
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('host')
            .setLabel('SFTP Host')
            .setPlaceholder(d.ftpHost || 'Same as RCON host')
            .setValue(this._setupWizard.sftp?.host || d.ftpHost || this._setupWizard.rcon?.host || '')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('port')
            .setLabel('SFTP Port')
            .setPlaceholder(d.ftpPort || '22')
            .setValue(this._setupWizard.sftp?.port || d.ftpPort || '')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('user')
            .setLabel('SFTP Username')
            .setPlaceholder('root / steam / your username')
            .setValue(this._setupWizard.sftp?.user || '')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('password')
            .setLabel('SFTP Password')
            .setPlaceholder('Your SFTP password')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
        ),
      );
    await interaction.showModal(modal);
    return true;
  }

  /**
   * Handle SFTP modal submission — test connection + auto-discover.
   */
  async _handleSetupSftpModal(interaction) {
    await interaction.deferUpdate();

    const host = interaction.fields.getTextInputValue('host').trim();
    const port = interaction.fields.getTextInputValue('port').trim();
    const user = interaction.fields.getTextInputValue('user').trim();
    const password = interaction.fields.getTextInputValue('password').trim();

    this._setupWizard.sftp = { host, port, user, password, status: 'testing', paths: null };
    await this._updateSetupEmbed(interaction);

    // Test SFTP connection + auto-discover paths
    const SftpClient = require('ssh2-sftp-client');
    const sftp = new SftpClient();
    try {
      await sftp.connect({
        host,
        port: parseInt(port, 10),
        username: user,
        password,
        readyTimeout: 10000,
        retries: 0,
      });

      // Auto-discover game files via recursive search
      const targets = ['HMZLog.log', 'PlayerConnectedLog.txt', 'PlayerIDMapped.txt', 'Save_DedicatedSaveMP.sav', 'GameServerSettings.ini', 'WelcomeMessage.txt'];
      const found = new Map();

      // Quick check: common game server paths first (fast path)
      const searchDirs = [
        '/home/steam/hzserver/serverfiles/HumanitZServer',
        '/home/steam/HumanitZServer',
        '/HumanitZServer',
        '/serverfiles/HumanitZServer',
        '/home/container/HumanitZServer',
        '/app/serverfiles/HumanitZServer',
        '/app/HumanitZServer',
      ];

      for (const dir of searchDirs) {
        if (found.size >= targets.length) break;
        try {
          const items = await sftp.list(dir);
          for (const item of items) {
            if (targets.includes(item.name) && !found.has(item.name)) {
              found.set(item.name, `${dir}/${item.name}`);
            }
          }
          // Also check Saved/SaveGames subdirectories for the save file
          if (!found.has('Save_DedicatedSaveMP.sav')) {
            try {
              const saveDir = `${dir}/Saved/SaveGames/SaveList/Default`;
              const saveItems = await sftp.list(saveDir);
              for (const item of saveItems) {
                if (item.name === 'Save_DedicatedSaveMP.sav') {
                  found.set(item.name, `${saveDir}/${item.name}`);
                }
              }
            } catch { /* save dir doesn't exist here */ }
          }
        } catch { /* dir doesn't exist */ }
      }

      // If quick check didn't find everything, do a full recursive search
      if (found.size < targets.length) {
        const _skip = /^(\.|node_modules|__pycache__|Engine|Content|Binaries|linux64|steamapps|proc|sys|run|tmp|lost\+found|snap|boot|usr)$/i;
        const _priority = /^(data|serverfiles|home|opt|root|app|HumanitZServer|hzserver|humanitz|container)/i;
        const _recurse = async (dir, depth) => {
          if (depth >= 8 || found.size >= targets.length) return;
          let items;
          try { items = await sftp.list(dir); } catch { return; }
          for (const item of items) {
            if (found.size >= targets.length) return;
            const fullPath = dir === '/' ? `/${item.name}` : `${dir}/${item.name}`;
            if (item.type === 'd') {
              if (_skip.test(item.name)) continue;
              if (_priority.test(item.name) || depth < 6) {
                await _recurse(fullPath, depth + 1);
              }
            } else if (targets.includes(item.name) && !found.has(item.name)) {
              found.set(item.name, fullPath);
            }
          }
        };
        await _recurse('/', 0);
      }

      await sftp.end();

      this._setupWizard.sftp.status = 'ok';
      this._setupWizard.sftp.paths = Object.fromEntries(found);
      this._setupWizard.sftp.foundCount = found.size;
      this._setupWizard.step = 'channels';
    } catch (err) {
      try { await sftp.end(); } catch { /* ignore */ }
      this._setupWizard.sftp.status = 'error';
      this._setupWizard.sftp.error = err.message;
    }

    await this._updateSetupEmbed(interaction);
    return true;
  }

  /**
   * Skip SFTP setup (user wants RCON-only even if they selected VPS/Bisect).
   */
  async _handleSetupSkipSftp(interaction) {
    await interaction.deferUpdate();
    this._setupWizard.sftp = null;
    this._setupWizard.step = 'channels';
    await this._updateSetupEmbed(interaction);
    return true;
  }

  /**
   * Show channel assignment modal.
   */
  async _handleSetupChannelsButton(interaction) {
    const ch = this._setupWizard.channels || {};
    const modal = new ModalBuilder()
      .setCustomId(SETUP.CHANNELS_MODAL)
      .setTitle('Channel Assignment')
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('status')
            .setLabel('Server Status Channel ID')
            .setPlaceholder('Right-click channel → Copy Channel ID')
            .setValue(ch.serverStatus || '')
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('stats')
            .setLabel('Player Stats Channel ID')
            .setPlaceholder('Right-click channel → Copy Channel ID')
            .setValue(ch.playerStats || '')
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('log')
            .setLabel('Activity Log Channel ID')
            .setPlaceholder('Right-click channel → Copy Channel ID')
            .setValue(ch.log || '')
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('chat')
            .setLabel('Chat Relay Channel ID (also admin channel)')
            .setPlaceholder('Right-click channel → Copy Channel ID')
            .setValue(ch.chat || '')
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
        ),
      );
    await interaction.showModal(modal);
    return true;
  }

  /**
   * Handle channel assignment modal.
   */
  async _handleSetupChannelsModal(interaction) {
    await interaction.deferUpdate();

    const status = interaction.fields.getTextInputValue('status').trim();
    const stats = interaction.fields.getTextInputValue('stats').trim();
    const log = interaction.fields.getTextInputValue('log').trim();
    const chat = interaction.fields.getTextInputValue('chat').trim();

    this._setupWizard.channels = {
      serverStatus: status || '',
      playerStats: stats || '',
      log: log || '',
      chat: chat || '',
    };
    this._setupWizard.step = 'apply';

    await this._updateSetupEmbed(interaction);
    return true;
  }

  /**
   * Apply all wizard settings — write to .env and restart.
   */
  async _handleSetupApply(interaction) {
    await interaction.deferUpdate();

    const wiz = this._setupWizard;
    const envUpdates = {};

    // RCON
    if (wiz.rcon) {
      envUpdates.RCON_HOST = wiz.rcon.host;
      envUpdates.RCON_PORT = wiz.rcon.port;
      envUpdates.RCON_PASSWORD = wiz.rcon.password;
    }

    // SFTP
    if (wiz.sftp && wiz.sftp.status === 'ok') {
      envUpdates.FTP_HOST = wiz.sftp.host;
      envUpdates.FTP_PORT = wiz.sftp.port;
      envUpdates.FTP_USER = wiz.sftp.user;
      envUpdates.FTP_PASSWORD = wiz.sftp.password;

      // Set discovered paths
      const paths = wiz.sftp.paths || {};
      if (paths['HMZLog.log']) envUpdates.FTP_LOG_PATH = paths['HMZLog.log'];
      if (paths['PlayerConnectedLog.txt']) envUpdates.FTP_CONNECT_LOG_PATH = paths['PlayerConnectedLog.txt'];
      if (paths['PlayerIDMapped.txt']) envUpdates.FTP_ID_MAP_PATH = paths['PlayerIDMapped.txt'];
      if (paths['Save_DedicatedSaveMP.sav']) envUpdates.FTP_SAVE_PATH = paths['Save_DedicatedSaveMP.sav'];
      if (paths['GameServerSettings.ini']) envUpdates.FTP_SETTINGS_PATH = paths['GameServerSettings.ini'];
      if (paths['WelcomeMessage.txt']) envUpdates.FTP_WELCOME_PATH = paths['WelcomeMessage.txt'];

      // Auto-detect base path
      const discovered = Object.values(paths);
      if (discovered.length > 0) {
        const common = _findCommonParent(discovered);
        if (common && common !== '/') {
          envUpdates.FTP_BASE_PATH = common;
        }
      }
    }

    // Profile-specific defaults
    if (wiz.profile === 'vps') {
      envUpdates.SAVE_POLL_INTERVAL = '30000';
    } else if (wiz.profile === 'bisect') {
      envUpdates.SAVE_POLL_INTERVAL = '300000';
    }

    // Channels
    const ch = wiz.channels || {};
    if (ch.serverStatus) envUpdates.SERVER_STATUS_CHANNEL_ID = ch.serverStatus;
    if (ch.playerStats) envUpdates.PLAYER_STATS_CHANNEL_ID = ch.playerStats;
    if (ch.log) envUpdates.LOG_CHANNEL_ID = ch.log;
    if (ch.chat) {
      envUpdates.CHAT_CHANNEL_ID = ch.chat;
      envUpdates.ADMIN_CHANNEL_ID = ch.chat; // same channel by default
    }

    // Trigger initial import on restart
    envUpdates.FIRST_RUN = 'true';

    // Write all at once
    _writeEnvValues(envUpdates);

    // Update embed with success message
    const successEmbed = new EmbedBuilder()
      .setTitle('✅ Setup Complete!')
      .setColor(0x2ecc71)
      .setDescription([
        'Configuration has been saved. The bot will restart now to apply settings and run the initial data import.',
        '',
        '**What happens next:**',
        '1. Bot restarts with new configuration',
        wiz.sftp?.status === 'ok' ? '2. Downloads server logs via SFTP' : '2. Connects to game server via RCON',
        wiz.sftp?.status === 'ok' ? '3. Parses player data and builds statistics' : '3. Starts monitoring chat and server status',
        '4. Posts embeds in your configured channels',
        '',
        'This channel will become your admin dashboard.',
      ].join('\n'))
      .setFooter({ text: 'Restarting...' });

    try {
      await this.panelMessage.edit({ embeds: [successEmbed], components: [] });
    } catch { /* message might be gone */ }

    // Restart
    setTimeout(() => process.exit(0), 2000);
    return true;
  }

  /**
   * Build and update the setup wizard embed based on current step.
   */
  async _updateSetupEmbed(interaction) {
    const wiz = this._setupWizard;
    const embed = new EmbedBuilder()
      .setTitle('🔧 HumanitZ Bot — Setup Wizard')
      .setColor(0x5865f2);

    const lines = [];
    const profileLabels = { vps: '🖥️ VPS / Self-hosted', bisect: '🌐 Bisect / Remote', 'rcon-only': '📡 RCON Only' };

    // Profile
    lines.push(`**Hosting:** ${profileLabels[wiz.profile] || 'Not selected'}`);
    lines.push('');

    // RCON status
    if (wiz.rcon) {
      const icon = wiz.rcon.status === 'ok' ? '✅' : wiz.rcon.status === 'error' ? '❌' : '⏳';
      lines.push(`${icon} **RCON:** \`${wiz.rcon.host}:${wiz.rcon.port}\``);
      if (wiz.rcon.status === 'error') {
        lines.push(`  └ ${wiz.rcon.error}`);
      }
    } else if (wiz.step === 'rcon') {
      lines.push('⬜ **RCON:** Not configured — tap the button below');
    }

    // SFTP status (skip for rcon-only)
    if (wiz.profile !== 'rcon-only') {
      if (wiz.sftp) {
        const icon = wiz.sftp.status === 'ok' ? '✅' : wiz.sftp.status === 'error' ? '❌' : '⏳';
        lines.push(`${icon} **SFTP:** \`${wiz.sftp.host}:${wiz.sftp.port}\``);
        if (wiz.sftp.status === 'ok' && wiz.sftp.foundCount !== undefined) {
          lines.push(`  └ Found ${wiz.sftp.foundCount}/6 game files`);
        }
        if (wiz.sftp.status === 'error') {
          lines.push(`  └ ${wiz.sftp.error}`);
        }
      } else if (wiz.step === 'sftp' || wiz.step === 'channels' || wiz.step === 'apply') {
        if (wiz.sftp === null && wiz.step !== 'sftp') {
          lines.push('⏭️ **SFTP:** Skipped');
        } else {
          lines.push('⬜ **SFTP:** Not configured');
        }
      }
    }

    // Channels
    const ch = wiz.channels || {};
    const channelCount = [ch.serverStatus, ch.playerStats, ch.log, ch.chat].filter(Boolean).length;
    if (channelCount > 0) {
      lines.push(`✅ **Channels:** ${channelCount} configured`);
      if (ch.serverStatus) lines.push(`  └ Status: <#${ch.serverStatus}>`);
      if (ch.playerStats) lines.push(`  └ Stats: <#${ch.playerStats}>`);
      if (ch.log) lines.push(`  └ Log: <#${ch.log}>`);
      if (ch.chat) lines.push(`  └ Chat: <#${ch.chat}>`);
    } else if (wiz.step === 'channels' || wiz.step === 'apply') {
      lines.push('⬜ **Channels:** None configured (optional)');
    }

    embed.setDescription(lines.join('\n'));

    // Step indicator
    const stepLabels = { profile: '1/4 — Profile', rcon: '2/4 — RCON', sftp: '3/4 — SFTP', channels: '3/4 — Channels', apply: '4/4 — Ready' };
    embed.setFooter({ text: `Step ${stepLabels[wiz.step] || wiz.step}` });

    // Build action rows based on current step
    const components = [];

    if (wiz.step === 'rcon') {
      components.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(SETUP.RCON_BTN).setLabel('Configure RCON').setStyle(ButtonStyle.Primary).setEmoji('🔌'),
      ));
    } else if (wiz.step === 'sftp') {
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(SETUP.SFTP_BTN).setLabel('Configure SFTP').setStyle(ButtonStyle.Primary).setEmoji('📂'),
        new ButtonBuilder().setCustomId(SETUP.SKIP_SFTP_BTN).setLabel('Skip SFTP').setStyle(ButtonStyle.Secondary),
      );
      // Allow re-testing RCON if it failed
      if (wiz.rcon?.status === 'error') {
        row.addComponents(
          new ButtonBuilder().setCustomId(SETUP.RCON_BTN).setLabel('Retry RCON').setStyle(ButtonStyle.Secondary),
        );
      }
      components.push(row);
    } else if (wiz.step === 'channels') {
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(SETUP.CHANNELS_BTN).setLabel('Set Channels').setStyle(ButtonStyle.Primary).setEmoji('📺'),
        new ButtonBuilder().setCustomId(SETUP.APPLY_BTN).setLabel('Apply & Restart').setStyle(ButtonStyle.Success).setEmoji('🚀'),
      );
      components.push(row);
    } else if (wiz.step === 'apply') {
      components.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(SETUP.CHANNELS_BTN).setLabel('Edit Channels').setStyle(ButtonStyle.Secondary).setEmoji('📺'),
        new ButtonBuilder().setCustomId(SETUP.APPLY_BTN).setLabel('Apply & Restart').setStyle(ButtonStyle.Success).setEmoji('🚀'),
      ));
    }

    try {
      await this.panelMessage.edit({ embeds: [embed], components });
    } catch (err) {
      console.error('[PANEL CH] Failed to update setup wizard embed:', err.message);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // Interaction router
  // ═══════════════════════════════════════════════════════════

  async handleInteraction(interaction) {
    // ── Setup wizard interactions ──
    if (this._setupWizard !== null) {
      return this._handleSetupInteraction(interaction);
    }

    // ── Buttons ──
    if (interaction.isButton()) {
      const id = interaction.customId;
      if ([BTN.START, BTN.STOP, BTN.RESTART, BTN.BACKUP, BTN.KILL].includes(id)) {
        return this._handlePowerButton(interaction, id);
      }
      if (id === BTN.BOT_RESTART) {
        return this._handleBotRestart(interaction);
      }
      if (id === BTN.NUKE) {
        return this._handleNukeButton(interaction);
      }
      if (id === BTN.REIMPORT) {
        return this._handleReimportButton(interaction);
      }
      if (id === BTN.DIAGNOSTICS) {
        return this._handleDiagnosticsButton(interaction);
      }
      if (id === BTN.ENV_SYNC) {
        return this._handleEnvSyncButton(interaction);
      }
      if (id === BTN.WELCOME_EDIT) {
        return this._handleWelcomeEditButton(interaction);
      }
      if (id === 'panel_welcome_open_modal') {
        return this._handleWelcomeOpenModal(interaction);
      }
      if (id === BTN.BROADCASTS) {
        return this._handleBroadcastsButton(interaction);
      }
      if (id === 'panel_broadcasts_open_modal') {
        return this._handleBroadcastsOpenModal(interaction);
      }
      if (id === BTN.ADD_SERVER) {
        return this._handleAddServerButton(interaction);
      }
      if (id.startsWith('panel_srv_')) {
        return this._handleServerAction(interaction, id);
      }
      if (id.startsWith('panel_add_sftp:')) {
        return this._handleAddSftpButton(interaction, id);
      }
      if (id.startsWith('panel_add_step2:')) {
        return this._handleAddServerStep2Button(interaction, id);
      }
      return false;
    }

    // ── Select menus ──
    if (interaction.isStringSelectMenu()) {
      if (interaction.customId === SELECT.VIEW) {
        return this._handleViewSelect(interaction);
      }
      if (interaction.customId === SELECT.ENV || interaction.customId === SELECT.ENV2) {
        return this._handleEnvSelect(interaction);
      }
      if (interaction.customId === SELECT.SETTINGS) {
        return this._handleGameSettingsSelect(interaction);
      }
      if (interaction.customId.startsWith('panel_srv_settings:')) {
        return this._handleSrvGameSettingsSelect(interaction);
      }
      if (interaction.customId === SELECT.SERVER) {
        return this._handleServerSelect(interaction);
      }
      return false;
    }

    // ── Modals ──
    if (interaction.isModalSubmit()) {
      if (interaction.customId.startsWith('panel_env_modal:')) {
        return this._handleEnvModal(interaction);
      }
      if (interaction.customId === 'panel_nuke_confirm') {
        return this._handleNukeConfirmModal(interaction);
      }
      if (interaction.customId.startsWith('panel_game_modal:')) {
        return this._handleGameSettingsModal(interaction);
      }
      if (interaction.customId === 'panel_welcome_modal') {
        return this._handleWelcomeModal(interaction);
      }
      if (interaction.customId === 'panel_broadcasts_modal') {
        return this._handleBroadcastsModal(interaction);
      }
      if (interaction.customId === 'panel_add_modal_step1') {
        return this._handleAddServerStep1Modal(interaction);
      }
      if (interaction.customId.startsWith('panel_add_modal_step2:')) {
        return this._handleAddServerStep2Modal(interaction);
      }
      if (interaction.customId.startsWith('panel_add_sftp_modal:')) {
        return this._handleAddSftpModal(interaction);
      }
      if (interaction.customId.startsWith('panel_srv_edit_modal:')) {
        return this._handleEditServerModal(interaction);
      }
      if (interaction.customId.startsWith('panel_srv_channels_modal:')) {
        return this._handleEditChannelsModal(interaction);
      }
      if (interaction.customId.startsWith('panel_srv_sftp_modal:')) {
        return this._handleEditSftpModal(interaction);
      }
      if (interaction.customId.startsWith('panel_srv_game_modal:')) {
        return this._handleSrvGameSettingsModal(interaction);
      }
      if (interaction.customId.startsWith('panel_srv_welcome_modal:')) {
        return this._handleSrvWelcomeModal(interaction);
      }
      if (interaction.customId.startsWith('panel_srv_automsg_modal:')) {
        return this._handleSrvAutoMsgModal(interaction);
      }
      return false;
    }

    return false;
  }

  // ═══════════════════════════════════════════════════════════
  // Button handlers
  // ═══════════════════════════════════════════════════════════

  async _handlePowerButton(interaction, id) {
    // Defer immediately to prevent token expiry
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    if (!this._isAdmin(interaction)) {
      await interaction.editReply('❌ Only administrators can use panel controls.');
      return true;
    }

    if (!panelApi.available) {
      await interaction.editReply('❌ Panel API is not configured. Power controls require PANEL_SERVER_URL and PANEL_API_KEY.');
      return true;
    }

    try {
      switch (id) {
        case BTN.START:
          await panelApi.sendPowerAction('start');
          await interaction.editReply('✅ **Start** signal sent. The server is booting up...');
          break;
        case BTN.STOP:
          await panelApi.sendPowerAction('stop');
          await interaction.editReply('✅ **Stop** signal sent. The server is shutting down gracefully...');
          break;
        case BTN.RESTART:
          await panelApi.sendPowerAction('restart');
          await interaction.editReply('✅ **Restart** signal sent. The server will restart shortly...');
          break;
        case BTN.KILL:
          await panelApi.sendPowerAction('kill');
          await interaction.editReply('⚠️ **Kill** signal sent. The server process was forcefully terminated.');
          break;
        case BTN.BACKUP:
          await panelApi.createBackup();
          await interaction.editReply('✅ **Backup** creation started. It will appear in the panel shortly.');
          break;
      }
      setTimeout(() => this._update(true), 3000);
    } catch (err) {
      await interaction.editReply(`❌ Action failed: ${err.message}`);
    }

    return true;
  }

  async _handleBotRestart(interaction) {
    if (!await this._requireAdmin(interaction, 'restart the bot')) return true;

    await interaction.reply({
      content: '🔄 Restarting bot... The process will exit and your process manager should restart it.',
      flags: MessageFlags.Ephemeral,
    });

    // Let Discord deliver the reply before exiting
    setTimeout(() => process.exit(0), 1500);
    return true;
  }

  async _handleNukeButton(interaction) {
    if (!await this._requireAdmin(interaction, 'factory reset the bot')) return true;

    // Confirmation modal — user must type "NUKE" to proceed
    const modal = new ModalBuilder()
      .setCustomId('panel_nuke_confirm')
      .setTitle('⚠️ Factory Reset — Confirm');

    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('confirm')
          .setLabel('Type NUKE to confirm (deletes ALL bot data)')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('NUKE')
          .setRequired(true)
          .setMinLength(4)
          .setMaxLength(4)
      )
    );

    await interaction.showModal(modal);
    return true;
  }

  async _handleNukeConfirmModal(interaction) {
    if (!await this._requireAdmin(interaction, 'factory reset the bot')) return true;

    const confirm = interaction.fields.getTextInputValue('confirm').trim().toUpperCase();
    if (confirm !== 'NUKE') {
      await interaction.reply({ content: '❌ Factory reset cancelled — you must type `NUKE` exactly.', flags: MessageFlags.Ephemeral });
      return true;
    }

    // Set NUKE_BOT=true in .env and restart
    _writeEnvValues({ NUKE_BOT: 'true' });
    await interaction.reply({
      content: '💣 **Factory Reset initiated.** The bot will restart, wipe all Discord messages and local data, then rebuild from server logs.\n\nThis may take a minute...',
      flags: MessageFlags.Ephemeral,
    });

    setTimeout(() => process.exit(0), 1500);
    return true;
  }

  async _handleReimportButton(interaction) {
    if (!await this._requireAdmin(interaction, 're-import data')) return true;

    // Set FIRST_RUN=true and restart — re-downloads logs and rebuilds stats
    _writeEnvValues({ FIRST_RUN: 'true' });
    await interaction.reply({
      content: '📥 **Re-Import started.** The bot will restart and re-download server logs to rebuild player stats and playtime data.\n\nExisting Discord messages are preserved — only local data is refreshed.',
      flags: MessageFlags.Ephemeral,
    });

    setTimeout(() => process.exit(0), 1500);
    return true;
  }

  // ═══════════════════════════════════════════════════════════
  // Diagnostics — live health probes + module status + suggestions
  // ═══════════════════════════════════════════════════════════

  async _handleDiagnosticsButton(interaction) {
    // Defer — probes can take a few seconds
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    
    if (!this._isAdmin(interaction)) {
      await interaction.editReply('❌ Only administrators can view diagnostics.');
      return true;
    }

    const rcon = require('../rcon/rcon');
    const playerStats = require('../tracking/player-stats');
    const playtime = require('../tracking/playtime-tracker');
    const upMs = Date.now() - this.startedAt.getTime();

    const results = { rcon: null, sftp: null, db: null, channels: [], save: null, panel: null };

    // ── Run probes in parallel ──
    const probes = [];

    // RCON probe — send a real command
    probes.push((async () => {
      if (!config.rconHost || !config.rconPassword) {
        results.rcon = { status: 'unconfigured' };
        return;
      }
      const start = Date.now();
      try {
        const resp = await Promise.race([
          rcon.send('info'),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000)),
        ]);
        results.rcon = { status: 'ok', latency: Date.now() - start, response: (resp || '').slice(0, 60) };
      } catch (err) {
        results.rcon = {
          status: rcon.connected ? 'error' : 'disconnected',
          latency: Date.now() - start,
          error: err.message,
        };
      }
    })());

    // SFTP probe — real connection test
    if (this._hasSftp) {
      probes.push((async () => {
        const SftpClient = require('ssh2-sftp-client');
        const sftp = new SftpClient();
        const start = Date.now();
        try {
          const connectOpts = {
            host: config.ftpHost,
            port: config.ftpPort || 2022,
            username: config.ftpUser,
            password: config.ftpPassword,
            readyTimeout: 8000,
            retries: 0,
          };
          if (config.ftpPrivateKeyPath) {
            try { connectOpts.privateKey = fs.readFileSync(config.ftpPrivateKeyPath); } catch { /* ignore */ }
          }
          await sftp.connect(connectOpts);
          // Probe actual configured file paths (not just base dir listing)
          let hasSave = false;
          let hasLog = false;
          try { await sftp.stat(config.ftpSavePath); hasSave = true; } catch { /* missing */ }
          try { await sftp.stat(config.ftpLogPath); hasLog = true; } catch { /* missing */ }
          await sftp.end();
          results.sftp = { status: 'ok', latency: Date.now() - start, hasSave, hasLog };
        } catch (err) {
          try { await sftp.end(); } catch { /* ignore */ }
          results.sftp = { status: 'error', latency: Date.now() - start, error: err.message };
        }
      })());
    } else {
      results.sftp = { status: 'unconfigured' };
    }

    // DB health check
    probes.push((async () => {
      if (!this._db || !this._db.db) {
        results.db = { status: 'unavailable' };
        return;
      }
      try {
        const integrity = this._db.db.pragma('integrity_check');
        const ok = integrity?.[0]?.integrity_check === 'ok';
        const totals = this._db.getServerTotals();
        const aliases = this._db.getAliasStats();
        const version = this._db.getMeta('schema_version');
        let fileSize = 0;
        try { fileSize = fs.statSync(this._db._dbPath).size; } catch { /* in-memory */ }
        results.db = {
          status: ok ? 'ok' : 'degraded',
          integrity: ok,
          version,
          players: totals?.total_players || 0,
          online: totals?.online_players || 0,
          totalKills: totals?.total_kills || 0,
          aliases: aliases?.totalAliases || 0,
          uniquePlayers: aliases?.uniquePlayers || 0,
          fileSize,
        };
      } catch (err) {
        results.db = { status: 'error', error: err.message };
      }
    })());

    // Panel API probe
    if (panelApi.available) {
      probes.push((async () => {
        const start = Date.now();
        try {
          const res = await Promise.race([
            panelApi.getResources(),
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000)),
          ]);
          results.panel = { status: 'ok', latency: Date.now() - start, state: res?.state || 'unknown' };
        } catch (err) {
          results.panel = { status: 'error', latency: Date.now() - start, error: err.message };
        }
      })());
    } else {
      results.panel = { status: 'unconfigured' };
    }

    await Promise.allSettled(probes);

    // ── Channel verification (sequential to avoid rate limits) ──
    const channelDefs = [
      { name: 'Admin', key: 'adminChannelId' },
      { name: 'Chat', key: 'chatChannelId' },
      { name: 'Server Status', key: 'serverStatusChannelId' },
      { name: 'Log (threads)', key: 'logChannelId' },
      { name: 'Activity Log', key: 'activityLogChannelId' },
      { name: 'Player Stats', key: 'playerStatsChannelId' },
      { name: 'Panel', key: 'panelChannelId' },
    ];
    for (const { name, key } of channelDefs) {
      const id = config[key];
      if (!id) {
        results.channels.push({ name, status: 'not set' });
        continue;
      }
      try {
        const ch = await this.client.channels.fetch(id);
        results.channels.push({ name, status: 'ok', channelName: ch?.name || id });
      } catch {
        results.channels.push({ name, status: 'error', id });
      }
    }

    // ── Save service health ──
    if (this._saveService) {
      const st = this._saveService.stats;
      results.save = {
        status: st.lastError ? 'error' : st.syncCount > 0 ? 'ok' : 'waiting',
        syncCount: st.syncCount,
        lastMtime: st.lastMtime,
        lastError: st.lastError,
        mode: st.mode,
        syncing: st.syncing,
      };
    }

    // ── Build module status lines ──
    const moduleLines = [];
    for (const [name, status] of Object.entries(this.moduleStatus)) {
      const icon = status.startsWith('🟢') ? '🟢' : status.startsWith('⚫') ? '⚫' : '🟡';
      const detail = status.replace(/^[🟢⚫🟡]\s*/, '');
      if (icon === '🟢') {
        moduleLines.push(`${icon} **${name}** — ${detail}`);
      } else if (icon === '⚫') {
        moduleLines.push(`${icon} **${name}** — Disabled in config`);
      } else {
        const reason = detail.replace(/^Skipped\s*/, '').replace(/^\(/, '').replace(/\)$/, '');
        moduleLines.push(`${icon} **${name}** — ${reason || 'Skipped'}`);
      }
    }

    // Enrich with live data where available
    if (this._logWatcher) {
      const lwActive = !!this._logWatcher.interval;
      const lwInit = this._logWatcher.initialised;
      if (lwActive && lwInit) {
        // already shown via moduleStatus
      } else if (lwActive && !lwInit) {
        moduleLines.push('-# Log Watcher is polling but hasn\'t received data yet');
      }
    }
    const psCount = playerStats._data ? Object.keys(playerStats._data.players || {}).length : 0;
    const ptCount = playtime._data ? Object.keys(playtime._data.players || {}).length : 0;
    const ptActive = playtime._activeSessions?.size || 0;

    // ── Build connectivity lines ──
    const connLines = [];

    // RCON
    if (results.rcon.status === 'ok') {
      connLines.push(`🟢 **RCON** — ${results.rcon.latency}ms · \`${results.rcon.response}\``);
    } else if (results.rcon.status === 'disconnected') {
      connLines.push(`🔴 **RCON** — Disconnected (${results.rcon.error})`);
    } else if (results.rcon.status === 'error') {
      connLines.push(`🟡 **RCON** — Error: ${results.rcon.error} (${results.rcon.latency}ms)`);
    } else {
      connLines.push('⚫ **RCON** — Not configured');
    }

    // SFTP
    if (results.sftp.status === 'ok') {
      const extras = [];
      const missing = [];
      if (results.sftp.hasSave) extras.push('save ✓');
      else missing.push('save');
      if (results.sftp.hasLog) extras.push('log ✓');
      else missing.push('log');
      
      let statusLine = `🟢 **SFTP** — ${results.sftp.latency}ms`;
      if (extras.length > 0) statusLine += ` · ${extras.join(', ')}`;
      if (missing.length > 0) statusLine += ` · ⚠️ **Missing:** ${missing.join(', ')}`;
      connLines.push(statusLine);
    } else if (results.sftp.status === 'error') {
      connLines.push(`🔴 **SFTP** — ${results.sftp.error} (${results.sftp.latency}ms)`);
    } else {
      connLines.push('⚫ **SFTP** — Not configured');
    }

    // Panel API
    if (results.panel.status === 'ok') {
      connLines.push(`🟢 **Panel API** — ${results.panel.latency}ms · Server: ${results.panel.state}`);
    } else if (results.panel.status === 'error') {
      connLines.push(`🔴 **Panel API** — ${results.panel.error} (${results.panel.latency}ms)`);
    } else {
      connLines.push('⚫ **Panel API** — Not configured');
    }

    // Database
    if (results.db.status === 'ok') {
      const sizeMB = (results.db.fileSize / 1024 / 1024).toFixed(1);
      connLines.push(`🟢 **Database** — v${results.db.version} · ${results.db.players} players · ${results.db.aliases} aliases · ${sizeMB} MB`);
    } else if (results.db.status === 'degraded') {
      connLines.push('🟡 **Database** — Integrity check failed');
    } else if (results.db.status === 'error') {
      connLines.push(`🔴 **Database** — ${results.db.error}`);
    } else {
      connLines.push('⚫ **Database** — Not initialised');
    }

    // Save service
    if (results.save) {
      if (results.save.status === 'ok') {
        const ago = results.save.lastMtime
          ? _formatBotUptime(Date.now() - new Date(results.save.lastMtime).getTime()) + ' ago'
          : 'unknown';
        connLines.push(`🟢 **Save Service** — ${results.save.syncCount} syncs · Last: ${ago} · Mode: ${results.save.mode}`);
      } else if (results.save.status === 'error') {
        connLines.push(`🔴 **Save Service** — ${results.save.lastError}`);
      } else {
        connLines.push('🟡 **Save Service** — Waiting for first sync');
      }
    }

    // ── Channel verification lines ──
    const chLines = results.channels.map(ch => {
      if (ch.status === 'ok') return `🟢 ${ch.name} → #${ch.channelName}`;
      if (ch.status === 'not set') return `⚫ ${ch.name} — not configured`;
      return `🔴 ${ch.name} — channel ${ch.id} not found or inaccessible`;
    });

    // ── Data summary ──
    const dataLines = [];
    if (results.db.status === 'ok' && results.db.players > 0) {
      dataLines.push(`👥 **${results.db.players}** players in database (${results.db.online} online)`);
      dataLines.push(`🪦 **${results.db.totalKills?.toLocaleString() || 0}** lifetime kills tracked`);
    }
    if (psCount > 0) dataLines.push(`📊 **${psCount}** players in log stats`);
    if (ptCount > 0) dataLines.push(`⏱️ **${ptCount}** players with playtime (${ptActive} active session${ptActive !== 1 ? 's' : ''})`);
    if (dataLines.length === 0) dataLines.push('No player data loaded yet');

    // ── Smart suggestions ──
    const tips = [];
    const skippedModules = Object.entries(this.moduleStatus).filter(([, s]) => s.startsWith('🟡'));
    const disabledModules = Object.entries(this.moduleStatus).filter(([, s]) => s.startsWith('⚫'));

    // RCON issues
    if (results.rcon.status === 'disconnected') {
      tips.push(
        '🔌 **RCON disconnected** — The bot auto-reconnects every 15 seconds. ' +
        'If your game server restarted (e.g. Bisect 8h schedule), just wait for it to finish booting. ' +
        'The bot will automatically reconnect — no manual action needed. ' +
        'Chat relay and server status will resume once RCON is back.'
      );
    } else if (results.rcon.status === 'error') {
      tips.push(
        '⚠️ **RCON issues** — Connected but commands are failing. Check that `RCON_HOST`, `RCON_PORT`, and `RCON_PASSWORD` match your server\'s RCON settings.'
      );
    } else if (results.rcon.status === 'ok' && results.rcon.latency > 2000) {
      tips.push(
        '🐢 **RCON slow** — Response took ' + results.rcon.latency + 'ms. ' +
        'This may cause delayed chat relay and status updates. ' +
        'Check server load or network latency to the game server.'
      );
    }

    // SFTP issues
    if (results.sftp.status === 'error') {
      tips.push(
        '🔴 **SFTP connection failed** — `' + results.sftp.error + '`. ' +
        'Verify `FTP_HOST`, `FTP_PORT`, `FTP_USER`, `FTP_PASSWORD` are correct. ' +
        'Common causes: wrong port (game SFTP is usually 2022), firewall blocking, incorrect credentials.'
      );
    } else if (results.sftp.status === 'ok' && !results.sftp.hasSave) {
      tips.push(
        '📁 **Save file not found** — SFTP connected but `FTP_SAVE_PATH` does not exist on the server. ' +
        'Check that `FTP_SAVE_PATH` points to the correct `.sav` file (default: `/HumanitZServer/Saved/SaveGames/SaveList/Default/Save_DedicatedSaveMP.sav`).'
      );
    } else if (results.sftp.status === 'ok' && !results.sftp.hasLog) {
      tips.push(
        '📁 **Log file not found** — `FTP_LOG_PATH` does not exist on the server. ' +
        'Log Watcher needs this file. Set `FTP_LOG_PATH` in `.env` to the full path of `HMZLog.log` on your server ' +
        '(e.g. `/home/steam/hzserver/serverfiles/HumanitZServer/HMZLog.log`). If you\'re unsure, run `npm run setup` to auto-discover.'
      );
    } else if (results.sftp.status === 'unconfigured' && skippedModules.some(([n]) => /log|save|stats|pvp/i.test(n))) {
      tips.push(
        '📡 **No SFTP configured** — Several modules need SFTP to read server files. ' +
        'Set `FTP_HOST`, `FTP_USER`, and `FTP_PASSWORD` to enable log watching, player stats, and save syncing. ' +
        'The bot will work for chat relay and server status without SFTP, but advanced features require it.'
      );
    }

    // Save issues
    if (results.save?.status === 'error') {
      tips.push('💾 **Save sync error** — `' + results.save.lastError + '`. Check SFTP/agent configuration.');
    } else if (results.save?.status === 'waiting') {
      tips.push('💾 **Save service waiting** — No sync has completed yet. This is normal on fresh startup; data will appear after the first poll cycle.');
    }

    // DB issues
    if (results.db.status === 'degraded') {
      tips.push('🗄️ **DB integrity issue** — The database failed SQLite integrity_check. Consider using "Factory Reset" to rebuild.');
    }
    if (results.db.status === 'ok' && results.db.players === 0 && results.save?.syncCount > 0) {
      tips.push('🗄️ **DB empty despite save syncs** — Save data was synced but no players in DB. The save file may be empty or corrupted.');
    }

    // Panel API
    if (results.panel.status === 'error') {
      tips.push('🎛️ **Panel API error** — `' + results.panel.error + '`. Verify `PANEL_SERVER_URL` and `PANEL_API_KEY`.');
    }

    // Channel issues
    const brokenChannels = results.channels.filter(c => c.status === 'error');
    if (brokenChannels.length > 0) {
      tips.push(
        '📺 **Invalid channel ID(s):** ' + brokenChannels.map(c => c.name).join(', ') + '. ' +
        'The channel may have been deleted or the bot lacks access. Update in the Channels config category.'
      );
    }

    // Missing channel suggestions for skipped modules
    const missingChannels = skippedModules.filter(([, s]) => /CHANNEL_ID/i.test(s));
    if (missingChannels.length > 0) {
      const names = missingChannels.map(([n]) => n).join(', ');
      tips.push(
        '📺 **Missing channel IDs for:** ' + names + '. ' +
        'Set the corresponding channel IDs in the Channels config above to activate these modules.'
      );
    }

    // Data staleness
    if (results.db.status === 'ok' && results.db.players > 0 && psCount === 0) {
      tips.push('📊 **Log stats empty** — DB has players but log-based stats (deaths, builds, loots) are empty. Enable Log Watcher with SFTP to track player activity.');
    }
    if (results.db.status === 'ok' && results.db.players > 0 && ptCount === 0) {
      tips.push('⏱️ **No playtime data** — Enable playtime tracking (`ENABLE_PLAYTIME=true`) and ensure RCON is connected to track player sessions.');
    }

    // Disabled module suggestions
    if (disabledModules.length > 0) {
      const names = disabledModules.map(([n]) => n).join(', ');
      tips.push('⚫ **Disabled modules:** ' + names + '. These can be enabled via `ENABLE_*=true` in config if needed.');
    }

    // All-good
    if (tips.length === 0) {
      tips.push('✅ All systems operational — no issues detected.');
    }

    // ── Build embeds ──
    const embed = new EmbedBuilder()
      .setTitle('🔍 System Diagnostics')
      .setColor(
        results.rcon.status === 'disconnected' || results.sftp.status === 'error' || results.db.status === 'error'
          ? 0xe74c3c
          : skippedModules.length > 0
            ? 0xf1c40f
            : 0x2ecc71
      )
      .setDescription(`Uptime: **${_formatBotUptime(upMs)}** · Modules: **${Object.keys(this.moduleStatus).length}**`)
      .addFields(
        { name: '🔌 Live Connectivity', value: connLines.join('\n') },
        { name: '📺 Channels', value: chLines.join('\n') || 'None configured' },
        { name: '📦 Modules', value: moduleLines.join('\n') || 'None registered' },
      )
      .setTimestamp()
      .setFooter({ text: 'This information is only visible to you' });

    if (dataLines.length > 0) {
      embed.addFields({ name: '📈 Data Summary', value: dataLines.join('\n') });
    }

    // Tips may be long — split into a second embed if needed
    const tipsText = tips.join('\n\n');
    const embeds = [embed];
    if (tipsText.length > 0) {
      if (tipsText.length <= 1024) {
        embed.addFields({ name: '💡 Suggestions & Guidance', value: tipsText });
      } else {
        // Overflow to a second embed
        const tipsEmbed = new EmbedBuilder()
          .setTitle('💡 Suggestions & Guidance')
          .setColor(0xf1c40f)
          .setDescription(tipsText.slice(0, 4096));
        embeds.push(tipsEmbed);
      }
    }

    await interaction.editReply({ embeds });
    return true;
  }

  // ═══════════════════════════════════════════════════════════
  // View selector handler
  // ═══════════════════════════════════════════════════════════

  async _handleViewSelect(interaction) {
    const selected = interaction.values[0];
    // Map 'srv_xxx' → 'xxx' for managed server views
    this._activeView = selected.startsWith('srv_') ? selected.slice(4) : selected;
    // Rebuild panel with new view and update the message
    try {
      await interaction.deferUpdate();
      await this._update(true);
    } catch (err) {
      console.error('[PANEL CH] View switch error:', err.message);
    }
    return true;
  }

  // ═══════════════════════════════════════════════════════════
  // Select menu → modal handlers
  // ═══════════════════════════════════════════════════════════

  async _handleEnvSelect(interaction) {
    if (!await this._requireAdmin(interaction, 'edit bot config')) return true;

    const categoryId = interaction.values[0];
    const category = ENV_CATEGORIES.find(c => c.id === categoryId);
    if (!category) {
      await interaction.reply({ content: '❌ Unknown category.', flags: MessageFlags.Ephemeral });
      return true;
    }

    const restartTag = category.restart ? ' (🔄 Bot Restart)' : ' (✨ Live)';
    const modal = new ModalBuilder()
      .setCustomId(`panel_env_modal:${categoryId}`)
      .setTitle(`Edit: ${category.label}${restartTag}`);

    for (const field of category.fields) {
      const style = field.style === 'paragraph' ? TextInputStyle.Paragraph : TextInputStyle.Short;
      const input = new TextInputBuilder()
        .setCustomId(field.env)
        .setLabel(field.label)
        .setStyle(style)
        .setRequired(false);

      if (field.sensitive) {
        const current = _getEnvValue(field);
        input.setPlaceholder(current ? 'Leave empty to keep current' : 'Enter value');
        input.setValue('');
      } else {
        input.setValue(_getEnvValue(field));
      }

      modal.addComponents(new ActionRowBuilder().addComponents(input));
    }

    await interaction.showModal(modal);
    return true;
  }

  async _handleGameSettingsSelect(interaction) {
    if (!await this._requireAdmin(interaction, 'edit server settings')) return true;

    if (!this._hasSftp) {
      await interaction.reply({ content: '❌ SFTP credentials not configured. Game settings require FTP_HOST, FTP_USER, and FTP_PASSWORD.', flags: MessageFlags.Ephemeral });
      return true;
    }

    const categoryId = interaction.values[0];
    const category = GAME_SETTINGS_CATEGORIES.find(c => c.id === categoryId);
    if (!category) {
      await interaction.reply({ content: '❌ Unknown category.', flags: MessageFlags.Ephemeral });
      return true;
    }

    const cached = _getCachedSettings(this._db);

    const modal = new ModalBuilder()
      .setCustomId(`panel_game_modal:${categoryId}`)
      .setTitle(`Server: ${category.label} (🔄 Server Restart)`);

    for (const setting of category.settings) {
      const currentValue = cached[setting.ini] != null ? String(cached[setting.ini]) : '';
      const input = new TextInputBuilder()
        .setCustomId(setting.ini)
        .setLabel(setting.label)
        .setStyle(TextInputStyle.Short)
        .setValue(currentValue)
        .setRequired(false);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
    }

    await interaction.showModal(modal);
    return true;
  }

  // ═══════════════════════════════════════════════════════════
  // Modal submit handlers
  // ═══════════════════════════════════════════════════════════

  async _handleEnvModal(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    
    if (!this._isAdmin(interaction)) {
      await interaction.editReply('❌ Only administrators can edit bot config.');
      return true;
    }

    const categoryId = interaction.customId.replace('panel_env_modal:', '');
    const category = ENV_CATEGORIES.find(c => c.id === categoryId);
    if (!category) {
      await interaction.editReply('❌ Unknown category.');
      return true;
    }

    try {
      const updates = {};
      const dbUpdates = {};
      const changes = [];

      for (const field of category.fields) {
        const newValue = interaction.fields.getTextInputValue(field.env);

        // Skip empty sensitive fields — keep current value unchanged
        if (field.sensitive && newValue === '') continue;

        const oldValue = _getEnvValue(field);

        if (newValue !== oldValue) {
          const displayOld = field.sensitive ? '••••••' : (oldValue || '(empty)');
          const displayNew = field.sensitive ? '••••••' : (newValue || '(empty)');
          changes.push(`**${field.label}:** \`${displayOld}\` → \`${displayNew}\``);

          if (!category.restart) {
            // Live-apply display settings → save to DB, not .env
            _applyLiveConfig(field, newValue);
            if (field.cfg) dbUpdates[field.cfg] = config[field.cfg];
          } else {
            // Restart-required settings → write to .env
            updates[field.env] = newValue;
          }
        }
      }

      if (changes.length === 0) {
        await interaction.editReply('No changes detected.');
        return true;
      }

      // Persist restart-required changes to .env
      if (Object.keys(updates).length > 0) {
        _writeEnvValues(updates);
      }
      // Persist display settings to DB
      if (Object.keys(dbUpdates).length > 0) {
        config.saveDisplaySettings(this._db, dbUpdates);
      }

      let msg = `✅ **${category.label}** updated:\n${changes.join('\n')}`;
      if (category.restart) {
        msg += '\n\n⚠️ **Restart the bot** for these changes to take effect.';
      } else {
        msg += '\n\n✨ Changes applied immediately.';
      }

      await interaction.editReply(msg);

      // Refresh embeds to show changes
      if (!category.restart) {
        setTimeout(() => this._update(true), 1000);
      }
    } catch (err) {
      await interaction.editReply(`❌ Failed to save: ${err.message}`);
    }

    return true;
  }

  async _handleGameSettingsModal(interaction) {
    if (!await this._requireAdmin(interaction, 'edit server settings')) return true;

    if (!this._hasSftp) {
      await interaction.reply({ content: '❌ SFTP credentials not configured.', flags: MessageFlags.Ephemeral });
      return true;
    }

    const categoryId = interaction.customId.replace('panel_game_modal:', '');
    const category = GAME_SETTINGS_CATEGORIES.find(c => c.id === categoryId);
    if (!category) {
      await interaction.reply({ content: '❌ Unknown category.', flags: MessageFlags.Ephemeral });
      return true;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      // Read fresh INI content via SFTP (panel file API is blocked on some hosts)
      const settingsPath = config.ftpSettingsPath;
      const sftp = new SftpClient();
      await sftp.connect({
        host: config.ftpHost,
        port: config.ftpPort,
        username: config.ftpUser,
        password: config.ftpPassword,
      });

      let content;
      try {
        content = (await sftp.get(settingsPath)).toString('utf8');
      } catch (readErr) {
        await sftp.end().catch(() => {});
        throw new Error(`Could not read settings file: ${readErr.message}`);
      }

      const changes = [];
      const cached = _getCachedSettings(this._db);

      for (const setting of category.settings) {
        const newValue = interaction.fields.getTextInputValue(setting.ini).trim();
        const oldValue = cached[setting.ini] != null ? String(cached[setting.ini]) : '';

        if (newValue !== oldValue) {
          // Regex-replace in raw INI text to preserve comments/formatting
          const regex = new RegExp(`^(${setting.ini}\\s*=\\s*).*$`, 'm');
          if (regex.test(content)) {
            content = content.replace(regex, `$1${newValue}`);
          }
          changes.push(`**${setting.label}:** \`${oldValue || '?'}\` → \`${newValue}\``);
          cached[setting.ini] = newValue;
        }
      }

      if (changes.length === 0) {
        await sftp.end().catch(() => {});
        await interaction.editReply('No changes detected.');
        return true;
      }

      // Write modified INI back via SFTP
      await sftp.put(Buffer.from(content, 'utf8'), settingsPath);
      await sftp.end().catch(() => {});

      // Update local cache so subsequent reads are fresh
      if (this._db) try { this._db.setStateJSON('server_settings', cached); } catch (_) {}

      let msg = `✅ **${category.label}** updated:\n${changes.join('\n')}`;
      msg += '\n\n⚠️ **Restart the server** for these changes to take effect.';

      await interaction.editReply(msg);
    } catch (err) {
      await interaction.editReply(`❌ Failed to save: ${err.message}`);
    }

    return true;
  }

  // ═══════════════════════════════════════════════════════════
  // Multi-server handlers
  // ═══════════════════════════════════════════════════════════

  async _handleAddServerButton(interaction) {
    if (!await this._requireAdmin(interaction, 'manage servers')) return true;

    const modal = new ModalBuilder()
      .setCustomId('panel_add_modal_step1')
      .setTitle('Add Server — Step 1: Connection');

    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('name').setLabel('Server Name').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('e.g. PvP Server')
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('rcon_host').setLabel('RCON Host').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('e.g. 192.168.1.100')
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('rcon_port').setLabel('RCON Port').setStyle(TextInputStyle.Short).setRequired(false).setValue('14541')
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('rcon_password').setLabel('RCON Password').setStyle(TextInputStyle.Short).setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('game_port').setLabel('Game Port').setStyle(TextInputStyle.Short).setRequired(false).setValue('14242')
      ),
    );

    await interaction.showModal(modal);
    return true;
  }

  async _handleAddServerStep1Modal(interaction) {
    if (!await this._requireAdmin(interaction, 'manage servers')) return true;

    const name = interaction.fields.getTextInputValue('name').trim();
    const rconHost = interaction.fields.getTextInputValue('rcon_host').trim();
    const rconPort = parseInt(interaction.fields.getTextInputValue('rcon_port'), 10) || 14541;
    const rconPassword = interaction.fields.getTextInputValue('rcon_password').trim();
    const gamePort = parseInt(interaction.fields.getTextInputValue('game_port'), 10) || 14242;

    if (!name || !rconHost || !rconPassword) {
      await interaction.reply({ content: '❌ Name, RCON Host, and RCON Password are required.', flags: MessageFlags.Ephemeral });
      return true;
    }

    // Store partial config for step 2
    this._pendingServers.set(interaction.user.id, {
      name,
      rcon: { host: rconHost, port: rconPort, password: rconPassword },
      gamePort,
      _createdAt: Date.now(),
    });

    // Show step 2 button
    const sftpBtn = new ButtonBuilder()
      .setCustomId(`panel_add_sftp:${interaction.user.id}`)
      .setLabel('Configure SFTP')
      .setStyle(ButtonStyle.Primary);

    const continueBtn = new ButtonBuilder()
      .setCustomId(`panel_add_step2:${interaction.user.id}`)
      .setLabel('Configure Channels')
      .setStyle(ButtonStyle.Primary);

    const skipBtn = new ButtonBuilder()
      .setCustomId(`panel_srv_skip_channels:${interaction.user.id}`)
      .setLabel('Skip — Save Now')
      .setStyle(ButtonStyle.Secondary);

    await interaction.reply({
      content: `✅ **Step 1 complete!** Server "${name}" connection configured.\n\n` +
        `**Next:** Configure SFTP for log watching, player stats, and save reading (file paths auto-discover).\n` +
        `Or skip SFTP to inherit the primary server's connection.\n` +
        `You can also configure channels or save now.`,
      components: [new ActionRowBuilder().addComponents(sftpBtn, continueBtn, skipBtn)],
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  async _handleAddSftpButton(interaction, customId) {
    if (!await this._requireAdmin(interaction, 'manage servers')) return true;

    const userId = customId.replace('panel_add_sftp:', '');
    const pending = this._pendingServers.get(userId);
    if (!pending) {
      await interaction.reply({ content: '❌ Session expired. Please start over with "Add Server".', flags: MessageFlags.Ephemeral });
      return true;
    }

    const modal = new ModalBuilder()
      .setCustomId(`panel_add_sftp_modal:${userId}`)
      .setTitle('Add Server — SFTP Connection');

    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('sftp_host').setLabel('SFTP Host').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('e.g. atlas.realm.se')
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('sftp_port').setLabel('SFTP Port').setStyle(TextInputStyle.Short).setRequired(false).setValue('22')
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('sftp_user').setLabel('SFTP Username').setStyle(TextInputStyle.Short).setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('sftp_password').setLabel('SFTP Password').setStyle(TextInputStyle.Short).setRequired(true)
      ),
    );

    await interaction.showModal(modal);
    return true;
  }

  async _handleAddSftpModal(interaction) {
    if (!await this._requireAdmin(interaction, 'manage servers')) return true;

    const userId = interaction.customId.replace('panel_add_sftp_modal:', '');
    const pending = this._pendingServers.get(userId);
    if (!pending) {
      await interaction.reply({ content: '❌ Session expired. Please start over with "Add Server".', flags: MessageFlags.Ephemeral });
      return true;
    }

    const host = interaction.fields.getTextInputValue('sftp_host').trim();
    const port = parseInt(interaction.fields.getTextInputValue('sftp_port'), 10) || 22;
    const user = interaction.fields.getTextInputValue('sftp_user').trim();
    const password = interaction.fields.getTextInputValue('sftp_password').trim();

    if (!host || !user || !password) {
      await interaction.reply({ content: '❌ SFTP host, username, and password are required.', flags: MessageFlags.Ephemeral });
      return true;
    }

    // Store SFTP config on the pending server definition
    pending.sftp = { host, port, user, password };

    // Show continue/skip buttons
    const continueBtn = new ButtonBuilder()
      .setCustomId(`panel_add_step2:${userId}`)
      .setLabel('Configure Channels')
      .setStyle(ButtonStyle.Primary);

    const skipBtn = new ButtonBuilder()
      .setCustomId(`panel_srv_skip_channels:${userId}`)
      .setLabel('Skip — Save Now')
      .setStyle(ButtonStyle.Secondary);

    await interaction.reply({
      content: `✅ **SFTP configured!** \`${host}:${port}\`\n` +
        `File paths will auto-discover when the server starts.\n\n` +
        `**Next:** Configure channels or save now.`,
      components: [new ActionRowBuilder().addComponents(continueBtn, skipBtn)],
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  async _handleAddServerStep2Button(interaction, customId) {
    if (!await this._requireAdmin(interaction, 'manage servers')) return true;

    const userId = customId.replace('panel_add_step2:', '');
    const pending = this._pendingServers.get(userId);
    if (!pending) {
      await interaction.reply({ content: '❌ Session expired. Please start over with "Add Server".', flags: MessageFlags.Ephemeral });
      return true;
    }

    const modal = new ModalBuilder()
      .setCustomId(`panel_add_modal_step2:${userId}`)
      .setTitle('Add Server — Step 2: Channels');

    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('ch_status').setLabel('Server Status Channel ID').setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder('Right-click channel → Copy Channel ID')
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('ch_stats').setLabel('Player Stats Channel ID').setStyle(TextInputStyle.Short).setRequired(false)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('ch_log').setLabel('Log Channel ID').setStyle(TextInputStyle.Short).setRequired(false)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('ch_chat').setLabel('Chat Relay Channel ID').setStyle(TextInputStyle.Short).setRequired(false)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('ch_admin').setLabel('Admin Channel ID').setStyle(TextInputStyle.Short).setRequired(false)
      ),
    );

    await interaction.showModal(modal);
    return true;
  }

  async _handleAddServerStep2Modal(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    
    if (!this._isAdmin(interaction)) {
      await interaction.editReply('❌ Only administrators can manage servers.');
      return true;
    }

    const userId = interaction.customId.replace('panel_add_modal_step2:', '');
    const pending = this._pendingServers.get(userId);
    if (!pending) {
      await interaction.editReply('❌ Session expired. Please start over with "Add Server".');
      return true;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const channels = {};
    const chStatus = interaction.fields.getTextInputValue('ch_status').trim();
    const chStats = interaction.fields.getTextInputValue('ch_stats').trim();
    const chLog = interaction.fields.getTextInputValue('ch_log').trim();
    const chChat = interaction.fields.getTextInputValue('ch_chat').trim();
    const chAdmin = interaction.fields.getTextInputValue('ch_admin').trim();

    if (chStatus) channels.serverStatus = chStatus;
    if (chStats) channels.playerStats = chStats;
    if (chLog) channels.log = chLog;
    if (chChat) channels.chat = chChat;
    if (chAdmin) channels.admin = chAdmin;

    const serverDef = { ...pending, channels, enabled: true };
    this._pendingServers.delete(userId);

    try {
      if (!this.multiServerManager) {
        await interaction.editReply('❌ Multi-server manager not available.');
        return true;
      }

      const saved = await this.multiServerManager.addServer(serverDef);
      const channelCount = Object.keys(channels).length;

      // Post a per-server management embed
      try {
        const instance = this.multiServerManager.getInstance(saved.id);
        const embed = this._buildManagedServerEmbed(saved, instance);
        const components = this._buildManagedServerComponents(saved.id, instance?.running || false);
        const msg = await this.channel.send({ embeds: [embed], components });
        this._serverMessages.set(saved.id, msg);
        this._saveMessageIds();
      } catch (embedErr) {
        console.error(`[PANEL CH] Failed to post embed for new server ${saved.name}:`, embedErr.message);
      }

      await interaction.editReply(
        `✅ **${saved.name}** added and started!\n` +
        `• RCON: \`${saved.rcon.host}:${saved.rcon.port}\`\n` +
        `• Game Port: \`${saved.gamePort}\`\n` +
        `• Channels: ${channelCount} configured\n` +
        `• SFTP: Inherited from primary server`
      );

      // Refresh the bot controls embed
      setTimeout(() => this._update(true), 1000);
    } catch (err) {
      await interaction.editReply(`❌ Failed to add server: ${err.message}`);
    }

    return true;
  }

  async _handleServerSelect(interaction) {
    if (!await this._requireAdmin(interaction, 'manage servers')) return true;

    const serverId = interaction.values[0];
    const servers = this.multiServerManager?.getAllServers() || [];
    const server = servers.find(s => s.id === serverId);
    if (!server) {
      await interaction.reply({ content: '❌ Server not found.', flags: MessageFlags.Ephemeral });
      return true;
    }

    const instance = this.multiServerManager.getInstance(serverId);
    const running = instance?.running || false;

    // Build management buttons
    const row1 = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`panel_srv_start:${serverId}`)
        .setLabel('Start')
        .setStyle(ButtonStyle.Success)
        .setDisabled(running),
      new ButtonBuilder()
        .setCustomId(`panel_srv_stop:${serverId}`)
        .setLabel('Stop')
        .setStyle(ButtonStyle.Danger)
        .setDisabled(!running),
      new ButtonBuilder()
        .setCustomId(`panel_srv_edit:${serverId}`)
        .setLabel('Edit Connection')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`panel_srv_remove:${serverId}`)
        .setLabel('Remove')
        .setStyle(ButtonStyle.Danger),
    );

    const row2 = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`panel_srv_channels:${serverId}`)
        .setLabel('Edit Channels')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`panel_srv_sftp:${serverId}`)
        .setLabel('Edit SFTP')
        .setStyle(ButtonStyle.Secondary),
    );

    // Build info text
    const ch = server.channels || {};
    const channelLines = [];
    if (ch.serverStatus) channelLines.push(`Status: <#${ch.serverStatus}>`);
    if (ch.playerStats) channelLines.push(`Stats: <#${ch.playerStats}>`);
    if (ch.log) channelLines.push(`Log: <#${ch.log}>`);
    if (ch.chat) channelLines.push(`Chat: <#${ch.chat}>`);
    if (ch.admin) channelLines.push(`Admin: <#${ch.admin}>`);

    const sftpInfo = server.sftp?.host ? `${server.sftp.host}:${server.sftp.port || 22}` : 'Inherited from primary';
    const moduleList = instance ? instance.getStatus().modules.join(', ') || 'None' : 'Not running';

    await interaction.reply({
      content: [
        `**${server.name}** ${running ? '🟢 Running' : '🔴 Stopped'}`,
        `• RCON: \`${server.rcon?.host || '?'}:${server.rcon?.port || 14541}\``,
        `• Game Port: \`${server.gamePort || 14242}\``,
        `• SFTP: ${sftpInfo}`,
        `• Channels: ${channelLines.length > 0 ? '\n' + channelLines.map(l => `  ${l}`).join('\n') : 'None configured'}`,
        `• Modules: ${moduleList}`,
      ].join('\n'),
      components: [row1, row2],
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  async _handleServerAction(interaction, customId) {
    if (!await this._requireAdmin(interaction, 'manage servers')) return true;

    // Handle skip channels button from add wizard
    if (customId.startsWith('panel_srv_skip_channels:')) {
      const userId = customId.replace('panel_srv_skip_channels:', '');
      const pending = this._pendingServers.get(userId);
      if (!pending) {
        await interaction.reply({ content: '❌ Session expired. Please start over.', flags: MessageFlags.Ephemeral });
        return true;
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const serverDef = { ...pending, channels: {}, enabled: true };
      this._pendingServers.delete(userId);

      try {
        const saved = await this.multiServerManager.addServer(serverDef);
        // Post a per-server management embed
        try {
          const instance = this.multiServerManager.getInstance(saved.id);
          const embed = this._buildManagedServerEmbed(saved, instance);
          const components = this._buildManagedServerComponents(saved.id, instance?.running || false);
          const msg = await this.channel.send({ embeds: [embed], components });
          this._serverMessages.set(saved.id, msg);
          this._saveMessageIds();
        } catch (embedErr) {
          console.error(`[PANEL CH] Failed to post embed for new server ${saved.name}:`, embedErr.message);
        }
        await interaction.editReply(
          `✅ **${saved.name}** added (no channels configured).\n` +
          `Use the server embed buttons to configure channels.`
        );
        setTimeout(() => this._update(true), 1000);
      } catch (err) {
        await interaction.editReply(`❌ Failed to add server: ${err.message}`);
      }
      return true;
    }

    // Parse action and serverId from customId: panel_srv_<action>:<serverId>
    const match = customId.match(/^panel_srv_(\w+):(.+)$/);
    if (!match) return false;

    const [, action, serverId] = match;

    switch (action) {
      case 'start': {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
          await this.multiServerManager.startServer(serverId);
          await interaction.editReply('✅ Server started.');
          setTimeout(() => this._update(true), 2000);
        } catch (err) {
          await interaction.editReply(`❌ Failed to start: ${err.message}`);
        }
        return true;
      }

      case 'stop': {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
          await this.multiServerManager.stopServer(serverId);
          await interaction.editReply('✅ Server stopped.');
          setTimeout(() => this._update(true), 1000);
        } catch (err) {
          await interaction.editReply(`❌ Failed to stop: ${err.message}`);
        }
        return true;
      }

      case 'restart': {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
          await this.multiServerManager.stopServer(serverId);
          await this.multiServerManager.startServer(serverId);
          await interaction.editReply('✅ Server restarted (modules stopped + started).');
          setTimeout(() => this._update(true), 2000);
        } catch (err) {
          await interaction.editReply(`❌ Failed to restart: ${err.message}`);
        }
        return true;
      }

      case 'remove': {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
          const servers = this.multiServerManager.getAllServers();
          const server = servers.find(s => s.id === serverId);
          const name = server?.name || serverId;
          await this.multiServerManager.removeServer(serverId);
          // Delete the per-server embed message
          const srvMsg = this._serverMessages.get(serverId);
          if (srvMsg) {
            try { await srvMsg.delete(); } catch {}
            this._serverMessages.delete(serverId);
            this._lastServerKeys.delete(serverId);
            this._saveMessageIds();
          }
          await interaction.editReply(`✅ **${name}** removed.`);
          setTimeout(() => this._update(true), 1000);
        } catch (err) {
          await interaction.editReply(`❌ Failed to remove: ${err.message}`);
        }
        return true;
      }

      case 'edit': {
        // Show modal with current connection values
        const servers = this.multiServerManager.getAllServers();
        const server = servers.find(s => s.id === serverId);
        if (!server) {
          await interaction.reply({ content: '❌ Server not found.', flags: MessageFlags.Ephemeral });
          return true;
        }

        const modal = new ModalBuilder()
          .setCustomId(`panel_srv_edit_modal:${serverId}`)
          .setTitle(_modalTitle('Edit: ', server.name, ' (🔄 Server Restart)'));

        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('name').setLabel('Server Name').setStyle(TextInputStyle.Short).setValue(server.name || '')
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('rcon_host').setLabel('RCON Host').setStyle(TextInputStyle.Short).setValue(server.rcon?.host || '')
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('rcon_port').setLabel('RCON Port').setStyle(TextInputStyle.Short).setValue(String(server.rcon?.port || 14541))
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('rcon_password').setLabel('RCON Password (blank = keep current)').setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder(server.rcon?.password ? '(unchanged)' : 'Enter password')
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('game_port').setLabel('Game Port').setStyle(TextInputStyle.Short).setValue(String(server.gamePort || 14242))
          ),
        );

        await interaction.showModal(modal);
        return true;
      }

      case 'channels': {
        const servers = this.multiServerManager.getAllServers();
        const server = servers.find(s => s.id === serverId);
        if (!server) {
          await interaction.reply({ content: '❌ Server not found.', flags: MessageFlags.Ephemeral });
          return true;
        }

        const ch = server.channels || {};
        const modal = new ModalBuilder()
          .setCustomId(`panel_srv_channels_modal:${serverId}`)
          .setTitle(_modalTitle('Channels: ', server.name, ' (🔄 Server Restart)'));

        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('ch_status').setLabel('Server Status Channel ID').setStyle(TextInputStyle.Short).setValue(ch.serverStatus || '').setRequired(false)
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('ch_stats').setLabel('Player Stats Channel ID').setStyle(TextInputStyle.Short).setValue(ch.playerStats || '').setRequired(false)
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('ch_log').setLabel('Log Channel ID').setStyle(TextInputStyle.Short).setValue(ch.log || '').setRequired(false)
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('ch_chat').setLabel('Chat Relay Channel ID').setStyle(TextInputStyle.Short).setValue(ch.chat || '').setRequired(false)
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('ch_admin').setLabel('Admin Channel ID').setStyle(TextInputStyle.Short).setValue(ch.admin || '').setRequired(false)
          ),
        );

        await interaction.showModal(modal);
        return true;
      }

      case 'sftp': {
        const servers = this.multiServerManager.getAllServers();
        const server = servers.find(s => s.id === serverId);
        if (!server) {
          await interaction.reply({ content: '❌ Server not found.', flags: MessageFlags.Ephemeral });
          return true;
        }

        const sftp = server.sftp || {};
        const modal = new ModalBuilder()
          .setCustomId(`panel_srv_sftp_modal:${serverId}`)
          .setTitle(_modalTitle('SFTP: ', server.name, ' (🔄 Server Restart)'));

        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('sftp_host').setLabel('SFTP Host (blank = inherit primary)').setStyle(TextInputStyle.Short).setValue(sftp.host || '').setRequired(false)
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('sftp_port').setLabel('SFTP Port').setStyle(TextInputStyle.Short).setValue(String(sftp.port || 22)).setRequired(false)
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('sftp_user').setLabel('SFTP Username (blank = inherit)').setStyle(TextInputStyle.Short).setValue(sftp.user || '').setRequired(false)
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('sftp_password').setLabel('SFTP Password (blank = inherit primary)').setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder(sftp.password ? '(unchanged)' : 'blank = inherit')
          ),
        );

        await interaction.showModal(modal);
        return true;
      }

      case 'welcome': {
        // Show modal to edit the server's WelcomeMessage.txt
        const servers = this.multiServerManager.getAllServers();
        const server = servers.find(s => s.id === serverId);
        if (!server) {
          await interaction.reply({ content: '❌ Server not found.', flags: MessageFlags.Ephemeral });
          return true;
        }

        const srvConfig = createServerConfig(server);
        if (!srvConfig.ftpHost || !srvConfig.ftpUser || (!srvConfig.ftpPassword && !srvConfig.ftpPrivateKeyPath)) {
          await interaction.reply({ content: '❌ No SFTP credentials configured for this server.', flags: MessageFlags.Ephemeral });
          return true;
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        let currentContent = '';
        try {
          const sftp = new SftpClient();
          await sftp.connect({ host: srvConfig.ftpHost, port: srvConfig.ftpPort, username: srvConfig.ftpUser, password: srvConfig.ftpPassword });
          const welcomePath = srvConfig.ftpWelcomePath || config.ftpWelcomePath;
          const buf = await sftp.get(welcomePath);
          currentContent = buf.toString('utf8');
          await sftp.end().catch(() => {});
        } catch (err) {
          await interaction.editReply(`❌ Could not read WelcomeMessage.txt: ${err.message}`);
          return true;
        }

        // Discord modal text inputs max 4000 chars
        if (currentContent.length > 4000) currentContent = currentContent.slice(0, 4000);

        const modal = new ModalBuilder()
          .setCustomId(`panel_srv_welcome_modal:${serverId}`)
          .setTitle(_modalTitle('Welcome: ', server.name, ''));

        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('welcome_content')
              .setLabel('Welcome Message')
              .setStyle(TextInputStyle.Paragraph)
              .setValue(currentContent)
              .setRequired(false)
              .setMaxLength(4000)
          ),
        );

        await interaction.showModal(modal);
        await interaction.deleteReply().catch(() => {});
        return true;
      }

      case 'automsg': {
        // Show modal to edit per-server auto-message settings
        const servers = this.multiServerManager.getAllServers();
        const server = servers.find(s => s.id === serverId);
        if (!server) {
          await interaction.reply({ content: '❌ Server not found.', flags: MessageFlags.Ephemeral });
          return true;
        }

        const am = server.autoMessages || {};
        const srvConfig = instance?.config || createServerConfig(server);

        const modal = new ModalBuilder()
          .setCustomId(`panel_srv_automsg_modal:${serverId}`)
          .setTitle(_modalTitle('Auto Msgs: ', server.name, ''));

        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('toggles')
              .setLabel('Toggles (welcome_msg,welcome_file,link,promo)')
              .setStyle(TextInputStyle.Short)
              .setValue([
                (am.enableWelcomeMsg  ?? srvConfig.enableWelcomeMsg  ?? true) ? '1' : '0',
                (am.enableWelcomeFile ?? srvConfig.enableWelcomeFile ?? true) ? '1' : '0',
                (am.enableAutoMsgLink ?? srvConfig.enableAutoMsgLink ?? true) ? '1' : '0',
                (am.enableAutoMsgPromo ?? srvConfig.enableAutoMsgPromo ?? true) ? '1' : '0',
              ].join(','))
              .setPlaceholder('1,1,1,1 (1=on, 0=off)')
              .setRequired(true)
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('link_text')
              .setLabel('Discord Link Broadcast (blank = default)')
              .setStyle(TextInputStyle.Paragraph)
              .setValue(am.linkText || '')
              .setRequired(false)
              .setMaxLength(4000)
              .setPlaceholder('Join our Discord! {discord_link}')
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('promo_text')
              .setLabel('Promo Broadcast (blank = default)')
              .setStyle(TextInputStyle.Paragraph)
              .setValue(am.promoText || '')
              .setRequired(false)
              .setMaxLength(4000)
              .setPlaceholder('Have any issues? Join our Discord: {discord_link}')
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId('discord_link')
              .setLabel('Discord Invite Link (blank = inherit)')
              .setStyle(TextInputStyle.Short)
              .setValue(am.discordLink || '')
              .setRequired(false)
              .setPlaceholder('https://discord.gg/...')
          ),
        );

        await interaction.showModal(modal);
        return true;
      }

      default:
        return false;
    }
  }

  async _handleEditServerModal(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    
    if (!this._isAdmin(interaction)) {
      await interaction.editReply('❌ Only administrators can manage servers.');
      return true;
    }

    const serverId = interaction.customId.replace('panel_srv_edit_modal:', '');

    try {
      const updates = {
        name: interaction.fields.getTextInputValue('name').trim(),
        gamePort: parseInt(interaction.fields.getTextInputValue('game_port'), 10) || 14242,
        rcon: {
          host: interaction.fields.getTextInputValue('rcon_host').trim(),
          port: parseInt(interaction.fields.getTextInputValue('rcon_port'), 10) || 14541,
        },
      };
      // Only update password if user typed something (blank = keep current)
      const rconPw = interaction.fields.getTextInputValue('rcon_password').trim();
      if (rconPw) updates.rcon.password = rconPw;

      const saved = await this.multiServerManager.updateServer(serverId, updates);
      await interaction.editReply(`✅ **${saved.name}** connection updated. Server restarted with new settings.`);
      setTimeout(() => this._update(true), 2000);
    } catch (err) {
      await interaction.editReply(`❌ Failed to update: ${err.message}`);
    }
    return true;
  }

  async _handleEditChannelsModal(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    
    if (!this._isAdmin(interaction)) {
      await interaction.editReply('❌ Only administrators can manage servers.');
      return true;
    }

    const serverId = interaction.customId.replace('panel_srv_channels_modal:', '');

    try {
      const channels = {};
      const status = interaction.fields.getTextInputValue('ch_status').trim();
      const stats = interaction.fields.getTextInputValue('ch_stats').trim();
      const log = interaction.fields.getTextInputValue('ch_log').trim();
      const chat = interaction.fields.getTextInputValue('ch_chat').trim();
      const admin = interaction.fields.getTextInputValue('ch_admin').trim();

      if (status) channels.serverStatus = status;
      if (stats) channels.playerStats = stats;
      if (log) channels.log = log;
      if (chat) channels.chat = chat;
      if (admin) channels.admin = admin;

      const saved = await this.multiServerManager.updateServer(serverId, { channels });
      await interaction.editReply(`✅ **${saved.name}** channels updated. Server restarted with new settings.`);
      setTimeout(() => this._update(true), 2000);
    } catch (err) {
      await interaction.editReply(`❌ Failed to update: ${err.message}`);
    }
    return true;
  }

  async _handleEditSftpModal(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    
    if (!this._isAdmin(interaction)) {
      await interaction.editReply('❌ Only administrators can manage servers.');
      return true;
    }

    const serverId = interaction.customId.replace('panel_srv_sftp_modal:', '');

    try {
      const sftp = {};
      const host = interaction.fields.getTextInputValue('sftp_host').trim();
      const port = interaction.fields.getTextInputValue('sftp_port').trim();
      const user = interaction.fields.getTextInputValue('sftp_user').trim();
      const password = interaction.fields.getTextInputValue('sftp_password').trim();

      if (host) sftp.host = host;
      if (port) sftp.port = parseInt(port, 10) || 22;
      if (user) sftp.user = user;
      if (password) sftp.password = password;

      // If SFTP host changed, clear old paths so auto-discovery re-runs on restart
      const servers = this.multiServerManager.getAllServers();
      const currentServer = servers.find(s => s.id === serverId);
      const hostChanged = host && currentServer?.sftp?.host !== host;
      const updates = { sftp };
      if (hostChanged) updates.paths = {};

      const saved = await this.multiServerManager.updateServer(serverId, updates);
      const sftpStatus = sftp.host ? `${sftp.host}:${sftp.port || 22}` : 'Inherited from primary';
      const extra = hostChanged ? ' Paths will auto-discover on startup.' : '';
      await interaction.editReply(`✅ **${saved.name}** SFTP updated to: ${sftpStatus}${extra}\nServer restarted with new settings.`);
      setTimeout(() => this._update(true), 2000);
    } catch (err) {
      await interaction.editReply(`❌ Failed to update: ${err.message}`);
    }
    return true;
  }

  // ═══════════════════════════════════════════════════════════
  // Managed-server game settings editor (per-server SFTP)
  // ═══════════════════════════════════════════════════════════

  /** Get effective SFTP config for a managed server (own creds or inherited from primary). */
  _getSrvSftpConfig(serverDef) {
    const srvConfig = createServerConfig(serverDef);
    if (!srvConfig.ftpHost || !srvConfig.ftpUser || (!srvConfig.ftpPassword && !srvConfig.ftpPrivateKeyPath)) return null;
    return {
      host: srvConfig.ftpHost,
      port: srvConfig.ftpPort,
      username: srvConfig.ftpUser,
      password: srvConfig.ftpPassword,
      settingsPath: srvConfig.ftpSettingsPath || config.ftpSettingsPath,
      welcomePath: srvConfig.ftpWelcomePath || config.ftpWelcomePath,
    };
  }

  async _handleSrvGameSettingsSelect(interaction) {
    if (!await this._requireAdmin(interaction, 'edit server settings')) return true;

    // customId = panel_srv_settings:<serverId>, value = categoryId
    const serverId = interaction.customId.replace('panel_srv_settings:', '');
    const categoryId = interaction.values[0];
    const category = GAME_SETTINGS_CATEGORIES.find(c => c.id === categoryId);
    if (!category) {
      await interaction.reply({ content: '❌ Unknown category.', flags: MessageFlags.Ephemeral });
      return true;
    }

    const servers = this.multiServerManager?.getAllServers() || [];
    const serverDef = servers.find(s => s.id === serverId);
    if (!serverDef) {
      await interaction.reply({ content: '❌ Server not found.', flags: MessageFlags.Ephemeral });
      return true;
    }

    const sftpCfg = this._getSrvSftpConfig(serverDef);
    if (!sftpCfg) {
      await interaction.reply({ content: '❌ No SFTP credentials for this server.', flags: MessageFlags.Ephemeral });
      return true;
    }

    // Read current settings from bot_state cache
    let cached = {};
    if (this._db) try { cached = this._db.getStateJSON(`server_settings_${serverId}`, {}) || {}; } catch {}

    const modal = new ModalBuilder()
      .setCustomId(`panel_srv_game_modal:${serverId}:${categoryId}`)
      .setTitle(_modalTitle(`${serverDef.name}: `, category.label, ' (🔄 Restart)'));

    for (const setting of category.settings) {
      const currentValue = cached[setting.ini] != null ? String(cached[setting.ini]) : '';
      const input = new TextInputBuilder()
        .setCustomId(setting.ini)
        .setLabel(setting.label)
        .setStyle(TextInputStyle.Short)
        .setValue(currentValue)
        .setRequired(false);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
    }

    await interaction.showModal(modal);
    return true;
  }

  async _handleSrvGameSettingsModal(interaction) {
    if (!await this._requireAdmin(interaction, 'edit server settings')) return true;

    // customId = panel_srv_game_modal:<serverId>:<categoryId>
    const parts = interaction.customId.replace('panel_srv_game_modal:', '').split(':');
    const serverId = parts[0];
    const categoryId = parts[1];
    const category = GAME_SETTINGS_CATEGORIES.find(c => c.id === categoryId);
    if (!category) {
      await interaction.reply({ content: '❌ Unknown category.', flags: MessageFlags.Ephemeral });
      return true;
    }

    const servers = this.multiServerManager?.getAllServers() || [];
    const serverDef = servers.find(s => s.id === serverId);
    if (!serverDef) {
      await interaction.reply({ content: '❌ Server not found.', flags: MessageFlags.Ephemeral });
      return true;
    }

    const sftpCfg = this._getSrvSftpConfig(serverDef);
    if (!sftpCfg) {
      await interaction.reply({ content: '❌ No SFTP credentials for this server.', flags: MessageFlags.Ephemeral });
      return true;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const sftp = new SftpClient();
      await sftp.connect({ host: sftpCfg.host, port: sftpCfg.port, username: sftpCfg.username, password: sftpCfg.password });

      let content;
      try {
        content = (await sftp.get(sftpCfg.settingsPath)).toString('utf8');
      } catch (readErr) {
        await sftp.end().catch(() => {});
        throw new Error(`Could not read settings file: ${readErr.message}`);
      }

      // Read/update cache
      let cached = {};
      if (this._db) try { cached = this._db.getStateJSON(`server_settings_${serverId}`, {}) || {}; } catch {}

      const changes = [];
      for (const setting of category.settings) {
        const newValue = interaction.fields.getTextInputValue(setting.ini).trim();
        const oldValue = cached[setting.ini] != null ? String(cached[setting.ini]) : '';

        if (newValue !== oldValue) {
          const regex = new RegExp(`^(${setting.ini}\\s*=\\s*).*$`, 'm');
          if (regex.test(content)) {
            content = content.replace(regex, `$1${newValue}`);
          }
          changes.push(`**${setting.label}:** \`${oldValue || '?'}\` → \`${newValue}\``);
          cached[setting.ini] = newValue;
        }
      }

      if (changes.length === 0) {
        await sftp.end().catch(() => {});
        await interaction.editReply('No changes detected.');
        return true;
      }

      await sftp.put(Buffer.from(content, 'utf8'), sftpCfg.settingsPath);
      await sftp.end().catch(() => {});

      if (this._db) try { this._db.setStateJSON(`server_settings_${serverId}`, cached); } catch (_) {}

      let msg = `✅ **${serverDef.name} — ${category.label}** updated:\n${changes.join('\n')}`;
      msg += '\n\n⚠️ **Restart the game server** for these changes to take effect.';

      await interaction.editReply(msg);
    } catch (err) {
      await interaction.editReply(`❌ Failed to save: ${err.message}`);
    }
    return true;
  }

  async _handleSrvWelcomeModal(interaction) {
    if (!await this._requireAdmin(interaction, 'manage servers')) return true;

    const serverId = interaction.customId.replace('panel_srv_welcome_modal:', '');

    const servers = this.multiServerManager?.getAllServers() || [];
    const serverDef = servers.find(s => s.id === serverId);
    if (!serverDef) {
      await interaction.reply({ content: '❌ Server not found.', flags: MessageFlags.Ephemeral });
      return true;
    }

    const sftpCfg = this._getSrvSftpConfig(serverDef);
    if (!sftpCfg) {
      await interaction.reply({ content: '❌ No SFTP credentials for this server.', flags: MessageFlags.Ephemeral });
      return true;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const newContent = interaction.fields.getTextInputValue('welcome_content');
      const sftp = new SftpClient();
      await sftp.connect({ host: sftpCfg.host, port: sftpCfg.port, username: sftpCfg.username, password: sftpCfg.password });
      await sftp.put(Buffer.from(newContent, 'utf8'), sftpCfg.welcomePath);
      await sftp.end().catch(() => {});

      await interaction.editReply(`✅ **${serverDef.name}** welcome message updated (${newContent.length} chars).`);
    } catch (err) {
      await interaction.editReply(`❌ Failed to save welcome message: ${err.message}`);
    }
    return true;
  }

  async _handleSrvAutoMsgModal(interaction) {
    if (!await this._requireAdmin(interaction, 'manage servers')) return true;

    const serverId = interaction.customId.replace('panel_srv_automsg_modal:', '');

    const servers = this.multiServerManager?.getAllServers() || [];
    const idx = servers.findIndex(s => s.id === serverId);
    if (idx === -1) {
      await interaction.reply({ content: '❌ Server not found.', flags: MessageFlags.Ephemeral });
      return true;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const togglesRaw = interaction.fields.getTextInputValue('toggles').trim();
      const linkText = interaction.fields.getTextInputValue('link_text').trim();
      const promoText = interaction.fields.getTextInputValue('promo_text').trim();
      const discordLink = interaction.fields.getTextInputValue('discord_link').trim();

      // Parse toggles: "1,1,0,1" → [true, true, false, true]
      const bits = togglesRaw.split(',').map(s => s.trim() === '1');
      const am = {
        enableWelcomeMsg:   bits[0] ?? true,
        enableWelcomeFile:  bits[1] ?? true,
        enableAutoMsgLink:  bits[2] ?? true,
        enableAutoMsgPromo: bits[3] ?? true,
      };
      if (linkText) am.linkText = linkText;
      if (promoText) am.promoText = promoText;
      if (discordLink) am.discordLink = discordLink;

      // Persist to servers.json
      const { loadServers, saveServers } = require('../server/multi-server');
      const allServers = loadServers();
      const srvIdx = allServers.findIndex(s => s.id === serverId);
      if (srvIdx !== -1) {
        allServers[srvIdx].autoMessages = am;
        saveServers(allServers);
      }

      // Hot-update the running instance's config
      const instance = this.multiServerManager.getInstance(serverId);
      if (instance) {
        instance.config.enableWelcomeMsg  = am.enableWelcomeMsg;
        instance.config.enableWelcomeFile = am.enableWelcomeFile;
        instance.config.enableAutoMsgLink = am.enableAutoMsgLink;
        instance.config.enableAutoMsgPromo = am.enableAutoMsgPromo;
        instance.config.autoMsgLinkText  = am.linkText || '';
        instance.config.autoMsgPromoText = am.promoText || '';
        if (am.discordLink) instance.config.discordInviteLink = am.discordLink;
      }

      // Build summary
      const labels = ['RCON Welcome', 'Welcome File', 'Link Broadcast', 'Promo Broadcast'];
      const summary = labels.map((l, i) => `${bits[i] ? '✅' : '❌'} ${l}`).join('\n');
      const extras = [];
      if (linkText) extras.push(`Link text: \`${linkText.slice(0, 60)}${linkText.length > 60 ? '...' : ''}\``);
      if (promoText) extras.push(`Promo text: \`${promoText.slice(0, 60)}${promoText.length > 60 ? '...' : ''}\``);
      if (discordLink) extras.push(`Discord: \`${discordLink}\``);

      await interaction.editReply(
        `✅ **Auto Messages updated for ${servers[idx].name}**\n${summary}` +
        (extras.length > 0 ? `\n${extras.join('\n')}` : '') +
        `\n\n⚠️ Restart the server to apply toggle changes.`
      );
    } catch (err) {
      await interaction.editReply(`❌ Failed to save: ${err.message}`);
    }
    return true;
  }

  // ═══════════════════════════════════════════════════════════
  // .env synchronization
  // ═══════════════════════════════════════════════════════════

  async _handleEnvSyncButton(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    
    if (!this._isAdmin(interaction)) {
      await interaction.editReply('❌ Only administrators can sync .env configuration.');
      return true;
    }

    const { needsSync, syncEnv, getVersion, getExampleVersion } = require('../env-sync');

    if (!needsSync()) {
      await interaction.editReply('✅ Your `.env` is already up to date with `.env.example`.');
      return true;
    }

    try {
      const currentVer = getVersion();
      const targetVer = getExampleVersion();
      const result = syncEnv();

      const changes = [];
      if (result.added > 0) changes.push(`${result.added} new key(s) added`);
      if (result.deprecated > 0) changes.push(`${result.deprecated} deprecated key(s) commented out`);

      await interaction.editReply(
        `✅ **.env synchronized!**\n\n` +
        `**Schema:** v${currentVer} → v${targetVer}\n` +
        `**Changes:** ${changes.join(', ')}\n\n` +
        `A backup was saved to \`data/backups/\`\n\n` +
        `⚠️ **Restart the bot** to apply new configuration keys.`
      );

      // Refresh panel to update button state
      setTimeout(() => this._update(true), 2000);
    } catch (err) {
      await interaction.editReply(`❌ Failed to sync .env: ${err.message}`);
    }

    return true;
  }

  // ═══════════════════════════════════════════════════════════
  // Welcome message editor
  // ═══════════════════════════════════════════════════════════

  async _handleWelcomeEditButton(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    
    if (!this._isAdmin(interaction)) {
      await interaction.editReply('❌ Only administrators can edit the welcome message.');
      return true;
    }

    if (!this._hasSftp) {
      await interaction.editReply('❌ SFTP credentials not configured.');
      return true;
    }

    // Read current WelcomeMessage.txt from server
    let currentContent = '';
    try {
      const sftp = new SftpClient();
      await sftp.connect({
        host: config.ftpHost,
        port: config.ftpPort,
        username: config.ftpUser,
        password: config.ftpPassword,
      });
      currentContent = (await sftp.get(config.ftpWelcomePath)).toString('utf8');
      await sftp.end().catch(() => {});
    } catch (err) {
      // File may not exist yet — that's fine, start with empty
      currentContent = '';
    }

    // Discord modals can't be shown after deferReply — use a message with a button instead
    const helpText = [
      '**📝 Welcome Message Editor**',
      '',
      'Click **Open Editor** below to edit your `WelcomeMessage.txt`.',
      'This is the popup players see when they join your server.',
      '',
      '**Color Tags** (game rich text):',
      '`<PN>text</>` — Red',
      '`<PR>text</>` — Green',
      '`<SP>text</>` — Ember/Orange',
      '`<FO>text</>` — Gray',
      '`<CL>text</>` — Blue',
      '',
      '**Placeholders** (auto-replaced):',
      '`{server_name}` — Server name from settings',
      '`{day}` — Current in-game day',
      '`{season}` — Current season',
      '`{weather}` — Current weather',
      '`{pvp_schedule}` — PvP schedule times',
      '`{discord_link}` — Your Discord invite link',
      '',
      '**Tip:** Leave the message blank and save to restore the default auto-generated welcome with leaderboards.',
      '',
      `Current length: ${currentContent.length} chars`,
    ].join('\n');

    // Store current content for the modal
    this._pendingWelcome = { userId: interaction.user.id, content: currentContent };

    const openBtn = new ButtonBuilder()
      .setCustomId('panel_welcome_open_modal')
      .setLabel('Open Editor')
      .setStyle(ButtonStyle.Primary);

    await interaction.editReply({
      content: helpText,
      components: [new ActionRowBuilder().addComponents(openBtn)],
    });
    return true;
  }

  async _handleWelcomeOpenModal(interaction) {
    if (!await this._requireAdmin(interaction, 'edit the welcome message')) return true;

    const pending = this._pendingWelcome;
    // Truncate to Discord's 4000-char modal value limit
    const currentValue = (pending?.content || '').slice(0, 4000);

    const modal = new ModalBuilder()
      .setCustomId('panel_welcome_modal')
      .setTitle('Welcome Message (✨ Live)');

    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('welcome_content')
          .setLabel('Message content (blank = auto-generated)')
          .setStyle(TextInputStyle.Paragraph)
          .setValue(currentValue)
          .setRequired(false)
          .setMaxLength(4000)
      ),
    );

    await interaction.showModal(modal);
    return true;
  }

  async _handleWelcomeModal(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    
    if (!this._isAdmin(interaction)) {
      await interaction.editReply('❌ Only administrators can edit the welcome message.');
      return true;
    }

    const newContent = interaction.fields.getTextInputValue('welcome_content');

    try {
      if (newContent.trim()) {
        // Write custom content directly via SFTP
        const sftp = new SftpClient();
        await sftp.connect({
          host: config.ftpHost,
          port: config.ftpPort,
          username: config.ftpUser,
          password: config.ftpPassword,
        });
        await sftp.put(Buffer.from(newContent, 'utf8'), config.ftpWelcomePath);
        await sftp.end().catch(() => {});

        // Also save as WELCOME_FILE_LINES in .env so it persists across restarts
        _writeEnvValues({ WELCOME_FILE_LINES: newContent.split('\n').join('|') });

        await interaction.editReply(
          `✅ **Welcome message updated!** (${newContent.length} chars)\n` +
          `Written to server via SFTP and saved to .env.\n` +
          `Players will see this on their next join.`
        );
      } else {
        // Clear custom — revert to auto-generated
        _writeEnvValues({ WELCOME_FILE_LINES: '' });
        config.welcomeFileLines = [];

        // Regenerate and write default content
        const { buildWelcomeContent } = require('./auto-messages');
        const autoContent = await buildWelcomeContent();

        const sftp = new SftpClient();
        await sftp.connect({
          host: config.ftpHost,
          port: config.ftpPort,
          username: config.ftpUser,
          password: config.ftpPassword,
        });
        await sftp.put(Buffer.from(autoContent, 'utf8'), config.ftpWelcomePath);
        await sftp.end().catch(() => {});

        await interaction.editReply(
          '✅ **Welcome message reset to auto-generated default!**\n' +
          'The welcome popup will now show leaderboards, server info, and stats.\n' +
          'Cleared WELCOME_FILE_LINES in .env.'
        );
      }
    } catch (err) {
      await interaction.editReply(`❌ Failed to save: ${err.message}`);
    }

    return true;
  }

  // ═══════════════════════════════════════════════════════════
  // Broadcast messages editor
  // ═══════════════════════════════════════════════════════════

  async _handleBroadcastsButton(interaction) {
    if (!await this._requireAdmin(interaction, 'edit broadcasts')) return true;

    const linkText = config.autoMsgLinkText || '';
    const promoText = config.autoMsgPromoText || '';

    const helpText = [
      '**📢 Broadcast Message Editor**',
      '',
      'Edit the periodic RCON messages sent to in-game chat.',
      'Leave a field blank to use the built-in default message.',
      '',
      '**Current defaults:**',
      '• **Link:** `Join our Discord! <your link>`',
      '• **Promo:** `Have any issues...? Join our Discord: <your link>`',
      '',
      '**Placeholders** (auto-replaced):',
      '`{server_name}` — Server name',
      '`{day}` — In-game day  •  `{season}` — Season',
      '`{weather}` — Weather  •  `{pvp_schedule}` — PvP times',
      '`{discord_link}` — Your Discord invite link',
      '',
      '**Note:** These are plain-text RCON messages.',
      'Color tags (`<PN>`, `<PR>`, etc.) only work in WelcomeMessage.txt.',
      '',
      `Link: ${linkText ? `\`${linkText.slice(0, 80)}${linkText.length > 80 ? '...' : ''}\`` : '*(default)*'}`,
      `Promo: ${promoText ? `\`${promoText.slice(0, 80)}${promoText.length > 80 ? '...' : ''}\`` : '*(default)*'}`,
    ].join('\n');

    this._pendingBroadcasts = { userId: interaction.user.id, linkText, promoText };

    const openBtn = new ButtonBuilder()
      .setCustomId('panel_broadcasts_open_modal')
      .setLabel('Open Editor')
      .setStyle(ButtonStyle.Primary);

    await interaction.reply({
      content: helpText,
      components: [new ActionRowBuilder().addComponents(openBtn)],
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  async _handleBroadcastsOpenModal(interaction) {
    if (!await this._requireAdmin(interaction, 'edit broadcasts')) return true;

    const pending = this._pendingBroadcasts;
    const linkVal = (pending?.linkText || '').slice(0, 4000);
    const promoVal = (pending?.promoText || '').slice(0, 4000);

    const modal = new ModalBuilder()
      .setCustomId('panel_broadcasts_modal')
      .setTitle('Edit Broadcasts (🔄 Bot Restart)');

    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('link_text')
          .setLabel('Discord Link Broadcast (blank = default)')
          .setStyle(TextInputStyle.Paragraph)
          .setValue(linkVal)
          .setRequired(false)
          .setMaxLength(4000)
          .setPlaceholder('Join our Discord! {discord_link}')
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('promo_text')
          .setLabel('Promo Broadcast (blank = default)')
          .setStyle(TextInputStyle.Paragraph)
          .setValue(promoVal)
          .setRequired(false)
          .setMaxLength(4000)
          .setPlaceholder('Have any issues? Join our Discord: {discord_link}')
      ),
    );

    await interaction.showModal(modal);
    return true;
  }

  async _handleBroadcastsModal(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    
    if (!this._isAdmin(interaction)) {
      await interaction.editReply('❌ Only administrators can edit broadcasts.');
      return true;
    }

    const linkText = interaction.fields.getTextInputValue('link_text').trim();
    const promoText = interaction.fields.getTextInputValue('promo_text').trim();

    try {
      const updates = {};
      if (linkText !== (config.autoMsgLinkText || '')) {
        updates.AUTO_MSG_LINK_TEXT = linkText;
        config.autoMsgLinkText = linkText;
      }
      if (promoText !== (config.autoMsgPromoText || '')) {
        updates.AUTO_MSG_PROMO_TEXT = promoText;
        config.autoMsgPromoText = promoText;
      }

      if (Object.keys(updates).length > 0) {
        _writeEnvValues(updates);
        const parts = [];
        if ('AUTO_MSG_LINK_TEXT' in updates) parts.push(`Link: ${linkText || '*(default)*'}`);
        if ('AUTO_MSG_PROMO_TEXT' in updates) parts.push(`Promo: ${promoText || '*(default)*'}`);
        await interaction.editReply(
          `✅ **Broadcast messages updated!**\n${parts.join('\n')}\n` +
          `Saved to .env. Restart bot to apply changes.`
        );
      } else {
        await interaction.editReply('ℹ️ No changes detected.');
      }
    } catch (err) {
      await interaction.editReply(`❌ Failed to save: ${err.message}`);
    }

    return true;
  }

  // ═══════════════════════════════════════════════════════════
  // Update loop
  // ═══════════════════════════════════════════════════════════

  async _cleanOwnMessages() {
    const ids = this._loadMessageIds();
    const savedIds = [ids.panelBot, ids.panelServer].filter(Boolean);
    if (ids.servers) {
      for (const msgId of Object.values(ids.servers)) {
        if (msgId) savedIds.push(msgId);
      }
    }
    await cleanOwnMessages(this.channel, this.client, { savedIds, label: 'PANEL CH' });
  }

  _loadMessageIds() {
    try {
      if (this._db) {
        return {
          panelBot: this._db.getState('msg_id_panel_bot') || null,
          panelServer: this._db.getState('msg_id_panel_server') || null,
          servers: this._db.getStateJSON('msg_id_panel_servers', {}),
        };
      }
    } catch {}
    return { panelBot: null, panelServer: null, servers: {} };
  }

  _saveMessageIds() {
    try {
      if (this._db && this.panelMessage) {
        this._db.setState('msg_id_panel_bot', this.panelMessage.id);
      }
    } catch {}
  }

  async _update(force = false) {
    try {
      if (!this.panelMessage) return;

      const { embeds, components } = await this._buildUnifiedPanel();
      const contentKey = embedContentKey(embeds, components);

      if (force || contentKey !== this._lastBotKey) {
        this._lastBotKey = contentKey;
        try {
          await this.panelMessage.edit({ embeds, components });
        } catch (editErr) {
          if (editErr.code === 10008 || editErr.message?.includes('Unknown Message')) {
            console.log('[PANEL CH] Panel message deleted, re-creating...');
            this.panelMessage = await this.channel.send({ embeds, components });
            this.botMessage = this.panelMessage;
            this._saveMessageIds();
          } else throw editErr;
        }
      }
    } catch (err) {
      console.error('[PANEL CH] Update error:', err.message);
    }
  }

  /**
   * Build the unified panel: all embeds + components for the active view.
   * Returns { embeds: EmbedBuilder[], components: ActionRowBuilder[] }
   */
  async _buildUnifiedPanel() {
    const embeds = [];
    const view = this._activeView || 'bot';

    // ── Embed 1: Bot overview (always) ──
    embeds.push(this._buildBotEmbed());

    // ── Embed 2: Primary server ──
    let resources = null, details = null, backups = null, schedules = null;
    if (panelApi.available) {
      try {
        [resources, details, backups, schedules] = await Promise.all([
          panelApi.getResources().catch(() => null),
          panelApi.getServerDetails().catch(() => ({})),
          panelApi.listBackups().catch(() => []),
          panelApi.listSchedules().catch(() => []),
        ]);
        const state = resources?.state || 'offline';
        this._lastState = state;
        this._backupLimit = details?.feature_limits?.backups ?? null;
        embeds.push(this._buildServerEmbed(resources, details, backups, schedules));
      } catch {
        // Panel API failed — skip server embed
      }
    } else if (this._hasSftp) {
      // No panel API but SFTP available — show minimal server info
      const serverEmbed = new EmbedBuilder()
        .setTitle('🖥️ Primary Server')
        .setColor(0x3498db)
        .setDescription('SFTP connected — use controls below for server tools')
        .setTimestamp();
      embeds.push(serverEmbed);
    }

    // ── Embeds 3+: Managed servers ──
    const managedServers = this.multiServerManager?.getAllServers() || [];
    for (const serverDef of managedServers) {
      const instance = this.multiServerManager.getInstance(serverDef.id);
      embeds.push(this._buildManagedServerEmbed(serverDef, instance));
    }

    // ── Build components based on active view ──
    const components = this._buildViewComponents(view, managedServers);

    return { embeds, components };
  }

  /**
   * Build action rows for the currently selected view.
   * Row 1 is always the view selector. Rows 2-5 depend on the view.
   */
  _buildViewComponents(view, managedServers = []) {
    const rows = [];

    // ── Row 1: View selector ──
    const viewOptions = [
      { label: 'Bot Controls', value: 'bot', emoji: '🤖', default: view === 'bot' },
    ];
    if (panelApi.available || this._hasSftp) {
      viewOptions.push({ label: 'Primary Server', value: 'server', emoji: '🖥️', default: view === 'server' });
    }
    for (const s of managedServers) {
      viewOptions.push({
        label: s.name || s.id,
        value: `srv_${s.id}`,
        emoji: '🌐',
        default: view === s.id,
      });
    }
    // Only show view selector if there's more than one option
    if (viewOptions.length > 1) {
      const viewSelect = new StringSelectMenuBuilder()
        .setCustomId(SELECT.VIEW)
        .setPlaceholder('Select panel view...')
        .addOptions(viewOptions);
      rows.push(new ActionRowBuilder().addComponents(viewSelect));
    }

    // ── Rows 2-5: View-specific controls ──
    const maxRemaining = 5 - rows.length;
    let viewRows = [];

    if (view === 'bot') {
      viewRows = this._buildBotComponents();
    } else if (view === 'server') {
      if (panelApi.available) {
        viewRows = this._buildServerComponents(this._lastState || 'offline');
      } else if (this._hasSftp) {
        viewRows = this._buildSftpOnlyServerComponents();
      }
    } else {
      // Managed server view
      const serverDef = managedServers.find(s => s.id === view);
      if (serverDef) {
        const instance = this.multiServerManager?.getInstance(serverDef.id);
        viewRows = this._buildManagedServerComponents(serverDef.id, instance?.running || false);
      }
    }

    // Trim to fit within Discord's 5 row limit
    for (let i = 0; i < Math.min(viewRows.length, maxRemaining); i++) {
      rows.push(viewRows[i]);
    }

    return rows;
  }

  /**
   * Build components for SFTP-only server view (no panel API).
   */
  _buildSftpOnlyServerComponents() {
    const rows = [];
    const toolsRow = new ActionRowBuilder();
    if (config.enableWelcomeFile) {
      toolsRow.addComponents(
        new ButtonBuilder()
          .setCustomId(BTN.WELCOME_EDIT)
          .setLabel('Welcome Message')
          .setStyle(ButtonStyle.Secondary)
      );
    }
    if (config.enableAutoMessages) {
      toolsRow.addComponents(
        new ButtonBuilder()
          .setCustomId(BTN.BROADCASTS)
          .setLabel('Broadcasts')
          .setStyle(ButtonStyle.Secondary)
      );
    }
    if (toolsRow.components.length > 0) rows.push(toolsRow);
    if (config.enableGameSettingsEditor) {
      const settingsSelect = new StringSelectMenuBuilder()
        .setCustomId(SELECT.SETTINGS)
        .setPlaceholder('Edit game server settings...')
        .addOptions(
          GAME_SETTINGS_CATEGORIES.map(c => ({
            label: c.label,
            value: c.id,
            emoji: c.emoji,
          }))
        );
      rows.push(new ActionRowBuilder().addComponents(settingsSelect));
    }
    return rows;
  }

  // ═══════════════════════════════════════════════════════════
  // Embed builders
  // ═══════════════════════════════════════════════════════════

  /**
   * Build embed for a managed (additional) server.
   * @param {object} serverDef - Server definition from servers.json
   * @param {object|undefined} instance - Running ServerInstance (or undefined)
   */
  _buildManagedServerEmbed(serverDef, instance) {
    const running = instance?.running || false;
    const statusIcon = running ? '🟢' : '🔴';
    const statusText = running ? 'Running' : 'Stopped';

    const embed = new EmbedBuilder()
      .setTitle(`🌐 ${serverDef.name || serverDef.id}`)
      .setColor(running ? 0x57f287 : 0xed4245)
      .setTimestamp()
      .setFooter({ text: `Server ID: ${serverDef.id}` });

    // Connection info
    const infoLines = [
      `${statusIcon} **${statusText}**`,
      '',
      `📡 **RCON:** \`${serverDef.rcon?.host || '?'}:${serverDef.rcon?.port || 14541}\``,
      `🎮 **Game Port:** \`${serverDef.gamePort || 14242}\``,
    ];

    // SFTP info
    if (serverDef.sftp?.host) {
      infoLines.push(`📂 **SFTP:** \`${serverDef.sftp.host}:${serverDef.sftp.port || 22}\``);
    } else {
      infoLines.push('📂 **SFTP:** Inherited from primary');
    }

    embed.setDescription(infoLines.join('\n'));

    // Channels field
    const ch = serverDef.channels || {};
    const channelLines = [];
    if (ch.serverStatus) channelLines.push(`Status: <#${ch.serverStatus}>`);
    if (ch.playerStats) channelLines.push(`Stats: <#${ch.playerStats}>`);
    if (ch.log) channelLines.push(`Log: <#${ch.log}>`);
    if (ch.chat) channelLines.push(`Chat: <#${ch.chat}>`);
    if (ch.admin) channelLines.push(`Admin: <#${ch.admin}>`);
    embed.addFields({
      name: '📺 Channels',
      value: channelLines.length > 0 ? channelLines.join('\n') : 'None configured',
      inline: true,
    });

    // Modules field
    if (instance) {
      const status = instance.getStatus();
      const modLines = status.modules?.length > 0 ? status.modules.join('\n') : 'None';
      embed.addFields({ name: '📦 Modules', value: modLines, inline: true });
    } else {
      embed.addFields({ name: '📦 Modules', value: 'Not running', inline: true });
    }

    // Auto Messages / Welcome settings
    const am = serverDef.autoMessages || {};
    const cfg = instance?.config || {};
    const amLines = [];
    const welcomeMsg  = am.enableWelcomeMsg  ?? cfg.enableWelcomeMsg  ?? true;
    const welcomeFile = am.enableWelcomeFile ?? cfg.enableWelcomeFile ?? true;
    const linkBcast   = am.enableAutoMsgLink ?? cfg.enableAutoMsgLink ?? true;
    const promoBcast  = am.enableAutoMsgPromo ?? cfg.enableAutoMsgPromo ?? true;
    amLines.push(`RCON Welcome: ${welcomeMsg ? '✅' : '❌'}`);
    amLines.push(`Welcome File: ${welcomeFile ? '✅' : '❌'}`);
    amLines.push(`Link Broadcast: ${linkBcast ? '✅' : '❌'}`);
    amLines.push(`Promo Broadcast: ${promoBcast ? '✅' : '❌'}`);
    if (am.linkText) amLines.push(`Link: \`${am.linkText.slice(0, 40)}${am.linkText.length > 40 ? '...' : ''}\``);
    if (am.promoText) amLines.push(`Promo: \`${am.promoText.slice(0, 40)}${am.promoText.length > 40 ? '...' : ''}\``);
    if (am.discordLink) amLines.push(`Discord: \`${am.discordLink.slice(0, 40)}\``);
    embed.addFields({ name: '📢 Auto Messages', value: amLines.join('\n'), inline: false });

    return embed;
  }

  /**
   * Build action-row buttons for a managed server embed.
   * @param {string} serverId
   * @param {boolean} running
   */
  _buildManagedServerComponents(serverId, running) {
    const row1 = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`panel_srv_start:${serverId}`)
        .setLabel('Start')
        .setStyle(ButtonStyle.Success)
        .setDisabled(running),
      new ButtonBuilder()
        .setCustomId(`panel_srv_stop:${serverId}`)
        .setLabel('Stop')
        .setStyle(ButtonStyle.Danger)
        .setDisabled(!running),
      new ButtonBuilder()
        .setCustomId(`panel_srv_restart:${serverId}`)
        .setLabel('Restart')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(!running),
      new ButtonBuilder()
        .setCustomId(`panel_srv_edit:${serverId}`)
        .setLabel('Edit Connection')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`panel_srv_remove:${serverId}`)
        .setLabel('Remove')
        .setStyle(ButtonStyle.Danger),
    );

    const row2 = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`panel_srv_channels:${serverId}`)
        .setLabel('Edit Channels')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`panel_srv_sftp:${serverId}`)
        .setLabel('Edit SFTP')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`panel_srv_welcome:${serverId}`)
        .setLabel('Welcome Message')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`panel_srv_automsg:${serverId}`)
        .setLabel('Auto Messages')
        .setStyle(ButtonStyle.Secondary),
    );

    // Game settings dropdown (row 3) — uses server's SFTP
    const serverDef = this.multiServerManager?.getAllServers().find(s => s.id === serverId);
    const hasSftp = !!(serverDef?.sftp?.host || config.ftpHost);
    const rows = [row1, row2];
    if (hasSftp) {
      const settingsSelect = new StringSelectMenuBuilder()
        .setCustomId(`panel_srv_settings:${serverId}`)
        .setPlaceholder('Edit game server settings...')
        .addOptions(
          GAME_SETTINGS_CATEGORIES.map(c => ({
            label: c.label,
            value: c.id,
            emoji: c.emoji,
          }))
        );
      rows.push(new ActionRowBuilder().addComponents(settingsSelect));
    }

    return rows;
  }

  _buildBotEmbed() {
    const upMs = Date.now() - this.startedAt.getTime();

    const embed = new EmbedBuilder()
      .setTitle('🤖 Bot Controls')
      .setColor(0x5865f2)
      .setTimestamp()
      .setFooter({ text: 'Select a category below to edit bot config' });

    // ── Bot info ──
    const username = this.client.user?.tag || 'Bot';
    const infoLines = [
      `**${username}**`,
      `🟢 Online · ⏱️ ${_formatBotUptime(upMs)}`,
      `🌐 \`${config.botTimezone}\``,
    ];

    // Show capability indicators for non-obvious setups
    const caps = [];
    if (panelApi.available) caps.push('Panel API');
    if (this._hasSftp) caps.push('SFTP');
    if (caps.length > 0 && caps.length < 2) {
      infoLines.push(`📡 ${caps.join(' · ')}`);
    }

    embed.setDescription(infoLines.join('\n'));

    // ── Module status ──
    const statusLines = [];
    let skippedCount = 0;
    for (const [name, status] of Object.entries(this.moduleStatus)) {
      const icon = status.startsWith('🟢') ? '🟢' : status.startsWith('⚫') ? '⚫' : '🟡';
      statusLines.push(`${icon} ${name}`);
      if (icon === '🟡') skippedCount++;
    }
    if (statusLines.length > 0) {
      let value = statusLines.join('\n');
      if (skippedCount > 0) {
        value += `\n-# ⚠️ ${skippedCount} module(s) need attention — tap **Diagnostics** below`;
      }
      embed.addFields({ name: '📦 Modules', value });
    }

    // Button descriptions (Discord buttons don't support hover tooltips)
    embed.addFields({
      name: '\u200b',
      value: [
        '-# 🔄 **Restart Bot** — Restart the bot process (brief downtime)',
        '-# 🗑️ **Factory Reset** — Wipe all data and re-build from scratch',
        '-# 📥 **Re-Import** — Re-download server files and rebuild stats',
        '-# 🔍 **System Diagnostics** — Live connectivity probes, module health, suggestions',
      ].join('\n'),
    });

    return embed;
  }

  _buildBotComponents() {
    // ── Select 1: Core & module settings ──
    const coreCategories = ENV_CATEGORIES.filter(c => c.group === 1);
    const coreSelect = new StringSelectMenuBuilder()
      .setCustomId(SELECT.ENV)
      .setPlaceholder('Core & module settings...')
      .addOptions(
        coreCategories.map(c => ({
          label: c.label,
          description: c.description,
          value: c.id,
          emoji: c.emoji,
        }))
      );

    // ── Select 2: Display & schedule settings ──
    const displayCategories = ENV_CATEGORIES.filter(c => c.group === 2);
    const displaySelect = new StringSelectMenuBuilder()
      .setCustomId(SELECT.ENV2)
      .setPlaceholder('Display & schedule settings...')
      .addOptions(
        displayCategories.map(c => ({
          label: c.label,
          description: c.description,
          value: c.id,
          emoji: c.emoji,
        }))
      );

    // ── Button row: Restart, Nuke, Re-Import, [Add Server] ──
    const restartBtn = new ButtonBuilder()
      .setCustomId(BTN.BOT_RESTART)
      .setLabel('Restart Bot')
      .setStyle(ButtonStyle.Primary);

    const nukeBtn = new ButtonBuilder()
      .setCustomId(BTN.NUKE)
      .setLabel('Factory Reset')
      .setStyle(ButtonStyle.Danger);

    const reimportBtn = new ButtonBuilder()
      .setCustomId(BTN.REIMPORT)
      .setLabel('Re-Import Data')
      .setStyle(ButtonStyle.Secondary);

    const diagBtn = new ButtonBuilder()
      .setCustomId(BTN.DIAGNOSTICS)
      .setLabel('System Diagnostics')
      .setStyle(ButtonStyle.Secondary);

    const { needsSync } = require('../env-sync');
    const envSyncBtn = new ButtonBuilder()
      .setCustomId(BTN.ENV_SYNC)
      .setLabel(needsSync() ? '🔄 Sync .env' : '✓ .env Synced')
      .setStyle(needsSync() ? ButtonStyle.Primary : ButtonStyle.Secondary)
      .setDisabled(!needsSync());

    const buttonRow = new ActionRowBuilder().addComponents(restartBtn, nukeBtn, reimportBtn, diagBtn, envSyncBtn);

    const rows = [
      new ActionRowBuilder().addComponents(coreSelect),
      new ActionRowBuilder().addComponents(displaySelect),
      buttonRow,
    ];

    // Add server management button row if multi-server manager is available (separate row to avoid 5-button limit)
    if (this.multiServerManager) {
      const addServerBtn = new ButtonBuilder()
        .setCustomId(BTN.ADD_SERVER)
        .setLabel('Add Server')
        .setStyle(ButtonStyle.Success);
      const serverMgmtRow = new ActionRowBuilder().addComponents(addServerBtn);
      rows.push(serverMgmtRow);
    }

    return rows;
  }

  _buildServerComponents(state) {
    const isRunning = state === 'running';
    const isOff = state === 'offline';
    const isTransitioning = state === 'starting' || state === 'stopping';

    const powerRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(BTN.START)
        .setLabel('Start')
        .setStyle(ButtonStyle.Success)
        .setDisabled(isRunning || isTransitioning),
      new ButtonBuilder()
        .setCustomId(BTN.STOP)
        .setLabel('Stop')
        .setStyle(ButtonStyle.Danger)
        .setDisabled(isOff || isTransitioning),
      new ButtonBuilder()
        .setCustomId(BTN.RESTART)
        .setLabel('Restart')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(isOff || isTransitioning),
      new ButtonBuilder()
        .setCustomId(BTN.BACKUP)
        .setLabel('Backup')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(this._backupLimit === 0),
      new ButtonBuilder()
        .setCustomId(BTN.KILL)
        .setLabel('Kill')
        .setStyle(ButtonStyle.Danger)
        .setDisabled(isOff),
    );

    // Server-specific tools row (welcome, broadcasts)
    const toolsRow = new ActionRowBuilder();
    if (this._hasSftp && config.enableWelcomeFile) {
      toolsRow.addComponents(
        new ButtonBuilder()
          .setCustomId(BTN.WELCOME_EDIT)
          .setLabel('Welcome Message')
          .setStyle(ButtonStyle.Secondary)
      );
    }
    if (config.enableAutoMessages) {
      toolsRow.addComponents(
        new ButtonBuilder()
          .setCustomId(BTN.BROADCASTS)
          .setLabel('Broadcasts')
          .setStyle(ButtonStyle.Secondary)
      );
    }

    const rows = [powerRow];
    if (toolsRow.components.length > 0) rows.push(toolsRow);

    // Game settings dropdown if SFTP is configured and editor is enabled
    if (this._hasSftp && config.enableGameSettingsEditor) {
      const settingsSelect = new StringSelectMenuBuilder()
        .setCustomId(SELECT.SETTINGS)
        .setPlaceholder('Edit game server settings...')
        .addOptions(
          GAME_SETTINGS_CATEGORIES.map(c => ({
            label: c.label,
            value: c.id,
            emoji: c.emoji,
          }))
        );
      rows.push(new ActionRowBuilder().addComponents(settingsSelect));
    }

    return rows;
  }

  _buildServerEmbed(resources, details, backups, schedules) {
    const state = resources?.state || 'offline';
    const si = _stateInfo(state);

    const embed = new EmbedBuilder()
      .setTitle('🖥️ Server Panel')
      .setColor(si.color)
      .setTimestamp()
      .setFooter({ text: 'Panel API · Auto-updating · Buttons require Administrator' });

    // ── State + name + description ──
    const name = details?.name || 'Game Server';
    const desc = details?.description || '';
    let headerLines = `**${name}**\n${si.emoji} **${si.label}**`;
    if (desc) headerLines += `\n*${desc}*`;
    embed.setDescription(headerLines);

    // ── Resource gauges ──
    if (resources && state === 'running') {
      const lines = [];

      if (resources.cpu != null) {
        const cpuLimit = details?.limits?.cpu || 100;
        const cpuRatio = Math.min(resources.cpu / cpuLimit, 1);
        lines.push(`🖥️ **CPU** ${_progressBar(cpuRatio)} **${resources.cpu}%** / ${cpuLimit}%`);
      }

      if (resources.memUsed != null && resources.memTotal != null) {
        const memRatio = resources.memTotal > 0 ? resources.memUsed / resources.memTotal : 0;
        lines.push(`🧠 **RAM** ${_progressBar(memRatio)} **${formatBytes(resources.memUsed)}** / ${formatBytes(resources.memTotal)}`);
      }

      if (resources.diskUsed != null && resources.diskTotal != null) {
        const diskRatio = resources.diskTotal > 0 ? resources.diskUsed / resources.diskTotal : 0;
        lines.push(`💾 **Disk** ${_progressBar(diskRatio)} **${formatBytes(resources.diskUsed)}** / ${formatBytes(resources.diskTotal)}`);
      }

      if (resources.uptime != null) {
        const up = formatUptime(resources.uptime);
        if (up) lines.push(`⏱️ **Uptime:** ${up}`);
      }

      if (lines.length > 0) {
        embed.addFields({ name: '📊 Live Resources', value: lines.join('\n') });
      }
    } else if (state !== 'running') {
      embed.addFields({ name: '📊 Resources', value: '*Server is not running*' });
    }

    // ── Allocations ──
    const allocs = details?.relationships?.allocations?.data || [];
    if (allocs.length > 0) {
      const allocLines = allocs.map(a => {
        const attr = a.attributes || a;
        const primary = attr.is_default ? ' ⭐' : '';
        const alias = attr.alias ? ` (${attr.alias})` : '';
        const notes = attr.notes ? ` — ${attr.notes}` : '';
        return `\`${attr.ip}:${attr.port}\`${alias}${primary}${notes}`;
      });
      embed.addFields({ name: '🌐 Allocations', value: allocLines.join('\n'), inline: true });
    }

    // ── Node ──
    if (details?.node) {
      embed.addFields({ name: '📍 Node', value: details.node, inline: true });
    }

    // ── Plan limits ──
    const limits = details?.limits || {};
    const fl = details?.feature_limits || {};
    const planParts = [];
    if (limits.memory) planParts.push(`RAM: ${limits.memory} MB`);
    if (limits.disk != null) planParts.push(`Disk: ${limits.disk === 0 ? '∞' : `${limits.disk} MB`}`);
    if (limits.cpu) planParts.push(`CPU: ${limits.cpu}%`);
    if (fl.backups != null) planParts.push(`Backups: ${fl.backups}`);
    if (fl.databases != null) planParts.push(`DBs: ${fl.databases}`);
    if (fl.allocations != null) planParts.push(`Ports: ${fl.allocations}`);
    if (planParts.length > 0) {
      embed.addFields({ name: '📋 Plan', value: planParts.join('  ·  '), inline: true });
    }

    // ── Backups ──
    if (backups && backups.length > 0) {
      const sorted = [...backups]
        .filter(b => b.completed_at)
        .sort((a, b) => new Date(b.completed_at) - new Date(a.completed_at));
      const successCount = backups.filter(b => b.is_successful).length;
      const totalSize = backups.reduce((sum, b) => sum + (b.bytes || 0), 0);
      const maxBackups = fl.backups || '?';

      const backupLines = sorted.slice(0, 5).map((b, i) => {
        const icon = b.is_successful ? '✅' : '❌';
        const locked = b.is_locked ? ' 🔒' : '';
        const date = new Date(b.completed_at).toLocaleDateString('en-GB', {
          day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
          timeZone: config.botTimezone,
        });
        return `${icon} **${b.name || `Backup ${i + 1}`}**${locked}\n　${formatBytes(b.bytes || 0)} · ${date}`;
      });

      const header = `${successCount}/${maxBackups} slots · ${formatBytes(totalSize)} total`;
      embed.addFields({ name: `💾 Backups (${header})`, value: backupLines.join('\n') || 'None' });
    } else {
      embed.addFields({ name: '💾 Backups', value: 'No backups yet. Click **Backup** below to create one.' });
    }

    // ── Schedules ──
    if (schedules && schedules.length > 0) {
      const activeCount = schedules.filter(s => s.is_active).length;
      const scheduleLines = schedules.slice(0, 8).map(s => {
        const active = s.is_active ? '🟢' : '⚫';
        const onlyOnline = s.only_when_online ? ' 🌐' : '';
        let next = '--';
        if (s.next_run_at) {
          const nextDate = new Date(s.next_run_at);
          const now = new Date();
          const diffMs = nextDate - now;
          if (diffMs > 0 && diffMs < 86400000) {
            const diffMins = Math.floor(diffMs / 60000);
            const diffHrs = Math.floor(diffMins / 60);
            const remMins = diffMins % 60;
            next = diffHrs > 0 ? `in ${diffHrs}h ${remMins}m` : `in ${diffMins}m`;
          } else {
            next = nextDate.toLocaleDateString('en-GB', {
              day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
              timeZone: config.botTimezone,
            });
          }
        }
        return `${active} **${s.name}**${onlyOnline} — ${next}`;
      });
      embed.addFields({
        name: `📅 Schedules (${activeCount}/${schedules.length} active)`,
        value: scheduleLines.join('\n'),
      });
    }

    // ── Quick reference ──
    embed.addFields({
      name: '⚡ Commands',
      value: '`/qspanel console <cmd>` — Run a console command\n`/qspanel schedules` — View all schedules\n`/qspanel backup-delete` — Remove a backup',
    });

    return embed;
  }
}

// Export custom IDs for the interaction handler
PanelChannel.BTN = BTN;
PanelChannel.SELECT = SELECT;
PanelChannel.ENV_CATEGORIES = ENV_CATEGORIES;
PanelChannel.GAME_SETTINGS_CATEGORIES = GAME_SETTINGS_CATEGORIES;

module.exports = PanelChannel;

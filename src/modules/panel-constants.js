/**
 * Panel channel constants — custom IDs, env categories, and game settings.
 *
 * Extracted from panel-channel.js to keep the main class focused on logic.
 * Pure data definitions, zero runtime dependencies.
 */

'use strict';

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
};

// ── Env categories ──────────────────────────────────────────
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
    description: 'Restrict sections to Discord admins (applies live)',
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

module.exports = { BTN, SELECT, SETUP, ENV_CATEGORIES, GAME_SETTINGS_CATEGORIES };

/**
 * Panel Channel — two-embed admin dashboard.
 *
 * Message 1 (top): Bot Controls — always shown when PANEL_CHANNEL_ID is set.
 *   - Bot status, uptime, module status
 *   - Env config editor (select category → modal → write .env + live apply)
 *   - Restart Bot button
 *   - Game settings editor (if SFTP available but no panel API)
 *
 * Message 2 (bottom): Game Server Panel — only when panel API is configured.
 *   - Power state, resources, backups, schedules
 *   - Power buttons (Start / Stop / Restart / Backup / Kill)
 *   - Game settings editor (if SFTP available)
 *
 * Admin-only channel. Requires PANEL_CHANNEL_ID.
 * Panel API features require PANEL_SERVER_URL + PANEL_API_KEY.
 * Game settings editor requires SFTP credentials (FTP_HOST/USER/PASSWORD).
 */

const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
  PermissionFlagsBits,
} = require('discord.js');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const panelApi = require('./panel-api');
const SftpClient = require('ssh2-sftp-client');
const { formatBytes, formatUptime } = require('./server-resources');
const MultiServerManager = require('./multi-server');
const { loadServers, saveServers, createServerConfig } = require('./multi-server');

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

/** Visual progress bar: ████████░░░░ */
function _progressBar(ratio, width = 12) {
  const clamped = Math.max(0, Math.min(1, ratio));
  const filled = Math.round(clamped * width);
  const empty = width - filled;
  return '█'.repeat(filled) + '░'.repeat(empty);
}

// ── Custom IDs ──────────────────────────────────────────────
const BTN = {
  START:        'panel_start',
  STOP:         'panel_stop',
  RESTART:      'panel_restart',
  BACKUP:       'panel_backup',
  KILL:         'panel_kill',
  BOT_RESTART:  'panel_bot_restart',
  ADD_SERVER:   'panel_add_server',
  WELCOME_EDIT: 'panel_welcome_edit',
  BROADCASTS:   'panel_broadcasts',
};

const SELECT = {
  ENV:      'panel_env_select',
  SETTINGS: 'panel_settings_select',
  SERVER:   'panel_server_select',
};

// ── Env categories (max 5 fields per category — Discord modal limit) ─
// `cfg` = config.js key for live apply. `type` = value parser.
// `restart` = true when bot restart is required for the change to take effect.

const ENV_CATEGORIES = [
  {
    id: 'channels', label: 'Channel IDs', emoji: '📺',
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
    id: 'features1', label: 'Module Toggles', emoji: '⚡',
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
    id: 'features2', label: 'Module Toggles 2', emoji: '⚡',
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
    id: 'display_player', label: 'Display: Player', emoji: '👤',
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
    id: 'display_server', label: 'Display: Server', emoji: '🖥️',
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
    id: 'display_extra', label: 'Display: Extra', emoji: '📊',
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
    id: 'intervals', label: 'Poll Intervals', emoji: '⏱️',
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
    id: 'timezone', label: 'Timezone', emoji: '🌐',
    description: 'Time settings (restart required)',
    restart: true,
    fields: [
      { env: 'BOT_TIMEZONE', label: 'Bot Timezone (IANA)', cfg: 'botTimezone' },
      { env: 'LOG_TIMEZONE', label: 'Log Timezone (IANA)', cfg: 'logTimezone' },
    ],
  },
  {
    id: 'pvp', label: 'PvP Schedule', emoji: '⚔️',
    description: 'PvP scheduler settings (restart required)',
    restart: true,
    fields: [
      { env: 'PVP_START_TIME', label: 'Default Start (HH:MM)' },
      { env: 'PVP_END_TIME', label: 'Default End (HH:MM)' },
      { env: 'PVP_RESTART_DELAY', label: 'Restart Delay (min)', cfg: 'pvpRestartDelay', type: 'int' },
      { env: 'PVP_UPDATE_SERVER_NAME', label: 'Update Name (true/false)', cfg: 'pvpUpdateServerName', type: 'bool' },
      { env: 'PVP_DAYS', label: 'Days (e.g. Mon,Wed,Fri)' },
      { env: 'PVP_HOURS_MON', label: 'Mon hours (HH:MM-HH:MM)' },
      { env: 'PVP_HOURS_TUE', label: 'Tue hours (HH:MM-HH:MM)' },
      { env: 'PVP_HOURS_WED', label: 'Wed hours (HH:MM-HH:MM)' },
      { env: 'PVP_HOURS_THU', label: 'Thu hours (HH:MM-HH:MM)' },
      { env: 'PVP_HOURS_FRI', label: 'Fri hours (HH:MM-HH:MM)' },
      { env: 'PVP_HOURS_SAT', label: 'Sat hours (HH:MM-HH:MM)' },
      { env: 'PVP_HOURS_SUN', label: 'Sun hours (HH:MM-HH:MM)' },
    ],
  },
  {
    id: 'automsg', label: 'Auto Messages', emoji: '📢',
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
    id: 'log_features', label: 'Log Features', emoji: '📋',
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
    id: 'display_more', label: 'Display: Status', emoji: '📺',
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
    id: 'threads_misc', label: 'Threads & Misc', emoji: '🧵',
    description: 'Thread mode, game port, leaderboards (restart required)',
    restart: true,
    fields: [
      { env: 'USE_CHAT_THREADS', label: 'Chat in Threads (true/false)', cfg: 'useChatThreads', type: 'bool' },
      { env: 'USE_ACTIVITY_THREADS', label: 'Activity Threads (true/false)', cfg: 'useActivityThreads', type: 'bool' },
      { env: 'GAME_PORT', label: 'Game Port (direct connect)', cfg: 'gamePort' },
      { env: 'SHOW_MOST_FISH', label: 'Most Fish Board (true/false)', cfg: 'showMostFish', type: 'bool' },
      { env: 'WEEKLY_RESET_DAY', label: 'Weekly Reset (0=Sun,1=Mon..6=Sat)', cfg: 'weeklyResetDay', type: 'int' },
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
];

// ── .env file helpers ───────────────────────────────────────
const ENV_PATH = path.join(__dirname, '..', '.env');
const SETTINGS_CACHE = path.join(__dirname, '..', 'data', 'server-settings.json');

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

/** Read cached game server settings from data/server-settings.json. */
function _getCachedSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_CACHE, 'utf8')); } catch { return {}; }
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
  static _DATA_DIR = path.join(__dirname, '..', 'data');
  /**
   * @param {import('discord.js').Client} client
   * @param {object} opts
   * @param {object} opts.moduleStatus - reference to the moduleStatus object from index.js
   * @param {Date}   opts.startedAt    - bot startup timestamp
   */
  constructor(client, { moduleStatus = {}, startedAt = new Date(), multiServerManager = null } = {}) {
    this.client = client;
    this.channel = null;
    this.botMessage = null;    // first message — bot controls (top)
    this.panelMessage = null;  // second message — game server panel (bottom)
    this._serverMessages = new Map(); // serverId → Discord message (per-server embeds)
    this._lastServerKeys = new Map(); // serverId → content hash
    this.interval = null;
    this.updateIntervalMs = parseInt(config.serverStatusInterval, 10) || 30000;
    this._lastBotKey = null;
    this._lastPanelKey = null;
    this._lastState = null;
    this._backupLimit = null;
    this.moduleStatus = moduleStatus;
    this.startedAt = startedAt;
    this.multiServerManager = multiServerManager;
    this._pendingServers = new Map(); // userId → { ...partial server config, _createdAt }
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
    return !!(config.ftpHost && config.ftpUser && config.ftpPassword);
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

      const features = [];
      features.push('bot controls');
      features.push('env editor');
      if (this._hasSftp) features.push('game settings (SFTP)');
      if (panelApi.available) features.push('server panel (API)');
      console.log(`[PANEL CH] Posting in #${this.channel.name} — ${features.join(', ')} (every ${this.updateIntervalMs / 1000}s)`);
      await this._cleanOwnMessages();

      // ── Message 1: Bot Controls (always) ──
      const botEmbed = new EmbedBuilder()
        .setTitle('🤖 Bot Controls')
        .setDescription('Loading...')
        .setColor(0x5865f2)
        .setTimestamp();
      this.botMessage = await this.channel.send({
        embeds: [botEmbed],
        components: this._buildBotComponents(),
      });

      // ── Message 2: Game Server Panel (only when panel API is available) ──
      if (panelApi.available) {
        const serverEmbed = new EmbedBuilder()
          .setTitle('🖥️ Server Panel')
          .setDescription('Loading panel data...')
          .setColor(0x95a5a6)
          .setTimestamp();
        this.panelMessage = await this.channel.send({
          embeds: [serverEmbed],
          components: this._buildServerComponents('offline'),
        });
      }

      // ── Message 2b: Primary Server tools (when no panel API but SFTP is available) ──
      if (!panelApi.available && this._hasSftp) {
        const primaryEmbed = new EmbedBuilder()
          .setTitle('🖥️ Primary Server')
          .setDescription('Server-specific tools (Welcome, Broadcasts, Game Settings)')
          .setColor(0x3498db)
          .setTimestamp();
        const primaryRows = [];
        const toolsRow = new ActionRowBuilder();
        if (config.enableWelcomeFile) {
          toolsRow.addComponents(
            new ButtonBuilder()
              .setCustomId(BTN.WELCOME_EDIT)
              .setLabel('Welcome Message')
              .setStyle(ButtonStyle.Secondary)
              .setEmoji('📝')
          );
        }
        if (config.enableAutoMessages) {
          toolsRow.addComponents(
            new ButtonBuilder()
              .setCustomId(BTN.BROADCASTS)
              .setLabel('Broadcasts')
              .setStyle(ButtonStyle.Secondary)
              .setEmoji('📢')
          );
        }
        if (toolsRow.components.length > 0) primaryRows.push(toolsRow);
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
        primaryRows.push(new ActionRowBuilder().addComponents(settingsSelect));
        this.panelMessage = await this.channel.send({
          embeds: [primaryEmbed],
          components: primaryRows,
        });
      }

      // ── Messages 3+: Per-server management embeds ──
      if (this.multiServerManager) {
        const servers = this.multiServerManager.getAllServers();
        for (const serverDef of servers) {
          try {
            const instance = this.multiServerManager.getInstance(serverDef.id);
            const embed = this._buildManagedServerEmbed(serverDef, instance);
            const components = this._buildManagedServerComponents(serverDef.id, instance?.running || false);
            const msg = await this.channel.send({ embeds: [embed], components });
            this._serverMessages.set(serverDef.id, msg);
          } catch (err) {
            console.error(`[PANEL CH] Failed to post embed for ${serverDef.name}:`, err.message);
          }
        }
      }

      // Persist all message IDs for next restart
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
  // Interaction router
  // ═══════════════════════════════════════════════════════════

  async handleInteraction(interaction) {
    // ── Buttons ──
    if (interaction.isButton()) {
      const id = interaction.customId;
      if ([BTN.START, BTN.STOP, BTN.RESTART, BTN.BACKUP, BTN.KILL].includes(id)) {
        return this._handlePowerButton(interaction, id);
      }
      if (id === BTN.BOT_RESTART) {
        return this._handleBotRestart(interaction);
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
      if (interaction.customId === SELECT.ENV) {
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
    if (!interaction.member?.permissions?.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({ content: '❌ Only administrators can use panel controls.', ephemeral: true });
      return true;
    }

    if (!panelApi.available) {
      await interaction.reply({ content: '❌ Panel API is not configured. Power controls require PANEL_SERVER_URL and PANEL_API_KEY.', ephemeral: true });
      return true;
    }

    await interaction.deferReply({ ephemeral: true });

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
    if (!interaction.member?.permissions?.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({ content: '❌ Only administrators can restart the bot.', ephemeral: true });
      return true;
    }

    await interaction.reply({
      content: '🔄 Restarting bot... The process will exit and your process manager should restart it.',
      ephemeral: true,
    });

    // Let Discord deliver the reply before exiting
    setTimeout(() => process.exit(0), 1500);
    return true;
  }

  // ═══════════════════════════════════════════════════════════
  // Select menu → modal handlers
  // ═══════════════════════════════════════════════════════════

  async _handleEnvSelect(interaction) {
    if (!interaction.member?.permissions?.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({ content: '❌ Only administrators can edit bot config.', ephemeral: true });
      return true;
    }

    const categoryId = interaction.values[0];
    const category = ENV_CATEGORIES.find(c => c.id === categoryId);
    if (!category) {
      await interaction.reply({ content: '❌ Unknown category.', ephemeral: true });
      return true;
    }

    const restartTag = category.restart ? ' (🔄 Bot Restart)' : ' (✨ Live)';
    const modal = new ModalBuilder()
      .setCustomId(`panel_env_modal:${categoryId}`)
      .setTitle(`Edit: ${category.label}${restartTag}`);

    for (const field of category.fields) {
      const input = new TextInputBuilder()
        .setCustomId(field.env)
        .setLabel(field.label)
        .setStyle(TextInputStyle.Short)
        .setValue(_getEnvValue(field))
        .setRequired(false);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
    }

    await interaction.showModal(modal);
    return true;
  }

  async _handleGameSettingsSelect(interaction) {
    if (!interaction.member?.permissions?.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({ content: '❌ Only administrators can edit server settings.', ephemeral: true });
      return true;
    }

    if (!this._hasSftp) {
      await interaction.reply({ content: '❌ SFTP credentials not configured. Game settings require FTP_HOST, FTP_USER, and FTP_PASSWORD.', ephemeral: true });
      return true;
    }

    const categoryId = interaction.values[0];
    const category = GAME_SETTINGS_CATEGORIES.find(c => c.id === categoryId);
    if (!category) {
      await interaction.reply({ content: '❌ Unknown category.', ephemeral: true });
      return true;
    }

    const cached = _getCachedSettings();

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
    if (!interaction.member?.permissions?.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({ content: '❌ Only administrators can edit bot config.', ephemeral: true });
      return true;
    }

    const categoryId = interaction.customId.replace('panel_env_modal:', '');
    const category = ENV_CATEGORIES.find(c => c.id === categoryId);
    if (!category) {
      await interaction.reply({ content: '❌ Unknown category.', ephemeral: true });
      return true;
    }

    await interaction.deferReply({ ephemeral: true });

    try {
      const updates = {};
      const changes = [];

      for (const field of category.fields) {
        const newValue = interaction.fields.getTextInputValue(field.env);
        const oldValue = _getEnvValue(field);

        if (newValue !== oldValue) {
          updates[field.env] = newValue;
          changes.push(`**${field.label}:** \`${oldValue || '(empty)'}\` → \`${newValue || '(empty)'}\``);

          // Apply live for categories that don't require restart
          if (!category.restart) {
            _applyLiveConfig(field, newValue);
          }
        }
      }

      if (Object.keys(updates).length === 0) {
        await interaction.editReply('No changes detected.');
        return true;
      }

      _writeEnvValues(updates);

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
    if (!interaction.member?.permissions?.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({ content: '❌ Only administrators can edit server settings.', ephemeral: true });
      return true;
    }

    if (!this._hasSftp) {
      await interaction.reply({ content: '❌ SFTP credentials not configured.', ephemeral: true });
      return true;
    }

    const categoryId = interaction.customId.replace('panel_game_modal:', '');
    const category = GAME_SETTINGS_CATEGORIES.find(c => c.id === categoryId);
    if (!category) {
      await interaction.reply({ content: '❌ Unknown category.', ephemeral: true });
      return true;
    }

    await interaction.deferReply({ ephemeral: true });

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
      const cached = _getCachedSettings();

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
      try { fs.writeFileSync(SETTINGS_CACHE, JSON.stringify(cached, null, 2)); } catch (_) {}

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
    if (!interaction.member?.permissions?.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({ content: '❌ Only administrators can manage servers.', ephemeral: true });
      return true;
    }

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
    if (!interaction.member?.permissions?.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({ content: '❌ Only administrators can manage servers.', ephemeral: true });
      return true;
    }

    const name = interaction.fields.getTextInputValue('name').trim();
    const rconHost = interaction.fields.getTextInputValue('rcon_host').trim();
    const rconPort = parseInt(interaction.fields.getTextInputValue('rcon_port'), 10) || 14541;
    const rconPassword = interaction.fields.getTextInputValue('rcon_password').trim();
    const gamePort = parseInt(interaction.fields.getTextInputValue('game_port'), 10) || 14242;

    if (!name || !rconHost || !rconPassword) {
      await interaction.reply({ content: '❌ Name, RCON Host, and RCON Password are required.', ephemeral: true });
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
      .setStyle(ButtonStyle.Primary)
      .setEmoji('📂');

    const continueBtn = new ButtonBuilder()
      .setCustomId(`panel_add_step2:${interaction.user.id}`)
      .setLabel('Configure Channels')
      .setStyle(ButtonStyle.Primary)
      .setEmoji('📺');

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
      ephemeral: true,
    });
    return true;
  }

  async _handleAddSftpButton(interaction, customId) {
    if (!interaction.member?.permissions?.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({ content: '❌ Only administrators can manage servers.', ephemeral: true });
      return true;
    }

    const userId = customId.replace('panel_add_sftp:', '');
    const pending = this._pendingServers.get(userId);
    if (!pending) {
      await interaction.reply({ content: '❌ Session expired. Please start over with "Add Server".', ephemeral: true });
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
    if (!interaction.member?.permissions?.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({ content: '❌ Only administrators can manage servers.', ephemeral: true });
      return true;
    }

    const userId = interaction.customId.replace('panel_add_sftp_modal:', '');
    const pending = this._pendingServers.get(userId);
    if (!pending) {
      await interaction.reply({ content: '❌ Session expired. Please start over with "Add Server".', ephemeral: true });
      return true;
    }

    const host = interaction.fields.getTextInputValue('sftp_host').trim();
    const port = parseInt(interaction.fields.getTextInputValue('sftp_port'), 10) || 22;
    const user = interaction.fields.getTextInputValue('sftp_user').trim();
    const password = interaction.fields.getTextInputValue('sftp_password').trim();

    if (!host || !user || !password) {
      await interaction.reply({ content: '❌ SFTP host, username, and password are required.', ephemeral: true });
      return true;
    }

    // Store SFTP config on the pending server definition
    pending.sftp = { host, port, user, password };

    // Show continue/skip buttons
    const continueBtn = new ButtonBuilder()
      .setCustomId(`panel_add_step2:${userId}`)
      .setLabel('Configure Channels')
      .setStyle(ButtonStyle.Primary)
      .setEmoji('📺');

    const skipBtn = new ButtonBuilder()
      .setCustomId(`panel_srv_skip_channels:${userId}`)
      .setLabel('Skip — Save Now')
      .setStyle(ButtonStyle.Secondary);

    await interaction.reply({
      content: `✅ **SFTP configured!** \`${host}:${port}\`\n` +
        `File paths will auto-discover when the server starts.\n\n` +
        `**Next:** Configure channels or save now.`,
      components: [new ActionRowBuilder().addComponents(continueBtn, skipBtn)],
      ephemeral: true,
    });
    return true;
  }

  async _handleAddServerStep2Button(interaction, customId) {
    if (!interaction.member?.permissions?.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({ content: '❌ Only administrators can manage servers.', ephemeral: true });
      return true;
    }

    const userId = customId.replace('panel_add_step2:', '');
    const pending = this._pendingServers.get(userId);
    if (!pending) {
      await interaction.reply({ content: '❌ Session expired. Please start over with "Add Server".', ephemeral: true });
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
    if (!interaction.member?.permissions?.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({ content: '❌ Only administrators can manage servers.', ephemeral: true });
      return true;
    }

    const userId = interaction.customId.replace('panel_add_modal_step2:', '');
    const pending = this._pendingServers.get(userId);
    if (!pending) {
      await interaction.reply({ content: '❌ Session expired. Please start over with "Add Server".', ephemeral: true });
      return true;
    }

    await interaction.deferReply({ ephemeral: true });

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
    if (!interaction.member?.permissions?.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({ content: '❌ Only administrators can manage servers.', ephemeral: true });
      return true;
    }

    const serverId = interaction.values[0];
    const servers = this.multiServerManager?.getAllServers() || [];
    const server = servers.find(s => s.id === serverId);
    if (!server) {
      await interaction.reply({ content: '❌ Server not found.', ephemeral: true });
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
      ephemeral: true,
    });
    return true;
  }

  async _handleServerAction(interaction, customId) {
    if (!interaction.member?.permissions?.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({ content: '❌ Only administrators can manage servers.', ephemeral: true });
      return true;
    }

    // Handle skip channels button from add wizard
    if (customId.startsWith('panel_srv_skip_channels:')) {
      const userId = customId.replace('panel_srv_skip_channels:', '');
      const pending = this._pendingServers.get(userId);
      if (!pending) {
        await interaction.reply({ content: '❌ Session expired. Please start over.', ephemeral: true });
        return true;
      }

      await interaction.deferReply({ ephemeral: true });
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
        await interaction.deferReply({ ephemeral: true });
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
        await interaction.deferReply({ ephemeral: true });
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
        await interaction.deferReply({ ephemeral: true });
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
        await interaction.deferReply({ ephemeral: true });
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
          await interaction.reply({ content: '❌ Server not found.', ephemeral: true });
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
          await interaction.reply({ content: '❌ Server not found.', ephemeral: true });
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
          await interaction.reply({ content: '❌ Server not found.', ephemeral: true });
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
          await interaction.reply({ content: '❌ Server not found.', ephemeral: true });
          return true;
        }

        const srvConfig = createServerConfig(server);
        if (!srvConfig.ftpHost || !srvConfig.ftpUser || !srvConfig.ftpPassword) {
          await interaction.reply({ content: '❌ No SFTP credentials configured for this server.', ephemeral: true });
          return true;
        }

        await interaction.deferReply({ ephemeral: true });

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
          await interaction.reply({ content: '❌ Server not found.', ephemeral: true });
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
    if (!interaction.member?.permissions?.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({ content: '❌ Only administrators can manage servers.', ephemeral: true });
      return true;
    }

    const serverId = interaction.customId.replace('panel_srv_edit_modal:', '');
    await interaction.deferReply({ ephemeral: true });

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
    if (!interaction.member?.permissions?.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({ content: '❌ Only administrators can manage servers.', ephemeral: true });
      return true;
    }

    const serverId = interaction.customId.replace('panel_srv_channels_modal:', '');
    await interaction.deferReply({ ephemeral: true });

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
    if (!interaction.member?.permissions?.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({ content: '❌ Only administrators can manage servers.', ephemeral: true });
      return true;
    }

    const serverId = interaction.customId.replace('panel_srv_sftp_modal:', '');
    await interaction.deferReply({ ephemeral: true });

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
    if (!srvConfig.ftpHost || !srvConfig.ftpUser || !srvConfig.ftpPassword) return null;
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
    if (!interaction.member?.permissions?.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({ content: '❌ Only administrators can edit server settings.', ephemeral: true });
      return true;
    }

    // customId = panel_srv_settings:<serverId>, value = categoryId
    const serverId = interaction.customId.replace('panel_srv_settings:', '');
    const categoryId = interaction.values[0];
    const category = GAME_SETTINGS_CATEGORIES.find(c => c.id === categoryId);
    if (!category) {
      await interaction.reply({ content: '❌ Unknown category.', ephemeral: true });
      return true;
    }

    const servers = this.multiServerManager?.getAllServers() || [];
    const serverDef = servers.find(s => s.id === serverId);
    if (!serverDef) {
      await interaction.reply({ content: '❌ Server not found.', ephemeral: true });
      return true;
    }

    const sftpCfg = this._getSrvSftpConfig(serverDef);
    if (!sftpCfg) {
      await interaction.reply({ content: '❌ No SFTP credentials for this server.', ephemeral: true });
      return true;
    }

    // Read current settings from server's data dir cache
    let cached = {};
    const dataDir = path.join(__dirname, '..', 'data', 'servers', serverId);
    const cachePath = path.join(dataDir, 'server-settings.json');
    try { cached = JSON.parse(fs.readFileSync(cachePath, 'utf8')); } catch {}

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
    if (!interaction.member?.permissions?.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({ content: '❌ Only administrators can edit server settings.', ephemeral: true });
      return true;
    }

    // customId = panel_srv_game_modal:<serverId>:<categoryId>
    const parts = interaction.customId.replace('panel_srv_game_modal:', '').split(':');
    const serverId = parts[0];
    const categoryId = parts[1];
    const category = GAME_SETTINGS_CATEGORIES.find(c => c.id === categoryId);
    if (!category) {
      await interaction.reply({ content: '❌ Unknown category.', ephemeral: true });
      return true;
    }

    const servers = this.multiServerManager?.getAllServers() || [];
    const serverDef = servers.find(s => s.id === serverId);
    if (!serverDef) {
      await interaction.reply({ content: '❌ Server not found.', ephemeral: true });
      return true;
    }

    const sftpCfg = this._getSrvSftpConfig(serverDef);
    if (!sftpCfg) {
      await interaction.reply({ content: '❌ No SFTP credentials for this server.', ephemeral: true });
      return true;
    }

    await interaction.deferReply({ ephemeral: true });

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
      const dataDir = path.join(__dirname, '..', 'data', 'servers', serverId);
      if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
      const cachePath = path.join(dataDir, 'server-settings.json');
      let cached = {};
      try { cached = JSON.parse(fs.readFileSync(cachePath, 'utf8')); } catch {}

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

      try { fs.writeFileSync(cachePath, JSON.stringify(cached, null, 2)); } catch (_) {}

      let msg = `✅ **${serverDef.name} — ${category.label}** updated:\n${changes.join('\n')}`;
      msg += '\n\n⚠️ **Restart the game server** for these changes to take effect.';

      await interaction.editReply(msg);
    } catch (err) {
      await interaction.editReply(`❌ Failed to save: ${err.message}`);
    }
    return true;
  }

  async _handleSrvWelcomeModal(interaction) {
    if (!interaction.member?.permissions?.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({ content: '❌ Only administrators can manage servers.', ephemeral: true });
      return true;
    }

    const serverId = interaction.customId.replace('panel_srv_welcome_modal:', '');

    const servers = this.multiServerManager?.getAllServers() || [];
    const serverDef = servers.find(s => s.id === serverId);
    if (!serverDef) {
      await interaction.reply({ content: '❌ Server not found.', ephemeral: true });
      return true;
    }

    const sftpCfg = this._getSrvSftpConfig(serverDef);
    if (!sftpCfg) {
      await interaction.reply({ content: '❌ No SFTP credentials for this server.', ephemeral: true });
      return true;
    }

    await interaction.deferReply({ ephemeral: true });

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
    if (!interaction.member?.permissions?.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({ content: '❌ Only administrators can manage servers.', ephemeral: true });
      return true;
    }

    const serverId = interaction.customId.replace('panel_srv_automsg_modal:', '');

    const servers = this.multiServerManager?.getAllServers() || [];
    const idx = servers.findIndex(s => s.id === serverId);
    if (idx === -1) {
      await interaction.reply({ content: '❌ Server not found.', ephemeral: true });
      return true;
    }

    await interaction.deferReply({ ephemeral: true });

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
      const { loadServers, saveServers } = require('./multi-server');
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
  // Welcome message editor
  // ═══════════════════════════════════════════════════════════

  async _handleWelcomeEditButton(interaction) {
    if (!interaction.member?.permissions?.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({ content: '❌ Only administrators can edit the welcome message.', ephemeral: true });
      return true;
    }

    if (!this._hasSftp) {
      await interaction.reply({ content: '❌ SFTP credentials not configured.', ephemeral: true });
      return true;
    }

    await interaction.deferReply({ ephemeral: true });

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
      .setStyle(ButtonStyle.Primary)
      .setEmoji('📝');

    await interaction.editReply({
      content: helpText,
      components: [new ActionRowBuilder().addComponents(openBtn)],
    });
    return true;
  }

  async _handleWelcomeOpenModal(interaction) {
    if (!interaction.member?.permissions?.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({ content: '❌ Only administrators can edit the welcome message.', ephemeral: true });
      return true;
    }

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
    if (!interaction.member?.permissions?.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({ content: '❌ Only administrators can edit the welcome message.', ephemeral: true });
      return true;
    }

    await interaction.deferReply({ ephemeral: true });

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
    if (!interaction.member?.permissions?.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({ content: '❌ Only administrators can edit broadcasts.', ephemeral: true });
      return true;
    }

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
      .setStyle(ButtonStyle.Primary)
      .setEmoji('📢');

    await interaction.reply({
      content: helpText,
      components: [new ActionRowBuilder().addComponents(openBtn)],
      ephemeral: true,
    });
    return true;
  }

  async _handleBroadcastsOpenModal(interaction) {
    if (!interaction.member?.permissions?.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({ content: '❌ Only administrators can edit broadcasts.', ephemeral: true });
      return true;
    }

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
    if (!interaction.member?.permissions?.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({ content: '❌ Only administrators can edit broadcasts.', ephemeral: true });
      return true;
    }

    await interaction.deferReply({ ephemeral: true });

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
    // Include per-server embed message IDs
    if (ids.servers) {
      for (const msgId of Object.values(ids.servers)) {
        if (msgId) savedIds.push(msgId);
      }
    }
    let allFound = savedIds.length > 0;
    if (savedIds.length > 0) {
      // Have saved IDs — try to delete those specific messages
      for (const savedId of savedIds) {
        try {
          const msg = await this.channel.messages.fetch(savedId);
          if (msg && msg.author.id === this.client.user.id) {
            await msg.delete();
            console.log(`[PANEL CH] Cleaned previous message ${savedId}`);
          }
        } catch (err) {
          if (err.code === 10008) {
            allFound = false; // message gone — need bulk sweep
          } else {
            console.log('[PANEL CH] Could not clean saved message:', err.message);
          }
        }
      }
      if (allFound) return; // all saved messages found and deleted — no sweep needed
      console.log('[PANEL CH] Some saved messages already gone, sweeping channel...');
    }
    // No saved IDs, or some were stale — sweep old bot messages
    // Only delete messages older than this process start to avoid wiping
    // sibling multi-server embeds posted earlier in this same startup.
    const bootTime = Date.now() - process.uptime() * 1000;
    try {
      const messages = await this.channel.messages.fetch({ limit: 20 });
      const botMessages = messages.filter(m => m.author.id === this.client.user.id && m.createdTimestamp < bootTime);
      if (botMessages.size > 0) {
        console.log(`[PANEL CH] Cleaning ${botMessages.size} old bot message(s)`);
        for (const [, msg] of botMessages) {
          try { await msg.delete(); } catch (_) {}
        }
      }
    } catch (err) {
      console.log('[PANEL CH] Could not clean old messages:', err.message);
    }
  }

  _loadMessageIds() {
    try {
      const fp = path.join(PanelChannel._DATA_DIR, 'message-ids.json');
      if (fs.existsSync(fp)) {
        const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
        return {
          panelBot: data.panelBot || null,
          panelServer: data.panelServer || null,
          servers: data.panelServers || {}, // serverId → messageId
        };
      }
    } catch {}
    return { panelBot: null, panelServer: null, servers: {} };
  }

  _saveMessageIds() {
    try {
      const fp = path.join(PanelChannel._DATA_DIR, 'message-ids.json');
      let data = {};
      try { if (fs.existsSync(fp)) data = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch {}
      if (this.botMessage)   data.panelBot = this.botMessage.id;
      if (this.panelMessage) data.panelServer = this.panelMessage.id;
      // Per-server message IDs
      const serverIds = {};
      for (const [sid, msg] of this._serverMessages) {
        serverIds[sid] = msg.id;
      }
      if (Object.keys(serverIds).length > 0) data.panelServers = serverIds;
      fs.writeFileSync(fp, JSON.stringify(data, null, 2));
    } catch {}
  }

  async _update(force = false) {
    try {
      // ── Update bot embed (always) ──
      if (this.botMessage) {
        const botEmbed = this._buildBotEmbed();
        const botKey = JSON.stringify(botEmbed.data);
        if (force || botKey !== this._lastBotKey) {
          this._lastBotKey = botKey;
          try {
            await this.botMessage.edit({ embeds: [botEmbed], components: this._buildBotComponents() });
          } catch (editErr) {
            if (editErr.code === 10008 || editErr.message?.includes('Unknown Message')) {
              console.log('[PANEL CH] Bot message deleted, re-creating...');
              this.botMessage = await this.channel.send({ embeds: [botEmbed], components: this._buildBotComponents() });
              this._saveMessageIds();
            } else throw editErr;
          }
        }
      }

      // ── Update server embed (only if panel API is available) ──
      if (this.panelMessage && panelApi.available) {
        const [resources, details, backups, schedules] = await Promise.all([
          panelApi.getResources().catch(() => null),
          panelApi.getServerDetails().catch(() => ({})),
          panelApi.listBackups().catch(() => []),
          panelApi.listSchedules().catch(() => []),
        ]);

        const state = resources?.state || 'offline';
        this._backupLimit = details?.feature_limits?.backups ?? null;

        const serverEmbed = this._buildServerEmbed(resources, details, backups, schedules);
        const panelKey = JSON.stringify(serverEmbed.data);
        if (force || panelKey !== this._lastPanelKey) {
          this._lastPanelKey = panelKey;
          this._lastState = state;
          try {
            await this.panelMessage.edit({
              embeds: [serverEmbed],
              components: this._buildServerComponents(state),
            });
          } catch (editErr) {
            if (editErr.code === 10008 || editErr.message?.includes('Unknown Message')) {
              console.log('[PANEL CH] Panel message deleted, re-creating...');
              this.panelMessage = await this.channel.send({
                embeds: [serverEmbed],
                components: this._buildServerComponents(state),
              });
              this._saveMessageIds();
            } else throw editErr;
          }
        }
      }

      // ── Update per-server management embeds ──
      if (this.multiServerManager && this._serverMessages.size > 0) {
        const servers = this.multiServerManager.getAllServers();
        for (const serverDef of servers) {
          const msg = this._serverMessages.get(serverDef.id);
          if (!msg) continue;
          const instance = this.multiServerManager.getInstance(serverDef.id);
          const embed = this._buildManagedServerEmbed(serverDef, instance);
          const embedKey = JSON.stringify(embed.data);
          if (force || embedKey !== this._lastServerKeys.get(serverDef.id)) {
            this._lastServerKeys.set(serverDef.id, embedKey);
            const components = this._buildManagedServerComponents(serverDef.id, instance?.running || false);
            try {
              await msg.edit({ embeds: [embed], components });
            } catch (editErr) {
              if (editErr.code === 10008 || editErr.message?.includes('Unknown Message')) {
                console.log(`[PANEL CH] Server embed for ${serverDef.name} deleted, re-creating...`);
                const newMsg = await this.channel.send({ embeds: [embed], components });
                this._serverMessages.set(serverDef.id, newMsg);
                this._saveMessageIds();
              }
            }
          }
        }
      }
    } catch (err) {
      console.error('[PANEL CH] Update error:', err.message);
    }
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
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('📝'),
      new ButtonBuilder()
        .setCustomId(`panel_srv_automsg:${serverId}`)
        .setLabel('Auto Messages')
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('📢'),
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
    for (const [name, status] of Object.entries(this.moduleStatus)) {
      const icon = status.startsWith('🟢') ? '🟢' : status.startsWith('⚫') ? '⚫' : '🟡';
      statusLines.push(`${icon} ${name}`);
    }
    if (statusLines.length > 0) {
      embed.addFields({ name: '📦 Modules', value: statusLines.join('\n') });
    }

    return embed;
  }

  _buildBotComponents() {
    const select = new StringSelectMenuBuilder()
      .setCustomId(SELECT.ENV)
      .setPlaceholder('Edit bot config...')
      .addOptions(
        ENV_CATEGORIES.map(c => ({
          label: c.label,
          description: c.description,
          value: c.id,
          emoji: c.emoji,
        }))
      );

    const restartBtn = new ButtonBuilder()
      .setCustomId(BTN.BOT_RESTART)
      .setLabel('Restart Bot')
      .setStyle(ButtonStyle.Danger);

    const buttonRow = new ActionRowBuilder().addComponents(restartBtn);

    // Add server management button if multi-server manager is available
    if (this.multiServerManager) {
      const addServerBtn = new ButtonBuilder()
        .setCustomId(BTN.ADD_SERVER)
        .setLabel('Add Server')
        .setStyle(ButtonStyle.Success)
        .setEmoji('➕');
      buttonRow.addComponents(addServerBtn);
    }

    return [
      new ActionRowBuilder().addComponents(select),
      buttonRow,
    ];
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
          .setEmoji('📝')
      );
    }
    if (config.enableAutoMessages) {
      toolsRow.addComponents(
        new ButtonBuilder()
          .setCustomId(BTN.BROADCASTS)
          .setLabel('Broadcasts')
          .setStyle(ButtonStyle.Secondary)
          .setEmoji('📢')
      );
    }

    const rows = [powerRow];
    if (toolsRow.components.length > 0) rows.push(toolsRow);

    // Game settings dropdown if SFTP is configured
    if (this._hasSftp) {
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

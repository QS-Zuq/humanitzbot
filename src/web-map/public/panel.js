
(function () {
  'use strict';

  const S = {
    user: null,
    tier: 0,
    currentTab: 'dashboard',
    currentServer: 'primary',
    multiServer: false,
    players: [],
    toggles: {},
    worldBounds: null,
    map: null,
    mapMarkers: {},
    mapReady: false,
    scheduleData: null,
    settingsOriginal: {},
    settingsChanged: {},
    settingsMode: 'game',
    botConfigOriginal: {},
    botConfigChanged: {},
    botConfigSections: [],
    consoleBuf: [],
    viewMode: 'admin',
    pollTimers: [],
    playerSort: { col: 'online', dir: 'desc' },
    playerViewMode: 'table',
    dashHistory: { online: [], events: [] },
    sparkCharts: {},
    dbLastResult: null,
    activityCategory: '',
    activityChartsLoaded: false,
    activityCharts: {},
    activityStats: null,
    dbMode: 'browse',
    dbTablesLive: [],
    dbSchemaCache: {},
  };

  const $ = (sel, ctx) => (ctx || document).querySelector(sel);
  const $$ = (sel, ctx) => [...(ctx || document).querySelectorAll(sel)];
  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };

  /** Build API URL with server query param appended */
  function apiUrl(path) {
    if (S.currentServer === 'primary') return path;
    var sep = path.indexOf('?') >= 0 ? '&' : '?';
    return path + sep + 'server=' + encodeURIComponent(S.currentServer);
  }

  /** Fetch wrapper that auto-appends server param to /api/ URLs */
  function apiFetch(url, opts) {
    return fetch(apiUrl(url), opts);
  }

  const SETTING_CATEGORIES = {
    Server: ['ServerName', 'MaxPlayers', 'SaveName', 'SearchID', 'Version', 'NoJoinFeedback', 'NoDeathFeedback', 'LimitedSpawns', 'Voip'],
    Gameplay: ['PVP', 'DaysPerSeason', 'StartingSeason', 'XpMultiplier', 'AirDrop', 'AirDropInterval', 'AIEvent', 'EagleEye', 'ClearInfection', 'MultiplayerSleep', 'FreezeTime', 'MaxOwnedCars', 'Territory', 'PermaDeath', 'OnDeath'],
    'Day / Night': ['DayDur', 'NightDur', 'Seg0', 'Seg1', 'Seg2'],
    Survival: ['VitalDrain', 'FoodDecay', 'Sleep', 'GenFuel', 'WeaponBreak', 'RespawnTimer'],
    Building: ['AllowDismantle', 'AllowHouseDismantle', 'BuildingHealth', 'BuildingDecay', 'Decay', 'FakeBuildingCleanup'],
    Companions: ['DogEnabled', 'RecruitDog', 'DogNum', 'CompanionHealth', 'CompanionDmg'],
    Zombies: ['ZombieAmountMulti', 'ZombieDiffHealth', 'ZombieDiffSpeed', 'ZombieDiffDamage', 'ZombieRespawnTimer', 'ZombieDogMulti'],
    'Humans (NPC)': ['HumanAmountMulti', 'HumanHealth', 'HumanSpeed', 'HumanDamage', 'HumanRespawnTimer'],
    Animals: ['AnimalMulti', 'AnimalRespawnTimer'],
    Loot: ['LootRespawn', 'LootRespawnTimer', 'PickupRespawnTimer', 'PickupCleanup', 'SaveIntervalSec'],
    'Loot Rarity': ['RarityFood', 'RarityDrink', 'RarityMelee', 'RarityRanged', 'RarityAmmo', 'RarityArmor', 'RarityResources', 'RarityOther'],
    Weather: ['Weather_ClearSky', 'Weather_Cloudy', 'Weather_Foggy', 'Weather_LightRain', 'Weather_Rain', 'Weather_Thunderstorm', 'Weather_LightSnow', 'Weather_Snow', 'Weather_Blizzard'],
  };

  const SETTING_DESCS = {
    ServerName: 'Display name of the server', MaxPlayers: 'Maximum concurrent players', SaveName: 'Save file name',
    SearchID: 'Server search identifier', Version: 'Server version',
    NoJoinFeedback: 'Hide join notifications in-game', NoDeathFeedback: 'Hide death notifications in-game',
    LimitedSpawns: 'Restrict spawn point choices', Voip: 'Voice chat enabled',
    PVP: 'Player vs player damage', DaysPerSeason: 'In-game days per season (4 seasons = 1 year)',
    StartingSeason: 'Season index at world start', XpMultiplier: 'Experience gain multiplier',
    AirDrop: 'Air drops enabled', AirDropInterval: 'Minutes between air drops',
    AIEvent: 'Random AI events enabled', EagleEye: 'Eagle Eye perk available',
    ClearInfection: 'Allow curing infection', MultiplayerSleep: 'All players must sleep to skip night',
    FreezeTime: 'Freeze the day/night cycle', MaxOwnedCars: 'Max vehicles per player',
    Territory: 'Territory protection enabled', PermaDeath: 'Permanent death mode',
    OnDeath: 'What happens on death (0=keep, 1=drop, 2=destroy)',
    DayDur: 'Daytime duration (minutes)', NightDur: 'Nighttime duration (minutes)',
    Seg0: 'Day segment 0', Seg1: 'Day segment 1', Seg2: 'Day segment 2',
    VitalDrain: 'Hunger/thirst/stamina drain rate', FoodDecay: 'Food spoilage enabled',
    Sleep: 'Sleep mechanic enabled', GenFuel: 'Generator fuel consumption',
    WeaponBreak: 'Weapons can break', RespawnTimer: 'Respawn cooldown (seconds)',
    AllowDismantle: 'Dismantle player structures', AllowHouseDismantle: 'Dismantle pre-built houses',
    BuildingHealth: 'Structure health multiplier', BuildingDecay: 'Structure decay rate',
    Decay: 'General decay rate', FakeBuildingCleanup: 'Clean up invalid structures',
    DogEnabled: 'Dog companions enabled', RecruitDog: 'Can recruit dogs', DogNum: 'Max dogs in world',
    CompanionHealth: 'Companion health multiplier', CompanionDmg: 'Companion damage multiplier',
    ZombieAmountMulti: 'Zombie spawn density', ZombieDiffHealth: 'Zombie health multiplier',
    ZombieDiffSpeed: 'Zombie speed multiplier', ZombieDiffDamage: 'Zombie damage multiplier',
    ZombieRespawnTimer: 'Zombie respawn (seconds)', ZombieDogMulti: 'Zombie dog spawn multiplier',
    HumanAmountMulti: 'Hostile human spawn density', HumanHealth: 'Human NPC health',
    HumanSpeed: 'Human NPC speed', HumanDamage: 'Human NPC damage',
    HumanRespawnTimer: 'Human NPC respawn time', AnimalMulti: 'Animal spawn density',
    AnimalRespawnTimer: 'Animal respawn time', LootRespawn: 'Loot respawning enabled',
    LootRespawnTimer: 'Loot respawn (seconds)', PickupRespawnTimer: 'Pickup respawn (seconds)',
    PickupCleanup: 'Clean up old pickups', SaveIntervalSec: 'Auto-save interval (seconds)',
    RarityFood: 'Food loot weight', RarityDrink: 'Drink loot weight',
    RarityMelee: 'Melee weapon weight', RarityRanged: 'Ranged weapon weight',
    RarityAmmo: 'Ammo weight', RarityArmor: 'Armor weight',
    RarityResources: 'Resource weight', RarityOther: 'Misc loot weight',
    Weather_ClearSky: 'Clear sky weight', Weather_Cloudy: 'Cloudy weight',
    Weather_Foggy: 'Fog weight', Weather_LightRain: 'Light rain weight',
    Weather_Rain: 'Rain weight', Weather_Thunderstorm: 'Thunderstorm weight',
    Weather_LightSnow: 'Light snow weight', Weather_Snow: 'Snow weight',
    Weather_Blizzard: 'Blizzard weight',
  };

  // ── Bot .env configuration descriptions ──
  const ENV_DESCS = {
    DISCORD_TOKEN: 'Discord bot token from the Developer Portal',
    DISCORD_CLIENT_ID: 'Application ID from the Developer Portal',
    DISCORD_GUILD_ID: 'The Discord server (guild) ID',
    DISCORD_OAUTH_SECRET: 'OAuth2 client secret for web panel login',
    DISCORD_INVITE_LINK: 'Discord invite link broadcast to players in-game',
    RCON_HOST: 'Game server IP or hostname for RCON connection',
    RCON_PORT: 'RCON TCP port (default 8888)',
    RCON_PASSWORD: 'RCON authentication password',
    GAME_PORT: 'Game connection port shown in status embeds',
    PUBLIC_HOST: 'Public IP/hostname for connect address (if different from RCON_HOST)',
    SERVER_NAME: 'Short display name for this server',
    FTP_HOST: 'SFTP server hostname',
    FTP_PORT: 'SFTP port (default 2022)',
    FTP_USER: 'SFTP username',
    FTP_PASSWORD: 'SFTP password',
    FTP_PRIVATE_KEY_PATH: 'Path to SSH private key (optional, replaces password auth)',
    FTP_BASE_PATH: 'Base path prefix for all SFTP file paths',
    FTP_LOG_PATH: 'Path to HMZLog.log on the game server',
    FTP_CONNECT_LOG_PATH: 'Path to PlayerConnectedLog.txt',
    FTP_ID_MAP_PATH: 'Path to PlayerIDMapped.txt',
    FTP_SAVE_PATH: 'Path to Save_DedicatedSaveMP.sav',
    FTP_SETTINGS_PATH: 'Path to GameServerSettings.ini',
    FTP_WELCOME_PATH: 'Path to WelcomeMessage.txt',
    PANEL_CHANNEL_ID: 'Discord channel for the bot admin panel (required)',
    ADMIN_CHANNEL_ID: 'Discord channel for admin alerts',
    CHAT_CHANNEL_ID: 'Discord channel for chat relay',
    LOG_CHANNEL_ID: 'Discord channel for activity log',
    SERVER_STATUS_CHANNEL_ID: 'Discord channel for the server status embed',
    PLAYER_STATS_CHANNEL_ID: 'Discord channel for player stats embed',
    ACTIVITY_LOG_CHANNEL_ID: 'Discord channel for the activity log feed',
    BOT_TIMEZONE: 'Timezone for daily threads and summaries (IANA format, e.g. America/New_York)',
    LOG_TIMEZONE: 'Timezone the game server writes log timestamps in (default UTC)',
    ADMIN_USER_IDS: 'Comma-separated Discord user IDs with admin access',
    ADMIN_ROLE_IDS: 'Comma-separated Discord role IDs with admin access',
    ADMIN_ALERT_CHANNEL_IDS: 'Comma-separated channel IDs for admin alerts',
    ADMIN_VIEW_PERMISSIONS: 'Discord permissions that grant admin view (default: Administrator)',
    ENABLE_STATUS_CHANNELS: 'Voice channel dashboard showing player count and time',
    ENABLE_SERVER_STATUS: 'Auto-updating server status embed',
    ENABLE_CHAT_RELAY: 'Bidirectional Discord ↔ in-game chat bridge',
    ENABLE_AUTO_MESSAGES: 'Welcome messages and periodic broadcasts',
    ENABLE_PLAYTIME: 'Session tracking and playtime leaderboards',
    ENABLE_LOG_WATCHER: 'SFTP log polling and activity feed',
    ENABLE_PLAYER_STATS: 'Player stats embed with save file data',
    ENABLE_MILESTONES: 'Player milestone announcements (kills, playtime, etc.)',
    ENABLE_RECAPS: 'Daily and weekly recap embeds',
    ENABLE_ANTICHEAT: 'Anticheat analysis system',
    ENABLE_KILL_FEED: 'Post zombie kill batches to activity thread',
    ENABLE_PVP_KILL_FEED: 'Post PvP kills to activity thread',
    PVP_KILL_WINDOW: 'Time window (ms) to attribute a kill after damage event',
    ENABLE_DEATH_LOOP_DETECTION: 'Collapse rapid-fire death messages',
    DEATH_LOOP_THRESHOLD: 'Deaths within window to trigger collapse',
    DEATH_LOOP_WINDOW: 'Time window (ms) for death loop detection',
    USE_CHAT_THREADS: 'Post chat messages in daily threads',
    USE_ACTIVITY_THREADS: 'Post activity events in daily threads',
    ENABLE_AUTO_MSG_LINK: 'Periodic Discord invite link broadcast',
    ENABLE_AUTO_MSG_PROMO: 'Periodic promo message broadcast',
    ENABLE_WELCOME_MSG: 'RCON welcome message on player join',
    ENABLE_WELCOME_FILE: 'SFTP-managed WelcomeMessage.txt',
    AUTO_MSG_LINK_TEXT: 'Custom Discord link broadcast text',
    AUTO_MSG_PROMO_TEXT: 'Custom promo broadcast text',
    WELCOME_FILE_LINES: 'Custom welcome file lines (pipe-separated)',
    ENABLE_PVP_SCHEDULER: 'Timed PvP on/off via SFTP settings edit',
    PVP_START_TIME: 'PvP enable time (HH:MM)',
    PVP_END_TIME: 'PvP disable time (HH:MM)',
    PVP_RESTART_DELAY: 'Countdown minutes before PvP restart',
    PVP_UPDATE_SERVER_NAME: 'Append PvP status to server name',
    PVP_DAYS: 'Days PvP is active (e.g. Mon,Wed,Fri)',
    PVP_SETTINGS_OVERRIDES: 'JSON: game settings applied when PvP enables',
    ENABLE_SERVER_SCHEDULER: 'Timed restarts with difficulty profiles',
    RESTART_TIMES: 'Comma-separated HH:MM restart times',
    RESTART_DELAY: 'Countdown minutes before scheduled restart',
    RESTART_PROFILES: 'Comma-separated difficulty profile names',
    RESTART_ROTATE_DAILY: 'Shift profile order each day',
    DOCKER_CONTAINER: 'Docker container name for restart commands',
    ENABLE_ACTIVITY_LOG: 'Save-diff activity logging (containers, horses, vehicles)',
    ENABLE_CONTAINER_LOG: 'Container item add/remove tracking',
    ENABLE_HORSE_LOG: 'Horse appeared/disappeared/health tracking',
    ENABLE_VEHICLE_LOG: 'Vehicle trunk change tracking',
    SHOW_INVENTORY_LOG: 'Player inventory change tracking (sensitive)',
    SHOW_INVENTORY_LOG_ADMIN_ONLY: 'Restrict inventory log to admins',
    SAVE_POLL_INTERVAL: 'Save file poll interval in ms (min 60000)',
    LOG_POLL_INTERVAL: 'Log file poll interval in ms (min 10000)',
    CHAT_POLL_INTERVAL: 'Chat poll interval in ms (min 5000)',
    SERVER_STATUS_INTERVAL: 'Server status poll interval in ms (min 15000)',
    PANEL_SERVER_URL: 'Pterodactyl panel server URL (for power/backups)',
    PANEL_API_KEY: 'Pterodactyl panel API key',
    ENABLE_PANEL: 'Panel API integration (power, backups, resources)',
    ENABLE_GAME_SETTINGS_EDITOR: 'Game settings editor in panel channel',
    ENABLE_SSH_RESOURCES: 'SSH-based resource monitoring',
    SSH_PORT: 'SSH port for resource monitoring (default: FTP_PORT)',
    RESOURCE_CACHE_TTL: 'Resource metrics cache TTL in ms',
    AGENT_MODE: 'Save parser mode: auto, agent, or direct',
    AGENT_TRIGGER: 'How to trigger agent: auto, ssh, panel, or none',
    AGENT_NODE_PATH: 'Path to Node.js binary on the game server',
    AGENT_REMOTE_DIR: 'Remote directory for agent upload',
    AGENT_CACHE_PATH: 'Path to humanitz-cache.json',
    AGENT_TIMEOUT: 'Max wait time (ms) for agent execution',
    AGENT_POLL_INTERVAL: 'Agent poll interval in ms (default 90000)',
    WEB_MAP_PORT: 'Port for the web panel (default: auto)',
    ENABLE_STDIN_CONSOLE: 'Interactive stdin console for headless hosts',
    STDIN_CONSOLE_WRITABLE: 'Allow stdin console to execute commands',
    FIRST_RUN: 'Run first-time setup on next start',
    ENV_SCHEMA_VERSION: 'Configuration schema version (managed by bot)',
    SHOW_RAID_STATS: 'Show raid stats in player embeds',
    SHOW_PVP_KILLS: 'Show PvP kills in overview embed',
    SHOW_VITALS: 'Show vitals in player embeds',
    SHOW_STATUS_EFFECTS: 'Show status effects in player embeds',
    SHOW_INVENTORY: 'Show inventory in player embeds',
    SHOW_RECIPES: 'Show recipes in player embeds',
    SHOW_LORE: 'Show lore in player embeds',
    SHOW_SKILLS: 'Show skills in player embeds',
    SHOW_CONNECTIONS: 'Show connection history in player embeds',
    SHOW_COORDINATES: 'Show player coordinates (sensitive)',
    SHOW_COORDINATES_ADMIN_ONLY: 'Restrict coordinates to admins',
  };

  // Boolean env keys — render as toggles instead of text inputs
  const ENV_BOOLEANS = new Set([
    'FIRST_RUN', 'ENABLE_STATUS_CHANNELS', 'ENABLE_SERVER_STATUS', 'ENABLE_CHAT_RELAY',
    'ENABLE_AUTO_MESSAGES', 'ENABLE_PLAYTIME', 'ENABLE_LOG_WATCHER', 'ENABLE_PLAYER_STATS',
    'ENABLE_MILESTONES', 'ENABLE_RECAPS', 'ENABLE_ANTICHEAT', 'ENABLE_KILL_FEED',
    'ENABLE_PVP_KILL_FEED', 'ENABLE_DEATH_LOOP_DETECTION', 'USE_CHAT_THREADS',
    'USE_ACTIVITY_THREADS', 'ENABLE_AUTO_MSG_LINK', 'ENABLE_AUTO_MSG_PROMO',
    'ENABLE_WELCOME_MSG', 'ENABLE_WELCOME_FILE', 'ENABLE_PVP_SCHEDULER',
    'PVP_UPDATE_SERVER_NAME', 'ENABLE_SERVER_SCHEDULER', 'RESTART_ROTATE_DAILY',
    'ENABLE_ACTIVITY_LOG', 'ENABLE_CONTAINER_LOG', 'ENABLE_HORSE_LOG',
    'ENABLE_VEHICLE_LOG', 'SHOW_INVENTORY_LOG', 'SHOW_INVENTORY_LOG_ADMIN_ONLY',
    'ENABLE_PANEL', 'ENABLE_GAME_SETTINGS_EDITOR', 'ENABLE_SSH_RESOURCES',
    'ENABLE_STDIN_CONSOLE', 'STDIN_CONSOLE_WRITABLE', 'SHOW_RAID_STATS',
    'SHOW_PVP_KILLS', 'SHOW_VITALS', 'SHOW_STATUS_EFFECTS', 'SHOW_INVENTORY',
    'SHOW_RECIPES', 'SHOW_LORE', 'SHOW_SKILLS', 'SHOW_CONNECTIONS',
    'SHOW_COORDINATES', 'SHOW_COORDINATES_ADMIN_ONLY',
    'ENABLE_FISHING_FEED', 'ENABLE_RECIPE_FEED', 'ENABLE_SKILL_FEED',
    'ENABLE_PROFESSION_FEED', 'ENABLE_LORE_FEED', 'ENABLE_UNIQUE_FEED',
    'ENABLE_COMPANION_FEED', 'ENABLE_CHALLENGE_FEED', 'ENABLE_WORLD_EVENT_FEED',
  ]);

  const DB_TABLES = [
    { value: 'activity_log', label: 'Activity Log' },
    { value: 'chat_log', label: 'Chat Log' },
    { value: 'players', label: 'Players' },
    { value: 'player_aliases', label: 'Player Aliases' },
    { value: 'clans', label: 'Clans' },
    { value: 'clan_members', label: 'Clan Members' },
    { value: 'world_state', label: 'World State' },
    { value: 'structures', label: 'Structures' },
    { value: 'vehicles', label: 'Vehicles' },
    { value: 'companions', label: 'Companions' },
    { value: 'world_horses', label: 'Horses' },
    { value: 'dead_bodies', label: 'Dead Bodies' },
    { value: 'containers', label: 'Containers' },
    { value: 'loot_actors', label: 'Loot Actors' },
    { value: 'world_drops', label: 'World Drops' },
    { value: 'server_settings', label: 'Server Settings' },
    { value: 'snapshots', label: 'Snapshots' },
    { value: 'item_instances', label: 'Item Instances' },
    { value: 'item_groups', label: 'Item Groups' },
    { value: 'item_movements', label: 'Item Movements' },
    { value: 'game_items', label: 'Game Items' },
    { value: 'game_buildings', label: 'Game Buildings' },
    { value: 'game_recipes', label: 'Game Recipes' },
    { value: 'game_vehicles_ref', label: 'Game Vehicles' },
    { value: 'game_loot_pools', label: 'Loot Pools' },
    { value: 'game_professions', label: 'Professions' },
    { value: 'game_afflictions', label: 'Afflictions' },
    { value: 'game_skills', label: 'Skills' },
    { value: 'game_challenges', label: 'Challenges' },
    { value: 'game_animals', label: 'Animals' },
    { value: 'game_server_setting_defs', label: 'Setting Definitions' },
  ];

  document.addEventListener('DOMContentLoaded', async () => {
    
    if (window.lucide) lucide.createIcons();
    
    if (window.tippy) tippy('[data-tippy-content]', { theme: 'translucent', delay: [200, 0] });

    const res = await fetch('/auth/me');
    S.user = await res.json();
    S.tier = S.user.tierLevel || 0;
    if (!S.user.authenticated || S.tier < 1) {
      showLanding();
      // Non-guild member: swap button to open invite in new tab + poll for join
      if (S.user.authenticated && S.tier < 1) {
        var authBtn = $('#landing-auth-btn');
        if (authBtn) {
          authBtn.innerHTML = '<svg width="18" height="14" viewBox="0 0 71 55" fill="currentColor"><path d="M60.1 4.9A58.5 58.5 0 0045.4.2a.2.2 0 00-.2.1 40.7 40.7 0 00-1.8 3.7c-5.5-.8-11-.8-16.3 0A37.3 37.3 0 0025.3.3a.2.2 0 00-.2-.1A58.4 58.4 0 0010.4 4.9a.2.2 0 00-.1.1C1.5 18.7-.9 32 .3 45.1v.1a58.8 58.8 0 0017.8 9 .2.2 0 00.3-.1c1.4-1.9 2.6-3.9 3.6-6a.2.2 0 00-.1-.3 38.8 38.8 0 01-5.5-2.6.2.2 0 010-.4l1.1-.9a.2.2 0 01.2 0 42 42 0 0035.8 0 .2.2 0 01.2 0l1.1.9a.2.2 0 010 .3 36.4 36.4 0 01-5.5 2.7.2.2 0 00-.1.3c1.1 2.1 2.3 4.1 3.7 6a.2.2 0 00.2.1 58.6 58.6 0 0017.9-9v-.1c1.4-15-2.3-28-9.8-39.6a.2.2 0 00-.1-.1zM23.7 37c-3.4 0-6.3-3.2-6.3-7s2.8-7 6.3-7 6.4 3.1 6.3 7-2.8 7-6.3 7zm23.2 0c-3.4 0-6.3-3.2-6.3-7s2.8-7 6.3-7 6.4 3.1 6.3 7-2.8 7-6.3 7z"/></svg> Join our Discord for full access';
          authBtn.classList.replace('bg-[#5865F2]', 'bg-accent/80');
          authBtn.classList.replace('hover:bg-[#4752C4]', 'hover:bg-accent');
          authBtn.target = '_blank';
          authBtn.rel = 'noopener';
          // href gets set below when landing API returns the invite URL
        }
        // Poll /auth/refresh every 5s — bot checks guild membership server-side
        // When user joins Discord and we detect it, auto-redirect to panel
        S._refreshPoll = setInterval(async function() {
          try {
            var r = await fetch('/auth/refresh');
            var d = await r.json();
            if (d.tierLevel >= 1) {
              clearInterval(S._refreshPoll);
              S.user = d;
              S.tier = d.tierLevel;
              showPanel();
            }
          } catch (e) { /* ignore */ }
        }, 5000);
      }
    }
    else showPanel();
  });

  function showLanding() {
    $('#landing').classList.remove('hidden');
    $('#panel').classList.add('hidden');
    const skyBg = $('#skyline-bg');
    if (skyBg) skyBg.classList.remove('panel-active');
    loadLanding();
    
    if (typeof gsap !== 'undefined') {
      gsap.fromTo('.landing-card', { opacity: 0, y: 12 }, { opacity: 1, y: 0, duration: 0.4, ease: 'power2.out' });
    }
  }

  async function loadLanding() {
    try {
      const r = await fetch('/api/landing');
      const d = await r.json();
      const p = d.primary;

      // Hero header — combined status across all servers
      var anyOnline = p.status === 'online';
      if (d.servers) for (var ci = 0; ci < d.servers.length; ci++) { if (d.servers[ci].status === 'online') anyOnline = true; }
      const dot = $('#ls-status-dot');
      const txt = $('#ls-status-text');
      dot.className = 'landing-status-dot ' + (anyOnline ? 'online' : 'offline');
      txt.textContent = anyOnline ? 'Online' : 'Offline';
      txt.className = 'text-xs ' + (anyOnline ? 'text-calm' : 'text-muted');

      // Build unified server list: primary first, then additional
      var allServers = [];
      allServers.push({
        name: p.name || 'Primary Server',
        status: p.status,
        onlineCount: p.onlineCount,
        maxPlayers: p.maxPlayers,
        totalPlayers: p.totalPlayers,
        gameDay: p.gameDay,
        season: p.season,
        gameTime: p.gameTime,
        host: p.host,
        gamePort: p.gamePort,
        schedule: d.schedule || null,
      });
      if (d.servers) {
        for (var ai = 0; ai < d.servers.length; ai++) allServers.push(d.servers[ai]);
      }

      // Render server cards
      var container = $('#server-cards');
      container.innerHTML = '';
      for (var si = 0; si < allServers.length; si++) {
        var s = allServers[si];
        var sOn = s.status === 'online';
        var stale = s.status === 'stale';
        var statusLabel = sOn ? 'Online' : stale ? 'Stale' : 'Offline';
        var statusColor = sOn ? 'bg-calm' : stale ? 'bg-yellow-500' : 'bg-muted';
        var statusText = sOn ? 'text-calm' : stale ? 'text-yellow-500' : 'text-muted';
        var addr = s.host ? (s.gamePort ? s.host + ':' + s.gamePort : s.host) : '';
        var card = el('div', 'server-card');

        var html = '<div class="server-card-header">';
        html += '<span class="server-card-dot ' + statusColor + (sOn ? ' pulse-dot' : '') + '"></span>';
        html += '<span class="server-card-name">' + esc(s.name) + '</span>';
        html += '<span class="server-card-status ' + statusText + '">' + statusLabel + '</span>';
        html += '</div>';

        // Stats row
        html += '<div class="server-card-stats">';
        html += '<span>' + (sOn ? s.onlineCount : '-') + '</span><span class="text-muted/50">/</span><span>' + (s.maxPlayers || '?') + '</span>';
        html += '<span class="text-muted/50">players</span>';
        html += '<span class="text-border">&middot;</span><span>' + (s.totalPlayers || 0) + ' total</span>';
        html += '</div>';

        // World info
        if (s.gameDay != null) {
          var wp = [];
          if (s.gameTime) wp.push(s.gameTime);
          var dps = s.daysPerSeason || 28, seasonNames = ['Spring', 'Summer', 'Autumn', 'Winter'];
          var seasonNum = Math.floor((s.gameDay % (dps * 4)) / dps);
          var dayInSeason = (s.gameDay % dps) + 1;
          var year = Math.floor(s.gameDay / (dps * 4)) + 1;
          wp.push('Day ' + dayInSeason + ' ' + (s.season || seasonNames[seasonNum]) + ', Year ' + year);
          html += '<div class="server-card-world">' + wp.join(' · ') + '</div>';
        }

        // Address
        if (addr) html += '<div class="server-card-addr">' + esc(addr) + '</div>';

        // Schedule (embedded in card)
        var sched = s.schedule;
        if (sched && sched.active) {
          html += '<div class="server-card-schedule">';
          html += '<div class="server-card-schedule-header">';
          html += '<span class="text-[10px] font-heading font-semibold text-text-bright uppercase tracking-wider">Schedule</span>';
          if (sched.timezone) html += '<span class="text-[9px] text-muted font-mono">' + esc(sched.timezone) + '</span>';
          html += '</div>';
          html += '<div class="server-card-schedule-list" data-server-idx="' + si + '"></div>';
          if (sched.nextRestart) {
            var mins = sched.minutesUntilRestart;
            var hrs = Math.floor(mins / 60);
            var m = mins % 60;
            var untilStr = hrs > 0 ? hrs + 'h ' + m + 'm' : m + 'm';
            html += '<div class="text-[10px] text-muted mt-1.5">Next transition in ' + untilStr + ' at ' + sched.nextRestart + '</div>';
          }
          if (sched.rotateDaily) {
            html += '<div class="text-[9px] text-muted/40 mt-0.5">Schedule rotates daily</div>';
          }
          html += '</div>';
        }

        card.innerHTML = html;
        container.appendChild(card);

        // Render schedule slots into the card's schedule list container (needs DOM element)
        if (sched && sched.active) {
          var schedList = card.querySelector('.server-card-schedule-list');
          if (schedList) {
            renderSchedule(schedList, sched, 'landing');
            if (sched.rotateDaily && sched.tomorrowSchedule) {
              renderTomorrowSchedule(schedList, sched);
            }
          }
        }

        // Store primary schedule for dashboard reuse
        if (si === 0 && sched && sched.active) S.scheduleData = sched;
      }

      var discordLink = $('#link-discord');
      if (discordLink) {
        var inviteUrl = p.discordInvite || '';
        if (inviteUrl) {
          var fullUrl = inviteUrl.startsWith('http') ? inviteUrl : 'https://' + inviteUrl;
          discordLink.href = fullUrl;
          $('#landing-links').classList.remove('hidden');
          // Update auth button for non-guild members to point to invite
          var authBtn = $('#landing-auth-btn');
          if (authBtn && S.user.authenticated && S.tier < 1) authBtn.href = fullUrl;
        } else {
          $('#landing-links').classList.remove('hidden');
          discordLink.style.display = 'none';
          if (discordLink.nextElementSibling) discordLink.nextElementSibling.remove();
        }
      }
    } catch (e) {
      console.error('Landing fetch error:', e);
      $('#ls-status-text').textContent = 'Error';
    }
  }

  function showPanel() {
    if (S._refreshPoll) { clearInterval(S._refreshPoll); S._refreshPoll = null; }
    $('#landing').classList.add('hidden');
    $('#panel').classList.remove('hidden');
    const skyBg = $('#skyline-bg');
    if (skyBg) skyBg.classList.add('panel-active');

    if (typeof gsap !== 'undefined') {
      gsap.fromTo('#sidebar', { x: -12, opacity: 0 }, { x: 0, opacity: 1, duration: 0.25, ease: 'power2.out' });
    }

    if (S.user.avatar) {
      var av = $('#user-avatar');
      av.src = S.user.avatar;
      av.classList.remove('hidden');
    }
    $('#user-name').textContent = S.user.displayName || S.user.username || '-';
    $('#user-tier').textContent = S.user.tier || '-';

    $$('[data-min-tier]').forEach(function(el) {
      var min = parseInt(el.dataset.minTier, 10);
      if (S.tier < min) el.classList.add('tier-hidden');
    });

    var userBlock = $('#user-block');
    if (userBlock && S.tier >= 3) userBlock.addEventListener('click', toggleViewMode);

    $$('.nav-link').forEach(function(link) {
      link.addEventListener('click', function(e) {
        e.preventDefault();
        if (link.classList.contains('tier-hidden')) return;
        switchTab(link.dataset.tab);
      });
    });

    setupCopyBtn('#copy-address-btn', '#landing-address');
    setupCopyBtn('#d-copy-btn', '#d-address');

    var chatSendBtn = $('#chat-send-btn');
    if (chatSendBtn) {
      chatSendBtn.addEventListener('click', function() { sendChat(); });
      var chatInput = $('#chat-msg-input');
      if (chatInput) chatInput.addEventListener('keydown', function(e) { if (e.key === 'Enter') sendChat(); });
    }
    var chatSearchInput = $('#chat-search');
    if (chatSearchInput) chatSearchInput.addEventListener('input', debounce(loadChat, 400));

    var rconSendBtn = $('#rcon-send-btn');
    if (rconSendBtn) {
      rconSendBtn.addEventListener('click', function() { sendRcon(); });
      var rconInput = $('#rcon-input');
      if (rconInput) rconInput.addEventListener('keydown', handleConsoleKeydown);
    }
    var clearBtn = $('#console-clear-btn');
    if (clearBtn) clearBtn.addEventListener('click', function() {
      S.consoleBuf = [];
      var out = $('#console-output');
      if (out) out.innerHTML = '<div class="console-line sys">Console cleared</div>';
    });

    var cmdBtn = $('#cmd-helper-btn');
    var cmdList = $('#cmd-helper-list');
    if (cmdBtn && cmdList) {
      cmdBtn.addEventListener('click', function() { cmdList.classList.toggle('hidden'); });
      document.addEventListener('click', function(e) {
        var wrap = $('#cmd-helper-wrap');
        if (wrap && !wrap.contains(e.target)) cmdList.classList.add('hidden');
      });
      $$('.cmd-item', cmdList).forEach(function(item) {
        item.addEventListener('click', function() {
          var input = $('#rcon-input');
          if (input) { input.value = item.dataset.cmd; input.focus(); }
          cmdList.classList.add('hidden');
        });
      });
    }

    var acWrap = $('#console-autocomplete');
    if (acWrap) {
      acWrap.addEventListener('click', function(e) {
        var item = e.target.closest('.cmd-item');
        if (!item) return;
        var input = $('#rcon-input');
        if (input) { input.value = item.dataset.cmd; input.focus(); }
        hideConsoleAutocomplete();
      });
    }

    $$('[data-action]').forEach(function(btn) {
      if (btn.classList.contains('quick-cmd')) return;
      btn.addEventListener('click', function() { doPowerAction(btn.dataset.action); });
    });

    var mapRefreshBtn = $('#map-refresh-btn');
    if (mapRefreshBtn) mapRefreshBtn.addEventListener('click', refreshMapSnapshot);

    $$('.quick-cmd[data-cmd]').forEach(function(btn) {
      btn.addEventListener('click', async function() {
        try {
          var r = await apiFetch('/api/panel/rcon', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command: btn.dataset.cmd }) });
          var d = await r.json();
          appendConsole(btn.dataset.cmd, 'cmd');
          appendConsole(d.response || d.error || 'No response', d.ok ? 'resp' : 'err');
        } catch (e) { appendConsole('Error: ' + e.message, 'err'); }
      });
    });

    var ps = $('#player-search');
    if (ps) ps.addEventListener('input', renderPlayers);
    var pso = $('#player-sort');
    if (pso) pso.addEventListener('change', renderPlayers);

    var pvTable = $('#player-view-table');
    var pvCards = $('#player-view-cards');
    if (pvTable) pvTable.addEventListener('click', function() {
      S.playerViewMode = 'table';
      pvTable.className = 'p-1.5 rounded text-accent bg-accent/10 border border-accent/20';
      if (pvCards) pvCards.className = 'p-1.5 rounded text-muted hover:text-text transition-colors';
      renderPlayers();
    });
    if (pvCards) pvCards.addEventListener('click', function() {
      S.playerViewMode = 'cards';
      if (pvTable) pvTable.className = 'p-1.5 rounded text-muted hover:text-text transition-colors';
      pvCards.className = 'p-1.5 rounded text-accent bg-accent/10 border border-accent/20';
      renderPlayers();
    });

    var pmc = $('#player-modal-close');
    if (pmc) pmc.addEventListener('click', function() { var m = $('#player-modal'); if (m) m.classList.add('hidden'); setBreadcrumbs([{ label: TAB_LABELS[S.currentTab] || S.currentTab }]); });
    var pm = $('#player-modal');
    if (pm) pm.addEventListener('click', function(e) { if (e.target.id === 'player-modal') { e.target.classList.add('hidden'); setBreadcrumbs([{ label: TAB_LABELS[S.currentTab] || S.currentTab }]); } });

    var mdc = $('#map-detail-close');
    if (mdc) mdc.addEventListener('click', function() { var p = $('#map-player-detail'); if (p) p.classList.add('hidden'); });

    var ms = $('#map-search');
    if (ms) ms.addEventListener('input', filterMapPlayers);
    var mso = $('#map-show-offline');
    if (mso) mso.addEventListener('change', function() { updateMapMarkers(); filterMapPlayers(); });

    ['structures', 'vehicles', 'containers', 'companions'].forEach(function(layer) {
      var cb = $('#map-layer-' + layer);
      if (cb) cb.addEventListener('change', function() { loadMapData(); });
    });

    // Activity category pills
    var pills = $$('.activity-pill');
    pills.forEach(function(pill) {
      pill.addEventListener('click', function() {
        pills.forEach(function(p) { p.classList.remove('active'); });
        pill.classList.add('active');
        S.activityCategory = pill.dataset.category || '';
        resetActivityPaging();
        loadActivity();
      });
    });
    var as = $('#activity-search');
    if (as) as.addEventListener('input', debounce(function() { resetActivityPaging(); loadActivity(); }, 300));
    var ad = $('#activity-date');
    if (ad) ad.addEventListener('change', function() { resetActivityPaging(); loadActivity(); });
    // Charts toggle
    var actChartToggle = $('#activity-toggle-charts');
    if (actChartToggle) actChartToggle.addEventListener('click', function() {
      var panel = $('#activity-charts-panel');
      if (panel) {
        var show = panel.classList.toggle('hidden');
        if (!show && !S.activityChartsLoaded) { loadActivityStats(); S.activityChartsLoaded = true; }
      }
    });

    // Fingerprint tracker controls
    var fpClose = $('#fp-close');
    if (fpClose) fpClose.addEventListener('click', function() {
      hideFingerprintTracker();
      var searchEl = $('#activity-search');
      if (searchEl) {
        // Strip the #fingerprint part, keep just the item name
        var val = searchEl.value;
        var hashIdx = val.indexOf('#');
        if (hashIdx > -1) { searchEl.value = val.slice(0, hashIdx); resetActivityPaging(); loadActivity(); }
      }
    });
    var fpLimit = $('#fp-limit');
    if (fpLimit) fpLimit.addEventListener('change', function() {
      // Re-trigger the tracker with updated limit
      var searchEl = $('#activity-search');
      if (searchEl) {
        var val = searchEl.value;
        var fpMatch = val.match(/^(.+)#([a-f0-9]{6,})$/i);
        if (fpMatch) showFingerprintTracker(fpMatch[1].trim(), fpMatch[2].trim());
      }
    });

    var cs = $('#clan-search');
    if (cs) cs.addEventListener('input', debounce(loadClans, 300));
    var cso = $('#clan-sort');
    if (cso) cso.addEventListener('change', loadClans);

    var ss = $('#settings-search');
    if (ss) ss.addEventListener('input', filterSettings);
    var sb = $('#settings-save-btn');
    if (sb) sb.addEventListener('click', showSettingsDiff);
    var srb = $('#settings-reset-btn');
    if (srb) srb.addEventListener('click', resetSettingsChanges);

    var sdc = $('#settings-diff-close');
    if (sdc) sdc.addEventListener('click', function() { $('#settings-diff-modal').classList.add('hidden'); });
    var sdCancel = $('#settings-diff-cancel');
    if (sdCancel) sdCancel.addEventListener('click', function() { $('#settings-diff-modal').classList.add('hidden'); });
    var sdConfirm = $('#settings-diff-confirm');
    if (sdConfirm) sdConfirm.addEventListener('click', function() { $('#settings-diff-modal').classList.add('hidden'); commitSettings(); });
    var sdModal = $('#settings-diff-modal');
    if (sdModal) sdModal.addEventListener('click', function(e) { if (e.target === sdModal) sdModal.classList.add('hidden'); });

    // Settings mode toggle (Game Server / Bot Config)
    $$('.settings-mode-btn').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var mode = btn.dataset.mode;
        if (mode === S.settingsMode) return;
        S.settingsMode = mode;
        $$('.settings-mode-btn').forEach(function(b) { b.classList.toggle('active', b.dataset.mode === mode); });
        var searchEl = $('#settings-search');
        if (searchEl) searchEl.value = '';
        var restartBadge = $('#settings-restart-badge');
        if (restartBadge) restartBadge.classList.add('hidden');
        if (mode === 'game') { loadSettings(); }
        else { loadBotConfig(); }
      });
    });

    var dbt = $('#db-table');
    if (dbt) dbt.addEventListener('change', function() { loadDatabase(); showDbSchema(); });
    var dbs = $('#db-search');
    if (dbs) dbs.addEventListener('input', debounce(loadDatabase, 300));
    var dbl = $('#db-limit');
    if (dbl) dbl.addEventListener('change', loadDatabase);
    var dbCsv = $('#db-export-csv');
    if (dbCsv) dbCsv.addEventListener('click', exportDbCsv);

    // DB mode toggle (Browse / Query)
    $$('#db-mode-browse, #db-mode-query').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var mode = btn.dataset.mode;
        S.dbMode = mode;
        $$('#db-mode-browse, #db-mode-query').forEach(function(b) { b.classList.toggle('active', b.dataset.mode === mode); });
        var browsePanel = $('#db-browse-panel');
        var queryPanel = $('#db-query-panel');
        if (browsePanel) browsePanel.classList.toggle('hidden', mode !== 'browse');
        if (queryPanel) queryPanel.classList.toggle('hidden', mode !== 'query');
      });
    });

    // Query builder event wiring
    var qbTable = $('#qb-table');
    if (qbTable) qbTable.addEventListener('change', function() { updateQbColumns(); updateQbPreview(); });
    var qbCols = $('#qb-columns');
    if (qbCols) qbCols.addEventListener('input', updateQbPreview);
    var qbWhereCol = $('#qb-where-col');
    if (qbWhereCol) qbWhereCol.addEventListener('change', updateQbPreview);
    var qbWhereOp = $('#qb-where-op');
    if (qbWhereOp) qbWhereOp.addEventListener('change', updateQbPreview);
    var qbWhereVal = $('#qb-where-val');
    if (qbWhereVal) qbWhereVal.addEventListener('input', updateQbPreview);
    var qbOrderCol = $('#qb-order-col');
    if (qbOrderCol) qbOrderCol.addEventListener('change', updateQbPreview);
    var qbOrderDir = $('#qb-order-dir');
    if (qbOrderDir) qbOrderDir.addEventListener('change', updateQbPreview);
    var qbLimit = $('#qb-limit');
    if (qbLimit) qbLimit.addEventListener('input', updateQbPreview);
    var qbRun = $('#qb-run');
    if (qbRun) qbRun.addEventListener('click', runQueryBuilder);
    var qbCopy = $('#qb-copy-sql');
    if (qbCopy) qbCopy.addEventListener('click', function() { var sql = buildQbSql(); navigator.clipboard.writeText(sql).then(function() { showToast('SQL copied'); }); });
    var rawRun = $('#db-raw-run');
    if (rawRun) rawRun.addEventListener('click', runRawSql);
    var rawInput = $('#db-raw-sql');
    if (rawInput) rawInput.addEventListener('keydown', function(e) { if (e.key === 'Enter') runRawSql(); });

    // Populate DB table dropdowns
    var dbSelect = $('#db-table');
    if (dbSelect) {
      dbSelect.innerHTML = '';
      for (var i = 0; i < DB_TABLES.length; i++) {
        var opt = document.createElement('option');
        opt.value = DB_TABLES[i].value;
        opt.textContent = DB_TABLES[i].label;
        dbSelect.appendChild(opt);
      }
    }
    var qbTableSelect = $('#qb-table');
    if (qbTableSelect) {
      qbTableSelect.innerHTML = '';
      for (var i = 0; i < DB_TABLES.length; i++) {
        var opt2 = document.createElement('option');
        opt2.value = DB_TABLES[i].value;
        opt2.textContent = DB_TABLES[i].label;
        qbTableSelect.appendChild(opt2);
      }
    }
    // Try to fetch live table list with row counts (overrides static list)
    fetchDbTableList();

    loadPlayersInBackground();
    loadServerList();

    switchTab('dashboard');
  }

  /** Load server list and populate the server selector dropdown */
  async function loadServerList() {
    try {
      var r = await fetch('/api/servers');
      if (!r.ok) return;
      var d = await r.json();
      S.multiServer = d.multiServer || false;
      if (!S.multiServer || !d.servers || d.servers.length <= 1) return;

      var sel = $('#server-select');
      var wrap = $('#server-selector');
      if (!sel || !wrap) return;

      sel.innerHTML = '';
      for (var i = 0; i < d.servers.length; i++) {
        var opt = document.createElement('option');
        opt.value = d.servers[i].id;
        opt.textContent = d.servers[i].name;
        sel.appendChild(opt);
      }
      sel.value = S.currentServer;
      wrap.classList.remove('hidden');

      sel.addEventListener('change', function() {
        S.currentServer = sel.value;
        // Reset cached data
        S.players = [];
        S.dashHistory = { online: [], events: [] };
        Object.keys(S.sparkCharts).forEach(function(k) {
          if (S.sparkCharts[k]) { S.sparkCharts[k].destroy(); delete S.sparkCharts[k]; }
        });
        S.settingsOriginal = {};
        S.settingsChanged = {};
        S.mapReady = false;
        // Reload current tab
        loadPlayersInBackground();
        switchTab(S.currentTab);
      });
    } catch (e) { /* non-critical */ }
  }

  async function loadPlayersInBackground() {
    try {
      var r = await apiFetch('/api/players');
      if (!r.ok) return;
      var d = await r.json();
      S.players = d.players || [];
      S.toggles = d.toggles || {};
      S.worldBounds = d.worldBounds || null;
    } catch (e) {  }
  }

  function toggleViewMode() {
    if (S.tier < 3) return;
    S.viewMode = S.viewMode === 'admin' ? 'survivor' : 'admin';
    var badge = $('#view-mode-badge');
    if (badge) badge.classList.toggle('hidden', S.viewMode === 'admin');
    $$('[data-min-tier]').forEach(function(el) {
      var min = parseInt(el.dataset.minTier, 10);
      var effectiveTier = S.viewMode === 'survivor' ? 1 : S.tier;
      if (effectiveTier < min) el.classList.add('tier-hidden');
      else el.classList.remove('tier-hidden');
    });
  }

  var TAB_LABELS = { dashboard:'Dashboard', map:'Live Map', timeline:'Timeline', players:'Players', clans:'Clans', activity:'Activity', chat:'Chat', items:'Items', console:'Console', settings:'Settings', controls:'Controls', database:'Database', anticheat:'Anticheat' };
  S.breadcrumbs = [];

  function setBreadcrumbs(crumbs) {
    S.breadcrumbs = crumbs;
    var bars = $$('.breadcrumb-bar');
    bars.forEach(function(bar) {
      if (!crumbs || crumbs.length <= 1) { bar.innerHTML = ''; return; }
      var html = '';
      for (var i = 0; i < crumbs.length; i++) {
        if (i > 0) html += '<span class="breadcrumb-sep"></span>';
        var isLast = i === crumbs.length - 1;
        if (isLast) {
          html += '<span class="breadcrumb-item current">' + esc(crumbs[i].label) + '</span>';
        } else {
          html += '<span class="breadcrumb-item" data-action="' + esc(crumbs[i].action || '') + '">' + esc(crumbs[i].label) + '</span>';
        }
      }
      bar.innerHTML = html;
    });
  }

  document.addEventListener('click', function(e) {
    var bc = e.target.closest('.breadcrumb-item:not(.current)');
    if (!bc) return;
    var action = bc.dataset.action;
    if (action === 'tab') {
      
      setBreadcrumbs([{ label: TAB_LABELS[S.currentTab] || S.currentTab }]);
      
      var pm = $('#player-modal'); if (pm) pm.classList.add('hidden');
      var idm = $('#item-detail-modal'); if (idm) idm.classList.add('hidden');
    } else if (action && action.startsWith('switchTab:')) {
      switchTab(action.split(':')[1]);
    }
  });

  function switchTab(tab) {
    S.currentTab = tab;
    setBreadcrumbs([{ label: TAB_LABELS[tab] || tab }]);
    $$('.tab-content').forEach(function(s) { s.classList.add('hidden'); });
    var tabEl = $('#tab-' + tab);
    if (tabEl) {
      tabEl.classList.remove('hidden');
      
      if (typeof gsap !== 'undefined') {
        gsap.fromTo(tabEl, { opacity: 0 }, { opacity: 1, duration: 0.15, ease: 'power2.out' });
      }
    }
    $$('.nav-link').forEach(function(l) { l.classList.toggle('active', l.dataset.tab === tab); });

    S.pollTimers.forEach(clearInterval);
    S.pollTimers = [];

    switch (tab) {
      case 'dashboard': loadDashboard(); S.pollTimers.push(setInterval(loadDashboard, 30000)); break;
      case 'map': initMap(); loadMapData(); S.pollTimers.push(setInterval(loadMapData, 15000)); break;
      case 'players': loadPlayers(); break;
      case 'clans': loadClans(); break;
      case 'activity': loadActivity(); if (!S.activityChartsLoaded) { loadActivityStats(); S.activityChartsLoaded = true; } break;
      case 'chat': loadChat(); S.pollTimers.push(setInterval(loadChat, 8000)); break;
      case 'settings': if (S.settingsMode === 'bot') loadBotConfig(); else loadSettings(); break;
      case 'controls': loadBackupList(); break;
      case 'database': loadDatabase(); break;
      case 'items': loadItems(); break;
      case 'timeline': initTimeline(); break;
      case 'anticheat': loadAnticheat(); break;
    }
  }

  function renderSparkline(canvasId, data, color) {
    var canvas = $('#' + canvasId);
    if (!canvas || !window.Chart) return;
    if (S.sparkCharts[canvasId]) {
      S.sparkCharts[canvasId].data.labels = data.map(function(_, i) { return i; });
      S.sparkCharts[canvasId].data.datasets[0].data = data;
      S.sparkCharts[canvasId].update('none');
      return;
    }
    S.sparkCharts[canvasId] = new Chart(canvas, {
      type: 'line',
      data: {
        labels: data.map(function(_, i) { return i; }),
        datasets: [{
          data: data,
          borderColor: color,
          borderWidth: 1.5,
          pointRadius: 0,
          tension: 0.3,
          fill: { target: 'origin', above: color + '15' },
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        resizeDelay: 0,
        animation: false,
        plugins: { legend: { display: false }, tooltip: { enabled: false } },
        scales: {
          x: { display: false },
          y: { display: false, beginAtZero: true }
        },
        layout: { padding: 0 },
        elements: { line: { borderCapStyle: 'round' } }
      }
    });
  }

  async function loadDashboard() {
    try {
      var results = await Promise.all([apiFetch('/api/panel/status'), apiFetch('/api/panel/stats')]);
      var status = results[0].ok ? await results[0].json() : {};
      var stats = results[1].ok ? await results[1].json() : {};

      var isOn = status.serverState === 'running';
      var stEl = $('#d-status');
      if (stEl) {
        if (status.serverState) { stEl.textContent = isOn ? 'Online' : 'Offline'; stEl.style.color = isOn ? '#6dba82' : '#c45a4a'; }
        else { stEl.textContent = '-'; stEl.style.color = ''; }
      }

      var onEl = $('#d-online');
      if (onEl) onEl.textContent = stats.onlinePlayers != null ? stats.onlinePlayers + ' / ' + (status.maxPlayers || '?') : '-';

      var totEl = $('#d-total');
      if (totEl) {
        if (stats.totalPlayers != null) {
          var offline = (stats.totalPlayers || 0) - (stats.onlinePlayers || 0);
          totEl.textContent = stats.totalPlayers + ' (' + offline + ' offline)';
        } else { totEl.textContent = '-'; }
      }

      var wEl = $('#d-world');
      if (wEl) {
        var parts = [];
        if (status.gameTime) parts.push(status.gameTime);
        if (status.gameDay != null) {
          var dps = status.daysPerSeason || 28;
          var dayInSeason = (status.gameDay % dps) + 1;
          var year = Math.floor(status.gameDay / (dps * 4)) + 1;
          var seasonNames = ['Spring', 'Summer', 'Autumn', 'Winter'];
          var seasonNum = Math.floor((status.gameDay % (dps * 4)) / dps);
          parts.push('Day ' + dayInSeason + ' of ' + (status.season || seasonNames[seasonNum]));
          parts.push('Year ' + year);
        }
        wEl.textContent = parts.length ? parts.join(' \u00b7 ') : '-';
      }

      var evEl = $('#d-events');
      if (evEl) evEl.textContent = fmtNum(stats.eventsToday || 0);

      var maxPts = 20;
      S.dashHistory.online.push(stats.onlinePlayers || 0);
      S.dashHistory.events.push(stats.eventsToday || 0);
      if (S.dashHistory.online.length > maxPts) S.dashHistory.online.shift();
      if (S.dashHistory.events.length > maxPts) S.dashHistory.events.shift();
      if (window.Chart && S.dashHistory.online.length > 1) {
        renderSparkline('spark-online', S.dashHistory.online, '#6dba82');
        renderSparkline('spark-events', S.dashHistory.events, '#d4915c');
      }

      var tzEl = $('#d-tz');
      if (tzEl && status.timezone) tzEl.textContent = status.timezone;

      try {
        var landing = await fetch('/api/landing');
        var ld = await landing.json();
        // Find the correct server's connect info based on current selection
        var srvData = null;
        if (S.currentServer === 'primary') {
          srvData = ld.primary;
        } else if (ld.servers) {
          for (var si = 0; si < ld.servers.length; si++) {
            if (ld.servers[si].id === S.currentServer) { srvData = ld.servers[si]; break; }
          }
        }
        if (!srvData) srvData = ld.primary;
        if (srvData.host) {
          var addr = srvData.gamePort ? srvData.host + ':' + srvData.gamePort : srvData.host;
          var dAddr = $('#d-address');
          if (dAddr) dAddr.textContent = addr;
          var dc = $('#dashboard-connect');
          if (dc) dc.classList.remove('hidden');
        }
      } catch (e) {  }

      try {
        var schedRes = await apiFetch('/api/panel/scheduler');
        var sched = await schedRes.json();
        if (sched.active) {
          S.scheduleData = sched;
          var sc = $('#schedule-card');
          if (sc) sc.classList.remove('hidden');
          renderSchedule($('#schedule-info'), sched, 'dashboard');
          if (sched.rotateDaily && sched.tomorrowSchedule) {
            renderTomorrowSchedule($('#schedule-info'), sched);
          }
        }
      } catch (e) {  }

      if (status.resources && S.tier >= 3 && S.viewMode === 'admin') {
        var rc = $('#resources-card');
        if (rc) rc.classList.remove('hidden');
        renderResources(status.resources, status.uptime);
      }

      try {
        var feeds = await Promise.all([apiFetch('/api/panel/activity?limit=15'), apiFetch('/api/panel/chat?limit=15')]);
        var act = await feeds[0].json();
        var chat = await feeds[1].json();
        renderActivityFeed($('#d-activity'), act.events, true);
        renderChatFeed($('#d-chat'), chat.messages, true);
      } catch (e) {  }
    } catch (e) {
      console.error('Dashboard error:', e);
    }
  }

  function renderSchedule(container, sched, context) {
    if (!container || !sched || !sched.todaySchedule) return;
    container.innerHTML = '';
    var profileSettings = sched.profileSettings || {};

    // Today header when rotation is on
    if (sched.rotateDaily) {
      var hdr = el('div', 'text-[10px] uppercase tracking-wider text-muted/50 font-semibold mt-0.5 mb-0.5');
      hdr.textContent = 'Today';
      container.appendChild(hdr);
    }

    for (var i = 0; i < sched.todaySchedule.length; i++) {
      var slot = sched.todaySchedule[i];
      var isCurrent = slot.profileName === sched.currentProfile;
      var div = el('div', 'sched-slot ' + (isCurrent ? 'active fade-in' : ''));

      var pn = slot.profileName || '';
      var colorCls = pn.includes('calm') ? 'calm' : pn.includes('surge') ? 'surge' : pn.includes('horde') ? 'horde' : '';
      // Use short label (name + PVP if applicable) for slot, full display name goes to tooltip
      var fullDisplayName = slot.profileDisplayName || pn.charAt(0).toUpperCase() + pn.slice(1);
      var parenIdx = fullDisplayName.indexOf(' (');
      var displayName = parenIdx >= 0 ? fullDisplayName.substring(0, parenIdx) : fullDisplayName;

      var inner = '<span class="sched-time">' + esc(slot.startTime) + '</span>';
      inner += '<span class="sched-name ' + colorCls + '">' + esc(displayName) + '</span>';

      if (isCurrent) {
        inner += '<span class="sched-marker">\u25C6 NOW</span>';
      } else {
        var hint = getRelativeHint(slot, sched);
        if (hint) inner += '<span class="sched-hint">' + hint + '</span>';
      }

      var ps = profileSettings[pn];
      div.innerHTML = inner;
      container.appendChild(div);

      if (ps && Object.keys(ps).length > 0 && typeof tippy !== 'undefined') {
        tippy(div, { content: buildScheduleTip(fullDisplayName, colorCls, ps), allowHTML: true, theme: 'translucent', placement: 'bottom', popperOptions: { modifiers: [{ name: 'flip', enabled: true }, { name: 'preventOverflow', options: { boundary: 'viewport' } }] }, maxWidth: 320, delay: [150, 0], appendTo: document.body });
      }
    }
  }

  function renderTomorrowSchedule(container, sched) {
    if (!container || !sched.tomorrowSchedule) return;
    var profileSettings = sched.profileSettings || {};

    var hdr = el('div', 'text-[10px] uppercase tracking-wider text-muted/50 font-semibold mt-2.5 mb-0.5');
    hdr.textContent = 'Tomorrow';
    container.appendChild(hdr);

    for (var i = 0; i < sched.tomorrowSchedule.length; i++) {
      var slot = sched.tomorrowSchedule[i];
      var div = el('div', 'sched-slot tomorrow');
      var pn = slot.profileName || '';
      var colorCls = pn.includes('calm') ? 'calm' : pn.includes('surge') ? 'surge' : pn.includes('horde') ? 'horde' : '';
      var fullDisplayName = slot.profileDisplayName || pn.charAt(0).toUpperCase() + pn.slice(1);
      var parenIdx = fullDisplayName.indexOf(' (');
      var displayName = parenIdx >= 0 ? fullDisplayName.substring(0, parenIdx) : fullDisplayName;
      div.innerHTML = '<span class="sched-time">' + esc(slot.startTime) + '</span><span class="sched-name ' + colorCls + '">' + esc(displayName) + '</span>';

      var ps = profileSettings[pn];
      container.appendChild(div);
      if (ps && Object.keys(ps).length > 0 && typeof tippy !== 'undefined') {
        tippy(div, { content: buildScheduleTip(fullDisplayName, colorCls, ps), allowHTML: true, theme: 'translucent', placement: 'bottom', popperOptions: { modifiers: [{ name: 'flip', enabled: true }, { name: 'preventOverflow', options: { boundary: 'viewport' } }] }, maxWidth: 320, delay: [150, 0], appendTo: document.body });
      }
    }
  }

  // Difficulty tooltip builder — filters noise, shows human-friendly values
  var SCHED_SKIP_KEYS = { ServerName:1, MaxPlayers:1, PVP:1 };
  var SCHED_LABELS = {
    ZombieAmountMulti: 'Zombies', ZombieDiffHealth: 'Zombie HP', ZombieDiffDamage: 'Zombie Damage',
    ZombieDiffSpeed: 'Zombie Speed', HumanAmountMulti: 'Bandits', AnimalMulti: 'Animals',
    AIEvent: 'AI Events', XpMultiplier: 'XP Multiplier', OnDeath: 'On Death',
    RarityFood: 'Food Loot', RarityDrink: 'Drink Loot', RarityMelee: 'Melee Loot',
    RarityRanged: 'Ranged Loot', RarityAmmo: 'Ammo Loot', RarityArmor: 'Armor Loot',
    RarityResources: 'Resource Loot', RarityOther: 'Other Loot',
  };
  var DIFF_LEVELS = { '1': 'Low', '2': 'Normal', '3': 'High', '4': 'Very High' };
  var RARITY_LEVELS = { '1': 'Scarce', '2': 'Normal', '3': 'Plenty', '4': 'Abundant' };
  function formatSettingVal(key, val) {
    var s = String(val).replace(/^"|"$/g, '');
    if (/^ZombieDiff/.test(key)) return DIFF_LEVELS[s] || s;
    if (/^Rarity/.test(key)) return RARITY_LEVELS[s] || s;
    if (/Multi$|Multiplier$/.test(key)) return parseFloat(s) !== 1 ? s + 'x' : '1x (default)';
    if (key === 'AIEvent') return DIFF_LEVELS[s] || s;
    if (key === 'OnDeath') { var od = { '0': 'Keep Items', '1': 'Drop Items', '2': 'Destroy Items' }; return od[s] || s; }
    return s;
  }
  function buildScheduleTip(name, colorCls, ps) {
    var accent = colorCls === 'calm' ? '#6dba82' : colorCls === 'surge' ? '#d4a843' : colorCls === 'horde' ? '#c45a4a' : '#c8c2b8';
    var h = '<div class="sched-tip"><div class="sched-tip-title" style="color:' + accent + '">' + esc(name) + '</div>';
    for (var k in ps) {
      if (!ps.hasOwnProperty(k) || SCHED_SKIP_KEYS[k]) continue;
      var label = SCHED_LABELS[k] || humanizeSettingKey(k);
      var val = formatSettingVal(k, ps[k]);
      h += '<div class="sched-tip-row"><span class="sched-tip-key">' + esc(label) + '</span><span class="sched-tip-val">' + esc(val) + '</span></div>';
    }
    h += '</div>';
    return h;
  }

  function getRelativeHint(slot, sched) {
    if (!sched.todaySchedule) return '';
    var now = minutesFromTimeStr(getCurrentTimeInTz(sched.timezone));
    var start = minutesFromTimeStr(slot.startTime);
    var diff = start - now;
    if (diff <= 0) return '';
    if (diff < 60) return 'in ' + diff + 'm';
    var h = Math.floor(diff / 60);
    var m = diff % 60;
    return m > 0 ? 'in ' + h + 'h ' + m + 'm' : 'in ' + h + 'h';
  }

  function minutesFromTimeStr(ts) {
    if (!ts) return 0;
    var parts = ts.split(':');
    return parseInt(parts[0], 10) * 60 + (parseInt(parts[1], 10) || 0);
  }

  function getCurrentTimeInTz(tz) {
    try {
      return new Date().toLocaleTimeString('en-US', { timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit' });
    } catch (e) { return new Date().toTimeString().slice(0, 5); }
  }

  function renderResources(res, uptime) {
    var container = $('#resources-info');
    if (!container) return;
    container.innerHTML = '';
    var bars = [
      { label: 'CPU', val: res.cpu, cls: 'cpu', fmt: (res.cpu || 0).toFixed(1) + '%', color: '#5b8fd4' },
      { label: 'Memory', val: res.memPercent, cls: 'mem', fmt: res.memFormatted || (res.memPercent || 0).toFixed(1) + '%', color: '#9b72cf' },
      { label: 'Disk', val: res.diskPercent, cls: 'disk', fmt: res.diskFormatted || (res.diskPercent || 0).toFixed(1) + '%', color: '#d4a843' },
    ];
    for (var i = 0; i < bars.length; i++) {
      var b = bars[i];
      var pct = Math.min(b.val || 0, 100);
      var row = el('div', 'space-y-1.5');
      row.innerHTML = '<div class="flex justify-between text-xs"><span class="text-muted">' + b.label + '</span><span class="text-gray-300 font-mono text-[11px]">' + b.fmt + '</span></div><div class="res-bar-track"><div class="res-bar-fill ' + b.cls + '" style="width:0%"></div></div>';
      container.appendChild(row);
      
      if (typeof gsap !== 'undefined') {
        var fill = row.querySelector('.res-bar-fill');
        if (fill) gsap.to(fill, { width: pct + '%', duration: 0.5, ease: 'power2.out' });
      } else {
        var fill2 = row.querySelector('.res-bar-fill');
        if (fill2) fill2.style.width = pct + '%';
      }
    }
    if (uptime) {
      var up = el('div', 'flex justify-between text-xs mt-2');
      up.innerHTML = '<span class="text-muted">Uptime</span><span class="text-gray-300 font-mono text-[11px]">' + esc(uptime) + '</span>';
      container.appendChild(up);
    }
  }

  function initMap() {
    if (S.mapReady) return;
    var container = $('#map-container');
    if (!container || !window.L) return;
    S.map = L.map(container, { crs: L.CRS.Simple, minZoom: -2, maxZoom: 3, zoomControl: true, attributionControl: false });
    var bounds = [[0, 0], [4096, 4096]];
    L.imageOverlay('/terrain.png', bounds, { className: 'map-terrain' }).addTo(S.map);
    S.map.fitBounds(bounds);
    S.mapReady = true;
  }

  async function loadMapData() {
    try {
      var r = await apiFetch('/api/players');
      if (!r.ok) return;
      var d = await r.json();
      S.players = d.players || [];
      S.toggles = d.toggles || {};
      S.worldBounds = d.worldBounds || null;
      updateMapMarkers();
      updateMapSidebar();

      var wantLayers = [];
      ['structures', 'vehicles', 'containers', 'companions', 'zombies', 'animals', 'bandits'].forEach(function(l) {
        var cb = $('#map-layer-' + l);
        if (cb && cb.checked) wantLayers.push(l);
      });
      if (wantLayers.length > 0) {
        try {
          var lr = await apiFetch('/api/panel/mapdata?layers=' + wantLayers.join(','));
          if (lr.ok) {
            var ld = await lr.json();
            updateMapWorldLayers(ld, wantLayers);
          }
        } catch(e) {  }
      } else {
        
        clearMapWorldLayers();
      }
    } catch (e) { console.error('Map data error:', e); }
  }

  var mapWorldLayers = {};

  function clearMapWorldLayers() {
    for (var k in mapWorldLayers) {
      if (mapWorldLayers[k] && S.map) S.map.removeLayer(mapWorldLayers[k]);
    }
    mapWorldLayers = {};
  }

  function updateMapWorldLayers(data, layers) {
    if (!S.map || !window.L) return;
    clearMapWorldLayers();

    if (layers.indexOf('structures') !== -1 && data.structures) {
      mapWorldLayers.structures = L.layerGroup();
      data.structures.forEach(function(s) {
        if (s.lat == null) return;
        var icon = L.divIcon({ className: '', html: '<div style="width:5px;height:5px;background:#3b82f6;border-radius:1px;border:1px solid #12100e"></div>', iconSize: [5, 5], iconAnchor: [2.5, 2.5] });
        var m = L.marker([s.lat, s.lng], { icon: icon });
        m.bindTooltip(esc(s.name || 'Structure'), { direction: 'top', offset: [0, -4] });
        var ownerName = s.owner && data.nameMap ? (data.nameMap[s.owner] || s.owner) : 'Unknown';
        var hpPct = s.maxHealth ? Math.round((s.health / s.maxHealth) * 100) : 0;
        var ownerHtml = s.owner ? '<span class="player-link" data-steam-id="' + esc(s.owner) + '">' + esc(ownerName) + '</span>' : esc(ownerName);
        var popupHtml = '<div class="tl-popup" style="min-width:160px"><b>' + entityLink(s.name || 'Structure', 'structure') + '</b>' +
          (s.upgrade ? '<br><span style="color:#7a746c">Level ' + s.upgrade + '</span>' : '') +
          '<br>\u2764\ufe0f ' + hpPct + '%' +
          '<br>\ud83d\udc64 ' + ownerHtml +
          (s.itemCount ? '<br>\ud83d\udce6 ' + s.itemCount + ' items' : '') + '</div>';
        m.bindPopup(popupHtml);
        m.addTo(mapWorldLayers.structures);
      });
      mapWorldLayers.structures.addTo(S.map);
    }

    if (layers.indexOf('vehicles') !== -1 && data.vehicles) {
      mapWorldLayers.vehicles = L.layerGroup();
      data.vehicles.forEach(function(v) {
        if (v.lat == null) return;
        var icon = L.divIcon({ className: '', html: '<div style="width:7px;height:7px;background:#d4a843;border-radius:1px;border:1px solid #12100e"></div>', iconSize: [7, 7], iconAnchor: [3.5, 3.5] });
        var m = L.marker([v.lat, v.lng], { icon: icon });
        m.bindTooltip(esc(v.name || 'Vehicle'), { direction: 'top', offset: [0, -5] });
        var hpPct = v.maxHealth ? Math.round((v.health / v.maxHealth) * 100) : 0;
        var hpColor = hpPct > 60 ? '#6dba82' : hpPct > 30 ? '#d4a843' : '#c45a4a';
        var popupHtml = '<div class="tl-popup" style="min-width:160px"><b>' + entityLink(v.name || 'Vehicle', 'vehicle') + '</b>' +
          '<br><span style="color:#7a746c">Health</span> <span style="color:' + hpColor + '">' + hpPct + '%</span>' +
          '<br>\u26fd Fuel: ' + (v.fuel || 0) + 'L</div>';
        m.bindPopup(popupHtml);
        m.addTo(mapWorldLayers.vehicles);
      });
      mapWorldLayers.vehicles.addTo(S.map);
    }

    if (layers.indexOf('containers') !== -1 && data.containers) {
      mapWorldLayers.containers = L.layerGroup();
      data.containers.forEach(function(c) {
        if (c.lat == null) return;
        var icon = L.divIcon({ className: '', html: '<div style="width:4px;height:4px;background:#a855f7;border-radius:50%;border:1px solid #12100e"></div>', iconSize: [4, 4], iconAnchor: [2, 2] });
        var m = L.marker([c.lat, c.lng], { icon: icon });
        m.bindTooltip(esc(c.name || 'Container') + ' (' + (c.itemCount || 0) + ')', { direction: 'top', offset: [0, -4] });
        var popupHtml = '<div class="tl-popup" style="min-width:140px"><b>' + entityLink(c.name || 'Container', 'container') + '</b>' +
          '<br>\ud83d\udce6 ' + (c.itemCount || 0) + ' items' +
          (c.locked ? '<br>\ud83d\udd12 Locked' : '') + '</div>';
        m.bindPopup(popupHtml);
        m.addTo(mapWorldLayers.containers);
      });
      mapWorldLayers.containers.addTo(S.map);
    }

    if (layers.indexOf('companions') !== -1 && data.companions) {
      mapWorldLayers.companions = L.layerGroup();
      data.companions.forEach(function(c) {
        if (c.lat == null) return;
        var icon = L.divIcon({ className: '', html: '<div style="width:6px;height:6px;background:#ec4899;border-radius:50%;border:1px solid #12100e"></div>', iconSize: [6, 6], iconAnchor: [3, 3] });
        var m = L.marker([c.lat, c.lng], { icon: icon });
        m.bindTooltip(esc(c.type || 'Companion'), { direction: 'top', offset: [0, -4] });
        var ownerName = c.owner && data.nameMap ? (data.nameMap[c.owner] || c.owner) : 'Unknown';
        var ownerHtml = c.owner ? '<span class="player-link" data-steam-id="' + esc(c.owner) + '">' + esc(ownerName) + '</span>' : esc(ownerName);
        var popupHtml = '<div class="tl-popup" style="min-width:140px"><b>' + entityLink(c.type || 'Companion', 'animal') + '</b>' +
          '<br>\ud83d\udc64 ' + ownerHtml +
          (c.health != null ? '<br>\u2764\ufe0f ' + Math.round(c.health) : '') + '</div>';
        m.bindPopup(popupHtml);
        m.addTo(mapWorldLayers.companions);
      });
      mapWorldLayers.companions.addTo(S.map);
    }

    if (layers.indexOf('zombies') !== -1 && data.zombies) {
      mapWorldLayers.zombies = L.layerGroup();
      data.zombies.forEach(function(z) {
        if (z.lat == null) return;
        var icon = L.divIcon({ className: 'timeline-marker', html: '<div style="width:6px;height:6px;border-radius:50%;background:#9b59b6;border:1.5px solid rgba(255,255,255,0.4);box-shadow:0 0 4px #9b59b660;" title="Zombie"></div>', iconSize: [6, 6], iconAnchor: [3, 3] });
        var m = L.marker([z.lat, z.lng], { icon: icon });
        m.bindTooltip(z.name || 'Zombie', { direction: 'top', offset: [0, -4] });
        m.addTo(mapWorldLayers.zombies);
      });
      mapWorldLayers.zombies.addTo(S.map);
    }

    if (layers.indexOf('animals') !== -1 && data.animals) {
      mapWorldLayers.animals = L.layerGroup();
      data.animals.forEach(function(a) {
        if (a.lat == null) return;
        var icon = L.divIcon({ className: 'timeline-marker', html: '<div style="width:7px;height:7px;transform:rotate(45deg);border-radius:2px;background:#e67e22;border:1.5px solid rgba(255,255,255,0.4);box-shadow:0 0 4px #e67e2260;" title="Animal"></div>', iconSize: [7, 7], iconAnchor: [3.5, 3.5] });
        var m = L.marker([a.lat, a.lng], { icon: icon });
        m.bindTooltip(a.name || 'Animal', { direction: 'top', offset: [0, -4] });
        m.addTo(mapWorldLayers.animals);
      });
      mapWorldLayers.animals.addTo(S.map);
    }

    if (layers.indexOf('bandits') !== -1 && data.bandits) {
      mapWorldLayers.bandits = L.layerGroup();
      data.bandits.forEach(function(b) {
        if (b.lat == null) return;
        var icon = L.divIcon({ className: 'timeline-marker', html: '<div style="width:8px;height:8px;border-radius:2px;background:#e74c3c;border:1.5px solid rgba(255,255,255,0.4);box-shadow:0 0 4px #e74c3c60;" title="Bandit"></div>', iconSize: [8, 8], iconAnchor: [4, 4] });
        var m = L.marker([b.lat, b.lng], { icon: icon });
        m.bindTooltip(b.name || 'Bandit', { direction: 'top', offset: [0, -4] });
        m.addTo(mapWorldLayers.bandits);
      });
      mapWorldLayers.bandits.addTo(S.map);
    }
  }

  function updateMapMarkers() {
    if (!S.map) return;
    var showOffline = true;
    var offlineChk = $('#map-show-offline');
    if (offlineChk) showOffline = offlineChk.checked;

    for (var id in S.mapMarkers) {
      S.map.removeLayer(S.mapMarkers[id]);
      delete S.mapMarkers[id];
    }

    for (var i = 0; i < S.players.length; i++) {
      var p = S.players[i];
      if (!p.hasPosition) continue;
      if (!showOffline && !p.isOnline) continue;
      if (p.lat == null || p.lng == null) continue;

      var color = p.isOnline ? '#6dba82' : '#7a746c';
      var icon = L.divIcon({
        className: '',
        html: '<div style="width:10px;height:10px;border-radius:50%;background:' + color + ';border:2px solid #12100e"></div>',
        iconSize: [10, 10], iconAnchor: [5, 5],
      });

      var marker = L.marker([p.lat, p.lng], { icon: icon }).addTo(S.map);
      marker.bindTooltip(p.name, { className: 'leaflet-tooltip-dark', offset: [8, 0] });
      (function(player) { marker.on('click', function() { showMapPlayerDetail(player); }); })(p);
      S.mapMarkers[p.steamId] = marker;
    }

    var count = S.players.filter(function(p) { return p.isOnline; }).length;
    var cEl = $('#map-player-count');
    if (cEl) cEl.textContent = count + ' online';
  }

  function updateMapSidebar() {
    var list = $('#map-player-list');
    if (!list) return;
    list.innerHTML = '';
    var sorted = S.players.slice().sort(function(a, b) {
      if (a.isOnline !== b.isOnline) return a.isOnline ? -1 : 1;
      return (a.name || '').localeCompare(b.name || '');
    });
    for (var i = 0; i < sorted.length; i++) {
      var p = sorted[i];
      var entry = el('div', 'map-player-entry');
      entry.innerHTML = '<span class="status-dot ' + (p.isOnline ? 'online' : 'offline') + '"></span><span class="mp-name player-link ' + (p.isOnline ? 'online' : '') + '" data-steam-id="' + esc(p.steamId || '') + '">' + esc(p.name) + '</span>';
      (function(player) {
        entry.addEventListener('click', function() {
          if (player.hasPosition && player.lat != null && S.map) S.map.setView([player.lat, player.lng], 1);
          showMapPlayerDetail(player);
        });
      })(p);
      list.appendChild(entry);
    }
  }

  function filterMapPlayers() {
    var q = ($('#map-search') ? $('#map-search').value : '').toLowerCase();
    $$('.map-player-entry', $('#map-player-list')).forEach(function(entry) {
      var name = entry.querySelector('.mp-name');
      var text = name ? name.textContent.toLowerCase() : '';
      entry.style.display = text.includes(q) ? '' : 'none';
    });
  }

  async function refreshMapSnapshot() {
    var btn = $('#map-refresh-btn');
    if (!btn) return;
    var origHTML = btn.innerHTML;
    btn.innerHTML = '<i data-lucide="loader" class="w-3 h-3 animate-spin"></i> Saving…';
    if (window.lucide) lucide.createIcons({ nodes: [btn] });
    btn.disabled = true;
    try {
      var r = await (typeof authFetch === 'function' ? authFetch : apiFetch)('/api/panel/refresh-snapshot', { method: 'POST' });
      if (r.ok) {
        btn.innerHTML = '<i data-lucide="check" class="w-3 h-3"></i> Done';
        if (window.lucide) lucide.createIcons({ nodes: [btn] });
        setTimeout(function() { loadMapData(); btn.innerHTML = origHTML; if (window.lucide) lucide.createIcons({ nodes: [btn] }); btn.disabled = false; }, 1000);
      } else {
        var d = await r.json().catch(function() { return {}; });
        btn.innerHTML = '<i data-lucide="x" class="w-3 h-3"></i> ' + (d.error || 'Failed');
        if (window.lucide) lucide.createIcons({ nodes: [btn] });
        setTimeout(function() { btn.innerHTML = origHTML; if (window.lucide) lucide.createIcons({ nodes: [btn] }); btn.disabled = false; }, 3000);
      }
    } catch (e) {
      btn.innerHTML = '<i data-lucide="x" class="w-3 h-3"></i> Error';
      if (window.lucide) lucide.createIcons({ nodes: [btn] });
      setTimeout(function() { btn.innerHTML = origHTML; if (window.lucide) lucide.createIcons({ nodes: [btn] }); btn.disabled = false; }, 3000);
    }
  }

  function showMapPlayerDetail(p) {
    var panel = $('#map-player-detail');
    var content = $('#map-detail-content');
    if (!panel || !content) return;
    content.innerHTML = buildPlayerDetail(p);
    content.dataset.steamId = p.steamId || '';
    panel.classList.remove('hidden');
  }

  async function loadPlayers() {
    try {
      var r = await apiFetch('/api/players');
      if (!r.ok) return;
      var d = await r.json();
      S.players = d.players || [];
      S.toggles = d.toggles || {};
      renderPlayers();
    } catch (e) { console.error('Players error:', e); }
  }

  function renderPlayers() {
    if (S.playerViewMode === 'cards') renderPlayerCards();
    else renderPlayerTable();
  }

  function renderPlayerTable() {
    var container = $('#player-list');
    if (!container) return;

    var query = ($('#player-search') ? $('#player-search').value : '').toLowerCase();
    var sort = $('#player-sort') ? $('#player-sort').value : 'online';

    var list = S.players.slice();

    if (query) {
      list = list.filter(function(p) {
        return (p.name || '').toLowerCase().includes(query) ||
          (p.steamId || '').includes(query) ||
          (p.profession || '').toLowerCase().includes(query) ||
          (p.clanName || '').toLowerCase().includes(query);
      });
    }

    list.sort(function(a, b) {
      switch (sort) {
        case 'online': return (b.isOnline ? 1 : 0) - (a.isOnline ? 1 : 0) || (a.name || '').localeCompare(b.name || '');
        case 'name': return (a.name || '').localeCompare(b.name || '');
        case 'kills': return (b.zeeksKilled || 0) - (a.zeeksKilled || 0);
        case 'playtime': return (b.totalPlaytime || 0) - (a.totalPlaytime || 0);
        case 'lastSeen': return new Date(b.lastSeen || 0) - new Date(a.lastSeen || 0);
        case 'daysSurvived': return (b.daysSurvived || 0) - (a.daysSurvived || 0);
        default: return 0;
      }
    });

    var sortCol = S.playerSort.col;
    var sortDir = S.playerSort.dir;
    if (sortCol !== 'online') {
      list.sort(function(a, b) {
        var va, vb;
        switch (sortCol) {
          case 'name': va = a.name || ''; vb = b.name || ''; return sortDir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
          case 'profession': va = a.profession || ''; vb = b.profession || ''; return sortDir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
          case 'clan': va = a.clanName || ''; vb = b.clanName || ''; return sortDir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
          case 'kills': return sortDir === 'asc' ? (a.zeeksKilled || 0) - (b.zeeksKilled || 0) : (b.zeeksKilled || 0) - (a.zeeksKilled || 0);
          case 'days': return sortDir === 'asc' ? (a.daysSurvived || 0) - (b.daysSurvived || 0) : (b.daysSurvived || 0) - (a.daysSurvived || 0);
          case 'health': var ha = a.maxHealth > 0 ? (a.health / a.maxHealth) : 0; var hb = b.maxHealth > 0 ? (b.health / b.maxHealth) : 0; return sortDir === 'asc' ? ha - hb : hb - ha;
          case 'playtime': return sortDir === 'asc' ? (a.totalPlaytime || 0) - (b.totalPlaytime || 0) : (b.totalPlaytime || 0) - (a.totalPlaytime || 0);
          default: return 0;
        }
      });
    }

    var table = el('table', 'player-table');
    var headers = [
      { key: '', label: '' }, { key: 'name', label: 'Name' }, { key: 'profession', label: 'Profession' },
      { key: 'clan', label: 'Clan' }, { key: 'kills', label: 'Kills' }, { key: 'days', label: 'Days' },
      { key: 'health', label: 'Health' }, { key: 'playtime', label: 'Playtime' }, { key: '', label: 'Steam ID' },
    ];

    var thead = el('thead');
    var headRow = el('tr');
    for (var hi = 0; hi < headers.length; hi++) {
      var h = headers[hi];
      var th = el('th');
      var arrow = sortCol === h.key ? (sortDir === 'asc' ? ' \u25B2' : ' \u25BC') : '';
      th.textContent = h.label + arrow;
      if (h.key) {
        th.style.cursor = 'pointer';
        (function(key) {
          th.addEventListener('click', function() {
            if (S.playerSort.col === key) S.playerSort.dir = S.playerSort.dir === 'asc' ? 'desc' : 'asc';
            else { S.playerSort.col = key; S.playerSort.dir = 'desc'; }
            renderPlayerTable();
          });
        })(h.key);
      }
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);

    var tbody = el('tbody');
    for (var pi = 0; pi < list.length; pi++) {
      var p = list[pi];
      var tr = el('tr', 'clickable');
      var healthPct = p.maxHealth > 0 ? Math.round((p.health / p.maxHealth) * 100) : (p.health || 0);
      var healthColor = healthPct > 60 ? '#6dba82' : healthPct > 30 ? '#d4a843' : '#c45a4a';

      tr.innerHTML = '<td><span class="status-dot ' + (p.isOnline ? 'online' : 'offline') + '"></span></td>' +
        '<td><span class="player-link">' + esc(p.name) + '</span></td>' +
        '<td class="text-muted">' + esc(p.profession || '-') + '</td>' +
        '<td class="text-muted">' + (p.clanName ? '<span class="entity-link" data-entity-table="clans" data-entity-search="' + esc(p.clanName) + '">[' + esc(p.clanName) + ']</span>' : '-') + '</td>' +
        '<td>' + fmtNum(p.zeeksKilled || 0) + '</td>' +
        '<td>' + (p.daysSurvived || 0) + '</td>' +
        '<td><span style="color:' + healthColor + '">' + healthPct + '%</span></td>' +
        '<td class="text-muted">' + formatPlaytime(p.totalPlaytime) + '</td>' +
        '<td class="font-mono text-xs text-muted"><a href="https://steamcommunity.com/profiles/' + esc(p.steamId) + '" target="_blank" class="hover:text-accent transition-colors" title="Open Steam profile">' + esc(p.steamId) + '</a></td>';
      (function(player) {
        tr.addEventListener('click', function(e) {
          if (e.target.tagName === 'A') return;
          showPlayerModal(player);
        });
      })(p);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    container.innerHTML = '';
    if (list.length === 0) {
      container.innerHTML = '<p class="text-muted text-center py-8">No players found</p>';
    } else {
      container.appendChild(table);
    }
  }

  function renderPlayerCards() {
    var container = $('#player-list');
    if (!container) return;

    var query = ($('#player-search') ? $('#player-search').value : '').toLowerCase();
    var sort = $('#player-sort') ? $('#player-sort').value : 'online';

    var list = S.players.slice();

    if (query) {
      list = list.filter(function(p) {
        return (p.name || '').toLowerCase().includes(query) ||
          (p.steamId || '').includes(query) ||
          (p.profession || '').toLowerCase().includes(query) ||
          (p.clanName || '').toLowerCase().includes(query);
      });
    }

    list.sort(function(a, b) {
      switch (sort) {
        case 'online': return (b.isOnline ? 1 : 0) - (a.isOnline ? 1 : 0) || (a.name || '').localeCompare(b.name || '');
        case 'name': return (a.name || '').localeCompare(b.name || '');
        case 'kills': return (b.zeeksKilled || 0) - (a.zeeksKilled || 0);
        case 'playtime': return (b.totalPlaytime || 0) - (a.totalPlaytime || 0);
        case 'lastSeen': return new Date(b.lastSeen || 0) - new Date(a.lastSeen || 0);
        case 'daysSurvived': return (b.daysSurvived || 0) - (a.daysSurvived || 0);
        default: return 0;
      }
    });

    var grid = el('div', 'player-cards-grid');

    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      var healthPct = p.maxHealth > 0 ? Math.round((p.health / p.maxHealth) * 100) : (p.health || 0);
      var healthColor = healthPct > 60 ? '#6dba82' : healthPct > 30 ? '#d4a843' : '#c45a4a';
      var barWidth = Math.max(0, Math.min(100, healthPct));

      var card = el('div', 'player-card');
      if (p.isOnline) card.classList.add('is-online');

      var profLabel = p.profession || 'Survivor';
      var clanTag = p.clanName ? ' <span class="pc-clan entity-link" data-entity-table="clans" data-entity-search="' + esc(p.clanName) + '">[' + esc(p.clanName) + ']</span>' : '';

      card.innerHTML =
        '<div class="pc-header">' +
          '<span class="status-dot ' + (p.isOnline ? 'online' : 'offline') + '"></span>' +
          '<span class="pc-name">' + esc(p.name) + '</span>' + clanTag +
        '</div>' +
        '<div class="pc-profession">' + esc(profLabel) + '</div>' +
        '<div class="pc-health">' +
          '<div class="pc-health-bar" style="width:' + barWidth + '%;background:' + healthColor + '"></div>' +
          '<span class="pc-health-label">' + healthPct + '%</span>' +
        '</div>' +
        '<div class="pc-stats">' +
          '<div class="pc-stat"><span class="pc-stat-val">' + fmtNum(p.zeeksKilled || 0) + '</span><span class="pc-stat-lbl">Kills</span></div>' +
          '<div class="pc-stat"><span class="pc-stat-val">' + (p.daysSurvived || 0) + '</span><span class="pc-stat-lbl">Days</span></div>' +
          '<div class="pc-stat"><span class="pc-stat-val">' + formatPlaytime(p.totalPlaytime) + '</span><span class="pc-stat-lbl">Playtime</span></div>' +
        '</div>';

      (function(player) {
        card.addEventListener('click', function() { showPlayerModal(player); });
      })(p);

      grid.appendChild(card);
    }

    container.innerHTML = '';
    if (list.length === 0) {
      container.innerHTML = '<p class="text-muted text-center py-8">No players found</p>';
    } else {
      container.appendChild(grid);
    }
  }

  function showPlayerModal(p) {
    var modal = $('#player-modal');
    var content = $('#player-modal-content');
    if (!modal || !content) return;
    content.innerHTML = buildPlayerDetail(p);
    content.dataset.steamId = p.steamId || '';
    modal.classList.remove('hidden');
    
    setBreadcrumbs([
      { label: TAB_LABELS[S.currentTab] || S.currentTab, action: 'tab' },
      { label: p.name || 'Player' }
    ]);
    
    if (typeof gsap !== 'undefined') {
      var inner = modal.querySelector('.bg-surface-100');
      if (inner) gsap.fromTo(inner, { opacity: 0, y: 12 }, { opacity: 1, y: 0, duration: 0.2, ease: 'power2.out' });
    }
  }

  function buildPlayerDetail(p) {
    var html = '';

    html += '<div class="flex items-center gap-3 mb-4">';
    html += '<span class="status-dot ' + (p.isOnline ? 'online' : 'offline') + '" style="width:10px;height:10px"></span>';
    html += '<div>';
    html += '<h2 class="text-lg font-semibold text-white">' + esc(p.name) + '</h2>';
    html += '<div class="text-xs text-muted">' + entityLink(p.profession || 'Unknown', 'item') + ' \u00b7 ' + (p.male ? 'Male' : 'Female');
    if (p.affliction && p.affliction !== 'Unknown') html += ' \u00b7 ' + entityLink(p.affliction, 'item');
    if (p.clanName) html += ' \u00b7 <span class="entity-link" data-entity-table="clans" data-entity-search="' + esc(p.clanName) + '">[' + esc(p.clanName) + ']</span>' + (p.clanRank ? ' (' + esc(p.clanRank) + ')' : '');
    html += '</div>';
    html += '<a href="https://steamcommunity.com/profiles/' + esc(p.steamId) + '" target="_blank" class="text-[11px] text-accent hover:underline font-mono">' + esc(p.steamId) + '</a>';
    html += '</div></div>';

    if (p.level || p.expCurrent) {
      var expPct = (p.expRequired > 0) ? Math.round((p.expCurrent / p.expRequired) * 100) : 0;
      html += '<div class="mb-4"><div class="flex items-center justify-between mb-1"><span class="text-xs font-medium text-muted">Level ' + (p.level || 0) + '</span>';
      html += '<span class="text-[10px] text-muted">' + fmtNum(Math.round(p.expCurrent || 0)) + ' / ' + fmtNum(Math.round(p.expRequired || 0)) + ' XP</span></div>';
      html += '<div class="vital-track"><div class="vital-fill" style="width:' + expPct + '%;background:#60a5fa"></div></div>';
      if (p.skillsPoint) html += '<div class="text-[10px] text-accent mt-0.5">' + p.skillsPoint + ' skill point' + (p.skillsPoint !== 1 ? 's' : '') + ' available</div>';
      html += '</div>';
    }

    html += '<div class="mb-4"><h3 class="text-xs font-medium text-muted uppercase tracking-wider mb-2">Kill Stats (Current Life)</h3>';
    html += '<div class="grid grid-cols-4 gap-2">';
    var killStats = [['Zombies', p.zeeksKilled], ['Headshots', p.headshots], ['Melee', p.meleeKills], ['Gun', p.gunKills], ['Blast', p.blastKills], ['Fist', p.fistKills], ['Takedown', p.takedownKills], ['Vehicle', p.vehicleKills]];
    for (var ki = 0; ki < killStats.length; ki++) {
      html += '<div class="text-center"><div class="text-sm font-semibold text-white">' + fmtNum(killStats[ki][1] || 0) + '</div><div class="text-[10px] text-muted">' + killStats[ki][0] + '</div></div>';
    }
    html += '</div></div>';

    if (p.hasExtendedStats) {
      html += '<div class="mb-4"><h3 class="text-xs font-medium text-muted uppercase tracking-wider mb-2">Lifetime Kills</h3>';
      html += '<div class="grid grid-cols-4 gap-2">';
      var ltStats = [['Total', p.lifetimeKills], ['Headshots', p.lifetimeHeadshots], ['Melee', p.lifetimeMeleeKills], ['Gun', p.lifetimeGunKills], ['Blast', p.lifetimeBlastKills], ['Fist', p.lifetimeFistKills], ['Takedown', p.lifetimeTakedownKills], ['Vehicle', p.lifetimeVehicleKills]];
      for (var li = 0; li < ltStats.length; li++) {
        html += '<div class="text-center"><div class="text-sm font-semibold text-white">' + fmtNum(ltStats[li][1] || 0) + '</div><div class="text-[10px] text-muted">' + ltStats[li][0] + '</div></div>';
      }
      html += '</div></div>';
    }

    html += '<div class="mb-4"><h3 class="text-xs font-medium text-muted uppercase tracking-wider mb-2">Survival</h3>';
    html += '<div class="grid grid-cols-4 gap-2">';
    var survStats = [
      ['Days Survived', p.daysSurvived], ['Lifetime Days', p.lifetimeDaysSurvived], ['Times Bitten', p.timesBitten], ['Fish Caught', p.fishCaught],
      ['Deaths', p.deaths], ['PvP Kills', p.pvpKills], ['PvP Deaths', p.pvpDeaths], ['Builds', p.builds],
      ['Containers', p.containersLooted], ['Raids Out', p.raidsOut], ['Raids In', p.raidsIn], ['Connects', p.connects],
    ];
    for (var si = 0; si < survStats.length; si++) {
      html += '<div class="text-center"><div class="text-sm font-semibold text-white">' + fmtNum(survStats[si][1] || 0) + '</div><div class="text-[10px] text-muted">' + survStats[si][0] + '</div></div>';
    }
    html += '</div>';
    html += '<div class="flex items-center justify-between mt-2 pt-2 border-t border-border/30 text-xs">';
    html += '<div><span class="text-muted">Playtime:</span> <span class="text-white font-medium">' + formatPlaytime(p.totalPlaytime) + '</span></div>';
    html += '<div><span class="text-muted">Last Seen:</span> <span class="text-white">' + (p.lastSeen ? new Date(p.lastSeen).toLocaleDateString() : '-') + '</span></div>';
    html += '</div></div>';

    if (S.toggles.showVitals !== false) {
      html += '<div class="mb-4"><h3 class="text-xs font-medium text-muted uppercase tracking-wider mb-2">Vitals</h3>';
      html += '<div class="space-y-1.5">';
      var vitals = [
        { label: 'Health', cur: p.health, max: p.maxHealth, color: '#6dba82' },
        { label: 'Hunger', cur: p.hunger, max: p.maxHunger, color: '#d4a843' },
        { label: 'Thirst', cur: p.thirst, max: p.maxThirst, color: '#3b82f6' },
        { label: 'Stamina', cur: p.stamina, max: p.maxStamina, color: '#a855f7' },
        { label: 'Infection', cur: p.infection, max: p.maxInfection, color: '#c45a4a' },
      ];
      if (p.battery != null) vitals.push({ label: 'Battery', cur: p.battery, max: 100, color: '#38bdf8' });
      if (p.fatigue != null) vitals.push({ label: 'Fatigue', cur: p.fatigue, max: 100, color: '#818cf8' });
      for (var vi = 0; vi < vitals.length; vi++) {
        var v = vitals[vi];
        var max = v.max || 100;
        var pct = max > 0 ? Math.round((v.cur / max) * 100) : 0;
        html += '<div class="vital-row"><span class="vital-label">' + v.label + '</span><div class="vital-track"><div class="vital-fill" style="width:' + pct + '%;background:' + v.color + '"></div></div><span class="vital-val">' + Math.round(v.cur || 0) + ' / ' + Math.round(max) + '</span></div>';
      }
      html += '</div></div>';
    }

    if ((p.playerStates && p.playerStates.length) || (p.bodyConditions && p.bodyConditions.length)) {
      html += '<div class="mb-4"><h3 class="text-xs font-medium text-muted uppercase tracking-wider mb-2">Status Effects</h3>';
      html += '<div class="flex flex-wrap gap-1">';
      var ps2 = p.playerStates || [];
      for (var psi = 0; psi < ps2.length; psi++) html += '<span class="text-[11px] bg-amber-400/10 text-amber-400 px-1.5 py-0.5 rounded entity-link" data-entity-table="game_afflictions" data-entity-search="' + esc(ps2[psi]) + '">' + esc(ps2[psi]) + '</span>';
      var bc = p.bodyConditions || [];
      for (var bci = 0; bci < bc.length; bci++) html += '<span class="text-[11px] bg-red-400/10 text-red-400 px-1.5 py-0.5 rounded entity-link" data-entity-table="game_afflictions" data-entity-search="' + esc(bc[bci]) + '">' + esc(bc[bci]) + '</span>';
      html += '</div></div>';
    }

    if (S.toggles.showInventory !== false) {
      html += buildInventorySection('Equipment', p.equipment, 'equipment');
      html += buildInventorySection('Quick Slots', p.quickSlots, 'quickslots');
      html += buildInventorySection('Inventory', p.inventory, 'storage');
      html += buildInventorySection('Backpack', p.backpackItems, 'storage');
    }

    if (S.toggles.showRecipes !== false && p.craftingRecipes && p.craftingRecipes.length) {
      html += '<div class="mb-3"><h3 class="text-xs font-medium text-muted uppercase tracking-wider mb-1.5">Crafting Recipes (' + p.craftingRecipes.length + ')</h3>';
      html += '<div class="flex flex-wrap gap-1">';
      for (var ri = 0; ri < p.craftingRecipes.length; ri++) {
        var recipeName = p.craftingRecipes[ri];
        html += '<span class="text-[10px] bg-surface-50 border border-border px-1.5 py-0.5 rounded text-muted cursor-pointer hover:text-accent hover:border-accent/40 transition-colors inv-clickable" data-item-name="' + esc(recipeName) + '">' + esc(recipeName) + '</span>';
      }
      html += '</div></div>';
    }

    if (p.unlockedSkills && p.unlockedSkills.length) {
      html += '<div class="mb-3"><h3 class="text-xs font-medium text-muted uppercase tracking-wider mb-1.5">Unlocked Skills (' + p.unlockedSkills.length + ')</h3>';
      html += '<div class="flex flex-wrap gap-1">';
      for (var ski = 0; ski < p.unlockedSkills.length; ski++) html += '<span class="text-[10px] bg-accent/10 text-accent px-1.5 py-0.5 rounded entity-link" data-entity-table="game_skills" data-entity-search="' + esc(p.unlockedSkills[ski]) + '">' + esc(p.unlockedSkills[ski]) + '</span>';
      html += '</div></div>';
    }

    if (S.toggles.showCoordinates !== false && p.hasPosition) {
      html += '<div class="mt-3 text-[11px] text-muted font-mono">Position: ' + p.worldX + ', ' + p.worldY + ', ' + p.worldZ + '</div>';
    }

    return html;
  }

  function buildInventorySection(title, items, gridType) {
    if (!items || !items.length) return '';
    var filled = items.filter(function(i) {
      if (!i) return false;
      if (typeof i === 'string') return i !== 'Empty' && i !== 'None' && i !== '';
      return i.item || i.name;
    });
    if (!filled.length) return '';

    var html = '<div class="mb-3"><h3 class="text-xs font-medium text-muted uppercase tracking-wider mb-1.5">' + title + '</h3>';
    html += '<div class="inv-grid ' + gridType + '">';

    for (var ii = 0; ii < items.length; ii++) {
      var item = items[ii];
      if (!item) { html += '<div class="inv-slot empty"><span class="inv-name">Empty</span></div>'; continue; }
      if (typeof item === 'string') {
        if (item === 'Empty' || item === 'None' || item === '') html += '<div class="inv-slot empty"><span class="inv-name">Empty</span></div>';
        else html += '<div class="inv-slot inv-clickable" data-item-name="' + esc(item) + '"><span class="inv-name">' + esc(item) + '</span></div>';
        continue;
      }
      var name = item.item || item.name || '';
      var qty = item.amount || item.quantity || 1;
      if (!name || name === 'Empty' || name === 'None') {
        html += '<div class="inv-slot empty"><span class="inv-name">Empty</span></div>';
      } else {
        var durPct = item.durability != null ? Math.round(item.durability) : null;
        var durColor = durPct != null ? (durPct > 60 ? '#6dba82' : durPct > 25 ? '#d4a843' : '#c45a4a') : '';
        var durBar = durPct != null ? '<div class="inv-dur-track"><div class="inv-dur-fill" style="width:' + durPct + '%;background:' + durColor + '"></div></div>' : '';
        var fpAttr = item.fingerprint ? ' data-item-fp="' + esc(item.fingerprint) + '"' : '';
        var ammoAttr = item.ammo ? ' data-item-ammo="' + item.ammo + '"' : '';
        var attachAttr = (item.attachments && item.attachments.length) ? ' data-item-attach="' + esc(JSON.stringify(item.attachments)) + '"' : '';
        var maxDurAttr = item.maxDur ? ' data-item-maxdur="' + item.maxDur + '"' : '';
        html += '<div class="inv-slot inv-clickable" data-item-name="' + esc(name) + '" data-item-qty="' + qty + '" data-item-dur="' + (durPct != null ? durPct : '') + '"' + fpAttr + ammoAttr + attachAttr + maxDurAttr + '><span class="inv-name">' + esc(name) + '</span>' + (qty > 1 ? '<span class="inv-qty">\u00d7' + qty + '</span>' : '') + durBar + '</div>';
      }
    }
    html += '</div></div>';
    return html;
  }

  async function loadClans() {
    var container = $('#clan-list');
    if (!container) return;

    var allClans = [];

    try {
      var r = await apiFetch('/api/panel/clans');
      if (r.ok) {
        var d = await r.json();
        allClans = d.clans || [];
      }
    } catch (e) {  }

    if (allClans.length === 0) {
      if (!S.players.length) {
        try {
          var r2 = await apiFetch('/api/players');
          if (r2.ok) { var d2 = await r2.json(); S.players = d2.players || []; }
        } catch (e) {  }
      }

      var clanMap = {};
      for (var i = 0; i < S.players.length; i++) {
        var p = S.players[i];
        var tag = p.clanName || null;
        if (!tag) continue;
        if (!clanMap[tag]) clanMap[tag] = { name: tag, members: [] };
        clanMap[tag].members.push({
          name: p.name,
          steam_id: p.steamId,
          rank: p.clanRank || '',
          is_online: p.isOnline || false,
          kills: p.kills || 0,
          deaths: p.deaths || 0,
          profession: p.profession || '',
          days_survived: p.daysSurvived || 0,
          playtime: p.playtime || 0,
        });
      }
      for (var key in clanMap) {
        if (clanMap.hasOwnProperty(key)) allClans.push(clanMap[key]);
      }
    }

    for (var ci = 0; ci < allClans.length; ci++) {
      var clan = allClans[ci];
      clan._onlineCount = 0;
      clan._totalKills = 0;
      clan._totalDeaths = 0;
      clan._totalPlaytime = 0;
      for (var mi = 0; mi < (clan.members || []).length; mi++) {
        var m = clan.members[mi];
        var player = S.players.find(function(p) { return p.steamId === m.steam_id; });
        if (player) {
          m.is_online = player.isOnline || false;
          m.kills = m.kills || player.kills || 0;
          m.deaths = m.deaths || player.deaths || 0;
          m.profession = m.profession || player.profession || '';
          m.days_survived = m.days_survived || player.daysSurvived || 0;
          m.playtime = m.playtime || player.playtime || 0;
        }
        if (m.is_online) clan._onlineCount++;
        clan._totalKills += (m.kills || 0);
        clan._totalDeaths += (m.deaths || 0);
        clan._totalPlaytime += (m.playtime || 0);
      }
    }

    var searchVal = ($('#clan-search') ? $('#clan-search').value : '').toLowerCase();
    var filtered = allClans;
    if (searchVal) {
      filtered = allClans.filter(function(c) {
        if (c.name.toLowerCase().indexOf(searchVal) !== -1) return true;
        for (var mi = 0; mi < (c.members || []).length; mi++) {
          if ((c.members[mi].name || '').toLowerCase().indexOf(searchVal) !== -1) return true;
        }
        return false;
      });
    }

    var sortVal = ($('#clan-sort') ? $('#clan-sort').value : 'members');
    filtered.sort(function(a, b) {
      if (sortVal === 'name') return (a.name || '').localeCompare(b.name || '');
      if (sortVal === 'online') return (b._onlineCount || 0) - (a._onlineCount || 0);
      if (sortVal === 'kills') return (b._totalKills || 0) - (a._totalKills || 0);
      return (b.members || []).length - (a.members || []).length; 
    });

    var totalPlayers = 0;
    var totalOnline = 0;
    var largestName = '-';
    var largestSize = 0;
    for (var si = 0; si < allClans.length; si++) {
      var sc = allClans[si];
      var ml = (sc.members || []).length;
      totalPlayers += ml;
      totalOnline += (sc._onlineCount || 0);
      if (ml > largestSize) { largestSize = ml; largestName = sc.name; }
    }
    var clsTotalEl = $('#clans-total');
    if (clsTotalEl) clsTotalEl.textContent = allClans.length;
    var clsPlayersEl = $('#clans-players');
    if (clsPlayersEl) clsPlayersEl.textContent = totalPlayers;
    var clsLargestEl = $('#clans-largest');
    if (clsLargestEl) clsLargestEl.textContent = largestSize > 0 ? '[' + largestName + '] (' + largestSize + ')' : '-';
    var clsOnlineEl = $('#clans-online');
    if (clsOnlineEl) clsOnlineEl.textContent = totalOnline;
    var clsCountEl = $('#clan-count');
    if (clsCountEl) clsCountEl.textContent = filtered.length + ' clan' + (filtered.length !== 1 ? 's' : '');

    if (filtered.length === 0) {
      container.innerHTML = '<div class="feed-empty col-span-full">No clans found. Clans appear when players form groups in-game.</div>';
      return;
    }

    container.innerHTML = '';
    for (var ci2 = 0; ci2 < filtered.length; ci2++) {
      var clan2 = filtered[ci2];
      var members2 = clan2.members || [];
      var card = el('div', 'card clan-card');
      var online2 = clan2._onlineCount || 0;

      var html = '';
      
      html += '<div class="flex items-center justify-between mb-3">';
      html += '<div>';
      html += '<h3 class="text-base font-semibold text-white">[' + esc(clan2.name) + ']</h3>';
      html += '<span class="text-xs text-muted">' + members2.length + ' member' + (members2.length !== 1 ? 's' : '');
      if (online2 > 0) html += ' · <span class="text-calm">' + online2 + ' online</span>';
      html += '</span>';
      html += '</div>';
      
      html += '<div class="flex items-center gap-1.5">';
      if (online2 > 0) html += '<span class="w-2.5 h-2.5 rounded-full bg-calm animate-pulse"></span>';
      else html += '<span class="w-2.5 h-2.5 rounded-full bg-muted/30"></span>';
      html += '</div>';
      html += '</div>';

      html += '<div class="grid grid-cols-3 gap-2 mb-3">';
      html += '<div class="text-center bg-surface-300 rounded-lg py-1.5 px-1">';
      html += '<div class="text-[10px] text-muted uppercase">Kills</div>';
      html += '<div class="text-sm font-semibold text-horde">' + (clan2._totalKills || 0) + '</div>';
      html += '</div>';
      html += '<div class="text-center bg-surface-300 rounded-lg py-1.5 px-1">';
      html += '<div class="text-[10px] text-muted uppercase">Deaths</div>';
      html += '<div class="text-sm font-semibold text-surge">' + (clan2._totalDeaths || 0) + '</div>';
      html += '</div>';
      html += '<div class="text-center bg-surface-300 rounded-lg py-1.5 px-1">';
      html += '<div class="text-[10px] text-muted uppercase">Playtime</div>';
      html += '<div class="text-sm font-semibold text-accent">' + formatPlaytimeShort(clan2._totalPlaytime || 0) + '</div>';
      html += '</div>';
      html += '</div>';

      html += '<div class="space-y-1">';
      
      members2.sort(function(a, b) {
        if (a.is_online !== b.is_online) return a.is_online ? -1 : 1;
        return (b.kills || 0) - (a.kills || 0);
      });
      for (var mi2 = 0; mi2 < members2.length; mi2++) {
        var m2 = members2[mi2];
        var displayName = m2.name || m2.steam_id || 'Unknown';
        html += '<div class="flex items-center gap-2 py-1 px-2 rounded hover:bg-surface-300/50 transition-colors group">';
        html += '<span class="status-dot ' + (m2.is_online ? 'online' : 'offline') + ' flex-shrink-0"></span>';
        html += '<span class="player-link text-sm truncate flex-1" data-steam-id="' + esc(m2.steam_id || '') + '">' + esc(displayName) + '</span>';
        if (m2.rank) html += '<span class="text-[10px] font-medium text-accent bg-accent/10 px-1.5 py-0.5 rounded flex-shrink-0">' + esc(m2.rank) + '</span>';
        if (m2.profession) html += '<span class="text-[10px] text-muted hidden group-hover:inline flex-shrink-0">' + esc(m2.profession) + '</span>';
        html += '<span class="text-[11px] text-muted ml-auto flex-shrink-0 tabular-nums">' + (m2.kills || 0) + 'K/' + (m2.deaths || 0) + 'D</span>';
        html += '</div>';
      }
      html += '</div>';

      card.innerHTML = html;
      container.appendChild(card);
    }
    
  }

  function formatPlaytimeShort(seconds) {
    if (!seconds || seconds <= 0) return '0h';
    var h = Math.floor(seconds / 3600);
    var m = Math.floor((seconds % 3600) / 60);
    if (h > 0) return h + 'h ' + m + 'm';
    return m + 'm';
  }

  var ACTIVITY_PAGE_SIZE = 100;
  var activityOffset = 0;
  var activityHasMore = false;

  function resetActivityPaging() {
    activityOffset = 0;
    activityHasMore = false;
    var container = $('#activity-feed');
    if (container) container.innerHTML = '';
    var btn = $('#activity-load-more');
    if (btn) btn.classList.add('hidden');
  }

  window.__loadMoreActivity = function() {
    loadActivity(true);
  };

  async function loadActivity(append) {
    var container = $('#activity-feed');
    if (!container) return;
    var category = S.activityCategory || '';
    var rawSearch = ($('#activity-search') ? $('#activity-search').value : '');
    var search = rawSearch.toLowerCase();
    var date = $('#activity-date') ? $('#activity-date').value : '';

    // Detect fingerprint search pattern: ItemName#abcdef123456
    var fpMatch = rawSearch.match(/^(.+)#([a-f0-9]{6,})$/i);
    if (fpMatch) {
      var fpItem = fpMatch[1].trim();
      var fpHash = fpMatch[2].trim();
      showFingerprintTracker(fpItem, fpHash);
      // Also load normal activity filtered by item name
      search = fpItem.toLowerCase();
    } else {
      hideFingerprintTracker();
    }

    if (!append) { activityOffset = 0; }
    var params = new URLSearchParams({ limit: String(ACTIVITY_PAGE_SIZE), offset: String(activityOffset) });
    if (category) params.set('type', category);
    if (search) params.set('actor', search);
    try {
      var r = await apiFetch('/api/panel/activity?' + params);
      var d = await r.json();
      var events = d.events || [];
      if (date) events = events.filter(function(e) { return (e.created_at || '').startsWith(date); });
      activityHasMore = events.length >= ACTIVITY_PAGE_SIZE;
      activityOffset += events.length;
      renderActivityFeed(container, events, false, append);
      var btn = $('#activity-load-more');
      if (btn) btn.classList.toggle('hidden', !activityHasMore);
    } catch (e) {
      if (!append) container.innerHTML = '<div class="feed-empty">Failed to load activity</div>';
    }
  }

  // ── Fingerprint Tracker ──
  function hideFingerprintTracker() {
    var panel = $('#fingerprint-tracker');
    if (panel) panel.classList.add('hidden');
  }

  async function showFingerprintTracker(itemName, fingerprint) {
    var panel = $('#fingerprint-tracker');
    if (!panel) return;

    // Show panel + loading state
    panel.classList.remove('hidden');
    if (window.lucide) lucide.createIcons({ nodes: [panel] });
    var nameEl = $('#fp-item-name');
    var hashEl = $('#fp-hash');
    var infoEl = $('#fp-instance-info');
    var ownershipEl = $('#fp-ownership');
    var chainEl = $('#fp-ownership-chain');
    var movementsEl = $('#fp-movements');
    var loadingEl = $('#fp-loading');
    var emptyEl = $('#fp-empty');

    if (nameEl) nameEl.textContent = itemName;
    if (hashEl) hashEl.textContent = '#' + fingerprint;
    if (infoEl) infoEl.innerHTML = '';
    if (chainEl) chainEl.innerHTML = '';
    if (movementsEl) movementsEl.innerHTML = '';
    if (ownershipEl) ownershipEl.classList.add('hidden');
    if (loadingEl) loadingEl.classList.remove('hidden');
    if (emptyEl) emptyEl.classList.add('hidden');

    var limit = parseInt(($('#fp-limit') || {}).value || '50', 10);

    try {
      var params = new URLSearchParams({ fingerprint: fingerprint, item: itemName });
      var r = await apiFetch('/api/panel/items/lookup?' + params);
      if (!r.ok) throw new Error('API error');
      var data = await r.json();

      if (loadingEl) loadingEl.classList.add('hidden');

      var match = data.match;
      var movements = data.movements || [];
      var ownership = data.ownershipChain || [];

      if (!match && movements.length === 0) {
        if (emptyEl) emptyEl.classList.remove('hidden');
        return;
      }

      // Render instance info badges
      if (match && infoEl) {
        var infoBadges = '';

        // Current location
        var locLabel = _fpFormatLocation(match.location_type, match.location_id);
        infoBadges += '<div class="fp-info-badge"><div class="fp-info-label">Location</div><div class="fp-info-value">' + locLabel + '</div></div>';

        // Durability
        if (match.durability != null && match.durability > 0) {
          var durPct = match.max_dur > 0 ? Math.round((match.durability / match.max_dur) * 100) : Math.round(match.durability);
          var durCol = durPct > 60 ? 'text-emerald-400' : durPct > 25 ? 'text-amber-400' : 'text-red-400';
          infoBadges += '<div class="fp-info-badge"><div class="fp-info-label">Durability</div><div class="fp-info-value ' + durCol + '">' + durPct + '%</div></div>';
        }

        // Amount
        if (match.amount > 1) {
          infoBadges += '<div class="fp-info-badge"><div class="fp-info-label">Amount</div><div class="fp-info-value">' + match.amount + '</div></div>';
        }

        // Total movements
        infoBadges += '<div class="fp-info-badge"><div class="fp-info-label">Movements</div><div class="fp-info-value">' + fmtNum(data.totalMovements || movements.length) + '</div></div>';

        // Status
        var status = match.lost ? '<span class="text-red-400">Lost</span>' : '<span class="text-emerald-400">Active</span>';
        infoBadges += '<div class="fp-info-badge"><div class="fp-info-label">Status</div><div class="fp-info-value">' + status + '</div></div>';

        // First seen
        if (match.first_seen) {
          infoBadges += '<div class="fp-info-badge"><div class="fp-info-label">First Seen</div><div class="fp-info-value text-xs">' + _fpShortDate(match.first_seen) + '</div></div>';
        }

        // Last seen
        if (match.last_seen) {
          infoBadges += '<div class="fp-info-badge"><div class="fp-info-label">Last Seen</div><div class="fp-info-value text-xs">' + _fpShortDate(match.last_seen) + '</div></div>';
        }

        // Ammo
        if (match.ammo > 0) {
          infoBadges += '<div class="fp-info-badge"><div class="fp-info-label">Ammo</div><div class="fp-info-value">' + match.ammo + '</div></div>';
        }

        infoEl.innerHTML = infoBadges;
      }

      // Render ownership chain
      if (ownership.length > 0 && ownershipEl && chainEl) {
        ownershipEl.classList.remove('hidden');
        var chainHtml = '';
        for (var ci = 0; ci < ownership.length; ci++) {
          if (ci > 0) chainHtml += '<span class="fp-custody-arrow">\u2192</span>';
          chainHtml += '<span class="fp-custody-player player-link" data-steam-id="' + esc(ownership[ci].steamId || '') + '">' + esc(ownership[ci].name || ownership[ci].steamId) + '</span>';
          chainHtml += '<span class="fp-custody-time">' + _fpShortDate(ownership[ci].at) + '</span>';
        }
        chainEl.innerHTML = chainHtml;
      }

      // Render movement timeline (limited)
      var limited = movements.slice(0, limit);
      if (limited.length > 0 && movementsEl) {
        var movHtml = '';
        for (var mi = 0; mi < limited.length; mi++) {
          var m = limited[mi];
          movHtml += _fpRenderMovementRow(m);
        }
        if (movements.length > limit) {
          movHtml += '<div class="text-[10px] text-muted text-center py-2">' + (movements.length - limit) + ' older movements not shown. Increase limit to see more.</div>';
        }
        movementsEl.innerHTML = movHtml;
      } else if (emptyEl) {
        emptyEl.classList.remove('hidden');
      }

    } catch (err) {
      if (loadingEl) loadingEl.classList.add('hidden');
      if (movementsEl) movementsEl.innerHTML = '<div class="text-xs text-red-400 text-center py-2">Failed to load tracker data</div>';
    }
  }

  function _fpFormatLocation(type, id, resolvedName) {
    if (!type) return '<span class="text-muted">Unknown</span>';
    if (type === 'player') {
      // Use resolved name from API, or try to look up from player list, or fallback to steam ID
      var pName = resolvedName || id;
      var steamId = id;
      if (!resolvedName) {
        for (var pi = 0; pi < S.players.length; pi++) {
          if (S.players[pi].steamId === id) { pName = S.players[pi].name; break; }
        }
      }
      return '<span class="player-link cursor-pointer hover:underline text-accent" data-steam-id="' + esc(steamId) + '">' + esc(pName) + '</span>';
    }
    if (type === 'container') {
      var cleanId = id.replace(/ChildActor_GEN_VARIABLE_|_C_CAT_\d+|BP_/g, '').replace(/_/g, ' ').trim();
      return '<span class="text-gray-300" title="' + esc(id) + '">' + esc(cleanId || id) + '</span>';
    }
    if (type === 'world_drop') {
      return '<span class="text-amber-400">World Drop</span>';
    }
    if (type === 'global_container') {
      return '<span class="text-blue-400">Global Container</span>';
    }
    return '<span class="text-gray-300">' + esc(type) + ': ' + esc(id) + '</span>';
  }

  function _fpShortDate(dateStr) {
    if (!dateStr) return '';
    try {
      var d = new Date(dateStr + 'Z');
      var now = new Date();
      var diff = now - d;
      if (diff < 60000) return 'just now';
      if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
      if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
      var month = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()];
      return month + ' ' + d.getDate() + ', ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    } catch (e) {
      return dateStr.slice(0, 16);
    }
  }

  function _fpRenderMovementRow(m) {
    var fromLoc = _fpFormatLocation(m.from_type, m.from_id, m.from_name);
    var toLoc = _fpFormatLocation(m.to_type, m.to_id, m.to_name);
    var time = _fpShortDate(m.created_at);
    var attrName = m.attributed_name || '';

    var html = '<div class="fp-movement-row">';
    html += '<span class="fp-time">' + esc(time) + '</span>';
    html += '<span class="fp-loc">' + fromLoc + '</span>';
    html += '<span class="fp-arrow">\u2192</span>';
    html += '<span class="fp-loc">' + toLoc + '</span>';
    if (attrName) {
      html += '<span class="text-muted text-[10px] ml-auto">by ' + esc(attrName) + '</span>';
    }
    if (m.amount > 1) {
      html += '<span class="text-muted text-[10px]">\u00d7' + m.amount + '</span>';
    }
    html += '</div>';
    return html;
  }

  function groupActivityEvents(events) {
    if (!events || !events.length) return [];
    var grouped = [];
    var i = 0;
    while (i < events.length) {
      var e = events[i];
      var groupable = e.type === 'container_loot' || e.type === 'player_build' || e.type === 'container_item_added' || e.type === 'container_item_removed' || e.type === 'structure_placed' || e.type === 'structure_destroyed' || e.type === 'inventory_item_added' || e.type === 'inventory_item_removed' || e.type === 'container_destroyed';
      if (!groupable) { grouped.push({ events: [e], count: 1 }); i++; continue; }
      var batch = [e];
      var j = i + 1;
      while (j < events.length && events[j].type === e.type && (events[j].actor || events[j].steam_id) === (e.actor || e.steam_id)) {
        var tA = e.created_at ? new Date(e.created_at).getTime() : 0;
        var tB = events[j].created_at ? new Date(events[j].created_at).getTime() : 0;
        if (Math.abs(tA - tB) > 120000) break;
        batch.push(events[j]);
        j++;
      }
      grouped.push({ events: batch, count: batch.length });
      i = j;
    }
    return grouped;
  }

  function renderActivityFeed(container, events, compact, append) {
    if (!container) return;
    if (!append) container.innerHTML = '';
    if (!events || !events.length) {
      if (!append) container.innerHTML = '<div class="feed-empty">No events</div>';
      return;
    }
    var limit = compact ? 15 : events.length;
    var sliced = events.slice(0, limit);
    var groups = groupActivityEvents(sliced);
    for (var g = 0; g < groups.length; g++) {
      var group = groups[g];
      var e = group.events[0];
      if (group.count === 1) {
        var item = el('div', 'feed-item fade-in');
        var time = e.created_at ? new Date(e.created_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }) : '';
        var fmt = formatActivityEvent(e);
        item.innerHTML = '<span class="feed-time">' + time + '</span><span class="feed-ico">' + fmt.icon + '</span><span class="feed-txt">' + fmt.text + '</span>';
        container.appendChild(item);
      } else {
        
        var items = {};
        for (var k = 0; k < group.events.length; k++) {
          var ev = group.events[k];
          var name = stripRconTags(ev.item || ev.type);
          items[name] = (items[name] || 0) + (ev.amount || 1);
        }
        var summary = Object.keys(items).map(function(n) { var t = /built|placed|destroyed/.test(e.type) ? 'structure' : 'item'; return entityLink(n, t) + (items[n] > 1 ? ' \u00d7' + items[n] : ''); }).join(', ');
        var fmt0 = formatActivityEvent(e);
        var actor = stripRconTags(e.actor_name || e.actor || e.steam_id || 'Unknown');
        var actorHtml = '<span class="player-link" data-steam-id="' + esc(e.steam_id || e.actor || '') + '">' + esc(actor) + '</span>';
        var time0 = e.created_at ? new Date(e.created_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }) : '';
        var actionWord = { container_loot: 'looted', player_build: 'built', container_item_added: 'added', container_item_removed: 'removed', structure_placed: 'placed', structure_destroyed: 'destroyed', inventory_item_added: 'picked up', inventory_item_removed: 'dropped', container_destroyed: 'destroyed' }[e.type] || 'did';
        var groupEl = el('div', 'feed-item feed-group fade-in');
        groupEl.innerHTML = '<span class="feed-time">' + time0 + '</span><span class="feed-ico">' + fmt0.icon + '</span><span class="feed-txt">' + actorHtml + ' <strong>' + actionWord + '</strong> ' + group.count + ' items: ' + summary + '</span>';
        groupEl.title = 'Click to expand ' + group.count + ' events';
        groupEl.style.cursor = 'pointer';
        (function(groupEl, groupEvents) {
          var expanded = false;
          groupEl.addEventListener('click', function() {
            if (expanded) {
              
              var next = groupEl.nextSibling;
              while (next && next.classList && next.classList.contains('feed-group-detail')) {
                var rm = next;
                next = next.nextSibling;
                rm.remove();
              }
              expanded = false;
              groupEl.classList.remove('feed-group-open');
            } else {
              
              var frag = document.createDocumentFragment();
              for (var d = 0; d < groupEvents.length; d++) {
                var de = groupEvents[d];
                var di = el('div', 'feed-item feed-group-detail fade-in');
                var dt = de.created_at ? new Date(de.created_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }) : '';
                var df = formatActivityEvent(de);
                di.innerHTML = '<span class="feed-time">' + dt + '</span><span class="feed-ico">' + df.icon + '</span><span class="feed-txt">' + df.text + '</span>';
                frag.appendChild(di);
              }
              groupEl.parentNode.insertBefore(frag, groupEl.nextSibling);
              expanded = true;
              groupEl.classList.add('feed-group-open');
            }
          });
        })(groupEl, group.events);
        container.appendChild(groupEl);
      }
    }
  }

  function formatActivityEvent(e) {
    var actor = stripRconTags(e.actor_name || e.actor || e.steam_id || 'Unknown');
    var target = stripRconTags(e.target_name || e.target_steam_id || '');
    var actorHtml = '<span class="player-link" data-steam-id="' + esc(e.steam_id || e.actor || '') + '">' + esc(actor) + '</span>';
    var targetHtml = target ? '<span class="player-link" data-steam-id="' + esc(e.target_steam_id || '') + '">' + esc(target) + '</span>' : '';
    var itemName = stripRconTags(e.item || '');
    
    var _itype = 'item';
    if (e.type === 'player_build' || e.type === 'structure_placed' || e.type === 'structure_destroyed' || e.type === 'structure_damaged' || e.type === 'building_destroyed') _itype = 'structure';
    else if (e.type === 'vehicle_change' || e.type === 'vehicle_fuel_changed' || e.type === 'vehicle_health_changed' || e.type === 'vehicle_appeared' || e.type === 'vehicle_destroyed') _itype = 'vehicle';
    else if (e.type === 'container_loot' || e.type === 'container_item_added' || e.type === 'container_item_removed' || e.type === 'container_destroyed') _itype = 'item';
    else if (e.type === 'raid_damage') _itype = 'structure';
    var itemHtml = itemName ? entityLink(itemName, _itype) : '';

    var map = {
      player_connect:    { icon: '\u2192', text: actorHtml + ' <strong>connected</strong>' },
      player_disconnect: { icon: '\u2190', text: actorHtml + ' <strong>disconnected</strong>' },
      player_death:      { icon: '\u2715', text: actorHtml + ' <strong>died</strong>' + (e.details ? ' \u2014 ' + esc(tryParseDetails(e.details, 'cause') || '') : '') },
      player_death_pvp:  { icon: '\u2694', text: actorHtml + ' <strong>killed</strong> ' + targetHtml },
      player_build:      { icon: '\u25AA', text: actorHtml + ' <strong>built</strong> ' + itemHtml + (e.amount > 1 ? ' \u00d7' + e.amount : '') },
      container_loot:    { icon: '\u25C7', text: actorHtml + ' <strong>looted</strong> ' + (itemHtml || 'container') + (e.amount > 1 ? ' \u00d7' + e.amount : '') },
      damage_taken:      { icon: '!', text: actorHtml + ' <strong>took damage</strong>' + (itemName ? ' from ' + itemHtml : '') },
      raid_damage:       { icon: '\u26A0', text: actorHtml + ' <strong>raided</strong> ' + targetHtml + (itemName ? ' (' + itemHtml + ')' : '') },
      building_destroyed:{ icon: '\u2715', text: (itemHtml || entityLink('Structure', 'structure')) + ' <strong>destroyed</strong>' + (target ? ' by ' + targetHtml : '') },
      admin_access:      { icon: '\u2605', text: actorHtml + ' <strong>admin action</strong>' + (itemName ? ': ' + itemHtml : '') },
      anticheat_flag:    { icon: '\u2691', text: actorHtml + ' <strong>flagged</strong>' + (itemName ? ' \u2014 ' + itemHtml : '') },
      container_item_added:  { icon: '+', text: (itemHtml || esc(itemName)) + ' <strong>added</strong> to container' + (actor !== 'Unknown' ? ' (' + actorHtml + ')' : '') },
      container_item_removed:{ icon: '\u2212', text: (itemHtml || esc(itemName)) + ' <strong>removed</strong> from container' + (actor !== 'Unknown' ? ' (' + actorHtml + ')' : '') },
      container_destroyed:   { icon: '\u2715', text: (itemHtml || entityLink('Container', 'item')) + ' <strong>destroyed</strong>' + (e.amount > 1 ? ' \u00d7' + e.amount : '') },
      structure_destroyed:   { icon: '\u2715', text: (itemHtml || entityLink('Structure', 'structure')) + ' <strong>destroyed</strong>' + (e.amount > 1 ? ' \u00d7' + e.amount : '') },
      structure_damaged:     { icon: '\u26A0', text: (itemHtml || entityLink('Structure', 'structure')) + ' <strong>damaged</strong>' + (target ? ' by ' + targetHtml : '') },
      structure_placed:      { icon: '\u25AA', text: (itemHtml || entityLink('Structure', 'structure')) + ' <strong>placed</strong>' + (e.amount > 1 ? ' \u00d7' + e.amount : '') },
      inventory_item_added:  { icon: '+', text: actorHtml + ' <strong>picked up</strong> ' + (itemHtml || 'item') + (e.amount > 1 ? ' \u00d7' + e.amount : '') },
      inventory_item_removed:{ icon: '\u2212', text: actorHtml + ' <strong>dropped</strong> ' + (itemHtml || 'item') + (e.amount > 1 ? ' \u00d7' + e.amount : '') },
      vehicle_fuel_changed:  { icon: '\u26FD', text: entityLink('Vehicle' + (itemName ? ' ' + itemName : ''), 'vehicle') + ' <strong>fuel changed</strong>' + (e.amount ? ' (' + e.amount + ')' : '') },
      vehicle_health_changed:{ icon: '\u2695', text: entityLink('Vehicle' + (itemName ? ' ' + itemName : ''), 'vehicle') + ' <strong>health changed</strong>' + (e.amount ? ' (' + e.amount + ')' : '') },
      vehicle_appeared:      { icon: '\u25CE', text: entityLink('Vehicle' + (itemName ? ' ' + itemName : ''), 'vehicle') + ' <strong>appeared</strong>' },
      vehicle_destroyed:     { icon: '\u2715', text: entityLink('Vehicle' + (itemName ? ' ' + itemName : ''), 'vehicle') + ' <strong>destroyed</strong>' },
      vehicle_change:        { icon: '\u25CE', text: entityLink('Vehicle' + (itemName ? ' ' + itemName : ''), 'vehicle') + ' <strong>state changed</strong>' },
      horse_appeared:        { icon: '\u25CE', text: 'Horse <strong>appeared</strong>' + (itemName ? ' (' + itemHtml + ')' : '') },
      horse_disappeared:     { icon: '\u2715', text: 'Horse <strong>disappeared</strong>' + (itemName ? ' (' + itemHtml + ')' : '') },
      horse_change:          { icon: '\u25CE', text: 'Horse <strong>status changed</strong>' + (itemName ? ': ' + itemHtml : '') },
      world_change:          { icon: '\u25CE', text: 'World <strong>' + esc(itemName || 'updated') + '</strong>' },
    };

    return map[e.type] || { icon: '\u00b7', text: actorHtml + ' \u2014 ' + esc(e.type || 'event') + (itemName ? ' (' + itemHtml + ')' : '') };
  }

  // ── Activity Stats & Charts ──

  const CHART_COLORS = {
    container: '#60a5fa',   // blue
    inventory: '#34d399',   // green
    vehicle: '#fbbf24',     // yellow
    session: '#a78bfa',     // purple
    combat: '#f87171',      // red
    structure: '#fb923c',   // orange
    horse: '#2dd4bf',       // teal
    admin: '#f472b6',       // pink
  };

  async function loadActivityStats() {
    try {
      var r = await apiFetch('/api/panel/activity-stats');
      var d = await r.json();
      S.activityStats = d;

      // Populate stat cards
      var totalEl = $('#act-total');
      if (totalEl) totalEl.textContent = (d.total || 0).toLocaleString();
      var typesEl = $('#act-types-count');
      if (typesEl) typesEl.textContent = Object.keys(d.types || {}).length;
      var rangeEl = $('#act-date-range');
      if (rangeEl && d.dateRange) {
        var e0 = d.dateRange.earliest ? d.dateRange.earliest.split('T')[0] : '?';
        var e1 = d.dateRange.latest ? d.dateRange.latest.split('T')[0] : '?';
        rangeEl.textContent = e0 + ' \u2014 ' + e1;
      }
      var topEl = $('#act-top-actor');
      if (topEl && d.topActors && d.topActors.length) {
        topEl.textContent = d.topActors[0].actor + ' (' + d.topActors[0].count.toLocaleString() + ')';
      }

      // Update pill counts
      var pills = $$('.activity-pill');
      for (var i = 0; i < pills.length; i++) {
        var pill = pills[i];
        var cat = pill.dataset.category || '';
        var badge = pill.querySelector('.pill-count');
        var count = 0;
        if (cat === '') count = d.total || 0;
        else count = (d.categories || {})[cat] || 0;
        if (badge) {
          badge.textContent = formatCompact(count);
        } else if (count > 0) {
          var span = document.createElement('span');
          span.className = 'pill-count';
          span.textContent = formatCompact(count);
          pill.appendChild(span);
        }
      }

      // Render charts
      renderDailyChart(d.daily || []);
      renderHourlyChart(d.hourly || []);
      renderCategoryChart(d.categories || {});
      renderTopActorsChart(d.topActors || []);

    } catch (e) {
      console.error('Failed to load activity stats:', e);
    }
  }

  function formatCompact(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return String(n);
  }

  function destroyChart(key) {
    if (S.activityCharts[key]) { S.activityCharts[key].destroy(); S.activityCharts[key] = null; }
  }

  function chartDefaults() {
    return {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { backgroundColor: 'rgba(15,15,20,0.95)', titleColor: '#e2e8f0', bodyColor: '#94a3b8', borderColor: 'rgba(255,255,255,0.1)', borderWidth: 1, cornerRadius: 6, padding: 8 },
      },
      scales: {
        x: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#64748b', font: { size: 10 } } },
        y: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#64748b', font: { size: 10 } }, beginAtZero: true },
      },
    };
  }

  function renderDailyChart(daily) {
    var canvas = $('#chart-daily-activity');
    if (!canvas) return;
    destroyChart('daily');
    var labels = daily.map(function(d) { return d.day ? d.day.slice(5) : ''; });
    var data = daily.map(function(d) { return d.count; });
    S.activityCharts.daily = new Chart(canvas, {
      type: 'line',
      data: {
        labels: labels,
        datasets: [{
          data: data,
          borderColor: '#60a5fa',
          backgroundColor: 'rgba(96,165,250,0.15)',
          fill: true,
          tension: 0.35,
          borderWidth: 2,
          pointRadius: 1.5,
          pointHoverRadius: 4,
          pointBackgroundColor: '#60a5fa',
        }]
      },
      options: chartDefaults(),
    });
  }

  function renderHourlyChart(hourly) {
    var canvas = $('#chart-hourly-activity');
    if (!canvas) return;
    destroyChart('hourly');
    var labels = [];
    var data = [];
    var hourMap = {};
    for (var i = 0; i < hourly.length; i++) hourMap[hourly[i].hour] = hourly[i].count;
    for (var h = 0; h < 24; h++) {
      labels.push(h.toString().padStart(2, '0') + ':00');
      data.push(hourMap[h] || 0);
    }
    S.activityCharts.hourly = new Chart(canvas, {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [{
          data: data,
          backgroundColor: 'rgba(167,139,250,0.5)',
          borderColor: '#a78bfa',
          borderWidth: 1,
          borderRadius: 3,
        }]
      },
      options: chartDefaults(),
    });
  }

  function renderCategoryChart(categories) {
    var canvas = $('#chart-category-activity');
    if (!canvas) return;
    destroyChart('category');
    var cats = Object.keys(categories);
    if (!cats.length) return;
    var labels = cats.map(function(c) { return c.charAt(0).toUpperCase() + c.slice(1); });
    var data = cats.map(function(c) { return categories[c]; });
    var colors = cats.map(function(c) { return CHART_COLORS[c] || '#64748b'; });
    S.activityCharts.category = new Chart(canvas, {
      type: 'doughnut',
      data: {
        labels: labels,
        datasets: [{
          data: data,
          backgroundColor: colors,
          borderColor: 'rgba(15,15,20,0.8)',
          borderWidth: 2,
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '55%',
        plugins: {
          legend: { position: 'right', labels: { color: '#94a3b8', font: { size: 11 }, padding: 8, usePointStyle: true, pointStyleWidth: 8 } },
          tooltip: { backgroundColor: 'rgba(15,15,20,0.95)', titleColor: '#e2e8f0', bodyColor: '#94a3b8', borderColor: 'rgba(255,255,255,0.1)', borderWidth: 1, cornerRadius: 6, padding: 8 },
        },
      },
    });
  }

  function renderTopActorsChart(topActors) {
    var canvas = $('#chart-top-actors');
    if (!canvas) return;
    destroyChart('topActors');
    if (!topActors.length) return;
    var labels = topActors.map(function(a) { return a.actor || 'Unknown'; });
    var data = topActors.map(function(a) { return a.count; });
    S.activityCharts.topActors = new Chart(canvas, {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [{
          data: data,
          backgroundColor: 'rgba(52,211,153,0.5)',
          borderColor: '#34d399',
          borderWidth: 1,
          borderRadius: 3,
        }]
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { backgroundColor: 'rgba(15,15,20,0.95)', titleColor: '#e2e8f0', bodyColor: '#94a3b8', borderColor: 'rgba(255,255,255,0.1)', borderWidth: 1, cornerRadius: 6, padding: 8 },
        },
        scales: {
          x: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#64748b', font: { size: 10 } }, beginAtZero: true },
          y: { grid: { display: false }, ticks: { color: '#94a3b8', font: { size: 11 } } },
        },
      },
    });
  }

  function tryParseDetails(details, key) {
    if (!details) return '';
    if (typeof details === 'string') { try { details = JSON.parse(details); } catch (e) { return details; } }
    return details[key] || '';
  }

  async function loadChat() {
    var container = $('#chat-feed');
    if (!container) return;
    var search = ($('#chat-search') ? $('#chat-search').value : '').trim();
    try {
      var params = new URLSearchParams({ limit: '200' });
      if (search) params.set('search', search);
      var r = await apiFetch('/api/panel/chat?' + params);
      var d = await r.json();
      var messages = d.messages || [];
      renderChatFeed(container, messages, false);
      var countEl = $('#chat-count');
      if (countEl) countEl.textContent = messages.length + ' messages' + (search ? ' (filtered)' : '');
      container.scrollTop = container.scrollHeight;
    } catch (e) {
      container.innerHTML = '<div class="feed-empty">Failed to load chat</div>';
    }
  }

  function renderChatFeed(container, messages, compact) {
    if (!container) return;
    if (!messages || !messages.length) { container.innerHTML = '<div class="feed-empty">No messages</div>'; return; }
    container.innerHTML = '';
    var limit = compact ? 15 : messages.length;
    var slice = messages.slice(0, limit);
    
    var chrono = compact ? slice : slice.slice().reverse();
    var lastDateKey = '';
    for (var i = 0; i < chrono.length; i++) {
      var m = chrono[i];
      
      if (!compact && m.created_at) {
        var d = new Date(m.created_at);
        var dateKey = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        var timeKey = dateKey + '-' + Math.floor(d.getTime() / 1800000); 
        if (timeKey !== lastDateKey) {
          var sep = el('div', 'chat-time-sep');
          var label = dateKey;
          if (i > 0) {
            label += ' \u00b7 ' + d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
          }
          sep.innerHTML = '<span>' + esc(label) + '</span>';
          container.appendChild(sep);
          lastDateKey = timeKey;
        }
      }
      var msg = el('div', 'chat-msg');
      var isSystem = m.type === 'join' || m.type === 'leave' || m.type === 'death';
      var isOutbound = m.direction === 'outbound';
      var timestamp = !compact && m.created_at ? new Date(m.created_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }) : '';
      var timeHtml = timestamp ? '<span class="chat-time-inline">' + timestamp + '</span>' : '';
      if (isSystem) {
        var action = m.type === 'join' ? 'joined' : m.type === 'leave' ? 'left' : 'died';
        var pLink = '<span class="player-link" data-steam-id="' + esc(m.steam_id || '') + '">' + esc(stripRconTags(m.player_name || 'Player')) + '</span>';
        msg.innerHTML = timeHtml + '<span class="chat-author system">System</span><span class="chat-text text-muted">' + pLink + ' ' + action + '</span>';
      } else {
        var authorCls = isOutbound ? 'outbound' : '';
        var author = isOutbound ? (m.discord_user || 'Discord') : (m.player_name || 'Player');
        var isAdmin = m.is_admin ? ' chat-admin' : '';
        var cleanMsg = stripRconTags(m.message || '');
        var cleanAuthor = stripRconTags(author);
        msg.innerHTML = timeHtml + '<span class="chat-author player-link' + isAdmin + ' ' + authorCls + '" data-steam-id="' + esc(m.steam_id || '') + '">' + esc(cleanAuthor) + '</span><span class="chat-text' + isAdmin + '">' + esc(cleanMsg) + '</span>';
      }
      container.appendChild(msg);
    }
  }

  async function sendChat() {
    if (S.tier < 2) return;
    var input = $('#chat-msg-input');
    if (!input) return;
    var msg = input.value.trim();
    if (!msg) return;
    try {
      
      await apiFetch('/api/admin/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: '[Panel] ' + (S.user ? S.user.displayName || 'Admin' : 'Admin') + ': ' + msg }),
      });
      input.value = '';
      var feed = $('#chat-feed');
      if (feed) {
        var div = el('div', 'chat-msg fade-in');
        div.innerHTML = '<span class="chat-author outbound">' + esc(S.user ? S.user.displayName || 'You' : 'You') + '</span><span class="chat-text">' + esc(msg) + '</span>';
        feed.appendChild(div);
        feed.scrollTop = feed.scrollHeight;
      }
      setTimeout(loadChat, 2000);
    } catch (e) { console.error('Chat send error:', e); }
  }

  var RCON_COMMANDS = [
    'info', 'players', 'save',
    'say ', 'admin ', 'servermsg ',
    'kick ', 'ban ', 'unban ',
    'whitelist ', 'removewhitelist ', 'addadmin ', 'removeadmin ',
    'fetchbanned', 'fetchwhitelist', 'fetchadmins',
    'teleport ', 'unstuck ', 'giveitem ',
    'weather ', 'season ', 'settime ', 'setday', 'setnight',
    'setzombiemultiplier ', 'setanimalmultiplier ', 'setzombies ', 'setanimals ',
    'restart ', 'QuickRestart', 'RestartNow', 'CancelRestart', 'shutdown '
  ];
  var consoleHistory = [];
  var consoleHistoryIdx = -1;
  try { consoleHistory = JSON.parse(localStorage.getItem('hmz_console_history') || '[]'); } catch {}

  function saveConsoleHistory() {
    try { localStorage.setItem('hmz_console_history', JSON.stringify(consoleHistory.slice(-50))); } catch {}
  }

  async function sendRcon() {
    var input = $('#rcon-input');
    if (!input) return;
    var cmd = input.value.trim();
    if (!cmd) return;
    
    if (consoleHistory[consoleHistory.length - 1] !== cmd) consoleHistory.push(cmd);
    if (consoleHistory.length > 50) consoleHistory.shift();
    saveConsoleHistory();
    consoleHistoryIdx = -1;
    hideConsoleAutocomplete();
    appendConsole(cmd, 'cmd');
    input.value = '';
    try {
      var r = await apiFetch('/api/panel/rcon', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command: cmd }) });
      var d = await r.json();
      if (d.ok) appendConsole(d.response || '(no response)', 'resp');
      else appendConsole('Error: ' + (d.error || 'Unknown error'), 'err');
    } catch (e) { appendConsole('Connection error: ' + e.message, 'err'); }
  }

  function handleConsoleKeydown(e) {
    var input = $('#rcon-input');
    if (!input) return;
    if (e.key === 'Enter') { sendRcon(); return; }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (consoleHistory.length === 0) return;
      if (consoleHistoryIdx === -1) consoleHistoryIdx = consoleHistory.length;
      consoleHistoryIdx = Math.max(0, consoleHistoryIdx - 1);
      input.value = consoleHistory[consoleHistoryIdx] || '';
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (consoleHistoryIdx === -1) return;
      consoleHistoryIdx = Math.min(consoleHistory.length, consoleHistoryIdx + 1);
      input.value = consoleHistoryIdx < consoleHistory.length ? consoleHistory[consoleHistoryIdx] : '';
      if (consoleHistoryIdx >= consoleHistory.length) consoleHistoryIdx = -1;
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      var val = input.value.toLowerCase();
      if (!val) return;
      var match = RCON_COMMANDS.find(function(c) { return c.startsWith(val); });
      if (match) input.value = match;
      hideConsoleAutocomplete();
      return;
    }
    if (e.key === 'Escape') { hideConsoleAutocomplete(); return; }
    
    setTimeout(function() { showConsoleAutocomplete(input.value); }, 0);
  }

  function showConsoleAutocomplete(val) {
    var wrap = $('#console-autocomplete');
    if (!wrap) return;
    val = (val || '').toLowerCase().trim();
    if (!val) { wrap.classList.add('hidden'); return; }
    var matches = RCON_COMMANDS.filter(function(c) { return c.startsWith(val) && c !== val; });
    
    var histMatches = [];
    for (var i = consoleHistory.length - 1; i >= 0 && histMatches.length < 3; i--) {
      if (consoleHistory[i].toLowerCase().startsWith(val) && matches.indexOf(consoleHistory[i]) === -1) {
        histMatches.push(consoleHistory[i]);
      }
    }
    var all = matches.concat(histMatches);
    if (all.length === 0) { wrap.classList.add('hidden'); return; }
    wrap.innerHTML = all.map(function(c) { return '<div class="cmd-item" data-cmd="' + esc(c) + '">' + esc(c) + '</div>'; }).join('');
    wrap.classList.remove('hidden');
  }

  function hideConsoleAutocomplete() {
    var wrap = $('#console-autocomplete');
    if (wrap) wrap.classList.add('hidden');
  }

  function appendConsole(text, cls) {
    var out = $('#console-output');
    if (!out) return;
    var line = el('div', 'console-line ' + cls);
    line.textContent = text;
    out.appendChild(line);
    out.scrollTop = out.scrollHeight;
  }

  async function loadSettings() {
    var container = $('#settings-grid');
    if (!container) return;
    try {
      var r = await apiFetch('/api/panel/settings');
      if (!r.ok) { container.innerHTML = '<div class="feed-empty">Settings unavailable</div>'; return; }
      var d = await r.json();
      var settings = d.settings || {};
      S.settingsOriginal = Object.assign({}, settings);
      S.settingsChanged = {};
      renderSettingsCategories(container, settings);
      var countEl = $('#settings-count');
      if (countEl) countEl.textContent = Object.keys(settings).length + ' settings';
    } catch (e) { container.innerHTML = '<div class="feed-empty">Failed to load settings</div>'; }
  }

  function renderSettingsCategories(container, settings) {
    container.innerHTML = '';
    var assigned = {};
    var categories = [];

    for (var catName in SETTING_CATEGORIES) {
      if (!SETTING_CATEGORIES.hasOwnProperty(catName)) continue;
      var keys = SETTING_CATEGORIES[catName];
      var items = [];
      for (var ki = 0; ki < keys.length; ki++) {
        if (keys[ki] in settings) { items.push({ key: keys[ki], value: settings[keys[ki]] }); assigned[keys[ki]] = true; }
      }
      if (items.length) categories.push({ name: catName, items: items });
    }

    var other = [];
    for (var key in settings) {
      if (!settings.hasOwnProperty(key)) continue;
      if (!assigned[key]) other.push({ key: key, value: settings[key] });
    }
    if (other.length) categories.push({ name: 'Other', items: other });

    for (var ci = 0; ci < categories.length; ci++) {
      var cat = categories[ci];
      var section = el('div', 'settings-category');
      var header = el('div', 'settings-category-header');
      header.innerHTML = '<span class="cat-arrow">\u25B8</span><span class="cat-label">' + cat.name + '</span><span class="cat-count">' + cat.items.length + '</span>';

      var body = el('div', 'settings-category-items');
      for (var ii = 0; ii < cat.items.length; ii++) {
        var item = cat.items[ii];
        var row = el('div', 'setting-row');
        row.dataset.key = item.key;
        var desc = SETTING_DESCS[item.key] || '';
        row.innerHTML = '<div class="setting-name">' + esc(humanizeSettingKey(item.key)) + '</div>' + (desc ? '<div class="setting-desc">' + esc(desc) + '</div>' : '') + '<input type="text" class="setting-input" value="' + esc(String(item.value)) + '" data-key="' + esc(item.key) + '" data-original="' + esc(String(item.value)) + '">';
        body.appendChild(row);
      }

      (function(bodyEl, headerEl) {
        headerEl.addEventListener('click', function() {
          bodyEl.classList.toggle('open');
          headerEl.querySelector('.cat-arrow').classList.toggle('open');
        });
      })(body, header);

      if (ci === 0) { body.classList.add('open'); header.querySelector('.cat-arrow').classList.add('open'); }

      section.appendChild(header);
      section.appendChild(body);
      container.appendChild(section);
    }

    container.addEventListener('input', function(e) {
      if (!e.target.classList.contains('setting-input')) return;
      var key = e.target.dataset.key;
      var orig = e.target.dataset.original;
      var val = e.target.value;
      if (val !== orig) { S.settingsChanged[key] = val; e.target.classList.add('changed'); }
      else { delete S.settingsChanged[key]; e.target.classList.remove('changed'); }

      var changeCount = Object.keys(S.settingsChanged).length;
      var hasChanges = changeCount > 0;
      var btn = $('#settings-save-btn');
      if (btn) { btn.disabled = !hasChanges; btn.classList.toggle('opacity-50', !hasChanges); btn.classList.toggle('cursor-not-allowed', !hasChanges); }
      var countBadge = $('#settings-change-count');
      if (countBadge) { countBadge.classList.toggle('hidden', !hasChanges); countBadge.textContent = changeCount + ' change' + (changeCount !== 1 ? 's' : ''); }
      var resetBtn = $('#settings-reset-btn');
      if (resetBtn) resetBtn.classList.toggle('hidden', !hasChanges);
    });
  }

  function filterSettings() {
    var q = ($('#settings-search') ? $('#settings-search').value : '').toLowerCase();
    $$('.setting-row').forEach(function(row) {
      var key = (row.dataset.key || '').toLowerCase();
      var nameEl = row.querySelector('.setting-name');
      var descEl = row.querySelector('.setting-desc');
      var name = nameEl ? nameEl.textContent.toLowerCase() : '';
      var desc = descEl ? descEl.textContent.toLowerCase() : '';
      row.style.display = (key.includes(q) || name.includes(q) || desc.includes(q)) ? '' : 'none';
    });
    $$('.settings-category').forEach(function(cat) {
      var visibleRows = cat.querySelectorAll('.setting-row:not([style*="display: none"])');
      cat.style.display = visibleRows.length ? '' : 'none';
      if (q && visibleRows.length) {
        var items = cat.querySelector('.settings-category-items');
        if (items) items.classList.add('open');
        var arrow = cat.querySelector('.cat-arrow');
        if (arrow) arrow.classList.add('open');
      }
    });
  }

  function showSettingsDiff() {
    var changed = S.settingsMode === 'bot' ? S.botConfigChanged : S.settingsChanged;
    var originals = S.settingsMode === 'bot' ? S.botConfigOriginal : S.settingsOriginal;
    var keys = Object.keys(changed);
    if (keys.length === 0) return;

    var content = $('#settings-diff-content');
    if (!content) return;
    content.innerHTML = '';

    var catOrder = {};
    var orderIdx = 0;
    for (var catName in SETTING_CATEGORIES) {
      if (!SETTING_CATEGORIES.hasOwnProperty(catName)) continue;
      var catKeys = SETTING_CATEGORIES[catName];
      for (var ci = 0; ci < catKeys.length; ci++) { catOrder[catKeys[ci]] = orderIdx++; }
    }
    keys.sort(function(a, b) {
      var oa = catOrder[a] != null ? catOrder[a] : 9999;
      var ob = catOrder[b] != null ? catOrder[b] : 9999;
      return oa - ob;
    });

    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      var oldVal = originals[key] != null ? String(originals[key]) : '';
      var newVal = changed[key];
      var isSensitive = S.settingsMode === 'bot' && !oldVal && newVal;
      var displayOld = isSensitive ? '(hidden)' : oldVal;
      var displayNew = isSensitive ? '(updated)' : newVal;
      var row = el('div', 'diff-row');
      var descKey = S.settingsMode === 'bot' ? key : humanizeSettingKey(key);
      row.innerHTML = '<div class="diff-key">' + esc(descKey) + '<div class="diff-key-raw">' + esc(key) + '</div></div>' +
        '<div class="diff-values">' +
        '<span class="diff-old">' + esc(displayOld) + '</span>' +
        '<span class="diff-arrow">\u2192</span>' +
        '<span class="diff-new">' + esc(String(displayNew)) + '</span>' +
        '</div>';
      content.appendChild(row);
    }

    var modal = $('#settings-diff-modal');
    if (modal) modal.classList.remove('hidden');
    
    if (window.lucide) lucide.createIcons();
  }

  function resetSettingsChanges() {
    if (S.settingsMode === 'bot') return resetBotConfigChanges();
    
    var keys = Object.keys(S.settingsChanged);
    for (var i = 0; i < keys.length; i++) {
      var input = $('input[data-key="' + keys[i] + '"]');
      if (input) {
        input.value = input.dataset.original;
        input.classList.remove('changed');
      }
    }
    S.settingsChanged = {};
    var btn = $('#settings-save-btn');
    if (btn) { btn.disabled = true; btn.classList.add('opacity-50', 'cursor-not-allowed'); }
    var countBadge = $('#settings-change-count');
    if (countBadge) countBadge.classList.add('hidden');
    var resetBtn = $('#settings-reset-btn');
    if (resetBtn) resetBtn.classList.add('hidden');
  }

  async function commitSettings() {
    if (S.settingsMode === 'bot') return commitBotConfig();
    if (Object.keys(S.settingsChanged).length === 0) return;
    var btn = $('#settings-save-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving...'; }
    try {
      var r = await apiFetch('/api/panel/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ settings: S.settingsChanged }) });
      var d = await r.json();
      if (d.ok) {
        var updated = d.updated || [];
        for (var ui = 0; ui < updated.length; ui++) {
          var key = updated[ui];
          S.settingsOriginal[key] = S.settingsChanged[key];
          var input = $('input[data-key="' + key + '"]');
          if (input) { input.dataset.original = S.settingsChanged[key]; input.classList.remove('changed'); }
        }
        S.settingsChanged = {};
        if (btn) btn.textContent = 'Saved \u2713';
        var countBadge = $('#settings-change-count');
        if (countBadge) countBadge.classList.add('hidden');
        var resetBtn = $('#settings-reset-btn');
        if (resetBtn) resetBtn.classList.add('hidden');
        setTimeout(function() { if (btn) { btn.textContent = 'Save Changes'; btn.disabled = true; btn.classList.add('opacity-50', 'cursor-not-allowed'); } }, 2000);
      } else throw new Error(d.error || 'Save failed');
    } catch (e) {
      if (btn) { btn.textContent = 'Error'; btn.disabled = false; }
      console.error('Settings save error:', e);
      setTimeout(function() { if (btn) btn.textContent = 'Save Changes'; }, 2000);
    }
  }

  // ══════════════════════════════════════════════════════════════════
  //  Bot Configuration (.env editor)
  // ══════════════════════════════════════════════════════════════════

  async function loadBotConfig() {
    var container = $('#settings-grid');
    if (!container) return;
    try {
      var r = await apiFetch('/api/panel/bot-config');
      if (!r.ok) { container.innerHTML = '<div class="feed-empty">Bot configuration unavailable</div>'; return; }
      var d = await r.json();
      S.botConfigSections = d.sections || [];
      S.botConfigOriginal = {};
      S.botConfigChanged = {};
      // Flatten for original tracking
      for (var si = 0; si < S.botConfigSections.length; si++) {
        var sec = S.botConfigSections[si];
        for (var ki = 0; ki < sec.keys.length; ki++) {
          var k = sec.keys[ki];
          S.botConfigOriginal[k.key] = k.value;
        }
      }
      renderBotConfig(container, S.botConfigSections);
      var countEl = $('#settings-count');
      var total = S.botConfigSections.reduce(function(sum, s) { return sum + s.keys.length; }, 0);
      if (countEl) countEl.textContent = total + ' settings';
      // Reset change state
      var btn = $('#settings-save-btn');
      if (btn) { btn.disabled = true; btn.classList.add('opacity-50', 'cursor-not-allowed'); }
      var countBadge = $('#settings-change-count');
      if (countBadge) countBadge.classList.add('hidden');
      var resetBtn = $('#settings-reset-btn');
      if (resetBtn) resetBtn.classList.add('hidden');
      var restartBadge = $('#settings-restart-badge');
      if (restartBadge) restartBadge.classList.add('hidden');
    } catch (e) {
      container.innerHTML = '<div class="feed-empty">Failed to load bot configuration</div>';
      console.error('Bot config error:', e);
    }
  }

  function renderBotConfig(container, sections) {
    container.innerHTML = '';

    for (var si = 0; si < sections.length; si++) {
      var sec = sections[si];
      if (!sec.keys.length) continue;

      var section = el('div', 'settings-category');
      var header = el('div', 'settings-category-header');
      header.innerHTML = '<span class="cat-arrow">\u25B8</span><span class="cat-label">' + esc(sec.label) + '</span><span class="cat-count">' + sec.keys.length + '</span>';

      var body = el('div', 'settings-category-items');
      for (var ki = 0; ki < sec.keys.length; ki++) {
        var item = sec.keys[ki];
        var row = el('div', 'setting-row' + (item.commented ? ' setting-commented' : ''));
        row.dataset.key = item.key;
        var desc = ENV_DESCS[item.key] || '';
        var isBool = ENV_BOOLEANS.has(item.key);
        var nameHtml = '<div class="setting-name">' + esc(humanizeEnvKey(item.key));
        if (item.sensitive) nameHtml += ' <span class="setting-sensitive-badge">secret</span>';
        if (item.readOnly) nameHtml += ' <span class="setting-sensitive-badge" style="color:#d4a843;border-color:rgba(212,168,67,0.15);background:rgba(212,168,67,0.08)">read-only</span>';
        nameHtml += '<div class="setting-env-key">' + esc(item.key) + '</div></div>';

        var inputHtml = '';
        if (item.readOnly) {
          inputHtml = '<span class="text-xs text-muted font-mono">' + esc(item.value || '-') + '</span>';
        } else if (item.sensitive) {
          inputHtml = '<div class="flex items-center gap-2">';
          if (item.hasValue) inputHtml += '<span class="text-xs text-calm">\u2022\u2022\u2022\u2022\u2022\u2022 set</span>';
          else inputHtml += '<span class="text-xs text-muted">not set</span>';
          inputHtml += '<input type="password" class="setting-input bot-config-input" style="width:180px" placeholder="Enter new value..." data-key="' + esc(item.key) + '" data-original="" data-sensitive="true" autocomplete="off">';
          inputHtml += '</div>';
        } else if (isBool) {
          var isOn = item.value === 'true';
          inputHtml = '<label class="setting-toggle"><input type="checkbox" class="bot-config-toggle" data-key="' + esc(item.key) + '" data-original="' + esc(item.value) + '"' + (isOn ? ' checked' : '') + '><span class="toggle-track"></span><span class="toggle-thumb"></span></label>';
        } else {
          inputHtml = '<input type="text" class="setting-input bot-config-input" value="' + esc(item.value) + '" data-key="' + esc(item.key) + '" data-original="' + esc(item.value) + '">';
        }

        row.innerHTML = nameHtml + (desc ? '<div class="setting-desc">' + esc(desc) + '</div>' : '') + inputHtml;
        body.appendChild(row);
      }

      // Wire accordion toggle
      (function(bodyEl, headerEl) {
        headerEl.addEventListener('click', function() {
          bodyEl.classList.toggle('open');
          headerEl.querySelector('.cat-arrow').classList.toggle('open');
        });
      })(body, header);

      // Open first section by default
      if (si === 0) { body.classList.add('open'); header.querySelector('.cat-arrow').classList.add('open'); }

      section.appendChild(header);
      section.appendChild(body);
      container.appendChild(section);
    }

    // Wire change detection for text inputs
    container.addEventListener('input', function(e) {
      if (!e.target.classList.contains('bot-config-input')) return;
      var key = e.target.dataset.key;
      var orig = e.target.dataset.original;
      var val = e.target.value;
      var isSensitive = e.target.dataset.sensitive === 'true';

      if (isSensitive) {
        // Any non-empty value in a sensitive field is a change
        if (val.length > 0) { S.botConfigChanged[key] = val; e.target.classList.add('changed'); }
        else { delete S.botConfigChanged[key]; e.target.classList.remove('changed'); }
      } else {
        if (val !== orig) { S.botConfigChanged[key] = val; e.target.classList.add('changed'); }
        else { delete S.botConfigChanged[key]; e.target.classList.remove('changed'); }
      }
      updateBotConfigBadges();
    });

    // Wire change detection for toggle switches
    container.addEventListener('change', function(e) {
      if (!e.target.classList.contains('bot-config-toggle')) return;
      var key = e.target.dataset.key;
      var orig = e.target.dataset.original;
      var val = e.target.checked ? 'true' : 'false';
      if (val !== orig) { S.botConfigChanged[key] = val; }
      else { delete S.botConfigChanged[key]; }
      updateBotConfigBadges();
    });
  }

  function updateBotConfigBadges() {
    var changeCount = Object.keys(S.botConfigChanged).length;
    var hasChanges = changeCount > 0;
    var btn = $('#settings-save-btn');
    if (btn) { btn.disabled = !hasChanges; btn.classList.toggle('opacity-50', !hasChanges); btn.classList.toggle('cursor-not-allowed', !hasChanges); }
    var countBadge = $('#settings-change-count');
    if (countBadge) { countBadge.classList.toggle('hidden', !hasChanges); countBadge.textContent = changeCount + ' change' + (changeCount !== 1 ? 's' : ''); }
    var resetBtn = $('#settings-reset-btn');
    if (resetBtn) resetBtn.classList.toggle('hidden', !hasChanges);
    var restartBadge = $('#settings-restart-badge');
    if (restartBadge) restartBadge.classList.toggle('hidden', !hasChanges);
  }

  function humanizeEnvKey(key) {
    // Convert SCREAMING_SNAKE_CASE to readable title
    return key.replace(/_/g, ' ').replace(/\b([A-Z]+)\b/g, function(m) {
      // Keep common acronyms uppercase
      if (/^(ID|IP|RCON|SFTP|FTP|SSH|PVP|API|URL|TTL|CSV|DB|OAUTH|MSG|XP|AI|DM|UI|NPC|ADMIN)$/.test(m)) return m;
      return m.charAt(0) + m.slice(1).toLowerCase();
    });
  }

  function resetBotConfigChanges() {
    var keys = Object.keys(S.botConfigChanged);
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      var input = $('input.bot-config-input[data-key="' + key + '"]');
      if (input) {
        if (input.dataset.sensitive === 'true') input.value = '';
        else input.value = input.dataset.original;
        input.classList.remove('changed');
      }
      var toggle = $('input.bot-config-toggle[data-key="' + key + '"]');
      if (toggle) {
        toggle.checked = toggle.dataset.original === 'true';
      }
    }
    S.botConfigChanged = {};
    updateBotConfigBadges();
  }

  async function commitBotConfig() {
    if (Object.keys(S.botConfigChanged).length === 0) return;
    var btn = $('#settings-save-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving...'; }
    try {
      var r = await apiFetch('/api/panel/bot-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ changes: S.botConfigChanged })
      });
      var d = await r.json();
      if (d.ok) {
        var updated = d.updated || [];
        for (var ui = 0; ui < updated.length; ui++) {
          var key = updated[ui];
          var newVal = S.botConfigChanged[key];
          // Don't store sensitive values in originals
          if ($('input.bot-config-input[data-key="' + key + '"][data-sensitive="true"]')) {
            var sens = $('input.bot-config-input[data-key="' + key + '"]');
            if (sens) { sens.value = ''; sens.classList.remove('changed'); }
          } else {
            S.botConfigOriginal[key] = newVal;
            var input = $('input.bot-config-input[data-key="' + key + '"]');
            if (input) { input.dataset.original = newVal; input.classList.remove('changed'); }
            var toggle = $('input.bot-config-toggle[data-key="' + key + '"]');
            if (toggle) { toggle.dataset.original = newVal; }
          }
        }
        S.botConfigChanged = {};
        if (btn) btn.textContent = 'Saved \u2713';
        updateBotConfigBadges();
        // Show restart notice
        var restartBadge = $('#settings-restart-badge');
        if (restartBadge) restartBadge.classList.remove('hidden');
        showToast(d.message || 'Settings saved. Restart the bot for changes to take effect.', 5000);
        setTimeout(function() { if (btn) { btn.textContent = 'Save Changes'; btn.disabled = true; btn.classList.add('opacity-50', 'cursor-not-allowed'); } }, 2000);
      } else throw new Error(d.error || 'Save failed');
    } catch (e) {
      if (btn) { btn.textContent = 'Error'; btn.disabled = false; }
      console.error('Bot config save error:', e);
      showToast('Error: ' + e.message, 5000);
      setTimeout(function() { if (btn) btn.textContent = 'Save Changes'; }, 2000);
    }
  }

  async function doPowerAction(action) {
    var log = $('#controls-log');
    var time = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
    appendLog(log, '[' + time + '] Sending ' + action + '...', 'text-muted');
    try {
      var r = await apiFetch('/api/panel/power', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: action }) });
      var d = await r.json();
      if (d.ok) appendLog(log, '[' + time + '] \u2713 ' + d.message, 'text-calm');
      else appendLog(log, '[' + time + '] \u2715 ' + (d.error || 'Failed'), 'text-red-400');
    } catch (e) { appendLog(log, '[' + time + '] \u2715 ' + e.message, 'text-red-400'); }
  }

  function appendLog(container, text, cls) {
    if (!container) return;
    var placeholder = container.querySelector('.text-muted');
    if (placeholder && placeholder.textContent === 'No actions yet') placeholder.remove();
    var line = el('div', 'text-xs ' + (cls || ''));
    line.textContent = text;
    container.appendChild(line);
    container.scrollTop = container.scrollHeight;
  }

  async function loadBackupList() {
    var container = $('#backup-list');
    if (!container) return;
    try {
      var r = await apiFetch('/api/panel/backups');
      if (!r.ok) return;
      var d = await r.json();
      var backups = d.backups || [];
      if (!backups.length) {
        container.classList.add('hidden');
        return;
      }
      container.classList.remove('hidden');
      container.innerHTML = '<div class="text-[10px] text-muted uppercase tracking-wider mb-1">Recent Backups</div>';
      for (var i = 0; i < Math.min(backups.length, 10); i++) {
        var b = backups[i];
        var row = el('div', 'flex items-center justify-between text-xs py-1 border-b border-border/20');
        var dateStr = b.created ? new Date(b.created).toLocaleString('en-US', { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '-';
        var sizeStr = b.size > 0 ? formatBytes(b.size) : '';
        var sourceBadge = b.source === 'panel' ? '<span class="text-[9px] bg-accent/10 text-accent px-1 py-0.5 rounded">Panel</span>' : '<span class="text-[9px] bg-surface-50 text-muted px-1 py-0.5 rounded">Local</span>';
        row.innerHTML = '<div class="flex items-center gap-2"><span class="text-muted">' + dateStr + '</span>' + sourceBadge + '</div>' +
          '<span class="text-muted font-mono text-[10px]">' + sizeStr + '</span>';
        container.appendChild(row);
      }
    } catch (e) {  }
  }

  function formatBytes(bytes) {
    if (!bytes || bytes <= 0) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
    return (bytes / 1073741824).toFixed(2) + ' GB';
  }

  var _itemsData = { instances: [], groups: [], locations: [], counts: {} };
  var _itemsMovements = [];

  async function loadItems() {
    try {
      var search = ($('#items-search') ? $('#items-search').value : '').trim();
      var view = $('#items-view') ? $('#items-view').value : 'all';

      var url = '/api/panel/items?limit=500';
      if (search) url += '&search=' + encodeURIComponent(search);
      var locFilter = $('#items-location-filter') ? $('#items-location-filter').value : '';
      if (locFilter) {
        var parts = locFilter.split('|');
        url += '&locationType=' + encodeURIComponent(parts[0]) + '&locationId=' + encodeURIComponent(parts[1]);
      }

      var resp = await apiFetch(url);
      _itemsData = await resp.json();

      var movResp = await apiFetch('/api/panel/movements?limit=50');
      var movData = await movResp.json();
      _itemsMovements = movData.movements || [];

      var uc = $('#items-unique-count');
      if (uc) uc.textContent = _itemsData.counts?.instances ?? _itemsData.instances.length;
      var gc = $('#items-group-count');
      if (gc) gc.textContent = _itemsData.counts?.groups ?? _itemsData.groups.length;
      var lc = $('#items-location-count');
      if (lc) lc.textContent = _itemsData.locations?.length ?? '-';
      var mc = $('#items-movement-count');
      if (mc) mc.textContent = _itemsMovements.length;

      var locSelect = $('#items-location-filter');
      if (locSelect && locSelect.options.length <= 1 && _itemsData.locations) {
        _itemsData.locations.sort(function(a, b) { return (a.type + a.id).localeCompare(b.type + b.id); });
        for (var i = 0; i < _itemsData.locations.length; i++) {
          var loc = _itemsData.locations[i];
          var opt = document.createElement('option');
          opt.value = loc.type + '|' + loc.id;
          opt.textContent = _formatLocationType(loc.type) + ': ' + _shortenId(loc.id) + ' (' + loc.totalItems + ')';
          locSelect.appendChild(opt);
        }
      }

      var container = $('#items-content');
      if (!container) return;

      if (view === 'movements') {
        _renderMovements(container, _itemsMovements);
      } else if (view === 'instances') {
        _renderItemTable(container, _itemsData.instances, 'instance');
      } else if (view === 'groups') {
        _renderGroupTable(container, _itemsData.groups);
      } else {
        
        _renderCombinedView(container, _itemsData);
      }

    } catch (err) {
      console.error('Failed to load items:', err);
      var c = $('#items-content');
      if (c) c.innerHTML = '<div class="text-xs text-horde">Failed to load item data</div>';
    }
  }

  function _renderCombinedView(container, data) {
    var html = '';

    if (data.groups.length > 0) {
      html += '<div class="card"><h3 class="card-title">Fungible Groups <span class="text-xs text-muted font-normal">(' + data.groups.length + ')</span></h3>';
      html += '<div class="overflow-x-auto"><table class="w-full text-xs">';
      html += '<thead><tr class="text-muted text-left border-b border-border"><th class="px-2 py-1.5">Item</th><th class="px-2 py-1.5">Qty</th><th class="px-2 py-1.5">Stack</th><th class="px-2 py-1.5">Location</th><th class="px-2 py-1.5">Fingerprint</th><th class="px-2 py-1.5">Last Seen</th><th class="px-2 py-1.5"></th></tr></thead><tbody>';
      for (var i = 0; i < data.groups.length; i++) {
        var g = data.groups[i];
        html += '<tr class="border-b border-border/30 hover:bg-surface-50/50">';
        html += '<td class="px-2 py-1.5 text-white font-medium">' + esc(g.item) + '</td>';
        html += '<td class="px-2 py-1.5"><span class="text-surge font-mono">' + g.quantity + '×</span></td>';
        html += '<td class="px-2 py-1.5 text-muted">' + (g.stack_size || 1) + '</td>';
        html += '<td class="px-2 py-1.5">' + _locationBadge(g.location_type, g.location_id, g.location_slot) + '</td>';
        html += '<td class="px-2 py-1.5 font-mono text-[10px]"><span class="text-emerald-400 cursor-pointer hover:underline fp-track-link" data-fp="' + esc(g.fingerprint) + '" data-item="' + esc(g.item) + '" title="Track this item">' + esc(g.fingerprint) + '</span></td>';
        html += '<td class="px-2 py-1.5 text-muted">' + _timeAgo(g.last_seen) + '</td>';
        html += '<td class="px-2 py-1.5"><button class="text-accent hover:text-accent-hover text-[10px] item-grp-detail" data-id="' + g.id + '">History</button></td>';
        html += '</tr>';
      }
      html += '</tbody></table></div></div>';
    }

    if (data.instances.length > 0) {
      html += '<div class="card"><h3 class="card-title">Unique Items <span class="text-xs text-muted font-normal">(' + data.instances.length + ')</span></h3>';
      html += _buildInstanceTable(data.instances);
      html += '</div>';
    }

    if (_itemsMovements.length > 0) {
      html += '<div class="card"><h3 class="card-title">Recent Movements <span class="text-xs text-muted font-normal">(last 50)</span></h3>';
      html += _buildMovementList(_itemsMovements);
      html += '</div>';
    }

    if (!data.groups.length && !data.instances.length) {
      html = '<div class="text-sm text-muted py-8 text-center">No tracked items found. Items are tracked automatically from save file syncs.</div>';
    }

    container.innerHTML = html;
    _bindItemDetailHandlers();
  }

  function _renderItemTable(container, instances, type) {
    if (!instances.length) {
      container.innerHTML = '<div class="text-sm text-muted py-8 text-center">No unique items found</div>';
      return;
    }
    container.innerHTML = '<div class="card">' + _buildInstanceTable(instances) + '</div>';
    _bindItemDetailHandlers();
  }

  function _renderGroupTable(container, groups) {
    if (!groups.length) {
      container.innerHTML = '<div class="text-sm text-muted py-8 text-center">No fungible groups found</div>';
      return;
    }
    
    _renderCombinedView(container, { groups: groups, instances: [], locations: [] });
  }

  function _renderMovements(container, movements) {
    if (!movements.length) {
      container.innerHTML = '<div class="text-sm text-muted py-8 text-center">No movements recorded yet</div>';
      return;
    }
    container.innerHTML = '<div class="card"><h3 class="card-title">Item Movements</h3>' + _buildMovementList(movements) + '</div>';
  }

  function _buildInstanceTable(instances) {
    var html = '<div class="overflow-x-auto"><table class="w-full text-xs">';
    html += '<thead><tr class="text-muted text-left border-b border-border"><th class="px-2 py-1.5">Item</th><th class="px-2 py-1.5">Amt</th><th class="px-2 py-1.5">Durability</th><th class="px-2 py-1.5">Location</th><th class="px-2 py-1.5">Fingerprint</th><th class="px-2 py-1.5">Last Seen</th><th class="px-2 py-1.5"></th></tr></thead><tbody>';
    for (var i = 0; i < instances.length; i++) {
      var inst = instances[i];
      var durPct = inst.max_dur > 0 ? Math.round((inst.durability / inst.max_dur) * 100) : (inst.durability > 0 ? Math.round(inst.durability * 100) : 0);
      var durColor = durPct > 60 ? 'text-calm' : durPct > 25 ? 'text-surge' : 'text-horde';
      html += '<tr class="border-b border-border/30 hover:bg-surface-50/50">';
      html += '<td class="px-2 py-1.5 text-white font-medium">' + esc(inst.item) + (inst.ammo ? ' <span class="text-muted">(' + inst.ammo + ')</span>' : '') + '</td>';
      html += '<td class="px-2 py-1.5">' + (inst.amount || 1) + '</td>';
      html += '<td class="px-2 py-1.5 ' + durColor + ' font-mono">' + durPct + '%</td>';
      html += '<td class="px-2 py-1.5">' + _locationBadge(inst.location_type, inst.location_id, inst.location_slot) + '</td>';
      html += '<td class="px-2 py-1.5 font-mono text-[10px]"><span class="text-emerald-400 cursor-pointer hover:underline fp-track-link" data-fp="' + esc(inst.fingerprint) + '" data-item="' + esc(inst.item) + '" title="Track this item">' + esc(inst.fingerprint) + '</span></td>';
      html += '<td class="px-2 py-1.5 text-muted">' + _timeAgo(inst.last_seen) + '</td>';
      html += '<td class="px-2 py-1.5"><button class="text-accent hover:text-accent-hover text-[10px] item-inst-detail" data-id="' + inst.id + '">History</button></td>';
      html += '</tr>';
    }
    html += '</tbody></table></div>';
    return html;
  }

  function _buildMovementList(movements) {
    var html = '<div class="space-y-1 max-h-96 overflow-y-auto">';
    for (var i = 0; i < movements.length; i++) {
      var m = movements[i];
      var icon = m.move_type === 'group_transfer' ? '⇄' : m.move_type === 'move' ? '→' : '↔';
      var typeLabel = m.move_type === 'group_transfer' ? '<span class="text-surge">group</span>' : '<span class="text-accent">move</span>';
      html += '<div class="flex items-center gap-2 text-xs py-1 border-b border-border/20">';
      html += '<span class="text-muted w-20 shrink-0">' + _timeAgo(m.created_at) + '</span>';
      html += '<span class="font-medium">' + icon + '</span>';
      html += '<span class="text-white">' + esc(m.item) + '</span>';
      html += '<span class="text-muted">×' + (m.amount || 1) + '</span>';
      html += '<span class="text-muted">from</span>' + _locationBadge(m.from_type, m.from_id, m.from_slot);
      html += '<span class="text-muted">to</span>' + _locationBadge(m.to_type, m.to_id, m.to_slot);
      if (m.attributed_name) {
        var attrSid = m.attributed_steam_id || '';
        if (attrSid) {
          html += '<span class="text-calm ml-auto player-link cursor-pointer hover:underline" data-steam-id="' + esc(attrSid) + '">by ' + esc(m.attributed_name) + '</span>';
        } else {
          html += '<span class="text-calm ml-auto">by ' + esc(m.attributed_name) + '</span>';
        }
      }
      html += '<span class="ml-auto">' + typeLabel + '</span>';
      html += '</div>';
    }
    html += '</div>';
    return html;
  }

  function _locationBadge(type, id, slot) {
    var colors = {
      player: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
      container: 'bg-purple-500/15 text-purple-400 border-purple-500/30',
      vehicle: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
      horse: 'bg-pink-500/15 text-pink-400 border-pink-500/30',
      structure: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
      world_drop: 'bg-gray-500/15 text-gray-400 border-gray-500/30',
      backpack: 'bg-orange-500/15 text-orange-400 border-orange-500/30',
      global_container: 'bg-indigo-500/15 text-indigo-400 border-indigo-500/30',
    };
    var cls = colors[type] || 'bg-surface-50 text-muted border-border';
    var label = _formatLocationType(type) + ': ' + _resolveLocationLabel(type, id);
    if (slot && slot !== 'items' && slot !== 'ground') label += ' (' + slot + ')';
    
    if (type === 'player' && id && /^\d{17}$/.test(id)) {
      return '<span class="inline-flex px-1.5 py-0.5 rounded text-[10px] border cursor-pointer hover:brightness-125 player-link ' + cls + '" data-steam-id="' + esc(id) + '">' + esc(label) + '</span>';
    }
    
    if ((type === 'container' || type === 'vehicle' || type === 'structure' || type === 'horse') && id) {
      var entityTable = type === 'horse' ? 'world_horses' : type + 's';
      return '<span class="inline-flex px-1.5 py-0.5 rounded text-[10px] border cursor-pointer hover:brightness-125 entity-link ' + cls + '" data-entity-table="' + entityTable + '" data-entity-search="' + esc(id) + '">' + esc(label) + '</span>';
    }
    return '<span class="inline-flex px-1.5 py-0.5 rounded text-[10px] border ' + cls + '">' + esc(label) + '</span>';
  }

  function _formatLocationType(type) {
    var map = { player: 'Player', container: 'Container', vehicle: 'Vehicle', horse: 'Horse', structure: 'Structure', world_drop: 'World', backpack: 'Backpack', global_container: 'Global' };
    return map[type] || type;
  }

  function _resolveLocationLabel(type, id) {
    if (!id) return '?';
    
    if (type === 'player' && /^\d{17}$/.test(id)) {
      var p = S.players.find(function(pl) { return pl.steamId === id; });
      if (p && p.name) return p.name;
      return '\u2026' + id.slice(-6);
    }
    return _shortenId(id);
  }

  function _shortenId(id) {
    if (!id) return '?';
    
    if (/^\d{17}$/.test(id)) return '…' + id.slice(-6);
    
    if (id.startsWith('pickup_') || id.startsWith('backpack_')) {
      var parts = id.split('_');
      return parts[0] + ' @' + parts.slice(1).join(',');
    }
    
    if (id.length > 24) return id.slice(0, 20) + '…';
    return id;
  }

  function _timeAgo(dateStr) {
    if (!dateStr) return '-';
    var d = new Date(dateStr + 'Z');
    var now = Date.now();
    var diff = Math.max(0, now - d.getTime());
    if (diff < 60000) return 'now';
    if (diff < 3600000) return Math.floor(diff / 60000) + 'm';
    if (diff < 86400000) return Math.floor(diff / 3600000) + 'h';
    return Math.floor(diff / 86400000) + 'd';
  }

  function _bindItemDetailHandlers() {
    
    $$('.item-inst-detail').forEach(function(btn) {
      btn.addEventListener('click', function() { _showItemDetail('instance', parseInt(btn.dataset.id, 10)); });
    });
    
    $$('.item-grp-detail').forEach(function(btn) {
      btn.addEventListener('click', function() { _showItemDetail('group', parseInt(btn.dataset.id, 10)); });
    });

    // Fingerprint → Activity tracker navigation
    $$('.fp-track-link').forEach(function(el) {
      el.addEventListener('click', function() {
        var fpHash = el.dataset.fp;
        var fpItem = el.dataset.item;
        if (fpHash && fpItem) {
          var searchEl = $('#activity-search');
          if (searchEl) searchEl.value = fpItem + '#' + fpHash;
          switchTab('activity');
          setTimeout(function() { resetActivityPaging(); loadActivity(); }, 100);
        }
      });
    });
  }

  async function _showItemDetail(type, id) {
    var modal = $('#item-detail-modal');
    var content = $('#item-detail-content');
    if (!modal || !content) return;

    content.innerHTML = '<div class="text-muted text-sm">Loading...</div>';
    modal.classList.remove('hidden');

    try {
      var url = type === 'group' ? '/api/panel/groups/' + id : '/api/panel/items/' + id + '/movements';
      var resp = await apiFetch(url);
      var data = await resp.json();

      var html = '';

      if (type === 'group') {
        var g = data.group;
        html += '<h2 class="text-lg font-semibold text-white mb-1">' + esc(g.item) + ' <span class="text-surge">×' + g.quantity + '</span></h2>';
        html += '<div class="text-xs text-muted mb-4">Fungible Group #' + g.id + ' · Fingerprint: <span class="font-mono">' + esc(g.fingerprint) + '</span></div>';
        html += '<div class="grid grid-cols-2 gap-2 mb-4 text-xs">';
        html += '<div><span class="text-muted">Location:</span> ' + _locationBadge(g.location_type, g.location_id, g.location_slot) + '</div>';
        html += '<div><span class="text-muted">Stack size:</span> ' + (g.stack_size || 1) + '</div>';
        html += '<div><span class="text-muted">First seen:</span> ' + (g.first_seen || '-') + '</div>';
        html += '<div><span class="text-muted">Last seen:</span> ' + (g.last_seen || '-') + '</div>';
        html += '</div>';
      } else {
        var inst = data.instance;
        var durPct = inst.max_dur > 0 ? Math.round((inst.durability / inst.max_dur) * 100) : (inst.durability > 0 ? Math.round(inst.durability * 100) : 0);
        html += '<h2 class="text-lg font-semibold text-white mb-1">' + esc(inst.item) + '</h2>';
        html += '<div class="text-xs text-muted mb-4">Instance #' + inst.id + ' · Fingerprint: <span class="font-mono">' + esc(inst.fingerprint) + '</span></div>';
        html += '<div class="grid grid-cols-2 gap-2 mb-4 text-xs">';
        html += '<div><span class="text-muted">Location:</span> ' + _locationBadge(inst.location_type, inst.location_id, inst.location_slot) + '</div>';
        html += '<div><span class="text-muted">Durability:</span> ' + durPct + '%</div>';
        if (inst.ammo) html += '<div><span class="text-muted">Ammo:</span> ' + inst.ammo + '</div>';
        html += '<div><span class="text-muted">Amount:</span> ' + (inst.amount || 1) + '</div>';
        html += '<div><span class="text-muted">First seen:</span> ' + (inst.first_seen || '-') + '</div>';
        html += '<div><span class="text-muted">Last seen:</span> ' + (inst.last_seen || '-') + '</div>';
        html += '</div>';
      }

      var movements = data.movements || [];
      if (movements.length > 0) {
        html += '<h3 class="text-sm font-semibold text-white mb-2">Movement History (' + movements.length + ')</h3>';
        html += '<div class="space-y-1 max-h-80 overflow-y-auto">';
        for (var i = 0; i < movements.length; i++) {
          var m = movements[i];
          html += '<div class="flex items-center gap-2 text-xs py-1.5 border-b border-border/20">';
          html += '<span class="text-muted w-32 shrink-0 font-mono text-[10px]">' + esc(m.created_at || '') + '</span>';
          html += '<span class="text-white">' + (m.move_type || 'move') + '</span>';
          html += '<span class="text-muted">×' + (m.amount || 1) + '</span>';
          html += _locationBadge(m.from_type, m.from_id, m.from_slot);
          html += '<span class="text-muted">→</span>';
          html += _locationBadge(m.to_type, m.to_id, m.to_slot);
          if (m.attributed_name) {
            var attrSteamId = m.attributed_steam_id || '';
            if (attrSteamId) {
              html += '<span class="text-calm ml-auto player-link cursor-pointer hover:underline" data-steam-id="' + esc(attrSteamId) + '">' + esc(m.attributed_name) + '</span>';
            } else {
              html += '<span class="text-calm ml-auto">' + esc(m.attributed_name) + '</span>';
            }
          }
          html += '</div>';
        }
        html += '</div>';
      } else {
        html += '<div class="text-xs text-muted mt-4">No movement history recorded</div>';
      }

      content.innerHTML = html;
    } catch (err) {
      content.innerHTML = '<div class="text-horde text-sm">Failed to load details: ' + esc(err.message) + '</div>';
    }
  }

  (function() {
    var searchInput = $('#items-search');
    if (searchInput) {
      var debounce = null;
      searchInput.addEventListener('input', function() {
        clearTimeout(debounce);
        debounce = setTimeout(function() { if (S.currentTab === 'items') loadItems(); }, 300);
      });
    }
    var viewSelect = $('#items-view');
    if (viewSelect) viewSelect.addEventListener('change', function() { if (S.currentTab === 'items') loadItems(); });
    var locFilter = $('#items-location-filter');
    if (locFilter) locFilter.addEventListener('change', function() { if (S.currentTab === 'items') loadItems(); });
    var closeBtn = $('#item-detail-close');
    if (closeBtn) closeBtn.addEventListener('click', function() { $('#item-detail-modal').classList.add('hidden'); });
    var modal = $('#item-detail-modal');
    if (modal) modal.addEventListener('click', function(e) { if (e.target === modal) modal.classList.add('hidden'); });
  })();

  async function loadDatabase() {
    var container = $('#db-results');
    if (!container) return;
    var table = $('#db-table') ? $('#db-table').value : 'activity_log';
    var search = ($('#db-search') ? $('#db-search').value : '').trim();
    var limit = parseInt($('#db-limit') ? $('#db-limit').value : '50', 10);

    container.innerHTML = '<div class="feed-empty">Loading...</div>';

    try {
      var params = new URLSearchParams({ limit: String(limit) });
      if (search) params.set('search', search);
      var r = await apiFetch('/api/panel/db/' + table + '?' + params);
      if (!r.ok) {
        var err = {};
        try { err = await r.json(); } catch (e) {  }
        container.innerHTML = '<div class="feed-empty">Error: ' + esc(err.error || r.statusText) + '</div>';
        return;
      }
      var d = await r.json();
      var rows = d.rows || [];
      var columns = d.columns || [];
      S.dbLastResult = { table: table, rows: rows, columns: columns };
      if (!rows.length) { container.innerHTML = '<div class="feed-empty">No data found</div>'; return; }
      renderDbTable(container, rows, columns);
    } catch (e) {
      container.innerHTML = '<div class="feed-empty">Failed to load data: ' + esc(e.message) + '</div>';
    }
  }

  function renderDbTable(container, rows, columns) {
    if (!rows || !rows.length) { container.innerHTML = '<div class="feed-empty">No data</div>'; return; }
    var hasResolved = rows.some(function(r) { return r._resolved_name; });

    var steamToName = {};
    for (var pi = 0; pi < S.players.length; pi++) {
      if (S.players[pi].steamId) steamToName[S.players[pi].steamId] = S.players[pi].name;
    }

    var steamCols = {};
    for (var sc = 0; sc < columns.length; sc++) {
      var cn = columns[sc].toLowerCase();
      if (cn === 'steam_id' || cn === 'target_steam_id' || cn === 'steamid' || cn === 'owner_steam_id') steamCols[columns[sc]] = true;
    }

    var fkMap = {
      'player_id': 'players', 'clan_id': 'clans', 'steam_id': 'activity_log',
      'target_steam_id': 'activity_log', 'owner_steam_id': 'players'
    };

    var table = el('table', 'db-table');
    var thead = el('thead');
    var headRow = el('tr');
    for (var ci = 0; ci < columns.length; ci++) {
      headRow.appendChild(el('th', '', humanizeSettingKey(columns[ci])));
    }
    if (hasResolved) headRow.appendChild(el('th', '', 'Player Name'));
    thead.appendChild(headRow);
    table.appendChild(thead);

    var tbody = el('tbody');
    for (var ri = 0; ri < rows.length; ri++) {
      var row = rows[ri];
      var tr = el('tr');
      for (var ci2 = 0; ci2 < columns.length; ci2++) {
        var col = columns[ci2];
        var td = el('td');
        var val = row[col];
        if (val == null) val = '';
        else if (typeof val === 'object') val = JSON.stringify(val);
        if ((col === 'created_at' || col === 'updated_at' || col === 'first_seen' || col === 'last_seen' || col === 'timestamp') && val) {
          try { val = new Date(val).toLocaleString('en-US', { hour12: false }); } catch (e) {  }
        }

        if (steamCols[col] && val && String(val).length > 10) {
          var resolved = steamToName[String(val)] || '';
          td.innerHTML = '<span class="player-link text-accent cursor-pointer" data-steam-id="' + esc(String(val)) + '">' + esc(resolved || String(val)) + '</span>';
          if (resolved) td.title = String(val);
          else td.title = String(val);
        }
        
        else if (fkMap[col] && val && !steamCols[col]) {
          var linkEl = document.createElement('span');
          linkEl.className = 'db-link text-accent cursor-pointer hover:underline';
          linkEl.dataset.table = fkMap[col];
          linkEl.dataset.search = String(val);
          linkEl.textContent = String(val);
          td.appendChild(linkEl);
          td.title = 'Click to look up in ' + fkMap[col];
        }
        else if (typeof val === 'number' && val > 9999) td.textContent = fmtNum(val);
        else td.textContent = String(val);

        if (!td.title) td.title = String(row[col] != null ? row[col] : '');
        tr.appendChild(td);
      }
      if (hasResolved) {
        var nameTd = el('td');
        nameTd.textContent = row._resolved_name || '';
        nameTd.className = 'text-accent';
        tr.appendChild(nameTd);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    container.innerHTML = '';
    container.appendChild(table);
  }

  function exportDbCsv() {
    if (!S.dbLastResult || !S.dbLastResult.rows.length) return;
    var d = S.dbLastResult;
    var cols = d.columns;
    var rows = d.rows;

    var lines = [];
    lines.push(cols.map(csvEsc).join(','));
    for (var i = 0; i < rows.length; i++) {
      var cells = [];
      for (var j = 0; j < cols.length; j++) {
        var val = rows[i][cols[j]];
        if (val == null) val = '';
        else if (typeof val === 'object') val = JSON.stringify(val);
        cells.push(csvEsc(String(val)));
      }
      lines.push(cells.join(','));
    }

    var csv = lines.join('\n');
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = d.table + '_' + new Date().toISOString().slice(0, 10) + '.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function csvEsc(str) {
    if (!str) return '';
    
    if (str.indexOf(',') !== -1 || str.indexOf('"') !== -1 || str.indexOf('\n') !== -1) {
      return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
  }

  // ── DB: Fetch live table list with row counts ──
  async function fetchDbTableList() {
    try {
      var r = await apiFetch('/api/panel/db/tables');
      if (!r.ok) return;
      var d = await r.json();
      S.dbTablesLive = d.tables || [];
      // Override dropdowns with live data
      var selects = [$('#db-table'), $('#qb-table')];
      for (var si = 0; si < selects.length; si++) {
        var sel = selects[si];
        if (!sel) continue;
        var prevVal = sel.value;
        sel.innerHTML = '';
        for (var i = 0; i < S.dbTablesLive.length; i++) {
          var t = S.dbTablesLive[i];
          var opt = document.createElement('option');
          opt.value = t.name;
          opt.textContent = t.name + ' (' + (t.rowCount || 0).toLocaleString() + ' rows)';
          sel.appendChild(opt);
        }
        if (prevVal) sel.value = prevVal;
      }
      // Cache schema info
      for (var j = 0; j < S.dbTablesLive.length; j++) {
        S.dbSchemaCache[S.dbTablesLive[j].name] = S.dbTablesLive[j].columns || [];
      }
    } catch (e) { /* ignore — will fall back to static list */ }
  }

  // ── DB: Show schema for selected table ──
  function showDbSchema() {
    var table = $('#db-table') ? $('#db-table').value : '';
    var container = $('#db-schema-info');
    if (!container) return;
    var cols = S.dbSchemaCache[table];
    if (!cols || !cols.length) {
      container.innerHTML = '<span class="text-muted text-xs">No schema info available</span>';
      return;
    }
    var html = '<div class="overflow-x-auto"><table class="db-table text-xs"><thead><tr>';
    html += '<th>Column</th><th>Type</th><th>PK</th><th>Nullable</th>';
    html += '</tr></thead><tbody>';
    for (var i = 0; i < cols.length; i++) {
      var c = cols[i];
      html += '<tr>';
      html += '<td class="font-mono text-accent">' + esc(c.name) + '</td>';
      html += '<td>' + esc(c.type || 'TEXT') + '</td>';
      html += '<td>' + (c.pk ? '\u2713' : '') + '</td>';
      html += '<td>' + (c.nullable ? 'yes' : 'no') + '</td>';
      html += '</tr>';
    }
    html += '</tbody></table></div>';
    container.innerHTML = html;
  }

  // ── DB: Query builder helpers ──
  function updateQbColumns() {
    var table = $('#qb-table') ? $('#qb-table').value : '';
    var cols = S.dbSchemaCache[table] || [];
    var whereCol = $('#qb-where-col');
    var orderCol = $('#qb-order-col');
    var selects = [whereCol, orderCol];
    for (var si = 0; si < selects.length; si++) {
      var sel = selects[si];
      if (!sel) continue;
      sel.innerHTML = '<option value="">--</option>';
      for (var i = 0; i < cols.length; i++) {
        var opt = document.createElement('option');
        opt.value = cols[i].name;
        opt.textContent = cols[i].name;
        sel.appendChild(opt);
      }
    }
  }

  function buildQbSql() {
    var table = $('#qb-table') ? $('#qb-table').value : '';
    var columns = ($('#qb-columns') ? $('#qb-columns').value : '').trim() || '*';
    var whereCol = $('#qb-where-col') ? $('#qb-where-col').value : '';
    var whereOp = $('#qb-where-op') ? $('#qb-where-op').value : '=';
    var whereVal = ($('#qb-where-val') ? $('#qb-where-val').value : '').trim();
    var orderCol = $('#qb-order-col') ? $('#qb-order-col').value : '';
    var orderDir = $('#qb-order-dir') ? $('#qb-order-dir').value : 'DESC';
    var limit = ($('#qb-limit') ? $('#qb-limit').value : '100').trim() || '100';

    if (!table) return '';
    var sql = 'SELECT ' + columns + ' FROM ' + table;
    if (whereCol && (whereVal || whereOp === 'IS NULL' || whereOp === 'IS NOT NULL')) {
      if (whereOp === 'IS NULL') sql += " WHERE " + whereCol + " IS NULL";
      else if (whereOp === 'IS NOT NULL') sql += " WHERE " + whereCol + " IS NOT NULL";
      else if (whereOp === 'LIKE') sql += " WHERE " + whereCol + " LIKE '%" + whereVal.replace(/'/g, "''") + "%'";
      else if (whereOp === 'IN') sql += " WHERE " + whereCol + " IN (" + whereVal + ")";
      else sql += " WHERE " + whereCol + " " + whereOp + " '" + whereVal.replace(/'/g, "''") + "'";
    }
    if (orderCol) sql += ' ORDER BY ' + orderCol + ' ' + orderDir;
    sql += ' LIMIT ' + parseInt(limit, 10);
    return sql;
  }

  function updateQbPreview() {
    var preview = $('#qb-preview');
    if (preview) preview.textContent = buildQbSql();
  }

  async function runQueryBuilder() {
    var sql = buildQbSql();
    if (!sql) return showToast('Select a table first', 'error');
    await executeRawQuery(sql);
  }

  async function runRawSql() {
    var input = $('#db-raw-sql');
    var sql = (input ? input.value : '').trim();
    if (!sql) return showToast('Enter a SQL query', 'error');
    await executeRawQuery(sql);
  }

  async function executeRawQuery(sql) {
    var container = $('#db-query-results');
    var status = $('#db-query-status');
    if (!container) return;
    container.innerHTML = '<div class="feed-empty">Running...</div>';
    if (status) status.textContent = '';

    try {
      var r = await apiFetch('/api/panel/db/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql: sql, limit: 500 }),
      });
      var d = await r.json();
      if (d.error) {
        container.innerHTML = '<div class="feed-empty text-danger">' + esc(d.error) + '</div>';
        if (status) status.textContent = 'Error';
        return;
      }
      var rows = d.rows || [];
      var columns = d.columns || [];
      S.dbLastResult = { table: 'query', rows: rows, columns: columns };
      if (status) status.textContent = rows.length + ' row' + (rows.length !== 1 ? 's' : '') + ' returned';
      if (!rows.length) {
        container.innerHTML = '<div class="feed-empty">No results</div>';
        return;
      }
      renderDbTable(container, rows, columns);
    } catch (e) {
      container.innerHTML = '<div class="feed-empty text-danger">Request failed: ' + esc(e.message) + '</div>';
      if (status) status.textContent = 'Failed';
    }
  }

  // ══════════════════════════════════════════════════
  //  ANTICHEAT
  // ══════════════════════════════════════════════════

  async function loadAnticheat() {
    var flagsContainer = $('#ac-flags-table');
    var riskContainer = $('#ac-risk-table');
    var cardsContainer = $('#ac-risk-cards');
    var countEl = $('#ac-flag-count');
    if (!flagsContainer) return;

    var statusFilter = $('#ac-status-filter') ? $('#ac-status-filter').value : 'open';
    var severityFilter = $('#ac-severity-filter') ? $('#ac-severity-filter').value : '';

    flagsContainer.innerHTML = '<div class="feed-empty">Loading flags...</div>';
    riskContainer.innerHTML = '<div class="feed-empty">Loading risk scores...</div>';

    // Load flags + risk scores in parallel
    try {
      var params = new URLSearchParams();
      if (statusFilter) params.set('status', statusFilter);
      if (severityFilter) params.set('severity', severityFilter);
      params.set('limit', '100');

      var [flagsRes, riskRes] = await Promise.all([
        apiFetch('/api/panel/anticheat/flags?' + params),
        apiFetch('/api/panel/anticheat/risk-scores')
      ]);

      if (!flagsRes.ok || !riskRes.ok) {
        var errMsg = 'Failed to load anticheat data';
        if (flagsRes.status === 403 || riskRes.status === 403) errMsg += ' (requires admin)';
        else errMsg += ' (server error)';
        flagsContainer.innerHTML = '<div class="feed-empty">' + errMsg + '</div>';
        riskContainer.innerHTML = '';
        if (cardsContainer) cardsContainer.innerHTML = '';
        return;
      }

      var flags = await flagsRes.json();
      var riskScores = await riskRes.json();

      // Render overview cards
      renderAcCards(cardsContainer, flags, riskScores);

      // Render flags table
      if (countEl) countEl.textContent = flags.length + ' flag(s)';
      renderAcFlags(flagsContainer, flags);

      // Render risk scores
      renderAcRiskScores(riskContainer, riskScores);
    } catch (e) {
      flagsContainer.innerHTML = '<div class="feed-empty">Error: ' + esc(e.message) + '</div>';
      riskContainer.innerHTML = '';
    }
  }

  function renderAcCards(container, flags, riskScores) {
    if (!container) return;
    var open = flags.filter(function(f) { return f.status === 'open'; }).length;
    var critical = flags.filter(function(f) { return f.severity === 'critical' || f.severity === 'high'; }).length;
    var atRisk = riskScores.filter(function(r) { return r.risk_score > 0.5; }).length;
    var total = flags.length;

    var cards = [
      { label: 'Open Flags', value: open, color: open > 0 ? 'text-amber-400' : 'text-green-400', icon: 'alert-triangle' },
      { label: 'Critical/High', value: critical, color: critical > 0 ? 'text-red-400' : 'text-green-400', icon: 'alert-octagon' },
      { label: 'At Risk Players', value: atRisk, color: atRisk > 0 ? 'text-orange-400' : 'text-green-400', icon: 'user-x' },
      { label: 'Total Flags', value: total, color: 'text-muted', icon: 'flag' }
    ];

    container.innerHTML = cards.map(function(c) {
      return '<div class="card p-3 flex items-center gap-3">' +
        '<i data-lucide="' + c.icon + '" class="w-6 h-6 ' + c.color + '"></i>' +
        '<div><div class="text-xl font-bold ' + c.color + '">' + c.value + '</div>' +
        '<div class="text-xs text-muted">' + c.label + '</div></div></div>';
    }).join('');
    if (typeof lucide !== 'undefined') lucide.createIcons({ attrs: { class: '' } });
  }

  var AC_SEVERITY_COLORS = { critical: 'bg-red-500/20 text-red-400', high: 'bg-orange-500/20 text-orange-400', medium: 'bg-amber-500/20 text-amber-400', low: 'bg-blue-500/20 text-blue-400', info: 'bg-gray-500/20 text-gray-400' };
  var AC_STATUS_COLORS = { open: 'bg-amber-500/20 text-amber-400', confirmed: 'bg-red-500/20 text-red-400', dismissed: 'bg-gray-500/20 text-gray-400', whitelisted: 'bg-green-500/20 text-green-400' };

  function renderAcFlags(container, flags) {
    if (!flags.length) { container.innerHTML = '<div class="feed-empty">No flags found</div>'; return; }

    var html = '<table class="db-table"><thead><tr>' +
      '<th>Severity</th><th>Detector</th><th>Player</th><th>Score</th><th>Status</th><th>Created</th><th>Actions</th>' +
      '</tr></thead><tbody>';

    for (var i = 0; i < flags.length; i++) {
      var f = flags[i];
      var sevClass = AC_SEVERITY_COLORS[f.severity] || '';
      var statClass = AC_STATUS_COLORS[f.status] || '';
      var details = '';
      try { details = typeof f.details === 'string' ? f.details : JSON.stringify(f.details || {}); } catch (e) { details = ''; }
      var detailsTrunc = details.length > 80 ? details.slice(0, 80) + '...' : details;

      html += '<tr>' +
        '<td><span class="px-1.5 py-0.5 rounded text-xs font-medium ' + sevClass + '">' + esc(f.severity) + '</span></td>' +
        '<td class="text-xs font-mono">' + esc(f.detector) + '</td>' +
        '<td>' + esc(f.player_name || f.steam_id || '-') + '</td>' +
        '<td class="font-mono text-xs">' + (f.score != null ? f.score.toFixed(3) : '-') + '</td>' +
        '<td><span class="px-1.5 py-0.5 rounded text-xs font-medium ' + statClass + '">' + esc(f.status) + '</span></td>' +
        '<td class="text-xs text-muted" title="' + esc(details) + '">' + (f.created_at ? new Date(f.created_at).toLocaleString('en-US', { hour12: false }) : '-') + '</td>' +
        '<td class="flex gap-1">';

      if (f.status === 'open') {
        html += '<button class="ac-review-btn btn-secondary text-xs px-1.5 py-0.5" data-id="' + f.id + '" data-action="confirmed" title="Confirm flag">✓</button>';
        html += '<button class="ac-review-btn btn-secondary text-xs px-1.5 py-0.5" data-id="' + f.id + '" data-action="dismissed" title="Dismiss flag">✗</button>';
        html += '<button class="ac-review-btn btn-secondary text-xs px-1.5 py-0.5" data-id="' + f.id + '" data-action="whitelisted" title="Whitelist">☆</button>';
      } else {
        html += '<span class="text-xs text-muted">' + esc(f.reviewed_by ? 'by ' + f.reviewed_by : '-') + '</span>';
      }
      html += '</td></tr>';

      // Expandable details row
      if (detailsTrunc) {
        html += '<tr class="bg-surface-50/30"><td colspan="7" class="text-xs text-muted font-mono p-1 pl-4">' + esc(detailsTrunc) + '</td></tr>';
      }
    }

    html += '</tbody></table>';
    container.innerHTML = html;

    // Wire review buttons
    container.querySelectorAll('.ac-review-btn').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var flagId = btn.dataset.id;
        var action = btn.dataset.action;
        var notes = '';
        if (action === 'dismissed') {
          notes = prompt('Dismissal reason (optional):') || '';
        }
        reviewAcFlag(flagId, action, notes);
      });
    });
  }

  function renderAcRiskScores(container, scores) {
    if (!scores.length) { container.innerHTML = '<div class="feed-empty">No player risk data</div>'; return; }

    var html = '<table class="db-table"><thead><tr>' +
      '<th>Player</th><th>Risk Score</th><th>Open</th><th>Confirmed</th><th>Dismissed</th><th>Last Flag</th>' +
      '</tr></thead><tbody>';

    for (var i = 0; i < scores.length; i++) {
      var s = scores[i];
      var riskPct = Math.round((s.risk_score || 0) * 100);
      var riskColor = riskPct >= 70 ? 'text-red-400' : riskPct >= 40 ? 'text-amber-400' : 'text-green-400';
      var barColor = riskPct >= 70 ? 'bg-red-400' : riskPct >= 40 ? 'bg-amber-400' : 'bg-green-400';
      var riskPlayerName = '';
      if (s.steam_id) { var rp = S.players.find(function(p) { return p.steamId === s.steam_id; }); if (rp) riskPlayerName = rp.name; }

      html += '<tr>' +
        '<td class="font-medium"><span class="player-link cursor-pointer hover:underline" data-steam-id="' + esc(s.steam_id) + '">' + esc(riskPlayerName || s.steam_id) + '</span></td>' +
        '<td><div class="flex items-center gap-2"><div class="w-16 h-1.5 bg-surface-100 rounded-full overflow-hidden"><div class="h-full ' + barColor + ' rounded-full" style="width:' + riskPct + '%"></div></div><span class="font-mono text-xs ' + riskColor + '">' + riskPct + '%</span></div></td>' +
        '<td class="font-mono text-xs">' + (s.open_flags || 0) + '</td>' +
        '<td class="font-mono text-xs">' + (s.confirmed_flags || 0) + '</td>' +
        '<td class="font-mono text-xs">' + (s.dismissed_flags || 0) + '</td>' +
        '<td class="text-xs text-muted">' + (s.last_flag_at ? new Date(s.last_flag_at).toLocaleString('en-US', { hour12: false }) : '-') + '</td>' +
        '</tr>';
    }
    html += '</tbody></table>';
    container.innerHTML = html;
  }

  async function reviewAcFlag(flagId, status, notes) {
    try {
      var r = await apiFetch('/api/panel/anticheat/flags/' + flagId + '/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: status, notes: notes || '' })
      });
      if (!r.ok) {
        var err = {};
        try { err = await r.json(); } catch (e) {  }
        alert('Review failed: ' + (err.error || r.statusText));
        return;
      }
      // Reload
      loadAnticheat();
    } catch (e) {
      alert('Review failed: ' + e.message);
    }
  }

  // Wire anticheat filter controls
  (function() {
    var sf = $('#ac-status-filter');
    var svf = $('#ac-severity-filter');
    var rb = $('#ac-refresh');
    if (sf) sf.addEventListener('change', function() { if (S.currentTab === 'anticheat') loadAnticheat(); });
    if (svf) svf.addEventListener('change', function() { if (S.currentTab === 'anticheat') loadAnticheat(); });
    if (rb) rb.addEventListener('click', function() { if (S.currentTab === 'anticheat') loadAnticheat(); });
  })();

  // ══════════════════════════════════════════════════
  //  COPY IP
  // ══════════════════════════════════════════════════

  function setupCopyBtn(btnSel, textSel) {
    var btn = $(btnSel);
    var textEl = $(textSel);
    if (!btn || !textEl) return;
    btn.addEventListener('click', async function(e) {
      e.preventDefault();
      e.stopPropagation();
      var text = textEl.textContent.trim();
      if (!text || text === '-') return;
      try {
        await navigator.clipboard.writeText(text);
        showCopyFeedback(btn);
      } catch (err) {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.left = '-999px';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); showCopyFeedback(btn); } catch (e2) { /* silent */ }
        document.body.removeChild(ta);
      }
    });
  }

  function showCopyFeedback(btn) {
    // Works with both Lucide <i> elements and raw <svg>
    var icon = btn.querySelector('svg') || btn.querySelector('i[data-lucide]');
    if (icon) {
      var origHtml = icon.outerHTML;
      icon.outerHTML = '<i data-lucide="check" class="w-4 h-4 text-calm"></i>';
      if (window.lucide) lucide.createIcons({ nodes: [btn] });
      setTimeout(function() {
        var check = btn.querySelector('svg') || btn.querySelector('i[data-lucide]');
        if (check) { check.outerHTML = origHtml; if (window.lucide) lucide.createIcons({ nodes: [btn] }); }
      }, 1500);
    }
  }

  // ══════════════════════════════════════════════════
  //  CLICK-TO-PROFILE DELEGATION
  // ══════════════════════════════════════════════════

  document.addEventListener('click', function(e) {
    // Player link click → open player modal
    var link = e.target.closest('.player-link');
    if (link) {
      e.preventDefault();
      var steamId = link.dataset.steamId;
      var name = link.textContent;
      var player = S.players.find(function(p) {
        return (steamId && p.steamId === steamId) ||
          (name && p.name === name) ||
          (name && p.name && p.name.toLowerCase() === name.toLowerCase());
      });
      if (player) showPlayerModal(player);
      else if (steamId) fetchAndShowPlayer(steamId);
      else {
        // No steamId and not in cached players — show brief toast
        showToast('Player "' + (name || 'Unknown') + '" not found in player data', 2500);
      }
      return;
    }

    // Inventory item click → show item popup
    var slot = e.target.closest('.inv-clickable');
    if (slot) {
      e.preventDefault();
      showItemPopup(slot);
      return;
    }

    // Activity cross-reference click → navigate to activity tab with filter
    var actLink = e.target.closest('.activity-link');
    if (actLink) {
      e.preventDefault();
      var actSearch = actLink.dataset.search || '';
      var actType = actLink.dataset.type || '';
      var as = $('#activity-search');
      if (as) as.value = actSearch;
      var af = $('#activity-filter');
      if (af && actType) af.value = actType;
      // Close any open popup/modal before navigating
      var openPopup = document.querySelector('.item-popup');
      if (openPopup) openPopup.remove();
      var openModal = $('#player-modal');
      if (openModal && !openModal.classList.contains('hidden')) openModal.classList.add('hidden');
      switchTab('activity');
      // Force reload with the pre-populated filters
      setTimeout(function() { resetActivityPaging(); loadActivity(); }, 100);
      return;
    }

    // Close item popup via close button
    var popupClose = e.target.closest('.item-popup-close');
    if (popupClose) {
      var popup = popupClose.closest('.item-popup');
      if (popup) popup.remove();
      return;
    }

    // DB cross-reference click → navigate to related data
    var dbLink = e.target.closest('.db-link');
    if (dbLink) {
      e.preventDefault();
      var table = dbLink.dataset.table;
      var search = dbLink.dataset.search;
      if (table) {
        var sel = $('#db-table');
        if (sel) { sel.value = table; }
        var srch = $('#db-search');
        if (srch) { srch.value = search || ''; }
        // Close any open popup/modal before navigating
        var openPopup2 = document.querySelector('.item-popup');
        if (openPopup2) openPopup2.remove();
        var openModal2 = $('#player-modal');
        if (openModal2 && !openModal2.classList.contains('hidden')) openModal2.classList.add('hidden');
        switchTab('database');
        setTimeout(loadDatabase, 100);
      }
      return;
    }

    // Entity link click → show entity info popup (or navigate for clans)
    var entLink = e.target.closest('.entity-link:not(.player-link)');
    if (entLink) {
      e.preventDefault();
      e.stopPropagation();
      var eTable = entLink.dataset.entityTable;
      var eSearch = entLink.dataset.entitySearch;
      if (eTable === 'clans' && eSearch) {
        var openPopup3 = document.querySelector('.item-popup');
        if (openPopup3) openPopup3.remove();
        var openModal3 = $('#player-modal');
        if (openModal3 && !openModal3.classList.contains('hidden')) openModal3.classList.add('hidden');
        switchTab('clans');
        setTimeout(function() {
          var cs = $('#clan-search');
          if (cs) { cs.value = eSearch; cs.dispatchEvent(new Event('input')); }
        }, 100);
      } else if (eSearch) {
        showEntityPopup(entLink, eSearch, eTable);
      }
      return;
    }

    // Item popup close button
    var popupClose = e.target.closest('.item-popup-close');
    if (popupClose) {
      var parentPopup = popupClose.closest('.item-popup');
      if (parentPopup) parentPopup.remove();
      return;
    }

    // Close item popup on outside click
    var popup = document.querySelector('.item-popup');
    if (popup && !e.target.closest('.item-popup') && !e.target.closest('.inv-clickable')) {
      popup.remove();
    }
  });

  // ══════════════════════════════════════════════════
  //  ESCAPE KEY — close modals/popups
  // ══════════════════════════════════════════════════

  document.addEventListener('keydown', function(e) {
    if (e.key !== 'Escape') return;
    // Item popup
    var popup = document.querySelector('.item-popup');
    if (popup) { popup.remove(); return; }
    // Settings diff modal
    var sdm = $('#settings-diff-modal');
    if (sdm && !sdm.classList.contains('hidden')) { sdm.classList.add('hidden'); return; }
    // Player modal
    var pm = $('#player-modal');
    if (pm && !pm.classList.contains('hidden')) { pm.classList.add('hidden'); setBreadcrumbs([{ label: TAB_LABELS[S.currentTab] || S.currentTab }]); return; }
    // Item detail modal
    var idm = $('#item-detail-modal');
    if (idm && !idm.classList.contains('hidden')) { idm.classList.add('hidden'); setBreadcrumbs([{ label: TAB_LABELS[S.currentTab] || S.currentTab }]); return; }
    // Map detail panel
    var mdp = $('#map-player-detail');
    if (mdp && !mdp.classList.contains('hidden')) { mdp.classList.add('hidden'); return; }
  });

  function showItemPopup(slot) {
    // Remove any existing popup
    var old = document.querySelector('.item-popup');
    if (old) old.remove();

    var name = slot.dataset.itemName || 'Unknown';
    var qty = slot.dataset.itemQty || '';
    var dur = slot.dataset.itemDur || '';
    var fp = slot.dataset.itemFp || '';
    var ammo = slot.dataset.itemAmmo || '';
    var attachStr = slot.dataset.itemAttach || '';
    var maxDur = slot.dataset.itemMaxdur || '';

    // Parse attachments
    var attachments = [];
    if (attachStr) { try { attachments = JSON.parse(attachStr); } catch(e) {} }

    // Determine the player context (whose inventory is this item in?)
    var contextSteamId = '';
    var parentContent = slot.closest('#player-modal-content, #map-detail-content');
    if (parentContent) contextSteamId = parentContent.dataset.steamId || '';

    // Count how many players have this item (client-side scan)
    var owners = [];
    for (var i = 0; i < S.players.length; i++) {
      var p = S.players[i];
      var count = countItemInPlayer(p, name);
      if (count > 0) owners.push({ name: p.name, steamId: p.steamId, count: count });
    }
    owners.sort(function(a, b) { return b.count - a.count; });

    // If this specific item has a fingerprint, identify who holds THIS instance
    var isTrackedInstance = !!fp;
    var instanceHolder = '';
    if (isTrackedInstance && contextSteamId) {
      var holder = S.players.find(function(p) { return p.steamId === contextSteamId; });
      if (holder) instanceHolder = holder.name;
    }

    var popup = document.createElement('div');
    popup.className = 'item-popup';

    // Build header with close button
    var html = '<div class="item-popup-header">' + esc(name) + '<span class="item-popup-close" style="cursor:pointer;color:#c45a4a;font-size:14px;line-height:1;padding:2px 4px;border-radius:3px;margin:-2px -4px -2px 0" title="Close">&times;</span></div>';
    html += '<div class="item-popup-body">';

    // Instance badge — highlight that this is a tracked specific item
    if (isTrackedInstance) {
      html += '<div class="text-[10px] font-medium text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded px-2 py-1 mb-2 flex items-center gap-1">';
      html += '\ud83d\udd0d Tracked Instance';
      if (instanceHolder) html += ' \u2014 held by <span class="player-link cursor-pointer hover:underline text-accent" data-steam-id="' + esc(contextSteamId) + '">' + esc(instanceHolder) + '</span>';
      html += '</div>';
    }

    // Basic stats grid
    html += '<div class="grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs mb-2">';
    if (qty) html += '<div><span class="text-muted">Quantity:</span> ' + qty + '</div>';
    if (dur) {
      var durN = parseInt(dur, 10);
      var durCol = durN > 60 ? 'text-emerald-400' : durN > 25 ? 'text-amber-400' : 'text-red-400';
      html += '<div><span class="text-muted">Durability:</span> <span class="' + durCol + '">' + dur + '%</span>';
      if (maxDur) html += ' <span class="text-muted text-[10px]">(max ' + parseFloat(maxDur).toFixed(1) + ')</span>';
      html += '</div>';
    }
    if (ammo) html += '<div><span class="text-muted">Ammo:</span> ' + ammo + '</div>';
    if (fp) html += '<div><span class="text-muted">Fingerprint:</span> <span class="font-mono text-[10px]">' + esc(fp) + '</span></div>';
    html += '</div>';

    // Attachments
    if (attachments.length > 0) {
      html += '<div class="text-xs mb-2"><span class="text-muted">Attachments:</span> <span class="text-accent">' + attachments.map(function(a) { return esc(a); }).join(', ') + '</span></div>';
    }

    // Owners section — for tracked instances, show as "Other holders of this item type" (secondary)
    if (owners.length > 0) {
      if (isTrackedInstance) {
        html += '<div class="text-xs text-muted mt-1 mb-1">' + owners.length + ' player' + (owners.length > 1 ? 's' : '') + ' hold' + (owners.length === 1 ? 's' : '') + ' ' + esc(name) + ':</div>';
      } else {
        html += '<div class="text-xs text-muted mt-1 mb-1">Held by ' + owners.length + ' player' + (owners.length > 1 ? 's' : '') + ':</div>';
      }
      html += '<div class="item-popup-owners">';
      for (var oi = 0; oi < Math.min(owners.length, 6); oi++) {
        html += '<div class="text-xs"><span class="player-link cursor-pointer hover:underline text-accent" data-steam-id="' + esc(owners[oi].steamId) + '">' + esc(owners[oi].name) + '</span> <span class="text-muted">\u00d7' + owners[oi].count + '</span></div>';
      }
      if (owners.length > 6) html += '<div class="text-[10px] text-muted">+' + (owners.length - 6) + ' more</div>';
      html += '</div>';
    }

    // Tracking data container — will be populated async (prioritizes fingerprint-specific data)
    html += '<div id="item-tracking-data" class="mt-2 border-t border-border/30 pt-2">';
    if (fp) {
      html += '<div class="text-[10px] text-muted">Loading instance history...</div>';
    } else if (name) {
      html += '<div class="text-[10px] text-muted">Loading tracking data...</div>';
    }
    html += '</div>';

    // Quick links
    html += '<div class="mt-2 flex gap-2 flex-wrap">';
    var actSearchVal = fp ? name + '#' + fp : name;
    html += '<span class="activity-link text-[10px] text-accent hover:underline cursor-pointer" data-search="' + esc(actSearchVal) + '">' + (fp ? '\ud83d\udd0d Track item' : 'Activity log') + ' \u2192</span>';
    if (S.tier >= 3) { // admin
      var dbSearch = fp || name;
      html += '<span class="db-link text-[10px] text-accent hover:underline cursor-pointer" data-table="item_instances" data-search="' + esc(dbSearch) + '">Item DB \u2192</span>';
      html += '<span class="db-link text-[10px] text-accent hover:underline cursor-pointer" data-table="item_movements" data-search="' + esc(dbSearch) + '">Movements \u2192</span>';
    }
    html += '</div>';
    html += '</div>';
    popup.innerHTML = html;

    // Position near the slot, then clamp to viewport
    var rect = slot.getBoundingClientRect();
    popup.style.position = 'fixed';
    popup.style.left = Math.min(rect.right + 8, window.innerWidth - 320) + 'px';
    popup.style.top = Math.max(rect.top - 20, 8) + 'px';
    popup.style.zIndex = '10000';
    popup.style.maxWidth = '320px';
    document.body.appendChild(popup);
    clampToViewport(popup);

    // Async: Fetch tracking data from item fingerprint API
    if (fp || name) {
      _fetchItemTrackingData(fp, name, contextSteamId);
    }
  }

  /** Fetch item tracking data from the fingerprint API and update the popup */
  async function _fetchItemTrackingData(fingerprint, itemName, steamId) {
    var container = document.getElementById('item-tracking-data');
    if (!container) return;

    try {
      var params = [];
      if (fingerprint) params.push('fingerprint=' + encodeURIComponent(fingerprint));
      if (itemName) params.push('item=' + encodeURIComponent(itemName));
      if (steamId) params.push('steamId=' + encodeURIComponent(steamId));
      var url = '/api/panel/items/lookup?' + params.join('&');

      var r = await apiFetch(url);
      if (!r.ok) {
        container.innerHTML = '<div class="text-[10px] text-muted">No tracking data available</div>';
        return;
      }

      var data = await r.json();
      if (!data.match) {
        container.innerHTML = '<div class="text-[10px] text-muted">Not yet tracked by fingerprint system</div>';
        return;
      }

      var html = '';
      var m = data.match;

      // Instance/group identity
      html += '<div class="text-[10px] font-semibold text-white mb-1">';
      html += data.matchType === 'group' ? '\ud83d\udce6 Fungible Group' : '\ud83d\udd0d Tracked Instance';
      html += ' #' + m.id + '</div>';

      // Tracking metadata
      html += '<div class="grid grid-cols-2 gap-x-2 gap-y-0.5 text-[10px] mb-1.5">';
      if (m.first_seen) html += '<div><span class="text-muted">First seen:</span> ' + _timeAgo(m.first_seen) + ' ago</div>';
      if (m.last_seen) html += '<div><span class="text-muted">Last seen:</span> ' + _timeAgo(m.last_seen) + ' ago</div>';
      if (data.matchType === 'group') {
        html += '<div><span class="text-muted">Qty tracked:</span> ' + (m.quantity || 0) + '</div>';
      }
      html += '<div><span class="text-muted">Movements:</span> ' + data.totalMovements + '</div>';
      html += '</div>';

      // Ownership chain
      if (data.ownershipChain && data.ownershipChain.length > 0) {
        html += '<div class="text-[10px] text-muted mb-0.5">Ownership chain:</div>';
        html += '<div class="flex flex-wrap gap-1 mb-1.5">';
        for (var oi = 0; oi < Math.min(data.ownershipChain.length, 8); oi++) {
          var owner = data.ownershipChain[oi];
          html += '<span class="player-link cursor-pointer hover:underline inline-flex items-center gap-0.5 px-1 py-0.5 rounded text-[10px] bg-emerald-500/15 text-emerald-400 border border-emerald-500/30" data-steam-id="' + esc(owner.steamId) + '">';
          html += esc(owner.name);
          html += '</span>';
          if (oi < Math.min(data.ownershipChain.length, 8) - 1) html += '<span class="text-muted text-[10px]">\u2192</span>';
        }
        if (data.ownershipChain.length > 8) html += '<span class="text-[10px] text-muted">+' + (data.ownershipChain.length - 8) + ' more</span>';
        html += '</div>';
      }

      // Recent movements (last 5)
      var movements = data.movements || [];
      if (movements.length > 0) {
        var showCount = Math.min(movements.length, 5);
        html += '<div class="text-[10px] text-muted mb-0.5">Recent movements:</div>';
        html += '<div class="space-y-0.5 max-h-28 overflow-y-auto">';
        // Show most recent first
        var recentMovements = movements.slice(-showCount).reverse();
        for (var mi = 0; mi < recentMovements.length; mi++) {
          var mv = recentMovements[mi];
          html += '<div class="flex items-center gap-1 text-[10px] py-0.5">';
          html += '<span class="text-muted font-mono shrink-0">' + _timeAgo(mv.created_at) + '</span>';
          html += _locationBadgeMini(mv.from_type, mv.from_id, mv.from_name);
          html += '<span class="text-muted">\u2192</span>';
          html += _locationBadgeMini(mv.to_type, mv.to_id, mv.to_name);
          if (mv.attributed_name) {
            html += '<span class="text-calm ml-auto player-link cursor-pointer hover:underline" data-steam-id="' + esc(mv.attributed_steam_id || '') + '">' + esc(mv.attributed_name) + '</span>';
          }
          html += '</div>';
        }
        html += '</div>';
        if (movements.length > 5) {
          html += '<div class="text-[10px] text-muted mt-0.5">' + (movements.length - 5) + ' more movements \u2014 ';
          html += '<span class="text-accent cursor-pointer hover:underline" onclick="if(S.tier>=3){switchTab(\'items\');}">';
          html += 'view in Items tab</span></div>';
        }
      }

      container.innerHTML = html;
    } catch (err) {
      container.innerHTML = '<div class="text-[10px] text-muted">Tracking data unavailable</div>';
    }
  }

  /** Mini location badge for item popup movement history */
  function _locationBadgeMini(type, id, resolvedName) {
    var colors = {
      player: 'text-emerald-400',
      container: 'text-purple-400',
      vehicle: 'text-amber-400',
      horse: 'text-pink-400',
      structure: 'text-blue-400',
      world_drop: 'text-gray-400',
      backpack: 'text-orange-400',
      global_container: 'text-indigo-400',
    };
    var cls = colors[type] || 'text-muted';
    var label = resolvedName || _shortenId(id);
    if (type === 'player') {
      return '<span class="' + cls + ' player-link cursor-pointer hover:underline" data-steam-id="' + esc(id || '') + '">' + esc(label) + '</span>';
    }
    if ((type === 'container' || type === 'vehicle' || type === 'structure' || type === 'horse') && id) {
      var entityTable = type === 'horse' ? 'world_horses' : type + 's';
      return '<span class="' + cls + ' entity-link cursor-pointer hover:underline" data-entity-table="' + entityTable + '" data-entity-search="' + esc(id) + '">' + esc(_formatLocationType(type)) + ':' + esc(label) + '</span>';
    }
    return '<span class="' + cls + '">' + esc(_formatLocationType(type)) + ':' + esc(label) + '</span>';
  }

  function countItemInPlayer(player, itemName) {
    var count = 0;
    var bags = [player.equipment, player.quickSlots, player.inventory, player.backpackItems];
    for (var b = 0; b < bags.length; b++) {
      var bag = bags[b];
      if (!bag) continue;
      for (var i = 0; i < bag.length; i++) {
        var item = bag[i];
        if (!item) continue;
        var n = typeof item === 'string' ? item : (item.item || item.name || '');
        if (n === itemName) count += (typeof item === 'object' ? (item.amount || item.quantity || 1) : 1);
      }
    }
    return count;
  }

  async function fetchAndShowPlayer(steamId) {
    try {
      var r = await apiFetch('/api/players/' + steamId);
      if (r.ok) { var p = await r.json(); showPlayerModal(p); }
    } catch (e) { /* silent */ }
  }

  // ── Entity info popup (items, structures, vehicles, animals, etc.) ──

  var ENTITY_TABLE_TO_TYPE = {
    item_instances: 'item', game_items: 'item', item_movements: 'item', item_groups: 'item',
    structures: 'structure', game_buildings: 'structure',
    vehicles: 'vehicle', game_vehicles_ref: 'vehicle',
    containers: 'container',
    world_horses: 'animal', game_animals: 'animal', companions: 'animal',
    game_recipes: 'recipe',
    game_afflictions: 'affliction',
    game_skills: 'skill',
    activity_log: 'item',
  };

  // Properties to hide in entity popups (internal/noisy fields)
  var ENTITY_HIDE_KEYS = new Set([
    'id', 'rowid', 'created_at', 'updated_at', 'raw_name', 'blueprint_path',
    'category_raw', 'categoryRaw', 'effects', 'attributeModifiers', 'skillModifiers',
    'icon_path', 'mesh_path', 'thumbnail_path',
  ]);

  function _formatEntityValue(key, val) {
    if (val == null || val === '') return null;
    if (typeof val === 'boolean') return val ? 'Yes' : 'No';
    if (typeof val === 'number') {
      if (key.toLowerCase().includes('percent') || key.toLowerCase().includes('multiplier')) return val.toFixed(2);
      if (val !== Math.floor(val)) return val.toFixed(2);
      return fmtNum(val);
    }
    var s = String(val);
    if (s.length > 200) return s.slice(0, 200) + '\u2026';
    return s;
  }

  function _formatEntityKey(key) {
    return key.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\b\w/g, function(c) { return c.toUpperCase(); });
  }

  function showEntityPopup(triggerEl, name, table) {
    var old = document.querySelector('.item-popup');
    if (old) old.remove();

    var type = ENTITY_TABLE_TO_TYPE[table] || 'item';

    var popup = document.createElement('div');
    popup.className = 'item-popup';

    var html = '<div class="item-popup-header">' + esc(name) + '<span class="item-popup-close" style="cursor:pointer;color:#c45a4a;font-size:14px;line-height:1;padding:2px 4px;border-radius:3px;margin:-2px -4px -2px 0" title="Close">&times;</span></div>';
    html += '<div class="item-popup-body">';
    html += '<div class="text-[10px] text-muted mb-1">' + _formatEntityKey(type) + '</div>';
    html += '<div id="entity-popup-data"><div class="text-[10px] text-muted">Loading\u2026</div></div>';

    // Quick links
    html += '<div class="mt-2 flex gap-2 flex-wrap" id="entity-popup-links">';
    html += '<span class="activity-link text-[10px] text-accent hover:underline cursor-pointer" data-search="' + esc(name) + '">Activity log \u2192</span>';
    html += '</div>';

    html += '</div>';
    popup.innerHTML = html;

    var rect = triggerEl.getBoundingClientRect();
    popup.style.position = 'fixed';
    popup.style.left = Math.min(rect.right + 8, window.innerWidth - 320) + 'px';
    popup.style.top = Math.max(rect.top - 20, 8) + 'px';
    popup.style.zIndex = '10000';
    popup.style.maxWidth = '340px';
    document.body.appendChild(popup);
    clampToViewport(popup);

    // Fetch entity data
    _fetchEntityData(name, type, table);
  }

  async function _fetchEntityData(name, type, table) {
    var container = document.getElementById('entity-popup-data');
    var linksContainer = document.getElementById('entity-popup-links');
    if (!container) return;

    try {
      var r = await (typeof authFetch === 'function' ? authFetch : apiFetch)('/api/panel/lookup/' + encodeURIComponent(type) + '/' + encodeURIComponent(name));
      if (!r.ok) { container.innerHTML = '<div class="text-[10px] text-muted">No data available</div>'; return; }
      var result = await r.json();

      if (!result.found) {
        container.innerHTML = '<div class="text-[10px] text-muted">Not found in game reference data</div>';
        if (result.activityCount > 0) {
          container.innerHTML += '<div class="text-[10px] text-muted mt-1">' + fmtNum(result.activityCount) + ' activity log references</div>';
        }
        return;
      }

      var data = result.data;
      var html = '<div class="grid gap-y-0.5 text-xs" style="grid-template-columns: auto 1fr">';
      var shown = 0;
      for (var key in data) {
        if (ENTITY_HIDE_KEYS.has(key)) continue;
        var val = _formatEntityValue(key, data[key]);
        if (val == null) continue;
        html += '<div class="text-muted pr-2 whitespace-nowrap">' + esc(_formatEntityKey(key)) + '</div>';
        html += '<div class="text-gray-300 truncate" title="' + esc(val) + '">' + esc(val) + '</div>';
        shown++;
        if (shown >= 16) { html += '<div class="text-muted text-[10px] col-span-2 mt-1">\u2026and more</div>'; break; }
      }
      html += '</div>';

      if (result.activityCount > 0) {
        html += '<div class="text-[10px] text-muted mt-1.5">' + fmtNum(result.activityCount) + ' activity log references</div>';
      }

      container.innerHTML = html;

      // Add DB links for admins
      if (S.tier >= 3 && linksContainer && result.refTable) {
        linksContainer.innerHTML += '<span class="db-link text-[10px] text-accent hover:underline cursor-pointer" data-table="' + esc(result.refTable) + '" data-search="' + esc(name) + '">View in DB \u2192</span>';
      }
    } catch (e) {
      container.innerHTML = '<div class="text-[10px] text-muted">Failed to load data</div>';
    }
  }

  // ══════════════════════════════════════════════════
  //  UTILITIES
  // ══════════════════════════════════════════════════

  function esc(str) {
    if (!str) return '';
    var div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
  }

  /** Strip RCON color tags (<SP>, <FO>, <PN>, <PR>, <CL>, </>) from text */
  function stripRconTags(str) {
    if (!str) return '';
    return String(str).replace(/<(?:PN|PR|SP|FO|CL|\/)>/g, '').trim();
  }

  /** Show a brief toast notification at the bottom of the screen */
  function showToast(message, duration) {
    var t = el('div', 'fixed bottom-4 left-1/2 -translate-x-1/2 bg-surface-200 border border-border text-text text-xs px-4 py-2 rounded-lg shadow-lg z-[10001] fade-in');
    t.textContent = message;
    document.body.appendChild(t);
    setTimeout(function() { t.remove(); }, duration || 3000);
  }

  /** Clamp a popup element within the viewport so it never goes off-screen */
  function clampToViewport(popup) {
    requestAnimationFrame(function() {
      var rect = popup.getBoundingClientRect();
      var pad = 8;
      if (rect.right > window.innerWidth - pad) popup.style.left = Math.max(pad, window.innerWidth - rect.width - pad) + 'px';
      if (rect.bottom > window.innerHeight - pad) popup.style.top = Math.max(pad, window.innerHeight - rect.height - pad) + 'px';
      if (rect.left < pad) popup.style.left = pad + 'px';
      if (rect.top < pad) popup.style.top = pad + 'px';
    });
  }

  /**
   * Render a clickable entity link for any game-world object.
   * Clicking navigates to the DB tab filtered for that entity.
   * @param {string} name - Display name
   * @param {string} [type] - Entity type hint: 'item','player','vehicle','container','structure','building','animal','ai'
   * @param {object} [opts] - { steamId, table, search, cls }
   */
  function entityLink(name, type, opts) {
    if (!name) return '';
    opts = opts || {};
    var escaped = esc(name);
    // Players — use player-link with steam ID
    if (type === 'player') {
      return '<span class="player-link entity-link cursor-pointer hover:underline text-accent" data-steam-id="' + esc(opts.steamId || '') + '">' + escaped + '</span>';
    }
    // Everything else — use entity-link which navigates to DB tab
    var table = opts.table || '';
    var search = opts.search || name;
    if (!table) {
      // Infer table from type
      if (type === 'item') table = 'item_instances';
      else if (type === 'vehicle') table = 'vehicles';
      else if (type === 'container') table = 'containers';
      else if (type === 'structure' || type === 'building') table = 'structures';
      else if (type === 'animal') table = 'game_animals';
      else if (type === 'ai' || type === 'zombie') table = 'activity_log';
      else table = 'activity_log';
    }
    var cls = opts.cls || 'text-accent';
    return '<span class="entity-link cursor-pointer hover:underline ' + cls + '" data-entity-table="' + esc(table) + '" data-entity-search="' + esc(search) + '">' + escaped + '</span>';
  }

  function formatPlaytime(minutes) {
    if (!minutes) return '0m';
    if (minutes < 60) return minutes + 'm';
    var h = Math.floor(minutes / 60);
    var m = minutes % 60;
    return m > 0 ? h + 'h ' + m + 'm' : h + 'h';
  }

  function fmtNum(n) {
    if (n == null) return '0';
    return Number(n).toLocaleString('en-US');
  }

  function humanizeSettingKey(key) {
    if (!key) return '';
    return key.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').replace(/\b\w/g, function(c) { return c.toUpperCase(); });
  }

  function debounce(fn, ms) {
    var timer;
    return function() {
      var args = arguments;
      clearTimeout(timer);
      timer = setTimeout(function() { fn.apply(null, args); }, ms);
    };
  }

  // ══════════════════════════════════════════════════
  //  TIMELINE — time-scroll playback of world state
  // ══════════════════════════════════════════════════

  var TL = {
    map: null, ready: false,
    snapshots: [],   // metadata list
    idx: -1,         // current index in snapshots[]
    data: null,      // full entity data for current snapshot
    playing: false,
    timer: null,
    speed: 5,
    layers: {},      // L.layerGroup per entity type
    visible: { players:true, zombies:true, animals:true, bandits:true, vehicles:true, structures:false, companions:true, backpacks:false, deaths:true },
    deathMarkers: null,
    nameMap: {},
  };

  function tlIcon(color, size, shape, title) {
    var css = shape === 'diamond'
      ? 'width:'+size+'px;height:'+size+'px;transform:rotate(45deg);border-radius:2px;'
      : shape === 'square'
        ? 'width:'+size+'px;height:'+size+'px;border-radius:2px;'
        : 'width:'+size+'px;height:'+size+'px;border-radius:50%;';
    return L.divIcon({
      className: 'tl-marker',
      html: '<div style="'+css+'background:'+color+';border:1.5px solid rgba(255,255,255,0.35);box-shadow:0 0 4px '+color+'60" title="'+(title||'')+'"></div>',
      iconSize: [size, size], iconAnchor: [size/2, size/2],
    });
  }

  async function initTimeline() {
    // Init map
    if (!TL.ready) {
      var c = $('#tl-map');
      if (!c || !window.L) return;
      TL.map = L.map(c, { crs: L.CRS.Simple, minZoom: -2, maxZoom: 4, zoomControl: true, attributionControl: false });
      L.imageOverlay('/terrain.png', [[0,0],[4096,4096]], { className: 'map-terrain' }).addTo(TL.map);
      TL.map.fitBounds([[0,0],[4096,4096]]);

      // Create layer groups
      ['players','zombies','animals','bandits','vehicles','structures','companions','backpacks','deaths'].forEach(function(k) {
        TL.layers[k] = L.layerGroup();
        if (TL.visible[k]) TL.layers[k].addTo(TL.map);
      });

      // Wire controls
      var playBtn = $('#tl-play');
      if (playBtn) playBtn.addEventListener('click', tlTogglePlay);
      var stepBack = $('#tl-step-back');
      if (stepBack) stepBack.addEventListener('click', function() { tlStop(); tlStep(-1); });
      var stepFwd = $('#tl-step-fwd');
      if (stepFwd) stepFwd.addEventListener('click', function() { tlStop(); tlStep(1); });
      var latest = $('#tl-go-latest');
      if (latest) latest.addEventListener('click', function() { tlStop(); tlGoTo(TL.snapshots.length - 1); });
      var slider = $('#tl-slider');
      if (slider) slider.addEventListener('input', function() { tlStop(); tlGoTo(parseInt(this.value, 10)); });

      // Speed buttons
      $$('.tl-speed').forEach(function(b) {
        b.addEventListener('click', function() {
          TL.speed = parseInt(this.dataset.speed, 10) || 5;
          $$('.tl-speed').forEach(function(x) { x.classList.toggle('active', parseInt(x.dataset.speed,10) === TL.speed); });
          if (TL.playing) { tlStop(); tlPlay(); }
        });
      });

      // Layer toggles
      ['players','zombies','animals','bandits','vehicles','structures','companions','backpacks','deaths'].forEach(function(k) {
        var cb = $('#tl-l-' + k);
        if (cb) cb.addEventListener('change', function() {
          TL.visible[k] = this.checked;
          if (this.checked) TL.layers[k].addTo(TL.map);
          else TL.map.removeLayer(TL.layers[k]);
          if (TL.data) tlRender();
        });
      });

      // Keyboard
      document.addEventListener('keydown', function(e) {
        if (S.currentTab !== 'timeline') return;
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
        if (e.key === ' ') { e.preventDefault(); tlTogglePlay(); }
        if (e.key === 'ArrowLeft') { e.preventDefault(); tlStop(); tlStep(-1); }
        if (e.key === 'ArrowRight') { e.preventDefault(); tlStop(); tlStep(1); }
        if (e.key === 'End') { e.preventDefault(); tlStop(); tlGoTo(TL.snapshots.length - 1); }
      });

      TL.ready = true;
    }

    // After a brief delay, invalidate map size (tab may not be visible yet)
    setTimeout(function() { if (TL.map) TL.map.invalidateSize(); }, 100);

    // Load snapshot list
    try {
      var bounds = await apiFetch('/api/timeline/bounds').then(function(r) { return r.json(); });
      if (!bounds || !bounds.count) {
        $('#tl-info').textContent = 'No snapshots yet — data records every ' + (5) + ' min';
        return;
      }
      TL.snapshots = await apiFetch('/api/timeline/snapshots?from=' + bounds.earliest + '&to=' + bounds.latest).then(function(r) { return r.json(); });
      if (!TL.snapshots.length) return;

      var slider = $('#tl-slider');
      if (slider) { slider.min = 0; slider.max = TL.snapshots.length - 1; slider.value = TL.snapshots.length - 1; }

      // Load latest snapshot
      tlGoTo(TL.snapshots.length - 1);
      // Load death markers
      tlLoadDeaths();
    } catch (e) {
      console.warn('[TL] Init error:', e);
      $('#tl-info').textContent = 'Timeline unavailable';
    }
  }

  async function tlGoTo(idx) {
    if (idx < 0 || idx >= TL.snapshots.length) return;
    TL.idx = idx;
    var slider = $('#tl-slider');
    if (slider) slider.value = idx;
    tlUpdateInfo();

    try {
      var snap = TL.snapshots[idx];
      TL.data = await apiFetch('/api/timeline/snapshot/' + snap.id).then(function(r) { return r.json(); });
      TL.nameMap = TL.data.nameMap || {};
      tlRender();
    } catch (e) {
      console.warn('[TL] Snapshot load error:', e);
    }
  }

  function tlUpdateInfo() {
    var info = $('#tl-info');
    if (!info) return;
    var s = TL.snapshots[TL.idx];
    if (!s) { info.textContent = 'No data'; return; }
    var d = new Date(s.created_at + (s.created_at.endsWith('Z') ? '' : 'Z'));
    var time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    var date = d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
    var w = s.weather_type || '';
    var sn = s.season || '';
    var day = s.game_day ? 'Day ' + s.game_day : '';
    info.innerHTML = '<b>' + date + ' ' + time + '</b> · ' + day + ' · ' + w + ' · ' + sn +
      ' · 👤' + (s.online_count||0) + '/' + (s.player_count||0) +
      ' 🧟' + (s.ai_count||0) + ' 🚗' + (s.vehicle_count||0) +
      ' 🏗️' + (s.structure_count||0) +
      ' <span class="text-muted text-[10px]">(' + (TL.idx+1) + '/' + TL.snapshots.length + ')</span>';
  }

  function tlRender() {
    if (!TL.data || !TL.map) return;
    var d = TL.data;

    // Clear entity layers (not deaths — those are loaded separately)
    ['players','zombies','animals','bandits','vehicles','structures','companions','backpacks'].forEach(function(k) {
      TL.layers[k].clearLayers();
    });

    // Players
    if (TL.visible.players && d.players) {
      d.players.forEach(function(p) {
        if (p.lat == null) return;
        var online = !!p.online;
        var icon = tlIcon(online ? '#6dba82' : '#7a746c', online ? 14 : 10, 'circle', p.name);
        var m = L.marker([p.lat, p.lng], { icon: icon, zIndexOffset: online ? 1000 : 500 });
        m.bindTooltip((online ? '🟢 ' : '') + p.name, { direction: 'top', offset: [0, -8] });
        m.bindPopup('<div class="tl-popup"><b>' + esc(p.name) + '</b> ' + (online ? '🟢' : '🔴') + '<br>' +
          '❤️ ' + Math.round(p.health||0) + '/' + (p.max_health||100) +
          ' | 🍖 ' + Math.round(p.hunger||0) + ' | 💧 ' + Math.round(p.thirst||0) + '<br>' +
          '🧟 Kills: ' + (p.zeeks_killed||0) + ' | ⭐ Lvl ' + (p.level||0) + '<br>' +
          '📅 Days: ' + (p.days_survived||0) + '</div>');
        m.addTo(TL.layers.players);
      });
    }

    // AI
    if (d.ai) {
      d.ai.forEach(function(a) {
        if (a.lat == null) return;
        var cat = a.category || 'zombie';
        if (cat === 'zombie' && !TL.visible.zombies) return;
        if (cat === 'animal' && !TL.visible.animals) return;
        if (cat === 'bandit' && !TL.visible.bandits) return;
        var icon = cat === 'animal' ? tlIcon('#e67e22', 6, 'diamond') :
                   cat === 'bandit' ? tlIcon('#e74c3c', 7, 'square') :
                   tlIcon('#9b59b6', 5, 'circle');
        var layerKey = cat === 'animal' ? 'animals' : cat === 'bandit' ? 'bandits' : 'zombies';
        var m = L.marker([a.lat, a.lng], { icon: icon });
        m.bindTooltip(a.display_name || a.ai_type, { direction: 'top', offset: [0, -5] });
        m.addTo(TL.layers[layerKey]);
      });
    }

    // Vehicles
    if (TL.visible.vehicles && d.vehicles) {
      d.vehicles.forEach(function(v) {
        if (v.lat == null) return;
        var m = L.marker([v.lat, v.lng], { icon: tlIcon('#3498db', 9, 'square') });
        var name = v.display_name || v.class || 'Vehicle';
        m.bindTooltip(name, { direction: 'top', offset: [0, -7] });
        m.bindPopup('<div class="tl-popup"><b>' + esc(name) + '</b><br>❤️ ' +
          Math.round(v.health||0) + '/' + (v.max_health||0) + '<br>⛽ ' +
          (Math.round((v.fuel||0)*10)/10) + 'L<br>📦 ' + (v.item_count||0) + ' items</div>');
        m.addTo(TL.layers.vehicles);
      });
    }

    // Structures
    if (TL.visible.structures && d.structures) {
      d.structures.forEach(function(s) {
        if (s.lat == null) return;
        var m = L.marker([s.lat, s.lng], { icon: tlIcon('#95a5a6', 4, 'square') });
        var name = s.display_name || s.actor_class || 'Structure';
        var owner = TL.nameMap[s.owner_steam_id] || s.owner_steam_id || '?';
        m.bindTooltip(name, { direction: 'top', offset: [0, -5] });
        m.bindPopup('<div class="tl-popup"><b>' + esc(name) + '</b><br>Owner: ' + esc(owner) +
          '<br>❤️ ' + Math.round(s.current_health||0) + '/' + (s.max_health||0) +
          '<br>⬆️ Tier ' + (s.upgrade_level||0) + '</div>');
        m.addTo(TL.layers.structures);
      });
    }

    // Companions
    if (TL.visible.companions && d.companions) {
      d.companions.forEach(function(c) {
        if (c.lat == null) return;
        var m = L.marker([c.lat, c.lng], { icon: tlIcon('#f1c40f', 7, 'diamond') });
        var name = c.display_name || c.entity_type || 'Companion';
        var owner = TL.nameMap[c.owner_steam_id] || '';
        m.bindTooltip(name + (owner ? ' (' + owner + ')' : ''), { direction: 'top', offset: [0, -6] });
        m.addTo(TL.layers.companions);
      });
    }

    // Backpacks
    if (TL.visible.backpacks && d.backpacks) {
      d.backpacks.forEach(function(b) {
        if (b.lat == null) return;
        var m = L.marker([b.lat, b.lng], { icon: tlIcon('#8e44ad', 6, 'square') });
        m.bindTooltip('Backpack (' + (b.item_count||0) + ' items)', { direction: 'top', offset: [0, -5] });
        m.addTo(TL.layers.backpacks);
      });
    }

    // Update counts
    var counts = {
      players: d.players ? d.players.length : 0,
      zombies: d.ai ? d.ai.filter(function(a){return a.category==='zombie';}).length : 0,
      animals: d.ai ? d.ai.filter(function(a){return a.category==='animal';}).length : 0,
      bandits: d.ai ? d.ai.filter(function(a){return a.category==='bandit';}).length : 0,
      vehicles: d.vehicles ? d.vehicles.length : 0,
      structures: d.structures ? d.structures.length : 0,
      companions: d.companions ? d.companions.length : 0,
      backpacks: d.backpacks ? d.backpacks.length : 0,
    };
    for (var k in counts) {
      var countEl = $('#tl-c-' + k);
      if (countEl) countEl.textContent = counts[k];
    }
  }

  async function tlLoadDeaths() {
    try {
      var deaths = await apiFetch('/api/timeline/deaths?limit=200').then(function(r){return r.json();});
      TL.layers.deaths.clearLayers();
      deaths.forEach(function(d) {
        if (d.lat == null) return;
        var m = L.marker([d.lat, d.lng], { icon: tlIcon('#ff0000', 8, 'circle', 'Death'), zIndexOffset: -100 });
        var cause = d.cause_name || d.cause_type || 'Unknown';
        var t = new Date(d.created_at).toLocaleString('en-GB', {day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'});
        m.bindPopup('<div class="tl-popup"><b>💀 ' + esc(d.victim_name||'?') + '</b><br>Killed by: ' + esc(cause) +
          ' (' + esc(d.cause_type||'') + ')<br>Dmg: ' + Math.round(d.damage_total||0) + '<br><small>' + t + '</small></div>');
        m.addTo(TL.layers.deaths);
      });
    } catch (e) { console.warn('[TL] Deaths error:', e); }
  }

  function tlTogglePlay() { TL.playing ? tlStop() : tlPlay(); }

  function tlPlay() {
    if (TL.playing || !TL.snapshots.length) return;
    TL.playing = true;
    var btn = $('#tl-play');
    if (btn) { btn.innerHTML = '<i data-lucide="pause" class="w-3.5 h-3.5"></i>'; if (window.lucide) lucide.createIcons({ nodes: [btn] }); }
    var interval = Math.max(200, 2000 / TL.speed);
    TL.timer = setInterval(function() {
      if (TL.idx >= TL.snapshots.length - 1) { tlStop(); return; }
      tlGoTo(TL.idx + 1);
    }, interval);
  }

  function tlStop() {
    TL.playing = false;
    if (TL.timer) { clearInterval(TL.timer); TL.timer = null; }
    var btn = $('#tl-play');
    if (btn) { btn.innerHTML = '<i data-lucide="play" class="w-3.5 h-3.5"></i>'; if (window.lucide) lucide.createIcons({ nodes: [btn] }); }
  }

  function tlStep(dir) {
    var next = TL.idx + dir;
    if (next >= 0 && next < TL.snapshots.length) tlGoTo(next);
  }

})();

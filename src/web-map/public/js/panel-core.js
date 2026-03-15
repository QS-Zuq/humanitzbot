/**
 * Panel Core — Foundation layer for the HumanitZ web panel.
 * Shared state, DOM utilities, API helpers, HTML escape, and data constants.
 *
 * @namespace Panel.core
 */
window.Panel = window.Panel || {};

(function () {
  'use strict';

  // ── Shared State ──────────────────────────────────

  const S = {
    user: null,
    tier: 0,
    currentTab: 'dashboard',
    currentServer: 'primary',
    multiServer: false,
    serverList: [],
    serverStatuses: {},
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
    _itemsData: null,
    _itemsMovements: null,
  };

  // ── DOM Utilities ─────────────────────────────────

  const $ = function (sel, ctx) {
    return (ctx || document).querySelector(sel);
  };
  const $$ = function (sel, ctx) {
    return Array.from((ctx || document).querySelectorAll(sel));
  };
  const el = function (tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  };

  // ── API Utilities ─────────────────────────────────

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

  // ── HTML Escape ───────────────────────────────────

  function esc(str) {
    if (!str) return '';
    var div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
  }

  // ── Constants ─────────────────────────────────────

  const SETTING_CATEGORY_KEY_MAP = {
    server: [
      'ServerName',
      'MaxPlayers',
      'SaveName',
      'SearchID',
      'Version',
      'NoJoinFeedback',
      'NoDeathFeedback',
      'LimitedSpawns',
      'Voip',
    ],
    gameplay: [
      'PVP',
      'DaysPerSeason',
      'StartingSeason',
      'XpMultiplier',
      'AirDrop',
      'AirDropInterval',
      'AIEvent',
      'EagleEye',
      'ClearInfection',
      'MultiplayerSleep',
      'FreezeTime',
      'MaxOwnedCars',
      'Territory',
      'PermaDeath',
      'OnDeath',
    ],
    day_night: ['DayDur', 'NightDur', 'Seg0', 'Seg1', 'Seg2'],
    survival: ['VitalDrain', 'FoodDecay', 'Sleep', 'GenFuel', 'WeaponBreak', 'RespawnTimer'],
    building: [
      'AllowDismantle',
      'AllowHouseDismantle',
      'BuildingHealth',
      'BuildingDecay',
      'Decay',
      'FakeBuildingCleanup',
    ],
    companions: ['DogEnabled', 'RecruitDog', 'DogNum', 'CompanionHealth', 'CompanionDmg'],
    zombies: [
      'ZombieAmountMulti',
      'ZombieDiffHealth',
      'ZombieDiffSpeed',
      'ZombieDiffDamage',
      'ZombieRespawnTimer',
      'ZombieDogMulti',
    ],
    humans_npc: ['HumanAmountMulti', 'HumanHealth', 'HumanSpeed', 'HumanDamage', 'HumanRespawnTimer'],
    animals: ['AnimalMulti', 'AnimalRespawnTimer'],
    loot: ['LootRespawn', 'LootRespawnTimer', 'PickupRespawnTimer', 'PickupCleanup', 'SaveIntervalSec'],
    loot_rarity: [
      'RarityFood',
      'RarityDrink',
      'RarityMelee',
      'RarityRanged',
      'RarityAmmo',
      'RarityArmor',
      'RarityResources',
      'RarityOther',
    ],
    weather: [
      'Weather_ClearSky',
      'Weather_Cloudy',
      'Weather_Foggy',
      'Weather_LightRain',
      'Weather_Rain',
      'Weather_Thunderstorm',
      'Weather_LightSnow',
      'Weather_Snow',
      'Weather_Blizzard',
    ],
  };

  function getSettingCategories() {
    return {
      [i18next.t('web:setting_categories.server')]: SETTING_CATEGORY_KEY_MAP.server.slice(),
      [i18next.t('web:setting_categories.gameplay')]: SETTING_CATEGORY_KEY_MAP.gameplay.slice(),
      [i18next.t('web:setting_categories.day_night')]: SETTING_CATEGORY_KEY_MAP.day_night.slice(),
      [i18next.t('web:setting_categories.survival')]: SETTING_CATEGORY_KEY_MAP.survival.slice(),
      [i18next.t('web:setting_categories.building')]: SETTING_CATEGORY_KEY_MAP.building.slice(),
      [i18next.t('web:setting_categories.companions')]: SETTING_CATEGORY_KEY_MAP.companions.slice(),
      [i18next.t('web:setting_categories.zombies')]: SETTING_CATEGORY_KEY_MAP.zombies.slice(),
      [i18next.t('web:setting_categories.humans_npc')]: SETTING_CATEGORY_KEY_MAP.humans_npc.slice(),
      [i18next.t('web:setting_categories.animals')]: SETTING_CATEGORY_KEY_MAP.animals.slice(),
      [i18next.t('web:setting_categories.loot')]: SETTING_CATEGORY_KEY_MAP.loot.slice(),
      [i18next.t('web:setting_categories.loot_rarity')]: SETTING_CATEGORY_KEY_MAP.loot_rarity.slice(),
      [i18next.t('web:setting_categories.weather')]: SETTING_CATEGORY_KEY_MAP.weather.slice(),
    };
  }

  const SETTING_DESC_KEY_OVERRIDES = {
    AIEvent: 'aievent',
  };

  function getSettingDescs() {
    return new Proxy(
      {},
      {
        get: function (_, prop) {
          if (typeof prop !== 'string') return undefined;
          var i18nKey = SETTING_DESC_KEY_OVERRIDES[prop] || Panel.core.utils.toI18nSnakeCase(prop);
          var fullKey = 'web:setting_descs.' + i18nKey;
          var translated = i18next.t(fullKey);
          return translated === fullKey ? '' : translated;
        },
      },
    );
  }

  // ── Bot .env configuration descriptions ──
  function getEnvDescs() {
    return new Proxy(
      {},
      {
        get: function (_, prop) {
          if (typeof prop !== 'string') return undefined;
          var fullKey = 'web:env_descs.' + String(prop).toLowerCase();
          var translated = i18next.t(fullKey);
          return translated === fullKey ? '' : translated;
        },
      },
    );
  }

  // Boolean env keys — render as toggles instead of text inputs
  const ENV_BOOLEANS = new Set([
    'FIRST_RUN',
    'ENABLE_STATUS_CHANNELS',
    'ENABLE_SERVER_STATUS',
    'ENABLE_CHAT_RELAY',
    'ENABLE_AUTO_MESSAGES',
    'ENABLE_PLAYTIME',
    'ENABLE_LOG_WATCHER',
    'ENABLE_PLAYER_STATS',
    'ENABLE_MILESTONES',
    'ENABLE_RECAPS',
    'ENABLE_ANTICHEAT',
    'ENABLE_KILL_FEED',
    'ENABLE_PVP_KILL_FEED',
    'ENABLE_DEATH_LOOP_DETECTION',
    'USE_CHAT_THREADS',
    'USE_ACTIVITY_THREADS',
    'ENABLE_AUTO_MSG_LINK',
    'ENABLE_AUTO_MSG_PROMO',
    'ENABLE_WELCOME_MSG',
    'ENABLE_WELCOME_FILE',
    'ENABLE_PVP_SCHEDULER',
    'PVP_UPDATE_SERVER_NAME',
    'ENABLE_SERVER_SCHEDULER',
    'RESTART_ROTATE_DAILY',
    'ENABLE_ACTIVITY_LOG',
    'ENABLE_CONTAINER_LOG',
    'ENABLE_HORSE_LOG',
    'ENABLE_VEHICLE_LOG',
    'SHOW_INVENTORY_LOG',
    'SHOW_INVENTORY_LOG_ADMIN_ONLY',
    'ENABLE_PANEL',
    'ENABLE_GAME_SETTINGS_EDITOR',
    'ENABLE_SSH_RESOURCES',
    'ENABLE_STDIN_CONSOLE',
    'STDIN_CONSOLE_WRITABLE',
    'SHOW_RAID_STATS',
    'SHOW_PVP_KILLS',
    'SHOW_VITALS',
    'SHOW_STATUS_EFFECTS',
    'SHOW_INVENTORY',
    'SHOW_RECIPES',
    'SHOW_LORE',
    'SHOW_SKILLS',
    'SHOW_CONNECTIONS',
    'SHOW_COORDINATES',
    'SHOW_COORDINATES_ADMIN_ONLY',
    'ENABLE_FISHING_FEED',
    'ENABLE_RECIPE_FEED',
    'ENABLE_SKILL_FEED',
    'ENABLE_PROFESSION_FEED',
    'ENABLE_LORE_FEED',
    'ENABLE_UNIQUE_FEED',
    'ENABLE_COMPANION_FEED',
    'ENABLE_CHALLENGE_FEED',
    'ENABLE_WORLD_EVENT_FEED',
  ]);

  const DB_TABLE_VALUES = [
    'activity_log',
    'chat_log',
    'players',
    'player_aliases',
    'clans',
    'clan_members',
    'world_state',
    'structures',
    'vehicles',
    'companions',
    'world_horses',
    'dead_bodies',
    'containers',
    'loot_actors',
    'world_drops',
    'server_settings',
    'snapshots',
    'item_instances',
    'item_groups',
    'item_movements',
    'game_items',
    'game_buildings',
    'game_recipes',
    'game_vehicles_ref',
    'game_loot_pools',
    'game_professions',
    'game_afflictions',
    'game_skills',
    'game_challenges',
    'game_animals',
    'game_server_setting_defs',
  ];

  function getDbTables() {
    return DB_TABLE_VALUES.map(function (value) {
      return {
        value: value,
        label: i18next.t('web:db_tables.' + value),
      };
    });
  }

  // ── Expose API ────────────────────────────────────

  Panel.core = {
    S: S,
    $: $,
    $$: $$,
    el: el,
    esc: esc,
    apiUrl: apiUrl,
    apiFetch: apiFetch,
    SETTING_CATEGORY_KEY_MAP: SETTING_CATEGORY_KEY_MAP,
    SETTING_DESC_KEY_OVERRIDES: SETTING_DESC_KEY_OVERRIDES,
    ENV_BOOLEANS: ENV_BOOLEANS,
    DB_TABLE_VALUES: DB_TABLE_VALUES,
    getSettingCategories: getSettingCategories,
    getSettingDescs: getSettingDescs,
    getEnvDescs: getEnvDescs,
    getDbTables: getDbTables,
  };
})();

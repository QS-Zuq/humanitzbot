/**
 * Config migration map — builds migration rules from ENV_CATEGORIES + fallback entries.
 *
 * Provides:
 *   - BOOTSTRAP_KEYS  — env keys that must stay in .env (Discord tokens, ports, etc.)
 *   - SERVER_SCOPED_KEYS — env keys that belong to per-server config (RCON, SFTP, channels)
 *   - buildMigrationMap() — maps envKey → { cfgKey, scope, type, sensitive }
 *   - migrateEnvToDb() — one-time migration of .env values → config_documents
 *   - migrateServersJsonToDb() — stores managed server definitions as NESTED objects
 *   - migrateDisplaySettings() — merges bot_state.display_settings into app document
 */

'use strict';

const { ENV_CATEGORIES } = require('../modules/panel-constants');

// ── Bootstrap keys that MUST stay in .env ────────────────────
// These are needed before DB is available or are security-critical.
const BOOTSTRAP_KEYS = new Set([
  'DISCORD_TOKEN',
  'DISCORD_CLIENT_ID',
  'DISCORD_GUILD_ID',
  'PANEL_CHANNEL_ID',
  'WEB_MAP_PORT',
  'DISCORD_OAUTH_SECRET',
  'WEB_MAP_CALLBACK_URL',
  'WEB_MAP_SESSION_SECRET',
  'WEB_MAP_TRUST_PROXY',
  'ENV_SCHEMA_VERSION',
  'FIRST_RUN',
  'NUKE_BOT',
  'NUKE_THREADS',
]);

// ── Server-scoped env key prefixes/patterns ──────────────────
// These go into 'server:primary' instead of 'app'.
const _SERVER_PREFIXES = ['RCON_', 'FTP_', 'PANEL_SERVER_URL', 'PANEL_API_KEY'];
const _SERVER_CHANNEL_SUFFIXES = [
  'ADMIN_CHANNEL_ID',
  'CHAT_CHANNEL_ID',
  'LOG_CHANNEL_ID',
  'SERVER_STATUS_CHANNEL_ID',
  'PLAYER_STATS_CHANNEL_ID',
  'ACTIVITY_LOG_CHANNEL_ID',
  'HOWYAGARN_CHANNEL_ID',
];

/**
 * Convert ENV_KEY_NAME to camelCase cfgKey (e.g. RCON_PASSWORD → rconPassword).
 * @param {string} envKey
 * @returns {string}
 */
function _envKeyToCfgKey(envKey) {
  return envKey.toLowerCase().replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

/**
 * Check if an env key is server-scoped.
 * @param {string} envKey
 * @returns {boolean}
 */
function _isServerScoped(envKey) {
  if (_SERVER_CHANNEL_SUFFIXES.includes(envKey)) return true;
  return _SERVER_PREFIXES.some((prefix) => envKey.startsWith(prefix));
}

// Precompute the set of server-scoped keys from ENV_CATEGORIES
const SERVER_SCOPED_KEYS = new Set();
for (const cat of ENV_CATEGORIES) {
  for (const field of cat.fields) {
    if (_isServerScoped(field.env)) {
      SERVER_SCOPED_KEYS.add(field.env);
    }
  }
}

// ── Fallback migration entries ────────────────────────────────
// Keys in config.js that are NOT covered by ENV_CATEGORIES.
// Each specifies { cfgKey, scope, type, sensitive? } explicitly.
const FALLBACK_MIGRATION_ENTRIES = {
  // Server-scoped — host, SFTP key, channels, per-server paths
  PUBLIC_HOST: { cfgKey: 'publicHost', scope: 'server:primary', type: 'string' },
  FTP_PRIVATE_KEY_PATH: { cfgKey: 'ftpPrivateKeyPath', scope: 'server:primary', type: 'string' },
  ACTIVITY_LOG_CHANNEL_ID: { cfgKey: 'activityLogChannelId', scope: 'server:primary', type: 'string' },
  HOWYAGARN_CHANNEL_ID: { cfgKey: 'howyagarnChannelId', scope: 'server:primary', type: 'string' },
  HZMOD_SERVER_ID: { cfgKey: 'hzmodServerId', scope: 'server:primary', type: 'string' },
  HZMOD_SOCKET_PATH: { cfgKey: 'hzmodSocketPath', scope: 'server:primary', type: 'string' },
  HZMOD_STATUS_PATH: { cfgKey: 'hzmodStatusPath', scope: 'server:primary', type: 'string' },
  DOCKER_CONTAINER: { cfgKey: 'dockerContainer', scope: 'server:primary', type: 'string' },
  RESTART_TIMES: { cfgKey: 'restartTimes', scope: 'server:primary', type: 'string' },
  RESTART_PROFILES: { cfgKey: 'restartProfiles', scope: 'server:primary', type: 'string' },
  RESTART_DELAY: { cfgKey: 'restartDelay', scope: 'server:primary', type: 'int' },
  RESTART_ROTATE_DAILY: { cfgKey: 'restartRotateDaily', scope: 'server:primary', type: 'bool' },
  SERVER_NAME_TEMPLATE: { cfgKey: 'serverNameTemplate', scope: 'server:primary', type: 'string' },

  // App-scoped — bot locale, stdin, feature toggles, display settings
  BOT_LOCALE: { cfgKey: 'botLocale', scope: 'app', type: 'string' },
  ENABLE_STDIN_CONSOLE: { cfgKey: 'enableStdinConsole', scope: 'app', type: 'bool' },
  STDIN_CONSOLE_WRITABLE: { cfgKey: 'stdinConsoleWritable', scope: 'app', type: 'bool' },
  ENABLE_MILESTONES: { cfgKey: 'enableMilestones', scope: 'app', type: 'bool' },
  ENABLE_RECAPS: { cfgKey: 'enableRecaps', scope: 'app', type: 'bool' },
  ENABLE_ANTICHEAT: { cfgKey: 'enableAnticheat', scope: 'app', type: 'bool' },
  ENABLE_GITHUB_TRACKER: { cfgKey: 'enableGithubTracker', scope: 'app', type: 'bool' },
  ENABLE_SERVER_SCHEDULER: { cfgKey: 'enableServerScheduler', scope: 'app', type: 'bool' },
  ENABLE_CHALLENGE_FEED: { cfgKey: 'enableChallengeFeed', scope: 'app', type: 'bool' },
  ENABLE_DID_YOU_KNOW: { cfgKey: 'enableDidYouKnow', scope: 'app', type: 'bool' },
  ENABLE_PLAYER_CARDS: { cfgKey: 'enablePlayerCards', scope: 'app', type: 'bool' },
  ENABLE_NEWSPAPER: { cfgKey: 'enableNewspaper', scope: 'app', type: 'bool' },
  ENABLE_HOWYAGARN: { cfgKey: 'enableHowyagarn', scope: 'app', type: 'bool' },
  SHOW_INVENTORY_LOG_ADMIN_ONLY: { cfgKey: 'showInventoryLogAdminOnly', scope: 'app', type: 'bool' },
  SHOW_CONTAINERS: { cfgKey: 'showContainers', scope: 'app', type: 'bool' },
  SHOW_CONTAINERS_ADMIN_ONLY: { cfgKey: 'showContainersAdminOnly', scope: 'app', type: 'bool' },
  SHOW_HORSES: { cfgKey: 'showHorses', scope: 'app', type: 'bool' },
  SHOW_HORSES_ADMIN_ONLY: { cfgKey: 'showHorsesAdminOnly', scope: 'app', type: 'bool' },
  SHOW_SKILLS_ADMIN_ONLY: { cfgKey: 'showSkillsAdminOnly', scope: 'app', type: 'bool' },
  SHOW_WORLD_STATS: { cfgKey: 'showWorldStats', scope: 'app', type: 'bool' },

  // App-scoped — GitHub tracker
  GITHUB_TOKEN: { cfgKey: 'githubToken', scope: 'app', type: 'string', sensitive: true },
  GITHUB_REPOS: { cfgKey: 'githubRepos', scope: 'app', type: 'string' },
  GITHUB_CHANNEL_ID: { cfgKey: 'githubChannelId', scope: 'app', type: 'string' },
  GITHUB_POLL_INTERVAL: { cfgKey: 'githubPollInterval', scope: 'app', type: 'int' },

  // App-scoped — anticheat intervals
  ANTICHEAT_ANALYZE_INTERVAL: { cfgKey: 'anticheatAnalyzeInterval', scope: 'app', type: 'int' },
  ANTICHEAT_BASELINE_INTERVAL: { cfgKey: 'anticheatBaselineInterval', scope: 'app', type: 'int' },

  // App-scoped — agent extras (matches existing AGENT_ scope in ENV_CATEGORIES)
  AGENT_REMOTE_DIR: { cfgKey: 'agentRemoteDir', scope: 'app', type: 'string' },
  AGENT_CACHE_PATH: { cfgKey: 'agentCachePath', scope: 'app', type: 'string' },
  AGENT_PANEL_COMMAND: { cfgKey: 'agentPanelCommand', scope: 'app', type: 'string' },
  AGENT_PANEL_DELAY: { cfgKey: 'agentPanelDelay', scope: 'app', type: 'int' },
};
// Also include server-scoped keys from FALLBACK_MIGRATION_ENTRIES
for (const [envKey, entry] of Object.entries(FALLBACK_MIGRATION_ENTRIES)) {
  if (entry.scope === 'server:primary') {
    SERVER_SCOPED_KEYS.add(envKey);
  }
}

// ── Migration map builder ────────────────────────────────────

/**
 * Build the migration map from ENV_CATEGORIES + FALLBACK_MIGRATION_ENTRIES.
 * @returns {Object<string, { cfgKey: string|null, scope: string, type: string, sensitive: boolean }>}
 */
function buildMigrationMap() {
  const map = {};

  // 1. Map ENV_CATEGORIES fields (panel-constants.js)
  for (const cat of ENV_CATEGORIES) {
    for (const field of cat.fields) {
      const envKey = field.env;

      // Skip bootstrap keys — they stay in .env
      if (BOOTSTRAP_KEYS.has(envKey)) continue;

      const scope = _isServerScoped(envKey) ? 'server:primary' : 'app';
      const type = field.type || 'string';
      const sensitive = field.sensitive || false;
      const cfgKey = field.cfg || _envKeyToCfgKey(envKey);

      map[envKey] = { cfgKey, scope, type, sensitive };
    }
  }

  // 2. Merge FALLBACK entries for keys not in ENV_CATEGORIES
  for (const [envKey, entry] of Object.entries(FALLBACK_MIGRATION_ENTRIES)) {
    if (BOOTSTRAP_KEYS.has(envKey)) continue;
    if (!map[envKey]) {
      map[envKey] = { cfgKey: entry.cfgKey, scope: entry.scope, type: entry.type, sensitive: entry.sensitive || false };
    }
  }

  return map;
}

// ── Type coercion helper ─────────────────────────────────────

/**
 * Coerce a string value based on its type annotation.
 * @param {string} value - Raw string from .env
 * @param {string} type - 'bool', 'int', or 'string'
 * @returns {boolean|number|string}
 */
function _coerce(value, type) {
  if (type === 'bool') {
    return value === 'true';
  }
  if (type === 'int') {
    const n = parseInt(value, 10);
    return Number.isNaN(n) ? value : n;
  }
  return value;
}

// ── Migration functions ──────────────────────────────────────

/**
 * Migrate env key-values into config_documents.
 * Reads from a flat envValues object (e.g. from dotenv.parse()),
 * maps to app + server:primary documents.
 *
 * @param {Object<string, string>} envValues - Key-value pairs from .env
 * @param {import('./config-repository')} configRepo
 * @returns {{ appKeys: number, serverKeys: number, skipped: number }}
 */
function migrateEnvToDb(envValues, configRepo) {
  const migrationMap = buildMigrationMap();
  const appPatch = {};
  const serverPatch = {};
  let skipped = 0;

  for (const [envKey, rawValue] of Object.entries(envValues)) {
    // Skip empty values
    if (rawValue === '' || rawValue == null) {
      skipped++;
      continue;
    }

    const mapping = migrationMap[envKey];
    if (!mapping) {
      skipped++;
      continue;
    }

    const { cfgKey, scope, type } = mapping;
    const targetKey = cfgKey || envKey;
    const coerced = _coerce(rawValue, type);

    if (scope === 'server:primary') {
      serverPatch[targetKey] = coerced;
    } else {
      appPatch[targetKey] = coerced;
    }
  }

  // Write to DB using merge-patch (preserves existing data)
  if (Object.keys(appPatch).length > 0) {
    configRepo.update('app', appPatch);
  }
  if (Object.keys(serverPatch).length > 0) {
    configRepo.update('server:primary', serverPatch);
  }

  return {
    appKeys: Object.keys(appPatch).length,
    serverKeys: Object.keys(serverPatch).length,
    skipped,
  };
}

/**
 * Migrate servers.json definitions into config_documents.
 * Stores each server definition as-is (NESTED shape) under 'server:<id>'.
 *
 * @param {Array<object>} serverDefs - Array of serverDef objects from servers.json
 * @param {import('./config-repository')} configRepo
 * @returns {number} Number of servers migrated
 */
function migrateServersJsonToDb(serverDefs, configRepo) {
  let count = 0;
  for (const def of serverDefs) {
    if (!def || !def.id) continue;
    const scope = `server:${def.id}`;
    // Store NESTED as-is — this matches what createServerConfig() expects
    configRepo.set(scope, def);
    count++;
  }
  return count;
}

/**
 * Migrate display_settings from bot_state into the 'app' config document.
 * Merges existing display overrides into the app scope.
 *
 * @param {import('./database')} db - HumanitZDB instance
 * @param {import('./config-repository')} configRepo
 * @returns {number} Number of display settings migrated
 */
function migrateDisplaySettings(db, configRepo) {
  const overrides = db.getStateJSON('display_settings', null);
  if (!overrides || typeof overrides !== 'object') return 0;

  const keys = Object.keys(overrides);
  if (keys.length === 0) return 0;

  configRepo.update('app', overrides);
  return keys.length;
}

module.exports = {
  BOOTSTRAP_KEYS,
  SERVER_SCOPED_KEYS,
  buildMigrationMap,
  migrateEnvToDb,
  migrateServersJsonToDb,
  migrateDisplaySettings,
  // Exported for testing
  FALLBACK_MIGRATION_ENTRIES,
  _coerce,
  _isServerScoped,
};

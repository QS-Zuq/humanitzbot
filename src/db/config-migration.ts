/**
 * Config migration map — builds migration rules from ENV_CATEGORIES + fallback entries.
 *
 * Provides:
 *   - BOOTSTRAP_KEYS  — env keys that must stay in .env (Discord tokens, ports, etc.)
 *   - SERVER_SCOPED_KEYS — env keys that belong to per-server config (RCON, SFTP, channels)
 *   - buildMigrationMap() — maps envKey -> { cfgKey, scope, type, sensitive }
 *   - migrateEnvToDb() — one-time migration of .env values -> config_documents
 *   - migrateServersJsonToDb() — stores managed server definitions as NESTED objects
 *   - migrateDisplaySettings() — merges bot_state.display_settings into app document
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const panelConstants = require('../modules/panel-constants') as {
  ENV_CATEGORIES: Array<{
    fields: Array<{
      env: string;
      type?: string;
      sensitive?: boolean;
      cfg?: string;
    }>;
  }>;
};
const { ENV_CATEGORIES } = panelConstants;

// ── Types ──────────────────────────────────────────────────────

interface MigrationEntry {
  cfgKey: string;
  scope: string;
  type: string;
  sensitive?: boolean;
}

interface ConfigRepo {
  update(scope: string, patch: Record<string, unknown>): Record<string, unknown>;
  set(scope: string, data: Record<string, unknown>): void;
}

interface HumanitZDBLike {
  getStateJSON(key: string, defaultVal: null): Record<string, unknown> | null;
}

// ── Bootstrap keys that MUST stay in .env ────────────────────
const BOOTSTRAP_KEYS = new Set([
  'DISCORD_TOKEN',
  'DISCORD_CLIENT_ID',
  'DISCORD_GUILD_ID',
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
const _SERVER_PREFIXES = ['RCON_', 'SFTP_', 'FTP_', 'PANEL_SERVER_URL', 'PANEL_API_KEY'];
const _SERVER_CHANNEL_SUFFIXES = [
  'ADMIN_CHANNEL_ID',
  'CHAT_CHANNEL_ID',
  'LOG_CHANNEL_ID',
  'SERVER_STATUS_CHANNEL_ID',
  'PLAYER_STATS_CHANNEL_ID',
  'ACTIVITY_LOG_CHANNEL_ID',
  'HOWYAGARN_CHANNEL_ID',
];

function _envKeyToCfgKey(envKey: string): string {
  return envKey.toLowerCase().replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

function _isServerScoped(envKey: string): boolean {
  if (_SERVER_CHANNEL_SUFFIXES.includes(envKey)) return true;
  return _SERVER_PREFIXES.some((prefix) => envKey.startsWith(prefix));
}

// Precompute the set of server-scoped keys from ENV_CATEGORIES
const SERVER_SCOPED_KEYS = new Set<string>();
for (const cat of ENV_CATEGORIES) {
  for (const field of cat.fields) {
    if (_isServerScoped(field.env)) {
      SERVER_SCOPED_KEYS.add(field.env);
    }
  }
}

// ── Fallback migration entries ────────────────────────────────
const FALLBACK_MIGRATION_ENTRIES: Record<string, MigrationEntry> = {
  PUBLIC_HOST: { cfgKey: 'publicHost', scope: 'server:primary', type: 'string' },
  SFTP_PRIVATE_KEY_PATH: { cfgKey: 'sftpPrivateKeyPath', scope: 'server:primary', type: 'string' },
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
  GITHUB_TOKEN: { cfgKey: 'githubToken', scope: 'app', type: 'string', sensitive: true },
  GITHUB_REPOS: { cfgKey: 'githubRepos', scope: 'app', type: 'string' },
  GITHUB_CHANNEL_ID: { cfgKey: 'githubChannelId', scope: 'app', type: 'string' },
  GITHUB_POLL_INTERVAL: { cfgKey: 'githubPollInterval', scope: 'app', type: 'int' },
  ANTICHEAT_ANALYZE_INTERVAL: { cfgKey: 'anticheatAnalyzeInterval', scope: 'app', type: 'int' },
  ANTICHEAT_BASELINE_INTERVAL: { cfgKey: 'anticheatBaselineInterval', scope: 'app', type: 'int' },
  AGENT_REMOTE_DIR: { cfgKey: 'agentRemoteDir', scope: 'app', type: 'string' },
  AGENT_CACHE_PATH: { cfgKey: 'agentCachePath', scope: 'app', type: 'string' },
  AGENT_PANEL_COMMAND: { cfgKey: 'agentPanelCommand', scope: 'app', type: 'string' },
  AGENT_PANEL_DELAY: { cfgKey: 'agentPanelDelay', scope: 'app', type: 'int' },
};

for (const [envKey, entry] of Object.entries(FALLBACK_MIGRATION_ENTRIES)) {
  if (entry.scope === 'server:primary') {
    SERVER_SCOPED_KEYS.add(envKey);
  }
}

// ── Migration map builder ────────────────────────────────────

function buildMigrationMap(): Record<string, MigrationEntry> {
  const map: Record<string, MigrationEntry> = {};

  for (const cat of ENV_CATEGORIES) {
    for (const field of cat.fields) {
      const envKey = field.env;
      if (BOOTSTRAP_KEYS.has(envKey)) continue;
      const scope = _isServerScoped(envKey) ? 'server:primary' : 'app';
      const type = field.type ?? 'string';
      const sensitive = field.sensitive ?? false;
      const cfgKey = field.cfg ?? _envKeyToCfgKey(envKey);
      map[envKey] = { cfgKey, scope, type, sensitive };
    }
  }

  for (const [envKey, entry] of Object.entries(FALLBACK_MIGRATION_ENTRIES)) {
    if (BOOTSTRAP_KEYS.has(envKey)) continue;
    if (!map[envKey]) {
      map[envKey] = { cfgKey: entry.cfgKey, scope: entry.scope, type: entry.type, sensitive: entry.sensitive ?? false };
    }
  }

  return map;
}

// ── Type coercion helper ─────────────────────────────────────

function _coerce(value: string, type: string): boolean | number | string {
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

function migrateEnvToDb(
  envValues: Record<string, string>,
  configRepo: ConfigRepo,
): { appKeys: number; serverKeys: number; skipped: number } {
  const migrationMap = buildMigrationMap();
  const appPatch: Record<string, unknown> = {};
  const serverPatch: Record<string, unknown> = {};
  let skipped = 0;

  for (const [envKey, rawValue] of Object.entries(envValues)) {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
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

function migrateServersJsonToDb(serverDefs: Array<Record<string, unknown>>, configRepo: ConfigRepo): number {
  let count = 0;
  for (const def of serverDefs) {
    if (!def['id']) continue;
    const defId = typeof def['id'] === 'string' ? def['id'] : JSON.stringify(def['id']);
    const scope = `server:${defId}`;
    configRepo.set(scope, def);
    count++;
  }
  return count;
}

function migrateDisplaySettings(db: HumanitZDBLike, configRepo: ConfigRepo): number {
  const overrides = db.getStateJSON('display_settings', null);

  if (!overrides || typeof overrides !== 'object') return 0;

  const keys = Object.keys(overrides);
  if (keys.length === 0) return 0;

  configRepo.update('app', overrides);
  return keys.length;
}

export {
  BOOTSTRAP_KEYS,
  SERVER_SCOPED_KEYS,
  buildMigrationMap,
  migrateEnvToDb,
  migrateServersJsonToDb,
  migrateDisplaySettings,
  FALLBACK_MIGRATION_ENTRIES,
  _coerce,
  _isServerScoped,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _mod = module as { exports: any };
_mod.exports = {
  BOOTSTRAP_KEYS,
  SERVER_SCOPED_KEYS,
  buildMigrationMap,
  migrateEnvToDb,
  migrateServersJsonToDb,
  migrateDisplaySettings,
  FALLBACK_MIGRATION_ENTRIES,
  _coerce,
  _isServerScoped,
};

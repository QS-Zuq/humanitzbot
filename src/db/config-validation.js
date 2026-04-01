/**
 * Field-level config validation for bot configuration values.
 *
 * Validates correctness of config values (port range, timezone format, etc.).
 * Separate from `_coerce()` in config-migration.js which only converts types.
 *
 * @module config-validation
 */

'use strict';

// ── Individual field validators ──────────────────────────────
// Each returns { valid, value, error?, warning? }

const FIELD_VALIDATORS = {
  /**
   * Port number: integer 1–65535.
   */
  port(v) {
    const n = parseInt(v, 10);
    if (isNaN(n) || n < 1 || n > 65535 || String(n) !== String(v).trim()) {
      return { valid: false, value: v, error: 'Port must be an integer between 1 and 65535' };
    }
    return { valid: true, value: n };
  },

  /**
   * IANA timezone — validated with Intl.DateTimeFormat.
   */
  timezone(v) {
    if (typeof v !== 'string' || !v.trim()) {
      return { valid: false, value: v, error: 'Timezone must be a non-empty string' };
    }
    try {
      Intl.DateTimeFormat(undefined, { timeZone: v.trim() });
      return { valid: true, value: v.trim() };
    } catch {
      return { valid: false, value: v, error: `Invalid IANA timezone: ${v}` };
    }
  },

  /**
   * Enum — value must be in the allowed set.
   * @param {string} v
   * @param {string[]} options - Allowed values
   */
  enum(v, options) {
    const trimmed = typeof v === 'string' ? v.trim() : String(v);
    if (!options || !options.includes(trimmed)) {
      return { valid: false, value: v, error: `Must be one of: ${(options || []).join(', ')}` };
    }
    return { valid: true, value: trimmed };
  },

  /**
   * Discord Snowflake — 17–20 digit numeric string.
   * Supports comma-separated lists (ADMIN_USER_IDS, etc.).
   */
  snowflake(v) {
    if (typeof v !== 'string' || !v.trim()) {
      return { valid: false, value: v, error: 'Snowflake must be a non-empty string' };
    }
    const ids = v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (ids.length === 0) {
      return { valid: false, value: v, error: 'At least one snowflake ID is required' };
    }
    const snowflakeRe = /^\d{17,20}$/;
    for (const id of ids) {
      if (!snowflakeRe.test(id)) {
        return { valid: false, value: v, error: `Invalid Discord snowflake: "${id}" (must be 17-20 digits)` };
      }
    }
    return { valid: true, value: v.trim() };
  },

  /**
   * Time in HH:MM format (00:00–23:59).
   */
  time(v) {
    if (typeof v !== 'string') {
      return { valid: false, value: v, error: 'Time must be a string in HH:MM format' };
    }
    const match = v.trim().match(/^(\d{2}):(\d{2})$/);
    if (!match) {
      return { valid: false, value: v, error: 'Time must be in HH:MM format (e.g. 08:30)' };
    }
    const h = parseInt(match[1], 10);
    const m = parseInt(match[2], 10);
    if (h > 23 || m > 59) {
      return { valid: false, value: v, error: `Invalid time: hours must be 00-23, minutes 00-59` };
    }
    return { valid: true, value: v.trim() };
  },

  /**
   * Valid JSON string.
   */
  json(v) {
    if (typeof v !== 'string' || !v.trim()) {
      return { valid: false, value: v, error: 'JSON value must be a non-empty string' };
    }
    try {
      JSON.parse(v);
      return { valid: true, value: v.trim() };
    } catch (e) {
      return { valid: false, value: v, error: `Invalid JSON: ${e.message}` };
    }
  },

  /**
   * Interval — integer >= min. Returns clamped value + warning if below min.
   * @param {string|number} v
   * @param {number} min - Minimum allowed value
   */
  interval(v, min) {
    const n = parseInt(v, 10);
    if (isNaN(n)) {
      return { valid: false, value: v, error: 'Interval must be an integer (milliseconds)' };
    }
    if (typeof min === 'number' && n < min) {
      return { valid: true, value: min, warning: `Value ${n} is below minimum ${min}, clamped to ${min}` };
    }
    return { valid: true, value: n };
  },

  /**
   * URL — basic check for http:// or https:// prefix.
   */
  url(v) {
    if (typeof v !== 'string' || !v.trim()) {
      return { valid: false, value: v, error: 'URL must be a non-empty string' };
    }
    const trimmed = v.trim();
    if (!/^https?:\/\/.+/i.test(trimmed)) {
      return { valid: false, value: v, error: 'URL must start with http:// or https://' };
    }
    return { valid: true, value: trimmed };
  },

  /**
   * Host — IP address or hostname (basic check: non-empty, no spaces).
   */
  host(v) {
    if (typeof v !== 'string' || !v.trim()) {
      return { valid: false, value: v, error: 'Host must be a non-empty string' };
    }
    const trimmed = v.trim();
    if (/\s/.test(trimmed)) {
      return { valid: false, value: v, error: 'Host must not contain whitespace' };
    }
    return { valid: true, value: trimmed };
  },

  /**
   * Path — non-empty string, no null bytes.
   */
  path(v) {
    if (typeof v !== 'string' || !v.trim()) {
      return { valid: false, value: v, error: 'Path must be a non-empty string' };
    }
    if (v.includes('\0')) {
      return { valid: false, value: v, error: 'Path must not contain null bytes' };
    }
    return { valid: true, value: v.trim() };
  },
};

// ── Map env keys → validator type ────────────────────────────
// Keys needing special validation beyond basic bool/string/int type checking.

const ENV_KEY_VALIDATORS = {
  // Ports
  RCON_PORT: { type: 'port' },
  SFTP_PORT: { type: 'port' },
  WEB_MAP_PORT: { type: 'port' },
  GAME_PORT: { type: 'port' },
  SSH_PORT: { type: 'port' },

  // Timezones
  BOT_TIMEZONE: { type: 'timezone' },
  LOG_TIMEZONE: { type: 'timezone' },

  // Enums
  AGENT_MODE: { type: 'enum', options: ['auto', 'agent', 'direct', 'cache'] },
  AGENT_TRIGGER: { type: 'enum', options: ['auto', 'rcon', 'panel', 'ssh', 'none'] },
  BOT_LOCALE: { type: 'enum', options: ['en', 'zh-TW', 'zh-CN'] },

  // Time (HH:MM)
  PVP_START_TIME: { type: 'time' },
  PVP_END_TIME: { type: 'time' },

  // JSON
  PVP_SETTINGS_OVERRIDES: { type: 'json' },

  // Snowflakes (comma-separated)
  ADMIN_USER_IDS: { type: 'snowflake' },
  ADMIN_ROLE_IDS: { type: 'snowflake' },
  ADMIN_ALERT_CHANNEL_IDS: { type: 'snowflake' },
  ADMIN_CHANNEL_ID: { type: 'snowflake' },
  CHAT_CHANNEL_ID: { type: 'snowflake' },
  LOG_CHANNEL_ID: { type: 'snowflake' },
  SERVER_STATUS_CHANNEL_ID: { type: 'snowflake' },
  PLAYER_STATS_CHANNEL_ID: { type: 'snowflake' },

  ACTIVITY_LOG_CHANNEL_ID: { type: 'snowflake' },
  GITHUB_CHANNEL_ID: { type: 'snowflake' },
  HOWYAGARN_CHANNEL_ID: { type: 'snowflake' },

  // Hosts
  RCON_HOST: { type: 'host' },
  SFTP_HOST: { type: 'host' },
  PUBLIC_HOST: { type: 'host' },

  // URLs
  PANEL_SERVER_URL: { type: 'url' },
  DISCORD_INVITE_LINK: { type: 'url' },

  // Paths
  SFTP_BASE_PATH: { type: 'path' },
  SFTP_LOG_PATH: { type: 'path' },
  SFTP_CONNECT_LOG_PATH: { type: 'path' },
  SFTP_ID_MAP_PATH: { type: 'path' },
  SFTP_SAVE_PATH: { type: 'path' },
  SFTP_SETTINGS_PATH: { type: 'path' },
  SFTP_WELCOME_PATH: { type: 'path' },
  AGENT_NODE_PATH: { type: 'path' },
  SFTP_PRIVATE_KEY_PATH: { type: 'path' },

  // Intervals (with min values matching config.js Math.max() clamping)
  CHAT_POLL_INTERVAL: { type: 'interval', min: 5000 },
  STATUS_CACHE_TTL: { type: 'interval', min: 10000 },
  STATUS_CHANNEL_INTERVAL: { type: 'interval', min: 60000 },
  SERVER_STATUS_INTERVAL: { type: 'interval', min: 15000 },
  AUTO_MSG_LINK_INTERVAL: { type: 'interval', min: 60000 },
  AUTO_MSG_PROMO_INTERVAL: { type: 'interval', min: 60000 },
  AUTO_MSG_JOIN_CHECK: { type: 'interval', min: 5000 },
  LOG_POLL_INTERVAL: { type: 'interval', min: 10000 },
  SAVE_POLL_INTERVAL: { type: 'interval', min: 60000 },
  RESOURCE_CACHE_TTL: { type: 'interval', min: 10000 },
  AGENT_POLL_INTERVAL: { type: 'interval', min: 30000 },
  AGENT_TIMEOUT: { type: 'interval', min: 10000 },
  GITHUB_POLL_INTERVAL: { type: 'interval', min: 30000 },
};

// ── Main validation function ─────────────────────────────────

/**
 * Validate a config field value.
 *
 * 1. If ENV_KEY_VALIDATORS has a specific validator for this key, use it.
 * 2. Otherwise, apply basic type checks based on fieldDef.type ('bool', 'int', 'string').
 * 3. Generic string guard: no newlines, max 2000 chars.
 *
 * @param {string} envKey - The env key name (e.g. 'RCON_PORT')
 * @param {string|number|boolean} value - The value to validate
 * @param {{ type?: string }} [fieldDef] - Optional field definition from ENV_CATEGORIES
 * @returns {{ valid: boolean, value: *, error?: string, warning?: string }}
 */
function validateField(envKey, value, fieldDef) {
  // Allow empty strings for optional fields (skip validation)
  if (value === '' || value === null || value === undefined) {
    return { valid: true, value: '' };
  }

  const strValue = String(value);

  // Generic string guards (match existing web-map/server.js behavior)
  if (strValue.includes('\n') || strValue.includes('\r')) {
    return { valid: false, value, error: 'Value must not contain newlines' };
  }
  if (strValue.length > 2000) {
    return { valid: false, value, error: 'Value must not exceed 2000 characters' };
  }

  // Specific validator from ENV_KEY_VALIDATORS
  const keyValidator = ENV_KEY_VALIDATORS[envKey];
  if (keyValidator) {
    const fn = FIELD_VALIDATORS[keyValidator.type];
    if (fn) {
      return fn(strValue, keyValidator.options || keyValidator.min);
    }
  }

  // Basic type validation from fieldDef
  const type = fieldDef?.type;
  if (type === 'bool') {
    if (strValue !== 'true' && strValue !== 'false') {
      return { valid: false, value, error: 'Boolean value must be "true" or "false"' };
    }
    return { valid: true, value: strValue === 'true' };
  }
  if (type === 'int') {
    const n = parseInt(strValue, 10);
    if (isNaN(n) || String(n) !== strValue.trim()) {
      return { valid: false, value, error: 'Value must be a valid integer' };
    }
    return { valid: true, value: n };
  }

  // Default: string — already passed generic guards
  return { valid: true, value: strValue };
}

module.exports = { validateField, FIELD_VALIDATORS, ENV_KEY_VALIDATORS };
module.exports._test = { validateField, FIELD_VALIDATORS };

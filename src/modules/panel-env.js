/**
 * Panel .env file helpers — shared between panel-channel and panel-setup-wizard.
 *
 * Read/write .env values, apply live config, read cached game settings.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');

const { BOOTSTRAP_KEYS } = require('../db/config-migration');
const ENV_PATH = path.join(__dirname, '..', '..', '.env');

/** Read current value for an env field — process.env first, then config. */
function getEnvValue(field) {
  const raw = process.env[field.env];
  if (raw !== undefined) return raw;
  if (field.cfg && config[field.cfg] !== undefined) return String(config[field.cfg]);
  return '';
}

/** Write key=value pairs to .env, preserving comments and formatting. */
let _envWriteLock = false;
function writeEnvValues(updates) {
  // Filter out DB-managed keys — only bootstrap keys should be written to .env
  const dbKeys = Object.keys(updates).filter((k) => !BOOTSTRAP_KEYS.has(k));
  if (dbKeys.length > 0) {
    console.warn('[PANEL-ENV] Skipping .env write for DB-managed keys:', dbKeys.join(', '));
    updates = Object.fromEntries(Object.entries(updates).filter(([k]) => BOOTSTRAP_KEYS.has(k)));
    if (Object.keys(updates).length === 0) return;
  }
  if (_envWriteLock) throw new Error('.env write already in progress');
  _envWriteLock = true;
  try {
    let content;
    try {
      content = fs.readFileSync(ENV_PATH, 'utf8');
    } catch {
      content = '';
    }
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
function applyLiveConfig(field, value) {
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
function getCachedSettings(db) {
  try {
    if (db) {
      const data = db.getStateJSON('server_settings', null);
      if (data) return data;
    }
  } catch {}
  return {};
}

module.exports = {
  ENV_PATH,
  getEnvValue,
  writeEnvValues,
  applyLiveConfig,
  getCachedSettings,
};

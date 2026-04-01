/**
 * .env file writer — extracted from panel-env.js for shared use.
 *
 * Write key=value pairs to .env, preserving comments and formatting.
 * Only bootstrap keys (not DB-managed) are written.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const { BOOTSTRAP_KEYS } = require('../db/config-migration');
const ENV_PATH = path.join(__dirname, '..', '..', '.env');

/** Write key=value pairs to .env, preserving comments and formatting. */
let _envWriteLock = false;
function writeEnvValues(updates) {
  // Filter out DB-managed keys — only bootstrap keys should be written to .env
  const dbKeys = Object.keys(updates).filter((k) => !BOOTSTRAP_KEYS.has(k));
  if (dbKeys.length > 0) {
    console.warn('[ENV-WRITER] Skipping .env write for DB-managed keys:', dbKeys.join(', '));
    updates = Object.fromEntries(Object.entries(updates).filter(([k]) => BOOTSTRAP_KEYS.has(k)));
    if (Object.keys(updates).length === 0) return;
  }
  // Track dangerous .env writes with stack trace — write to file since console may scroll
  if (updates.NUKE_BOT || updates.FIRST_RUN) {
    const msg = `[${new Date().toISOString()}] CRITICAL ENV WRITE: ${JSON.stringify(updates)}\nStack: ${new Error().stack}\n\n`;
    console.warn('[ENV-WRITER] ⚠ Writing critical key:', JSON.stringify(updates));
    try {
      fs.appendFileSync(path.join(__dirname, '..', '..', 'data', 'nuke-audit.log'), msg);
    } catch (auditErr) {
      console.error('[ENV-WRITER] CRITICAL: Failed to write nuke audit log:', auditErr.message);
    }
  }
  if (_envWriteLock) throw new Error('.env write already in progress');
  _envWriteLock = true;
  try {
    let content;
    try {
      content = fs.readFileSync(ENV_PATH, 'utf8');
    } catch (readErr) {
      if (readErr.code === 'ENOENT') {
        content = '';
      } else {
        throw new Error(`.env read failed (${readErr.code}): ${readErr.message}`, { cause: readErr });
      }
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

module.exports = {
  ENV_PATH,
  writeEnvValues,
};

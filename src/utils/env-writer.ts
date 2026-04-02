/**
 * .env file writer — extracted from panel-env.js for shared use.
 *
 * Write key=value pairs to .env, preserving comments and formatting.
 * Only bootstrap keys (not DB-managed) are written.
 */

import fs from 'node:fs';
import path from 'node:path';
import { getDirname } from './paths.js';

// eslint-disable-next-line @typescript-eslint/no-require-imports -- CJS module not yet migrated
const { BOOTSTRAP_KEYS } = require('../db/config-migration') as { BOOTSTRAP_KEYS: Set<string> };

const __dirname = getDirname(import.meta.url);
const _defaultEnvPath = path.join(__dirname, '..', '..', '.env');
const _defaultAuditPath = path.join(__dirname, '..', '..', 'data', 'nuke-audit.log');

let _envPath = _defaultEnvPath;
let _auditPath = _defaultAuditPath;

/** Current .env path (overridable for tests). */
export const ENV_PATH = _defaultEnvPath;

/** Override file paths for testing — prevents writes to real .env and audit log. */
export function _setTestPaths(envPath: string, auditPath: string): void {
  _envPath = envPath;
  _auditPath = auditPath;
}

/** Reset to default paths (call in afterEach). */
export function _resetPaths(): void {
  _envPath = _defaultEnvPath;
  _auditPath = _defaultAuditPath;
}

let _envWriteLock = false;

/** Write key=value pairs to .env, preserving comments and formatting. */
export function writeEnvValues(updates: Record<string, string>): void {
  // Filter out DB-managed keys — only bootstrap keys should be written to .env
  const dbKeys = Object.keys(updates).filter((k) => !BOOTSTRAP_KEYS.has(k));
  if (dbKeys.length > 0) {
    console.warn('[ENV-WRITER] Skipping .env write for DB-managed keys:', dbKeys.join(', '));
    updates = Object.fromEntries(Object.entries(updates).filter(([k]) => BOOTSTRAP_KEYS.has(k)));
    if (Object.keys(updates).length === 0) return;
  }
  // Track dangerous .env writes with stack trace — write to file since console may scroll
  if (updates.NUKE_BOT ?? updates.FIRST_RUN) {
    const stack = new Error().stack ?? 'no stack';
    const msg = `[${new Date().toISOString()}] CRITICAL ENV WRITE: ${JSON.stringify(updates)}\nStack: ${stack}\n\n`;
    console.warn('[ENV-WRITER] ⚠ Writing critical key:', JSON.stringify(updates));
    try {
      fs.appendFileSync(_auditPath, msg);
    } catch (auditErr) {
      const errMsg = auditErr instanceof Error ? auditErr.message : String(auditErr);
      console.error('[ENV-WRITER] CRITICAL: Failed to write nuke audit log:', errMsg);
    }
  }
  if (_envWriteLock) throw new Error('.env write already in progress');
  _envWriteLock = true;
  try {
    let content: string;
    try {
      content = fs.readFileSync(_envPath, 'utf8');
    } catch (readErr) {
      if ((readErr as NodeJS.ErrnoException).code === 'ENOENT') {
        content = '';
      } else {
        const err = readErr as NodeJS.ErrnoException;
        throw new Error(`.env read failed (${err.code ?? 'UNKNOWN'}): ${err.message}`, { cause: readErr });
      }
    }
    for (const [key, rawValue] of Object.entries(updates)) {
      // Sanitize: strip newlines/carriage returns to prevent env injection
      const value = rawValue.replace(/[\r\n]+/g, ' ');
      const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`^(#\\s*)?${escapedKey}\\s*=.*$`, 'm');
      if (regex.test(content)) {
        content = content.replace(regex, `${key}=${value}`);
      } else {
        content += `\n${key}=${value}`;
      }
      process.env[key] = value;
    }
    fs.writeFileSync(_envPath, content, 'utf8');
  } finally {
    _envWriteLock = false;
  }
}

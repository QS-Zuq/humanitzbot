/**
 * Shared logger helper — prevents log injection (CWE-117) by ensuring the
 * format string passed to console.log/warn/error is always a constant.
 *
 * In Node.js, console.log uses util.format internally. If the first argument
 * contains %s/%d and additional arguments follow, they get substituted.
 * By using `console.log('[%s]', label, ...args)` the label is always in the
 * second position, never interpreted as a format directive.
 *
 * The label is sanitized: CR/LF/tab removed (prevents log forging),
 * non-word characters stripped (prevents format-string injection via %),
 * and length capped at 40 characters.
 *
 * Usage:
 *   const { createLogger } = require('../utils/log');
 *   this._log = createLogger(deps.label, 'MODULE_NAME');
 *   this._log.info('Started successfully');
 *   this._log.error('Failed:', err.message);
 */

/**
 * Sanitize a log label to prevent log injection.
 * @param {*} raw - Raw label value (may come from user-configurable server names)
 * @param {string} fallback - Default label if raw is empty
 * @returns {string} Safe single-line label
 */
function sanitizeLabel(raw, fallback) {
  return String(raw ?? fallback ?? 'APP')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[^\w :/-]/g, '')
    .trim()
    .slice(0, 40);
}

/**
 * Create a logger instance with a fixed label prefix.
 * The format string is always a constant — label goes into %s slot.
 *
 * @param {*} rawLabel - Label from deps injection
 * @param {string} fallback - Default label
 * @returns {{ info: Function, warn: Function, error: Function, label: string }}
 */
function createLogger(rawLabel, fallback) {
  const label = sanitizeLabel(rawLabel, fallback);
  return {
    label,
    info: (...args) => console.log('[%s]', label, ...args),
    warn: (...args) => console.warn('[%s]', label, ...args),
    error: (...args) => console.error('[%s]', label, ...args),
  };
}

module.exports = { createLogger, sanitizeLabel };

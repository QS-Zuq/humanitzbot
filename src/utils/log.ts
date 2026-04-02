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
 */

export interface Logger {
  label: string;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

/**
 * Sanitize a log label to prevent log injection.
 * @param raw - Raw label value (may come from user-configurable server names)
 * @param fallback - Default label if raw is empty
 * @returns Safe single-line label
 */
export function sanitizeLabel(raw: unknown, fallback?: string): string {
  const str = typeof raw === 'string' ? raw : typeof fallback === 'string' ? fallback : 'APP';
  return str
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[^\w :/-]/g, '')
    .trim()
    .slice(0, 40);
}

/**
 * Create a logger instance with a fixed label prefix.
 * The format string is always a constant — label goes into %s slot.
 */
export function createLogger(rawLabel: unknown, fallback?: string): Logger {
  const label = sanitizeLabel(rawLabel, fallback);
  return {
    label,
    info: (...args: unknown[]) => {
      console.log('[%s]', label, ...args);
    },
    warn: (...args: unknown[]) => {
      console.warn('[%s]', label, ...args);
    },
    error: (...args: unknown[]) => {
      console.error('[%s]', label, ...args);
    },
  };
}

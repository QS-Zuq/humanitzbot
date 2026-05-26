/**
 * Shared logger helper — creates category-scoped loggers that output to both
 * the console (human-readable) and structured JSON log files (daily rotation).
 *
 * Delegates to the structured logger system (src/logger/) for file output
 * while preserving the simple createLogger() API used throughout the codebase.
 *
 * Labels are sanitized to prevent log injection (CWE-117).
 */

import { createStructuredLogger } from '../logger/logger.js';

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
 * Writes to both console (human-readable) and structured JSON log files.
 */
export function createLogger(rawLabel: unknown, fallback?: string): Logger {
  const label = sanitizeLabel(rawLabel, fallback);
  const structured = createStructuredLogger(label);

  return {
    label,
    info: (...args: unknown[]) => {
      structured.info(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    },
    warn: (...args: unknown[]) => {
      structured.warn(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    },
    error: (...args: unknown[]) => {
      structured.error(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    },
  };
}

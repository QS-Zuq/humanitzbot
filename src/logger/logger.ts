import type { LogEntry, LogLevel, Transport } from './types.js';
import { ConsoleTransport, FileTransport } from './transports.js';
import { getDirname } from '../utils/paths.js';
import path from 'node:path';

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const defaultLogDir = path.join(getDirname(import.meta.url), '..', '..', 'logs');

let globalTransports: Transport[] = [];
let globalMinLevel: LogLevel = 'info';
let initialized = false;

/** Initialize the global logging system. Call once at startup. */
export function initLogger(opts: { logDir?: string; level?: LogLevel; console?: boolean; file?: boolean } = {}): void {
  if (initialized) return;
  const logDir = opts.logDir ?? defaultLogDir;

  if (opts.console !== false) {
    globalTransports.push(new ConsoleTransport());
  }
  if (opts.file !== false) {
    globalTransports.push(new FileTransport(logDir));
  }
  globalMinLevel = opts.level ?? 'info';
  initialized = true;
}

/** Shut down all transports. */
export function shutdownLogger(): void {
  for (const t of globalTransports) {
    t.close?.();
  }
  globalTransports = [];
  initialized = false;
}

/** Create a category-scoped logger instance. */
export function createStructuredLogger(category: string) {
  function log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    if (LOG_LEVELS[level] < LOG_LEVELS[globalMinLevel]) return;

    // Lazy-init with defaults if not explicitly initialized
    if (!initialized) {
      initLogger();
    }

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      category,
      message,
      ...(data !== undefined ? { data } : {}),
    };

    for (const transport of globalTransports) {
      transport.write(entry);
    }
  }

  return {
    category,
    debug: (message: string, data?: Record<string, unknown>) => {
      log('debug', message, data);
    },
    info: (message: string, data?: Record<string, unknown>) => {
      log('info', message, data);
    },
    warn: (message: string, data?: Record<string, unknown>) => {
      log('warn', message, data);
    },
    error: (message: string, data?: Record<string, unknown>) => {
      log('error', message, data);
    },
  };
}

/**
 * Session store factory for express-session.
 *
 * Pluggable backends:
 *   - 'memory'  — express-session built-in MemoryStore (dev/testing only)
 *   - 'sqlite'  — SQLite via better-sqlite3 (default, zero extra deps)
 *   - 'redis'   — Redis via connect-redis + redis (optional, user installs)
 */

import type { Store } from 'express-session';
import { createRequire } from 'node:module';
import { createLogger } from '../utils/log.js';
import { SqliteSessionStore } from './session-stores/sqlite-store.js';
import { errMsg } from '../utils/error.js';

const _require = createRequire(import.meta.url);

const _log = createLogger(null, 'SESSION');

// Config subset needed by this factory
interface SessionConfig {
  sessionStore?: string;
  sessionRedisUrl?: string;
  sessionTtl?: number;
}

function createSessionStore(config: SessionConfig, db?: unknown): Store | undefined {
  const storeType = (config.sessionStore || 'sqlite').toLowerCase();

  switch (storeType) {
    // @ts-expect-error — intentional fallthrough from redis to sqlite
    case 'redis': {
      try {
        const connectRedis: Record<string, unknown> = _require('connect-redis') as Record<string, unknown>;
        const RedisStore = (connectRedis['RedisStore'] ?? connectRedis['default'] ?? connectRedis) as new (
          opts: Record<string, unknown>,
        ) => Store & { _redisClient?: unknown };
        const redisModule: Record<string, unknown> = _require('redis') as Record<string, unknown>;
        const createClient = redisModule['createClient'] as (opts: Record<string, unknown>) => {
          on(event: string, cb: (err: Error) => void): void;
          connect(): Promise<void>;
        };

        const redisClient = createClient({ url: config.sessionRedisUrl || 'redis://localhost:6379' });

        redisClient.on('error', (err: Error) => {
          _log.error('Redis client error:', err.message);
        });

        // connect-redis handles connect asynchronously; connect and log
        redisClient
          .connect()
          .then(() => {
            _log.info('Redis connected');
          })
          .catch((err: unknown) => {
            _log.error('Redis connect failed:', errMsg(err));
            _log.error('Sessions will fail until Redis is available');
          });

        const store = new RedisStore({
          client: redisClient,
          prefix: 'hmz:sess:',
          ttl: config.sessionTtl || 604800,
        });

        // Attach redis client for graceful shutdown
        store._redisClient = redisClient;

        _log.info('Using Redis session store');
        return store;
      } catch (err: unknown) {
        if (typeof err === 'object' && err !== null && (err as { code?: string }).code === 'MODULE_NOT_FOUND') {
          _log.error('Redis packages not installed. Run: npm install redis connect-redis');
          _log.info('Falling back to SQLite store');
          // Fall through to sqlite
        } else {
          throw err;
        }
      }
    }
    // falls through
    case 'sqlite': {
      if (!db) {
        _log.warn('No database provided for SQLite store — falling back to memory');
        return undefined;
      }
      const store = new (SqliteSessionStore as unknown as new (db: unknown, opts: { table: string }) => Store)(db, {
        // SAFETY: express-session Store inheritance not typed
        table: 'web_sessions',
      });
      _log.info('Using SQLite session store');
      return store;
    }
    default: {
      // 'memory' or any unrecognized value
      if (storeType !== 'memory') {
        _log.warn('Unknown store type %s — falling back to memory', storeType);
      }
      _log.info('Using in-memory session store (sessions lost on restart)');
      return undefined; // express-session uses MemoryStore by default
    }
  }
}

export { createSessionStore };

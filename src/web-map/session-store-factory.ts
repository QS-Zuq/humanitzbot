/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment,
   @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
/**
 * Session store factory for express-session.
 *
 * Pluggable backends:
 *   - 'memory'  — express-session built-in MemoryStore (dev/testing only)
 *   - 'sqlite'  — SQLite via better-sqlite3 (default, zero extra deps)
 *   - 'redis'   — Redis via connect-redis + redis (optional, user installs)
 */

import type { Store } from 'express-session';
import { createLogger } from '../utils/log.js';
import { SqliteSessionStore } from './session-stores/sqlite-store.js';

const _log = createLogger(null, 'SESSION');

function createSessionStore(config: any, db?: any): Store | undefined {
  const storeType = ((config.sessionStore as string) || 'sqlite').toLowerCase();

  switch (storeType) {
    // @ts-expect-error — intentional fallthrough from redis to sqlite
    case 'redis': {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- optional dep, lazy-loaded in sync factory
        const connectRedis = require('connect-redis');
        const RedisStore = connectRedis.RedisStore || connectRedis.default || connectRedis;
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- optional dep, lazy-loaded in sync factory
        const { createClient } = require('redis');

        const redisClient = createClient({ url: (config.sessionRedisUrl as string) || 'redis://localhost:6379' });

        redisClient.on('error', (err: Error) => {
          _log.error('Redis client error:', err.message);
        });

        // connect-redis handles connect asynchronously; connect and log
        (redisClient.connect() as Promise<void>)
          .then(() => {
            _log.info('Redis connected');
          })
          .catch((err: unknown) => {
            _log.error('Redis connect failed:', (err as Error).message);
            _log.error('Sessions will fail until Redis is available');
          });

        const store = new RedisStore({
          client: redisClient,
          prefix: 'hmz:sess:',
          ttl: (config.sessionTtl as number) || 604800,
        });

        // Attach redis client for graceful shutdown
        store._redisClient = redisClient;

        _log.info('Using Redis session store');
        return store as Store;
      } catch (err: unknown) {
        if ((err as any).code === 'MODULE_NOT_FOUND') {
          _log.error('Redis packages not installed. Run: npm install redis connect-redis');
          _log.info('Falling back to SQLite store');
          // Fall through to sqlite
        } else {
          throw err;
        }
      }
    }
    // eslint-disable-next-line no-fallthrough
    case 'sqlite': {
      if (!db) {
        _log.warn('No database provided for SQLite store — falling back to memory');
        return undefined;
      }
      const store = new (SqliteSessionStore as unknown as new (db: any, opts: any) => Store)(db, {
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

/**
 * Session store factory for express-session.
 *
 * Pluggable backends:
 *   - 'memory'  — express-session built-in MemoryStore (dev/testing only)
 *   - 'sqlite'  — SQLite via better-sqlite3 (default, zero extra deps)
 *   - 'redis'   — Redis via connect-redis + redis (optional, user installs)
 *
 * @param {object} config - Bot config object (sessionStore, sessionTtl, sessionRedisUrl)
 * @param {import('better-sqlite3').Database} [db] - SQLite database instance (for sqlite store)
 * @returns {import('express-session').Store|undefined} Store instance, or undefined for MemoryStore
 */

'use strict';

function createSessionStore(config, db) {
  const storeType = (config.sessionStore || 'sqlite').toLowerCase();

  switch (storeType) {
    case 'redis': {
      try {
        // Lazy require — only loaded if redis + connect-redis are installed
        const RedisStore = require('connect-redis').default;
        const { createClient } = require('redis');

        const redisClient = createClient({ url: config.sessionRedisUrl || 'redis://localhost:6379' });

        redisClient.on('error', (err) => {
          console.error('[SESSION] Redis client error:', err.message);
        });

        // connect-redis handles connect asynchronously; connect and log
        redisClient
          .connect()
          .then(() => console.log('[SESSION] Redis connected'))
          .catch((err) => {
            console.error('[SESSION] Redis connect failed:', err.message);
            console.error('[SESSION] Sessions will fail until Redis is available');
          });

        const store = new RedisStore({
          client: redisClient,
          prefix: 'hmz:sess:',
          ttl: config.sessionTtl || 604800,
        });

        // Attach redis client for graceful shutdown
        store._redisClient = redisClient;

        console.log('[SESSION] Using Redis session store');
        return store;
      } catch (err) {
        if (err.code === 'MODULE_NOT_FOUND') {
          console.error('[SESSION] Redis packages not installed. Run: npm install redis connect-redis');
          console.log('[SESSION] Falling back to SQLite store');
          // Fall through to sqlite
        } else {
          throw err;
        }
      }
    }
    // eslint-disable-next-line no-fallthrough
    case 'sqlite': {
      if (!db) {
        console.warn('[SESSION] No database provided for SQLite store — falling back to memory');
        return undefined;
      }
      const { SqliteSessionStore } = require('./session-stores/sqlite-store');
      const store = new SqliteSessionStore(db, { table: 'web_sessions' });
      console.log('[SESSION] Using SQLite session store');
      return store;
    }
    default: {
      // 'memory' or any unrecognized value
      if (storeType !== 'memory') {
        console.warn(`[SESSION] Unknown store type "${storeType}" — falling back to memory`);
      }
      console.log('[SESSION] Using in-memory session store (sessions lost on restart)');
      return undefined; // express-session uses MemoryStore by default
    }
  }
}

module.exports = { createSessionStore };

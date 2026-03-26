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

const { createLogger } = require('../utils/log');
const _log = createLogger(null, 'SESSION');

function createSessionStore(config, db) {
  const storeType = (config.sessionStore || 'sqlite').toLowerCase();

  switch (storeType) {
    case 'redis': {
      try {
        // Lazy require — only loaded if redis + connect-redis are installed
        const connectRedis = require('connect-redis');
        const RedisStore = connectRedis.RedisStore || connectRedis.default || connectRedis;
        const { createClient } = require('redis');

        const redisClient = createClient({ url: config.sessionRedisUrl || 'redis://localhost:6379' });

        redisClient.on('error', (err) => {
          _log.error('Redis client error:', err.message);
        });

        // connect-redis handles connect asynchronously; connect and log
        redisClient
          .connect()
          .then(() => _log.info('Redis connected'))
          .catch((err) => {
            _log.error('Redis connect failed:', err.message);
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
      } catch (err) {
        if (err.code === 'MODULE_NOT_FOUND') {
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
      const { SqliteSessionStore } = require('./session-stores/sqlite-store');
      const store = new SqliteSessionStore(db, { table: 'web_sessions' });
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

module.exports = { createSessionStore };

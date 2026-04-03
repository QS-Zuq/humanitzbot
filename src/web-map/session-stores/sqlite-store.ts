/**
 * SQLite session store for express-session.
 *
 * Uses the existing better-sqlite3 dependency — zero additional packages needed.
 * Implements the express-session Store interface: get, set, destroy, touch, clear, length, all.
 *
 * Table: web_sessions (sid TEXT PK, sess TEXT NOT NULL, expired INTEGER NOT NULL)
 * Background cleanup runs every 15 minutes to prune expired rows.
 */

import { Store } from 'express-session';
import util from 'util';
import { createLogger } from '../../utils/log.js';

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access,
   @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call,
   @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return,
   @typescript-eslint/restrict-plus-operands
   -- Prototype-based Store subclass with untyped better-sqlite3 db */

const _log = createLogger(null, 'SESSION:SQLite');

// ── SqliteSessionStore ──────────────────────────────────────────────────────

interface SqliteStoreOptions {
  table?: string;
  cleanupInterval?: number;
  ttlMs?: number;
}

function SqliteSessionStore(this: any, db: any, opts: SqliteStoreOptions = {}) {
  (Store as any).call(this, opts);

  this._db = db;
  this._table = opts.table || 'web_sessions';
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(this._table as string)) {
    throw new Error(`[SESSION] Invalid table name: ${this._table as string}`);
  }
  this._cleanupInterval = opts.cleanupInterval ?? 15 * 60 * 1000;
  this._cleanupTimer = null;
  this._ttlMs = opts.ttlMs || 7 * 24 * 60 * 60 * 1000; // default 7 days

  this._ensureTable();
  this._prepareStatements();
  this._startCleanup();
}

util.inherits(SqliteSessionStore, Store);

// ── Schema ──────────────────────────────────────────────────────────────────

SqliteSessionStore.prototype._ensureTable = function (this: any) {
  const ddl = `
    CREATE TABLE IF NOT EXISTS ${this._table as string} (
      sid TEXT PRIMARY KEY,
      sess TEXT NOT NULL,
      expired INTEGER NOT NULL
    )
  `;
  this._db.exec(ddl);
  const idx = `CREATE INDEX IF NOT EXISTS idx_${this._table as string}_expired ON ${this._table as string} (expired)`;
  this._db.exec(idx);
};

// ── Prepared Statements ─────────────────────────────────────────────────────

SqliteSessionStore.prototype._prepareStatements = function (this: any) {
  const t = this._table as string;
  this._stmtGet = this._db.prepare(`SELECT sess FROM ${t} WHERE sid = ? AND expired > ?`);
  this._stmtSet = this._db.prepare(`INSERT OR REPLACE INTO ${t} (sid, sess, expired) VALUES (?, ?, ?)`);
  this._stmtDestroy = this._db.prepare(`DELETE FROM ${t} WHERE sid = ?`);
  this._stmtTouch = this._db.prepare(`UPDATE ${t} SET expired = ? WHERE sid = ?`);
  this._stmtLength = this._db.prepare(`SELECT COUNT(*) AS cnt FROM ${t} WHERE expired > ?`);
  this._stmtClear = this._db.prepare(`DELETE FROM ${t}`);
  this._stmtAll = this._db.prepare(`SELECT sess FROM ${t} WHERE expired > ?`);
  this._stmtPrune = this._db.prepare(`DELETE FROM ${t} WHERE expired <= ?`);
};

// ── Store Interface ─────────────────────────────────────────────────────────

SqliteSessionStore.prototype.get = function (
  this: any,
  sid: string,
  callback: (err: Error | null, session?: any) => void,
) {
  try {
    const now = Date.now();
    const row = this._stmtGet.get(sid, now);
    if (!row) {
      callback(null, null);
      return;
    }
    const sess = JSON.parse(row.sess);
    callback(null, sess);
  } catch (err) {
    callback(err as Error);
  }
};

SqliteSessionStore.prototype.set = function (
  this: any,
  sid: string,
  session: any,
  callback: (err: Error | null) => void,
) {
  try {
    const expired = this._getExpireTime(session);
    const sess = JSON.stringify(session);
    this._stmtSet.run(sid, sess, expired);
    callback(null);
  } catch (err) {
    callback(err as Error);
  }
};

SqliteSessionStore.prototype.destroy = function (this: any, sid: string, callback?: (err: Error | null) => void) {
  try {
    this._stmtDestroy.run(sid);
    if (callback) callback(null);
  } catch (err) {
    if (callback) callback(err as Error);
  }
};

SqliteSessionStore.prototype.touch = function (
  this: any,
  sid: string,
  session: any,
  callback: (err: Error | null) => void,
) {
  try {
    const expired = this._getExpireTime(session);
    this._stmtTouch.run(expired, sid);
    callback(null);
  } catch (err) {
    callback(err as Error);
  }
};

SqliteSessionStore.prototype.length = function (this: any, callback: (err: Error | null, length?: number) => void) {
  try {
    const row = this._stmtLength.get(Date.now());
    callback(null, row.cnt);
  } catch (err) {
    callback(err as Error);
  }
};

SqliteSessionStore.prototype.clear = function (this: any, callback: (err: Error | null) => void) {
  try {
    this._stmtClear.run();
    callback(null);
  } catch (err) {
    callback(err as Error);
  }
};

SqliteSessionStore.prototype.all = function (this: any, callback: (err: Error | null, sessions?: any[]) => void) {
  try {
    const rows = this._stmtAll.all(Date.now());
    const sessions = rows.map((r: any) => JSON.parse(r.sess));
    callback(null, sessions);
  } catch (err) {
    callback(err as Error);
  }
};

// ── Helpers ─────────────────────────────────────────────────────────────────

SqliteSessionStore.prototype._getExpireTime = function (this: any, session: any) {
  if (session && session.cookie) {
    if (session.cookie.expires) {
      const t = new Date(session.cookie.expires).getTime();
      if (!isNaN(t)) return t;
    }
    if (typeof session.cookie.maxAge === 'number' && session.cookie.maxAge > 0) {
      return Date.now() + session.cookie.maxAge;
    }
    if (typeof session.cookie.originalMaxAge === 'number' && session.cookie.originalMaxAge > 0) {
      return Date.now() + session.cookie.originalMaxAge;
    }
  }
  return Date.now() + ((this._ttlMs as number) || 7 * 24 * 60 * 60 * 1000);
};

// ── Background Cleanup ──────────────────────────────────────────────────────

SqliteSessionStore.prototype._startCleanup = function (this: any) {
  if ((this._cleanupInterval as number) <= 0) return;
  this._cleanupTimer = setInterval(() => {
    try {
      const result = this._stmtPrune.run(Date.now());
      if (result.changes > 0) {
        _log.info('Pruned %d expired session(s)', result.changes);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      _log.error('Cleanup error:', msg);
    }
  }, this._cleanupInterval as number);
  this._cleanupTimer.unref();
};

SqliteSessionStore.prototype.stopCleanup = function (this: any) {
  if (this._cleanupTimer) {
    clearInterval(this._cleanupTimer);
    this._cleanupTimer = null;
  }
};

export { SqliteSessionStore };

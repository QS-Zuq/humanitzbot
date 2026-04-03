/**
 * SQLite session store for express-session.
 *
 * Uses the existing better-sqlite3 dependency — zero additional packages needed.
 * Implements the express-session Store interface: get, set, destroy, touch, clear, length, all.
 *
 * Table: web_sessions (sid TEXT PK, sess TEXT NOT NULL, expired INTEGER NOT NULL)
 * Background cleanup runs every 15 minutes to prune expired rows.
 */

import { Store, type SessionData } from 'express-session';
import util from 'util';
import { createLogger } from '../../utils/log.js';

// Prototype-based Store subclass with typed better-sqlite3 interfaces

const _log = createLogger(null, 'SESSION:SQLite');

// ── Typed interfaces for better-sqlite3 operations ──

interface PreparedStatement {
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
  run(...params: unknown[]): { changes: number };
}

interface DbHandle {
  exec(sql: string): void;
  prepare(sql: string): PreparedStatement;
}

// ── SqliteSessionStore ──────────────────────────────────────────────────────

interface SqliteStoreOptions {
  table?: string;
  cleanupInterval?: number;
  ttlMs?: number;
}

interface SqliteStoreInstance extends Store {
  _db: DbHandle;
  _table: string;
  _cleanupInterval: number;
  _cleanupTimer: ReturnType<typeof setInterval> | null;
  _ttlMs: number;
  _stmtGet: PreparedStatement;
  _stmtSet: PreparedStatement;
  _stmtDestroy: PreparedStatement;
  _stmtTouch: PreparedStatement;
  _stmtLength: PreparedStatement;
  _stmtClear: PreparedStatement;
  _stmtAll: PreparedStatement;
  _stmtPrune: PreparedStatement;
  _ensureTable(): void;
  _prepareStatements(): void;
  _startCleanup(): void;
  _getExpireTime(session: SessionData): number;
  stopCleanup(): void;
}

function SqliteSessionStore(this: SqliteStoreInstance, db: DbHandle, opts: SqliteStoreOptions = {}) {
  (Store as unknown as { call(thisArg: unknown, opts: Record<string, unknown>): void }).call(
    this,
    opts as Record<string, unknown>,
  );

  this._db = db;
  this._table = opts.table || 'web_sessions';
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(this._table)) {
    throw new Error(`[SESSION] Invalid table name: ${this._table}`);
  }
  this._cleanupInterval = opts.cleanupInterval ?? 15 * 60 * 1000;
  this._cleanupTimer = null;
  this._ttlMs = opts.ttlMs || 7 * 24 * 60 * 60 * 1000; // default 7 days

  this._ensureTable();
  this._prepareStatements();
  this._startCleanup();
}

util.inherits(SqliteSessionStore, Store);

const _proto = SqliteSessionStore.prototype as SqliteStoreInstance;

// ── Schema ──────────────────────────────────────────────────────────────────

_proto._ensureTable = function (this: SqliteStoreInstance) {
  const ddl = `
    CREATE TABLE IF NOT EXISTS ${this._table} (
      sid TEXT PRIMARY KEY,
      sess TEXT NOT NULL,
      expired INTEGER NOT NULL
    )
  `;
  this._db.exec(ddl);
  const idx = `CREATE INDEX IF NOT EXISTS idx_${this._table}_expired ON ${this._table} (expired)`;
  this._db.exec(idx);
};

// ── Prepared Statements ─────────────────────────────────────────────────────

_proto._prepareStatements = function (this: SqliteStoreInstance) {
  const t = this._table;
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

_proto.get = function (
  this: SqliteStoreInstance,
  sid: string,
  callback: (err: Error | null, session?: SessionData | null) => void,
) {
  try {
    const now = Date.now();
    const row = this._stmtGet.get(sid, now);
    if (!row) {
      callback(null, null);
      return;
    }
    const sess = JSON.parse(row['sess'] as string) as SessionData;
    callback(null, sess);
  } catch (err) {
    callback(err as Error);
  }
};

_proto.set = function (
  this: SqliteStoreInstance,
  sid: string,
  session: SessionData,
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

_proto.destroy = function (this: SqliteStoreInstance, sid: string, callback?: (err: Error | null) => void) {
  try {
    this._stmtDestroy.run(sid);
    if (callback) callback(null);
  } catch (err) {
    if (callback) callback(err as Error);
  }
};

_proto.touch = function (this: SqliteStoreInstance, sid: string, session: SessionData, callback?: () => void) {
  try {
    const expired = this._getExpireTime(session);
    this._stmtTouch.run(expired, sid);
    if (callback) callback();
  } catch {
    // touch errors are non-critical
  }
};

_proto.length = function (this: SqliteStoreInstance, callback: (err: Error | null, length?: number) => void) {
  try {
    const row = this._stmtLength.get(Date.now());
    callback(null, (row?.['cnt'] as number | undefined) ?? 0);
  } catch (err) {
    callback(err as Error);
  }
};

_proto.clear = function (this: SqliteStoreInstance, callback: (err: Error | null) => void) {
  try {
    this._stmtClear.run();
    callback(null);
  } catch (err) {
    callback(err as Error);
  }
};

_proto.all = function (this: SqliteStoreInstance, callback: (err: Error | null, sessions?: SessionData[]) => void) {
  try {
    const rows = this._stmtAll.all(Date.now());
    const sessions = rows.map((r: Record<string, unknown>) => JSON.parse(r['sess'] as string) as SessionData);
    callback(null, sessions);
  } catch (err) {
    callback(err as Error);
  }
};

// ── Helpers ─────────────────────────────────────────────────────────────────

_proto._getExpireTime = function (this: SqliteStoreInstance, session: SessionData): number {
  const cookie = session.cookie;
  if (typeof cookie.maxAge === 'number' && cookie.maxAge > 0) {
    return Date.now() + cookie.maxAge;
  }
  if (typeof cookie.originalMaxAge === 'number' && cookie.originalMaxAge > 0) {
    return Date.now() + cookie.originalMaxAge;
  }
  return Date.now() + (this._ttlMs || 7 * 24 * 60 * 60 * 1000);
};

// ── Background Cleanup ──────────────────────────────────────────────────────

_proto._startCleanup = function (this: SqliteStoreInstance) {
  if (this._cleanupInterval <= 0) return;
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
  }, this._cleanupInterval);
  this._cleanupTimer.unref();
};

_proto.stopCleanup = function (this: SqliteStoreInstance) {
  if (this._cleanupTimer) {
    clearInterval(this._cleanupTimer);
    this._cleanupTimer = null;
  }
};

export { SqliteSessionStore };

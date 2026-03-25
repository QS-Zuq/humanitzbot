/**
 * SQLite session store for express-session.
 *
 * Uses the existing better-sqlite3 dependency — zero additional packages needed.
 * Implements the express-session Store interface: get, set, destroy, touch, clear, length, all.
 *
 * Table: web_sessions (sid TEXT PK, sess TEXT NOT NULL, expired INTEGER NOT NULL)
 * Background cleanup runs every 15 minutes to prune expired rows.
 */

'use strict';

const { Store } = require('express-session');
const util = require('util');

// ── SqliteSessionStore ──────────────────────────────────────────────────────

/**
 * @param {import('better-sqlite3').Database} db - better-sqlite3 database instance
 * @param {object} [opts]
 * @param {string} [opts.table='web_sessions'] - table name
 * @param {number} [opts.cleanupInterval=900000] - cleanup interval in ms (default 15 min)
 */
function SqliteSessionStore(db, opts = {}) {
  Store.call(this, opts);

  this._db = db;
  this._table = opts.table || 'web_sessions';
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(this._table)) {
    throw new Error(`[SESSION] Invalid table name: ${this._table}`);
  }
  this._cleanupInterval = opts.cleanupInterval ?? 15 * 60 * 1000;
  this._cleanupTimer = null;

  this._ensureTable();
  this._prepareStatements();
  this._startCleanup();
}

util.inherits(SqliteSessionStore, Store);

// ── Schema ──────────────────────────────────────────────────────────────────

SqliteSessionStore.prototype._ensureTable = function () {
  this._db.exec(`
    CREATE TABLE IF NOT EXISTS ${this._table} (
      sid TEXT PRIMARY KEY,
      sess TEXT NOT NULL,
      expired INTEGER NOT NULL
    )
  `);
  this._db.exec(`
    CREATE INDEX IF NOT EXISTS idx_${this._table}_expired ON ${this._table} (expired)
  `);
};

// ── Prepared Statements ─────────────────────────────────────────────────────

SqliteSessionStore.prototype._prepareStatements = function () {
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

SqliteSessionStore.prototype.get = function (sid, callback) {
  try {
    const now = Date.now();
    const row = this._stmtGet.get(sid, now);
    if (!row) return callback(null, null);
    const sess = JSON.parse(row.sess);
    callback(null, sess);
  } catch (err) {
    callback(err);
  }
};

SqliteSessionStore.prototype.set = function (sid, session, callback) {
  try {
    const expired = this._getExpireTime(session);
    const sess = JSON.stringify(session);
    this._stmtSet.run(sid, sess, expired);
    callback(null);
  } catch (err) {
    callback(err);
  }
};

SqliteSessionStore.prototype.destroy = function (sid, callback) {
  try {
    this._stmtDestroy.run(sid);
    if (callback) callback(null);
  } catch (err) {
    if (callback) callback(err);
  }
};

SqliteSessionStore.prototype.touch = function (sid, session, callback) {
  try {
    const expired = this._getExpireTime(session);
    this._stmtTouch.run(expired, sid);
    callback(null);
  } catch (err) {
    callback(err);
  }
};

SqliteSessionStore.prototype.length = function (callback) {
  try {
    const row = this._stmtLength.get(Date.now());
    callback(null, row.cnt);
  } catch (err) {
    callback(err);
  }
};

SqliteSessionStore.prototype.clear = function (callback) {
  try {
    this._stmtClear.run();
    callback(null);
  } catch (err) {
    callback(err);
  }
};

SqliteSessionStore.prototype.all = function (callback) {
  try {
    const rows = this._stmtAll.all(Date.now());
    const sessions = rows.map((r) => JSON.parse(r.sess));
    callback(null, sessions);
  } catch (err) {
    callback(err);
  }
};

// ── Helpers ─────────────────────────────────────────────────────────────────

SqliteSessionStore.prototype._getExpireTime = function (session) {
  if (session && session.cookie && session.cookie.expires) {
    return new Date(session.cookie.expires).getTime();
  }
  // Fallback: 24 hours from now
  return Date.now() + 86400000;
};

// ── Background Cleanup ──────────────────────────────────────────────────────

SqliteSessionStore.prototype._startCleanup = function () {
  if (this._cleanupInterval <= 0) return;
  this._cleanupTimer = setInterval(() => {
    try {
      const result = this._stmtPrune.run(Date.now());
      if (result.changes > 0) {
        console.log(`[SESSION] Pruned ${result.changes} expired session(s)`);
      }
    } catch (err) {
      console.error('[SESSION] Cleanup error:', err.message);
    }
  }, this._cleanupInterval);
  this._cleanupTimer.unref();
};

SqliteSessionStore.prototype.stopCleanup = function () {
  if (this._cleanupTimer) {
    clearInterval(this._cleanupTimer);
    this._cleanupTimer = null;
  }
};

module.exports = { SqliteSessionStore };

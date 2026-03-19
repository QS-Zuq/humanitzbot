/**
 * ConfigRepository — DB-backed configuration storage using config_documents table.
 *
 * Each document is a JSON object stored under a scope key:
 *   - 'app'             — global bot settings (flat cfgKey)
 *   - 'server:primary'  — primary RCON/SFTP settings (flat cfgKey)
 *   - 'server:srv_xxx'  — managed server definitions (NESTED serverDef)
 *
 * Uses UPSERT for set(), transactions for update() (read→merge→write atomically).
 * Version auto-increments on every write.
 */

'use strict';

class ConfigRepository {
  /**
   * @param {import('./database')} db - HumanitZDB instance
   */
  constructor(db) {
    this._db = db;
    this._handle = db._db || db.db; // underlying better-sqlite3 handle
    this._prepareStatements();
  }

  // ── Prepared statements ──────────────────────────────────────

  _prepareStatements() {
    this._stmts = {
      get: this._handle.prepare('SELECT data FROM config_documents WHERE scope = ?'),

      getMeta: this._handle.prepare('SELECT data, version, updated_at FROM config_documents WHERE scope = ?'),

      set: this._handle.prepare(`
        INSERT INTO config_documents (scope, data, version, updated_at)
        VALUES (?, ?, 1, datetime('now'))
        ON CONFLICT(scope) DO UPDATE SET
          data = excluded.data,
          version = config_documents.version + 1,
          updated_at = datetime('now')
      `),

      delete: this._handle.prepare('DELETE FROM config_documents WHERE scope = ?'),

      loadAll: this._handle.prepare('SELECT scope, data, version, updated_at FROM config_documents'),

      listServerScopes: this._handle.prepare("SELECT scope FROM config_documents WHERE scope LIKE 'server:%'"),
    };
  }

  // ── Public API ───────────────────────────────────────────────

  /**
   * Get the parsed data for a scope.
   * @param {string} scope
   * @returns {object|null}
   */
  get(scope) {
    const row = this._stmts.get.get(scope);
    if (!row) return null;
    try {
      return JSON.parse(row.data);
    } catch (err) {
      console.error('[CONFIG-REPO] Corrupt JSON in scope="' + scope + '":', err.message);
      return null;
    }
  }

  /**
   * Set (upsert) the full data for a scope. Replaces the entire document.
   * @param {string} scope
   * @param {object} data
   */
  set(scope, data) {
    this._stmts.set.run(scope, JSON.stringify(data));
  }

  /**
   * Merge-patch update: read→merge→write atomically in a transaction.
   * - Keys present in patch are merged
   * - Keys with value `undefined` are deleted
   * - Creates the document if it doesn't exist
   * @param {string} scope
   * @param {object} patch
   * @returns {object} The resulting merged document
   */
  update(scope, patch) {
    const txn = this._handle.transaction(() => {
      const existing = this.get(scope) || {};
      const merged = { ...existing };

      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) {
          delete merged[key];
        } else {
          merged[key] = value;
        }
      }

      this.set(scope, merged);
      return merged;
    });

    return txn();
  }

  /**
   * Delete a scope's document entirely.
   * @param {string} scope
   */
  delete(scope) {
    this._stmts.delete.run(scope);
  }

  /**
   * Load all config documents.
   * @returns {Map<string, { data: object, version: number, updatedAt: string }>}
   */
  loadAll() {
    const rows = this._stmts.loadAll.all();
    const map = new Map();
    for (const row of rows) {
      try {
        map.set(row.scope, {
          data: JSON.parse(row.data),
          version: row.version,
          updatedAt: row.updated_at,
        });
      } catch (err) {
        console.error(`[CONFIG-REPO] Skipping unparseable row scope="${row.scope}":`, err.message);
        // Skip unparseable rows
      }
    }
    return map;
  }

  /**
   * Get metadata for a scope (data + version + updatedAt).
   * @param {string} scope
   * @returns {{ data: object, version: number, updatedAt: string }|null}
   */
  getMeta(scope) {
    const row = this._stmts.getMeta.get(scope);
    if (!row) return null;
    try {
      return {
        data: JSON.parse(row.data),
        version: row.version,
        updatedAt: row.updated_at,
      };
    } catch (err) {
      console.error(`[CONFIG-REPO] Corrupt JSON in scope="${scope}" (getMeta):`, err.message);
      return null;
    }
  }

  /**
   * List all scopes that start with 'server:'.
   * @returns {string[]}
   */
  listServerScopes() {
    return this._stmts.listServerScopes.all().map((r) => r.scope);
  }
}

module.exports = ConfigRepository;

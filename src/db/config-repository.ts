/**
 * ConfigRepository — DB-backed configuration storage using config_documents table.
 *
 * Each document is a JSON object stored under a scope key:
 *   - 'app'             — global bot settings (flat cfgKey)
 *   - 'server:primary'  — primary RCON/SFTP settings (flat cfgKey)
 *   - 'server:srv_xxx'  — managed server definitions (NESTED serverDef)
 *
 * Uses UPSERT for set(), transactions for update() (read->merge->write atomically).
 * Version auto-increments on every write.
 */

import type Database from 'better-sqlite3';

interface HumanitZDBLike {
  _db?: Database.Database;
  db?: Database.Database;
}

interface ConfigMetaRow {
  data: string;
  version: number;
  updated_at: string;
}

interface ConfigMeta {
  data: Record<string, unknown>;
  version: number;
  updatedAt: string;
}

interface ConfigDocRow {
  scope: string;
  data: string;
  version: number;
  updated_at: string;
}

interface ScopeRow {
  scope: string;
}

class ConfigRepository {
  // Kept for potential future use / external access by consumers
  readonly _db: HumanitZDBLike;
  private readonly _handle: Database.Database;
  private _stmts!: {
    get: Database.Statement;
    getMeta: Database.Statement;
    set: Database.Statement;
    delete: Database.Statement;
    loadAll: Database.Statement;
    listServerScopes: Database.Statement;
  };

  constructor(db: HumanitZDBLike) {
    this._db = db;
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    this._handle = (db._db ?? db.db)!;
    this._prepareStatements();
  }

  // ── Prepared statements ──────────────────────────────────────

  private _prepareStatements(): void {
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

  get(scope: string): Record<string, unknown> | null {
    const row = this._stmts.get.get(scope) as { data: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.data) as Record<string, unknown>;
    } catch (err) {
      console.error('[CONFIG-REPO] Corrupt JSON in scope:', scope, (err as Error).message);
      return null;
    }
  }

  set(scope: string, data: Record<string, unknown>): void {
    this._stmts.set.run(scope, JSON.stringify(data));
  }

  update(scope: string, patch: Record<string, unknown>): Record<string, unknown> {
    const txn = this._handle.transaction(() => {
      const existing = this.get(scope) ?? {};
      const merged: Record<string, unknown> = { ...existing };

      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) {
          // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
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

  delete(scope: string): void {
    this._stmts.delete.run(scope);
  }

  loadAll(): Map<string, ConfigMeta> {
    const rows = this._stmts.loadAll.all() as ConfigDocRow[];
    const map = new Map<string, ConfigMeta>();
    for (const row of rows) {
      try {
        map.set(row.scope, {
          data: JSON.parse(row.data) as Record<string, unknown>,
          version: row.version,
          updatedAt: row.updated_at,
        });
      } catch (err) {
        console.error(`[CONFIG-REPO] Skipping unparseable row scope="${row.scope}":`, (err as Error).message);
      }
    }
    return map;
  }

  getMeta(scope: string): ConfigMeta | null {
    const row = this._stmts.getMeta.get(scope) as ConfigMetaRow | undefined;
    if (!row) return null;
    try {
      return {
        data: JSON.parse(row.data) as Record<string, unknown>,
        version: row.version,
        updatedAt: row.updated_at,
      };
    } catch (err) {
      console.error(`[CONFIG-REPO] Corrupt JSON in scope="${scope}" (getMeta):`, (err as Error).message);
      return null;
    }
  }

  listServerScopes(): string[] {
    return (this._stmts.listServerScopes.all() as ScopeRow[]).map((r) => r.scope);
  }
}

export default ConfigRepository;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _mod = module as { exports: any };
_mod.exports = ConfigRepository;

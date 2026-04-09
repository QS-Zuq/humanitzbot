import type Database from 'better-sqlite3';
import { BaseRepository } from './base-repository.js';

/**
 * MetaRepository — schema metadata key-value store.
 *
 * Manages the `meta` table used for schema versioning,
 * game reference seeding state, and other persistent metadata.
 */
export class MetaRepository extends BaseRepository {
  declare private _stmts: {
    getMeta: Database.Statement;
    setMeta: Database.Statement;
  };

  protected _prepareStatements(): void {
    this._stmts = {
      getMeta: this._handle.prepare('SELECT value FROM meta WHERE key = ?'),
      setMeta: this._handle.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)'),
    };
  }

  /** Get a meta value by key. Returns null if not found. */
  getMeta(key: string): string | null {
    const row = this._stmts.getMeta.get(key) as { value: string } | undefined;
    return row ? row.value : null;
  }

  /**
   * Get a meta value, returning null (not throwing) if the meta table
   * doesn't exist yet (very first run before schema is applied).
   */
  getMetaRaw(key: string): string | null {
    try {
      const row = this._handle.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
        | { value: string }
        | undefined;
      return row ? row.value : null;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('no such table')) return null;
      throw err;
    }
  }

  /** Set a meta value. Creates or replaces. */
  setMeta(key: string, value: string | null): void {
    this._stmts.setMeta.run(key, value);
  }
}

import type Database from 'better-sqlite3';
import { BaseRepository } from './base-repository.js';
import { type DbRow } from './db-utils.js';

/**
 * WorldStateRepository — world state, server settings, and snapshots.
 *
 * Manages three related tables:
 * - `world_state` — in-game world variables (day, time, weather, etc.)
 * - `server_settings` — server configuration from save file
 * - `snapshots` — periodic player/stat snapshots for delta calculations
 */
export class WorldStateRepository extends BaseRepository {
  declare private _stmts: {
    setWorldState: Database.Statement;
    getWorldState: Database.Statement;
    getAllWorldState: Database.Statement;
    upsertSetting: Database.Statement;
    getSetting: Database.Statement;
    getAllSettings: Database.Statement;
    insertSnapshot: Database.Statement;
    getLatestSnapshot: Database.Statement;
    purgeOldSnapshots: Database.Statement;
  };

  protected _prepareStatements(): void {
    this._stmts = {
      // World state
      setWorldState: this._handle.prepare(
        "INSERT OR REPLACE INTO world_state (key, value, updated_at) VALUES (?, ?, datetime('now'))",
      ),
      getWorldState: this._handle.prepare('SELECT value FROM world_state WHERE key = ?'),
      getAllWorldState: this._handle.prepare('SELECT * FROM world_state'),
      // Server settings
      upsertSetting: this._handle.prepare(
        "INSERT OR REPLACE INTO server_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))",
      ),
      getSetting: this._handle.prepare('SELECT value FROM server_settings WHERE key = ?'),
      getAllSettings: this._handle.prepare('SELECT * FROM server_settings ORDER BY key'),
      // Snapshots
      insertSnapshot: this._handle.prepare('INSERT INTO snapshots (type, steam_id, data) VALUES (?, ?, ?)'),
      getLatestSnapshot: this._handle.prepare(
        'SELECT * FROM snapshots WHERE type = ? AND steam_id = ? ORDER BY created_at DESC LIMIT 1',
      ),
      purgeOldSnapshots: this._handle.prepare("DELETE FROM snapshots WHERE created_at < datetime('now', ?)"),
    };
  }

  // ── World state ──

  setWorldState(key: string, value: unknown): void {
    const stored = value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value);
    this._stmts.setWorldState.run(key, stored);
  }

  getWorldState(key: string): string | null {
    const r = this._stmts.getWorldState.get(key) as DbRow | undefined;
    return r ? (r.value as string) : null;
  }

  getAllWorldState(): Record<string, unknown> {
    const rows = this._stmts.getAllWorldState.all() as DbRow[];
    const result: Record<string, unknown> = {};
    for (const r of rows) result[r.key as string] = r.value;
    return result;
  }

  /** Inner variant for use inside an outer transaction (no wrapper). */
  innerSetWorldState(key: string, value: unknown): void {
    const stored = value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value);
    this._stmts.setWorldState.run(key, stored);
  }

  // ── Server settings ──

  upsertSetting(key: string, value: string): void {
    this._stmts.upsertSetting.run(key, value);
  }

  upsertSettings(settings: Record<string, string>): void {
    const upsert = this._handle.transaction((obj: Record<string, string>) => {
      for (const [key, value] of Object.entries(obj)) {
        this._stmts.upsertSetting.run(key, value);
      }
    });
    upsert(settings);
  }

  /** Inner variant for use inside an outer transaction (no wrapper). */
  innerUpsertSetting(key: string, value: string): void {
    this._stmts.upsertSetting.run(key, value);
  }

  getSetting(key: string): string | null {
    const r = this._stmts.getSetting.get(key) as DbRow | undefined;
    return r ? (r.value as string) : null;
  }

  getAllSettings(): Record<string, unknown> {
    const rows = this._stmts.getAllSettings.all() as DbRow[];
    const result: Record<string, unknown> = {};
    for (const r of rows) result[r.key as string] = r.value;
    return result;
  }

  // ── Snapshots ──

  createSnapshot(type: string, steamId: string, data: Record<string, unknown>): void {
    this._stmts.insertSnapshot.run(type, steamId, JSON.stringify(data));
  }

  getLatestSnapshot(type: string, steamId: string): (DbRow & { data: unknown }) | null {
    const row = this._stmts.getLatestSnapshot.get(type, steamId) as DbRow | undefined;
    return row ? { ...row, data: JSON.parse((row.data as string) || '{}') as unknown } : null;
  }

  purgeSnapshots(olderThan: string): void {
    this._stmts.purgeOldSnapshots.run(olderThan);
  }
}

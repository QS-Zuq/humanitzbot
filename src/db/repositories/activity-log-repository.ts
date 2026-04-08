import type Database from 'better-sqlite3';
import { BaseRepository } from './base-repository.js';
import { type DbRow } from './db-utils.js';

function _parseActivityRow(row: unknown): DbRow | null {
  if (!row) return null;
  const parsed: DbRow = { ...(row as DbRow) };
  if (parsed.details && typeof parsed.details === 'string') {
    try {
      parsed.details = JSON.parse(parsed.details) as unknown;
    } catch {
      /* leave as string */
    }
  }
  return parsed;
}

export class ActivityLogRepository extends BaseRepository {
  declare private _stmts: {
    insertActivity: Database.Statement;
    insertActivityAt: Database.Statement;
    clearActivityLog: Database.Statement;
    getRecentActivity: Database.Statement;
    getRecentActivityPaged: Database.Statement;
    getActivityByCategory: Database.Statement;
    getActivityByCategoryPaged: Database.Statement;
    getActivityByActor: Database.Statement;
    getActivityByActorPaged: Database.Statement;
    getActivitySince: Database.Statement;
    getActivitySinceBySource: Database.Statement;
    purgeOldActivity: Database.Statement;
    countActivity: Database.Statement;
    countActivityBySource: Database.Statement;
  };

  protected _prepareStatements(): void {
    this._stmts = {
      insertActivity: this._handle.prepare(`
      INSERT INTO activity_log (type, category, actor, actor_name, item, amount, details, pos_x, pos_y, pos_z, steam_id, source, target_name, target_steam_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
      insertActivityAt: this._handle.prepare(`
      INSERT INTO activity_log (type, category, actor, actor_name, item, amount, details, pos_x, pos_y, pos_z, created_at, steam_id, source, target_name, target_steam_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
      clearActivityLog: this._handle.prepare('DELETE FROM activity_log'),
      getRecentActivity: this._handle.prepare('SELECT * FROM activity_log ORDER BY created_at DESC, id DESC LIMIT ?'),
      getRecentActivityPaged: this._handle.prepare(
        'SELECT * FROM activity_log ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?',
      ),
      getActivityByCategory: this._handle.prepare(
        'SELECT * FROM activity_log WHERE category = ? ORDER BY created_at DESC, id DESC LIMIT ?',
      ),
      getActivityByCategoryPaged: this._handle.prepare(
        'SELECT * FROM activity_log WHERE category = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?',
      ),
      getActivityByActor: this._handle.prepare(
        'SELECT * FROM activity_log WHERE actor = ? ORDER BY created_at DESC, id DESC LIMIT ?',
      ),
      getActivityByActorPaged: this._handle.prepare(
        'SELECT * FROM activity_log WHERE actor = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?',
      ),
      getActivitySince: this._handle.prepare(
        'SELECT * FROM activity_log WHERE created_at >= ? ORDER BY created_at ASC, id ASC',
      ),
      getActivitySinceBySource: this._handle.prepare(
        'SELECT * FROM activity_log WHERE created_at >= ? AND source = ? ORDER BY created_at ASC, id ASC',
      ),
      purgeOldActivity: this._handle.prepare("DELETE FROM activity_log WHERE created_at < datetime('now', ?)"),
      countActivity: this._handle.prepare('SELECT COUNT(*) as count FROM activity_log'),
      countActivityBySource: this._handle.prepare('SELECT source, COUNT(*) as count FROM activity_log GROUP BY source'),
    };
  }

  /**
   * Insert a single activity log entry.
   * @param {object} entry - { type, category, actor, actorName, item, amount, details, x, y, z, steamId, source, targetName, targetSteamId }
   */
  insertActivity(entry: Record<string, unknown>) {
    this._stmts.insertActivity.run(
      entry.type,
      entry.category || '',
      entry.actor || '',
      entry.actorName || '',
      entry.item || '',
      entry.amount || 0,
      JSON.stringify(entry.details || {}),
      entry.x ?? null,
      entry.y ?? null,
      entry.z ?? null,
      entry.steamId || '',
      entry.source || 'save',
      entry.targetName || '',
      entry.targetSteamId || '',
    );
  }

  /**
   * Insert multiple activity entries in a single transaction.
   * @param {Array<object>} entries
   */
  insertActivities(entries: Array<Record<string, unknown>>): void {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- defensive: untyped callers may pass null
    if (!entries || entries.length === 0) return;
    const tx = this._handle.transaction((list: Array<Record<string, unknown>>) => {
      for (const entry of list) {
        this._stmts.insertActivity.run(
          entry.type,
          entry.category || '',
          entry.actor || '',
          entry.actorName || '',
          entry.item || '',
          entry.amount || 0,
          JSON.stringify(entry.details || {}),
          entry.x ?? null,
          entry.y ?? null,
          entry.z ?? null,
          entry.steamId || '',
          entry.source || 'save',
          entry.targetName || '',
          entry.targetSteamId || '',
        );
      }
    });
    tx(entries);
  }

  /**
   * Insert multiple activity entries with explicit timestamps (for backfill).
   * Each entry must have a `createdAt` ISO string.
   * @param {Array<object>} entries
   */
  insertActivitiesAt(entries: Array<Record<string, unknown>>): void {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- defensive: untyped callers may pass null
    if (!entries || entries.length === 0) return;
    const tx = this._handle.transaction((list: Array<Record<string, unknown>>) => {
      for (const entry of list) {
        this._stmts.insertActivityAt.run(
          entry.type,
          entry.category || '',
          entry.actor || '',
          entry.actorName || '',
          entry.item || '',
          entry.amount || 0,
          JSON.stringify(entry.details || {}),
          entry.x ?? null,
          entry.y ?? null,
          entry.z ?? null,
          entry.createdAt,
          entry.steamId || '',
          entry.source || 'save',
          entry.targetName || '',
          entry.targetSteamId || '',
        );
      }
    });
    tx(entries);
  }

  /** Delete all activity log entries (used by setup --fix/--backfill). */
  clearActivityLog() {
    this._stmts.clearActivityLog.run();
  }

  /** Get the most recent N activity entries. */
  getRecentActivity(limit = 50, offset = 0) {
    return this._stmts.getRecentActivityPaged.all(limit, offset).map(_parseActivityRow);
  }

  /** Get recent activity for a specific category. */
  getActivityByCategory(category: string, limit = 50, offset = 0) {
    return this._stmts.getActivityByCategoryPaged.all(category, limit, offset).map(_parseActivityRow);
  }

  /** Get recent activity for a specific actor (container name, steam ID, etc.). */
  getActivityByActor(actor: string, limit = 50, offset = 0) {
    return this._stmts.getActivityByActorPaged.all(actor, limit, offset).map(_parseActivityRow);
  }

  /** Get all activity since a given ISO timestamp. */
  getActivitySince(isoTimestamp: string) {
    return this._stmts.getActivitySince.all(isoTimestamp).map(_parseActivityRow);
  }

  /** Purge old activity entries (e.g. '-30 days'). */
  purgeOldActivity(olderThan: string) {
    return this._stmts.purgeOldActivity.run(olderThan);
  }

  /** Count total activity entries. */
  getActivityCount() {
    const row = this._stmts.countActivity.get() as DbRow | undefined;
    return row?.count || 0;
  }

  /** Get activity counts grouped by source. */
  getActivityCountBySource() {
    return this._stmts.countActivityBySource.all();
  }

  /** Get all activity since a given ISO timestamp, filtered by source. */
  getActivitySinceBySource(isoTimestamp: string, source: string) {
    return this._stmts.getActivitySinceBySource.all(isoTimestamp, source).map(_parseActivityRow);
  }
}

import type Database from 'better-sqlite3';
import { BaseRepository } from './base-repository.js';
import { type DbRow } from './db-utils.js';

const STEAM_ID_RE = /^\d{17}$/;
const MIN_SEARCH_TERM_LENGTH = 2;
const MAX_ACTIVITY_SEARCH_LIMIT = 500;
const CATEGORY_VARIANTS: Record<string, string[]> = {
  structure: ['structure', 'building', 'build', 'raid'],
  building: ['structure', 'building', 'build', 'raid'],
  build: ['structure', 'building', 'build', 'raid'],
  raid: ['structure', 'building', 'build', 'raid'],
  container: ['container', 'loot', 'clan'],
  loot: ['container', 'loot', 'clan'],
  clan: ['container', 'loot', 'clan'],
  combat: ['combat', 'death'],
  death: ['combat', 'death'],
};

type NormalizedActivityEntry = {
  type: unknown;
  category: string;
  actor: string;
  actorName: string;
  item: string;
  amount: unknown;
  detailsJson: string;
  x: unknown;
  y: unknown;
  z: unknown;
  createdAt: unknown;
  steamId: string;
  source: string;
  targetName: string;
  targetSteamId: string;
};

type ActivityDateRangeOptions = { dateFrom?: string; dateTo?: string; bucketOffsetMinutes?: number };
type ActivitySearchOptions = ActivityDateRangeOptions & { category?: string; limit?: number; offset?: number };

type ActivityPage = {
  categories: string[];
  limit: number;
  offset: number;
  dateFrom: string;
  dateTo: string;
};

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

function _asString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function _firstString(...values: unknown[]): string {
  for (const value of values) {
    const str = _asString(value);
    if (str) return str;
  }
  return '';
}

function _isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function _parseDetails(details: unknown): unknown {
  if (typeof details !== 'string') return details;
  try {
    return JSON.parse(details) as unknown;
  } catch {
    return details;
  }
}

function _mergeAttributionDetails(details: unknown, entry: Record<string, unknown>): unknown {
  const parsedDetails = _parseDetails(details);
  const attributedPlayer = _firstString(entry.attributedPlayer, entry.attributed_player);
  const attributedSteamId = _firstString(entry.attributedSteamId, entry.attributed_steam_id);

  if (!_isRecord(parsedDetails)) return parsedDetails || {};
  const merged: Record<string, unknown> = { ...parsedDetails };
  if (attributedPlayer && !merged.attributedPlayer) merged.attributedPlayer = attributedPlayer;
  if (attributedSteamId && !merged.attributedSteamId) merged.attributedSteamId = attributedSteamId;
  return merged;
}

function _normalizeActivityEntry(entry: Record<string, unknown>): NormalizedActivityEntry {
  const actor = _firstString(entry.actor);
  const steamId = _firstString(
    entry.steamId,
    entry.steam_id,
    STEAM_ID_RE.test(actor) ? actor : '',
    entry.attributedSteamId,
    entry.attributed_steam_id,
  );
  const details = _mergeAttributionDetails(entry.details || {}, entry);

  return {
    type: entry.type,
    category: _firstString(entry.category),
    actor,
    actorName: _firstString(entry.actorName, entry.actor_name),
    item: _firstString(entry.item),
    amount: entry.amount || 0,
    detailsJson: JSON.stringify(details),
    x: entry.x ?? entry.pos_x ?? null,
    y: entry.y ?? entry.pos_y ?? null,
    z: entry.z ?? entry.pos_z ?? null,
    createdAt: entry.createdAt ?? entry.created_at,
    steamId,
    source: _firstString(entry.source) || 'save',
    targetName: _firstString(entry.targetName, entry.target_name),
    targetSteamId: _firstString(entry.targetSteamId, entry.target_steam_id),
  };
}

function _escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, '\\$&');
}

function _categoryVariants(category: string): string[] {
  const normalized = category.trim();
  if (!normalized) return [];
  return [...new Set(CATEGORY_VARIANTS[normalized] ?? [normalized])];
}

function _activityPage(options: ActivitySearchOptions = {}): ActivityPage {
  const requestedLimit = Number.isFinite(options.limit) ? Number(options.limit) : 50;
  const requestedOffset = Number.isFinite(options.offset) ? Number(options.offset) : 0;
  return {
    categories: _categoryVariants(_asString(options.category)),
    limit: Math.min(Math.max(requestedLimit, 1), MAX_ACTIVITY_SEARCH_LIMIT),
    offset: Math.max(requestedOffset, 0),
    dateFrom: _asString(options.dateFrom),
    dateTo: _asString(options.dateTo),
  };
}

function _categoryClause(categories: string[]): string {
  return categories.length ? `category IN (${categories.map(() => '?').join(', ')}) AND` : '';
}

function _dateClause(range: ActivityDateRangeOptions): string {
  const clauses: string[] = [];
  if (_asString(range.dateFrom)) clauses.push('created_at >= ?');
  if (_asString(range.dateTo)) clauses.push('created_at < ?');
  return clauses.length ? `${clauses.join(' AND ')} AND` : '';
}

function _dateWhere(range: ActivityDateRangeOptions): string {
  const clause = _dateClause(range);
  return clause ? clause.slice(0, -4).trim() : '';
}

function _dateParams(range: ActivityDateRangeOptions): string[] {
  const params: string[] = [];
  const from = _asString(range.dateFrom);
  const to = _asString(range.dateTo);
  if (from) params.push(from);
  if (to) params.push(to);
  return params;
}

function _bucketOffsetModifier(options: ActivityDateRangeOptions): string {
  const minutes = Number(options.bucketOffsetMinutes);
  if (!Number.isFinite(minutes) || minutes === 0) return '+0 minutes';
  const rounded = Math.trunc(minutes);
  return `${rounded >= 0 ? '+' : ''}${String(rounded)} minutes`;
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
    searchActivity: Database.Statement;
    getActivitySince: Database.Statement;
    getActivitySinceBySource: Database.Statement;
    hasRecentActivity: Database.Statement;
    purgeOldActivity: Database.Statement;
    countActivity: Database.Statement;
    countActivityBySource: Database.Statement;
    countByType: Database.Statement;
    hourlyDistribution: Database.Statement;
    dailyCount: Database.Statement;
    dailyByType: Database.Statement;
    topActors: Database.Statement;
    topPlayers: Database.Statement;
    topContainers: Database.Statement;
    dateRange: Database.Statement;
    countByTextSearch: Database.Statement;
    distinctNumericActorsNeedingNames: Database.Statement;
    repairActorName: Database.Statement;
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
      searchActivity: this._handle.prepare(`
        SELECT * FROM activity_log
        WHERE (? = '' OR category = ?)
          AND (
            actor = ?
            OR steam_id = ?
            OR target_steam_id = ?
            OR actor LIKE ? ESCAPE '\\'
            OR actor_name LIKE ? ESCAPE '\\'
            OR target_name LIKE ? ESCAPE '\\'
            OR item LIKE ? ESCAPE '\\'
            OR details LIKE ? ESCAPE '\\'
          )
        ORDER BY created_at DESC, id DESC
        LIMIT ? OFFSET ?
      `),
      getActivitySince: this._handle.prepare(
        'SELECT * FROM activity_log WHERE created_at >= ? ORDER BY created_at ASC, id ASC',
      ),
      getActivitySinceBySource: this._handle.prepare(
        'SELECT * FROM activity_log WHERE created_at >= ? AND source = ? ORDER BY created_at ASC, id ASC',
      ),
      hasRecentActivity: this._handle.prepare(`
        SELECT 1 FROM activity_log
        WHERE type = ?
          AND steam_id = ?
          AND source = ?
          AND ((julianday(?) - julianday(created_at)) * 86400000.0) BETWEEN 0 AND ?
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `),
      purgeOldActivity: this._handle.prepare("DELETE FROM activity_log WHERE created_at < datetime('now', ?)"),
      countActivity: this._handle.prepare('SELECT COUNT(*) as count FROM activity_log'),
      countActivityBySource: this._handle.prepare('SELECT source, COUNT(*) as count FROM activity_log GROUP BY source'),
      countByType: this._handle.prepare(
        'SELECT type, COUNT(*) as count FROM activity_log GROUP BY type ORDER BY count DESC',
      ),
      hourlyDistribution: this._handle.prepare(`
        SELECT CAST(strftime('%H', created_at) AS INTEGER) as hour, COUNT(*) as count
        FROM activity_log
        WHERE created_at >= datetime('now', ?)
        GROUP BY hour ORDER BY hour
      `),
      dailyCount: this._handle.prepare(`
        SELECT date(created_at) as day, COUNT(*) as count
        FROM activity_log
        WHERE created_at >= datetime('now', ?)
        GROUP BY day ORDER BY day
      `),
      dailyByType: this._handle.prepare(`
        SELECT date(created_at) as day, type, COUNT(*) as count
        FROM activity_log
        WHERE created_at >= datetime('now', ?)
        GROUP BY day, type ORDER BY day
      `),
      topActors: this._handle.prepare(`
        SELECT COALESCE(actor_name, actor, steam_id) as actor, COUNT(*) as count
        FROM activity_log
        WHERE created_at >= datetime('now', ?) AND actor IS NOT NULL AND actor != ''
        GROUP BY actor ORDER BY count DESC LIMIT ?
      `),
      topPlayers: this._handle.prepare(`
        SELECT steam_id, COUNT(*) AS count
        FROM (
          SELECT id, steam_id
          FROM activity_log
          WHERE created_at >= datetime('now', ?)
            AND steam_id GLOB '[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'
          UNION
          SELECT id, actor AS steam_id
          FROM activity_log
          WHERE created_at >= datetime('now', ?)
            AND actor GLOB '[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'
          UNION
          SELECT id, target_steam_id AS steam_id
          FROM activity_log
          WHERE created_at >= datetime('now', ?)
            AND target_steam_id GLOB '[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'
          UNION
          SELECT id, json_extract(details, '$.attributedSteamId') AS steam_id
          FROM activity_log
          WHERE created_at >= datetime('now', ?)
            AND json_valid(details)
            AND json_extract(details, '$.attribution.status') = 'attributed'
            AND json_extract(details, '$.attributedSteamId') GLOB '[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'
          UNION
          SELECT id, json_extract(details, '$.attribution.matchedCandidates[0].steamId') AS steam_id
          FROM activity_log
          WHERE created_at >= datetime('now', ?)
            AND json_valid(details)
            AND json_extract(details, '$.attribution.status') = 'attributed'
            AND json_extract(details, '$.attribution.matchedCandidates[0].steamId') GLOB '[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'
        )
        GROUP BY steam_id
        ORDER BY count DESC
        LIMIT ?
      `),
      topContainers: this._handle.prepare(`
        SELECT actor, COALESCE(NULLIF(MAX(actor_name), ''), actor) AS actor_name, COUNT(*) AS count
        FROM activity_log
        WHERE created_at >= datetime('now', ?)
          AND category IN ('container', 'loot', 'clan')
          AND actor IS NOT NULL
          AND actor != ''
          AND actor NOT GLOB '[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'
        GROUP BY actor
        ORDER BY count DESC
        LIMIT ?
      `),
      dateRange: this._handle.prepare(
        'SELECT MIN(created_at) as earliest, MAX(created_at) as latest FROM activity_log',
      ),
      countByTextSearch: this._handle.prepare(
        'SELECT COUNT(*) as count FROM activity_log WHERE details LIKE ? OR item LIKE ?',
      ),
      distinctNumericActorsNeedingNames: this._handle.prepare(
        `SELECT DISTINCT actor FROM activity_log
         WHERE actor_name = actor AND actor GLOB '[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'`,
      ),
      repairActorName: this._handle.prepare(
        'UPDATE activity_log SET actor_name = ? WHERE actor = ? AND actor_name = actor',
      ),
    };
  }

  /**
   * Insert a single activity log entry.
   * @param {object} entry - { type, category, actor, actorName, item, amount, details, x, y, z, steamId, source, targetName, targetSteamId }
   */
  insertActivity(entry: Record<string, unknown>) {
    const activity = _normalizeActivityEntry(entry);
    this._stmts.insertActivity.run(
      activity.type,
      activity.category,
      activity.actor,
      activity.actorName,
      activity.item,
      activity.amount,
      activity.detailsJson,
      activity.x,
      activity.y,
      activity.z,
      activity.steamId,
      activity.source,
      activity.targetName,
      activity.targetSteamId,
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
        const activity = _normalizeActivityEntry(entry);
        this._stmts.insertActivity.run(
          activity.type,
          activity.category,
          activity.actor,
          activity.actorName,
          activity.item,
          activity.amount,
          activity.detailsJson,
          activity.x,
          activity.y,
          activity.z,
          activity.steamId,
          activity.source,
          activity.targetName,
          activity.targetSteamId,
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
        const activity = _normalizeActivityEntry(entry);
        this._stmts.insertActivityAt.run(
          activity.type,
          activity.category,
          activity.actor,
          activity.actorName,
          activity.item,
          activity.amount,
          activity.detailsJson,
          activity.x,
          activity.y,
          activity.z,
          activity.createdAt,
          activity.steamId,
          activity.source,
          activity.targetName,
          activity.targetSteamId,
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
  getRecentActivity(limit = 50, offset = 0, options: ActivityDateRangeOptions = {}) {
    const range = { dateFrom: _asString(options.dateFrom), dateTo: _asString(options.dateTo) };
    const dateClause = _dateClause(range);
    if (!dateClause) return this._stmts.getRecentActivityPaged.all(limit, offset).map(_parseActivityRow);
    return this._handle
      .prepare(
        `SELECT * FROM activity_log
         WHERE ${dateClause.slice(0, -4).trim()}
         ORDER BY created_at DESC, id DESC
         LIMIT ? OFFSET ?`,
      )
      .all(..._dateParams(range), limit, offset)
      .map(_parseActivityRow);
  }

  /** Get recent activity for a specific category. */
  getActivityByCategory(category: string, limit = 50, offset = 0, options: ActivityDateRangeOptions = {}) {
    const categories = _categoryVariants(category);
    if (categories.length === 0) return [];
    const range = { dateFrom: _asString(options.dateFrom), dateTo: _asString(options.dateTo) };
    const dateClause = _dateClause(range);
    const placeholders = categories.map(() => '?').join(', ');
    return this._handle
      .prepare(
        `SELECT * FROM activity_log
         WHERE ${dateClause} category IN (${placeholders})
         ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
      )
      .all(..._dateParams(range), ...categories, limit, offset)
      .map(_parseActivityRow);
  }

  /** Get recent activity for a specific actor (container name, steam ID, etc.). */
  getActivityByActor(actor: string, limit = 50, offset = 0) {
    return this._stmts.getActivityByActorPaged.all(actor, limit, offset).map(_parseActivityRow);
  }

  /** Search recent activity by player attribution, actor/entity labels, item, target, or details. */
  searchActivity(term: string, options: ActivitySearchOptions = {}) {
    const searchTerm = _asString(term).trim();
    if (searchTerm.length < MIN_SEARCH_TERM_LENGTH) return [];

    const { categories, limit, offset, dateFrom, dateTo } = _activityPage(options);
    const likeTerm = `%${_escapeLike(searchTerm)}%`;
    const categoryClause = _categoryClause(categories);
    const range = { dateFrom, dateTo };
    const dateClause = _dateClause(range);

    return this._handle
      .prepare(
        `SELECT * FROM activity_log
         WHERE ${dateClause} ${categoryClause}
           (
             actor = ?
             OR steam_id = ?
             OR target_steam_id = ?
             OR actor LIKE ? ESCAPE '\\'
             OR actor_name LIKE ? ESCAPE '\\'
             OR target_name LIKE ? ESCAPE '\\'
             OR item LIKE ? ESCAPE '\\'
             OR details LIKE ? ESCAPE '\\'
           )
         ORDER BY created_at DESC, id DESC
         LIMIT ? OFFSET ?`,
      )
      .all(
        ..._dateParams(range),
        ...categories,
        searchTerm,
        searchTerm,
        searchTerm,
        likeTerm,
        likeTerm,
        likeTerm,
        likeTerm,
        likeTerm,
        limit,
        offset,
      )
      .map(_parseActivityRow);
  }

  /** Search reliable player-attributed activity only. Never broad-LIKE details for Steam IDs. */
  searchActivityByPlayer(steamId: string, options: ActivitySearchOptions = {}) {
    const normalizedSteamId = _asString(steamId).trim();
    if (!STEAM_ID_RE.test(normalizedSteamId)) return [];

    const { categories, limit, offset, dateFrom, dateTo } = _activityPage(options);
    const categoryClause = _categoryClause(categories);
    const range = { dateFrom, dateTo };
    const dateClause = _dateClause(range);

    return this._handle
      .prepare(
        `SELECT * FROM activity_log
         WHERE ${dateClause} ${categoryClause}
           (
             steam_id = ?
             OR actor = ?
             OR target_steam_id = ?
             OR (
               json_valid(details)
               AND json_extract(details, '$.attribution.status') = 'attributed'
               AND (
                 json_extract(details, '$.attributedSteamId') = ?
                 OR json_extract(details, '$.attribution.matchedCandidates[0].steamId') = ?
               )
             )
           )
         ORDER BY created_at DESC, id DESC
         LIMIT ? OFFSET ?`,
      )
      .all(
        ..._dateParams(range),
        ...categories,
        normalizedSteamId,
        normalizedSteamId,
        normalizedSteamId,
        normalizedSteamId,
        normalizedSteamId,
        limit,
        offset,
      )
      .map(_parseActivityRow);
  }

  /** Search item-related activity by item name and item-list details. */
  searchActivityByItem(term: string, options: ActivitySearchOptions = {}) {
    const searchTerm = _asString(term).trim();
    if (searchTerm.length < MIN_SEARCH_TERM_LENGTH) return [];

    const { categories, limit, offset, dateFrom, dateTo } = _activityPage(options);
    const likeTerm = `%${_escapeLike(searchTerm)}%`;
    const categoryClause = _categoryClause(categories);
    const range = { dateFrom, dateTo };
    const dateClause = _dateClause(range);

    return this._handle
      .prepare(
        `SELECT * FROM activity_log
         WHERE ${dateClause} ${categoryClause}
           (
             item LIKE ? ESCAPE '\\'
             OR details LIKE ? ESCAPE '\\'
           )
         ORDER BY created_at DESC, id DESC
         LIMIT ? OFFSET ?`,
      )
      .all(..._dateParams(range), ...categories, likeTerm, likeTerm, limit, offset)
      .map(_parseActivityRow);
  }

  /** Search container/entity actor activity by actor trace key. */
  searchActivityByContainer(term: string, options: ActivitySearchOptions = {}) {
    const searchTerm = _asString(term).trim();
    if (searchTerm.length < MIN_SEARCH_TERM_LENGTH) return [];

    const pageOptions = { ...options, category: options.category || 'container' };
    const { categories, limit, offset, dateFrom, dateTo } = _activityPage(pageOptions);
    const likeTerm = `%${_escapeLike(searchTerm)}%`;
    const categoryClause = _categoryClause(categories);
    const range = { dateFrom, dateTo };
    const dateClause = _dateClause(range);

    return this._handle
      .prepare(
        `SELECT * FROM activity_log
         WHERE ${dateClause} ${categoryClause}
           (
             actor = ?
             OR actor_name = ?
             OR actor LIKE ? ESCAPE '\\'
             OR actor_name LIKE ? ESCAPE '\\'
           )
         ORDER BY created_at DESC, id DESC
         LIMIT ? OFFSET ?`,
      )
      .all(..._dateParams(range), ...categories, searchTerm, searchTerm, likeTerm, likeTerm, limit, offset)
      .map(_parseActivityRow);
  }

  /** Get all activity since a given ISO timestamp. */
  getActivitySince(isoTimestamp: string) {
    return this._stmts.getActivitySince.all(isoTimestamp).map(_parseActivityRow);
  }

  hasRecentActivity(type: string, steamId: string, source: string, windowMs: number, now: Date = new Date()): boolean {
    if (!type || !STEAM_ID_RE.test(steamId) || !source || windowMs <= 0) return false;
    return !!this._stmts.hasRecentActivity.get(type, steamId, source, now.toISOString(), windowMs);
  }

  /** Purge old activity entries (e.g. '-30 days'). */
  purgeOldActivity(olderThan: string) {
    return this._stmts.purgeOldActivity.run(olderThan);
  }

  /** Count total activity entries. */
  getActivityCount(options: ActivityDateRangeOptions = {}) {
    const where = _dateWhere(options);
    if (where) {
      const row = this._handle
        .prepare(`SELECT COUNT(*) as count FROM activity_log WHERE ${where}`)
        .get(..._dateParams(options)) as DbRow | undefined;
      return row?.count || 0;
    }
    const row = this._stmts.countActivity.get() as DbRow | undefined;
    return row?.count || 0;
  }

  countByType(options: ActivityDateRangeOptions = {}) {
    const where = _dateWhere(options);
    if (where) {
      return this._handle
        .prepare(`SELECT type, COUNT(*) as count FROM activity_log WHERE ${where} GROUP BY type ORDER BY count DESC`)
        .all(..._dateParams(options));
    }
    return this._stmts.countByType.all();
  }

  hourlyDistribution(days = 7, options: ActivityDateRangeOptions = {}) {
    const where = _dateWhere(options);
    if (where) {
      const offset = _bucketOffsetModifier(options);
      return this._handle
        .prepare(
          `SELECT CAST(strftime('%H', datetime(created_at, ?)) AS INTEGER) as hour, COUNT(*) as count
           FROM activity_log
           WHERE ${where}
           GROUP BY hour ORDER BY hour`,
        )
        .all(offset, ..._dateParams(options));
    }
    return this._stmts.hourlyDistribution.all(`-${String(days)} days`);
  }

  dailyCount(days = 30, options: ActivityDateRangeOptions = {}) {
    const where = _dateWhere(options);
    if (where) {
      const offset = _bucketOffsetModifier(options);
      return this._handle
        .prepare(
          `SELECT date(datetime(created_at, ?)) as day, COUNT(*) as count
           FROM activity_log
           WHERE ${where}
           GROUP BY day ORDER BY day`,
        )
        .all(offset, ..._dateParams(options));
    }
    return this._stmts.dailyCount.all(`-${String(days)} days`);
  }

  dailyByType(days = 14, options: ActivityDateRangeOptions = {}) {
    const where = _dateWhere(options);
    if (where) {
      const offset = _bucketOffsetModifier(options);
      return this._handle
        .prepare(
          `SELECT date(datetime(created_at, ?)) as day, type, COUNT(*) as count
           FROM activity_log
           WHERE ${where}
           GROUP BY day, type ORDER BY day`,
        )
        .all(offset, ..._dateParams(options));
    }
    return this._stmts.dailyByType.all(`-${String(days)} days`);
  }

  topActors(days = 7, limit = 10, options: ActivityDateRangeOptions = {}) {
    const where = _dateWhere(options);
    if (where) {
      return this._handle
        .prepare(
          `SELECT COALESCE(actor_name, actor, steam_id) as actor, COUNT(*) as count
           FROM activity_log
           WHERE ${where} AND actor IS NOT NULL AND actor != ''
           GROUP BY actor ORDER BY count DESC LIMIT ?`,
        )
        .all(..._dateParams(options), limit);
    }
    return this._stmts.topActors.all(`-${String(days)} days`, limit);
  }

  topPlayers(days = 7, limit = 10, options: ActivityDateRangeOptions = {}) {
    const where = _dateWhere(options);
    if (where) {
      const datePredicate = where ? `${where} AND` : '';
      const params = _dateParams(options);
      return this._handle
        .prepare(
          `SELECT steam_id, COUNT(*) AS count
           FROM (
             SELECT id, steam_id
             FROM activity_log
             WHERE ${datePredicate}
               steam_id GLOB '[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'
             UNION
             SELECT id, actor AS steam_id
             FROM activity_log
             WHERE ${datePredicate}
               actor GLOB '[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'
             UNION
             SELECT id, target_steam_id AS steam_id
             FROM activity_log
             WHERE ${datePredicate}
               target_steam_id GLOB '[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'
             UNION
             SELECT id, json_extract(details, '$.attributedSteamId') AS steam_id
             FROM activity_log
             WHERE ${datePredicate}
               json_valid(details)
               AND json_extract(details, '$.attribution.status') = 'attributed'
               AND json_extract(details, '$.attributedSteamId') GLOB '[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'
             UNION
             SELECT id, json_extract(details, '$.attribution.matchedCandidates[0].steamId') AS steam_id
             FROM activity_log
             WHERE ${datePredicate}
               json_valid(details)
               AND json_extract(details, '$.attribution.status') = 'attributed'
               AND json_extract(details, '$.attribution.matchedCandidates[0].steamId') GLOB '[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'
           )
           GROUP BY steam_id
           ORDER BY count DESC
           LIMIT ?`,
        )
        .all(...params, ...params, ...params, ...params, ...params, limit);
    }
    const window = `-${String(days)} days`;
    return this._stmts.topPlayers.all(window, window, window, window, window, limit);
  }

  topContainers(days = 7, limit = 10, options: ActivityDateRangeOptions = {}) {
    const where = _dateWhere(options);
    if (where) {
      return this._handle
        .prepare(
          `SELECT actor, COALESCE(NULLIF(MAX(actor_name), ''), actor) AS actor_name, COUNT(*) AS count
           FROM activity_log
           WHERE ${where}
             AND category IN ('container', 'loot', 'clan')
             AND actor IS NOT NULL
             AND actor != ''
             AND actor NOT GLOB '[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'
           GROUP BY actor
           ORDER BY count DESC
           LIMIT ?`,
        )
        .all(..._dateParams(options), limit);
    }
    return this._stmts.topContainers.all(`-${String(days)} days`, limit);
  }

  dateRange(options: ActivityDateRangeOptions = {}) {
    const where = _dateWhere(options);
    if (where) {
      return this._handle
        .prepare(`SELECT MIN(created_at) as earliest, MAX(created_at) as latest FROM activity_log WHERE ${where}`)
        .get(..._dateParams(options)) as { earliest: string | null; latest: string | null } | undefined;
    }
    return this._stmts.dateRange.get() as { earliest: string | null; latest: string | null } | undefined;
  }

  countByTextSearch(pattern: string): number {
    const row = this._stmts.countByTextSearch.get(pattern, pattern) as { count?: number } | undefined;
    return row?.count ?? 0;
  }

  repairActorNames(idMap: Record<string, string>): number {
    if (Object.keys(idMap).length === 0) return 0;
    const rows = this._stmts.distinctNumericActorsNeedingNames.all() as Array<{ actor: string }>;
    let fixed = 0;
    this._handle.transaction(() => {
      for (const row of rows) {
        const name = idMap[row.actor];
        if (!name) continue;
        const info = this._stmts.repairActorName.run(name, row.actor);
        fixed += info.changes;
      }
    })();
    return fixed;
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

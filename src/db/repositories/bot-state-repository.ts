import { botStateEvents } from '../../state/bot-state-events.js';
import { getSchemaMode } from '../../state/bot-state-mode.js';
import { BaseRepository } from './base-repository.js';

/**
 * BotStateRepository — runtime operational state key-value store.
 *
 * Manages the `bot_state` table used for transient runtime state:
 * message IDs, tracker offsets, server settings cache, etc.
 */
export class BotStateRepository extends BaseRepository {
  declare private _stmts: {
    get: import('better-sqlite3').Statement;
    set: import('better-sqlite3').Statement;
    del: import('better-sqlite3').Statement;
    all: import('better-sqlite3').Statement;
  };

  protected _prepareStatements(): void {
    this._stmts = {
      get: this._handle.prepare('SELECT value FROM bot_state WHERE key = ?'),
      set: this._handle.prepare(
        "INSERT OR REPLACE INTO bot_state (key, value, updated_at) VALUES (?, ?, datetime('now'))",
      ),
      del: this._handle.prepare('DELETE FROM bot_state WHERE key = ?'),
      all: this._handle.prepare('SELECT key, value, updated_at FROM bot_state ORDER BY key'),
    };
  }

  /** Get a bot_state value by key. Returns null if not found. */
  getState(key: string): string | null {
    const row = this._stmts.get.get(key) as { value: string } | undefined;
    return row ? row.value : null;
  }

  /** Set a bot_state value. Creates or replaces. */
  setState(key: string, value: unknown): void {
    this._stmts.set.run(
      key,
      value != null
        ? typeof value === 'object'
          ? JSON.stringify(value)
          : String(value as string | number | boolean)
        : null,
    );
  }

  /** Get a bot_state value parsed as JSON. Returns defaultVal if not found or parse fails. */
  getStateJSON(key: string, defaultVal: unknown = null): unknown {
    const raw = this.getState(key);
    if (raw == null) return defaultVal;
    try {
      return JSON.parse(raw) as unknown;
    } catch (err: unknown) {
      this._log.warn(
        `Failed to parse bot_state JSON for key "${key}": ${err instanceof Error ? err.message : String(err)}`,
      );
      return defaultVal;
    }
  }

  /** Set a bot_state value as JSON. */
  setStateJSON(key: string, value: unknown): void {
    this.setState(key, JSON.stringify(value));
  }

  /** Delete a bot_state key. */
  deleteState(key: string): void {
    this._stmts.del.run(key);
  }

  /** Get all bot_state entries. Returns array of { key, value, updated_at }. */
  getAllState(): Array<{ key: string; value: string | null; updated_at: string }> {
    return this._stmts.all.all() as Array<{
      key: string;
      value: string | null;
      updated_at: string;
    }>;
  }

  /**
   * Get a bot_state value parsed as JSON and validated through the provided normalizer.
   *
   * Mode behaviour (see src/state/bot-state-mode.ts):
   *   off      — bypasses validation entirely; behaves like getStateJSON(key, defaultVal).
   *   dry-run  — runs normalizer, emits shape-invalid if issues found, returns the **raw**
   *              parsed value (not the partial-recovery shape).  Callers MUST defensively
   *              guard all field access; see temp/pr2-schema-spike.md §Q11 for rationale.
   *   enforce  — runs normalizer, emits shape-invalid if issues found, returns the
   *              partial-recovery shape (always safe to use without guards).
   *
   * In all modes, a JSON parse failure emits parse-error and returns defaultVal.
   * The database row is NEVER overwritten by this method.
   *
   * see `temp/pr2-schema-spike.md` for dry-run mitigation decision (Q11)
   */
  getStateJSONValidated<T>(key: string, normalize: (raw: unknown) => { shape: T; issues: string[] }, defaultVal: T): T {
    const mode = getSchemaMode();

    // mode=off: bypass validation entirely
    if (mode === 'off') {
      return this.getStateJSON(key, defaultVal) as T;
    }

    const rawStr = this.getState(key);
    if (rawStr == null) return defaultVal;

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawStr);
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err);
      this._log.warn(`[BOT_STATE] parse-error key=${key}: ${error}`);
      botStateEvents.emit('parse-error', { key, error, rawValue: rawStr });
      return defaultVal;
    }

    const { shape, issues } = normalize(parsed);
    if (issues.length > 0) {
      this._log.warn(`[BOT_STATE] shape-invalid key=${key} issues=${JSON.stringify(issues)}`);
      botStateEvents.emit('shape-invalid', { key, issues });
      // dry-run: return raw parsed value so callers observe real-world shapes
      if (mode === 'dry-run') return parsed as T;
      // enforce: return partial-recovery shape
      return shape;
    }

    return shape;
  }

  /**
   * Set a bot_state value as JSON after running the normalizer.
   * Throws if the normalizer reports any issues (write-side fail-loud for canary keys).
   * Use this for canary keys only (kill_tracker, github_tracker).
   */
  setStateJSONValidated<T>(key: string, normalize: (raw: unknown) => { shape: T; issues: string[] }, value: T): void {
    const { issues } = normalize(value);
    if (issues.length > 0) {
      throw new Error(`bot_state.${key} failed validation: ${issues.join('; ')}`);
    }
    this.setStateJSON(key, value);
  }

  /**
   * Delete bot_state rows that match a key prefix and are older than daysOlder days.
   * Uses SQLite-native datetime arithmetic to avoid JS timezone skew.
   * Returns the number of rows deleted.
   */
  deleteByKeyPrefixAndAge(prefix: string, daysOlder: number): number {
    const result = this._handle
      .prepare("DELETE FROM bot_state WHERE key LIKE ? || '%' AND updated_at < datetime('now', ? || ' days')")
      .run(prefix, `-${daysOlder}`) as { changes: number };
    return result.changes;
  }
}

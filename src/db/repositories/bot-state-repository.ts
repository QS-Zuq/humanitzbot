import { BaseRepository } from './base-repository.js';

/**
 * BotStateRepository — runtime operational state key-value store.
 *
 * Manages the `bot_state` table used for transient runtime state:
 * message IDs, tracker offsets, server settings cache, etc.
 */
export class BotStateRepository extends BaseRepository {
  protected _prepareStatements(): void {
    // bot_state uses inline prepare() calls since the queries are simple
    // and not called in hot loops.
  }

  /** Get a bot_state value by key. Returns null if not found. */
  getState(key: string): string | null {
    const row = this._handle.prepare('SELECT value FROM bot_state WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row ? row.value : null;
  }

  /** Set a bot_state value. Creates or replaces. */
  setState(key: string, value: unknown): void {
    this._handle
      .prepare("INSERT OR REPLACE INTO bot_state (key, value, updated_at) VALUES (?, ?, datetime('now'))")
      .run(
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
    this._handle.prepare('DELETE FROM bot_state WHERE key = ?').run(key);
  }

  /** Get all bot_state entries. Returns array of { key, value, updated_at }. */
  getAllState(): Array<{ key: string; value: string; updated_at: string }> {
    return this._handle.prepare('SELECT key, value, updated_at FROM bot_state ORDER BY key').all() as Array<{
      key: string;
      value: string;
      updated_at: string;
    }>;
  }
}

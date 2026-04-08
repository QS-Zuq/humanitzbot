/** Shared utilities for database repositories. */

/** Generic row type for untyped SQLite query results. */
export type DbRow = Record<string, unknown>;

/** Serialize a value to JSON string for storage. */
export function _json(value: unknown): string {
  if (value === undefined || value === null) return '[]';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

const DB_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const SQLITE_UTC_RE = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?$/;
const ISO_WITH_ZONE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function _isValidDate(date: Date): boolean {
  return !Number.isNaN(date.getTime());
}

/**
 * Format a UTC instant for DB wall-clock timestamp columns.
 *
 * Canonical DB format is SQLite-compatible UTC text:
 * `YYYY-MM-DD HH:mm:ss`.
 */
export function formatDbTimestampUtc(date: Date = new Date()): string {
  if (!_isValidDate(date)) throw new RangeError('Invalid Date');
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Parse a DB wall-clock timestamp as a UTC instant.
 *
 * Accepts the canonical SQLite UTC text format and legacy ISO_Z/offset
 * strings. Timezone-less SQLite strings are always treated as UTC, never as
 * local process/browser time.
 */
export function parseDbTimestampUtc(value: unknown): Date | null {
  if (value instanceof Date) return _isValidDate(value) ? new Date(value.getTime()) : null;
  if (typeof value !== 'string') return null;

  const raw = value.trim();
  if (!raw) return null;

  const sqlite = raw.match(SQLITE_UTC_RE);
  const parsed = sqlite
    ? new Date(`${sqlite[1]}T${sqlite[2]}${sqlite[3] ?? ''}Z`)
    : ISO_WITH_ZONE_RE.test(raw)
      ? new Date(raw)
      : null;

  return parsed && _isValidDate(parsed) ? parsed : null;
}

/**
 * Normalize any accepted DB timestamp input to canonical UTC text.
 */
export function normalizeDbTimestampUtc(value: unknown): string | null {
  const parsed = parseDbTimestampUtc(value);
  return parsed ? formatDbTimestampUtc(parsed) : null;
}

export function isDbTimestampUtc(value: unknown): value is string {
  return typeof value === 'string' && DB_TIMESTAMP_RE.test(value);
}

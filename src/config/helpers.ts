/**
 * Config helper functions — pure utilities for parsing environment variables.
 */

/** Parse a boolean environment variable. */
export function envBool(key: string, defaultValue: boolean): boolean {
  const val = process.env[key];
  if (val === undefined || val === '') return defaultValue;
  return val === 'true';
}

/** Parse an HH:MM time string into total minutes from midnight. */
export function envTime(key: string): number {
  const val = process.env[key];
  if (val === undefined || val === '') return NaN;
  const parts = val.split(':');
  const h = parseInt(parts[0] ?? '', 10);
  const m = parts.length > 1 ? parseInt(parts[1] ?? '', 10) : 0;
  if (isNaN(h) || isNaN(m)) return NaN;
  return h * 60 + m;
}

/**
 * Compute the UTC-to-local offset in milliseconds for a given timezone.
 * Used by parseLogTimestamp to convert game-server log times to UTC.
 */
export function tzOffsetMs(utcDate: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(utcDate);

  const y = parts.find((p) => p.type === 'year')?.value ?? '1970';
  const m = parts.find((p) => p.type === 'month')?.value ?? '01';
  const d = parts.find((p) => p.type === 'day')?.value ?? '01';
  let h = parts.find((p) => p.type === 'hour')?.value ?? '00';
  if (h === '24') h = '00'; // midnight edge case
  const mn = parts.find((p) => p.type === 'minute')?.value ?? '00';
  const s = parts.find((p) => p.type === 'second')?.value ?? '00';

  const localAsUtc = new Date(`${y}-${m}-${d}T${h}:${mn}:${s}Z`);
  return localAsUtc.getTime() - utcDate.getTime();
}

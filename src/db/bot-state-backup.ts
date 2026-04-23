/**
 * bot-state-backup.ts — startup-time bot_state backup utilities.
 *
 * backupCriticalBotStateKeys: one-shot idempotent backup of canary keys
 *   (kill_tracker, github_tracker) to a date-stamped prefix row before
 *   any schema validation is applied. Guards against "read invalid → partial
 *   recovery → write default → silent data wipe" (Pre-mortem S4).
 *
 * backupFirstRunKeys: backup transient keys before FIRST_RUN deletes them.
 *   Used by Stage 4 of PR2 (src/index.ts FIRST_RUN block).
 *
 * cleanupBackupKeys: TTL cleanup — deletes backup rows older than 7 days.
 *   Uses SQLite-native datetime arithmetic (pre-commit condition #1).
 */

import type { HumanitZDB } from './database.js';

/** Keys backed up as canary rows on every startup. */
const CRITICAL_KEYS = ['kill_tracker', 'github_tracker'] as const;

/** Prefix used for canary startup backups. */
export const CANARY_BACKUP_PREFIX = 'canary_backup__';

/** Prefix used for FIRST_RUN backups. */
export const FIRST_RUN_BACKUP_PREFIX = 'first_run_backup__';

/** TTL in days for backup rows. */
const BACKUP_TTL_DAYS = 7;

/**
 * Exact bot_state keys cleared by FIRST_RUN.
 *
 * Keep this list centralized so PR2's reset contract is testable: do clear
 * keys that have no bootstrap/backfill path (`kill_tracker`,
 * `weekly_baseline`, `recap_service`), but do not clear `github_tracker` or
 * `milestones` because they self-seed/backfill and clearing only adds churn.
 */
export const FIRST_RUN_TRANSIENT_KEYS = [
  'msg_id_server_status',
  'msg_id_player_stats',
  'msg_id_panel_bot',
  'msg_id_panel_server',
  'msg_id_panel_servers',
  'log_offsets',
  'day_counts',
  'pvp_kills',
  'welcome_stats',
  'bot_running',
  'kill_tracker',
  'weekly_baseline',
  'recap_service',
] as const;

/**
 * Returns today's date as YYYY-MM-DD in UTC.
 */
function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * One-shot idempotent backup of canary keys.
 *
 * For each key in CRITICAL_KEYS, writes a row with key =
 *   `canary_backup__<key>__<yyyy-mm-dd>`
 * if one does not already exist for today. This ensures the "last known
 * good" value is available for manual recovery even if a later schema
 * validation causes a partial-recovery write to diverge from the original.
 */
export function backupCriticalBotStateKeys(db: HumanitZDB): void {
  const today = todayUTC();
  for (const key of CRITICAL_KEYS) {
    const raw = db.botState.getState(key);
    if (raw == null) continue; // no row to back up
    const backupKey = `${CANARY_BACKUP_PREFIX}${key}__${today}`;
    const existing = db.botState.getState(backupKey);
    if (existing !== null) continue; // idempotent: already backed up today
    db.botState.setState(backupKey, raw);
  }
}

/**
 * Idempotent backup of transient keys before FIRST_RUN deletion.
 *
 * Writes `first_run_backup__<key>__<yyyy-mm-dd>` for each non-null key.
 * Skips if today's backup row already exists (safe to call on repeated
 * FIRST_RUN=1 starts — S5 pre-mortem defence).
 */
export function backupFirstRunKeys(db: HumanitZDB, keys: readonly string[]): void {
  const today = todayUTC();
  for (const key of keys) {
    const raw = db.botState.getState(key);
    if (raw == null) continue;
    const backupKey = `${FIRST_RUN_BACKUP_PREFIX}${key}__${today}`;
    const existing = db.botState.getState(backupKey);
    if (existing !== null) continue; // idempotent: already backed up today
    db.botState.setState(backupKey, raw);
  }
}

/**
 * Delete all backup rows (both canary_backup__ and first_run_backup__) that
 * are older than BACKUP_TTL_DAYS days. Uses SQLite-native datetime arithmetic
 * to avoid JS timezone skew (pre-commit condition #1).
 *
 * Called once on startup after db.init().
 */
export function cleanupBackupKeys(db: HumanitZDB): void {
  db.botState.deleteByKeyPrefixAndAge(CANARY_BACKUP_PREFIX, BACKUP_TTL_DAYS);
  db.botState.deleteByKeyPrefixAndAge(FIRST_RUN_BACKUP_PREFIX, BACKUP_TTL_DAYS);
}

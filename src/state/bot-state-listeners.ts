/**
 * bot-state-listeners.ts — attach observability listeners to botStateEvents.
 *
 * Called once on startup (after db.init(), before any bot_state reads) to wire
 * up warn-level logging for parse-error, shape-invalid, and migration-failed
 * events emitted by BotStateRepository.
 *
 * Deduplication is handled by logRejection's 60s dedupe cache (reused here via
 * a synthetic rejected promise). ctx format:
 *   bot-state:parse-error:<key>
 *   bot-state:shape-invalid:<key>
 *   bot-state:migration-failed:<from>-><to>
 */

import { botStateEvents } from './bot-state-events.js';
import type { Logger } from '../utils/log.js';
import type { HumanitZDB } from '../db/database.js';

// We need the dedupe cache from logRejection for 60s dedup of warn logs.
// logRejection operates on Promise rejections; we replicate its dedupe logic
// here for synchronous EventEmitter events.
import { _resetLogRejectionCache } from '../utils/log-rejection.js';

// Module-local dedupe cache (mirrors logRejection's DEDUPE_WINDOW_MS / MAX_LOGS_PER_WINDOW)
const _dedupeCache = new Map<string, { count: number; windowStart: number }>();
const DEDUPE_WINDOW_MS = 60_000;
const MAX_LOGS_PER_WINDOW = 2;

function _shouldLog(ctx: string): boolean {
  const now = Date.now();
  const entry = _dedupeCache.get(ctx);
  if (!entry || now - entry.windowStart >= DEDUPE_WINDOW_MS) {
    _dedupeCache.set(ctx, { count: 1, windowStart: now });
    return true;
  }
  if (entry.count < MAX_LOGS_PER_WINDOW) {
    entry.count += 1;
    return true;
  }
  return false;
}

/** Test helper — clear the listener dedupe cache between tests. */
export function _resetBotStateListenerCache(): void {
  _dedupeCache.clear();
}

/**
 * Attach parse-error and shape-invalid listeners.
 * Throws if called more than once (second call is a programmer error).
 * Call only once per process startup.
 *
 * Note: migration-failed listener is intentionally NOT attached here.
 * Per plan acceptance #15, migration-failed === 0 listeners for PR2.
 * It will be enabled in PR3/PR4.
 */
export function attachBotStateListeners(log: Logger, _db: HumanitZDB): void {
  if (botStateEvents.listenerCount('parse-error') > 0 || botStateEvents.listenerCount('shape-invalid') > 0) {
    throw new Error('bot-state-listeners already attached — second call is a programmer error');
  }

  botStateEvents.on('parse-error', ({ key, error }) => {
    const ctx = `bot-state:parse-error:${key}`;
    if (_shouldLog(ctx)) {
      log.warn(`[${ctx}] JSON parse failed: ${error}`);
    }
  });

  botStateEvents.on('shape-invalid', ({ key, issues }) => {
    const ctx = `bot-state:shape-invalid:${key}`;
    if (_shouldLog(ctx)) {
      log.warn(`[${ctx}] shape issues: ${issues.join('; ')}`);
    }
  });

  // migration-failed listener intentionally omitted for PR2 (plan acceptance #15).
  // PR3/PR4 will add it once the migration path is implemented.
}

// Re-export for test teardown convenience
export { _resetLogRejectionCache };

import { errMsg } from './error.js';
import type { Logger } from './log.js';

type LogErrorFn = Pick<Logger, 'error'>;

interface DedupeEntry {
  count: number;
  windowStart: number;
}

const _dedupeCache = new Map<string, DedupeEntry>();
const DEDUPE_WINDOW_MS = 60_000;
const MAX_LOGS_PER_WINDOW = 2;

/**
 * Attach a `.catch` handler to a fire-and-forget promise.
 * Dedupes: same `ctx` logs at most MAX_LOGS_PER_WINDOW times per DEDUPE_WINDOW_MS.
 */
export function logRejection(promise: Promise<unknown>, log: LogErrorFn, ctx: string): void {
  promise.catch((err: unknown) => {
    const now = Date.now();
    const entry = _dedupeCache.get(ctx);

    if (!entry || now - entry.windowStart >= DEDUPE_WINDOW_MS) {
      _dedupeCache.set(ctx, { count: 1, windowStart: now });
      log.error(`[${ctx}] ${errMsg(err)}`);
      return;
    }

    if (entry.count < MAX_LOGS_PER_WINDOW) {
      entry.count += 1;
      log.error(`[${ctx}] ${errMsg(err)}`);
      if (entry.count === MAX_LOGS_PER_WINDOW) {
        log.error(`[${ctx}] further errors within ${String(DEDUPE_WINDOW_MS / 1000)}s will be suppressed`);
      }
    }
  });
}

/** Test helper — clear dedupe cache between tests. */
export function _resetLogRejectionCache(): void {
  _dedupeCache.clear();
}

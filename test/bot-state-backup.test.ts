/**
 * Integration tests for bot-state-backup.ts (Stage 2 / Stage 4 canary + FIRST_RUN).
 *
 * Uses an in-memory SQLite via BotStateRepository directly.
 * All tests use node:test + node:assert/strict.
 */

import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { BotStateRepository } from '../src/db/repositories/bot-state-repository.js';
import {
  backupCriticalBotStateKeys,
  backupFirstRunKeys,
  cleanupBackupKeys,
  CANARY_BACKUP_PREFIX,
  FIRST_RUN_TRANSIENT_KEYS,
  FIRST_RUN_BACKUP_PREFIX,
} from '../src/db/bot-state-backup.js';
import { normalizeKillTracker } from '../src/state/bot-state-schemas.js';

// ─── Minimal HumanitZDB stub ──────────────────────────────────────────────────

let handle: InstanceType<typeof Database>;
let repo: BotStateRepository;

function makeDb() {
  return { botState: repo } as unknown as Parameters<typeof backupCriticalBotStateKeys>[0];
}

before(() => {
  handle = new Database(':memory:');
  handle.exec(
    "CREATE TABLE bot_state (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now')))",
  );
  repo = new BotStateRepository(handle);
});

after(() => {
  handle.close();
});

afterEach(() => {
  handle.exec('DELETE FROM bot_state');
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

function countByPrefix(prefix: string): number {
  const rows = handle.prepare("SELECT COUNT(*) as n FROM bot_state WHERE key LIKE ? || '%'").get(prefix) as {
    n: number;
  };
  return rows.n;
}

// ─── backupCriticalBotStateKeys ────────────────────────────────────────────────

describe('backupCriticalBotStateKeys', () => {
  it('writes canary_backup__ rows for kill_tracker and github_tracker when they exist', () => {
    repo.setState('kill_tracker', JSON.stringify({ players: {} }));
    repo.setState('github_tracker', JSON.stringify({ 'owner/repo': {} }));

    backupCriticalBotStateKeys(makeDb());

    const today = todayUTC();
    assert.ok(
      repo.getState(CANARY_BACKUP_PREFIX + 'kill_tracker__' + today) !== null,
      'kill_tracker backup row must exist',
    );
    assert.ok(
      repo.getState(CANARY_BACKUP_PREFIX + 'github_tracker__' + today) !== null,
      'github_tracker backup row must exist',
    );
  });

  it('skips keys that have no row in bot_state', () => {
    backupCriticalBotStateKeys(makeDb());
    assert.equal(countByPrefix(CANARY_BACKUP_PREFIX), 0);
  });

  it('is idempotent — calling twice does not double-backup', () => {
    repo.setState('kill_tracker', JSON.stringify({ players: {} }));
    repo.setState('github_tracker', JSON.stringify({}));

    backupCriticalBotStateKeys(makeDb());
    backupCriticalBotStateKeys(makeDb());

    assert.equal(countByPrefix(CANARY_BACKUP_PREFIX), 2, 'exactly 2 backup rows (not 4)');
  });

  it('backup value matches original row value', () => {
    const original = JSON.stringify({ players: { steam_1: {} } });
    repo.setState('kill_tracker', original);

    backupCriticalBotStateKeys(makeDb());

    const today = todayUTC();
    const backup = repo.getState(CANARY_BACKUP_PREFIX + 'kill_tracker__' + today);
    assert.equal(backup, original);
  });
});

// ─── backupFirstRunKeys ────────────────────────────────────────────────────────

describe('backupFirstRunKeys', () => {
  it('FIRST_RUN_TRANSIENT_KEYS encodes PR2 reset scope (3 added keys, no self-seeding keys)', () => {
    const transientKeys: readonly string[] = FIRST_RUN_TRANSIENT_KEYS;
    assert.ok(transientKeys.includes('kill_tracker'), 'kill_tracker must be cleared on FIRST_RUN');
    assert.ok(transientKeys.includes('weekly_baseline'), 'weekly_baseline must be cleared on FIRST_RUN');
    assert.ok(transientKeys.includes('recap_service'), 'recap_service must be cleared on FIRST_RUN');
    assert.ok(
      !transientKeys.includes('github_tracker'),
      'github_tracker must not be cleared because it bootstraps itself',
    );
    assert.ok(!transientKeys.includes('milestones'), 'milestones must not be cleared because it backfills itself');
    assert.equal(new Set(transientKeys).size, transientKeys.length, 'key list must be unique');
  });

  it('writes first_run_backup__ rows for the given keys', () => {
    repo.setState('kill_tracker', JSON.stringify({ players: {} }));
    repo.setState('weekly_baseline', JSON.stringify({ weekStart: null, players: {} }));
    repo.setState('recap_service', JSON.stringify({ lastDaily: null }));

    backupFirstRunKeys(makeDb(), ['kill_tracker', 'weekly_baseline', 'recap_service']);

    const today = todayUTC();
    assert.ok(repo.getState(FIRST_RUN_BACKUP_PREFIX + 'kill_tracker__' + today) !== null);
    assert.ok(repo.getState(FIRST_RUN_BACKUP_PREFIX + 'weekly_baseline__' + today) !== null);
    assert.ok(repo.getState(FIRST_RUN_BACKUP_PREFIX + 'recap_service__' + today) !== null);
  });

  it('is idempotent — two FIRST_RUN=1 starts do not double-backup', () => {
    repo.setState('kill_tracker', JSON.stringify({ players: {} }));

    backupFirstRunKeys(makeDb(), ['kill_tracker']);
    backupFirstRunKeys(makeDb(), ['kill_tracker']);

    assert.equal(countByPrefix(FIRST_RUN_BACKUP_PREFIX), 1, 'still exactly 1 backup row');
  });

  it('skips keys with no existing row', () => {
    backupFirstRunKeys(makeDb(), ['kill_tracker', 'weekly_baseline']);
    assert.equal(countByPrefix(FIRST_RUN_BACKUP_PREFIX), 0);
  });
});

// ─── cleanupBackupKeys (TTL) ──────────────────────────────────────────────────

describe('cleanupBackupKeys', () => {
  it('deletes backup rows older than 7 days', () => {
    handle
      .prepare("INSERT INTO bot_state (key, value, updated_at) VALUES (?, ?, datetime('now', '-8 days'))")
      .run(CANARY_BACKUP_PREFIX + 'kill_tracker__2026-04-01', '{"old":true}');

    cleanupBackupKeys(makeDb());

    assert.equal(countByPrefix(CANARY_BACKUP_PREFIX), 0, 'old row must be deleted');
  });

  it('T3 boundary: keeps rows 1 second younger than 7 days old (clearly inside keep window)', () => {
    // Use -7 days +1 second to avoid any second-boundary race in CI.
    // The exact -7 days edge is not tested to prevent flakiness.
    handle
      .prepare("INSERT INTO bot_state (key, value, updated_at) VALUES (?, ?, datetime('now', '-7 days', '+1 second'))")
      .run(CANARY_BACKUP_PREFIX + 'kill_tracker__2026-04-16', '{"boundary":true}');

    cleanupBackupKeys(makeDb());

    assert.equal(countByPrefix(CANARY_BACKUP_PREFIX), 1, 'young-boundary row must be kept');
  });

  it('T3 boundary: deletes rows at -7 days -1 second (just past boundary)', () => {
    handle
      .prepare("INSERT INTO bot_state (key, value, updated_at) VALUES (?, ?, datetime('now', '-7 days', '-1 second'))")
      .run(CANARY_BACKUP_PREFIX + 'kill_tracker__2026-04-16', '{"past":true}');

    cleanupBackupKeys(makeDb());

    assert.equal(countByPrefix(CANARY_BACKUP_PREFIX), 0, 'just-past-boundary row must be deleted');
  });

  it('keeps recent rows (today)', () => {
    const today = todayUTC();
    handle
      .prepare("INSERT INTO bot_state (key, value, updated_at) VALUES (?, ?, datetime('now'))")
      .run(CANARY_BACKUP_PREFIX + 'kill_tracker__' + today, '{"fresh":true}');

    cleanupBackupKeys(makeDb());

    assert.equal(countByPrefix(CANARY_BACKUP_PREFIX), 1, 'today row must be kept');
  });
});

// ─── Canary write throw + read emit integration ───────────────────────────────

describe('canary write/read validation integration', () => {
  it('setStateJSONValidated throws on invalid shape, original row is NOT overwritten', () => {
    const validRaw = JSON.stringify({ players: {} });
    repo.setState('kill_tracker', validRaw);

    const badVal = { players: null } as Parameters<typeof normalizeKillTracker>[0];
    const { issues } = normalizeKillTracker(badVal);
    assert.ok(issues.length > 0, 'bad shape must produce issues');

    assert.throws(() => {
      repo.setStateJSONValidated('kill_tracker', normalizeKillTracker, badVal as never);
    }, /bot_state\.kill_tracker failed validation/);

    assert.equal(repo.getState('kill_tracker'), validRaw, 'original row must not be overwritten');
  });
});

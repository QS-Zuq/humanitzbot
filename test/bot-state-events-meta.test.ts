/**
 * T5 meta-test — verify that if a test SKIPS the C6 afterEach cleanup convention,
 * the next test will see a non-zero listenerCount (proving the convention is essential).
 *
 * This test file itself cleans up at the end (via after()) so it does NOT leak
 * listeners to other test files.
 *
 * The test PASSES if the meta-assertion holds: "deliberately omitting removeAllListeners
 * causes the subsequent test's listenerCount to be > 1".
 *
 * Run with { concurrency: false } to guarantee ordering within the file.
 */

import { after, afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { botStateEvents } from '../src/state/bot-state-events.js';
import { attachBotStateListeners, _resetBotStateListenerCache } from '../src/state/bot-state-listeners.js';

// ── Stage 6: attachBotStateListeners tests ────────────────────────────────────

// Minimal logger stub
function makeLog() {
  const warns: string[] = [];
  return {
    warn: (msg: string) => {
      warns.push(msg);
    },
    error: () => {},
    info: () => {},
    debug: () => {},
    label: 'test-bot-state',
    _warns: warns,
  } as any;
}

// Minimal HumanitZDB stub (not used by listeners but required by signature)
const stubDb = {} as any;

describe('attachBotStateListeners (Stage 6)', { concurrency: false }, () => {
  afterEach(() => {
    botStateEvents.removeAllListeners('parse-error');
    botStateEvents.removeAllListeners('shape-invalid');
    botStateEvents.removeAllListeners('migration-failed');
    _resetBotStateListenerCache();
  });

  it('attaches exactly 1 listener for parse-error and shape-invalid; 0 for migration-failed (PR2 plan #15)', () => {
    const log = makeLog();
    botStateEvents.removeAllListeners('parse-error');
    botStateEvents.removeAllListeners('shape-invalid');
    botStateEvents.removeAllListeners('migration-failed');

    attachBotStateListeners(log, stubDb);

    assert.equal(botStateEvents.listenerCount('parse-error'), 1, 'parse-error must have 1 listener');
    assert.equal(botStateEvents.listenerCount('shape-invalid'), 1, 'shape-invalid must have 1 listener');
    assert.equal(
      botStateEvents.listenerCount('migration-failed'),
      0,
      'migration-failed must have 0 listeners (PR2 plan #15)',
    );
  });

  it('throws on second call (duplicate-attach guard)', () => {
    const log = makeLog();
    botStateEvents.removeAllListeners('parse-error');
    botStateEvents.removeAllListeners('shape-invalid');
    botStateEvents.removeAllListeners('migration-failed');

    attachBotStateListeners(log, stubDb);
    assert.throws(
      () => {
        attachBotStateListeners(log, stubDb);
      },
      /bot-state-listeners already attached/,
      'second call must throw programmer error',
    );
  });

  it('T6-dedupe: 3 emits of same ctx within 60s window → log.warn called only 2 times', () => {
    const log = makeLog();
    attachBotStateListeners(log, stubDb);

    // Emit parse-error 3 times with same key (same dedupe ctx)
    for (let i = 0; i < 3; i++) {
      botStateEvents.emit('parse-error', { key: 'kill_tracker', error: 'bad json', rawValue: '{' });
    }

    assert.equal(log._warns.length, 2, `dedupe must allow exactly 2 logs per 60s window, got ${log._warns.length}`);
  });

  it('T6-parse-error: warn includes key', () => {
    const log = makeLog();
    attachBotStateListeners(log, stubDb);

    botStateEvents.emit('parse-error', { key: 'github_tracker', error: 'unexpected end', rawValue: '' });

    assert.ok(log._warns.length >= 1, 'should have logged at least 1 warning');
    assert.ok(log._warns[0].includes('github_tracker'), 'warn must mention the key');
  });

  it('T6-shape-invalid: warn includes key and issues', () => {
    const log = makeLog();
    attachBotStateListeners(log, stubDb);

    botStateEvents.emit('shape-invalid', { key: 'kill_tracker', issues: ['players must be object'] });

    assert.ok(log._warns.length >= 1);
    assert.ok(log._warns[0].includes('kill_tracker'));
    assert.ok(log._warns[0].includes('players must be object'));
  });

  it('T6-migration-failed: no listener attached (PR2 plan acceptance #15 — 0 listeners)', () => {
    // migration-failed listener is intentionally deferred to PR3/PR4.
    // Verify that attachBotStateListeners does NOT attach migration-failed.
    const log = makeLog();
    attachBotStateListeners(log, stubDb);

    assert.equal(botStateEvents.listenerCount('migration-failed'), 0, 'migration-failed must have 0 listeners in PR2');

    // Emitting migration-failed must not invoke any log.warn via our listeners
    const warnsBefore = log._warns.length;
    botStateEvents.emit('migration-failed', { from: 'v1', to: 'v2', error: 'schema mismatch' });
    assert.equal(log._warns.length, warnsBefore, 'no warn should be logged for migration-failed in PR2');
  });
});

// ── T5 meta-test ──────────────────────────────────────────────────────────────

describe('T5 listener-cleanup meta-test', { concurrency: false }, () => {
  it('step 1 — attach a listener but intentionally skip removeAllListeners (simulates broken cleanup)', () => {
    // Baseline: start clean
    botStateEvents.removeAllListeners('parse-error');
    assert.equal(botStateEvents.listenerCount('parse-error'), 0, 'must start with 0 listeners');

    // Attach one listener — and deliberately do NOT remove it
    botStateEvents.on('parse-error', () => {});
    assert.equal(botStateEvents.listenerCount('parse-error'), 1);
    // NO removeAllListeners here — intentional convention violation
  });

  it('step 2 — next test sees leaked listener from step 1 (count > 0 before any new attach)', () => {
    // The leaked listener from step 1 is still there
    assert.equal(
      botStateEvents.listenerCount('parse-error'),
      1,
      'leaked listener from step 1 must still be present (proves cleanup is mandatory)',
    );

    // Adding our own listener — now count is 2
    botStateEvents.on('parse-error', () => {});
    assert.equal(
      botStateEvents.listenerCount('parse-error'),
      2,
      'attaching a second listener on top of the leaked one gives count=2',
    );
  });

  it('step 3 — after proper cleanup, subsequent test sees clean state', () => {
    // Proper cleanup (simulates what C6 afterEach should do)
    botStateEvents.removeAllListeners('parse-error');
    assert.equal(botStateEvents.listenerCount('parse-error'), 0);

    // Fresh attach
    botStateEvents.on('parse-error', () => {});
    assert.equal(botStateEvents.listenerCount('parse-error'), 1, 'after proper cleanup, a fresh attach gives count=1');
    // Clean up for the file-level after()
    botStateEvents.removeAllListeners('parse-error');
  });
});

after(() => {
  // Final cleanup — ensure this file does not leak to other test files
  botStateEvents.removeAllListeners('parse-error');
  botStateEvents.removeAllListeners('shape-invalid');
  botStateEvents.removeAllListeners('migration-failed');
});

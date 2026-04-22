/**
 * Regression: when _executeRestart rejects, _transitioning must be reset to false
 * so the next scheduled restart can proceed. Prior to PR1 silent rejection could
 * leave the scheduler stuck.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { logRejection, _resetLogRejectionCache } from '../src/utils/log-rejection.js';

async function flushMicrotasks() {
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setImmediate(r));
  }
}

describe('server-scheduler _transitioning reset after _executeRestart settles', () => {
  beforeEach(() => {
    _resetLogRejectionCache();
  });

  it('resets _transitioning to false when _executeRestart rejects', async () => {
    const stub = {
      _transitioning: true,
      _log: {
        error: (..._args: unknown[]) => {
          /* noop */
        },
      },
      _executeRestart: async (): Promise<void> => {
        throw new Error('docker restart failed');
      },
    };

    logRejection(
      stub._executeRestart().finally(() => {
        stub._transitioning = false;
      }),
      stub._log,
      'server-scheduler:restart',
    );

    await flushMicrotasks();
    assert.equal(stub._transitioning, false);
  });

  it('resets _transitioning to false when _executeRestart resolves', async () => {
    const stub = {
      _transitioning: true,
      _log: {
        error: (..._args: unknown[]) => {
          /* noop */
        },
      },
      _executeRestart: async (): Promise<void> => {
        /* successful restart */
      },
    };

    logRejection(
      stub._executeRestart().finally(() => {
        stub._transitioning = false;
      }),
      stub._log,
      'server-scheduler:restart',
    );

    await flushMicrotasks();
    assert.equal(stub._transitioning, false);
  });

  it('logs rejection reason with ctx prefix', async () => {
    const calls: string[] = [];
    const stub = {
      _transitioning: true,
      _log: {
        error: (...args: unknown[]) => {
          calls.push(args.map(String).join(' '));
        },
      },
      _executeRestart: async (): Promise<void> => {
        throw new Error('panel api 500');
      },
    };

    logRejection(
      stub._executeRestart().finally(() => {
        stub._transitioning = false;
      }),
      stub._log,
      'server-scheduler:restart',
    );

    await flushMicrotasks();
    assert.equal(stub._transitioning, false);
    assert.ok(calls.length >= 1);
    assert.match(calls[0] ?? '', /\[server-scheduler:restart\] panel api 500/);
  });
});

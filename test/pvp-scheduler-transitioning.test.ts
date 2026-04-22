/**
 * Regression: when _executeToggle rejects, _transitioning must be reset to false
 * so the next tick can re-start a countdown. Prior to PR1 this was vulnerable to
 * silent rejection leaving the scheduler stuck.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { logRejection, _resetLogRejectionCache } from '../src/utils/log-rejection.js';

async function flushMicrotasks() {
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setImmediate(r));
  }
}

describe('pvp-scheduler _transitioning reset after _executeToggle settles', () => {
  beforeEach(() => {
    _resetLogRejectionCache();
  });

  it('resets _transitioning to false when _executeToggle rejects', async () => {
    const stub = {
      _transitioning: true,
      _log: {
        error: (..._args: unknown[]) => {
          /* noop */
        },
      },
      _executeToggle: async (): Promise<void> => {
        throw new Error('sftp failed');
      },
    };

    logRejection(
      stub._executeToggle().finally(() => {
        stub._transitioning = false;
      }),
      stub._log,
      'pvp-scheduler:toggle',
    );

    await flushMicrotasks();
    assert.equal(stub._transitioning, false);
  });

  it('resets _transitioning to false when _executeToggle resolves', async () => {
    const stub = {
      _transitioning: true,
      _log: {
        error: (..._args: unknown[]) => {
          /* noop */
        },
      },
      _executeToggle: async (): Promise<void> => {
        /* successful toggle */
      },
    };

    logRejection(
      stub._executeToggle().finally(() => {
        stub._transitioning = false;
      }),
      stub._log,
      'pvp-scheduler:toggle',
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
      _executeToggle: async (): Promise<void> => {
        throw new Error('sftp timeout');
      },
    };

    logRejection(
      stub._executeToggle().finally(() => {
        stub._transitioning = false;
      }),
      stub._log,
      'pvp-scheduler:toggle',
    );

    await flushMicrotasks();
    assert.equal(stub._transitioning, false);
    assert.ok(calls.length >= 1);
    assert.match(calls[0] ?? '', /\[pvp-scheduler:toggle\] sftp timeout/);
  });
});

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { logRejection, _resetLogRejectionCache } from '../src/utils/log-rejection.js';

function makeLog() {
  const calls: string[] = [];
  return {
    calls,
    log: {
      error: (...args: unknown[]) => {
        calls.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
      },
    },
  };
}

async function flushMicrotasks() {
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setImmediate(r));
  }
}

describe('logRejection', () => {
  beforeEach(() => {
    _resetLogRejectionCache();
  });

  it('logs first rejection with ctx-prefixed message', async () => {
    const { calls, log } = makeLog();
    logRejection(Promise.reject(new Error('boom')), log, 'test:ctx1');
    await flushMicrotasks();
    assert.equal(calls.length, 1);
    assert.match(calls[0] ?? '', /\[test:ctx1\] boom/);
  });

  it('dedupes to at most 2 real errors + 1 suppressed notice per window', async () => {
    const { calls, log } = makeLog();
    for (let i = 0; i < 50; i++) {
      logRejection(Promise.reject(new Error(`e${String(i)}`)), log, 'test:ctx2');
    }
    await flushMicrotasks();
    // Expect exactly: 2 error messages + 1 "further errors will be suppressed" notice
    assert.equal(calls.length, 3);
    assert.match(calls[0] ?? '', /\[test:ctx2\] e0/);
    assert.match(calls[1] ?? '', /\[test:ctx2\] e1/);
    assert.match(calls[2] ?? '', /\[test:ctx2\] further errors within .* will be suppressed/);
  });

  it('different ctx do not share dedupe budget', async () => {
    const { calls, log } = makeLog();
    logRejection(Promise.reject(new Error('a')), log, 'ctx-a');
    logRejection(Promise.reject(new Error('b')), log, 'ctx-b');
    logRejection(Promise.reject(new Error('c')), log, 'ctx-c');
    await flushMicrotasks();
    assert.equal(calls.length, 3);
    assert.match(calls[0] ?? '', /\[ctx-a\] a/);
    assert.match(calls[1] ?? '', /\[ctx-b\] b/);
    assert.match(calls[2] ?? '', /\[ctx-c\] c/);
  });

  it('formats non-Error rejection via String()', async () => {
    const { calls, log } = makeLog();
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- verifies non-Error rejection handling.
    logRejection(Promise.reject('string-reason'), log, 'ctx-str');
    await flushMicrotasks();
    assert.equal(calls.length, 1);
    assert.match(calls[0] ?? '', /\[ctx-str\] string-reason/);
  });

  it('resolved promises do not trigger log', async () => {
    const { calls, log } = makeLog();
    logRejection(Promise.resolve('ok'), log, 'ctx-ok');
    await flushMicrotasks();
    assert.equal(calls.length, 0);
  });

  it('cache reset starts a fresh dedupe window', async () => {
    const { calls, log } = makeLog();
    for (let i = 0; i < 5; i++) {
      logRejection(Promise.reject(new Error(`x${String(i)}`)), log, 'test:reset');
    }
    await flushMicrotasks();
    assert.equal(calls.length, 3); // 2 errors + 1 suppressed notice

    _resetLogRejectionCache();

    for (let i = 0; i < 5; i++) {
      logRejection(Promise.reject(new Error(`y${String(i)}`)), log, 'test:reset');
    }
    await flushMicrotasks();
    assert.equal(calls.length, 6); // previous 3 + 2 new errors + 1 new notice
  });
});

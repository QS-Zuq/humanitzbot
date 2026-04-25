/**
 * Tests for panel-rcon.js — WebSocket RCON via Pterodactyl panel.
 * Run: node --test test/panel-rcon.test.js
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'events';

import * as _panel_rcon from '../src/rcon/panel-rcon.js';
import { ReconnectBackoff } from '../src/rcon/reconnect-backoff.js';
const { PanelRcon } = _panel_rcon as any;

// ── Mock WebSocket ──────────────────────────────────────

class MockWebSocket extends EventEmitter {
  static OPEN = 1;
  static CLOSED = 3;
  url: string;
  opts: unknown;
  readyState: number;
  _sends: string[];
  _lastSent: string | undefined;

  constructor(url: string, opts: unknown) {
    super();
    this.url = url;
    this.opts = opts;
    this.readyState = 1; // WebSocket.OPEN === 1
    this._sends = [];
  }
  send(data: string) {
    this._lastSent = data;
    this._sends.push(data);
  }
  close() {
    this.readyState = 3;
    this.emit('close');
  }
  terminate() {
    this.readyState = 3;
  }
}

// ── Helpers ─────────────────────────────────────────────

function createMockPanelApi(overrides: Record<string, unknown> = {}) {
  return {
    available: true,
    getWebsocketAuth: async () => ({ socket: 'wss://test.example.com/ws', token: 'test-jwt-token' }),
    ...overrides,
  };
}

function createTestRcon(opts: Record<string, unknown> = {}) {
  const panelApi = opts.panelApi ?? createMockPanelApi();
  return new PanelRcon({
    panelApi,
    WebSocket: MockWebSocket,
    label: 'TEST',
    ...opts,
  });
}

/** Drive MockWebSocket through open → auth success to complete connect(). */
async function connectRcon(rcon: InstanceType<typeof PanelRcon>) {
  const p = rcon.connect();
  await new Promise((r) => setTimeout(r, 20));
  rcon._ws.emit('open');
  rcon._ws.emit('message', JSON.stringify({ event: 'auth success' }));
  await p;
}

const noop = () => {};

interface FakeTimer {
  fn: () => void;
  delay: number;
  cleared: boolean;
}

function installFakeTimers() {
  const timers: FakeTimer[] = [];
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;

  (globalThis as any).setTimeout = (fn: () => void, delay = 0) => {
    const timer = { fn, delay, cleared: false };
    timers.push(timer);
    return timer;
  };
  (globalThis as any).clearTimeout = (timer: FakeTimer | undefined) => {
    if (timer) timer.cleared = true;
  };

  return {
    timers,
    restore() {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    },
  };
}

// ══════════════════════════════════════════════════════════
// _handleMessage
// ══════════════════════════════════════════════════════════

describe('_handleMessage', () => {
  let rcon: InstanceType<typeof PanelRcon>;

  beforeEach(() => {
    rcon = createTestRcon();
  });

  afterEach(async () => {
    await rcon.disconnect();
  });

  it('auth success sets connected and authenticated', () => {
    const timeout = setTimeout(noop, 15000);
    let resolved = false;
    rcon._handleMessage({ event: 'auth success' }, () => (resolved = true), noop, timeout);
    clearTimeout(timeout); // ensure no timer leak

    assert.equal(rcon.connected, true);
    assert.equal(rcon.authenticated, true);
    assert.equal(resolved, true);
  });

  it('auth success emits reconnect with downtime on re-connect', () => {
    rcon._everConnected = true;
    rcon._disconnectedAt = Date.now() - 5000;

    const events: unknown[] = [];
    rcon.on('reconnect', (data: unknown) => events.push(data));

    const timeout = setTimeout(noop, 15000);
    rcon._handleMessage({ event: 'auth success' }, noop, noop, timeout);
    clearTimeout(timeout);

    assert.equal(events.length, 1);
    assert.ok(
      (events[0] as { downtime: number }).downtime >= 4000,
      `downtime ${(events[0] as { downtime: number }).downtime} should be >= 4000`,
    );
    assert.equal(rcon._disconnectedAt, null);
  });

  it('first auth success does not emit reconnect', () => {
    const events: unknown[] = [];
    rcon.on('reconnect', (data: unknown) => events.push(data));

    const timeout = setTimeout(noop, 15000);
    rcon._handleMessage({ event: 'auth success' }, noop, noop, timeout);
    clearTimeout(timeout);

    assert.equal(events.length, 0);
    assert.equal(rcon._everConnected, true);
  });

  it('console output emits output event and feeds _outputCallback', () => {
    const emitted: string[] = [];
    rcon.on('output', (line: string) => emitted.push(line));
    const fed: string[] = [];
    rcon._outputCallback = (line: string) => fed.push(line);

    rcon._handleMessage({ event: 'console output', args: ['server started'] }, noop, noop);

    assert.deepEqual(emitted, ['server started']);
    assert.deepEqual(fed, ['server started']);
  });

  it('install output behaves the same as console output', () => {
    const emitted: string[] = [];
    rcon.on('output', (line: string) => emitted.push(line));
    const fed: string[] = [];
    rcon._outputCallback = (line: string) => fed.push(line);

    rcon._handleMessage({ event: 'install output', args: ['installing...'] }, noop, noop);

    assert.deepEqual(emitted, ['installing...']);
    assert.deepEqual(fed, ['installing...']);
  });

  it('token expiring triggers token refresh', async () => {
    const authCalls: number[] = [];
    const panelApi = createMockPanelApi({
      getWebsocketAuth: async () => {
        authCalls.push(1);
        return { socket: 'wss://test', token: 'refreshed-token' };
      },
    });
    rcon = createTestRcon({ panelApi });
    rcon._ws = new MockWebSocket('wss://test', undefined);
    rcon._ws.readyState = 1;

    rcon._handleMessage({ event: 'token expiring' }, noop, noop);
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(authCalls.length, 1, 'should call getWebsocketAuth');
    const sent = JSON.parse(rcon._ws._sends[0]);
    assert.equal(sent.event, 'auth');
    assert.deepEqual(sent.args, ['refreshed-token']);
    assert.equal(rcon._token, 'refreshed-token');
  });

  it('token expired cleans up state and schedules reconnect', () => {
    rcon.connected = true;
    rcon.authenticated = true;
    rcon._ws = new MockWebSocket('wss://test', undefined);

    rcon._handleMessage({ event: 'token expired' }, noop, noop);

    assert.equal(rcon.connected, false);
    assert.equal(rcon.authenticated, false);
    assert.ok(rcon._reconnectTimeout !== null, 'should schedule reconnect');
  });

  it('token refresh failure cleans up state and schedules one reconnect', async () => {
    const panelApi = createMockPanelApi({
      getWebsocketAuth: async () => {
        throw new Error('refresh failed');
      },
    });
    rcon = createTestRcon({ panelApi });
    rcon.connected = true;
    rcon.authenticated = true;
    rcon._ws = new MockWebSocket('wss://test', undefined);
    const warns: unknown[][] = [];
    rcon._log.warn = (...args: unknown[]) => warns.push(args);

    rcon._handleMessage({ event: 'token expiring' }, noop, noop);
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(rcon.connected, false);
    assert.equal(rcon.authenticated, false);
    assert.equal(warns.length, 1);
    assert.match(String(warns[0]?.[0]), /Token refresh failed/);
    assert.ok(rcon._reconnectTimeout !== null, 'should schedule reconnect');

    const scheduled = rcon._reconnectTimeout;
    rcon._scheduleReconnect();
    assert.strictEqual(rcon._reconnectTimeout, scheduled, 'pending reconnect should be deduped');
  });

  it('token refresh treats missing token as a recoverable reconnect failure', async () => {
    const panelApi = createMockPanelApi({
      getWebsocketAuth: async () => ({}),
    });
    rcon = createTestRcon({ panelApi });
    rcon.connected = true;
    rcon.authenticated = true;
    rcon._ws = new MockWebSocket('wss://test', undefined);
    const warns: unknown[][] = [];
    rcon._log.warn = (...args: unknown[]) => warns.push(args);

    await rcon._refreshToken();

    assert.equal(rcon.connected, false);
    assert.equal(rcon.authenticated, false);
    assert.equal(warns.length, 1);
    assert.match(String(warns[0]?.[1]), /Missing refreshed WebSocket token/);
    assert.ok(rcon._reconnectTimeout !== null, 'should schedule reconnect');
  });

  it('stats emits parsed JSON object', () => {
    const received: unknown[] = [];
    rcon.on('stats', (data: unknown) => received.push(data));

    const payload = { cpu_absolute: 12.5, memory_bytes: 1024000 };
    rcon._handleMessage({ event: 'stats', args: [JSON.stringify(payload)] }, noop, noop);

    assert.equal(received.length, 1);
    assert.deepEqual(received[0], payload);
  });

  it('stats with invalid JSON does not throw', () => {
    const received: unknown[] = [];
    rcon.on('stats', (data: unknown) => received.push(data));

    assert.doesNotThrow(() => {
      rcon._handleMessage({ event: 'stats', args: ['not-json{'] }, noop, noop);
    });
    assert.equal(received.length, 0);
  });

  it('status emits status string', () => {
    const statuses: string[] = [];
    rcon.on('status', (s: string) => statuses.push(s));

    rcon._handleMessage({ event: 'status', args: ['running'] }, noop, noop);

    assert.deepEqual(statuses, ['running']);
  });

  it('daemon message and other ignored events do not crash', () => {
    assert.doesNotThrow(() => {
      rcon._handleMessage({ event: 'daemon message', args: ['msg'] }, noop, noop);
      rcon._handleMessage({ event: 'install started', args: [] }, noop, noop);
      rcon._handleMessage({ event: 'backup completed', args: [] }, noop, noop);
      rcon._handleMessage({ event: 'unknown_custom_event', args: [] }, noop, noop);
    });
  });
});

// ══════════════════════════════════════════════════════════
// reconnect backoff
// ══════════════════════════════════════════════════════════

describe('reconnect backoff', () => {
  it('uses the same capped exponential delay helper as TCP RCON', () => {
    const backoff = new ReconnectBackoff();
    assert.equal(backoff.nextDelayMs(), 15000);
    assert.equal(backoff.nextDelayMs(), 30000);
    assert.equal(backoff.nextDelayMs(), 60000);
    assert.equal(backoff.nextDelayMs(), 120000);
    assert.equal(backoff.nextDelayMs(), 300000);
    assert.equal(backoff.nextDelayMs(), 300000);
  });

  it('schedules one reconnect timer with the current backoff delay', () => {
    const fakeTimers = installFakeTimers();
    try {
      const rcon = createTestRcon();
      rcon.connect = async () => {};

      rcon._scheduleReconnect();
      rcon._scheduleReconnect();

      assert.equal(fakeTimers.timers.length, 1, 'pending reconnect timer should be deduped');
      assert.equal(fakeTimers.timers[0]?.delay, 15000);
      assert.ok(rcon._reconnectTimeout);
    } finally {
      fakeTimers.restore();
    }
  });

  it('reschedules after a failed reconnect attempt and resets on auth success', async () => {
    const fakeTimers = installFakeTimers();
    try {
      const rcon = createTestRcon();
      rcon.connect = async () => {
        throw new Error('boom');
      };

      rcon._scheduleReconnect();
      assert.equal(fakeTimers.timers[0]?.delay, 15000);
      fakeTimers.timers[0].fn();
      await Promise.resolve();
      assert.equal(fakeTimers.timers[1]?.delay, 30000);

      const timeout = setTimeout(noop, 15000);
      rcon._handleMessage({ event: 'auth success' }, noop, timeout);
      assert.equal(rcon._reconnectBackoff.nextDelayMs(), 15000);
    } finally {
      fakeTimers.restore();
    }
  });

  it('manual disconnect clears the timer and resets backoff', () => {
    const fakeTimers = installFakeTimers();
    try {
      const rcon = createTestRcon();
      rcon._scheduleReconnect();
      rcon.disconnect();

      assert.equal(fakeTimers.timers[0]?.cleared, true);
      assert.equal(rcon._reconnectTimeout, null);
      assert.equal(rcon._reconnectBackoff.nextDelayMs(), 15000);
    } finally {
      fakeTimers.restore();
    }
  });
});

// ══════════════════════════════════════════════════════════
// Connect lifecycle
// ══════════════════════════════════════════════════════════

describe('connect lifecycle', () => {
  it('sends auth JSON on WebSocket open', async () => {
    const rcon = createTestRcon();
    const p = rcon.connect();
    await new Promise((r) => setTimeout(r, 20));

    assert.ok(rcon._ws, 'WebSocket should be created');
    rcon._ws.emit('open');

    const authMsg = JSON.parse(rcon._ws._sends[0]);
    assert.equal(authMsg.event, 'auth');
    assert.deepEqual(authMsg.args, ['test-jwt-token']);

    rcon._ws.emit('message', JSON.stringify({ event: 'auth success' }));
    await p;
    rcon.disconnect();
  });

  it('resolves when auth success message is received', async () => {
    const rcon = createTestRcon();
    await connectRcon(rcon);

    assert.equal(rcon.connected, true);
    assert.equal(rcon.authenticated, true);
    rcon.disconnect();
  });

  it('deduplicates concurrent connect attempts', async () => {
    let wsCount = 0;
    class CountingWS extends MockWebSocket {
      constructor(url: string, opts: unknown) {
        super(url, opts);
        wsCount++;
      }
    }

    const rcon = new PanelRcon({
      panelApi: createMockPanelApi(),
      WebSocket: CountingWS,
      label: 'TEST',
    });

    const p1 = rcon.connect();
    const p2 = rcon.connect();

    await new Promise((r) => setTimeout(r, 20));
    rcon._ws.emit('open');
    rcon._ws.emit('message', JSON.stringify({ event: 'auth success' }));

    await Promise.all([p1, p2]);
    assert.equal(wsCount, 1, 'should only create one WebSocket');
    rcon.disconnect();
  });

  it('rejects when panelApi returns no token', async () => {
    const rcon = createTestRcon({
      panelApi: createMockPanelApi({
        getWebsocketAuth: async () => ({ socket: 'wss://test', token: null }),
      }),
    });

    await assert.rejects(rcon.connect(), { message: /Failed to get WebSocket credentials/ });
  });

  it('rejects and reschedules when WebSocket closes before auth success', async () => {
    class ClosingWS extends MockWebSocket {
      constructor(url: string, opts: unknown) {
        super(url, opts);
        setImmediate(() => this.emit('close', 1006, Buffer.alloc(0)));
      }
    }

    const rcon = createTestRcon({ WebSocket: ClosingWS });
    rcon._everConnected = true;

    try {
      await assert.rejects(rcon.connect(), { message: /WebSocket closed: code 1006/ });
      assert.ok(rcon._reconnectTimeout !== null, 'should schedule reconnect after pre-auth close');
    } finally {
      rcon.disconnect();
    }
  });

  it('settles once when WebSocket error and close both fire while connecting', async () => {
    class ErrorThenCloseWS extends MockWebSocket {
      constructor(url: string, opts: unknown) {
        super(url, opts);
        setImmediate(() => {
          this.emit('error', new Error('ws failed'));
          this.emit('close', 1006, Buffer.alloc(0));
        });
      }
    }

    const rcon = createTestRcon({ WebSocket: ErrorThenCloseWS });
    rcon._everConnected = true;
    let reconnectSchedules = 0;
    rcon._scheduleReconnect = () => {
      reconnectSchedules++;
    };

    await assert.rejects(rcon.connect(), { message: /ws failed/ });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(reconnectSchedules, 1, 'should schedule reconnect once for paired error/close events');
  });

  it('returns immediately when already connected and authenticated', async () => {
    const rcon = createTestRcon();
    await connectRcon(rcon);

    const sendsBefore = rcon._ws._sends.length;
    await rcon.connect();
    assert.equal(rcon._ws._sends.length, sendsBefore, 'should not send additional auth');
    rcon.disconnect();
  });
});

// ══════════════════════════════════════════════════════════
// send / _sendCommand
// ══════════════════════════════════════════════════════════

describe('send / _sendCommand', () => {
  it('wraps command in { event: "send command", args: [cmd] }', { timeout: 5000 }, async () => {
    const rcon = createTestRcon();
    await connectRcon(rcon);

    const p = rcon.send('Players');
    await new Promise((r) => setTimeout(r, 50));

    const cmdMsg = rcon._ws._sends
      .map((s: string) => JSON.parse(s))
      .find((m: { event: string }) => m.event === 'send command');
    assert.deepEqual(cmdMsg, { event: 'send command', args: ['Players'] });

    // Feed output to resolve the command
    rcon._ws.emit('message', JSON.stringify({ event: 'console output', args: ['response'] }));
    await p;
    rcon.disconnect();
  });

  it('rejects when WebSocket is null', async () => {
    const rcon = createTestRcon();
    rcon.connected = true;
    rcon.authenticated = true;
    rcon._ws = null;

    await assert.rejects(rcon._sendCommand('info'), { message: /WebSocket not connected/ });
  });

  it('rejects when WebSocket readyState is not OPEN', async () => {
    const rcon = createTestRcon();
    rcon.connected = true;
    rcon.authenticated = true;
    rcon._ws = new MockWebSocket('wss://test', undefined);
    rcon._ws.readyState = 3; // CLOSED

    await assert.rejects(rcon._sendCommand('info'), { message: /WebSocket not connected/ });
  });

  it('skips command echo, strips [RCON]: prefix and ANSI codes', { timeout: 5000 }, async () => {
    const rcon = createTestRcon({ silenceMs: 30 });
    await connectRcon(rcon);

    const p = rcon.send('Players');
    await new Promise((r) => setTimeout(r, 20));

    // Command echo — should be skipped
    rcon._ws.emit('message', JSON.stringify({ event: 'console output', args: ['Players'] }));
    // Normal line with [RCON]: prefix — prefix stripped
    rcon._ws.emit('message', JSON.stringify({ event: 'console output', args: ['[RCON]: Player1'] }));
    // ANSI-wrapped line with [RCON]: prefix — both stripped
    rcon._ws.emit('message', JSON.stringify({ event: 'console output', args: ['\x1b[33m[RCON]: Player2\x1b[0m'] }));
    // Plain line without prefix — kept as-is
    rcon._ws.emit('message', JSON.stringify({ event: 'console output', args: ['Status: OK'] }));

    const result = await p;
    assert.equal(result, 'Player1\nPlayer2\nStatus: OK');
    rcon.disconnect();
  });

  it('silence detection — resolves after configured silence period', { timeout: 5000 }, async () => {
    const rcon = createTestRcon({ silenceMs: 30 });
    await connectRcon(rcon);

    const p = rcon.send('info');
    await new Promise((r) => setTimeout(r, 20));

    rcon._ws.emit('message', JSON.stringify({ event: 'console output', args: ['info'] }));
    rcon._ws.emit('message', JSON.stringify({ event: 'console output', args: ['[RCON]: Server v1.0'] }));

    const result = await p;
    assert.equal(result, 'Server v1.0');
    rcon.disconnect();
  });

  it('command queuing — second send waits for first to complete', { timeout: 5000 }, async () => {
    const rcon = createTestRcon({ silenceMs: 30 });
    await connectRcon(rcon);

    const p1 = rcon.send('cmd1');
    const p2 = rcon.send('cmd2');
    await new Promise((r) => setTimeout(r, 20));

    const sentCmds = rcon._ws._sends
      .map((s: string) => JSON.parse(s))
      .filter((m: { event: string }) => m.event === 'send command');
    assert.equal(sentCmds.length, 1);
    assert.deepEqual(sentCmds[0].args, ['cmd1']);

    // Resolve cmd1
    rcon._ws.emit('message', JSON.stringify({ event: 'console output', args: ['cmd1'] }));
    rcon._ws.emit('message', JSON.stringify({ event: 'console output', args: ['result1'] }));
    const r1 = await p1;
    assert.equal(r1, 'result1');

    // Wait for cmd2 to start
    await new Promise((r) => setTimeout(r, 50));
    const allCmds = rcon._ws._sends
      .map((s: string) => JSON.parse(s))
      .filter((m: { event: string }) => m.event === 'send command');
    assert.equal(allCmds.length, 2, 'cmd2 should now be sent');
    assert.deepEqual(allCmds[1].args, ['cmd2']);

    // Resolve cmd2
    rcon._ws.emit('message', JSON.stringify({ event: 'console output', args: ['cmd2'] }));
    rcon._ws.emit('message', JSON.stringify({ event: 'console output', args: ['result2'] }));
    const r2 = await p2;
    assert.equal(r2, 'result2');

    rcon.disconnect();
  });
});

// ══════════════════════════════════════════════════════════
// sendCached
// ══════════════════════════════════════════════════════════

describe('sendCached', () => {
  it('returns cached response within TTL', async () => {
    const rcon = createTestRcon();
    rcon.cache.set('info', { data: 'cached-info-response', timestamp: Date.now() });

    const result = await rcon.sendCached('info', 30000);
    assert.equal(result, 'cached-info-response');
  });

  it('re-fetches when cache entry is expired', async () => {
    const rcon = createTestRcon();
    rcon.send = async (cmd: string) => `fresh-${cmd}`;
    rcon.cache.set('info', { data: 'stale-data', timestamp: Date.now() - 60000 });

    const result = await rcon.sendCached('info', 30000);
    assert.equal(result, 'fresh-info');
    assert.equal(rcon.cache.get('info').data, 'fresh-info');
  });

  it('evicts stale entries when cache exceeds 50', async () => {
    const rcon = createTestRcon();
    rcon.send = async (cmd: string) => `result-${cmd}`;

    // Fill cache with 51 stale entries (all older than 2× TTL)
    for (let i = 0; i < 51; i++) {
      rcon.cache.set(`cmd-${i}`, { data: `data-${i}`, timestamp: Date.now() - 120000 });
    }

    await rcon.sendCached('new-cmd', 30000);
    assert.equal(rcon.cache.size, 1, 'all stale entries should be evicted, only new entry remains');
  });
});

// ══════════════════════════════════════════════════════════
// disconnect
// ══════════════════════════════════════════════════════════

describe('disconnect', () => {
  it('resets connected state and clears WebSocket', async () => {
    const rcon = createTestRcon();
    await connectRcon(rcon);

    assert.equal(rcon.connected, true);
    assert.ok(rcon._ws);

    await rcon.disconnect();

    assert.equal(rcon.connected, false);
    assert.equal(rcon.authenticated, false);
    assert.equal(rcon._ws, null);
    assert.equal(rcon._outputCallback, null);
  });
});

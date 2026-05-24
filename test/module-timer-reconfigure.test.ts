import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import ChatRelay from '../src/modules/chat-relay.js';
import AutoMessages from '../src/modules/auto-messages.js';
import PlayerPresenceTracker from '../src/modules/player-presence.js';
import AnticheatIntegration from '../src/modules/anticheat-integration.js';
import LogWatcher from '../src/modules/log-watcher.js';

type TimerToken = {
  id: number;
  delay: number;
  callback: IntervalCallback;
};

type TimerHandler = Parameters<typeof setInterval>[0];
type IntervalCallback = (...args: unknown[]) => void;

function withIntervalSpy<T>(fn: (spy: IntervalSpy) => T): T {
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const spy = new IntervalSpy();

  globalThis.setInterval = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
    const token = spy.schedule(() => {}, timeout ?? 0);
    token.callback = () => {
      if (typeof handler === 'function') {
        (handler as IntervalCallback)(...args);
      }
    };
    return token as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval;

  globalThis.clearInterval = ((timer?: ReturnType<typeof setInterval>) => {
    spy.clear(timer);
  }) as typeof clearInterval;

  try {
    return fn(spy);
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
}

class IntervalSpy {
  private _nextId = 1;
  readonly scheduled: TimerToken[] = [];
  readonly cleared: unknown[] = [];

  existing(delay = 1): ReturnType<typeof setInterval> {
    return { id: this._nextId++, delay, callback: () => undefined } as unknown as ReturnType<typeof setInterval>;
  }

  schedule(callback: IntervalCallback, delay: number): TimerToken {
    const token = { id: this._nextId++, delay, callback };
    this.scheduled.push(token);
    return token;
  }

  clear(timer: unknown): void {
    this.cleared.push(timer);
  }
}

function withTimeoutClearSpy<T>(fn: (spy: TimeoutClearSpy) => T): T {
  const originalClearTimeout = globalThis.clearTimeout;
  const spy = new TimeoutClearSpy();

  globalThis.clearTimeout = ((timer?: ReturnType<typeof setTimeout>) => {
    spy.clear(timer);
  }) as typeof clearTimeout;

  try {
    return fn(spy);
  } finally {
    globalThis.clearTimeout = originalClearTimeout;
  }
}

class TimeoutClearSpy {
  private _nextId = 1;
  readonly cleared: unknown[] = [];

  existing(delay = 1): ReturnType<typeof setTimeout> {
    return { id: this._nextId++, delay, callback: () => undefined } as unknown as ReturnType<typeof setTimeout>;
  }

  clear(timer: unknown): void {
    this.cleared.push(timer);
  }
}

function baseConfig(overrides: Record<string, unknown> = {}) {
  return {
    chatPollInterval: 10_000,
    autoMsgLinkInterval: 1_800_000,
    autoMsgPromoInterval: 2_700_000,
    autoMsgJoinCheckInterval: 10_000,
    enableAutoMsgLink: true,
    enableAutoMsgPromo: true,
    enableWelcomeMsg: true,
    autoMsgLinkText: '',
    autoMsgPromoText: '',
    anticheatAnalyzeInterval: 60_000,
    anticheatBaselineInterval: 900_000,
    logPollInterval: 30_000,
    enablePvpKillFeed: true,
    pvpKillWindow: 60_000,
    enableDeathLoopDetection: true,
    deathLoopThreshold: 3,
    deathLoopWindow: 60_000,
    discordInviteLink: '',
    serverName: 'Test Server',
    formatTime: (date: Date) => date.toISOString(),
    ...overrides,
  } as any;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('module timer reconfigure', () => {
  it('ChatRelay resets active chat poll timer without re-registering Discord listeners', () => {
    withIntervalSpy((spy) => {
      const client = { on: (_event: string, _handler: unknown) => {}, removeListener: () => {} } as any;
      const config = baseConfig({ chatPollInterval: 10_000 });
      const relay = new ChatRelay(client, { config });
      const originalTimer = spy.existing(10_000);
      (relay as any)._pollTimer = originalTimer;
      let listenerAdds = 0;
      client.on = () => {
        listenerAdds += 1;
      };

      relay.reconfigure({ chatPollInterval: 45_000 });

      assert.equal(config.chatPollInterval, 45_000);
      assert.deepEqual(spy.cleared, [originalTimer]);
      assert.equal(spy.scheduled.length, 1);
      assert.equal(spy.scheduled[0]?.delay, 45_000);
      assert.equal(listenerAdds, 0);
    });
  });

  it('ChatRelay updates config but does not create a timer when inactive', () => {
    withIntervalSpy((spy) => {
      const config = baseConfig({ chatPollInterval: 10_000 });
      const relay = new ChatRelay({ on: () => {}, removeListener: () => {} } as any, { config });

      relay.reconfigure({ chatPollInterval: 20_000 });

      assert.equal(config.chatPollInterval, 20_000);
      assert.deepEqual(spy.cleared, []);
      assert.deepEqual(spy.scheduled, []);
    });
  });

  it('ChatRelay skips overlapping chat polls', async () => {
    const firstPoll = deferred<string>();
    let sendCalls = 0;
    const relay = new ChatRelay(
      { on: () => {}, removeListener: () => {} } as any,
      {
        config: baseConfig(),
        rcon: {
          send: async () => {
            sendCalls += 1;
            if (sendCalls === 1) return firstPoll.promise;
            return '';
          },
        },
      } as any,
    );

    const poll1 = (relay as any)._pollChat();
    const poll2 = (relay as any)._pollChat();

    assert.equal(sendCalls, 1);
    firstPoll.resolve('');
    await Promise.all([poll1, poll2]);

    await (relay as any)._pollChat();

    assert.equal(sendCalls, 2);
  });

  it('AutoMessages resets only existing link/promo timers', () => {
    withIntervalSpy((spy) => {
      const config = baseConfig({ autoMsgLinkInterval: 1_800_000, autoMsgPromoInterval: 2_700_000 });
      const autoMessages = new AutoMessages({ config });
      const linkTimer = spy.existing(1_800_000);
      (autoMessages as any)._linkTimer = linkTimer;

      autoMessages.reconfigure({ autoMsgLinkInterval: 120_000, autoMsgPromoInterval: 180_000 });

      assert.equal(config.autoMsgLinkInterval, 120_000);
      assert.equal(config.autoMsgPromoInterval, 180_000);
      assert.deepEqual(spy.cleared, [linkTimer]);
      assert.equal(spy.scheduled.length, 1);
      assert.equal(spy.scheduled[0]?.delay, 120_000);
      assert.equal((autoMessages as any)._promoTimer, null);
    });
  });

  it('AutoMessages keeps identical intervals on the existing timer', () => {
    withIntervalSpy((spy) => {
      const config = baseConfig({ autoMsgLinkInterval: 1_800_000 });
      const autoMessages = new AutoMessages({ config });
      const linkTimer = spy.existing(1_800_000);
      (autoMessages as any)._linkTimer = linkTimer;

      autoMessages.reconfigure({ autoMsgLinkInterval: 1_800_000 });

      assert.deepEqual(spy.cleared, []);
      assert.deepEqual(spy.scheduled, []);
      assert.equal((autoMessages as any)._linkTimer, linkTimer);
    });
  });

  it('AutoMessages updates text and invite settings without sending immediately', () => {
    withIntervalSpy((spy) => {
      const config = baseConfig({
        discordInviteLink: 'https://discord.gg/old',
        autoMsgLinkText: '',
        autoMsgPromoText: '',
      });
      const autoMessages = new AutoMessages({ config });
      let sendCalls = 0;
      (autoMessages as any)._sendDiscordLink = () => {
        sendCalls += 1;
      };
      (autoMessages as any)._sendPromoMessage = () => {
        sendCalls += 1;
      };

      autoMessages.reconfigure({
        discordInviteLink: 'https://discord.gg/new',
        autoMsgLinkText: 'Join {discord}',
        autoMsgPromoText: 'Promo {players}',
      });

      assert.equal(config.discordInviteLink, 'https://discord.gg/new');
      assert.equal((autoMessages as any).discordLink, 'https://discord.gg/new');
      assert.equal(config.autoMsgLinkText, 'Join {discord}');
      assert.equal(config.autoMsgPromoText, 'Promo {players}');
      assert.equal(sendCalls, 0);
      assert.deepEqual(spy.scheduled, []);
    });
  });

  it('AutoMessages toggles link and promo timers idempotently', () => {
    withIntervalSpy((spy) => {
      const config = baseConfig({
        enableAutoMsgLink: false,
        enableAutoMsgPromo: true,
        autoMsgLinkInterval: 120_000,
        autoMsgPromoInterval: 180_000,
      });
      const autoMessages = new AutoMessages({ config });
      const promoTimer = spy.existing(180_000);
      (autoMessages as any)._promoTimer = promoTimer;

      autoMessages.reconfigure({ enableAutoMsgLink: true });
      autoMessages.reconfigure({ enableAutoMsgLink: true });
      autoMessages.reconfigure({ enableAutoMsgPromo: false });

      assert.equal(config.enableAutoMsgLink, true);
      assert.equal(config.enableAutoMsgPromo, false);
      assert.equal(spy.scheduled.length, 1);
      assert.equal(spy.scheduled[0]?.delay, 120_000);
      assert.deepEqual(spy.cleared, [promoTimer]);
      assert.notEqual((autoMessages as any)._linkTimer, null);
      assert.equal((autoMessages as any)._promoTimer, null);
    });
  });

  it('AutoMessages toggles welcome listener idempotently', () => {
    const added: Array<{ event: string; listener: unknown }> = [];
    const removed: Array<{ event: string; listener: unknown }> = [];
    const presenceTracker = {
      on(event: string, listener: unknown) {
        added.push({ event, listener });
      },
      removeListener(event: string, listener: unknown) {
        removed.push({ event, listener });
      },
    };
    const config = baseConfig({ enableWelcomeMsg: false });
    const autoMessages = new AutoMessages({ config, presenceTracker: presenceTracker as any });

    autoMessages.reconfigure({ enableWelcomeMsg: true });
    autoMessages.reconfigure({ enableWelcomeMsg: true });
    autoMessages.reconfigure({ enableWelcomeMsg: false });

    assert.equal(config.enableWelcomeMsg, false);
    assert.equal(added.length, 1);
    const [addedListener] = added;
    assert.ok(addedListener);
    assert.equal(addedListener.event, 'playerJoined');
    assert.deepEqual(removed, [{ event: 'playerJoined', listener: addedListener.listener }]);
    assert.equal((autoMessages as any)._onPlayerJoined, null);
  });

  it('PlayerPresenceTracker resets active join-check timer', () => {
    withIntervalSpy((spy) => {
      const config = baseConfig({ autoMsgJoinCheckInterval: 10_000 });
      const tracker = new PlayerPresenceTracker({ config });
      const originalTimer = spy.existing(10_000);
      (tracker as any)._pollTimer = originalTimer;

      tracker.reconfigure({ autoMsgJoinCheckInterval: 15_000 });

      assert.equal(config.autoMsgJoinCheckInterval, 15_000);
      assert.deepEqual(spy.cleared, [originalTimer]);
      assert.equal(spy.scheduled.length, 1);
      assert.equal(spy.scheduled[0]?.delay, 15_000);
    });
  });

  it('PlayerPresenceTracker keeps identical intervals on the existing timer', () => {
    withIntervalSpy((spy) => {
      const config = baseConfig({ autoMsgJoinCheckInterval: 10_000 });
      const tracker = new PlayerPresenceTracker({ config });
      const originalTimer = spy.existing(10_000);
      (tracker as any)._pollTimer = originalTimer;

      tracker.reconfigure({ autoMsgJoinCheckInterval: 10_000 });

      assert.deepEqual(spy.cleared, []);
      assert.deepEqual(spy.scheduled, []);
      assert.equal((tracker as any)._pollTimer, originalTimer);
    });
  });

  it('PlayerPresenceTracker skips overlapping polls', async () => {
    const firstPoll = deferred<{ players: unknown[] }>();
    let listCalls = 0;
    const tracker = new PlayerPresenceTracker({
      config: baseConfig(),
      playtime: {
        playerJoin: () => {},
        recordPlayerCount: () => {},
        recordUniqueToday: () => {},
      },
      getPlayerList: async () => {
        listCalls += 1;
        if (listCalls === 1) return firstPoll.promise as any;
        return { players: [] } as any;
      },
    } as any);
    (tracker as any)._initialised = true;

    const poll1 = (tracker as any)._poll();
    const poll2 = (tracker as any)._poll();

    assert.equal(listCalls, 1);
    firstPoll.resolve({ players: [] });
    await Promise.all([poll1, poll2]);

    await (tracker as any)._poll();

    assert.equal(listCalls, 2);
  });

  it('AnticheatIntegration resets active timers without starting unavailable engine', () => {
    withIntervalSpy((spy) => {
      const config = baseConfig({ anticheatAnalyzeInterval: 60_000, anticheatBaselineInterval: 900_000 });
      const anticheat = new AnticheatIntegration({ config });
      const analyzeTimer = spy.existing(60_000);
      const baselineTimer = spy.existing(900_000);
      (anticheat as any)._analyzeTimer = analyzeTimer;
      (anticheat as any)._baselineTimer = baselineTimer;

      anticheat.reconfigure({ anticheatAnalyzeInterval: 120_000, anticheatBaselineInterval: 1_200_000 });

      assert.equal(config.anticheatAnalyzeInterval, 120_000);
      assert.equal(config.anticheatBaselineInterval, 1_200_000);
      assert.deepEqual(spy.cleared, [analyzeTimer, baselineTimer]);
      assert.deepEqual(
        spy.scheduled.map((timer) => timer.delay),
        [120_000, 1_200_000],
      );
      assert.equal((anticheat as any)._engine, null);
    });
  });

  it('AnticheatIntegration clamps low intervals to safe minimums', () => {
    withIntervalSpy((spy) => {
      const config = baseConfig({ anticheatAnalyzeInterval: 60_000, anticheatBaselineInterval: 900_000 });
      const anticheat = new AnticheatIntegration({ config });
      const analyzeTimer = spy.existing(60_000);
      (anticheat as any)._analyzeTimer = analyzeTimer;

      anticheat.reconfigure({ anticheatAnalyzeInterval: 1_000 });

      assert.equal(config.anticheatAnalyzeInterval, 30_000);
      assert.deepEqual(spy.cleared, [analyzeTimer]);
      assert.equal(spy.scheduled.length, 1);
      assert.equal(spy.scheduled[0]?.delay, 30_000);
    });
  });

  it('AnticheatIntegration rejects non-numeric runtime intervals visibly', () => {
    withIntervalSpy((spy) => {
      const config = baseConfig({ anticheatAnalyzeInterval: 60_000, anticheatBaselineInterval: 900_000 });
      const anticheat = new AnticheatIntegration({ config });
      const analyzeTimer = spy.existing(60_000);
      (anticheat as any)._analyzeTimer = analyzeTimer;

      assert.throws(() => {
        anticheat.reconfigure({ anticheatAnalyzeInterval: 'not-a-number' });
      }, /anticheat analyze interval must be a finite number/);

      assert.equal(config.anticheatAnalyzeInterval, 60_000);
      assert.deepEqual(spy.cleared, []);
      assert.deepEqual(spy.scheduled, []);
      assert.equal((anticheat as any)._analyzeTimer, analyzeTimer);
    });
  });

  it('AnticheatIntegration does not create timers when engine never started', () => {
    withIntervalSpy((spy) => {
      const config = baseConfig({ anticheatAnalyzeInterval: 60_000, anticheatBaselineInterval: 900_000 });
      const anticheat = new AnticheatIntegration({ config });

      anticheat.reconfigure({ anticheatAnalyzeInterval: 120_000, anticheatBaselineInterval: 1_200_000 });

      assert.equal(config.anticheatAnalyzeInterval, 120_000);
      assert.equal(config.anticheatBaselineInterval, 1_200_000);
      assert.deepEqual(spy.cleared, []);
      assert.deepEqual(spy.scheduled, []);
      assert.equal((anticheat as any)._engine, null);
    });
  });

  it('LogWatcher updates config but does not create a timer when inactive', () => {
    withIntervalSpy((spy) => {
      const config = baseConfig({ logPollInterval: 30_000 });
      const watcher = new LogWatcher({} as any, { config });

      watcher.reconfigure({ logPollInterval: 45_000 });

      assert.equal(config.logPollInterval, 45_000);
      assert.deepEqual(spy.cleared, []);
      assert.deepEqual(spy.scheduled, []);
      assert.equal(watcher.interval, null);
    });
  });

  it('LogWatcher resets active log poll timer without triggering an immediate poll', () => {
    withIntervalSpy((spy) => {
      const config = baseConfig({ logPollInterval: 30_000 });
      const watcher = new LogWatcher({} as any, { config });
      const originalTimer = spy.existing(30_000);
      let pollCalls = 0;
      watcher.interval = originalTimer;
      (watcher as any)._polling = true;
      (watcher as any)._poll = () => {
        pollCalls += 1;
        return Promise.resolve();
      };

      watcher.reconfigure({ logPollInterval: 45_000 });

      assert.equal(config.logPollInterval, 45_000);
      assert.deepEqual(spy.cleared, [originalTimer]);
      assert.equal(spy.scheduled.length, 1);
      assert.equal(spy.scheduled[0]?.delay, 45_000);
      assert.equal(pollCalls, 0);
    });
  });

  it('LogWatcher clamps runtime interval to the configured minimum', () => {
    withIntervalSpy((spy) => {
      const config = baseConfig({ logPollInterval: 30_000 });
      const watcher = new LogWatcher({} as any, { config });
      const originalTimer = spy.existing(30_000);
      watcher.interval = originalTimer;

      watcher.reconfigure({ logPollInterval: 1_000 });

      assert.equal(config.logPollInterval, 10_000);
      assert.deepEqual(spy.cleared, [originalTimer]);
      assert.equal(spy.scheduled.length, 1);
      assert.equal(spy.scheduled[0]?.delay, 10_000);
    });
  });

  it('LogWatcher applies kill feed and death-loop settings without touching the poll timer', () => {
    withIntervalSpy((spy) => {
      const config = baseConfig({
        enablePvpKillFeed: true,
        pvpKillWindow: 60_000,
        enableDeathLoopDetection: true,
        deathLoopThreshold: 3,
        deathLoopWindow: 60_000,
      });
      const watcher = new LogWatcher({} as any, { config });
      const originalTimer = spy.existing(30_000);
      let pollCalls = 0;
      watcher.interval = originalTimer;
      (watcher as any)._poll = () => {
        pollCalls += 1;
        return Promise.resolve();
      };

      watcher.reconfigure({
        enablePvpKillFeed: false,
        pvpKillWindow: 90_000,
        enableDeathLoopDetection: false,
        deathLoopThreshold: 5,
        deathLoopWindow: 120_000,
      });

      assert.equal(config.enablePvpKillFeed, false);
      assert.equal(config.pvpKillWindow, 90_000);
      assert.equal(config.enableDeathLoopDetection, false);
      assert.equal(config.deathLoopThreshold, 5);
      assert.equal(config.deathLoopWindow, 120_000);
      assert.deepEqual(spy.cleared, []);
      assert.deepEqual(spy.scheduled, []);
      assert.equal(watcher.interval, originalTimer);
      assert.equal(pollCalls, 0);
    });
  });

  it('LogWatcher keeps invalid numeric reconfigure values out of runtime config', () => {
    const config = baseConfig({ pvpKillWindow: 60_000, deathLoopThreshold: 3, deathLoopWindow: 60_000 });
    const watcher = new LogWatcher({} as any, { config });

    watcher.reconfigure({
      pvpKillWindow: 'not-a-number',
      deathLoopThreshold: 'nope',
      deathLoopWindow: Number.NaN,
    });

    assert.equal(config.pvpKillWindow, 60_000);
    assert.equal(config.deathLoopThreshold, 3);
    assert.equal(config.deathLoopWindow, 60_000);

    watcher.reconfigure({ pvpKillWindow: 0, deathLoopThreshold: 0, deathLoopWindow: 0 });

    assert.equal(config.pvpKillWindow, 1);
    assert.equal(config.deathLoopThreshold, 1);
    assert.equal(config.deathLoopWindow, 1);
  });

  it('LogWatcher clears queued death-loop summaries when detection is disabled live', () => {
    withTimeoutClearSpy((spy) => {
      const config = baseConfig({ enableDeathLoopDetection: true, deathLoopThreshold: 3, deathLoopWindow: 60_000 });
      const watcher = new LogWatcher({} as any, { config });
      const deathLoopTimer = spy.existing(60_000);
      (watcher as any)._deathLoopTracker.set('player-one', {
        count: 3,
        firstTimestamp: 1_000,
        lastTimestamp: 2_000,
        timer: deathLoopTimer,
      });

      watcher.reconfigure({ enableDeathLoopDetection: false });

      assert.equal(config.enableDeathLoopDetection, false);
      assert.deepEqual(spy.cleared, [deathLoopTimer]);
      assert.equal((watcher as any)._deathLoopTracker.size, 0);
    });
  });
});

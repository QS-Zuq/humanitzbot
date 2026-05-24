import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import RuntimeConfigApplier from '../src/config/runtime-config-applier.js';
import {
  isDirectSavePolling,
  registerSaveServiceRuntimeHandlers,
  resolveSaveServicePollInterval,
} from '../src/config/save-service-runtime.js';
import SaveService from '../src/parsers/save-service.js';

type TimerToken = {
  id: number;
  delay: number;
  callback: (...args: unknown[]) => void;
};

type TimerHandler = Parameters<typeof setInterval>[0];

class IntervalSpy {
  private _nextId = 1;
  readonly scheduled: TimerToken[] = [];
  readonly cleared: unknown[] = [];

  schedule(callback: (...args: unknown[]) => void, delay: number): TimerToken {
    const token = { id: this._nextId++, delay, callback };
    this.scheduled.push(token);
    return token;
  }

  clear(timer: unknown): void {
    this.cleared.push(timer);
  }
}

async function withIntervalSpy<T>(fn: (spy: IntervalSpy) => Promise<T> | T): Promise<T> {
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const spy = new IntervalSpy();

  globalThis.setInterval = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
    return spy.schedule(() => {
      if (typeof handler === 'function') {
        (handler as (...callbackArgs: unknown[]) => void)(...args);
      }
    }, timeout ?? 0) as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval;

  globalThis.clearInterval = ((timer?: ReturnType<typeof setInterval>) => {
    spy.clear(timer);
  }) as typeof clearInterval;

  try {
    return await fn(spy);
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
}

function makeSaveService(pollInterval = 60_000): SaveService {
  const service = new SaveService({} as any, {
    pollInterval,
    agentMode: 'auto',
    label: 'SAVE TEST',
  });
  (service as any)._poll = async () => {};
  return service;
}

describe('SaveService runtime reconfigure', () => {
  it('resets the active poll timer when the interval changes', async () => {
    await withIntervalSpy(async (spy) => {
      const service = makeSaveService(60_000);

      await service.start();
      assert.equal(spy.scheduled.length, 1);
      assert.equal(spy.scheduled[0]?.delay, 60_000);

      service.reconfigure({ pollInterval: 90_000 });

      assert.deepEqual(spy.cleared, [spy.scheduled[0]]);
      assert.equal(spy.scheduled.length, 2);
      assert.equal(spy.scheduled[1]?.delay, 90_000);

      service.stop();
    });
  });

  it('keeps the existing timer when the interval is unchanged', async () => {
    await withIntervalSpy(async (spy) => {
      const service = makeSaveService(60_000);

      await service.start();
      const originalTimer = spy.scheduled[0];

      service.reconfigure({ pollInterval: 60_000 });

      assert.deepEqual(spy.cleared, []);
      assert.equal(spy.scheduled.length, 1);
      assert.equal(spy.scheduled[0], originalTimer);

      service.stop();
    });
  });

  it('updates inactive settings without creating a timer', async () => {
    await withIntervalSpy((spy) => {
      const service = makeSaveService(60_000);

      service.reconfigure({ pollInterval: 90_000, agentTimeout: 15_000, agentPanelDelay: 750 });

      assert.deepEqual(spy.scheduled, []);
      assert.equal((service as any)._pollInterval, 90_000);
      assert.equal((service as any)._agentTimeout, 15_000);
      assert.equal((service as any)._agentPanelDelay, 750);
    });
  });

  it('updates SFTP source fields and resets source-derived runtime state', async () => {
    await withIntervalSpy((spy) => {
      const service = makeSaveService(60_000);
      const oldCredentialFixture = 'fixture-old';
      const nextCredentialFixture = 'fixture-next';

      Object.assign(service as any, {
        _sftpConfig: { host: 'old', port: 2022, username: 'old-user', password: oldCredentialFixture },
        _savePath: '/old/SaveList/Default/Save_DedicatedSaveMP.sav',
        _clanSavePath: '/old/Save_ClanData.sav',
        _agentIdMapPath: '/old/PlayerIDMapped.txt',
        _lastMtime: 123,
        _lastClanMtime: 456,
        _lastCacheMtime: 789,
        _agentCapable: true,
        _panelCapable: true,
        _resolvedTrigger: 'ssh',
        _agentDeployed: true,
        _mode: 'agent',
      });

      service.reconfigure({
        sftpConfig: { host: 'new', port: 2222, username: 'new-user', password: nextCredentialFixture },
        savePath: '/new/SaveList/Default/Save_DedicatedSaveMP.sav',
        clanSavePath: '/new/Save_ClanData.sav',
        agentIdMapPath: '/new/PlayerIDMapped.txt',
      });

      assert.deepEqual((service as any)._sftpConfig, {
        host: 'new',
        port: 2222,
        username: 'new-user',
        password: nextCredentialFixture,
      });
      assert.equal((service as any)._savePath, '/new/SaveList/Default/Save_DedicatedSaveMP.sav');
      assert.equal((service as any)._clanSavePath, '/new/Save_ClanData.sav');
      assert.equal((service as any)._agentIdMapPath, '/new/PlayerIDMapped.txt');
      assert.equal((service as any)._lastMtime, null);
      assert.equal((service as any)._lastClanMtime, null);
      assert.equal((service as any)._lastCacheMtime, null);
      assert.equal((service as any)._agentCapable, null);
      assert.equal((service as any)._panelCapable, null);
      assert.equal((service as any)._resolvedTrigger, null);
      assert.equal((service as any)._agentDeployed, false);
      assert.equal((service as any)._mode, null);
      assert.equal((service as any)._agentPath, '/new/SaveList/Default/humanitz-agent.js');
      assert.equal((service as any)._cachePath, '/new/SaveList/Default/humanitz-cache.json');
      assert.equal((service as any)._runScriptPath, '');
      assert.deepEqual(spy.scheduled, []);
    });
  });

  it('updates Agent source fields and resets source-derived runtime state', async () => {
    await withIntervalSpy((spy) => {
      const service = makeSaveService(90_000);

      Object.assign(service as any, {
        _savePath: '/old/SaveList/Default/Save_DedicatedSaveMP.sav',
        _agentMode: 'auto',
        _agentNodePath: 'node',
        _agentRemoteDir: '/old/SaveList/Default',
        _agentCachePath: '',
        _agentTrigger: 'auto',
        _agentPanelCommand: 'createHZSocket',
        _lastMtime: 123,
        _lastClanMtime: 456,
        _lastCacheMtime: 789,
        _agentCapable: true,
        _panelCapable: true,
        _resolvedTrigger: 'ssh',
        _agentDeployed: true,
        _mode: 'agent',
        _agentPath: '/old/SaveList/Default/humanitz-agent.js',
        _cachePath: '/old/SaveList/Default/humanitz-cache.json',
        _runScriptPath: '/old/SaveList/Default/run-agent.sh',
      });

      service.reconfigure({
        agentMode: 'direct',
        agentNodePath: '/usr/bin/node',
        agentRemoteDir: '/new/agent',
        agentCachePath: '/new/cache.json',
        agentTrigger: 'panel',
        agentPanelCommand: 'refreshHZSocket',
        pollInterval: 300_000,
      });

      assert.equal((service as any)._agentMode, 'direct');
      assert.equal((service as any)._agentNodePath, '/usr/bin/node');
      assert.equal((service as any)._agentRemoteDir, '/new/agent');
      assert.equal((service as any)._agentCachePath, '/new/cache.json');
      assert.equal((service as any)._agentTrigger, 'panel');
      assert.equal((service as any)._agentPanelCommand, 'refreshHZSocket');
      assert.equal((service as any)._pollInterval, 300_000);
      assert.equal((service as any)._lastMtime, null);
      assert.equal((service as any)._lastClanMtime, null);
      assert.equal((service as any)._lastCacheMtime, null);
      assert.equal((service as any)._agentCapable, null);
      assert.equal((service as any)._panelCapable, null);
      assert.equal((service as any)._resolvedTrigger, null);
      assert.equal((service as any)._agentDeployed, false);
      assert.equal((service as any)._mode, null);
      assert.equal((service as any)._agentPath, '/new/agent/humanitz-agent.js');
      assert.equal((service as any)._cachePath, '/new/cache.json');
      assert.equal((service as any)._runScriptPath, '');
      assert.deepEqual(spy.scheduled, []);
    });
  });

  it('can restore a previous Agent source snapshot with a second reconfigure call', () => {
    const service = makeSaveService(90_000);
    Object.assign(service as any, {
      _savePath: '/old/SaveList/Default/Save_DedicatedSaveMP.sav',
      _agentRemoteDir: '/old/SaveList/Default',
    });

    const previous = {
      pollInterval: 90_000,
      agentMode: 'auto',
      agentNodePath: 'node',
      agentRemoteDir: '/old/SaveList/Default',
      agentCachePath: '',
      agentTrigger: 'auto',
      agentPanelCommand: 'createHZSocket',
    };

    service.reconfigure({
      pollInterval: 300_000,
      agentMode: 'direct',
      agentNodePath: '/usr/bin/node',
      agentRemoteDir: '/new/agent',
      agentCachePath: '/new/cache.json',
      agentTrigger: 'panel',
      agentPanelCommand: 'refreshHZSocket',
    });
    service.reconfigure(previous);

    assert.equal((service as any)._pollInterval, 90_000);
    assert.equal((service as any)._agentMode, 'auto');
    assert.equal((service as any)._agentNodePath, 'node');
    assert.equal((service as any)._agentRemoteDir, '/old/SaveList/Default');
    assert.equal((service as any)._agentCachePath, '');
    assert.equal((service as any)._agentTrigger, 'auto');
    assert.equal((service as any)._agentPanelCommand, 'createHZSocket');
    assert.equal((service as any)._agentPath, '/old/SaveList/Default/humanitz-agent.js');
    assert.equal((service as any)._cachePath, '/old/SaveList/Default/humanitz-cache.json');
  });

  it('surfaces invalid runtime timing values without mutating the timer', async () => {
    await withIntervalSpy(async (spy) => {
      const service = makeSaveService(60_000);
      await service.start();

      assert.throws(() => {
        service.reconfigure({ pollInterval: Number.NaN });
      }, /pollInterval must be a positive finite number/);
      assert.equal(spy.scheduled.length, 1);
      assert.deepEqual(spy.cleared, []);
      assert.equal((service as any)._pollInterval, 60_000);

      service.stop();
    });
  });
});

describe('SaveService runtime polling helpers', () => {
  it('treats direct agent mode and local paths as direct save polling', () => {
    assert.equal(isDirectSavePolling({ agentMode: 'direct' }), true);
    assert.equal(isDirectSavePolling({ agentMode: 'auto', localPath: '/tmp/save.sav' }), true);
    assert.equal(isDirectSavePolling({ agentMode: 'agent', localPath: '' }), false);
  });

  it('uses AGENT_POLL_INTERVAL for normal agent/cache mode and never falls back to SAVE_POLL_INTERVAL', () => {
    assert.equal(
      resolveSaveServicePollInterval({
        agentMode: 'auto',
        savePollInterval: 300_000,
        agentPollInterval: 90_000,
      }),
      90_000,
    );

    assert.equal(
      resolveSaveServicePollInterval({
        agentMode: 'agent',
        savePollInterval: 300_000,
        agentPollInterval: 0,
      }),
      30_000,
    );
  });

  it('uses SAVE_POLL_INTERVAL only for direct/local diagnostic polling', () => {
    assert.equal(
      resolveSaveServicePollInterval({
        agentMode: 'direct',
        savePollInterval: 120_000,
        agentPollInterval: 30_000,
      }),
      120_000,
    );
    assert.equal(
      resolveSaveServicePollInterval({
        agentMode: 'auto',
        localPath: '/tmp/save.sav',
        savePollInterval: 45_000,
        agentPollInterval: 90_000,
      }),
      60_000,
    );
  });

  it('surfaces non-finite poll intervals', () => {
    assert.throws(
      () =>
        resolveSaveServicePollInterval({
          agentMode: 'auto',
          savePollInterval: 300_000,
          agentPollInterval: Number.POSITIVE_INFINITY,
        }),
      /AGENT_POLL_INTERVAL must be a finite number/,
    );
  });
});

describe('SaveService runtime handler registration', () => {
  it('registers real handlers for SaveService runtime timing keys', () => {
    const applier = new RuntimeConfigApplier();
    const config = {
      agentMode: 'auto',
      savePollInterval: 300_000,
      agentPollInterval: 90_000,
      agentTimeout: 120_000,
      agentPanelDelay: 3_000,
    };
    const calls: unknown[] = [];

    registerSaveServiceRuntimeHandlers({
      runtimeConfigApplier: applier,
      saveService: {
        reconfigure(options) {
          calls.push(options);
        },
      },
      getConfig: () => config,
    });

    assert.equal(applier.hasModuleReconfigure('SAVE_POLL_INTERVAL'), true);
    assert.equal(applier.hasModuleReconfigure('AGENT_POLL_INTERVAL'), true);
    assert.equal(applier.hasModuleReconfigure('AGENT_TIMEOUT'), true);
    assert.equal(applier.hasModuleReconfigure('AGENT_PANEL_DELAY'), true);
  });

  it('unregisters SaveService runtime timing handlers during cleanup', () => {
    const applier = new RuntimeConfigApplier();
    const config = {
      agentMode: 'auto',
      savePollInterval: 300_000,
      agentPollInterval: 90_000,
      agentTimeout: 120_000,
      agentPanelDelay: 3_000,
    };

    const unregister = registerSaveServiceRuntimeHandlers({
      runtimeConfigApplier: applier,
      saveService: {
        reconfigure() {},
      },
      getConfig: () => config,
    });

    unregister();

    assert.equal(applier.hasModuleReconfigure('SAVE_POLL_INTERVAL'), false);
    assert.equal(applier.hasModuleReconfigure('AGENT_POLL_INTERVAL'), false);
    assert.equal(applier.hasModuleReconfigure('AGENT_TIMEOUT'), false);
    assert.equal(applier.hasModuleReconfigure('AGENT_PANEL_DELAY'), false);
  });

  it('registers SaveService handlers with owner-scoped lifecycle cleanup', async () => {
    const applier = new RuntimeConfigApplier();
    const config = {
      agentMode: 'auto',
      savePollInterval: 300_000,
      agentPollInterval: 90_000,
      agentTimeout: 120_000,
      agentPanelDelay: 3_000,
    };

    registerSaveServiceRuntimeHandlers({
      runtimeConfigApplier: applier,
      saveService: {
        reconfigure() {},
      },
      getConfig: () => config,
    });

    await applier.cleanupOwner('save-service-runtime');

    assert.equal(applier.hasModuleReconfigure('SAVE_POLL_INTERVAL'), false);
    assert.equal(applier.hasModuleReconfigure('AGENT_POLL_INTERVAL'), false);
    assert.equal(applier.hasModuleReconfigure('AGENT_TIMEOUT'), false);
    assert.equal(applier.hasModuleReconfigure('AGENT_PANEL_DELAY'), false);
  });

  it('applies SAVE_POLL_INTERVAL in normal mode without changing the agent/cache cadence', () => {
    const applier = new RuntimeConfigApplier();
    const config = {
      agentMode: 'auto',
      savePollInterval: 300_000,
      agentPollInterval: 90_000,
      agentTimeout: 120_000,
      agentPanelDelay: 3_000,
    };
    const calls: unknown[] = [];

    registerSaveServiceRuntimeHandlers({
      runtimeConfigApplier: applier,
      saveService: {
        reconfigure(options) {
          calls.push(options);
        },
      },
      getConfig: () => config,
    });

    assert.equal(
      applier.applyModuleReconfigure({ envKey: 'SAVE_POLL_INTERVAL', cfgKey: 'savePollInterval', value: 120_000 }),
      true,
    );

    assert.equal(config.savePollInterval, 120_000);
    assert.deepEqual(calls, [{ pollInterval: 90_000 }]);
  });

  it('clamps AGENT_POLL_INTERVAL below the minimum instead of falling back to SAVE_POLL_INTERVAL', () => {
    const applier = new RuntimeConfigApplier();
    const config = {
      agentMode: 'auto',
      savePollInterval: 300_000,
      agentPollInterval: 90_000,
      agentTimeout: 120_000,
      agentPanelDelay: 3_000,
    };
    const calls: unknown[] = [];

    registerSaveServiceRuntimeHandlers({
      runtimeConfigApplier: applier,
      saveService: {
        reconfigure(options) {
          calls.push(options);
        },
      },
      getConfig: () => config,
    });

    assert.equal(
      applier.applyModuleReconfigure({ envKey: 'AGENT_POLL_INTERVAL', cfgKey: 'agentPollInterval', value: 0 }),
      true,
    );

    assert.equal(config.agentPollInterval, 30_000);
    assert.deepEqual(calls, [{ pollInterval: 30_000 }]);
  });

  it('updates direct/local diagnostic cadence from SAVE_POLL_INTERVAL', () => {
    const applier = new RuntimeConfigApplier();
    const config = {
      agentMode: 'direct',
      savePollInterval: 60_000,
      agentPollInterval: 90_000,
      agentTimeout: 120_000,
      agentPanelDelay: 3_000,
    };
    const calls: unknown[] = [];

    registerSaveServiceRuntimeHandlers({
      runtimeConfigApplier: applier,
      saveService: {
        reconfigure(options) {
          calls.push(options);
        },
      },
      getConfig: () => config,
    });

    assert.equal(
      applier.applyModuleReconfigure({ envKey: 'SAVE_POLL_INTERVAL', cfgKey: 'savePollInterval', value: 120_000 }),
      true,
    );

    assert.deepEqual(calls, [{ pollInterval: 120_000 }]);
  });

  it('preserves config localPath when no explicit localPath callback is supplied', () => {
    const applier = new RuntimeConfigApplier();
    const config = {
      agentMode: 'auto',
      localPath: '/tmp/save.sav',
      savePollInterval: 120_000,
      agentPollInterval: 90_000,
      agentTimeout: 120_000,
      agentPanelDelay: 3_000,
    };
    const calls: unknown[] = [];

    registerSaveServiceRuntimeHandlers({
      runtimeConfigApplier: applier,
      saveService: {
        reconfigure(options) {
          calls.push(options);
        },
      },
      getConfig: () => config,
    });

    assert.equal(
      applier.applyModuleReconfigure({ envKey: 'AGENT_POLL_INTERVAL', cfgKey: 'agentPollInterval', value: 30_000 }),
      true,
    );

    assert.deepEqual(calls, [{ pollInterval: 120_000 }]);
  });

  it('updates agent timeout and panel delay without touching the poll timer', () => {
    const applier = new RuntimeConfigApplier();
    const config = {
      agentMode: 'auto',
      savePollInterval: 300_000,
      agentPollInterval: 90_000,
      agentTimeout: 120_000,
      agentPanelDelay: 3_000,
    };
    const calls: unknown[] = [];

    registerSaveServiceRuntimeHandlers({
      runtimeConfigApplier: applier,
      saveService: {
        reconfigure(options) {
          calls.push(options);
        },
      },
      getConfig: () => config,
    });

    assert.equal(
      applier.applyModuleReconfigure({ envKey: 'AGENT_TIMEOUT', cfgKey: 'agentTimeout', value: 5_000 }),
      true,
    );
    assert.equal(
      applier.applyModuleReconfigure({ envKey: 'AGENT_PANEL_DELAY', cfgKey: 'agentPanelDelay', value: 100 }),
      true,
    );

    assert.equal(config.agentTimeout, 10_000);
    assert.equal(config.agentPanelDelay, 500);
    assert.deepEqual(calls, [{ agentTimeout: 10_000 }, { agentPanelDelay: 500 }]);
  });

  it('surfaces invalid handler timing values before mutating runtime config', () => {
    const applier = new RuntimeConfigApplier();
    const config = {
      agentMode: 'auto',
      savePollInterval: 300_000,
      agentPollInterval: 90_000,
      agentTimeout: 120_000,
      agentPanelDelay: 3_000,
    };
    const calls: unknown[] = [];

    registerSaveServiceRuntimeHandlers({
      runtimeConfigApplier: applier,
      saveService: {
        reconfigure(options) {
          calls.push(options);
        },
      },
      getConfig: () => config,
    });

    assert.throws(
      () => applier.applyModuleReconfigure({ envKey: 'AGENT_TIMEOUT', cfgKey: 'agentTimeout', value: 'nope' }),
      /AGENT_TIMEOUT must be a finite number/,
    );
    assert.equal(config.agentTimeout, 120_000);
    assert.deepEqual(calls, []);
  });
});

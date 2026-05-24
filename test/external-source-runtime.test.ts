import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import RuntimeConfigApplier from '../src/config/runtime-config-applier.js';
import {
  registerExternalSourceRuntimeHandlers,
  type AgentSourceRuntimeReconfigureOptions,
  type HzmodSourceRuntimeSnapshot,
} from '../src/config/external-source-runtime.js';
import { summarizeConfigReloadApplyAsync } from '../src/config/reload-strategy.js';

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    agentMode: 'auto',
    agentTrigger: 'auto',
    agentNodePath: 'node',
    agentRemoteDir: '/old/save',
    agentCachePath: '/old/cache.json',
    agentPanelCommand: 'createHZSocket',
    savePollInterval: 300_000,
    agentPollInterval: 90_000,
    hzmodServerId: 'vps_dev',
    hzmodSocketPath: '/old/hzmod.sock',
    hzmodStatusPath: '/old/status.json',
    ...overrides,
  };
}

function registerWithFakes(
  options: {
    config?: Record<string, unknown>;
    saveService?: { reconfigure(options: AgentSourceRuntimeReconfigureOptions): void } | null;
    reconfigureHzmod?: (next: HzmodSourceRuntimeSnapshot, previous: HzmodSourceRuntimeSnapshot) => void | Promise<void>;
  } = {},
) {
  const applier = new RuntimeConfigApplier();
  const config = options.config ?? makeConfig();

  registerExternalSourceRuntimeHandlers({
    runtimeConfigApplier: applier,
    config,
    getSaveService: () => options.saveService,
    reconfigureHzmod: options.reconfigureHzmod,
  });

  return { applier, config };
}

describe('external source runtime handlers', () => {
  it('applies Agent source keys as one batch after SaveService accepts the next snapshot', async () => {
    const calls: AgentSourceRuntimeReconfigureOptions[] = [];
    const { applier, config } = registerWithFakes({
      saveService: {
        reconfigure(options) {
          calls.push(options);
          assert.equal(config.agentMode, 'auto', 'runtime config mutates only after SaveService succeeds');
        },
      },
    });

    const result = await applier.applyConnectionReconnectBatch([
      { envKey: 'AGENT_MODE', cfgKey: 'agentMode', value: 'direct' },
      { envKey: 'AGENT_TRIGGER', cfgKey: 'agentTrigger', value: 'panel' },
      { envKey: 'AGENT_NODE_PATH', cfgKey: 'agentNodePath', value: '/usr/bin/node' },
    ]);

    assert.deepEqual(result, { applied: ['AGENT_MODE', 'AGENT_TRIGGER', 'AGENT_NODE_PATH'], errors: [] });
    assert.deepEqual(calls, [
      {
        pollInterval: 300_000,
        agentMode: 'direct',
        agentTrigger: 'panel',
        agentNodePath: '/usr/bin/node',
        agentRemoteDir: '/old/save',
        agentCachePath: '/old/cache.json',
        agentPanelCommand: 'createHZSocket',
      },
    ]);
    assert.equal(config.agentMode, 'direct');
    assert.equal(config.agentTrigger, 'panel');
    assert.equal(config.agentNodePath, '/usr/bin/node');
  });

  it('recalculates Agent poll interval from the active source mode', async () => {
    const calls: AgentSourceRuntimeReconfigureOptions[] = [];
    const { applier } = registerWithFakes({
      saveService: { reconfigure: (options) => calls.push(options) },
    });

    await applier.applyConnectionReconnectBatch([{ envKey: 'AGENT_MODE', cfgKey: 'agentMode', value: 'agent' }]);
    await applier.applyConnectionReconnectBatch([{ envKey: 'AGENT_MODE', cfgKey: 'agentMode', value: 'direct' }]);

    assert.equal(calls[0]?.pollInterval, 90_000);
    assert.equal(calls[1]?.pollInterval, 300_000);
  });

  it('normalizes Agent source defaults before mutating runtime config', async () => {
    const calls: AgentSourceRuntimeReconfigureOptions[] = [];
    const { applier, config } = registerWithFakes({
      saveService: { reconfigure: (options) => calls.push(options) },
    });

    const result = await applier.applyConnectionReconnectBatch([
      { envKey: 'AGENT_MODE', cfgKey: 'agentMode', value: 'DIRECT' },
      { envKey: 'AGENT_TRIGGER', cfgKey: 'agentTrigger', value: 'PANEL' },
      { envKey: 'AGENT_NODE_PATH', cfgKey: 'agentNodePath', value: '' },
    ]);

    assert.deepEqual(result.errors, []);
    const firstCall = calls[0];
    assert.ok(firstCall);
    assert.equal(firstCall.agentMode, 'direct');
    assert.equal(firstCall.agentTrigger, 'panel');
    assert.equal(firstCall.agentNodePath, 'node');
    assert.equal(config.agentMode, 'direct');
    assert.equal(config.agentTrigger, 'panel');
    assert.equal(config.agentNodePath, 'node');
  });

  it('rolls Agent source runtime back when SaveService reconfigure fails after partial mutation', async () => {
    const active = {
      agentMode: 'auto',
      agentTrigger: 'auto',
      agentNodePath: 'node',
      agentRemoteDir: '/old/save',
      agentCachePath: '/old/cache.json',
      agentPanelCommand: 'createHZSocket',
      pollInterval: 90_000,
      resetToken: 'old',
    };
    let callCount = 0;
    const { applier, config } = registerWithFakes({
      saveService: {
        reconfigure(options) {
          callCount++;
          Object.assign(active, options, { resetToken: callCount === 1 ? 'partial-new' : 'old' });
          if (callCount === 1) throw new Error('save source refused');
        },
      },
    });

    const result = await applier.applyConnectionReconnectBatch([
      { envKey: 'AGENT_MODE', cfgKey: 'agentMode', value: 'direct' },
      { envKey: 'AGENT_TRIGGER', cfgKey: 'agentTrigger', value: 'panel' },
    ]);

    assert.deepEqual(result.applied, []);
    assert.deepEqual(result.errors, [
      { key: 'AGENT_MODE', message: 'save source refused' },
      { key: 'AGENT_TRIGGER', message: 'save source refused' },
    ]);
    assert.equal(config.agentMode, 'auto');
    assert.equal(config.agentTrigger, 'auto');
    assert.deepEqual(active, {
      agentMode: 'auto',
      agentTrigger: 'auto',
      agentNodePath: 'node',
      agentRemoteDir: '/old/save',
      agentCachePath: '/old/cache.json',
      agentPanelCommand: 'createHZSocket',
      pollInterval: 90_000,
      resetToken: 'old',
    });
  });

  it('applies Agent advanced source keys through module reconfigure', () => {
    const calls: AgentSourceRuntimeReconfigureOptions[] = [];
    const { applier, config } = registerWithFakes({
      saveService: { reconfigure: (options) => calls.push(options) },
    });

    assert.equal(
      applier.applyModuleReconfigure({
        envKey: 'AGENT_REMOTE_DIR',
        cfgKey: 'agentRemoteDir',
        value: '/new/save',
      }),
      true,
    );
    assert.equal(
      applier.applyModuleReconfigure({
        envKey: 'AGENT_CACHE_PATH',
        cfgKey: 'agentCachePath',
        value: '/new/cache.json',
      }),
      true,
    );
    assert.equal(
      applier.applyModuleReconfigure({
        envKey: 'AGENT_PANEL_COMMAND',
        cfgKey: 'agentPanelCommand',
        value: 'refreshHZSocket',
      }),
      true,
    );

    assert.equal(config.agentRemoteDir, '/new/save');
    assert.equal(config.agentCachePath, '/new/cache.json');
    assert.equal(config.agentPanelCommand, 'refreshHZSocket');
    assert.equal(calls.length, 3);
    assert.equal(calls[2]?.agentPanelCommand, 'refreshHZSocket');
  });

  it('applies HZMod source keys as one batch after the optional rebind callback succeeds', async () => {
    const rebinds: Array<{ next: HzmodSourceRuntimeSnapshot; previous: HzmodSourceRuntimeSnapshot }> = [];
    const { applier, config } = registerWithFakes({
      reconfigureHzmod(next, previous) {
        rebinds.push({ next, previous });
        assert.equal(config.hzmodSocketPath, '/old/hzmod.sock', 'config mutates after callback success');
      },
    });

    const result = await applier.applyConnectionReconnectBatch([
      { envKey: 'HZMOD_SERVER_ID', cfgKey: 'hzmodServerId', value: 'vps_live' },
      { envKey: 'HZMOD_SOCKET_PATH', cfgKey: 'hzmodSocketPath', value: '/new/hzmod.sock' },
      { envKey: 'HZMOD_STATUS_PATH', cfgKey: 'hzmodStatusPath', value: '/new/status.json' },
    ]);

    assert.deepEqual(result, {
      applied: ['HZMOD_SERVER_ID', 'HZMOD_SOCKET_PATH', 'HZMOD_STATUS_PATH'],
      errors: [],
    });
    assert.deepEqual(rebinds, [
      {
        previous: {
          hzmodServerId: 'vps_dev',
          hzmodSocketPath: '/old/hzmod.sock',
          hzmodStatusPath: '/old/status.json',
        },
        next: {
          hzmodServerId: 'vps_live',
          hzmodSocketPath: '/new/hzmod.sock',
          hzmodStatusPath: '/new/status.json',
        },
      },
    ]);
    assert.equal(config.hzmodServerId, 'vps_live');
    assert.equal(config.hzmodSocketPath, '/new/hzmod.sock');
    assert.equal(config.hzmodStatusPath, '/new/status.json');
  });

  it('keeps HZMod runtime config unchanged when the optional rebind callback fails', async () => {
    const { applier, config } = registerWithFakes({
      reconfigureHzmod() {
        throw new Error('ipc refused');
      },
    });

    const result = await applier.applyConnectionReconnectBatch([
      { envKey: 'HZMOD_SOCKET_PATH', cfgKey: 'hzmodSocketPath', value: '/bad/hzmod.sock' },
      { envKey: 'HZMOD_STATUS_PATH', cfgKey: 'hzmodStatusPath', value: '/bad/status.json' },
    ]);

    assert.deepEqual(result.applied, []);
    assert.deepEqual(result.errors, [
      { key: 'HZMOD_SOCKET_PATH', message: 'ipc refused' },
      { key: 'HZMOD_STATUS_PATH', message: 'ipc refused' },
    ]);
    assert.equal(config.hzmodSocketPath, '/old/hzmod.sock');
    assert.equal(config.hzmodStatusPath, '/old/status.json');
  });

  it('leaves unrelated connection keys pending when no PR8 owner is registered', async () => {
    const { applier } = registerWithFakes();

    const result = await summarizeConfigReloadApplyAsync(['HZMOD_SOCKET_PATH', 'PUBLIC_HOST'], {
      categories: [
        {
          reloadStrategy: 'connection-reconnect',
          fields: [{ env: 'HZMOD_SOCKET_PATH' }, { env: 'PUBLIC_HOST' }],
        },
      ],
      applyConnectionReconnectBatch: async (envKeys) => {
        const contexts = envKeys.map((envKey) => ({
          envKey,
          cfgKey: envKey === 'HZMOD_SOCKET_PATH' ? 'hzmodSocketPath' : 'publicHost',
          value: 'next',
        }));
        return applier.applyConnectionReconnectBatch(contexts);
      },
    });

    assert.deepEqual(result.appliedReconnect, ['HZMOD_SOCKET_PATH']);
    assert.deepEqual(result.pendingReconnect, ['PUBLIC_HOST']);
  });
});

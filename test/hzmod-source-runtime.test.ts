import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  createHzmodIpc,
  reconfigureHzmodRuntimeState,
  type HzmodIpcClientInstance,
} from '../src/config/hzmod-source-runtime.js';
import type { HzmodSourceRuntimeSnapshot } from '../src/config/external-source-runtime.js';

const quietLogger = { log() {}, error() {} };

class FakeIpc implements HzmodIpcClientInstance {
  static instances: FakeIpc[] = [];

  readonly events: string[];
  readonly socketPath: string;
  destroyed = false;
  connected = false;
  handlers: Record<string, Array<(...args: unknown[]) => void>> = {};

  constructor(socketPath: string) {
    this.socketPath = socketPath;
    this.events = [];
    FakeIpc.instances.push(this);
  }

  connect(): void {
    this.events.push(`connect:${this.socketPath}`);
    this.connected = true;
  }

  destroy(): void {
    this.events.push(`destroy:${this.socketPath}`);
    this.destroyed = true;
  }

  on(event: string, handler: (...args: unknown[]) => void): void {
    this.handlers[event] = [...(this.handlers[event] ?? []), handler];
  }
}

function snapshots(overrides: Partial<HzmodSourceRuntimeSnapshot> = {}) {
  const previous: HzmodSourceRuntimeSnapshot = {
    hzmodServerId: 'old-server',
    hzmodSocketPath: '/old/hzmod.sock',
    hzmodStatusPath: '/old/status.json',
  };
  const next: HzmodSourceRuntimeSnapshot = {
    hzmodServerId: 'new-server',
    hzmodSocketPath: '/new/hzmod.sock',
    hzmodStatusPath: '/new/status.json',
    ...overrides,
  };
  return { previous, next };
}

function makePluginHost(plugin: Record<string, unknown>, options: { fail?: boolean } = {}) {
  return {
    reconfigurePlugin(name: string, patch: Record<string, unknown>) {
      assert.equal(name, 'hzmod');
      if (options.fail) throw new Error('plugin refused');

      const previous = Object.fromEntries(
        Object.keys(patch).map((key) => [key, { had: Object.hasOwn(plugin, key), value: plugin[key] }]),
      ) as Record<string, { had: boolean; value: unknown }>;
      Object.assign(plugin, patch);

      return () => {
        for (const [key, old] of Object.entries(previous)) {
          if (old.had) plugin[key] = old.value;
          else Reflect.deleteProperty(plugin, key);
        }
      };
    },
  };
}

describe('HZMod source runtime helpers', () => {
  it('connects the candidate IPC before swapping plugin metadata and destroying the old IPC', () => {
    FakeIpc.instances = [];
    const oldIpc = new FakeIpc('/old/hzmod.sock');
    const state = { ipc: oldIpc as HzmodIpcClientInstance | undefined };
    const plugin: Record<string, unknown> = {
      name: 'hzmod',
      serverId: 'old-server',
      statusPath: '/old/status.json',
      ipc: oldIpc,
    };
    const { previous, next } = snapshots();

    reconfigureHzmodRuntimeState(state, next, previous, {
      getIpcClientConstructor: () => FakeIpc,
      getWebMapServer: () => makePluginHost(plugin),
      logger: quietLogger,
    });

    const newIpc = FakeIpc.instances.find((ipc) => ipc.socketPath === '/new/hzmod.sock');
    assert.ok(newIpc);
    assert.equal(newIpc.connected, true);
    assert.equal(oldIpc.destroyed, true);
    assert.equal(state.ipc, newIpc);
    assert.equal(plugin.serverId, 'new-server');
    assert.equal(plugin.statusPath, '/new/status.json');
    assert.equal(plugin.ipc, newIpc);
  });

  it('destroys a candidate IPC and keeps the old runtime when plugin reconfigure fails', () => {
    FakeIpc.instances = [];
    const oldIpc = new FakeIpc('/old/hzmod.sock');
    const state = { ipc: oldIpc as HzmodIpcClientInstance | undefined };
    const plugin: Record<string, unknown> = { name: 'hzmod', serverId: 'old-server', ipc: oldIpc };
    const { previous, next } = snapshots();

    assert.throws(() => {
      reconfigureHzmodRuntimeState(state, next, previous, {
        getIpcClientConstructor: () => FakeIpc,
        getWebMapServer: () => makePluginHost(plugin, { fail: true }),
        logger: quietLogger,
      });
    }, /plugin refused/);

    const newIpc = FakeIpc.instances.find((ipc) => ipc.socketPath === '/new/hzmod.sock');
    assert.ok(newIpc);
    assert.equal(newIpc.destroyed, true);
    assert.equal(oldIpc.destroyed, false);
    assert.equal(state.ipc, oldIpc);
    assert.equal(plugin.serverId, 'old-server');
    assert.equal(plugin.ipc, oldIpc);
  });

  it('destroys a candidate IPC when connect throws before returning it', () => {
    class RefusingIpc extends FakeIpc {
      override connect(): void {
        super.connect();
        throw new Error('connect refused');
      }
    }

    FakeIpc.instances = [];

    assert.throws(() => createHzmodIpc('/bad/hzmod.sock', RefusingIpc, quietLogger), /connect refused/);

    const candidate = FakeIpc.instances.find((ipc) => ipc.socketPath === '/bad/hzmod.sock');
    assert.ok(candidate);
    assert.equal(candidate.destroyed, true);
  });
});

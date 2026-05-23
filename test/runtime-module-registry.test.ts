import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import RuntimeModuleRegistry from '../src/config/runtime-module-registry.js';

type Listener = (...args: unknown[]) => void;

class FakeEmitter {
  readonly added: Array<{ event: string | symbol; listener: Listener }> = [];
  readonly removed: Array<{ event: string | symbol; listener: Listener }> = [];

  on(event: string | symbol, listener: Listener): void {
    this.added.push({ event, listener });
  }

  removeListener(event: string | symbol, listener: Listener): void {
    this.removed.push({ event, listener });
  }
}

function aggregateErrors(err: unknown): unknown[] {
  assert.ok(err instanceof AggregateError);
  return Array.from(err.errors as Iterable<unknown>);
}

function listenerRegistrationOwners(registry: RuntimeModuleRegistry): Map<string, unknown> {
  const value = Reflect.get(registry, '_listenerRegistrations');
  assert.ok(value instanceof Map);
  return value as Map<string, unknown>;
}

describe('RuntimeModuleRegistry', () => {
  it('starts registered modules idempotently', async () => {
    const registry = new RuntimeModuleRegistry();
    let startCalls = 0;

    registry.registerModule('status', {
      start() {
        startCalls += 1;
      },
    });

    await registry.start('status');
    await registry.start('status');

    assert.equal(startCalls, 1);
    assert.equal(registry.isRunning('status'), true);
    assert.equal(registry.hasModule('status'), true);
  });

  it('runs owner cleanup before module stop and stops idempotently', async () => {
    const registry = new RuntimeModuleRegistry();
    const events: string[] = [];
    let stopCalls = 0;

    registry.registerModule('chat-relay', {
      stop() {
        stopCalls += 1;
        events.push('module-stop');
      },
    });
    registry.trackCleanup('chat-relay', () => {
      events.push('cleanup');
    });

    await registry.start('chat-relay');
    await registry.stop('chat-relay');
    await registry.stop('chat-relay');

    assert.deepEqual(events, ['cleanup', 'module-stop']);
    assert.equal(stopCalls, 1);
    assert.equal(registry.isRunning('chat-relay'), false);
  });

  it('cleans remaining resources and surfaces every teardown failure', async () => {
    const registry = new RuntimeModuleRegistry();
    const events: string[] = [];

    registry.registerModule('log-watcher', {
      stop() {
        events.push('module-stop');
        throw new Error('module stop refused');
      },
    });
    registry.trackCleanup('log-watcher', () => {
      events.push('cleanup-a');
      throw new Error('cleanup a refused');
    });
    registry.trackCleanup('log-watcher', () => {
      events.push('cleanup-b');
      throw new Error('cleanup b refused');
    });

    await registry.start('log-watcher');

    let thrown: unknown;
    try {
      await registry.stop('log-watcher');
    } catch (err) {
      thrown = err;
    }

    assert.deepEqual(events, ['cleanup-b', 'cleanup-a', 'module-stop']);
    assert.deepEqual(
      aggregateErrors(thrown).map((err) => (err instanceof Error ? err.message : String(err))),
      ['cleanup b refused', 'cleanup a refused', 'module stop refused'],
    );
  });

  it('tracks timer ownership and clears timers once', async () => {
    const registry = new RuntimeModuleRegistry();
    const timer = { id: 1 };
    const cleared: unknown[] = [];

    registry.trackTimer('save-service', timer, (timerToClear) => {
      cleared.push(timerToClear);
    });

    await registry.cleanupOwner('save-service');
    await registry.cleanupOwner('save-service');

    assert.deepEqual(cleared, [timer]);
  });

  it('dedupes listener ownership for the same owner, emitter, event, and listener', async () => {
    const registry = new RuntimeModuleRegistry();
    const emitter = new FakeEmitter();
    const listener = () => {};

    registry.trackListener('chat-relay', emitter, 'messageCreate', listener);
    registry.trackListener('chat-relay', emitter, 'messageCreate', listener);

    assert.equal(emitter.added.length, 1);

    await registry.cleanupOwner('chat-relay');
    await registry.cleanupOwner('chat-relay');

    assert.deepEqual(emitter.removed, [{ event: 'messageCreate', listener }]);
  });

  it('keeps listener ownership separate by emitter identity', async () => {
    const registry = new RuntimeModuleRegistry();
    const firstEmitter = new FakeEmitter();
    const secondEmitter = new FakeEmitter();
    const listener = () => {};

    registry.trackListener('chat-relay', firstEmitter, 'messageCreate', listener);
    registry.trackListener('chat-relay', secondEmitter, 'messageCreate', listener);

    assert.equal(firstEmitter.added.length, 1);
    assert.equal(secondEmitter.added.length, 1);

    await registry.cleanupOwner('chat-relay');

    assert.deepEqual(firstEmitter.removed, [{ event: 'messageCreate', listener }]);
    assert.deepEqual(secondEmitter.removed, [{ event: 'messageCreate', listener }]);
  });

  it('keeps listener ownership separate by owner', async () => {
    const registry = new RuntimeModuleRegistry();
    const emitter = new FakeEmitter();
    const listener = () => {};

    registry.trackListener('chat-relay', emitter, 'messageCreate', listener);
    registry.trackListener('audit', emitter, 'messageCreate', listener);

    assert.equal(emitter.added.length, 2);

    await registry.cleanupOwner('chat-relay');

    assert.deepEqual(emitter.removed, [{ event: 'messageCreate', listener }]);
  });

  it('clears listener bookkeeping even when the cleanup stack is already empty', async () => {
    const registry = new RuntimeModuleRegistry();
    const emitter = new FakeEmitter();
    const listener = () => {};

    const unregister = registry.trackListener('chat-relay', emitter, 'messageCreate', listener);
    assert.equal(listenerRegistrationOwners(registry).has('chat-relay'), true);

    unregister();
    await registry.cleanupOwner('chat-relay');

    assert.equal(listenerRegistrationOwners(registry).has('chat-relay'), false);
  });

  it('restores tracked callbacks to the previous callback', async () => {
    const registry = new RuntimeModuleRegistry();
    const previous = () => 'previous';
    const next = () => 'next';
    let current: (() => string) | null = previous;

    registry.trackCallback(
      'log-watcher',
      (callback) => {
        current = callback;
      },
      next,
      previous,
    );

    assert.equal(current, next);

    await registry.cleanupOwner('log-watcher');

    assert.equal(current, previous);
  });

  it('clears tracked callbacks when no previous callback exists', async () => {
    const registry = new RuntimeModuleRegistry();
    const next = () => 'next';
    let current: (() => string) | null = null;

    registry.trackCallback(
      'log-watcher',
      (callback) => {
        current = callback;
      },
      next,
    );

    assert.equal(current, next);

    await registry.cleanupOwner('log-watcher');

    assert.equal(current, null);
  });

  it('cleans an owner without requiring a registered module', async () => {
    const registry = new RuntimeModuleRegistry();
    const events: string[] = [];

    registry.trackCleanup('runtime-config', () => {
      events.push('cleanup');
    });

    await registry.cleanupOwner('runtime-config');

    assert.deepEqual(events, ['cleanup']);
  });
});

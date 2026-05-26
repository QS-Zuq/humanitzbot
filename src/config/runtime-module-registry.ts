export type RuntimeCleanup = () => void | Promise<void>;

export interface RuntimeModule {
  start?: () => void | Promise<void>;
  stop?: () => void | Promise<void>;
}

export interface RuntimeEventEmitter {
  on(event: string | symbol, listener: (...args: unknown[]) => void): unknown;
  removeListener(event: string | symbol, listener: (...args: unknown[]) => void): unknown;
}

interface RuntimeModuleEntry {
  module: RuntimeModule;
  running: boolean;
}

interface RuntimeCleanupEntry {
  cleanup: RuntimeCleanup;
  active: boolean;
}

function requireOwnerId(ownerId: string): void {
  if (!ownerId) throw new Error('ownerId is required');
}

function toErrorList(error: unknown): unknown[] {
  if (error instanceof AggregateError) {
    return Array.from(error.errors as Iterable<unknown>);
  }

  return [error];
}

function throwAggregateError(message: string, errors: unknown[]): void {
  if (errors.length === 0) return;
  throw new AggregateError(errors, message);
}

class RuntimeModuleRegistry {
  private readonly _modules = new Map<string, RuntimeModuleEntry>();
  private readonly _ownerCleanups = new Map<string, RuntimeCleanupEntry[]>();
  private readonly _listenerRegistrations = new Map<
    string,
    WeakMap<RuntimeEventEmitter, Map<string | symbol, Set<(...args: unknown[]) => void>>>
  >();

  registerModule(id: string, module: RuntimeModule): void {
    requireOwnerId(id);
    if (this._modules.has(id)) throw new Error(`Runtime module already registered: ${id}`);
    this._modules.set(id, { module, running: false });
  }

  hasModule(id: string): boolean {
    return this._modules.has(id);
  }

  getModule(id: string): RuntimeModule | undefined {
    return this._modules.get(id)?.module;
  }

  isRunning(id: string): boolean {
    return this._modules.get(id)?.running === true;
  }

  async start(id: string): Promise<void> {
    const entry = this._modules.get(id);
    if (!entry) throw new Error(`Runtime module not registered: ${id}`);
    if (entry.running) return;

    await entry.module.start?.();
    entry.running = true;
  }

  async stop(id: string): Promise<void> {
    const entry = this._modules.get(id);
    const wasRunning = entry?.running === true;
    const errors: unknown[] = [];

    try {
      await this.cleanupOwner(id);
    } catch (err) {
      errors.push(...toErrorList(err));
    }

    if (entry && wasRunning) {
      entry.running = false;
      try {
        await entry.module.stop?.();
      } catch (err) {
        errors.push(err);
      }
    }

    throwAggregateError(`Runtime module "${id}" stop failed`, errors);
  }

  trackCleanup(ownerId: string, cleanup: RuntimeCleanup): () => void {
    requireOwnerId(ownerId);

    const entry: RuntimeCleanupEntry = { cleanup, active: true };
    const stack = this._getCleanupStack(ownerId);
    stack.push(entry);

    return () => {
      if (!entry.active) return;
      entry.active = false;
      const index = stack.indexOf(entry);
      if (index >= 0) stack.splice(index, 1);
      if (stack.length === 0) this._ownerCleanups.delete(ownerId);
    };
  }

  trackTimer<TTimer>(
    ownerId: string,
    timer: TTimer,
    clearTimer: (timer: TTimer) => void = (timerToClear) => {
      clearInterval(timerToClear as Parameters<typeof clearInterval>[0]);
    },
  ): () => void {
    return this.trackCleanup(ownerId, () => {
      clearTimer(timer);
    });
  }

  trackListener(
    ownerId: string,
    emitter: RuntimeEventEmitter,
    event: string | symbol,
    listener: (...args: unknown[]) => void,
  ): () => void {
    requireOwnerId(ownerId);
    const listenerSet = this._getListenerSet(ownerId, emitter, event);
    if (listenerSet.has(listener)) return () => {};

    listenerSet.add(listener);
    emitter.on(event, listener);

    return this.trackCleanup(ownerId, () => {
      if (!listenerSet.has(listener)) return;
      listenerSet.delete(listener);
      emitter.removeListener(event, listener);
    });
  }

  trackCallback<TCallback extends (...args: unknown[]) => unknown>(
    ownerId: string,
    setCallback: (callback: TCallback | null) => void,
    nextCallback: TCallback | null,
    previousCallback: TCallback | null = null,
  ): () => void {
    setCallback(nextCallback);
    return this.trackCleanup(ownerId, () => {
      setCallback(previousCallback);
    });
  }

  async cleanupOwner(ownerId: string): Promise<void> {
    requireOwnerId(ownerId);

    const stack = this._ownerCleanups.get(ownerId);
    const errors: unknown[] = [];

    if (stack) {
      while (stack.length > 0) {
        const entry = stack.pop();
        if (!entry || !entry.active) continue;
        entry.active = false;

        try {
          await entry.cleanup();
        } catch (err) {
          errors.push(err);
        }
      }

      this._ownerCleanups.delete(ownerId);
    }

    this._listenerRegistrations.delete(ownerId);

    throwAggregateError(`Runtime owner "${ownerId}" cleanup failed`, errors);
  }

  private _getCleanupStack(ownerId: string): RuntimeCleanupEntry[] {
    let stack = this._ownerCleanups.get(ownerId);
    if (!stack) {
      stack = [];
      this._ownerCleanups.set(ownerId, stack);
    }
    return stack;
  }

  private _getListenerSet(
    ownerId: string,
    emitter: RuntimeEventEmitter,
    event: string | symbol,
  ): Set<(...args: unknown[]) => void> {
    let ownerMap = this._listenerRegistrations.get(ownerId);
    if (!ownerMap) {
      ownerMap = new WeakMap();
      this._listenerRegistrations.set(ownerId, ownerMap);
    }

    let emitterMap = ownerMap.get(emitter);
    if (!emitterMap) {
      emitterMap = new Map();
      ownerMap.set(emitter, emitterMap);
    }

    let listenerSet = emitterMap.get(event);
    if (!listenerSet) {
      listenerSet = new Set();
      emitterMap.set(event, listenerSet);
    }

    return listenerSet;
  }
}

export default RuntimeModuleRegistry;
export { RuntimeModuleRegistry };

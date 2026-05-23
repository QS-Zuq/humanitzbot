import RuntimeModuleRegistry from './runtime-module-registry.js';

export interface RuntimeConfigApplyContext {
  envKey: string;
  cfgKey: string;
  value: unknown;
}

export type RuntimeConfigApplyHandler = (context: RuntimeConfigApplyContext) => void;
export type RuntimeConfigApplyBatchHandler = (contexts: RuntimeConfigApplyContext[]) => void | Promise<void>;

export interface RuntimeConfigBatchApplyError {
  key: string;
  message: string;
}

export interface RuntimeConfigBatchApplyResult {
  applied: string[];
  errors: RuntimeConfigBatchApplyError[];
}

interface RuntimeConfigRegisterOptions {
  ownerId?: string;
}

interface RuntimeConfigBatchHandlerEntry {
  envKeys: Set<string>;
  handler: RuntimeConfigApplyBatchHandler;
}

function toErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'string' && err) return err;
  return 'Runtime apply failed';
}

class RuntimeConfigApplier {
  private readonly _moduleReconfigureHandlers = new Map<string, RuntimeConfigApplyHandler>();
  private readonly _connectionReconnectHandlers = new Map<string, RuntimeConfigApplyHandler>();
  private readonly _connectionReconnectBatchHandlers = new Set<RuntimeConfigBatchHandlerEntry>();
  private readonly _connectionReconnectBatchHandlersByKey = new Map<string, RuntimeConfigBatchHandlerEntry>();
  private readonly _lifecycle = new RuntimeModuleRegistry();

  registerModuleReconfigure(
    envKey: string,
    handler: RuntimeConfigApplyHandler,
    options: RuntimeConfigRegisterOptions = {},
  ): () => void {
    if (!envKey) throw new Error('envKey is required');
    this._moduleReconfigureHandlers.set(envKey, handler);

    const unregisterHandler = () => {
      if (this._moduleReconfigureHandlers.get(envKey) === handler) {
        this._moduleReconfigureHandlers.delete(envKey);
      }
    };

    if (!options.ownerId) return unregisterHandler;

    const unregisterOwnerCleanup = this._lifecycle.trackCleanup(options.ownerId, unregisterHandler);
    return () => {
      unregisterOwnerCleanup();
      unregisterHandler();
    };
  }

  hasModuleReconfigure(envKey: string): boolean {
    return this._moduleReconfigureHandlers.has(envKey);
  }

  applyModuleReconfigure(context: RuntimeConfigApplyContext): boolean {
    const handler = this._moduleReconfigureHandlers.get(context.envKey);
    if (!handler) return false;
    handler(context);
    return true;
  }

  registerConnectionReconnect(
    envKey: string,
    handler: RuntimeConfigApplyHandler,
    options: RuntimeConfigRegisterOptions = {},
  ): () => void {
    if (!envKey) throw new Error('envKey is required');
    this._connectionReconnectHandlers.set(envKey, handler);

    const unregisterHandler = () => {
      if (this._connectionReconnectHandlers.get(envKey) === handler) {
        this._connectionReconnectHandlers.delete(envKey);
      }
    };

    if (!options.ownerId) return unregisterHandler;

    const unregisterOwnerCleanup = this._lifecycle.trackCleanup(options.ownerId, unregisterHandler);
    return () => {
      unregisterOwnerCleanup();
      unregisterHandler();
    };
  }

  registerConnectionReconnectGroup(
    envKeys: string[],
    handler: RuntimeConfigApplyBatchHandler,
    options: RuntimeConfigRegisterOptions = {},
  ): () => void {
    const uniqueEnvKeys = [...new Set(envKeys)];
    if (uniqueEnvKeys.length === 0) throw new Error('envKeys are required');
    for (const envKey of uniqueEnvKeys) {
      if (!envKey) throw new Error('envKey is required');
    }

    const entry: RuntimeConfigBatchHandlerEntry = {
      envKeys: new Set(uniqueEnvKeys),
      handler,
    };
    this._connectionReconnectBatchHandlers.add(entry);
    for (const envKey of uniqueEnvKeys) {
      this._connectionReconnectBatchHandlersByKey.set(envKey, entry);
    }

    const unregisterHandler = () => {
      if (!this._connectionReconnectBatchHandlers.has(entry)) return;
      this._connectionReconnectBatchHandlers.delete(entry);
      for (const envKey of uniqueEnvKeys) {
        if (this._connectionReconnectBatchHandlersByKey.get(envKey) === entry) {
          this._connectionReconnectBatchHandlersByKey.delete(envKey);
        }
      }
    };

    if (!options.ownerId) return unregisterHandler;

    const unregisterOwnerCleanup = this._lifecycle.trackCleanup(options.ownerId, unregisterHandler);
    return () => {
      unregisterOwnerCleanup();
      unregisterHandler();
    };
  }

  hasConnectionReconnect(envKey: string): boolean {
    return this._connectionReconnectHandlers.has(envKey) || this._connectionReconnectBatchHandlersByKey.has(envKey);
  }

  applyConnectionReconnect(context: RuntimeConfigApplyContext): boolean {
    const handler = this._connectionReconnectHandlers.get(context.envKey);
    if (!handler) return false;
    handler(context);
    return true;
  }

  async applyConnectionReconnectBatch(contexts: RuntimeConfigApplyContext[]): Promise<RuntimeConfigBatchApplyResult> {
    const applied: string[] = [];
    const errors: RuntimeConfigBatchApplyError[] = [];
    const grouped = new Map<RuntimeConfigBatchHandlerEntry, RuntimeConfigApplyContext[]>();
    const singleContexts: RuntimeConfigApplyContext[] = [];

    for (const context of contexts) {
      const batchEntry = this._connectionReconnectBatchHandlersByKey.get(context.envKey);
      if (batchEntry) {
        const bucket = grouped.get(batchEntry) ?? [];
        bucket.push(context);
        grouped.set(batchEntry, bucket);
        continue;
      }

      if (this._connectionReconnectHandlers.has(context.envKey)) {
        singleContexts.push(context);
      }
    }

    for (const [entry, bucket] of grouped) {
      try {
        await entry.handler(bucket);
        applied.push(...bucket.map((context) => context.envKey));
      } catch (err) {
        const message = toErrorMessage(err);
        for (const context of bucket) errors.push({ key: context.envKey, message });
      }
    }

    for (const context of singleContexts) {
      try {
        const handler = this._connectionReconnectHandlers.get(context.envKey);
        if (!handler) continue;
        handler(context);
        applied.push(context.envKey);
      } catch (err) {
        errors.push({ key: context.envKey, message: toErrorMessage(err) });
      }
    }

    return { applied, errors };
  }

  cleanupOwner(ownerId: string): Promise<void> {
    return this._lifecycle.cleanupOwner(ownerId);
  }
}

export default RuntimeConfigApplier;
export { RuntimeConfigApplier };

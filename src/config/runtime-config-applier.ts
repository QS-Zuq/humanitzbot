import RuntimeModuleRegistry from './runtime-module-registry.js';

export interface RuntimeConfigApplyContext {
  envKey: string;
  cfgKey: string;
  value: unknown;
}

export type RuntimeConfigApplyHandler = (context: RuntimeConfigApplyContext) => void;

interface RuntimeConfigRegisterOptions {
  ownerId?: string;
}

class RuntimeConfigApplier {
  private readonly _moduleReconfigureHandlers = new Map<string, RuntimeConfigApplyHandler>();
  private readonly _connectionReconnectHandlers = new Map<string, RuntimeConfigApplyHandler>();
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

  hasConnectionReconnect(envKey: string): boolean {
    return this._connectionReconnectHandlers.has(envKey);
  }

  applyConnectionReconnect(context: RuntimeConfigApplyContext): boolean {
    const handler = this._connectionReconnectHandlers.get(context.envKey);
    if (!handler) return false;
    handler(context);
    return true;
  }

  cleanupOwner(ownerId: string): Promise<void> {
    return this._lifecycle.cleanupOwner(ownerId);
  }
}

export default RuntimeConfigApplier;
export { RuntimeConfigApplier };

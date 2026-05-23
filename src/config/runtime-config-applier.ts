export interface RuntimeConfigApplyContext {
  envKey: string;
  cfgKey: string;
  value: unknown;
}

export type RuntimeConfigApplyHandler = (context: RuntimeConfigApplyContext) => void;

class RuntimeConfigApplier {
  private readonly _moduleReconfigureHandlers = new Map<string, RuntimeConfigApplyHandler>();
  private readonly _connectionReconnectHandlers = new Map<string, RuntimeConfigApplyHandler>();

  registerModuleReconfigure(envKey: string, handler: RuntimeConfigApplyHandler): () => void {
    if (!envKey) throw new Error('envKey is required');
    this._moduleReconfigureHandlers.set(envKey, handler);

    return () => {
      if (this._moduleReconfigureHandlers.get(envKey) === handler) {
        this._moduleReconfigureHandlers.delete(envKey);
      }
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

  registerConnectionReconnect(envKey: string, handler: RuntimeConfigApplyHandler): () => void {
    if (!envKey) throw new Error('envKey is required');
    this._connectionReconnectHandlers.set(envKey, handler);

    return () => {
      if (this._connectionReconnectHandlers.get(envKey) === handler) {
        this._connectionReconnectHandlers.delete(envKey);
      }
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
}

export default RuntimeConfigApplier;
export { RuntimeConfigApplier };

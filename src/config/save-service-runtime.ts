import type { RuntimeConfigApplyContext, RuntimeConfigApplyHandler } from './runtime-config-applier.js';

const DIRECT_SAVE_POLL_MIN_MS = 60_000;
const AGENT_SAVE_POLL_MIN_MS = 30_000;
const AGENT_TIMEOUT_MIN_MS = 10_000;
const AGENT_PANEL_DELAY_MIN_MS = 500;

type SaveServiceRuntimeEnvKey = 'SAVE_POLL_INTERVAL' | 'AGENT_POLL_INTERVAL' | 'AGENT_TIMEOUT' | 'AGENT_PANEL_DELAY';

interface RuntimeConfigRegistry {
  registerModuleReconfigure(envKey: string, handler: RuntimeConfigApplyHandler): () => void;
}

interface SaveServiceReconfigurable {
  reconfigure(options: { pollInterval?: number; agentTimeout?: number; agentPanelDelay?: number }): void;
}

export interface SaveServiceRuntimeConfig {
  agentMode?: unknown;
  localPath?: unknown;
  savePollInterval?: unknown;
  agentPollInterval?: unknown;
  agentTimeout?: unknown;
  agentPanelDelay?: unknown;
}

interface RegisterSaveServiceRuntimeHandlersOptions {
  runtimeConfigApplier: RuntimeConfigRegistry;
  saveService: SaveServiceReconfigurable;
  getConfig: () => SaveServiceRuntimeConfig;
  getLocalPath?: () => unknown;
}

const TIMING_FIELDS: Record<SaveServiceRuntimeEnvKey, { cfgKey: keyof SaveServiceRuntimeConfig; min: number }> = {
  SAVE_POLL_INTERVAL: { cfgKey: 'savePollInterval', min: DIRECT_SAVE_POLL_MIN_MS },
  AGENT_POLL_INTERVAL: { cfgKey: 'agentPollInterval', min: AGENT_SAVE_POLL_MIN_MS },
  AGENT_TIMEOUT: { cfgKey: 'agentTimeout', min: AGENT_TIMEOUT_MIN_MS },
  AGENT_PANEL_DELAY: { cfgKey: 'agentPanelDelay', min: AGENT_PANEL_DELAY_MIN_MS },
};

export function isDirectSavePolling(options: { agentMode?: unknown; localPath?: unknown }): boolean {
  const localPath = typeof options.localPath === 'string' ? options.localPath.trim() : '';
  const agentMode = typeof options.agentMode === 'string' ? options.agentMode.toLowerCase() : '';
  return localPath.length > 0 || agentMode === 'direct';
}

export function clampTimingMs(value: unknown, name: string, min: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number`);
  }
  return Math.max(Math.trunc(value), min);
}

export function resolveSaveServicePollInterval(options: SaveServiceRuntimeConfig): number {
  if (isDirectSavePolling(options)) {
    return clampTimingMs(options.savePollInterval, 'SAVE_POLL_INTERVAL', DIRECT_SAVE_POLL_MIN_MS);
  }

  return clampTimingMs(options.agentPollInterval, 'AGENT_POLL_INTERVAL', AGENT_SAVE_POLL_MIN_MS);
}

function isSaveServiceRuntimeEnvKey(value: string): value is SaveServiceRuntimeEnvKey {
  return Object.prototype.hasOwnProperty.call(TIMING_FIELDS, value);
}

function applyTimingContext(cfg: SaveServiceRuntimeConfig, context: RuntimeConfigApplyContext): number {
  if (!isSaveServiceRuntimeEnvKey(context.envKey)) {
    throw new Error(`Unsupported SaveService runtime key: ${context.envKey}`);
  }

  const field = TIMING_FIELDS[context.envKey];
  if (context.cfgKey !== field.cfgKey) {
    throw new Error(`${context.envKey} expected cfgKey ${field.cfgKey}, received ${context.cfgKey}`);
  }

  const normalized = clampTimingMs(context.value, context.envKey, field.min);
  cfg[field.cfgKey] = normalized;
  return normalized;
}

export function registerSaveServiceRuntimeHandlers(options: RegisterSaveServiceRuntimeHandlersOptions): () => void {
  const { runtimeConfigApplier, saveService, getConfig, getLocalPath } = options;

  const reconfigurePollInterval = (context: RuntimeConfigApplyContext): void => {
    const cfg = getConfig();
    applyTimingContext(cfg, context);
    const localPath = getLocalPath ? getLocalPath() : cfg.localPath;
    saveService.reconfigure({
      pollInterval: resolveSaveServicePollInterval({
        ...cfg,
        localPath,
      }),
    });
  };

  const unregisterHandlers = [
    runtimeConfigApplier.registerModuleReconfigure('SAVE_POLL_INTERVAL', reconfigurePollInterval),
    runtimeConfigApplier.registerModuleReconfigure('AGENT_POLL_INTERVAL', reconfigurePollInterval),
    runtimeConfigApplier.registerModuleReconfigure('AGENT_TIMEOUT', (context) => {
      const cfg = getConfig();
      const agentTimeout = applyTimingContext(cfg, context);
      saveService.reconfigure({ agentTimeout });
    }),
    runtimeConfigApplier.registerModuleReconfigure('AGENT_PANEL_DELAY', (context) => {
      const cfg = getConfig();
      const agentPanelDelay = applyTimingContext(cfg, context);
      saveService.reconfigure({ agentPanelDelay });
    }),
  ];

  return () => {
    for (const unregister of unregisterHandlers) unregister();
  };
}

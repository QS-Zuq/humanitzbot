import type {
  RuntimeConfigApplyBatchHandler,
  RuntimeConfigApplyContext,
  RuntimeConfigApplyHandler,
} from './runtime-config-applier.js';
import { getConfigValue, setConfigValue } from './index.js';
import { resolveSaveServicePollInterval } from './save-service-runtime.js';

const AGENT_SOURCE_RUNTIME_OWNER = 'agent-source-runtime';
const HZMOD_SOURCE_RUNTIME_OWNER = 'hzmod-source-runtime';

export const AGENT_SOURCE_RECONNECT_ENV_KEYS = ['AGENT_MODE', 'AGENT_TRIGGER', 'AGENT_NODE_PATH'] as const;
export const AGENT_SOURCE_RECONFIGURE_ENV_KEYS = [
  'AGENT_REMOTE_DIR',
  'AGENT_CACHE_PATH',
  'AGENT_PANEL_COMMAND',
] as const;
export const HZMOD_SOURCE_RECONNECT_ENV_KEYS = ['HZMOD_SERVER_ID', 'HZMOD_SOCKET_PATH', 'HZMOD_STATUS_PATH'] as const;

type AgentSourceReconnectEnvKey = (typeof AGENT_SOURCE_RECONNECT_ENV_KEYS)[number];
type AgentSourceReconfigureEnvKey = (typeof AGENT_SOURCE_RECONFIGURE_ENV_KEYS)[number];
type AgentSourceEnvKey = AgentSourceReconnectEnvKey | AgentSourceReconfigureEnvKey;
type HzmodSourceEnvKey = (typeof HZMOD_SOURCE_RECONNECT_ENV_KEYS)[number];

interface RuntimeConfigRegistry {
  registerConnectionReconnectGroup(
    envKeys: string[],
    handler: RuntimeConfigApplyBatchHandler,
    options?: { ownerId?: string },
  ): () => void;
  registerModuleReconfigure(
    envKey: string,
    handler: RuntimeConfigApplyHandler,
    options?: { ownerId?: string },
  ): () => void;
}

export interface AgentSourceRuntimeSnapshot {
  agentMode: string;
  agentTrigger: string;
  agentNodePath: string;
  agentRemoteDir: string;
  agentCachePath: string;
  agentPanelCommand: string;
  savePollInterval: number;
  agentPollInterval: number;
}

export interface HzmodSourceRuntimeSnapshot {
  hzmodServerId: string;
  hzmodSocketPath: string;
  hzmodStatusPath: string;
}

export interface AgentSourceRuntimeReconfigureOptions {
  pollInterval?: number;
  agentMode?: string;
  agentTrigger?: string;
  agentNodePath?: string;
  agentRemoteDir?: string;
  agentCachePath?: string;
  agentPanelCommand?: string;
}

interface AgentSourceRuntime {
  reconfigure(options: AgentSourceRuntimeReconfigureOptions): void;
}

export type HzmodSourceRuntimeReconfigure = (
  next: HzmodSourceRuntimeSnapshot,
  previous: HzmodSourceRuntimeSnapshot,
) => void | Promise<void>;

interface RegisterExternalSourceRuntimeHandlersOptions {
  runtimeConfigApplier: RuntimeConfigRegistry;
  config: unknown;
  getSaveService?: () => AgentSourceRuntime | null | undefined;
  reconfigureHzmod?: HzmodSourceRuntimeReconfigure;
}

const AGENT_SOURCE_ENV_TO_CFG: Record<AgentSourceEnvKey, keyof AgentSourceRuntimeSnapshot> = {
  AGENT_MODE: 'agentMode',
  AGENT_TRIGGER: 'agentTrigger',
  AGENT_NODE_PATH: 'agentNodePath',
  AGENT_REMOTE_DIR: 'agentRemoteDir',
  AGENT_CACHE_PATH: 'agentCachePath',
  AGENT_PANEL_COMMAND: 'agentPanelCommand',
};

const HZMOD_SOURCE_ENV_TO_CFG: Record<HzmodSourceEnvKey, keyof HzmodSourceRuntimeSnapshot> = {
  HZMOD_SERVER_ID: 'hzmodServerId',
  HZMOD_SOCKET_PATH: 'hzmodSocketPath',
  HZMOD_STATUS_PATH: 'hzmodStatusPath',
};

function stringValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  return '';
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;
}

function lowerStringValue(value: unknown, fallback: string): string {
  const raw = stringValue(value).trim();
  return (raw || fallback).toLowerCase();
}

function hzmodStringValue(value: unknown, name: string): string {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value).trim();
  }
  throw new Error(`${name} must be a string-compatible value`);
}

function getAgentSourceSnapshot(config: unknown): AgentSourceRuntimeSnapshot {
  return {
    agentMode: lowerStringValue(getConfigValue(config, 'agentMode'), 'auto'),
    agentTrigger: lowerStringValue(getConfigValue(config, 'agentTrigger'), 'auto'),
    agentNodePath: stringValue(getConfigValue(config, 'agentNodePath')) || 'node',
    agentRemoteDir: stringValue(getConfigValue(config, 'agentRemoteDir')),
    agentCachePath: stringValue(getConfigValue(config, 'agentCachePath')),
    agentPanelCommand: stringValue(getConfigValue(config, 'agentPanelCommand')) || 'createHZSocket',
    savePollInterval: numberValue(getConfigValue(config, 'savePollInterval'), 300_000),
    agentPollInterval: numberValue(getConfigValue(config, 'agentPollInterval'), 90_000),
  };
}

function getHzmodSourceSnapshot(config: unknown): HzmodSourceRuntimeSnapshot {
  return normalizeHzmodSourceSnapshot({
    hzmodServerId: stringValue(getConfigValue(config, 'hzmodServerId')),
    hzmodSocketPath: stringValue(getConfigValue(config, 'hzmodSocketPath')),
    hzmodStatusPath: stringValue(getConfigValue(config, 'hzmodStatusPath')),
  });
}

function applyContexts<TSnapshot extends object>(
  snapshot: TSnapshot,
  contexts: RuntimeConfigApplyContext[],
  envToCfg: Record<string, keyof TSnapshot>,
): TSnapshot {
  const next = { ...snapshot };
  for (const context of contexts) {
    const cfgKey = envToCfg[context.envKey];
    if (!cfgKey) continue;
    (next as Record<string, unknown>)[String(cfgKey)] = context.value;
  }
  return next;
}

function normalizeAgentSourceSnapshot(snapshot: AgentSourceRuntimeSnapshot): AgentSourceRuntimeSnapshot {
  return {
    ...snapshot,
    agentMode: lowerStringValue(snapshot.agentMode, 'auto'),
    agentTrigger: lowerStringValue(snapshot.agentTrigger, 'auto'),
    agentNodePath: stringValue(snapshot.agentNodePath) || 'node',
    agentRemoteDir: stringValue(snapshot.agentRemoteDir),
    agentCachePath: stringValue(snapshot.agentCachePath),
    agentPanelCommand: stringValue(snapshot.agentPanelCommand) || 'createHZSocket',
    savePollInterval: numberValue(snapshot.savePollInterval, 300_000),
    agentPollInterval: numberValue(snapshot.agentPollInterval, 90_000),
  };
}

function normalizeHzmodSourceSnapshot(snapshot: HzmodSourceRuntimeSnapshot): HzmodSourceRuntimeSnapshot {
  return {
    hzmodServerId: hzmodStringValue(snapshot.hzmodServerId, 'hzmodServerId'),
    hzmodSocketPath: hzmodStringValue(snapshot.hzmodSocketPath, 'hzmodSocketPath'),
    hzmodStatusPath: hzmodStringValue(snapshot.hzmodStatusPath, 'hzmodStatusPath'),
  };
}

function setAgentSourceSnapshot(config: unknown, snapshot: AgentSourceRuntimeSnapshot): void {
  const normalized = normalizeAgentSourceSnapshot(snapshot);
  for (const cfgKey of Object.values(AGENT_SOURCE_ENV_TO_CFG)) {
    setConfigValue(config, cfgKey, normalized[cfgKey]);
  }
}

function setHzmodSourceSnapshot(config: unknown, snapshot: HzmodSourceRuntimeSnapshot): void {
  const normalized = normalizeHzmodSourceSnapshot(snapshot);
  for (const cfgKey of Object.values(HZMOD_SOURCE_ENV_TO_CFG)) {
    setConfigValue(config, cfgKey, normalized[cfgKey]);
  }
}

function toSaveServiceOptions(snapshot: AgentSourceRuntimeSnapshot): AgentSourceRuntimeReconfigureOptions {
  return {
    pollInterval: resolveSaveServicePollInterval(snapshot),
    agentMode: snapshot.agentMode,
    agentTrigger: snapshot.agentTrigger,
    agentNodePath: snapshot.agentNodePath,
    agentRemoteDir: snapshot.agentRemoteDir,
    agentCachePath: snapshot.agentCachePath,
    agentPanelCommand: snapshot.agentPanelCommand,
  };
}

function reconfigureSaveService(
  saveService: AgentSourceRuntime | null | undefined,
  next: AgentSourceRuntimeSnapshot,
  previous: AgentSourceRuntimeSnapshot,
): void {
  if (!saveService) return;
  try {
    saveService.reconfigure(toSaveServiceOptions(next));
  } catch (err) {
    try {
      saveService.reconfigure(toSaveServiceOptions(previous));
    } catch {
      // Preserve the original runtime-apply failure.
    }
    throw err;
  }
}

function makeAgentReconnectHandler(
  options: RegisterExternalSourceRuntimeHandlersOptions,
): RuntimeConfigApplyBatchHandler {
  const { config, getSaveService } = options;
  return (contexts) => {
    const previous = getAgentSourceSnapshot(config);
    const next = normalizeAgentSourceSnapshot(applyContexts(previous, contexts, AGENT_SOURCE_ENV_TO_CFG));
    reconfigureSaveService(getSaveService?.(), next, previous);
    setAgentSourceSnapshot(config, next);
  };
}

function makeAgentReconfigureHandler(options: RegisterExternalSourceRuntimeHandlersOptions): RuntimeConfigApplyHandler {
  const { config, getSaveService } = options;
  return (context) => {
    const previous = getAgentSourceSnapshot(config);
    const next = normalizeAgentSourceSnapshot(applyContexts(previous, [context], AGENT_SOURCE_ENV_TO_CFG));
    reconfigureSaveService(getSaveService?.(), next, previous);
    setAgentSourceSnapshot(config, next);
  };
}

function makeHzmodReconnectHandler(
  options: RegisterExternalSourceRuntimeHandlersOptions,
): RuntimeConfigApplyBatchHandler {
  const { config, reconfigureHzmod } = options;
  return async (contexts) => {
    const previous = getHzmodSourceSnapshot(config);
    const next = normalizeHzmodSourceSnapshot(applyContexts(previous, contexts, HZMOD_SOURCE_ENV_TO_CFG));
    if (reconfigureHzmod) await reconfigureHzmod(next, previous);
    setHzmodSourceSnapshot(config, next);
  };
}

export function registerExternalSourceRuntimeHandlers(
  options: RegisterExternalSourceRuntimeHandlersOptions,
): () => void {
  const { runtimeConfigApplier } = options;
  const unregisterHandlers = [
    runtimeConfigApplier.registerConnectionReconnectGroup(
      [...AGENT_SOURCE_RECONNECT_ENV_KEYS],
      makeAgentReconnectHandler(options),
      { ownerId: AGENT_SOURCE_RUNTIME_OWNER },
    ),
    ...AGENT_SOURCE_RECONFIGURE_ENV_KEYS.map((envKey) =>
      runtimeConfigApplier.registerModuleReconfigure(envKey, makeAgentReconfigureHandler(options), {
        ownerId: AGENT_SOURCE_RUNTIME_OWNER,
      }),
    ),
    runtimeConfigApplier.registerConnectionReconnectGroup(
      [...HZMOD_SOURCE_RECONNECT_ENV_KEYS],
      makeHzmodReconnectHandler(options),
      { ownerId: HZMOD_SOURCE_RUNTIME_OWNER },
    ),
  ];

  return () => {
    for (const unregister of unregisterHandlers) unregister();
  };
}

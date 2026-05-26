import { ENV_CATEGORIES as DEFAULT_ENV_CATEGORIES } from '../modules/panel-constants.js';

export const RELOAD_STRATEGIES = [
  'live',
  'module-reconfigure',
  'module-restart',
  'connection-reconnect',
  'bot-restart',
  'game-restart',
] as const;

export type ReloadStrategy = (typeof RELOAD_STRATEGIES)[number];
type PendingReloadStrategy = Exclude<ReloadStrategy, 'live'>;

export interface EnvConfigFieldWithReloadStrategy {
  env: string;
  reloadStrategy?: ReloadStrategy;
}

export interface EnvConfigCategoryWithReloadStrategy {
  reloadStrategy?: ReloadStrategy;
  restart?: boolean;
  fields: EnvConfigFieldWithReloadStrategy[];
}

export interface ConfigReloadError {
  key: string;
  strategy: ReloadStrategy;
  message: string;
}

export interface ConfigReloadApplyResult {
  updated: string[];
  appliedLive: string[];
  appliedModuleReconfigure: string[];
  appliedModuleRestart: string[];
  appliedReconnect: string[];
  pendingModuleReconfigure: string[];
  pendingModuleRestart: string[];
  pendingReconnect: string[];
  pendingBotRestart: string[];
  pendingGameRestart: string[];
  errors: ConfigReloadError[];
  restartRequired: boolean;
  message: string;
}

interface SummarizeConfigReloadOptions {
  categories?: EnvConfigCategoryWithReloadStrategy[];
  applyLive?: (envKey: string) => void;
  applyModuleReconfigure?: (envKey: string) => boolean;
  applyModuleRestart?: (envKey: string) => boolean;
  applyModuleRestartAsync?: (envKey: string) => Promise<boolean>;
  applyConnectionReconnect?: (envKey: string) => boolean;
  applyConnectionReconnectBatch?: (envKeys: string[]) => Promise<ConnectionReconnectBatchApplyResult>;
}

export interface ConnectionReconnectBatchApplyResult {
  applied: string[];
  errors?: Array<{ key: string; message: string }>;
}

export const DEFAULT_RELOAD_STRATEGY: ReloadStrategy = 'bot-restart';

function getDefaultCategories(): EnvConfigCategoryWithReloadStrategy[] {
  return DEFAULT_ENV_CATEGORIES as EnvConfigCategoryWithReloadStrategy[];
}

export function isReloadStrategy(value: unknown): value is ReloadStrategy {
  return typeof value === 'string' && (RELOAD_STRATEGIES as readonly string[]).includes(value);
}

export function resolveReloadStrategy(
  envKey: string,
  categories: EnvConfigCategoryWithReloadStrategy[] = getDefaultCategories(),
): ReloadStrategy {
  for (const category of categories) {
    const field = category.fields.find((candidate) => candidate.env === envKey);
    if (!field) continue;
    if (isReloadStrategy(field.reloadStrategy)) return field.reloadStrategy;
    if (isReloadStrategy(category.reloadStrategy)) return category.reloadStrategy;
    return DEFAULT_RELOAD_STRATEGY;
  }

  return DEFAULT_RELOAD_STRATEGY;
}

export function buildReloadStrategyMap(
  categories: EnvConfigCategoryWithReloadStrategy[] = getDefaultCategories(),
): Record<string, ReloadStrategy> {
  const map: Record<string, ReloadStrategy> = {};
  for (const category of categories) {
    for (const field of category.fields) {
      map[field.env] = resolveReloadStrategy(field.env, categories);
    }
  }
  return map;
}

export function createEmptyConfigReloadApplyResult(): ConfigReloadApplyResult {
  return {
    updated: [],
    appliedLive: [],
    appliedModuleReconfigure: [],
    appliedModuleRestart: [],
    appliedReconnect: [],
    pendingModuleReconfigure: [],
    pendingModuleRestart: [],
    pendingReconnect: [],
    pendingBotRestart: [],
    pendingGameRestart: [],
    errors: [],
    restartRequired: false,
    message: 'No settings changed.',
  };
}

function toErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'string' && err) return err;
  return 'Runtime apply failed';
}

function assertNever(value: never): never {
  throw new Error(`Unhandled reload strategy: ${String(value)}`);
}

function addPending(result: ConfigReloadApplyResult, envKey: string, strategy: PendingReloadStrategy): void {
  switch (strategy) {
    case 'module-reconfigure':
      result.pendingModuleReconfigure.push(envKey);
      return;
    case 'module-restart':
      result.pendingModuleRestart.push(envKey);
      return;
    case 'connection-reconnect':
      result.pendingReconnect.push(envKey);
      return;
    case 'game-restart':
      result.pendingGameRestart.push(envKey);
      return;
    case 'bot-restart':
      result.pendingBotRestart.push(envKey);
      return;
    default:
      assertNever(strategy);
  }
}

function countPending(result: ConfigReloadApplyResult): number {
  return (
    result.pendingModuleReconfigure.length +
    result.pendingModuleRestart.length +
    result.pendingReconnect.length +
    result.pendingBotRestart.length +
    result.pendingGameRestart.length
  );
}

function buildConfigReloadMessage(result: ConfigReloadApplyResult): string {
  if (result.updated.length === 0) return 'No settings changed.';

  const parts: string[] = [];
  if (result.appliedLive.length > 0) parts.push(`${result.appliedLive.length} applied live`);
  if (result.appliedModuleReconfigure.length > 0)
    parts.push(`${result.appliedModuleReconfigure.length} applied module reconfigure`);
  if (result.appliedModuleRestart.length > 0)
    parts.push(`${result.appliedModuleRestart.length} applied module restart`);
  if (result.appliedReconnect.length > 0) parts.push(`${result.appliedReconnect.length} applied reconnect`);
  if (result.pendingModuleReconfigure.length > 0)
    parts.push(`${result.pendingModuleReconfigure.length} pending module reconfigure`);
  if (result.pendingModuleRestart.length > 0)
    parts.push(`${result.pendingModuleRestart.length} pending module restart`);
  if (result.pendingReconnect.length > 0) parts.push(`${result.pendingReconnect.length} pending reconnect`);
  if (result.pendingBotRestart.length > 0) parts.push(`${result.pendingBotRestart.length} pending bot restart`);
  if (result.pendingGameRestart.length > 0) parts.push(`${result.pendingGameRestart.length} pending game restart`);
  if (result.errors.length > 0) parts.push(`${result.errors.length} runtime apply failed`);

  return `Settings saved. ${parts.join(', ')}.`;
}

export function summarizeConfigReloadApply(
  changedKeys: Iterable<string>,
  options: SummarizeConfigReloadOptions = {},
): ConfigReloadApplyResult {
  const result = createEmptyConfigReloadApplyResult();
  const categories = options.categories ?? getDefaultCategories();

  for (const envKey of new Set(changedKeys)) {
    const strategy = resolveReloadStrategy(envKey, categories);
    result.updated.push(envKey);

    if (strategy === 'live') {
      if (!options.applyLive) {
        result.errors.push({ key: envKey, strategy, message: 'Live apply handler is not configured' });
        continue;
      }

      try {
        options.applyLive(envKey);
        result.appliedLive.push(envKey);
      } catch (err) {
        result.errors.push({ key: envKey, strategy, message: toErrorMessage(err) });
      }
      continue;
    }

    if (strategy === 'module-reconfigure') {
      try {
        if (options.applyModuleReconfigure?.(envKey) === true) {
          result.appliedModuleReconfigure.push(envKey);
          continue;
        }
      } catch (err) {
        result.errors.push({ key: envKey, strategy, message: toErrorMessage(err) });
        continue;
      }
    }

    if (strategy === 'module-restart') {
      try {
        if (options.applyModuleRestart?.(envKey) === true) {
          result.appliedModuleRestart.push(envKey);
          continue;
        }
      } catch (err) {
        result.errors.push({ key: envKey, strategy, message: toErrorMessage(err) });
        continue;
      }
    }

    if (strategy === 'connection-reconnect') {
      try {
        if (options.applyConnectionReconnect?.(envKey) === true) {
          result.appliedReconnect.push(envKey);
          continue;
        }
      } catch (err) {
        result.errors.push({ key: envKey, strategy, message: toErrorMessage(err) });
        continue;
      }
    }

    addPending(result, envKey, strategy);
  }

  result.restartRequired = result.errors.length > 0 || countPending(result) > 0;
  result.message = buildConfigReloadMessage(result);
  return result;
}

export async function summarizeConfigReloadApplyAsync(
  changedKeys: Iterable<string>,
  options: SummarizeConfigReloadOptions = {},
): Promise<ConfigReloadApplyResult> {
  const result = createEmptyConfigReloadApplyResult();
  const categories = options.categories ?? getDefaultCategories();
  const pendingConnectionReconnect: string[] = [];
  const pendingModuleRestart: string[] = [];

  for (const envKey of new Set(changedKeys)) {
    const strategy = resolveReloadStrategy(envKey, categories);
    result.updated.push(envKey);

    if (strategy === 'live') {
      if (!options.applyLive) {
        result.errors.push({ key: envKey, strategy, message: 'Live apply handler is not configured' });
        continue;
      }

      try {
        options.applyLive(envKey);
        result.appliedLive.push(envKey);
      } catch (err) {
        result.errors.push({ key: envKey, strategy, message: toErrorMessage(err) });
      }
      continue;
    }

    if (strategy === 'module-reconfigure') {
      try {
        if (options.applyModuleReconfigure?.(envKey) === true) {
          result.appliedModuleReconfigure.push(envKey);
          continue;
        }
      } catch (err) {
        result.errors.push({ key: envKey, strategy, message: toErrorMessage(err) });
        continue;
      }
    }

    if (strategy === 'module-restart') {
      pendingModuleRestart.push(envKey);
      continue;
    }

    if (strategy === 'connection-reconnect') {
      pendingConnectionReconnect.push(envKey);
      continue;
    }

    addPending(result, envKey, strategy);
  }

  if (pendingConnectionReconnect.length > 0) {
    if (options.applyConnectionReconnectBatch) {
      try {
        const batchResult = await options.applyConnectionReconnectBatch(pendingConnectionReconnect);
        const applied = new Set(batchResult.applied);
        const failed = new Set<string>();

        for (const error of batchResult.errors ?? []) {
          failed.add(error.key);
          result.errors.push({ key: error.key, strategy: 'connection-reconnect', message: error.message });
        }

        for (const envKey of pendingConnectionReconnect) {
          if (applied.has(envKey)) {
            result.appliedReconnect.push(envKey);
          } else if (!failed.has(envKey)) {
            result.pendingReconnect.push(envKey);
          }
        }
      } catch (err) {
        const message = toErrorMessage(err);
        for (const envKey of pendingConnectionReconnect) {
          result.errors.push({ key: envKey, strategy: 'connection-reconnect', message });
        }
      }
    } else {
      for (const envKey of pendingConnectionReconnect) {
        try {
          if (options.applyConnectionReconnect?.(envKey) === true) {
            result.appliedReconnect.push(envKey);
            continue;
          }
        } catch (err) {
          result.errors.push({ key: envKey, strategy: 'connection-reconnect', message: toErrorMessage(err) });
          continue;
        }

        result.pendingReconnect.push(envKey);
      }
    }
  }

  if (pendingModuleRestart.length > 0) {
    const hasUnresolvedReconnect =
      pendingConnectionReconnect.length > 0 &&
      (result.pendingReconnect.length > 0 || result.errors.some((error) => error.strategy === 'connection-reconnect'));

    if (hasUnresolvedReconnect) {
      for (const envKey of pendingModuleRestart) addPending(result, envKey, 'module-restart');
    } else {
      for (const envKey of pendingModuleRestart) {
        try {
          const applied = options.applyModuleRestartAsync
            ? await options.applyModuleRestartAsync(envKey)
            : options.applyModuleRestart?.(envKey) === true;
          if (applied) {
            result.appliedModuleRestart.push(envKey);
            continue;
          }
        } catch (err) {
          result.errors.push({ key: envKey, strategy: 'module-restart', message: toErrorMessage(err) });
          continue;
        }

        addPending(result, envKey, 'module-restart');
      }
    }
  }

  result.restartRequired = result.errors.length > 0 || countPending(result) > 0;
  result.message = buildConfigReloadMessage(result);
  return result;
}

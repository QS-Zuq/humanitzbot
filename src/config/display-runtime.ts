import type { RuntimeConfigApplyContext, RuntimeConfigApplyHandler } from './runtime-config-applier.js';
import { setConfigValue } from './index.js';

const DISPLAY_RUNTIME_OWNER = 'display-runtime';

export const DISPLAY_RUNTIME_ENV_KEYS = ['BOT_LOCALE', 'BOT_TIMEZONE', 'LOG_TIMEZONE'] as const;

type DisplayRuntimeEnvKey = (typeof DISPLAY_RUNTIME_ENV_KEYS)[number];
type DisplayRuntimeConfigKey = 'botLocale' | 'botTimezone' | 'logTimezone';

interface RuntimeConfigRegistry {
  registerModuleReconfigure(
    envKey: string,
    handler: RuntimeConfigApplyHandler,
    options?: { ownerId?: string },
  ): () => void;
}

interface RegisterDisplayRuntimeHandlersOptions {
  runtimeConfigApplier: RuntimeConfigRegistry;
  config: unknown;
  onApplied?: (context: RuntimeConfigApplyContext) => void;
}

const DISPLAY_ENV_TO_CFG: Record<DisplayRuntimeEnvKey, DisplayRuntimeConfigKey> = {
  BOT_LOCALE: 'botLocale',
  BOT_TIMEZONE: 'botTimezone',
  LOG_TIMEZONE: 'logTimezone',
};

const DISPLAY_DEFAULTS: Record<DisplayRuntimeEnvKey, string> = {
  BOT_LOCALE: 'en',
  BOT_TIMEZONE: 'UTC',
  LOG_TIMEZONE: 'UTC',
};

const SUPPORTED_LOCALES = new Set(['en', 'zh-TW', 'zh-CN']);

function isDisplayRuntimeEnvKey(value: string): value is DisplayRuntimeEnvKey {
  return (DISPLAY_RUNTIME_ENV_KEYS as readonly string[]).includes(value);
}

function stringValue(value: unknown, fallback: string): string {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || fallback;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    const trimmed = String(value).trim();
    return trimmed || fallback;
  }
  return fallback;
}

function validateTimeZone(value: string, envKey: DisplayRuntimeEnvKey): string {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: value });
  } catch (err) {
    throw new Error(`Invalid IANA timezone for ${envKey}: ${value}`, { cause: err });
  }
  return value;
}

export function normalizeDisplayRuntimeValue(envKey: DisplayRuntimeEnvKey, value: unknown): string {
  const normalized = stringValue(value, DISPLAY_DEFAULTS[envKey]);

  if (envKey === 'BOT_LOCALE') {
    if (!SUPPORTED_LOCALES.has(normalized)) {
      throw new Error(`Unsupported bot locale: ${normalized}`);
    }
    return normalized;
  }

  return validateTimeZone(normalized, envKey);
}

function makeDisplayReconfigureHandler(options: RegisterDisplayRuntimeHandlersOptions): RuntimeConfigApplyHandler {
  const { config, onApplied } = options;

  return (context) => {
    if (!isDisplayRuntimeEnvKey(context.envKey)) {
      throw new Error(`Unsupported display runtime key: ${context.envKey}`);
    }

    const cfgKey = DISPLAY_ENV_TO_CFG[context.envKey];
    if (context.cfgKey !== cfgKey) {
      throw new Error(`${context.envKey} expected cfgKey ${cfgKey}, received ${context.cfgKey}`);
    }

    setConfigValue(config, cfgKey, normalizeDisplayRuntimeValue(context.envKey, context.value));
    onApplied?.(context);
  };
}

export function registerDisplayRuntimeHandlers(options: RegisterDisplayRuntimeHandlersOptions): () => void {
  const { runtimeConfigApplier } = options;
  const handler = makeDisplayReconfigureHandler(options);
  const unregisterHandlers = DISPLAY_RUNTIME_ENV_KEYS.map((envKey) =>
    runtimeConfigApplier.registerModuleReconfigure(envKey, handler, { ownerId: DISPLAY_RUNTIME_OWNER }),
  );

  return () => {
    for (const unregister of unregisterHandlers) unregister();
  };
}

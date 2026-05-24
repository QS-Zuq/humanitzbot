import fs from 'node:fs';
import type {
  RuntimeConfigApplyContext,
  RuntimeConfigApplyBatchHandler,
  RuntimeConfigApplyHandler,
} from './runtime-config-applier.js';
import { getConfigValue, setConfigValue } from './index.js';

const RCON_RUNTIME_OWNER = 'core-rcon-runtime';
const SFTP_RUNTIME_OWNER = 'core-sftp-runtime';

export const RCON_RUNTIME_ENV_KEYS = ['RCON_HOST', 'RCON_PORT', 'RCON_PASSWORD'] as const;
export const SFTP_RUNTIME_ENV_KEYS = [
  'SFTP_HOST',
  'SFTP_PORT',
  'SFTP_USER',
  'SFTP_PASSWORD',
  'SFTP_PRIVATE_KEY_PATH',
  'SFTP_BASE_PATH',
  'SFTP_LOG_PATH',
  'SFTP_CONNECT_LOG_PATH',
  'SFTP_ID_MAP_PATH',
  'SFTP_SAVE_PATH',
  'SFTP_SETTINGS_PATH',
] as const;

type RconRuntimeEnvKey = (typeof RCON_RUNTIME_ENV_KEYS)[number];
type SftpRuntimeEnvKey = (typeof SFTP_RUNTIME_ENV_KEYS)[number];

interface RuntimeConfigRegistry {
  registerConnectionReconnect(
    envKey: string,
    handler: RuntimeConfigApplyHandler,
    options?: { ownerId?: string },
  ): () => void;
  registerConnectionReconnectGroup(
    envKeys: string[],
    handler: RuntimeConfigApplyBatchHandler,
    options?: { ownerId?: string },
  ): () => void;
}

interface RconRuntime {
  reconnect(options: { host?: string | null; port?: number | null; password?: string | null }): Promise<void>;
  disconnect(): void;
}

interface SaveServiceRuntime {
  reconfigure(options: {
    sftpConfig?: SftpConnectConfig | null;
    savePath?: string;
    clanSavePath?: string;
    agentIdMapPath?: string;
  }): void;
}

interface LogWatcherRuntime {
  reconfigureSftpLogSource(options: { sftpLogPath?: string; sftpConnectLogPath?: string }): Promise<void>;
}

interface SftpConnectConfig {
  host: string;
  port: number;
  username: string;
  password?: string;
  passphrase?: string;
  privateKey?: Buffer;
}

interface RconRuntimeSnapshot {
  rconHost: string;
  rconPort: number;
  rconPassword: string;
}

interface SftpRuntimeSnapshot {
  sftpHost: string;
  sftpPort: number;
  sftpUser: string;
  sftpPassword: string;
  sftpPrivateKeyPath: string;
  sftpBasePath: string;
  sftpLogPath: string;
  sftpConnectLogPath: string;
  sftpIdMapPath: string;
  sftpSavePath: string;
  sftpSettingsPath: string;
}

interface RegisterCoreConnectionRuntimeHandlersOptions {
  runtimeConfigApplier: RuntimeConfigRegistry;
  config: unknown;
  rcon: RconRuntime;
  getSaveService?: () => SaveServiceRuntime | null | undefined;
  getLogWatcher?: () => LogWatcherRuntime | null | undefined;
}

const RCON_ENV_TO_CFG: Record<RconRuntimeEnvKey, keyof RconRuntimeSnapshot> = {
  RCON_HOST: 'rconHost',
  RCON_PORT: 'rconPort',
  RCON_PASSWORD: 'rconPassword',
};

const SFTP_ENV_TO_CFG: Record<SftpRuntimeEnvKey, keyof SftpRuntimeSnapshot> = {
  SFTP_HOST: 'sftpHost',
  SFTP_PORT: 'sftpPort',
  SFTP_USER: 'sftpUser',
  SFTP_PASSWORD: 'sftpPassword',
  SFTP_PRIVATE_KEY_PATH: 'sftpPrivateKeyPath',
  SFTP_BASE_PATH: 'sftpBasePath',
  SFTP_LOG_PATH: 'sftpLogPath',
  SFTP_CONNECT_LOG_PATH: 'sftpConnectLogPath',
  SFTP_ID_MAP_PATH: 'sftpIdMapPath',
  SFTP_SAVE_PATH: 'sftpSavePath',
  SFTP_SETTINGS_PATH: 'sftpSettingsPath',
};

function stringValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  return '';
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;
}

function getRconSnapshot(config: unknown): RconRuntimeSnapshot {
  return {
    rconHost: stringValue(getConfigValue(config, 'rconHost')),
    rconPort: numberValue(getConfigValue(config, 'rconPort'), 14541),
    rconPassword: stringValue(getConfigValue(config, 'rconPassword')),
  };
}

function getSftpSnapshot(config: unknown): SftpRuntimeSnapshot {
  return normalizeSftpSnapshot({
    sftpHost: stringValue(getConfigValue(config, 'sftpHost')),
    sftpPort: numberValue(getConfigValue(config, 'sftpPort'), 2022),
    sftpUser: stringValue(getConfigValue(config, 'sftpUser')),
    sftpPassword: stringValue(getConfigValue(config, 'sftpPassword')),
    sftpPrivateKeyPath: stringValue(getConfigValue(config, 'sftpPrivateKeyPath')),
    sftpBasePath: stringValue(getConfigValue(config, 'sftpBasePath')),
    sftpLogPath: stringValue(getConfigValue(config, 'sftpLogPath')),
    sftpConnectLogPath: stringValue(getConfigValue(config, 'sftpConnectLogPath')),
    sftpIdMapPath: stringValue(getConfigValue(config, 'sftpIdMapPath')),
    sftpSavePath: stringValue(getConfigValue(config, 'sftpSavePath')),
    sftpSettingsPath: stringValue(getConfigValue(config, 'sftpSettingsPath')),
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

function withBasePath(basePath: string, filePath: string): string {
  if (!basePath || !filePath || filePath.startsWith('/')) return filePath;
  return `${basePath.replace(/\/+$/, '')}/${filePath.replace(/^\/+/, '')}`;
}

function normalizeSftpSnapshot(snapshot: SftpRuntimeSnapshot): SftpRuntimeSnapshot {
  const basePath = snapshot.sftpBasePath.replace(/\/+$/, '');
  return {
    ...snapshot,
    sftpBasePath: basePath,
    sftpLogPath: withBasePath(basePath, snapshot.sftpLogPath),
    sftpConnectLogPath: withBasePath(basePath, snapshot.sftpConnectLogPath),
    sftpIdMapPath: withBasePath(basePath, snapshot.sftpIdMapPath),
    sftpSavePath: withBasePath(basePath, snapshot.sftpSavePath),
    sftpSettingsPath: withBasePath(basePath, snapshot.sftpSettingsPath),
  };
}

function buildSftpConnectConfig(snapshot: SftpRuntimeSnapshot): SftpConnectConfig {
  const connectConfig: SftpConnectConfig = {
    host: snapshot.sftpHost,
    port: snapshot.sftpPort,
    username: snapshot.sftpUser,
  };

  if (snapshot.sftpPrivateKeyPath) {
    try {
      connectConfig.privateKey = fs.readFileSync(snapshot.sftpPrivateKeyPath);
    } catch (err) {
      throw new Error('SFTP private key path is not readable', { cause: err });
    }
    if (snapshot.sftpPassword) connectConfig.passphrase = snapshot.sftpPassword;
    return connectConfig;
  }

  connectConfig.password = snapshot.sftpPassword;
  return connectConfig;
}

function clanPathFromSavePath(savePath: string): string {
  const match = savePath.match(/^(.*[/\\])SaveList[/\\].+$/);
  if (!match?.[1]) {
    throw new Error('Cannot derive clan save path from SFTP_SAVE_PATH');
  }
  return `${match[1]}Save_ClanData.sav`;
}

function setRconSnapshot(config: unknown, snapshot: RconRuntimeSnapshot): void {
  for (const cfgKey of Object.values(RCON_ENV_TO_CFG)) {
    setConfigValue(config, cfgKey, snapshot[cfgKey]);
  }
}

function setSftpSnapshot(config: unknown, snapshot: SftpRuntimeSnapshot): void {
  for (const cfgKey of Object.values(SFTP_ENV_TO_CFG)) {
    setConfigValue(config, cfgKey, snapshot[cfgKey]);
  }
}

function makeRconReconnectHandler(
  options: RegisterCoreConnectionRuntimeHandlersOptions,
): RuntimeConfigApplyBatchHandler {
  const { config, rcon } = options;
  return async (contexts) => {
    const previous = getRconSnapshot(config);
    const next = applyContexts(previous, contexts, RCON_ENV_TO_CFG);

    if (!next.rconHost) {
      rcon.disconnect();
      setRconSnapshot(config, next);
      return;
    }

    await rcon.reconnect({
      host: next.rconHost,
      port: next.rconPort,
      password: next.rconPassword,
    });
    setRconSnapshot(config, next);
  };
}

function makeSftpReconnectHandler(
  options: RegisterCoreConnectionRuntimeHandlersOptions,
): RuntimeConfigApplyBatchHandler {
  const { config, getLogWatcher, getSaveService } = options;
  return async (contexts) => {
    const previous = getSftpSnapshot(config);
    const next = normalizeSftpSnapshot(applyContexts(previous, contexts, SFTP_ENV_TO_CFG));
    const nextSftpConfig = next.sftpHost && next.sftpUser ? buildSftpConnectConfig(next) : null;
    const previousSftpConfig = (() => {
      try {
        return previous.sftpHost && previous.sftpUser ? buildSftpConnectConfig(previous) : null;
      } catch {
        return null;
      }
    })();
    const logPathsChanged =
      previous.sftpLogPath !== next.sftpLogPath || previous.sftpConnectLogPath !== next.sftpConnectLogPath;
    const saveService = getSaveService?.() ?? null;
    const logWatcher = getLogWatcher?.() ?? null;
    const nextClanSavePath = saveService ? clanPathFromSavePath(next.sftpSavePath) : undefined;
    const previousClanSavePath = saveService ? clanPathFromSavePath(previous.sftpSavePath) : undefined;
    let saveServiceApplied = false;
    let logWatcherApplied = false;

    setSftpSnapshot(config, next);
    try {
      if (logPathsChanged && logWatcher) {
        await logWatcher.reconfigureSftpLogSource({
          sftpLogPath: next.sftpLogPath,
          sftpConnectLogPath: next.sftpConnectLogPath,
        });
        logWatcherApplied = true;
      }

      if (saveService) {
        saveServiceApplied = true;
        saveService.reconfigure({
          sftpConfig: nextSftpConfig,
          savePath: next.sftpSavePath,
          clanSavePath: nextClanSavePath,
          agentIdMapPath: next.sftpIdMapPath,
        });
      }
    } catch (err) {
      setSftpSnapshot(config, previous);
      if (logWatcherApplied && logPathsChanged && logWatcher) {
        try {
          await logWatcher.reconfigureSftpLogSource({
            sftpLogPath: previous.sftpLogPath,
            sftpConnectLogPath: previous.sftpConnectLogPath,
          });
        } catch {
          // Preserve the original runtime-apply failure.
        }
      }
      if (saveServiceApplied) {
        try {
          saveService?.reconfigure({
            sftpConfig: previousSftpConfig,
            savePath: previous.sftpSavePath,
            clanSavePath: previousClanSavePath,
            agentIdMapPath: previous.sftpIdMapPath,
          });
        } catch {
          // Preserve the original runtime-apply failure.
        }
      }
      throw err;
    }
  };
}

export function registerCoreConnectionRuntimeHandlers(
  options: RegisterCoreConnectionRuntimeHandlersOptions,
): () => void {
  const { runtimeConfigApplier } = options;
  const unregisterHandlers = [
    runtimeConfigApplier.registerConnectionReconnectGroup(
      [...RCON_RUNTIME_ENV_KEYS],
      makeRconReconnectHandler(options),
      {
        ownerId: RCON_RUNTIME_OWNER,
      },
    ),
    runtimeConfigApplier.registerConnectionReconnectGroup(
      [...SFTP_RUNTIME_ENV_KEYS],
      makeSftpReconnectHandler(options),
      {
        ownerId: SFTP_RUNTIME_OWNER,
      },
    ),
  ];

  return () => {
    for (const unregister of unregisterHandlers) unregister();
  };
}

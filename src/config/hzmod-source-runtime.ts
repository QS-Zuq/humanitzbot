import type { HzmodSourceRuntimeSnapshot } from './external-source-runtime.js';
import { errMsg } from '../utils/error.js';

export interface HzmodIpcClientInstance {
  connect: () => void;
  destroy: () => void;
  on: (event: string, handler: (...args: unknown[]) => void) => void;
}

export type HzmodIpcClientConstructor = new (socketPath: string) => HzmodIpcClientInstance;

interface HzmodRuntimeState {
  ipc?: HzmodIpcClientInstance;
}

interface HzmodWebMapPluginHost {
  reconfigurePlugin(name: string, patch: Record<string, unknown>): (() => void) | null;
}

interface HzmodRuntimeReconfigureOptions {
  getIpcClientConstructor: () => HzmodIpcClientConstructor | undefined;
  getWebMapServer: () => HzmodWebMapPluginHost | null | undefined;
  logger?: Pick<typeof console, 'log' | 'error'>;
}

function attachHzmodIpcLogging(ipc: HzmodIpcClientInstance, logger: Pick<typeof console, 'log' | 'error'>): void {
  ipc.on('connect', () => {
    logger.log('[BOT] hzmod IPC connected');
  });
  ipc.on('disconnect', () => {
    logger.log('[BOT] hzmod IPC disconnected — will reconnect');
  });
  ipc.on('error', (ipcErr: unknown) => {
    logger.error('[BOT] hzmod IPC error:', errMsg(ipcErr));
  });
}

export function createHzmodIpc(
  socketPath: string,
  HzmodIpcClient: HzmodIpcClientConstructor | undefined,
  logger: Pick<typeof console, 'log' | 'error'> = console,
): HzmodIpcClientInstance | null {
  if (!HzmodIpcClient || !socketPath) return null;

  const ipc = new HzmodIpcClient(socketPath);
  attachHzmodIpcLogging(ipc, logger);

  try {
    ipc.connect();
  } catch (err) {
    try {
      ipc.destroy();
    } catch {
      // Preserve the original connect failure.
    }
    throw err;
  }

  logger.log(`[BOT] hzmod IPC client connecting to ${socketPath}`);
  return ipc;
}

export function reconfigureHzmodRuntimeState(
  state: HzmodRuntimeState,
  next: HzmodSourceRuntimeSnapshot,
  previous: HzmodSourceRuntimeSnapshot,
  options: HzmodRuntimeReconfigureOptions,
): void {
  const socketChanged = next.hzmodSocketPath !== previous.hzmodSocketPath;
  const previousIpc = state.ipc ?? null;
  let candidateIpc: HzmodIpcClientInstance | null = previousIpc;
  let rollbackPlugin: (() => void) | null = null;

  try {
    if (socketChanged) {
      candidateIpc = createHzmodIpc(next.hzmodSocketPath, options.getIpcClientConstructor(), options.logger);
    }

    rollbackPlugin =
      options.getWebMapServer()?.reconfigurePlugin('hzmod', {
        serverId: next.hzmodServerId,
        statusPath: next.hzmodStatusPath,
        ipc: candidateIpc,
      }) ?? null;

    if (socketChanged) {
      if (previousIpc && previousIpc !== candidateIpc) previousIpc.destroy();
      state.ipc = candidateIpc ?? undefined;
    }
  } catch (err) {
    rollbackPlugin?.();
    if (socketChanged && candidateIpc && candidateIpc !== previousIpc) {
      try {
        candidateIpc.destroy();
      } catch {
        // Preserve the original runtime-apply failure.
      }
    }
    throw err;
  }
}

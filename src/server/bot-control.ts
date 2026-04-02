/**
 * BotControlService — shared bot lifecycle actions.
 *
 * Centralizes restart / reimport / factory-reset / env-sync logic so that
 * both the Discord Panel and the Web Dashboard can trigger them through the
 * same service.  Dependency-injected `exit` keeps the class unit-testable.
 */

import { writeEnvValues } from '../utils/env-writer.js';

interface ActionMeta {
  source?: string;
  user?: string;
}

interface ExitActionResult {
  action: string;
  scheduledAt: string;
}

interface EnvSyncResult {
  action: 'env_sync';
  needed: boolean;
  currentVer?: string;
  targetVer?: string;
  added?: number;
  deprecated?: number;
}

interface BotControlDeps {
  exit?: (code: number) => void;
}

class BotControlService {
  private _exit: (code: number) => void;
  private _pendingAction: string | null;

  constructor(deps: BotControlDeps = {}) {
    this._exit =
      deps.exit ||
      ((code: number) => {
        process.exit(code);
      });
    this._pendingAction = null;
  }

  // ── Actions ────────────────────────────────────────────────

  restart(meta: ActionMeta = {}): ExitActionResult {
    return this._doExitAction('restart', meta);
  }

  factoryReset(meta: ActionMeta = {}): ExitActionResult {
    return this._doExitAction('factory_reset', meta, () => {
      writeEnvValues({ NUKE_BOT: 'true' });
    });
  }

  reimport(meta: ActionMeta = {}): ExitActionResult {
    return this._doExitAction('reimport', meta, () => {
      writeEnvValues({ FIRST_RUN: 'true' });
    });
  }

  envSync(): EnvSyncResult {
    // Lazy require — avoids circular dependency at startup
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { needsSync, syncEnv, getVersion, getExampleVersion } = require('../env-sync') as {
      needsSync: () => boolean;
      syncEnv: () => { added: number; deprecated: number };
      getVersion: () => string;
      getExampleVersion: () => string;
    };
    if (!needsSync()) {
      return { action: 'env_sync', needed: false };
    }
    const currentVer = getVersion();
    const targetVer = getExampleVersion();
    const result = syncEnv();
    return {
      action: 'env_sync',
      needed: true,
      currentVer,
      targetVer,
      added: result.added,
      deprecated: result.deprecated,
    };
  }

  // ── Accessors ──────────────────────────────────────────────

  get pendingAction(): string | null {
    return this._pendingAction;
  }

  // ── Internal ───────────────────────────────────────────────

  private _doExitAction(action: string, meta: ActionMeta, beforeExit?: () => void): ExitActionResult {
    this._guardPending();
    // Mark pending BEFORE side-effects so concurrent callers are blocked.
    // Roll back if beforeExit throws to avoid permanent lock.
    this._pendingAction = action;
    try {
      if (beforeExit) beforeExit();
    } catch (err) {
      this._pendingAction = null;
      throw err;
    }
    const scheduledAt = new Date().toISOString();
    const label = action.replace(/_/g, ' ');
    console.log(`[BOT-CONTROL] ${label} requested by ${meta.source || 'unknown'}${meta.user ? ` (${meta.user})` : ''}`);
    setTimeout(() => {
      this._exit(0);
    }, 1500);
    return { action, scheduledAt };
  }

  private _guardPending(): void {
    if (this._pendingAction) {
      const err = new Error(`Another action is already pending: ${this._pendingAction}`) as Error & { code: string };
      err.code = 'BOT_ACTION_PENDING';
      throw err;
    }
  }
}

export { BotControlService };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _mod = module as { exports: any };
_mod.exports = BotControlService;

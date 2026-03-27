/**
 * BotControlService — shared bot lifecycle actions.
 *
 * Centralizes restart / reimport / factory-reset / env-sync logic so that
 * both the Discord Panel and the Web Dashboard can trigger them through the
 * same service.  Dependency-injected `exit` keeps the class unit-testable.
 */

'use strict';

const { writeEnvValues } = require('../modules/panel-env');

class BotControlService {
  /**
   * @param {object} deps
   * @param {Function} [deps.exit] - Process exit function (default: process.exit)
   */
  constructor(deps = {}) {
    this._exit = deps.exit || ((code) => process.exit(code));
    this._pendingAction = null;
  }

  // ── Actions ────────────────────────────────────────────────

  /**
   * Restart the bot process. Exits with code 0 after a short delay.
   * @param {{ source?: string, user?: string }} meta - Who triggered this
   * @returns {{ action: 'restart', scheduledAt: string }}
   */
  restart(meta = {}) {
    return this._doExitAction('restart', meta);
  }

  /**
   * Factory reset: set NUKE_BOT=true in .env, then exit.
   * @param {{ source?: string, user?: string }} meta
   * @returns {{ action: 'factory_reset', scheduledAt: string }}
   */
  factoryReset(meta = {}) {
    return this._doExitAction('factory_reset', meta, () => writeEnvValues({ NUKE_BOT: 'true' }));
  }

  /**
   * Reimport: set FIRST_RUN=true in .env, then exit.
   * @param {{ source?: string, user?: string }} meta
   * @returns {{ action: 'reimport', scheduledAt: string }}
   */
  reimport(meta = {}) {
    return this._doExitAction('reimport', meta, () => writeEnvValues({ FIRST_RUN: 'true' }));
  }

  /**
   * Sync .env with .env.example. Does NOT restart.
   * Returns `{ needed: false }` when already up to date, or sync result details when changes were applied.
   * @returns {{ action: 'env_sync', needed: false } | { action: 'env_sync', needed: true, added: number, deprecated: number, currentVer: string, targetVer: string }}
   */
  envSync() {
    // Lazy require — matches existing pattern in panel-channel.js
    const { needsSync, syncEnv, getVersion, getExampleVersion } = require('../env-sync');
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

  /** @returns {string|null} Currently pending action name */
  get pendingAction() {
    return this._pendingAction;
  }

  // ── Internal ───────────────────────────────────────────────

  /**
   * Shared ceremony for actions that schedule a process exit.
   * @param {string} action - Action name (e.g. 'restart', 'reimport')
   * @param {{ source?: string, user?: string }} meta
   * @param {Function} [beforeExit] - Optional side-effect before scheduling exit
   * @returns {{ action: string, scheduledAt: string }}
   * @private
   */
  _doExitAction(action, meta, beforeExit) {
    this._guardPending();
    const scheduledAt = new Date().toISOString();
    const label = action.replace(/_/g, ' ');
    console.log(`[BOT-CONTROL] ${label} requested by ${meta.source || 'unknown'}${meta.user ? ` (${meta.user})` : ''}`);
    // Run side-effect BEFORE setting _pendingAction — if writeEnvValues throws,
    // we must not leave the service in a permanently locked state.
    if (beforeExit) beforeExit();
    this._pendingAction = action;
    setTimeout(() => this._exit(0), 1500);
    return { action, scheduledAt };
  }

  /** @private */
  _guardPending() {
    if (this._pendingAction) {
      throw new Error(`Another action is already pending: ${this._pendingAction}`);
    }
  }
}

module.exports = BotControlService;

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
    this._guardPending();
    this._pendingAction = 'restart';
    const scheduledAt = new Date().toISOString();
    console.log(`[BOT-CONTROL] Restart requested by ${meta.source || 'unknown'}${meta.user ? ` (${meta.user})` : ''}`);
    setTimeout(() => this._exit(0), 1500);
    return { action: 'restart', scheduledAt };
  }

  /**
   * Factory reset: set NUKE_BOT=true in .env, then exit.
   * @param {{ source?: string, user?: string }} meta
   * @returns {{ action: 'factory_reset', scheduledAt: string }}
   */
  factoryReset(meta = {}) {
    this._guardPending();
    this._pendingAction = 'factory_reset';
    const scheduledAt = new Date().toISOString();
    console.log(
      `[BOT-CONTROL] Factory reset requested by ${meta.source || 'unknown'}${meta.user ? ` (${meta.user})` : ''}`,
    );
    writeEnvValues({ NUKE_BOT: 'true' });
    setTimeout(() => this._exit(0), 1500);
    return { action: 'factory_reset', scheduledAt };
  }

  /**
   * Reimport: set FIRST_RUN=true in .env, then exit.
   * @param {{ source?: string, user?: string }} meta
   * @returns {{ action: 'reimport', scheduledAt: string }}
   */
  reimport(meta = {}) {
    this._guardPending();
    this._pendingAction = 'reimport';
    const scheduledAt = new Date().toISOString();
    console.log(`[BOT-CONTROL] Reimport requested by ${meta.source || 'unknown'}${meta.user ? ` (${meta.user})` : ''}`);
    writeEnvValues({ FIRST_RUN: 'true' });
    setTimeout(() => this._exit(0), 1500);
    return { action: 'reimport', scheduledAt };
  }

  /**
   * Sync .env with .env.example. Does NOT restart.
   * @returns {{ action: 'env_sync', needed: boolean, added?: number, deprecated?: number,
   *             currentVer?: string, targetVer?: string }}
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

  /** @private */
  _guardPending() {
    if (this._pendingAction) {
      throw new Error(`Another action is already pending: ${this._pendingAction}`);
    }
  }
}

module.exports = BotControlService;

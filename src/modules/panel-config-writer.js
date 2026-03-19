/**
 * Unified config update — writes to DB + optionally applies live to config singleton.
 *
 * Replaces the dual writeEnvValues() + applyLiveConfig() pattern with a single function
 * that handles both DB persistence and in-memory updates based on category restart requirements.
 */

'use strict';

const _defaultConfig = require('../config');
const { _coerce } = require('../db/config-migration');

// ── Unified config update ─────────────────────────────────────

/**
 * Unified config update: writes to DB + optionally applies live to config singleton.
 *
 * For categories that don't require restart (e.g. display toggles), the coerced value
 * is written to `config[field.cfg]` immediately AND persisted to the DB.
 *
 * For categories that require restart, values are only persisted to the DB.
 * The caller should inform the user that a restart is needed.
 *
 * @param {object} opts
 * @param {string} opts.scope - 'app' | 'server:primary' | 'server:<id>'
 * @param {Array<{field: object, value: string}>} opts.changes - field has {env, cfg, type, sensitive}
 * @param {boolean} opts.categoryRestart - whether the category requires restart
 * @param {import('../db/config-repository')} opts.configRepo
 * @param {object} [opts.liveConfig] - config object for live apply (default: main singleton)
 * @returns {{ applied: string[], requiresRestart: string[] }}
 */
function updateConfig({ scope, changes, categoryRestart, configRepo, liveConfig }) {
  const config = liveConfig || _defaultConfig;
  const patch = {};
  const applied = [];
  const requiresRestart = [];

  for (const { field, value } of changes) {
    if (!field.cfg) continue;

    const coerced = _coerce(value, field.type);
    patch[field.cfg] = coerced;

    if (!categoryRestart) {
      // Live-apply: update in-memory config immediately
      config[field.cfg] = coerced;
      applied.push(field.cfg);
    } else {
      requiresRestart.push(field.cfg);
    }
  }

  // Persist all changes to DB in a single merge-patch operation
  if (Object.keys(patch).length > 0) {
    configRepo.update(scope, patch);
  }

  return { applied, requiresRestart };
}

module.exports = { updateConfig };

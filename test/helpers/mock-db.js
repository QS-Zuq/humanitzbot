'use strict';

/**
 * Shared mock DB factory for tests.
 *
 * Provides a minimal in-memory state store with the same API surface as
 * HumanitZDB, plus optional method injection via the `extras` parameter.
 *
 * @param {object} opts
 * @param {Array}  [opts.players=[]]  - Rows returned by `getAllPlayers()`
 * @param {Array}  [opts.clans=[]]    - Rows returned by `getAllClans()`
 * @param {object} [opts.state=null]  - Initial state-store entries (key → value, auto-stringified)
 * @param {object} [opts.extras={}]   - Additional methods merged onto the mock
 * @returns {object} Mock DB instance
 */
function mockDb({ players = [], clans = [], state = null, extras = {} } = {}) {
  const store = new Map();

  // Seed initial state
  if (state && typeof state === 'object') {
    for (const [k, v] of Object.entries(state)) {
      store.set(k, JSON.stringify(v));
    }
  }

  return {
    getAllPlayers() {
      return players;
    },
    getAllClans() {
      return clans;
    },

    // ── State store ──────────────────────────────────────────
    getState(key) {
      return store.get(key) ?? null;
    },
    setState(key, value) {
      store.set(key, value != null ? String(value) : null);
    },
    getStateJSON(key, defaultVal = null) {
      const raw = store.get(key);
      if (raw == null) return defaultVal;
      try {
        return JSON.parse(raw);
      } catch {
        return defaultVal;
      }
    },
    setStateJSON(key, value) {
      store.set(key, JSON.stringify(value));
    },

    /** Escape hatch for tests that need to inspect the raw store */
    _store: store,

    // Merge caller-provided extras (e.g. getActivitySince, topKillers)
    ...extras,
  };
}

module.exports = { mockDb };

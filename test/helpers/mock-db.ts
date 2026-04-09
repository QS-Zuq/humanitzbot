interface MockDbOpts {
  players?: any[];
  clans?: any[];
  state?: Record<string, any> | null;
  extras?: Record<string, any>;
}

export function mockDb({ players = [], clans = [], state = null, extras = {} }: MockDbOpts = {}) {
  const store = new Map<string, string | null>();

  if (state && typeof state === 'object') {
    for (const [k, v] of Object.entries(state)) {
      store.set(k, typeof v === 'string' ? v : JSON.stringify(v));
    }
  }

  const stateAccessors = {
    getState(key: string) {
      return store.get(key) ?? null;
    },
    setState(key: string, value: any) {
      store.set(key, value != null ? String(value) : null);
    },
    getStateJSON(key: string, defaultVal: any = null) {
      const raw = store.get(key);
      if (raw == null) return defaultVal;
      try {
        return JSON.parse(raw);
      } catch {
        return defaultVal;
      }
    },
    setStateJSON(key: string, value: any) {
      store.set(key, JSON.stringify(value));
    },
  };

  return {
    // Repository getters (new pattern)
    player: {
      getAllPlayers() {
        return players;
      },
    },
    clan: {
      getAllClans() {
        return clans;
      },
    },
    // Legacy flat accessors (for backward compat with existing tests)
    getAllPlayers() {
      return players;
    },
    getAllClans() {
      return clans;
    },
    ...stateAccessors,
    _store: store,
    ...extras,
  };
}

// CJS compat
module.exports = { mockDb };

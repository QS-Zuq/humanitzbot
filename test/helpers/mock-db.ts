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
    getStateJSONValidated<T>(
      key: string,
      normalize: (raw: unknown) => { shape: T; issues: string[] },
      defaultVal: T,
    ): T {
      const raw = store.get(key);
      if (raw == null) return defaultVal;
      try {
        const parsed = JSON.parse(raw);
        return normalize(parsed).shape;
      } catch {
        return defaultVal;
      }
    },
    setStateJSON(key: string, value: any) {
      store.set(key, JSON.stringify(value));
    },
    setStateJSONValidated<T>(key: string, normalize: (raw: unknown) => { shape: T; issues: string[] }, value: T) {
      const { issues } = normalize(value);
      if (issues.length > 0) throw new Error(`bot_state.${key} failed validation: ${issues.join('; ')}`);
      store.set(key, JSON.stringify(value));
    },
  };

  const dbObj: Record<string, any> = {
    // Repository getters (new pattern)
    player: {
      getAllPlayers() {
        return players;
      },
      countAllPlayers() {
        return players.length;
      },
      listAllPlayerNames() {
        return players.map((p) => ({ steam_id: p.steam_id, name: p.name }));
      },
      listNamedPlayers() {
        return players.filter((p) => p.name).map((p) => ({ steam_id: p.steam_id, name: p.name }));
      },
    },
    clan: {
      getAllClans() {
        return clans;
      },
    },
    botState: stateAccessors,
    _store: store,
    ...extras,
  };
  dbObj.rawQuery = (sql: string, params: unknown[] = [], opts: { mode?: string } = {}) => {
    const stmt = dbObj.db?.prepare(sql);
    if (!stmt) return opts.mode === 'get' ? undefined : [];
    if (opts.mode === 'run') return stmt.run(...params);
    if (opts.mode === 'get') return stmt.get(...params);
    return stmt.all(...params);
  };
  return dbObj;
}

// CJS compat
module.exports = { mockDb };

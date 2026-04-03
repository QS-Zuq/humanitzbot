/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-floating-promises, @typescript-eslint/require-await, @typescript-eslint/no-dynamic-delete */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import * as _configMod from '../src/config/index.js';
const {
  _envBool: envBool,
  _envTime: envTime,
  _tzOffsetMs: tzOffsetMs,
  canShow,
  isAdminView,
  addAdminMembers,
} = _configMod as any;
const config = (_configMod as any).default;

// ══════════════════════════════════════════════════════════
// envBool — string to boolean coercion
// ══════════════════════════════════════════════════════════

describe('envBool', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved.TEST_BOOL = process.env.TEST_BOOL;
    delete process.env.TEST_BOOL;
  });

  afterEach(() => {
    if (saved.TEST_BOOL !== undefined) {
      process.env.TEST_BOOL = saved.TEST_BOOL;
    } else {
      delete process.env.TEST_BOOL;
    }
  });

  it('returns true when env is "true"', () => {
    process.env.TEST_BOOL = 'true';
    assert.equal(envBool('TEST_BOOL', false), true);
  });

  it('returns false when env is "false"', () => {
    process.env.TEST_BOOL = 'false';
    assert.equal(envBool('TEST_BOOL', true), false);
  });

  it('returns default when env is undefined', () => {
    delete process.env.TEST_BOOL;
    assert.equal(envBool('TEST_BOOL', true), true);
    assert.equal(envBool('TEST_BOOL', false), false);
  });

  it('returns default when env is empty string', () => {
    process.env.TEST_BOOL = '';
    assert.equal(envBool('TEST_BOOL', true), true);
  });

  it('treats non-"true" strings as false', () => {
    process.env.TEST_BOOL = 'yes';
    assert.equal(envBool('TEST_BOOL', true), false);
    process.env.TEST_BOOL = '1';
    assert.equal(envBool('TEST_BOOL', true), false);
    process.env.TEST_BOOL = 'TRUE';
    assert.equal(envBool('TEST_BOOL', true), false);
  });
});

// ══════════════════════════════════════════════════════════
// envTime — HH:MM string to total minutes
// ══════════════════════════════════════════════════════════

describe('envTime', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved.TEST_TIME = process.env.TEST_TIME;
    delete process.env.TEST_TIME;
  });

  afterEach(() => {
    if (saved.TEST_TIME !== undefined) {
      process.env.TEST_TIME = saved.TEST_TIME;
    } else {
      delete process.env.TEST_TIME;
    }
  });

  it('parses HH:MM format', () => {
    process.env.TEST_TIME = '22:30';
    assert.equal(envTime('TEST_TIME'), 22 * 60 + 30);
  });

  it('parses hour-only format', () => {
    process.env.TEST_TIME = '18';
    assert.equal(envTime('TEST_TIME'), 18 * 60);
  });

  it('parses midnight', () => {
    process.env.TEST_TIME = '0:00';
    assert.equal(envTime('TEST_TIME'), 0);
  });

  it('parses 23:59', () => {
    process.env.TEST_TIME = '23:59';
    assert.equal(envTime('TEST_TIME'), 23 * 60 + 59);
  });

  it('returns NaN for undefined env var', () => {
    assert.ok(isNaN(envTime('TEST_TIME')));
  });

  it('returns NaN for empty string', () => {
    process.env.TEST_TIME = '';
    assert.ok(isNaN(envTime('TEST_TIME')));
  });

  it('returns NaN for non-numeric input', () => {
    process.env.TEST_TIME = 'abc';
    assert.ok(isNaN(envTime('TEST_TIME')));
  });
});

// ══════════════════════════════════════════════════════════
// _tzOffsetMs — compute timezone offset from UTC
// ══════════════════════════════════════════════════════════

describe('_tzOffsetMs', () => {
  it('returns 0 for UTC', () => {
    const d = new Date('2026-02-13T12:00:00Z');
    assert.equal(tzOffsetMs(d, 'UTC'), 0);
  });

  it('returns positive offset for UTC+ timezones', () => {
    // Europe/Tallinn is UTC+2 (EET) or UTC+3 (EEST)
    // February = EET = UTC+2
    const d = new Date('2026-02-13T12:00:00Z');
    const offset = tzOffsetMs(d, 'Europe/Tallinn');
    assert.equal(offset, 2 * 60 * 60 * 1000); // +2h
  });

  it('returns negative offset for UTC- timezones', () => {
    // America/New_York is UTC-5 (EST) in February
    const d = new Date('2026-02-13T12:00:00Z');
    const offset = tzOffsetMs(d, 'America/New_York');
    assert.equal(offset, -5 * 60 * 60 * 1000); // -5h
  });

  it('accounts for DST changes', () => {
    // America/New_York: EST (UTC-5) in Jan, EDT (UTC-4) in Jul
    const winter = new Date('2026-01-15T12:00:00Z');
    const summer = new Date('2026-07-15T12:00:00Z');
    assert.equal(tzOffsetMs(winter, 'America/New_York'), -5 * 60 * 60 * 1000);
    assert.equal(tzOffsetMs(summer, 'America/New_York'), -4 * 60 * 60 * 1000);
  });
});

// ══════════════════════════════════════════════════════════
// parseLogTimestamp — log time → UTC Date
// ══════════════════════════════════════════════════════════

describe('parseLogTimestamp', () => {
  let savedLogTz: string;

  beforeEach(() => {
    savedLogTz = config.logTimezone;
  });

  afterEach(() => {
    config.logTimezone = savedLogTz;
  });

  it('treats log time as UTC when logTimezone is UTC', () => {
    config.logTimezone = 'UTC';
    const d = config.parseLogTimestamp('2026', '2', '13', '12', '35');
    assert.equal(d.toISOString(), '2026-02-13T12:35:00.000Z');
  });

  it('converts from UTC+2 correctly (Europe/Tallinn in winter)', () => {
    config.logTimezone = 'Europe/Tallinn';
    // Log says 14:00 in Tallinn (UTC+2) → should be 12:00 UTC
    const d = config.parseLogTimestamp('2026', '2', '13', '14', '0');
    assert.equal(d.toISOString(), '2026-02-13T12:00:00.000Z');
  });

  it('converts from UTC-5 correctly (America/New_York in winter)', () => {
    config.logTimezone = 'America/New_York';
    // Log says 07:00 in NY (UTC-5) → should be 12:00 UTC
    const d = config.parseLogTimestamp('2026', '2', '13', '7', '0');
    assert.equal(d.toISOString(), '2026-02-13T12:00:00.000Z');
  });

  it('handles DST: America/New_York summer (EDT = UTC-4)', () => {
    config.logTimezone = 'America/New_York';
    // Log says 08:00 in NY (UTC-4 in summer) → should be 12:00 UTC
    const d = config.parseLogTimestamp('2026', '7', '15', '8', '0');
    assert.equal(d.toISOString(), '2026-07-15T12:00:00.000Z');
  });

  it('handles midnight crossing (UTC+2 log at 01:00 → previous UTC day)', () => {
    config.logTimezone = 'Europe/Tallinn';
    // Log says 01:00 Feb 14 in Tallinn → 23:00 Feb 13 UTC
    const d = config.parseLogTimestamp('2026', '2', '14', '1', '0');
    assert.equal(d.toISOString(), '2026-02-13T23:00:00.000Z');
  });

  it('handles half-hour offset timezone (Asia/Kolkata = UTC+5:30)', () => {
    config.logTimezone = 'Asia/Kolkata';
    // Log says 17:30 in IST → 12:00 UTC
    const d = config.parseLogTimestamp('2026', '2', '13', '17', '30');
    assert.equal(d.toISOString(), '2026-02-13T12:00:00.000Z');
  });

  it('pads single-digit month and day', () => {
    config.logTimezone = 'UTC';
    const d = config.parseLogTimestamp('2026', '2', '3', '9', '5');
    assert.equal(d.toISOString(), '2026-02-03T09:05:00.000Z');
  });
});

// ══════════════════════════════════════════════════════════
// canShow — admin-only visibility helper
// ══════════════════════════════════════════════════════════

describe('canShow', () => {
  let saved: Record<string, unknown>;

  beforeEach(() => {
    saved = {
      showVitals: config.showVitals,
      showVitalsAdminOnly: config.showVitalsAdminOnly,
    };
  });

  afterEach(() => {
    config.showVitals = saved.showVitals;
    config.showVitalsAdminOnly = saved.showVitalsAdminOnly;
  });

  it('returns true when toggle is on and adminOnly is off', () => {
    config.showVitals = true;
    config.showVitalsAdminOnly = false;
    assert.equal(canShow('showVitals', false), true);
    assert.equal(canShow('showVitals', true), true);
  });

  it('returns false when toggle is off regardless of admin', () => {
    config.showVitals = false;
    config.showVitalsAdminOnly = false;
    assert.equal(canShow('showVitals', false), false);
    assert.equal(canShow('showVitals', true), false);
  });

  it('hides from non-admin when adminOnly is true', () => {
    config.showVitals = true;
    config.showVitalsAdminOnly = true;
    assert.equal(canShow('showVitals', false), false);
  });

  it('shows to admin when adminOnly is true', () => {
    config.showVitals = true;
    config.showVitalsAdminOnly = true;
    assert.equal(canShow('showVitals', true), true);
  });

  it('defaults isAdmin to false', () => {
    config.showVitals = true;
    config.showVitalsAdminOnly = true;
    assert.equal(canShow('showVitals'), false);
  });

  it('returns true when no adminOnly key exists and toggle is on', () => {
    // A toggle without a matching AdminOnly companion should still work
    config.someCustomToggle = true;
    assert.equal(canShow('someCustomToggle', false), true);
    delete config.someCustomToggle;
  });
});

// ══════════════════════════════════════════════════════════
// isAdminView — configurable permission check
// ══════════════════════════════════════════════════════════

describe('isAdminView', () => {
  let saved: string[];

  beforeEach(() => {
    saved = [...config.adminViewPermissions];
  });

  afterEach(() => {
    config.adminViewPermissions = saved;
  });

  it('returns false for null member', () => {
    assert.equal(isAdminView(null), false);
  });

  it('returns false for member without permissions', () => {
    assert.equal(isAdminView({}), false);
    assert.equal(isAdminView({ permissions: null }), false);
  });

  it('returns true when member has Administrator (default)', () => {
    config.adminViewPermissions = ['Administrator'];
    const member = { permissions: { has: (p: string) => p === 'Administrator' } };
    assert.equal(isAdminView(member), true);
  });

  it('returns false when member lacks the required permission', () => {
    config.adminViewPermissions = ['Administrator'];
    const member = { permissions: { has: () => false } };
    assert.equal(isAdminView(member), false);
  });

  it('matches any of multiple configured permissions', () => {
    config.adminViewPermissions = ['Administrator', 'ManageGuild'];
    const memberA = { permissions: { has: (p: string) => p === 'Administrator' } };
    const memberB = { permissions: { has: (p: string) => p === 'ManageGuild' } };
    const memberC = { permissions: { has: () => false } };
    assert.equal(isAdminView(memberA), true);
    assert.equal(isAdminView(memberB), true);
    assert.equal(isAdminView(memberC), false);
  });
});

// ══════════════════════════════════════════════════════════
// addAdminMembers — role + user ID thread auto-join
// ══════════════════════════════════════════════════════════

describe('addAdminMembers', () => {
  let saved: Record<string, string[]>;

  beforeEach(() => {
    saved = {
      adminUserIds: [...config.adminUserIds],
      adminRoleIds: [...config.adminRoleIds],
    };
  });

  afterEach(() => {
    config.adminUserIds = saved.adminUserIds;
    config.adminRoleIds = saved.adminRoleIds;
  });

  it('adds explicit user IDs to thread', async () => {
    config.adminUserIds = ['111', '222'];
    config.adminRoleIds = [];
    const added: string[] = [];
    const thread = {
      members: {
        add: (uid: string) => {
          added.push(uid);
          return Promise.resolve();
        },
      },
    };
    const guild = {};
    await addAdminMembers(thread, guild);
    assert.deepEqual(added, ['111', '222']);
  });

  it('adds role members to thread', async () => {
    config.adminUserIds = [];
    config.adminRoleIds = ['role1'];
    const added: string[] = [];
    const thread = {
      members: {
        add: (uid: string) => {
          added.push(uid);
          return Promise.resolve();
        },
      },
    };
    const roleMembers = new Map([
      ['user1', {}],
      ['user2', {}],
    ]);
    const guild = {
      roles: { cache: new Map([['role1', { members: roleMembers }]]) },
      members: {
        cache: new Map([
          ['a', {}],
          ['b', {}],
        ]),
      },
    };
    await addAdminMembers(thread, guild);
    assert.deepEqual(added, ['user1', 'user2']);
  });

  it('fetches role if not in cache', async () => {
    config.adminUserIds = [];
    config.adminRoleIds = ['role1'];
    const added: string[] = [];
    const thread = {
      members: {
        add: (uid: string) => {
          added.push(uid);
          return Promise.resolve();
        },
      },
    };
    const roleMembers = new Map([['user1', {}]]);
    const guild = {
      roles: {
        cache: new Map(),
        fetch: async (id: string) => (id === 'role1' ? { members: roleMembers } : null),
      },
      members: {
        cache: new Map([
          ['a', {}],
          ['b', {}],
        ]),
      },
    };
    await addAdminMembers(thread, guild);
    assert.deepEqual(added, ['user1']);
  });

  it('skips invalid role IDs gracefully', async () => {
    config.adminUserIds = [];
    config.adminRoleIds = ['badRole'];
    const added: string[] = [];
    const thread = {
      members: {
        add: (uid: string) => {
          added.push(uid);
          return Promise.resolve();
        },
      },
    };
    const guild = {
      roles: {
        cache: new Map(),
        fetch: async () => null,
      },
      members: { cache: new Map([['a', {}]]) },
    };
    await addAdminMembers(thread, guild);
    assert.deepEqual(added, []);
  });

  it('combines user IDs and role members', async () => {
    config.adminUserIds = ['explicit1'];
    config.adminRoleIds = ['role1'];
    const added: string[] = [];
    const thread = {
      members: {
        add: (uid: string) => {
          added.push(uid);
          return Promise.resolve();
        },
      },
    };
    const roleMembers = new Map([['roleUser1', {}]]);
    const guild = {
      roles: { cache: new Map([['role1', { members: roleMembers }]]) },
      members: {
        cache: new Map([
          ['a', {}],
          ['b', {}],
        ]),
      },
    };
    await addAdminMembers(thread, guild);
    assert.deepEqual(added, ['explicit1', 'roleUser1']);
  });
});

// ══════════════════════════════════════════════════════════
// config.hydrate() — DB-backed config hydration
// ══════════════════════════════════════════════════════════

describe('config.hydrate', () => {
  let saved: Record<string, unknown>;

  beforeEach(() => {
    saved = {
      rconHost: config.rconHost,
      rconPort: config.rconPort,
      rconPassword: config.rconPassword,
      showVitals: config.showVitals,
      _configRepo: config._configRepo,
    };
    delete config._configRepo;
  });

  afterEach(() => {
    config.rconHost = saved.rconHost;
    config.rconPort = saved.rconPort;
    config.rconPassword = saved.rconPassword;
    config.showVitals = saved.showVitals;
    config._configRepo = saved._configRepo;
  });

  /** Minimal stub matching ConfigRepository.get() contract */
  function mockRepo(docs: Record<string, unknown> = {}) {
    return {
      get(scope: string) {
        return (docs as any)[scope] || null;
      },
      update(scope: string, patch: Record<string, unknown>) {
        const existing = (docs as any)[scope] || {};
        (docs as any)[scope] = { ...existing, ...patch };
        return (docs as any)[scope];
      },
    };
  }

  it('sets values from app document', () => {
    const repo = mockRepo({ app: { showVitals: false } });
    config.showVitals = true;
    config.hydrate(repo);
    assert.equal(config.showVitals, false);
  });

  it('sets values from server:primary document', () => {
    const repo = mockRepo({ 'server:primary': { rconHost: '10.0.0.1' } });
    config.rconHost = '';
    config.hydrate(repo);
    assert.equal(config.rconHost, '10.0.0.1');
  });

  it('server:primary values override app values for same key', () => {
    const repo = mockRepo({
      app: { rconHost: 'from-app' },
      'server:primary': { rconHost: 'from-server' },
    });
    config.hydrate(repo);
    assert.equal(config.rconHost, 'from-server');
  });

  it('ignores unknown DB keys not present in config', () => {
    const repo = mockRepo({ app: { _totallyFakeKey_xyz: 42 } });
    config.hydrate(repo);
    assert.equal(config._totallyFakeKey_xyz, undefined);
  });

  it('preserves config reference identity', () => {
    const ref = config;
    const repo = mockRepo({ app: { showVitals: true } });
    config.hydrate(repo);
    assert.equal(config, ref);
  });

  it('handles null/empty documents gracefully (no-op)', () => {
    const repo = mockRepo({});
    config.rconHost = 'original';
    config.hydrate(repo);
    assert.equal(config.rconHost, 'original');
  });

  it('stores _configRepo reference after hydrate', () => {
    const repo = mockRepo({});
    config.hydrate(repo);
    assert.equal(config._configRepo, repo);
  });
});

// ══════════════════════════════════════════════════════════
// config.needsSetup — lazy getter
// ══════════════════════════════════════════════════════════

describe('config.needsSetup (getter)', () => {
  let saved: Record<string, unknown>;

  beforeEach(() => {
    saved = {
      rconHost: config.rconHost,
      rconPassword: config.rconPassword,
    };
  });

  afterEach(() => {
    // Restore: delete any direct assignment, then re-define getter if needed
    delete config.needsSetup;
    // If it was a plain value before, restore the getter
    if (!Object.getOwnPropertyDescriptor(config, 'needsSetup')?.get) {
      Object.defineProperty(config, 'needsSetup', {
        get() {
          return (
            !config.rconHost ||
            !config.rconPassword ||
            config.rconHost.startsWith('your_') ||
            config.rconPassword.startsWith('your_')
          );
        },
        configurable: true,
        enumerable: true,
      });
    }
    config.rconHost = saved.rconHost;
    config.rconPassword = saved.rconPassword;
  });

  it('returns true when rconHost is empty', () => {
    config.rconHost = '';
    config.rconPassword = 'secret';
    assert.equal(config.needsSetup, true);
  });

  it('returns true when rconPassword is empty', () => {
    config.rconHost = '10.0.0.1';
    config.rconPassword = '';
    assert.equal(config.needsSetup, true);
  });

  it('returns true when rconHost starts with your_', () => {
    config.rconHost = 'your_server_ip';
    config.rconPassword = 'secret';
    assert.equal(config.needsSetup, true);
  });

  it('returns false when RCON is properly configured', () => {
    config.rconHost = '10.0.0.1';
    config.rconPassword = 'secret';
    assert.equal(config.needsSetup, false);
  });

  it('evaluates lazily — reflects hydrate changes', () => {
    config.rconHost = '';
    config.rconPassword = '';
    assert.equal(config.needsSetup, true);

    // Simulate hydrate setting values
    config.rconHost = '10.0.0.1';
    config.rconPassword = 'secret';
    assert.equal(config.needsSetup, false);
  });

  it('needsSetup is read-only derived state', () => {
    config.rconHost = '';
    assert.strictEqual(config.needsSetup, true);
    config.rconHost = '127.0.0.1';
    config.rconPassword = 'secret';
    assert.strictEqual(config.needsSetup, false);
  });

  it('needsSetup ignores direct assignment (setter removed)', () => {
    // Ensure needsSetup is currently true (no RCON configured)
    config.rconHost = '';
    config.rconPassword = '';
    assert.strictEqual(config.needsSetup, true);

    // Direct assignment should have no effect (getter-only)
    config.needsSetup = false;
    assert.strictEqual(config.needsSetup, true, 'needsSetup should still be true — setter was removed');
  });
});

// ══════════════════════════════════════════════════════════
// saveDisplaySetting / saveDisplaySettings — dual-path writes
// ══════════════════════════════════════════════════════════

describe('saveDisplaySetting / saveDisplaySettings', () => {
  let saved: Record<string, unknown>;

  beforeEach(() => {
    saved = {
      showVitals: config.showVitals,
      showInventory: config.showInventory,
      _configRepo: config._configRepo,
    };
    delete config._configRepo;
  });

  afterEach(() => {
    config.showVitals = saved.showVitals;
    config.showInventory = saved.showInventory;
    config._configRepo = saved._configRepo;
  });

  /** Minimal ConfigRepository stub that records update() calls */
  function mockRepo() {
    const calls: Array<{ scope: string; patch: unknown }> = [];
    return {
      calls,
      get() {
        return null;
      },
      update(scope: string, patch: unknown) {
        calls.push({ scope, patch });
        return patch;
      },
    };
  }

  /** Minimal DB stub for legacy bot_state fallback */
  function mockDb() {
    const state: Record<string, unknown> = {};
    return {
      state,
      getStateJSON(key: string, def: unknown) {
        return state[key] !== undefined ? state[key] : def;
      },
      setStateJSON(key: string, value: unknown) {
        state[key] = value;
      },
    };
  }

  it('saveDisplaySetting with configRepo: writes to config_documents', () => {
    const repo = mockRepo();
    config._configRepo = repo;
    config.saveDisplaySetting(null, 'showVitals', false);
    assert.equal(config.showVitals, false);
    assert.equal(repo.calls.length, 1);
    assert.deepEqual(repo.calls[0], { scope: 'app', patch: { showVitals: false } });
  });

  it('saveDisplaySetting without configRepo: falls back to bot_state', () => {
    delete config._configRepo;
    const db = mockDb();
    config.saveDisplaySetting(db, 'showVitals', true);
    assert.equal(config.showVitals, true);
    assert.deepEqual(db.state.display_settings, { showVitals: true });
  });

  it('saveDisplaySettings batch: writes multiple keys via configRepo', () => {
    const repo = mockRepo();
    config._configRepo = repo;
    config.saveDisplaySettings(null, { showVitals: false, showInventory: true });
    assert.equal(config.showVitals, false);
    assert.equal(config.showInventory, true);
    assert.equal(repo.calls.length, 1);
    assert.deepEqual(repo.calls[0], {
      scope: 'app',
      patch: { showVitals: false, showInventory: true },
    });
  });

  it('saveDisplaySettings without configRepo: falls back to bot_state', () => {
    delete config._configRepo;
    const db = mockDb();
    config.saveDisplaySettings(db, { showVitals: false, showInventory: true });
    assert.equal(config.showVitals, false);
    assert.equal(config.showInventory, true);
    assert.deepEqual(db.state.display_settings, { showVitals: false, showInventory: true });
  });

  it('loadDisplayOverrides is a no-op', () => {
    config.showVitals = true;
    config.loadDisplayOverrides({ getStateJSON: () => ({ showVitals: false }) });
    assert.equal(config.showVitals, true); // Unchanged — no-op
  });
});

// ══════════════════════════════════════════════════════════
// FTP→SFTP backward compatibility — env fallback pattern
// ══════════════════════════════════════════════════════════

describe('FTP\u2192SFTP backward compatibility', () => {
  const configPath = require.resolve('../src/config');
  let savedModule: unknown;
  const savedEnv: Record<string, string | undefined> = {};

  // Env vars we manipulate — save and restore in each test
  const MANAGED_KEYS = [
    'SFTP_HOST',
    'FTP_HOST',
    'SFTP_PORT',
    'FTP_PORT',
    'SFTP_USER',
    'FTP_USER',
    'SFTP_PASSWORD',
    'FTP_PASSWORD',
  ];

  beforeEach(() => {
    savedModule = require.cache[configPath];
    for (const key of MANAGED_KEYS) {
      savedEnv[key] = process.env[key];
    }
  });

  afterEach(() => {
    for (const key of MANAGED_KEYS) {
      if (savedEnv[key] !== undefined) {
        process.env[key] = savedEnv[key];
      } else {
        delete process.env[key];
      }
    }
    // Restore original module so other tests use the original singleton
    require.cache[configPath] = savedModule as any;
  });

  /** Delete config from require cache and re-require with current process.env */
  function reloadConfig() {
    delete require.cache[configPath];

    // eslint-disable-next-line @typescript-eslint/no-require-imports -- dynamic require for test isolation
    return require(configPath);
  }

  it('falls back to FTP_HOST when SFTP_HOST is not set', () => {
    process.env.SFTP_HOST = ''; // empty = falsy, but prevents dotenv overwrite
    process.env.FTP_HOST = 'ftp-fallback-host';
    const cfg = reloadConfig();
    assert.equal(cfg.sftpHost, 'ftp-fallback-host');
  });

  it('prefers SFTP_HOST over FTP_HOST when both are set', () => {
    process.env.SFTP_HOST = 'sftp-primary-host';
    process.env.FTP_HOST = 'ftp-fallback-host';
    const cfg = reloadConfig();
    assert.equal(cfg.sftpHost, 'sftp-primary-host');
  });

  it('falls back to FTP_PORT when SFTP_PORT is not set', () => {
    process.env.SFTP_PORT = '';
    process.env.FTP_PORT = '9999';
    const cfg = reloadConfig();
    assert.equal(cfg.sftpPort, 9999);
  });

  it('falls back to FTP_USER when SFTP_USER is not set', () => {
    process.env.SFTP_USER = '';
    process.env.FTP_USER = 'ftp-user-fallback';
    const cfg = reloadConfig();
    assert.equal(cfg.sftpUser, 'ftp-user-fallback');
  });

  it('falls back to FTP_PASSWORD when SFTP_PASSWORD is not set', () => {
    process.env.SFTP_PASSWORD = '';
    process.env.FTP_PASSWORD = 'ftp-pass-fallback';
    const cfg = reloadConfig();
    assert.equal(cfg.sftpPassword, 'ftp-pass-fallback');
  });
});

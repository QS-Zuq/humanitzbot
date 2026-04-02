/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any, @typescript-eslint/no-require-imports, @typescript-eslint/no-floating-promises, @typescript-eslint/restrict-template-expressions */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const HumanitZDB = require('../src/db/database');

const ConfigRepository = require('../src/db/config-repository');

const {
  BOOTSTRAP_KEYS,
  buildMigrationMap,
  migrateEnvToDb,
  migrateServersJsonToDb,
  migrateDisplaySettings,
  _coerce,
} = require('../src/db/config-migration');

describe('config-migration', () => {
  let db: any;
  let repo: any;

  beforeEach(() => {
    db = new HumanitZDB({ memory: true, label: 'MigrationTest' });
    db.init();
    repo = new ConfigRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  // ── 1. Migration map coverage ───────────────────────────────

  it('buildMigrationMap() covers all ENV_CATEGORIES fields except bootstrap', () => {
    const map = buildMigrationMap();
    const keys = Object.keys(map);

    // Should have a reasonable number of mapped keys
    assert.ok(keys.length > 50, `Expected >50 mapped keys, got ${keys.length}`);

    // No bootstrap keys should be in the map
    for (const bk of BOOTSTRAP_KEYS) {
      assert.ok(!map[bk], `Bootstrap key ${bk} should not be in migration map`);
    }

    // Known keys should exist
    assert.ok(map['RCON_HOST'], 'RCON_HOST should be in map');
    assert.ok(map['SHOW_VITALS'], 'SHOW_VITALS should be in map');
    assert.ok(map['ENABLE_CHAT_RELAY'], 'ENABLE_CHAT_RELAY should be in map');
  });

  // ── 2. Scope assignment ─────────────────────────────────────

  it('assigns RCON/SFTP/channel keys to server:primary, others to app', () => {
    const map = buildMigrationMap();

    // Server-scoped
    assert.equal(map['RCON_HOST'].scope, 'server:primary');
    assert.equal(map['RCON_PORT'].scope, 'server:primary');
    assert.equal(map['SFTP_HOST'].scope, 'server:primary');
    assert.equal(map['SFTP_PORT'].scope, 'server:primary');
    assert.equal(map['CHAT_CHANNEL_ID'].scope, 'server:primary');
    assert.equal(map['ADMIN_CHANNEL_ID'].scope, 'server:primary');

    // App-scoped
    assert.equal(map['SHOW_VITALS'].scope, 'app');
    assert.equal(map['ENABLE_CHAT_RELAY'].scope, 'app');
    assert.equal(map['SERVER_STATUS_INTERVAL'].scope, 'app');
  });

  // ── 3. Type coercion ────────────────────────────────────────

  it('migrateEnvToDb() coerces types: bool→boolean, int→number', () => {
    migrateEnvToDb(
      {
        SHOW_VITALS: 'true',
        ENABLE_CHAT_RELAY: 'false',
        SERVER_STATUS_INTERVAL: '5000',
        SERVER_NAME: 'MyServer',
        RCON_HOST: '192.168.1.100',
        RCON_PORT: '27015',
      },
      repo,
    );

    const app = repo.get('app');
    assert.equal(app.showVitals, true);
    assert.equal(app.enableChatRelay, false);
    assert.equal(app.serverStatusInterval, 5000);
    assert.equal(app.serverName, 'MyServer');

    const srv = repo.get('server:primary');
    assert.equal(srv.rconHost, '192.168.1.100');
    assert.equal(srv.rconPort, 27015);
  });

  // ── 4. NESTED serverDef preserved ───────────────────────────

  it('migrateServersJsonToDb() stores NESTED serverDef as-is', () => {
    const serverDefs = [
      {
        id: 'srv_001',
        name: 'Test Server',
        rcon: { host: '10.0.0.1', port: 27015, password: 'secret' },
        sftp: { host: '10.0.0.1', port: 22, user: 'admin', password: 'pass' },
        channels: { chat: '123', log: '456' },
      },
      {
        id: 'srv_002',
        name: 'Server 2',
        rcon: { host: '10.0.0.2', port: 27016 },
      },
    ];

    const count = migrateServersJsonToDb(serverDefs, repo);
    assert.equal(count, 2);

    const srv1 = repo.get('server:srv_001');
    assert.equal(srv1.id, 'srv_001');
    assert.equal(srv1.rcon.host, '10.0.0.1');
    assert.equal(srv1.rcon.port, 27015);
    assert.equal(srv1.sftp.user, 'admin');
    assert.deepStrictEqual(srv1.channels, { chat: '123', log: '456' });

    const srv2 = repo.get('server:srv_002');
    assert.equal(srv2.name, 'Server 2');
    assert.equal(srv2.rcon.host, '10.0.0.2');
  });

  // ── 5. displaySettings merge ────────────────────────────────

  it('migrateDisplaySettings() merges bot_state.display_settings into app', () => {
    // Pre-populate app scope
    repo.set('app', { serverName: 'Existing', enableChatRelay: true });

    // Set display_settings in bot_state
    db.setStateJSON('display_settings', {
      showVitals: false,
      showInventory: true,
    });

    const count = migrateDisplaySettings(db, repo);
    assert.equal(count, 2);

    const app = repo.get('app');
    // Merged values
    assert.equal(app.showVitals, false);
    assert.equal(app.showInventory, true);
    // Existing values preserved
    assert.equal(app.serverName, 'Existing');
    assert.equal(app.enableChatRelay, true);
  });

  // ── 6. Idempotent migration ─────────────────────────────────

  it('migrateEnvToDb() is idempotent — repeated calls produce same result', () => {
    const envValues = {
      SHOW_VITALS: 'true',
      SERVER_NAME: 'Test',
      RCON_HOST: '10.0.0.1',
    };

    migrateEnvToDb(envValues, repo);
    const firstApp = repo.get('app');
    const firstSrv = repo.get('server:primary');

    migrateEnvToDb(envValues, repo);
    const secondApp = repo.get('app');
    const secondSrv = repo.get('server:primary');

    assert.deepStrictEqual(firstApp, secondApp);
    assert.deepStrictEqual(firstSrv, secondSrv);
  });

  // ── 7. Empty values skipped ─────────────────────────────────

  it('migrateEnvToDb() skips empty/null values', () => {
    const result = migrateEnvToDb(
      {
        SHOW_VITALS: '',
        SERVER_NAME: '',
        RCON_HOST: '10.0.0.1',
        UNKNOWN_KEY: 'ignored',
      },
      repo,
    );

    // Only RCON_HOST should be written
    assert.equal(result.serverKeys, 1);
    assert.equal(result.appKeys, 0);
    assert.ok(result.skipped >= 2, 'Empty values + unknown keys should be skipped');

    assert.equal(repo.get('app'), null);
    assert.deepStrictEqual(repo.get('server:primary'), { rconHost: '10.0.0.1' });
  });

  // ── 8. _coerce helper ──────────────────────────────────────

  it('_coerce handles bool, int, and string types', () => {
    assert.equal(_coerce('true', 'bool'), true);
    assert.equal(_coerce('false', 'bool'), false);
    assert.equal(_coerce('5000', 'int'), 5000);
    assert.equal(_coerce('abc', 'int'), 'abc'); // NaN fallback
    assert.equal(_coerce('hello', 'string'), 'hello');
    assert.equal(_coerce('hello', undefined), 'hello'); // default = string
  });
});

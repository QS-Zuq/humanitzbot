/**
 * Tests for env-sync.js — .env synchronization and v5 DB migration.
 * Run: npm test
 */
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const envSync = require('../src/env-sync');

// ── Helpers ──────────────────────────────────────────────────
let tmpDir;

function setupTmp() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-sync-test-'));
  const backupDir = path.join(tmpDir, 'backups');
  envSync._test.setPaths({
    envPath: path.join(tmpDir, '.env'),
    examplePath: path.join(tmpDir, '.env.example'),
    backupDir,
  });
  return { envPath: path.join(tmpDir, '.env'), examplePath: path.join(tmpDir, '.env.example'), backupDir };
}

function teardownTmp() {
  envSync._test.resetPaths();
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  tmpDir = null;
}

// ══════════════════════════════════════════════════════════
// parseEnv
// ══════════════════════════════════════════════════════════

describe('parseEnv', () => {
  afterEach(teardownTmp);

  it('parses active key=value pairs', () => {
    const { envPath } = setupTmp();
    fs.writeFileSync(envPath, 'FOO=bar\nBAZ=123\n');
    const result = envSync.parseEnv(envPath);
    assert.equal(result.entries.get('FOO').value, 'bar');
    assert.equal(result.entries.get('BAZ').value, '123');
  });

  it('extracts ENV_SCHEMA_VERSION', () => {
    const { envPath } = setupTmp();
    fs.writeFileSync(envPath, 'ENV_SCHEMA_VERSION=4\nFOO=bar\n');
    const result = envSync.parseEnv(envPath);
    assert.equal(result.version, '4');
  });

  it('parses commented keys when includeCommented=true', () => {
    const { envPath } = setupTmp();
    fs.writeFileSync(envPath, '#OPTIONAL_KEY=default\nACTIVE=yes\n');
    const result = envSync.parseEnv(envPath, { includeCommented: true });
    assert.ok(result.entries.has('OPTIONAL_KEY'));
    assert.equal(result.entries.get('OPTIONAL_KEY').commented, true);
    assert.equal(result.entries.get('ACTIVE').commented, false);
  });

  it('returns empty map for missing file', () => {
    setupTmp();
    const result = envSync.parseEnv('/nonexistent/.env');
    assert.equal(result.entries.size, 0);
    assert.equal(result.version, null);
  });
});

// ══════════════════════════════════════════════════════════
// needsSync
// ══════════════════════════════════════════════════════════

describe('needsSync', () => {
  afterEach(teardownTmp);

  it('returns true when .env is missing', () => {
    const { examplePath } = setupTmp();
    fs.writeFileSync(examplePath, 'ENV_SCHEMA_VERSION=5\n');
    assert.equal(envSync.needsSync(), true);
  });

  it('returns true when schema versions differ', () => {
    const { envPath, examplePath } = setupTmp();
    fs.writeFileSync(envPath, 'ENV_SCHEMA_VERSION=4\nDISCORD_TOKEN=abc\n');
    fs.writeFileSync(examplePath, 'ENV_SCHEMA_VERSION=5\nDISCORD_TOKEN=placeholder\n');
    assert.equal(envSync.needsSync(), true);
  });

  it('returns false when versions match and all keys present', () => {
    const { envPath, examplePath } = setupTmp();
    fs.writeFileSync(envPath, 'ENV_SCHEMA_VERSION=5\nDISCORD_TOKEN=mytoken\n');
    fs.writeFileSync(examplePath, 'ENV_SCHEMA_VERSION=5\nDISCORD_TOKEN=placeholder\n');
    assert.equal(envSync.needsSync(), false);
  });
});

// ══════════════════════════════════════════════════════════
// syncEnv — v5 DB migration
// ══════════════════════════════════════════════════════════

describe('syncEnv', () => {
  afterEach(teardownTmp);

  it('comments out non-bootstrap keys with [Migrated to DB] prefix', () => {
    const { envPath, examplePath } = setupTmp();
    // Old v4 .env with many keys
    fs.writeFileSync(
      envPath,
      [
        'ENV_SCHEMA_VERSION=4',
        'DISCORD_TOKEN=real_token',
        'DISCORD_CLIENT_ID=123',
        'DISCORD_GUILD_ID=456',
        'PANEL_CHANNEL_ID=789',
        'RCON_HOST=10.0.0.1',
        'RCON_PORT=8888',
        'RCON_PASSWORD=secret',
        'ENABLE_CHAT_RELAY=true',
        'BOT_TIMEZONE=UTC',
        'NUKE_BOT=false',
        '',
      ].join('\n'),
    );
    // New v5 .env.example (bootstrap only)
    fs.writeFileSync(
      examplePath,
      [
        'ENV_SCHEMA_VERSION=5',
        '# ── Discord Bot (required) ───────────────────────────────────',
        'DISCORD_TOKEN=your_discord_bot_token_here',
        'DISCORD_CLIENT_ID=your_discord_client_id_here',
        'DISCORD_GUILD_ID=your_discord_guild_id_here',
        'PANEL_CHANNEL_ID=',
        '# ── Web Dashboard (optional) ────────────────────────────────',
        '#WEB_MAP_PORT=3000',
        'NUKE_BOT=false',
        '',
      ].join('\n'),
    );

    const result = envSync.syncEnv();
    const content = fs.readFileSync(envPath, 'utf8');

    // Bootstrap keys stay active with user values
    assert.match(content, /^DISCORD_TOKEN=real_token$/m);
    assert.match(content, /^DISCORD_CLIENT_ID=123$/m);
    assert.match(content, /^DISCORD_GUILD_ID=456$/m);
    assert.match(content, /^PANEL_CHANNEL_ID=789$/m);
    assert.match(content, /^NUKE_BOT=false$/m);

    // Non-bootstrap keys are commented with migration prefix
    assert.match(content, /^# \[Migrated to DB\] RCON_HOST=10\.0\.0\.1$/m);
    assert.match(content, /^# \[Migrated to DB\] RCON_PORT=8888$/m);
    assert.match(content, /^# \[Migrated to DB\] RCON_PASSWORD=secret$/m);
    assert.match(content, /^# \[Migrated to DB\] ENABLE_CHAT_RELAY=true$/m);
    assert.match(content, /^# \[Migrated to DB\] BOT_TIMEZONE=UTC$/m);

    // Schema version is bumped to 5
    assert.match(content, /^ENV_SCHEMA_VERSION=5$/m);

    // Section header mentions DB migration
    assert.match(content, /Migrated to Database/);

    assert.ok(result.deprecated >= 5);
  });

  it('preserves dynamic keys (RESTART_PROFILE_, PVP_HOURS_)', () => {
    const { envPath, examplePath } = setupTmp();
    fs.writeFileSync(
      envPath,
      [
        'ENV_SCHEMA_VERSION=4',
        'DISCORD_TOKEN=tok',
        'RESTART_PROFILE_CALM=setting1',
        'PVP_HOURS_MON=18:00-22:00',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(examplePath, ['ENV_SCHEMA_VERSION=5', 'DISCORD_TOKEN=placeholder', ''].join('\n'));

    envSync.syncEnv();
    const content = fs.readFileSync(envPath, 'utf8');

    // Dynamic keys preserved as active (not commented)
    assert.match(content, /^RESTART_PROFILE_CALM=setting1$/m);
    assert.match(content, /^PVP_HOURS_MON=18:00-22:00$/m);
  });

  it('creates a backup of the old .env', () => {
    const { envPath, examplePath, backupDir } = setupTmp();
    fs.writeFileSync(envPath, 'ENV_SCHEMA_VERSION=4\nDISCORD_TOKEN=tok\n');
    fs.writeFileSync(examplePath, 'ENV_SCHEMA_VERSION=5\nDISCORD_TOKEN=placeholder\n');

    envSync.syncEnv();

    assert.ok(fs.existsSync(backupDir), 'backup directory should exist');
    const backups = fs.readdirSync(backupDir).filter((f) => f.startsWith('.env.backup.'));
    assert.ok(backups.length >= 1, 'should have at least one backup file');
  });

  it('prunes backups to keep only the 2 most recent', () => {
    const { envPath, examplePath, backupDir } = setupTmp();
    fs.mkdirSync(backupDir, { recursive: true });
    // Create 3 pre-existing backups
    fs.writeFileSync(path.join(backupDir, '.env.backup.1000'), 'old1');
    fs.writeFileSync(path.join(backupDir, '.env.backup.2000'), 'old2');
    fs.writeFileSync(path.join(backupDir, '.env.backup.3000'), 'old3');

    fs.writeFileSync(envPath, 'ENV_SCHEMA_VERSION=4\nDISCORD_TOKEN=tok\n');
    fs.writeFileSync(examplePath, 'ENV_SCHEMA_VERSION=5\nDISCORD_TOKEN=placeholder\n');

    envSync.syncEnv();

    const remaining = fs.readdirSync(backupDir).filter((f) => f.startsWith('.env.backup.'));
    assert.ok(remaining.length <= 2, `should keep at most 2 backups, got ${remaining.length}`);
  });

  it('adds missing required keys from .env.example', () => {
    const { envPath, examplePath } = setupTmp();
    // .env missing DISCORD_GUILD_ID
    fs.writeFileSync(envPath, 'ENV_SCHEMA_VERSION=4\nDISCORD_TOKEN=tok\n');
    fs.writeFileSync(examplePath, 'ENV_SCHEMA_VERSION=5\nDISCORD_TOKEN=placeholder\nDISCORD_GUILD_ID=your_guild_id\n');

    const result = envSync.syncEnv();
    const content = fs.readFileSync(envPath, 'utf8');

    assert.match(content, /^DISCORD_GUILD_ID=your_guild_id$/m);
    assert.equal(result.added, 1);
  });

  it('throws when .env.example is missing', () => {
    setupTmp();
    // Don't write .env.example
    assert.throws(() => envSync.syncEnv(), /\.env\.example not found/);
  });
});

// ══════════════════════════════════════════════════════════
// getVersion / getExampleVersion
// ══════════════════════════════════════════════════════════

describe('getVersion / getExampleVersion', () => {
  afterEach(teardownTmp);

  it('returns schema version from .env', () => {
    const { envPath } = setupTmp();
    fs.writeFileSync(envPath, 'ENV_SCHEMA_VERSION=5\n');
    assert.equal(envSync.getVersion(), '5');
  });

  it('returns 0 when .env has no version', () => {
    const { envPath } = setupTmp();
    fs.writeFileSync(envPath, 'FOO=bar\n');
    assert.equal(envSync.getVersion(), '0');
  });

  it('returns example schema version', () => {
    const { examplePath } = setupTmp();
    fs.writeFileSync(examplePath, 'ENV_SCHEMA_VERSION=5\n');
    assert.equal(envSync.getExampleVersion(), '5');
  });
});

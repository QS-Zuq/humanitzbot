/**
 * Tests for panel-config-writer — unified updateConfig() function.
 * Run: node --test test/panel-config-writer.test.js
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const HumanitZDB = require('../src/db/database');
const ConfigRepository = require('../src/db/config-repository');
const { updateConfig } = require('../src/modules/panel-config-writer');
const { _coerce } = require('../src/db/config-migration');

describe('panel-config-writer', () => {
  /** @type {import('../src/db/database')} */
  let db;
  /** @type {ConfigRepository} */
  let repo;

  beforeEach(() => {
    db = new HumanitZDB({ memory: true, label: 'PanelConfigWriterTest' });
    db.init();
    repo = new ConfigRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  // ── _coerce ─────────────────────────────────────────────────

  describe('_coerce', () => {
    it('converts "true" to boolean true for bool type', () => {
      assert.strictEqual(_coerce('true', 'bool'), true);
    });

    it('converts "false" to boolean false for bool type', () => {
      assert.strictEqual(_coerce('false', 'bool'), false);
    });

    it('converts numeric string to number for int type', () => {
      assert.strictEqual(_coerce('42', 'int'), 42);
    });

    it('returns original string for non-numeric int type', () => {
      assert.strictEqual(_coerce('abc', 'int'), 'abc');
    });

    it('returns string as-is for string type', () => {
      assert.strictEqual(_coerce('hello', 'string'), 'hello');
    });

    it('returns string as-is for undefined type', () => {
      assert.strictEqual(_coerce('hello', undefined), 'hello');
    });
  });

  // ── updateConfig — live apply ───────────────────────────────

  describe('updateConfig — live apply (no restart)', () => {
    it('applies changes to config + writes to DB', () => {
      const config = { showVitals: false, showLore: true };
      const changes = [
        { field: { env: 'SHOW_VITALS', cfg: 'showVitals', type: 'bool' }, value: 'true' },
        { field: { env: 'SHOW_LORE', cfg: 'showLore', type: 'bool' }, value: 'false' },
      ];

      const result = updateConfig({
        scope: 'app',
        changes,
        categoryRestart: false,
        configRepo: repo,
        liveConfig: config,
      });

      // In-memory config updated
      assert.strictEqual(config.showVitals, true);
      assert.strictEqual(config.showLore, false);

      // DB persisted
      const dbData = repo.get('app');
      assert.strictEqual(dbData.showVitals, true);
      assert.strictEqual(dbData.showLore, false);

      // Return value
      assert.deepStrictEqual(result.applied, ['showVitals', 'showLore']);
      assert.deepStrictEqual(result.requiresRestart, []);
    });
  });

  // ── updateConfig — restart required ─────────────────────────

  describe('updateConfig — restart required', () => {
    it('writes to DB but does NOT update config in memory', () => {
      const config = { rconHost: '127.0.0.1', rconPort: 7777 };
      const changes = [
        { field: { env: 'RCON_HOST', cfg: 'rconHost', type: 'string' }, value: '192.168.1.100' },
        { field: { env: 'RCON_PORT', cfg: 'rconPort', type: 'int' }, value: '9999' },
      ];

      const result = updateConfig({
        scope: 'server:primary',
        changes,
        categoryRestart: true,
        configRepo: repo,
        liveConfig: config,
      });

      // In-memory config NOT updated
      assert.strictEqual(config.rconHost, '127.0.0.1');
      assert.strictEqual(config.rconPort, 7777);

      // DB persisted
      const dbData = repo.get('server:primary');
      assert.strictEqual(dbData.rconHost, '192.168.1.100');
      assert.strictEqual(dbData.rconPort, 9999);

      // Return value
      assert.deepStrictEqual(result.applied, []);
      assert.deepStrictEqual(result.requiresRestart, ['rconHost', 'rconPort']);
    });
  });

  // ── updateConfig — fields without cfg are skipped ───────────

  describe('updateConfig — no-cfg fields', () => {
    it('skips fields that lack a cfg key', () => {
      const config = {};
      const changes = [
        { field: { env: 'PVP_START_TIME', type: 'string' }, value: '18:00' },
        { field: { env: 'SHOW_VITALS', cfg: 'showVitals', type: 'bool' }, value: 'true' },
      ];

      const result = updateConfig({
        scope: 'app',
        changes,
        categoryRestart: false,
        configRepo: repo,
        liveConfig: config,
      });

      // Only field with cfg was applied
      assert.deepStrictEqual(result.applied, ['showVitals']);
      assert.strictEqual(config.showVitals, true);

      // DB has only the cfg-mapped key
      const dbData = repo.get('app');
      assert.strictEqual(dbData.showVitals, true);
      assert.strictEqual(dbData.PVP_START_TIME, undefined);
    });
  });

  // ── updateConfig — empty changes = no DB write ──────────────

  describe('updateConfig — empty changes', () => {
    it('does not write to DB when changes array is empty', () => {
      const config = {};
      const result = updateConfig({
        scope: 'app',
        changes: [],
        categoryRestart: false,
        configRepo: repo,
        liveConfig: config,
      });

      assert.deepStrictEqual(result.applied, []);
      assert.deepStrictEqual(result.requiresRestart, []);
      assert.strictEqual(repo.get('app'), null);
    });
  });

  // ── updateConfig — merge with existing DB data ──────────────

  describe('updateConfig — merges with existing DB data', () => {
    it('preserves existing keys in the DB scope', () => {
      repo.set('app', { existingKey: 'preserved', showVitals: false });

      const config = { showVitals: false };
      updateConfig({
        scope: 'app',
        changes: [{ field: { env: 'SHOW_VITALS', cfg: 'showVitals', type: 'bool' }, value: 'true' }],
        categoryRestart: false,
        configRepo: repo,
        liveConfig: config,
      });

      const dbData = repo.get('app');
      assert.strictEqual(dbData.existingKey, 'preserved');
      assert.strictEqual(dbData.showVitals, true);
    });
  });

  // ── updateConfig — uses default config when liveConfig not provided ──

  describe('updateConfig — default config', () => {
    it('uses the config singleton when liveConfig is omitted', () => {
      const defaultConfig = require('../src/config');
      const originalValue = defaultConfig.showVitals;

      try {
        const result = updateConfig({
          scope: 'app',
          changes: [{ field: { env: 'SHOW_VITALS', cfg: 'showVitals', type: 'bool' }, value: 'true' }],
          categoryRestart: false,
          configRepo: repo,
        });

        assert.deepStrictEqual(result.applied, ['showVitals']);
        assert.strictEqual(defaultConfig.showVitals, true);
      } finally {
        // Restore original value
        defaultConfig.showVitals = originalValue;
      }
    });
  });
});

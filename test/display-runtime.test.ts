import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import RuntimeConfigApplier from '../src/config/runtime-config-applier.js';
import {
  DISPLAY_RUNTIME_ENV_KEYS,
  normalizeDisplayRuntimeValue,
  registerDisplayRuntimeHandlers,
} from '../src/config/display-runtime.js';

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    botLocale: 'en',
    botTimezone: 'UTC',
    logTimezone: 'UTC',
    ...overrides,
  };
}

describe('display runtime handlers', () => {
  it('normalizes locale and timezone values before mutating active config', () => {
    const applier = new RuntimeConfigApplier();
    const config = makeConfig();
    const applied: string[] = [];

    registerDisplayRuntimeHandlers({
      runtimeConfigApplier: applier,
      config,
      onApplied: (context) => applied.push(context.envKey),
    });

    assert.equal(applier.applyModuleReconfigure({ envKey: 'BOT_LOCALE', cfgKey: 'botLocale', value: ' zh-TW ' }), true);
    assert.equal(
      applier.applyModuleReconfigure({ envKey: 'BOT_TIMEZONE', cfgKey: 'botTimezone', value: ' Asia/Taipei ' }),
      true,
    );
    assert.equal(
      applier.applyModuleReconfigure({ envKey: 'LOG_TIMEZONE', cfgKey: 'logTimezone', value: ' Europe/London ' }),
      true,
    );

    assert.equal(config.botLocale, 'zh-TW');
    assert.equal(config.botTimezone, 'Asia/Taipei');
    assert.equal(config.logTimezone, 'Europe/London');
    assert.deepEqual(applied, [...DISPLAY_RUNTIME_ENV_KEYS]);
  });

  it('rejects unsupported bot locale values without mutating config', () => {
    const applier = new RuntimeConfigApplier();
    const config = makeConfig();

    registerDisplayRuntimeHandlers({ runtimeConfigApplier: applier, config });

    assert.throws(
      () => applier.applyModuleReconfigure({ envKey: 'BOT_LOCALE', cfgKey: 'botLocale', value: 'fr' }),
      /Unsupported bot locale: fr/,
    );
    assert.equal(config.botLocale, 'en');
  });

  it('rejects cfgKey mismatches without mutating config', () => {
    const applier = new RuntimeConfigApplier();
    const config = makeConfig();

    registerDisplayRuntimeHandlers({ runtimeConfigApplier: applier, config });

    assert.throws(
      () => applier.applyModuleReconfigure({ envKey: 'BOT_LOCALE', cfgKey: 'botTimezone', value: 'zh-TW' }),
      /BOT_LOCALE expected cfgKey botLocale, received botTimezone/,
    );
    assert.equal(config.botLocale, 'en');
    assert.equal(config.botTimezone, 'UTC');
  });

  it('rejects invalid IANA timezone values without mutating config', () => {
    const applier = new RuntimeConfigApplier();
    const config = makeConfig({ botTimezone: 'Asia/Taipei' });

    registerDisplayRuntimeHandlers({ runtimeConfigApplier: applier, config });

    assert.throws(
      () => applier.applyModuleReconfigure({ envKey: 'BOT_TIMEZONE', cfgKey: 'botTimezone', value: 'Fake/Zone' }),
      /Invalid IANA timezone for BOT_TIMEZONE: Fake\/Zone/,
    );
    assert.equal(config.botTimezone, 'Asia/Taipei');
  });

  it('falls back to safe defaults for empty values', () => {
    assert.equal(normalizeDisplayRuntimeValue('BOT_LOCALE', '   '), 'en');
    assert.equal(normalizeDisplayRuntimeValue('BOT_TIMEZONE', '\t'), 'UTC');
    assert.equal(normalizeDisplayRuntimeValue('LOG_TIMEZONE', null), 'UTC');
  });

  it('unregisters display handlers during cleanup', async () => {
    const applier = new RuntimeConfigApplier();

    registerDisplayRuntimeHandlers({ runtimeConfigApplier: applier, config: makeConfig() });

    for (const envKey of DISPLAY_RUNTIME_ENV_KEYS) {
      assert.equal(applier.hasModuleReconfigure(envKey), true);
    }

    await applier.cleanupOwner('display-runtime');

    for (const envKey of DISPLAY_RUNTIME_ENV_KEYS) {
      assert.equal(applier.hasModuleReconfigure(envKey), false);
    }
  });
});

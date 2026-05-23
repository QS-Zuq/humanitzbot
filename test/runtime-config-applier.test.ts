import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import RuntimeConfigApplier from '../src/config/runtime-config-applier.js';

describe('RuntimeConfigApplier', () => {
  it('applies registered module-reconfigure handlers', () => {
    const applier = new RuntimeConfigApplier();
    const seen: unknown[] = [];

    applier.registerModuleReconfigure('SERVER_STATUS_INTERVAL', (context) => {
      seen.push(context);
    });

    const applied = applier.applyModuleReconfigure({
      envKey: 'SERVER_STATUS_INTERVAL',
      cfgKey: 'serverStatusInterval',
      value: 45_000,
    });

    assert.equal(applied, true);
    assert.deepEqual(seen, [{ envKey: 'SERVER_STATUS_INTERVAL', cfgKey: 'serverStatusInterval', value: 45_000 }]);
  });

  it('returns false when no module-reconfigure handler is registered', () => {
    const applier = new RuntimeConfigApplier();

    const applied = applier.applyModuleReconfigure({
      envKey: 'BOT_LOCALE',
      cfgKey: 'botLocale',
      value: 'zh-TW',
    });

    assert.equal(applied, false);
  });

  it('unregisters only the matching handler', () => {
    const applier = new RuntimeConfigApplier();
    let calls = 0;
    const unregister = applier.registerModuleReconfigure('SERVER_STATUS_INTERVAL', () => {
      calls += 1;
    });

    assert.equal(applier.hasModuleReconfigure('SERVER_STATUS_INTERVAL'), true);
    unregister();

    const applied = applier.applyModuleReconfigure({
      envKey: 'SERVER_STATUS_INTERVAL',
      cfgKey: 'serverStatusInterval',
      value: 45_000,
    });

    assert.equal(applied, false);
    assert.equal(calls, 0);
  });

  it('surfaces handler failures to callers', () => {
    const applier = new RuntimeConfigApplier();
    applier.registerModuleReconfigure('SERVER_STATUS_INTERVAL', () => {
      throw new Error('timer refused');
    });

    assert.throws(
      () =>
        applier.applyModuleReconfigure({
          envKey: 'SERVER_STATUS_INTERVAL',
          cfgKey: 'serverStatusInterval',
          value: 45_000,
        }),
      /timer refused/,
    );
  });
});

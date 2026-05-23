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

  it('applies registered connection-reconnect handlers', () => {
    const applier = new RuntimeConfigApplier();
    const seen: unknown[] = [];

    applier.registerConnectionReconnect('PANEL_SERVER_URL', (context) => {
      seen.push(context);
    });

    const applied = applier.applyConnectionReconnect({
      envKey: 'PANEL_SERVER_URL',
      cfgKey: 'panelServerUrl',
      value: 'https://panel.example.test/server/abc123',
    });

    assert.equal(applied, true);
    assert.deepEqual(seen, [
      {
        envKey: 'PANEL_SERVER_URL',
        cfgKey: 'panelServerUrl',
        value: 'https://panel.example.test/server/abc123',
      },
    ]);
  });

  it('returns false when no connection-reconnect handler is registered', () => {
    const applier = new RuntimeConfigApplier();

    const applied = applier.applyConnectionReconnect({
      envKey: 'RCON_HOST',
      cfgKey: 'rconHost',
      value: '10.0.0.99',
    });

    assert.equal(applied, false);
  });

  it('unregisters only the matching connection-reconnect handler', () => {
    const applier = new RuntimeConfigApplier();
    let calls = 0;
    const first = () => {
      calls += 1;
    };
    const second = () => {
      calls += 10;
    };
    const unregisterFirst = applier.registerConnectionReconnect('PANEL_API_KEY', first);
    applier.registerConnectionReconnect('PANEL_API_KEY', second);

    unregisterFirst();

    const applied = applier.applyConnectionReconnect({
      envKey: 'PANEL_API_KEY',
      cfgKey: 'panelApiKey',
      value: 'secret',
    });

    assert.equal(applied, true);
    assert.equal(calls, 10);
  });

  it('surfaces connection-reconnect handler failures to callers', () => {
    const applier = new RuntimeConfigApplier();
    applier.registerConnectionReconnect('PANEL_SERVER_URL', () => {
      throw new Error('panel refused');
    });

    assert.throws(
      () =>
        applier.applyConnectionReconnect({
          envKey: 'PANEL_SERVER_URL',
          cfgKey: 'panelServerUrl',
          value: 'https://panel.example.test/server/abc123',
        }),
      /panel refused/,
    );
  });
});

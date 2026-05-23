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

  it('unregisters owner-scoped module-reconfigure handlers as a group', async () => {
    const applier = new RuntimeConfigApplier();
    let calls = 0;

    applier.registerModuleReconfigure(
      'SERVER_STATUS_INTERVAL',
      () => {
        calls += 1;
      },
      { ownerId: 'server-status' },
    );
    applier.registerModuleReconfigure(
      'STATUS_CHANNEL_INTERVAL',
      () => {
        calls += 10;
      },
      { ownerId: 'server-status' },
    );

    assert.equal(
      applier.applyModuleReconfigure({
        envKey: 'SERVER_STATUS_INTERVAL',
        cfgKey: 'serverStatusInterval',
        value: 60_000,
      }),
      true,
    );
    await applier.cleanupOwner('server-status');

    assert.equal(
      applier.applyModuleReconfigure({
        envKey: 'SERVER_STATUS_INTERVAL',
        cfgKey: 'serverStatusInterval',
        value: 60_000,
      }),
      false,
    );
    assert.equal(
      applier.applyModuleReconfigure({
        envKey: 'STATUS_CHANNEL_INTERVAL',
        cfgKey: 'statusChannelInterval',
        value: 60_000,
      }),
      false,
    );
    assert.equal(calls, 1);
  });

  it('unregisters owner-scoped connection-reconnect handlers as a group', async () => {
    const applier = new RuntimeConfigApplier();
    let calls = 0;

    applier.registerConnectionReconnect(
      'PANEL_SERVER_URL',
      () => {
        calls += 1;
      },
      { ownerId: 'panel-api' },
    );
    applier.registerConnectionReconnect(
      'PANEL_API_KEY',
      () => {
        calls += 10;
      },
      { ownerId: 'panel-api' },
    );

    await applier.cleanupOwner('panel-api');

    assert.equal(
      applier.applyConnectionReconnect({
        envKey: 'PANEL_SERVER_URL',
        cfgKey: 'panelServerUrl',
        value: 'https://panel.example.test/server/abc123',
      }),
      false,
    );
    assert.equal(
      applier.applyConnectionReconnect({
        envKey: 'PANEL_API_KEY',
        cfgKey: 'panelApiKey',
        value: 'secret',
      }),
      false,
    );
    assert.equal(calls, 0);
  });

  it('does not let one owner cleanup remove another owner replacement handler', async () => {
    const applier = new RuntimeConfigApplier();
    let calls = 0;

    applier.registerModuleReconfigure(
      'SERVER_STATUS_INTERVAL',
      () => {
        calls += 1;
      },
      { ownerId: 'old-server-status' },
    );
    applier.registerModuleReconfigure(
      'SERVER_STATUS_INTERVAL',
      () => {
        calls += 10;
      },
      { ownerId: 'new-server-status' },
    );

    await applier.cleanupOwner('old-server-status');

    assert.equal(
      applier.applyModuleReconfigure({
        envKey: 'SERVER_STATUS_INTERVAL',
        cfgKey: 'serverStatusInterval',
        value: 60_000,
      }),
      true,
    );
    assert.equal(calls, 10);
  });

  it('preserves existing non-owner registration APIs during owner cleanup', async () => {
    const applier = new RuntimeConfigApplier();
    let calls = 0;

    applier.registerModuleReconfigure('SERVER_STATUS_INTERVAL', () => {
      calls += 1;
    });

    await applier.cleanupOwner('unrelated-owner');

    assert.equal(
      applier.applyModuleReconfigure({
        envKey: 'SERVER_STATUS_INTERVAL',
        cfgKey: 'serverStatusInterval',
        value: 60_000,
      }),
      true,
    );
    assert.equal(calls, 1);
  });
});

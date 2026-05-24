import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import * as _reload_strategy from '../src/config/reload-strategy.js';
const {
  RELOAD_STRATEGIES,
  resolveReloadStrategy,
  summarizeConfigReloadApply,
  summarizeConfigReloadApplyAsync,
  buildReloadStrategyMap,
} = _reload_strategy;
type EnvConfigCategoryWithReloadStrategy = _reload_strategy.EnvConfigCategoryWithReloadStrategy;
type ReloadStrategy = _reload_strategy.ReloadStrategy;

import * as _panel_constants from '../src/modules/panel-constants.js';
const { ENV_CATEGORIES } = _panel_constants as {
  ENV_CATEGORIES: EnvConfigCategoryWithReloadStrategy[];
};

const TEST_CATEGORIES: EnvConfigCategoryWithReloadStrategy[] = [
  { restart: false, fields: [{ env: 'LEGACY_RESTART_FALSE' }] },
  { restart: false, reloadStrategy: 'live', fields: [{ env: 'SHOW_VITALS' }] },
  { restart: true, reloadStrategy: 'module-reconfigure', fields: [{ env: 'SERVER_STATUS_INTERVAL' }] },
  {
    restart: true,
    reloadStrategy: 'connection-reconnect',
    fields: [{ env: 'RCON_HOST' }, { env: 'PANEL_SERVER_URL' }, { env: 'PANEL_API_KEY' }],
  },
  { restart: true, reloadStrategy: 'bot-restart', fields: [{ env: 'SESSION_STORE' }] },
  { restart: true, reloadStrategy: 'game-restart', fields: [{ env: 'GAME_DIFFICULTY' }] },
  {
    restart: true,
    reloadStrategy: 'module-restart',
    fields: [{ env: 'ENABLE_CHAT_RELAY' }, { env: 'SHOW_STATUS_EFFECTS', reloadStrategy: 'live' }],
  },
];

describe('config reload strategy helpers', () => {
  it('returns an empty successful result for empty changes', () => {
    const result = summarizeConfigReloadApply([], { categories: TEST_CATEGORIES });
    assert.deepEqual(result.updated, []);
    assert.equal(result.restartRequired, false);
    assert.equal(result.message, 'No settings changed.');
  });

  it('classifies explicit live keys as applied live', () => {
    const applied: string[] = [];
    const result = summarizeConfigReloadApply(['SHOW_VITALS'], {
      categories: TEST_CATEGORIES,
      applyLive(envKey) {
        applied.push(envKey);
      },
    });
    assert.deepEqual(result.appliedLive, ['SHOW_VITALS']);
    assert.deepEqual(applied, ['SHOW_VITALS']);
    assert.equal(result.restartRequired, false);
  });

  it('classifies connection keys as pending reconnect', () => {
    const result = summarizeConfigReloadApply(['RCON_HOST'], { categories: TEST_CATEGORIES });
    assert.deepEqual(result.pendingReconnect, ['RCON_HOST']);
    assert.equal(result.restartRequired, true);
  });

  it('applies connection-reconnect keys when a handler accepts them', () => {
    const applied: string[] = [];
    const result = summarizeConfigReloadApply(['PANEL_SERVER_URL'], {
      categories: TEST_CATEGORIES,
      applyConnectionReconnect(envKey) {
        applied.push(envKey);
        return true;
      },
    });

    assert.deepEqual(result.appliedReconnect, ['PANEL_SERVER_URL']);
    assert.deepEqual(result.pendingReconnect, []);
    assert.deepEqual(applied, ['PANEL_SERVER_URL']);
    assert.equal(result.restartRequired, false);
    assert.match(result.message, /1 applied reconnect/);
  });

  it('keeps connection-reconnect keys pending when no handler exists', () => {
    const result = summarizeConfigReloadApply(['PANEL_SERVER_URL'], {
      categories: TEST_CATEGORIES,
      applyConnectionReconnect() {
        return false;
      },
    });

    assert.deepEqual(result.appliedReconnect, []);
    assert.deepEqual(result.pendingReconnect, ['PANEL_SERVER_URL']);
    assert.equal(result.restartRequired, true);
  });

  it('records connection-reconnect handler failures without counting the key as applied', () => {
    const result = summarizeConfigReloadApply(['PANEL_SERVER_URL'], {
      categories: TEST_CATEGORIES,
      applyConnectionReconnect() {
        throw new Error('panel refused');
      },
    });

    assert.deepEqual(result.appliedReconnect, []);
    assert.deepEqual(result.pendingReconnect, []);
    assert.equal(result.errors.length, 1);
    const [error] = result.errors;
    assert.ok(error);
    assert.equal(error.key, 'PANEL_SERVER_URL');
    assert.equal(error.strategy, 'connection-reconnect');
    assert.equal(error.message, 'panel refused');
    assert.equal(result.restartRequired, true);
  });

  it('applies module-reconfigure keys when a handler accepts them', () => {
    const applied: string[] = [];
    const result = summarizeConfigReloadApply(['SERVER_STATUS_INTERVAL'], {
      categories: TEST_CATEGORIES,
      applyModuleReconfigure(envKey) {
        applied.push(envKey);
        return true;
      },
    });

    assert.deepEqual(result.appliedModuleReconfigure, ['SERVER_STATUS_INTERVAL']);
    assert.deepEqual(result.pendingModuleReconfigure, []);
    assert.deepEqual(applied, ['SERVER_STATUS_INTERVAL']);
    assert.equal(result.restartRequired, false);
  });

  it('applies PR5 timer handlers without retaining removed GitHub polling metadata', () => {
    const pr4Keys = [
      'LOG_POLL_INTERVAL',
      'CHAT_POLL_INTERVAL',
      'AUTO_MSG_LINK_INTERVAL',
      'AUTO_MSG_PROMO_INTERVAL',
      'AUTO_MSG_JOIN_CHECK',
      'ANTICHEAT_ANALYZE_INTERVAL',
      'ANTICHEAT_BASELINE_INTERVAL',
    ];
    const pr5Keys = [...pr4Keys, 'SAVE_POLL_INTERVAL', 'AGENT_POLL_INTERVAL', 'AGENT_TIMEOUT', 'AGENT_PANEL_DELAY'];
    const result = summarizeConfigReloadApply(pr5Keys, {
      categories: ENV_CATEGORIES,
      applyModuleReconfigure(envKey) {
        return pr5Keys.includes(envKey);
      },
    });

    assert.deepEqual(result.appliedModuleReconfigure, pr5Keys);
    assert.deepEqual(result.pendingModuleReconfigure, []);
    assert.equal(result.restartRequired, false);
  });

  it('applies PR9 low-risk module-reconfigure keys when handlers exist', () => {
    const pr9Keys = [
      'DISCORD_INVITE_LINK',
      'ENABLE_AUTO_MSG_LINK',
      'AUTO_MSG_LINK_TEXT',
      'ENABLE_PVP_KILL_FEED',
      'PVP_KILL_WINDOW',
      'DEATH_LOOP_THRESHOLD',
      'STATUS_CACHE_TTL',
      'RESOURCE_CACHE_TTL',
    ];
    const result = summarizeConfigReloadApply(pr9Keys, {
      categories: ENV_CATEGORIES,
      applyModuleReconfigure(envKey) {
        return pr9Keys.includes(envKey);
      },
    });

    assert.deepEqual(result.appliedModuleReconfigure, pr9Keys);
    assert.deepEqual(result.pendingModuleReconfigure, []);
    assert.equal(result.restartRequired, false);
  });

  it('keeps PR10 feature toggles classified as module-restart without PR9 handlers', () => {
    const result = summarizeConfigReloadApply(['ENABLE_CHAT_RELAY', 'ENABLE_LOG_WATCHER'], {
      categories: ENV_CATEGORIES,
      applyModuleReconfigure() {
        return true;
      },
    });

    assert.deepEqual(result.appliedModuleReconfigure, []);
    assert.deepEqual(result.pendingModuleRestart, ['ENABLE_CHAT_RELAY', 'ENABLE_LOG_WATCHER']);
    assert.equal(result.restartRequired, true);
  });

  it('real panel metadata no longer exposes GitHub Tracker settings', () => {
    const removedKeys = new Set([
      'ENABLE_GITHUB_TRACKER',
      'GITHUB_TOKEN',
      'GITHUB_REPOS',
      'GITHUB_CHANNEL_ID',
      'GITHUB_POLL_INTERVAL',
    ]);

    for (const category of ENV_CATEGORIES) {
      const categoryId = (category as { id?: string }).id;
      assert.notEqual(categoryId, 'github_tracker', 'GitHub Tracker category must be removed');
      for (const field of category.fields) {
        assert.equal(removedKeys.has(field.env), false, `${field.env} must not be exposed in panel metadata`);
      }
    }
  });

  it('keeps agent lifecycle settings out of PR5 runtime timing handlers', () => {
    const pr5TimingKeys = ['AGENT_POLL_INTERVAL', 'AGENT_TIMEOUT'];
    const result = summarizeConfigReloadApply(['AGENT_MODE', 'AGENT_TRIGGER', 'AGENT_NODE_PATH', ...pr5TimingKeys], {
      categories: ENV_CATEGORIES,
      applyModuleReconfigure(envKey) {
        return pr5TimingKeys.includes(envKey);
      },
    });

    assert.deepEqual(result.appliedModuleReconfigure, pr5TimingKeys);
    assert.deepEqual(result.pendingReconnect, ['AGENT_MODE', 'AGENT_TRIGGER', 'AGENT_NODE_PATH']);
    assert.equal(result.restartRequired, true);
  });

  it('keeps module-reconfigure keys pending when no handler exists', () => {
    const result = summarizeConfigReloadApply(['SERVER_STATUS_INTERVAL'], {
      categories: TEST_CATEGORIES,
      applyModuleReconfigure() {
        return false;
      },
    });

    assert.deepEqual(result.appliedModuleReconfigure, []);
    assert.deepEqual(result.pendingModuleReconfigure, ['SERVER_STATUS_INTERVAL']);
    assert.equal(result.restartRequired, true);
  });

  it('records module-reconfigure handler failures without counting the key as applied', () => {
    const result = summarizeConfigReloadApply(['SERVER_STATUS_INTERVAL'], {
      categories: TEST_CATEGORIES,
      applyModuleReconfigure() {
        throw new Error('timer refused');
      },
    });

    assert.deepEqual(result.appliedModuleReconfigure, []);
    assert.deepEqual(result.pendingModuleReconfigure, []);
    assert.equal(result.errors.length, 1);
    const [error] = result.errors;
    assert.ok(error);
    assert.equal(error.key, 'SERVER_STATUS_INTERVAL');
    assert.equal(error.strategy, 'module-reconfigure');
    assert.equal(error.message, 'timer refused');
    assert.equal(result.restartRequired, true);
  });

  it('classifies bot restart keys as pending bot restart', () => {
    const result = summarizeConfigReloadApply(['SESSION_STORE'], { categories: TEST_CATEGORIES });
    assert.deepEqual(result.pendingBotRestart, ['SESSION_STORE']);
    assert.equal(result.restartRequired, true);
  });

  it('classifies game restart keys as pending game restart', () => {
    const result = summarizeConfigReloadApply(['GAME_DIFFICULTY'], { categories: TEST_CATEGORIES });
    assert.deepEqual(result.pendingGameRestart, ['GAME_DIFFICULTY']);
    assert.equal(result.restartRequired, true);
  });

  it('keeps mixed live and pending classes separate', () => {
    const result = summarizeConfigReloadApply(['SHOW_VITALS', 'RCON_HOST'], {
      categories: TEST_CATEGORIES,
      applyLive() {},
    });
    assert.deepEqual(result.appliedLive, ['SHOW_VITALS']);
    assert.deepEqual(result.pendingReconnect, ['RCON_HOST']);
    assert.equal(result.restartRequired, true);
    assert.match(result.message, /1 applied live/);
    assert.match(result.message, /1 pending reconnect/);
  });

  it('keeps mixed applied reconnect and pending reconnect classes separate', () => {
    const result = summarizeConfigReloadApply(['PANEL_SERVER_URL', 'RCON_HOST'], {
      categories: TEST_CATEGORIES,
      applyConnectionReconnect(envKey) {
        return envKey === 'PANEL_SERVER_URL';
      },
    });

    assert.deepEqual(result.appliedReconnect, ['PANEL_SERVER_URL']);
    assert.deepEqual(result.pendingReconnect, ['RCON_HOST']);
    assert.equal(result.restartRequired, true);
    assert.match(result.message, /1 applied reconnect/);
    assert.match(result.message, /1 pending reconnect/);
  });

  it('applies connection-reconnect keys through the async batch handler', async () => {
    const seen: unknown[] = [];
    const result = await summarizeConfigReloadApplyAsync(['RCON_HOST', 'RCON_PORT', 'PANEL_SERVER_URL'], {
      categories: [
        ...TEST_CATEGORIES,
        {
          restart: true,
          reloadStrategy: 'connection-reconnect',
          fields: [{ env: 'RCON_PORT' }],
        },
      ],
      async applyConnectionReconnectBatch(envKeys) {
        seen.push(envKeys);
        return { applied: ['RCON_HOST', 'RCON_PORT'] };
      },
    });

    assert.deepEqual(seen, [['RCON_HOST', 'RCON_PORT', 'PANEL_SERVER_URL']]);
    assert.deepEqual(result.appliedReconnect, ['RCON_HOST', 'RCON_PORT']);
    assert.deepEqual(result.pendingReconnect, ['PANEL_SERVER_URL']);
    assert.equal(result.restartRequired, true);
  });

  it('applies Agent and HZMod reconnect keys through the async batch handler', async () => {
    const result = await summarizeConfigReloadApplyAsync(['AGENT_MODE', 'HZMOD_SOCKET_PATH', 'PUBLIC_HOST'], {
      categories: [
        {
          restart: true,
          reloadStrategy: 'connection-reconnect',
          fields: [{ env: 'AGENT_MODE' }, { env: 'HZMOD_SOCKET_PATH' }, { env: 'PUBLIC_HOST' }],
        },
      ],
      async applyConnectionReconnectBatch(envKeys) {
        assert.deepEqual(envKeys, ['AGENT_MODE', 'HZMOD_SOCKET_PATH', 'PUBLIC_HOST']);
        return { applied: ['AGENT_MODE', 'HZMOD_SOCKET_PATH'] };
      },
    });

    assert.deepEqual(result.appliedReconnect, ['AGENT_MODE', 'HZMOD_SOCKET_PATH']);
    assert.deepEqual(result.pendingReconnect, ['PUBLIC_HOST']);
    assert.equal(result.restartRequired, true);
  });

  it('records async batch connection-reconnect errors without marking keys pending', async () => {
    const result = await summarizeConfigReloadApplyAsync(['RCON_HOST', 'RCON_PASSWORD'], {
      categories: [
        ...TEST_CATEGORIES,
        {
          restart: true,
          reloadStrategy: 'connection-reconnect',
          fields: [{ env: 'RCON_PASSWORD' }],
        },
      ],
      async applyConnectionReconnectBatch() {
        return {
          applied: [],
          errors: [
            { key: 'RCON_HOST', message: 'rcon refused' },
            { key: 'RCON_PASSWORD', message: 'rcon refused' },
          ],
        };
      },
    });

    assert.deepEqual(result.appliedReconnect, []);
    assert.deepEqual(result.pendingReconnect, []);
    assert.deepEqual(
      result.errors.map((error) => ({ key: error.key, strategy: error.strategy, message: error.message })),
      [
        { key: 'RCON_HOST', strategy: 'connection-reconnect', message: 'rcon refused' },
        { key: 'RCON_PASSWORD', strategy: 'connection-reconnect', message: 'rcon refused' },
      ],
    );
    assert.equal(result.restartRequired, true);
  });

  it('falls unknown keys back to pending bot restart', () => {
    const result = summarizeConfigReloadApply(['UNKNOWN_FUTURE_KEY'], { categories: TEST_CATEGORIES });
    assert.deepEqual(result.pendingBotRestart, ['UNKNOWN_FUTURE_KEY']);
    assert.equal(result.restartRequired, true);
  });

  it('does not infer live from legacy restart=false without explicit reloadStrategy', () => {
    assert.equal(resolveReloadStrategy('LEGACY_RESTART_FALSE', TEST_CATEGORIES), 'bot-restart');
    const result = summarizeConfigReloadApply(['LEGACY_RESTART_FALSE'], { categories: TEST_CATEGORIES });
    assert.deepEqual(result.appliedLive, []);
    assert.deepEqual(result.pendingBotRestart, ['LEGACY_RESTART_FALSE']);
    assert.equal(result.restartRequired, true);
  });

  it('does not count live keys as applied when no live apply handler exists', () => {
    const result = summarizeConfigReloadApply(['SHOW_VITALS'], { categories: TEST_CATEGORIES });
    assert.deepEqual(result.appliedLive, []);
    assert.equal(result.errors.length, 1);
    const [error] = result.errors;
    assert.ok(error);
    assert.equal(error.key, 'SHOW_VITALS');
    assert.equal(error.message, 'Live apply handler is not configured');
    assert.equal(result.restartRequired, true);
  });

  it('uses field-level reloadStrategy override over category default', () => {
    assert.equal(resolveReloadStrategy('SHOW_STATUS_EFFECTS', TEST_CATEGORIES), 'live');
  });

  it('records live apply failures without counting the key as successfully applied', () => {
    const result = summarizeConfigReloadApply(['SHOW_VITALS'], {
      categories: TEST_CATEGORIES,
      applyLive() {
        throw new Error('write blocked');
      },
    });

    assert.deepEqual(result.appliedLive, []);
    assert.equal(result.errors.length, 1);
    const [error] = result.errors;
    assert.ok(error);
    assert.equal(error.key, 'SHOW_VITALS');
    assert.equal(error.message, 'write blocked');
    assert.equal(result.restartRequired, true);
  });

  it('real panel metadata resolves every exposed key to a known strategy', () => {
    const known = new Set<ReloadStrategy>(RELOAD_STRATEGIES);
    const map = buildReloadStrategyMap(ENV_CATEGORIES);

    for (const category of ENV_CATEGORIES) {
      assert.ok(known.has(category.reloadStrategy as ReloadStrategy), `${category.reloadStrategy} is known`);
      for (const field of category.fields) {
        assert.ok(known.has(map[field.env] as ReloadStrategy), `${field.env} resolves to a known strategy`);
      }
    }
  });

  it('real panel metadata only resolves live when explicitly allowlisted', () => {
    for (const category of ENV_CATEGORIES) {
      for (const field of category.fields) {
        if (resolveReloadStrategy(field.env, ENV_CATEGORIES) !== 'live') continue;
        assert.equal(
          field.reloadStrategy === 'live' || category.reloadStrategy === 'live',
          true,
          `${field.env} must have explicit live strategy metadata`,
        );
      }
    }
  });
});

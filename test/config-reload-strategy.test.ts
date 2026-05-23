import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import * as _reload_strategy from '../src/config/reload-strategy.js';
const { RELOAD_STRATEGIES, resolveReloadStrategy, summarizeConfigReloadApply, buildReloadStrategyMap } =
  _reload_strategy;
type EnvConfigCategoryWithReloadStrategy = _reload_strategy.EnvConfigCategoryWithReloadStrategy;
type ReloadStrategy = _reload_strategy.ReloadStrategy;

import * as _panel_constants from '../src/modules/panel-constants.js';
const { ENV_CATEGORIES } = _panel_constants as {
  ENV_CATEGORIES: EnvConfigCategoryWithReloadStrategy[];
};

const TEST_CATEGORIES: EnvConfigCategoryWithReloadStrategy[] = [
  { restart: false, fields: [{ env: 'LEGACY_RESTART_FALSE' }] },
  { restart: false, reloadStrategy: 'live', fields: [{ env: 'SHOW_VITALS' }] },
  { restart: true, reloadStrategy: 'connection-reconnect', fields: [{ env: 'RCON_HOST' }] },
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

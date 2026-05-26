import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { planWebPanelStartup } from '../src/web-map/startup-plan.js';

describe('planWebPanelStartup', () => {
  it('returns disabled when WEB_MAP_PORT is missing', () => {
    const plan = planWebPanelStartup({}, { discordClientSecret: 'secret' });
    assert.deepEqual(plan, { action: 'disabled', reason: 'noPort' });
  });

  it('returns disabled when WEB_MAP_PORT is not a number', () => {
    const plan = planWebPanelStartup({ WEB_MAP_PORT: 'abc' }, { discordClientSecret: 'secret' });
    assert.equal(plan.action, 'disabled');
  });

  it('returns disabled when WEB_MAP_PORT is 0', () => {
    const plan = planWebPanelStartup({ WEB_MAP_PORT: '0' }, { discordClientSecret: 'secret' });
    assert.equal(plan.action, 'disabled');
  });

  it('returns oauth mode when both secret and callback URL are set', () => {
    const plan = planWebPanelStartup(
      { WEB_MAP_PORT: '3000', WEB_MAP_CALLBACK_URL: 'http://localhost:3000/auth/callback' },
      { discordClientSecret: 'secret' },
    );
    assert.deepEqual(plan, { action: 'start', port: 3000, mode: 'oauth' });
  });

  it('returns landingOnly mode when OAuth not configured', () => {
    const plan = planWebPanelStartup({ WEB_MAP_PORT: '3000' }, { discordClientSecret: '' });
    assert.deepEqual(plan, { action: 'start', port: 3000, mode: 'landingOnly' });
  });

  it('partial OAuth: only secret set → landingOnly', () => {
    const plan = planWebPanelStartup({ WEB_MAP_PORT: '3000' }, { discordClientSecret: 'secret' });
    assert.equal(plan.action, 'start');
    assert.equal(plan.mode, 'landingOnly');
  });

  it('partial OAuth: only callback URL set → landingOnly', () => {
    const plan = planWebPanelStartup(
      { WEB_MAP_PORT: '3000', WEB_MAP_CALLBACK_URL: 'http://localhost:3000/auth/callback' },
      { discordClientSecret: '' },
    );
    assert.equal(plan.action, 'start');
    assert.equal(plan.mode, 'landingOnly');
  });
});

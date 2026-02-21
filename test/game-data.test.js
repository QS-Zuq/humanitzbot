/**
 * Tests for game-data.js — static map integrity.
 * Run: npm test
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const gameData = require('../src/game-data');

describe('AFFLICTION_MAP', () => {
  it('is an array', () => {
    assert.ok(Array.isArray(gameData.AFFLICTION_MAP));
  });

  it('has at least 5 entries', () => {
    assert.ok(gameData.AFFLICTION_MAP.length >= 5);
  });

  it('index 0 is None or similar', () => {
    assert.ok(typeof gameData.AFFLICTION_MAP[0] === 'string');
  });

  it('all entries are strings', () => {
    for (const entry of gameData.AFFLICTION_MAP) {
      assert.ok(typeof entry === 'string', `Expected string, got ${typeof entry}: ${entry}`);
    }
  });
});

describe('PROFESSION_DETAILS', () => {
  it('is a non-empty object', () => {
    assert.ok(typeof gameData.PROFESSION_DETAILS === 'object');
    assert.ok(Object.keys(gameData.PROFESSION_DETAILS).length > 0);
  });

  it('each entry has perk and description', () => {
    for (const [key, detail] of Object.entries(gameData.PROFESSION_DETAILS)) {
      assert.ok(typeof key === 'string' && key.length > 0, `empty key`);
      assert.ok(detail.perk, `${key} missing perk`);
      assert.ok(detail.description, `${key} missing description`);
    }
  });
});

describe('CHALLENGES', () => {
  it('is an array with entries', () => {
    assert.ok(Array.isArray(gameData.CHALLENGES));
    assert.ok(gameData.CHALLENGES.length > 0);
  });

  it('each challenge has id and name', () => {
    for (const challenge of gameData.CHALLENGES) {
      assert.ok(challenge.id, 'Missing challenge id');
      assert.ok(challenge.name, 'Missing challenge name');
    }
  });
});

describe('SKILL_EFFECTS', () => {
  it('is a non-empty object', () => {
    assert.ok(typeof gameData.SKILL_EFFECTS === 'object');
    assert.ok(Object.keys(gameData.SKILL_EFFECTS).length > 0);
  });
});

describe('SERVER_SETTING_DESCRIPTIONS', () => {
  it('is a non-empty object', () => {
    assert.ok(typeof gameData.SERVER_SETTING_DESCRIPTIONS === 'object');
    assert.ok(Object.keys(gameData.SERVER_SETTING_DESCRIPTIONS).length > 0);
  });

  it('each value is a string', () => {
    for (const [key, val] of Object.entries(gameData.SERVER_SETTING_DESCRIPTIONS)) {
      assert.ok(typeof val === 'string', `${key} should be a string`);
    }
  });
});

describe('LOADING_TIPS', () => {
  it('is an array of strings', () => {
    assert.ok(Array.isArray(gameData.LOADING_TIPS));
    assert.ok(gameData.LOADING_TIPS.length > 0);
    for (const tip of gameData.LOADING_TIPS) {
      assert.ok(typeof tip === 'string');
    }
  });
});

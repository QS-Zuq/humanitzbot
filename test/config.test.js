/**
 * Tests for config.js — envBool, envTime helpers.
 * Run: npm test
 */
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { _envBool: envBool, _envTime: envTime } = require('../src/config');

// ══════════════════════════════════════════════════════════
// envBool — string to boolean coercion
// ══════════════════════════════════════════════════════════

describe('envBool', () => {
  const saved = {};

  beforeEach(() => {
    saved.TEST_BOOL = process.env.TEST_BOOL;
    delete process.env.TEST_BOOL;
  });

  afterEach(() => {
    if (saved.TEST_BOOL !== undefined) {
      process.env.TEST_BOOL = saved.TEST_BOOL;
    } else {
      delete process.env.TEST_BOOL;
    }
  });

  it('returns true when env is "true"', () => {
    process.env.TEST_BOOL = 'true';
    assert.equal(envBool('TEST_BOOL', false), true);
  });

  it('returns false when env is "false"', () => {
    process.env.TEST_BOOL = 'false';
    assert.equal(envBool('TEST_BOOL', true), false);
  });

  it('returns default when env is undefined', () => {
    delete process.env.TEST_BOOL;
    assert.equal(envBool('TEST_BOOL', true), true);
    assert.equal(envBool('TEST_BOOL', false), false);
  });

  it('returns default when env is empty string', () => {
    process.env.TEST_BOOL = '';
    assert.equal(envBool('TEST_BOOL', true), true);
  });

  it('treats non-"true" strings as false', () => {
    process.env.TEST_BOOL = 'yes';
    assert.equal(envBool('TEST_BOOL', true), false);
    process.env.TEST_BOOL = '1';
    assert.equal(envBool('TEST_BOOL', true), false);
    process.env.TEST_BOOL = 'TRUE';
    assert.equal(envBool('TEST_BOOL', true), false);
  });
});

// ══════════════════════════════════════════════════════════
// envTime — HH:MM string to total minutes
// ══════════════════════════════════════════════════════════

describe('envTime', () => {
  const saved = {};

  beforeEach(() => {
    saved.TEST_TIME = process.env.TEST_TIME;
    delete process.env.TEST_TIME;
  });

  afterEach(() => {
    if (saved.TEST_TIME !== undefined) {
      process.env.TEST_TIME = saved.TEST_TIME;
    } else {
      delete process.env.TEST_TIME;
    }
  });

  it('parses HH:MM format', () => {
    process.env.TEST_TIME = '22:30';
    assert.equal(envTime('TEST_TIME'), 22 * 60 + 30);
  });

  it('parses hour-only format', () => {
    process.env.TEST_TIME = '18';
    assert.equal(envTime('TEST_TIME'), 18 * 60);
  });

  it('parses midnight', () => {
    process.env.TEST_TIME = '0:00';
    assert.equal(envTime('TEST_TIME'), 0);
  });

  it('parses 23:59', () => {
    process.env.TEST_TIME = '23:59';
    assert.equal(envTime('TEST_TIME'), 23 * 60 + 59);
  });

  it('returns NaN for undefined env var', () => {
    assert.ok(isNaN(envTime('TEST_TIME')));
  });

  it('returns NaN for empty string', () => {
    process.env.TEST_TIME = '';
    assert.ok(isNaN(envTime('TEST_TIME')));
  });

  it('returns NaN for non-numeric input', () => {
    process.env.TEST_TIME = 'abc';
    assert.ok(isNaN(envTime('TEST_TIME')));
  });
});

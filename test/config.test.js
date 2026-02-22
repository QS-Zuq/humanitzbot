/**
 * Tests for config.js — envBool, envTime helpers.
 * Run: npm test
 */
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { _envBool: envBool, _envTime: envTime, _tzOffsetMs: tzOffsetMs } = require('../src/config');
const config = require('../src/config');

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

// ══════════════════════════════════════════════════════════
// _tzOffsetMs — compute timezone offset from UTC
// ══════════════════════════════════════════════════════════

describe('_tzOffsetMs', () => {
  it('returns 0 for UTC', () => {
    const d = new Date('2026-02-13T12:00:00Z');
    assert.equal(tzOffsetMs(d, 'UTC'), 0);
  });

  it('returns positive offset for UTC+ timezones', () => {
    // Europe/Tallinn is UTC+2 (EET) or UTC+3 (EEST)
    // February = EET = UTC+2
    const d = new Date('2026-02-13T12:00:00Z');
    const offset = tzOffsetMs(d, 'Europe/Tallinn');
    assert.equal(offset, 2 * 60 * 60 * 1000); // +2h
  });

  it('returns negative offset for UTC- timezones', () => {
    // America/New_York is UTC-5 (EST) in February
    const d = new Date('2026-02-13T12:00:00Z');
    const offset = tzOffsetMs(d, 'America/New_York');
    assert.equal(offset, -5 * 60 * 60 * 1000); // -5h
  });

  it('accounts for DST changes', () => {
    // America/New_York: EST (UTC-5) in Jan, EDT (UTC-4) in Jul
    const winter = new Date('2026-01-15T12:00:00Z');
    const summer = new Date('2026-07-15T12:00:00Z');
    assert.equal(tzOffsetMs(winter, 'America/New_York'), -5 * 60 * 60 * 1000);
    assert.equal(tzOffsetMs(summer, 'America/New_York'), -4 * 60 * 60 * 1000);
  });
});

// ══════════════════════════════════════════════════════════
// parseLogTimestamp — log time → UTC Date
// ══════════════════════════════════════════════════════════

describe('parseLogTimestamp', () => {
  let savedLogTz;

  beforeEach(() => {
    savedLogTz = config.logTimezone;
  });

  afterEach(() => {
    config.logTimezone = savedLogTz;
  });

  it('treats log time as UTC when logTimezone is UTC', () => {
    config.logTimezone = 'UTC';
    const d = config.parseLogTimestamp('2026', '2', '13', '12', '35');
    assert.equal(d.toISOString(), '2026-02-13T12:35:00.000Z');
  });

  it('converts from UTC+2 correctly (Europe/Tallinn in winter)', () => {
    config.logTimezone = 'Europe/Tallinn';
    // Log says 14:00 in Tallinn (UTC+2) → should be 12:00 UTC
    const d = config.parseLogTimestamp('2026', '2', '13', '14', '0');
    assert.equal(d.toISOString(), '2026-02-13T12:00:00.000Z');
  });

  it('converts from UTC-5 correctly (America/New_York in winter)', () => {
    config.logTimezone = 'America/New_York';
    // Log says 07:00 in NY (UTC-5) → should be 12:00 UTC
    const d = config.parseLogTimestamp('2026', '2', '13', '7', '0');
    assert.equal(d.toISOString(), '2026-02-13T12:00:00.000Z');
  });

  it('handles DST: America/New_York summer (EDT = UTC-4)', () => {
    config.logTimezone = 'America/New_York';
    // Log says 08:00 in NY (UTC-4 in summer) → should be 12:00 UTC
    const d = config.parseLogTimestamp('2026', '7', '15', '8', '0');
    assert.equal(d.toISOString(), '2026-07-15T12:00:00.000Z');
  });

  it('handles midnight crossing (UTC+2 log at 01:00 → previous UTC day)', () => {
    config.logTimezone = 'Europe/Tallinn';
    // Log says 01:00 Feb 14 in Tallinn → 23:00 Feb 13 UTC
    const d = config.parseLogTimestamp('2026', '2', '14', '1', '0');
    assert.equal(d.toISOString(), '2026-02-13T23:00:00.000Z');
  });

  it('handles half-hour offset timezone (Asia/Kolkata = UTC+5:30)', () => {
    config.logTimezone = 'Asia/Kolkata';
    // Log says 17:30 in IST → 12:00 UTC
    const d = config.parseLogTimestamp('2026', '2', '13', '17', '30');
    assert.equal(d.toISOString(), '2026-02-13T12:00:00.000Z');
  });

  it('pads single-digit month and day', () => {
    config.logTimezone = 'UTC';
    const d = config.parseLogTimestamp('2026', '2', '3', '9', '5');
    assert.equal(d.toISOString(), '2026-02-03T09:05:00.000Z');
  });
});

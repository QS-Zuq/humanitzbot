/**
 * Tests for PlaytimeTracker._formatDuration()
 * Run: npm test
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const playtime = require('../src/playtime-tracker');

describe('_formatDuration', () => {
  it('returns "0m" for zero ms', () => {
    assert.equal(playtime._formatDuration(0), '0m');
  });

  it('returns "0m" for sub-second values', () => {
    assert.equal(playtime._formatDuration(500), '0m');
    assert.equal(playtime._formatDuration(999), '0m');
  });

  it('formats minutes only', () => {
    assert.equal(playtime._formatDuration(5 * 60 * 1000), '5 Minutes');
  });

  it('formats singular minute', () => {
    assert.equal(playtime._formatDuration(60 * 1000), '1 Minute');
  });

  it('formats hours and minutes', () => {
    const ms = (2 * 3600 + 30 * 60) * 1000;
    assert.equal(playtime._formatDuration(ms), '2 Hours, 30 Minutes');
  });

  it('formats singular hour', () => {
    const ms = 3600 * 1000;
    assert.equal(playtime._formatDuration(ms), '1 Hour');
  });

  it('formats days, hours, and minutes', () => {
    const ms = (1 * 86400 + 5 * 3600 + 15 * 60) * 1000;
    assert.equal(playtime._formatDuration(ms), '1 Day, 5 Hours, 15 Minutes');
  });

  it('formats multiple days', () => {
    const ms = (3 * 86400 + 0 * 3600 + 0 * 60) * 1000;
    assert.equal(playtime._formatDuration(ms), '3 Days');
  });

  it('formats exactly 24 hours as 1 day', () => {
    const ms = 86400 * 1000;
    assert.equal(playtime._formatDuration(ms), '1 Day');
  });

  it('singular day', () => {
    const ms = (1 * 86400 + 1 * 3600 + 1 * 60) * 1000;
    assert.equal(playtime._formatDuration(ms), '1 Day, 1 Hour, 1 Minute');
  });
});

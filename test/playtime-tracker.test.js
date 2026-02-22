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

// ── Peak tracking ─────────────────────────────────────────────
const { after } = require('node:test');
const fs = require('fs');
const path = require('path');

/**
 * Helper: create a fresh playtime tracker isolated from the real data file.
 * We stub _load, _save, and config.getToday for controlled testing.
 */
function freshTracker(today = '2026-02-20') {
  // Clear the module cache so we get a fresh singleton
  const modPath = require.resolve('../src/playtime-tracker');
  delete require.cache[modPath];
  const tracker = require(modPath);

  // Stub config.getToday
  const config = require('../src/config');
  const origGetToday = config.getToday;
  config.getToday = () => today;

  // Force init with fresh data (skip loading file)
  tracker._loaded = true;
  tracker._data = {
    trackingSince: '2026-02-13T00:00:00.000Z',
    players: {},
    peaks: {
      allTimePeak: 0,
      allTimePeakDate: null,
      todayPeak: 0,
      todayDate: today,
      uniqueToday: [],
      uniqueDayPeak: 0,
      uniqueDayPeakDate: null,
      yesterdayUnique: 0,
    },
  };
  tracker._dirty = false;

  // No-op save
  tracker._save = () => {};

  return { tracker, config, origGetToday, modPath };
}

describe('Peak tracking', () => {
  let tracker, config, origGetToday, modPath;

  after(() => {
    // Restore config.getToday and clean up
    if (origGetToday) config.getToday = origGetToday;
    if (modPath) delete require.cache[modPath];
    clearInterval(tracker?._saveTimer);
  });

  it('recordPlayerCount updates allTimePeak and todayPeak', () => {
    ({ tracker, config, origGetToday, modPath } = freshTracker());
    tracker.recordPlayerCount(5);
    const peaks = tracker.getPeaks();
    assert.equal(peaks.allTimePeak, 5);
    assert.equal(peaks.todayPeak, 5);
  });

  it('allTimePeak only increases, never decreases', () => {
    ({ tracker, config, origGetToday, modPath } = freshTracker());
    tracker.recordPlayerCount(8);
    tracker.recordPlayerCount(3);
    assert.equal(tracker.getPeaks().allTimePeak, 8);
    assert.equal(tracker.getPeaks().todayPeak, 8);
  });

  it('recordUniqueToday tracks unique player IDs', () => {
    ({ tracker, config, origGetToday, modPath } = freshTracker());
    tracker.recordPlayerCount(1); // ensure peaks exist
    tracker.recordUniqueToday('76561198000000001');
    tracker.recordUniqueToday('76561198000000002');
    tracker.recordUniqueToday('76561198000000001'); // duplicate
    assert.equal(tracker.getPeaks().uniqueToday, 2);
  });

  it('recordUniqueToday updates uniqueDayPeak', () => {
    ({ tracker, config, origGetToday, modPath } = freshTracker());
    tracker.recordPlayerCount(1);
    for (let i = 1; i <= 7; i++) {
      tracker.recordUniqueToday(`7656119800000000${i}`);
    }
    assert.equal(tracker.getPeaks().uniqueDayPeak, 7);
    assert.ok(tracker.getPeaks().uniqueDayPeakDate);
  });

  it('day rollover snapshots yesterdayUnique and resets daily stats', () => {
    ({ tracker, config, origGetToday, modPath } = freshTracker('2026-02-19'));
    tracker.recordPlayerCount(4);
    tracker.recordUniqueToday('76561198000000001');
    tracker.recordUniqueToday('76561198000000002');
    tracker.recordUniqueToday('76561198000000003');

    // Simulate day rollover
    config.getToday = () => '2026-02-20';
    tracker.recordPlayerCount(2);

    const peaks = tracker.getPeaks();
    assert.equal(peaks.yesterdayUnique, 3, 'yesterdayUnique should be snapshotted');
    assert.equal(peaks.uniqueToday, 0, 'uniqueToday should be reset');
    assert.equal(peaks.todayPeak, 2, 'todayPeak should reflect new day count');
    assert.equal(peaks.allTimePeak, 4, 'allTimePeak should persist from yesterday');
  });

  it('day rollover updates uniqueDayPeak if yesterday was a record day', () => {
    ({ tracker, config, origGetToday, modPath } = freshTracker('2026-02-19'));
    tracker.recordPlayerCount(2);
    for (let i = 1; i <= 11; i++) {
      tracker.recordUniqueToday(`7656119800000${String(i).padStart(4, '0')}`);
    }

    // Simulate day rollover
    config.getToday = () => '2026-02-20';
    tracker.recordPlayerCount(1);

    assert.equal(tracker.getPeaks().uniqueDayPeak, 11);
  });

  it('getPeaks returns all expected fields', () => {
    ({ tracker, config, origGetToday, modPath } = freshTracker());
    tracker.recordPlayerCount(3);
    tracker.recordUniqueToday('76561198000000001');

    const peaks = tracker.getPeaks();
    assert.equal(typeof peaks.allTimePeak, 'number');
    assert.equal(typeof peaks.todayPeak, 'number');
    assert.equal(typeof peaks.uniqueToday, 'number');
    assert.equal(typeof peaks.uniqueDayPeak, 'number');
    assert.equal(typeof peaks.yesterdayUnique, 'number');
    assert.equal(typeof peaks.totalUniquePlayers, 'number');
  });
});

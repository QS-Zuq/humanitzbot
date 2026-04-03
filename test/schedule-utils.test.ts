/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-floating-promises */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import * as _schedule_utils from '../src/modules/schedule-utils.js';
const { getDayOfYear, getDayOffset, getRotatedProfileIndex, getTodaySchedule, getActiveProfileIndex } =
  _schedule_utils as any;

describe('schedule-utils', () => {
  describe('getDayOfYear', () => {
    it('returns 0 for January 1', () => {
      const jan1 = new Date('2026-01-01T12:00:00Z');
      assert.equal(getDayOfYear('UTC', jan1), 0);
    });

    it('returns 31 for February 1', () => {
      const feb1 = new Date('2026-02-01T12:00:00Z');
      assert.equal(getDayOfYear('UTC', feb1), 31);
    });

    it('returns 364 for December 31 (non-leap year)', () => {
      const dec31 = new Date('2026-12-31T12:00:00Z');
      assert.equal(getDayOfYear('UTC', dec31), 364);
    });
  });

  describe('getDayOffset', () => {
    it('returns 0 when rotation is disabled', () => {
      assert.equal(getDayOffset('UTC', 3, false), 0);
    });

    it('returns 0 when only one profile', () => {
      assert.equal(getDayOffset('UTC', 1, true), 0);
    });

    it('returns dayOfYear % profileCount', () => {
      // Day 31 (Feb 1) with 3 profiles → 31 % 3 = 1
      const feb1 = new Date('2026-02-01T12:00:00Z');
      assert.equal(getDayOffset('UTC', 3, true, feb1), 1);
    });

    it('wraps around correctly', () => {
      // Day 0 (Jan 1) → 0 % 3 = 0
      const jan1 = new Date('2026-01-01T12:00:00Z');
      assert.equal(getDayOffset('UTC', 3, true, jan1), 0);
      // Day 2 (Jan 3) → 2 % 3 = 2
      const jan3 = new Date('2026-01-03T12:00:00Z');
      assert.equal(getDayOffset('UTC', 3, true, jan3), 2);
      // Day 3 (Jan 4) → 3 % 3 = 0 (wraps)
      const jan4 = new Date('2026-01-04T12:00:00Z');
      assert.equal(getDayOffset('UTC', 3, true, jan4), 0);
    });
  });

  describe('getRotatedProfileIndex', () => {
    it('returns slotIndex when offset is 0', () => {
      assert.equal(getRotatedProfileIndex(0, 3, 0), 0);
      assert.equal(getRotatedProfileIndex(1, 3, 0), 1);
      assert.equal(getRotatedProfileIndex(2, 3, 0), 2);
    });

    it('shifts by offset', () => {
      // offset=1: slot0→1, slot1→2, slot2→0
      assert.equal(getRotatedProfileIndex(0, 3, 1), 1);
      assert.equal(getRotatedProfileIndex(1, 3, 1), 2);
      assert.equal(getRotatedProfileIndex(2, 3, 1), 0);
    });

    it('wraps correctly with offset=2', () => {
      // offset=2: slot0→2, slot1→0, slot2→1
      assert.equal(getRotatedProfileIndex(0, 3, 2), 2);
      assert.equal(getRotatedProfileIndex(1, 3, 2), 0);
      assert.equal(getRotatedProfileIndex(2, 3, 2), 1);
    });
  });

  describe('getTodaySchedule', () => {
    const times = ['01:00', '09:00', '17:00'];
    const profiles = ['calm', 'surge', 'horde'];

    it('returns static order when offset is 0', () => {
      const schedule = getTodaySchedule(times, profiles, 0);
      assert.equal(schedule.length, 3);
      assert.equal(schedule[0].profileName, 'calm');
      assert.equal(schedule[0].startTime, '01:00');
      assert.equal(schedule[0].endTime, '09:00');
      assert.equal(schedule[1].profileName, 'surge');
      assert.equal(schedule[2].profileName, 'horde');
    });

    it('rotates profiles when offset is 1', () => {
      const schedule = getTodaySchedule(times, profiles, 1);
      // slot 0 → profile 1 (surge), slot 1 → profile 2 (horde), slot 2 → profile 0 (calm)
      assert.equal(schedule[0].profileName, 'surge');
      assert.equal(schedule[0].startTime, '01:00');
      assert.equal(schedule[1].profileName, 'horde');
      assert.equal(schedule[1].startTime, '09:00');
      assert.equal(schedule[2].profileName, 'calm');
      assert.equal(schedule[2].startTime, '17:00');
    });

    it('rotates profiles when offset is 2', () => {
      const schedule = getTodaySchedule(times, profiles, 2);
      assert.equal(schedule[0].profileName, 'horde');
      assert.equal(schedule[1].profileName, 'calm');
      assert.equal(schedule[2].profileName, 'surge');
    });
  });

  describe('getActiveProfileIndex', () => {
    const timeMins = [60, 540, 1020]; // 01:00, 09:00, 17:00

    it('returns correct profile at start of day (before first restart)', () => {
      // 00:30 → slot 0 (before any restart, wraps to slot 0)
      const idx = getActiveProfileIndex(timeMins, 30, 3, 0);
      assert.equal(idx, 0);
    });

    it('returns correct profile after first restart', () => {
      // 02:00 → slot 0 (after 01:00)
      const idx = getActiveProfileIndex(timeMins, 120, 3, 0);
      assert.equal(idx, 0);
    });

    it('returns correct profile after second restart', () => {
      // 10:00 → slot 1 (after 09:00)
      const idx = getActiveProfileIndex(timeMins, 600, 3, 0);
      assert.equal(idx, 1);
    });

    it('returns correct profile after third restart', () => {
      // 20:00 → slot 2 (after 17:00)
      const idx = getActiveProfileIndex(timeMins, 1200, 3, 0);
      assert.equal(idx, 2);
    });

    it('applies day offset correctly', () => {
      // 10:00 → slot 1 with offset 1 → profile (1+1)%3 = 2
      const idx = getActiveProfileIndex(timeMins, 600, 3, 1);
      assert.equal(idx, 2);
    });
  });
});

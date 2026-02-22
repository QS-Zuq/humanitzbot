/**
 * Tests for pvp-scheduler.js — per-day PvP hours, window detection, transitions.
 * Run: npm test
 */
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// Minimal stub for PvpScheduler — we only test pure-logic methods
const PvpScheduler = require('../src/pvp-scheduler');

function makeScheduler(overrides = {}) {
  const config = {
    pvpStartMinutes: 1080, // 18:00
    pvpEndMinutes: 1320,   // 22:00
    pvpDays: null,         // every day
    pvpDayHours: null,     // no per-day overrides
    pvpRestartDelay: 10,
    pvpUpdateServerName: false,
    botTimezone: 'UTC',
    ftpHost: '', ftpPort: 22, ftpUser: '', ftpPassword: '',
    ftpSettingsPath: '',
    adminChannelId: '',
    enablePvpScheduler: true,
    ...overrides,
  };
  const stub = new PvpScheduler(null, null, { config, rcon: { send: async () => '' }, label: 'TEST' });
  // Set internal state that start() normally resolves
  stub._pvpStart = config.pvpStartMinutes;
  stub._pvpEnd = config.pvpEndMinutes;
  stub._pvpDayHours = config.pvpDayHours;
  stub._currentPvp = false;
  return stub;
}

// ══════════════════════════════════════════════════════════
// _getHoursForDay — per-day override resolution
// ══════════════════════════════════════════════════════════

describe('_getHoursForDay', () => {
  it('returns global defaults when no per-day overrides', () => {
    const s = makeScheduler();
    const h = s._getHoursForDay(1); // Monday
    assert.deepEqual(h, { start: 1080, end: 1320 });
  });

  it('returns per-day override when set', () => {
    const s = makeScheduler({
      pvpDayHours: new Map([
        [5, { start: 960, end: 1380 }], // Friday: 16:00-23:00
      ]),
    });
    assert.deepEqual(s._getHoursForDay(5), { start: 960, end: 1380 });
    assert.deepEqual(s._getHoursForDay(1), { start: 1080, end: 1320 }); // fallback
  });

  it('returns per-day override for all configured days', () => {
    const s = makeScheduler({
      pvpDayHours: new Map([
        [0, { start: 720, end: 1440 }],  // Sun: 12:00-24:00
        [6, { start: 720, end: 1440 }],  // Sat: 12:00-24:00
      ]),
    });
    assert.deepEqual(s._getHoursForDay(0), { start: 720, end: 1440 }); // Sun
    assert.deepEqual(s._getHoursForDay(6), { start: 720, end: 1440 }); // Sat
    assert.deepEqual(s._getHoursForDay(3), { start: 1080, end: 1320 }); // Wed = default
  });
});

// ══════════════════════════════════════════════════════════
// _isInsidePvpWindow — with per-day hours
// ══════════════════════════════════════════════════════════

describe('_isInsidePvpWindow (global defaults)', () => {
  it('returns true when inside same-day window', () => {
    const s = makeScheduler(); // 18:00-22:00
    assert.equal(s._isInsidePvpWindow(1100, 3), true); // Wed 18:20
  });

  it('returns false when outside window', () => {
    const s = makeScheduler();
    assert.equal(s._isInsidePvpWindow(600, 3), false); // Wed 10:00
  });

  it('returns false at exact end time', () => {
    const s = makeScheduler();
    assert.equal(s._isInsidePvpWindow(1320, 3), false); // Wed 22:00
  });

  it('returns true at exact start time', () => {
    const s = makeScheduler();
    assert.equal(s._isInsidePvpWindow(1080, 3), true); // Wed 18:00
  });
});

describe('_isInsidePvpWindow (per-day overrides)', () => {
  it('uses Friday override when on Friday', () => {
    const s = makeScheduler({
      pvpDayHours: new Map([
        [5, { start: 960, end: 1380 }], // Friday: 16:00-23:00
      ]),
    });
    assert.equal(s._isInsidePvpWindow(1000, 5), true);  // Fri 16:40 — inside override
    assert.equal(s._isInsidePvpWindow(1350, 5), true);  // Fri 22:30 — inside override (past default end)
    assert.equal(s._isInsidePvpWindow(900, 5), false);   // Fri 15:00 — before override start
  });

  it('uses global default on days without override', () => {
    const s = makeScheduler({
      pvpDayHours: new Map([
        [5, { start: 960, end: 1380 }], // Friday only
      ]),
    });
    assert.equal(s._isInsidePvpWindow(1100, 3), true);  // Wed 18:20 — default range
    assert.equal(s._isInsidePvpWindow(1350, 3), false);  // Wed 22:30 — outside default
  });
});

describe('_isInsidePvpWindow (overnight)', () => {
  it('detects inside overnight window after start', () => {
    const s = makeScheduler({
      pvpStartMinutes: 1320, // 22:00
      pvpEndMinutes: 360,    // 06:00
    });
    assert.equal(s._isInsidePvpWindow(1380, 3), true); // Wed 23:00
  });

  it('detects inside overnight window before end (next day)', () => {
    const s = makeScheduler({
      pvpStartMinutes: 1320, // 22:00
      pvpEndMinutes: 360,    // 06:00
    });
    assert.equal(s._isInsidePvpWindow(120, 4), true); // Thu 02:00 (started Wed night)
  });

  it('detects outside overnight window in the gap', () => {
    const s = makeScheduler({
      pvpStartMinutes: 1320, // 22:00
      pvpEndMinutes: 360,    // 06:00
    });
    assert.equal(s._isInsidePvpWindow(720, 4), false); // Thu 12:00
  });
});

describe('_isInsidePvpWindow (pvpDays filter)', () => {
  it('returns false on non-PvP days', () => {
    const s = makeScheduler({
      pvpDays: new Set([5, 6]), // Fri, Sat only
    });
    assert.equal(s._isInsidePvpWindow(1100, 3), false); // Wed 18:20 — not a PvP day
    assert.equal(s._isInsidePvpWindow(1100, 5), true);  // Fri 18:20 — PvP day
  });
});

// ══════════════════════════════════════════════════════════
// _minutesUntilNextTransition — per-day aware
// ══════════════════════════════════════════════════════════

describe('_minutesUntilNextTransition', () => {
  it('calculates minutes until PvP OFF when inside window', () => {
    const s = makeScheduler();
    // Mock _getCurrentTime to return Wed 19:00
    s._getCurrentTime = () => ({ hour: 19, minute: 0, totalMinutes: 1140, dayOfWeek: 3 });
    s._currentPvp = true;
    const { minutesUntil, targetPvp } = s._minutesUntilNextTransition();
    assert.equal(targetPvp, false); // next transition = PvP OFF
    assert.equal(minutesUntil, 180); // 22:00 - 19:00 = 180 min
  });

  it('calculates minutes until PvP ON when outside window', () => {
    const s = makeScheduler();
    s._getCurrentTime = () => ({ hour: 10, minute: 0, totalMinutes: 600, dayOfWeek: 3 });
    const { minutesUntil, targetPvp } = s._minutesUntilNextTransition();
    assert.equal(targetPvp, true); // next transition = PvP ON
    assert.equal(minutesUntil, 480); // 18:00 - 10:00 = 480 min
  });

  it('uses per-day override for next start time', () => {
    const s = makeScheduler({
      pvpDayHours: new Map([
        [5, { start: 960, end: 1380 }], // Friday: 16:00-23:00
      ]),
    });
    // Friday 10:00 — next start should be Friday's 16:00
    s._getCurrentTime = () => ({ hour: 10, minute: 0, totalMinutes: 600, dayOfWeek: 5 });
    const { minutesUntil, targetPvp } = s._minutesUntilNextTransition();
    assert.equal(targetPvp, true);
    assert.equal(minutesUntil, 360); // 16:00 - 10:00
  });

  it('uses per-day override for PvP OFF end time', () => {
    const s = makeScheduler({
      pvpDayHours: new Map([
        [5, { start: 960, end: 1380 }], // Friday: 16:00-23:00
      ]),
    });
    // Friday 20:00 — inside PvP, end should be 23:00
    s._getCurrentTime = () => ({ hour: 20, minute: 0, totalMinutes: 1200, dayOfWeek: 5 });
    s._currentPvp = true;
    const { minutesUntil, targetPvp } = s._minutesUntilNextTransition();
    assert.equal(targetPvp, false);
    assert.equal(minutesUntil, 180); // 23:00 - 20:00
  });

  it('skips to next PvP day when today is past start', () => {
    const s = makeScheduler({
      pvpDays: new Set([1, 5]), // Mon, Fri
    });
    // Monday 23:00 — PvP already ended, next is Friday
    s._getCurrentTime = () => ({ hour: 23, minute: 0, totalMinutes: 1380, dayOfWeek: 1 });
    const { minutesUntil, targetPvp } = s._minutesUntilNextTransition();
    assert.equal(targetPvp, true);
    // Mon 23:00 to Fri 18:00 = 4 days * 1440 - 1380 + 1080 = 5760 - 1380 + 1080 = 5460
    assert.equal(minutesUntil, 5460);
  });
});

// ══════════════════════════════════════════════════════════
// _formatPvpTimeRange — shows today's hours
// ══════════════════════════════════════════════════════════

describe('_formatPvpTimeRange', () => {
  it('shows global default when no override', () => {
    const s = makeScheduler();
    s._getCurrentTime = () => ({ hour: 12, minute: 0, totalMinutes: 720, dayOfWeek: 3 });
    assert.match(s._formatPvpTimeRange(), /18:00-22:00/);
  });

  it('shows per-day hours for current day', () => {
    const s = makeScheduler({
      pvpDayHours: new Map([
        [5, { start: 960, end: 1380 }], // Friday: 16:00-23:00
      ]),
    });
    s._getCurrentTime = () => ({ hour: 12, minute: 0, totalMinutes: 720, dayOfWeek: 5 });
    assert.match(s._formatPvpTimeRange(), /16:00-23:00/);
  });
});

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import _config from '../src/config/index.js';
const config = _config as any;

import { _cleanActorName, _formatLocation, _test as _activityTest } from '../src/modules/activity-log.js';

const { _filterEvents, _formatTime, _categoryTitle } = _activityTest;

// ── _cleanActorName ─────────────────────────────────────────────────────────

describe('_cleanActorName', () => {
  it('strips BP_ prefix and _C suffix', () => {
    assert.equal(_cleanActorName('BP_WoodWall_C_12345'), 'Wood Wall');
  });

  it('strips GEN_VARIABLE pattern', () => {
    assert.equal(_cleanActorName('Door_GEN_VARIABLE_BP_LockedMetalShutter_C_CAT_2147206852'), 'Locked Metal Shutter');
  });

  it('splits CamelCase into spaces', () => {
    assert.equal(_cleanActorName('LockedMetalShutter'), 'Locked Metal Shutter');
  });

  it('returns "Unknown" for null', () => {
    assert.equal(_cleanActorName(null), 'Unknown');
  });

  it('returns "Unknown" for empty string', () => {
    assert.equal(_cleanActorName(''), 'Unknown');
  });

  it('returns already-clean name as-is', () => {
    assert.equal(_cleanActorName('Wood Wall'), 'Wood Wall');
  });
});

// ── _formatLocation ─────────────────────────────────────────────────────────

describe('_formatLocation', () => {
  it('formats valid x/y to a grid label', () => {
    // Center of map → [E5]
    const result = _formatLocation({ x: 201200, y: -200600 });
    assert.equal(result, ' `[E5]`');
  });

  it('uses pos_x/pos_y when x/y are missing', () => {
    const result = _formatLocation({ pos_x: 201200, pos_y: -200600 });
    assert.equal(result, ' `[E5]`');
  });

  it('returns [A1] at minimum bounds', () => {
    const result = _formatLocation({ x: 3250, y: -398550 });
    assert.equal(result, ' `[A1]`');
  });

  it('returns [H8] at maximum bounds', () => {
    const result = _formatLocation({ x: 399150, y: -2650 });
    assert.equal(result, ' `[H8]`');
  });

  it('clamps out-of-bounds negative x to row 1', () => {
    const result = _formatLocation({ x: -10000, y: -200600 });
    assert.match(result, /\[E1\]/);
  });

  it('clamps out-of-bounds large y to column H', () => {
    const result = _formatLocation({ x: 201200, y: 99999 });
    assert.match(result, /\[H5\]/);
  });

  it('returns empty string when x is null', () => {
    assert.equal(_formatLocation({ x: null, y: -200600 }), '');
  });

  it('returns empty string when both coordinates are missing', () => {
    assert.equal(_formatLocation({}), '');
  });
});

// ── _filterEvents ───────────────────────────────────────────────────────────

describe('_filterEvents', () => {
  const allEvents = [
    { category: 'container', type: 'container_item_added' },
    { category: 'inventory', type: 'inventory_item_added' },
    { category: 'horse', type: 'horse_appeared' },
    { category: 'vehicle', type: 'vehicle_item_added' },
    { category: 'world', type: 'world_day_advanced' },
    { category: 'structure', type: 'structure_built' },
  ];

  // Save original config values and restore after each test
  let saved: Record<string, unknown>;
  beforeEach(() => {
    saved = {
      showInventoryLog: config.showInventoryLog,
      enableContainerLog: config.enableContainerLog,
      enableHorseLog: config.enableHorseLog,
      enableVehicleLog: config.enableVehicleLog,
      enableWorldEventFeed: config.enableWorldEventFeed,
      enableStructureLog: config.enableStructureLog,
    };
    // Enable all by default
    config.showInventoryLog = true;
    config.enableContainerLog = true;
    config.enableHorseLog = true;
    config.enableVehicleLog = true;
    config.enableWorldEventFeed = true;
    config.enableStructureLog = true;
  });

  afterEach(() => {
    Object.assign(config, saved);
  });

  it('passes all events when all toggles are enabled', () => {
    const result = _filterEvents.call({}, allEvents);
    assert.equal(result.length, allEvents.length);
  });

  it('filters inventory when showInventoryLog is false', () => {
    config.showInventoryLog = false;
    const result = _filterEvents.call({}, allEvents);
    assert.equal(result.length, allEvents.length - 1);
    assert.ok(!result.some((e: { category: string }) => e.category === 'inventory'));
  });

  it('filters container when enableContainerLog is false', () => {
    config.enableContainerLog = false;
    const result = _filterEvents.call({}, allEvents);
    assert.equal(result.length, allEvents.length - 1);
    assert.ok(!result.some((e: { category: string }) => e.category === 'container'));
  });

  it('filters horse when enableHorseLog is false', () => {
    config.enableHorseLog = false;
    const result = _filterEvents.call({}, allEvents);
    assert.equal(result.length, allEvents.length - 1);
    assert.ok(!result.some((e: { category: string }) => e.category === 'horse'));
  });

  it('filters vehicle when enableVehicleLog is false', () => {
    config.enableVehicleLog = false;
    const result = _filterEvents.call({}, allEvents);
    assert.equal(result.length, allEvents.length - 1);
    assert.ok(!result.some((e: { category: string }) => e.category === 'vehicle'));
  });

  it('filters world when enableWorldEventFeed is false', () => {
    config.enableWorldEventFeed = false;
    const result = _filterEvents.call({}, allEvents);
    assert.equal(result.length, allEvents.length - 1);
    assert.ok(!result.some((e: { category: string }) => e.category === 'world'));
  });

  it('filters structure when enableStructureLog is false', () => {
    config.enableStructureLog = false;
    const result = _filterEvents.call({}, allEvents);
    assert.equal(result.length, allEvents.length - 1);
    assert.ok(!result.some((e: { category: string }) => e.category === 'structure'));
  });

  it('passes unknown categories through', () => {
    const events = [{ category: 'custom_thing', type: 'custom_event' }];
    const result = _filterEvents.call({}, events);
    assert.equal(result.length, 1);
  });

  it('returns empty array for empty input', () => {
    const result = _filterEvents.call({}, []);
    assert.deepEqual(result, []);
  });
});

// ── _formatTime ─────────────────────────────────────────────────────────────

describe('_formatTime', () => {
  beforeEach(() => {
    config.botTimezone = 'UTC';
  });

  it('formats an ISO string to a time string', () => {
    const result = _formatTime('2026-01-15T14:30:00Z');
    assert.ok(result.length > 0, 'should return non-empty string');
    assert.match(result, /\d{1,2}[:.]\d{2}/, 'should contain time digits');
  });

  it('formats a Date object to a time string', () => {
    const result = _formatTime(new Date('2026-06-01T08:15:00Z'));
    assert.ok(result.length > 0, 'should return non-empty string');
    assert.match(result, /\d{1,2}[:.]\d{2}/, 'should contain time digits');
  });

  it('returns empty string for null', () => {
    assert.equal(_formatTime(null), '');
  });

  it('returns empty string for undefined', () => {
    assert.equal(_formatTime(undefined), '');
  });

  it('returns empty string for invalid date string', () => {
    assert.equal(_formatTime('not-a-date'), '');
  });
});

// ── _categoryTitle ──────────────────────────────────────────────────────────

describe('_categoryTitle', () => {
  it('returns correct title for container', () => {
    assert.equal(_categoryTitle('container'), 'Container Activity');
  });

  it('returns correct title for inventory', () => {
    assert.equal(_categoryTitle('inventory'), 'Inventory Changes');
  });

  it('returns correct title for horse', () => {
    assert.equal(_categoryTitle('horse'), 'Horse Activity');
  });

  it('returns correct title for vehicle', () => {
    assert.equal(_categoryTitle('vehicle'), 'Vehicle Activity');
  });

  it('returns correct title for world', () => {
    assert.equal(_categoryTitle('world'), 'World Events');
  });

  it('returns correct title for structure', () => {
    assert.equal(_categoryTitle('structure'), 'Structure Activity');
  });

  it('returns generic title for unknown category', () => {
    assert.equal(_categoryTitle('something_else'), 'Activity');
  });
});

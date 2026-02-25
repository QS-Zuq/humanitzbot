/**
 * Tests for src/db/diff-engine.js — save-file diff engine.
 *
 * Covers: _normalizeItems, _buildItemBag, _diffItemLists,
 *         diffContainers, diffHorses, diffPlayerInventories,
 *         diffWorldState, diffVehicleInventories, diffSaveState.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  diffSaveState,
  diffContainers,
  diffHorses,
  diffPlayerInventories,
  diffWorldState,
  diffVehicleInventories,
  _diffItemLists,
  _normalizeItems,
  _buildItemBag,
} = require('../src/db/diff-engine');

// ═══════════════════════════════════════════════════════════════════════════
//  _normalizeItems
// ═══════════════════════════════════════════════════════════════════════════

describe('_normalizeItems', () => {
  it('returns empty array for null/undefined', () => {
    assert.deepEqual(_normalizeItems(null), []);
    assert.deepEqual(_normalizeItems(undefined), []);
  });

  it('returns empty array for non-array values', () => {
    assert.deepEqual(_normalizeItems(42), []);
    assert.deepEqual(_normalizeItems(true), []);
    assert.deepEqual(_normalizeItems({}), []);
  });

  it('parses JSON string', () => {
    const json = JSON.stringify([{ item: 'Axe', amount: 1 }]);
    const result = _normalizeItems(json);
    assert.equal(result.length, 1);
    assert.equal(result[0].item, 'Axe');
  });

  it('returns empty array for invalid JSON string', () => {
    assert.deepEqual(_normalizeItems('{bad json'), []);
  });

  it('passes through plain arrays', () => {
    const items = [{ item: 'Sword', amount: 1 }];
    assert.deepEqual(_normalizeItems(items), items);
  });

  it('filters out None and Empty items', () => {
    const items = [
      { item: 'Axe', amount: 1 },
      { item: 'None', amount: 0 },
      { item: 'Empty', amount: 0 },
      { item: 'Sword', amount: 1 },
    ];
    const result = _normalizeItems(items);
    assert.equal(result.length, 2);
    assert.equal(result[0].item, 'Axe');
    assert.equal(result[1].item, 'Sword');
  });

  it('filters out null entries and entries without item field', () => {
    const items = [
      null,
      { amount: 5 },
      { item: 'Bandage', amount: 3 },
    ];
    const result = _normalizeItems(items);
    assert.equal(result.length, 1);
    assert.equal(result[0].item, 'Bandage');
  });

  it('returns empty array for empty string', () => {
    assert.deepEqual(_normalizeItems(''), []);
  });

  it('handles "[]" JSON string', () => {
    assert.deepEqual(_normalizeItems('[]'), []);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  _buildItemBag
// ═══════════════════════════════════════════════════════════════════════════

describe('_buildItemBag', () => {
  it('groups items by name', () => {
    const items = [
      { item: 'Axe', amount: 1 },
      { item: 'Bandage', amount: 5 },
      { item: 'Axe', amount: 1 },
    ];
    const bag = _buildItemBag(items);
    assert.equal(bag.size, 2);
    assert.equal(bag.get('Axe').length, 2);
    assert.equal(bag.get('Bandage').length, 1);
  });

  it('returns empty map for empty array', () => {
    const bag = _buildItemBag([]);
    assert.equal(bag.size, 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  _diffItemLists
// ═══════════════════════════════════════════════════════════════════════════

describe('_diffItemLists', () => {
  it('returns empty for identical lists', () => {
    const items = [{ item: 'Axe', amount: 1 }];
    const { added, removed } = _diffItemLists(items, items);
    assert.equal(added.length, 0);
    assert.equal(removed.length, 0);
  });

  it('detects new item added', () => {
    const old = [{ item: 'Axe', amount: 1 }];
    const now = [{ item: 'Axe', amount: 1 }, { item: 'Bandage', amount: 3 }];
    const { added, removed } = _diffItemLists(old, now);
    assert.equal(added.length, 1);
    assert.equal(added[0].item, 'Bandage');
    assert.equal(added[0].amount, 3);
    assert.equal(removed.length, 0);
  });

  it('detects item removed', () => {
    const old = [{ item: 'Axe', amount: 1 }, { item: 'Sword', amount: 1 }];
    const now = [{ item: 'Axe', amount: 1 }];
    const { added, removed } = _diffItemLists(old, now);
    assert.equal(added.length, 0);
    assert.equal(removed.length, 1);
    assert.equal(removed[0].item, 'Sword');
  });

  it('detects quantity increase', () => {
    const old = [{ item: 'Bandage', amount: 3 }];
    const now = [{ item: 'Bandage', amount: 5 }];
    const { added, removed } = _diffItemLists(old, now);
    assert.equal(added.length, 1);
    assert.equal(added[0].item, 'Bandage');
    assert.equal(added[0].amount, 2);
    assert.equal(removed.length, 0);
  });

  it('detects quantity decrease', () => {
    const old = [{ item: 'Bandage', amount: 10 }];
    const now = [{ item: 'Bandage', amount: 4 }];
    const { added, removed } = _diffItemLists(old, now);
    assert.equal(added.length, 0);
    assert.equal(removed.length, 1);
    assert.equal(removed[0].item, 'Bandage');
    assert.equal(removed[0].amount, 6);
  });

  it('handles empty old list (all items new)', () => {
    const now = [{ item: 'Gun', amount: 1 }, { item: 'Ammo', amount: 30 }];
    const { added, removed } = _diffItemLists([], now);
    assert.equal(added.length, 2);
    assert.equal(removed.length, 0);
  });

  it('handles empty new list (all items removed)', () => {
    const old = [{ item: 'Food', amount: 2 }];
    const { added, removed } = _diffItemLists(old, []);
    assert.equal(added.length, 0);
    assert.equal(removed.length, 1);
    assert.equal(removed[0].item, 'Food');
    assert.equal(removed[0].amount, 2);
  });

  it('sums amounts for duplicate item names', () => {
    const old = [
      { item: 'Nail', amount: 10 },
      { item: 'Nail', amount: 5 },
    ];
    const now = [
      { item: 'Nail', amount: 20 },
    ];
    const { added, removed } = _diffItemLists(old, now);
    // Old total = 15, new total = 20, so added 5
    assert.equal(added.length, 1);
    assert.equal(added[0].amount, 5);
    assert.equal(removed.length, 0);
  });

  it('defaults missing amount to 1', () => {
    const old = [{ item: 'Axe' }]; // no amount field
    const now = [{ item: 'Axe' }, { item: 'Axe' }];
    const { added, removed } = _diffItemLists(old, now);
    // Old = 1, New = 2
    assert.equal(added.length, 1);
    assert.equal(added[0].amount, 1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  diffContainers
// ═══════════════════════════════════════════════════════════════════════════

describe('diffContainers', () => {
  it('returns empty for identical containers', () => {
    const c = [{ actorName: 'Box1', items: [{ item: 'Axe', amount: 1 }] }];
    const events = diffContainers(c, c);
    assert.equal(events.length, 0);
  });

  it('detects item added to container', () => {
    const old = [{ actor_name: 'Box1', items: [] }];
    const now = [{ actorName: 'Box1', items: [{ item: 'Rope', amount: 2 }] }];
    const events = diffContainers(old, now);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'container_item_added');
    assert.equal(events[0].category, 'container');
    assert.equal(events[0].actor, 'Box1');
    assert.equal(events[0].item, 'Rope');
    assert.equal(events[0].amount, 2);
  });

  it('detects item removed from container', () => {
    const old = [{ actorName: 'Box1', items: [{ item: 'Rope', amount: 2 }] }];
    const now = [{ actorName: 'Box1', items: [] }];
    const events = diffContainers(old, now);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'container_item_removed');
    assert.equal(events[0].item, 'Rope');
    assert.equal(events[0].amount, 2);
  });

  it('handles DB JSON strings for items', () => {
    const old = [{ actor_name: 'Box1', items: JSON.stringify([{ item: 'Nail', amount: 10 }]) }];
    const now = [{ actorName: 'Box1', items: [{ item: 'Nail', amount: 15 }] }];
    const events = diffContainers(old, now);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'container_item_added');
    assert.equal(events[0].item, 'Nail');
    assert.equal(events[0].amount, 5);
  });

  it('detects container locked', () => {
    const old = [{ actorName: 'Box1', items: [], locked: false }];
    const now = [{ actorName: 'Box1', items: [], locked: true }];
    const events = diffContainers(old, now);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'container_locked');
  });

  it('detects container unlocked', () => {
    const old = [{ actorName: 'Box1', items: [], locked: true }];
    const now = [{ actorName: 'Box1', items: [], locked: false }];
    const events = diffContainers(old, now);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'container_unlocked');
  });

  it('does not report lock change for new containers', () => {
    // If a container is new (not in old), lock state shouldn't be emitted
    const old = [];
    const now = [{ actorName: 'Box1', items: [], locked: true }];
    const events = diffContainers(old, now);
    // No container_locked event — only items matter for new containers
    assert.ok(!events.some(e => e.type === 'container_locked'));
  });

  it('detects container destroyed (disappeared with items)', () => {
    const old = [{ actorName: 'Box1', items: [{ item: 'Axe', amount: 1 }, { item: 'Sword', amount: 1 }] }];
    const now = [];
    const events = diffContainers(old, now);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'container_destroyed');
    assert.equal(events[0].amount, 2); // 2 items lost
    assert.ok(events[0].details.items.length === 2);
  });

  it('does not report destroyed for empty containers that disappear', () => {
    const old = [{ actorName: 'Box1', items: [] }];
    const now = [];
    const events = diffContainers(old, now);
    assert.equal(events.length, 0);
  });

  it('carries position from new container', () => {
    const old = [{ actorName: 'Box1', items: [] }];
    const now = [{ actorName: 'Box1', items: [{ item: 'Axe', amount: 1 }], x: 100, y: 200, z: 50 }];
    const events = diffContainers(old, now);
    assert.equal(events[0].x, 100);
    assert.equal(events[0].y, 200);
    assert.equal(events[0].z, 50);
  });

  it('handles pos_x/pos_y/pos_z naming', () => {
    const old = [{ actor_name: 'Box1', items: [] }];
    const now = [{ actorName: 'Box1', items: [{ item: 'Axe', amount: 1 }], pos_x: 10, pos_y: 20, pos_z: 30 }];
    const events = diffContainers(old, now);
    assert.equal(events[0].x, 10);
    assert.equal(events[0].y, 20);
    assert.equal(events[0].z, 30);
  });

  it('handles multiple containers with mixed changes', () => {
    const old = [
      { actorName: 'Box1', items: [{ item: 'Nail', amount: 10 }] },
      { actorName: 'Box2', items: [{ item: 'Rope', amount: 5 }] },
    ];
    const now = [
      { actorName: 'Box1', items: [{ item: 'Nail', amount: 10 }] }, // unchanged
      { actorName: 'Box2', items: [{ item: 'Rope', amount: 3 }] },  // lost 2
    ];
    const events = diffContainers(old, now);
    assert.equal(events.length, 1);
    assert.equal(events[0].actor, 'Box2');
    assert.equal(events[0].type, 'container_item_removed');
    assert.equal(events[0].amount, 2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  diffHorses
// ═══════════════════════════════════════════════════════════════════════════

describe('diffHorses', () => {
  it('returns empty for identical horses', () => {
    const h = [{ class: 'Horse_A', owner_steam_id: '123', health: 100, display_name: 'Rex' }];
    const events = diffHorses(h, h);
    assert.equal(events.length, 0);
  });

  it('detects new horse appeared', () => {
    const old = [];
    const now = [{ class: 'Horse_A', owner_steam_id: '123', health: 100, display_name: 'Rex' }];
    const events = diffHorses(old, now);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'horse_appeared');
    assert.equal(events[0].actorName, 'Rex');
    assert.equal(events[0].details.owner, '123');
  });

  it('detects horse disappeared', () => {
    const old = [{ class: 'Horse_A', owner_steam_id: '123', health: 100, display_name: 'Rex' }];
    const now = [];
    const events = diffHorses(old, now);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'horse_disappeared');
    assert.equal(events[0].actorName, 'Rex');
    assert.equal(events[0].details.lastHealth, 100);
  });

  it('detects significant health change (>= 5)', () => {
    const old = [{ class: 'Horse_A', owner_steam_id: '123', health: 100 }];
    const now = [{ class: 'Horse_A', owner_steam_id: '123', health: 90 }];
    const events = diffHorses(old, now);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'horse_health_changed');
    assert.equal(events[0].amount, -10);
    assert.equal(events[0].details.oldHealth, 100);
    assert.equal(events[0].details.newHealth, 90);
  });

  it('ignores minor health change (< 5)', () => {
    const old = [{ class: 'Horse_A', owner_steam_id: '123', health: 100 }];
    const now = [{ class: 'Horse_A', owner_steam_id: '123', health: 97 }];
    const events = diffHorses(old, now);
    assert.equal(events.length, 0);
  });

  it('detects health change at exact boundary (5)', () => {
    const old = [{ class: 'Horse_A', owner_steam_id: '123', health: 100 }];
    const now = [{ class: 'Horse_A', owner_steam_id: '123', health: 95 }];
    const events = diffHorses(old, now);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'horse_health_changed');
  });

  it('detects owner change', () => {
    const old = [{ class: 'Horse_A', owner_steam_id: '111', health: 100, display_name: 'Rex' }];
    // Same class but different owner — generates a new key, so one appears, one disappears
    // Actually the composite key is class::owner, so different owners = different keys
    // This means we'll see one disappeared (old owner) and one appeared (new owner)
    const now = [{ class: 'Horse_A', owner_steam_id: '222', health: 100, display_name: 'Rex' }];
    const events = diffHorses(old, now);
    // old key: Horse_A::111, new key: Horse_A::222 — different keys
    assert.equal(events.length, 2);
    const types = events.map(e => e.type).sort();
    assert.deepEqual(types, ['horse_appeared', 'horse_disappeared']);
  });

  it('handles camelCase field names from parser', () => {
    const old = [];
    const now = [{ class: 'Horse_A', ownerSteamId: '123', health: 100, displayName: 'Rex' }];
    const events = diffHorses(old, now);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'horse_appeared');
    assert.equal(events[0].actorName, 'Rex');
  });

  it('handles multiple horses of same class and owner', () => {
    const old = [
      { class: 'Horse_A', owner_steam_id: '123', health: 100, display_name: 'Horse1' },
      { class: 'Horse_A', owner_steam_id: '123', health: 80, display_name: 'Horse2' },
    ];
    const now = [
      { class: 'Horse_A', owner_steam_id: '123', health: 100, display_name: 'Horse1' },
      { class: 'Horse_A', owner_steam_id: '123', health: 80, display_name: 'Horse2' },
    ];
    const events = diffHorses(old, now);
    assert.equal(events.length, 0); // No changes
  });

  it('position fields propagate', () => {
    const old = [];
    const now = [{ class: 'Horse_A', owner_steam_id: '123', health: 100, x: 10, y: 20, z: 30 }];
    const events = diffHorses(old, now);
    assert.equal(events[0].x, 10);
    assert.equal(events[0].y, 20);
    assert.equal(events[0].z, 30);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  diffPlayerInventories
// ═══════════════════════════════════════════════════════════════════════════

describe('diffPlayerInventories', () => {
  it('skips new players (not in old)', () => {
    const old = new Map();
    const now = new Map([['steam1', {
      name: 'Player1',
      inventory: [{ item: 'Axe', amount: 1 }],
    }]]);
    const events = diffPlayerInventories(old, now);
    assert.equal(events.length, 0);
  });

  it('detects item added to inventory', () => {
    const old = new Map([['steam1', {
      name: 'Player1',
      inventory: [{ item: 'Axe', amount: 1 }],
      equipment: [], quick_slots: [], backpack_items: [],
    }]]);
    const now = new Map([['steam1', {
      name: 'Player1',
      inventory: [{ item: 'Axe', amount: 1 }, { item: 'Bandage', amount: 3 }],
      equipment: [], quickSlots: [], backpackItems: [],
    }]]);
    const events = diffPlayerInventories(old, now);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'inventory_item_added');
    assert.equal(events[0].category, 'inventory');
    assert.equal(events[0].actor, 'steam1');
    assert.equal(events[0].item, 'Bandage');
    assert.equal(events[0].amount, 3);
    assert.equal(events[0].details.slot, 'inventory');
  });

  it('detects item removed from equipment', () => {
    const old = new Map([['steam1', {
      name: 'Player1',
      inventory: [], equipment: [{ item: 'Helmet', amount: 1 }],
      quick_slots: [], backpack_items: [],
    }]]);
    const now = new Map([['steam1', {
      name: 'Player1',
      inventory: [], equipment: [],
      quickSlots: [], backpackItems: [],
    }]]);
    const events = diffPlayerInventories(old, now);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'inventory_item_removed');
    assert.equal(events[0].item, 'Helmet');
    assert.equal(events[0].details.slot, 'equipment');
  });

  it('detects changes in quick_slots and backpack', () => {
    const old = new Map([['steam1', {
      inventory: [], equipment: [],
      quick_slots: [{ item: 'Medkit', amount: 1 }],
      backpack_items: [{ item: 'Rope', amount: 5 }],
    }]]);
    const now = new Map([['steam1', {
      inventory: [], equipment: [],
      quickSlots: [{ item: 'Medkit', amount: 1 }, { item: 'Grenade', amount: 2 }],
      backpackItems: [],
    }]]);
    const events = diffPlayerInventories(old, now);
    const qsAdd = events.find(e => e.details.slot === 'quick_slots' && e.type === 'inventory_item_added');
    const bpRem = events.find(e => e.details.slot === 'backpack' && e.type === 'inventory_item_removed');
    assert.ok(qsAdd);
    assert.equal(qsAdd.item, 'Grenade');
    assert.ok(bpRem);
    assert.equal(bpRem.item, 'Rope');
  });

  it('uses nameResolver when provided', () => {
    const old = new Map([['steam1', { inventory: [], equipment: [], quick_slots: [], backpack_items: [] }]]);
    const now = new Map([['steam1', { inventory: [{ item: 'Axe', amount: 1 }], equipment: [], quickSlots: [], backpackItems: [] }]]);
    const resolver = (id) => id === 'steam1' ? 'Bob' : id;
    const events = diffPlayerInventories(old, now, resolver);
    assert.equal(events[0].actorName, 'Bob');
  });

  it('falls back to player name when no resolver', () => {
    const old = new Map([['steam1', { name: 'Alice', inventory: [], equipment: [], quick_slots: [], backpack_items: [] }]]);
    const now = new Map([['steam1', { name: 'Alice', inventory: [{ item: 'Axe', amount: 1 }], equipment: [], quickSlots: [], backpackItems: [] }]]);
    const events = diffPlayerInventories(old, now);
    assert.equal(events[0].actorName, 'Alice');
  });

  it('accepts object instead of Map for old players', () => {
    const old = { steam1: { inventory: [{ item: 'Axe', amount: 1 }], equipment: [], quick_slots: [], backpack_items: [] } };
    const now = new Map([['steam1', { inventory: [], equipment: [], quickSlots: [], backpackItems: [] }]]);
    const events = diffPlayerInventories(old, now);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'inventory_item_removed');
    assert.equal(events[0].item, 'Axe');
  });

  it('accepts array with steam_id for old players', () => {
    const old = [{ steam_id: 'steam1', inventory: [{ item: 'Axe', amount: 1 }], equipment: [], quick_slots: [], backpack_items: [] }];
    const now = new Map([['steam1', { inventory: [], equipment: [], quickSlots: [], backpackItems: [] }]]);
    const events = diffPlayerInventories(old, now);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'inventory_item_removed');
  });

  it('handles DB JSON strings for inventory fields', () => {
    const old = new Map([['steam1', {
      inventory: JSON.stringify([{ item: 'Axe', amount: 1 }]),
      equipment: '[]', quick_slots: '[]', backpack_items: '[]',
    }]]);
    const now = new Map([['steam1', {
      inventory: [{ item: 'Axe', amount: 1 }, { item: 'Sword', amount: 1 }],
      equipment: [], quickSlots: [], backpackItems: [],
    }]]);
    const events = diffPlayerInventories(old, now);
    assert.equal(events.length, 1);
    assert.equal(events[0].item, 'Sword');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  diffWorldState
// ═══════════════════════════════════════════════════════════════════════════

describe('diffWorldState', () => {
  it('returns empty for identical state', () => {
    const state = { dedi_days_passed: '10', current_season: 'Summer' };
    const events = diffWorldState(state, state);
    assert.equal(events.length, 0);
  });

  it('detects day advance', () => {
    const old = { dedi_days_passed: '10' };
    const now = { dedi_days_passed: '12' };
    const events = diffWorldState(old, now);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'world_day_advanced');
    assert.equal(events[0].category, 'world');
    assert.equal(events[0].amount, 2);
    assert.equal(events[0].details.oldDay, 10);
    assert.equal(events[0].details.newDay, 12);
  });

  it('does not report when day stays the same', () => {
    const old = { dedi_days_passed: '10' };
    const now = { dedi_days_passed: '10' };
    const events = diffWorldState(old, now);
    assert.equal(events.length, 0);
  });

  it('does not report day going backward', () => {
    const old = { dedi_days_passed: '10' };
    const now = { dedi_days_passed: '8' }; // rollback/restore
    const events = diffWorldState(old, now);
    assert.equal(events.length, 0);
  });

  it('detects season change', () => {
    const old = { current_season: 'Summer' };
    const now = { current_season: 'Autumn' };
    const events = diffWorldState(old, now);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'world_season_changed');
    assert.equal(events[0].item, 'Autumn');
    assert.equal(events[0].details.oldSeason, 'Summer');
    assert.equal(events[0].details.newSeason, 'Autumn');
  });

  it('detects airdrop spawned', () => {
    const old = { airdrop: '' };
    const now = { airdrop: 'BP_AirdropCrate_C' };
    const events = diffWorldState(old, now);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'airdrop_spawned');
    assert.equal(events[0].details.airdrop, 'BP_AirdropCrate_C');
  });

  it('detects airdrop spawned from None', () => {
    const old = { airdrop: 'None' };
    const now = { airdrop: 'BP_AirdropCrate_C' };
    const events = diffWorldState(old, now);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'airdrop_spawned');
  });

  it('detects airdrop despawned', () => {
    const old = { airdrop: 'BP_AirdropCrate_C' };
    const now = { airdrop: '' };
    const events = diffWorldState(old, now);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'airdrop_despawned');
    assert.equal(events[0].details.airdrop, 'BP_AirdropCrate_C');
  });

  it('detects airdrop despawned to None', () => {
    const old = { airdrop: 'BP_AirdropCrate_C' };
    const now = { airdrop: 'None' };
    const events = diffWorldState(old, now);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'airdrop_despawned');
  });

  it('does not fire airdrop event for None → None', () => {
    const old = { airdrop: 'None' };
    const now = { airdrop: 'None' };
    const events = diffWorldState(old, now);
    assert.equal(events.length, 0);
  });

  it('handles missing fields gracefully', () => {
    const old = {};
    const now = {};
    const events = diffWorldState(old, now);
    assert.equal(events.length, 0);
  });

  it('detects multiple world events simultaneously', () => {
    const old = { dedi_days_passed: '10', current_season: 'Summer', airdrop: '' };
    const now = { dedi_days_passed: '11', current_season: 'Autumn', airdrop: 'Crate' };
    const events = diffWorldState(old, now);
    assert.equal(events.length, 3);
    const types = events.map(e => e.type).sort();
    assert.deepEqual(types, ['airdrop_spawned', 'world_day_advanced', 'world_season_changed']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  diffVehicleInventories
// ═══════════════════════════════════════════════════════════════════════════

describe('diffVehicleInventories', () => {
  it('returns empty for identical vehicles', () => {
    const v = [{ class: 'Truck', inventory: [{ item: 'Fuel', amount: 5 }] }];
    const events = diffVehicleInventories(v, v);
    assert.equal(events.length, 0);
  });

  it('detects item added to vehicle', () => {
    const old = [{ class: 'Truck', inventory: [] }];
    const now = [{ class: 'Truck', inventory: [{ item: 'Fuel', amount: 5 }] }];
    const events = diffVehicleInventories(old, now);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'vehicle_item_added');
    assert.equal(events[0].category, 'vehicle');
    assert.equal(events[0].item, 'Fuel');
    assert.equal(events[0].amount, 5);
  });

  it('detects item removed from vehicle', () => {
    const old = [{ class: 'Truck', inventory: [{ item: 'Fuel', amount: 5 }] }];
    const now = [{ class: 'Truck', inventory: [] }];
    const events = diffVehicleInventories(old, now);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'vehicle_item_removed');
    assert.equal(events[0].item, 'Fuel');
    assert.equal(events[0].amount, 5);
  });

  it('skips new vehicles (not in old set)', () => {
    const old = [];
    const now = [{ class: 'Truck', inventory: [{ item: 'Fuel', amount: 5 }] }];
    const events = diffVehicleInventories(old, now);
    assert.equal(events.length, 0);
  });

  it('handles multiple vehicles of same class', () => {
    const old = [
      { class: 'Truck', inventory: [{ item: 'Fuel', amount: 10 }] },
      { class: 'Truck', inventory: [{ item: 'Tire', amount: 4 }] },
    ];
    const now = [
      { class: 'Truck', inventory: [{ item: 'Fuel', amount: 10 }] }, // unchanged
      { class: 'Truck', inventory: [] },                              // items removed
    ];
    const events = diffVehicleInventories(old, now);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'vehicle_item_removed');
    assert.equal(events[0].item, 'Tire');
  });

  it('uses displayName for actorName', () => {
    const old = [{ class: 'Truck', displayName: 'Pickup Truck', inventory: [] }];
    const now = [{ class: 'Truck', displayName: 'Pickup Truck', inventory: [{ item: 'Axe', amount: 1 }] }];
    const events = diffVehicleInventories(old, now);
    assert.equal(events[0].actorName, 'Pickup Truck');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  diffSaveState (integration)
// ═══════════════════════════════════════════════════════════════════════════

describe('diffSaveState', () => {
  it('returns empty for identical old/new state', () => {
    const state = {
      containers: [{ actorName: 'Box1', items: [] }],
      horses: [{ class: 'Horse_A', owner_steam_id: '1', health: 100 }],
      players: new Map(),
      worldState: { dedi_days_passed: '10' },
      vehicles: [{ class: 'Truck', inventory: [] }],
    };
    const events = diffSaveState(state, state);
    assert.equal(events.length, 0);
  });

  it('aggregates events from all diff functions', () => {
    const old = {
      containers: [{ actorName: 'Box1', items: [] }],
      horses: [],
      players: new Map([['s1', { inventory: [], equipment: [], quick_slots: [], backpack_items: [] }]]),
      worldState: { dedi_days_passed: '10' },
      vehicles: [{ class: 'Car', inventory: [] }],
    };
    const now = {
      containers: [{ actorName: 'Box1', items: [{ item: 'Rope', amount: 1 }] }],
      horses: [{ class: 'Horse_A', owner_steam_id: '1', health: 100 }],
      players: new Map([['s1', { inventory: [{ item: 'Axe', amount: 1 }], equipment: [], quickSlots: [], backpackItems: [] }]]),
      worldState: { dedi_days_passed: '11' },
      vehicles: [{ class: 'Car', inventory: [{ item: 'Fuel', amount: 3 }] }],
    };
    const events = diffSaveState(old, now);

    const categories = new Set(events.map(e => e.category));
    assert.ok(categories.has('container'));
    assert.ok(categories.has('horse'));
    assert.ok(categories.has('inventory'));
    assert.ok(categories.has('world'));
    assert.ok(categories.has('vehicle'));
    assert.ok(events.length >= 5); // at least one from each category
  });

  it('passes nameResolver to player inventory diff', () => {
    const old = {
      containers: [], horses: [],
      players: new Map([['s1', { inventory: [], equipment: [], quick_slots: [], backpack_items: [] }]]),
      worldState: {}, vehicles: [],
    };
    const now = {
      containers: [], horses: [],
      players: new Map([['s1', { inventory: [{ item: 'Axe', amount: 1 }], equipment: [], quickSlots: [], backpackItems: [] }]]),
      worldState: {}, vehicles: [],
    };
    const resolver = (id) => 'TestPlayer';
    const events = diffSaveState(old, now, resolver);
    assert.equal(events[0].actorName, 'TestPlayer');
  });

  it('handles null/missing sections gracefully', () => {
    const old = { containers: null, horses: null, players: null, worldState: null, vehicles: null };
    const now = { containers: null, horses: null, players: null, worldState: null, vehicles: null };
    const events = diffSaveState(old, now);
    assert.equal(events.length, 0);
  });

  it('handles partial state (some sections present, some not)', () => {
    const old = {
      containers: [{ actorName: 'Box1', items: [] }],
      horses: null,
      players: new Map(),
      worldState: { dedi_days_passed: '5' },
      vehicles: null,
    };
    const now = {
      containers: [{ actorName: 'Box1', items: [{ item: 'Nail', amount: 20 }] }],
      horses: null,
      players: new Map(),
      worldState: { dedi_days_passed: '6' },
      vehicles: null,
    };
    const events = diffSaveState(old, now);
    assert.equal(events.length, 2); // container item + day advance
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  _crossReferenceContainerAccess
// ═══════════════════════════════════════════════════════════════════════════

const { _crossReferenceContainerAccess } = require('../src/db/diff-engine');

describe('_crossReferenceContainerAccess', () => {
  it('attributes container removal to player who gained the same item', () => {
    const events = [
      { type: 'container_item_removed', category: 'container', actor: 'Box1', actorName: 'Box1',
        item: 'Axe', amount: 1, x: 1000, y: 2000 },
      { type: 'inventory_item_added', category: 'inventory', actor: 'STEAM_001', actorName: 'Alice',
        item: 'Axe', amount: 1, x: 1100, y: 2100 },
    ];
    _crossReferenceContainerAccess(events);
    assert.equal(events[0].attributedPlayer, 'Alice');
    assert.equal(events[0].attributedSteamId, 'STEAM_001');
  });

  it('attributes container addition to player who lost the same item', () => {
    const events = [
      { type: 'container_item_added', category: 'container', actor: 'Box1', actorName: 'Box1',
        item: 'Bandage', amount: 3, x: 1000, y: 2000 },
      { type: 'inventory_item_removed', category: 'inventory', actor: 'STEAM_002', actorName: 'Bob',
        item: 'Bandage', amount: 3, x: 1050, y: 2050 },
    ];
    _crossReferenceContainerAccess(events);
    assert.equal(events[0].attributedPlayer, 'Bob');
    assert.equal(events[0].attributedSteamId, 'STEAM_002');
  });

  it('does not attribute when player is too far from container', () => {
    const events = [
      { type: 'container_item_removed', category: 'container', actor: 'Box1', actorName: 'Box1',
        item: 'Axe', amount: 1, x: 1000, y: 2000 },
      { type: 'inventory_item_added', category: 'inventory', actor: 'STEAM_001', actorName: 'Alice',
        item: 'Axe', amount: 1, x: 100000, y: 200000 },
    ];
    _crossReferenceContainerAccess(events);
    assert.equal(events[0].attributedPlayer, undefined);
  });

  it('picks the player with the best item match when multiple nearby', () => {
    const events = [
      { type: 'container_item_removed', category: 'container', actor: 'Box1', actorName: 'Box1',
        item: 'Nail', amount: 10, x: 1000, y: 2000 },
      { type: 'inventory_item_added', category: 'inventory', actor: 'STEAM_001', actorName: 'Alice',
        item: 'Nail', amount: 3, x: 1100, y: 2100 },
      { type: 'inventory_item_added', category: 'inventory', actor: 'STEAM_002', actorName: 'Bob',
        item: 'Nail', amount: 8, x: 1200, y: 2200 },
    ];
    _crossReferenceContainerAccess(events);
    // Bob gained 8 nails vs Alice's 3 — Bob is the better match (min(8,10) > min(3,10))
    assert.equal(events[0].attributedPlayer, 'Bob');
  });

  it('does not crash with no inventory events', () => {
    const events = [
      { type: 'container_item_removed', category: 'container', actor: 'Box1', actorName: 'Box1',
        item: 'Axe', amount: 1, x: 0, y: 0 },
    ];
    _crossReferenceContainerAccess(events);
    assert.equal(events[0].attributedPlayer, undefined);
  });

  it('does not crash with no container events', () => {
    const events = [
      { type: 'inventory_item_added', category: 'inventory', actor: 'STEAM_001', actorName: 'Alice',
        item: 'Axe', amount: 1, x: 0, y: 0 },
    ];
    _crossReferenceContainerAccess(events);
    // No container events to attribute — should not throw
    assert.ok(true);
  });

  it('handles events with no coordinates (skips distance check)', () => {
    const events = [
      { type: 'container_item_removed', category: 'container', actor: 'Box1', actorName: 'Box1',
        item: 'Rope', amount: 2, x: null, y: null },
      { type: 'inventory_item_added', category: 'inventory', actor: 'STEAM_001', actorName: 'Alice',
        item: 'Rope', amount: 2, x: null, y: null },
    ];
    _crossReferenceContainerAccess(events);
    // No coords — position check is skipped, item match still works
    assert.equal(events[0].attributedPlayer, 'Alice');
  });

  it('cross-references through diffSaveState end-to-end', () => {
    const old = {
      containers: [{ actorName: 'Crate', items: [{ item: 'Food', amount: 5 }], pos_x: 100, pos_y: 200, pos_z: 0 }],
      horses: [],
      players: new Map([['76561100000', { name: 'TestPlayer', x: 120, y: 220, z: 0,
        inventory: [{ item: 'Knife', amount: 1 }], equipment: [], quick_slots: [], backpack_items: [] }]]),
      worldState: {},
      vehicles: [],
    };
    const now = {
      containers: [{ actorName: 'Crate', items: [{ item: 'Food', amount: 2 }], pos_x: 100, pos_y: 200, pos_z: 0 }],
      horses: [],
      players: new Map([['76561100000', { name: 'TestPlayer', x: 120, y: 220, z: 0,
        inventory: [{ item: 'Knife', amount: 1 }, { item: 'Food', amount: 3 }], equipment: [], quick_slots: [], backpack_items: [] }]]),
      worldState: {},
      vehicles: [],
    };
    const events = diffSaveState(old, now, (id) => id === '76561100000' ? 'TestPlayer' : id);
    const containerRemoved = events.find(e => e.type === 'container_item_removed');
    const invAdded = events.find(e => e.type === 'inventory_item_added');

    assert.ok(containerRemoved, 'should have container_item_removed event');
    assert.ok(invAdded, 'should have inventory_item_added event');
    assert.equal(containerRemoved.item, 'Food');
    assert.equal(containerRemoved.amount, 3);
    assert.equal(containerRemoved.attributedPlayer, 'TestPlayer');
    assert.equal(containerRemoved.attributedSteamId, '76561100000');
  });
});

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-floating-promises */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import * as _diff_engine from '../src/db/diff-engine.js';
const {
  diffContainers,
  diffHorses,
  diffPlayerInventories,
  diffWorldState,
  diffVehicleInventories,
  _diffItemLists,
  _normalizeItems,
  _buildItemBag,
} = _diff_engine as any;

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
    const items = [null, { amount: 5 }, { item: 'Bandage', amount: 3 }];
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
    const now = [
      { item: 'Axe', amount: 1 },
      { item: 'Bandage', amount: 3 },
    ];
    const { added, removed } = _diffItemLists(old, now);
    assert.equal(added.length, 1);
    assert.equal(added[0].item, 'Bandage');
    assert.equal(added[0].amount, 3);
    assert.equal(removed.length, 0);
  });

  it('detects item removed', () => {
    const old = [
      { item: 'Axe', amount: 1 },
      { item: 'Sword', amount: 1 },
    ];
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
    const now = [
      { item: 'Gun', amount: 1 },
      { item: 'Ammo', amount: 30 },
    ];
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
    const now = [{ item: 'Nail', amount: 20 }];
    const { added, removed } = _diffItemLists(old, now);
    // Old total = 15, new total = 20, so added 5
    assert.equal(added.length, 1);
    assert.equal(added[0].amount, 5);
    assert.equal(removed.length, 0);
  });

  it('defaults missing amount to 1', () => {
    const old = [{ item: 'Axe' }]; // no amount field
    const now = [{ item: 'Axe' }, { item: 'Axe' }];
    const { added, removed: _removed } = _diffItemLists(old, now);
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
    const old: any[] = [];
    const now = [{ actorName: 'Box1', items: [], locked: true }];
    const events = diffContainers(old, now);
    // No container_locked event — only items matter for new containers
    assert.ok(!events.some((e: any) => e.type === 'container_locked'));
  });

  it('detects container destroyed (disappeared with items)', () => {
    const old = [
      {
        actorName: 'Box1',
        items: [
          { item: 'Axe', amount: 1 },
          { item: 'Sword', amount: 1 },
        ],
      },
    ];
    const now: any[] = [];
    const events = diffContainers(old, now);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'container_destroyed');
    assert.equal(events[0].amount, 2); // 2 items lost
    assert.ok(events[0].details.items.length === 2);
  });

  it('does not report destroyed for empty containers that disappear', () => {
    const old = [{ actorName: 'Box1', items: [] }];
    const now: any[] = [];
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
      { actorName: 'Box2', items: [{ item: 'Rope', amount: 3 }] }, // lost 2
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
    const old: any[] = [];
    const now = [{ class: 'Horse_A', owner_steam_id: '123', health: 100, display_name: 'Rex' }];
    const events = diffHorses(old, now);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'horse_appeared');
    assert.equal(events[0].actorName, 'Rex');
    assert.equal(events[0].details.owner, '123');
  });

  it('detects horse disappeared', () => {
    const old = [{ class: 'Horse_A', owner_steam_id: '123', health: 100, display_name: 'Rex' }];
    const now: any[] = [];
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
    const now = [{ class: 'Horse_A', owner_steam_id: '222', health: 100, display_name: 'Rex' }];
    const events = diffHorses(old, now);
    assert.equal(events.length, 2);
    const types = events.map((e: any) => e.type).sort();
    assert.deepEqual(types, ['horse_appeared', 'horse_disappeared']);
  });

  it('handles camelCase field names from parser', () => {
    const old: any[] = [];
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
    const old: any[] = [];
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
    const now = new Map([
      [
        'steam1',
        {
          name: 'Player1',
          inventory: [{ item: 'Axe', amount: 1 }],
        },
      ],
    ]);
    const events = diffPlayerInventories(old, now);
    assert.equal(events.length, 0);
  });

  it('detects item added to inventory', () => {
    const old = new Map([
      [
        'steam1',
        {
          name: 'Player1',
          inventory: [{ item: 'Axe', amount: 1 }],
          equipment: [],
          quick_slots: [],
          backpack_items: [],
        },
      ],
    ]);
    const now = new Map([
      [
        'steam1',
        {
          name: 'Player1',
          inventory: [
            { item: 'Axe', amount: 1 },
            { item: 'Bandage', amount: 3 },
          ],
          equipment: [],
          quickSlots: [],
          backpackItems: [],
        },
      ],
    ]);
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
    const old = new Map([
      [
        'steam1',
        {
          name: 'Player1',
          inventory: [],
          equipment: [{ item: 'Helmet', amount: 1 }],
          quick_slots: [],
          backpack_items: [],
        },
      ],
    ]);
    const now = new Map([
      [
        'steam1',
        {
          name: 'Player1',
          inventory: [],
          equipment: [],
          quickSlots: [],
          backpackItems: [],
        },
      ],
    ]);
    const events = diffPlayerInventories(old, now);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'inventory_item_removed');
    assert.equal(events[0].item, 'Helmet');
    assert.equal(events[0].details.slot, 'equipment');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  diffWorldState
// ═══════════════════════════════════════════════════════════════════════════

describe('diffWorldState', () => {
  it('returns empty for identical world state', () => {
    const ws = { dayNumber: 5, currentSeason: 'Summer', totalPlayers: 10 };
    const events = diffWorldState(ws, ws);
    assert.equal(events.length, 0);
  });

  it('detects day advanced', () => {
    const old = { dayNumber: 5, currentSeason: 'Summer' };
    const now = { dayNumber: 6, currentSeason: 'Summer' };
    const events = diffWorldState(old, now);
    assert.ok(events.some((e: any) => e.type === 'world_day_advanced'));
  });

  it('detects season change', () => {
    const old = { dayNumber: 5, currentSeason: 'Summer' };
    const now = { dayNumber: 6, currentSeason: 'Autumn' };
    const events = diffWorldState(old, now);
    assert.ok(events.some((e: any) => e.type === 'world_season_changed'));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  diffVehicleInventories
// ═══════════════════════════════════════════════════════════════════════════

describe('diffVehicleInventories', () => {
  it('returns empty for identical vehicles', () => {
    const v = [{ id: 'v1', items: [{ item: 'Fuel', amount: 10 }] }];
    const events = diffVehicleInventories(v, v);
    assert.equal(events.length, 0);
  });

  it('detects item added to vehicle', () => {
    const old = [{ id: 'v1', items: [] }];
    const now = [{ id: 'v1', items: [{ item: 'Fuel', amount: 10 }] }];
    const events = diffVehicleInventories(old, now);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'vehicle_item_added');
    assert.equal(events[0].category, 'vehicle');
  });
});

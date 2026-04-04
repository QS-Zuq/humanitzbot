/**
 * Save-file diff engine — detects changes between consecutive save syncs.
 *
 * Pure functions that compare old DB state with newly-parsed data and return
 * activity_log entries for every detected change (item movements, horse changes,
 * world events, etc.).
 *
 * Used by SaveService to populate the activity_log table on each sync cycle.
 *
 * @module diff-engine
 */

// ── Types ──────────────────────────────────────────────────────────────────

interface DiffItem {
  item: string;
  amount: number;
  durability?: number;
  ammo?: number;
}

interface ActivityEvent {
  type: string;
  category: string;
  actor: string;
  actorName: string;
  steam_id?: string;
  item: string;
  amount: number;
  details: Record<string, unknown>;
  x?: number | null;
  y?: number | null;
  z?: number | null;
  attributedPlayer?: string;
  attributedSteamId?: string;
}

interface EntityRecord {
  actor_name?: string;
  actorName?: string;
  items?: unknown;
  locked?: number | boolean;
  x?: number;
  y?: number;
  z?: number;
  pos_x?: number;
  pos_y?: number;
  pos_z?: number;
  class?: string;
  display_name?: string;
  displayName?: string;
  owner_steam_id?: string;
  ownerSteamId?: string;
  horse_name?: string;
  name?: string;
  health?: number;
  max_health?: number;
  maxHealth?: number;
  fuel?: number;
  current_health?: number;
  currentHealth?: number;
  upgrade_level?: number | string;
  upgradeLevel?: number | string;
  actor_class?: string;
  actorClass?: string;
  inventory?: unknown;
  [key: string]: unknown;
}

interface SlotDef {
  field: string;
  dbField?: string;
  parseField?: string;
  label: string;
}

interface PlayerChanges {
  name: string;
  x: number | null | undefined;
  y: number | null | undefined;
  z: number | null | undefined;
  gained: Map<string, number>;
  lost: Map<string, number>;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Main entry point
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Compare old and new save state, returning all detected changes.
 */
function diffSaveState(
  oldState: Record<string, unknown>,
  newState: Record<string, unknown>,
  nameResolver?: (steamId: string) => string,
): ActivityEvent[] {
  const events: ActivityEvent[] = [];

  if (oldState.containers && newState.containers) {
    events.push(...diffContainers(oldState.containers as EntityRecord[], newState.containers as EntityRecord[]));
  }

  if (oldState.horses && newState.horses) {
    events.push(...diffHorses(oldState.horses as EntityRecord[], newState.horses as EntityRecord[]));
  }

  if (oldState.players && newState.players) {
    events.push(
      ...diffPlayerInventories(
        oldState.players as Map<string, EntityRecord> | EntityRecord[] | Record<string, EntityRecord>,
        newState.players as Map<string, EntityRecord> | EntityRecord[] | Record<string, EntityRecord>,
        nameResolver,
      ),
    );
  }

  if (oldState.worldState && newState.worldState) {
    events.push(
      ...diffWorldState(oldState.worldState as Record<string, string>, newState.worldState as Record<string, string>),
    );
  }

  if (oldState.vehicles && newState.vehicles) {
    events.push(...diffVehicleInventories(oldState.vehicles as EntityRecord[], newState.vehicles as EntityRecord[]));
    events.push(...diffVehicleState(oldState.vehicles as EntityRecord[], newState.vehicles as EntityRecord[]));
  }

  if (oldState.structures && newState.structures) {
    events.push(...diffStructures(oldState.structures as EntityRecord[], newState.structures as EntityRecord[]));
  }

  // Cross-reference container <-> player inventory changes for attribution
  _crossReferenceContainerAccess(events);

  return events;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Container diffs
// ═══════════════════════════════════════════════════════════════════════════

function diffContainers(oldContainers: EntityRecord[], newContainers: EntityRecord[]): ActivityEvent[] {
  const events: ActivityEvent[] = [];
  const oldMap = _indexBy(oldContainers, (c) => c.actor_name ?? c.actorName ?? '');
  const newMap = _indexBy(newContainers, (c) => c.actor_name ?? c.actorName ?? '');

  for (const [name, newC] of newMap) {
    const oldC = oldMap.get(name);
    const newItems = _normalizeItems(newC.items);
    const oldItems = oldC ? _normalizeItems(oldC.items) : [];

    const { added, removed } = _diffItemLists(oldItems, newItems);

    for (const item of added) {
      events.push({
        type: 'container_item_added',
        category: 'container',
        actor: name,
        actorName: name,
        item: item.item,
        amount: item.amount,
        details: { durability: item.durability, ammo: item.ammo },
        x: newC.x ?? newC.pos_x,
        y: newC.y ?? newC.pos_y,
        z: newC.z ?? newC.pos_z,
      });
    }

    for (const item of removed) {
      events.push({
        type: 'container_item_removed',
        category: 'container',
        actor: name,
        actorName: name,
        item: item.item,
        amount: item.amount,
        details: { durability: item.durability, ammo: item.ammo },
        x: newC.x ?? newC.pos_x,
        y: newC.y ?? newC.pos_y,
        z: newC.z ?? newC.pos_z,
      });
    }

    // Lock state change
    const oldLocked = oldC ? !!oldC.locked : false;
    const newLocked = !!newC.locked;
    if (oldC && oldLocked !== newLocked) {
      events.push({
        type: newLocked ? 'container_locked' : 'container_unlocked',
        category: 'container',
        actor: name,
        actorName: name,
        item: '',
        amount: 0,
        details: {},
        x: newC.x ?? newC.pos_x,
        y: newC.y ?? newC.pos_y,
        z: newC.z ?? newC.pos_z,
      });
    }
  }

  // Containers that disappeared entirely (with items)
  for (const [name, oldC] of oldMap) {
    if (!newMap.has(name)) {
      const items = _normalizeItems(oldC.items);
      if (items.length > 0) {
        events.push({
          type: 'container_destroyed',
          category: 'container',
          actor: name,
          actorName: name,
          item: '',
          amount: items.length,
          details: { items: items.map((i) => `${i.item} x${String(i.amount)}`).slice(0, 10) },
          x: oldC.x ?? oldC.pos_x,
          y: oldC.y ?? oldC.pos_y,
          z: oldC.z ?? oldC.pos_z,
        });
      }
    }
  }

  return events;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Horse diffs
// ═══════════════════════════════════════════════════════════════════════════

function diffHorses(oldHorses: EntityRecord[], newHorses: EntityRecord[]): ActivityEvent[] {
  const events: ActivityEvent[] = [];

  const oldMap = _indexHorses(oldHorses);
  const newMap = _indexHorses(newHorses);

  for (const [key, newH] of newMap) {
    const oldH = oldMap.get(key);
    const hName = newH.display_name ?? newH.displayName ?? newH.horse_name ?? newH.name ?? key;

    if (!oldH) {
      events.push({
        type: 'horse_appeared',
        category: 'horse',
        actor: key,
        actorName: hName,
        item: '',
        amount: 0,
        details: {
          class: newH.class,
          owner: newH.owner_steam_id ?? newH.ownerSteamId,
          health: newH.health,
        },
        x: newH.x ?? newH.pos_x,
        y: newH.y ?? newH.pos_y,
        z: newH.z ?? newH.pos_z,
      });
    } else {
      const oldHealth = oldH.health ?? 0;
      const newHealth = newH.health ?? 0;
      if (Math.abs(newHealth - oldHealth) >= 5) {
        events.push({
          type: 'horse_health_changed',
          category: 'horse',
          actor: key,
          actorName: hName,
          item: '',
          amount: Math.round(newHealth - oldHealth),
          details: { oldHealth, newHealth },
          x: newH.x ?? newH.pos_x,
          y: newH.y ?? newH.pos_y,
          z: newH.z ?? newH.pos_z,
        });
      }

      const oldOwner = oldH.owner_steam_id ?? oldH.ownerSteamId ?? '';
      const newOwner = newH.owner_steam_id ?? newH.ownerSteamId ?? '';
      if (oldOwner !== newOwner && (oldOwner || newOwner)) {
        events.push({
          type: 'horse_owner_changed',
          category: 'horse',
          actor: key,
          actorName: hName,
          item: '',
          amount: 0,
          details: { oldOwner, newOwner },
          x: newH.x ?? newH.pos_x,
          y: newH.y ?? newH.pos_y,
          z: newH.z ?? newH.pos_z,
        });
      }
    }
  }

  for (const [key, oldH] of oldMap) {
    if (!newMap.has(key)) {
      const hName = oldH.display_name ?? oldH.displayName ?? oldH.horse_name ?? oldH.name ?? key;
      events.push({
        type: 'horse_disappeared',
        category: 'horse',
        actor: key,
        actorName: hName,
        item: '',
        amount: 0,
        details: {
          class: oldH.class,
          owner: oldH.owner_steam_id ?? oldH.ownerSteamId,
          lastHealth: oldH.health,
        },
        x: oldH.x ?? oldH.pos_x,
        y: oldH.y ?? oldH.pos_y,
        z: oldH.z ?? oldH.pos_z,
      });
    }
  }

  return events;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Player inventory diffs
// ═══════════════════════════════════════════════════════════════════════════

function diffPlayerInventories(
  oldPlayers: Map<string, EntityRecord> | EntityRecord[] | Record<string, EntityRecord>,
  newPlayers: Map<string, EntityRecord> | EntityRecord[] | Record<string, EntityRecord>,
  nameResolver?: (steamId: string) => string,
): ActivityEvent[] {
  const events: ActivityEvent[] = [];
  const oldMap = _toMap(oldPlayers);
  const newMap = _toMap(newPlayers);

  const slots: SlotDef[] = [
    { field: 'inventory', label: 'inventory' },
    { field: 'equipment', label: 'equipment' },
    { field: 'quick_slots', dbField: 'quick_slots', parseField: 'quickSlots', label: 'quick_slots' },
    { field: 'backpack_items', dbField: 'backpack_items', parseField: 'backpackItems', label: 'backpack' },
  ];

  for (const [steamId, newP] of newMap) {
    const oldP = oldMap.get(steamId);
    if (!oldP) continue;

    const playerName = nameResolver ? nameResolver(steamId) : (newP.name ?? steamId);

    for (const slot of slots) {
      const oldItems = _normalizeItems(_getField(oldP, slot));
      const newItems = _normalizeItems(_getField(newP, slot));

      const { added, removed } = _diffItemLists(oldItems, newItems);

      for (const item of added) {
        events.push({
          type: 'inventory_item_added',
          category: 'inventory',
          actor: steamId,
          actorName: playerName,
          item: item.item,
          amount: item.amount,
          details: { slot: slot.label, durability: item.durability },
          x: newP.x ?? newP.pos_x,
          y: newP.y ?? newP.pos_y,
          z: newP.z ?? newP.pos_z,
        });
      }

      for (const item of removed) {
        events.push({
          type: 'inventory_item_removed',
          category: 'inventory',
          actor: steamId,
          actorName: playerName,
          item: item.item,
          amount: item.amount,
          details: { slot: slot.label, durability: item.durability },
          x: newP.x ?? newP.pos_x,
          y: newP.y ?? newP.pos_y,
          z: newP.z ?? newP.pos_z,
        });
      }
    }
  }

  return events;
}

// ═══════════════════════════════════════════════════════════════════════════
//  World state diffs
// ═══════════════════════════════════════════════════════════════════════════

function diffWorldState(oldState: Record<string, string>, newState: Record<string, string>): ActivityEvent[] {
  const events: ActivityEvent[] = [];

  const oldDay = parseInt(oldState['dedi_days_passed'] ?? '0', 10);
  const newDay = parseInt(newState['dedi_days_passed'] ?? '0', 10);
  if (newDay > oldDay) {
    events.push({
      type: 'world_day_advanced',
      category: 'world',
      actor: 'world',
      actorName: 'World',
      item: '',
      amount: newDay - oldDay,
      details: { oldDay, newDay },
    });
  }

  const oldSeason = oldState['current_season'] ?? '';
  const newSeason = newState['current_season'] ?? '';
  if (newSeason && oldSeason !== newSeason) {
    events.push({
      type: 'world_season_changed',
      category: 'world',
      actor: 'world',
      actorName: 'World',
      item: newSeason,
      amount: 0,
      details: { oldSeason, newSeason },
    });
  }

  const rawOldAirdrop = oldState['airdrop'] ?? '';
  const rawNewAirdrop = newState['airdrop'] ?? '';
  const oldAirdrop = rawOldAirdrop === 'None' ? '' : rawOldAirdrop;
  const newAirdrop = rawNewAirdrop === 'None' ? '' : rawNewAirdrop;
  if (!oldAirdrop && newAirdrop) {
    events.push({
      type: 'airdrop_spawned',
      category: 'world',
      actor: 'airdrop',
      actorName: 'Airdrop',
      item: '',
      amount: 0,
      details: { airdrop: newAirdrop },
    });
  } else if (oldAirdrop && !newAirdrop) {
    events.push({
      type: 'airdrop_despawned',
      category: 'world',
      actor: 'airdrop',
      actorName: 'Airdrop',
      item: '',
      amount: 0,
      details: { airdrop: oldAirdrop },
    });
  }

  return events;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Vehicle inventory diffs
// ═══════════════════════════════════════════════════════════════════════════

function diffVehicleInventories(oldVehicles: EntityRecord[], newVehicles: EntityRecord[]): ActivityEvent[] {
  const events: ActivityEvent[] = [];

  const oldByKey = _indexVehicles(oldVehicles);
  const newByKey = _indexVehicles(newVehicles);

  for (const [key, newV] of newByKey) {
    const oldV = oldByKey.get(key);
    if (!oldV) continue;

    const vName = newV.display_name ?? newV.displayName ?? newV.class ?? key;
    const oldItems = _normalizeItems(oldV.inventory);
    const newItems = _normalizeItems(newV.inventory);

    const { added, removed } = _diffItemLists(oldItems, newItems);

    for (const item of added) {
      events.push({
        type: 'vehicle_item_added',
        category: 'vehicle',
        actor: key,
        actorName: vName,
        item: item.item,
        amount: item.amount,
        details: { durability: item.durability },
        x: newV.x ?? newV.pos_x,
        y: newV.y ?? newV.pos_y,
        z: newV.z ?? newV.pos_z,
      });
    }

    for (const item of removed) {
      events.push({
        type: 'vehicle_item_removed',
        category: 'vehicle',
        actor: key,
        actorName: vName,
        item: item.item,
        amount: item.amount,
        details: { durability: item.durability },
        x: newV.x ?? newV.pos_x,
        y: newV.y ?? newV.pos_y,
        z: newV.z ?? newV.pos_z,
      });
    }
  }

  return events;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Vehicle state diffs (health, fuel)
// ═══════════════════════════════════════════════════════════════════════════

function diffVehicleState(oldVehicles: EntityRecord[], newVehicles: EntityRecord[]): ActivityEvent[] {
  const events: ActivityEvent[] = [];
  const oldByKey = _indexVehicles(oldVehicles);
  const newByKey = _indexVehicles(newVehicles);

  for (const [key, newV] of newByKey) {
    const oldV = oldByKey.get(key);
    if (!oldV) {
      const vName = newV.display_name ?? newV.displayName ?? newV.class ?? key;
      events.push({
        type: 'vehicle_appeared',
        category: 'vehicle',
        actor: key,
        actorName: vName,
        item: '',
        amount: 0,
        details: { health: newV.health, maxHealth: newV.maxHealth, fuel: newV.fuel },
        x: newV.x ?? newV.pos_x,
        y: newV.y ?? newV.pos_y,
        z: newV.z ?? newV.pos_z,
      });
      continue;
    }

    const vName = newV.display_name ?? newV.displayName ?? newV.class ?? key;

    const oldHealth = parseFloat(String(oldV.health ?? 0));
    const newHealth = parseFloat(String(newV.health ?? 0));
    const maxHealth = parseFloat(String(newV.max_health ?? newV.maxHealth ?? 100));
    if (Math.abs(newHealth - oldHealth) >= 5) {
      events.push({
        type: 'vehicle_health_changed',
        category: 'vehicle',
        actor: key,
        actorName: vName,
        item: '',
        amount: Math.round(newHealth - oldHealth),
        details: { oldHealth, newHealth, healthPercent: (newHealth / maxHealth) * 100 },
        x: newV.x ?? newV.pos_x,
        y: newV.y ?? newV.pos_y,
        z: newV.z ?? newV.pos_z,
      });
    }

    const oldFuel = parseFloat(String(oldV.fuel ?? 0));
    const newFuel = parseFloat(String(newV.fuel ?? 0));
    if (Math.abs(newFuel - oldFuel) >= 2) {
      events.push({
        type: 'vehicle_fuel_changed',
        category: 'vehicle',
        actor: key,
        actorName: vName,
        item: '',
        amount: Math.round((newFuel - oldFuel) * 10) / 10,
        details: { oldFuel, newFuel },
        x: newV.x ?? newV.pos_x,
        y: newV.y ?? newV.pos_y,
        z: newV.z ?? newV.pos_z,
      });
    }
  }

  for (const [key, oldV] of oldByKey) {
    if (!newByKey.has(key)) {
      const vName = oldV.display_name ?? oldV.displayName ?? oldV.class ?? key;
      events.push({
        type: 'vehicle_destroyed',
        category: 'vehicle',
        actor: key,
        actorName: vName,
        item: '',
        amount: 0,
        details: { lastHealth: oldV.health },
        x: oldV.x ?? oldV.pos_x,
        y: oldV.y ?? oldV.pos_y,
        z: oldV.z ?? oldV.pos_z,
      });
    }
  }

  return events;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Structure diffs (health, upgrades, destruction)
// ═══════════════════════════════════════════════════════════════════════════

function diffStructures(oldStructures: EntityRecord[], newStructures: EntityRecord[]): ActivityEvent[] {
  const events: ActivityEvent[] = [];
  const oldByKey = _indexStructures(oldStructures);
  const newByKey = _indexStructures(newStructures);

  for (const [key, newS] of newByKey) {
    const oldS = oldByKey.get(key);
    if (!oldS) continue;

    const sName = newS.display_name ?? newS.displayName ?? newS.actor_class ?? newS.actorClass ?? key;

    const oldHealth = parseFloat(String(oldS.current_health ?? oldS.currentHealth ?? 0));
    const newHealth = parseFloat(String(newS.current_health ?? newS.currentHealth ?? 0));
    const maxHealth = parseFloat(String(newS.max_health ?? newS.maxHealth ?? 100));
    if (Math.abs(newHealth - oldHealth) >= 10) {
      if (newHealth <= 0 && oldHealth > 0) {
        events.push({
          type: 'structure_destroyed',
          category: 'structure',
          actor: key,
          actorName: sName,
          steam_id: newS.owner_steam_id ?? newS.ownerSteamId ?? '',
          item: '',
          amount: 0,
          details: { owner: newS.owner_steam_id ?? newS.ownerSteamId, oldHealth },
          x: newS.x ?? newS.pos_x,
          y: newS.y ?? newS.pos_y,
          z: newS.z ?? newS.pos_z,
        });
      } else {
        events.push({
          type: 'structure_damaged',
          category: 'structure',
          actor: key,
          actorName: sName,
          steam_id: newS.owner_steam_id ?? newS.ownerSteamId ?? '',
          item: '',
          amount: Math.round(newHealth - oldHealth),
          details: {
            oldHealth,
            newHealth,
            healthPercent: (newHealth / maxHealth) * 100,
            owner: newS.owner_steam_id ?? newS.ownerSteamId,
          },
          x: newS.x ?? newS.pos_x,
          y: newS.y ?? newS.pos_y,
          z: newS.z ?? newS.pos_z,
        });
      }
    }

    const oldLevel = parseInt(String(oldS.upgrade_level ?? oldS.upgradeLevel ?? 0), 10);
    const newLevel = parseInt(String(newS.upgrade_level ?? newS.upgradeLevel ?? 0), 10);
    if (newLevel > oldLevel) {
      events.push({
        type: 'structure_upgraded',
        category: 'structure',
        actor: key,
        actorName: sName,
        steam_id: newS.owner_steam_id ?? newS.ownerSteamId ?? '',
        item: '',
        amount: newLevel - oldLevel,
        details: { oldLevel, newLevel, owner: newS.owner_steam_id ?? newS.ownerSteamId },
        x: newS.x ?? newS.pos_x,
        y: newS.y ?? newS.pos_y,
        z: newS.z ?? newS.pos_z,
      });
    }
  }

  for (const [key, oldS] of oldByKey) {
    if (!newByKey.has(key)) {
      const owner = oldS.owner_steam_id ?? oldS.ownerSteamId ?? '';
      if (!owner) continue;
      const sName = oldS.display_name ?? oldS.displayName ?? oldS.actor_class ?? oldS.actorClass ?? key;
      events.push({
        type: 'structure_destroyed',
        category: 'structure',
        actor: key,
        actorName: sName,
        steam_id: owner,
        item: '',
        amount: 0,
        details: { owner, lastHealth: oldS.current_health ?? oldS.currentHealth },
        x: oldS.x ?? oldS.pos_x,
        y: oldS.y ?? oldS.pos_y,
        z: oldS.z ?? oldS.pos_z,
      });
    }
  }

  return events;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Helpers
// ═══════════════════════════════════════════════════════════════════════════

function _normalizeItems(items: unknown): DiffItem[] {
  if (!items) return [];
  let parsed: unknown = items;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((i): i is DiffItem => {
    const rec = i as DiffItem | null | undefined;
    return !!rec && !!rec.item && rec.item !== 'None' && rec.item !== 'Empty';
  });
}

function _diffItemLists(oldItems: DiffItem[], newItems: DiffItem[]): { added: DiffItem[]; removed: DiffItem[] } {
  const oldBag = _buildItemBag(oldItems);
  const newBag = _buildItemBag(newItems);

  const added: DiffItem[] = [];
  const removed: DiffItem[] = [];

  const allItems = new Set([...oldBag.keys(), ...newBag.keys()]);

  for (const itemName of allItems) {
    const oldCount = _sumAmounts(oldBag.get(itemName) ?? []);
    const newCount = _sumAmounts(newBag.get(itemName) ?? []);

    if (newCount > oldCount) {
      added.push({ item: itemName, amount: newCount - oldCount });
    } else if (oldCount > newCount) {
      removed.push({ item: itemName, amount: oldCount - newCount });
    }
  }

  return { added, removed };
}

function _buildItemBag(items: DiffItem[]): Map<string, DiffItem[]> {
  const bag = new Map<string, DiffItem[]>();
  for (const item of items) {
    const name = item.item;
    let list = bag.get(name);
    if (!list) {
      list = [];
      bag.set(name, list);
    }
    list.push(item);
  }
  return bag;
}

function _sumAmounts(entries: DiffItem[]): number {
  return entries.reduce((sum, e) => sum + (e.amount || 1), 0);
}

function _indexBy(arr: EntityRecord[], keyFn: (item: EntityRecord) => string): Map<string, EntityRecord> {
  const map = new Map<string, EntityRecord>();
  for (const item of arr) {
    const key = keyFn(item);
    if (key) map.set(key, item);
  }
  return map;
}

function _indexHorses(horses: EntityRecord[]): Map<string, EntityRecord> {
  const map = new Map<string, EntityRecord>();
  const counters = new Map<string, number>();
  for (const h of horses) {
    const cls = h.class ?? '';
    const owner = h.owner_steam_id ?? h.ownerSteamId ?? '';
    const base = `${cls}::${owner}`;
    const n = (counters.get(base) ?? 0) + 1;
    counters.set(base, n);
    map.set(n > 1 ? `${base}::${String(n)}` : base, h);
  }
  return map;
}

function _indexVehicles(vehicles: EntityRecord[]): Map<string, EntityRecord> {
  const map = new Map<string, EntityRecord>();
  const counters = new Map<string, number>();
  for (const v of vehicles) {
    const cls = v.class ?? v.display_name ?? v.displayName ?? '';
    const n = (counters.get(cls) ?? 0) + 1;
    counters.set(cls, n);
    map.set(`${cls}::${String(n)}`, v);
  }
  return map;
}

function _indexStructures(structures: EntityRecord[]): Map<string, EntityRecord> {
  const map = new Map<string, EntityRecord>();
  const counters = new Map<string, number>();
  for (const s of structures) {
    const cls = s.actor_class ?? s.actorClass ?? '';
    const owner = s.owner_steam_id ?? s.ownerSteamId ?? '';
    const px = Math.round((s.x ?? s.pos_x ?? 0) / 100);
    const py = Math.round((s.y ?? s.pos_y ?? 0) / 100);
    const base = `${cls}::${owner}::${String(px)},${String(py)}`;
    const n = (counters.get(base) ?? 0) + 1;
    counters.set(base, n);
    map.set(n > 1 ? `${base}::${String(n)}` : base, s);
  }
  return map;
}

function _toMap(
  players: Map<string, EntityRecord> | EntityRecord[] | Record<string, EntityRecord>,
): Map<string, EntityRecord> {
  if (players instanceof Map) return players;
  if (Array.isArray(players)) {
    const map = new Map<string, EntityRecord>();
    for (const p of players) {
      const id = (p.steam_id ?? p['steamId']) as string | undefined;
      if (id) map.set(id, p);
    }
    return map;
  }
  if (typeof players === 'object') {
    return new Map(Object.entries(players));
  }
  return new Map();
}

function _getField(player: EntityRecord, slot: SlotDef): unknown {
  if (slot.parseField && player[slot.parseField] !== undefined) return player[slot.parseField];
  if (slot.dbField && player[slot.dbField] !== undefined) return player[slot.dbField];
  return player[slot.field] ?? [];
}

// ═══════════════════════════════════════════════════════════════════════════
//  Container <-> Inventory cross-referencing
// ═══════════════════════════════════════════════════════════════════════════

function _crossReferenceContainerAccess(events: ActivityEvent[]): void {
  const containerEvents = events.filter((e) => e.category === 'container' && e.item);
  const inventoryEvents = events.filter((e) => e.category === 'inventory' && e.item);

  if (containerEvents.length === 0 || inventoryEvents.length === 0) return;

  const playerChanges = new Map<string, PlayerChanges>();
  for (const e of inventoryEvents) {
    const steamId = e.actor;
    if (!playerChanges.has(steamId)) {
      playerChanges.set(steamId, {
        name: e.actorName,
        x: e.x,
        y: e.y,
        z: e.z,
        gained: new Map(),
        lost: new Map(),
      });
    }
    const pc = playerChanges.get(steamId);
    if (!pc) continue;
    if (e.type === 'inventory_item_added') {
      pc.gained.set(e.item, (pc.gained.get(e.item) ?? 0) + e.amount);
    } else if (e.type === 'inventory_item_removed') {
      pc.lost.set(e.item, (pc.lost.get(e.item) ?? 0) + e.amount);
    }
  }

  const MAX_DISTANCE_SQ = 5000 * 5000;

  for (const ce of containerEvents) {
    if (ce.type !== 'container_item_added' && ce.type !== 'container_item_removed') continue;

    let bestPlayer: { name: string; steamId: string } | null = null;
    let bestScore = 0;

    for (const [steamId, pc] of playerChanges) {
      if (ce.x != null && pc.x != null) {
        const dx = ce.x - pc.x;
        const dy = (ce.y ?? 0) - (pc.y ?? 0);
        const distSq = dx * dx + dy * dy;
        if (distSq > MAX_DISTANCE_SQ) continue;
      }

      const matchAmount =
        ce.type === 'container_item_removed' ? (pc.gained.get(ce.item) ?? 0) : (pc.lost.get(ce.item) ?? 0);

      const score = Math.min(matchAmount, ce.amount);
      if (score > 0 && score > bestScore) {
        bestScore = score;
        bestPlayer = { name: pc.name, steamId };
      }
    }

    if (bestPlayer) {
      ce.attributedPlayer = bestPlayer.name;
      ce.attributedSteamId = bestPlayer.steamId;
    }
  }
}

export {
  diffSaveState,
  diffContainers,
  diffHorses,
  diffPlayerInventories,
  diffWorldState,
  diffVehicleInventories,
  diffVehicleState,
  diffStructures,
  _crossReferenceContainerAccess,
  _diffItemLists,
  _normalizeItems,
  _buildItemBag,
};

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

// ═══════════════════════════════════════════════════════════════════════════
//  Main entry point
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Compare old and new save state, returning all detected changes.
 *
 * @param {object} oldState - Previous state from DB
 * @param {object} oldState.containers - Array of container rows (actor_name, items JSON)
 * @param {object} oldState.horses - Array of world_horses rows
 * @param {object} oldState.players - Map or object of steamId → { inventory, equipment, quick_slots, backpack_items }
 * @param {object} oldState.worldState - { key → value } object
 * @param {object} oldState.vehicles - Array of vehicle rows (items JSON)
 * @param {object} newState - Freshly parsed save data
 * @param {object} newState.containers - Array of parsed containers
 * @param {object} newState.horses - Array of parsed horses
 * @param {object} newState.players - Map of steamId → player data
 * @param {object} newState.worldState - { key → value } object
 * @param {object} newState.vehicles - Array of parsed vehicles
 * @param {object} [nameResolver] - Optional function(steamId) → displayName
 * @returns {Array<object>} Activity log entries
 */
function diffSaveState(oldState, newState, nameResolver) {
  const events = [];

  if (oldState.containers && newState.containers) {
    events.push(...diffContainers(oldState.containers, newState.containers));
  }

  if (oldState.horses && newState.horses) {
    events.push(...diffHorses(oldState.horses, newState.horses));
  }

  if (oldState.players && newState.players) {
    events.push(...diffPlayerInventories(oldState.players, newState.players, nameResolver));
  }

  if (oldState.worldState && newState.worldState) {
    events.push(...diffWorldState(oldState.worldState, newState.worldState));
  }

  if (oldState.vehicles && newState.vehicles) {
    events.push(...diffVehicleInventories(oldState.vehicles, newState.vehicles));
  }

  // Cross-reference container ↔ player inventory changes for attribution
  _crossReferenceContainerAccess(events);

  return events;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Container diffs
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Compare container inventories between two snapshots.
 * Detects items added/removed and lock state changes.
 *
 * @param {Array} oldContainers - DB rows with actor_name, items (JSON string or array)
 * @param {Array} newContainers - Parsed containers with actorName, items (array)
 * @returns {Array<object>} Activity log entries
 */
function diffContainers(oldContainers, newContainers) {
  const events = [];
  const oldMap = _indexBy(oldContainers, c => c.actor_name || c.actorName);
  const newMap = _indexBy(newContainers, c => c.actor_name || c.actorName);

  for (const [name, newC] of newMap) {
    const oldC = oldMap.get(name);
    const newItems = _normalizeItems(newC.items);
    const oldItems = oldC ? _normalizeItems(oldC.items) : [];

    // Item diff
    const { added, removed } = _diffItemLists(oldItems, newItems);

    for (const item of added) {
      events.push({
        type: 'container_item_added', category: 'container',
        actor: name, actorName: name,
        item: item.item, amount: item.amount,
        details: { durability: item.durability, ammo: item.ammo },
        x: newC.x ?? newC.pos_x, y: newC.y ?? newC.pos_y, z: newC.z ?? newC.pos_z,
      });
    }

    for (const item of removed) {
      events.push({
        type: 'container_item_removed', category: 'container',
        actor: name, actorName: name,
        item: item.item, amount: item.amount,
        details: { durability: item.durability, ammo: item.ammo },
        x: newC.x ?? newC.pos_x, y: newC.y ?? newC.pos_y, z: newC.z ?? newC.pos_z,
      });
    }

    // Lock state change
    const oldLocked = oldC ? !!(oldC.locked) : false;
    const newLocked = !!(newC.locked);
    if (oldC && oldLocked !== newLocked) {
      events.push({
        type: newLocked ? 'container_locked' : 'container_unlocked',
        category: 'container',
        actor: name, actorName: name, item: '', amount: 0,
        details: {},
        x: newC.x ?? newC.pos_x, y: newC.y ?? newC.pos_y, z: newC.z ?? newC.pos_z,
      });
    }
  }

  // Containers that disappeared entirely (with items)
  for (const [name, oldC] of oldMap) {
    if (!newMap.has(name)) {
      const items = _normalizeItems(oldC.items);
      if (items.length > 0) {
        events.push({
          type: 'container_destroyed', category: 'container',
          actor: name, actorName: name,
          item: '', amount: items.length,
          details: { items: items.map(i => `${i.item} x${i.amount}`).slice(0, 10) },
          x: oldC.x ?? oldC.pos_x, y: oldC.y ?? oldC.pos_y, z: oldC.z ?? oldC.pos_z,
        });
      }
    }
  }

  return events;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Horse diffs
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Compare horse state between snapshots.
 * Detects horses appearing, disappearing, health changes, ownership changes.
 *
 * @param {Array} oldHorses - DB rows or parsed horse arrays
 * @param {Array} newHorses - Parsed horse arrays from save
 * @returns {Array<object>} Activity log entries
 */
function diffHorses(oldHorses, newHorses) {
  const events = [];

  // Key horses by class+owner (since they may not have unique actor names)
  const oldMap = _indexHorses(oldHorses);
  const newMap = _indexHorses(newHorses);

  for (const [key, newH] of newMap) {
    const oldH = oldMap.get(key);
    const hName = newH.display_name || newH.displayName || newH.horse_name || newH.name || key;

    if (!oldH) {
      // New horse appeared
      events.push({
        type: 'horse_appeared', category: 'horse',
        actor: key, actorName: hName,
        item: '', amount: 0,
        details: {
          class: newH.class, owner: newH.owner_steam_id || newH.ownerSteamId,
          health: newH.health,
        },
        x: newH.x ?? newH.pos_x, y: newH.y ?? newH.pos_y, z: newH.z ?? newH.pos_z,
      });
    } else {
      // Check health change (significant)
      const oldHealth = oldH.health || 0;
      const newHealth = newH.health || 0;
      if (Math.abs(newHealth - oldHealth) >= 5) {
        events.push({
          type: 'horse_health_changed', category: 'horse',
          actor: key, actorName: hName,
          item: '', amount: Math.round(newHealth - oldHealth),
          details: { oldHealth, newHealth },
          x: newH.x ?? newH.pos_x, y: newH.y ?? newH.pos_y, z: newH.z ?? newH.pos_z,
        });
      }

      // Check owner change
      const oldOwner = oldH.owner_steam_id || oldH.ownerSteamId || '';
      const newOwner = newH.owner_steam_id || newH.ownerSteamId || '';
      if (oldOwner !== newOwner && (oldOwner || newOwner)) {
        events.push({
          type: 'horse_owner_changed', category: 'horse',
          actor: key, actorName: hName,
          item: '', amount: 0,
          details: { oldOwner, newOwner },
          x: newH.x ?? newH.pos_x, y: newH.y ?? newH.pos_y, z: newH.z ?? newH.pos_z,
        });
      }
    }
  }

  // Horses that disappeared
  for (const [key, oldH] of oldMap) {
    if (!newMap.has(key)) {
      const hName = oldH.display_name || oldH.displayName || oldH.horse_name || oldH.name || key;
      events.push({
        type: 'horse_disappeared', category: 'horse',
        actor: key, actorName: hName,
        item: '', amount: 0,
        details: {
          class: oldH.class,
          owner: oldH.owner_steam_id || oldH.ownerSteamId,
          lastHealth: oldH.health,
        },
        x: oldH.x ?? oldH.pos_x, y: oldH.y ?? oldH.pos_y, z: oldH.z ?? oldH.pos_z,
      });
    }
  }

  return events;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Player inventory diffs
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Compare player inventories between snapshots.
 * Detects items added/removed from inventory, equipment, quick slots, backpack.
 *
 * @param {Map|Object} oldPlayers - steamId → player data (DB rows or parsed)
 * @param {Map|Object} newPlayers - steamId → player data (parsed)
 * @param {Function} [nameResolver] - Optional (steamId) → displayName
 * @returns {Array<object>}
 */
function diffPlayerInventories(oldPlayers, newPlayers, nameResolver) {
  const events = [];
  const oldMap = _toMap(oldPlayers);
  const newMap = _toMap(newPlayers);

  const slots = [
    { field: 'inventory', label: 'inventory' },
    { field: 'equipment', label: 'equipment' },
    { field: 'quick_slots', dbField: 'quick_slots', parseField: 'quickSlots', label: 'quick_slots' },
    { field: 'backpack_items', dbField: 'backpack_items', parseField: 'backpackItems', label: 'backpack' },
  ];

  for (const [steamId, newP] of newMap) {
    const oldP = oldMap.get(steamId);
    if (!oldP) continue; // New players — don't log their initial inventory as "added"

    const playerName = nameResolver ? nameResolver(steamId) : (newP.name || steamId);

    for (const slot of slots) {
      const oldItems = _normalizeItems(_getField(oldP, slot));
      const newItems = _normalizeItems(_getField(newP, slot));

      const { added, removed } = _diffItemLists(oldItems, newItems);

      for (const item of added) {
        events.push({
          type: 'inventory_item_added', category: 'inventory',
          actor: steamId, actorName: playerName,
          item: item.item, amount: item.amount,
          details: { slot: slot.label, durability: item.durability },
          x: newP.x ?? newP.pos_x, y: newP.y ?? newP.pos_y, z: newP.z ?? newP.pos_z,
        });
      }

      for (const item of removed) {
        events.push({
          type: 'inventory_item_removed', category: 'inventory',
          actor: steamId, actorName: playerName,
          item: item.item, amount: item.amount,
          details: { slot: slot.label, durability: item.durability },
          x: newP.x ?? newP.pos_x, y: newP.y ?? newP.pos_y, z: newP.z ?? newP.pos_z,
        });
      }
    }
  }

  return events;
}

// ═══════════════════════════════════════════════════════════════════════════
//  World state diffs
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Compare world state key-value pairs.
 * Detects day changes, season changes, airdrop spawns/despawns.
 *
 * @param {object} oldState - { key → value }
 * @param {object} newState - { key → value }
 * @returns {Array<object>}
 */
function diffWorldState(oldState, newState) {
  const events = [];

  // Day advance
  const oldDay = parseInt(oldState.dedi_days_passed || '0', 10);
  const newDay = parseInt(newState.dedi_days_passed || '0', 10);
  if (newDay > oldDay) {
    events.push({
      type: 'world_day_advanced', category: 'world',
      actor: 'world', actorName: 'World',
      item: '', amount: newDay - oldDay,
      details: { oldDay, newDay },
    });
  }

  // Season change
  const oldSeason = oldState.current_season || '';
  const newSeason = newState.current_season || '';
  if (newSeason && oldSeason !== newSeason) {
    events.push({
      type: 'world_season_changed', category: 'world',
      actor: 'world', actorName: 'World',
      item: newSeason, amount: 0,
      details: { oldSeason, newSeason },
    });
  }

  // Airdrop state
  const rawOldAirdrop = oldState.airdrop || '';
  const rawNewAirdrop = newState.airdrop || '';
  const oldAirdrop = rawOldAirdrop === 'None' ? '' : rawOldAirdrop;
  const newAirdrop = rawNewAirdrop === 'None' ? '' : rawNewAirdrop;
  if (!oldAirdrop && newAirdrop) {
    events.push({
      type: 'airdrop_spawned', category: 'world',
      actor: 'airdrop', actorName: 'Airdrop',
      item: '', amount: 0,
      details: { airdrop: newAirdrop },
    });
  } else if (oldAirdrop && !newAirdrop) {
    events.push({
      type: 'airdrop_despawned', category: 'world',
      actor: 'airdrop', actorName: 'Airdrop',
      item: '', amount: 0,
      details: { airdrop: oldAirdrop },
    });
  }

  return events;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Vehicle inventory diffs
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Compare vehicle trunk inventories between snapshots.
 *
 * @param {Array} oldVehicles - DB vehicle rows
 * @param {Array} newVehicles - Parsed vehicles
 * @returns {Array<object>}
 */
function diffVehicleInventories(oldVehicles, newVehicles) {
  const events = [];

  // Vehicles don't have stable actor names, so match by class + position proximity
  // For simplicity, index by class+index (relies on deterministic order from save parser)
  const oldByKey = _indexVehicles(oldVehicles);
  const newByKey = _indexVehicles(newVehicles);

  for (const [key, newV] of newByKey) {
    const oldV = oldByKey.get(key);
    if (!oldV) continue; // New vehicle — skip initial items

    const vName = newV.display_name || newV.displayName || newV.class || key;
    const oldItems = _normalizeItems(oldV.inventory);
    const newItems = _normalizeItems(newV.inventory);

    const { added, removed } = _diffItemLists(oldItems, newItems);

    for (const item of added) {
      events.push({
        type: 'vehicle_item_added', category: 'vehicle',
        actor: key, actorName: vName,
        item: item.item, amount: item.amount,
        details: { durability: item.durability },
        x: newV.x ?? newV.pos_x, y: newV.y ?? newV.pos_y, z: newV.z ?? newV.pos_z,
      });
    }

    for (const item of removed) {
      events.push({
        type: 'vehicle_item_removed', category: 'vehicle',
        actor: key, actorName: vName,
        item: item.item, amount: item.amount,
        details: { durability: item.durability },
        x: newV.x ?? newV.pos_x, y: newV.y ?? newV.pos_y, z: newV.z ?? newV.pos_z,
      });
    }
  }

  return events;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Helpers
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Normalize items to a consistent format.
 * Handles JSON strings (from DB) and arrays (from parser).
 */
function _normalizeItems(items) {
  if (!items) return [];
  if (typeof items === 'string') {
    try { items = JSON.parse(items); } catch { return []; }
  }
  if (!Array.isArray(items)) return [];
  return items.filter(i => i && i.item && i.item !== 'None' && i.item !== 'Empty');
}

/**
 * Diff two item arrays.
 * Returns { added: [...], removed: [...] } — items that appeared or disappeared.
 *
 * Uses item name + amount as key. Tracks quantity changes — if a stack went from
 * 5 to 3, reports removal of 2. If duplicates exist, handles per-slot.
 */
function _diffItemLists(oldItems, newItems) {
  // Build a multimap: item → [amounts] for old and new
  const oldBag = _buildItemBag(oldItems);
  const newBag = _buildItemBag(newItems);

  const added = [];
  const removed = [];

  // All item names across both bags
  const allItems = new Set([...oldBag.keys(), ...newBag.keys()]);

  for (const itemName of allItems) {
    const oldCount = _sumAmounts(oldBag.get(itemName) || []);
    const newCount = _sumAmounts(newBag.get(itemName) || []);

    if (newCount > oldCount) {
      added.push({ item: itemName, amount: newCount - oldCount });
    } else if (oldCount > newCount) {
      removed.push({ item: itemName, amount: oldCount - newCount });
    }
  }

  return { added, removed };
}

/**
 * Build item name → [{ amount, durability, ammo }] bag.
 */
function _buildItemBag(items) {
  const bag = new Map();
  for (const item of items) {
    const name = item.item;
    if (!bag.has(name)) bag.set(name, []);
    bag.get(name).push(item);
  }
  return bag;
}

function _sumAmounts(entries) {
  return entries.reduce((sum, e) => sum + (e.amount || 1), 0);
}

/**
 * Index an array by a key function into a Map.
 */
function _indexBy(arr, keyFn) {
  const map = new Map();
  for (const item of arr) {
    const key = keyFn(item);
    if (key) map.set(key, item);
  }
  return map;
}

/**
 * Index horses by a stable composite key: class + owner (since individual actors
 * may not have a unique name).
 */
function _indexHorses(horses) {
  const map = new Map();
  const counters = new Map();
  for (const h of horses) {
    const cls = h.class || '';
    const owner = h.owner_steam_id || h.ownerSteamId || '';
    const base = `${cls}::${owner}`;
    const n = (counters.get(base) || 0) + 1;
    counters.set(base, n);
    map.set(n > 1 ? `${base}::${n}` : base, h);
  }
  return map;
}

/**
 * Index vehicles by class + index (relies on deterministic save parser ordering).
 */
function _indexVehicles(vehicles) {
  const map = new Map();
  const counters = new Map();
  for (const v of vehicles) {
    const cls = v.class || v.display_name || v.displayName || '';
    const n = (counters.get(cls) || 0) + 1;
    counters.set(cls, n);
    map.set(`${cls}::${n}`, v);
  }
  return map;
}

/**
 * Convert players (Map or object or DB array) to a Map<steamId, data>.
 */
function _toMap(players) {
  if (players instanceof Map) return players;
  if (Array.isArray(players)) {
    const map = new Map();
    for (const p of players) {
      const id = p.steam_id || p.steamId;
      if (id) map.set(id, p);
    }
    return map;
  }
  if (typeof players === 'object') {
    return new Map(Object.entries(players));
  }
  return new Map();
}

/**
 * Get inventory field from a player row, handling both DB column names and parser field names.
 */
function _getField(player, slot) {
  // Parser uses camelCase, DB uses snake_case
  return player[slot.parseField] || player[slot.dbField] || player[slot.field] || [];
}

// ═══════════════════════════════════════════════════════════════════════════
//  Container ↔ Inventory cross-referencing
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Cross-reference container item changes with player inventory changes from
 * the same diff cycle to attribute container access to specific players.
 *
 * Logic:
 * - Container lost item X + player gained item X → player took from container
 * - Container gained item X + player lost item X → player deposited to container
 * - Position proximity validates the attribution (player must be near container)
 *
 * Mutates container events in-place, adding:
 *   attributedPlayer   — display name of the matched player
 *   attributedSteamId  — steam ID of the matched player
 *
 * @param {Array<object>} events - All events from a single diff cycle
 */
function _crossReferenceContainerAccess(events) {
  // Separate container and inventory events
  const containerEvents = events.filter(e => e.category === 'container' && e.item);
  const inventoryEvents = events.filter(e => e.category === 'inventory' && e.item);

  if (containerEvents.length === 0 || inventoryEvents.length === 0) return;

  // Build per-player item maps: steamId → { gained: {item→amount}, lost: {item→amount}, name, x, y, z }
  const playerChanges = new Map();
  for (const e of inventoryEvents) {
    const steamId = e.actor;
    if (!playerChanges.has(steamId)) {
      playerChanges.set(steamId, {
        name: e.actorName, x: e.x, y: e.y, z: e.z,
        gained: new Map(), lost: new Map(),
      });
    }
    const pc = playerChanges.get(steamId);
    if (e.type === 'inventory_item_added') {
      pc.gained.set(e.item, (pc.gained.get(e.item) || 0) + e.amount);
    } else if (e.type === 'inventory_item_removed') {
      pc.lost.set(e.item, (pc.lost.get(e.item) || 0) + e.amount);
    }
  }

  // Maximum world-unit distance for a player to be "near" a container
  // UE4 units — ~5000 units ≈ 50 metres, generous to account for save timing
  const MAX_DISTANCE_SQ = 5000 * 5000;

  // For each container event, find the best player match
  for (const ce of containerEvents) {
    if (ce.type !== 'container_item_added' && ce.type !== 'container_item_removed') continue;

    let bestPlayer = null;
    let bestScore = 0;

    for (const [steamId, pc] of playerChanges) {
      // Check position proximity (if both have coordinates)
      if (ce.x != null && pc.x != null) {
        const dx = (ce.x - pc.x);
        const dy = (ce.y - pc.y);
        const distSq = dx * dx + dy * dy;
        if (distSq > MAX_DISTANCE_SQ) continue; // too far away
      }

      // Match: container lost item → player gained same item (player took it)
      // Match: container gained item → player lost same item (player deposited)
      let matchAmount = 0;
      if (ce.type === 'container_item_removed') {
        matchAmount = pc.gained.get(ce.item) || 0;
      } else if (ce.type === 'container_item_added') {
        matchAmount = pc.lost.get(ce.item) || 0;
      }

      // Score by how much overlaps (min of container change and player change)
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

module.exports = {
  diffSaveState,
  diffContainers,
  diffHorses,
  diffPlayerInventories,
  diffWorldState,
  diffVehicleInventories,
  _crossReferenceContainerAccess,
  // Exported for testing
  _diffItemLists,
  _normalizeItems,
  _buildItemBag,
};

/**
 * Item Tracker — reconciles save snapshots against the DB to track item movements.
 *
 * ## Dual-track system: Unique items vs Fungible groups
 *
 * Items with unique fingerprints (weapons with specific durability, items with
 * attachments, etc.) are tracked as individual *instances* in `item_instances`.
 * When a unique item moves from container A to player B, we detect the movement
 * and record chain-of-custody.
 *
 * Fungible items — multiple items sharing the same fingerprint at the same
 * location (e.g. 3 stacks of Nails all at durability 1.0) — are tracked as
 * counted *groups* in `item_groups`. Each group is keyed by
 * (fingerprint, location_type, location_id, location_slot). When the count
 * decreases at location A and increases at location B for the same fingerprint,
 * we detect a group transfer and record it.
 *
 * @module item-tracker
 */

import { normalizeInventory } from './item-fingerprint.js';
// HumanitZDB is the canonical type; HumanitZDBLike below provides a typed
// adapter so reconcileItems() can use db.item.xxx() with correct return types.
// Once ItemRepository has typed return values, replace HumanitZDBLike with HumanitZDB.

// ── Types ──────────────────────────────────────────────────────

interface ReconcileStats {
  matched: number;
  created: number;
  moved: number;
  lost: number;
  groups: {
    matched: number;
    created: number;
    adjusted: number;
    transferred: number;
    lost: number;
  };
}

interface LocationItem {
  item: string;
  amount: number;
  durability: number;
  ammo: number;
  attachments: string[];
  cap: number;
  maxDur: number;
  weight: number;
  wetness: number;
  fingerprint: string;
  locationType: string;
  locationId: string;
  locationSlot: string;
  x: number | null;
  y: number | null;
  z: number | null;
  _matchedInstanceId?: number;
  _matchType?: string;
}

interface ItemInstance {
  id: number;
  fingerprint: string;
  item: string;
  location_type: string;
  location_id: string;
  location_slot: string;
  amount: number;
  group_id?: number | null;
  _matched?: boolean;
}

interface ItemGroup {
  id: number;
  fingerprint: string;
  item: string;
  quantity: number;
  location_type: string;
  location_id: string;
  location_slot: string;
  pos_x?: number | null;
  pos_y?: number | null;
  pos_z?: number | null;
  _matched?: boolean;
}

interface FungibleGroup {
  fingerprint: string;
  items: LocationItem[];
  locationType: string;
  locationId: string;
  locationSlot: string;
  x: number | null;
  y: number | null;
  z: number | null;
  quantity: number;
  representative: LocationItem;
  _matchedGroupId?: number;
}

interface DeltaEntry {
  groupId: number;
  amount: number;
  locationType: string;
  locationId: string;
  locationSlot: string;
  x: number | null;
  y: number | null;
  z: number | null;
}

interface Attribution {
  steamId: string;
  name: string;
}

interface SnapshotData {
  players?: Map<string, Record<string, unknown>>;
  containers?: Array<Record<string, unknown>>;
  vehicles?: Array<Record<string, unknown>>;
  horses?: Array<Record<string, unknown>>;
  structures?: Array<Record<string, unknown>>;
  worldState?: Record<string, unknown>;
}

interface HumanitZDBLike {
  item: {
    getActiveItemInstances(): ItemInstance[];
    touchItemInstance(id: number): void;
    moveItemInstance(id: number, data: Record<string, unknown>, attribution: unknown, reason: string): void;
    createItemInstance(data: Record<string, unknown>): number;
    markItemLost(id: number): void;
    getActiveItemGroups(): ItemGroup[];
    touchItemGroup(id: number): void;
    updateItemGroupQuantity(id: number, qty: number): void;
    upsertItemGroup(data: Record<string, unknown>): { id: number };
    markItemGroupLost(id: number): void;
    getItemGroup(id: number): { item?: string } | undefined;
    recordGroupMovement(data: Record<string, unknown>): void;
  };
}

// ═══════════════════════════════════════════════════════════════════════════
//  Main entry
// ═══════════════════════════════════════════════════════════════════════════

function reconcileItems(
  db: HumanitZDBLike,
  snapshot: SnapshotData,
  nameResolver?: (steamId: string) => string,
): ReconcileStats {
  const stats: ReconcileStats = {
    matched: 0,
    created: 0,
    moved: 0,
    lost: 0,
    groups: { matched: 0, created: 0, adjusted: 0, transferred: 0, lost: 0 },
  };

  const currentItems: LocationItem[] = [];

  // Players
  if (snapshot.players) {
    for (const [steamId, data] of snapshot.players) {
      const slots: [string, unknown][] = [
        ['inventory', data['inventory']],
        ['equipment', data['equipment']],
        ['quick_slots', data['quickSlots']],
        ['backpack', data['backpackItems']],
      ];
      for (const [slotName, items] of slots) {
        if (!items || (items as unknown[]).length === 0) continue;
        _addLocationItems(currentItems, normalizeInventory(items as unknown[]), 'player', steamId, slotName, data);
      }
    }
  }

  // Containers
  if (snapshot.containers) {
    for (const c of snapshot.containers) {
      if ((c['items'] as unknown[] | undefined)?.length) {
        _addLocationItems(
          currentItems,
          normalizeInventory(c['items'] as unknown[]),
          'container',
          (c['actorName'] as string | undefined) ?? (c['name'] as string | undefined) ?? '',
          'items',
          c,
        );
      }
    }
  }

  // Vehicles
  if (snapshot.vehicles) {
    for (const v of snapshot.vehicles) {
      const slots: [string, unknown][] = [
        ['inventory', v['inventory']],
        ['trunk', v['trunkItems']],
      ];
      for (const [slotName, items] of slots) {
        if (!items || (items as unknown[]).length === 0) continue;
        _addLocationItems(
          currentItems,
          normalizeInventory(items as unknown[]),
          'vehicle',
          (v['actorName'] as string | undefined) ?? (v['name'] as string | undefined) ?? '',
          slotName,
          v,
        );
      }
    }
  }

  // Horses
  if (snapshot.horses) {
    for (const h of snapshot.horses) {
      if ((h['saddleItems'] as unknown[] | undefined)?.length) {
        _addLocationItems(
          currentItems,
          normalizeInventory(h['saddleItems'] as unknown[]),
          'horse',
          (h['actorName'] as string | undefined) ?? (h['name'] as string | undefined) ?? '',
          'saddle',
          h,
        );
      }
    }
  }

  // Structures
  if (snapshot.structures) {
    for (const s of snapshot.structures) {
      if ((s['inventory'] as unknown[] | undefined)?.length) {
        _addLocationItems(
          currentItems,
          normalizeInventory(s['inventory'] as unknown[]),
          'structure',
          (s['actorName'] as string | undefined) ?? (s['name'] as string | undefined) ?? '',
          'items',
          s,
        );
      }
    }
  }

  // World drops
  const ws = snapshot.worldState ?? {};
  if (ws['lodPickups']) {
    for (const p of ws['lodPickups'] as Array<Record<string, unknown>>) {
      if (!p['item'] || p['item'] === 'None') continue;
      const posId = `pickup_${String(Math.round(p['x'] as number))}_${String(Math.round(p['y'] as number))}_${String(Math.round(p['z'] as number))}`;
      const normalized = normalizeInventory([p]);
      _addLocationItems(currentItems, normalized, 'world_drop', posId, 'ground', p);
    }
  }
  if (ws['droppedBackpacks']) {
    for (const bp of ws['droppedBackpacks'] as Array<Record<string, unknown>>) {
      if (!(bp['items'] as unknown[] | undefined)?.length) continue;
      const posId = `backpack_${String(Math.round(bp['x'] as number))}_${String(Math.round(bp['y'] as number))}_${String(Math.round(bp['z'] as number))}`;
      _addLocationItems(currentItems, normalizeInventory(bp['items'] as unknown[]), 'backpack', posId, 'items', bp);
    }
  }
  if (ws['globalContainers']) {
    for (const gc of ws['globalContainers'] as Array<Record<string, unknown>>) {
      if (!(gc['items'] as unknown[] | undefined)?.length) continue;
      _addLocationItems(
        currentItems,
        normalizeInventory(gc['items'] as unknown[]),
        'global_container',
        (gc['actorName'] as string | undefined) ?? '',
        'items',
        gc,
      );
    }
  }

  // ── Classify items: unique vs fungible ──
  const locationGroups = new Map<string, Map<string, LocationItem[]>>();
  for (const item of currentItems) {
    const locKey = `${item.locationType}|${item.locationId}|${item.locationSlot}`;
    let fpMap = locationGroups.get(locKey);
    if (!fpMap) {
      fpMap = new Map();
      locationGroups.set(locKey, fpMap);
    }
    let fpList = fpMap.get(item.fingerprint);
    if (!fpList) {
      fpList = [];
      fpMap.set(item.fingerprint, fpList);
    }
    fpList.push(item);
  }

  const uniqueItems: LocationItem[] = [];
  const fungibleGroups: FungibleGroup[] = [];

  for (const [, fpMap] of locationGroups) {
    for (const [fingerprint, items] of fpMap) {
      const first = items[0];
      if (!first) continue;
      if (items.length === 1) {
        uniqueItems.push(first);
      } else {
        fungibleGroups.push({
          fingerprint,
          items,
          locationType: first.locationType,
          locationId: first.locationId,
          locationSlot: first.locationSlot,
          x: first.x,
          y: first.y,
          z: first.z,
          quantity: items.length,
          representative: first,
        });
      }
    }
  }

  _reconcileUniqueItems(db, uniqueItems, snapshot, nameResolver, stats);
  _reconcileFungibleGroups(db, fungibleGroups, snapshot, nameResolver, stats);

  return stats;
}

function _reconcileUniqueItems(
  db: HumanitZDBLike,
  currentItems: LocationItem[],
  snapshot: SnapshotData,
  nameResolver: ((steamId: string) => string) | undefined,
  stats: ReconcileStats,
): void {
  const existing = db.item.getActiveItemInstances();
  const existingByFP = new Map<string, ItemInstance[]>();
  for (const inst of existing) {
    if (inst.group_id) continue;
    let list = existingByFP.get(inst.fingerprint);
    if (!list) {
      list = [];
      existingByFP.set(inst.fingerprint, list);
    }
    list.push(inst);
  }

  // Pass 1: exact match
  for (const ci of currentItems) {
    const candidates = existingByFP.get(ci.fingerprint);
    if (!candidates) continue;
    const exact = candidates.find(
      (c) =>
        !c._matched &&
        c.location_type === ci.locationType &&
        c.location_id === ci.locationId &&
        c.location_slot === ci.locationSlot,
    );
    if (exact) {
      exact._matched = true;
      ci._matchedInstanceId = exact.id;
      ci._matchType = 'exact';
      db.item.touchItemInstance(exact.id);
      stats.matched++;
    }
  }

  // Pass 2: fingerprint match (moved)
  for (const ci of currentItems) {
    if (ci._matchedInstanceId) continue;
    const candidates = existingByFP.get(ci.fingerprint);
    if (!candidates) continue;
    const moved = candidates.find((c) => !c._matched);
    if (moved) {
      moved._matched = true;
      ci._matchedInstanceId = moved.id;
      ci._matchType = 'moved';
      const attribution = _attributeMovement(ci, moved, snapshot, nameResolver);
      db.item.moveItemInstance(
        moved.id,
        {
          locationType: ci.locationType,
          locationId: ci.locationId,
          locationSlot: ci.locationSlot,
          x: ci.x,
          y: ci.y,
          z: ci.z,
          amount: ci.amount,
          groupId: null,
        },
        attribution,
        'move',
      );
      stats.moved++;
    }
  }

  // Pass 3: create new
  for (const ci of currentItems) {
    if (ci._matchedInstanceId) continue;
    const id = db.item.createItemInstance({
      fingerprint: ci.fingerprint,
      item: ci.item,
      durability: ci.durability,
      ammo: ci.ammo,
      attachments: ci.attachments,
      cap: ci.cap,
      maxDur: ci.maxDur,
      locationType: ci.locationType,
      locationId: ci.locationId,
      locationSlot: ci.locationSlot,
      x: ci.x,
      y: ci.y,
      z: ci.z,
      amount: ci.amount,
      groupId: null,
    });
    ci._matchedInstanceId = id;
    stats.created++;
  }

  // Pass 4: mark lost
  for (const candidates of existingByFP.values()) {
    for (const inst of candidates) {
      if (!inst._matched) {
        db.item.markItemLost(inst.id);
        stats.lost++;
      }
    }
  }
}

function _reconcileFungibleGroups(
  db: HumanitZDBLike,
  currentGroups: FungibleGroup[],
  snapshot: SnapshotData,
  nameResolver: ((steamId: string) => string) | undefined,
  stats: ReconcileStats,
): void {
  const existingGroups = db.item.getActiveItemGroups();
  const existingByFP = new Map<string, ItemGroup[]>();
  for (const g of existingGroups) {
    let list = existingByFP.get(g.fingerprint);
    if (!list) {
      list = [];
      existingByFP.set(g.fingerprint, list);
    }
    list.push(g);
  }

  const deltas = new Map<string, { increases: DeltaEntry[]; decreases: DeltaEntry[] }>();

  for (const cg of currentGroups) {
    const rep = cg.representative;
    const existingList = existingByFP.get(cg.fingerprint) ?? [];

    const exact = existingList.find(
      (g) =>
        !g._matched &&
        g.location_type === cg.locationType &&
        g.location_id === cg.locationId &&
        g.location_slot === cg.locationSlot,
    );

    if (exact) {
      exact._matched = true;
      cg._matchedGroupId = exact.id;
      const oldQty = exact.quantity;
      const newQty = cg.quantity;

      if (oldQty === newQty) {
        db.item.touchItemGroup(exact.id);
        stats.groups.matched++;
      } else {
        db.item.updateItemGroupQuantity(exact.id, newQty);
        stats.groups.adjusted++;

        let delta = deltas.get(cg.fingerprint);
        if (!delta) {
          delta = { increases: [], decreases: [] };
          deltas.set(cg.fingerprint, delta);
        }
        if (newQty > oldQty) {
          delta.increases.push({
            groupId: exact.id,
            amount: newQty - oldQty,
            locationType: cg.locationType,
            locationId: cg.locationId,
            locationSlot: cg.locationSlot,
            x: cg.x,
            y: cg.y,
            z: cg.z,
          });
        } else {
          delta.decreases.push({
            groupId: exact.id,
            amount: oldQty - newQty,
            locationType: cg.locationType,
            locationId: cg.locationId,
            locationSlot: cg.locationSlot,
            x: cg.x,
            y: cg.y,
            z: cg.z,
          });
        }
      }
    } else {
      const { id } = db.item.upsertItemGroup({
        fingerprint: cg.fingerprint,
        item: rep.item,
        durability: rep.durability,
        ammo: rep.ammo,
        attachments: rep.attachments,
        cap: rep.cap,
        maxDur: rep.maxDur,
        locationType: cg.locationType,
        locationId: cg.locationId,
        locationSlot: cg.locationSlot,
        x: cg.x,
        y: cg.y,
        z: cg.z,
        quantity: cg.quantity,
        stackSize: rep.amount || 1,
      });
      cg._matchedGroupId = id;
      stats.groups.created++;

      let delta2 = deltas.get(cg.fingerprint);
      if (!delta2) {
        delta2 = { increases: [], decreases: [] };
        deltas.set(cg.fingerprint, delta2);
      }
      delta2.increases.push({
        groupId: id,
        amount: cg.quantity,
        locationType: cg.locationType,
        locationId: cg.locationId,
        locationSlot: cg.locationSlot,
        x: cg.x,
        y: cg.y,
        z: cg.z,
      });
    }
  }

  // Mark lost
  for (const [fp, groups] of existingByFP) {
    for (const g of groups) {
      if (!g._matched) {
        db.item.markItemGroupLost(g.id);
        stats.groups.lost++;

        let deltaFp = deltas.get(fp);
        if (!deltaFp) {
          deltaFp = { increases: [], decreases: [] };
          deltas.set(fp, deltaFp);
        }
        deltaFp.decreases.push({
          groupId: g.id,
          amount: g.quantity,
          locationType: g.location_type,
          locationId: g.location_id,
          locationSlot: g.location_slot,
          x: g.pos_x ?? null,
          y: g.pos_y ?? null,
          z: g.pos_z ?? null,
        });
      }
    }
  }

  // Cross-reference deltas
  for (const [fingerprint, delta] of deltas) {
    if (delta.decreases.length === 0 || delta.increases.length === 0) continue;

    const decreases = delta.decreases.slice().sort((a, b) => b.amount - a.amount);
    const increases = delta.increases.slice().sort((a, b) => b.amount - a.amount);

    for (const dec of decreases) {
      let remaining = dec.amount;
      for (const inc of increases) {
        if (remaining <= 0) break;
        if (inc.amount <= 0) continue;

        const transferred = Math.min(remaining, inc.amount);
        remaining -= transferred;
        inc.amount -= transferred;

        const fakeCurrentItem = {
          locationType: inc.locationType,
          locationId: inc.locationId,
          x: inc.x,
          y: inc.y,
          z: inc.z,
        };
        const fakeOldInstance = { location_type: dec.locationType, location_id: dec.locationId };
        const attribution = _attributeMovement(
          fakeCurrentItem as LocationItem,
          fakeOldInstance as ItemInstance,
          snapshot,
          nameResolver,
        );

        const srcGroup = db.item.getItemGroup(dec.groupId) as { item?: string } | undefined;
        const itemName = srcGroup?.item ?? fingerprint;

        db.item.recordGroupMovement({
          groupId: inc.groupId,
          moveType: 'group_transfer',
          item: itemName,
          from: { type: dec.locationType, id: dec.locationId, slot: dec.locationSlot },
          to: { type: inc.locationType, id: inc.locationId, slot: inc.locationSlot },
          amount: transferred,
          attribution,
          pos: { x: inc.x, y: inc.y, z: inc.z },
        });
        stats.groups.transferred++;
      }
    }
  }
}

function _addLocationItems(
  currentItems: LocationItem[],
  items: Array<{
    item: string;
    amount: number;
    durability: number;
    ammo: number;
    attachments: string[];
    cap: number;
    maxDur: number;
    weight: number;
    wetness: number;
    fingerprint: string;
  }>,
  locationType: string,
  locationId: string,
  locationSlot: string,
  entity: Record<string, unknown>,
): void {
  for (const item of items) {
    currentItems.push({
      ...item,
      locationType,
      locationId,
      locationSlot,
      x: (entity['x'] ?? entity['pos_x'] ?? null) as number | null,
      y: (entity['y'] ?? entity['pos_y'] ?? null) as number | null,
      z: (entity['z'] ?? entity['pos_z'] ?? null) as number | null,
    });
  }
}

function _attributeMovement(
  currentItem: { locationType: string; locationId: string; x?: number | null; y?: number | null; z?: number | null },
  oldInstance: { location_type: string; location_id: string },
  snapshot: SnapshotData,
  nameResolver?: (steamId: string) => string,
): Attribution | null {
  if (currentItem.locationType === 'player') {
    const name = nameResolver ? nameResolver(currentItem.locationId) : currentItem.locationId;
    return { steamId: currentItem.locationId, name };
  }

  if (oldInstance.location_type === 'player') {
    const name = nameResolver ? nameResolver(oldInstance.location_id) : oldInstance.location_id;
    return { steamId: oldInstance.location_id, name };
  }

  if (snapshot.players && currentItem.x != null) {
    const MAX_DIST_SQ = 5000 * 5000;
    let bestPlayer: string | null = null;
    let bestDistSq = MAX_DIST_SQ;

    for (const [steamId, data] of snapshot.players) {
      if (data['x'] == null) continue;
      const dx = currentItem.x - ((data['x'] as number) || 0);
      const dy = (currentItem.y ?? 0) - ((data['y'] as number) || 0);
      const distSq = dx * dx + dy * dy;
      if (distSq < bestDistSq) {
        bestDistSq = distSq;
        bestPlayer = steamId;
      }
    }

    if (bestPlayer) {
      const name = nameResolver ? nameResolver(bestPlayer) : bestPlayer;
      return { steamId: bestPlayer, name };
    }
  }

  return null;
}

export { reconcileItems };

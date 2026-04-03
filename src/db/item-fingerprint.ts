/**
 * Item fingerprint utilities — generates unique-ish identities for item instances.
 *
 * Items in HumanitZ save files have several properties that, combined, create a
 * near-unique fingerprint for tracking individual instances across locations:
 *
 *   - item (RowName)       — the item type, e.g. "AK47"
 *   - durability (float)   — current durability, high-precision float
 *   - ammo (int)           — loaded ammo count (weapons only)
 *   - attachments (array)  — attached mods/scopes
 *   - cap (float)          — container capacity (bottles, etc.)
 *   - maxDur (float)       — max durability (may differ from item default after repair)
 *
 * The durability float alone has enough precision (~6 decimal digits) that two
 * AK-47s at 0.847623 and 0.847624 are distinguishable. Combined with ammo and
 * attachments, collisions are extremely rare in practice.
 *
 * Stackable items (amount > 1) with identical durability WILL collide — that's
 * correct behaviour. Nails x50 at durability 1.0 is fungible; we track the stack.
 *
 * @module item-fingerprint
 */

import * as crypto from 'node:crypto';

/* eslint-disable @typescript-eslint/no-unnecessary-condition, @typescript-eslint/no-unnecessary-type-assertion */

interface ItemInput {
  item: string;
  durability?: number;
  ammo?: number;
  attachments?: string[];
  cap?: number;
  maxDur?: number;
  amount?: number;
  weight?: number;
  wetness?: number;
}

interface NormalizedItem {
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
}

interface RawSlotProperty {
  name: string;
  value?: unknown;
  children?: RawSlotProperty[];
}

/**
 * Generate a fingerprint hash for an item instance.
 */
function generateFingerprint(item: ItemInput): string {
  if (!item || !item.item) return '';

  // Build deterministic string from all distinguishing properties
  const parts = [
    item.item,
    _normFloat(item.durability),
    String(item.ammo ?? 0),
    _normAttachments(item.attachments),
    _normFloat(item.cap),
    _normFloat(item.maxDur),
  ];

  const raw = parts.join('|');
  return crypto.createHash('md5').update(raw).digest('hex').slice(0, 12);
}

/**
 * Normalize a float to a consistent string representation.
 * Rounds to 6 decimal places to avoid floating point drift between parses.
 */
function _normFloat(val: number | null | undefined): string {
  if (!val && val !== 0) return '0';
  return val.toFixed(6);
}

/**
 * Normalize attachments array to a consistent sorted string.
 */
function _normAttachments(attachments: string[] | null | undefined): string {
  if (!attachments || !Array.isArray(attachments) || attachments.length === 0) return '';
  return attachments.slice().sort().join(',');
}

/**
 * Extract fingerprint-relevant fields from a raw inventory slot.
 * Works with both agent output ({item, durability, ammo, ...}) and
 * raw save-parser output (array of property objects).
 */
function normalizeSlot(slot: ItemInput | RawSlotProperty[] | null | undefined): NormalizedItem | null {
  if (!slot) return null;

  // Already in clean format (from agent or post-processing)
  if (!Array.isArray(slot) && typeof (slot as ItemInput).item === 'string') {
    const s = slot as ItemInput;
    if (!s.item || s.item === 'None' || s.item === 'Empty') return null;
    return {
      item: s.item,
      amount: s.amount ?? 1,
      durability: s.durability ?? 0,
      ammo: s.ammo ?? 0,
      attachments: s.attachments ?? [],
      cap: s.cap ?? 0,
      maxDur: s.maxDur ?? 0,
      weight: s.weight ?? 0,
      wetness: s.wetness ?? 0,
      fingerprint: generateFingerprint(s),
    };
  }

  // Raw save-parser format: array of property objects [{name, value}, ...]
  if (Array.isArray(slot)) {
    const parsed: NormalizedItem = {
      item: '',
      amount: 0,
      durability: 0,
      ammo: 0,
      attachments: [],
      cap: 0,
      maxDur: 0,
      weight: 0,
      wetness: 0,
      fingerprint: '',
    };
    for (const prop of slot) {
      if (prop.name === 'Item' && prop.children) {
        for (const c of prop.children) {
          if (c.name === 'RowName') parsed.item = (c.value as string) ?? '';
        }
      }
      if (prop.name === 'Amount') parsed.amount = (prop.value as number) ?? 0;
      if (prop.name === 'Durability') parsed.durability = (prop.value as number) ?? 0;
      if (prop.name === 'Ammo') parsed.ammo = (prop.value as number) ?? 0;
      if (prop.name === 'Attachments' && Array.isArray(prop.value)) parsed.attachments = prop.value as string[];
      if (prop.name === 'Cap') parsed.cap = (prop.value as number) ?? 0;
      if (prop.name === 'MaxDur') parsed.maxDur = (prop.value as number) ?? 0;
      if (prop.name === 'Weight') parsed.weight = (prop.value as number) ?? 0;
      if (prop.name === 'Wetness') parsed.wetness = (prop.value as number) ?? 0;
    }
    if (!parsed.item || parsed.item === 'None' || parsed.item === 'Empty') return null;
    parsed.fingerprint = generateFingerprint(parsed);
    return parsed;
  }

  return null;
}

/**
 * Normalize a full inventory array (from any source) into clean fingerprinted items.
 */
function normalizeInventory(items: unknown[] | null | undefined): NormalizedItem[] {
  if (!items || !Array.isArray(items)) return [];
  const result: NormalizedItem[] = [];
  for (const slot of items) {
    const normalized = normalizeSlot(slot as ItemInput | RawSlotProperty[]);
    if (normalized) result.push(normalized);
  }
  return result;
}

/**
 * Build a fingerprint -> item map for fast lookup during reconciliation.
 */
function buildFingerprintMap(items: NormalizedItem[]): Map<string, NormalizedItem[]> {
  const map = new Map<string, NormalizedItem[]>();
  for (const item of items) {
    if (!item.fingerprint) continue;
    const arr = map.get(item.fingerprint);
    if (arr) {
      arr.push(item);
    } else {
      map.set(item.fingerprint, [item]);
    }
  }
  return map;
}

export { generateFingerprint, normalizeSlot, normalizeInventory, buildFingerprintMap };
export type { NormalizedItem, ItemInput, RawSlotProperty };

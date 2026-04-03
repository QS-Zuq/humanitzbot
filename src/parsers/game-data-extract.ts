'use strict';

/* eslint-disable @typescript-eslint/no-unnecessary-condition -- raw JSON fields may be absent at runtime */

// ═══════════════════════════════════════════════════════════════════════════
//  game-data-extract.ts — Dynamic extraction from game-tables-raw.json
//
//  Reads the full 22 MB extraction once at module load, cleans UE4 hashed
//  field names, resolves enum values to human-readable names, and exports
//  structured data for every useful table. Profession and clan-rank enums
//  delegate to save-parser.js as the single source of truth.
// ═══════════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { getDirname } from '../utils/paths.js';

const __dirname = getDirname(import.meta.url);

// ── Types ─────────────────────────────────────────────────────────────────

type RawValue = string | number | boolean | null | undefined | RawObject | RawArray;
interface RawObject {
  [key: string]: RawValue;
}
type RawArray = RawValue[];

interface RawTable {
  rows?: Record<string, Record<string, RawValue>>;
  rowCount?: number;
}

interface SaveParserEnums {
  PERK_MAP: Record<string, string>;
  CLAN_RANK_MAP: Record<string, string>;
}

// RawObject is a RawObject with known keys — no separate interface needed

// ── Load raw data ──────────────────────────────────────────────────────────

const RAW_PATH = path.join(__dirname, '..', '..', 'data', 'game-tables-raw.json');

let RAW: Record<string, RawTable>;
try {
  RAW = JSON.parse(fs.readFileSync(RAW_PATH, 'utf8')) as Record<string, RawTable>;
} catch {
  console.warn('[game-data-extract] game-tables-raw.json not found — exports will be empty');
  RAW = {};
}

// ── Key-cleaning helpers ───────────────────────────────────────────────────

/**
 * UE4 exports field names like `FieldName_N_HEXHASH`.
 * This regex extracts just the clean portion.
 */
const HASH_RE = /^(.+?)_\d+_[A-F0-9]{20,}$/i;

/** Strip UE4 hash suffix from a single key. */
function cleanKey(key: string): string {
  const m = key.match(HASH_RE);
  return m?.[1] ?? key;
}

/** Recursively clean all keys in an object/array. */
function deepClean(val: RawValue): RawValue {
  if (val === null || val === undefined) return val;
  if (Array.isArray(val)) return val.map(deepClean);
  if (typeof val === 'object') {
    const out: RawObject = {};
    for (const [k, v] of Object.entries(val)) {
      out[cleanKey(k)] = deepClean(v);
    }
    return out;
  }
  return val;
}

/** Clean only top-level keys of a row (fast path for flat tables). */
function cleanRow(row: Record<string, RawValue>): RawObject {
  const out: RawObject = {};
  for (const [k, v] of Object.entries(row)) {
    out[cleanKey(k)] = v;
  }
  return out;
}

// ── Adapter: shared enums from save-parser (single source of truth) ──────

/**
 * Project a prefixed enum map (e.g. 'Enum_Professions::NewEnumerator0' → 'Unemployed')
 * into the unprefixed format used by ENUM_MAPS ('NewEnumerator0' → 'Unemployed').
 * Optionally fills Reserved placeholder slots for unused enum indices.
 */
function _projectEnum(prefixedMap: Record<string, string>, reservedSlots: number[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const [key, value] of Object.entries(prefixedMap)) {
    const idx = key.indexOf('::');
    if (idx !== -1) map[key.substring(idx + 2)] = value;
  }
  for (const slot of reservedSlots) {
    const k = `NewEnumerator${String(slot)}`;
    if (!map[k]) map[k] = 'Reserved';
  }
  return map;
}

// Load save-parser enum maps; fall back to empty objects if unavailable
let _saveParserEnums: SaveParserEnums;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- sync module-scope init, top-level await incompatible with CJS
  const sp = require('./save-parser') as SaveParserEnums;
  _saveParserEnums = { PERK_MAP: sp.PERK_MAP, CLAN_RANK_MAP: sp.CLAN_RANK_MAP };
} catch (err: unknown) {
  if ((err as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') {
    console.warn('[game-data-extract] save-parser load error:', (err as Error).message);
  }
  _saveParserEnums = { PERK_MAP: {}, CLAN_RANK_MAP: {} };
}

// ── Enum resolution ────────────────────────────────────────────────────────

/** All enum maps — display names for every UE4 enum value. */
const ENUM_MAPS: Record<string, Record<string, string>> = {
  // Item types (25 values — verified against DT_ItemDatabase Type field)
  E_ItemTypes: {
    NewEnumerator0: 'Misc',
    NewEnumerator2: 'Melee',
    NewEnumerator3: 'Pistol',
    NewEnumerator4: 'Ranged',
    NewEnumerator5: 'Medical',
    NewEnumerator6: 'Drink',
    NewEnumerator7: 'Food',
    NewEnumerator8: 'Consumable',
    NewEnumerator9: 'Resource',
    NewEnumerator10: 'Tool',
    NewEnumerator11: 'Utility',
    NewEnumerator12: 'Ammo',
    NewEnumerator13: 'Equipment',
    NewEnumerator14: 'Material',
    NewEnumerator15: 'Trinket',
    NewEnumerator16: 'Repair',
    NewEnumerator17: 'Key',
    NewEnumerator18: 'Armor',
    NewEnumerator19: 'Power',
    NewEnumerator20: 'VehiclePart',
    NewEnumerator21: 'Throwable',
    NewEnumerator22: 'Treatment',
    NewEnumerator23: 'Trap',
    NewEnumerator24: 'Attachment',
    NewEnumerator25: 'SkillBook',
  },

  E_SpecificType: {
    NewEnumerator0: 'Vehicle Part',
    NewEnumerator1: 'Energy Drink',
    NewEnumerator2: 'Alcohol',
    NewEnumerator3: 'Blunt',
    NewEnumerator4: 'Blade',
    NewEnumerator5: 'None',
    NewEnumerator6: 'None',
    NewEnumerator7: 'Vegetable',
    NewEnumerator8: 'Fruit',
    NewEnumerator9: 'Medicine',
    NewEnumerator10: 'None',
    NewEnumerator11: 'Dirty Water',
    NewEnumerator12: 'None',
    NewEnumerator13: 'None',
    NewEnumerator14: 'Meat',
  },

  E_ClothingPosition: {
    NewEnumerator0: 'None',
    NewEnumerator1: 'Head',
    NewEnumerator3: 'Body',
    NewEnumerator4: 'Legs',
    NewEnumerator5: 'Feet',
    NewEnumerator6: 'Hands',
    NewEnumerator7: 'Face',
    NewEnumerator8: 'Back',
  },

  E_BuildCategory: {
    NewEnumerator0: 'Crafting',
    NewEnumerator1: 'Structure',
    NewEnumerator2: 'Farming',
    NewEnumerator3: 'Storage',
    NewEnumerator4: 'Power',
    NewEnumerator5: 'Defence',
  },

  E_CraftingStation: {
    NewEnumerator0: 'Inventory',
    NewEnumerator1: 'Campfire',
    NewEnumerator2: 'Distiller',
    NewEnumerator3: 'Cooking Stove',
    NewEnumerator4: 'Workbench',
    NewEnumerator5: 'Chemistry Station',
    NewEnumerator6: 'Fat Converter',
    NewEnumerator7: 'Melee Bench',
    NewEnumerator8: 'Ammo Bench',
    NewEnumerator9: 'Table Saw',
    NewEnumerator10: 'Furnace',
    NewEnumerator11: 'Tanning Rack',
    NewEnumerator12: 'Tailoring Bench',
    NewEnumerator13: 'Salting Table',
    NewEnumerator14: 'Cement Mixer',
  },

  E_ResourceType: {
    NewEnumerator0: 'Wood',
    NewEnumerator1: 'Rock',
    NewEnumerator2: 'Ammo',
    NewEnumerator3: 'Scrap Metal',
    NewEnumerator4: 'Rope',
    NewEnumerator5: 'Log',
    NewEnumerator6: 'Nails',
    NewEnumerator8: 'Sticks',
    NewEnumerator9: 'Tarp',
    NewEnumerator10: 'Car Battery',
    NewEnumerator11: 'Electronics',
    NewEnumerator13: 'Sheet Metal',
    NewEnumerator14: 'Oil',
    NewEnumerator15: 'Fuel Can',
    NewEnumerator16: 'Barb Wire',
    NewEnumerator17: 'Electrical Cable',
    NewEnumerator18: 'Empty Jar',
    NewEnumerator20: 'Cement',
    NewEnumerator21: 'Refined Iron',
    NewEnumerator22: 'Hose',
    NewEnumerator23: 'Funnel',
    NewEnumerator24: 'Gun Parts',
    NewEnumerator25: 'Pollen Trap',
    NewEnumerator26: 'Microphone',
    NewEnumerator27: 'Generator Engine',
    NewEnumerator28: 'Thermostat',
    NewEnumerator29: 'Compressor',
    NewEnumerator30: 'Element',
    NewEnumerator31: 'Jump Leads',
    NewEnumerator32: 'Battery Charger',
    NewEnumerator33: 'Water Barrel',
    NewEnumerator34: 'Bear Hide',
    NewEnumerator35: 'Wolf Hide',
    NewEnumerator36: 'Deer Hide',
    NewEnumerator37: 'Alarm Clock',
    NewEnumerator38: 'Grenade',
    NewEnumerator39: 'Thread',
    NewEnumerator40: 'Pump Shotgun',
    NewEnumerator41: 'Reserved',
  },

  E_CarUpgradeTypes: {
    NewEnumerator0: 'Front Bumper',
    NewEnumerator1: 'Rear Bumper',
    NewEnumerator2: 'Reserved',
    NewEnumerator3: 'Reserved',
    NewEnumerator4: 'Storage',
    NewEnumerator5: 'Wheels',
    NewEnumerator6: 'Reserved',
    NewEnumerator7: 'Window Left',
    NewEnumerator8: 'Window Right',
    NewEnumerator9: 'Windshield',
    NewEnumerator10: 'Reserved',
  },

  Enum_AnimalType: {
    NewEnumerator0: 'Bear',
    NewEnumerator1: 'Wolf',
    NewEnumerator2: 'Deer',
    NewEnumerator3: 'Rabbit',
    NewEnumerator4: 'Chicken',
    NewEnumerator5: 'Pig',
  },

  Enum_Professions: _projectEnum(_saveParserEnums.PERK_MAP, [4, 5, 6, 7, 8]),

  Enum_SkillCategories: {
    NewEnumerator0: 'Survival',
    NewEnumerator1: 'Crafting',
    NewEnumerator2: 'Combat',
  },

  Enum_SkillBookType: {
    NewEnumerator0: 'Recipe',
    NewEnumerator1: 'Skill',
  },

  E_StatCat: {
    NewEnumerator0: 'Objective',
    NewEnumerator1: 'Combat',
    NewEnumerator2: 'Quest',
    NewEnumerator3: 'Survival',
  },

  E_MiniRequired: {
    NewEnumerator0: 'Item',
    NewEnumerator1: 'Kill',
  },

  E_ClanRank: _projectEnum(_saveParserEnums.CLAN_RANK_MAP, []),

  E_DogCommand: {
    NewEnumerator0: 'Follow',
    NewEnumerator1: 'Stay',
    NewEnumerator2: 'Attack',
    NewEnumerator3: 'Guard',
    NewEnumerator4: 'Patrol',
    NewEnumerator5: 'Dismiss',
  },

  E_QuestStatus: {
    NewEnumerator0: 'Available',
    NewEnumerator1: 'Active',
    NewEnumerator2: 'Complete',
    NewEnumerator3: 'Failed',
  },

  Enum_CharacterStartPerk: {
    NewEnumerator0: 'None',
    NewEnumerator1: 'Strong',
    NewEnumerator2: 'Fast',
    NewEnumerator3: 'Quiet',
    NewEnumerator4: 'Tough',
    NewEnumerator5: 'Smart',
    NewEnumerator6: 'Lucky',
    NewEnumerator7: 'Resourceful',
    NewEnumerator8: 'Hardy',
  },

  E_InvSlotType: {
    NewEnumerator0: 'Equipment',
    NewEnumerator1: 'Quickslot',
    NewEnumerator2: 'Pocket',
    NewEnumerator3: 'Backpack',
    NewEnumerator4: 'Container',
    NewEnumerator5: 'Ground',
    NewEnumerator6: 'Vehicle',
    NewEnumerator7: 'Hotbar',
    NewEnumerator8: 'Clothing',
    NewEnumerator9: 'Trade',
  },

  E_ContainerSlots: {
    NewEnumerator0: 'Medium',
    NewEnumerator1: 'Large',
    NewEnumerator2: 'Small',
    NewEnumerator3: 'Extra Large',
  },
};

/**
 * Resolve a UE4 enum string like "E_ItemTypes::NewEnumerator3" to its display name.
 * Returns the raw value if no mapping is found.
 */
function resolveEnum(value: RawValue): RawValue {
  if (typeof value !== 'string') return value;
  const idx = value.indexOf('::');
  if (idx === -1) return value;
  const prefix = value.substring(0, idx);
  const suffix = value.substring(idx + 2);
  const map = ENUM_MAPS[prefix];
  return map?.[suffix] ?? value;
}

// ── Table accessors ────────────────────────────────────────────────────────

function getTable(name: string): Record<string, Record<string, RawValue>> {
  return RAW[name]?.rows ?? {};
}

function getTableCleaned(name: string): Record<string, RawObject> {
  const rows = getTable(name);
  const out: Record<string, RawObject> = {};
  for (const [id, row] of Object.entries(rows)) {
    out[id] = deepClean(row) as RawObject;
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
//  ITEMS — DT_ItemDatabase (718 items, ~35 gameplay fields each)
// ═══════════════════════════════════════════════════════════════════════════

function extractItems(): Record<string, RawObject> {
  const raw = getTable('DT_ItemDatabase');
  const items: Record<string, RawObject> = {};
  for (const [id, row] of Object.entries(raw)) {
    const c = cleanRow(row) as Record<string, RawValue>;

    const attachments = c['SupportedAttachments'] ? deepClean(c['SupportedAttachments']) : null;
    const itemsInside = c['ItemsInside'] ? deepClean(c['ItemsInside']) : null;
    const skillBookData = c['SkillBookData'] ? deepClean(c['SkillBookData']) : null;
    const customImage = c['CustomImage'] ? deepClean(c['CustomImage']) : null;

    items[id] = {
      id,
      name: c['Name'] || id,
      description: c['Desc'] || '',
      type: resolveEnum(c['Type']),
      typeRaw: c['Type'] || '',
      specificType: resolveEnum(c['SpecificType']),
      wearPosition: resolveEnum(c['WearOnCharacter']),
      buildResource: resolveEnum(c['BuildResource']),
      chanceToSpawn: c['ChanceToSpawn'] ?? 0,
      durabilityLoss: c['DurabilityLoss'] ?? 0,
      armorProtection: c['ArmorProtectionValue'] ?? 0,
      maxStackSize: c['MaxStackSize'] ?? 1,
      canStack: c['CanStack'] ?? false,
      itemSize: c['ItemSize'] ?? 1,
      weight: c['Weight'] ?? 0,
      firstValue: c['FirstValue'] ?? 0,
      secondItemType: resolveEnum(c['SecondItemType']),
      secondValue: c['SecondValue'] ?? 0,
      valueToTrader: c['ValueToTrader'] ?? 0,
      valueForPlayer: c['ValueForPlayer'] ?? 0,
      doesDecay: c['DoesDecay'] ?? false,
      decayPerDay: c['DecayPerDay'] ?? 0,
      onlyDecayIfOpened: c['OnlyDecayIfOpened'] ?? false,
      warmthValue: c['WarmthValue'] ?? 0,
      infectionProtection: c['InfectionProtection'] ?? 0,
      clothingRainMod: c['ClothingRainModifier'] ?? 0,
      clothingSnowMod: c['ClothingSnowModifier'] ?? 0,
      summerCoolValue: c['SummerCoolValue'] ?? 0,
      isSkillBook: c['IsSkillBook'] ?? false,
      noPocket: c['NoPocket'] ?? false,
      excludeFromVendor: c['ExcludeFromVendor'] ?? false,
      excludeFromAI: c['ExcludeFromAI'] ?? false,
      useAsFertilizer: c['UseAsFertilizer'] ?? false,
      closeBackpackOnUse: c['CloseBackpackOnUse'] ?? false,
      state: c['State'] ?? '',
      randCapacity: c['RandCapacity'] ?? 0,
      randAtt: c['RandAtt'] ?? false,
      tag: c['Tag'] || '',
      openItem: c['OpenItem'] || '',
      bodyAttachSocket: c['BodyAttachSocket'] || '',
      supportedAttachments: attachments,
      itemsInside: itemsInside,
      skillBookData: skillBookData,
      customImage: customImage,
    };
  }
  return items;
}

// ═══════════════════════════════════════════════════════════════════════════
//  LOOT TABLES — 68 INV_* tables
// ═══════════════════════════════════════════════════════════════════════════

function extractLootTables(): Record<string, RawObject> {
  const tables: Record<string, RawObject> = {};
  for (const tableName of Object.keys(RAW)) {
    if (!tableName.startsWith('INV_')) continue;
    const raw = getTable(tableName);
    const items: Record<string, RawObject> = {};
    for (const [itemId, row] of Object.entries(raw)) {
      const c = cleanRow(row);
      items[itemId] = {
        name: c['Name'] || itemId,
        chanceToSpawn: c['ChanceToSpawn'] ?? 0,
        type: resolveEnum(c['Type']),
        maxStackSize: c['MaxStackSize'] ?? 1,
      };
    }
    tables[tableName] = {
      name: tableName,
      itemCount: Object.keys(items).length,
      items,
    };
  }
  return tables;
}

// ═══════════════════════════════════════════════════════════════════════════
//  BUILDINGS — DT_Buildings (122 entries)
// ═══════════════════════════════════════════════════════════════════════════

function extractBuildings(): Record<string, RawObject> {
  const raw = getTable('DT_Buildings');
  const buildings: Record<string, RawObject> = {};
  for (const [id, row] of Object.entries(raw)) {
    const c = cleanRow(row);

    const resources: RawObject[] = [];
    if (Array.isArray(c['RequiredResources'])) {
      for (const res of c['RequiredResources']) {
        const rc = deepClean(res) as RawObject;
        resources.push({
          type: resolveEnum(rc['ResourceType']),
          typeRaw: (rc['ResourceType'] as string) || '',
          amount: (rc['Amount'] as number) ?? 0,
        });
      }
    }

    const upgrades: RawObject[] = [];
    if (Array.isArray(c['Upgrades'])) {
      for (const upg of c['Upgrades']) {
        const uc = deepClean(upg) as RawObject;
        const upgResources: RawObject[] = [];
        if (Array.isArray(uc['RequiredResources'])) {
          for (const res of uc['RequiredResources']) {
            const r = res as RawObject;
            upgResources.push({
              type: resolveEnum(r['ResourceType']),
              amount: r['Amount'] ?? 0,
            });
          }
        }
        upgrades.push({
          health: (uc['NewHealth'] as number) ?? 0,
          resources: upgResources,
        });
      }
    }

    buildings[id] = {
      id,
      name: c['BuildingName'] || id,
      description: c['Description'] || '',
      category: resolveEnum(c['Category']),
      categoryRaw: c['Category'] || '',
      health: c['FinishedBuildingHealth'] ?? 0,
      showInBuildMenu: c['ShowInBuildMenu'] ?? false,
      requiresBuildTool: c['RequiresBuildTool'] ?? false,
      moveableAfterPlacement: c['MoveableAfterPlacement'] ?? false,
      learnedBuilding: c['LearnedBuilding'] ?? false,
      placementOnLandscapeOnly: c['PlacementOnLandscapeOnly'] ?? false,
      placementInWaterOnly: c['PlacementInWaterOnly'] ?? false,
      placementOnStructureOnly: c['PlacementOnStructureOnly'] ?? false,
      wallPlacement: c['WallPlacement?'] ?? false,
      requireFoundation: c['RequireFoundation?'] ?? false,
      requireAllFoundations: c['RequireAllFoundations?'] ?? false,
      allowSnapToggle: c['AllowSnapToggle'] ?? false,
      checkGeoCollision: c['CheckGeoCollision'] ?? false,
      wallDistance: c['WallDistance'] ?? 0,
      forwardDistance: c['ForwardDistance'] ?? 0,
      xpMultiplier: c['XPMultiplier'] ?? 1,
      resources,
      upgrades,
    };
  }
  return buildings;
}

// ═══════════════════════════════════════════════════════════════════════════
//  CRAFTING RECIPES — DT_CraftingData
// ═══════════════════════════════════════════════════════════════════════════

function parseRawObject(struct: RawValue): RawObject | null {
  if (!struct) return null;
  const c = deepClean(struct) as RawObject;
  const dt = c['Item'] as RawObject | undefined;
  return {
    itemId: (dt?.['RowName'] as string) || '',
    amount: c['Amount'] ?? 0,
    durability: c['Durability'] ?? 0,
    ammo: c['Ammo'] ?? 0,
    weight: c['Weight'] ?? 0,
    capacity: c['Cap'] ?? 0,
  };
}

function extractRecipes(): Record<string, RawObject> {
  const raw = getTable('DT_CraftingData');
  const recipes: Record<string, RawObject> = {};
  for (const [id, row] of Object.entries(raw)) {
    const c = deepClean(row) as RawObject;

    const ingredients: RawObject[] = [];
    if (Array.isArray(c['RequiredItems'])) {
      for (const req of c['RequiredItems']) {
        const parsed = parseRawObject(req);
        if (parsed && parsed.itemId && parsed.itemId !== 'Empty' && parsed.itemId !== 'None') {
          ingredients.push(parsed);
        }
      }
    }

    const craftedItem = parseRawObject(c['CraftedIItem']);
    const alsoGive = parseRawObject(c['AlsoGiveItem']);
    const alsoGiveArr: RawObject[] = [];
    if (Array.isArray(c['AlsoGiveArr'])) {
      for (const item of c['AlsoGiveArr']) {
        const p = parseRawObject(item);
        if (p && p.itemId && p.itemId !== 'Empty' && p.itemId !== 'None') alsoGiveArr.push(p);
      }
    }

    recipes[id] = {
      id,
      name: c['RecipeName'] || id,
      description: c['RecipeDescription'] || '',
      station: resolveEnum(c['CraftingStation']),
      stationRaw: c['CraftingStation'] || '',
      recipeType: resolveEnum(c['RecipeType']),
      craftTime: c['CraftTime'] ?? 0,
      profession: resolveEnum(c['Profession']),
      professionRaw: c['Profession'] || '',
      requiresRecipe: c['RequiresRecipe'] ?? false,
      hidden: c['Hidden?'] ?? false,
      inventorySearchOnly: c['InventorySearchOnly'] ?? false,
      xpMultiplier: c['XPMultiplier'] ?? 1,
      maxItemsDisplayed: c['MaxItemsDisplayed'] ?? 1,
      useAny: c['UseAny?'] ?? false,
      copyCapacity: c['CopyCapacity?'] ?? false,
      noSpoiled: c['NoSpoiled?'] ?? false,
      ignoreMeleeCheck: c['IgnoreMeleeCheck'] ?? false,
      overrideName: c['OverrideName'] || '',
      overrideDescription: c['OverrideDescription'] || '',
      craftedItem,
      alsoGiveItem:
        alsoGive && alsoGive.itemId && alsoGive.itemId !== 'Empty' && alsoGive.itemId !== 'None' ? alsoGive : null,
      alsoGiveArr: alsoGiveArr.length > 0 ? alsoGiveArr : null,
      ingredients,
    };
  }
  return recipes;
}

// ═══════════════════════════════════════════════════════════════════════════
//  SKILLS — DT_Skills
// ═══════════════════════════════════════════════════════════════════════════

function extractSkills(): Record<string, RawObject> {
  const raw = getTable('DT_Skills');
  const skills: Record<string, RawObject> = {};
  for (const [id, row] of Object.entries(raw)) {
    const c = deepClean(row) as RawObject;

    const perk = (c['PerkModifier'] as RawObject) || {};
    const effects: RawObject = {
      fuelPercentage: perk['FuelPercentage'] ?? 1,
      repairPercentage: perk['RepairPercentage'] ?? 1,
      chargePercentage: perk['ChargePercentage'] ?? 1,
      chancePercentage: perk['ChancePercentage'] ?? 1,
      timePercentage: perk['TimePercentage'] ?? 1,
      weightPercentage: perk['WeightPercentage'] ?? 1,
      projectileDamagePercentage: perk['ProjectileDamagePercentage'] ?? 1,
      meleeDamagePercentage: perk['MeleeDamagePercentage'] ?? 1,
      explosiveDamagePercentage: perk['ExplosiveDamagePercentage'] ?? 1,
      fistsDamagePercentage: perk['FistsDamagePercentage'] ?? 0,
      zoomPercentage: perk['ZoomPercentage'] ?? 0,
      enabled: perk['Enable'] ?? false,
      time: perk['Time'] ?? 0,
      amountSingle: perk['AmountSingle'] ?? 0,
      amountDecimal: perk['AmountDecimal'] ?? 0,
    };

    const attributeModifiers: RawObject[] = [];
    if (Array.isArray(perk['AttributeModifiers'])) {
      for (const mod of perk['AttributeModifiers']) {
        const m = mod as RawObject;
        attributeModifiers.push({
          conditions: (m['Conditions'] as RawArray) || [],
          gainMultiplier: m['GainMultiplier'] ?? 0,
          drainMultiplier: m['DrainMultiplier'] ?? 0,
          valueModifier: m['ValueModifier'] ?? 0,
          isPercentage: m['ValueIsPercentage'] ?? true,
        });
      }
    }

    const skillModifiers: RawObject[] = [];
    if (Array.isArray(c['SkillModifiers'])) {
      for (const sm of c['SkillModifiers']) {
        const s = sm as RawObject;
        const generalMods: RawObject[] = [];
        if (Array.isArray(s['ModifiersGeneral'])) {
          for (const gm of s['ModifiersGeneral']) {
            const g = gm as RawObject;
            generalMods.push({
              effect: (g['Effect'] as RawArray) || [],
              value: g['Value'] ?? 0,
              isPercentage: g['IsPercentage'] ?? false,
            });
          }
        }
        const attrMods: RawObject[] = [];
        if (Array.isArray(s['ModifiersAttributes'])) {
          for (const am of s['ModifiersAttributes']) {
            const a = am as RawObject;
            attrMods.push({
              conditions: (a['Conditions'] as RawArray) || [],
              gainMultiplier: a['GainMultiplier'] ?? 0,
              drainMultiplier: a['DrainMultiplier'] ?? 0,
              valueModifier: a['ValueModifier'] ?? 0,
              isPercentage: a['ValueIsPercentage'] ?? true,
            });
          }
        }
        skillModifiers.push({
          targetClassifications: (s['TargetClassifications'] as RawArray) || [],
          conditions: (s['Conditions'] as RawArray) || [],
          generalModifiers: generalMods,
          attributeModifiers: attrMods,
        });
      }
    }

    skills[id] = {
      id,
      name: c['Name'] || id,
      description: c['Description'] || '',
      category: resolveEnum(c['Category']),
      categoryRaw: c['Category'] || '',
      cost: c['Cost'] ?? 0,
      levelUnlock: c['LevelUnlock'] ?? 0,
      tier: c['Tier'] ?? 0,
      column: c['Column'] ?? 0,
      effects,
      attributeModifiers,
      skillModifiers,
    };
  }
  return skills;
}

// ═══════════════════════════════════════════════════════════════════════════
//  PROFESSIONS — DT_Professions (12 entries)
// ═══════════════════════════════════════════════════════════════════════════

function extractProfessions(): Record<string, RawObject> {
  const raw = getTable('DT_Professions');
  const professions: Record<string, RawObject> = {};
  for (const [id, row] of Object.entries(raw)) {
    const c = deepClean(row) as RawObject;
    professions[id] = {
      id,
      name: c['Name'] || id,
      description: c['Description'] || '',
      startingItems: Array.isArray(c['StartingItems'])
        ? c['StartingItems']
            .map(parseRawObject)
            .filter((r): r is RawObject => r !== null && !!r.itemId && r.itemId !== 'None' && r.itemId !== 'Empty')
        : [],
      passivePerks: (c['PassivePerks'] as RawArray) || [],
    };
  }
  return professions;
}

// ═══════════════════════════════════════════════════════════════════════════
//  STATISTICS / CHALLENGES — DT_Statistics
// ═══════════════════════════════════════════════════════════════════════════

function extractStatistics(): Record<string, RawObject> {
  const raw = getTable('DT_Statistics');
  const stats: Record<string, RawObject> = {};
  for (const [id, row] of Object.entries(raw)) {
    const c = cleanRow(row);
    const progress = c['Progress'] as RawObject | undefined;
    stats[id] = {
      id,
      guid: c['ID'] || '',
      category: resolveEnum(c['Category']),
      categoryRaw: c['Category'] || '',
      name: c['Name'] || id,
      description: c['Descriptionn'] || c['Description'] || '',
      progressMin: (progress?.['x'] as number) ?? 0,
      progressMax: (progress?.['y'] as number) ?? 1,
      xp: c['XP'] ?? 0,
      skillPoint: c['SkillPoint'] ?? 0,
    };
  }
  return stats;
}

// ═══════════════════════════════════════════════════════════════════════════
//  STAT CONFIG / CHALLENGES — DT_StatConfig (67 detailed challenge definitions)
// ═══════════════════════════════════════════════════════════════════════════

function extractStatConfig(): Record<string, RawObject> {
  const raw = getTable('DT_StatConfig');
  const stats: Record<string, RawObject> = {};
  for (const [id, row] of Object.entries(raw)) {
    const c = cleanRow(row);
    const progress = c['Progress'] as RawObject | undefined;
    stats[id] = {
      id,
      guid: c['ID'] || '',
      category: resolveEnum(c['Category']),
      categoryRaw: c['Category'] || '',
      name: c['Name'] || id,
      description: c['Descriptionn'] || c['Description'] || '',
      progressMin: (progress?.['x'] as number) ?? 0,
      progressMax: (progress?.['y'] as number) ?? 1,
      xp: c['XP'] ?? 0,
      skillPoint: c['SkillPoint'] ?? 0,
    };
  }
  return stats;
}

// ═══════════════════════════════════════════════════════════════════════════
//  CROPS — DT_CropData
// ═══════════════════════════════════════════════════════════════════════════

function extractCrops(): Record<string, RawObject> {
  const raw = getTable('DT_CropData');
  const crops: Record<string, RawObject> = {};
  for (const [id, row] of Object.entries(raw)) {
    const c = deepClean(row) as RawObject;
    const colRow = c['ColRow'] as RawObject | undefined;
    const spacing = c['Spacing'] as RawObject | undefined;
    crops[id] = {
      id,
      seedItemId: id,
      cropId: c['ID'] ?? 0,
      growthTimeDays: c['GrowthTimeDays'] ?? 0,
      growSeasons: (c['GrowSeasons'] as RawArray) || [],
      gridColumns: (colRow?.['x'] as number) ?? 1,
      gridRows: (colRow?.['y'] as number) ?? 1,
      spacingX: (spacing?.['x'] as number) ?? 0,
      spacingY: (spacing?.['y'] as number) ?? 0,
      stageCount: Array.isArray(c['Stages']) ? c['Stages'].length : 0,
      harvestResult: c['HarvestResult'] || '',
      harvestCount: c['Count'] ?? 0,
    };
  }
  return crops;
}

// ═══════════════════════════════════════════════════════════════════════════
//  VEHICLES — DT_VehicleSpawn (27 entries)
// ═══════════════════════════════════════════════════════════════════════════

function extractVehicles(): Record<string, RawObject> {
  const raw = getTable('DT_VehicleSpawn');
  const vehicles: Record<string, RawObject> = {};
  for (const [id, row] of Object.entries(raw)) {
    const c = cleanRow(row);
    vehicles[id] = {
      id,
      name: c['VehicleName'] || id,
    };
  }
  return vehicles;
}

// ═══════════════════════════════════════════════════════════════════════════
//  CAR UPGRADES — DT_CarUpgrades (23 entries)
// ═══════════════════════════════════════════════════════════════════════════

function extractCarUpgrades(): Record<string, RawObject> {
  const raw = getTable('DT_CarUpgrades');
  const upgrades: Record<string, RawObject> = {};
  for (const [id, row] of Object.entries(raw)) {
    const c = deepClean(row) as RawObject;

    const craftCost: RawObject[] = [];
    if (Array.isArray(c['CraftCost'])) {
      for (const cost of c['CraftCost']) {
        const co = cost as RawObject;
        craftCost.push({
          type: resolveEnum(co['ResourceType']),
          amount: co['Amount'] ?? 0,
        });
      }
    }

    upgrades[id] = {
      id,
      type: resolveEnum(c['Type']),
      typeRaw: c['Type'] || '',
      level: c['Level'] ?? 0,
      socket: c['Socket'] || '',
      toolDurabilityLost: c['ToolInHandDurLost'] ?? 0,
      craftTimeMinutes: c['CraftTimeMinutes'] ?? 0,
      health: c['Health'] ?? 0,
      craftCost,
    };
  }
  return upgrades;
}

// ═══════════════════════════════════════════════════════════════════════════
//  AMMO DAMAGE — DT_AmmoDamage
// ═══════════════════════════════════════════════════════════════════════════

function extractAmmoDamage(): Record<string, RawObject> {
  const raw = getTable('DT_AmmoDamage');
  const ammo: Record<string, RawObject> = {};
  for (const [id, row] of Object.entries(raw)) {
    const c = cleanRow(row);
    ammo[id] = {
      id,
      damage: c['DamageValue'] ?? 0,
      headshotMultiplier: c['HeadshotMultiplier'] ?? 1,
      range: c['Range'] ?? 0,
      penetration: c['Penetration'] ?? 0,
    };
  }
  return ammo;
}

// ═══════════════════════════════════════════════════════════════════════════
//  REPAIR — DT_RepairData
// ═══════════════════════════════════════════════════════════════════════════

function extractRepairData(): Record<string, RawObject> {
  const raw = getTable('DT_RepairData');
  const repairs: Record<string, RawObject> = {};
  for (const [id, row] of Object.entries(raw)) {
    const c = deepClean(row) as RawObject;

    const extraResources: RawObject[] = [];
    if (Array.isArray(c['Extra'])) {
      for (const ex of c['Extra']) {
        const e = ex as RawObject;
        extraResources.push({
          type: resolveEnum(e['ResourceType']),
          amount: e['Amount'] ?? 0,
        });
      }
    }

    repairs[id] = {
      id,
      buildingId: id,
      resourceType: resolveEnum(c['Resource']),
      resourceTypeRaw: c['Resource'] || '',
      amount: c['Amount'] ?? 0,
      healthToAdd: c['HealthToAdd'] ?? 0,
      isRepairable: c['IsRepairable'] ?? true,
      extraResources,
    };
  }
  return repairs;
}

// ═══════════════════════════════════════════════════════════════════════════
//  FURNITURE DROPS — DT_FurnitureDamage (21 entries)
// ═══════════════════════════════════════════════════════════════════════════

function extractFurniture(): Record<string, RawObject> {
  const raw = getTable('DT_FurnitureDamage');
  const furniture: Record<string, RawObject> = {};
  for (const [id, row] of Object.entries(raw)) {
    const c = deepClean(row) as RawObject;

    const dropResources: RawObject[] = [];
    if (Array.isArray(c['DropResources'])) {
      for (const dr of c['DropResources']) {
        const d = dr as RawObject;
        dropResources.push({
          itemId: (d['ItemID'] as string) || '',
          min: d['Min'] ?? 0,
          max: d['Max'] ?? 0,
        });
      }
    }

    furniture[id] = {
      id,
      name: id,
      meshCount: Array.isArray(c['Meshes']) ? c['Meshes'].length : 0,
      dropResources,
    };
  }
  return furniture;
}

// ═══════════════════════════════════════════════════════════════════════════
//  TRAPS — DT_TrapSettings
// ═══════════════════════════════════════════════════════════════════════════

function extractTraps(): Record<string, RawObject> {
  const raw = getTable('DT_TrapSettings');
  const traps: Record<string, RawObject> = {};
  for (const [id, row] of Object.entries(raw)) {
    const c = deepClean(row) as RawObject;
    const itemRef = c['RawObjecterence'] as RawObject | undefined;
    const reqAmmo = c['RequiredAmmo'] as RawObject | undefined;

    traps[id] = {
      id,
      itemId: (itemRef?.['RowName'] as string) || '',
      requiresWeapon: c['RequiresWeapon'] ?? false,
      requiresAmmo: c['RequiresAmmo'] ?? false,
      requiresItems: c['RequiresItems'] ?? false,
      requiredAmmoId: (reqAmmo?.['RowName'] as string) || '',
      compatibleItemCount: Array.isArray(c['CompatibleItems']) ? c['CompatibleItems'].length : 0,
    };
  }
  return traps;
}

// ═══════════════════════════════════════════════════════════════════════════
//  ANIMALS — Animal_DT (6 entries)
// ═══════════════════════════════════════════════════════════════════════════

function extractAnimals(): Record<string, RawObject> {
  const raw = getTable('Animal_DT');
  const animals: Record<string, RawObject> = {};
  for (const [id, row] of Object.entries(raw)) {
    const c = cleanRow(row);
    animals[id] = {
      id,
      name: id,
      type: resolveEnum(c['AnimalType']),
      hideItemId: c['HideNameFromItemDT'] || '',
    };
  }
  return animals;
}

// ═══════════════════════════════════════════════════════════════════════════
//  XP — DT_XpData
// ═══════════════════════════════════════════════════════════════════════════

function extractXpData(): RawObject[] {
  const raw = getTable('DT_XpData');
  const xp: RawObject[] = [];
  for (const [id, row] of Object.entries(raw)) {
    const c = cleanRow(row);
    xp.push({
      id,
      category: c['XpCategory'] || '',
      gainMultiplier: c['XpGainMultiplier'] ?? 1,
    });
  }
  return xp;
}

// ═══════════════════════════════════════════════════════════════════════════
//  SPAWN LOCATIONS — DT_SpawnLocation
// ═══════════════════════════════════════════════════════════════════════════

function extractSpawnLocations(): Record<string, RawObject> {
  const raw = getTable('DT_SpawnLocation');
  const locs: Record<string, RawObject> = {};
  for (const [id, row] of Object.entries(raw)) {
    const c = cleanRow(row);
    locs[id] = {
      id,
      name: c['Name'] || id,
      description: c['Description'] || '',
      map: c['Map'] || '',
    };
  }
  return locs;
}

// ═══════════════════════════════════════════════════════════════════════════
//  LORE — DT_LoreData
// ═══════════════════════════════════════════════════════════════════════════

function extractLore(): Record<string, RawObject> {
  const raw = getTable('DT_LoreData');
  const lore: Record<string, RawObject> = {};
  for (const [id, row] of Object.entries(raw)) {
    const c = deepClean(row) as RawObject;
    lore[id] = {
      id,
      title: c['Title'] || id,
      text: c['Text'] || c['LoreText'] || '',
      category: c['Category'] || '',
      order: c['Order'] ?? 0,
    };
  }
  return lore;
}

// ═══════════════════════════════════════════════════════════════════════════
//  QUESTS — DT_MiniQuest
// ═══════════════════════════════════════════════════════════════════════════

function extractQuests(): Record<string, RawObject> {
  const raw = getTable('DT_MiniQuest');
  const quests: Record<string, RawObject> = {};
  for (const [id, row] of Object.entries(raw)) {
    const c = deepClean(row) as RawObject;

    const requirements: RawObject[] = [];
    if (Array.isArray(c['RequiredStuff'])) {
      for (const req of c['RequiredStuff']) {
        const r = req as RawObject;
        const item = r['Item'] as RawObject | undefined;
        requirements.push({
          type: resolveEnum(r['Required']),
          itemId: (item?.['RowName'] as string) || '',
          amount: r['Amount'] ?? 0,
        });
      }
    }

    const rewards: RawObject[] = [];
    if (Array.isArray(c['Rewards'])) {
      for (const rew of c['Rewards']) {
        const parsed = parseRawObject(rew);
        if (parsed && parsed.itemId && parsed.itemId !== 'None' && parsed.itemId !== 'Empty') {
          rewards.push(parsed);
        }
      }
    }

    quests[id] = {
      id,
      name: c['QuestName'] || c['Name'] || id,
      description: c['QuestDescription'] || c['Description'] || '',
      xpReward: c['XPReward'] ?? 0,
      requirements,
      rewards,
    };
  }
  return quests;
}

// ═══════════════════════════════════════════════════════════════════════════
//  AFFLICTIONS — DT_Affliction
// ═══════════════════════════════════════════════════════════════════════════

function extractAfflictions(): Record<string, RawObject> {
  const raw = getTable('DT_Affliction');
  const afflictions: Record<string, RawObject> = {};
  for (const [id, row] of Object.entries(raw)) {
    const c = deepClean(row) as RawObject;
    afflictions[id] = {
      id,
      name: c['Name'] || id,
      description: c['Description'] || '',
      treatment: c['Treatment'] || '',
      duration: c['Duration'] ?? 0,
      damagePerTick: c['DamagePerTick'] ?? 0,
    };
  }
  return afflictions;
}

// ═══════════════════════════════════════════════════════════════════════════
//  LOADING TIPS — DT_LoadingTips
// ═══════════════════════════════════════════════════════════════════════════

function extractLoadingTips(): RawObject[] {
  const raw = getTable('DT_LoadingTips');
  const tips: RawObject[] = [];
  for (const [id, row] of Object.entries(raw)) {
    const c = cleanRow(row);
    tips.push({
      id,
      text: c['Tip'] || c['Text'] || '',
    });
  }
  return tips;
}

// ═══════════════════════════════════════════════════════════════════════════
//  SPRAYS — DataTable_Sprays
// ═══════════════════════════════════════════════════════════════════════════

function extractSprays(): Record<string, RawObject> {
  const raw = getTable('DataTable_Sprays');
  const sprays: Record<string, RawObject> = {};
  for (const [id, row] of Object.entries(raw)) {
    const c = cleanRow(row);
    sprays[id] = {
      id,
      name: c['SprayName'] || id,
      description: c['Description'] || '',
      color: c['Color'] || '',
    };
  }
  return sprays;
}

// ═══════════════════════════════════════════════════════════════════════════
//  FOLIAGE — DT_FoliageData
// ═══════════════════════════════════════════════════════════════════════════

function extractFoliage(): Record<string, RawObject> {
  const raw = getTable('DT_FoliageData');
  const foliage: Record<string, RawObject> = {};
  for (const [id, row] of Object.entries(raw)) {
    const c = deepClean(row) as RawObject;

    const drops: RawObject[] = [];
    if (Array.isArray(c['Drops'])) {
      for (const drop of c['Drops']) {
        const d = drop as RawObject;
        drops.push({
          itemId: (d['ItemID'] as string) || ((d['Item'] as RawObject)?.['RowName'] as string) || '',
          chance: d['Chance'] ?? d['ChancePercentage'] ?? 100,
          min: d['Min'] ?? 1,
          max: d['Max'] ?? 1,
        });
      }
    }

    foliage[id] = {
      id,
      name: id,
      health: c['Health'] ?? 0,
      canChop: c['CanChop'] ?? false,
      canMine: c['CanMine'] ?? false,
      drops,
    };
  }
  return foliage;
}

// ═══════════════════════════════════════════════════════════════════════════
//  CHARACTER CREATOR — DT_CharacterCreator
// ═══════════════════════════════════════════════════════════════════════════

function extractCharacterCreator(): Record<string, RawObject> {
  const raw = getTable('DT_CharacterCreator');
  const chars: Record<string, RawObject> = {};
  for (const [id, row] of Object.entries(raw)) {
    const c = deepClean(row) as RawObject;
    chars[id] = {
      id,
      name: c['Name'] || id,
      isMale: c['IsMale?'] ?? true,
    };
  }
  return chars;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Convenience: name lookups
// ═══════════════════════════════════════════════════════════════════════════

function buildItemNames(items: Record<string, RawObject>): Record<string, string> {
  const map: Record<string, string> = {};
  for (const [id, item] of Object.entries(items)) {
    map[id] = item['name'] as string;
  }
  return map;
}

function buildBuildingNames(buildings: Record<string, RawObject>): Record<string, string> {
  const map: Record<string, string> = {};
  for (const [id, b] of Object.entries(buildings)) {
    map[id] = b['name'] as string;
  }
  return map;
}

function buildVehicleNames(vehicles: Record<string, RawObject>): Record<string, string> {
  const map: Record<string, string> = {};
  for (const [id, v] of Object.entries(vehicles)) {
    map[id] = (v['name'] as string) || id;
  }
  return map;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Lazy-cached extraction — each table extracted once on first access
// ═══════════════════════════════════════════════════════════════════════════

const _cache: Record<string, unknown> = {};

function cached<T>(key: string, fn: () => T): T {
  if (!(key in _cache)) _cache[key] = fn();
  return _cache[key] as T;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Exports — use Object.defineProperty for lazy getters
// ═══════════════════════════════════════════════════════════════════════════

// Direct exports (non-lazy)
export {
  cleanKey,
  cleanRow,
  deepClean,
  resolveEnum,
  ENUM_MAPS,
  getTable,
  getTableCleaned,
  getITEMS,
  getITEM_NAMES,
  getLOOT_TABLES,
  getBUILDINGS,
  getBUILDING_NAMES,
  getRECIPES,
  getSKILLS,
  getPROFESSIONS,
  getSTATISTICS,
  getSTAT_CONFIG,
  getCROPS,
  getVEHICLES,
  getVEHICLE_NAMES,
  getCAR_UPGRADES,
  getAMMO_DAMAGE,
  getREPAIR_DATA,
  getFURNITURE,
  getTRAPS,
  getANIMALS,
  getXP_DATA,
  getSPAWN_LOCATIONS,
  getLORE,
  getQUESTS,
  getAFFLICTIONS,
  getLOADING_TIPS,
  getSPRAYS,
  getFOLIAGE,
  getCHARACTERS,
  getTABLE_SUMMARY,
};

// Lazy getters need to go through the module.exports CJS compat layer.
// For TS ESM consumers, provide accessor functions.
function getITEMS(): Record<string, RawObject> {
  return cached('items', extractItems);
}
function getITEM_NAMES(): Record<string, string> {
  return cached('itemNames', () => buildItemNames(getITEMS()));
}
function getLOOT_TABLES(): Record<string, RawObject> {
  return cached('lootTables', extractLootTables);
}
function getBUILDINGS(): Record<string, RawObject> {
  return cached('buildings', extractBuildings);
}
function getBUILDING_NAMES(): Record<string, string> {
  return cached('buildingNames', () => buildBuildingNames(getBUILDINGS()));
}
function getRECIPES(): Record<string, RawObject> {
  return cached('recipes', extractRecipes);
}
function getSKILLS(): Record<string, RawObject> {
  return cached('skills', extractSkills);
}
function getPROFESSIONS(): Record<string, RawObject> {
  return cached('professions', extractProfessions);
}
function getSTATISTICS(): Record<string, RawObject> {
  return cached('statistics', extractStatistics);
}
function getSTAT_CONFIG(): Record<string, RawObject> {
  return cached('statConfig', extractStatConfig);
}
function getCROPS(): Record<string, RawObject> {
  return cached('crops', extractCrops);
}
function getVEHICLES(): Record<string, RawObject> {
  return cached('vehicles', extractVehicles);
}
function getVEHICLE_NAMES(): Record<string, string> {
  return cached('vehicleNames', () => buildVehicleNames(getVEHICLES()));
}
function getCAR_UPGRADES(): Record<string, RawObject> {
  return cached('carUpgrades', extractCarUpgrades);
}
function getAMMO_DAMAGE(): Record<string, RawObject> {
  return cached('ammoDamage', extractAmmoDamage);
}
function getREPAIR_DATA(): Record<string, RawObject> {
  return cached('repairData', extractRepairData);
}
function getFURNITURE(): Record<string, RawObject> {
  return cached('furniture', extractFurniture);
}
function getTRAPS(): Record<string, RawObject> {
  return cached('traps', extractTraps);
}
function getANIMALS(): Record<string, RawObject> {
  return cached('animals', extractAnimals);
}
function getXP_DATA(): RawObject[] {
  return cached('xpData', extractXpData);
}
function getSPAWN_LOCATIONS(): Record<string, RawObject> {
  return cached('spawnLocations', extractSpawnLocations);
}
function getLORE(): Record<string, RawObject> {
  return cached('lore', extractLore);
}
function getQUESTS(): Record<string, RawObject> {
  return cached('quests', extractQuests);
}
function getAFFLICTIONS(): Record<string, RawObject> {
  return cached('afflictions', extractAfflictions);
}
function getLOADING_TIPS(): RawObject[] {
  return cached('loadingTips', extractLoadingTips);
}
function getSPRAYS(): Record<string, RawObject> {
  return cached('sprays', extractSprays);
}
function getFOLIAGE(): Record<string, RawObject> {
  return cached('foliage', extractFoliage);
}
function getCHARACTERS(): Record<string, RawObject> {
  return cached('characters', extractCharacterCreator);
}
function getTABLE_SUMMARY(): Record<string, number> {
  return cached('summary', () => {
    const s: Record<string, number> = {};
    for (const [name, table] of Object.entries(RAW)) {
      s[name] = table.rowCount ?? Object.keys(table.rows ?? {}).length;
    }
    return s;
  });
}

// CJS compatibility — .js consumers use require('./game-data-extract')
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _mod = module as { exports: any };

_mod.exports = {
  cleanKey,
  cleanRow,
  deepClean,
  resolveEnum,
  ENUM_MAPS,
  getTable,
  getTableCleaned,
  _test: { _projectEnum },
};

// Lazy-loaded game data (extracted on first access)
Object.defineProperty(_mod.exports, 'ITEMS', { get: getITEMS, enumerable: true });
Object.defineProperty(_mod.exports, 'ITEM_NAMES', { get: getITEM_NAMES, enumerable: true });
Object.defineProperty(_mod.exports, 'LOOT_TABLES', { get: getLOOT_TABLES, enumerable: true });
Object.defineProperty(_mod.exports, 'BUILDINGS', { get: getBUILDINGS, enumerable: true });
Object.defineProperty(_mod.exports, 'BUILDING_NAMES', { get: getBUILDING_NAMES, enumerable: true });
Object.defineProperty(_mod.exports, 'RECIPES', { get: getRECIPES, enumerable: true });
Object.defineProperty(_mod.exports, 'SKILLS', { get: getSKILLS, enumerable: true });
Object.defineProperty(_mod.exports, 'PROFESSIONS', { get: getPROFESSIONS, enumerable: true });
Object.defineProperty(_mod.exports, 'STATISTICS', { get: getSTATISTICS, enumerable: true });
Object.defineProperty(_mod.exports, 'STAT_CONFIG', { get: getSTAT_CONFIG, enumerable: true });
Object.defineProperty(_mod.exports, 'CROPS', { get: getCROPS, enumerable: true });
Object.defineProperty(_mod.exports, 'VEHICLES', { get: getVEHICLES, enumerable: true });
Object.defineProperty(_mod.exports, 'VEHICLE_NAMES', { get: getVEHICLE_NAMES, enumerable: true });
Object.defineProperty(_mod.exports, 'CAR_UPGRADES', { get: getCAR_UPGRADES, enumerable: true });
Object.defineProperty(_mod.exports, 'AMMO_DAMAGE', { get: getAMMO_DAMAGE, enumerable: true });
Object.defineProperty(_mod.exports, 'REPAIR_DATA', { get: getREPAIR_DATA, enumerable: true });
Object.defineProperty(_mod.exports, 'FURNITURE', { get: getFURNITURE, enumerable: true });
Object.defineProperty(_mod.exports, 'TRAPS', { get: getTRAPS, enumerable: true });
Object.defineProperty(_mod.exports, 'ANIMALS', { get: getANIMALS, enumerable: true });
Object.defineProperty(_mod.exports, 'XP_DATA', { get: getXP_DATA, enumerable: true });
Object.defineProperty(_mod.exports, 'SPAWN_LOCATIONS', { get: getSPAWN_LOCATIONS, enumerable: true });
Object.defineProperty(_mod.exports, 'LORE', { get: getLORE, enumerable: true });
Object.defineProperty(_mod.exports, 'QUESTS', { get: getQUESTS, enumerable: true });
Object.defineProperty(_mod.exports, 'AFFLICTIONS', { get: getAFFLICTIONS, enumerable: true });
Object.defineProperty(_mod.exports, 'LOADING_TIPS', { get: getLOADING_TIPS, enumerable: true });
Object.defineProperty(_mod.exports, 'SPRAYS', { get: getSPRAYS, enumerable: true });
Object.defineProperty(_mod.exports, 'FOLIAGE', { get: getFOLIAGE, enumerable: true });
Object.defineProperty(_mod.exports, 'CHARACTERS', { get: getCHARACTERS, enumerable: true });
Object.defineProperty(_mod.exports, 'TABLE_SUMMARY', { get: getTABLE_SUMMARY, enumerable: true });

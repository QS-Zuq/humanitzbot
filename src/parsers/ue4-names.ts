/**
 * Shared UE4 actor/blueprint name cleaning utilities.
 *
 * Raw UE4 names look like:
 *   "Door_GEN_VARIABLE_BP_LockedMetalShutter_C_CAT_2147206852"
 *   "ChildActor_GEN_VARIABLE_BP_VehicleStorage_C_CAT_2147253396"
 *   "Storage_GEN_VARIABLE_BP_WoodCrate_C_2147261242"
 *   "BuildContainer_147"
 *   "BP_WoodWall_C_12345"
 *   "/Game/BuildingSystem/Blueprints/Buildings/BP_WoodWall.BP_WoodWall_C"
 *
 * All converge to a single `cleanName()` function that produces human-readable
 * labels: "Locked Metal Shutter", "Vehicle Storage", "Wood Crate", "Wood Wall"
 *
 * @module ue4-names
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const gameData = require('./game-data') as {
  ITEM_NAMES: Record<string, string>;
  BUILDING_NAMES: Record<string, string>;
};

const { ITEM_NAMES, BUILDING_NAMES } = gameData;

// ─── Common container aliases ────────────────────────────────────────────────
// These fire first to catch well-known patterns before generic cleanup.
const CONTAINER_ALIASES: Array<[RegExp, string]> = [
  [/ContainerEnemyAI_Pistol/i, 'Zombie Drop (Pistol)'],
  [/ContainerEnemyAI/i, 'Zombie Drop'],
  [/WeaponStash/i, 'Weapon Stash'],
  [/VehicleStorage/i, 'Vehicle Storage'],
  [/CupboardContainer/i, 'Cupboard'],
  [/StorageContainer/i, 'Storage Container'],
  [/Fridge/i, 'Fridge'],
  [/^Barrel$/i, 'Barrel'],
  [/GunLocker/i, 'Gun Locker'],
  [/WoodCrate/i, 'Wood Crate'],
  [/MetalCrate/i, 'Metal Crate'],
  [/^BuildContainer(?:_\d+)?$/i, 'Container'],
];

// ─── NPC/AI name aliases ──────────────────────────────────────────────────
// Post-cleanup names from damage sources that generic CamelCase splitting can't fix.
const NPC_ALIASES = new Map<string, string>([
  ['dogzombie', 'Dog Zombie'],
  ['zombiebear', 'Zombie Bear'],
  ['kaihuman', 'Bandit'],
  ['kai human', 'Bandit'],
  ['kai human melee', 'Bandit'],
  ['kai human ranged', 'Bandit'],
  ['bellytoxic', 'Bloater'],
  ['belly toxic', 'Bloater'],
  ['runnerbrute', 'Runner Brute'],
  ['giantbrute', 'Giant Brute'],
  ['giant brute', 'Giant Brute'],
  ['militaryarmoured', 'Military Armoured'],
  ['military armoured', 'Military Armoured'],
  ['police armor', 'Police Armoured'],
  ['policearmor', 'Police Armoured'],
  ['police1', 'Police Zombie'],
  ['police2', 'Police Zombie'],
]);

/**
 * Clean a raw UE4 actor name, blueprint path, or item name into a readable label.
 */
function cleanName(raw: unknown): string {
  if (!raw) return 'Unknown';
  const rawStr = typeof raw === 'string' ? raw : String(raw as number);
  let name = rawStr;

  // Strip trailing UE4 pawn metadata: "(25m) Weapon()" suffix
  name = name.replace(/\(\d+m\)\s*Weapon\(\)\s*$/, '').trim();

  // BuildContainer → Container (catch early before CamelCase-only path)
  if (/^BuildContainer(?:_\d+)?$/i.test(name)) return 'Container';

  // Space-separated UE4 pawn names: "Pawn Zombie Runner C 2147019193"
  const pawnMatch = name.match(/^Pawn\s+(.+?)\s+C\s+\d+/i);
  if (pawnMatch) {
    const pawnInner = pawnMatch[1]?.trim() ?? '';
    const stripped: string = pawnInner.replace(/^Zombie\s+/i, '');
    name = stripped || pawnInner;
    if (/[a-z][A-Z]/.test(name)) {
      return name.replace(/([a-z])([A-Z])/g, '$1 $2').trim();
    }
    return name;
  }

  // Already clean (no underscores, no BP_ prefix, has spaces) — return as-is
  if (!name.includes('_') && !name.startsWith('BP_')) {
    const buildingName = BUILDING_NAMES[name];
    if (buildingName) return buildingName;

    if (/[a-z][A-Z]/.test(name)) {
      return name.replace(/([a-z])([A-Z])/g, '$1 $2').trim();
    }
    return name;
  }

  // Full blueprint path: /Game/.../BP_WoodWall.BP_WoodWall_C
  const pathMatch = name.match(/BP_([^.]+?)(?:_C)?$/);
  if (name.includes('/') && pathMatch) {
    name = pathMatch[1] as string;
  } else {
    name = name.replace(/_C_(?:CAT_)?\d+$/, '');
    name = name.replace(/_C_\d+$/, '');
    name = name.replace(/_C$/, '');
  }

  // Strip GEN_VARIABLE noise
  name = name.replace(/^.*?_GEN_VARIABLE_(?:BP_)?/, '');

  // Strip leading prefixes that survived
  name = name.replace(/^(?:ChildActor|Storage|Door|Window|Lamp|Light|Prop|Deco)_/i, '');
  name = name.replace(/^BP_/, '');

  // Strip PawnZombie / Pawn prefix
  name = name.replace(/^Pawn(?:Zombie\d*)?_?/i, '');
  if (!name) return 'Zombie';

  // BuildContainer_NNN → Container
  if (/^BuildContainer(?:_\d+)?$/i.test(name)) return 'Container';

  // Strip trailing numeric ID: _12345
  name = name.replace(/_\d+$/, '');

  // Check BUILDING_NAMES for authoritative display name
  const buildingDisplayName = BUILDING_NAMES[name];
  if (buildingDisplayName) return buildingDisplayName;

  // Check container aliases on the cleaned intermediate
  for (const [pattern, alias] of CONTAINER_ALIASES) {
    if (pattern.test(name)) return alias;
  }

  // Underscores → spaces
  name = name.replace(/_/g, ' ');

  // CamelCase → spaced
  name = name.replace(/([a-z])([A-Z])/g, '$1 $2');

  // Collapse multiple spaces
  name = name.replace(/\s{2,}/g, ' ').trim();

  // Check NPC aliases
  const npcAlias = NPC_ALIASES.get(name.toLowerCase());
  if (npcAlias) return npcAlias;

  return name || rawStr;
}

// ─── Manual item name aliases ────────────────────────────────────────────────
const ITEM_ALIASES = new Map<string, string>([
  // Weapons & ammo
  ['tacticalmachette', 'Tactical Machete'],
  ['tacticalmachete', 'Tactical Machete'],
  ['22ammo', '.22 Ammo'],
  ['9mmammo', '9mm Ammo'],
  ['45ammo', '.45 Ammo'],
  ['shotgunammo', 'Shotgun Ammo'],
  ['rifleammo', 'Rifle Ammo'],
  ['357', '.357 Revolver'],
  ['improaxe', 'Improvised Axe'],
  ['improarrow', 'Improvised Arrow'],
  ['improdrill', 'Improvised Drill'],
  ['improhammer', 'Improvised Hammer'],
  ['impromace', 'Improvised Mace'],
  ['improknife', 'Improvised Knife'],
  ['improbat', 'Improvised Bat'],
  ['improbow', 'Improvised Bow'],
  ['improsword', 'Improvised Sword'],
  ['impro backpack', 'Improvised Backpack'],
  ['drillkit', 'Drill Kit'],
  ['lockpick', 'Lock Pick'],
  ['binos', 'Binoculars'],
  ['binocs', 'Binoculars'],

  // Attachments
  ['att_mag_extended', 'Extended Magazine'],
  ['att_mag_extended_uzi', 'Extended Mag (Uzi)'],
  ['att_mag_extended_ak', 'Extended Mag (AK)'],
  ['att_mag_extended_ar', 'Extended Mag (AR)'],
  ['att_mag_drum', 'Drum Magazine'],
  ['att_scope_2x', '2x Scope'],
  ['att_scope_4x', '4x Scope'],
  ['att_scope_8x', '8x Scope'],
  ['att_scope_red_dot', 'Red Dot Sight'],
  ['att_scope_holo', 'Holographic Sight'],
  ['att_suppressor', 'Suppressor'],
  ['att_flashlight', 'Flashlight Attachment'],
  ['att_laser', 'Laser Sight'],
  ['att_grip', 'Foregrip'],

  // Food & drink
  ['energy drink', 'Energy Drink'],
  ['energy drink2', 'Energy Drink'],
  ['energydrink', 'Energy Drink'],
  ['energydrink2', 'Energy Drink'],
  ['porkn beans', 'Pork & Beans'],
  ['porknbeans', 'Pork & Beans'],
  ['pork n beans', 'Pork & Beans'],
  ['dogfood', 'Dog Food'],
  ['dog food', 'Dog Food'],
  ['catfood', 'Cat Food'],
  ['water tabs', 'Water Purification Tablets'],
  ['watertabs', 'Water Purification Tablets'],

  // Medical
  ['med kit', 'Medical Kit'],
  ['medkit', 'Medical Kit'],
  ['repair kit', 'Repair Kit'],
  ['repairkit', 'Repair Kit'],
  ['first aid', 'First Aid Kit'],
  ['firstaid', 'First Aid Kit'],

  // Clothing
  ['police vest', 'Police Vest'],
  ['policevest', 'Police Vest'],

  // Tools & misc
  ['pocket watch', 'Pocket Watch'],
  ['pocketwatch', 'Pocket Watch'],
  ['stone knife', 'Stone Knife'],
  ['stoneknife', 'Stone Knife'],
  ['cb radio', 'CB Radio'],
  ['cbradio', 'CB Radio'],
]);

/**
 * Clean a raw item name from save data.
 */
function cleanItemName(raw: unknown): string {
  if (!raw) return 'Unknown';
  const rawStr = typeof raw === 'string' ? raw : String(raw as number);
  let name = rawStr;

  // Full path: strip to last segment
  if (name.includes('/')) {
    const seg = name.split('/').pop() ?? name;
    name = seg.replace(/\.[^.]+$/, '');
  }

  // Strip BP_ prefix and _C suffix
  name = name.replace(/^BP_/, '').replace(/_C$/, '');

  // Strip trailing numeric instance IDs: _12345 (5+ digits)
  name = name.replace(/_\d{5,}$/, '');

  // Check authoritative ITEM_NAMES from game data (718 items)
  const itemDisplayName = ITEM_NAMES[name];
  if (itemDisplayName) return itemDisplayName;

  // Check alias map (case-insensitive)
  const aliasKey = name.toLowerCase().trim();
  const aliasResult = ITEM_ALIASES.get(aliasKey);
  if (aliasResult) return aliasResult;

  // Underscores → spaces
  name = name.replace(/_/g, ' ');

  // Check alias again after underscore removal
  const aliasKey2 = name.toLowerCase().trim();
  const aliasResult2 = ITEM_ALIASES.get(aliasKey2);
  if (aliasResult2) return aliasResult2;

  // Expand "Lv" abbreviation: "SwordLv3" → "Sword Lvl 3"
  name = name.replace(/Lv(\d)/g, 'Lvl $1');

  // Strip trailing digit-only duplicate markers stuck to words
  name = name.replace(/([a-zA-Z])(\d)$/, '$1');

  // CamelCase → spaced
  name = name.replace(/([a-z])([A-Z])/g, '$1 $2');

  // Consecutive uppercase then lowercase: "ABCDef" → "ABC Def"
  name = name.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');

  // Title case
  name = name.replace(/\b([a-z])/g, (_, c: string) => c.toUpperCase());

  // Collapse multiple spaces
  name = name.replace(/\s{2,}/g, ' ').trim();

  return name || rawStr;
}

/**
 * Test whether a string is a hex GUID (used for unique item IDs).
 */
function isHexGuid(str: string): boolean {
  if (!str || typeof str !== 'string') return false;
  return /^[0-9a-f]{24,}$/i.test(str.trim());
}

interface ItemObject {
  item?: string;
  name?: string;
  [key: string]: unknown;
}

/**
 * Clean an array of items, removing hex GUIDs and cleaning names.
 */
function cleanItemArray(items: unknown[]): unknown[] {
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => {
      if (typeof item === 'string') {
        if (isHexGuid(item)) return null;
        return cleanItemName(item);
      }
      if (item && typeof item === 'object') {
        const obj = item as ItemObject;
        const name = obj.item ?? obj.name ?? '';
        if (isHexGuid(name)) return null;
        return { ...obj, item: cleanItemName(name) };
      }
      return item;
    })
    .filter(Boolean);
}

export { cleanName, cleanItemName, cleanItemArray, isHexGuid, CONTAINER_ALIASES, ITEM_ALIASES };

// CJS compatibility — .js consumers use require('./ue4-names')
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _mod = module as { exports: any };

_mod.exports = { cleanName, cleanItemName, cleanItemArray, isHexGuid, CONTAINER_ALIASES, ITEM_ALIASES };

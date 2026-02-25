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

// ─── Common container aliases ────────────────────────────────────────────────
// These fire first to catch well-known patterns before generic cleanup.
const CONTAINER_ALIASES = [
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

/**
 * Clean a raw UE4 actor name, blueprint path, or item name into a readable label.
 *
 * Handles all known patterns:
 *   - Full blueprint paths:  /Game/.../BP_Name.BP_Name_C
 *   - Actor instances:       Door_GEN_VARIABLE_BP_LockedMetalShutter_C_CAT_2147206852
 *   - Storage actors:        ChildActor_GEN_VARIABLE_BP_VehicleStorage_C_2147253396
 *   - Build containers:      BuildContainer_147
 *   - Simple blueprints:     BP_WoodWall_C_12345
 *   - Already clean names:   "Wood Wall"
 *
 * @param {string} raw - The raw UE4 name
 * @returns {string} Human-readable label
 */
function cleanName(raw) {
  if (!raw) return 'Unknown';
  let name = String(raw);

  // BuildContainer → Container (catch early before CamelCase-only path)
  if (/^BuildContainer(?:_\d+)?$/i.test(name)) return 'Container';

  // Already clean (no underscores, no BP_ prefix, has spaces) — return as-is
  if (!name.includes('_') && !name.startsWith('BP_')) {
    // But still CamelCase-split: "LockedMetalShutter" → "Locked Metal Shutter"
    if (/[a-z][A-Z]/.test(name)) {
      return name.replace(/([a-z])([A-Z])/g, '$1 $2').trim();
    }
    return name;
  }

  // Full blueprint path: /Game/.../BP_WoodWall.BP_WoodWall_C
  const pathMatch = name.match(/BP_([^.]+?)(?:_C)?$/);
  if (name.includes('/') && pathMatch) {
    name = pathMatch[1];
  } else {
    // Strip trailing instance IDs:  _C_CAT_2147206852, _C_2147206852
    name = name.replace(/_C_(?:CAT_)?\d+$/, '');
    name = name.replace(/_C_\d+$/, '');
    // Strip trailing _C suffix
    name = name.replace(/_C$/, '');
  }

  // Strip GEN_VARIABLE noise (can appear after any prefix or standalone)
  // "Door_GEN_VARIABLE_BP_LockedMetalShutter" → "LockedMetalShutter"
  // "ChildActor_GEN_VARIABLE_BP_VehicleStorage" → "VehicleStorage"
  name = name.replace(/^.*?_GEN_VARIABLE_(?:BP_)?/, '');

  // Strip leading prefixes that survived
  name = name.replace(/^(?:ChildActor|Storage|Door|Window|Lamp|Light|Prop|Deco)_/i, '');
  name = name.replace(/^BP_/, '');

  // BuildContainer_NNN → Container
  if (/^BuildContainer(?:_\d+)?$/i.test(name)) return 'Container';

  // Strip trailing numeric ID: _12345
  name = name.replace(/_\d+$/, '');

  // Check container aliases on the cleaned intermediate
  for (const [pattern, alias] of CONTAINER_ALIASES) {
    if (pattern.test(name)) return alias;
  }

  // Underscores → spaces
  name = name.replace(/_/g, ' ');

  // CamelCase → spaced: "LockedMetalShutter" → "Locked Metal Shutter"
  name = name.replace(/([a-z])([A-Z])/g, '$1 $2');

  // Collapse multiple spaces
  name = name.replace(/\s{2,}/g, ' ').trim();

  return name || raw;
}

// ─── Manual item name aliases ────────────────────────────────────────────────
// Catches known item names that generic cleanup can't fix.
// Keys are lowercase for case-insensitive matching.
const ITEM_ALIASES = new Map([
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
 * Handles all known patterns from UE4:
 *   - Blueprint paths: /Game/.../BP_ItemName.BP_ItemName_C
 *   - Blueprint names: BP_ItemName_C
 *   - Concatenated names: tacticalmachette, 22ammo, drillkit
 *   - Attachment names: Att_Mag_Extended_Uzi
 *   - Trailing duplicates: Energy Drink2, Item_3
 *   - Hex GUIDs: 92b0cc283720f24098060a59425d8394 (filtered)
 *
 * @param {string} raw - The raw item name
 * @returns {string} Human-readable item name
 */
function cleanItemName(raw) {
  if (!raw) return 'Unknown';
  let name = String(raw);

  // Full path: strip to last segment
  if (name.includes('/')) {
    const seg = name.split('/').pop() || name;
    name = seg.replace(/\.[^.]+$/, ''); // strip .ClassName extension
  }

  // Strip BP_ prefix and _C suffix
  name = name.replace(/^BP_/, '').replace(/_C$/, '');

  // Strip trailing numeric instance IDs: _12345 (5+ digits)
  name = name.replace(/_\d{5,}$/, '');

  // Check alias map (case-insensitive)
  const aliasKey = name.toLowerCase().trim();
  if (ITEM_ALIASES.has(aliasKey)) return ITEM_ALIASES.get(aliasKey);

  // Underscores → spaces
  name = name.replace(/_/g, ' ');

  // Check alias again after underscore removal
  const aliasKey2 = name.toLowerCase().trim();
  if (ITEM_ALIASES.has(aliasKey2)) return ITEM_ALIASES.get(aliasKey2);

  // Expand "Lv" abbreviation: "SwordLv3" → "Sword Lvl 3" (before trailing digit strip)
  name = name.replace(/Lv(\d)/g, 'Lvl $1');

  // Strip trailing digit-only duplicate markers stuck to words: "Energy Drink2" → "Energy Drink"
  // But NOT standalone numbers after spaces: "Lvl 3" stays "Lvl 3"
  name = name.replace(/([a-zA-Z])(\d)$/, '$1');

  // CamelCase → spaced: "TacticalMachette" → "Tactical Machette"
  name = name.replace(/([a-z])([A-Z])/g, '$1 $2');

  // Consecutive uppercase then lowercase: "ABCDef" → "ABC Def"
  name = name.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');

  // Title case: each word gets capitalised first letter
  name = name.replace(/\b([a-z])/g, (_, c) => c.toUpperCase());

  // Collapse multiple spaces
  name = name.replace(/\s{2,}/g, ' ').trim();

  return name || raw;
}

/**
 * Test whether a string is a hex GUID (used for unique item IDs).
 * These are internal tracking IDs, not meaningful to display.
 *
 * @param {string} str
 * @returns {boolean}
 */
function isHexGuid(str) {
  if (!str || typeof str !== 'string') return false;
  return /^[0-9a-f]{24,}$/i.test(str.trim());
}

/**
 * Clean an array of items, removing hex GUIDs and cleaning names.
 * @param {Array} items - Array of strings or objects with .item/.name
 * @returns {Array} Cleaned array with GUIDs removed
 */
function cleanItemArray(items) {
  if (!Array.isArray(items)) return [];
  return items
    .map(item => {
      if (typeof item === 'string') {
        if (isHexGuid(item)) return null;
        return cleanItemName(item);
      }
      if (item && typeof item === 'object') {
        const name = item.item || item.name || '';
        if (isHexGuid(name)) return null;
        return { ...item, item: cleanItemName(name) };
      }
      return item;
    })
    .filter(Boolean);
}

module.exports = { cleanName, cleanItemName, cleanItemArray, isHexGuid, CONTAINER_ALIASES, ITEM_ALIASES };

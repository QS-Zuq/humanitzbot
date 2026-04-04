/**
 * Game reference module — seeds all static game data into SQLite.
 *
 * Sources:
 *   - game-data-extract.ts (dynamic extraction from game-tables-raw.json)
 *   - game-data.ts (hand-curated data + re-exports from extract)
 *
 * Tables populated (schema v11):
 *   - game_items, game_professions, game_afflictions, game_skills,
 *     game_challenges, game_loading_tips, game_server_setting_defs,
 *     game_recipes, game_lore, game_quests, game_spawn_locations,
 *     game_buildings, game_loot_pools / game_loot_pool_items,
 *     game_vehicles_ref, game_animals, game_crops, game_car_upgrades,
 *     game_ammo_types, game_repair_data, game_furniture, game_traps, game_sprays
 */

import * as _gameData from './game-data.js';
import type { HumanitZDB } from '../db/database.js';

import { PERK_MAP as _PERK_MAP } from './save-parser.js';
const _saveParserModule = { PERK_MAP: _PERK_MAP };

const AFFLICTION_MAP = _gameData['AFFLICTION_MAP'];
const AFFLICTION_DETAILS = _gameData['AFFLICTION_DETAILS'] as Record<string, { name: string; description: string }>;
const PROFESSION_DETAILS = _gameData['PROFESSION_DETAILS'] as Record<
  string,
  { perk: string; description: string; affliction: string; unlockedSkills: string[] }
>;
const CHALLENGES = _gameData['CHALLENGES'] as Array<{
  id: string;
  name: string;
  description: string;
  progressMax: number;
}>;
const CHALLENGE_DESCRIPTIONS = _gameData['CHALLENGE_DESCRIPTIONS'] as Record<
  string,
  { name: string; desc?: string; target?: number }
>;
const LOADING_TIPS = _gameData['LOADING_TIPS'];
const SKILL_EFFECTS = _gameData['SKILL_EFFECTS'];
const SKILL_DETAILS = _gameData['SKILL_DETAILS'] as Record<
  string,
  { name: string; description: string; category?: string }
>;
const SERVER_SETTING_DESCRIPTIONS = _gameData['SERVER_SETTING_DESCRIPTIONS'];
const ITEM_DATABASE = _gameData['ITEM_DATABASE'];
const CRAFTING_RECIPES = _gameData['CRAFTING_RECIPES'];
const LORE_ENTRIES = _gameData['LORE_ENTRIES'];
const QUEST_DATA = _gameData['QUEST_DATA'];
const SPAWN_LOCATIONS = _gameData['SPAWN_LOCATIONS'];
const BUILDINGS = _gameData['BUILDINGS'];
const LOOT_TABLES = _gameData['LOOT_TABLES'];
const VEHICLES = _gameData['VEHICLES'] as Record<string, { name?: string }>;
const ANIMALS = _gameData['ANIMALS'];
const CROP_DATA = _gameData['CROP_DATA'];
const CAR_UPGRADES = _gameData['CAR_UPGRADES'];
const AMMO_DAMAGE = _gameData['AMMO_DAMAGE'];
const REPAIR_RECIPES = _gameData['REPAIR_RECIPES'];
const FURNITURE_DROPS = _gameData['FURNITURE_DROPS'];
const TRAPS = _gameData['TRAPS'];
const SPRAYS = _gameData['SPRAYS'];

// ─── Seed all game reference data ──────────────────────────────────────────

// Current version — bump this whenever ENUM_MAPS, extractors, or curated data change
const GAME_REF_VERSION = 2;

/**
 * Seed all game reference data into the database.
 * Safe to call multiple times — uses INSERT OR REPLACE.
 * Re-seeds automatically when GAME_REF_VERSION is bumped.
 */
function seed(db: HumanitZDB): void {
  // Check if re-seed is needed (version mismatch or empty)
  try {
    const count = db._db?.prepare('SELECT COUNT(*) as n FROM game_items').get() as { n: number } | undefined;
    const storedVersion = db._getMeta('game_ref_version');
    const currentVersion = String(GAME_REF_VERSION);

    if (count && count.n > 0 && storedVersion === currentVersion) {
      console.log(`[GameRef] Game reference data up to date (v${currentVersion}, ${String(count.n)} items) — skipping`);
      return;
    }

    if (count && count.n > 0 && storedVersion !== currentVersion) {
      console.log(
        `[GameRef] Game reference data outdated (v${storedVersion ?? '?'} → v${currentVersion}) — re-seeding...`,
      );
    }
  } catch {
    // Table doesn't exist yet — proceed with seeding
  }

  // Core reference tables
  seedItems(db);
  seedProfessions(db);
  seedAfflictions(db);
  seedSkills(db);
  seedChallenges(db);
  seedLoadingTipsData(db);
  seedServerSettingDefs(db);
  seedRecipes(db);
  seedLore(db);
  seedQuests(db);
  seedSpawnLocations(db);

  // New v11 reference tables
  seedBuildings(db);
  seedLootPools(db);
  seedVehiclesRef(db);
  seedAnimals(db);
  seedCrops(db);
  seedCarUpgrades(db);
  seedAmmoTypes(db);
  seedRepairData(db);
  seedFurniture(db);
  seedTraps(db);
  seedSpraysData(db);

  db._setMeta('game_ref_seeded', new Date().toISOString());
  db._setMeta('game_ref_version', String(GAME_REF_VERSION));
  console.log(`[GameRef] All game reference data seeded (v${String(GAME_REF_VERSION)}, 22 tables)`);
}

// ─── Items (game_items — 718 entries) ───────────────────────────────────────

function seedItems(db: HumanitZDB): void {
  const items = Object.values(ITEM_DATABASE);
  db.seedGameItems(items);
}

// ─── Professions ────────────────────────────────────────────────────────────

function seedProfessions(db: HumanitZDB): void {
  let PERK_MAP: Record<string, string>;
  try {
    PERK_MAP = _saveParserModule.PERK_MAP;
  } catch {
    PERK_MAP = {};
  }

  // Build enum_value → name reverse map
  const enumToName: Record<string, string> = {};
  for (const [enumVal, name] of Object.entries(PERK_MAP)) {
    enumToName[name] = enumVal;
  }

  const professions = Object.entries(PROFESSION_DETAILS).map(([name, info]) => ({
    id: name,
    enumValue: enumToName[name] ?? '',
    enumIndex: _enumIndex(enumToName[name]),
    perk: info.perk || '',
    description: info.description || '',
    affliction: info.affliction || '',
    skills: info.unlockedSkills,
  }));

  db.seedGameProfessions(professions);
}

function _enumIndex(enumValue: string | undefined): number {
  if (!enumValue) return 0;
  const m = enumValue.match(/(\d+)$/);
  return m?.[1] ? parseInt(m[1], 10) : 0;
}

// ─── Afflictions ────────────────────────────────────────────────────────────

function seedAfflictions(db: HumanitZDB): void {
  const detailsByName: Record<string, { description: string }> = {};
  for (const detail of Object.values(AFFLICTION_DETAILS)) {
    detailsByName[detail.name] = detail;
  }

  const afflictions = AFFLICTION_MAP.map((name, idx) => ({
    idx,
    name,
    description: detailsByName[name]?.description ?? '',
    icon: '',
  }));
  db.seedGameAfflictions(afflictions);
}

// ─── Skills ─────────────────────────────────────────────────────────────────

function seedSkills(db: HumanitZDB): void {
  const skills = Object.entries(SKILL_DETAILS).map(([id, detail]) => {
    const upperName = (detail.name || id).toUpperCase();
    const effect = SKILL_EFFECTS[upperName] ?? SKILL_EFFECTS[id] ?? '';
    return {
      id: id,
      name: detail.name || id,
      description: detail.description || '',
      effect,
      category: detail.category?.toLowerCase() || 'general',
      icon: '',
    };
  });
  db.seedGameSkills(skills);
}

// ─── Challenges ─────────────────────────────────────────────────────────────

function seedChallenges(db: HumanitZDB): void {
  const merged: Array<{ id: string; name: string; description: string; saveField: string; target: number }> = [];

  for (const ch of CHALLENGES) {
    merged.push({
      id: ch.id,
      name: ch.name,
      description: ch.description,
      saveField: '',
      target: ch.progressMax || 0,
    });
  }

  for (const [field, info] of Object.entries(CHALLENGE_DESCRIPTIONS)) {
    const existing = merged.find((m) => m.name === info.name);
    if (existing) {
      existing.saveField = field;
      if (info.target) existing.target = info.target;
      if (info.desc && !existing.description) existing.description = info.desc;
    } else {
      merged.push({
        id: field,
        name: info.name,
        description: info.desc ?? '',
        saveField: field,
        target: info.target ?? 0,
      });
    }
  }

  db.seedGameChallenges(merged);
}

// ─── Loading tips ───────────────────────────────────────────────────────────

function seedLoadingTipsData(db: HumanitZDB): void {
  const categorized = LOADING_TIPS.map((text) => {
    let category = 'general';
    if (/RMB|LMB|press|toggle|click|key|ctrl|shift|spacebar|hot key|button/i.test(text)) category = 'controls';
    else if (/health|thirst|hunger|stamina|infection|vital/i.test(text)) category = 'vitals';
    else if (/inventory|weapon|slot|backpack|carry/i.test(text)) category = 'inventory';
    else if (/fish|reel|tension|bait/i.test(text)) category = 'fishing';
    else if (/build|craft|station|structure|workbench/i.test(text)) category = 'crafting';
    else if (/vehicle|car|trunk|stall|horn|headlight/i.test(text)) category = 'vehicles';
    else if (/zeek|zombie|spawn/i.test(text)) category = 'combat';
    return { text, category };
  });
  db.seedLoadingTips(categorized);
}

// ─── Server setting definitions ─────────────────────────────────────────────

function seedServerSettingDefs(db: HumanitZDB): void {
  const settings = Object.entries(SERVER_SETTING_DESCRIPTIONS).map(([key, label]) => ({
    key,
    label,
    description: '',
    type: _inferSettingType(key),
    defaultVal: '',
    options: [] as string[],
  }));
  db.seedGameServerSettingDefs(settings);
}

function _inferSettingType(key: string): string {
  if (/enabled|fire|anywhere|position|drop/i.test(key)) return 'bool';
  if (/max|time|drain|multiplier|population|difficulty/i.test(key)) return 'float';
  if (/mode|level/i.test(key)) return 'enum';
  if (/name/i.test(key)) return 'string';
  return 'string';
}

// ─── Recipes (game_recipes — 154 entries) ───────────────────────────────────

function seedRecipes(db: HumanitZDB): void {
  const recipes = Object.values(CRAFTING_RECIPES);
  db.seedGameRecipes(recipes);
}

// ─── Lore (game_lore — 12 entries) ──────────────────────────────────────────

function seedLore(db: HumanitZDB): void {
  const lore = Object.values(LORE_ENTRIES);
  db.seedGameLore(lore);
}

// ─── Quests (game_quests — 18 entries) ──────────────────────────────────────

function seedQuests(db: HumanitZDB): void {
  const quests = Object.values(QUEST_DATA);
  db.seedGameQuests(quests);
}

// ─── Spawn locations (game_spawn_locations — 10 entries) ────────────────────

function seedSpawnLocations(db: HumanitZDB): void {
  const spawns = Object.values(SPAWN_LOCATIONS);
  db.seedGameSpawnLocations(spawns);
}

// ─── Buildings (game_buildings — 122 entries) ───────────────────────────────

function seedBuildings(db: HumanitZDB): void {
  const buildings = Object.values(BUILDINGS);
  db.seedGameBuildings(buildings);
}

// ─── Loot pools (game_loot_pools + game_loot_pool_items — 68 tables) ───────

function seedLootPools(db: HumanitZDB): void {
  db.seedGameLootPools(LOOT_TABLES);
}

// ─── Vehicles (game_vehicles_ref — 27 entries) ─────────────────────────────

function seedVehiclesRef(db: HumanitZDB): void {
  const vehicles = Object.entries(VEHICLES).map(([id, v]) => ({
    id,
    name: v.name ?? id,
  }));
  db.seedGameVehiclesRef(vehicles);
}

// ─── Animals (game_animals — 6 entries) ─────────────────────────────────────

function seedAnimals(db: HumanitZDB): void {
  const animals = Object.values(ANIMALS);
  db.seedGameAnimals(animals);
}

// ─── Crops (game_crops — 6 entries) ─────────────────────────────────────────

function seedCrops(db: HumanitZDB): void {
  const crops = Object.values(CROP_DATA);
  db.seedGameCrops(crops);
}

// ─── Car upgrades (game_car_upgrades — 23 entries) ──────────────────────────

function seedCarUpgrades(db: HumanitZDB): void {
  const upgrades = Object.values(CAR_UPGRADES);
  db.seedGameCarUpgrades(upgrades);
}

// ─── Ammo types (game_ammo_types — 8 entries) ───────────────────────────────

function seedAmmoTypes(db: HumanitZDB): void {
  const ammo = Object.values(AMMO_DAMAGE);
  db.seedGameAmmoTypes(ammo);
}

// ─── Repair data (game_repair_data — 57 entries) ────────────────────────────

function seedRepairData(db: HumanitZDB): void {
  const repairs = Object.values(REPAIR_RECIPES);
  db.seedGameRepairData(repairs);
}

// ─── Furniture (game_furniture — 21 entries) ─────────────────────────────────

function seedFurniture(db: HumanitZDB): void {
  const furniture = Object.values(FURNITURE_DROPS);
  db.seedGameFurniture(furniture);
}

// ─── Traps (game_traps — 6 entries) ─────────────────────────────────────────

function seedTraps(db: HumanitZDB): void {
  const traps = Object.values(TRAPS);
  db.seedGameTraps(traps);
}

// ─── Sprays (game_sprays — 8 entries) ───────────────────────────────────────

function seedSpraysData(db: HumanitZDB): void {
  const sprays = Object.values(SPRAYS);
  db.seedGameSprays(sprays);
}

export { seed };

/**
 * Game reference data for HumanitZ bot.
 *
 * Combines dynamically extracted data from game-data-extract.ts
 * (DT_ItemDatabase, DT_Buildings, DT_CraftingData, etc.) with
 * hand-curated sections that require human interpretation or
 * cannot be machine-extracted (AFFLICTION_MAP index order,
 * PROFESSION_DETAILS perks/skills, CHALLENGE_DESCRIPTIONS
 * save-field mapping, SKILL_EFFECTS text, SERVER_SETTING_DESCRIPTIONS).
 *
 * @module game-data
 */

import * as extract from './game-data-extract.js';

// ── Types ──────────────────────────────────────────────────────────────────

interface AfflictionDetail {
  name: string;
  description: string;
  value: number;
}

interface ProfessionDetail {
  perk: string;
  description: string;
  affliction: string;
  unlockedSkills: string[];
}

interface ChallengeDescription {
  name: string;
  desc?: string;
  target?: number;
}

interface StatDisplayEntry {
  name: string;
  completionValue: number;
  isSection: boolean;
}

interface ChallengeEntry {
  id: string;
  name: string;
  description: string;
  category: unknown;
  xp: number;
  skillPoint: number;
  guid: string;
  progressMax: number;
  source: string;
}

interface ExtractedStat {
  id: string;
  name: string;
  description: string;
  category: unknown;
  xp: number;
  skillPoint: number;
  guid: string;
  progressMax: number;
}

interface ExtractedTip {
  text: string;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Hand-curated data (cannot be derived from game-tables-raw.json)
// ═══════════════════════════════════════════════════════════════════════════

// ─── Afflictions ────────────────────────────────────────────────────────────

/**
 * Affliction index → display name.
 * Save file stores affliction as a numeric index; this array maps them.
 * ORDER MATTERS — do not sort or reorder.
 */
const AFFLICTION_MAP: string[] = [
  'No Affliction',
  'Random Affliction',
  'Carnivore',
  'Poor Circulation',
  'Gastro',
  'Night Terrors',
  'Vegetarian',
  'Heavy Feet',
  'ACL Injury',
  'Feeble',
  'Bad Back',
  'Never Full',
  'Z Magnet',
  'Shaky Hands',
  'Lingering Pain',
  'Alcoholic',
  'Tactless',
  'Fumble',
  'Wasteful',
  'Hemophiliac',
];

/** Full affliction details with descriptions (hand-curated). */
const AFFLICTION_DETAILS: Record<string, AfflictionDetail> = {
  NoAffliction: { name: 'No Affliction', description: 'You start the game with no affliction', value: 0 },
  Random: { name: 'Random Affliction', description: 'You start the game with a random affliction', value: 0 },
  Carnivore: { name: 'Carnivore', description: 'Only eats meat', value: 0 },
  PoorCirculation: { name: 'Poor Circulation', description: 'Get hypothermia from all cold weather', value: 1 },
  Gastro: { name: 'Gastro', description: 'Risk of sickness from eating stale food', value: 1 },
  NightTerrors: { name: 'Night Terrors', description: 'Unable to sleep at night', value: 1 },
  Veggie: { name: 'Vegetarian', description: 'Cannot eat meat products', value: 1 },
  HeavyFeet: {
    name: 'Heavy Feet',
    description: 'Increased noise while walking, jogging, and sprinting',
    value: 20,
  },
  ACL: { name: 'ACL Injury', description: 'Jogging and sprinting speed reduced by 20%', value: 20 },
  Feeble: { name: 'Feeble', description: 'Melee damage reduced by 25%', value: 25 },
  BadBack: { name: 'Bad Back', description: 'Carry weight reduced by 25%', value: 25 },
  NeverFull: { name: 'Never Full', description: '25% less stats from food and drink', value: 25 },
  ZMagnet: { name: 'Z Magnet', description: 'More susceptible to infection and cuts from zeeks', value: 30 },
  ShakyHands: { name: 'Shaky Hands', description: 'Reduced ranged weapon accuracy', value: 50 },
  LingeringPain: { name: 'Lingering Pain', description: 'Reduced effectiveness of healing items', value: 50 },
  Alcoholic: {
    name: 'Alcoholic',
    description: 'Needs alcohol on a regular basis or risk losing stamina',
    value: 50,
  },
  Tactless: {
    name: 'Tactless',
    description: 'Poor negotiation skills, and trades cost twice as much',
    value: 50,
  },
  Fumble: { name: 'Fumble', description: 'Reloading weapons takes longer', value: 50 },
  Wasteful: { name: 'Wasteful', description: 'Poor condition of crafted items', value: 50 },
  Hemophilia: { name: 'Hemophiliac', description: 'Rate of blood loss increased when bleeding', value: 50 },
};

// ─── Professions ────────────────────────────────────────────────────────────

const PROFESSION_DETAILS: Record<string, ProfessionDetail> = {
  Unemployed: {
    perk: '25% more experience gained',
    description:
      'Having no real skills or the motivation to hold down a job, you start your fight for survival with no useful skills or perks to aide you along the way.',
    affliction: 'No Affliction',
    unlockedSkills: [],
  },
  'Amateur Boxer': {
    perk: 'Fist fighting deals 300% unarmed damage',
    description: 'Years of boxing have hardened your fists and your spirit.',
    affliction: 'Random Affliction',
    unlockedSkills: ['WRESTLER', 'SPRINTER'],
  },
  Farmer: {
    perk: 'Fertilizer is more potent',
    description: 'Working the land has taught you patience and resourcefulness.',
    affliction: 'Random Affliction',
    unlockedSkills: ['BANDOLEER', 'CARPENTRY'],
  },
  Mechanic: {
    perk: '50% more effective with Repair Kits',
    description: 'Years of fixing cars and machinery has made you handy with tools.',
    affliction: 'Random Affliction',
    unlockedSkills: ['METAL WORKING', 'CALLUSED'],
  },
  'Car Salesman': {
    perk: '25% less NPC trading cost',
    description: 'Smooth talking comes naturally and people trust you.',
    affliction: 'Random Affliction',
    unlockedSkills: ['CHARISMA', 'HAGGLER'],
  },
  Outdoorsman: {
    perk: '10% less bow sway',
    description: 'Living off the land is second nature to you.',
    affliction: 'Random Affliction',
    unlockedSkills: ['VITAL SHOT', 'SPEED STEALTH'],
  },
  Chemist: {
    perk: 'Craft x2 treatments at chemistry station',
    description: 'A background in chemistry gives you an edge in crafting medicines.',
    affliction: 'Random Affliction',
    unlockedSkills: ['INFECTION TREATMENT', 'HEALTHY GUT'],
  },
  'Emergency Medical Technician': {
    perk: '25% better healing effectiveness',
    description: 'First responder training has prepared you for trauma situations.',
    affliction: 'Random Affliction',
    unlockedSkills: ['CALLUSED', 'REDEYE'],
  },
  'Military Veteran': {
    perk: '2x fatigue resistance',
    description: 'Military training has hardened your body and mind.',
    affliction: 'Random Affliction',
    unlockedSkills: ['RELOADER', 'MAG FLIP'],
  },
  Thief: {
    perk: 'No alarms triggered when stealing',
    description: 'A life of crime has taught you how to move silently.',
    affliction: 'Random Affliction',
    unlockedSkills: ['DEEP POCKETS', 'LIGHTFOOT'],
  },
  'Fire Fighter': {
    perk: 'No overheat from fire/heat',
    description: 'Braving fires has made you resistant to heat.',
    affliction: 'Random Affliction',
    unlockedSkills: ['BEAST OF BURDEN', 'CONTROLLED BREATHING'],
  },
  'Electrical Engineer': {
    perk: 'Unlock all powered structures',
    description: 'Your knowledge of electronics lets you build advanced machinery.',
    affliction: 'Random Affliction',
    unlockedSkills: ['HACKER', 'RING MY BELL'],
  },
};

// ─── Challenges ─────────────────────────────────────────────────────────────

const CHALLENGE_DESCRIPTIONS: Record<string, ChallengeDescription> = {
  challengeKillZombies: { name: 'Kill Zombies', desc: 'Kill some zombies to get started' },
  challengeKill50: { name: 'Exterminator', desc: 'Kill 50 zombies', target: 50 },
  challengeCatch20Fish: { name: 'Angler', desc: 'Catch 20 fish', target: 20 },
  challengeRegularAngler: { name: 'Regular Angler', desc: 'Keep fishing regularly' },
  challengeKillZombieBear: { name: 'Bear Hunter', desc: 'Kill a zombie bear' },
  challenge9Squares: { name: '9 Squares to Chaos', desc: 'Unknown challenge objective' },
  challengeCraftFirearm: { name: 'Gunsmith', desc: 'Craft a firearm' },
  challengeCraftFurnace: { name: 'Smelter', desc: 'Craft a furnace' },
  challengeCraftMeleeBench: { name: 'Melee Crafter', desc: 'Craft a melee workbench' },
  challengeCraftMeleeWeapon: { name: 'Bladesmith', desc: 'Craft a melee weapon' },
  challengeCraftRainCollector: { name: 'Water Collector', desc: 'Craft a rain collector' },
  challengeCraftTablesaw: { name: 'Woodworker', desc: 'Craft a tablesaw' },
  challengeCraftTreatment: { name: 'Medic', desc: 'Craft an infection treatment' },
  challengeCraftWeaponsBench: { name: 'Armourer', desc: 'Craft a weapons bench' },
  challengeCraftWorkbench: { name: 'Handyman', desc: 'Craft a workbench' },
  challengeFindDog: { name: 'Best Friend', desc: 'Find a canine companion' },
  challengeFindHeli: { name: 'Crash Site', desc: 'Find a crashed helicopter' },
  challengeLockpickSUV: { name: 'Grand Theft Auto', desc: 'Lockpick the Survivor SUV' },
  challengeRepairRadio: { name: 'Radio Operator', desc: 'Repair the radio tower' },
};

// ─── Skill effects (legacy text) ────────────────────────────────────────────

const SKILL_EFFECTS: Record<string, string> = {
  BANDOLEER: 'Carry more ammo',
  'BEAST OF BURDEN': 'Carry weight increased by 25%',
  CALLUSED: 'Melee damage reduced by 25%',
  CARPENTRY: 'Building speed increased',
  CHARISMA: 'Better NPC interactions',
  'CONTROLLED BREATHING': 'Steadier aim when aiming down sights',
  'DEEP POCKETS': 'Extra inventory slots',
  HACKER: 'Can hack electronic locks',
  HAGGLER: 'Better trade prices',
  'HEALTHY GUT': 'Food poisoning resistance',
  'INFECTION TREATMENT': 'Infection cure effectiveness up',
  LIGHTFOOT: 'Quieter movement',
  'MAG FLIP': 'Instant magazine swap',
  'METAL WORKING': 'Metal crafting improved',
  REDEYE: 'Reduced recoil',
  RELOADER: 'Faster reload speed',
  'RING MY BELL': 'Electronic traps more effective',
  'SPEED STEALTH': 'Move faster while crouching',
  SPRINTER: 'Sprint speed increased',
  'VITAL SHOT': 'Critical hit chance increased',
  WRESTLER: 'Grapple attack damage increased',
};

// ─── Server settings ────────────────────────────────────────────────────────

const SERVER_SETTING_DESCRIPTIONS: Record<string, string> = {
  ServerName: 'Server Name',
  MaxPlayers: 'Max Players',
  GameMode: 'Game Mode',
  DifficultyLevel: 'Difficulty',
  ZombiePopulation: 'Zombie Population',
  ZombieDifficulty: 'Zombie Difficulty',
  LootRespawnTime: 'Loot Respawn Time',
  DayNightCycle: 'Day/Night Cycle Speed',
  PvPEnabled: 'PvP Enabled',
  FriendlyFire: 'Friendly Fire',
  BuildAnywhere: 'Build Anywhere',
  DropItemsOnDeath: 'Drop Items On Death',
  ShowMapPlayerPosition: 'Show Player Position on Map',
  MaxStructures: 'Max Structures',
  VehicleRespawnTime: 'Vehicle Respawn Time',
  StaminaDrain: 'Stamina Drain Rate',
  HungerDrain: 'Hunger Drain Rate',
  ThirstDrain: 'Thirst Drain Rate',
  PlayerDamageMultiplier: 'Player Damage Multiplier',
  ZombieDamageMultiplier: 'Zombie Damage Multiplier',
  StructureDamageMultiplier: 'Structure Damage Multiplier',
  ResourceGatherMultiplier: 'Resource Gather Multiplier',
  XPMultiplier: 'XP Multiplier',
  CraftingSpeedMultiplier: 'Crafting Speed Multiplier',
};

// ─── Stat display names ─────────────────────────────────────────────────────

const STAT_DISPLAY_NAMES: Record<string, StatDisplayEntry> = {
  NewRow_0: { name: 'Blast Kills', completionValue: 50, isSection: true },
  NewRow_1: { name: 'Ranged Kills', completionValue: 50, isSection: true },
  NewRow_10: { name: 'Catch 20 Fish', completionValue: 20, isSection: false },
  NewRow_11: { name: 'Kill 50 Zeeks', completionValue: 50, isSection: false },
  NewRow_12: { name: '9 Squares to Chaos', completionValue: 3, isSection: false },
  NewRow_13: { name: 'Regular Angler', completionValue: 0, isSection: false },
  NewRow_14: { name: 'Kill Some Zeeks', completionValue: 50, isSection: false },
  NewRow_15: { name: 'Times Bitten', completionValue: 0, isSection: false },
  NewRow_16: { name: 'Craft a firearm', completionValue: 1, isSection: false },
  NewRow_17: { name: 'Craft a furnace', completionValue: 1, isSection: false },
  NewRow_18: { name: 'Craft a melee bench', completionValue: 1, isSection: false },
  NewRow_19: { name: 'Craft a melee weapon', completionValue: 1, isSection: false },
  NewRow_2: { name: 'Melee Kills', completionValue: 20, isSection: true },
  NewRow_20: { name: 'Craft a raincollector', completionValue: 1, isSection: false },
  NewRow_21: { name: 'Craft a tablesaw', completionValue: 1, isSection: false },
  NewRow_22: { name: 'Craft a treatment', completionValue: 1, isSection: false },
  NewRow_23: { name: 'Craft a weaponsbench', completionValue: 1, isSection: false },
  NewRow_24: { name: 'Craft a workbench', completionValue: 1, isSection: false },
  NewRow_25: { name: 'Find a canine companion', completionValue: 1, isSection: false },
  NewRow_26: { name: 'Find the crashed helicopter', completionValue: 1, isSection: false },
  NewRow_27: { name: 'Lockpick a survivor SUV', completionValue: 1, isSection: false },
  NewRow_28: { name: 'Repair the radio tower', completionValue: 1, isSection: false },
  NewRow_29: { name: 'Kill a zombie bear', completionValue: 1, isSection: false },
  NewRow_3: { name: 'Takedown Kills', completionValue: 50, isSection: true },
  NewRow_30: { name: 'Loot airdrop', completionValue: 1, isSection: false },
  NewRow_4: { name: 'Unarmed Kills', completionValue: 50, isSection: true },
  NewRow_5: { name: 'Vehicle Kills', completionValue: 50, isSection: true },
  NewRow_6: { name: 'Headshots', completionValue: 50, isSection: false },
  NewRow_7: { name: 'Fish Caught', completionValue: 50, isSection: false },
  NewRow_8: { name: 'Pike Caught', completionValue: 50, isSection: true },
  NewRow_9: { name: 'Survive for 3 Days', completionValue: 3, isSection: false },
  TotalZeekKilled: { name: 'Total zeeks killed', completionValue: 0, isSection: false },
};

// ═══════════════════════════════════════════════════════════════════════════
//  Extracted data (from game-data-extract.ts — 22 MB game-tables-raw.json)
// ═══════════════════════════════════════════════════════════════════════════

const ITEM_DATABASE = extract.getITEMS() as Record<string, Record<string, unknown>>;
const ITEM_NAMES = extract.getITEM_NAMES();
const BUILDINGS = extract.getBUILDINGS() as Record<string, Record<string, unknown>>;
const BUILDING_NAMES = extract.getBUILDING_NAMES();
const VEHICLE_NAMES = extract.getVEHICLE_NAMES();
const CRAFTING_RECIPES = extract.getRECIPES() as Record<string, Record<string, unknown>>;
const LOOT_TABLES = extract.getLOOT_TABLES() as Record<string, Record<string, unknown>>;
const SKILL_DETAILS = extract.getSKILLS() as Record<string, Record<string, unknown>>;
const EXTRACTED_PROFESSIONS = extract.getPROFESSIONS() as Record<string, Record<string, unknown>>;
const STATISTICS = extract.getSTATISTICS() as unknown as Record<string, ExtractedStat>; // SAFETY: upstream pz-extract types lack generics
const STAT_CONFIG = extract.getSTAT_CONFIG() as unknown as Record<string, ExtractedStat>; // SAFETY: upstream pz-extract types lack generics
const CROP_DATA = extract.getCROPS() as Record<string, Record<string, unknown>>;
const VEHICLES = extract.getVEHICLES() as Record<string, Record<string, unknown>>;
const CAR_UPGRADES = extract.getCAR_UPGRADES() as Record<string, Record<string, unknown>>;
const AMMO_DAMAGE = extract.getAMMO_DAMAGE() as Record<string, Record<string, unknown>>;
const REPAIR_RECIPES = extract.getREPAIR_DATA() as Record<string, Record<string, unknown>>;
const FURNITURE_DROPS = extract.getFURNITURE() as Record<string, Record<string, unknown>>;
const TRAPS = extract.getTRAPS() as Record<string, Record<string, unknown>>;
const ANIMALS = extract.getANIMALS() as Record<string, Record<string, unknown>>;
const XP_DATA = extract.getXP_DATA() as Record<string, unknown>[];
const SPAWN_LOCATIONS = extract.getSPAWN_LOCATIONS() as Record<string, Record<string, unknown>>;
const LORE_ENTRIES = extract.getLORE() as Record<string, Record<string, unknown>>;
const QUEST_DATA = extract.getQUESTS() as Record<string, Record<string, unknown>>;
const EXTRACTED_AFFLICTIONS = extract.getAFFLICTIONS() as Record<string, Record<string, unknown>>;
const EXTRACTED_LOADING_TIPS = extract.getLOADING_TIPS() as unknown as ExtractedTip[]; // SAFETY: upstream pz-extract types lack generics
const SPRAYS = extract.getSPRAYS() as Record<string, Record<string, unknown>>;
const FOLIAGE = extract.getFOLIAGE() as Record<string, Record<string, unknown>>;
const CHARACTERS = extract.getCHARACTERS() as Record<string, Record<string, unknown>>;
const TABLE_SUMMARY = extract.getTABLE_SUMMARY() as Record<string, unknown>;
const { deepClean, resolveEnum, getTable, getTableCleaned, ENUM_MAPS, cleanKey, cleanRow } = extract;

// ─── Challenges (from extracted STATISTICS + STAT_CONFIG) ───────────────────

const _challengeMap = new Map<string, ChallengeEntry>();

// Start with DT_Statistics (32 entries — legacy stat tracking)
for (const s of Object.values(STATISTICS)) {
  _challengeMap.set(s.id, {
    id: s.id,
    name: s.name,
    description: s.description,
    category: s.category,
    xp: s.xp,
    skillPoint: s.skillPoint,
    guid: s.guid,
    progressMax: s.progressMax,
    source: 'statistics',
  });
}

// Merge DT_StatConfig (67 entries — richer challenge definitions with GUIDs)
for (const sc of Object.values(STAT_CONFIG)) {
  if (_challengeMap.has(sc.id)) {
    // Merge — StatConfig has better descriptions and XP values
    const existing = _challengeMap.get(sc.id);
    if (!existing) continue;
    if (sc.description && !existing.description) existing.description = sc.description;
    if (sc.xp > existing.xp) existing.xp = sc.xp;
    if (sc.skillPoint > existing.skillPoint) existing.skillPoint = sc.skillPoint;
    if (sc.guid && !existing.guid) existing.guid = sc.guid;
    existing.progressMax = sc.progressMax || existing.progressMax;
    existing.source = 'both';
  } else {
    _challengeMap.set(sc.id, {
      id: sc.id,
      name: sc.name,
      description: sc.description,
      category: sc.category,
      xp: sc.xp,
      skillPoint: sc.skillPoint,
      guid: sc.guid,
      progressMax: sc.progressMax,
      source: 'stat_config',
    });
  }
}

const CHALLENGES: ChallengeEntry[] = [..._challengeMap.values()];

// ─── Loading tips (consumers expect array of strings) ───────────────────────

const LOADING_TIPS: string[] = EXTRACTED_LOADING_TIPS.map((t) => t.text).filter((t) => t.length > 0);

// ─── Enum lookup maps ───────────────────────────────────────────────────────

const CRAFTING_STATION_NAMES = ENUM_MAPS['E_CraftingStation'] ?? {};
const ITEM_TYPE_NAMES = ENUM_MAPS['E_ItemTypes'] ?? {};
const BUILD_CATEGORY_NAMES = ENUM_MAPS['E_BuildCategory'] ?? {};
const CHALLENGE_CATEGORY_NAMES = ENUM_MAPS['E_StatCat'] ?? {};
const SKILL_CATEGORY_NAMES = ENUM_MAPS['Enum_SkillCategories'] ?? {};

// ═══════════════════════════════════════════════════════════════════════════
//  Exports
// ═══════════════════════════════════════════════════════════════════════════

export {
  // Hand-curated (save-specific mapping, human-written text)
  AFFLICTION_MAP,
  AFFLICTION_DETAILS,
  PROFESSION_DETAILS,
  CHALLENGE_DESCRIPTIONS,
  SKILL_EFFECTS,
  SERVER_SETTING_DESCRIPTIONS,
  STAT_DISPLAY_NAMES,
  // Derived from extracted data
  CHALLENGES,
  LOADING_TIPS,
  // Extracted entity data (full objects with all fields)
  ITEM_DATABASE,
  ITEM_NAMES,
  BUILDINGS,
  BUILDING_NAMES,
  VEHICLE_NAMES,
  CRAFTING_RECIPES,
  LOOT_TABLES,
  SKILL_DETAILS,
  EXTRACTED_PROFESSIONS,
  STATISTICS,
  STAT_CONFIG,
  CROP_DATA,
  VEHICLES,
  CAR_UPGRADES,
  AMMO_DAMAGE,
  REPAIR_RECIPES,
  FURNITURE_DROPS,
  TRAPS,
  ANIMALS,
  XP_DATA,
  SPAWN_LOCATIONS,
  LORE_ENTRIES,
  QUEST_DATA,
  EXTRACTED_AFFLICTIONS,
  SPRAYS,
  FOLIAGE,
  CHARACTERS,
  TABLE_SUMMARY,
  // Enum lookup maps
  CRAFTING_STATION_NAMES,
  ITEM_TYPE_NAMES,
  BUILD_CATEGORY_NAMES,
  CHALLENGE_CATEGORY_NAMES,
  SKILL_CATEGORY_NAMES,
  ENUM_MAPS,
  // Utilities (re-exported)
  cleanKey,
  cleanRow,
  deepClean,
  resolveEnum,
  getTable,
  getTableCleaned,
};

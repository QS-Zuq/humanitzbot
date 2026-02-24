/**
 * Comprehensive HumanitZ save file parser.
 *
 * Parses a GVAS save file (.sav) and returns a structured object containing:
 *   - players     Map<steamId, PlayerData>   — all per-player data
 *   - worldState  object                     — global server state
 *   - structures  array                      — placed buildings with health/owners
 *   - vehicles    array                      — vehicles with position/health/fuel
 *   - companions  array                      — dogs and other companions
 *   - deadBodies  array                      — death loot locations
 *   - containers  array                      — global storage containers
 *   - lootActors  array                      — modular loot spawn points
 *   - quests      array                      — world quest state
 *
 * Also exports parseClanData(buf) for the separate Save_ClanData.sav file.
 */

const { createReader, parseHeader, readProperty, recoverForward } = require('./gvas-reader');

// ─── Perk enum → display name ──────────────────────────────────────────────

const  PERK_MAP = {
  'Enum_Professions::NewEnumerator0':  'Unemployed',
  'Enum_Professions::NewEnumerator1':  'Amateur Boxer',
  'Enum_Professions::NewEnumerator2':  'Farmer',
  'Enum_Professions::NewEnumerator3':  'Mechanic',
  'Enum_Professions::NewEnumerator9':  'Car Salesman',
  'Enum_Professions::NewEnumerator10': 'Outdoorsman',
  'Enum_Professions::NewEnumerator12': 'Chemist',
  'Enum_Professions::NewEnumerator13': 'Emergency Medical Technician',
  'Enum_Professions::NewEnumerator14': 'Military Veteran',
  'Enum_Professions::NewEnumerator15': 'Thief',
  'Enum_Professions::NewEnumerator16': 'Fire Fighter',
  'Enum_Professions::NewEnumerator17': 'Electrical Engineer',
};

const PERK_INDEX_MAP = {
  0: 'Unemployed', 1: 'Amateur Boxer', 2: 'Farmer', 3: 'Mechanic',
  9: 'Car Salesman', 10: 'Outdoorsman', 12: 'Chemist',
  13: 'Emergency Medical Technician', 14: 'Military Veteran',
  15: 'Thief', 16: 'Fire Fighter', 17: 'Electrical Engineer',
};

// ─── Clan rank → display name ──────────────────────────────────────────────

const CLAN_RANK_MAP = {
  'E_ClanRank::NewEnumerator0': 'Recruit',
  'E_ClanRank::NewEnumerator1': 'Member',
  'E_ClanRank::NewEnumerator2': 'Officer',
  'E_ClanRank::NewEnumerator3': 'Co-Leader',
  'E_ClanRank::NewEnumerator4': 'Leader',
};

// ─── Season enum → display name ────────────────────────────────────────────

const SEASON_MAP = {
  'UDS_Season::NewEnumerator0': 'Spring',
  'UDS_Season::NewEnumerator1': 'Summer',
  'UDS_Season::NewEnumerator2': 'Autumn',
  'UDS_Season::NewEnumerator3': 'Winter',
};

// ─── Statistics tag path → player field mapping ────────────────────────────

const STAT_TAG_MAP = {
  'statistics.stat.game.kills.total':         'lifetimeKills',
  'statistics.stat.game.kills.headshot':       'lifetimeHeadshots',
  'statistics.stat.game.kills.type.melee':     'lifetimeMeleeKills',
  'statistics.stat.game.kills.type.ranged':    'lifetimeGunKills',
  'statistics.stat.game.kills.type.blast':     'lifetimeBlastKills',
  'statistics.stat.game.kills.type.unarmed':   'lifetimeFistKills',
  'statistics.stat.game.kills.type.takedown':  'lifetimeTakedownKills',
  'statistics.stat.game.kills.type.vehicle':   'lifetimeVehicleKills',
  'statistics.stat.progress.survivefor3days':  'lifetimeDaysSurvived',
  'statistics.stat.game.bitten':               'timesBitten',
  'statistics.stat.game.activity.FishCaught':       'fishCaught',
  'statistics.stat.game.activity.FishCaught.Pike':  'fishCaughtPike',
  // Challenge progress
  'statistics.stat.challenge.KillSomeZombies':      'challengeKillZombies',
  'statistics.stat.progress.kill50zombies':          'challengeKill50',
  'statistics.stat.progress.catch20fish':            'challengeCatch20Fish',
  'statistics.stat.challenge.RegularAngler':         'challengeRegularAngler',
  'statistics.stat.challenge.KillZombieBear':        'challengeKillZombieBear',
  'statistics.stat.challenge.9SquaresToChaos':       'challenge9Squares',
  'statistics.stat.challenge.CraftFirearm':          'challengeCraftFirearm',
  'statistics.stat.challenge.CraftFurnace':          'challengeCraftFurnace',
  'statistics.stat.challenge.CraftMeleeBench':       'challengeCraftMeleeBench',
  'statistics.stat.challenge.CraftMeleeWeapon':      'challengeCraftMeleeWeapon',
  'statistics.stat.challenge.CraftRainCollector':    'challengeCraftRainCollector',
  'statistics.stat.challenge.CraftTablesaw':         'challengeCraftTablesaw',
  'statistics.stat.challenge.CraftTreatment':        'challengeCraftTreatment',
  'statistics.stat.challenge.CraftWeaponsBench':     'challengeCraftWeaponsBench',
  'statistics.stat.challenge.CraftWorkbench':        'challengeCraftWorkbench',
  'statistics.stat.challenge.FindCanineCompanion':   'challengeFindDog',
  'statistics.stat.challenge.FindCrashedHelicopter': 'challengeFindHeli',
  'statistics.stat.challenge.LockpickSurvivorSUV':  'challengeLockpickSUV',
  'statistics.stat.challenge.RepairRadioTower':      'challengeRepairRadio',
};

// ─── Simplify UE4 blueprint class names ────────────────────────────────────

function simplifyBlueprint(bp) {
  if (!bp || typeof bp !== 'string') return bp;
  // "/Game/BuildingSystem/Blueprints/Buildings/BP_WoodWall.BP_WoodWall_C" → "WoodWall"
  const match = bp.match(/BP_([^.]+?)(?:_C)?$/);
  if (match) return match[1];
  // Fallback: last segment
  const parts = bp.split('/');
  return parts[parts.length - 1].replace(/_C$/, '').replace(/^BP_/, '');
}

// ─── Default player data template ──────────────────────────────────────────

function createPlayerData() {
  return {
    // Character
    male: true,
    startingPerk: 'Unknown',
    affliction: 0,
    charProfile: {},

    // Current-life kill stats (GameStats — resets on death)
    zeeksKilled: 0,
    headshots: 0,
    meleeKills: 0,
    gunKills: 0,
    blastKills: 0,
    fistKills: 0,
    takedownKills: 0,
    vehicleKills: 0,

    // Lifetime stats (Statistics — persist across deaths)
    lifetimeKills: 0,
    lifetimeHeadshots: 0,
    lifetimeMeleeKills: 0,
    lifetimeGunKills: 0,
    lifetimeBlastKills: 0,
    lifetimeFistKills: 0,
    lifetimeTakedownKills: 0,
    lifetimeVehicleKills: 0,
    lifetimeDaysSurvived: 0,
    hasExtendedStats: false,

    // Survival & activity
    daysSurvived: 0,
    timesBitten: 0,
    bites: 0,
    fishCaught: 0,
    fishCaughtPike: 0,

    // Vitals
    health: 0, maxHealth: 0,
    hunger: 0, maxHunger: 0,
    thirst: 0, maxThirst: 0,
    stamina: 0, maxStamina: 0,
    infection: 0, maxInfection: 0,
    battery: 100,

    // Float data
    fatigue: 0,
    infectionBuildup: 0,
    wellRested: 0,
    energy: 0,
    hood: 0,
    hypoHandle: 0,

    // Experience
    exp: 0,

    // Position & respawn
    x: null, y: null, z: null,
    rotationYaw: null,
    respawnX: null, respawnY: null, respawnZ: null,

    // CB Radio
    cbRadioCooldown: 0,

    // Status effects
    playerStates: [],
    bodyConditions: [],

    // Recipes
    craftingRecipes: [],
    buildingRecipes: [],

    // Skills & professions
    unlockedProfessions: [],
    unlockedSkills: [],
    skillsData: [],

    // Inventory
    inventory: [],
    equipment: [],
    quickSlots: [],
    backpackItems: [],
    backpackData: {},

    // Lore
    lore: [],

    // Unique items
    uniqueLoots: [],
    craftedUniques: [],
    lootItemUnique: [],

    // Quests & challenges
    questData: [],
    miniQuest: {},
    challenges: [],
    questSpawnerDone: [],

    // Companions
    companionData: [],
    horses: [],

    // Extended stats (raw)
    extendedStats: [],

    // Challenge progress (parsed from Statistics)
    challengeKillZombies: 0,
    challengeKill50: 0,
    challengeCatch20Fish: 0,
    challengeRegularAngler: 0,
    challengeKillZombieBear: 0,
    challenge9Squares: 0,
    challengeCraftFirearm: 0,
    challengeCraftFurnace: 0,
    challengeCraftMeleeBench: 0,
    challengeCraftMeleeWeapon: 0,
    challengeCraftRainCollector: 0,
    challengeCraftTablesaw: 0,
    challengeCraftTreatment: 0,
    challengeCraftWeaponsBench: 0,
    challengeCraftWorkbench: 0,
    challengeFindDog: 0,
    challengeFindHeli: 0,
    challengeLockpickSUV: 0,
    challengeRepairRadio: 0,

    // Custom data map
    customData: {},

    // Day incremented flag
    dayIncremented: false,

    // Infection timer
    infectionTimer: null,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
//  Main parser
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Parse a complete HumanitZ save file.
 *
 * @param {Buffer} buf - The raw .sav file contents
 * @returns {object} { players, worldState, structures, vehicles, companions, deadBodies, containers, lootActors, quests, header }
 */
function parseSave(buf) {
  const r = createReader(buf);
  const header = parseHeader(r);

  // ── Result containers ──
  const players = new Map();
  const worldState = {};
  const structures = [];
  const vehicles = [];
  const companions = [];
  const deadBodies = [];
  const containers = [];
  const lootActors = [];
  const quests = [];

  // ── Parallel arrays that get assembled after parsing ──
  let buildActorClasses = [];      // ObjectProperty array
  let buildActorHealths = [];      // FloatProperty array  
  let buildActorMaxHealths = [];   // FloatProperty array
  let buildActorUpgrades = [];     // IntProperty array
  let buildActorTrailer = [];      // BoolProperty array
  let buildActorStrings = [];      // StrProperty array (owner info)
  let buildActorData = [];         // StrProperty array
  let buildActorNoSpawn = [];      // struct array (parsed)
  let buildActorInventories = [];  // struct array (parsed)
  let buildActorTransformCount = 0;

  // ── Player state machine ──
  let currentSteamID = null;

  function ensurePlayer(id) {
    if (!players.has(id)) players.set(id, createPlayerData());
    return players.get(id);
  }

  function prescanSteamId(props) {
    for (const prop of props) {
      if (prop?.name === 'SteamID' && typeof prop.value === 'string') {
        const match = prop.value.match(/(7656\d+)/);
        if (match) { currentSteamID = match[1]; return; }
      }
    }
  }

  // ── Property handler ──

  function handleProp(prop) {
    if (!prop) return;
    const n = prop.name;

    // ── SteamID detection ──
    if (n === 'SteamID' && typeof prop.value === 'string') {
      const match = prop.value.match(/(7656\d+)/);
      if (match) currentSteamID = match[1];
    }

    // ── Children recursion ──
    if (prop.children) {
      prescanSteamId(prop.children);
      for (const child of prop.children) handleProp(child);
    }

    // ── Statistics array extraction (nested struct array) ──
    if (Array.isArray(prop.value) && prop.value.length > 0 && Array.isArray(prop.value[0])) {
      if (n === 'Statistics' && currentSteamID) {
        _extractStatistics(prop.value, ensurePlayer(currentSteamID));
      }
      if (n === 'ExtendedStats' && currentSteamID) {
        _extractExtendedStats(prop.value, ensurePlayer(currentSteamID));
      }
      for (const elemProps of prop.value) {
        if (Array.isArray(elemProps)) {
          prescanSteamId(elemProps);
          for (const ep of elemProps) handleProp(ep);
        }
      }
    }

    // ════════════════════════════════════════════════════════════════════════
    //  WORLD-LEVEL PROPERTIES (count = 1, global)
    // ════════════════════════════════════════════════════════════════════════

    // Build actor classes (parallel array with structures)
    if (n === 'BuildActorClass' && Array.isArray(prop.value)) {
      buildActorClasses = prop.value;
      return;
    }
    if (n === 'BuildActorTransform') {
      if (typeof prop.value === 'string' && prop.value.startsWith('<skipped')) {
        const m = prop.value.match(/\d+/);
        buildActorTransformCount = m ? parseInt(m[0], 10) : 0;
      }
      return;
    }
    if (n === 'BuildingCurrentHealth' && Array.isArray(prop.value)) {
      buildActorHealths = prop.value;
      return;
    }
    if (n === 'BuildingMaxHealth' && Array.isArray(prop.value)) {
      buildActorMaxHealths = prop.value;
      return;
    }
    if (n === 'BuildingUpgradeLv' && Array.isArray(prop.value)) {
      buildActorUpgrades = prop.value;
      return;
    }
    if (n === 'AttachedToTrailer' && Array.isArray(prop.value)) {
      buildActorTrailer = prop.value;
      return;
    }
    if (n === 'BuildingStr' && Array.isArray(prop.value)) {
      buildActorStrings = prop.value;
      return;
    }
    if (n === 'BuildActorData' && Array.isArray(prop.value)) {
      buildActorData = prop.value;
      return;
    }
    if (n === 'BuildActorsNoSpawn' && Array.isArray(prop.value)) {
      // Struct array — each element has BuildActor + other props
      buildActorNoSpawn = prop.value;
      return;
    }
    if (n === 'BuildActorInventory' && Array.isArray(prop.value)) {
      buildActorInventories = prop.value;
      return;
    }

    // Vehicles
    if (n === 'Cars' && Array.isArray(prop.value)) {
      _extractVehicles(prop.value, vehicles);
      return;
    }

    // Dogs in world
    if (n === 'Dogs' && Array.isArray(prop.value) && !currentSteamID) {
      for (const name of prop.value) {
        if (name && typeof name === 'string') {
          companions.push({ type: 'dog', actorName: name, ownerSteamId: '', x: null, y: null, z: null, health: 0, extra: {} });
        }
      }
      return;
    }

    // Dead bodies
    if (n === 'DeadBodies' && Array.isArray(prop.value) && !currentSteamID) {
      for (const name of prop.value) {
        if (name && typeof name === 'string') {
          deadBodies.push({ actorName: name, x: null, y: null, z: null });
        }
      }
      return;
    }

    // Explodable barrels (world objects)
    if (n === 'ExplodableBarrels' && Array.isArray(prop.value) && !currentSteamID) {
      worldState.explodableBarrels = prop.value;
      return;
    }

    // Generators
    if (n === 'GennyPowerLevel' && Array.isArray(prop.value) && !currentSteamID) {
      worldState.generatorPowerLevels = prop.value;
      return;
    }

    // Container data (global storage)
    if (n === 'ContainerData' && !currentSteamID) {
      _extractContainers(prop, containers);
      return;
    }

    // Modular loot actors
    if (n === 'ModularLootActor' && !currentSteamID) {
      _extractLootActors(prop, lootActors);
      return;
    }

    // Stone cutting stations
    if (n === 'StoneCutting' && !currentSteamID) {
      worldState.stoneCuttingStations = Array.isArray(prop.value) ? prop.value.length : 0;
      return;
    }

    // Pre-build actors (like campfires that exist before player build)
    if (n === 'PreBuildActors' && !currentSteamID) {
      worldState.preBuildActorCount = Array.isArray(prop.value) ? prop.value.length : 0;
      return;
    }

    // World quest data
    if (n === 'QuestSavedData' && !currentSteamID) {
      _extractWorldQuests(prop, quests);
      return;
    }

    // Random quest config
    if (n === 'RandQuestConfig' && prop.value && typeof prop.value === 'object') {
      worldState.questConfig = prop.value;
      return;
    }

    // Airdrop
    if (n === 'Airdrop') {
      worldState.airdropActive = true;
      return;
    }

    // Drop-in saves (players who connected then disconnected)
    if (n === 'DropInSaves' && Array.isArray(prop.value) && !currentSteamID) {
      // Extract Steam IDs from each drop-in entry
      const dropIns = [];
      for (const elemProps of prop.value) {
        if (!Array.isArray(elemProps)) continue;
        for (const ep of elemProps) {
          if (ep.name === 'SteamID' && typeof ep.value === 'string') {
            const m = ep.value.match(/(7656\d+)/);
            if (m) dropIns.push(m[1]);
          }
        }
      }
      worldState.dropInSaves = dropIns;
      return;
    }

    // Unique spawners
    if (n === 'UniqueSpawners') {
      worldState.uniqueSpawnerCount = Array.isArray(prop.value) ? prop.value.length : 0;
      return;
    }

    // Global world state scalars
    if (n === 'Dedi_DaysPassed' && typeof prop.value === 'number') {
      worldState.daysPassed = prop.value;
      return;
    }
    if (n === 'CurrentSeason') {
      worldState.currentSeason = SEASON_MAP[prop.value] || prop.value;
      return;
    }
    if (n === 'CurrentSeasonDay' && typeof prop.value === 'number') {
      worldState.currentSeasonDay = prop.value;
      return;
    }
    if (n === 'RandomSeed' && typeof prop.value === 'number') {
      worldState.randomSeed = prop.value;
      return;
    }
    if (n === 'UsesSteamUID') {
      worldState.usesSteamUid = !!prop.value;
      return;
    }
    if (n === 'GameDiff') {
      worldState.gameDifficulty = prop.children || prop.value;
      return;
    }
    if (n === 'UDSandUDWsave') {
      worldState.weatherState = prop.children || prop.value;
      return;
    }

    // ════════════════════════════════════════════════════════════════════════
    //  PER-PLAYER PROPERTIES
    // ════════════════════════════════════════════════════════════════════════

    if (!currentSteamID) return;
    const p = ensurePlayer(currentSteamID);

    // ── Simple scalar values ──
    if (n === 'DayzSurvived' && typeof prop.value === 'number') p.daysSurvived = prop.value;
    if (n === 'Affliction' && typeof prop.value === 'number') p.affliction = prop.value;
    if (n === 'Male') p.male = !!prop.value;
    if (n === 'DayIncremented') p.dayIncremented = !!prop.value;
    if (n === 'Bites' && typeof prop.value === 'number') p.bites = prop.value;
    if (n === 'CBRadioCooldown' && typeof prop.value === 'number') p.cbRadioCooldown = prop.value;

    // Vitals
    if (n === 'CurrentHealth' && typeof prop.value === 'number') p.health = _round(prop.value);
    if (n === 'MaxHealth' && typeof prop.value === 'number') p.maxHealth = _round(prop.value);
    if (n === 'CurrentHunger' && typeof prop.value === 'number') p.hunger = _round(prop.value);
    if (n === 'MaxHunger' && typeof prop.value === 'number') p.maxHunger = _round(prop.value);
    if (n === 'CurrentThirst' && typeof prop.value === 'number') p.thirst = _round(prop.value);
    if (n === 'MaxThirst' && typeof prop.value === 'number') p.maxThirst = _round(prop.value);
    if (n === 'CurrentStamina' && typeof prop.value === 'number') p.stamina = _round(prop.value);
    if (n === 'MaxStamina' && typeof prop.value === 'number') p.maxStamina = _round(prop.value);
    if (n === 'CurrentInfection' && typeof prop.value === 'number') p.infection = _round(prop.value);
    if (n === 'MaxInfection' && typeof prop.value === 'number') p.maxInfection = _round(prop.value);
    if (n === 'PlayerBattery' && typeof prop.value === 'number') p.battery = _round(prop.value);

    // Experience
    if (n === 'Exp' && typeof prop.value === 'number') p.exp = _round(prop.value);

    // Infection timer
    if (n === 'InfectionTimer') p.infectionTimer = prop.value || null;

    // ── Perk (profession) ──
    if (n === 'StartingPerk') {
      let mapped = null;
      if (typeof prop.value === 'string') mapped = PERK_MAP[prop.value];
      else if (typeof prop.value === 'number') mapped = PERK_INDEX_MAP[prop.value];
      if (mapped) p.startingPerk = mapped;
    }

    // ── GameStats map (current-life kills — resets on death) ──
    if (n === 'GameStats' && prop.value && typeof prop.value === 'object') {
      const gs = prop.value;
      if (gs.ZeeksKilled !== undefined) p.zeeksKilled = gs.ZeeksKilled;
      if (gs.HeadShot !== undefined) p.headshots = gs.HeadShot;
      if (gs.MeleeKills !== undefined) p.meleeKills = gs.MeleeKills;
      if (gs.GunKills !== undefined) p.gunKills = gs.GunKills;
      if (gs.BlastKills !== undefined) p.blastKills = gs.BlastKills;
      if (gs.FistKills !== undefined) p.fistKills = gs.FistKills;
      if (gs.TakedownKills !== undefined) p.takedownKills = gs.TakedownKills;
      if (gs.VehicleKills !== undefined) p.vehicleKills = gs.VehicleKills;
      if (gs.DaysSurvived !== undefined && gs.DaysSurvived > 0) p.daysSurvived = gs.DaysSurvived;
    }

    // ── FloatData map ──
    if (n === 'FloatData' && prop.value && typeof prop.value === 'object') {
      const fd = prop.value;
      if (fd.Fatigue !== undefined) p.fatigue = _round2(fd.Fatigue);
      if (fd.InfectionBuildup !== undefined) p.infectionBuildup = Math.round(fd.InfectionBuildup);
      if (fd.WellRested !== undefined) p.wellRested = _round2(fd.WellRested);
      if (fd.Energy !== undefined) p.energy = _round2(fd.Energy);
      if (fd.Hood !== undefined) p.hood = _round2(fd.Hood);
      if (fd.HypoHandle !== undefined) p.hypoHandle = _round2(fd.HypoHandle);
    }

    // ── CustomData map ──
    if (n === 'CustomData' && prop.value && typeof prop.value === 'object') {
      p.customData = prop.value;
    }

    // ── Recipes ──
    if (n === 'Recipe_Crafting' && Array.isArray(prop.value)) p.craftingRecipes = prop.value.filter(Boolean);
    if (n === 'Recipe_Building' && Array.isArray(prop.value)) p.buildingRecipes = prop.value.filter(Boolean);

    // ── Status effects ──
    if (n === 'PlayerStates' && Array.isArray(prop.value)) p.playerStates = prop.value;
    if (n === 'BodyCondition' && Array.isArray(prop.value)) p.bodyConditions = prop.value;

    // ── Professions ──
    if (n === 'UnlockedProfessionArr' && Array.isArray(prop.value)) p.unlockedProfessions = prop.value;

    // ── Skills ──
    if ((n === 'UnlockedSkills' || n.startsWith('UnlockedSkills_')) && Array.isArray(prop.value)) {
      p.unlockedSkills = prop.value.filter(Boolean);
    }
    if (n === 'Skills' && Array.isArray(prop.value)) {
      p.skillsData = prop.value;
    }

    // ── Unique items ──
    if ((n === 'UniqueLoots' || n.startsWith('UniqueLoots_')) && Array.isArray(prop.value)) {
      p.uniqueLoots = prop.value;
    }
    if ((n === 'CraftedUniques' || n.startsWith('CraftedUniques_')) && Array.isArray(prop.value)) {
      p.craftedUniques = prop.value.filter(Boolean);
    }
    if (n === 'LootItemUnique' && Array.isArray(prop.value)) {
      p.lootItemUnique = prop.value.filter(Boolean);
    }

    // ── Lore ──
    if (n === 'LoreId' && typeof prop.value === 'string') p.lore.push(prop.value);
    if (n === 'Lore' && Array.isArray(prop.value)) {
      // Struct array version
      p.lore = prop.value;
    }

    // ── Player Transform (position + rotation) ──
    if (n === 'PlayerTransform' && prop.type === 'StructProperty' && prop.structType === 'Transform') {
      _extractTransform(prop, p);
    }
    // Also handle unnamed Transform properties (fallback)
    if (prop.type === 'StructProperty' && prop.structType === 'Transform' && prop.value?.translation) {
      _extractTransform(prop, p);
    }

    // ── Respawn point ──
    if (n === 'PlayerRespawnPoint' && prop.type === 'StructProperty' && prop.structType === 'Transform') {
      if (prop.value?.translation) {
        const t = prop.value.translation;
        if (typeof t.x === 'number') {
          p.respawnX = _round2(t.x);
          p.respawnY = _round2(t.y);
          p.respawnZ = _round2(t.z);
        }
      }
    }

    // ── Character profile ──
    if (n === 'CharProfile' && prop.children) {
      p.charProfile = _childrenToObject(prop.children);
    }

    // ── Inventory ──
    if (n === 'PlayerInventory' && Array.isArray(prop.value)) p.inventory = prop.value;
    if (n === 'PlayerEquipment' && Array.isArray(prop.value)) p.equipment = prop.value;
    if (n === 'PlayerQuickSlots' && Array.isArray(prop.value)) p.quickSlots = prop.value;
    if ((n === 'BackpackInventory' || n.startsWith('BackpackInventory_')) && Array.isArray(prop.value)) p.backpackItems = prop.value;

    // ── Backpack data ──
    if (n === 'BackpackData' && (prop.children || Array.isArray(prop.value))) {
      p.backpackData = prop.children ? _childrenToObject(prop.children) : prop.value;
    }

    // ── Quest / challenge data ──
    if (n === 'QuestData' && Array.isArray(prop.value)) p.questData = prop.value;
    if (n === 'MiniQuest' && (prop.children || prop.value)) {
      p.miniQuest = prop.children ? _childrenToObject(prop.children) : prop.value;
    }
    if (n === 'Challenges' && Array.isArray(prop.value)) p.challenges = prop.value;
    if (n === 'QuestSpawnerDone' && Array.isArray(prop.value)) p.questSpawnerDone = prop.value;

    // ── Companion data ──
    if (n === 'CompanionData' && Array.isArray(prop.value)) p.companionData = prop.value;
    if (n === 'Horses' && Array.isArray(prop.value)) p.horses = prop.value;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Main parse loop
  // ═══════════════════════════════════════════════════════════════════════════

  while (r.remaining() > 4) {
    try {
      const saved = r.getOffset();
      const prop = readProperty(r, { skipLargeArrays: true, skipThreshold: 10 });
      if (prop === null) {
        if (r.getOffset() === saved) {
          if (!recoverForward(r, saved)) break;
        }
        continue;
      }
      handleProp(prop);
    } catch (err) {
      const pos = r.getOffset();
      if (!recoverForward(r, pos)) break;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Post-processing: assemble parallel arrays into structures
  // ═══════════════════════════════════════════════════════════════════════════

  const structCount = buildActorClasses.length || buildActorTransformCount;
  for (let i = 0; i < structCount; i++) {
    const ownerStr = buildActorStrings[i] || '';
    const ownerMatch = ownerStr.match(/(7656\d+)/);
    structures.push({
      actorClass: buildActorClasses[i] || '',
      displayName: simplifyBlueprint(buildActorClasses[i] || ''),
      ownerSteamId: ownerMatch ? ownerMatch[1] : '',
      x: null, y: null, z: null, // transforms are skipped for performance
      currentHealth: buildActorHealths[i] || 0,
      maxHealth: buildActorMaxHealths[i] || 0,
      upgradeLevel: buildActorUpgrades[i] || 0,
      attachedToTrailer: buildActorTrailer[i] || false,
      inventory: [],
      noSpawn: false,
      extraData: buildActorData[i] || '',
    });
  }

  // Mark no-spawn structures
  for (const nsProps of buildActorNoSpawn) {
    if (!Array.isArray(nsProps)) continue;
    for (const nsp of nsProps) {
      if (nsp.name === 'BuildActor' && typeof nsp.value === 'string') {
        // Find matching structure
        const idx = structures.findIndex(s => s.extraData === nsp.value || s.actorClass === nsp.value);
        if (idx >= 0) structures[idx].noSpawn = true;
      }
    }
  }

  // Assign inventories to structures
  for (const invProps of buildActorInventories) {
    if (!Array.isArray(invProps)) continue;
    let actorName = '';
    let items = [];
    for (const ip of invProps) {
      if (ip.name === 'ContainerActor') actorName = ip.value;
      if (ip.name === 'ContainerSlots' && Array.isArray(ip.value)) items = ip.value;
    }
    if (actorName) {
      // Find the container or add as standalone
      const existingContainer = containers.find(c => c.actorName === actorName);
      if (existingContainer) {
        existingContainer.items = items;
      } else {
        containers.push({ actorName, items, x: null, y: null, z: null });
      }
    }
  }

  // World summary stats
  worldState.totalStructures = structures.length;
  worldState.totalVehicles = vehicles.length;
  worldState.totalCompanions = companions.length;
  worldState.totalDeadBodies = deadBodies.length;
  worldState.totalPlayers = players.size;

  return {
    players,
    worldState,
    structures,
    vehicles,
    companions,
    deadBodies,
    containers,
    lootActors,
    quests,
    header,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
//  Extraction helpers
// ═══════════════════════════════════════════════════════════════════════════

function _extractStatistics(statArray, player) {
  for (const elemProps of statArray) {
    if (!Array.isArray(elemProps)) continue;
    let tagName = null;
    let currentValue = null;

    for (const ep of elemProps) {
      if (ep.name === 'StatisticId') {
        if (ep.children) {
          for (const c of ep.children) {
            if (c.name === 'TagName' && typeof c.value === 'string') tagName = c.value;
          }
        }
        if (typeof ep.value === 'string' && ep.value.startsWith('statistics.')) {
          tagName = ep.value;
        }
      }
      if (ep.name === 'CurrentValue' && typeof ep.value === 'number') {
        currentValue = ep.value;
      }
    }

    if (tagName && currentValue !== null && currentValue > 0) {
      const field = STAT_TAG_MAP[tagName];
      if (field) {
        player[field] = Math.round(currentValue);
        player.hasExtendedStats = true;
      }
    }
  }
}

function _extractExtendedStats(statArray, player) {
  player.extendedStats = [];
  for (const elemProps of statArray) {
    if (!Array.isArray(elemProps)) continue;
    const stat = {};
    for (const ep of elemProps) {
      if (ep.name === 'StatName') stat.name = ep.value;
      if (ep.name === 'StatValue' && typeof ep.value === 'number') stat.value = ep.value;
    }
    if (stat.name) player.extendedStats.push(stat);
  }
}

function _extractVehicles(carArray, vehicles) {
  for (const carProps of carArray) {
    if (!Array.isArray(carProps)) continue;
    const vehicle = {
      class: '', displayName: '',
      x: null, y: null, z: null,
      health: 0, maxHealth: 0, fuel: 0,
      inventory: [], upgrades: [], extra: {},
    };

    for (const cp of carProps) {
      if (cp.name === 'Class') {
        vehicle.class = cp.value || '';
        vehicle.displayName = simplifyBlueprint(cp.value || '');
      }
      if (cp.name === 'Health' && typeof cp.value === 'number') vehicle.health = _round(cp.value);
      if (cp.name === 'MaxHealth' && typeof cp.value === 'number') vehicle.maxHealth = _round(cp.value);
      if (cp.name === 'Fuel' && typeof cp.value === 'number') vehicle.fuel = _round(cp.value);
      if (cp.name === 'Transform' && cp.value?.translation) {
        vehicle.x = _round2(cp.value.translation.x);
        vehicle.y = _round2(cp.value.translation.y);
        vehicle.z = _round2(cp.value.translation.z);
      }
      // Nest any other car props into extra
      if (!['Class', 'Health', 'MaxHealth', 'Fuel', 'Transform'].includes(cp.name)) {
        vehicle.extra[cp.name] = cp.value;
      }
    }

    vehicles.push(vehicle);
  }
}

function _extractContainers(prop, containers) {
  if (!Array.isArray(prop.value)) return;
  for (const elemProps of prop.value) {
    if (!Array.isArray(elemProps)) continue;
    const container = { actorName: '', items: [], x: null, y: null, z: null };
    for (const cp of elemProps) {
      if (cp.name === 'ContainerActor') container.actorName = cp.value || '';
      if (cp.name === 'ContainerSlots' && Array.isArray(cp.value)) container.items = cp.value;
    }
    if (container.actorName) containers.push(container);
  }
}

function _extractLootActors(prop, lootActors) {
  if (!Array.isArray(prop.value)) return;
  for (const elemProps of prop.value) {
    if (!Array.isArray(elemProps)) continue;
    const actor = { name: '', type: '', x: null, y: null, z: null, items: [] };
    for (const lp of elemProps) {
      if (lp.name === 'Name') actor.name = lp.value || '';
      if (lp.name === 'Type') actor.type = lp.value || '';
      if (lp.name === 'Items' && Array.isArray(lp.value)) actor.items = lp.value;
    }
    if (actor.name) lootActors.push(actor);
  }
}

function _extractWorldQuests(prop, quests) {
  if (!Array.isArray(prop.value)) return;
  for (const elemProps of prop.value) {
    if (!Array.isArray(elemProps)) continue;
    const quest = { id: '', type: '', state: '', data: {} };
    for (const qp of elemProps) {
      if (qp.name === 'GUID' || qp.name === 'ID') quest.id = qp.value || '';
      if (qp.name === 'QuestType') quest.type = qp.value || '';
      if (qp.name === 'State' || qp.name === 'Status') quest.state = qp.value || '';
    }
    if (quest.id) quests.push(quest);
  }
}

function _extractTransform(prop, player) {
  if (prop.value?.translation) {
    const t = prop.value.translation;
    if (typeof t.x === 'number' && typeof t.y === 'number') {
      player.x = _round2(t.x);
      player.y = _round2(t.y);
      player.z = _round2(t.z);
    }
    if (prop.value.rotation) {
      const q = prop.value.rotation;
      if (typeof q.z === 'number' && typeof q.w === 'number') {
        player.rotationYaw = _round(Math.atan2(2 * q.z * q.w, 1 - 2 * q.z * q.z) * (180 / Math.PI));
      }
    }
  }
}

function _childrenToObject(children) {
  const obj = {};
  for (const c of children) {
    if (c.name && c.value !== undefined && c.value !== 'struct' && c.value !== '<text>') {
      obj[c.name] = c.value;
    }
    if (c.children) {
      obj[c.name] = _childrenToObject(c.children);
    }
  }
  return obj;
}

// ─── Rounding helpers ──────────────────────────────────────────────────────

function _round(v) { return Math.round(v * 10) / 10; }
function _round2(v) { return Math.round(v * 100) / 100; }

// ═══════════════════════════════════════════════════════════════════════════
//  Clan data parser (separate Save_ClanData.sav file)
// ═══════════════════════════════════════════════════════════════════════════

function parseClanData(buf) {
  const r = createReader(buf);
  parseHeader(r);

  const clans = [];

  while (r.remaining() > 4) {
    const saved = r.getOffset();
    const prop = readProperty(r);
    if (prop === null) {
      if (r.getOffset() === saved) break;
      continue;
    }

    if (prop.name === 'ClanInfo' && prop.type === 'ArrayProperty') {
      if (!Array.isArray(prop.value)) continue;

      for (const clanProps of prop.value) {
        if (!Array.isArray(clanProps)) continue;
        const clan = { name: '', members: [] };

        for (const cp of clanProps) {
          if (cp.name?.startsWith('ClanName') && typeof cp.value === 'string') {
            clan.name = cp.value;
          }
          if (cp.name?.startsWith('Members') && cp.type === 'ArrayProperty') {
            if (Array.isArray(cp.value)) {
              for (const memberProps of cp.value) {
                if (!Array.isArray(memberProps)) continue;
                const member = { name: '', steamId: '', rank: 'Member', canInvite: false, canKick: false };
                for (const mp of memberProps) {
                  if (mp.name?.startsWith('Name') && typeof mp.value === 'string') member.name = mp.value;
                  if (mp.name?.startsWith('NetID') && typeof mp.value === 'string') {
                    const match = mp.value.match(/(7656\d+)/);
                    if (match) member.steamId = match[1];
                  }
                  if (mp.name?.startsWith('Rank') && typeof mp.value === 'string') {
                    member.rank = CLAN_RANK_MAP[mp.value] || mp.value;
                  }
                  if (mp.name?.startsWith('CanInvite')) member.canInvite = !!mp.value;
                  if (mp.name?.startsWith('CanKick')) member.canKick = !!mp.value;
                }
                if (member.steamId) clan.members.push(member);
              }
            }
          }
        }
        if (clan.name && clan.members.length > 0) clans.push(clan);
      }
    }
  }

  return clans;
}

module.exports = {
  parseSave,
  parseClanData,
  createPlayerData,
  simplifyBlueprint,
  PERK_MAP,
  PERK_INDEX_MAP,
  CLAN_RANK_MAP,
  SEASON_MAP,
  STAT_TAG_MAP,
};

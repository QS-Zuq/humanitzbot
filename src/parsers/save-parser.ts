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

import {
  createReader,
  parseHeader,
  readProperty,
  recoverForward,
  type GvasReader,
  type GvasProperty,
} from './gvas-reader.js';

// ─── Perk enum → display name ──────────────────────────────────────────────

const PERK_MAP: Record<string, string> = {
  'Enum_Professions::NewEnumerator0': 'Unemployed',
  'Enum_Professions::NewEnumerator1': 'Amateur Boxer',
  'Enum_Professions::NewEnumerator2': 'Farmer',
  'Enum_Professions::NewEnumerator3': 'Mechanic',
  'Enum_Professions::NewEnumerator9': 'Car Salesman',
  'Enum_Professions::NewEnumerator10': 'Outdoorsman',
  'Enum_Professions::NewEnumerator12': 'Chemist',
  'Enum_Professions::NewEnumerator13': 'Emergency Medical Technician',
  'Enum_Professions::NewEnumerator14': 'Military Veteran',
  'Enum_Professions::NewEnumerator15': 'Thief',
  'Enum_Professions::NewEnumerator16': 'Fire Fighter',
  'Enum_Professions::NewEnumerator17': 'Electrical Engineer',
};

const PERK_INDEX_MAP: Record<number, string> = Object.fromEntries(
  Object.entries(PERK_MAP).map(([k, v]) => {
    const num = parseInt(k.split('NewEnumerator')[1] ?? '0', 10);
    return [num, v];
  }),
);

// ─── Clan rank → display name ──────────────────────────────────────────────

const CLAN_RANK_MAP: Record<string, string> = {
  'E_ClanRank::NewEnumerator0': 'Recruit',
  'E_ClanRank::NewEnumerator1': 'Member',
  'E_ClanRank::NewEnumerator2': 'Officer',
  'E_ClanRank::NewEnumerator3': 'Co-Leader',
  'E_ClanRank::NewEnumerator4': 'Leader',
};

// ─── Season enum → display name ────────────────────────────────────────────

const SEASON_MAP: Record<string, string> = {
  'UDS_Season::NewEnumerator0': 'Spring',
  'UDS_Season::NewEnumerator1': 'Summer',
  'UDS_Season::NewEnumerator2': 'Autumn',
  'UDS_Season::NewEnumerator3': 'Winter',
};

// ─── Statistics tag path → player field mapping ────────────────────────────

const STAT_TAG_MAP: Record<string, string> = {
  'statistics.stat.game.kills.total': 'lifetimeKills',
  'statistics.stat.game.kills.headshot': 'lifetimeHeadshots',
  'statistics.stat.game.kills.type.melee': 'lifetimeMeleeKills',
  'statistics.stat.game.kills.type.ranged': 'lifetimeGunKills',
  'statistics.stat.game.kills.type.blast': 'lifetimeBlastKills',
  'statistics.stat.game.kills.type.unarmed': 'lifetimeFistKills',
  'statistics.stat.game.kills.type.takedown': 'lifetimeTakedownKills',
  'statistics.stat.game.kills.type.vehicle': 'lifetimeVehicleKills',
  'statistics.stat.progress.survivefor3days': 'lifetimeDaysSurvived',
  'statistics.stat.game.bitten': 'timesBitten',
  'statistics.stat.game.activity.FishCaught': 'fishCaught',
  'statistics.stat.game.activity.FishCaught.Pike': 'fishCaughtPike',
  'statistics.stat.challenge.KillSomeZombies': 'challengeKillZombies',
  'statistics.stat.progress.kill50zombies': 'challengeKill50',
  'statistics.stat.progress.catch20fish': 'challengeCatch20Fish',
  'statistics.stat.challenge.RegularAngler': 'challengeRegularAngler',
  'statistics.stat.challenge.KillZombieBear': 'challengeKillZombieBear',
  'statistics.stat.challenge.9SquaresToChaos': 'challenge9Squares',
  'statistics.stat.challenge.CraftFirearm': 'challengeCraftFirearm',
  'statistics.stat.challenge.CraftFurnace': 'challengeCraftFurnace',
  'statistics.stat.challenge.CraftMeleeBench': 'challengeCraftMeleeBench',
  'statistics.stat.challenge.CraftMeleeWeapon': 'challengeCraftMeleeWeapon',
  'statistics.stat.challenge.CraftRainCollector': 'challengeCraftRainCollector',
  'statistics.stat.challenge.CraftTablesaw': 'challengeCraftTablesaw',
  'statistics.stat.challenge.CraftTreatment': 'challengeCraftTreatment',
  'statistics.stat.challenge.CraftWeaponsBench': 'challengeCraftWeaponsBench',
  'statistics.stat.challenge.CraftWorkbench': 'challengeCraftWorkbench',
  'statistics.stat.challenge.FindCanineCompanion': 'challengeFindDog',
  'statistics.stat.challenge.FindCrashedHelicopter': 'challengeFindHeli',
  'statistics.stat.challenge.LockpickSurvivorSUV': 'challengeLockpickSUV',
  'statistics.stat.challenge.RepairRadioTower': 'challengeRepairRadio',
};

// ─── Simplify UE4 blueprint class names ────────────────────────────────────

function simplifyBlueprint(bp: string): string {
  if (!bp || typeof bp !== 'string') return bp;
  const match = bp.match(/BP_([^.]+?)(?:_C)?$/);
  if (match) return match[1] ?? bp;
  const parts = bp.split('/');
  const last = parts[parts.length - 1] ?? '';
  return last.replace(/_C$/, '').replace(/^BP_/, '');
}

// ─── Player data types ────────────────────────────────────────────────────

interface PlayerData {
  [key: string]: unknown;
  male: boolean;
  startingPerk: string;
  affliction: number;
  charProfile: Record<string, unknown>;
  zeeksKilled: number;
  headshots: number;
  meleeKills: number;
  gunKills: number;
  blastKills: number;
  fistKills: number;
  takedownKills: number;
  vehicleKills: number;
  lifetimeKills: number;
  lifetimeHeadshots: number;
  lifetimeMeleeKills: number;
  lifetimeGunKills: number;
  lifetimeBlastKills: number;
  lifetimeFistKills: number;
  lifetimeTakedownKills: number;
  lifetimeVehicleKills: number;
  lifetimeDaysSurvived: number;
  hasExtendedStats: boolean;
  daysSurvived: number;
  timesBitten: number;
  bites: number;
  fishCaught: number;
  fishCaughtPike: number;
  health: number;
  maxHealth: number;
  hunger: number;
  maxHunger: number;
  thirst: number;
  maxThirst: number;
  stamina: number;
  maxStamina: number;
  infection: number;
  maxInfection: number;
  battery: number;
  fatigue: number;
  infectionBuildup: number;
  wellRested: number;
  energy: number;
  hood: number;
  hypoHandle: number;
  exp: number;
  level: number;
  skillPoints: number;
  expCurrent: number;
  expRequired: number;
  x: number | null;
  y: number | null;
  z: number | null;
  rotationYaw: number | null;
  respawnX: number | null;
  respawnY: number | null;
  respawnZ: number | null;
  cbRadioCooldown: number;
  playerStates: unknown[];
  bodyConditions: unknown[];
  craftingRecipes: unknown[];
  buildingRecipes: unknown[];
  unlockedProfessions: unknown[];
  unlockedSkills: unknown[];
  skillsData: unknown[];
  skillTree: unknown[];
  inventory: unknown[];
  equipment: unknown[];
  quickSlots: unknown[];
  backpackItems: unknown[];
  backpackData: Record<string, unknown>;
  lore: unknown[];
  uniqueLoots: unknown[];
  craftedUniques: unknown[];
  lootItemUnique: unknown[];
  questData: unknown[];
  miniQuest: Record<string, unknown>;
  challenges: unknown[];
  questSpawnerDone: unknown[];
  companionData: unknown[];
  horses: unknown[];
  extendedStats: unknown[];
  challengeKillZombies: number;
  challengeKill50: number;
  challengeCatch20Fish: number;
  challengeRegularAngler: number;
  challengeKillZombieBear: number;
  challenge9Squares: number;
  challengeCraftFirearm: number;
  challengeCraftFurnace: number;
  challengeCraftMeleeBench: number;
  challengeCraftMeleeWeapon: number;
  challengeCraftRainCollector: number;
  challengeCraftTablesaw: number;
  challengeCraftTreatment: number;
  challengeCraftWeaponsBench: number;
  challengeCraftWorkbench: number;
  challengeFindDog: number;
  challengeFindHeli: number;
  challengeLockpickSUV: number;
  challengeRepairRadio: number;
  customData: Record<string, unknown>;
  dayIncremented: boolean;
  infectionTimer: unknown;
  backpackSize: number;
  characterProfile: string;
  skinTone: number;
  bSize: number;
  durability: number;
  dirtBlood: Record<string, unknown> | null;
  randColor: number;
  randHair: number;
  repUpper: string;
  repHead: string;
  repLower: string;
  repHand: string;
  repBoot: string;
  repFace: string;
  repFacial: number;
  badFood: number;
  skinBlood: number;
  skinDirt: number;
  clean: number;
  sleepers: number;
  floatData: Record<string, unknown>;
  name?: string;
}

// ─── Default player data template ──────────────────────────────────────────

function createPlayerData(): PlayerData {
  return {
    male: true,
    startingPerk: 'Unknown',
    affliction: 0,
    charProfile: {},
    zeeksKilled: 0,
    headshots: 0,
    meleeKills: 0,
    gunKills: 0,
    blastKills: 0,
    fistKills: 0,
    takedownKills: 0,
    vehicleKills: 0,
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
    daysSurvived: 0,
    timesBitten: 0,
    bites: 0,
    fishCaught: 0,
    fishCaughtPike: 0,
    health: 0,
    maxHealth: 0,
    hunger: 0,
    maxHunger: 0,
    thirst: 0,
    maxThirst: 0,
    stamina: 0,
    maxStamina: 0,
    infection: 0,
    maxInfection: 0,
    battery: 100,
    fatigue: 0,
    infectionBuildup: 0,
    wellRested: 0,
    energy: 0,
    hood: 0,
    hypoHandle: 0,
    exp: 0,
    level: 0,
    skillPoints: 0,
    expCurrent: 0,
    expRequired: 0,
    x: null,
    y: null,
    z: null,
    rotationYaw: null,
    respawnX: null,
    respawnY: null,
    respawnZ: null,
    cbRadioCooldown: 0,
    playerStates: [],
    bodyConditions: [],
    craftingRecipes: [],
    buildingRecipes: [],
    unlockedProfessions: [],
    unlockedSkills: [],
    skillsData: [],
    skillTree: [],
    inventory: [],
    equipment: [],
    quickSlots: [],
    backpackItems: [],
    backpackData: {},
    lore: [],
    uniqueLoots: [],
    craftedUniques: [],
    lootItemUnique: [],
    questData: [],
    miniQuest: {},
    challenges: [],
    questSpawnerDone: [],
    companionData: [],
    horses: [],
    extendedStats: [],
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
    customData: {},
    dayIncremented: false,
    infectionTimer: null,
    backpackSize: 0,
    characterProfile: '',
    skinTone: 0,
    bSize: 0,
    durability: 0,
    dirtBlood: null,
    randColor: 0,
    randHair: 0,
    repUpper: '',
    repHead: '',
    repLower: '',
    repHand: '',
    repBoot: '',
    repFace: '',
    repFacial: 0,
    badFood: 0,
    skinBlood: 0,
    skinDirt: 0,
    clean: 0,
    sleepers: 0,
    floatData: {},
  };
}

// ─── Result types ──────────────────────────────────────────────────────────

interface WorldState {
  [key: string]: unknown;
}

interface Structure {
  actorClass: string;
  displayName: string;
  ownerSteamId: string;
  x: number | null;
  y: number | null;
  z: number | null;
  currentHealth: number;
  maxHealth: number;
  upgradeLevel: number;
  attachedToTrailer: boolean;
  inventory: unknown[];
  noSpawn: boolean;
  extraData: string;
}

interface Vehicle {
  class: string;
  displayName: string;
  x: number | null;
  y: number | null;
  z: number | null;
  health: number;
  maxHealth: number;
  fuel: number;
  inventory: unknown[];
  upgrades: unknown[];
  extra: Record<string, unknown>;
}

interface Companion {
  type: string;
  actorName: string;
  ownerSteamId: string;
  x: number | null;
  y: number | null;
  z: number | null;
  health: number;
  extra: Record<string, unknown>;
}

interface DeadBody {
  actorName: string;
  x: number | null;
  y: number | null;
  z: number | null;
}

interface Container {
  actorName: string;
  items: unknown[];
  quickSlots: unknown[];
  x: number | null;
  y: number | null;
  z: number | null;
  locked: boolean;
  doesSpawnLoot: boolean;
  [key: string]: unknown;
}

interface LootActor {
  name: string;
  type: string;
  x: number | null;
  y: number | null;
  z: number | null;
  items: unknown[];
}

interface Quest {
  id: string;
  type: string;
  state: string;
  data: Record<string, unknown>;
}

interface Horse {
  class: string;
  displayName: string;
  x: number | null;
  y: number | null;
  z: number | null;
  health: number;
  maxHealth: number;
  energy: number;
  stamina: number;
  ownerSteamId: string;
  name: string;
  saddleInventory: unknown[];
  inventory: unknown[];
  extra: Record<string, unknown>;
}

interface ClanMember {
  name: string;
  steamId: string;
  rank: string;
  canInvite: boolean;
  canKick: boolean;
}

interface Clan {
  name: string;
  members: ClanMember[];
}

interface ParseResult {
  players: Map<string, PlayerData>;
  worldState: WorldState;
  structures: Structure[];
  vehicles: Vehicle[];
  companions: Companion[];
  deadBodies: DeadBody[];
  containers: Container[];
  lootActors: LootActor[];
  quests: Quest[];
  horses: Horse[];
  header: ReturnType<typeof parseHeader>;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Main parser
// ═══════════════════════════════════════════════════════════════════════════

function parseSave(buf: Buffer): ParseResult {
  const r = createReader(buf);
  const header = parseHeader(r);

  const players = new Map<string, PlayerData>();
  const worldState: WorldState = {};
  const structures: Structure[] = [];
  const vehicles: Vehicle[] = [];
  const companions: Companion[] = [];
  const deadBodies: DeadBody[] = [];
  const containers: Container[] = [];
  const lootActors: LootActor[] = [];
  const quests: Quest[] = [];
  const horses: Horse[] = [];

  let buildActorClasses: string[] = [];
  let buildActorHealths: number[] = [];
  let buildActorMaxHealths: number[] = [];
  let buildActorUpgrades: number[] = [];
  let buildActorTrailer: boolean[] = [];
  let buildActorStrings: string[] = [];
  let buildActorData: string[] = [];
  let buildActorNoSpawn: unknown[][] = [];
  let buildActorInventories: unknown[][] = [];
  let buildActorTransformCount = 0;
  let buildActorTransforms: Array<{ x: number; y: number; z: number } | null> = [];

  let currentSteamID: string | null = null;

  function ensurePlayer(id: string): PlayerData {
    const existing = players.get(id);
    if (existing) return existing;
    const fresh = createPlayerData();
    players.set(id, fresh);
    return fresh;
  }

  function prescanSteamId(props: GvasProperty[]): void {
    for (const prop of props) {
      if (prop.name === 'SteamID' && typeof prop.value === 'string') {
        const match = prop.value.match(/(7656\d+)/);
        if (match) {
          currentSteamID = match[1] ?? null;
          return;
        }
      }
    }
  }

  function handleProp(prop: GvasProperty | null | undefined): void {
    if (!prop) return;
    const n = prop.name;

    if (n === 'SteamID' && typeof prop.value === 'string') {
      const match = prop.value.match(/(7656\d+)/);
      if (match) currentSteamID = match[1] ?? null;
    }

    if (prop.children) {
      prescanSteamId(prop.children);
      for (const child of prop.children) {
        handleProp(child);
      }
    }

    // Statistics array extraction
    if (
      Array.isArray(prop.value) &&
      (prop.value as unknown[]).length > 0 &&
      Array.isArray((prop.value as unknown[])[0])
    ) {
      if (n === 'Statistics' && currentSteamID) {
        _extractStatistics(prop.value as unknown[][], ensurePlayer(currentSteamID));
      }
      if (n === 'ExtendedStats' && currentSteamID) {
        _extractExtendedStats(prop.value as unknown[][], ensurePlayer(currentSteamID));
      }

      if (n === 'Tree' && currentSteamID) {
        const p = ensurePlayer(currentSteamID);
        const allSkills: unknown[] = [];
        p.skillTree = (prop.value as GvasProperty[][])
          .map((elemProps) => {
            if (!Array.isArray(elemProps)) return null;
            const node: Record<string, unknown> = {};
            for (const ep of elemProps) {
              if (ep.name === 'Type') node['type'] = ep.value;
              else if (ep.name === 'Index') node['index'] = ep.value;
              else if (ep.name === 'Locked?') node['locked'] = ep.value;
              else if (ep.name === 'NeedSpecialUnlock?') node['needSpecialUnlock'] = ep.value;
              else if (ep.name === 'Exp') node['exp'] = ep.value;
              else if (ep.name === 'ExpNeeded') node['expNeeded'] = ep.value;
              else if (ep.name === 'UnlockedSkills' && Array.isArray(ep.value)) {
                node['unlockedSkills'] = (ep.value as unknown[]).filter(Boolean);
                for (const s of node['unlockedSkills'] as unknown[]) {
                  allSkills.push(s);
                }
              } else if (ep.name === 'UnlockProgress' && Array.isArray(ep.value)) node['unlockProgress'] = ep.value;
            }
            return node;
          })
          .filter(Boolean);
        if (allSkills.length) p.unlockedSkills = allSkills;
        return;
      }

      for (const elemProps of prop.value as unknown[]) {
        if (Array.isArray(elemProps)) {
          prescanSteamId(elemProps as GvasProperty[]);
          for (const ep of elemProps as GvasProperty[]) {
            handleProp(ep);
          }
        }
      }
      if (n === 'DropInSaves') currentSteamID = null;
    }

    // ── WORLD-LEVEL PROPERTIES ──

    if (n === 'BuildActorClass' && Array.isArray(prop.value)) {
      buildActorClasses = prop.value as string[];
      return;
    }
    if (n === 'BuildActorTransform') {
      if (Array.isArray(prop.value)) {
        buildActorTransforms = (prop.value as GvasProperty[][]).map((elem) => {
          if (Array.isArray(elem)) {
            const t = elem.find((c: GvasProperty) => c.name === 'Translation');
            return (t?.value as { x: number; y: number; z: number } | undefined) ?? null;
          }
          return null;
        });
        buildActorTransformCount = (prop.value as unknown[]).length;
      } else if (typeof prop.value === 'string' && prop.value.startsWith('<skipped')) {
        const m = prop.value.match(/\d+/);
        buildActorTransformCount = m?.[0] ? parseInt(m[0], 10) : 0;
      }
      return;
    }
    if (n === 'BuildingCurrentHealth' && Array.isArray(prop.value)) {
      buildActorHealths = prop.value as number[];
      return;
    }
    if (n === 'BuildingMaxHealth' && Array.isArray(prop.value)) {
      buildActorMaxHealths = prop.value as number[];
      return;
    }
    if (n === 'BuildingUpgradeLv' && Array.isArray(prop.value)) {
      buildActorUpgrades = prop.value as number[];
      return;
    }
    if (n === 'AttachedToTrailer' && Array.isArray(prop.value)) {
      buildActorTrailer = prop.value as boolean[];
      return;
    }
    if (n === 'BuildingStr' && Array.isArray(prop.value)) {
      buildActorStrings = prop.value as string[];
      return;
    }
    if (n === 'BuildActorData' && Array.isArray(prop.value)) {
      buildActorData = prop.value as string[];
      return;
    }
    if (n === 'BuildActorsNoSpawn' && Array.isArray(prop.value)) {
      buildActorNoSpawn = prop.value as unknown[][];
      return;
    }
    if (n === 'BuildActorInventory' && Array.isArray(prop.value)) {
      buildActorInventories = prop.value as unknown[][];
      return;
    }

    if (n === 'Cars' && Array.isArray(prop.value)) {
      _extractVehicles(prop.value as GvasProperty[][], vehicles);
      return;
    }

    if (n === 'Dogs' && Array.isArray(prop.value)) {
      for (const name of prop.value as string[]) {
        if (name && typeof name === 'string') {
          companions.push({
            type: 'dog',
            actorName: name,
            ownerSteamId: '',
            x: null,
            y: null,
            z: null,
            health: 0,
            extra: {},
          });
        }
      }
      return;
    }

    if (n === 'DeadBodies' && Array.isArray(prop.value)) {
      for (const name of prop.value as string[]) {
        if (name && typeof name === 'string') {
          deadBodies.push({ actorName: name, x: null, y: null, z: null });
        }
      }
      return;
    }

    if (n === 'ExplodableBarrels' && Array.isArray(prop.value)) {
      worldState['explodableBarrels'] = prop.value;
      return;
    }
    if (n === 'GennyPowerLevel' && Array.isArray(prop.value)) {
      worldState['generatorPowerLevels'] = prop.value;
      return;
    }
    if (n === 'HorseData' && Array.isArray(prop.value)) {
      _extractHorses(prop.value as GvasProperty[][], horses);
      return;
    }

    if (n === 'LODPickups' && Array.isArray(prop.value)) {
      worldState['lodPickups'] = [];
      for (const elemProps of prop.value as GvasProperty[][]) {
        if (!Array.isArray(elemProps)) continue;
        const pickup: Record<string, unknown> = {
          valid: false,
          x: null,
          y: null,
          z: null,
          item: '',
          amount: 0,
          durability: 0,
          worldLoot: false,
          placed: false,
          spawned: false,
        };
        for (const ep of elemProps) {
          if (ep.name === 'Valid?' && ep.value) pickup['valid'] = true;
          if (ep.name === 'WorldLoot?' && ep.value) pickup['worldLoot'] = true;
          if (ep.name === 'PlacedItem?' && ep.value) pickup['placed'] = true;
          if (ep.name === 'Spawned?' && ep.value) pickup['spawned'] = true;
          if (ep.name === 'Transform') {
            const tv = ep.value as { translation?: { x: number; y: number; z: number } } | null;
            if (tv?.translation) {
              pickup['x'] = _round2(tv.translation.x);
              pickup['y'] = _round2(tv.translation.y);
              pickup['z'] = _round2(tv.translation.z);
            }
          }
          if (ep.name === 'Info' && ep.children) {
            for (const ic of ep.children) {
              if (ic.name === 'Item' && ic.children) {
                for (const icc of ic.children) {
                  if (icc.name === 'RowName' && typeof icc.value === 'string') pickup['item'] = icc.value;
                }
              }
              if (ic.name === 'Amount' && typeof ic.value === 'number') pickup['amount'] = ic.value;
              if (ic.name === 'Durability' && typeof ic.value === 'number') pickup['durability'] = _round(ic.value);
            }
          }
        }
        if (pickup['valid'] && pickup['item']) (worldState['lodPickups'] as unknown[]).push(pickup);
      }
      worldState['totalLodPickups'] = (worldState['lodPickups'] as unknown[]).length;
      return;
    }

    if (n === 'SavedActors' && Array.isArray(prop.value)) {
      worldState['savedActors'] = [];
      for (const elemProps of prop.value as GvasProperty[][]) {
        if (!Array.isArray(elemProps)) continue;
        const actor: Record<string, unknown> = {
          class: '',
          displayName: '',
          x: null,
          y: null,
          z: null,
          health: 0,
          ownerSteamId: '',
          locked: false,
          dtName: '',
        };
        for (const ap of elemProps) {
          if (ap.name === 'Class') {
            actor['class'] = ap.value ?? '';
            actor['displayName'] = simplifyBlueprint((ap.value as string | undefined) ?? '');
          }
          if (ap.name === 'Transform') {
            const tv = ap.value as { translation?: { x: number; y: number; z: number } } | null;
            if (tv?.translation) {
              actor['x'] = _round2(tv.translation.x);
              actor['y'] = _round2(tv.translation.y);
              actor['z'] = _round2(tv.translation.z);
            }
          }
          if (ap.name === 'Health' && typeof ap.value === 'number') actor['health'] = _round(ap.value);
          if (ap.name === 'Owner' && typeof ap.value === 'string') {
            const m = ap.value.match(/(7656\d+)/);
            if (m) actor['ownerSteamId'] = m[1];
          }
          if (ap.name === 'DTName') actor['dtName'] = ap.value ?? '';
          if (ap.name === 'Locked?') actor['locked'] = !!ap.value;
        }
        (worldState['savedActors'] as unknown[]).push(actor);
      }
      return;
    }

    if (n === 'NodeSaveData' && Array.isArray(prop.value)) {
      worldState['nodeSaveDataCount'] = (prop.value as unknown[]).length;
      worldState['aiSpawns'] = [];
      for (const entry of prop.value as GvasProperty[][]) {
        if (!Array.isArray(entry)) continue;
        const nodeUid = entry.find((c: GvasProperty) => c.name === 'NodeUID');
        const data = entry.find((c: GvasProperty) => c.name === 'Data');
        if (!data?.value || !Array.isArray(data.value)) continue;
        for (const aiInfo of data.value as GvasProperty[][]) {
          if (!Array.isArray(aiInfo)) continue;
          const aiType = aiInfo.find((c: GvasProperty) => c.name === 'AIType')?.value as string | undefined;
          const aiLoc = aiInfo.find((c: GvasProperty) => c.name === 'AILocation')?.value as
            | { x: number; y: number; z: number }
            | undefined;
          const graveTime = aiInfo.find((c: GvasProperty) => c.name === 'GraveTimeMinutes')?.value as
            | number
            | undefined;
          if (!aiType || aiType === 'EAItype::E_None') continue;
          const typeName = aiType.replace('EAItype::E_', '');
          let category = 'zombie';
          if (typeName.startsWith('Animal')) category = 'animal';
          else if (typeName.startsWith('Bandit')) category = 'bandit';
          (worldState['aiSpawns'] as unknown[]).push({
            type: typeName,
            category,
            nodeUid: nodeUid?.value ?? '',
            x: aiLoc ? _round2(aiLoc.x) : null,
            y: aiLoc ? _round2(aiLoc.y) : null,
            z: aiLoc ? _round2(aiLoc.z) : null,
            graveTimeMinutes: typeof graveTime === 'number' ? graveTime : 0,
          });
        }
      }
      worldState['aiSummary'] = { zombies: 0, bandits: 0, animals: 0, byType: {} as Record<string, number> };
      const summary = worldState['aiSummary'] as {
        zombies: number;
        bandits: number;
        animals: number;
        byType: Record<string, number>;
      };
      for (const ai of worldState['aiSpawns'] as Array<{ category: string; type: string }>) {
        if (ai.category === 'zombie') summary.zombies++;
        else if (ai.category === 'bandit') summary.bandits++;
        else if (ai.category === 'animal') summary.animals++;
        summary.byType[ai.type] = (summary.byType[ai.type] ?? 0) + 1;
      }
      return;
    }

    if (n === 'DestroyedSleepers' && Array.isArray(prop.value)) {
      worldState['destroyedSleepers'] = (prop.value as unknown[]).length;
      worldState['destroyedSleeperIds'] = prop.value;
      return;
    }
    if (n === 'DestroyedRandCars') {
      if (Array.isArray(prop.value)) {
        worldState['destroyedRandCars'] = (prop.value as unknown[]).length;
        worldState['destroyedRandCarPositions'] = (prop.value as Array<{ x: number; y: number; z: number } | null>)
          .map((elem) => {
            if (elem && typeof elem.x === 'number') {
              return { x: _round2(elem.x), y: _round2(elem.y), z: _round2(elem.z) };
            }
            return null;
          })
          .filter(Boolean);
      } else if (typeof prop.value === 'string' && prop.value.startsWith('<skipped')) {
        worldState['destroyedRandCars'] = parseInt(prop.value.match(/\d+/)?.[0] ?? '0', 10);
      } else {
        worldState['destroyedRandCars'] = 0;
      }
      return;
    }

    if (n === 'SaveID' && typeof prop.value === 'number') {
      worldState['saveId'] = prop.value;
      return;
    }
    if (n === 'ContainerData') {
      _extractContainers(prop, containers);
      return;
    }
    if (n === 'ModularLootActor') {
      _extractLootActors(prop, lootActors);
      return;
    }

    if (n === 'StoneCutting') {
      worldState['stoneCuttingStations'] = Array.isArray(prop.value) ? (prop.value as unknown[]).length : 0;
      if (Array.isArray(prop.value)) {
        worldState['stoneCuttingData'] = (prop.value as GvasProperty[][])
          .map((elemProps) => {
            if (!Array.isArray(elemProps)) return null;
            const station: Record<string, unknown> = { name: '', stage: 0, time: 0 };
            for (const ep of elemProps) {
              if (ep.name === 'Name') station['name'] = ep.value ?? '';
              if (ep.name === 'Stage' && typeof ep.value === 'number') station['stage'] = ep.value;
              if (ep.name === 'Time' && typeof ep.value === 'number') station['time'] = _round(ep.value);
            }
            return station;
          })
          .filter(Boolean);
      }
      return;
    }

    if (n === 'PreBuildActors') {
      worldState['preBuildActors'] = [];
      if (Array.isArray(prop.value)) {
        for (const elemProps of prop.value as GvasProperty[][]) {
          if (!Array.isArray(elemProps)) continue;
          const actor: Record<string, unknown> = {
            class: '',
            displayName: '',
            x: null,
            y: null,
            z: null,
            resources: {},
          };
          for (const ep of elemProps) {
            if (ep.name === 'Class') {
              actor['class'] = ep.value ?? '';
              actor['displayName'] = simplifyBlueprint((ep.value as string | undefined) ?? '');
            }
            if (ep.name === 'Transform') {
              const tv = ep.value as { translation?: { x: number; y: number; z: number } } | null;
              if (tv?.translation) {
                actor['x'] = _round2(tv.translation.x);
                actor['y'] = _round2(tv.translation.y);
                actor['z'] = _round2(tv.translation.z);
              }
            }
            if (ep.name === 'Resources' && ep.value) actor['resources'] = ep.value;
          }
          (worldState['preBuildActors'] as unknown[]).push(actor);
        }
      }
      worldState['preBuildActorCount'] = (worldState['preBuildActors'] as unknown[]).length;
      return;
    }

    if (n === 'SGlobalContainerSave') {
      worldState['globalContainers'] = [];
      if (Array.isArray(prop.value)) {
        for (const entry of prop.value as Array<{ value?: GvasProperty[] } | null>) {
          if (!entry?.value) continue;
          const props = Array.isArray(entry.value) ? entry.value : [];
          const container: Record<string, unknown> = {
            actorName: '',
            items: [],
            quickSlots: [],
            locked: false,
            doesSpawnLoot: false,
          };
          for (const cp of props) {
            if (cp.name === 'ContainerActor') container['actorName'] = cp.value ?? '';
            if (cp.name === 'ContainerInventoryArray' && Array.isArray(cp.value)) container['items'] = cp.value;
            if (cp.name === 'ContainerQuickSlotArray' && Array.isArray(cp.value)) container['quickSlots'] = cp.value;
            if (cp.name === 'DoesSpawnLoot') container['doesSpawnLoot'] = !!cp.value;
            if (cp.name === 'Locked?') container['locked'] = !!cp.value;
          }
          if ((container['items'] as unknown[]).length > 0 || (container['quickSlots'] as unknown[]).length > 0) {
            (worldState['globalContainers'] as unknown[]).push(container);
          }
        }
      }
      worldState['totalGlobalContainers'] = (worldState['globalContainers'] as unknown[]).length;
      return;
    }

    if (n === 'LodModularLootActor') {
      worldState['modularLootActors'] = [];
      worldState['modularLootSlotCount'] = 0;
      if (Array.isArray(prop.value)) {
        for (const entry of prop.value as Array<{ key?: GvasProperty[]; value?: GvasProperty[] } | null>) {
          if (!entry) continue;
          const entryProps = [...(entry.key ?? []), ...(entry.value ?? [])];
          if (entryProps.length === 0) continue;
          const actor: Record<string, unknown> = { name: '', disabled: false, spawned: false, slots: [] };
          for (const cp of entryProps) {
            if (cp.name === 'Name') actor['name'] = cp.value ?? '';
            if (cp.name === 'Disabled?') actor['disabled'] = !!cp.value;
            if (cp.name === 'Spawned?') actor['spawned'] = !!cp.value;
            if (cp.name === 'Slots' && Array.isArray(cp.value)) {
              for (const slot of cp.value as GvasProperty[][]) {
                if (!Array.isArray(slot)) continue;
                const s: Record<string, unknown> = { supportedItems: [], itemId: '', count: 0, durability: 0 };
                for (const sp of slot) {
                  if (sp.name === 'SupportedItems' && Array.isArray(sp.value)) s['supportedItems'] = sp.value;
                  if (sp.name === 'ItemID') s['itemId'] = sp.value ?? '';
                  if (sp.name === 'Count' && typeof sp.value === 'number') s['count'] = sp.value;
                  if (sp.name === 'Dur' && typeof sp.value === 'number') s['durability'] = _round(sp.value);
                }
                (actor['slots'] as unknown[]).push(s);
                worldState['modularLootSlotCount'] = (worldState['modularLootSlotCount'] as number) + 1;
              }
            }
          }
          (worldState['modularLootActors'] as unknown[]).push(actor);
        }
      }
      worldState['totalModularLootActors'] = (worldState['modularLootActors'] as unknown[]).length;
      return;
    }

    if (n === 'ExtraParams' && Array.isArray(prop.value)) {
      worldState['_extraParams'] = prop.value;
      return;
    }
    if (n === 'BuildingDecay' && Array.isArray(prop.value)) {
      worldState['buildingDecayCount'] = (prop.value as unknown[]).length;
      let decaying = 0;
      for (const v of prop.value as number[]) {
        if (typeof v === 'number' && v > 0) decaying++;
      }
      worldState['buildingDecayActive'] = decaying;
      return;
    }

    if (n === 'ExplodableBarrelsTransform' && Array.isArray(prop.value)) {
      worldState['explodableBarrelPositions'] = (prop.value as GvasProperty[][])
        .map((elem) => {
          if (Array.isArray(elem)) {
            const t = elem.find((c: GvasProperty) => c.name === 'Translation');
            const tv = t?.value as { x: number; y: number; z: number } | undefined;
            if (tv) return { x: _round2(tv.x), y: _round2(tv.y), z: _round2(tv.z) };
          }
          return null;
        })
        .filter(Boolean);
      return;
    }

    if (n === 'LOD_Pickup_Disabled' && Array.isArray(prop.value)) {
      worldState['lodPickupDisabled'] = prop.value;
      return;
    }
    if (n === 'LOD_Backpack_Disabled' && Array.isArray(prop.value)) {
      worldState['lodBackpackDisabled'] = prop.value;
      return;
    }
    if (n === 'LOD_PreB_Disabled' && Array.isArray(prop.value)) {
      worldState['lodPreBDisabled'] = prop.value;
      return;
    }

    if (n === 'LODHouseData' && Array.isArray(prop.value)) {
      worldState['houses'] = [];
      for (const entry of prop.value as Array<{ key?: GvasProperty[]; value?: GvasProperty[] } | null>) {
        if (!entry) continue;
        const entryProps = [...(entry.key ?? []), ...(entry.value ?? [])];
        if (entryProps.length === 0) continue;
        const house: Record<string, unknown> = {
          uid: '',
          name: '',
          windowsOpen: 0,
          windowsTotal: 0,
          doorsOpen: 0,
          doorsLocked: 0,
          doorsTotal: 0,
          destroyedFurniture: 0,
          hasGenerator: false,
          randomSeed: 0,
          floatData: {},
        };
        for (const hp of entryProps) {
          if (hp.name === 'UID') house['uid'] = hp.value ?? '';
          if (hp.name === 'Name') house['name'] = hp.value ?? '';
          if (hp.name === 'Windows' && Array.isArray(hp.value)) {
            house['windowsTotal'] = (hp.value as unknown[]).length;
            house['windowsOpen'] = (hp.value as boolean[]).filter(Boolean).length;
          }
          if (hp.name === 'DoorsOpened' && Array.isArray(hp.value)) {
            house['doorsTotal'] = (hp.value as unknown[]).length;
            house['doorsOpen'] = (hp.value as boolean[]).filter(Boolean).length;
          }
          if (hp.name === 'DoorsLocked' && Array.isArray(hp.value)) {
            house['doorsLocked'] = (hp.value as boolean[]).filter(Boolean).length;
          }
          if (hp.name === 'DestroyedFurniture' && Array.isArray(hp.value)) {
            house['destroyedFurniture'] = (hp.value as unknown[]).length;
          }
          if (hp.name === 'HasGenerator?') house['hasGenerator'] = !!hp.value;
          if (hp.name === 'RandomSeed' && typeof hp.value === 'number') house['randomSeed'] = hp.value;
          if (hp.name === 'FloatData' && hp.value && typeof hp.value === 'object') house['floatData'] = hp.value;
        }
        if (house['name']) (worldState['houses'] as unknown[]).push(house);
      }
      worldState['totalHouses'] = (worldState['houses'] as unknown[]).length;
      return;
    }

    if (n === 'FoliageBerry') {
      worldState['foliageBerry'] = prop.children ?? prop.value;
      return;
    }

    if (n === 'HZActorManagerData') {
      if (prop.children) {
        const mgr: Record<string, unknown> = { destroyedActors: [], destroyedInstances: [] };
        for (const c of prop.children) {
          if (c.name === 'DestroyedActorProps' && Array.isArray(c.value)) mgr['destroyedActors'] = c.value;
          if (c.name === 'DestroyedInstances' && Array.isArray(c.value)) {
            for (const inst of c.value as GvasProperty[][]) {
              if (!Array.isArray(inst)) continue;
              const entry: Record<string, unknown> = { compTag: '', indices: [] };
              for (const ip of inst) {
                if (ip.name === 'CompTag') entry['compTag'] = ip.value ?? '';
                if (ip.name === 'DestroyedInstanceIndices' && Array.isArray(ip.value)) entry['indices'] = ip.value;
              }
              if (entry['compTag']) (mgr['destroyedInstances'] as unknown[]).push(entry);
            }
          }
        }
        worldState['actorManagerData'] = mgr;
      } else {
        worldState['actorManagerData'] = prop.value;
      }
      return;
    }

    if (n === 'BackpackData' && Array.isArray(prop.value) && !currentSteamID) {
      worldState['droppedBackpacks'] = [];
      for (const elemProps of prop.value as GvasProperty[][]) {
        if (!Array.isArray(elemProps)) continue;
        const backpack: Record<string, unknown> = { x: null, y: null, z: null, items: [], class: '' };
        for (const bp of elemProps) {
          if (bp.name === 'BackpackTransform') {
            const tv = bp.value as { translation?: { x: number; y: number; z: number } } | null;
            if (tv?.translation) {
              backpack['x'] = _round2(tv.translation.x);
              backpack['y'] = _round2(tv.translation.y);
              backpack['z'] = _round2(tv.translation.z);
            }
          }
          if (bp.name === 'BackpackClass') backpack['class'] = bp.value ?? '';
          if (bp.name === 'EquippedBackpack') backpack['equipped'] = !!bp.value;
          if (bp.name === 'BackpackInventory' && Array.isArray(bp.value)) backpack['items'] = bp.value;
        }
        if (backpack['x'] !== null) (worldState['droppedBackpacks'] as unknown[]).push(backpack);
      }
      worldState['totalDroppedBackpacks'] = (worldState['droppedBackpacks'] as unknown[]).length;
      return;
    }

    if (n === 'SpawnedHeliCrash' && Array.isArray(prop.value)) {
      worldState['heliCrashData'] = prop.value;
      return;
    }
    if (n === 'HeliCrashSpawnDay' && typeof prop.value === 'number') {
      worldState['heliCrashSpawnDay'] = prop.value;
      return;
    }
    if (n === 'QuestSavedData') {
      _extractWorldQuests(prop, quests);
      return;
    }
    if (n === 'RandQuestConfig' && prop.value && typeof prop.value === 'object') {
      worldState['questConfig'] = prop.value;
      return;
    }

    if (n === 'Airdrop') {
      worldState['airdropActive'] = true;
      if (prop.children) {
        const airdrop: Record<string, unknown> = {};
        for (const c of prop.children) {
          if (c.name === 'Loc') {
            const tv = c.value as { translation?: { x: number; y: number; z: number } } | null;
            if (tv?.translation) {
              airdrop['x'] = _round2(tv.translation.x);
              airdrop['y'] = _round2(tv.translation.y);
              airdrop['z'] = _round2(tv.translation.z);
            }
          }
          if (c.name === 'LifeSpan' && typeof c.value === 'number') airdrop['lifeSpan'] = _round(c.value);
          if (c.name === 'AIAlive' && typeof c.value === 'number') airdrop['aiAlive'] = c.value;
          if (c.name === 'UID') airdrop['uid'] = c.value;
        }
        worldState['airdrop'] = airdrop;
      }
      return;
    }

    if (n === 'DropInSaves' && Array.isArray(prop.value)) {
      const dropIns: string[] = [];
      for (const elemProps of prop.value as GvasProperty[][]) {
        if (!Array.isArray(elemProps)) continue;
        for (const ep of elemProps) {
          if (ep.name === 'SteamID' && typeof ep.value === 'string') {
            const m = ep.value.match(/(7656\d+)/);
            if (m?.[1]) dropIns.push(m[1]);
          }
        }
      }
      worldState['dropInSaves'] = dropIns;
      return;
    }

    if (n === 'UniqueSpawners') {
      worldState['uniqueSpawnerCount'] = Array.isArray(prop.value) ? (prop.value as unknown[]).length : 0;
      worldState['uniqueSpawnerIds'] = Array.isArray(prop.value) ? prop.value : [];
      return;
    }

    if (n === 'Dedi_DaysPassed' && typeof prop.value === 'number') {
      worldState['daysPassed'] = prop.value;
      return;
    }
    if (n === 'CurrentSeason') {
      worldState['currentSeason'] = SEASON_MAP[prop.value as string] ?? prop.value;
      return;
    }
    if (n === 'CurrentSeasonDay' && typeof prop.value === 'number') {
      worldState['currentSeasonDay'] = prop.value;
      return;
    }
    if (n === 'RandomSeed' && typeof prop.value === 'number') {
      worldState['randomSeed'] = prop.value;
      return;
    }
    if (n === 'UsesSteamUID') {
      worldState['usesSteamUid'] = !!prop.value;
      return;
    }

    if (n === 'GameDiff') {
      if (prop.children) {
        const diff: Record<string, unknown> = {};
        for (const c of prop.children) {
          if (c.name === 'LootAmontMultiplier' && typeof c.value === 'number') diff['lootMultiplier'] = c.value;
          if (c.name === 'LootRespawnTimer' && typeof c.value === 'number') diff['lootRespawnTimer'] = c.value;
          if (c.name === 'ZombieAmountMultiplier' && typeof c.value === 'number') diff['zombieMultiplier'] = c.value;
          if (c.name === 'DayDuration' && typeof c.value === 'number') diff['dayDuration'] = c.value;
          if (c.name === 'StartingSeason') diff['startingSeason'] = SEASON_MAP[c.value as string] ?? c.value;
          if (c.name === 'DaysPerSeason' && typeof c.value === 'number') diff['daysPerSeason'] = c.value;
          if (c.name === 'StartingDayNight' && typeof c.value === 'number') diff['startingDayNight'] = c.value;
          if (c.name === 'AirDropDays' && typeof c.value === 'number') diff['airdropDays'] = c.value;
          if (c.name === 'ZombieDiff' && typeof c.value === 'number') diff['zombieDifficulty'] = c.value;
          if (c.name === 'Params') diff['params'] = c.value;
        }
        worldState['gameDifficulty'] = diff;
      } else {
        worldState['gameDifficulty'] = prop.value;
      }
      return;
    }

    if (n === 'UDSandUDWsave') {
      worldState['weatherState'] = prop.children ?? prop.value;
      const ws = worldState['weatherState'];
      if (Array.isArray(ws)) {
        for (const c of ws as GvasProperty[]) {
          if (c.name === 'TotalDaysElapsed' && typeof c.value === 'number') worldState['totalDaysElapsed'] = c.value;
          if (c.name === 'TimeofDay' && typeof c.value === 'number')
            worldState['timeOfDay'] = Math.round(c.value * 100) / 100;
        }
      }
      return;
    }

    // ── PLAYER-LEVEL PROPERTIES ──

    if (!currentSteamID) return;
    const p = ensurePlayer(currentSteamID);

    if (n === 'DayzSurvived' && typeof prop.value === 'number') p.daysSurvived = prop.value;
    if (n === 'Affliction' && typeof prop.value === 'number') p.affliction = prop.value;
    if (n === 'Male') p.male = !!prop.value;
    if (n === 'DayIncremented') p.dayIncremented = !!prop.value;
    if (n === 'Backpack' && typeof prop.value === 'number') p.backpackSize = prop.value;
    if (n === 'Profile') p.characterProfile = (prop.value as string) || '';
    if (n === 'Skin' && typeof prop.value === 'number') p.skinTone = prop.value;
    if (n === 'BSize' && typeof prop.value === 'number') p.bSize = prop.value;
    if (n === 'Dur' && typeof prop.value === 'number') p.durability = prop.value;
    if (n === 'DirtBlood' && prop.children) p.dirtBlood = _childrenToObject(prop.children);
    if (n === 'RandColor' && typeof prop.value === 'number') p.randColor = prop.value;
    if (n === 'RandHair' && typeof prop.value === 'number') p.randHair = prop.value;
    if (n === 'RepUpper') p.repUpper = (prop.value as string) || '';
    if (n === 'RepHead') p.repHead = (prop.value as string) || '';
    if (n === 'RepLower') p.repLower = (prop.value as string) || '';
    if (n === 'RepHand') p.repHand = (prop.value as string) || '';
    if (n === 'RepBoot') p.repBoot = (prop.value as string) || '';
    if (n === 'RepFace') p.repFace = (prop.value as string) || '';
    if (n === 'RepFacial' && typeof prop.value === 'number') p.repFacial = prop.value;
    if (n === 'Bites' && typeof prop.value === 'number') p.bites = prop.value;
    if (n === 'CBRadioCooldown' && typeof prop.value === 'number') p.cbRadioCooldown = prop.value;

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

    if (n === 'Exp') {
      if (typeof prop.value === 'number') {
        p.exp = _round(prop.value);
      } else if (prop.children) {
        for (const ec of prop.children) {
          if (ec.name === 'XPGained' && typeof ec.value === 'number') p.exp = ec.value;
          if (ec.name === 'Level' && typeof ec.value === 'number') p.level = ec.value;
          if (ec.name === 'SkillsPoint' && typeof ec.value === 'number') p.skillPoints = ec.value;
          if (ec.name === 'Current' && typeof ec.value === 'number') p.expCurrent = _round(ec.value);
          if (ec.name === 'Required' && typeof ec.value === 'number') p.expRequired = _round(ec.value);
        }
      }
    }

    if (n === 'InfectionTimer') p.infectionTimer = prop.value ?? null;

    if (n === 'StartingPerk') {
      let mapped: string | undefined;
      if (typeof prop.value === 'string') mapped = PERK_MAP[prop.value];
      else if (typeof prop.value === 'number') mapped = PERK_INDEX_MAP[prop.value];
      if (mapped) p.startingPerk = mapped;
    }

    if (n === 'GameStats' && prop.value && typeof prop.value === 'object') {
      const gs = prop.value as Record<string, number | undefined>;
      if (gs['ZeeksKilled'] !== undefined) p.zeeksKilled = gs['ZeeksKilled'];
      if (gs['HeadShot'] !== undefined) p.headshots = gs['HeadShot'];
      if (gs['MeleeKills'] !== undefined) p.meleeKills = gs['MeleeKills'];
      if (gs['GunKills'] !== undefined) p.gunKills = gs['GunKills'];
      if (gs['BlastKills'] !== undefined) p.blastKills = gs['BlastKills'];
      if (gs['FistKills'] !== undefined) p.fistKills = gs['FistKills'];
      if (gs['TakedownKills'] !== undefined) p.takedownKills = gs['TakedownKills'];
      if (gs['VehicleKills'] !== undefined) p.vehicleKills = gs['VehicleKills'];
      if (gs['DaysSurvived'] !== undefined && gs['DaysSurvived'] > 0) p.daysSurvived = gs['DaysSurvived'];
    }

    if (n === 'FloatData' && prop.value && typeof prop.value === 'object') {
      const fd = prop.value as Record<string, number | undefined>;
      if (fd['Fatigue'] !== undefined) p.fatigue = _round2(fd['Fatigue']);
      if (fd['InfectionBuildup'] !== undefined) p.infectionBuildup = Math.round(fd['InfectionBuildup']);
      if (fd['WellRested'] !== undefined) p.wellRested = _round2(fd['WellRested']);
      if (fd['Energy'] !== undefined) p.energy = _round2(fd['Energy']);
      if (fd['Hood'] !== undefined) p.hood = _round2(fd['Hood']);
      if (fd['HypoHandle'] !== undefined) p.hypoHandle = _round2(fd['HypoHandle']);
      if (fd['BadFood'] !== undefined) p.badFood = _round2(fd['BadFood']);
      if (fd['Skin_Blood'] !== undefined) p.skinBlood = _round2(fd['Skin_Blood']);
      if (fd['Skin_Dirt'] !== undefined) p.skinDirt = _round2(fd['Skin_Dirt']);
      if (fd['Clean'] !== undefined) p.clean = _round2(fd['Clean']);
      if (fd['Sleepers'] !== undefined) p.sleepers = _round2(fd['Sleepers']);
      p.floatData = fd;
    }

    if (n === 'CustomData' && prop.value && typeof prop.value === 'object')
      p.customData = prop.value as Record<string, unknown>;

    if (n === 'Recipe_Crafting' && Array.isArray(prop.value))
      p.craftingRecipes = (prop.value as unknown[]).filter(Boolean);
    if (n === 'Recipe_Building' && Array.isArray(prop.value))
      p.buildingRecipes = (prop.value as unknown[]).filter(Boolean);
    if (n === 'PlayerStates' && Array.isArray(prop.value)) p.playerStates = prop.value as unknown[];
    if (n === 'BodyCondition' && Array.isArray(prop.value)) p.bodyConditions = prop.value as unknown[];
    if (n === 'UnlockedProfessionArr' && Array.isArray(prop.value)) p.unlockedProfessions = prop.value as unknown[];
    if ((n === 'UnlockedSkills' || n.startsWith('UnlockedSkills_')) && Array.isArray(prop.value))
      p.unlockedSkills = (prop.value as unknown[]).filter(Boolean);
    if (n === 'Skills' && Array.isArray(prop.value)) p.skillsData = prop.value as unknown[];
    if ((n === 'UniqueLoots' || n.startsWith('UniqueLoots_')) && Array.isArray(prop.value))
      p.uniqueLoots = prop.value as unknown[];
    if ((n === 'CraftedUniques' || n.startsWith('CraftedUniques_')) && Array.isArray(prop.value))
      p.craftedUniques = (prop.value as unknown[]).filter(Boolean);
    if (n === 'LootItemUnique' && Array.isArray(prop.value))
      p.lootItemUnique = (prop.value as unknown[]).filter(Boolean);
    if (n === 'LoreId' && typeof prop.value === 'string') p.lore.push(prop.value);
    if (n === 'Lore' && Array.isArray(prop.value)) p.lore = prop.value as unknown[];

    if (n === 'PlayerTransform' && prop.type === 'StructProperty' && prop.structType === 'Transform') {
      _extractTransform(prop, p);
    } else if (
      p.x === null &&
      prop.type === 'StructProperty' &&
      prop.structType === 'Transform' &&
      (prop.value as { translation?: unknown } | undefined)?.translation
    ) {
      const SKIP_TRANSFORMS = ['PlayerRespawnPoint', 'BackpackTransform', 'Transform', 'CompanionTransform'];
      if (!SKIP_TRANSFORMS.includes(n)) _extractTransform(prop, p);
    }

    if (n === 'PlayerRespawnPoint' && prop.type === 'StructProperty' && prop.structType === 'Transform') {
      const tv = prop.value as { translation?: { x: number; y: number; z: number } } | null;
      if (tv?.translation && typeof tv.translation.x === 'number') {
        p.respawnX = _round2(tv.translation.x);
        p.respawnY = _round2(tv.translation.y);
        p.respawnZ = _round2(tv.translation.z);
      }
    }

    if (n === 'CharProfile' && prop.children) {
      const profile: Record<string, unknown> = {};
      for (const c of prop.children) {
        if (c.name === 'Valid?') profile['valid'] = !!c.value;
        if (c.name === 'Male?') profile['isMale'] = !!c.value;
        if (c.name === 'Preset') profile['preset'] = c.value ?? '';
        if (c.name === 'Skin' && typeof c.value === 'number') profile['skin'] = c.value;
        if (c.name === 'Facial' && typeof c.value === 'number') profile['facial'] = c.value;
        if (c.name === 'HairSyle' && typeof c.value === 'number') profile['hairStyle'] = c.value;
        if (c.name === 'Upper' && typeof c.value === 'number') profile['upper'] = c.value;
        if (c.name === 'Bottom' && typeof c.value === 'number') profile['bottom'] = c.value;
        if (c.name === 'Gloves' && typeof c.value === 'number') profile['gloves'] = c.value;
        if (c.name === 'FootWear' && typeof c.value === 'number') profile['footWear'] = c.value;
        if (c.name === 'HairColor' && c.value) profile['hairColor'] = c.value;
        if (c.name === 'FacialColor' && c.value) profile['facialColor'] = c.value;
        if (c.name === 'MinimapFileName') profile['minimapFile'] = c.value ?? '';
        if (c.name === 'FacialColorIndex' && typeof c.value === 'number') profile['facialColorIndex'] = c.value;
        if (c.name === 'HairColorIndex' && typeof c.value === 'number') profile['hairColorIndex'] = c.value;
        if (c.name === 'BodyType' && typeof c.value === 'number') profile['bodyType'] = c.value;
        if (c.name === 'EyeColor' && typeof c.value === 'number') profile['eyeColor'] = c.value;
        if (c.name === 'Extra' && Array.isArray(c.value)) profile['extra'] = c.value;
      }
      p.charProfile = profile;
    }

    if (n === 'PlayerInventory' && Array.isArray(prop.value)) p.inventory = prop.value as unknown[];
    if (n === 'PlayerEquipment' && Array.isArray(prop.value)) p.equipment = prop.value as unknown[];
    if (n === 'PlayerQuickSlots' && Array.isArray(prop.value)) p.quickSlots = prop.value as unknown[];
    if ((n === 'BackpackInventory' || n.startsWith('BackpackInventory_')) && Array.isArray(prop.value))
      p.backpackItems = prop.value as unknown[];
    if (n === 'BackpackData' && (prop.children || Array.isArray(prop.value))) {
      p.backpackData = prop.children ? _childrenToObject(prop.children) : (prop.value as Record<string, unknown>);
    }
    if (n === 'QuestData' && Array.isArray(prop.value)) p.questData = prop.value as unknown[];
    if (n === 'MiniQuest' && (prop.children || prop.value)) {
      p.miniQuest = prop.children ? _childrenToObject(prop.children) : (prop.value as Record<string, unknown>);
    }
    if (n === 'Challenges' && Array.isArray(prop.value)) p.challenges = prop.value as unknown[];
    if (n === 'QuestSpawnerDone' && Array.isArray(prop.value)) p.questSpawnerDone = prop.value as unknown[];

    if (n === 'CompanionData' && Array.isArray(prop.value)) {
      p.companionData = [];
      for (const cd of prop.value as GvasProperty[][]) {
        if (!Array.isArray(cd)) continue;
        const comp: Record<string, unknown> = {
          class: '',
          displayName: '',
          x: null,
          y: null,
          z: null,
          health: 0,
          energy: 0,
          vest: 0,
          command: '',
          inventory: [],
        };
        for (const cp of cd) {
          if (cp.name === 'Class') {
            comp['class'] = cp.value ?? '';
            comp['displayName'] = simplifyBlueprint((cp.value as string | undefined) ?? '');
          }
          if (cp.name === 'Transform') {
            const tv = cp.value as { translation?: { x: number; y: number; z: number } } | null;
            if (tv?.translation) {
              comp['x'] = _round2(tv.translation.x);
              comp['y'] = _round2(tv.translation.y);
              comp['z'] = _round2(tv.translation.z);
            }
          }
          if (cp.name === 'Stats' && cp.children) {
            for (const sc of cp.children) {
              if (sc.name === 'Health' && typeof sc.value === 'number') comp['health'] = _round(sc.value);
              if (sc.name === 'Energy' && typeof sc.value === 'number') comp['energy'] = _round(sc.value);
            }
          }
          if (cp.name === 'Vest' && typeof cp.value === 'number') comp['vest'] = cp.value;
          if (cp.name === 'Command') comp['command'] = cp.value ?? '';
          if (cp.name === 'Inventory' && Array.isArray(cp.value)) comp['inventory'] = cp.value;
        }
        p.companionData.push(comp);
        companions.push({
          type: 'dog',
          actorName: (comp['displayName'] as string) || (comp['class'] as string),
          ownerSteamId: currentSteamID || '',
          x: comp['x'] as number | null,
          y: comp['y'] as number | null,
          z: comp['z'] as number | null,
          health: comp['health'] as number,
          extra: { energy: comp['energy'], command: comp['command'], vest: comp['vest'] },
        });
      }
    }
    if (n === 'Horses' && Array.isArray(prop.value)) p.horses = prop.value as unknown[];
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Main parse loop
  // ═══════════════════════════════════════════════════════════════════════════

  while (r.remaining() > 4) {
    try {
      const saved = r.getOffset();
      const prop = readProperty(r, { skipLargeArrays: false });
      if (prop === null) {
        if (r.getOffset() === saved) {
          if (!recoverForward(r, saved)) break;
        }
        continue;
      }
      handleProp(prop);
    } catch {
      const pos = r.getOffset();
      if (!recoverForward(r, pos)) break;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Post-processing: assemble parallel arrays into structures
  // ═══════════════════════════════════════════════════════════════════════════

  const structCount = buildActorClasses.length || buildActorTransformCount;
  for (let i = 0; i < structCount; i++) {
    const ownerStr = buildActorStrings[i] ?? '';
    const ownerMatch = ownerStr.match(/(7656\d+)/);
    const transform = buildActorTransforms[i];
    structures.push({
      actorClass: buildActorClasses[i] ?? '',
      displayName: simplifyBlueprint(buildActorClasses[i] ?? ''),
      ownerSteamId: ownerMatch?.[1] ?? '',
      x: transform ? _round2(transform.x) : null,
      y: transform ? _round2(transform.y) : null,
      z: transform ? _round2(transform.z) : null,
      currentHealth: buildActorHealths[i] ?? 0,
      maxHealth: buildActorMaxHealths[i] ?? 0,
      upgradeLevel: buildActorUpgrades[i] ?? 0,
      attachedToTrailer: buildActorTrailer[i] ?? false,
      inventory: [],
      noSpawn: false,
      extraData: buildActorData[i] ?? '',
    });
  }

  for (const nsProps of buildActorNoSpawn) {
    if (!Array.isArray(nsProps)) continue;
    for (const nsp of nsProps as GvasProperty[]) {
      if (nsp.name === 'BuildActor' && typeof nsp.value === 'string') {
        const idx = structures.findIndex((s) => s.extraData === nsp.value || s.actorClass === nsp.value);
        const target = idx >= 0 ? structures[idx] : undefined;
        if (target) target.noSpawn = true;
      }
    }
  }

  for (let idx = 0; idx < buildActorInventories.length; idx++) {
    const invProps = buildActorInventories[idx];
    if (!Array.isArray(invProps)) continue;
    let actorName = '';
    let items: unknown[] = [];
    let quickSlots: unknown[] = [];
    let locked = false;
    let craftingContent: unknown[] = [];
    let doesSpawnLoot = false;

    for (const ip of invProps as GvasProperty[]) {
      if (ip.name === 'ContainerActor') actorName = (ip.value as string) || '';
      if (ip.name === 'ContainerInventoryArray' && Array.isArray(ip.value)) items = ip.value as unknown[];
      if (ip.name === 'ContainerQuickSlotArray' && Array.isArray(ip.value)) quickSlots = ip.value as unknown[];
      if (ip.name === 'Locked?') locked = !!ip.value;
      if (ip.name === 'DoesSpawnLoot') doesSpawnLoot = !!ip.value;
      if (ip.name === 'CraftingContent' && Array.isArray(ip.value)) craftingContent = ip.value as unknown[];
    }

    if (items.length === 0 && quickSlots.length === 0 && craftingContent.length === 0) continue;

    if (actorName) {
      const existingContainer = containers.find((c) => c.actorName === actorName);
      if (existingContainer) {
        existingContainer.items = items;
        existingContainer.quickSlots = quickSlots;
        existingContainer.locked = locked;
      } else {
        const transform = buildActorTransforms[idx];
        containers.push({
          actorName,
          items,
          quickSlots,
          x: transform ? _round2(transform.x) : null,
          y: transform ? _round2(transform.y) : null,
          z: transform ? _round2(transform.z) : null,
          locked,
          doesSpawnLoot,
          buildIndex: idx,
        });
      }
    } else {
      const transform = buildActorTransforms[idx];
      containers.push({
        actorName: `BuildContainer_${String(idx)}`,
        items,
        quickSlots,
        x: transform ? _round2(transform.x) : null,
        y: transform ? _round2(transform.y) : null,
        z: transform ? _round2(transform.z) : null,
        locked,
        doesSpawnLoot,
        craftingContent,
        buildIndex: idx,
      });
    }
  }

  if (!worldState['currentSeason'] && worldState['gameDifficulty']) {
    const SEASONS = ['Spring', 'Summer', 'Fall', 'Winter'];
    const diff = worldState['gameDifficulty'] as Record<string, unknown>;
    const startIdx = SEASONS.indexOf(diff['startingSeason'] as string);
    if (startIdx !== -1 && worldState['daysPassed'] != null) {
      const dps = (diff['daysPerSeason'] as number) || 28;
      const seasonsPassed = Math.floor((worldState['daysPassed'] as number) / dps);
      worldState['currentSeason'] = SEASONS[(startIdx + seasonsPassed) % 4];
    }
  }

  worldState['totalStructures'] = structures.length;
  worldState['totalVehicles'] = vehicles.length;
  worldState['totalCompanions'] = companions.length;
  worldState['totalDeadBodies'] = deadBodies.length;
  worldState['totalHorses'] = horses.length;
  worldState['totalContainers'] = containers.length;
  worldState['totalPlayers'] = players.size;

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
    horses,
    header,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
//  Extraction helpers
// ═══════════════════════════════════════════════════════════════════════════

function _extractStatistics(statArray: unknown[][], player: PlayerData): void {
  for (const elemProps of statArray) {
    if (!Array.isArray(elemProps)) continue;
    let tagName: string | null = null;
    let currentValue: number | null = null;

    for (const ep of elemProps as GvasProperty[]) {
      if (ep.name === 'StatisticId') {
        if (ep.children) {
          for (const c of ep.children) {
            if (c.name === 'TagName' && typeof c.value === 'string') tagName = c.value;
          }
        }
        if (typeof ep.value === 'string' && ep.value.startsWith('statistics.')) tagName = ep.value;
      }
      if (ep.name === 'CurrentValue' && typeof ep.value === 'number') currentValue = ep.value;
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

function _extractExtendedStats(statArray: unknown[][], player: PlayerData): void {
  player.extendedStats = [];
  for (const elemProps of statArray) {
    if (!Array.isArray(elemProps)) continue;
    const stat: Record<string, unknown> = {};
    for (const ep of elemProps as GvasProperty[]) {
      if (ep.name === 'StatName') stat['name'] = ep.value;
      if (ep.name === 'StatValue' && typeof ep.value === 'number') stat['value'] = ep.value;
    }
    if (stat['name']) player.extendedStats.push(stat);
  }
}

function _extractVehicles(carArray: GvasProperty[][], vehicleList: Vehicle[]): void {
  for (const carProps of carArray) {
    if (!Array.isArray(carProps)) continue;
    const vehicle: Vehicle = {
      class: '',
      displayName: '',
      x: null,
      y: null,
      z: null,
      health: 0,
      maxHealth: 0,
      fuel: 0,
      inventory: [],
      upgrades: [],
      extra: {},
    };

    for (const cp of carProps) {
      if (cp.name === 'Class') {
        vehicle.class = (cp.value as string) || '';
        vehicle.displayName = simplifyBlueprint((cp.value as string) || '');
      }
      if (cp.name === 'Health' && typeof cp.value === 'number') vehicle.health = _round(cp.value);
      if (cp.name === 'MaxHealth' && typeof cp.value === 'number') vehicle.maxHealth = _round(cp.value);
      if (cp.name === 'Fuel' && typeof cp.value === 'number') vehicle.fuel = _round(cp.value);
      if (cp.name === 'Transform') {
        const tv = cp.value as { translation?: { x: number; y: number; z: number } } | null;
        if (tv?.translation) {
          vehicle.x = _round2(tv.translation.x);
          vehicle.y = _round2(tv.translation.y);
          vehicle.z = _round2(tv.translation.z);
        }
      }
      if (!['Class', 'Health', 'MaxHealth', 'Fuel', 'Transform'].includes(cp.name)) vehicle.extra[cp.name] = cp.value;
    }
    vehicleList.push(vehicle);
  }
}

function _extractContainers(prop: GvasProperty, containerList: Container[]): void {
  if (!Array.isArray(prop.value)) return;
  for (const elemProps of prop.value as GvasProperty[][]) {
    if (!Array.isArray(elemProps)) continue;
    const container: Container = {
      actorName: '',
      items: [],
      quickSlots: [],
      x: null,
      y: null,
      z: null,
      locked: false,
      doesSpawnLoot: false,
      alarmOff: false,
    };
    for (const cp of elemProps) {
      if (cp.name === 'ContainerActor') container.actorName = (cp.value as string) || '';
      if (cp.name === 'ContainerInventoryArray' && Array.isArray(cp.value)) container.items = cp.value as unknown[];
      if (cp.name === 'ContainerQuickSlotArray' && Array.isArray(cp.value))
        container.quickSlots = cp.value as unknown[];
      if (cp.name === 'DoesSpawnLoot') container.doesSpawnLoot = !!cp.value;
      if (cp.name === 'AlarmOff') container['alarmOff'] = !!cp.value;
      if (cp.name === 'Locked?') container.locked = !!cp.value;
      if (cp.name === 'HackCoolDown' && typeof cp.value === 'number') container['hackCoolDown'] = cp.value;
      if (cp.name === 'CraftingContent' && Array.isArray(cp.value)) container['craftingContent'] = cp.value;
      if (cp.name === 'DestroyTime' && typeof cp.value === 'number') container['destroyTime'] = cp.value;
      if (cp.name === 'Extra_Float_Params' && cp.value) container['extraFloats'] = cp.value;
      if (cp.name === 'Extra_Bool_Params' && cp.value) container['extraBools'] = cp.value;
    }
    if (container.actorName) containerList.push(container);
  }
}

function _extractHorses(horseArray: GvasProperty[][], horseList: Horse[]): void {
  for (const horseProps of horseArray) {
    if (!Array.isArray(horseProps)) continue;
    const horse: Horse = {
      class: '',
      displayName: '',
      x: null,
      y: null,
      z: null,
      health: 0,
      maxHealth: 0,
      energy: 0,
      stamina: 0,
      ownerSteamId: '',
      name: '',
      saddleInventory: [],
      inventory: [],
      extra: {},
    };

    for (const hp of horseProps) {
      if (hp.name === 'Class') {
        horse.class = (hp.value as string) || '';
        horse.displayName = simplifyBlueprint((hp.value as string) || '');
      }
      if (hp.name === 'HorseName' && typeof hp.value === 'string') horse.name = hp.value;
      if (hp.name === 'Health' && typeof hp.value === 'number') horse.health = _round(hp.value);
      if (hp.name === 'MaxHealth' && typeof hp.value === 'number') horse.maxHealth = _round(hp.value);
      if (hp.name === 'Energy' && typeof hp.value === 'number') horse.energy = _round(hp.value);
      if (hp.name === 'Stamina' && typeof hp.value === 'number') horse.stamina = _round(hp.value);
      if (hp.name === 'Transform') {
        const tv = hp.value as { translation?: { x: number; y: number; z: number } } | null;
        if (tv?.translation) {
          horse.x = _round2(tv.translation.x);
          horse.y = _round2(tv.translation.y);
          horse.z = _round2(tv.translation.z);
        }
      }
      if (hp.name === 'Owner' && typeof hp.value === 'string') {
        const m = hp.value.match(/(7656\d+)/);
        if (m?.[1]) horse.ownerSteamId = m[1];
      }
      if (hp.name === 'SaddleInventory' && Array.isArray(hp.value)) horse.saddleInventory = hp.value as unknown[];
      if (hp.name === 'Inventory' && Array.isArray(hp.value)) horse.inventory = hp.value as unknown[];
      if (
        ![
          'Class',
          'HorseName',
          'Health',
          'MaxHealth',
          'Energy',
          'Stamina',
          'Transform',
          'Owner',
          'SaddleInventory',
          'Inventory',
        ].includes(hp.name)
      ) {
        horse.extra[hp.name] = hp.value;
      }
    }
    horseList.push(horse);
  }
}

function _extractLootActors(prop: GvasProperty, actorList: LootActor[]): void {
  if (!Array.isArray(prop.value)) return;
  for (const elemProps of prop.value as GvasProperty[][]) {
    if (!Array.isArray(elemProps)) continue;
    const actor: LootActor = { name: '', type: '', x: null, y: null, z: null, items: [] };
    for (const lp of elemProps) {
      if (lp.name === 'Name') actor.name = (lp.value as string) || '';
      if (lp.name === 'Type') actor.type = (lp.value as string) || '';
      if (lp.name === 'Items' && Array.isArray(lp.value)) actor.items = lp.value as unknown[];
    }
    if (actor.name) actorList.push(actor);
  }
}

function _extractWorldQuests(prop: GvasProperty, questList: Quest[]): void {
  if (!Array.isArray(prop.value)) return;
  for (const elemProps of prop.value as GvasProperty[][]) {
    if (!Array.isArray(elemProps)) continue;
    const quest: Quest = { id: '', type: '', state: '', data: {} };
    for (const qp of elemProps) {
      if (qp.name === 'GUID' || qp.name === 'ID') quest.id = (qp.value as string) || '';
      if (qp.name === 'QuestType') quest.type = (qp.value as string) || '';
      if (qp.name === 'State' || qp.name === 'Status') quest.state = (qp.value as string) || '';
    }
    if (quest.id) questList.push(quest);
  }
}

function _extractTransform(prop: GvasProperty, player: PlayerData): void {
  const tv = prop.value as {
    translation?: { x: number; y: number; z: number };
    rotation?: { z: number; w: number };
  } | null;
  if (tv?.translation) {
    const t = tv.translation;
    if (typeof t.x === 'number' && typeof t.y === 'number') {
      player.x = _round2(t.x);
      player.y = _round2(t.y);
      player.z = _round2(t.z);
    }
    if (tv.rotation) {
      const q = tv.rotation;
      if (typeof q.z === 'number' && typeof q.w === 'number') {
        player.rotationYaw = _round(Math.atan2(2 * q.z * q.w, 1 - 2 * q.z * q.z) * (180 / Math.PI));
      }
    }
  }
}

function _childrenToObject(children: GvasProperty[]): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
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

function _round(v: number): number {
  return v;
}
function _round2(v: number): number {
  return v;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Clan data parser (separate Save_ClanData.sav file)
// ═══════════════════════════════════════════════════════════════════════════

function parseClanData(buf: Buffer): Clan[] {
  const r: GvasReader = createReader(buf);
  parseHeader(r);

  const clans: Clan[] = [];

  while (r.remaining() > 4) {
    const saved = r.getOffset();
    const prop = readProperty(r);
    if (prop === null) {
      if (r.getOffset() === saved) break;
      continue;
    }

    if (prop.name === 'ClanInfo' && prop.type === 'ArrayProperty') {
      if (!Array.isArray(prop.value)) continue;

      for (const clanProps of prop.value as GvasProperty[][]) {
        if (!Array.isArray(clanProps)) continue;
        const clan: Clan = { name: '', members: [] };

        for (const cp of clanProps) {
          if (cp.name.startsWith('ClanName') && typeof cp.value === 'string') clan.name = cp.value;
          if (cp.name.startsWith('Members') && cp.type === 'ArrayProperty') {
            if (Array.isArray(cp.value)) {
              for (const memberProps of cp.value as GvasProperty[][]) {
                if (!Array.isArray(memberProps)) continue;
                const member: ClanMember = { name: '', steamId: '', rank: 'Member', canInvite: false, canKick: false };
                for (const mp of memberProps) {
                  if (mp.name.startsWith('Name') && typeof mp.value === 'string') member.name = mp.value;
                  if (mp.name.startsWith('NetID') && typeof mp.value === 'string') {
                    const match = mp.value.match(/(7656\d+)/);
                    if (match?.[1]) member.steamId = match[1];
                  }
                  if (mp.name.startsWith('Rank') && typeof mp.value === 'string') {
                    member.rank = CLAN_RANK_MAP[mp.value] ?? mp.value;
                  }
                  if (mp.name.startsWith('CanInvite')) member.canInvite = !!mp.value;
                  if (mp.name.startsWith('CanKick')) member.canKick = !!mp.value;
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

export {
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

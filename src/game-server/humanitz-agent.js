#!/usr/bin/env node
/**
 * HumanitZ Save Parser Agent v1
 * Auto-generated — do not edit manually.
 * Regenerate via: node -e "require('./src/parsers/agent-builder').writeAgent()"
 *
 * Parses Save_DedicatedSaveMP.sav on the game server and writes
 * a compact humanitz-cache.json for the bot to download.
 *
 * Usage:
 *   node humanitz-agent.js                       # auto-discover save, parse once
 *   node humanitz-agent.js --save /path/to/save  # explicit path
 *   node humanitz-agent.js --watch                # watch mode (re-parse on change)
 *   node humanitz-agent.js --watch --interval 30  # custom poll interval (seconds)
 *   node humanitz-agent.js --help                 # show usage
 *
 * Output: humanitz-cache.json in the same directory as the save file.
 *
 * Requirements: Node.js 16+ (no npm packages needed)
 */
'use strict';
const _fs = require('fs');
const _path = require('path');

// ═══════════════════════════════════════════════════════════════════════════
//  GVAS Binary Reader (auto-bundled from gvas-reader.js)
// ═══════════════════════════════════════════════════════════════════════════

// ─── Binary Reader ──────────────────────────────────────────────────────────

function createReader(buf) {
  let offset = 0;

  function readU8()  { return buf[offset++]; }
  function readU16() { const v = buf.readUInt16LE(offset); offset += 2; return v; }
  function readU32() { const v = buf.readUInt32LE(offset); offset += 4; return v; }
  function readI32() { const v = buf.readInt32LE(offset); offset += 4; return v; }
  function readI64() {
    const lo = buf.readUInt32LE(offset);
    const hi = buf.readInt32LE(offset + 4);
    offset += 8;
    return Number(BigInt(hi) * 0x100000000n + BigInt(lo >>> 0));
  }
  function readF32() { const v = buf.readFloatLE(offset); offset += 4; return v; }
  function readF64() { const v = buf.readDoubleLE(offset); offset += 8; return v; }
  function readGuid() {
    const g = buf.subarray(offset, offset + 16);
    offset += 16;
    return g.toString('hex');
  }
  function readBool() { return readU8() !== 0; }

  /**
   * Read a UE4 FString (length-prefixed, null-terminated).
   * Positive length = UTF-8, negative length = UTF-16LE.
   */
  function readFString() {
    const len = readI32();
    if (len === 0) return '';
    if (len > 0 && len < 65536) {
      const s = buf.toString('utf8', offset, offset + len - 1);
      offset += len;
      return s;
    }
    if (len < 0 && len > -65536) {
      const chars = -len;
      const s = buf.toString('utf16le', offset, offset + (chars - 1) * 2);
      offset += chars * 2;
      return s;
    }
    throw new Error(`Bad FString length: ${len} at offset ${offset - 4}`);
  }

  function getOffset() { return offset; }
  function setOffset(o) { offset = o; }
  function remaining() { return buf.length - offset; }
  function peek(bytes) { return buf.subarray(offset, offset + bytes); }
  function skip(bytes) { offset += bytes; }

  return {
    buf,
    readU8, readU16, readU32, readI32, readI64,
    readF32, readF64, readGuid, readBool, readFString,
    getOffset, setOffset, remaining, peek, skip,
    length: buf.length,
  };
}

// ─── Clean UE4 GUID suffixes from property names ───────────────────────────

function cleanName(name) {
  return name.replace(/_\d+_[A-F0-9]{32}$/i, '');
}

// ─── GVAS header parser ────────────────────────────────────────────────────

function parseHeader(r) {
  const magic = Buffer.from([
    r.readU8(), r.readU8(), r.readU8(), r.readU8(),
  ]).toString('ascii');

  if (magic !== 'GVAS') throw new Error('Not a GVAS save file');

  const header = {
    magic,
    saveVersion: r.readU32(),
    packageVersion: r.readU32(),
    engineVersion: {
      major: r.readU16(),
      minor: r.readU16(),
      patch: r.readU16(),
    },
    build: r.readU32(),
    branch: r.readFString(),
    customVersions: [],
  };

  r.readU32(); // custom version format
  const numCV = r.readU32();
  for (let i = 0; i < numCV; i++) {
    header.customVersions.push({ guid: r.readGuid(), version: r.readI32() });
  }
  header.saveClass = r.readFString();

  return header;
}

// ─── Property type names we capture MapProperty values for ─────────────────

const MAP_CAPTURE = new Set([
  'GameStats', 'FloatData', 'CustomData', 'LODHouseData',
  'RandQuestConfig', 'SGlobalContainerSave',
]);

// ─── Read a single UProperty ───────────────────────────────────────────────

/**
 * Read one UProperty from the stream.
 * Returns { name, type, raw, value, ...extras } or null at end/error.
 *
 * @param {object} r - Reader from createReader()
 * @param {object} [options]
 * @param {boolean} [options.skipLargeArrays=false] - Skip arrays >100 elements of Vector/Rotator/Transform
 * @returns {object|null}
 */
function readProperty(r, options = {}) {
  const skipLargeArrays = options.skipLargeArrays ?? false;
  const skipThreshold = options.skipThreshold ?? 10;

  if (r.remaining() < 4) return null;
  const startOff = r.getOffset();

  let name;
  try { name = r.readFString(); } catch { return null; }
  if (name === 'None' || name === '') return null;

  let typeName;
  try { typeName = r.readFString(); } catch { r.setOffset(startOff); return null; }

  const dataSize = r.readI64();
  if (dataSize < 0 || dataSize > r.length) { r.setOffset(startOff); return null; }

  const cname = cleanName(name);
  const prop = { name: cname, type: typeName, raw: name };

  try {
    switch (typeName) {
      case 'BoolProperty':
        prop.value = r.readBool();
        r.readU8(); // separator
        break;

      case 'IntProperty':
        r.readU8();
        prop.value = r.readI32();
        break;

      case 'UInt32Property':
        r.readU8();
        prop.value = r.readU32();
        break;

      case 'Int64Property':
        r.readU8();
        prop.value = r.readI64();
        break;

      case 'FloatProperty':
        r.readU8();
        prop.value = r.readF32();
        break;

      case 'DoubleProperty':
        r.readU8();
        prop.value = r.readF64();
        break;

      case 'StrProperty':
      case 'NameProperty':
      case 'SoftObjectProperty':
      case 'ObjectProperty':
        r.readU8();
        prop.value = r.readFString();
        break;

      case 'EnumProperty':
        prop.enumType = r.readFString();
        r.readU8();
        prop.value = r.readFString();
        break;

      case 'ByteProperty': {
        const enumName = r.readFString();
        r.readU8();
        if (enumName === 'None') {
          prop.value = r.readU8();
        } else {
          prop.enumType = enumName;
          prop.value = r.readFString();
        }
        break;
      }

      case 'TextProperty':
        r.readU8();
        r.setOffset(r.getOffset() + dataSize);
        prop.value = '<text>';
        break;

      case 'StructProperty':
        _readStructProperty(r, prop, dataSize);
        break;

      case 'ArrayProperty':
        _readArrayProperty(r, prop, dataSize, { skipLargeArrays, skipThreshold });
        break;

      case 'MapProperty':
        _readMapProperty(r, prop, dataSize, cname);
        break;

      case 'SetProperty': {
        r.readFString(); // inner type
        r.readU8();
        r.setOffset(r.getOffset() + dataSize);
        prop.value = null;
        break;
      }

      default:
        r.readU8();
        r.setOffset(r.getOffset() + dataSize);
        prop.value = null;
        break;
    }
  } catch (e) {
    // Unrecoverable parse error within this property
    return null;
  }

  return prop;
}

// ─── Struct subtypes ───────────────────────────────────────────────────────

function _readStructProperty(r, prop, dataSize) {
  const structType = r.readFString();
  r.readGuid();
  r.readU8();
  prop.structType = structType;

  switch (structType) {
    case 'Vector':
    case 'Rotator':
      prop.value = { x: r.readF32(), y: r.readF32(), z: r.readF32() };
      break;

    case 'Quat':
      prop.value = { x: r.readF32(), y: r.readF32(), z: r.readF32(), w: r.readF32() };
      break;

    case 'Guid':
      prop.value = r.readGuid();
      break;

    case 'LinearColor':
      prop.value = { r: r.readF32(), g: r.readF32(), b: r.readF32(), a: r.readF32() };
      break;

    case 'DateTime':
    case 'Timespan':
      prop.value = r.readI64();
      break;

    case 'Vector2D':
      prop.value = { x: r.readF32(), y: r.readF32() };
      break;

    case 'GameplayTagContainer': {
      const c = r.readU32();
      prop.value = [];
      for (let i = 0; i < c; i++) prop.value.push(r.readFString());
      break;
    }

    case 'TimerHandle':
      prop.value = r.readFString();
      break;

    case 'SoftClassPath':
    case 'SoftObjectPath':
      prop.value = r.readFString();
      break;

    case 'Transform': {
      const subProps = [];
      let sub;
      while ((sub = readProperty(r)) !== null) subProps.push(sub);
      const translation = subProps.find(s => s.name === 'Translation');
      const rotation = subProps.find(s => s.name === 'Rotation');
      const scale = subProps.find(s => s.name === 'Scale3D');
      prop.value = {
        translation: translation?.value || null,
        rotation: rotation?.value || null,
        scale: scale?.value || null,
      };
      prop.children = subProps;
      break;
    }

    default: {
      // Generic struct — recursively read child properties
      prop.value = 'struct';
      const children = [];
      let child;
      while ((child = readProperty(r)) !== null) children.push(child);
      prop.children = children;
      break;
    }
  }
}

// ─── Array subtypes ────────────────────────────────────────────────────────

function _readArrayProperty(r, prop, dataSize, options) {
  const innerType = r.readFString();
  r.readU8();
  const afterSep = r.getOffset();
  const count = r.readI32();
  prop.innerType = innerType;
  prop.count = count;

  if (innerType === 'StructProperty') {
    r.readFString(); // arrName
    r.readFString(); // arrType
    r.readI64();     // arrSize
    const arrStructType = r.readFString();
    r.readGuid();
    r.readU8();
    prop.arrayStructType = arrStructType;

    // Skip large world-geometry arrays (Transform, Vector, Rotator)
    if (options.skipLargeArrays
        && ['Transform', 'Vector', 'Rotator'].includes(arrStructType)
        && count > options.skipThreshold) {
      r.setOffset(afterSep + dataSize);
      prop.value = `<skipped ${count}>`;
      return;
    }

    if (arrStructType === 'S_Slots') {
      // Inventory slots — parse to extract items  
      prop.value = _parseInventorySlots(r, count);
    } else {
      // Generic struct array — parse each element
      const elements = [];
      for (let i = 0; i < count; i++) {
        const elemProps = [];
        let child;
        while ((child = readProperty(r)) !== null) elemProps.push(child);
        elements.push(elemProps);
      }
      prop.value = elements;
    }
  } else if (innerType === 'NameProperty' || innerType === 'StrProperty' || innerType === 'ObjectProperty') {
    prop.value = [];
    for (let i = 0; i < count; i++) prop.value.push(r.readFString());
  } else if (innerType === 'IntProperty') {
    prop.value = [];
    for (let i = 0; i < count; i++) prop.value.push(r.readI32());
  } else if (innerType === 'FloatProperty') {
    prop.value = [];
    for (let i = 0; i < count; i++) prop.value.push(r.readF32());
  } else if (innerType === 'BoolProperty') {
    prop.value = [];
    for (let i = 0; i < count; i++) prop.value.push(r.readBool());
  } else if (innerType === 'ByteProperty') {
    prop.value = [];
    for (let i = 0; i < count; i++) prop.value.push(r.readU8());
  } else if (innerType === 'EnumProperty') {
    prop.value = [];
    for (let i = 0; i < count; i++) prop.value.push(r.readFString());
  } else if (innerType === 'UInt32Property') {
    prop.value = [];
    for (let i = 0; i < count; i++) prop.value.push(r.readU32());
  } else {
    // Unknown inner type — skip the data
    r.setOffset(afterSep + dataSize);
    prop.value = `<unknown ${innerType}>`;
  }
}

// ─── Inventory slot parsing ────────────────────────────────────────────────

function _parseInventorySlots(r, count) {
  const items = [];
  for (let i = 0; i < count; i++) {
    const slotProps = [];
    let child;
    while ((child = readProperty(r)) !== null) slotProps.push(child);

    let itemName = null, amount = 0, durability = 0;
    for (const sp of slotProps) {
      if (sp.name === 'Item' && sp.children) {
        for (const c of sp.children) {
          if (c.name === 'RowName') itemName = c.value;
        }
      }
      if (sp.name === 'Amount') amount = sp.value || 0;
      if (sp.name === 'Durability') durability = sp.value || 0;
    }

    if (itemName && itemName !== 'None') {
      items.push({
        item: itemName,
        amount,
        durability: Math.round(durability * 10) / 10,
      });
    }
  }
  return items;
}

// ─── Map property ──────────────────────────────────────────────────────────

function _readMapProperty(r, prop, dataSize, cname) {
  const keyType = r.readFString();
  const valType = r.readFString();
  r.readU8();
  const afterSep = r.getOffset();
  prop.keyType = keyType;
  prop.valType = valType;

  if (MAP_CAPTURE.has(cname)) {
    r.readI32(); // removedCount
    const count = r.readI32();
    const entries = {};
    for (let i = 0; i < count; i++) {
      let key;
      if (keyType === 'StrProperty' || keyType === 'NameProperty') key = r.readFString();
      else if (keyType === 'IntProperty') key = r.readI32();
      else if (keyType === 'EnumProperty') key = r.readFString();
      else { r.setOffset(afterSep + dataSize); prop.value = null; return; }

      let val;
      if (valType === 'FloatProperty') val = r.readF32();
      else if (valType === 'IntProperty') val = r.readI32();
      else if (valType === 'StrProperty') val = r.readFString();
      else if (valType === 'BoolProperty') val = r.readBool();
      else { r.setOffset(afterSep + dataSize); prop.value = null; return; }

      entries[key] = val;
    }
    prop.value = entries;
  } else {
    // Skip maps we don't need to capture
    r.setOffset(afterSep + dataSize);
    prop.value = null;
  }
}

// ─── Recovery: scan forward for next valid property ────────────────────────

/**
 * When parsing gets stuck (null property without offset advancement),
 * scan forward to find the next valid property header.
 * @param {object} r - Reader
 * @param {number} startPos - Position where we got stuck
 * @param {number} [maxScan=50000] - Max bytes to scan forward
 * @returns {boolean} true if a valid offset was found and reader repositioned
 */
function recoverForward(r, startPos, maxScan = 50000) {
  const buf = r.buf;
  for (let scan = startPos + 1; scan < Math.min(startPos + maxScan, buf.length - 10); scan++) {
    const len = buf.readInt32LE(scan);
    if (len > 3 && len < 80) {
      const peek = buf.toString('utf8', scan + 4, scan + 4 + len - 1);
      if (/^[A-Z][a-zA-Z0-9_]{2,60}$/.test(peek)) {
        r.setOffset(scan);
        return true;
      }
    }
  }
  return false;
}


// ═══════════════════════════════════════════════════════════════════════════
//  Save Parser (auto-bundled from save-parser.js)
// ═══════════════════════════════════════════════════════════════════════════

// ─── Perk enum → display name ──────────────────────────────────────────────

const PERK_MAP = {
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


// ═══════════════════════════════════════════════════════════════════════════
//  Agent CLI
// ═══════════════════════════════════════════════════════════════════════════

const CACHE_FILENAME = 'humanitz-cache.json';
const SAVE_FILENAME = 'Save_DedicatedSaveMP.sav';

// ── Argument parsing ──

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { save: '', output: '', watch: false, interval: 30, help: false, discover: false };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--watch' || arg === '-w') opts.watch = true;
    else if (arg === '--discover') opts.discover = true;
    else if ((arg === '--save' || arg === '-s') && args[i + 1]) opts.save = args[++i];
    else if ((arg === '--output' || arg === '-o') && args[i + 1]) opts.output = args[++i];
    else if ((arg === '--interval' || arg === '-i') && args[i + 1]) opts.interval = parseInt(args[++i], 10) || 30;
    else if (!arg.startsWith('-')) opts.save = arg;  // positional = save path
  }

  return opts;
}

function showHelp() {
  console.log(`
HumanitZ Save Parser Agent

Usage: node humanitz-agent.js [options] [save-path]

Options:
  --save, -s <path>      Path to Save_DedicatedSaveMP.sav
  --output, -o <path>    Output path for cache JSON
  --watch, -w            Watch mode: re-parse when save changes
  --interval, -i <sec>   Poll interval in seconds (default: 30)
  --discover             Search for save file in common locations
  --help, -h             Show this help

If no save path is given, searches current directory and common locations.
Output defaults to humanitz-cache.json next to the save file.
`);
}

// ── Auto-discovery ──

function discoverSave(startDir) {
  // Common locations on various hosts
  const searchPaths = [
    _path.join(startDir, SAVE_FILENAME),
    _path.join(startDir, 'Saved', 'SaveGames', 'SaveList', 'Default', SAVE_FILENAME),
    _path.join(startDir, 'HumanitZServer', 'Saved', 'SaveGames', 'SaveList', 'Default', SAVE_FILENAME),
    _path.join(startDir, 'HumanitZ', 'Saved', 'SaveGames', 'SaveList', 'Default', SAVE_FILENAME),
    // Pterodactyl / containerised
    _path.join('/home/container', 'HumanitZServer', 'Saved', 'SaveGames', 'SaveList', 'Default', SAVE_FILENAME),
    _path.join('/home/container', 'Saved', 'SaveGames', 'SaveList', 'Default', SAVE_FILENAME),
    // Windows defaults
    'C:\\HumanitZServer\\Saved\\SaveGames\\SaveList\\Default\\' + SAVE_FILENAME,
  ];

  for (const p of searchPaths) {
    try { if (_fs.existsSync(p)) return p; } catch { /* skip */ }
  }

  // Recursive search (max 3 levels deep)
  return _deepSearch(startDir, SAVE_FILENAME, 0, 3);
}

function _deepSearch(dir, target, depth, maxDepth) {
  if (depth > maxDepth) return null;
  try {
    const entries = _fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isFile() && e.name === target) return _path.join(dir, e.name);
    }
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') {
        const found = _deepSearch(_path.join(dir, e.name), target, depth + 1, maxDepth);
        if (found) return found;
      }
    }
  } catch { /* permission denied, etc */ }
  return null;
}

// ── Parse and write cache ──

function parseAndWrite(savePath, outputPath) {
  const startTime = Date.now();

  const buf = _fs.readFileSync(savePath);
  const result = parseSave(buf);

  // Convert players Map to plain object for JSON serialisation
  const playersObj = {};
  for (const [steamId, data] of result.players) {
    playersObj[steamId] = data;
  }

  const cache = {
    v: 1,
    ts: new Date().toISOString(),
    mtime: _fs.statSync(savePath).mtimeMs,
    players: playersObj,
    worldState: result.worldState,
    structures: result.structures,
    vehicles: result.vehicles,
    companions: result.companions,
    deadBodies: result.deadBodies,
    containers: result.containers,
    lootActors: result.lootActors,
    quests: result.quests,
  };

  const json = JSON.stringify(cache);
  _fs.writeFileSync(outputPath, json);

  const elapsed = Date.now() - startTime;
  const sizeMB = (json.length / 1024 / 1024).toFixed(2);
  const playerCount = Object.keys(playersObj).length;
  console.log('[Agent] Parsed ' + playerCount + ' players, '
    + result.structures.length + ' structures, '
    + result.vehicles.length + ' vehicles → '
    + sizeMB + 'MB cache (' + elapsed + 'ms)');

  return cache;
}

// ── Watch mode ──

function watchMode(savePath, outputPath, intervalSec) {
  let lastMtime = 0;

  function check() {
    try {
      const stat = _fs.statSync(savePath);
      if (stat.mtimeMs !== lastMtime) {
        lastMtime = stat.mtimeMs;
        parseAndWrite(savePath, outputPath);
      }
    } catch (err) {
      console.error('[Agent] Error:', err.message);
    }
  }

  console.log('[Agent] Watching ' + savePath + ' (poll every ' + intervalSec + 's)');
  console.log('[Agent] Output: ' + outputPath);
  console.log('[Agent] Press Ctrl+C to stop');

  check(); // immediate first parse
  setInterval(check, intervalSec * 1000);
}

// ── Main ──

function main() {
  const opts = parseArgs();

  if (opts.help) { showHelp(); process.exit(0); }

  // Resolve save path
  let savePath = opts.save;
  if (!savePath) {
    savePath = discoverSave(process.cwd());
    if (!savePath) {
      console.error('[Agent] Could not find ' + SAVE_FILENAME);
      console.error('[Agent] Use --save <path> to specify the save file location');
      process.exit(1);
    }
    console.log('[Agent] Found save: ' + savePath);
  }

  if (!_fs.existsSync(savePath)) {
    console.error('[Agent] Save file not found: ' + savePath);
    process.exit(1);
  }

  // Resolve output path
  const outputPath = opts.output || _path.join(_path.dirname(savePath), CACHE_FILENAME);

  if (opts.watch) {
    watchMode(savePath, outputPath, opts.interval);
  } else {
    parseAndWrite(savePath, outputPath);
  }
}

main();

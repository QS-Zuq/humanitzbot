#!/usr/bin/env node
/**
 * HumanitZ Save Parser Agent v2
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
//  GVAS Binary Reader (auto-bundled from gvas-reader.ts)
// ═══════════════════════════════════════════════════════════════════════════

function createReader(buf) {
  let offset = 0;
  function readU8() {
    return buf[offset++];
  }
  function readU16() {
    const v = buf.readUInt16LE(offset);
    offset += 2;
    return v;
  }
  function readU32() {
    const v = buf.readUInt32LE(offset);
    offset += 4;
    return v;
  }
  function readI32() {
    const v = buf.readInt32LE(offset);
    offset += 4;
    return v;
  }
  function readI64() {
    const lo = buf.readUInt32LE(offset);
    const hi = buf.readInt32LE(offset + 4);
    offset += 8;
    return Number(BigInt(hi) * 0x100000000n + BigInt(lo >>> 0));
  }
  function readF32() {
    const v = buf.readFloatLE(offset);
    offset += 4;
    return v;
  }
  function readF64() {
    const v = buf.readDoubleLE(offset);
    offset += 8;
    return v;
  }
  function readGuid() {
    const g = buf.subarray(offset, offset + 16);
    offset += 16;
    return g.toString('hex');
  }
  function readBool() {
    return readU8() !== 0;
  }
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
    throw new Error(`Bad FString length: ${String(len)} at offset ${String(offset - 4)}`);
  }
  function getOffset() {
    return offset;
  }
  function setOffset(o) {
    offset = o;
  }
  function remaining() {
    return buf.length - offset;
  }
  function peek(bytes) {
    return buf.subarray(offset, offset + bytes);
  }
  function skip(bytes) {
    offset += bytes;
  }
  return {
    buf,
    readU8,
    readU16,
    readU32,
    readI32,
    readI64,
    readF32,
    readF64,
    readGuid,
    readBool,
    readFString,
    getOffset,
    setOffset,
    remaining,
    peek,
    skip,
    length: buf.length,
  };
}
function cleanName(name) {
  return name.replace(/_\d+_[A-F0-9]{32}$/i, '');
}
function parseHeader(r) {
  const magic = Buffer.from([r.readU8(), r.readU8(), r.readU8(), r.readU8()]).toString('ascii');
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
  r.readU32();
  const numCV = r.readU32();
  for (let i = 0; i < numCV; i++) {
    header.customVersions.push({ guid: r.readGuid(), version: r.readI32() });
  }
  header.saveClass = r.readFString();
  return header;
}
const MAP_CAPTURE = /* @__PURE__ */ new Set([
  'GameStats',
  'FloatData',
  'CustomData',
  'LODHouseData',
  'RandQuestConfig',
  'SGlobalContainerSave',
  'LodModularLootActor',
]);
function readProperty(r, options = {}) {
  const skipLargeArrays = options.skipLargeArrays ?? false;
  const skipThreshold = options.skipThreshold ?? 10;
  if (r.remaining() < 4) return null;
  const startOff = r.getOffset();
  let name;
  try {
    name = r.readFString();
  } catch {
    return null;
  }
  if (name === 'None' || name === '') return null;
  let typeName;
  try {
    typeName = r.readFString();
  } catch {
    r.setOffset(startOff);
    return null;
  }
  const dataSize = r.readI64();
  if (dataSize < 0 || dataSize > r.length) {
    r.setOffset(startOff);
    return null;
  }
  const cname = cleanName(name);
  const prop = { name: cname, type: typeName, raw: name, value: null };
  try {
    switch (typeName) {
      case 'BoolProperty':
        prop.value = r.readBool();
        r.readU8();
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
        r.readFString();
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
  } catch {
    return null;
  }
  return prop;
}
function _readStructProperty(r, prop, _dataSize) {
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
      const tags = [];
      for (let i = 0; i < c; i++) {
        tags.push(r.readFString());
      }
      prop.value = tags;
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
      while ((sub = readProperty(r)) !== null) {
        subProps.push(sub);
      }
      const translation = subProps.find((s) => s.name === 'Translation');
      const rotation = subProps.find((s) => s.name === 'Rotation');
      const scale = subProps.find((s) => s.name === 'Scale3D');
      prop.value = {
        translation: (translation == null ? void 0 : translation.value) ?? null,
        rotation: (rotation == null ? void 0 : rotation.value) ?? null,
        scale: (scale == null ? void 0 : scale.value) ?? null,
      };
      prop.children = subProps;
      break;
    }
    default: {
      prop.value = 'struct';
      const children = [];
      let child;
      while ((child = readProperty(r)) !== null) {
        children.push(child);
      }
      prop.children = children;
      break;
    }
  }
}
function _readArrayProperty(r, prop, dataSize, options) {
  const innerType = r.readFString();
  r.readU8();
  const afterSep = r.getOffset();
  const count = r.readI32();
  prop.innerType = innerType;
  prop.count = count;
  if (innerType === 'StructProperty') {
    r.readFString();
    r.readFString();
    r.readI64();
    const arrStructType = r.readFString();
    r.readGuid();
    r.readU8();
    prop.arrayStructType = arrStructType;
    if (
      options.skipLargeArrays &&
      ['Transform', 'Vector', 'Rotator'].includes(arrStructType) &&
      count > options.skipThreshold
    ) {
      r.setOffset(afterSep + dataSize);
      prop.value = `<skipped ${String(count)}>`;
      return;
    }
    if (arrStructType === 'S_Slots') {
      prop.value = _parseInventorySlots(r, count);
    } else if (arrStructType === 'Guid') {
      const guids = [];
      for (let i = 0; i < count; i++) {
        guids.push(r.readGuid());
      }
      prop.value = guids;
    } else if (arrStructType === 'Vector' || arrStructType === 'Rotator') {
      const vecs = [];
      for (let i = 0; i < count; i++) {
        vecs.push({ x: r.readF32(), y: r.readF32(), z: r.readF32() });
      }
      prop.value = vecs;
    } else if (arrStructType === 'Quat') {
      const quats = [];
      for (let i = 0; i < count; i++) {
        quats.push({ x: r.readF32(), y: r.readF32(), z: r.readF32(), w: r.readF32() });
      }
      prop.value = quats;
    } else if (arrStructType === 'LinearColor') {
      const colors = [];
      for (let i = 0; i < count; i++) {
        colors.push({ r: r.readF32(), g: r.readF32(), b: r.readF32(), a: r.readF32() });
      }
      prop.value = colors;
    } else if (arrStructType === 'DateTime' || arrStructType === 'Timespan') {
      const times = [];
      for (let i = 0; i < count; i++) {
        times.push(r.readI64());
      }
      prop.value = times;
    } else if (arrStructType === 'Vector2D') {
      const vec2s = [];
      for (let i = 0; i < count; i++) {
        vec2s.push({ x: r.readF32(), y: r.readF32() });
      }
      prop.value = vec2s;
    } else {
      const elements = [];
      for (let i = 0; i < count; i++) {
        const elemProps = [];
        let child;
        while ((child = readProperty(r)) !== null) {
          elemProps.push(child);
        }
        elements.push(elemProps);
      }
      prop.value = elements;
    }
  } else if (innerType === 'NameProperty' || innerType === 'StrProperty' || innerType === 'ObjectProperty') {
    const strs = [];
    for (let i = 0; i < count; i++) {
      strs.push(r.readFString());
    }
    prop.value = strs;
  } else if (innerType === 'IntProperty') {
    const ints = [];
    for (let i = 0; i < count; i++) {
      ints.push(r.readI32());
    }
    prop.value = ints;
  } else if (innerType === 'FloatProperty') {
    const floats = [];
    for (let i = 0; i < count; i++) {
      floats.push(r.readF32());
    }
    prop.value = floats;
  } else if (innerType === 'BoolProperty') {
    const bools = [];
    for (let i = 0; i < count; i++) {
      bools.push(r.readBool());
    }
    prop.value = bools;
  } else if (innerType === 'ByteProperty') {
    const bytes = [];
    for (let i = 0; i < count; i++) {
      bytes.push(r.readU8());
    }
    prop.value = bytes;
  } else if (innerType === 'EnumProperty') {
    const enums = [];
    for (let i = 0; i < count; i++) {
      enums.push(r.readFString());
    }
    prop.value = enums;
  } else if (innerType === 'UInt32Property') {
    const uints = [];
    for (let i = 0; i < count; i++) {
      uints.push(r.readU32());
    }
    prop.value = uints;
  } else {
    r.setOffset(afterSep + dataSize);
    prop.value = `<unknown ${innerType}>`;
  }
}
function _parseInventorySlots(r, count) {
  const items = [];
  for (let i = 0; i < count; i++) {
    const slotProps = [];
    let child;
    while ((child = readProperty(r)) !== null) {
      slotProps.push(child);
    }
    let itemName = null;
    let amount = 0;
    let durability = 0;
    let ammo = 0;
    let attachments = [];
    let cap = 0;
    let weight = 0;
    let maxDur = 0;
    let wetness = 0;
    for (const sp of slotProps) {
      if (sp.name === 'Item' && sp.children) {
        for (const c of sp.children) {
          if (c.name === 'RowName') itemName = c.value;
        }
      }
      if (sp.name === 'Amount') amount = sp.value || 0;
      if (sp.name === 'Durability') durability = sp.value || 0;
      if (sp.name === 'Ammo') ammo = sp.value || 0;
      if (sp.name === 'Attachments' && Array.isArray(sp.value)) attachments = sp.value;
      if (sp.name === 'Cap') cap = sp.value || 0;
      if (sp.name === 'Weight') weight = sp.value || 0;
      if (sp.name === 'MaxDur') maxDur = sp.value || 0;
      if (sp.name === 'Wetness') wetness = sp.value || 0;
    }
    if (itemName && itemName !== 'None' && itemName !== 'Empty') {
      const slot = {
        item: itemName,
        amount,
        durability: Math.round(durability * 100) / 100,
      };
      if (ammo) slot.ammo = ammo;
      if (attachments.length) slot.attachments = attachments;
      if (cap) slot.cap = Math.round(cap * 100) / 100;
      if (weight) slot.weight = Math.round(weight * 1e4) / 1e4;
      if (maxDur) slot.maxDur = Math.round(maxDur * 100) / 100;
      if (wetness) slot.wetness = Math.round(wetness * 100) / 100;
      items.push(slot);
    }
  }
  return items;
}
function _readMapProperty(r, prop, dataSize, cname) {
  const keyType = r.readFString();
  const valType = r.readFString();
  r.readU8();
  const afterSep = r.getOffset();
  prop.keyType = keyType;
  prop.valType = valType;
  if (MAP_CAPTURE.has(cname)) {
    r.readI32();
    const count = r.readI32();
    if (valType === 'StructProperty' || keyType === 'StructProperty') {
      const entries2 = [];
      for (let i = 0; i < count; i++) {
        const entry = { key: null, value: null };
        if (keyType === 'StrProperty' || keyType === 'NameProperty') entry.key = r.readFString();
        else if (keyType === 'IntProperty') entry.key = r.readI32();
        else if (keyType === 'EnumProperty') entry.key = r.readFString();
        else if (keyType === 'StructProperty') {
          const keyProps = [];
          let kp;
          while ((kp = readProperty(r)) !== null) {
            keyProps.push(kp);
          }
          entry.key = keyProps;
        }
        if (valType === 'StructProperty') {
          const valProps = [];
          let vp;
          while ((vp = readProperty(r)) !== null) {
            valProps.push(vp);
          }
          entry.value = valProps;
        } else if (valType === 'FloatProperty') entry.value = r.readF32();
        else if (valType === 'IntProperty') entry.value = r.readI32();
        else if (valType === 'StrProperty') entry.value = r.readFString();
        else if (valType === 'BoolProperty') entry.value = r.readBool();
        entries2.push(entry);
      }
      prop.value = entries2;
      return;
    }
    const entries = {};
    for (let i = 0; i < count; i++) {
      let key;
      if (keyType === 'StrProperty' || keyType === 'NameProperty') key = r.readFString();
      else if (keyType === 'IntProperty') key = r.readI32();
      else if (keyType === 'EnumProperty') key = r.readFString();
      else {
        r.setOffset(afterSep + dataSize);
        prop.value = null;
        return;
      }
      let val;
      if (valType === 'FloatProperty') val = r.readF32();
      else if (valType === 'IntProperty') val = r.readI32();
      else if (valType === 'StrProperty') val = r.readFString();
      else if (valType === 'BoolProperty') val = r.readBool();
      else {
        r.setOffset(afterSep + dataSize);
        prop.value = null;
        return;
      }
      entries[key] = val;
    }
    prop.value = entries;
  } else {
    r.setOffset(afterSep + dataSize);
    prop.value = null;
  }
}
function recoverForward(r, startPos, maxScan = 5e5) {
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
//  Save Parser (auto-bundled from save-parser.ts)
// ═══════════════════════════════════════════════════════════════════════════

(createReader, parseHeader, readProperty, recoverForward);

const PERK_MAP = {
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
const PERK_INDEX_MAP = Object.fromEntries(
  Object.entries(PERK_MAP).map(([k, v]) => {
    const num = parseInt(k.split('NewEnumerator')[1] ?? '0', 10);
    return [num, v];
  }),
);
const CLAN_RANK_MAP = {
  'E_ClanRank::NewEnumerator0': 'Recruit',
  'E_ClanRank::NewEnumerator1': 'Member',
  'E_ClanRank::NewEnumerator2': 'Officer',
  'E_ClanRank::NewEnumerator3': 'Co-Leader',
  'E_ClanRank::NewEnumerator4': 'Leader',
};
const SEASON_MAP = {
  'UDS_Season::NewEnumerator0': 'Spring',
  'UDS_Season::NewEnumerator1': 'Summer',
  'UDS_Season::NewEnumerator2': 'Autumn',
  'UDS_Season::NewEnumerator3': 'Winter',
};
const STAT_TAG_MAP = {
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
function simplifyBlueprint(bp) {
  if (!bp || typeof bp !== 'string') return bp;
  const match = bp.match(/BP_([^.]+?)(?:_C)?$/);
  if (match) return match[1] ?? bp;
  const parts = bp.split('/');
  const last = parts[parts.length - 1] ?? '';
  return last.replace(/_C$/, '').replace(/^BP_/, '');
}
function createPlayerData() {
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
function parseSave(buf) {
  const r = createReader(buf);
  const header = parseHeader(r);
  const players = /* @__PURE__ */ new Map();
  const worldState = {};
  const structures = [];
  const vehicles = [];
  const companions = [];
  const deadBodies = [];
  const containers = [];
  const lootActors = [];
  const quests = [];
  const horses = [];
  let buildActorClasses = [];
  let buildActorHealths = [];
  let buildActorMaxHealths = [];
  let buildActorUpgrades = [];
  let buildActorTrailer = [];
  let buildActorStrings = [];
  let buildActorData = [];
  let buildActorNoSpawn = [];
  let buildActorInventories = [];
  let buildActorTransformCount = 0;
  let buildActorTransforms = [];
  let currentSteamID = null;
  function ensurePlayer(id) {
    if (!players.has(id)) players.set(id, createPlayerData());
    return players.get(id);
  }
  function prescanSteamId(props) {
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
  function handleProp(prop) {
    var _a, _b, _c, _d, _e;
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
    if (Array.isArray(prop.value) && prop.value.length > 0 && Array.isArray(prop.value[0])) {
      if (n === 'Statistics' && currentSteamID) {
        _extractStatistics(prop.value, ensurePlayer(currentSteamID));
      }
      if (n === 'ExtendedStats' && currentSteamID) {
        _extractExtendedStats(prop.value, ensurePlayer(currentSteamID));
      }
      if (n === 'Tree' && currentSteamID) {
        const p2 = ensurePlayer(currentSteamID);
        const allSkills = [];
        p2.skillTree = prop.value
          .map((elemProps) => {
            if (!Array.isArray(elemProps)) return null;
            const node = {};
            for (const ep of elemProps) {
              if (ep.name === 'Type') node['type'] = ep.value;
              else if (ep.name === 'Index') node['index'] = ep.value;
              else if (ep.name === 'Locked?') node['locked'] = ep.value;
              else if (ep.name === 'NeedSpecialUnlock?') node['needSpecialUnlock'] = ep.value;
              else if (ep.name === 'Exp') node['exp'] = ep.value;
              else if (ep.name === 'ExpNeeded') node['expNeeded'] = ep.value;
              else if (ep.name === 'UnlockedSkills' && Array.isArray(ep.value)) {
                node['unlockedSkills'] = ep.value.filter(Boolean);
                for (const s of node['unlockedSkills']) {
                  allSkills.push(s);
                }
              } else if (ep.name === 'UnlockProgress' && Array.isArray(ep.value)) node['unlockProgress'] = ep.value;
            }
            return node;
          })
          .filter(Boolean);
        if (allSkills.length) p2.unlockedSkills = allSkills;
        return;
      }
      for (const elemProps of prop.value) {
        if (Array.isArray(elemProps)) {
          prescanSteamId(elemProps);
          for (const ep of elemProps) {
            handleProp(ep);
          }
        }
      }
      if (n === 'DropInSaves') currentSteamID = null;
    }
    if (n === 'BuildActorClass' && Array.isArray(prop.value)) {
      buildActorClasses = prop.value;
      return;
    }
    if (n === 'BuildActorTransform') {
      if (Array.isArray(prop.value)) {
        buildActorTransforms = prop.value.map((elem) => {
          if (Array.isArray(elem)) {
            const t = elem.find((c) => c.name === 'Translation');
            return (t == null ? void 0 : t.value) ?? null;
          }
          return null;
        });
        buildActorTransformCount = prop.value.length;
      } else if (typeof prop.value === 'string' && prop.value.startsWith('<skipped')) {
        const m = prop.value.match(/\d+/);
        buildActorTransformCount = (m == null ? void 0 : m[0]) ? parseInt(m[0], 10) : 0;
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
      buildActorNoSpawn = prop.value;
      return;
    }
    if (n === 'BuildActorInventory' && Array.isArray(prop.value)) {
      buildActorInventories = prop.value;
      return;
    }
    if (n === 'Cars' && Array.isArray(prop.value)) {
      _extractVehicles(prop.value, vehicles);
      return;
    }
    if (n === 'Dogs' && Array.isArray(prop.value)) {
      for (const name of prop.value) {
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
      for (const name of prop.value) {
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
      _extractHorses(prop.value, horses);
      return;
    }
    if (n === 'LODPickups' && Array.isArray(prop.value)) {
      worldState['lodPickups'] = [];
      for (const elemProps of prop.value) {
        if (!Array.isArray(elemProps)) continue;
        const pickup = {
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
            const tv = ep.value;
            if (tv == null ? void 0 : tv.translation) {
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
        if (pickup['valid'] && pickup['item']) worldState['lodPickups'].push(pickup);
      }
      worldState['totalLodPickups'] = worldState['lodPickups'].length;
      return;
    }
    if (n === 'SavedActors' && Array.isArray(prop.value)) {
      worldState['savedActors'] = [];
      for (const elemProps of prop.value) {
        if (!Array.isArray(elemProps)) continue;
        const actor = {
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
            actor['displayName'] = simplifyBlueprint(ap.value ?? '');
          }
          if (ap.name === 'Transform') {
            const tv = ap.value;
            if (tv == null ? void 0 : tv.translation) {
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
        worldState['savedActors'].push(actor);
      }
      return;
    }
    if (n === 'NodeSaveData' && Array.isArray(prop.value)) {
      worldState['nodeSaveDataCount'] = prop.value.length;
      worldState['aiSpawns'] = [];
      for (const entry of prop.value) {
        if (!Array.isArray(entry)) continue;
        const nodeUid = entry.find((c) => c.name === 'NodeUID');
        const data = entry.find((c) => c.name === 'Data');
        if (!(data == null ? void 0 : data.value) || !Array.isArray(data.value)) continue;
        for (const aiInfo of data.value) {
          if (!Array.isArray(aiInfo)) continue;
          const aiType = (_a = aiInfo.find((c) => c.name === 'AIType')) == null ? void 0 : _a.value;
          const aiLoc = (_b = aiInfo.find((c) => c.name === 'AILocation')) == null ? void 0 : _b.value;
          const graveTime = (_c = aiInfo.find((c) => c.name === 'GraveTimeMinutes')) == null ? void 0 : _c.value;
          if (!aiType || aiType === 'EAItype::E_None') continue;
          const typeName = aiType.replace('EAItype::E_', '');
          let category = 'zombie';
          if (typeName.startsWith('Animal')) category = 'animal';
          else if (typeName.startsWith('Bandit')) category = 'bandit';
          worldState['aiSpawns'].push({
            type: typeName,
            category,
            nodeUid: (nodeUid == null ? void 0 : nodeUid.value) ?? '',
            x: aiLoc ? _round2(aiLoc.x) : null,
            y: aiLoc ? _round2(aiLoc.y) : null,
            z: aiLoc ? _round2(aiLoc.z) : null,
            graveTimeMinutes: typeof graveTime === 'number' ? graveTime : 0,
          });
        }
      }
      worldState['aiSummary'] = { zombies: 0, bandits: 0, animals: 0, byType: {} };
      const summary = worldState['aiSummary'];
      for (const ai of worldState['aiSpawns']) {
        if (ai.category === 'zombie') summary.zombies++;
        else if (ai.category === 'bandit') summary.bandits++;
        else if (ai.category === 'animal') summary.animals++;
        summary.byType[ai.type] = (summary.byType[ai.type] ?? 0) + 1;
      }
      return;
    }
    if (n === 'DestroyedSleepers' && Array.isArray(prop.value)) {
      worldState['destroyedSleepers'] = prop.value.length;
      worldState['destroyedSleeperIds'] = prop.value;
      return;
    }
    if (n === 'DestroyedRandCars') {
      if (Array.isArray(prop.value)) {
        worldState['destroyedRandCars'] = prop.value.length;
        worldState['destroyedRandCarPositions'] = prop.value
          .map((elem) => {
            if (elem && typeof elem.x === 'number') {
              return { x: _round2(elem.x), y: _round2(elem.y), z: _round2(elem.z) };
            }
            return null;
          })
          .filter(Boolean);
      } else if (typeof prop.value === 'string' && prop.value.startsWith('<skipped')) {
        worldState['destroyedRandCars'] = parseInt(
          ((_d = prop.value.match(/\d+/)) == null ? void 0 : _d[0]) ?? '0',
          10,
        );
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
      worldState['stoneCuttingStations'] = Array.isArray(prop.value) ? prop.value.length : 0;
      if (Array.isArray(prop.value)) {
        worldState['stoneCuttingData'] = prop.value
          .map((elemProps) => {
            if (!Array.isArray(elemProps)) return null;
            const station = { name: '', stage: 0, time: 0 };
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
        for (const elemProps of prop.value) {
          if (!Array.isArray(elemProps)) continue;
          const actor = {
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
              actor['displayName'] = simplifyBlueprint(ep.value ?? '');
            }
            if (ep.name === 'Transform') {
              const tv = ep.value;
              if (tv == null ? void 0 : tv.translation) {
                actor['x'] = _round2(tv.translation.x);
                actor['y'] = _round2(tv.translation.y);
                actor['z'] = _round2(tv.translation.z);
              }
            }
            if (ep.name === 'Resources' && ep.value) actor['resources'] = ep.value;
          }
          worldState['preBuildActors'].push(actor);
        }
      }
      worldState['preBuildActorCount'] = worldState['preBuildActors'].length;
      return;
    }
    if (n === 'SGlobalContainerSave') {
      worldState['globalContainers'] = [];
      if (Array.isArray(prop.value)) {
        for (const entry of prop.value) {
          if (!(entry == null ? void 0 : entry.value)) continue;
          const props = Array.isArray(entry.value) ? entry.value : [];
          const container = {
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
          if (container['items'].length > 0 || container['quickSlots'].length > 0) {
            worldState['globalContainers'].push(container);
          }
        }
      }
      worldState['totalGlobalContainers'] = worldState['globalContainers'].length;
      return;
    }
    if (n === 'LodModularLootActor') {
      worldState['modularLootActors'] = [];
      worldState['modularLootSlotCount'] = 0;
      if (Array.isArray(prop.value)) {
        for (const entry of prop.value) {
          if (!entry) continue;
          const entryProps = [...(entry.key ?? []), ...(entry.value ?? [])];
          if (entryProps.length === 0) continue;
          const actor = { name: '', disabled: false, spawned: false, slots: [] };
          for (const cp of entryProps) {
            if (cp.name === 'Name') actor['name'] = cp.value ?? '';
            if (cp.name === 'Disabled?') actor['disabled'] = !!cp.value;
            if (cp.name === 'Spawned?') actor['spawned'] = !!cp.value;
            if (cp.name === 'Slots' && Array.isArray(cp.value)) {
              for (const slot of cp.value) {
                if (!Array.isArray(slot)) continue;
                const s = { supportedItems: [], itemId: '', count: 0, durability: 0 };
                for (const sp of slot) {
                  if (sp.name === 'SupportedItems' && Array.isArray(sp.value)) s['supportedItems'] = sp.value;
                  if (sp.name === 'ItemID') s['itemId'] = sp.value ?? '';
                  if (sp.name === 'Count' && typeof sp.value === 'number') s['count'] = sp.value;
                  if (sp.name === 'Dur' && typeof sp.value === 'number') s['durability'] = _round(sp.value);
                }
                actor['slots'].push(s);
                worldState['modularLootSlotCount'] = worldState['modularLootSlotCount'] + 1;
              }
            }
          }
          worldState['modularLootActors'].push(actor);
        }
      }
      worldState['totalModularLootActors'] = worldState['modularLootActors'].length;
      return;
    }
    if (n === 'ExtraParams' && Array.isArray(prop.value)) {
      worldState['_extraParams'] = prop.value;
      return;
    }
    if (n === 'BuildingDecay' && Array.isArray(prop.value)) {
      worldState['buildingDecayCount'] = prop.value.length;
      let decaying = 0;
      for (const v of prop.value) {
        if (typeof v === 'number' && v > 0) decaying++;
      }
      worldState['buildingDecayActive'] = decaying;
      return;
    }
    if (n === 'ExplodableBarrelsTransform' && Array.isArray(prop.value)) {
      worldState['explodableBarrelPositions'] = prop.value
        .map((elem) => {
          if (Array.isArray(elem)) {
            const t = elem.find((c) => c.name === 'Translation');
            const tv = t == null ? void 0 : t.value;
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
      for (const entry of prop.value) {
        if (!entry) continue;
        const entryProps = [...(entry.key ?? []), ...(entry.value ?? [])];
        if (entryProps.length === 0) continue;
        const house = {
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
            house['windowsTotal'] = hp.value.length;
            house['windowsOpen'] = hp.value.filter(Boolean).length;
          }
          if (hp.name === 'DoorsOpened' && Array.isArray(hp.value)) {
            house['doorsTotal'] = hp.value.length;
            house['doorsOpen'] = hp.value.filter(Boolean).length;
          }
          if (hp.name === 'DoorsLocked' && Array.isArray(hp.value)) {
            house['doorsLocked'] = hp.value.filter(Boolean).length;
          }
          if (hp.name === 'DestroyedFurniture' && Array.isArray(hp.value)) {
            house['destroyedFurniture'] = hp.value.length;
          }
          if (hp.name === 'HasGenerator?') house['hasGenerator'] = !!hp.value;
          if (hp.name === 'RandomSeed' && typeof hp.value === 'number') house['randomSeed'] = hp.value;
          if (hp.name === 'FloatData' && hp.value && typeof hp.value === 'object') house['floatData'] = hp.value;
        }
        if (house['name']) worldState['houses'].push(house);
      }
      worldState['totalHouses'] = worldState['houses'].length;
      return;
    }
    if (n === 'FoliageBerry') {
      worldState['foliageBerry'] = prop.children ?? prop.value;
      return;
    }
    if (n === 'HZActorManagerData') {
      if (prop.children) {
        const mgr = { destroyedActors: [], destroyedInstances: [] };
        for (const c of prop.children) {
          if (c.name === 'DestroyedActorProps' && Array.isArray(c.value)) mgr['destroyedActors'] = c.value;
          if (c.name === 'DestroyedInstances' && Array.isArray(c.value)) {
            for (const inst of c.value) {
              if (!Array.isArray(inst)) continue;
              const entry = { compTag: '', indices: [] };
              for (const ip of inst) {
                if (ip.name === 'CompTag') entry['compTag'] = ip.value ?? '';
                if (ip.name === 'DestroyedInstanceIndices' && Array.isArray(ip.value)) entry['indices'] = ip.value;
              }
              if (entry['compTag']) mgr['destroyedInstances'].push(entry);
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
      for (const elemProps of prop.value) {
        if (!Array.isArray(elemProps)) continue;
        const backpack = { x: null, y: null, z: null, items: [], class: '' };
        for (const bp of elemProps) {
          if (bp.name === 'BackpackTransform') {
            const tv = bp.value;
            if (tv == null ? void 0 : tv.translation) {
              backpack['x'] = _round2(tv.translation.x);
              backpack['y'] = _round2(tv.translation.y);
              backpack['z'] = _round2(tv.translation.z);
            }
          }
          if (bp.name === 'BackpackClass') backpack['class'] = bp.value ?? '';
          if (bp.name === 'EquippedBackpack') backpack['equipped'] = !!bp.value;
          if (bp.name === 'BackpackInventory' && Array.isArray(bp.value)) backpack['items'] = bp.value;
        }
        if (backpack['x'] !== null) worldState['droppedBackpacks'].push(backpack);
      }
      worldState['totalDroppedBackpacks'] = worldState['droppedBackpacks'].length;
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
        const airdrop = {};
        for (const c of prop.children) {
          if (c.name === 'Loc') {
            const tv = c.value;
            if (tv == null ? void 0 : tv.translation) {
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
      const dropIns = [];
      for (const elemProps of prop.value) {
        if (!Array.isArray(elemProps)) continue;
        for (const ep of elemProps) {
          if (ep.name === 'SteamID' && typeof ep.value === 'string') {
            const m = ep.value.match(/(7656\d+)/);
            if (m == null ? void 0 : m[1]) dropIns.push(m[1]);
          }
        }
      }
      worldState['dropInSaves'] = dropIns;
      return;
    }
    if (n === 'UniqueSpawners') {
      worldState['uniqueSpawnerCount'] = Array.isArray(prop.value) ? prop.value.length : 0;
      worldState['uniqueSpawnerIds'] = Array.isArray(prop.value) ? prop.value : [];
      return;
    }
    if (n === 'Dedi_DaysPassed' && typeof prop.value === 'number') {
      worldState['daysPassed'] = prop.value;
      return;
    }
    if (n === 'CurrentSeason') {
      worldState['currentSeason'] = SEASON_MAP[prop.value] ?? prop.value;
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
        const diff = {};
        for (const c of prop.children) {
          if (c.name === 'LootAmontMultiplier' && typeof c.value === 'number') diff['lootMultiplier'] = c.value;
          if (c.name === 'LootRespawnTimer' && typeof c.value === 'number') diff['lootRespawnTimer'] = c.value;
          if (c.name === 'ZombieAmountMultiplier' && typeof c.value === 'number') diff['zombieMultiplier'] = c.value;
          if (c.name === 'DayDuration' && typeof c.value === 'number') diff['dayDuration'] = c.value;
          if (c.name === 'StartingSeason') diff['startingSeason'] = SEASON_MAP[c.value] ?? c.value;
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
        for (const c of ws) {
          if (c.name === 'TotalDaysElapsed' && typeof c.value === 'number') worldState['totalDaysElapsed'] = c.value;
          if (c.name === 'TimeofDay' && typeof c.value === 'number')
            worldState['timeOfDay'] = Math.round(c.value * 100) / 100;
        }
      }
      return;
    }
    if (!currentSteamID) return;
    const p = ensurePlayer(currentSteamID);
    if (n === 'DayzSurvived' && typeof prop.value === 'number') p.daysSurvived = prop.value;
    if (n === 'Affliction' && typeof prop.value === 'number') p.affliction = prop.value;
    if (n === 'Male') p.male = !!prop.value;
    if (n === 'DayIncremented') p.dayIncremented = !!prop.value;
    if (n === 'Backpack' && typeof prop.value === 'number') p.backpackSize = prop.value;
    if (n === 'Profile') p.characterProfile = prop.value || '';
    if (n === 'Skin' && typeof prop.value === 'number') p.skinTone = prop.value;
    if (n === 'BSize' && typeof prop.value === 'number') p.bSize = prop.value;
    if (n === 'Dur' && typeof prop.value === 'number') p.durability = prop.value;
    if (n === 'DirtBlood' && prop.children) p.dirtBlood = _childrenToObject(prop.children);
    if (n === 'RandColor' && typeof prop.value === 'number') p.randColor = prop.value;
    if (n === 'RandHair' && typeof prop.value === 'number') p.randHair = prop.value;
    if (n === 'RepUpper') p.repUpper = prop.value || '';
    if (n === 'RepHead') p.repHead = prop.value || '';
    if (n === 'RepLower') p.repLower = prop.value || '';
    if (n === 'RepHand') p.repHand = prop.value || '';
    if (n === 'RepBoot') p.repBoot = prop.value || '';
    if (n === 'RepFace') p.repFace = prop.value || '';
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
      let mapped;
      if (typeof prop.value === 'string') mapped = PERK_MAP[prop.value];
      else if (typeof prop.value === 'number') mapped = PERK_INDEX_MAP[prop.value];
      if (mapped) p.startingPerk = mapped;
    }
    if (n === 'GameStats' && prop.value && typeof prop.value === 'object') {
      const gs = prop.value;
      if (gs['ZeeksKilled'] !== void 0) p.zeeksKilled = gs['ZeeksKilled'];
      if (gs['HeadShot'] !== void 0) p.headshots = gs['HeadShot'];
      if (gs['MeleeKills'] !== void 0) p.meleeKills = gs['MeleeKills'];
      if (gs['GunKills'] !== void 0) p.gunKills = gs['GunKills'];
      if (gs['BlastKills'] !== void 0) p.blastKills = gs['BlastKills'];
      if (gs['FistKills'] !== void 0) p.fistKills = gs['FistKills'];
      if (gs['TakedownKills'] !== void 0) p.takedownKills = gs['TakedownKills'];
      if (gs['VehicleKills'] !== void 0) p.vehicleKills = gs['VehicleKills'];
      if (gs['DaysSurvived'] !== void 0 && gs['DaysSurvived'] > 0) p.daysSurvived = gs['DaysSurvived'];
    }
    if (n === 'FloatData' && prop.value && typeof prop.value === 'object') {
      const fd = prop.value;
      if (fd['Fatigue'] !== void 0) p.fatigue = _round2(fd['Fatigue']);
      if (fd['InfectionBuildup'] !== void 0) p.infectionBuildup = Math.round(fd['InfectionBuildup']);
      if (fd['WellRested'] !== void 0) p.wellRested = _round2(fd['WellRested']);
      if (fd['Energy'] !== void 0) p.energy = _round2(fd['Energy']);
      if (fd['Hood'] !== void 0) p.hood = _round2(fd['Hood']);
      if (fd['HypoHandle'] !== void 0) p.hypoHandle = _round2(fd['HypoHandle']);
      if (fd['BadFood'] !== void 0) p.badFood = _round2(fd['BadFood']);
      if (fd['Skin_Blood'] !== void 0) p.skinBlood = _round2(fd['Skin_Blood']);
      if (fd['Skin_Dirt'] !== void 0) p.skinDirt = _round2(fd['Skin_Dirt']);
      if (fd['Clean'] !== void 0) p.clean = _round2(fd['Clean']);
      if (fd['Sleepers'] !== void 0) p.sleepers = _round2(fd['Sleepers']);
      p.floatData = fd;
    }
    if (n === 'CustomData' && prop.value && typeof prop.value === 'object') p.customData = prop.value;
    if (n === 'Recipe_Crafting' && Array.isArray(prop.value)) p.craftingRecipes = prop.value.filter(Boolean);
    if (n === 'Recipe_Building' && Array.isArray(prop.value)) p.buildingRecipes = prop.value.filter(Boolean);
    if (n === 'PlayerStates' && Array.isArray(prop.value)) p.playerStates = prop.value;
    if (n === 'BodyCondition' && Array.isArray(prop.value)) p.bodyConditions = prop.value;
    if (n === 'UnlockedProfessionArr' && Array.isArray(prop.value)) p.unlockedProfessions = prop.value;
    if ((n === 'UnlockedSkills' || n.startsWith('UnlockedSkills_')) && Array.isArray(prop.value))
      p.unlockedSkills = prop.value.filter(Boolean);
    if (n === 'Skills' && Array.isArray(prop.value)) p.skillsData = prop.value;
    if ((n === 'UniqueLoots' || n.startsWith('UniqueLoots_')) && Array.isArray(prop.value)) p.uniqueLoots = prop.value;
    if ((n === 'CraftedUniques' || n.startsWith('CraftedUniques_')) && Array.isArray(prop.value))
      p.craftedUniques = prop.value.filter(Boolean);
    if (n === 'LootItemUnique' && Array.isArray(prop.value)) p.lootItemUnique = prop.value.filter(Boolean);
    if (n === 'LoreId' && typeof prop.value === 'string') p.lore.push(prop.value);
    if (n === 'Lore' && Array.isArray(prop.value)) p.lore = prop.value;
    if (n === 'PlayerTransform' && prop.type === 'StructProperty' && prop.structType === 'Transform') {
      _extractTransform(prop, p);
    } else if (
      p.x === null &&
      prop.type === 'StructProperty' &&
      prop.structType === 'Transform' &&
      ((_e = prop.value) == null ? void 0 : _e.translation)
    ) {
      const SKIP_TRANSFORMS = ['PlayerRespawnPoint', 'BackpackTransform', 'Transform', 'CompanionTransform'];
      if (!SKIP_TRANSFORMS.includes(n)) _extractTransform(prop, p);
    }
    if (n === 'PlayerRespawnPoint' && prop.type === 'StructProperty' && prop.structType === 'Transform') {
      const tv = prop.value;
      if ((tv == null ? void 0 : tv.translation) && typeof tv.translation.x === 'number') {
        p.respawnX = _round2(tv.translation.x);
        p.respawnY = _round2(tv.translation.y);
        p.respawnZ = _round2(tv.translation.z);
      }
    }
    if (n === 'CharProfile' && prop.children) {
      const profile = {};
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
    if (n === 'PlayerInventory' && Array.isArray(prop.value)) p.inventory = prop.value;
    if (n === 'PlayerEquipment' && Array.isArray(prop.value)) p.equipment = prop.value;
    if (n === 'PlayerQuickSlots' && Array.isArray(prop.value)) p.quickSlots = prop.value;
    if ((n === 'BackpackInventory' || n.startsWith('BackpackInventory_')) && Array.isArray(prop.value))
      p.backpackItems = prop.value;
    if (n === 'BackpackData' && (prop.children || Array.isArray(prop.value))) {
      p.backpackData = prop.children ? _childrenToObject(prop.children) : prop.value;
    }
    if (n === 'QuestData' && Array.isArray(prop.value)) p.questData = prop.value;
    if (n === 'MiniQuest' && (prop.children || prop.value)) {
      p.miniQuest = prop.children ? _childrenToObject(prop.children) : prop.value;
    }
    if (n === 'Challenges' && Array.isArray(prop.value)) p.challenges = prop.value;
    if (n === 'QuestSpawnerDone' && Array.isArray(prop.value)) p.questSpawnerDone = prop.value;
    if (n === 'CompanionData' && Array.isArray(prop.value)) {
      p.companionData = [];
      for (const cd of prop.value) {
        if (!Array.isArray(cd)) continue;
        const comp = {
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
            comp['displayName'] = simplifyBlueprint(cp.value ?? '');
          }
          if (cp.name === 'Transform') {
            const tv = cp.value;
            if (tv == null ? void 0 : tv.translation) {
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
          actorName: comp['displayName'] || comp['class'],
          ownerSteamId: currentSteamID ?? '',
          x: comp['x'],
          y: comp['y'],
          z: comp['z'],
          health: comp['health'],
          extra: { energy: comp['energy'], command: comp['command'], vest: comp['vest'] },
        });
      }
    }
    if (n === 'Horses' && Array.isArray(prop.value)) p.horses = prop.value;
  }
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
  const structCount = buildActorClasses.length || buildActorTransformCount;
  for (let i = 0; i < structCount; i++) {
    const ownerStr = buildActorStrings[i] ?? '';
    const ownerMatch = ownerStr.match(/(7656\d+)/);
    const transform = buildActorTransforms[i];
    structures.push({
      actorClass: buildActorClasses[i] ?? '',
      displayName: simplifyBlueprint(buildActorClasses[i] ?? ''),
      ownerSteamId: (ownerMatch == null ? void 0 : ownerMatch[1]) ?? '',
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
    for (const nsp of nsProps) {
      if (nsp.name === 'BuildActor' && typeof nsp.value === 'string') {
        const idx = structures.findIndex((s) => s.extraData === nsp.value || s.actorClass === nsp.value);
        if (idx >= 0) structures[idx].noSpawn = true;
      }
    }
  }
  for (let idx = 0; idx < buildActorInventories.length; idx++) {
    const invProps = buildActorInventories[idx];
    if (!Array.isArray(invProps)) continue;
    let actorName = '';
    let items = [];
    let quickSlots = [];
    let locked = false;
    let craftingContent = [];
    let doesSpawnLoot = false;
    for (const ip of invProps) {
      if (ip.name === 'ContainerActor') actorName = ip.value || '';
      if (ip.name === 'ContainerInventoryArray' && Array.isArray(ip.value)) items = ip.value;
      if (ip.name === 'ContainerQuickSlotArray' && Array.isArray(ip.value)) quickSlots = ip.value;
      if (ip.name === 'Locked?') locked = !!ip.value;
      if (ip.name === 'DoesSpawnLoot') doesSpawnLoot = !!ip.value;
      if (ip.name === 'CraftingContent' && Array.isArray(ip.value)) craftingContent = ip.value;
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
    const diff = worldState['gameDifficulty'];
    const startIdx = SEASONS.indexOf(diff['startingSeason']);
    if (startIdx !== -1 && worldState['daysPassed'] != null) {
      const dps = diff['daysPerSeason'] || 28;
      const seasonsPassed = Math.floor(worldState['daysPassed'] / dps);
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
function _extractExtendedStats(statArray, player) {
  player.extendedStats = [];
  for (const elemProps of statArray) {
    if (!Array.isArray(elemProps)) continue;
    const stat = {};
    for (const ep of elemProps) {
      if (ep.name === 'StatName') stat['name'] = ep.value;
      if (ep.name === 'StatValue' && typeof ep.value === 'number') stat['value'] = ep.value;
    }
    if (stat['name']) player.extendedStats.push(stat);
  }
}
function _extractVehicles(carArray, vehicleList) {
  for (const carProps of carArray) {
    if (!Array.isArray(carProps)) continue;
    const vehicle = {
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
        vehicle.class = cp.value || '';
        vehicle.displayName = simplifyBlueprint(cp.value || '');
      }
      if (cp.name === 'Health' && typeof cp.value === 'number') vehicle.health = _round(cp.value);
      if (cp.name === 'MaxHealth' && typeof cp.value === 'number') vehicle.maxHealth = _round(cp.value);
      if (cp.name === 'Fuel' && typeof cp.value === 'number') vehicle.fuel = _round(cp.value);
      if (cp.name === 'Transform') {
        const tv = cp.value;
        if (tv == null ? void 0 : tv.translation) {
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
function _extractContainers(prop, containerList) {
  if (!Array.isArray(prop.value)) return;
  for (const elemProps of prop.value) {
    if (!Array.isArray(elemProps)) continue;
    const container = {
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
      if (cp.name === 'ContainerActor') container.actorName = cp.value || '';
      if (cp.name === 'ContainerInventoryArray' && Array.isArray(cp.value)) container.items = cp.value;
      if (cp.name === 'ContainerQuickSlotArray' && Array.isArray(cp.value)) container.quickSlots = cp.value;
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
function _extractHorses(horseArray, horseList) {
  for (const horseProps of horseArray) {
    if (!Array.isArray(horseProps)) continue;
    const horse = {
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
        horse.class = hp.value || '';
        horse.displayName = simplifyBlueprint(hp.value || '');
      }
      if (hp.name === 'HorseName' && typeof hp.value === 'string') horse.name = hp.value;
      if (hp.name === 'Health' && typeof hp.value === 'number') horse.health = _round(hp.value);
      if (hp.name === 'MaxHealth' && typeof hp.value === 'number') horse.maxHealth = _round(hp.value);
      if (hp.name === 'Energy' && typeof hp.value === 'number') horse.energy = _round(hp.value);
      if (hp.name === 'Stamina' && typeof hp.value === 'number') horse.stamina = _round(hp.value);
      if (hp.name === 'Transform') {
        const tv = hp.value;
        if (tv == null ? void 0 : tv.translation) {
          horse.x = _round2(tv.translation.x);
          horse.y = _round2(tv.translation.y);
          horse.z = _round2(tv.translation.z);
        }
      }
      if (hp.name === 'Owner' && typeof hp.value === 'string') {
        const m = hp.value.match(/(7656\d+)/);
        if (m == null ? void 0 : m[1]) horse.ownerSteamId = m[1];
      }
      if (hp.name === 'SaddleInventory' && Array.isArray(hp.value)) horse.saddleInventory = hp.value;
      if (hp.name === 'Inventory' && Array.isArray(hp.value)) horse.inventory = hp.value;
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
function _extractLootActors(prop, actorList) {
  if (!Array.isArray(prop.value)) return;
  for (const elemProps of prop.value) {
    if (!Array.isArray(elemProps)) continue;
    const actor = { name: '', type: '', x: null, y: null, z: null, items: [] };
    for (const lp of elemProps) {
      if (lp.name === 'Name') actor.name = lp.value || '';
      if (lp.name === 'Type') actor.type = lp.value || '';
      if (lp.name === 'Items' && Array.isArray(lp.value)) actor.items = lp.value;
    }
    if (actor.name) actorList.push(actor);
  }
}
function _extractWorldQuests(prop, questList) {
  if (!Array.isArray(prop.value)) return;
  for (const elemProps of prop.value) {
    if (!Array.isArray(elemProps)) continue;
    const quest = { id: '', type: '', state: '', data: {} };
    for (const qp of elemProps) {
      if (qp.name === 'GUID' || qp.name === 'ID') quest.id = qp.value || '';
      if (qp.name === 'QuestType') quest.type = qp.value || '';
      if (qp.name === 'State' || qp.name === 'Status') quest.state = qp.value || '';
    }
    if (quest.id) questList.push(quest);
  }
}
function _extractTransform(prop, player) {
  const tv = prop.value;
  if (tv == null ? void 0 : tv.translation) {
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
function _childrenToObject(children) {
  const obj = {};
  for (const c of children) {
    if (c.name && c.value !== void 0 && c.value !== 'struct' && c.value !== '<text>') {
      obj[c.name] = c.value;
    }
    if (c.children) {
      obj[c.name] = _childrenToObject(c.children);
    }
  }
  return obj;
}
function _round(v) {
  return v;
}
function _round2(v) {
  return v;
}
function parseClanData(buf) {
  var _a, _b, _c, _d, _e, _f, _g;
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
          if (((_a = cp.name) == null ? void 0 : _a.startsWith('ClanName')) && typeof cp.value === 'string')
            clan.name = cp.value;
          if (((_b = cp.name) == null ? void 0 : _b.startsWith('Members')) && cp.type === 'ArrayProperty') {
            if (Array.isArray(cp.value)) {
              for (const memberProps of cp.value) {
                if (!Array.isArray(memberProps)) continue;
                const member = { name: '', steamId: '', rank: 'Member', canInvite: false, canKick: false };
                for (const mp of memberProps) {
                  if (((_c = mp.name) == null ? void 0 : _c.startsWith('Name')) && typeof mp.value === 'string')
                    member.name = mp.value;
                  if (((_d = mp.name) == null ? void 0 : _d.startsWith('NetID')) && typeof mp.value === 'string') {
                    const match = mp.value.match(/(7656\d+)/);
                    if (match == null ? void 0 : match[1]) member.steamId = match[1];
                  }
                  if (((_e = mp.name) == null ? void 0 : _e.startsWith('Rank')) && typeof mp.value === 'string') {
                    member.rank = CLAN_RANK_MAP[mp.value] ?? mp.value;
                  }
                  if ((_f = mp.name) == null ? void 0 : _f.startsWith('CanInvite')) member.canInvite = !!mp.value;
                  if ((_g = mp.name) == null ? void 0 : _g.startsWith('CanKick')) member.canKick = !!mp.value;
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
const CLAN_FILENAME = 'Save_ClanData.sav';

// ── Argument parsing ──

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { save: '', output: '', watch: false, interval: 30, help: false, discover: false, pretty: false };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--watch' || arg === '-w') opts.watch = true;
    else if (arg === '--pretty' || arg === '-p') opts.pretty = true;
    else if (arg === '--discover') opts.discover = true;
    else if ((arg === '--save' || arg === '-s') && args[i + 1]) opts.save = args[++i];
    else if ((arg === '--output' || arg === '-o') && args[i + 1]) opts.output = args[++i];
    else if ((arg === '--interval' || arg === '-i') && args[i + 1]) opts.interval = parseInt(args[++i], 10) || 30;
    else if (!arg.startsWith('-')) opts.save = arg; // positional = save path
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
  --pretty, -p           Pretty-print JSON output (human-readable)
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
    try {
      if (_fs.existsSync(p)) return p;
    } catch {
      /* skip */
    }
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
  } catch {
    /* permission denied, etc */
  }
  return null;
}

// ── Parse and write cache ──

function parseAndWrite(savePath, outputPath, pretty) {
  const startTime = Date.now();

  const buf = _fs.readFileSync(savePath);
  const result = parseSave(buf);

  // Convert players Map to plain object for JSON serialisation
  const playersObj = {};
  for (const [steamId, data] of result.players) {
    playersObj[steamId] = data;
  }

  // Parse clan data if Save_ClanData.sav exists alongside the main save
  let clans = [];
  const clanPath = _path.join(_path.dirname(savePath), CLAN_FILENAME);
  try {
    if (_fs.existsSync(clanPath)) {
      const clanBuf = _fs.readFileSync(clanPath);
      clans = parseClanData(clanBuf);
    }
  } catch (err) {
    console.error('[Agent] Clan parse warning:', err.message);
  }

  const cache = {
    v: 2,
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
    horses: result.horses,
    clans: clans,
  };

  const json = pretty ? JSON.stringify(cache, null, 2) : JSON.stringify(cache);

  // Atomic write: write to temp file then rename to prevent the bot
  // from reading a partially-written cache during an FTP download
  const tmpPath = outputPath + '.tmp';
  _fs.writeFileSync(tmpPath, json);
  _fs.renameSync(tmpPath, outputPath);

  const elapsed = Date.now() - startTime;
  const sizeMB = (json.length / 1024 / 1024).toFixed(2);
  const playerCount = Object.keys(playersObj).length;
  const clanInfo = clans.length ? ', ' + clans.length + ' clans' : '';
  console.log(
    '[Agent] Parsed ' +
      playerCount +
      ' players, ' +
      result.structures.length +
      ' structures, ' +
      result.vehicles.length +
      ' vehicles' +
      clanInfo +
      ' → ' +
      sizeMB +
      'MB cache (' +
      elapsed +
      'ms)',
  );

  return cache;
}

// ── Watch mode ──

function watchMode(savePath, outputPath, intervalSec, pretty) {
  let lastMtime = 0;

  function check() {
    try {
      const stat = _fs.statSync(savePath);
      if (stat.mtimeMs !== lastMtime) {
        lastMtime = stat.mtimeMs;
        parseAndWrite(savePath, outputPath, pretty);
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

  if (opts.help) {
    showHelp();
    process.exit(0);
  }

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
    watchMode(savePath, outputPath, opts.interval, opts.pretty);
  } else {
    parseAndWrite(savePath, outputPath, opts.pretty);
  }
}

main();

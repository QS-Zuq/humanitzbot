/* ── Low-level binary readers ── */

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
  function readGuid() { const g = buf.subarray(offset, offset + 16); offset += 16; return g.toString('hex'); }
  function readBool() { return readU8() !== 0; }

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

  return {
    readU8, readU16, readU32, readI32, readI64, readF32, readF64,
    readGuid, readBool, readFString, getOffset, setOffset, remaining,
    length: buf.length,
  };
}

/* ── Strip UE4 GUID suffixes from property names ── */
function cleanName(name) {
  return name.replace(/_\d+_[A-F0-9]{32}$/i, '');
}

/* ── Property names whose Map values we want to capture ── */
const MAP_CAPTURE = new Set(['GameStats', 'FloatData']);

/* ── Statistics tag path → player field mapping ── */
const EXTENDED_STAT_MAP = {
  // Kill stats (cumulative / lifetime)
  'statistics.stat.game.kills.total':         'lifetimeKills',
  'statistics.stat.game.kills.headshot':       'lifetimeHeadshots',
  'statistics.stat.game.kills.type.melee':     'lifetimeMeleeKills',
  'statistics.stat.game.kills.type.ranged':    'lifetimeGunKills',
  'statistics.stat.game.kills.type.blast':     'lifetimeBlastKills',
  'statistics.stat.game.kills.type.unarmed':   'lifetimeFistKills',
  'statistics.stat.game.kills.type.takedown':  'lifetimeTakedownKills',
  'statistics.stat.game.kills.type.vehicle':   'lifetimeVehicleKills',
  // Survival / activity
  'statistics.stat.progress.survivefor3days':  'lifetimeDaysSurvived',
  'statistics.stat.game.bitten':               'timesBitten',
  'statistics.stat.game.activity.FishCaught':       'fishCaught',
  'statistics.stat.game.activity.FishCaught.Pike':  'fishCaughtPike',
  // Challenge / progress trackers
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

/* ── Parse the GVAS header ── */
function parseHeader(r) {
  const magic = Buffer.from([
    r.readU8(), r.readU8(), r.readU8(), r.readU8(),
  ]).toString('ascii');
  if (magic !== 'GVAS') throw new Error('Not a GVAS save file');

  r.readU32(); // save version
  r.readU32(); // package version
  r.readU16(); r.readU16(); r.readU16(); // engine major.minor.patch
  r.readU32(); // build
  r.readFString(); // branch

  r.readU32(); // custom version format
  const numCV = r.readU32();
  for (let i = 0; i < numCV; i++) {
    r.readGuid(); r.readI32();
  }
  r.readFString(); // save class
}

/* ── Read a single UProperty ── */
function readProperty(r) {
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
        prop.value = r.readBool(); r.readU8();
        break;
      case 'IntProperty':
        r.readU8(); prop.value = r.readI32();
        break;
      case 'UInt32Property':
        r.readU8(); prop.value = r.readU32();
        break;
      case 'Int64Property':
        r.readU8(); prop.value = r.readI64();
        break;
      case 'FloatProperty':
        r.readU8(); prop.value = r.readF32();
        break;
      case 'DoubleProperty':
        r.readU8(); prop.value = r.readF64();
        break;
      case 'StrProperty':
      case 'NameProperty':
      case 'SoftObjectProperty':
      case 'ObjectProperty':
        r.readU8(); prop.value = r.readFString();
        break;
      case 'EnumProperty':
        prop.enumType = r.readFString(); r.readU8();
        prop.value = r.readFString();
        break;
      case 'ByteProperty': {
        const enumName = r.readFString(); r.readU8();
        if (enumName === 'None') { prop.value = r.readU8(); }
        else { prop.enumType = enumName; prop.value = r.readFString(); }
        break;
      }
      case 'TextProperty':
        r.readU8(); r.setOffset(r.getOffset() + dataSize); prop.value = '<text>';
        break;

      case 'StructProperty': {
        const structType = r.readFString();
        r.readGuid(); r.readU8();
        prop.structType = structType;
        if (structType === 'Vector' || structType === 'Rotator') {
          prop.value = { x: r.readF32(), y: r.readF32(), z: r.readF32() };
        } else if (structType === 'Quat') {
          prop.value = { x: r.readF32(), y: r.readF32(), z: r.readF32(), w: r.readF32() };
        } else if (structType === 'Guid') {
          prop.value = r.readGuid();
        } else if (structType === 'LinearColor') {
          prop.value = { r: r.readF32(), g: r.readF32(), b: r.readF32(), a: r.readF32() };
        } else if (structType === 'DateTime' || structType === 'Timespan') {
          prop.value = r.readI64();
        } else if (structType === 'Vector2D') {
          prop.value = { x: r.readF32(), y: r.readF32() };
        } else if (structType === 'GameplayTag') {
          // Parse as generic struct so we can read TagName child
          prop.value = 'struct';
          const tagChildren = [];
          let tagChild;
          while ((tagChild = readProperty(r)) !== null) tagChildren.push(tagChild);
          prop.children = tagChildren;
        } else if (structType === 'GameplayTagContainer') {
          const c = r.readU32(); prop.value = [];
          for (let i = 0; i < c; i++) prop.value.push(r.readFString());
        } else if (structType === 'TimerHandle') {
          prop.value = r.readFString();
        } else if (structType === 'Transform') {
          prop.value = 'transform';
          while (readProperty(r) !== null) { /* consume sub-props */ }
        } else {
          // Generic struct — read children into parent flow
          prop.value = 'struct';
          // Children are handled externally by handleProperty()
          const children = [];
          let child;
          while ((child = readProperty(r)) !== null) children.push(child);
          prop.children = children;
        }
        break;
      }

      case 'ArrayProperty': {
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
          r.readGuid(); r.readU8();
          prop.arrayStructType = arrStructType;

          // Skip large world arrays
          if (['Transform', 'Vector', 'Rotator'].includes(arrStructType) && count > 10) {
            r.setOffset(afterSep + dataSize);
            prop.value = `<skipped ${count}>`;
          } else if (arrStructType === 'S_Slots') {
            // Inventory slots — parse to extract items
            const items = [];
            for (let i = 0; i < count; i++) {
              const slotProps = [];
              let child;
              while ((child = readProperty(r)) !== null) slotProps.push(child);
              // Extract item name + durability
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
                items.push({ item: itemName, amount, durability: Math.round(durability * 10) / 10 });
              }
            }
            prop.value = items;
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
        } else {
          r.setOffset(afterSep + dataSize);
          prop.value = `<unknown ${innerType}>`;
        }
        break;
      }

      case 'MapProperty': {
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
            else { r.setOffset(afterSep + dataSize); prop.value = null; break; }
            let val;
            if (valType === 'FloatProperty') val = r.readF32();
            else if (valType === 'IntProperty') val = r.readI32();
            else if (valType === 'StrProperty') val = r.readFString();
            else if (valType === 'BoolProperty') val = r.readBool();
            else { r.setOffset(afterSep + dataSize); prop.value = null; break; }
            entries[key] = val;
          }
          prop.value = entries;
        } else {
          r.setOffset(afterSep + dataSize);
          prop.value = null;
        }
        break;
      }

      case 'SetProperty': {
        const inner = r.readFString();
        r.readU8();
        const afterSep = r.getOffset();
        r.setOffset(afterSep + dataSize);
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
    // Unrecoverable parse error
    return null;
  }

  return prop;
}

/* ── Perk enum to readable name ── */
// Verified by extracting DT_Professions DataTable from game pak file
// (pakchunk0-WindowsNoEditor.pak → /Game/Coredamage/Data/DT_Professions)
// Enumerators 4-8 and 11 were removed from the game and no longer exist.
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

// ByteProperty stores the enum index as a number — same mapping as above
const PERK_INDEX_MAP = {
  0: 'Unemployed', 1: 'Amateur Boxer', 2: 'Farmer', 3: 'Mechanic',
  9: 'Car Salesman', 10: 'Outdoorsman', 12: 'Chemist',
  13: 'Emergency Medical Technician', 14: 'Military Veteran',
  15: 'Thief', 16: 'Fire Fighter', 17: 'Electrical Engineer',
};

/* ── Main parse function ── */
function parseSave(buf) {
  const r = createReader(buf);
  parseHeader(r);

  // State machine: track current player by SteamID marker
  let currentSteamID = null;
  const players = new Map();

  function ensurePlayer(id) {
    if (!players.has(id)) {
      players.set(id, {
        // Kill stats
        zeeksKilled: 0,
        headshots: 0,
        meleeKills: 0,
        gunKills: 0,
        blastKills: 0,
        fistKills: 0,
        takedownKills: 0,
        vehicleKills: 0,
        // Survival
        daysSurvived: 0,
        affliction: 0,
        // Vitals (snapshot)
        health: 0,
        hunger: 0,
        thirst: 0,
        stamina: 0,
        infection: 0,
        battery: 0,
        // Character
        male: true,
        startingPerk: 'Unknown',
        // Float data
        fatigue: 0,
        infectionBuildup: 0,
        // Recipes
        craftingRecipes: [],
        buildingRecipes: [],
        // Inventory
        inventory: [],
        equipment: [],
        quickSlots: [],
        // States
        playerStates: [],
        bodyConditions: [],
        // Lore
        lore: [],
        // Professions
        unlockedProfessions: [],
        // Skills
        unlockedSkills: [],
        // Unique items
        uniqueLoots: [],
        craftedUniques: [],
        // Lifetime stats (from Statistics — persist across deaths)
        lifetimeKills: 0,
        lifetimeHeadshots: 0,
        lifetimeMeleeKills: 0,
        lifetimeGunKills: 0,
        lifetimeBlastKills: 0,
        lifetimeFistKills: 0,
        lifetimeTakedownKills: 0,
        lifetimeVehicleKills: 0,
        lifetimeDaysSurvived: 0,
        // Challenge progress (from Statistics)
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
        // Activity (from Statistics)
        timesBitten: 0,
        fishCaught: 0,
        fishCaughtPike: 0,
        hasExtendedStats: false,
      });
    }
    return players.get(id);
  }

  function prescanSteamId(props) {
    for (const prop of props) {
      if (prop && prop.name === 'SteamID' && typeof prop.value === 'string') {
        const match = prop.value.match(/(7656\d+)/);
        if (match) { currentSteamID = match[1]; return; }
      }
    }
  }

  function handleProp(prop) {
    if (!prop) return;
    const n = prop.name;

    // SteamID marks a new player context
    if (n === 'SteamID' && typeof prop.value === 'string') {
      const match = prop.value.match(/(7656\d+)/);
      if (match) currentSteamID = match[1];
    }

    // Always process children/nested arrays (they may contain SteamIDs)
    if (prop.children) {
      prescanSteamId(prop.children);
      for (const child of prop.children) handleProp(child);
    }
    if (Array.isArray(prop.value) && prop.value.length > 0 && Array.isArray(prop.value[0])) {
      // ── Statistics: pair-wise extraction of TagName + CurrentValue ──
      if (n === 'Statistics' && currentSteamID) {
        const p = ensurePlayer(currentSteamID);
        for (const elemProps of prop.value) {
          if (!Array.isArray(elemProps)) continue;
          let tagName = null;
          let currentValue = null;
          for (const ep of elemProps) {
            if (ep.name === 'StatisticId' && ep.children) {
              for (const c of ep.children) {
                if (c.name === 'TagName' && typeof c.value === 'string') tagName = c.value;
              }
            }
            // Also check: StatisticId might be a GameplayTag with value = tag string directly
            if (ep.name === 'StatisticId' && typeof ep.value === 'string' && ep.value.startsWith('statistics.')) {
              tagName = ep.value;
            }
            if (ep.name === 'CurrentValue' && typeof ep.value === 'number') {
              currentValue = ep.value;
            }
          }
          if (tagName && currentValue !== null && currentValue > 0) {
            const field = EXTENDED_STAT_MAP[tagName];
            if (field) {
              p[field] = Math.round(currentValue);
              p.hasExtendedStats = true;
            }
          }
        }
      }
      for (const elemProps of prop.value) {
        prescanSteamId(elemProps);
        for (const ep of elemProps) handleProp(ep);
      }
    }

    if (!currentSteamID) return;
    const p = ensurePlayer(currentSteamID);

    // Simple values
    if (n === 'DayzSurvived' && typeof prop.value === 'number') p.daysSurvived = prop.value;
    if (n === 'Affliction' && typeof prop.value === 'number') p.affliction = prop.value;
    if (n === 'Male') p.male = !!prop.value;
    if (n === 'CurrentHealth' && typeof prop.value === 'number') p.health = Math.round(prop.value * 10) / 10;
    if (n === 'CurrentHunger' && typeof prop.value === 'number') p.hunger = Math.round(prop.value * 10) / 10;
    if (n === 'CurrentThirst' && typeof prop.value === 'number') p.thirst = Math.round(prop.value * 10) / 10;
    if (n === 'CurrentStamina' && typeof prop.value === 'number') p.stamina = Math.round(prop.value * 10) / 10;
    if (n === 'CurrentInfection' && typeof prop.value === 'number') p.infection = Math.round(prop.value * 10) / 10;
    if (n === 'PlayerBattery' && typeof prop.value === 'number') p.battery = Math.round(prop.value * 10) / 10;

    // Perk — may be EnumProperty (string value) or ByteProperty (numeric index)
    if (n === 'StartingPerk') {
      let mapped = null;
      if (typeof prop.value === 'string') {
        mapped = PERK_MAP[prop.value];
      } else if (typeof prop.value === 'number') {
        mapped = PERK_INDEX_MAP[prop.value];
      }
      if (mapped) {
        p.startingPerk = mapped;
      } else if (prop.value !== 'None' && prop.value !== null && prop.value !== undefined) {
        // Log truly unexpected/unmapped values
        console.log(`[SAVE PARSER] Unknown StartingPerk for ${currentSteamID}: type=${typeof prop.value} value=${JSON.stringify(prop.value)} enumType=${prop.enumType}`);
      }
    }

    // GameStats map (kills!)
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

    // FloatData map
    if (n === 'FloatData' && prop.value && typeof prop.value === 'object') {
      if (prop.value.Fatigue !== undefined) p.fatigue = Math.round(prop.value.Fatigue * 100) / 100;
      if (prop.value.InfectionBuildup !== undefined) p.infectionBuildup = Math.round(prop.value.InfectionBuildup);
    }

    // Recipe arrays
    if (n === 'Recipe_Crafting' && Array.isArray(prop.value)) p.craftingRecipes = prop.value.filter(Boolean);
    if (n === 'Recipe_Building' && Array.isArray(prop.value)) p.buildingRecipes = prop.value.filter(Boolean);

    // Player states
    if (n === 'PlayerStates' && Array.isArray(prop.value)) p.playerStates = prop.value;
    if (n === 'BodyCondition' && Array.isArray(prop.value)) p.bodyConditions = prop.value;

    // Professions
    if (n === 'UnlockedProfessionArr' && Array.isArray(prop.value)) p.unlockedProfessions = prop.value;

    // Skills (may appear as UnlockedSkills or UnlockedSkills_18)
    if ((n === 'UnlockedSkills' || n.startsWith('UnlockedSkills_')) && Array.isArray(prop.value)) {
      p.unlockedSkills = prop.value.filter(Boolean);
    }

    // Unique items
    if ((n === 'UniqueLoots' || n.startsWith('UniqueLoots_')) && Array.isArray(prop.value)) {
      p.uniqueLoots = prop.value.filter(Boolean);
    }
    if ((n === 'CraftedUniques' || n.startsWith('CraftedUniques_')) && Array.isArray(prop.value)) {
      p.craftedUniques = prop.value.filter(Boolean);
    }

    // Lore
    if (n === 'LoreId' && typeof prop.value === 'string') p.lore.push(prop.value);

    // Inventory / Equipment / Quick Slots
    if (n === 'PlayerInventory' && Array.isArray(prop.value)) p.inventory = prop.value;
    if (n === 'PlayerEquipment' && Array.isArray(prop.value)) p.equipment = prop.value;
    if (n === 'PlayerQuickSlots' && Array.isArray(prop.value)) p.quickSlots = prop.value;

  }

  // Read all properties sequentially
  while (r.remaining() > 4) {
    try {
      const saved = r.getOffset();
      const prop = readProperty(r);
      if (prop === null) {
        if (r.getOffset() === saved) {
          // Stuck — scan forward for next property
          let found = false;
          for (let scan = saved + 1; scan < Math.min(saved + 50000, r.length - 10); scan++) {
            const len = buf.readInt32LE(scan);
            if (len > 3 && len < 80) {
              const peek = buf.toString('utf8', scan + 4, scan + 4 + len - 1);
              if (/^[A-Z][a-zA-Z0-9_]{2,60}$/.test(peek)) {
                r.setOffset(scan);
                found = true;
                break;
              }
            }
          }
          if (!found) break;
        }
        continue;
      }
      handleProp(prop);
    } catch (err) {
      // Corrupt or unexpected property — log and continue with partial data
      console.error(`[SAVE PARSER] Error at offset ${r.getOffset()}: ${err.message}`);
      // Try to skip past the bad data
      const pos = r.getOffset();
      let recovered = false;
      for (let scan = pos + 1; scan < Math.min(pos + 50000, r.length - 10); scan++) {
        const len = buf.readInt32LE(scan);
        if (len > 3 && len < 80) {
          const peek = buf.toString('utf8', scan + 4, scan + 4 + len - 1);
          if (/^[A-Z][a-zA-Z0-9_]{2,60}$/.test(peek)) {
            r.setOffset(scan);
            recovered = true;
            break;
          }
        }
      }
      if (!recovered) break;
    }
  }

  return players;
}

/* ── Clan rank enum to readable name ── */
const CLAN_RANK_MAP = {
  'E_ClanRank::NewEnumerator0': 'Recruit',
  'E_ClanRank::NewEnumerator1': 'Member',
  'E_ClanRank::NewEnumerator2': 'Officer',
  'E_ClanRank::NewEnumerator3': 'Co-Leader',
  'E_ClanRank::NewEnumerator4': 'Leader',
};

function parseClanData(buf) {
  const r = createReader(buf);
  parseHeader(r);

  const clans = [];

  // Read all top-level properties — we're looking for the "ClanInfo" array
  while (r.remaining() > 4) {
    const saved = r.getOffset();
    const prop = readProperty(r);
    if (prop === null) {
      if (r.getOffset() === saved) break;
      continue;
    }

    if (prop.name === 'ClanInfo' && prop.type === 'ArrayProperty') {
      // ClanInfo is a StructProperty array of S_ClanInfo
      // Each element is an array of props: ClanName + Members (nested struct array)
      if (!Array.isArray(prop.value)) continue;

      for (const clanProps of prop.value) {
        if (!Array.isArray(clanProps)) continue;
        const clan = { name: '', members: [] };

        for (const cp of clanProps) {
          if (cp.name?.startsWith('ClanName') && typeof cp.value === 'string') {
            clan.name = cp.value;
          }
          if (cp.name?.startsWith('Members') && cp.type === 'ArrayProperty') {
            // Members is a struct array of S_ClanMember
            if (Array.isArray(cp.value)) {
              for (const memberProps of cp.value) {
                if (!Array.isArray(memberProps)) continue;
                const member = { name: '', steamId: '', rank: 'Member', canInvite: false, canKick: false };
                for (const mp of memberProps) {
                  if (mp.name?.startsWith('Name') && typeof mp.value === 'string') {
                    member.name = mp.value;
                  }
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

module.exports = { parseSave, parseClanData, PERK_MAP, CLAN_RANK_MAP };

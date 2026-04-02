/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-require-imports, @typescript-eslint/no-floating-promises, @typescript-eslint/restrict-template-expressions, @typescript-eslint/no-unnecessary-type-assertion */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';

// ─── New parser modules ─────────────────────────────────────────────────────

const { createReader, parseHeader, readProperty, cleanName, recoverForward } = require('../src/parsers/gvas-reader');

const {
  parseSave,
  parseClanData,
  PERK_MAP,
  PERK_INDEX_MAP,
  CLAN_RANK_MAP,
  SEASON_MAP,
  STAT_TAG_MAP,
  createPlayerData,
  simplifyBlueprint,
} = require('../src/parsers/save-parser');

const HumanitZDB = require('../src/db/database');

// ─── Test data paths ────────────────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, '..', 'data');
const SAV_FILES = [
  'Save_DedicatedSaveMP.sav',
  'Save_DedicatedSaveMP_FRESH.sav',
  'Save_DedicatedSaveMP_FRESH2.sav',
  'Save_DedicatedSaveMP_LIVE.sav',
  'Save_DedicatedSaveMP_NE.sav',
  'Save_DedicatedSaveMP_NEW.sav',
  'Save_DedicatedSaveMP_CAL.sav',
].filter((f: string) => fs.existsSync(path.join(DATA_DIR, f)));

// ─── Helpers ────────────────────────────────────────────────────────────────

function writeFString(str: string): Buffer {
  if (str === '') {
    const b = Buffer.alloc(4);
    b.writeInt32LE(0);
    return b;
  }
  const encoded = Buffer.from(str + '\0', 'utf8');
  const buf = Buffer.alloc(4);
  buf.writeInt32LE(encoded.length);
  return Buffer.concat([buf, encoded]);
}

function writeU8(val: number): Buffer {
  const b = Buffer.alloc(1);
  b[0] = val;
  return b;
}
function writeI32(val: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeInt32LE(val);
  return b;
}
function writeI64(val: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(BigInt(val));
  return b;
}
function writeF32(val: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeFloatLE(val);
  return b;
}

function buildGvasHeader(): Buffer {
  const parts: Buffer[] = [];
  parts.push(Buffer.from('GVAS'));
  parts.push(Buffer.alloc(8, 0)); // save + package version
  parts.push(Buffer.alloc(6, 0)); // engine version
  parts.push(Buffer.alloc(4, 0)); // build
  const str1 = writeFString('');
  parts.push(str1);
  parts.push(Buffer.alloc(8, 0)); // custom version format + count
  parts.push(str1); // save class
  return Buffer.concat(parts);
}

function buildStrProperty(name: string, value: string): Buffer {
  const valBuf = writeFString(value);
  return Buffer.concat([writeFString(name), writeFString('StrProperty'), writeI64(valBuf.length), writeU8(0), valBuf]);
}

function buildIntProperty(name: string, value: number): Buffer {
  return Buffer.concat([writeFString(name), writeFString('IntProperty'), writeI64(4), writeU8(0), writeI32(value)]);
}

function buildFloatProperty(name: string, value: number): Buffer {
  return Buffer.concat([writeFString(name), writeFString('FloatProperty'), writeI64(4), writeU8(0), writeF32(value)]);
}

function buildBoolProperty(name: string, value: boolean): Buffer {
  return Buffer.concat([
    writeFString(name),
    writeFString('BoolProperty'),
    writeI64(0),
    writeU8(value ? 1 : 0),
    writeU8(0),
  ]);
}

function buildStructProperty(name: string, structType: string, contentParts: Buffer[]): Buffer {
  const content = Buffer.concat(contentParts);
  return Buffer.concat([
    writeFString(name),
    writeFString('StructProperty'),
    writeI64(content.length),
    writeFString(structType),
    Buffer.alloc(16),
    writeU8(0),
    content,
  ]);
}

function buildVectorStruct(name: string, x: number, y: number, z: number): Buffer {
  return buildStructProperty(name, 'Vector', [writeF32(x), writeF32(y), writeF32(z)]);
}

function buildQuatStruct(name: string, x: number, y: number, z: number, w: number): Buffer {
  return buildStructProperty(name, 'Quat', [writeF32(x), writeF32(y), writeF32(z), writeF32(w)]);
}

function buildTransformStruct(
  name: string,
  tx: number,
  ty: number,
  tz: number,
  qx: number,
  qy: number,
  qz: number,
  qw: number,
): Buffer {
  return buildStructProperty(name, 'Transform', [
    buildVectorStruct('Translation', tx, ty, tz),
    buildQuatStruct('Rotation', qx, qy, qz, qw),
    writeFString('None'),
  ]);
}

// ═══════════════════════════════════════════════════════════════════════════
//  GVAS Reader tests
// ═══════════════════════════════════════════════════════════════════════════

describe('gvas-reader', () => {
  describe('createReader', () => {
    it('reads basic types correctly', () => {
      const buf = Buffer.alloc(32);
      buf.writeUInt8(0xff, 0);
      buf.writeUInt16LE(1234, 1);
      buf.writeUInt32LE(99999, 3);
      buf.writeInt32LE(-42, 7);
      buf.writeFloatLE(3.14, 11);

      const r = createReader(buf);
      assert.equal(r.readU8(), 0xff);
      assert.equal(r.readU16(), 1234);
      assert.equal(r.readU32(), 99999);
      assert.equal(r.readI32(), -42);
      assert.ok(Math.abs(r.readF32() - 3.14) < 0.01);
    });

    it('reads FString correctly', () => {
      const str = 'TestString';
      const buf = writeFString(str);
      const r = createReader(buf);
      assert.equal(r.readFString(), str);
    });

    it('handles empty FString', () => {
      const buf = writeFString('');
      const r = createReader(buf);
      assert.equal(r.readFString(), '');
    });

    it('tracks remaining bytes', () => {
      const buf = Buffer.alloc(10);
      const r = createReader(buf);
      assert.equal(r.remaining(), 10);
      r.skip(5);
      assert.equal(r.remaining(), 5);
    });
  });

  describe('parseHeader', () => {
    it('parses a valid GVAS header', () => {
      const buf = buildGvasHeader();
      const r = createReader(buf);
      const h = parseHeader(r);
      assert.equal(h.magic, 'GVAS');
    });

    it('throws on non-GVAS data', () => {
      const r = createReader(Buffer.from('NOPE'));
      assert.throws(() => parseHeader(r), /Not a GVAS/);
    });
  });

  describe('readProperty', () => {
    it('reads a StrProperty', () => {
      const buf = buildStrProperty('TestName', 'TestValue');
      const r = createReader(buf);
      const prop = readProperty(r);
      assert.equal(prop.name, 'TestName');
      assert.equal(prop.type, 'StrProperty');
      assert.equal(prop.value, 'TestValue');
    });

    it('reads an IntProperty', () => {
      const buf = buildIntProperty('Score', 42);
      const r = createReader(buf);
      const prop = readProperty(r);
      assert.equal(prop.name, 'Score');
      assert.equal(prop.type, 'IntProperty');
      assert.equal(prop.value, 42);
    });

    it('reads a FloatProperty', () => {
      const buf = buildFloatProperty('Health', 87.5);
      const r = createReader(buf);
      const prop = readProperty(r);
      assert.equal(prop.name, 'Health');
      assert.equal(prop.value, Math.fround(87.5));
    });

    it('reads a BoolProperty', () => {
      const buf = buildBoolProperty('Male', true);
      const r = createReader(buf);
      const prop = readProperty(r);
      assert.equal(prop.name, 'Male');
      assert.equal(prop.value, true);
    });

    it('reads a Transform struct', () => {
      const buf = buildTransformStruct('PlayerTransform', 100.5, -200.25, 50.0, 0, 0, 0.7071, 0.7071);
      const r = createReader(buf);
      const prop = readProperty(r);
      assert.equal(prop.structType, 'Transform');
      assert.ok(Math.abs(prop.value.translation.x - 100.5) < 0.01);
      assert.ok(Math.abs(prop.value.rotation.w - 0.7071) < 0.01);
    });

    it('returns null at end of stream', () => {
      const r = createReader(Buffer.alloc(2));
      assert.equal(readProperty(r), null);
    });

    it('returns null for None terminator', () => {
      const buf = writeFString('None');
      const r = createReader(buf);
      assert.equal(readProperty(r), null);
    });
  });

  describe('cleanName', () => {
    it('strips GUID suffixes', () => {
      assert.equal(cleanName('Recipe_Crafting_0_ABCDEF0123456789ABCDEF0123456789'), 'Recipe_Crafting');
    });

    it('preserves names without GUID suffix', () => {
      assert.equal(cleanName('SteamID'), 'SteamID');
    });
  });

  describe('recoverForward', () => {
    it('finds the next property-like structure', () => {
      // Build buf with garbage then a valid property
      const garbage = Buffer.alloc(50, 0xff);
      const validProp = buildIntProperty('Score', 10);
      const buf = Buffer.concat([garbage, validProp]);
      const r = createReader(buf);
      assert.ok(recoverForward(r, 0, 200));
    });

    it('returns false when no valid property found', () => {
      const buf = Buffer.alloc(100, 0xff);
      const r = createReader(buf);
      assert.equal(recoverForward(r, 0, 100), false);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  Save Parser tests
// ═══════════════════════════════════════════════════════════════════════════

describe('save-parser', () => {
  describe('constants', () => {
    it('PERK_MAP has 12 entries', () => {
      assert.equal(Object.keys(PERK_MAP).length, 12);
    });

    it('PERK_INDEX_MAP has 12 entries', () => {
      assert.equal(Object.keys(PERK_INDEX_MAP).length, 12);
    });

    it('CLAN_RANK_MAP has 5 ranks', () => {
      assert.equal(Object.keys(CLAN_RANK_MAP).length, 5);
    });

    it('SEASON_MAP has 4 seasons', () => {
      assert.equal(Object.keys(SEASON_MAP).length, 4);
    });

    it('STAT_TAG_MAP maps known tags', () => {
      assert.equal(STAT_TAG_MAP['statistics.stat.game.kills.total'], 'lifetimeKills');
      assert.equal(STAT_TAG_MAP['statistics.stat.game.bitten'], 'timesBitten');
    });
  });

  describe('createPlayerData', () => {
    it('returns a fresh player with all default fields', () => {
      const p = createPlayerData();
      assert.equal(p.male, true);
      assert.equal(p.startingPerk, 'Unknown');
      assert.equal(p.zeeksKilled, 0);
      assert.equal(p.health, 0);
      assert.equal(p.x, null);
      assert.deepEqual(p.inventory, []);
      assert.deepEqual(p.craftingRecipes, []);
      assert.equal(p.dayIncremented, false);
    });
  });

  describe('simplifyBlueprint', () => {
    it('extracts name from full blueprint path', () => {
      assert.equal(
        simplifyBlueprint('/Game/BuildingSystem/Blueprints/Buildings/BP_WoodWall.BP_WoodWall_C'),
        'WoodWall',
      );
    });

    it('handles simple BP_ names', () => {
      assert.equal(simplifyBlueprint('BP_SandbagWall_C'), 'SandbagWall');
    });

    it('handles null/undefined', () => {
      assert.equal(simplifyBlueprint(null), null);
      assert.equal(simplifyBlueprint(undefined), undefined);
    });
  });

  describe('parseSave — synthetic', () => {
    it('throws on non-GVAS data', () => {
      assert.throws(() => parseSave(Buffer.from('BAD')), /Not a GVAS/);
    });

    it('returns structure for empty GVAS', () => {
      const buf = Buffer.concat([buildGvasHeader(), writeFString('None')]);
      const result = parseSave(buf);
      assert.ok(result.players instanceof Map);
      assert.ok(typeof result.worldState === 'object');
      assert.ok(Array.isArray(result.structures));
      assert.ok(Array.isArray(result.vehicles));
    });

    it('extracts SteamID and basic player fields', () => {
      const buf = Buffer.concat([
        buildGvasHeader(),
        buildStrProperty('SteamID', '76561198000000001'),
        buildBoolProperty('Male', false),
        buildIntProperty('DayzSurvived', 7),
        buildFloatProperty('CurrentHealth', 85.5),
        buildFloatProperty('CurrentHunger', 60.0),
        writeFString('None'),
      ]);
      const { players } = parseSave(buf);
      assert.equal(players.size, 1);
      const p = players.get('76561198000000001');
      assert.ok(p);
      assert.equal(p.male, false);
      assert.equal(p.daysSurvived, 7);
      assert.ok(Math.abs(p.health - 85.5) < 0.5);
      assert.ok(Math.abs(p.hunger - 60.0) < 0.5);
    });

    it('extracts position from PlayerTransform', () => {
      const buf = Buffer.concat([
        buildGvasHeader(),
        buildStrProperty('SteamID', '76561198000000001'),
        buildTransformStruct('PlayerTransform', 37377.63, -292189, 5014, 0, 0, -0.5, 0.866),
        writeFString('None'),
      ]);
      const { players } = parseSave(buf);
      const p = players.get('76561198000000001');
      assert.ok(Math.abs(p.x - 37377.63) < 1);
      assert.ok(Math.abs(p.y - -292189) < 1);
      assert.ok(typeof p.rotationYaw === 'number');
    });

    it('handles multiple players', () => {
      const buf = Buffer.concat([
        buildGvasHeader(),
        buildStrProperty('SteamID', '76561198000000001'),
        buildIntProperty('DayzSurvived', 3),
        buildStrProperty('SteamID', '76561198000000002'),
        buildIntProperty('DayzSurvived', 5),
        writeFString('None'),
      ]);
      const { players } = parseSave(buf);
      assert.equal(players.size, 2);
      assert.equal(players.get('76561198000000001').daysSurvived, 3);
      assert.equal(players.get('76561198000000002').daysSurvived, 5);
    });

    it('extracts world state scalars', () => {
      const buf = Buffer.concat([
        buildGvasHeader(),
        buildIntProperty('Dedi_DaysPassed', 42),
        buildIntProperty('CurrentSeasonDay', 5),
        writeFString('None'),
      ]);
      const { worldState } = parseSave(buf);
      assert.equal(worldState.daysPassed, 42);
      assert.equal(worldState.currentSeasonDay, 5);
    });
  });

  describe('parseClanData — synthetic', () => {
    it('returns empty array for empty GVAS', () => {
      const buf = Buffer.concat([buildGvasHeader(), writeFString('None')]);
      assert.deepEqual(parseClanData(buf), []);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  Real save file tests (data/*.sav)
// ═══════════════════════════════════════════════════════════════════════════

describe('parseSave — real .sav files', () => {
  for (const filename of SAV_FILES) {
    describe(filename, () => {
      let result: any;

      before(() => {
        const buf = fs.readFileSync(path.join(DATA_DIR, filename));
        result = parseSave(buf);
      });

      it('returns expected structure', () => {
        assert.ok(result.players instanceof Map);
        assert.ok(typeof result.worldState === 'object');
        assert.ok(Array.isArray(result.structures));
        assert.ok(Array.isArray(result.vehicles));
        assert.ok(Array.isArray(result.companions));
        assert.ok(Array.isArray(result.deadBodies));
        assert.ok(Array.isArray(result.containers));
        assert.ok(result.header);
        assert.equal(result.header.magic, 'GVAS');
      });

      it('extracts at least one player', () => {
        assert.ok(result.players.size >= 1, `Expected players, got ${result.players.size}`);
      });

      it('all player SteamIDs are valid format', () => {
        for (const steamId of result.players.keys()) {
          assert.ok(/^7656\d{13,}$/.test(steamId as string), `Invalid SteamID: ${steamId}`);
        }
      });

      it('player data has expected fields', () => {
        const [_steamId, p] = result.players.entries().next().value as [any, any];
        assert.ok('male' in p);
        assert.ok('startingPerk' in p);
        assert.ok('health' in p);
        assert.ok('inventory' in p);
        assert.ok('craftingRecipes' in p);
        assert.ok('x' in p);
      });

      it('players have reasonable vital values', () => {
        for (const [, p] of result.players) {
          if ((p as any).health > 0) {
            assert.ok((p as any).health <= 200, `Health ${(p as any).health} too high for ${(p as any).startingPerk}`);
          }
        }
      });

      it('structures is an array with valid entries', () => {
        if (result.structures.length > 0) {
          const s = result.structures[0];
          assert.ok('actorClass' in s);
          assert.ok('displayName' in s);
          assert.ok('currentHealth' in s);
          assert.ok('maxHealth' in s);
        }
      });

      it('worldState has expected keys', () => {
        assert.ok('totalPlayers' in result.worldState);
        assert.ok('totalStructures' in result.worldState);
      });
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  Database tests (in-memory)
// ═══════════════════════════════════════════════════════════════════════════

describe('HumanitZDB', () => {
  let db: any;

  before(() => {
    db = new HumanitZDB({ memory: true, label: 'Test' });
    db.init();
  });

  after(() => {
    db.close();
  });

  describe('init', () => {
    it('creates all tables', () => {
      const tables = db.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
      const names = tables.map((t: any) => t.name);
      assert.ok(names.includes('players'));
      assert.ok(names.includes('clans'));
      assert.ok(names.includes('structures'));
      assert.ok(names.includes('vehicles'));
      assert.ok(names.includes('world_state'));
      assert.ok(names.includes('game_items'));
      assert.ok(names.includes('meta'));
    });

    it('sets schema version', () => {
      const version = db._getMeta('schema_version');
      assert.equal(version, '15');
    });

    it('creates player_aliases table', () => {
      const tables = db.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
      assert.ok(tables.map((t: any) => t.name).includes('player_aliases'));
    });
  });

  describe('upsertPlayer', () => {
    it('inserts a new player', () => {
      db.upsertPlayer('76561198000000001', {
        name: 'TestPlayer',
        male: true,
        startingPerk: 'Mechanic',
        health: 85.5,
        zeeksKilled: 42,
        inventory: [{ item: 'Axe', amount: 1, durability: 50 }],
      });

      const p = db.getPlayer('76561198000000001');
      assert.ok(p);
      assert.equal(p.name, 'TestPlayer');
      assert.equal(p.starting_perk, 'Mechanic');
      assert.ok(Math.abs(p.health - 85.5) < 0.1);
      assert.equal(p.zeeks_killed, 42);
      assert.ok(Array.isArray(p.inventory));
      assert.equal(p.inventory[0].item, 'Axe');
    });

    it('updates existing player', () => {
      db.upsertPlayer('76561198000000001', {
        name: 'TestPlayer',
        health: 50,
        zeeksKilled: 100,
      });
      const p = db.getPlayer('76561198000000001');
      assert.equal(p.zeeks_killed, 100);
      assert.ok(Math.abs(p.health - 50) < 0.1);
    });
  });

  describe('getAllPlayers', () => {
    it('returns all players', () => {
      db.upsertPlayer('76561198000000002', { name: 'Player2', lifetimeKills: 10 });
      const all = db.getAllPlayers();
      assert.ok(all.length >= 2);
    });
  });

  describe('leaderboards', () => {
    before(() => {
      db.upsertPlayer('76561198000000003', { name: 'Killer', lifetimeKills: 500, fishCaught: 20 });
      db.upsertPlayer('76561198000000004', { name: 'Fisher', lifetimeKills: 5, fishCaught: 200 });
    });

    it('topKillers returns sorted by kills', () => {
      const top = db.topKillers(5);
      assert.ok(top.length >= 2);
      assert.ok(top[0].lifetime_kills >= top[1].lifetime_kills);
    });

    it('topFish returns sorted by fish caught', () => {
      const top = db.topFish(5);
      assert.ok(top.length >= 1);
      assert.equal(top[0].name, 'Fisher');
    });
  });

  describe('world state', () => {
    it('stores and retrieves world state', () => {
      db.setWorldState('daysPassed', '42');
      assert.equal(db.getWorldState('daysPassed'), '42');
    });

    it('getAllWorldState returns all keys', () => {
      db.setWorldState('currentSeason', 'Summer');
      const ws = db.getAllWorldState();
      assert.equal(ws.daysPassed, '42');
      assert.equal(ws.currentSeason, 'Summer');
    });
  });

  describe('structures', () => {
    it('replaces all structures', () => {
      db.replaceStructures([
        {
          actorClass: 'BP_WoodWall',
          displayName: 'WoodWall',
          ownerSteamId: '76561198000000001',
          currentHealth: 100,
          maxHealth: 100,
        },
        {
          actorClass: 'BP_StoneWall',
          displayName: 'StoneWall',
          ownerSteamId: '76561198000000002',
          currentHealth: 200,
          maxHealth: 200,
        },
      ]);
      const all = db.getStructures();
      assert.equal(all.length, 2);
    });

    it('getStructuresByOwner returns filtered', () => {
      const owned = db.getStructuresByOwner('76561198000000001');
      assert.equal(owned.length, 1);
      assert.equal(owned[0].display_name, 'WoodWall');
    });

    it('getStructureCounts returns owner counts', () => {
      const counts = db.getStructureCounts();
      assert.ok(counts.length >= 1);
      assert.ok(counts[0].count >= 1);
    });
  });

  describe('vehicles', () => {
    it('replaces all vehicles', () => {
      db.replaceVehicles([{ class: 'BP_Sedan', displayName: 'Sedan', health: 500, maxHealth: 1000, fuel: 50 }]);
      const all = db.getAllVehicles();
      assert.equal(all.length, 1);
      assert.equal(all[0].display_name, 'Sedan');
    });
  });

  describe('clans', () => {
    it('upserts a clan with members', () => {
      db.upsertClan('TestClan', [
        { steamId: '76561198000000001', name: 'Player1', rank: 'Leader', canInvite: true, canKick: true },
        { steamId: '76561198000000002', name: 'Player2', rank: 'Member', canInvite: false, canKick: false },
      ]);
      const clans = db.getAllClans();
      assert.ok(clans.length >= 1);
      const tc = clans.find((c: any) => c.name === 'TestClan');
      assert.ok(tc);
      assert.equal(tc.members.length, 2);
    });
  });

  describe('syncFromSave', () => {
    it('syncs a full parsed result', () => {
      const players = new Map();
      players.set('76561198000000010', {
        name: 'SyncPlayer',
        male: true,
        health: 90,
        zeeksKilled: 50,
        lifetimeKills: 200,
      });

      db.syncFromSave({
        players,
        worldState: { daysPassed: 100, currentSeason: 'Winter' },
        structures: [
          {
            actorClass: 'BP_Fence',
            displayName: 'Fence',
            ownerSteamId: '76561198000000010',
            currentHealth: 50,
            maxHealth: 100,
          },
        ],
        vehicles: [{ class: 'BP_Truck', displayName: 'Truck', health: 800, maxHealth: 1200, fuel: 75 }],
        companions: [{ type: 'dog', actorName: 'Dog_1', ownerSteamId: '76561198000000010', health: 100 }],
        clans: [
          {
            name: 'SyncClan',
            members: [
              { steamId: '76561198000000010', name: 'SyncPlayer', rank: 'Leader', canInvite: true, canKick: true },
            ],
          },
        ],
      });

      // Verify everything was synced
      const p = db.getPlayer('76561198000000010');
      assert.equal(p.name, 'SyncPlayer');
      assert.equal(p.lifetime_kills, 200);

      assert.equal(db.getWorldState('daysPassed'), '100');
      assert.equal(db.getWorldState('currentSeason'), 'Winter');

      const structs = db.getStructures();
      assert.equal(structs.length, 1);
      assert.equal(structs[0].display_name, 'Fence');
    });
  });

  describe('snapshots', () => {
    it('creates and retrieves snapshots', () => {
      db.createSnapshot('weekly', '76561198000000001', { kills: 42, deaths: 3 });
      const snap = db.getLatestSnapshot('weekly', '76561198000000001');
      assert.ok(snap);
      assert.equal(snap.data.kills, 42);
    });
  });

  describe('game reference seeding', () => {
    it('seeds game items', () => {
      db.seedGameItems([
        { id: 'Axe', name: 'Fire Axe', description: 'A fire axe', category: 'melee', stackSize: 1 },
        { id: 'Bandage', name: 'Bandage', description: 'Heals wounds', category: 'medical', stackSize: 5 },
      ]);
      const item = db.getGameItem('Axe');
      assert.ok(item);
      assert.equal(item.name, 'Fire Axe');
    });

    it('searches game items', () => {
      const results = db.searchGameItems('axe');
      assert.ok(results.length >= 1);
      assert.equal(results[0].id, 'Axe');
    });

    it('seeds professions', () => {
      db.seedGameProfessions([
        {
          id: 'Mechanic',
          enumValue: 'Enum_Professions::NewEnumerator3',
          enumIndex: 3,
          perk: '50% more effective with Repair Kits',
          skills: ['METAL WORKING', 'CALLUSED'],
        },
      ]);
    });

    it('seeds loading tips and gets random tip', () => {
      db.seedLoadingTips([
        { text: 'Tip 1', category: 'general' },
        { text: 'Tip 2', category: 'combat' },
      ]);
      const tip = db.getRandomTip();
      assert.ok(tip);
      assert.ok(tip.text);
    });
  });

  describe('server totals', () => {
    it('returns aggregate stats', () => {
      const totals = db.getServerTotals();
      assert.ok(totals.total_players > 0);
      assert.ok(typeof totals.total_kills === 'number');
    });
  });

  // ── Player identity / alias resolution ──

  describe('registerAlias', () => {
    it('registers a name↔steamId association', () => {
      db.registerAlias('76561198000000099', 'AliasTestPlayer', 'idmap');
      const result = db.resolveNameToSteamId('AliasTestPlayer');
      assert.ok(result);
      assert.equal(result.steamId, '76561198000000099');
      assert.equal(result.name, 'AliasTestPlayer');
      assert.equal(result.source, 'idmap');
    });

    it('is case-insensitive', () => {
      const result = db.resolveNameToSteamId('aliastestplayer');
      assert.ok(result);
      assert.equal(result.steamId, '76561198000000099');
    });

    it('rejects invalid steamIds', () => {
      db.registerAlias('name:BadKey', 'Ghost', 'log');
      const result = db.resolveNameToSteamId('Ghost');
      assert.equal(result, null);
    });

    it('rejects empty names', () => {
      db.registerAlias('76561198000000099', '', 'log');
      // Should not create a blank alias
      const aliases = db.getPlayerAliases('76561198000000099');
      assert.ok(!aliases.some((a: any) => a.name === ''));
    });
  });

  describe('resolveNameToSteamId', () => {
    it('resolves exact match', () => {
      db.registerAlias('76561198000000050', 'ExactMatch', 'connect_log');
      const r = db.resolveNameToSteamId('ExactMatch');
      assert.equal(r.steamId, '76561198000000050');
    });

    it('returns null for unknown name', () => {
      assert.equal(db.resolveNameToSteamId('TotallyUnknown'), null);
    });

    it('treats 17-digit numbers as direct SteamIDs', () => {
      const r = db.resolveNameToSteamId('76561198000000001');
      assert.equal(r.steamId, '76561198000000001');
      assert.equal(r.source, 'direct');
    });
  });

  describe('resolveSteamIdToName', () => {
    it('returns best current name', () => {
      db.registerAlias('76561198000000051', 'OldName', 'log');
      db.registerAlias('76561198000000051', 'CurrentName', 'idmap');
      const name = db.resolveSteamIdToName('76561198000000051');
      assert.equal(name, 'CurrentName');
    });

    it('returns steamId when no aliases exist', () => {
      const name = db.resolveSteamIdToName('76561198999999999');
      assert.equal(name, '76561198999999999');
    });

    it('prefers higher-priority sources', () => {
      db.registerAlias('76561198000000052', 'LogName', 'log');
      db.registerAlias('76561198000000052', 'IdmapName', 'idmap');
      db.registerAlias('76561198000000052', 'ConnLogName', 'connect_log');
      const name = db.resolveSteamIdToName('76561198000000052');
      assert.equal(name, 'IdmapName');
    });
  });

  describe('getPlayerAliases', () => {
    it('returns all names for a player', () => {
      db.registerAlias('76561198000000060', 'Name1', 'log');
      db.registerAlias('76561198000000060', 'Name2', 'connect_log');
      db.registerAlias('76561198000000060', 'Name3', 'idmap');
      const aliases = db.getPlayerAliases('76561198000000060');
      assert.ok(aliases.length >= 3);
      const names = aliases.map((a: any) => a.name);
      assert.ok(names.includes('Name1'));
      assert.ok(names.includes('Name2'));
      assert.ok(names.includes('Name3'));
    });
  });

  describe('importIdMap', () => {
    it('bulk imports id map entries', () => {
      db.importIdMap([
        { steamId: '76561198000000070', name: 'MapPlayer1' },
        { steamId: '76561198000000071', name: 'MapPlayer2' },
        { steamId: '76561198000000072', name: 'MapPlayer3' },
      ]);
      assert.equal(db.resolveNameToSteamId('MapPlayer1').steamId, '76561198000000070');
      assert.equal(db.resolveNameToSteamId('MapPlayer2').steamId, '76561198000000071');
      assert.equal(db.resolveNameToSteamId('MapPlayer3').steamId, '76561198000000072');
    });
  });

  describe('importConnectLog', () => {
    it('bulk imports connect log entries', () => {
      db.importConnectLog([
        { steamId: '76561198000000080', name: 'ConnPlayer1' },
        { steamId: '76561198000000081', name: 'ConnPlayer2' },
      ]);
      assert.equal(db.resolveNameToSteamId('ConnPlayer1').steamId, '76561198000000080');
      assert.equal(db.resolveSteamIdToName('76561198000000081'), 'ConnPlayer2');
    });
  });

  describe('searchPlayersByName', () => {
    it('finds players by partial name', () => {
      db.registerAlias('76561198000000090', 'SearchableJohn', 'idmap');
      const results = db.searchPlayersByName('searchable');
      assert.ok(results.length > 0);
      assert.equal(results[0].steamId, '76561198000000090');
    });

    it('returns empty for no match', () => {
      const results = db.searchPlayersByName('xyzzynonexistent');
      assert.equal(results.length, 0);
    });
  });

  describe('getAliasStats', () => {
    it('returns counts', () => {
      const stats = db.getAliasStats();
      assert.ok(stats.uniquePlayers > 0);
      assert.ok(stats.totalAliases > 0);
      assert.ok(stats.totalAliases >= stats.uniquePlayers);
    });
  });

  describe('upsertPlayer auto-registers alias', () => {
    it('creates alias on player upsert with name', () => {
      db.upsertPlayer('76561198000000095', {
        name: 'AutoAliasPlayer',
        male: true,
        health: 100,
      });
      const r = db.resolveNameToSteamId('AutoAliasPlayer');
      assert.ok(r);
      assert.equal(r.steamId, '76561198000000095');
    });
  });

  describe('name change tracking via aliases', () => {
    it('tracks old and new names for the same player', () => {
      db.registerAlias('76561198000000085', 'OriginalName', 'connect_log');
      db.registerAlias('76561198000000085', 'NewerName', 'connect_log');

      // Both names should resolve to the same SteamID
      assert.equal(db.resolveNameToSteamId('OriginalName').steamId, '76561198000000085');
      assert.equal(db.resolveNameToSteamId('NewerName').steamId, '76561198000000085');

      // Current name should be the newer one
      const name = db.resolveSteamIdToName('76561198000000085');
      assert.equal(name, 'NewerName');

      // Both should appear in aliases
      const aliases = db.getPlayerAliases('76561198000000085');
      const names = aliases.map((a: any) => a.name);
      assert.ok(names.includes('OriginalName'));
      assert.ok(names.includes('NewerName'));
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  Integration: parse real .sav → sync to DB
// ═══════════════════════════════════════════════════════════════════════════

describe('Integration: parse .sav → sync to DB', () => {
  if (SAV_FILES.length === 0) {
    it('skipped — no .sav files in data/', () => {
      assert.ok(true);
    });
  } else {
    let db: any;

    before(() => {
      db = new HumanitZDB({ memory: true, label: 'IntTest' });
      db.init();
    });

    after(() => {
      db.close();
    });

    it('parses and syncs a real save file', () => {
      const filename = SAV_FILES[0];
      if (!filename) return;
      const buf = fs.readFileSync(path.join(DATA_DIR, filename));
      const parsed = parseSave(buf);

      db.syncFromSave({
        players: parsed.players,
        worldState: parsed.worldState,
        structures: parsed.structures,
        vehicles: parsed.vehicles,
        companions: parsed.companions,
      });

      const allPlayers = db.getAllPlayers();
      assert.ok(allPlayers.length > 0, 'Should have players in DB after sync');

      const firstPlayer = allPlayers[0];
      assert.ok(firstPlayer.steam_id);
      assert.ok('health' in firstPlayer);
      assert.ok('inventory' in firstPlayer);
    });

    it('leaderboards work after sync', () => {
      const top = db.topKillers(10);
      assert.ok(Array.isArray(top));
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  Game reference seeding from curated data
// ═══════════════════════════════════════════════════════════════════════════

describe('game-reference seed', () => {
  let db: any;

  before(() => {
    db = new HumanitZDB({ memory: true, label: 'RefTest' });
    db.init();
  });

  after(() => {
    db.close();
  });

  it('seeds all reference data without errors', () => {
    const { seed } = require('../src/parsers/game-reference');
    assert.doesNotThrow(() => seed(db));
  });

  it('populates game_professions', () => {
    const rows = db.db.prepare('SELECT * FROM game_professions').all();
    assert.ok(rows.length >= 12, `Expected >= 12 professions, got ${rows.length}`);
  });

  it('populates game_afflictions', () => {
    const rows = db.db.prepare('SELECT * FROM game_afflictions').all();
    assert.ok(rows.length >= 18, `Expected >= 18 afflictions, got ${rows.length}`);
  });

  it('populates game_skills', () => {
    const rows = db.db.prepare('SELECT * FROM game_skills').all();
    assert.ok(rows.length >= 10, `Expected >= 10 skills, got ${rows.length}`);
  });

  it('populates game_challenges', () => {
    const rows = db.db.prepare('SELECT * FROM game_challenges').all();
    assert.ok(rows.length >= 10, `Expected >= 10 challenges, got ${rows.length}`);
  });

  it('populates game_loading_tips', () => {
    const rows = db.db.prepare('SELECT * FROM game_loading_tips').all();
    assert.ok(rows.length >= 20, `Expected >= 20 tips, got ${rows.length}`);
  });

  it('populates game_server_setting_defs', () => {
    const rows = db.db.prepare('SELECT * FROM game_server_setting_defs').all();
    assert.ok(rows.length >= 10, `Expected >= 10 settings, got ${rows.length}`);
  });
});

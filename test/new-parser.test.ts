import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';
import Database from 'better-sqlite3';

// ─── New parser modules ─────────────────────────────────────────────────────

import * as _gvas_reader from '../src/parsers/gvas-reader.js';
import * as _game_reference from '../src/parsers/game-reference.js';
const { createReader, parseHeader, readProperty, cleanName, recoverForward } = _gvas_reader as any;

import * as _save_parser from '../src/parsers/save-parser.js';
const saveParserInternals = _save_parser as any;
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
} = saveParserInternals;

import _database from '../src/db/database.js';
const HumanitZDB = _database as any;

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
      assert.throws(() => parseSave(Buffer.from('BADD')), /Not a GVAS/);
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
          if (p.health > 0) {
            assert.ok(p.health <= 200, `Health ${p.health} too high for ${p.startingPerk}`);
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
      assert.ok(names.includes('player_details'));
      assert.ok(names.includes('meta'));
    });

    it('sets schema version', () => {
      const version = db._getMeta('schema_version');
      assert.equal(version, '23');
    });

    it('creates player_aliases table', () => {
      const tables = db.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
      assert.ok(tables.map((t: any) => t.name).includes('player_aliases'));
    });

    it('repairs save snapshot schema when metadata says v21 but physical columns are missing', () => {
      const tmpDir = fs.mkdtempSync(path.join(DATA_DIR, 'tmp-schema-repair-'));
      const dbPath = path.join(tmpDir, 'humanitz.db');
      let repairDb: any = null;
      try {
        const seedDb = new HumanitZDB({ dbPath, label: 'RepairSeed' });
        seedDb.init();
        seedDb.close();

        const raw = new Database(dbPath);
        raw.exec(`
          DROP TABLE IF EXISTS player_details;
          ALTER TABLE players DROP COLUMN has_save_snapshot;
          ALTER TABLE players DROP COLUMN last_save_snapshot_at;
          UPDATE meta SET value = '21' WHERE key = 'schema_version';
        `);
        raw.close();

        repairDb = new HumanitZDB({ dbPath, label: 'Repair' });
        repairDb.init();

        const columns = repairDb.db
          .prepare('PRAGMA table_info(players)')
          .all()
          .map((row: any) => row.name);
        assert.ok(columns.includes('has_save_snapshot'));
        assert.ok(columns.includes('last_save_snapshot_at'));
        assert.ok(
          repairDb.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='player_details'").get(),
        );
      } finally {
        if (repairDb) repairDb.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe('upsertPlayer', () => {
    it('inserts a new player', () => {
      db.player.upsertPlayer('76561198000000001', {
        name: 'TestPlayer',
        male: true,
        startingPerk: 'Mechanic',
        health: 85.5,
        zeeksKilled: 42,
        inventory: [{ item: 'Axe', amount: 1, durability: 50 }],
      });

      const p = db.player.getPlayer('76561198000000001');
      assert.ok(p);
      assert.equal(p.name, 'TestPlayer');
      assert.equal(p.starting_perk, 'Mechanic');
      assert.ok(Math.abs(p.health - 85.5) < 0.1);
      assert.equal(p.zeeks_killed, 42);
      assert.ok(Array.isArray(p.inventory));
      assert.equal(p.inventory[0].item, 'Axe');
      assert.equal(p.has_save_snapshot, true);
      assert.ok(p.last_save_snapshot_at);

      const detail = db.player.getPlayerDetail('76561198000000001');
      assert.ok(detail);
      assert.equal(detail.has_save_snapshot, true);
      assert.ok(detail.last_save_snapshot_at);
      assert.equal(detail.source_file, null);
      assert.ok(detail.snapshot && typeof detail.snapshot === 'object');
      assert.equal((detail.snapshot as Record<string, unknown>).name, 'TestPlayer');
      assert.equal((detail.snapshot as Record<string, unknown>).health, 85.5);
    });

    it('updates existing player', () => {
      db.player.upsertPlayer('76561198000000001', {
        name: 'TestPlayer',
        health: 50,
        zeeksKilled: 100,
      });
      const p = db.player.getPlayer('76561198000000001');
      assert.equal(p.zeeks_killed, 100);
      assert.ok(Math.abs(p.health - 50) < 0.1);
    });

    it('stores full save snapshot metadata in player_details', () => {
      db.player.upsertPlayer('76561198000000005', {
        name: 'DetailedPlayer',
        health: 77,
        inventory: [{ item: 'Rifle', amount: 1 }],
        unmappedFullField: { nested: true },
        __saveSource: {
          sourceFile: '76561198000000005@abc.sav',
          sourceMtimeMs: 12345.5,
          sourceSize: 67890,
          cacheVersion: 3,
          agentVersion: 3,
          parserSignature: 'agent-v3',
        },
      });

      const p = db.player.getPlayer('76561198000000005');
      assert.equal(p.has_save_snapshot, true);
      assert.ok(p.last_save_snapshot_at);

      const detail = db.player.getPlayerDetail('76561198000000005');
      assert.ok(detail);
      assert.equal(detail.has_save_snapshot, true);
      assert.ok(detail.last_save_snapshot_at);
      assert.equal(detail.source_file, '76561198000000005@abc.sav');
      assert.equal(detail.source_mtime_ms, 12345.5);
      assert.equal(detail.source_size, 67890);
      assert.equal(detail.cache_version, 3);
      assert.equal(detail.agent_version, 3);
      assert.equal(detail.parser_signature, 'agent-v3');
      const snapshot = detail.snapshot as Record<string, unknown>;
      assert.equal(snapshot.name, 'DetailedPlayer');
      assert.deepEqual(snapshot.unmappedFullField, { nested: true });
      assert.equal(Object.prototype.hasOwnProperty.call(snapshot, '__saveSource'), false);
    });

    it('updates player_details as latest-state rows, not history rows', () => {
      const steamId = '76561198000000007';
      db.player.upsertPlayer(steamId, {
        name: 'LatestState',
        health: 70,
        __saveSource: {
          sourceFile: 'first.sav',
          sourceMtimeMs: 100,
          sourceSize: 10,
          cacheVersion: 3,
          agentVersion: 3,
          parserSignature: 'agent-v3',
        },
      });
      db.player.upsertPlayer(steamId, {
        name: 'LatestState',
        health: 88,
        extraLatestField: true,
        __saveSource: {
          sourceFile: 'second.sav',
          sourceMtimeMs: 200,
          sourceSize: 20,
          cacheVersion: 3,
          agentVersion: 3,
          parserSignature: 'agent-v3',
        },
      });

      const rows = db.rawQuery('SELECT * FROM player_details WHERE steam_id = ?', [steamId], { ctx: 'test' });
      assert.equal(rows.length, 1);
      const detail = db.player.getPlayerDetail(steamId);
      assert.ok(detail);
      assert.equal(detail.has_save_snapshot, true);
      assert.equal(detail.source_file, 'second.sav');
      assert.equal((detail.snapshot as Record<string, unknown>).health, 88);
      assert.equal((detail.snapshot as Record<string, unknown>).extraLatestField, true);
    });

    it('stores missing snapshot source numeric metadata as null, not zero', () => {
      db.player.upsertPlayer('76561198000000008', {
        name: 'NullableMeta',
        __saveSource: {
          sourceFile: 'nullable.sav',
          sourceMtimeMs: null,
          sourceSize: '',
          cacheVersion: null,
          agentVersion: '',
          parserSignature: 'agent-v3',
        },
      });

      const detail = db.player.getPlayerDetail('76561198000000008');
      assert.ok(detail);
      assert.equal(detail.source_mtime_ms, null);
      assert.equal(detail.source_size, null);
      assert.equal(detail.cache_version, null);
      assert.equal(detail.agent_version, null);
      assert.equal(detail.parser_signature, 'agent-v3');
    });

    it('log-only rows do not become save-backed', () => {
      db.player.upsertFullLogStats('76561198000000009', {
        name: 'LogOnly',
        deaths: 1,
        pvpKills: 0,
      });

      const p = db.player.getPlayer('76561198000000009');
      assert.ok(p);
      assert.equal(p.has_save_snapshot, false);
      assert.equal(p.last_save_snapshot_at, null);
      assert.equal(db.player.getPlayerDetail('76561198000000009'), null);
    });

    it('playtime-only rows do not become save-backed', () => {
      db.player.upsertFullPlaytime('76561198000000006', {
        name: 'PlaytimeOnly',
        totalMs: 120000,
        sessions: 1,
      });

      const p = db.player.getPlayer('76561198000000006');
      assert.ok(p);
      assert.equal(p.has_save_snapshot, false);
      assert.equal(p.last_save_snapshot_at, null);
      assert.equal(db.player.getPlayerDetail('76561198000000006'), null);
    });

    it('playtime updates do not clear an existing save-backed marker', () => {
      const steamId = '76561198000000008';
      db.player.upsertPlayer(steamId, { name: 'SaveBacked', health: 91 });
      db.player.upsertFullPlaytime(steamId, {
        name: 'SaveBacked',
        totalMs: 240000,
        sessions: 2,
      });

      const p = db.player.getPlayer(steamId);
      assert.ok(p);
      assert.equal(p.has_save_snapshot, true);
      assert.ok(p.last_save_snapshot_at);
      assert.equal(db.player.getPlayerDetail(steamId) !== null, true);
    });
  });

  describe('getAllPlayers', () => {
    it('returns all players', () => {
      db.player.upsertPlayer('76561198000000002', { name: 'Player2', lifetimeKills: 10 });
      const all = db.player.getAllPlayers();
      assert.ok(all.length >= 2);
    });
  });

  describe('leaderboards', () => {
    before(() => {
      db.player.upsertPlayer('76561198000000003', { name: 'Killer', lifetimeKills: 500, fishCaught: 20 });
      db.player.upsertPlayer('76561198000000004', { name: 'Fisher', lifetimeKills: 5, fishCaught: 200 });
    });

    it('topKillers returns sorted by kills', () => {
      const top = db.leaderboard.topKillers(5);
      assert.ok(top.length >= 2);
      assert.ok(top[0].lifetime_kills >= top[1].lifetime_kills);
    });

    it('topFish returns sorted by fish caught', () => {
      const top = db.leaderboard.topFish(5);
      assert.ok(top.length >= 1);
      assert.equal(top[0].name, 'Fisher');
    });
  });

  describe('world state', () => {
    it('stores and retrieves world state', () => {
      db.worldState.setWorldState('daysPassed', '42');
      assert.equal(db.worldState.getWorldState('daysPassed'), '42');
    });

    it('getAllWorldState returns all keys', () => {
      db.worldState.setWorldState('currentSeason', 'Summer');
      const ws = db.worldState.getAllWorldState();
      assert.equal(ws.daysPassed, '42');
      assert.equal(ws.currentSeason, 'Summer');
    });
  });

  describe('structures', () => {
    it('replaces all structures', () => {
      db.worldObject.replaceStructures([
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
      const all = db.worldObject.getStructures();
      assert.equal(all.length, 2);
    });

    it('getStructuresByOwner returns filtered', () => {
      const owned = db.worldObject.getStructuresByOwner('76561198000000001');
      assert.equal(owned.length, 1);
      assert.equal(owned[0].display_name, 'WoodWall');
    });

    it('getStructureCounts returns owner counts', () => {
      const counts = db.worldObject.getStructureCounts();
      assert.ok(counts.length >= 1);
      assert.ok(counts[0].count >= 1);
    });
  });

  describe('vehicles', () => {
    it('replaces all vehicles', () => {
      db.worldObject.replaceVehicles([
        { class: 'BP_Sedan', displayName: 'Sedan', health: 500, maxHealth: 1000, fuel: 50 },
      ]);
      const all = db.worldObject.getAllVehicles();
      assert.equal(all.length, 1);
      assert.equal(all[0].display_name, 'Sedan');
    });
  });

  describe('clans', () => {
    it('upserts a clan with members', () => {
      db.clan.upsertClan('TestClan', [
        { steamId: '76561198000000001', name: 'Player1', rank: 'Leader', canInvite: true, canKick: true },
        { steamId: '76561198000000002', name: 'Player2', rank: 'Member', canInvite: false, canKick: false },
      ]);
      const clans = db.clan.getAllClans();
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
      const p = db.player.getPlayer('76561198000000010');
      assert.equal(p.name, 'SyncPlayer');
      assert.equal(p.lifetime_kills, 200);

      assert.equal(db.worldState.getWorldState('daysPassed'), '100');
      assert.equal(db.worldState.getWorldState('currentSeason'), 'Winter');

      const structs = db.worldObject.getStructures();
      assert.equal(structs.length, 1);
      assert.equal(structs[0].display_name, 'Fence');
    });
  });

  describe('snapshots', () => {
    it('creates and retrieves snapshots', () => {
      db.worldState.createSnapshot('weekly', '76561198000000001', { kills: 42, deaths: 3 });
      const snap = db.worldState.getLatestSnapshot('weekly', '76561198000000001');
      assert.ok(snap);
      assert.equal(snap.data.kills, 42);
    });
  });

  describe('game reference seeding', () => {
    it('seeds game items', () => {
      db.gameData.seedGameItems([
        { id: 'Axe', name: 'Fire Axe', description: 'A fire axe', category: 'melee', stackSize: 1 },
        { id: 'Bandage', name: 'Bandage', description: 'Heals wounds', category: 'medical', stackSize: 5 },
      ]);
      const item = db.gameData.getGameItem('Axe');
      assert.ok(item);
      assert.equal(item.name, 'Fire Axe');
    });

    it('searches game items', () => {
      const results = db.gameData.searchGameItems('axe');
      assert.ok(results.length >= 1);
      assert.equal(results[0].id, 'Axe');
    });

    it('seeds professions', () => {
      db.gameData.seedGameProfessions([
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
      db.gameData.seedLoadingTips([
        { text: 'Tip 1', category: 'general' },
        { text: 'Tip 2', category: 'combat' },
      ]);
      const tip = db.gameData.getRandomTip();
      assert.ok(tip);
      assert.ok(tip.text);
    });
  });

  describe('server totals', () => {
    it('returns aggregate stats', () => {
      const totals = db.leaderboard.getServerTotals();
      assert.ok(totals.total_players > 0);
      assert.ok(typeof totals.total_kills === 'number');
    });
  });

  // ── Player identity / alias resolution ──

  describe('registerAlias', () => {
    it('registers a name↔steamId association', () => {
      db.player.registerAlias('76561198000000099', 'AliasTestPlayer', 'idmap');
      const result = db.player.resolveNameToSteamId('AliasTestPlayer');
      assert.ok(result);
      assert.equal(result.steamId, '76561198000000099');
      assert.equal(result.name, 'AliasTestPlayer');
      assert.equal(result.source, 'idmap');
    });

    it('is case-insensitive', () => {
      const result = db.player.resolveNameToSteamId('aliastestplayer');
      assert.ok(result);
      assert.equal(result.steamId, '76561198000000099');
    });

    it('rejects invalid steamIds', () => {
      db.player.registerAlias('name:BadKey', 'Ghost', 'log');
      const result = db.player.resolveNameToSteamId('Ghost');
      assert.equal(result, null);
    });

    it('rejects empty names', () => {
      db.player.registerAlias('76561198000000099', '', 'log');
      // Should not create a blank alias
      const aliases = db.player.getPlayerAliases('76561198000000099');
      assert.ok(!aliases.some((a: any) => a.name === ''));
    });
  });

  describe('resolveNameToSteamId', () => {
    it('resolves exact match', () => {
      db.player.registerAlias('76561198000000050', 'ExactMatch', 'connect_log');
      const r = db.player.resolveNameToSteamId('ExactMatch');
      assert.equal(r.steamId, '76561198000000050');
    });

    it('returns null for unknown name', () => {
      assert.equal(db.player.resolveNameToSteamId('TotallyUnknown'), null);
    });

    it('treats 17-digit numbers as direct SteamIDs', () => {
      const r = db.player.resolveNameToSteamId('76561198000000001');
      assert.equal(r.steamId, '76561198000000001');
      assert.equal(r.source, 'direct');
    });
  });

  describe('resolveSteamIdToName', () => {
    it('returns best current name', () => {
      db.player.registerAlias('76561198000000051', 'OldName', 'log');
      db.player.registerAlias('76561198000000051', 'CurrentName', 'idmap');
      const name = db.player.resolveSteamIdToName('76561198000000051');
      assert.equal(name, 'CurrentName');
    });

    it('returns steamId when no aliases exist', () => {
      const name = db.player.resolveSteamIdToName('76561198999999999');
      assert.equal(name, '76561198999999999');
    });

    it('prefers higher-priority sources', () => {
      db.player.registerAlias('76561198000000052', 'LogName', 'log');
      db.player.registerAlias('76561198000000052', 'IdmapName', 'idmap');
      db.player.registerAlias('76561198000000052', 'ConnLogName', 'connect_log');
      const name = db.player.resolveSteamIdToName('76561198000000052');
      assert.equal(name, 'IdmapName');
    });

    it('lists player display names with aliases resolved in one query', () => {
      db.player.upsertPlayer('76561198000000053', { name: 'SteamOnlyName' });
      db.player.upsertPlayer('76561198000000054', { name: 'OldPlayerName' });
      db.player.registerAlias('76561198000000054', 'DisplayNameFromIdMap', 'idmap');

      const rows = db.player.listAllPlayerDisplayNames();
      const bySteam = new Map<string, any>(rows.map((row: any) => [row.steam_id, row]));

      assert.equal(bySteam.get('76561198000000053')?.display_name, 'SteamOnlyName');
      assert.equal(bySteam.get('76561198000000054')?.display_name, 'DisplayNameFromIdMap');
    });
  });

  describe('getPlayerAliases', () => {
    it('returns all names for a player', () => {
      db.player.registerAlias('76561198000000060', 'Name1', 'log');
      db.player.registerAlias('76561198000000060', 'Name2', 'connect_log');
      db.player.registerAlias('76561198000000060', 'Name3', 'idmap');
      const aliases = db.player.getPlayerAliases('76561198000000060');
      assert.ok(aliases.length >= 3);
      const names = aliases.map((a: any) => a.name);
      assert.ok(names.includes('Name1'));
      assert.ok(names.includes('Name2'));
      assert.ok(names.includes('Name3'));
    });
  });

  describe('importIdMap', () => {
    it('bulk imports id map entries', () => {
      db.player.importIdMap([
        { steamId: '76561198000000070', name: 'MapPlayer1' },
        { steamId: '76561198000000071', name: 'MapPlayer2' },
        { steamId: '76561198000000072', name: 'MapPlayer3' },
      ]);
      assert.equal(db.player.resolveNameToSteamId('MapPlayer1').steamId, '76561198000000070');
      assert.equal(db.player.resolveNameToSteamId('MapPlayer2').steamId, '76561198000000071');
      assert.equal(db.player.resolveNameToSteamId('MapPlayer3').steamId, '76561198000000072');
    });
  });

  describe('importConnectLog', () => {
    it('bulk imports connect log entries', () => {
      db.player.importConnectLog([
        { steamId: '76561198000000080', name: 'ConnPlayer1' },
        { steamId: '76561198000000081', name: 'ConnPlayer2' },
      ]);
      assert.equal(db.player.resolveNameToSteamId('ConnPlayer1').steamId, '76561198000000080');
      assert.equal(db.player.resolveSteamIdToName('76561198000000081'), 'ConnPlayer2');
    });
  });

  describe('searchPlayersByName', () => {
    it('finds players by partial name', () => {
      db.player.registerAlias('76561198000000090', 'SearchableJohn', 'idmap');
      const results = db.player.searchPlayersByName('searchable');
      assert.ok(results.length > 0);
      assert.equal(results[0].steamId, '76561198000000090');
    });

    it('returns empty for no match', () => {
      const results = db.player.searchPlayersByName('xyzzynonexistent');
      assert.equal(results.length, 0);
    });
  });

  describe('getAliasStats', () => {
    it('returns counts', () => {
      const stats = db.player.getAliasStats();
      assert.ok(stats.uniquePlayers > 0);
      assert.ok(stats.totalAliases > 0);
      assert.ok(stats.totalAliases >= stats.uniquePlayers);
    });
  });

  describe('upsertPlayer auto-registers alias', () => {
    it('creates alias on player upsert with name', () => {
      db.player.upsertPlayer('76561198000000095', {
        name: 'AutoAliasPlayer',
        male: true,
        health: 100,
      });
      const r = db.player.resolveNameToSteamId('AutoAliasPlayer');
      assert.ok(r);
      assert.equal(r.steamId, '76561198000000095');
    });
  });

  describe('name change tracking via aliases', () => {
    it('tracks old and new names for the same player', () => {
      db.player.registerAlias('76561198000000085', 'OriginalName', 'connect_log');
      db.player.registerAlias('76561198000000085', 'NewerName', 'connect_log');

      // Both names should resolve to the same SteamID
      assert.equal(db.player.resolveNameToSteamId('OriginalName').steamId, '76561198000000085');
      assert.equal(db.player.resolveNameToSteamId('NewerName').steamId, '76561198000000085');

      // Current name should be the newer one
      const name = db.player.resolveSteamIdToName('76561198000000085');
      assert.equal(name, 'NewerName');

      // Both should appear in aliases
      const aliases = db.player.getPlayerAliases('76561198000000085');
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

      const allPlayers = db.player.getAllPlayers();
      assert.ok(allPlayers.length > 0, 'Should have players in DB after sync');

      const firstPlayer = allPlayers[0];
      assert.ok(firstPlayer.steam_id);
      assert.ok('health' in firstPlayer);
      assert.ok('inventory' in firstPlayer);
    });

    it('leaderboards work after sync', () => {
      const top = db.leaderboard.topKillers(10);
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
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- Test imports seed from a dynamic module shape.
    const { seed } = _game_reference as any;
    assert.doesNotThrow(() => {
      seed(db);
    });
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

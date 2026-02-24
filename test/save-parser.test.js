/**
 * Tests for save-parser.js — GVAS binary reader and save file parsing.
 * Run: npm test
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseSave, parseClanData, PERK_MAP, CLAN_RANK_MAP, createReader, readProperty } = require('../src/save-parser');

// ── Helper: build a minimal GVAS buffer ──

function buildGvasHeader() {
  const parts = [];
  // Magic
  parts.push(Buffer.from('GVAS'));
  // Save version + package version
  parts.push(Buffer.alloc(8, 0));
  // Engine version (major U16, minor U16, patch U16)
  parts.push(Buffer.alloc(6, 0));
  // Build U32
  parts.push(Buffer.alloc(4, 0));
  // Branch FString (empty string — length = 1, then null byte)
  const branchLen = Buffer.alloc(4);
  branchLen.writeInt32LE(1);
  parts.push(branchLen);
  parts.push(Buffer.from('\0'));
  // Custom version format U32 + count U32 (0 custom versions)
  parts.push(Buffer.alloc(8, 0));
  // Save class FString (empty — length = 1, null)
  parts.push(branchLen);
  parts.push(Buffer.from('\0'));
  return Buffer.concat(parts);
}

function writeFString(str) {
  if (str === '') {
    const buf = Buffer.alloc(4);
    buf.writeInt32LE(0);
    return buf;
  }
  const encoded = Buffer.from(str + '\0', 'utf8');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeInt32LE(encoded.length);
  return Buffer.concat([lenBuf, encoded]);
}

// ── Constants ──

describe('PERK_MAP', () => {
  it('has 12 profession entries', () => {
    assert.equal(Object.keys(PERK_MAP).length, 12);
  });

  it('maps known enum values', () => {
    assert.equal(PERK_MAP['Enum_Professions::NewEnumerator0'], 'Unemployed');
    assert.equal(PERK_MAP['Enum_Professions::NewEnumerator14'], 'Military Veteran');
    assert.equal(PERK_MAP['Enum_Professions::NewEnumerator17'], 'Electrical Engineer');
  });

  it('returns undefined for unknown enumerators', () => {
    assert.equal(PERK_MAP['Enum_Professions::NewEnumerator99'], undefined);
  });
});

describe('CLAN_RANK_MAP', () => {
  it('has 5 rank entries', () => {
    assert.equal(Object.keys(CLAN_RANK_MAP).length, 5);
  });

  it('maps all ranks correctly', () => {
    assert.equal(CLAN_RANK_MAP['E_ClanRank::NewEnumerator0'], 'Recruit');
    assert.equal(CLAN_RANK_MAP['E_ClanRank::NewEnumerator4'], 'Leader');
  });
});

// ── parseSave ──

describe('parseSave', () => {
  it('throws on non-GVAS input', () => {
    assert.throws(() => parseSave(Buffer.from('NOT_GVAS_DATA')), /Not a GVAS save file/);
  });

  it('throws on empty buffer', () => {
    assert.throws(() => parseSave(Buffer.alloc(0)));
  });

  it('returns a Map for a valid but empty save (header only + no properties)', () => {
    const header = buildGvasHeader();
    // Add a "None" property terminator (FString "None" + type "None")
    const noneStr = writeFString('None');
    const buf = Buffer.concat([header, noneStr]);
    const result = parseSave(buf);
    assert.ok(result.players instanceof Map);
  });
});

// ── parseClanData ──

describe('parseClanData', () => {
  it('returns an array for a valid but empty save', () => {
    const header = buildGvasHeader();
    const noneStr = writeFString('None');
    const buf = Buffer.concat([header, noneStr]);
    const result = parseClanData(buf);
    assert.ok(Array.isArray(result));
    assert.equal(result.length, 0);
  });

  it('throws on non-GVAS input', () => {
    assert.throws(() => parseClanData(Buffer.from('NOT_GVAS_DATA')), /Not a GVAS save file/);
  });
});

// ── readProperty: Transform with sub-properties ──

function writeU8(val) { const b = Buffer.alloc(1); b[0] = val; return b; }
function writeI32(val) { const b = Buffer.alloc(4); b.writeInt32LE(val); return b; }
function writeI64(val) { const b = Buffer.alloc(8); b.writeInt32LE(val, 0); b.writeInt32LE(0, 4); return b; }
function writeF32(val) { const b = Buffer.alloc(4); b.writeFloatLE(val); return b; }

function buildStructProperty(name, structType, contentParts) {
  const content = Buffer.concat(contentParts);
  return Buffer.concat([
    writeFString(name),
    writeFString('StructProperty'),
    writeI64(content.length),
    writeFString(structType),
    Buffer.alloc(16), // GUID
    writeU8(0),       // flag
    content,
  ]);
}

function buildVectorStruct(name, x, y, z) {
  return buildStructProperty(name, 'Vector', [writeF32(x), writeF32(y), writeF32(z)]);
}

function buildQuatStruct(name, x, y, z, w) {
  return buildStructProperty(name, 'Quat', [writeF32(x), writeF32(y), writeF32(z), writeF32(w)]);
}

function buildTransformStruct(name, tx, ty, tz, qx, qy, qz, qw) {
  const translationProp = buildVectorStruct('Translation', tx, ty, tz);
  const rotationProp = buildQuatStruct('Rotation', qx, qy, qz, qw);
  const noneTerm = writeFString('None');
  return buildStructProperty(name, 'Transform', [translationProp, rotationProp, noneTerm]);
}

describe('readProperty — Transform', () => {
  it('captures Translation and Rotation sub-properties', () => {
    const data = buildTransformStruct('ActorTransform', 100.5, -200.25, 50.0, 0, 0, 0.7071, 0.7071);
    const r = createReader(data);
    const prop = readProperty(r);
    
    assert.ok(prop);
    assert.equal(prop.name, 'ActorTransform');
    assert.equal(prop.type, 'StructProperty');
    assert.equal(prop.structType, 'Transform');
    
    // Translation should be captured
    assert.ok(prop.value.translation);
    assert.ok(Math.abs(prop.value.translation.x - 100.5) < 0.01);
    assert.ok(Math.abs(prop.value.translation.y - (-200.25)) < 0.01);
    assert.ok(Math.abs(prop.value.translation.z - 50.0) < 0.01);
    
    // Rotation should be captured
    assert.ok(prop.value.rotation);
    assert.ok(Math.abs(prop.value.rotation.z - 0.7071) < 0.01);
    assert.ok(Math.abs(prop.value.rotation.w - 0.7071) < 0.01);
  });

  it('children array includes sub-properties', () => {
    const data = buildTransformStruct('PlayerTransform', 1000, -2000, 300, 0, 0, 0, 1);
    const r = createReader(data);
    const prop = readProperty(r);
    
    assert.ok(Array.isArray(prop.children));
    const names = prop.children.map(c => c.name);
    assert.ok(names.includes('Translation'));
    assert.ok(names.includes('Rotation'));
  });
});

// ── parseSave: coordinate extraction into player data ──

function buildStrProperty(name, value) {
  const valBuf = writeFString(value);
  return Buffer.concat([
    writeFString(name),
    writeFString('StrProperty'),
    writeI64(valBuf.length),
    writeU8(0), // flag
    valBuf,
  ]);
}

describe('parseSave — player coordinates', () => {
  it('extracts position from Transform after SteamID', () => {
    const header = buildGvasHeader();
    const steamIdProp = buildStrProperty('SteamID', '76561198055916841');
    const transformProp = buildTransformStruct('SavedTransform', 37377.63, -292189.0, 5014.04, 0, 0, -0.5, 0.866);
    const noneTerm = writeFString('None');
    
    const buf = Buffer.concat([header, steamIdProp, transformProp, noneTerm]);
    const { players } = parseSave(buf);
    
    assert.equal(players.size, 1);
    const p = players.get('76561198055916841');
    assert.ok(p);
    assert.ok(Math.abs(p.x - 37377.63) < 0.1);
    assert.ok(Math.abs(p.y - (-292189.0)) < 1);
    assert.ok(Math.abs(p.z - 5014.04) < 0.1);
    assert.ok(typeof p.rotationYaw === 'number');
  });

  it('defaults to null coordinates when no Transform present', () => {
    const header = buildGvasHeader();
    const steamIdProp = buildStrProperty('SteamID', '76561198000000001');
    const noneTerm = writeFString('None');
    
    const buf = Buffer.concat([header, steamIdProp, noneTerm]);
    const { players } = parseSave(buf);
    
    const p = players.get('76561198000000001');
    assert.ok(p);
    assert.equal(p.x, null);
    assert.equal(p.y, null);
    assert.equal(p.z, null);
    assert.equal(p.rotationYaw, null);
  });
});

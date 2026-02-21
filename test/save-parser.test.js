/**
 * Tests for save-parser.js — GVAS binary reader and save file parsing.
 * Run: npm test
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseSave, parseClanData, PERK_MAP, CLAN_RANK_MAP } = require('../src/save-parser');

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
    assert.ok(result instanceof Map);
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

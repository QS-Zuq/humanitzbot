/**
 * Tests for /threads rebuild — log parsing and summary builders.
 * Run: node --test test/threads.test.js
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { _parseHmzLog, _parseConnectLog, _mergeDays, _buildSummaryEmbed, _dateKey } = require('../src/commands/threads');

// ══════════════════════════════════════════════════════════
// _dateKey
// ══════════════════════════════════════════════════════════

describe('_dateKey', () => {
  it('returns YYYY-MM-DD string for a Date', () => {
    const key = _dateKey(new Date('2026-02-15T12:00:00Z'));
    assert.match(key, /^\d{4}-\d{2}-\d{2}$/);
  });

  it('returns consistent key for same day', () => {
    const a = _dateKey(new Date('2026-02-15T01:00:00Z'));
    const b = _dateKey(new Date('2026-02-15T10:00:00Z'));
    assert.equal(a, b);
  });
});

// ══════════════════════════════════════════════════════════
// _parseHmzLog
// ══════════════════════════════════════════════════════════

describe('_parseHmzLog', () => {
  it('returns empty object for empty input', () => {
    assert.deepEqual(_parseHmzLog(''), {});
  });

  it('ignores lines that do not match the timestamp regex', () => {
    assert.deepEqual(_parseHmzLog('random garbage line\nanother line'), {});
  });

  it('counts player deaths', () => {
    const log = '(15/02/2026 12:30) Player died (TestPlayer)\n';
    const days = _parseHmzLog(log);
    const keys = Object.keys(days);
    assert.equal(keys.length, 1);
    assert.equal(days[keys[0]].deaths, 1);
    assert.ok(days[keys[0]].players.has('TestPlayer'));
  });

  it('counts building completed', () => {
    const log = '(15/02/2026 14:00) Builder(12345678901234567) finished building WoodWall\n';
    const days = _parseHmzLog(log);
    const key = Object.keys(days)[0];
    assert.equal(days[key].builds, 1);
  });

  it('counts damage taken', () => {
    const log = '(15/02/2026 14:00) SomePlayer took 25.0 damage from Zombie\n';
    const days = _parseHmzLog(log);
    const key = Object.keys(days)[0];
    assert.equal(days[key].damage, 1);
  });

  it('counts container looted', () => {
    const log = '(15/02/2026 14:00) Looter (12345678901234567) looted a container\n';
    const days = _parseHmzLog(log);
    const key = Object.keys(days)[0];
    assert.equal(days[key].loots, 1);
  });

  it('counts raid hits and destroyed', () => {
    const log = [
      '(15/02/2026 14:00) Building (WoodWall) owned by (12345678901234567) damaged by Player',
      '(15/02/2026 14:05) Building (WoodWall) owned by (12345678901234567) damaged by Player (Destroyed)',
    ].join('\n');
    const days = _parseHmzLog(log);
    const key = Object.keys(days)[0];
    assert.equal(days[key].raidHits, 1);
    assert.equal(days[key].destroyed, 1);
  });

  it('counts admin access', () => {
    const log = '(15/02/2026 14:00) SomeAdmin gained admin access!\n';
    const days = _parseHmzLog(log);
    const key = Object.keys(days)[0];
    assert.equal(days[key].admin, 1);
  });

  it('counts multiple events across two days', () => {
    const log = [
      '(15/02/2026 12:00) Player died (Alice)',
      '(15/02/2026 13:00) Player died (Bob)',
      '(16/02/2026 08:00) Player died (Charlie)',
    ].join('\n');
    const days = _parseHmzLog(log);
    const keys = Object.keys(days).sort();
    assert.equal(keys.length, 2);
    assert.equal(days[keys[0]].deaths, 2);
    assert.equal(days[keys[1]].deaths, 1);
  });
});

// ══════════════════════════════════════════════════════════
// _parseConnectLog
// ══════════════════════════════════════════════════════════

describe('_parseConnectLog', () => {
  it('returns empty object for empty input', () => {
    assert.deepEqual(_parseConnectLog(''), {});
  });

  it('counts connects and disconnects', () => {
    const log = [
      'Player Connected TestPlayer NetID(12345678901234567) (15/02/2026 10:00)',
      'Player Disconnected TestPlayer NetID(12345678901234567) (15/02/2026 11:00)',
    ].join('\n');
    const days = _parseConnectLog(log);
    const keys = Object.keys(days);
    assert.equal(keys.length, 1);
    assert.equal(days[keys[0]].connects, 1);
    assert.equal(days[keys[0]].disconnects, 1);
    assert.ok(days[keys[0]].players.has('TestPlayer'));
  });
});

// ══════════════════════════════════════════════════════════
// _mergeDays
// ══════════════════════════════════════════════════════════

describe('_mergeDays', () => {
  it('merges hmz and connect data for same date', () => {
    const hmz = { '2026-02-15': { deaths: 3, builds: 1, damage: 5, loots: 2, raidHits: 0, destroyed: 0, admin: 0, cheat: 0, players: new Set(['Alice']) } };
    const conn = { '2026-02-15': { connects: 4, disconnects: 2, players: new Set(['Alice', 'Bob']) } };
    const merged = _mergeDays(hmz, conn);
    assert.equal(merged['2026-02-15'].deaths, 3);
    assert.equal(merged['2026-02-15'].connects, 4);
    assert.equal(merged['2026-02-15'].uniquePlayers, 2);
  });

  it('includes dates that appear in only one source', () => {
    const hmz = { '2026-02-15': { deaths: 1, builds: 0, damage: 0, loots: 0, raidHits: 0, destroyed: 0, admin: 0, cheat: 0, players: new Set() } };
    const conn = { '2026-02-16': { connects: 2, disconnects: 1, players: new Set(['X']) } };
    const merged = _mergeDays(hmz, conn);
    assert.ok('2026-02-15' in merged);
    assert.ok('2026-02-16' in merged);
  });
});

// ══════════════════════════════════════════════════════════
// _buildSummaryEmbed
// ══════════════════════════════════════════════════════════

describe('_buildSummaryEmbed', () => {
  it('returns an EmbedBuilder with title and description', () => {
    const embed = _buildSummaryEmbed('2026-02-15', {
      connects: 5, disconnects: 3, deaths: 2, builds: 1,
      damage: 10, loots: 4, raidHits: 0, destroyed: 0,
      admin: 0, cheat: 0, uniquePlayers: 3,
    });
    const json = embed.toJSON();
    assert.ok(json.title.includes('Daily Summary'));
    assert.ok(json.description.includes('Deaths'));
    assert.ok(json.description.includes('Connections'));
  });

  it('omits zero-count categories', () => {
    const embed = _buildSummaryEmbed('2026-02-15', {
      connects: 0, disconnects: 0, deaths: 1, builds: 0,
      damage: 0, loots: 0, raidHits: 0, destroyed: 0,
      admin: 0, cheat: 0, uniquePlayers: 1,
    });
    const desc = embed.toJSON().description;
    assert.ok(desc.includes('Deaths'));
    assert.ok(!desc.includes('Connections'));
    assert.ok(!desc.includes('Items Built'));
  });
});

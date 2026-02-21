/**
 * Tests for server-info.js — RCON response parsing.
 * Run: npm test
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { _parseServerInfo: parseServerInfo, _parsePlayerList: parsePlayerList } = require('../src/server-info');

// ══════════════════════════════════════════════════════════
// parseServerInfo
// ══════════════════════════════════════════════════════════

describe('parseServerInfo', () => {
  it('returns empty result for null/empty input', () => {
    const r1 = parseServerInfo(null);
    assert.deepEqual(r1.fields, {});
    assert.equal(r1.raw, '');

    const r2 = parseServerInfo('');
    assert.deepEqual(r2.fields, {});

    const r3 = parseServerInfo('   ');
    assert.deepEqual(r3.fields, {});
  });

  it('parses standard key:value response', () => {
    const raw = [
      'Name: My Test Server',
      'Day: 42',
      'Time: 14:5',
      'Season: Summer',
      'Weather: Sunny',
      'FPS: 60',
      'AI: 150',
      '5 connected.',
    ].join('\n');

    const info = parseServerInfo(raw);
    assert.equal(info.name, 'My Test Server');
    assert.equal(info.day, '42');
    assert.equal(info.time, '14:05'); // zero-padded
    assert.equal(info.season, 'Summer');
    assert.equal(info.weather, 'Sunny');
    assert.equal(info.fps, '60');
    assert.equal(info.ai, '150');
    assert.equal(info.players, 5);
  });

  it('zero-pads single-digit minutes in time', () => {
    const info = parseServerInfo('Time: 2:2');
    assert.equal(info.time, '2:02');
  });

  it('keeps already-padded time intact', () => {
    const info = parseServerInfo('Time: 14:30');
    assert.equal(info.time, '14:30');
  });

  it('parses "no players connected"', () => {
    const info = parseServerInfo('No players connected');
    assert.equal(info.players, 0);
  });

  it('parses "X connected." format', () => {
    const info = parseServerInfo('12 connected.');
    assert.equal(info.players, 12);
  });

  it('parses "0 connected." format', () => {
    const info = parseServerInfo('0 connected.');
    assert.equal(info.players, 0);
  });

  it('parses player count with max (Players: 5/32)', () => {
    const info = parseServerInfo('Players: 5/32');
    assert.equal(info.players, 5);
    assert.equal(info.maxPlayers, 32);
  });

  it('parses version field', () => {
    const info = parseServerInfo('Version: 0.9.23');
    assert.equal(info.version, '0.9.23');
  });

  it('stores all fields generically', () => {
    const info = parseServerInfo('CustomField: some value');
    assert.equal(info.fields['CustomField'], 'some value');
  });
});

// ══════════════════════════════════════════════════════════
// parsePlayerList
// ══════════════════════════════════════════════════════════

describe('parsePlayerList', () => {
  it('returns empty for null/empty input', () => {
    const r = parsePlayerList(null);
    assert.equal(r.count, 0);
    assert.deepEqual(r.players, []);
  });

  it('returns empty for "no players connected"', () => {
    const r = parsePlayerList('No players connected');
    assert.equal(r.count, 0);
    assert.deepEqual(r.players, []);
  });

  it('parses HumanitZ player format with SteamID', () => {
    const raw = 'PlayerOne (76561100000000001)';
    const r = parsePlayerList(raw);
    assert.equal(r.count, 1);
    assert.equal(r.players[0].name, 'PlayerOne');
    assert.equal(r.players[0].steamId, '76561100000000001');
  });

  it('parses multiple players', () => {
    const raw = [
      'PlayerOne (76561100000000001)',
      'Player Two (76561100000000002)',
      'Player-Three (76561100000000003)',
    ].join('\n');
    const r = parsePlayerList(raw);
    assert.equal(r.count, 3);
    assert.equal(r.players[0].name, 'PlayerOne');
    assert.equal(r.players[1].name, 'Player Two');
    assert.equal(r.players[2].name, 'Player-Three');
  });

  it('handles extended SteamID format (with GUID)', () => {
    const raw = 'PlayerOne (76561100000000001_+_|abc123)';
    const r = parsePlayerList(raw);
    assert.equal(r.players[0].name, 'PlayerOne');
    assert.equal(r.players[0].steamId, '76561100000000001');
  });

  it('handles player count header', () => {
    const raw = [
      'Players: 2',
      'Alpha (76561100000000001)',
      'Beta (76561100000000002)',
    ].join('\n');
    const r = parsePlayerList(raw);
    assert.equal(r.count, 2);
    assert.equal(r.players.length, 2);
  });

  it('falls back to plain name when no SteamID', () => {
    const raw = 'SomeName';
    const r = parsePlayerList(raw);
    assert.equal(r.count, 1);
    assert.equal(r.players[0].name, 'SomeName');
    assert.equal(r.players[0].steamId, 'N/A');
  });

  it('skips junk lines', () => {
    const raw = [
      'Players',
      '---',
      '===',
      'no players found',
    ].join('\n');
    const r = parsePlayerList(raw);
    assert.equal(r.count, 0);
    assert.deepEqual(r.players, []);
  });
});

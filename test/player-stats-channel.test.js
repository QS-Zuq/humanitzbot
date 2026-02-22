/**
 * Tests for player-stats-channel.js utility functions: _parseIni, _cleanItemName
 * Run: npm test
 */
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');

const { _parseIni, _cleanItemName } = require('../src/player-stats-channel');

// Clean up singleton timers that keep the process alive.
// Requiring player-stats-channel pulls in both player-stats and playtime-tracker
// singletons. Any test that triggers _ensureInit() (e.g. _snapshotPlayerStats)
// starts 60-second setIntervals on both — clear them so the process can exit.
after(() => {
  const playtime = require('../src/playtime-tracker');
  if (playtime._saveTimer) { clearInterval(playtime._saveTimer); playtime._saveTimer = null; }

  const pStats = require('../src/player-stats');
  if (pStats._saveTimer) { clearInterval(pStats._saveTimer); pStats._saveTimer = null; }
});

// ══════════════════════════════════════════════════════════
// _parseIni
// ══════════════════════════════════════════════════════════

describe('_parseIni', () => {
  it('parses simple key=value pairs', () => {
    const result = _parseIni('key1=value1\nkey2=value2');
    assert.deepEqual(result, { key1: 'value1', key2: 'value2' });
  });

  it('trims whitespace around keys and values', () => {
    const result = _parseIni('  key  =  value  ');
    assert.equal(result.key, 'value');
  });

  it('skips comment lines (# and ;)', () => {
    const result = _parseIni('# Comment\n; Another comment\nkey=value');
    assert.deepEqual(result, { key: 'value' });
  });

  it('skips empty lines', () => {
    const result = _parseIni('\n\nkey=value\n\n');
    assert.deepEqual(result, { key: 'value' });
  });

  it('handles section headers (ignores them, takes last key)', () => {
    const ini = '[Section1]\nkey=val1\n[Section2]\nkey=val2';
    const result = _parseIni(ini);
    assert.equal(result.key, 'val2'); // last one wins
  });

  it('handles values with = sign', () => {
    const result = _parseIni('path=C:\\some=path');
    assert.equal(result.path, 'C:\\some=path');
  });

  it('handles empty values', () => {
    const result = _parseIni('key=');
    assert.equal(result.key, '');
  });

  it('handles \\r\\n line endings', () => {
    const result = _parseIni('key1=val1\r\nkey2=val2');
    assert.deepEqual(result, { key1: 'val1', key2: 'val2' });
  });

  it('returns empty object for empty input', () => {
    assert.deepEqual(_parseIni(''), {});
  });

  it('parses realistic GameServerSettings.ini content', () => {
    const ini = `[GameServerSettings]
ServerName=My Server
MaxPlayers=32
PvP=true
# This is a comment
Password=`;
    const result = _parseIni(ini);
    assert.equal(result.ServerName, 'My Server');
    assert.equal(result.MaxPlayers, '32');
    assert.equal(result.PvP, 'true');
    assert.equal(result.Password, '');
  });
});

// ══════════════════════════════════════════════════════════
// _cleanItemName
// ══════════════════════════════════════════════════════════

describe('_cleanItemName', () => {
  it('splits camelCase into words', () => {
    assert.equal(_cleanItemName('WoodenWall'), 'Wooden Wall');
  });

  it('splits consecutive uppercase then lowercase', () => {
    assert.equal(_cleanItemName('ABCDef'), 'ABC Def');
  });

  it('strips BP_ prefix', () => {
    assert.equal(_cleanItemName('BP_WoodenWall'), 'Wooden Wall');
  });

  it('strips _C suffix', () => {
    assert.equal(_cleanItemName('WoodenWall_C'), 'Wooden Wall');
  });

  it('replaces underscores with spaces', () => {
    assert.equal(_cleanItemName('Wooden_Wall'), 'Wooden Wall');
  });

  it('expands Lv to Lvl', () => {
    assert.equal(_cleanItemName('SwordLv3'), 'Sword Lvl 3');
  });

  it('handles full UE4 blueprint name', () => {
    assert.equal(_cleanItemName('BP_WoodenWall_C'), 'Wooden Wall');
  });

  it('returns empty string for null/undefined', () => {
    assert.equal(_cleanItemName(null), '');
    assert.equal(_cleanItemName(undefined), '');
  });

  it('converts non-string input to string', () => {
    assert.equal(_cleanItemName(123), '123');
  });

  it('trims result', () => {
    assert.equal(_cleanItemName('  SomeName  '), 'Some Name');
  });
});

// ══════════════════════════════════════════════════════════
// _isNewWeek (weekly baseline reset detection)
// ══════════════════════════════════════════════════════════

const PlayerStatsChannel = require('../src/player-stats-channel');

describe('_isNewWeek', () => {
  // Create a minimal instance to call the prototype method
  function makeInstance() {
    const inst = Object.create(PlayerStatsChannel.prototype);
    return inst;
  }

  it('returns true when no weekStart exists', () => {
    const inst = makeInstance();
    assert.equal(inst._isNewWeek(null, new Date('2025-06-16T10:00:00Z')), true);
  });

  it('returns false when baseline is in current week (reset Mon)', () => {
    const inst = makeInstance();
    // Wednesday baseline, checked on Thursday (same week, reset day=Mon)
    // config.weeklyResetDay = 1 (Monday), config.botTimezone = 'UTC' or similar
    const baseline = '2025-06-11T12:00:00Z'; // Wednesday Jun 11
    const now = new Date('2025-06-12T12:00:00Z'); // Thursday Jun 12
    // Both are in the week starting Mon Jun 9
    assert.equal(inst._isNewWeek(baseline, now), false);
  });

  it('returns true when baseline is from previous week', () => {
    const inst = makeInstance();
    // Baseline from last week Friday, now is this week Tuesday
    const baseline = '2025-06-06T12:00:00Z'; // Friday Jun 6
    const now = new Date('2025-06-10T12:00:00Z'); // Tuesday Jun 10
    // Reset is Monday → Jun 9 is the boundary
    assert.equal(inst._isNewWeek(baseline, now), true);
  });

  it('returns true when baseline is from before the reset boundary', () => {
    const inst = makeInstance();
    // Baseline from Saturday, now is Monday afternoon (after reset)
    // In Europe/Tallinn (UTC+3): Sat Jun 7 23:00 → Mon Jun 9 15:00
    const baseline = '2025-06-07T20:00:00Z'; // Saturday Jun 7
    const now = new Date('2025-06-09T12:00:00Z'); // Monday Jun 9
    assert.equal(inst._isNewWeek(baseline, now), true);
  });

  it('returns false when checked on reset day with same-week baseline', () => {
    const inst = makeInstance();
    // Baseline from this Monday morning, checked later same Monday
    const baseline = '2025-06-09T06:00:00Z'; // Monday Jun 9 morning
    const now = new Date('2025-06-09T18:00:00Z'); // Monday Jun 9 evening
    assert.equal(inst._isNewWeek(baseline, now), false);
  });
});

// ══════════════════════════════════════════════════════════
// _snapshotPlayerStats
// ══════════════════════════════════════════════════════════

describe('_snapshotPlayerStats', () => {
  function makeInstance(saveData, logStats, ptData) {
    const inst = Object.create(PlayerStatsChannel.prototype);
    inst._saveData = saveData || new Map();
    inst._killData = { players: {} };
    return inst;
  }

  it('creates a snapshot with all stat fields', () => {
    const saveData = new Map([['12345', { fishCaught: 10, timesBitten: 3, lifetimeKills: 50, hasExtendedStats: true }]]);
    const inst = makeInstance(saveData);
    const snap = inst._snapshotPlayerStats('12345');
    assert.equal(snap.kills, 50);
    assert.equal(snap.fish, 10);
    assert.equal(snap.bitten, 3);
    assert.equal(typeof snap.pvpKills, 'number');
    assert.equal(typeof snap.playtimeMs, 'number');
  });

  it('returns zeros for unknown player', () => {
    const inst = makeInstance(new Map());
    const snap = inst._snapshotPlayerStats('unknown');
    assert.equal(snap.kills, 0);
    assert.equal(snap.pvpKills, 0);
    assert.equal(snap.fish, 0);
    assert.equal(snap.bitten, 0);
    assert.equal(snap.playtimeMs, 0);
  });
});

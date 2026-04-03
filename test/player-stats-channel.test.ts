/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-floating-promises */
/**
 * Tests for player-stats-channel.js utility functions: _parseIni, _cleanItemName
 * Run: npm test
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';

import * as _player_stats_channel from '../src/modules/player-stats-channel.js';
const { _parseIni, _cleanItemName, _resolveUdsWeather, _dbRowToSave } = _player_stats_channel as any;

// Clean up singleton references after tests.
// Requiring player-stats-channel pulls in both player-stats and playtime-tracker
// singletons. No timers to clean up since DB-first migration removed JSON auto-save.
after(() => {
  // no-op — kept for future cleanup hooks if needed
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

describe('_isNewWeek (via KillTracker)', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- dynamic require for test isolation
  const KillTracker = require('../src/tracking/kill-tracker');

  function makeTracker(resetDay = 1, tz = 'UTC') {
    return new KillTracker({
      config: { weeklyResetDay: resetDay, botTimezone: tz, showWeeklyStats: true, getToday: () => '2025-06-12' },
      playerStats: { getStats: () => null, getAllPlayers: () => [], getNameForId: () => null },
      playtime: { getPlaytime: () => null },
      db: null,
    });
  }

  it('returns true when no weekStart exists', () => {
    const tracker = makeTracker();
    assert.equal(tracker._isNewWeek(null, new Date('2025-06-16T10:00:00Z')), true);
  });

  it('returns false when baseline is in current week (reset Mon)', () => {
    const tracker = makeTracker();
    const baseline = '2025-06-11T12:00:00Z'; // Wednesday Jun 11
    const now = new Date('2025-06-12T12:00:00Z'); // Thursday Jun 12
    assert.equal(tracker._isNewWeek(baseline, now), false);
  });

  it('returns true when baseline is from previous week', () => {
    const tracker = makeTracker();
    const baseline = '2025-06-06T12:00:00Z'; // Friday Jun 6
    const now = new Date('2025-06-10T12:00:00Z'); // Tuesday Jun 10
    assert.equal(tracker._isNewWeek(baseline, now), true);
  });

  it('returns true when baseline is from before the reset boundary', () => {
    const tracker = makeTracker();
    const baseline = '2025-06-07T20:00:00Z'; // Saturday Jun 7
    const now = new Date('2025-06-09T12:00:00Z'); // Monday Jun 9
    assert.equal(tracker._isNewWeek(baseline, now), true);
  });

  it('returns false when checked on reset day with same-week baseline', () => {
    const tracker = makeTracker();
    const baseline = '2025-06-09T06:00:00Z'; // Monday Jun 9 morning
    const now = new Date('2025-06-09T18:00:00Z'); // Monday Jun 9 evening
    assert.equal(tracker._isNewWeek(baseline, now), false);
  });

  it('handles bot timezone ahead of UTC without false reset', () => {
    const tracker = makeTracker(1, 'Europe/Tallinn');
    const baseline = '2025-06-11T12:00:00Z'; // Wed Jun 11 15:00 Tallinn
    const now = new Date('2025-06-12T21:30:00Z'); // Fri Jun 13 00:30 Tallinn
    assert.equal(
      tracker._isNewWeek(baseline, now),
      false,
      'should NOT reset mid-week even when bot TZ is ahead of system TZ',
    );
  });

  it('correctly resets when bot timezone crosses weekly boundary', () => {
    const tracker = makeTracker(1, 'Europe/Tallinn');
    const baseline = '2025-06-06T12:00:00Z'; // Fri Jun 6
    const now = new Date('2025-06-10T08:00:00Z'); // Tue Jun 10, 11:00 Tallinn
    assert.equal(tracker._isNewWeek(baseline, now), true, 'should reset when Mon boundary has passed in bot TZ');
  });
});

// ══════════════════════════════════════════════════════════
// _snapshotPlayerStats (now in KillTracker)
// ══════════════════════════════════════════════════════════

describe('_snapshotPlayerStats (via KillTracker)', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- dynamic require for test isolation
  const KillTracker = require('../src/tracking/kill-tracker');

  function makeTracker(_saveData: Map<string, unknown>, logStats?: unknown, ptData?: unknown) {
    return new KillTracker({
      config: { showWeeklyStats: true, weeklyResetDay: 1, botTimezone: 'UTC', getToday: () => '2025-01-15' },
      playerStats: { getStats: () => logStats || null, getAllPlayers: () => [], getNameForId: () => null },
      playtime: { getPlaytime: () => ptData || null },
      db: null,
    });
  }

  it('creates a snapshot with all stat fields', () => {
    const saveData = new Map([
      ['12345', { fishCaught: 10, timesBitten: 3, lifetimeKills: 50, hasExtendedStats: true }],
    ]);
    const tracker = makeTracker(saveData);
    const snap = tracker._snapshotPlayerStats('12345', saveData);
    assert.equal(snap.kills, 50);
    assert.equal(snap.fish, 10);
    assert.equal(snap.bitten, 3);
    assert.equal(typeof snap.pvpKills, 'number');
    assert.equal(typeof snap.playtimeMs, 'number');
  });

  it('returns zeros for unknown player', () => {
    const tracker = makeTracker(new Map());
    const snap = tracker._snapshotPlayerStats('unknown', new Map());
    assert.equal(snap.kills, 0);
    assert.equal(snap.pvpKills, 0);
    assert.equal(snap.fish, 0);
    assert.equal(snap.bitten, 0);
    assert.equal(snap.playtimeMs, 0);
  });
});

// ══════════════════════════════════════════════════════════
// _resolveUdsWeather
// ══════════════════════════════════════════════════════════

describe('_resolveUdsWeather', () => {
  it('maps known UDS weather enums to readable names', () => {
    assert.equal(_resolveUdsWeather('UDS_WeatherTypes::NewEnumerator0'), 'Clear Skies');
    assert.equal(_resolveUdsWeather('UDS_WeatherTypes::NewEnumerator4'), 'Foggy');
    assert.equal(_resolveUdsWeather('UDS_WeatherTypes::NewEnumerator7'), 'Thunderstorm');
    assert.equal(_resolveUdsWeather('UDS_WeatherTypes::NewEnumerator10'), 'Blizzard');
  });

  it('falls back gracefully for unknown enum values', () => {
    const result = _resolveUdsWeather('UDS_WeatherTypes::NewEnumerator99');
    assert.equal(result, 'Weather 99');
  });

  it('returns null for null/empty input', () => {
    assert.equal(_resolveUdsWeather(null), null);
    assert.equal(_resolveUdsWeather(''), null);
  });
});

// ══════════════════════════════════════════════════════════
// Challenge snapshot and detection helpers
// ══════════════════════════════════════════════════════════

describe('Challenge tracking (via KillTracker)', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- dynamic require for test isolation
  const KillTracker = require('../src/tracking/kill-tracker');

  it('CHALLENGE_KEYS contains all 19 challenge fields', () => {
    assert.equal(KillTracker.CHALLENGE_KEYS.length, 19);
    assert.ok(KillTracker.CHALLENGE_KEYS.includes('challengeKill50'));
    assert.ok(KillTracker.CHALLENGE_KEYS.includes('challengeFindDog'));
    assert.ok(KillTracker.CHALLENGE_KEYS.includes('challengeRepairRadio'));
  });

  it('_snapshotChallenges captures current values', () => {
    const save = { challengeKill50: 35, challengeFindDog: 1, challengeCraftFurnace: 0 };
    const snap = KillTracker._snapshotChallenges(save);
    assert.equal(snap.challengeKill50, 35);
    assert.equal(snap.challengeFindDog, 1);
    assert.equal(snap.challengeCraftFurnace, 0);
    // Missing keys default to 0
    assert.equal(snap.challengeRepairRadio, 0);
  });
});

// ══════════════════════════════════════════════════════════
// _dbRowToSave — DB snake_case → camelCase save format
// ══════════════════════════════════════════════════════════

describe('_dbRowToSave', () => {
  it('returns null for null input', () => {
    assert.equal(_dbRowToSave(null), null);
  });

  it('converts kill stats from snake_case to camelCase', () => {
    const row = {
      steam_id: '76561198000000001',
      name: 'TestPlayer',
      zeeks_killed: 100,
      headshots: 50,
      melee_kills: 30,
      gun_kills: 40,
      blast_kills: 5,
      fist_kills: 2,
      takedown_kills: 8,
      vehicle_kills: 3,
    };
    const save = _dbRowToSave(row);
    assert.equal(save.zeeksKilled, 100);
    assert.equal(save.headshots, 50);
    assert.equal(save.meleeKills, 30);
    assert.equal(save.gunKills, 40);
    assert.equal(save.blastKills, 5);
    assert.equal(save.fistKills, 2);
    assert.equal(save.takedownKills, 8);
    assert.equal(save.vehicleKills, 3);
  });

  it('converts lifetime stats correctly', () => {
    const row = {
      lifetime_kills: 500,
      lifetime_headshots: 200,
      lifetime_melee_kills: 150,
      lifetime_gun_kills: 250,
      lifetime_blast_kills: 10,
      lifetime_fist_kills: 5,
      lifetime_takedown_kills: 20,
      lifetime_vehicle_kills: 15,
      lifetime_days_survived: 45,
      has_extended_stats: true,
    };
    const save = _dbRowToSave(row);
    assert.equal(save.lifetimeKills, 500);
    assert.equal(save.lifetimeHeadshots, 200);
    assert.equal(save.lifetimeDaysSurvived, 45);
    assert.equal(save.hasExtendedStats, true);
  });

  it('converts vitals and position', () => {
    const row = {
      health: 85,
      max_health: 100,
      hunger: 60,
      max_hunger: 100,
      thirst: 40,
      max_thirst: 100,
      stamina: 90,
      max_stamina: 100,
      infection: 75,
      max_infection: 100,
      battery: 50,
      fatigue: 0.3,
      infection_buildup: 10,
      pos_x: 1000,
      pos_y: 2000,
      pos_z: 300,
      rotation_yaw: 45,
    };
    const save = _dbRowToSave(row);
    assert.equal(save.health, 85);
    assert.equal(save.maxHealth, 100);
    assert.equal(save.hunger, 60);
    assert.equal(save.stamina, 90);
    assert.equal(save.infection, 75);
    assert.equal(save.battery, 50);
    assert.equal(save.fatigue, 0.3);
    assert.equal(save.infectionBuildup, 10);
    assert.equal(save.x, 1000);
    assert.equal(save.y, 2000);
    assert.equal(save.z, 300);
    assert.equal(save.rotationYaw, 45);
  });

  it('converts JSON array columns with null fallback', () => {
    const row = {
      crafting_recipes: ['Recipe1', 'Recipe2'],
      building_recipes: null,
      unlocked_skills: ['Skill1'],
      inventory: [],
      equipment: [{ item: 'Axe', amount: 1 }],
      companion_data: null,
      horses: null,
    };
    const save = _dbRowToSave(row);
    assert.deepEqual(save.craftingRecipes, ['Recipe1', 'Recipe2']);
    assert.deepEqual(save.buildingRecipes, []);
    assert.deepEqual(save.unlockedSkills, ['Skill1']);
    assert.deepEqual(save.inventory, []);
    assert.deepEqual(save.equipment, [{ item: 'Axe', amount: 1 }]);
    assert.deepEqual(save.companionData, []);
    assert.deepEqual(save.horses, []);
  });

  it('converts challenge fields', () => {
    const row = {
      challenge_kill_zombies: 100,
      challenge_kill_50: 50,
      challenge_catch_20_fish: 20,
      challenge_find_dog: 1,
      challenge_repair_radio: 0,
      challenge_9_squares: 5,
      challenge_lockpick_suv: 1,
    };
    const save = _dbRowToSave(row);
    assert.equal(save.challengeKillZombies, 100);
    assert.equal(save.challengeKill50, 50);
    assert.equal(save.challengeCatch20Fish, 20);
    assert.equal(save.challengeFindDog, 1);
    assert.equal(save.challengeRepairRadio, 0);
    assert.equal(save.challenge9Squares, 5);
    assert.equal(save.challengeLockpickSUV, 1);
  });

  it('converts activity fields', () => {
    const row = {
      days_survived: 12,
      times_bitten: 5,
      fish_caught: 15,
      fish_caught_pike: 3,
      exp: 12500,
      level: 8,
      starting_perk: 'Carpenter',
      affliction: 2,
      male: true,
    };
    const save = _dbRowToSave(row);
    assert.equal(save.daysSurvived, 12);
    assert.equal(save.timesBitten, 5);
    assert.equal(save.fishCaught, 15);
    assert.equal(save.fishCaughtPike, 3);
    assert.equal(save.exp, 12500);
    assert.equal(save.level, 8);
    assert.equal(save.startingPerk, 'Carpenter');
    assert.equal(save.affliction, 2);
    assert.equal(save.male, true);
  });
});

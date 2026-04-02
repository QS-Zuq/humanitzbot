/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-require-imports, @typescript-eslint/no-floating-promises */
/**
 * Tests for src/server/server-display.js — V35 INI display helpers.
 * Run: npm test
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const {
  ON_DEATH_LABELS,
  AI_EVENT_LABELS,
  DIFFICULTY_LABELS,
  SCARCITY_LABELS,
  VITAL_DRAIN_LABELS,
  formatTime,
  spawnLabel,
  difficultyLabel,
  difficultyBar,
  settingBool,
  settingLabel,
  settingMultiplier,
  settingDays,
  settingPermaDeath,
  progressBar,
  blockBar,
  weatherEmoji,
  seasonEmoji,
  timeEmoji,
  buildSettingsFields,
  buildLootScarcity,
} = require('../src/server/server-display');

const { modalTitle } = require('../src/modules/discord-utils');

describe('ON_DEATH_LABELS (V35)', () => {
  it('has exactly 4 entries', () => {
    assert.equal(ON_DEATH_LABELS.length, 4);
  });

  it('index 0 = "Lose Nothing"', () => {
    assert.equal(ON_DEATH_LABELS[0], 'Lose Nothing');
  });

  it('index 1 = "Backpack + Weapon"', () => {
    assert.equal(ON_DEATH_LABELS[1], 'Backpack + Weapon');
  });

  it('index 2 = "Pockets + Backpack"', () => {
    assert.equal(ON_DEATH_LABELS[2], 'Pockets + Backpack');
  });

  it('index 3 = "Everything"', () => {
    assert.equal(ON_DEATH_LABELS[3], 'Everything');
  });
});

describe('AI_EVENT_LABELS (V35)', () => {
  it('has exactly 5 entries', () => {
    assert.equal(AI_EVENT_LABELS.length, 5);
  });

  it('index 0 = "Off"', () => {
    assert.equal(AI_EVENT_LABELS[0], 'Off');
  });

  it('index 3 = "High"', () => {
    assert.equal(AI_EVENT_LABELS[3], 'High');
  });

  it('index 4 = "Insane"', () => {
    assert.equal(AI_EVENT_LABELS[4], 'Insane');
  });
});

describe('DIFFICULTY_LABELS', () => {
  it('has exactly 6 entries', () => {
    assert.equal(DIFFICULTY_LABELS.length, 6);
  });

  it('covers full range', () => {
    assert.deepEqual(DIFFICULTY_LABELS, ['Very Easy', 'Easy', 'Default', 'Hard', 'Very Hard', 'Nightmare']);
  });
});

describe('VITAL_DRAIN_LABELS', () => {
  it('has exactly 3 entries', () => {
    assert.equal(VITAL_DRAIN_LABELS.length, 3);
  });

  it('index 1 = "Normal"', () => {
    assert.equal(VITAL_DRAIN_LABELS[1], 'Normal');
  });
});

describe('SCARCITY_LABELS', () => {
  it('has exactly 5 entries', () => {
    assert.equal(SCARCITY_LABELS.length, 5);
  });

  it('covers Scarce → Abundant', () => {
    assert.equal(SCARCITY_LABELS[0], 'Scarce');
    assert.equal(SCARCITY_LABELS[4], 'Abundant');
  });
});

describe('settingBool', () => {
  it('returns null for null/undefined', () => {
    assert.equal(settingBool(null), null);
    assert.equal(settingBool(undefined), null);
  });

  it('"1" → "On"', () => {
    assert.equal(settingBool('1'), 'On');
  });

  it('"0" → "Off"', () => {
    assert.equal(settingBool('0'), 'Off');
  });

  it('"true" → "On" (V35 boolean format)', () => {
    assert.equal(settingBool('true'), 'On');
  });

  it('"false" → "Off" (V35 boolean format)', () => {
    assert.equal(settingBool('false'), 'Off');
  });

  it('"True" (capitalized) → "On"', () => {
    assert.equal(settingBool('True'), 'On');
  });

  it('"FALSE" (uppercased) → "Off"', () => {
    assert.equal(settingBool('FALSE'), 'Off');
  });

  it('random string → "Off"', () => {
    assert.equal(settingBool('foo'), 'Off');
  });
});

describe('settingLabel', () => {
  it('returns null for null/undefined', () => {
    assert.equal(settingLabel(null, ['A', 'B']), null);
    assert.equal(settingLabel(undefined, ['A', 'B']), null);
  });

  it('maps index to label', () => {
    assert.equal(settingLabel('0', ['Off', 'On']), 'Off');
    assert.equal(settingLabel('1', ['Off', 'On']), 'On');
  });

  it('returns raw value for out-of-range index', () => {
    assert.equal(settingLabel('5', ['A', 'B']), '5');
  });

  it('returns string for NaN input', () => {
    assert.equal(settingLabel('abc', ['A', 'B']), 'abc');
  });

  it('rounds float to nearest index', () => {
    assert.equal(settingLabel('1.7', ['A', 'B', 'C']), 'C');
    assert.equal(settingLabel('0.4', ['A', 'B', 'C']), 'A');
  });
});

describe('settingMultiplier', () => {
  it('returns null for null/undefined', () => {
    assert.equal(settingMultiplier(null), null);
    assert.equal(settingMultiplier(undefined), null);
  });

  it('0 → "Off"', () => {
    assert.equal(settingMultiplier('0'), 'Off');
    assert.equal(settingMultiplier(0), 'Off');
  });

  it('1 → "Default"', () => {
    assert.equal(settingMultiplier('1'), 'Default');
    assert.equal(settingMultiplier(1), 'Default');
  });

  it('0.5 → "0.5x"', () => {
    assert.equal(settingMultiplier('0.5'), '0.5x');
    assert.equal(settingMultiplier(0.5), '0.5x');
  });

  it('2 → "2x"', () => {
    assert.equal(settingMultiplier('2'), '2x');
    assert.equal(settingMultiplier(2), '2x');
  });

  it('2.5 → "2.5x"', () => {
    assert.equal(settingMultiplier(2.5), '2.5x');
  });

  it('NaN string → string passthrough', () => {
    assert.equal(settingMultiplier('abc'), 'abc');
  });
});

describe('settingDays', () => {
  it('returns null for null/undefined', () => {
    assert.equal(settingDays(null), null);
    assert.equal(settingDays(undefined), null);
  });

  it('0 → "Off"', () => {
    assert.equal(settingDays('0'), 'Off');
    assert.equal(settingDays(0), 'Off');
  });

  it('7 → "7 days"', () => {
    assert.equal(settingDays('7'), '7 days');
    assert.equal(settingDays(7), '7 days');
  });

  it('14 → "14 days"', () => {
    assert.equal(settingDays(14), '14 days');
  });

  it('custom unit: 12 hours', () => {
    assert.equal(settingDays(12, 'hours'), '12 hours');
  });

  it('NaN string → string passthrough', () => {
    assert.equal(settingDays('abc'), 'abc');
  });
});

describe('settingPermaDeath', () => {
  it('returns null for null/undefined', () => {
    assert.equal(settingPermaDeath(null), null);
    assert.equal(settingPermaDeath(undefined), null);
  });

  it('"true" → "On"', () => {
    assert.equal(settingPermaDeath('true'), 'On');
  });

  it('"false" → "Off"', () => {
    assert.equal(settingPermaDeath('false'), 'Off');
  });

  it('"True" (capitalized) → "On"', () => {
    assert.equal(settingPermaDeath('True'), 'On');
  });

  it('"FALSE" (uppercased) → "Off"', () => {
    assert.equal(settingPermaDeath('FALSE'), 'Off');
  });

  it('0 → "Off" (legacy enum)', () => {
    assert.equal(settingPermaDeath('0'), 'Off');
    assert.equal(settingPermaDeath(0), 'Off');
  });

  it('1 → "Individual" (legacy enum)', () => {
    assert.equal(settingPermaDeath('1'), 'Individual');
    assert.equal(settingPermaDeath(1), 'Individual');
  });

  it('2 → "All" (legacy enum)', () => {
    assert.equal(settingPermaDeath('2'), 'All');
    assert.equal(settingPermaDeath(2), 'All');
  });
});

describe('spawnLabel', () => {
  it('returns null for null/undefined', () => {
    assert.equal(spawnLabel(null), null);
    assert.equal(spawnLabel(undefined), null);
  });

  it('0 → "None"', () => {
    assert.equal(spawnLabel('0'), 'None');
    assert.equal(spawnLabel(0), 'None');
  });

  it('1 → "x1 (Default)"', () => {
    assert.equal(spawnLabel('1'), 'x1 (Default)');
    assert.equal(spawnLabel(1), 'x1 (Default)');
  });

  it('0.5 → "x0.5"', () => {
    assert.equal(spawnLabel('0.5'), 'x0.5');
    assert.equal(spawnLabel(0.5), 'x0.5');
  });

  it('2.5 → "x2.5"', () => {
    assert.equal(spawnLabel('2.5'), 'x2.5');
    assert.equal(spawnLabel(2.5), 'x2.5');
  });

  it('3 → "x3"', () => {
    assert.equal(spawnLabel('3'), 'x3');
    assert.equal(spawnLabel(3), 'x3');
  });

  it('NaN string → string passthrough', () => {
    assert.equal(spawnLabel('abc'), 'abc');
  });
});

describe('formatTime', () => {
  it('returns null for null/undefined', () => {
    assert.equal(formatTime(null), null);
    assert.equal(formatTime(undefined), null);
  });

  it('zero-pads single-digit minutes', () => {
    assert.equal(formatTime('8:5'), '8:05');
  });

  it('keeps already-padded time', () => {
    assert.equal(formatTime('14:30'), '14:30');
  });

  it('handles single-digit hour', () => {
    assert.equal(formatTime('2:2'), '2:02');
  });

  it('passes through non-matching strings', () => {
    assert.equal(formatTime('not a time'), 'not a time');
  });
});

describe('difficultyLabel', () => {
  it('returns null for null/undefined', () => {
    assert.equal(difficultyLabel(null), null);
    assert.equal(difficultyLabel(undefined), null);
  });

  it('0 → "Very Easy"', () => {
    assert.equal(difficultyLabel('0'), 'Very Easy');
    assert.equal(difficultyLabel(0), 'Very Easy');
  });

  it('2 → "Default"', () => {
    assert.equal(difficultyLabel('2'), 'Default');
  });

  it('5 → "Nightmare"', () => {
    assert.equal(difficultyLabel('5'), 'Nightmare');
  });

  it('out-of-range → raw string', () => {
    assert.equal(difficultyLabel('99'), '99');
  });

  it('NaN → string passthrough', () => {
    assert.equal(difficultyLabel('abc'), 'abc');
  });
});

describe('difficultyBar', () => {
  it('returns null for null/undefined', () => {
    assert.equal(difficultyBar(null), null);
    assert.equal(difficultyBar(undefined), null);
  });

  it('includes label text', () => {
    const bar = difficultyBar('2');
    assert.ok(bar.includes('Default'));
  });

  it('uses ▓ and ░ characters', () => {
    const bar = difficultyBar('0');
    assert.ok(bar.includes('▓'));
    assert.ok(bar.includes('░'));
  });
});

describe('progressBar', () => {
  it('0 ratio → all empty', () => {
    const bar = progressBar(0, 5);
    assert.equal(bar, '░░░░░');
  });

  it('1 ratio → all filled', () => {
    const bar = progressBar(1, 5);
    assert.equal(bar, '▓▓▓▓▓');
  });

  it('0.5 ratio → half filled', () => {
    const bar = progressBar(0.5, 4);
    assert.equal(bar, '▓▓░░');
  });

  it('clamps above 1', () => {
    const bar = progressBar(1.5, 3);
    assert.equal(bar, '▓▓▓');
  });

  it('clamps below 0', () => {
    const bar = progressBar(-1, 3);
    assert.equal(bar, '░░░');
  });
});

describe('blockBar', () => {
  it('uses █ and ░ characters', () => {
    const bar = blockBar(0.5, 4);
    assert.equal(bar, '██░░');
  });
});

describe('weatherEmoji', () => {
  it('returns empty string for null', () => {
    assert.equal(weatherEmoji(null), '');
  });

  it('thunder → ⛈️', () => {
    assert.ok(weatherEmoji('Thunderstorm').includes('⛈️'));
  });

  it('rain → rain emoji', () => {
    assert.ok(weatherEmoji('Light Rain').length > 0);
  });

  it('clear/sunny → ☀️', () => {
    assert.ok(weatherEmoji('Clear Sky').includes('☀️'));
  });
});

describe('seasonEmoji', () => {
  it('returns empty string for null', () => {
    assert.equal(seasonEmoji(null), '');
  });

  it('Summer → ☀️', () => {
    assert.ok(seasonEmoji('Summer').includes('☀️'));
  });

  it('Winter → ❄️', () => {
    assert.ok(seasonEmoji('Winter').includes('❄️'));
  });
});

describe('timeEmoji', () => {
  it('returns empty string for null', () => {
    assert.equal(timeEmoji(null), '');
  });

  it('midday → ☀️', () => {
    assert.ok(timeEmoji('12:00').includes('☀️'));
  });

  it('midnight → 🌙', () => {
    assert.ok(timeEmoji('0:00').includes('🌙'));
  });

  it('dawn → 🌅', () => {
    assert.ok(timeEmoji('6:30').includes('🌅'));
  });
});

describe('buildSettingsFields', () => {
  it('returns array', () => {
    const fields = buildSettingsFields({});
    assert.ok(Array.isArray(fields));
  });

  it('builds General section with V35 settings', () => {
    const s = {
      PVP: 'true',
      MaxPlayers: '32',
      OnDeath: '0',
      PermaDeath: 'false',
      VitalDrain: '1',
    };
    const fields = buildSettingsFields(s);
    const general = fields.find((f: { name: string }) => f.name.includes('General'));
    assert.ok(general, 'General section should exist');
    assert.ok(general.value.includes('On'), 'PVP=true → On');
    assert.ok(general.value.includes('Lose Nothing'), 'OnDeath=0 → Lose Nothing');
    assert.ok(general.value.includes('Off'), 'PermaDeath=false → Off');
  });

  it('uses settingMultiplier for FoodDecay', () => {
    const s = { FoodDecay: '0.5' };
    const fields = buildSettingsFields(s);
    const items = fields.find((f: { name: string }) => f.name.includes('Items'));
    assert.ok(items, 'Items section should exist');
    assert.ok(items.value.includes('0.5x'), 'FoodDecay=0.5 → 0.5x');
  });

  it('FoodDecay=0 → Off', () => {
    const s = { FoodDecay: '0' };
    const fields = buildSettingsFields(s);
    const items = fields.find((f: { name: string }) => f.name.includes('Items'));
    assert.ok(items);
    assert.ok(items.value.includes('Off'), 'FoodDecay=0 → Off');
  });

  it('uses settingDays for BuildingDecay', () => {
    const s = { BuildingDecay: '14' };
    const fields = buildSettingsFields(s, { showExtendedSettings: true });
    const building = fields.find((f: { name: string }) => f.name.includes('Building'));
    assert.ok(building, 'Building section should exist');
    assert.ok(building.value.includes('14 days'), 'BuildingDecay=14 → 14 days');
  });

  it('BuildingDecay=0 → Off', () => {
    const s = { BuildingDecay: '0' };
    const fields = buildSettingsFields(s, { showExtendedSettings: true });
    const building = fields.find((f: { name: string }) => f.name.includes('Building'));
    assert.ok(building);
    assert.ok(building.value.includes('Off'), 'BuildingDecay=0 → Off');
  });

  it('uses settingMultiplier for BuildingHealth', () => {
    const s = { BuildingHealth: '2' };
    const fields = buildSettingsFields(s, { showExtendedSettings: true });
    const building = fields.find((f: { name: string }) => f.name.includes('Building'));
    assert.ok(building);
    assert.ok(building.value.includes('2x'), 'BuildingHealth=2 → 2x');
  });

  it('uses AI_EVENT_LABELS for AIEvent (5 levels)', () => {
    const s = { AIEvent: '4' };
    const fields = buildSettingsFields(s, { showExtendedSettings: true });
    const bandits = fields.find((f: { name: string }) => f.name.includes('Bandits'));
    assert.ok(bandits, 'Bandits section should exist');
    assert.ok(bandits.value.includes('Insane'), 'AIEvent=4 → Insane');
  });

  it('AIEvent=3 → High', () => {
    const s = { AIEvent: '3' };
    const fields = buildSettingsFields(s, { showExtendedSettings: true });
    const bandits = fields.find((f: { name: string }) => f.name.includes('Bandits'));
    assert.ok(bandits);
    assert.ok(bandits.value.includes('High'), 'AIEvent=3 → High');
  });

  it('uses spawnLabel for ZombieAmountMulti (float multiplier)', () => {
    const s = { ZombieAmountMulti: '1.5' };
    const fields = buildSettingsFields(s);
    const zombies = fields.find((f: { name: string }) => f.name.includes('Zombies'));
    assert.ok(zombies, 'Zombies section should exist');
    assert.ok(zombies.value.includes('x1.5'), 'ZombieAmountMulti=1.5 → x1.5');
  });

  it('respects cfg toggle to hide sections', () => {
    const s = { PVP: 'true', ZombieAmountMulti: '1' };
    const fields = buildSettingsFields(s, { showSettingsGeneral: false });
    const general = fields.find((f: { name: string }) => f.name.includes('General'));
    assert.equal(general, undefined, 'General section should be hidden');
  });
});

describe('buildLootScarcity', () => {
  it('returns null for empty settings', () => {
    assert.equal(buildLootScarcity({}), null);
  });

  it('formats per-category keys', () => {
    const s = { RarityFood: '2', RarityMelee: '3' };
    const result = buildLootScarcity(s);
    assert.ok(result.includes('Default'), 'RarityFood=2 → Default');
    assert.ok(result.includes('Plentiful'), 'RarityMelee=3 → Plentiful');
  });

  it('falls back to LootRarity when per-category missing', () => {
    const s = { LootRarity: '1' };
    const result = buildLootScarcity(s);
    assert.ok(result, 'Should produce output from LootRarity fallback');
    // LootRarity=1 → "Low" for all 8 categories
    const lowCount = (result.match(/Low/g) || []).length;
    assert.equal(lowCount, 8, 'All 8 categories should show "Low"');
  });

  it('per-category overrides LootRarity', () => {
    const s = { LootRarity: '1', RarityFood: '4' };
    const result = buildLootScarcity(s);
    assert.ok(result.includes('Abundant'), 'RarityFood=4 → Abundant (overrides LootRarity)');
  });
});

describe('modalTitle', () => {
  it('returns full title when under 45 chars', () => {
    const result = modalTitle('Edit: ', 'General', ' (🔄)');
    assert.equal(result, 'Edit: General (🔄)');
  });

  it('truncates long names to stay within 45 chars', () => {
    const result = modalTitle('Edit: ', 'Building & Territory & Extra Long Name That Will Overflow', ' (🔄)');
    assert.ok(result.length <= 45, `Expected ≤45 chars, got ${result.length}: "${result}"`);
    assert.ok(result.includes('…'), 'Should include ellipsis');
  });

  it('exactly 45 chars is not truncated', () => {
    const prefix = 'A: '; // 3 chars
    const suffix = ' END'; // 4 chars
    const maxName = 45 - 3 - 4; // 38 chars
    const name = 'X'.repeat(maxName);
    const result = modalTitle(prefix, name, suffix);
    assert.equal(result.length, 45);
    assert.ok(!result.includes('…'), 'Exact fit should not truncate');
  });

  it('handles emoji/surrogate pairs without splitting', () => {
    const prefix = 'A: ';
    const suffix = '';
    const maxName = 45 - 3;
    const name = '🔄'.repeat(maxName); // plenty of emoji
    const result = modalTitle(prefix, name, suffix);
    const charCount = Array.from(result).length;
    assert.ok(charCount <= 45, `Expected ≤45 characters, got ${charCount}`);
    assert.ok(!result.includes('\uFFFD'), 'No replacement characters');
  });

  it('handles empty name', () => {
    const result = modalTitle('Edit: ', '', '');
    assert.equal(result, 'Edit: ');
  });

  it('handles edge case where prefix+suffix exceed 45', () => {
    const prefix = 'A'.repeat(25);
    const suffix = 'B'.repeat(25);
    const result = modalTitle(prefix, 'Hello', suffix);
    assert.ok(result.length <= 45, `Expected ≤45 chars, got ${result.length}`);
  });

  it('"Building & Territory" with restart tag fits in 45 chars', () => {
    const result = modalTitle('Edit: ', 'Building & Territory', ' (🔄 Server Restart)');
    assert.ok(result.length <= 45, `"Building & Territory" modal should fit: ${result.length} chars`);
  });

  it('"Companions & Animals" with restart tag fits in 45 chars', () => {
    const result = modalTitle('Edit: ', 'Companions & Animals', ' (🔄 Server Restart)');
    assert.ok(result.length <= 45, `"Companions & Animals" modal should fit: ${result.length} chars`);
  });
});

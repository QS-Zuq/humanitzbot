/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-require-imports, @typescript-eslint/no-floating-promises, @typescript-eslint/no-non-null-assertion, @typescript-eslint/restrict-template-expressions, @typescript-eslint/no-unnecessary-type-assertion */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const gameData = require('../src/parsers/game-data');

const { PERK_MAP, PERK_INDEX_MAP, CLAN_RANK_MAP, SEASON_MAP } = require('../src/parsers/save-parser');
const { ENUM_MAPS } = gameData;

const { _projectEnum } = require('../src/parsers/game-data-extract')._test;

describe('AFFLICTION_MAP', () => {
  it('is an array', () => {
    assert.ok(Array.isArray(gameData.AFFLICTION_MAP));
  });

  it('has at least 5 entries', () => {
    assert.ok(gameData.AFFLICTION_MAP.length >= 5);
  });

  it('index 0 is None or similar', () => {
    assert.ok(typeof gameData.AFFLICTION_MAP[0] === 'string');
  });

  it('all entries are strings', () => {
    for (const entry of gameData.AFFLICTION_MAP) {
      assert.ok(typeof entry === 'string', `Expected string, got ${typeof entry}: ${entry}`);
    }
  });
});

describe('PROFESSION_DETAILS', () => {
  it('is a non-empty object', () => {
    assert.ok(typeof gameData.PROFESSION_DETAILS === 'object');
    assert.ok(Object.keys(gameData.PROFESSION_DETAILS).length > 0);
  });

  it('each entry has perk and description', () => {
    for (const [key, detail] of Object.entries(gameData.PROFESSION_DETAILS)) {
      assert.ok(typeof key === 'string' && key.length > 0, `empty key`);
      assert.ok((detail as any).perk, `${key} missing perk`);
      assert.ok((detail as any).description, `${key} missing description`);
    }
  });
});

describe('CHALLENGES', () => {
  it('is an array with entries', () => {
    assert.ok(Array.isArray(gameData.CHALLENGES));
    assert.ok(gameData.CHALLENGES.length > 0);
  });

  it('each challenge has id and name', () => {
    for (const challenge of gameData.CHALLENGES) {
      assert.ok((challenge as any).id, 'Missing challenge id');
      assert.ok((challenge as any).name, 'Missing challenge name');
    }
  });
});

describe('SKILL_EFFECTS', () => {
  it('is a non-empty object', () => {
    assert.ok(typeof gameData.SKILL_EFFECTS === 'object');
    assert.ok(Object.keys(gameData.SKILL_EFFECTS).length > 0);
  });
});

describe('SERVER_SETTING_DESCRIPTIONS', () => {
  it('is a non-empty object', () => {
    assert.ok(typeof gameData.SERVER_SETTING_DESCRIPTIONS === 'object');
    assert.ok(Object.keys(gameData.SERVER_SETTING_DESCRIPTIONS).length > 0);
  });

  it('each value is a string', () => {
    for (const [key, val] of Object.entries(gameData.SERVER_SETTING_DESCRIPTIONS)) {
      assert.ok(typeof val === 'string', `${key} should be a string`);
    }
  });
});

describe('LOADING_TIPS', () => {
  it('is an array of strings', () => {
    assert.ok(Array.isArray(gameData.LOADING_TIPS));
    assert.ok(gameData.LOADING_TIPS.length > 0);
    for (const tip of gameData.LOADING_TIPS) {
      assert.ok(typeof tip === 'string');
    }
  });
});

// ─── New maps from DT files ────────────────────────────────────────────────

describe('ITEM_DATABASE', () => {
  it('has 718 items', () => {
    assert.equal(Object.keys(gameData.ITEM_DATABASE).length, 718);
  });

  it('each item has name and type', () => {
    for (const [id, item] of Object.entries(gameData.ITEM_DATABASE)) {
      assert.ok((item as any).name, `${id} missing name`);
      assert.ok(typeof (item as any).type === 'string', `${id} missing type`);
    }
  });

  it('Desert Hawk is a Pistol', () => {
    assert.equal(gameData.ITEM_DATABASE['DesertEagle'].name, 'Desert Hawk');
    assert.equal(gameData.ITEM_DATABASE['DesertEagle'].type, 'Pistol');
  });

  it('AK47 is Ranged', () => {
    assert.equal(gameData.ITEM_DATABASE['AK47'].type, 'Ranged');
  });

  it('Bandage is Medical', () => {
    assert.equal(gameData.ITEM_DATABASE['Bandage'].type, 'Medical');
  });
});

describe('ITEM_NAMES', () => {
  it('has same count as ITEM_DATABASE', () => {
    assert.equal(Object.keys(gameData.ITEM_NAMES).length, Object.keys(gameData.ITEM_DATABASE).length);
  });

  it('maps row name to display name', () => {
    assert.equal(gameData.ITEM_NAMES['DesertEagle'], 'Desert Hawk');
    assert.equal(gameData.ITEM_NAMES['AK47'], 'AK47');
  });
});

describe('BUILDING_NAMES', () => {
  it('has 122 buildings', () => {
    assert.equal(Object.keys(gameData.BUILDING_NAMES).length, 122);
  });

  it('each building name is a string', () => {
    for (const [id, name] of Object.entries(gameData.BUILDING_NAMES)) {
      assert.ok(typeof name === 'string' && (name as string).length > 0, `${id} missing name`);
    }
  });

  it('WaterCatcher is Rain Collector', () => {
    assert.equal(gameData.BUILDING_NAMES['WaterCatcher'], 'Rain Collector');
  });
});

describe('VEHICLE_NAMES', () => {
  it('has 27 vehicles', () => {
    assert.equal(Object.keys(gameData.VEHICLE_NAMES).length, 27);
  });

  it('each value is a string', () => {
    for (const [id, name] of Object.entries(gameData.VEHICLE_NAMES)) {
      assert.ok(typeof name === 'string' && (name as string).length > 0, `${id} should have a name`);
    }
  });
});

describe('CRAFTING_RECIPES', () => {
  it('has 154 recipes', () => {
    assert.equal(Object.keys(gameData.CRAFTING_RECIPES).length, 154);
  });

  it('each recipe has name and station', () => {
    for (const [id, r] of Object.entries(gameData.CRAFTING_RECIPES)) {
      assert.ok((r as any).name, `${id} missing name`);
      assert.ok(typeof (r as any).station === 'string', `${id} missing station`);
      assert.ok(Array.isArray((r as any).ingredients), `${id} ingredients should be array`);
    }
  });
});

describe('LORE_ENTRIES', () => {
  it('has 12 entries', () => {
    assert.equal(Object.keys(gameData.LORE_ENTRIES).length, 12);
  });

  it('each entry has title', () => {
    for (const [id, l] of Object.entries(gameData.LORE_ENTRIES)) {
      assert.ok((l as any).title, `${id} missing title`);
    }
  });
});

describe('QUEST_DATA', () => {
  it('has 18 quests', () => {
    assert.equal(Object.keys(gameData.QUEST_DATA).length, 18);
  });

  it('each quest has name', () => {
    for (const [id, q] of Object.entries(gameData.QUEST_DATA)) {
      assert.ok((q as any).name, `${id} missing name`);
    }
  });
});

describe('SPAWN_LOCATIONS', () => {
  it('has 10 locations', () => {
    assert.equal(Object.keys(gameData.SPAWN_LOCATIONS).length, 10);
  });
});

describe('AMMO_DAMAGE', () => {
  it('has 8 ammo types', () => {
    assert.equal(Object.keys(gameData.AMMO_DAMAGE).length, 8);
  });

  it('each has damage and headshotMultiplier', () => {
    for (const [id, a] of Object.entries(gameData.AMMO_DAMAGE)) {
      assert.ok(typeof (a as any).damage === 'number', `${id} missing damage`);
      assert.ok(typeof (a as any).headshotMultiplier === 'number', `${id} missing headshotMultiplier`);
    }
  });
});

describe('SKILL_DETAILS', () => {
  it('has 35 skills', () => {
    assert.equal(Object.keys(gameData.SKILL_DETAILS).length, 35);
  });

  it('each skill has name and category', () => {
    for (const [id, s] of Object.entries(gameData.SKILL_DETAILS)) {
      assert.ok((s as any).name, `${id} missing name`);
      assert.ok(typeof (s as any).category === 'string', `${id} missing category`);
    }
  });
});

describe('REPAIR_RECIPES', () => {
  it('has 57 entries', () => {
    assert.equal(Object.keys(gameData.REPAIR_RECIPES).length, 57);
  });

  it('each value is an object with id', () => {
    for (const [id, r] of Object.entries(gameData.REPAIR_RECIPES)) {
      assert.ok(r && typeof r === 'object', `${id} should be an object`);
      assert.ok((r as any).id, `${id} missing id`);
    }
  });
});

describe('CROP_DATA', () => {
  it('has 6 crops', () => {
    assert.equal(Object.keys(gameData.CROP_DATA).length, 6);
  });

  it('each crop has growthTimeDays', () => {
    for (const [id, c] of Object.entries(gameData.CROP_DATA)) {
      assert.ok(typeof (c as any).growthTimeDays === 'number', `${id} missing growthTimeDays`);
    }
  });
});

describe('AFFLICTION_DETAILS', () => {
  it('has 20 afflictions', () => {
    assert.equal(Object.keys(gameData.AFFLICTION_DETAILS).length, 20);
  });

  it('each has name and value', () => {
    for (const [id, a] of Object.entries(gameData.AFFLICTION_DETAILS)) {
      assert.ok((a as any).name, `${id} missing name`);
      assert.ok(typeof (a as any).value === 'number', `${id} missing value`);
    }
  });
});

describe('Enum lookup maps', () => {
  it('CRAFTING_STATION_NAMES is populated', () => {
    assert.ok(Object.keys(gameData.CRAFTING_STATION_NAMES).length > 0);
  });

  it('ITEM_TYPE_NAMES is populated', () => {
    assert.ok(Object.keys(gameData.ITEM_TYPE_NAMES).length > 0);
  });

  it('BUILD_CATEGORY_NAMES is populated', () => {
    assert.ok(Object.keys(gameData.BUILD_CATEGORY_NAMES).length > 0);
  });
});

// ── Enum map consistency (save-parser ↔ ENUM_MAPS) ────────────────────────────

describe('Enum map consistency (save-parser ↔ ENUM_MAPS)', () => {
  it('save-parser exports are non-empty (guard against silent load failure)', () => {
    assert.ok(Object.keys(PERK_MAP).length > 0, 'PERK_MAP should not be empty');
    assert.ok(Object.keys(CLAN_RANK_MAP).length > 0, 'CLAN_RANK_MAP should not be empty');
    assert.ok(Object.keys(ENUM_MAPS.Enum_Professions).length > 0, 'ENUM_MAPS.Enum_Professions should not be empty');
    assert.ok(Object.keys(ENUM_MAPS.E_ClanRank).length > 0, 'ENUM_MAPS.E_ClanRank should not be empty');
  });

  it('PERK_MAP has exactly 12 active professions', () => {
    assert.equal(Object.keys(PERK_MAP).length, 12);
  });

  it('ENUM_MAPS.Enum_Professions has exactly 17 entries (12 active + 5 Reserved)', () => {
    assert.equal(Object.keys(ENUM_MAPS.Enum_Professions).length, 17);
    const active = Object.values(ENUM_MAPS.Enum_Professions).filter((v) => v !== 'Reserved');
    assert.equal(active.length, 12);
  });

  it('CLAN_RANK_MAP has exactly 5 ranks', () => {
    assert.equal(Object.keys(CLAN_RANK_MAP).length, 5);
  });

  it('ENUM_MAPS.Enum_Professions matches PERK_MAP for all active professions', () => {
    for (const [key, value] of Object.entries(PERK_MAP)) {
      const suffix = (key as string).split('::')[1]!;
      assert.equal(
        ENUM_MAPS.Enum_Professions[suffix],
        value,
        `Mismatch for ${suffix}: PERK_MAP='${value}', ENUM_MAPS='${ENUM_MAPS.Enum_Professions[suffix]}'`,
      );
    }
  });

  it('ENUM_MAPS.Enum_Professions has no active entries missing from PERK_MAP', () => {
    for (const [key, value] of Object.entries(ENUM_MAPS.Enum_Professions)) {
      if (value === 'Reserved') continue;
      assert.ok(
        PERK_MAP[`Enum_Professions::${key}`],
        `ENUM_MAPS has '${key}' → '${value}' but PERK_MAP has no matching entry`,
      );
    }
  });

  it('ENUM_MAPS.E_ClanRank matches CLAN_RANK_MAP for all ranks', () => {
    for (const [key, value] of Object.entries(CLAN_RANK_MAP)) {
      const suffix = (key as string).split('::')[1]!;
      assert.equal(
        ENUM_MAPS.E_ClanRank[suffix],
        value,
        `Mismatch for ${suffix}: CLAN_RANK_MAP='${value}', ENUM_MAPS='${ENUM_MAPS.E_ClanRank[suffix]}'`,
      );
    }
  });

  it('ENUM_MAPS.E_ClanRank has no entries missing from CLAN_RANK_MAP', () => {
    for (const [key, value] of Object.entries(ENUM_MAPS.E_ClanRank)) {
      assert.ok(
        CLAN_RANK_MAP[`E_ClanRank::${key}`],
        `ENUM_MAPS has '${key}' → '${value}' but CLAN_RANK_MAP has no matching entry`,
      );
    }
  });

  it('PERK_INDEX_MAP is consistent with PERK_MAP', () => {
    for (const [key, value] of Object.entries(PERK_MAP)) {
      const idx = parseInt((key as string).split('NewEnumerator')[1]!, 10);
      assert.equal(PERK_INDEX_MAP[idx], value, `PERK_INDEX_MAP[${idx}] should be '${value}'`);
    }
    assert.equal(Object.keys(PERK_INDEX_MAP).length, 12, 'PERK_INDEX_MAP should have 12 entries');
  });

  it('ENUM_MAPS.Enum_Professions Reserved slots are only for unused indices', () => {
    for (const [key, value] of Object.entries(ENUM_MAPS.Enum_Professions)) {
      if (value === 'Reserved') {
        assert.ok(!PERK_MAP[`Enum_Professions::${key}`], `${key} marked Reserved in ENUM_MAPS but exists in PERK_MAP`);
      }
    }
  });

  it('SEASON_MAP is intentionally absent from ENUM_MAPS', () => {
    assert.ok(!('UDS_Season' in ENUM_MAPS), 'UDS_Season should not be in ENUM_MAPS');
    assert.equal(Object.keys(SEASON_MAP).length, 4, 'SEASON_MAP should have 4 seasons');
  });
});

// ── _projectEnum unit tests ────────────────────────────────────────────────────

describe('_projectEnum', () => {
  it('strips the enum prefix from keys', () => {
    const result = _projectEnum({ 'Foo::NewEnumerator0': 'Bar' }, []);
    assert.equal(result['NewEnumerator0'], 'Bar');
    assert.equal(Object.keys(result).length, 1);
  });

  it('returns empty object for empty input', () => {
    assert.deepEqual(_projectEnum({}, []), {});
  });

  it('fills reserved slots with "Reserved"', () => {
    const result = _projectEnum({}, [4, 5]);
    assert.equal(result['NewEnumerator4'], 'Reserved');
    assert.equal(result['NewEnumerator5'], 'Reserved');
    assert.equal(Object.keys(result).length, 2);
  });

  it('does not overwrite an existing key with Reserved', () => {
    const result = _projectEnum({ 'Foo::NewEnumerator4': 'Active' }, [4]);
    assert.equal(result['NewEnumerator4'], 'Active');
  });

  it('ignores keys without :: separator', () => {
    const result = _projectEnum({ NoSeparator: 'Value', 'Has::Sep': 'OK' }, []);
    assert.equal(Object.keys(result).length, 1);
    assert.equal(result['Sep'], 'OK');
  });
});

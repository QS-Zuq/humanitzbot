'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const HumanitZDB = require('../src/db/database');

// ── Test DB setup ────────────────────────────────────────────────────────────

let db;

function seedTestData() {
  // Insert some players for testing
  db.db.exec(`
    INSERT OR REPLACE INTO players (steam_id, name, lifetime_kills, lifetime_headshots, fish_caught, times_bitten, log_builds, log_deaths, log_loots, log_pvp_kills, log_pvp_deaths, log_killed_by, playtime_seconds, days_survived, session_count, last_seen)
    VALUES
      ('11111111111111111', 'ZombieSlayer',   5000, 1200, 42, 8,  150, 3,  200, 2, 1, 'Zombie', 360000, 45, 50, datetime('now')),
      ('22222222222222222', 'FishMaster',     200,  50,   95, 3,  20,  8,  50,  0, 0, 'Hunger',  72000, 12, 20, datetime('now')),
      ('33333333333333333', 'BuilderBob',     100,  20,   5,  1,  500, 2,  30,  0, 0, 'Fall',    36000, 30, 15, datetime('now')),
      ('44444444444444444', 'PvPKing',        800,  400,  0,  25, 10,  25, 100, 15, 5, 'Player', 180000, 7,  40, datetime('now')),
      ('55555555555555555', 'Newbie',         5,    1,    0,  0,  2,   0,  5,   0, 0, NULL,       3600, 1,  2,  datetime('now'))
  `);

  // World state
  db.db.exec(`
    INSERT OR REPLACE INTO world_state (key, value) VALUES ('day', '42');
    INSERT OR REPLACE INTO world_state (key, value) VALUES ('season', 'Summer');
  `);

  // Structures
  db.db.exec(`
    INSERT INTO structures (actor_class, display_name, pos_x, pos_y, pos_z) VALUES
      ('BP_Wall_C', 'Wall', 100, 200, 0),
      ('BP_Floor_C', 'Floor', 100, 201, 0),
      ('BP_Door_C', 'Door', 101, 200, 0)
  `);

  // Vehicles
  db.db.exec(`
    INSERT INTO vehicles (class, pos_x, pos_y, pos_z, fuel) VALUES
      ('BP_Sedan_C', 500, 500, 0, 50.0),
      ('BP_Truck_C', 600, 600, 0, 0.0)
  `);
}

// ── did-you-know tests ───────────────────────────────────────────────────────

describe('howyagarn/did-you-know', () => {
  before(() => {
    db = new HumanitZDB({ memory: true });
    db.init();
    seedTestData();
  });

  after(() => {
    db.close();
  });

  const { getRandomFact, getAllFacts } = require('../src/modules/howyagarn/did-you-know');

  it('returns null when no DB', () => {
    assert.equal(getRandomFact(null), null);
  });

  it('getAllFacts returns multiple facts from seeded data', () => {
    const facts = getAllFacts(db);
    assert.ok(facts.length >= 5, `Expected at least 5 facts, got ${facts.length}`);
    for (const f of facts) {
      assert.ok(f.text, 'Each fact must have text');
      assert.ok(f.emoji, 'Each fact must have an emoji');
    }
  });

  it('getRandomFact returns a fact with text and emoji', () => {
    const fact = getRandomFact(db);
    assert.ok(fact, 'Should return a fact');
    assert.ok(fact.text.length > 0);
    assert.ok(fact.emoji.length > 0);
  });

  it('facts reference real player names', () => {
    const facts = getAllFacts(db);
    const allText = facts.map(f => f.text).join(' ');
    // At least one of our test players should appear
    const hasPlayer = ['ZombieSlayer', 'FishMaster', 'BuilderBob', 'PvPKing'].some(n => allText.includes(n));
    assert.ok(hasPlayer, 'Facts should reference actual player names');
  });

  it('vehicle fact mentions fuel status', () => {
    const facts = getAllFacts(db);
    const vehicleFact = facts.find(f => f.emoji === '🚗');
    assert.ok(vehicleFact, 'Should have a vehicle fact');
    assert.ok(vehicleFact.text.includes('2 vehicles'), `Vehicle fact should mention count: ${vehicleFact.text}`);
    assert.ok(vehicleFact.text.includes('no fuel'), `Vehicle fact should mention fuel: ${vehicleFact.text}`);
  });

  it('world day fact shows current day', () => {
    const facts = getAllFacts(db);
    const dayFact = facts.find(f => f.emoji === '📅');
    assert.ok(dayFact, 'Should have a world day fact');
    assert.ok(dayFact.text.includes('42'), 'Should reference day 42');
  });
});

// ── player-cards tests ───────────────────────────────────────────────────────

describe('howyagarn/player-cards', () => {
  before(() => {
    db = new HumanitZDB({ memory: true });
    db.init();
    seedTestData();
  });

  after(() => {
    db.close();
  });

  const { buildPlayerCard, buildPlayerCardByName, TIERS, TRAITS } = require('../src/modules/howyagarn/player-cards');

  it('returns null for unknown steam ID', () => {
    assert.equal(buildPlayerCard(db, '99999999999999999'), null);
  });

  it('returns null when no DB', () => {
    assert.equal(buildPlayerCard(null, '11111111111111111'), null);
  });

  it('builds a card for ZombieSlayer', () => {
    const embed = buildPlayerCard(db, '11111111111111111');
    assert.ok(embed, 'Should build an embed');
    assert.ok(embed.data.title.includes('ZombieSlayer'));
    assert.ok(embed.data.description.includes('5,000'), 'Should show kill count');
  });

  it('assigns traits based on stats', () => {
    const embed = buildPlayerCard(db, '11111111111111111');
    assert.ok(embed.data.description.includes('Zombie Slayer'), 'ZombieSlayer should get Zombie Slayer trait');
    assert.ok(embed.data.description.includes('Sharpshooter'), 'ZombieSlayer should get Sharpshooter trait');
    assert.ok(embed.data.description.includes('Fisherman'), 'ZombieSlayer should get Fisherman trait');
  });

  it('top player gets higher rarity', () => {
    const topCard = buildPlayerCard(db, '11111111111111111');
    const newbCard = buildPlayerCard(db, '55555555555555555');
    // Top player should have a higher-rarity color than the newbie
    const topTier = TIERS.find(t => topCard.data.color === t.color);
    const newbTier = TIERS.find(t => newbCard.data.color === t.color);
    assert.ok(topTier, 'Top player should match a tier');
    assert.ok(newbTier, 'Newbie should match a tier');
    assert.ok(topTier.minPercentile >= newbTier.minPercentile,
      `Top tier (${topTier.name}) should be >= newbie tier (${newbTier.name})`);
  });

  it('buildPlayerCardByName works case-insensitively', () => {
    const result = buildPlayerCardByName(db, 'zombieslayer');
    assert.ok(result, 'Should find by lowercase name');
    assert.ok(result.embed.data.title.includes('ZombieSlayer'));
    assert.equal(result.steamId, '11111111111111111');
  });

  it('buildPlayerCardByName returns null for unknown name', () => {
    assert.equal(buildPlayerCardByName(db, 'NonexistentPlayer'), null);
  });

  it('shows PvP stats when present', () => {
    const embed = buildPlayerCard(db, '44444444444444444');
    assert.ok(embed.data.description.includes('PvP'), 'PvPKing should have PvP stats');
    assert.ok(embed.data.description.includes('15K'), 'Should show PvP kill count');
  });

  it('shows headshot rate', () => {
    const embed = buildPlayerCard(db, '11111111111111111');
    assert.ok(embed.data.description.includes('Headshots'), 'Should show headshot section');
    assert.ok(embed.data.description.includes('24%'), 'Should show headshot rate (1200/5000 = 24%)');
  });
});

// ── newspaper tests ──────────────────────────────────────────────────────────

describe('howyagarn/newspaper', () => {
  before(() => {
    db = new HumanitZDB({ memory: true });
    db.init();
    seedTestData();
  });

  after(() => {
    db.close();
  });

  const { buildNewspaper } = require('../src/modules/howyagarn/newspaper');

  it('returns null when no DB', () => {
    assert.equal(buildNewspaper(null), null);
  });

  it('builds a newspaper with multiple sections', () => {
    const embed = buildNewspaper(db);
    assert.ok(embed, 'Should build an embed');
    assert.ok(embed.data.title.includes('Times'), 'Title should be newspaper-style');
    assert.ok(embed.data.fields.length >= 3, `Expected at least 3 sections, got ${embed.data.fields.length}`);
  });

  it('includes server name in title', () => {
    const embed = buildNewspaper(db, { serverName: 'TestServer' });
    assert.ok(embed.data.title.includes('TestServer'));
  });

  it('BREAKING section references real data', () => {
    const embed = buildNewspaper(db);
    const breaking = embed.data.fields.find(f => f.name.includes('BREAKING'));
    assert.ok(breaking, 'Should have BREAKING section');
    assert.ok(breaking.value.includes('ZombieSlayer') || breaking.value.includes('structure'),
      'BREAKING should reference real data');
  });

  it('SPORTS section has kill rankings', () => {
    const embed = buildNewspaper(db);
    const sports = embed.data.fields.find(f => f.name.includes('SPORTS'));
    assert.ok(sports, 'Should have SPORTS section');
    assert.ok(sports.value.includes('🥇'));
  });

  it('OBITUARIES section lists deaths', () => {
    const embed = buildNewspaper(db);
    const obits = embed.data.fields.find(f => f.name.includes('OBITUARIES'));
    assert.ok(obits, 'Should have OBITUARIES section');
    assert.ok(obits.value.includes('PvPKing'), 'Should list the player with most deaths');
  });

  it('WEATHER section shows season and day', () => {
    const embed = buildNewspaper(db);
    const weather = embed.data.fields.find(f => f.name.includes('WEATHER'));
    assert.ok(weather, 'Should have WEATHER section');
    assert.ok(weather.value.includes('Summer'));
    assert.ok(weather.value.includes('42'));
  });

  it('CLASSIFIEDS mentions abandoned vehicles', () => {
    const embed = buildNewspaper(db);
    const classifieds = embed.data.fields.find(f => f.name.includes('CLASSIFIEDS'));
    assert.ok(classifieds, 'Should have CLASSIFIEDS section');
    assert.ok(classifieds.value.includes('abandoned'));
  });
});

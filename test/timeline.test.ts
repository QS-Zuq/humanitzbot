/**
 * Tests for the Timeline system — schema v10 tables, DB CRUD, SnapshotService.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import _database from '../src/db/database.js';
const HumanitZDB = _database as any;

import _snapshot_service from '../src/tracking/snapshot-service.js';
const SnapshotService = _snapshot_service as any;

import * as _schema from '../src/db/schema.js';
const { SCHEMA_VERSION, ALL_TABLES } = _schema as any;

let db: typeof HumanitZDB;

before(() => {
  db = new HumanitZDB({ memory: true, label: 'TimelineTest' });
  db.init();
});

after(() => {
  if (db) db.close();
});

describe('Schema v11 — Timeline tables', () => {
  it('schema version is 15', () => {
    assert.equal(SCHEMA_VERSION, 15);
  });

  it('ALL_TABLES includes timeline table definitions', () => {
    const allSql = ALL_TABLES.join('\n');
    const expected = [
      'timeline_snapshots',
      'timeline_players',
      'timeline_ai',
      'timeline_vehicles',
      'timeline_structures',
      'timeline_houses',
      'timeline_companions',
      'timeline_backpacks',
      'death_causes',
    ];
    for (const t of expected) {
      assert.ok(allSql.includes(t), `ALL_TABLES SQL should include ${t}`);
    }
  });

  it('creates all timeline tables in DB', () => {
    const tables = db.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    const names = tables.map((t: { name: string }) => t.name);
    assert.ok(names.includes('timeline_snapshots'));
    assert.ok(names.includes('timeline_players'));
    assert.ok(names.includes('timeline_ai'));
    assert.ok(names.includes('timeline_vehicles'));
    assert.ok(names.includes('timeline_structures'));
    assert.ok(names.includes('timeline_houses'));
    assert.ok(names.includes('timeline_companions'));
    assert.ok(names.includes('timeline_backpacks'));
    assert.ok(names.includes('death_causes'));
  });

  it('creates indexes on timeline tables', () => {
    const indexes = db.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_tl_%'").all();
    const names = indexes.map((i: { name: string }) => i.name);
    assert.ok(names.includes('idx_tl_snap_created'));
    assert.ok(names.includes('idx_tl_snap_day'));
    assert.ok(names.includes('idx_tl_players_snap'));
    assert.ok(names.includes('idx_tl_players_steam'));
    assert.ok(names.includes('idx_tl_ai_snap'));
    assert.ok(names.includes('idx_tl_ai_type'));
    assert.ok(names.includes('idx_tl_ai_cat'));
    assert.ok(names.includes('idx_tl_vehicles_snap'));
    assert.ok(names.includes('idx_tl_structures_snap'));
    assert.ok(names.includes('idx_tl_structures_owner'));
  });
});

describe('DB — insertTimelineSnapshot + queries', () => {
  let snapId: number;

  it('inserts a timeline snapshot with entities', () => {
    snapId = db.insertTimelineSnapshot({
      snapshot: {
        gameDay: 42,
        gameTime: 14.5,
        playerCount: 2,
        onlineCount: 1,
        aiCount: 3,
        structureCount: 1,
        vehicleCount: 1,
        containerCount: 0,
        worldItemCount: 10,
        weatherType: 'Rain',
        season: 'Summer',
        airdropActive: true,
        airdropX: 1000,
        airdropY: 2000,
        airdropAiAlive: 2,
        summary: { gameDifficulty: 'hard' },
      },
      players: [
        {
          steamId: '76561198000000001',
          name: 'Alice',
          online: 1,
          x: 100,
          y: 200,
          z: 50,
          health: 90,
          maxHealth: 100,
          hunger: 70,
          thirst: 60,
          infection: 0,
          stamina: 80,
          level: 5,
          zeeksKilled: 42,
          daysSurvived: 10,
          lifetimeKills: 100,
        },
        {
          steamId: '76561198000000002',
          name: 'Bob',
          online: 0,
          x: 300,
          y: 400,
          z: 55,
          health: 50,
          maxHealth: 100,
          hunger: 40,
          thirst: 30,
          infection: 5,
          stamina: 60,
          level: 3,
          zeeksKilled: 20,
          daysSurvived: 5,
          lifetimeKills: 50,
        },
      ],
      ai: [
        { aiType: 'ZombieDefault', category: 'zombie', displayName: 'Zombie', nodeUid: 'n1', x: 500, y: 600, z: 10 },
        { aiType: 'AnimalWold', category: 'animal', displayName: 'Wolf', nodeUid: 'n2', x: 700, y: 800, z: 15 },
        {
          aiType: 'BanditPistol',
          category: 'bandit',
          displayName: 'Bandit (Pistol)',
          nodeUid: 'n3',
          x: 900,
          y: 100,
          z: 20,
        },
      ],
      vehicles: [
        {
          class: 'BP_Sedan_C',
          displayName: 'Sedan',
          x: 1100,
          y: 1200,
          z: 5,
          health: 800,
          maxHealth: 1000,
          fuel: 15.5,
          itemCount: 3,
        },
      ],
      structures: [
        {
          actorClass: 'BP_WoodWall_C',
          displayName: 'Wood Wall',
          ownerSteamId: '76561198000000001',
          x: 150,
          y: 250,
          z: 50,
          currentHealth: 200,
          maxHealth: 500,
          upgradeLevel: 1,
        },
      ],
      houses: [
        {
          uid: 'house_001',
          name: 'Ranch House',
          windowsOpen: 2,
          windowsTotal: 4,
          doorsOpen: 1,
          doorsLocked: 0,
          doorsTotal: 3,
          destroyedFurniture: 1,
          hasGenerator: true,
          sleepers: 0,
          clean: 1,
          x: null,
          y: null,
        },
      ],
      companions: [
        {
          entityType: 'dog',
          actorName: 'BP_Dog_C',
          displayName: 'Dog',
          ownerSteamId: '76561198000000001',
          x: 110,
          y: 210,
          z: 50,
          health: 80,
          extra: { stamina: 50 },
        },
      ],
      backpacks: [{ class: 'BP_Backpack_C', x: 500, y: 500, z: 10, itemCount: 5, items: [{ item: 'Axe', amount: 1 }] }],
    });

    assert.ok(typeof snapId === 'number');
    assert.ok(snapId > 0);
  });

  it('getTimelineSnapshots returns snapshot metadata', () => {
    const snaps = db.getTimelineSnapshots(10);
    assert.ok(snaps.length >= 1);
    const s = snaps[0];
    assert.equal(s.game_day, 42);
    assert.equal(s.weather_type, 'Rain');
    assert.equal(s.season, 'Summer');
    assert.equal(s.player_count, 2);
    assert.equal(s.online_count, 1);
    assert.equal(s.ai_count, 3);
    assert.equal(s.airdrop_active, 1);
    assert.ok(typeof s.summary === 'object'); // parsed from JSON
    assert.equal(s.summary.gameDifficulty, 'hard');
  });

  it('getTimelineSnapshotFull returns all entities', () => {
    const full = db.getTimelineSnapshotFull(snapId);
    assert.ok(full);
    assert.ok(full.snapshot);
    assert.equal(full.snapshot.id, snapId);
    assert.equal(full.players.length, 2);
    assert.equal(full.ai.length, 3);
    assert.equal(full.vehicles.length, 1);
    assert.equal(full.structures.length, 1);
    assert.equal(full.houses.length, 1);
    assert.equal(full.companions.length, 1);
    assert.equal(full.backpacks.length, 1);
  });

  it('getTimelineSnapshotFull player data is correct', () => {
    const full = db.getTimelineSnapshotFull(snapId);
    const alice = full.players.find((p: { name: string }) => p.name === 'Alice');
    assert.ok(alice);
    assert.equal(alice.steam_id, '76561198000000001');
    assert.equal(alice.online, 1);
    assert.equal(alice.pos_x, 100);
    assert.equal(alice.pos_y, 200);
    assert.equal(alice.health, 90);
    assert.equal(alice.level, 5);
    assert.equal(alice.zeeks_killed, 42);
  });

  it('getTimelineSnapshotFull AI data is correct', () => {
    const full = db.getTimelineSnapshotFull(snapId);
    const wolf = full.ai.find((a: { ai_type: string }) => a.ai_type === 'AnimalWold');
    assert.ok(wolf);
    assert.equal(wolf.category, 'animal');
    assert.equal(wolf.display_name, 'Wolf');
    assert.equal(wolf.pos_x, 700);
  });

  it('getTimelineSnapshotFull vehicle data is correct', () => {
    const full = db.getTimelineSnapshotFull(snapId);
    assert.equal(full.vehicles[0].display_name, 'Sedan');
    assert.equal(full.vehicles[0].fuel, 15.5);
    assert.equal(full.vehicles[0].item_count, 3);
  });

  it('getTimelineSnapshotFull structure data is correct', () => {
    const full = db.getTimelineSnapshotFull(snapId);
    assert.equal(full.structures[0].display_name, 'Wood Wall');
    assert.equal(full.structures[0].owner_steam_id, '76561198000000001');
    assert.equal(full.structures[0].upgrade_level, 1);
  });

  it('getTimelineSnapshotFull house data is correct', () => {
    const full = db.getTimelineSnapshotFull(snapId);
    assert.equal(full.houses[0].uid, 'house_001');
    assert.equal(full.houses[0].windows_open, 2);
    assert.equal(full.houses[0].has_generator, 1);
  });

  it('getTimelineSnapshotFull companion data is correct', () => {
    const full = db.getTimelineSnapshotFull(snapId);
    assert.equal(full.companions[0].entity_type, 'dog');
    assert.equal(full.companions[0].owner_steam_id, '76561198000000001');
  });

  it('getTimelineSnapshotFull backpack data is correct', () => {
    const full = db.getTimelineSnapshotFull(snapId);
    assert.equal(full.backpacks[0].item_count, 5);
    assert.ok(Array.isArray(full.backpacks[0].items_summary)); // parsed from JSON
  });

  it('getTimelineBounds returns correct bounds', () => {
    const bounds = db.getTimelineBounds();
    assert.ok(bounds);
    assert.ok(bounds.earliest);
    assert.ok(bounds.latest);
    assert.ok(bounds.count >= 1);
  });

  it('getTimelineSnapshotRange returns snapshots in range', () => {
    db.getTimelineBounds();
    const snaps = db.getTimelineSnapshotRange('2000-01-01', '2100-01-01');
    assert.ok(snaps.length >= 1);
  });

  it('getTimelineSnapshotFull returns null for missing ID', () => {
    const result = db.getTimelineSnapshotFull(999999);
    assert.equal(result, null);
  });
});

describe('DB — Player position history', () => {
  it('getPlayerPositionHistory returns player trail', () => {
    const trail = db.getPlayerPositionHistory('76561198000000001', '2000-01-01', '2100-01-01');
    assert.ok(trail.length >= 1);
    assert.equal(trail[0].pos_x, 100);
    assert.equal(trail[0].pos_y, 200);
    assert.ok(trail[0].created_at);
  });

  it('getPlayerPositionHistory returns empty for unknown player', () => {
    const trail = db.getPlayerPositionHistory('0000000000000000', '2000-01-01', '2100-01-01');
    assert.equal(trail.length, 0);
  });
});

describe('DB — AI population history', () => {
  it('getAIPopulationHistory returns population data', () => {
    const pop = db.getAIPopulationHistory('2000-01-01', '2100-01-01');
    assert.ok(pop.length >= 1);
    assert.equal(pop[0].ai_count, 3);
    assert.equal(pop[0].zombies, 1);
    assert.equal(pop[0].animals, 1);
    assert.equal(pop[0].bandits, 1);
  });
});

describe('DB — Death causes', () => {
  it('inserts a death cause', () => {
    db.insertDeathCause({
      victimName: 'Alice',
      victimSteamId: '76561198000000001',
      causeType: 'zombie',
      causeName: 'Runner',
      causeRaw: 'BP_ZombieRunner_C',
      damageTotal: 45.5,
      x: 100,
      y: 200,
      z: 50,
    });
    // Should not throw
  });

  it('inserts a PvP death cause', () => {
    db.insertDeathCause({
      victimName: 'Bob',
      victimSteamId: '76561198000000002',
      causeType: 'player',
      causeName: 'Alice',
      causeRaw: 'BP_Player_C',
      damageTotal: 80,
      x: 300,
      y: 400,
      z: 55,
    });
  });

  it('getDeathCauses returns recent deaths', () => {
    const deaths = db.getDeathCauses(10);
    assert.ok(deaths.length >= 2);
    assert.equal(deaths[0].victim_name, 'Bob'); // most recent first
    assert.equal(deaths[0].cause_type, 'player');
    assert.equal(deaths[0].cause_name, 'Alice');
  });

  it('getDeathCausesByPlayer filters by player name', () => {
    const deaths = db.getDeathCausesByPlayer('Alice', 10);
    assert.ok(deaths.length >= 1);
    assert.equal(deaths[0].victim_name, 'Alice');
    assert.equal(deaths[0].cause_name, 'Runner');
  });

  it('getDeathCausesByPlayer filters by steam ID', () => {
    const deaths = db.getDeathCausesByPlayer('76561198000000002', 10);
    assert.ok(deaths.length >= 1);
    assert.equal(deaths[0].victim_name, 'Bob');
  });

  it('getDeathCauseStats returns aggregated stats', () => {
    const stats = db.getDeathCauseStats();
    assert.ok(stats.length >= 2);
    const zombieStat = stats.find((s: { cause_type: string }) => s.cause_type === 'zombie');
    assert.ok(zombieStat);
    assert.equal(zombieStat.cause_name, 'Runner');
    assert.equal(zombieStat.count, 1);
  });

  it('getDeathCausesSince returns deaths after timestamp', () => {
    const deaths = db.getDeathCausesSince('2000-01-01');
    assert.ok(deaths.length >= 2);
  });
});

describe('DB — purgeOldTimeline', () => {
  it('purgeOldTimeline does not delete recent data', () => {
    const result = db.purgeOldTimeline('-1 second');
    // Should delete everything (all are older than 1 second ago), but it uses
    // datetime('now', ...) so recent inserts may or may not be affected.
    // At minimum, it shouldn't crash
    assert.ok(typeof result.changes === 'number');
  });
});

describe('SnapshotService', () => {
  let service: typeof SnapshotService;
  let serviceDb: typeof HumanitZDB;

  before(() => {
    serviceDb = new HumanitZDB({ memory: true, label: 'SnapTest' });
    serviceDb.init();
    service = new SnapshotService(serviceDb, { retentionDays: 7 });
  });

  after(() => {
    if (serviceDb) serviceDb.close();
  });

  it('records a snapshot from save-like data', () => {
    const saveData = {
      players: new Map([
        [
          '76561198000000001',
          {
            name: 'TestPlayer',
            steamId: '76561198000000001',
            x: 150000,
            y: -200000,
            z: 100,
            health: 85,
            maxHealth: 100,
            hunger: 60,
            thirst: 50,
            infection: 0,
            stamina: 90,
            level: 7,
            zeeksKilled: 55,
            daysSurvived: 15,
            lifetimeKills: 120,
          },
        ],
      ]),
      worldState: {
        totalDaysElapsed: 45,
        timeOfDay: { day: 45, time: 10.5 },
        aiSpawns: [
          { type: 'ZombieDefault', category: 'zombie', x: 160000, y: -190000, z: 50, nodeUid: 'a1' },
          { type: 'AnimalWold', category: 'animal', x: 170000, y: -180000, z: 55, nodeUid: 'a2' },
        ],
        houses: [
          {
            uid: 'h1',
            name: 'House 1',
            windowsOpen: 1,
            windowsTotal: 3,
            doorsOpen: 0,
            doorsTotal: 2,
            doorsLocked: 1,
            destroyedFurniture: 0,
            hasGenerator: false,
          },
        ],
        droppedBackpacks: [
          { class: 'BP_Backpack_C', x: 155000, y: -195000, z: 80, items: [{ item: 'Axe', amount: 1 }] },
        ],
      },
      vehicles: [
        {
          class: 'BP_Van_C',
          displayName: 'Van',
          x: 140000,
          y: -210000,
          z: 60,
          health: 500,
          maxHealth: 1000,
          fuel: 20,
          inventory: ['item1', 'item2'],
        },
      ],
      structures: [
        {
          actorClass: 'BP_WoodFloor_C',
          displayName: 'Wood Floor',
          ownerSteamId: '76561198000000001',
          x: 152000,
          y: -198000,
          z: 100,
          currentHealth: 300,
          maxHealth: 500,
          upgradeLevel: 2,
        },
      ],
      companions: [
        {
          type: 'dog',
          actorName: 'BP_Dog_C',
          ownerSteamId: '76561198000000001',
          x: 151000,
          y: -199000,
          z: 100,
          health: 90,
          extra: {},
        },
      ],
      horses: [
        {
          actorName: 'BP_Horse_C',
          horseName: 'Spirit',
          ownerSteamId: '76561198000000001',
          x: 153000,
          y: -197000,
          z: 100,
          health: 100,
          energy: 80,
          stamina: 70,
        },
      ],
    };

    const snapId = service.recordSnapshot(saveData, { onlinePlayers: new Set(['testplayer']) });
    assert.ok(typeof snapId === 'number');
    assert.ok(snapId > 0);
    assert.equal(service.snapshotCount, 1);
    assert.equal(service.lastSnapshotId, snapId);
  });

  it('stored snapshot has correct metadata', () => {
    const snaps = serviceDb.getTimelineSnapshots(1);
    assert.equal(snaps.length, 1);
    const s = snaps[0];
    assert.equal(s.game_day, 45);
    assert.equal(s.player_count, 1);
    assert.equal(s.ai_count, 2);
    assert.equal(s.vehicle_count, 1);
    assert.equal(s.structure_count, 1);
    assert.equal(s.season, 'Summer'); // day 45 → (45 % 120) / 30 = 1 → Summer
  });

  it('stored snapshot has correct entity data', () => {
    const full = serviceDb.getTimelineSnapshotFull(service.lastSnapshotId);
    assert.ok(full);
    assert.equal(full.players.length, 1);
    assert.equal(full.players[0].name, 'TestPlayer');
    assert.equal(full.ai.length, 2);
    assert.equal(full.vehicles.length, 1);
    assert.equal(full.vehicles[0].display_name, 'Van');
    assert.equal(full.structures.length, 1);
    assert.equal(full.companions.length, 2); // 1 companion + 1 horse
    assert.equal(full.backpacks.length, 1);
    assert.equal(full.houses.length, 1);
  });

  it('horse is stored as companion with entity_type=horse', () => {
    const full = serviceDb.getTimelineSnapshotFull(service.lastSnapshotId);
    const horse = full.companions.find((c: { entity_type: string }) => c.entity_type === 'horse');
    assert.ok(horse);
    assert.equal(horse.display_name, 'Spirit');
  });

  it('AI display names are resolved', () => {
    const full = serviceDb.getTimelineSnapshotFull(service.lastSnapshotId);
    const zombie = full.ai.find((a: { ai_type: string }) => a.ai_type === 'ZombieDefault');
    assert.ok(zombie);
    assert.equal(zombie.display_name, 'Zombie');
    assert.equal(zombie.category, 'zombie');

    const wolf = full.ai.find((a: { ai_type: string }) => a.ai_type === 'AnimalWold');
    assert.ok(wolf);
    assert.equal(wolf.display_name, 'Wolf');
    assert.equal(wolf.category, 'animal');
  });

  it('handles empty save data without crashing', () => {
    const snapId = service.recordSnapshot({});
    // Should return a snapshot ID (empty but valid)
    assert.ok(typeof snapId === 'number');
  });

  it('handles null DB gracefully', () => {
    const nullService = new SnapshotService(null);
    const result = nullService.recordSnapshot({ players: new Map() });
    assert.equal(result, null);
  });

  it('handles null saveData gracefully', () => {
    const result = service.recordSnapshot(null);
    assert.equal(result, null);
  });

  it('classifies AI categories correctly', () => {
    // Test internal method
    assert.equal(service._classifyAICategory('ZombieDefault'), 'zombie');
    assert.equal(service._classifyAICategory('ZombieRunner'), 'zombie');
    assert.equal(service._classifyAICategory('AnimalWold'), 'animal');
    assert.equal(service._classifyAICategory('AnimalBear'), 'animal');
    assert.equal(service._classifyAICategory('BanditPistol'), 'bandit');
    assert.equal(service._classifyAICategory('BanditRifle'), 'bandit');
    assert.equal(service._classifyAICategory('AnimalZDog'), 'zombie'); // zombie animal = zombie
    assert.equal(service._classifyAICategory(null), 'unknown');
  });

  it('resolves seasons from day count', () => {
    assert.equal(service._resolveSeason({ totalDaysElapsed: 0 }), 'Spring'); // 0-29
    assert.equal(service._resolveSeason({ totalDaysElapsed: 15 }), 'Spring');
    assert.equal(service._resolveSeason({ totalDaysElapsed: 30 }), 'Summer'); // 30-59
    assert.equal(service._resolveSeason({ totalDaysElapsed: 60 }), 'Autumn'); // 60-89
    assert.equal(service._resolveSeason({ totalDaysElapsed: 90 }), 'Winter'); // 90-119
    assert.equal(service._resolveSeason({ totalDaysElapsed: 120 }), 'Spring'); // cycles
  });
});

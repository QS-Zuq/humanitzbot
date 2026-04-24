import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import SaveService from '../src/parsers/save-service.js';

type AnyRecord = Record<string, any>;

function makeParsedSave(overrides: AnyRecord = {}) {
  return {
    players: new Map<string, AnyRecord>(),
    worldState: {},
    structures: [],
    vehicles: [],
    companions: [],
    deadBodies: [],
    containers: [],
    lootActors: [],
    quests: [],
    horses: [],
    ...overrides,
  };
}

function makeCache(overrides: AnyRecord = {}) {
  return {
    v: 1,
    players: {},
    worldState: {},
    structures: [],
    vehicles: [],
    companions: [],
    deadBodies: [],
    containers: [],
    lootActors: [],
    quests: [],
    horses: [],
    ...overrides,
  };
}

function makeDb(overrides: AnyRecord = {}) {
  const syncPayloads: AnyRecord[] = [];
  const metaWrites: AnyRecord[] = [];
  const insertedActivities: AnyRecord[][] = [];
  const calls: string[] = [];
  let nextItemId = 1;
  let nextGroupId = 1;

  const db: AnyRecord = {
    syncPayloads,
    metaWrites,
    insertedActivities,
    calls,
    syncAllFromSave(payload: AnyRecord) {
      syncPayloads.push(payload);
    },
    activityLog: {
      insertActivities(entries: AnyRecord[]) {
        insertedActivities.push(entries);
      },
      purgeOldActivity(age: string) {
        calls.push(`purgeOldActivity:${age}`);
      },
      repairActorNames() {
        return 0;
      },
    },
    meta: {
      setMeta(key: string, value: string) {
        metaWrites.push({ key, value });
      },
    },
    item: {
      getActiveItemInstances() {
        return [];
      },
      touchItemInstance() {},
      moveItemInstance() {},
      createItemInstance() {
        return nextItemId++;
      },
      markItemLost() {},
      getActiveItemGroups() {
        return [];
      },
      touchItemGroup() {},
      updateItemGroupQuantity() {},
      upsertItemGroup() {
        return { id: nextGroupId++ };
      },
      markItemGroupLost() {},
      getItemGroup() {
        return undefined;
      },
      recordGroupMovement() {},
      purgeOldLostItems(age: string) {
        calls.push(`purgeOldLostItems:${age}`);
      },
      purgeOldLostGroups(age: string) {
        calls.push(`purgeOldLostGroups:${age}`);
      },
      purgeOldMovements(age: string) {
        calls.push(`purgeOldMovements:${age}`);
      },
    },
    worldObject: {
      getAllContainers() {
        return [];
      },
      getAllWorldHorses() {
        return [];
      },
      getAllVehicles() {
        return [];
      },
      getStructures() {
        return [];
      },
    },
    worldState: {
      getAllWorldState() {
        return {};
      },
    },
    player: {
      getOnlinePlayersForDiff() {
        return [];
      },
    },
    ...overrides,
  };

  return db;
}

function makeService(db = makeDb(), options: AnyRecord = {}) {
  const svc = new SaveService(db as any, {
    dataDir: '/tmp/humanitzbot-save-service-test-empty',
    idMap: {},
    ...options,
  }) as any;
  svc._writeSaveCache = () => {};
  return svc;
}

function captureSync(svc: any) {
  let result: AnyRecord | null = null;
  svc.once('sync', (payload: AnyRecord) => {
    result = payload;
  });
  return () => result;
}

describe('SaveService _parseCache', () => {
  it('rejects malformed JSON without updating cache mtime', () => {
    const svc = makeService();
    svc._lastCacheMtime = 123;

    const result = svc._parseCache('{bad json', 456);

    assert.equal(result, null);
    assert.equal(svc._lastCacheMtime, 123);
  });

  it('rejects missing or old cache versions without updating cache mtime', () => {
    const svc = makeService();
    svc._lastCacheMtime = 123;

    assert.equal(svc._parseCache(JSON.stringify({ players: {} }), 456), null);
    assert.equal(svc._lastCacheMtime, 123);
    assert.equal(svc._parseCache(JSON.stringify({ v: 0, players: {} }), 789), null);
    assert.equal(svc._lastCacheMtime, 123);
  });

  it('accepts valid cache data and updates mtime only when provided', () => {
    const svc = makeService();

    const first = svc._parseCache(JSON.stringify(makeCache({ players: { steam1: { name: 'A' } } })), 456);
    assert.equal(first.players.steam1.name, 'A');
    assert.equal(svc._lastCacheMtime, 456);

    const second = svc._parseCache(JSON.stringify(makeCache({ players: { steam2: { name: 'B' } } })), null);
    assert.equal(second.players.steam2.name, 'B');
    assert.equal(svc._lastCacheMtime, 456);
  });
});

describe('SaveService _syncFromCache', () => {
  it('normalizes cache players into a Map and supplies default arrays', async () => {
    const svc = makeService();
    let parsedArg: AnyRecord | null = null;
    let clansArg: unknown[] | null = null;
    svc._syncParsedData = (parsed: AnyRecord, clans: unknown[]) => {
      parsedArg = parsed;
      clansArg = clans;
      return { ok: true };
    };

    await svc._syncFromCache({ v: 1, players: { steam1: { name: 'Alice' } }, worldState: { day: 7 } });

    assert.ok(parsedArg);
    const parsed = parsedArg as AnyRecord;
    assert.ok(parsed.players instanceof Map);
    assert.deepEqual(parsed.players.get('steam1'), { name: 'Alice' });
    assert.deepEqual(parsed.worldState, { day: 7 });
    assert.deepEqual(parsed.structures, []);
    assert.deepEqual(parsed.vehicles, []);
    assert.deepEqual(parsed.companions, []);
    assert.deepEqual(parsed.deadBodies, []);
    assert.deepEqual(parsed.containers, []);
    assert.deepEqual(parsed.lootActors, []);
    assert.deepEqual(parsed.quests, []);
    assert.deepEqual(parsed.horses, []);
    assert.deepEqual(clansArg, []);
  });

  it('fetches clan data only when a clan save path is configured', async () => {
    const svc = makeService(undefined, { clanSavePath: '/Save_ClanData.sav' });
    const clans = [{ name: 'WolfPack' }];
    let clansArg: unknown[] | null = null;
    let fetchCalled = false;
    svc._fetchClanData = async () => {
      fetchCalled = true;
      return clans;
    };
    svc._syncParsedData = (_parsed: AnyRecord, nextClans: unknown[]) => {
      clansArg = nextClans;
      return { ok: true };
    };

    await svc._syncFromCache(makeCache());

    assert.equal(fetchCalled, true);
    assert.deepEqual(clansArg, clans);
  });

  it('does not fetch clan data when no clan save path is configured', async () => {
    const svc = makeService();
    let fetchCalled = false;
    let clansArg: unknown[] | null = null;
    svc._fetchClanData = async () => {
      fetchCalled = true;
      return [{ name: 'ShouldNotLoad' }];
    };
    svc._syncParsedData = (_parsed: AnyRecord, nextClans: unknown[]) => {
      clansArg = nextClans;
      return { ok: true };
    };

    await svc._syncFromCache(makeCache());

    assert.equal(fetchCalled, false);
    assert.deepEqual(clansArg, []);
  });

  it('emits sync result through the normal parsed-data path', async () => {
    const db = makeDb();
    const svc = makeService(db);
    const getSync = captureSync(svc);

    await svc._syncFromCache(
      makeCache({ players: { steam1: { name: 'Alice' } }, structures: [{ actorName: 'wall' }] }),
    );

    const result = getSync();
    assert.ok(result);
    assert.equal(result.playerCount, 1);
    assert.equal(result.structureCount, 1);
    assert.deepEqual(result.steamIds, ['steam1']);
    assert.equal(db.metaWrites.find((entry: AnyRecord) => entry.key === 'last_save_players')?.value, '1');
  });
});

describe('SaveService _syncParsedData', () => {
  it('applies idMap names before syncing and emitting the result', () => {
    const db = makeDb();
    const svc = makeService(db, { idMap: { steam1: 'Mapped Alice' } });
    const getSync = captureSync(svc);
    const players = new Map([['steam1', { name: 'Old Alice', inventory: [] }]]);

    const result = svc._syncParsedData(makeParsedSave({ players }), [{ name: 'Clan' }]);

    assert.equal(db.syncPayloads[0].players.get('steam1').name, 'Mapped Alice');
    assert.equal(result.parsed.players.get('steam1').name, 'Mapped Alice');
    assert.equal(getSync()?.clanCount, 1);
  });

  it('passes null worldDrops when no world drop state exists', () => {
    const db = makeDb();
    const svc = makeService(db);

    svc._syncParsedData(makeParsedSave(), []);

    assert.equal(db.syncPayloads[0].worldDrops, null);
  });

  it('builds worldDrops from pickups, backpacks, and global containers', () => {
    const db = makeDb();
    const svc = makeService(db);
    const worldState = {
      lodPickups: [{ item: 'None', amount: 2, x: 1, y: 2, z: 3, placed: true }],
      droppedBackpacks: [{ items: [], x: 4, y: 5, z: 6 }],
      globalContainers: [{ actorName: 'global_box', items: [], locked: true, x: 7, y: 8, z: 9 }],
    };

    svc._syncParsedData(makeParsedSave({ worldState }), []);

    assert.deepEqual(db.syncPayloads[0].worldDrops, [
      {
        type: 'pickup',
        actorName: '',
        item: 'None',
        amount: 2,
        durability: 0,
        items: [],
        worldLoot: undefined,
        placed: true,
        spawned: undefined,
        x: 1,
        y: 2,
        z: 3,
      },
      {
        type: 'backpack',
        actorName: 'backpack_0',
        item: '',
        amount: 0,
        durability: 0,
        items: [],
        x: 4,
        y: 5,
        z: 6,
      },
      {
        type: 'global_container',
        actorName: 'global_box',
        item: '',
        amount: 0,
        durability: 0,
        items: [],
        locked: true,
        doesSpawnLoot: undefined,
        x: 7,
        y: 8,
        z: 9,
      },
    ]);
  });

  it('writes meta and emits the expected sync result shape', () => {
    const db = makeDb();
    const svc = makeService(db, { agentMode: 'agent' });
    const getSync = captureSync(svc);
    const parsed = makeParsedSave({
      players: new Map([
        ['steam1', { name: 'Alice', inventory: [] }],
        ['steam2', { name: 'Bob', inventory: [] }],
      ]),
      structures: [{ actorName: 'wall' }],
      vehicles: [{ actorName: 'truck' }],
      companions: [{ actorName: 'dog' }],
      horses: [{ actorName: 'horse' }],
      containers: [{ actorName: 'box', items: [] }],
      worldState: { day: 42 },
    });

    const result = svc._syncParsedData(parsed, [{ name: 'Clan' }]);

    assert.equal(result.playerCount, 2);
    assert.equal(result.structureCount, 1);
    assert.equal(result.vehicleCount, 1);
    assert.equal(result.companionCount, 1);
    assert.equal(result.clanCount, 1);
    assert.equal(result.horseCount, 1);
    assert.equal(result.containerCount, 1);
    assert.deepEqual(result.steamIds, ['steam1', 'steam2']);
    assert.equal(result.mode, 'agent');
    assert.deepEqual(result.worldState, { day: 42 });
    assert.equal(
      db.metaWrites.some((entry: AnyRecord) => entry.key === 'last_save_sync'),
      true,
    );
    assert.equal(db.metaWrites.find((entry: AnyRecord) => entry.key === 'last_save_players')?.value, '2');
    assert.equal(getSync(), result);
  });

  it('continues when guarded diff reading fails', () => {
    const db = makeDb();
    const svc = makeService(db);
    const getSync = captureSync(svc);
    svc._syncCount = 1;
    svc._readOldStateForDiff = () => {
      throw new Error('diff read failed');
    };

    const result = svc._syncParsedData(makeParsedSave({ players: new Map([['steam1', { inventory: [] }]]) }), []);

    assert.equal(db.syncPayloads.length, 1);
    assert.equal(result.activityEvents, 0);
    assert.equal(getSync(), result);
  });

  it('continues when guarded item tracking fails', () => {
    const db = makeDb({
      item: {
        ...makeDb().item,
        getActiveItemInstances() {
          throw new Error('item tracker failed');
        },
      },
    });
    const svc = makeService(db);

    const result = svc._syncParsedData(makeParsedSave(), []);

    assert.equal(db.syncPayloads.length, 1);
    assert.equal(result.itemTracking, null);
    assert.equal(db.metaWrites.find((entry: AnyRecord) => entry.key === 'last_save_players')?.value, '0');
  });

  it('continues when guarded activity log insert and purge fail', () => {
    const baseDb = makeDb();
    const db = makeDb({
      activityLog: {
        ...baseDb.activityLog,
        insertActivities() {
          throw new Error('insert failed');
        },
        purgeOldActivity() {
          throw new Error('purge failed');
        },
      },
    });
    const svc = makeService(db);
    svc._syncCount = 1;
    svc._readOldStateForDiff = () => ({
      containers: [{ actorName: 'crate', items: [] }],
      horses: [],
      players: [],
      worldState: {},
      vehicles: [],
      structures: [],
    });
    const parsed = makeParsedSave({
      containers: [{ actorName: 'crate', items: [{ item: 'Nails', amount: 1 }] }],
    });

    const result = svc._syncParsedData(parsed, []);

    assert.equal(db.syncPayloads.length, 1);
    assert.ok(result.activityEvents > 0);
    assert.equal(db.metaWrites.find((entry: AnyRecord) => entry.key === 'last_save_players')?.value, '0');
  });
});

describe('SaveService _poll', () => {
  it('returns immediately when a sync is already in progress', async () => {
    const svc = makeService();
    let directCalled = false;
    let agentCalled = false;
    svc._syncing = true;
    svc._pollDirect = async () => {
      directCalled = true;
    };
    svc._pollAgent = async () => {
      agentCalled = true;
      return true;
    };

    await svc._poll(true);

    assert.equal(directCalled, false);
    assert.equal(agentCalled, false);
    assert.equal(svc._syncing, true);
  });

  it('falls back to direct mode when auto agent polling is unavailable', async () => {
    const svc = makeService(undefined, { agentMode: 'auto' });
    let directForce: boolean | null = null;
    svc._pollAgent = async () => false;
    svc._pollDirect = async (force: boolean) => {
      directForce = force;
    };

    await svc._poll(true);

    assert.equal(directForce, true);
    assert.equal(svc._mode, 'direct');
    assert.equal(svc._syncing, false);
  });
});

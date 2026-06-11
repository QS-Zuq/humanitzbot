import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import SaveService from '../src/parsers/save-service.js';
import { SaveSyncPipeline, type SaveSyncPipelineDeps } from '../src/parsers/save-sync-pipeline.js';

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
  const importedIdMap: AnyRecord[] = [];
  const calls: string[] = [];
  let nextItemId = 1;
  let nextGroupId = 1;

  const db: AnyRecord = {
    syncPayloads,
    metaWrites,
    insertedActivities,
    importedIdMap,
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
      purgeOldItemTrackerData(opts: AnyRecord = {}) {
        calls.push(
          `purgeOldItemTrackerData:${opts.lostItemsAge ?? ''}:${opts.lostGroupsAge ?? ''}:${opts.movementsAge ?? ''}`,
        );
        return { movementsDeleted: 0, itemsDeleted: 0, groupsDeleted: 0 };
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
      getPlayersForDiffBySteamIds() {
        return [];
      },
      importIdMap(entries: AnyRecord[]) {
        importedIdMap.push(...entries);
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

function makePipeline(db = makeDb(), overrides: Partial<SaveSyncPipelineDeps> = {}) {
  const emitted: AnyRecord[] = [];
  const cacheWrites: AnyRecord[] = [];
  let syncCount = 0;
  const deps: SaveSyncPipelineDeps = {
    db: db as any,
    log: {
      label: 'SaveSyncPipelineTest',
      info() {},
      warn() {},
      error() {},
    },
    getIdMap: () => ({}),
    getMode: () => 'auto',
    getSyncCount: () => syncCount,
    readOldStateForDiff: () => null,
    writeSaveCache(parsed) {
      cacheWrites.push(parsed);
    },
    emitSync(result) {
      emitted.push(result);
    },
    shouldFetchClanData: () => false,
    fetchClanData: async () => [],
    ...overrides,
  };
  return {
    pipeline: new SaveSyncPipeline(deps),
    emitted,
    cacheWrites,
    setSyncCount(next: number) {
      syncCount = next;
    },
  };
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

  it('marks the agent/cache path capable after reading cache with idMap', () => {
    const svc = makeService();

    const result = svc._parseCache(
      JSON.stringify(
        makeCache({
          idMap: { '76561198000000001': 'Mapped Alice' },
          players: { '76561198000000001': { name: '' } },
        }),
      ),
      456,
    );

    assert.equal(result.idMap['76561198000000001'], 'Mapped Alice');
    assert.equal(svc.stats.agentCapable, true);
  });

  it('logs per-player cache stats and warning states', () => {
    const svc = makeService();
    const logs: string[] = [];
    svc._log = {
      info(...args: unknown[]) {
        logs.push(args.map(String).join(' '));
      },
      warn(...args: unknown[]) {
        logs.push(args.map(String).join(' '));
      },
      error() {},
    };

    const result = svc._parseCache(
      JSON.stringify(
        makeCache({
          v: 3,
          players: {},
          playerCacheStats: {
            mode: 'legacy-main-save',
            discovered: 2,
            parsed: 0,
            reused: 0,
            removed: 0,
            errors: 1,
          },
        }),
      ),
      456,
    );

    assert.ok(result);
    assert.ok(logs.some((line) => line.includes('player files discovered 2')));
    assert.ok(logs.some((line) => line.includes('legacy main-save player mode')));
    assert.ok(logs.some((line) => line.includes('discovered 2 per-player file(s) but contains 0 players')));
    assert.ok(logs.some((line) => line.includes('1 per-player parse error(s)')));
  });
});

describe('SaveService agent availability', () => {
  it('checks Node.js directly instead of requiring a pre-deployed check-node script', async () => {
    const svc = makeService(undefined, {
      agentNodePath: '/opt/node/bin/node',
      savePath: '/srv/HumanitZServer/Saved/SaveGames/SaveList/Default/Save_DedicatedSaveMP.sav',
    });
    const commands: string[] = [];
    svc._resolvePaths();
    svc._sshExec = async (command: string) => {
      commands.push(command);
      return { code: 0, stdout: 'v22.12.0\n', stderr: '' };
    };

    const result = await svc.checkNodeAvailable();

    assert.equal(result, true);
    assert.equal(svc._agentCapable, true);
    assert.deepEqual(commands, ["'/opt/node/bin/node' --version"]);
  });

  it('records a node-check failure when the direct Node.js probe fails', async () => {
    const svc = makeService(undefined, { agentNodePath: 'node' });
    svc._sshExec = async () => ({ code: 127, stdout: '', stderr: 'node: command not found' });

    const result = await svc.checkNodeAvailable();

    assert.equal(result, false);
    assert.equal(svc._agentCapable, false);
    assert.match(svc._lastError, /^node-check-failed:/);
  });
});

describe('SaveSyncPipeline syncFromCache', () => {
  it('normalizes cache players into a Map and passes list fields through as-is', async () => {
    const db = makeDb();
    const { pipeline, emitted, cacheWrites } = makePipeline(db);

    // containers present (empty) is authoritative; the other list fields are
    // absent from the cache and must stay undefined so the DB sync skips them.
    await pipeline.syncFromCache({
      v: 1,
      players: { steam1: { name: 'Alice' } },
      worldState: { day: 7 },
      containers: [],
    });

    const parsed = db.syncPayloads[0] as AnyRecord;
    assert.ok(parsed.players instanceof Map);
    assert.deepEqual(parsed.players.get('steam1'), { name: 'Alice' });
    assert.deepEqual(parsed.worldState, { day: 7 });
    assert.deepEqual(parsed.containers, []);
    assert.equal(parsed.structures, undefined);
    assert.equal(parsed.vehicles, undefined);
    assert.equal(parsed.companions, undefined);
    assert.equal(parsed.deadBodies, undefined);
    assert.equal(parsed.lootActors, undefined);
    assert.equal(parsed.quests, undefined);
    assert.equal(parsed.horses, undefined);
    assert.deepEqual(parsed.clans, []);
    assert.equal(cacheWrites.length, 1);
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0]?.playerCount, 1);
  });

  it('keeps worldState and the derived worldDrops undefined when the cache omits worldState', async () => {
    const db = makeDb();
    const { pipeline } = makePipeline(db);

    await pipeline.syncFromCache({ v: 1, players: {} });

    const parsed = db.syncPayloads[0] as AnyRecord;
    assert.equal(parsed.worldState, undefined);
    assert.equal(parsed.worldDrops, undefined);
  });

  it('returns undefined worldDrops when the world-drop build throws partway', async () => {
    const db = makeDb();
    const { pipeline } = makePipeline(db);

    // lodPickups is not iterable → _buildWorldDrops throws and must yield
    // undefined (preserve the table) instead of a partial array.
    await pipeline.syncParsedData(makeParsedSave({ worldState: { lodPickups: 42 } }), []);

    assert.equal((db.syncPayloads[0] as AnyRecord).worldDrops, undefined);
  });

  it('emits no destroyed events for categories omitted from the cache', async () => {
    const oldState = {
      containers: [{ actorName: 'c1', items: [{ item: 'AK47', amount: 1 }], x: 1, y: 2, z: 3 }],
    };

    // containers omitted → diff category skipped, no spurious events
    const omittedDb = makeDb();
    const omitted = makePipeline(omittedDb, {
      getSyncCount: () => 5,
      readOldStateForDiff: () => oldState,
    });
    await omitted.pipeline.syncFromCache({ v: 1, players: {} });
    assert.equal(omittedDb.insertedActivities.flat().length, 0);

    // present-but-empty containers stays authoritative → container_destroyed
    const clearedDb = makeDb();
    const cleared = makePipeline(clearedDb, {
      getSyncCount: () => 5,
      readOldStateForDiff: () => oldState,
    });
    await cleared.pipeline.syncFromCache({ v: 1, players: {}, containers: [] });
    const events = clearedDb.insertedActivities.flat() as AnyRecord[];
    assert.ok(events.some((e) => e.type === 'container_destroyed'));
  });

  it('passes empty worldDrops through as an array instead of null', async () => {
    const db = makeDb();
    const { pipeline } = makePipeline(db);

    await pipeline.syncParsedData(makeParsedSave(), []);

    assert.deepEqual((db.syncPayloads[0] as AnyRecord).worldDrops, []);
  });

  it('fetches clan data only when a clan save path is configured', async () => {
    const db = makeDb();
    const clans = [{ name: 'WolfPack' }];
    let fetchCalled = false;
    const { pipeline } = makePipeline(db, {
      shouldFetchClanData: () => true,
      fetchClanData: async () => {
        fetchCalled = true;
        return clans;
      },
    });

    await pipeline.syncFromCache(makeCache());

    assert.equal(fetchCalled, true);
    assert.deepEqual(db.syncPayloads[0].clans, clans);
  });

  it('does not fetch clan data when no clan save path is configured', async () => {
    const db = makeDb();
    let fetchCalled = false;
    const { pipeline } = makePipeline(db, {
      fetchClanData: async () => {
        fetchCalled = true;
        return [{ name: 'ShouldNotLoad' }];
      },
    });

    await pipeline.syncFromCache(makeCache());

    assert.equal(fetchCalled, false);
    assert.deepEqual(db.syncPayloads[0].clans, []);
  });

  it('runs activity cleanup only on maintenance sync intervals', async () => {
    const db = makeDb();
    const pipelineHarness = makePipeline(db);
    const activityPurgeCount = () => db.calls.filter((call: string) => call === 'purgeOldActivity:-30 days').length;

    pipelineHarness.setSyncCount(1);
    await pipelineHarness.pipeline.syncParsedData(makeParsedSave(), []);
    assert.equal(activityPurgeCount(), 0);

    pipelineHarness.setSyncCount(100);
    await pipelineHarness.pipeline.syncParsedData(makeParsedSave(), []);
    assert.equal(activityPurgeCount(), 1);

    pipelineHarness.setSyncCount(0);
    await pipelineHarness.pipeline.syncParsedData(makeParsedSave(), []);
    assert.equal(activityPurgeCount(), 2);
  });

  it('uses the consolidated FK-safe item tracker purge only on maintenance sync intervals', async () => {
    const db = makeDb();
    const pipelineHarness = makePipeline(db);
    const itemPurgeCount = () =>
      db.calls.filter((call: string) => call === 'purgeOldItemTrackerData:-7 days:-7 days:-30 days').length;

    pipelineHarness.setSyncCount(1);
    await pipelineHarness.pipeline.syncParsedData(makeParsedSave(), []);
    assert.equal(itemPurgeCount(), 0);

    pipelineHarness.setSyncCount(100);
    await pipelineHarness.pipeline.syncParsedData(makeParsedSave(), []);
    assert.equal(itemPurgeCount(), 1);
    assert.equal(
      db.calls.some((call: string) => call.startsWith('purgeOldLostItems:')),
      false,
    );
    assert.equal(
      db.calls.some((call: string) => call.startsWith('purgeOldLostGroups:')),
      false,
    );
    assert.equal(
      db.calls.some((call: string) => call.startsWith('purgeOldMovements:')),
      false,
    );
  });

  it('logs sync phase timings', async () => {
    const db = makeDb();
    const logs: string[] = [];
    const { pipeline } = makePipeline(db, {
      log: {
        label: 'SaveSyncPipelineTest',
        info(...args: unknown[]) {
          logs.push(args.map(String).join(' '));
        },
        warn() {},
        error() {},
      },
    });

    await pipeline.syncParsedData(makeParsedSave(), []);

    const phaseLog = logs.find((line) => line.includes('Sync phases:'));
    assert.ok(phaseLog);
    for (const key of ['prep=', 'db=', 'items=', 'itemPurge=', 'activity=', 'meta=', 'cacheWrite=', 'total=']) {
      assert.match(phaseLog, new RegExp(key));
    }
  });

  it('does not purge item tracker data when item reconciliation fails', async () => {
    const baseDb = makeDb();
    const db = makeDb({
      item: {
        ...baseDb.item,
        getActiveItemInstances() {
          throw new Error('item tracker failed');
        },
        purgeOldItemTrackerData() {
          throw new Error('purge should not run');
        },
      },
    });
    const logs: string[] = [];
    const pipelineHarness = makePipeline(db, {
      log: {
        label: 'SaveSyncPipelineTest',
        info() {},
        warn(...args: unknown[]) {
          logs.push(args.map(String).join(' '));
        },
        error() {},
      },
    });

    pipelineHarness.setSyncCount(100);
    const result = await pipelineHarness.pipeline.syncParsedData(makeParsedSave(), []);

    assert.equal(result.itemTracking, null);
    assert.equal(
      logs.some((line) => line.includes('Item tracker reconcile error (non-fatal):')),
      true,
    );
    assert.equal(
      logs.some((line) => line.includes('Item tracker purge error (non-fatal):')),
      false,
    );
  });

  it('keeps item stats when maintenance purge fails', async () => {
    const baseDb = makeDb();
    const db = makeDb({
      item: {
        ...baseDb.item,
        purgeOldItemTrackerData() {
          throw new Error('FOREIGN KEY constraint failed');
        },
      },
    });
    const logs: string[] = [];
    const pipelineHarness = makePipeline(db, {
      log: {
        label: 'SaveSyncPipelineTest',
        info() {},
        warn(...args: unknown[]) {
          logs.push(args.map(String).join(' '));
        },
        error() {},
      },
    });
    pipelineHarness.setSyncCount(100);

    const result = await pipelineHarness.pipeline.syncParsedData(
      makeParsedSave({
        players: new Map([['steam1', { inventory: [{ item: 'Rifle', amount: 1 }], equipment: [] }]]),
      }),
      [],
    );

    assert.ok(result.itemTracking);
    assert.equal(result.itemTracking.created, 1);
    assert.equal(
      logs.some((line) => line.includes('Item tracker purge error (non-fatal):')),
      true,
    );
  });
});

describe('SaveService _syncFromCache', () => {
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

  it('applies agent cache idMap before syncing player names', async () => {
    const steamId = '76561198000000001';
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'humanitzbot-idmap-'));
    const db = makeDb();
    const svc = makeService(db, { dataDir });

    try {
      await svc._syncFromCache(
        makeCache({
          idMap: { [steamId]: 'Mapped Alice' },
          players: { [steamId]: { name: '', inventory: [] } },
        }),
      );

      assert.equal(db.syncPayloads[0].players.get(steamId).name, 'Mapped Alice');
      assert.deepEqual(db.importedIdMap, [{ steamId, name: 'Mapped Alice' }]);
      assert.equal(svc._idMap[steamId], 'Mapped Alice');
      assert.equal(fs.existsSync(path.join(dataDir, 'data', 'logs', 'PlayerIDMapped.txt')), false);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe('SaveService _syncParsedData', () => {
  it('applies idMap names before syncing and emitting the result', async () => {
    const steamId = '76561198000000001';
    const db = makeDb();
    const svc = makeService(db, { idMap: { [steamId]: 'Mapped Alice' } });
    const getSync = captureSync(svc);
    const players = new Map([[steamId, { name: 'Old Alice', inventory: [] }]]);

    const result = await svc._syncParsedData(makeParsedSave({ players }), [{ name: 'Clan' }]);

    assert.equal(db.syncPayloads[0].players.get(steamId).name, 'Mapped Alice');
    assert.equal(result.parsed.players.get(steamId).name, 'Mapped Alice');
    assert.equal(getSync()?.clanCount, 1);
  });

  it('passes an empty worldDrops array when no world drop state exists', async () => {
    const db = makeDb();
    const svc = makeService(db);

    await svc._syncParsedData(makeParsedSave(), []);

    // An empty array is authoritative ("the world has no drops") and clears
    // the table downstream; null was the legacy encoding for the same case.
    assert.deepEqual(db.syncPayloads[0].worldDrops, []);
  });

  it('builds worldDrops from pickups, backpacks, and global containers', async () => {
    const db = makeDb();
    const svc = makeService(db);
    const worldState = {
      lodPickups: [{ item: 'None', amount: 2, x: 1, y: 2, z: 3, placed: true }],
      droppedBackpacks: [{ items: [], x: 4, y: 5, z: 6 }],
      globalContainers: [{ actorName: 'global_box', items: [], locked: true, x: 7, y: 8, z: 9 }],
    };

    await svc._syncParsedData(makeParsedSave({ worldState }), []);

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

  it('writes meta and emits the expected sync result shape', async () => {
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

    const result = await svc._syncParsedData(parsed, [{ name: 'Clan' }]);

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
    assert.deepEqual(
      [
        'playerCount',
        'structureCount',
        'vehicleCount',
        'companionCount',
        'clanCount',
        'horseCount',
        'containerCount',
        'activityEvents',
        'itemTracking',
        'worldState',
        'elapsed',
        'steamIds',
        'mode',
        'diffEvents',
        'syncTime',
        'parsed',
      ].filter((key) => !(key in result)),
      [],
    );
    assert.equal(
      db.metaWrites.some((entry: AnyRecord) => entry.key === 'last_save_sync'),
      true,
    );
    assert.equal(db.metaWrites.find((entry: AnyRecord) => entry.key === 'last_save_players')?.value, '2');
    assert.equal(getSync(), result);
  });

  it('continues when guarded diff reading fails', async () => {
    const db = makeDb();
    const svc = makeService(db);
    const getSync = captureSync(svc);
    svc._syncCount = 1;
    svc._readOldStateForDiff = () => {
      throw new Error('diff read failed');
    };

    const result = await svc._syncParsedData(makeParsedSave({ players: new Map([['steam1', { inventory: [] }]]) }), []);

    assert.equal(db.syncPayloads.length, 1);
    assert.equal(result.activityEvents, 0);
    assert.equal(getSync(), result);
  });

  it('continues when guarded item tracking fails', async () => {
    const db = makeDb({
      item: {
        ...makeDb().item,
        getActiveItemInstances() {
          throw new Error('item tracker failed');
        },
      },
    });
    const svc = makeService(db);

    const result = await svc._syncParsedData(makeParsedSave(), []);

    assert.equal(db.syncPayloads.length, 1);
    assert.equal(result.itemTracking, null);
    assert.equal(db.metaWrites.find((entry: AnyRecord) => entry.key === 'last_save_players')?.value, '0');
  });

  it('does not build diff events on the first sync', async () => {
    const db = makeDb();
    const svc = makeService(db);
    svc._syncCount = 0;
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

    const result = await svc._syncParsedData(parsed, []);

    assert.equal(result.activityEvents, 0);
    assert.deepEqual(result.diffEvents, []);
    assert.deepEqual(db.insertedActivities, []);
  });

  it('builds diff events after the first sync when old and new state differ', async () => {
    const db = makeDb();
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

    const result = await svc._syncParsedData(parsed, []);

    assert.ok(result.activityEvents > 0);
    assert.ok(result.diffEvents.length > 0);
    assert.equal(db.insertedActivities.length, 1);
  });

  it('falls back to current parsed Steam IDs for old player diff when no online rows exist', async () => {
    const candidateCalls: string[][] = [];
    const db = makeDb({
      worldObject: {
        getAllContainers() {
          return [{ actorName: 'crate', items: [] }];
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
      player: {
        getOnlinePlayersForDiff() {
          return [];
        },
        getPlayersForDiffBySteamIds(steamIds: string[]) {
          candidateCalls.push(steamIds);
          return [
            {
              steam_id: '76561198000000021',
              name: 'Alice',
              inventory: [{ item: 'Nails', amount: 3 }],
              equipment: [],
              quick_slots: [],
              backpack_items: [],
            },
          ];
        },
        importIdMap(entries: AnyRecord[]) {
          db.importedIdMap.push(...entries);
        },
      },
    });
    const svc = makeService(db);
    svc._syncCount = 1;
    const parsed = makeParsedSave({
      players: new Map([
        [
          '76561198000000021',
          {
            name: 'Alice',
            inventory: [],
            equipment: [],
            quick_slots: [],
            backpack_items: [],
          },
        ],
      ]),
      containers: [{ actorName: 'crate', items: [{ item: 'Nails', amount: 3 }] }],
    });

    const result = await svc._syncParsedData(parsed, []);

    assert.deepEqual(candidateCalls, [['76561198000000021']]);
    const containerEvent = result.diffEvents.find((event: AnyRecord) => event.type === 'container_item_added');
    assert.ok(containerEvent);
    assert.equal(containerEvent.attributedSteamId, '76561198000000021');
  });

  it('continues when guarded activity log insert and purge fail', async () => {
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
    svc._syncCount = 100;
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

    const result = await svc._syncParsedData(parsed, []);

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

  it('does not fall back to direct mode when auto agent polling is unavailable', async () => {
    const svc = makeService(undefined, { agentMode: 'auto' });
    let directForce: boolean | null = null;
    svc._pollAgent = async () => false;
    svc._pollDirect = async (force: boolean) => {
      directForce = force;
    };

    await svc._poll(true);

    assert.equal(directForce, null);
    assert.notEqual(svc._mode, 'direct');
    assert.equal(svc._syncing, false);
    assert.match(svc.stats.lastError as string, /^agent-unavailable:/);
  });

  it('still allows explicit direct mode as a diagnostic path', async () => {
    const svc = makeService(undefined, { agentMode: 'direct' });
    let directForce: boolean | null = null;
    svc._pollAgent = async () => {
      throw new Error('agent should not run');
    };
    svc._pollDirect = async (force: boolean) => {
      directForce = force;
    };

    await svc._poll(true);

    assert.equal(directForce, true);
    assert.equal(svc._syncing, false);
  });
});

describe('SaveService _pollAgent', () => {
  it('refreshes startup cache that lacks idMap before syncing', async () => {
    const svc = makeService();
    const oldCache = makeCache({ players: { steam1: { name: 'Steam Only' } } });
    const freshCache = makeCache({
      idMap: { '76561198000000001': 'Mapped Alice' },
      players: { '76561198000000001': { name: '' } },
    });
    const reads: boolean[] = [];
    const synced: AnyRecord[] = [];
    let triggered = false;
    svc._readCacheFromSftp = async (force: boolean) => {
      reads.push(force);
      return reads.length === 1 ? oldCache : freshCache;
    };
    svc._resolveTrigger = async () => 'rcon';
    svc._triggerViaRcon = async () => {
      triggered = true;
    };
    svc._syncFromCache = async (cache: AnyRecord) => {
      synced.push(cache);
    };

    const result = await svc._pollAgent(false);

    assert.equal(result, true);
    assert.equal(triggered, true);
    assert.deepEqual(reads, [false, true]);
    assert.deepEqual(synced, [freshCache]);
  });

  it('fails when an existing cache lacks idMap and no trigger can refresh it', async () => {
    const svc = makeService();
    const oldCache = makeCache({ players: { steam1: { name: 'Steam Only' } } });
    const synced: AnyRecord[] = [];
    svc._readCacheFromSftp = async () => oldCache;
    svc._resolveTrigger = async () => 'none';
    svc._syncFromCache = async (cache: AnyRecord) => {
      synced.push(cache);
    };

    const result = await svc._pollAgent(true);

    assert.equal(result, false);
    assert.deepEqual(synced, []);
    assert.match(svc.stats.lastError as string, /^agent-cache-missing-idmap:/);
  });

  it('fails when a refreshed cache still lacks idMap', async () => {
    const svc = makeService();
    const oldCache = makeCache({ players: { steam1: { name: 'Steam Only' } } });
    const freshCache = makeCache({ players: { steam1: { name: 'Steam Only' } } });
    const synced: AnyRecord[] = [];
    let triggered = false;
    svc._readCacheFromSftp = async (force: boolean) => (force ? freshCache : oldCache);
    svc._resolveTrigger = async () => 'rcon';
    svc._triggerViaRcon = async () => {
      triggered = true;
    };
    svc._syncFromCache = async (cache: AnyRecord) => {
      synced.push(cache);
    };

    const result = await svc._pollAgent(false);

    assert.equal(result, false);
    assert.equal(triggered, true);
    assert.deepEqual(synced, []);
    assert.match(svc.stats.lastError as string, /^agent-cache-missing-idmap:/);
  });

  it('fails loudly when no agent trigger is usable', async () => {
    const svc = makeService();
    svc._readCacheFromSftp = async () => null;
    svc._resolveTrigger = async () => 'none';

    const result = await svc._pollAgent(true);

    assert.equal(result, false);
    assert.match(svc.stats.lastError as string, /^agent-unavailable:/);
  });

  it('records deployment failures separately from execute failures', async () => {
    const svc = makeService();
    svc._readCacheFromSftp = async () => null;
    svc._resolveTrigger = async () => 'ssh';
    svc.deployAgent = async () => {
      throw new Error('disk full');
    };

    const result = await svc._pollAgent(true);

    assert.equal(result, false);
    assert.match(svc.stats.lastError as string, /^agent-deploy-failed:/);
  });

  it('records execute failures after an agent has been deployed', async () => {
    const svc = makeService();
    svc._agentDeployed = true;
    svc._readCacheFromSftp = async () => null;
    svc._resolveTrigger = async () => 'ssh';
    svc.executeAgent = async () => {
      throw new Error('permission denied');
    };

    const result = await svc._pollAgent(true);

    assert.equal(result, false);
    assert.match(svc.stats.lastError as string, /^agent-execute-failed:/);
  });

  it('records cache-missing when a trigger runs but does not produce cache', async () => {
    const svc = makeService();
    const reads: boolean[] = [];
    let triggered = false;
    svc._cachePath = '/srv/save/humanitz-cache.json';
    svc._readCacheFromSftp = async (force: boolean) => {
      reads.push(force);
      return null;
    };
    svc._resolveTrigger = async () => 'rcon';
    svc._triggerViaRcon = async () => {
      triggered = true;
    };

    const result = await svc._pollAgent(false);

    assert.equal(result, false);
    assert.equal(triggered, true);
    assert.deepEqual(reads, [false, true]);
    assert.match(svc.stats.lastError as string, /^agent-cache-missing:/);
  });
});

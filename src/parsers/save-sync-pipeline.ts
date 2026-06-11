import { performance } from 'node:perf_hooks';
import { diffSaveState } from '../db/diff-engine.js';
import { reconcileItems } from '../db/item-tracker.js';
import type { HumanitZDB } from '../db/database.js';
import type { Logger } from '../utils/log.js';
import { errMsg } from '../utils/error.js';
import { yieldToEventLoop } from '../utils/async.js';

const MAINTENANCE_PURGE_INTERVAL_SYNCS = 100;

function _presentArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

export type SaveActivityEvent = ReturnType<typeof diffSaveState>[number];
export type SaveItemStats = Awaited<ReturnType<typeof reconcileItems>>;
export type SaveSyncPipelineDb = Pick<HumanitZDB, 'syncAllFromSave' | 'activityLog' | 'meta' | 'item'>;

interface SyncPhaseTimings {
  prep: number;
  db: number;
  items: number;
  itemPurge: number;
  activity: number;
  meta: number;
  cacheWrite: number;
  total: number;
}

interface ItemTrackingRunResult {
  stats: SaveItemStats | null;
  reconcileMs: number;
  purgeMs: number;
}

export interface SaveCacheData extends Record<string, unknown> {
  v?: number;
  idMap?: Record<string, string>;
  idMapCount?: number;
  idMapPath?: string;
  idMapMtime?: number | null;
  players?: Record<string, Record<string, unknown>>;
  playerManifest?: {
    parserSignature?: string;
    files?: Record<
      string,
      {
        fileName?: string;
        relPath?: string;
        mtimeMs?: number;
        size?: number;
        status?: string;
      }
    >;
  };
  playerCacheStats?: Record<string, unknown>;
  worldState?: Record<string, unknown>;
  structures?: unknown[];
  vehicles?: unknown[];
  companions?: unknown[];
  deadBodies?: unknown[];
  containers?: unknown[];
  lootActors?: unknown[];
  quests?: unknown[];
  horses?: unknown[];
}

export interface SaveParsedDataInput extends Record<string, unknown> {
  players: Map<string, Record<string, unknown>>;
  playerSources?: Map<string, Record<string, unknown>>;
  worldState?: Record<string, unknown>;
  structures?: unknown[];
  vehicles?: unknown[];
  companions?: unknown[];
  deadBodies?: unknown[];
  containers?: unknown[];
  lootActors?: unknown[];
  quests?: unknown[];
  horses?: unknown[];
}

export interface SaveSyncResult {
  playerCount: number;
  structureCount: number;
  vehicleCount: number;
  companionCount: number;
  clanCount: number;
  horseCount: number;
  containerCount: number;
  activityEvents: number;
  itemTracking: SaveItemStats | null;
  worldState: unknown;
  elapsed: number;
  steamIds: string[];
  mode: string;
  diffEvents: SaveActivityEvent[];
  syncTime: Date;
  parsed: {
    players: Map<string, Record<string, unknown>>;
    structures: unknown[];
    vehicles: unknown[];
    companions: unknown[];
    horses: unknown[];
    containers: unknown[];
  };
}

export interface SaveSyncPipelineDeps {
  db: SaveSyncPipelineDb;
  log: Logger;
  getIdMap: () => Record<string, string>;
  getMode: () => string;
  getSyncCount: () => number;
  readOldStateForDiff: (candidateSteamIds?: string[]) => Record<string, unknown> | null;
  writeSaveCache: (parsed: SaveParsedDataInput) => void;
  emitSync: (result: SaveSyncResult) => void;
  shouldFetchClanData: () => boolean;
  fetchClanData: () => Promise<unknown[]>;
}

export class SaveSyncPipeline {
  private readonly _deps: SaveSyncPipelineDeps;

  constructor(deps: SaveSyncPipelineDeps) {
    this._deps = deps;
  }

  async syncFromCache(cache: SaveCacheData): Promise<void> {
    const players = new Map<string, Record<string, unknown>>();
    const playerSources = new Map<string, Record<string, unknown>>();
    const manifestFiles = cache.playerManifest?.files ?? {};
    for (const [steamId, data] of Object.entries(cache.players ?? {})) {
      players.set(steamId, data);
      const manifest = manifestFiles[steamId];
      if (manifest) {
        playerSources.set(steamId, {
          sourceFile: manifest.relPath || manifest.fileName || '',
          sourceMtimeMs: manifest.mtimeMs,
          sourceSize: manifest.size,
          cacheVersion: cache.v,
          agentVersion: cache.v,
          parserSignature: cache.playerManifest?.parserSignature,
        });
      } else if (cache.v != null) {
        playerSources.set(steamId, {
          cacheVersion: cache.v,
          agentVersion: cache.v,
          parserSignature: cache.playerManifest?.parserSignature,
        });
      }
    }
    // Pass list fields through as-is: a present array (even empty) is
    // authoritative and clears/replaces the table downstream, while a field
    // missing from the cache (older agent version) stays undefined so the
    // table is left untouched. See syncAllFromSave() payload semantics.
    const parsed: SaveParsedDataInput = {
      players,
      playerSources,
      worldState: cache.worldState ?? {},
      structures: _presentArray(cache.structures),
      vehicles: _presentArray(cache.vehicles),
      companions: _presentArray(cache.companions),
      deadBodies: _presentArray(cache.deadBodies),
      containers: _presentArray(cache.containers),
      lootActors: _presentArray(cache.lootActors),
      quests: _presentArray(cache.quests),
      horses: _presentArray(cache.horses),
    };
    const clans = this._deps.shouldFetchClanData() ? await this._deps.fetchClanData() : [];
    await this.syncParsedData(parsed, clans);
  }

  /**
   * Runs the sync as a sequence of phase transactions (world data, item
   * tracking, activity log, meta) with event-loop yields in between, so the
   * synchronous better-sqlite3 writes never block the process for the whole
   * sync. _poll()'s _syncing guard prevents a second sync from interleaving.
   */
  async syncParsedData(parsed: SaveParsedDataInput, clans: unknown[]): Promise<SaveSyncResult> {
    const startTime = Date.now();
    const phaseStart = performance.now();
    let phaseMark = phaseStart;
    const players = parsed.players;
    const idMap = this._deps.getIdMap();

    for (const [steamId, data] of players) {
      if (idMap[steamId]) data['name'] = idMap[steamId];
    }

    const diffEvents = this._buildDiffEvents(parsed, players, idMap);
    const worldDrops = this._buildWorldDrops(parsed);
    const timings: SyncPhaseTimings = {
      prep: this._elapsedSince(phaseMark),
      db: 0,
      items: 0,
      itemPurge: 0,
      activity: 0,
      meta: 0,
      cacheWrite: 0,
      total: 0,
    };

    phaseMark = performance.now();
    await this._deps.db.syncAllFromSave({
      players,
      playerSources: parsed.playerSources,
      worldState: parsed.worldState,
      structures: parsed.structures,
      vehicles: parsed.vehicles,
      companions: parsed.companions,
      clans,
      deadBodies: parsed.deadBodies,
      containers: parsed.containers,
      lootActors: parsed.lootActors,
      quests: parsed.quests,
      horses: parsed.horses,
      worldDrops,
    });
    timings.db = this._elapsedSince(phaseMark);

    await yieldToEventLoop();
    const itemTracking = await this._reconcileItems(parsed, players, idMap);
    timings.items = itemTracking.reconcileMs;
    timings.itemPurge = itemTracking.purgeMs;

    await yieldToEventLoop();
    phaseMark = performance.now();
    this._writeActivityEvents(diffEvents);
    if (this._isMaintenancePurgeDue()) {
      this._purgeOldActivity();
    }
    timings.activity = this._elapsedSince(phaseMark);

    phaseMark = performance.now();
    this._deps.db.meta.setMeta('last_save_sync', new Date().toISOString());
    this._deps.db.meta.setMeta('last_save_players', String(players.size));
    timings.meta = this._elapsedSince(phaseMark);

    phaseMark = performance.now();
    this._deps.writeSaveCache(parsed);
    timings.cacheWrite = this._elapsedSince(phaseMark);
    timings.total = this._elapsedSince(phaseStart);
    this._logSyncPhases(timings);

    const result = this._buildResult(parsed, clans, diffEvents, itemTracking.stats, startTime);
    this._deps.emitSync(result);
    return result;
  }

  private _buildDiffEvents(
    parsed: SaveParsedDataInput,
    players: Map<string, Record<string, unknown>>,
    idMap: Record<string, string>,
  ): SaveActivityEvent[] {
    let diffEvents: SaveActivityEvent[] = [];
    const isFirstSync = this._deps.getSyncCount() === 0;
    if (isFirstSync) return diffEvents;

    try {
      const candidateSteamIds = [...players.keys()].filter((steamId) => /^\d{17}$/.test(steamId));
      const oldState = this._deps.readOldStateForDiff(candidateSteamIds);
      if (oldState) {
        const newState = {
          containers: parsed.containers ?? [],
          horses: parsed.horses ?? [],
          players,
          worldState: parsed.worldState ?? {},
          vehicles: parsed.vehicles ?? [],
          structures: parsed.structures ?? [],
        };
        const nameResolver = (steamId: string): string => {
          const p = players.get(steamId);
          return (p?.['name'] as string) || idMap[steamId] || steamId;
        };
        diffEvents = diffSaveState(oldState, newState, nameResolver);
      }
    } catch (err: unknown) {
      this._deps.log.warn('Diff engine error (non-fatal):', errMsg(err));
    }
    return diffEvents;
  }

  private _buildWorldDrops(parsed: SaveParsedDataInput): unknown[] {
    const worldDrops: unknown[] = [];
    try {
      const ws = parsed.worldState ?? {};
      if (ws['lodPickups']) {
        for (const p of ws['lodPickups'] as Array<Record<string, unknown>>) {
          worldDrops.push({
            type: 'pickup',
            actorName: '',
            item: p['item'],
            amount: p['amount'] ?? 1,
            durability: p['durability'] ?? 0,
            items: [],
            worldLoot: p['worldLoot'],
            placed: p['placed'],
            spawned: p['spawned'],
            x: p['x'],
            y: p['y'],
            z: p['z'],
          });
        }
      }
      if (ws['droppedBackpacks']) {
        for (let i = 0; i < (ws['droppedBackpacks'] as unknown[]).length; i++) {
          const bp = (ws['droppedBackpacks'] as Array<Record<string, unknown>>)[i];
          if (!bp) continue;
          worldDrops.push({
            type: 'backpack',
            actorName: `backpack_${String(i)}`,
            item: '',
            amount: 0,
            durability: 0,
            items: bp['items'] ?? [],
            x: bp['x'],
            y: bp['y'],
            z: bp['z'],
          });
        }
      }
      if (ws['globalContainers']) {
        for (const gc of ws['globalContainers'] as Array<Record<string, unknown>>) {
          worldDrops.push({
            type: 'global_container',
            actorName: gc['actorName'] ?? '',
            item: '',
            amount: 0,
            durability: 0,
            items: gc['items'] ?? [],
            locked: gc['locked'],
            doesSpawnLoot: gc['doesSpawnLoot'],
            x: gc['x'] ?? null,
            y: gc['y'] ?? null,
            z: gc['z'] ?? null,
          });
        }
      }
    } catch (err: unknown) {
      this._deps.log.warn('World drops build error (non-fatal):', errMsg(err));
    }
    return worldDrops;
  }

  private async _reconcileItems(
    parsed: SaveParsedDataInput,
    players: Map<string, Record<string, unknown>>,
    idMap: Record<string, string>,
  ): Promise<ItemTrackingRunResult> {
    let itemStats: SaveItemStats;
    let purgeMs = 0;
    const reconcileStart = performance.now();
    try {
      const nameResolver = (steamId: string): string => {
        const p = players.get(steamId);
        return (p?.['name'] as string) || idMap[steamId] || steamId;
      };
      itemStats = await reconcileItems(
        // SAFETY: HumanitZDBLike requires index signature not present on class
        this._deps.db as unknown as Parameters<typeof reconcileItems>[0],
        {
          players,
          containers: (parsed.containers as Record<string, unknown>[] | undefined) ?? [],
          vehicles: (parsed.vehicles as Record<string, unknown>[] | undefined) ?? [],
          horses: (parsed.horses as Record<string, unknown>[] | undefined) ?? [],
          structures: (parsed.structures as Record<string, unknown>[] | undefined) ?? [],
          worldState: parsed.worldState ?? {},
        },
        nameResolver,
      );
    } catch (err: unknown) {
      this._deps.log.warn('Item tracker reconcile error (non-fatal):', errMsg(err));
      return { stats: null, reconcileMs: this._elapsedSince(reconcileStart), purgeMs };
    }

    const reconcileMs = this._elapsedSince(reconcileStart);

    if (this._isMaintenancePurgeDue()) {
      const purgeStart = performance.now();
      try {
        const purgeResult = this._deps.db.item.purgeOldItemTrackerData({
          lostItemsAge: '-7 days',
          lostGroupsAge: '-7 days',
          movementsAge: '-30 days',
        });
        purgeMs = this._elapsedSince(purgeStart);
        this._deps.log.info(
          `Item tracker purge: ${String(purgeResult.movementsDeleted)} movement(s), ${String(purgeResult.itemsDeleted)} item(s), ${String(purgeResult.groupsDeleted)} group(s) removed`,
        );
      } catch (err: unknown) {
        purgeMs = this._elapsedSince(purgeStart);
        this._deps.log.warn('Item tracker purge error (non-fatal):', errMsg(err));
      }
    }

    return { stats: itemStats, reconcileMs, purgeMs };
  }

  private _writeActivityEvents(diffEvents: SaveActivityEvent[]): void {
    if (diffEvents.length === 0) return;
    try {
      this._deps.db.activityLog.insertActivities(diffEvents as unknown as Array<Record<string, unknown>>);
      this._deps.log.info(`Activity log: ${String(diffEvents.length)} events recorded`);
    } catch (err: unknown) {
      this._deps.log.warn('Failed to write activity log:', errMsg(err));
    }
  }

  private _isMaintenancePurgeDue(): boolean {
    return this._deps.getSyncCount() % MAINTENANCE_PURGE_INTERVAL_SYNCS === 0;
  }

  private _purgeOldActivity(): void {
    try {
      this._deps.db.activityLog.purgeOldActivity('-30 days');
    } catch (err: unknown) {
      this._deps.log.warn('Activity cleanup failed (non-fatal):', errMsg(err));
    }
  }

  private _buildResult(
    parsed: SaveParsedDataInput,
    clans: unknown[],
    diffEvents: SaveActivityEvent[],
    itemStats: SaveItemStats | null,
    startTime: number,
  ): SaveSyncResult {
    const players = parsed.players;
    const elapsed = Date.now() - startTime;
    const mode = this._deps.getMode();
    const structures = parsed.structures ?? [];
    const vehicles = parsed.vehicles ?? [];
    const companions = parsed.companions ?? [];
    const horses = parsed.horses ?? [];
    const containers = parsed.containers ?? [];
    const horsesLabel = horses.length ? `, ${String(horses.length)} horses` : '';
    const containersLabel = containers.length ? `, ${String(containers.length)} containers` : '';
    const activityLabel = diffEvents.length ? `, ${String(diffEvents.length)} activity events` : '';
    const itemLabel = itemStats
      ? `, items: ${String(itemStats.matched)}m/${String(itemStats.created)}c/${String(itemStats.moved)}v/${String(itemStats.lost)}l` +
        ` grp: ${String(itemStats.groups.matched)}m/${String(itemStats.groups.created)}c/${String(itemStats.groups.adjusted)}a/${String(itemStats.groups.transferred)}t/${String(itemStats.groups.lost)}l`
      : '';
    this._deps.log.info(
      `Sync complete (${mode}): ${String(players.size)} players, ${String(structures.length)} structures, ${String(vehicles.length)} vehicles, ${String(clans.length)} clans${horsesLabel}${containersLabel}${activityLabel}${itemLabel} (${String(elapsed)}ms)`,
    );

    return {
      playerCount: players.size,
      structureCount: structures.length,
      vehicleCount: vehicles.length,
      companionCount: companions.length,
      clanCount: clans.length,
      horseCount: horses.length,
      containerCount: containers.length,
      activityEvents: diffEvents.length,
      itemTracking: itemStats,
      worldState: parsed.worldState,
      elapsed,
      steamIds: [...players.keys()],
      mode,
      diffEvents,
      syncTime: new Date(),
      parsed: {
        players,
        structures,
        vehicles,
        companions,
        horses,
        containers,
      },
    };
  }

  private _elapsedSince(start: number): number {
    return Math.max(0, Math.round(performance.now() - start));
  }

  private _logSyncPhases(timings: SyncPhaseTimings): void {
    this._deps.log.info(
      `Sync phases: prep=${String(timings.prep)}ms db=${String(timings.db)}ms items=${String(timings.items)}ms itemPurge=${String(timings.itemPurge)}ms activity=${String(timings.activity)}ms meta=${String(timings.meta)}ms cacheWrite=${String(timings.cacheWrite)}ms total=${String(timings.total)}ms`,
    );
  }
}

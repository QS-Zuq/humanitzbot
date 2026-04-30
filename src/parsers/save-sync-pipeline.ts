import { diffSaveState } from '../db/diff-engine.js';
import { reconcileItems } from '../db/item-tracker.js';
import type { HumanitZDB } from '../db/database.js';
import type { Logger } from '../utils/log.js';
import { errMsg } from '../utils/error.js';

const MAINTENANCE_PURGE_INTERVAL_SYNCS = 100;

export type SaveActivityEvent = ReturnType<typeof diffSaveState>[number];
export type SaveItemStats = ReturnType<typeof reconcileItems>;
export type SaveSyncPipelineDb = Pick<HumanitZDB, 'syncAllFromSave' | 'activityLog' | 'meta' | 'item'>;

export interface SaveCacheData extends Record<string, unknown> {
  v?: number;
  players?: Record<string, Record<string, unknown>>;
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
  readOldStateForDiff: () => Record<string, unknown> | null;
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
    for (const [steamId, data] of Object.entries(cache.players ?? {})) {
      players.set(steamId, data);
    }
    const parsed: SaveParsedDataInput = {
      players,
      worldState: cache.worldState ?? {},
      structures: cache.structures ?? [],
      vehicles: cache.vehicles ?? [],
      companions: cache.companions ?? [],
      deadBodies: cache.deadBodies ?? [],
      containers: cache.containers ?? [],
      lootActors: cache.lootActors ?? [],
      quests: cache.quests ?? [],
      horses: cache.horses ?? [],
    };
    const clans = this._deps.shouldFetchClanData() ? await this._deps.fetchClanData() : [];
    this.syncParsedData(parsed, clans);
  }

  syncParsedData(parsed: SaveParsedDataInput, clans: unknown[]): SaveSyncResult {
    const startTime = Date.now();
    const players = parsed.players;
    const idMap = this._deps.getIdMap();

    for (const [steamId, data] of players) {
      if (idMap[steamId]) data['name'] = idMap[steamId];
    }

    const diffEvents = this._buildDiffEvents(parsed, players, idMap);
    const worldDrops = this._buildWorldDrops(parsed);

    this._deps.db.syncAllFromSave({
      players,
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
      worldDrops: worldDrops.length > 0 ? worldDrops : null,
    });

    const itemStats = this._reconcileItems(parsed, players, idMap);
    this._writeActivityEvents(diffEvents);
    if (this._isMaintenancePurgeDue()) {
      this._purgeOldActivity();
    }

    this._deps.db.meta.setMeta('last_save_sync', new Date().toISOString());
    this._deps.db.meta.setMeta('last_save_players', String(players.size));

    const result = this._buildResult(parsed, clans, diffEvents, itemStats, startTime);
    this._deps.writeSaveCache(parsed);
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
      const oldState = this._deps.readOldStateForDiff();
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

  private _reconcileItems(
    parsed: SaveParsedDataInput,
    players: Map<string, Record<string, unknown>>,
    idMap: Record<string, string>,
  ): SaveItemStats | null {
    let itemStats: SaveItemStats | null = null;
    try {
      const nameResolver = (steamId: string): string => {
        const p = players.get(steamId);
        return (p?.['name'] as string) || idMap[steamId] || steamId;
      };
      itemStats = reconcileItems(
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
      if (this._isMaintenancePurgeDue()) {
        this._deps.db.item.purgeOldLostItems('-7 days');
        this._deps.db.item.purgeOldLostGroups('-7 days');
        this._deps.db.item.purgeOldMovements('-30 days');
      }
    } catch (err: unknown) {
      this._deps.log.warn('Item tracker error (non-fatal):', errMsg(err));
    }
    return itemStats;
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
}

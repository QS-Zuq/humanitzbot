/**
 * Snapshot Service — captures full world state on each save poll cycle.
 *
 * Records temporal data (player positions, AI spawns, vehicles, structures,
 * houses, companions, backpacks, weather) to timeline_* DB tables. This
 * enables time-scroll playback on the live map and historical analytics.
 *
 * Hooks into the save poll cycle via `recordSnapshot(saveData)` — called
 * by PlayerStatsChannel after each successful save parse.
 *
 * @module snapshot-service
 */

import { cleanName } from '../parsers/ue4-names.js';
import { createLogger, type Logger } from '../utils/log.js';
import { errMsg } from '../utils/error.js';

// ── AI type → display name mapping ──────────────────────────

const AI_DISPLAY_NAMES: Record<string, string> = {
  // Zombies
  ZombieDefault: 'Zombie',
  ZombieDefault2: 'Zombie',
  ZombieFemale: 'Female Zombie',
  ZombieFemale2: 'Female Zombie',
  ZombieUrban: 'Urban Zombie',
  ZombieRunner: 'Runner',
  ZombieBrute: 'Brute',
  ZombieFatty: 'Bloater',
  ZombieBellyToxic: 'Bloater',
  ZombieMutant: 'Mutant',
  ZombieCop: 'Police Zombie',
  ZombiePolice1: 'Police Zombie',
  ZombiePolice2: 'Police Zombie',
  ZombiePoliceArmor: 'Police Armoured',
  ZombieMilitaryArmor: 'Military Armoured',
  ZombieMilitaryArmorV2: 'Military Armoured V2',
  ZombieCamo: 'Camo Zombie',
  ZombieHazmat: 'Hazmat Zombie',
  ZombieMedic: 'Medic Zombie',
  ZombieBruteRunner: 'Runner Brute',
  ZombieBruteComp: 'Brute',
  ZombieBruteCop: 'Riot Brute',

  // Zombie animals
  AnimalZDog: 'Dog Zombie',
  AnimalZBear: 'Zombie Bear',
  AnimalZStag: 'Zombie Stag',

  // Animals
  AnimalWold: 'Wolf', // typo in game data
  AnimalBear: 'Bear',
  AnimalRabbit: 'Rabbit',
  AnimalPig: 'Pig',
  AnimalStag: 'Stag',
  AnimalDoe: 'Doe',
  AnimalChicken: 'Chicken',

  // Bandits
  BanditPistol: 'Bandit (Pistol)',
  BanditMelee: 'Bandit (Melee)',
  BanditShotgun: 'Bandit (Shotgun)',
  BanditRifle: 'Bandit (Rifle)',
  BanditSniper: 'Bandit (Sniper)',
};

// Minimal DB interface matching src/db/database.ts
interface HumanitZDB {
  insertTimelineSnapshot(data: TimelineInsertData): number;
  purgeOldTimeline(olderThan: string): { changes: number };
}

interface TimelineInsertData {
  [key: string]: unknown;
  snapshot: SnapshotHeader;
  players: TimelinePlayer[];
  ai: TimelineAI[];
  vehicles: TimelineVehicle[];
  structures: TimelineStructure[];
  houses: TimelineHouse[];
  companions: TimelineCompanion[];
  backpacks: TimelineBackpack[];
}

interface SnapshotHeader {
  gameDay: number;
  gameTime: number;
  playerCount: number;
  onlineCount: number;
  aiCount: number;
  structureCount: number;
  vehicleCount: number;
  containerCount: number;
  worldItemCount: number;
  weatherType: string;
  season: string;
  airdropActive: boolean;
  airdropX: number | null;
  airdropY: number | null;
  airdropAiAlive: number;
  summary: Record<string, unknown>;
}

interface TimelinePlayer {
  steamId: string;
  name: string;
  online: number;
  x: number | null;
  y: number | null;
  z: number | null;
  health: number;
  maxHealth: number;
  hunger: number;
  thirst: number;
  infection: number;
  stamina: number;
  level: number;
  zeeksKilled: number;
  daysSurvived: number;
  lifetimeKills: number;
}

interface TimelineAI {
  aiType: string;
  category: string;
  displayName: string;
  nodeUid: string;
  x: number | null;
  y: number | null;
  z: number | null;
}

interface TimelineVehicle {
  class: string;
  displayName: string;
  x: number | null;
  y: number | null;
  z: number | null;
  health: number;
  maxHealth: number;
  fuel: number;
  itemCount: number;
}

interface TimelineStructure {
  actorClass: string;
  displayName: string;
  ownerSteamId: string;
  x: number | null;
  y: number | null;
  z: number | null;
  currentHealth: number;
  maxHealth: number;
  upgradeLevel: number;
}

interface TimelineHouse {
  uid: string;
  name: string;
  windowsOpen: number;
  windowsTotal: number;
  doorsOpen: number;
  doorsLocked: number;
  doorsTotal: number;
  destroyedFurniture: number;
  hasGenerator: boolean;
  sleepers: number;
  clean: number;
  x: null;
  y: null;
}

interface TimelineCompanion {
  entityType: string;
  actorName: string;
  displayName: string;
  ownerSteamId: string;
  x: number | null;
  y: number | null;
  z: number | null;
  health: number;
  extra: Record<string, unknown>;
}

interface TimelineBackpack {
  class: string;
  x: number | null;
  y: number | null;
  z: number | null;
  itemCount: number;
  items: { item: string; amount: number }[];
}

// Loose save-data shapes — save-parser is not yet migrated
type SaveEntity = Record<string, unknown>;

interface SaveData {
  players?: Map<string, SaveEntity> | Record<string, SaveEntity> | SaveEntity[];
  worldState?: Record<string, unknown>;
  vehicles?: Map<string, SaveEntity> | Record<string, SaveEntity> | SaveEntity[];
  structures?: Map<string, SaveEntity> | Record<string, SaveEntity> | SaveEntity[];
  containers?: Map<string, SaveEntity> | Record<string, SaveEntity> | SaveEntity[];
  companions?: Map<string, SaveEntity> | Record<string, SaveEntity> | SaveEntity[];
  horses?: Map<string, SaveEntity> | Record<string, SaveEntity> | SaveEntity[];
}

interface RecordSnapshotOptions {
  onlinePlayers?: Set<string>;
}

export interface SnapshotServiceOptions {
  label?: string;
  retentionDays?: number;
  trackStructures?: boolean;
  trackHouses?: boolean;
  trackBackpacks?: boolean;
}

export class SnapshotService {
  private _db: HumanitZDB;
  private _log: Logger;
  private _retentionDays: number;
  private _trackStructures: boolean;
  private _trackHouses: boolean;
  private _trackBackpacks: boolean;
  private _lastSnapshotId: number | null = null;
  private _snapshotCount: number = 0;
  private _pruneCounter: number = 0;

  /**
   * @param db - HumanitZDB instance
   * @param options
   * @param options.label - Log prefix
   * @param options.retentionDays - How many days to keep timeline data (default: 14)
   * @param options.trackStructures - Track structures in timeline (can be large, default: true)
   * @param options.trackHouses - Track house state in timeline (default: true)
   * @param options.trackBackpacks - Track dropped backpacks (default: true)
   */
  constructor(db: HumanitZDB, options: SnapshotServiceOptions = {}) {
    this._db = db;
    this._log = createLogger(options.label, 'TIMELINE');
    this._retentionDays = options.retentionDays ?? 14;
    this._trackStructures = options.trackStructures !== false;
    this._trackHouses = options.trackHouses !== false;
    this._trackBackpacks = options.trackBackpacks !== false;
  }

  /**
   * Record a complete world snapshot from parsed save data.
   * Called after each successful save poll.
   *
   * @param saveData - The full parsed save object (from save-cache.json or parseSave())
   * @param options
   * @param options.onlinePlayers - Set of currently online player names (lowercase)
   * @returns The snapshot ID, or null if failed
   */
  recordSnapshot(saveData: SaveData, options: RecordSnapshotOptions = {}): number | null {
    if (!(saveData as SaveData | null | undefined)) return null;

    try {
      const ws: Record<string, unknown> = saveData.worldState ?? {};
      const players = this._normalizeToArray(saveData.players);
      const vehicles = this._normalizeToArray(saveData.vehicles);
      const structures = this._normalizeToArray(saveData.structures);
      const containers = this._normalizeToArray(saveData.containers);
      const aiSpawns = (ws['aiSpawns'] as SaveEntity[] | undefined) ?? [];
      const houses = (ws['houses'] as SaveEntity[] | undefined) ?? [];
      const backpacks = (ws['droppedBackpacks'] as SaveEntity[] | undefined) ?? [];
      const companions = this._normalizeToArray(saveData.companions);
      const horses = this._normalizeToArray(saveData.horses);
      const onlineSet = options.onlinePlayers ?? new Set<string>();

      const timeOfDay = ws['timeOfDay'] as Record<string, unknown> | number | undefined;
      const gameTime =
        typeof timeOfDay === 'object' ? ((timeOfDay['time'] as number | undefined) ?? 0) : (timeOfDay ?? 0);
      const gameDay =
        typeof timeOfDay === 'object'
          ? ((ws['totalDaysElapsed'] as number | undefined) ?? (timeOfDay['day'] as number | undefined) ?? 0)
          : ((ws['totalDaysElapsed'] as number | undefined) ?? 0);

      const airdrop = ws['airdrop'] as Record<string, unknown> | undefined;

      // Build snapshot header
      const snapshot: SnapshotHeader = {
        gameDay,
        gameTime,
        playerCount: players.length,
        onlineCount:
          onlineSet.size ||
          players.filter((p) => onlineSet.has(((p['name'] as string | undefined) ?? '').toLowerCase())).length,
        aiCount: aiSpawns.length,
        structureCount: structures.length,
        vehicleCount: vehicles.length,
        containerCount: containers.length,
        worldItemCount: ((ws['lodPickups'] as unknown[] | undefined) ?? []).length,
        weatherType: this._resolveWeather(ws['weatherState']),
        season: this._resolveSeason(ws),
        airdropActive: !!airdrop?.['uid'],
        airdropX: (airdrop?.['x'] as number | undefined) ?? null,
        airdropY: (airdrop?.['y'] as number | undefined) ?? null,
        airdropAiAlive: (airdrop?.['aiAlive'] as number | undefined) ?? 0,
        summary: {
          gameDifficulty: (ws['gameDifficulty'] as Record<string, unknown> | undefined) ?? {},
          heliCrash: (ws['heliCrashData'] as unknown[] | undefined) ?? [],
          destroyedSleepers: (ws['destroyedSleepers'] as unknown[] | undefined)?.length ?? 0,
          destroyedRandCars: (ws['destroyedRandCars'] as unknown[] | undefined)?.length ?? 0,
          explodableBarrels: (ws['explodableBarrels'] as unknown[] | undefined)?.length ?? 0,
          buildingDecayCount: (ws['buildingDecayCount'] as number | undefined) ?? 0,
        },
      };

      // Build entity arrays
      const timelinePlayers: TimelinePlayer[] = players.map((p) => ({
        steamId: (p['steamId'] as string | undefined) ?? (p['steam_id'] as string | undefined) ?? '',
        name: (p['name'] as string | undefined) ?? '',
        online: onlineSet.has(((p['name'] as string | undefined) ?? '').toLowerCase()) ? 1 : 0,
        x: (p['x'] as number | undefined) ?? (p['pos_x'] as number | undefined) ?? null,
        y: (p['y'] as number | undefined) ?? (p['pos_y'] as number | undefined) ?? null,
        z: (p['z'] as number | undefined) ?? (p['pos_z'] as number | undefined) ?? null,
        health: (p['health'] as number | undefined) ?? 0,
        maxHealth: (p['maxHealth'] as number | undefined) ?? (p['max_health'] as number | undefined) ?? 100,
        hunger: (p['hunger'] as number | undefined) ?? 0,
        thirst: (p['thirst'] as number | undefined) ?? 0,
        infection: (p['infection'] as number | undefined) ?? 0,
        stamina: (p['stamina'] as number | undefined) ?? 0,
        level: (p['level'] as number | undefined) ?? 0,
        zeeksKilled: (p['zeeksKilled'] as number | undefined) ?? (p['zeeks_killed'] as number | undefined) ?? 0,
        daysSurvived: (p['daysSurvived'] as number | undefined) ?? (p['days_survived'] as number | undefined) ?? 0,
        lifetimeKills: (p['lifetimeKills'] as number | undefined) ?? (p['lifetime_kills'] as number | undefined) ?? 0,
      }));

      // Filter out dead AI (graveTimeMinutes > 0 means killed, waiting to respawn)
      const aliveAI = aiSpawns.filter(
        (a) => !(a['graveTimeMinutes'] as number | undefined) || (a['graveTimeMinutes'] as number) <= 0,
      );
      const timelineAI: TimelineAI[] = aliveAI.map((a) => {
        const aiType = (a['type'] as string | undefined) ?? 'Unknown';
        return {
          aiType,
          category: (a['category'] as string | undefined) ?? this._classifyAICategory(aiType),
          displayName: AI_DISPLAY_NAMES[aiType] ?? cleanName(aiType),
          nodeUid: (a['nodeUid'] as string | undefined) ?? '',
          x: (a['x'] as number | undefined) ?? null,
          y: (a['y'] as number | undefined) ?? null,
          z: (a['z'] as number | undefined) ?? null,
        };
      });

      const timelineVehicles: TimelineVehicle[] = vehicles.map((v) => ({
        class: (v['class'] as string | undefined) ?? '',
        displayName: (v['displayName'] as string | undefined) ?? cleanName((v['class'] as string | undefined) ?? ''),
        x: (v['x'] as number | undefined) ?? (v['pos_x'] as number | undefined) ?? null,
        y: (v['y'] as number | undefined) ?? (v['pos_y'] as number | undefined) ?? null,
        z: (v['z'] as number | undefined) ?? (v['pos_z'] as number | undefined) ?? null,
        health: (v['health'] as number | undefined) ?? 0,
        maxHealth: (v['maxHealth'] as number | undefined) ?? (v['max_health'] as number | undefined) ?? 0,
        fuel: (v['fuel'] as number | undefined) ?? 0,
        itemCount: ((v['inventory'] as unknown[] | undefined) ?? []).length,
      }));

      const timelineStructures: TimelineStructure[] = this._trackStructures
        ? structures.map((s) => ({
            actorClass: (s['actorClass'] as string | undefined) ?? (s['actor_class'] as string | undefined) ?? '',
            displayName:
              (s['displayName'] as string | undefined) ??
              (s['display_name'] as string | undefined) ??
              cleanName((s['actorClass'] as string | undefined) ?? (s['actor_class'] as string | undefined) ?? ''),
            ownerSteamId:
              (s['ownerSteamId'] as string | undefined) ?? (s['owner_steam_id'] as string | undefined) ?? '',
            x: (s['x'] as number | undefined) ?? (s['pos_x'] as number | undefined) ?? null,
            y: (s['y'] as number | undefined) ?? (s['pos_y'] as number | undefined) ?? null,
            z: (s['z'] as number | undefined) ?? (s['pos_z'] as number | undefined) ?? null,
            currentHealth:
              (s['currentHealth'] as number | undefined) ?? (s['current_health'] as number | undefined) ?? 0,
            maxHealth: (s['maxHealth'] as number | undefined) ?? (s['max_health'] as number | undefined) ?? 0,
            upgradeLevel: (s['upgradeLevel'] as number | undefined) ?? (s['upgrade_level'] as number | undefined) ?? 0,
          }))
        : [];

      const timelineHouses: TimelineHouse[] = this._trackHouses
        ? houses.map((h) => {
            const floatData = h['floatData'] as Record<string, number> | undefined;
            return {
              uid: (h['uid'] as string | undefined) ?? '',
              name: (h['name'] as string | undefined) ?? '',
              windowsOpen: (h['windowsOpen'] as number | undefined) ?? 0,
              windowsTotal: (h['windowsTotal'] as number | undefined) ?? 0,
              doorsOpen: (h['doorsOpen'] as number | undefined) ?? 0,
              doorsLocked: (h['doorsLocked'] as number | undefined) ?? 0,
              doorsTotal: (h['doorsTotal'] as number | undefined) ?? 0,
              destroyedFurniture: (h['destroyedFurniture'] as number | undefined) ?? 0,
              hasGenerator: !!h['hasGenerator'],
              sleepers: floatData?.['Sleepers'] ?? (h['sleepers'] as number | undefined) ?? 0,
              clean: floatData?.['Clean'] ?? (h['clean'] as number | undefined) ?? 0,
              x: null, // houses don't have positions in save data
              y: null,
            };
          })
        : [];

      // Merge companions + horses into one timeline array
      const timelineCompanions: TimelineCompanion[] = [
        ...companions.map((c) => ({
          entityType: (c['type'] as string | undefined) ?? 'dog',
          actorName: (c['actorName'] as string | undefined) ?? (c['actor_name'] as string | undefined) ?? '',
          displayName: cleanName(
            (c['actorName'] as string | undefined) ?? (c['actor_name'] as string | undefined) ?? '',
          ),
          ownerSteamId: (c['ownerSteamId'] as string | undefined) ?? (c['owner_steam_id'] as string | undefined) ?? '',
          x: (c['x'] as number | undefined) ?? (c['pos_x'] as number | undefined) ?? null,
          y: (c['y'] as number | undefined) ?? (c['pos_y'] as number | undefined) ?? null,
          z: (c['z'] as number | undefined) ?? (c['pos_z'] as number | undefined) ?? null,
          health: (c['health'] as number | undefined) ?? 0,
          extra: (c['extra'] as Record<string, unknown> | undefined) ?? {},
        })),
        ...horses.map((h) => {
          const extra = h['extra'] as Record<string, number> | undefined;
          return {
            entityType: 'horse',
            actorName: (h['actorName'] as string | undefined) ?? (h['actor_name'] as string | undefined) ?? '',
            displayName:
              (h['horseName'] as string | undefined) ??
              (h['horse_name'] as string | undefined) ??
              (h['displayName'] as string | undefined) ??
              (h['display_name'] as string | undefined) ??
              'Horse',
            ownerSteamId:
              (h['ownerSteamId'] as string | undefined) ?? (h['owner_steam_id'] as string | undefined) ?? '',
            x: (h['x'] as number | undefined) ?? (h['pos_x'] as number | undefined) ?? null,
            y: (h['y'] as number | undefined) ?? (h['pos_y'] as number | undefined) ?? null,
            z: (h['z'] as number | undefined) ?? (h['pos_z'] as number | undefined) ?? null,
            health: (h['health'] as number | undefined) ?? 0,
            extra: {
              energy: (h['energy'] as number | undefined) ?? 0,
              stamina: (h['stamina'] as number | undefined) ?? 0,
              saddle: extra?.['Saddle'] ?? 0,
            },
          };
        }),
      ];

      const timelineBackpacks: TimelineBackpack[] = this._trackBackpacks
        ? backpacks.map((b) => {
            const items = ((b['items'] as SaveEntity[] | undefined) ?? []).slice(0, 10);
            return {
              class: (b['class'] as string | undefined) ?? '',
              x: (b['x'] as number | undefined) ?? null,
              y: (b['y'] as number | undefined) ?? null,
              z: (b['z'] as number | undefined) ?? null,
              itemCount: ((b['items'] as unknown[] | undefined) ?? []).length,
              items: items.map((i) => ({
                item: (i['item'] as string | undefined) ?? '',
                amount: (i['amount'] as number | undefined) ?? 1,
              })),
            };
          })
        : [];

      // Write to DB
      const snapId = this._db.insertTimelineSnapshot({
        snapshot,
        players: timelinePlayers,
        ai: timelineAI,
        vehicles: timelineVehicles,
        structures: timelineStructures,
        houses: timelineHouses,
        companions: timelineCompanions,
        backpacks: timelineBackpacks,
      });

      this._lastSnapshotId = snapId;
      this._snapshotCount++;

      // Periodic pruning (every 12 snapshots ≈ 1 hour at 5-min intervals)
      this._pruneCounter++;
      if (this._pruneCounter >= 12) {
        this._pruneCounter = 0;
        this._pruneOldData();
      }

      const entityCount =
        timelinePlayers.length +
        timelineAI.length +
        timelineVehicles.length +
        timelineStructures.length +
        timelineHouses.length +
        timelineCompanions.length +
        timelineBackpacks.length;
      this._log.info(
        `Snapshot #${String(this._snapshotCount)} recorded (${String(entityCount)} entities, id=${String(snapId)})`,
      );

      return snapId;
    } catch (err) {
      this._log.error('Failed to record snapshot:', errMsg(err));
      return null;
    }
  }

  /** Get the most recent snapshot ID. */
  get lastSnapshotId(): number | null {
    return this._lastSnapshotId;
  }

  /** Get total snapshots recorded this session. */
  get snapshotCount(): number {
    return this._snapshotCount;
  }

  // ── Internal helpers ───────────────────────────────────────

  /** Convert Map or object to array of values. */
  private _normalizeToArray(
    data: Map<string, SaveEntity> | Record<string, SaveEntity> | SaveEntity[] | undefined | null,
  ): SaveEntity[] {
    if (!data) return [];
    if (Array.isArray(data)) return data;
    if (data instanceof Map) return [...data.values()];
    return Object.values(data);
  }

  /** Classify AI type into category. */
  private _classifyAICategory(type: string): string {
    if (!type) return 'unknown';
    if (/^Bandit/i.test(type)) return 'bandit';
    if (/^Animal(?!Z)/i.test(type)) return 'animal';
    return 'zombie';
  }

  /** Resolve weather type from UDS weather state. */
  private _resolveWeather(weatherState: unknown): string {
    if (!weatherState || !Array.isArray(weatherState)) return '';
    const udw = (weatherState as Array<Record<string, unknown>>).find((w) => w['name'] === 'UDWRandomWeatherState');
    if (!udw || !udw['children']) return '';
    const current = (udw['children'] as Array<Record<string, unknown>>).find(
      (c) => c['name'] === 'CurrentRandomWeatherType',
    );
    if (!current) return '';
    // Map UDS enumerator to human name
    const weatherMap: Record<string, string> = {
      'UDS_WeatherTypes::NewEnumerator0': 'Clear',
      'UDS_WeatherTypes::NewEnumerator1': 'Partly Cloudy',
      'UDS_WeatherTypes::NewEnumerator2': 'Cloudy',
      'UDS_WeatherTypes::NewEnumerator3': 'Overcast',
      'UDS_WeatherTypes::NewEnumerator4': 'Light Rain',
      'UDS_WeatherTypes::NewEnumerator5': 'Rain',
      'UDS_WeatherTypes::NewEnumerator6': 'Thunderstorm',
      'UDS_WeatherTypes::NewEnumerator7': 'Light Snow',
      'UDS_WeatherTypes::NewEnumerator8': 'Snow',
      'UDS_WeatherTypes::NewEnumerator9': 'Blizzard',
      'UDS_WeatherTypes::NewEnumerator10': 'Fog',
    };
    const value = current['value'] as string | undefined;
    return (value ? weatherMap[value] : undefined) ?? value ?? '';
  }

  /** Resolve current season from world state. */
  private _resolveSeason(ws: Record<string, unknown>): string {
    // Check for season in weather state
    if (ws['weatherState'] && Array.isArray(ws['weatherState'])) {
      // Could derive season from SimulationDate, but for now return
      // the dedicated season field if present
      void (ws['weatherState'] as Array<Record<string, unknown>>).find((w) => w['name'] === 'SimulationDate');
    }
    // Check direct season field
    if (ws['currentSeason']) return ws['currentSeason'] as string;
    // Derive from total days (roughly 30-day seasons)
    const days = (ws['totalDaysElapsed'] as number | undefined) ?? 0;
    const seasonIdx = Math.floor((days % 120) / 30);
    return ['Spring', 'Summer', 'Autumn', 'Winter'][seasonIdx] ?? 'Unknown';
  }

  /** Prune old timeline data beyond retention period. */
  private _pruneOldData(): void {
    try {
      const result = this._db.purgeOldTimeline(`-${String(this._retentionDays)} days`);
      if (result.changes > 0) {
        this._log.info(`Pruned ${String(result.changes)} old timeline snapshots (>${String(this._retentionDays)}d)`);
      }
    } catch (err) {
      this._log.warn('Failed to prune timeline:', errMsg(err));
    }
  }
}

export default SnapshotService;

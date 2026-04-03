/**
 * KillTracker — lifetime stat accumulation across deaths.
 *
 * Tracks per-player kill/survival/activity deltas between save polls and
 * accumulates lifetime totals even when the game resets stats on death.
 * Handles two code paths:
 *   - ExtendedStats (newer saves): lifetime values in save, never reset
 *   - Legacy (older saves): GameStats resets on death, we "bank" pre-death values
 *
 * This is the shared data layer consumed by:
 *   - PlayerStatsChannel (Discord embeds + activity feed)
 *   - Web panel API endpoints
 *   - howyagarn features (player cards, newspaper, etc.)
 *
 * @module tracking/kill-tracker
 */

import config from '../config/index.js';
import playtimeSingleton from './playtime-tracker.js';
import type { PlaytimeTracker } from './playtime-tracker.js';
import playerStatsSingleton from './player-stats.js';
import type { PlayerStats } from './player-stats.js';
import { createLogger, type Logger } from '../utils/log.js';

type ConfigType = typeof config;
type PlaytimeType = InstanceType<typeof PlaytimeTracker>;
type PlayerStatsType = InstanceType<typeof PlayerStats>;

// ═══════════════════════════════════════════════════════════════════════════
//  Types
// ═══════════════════════════════════════════════════════════════════════════

// Loose save-data shape — save-parser is not yet migrated
type SaveEntry = Record<string, unknown>;

interface ResolvedPlayer {
  name: string;
  firstSeen: string | null;
  lastActive: string | null;
  playtime: ReturnType<PlaytimeType['getPlaytime']>;
  log: ReturnType<PlayerStatsType['getStats']>;
  save: SaveEntry | null;
}

interface KillObj {
  zeeksKilled: number;
  headshots: number;
  meleeKills: number;
  gunKills: number;
  blastKills: number;
  fistKills: number;
  takedownKills: number;
  vehicleKills: number;
}

interface SurvivalObj {
  daysSurvived: number;
}

type ScalarActivityObj = Record<string, number>;
type ArrayActivityObj = Record<string, unknown[]>;
type ChallengeObj = Record<string, number>;

interface PlayerKillRecord {
  cumulative: KillObj;
  lastSnapshot: KillObj;
  survivalCumulative: SurvivalObj;
  survivalSnapshot: SurvivalObj;
  hasExtendedStats: boolean;
  deathCheckpoint: KillObj | null;
  lastKnownDeaths: number;
  lifetimeSnapshot: KillObj | null;
  survivalLifetimeSnapshot: SurvivalObj | null;
  lastLifetimeSnapshot: KillObj | null;
  lastSurvivalLifetimeSnapshot: SurvivalObj | null;
  activitySnapshot: ScalarActivityObj;
  activityArraySnapshot: ArrayActivityObj;
  challengeSnapshot: ChallengeObj;
}

interface TrackerData {
  players: Record<string, PlayerKillRecord>;
  lastPollDate?: string | null;
}

interface KillDelta {
  steamId: string;
  name: string;
  delta: Partial<KillObj>;
}

interface SurvivalDelta {
  steamId: string;
  name: string;
  delta: Partial<SurvivalObj>;
}

interface FishingDelta {
  steamId: string;
  name: string;
  delta: Record<string, number>;
}

interface RecipeDelta {
  steamId: string;
  name: string;
  type: string;
  items: unknown[];
}

interface SkillDelta {
  steamId: string;
  name: string;
  items: unknown[];
}

interface ProfessionDelta {
  steamId: string;
  name: string;
  items: unknown[];
}

interface LoreDelta {
  steamId: string;
  name: string;
  items: unknown[];
}

interface UniqueDelta {
  steamId: string;
  name: string;
  type: string;
  items: unknown[];
}

interface CompanionDelta {
  steamId: string;
  name: string;
  type: string;
  items: unknown[];
}

interface ChallengeDelta {
  steamId: string;
  name: string;
  completed: { key: string; name: string; desc: string }[];
}

interface AccumulateResult {
  deltas: {
    killDeltas: KillDelta[];
    survivalDeltas: SurvivalDelta[];
    fishingDeltas: FishingDelta[];
    recipeDeltas: RecipeDelta[];
    skillDeltas: SkillDelta[];
    professionDeltas: ProfessionDelta[];
    loreDeltas: LoreDelta[];
    uniqueDeltas: UniqueDelta[];
    companionDeltas: CompanionDelta[];
    challengeDeltas: ChallengeDelta[];
  };
  targetDate: string;
}

interface WeeklyStats {
  weekStart: string | null;
  topKillers: { name: string; kills: number }[];
  topPvpKillers: { name: string; kills: number }[];
  topFishers: { name: string; count: number }[];
  topBitten: { name: string; count: number }[];
  topPlaytime: { name: string; ms: number }[];
}

interface PlayerBaseline {
  kills: number;
  pvpKills: number;
  fish: number;
  bitten: number;
  playtimeMs: number;
  craftingRecipes: number;
  buildingRecipes: number;
  unlockedSkills: number;
  unlockedProfessions: number;
  lore: number;
  uniqueLoots: number;
  craftedUniques: number;
  companions: number;
}

interface WeeklyBaseline {
  weekStart: string | null;
  players: Record<string, PlayerBaseline>;
}

interface GameData {
  CHALLENGE_DESCRIPTIONS: Record<string, { name: string; desc: string; target?: number }>;
}

// Minimal DB interface (src/db not yet migrated)
interface HumanitZDB {
  getStateJSON(key: string, fallback: null): unknown;
  setStateJSON(key: string, data: unknown): void;
}

export interface KillTrackerDeps {
  config?: ConfigType;
  playtime?: PlaytimeType;
  playerStats?: PlayerStatsType;
  db?: HumanitZDB | null;
  label?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Standalone player resolver — shared between KillTracker and PSC
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Cross-validated player name/timestamp resolver.
 * Picks the most-recent-event name from playtime and log sources.
 */
export function resolvePlayer(
  steamId: string,
  deps: { playtime: PlaytimeType; playerStats: PlayerStatsType; saveData: Map<string, SaveEntry> },
): ResolvedPlayer {
  const pt = deps.playtime.getPlaytime(steamId);
  const log = deps.playerStats.getStats(steamId);
  const save = deps.saveData instanceof Map ? (deps.saveData.get(steamId) ?? null) : null;

  // Name resolution: most-recent-event wins
  let name: string;
  const ptName = pt?.name;
  const logName = log?.name;

  if (ptName && logName) {
    if (ptName !== logName) {
      const ptTime = ptName && pt.lastSeen ? new Date(pt.lastSeen).getTime() : 0;
      const logTime = logName && log.lastEvent ? new Date(log.lastEvent).getTime() : 0;
      name = ptTime >= logTime ? ptName : logName;
    } else {
      name = ptName;
    }
  } else {
    name = ptName ?? logName ?? deps.playerStats.getNameForId(steamId);
  }

  // Last active: max of both timestamps
  const ptLastSeen = pt?.lastSeen ? new Date(pt.lastSeen).getTime() : 0;
  const logLastEvent = log?.lastEvent ? new Date(log.lastEvent).getTime() : 0;
  const lastActiveMs = Math.max(ptLastSeen, logLastEvent);
  const lastActive = lastActiveMs > 0 ? new Date(lastActiveMs).toISOString() : null;

  const firstSeen = pt?.firstSeen ?? null;

  return { name, firstSeen, lastActive, playtime: pt, log, save };
}

// ═══════════════════════════════════════════════════════════════════════════
//  KillTracker
// ═══════════════════════════════════════════════════════════════════════════

export class KillTracker {
  // ── Key arrays (shared between tracker and embeds) ──
  static readonly KILL_KEYS: readonly (keyof KillObj)[] = [
    'zeeksKilled',
    'headshots',
    'meleeKills',
    'gunKills',
    'blastKills',
    'fistKills',
    'takedownKills',
    'vehicleKills',
  ];
  static readonly SURVIVAL_KEYS: readonly (keyof SurvivalObj)[] = ['daysSurvived'];
  static readonly ACTIVITY_SCALAR_KEYS: readonly string[] = ['fishCaught', 'fishCaughtPike', 'timesBitten'];
  static readonly CHALLENGE_KEYS: readonly string[] = [
    'challengeKillZombies',
    'challengeKill50',
    'challengeCatch20Fish',
    'challengeRegularAngler',
    'challengeKillZombieBear',
    'challenge9Squares',
    'challengeCraftFirearm',
    'challengeCraftFurnace',
    'challengeCraftMeleeBench',
    'challengeCraftMeleeWeapon',
    'challengeCraftRainCollector',
    'challengeCraftTablesaw',
    'challengeCraftTreatment',
    'challengeCraftWeaponsBench',
    'challengeCraftWorkbench',
    'challengeFindDog',
    'challengeFindHeli',
    'challengeLockpickSUV',
    'challengeRepairRadio',
  ];
  static readonly ACTIVITY_ARRAY_KEYS: readonly string[] = [
    'craftingRecipes',
    'buildingRecipes',
    'unlockedSkills',
    'unlockedProfessions',
    'lore',
    'lootItemUnique',
    'craftedUniques',
    'companionData',
    'horses',
  ];
  static readonly LIFETIME_KEY_MAP: Record<string, string> = {
    zeeksKilled: 'lifetimeKills',
    headshots: 'lifetimeHeadshots',
    meleeKills: 'lifetimeMeleeKills',
    gunKills: 'lifetimeGunKills',
    blastKills: 'lifetimeBlastKills',
    fistKills: 'lifetimeFistKills',
    takedownKills: 'lifetimeTakedownKills',
    vehicleKills: 'lifetimeVehicleKills',
  };

  private _config: ConfigType;
  private _playtime: PlaytimeType;
  private _playerStats: PlayerStatsType;
  private _db: HumanitZDB | null;
  private _log: Logger;
  private _data: TrackerData;
  private _dirty: boolean;

  constructor(deps: KillTrackerDeps = {}) {
    this._config = deps.config ?? config;
    this._playtime = deps.playtime ?? playtimeSingleton;
    this._playerStats = deps.playerStats ?? playerStatsSingleton;
    this._db = deps.db ?? null;
    this._log = createLogger(deps.label, 'KillTracker');

    // { players: { steamId: { cumulative, lastSnapshot, survivalCumulative, ... } } }
    this._data = { players: {} };
    this._dirty = false;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Persistence
  // ═══════════════════════════════════════════════════════════════════════════

  load(): void {
    try {
      let raw: TrackerData | null = null;
      if (this._db) {
        raw = this._db.getStateJSON('kill_tracker', null) as TrackerData | null;
        if (raw) {
          this._data = raw;
          const count = Object.keys(this._data.players).length;
          this._log.info(`Loaded ${String(count)} player(s) from kill tracker (DB)`);
        }
      }
      if (raw) {
        // Migrate old records loaded from JSON: fields may be missing in older saves.
        // We cast to unknown first so TypeScript allows the falsy checks on required fields.
        for (const r of Object.values(this._data.players)) {
          const record = r as unknown as Record<string, unknown> & PlayerKillRecord;
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime game event data may have unexpected shape
          if (!record.survivalCumulative) {
            record.survivalCumulative = KillTracker._emptySurvival();
          }
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime game event data may have unexpected shape
          if (!record.survivalSnapshot) {
            record.survivalSnapshot = KillTracker._emptySurvival();
          }
          if (!record.deathCheckpoint) record.deathCheckpoint = null;
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime game event data may have unexpected shape
          if (record.lastKnownDeaths === undefined) record.lastKnownDeaths = 0;
          if (!record.lifetimeSnapshot) record.lifetimeSnapshot = null;
          if (!record.survivalLifetimeSnapshot) record.survivalLifetimeSnapshot = null;
          if (!record.lastLifetimeSnapshot) {
            record.lastLifetimeSnapshot = record.lifetimeSnapshot ? { ...record.lifetimeSnapshot } : null;
          }
          if (!record.lastSurvivalLifetimeSnapshot) {
            record.lastSurvivalLifetimeSnapshot = record.survivalLifetimeSnapshot
              ? { ...record.survivalLifetimeSnapshot }
              : null;
          }
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime game event data may have unexpected shape
          if (!record.activitySnapshot) {
            record.activitySnapshot = KillTracker._emptyObj(KillTracker.ACTIVITY_SCALAR_KEYS);
          }
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime game event data may have unexpected shape
          if (!record.activityArraySnapshot) {
            record.activityArraySnapshot = {};
            for (const k of KillTracker.ACTIVITY_ARRAY_KEYS) record.activityArraySnapshot[k] = [];
          }
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime game event data may have unexpected shape
          if (!record.challengeSnapshot) {
            record.challengeSnapshot = KillTracker._emptyObj(KillTracker.CHALLENGE_KEYS);
          }
        }
      }
    } catch (err) {
      this._log.error('Failed to load kill tracker, starting fresh:', (err as Error).message);
      this._data = { players: {} };
    }
  }

  save(): void {
    if (!this._dirty) return;
    try {
      if (this._db) this._db.setStateJSON('kill_tracker', this._data);
      this._dirty = false;
    } catch (err) {
      this._log.error('Failed to save kill tracker:', (err as Error).message);
    }
  }

  /** Expose raw data for PSC's _cacheWelcomeStats and embed builders */
  get players(): Record<string, PlayerKillRecord> {
    return this._data.players;
  }

  get lastPollDate(): string | null {
    return this._data.lastPollDate ?? null;
  }

  set lastPollDate(v: string | null) {
    this._data.lastPollDate = v;
    this._dirty = true;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Static helpers
  // ═══════════════════════════════════════════════════════════════════════════

  static _emptyObj(keys: readonly string[]): Record<string, number> {
    const obj: Record<string, number> = {};
    for (const k of keys) obj[k] = 0;
    return obj;
  }

  static _emptyKills(): KillObj {
    return KillTracker._emptyObj(KillTracker.KILL_KEYS) as unknown as KillObj;
  }

  static _emptySurvival(): SurvivalObj {
    return { daysSurvived: 0 };
  }

  static _snapshotKills(save: SaveEntry): KillObj {
    const obj: KillObj = KillTracker._emptyKills();
    for (const k of KillTracker.KILL_KEYS) {
      obj[k] = (save[k] as number | undefined) ?? 0;
    }
    return obj;
  }

  static _snapshotSurvival(save: SaveEntry): SurvivalObj {
    return { daysSurvived: (save['daysSurvived'] as number | undefined) ?? 0 };
  }

  static _snapshotChallenges(save: SaveEntry): ChallengeObj {
    const obj: ChallengeObj = {};
    for (const k of KillTracker.CHALLENGE_KEYS) obj[k] = (save[k] as number | undefined) ?? 0;
    return obj;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Accumulation — compute deltas between save polls
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Process a new save poll: compute deltas, update snapshots, return arrays.
   *
   * @param saveData - steamId → save data map
   * @param opts - { gameData } for challenge descriptions
   * @returns deltas object + which date they belong to
   */
  accumulate(saveData: Map<string, SaveEntry>, opts: { gameData?: GameData | null } = {}): AccumulateResult {
    const today = this._config.getToday();
    const gameData = opts.gameData ?? null;

    // Determine which date's thread these deltas belong to.
    const lastPollDate = this._data.lastPollDate ?? null;
    const targetDate = lastPollDate && lastPollDate !== today ? lastPollDate : today;
    this._data.lastPollDate = today;
    this._dirty = true;

    if (targetDate !== today) {
      this._log.info(`First poll after restart — pending deltas for ${targetDate}`);
    }

    const killDeltas: KillDelta[] = [];
    const survivalDeltas: SurvivalDelta[] = [];
    const fishingDeltas: FishingDelta[] = [];
    const recipeDeltas: RecipeDelta[] = [];
    const skillDeltas: SkillDelta[] = [];
    const professionDeltas: ProfessionDelta[] = [];
    const loreDeltas: LoreDelta[] = [];
    const uniqueDeltas: UniqueDelta[] = [];
    const companionDeltas: CompanionDelta[] = [];
    const challengeDeltas: ChallengeDelta[] = [];

    for (const [id, save] of saveData) {
      const currentKills = KillTracker._snapshotKills(save);
      const currentSurvival = KillTracker._snapshotSurvival(save);

      if (!this._data.players[id]) {
        // First time seeing this player — initialise
        const logDeaths = this._playerStats.getStats(id)?.deaths ?? 0;
        const actSnapshot: ScalarActivityObj = {};
        for (const k of KillTracker.ACTIVITY_SCALAR_KEYS) actSnapshot[k] = (save[k] as number | undefined) ?? 0;
        const arrSnapshot: ArrayActivityObj = {};
        for (const k of KillTracker.ACTIVITY_ARRAY_KEYS) {
          arrSnapshot[k] = Array.isArray(save[k]) ? [...(save[k] as unknown[])] : [];
        }
        const newRecord: PlayerKillRecord = {
          cumulative: KillTracker._emptyKills(),
          lastSnapshot: currentKills,
          survivalCumulative: KillTracker._emptySurvival(),
          survivalSnapshot: currentSurvival,
          hasExtendedStats: !!save['hasExtendedStats'],
          deathCheckpoint: null,
          lastKnownDeaths: logDeaths,
          lifetimeSnapshot: null,
          survivalLifetimeSnapshot: null,
          lastLifetimeSnapshot: null,
          lastSurvivalLifetimeSnapshot: null,
          activitySnapshot: actSnapshot,
          activityArraySnapshot: arrSnapshot,
          challengeSnapshot: KillTracker._snapshotChallenges(save),
        };
        this._data.players[id] = newRecord;
        // Cache lifetime values if available
        if (save['hasExtendedStats']) {
          const ls = KillTracker._emptyKills();
          for (const k of KillTracker.KILL_KEYS) {
            const lifetimeKey = KillTracker.LIFETIME_KEY_MAP[k];
            ls[k] = lifetimeKey ? ((save[lifetimeKey] as number | undefined) ?? 0) : 0;
          }
          newRecord.lifetimeSnapshot = ls;
          newRecord.lastLifetimeSnapshot = { ...ls };
          newRecord.survivalLifetimeSnapshot = {
            daysSurvived:
              (save['lifetimeDaysSurvived'] as number | undefined) ?? (save['daysSurvived'] as number | undefined) ?? 0,
          };
          newRecord.lastSurvivalLifetimeSnapshot = { ...newRecord.survivalLifetimeSnapshot };
        }
        this._dirty = true;
        continue;
      }

      const record = this._data.players[id];
      const lastKills = record.lastSnapshot;
      const lastSurvival = record.survivalSnapshot;
      const playerName = resolvePlayer(id, {
        playtime: this._playtime,
        playerStats: this._playerStats,
        saveData,
      }).name;

      // ExtendedStats path
      if (save['hasExtendedStats']) {
        record.hasExtendedStats = true;
        // Clear stale cumulative data
        if (record.cumulative.zeeksKilled > 0 || record.survivalCumulative.daysSurvived > 0) {
          this._log.info(`${id}: ExtendedStats available — clearing banked cumulative`);
          record.cumulative = KillTracker._emptyKills();
          record.survivalCumulative = KillTracker._emptySurvival();
        }
        // Cache lifetime values
        const ls = KillTracker._emptyKills();
        for (const k of KillTracker.KILL_KEYS) {
          const lifetimeKey = KillTracker.LIFETIME_KEY_MAP[k];
          ls[k] = lifetimeKey ? ((save[lifetimeKey] as number | undefined) ?? 0) : 0;
        }
        record.lifetimeSnapshot = ls;
        record.survivalLifetimeSnapshot = {
          daysSurvived:
            (save['lifetimeDaysSurvived'] as number | undefined) ?? (save['daysSurvived'] as number | undefined) ?? 0,
        };

        // Death checkpoint
        const logDeaths = this._playerStats.getStats(id)?.deaths ?? 0;
        const prevDeaths = record.lastKnownDeaths;
        if (logDeaths > prevDeaths) {
          const cp = KillTracker._emptyKills();
          for (const k of KillTracker.KILL_KEYS) {
            const lifetimeKey = KillTracker.LIFETIME_KEY_MAP[k];
            const lifetime = lifetimeKey ? ((save[lifetimeKey] as number | undefined) ?? 0) : 0;
            cp[k] = lifetime - currentKills[k];
          }
          record.deathCheckpoint = cp;
          record.lastKnownDeaths = logDeaths;
          this._log.info(
            `${id}: death #${String(logDeaths)} — checkpoint set (lifetime ${String((save['lifetimeKills'] as number | undefined) ?? 0)}, session ${String(currentKills.zeeksKilled)})`,
          );
          this._dirty = true;
        } else if (record.lastKnownDeaths !== logDeaths) {
          record.lastKnownDeaths = logDeaths;
          this._dirty = true;
        }
      } else {
        // Legacy fallback: detect death reset
        const deathReset = currentKills.zeeksKilled < lastKills.zeeksKilled;
        if (deathReset) {
          for (const k of KillTracker.KILL_KEYS) {
            record.cumulative[k] += lastKills[k];
          }
          for (const k of KillTracker.SURVIVAL_KEYS) {
            record.survivalCumulative[k] += lastSurvival[k];
          }
          this._log.info(
            `${id}: death detected — banked ${String(lastKills.zeeksKilled)} kills, ${String(lastSurvival.daysSurvived)} days`,
          );
          record.lastSnapshot = currentKills;
          record.survivalSnapshot = currentSurvival;
          this._dirty = true;
          continue;
        }
      }

      // ── Kill deltas ──
      const killDelta: Partial<KillObj> = {};
      let hasKills = false;
      if (record.hasExtendedStats && record.lifetimeSnapshot) {
        const prevLifetime = record.lastLifetimeSnapshot ?? KillTracker._emptyKills();
        for (const k of KillTracker.KILL_KEYS) {
          const diff = record.lifetimeSnapshot[k] - prevLifetime[k];
          if (diff > 0) {
            killDelta[k] = diff;
            hasKills = true;
          }
        }
        record.lastLifetimeSnapshot = { ...record.lifetimeSnapshot };
      } else {
        for (const k of KillTracker.KILL_KEYS) {
          const diff = currentKills[k] - lastKills[k];
          if (diff > 0) {
            killDelta[k] = diff;
            hasKills = true;
          }
        }
      }
      if (hasKills) {
        killDeltas.push({ steamId: id, name: playerName, delta: killDelta });
      }

      // ── Survival deltas ──
      const survDelta: Partial<SurvivalObj> = {};
      let hasSurv = false;
      if (record.hasExtendedStats && record.survivalLifetimeSnapshot) {
        const prevSurvLifetime = record.lastSurvivalLifetimeSnapshot ?? KillTracker._emptySurvival();
        for (const k of KillTracker.SURVIVAL_KEYS) {
          const diff = record.survivalLifetimeSnapshot[k] - prevSurvLifetime[k];
          if (diff > 0) {
            survDelta[k] = diff;
            hasSurv = true;
          }
        }
        record.lastSurvivalLifetimeSnapshot = { ...record.survivalLifetimeSnapshot };
      } else {
        for (const k of KillTracker.SURVIVAL_KEYS) {
          const diff = currentSurvival[k] - lastSurvival[k];
          if (diff > 0) {
            survDelta[k] = diff;
            hasSurv = true;
          }
        }
      }
      if (hasSurv) {
        survivalDeltas.push({ steamId: id, name: playerName, delta: survDelta });
      }

      // ── Activity scalar diffs (fishing, bites) ──
      const prevAct = record.activitySnapshot;
      const fishDelta: Record<string, number> = {};
      let hasFish = false;
      for (const k of KillTracker.ACTIVITY_SCALAR_KEYS) {
        const diff = ((save[k] as number | undefined) ?? 0) - (prevAct[k] ?? 0);
        if (diff > 0) {
          fishDelta[k] = diff;
          hasFish = true;
        }
      }
      if (hasFish) {
        fishingDeltas.push({ steamId: id, name: playerName, delta: fishDelta });
      }
      const newActSnapshot: ScalarActivityObj = {};
      for (const k of KillTracker.ACTIVITY_SCALAR_KEYS) newActSnapshot[k] = (save[k] as number | undefined) ?? 0;
      record.activitySnapshot = newActSnapshot;

      // ── Activity array diffs (recipes, skills, professions, lore, uniques, companions) ──
      const prevArr = record.activityArraySnapshot;
      const newArrSnapshot: ArrayActivityObj = {};
      for (const k of KillTracker.ACTIVITY_ARRAY_KEYS) {
        const current = Array.isArray(save[k]) ? (save[k] as unknown[]) : [];
        const prev = Array.isArray(prevArr[k]) ? prevArr[k] : [];
        newArrSnapshot[k] = [...current];

        if (current.length > prev.length) {
          const toKey = (v: unknown): string =>
            v !== null && typeof v === 'object'
              ? JSON.stringify(v as Record<string, unknown>)
              : String(v as string | number | boolean);
          const prevSet = new Set(prev.map(toKey));
          const newItems = current.filter((v) => !prevSet.has(toKey(v)));
          if (newItems.length > 0) {
            if (k === 'craftingRecipes' || k === 'buildingRecipes') {
              recipeDeltas.push({
                steamId: id,
                name: playerName,
                type: k === 'craftingRecipes' ? 'Crafting' : 'Building',
                items: newItems,
              });
            } else if (k === 'unlockedSkills') {
              skillDeltas.push({ steamId: id, name: playerName, items: newItems });
            } else if (k === 'unlockedProfessions') {
              professionDeltas.push({ steamId: id, name: playerName, items: newItems });
            } else if (k === 'lore') {
              loreDeltas.push({ steamId: id, name: playerName, items: newItems });
            } else if (k === 'lootItemUnique' || k === 'craftedUniques') {
              uniqueDeltas.push({
                steamId: id,
                name: playerName,
                type: k === 'lootItemUnique' ? 'found' : 'crafted',
                items: newItems,
              });
            } else if (k === 'companionData' || k === 'horses') {
              companionDeltas.push({
                steamId: id,
                name: playerName,
                type: k === 'horses' ? 'horse' : 'companion',
                items: newItems,
              });
            }
          }
        }
      }
      record.activityArraySnapshot = newArrSnapshot;

      // ── Challenge completion detection ──
      if (save['hasExtendedStats'] && gameData?.CHALLENGE_DESCRIPTIONS) {
        const prevChal = record.challengeSnapshot;
        const completedNow: { key: string; name: string; desc: string }[] = [];
        for (const k of KillTracker.CHALLENGE_KEYS) {
          const cur = (save[k] as number | undefined) ?? 0;
          const prev = prevChal[k] ?? 0;
          if (cur > prev) {
            const info = gameData.CHALLENGE_DESCRIPTIONS[k];
            if (info) {
              const wasComplete = info.target ? prev >= info.target : prev > 0;
              const isComplete = info.target ? cur >= info.target : cur > 0;
              if (!wasComplete && isComplete) {
                completedNow.push({ key: k, name: info.name, desc: info.desc });
              }
            }
          }
        }
        if (completedNow.length > 0) {
          challengeDeltas.push({ steamId: id, name: playerName, completed: completedNow });
        }
        record.challengeSnapshot = KillTracker._snapshotChallenges(save);
      }

      record.lastSnapshot = currentKills;
      record.survivalSnapshot = currentSurvival;
      this._dirty = true;
    }

    this.save();

    return {
      deltas: {
        killDeltas,
        survivalDeltas,
        fishingDeltas,
        recipeDeltas,
        skillDeltas,
        professionDeltas,
        loreDeltas,
        uniqueDeltas,
        companionDeltas,
        challengeDeltas,
      },
      targetDate,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Queries — all-time stats (persist across deaths)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get all-time kill totals for a player (lifetime across deaths).
   * @param steamId
   * @param saveData - current save data map
   * @returns kill totals or null
   */
  getAllTimeKills(steamId: string, saveData: Map<string, SaveEntry>): KillObj | null {
    const record = this._data.players[steamId];
    const save = saveData instanceof Map ? (saveData.get(steamId) ?? null) : null;
    if (!record && !save) return null;

    const allTime = KillTracker._emptyKills();

    // ExtendedStats lifetime values (persist across deaths)
    if (save?.['hasExtendedStats']) {
      allTime.zeeksKilled = (save['lifetimeKills'] as number | undefined) ?? 0;
      allTime.headshots = (save['lifetimeHeadshots'] as number | undefined) ?? 0;
      allTime.meleeKills = (save['lifetimeMeleeKills'] as number | undefined) ?? 0;
      allTime.gunKills = (save['lifetimeGunKills'] as number | undefined) ?? 0;
      allTime.blastKills = (save['lifetimeBlastKills'] as number | undefined) ?? 0;
      allTime.fistKills = (save['lifetimeFistKills'] as number | undefined) ?? 0;
      allTime.takedownKills = (save['lifetimeTakedownKills'] as number | undefined) ?? 0;
      allTime.vehicleKills = (save['lifetimeVehicleKills'] as number | undefined) ?? 0;
      return allTime;
    }

    // Offline but previously had ExtendedStats — use cached lifetime
    if (record?.hasExtendedStats && record.lifetimeSnapshot) {
      for (const k of KillTracker.KILL_KEYS) {
        allTime[k] = record.lifetimeSnapshot[k];
      }
      return allTime;
    }

    // Legacy fallback: cumulative (banked) + current save
    if (record) {
      for (const k of KillTracker.KILL_KEYS) {
        allTime[k] += record.cumulative[k];
      }
    }
    if (save) {
      for (const k of KillTracker.KILL_KEYS) {
        allTime[k] += (save[k] as number | undefined) ?? 0;
      }
    }
    return allTime;
  }

  /**
   * Get current-life kills for a player.
   * ExtendedStats: lifetime - deathCheckpoint.
   * Legacy: raw GameStats values.
   * @param steamId
   * @param saveData
   */
  getCurrentLifeKills(steamId: string, saveData: Map<string, SaveEntry>): KillObj | null {
    const record = this._data.players[steamId];
    const save = saveData instanceof Map ? (saveData.get(steamId) ?? null) : null;
    if (!save) return null;

    // ExtendedStats: compute from lifetime - checkpoint
    if (save['hasExtendedStats'] && record?.deathCheckpoint) {
      const life = KillTracker._emptyKills();
      for (const k of KillTracker.KILL_KEYS) {
        const lifetimeKey = KillTracker.LIFETIME_KEY_MAP[k];
        const lifetime = lifetimeKey ? ((save[lifetimeKey] as number | undefined) ?? 0) : 0;
        life[k] = Math.max(0, lifetime - record.deathCheckpoint[k]);
      }
      return life;
    }

    // ExtendedStats, never died: all lifetime kills are current life
    if (save['hasExtendedStats']) {
      const life = KillTracker._emptyKills();
      for (const k of KillTracker.KILL_KEYS) {
        const lifetimeKey = KillTracker.LIFETIME_KEY_MAP[k];
        life[k] = lifetimeKey ? ((save[lifetimeKey] as number | undefined) ?? 0) : 0;
      }
      return life;
    }

    // Offline, previously ExtendedStats — cached lifetime - checkpoint
    if (record?.hasExtendedStats && record.lifetimeSnapshot) {
      if (record.deathCheckpoint) {
        const life = KillTracker._emptyKills();
        for (const k of KillTracker.KILL_KEYS) {
          life[k] = Math.max(0, record.lifetimeSnapshot[k] - record.deathCheckpoint[k]);
        }
        return life;
      }
      return { ...record.lifetimeSnapshot };
    }

    // Legacy: GameStats is the current-life value
    return KillTracker._snapshotKills(save);
  }

  /**
   * Get all-time survival days for a player.
   * @param steamId
   * @param saveData
   * @returns survival totals or null
   */
  getAllTimeSurvival(steamId: string, saveData: Map<string, SaveEntry>): SurvivalObj | null {
    const record = this._data.players[steamId];
    const save = saveData instanceof Map ? (saveData.get(steamId) ?? null) : null;
    if (!record && !save) return null;

    const allTime = KillTracker._emptySurvival();

    if (save?.['hasExtendedStats']) {
      allTime.daysSurvived =
        (save['lifetimeDaysSurvived'] as number | undefined) ?? (save['daysSurvived'] as number | undefined) ?? 0;
      return allTime;
    }

    if (record?.hasExtendedStats && record.survivalLifetimeSnapshot) {
      allTime.daysSurvived = record.survivalLifetimeSnapshot.daysSurvived;
      return allTime;
    }

    // Legacy fallback
    if (record) {
      for (const k of KillTracker.SURVIVAL_KEYS) {
        allTime[k] += record.survivalCumulative[k];
      }
    }
    if (save) {
      for (const k of KillTracker.SURVIVAL_KEYS) {
        allTime[k] += (save[k] as number | undefined) ?? 0;
      }
    }
    return allTime;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Weekly stats
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Compute weekly delta leaderboards by comparing current stats to a baseline.
   * Manages baseline persistence: loads/resets from DB on week rollover.
   *
   * @param saveData
   * @returns weekly stats object or null
   */
  computeWeeklyStats(saveData: Map<string, SaveEntry>): WeeklyStats | null {
    if (!this._config.showWeeklyStats) return null;

    let baseline: WeeklyBaseline = { weekStart: null, players: {} };
    try {
      if (this._db) {
        const saved = this._db.getStateJSON('weekly_baseline', null) as WeeklyBaseline | null;
        if (saved) baseline = saved;
      }
    } catch (_) {
      /* non-critical */
    }

    const now = new Date();
    const needsReset = !baseline.weekStart || this._isNewWeek(baseline.weekStart, now);

    if (needsReset) {
      baseline = { weekStart: now.toISOString(), players: {} };
      for (const [id] of saveData) {
        baseline.players[id] = this._snapshotPlayerStats(id, saveData);
      }
      try {
        if (this._db) this._db.setStateJSON('weekly_baseline', baseline);
        this._log.info('Weekly baseline reset');
      } catch (err) {
        this._log.error('Failed to write weekly baseline:', (err as Error).message);
      }
    }

    const allLog = this._playerStats.getAllPlayers() as Array<{ id: string; pvpKills?: number }>;
    const logMap = new Map(allLog.map((p) => [p.id, p]));

    const weeklyKillers: { name: string; kills: number }[] = [];
    const weeklyPvpKillers: { name: string; kills: number }[] = [];
    const weeklyFishers: { name: string; count: number }[] = [];
    const weeklyBitten: { name: string; count: number }[] = [];
    const weeklyPlaytime: { name: string; ms: number }[] = [];

    const allIds = new Set([...saveData.keys(), ...allLog.map((p) => p.id)]);
    for (const id of allIds) {
      const resolved = resolvePlayer(id, { playtime: this._playtime, playerStats: this._playerStats, saveData });
      const snap: Partial<PlayerBaseline> = baseline.players[id] ?? {};

      const at = this.getAllTimeKills(id, saveData);
      const kills = (at?.zeeksKilled ?? 0) - (snap.kills ?? 0);
      if (kills > 0) weeklyKillers.push({ name: resolved.name, kills });

      const log = logMap.get(id);
      const pvp = (log?.pvpKills ?? 0) - (snap.pvpKills ?? 0);
      if (pvp > 0) weeklyPvpKillers.push({ name: resolved.name, kills: pvp });

      const save = saveData.get(id);
      const fish = ((save?.['fishCaught'] as number | undefined) ?? 0) - (snap.fish ?? 0);
      if (fish > 0) weeklyFishers.push({ name: resolved.name, count: fish });

      const bites = ((save?.['timesBitten'] as number | undefined) ?? 0) - (snap.bitten ?? 0);
      if (bites > 0) weeklyBitten.push({ name: resolved.name, count: bites });

      const pt = this._playtime.getPlaytime(id);
      const ptMs = (pt?.totalMs ?? 0) - (snap.playtimeMs ?? 0);
      if (ptMs > 60000) weeklyPlaytime.push({ name: resolved.name, ms: ptMs });
    }

    weeklyKillers.sort((a, b) => b.kills - a.kills);
    weeklyPvpKillers.sort((a, b) => b.kills - a.kills);
    weeklyFishers.sort((a, b) => b.count - a.count);
    weeklyBitten.sort((a, b) => b.count - a.count);
    weeklyPlaytime.sort((a, b) => b.ms - a.ms);

    return {
      weekStart: baseline.weekStart,
      topKillers: weeklyKillers.slice(0, 5),
      topPvpKillers: weeklyPvpKillers.slice(0, 5),
      topFishers: weeklyFishers.slice(0, 5),
      topBitten: weeklyBitten.slice(0, 5),
      topPlaytime: weeklyPlaytime.slice(0, 5),
    };
  }

  /**
   * Snapshot a player's current stats for weekly baseline comparison.
   */
  private _snapshotPlayerStats(id: string, saveData: Map<string, SaveEntry>): PlayerBaseline {
    const at = this.getAllTimeKills(id, saveData);
    const log = this._playerStats.getStats(id);
    const save = saveData.get(id);
    const pt = this._playtime.getPlaytime(id);
    return {
      kills: at?.zeeksKilled ?? 0,
      pvpKills: log?.pvpKills ?? 0,
      fish: (save?.['fishCaught'] as number | undefined) ?? 0,
      bitten: (save?.['timesBitten'] as number | undefined) ?? 0,
      playtimeMs: pt?.totalMs ?? 0,
      craftingRecipes: (save?.['craftingRecipes'] as unknown[] | undefined)?.length ?? 0,
      buildingRecipes: (save?.['buildingRecipes'] as unknown[] | undefined)?.length ?? 0,
      unlockedSkills: (save?.['unlockedSkills'] as unknown[] | undefined)?.length ?? 0,
      unlockedProfessions: (save?.['unlockedProfessions'] as unknown[] | undefined)?.length ?? 0,
      lore: (save?.['lore'] as unknown[] | undefined)?.length ?? 0,
      uniqueLoots: (save?.['uniqueLoots'] as unknown[] | undefined)?.length ?? 0,
      craftedUniques: (save?.['craftedUniques'] as unknown[] | undefined)?.length ?? 0,
      companions:
        ((save?.['companionData'] as unknown[] | undefined)?.length ?? 0) +
        ((save?.['horses'] as unknown[] | undefined)?.length ?? 0),
    };
  }

  /**
   * Check if the baseline's weekStart falls in a previous week.
   */
  private _isNewWeek(weekStartIso: string, now: Date): boolean {
    const resetDay = this._config.weeklyResetDay;
    const dayStr = now.toLocaleDateString('en-US', {
      weekday: 'short',
      timeZone: this._config.botTimezone,
    });
    const dayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const currentDay = dayMap[dayStr] ?? now.getDay();
    const daysSinceReset = (currentDay - resetDay + 7) % 7;

    const todayStr = now.toLocaleDateString('en-CA', { timeZone: this._config.botTimezone });
    const [y, m, d] = todayStr.split('-').map(Number) as [number, number, number];
    const resetDate = new Date(Date.UTC(y, m - 1, d - daysSinceReset));
    const resetDateStr = resetDate.toISOString().slice(0, 10);

    const weekStart = new Date(weekStartIso);
    const weekStartDateStr = weekStart.toLocaleDateString('en-CA', { timeZone: this._config.botTimezone });

    return weekStartDateStr < resetDateStr;
  }
}

// CJS compat — consumed by non-migrated .js modules via require()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _mod = module as { exports: any };
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
_mod.exports = KillTracker;
_mod.exports.resolvePlayer = resolvePlayer;
/* eslint-enable @typescript-eslint/no-unsafe-member-access */

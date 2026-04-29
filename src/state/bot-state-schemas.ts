/**
 * bot-state-schemas.ts — Option E field-level partial-recovery normalizers.
 *
 * Each exported normalizeXxx(raw) function accepts an unknown value read from
 * bot_state and returns { shape, issues }.  `shape` is always a valid instance
 * of the target type (invalid fields are substituted with safe defaults).
 * `issues` lists per-field diagnostic strings for every substitution made.
 *
 * Only kill_tracker and github_tracker are canary keys for PR2.  The other
 * keys (milestones, weekly_baseline, recap_service …) will get normalizers in
 * PR4/PR5.
 *
 * Decision: Option E selected after Stage 0 spike — see temp/pr2-schema-spike.md.
 */

// ─── Shared helpers ──────────────────────────────────────────────────────────

export function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isNumberRecord(v: unknown): v is Record<string, number> {
  if (!isObj(v)) return false;
  for (const val of Object.values(v)) if (typeof val !== 'number') return false;
  return true;
}

function isArrayRecord(v: unknown): v is Record<string, unknown[]> {
  if (!isObj(v)) return false;
  for (const val of Object.values(v)) if (!Array.isArray(val)) return false;
  return true;
}

export function isNumberArray(v: unknown): v is number[] {
  if (!Array.isArray(v)) return false;
  for (const x of v) if (typeof x !== 'number') return false;
  return true;
}

export function isStringArray(v: unknown): v is string[] {
  if (!Array.isArray(v)) return false;
  for (const x of v) if (typeof x !== 'string') return false;
  return true;
}

function optionalDateString(v: unknown, issues: string[], path: string): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v === 'string' && Number.isFinite(Date.parse(v))) return v;
  issues.push(`${path}: expected date string | null (dropped)`);
  return undefined;
}

function normalizeArrayRecord<T>(
  raw: unknown,
  issues: string[],
  path: string,
  guard: (v: unknown) => v is T[],
  typeLabel: string,
): Record<string, T[]> {
  if (raw === undefined) return {};
  if (!isObj(raw)) {
    issues.push(`${path}: expected object (substituted empty)`);
    return {};
  }
  const out: Record<string, T[]> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (guard(value)) {
      out[key] = value;
    } else {
      issues.push(`${path}[${key}]: expected ${typeLabel} (dropped)`);
    }
  }
  return out;
}

// ─── kill_tracker ─────────────────────────────────────────────────────────────

interface KillObjShape {
  zeeksKilled: number;
  headshots: number;
  meleeKills: number;
  gunKills: number;
  blastKills: number;
  fistKills: number;
  takedownKills: number;
  vehicleKills: number;
}

interface SurvivalObjShape {
  daysSurvived: number;
}

export interface PlayerKillRecord {
  cumulative: KillObjShape;
  lastSnapshot: KillObjShape;
  survivalCumulative: SurvivalObjShape;
  survivalSnapshot: SurvivalObjShape;
  hasExtendedStats: boolean;
  deathCheckpoint: KillObjShape | null;
  lastKnownDeaths: number;
  lifetimeSnapshot: KillObjShape | null;
  survivalLifetimeSnapshot: SurvivalObjShape | null;
  lastLifetimeSnapshot: KillObjShape | null;
  lastSurvivalLifetimeSnapshot: SurvivalObjShape | null;
  activitySnapshot: Record<string, number>;
  activityArraySnapshot: Record<string, unknown[]>;
  challengeSnapshot: Record<string, number>;
}

export interface KillTrackerShape {
  players: Record<string, PlayerKillRecord>;
  lastPollDate?: string | null;
}

const EMPTY_KILL: KillObjShape = {
  zeeksKilled: 0,
  headshots: 0,
  meleeKills: 0,
  gunKills: 0,
  blastKills: 0,
  fistKills: 0,
  takedownKills: 0,
  vehicleKills: 0,
};
const EMPTY_SURVIVAL: SurvivalObjShape = { daysSurvived: 0 };

const KILL_FIELDS = [
  'zeeksKilled',
  'headshots',
  'meleeKills',
  'gunKills',
  'blastKills',
  'fistKills',
  'takedownKills',
  'vehicleKills',
] as const;

function validateSurvival(v: unknown, path: string): SurvivalObjShape {
  if (!isObj(v)) throw new Error(`${path}: expected object`);
  if (typeof v.daysSurvived !== 'number') throw new Error(`${path}.daysSurvived: expected number`);
  return v as unknown as SurvivalObjShape;
}

function softKillObj(v: unknown, issues: string[], path: string): KillObjShape {
  if (!isObj(v)) {
    issues.push(`${path}: expected object`);
    return { ...EMPTY_KILL };
  }

  const out: KillObjShape = { ...EMPTY_KILL };
  for (const k of KILL_FIELDS) {
    if (typeof v[k] === 'number') {
      out[k] = v[k];
    } else {
      issues.push(`${path}.${k}: expected number (substituted 0)`);
    }
  }
  return out;
}

function softSurvival(v: unknown, issues: string[], path: string): SurvivalObjShape {
  try {
    return validateSurvival(v, path);
  } catch (e) {
    issues.push((e as Error).message);
    return { ...EMPTY_SURVIVAL };
  }
}

export const KILL_TRACKER_DEFAULT: KillTrackerShape = { players: {} };

/** Factory — always returns a fresh default instance (prevents cross-instance mutation). */
export function makeKillTrackerDefault(): KillTrackerShape {
  return { players: {} };
}

/**
 * Option E normalizer for kill_tracker.
 * On invalid fields, substitutes safe defaults and records diagnostics in issues[].
 * Shape is always returned; issues.length > 0 means partial recovery occurred.
 */
export function normalizeKillTracker(raw: unknown): { shape: KillTrackerShape; issues: string[] } {
  const issues: string[] = [];
  if (!isObj(raw)) {
    issues.push('root: expected object');
    return { shape: { players: {} }, issues };
  }
  const out: KillTrackerShape = { players: {} };
  if (isObj(raw.players)) {
    for (const [sid, rec] of Object.entries(raw.players)) {
      if (!isObj(rec)) {
        issues.push(`players[${sid}]: expected object (skipped)`);
        continue;
      }
      out.players[sid] = {
        cumulative: softKillObj(rec.cumulative, issues, `players[${sid}].cumulative`),
        lastSnapshot: softKillObj(rec.lastSnapshot, issues, `players[${sid}].lastSnapshot`),
        survivalCumulative: softSurvival(rec.survivalCumulative, issues, `players[${sid}].survivalCumulative`),
        survivalSnapshot: softSurvival(rec.survivalSnapshot, issues, `players[${sid}].survivalSnapshot`),
        hasExtendedStats:
          typeof rec.hasExtendedStats === 'boolean'
            ? rec.hasExtendedStats
            : (() => {
                issues.push(`players[${sid}].hasExtendedStats: expected boolean (substituted false)`);
                return false;
              })(),
        deathCheckpoint:
          rec.deathCheckpoint === null || rec.deathCheckpoint === undefined
            ? null
            : softKillObj(rec.deathCheckpoint, issues, `players[${sid}].deathCheckpoint`),
        lastKnownDeaths:
          typeof rec.lastKnownDeaths === 'number'
            ? rec.lastKnownDeaths
            : (() => {
                issues.push(`players[${sid}].lastKnownDeaths: expected number (substituted 0)`);
                return 0;
              })(),
        lifetimeSnapshot: isObj(rec.lifetimeSnapshot)
          ? softKillObj(rec.lifetimeSnapshot, issues, `players[${sid}].lifetimeSnapshot`)
          : rec.lifetimeSnapshot != null
            ? (() => {
                issues.push(`players[${sid}].lifetimeSnapshot: expected object | null (substituted null)`);
                return null;
              })()
            : null,
        survivalLifetimeSnapshot: isObj(rec.survivalLifetimeSnapshot)
          ? softSurvival(rec.survivalLifetimeSnapshot, issues, `players[${sid}].survivalLifetimeSnapshot`)
          : rec.survivalLifetimeSnapshot != null
            ? (() => {
                issues.push(`players[${sid}].survivalLifetimeSnapshot: expected object | null (substituted null)`);
                return null;
              })()
            : null,
        lastLifetimeSnapshot: isObj(rec.lastLifetimeSnapshot)
          ? softKillObj(rec.lastLifetimeSnapshot, issues, `players[${sid}].lastLifetimeSnapshot`)
          : rec.lastLifetimeSnapshot != null
            ? (() => {
                issues.push(`players[${sid}].lastLifetimeSnapshot: expected object | null (substituted null)`);
                return null;
              })()
            : null,
        lastSurvivalLifetimeSnapshot: isObj(rec.lastSurvivalLifetimeSnapshot)
          ? softSurvival(rec.lastSurvivalLifetimeSnapshot, issues, `players[${sid}].lastSurvivalLifetimeSnapshot`)
          : rec.lastSurvivalLifetimeSnapshot != null
            ? (() => {
                issues.push(`players[${sid}].lastSurvivalLifetimeSnapshot: expected object | null (substituted null)`);
                return null;
              })()
            : null,
        activitySnapshot: isNumberRecord(rec.activitySnapshot)
          ? rec.activitySnapshot
          : (() => {
              issues.push(`players[${sid}].activitySnapshot: expected Record<string,number> (substituted {})`);
              return {} as Record<string, number>;
            })(),
        activityArraySnapshot: isArrayRecord(rec.activityArraySnapshot)
          ? rec.activityArraySnapshot
          : (() => {
              issues.push(`players[${sid}].activityArraySnapshot: expected Record<string,unknown[]> (substituted {})`);
              return {} as Record<string, unknown[]>;
            })(),
        challengeSnapshot: isNumberRecord(rec.challengeSnapshot)
          ? rec.challengeSnapshot
          : (() => {
              issues.push(`players[${sid}].challengeSnapshot: expected Record<string,number> (substituted {})`);
              return {} as Record<string, number>;
            })(),
      };
    }
  } else {
    issues.push('root.players: expected object (substituted empty)');
  }
  if (raw.lastPollDate != null && typeof raw.lastPollDate !== 'string') {
    issues.push('root.lastPollDate: expected string | null | undefined (dropped)');
  } else {
    out.lastPollDate = raw.lastPollDate;
  }
  return { shape: out, issues };
}

// ─── github_tracker ──────────────────────────────────────────────────────────

export interface RepoState {
  seenPrIds?: number[];
  closedPrIds?: number[];
  seenCommitShas?: string[];
  bootstrapped?: boolean;
  _bootstrapAttempts?: number;
}

export type GithubTrackerShape = Record<string, RepoState>;

export const GITHUB_TRACKER_DEFAULT: GithubTrackerShape = {};

/** Factory — always returns a fresh default instance (prevents cross-instance mutation). */
export function makeGithubTrackerDefault(): GithubTrackerShape {
  return {};
}

/**
 * Option E normalizer for github_tracker.
 * Per-repo recovery: a bad repo entry is skipped while healthy siblings are preserved.
 */
export function normalizeGithubTracker(raw: unknown): { shape: GithubTrackerShape; issues: string[] } {
  const issues: string[] = [];
  const out: GithubTrackerShape = {};
  if (!isObj(raw)) {
    issues.push('root: expected object');
    return { shape: out, issues };
  }
  for (const [repo, rs] of Object.entries(raw)) {
    if (!isObj(rs)) {
      issues.push(`[${repo}]: expected object (skipped)`);
      continue;
    }
    const recovered: RepoState = {};
    if (rs.seenPrIds !== undefined) {
      if (isNumberArray(rs.seenPrIds)) recovered.seenPrIds = rs.seenPrIds;
      else issues.push(`[${repo}].seenPrIds: expected number[] (dropped)`);
    }
    if (rs.closedPrIds !== undefined) {
      if (isNumberArray(rs.closedPrIds)) recovered.closedPrIds = rs.closedPrIds;
      else issues.push(`[${repo}].closedPrIds: expected number[] (dropped)`);
    }
    if (rs.seenCommitShas !== undefined) {
      if (isStringArray(rs.seenCommitShas)) recovered.seenCommitShas = rs.seenCommitShas;
      else issues.push(`[${repo}].seenCommitShas: expected string[] (dropped)`);
    }
    if (rs.bootstrapped !== undefined) {
      if (typeof rs.bootstrapped === 'boolean') recovered.bootstrapped = rs.bootstrapped;
      else issues.push(`[${repo}].bootstrapped: expected boolean (dropped)`);
    }
    if (rs._bootstrapAttempts !== undefined) {
      if (typeof rs._bootstrapAttempts === 'number') recovered._bootstrapAttempts = rs._bootstrapAttempts;
      else issues.push(`[${repo}]._bootstrapAttempts: expected number (dropped)`);
    }
    out[repo] = recovered;
  }
  return { shape: out, issues };
}

// ─── weekly_baseline (read-side only for PR2) ─────────────────────────────────
// write-side intentionally left as setStateJSON — see plan §3 Stage 2

export interface WeeklyBaselineShape {
  weekStart: string | null;
  players: Record<string, unknown>;
}

export const WEEKLY_BASELINE_DEFAULT: WeeklyBaselineShape = {
  weekStart: null,
  players: {},
};

/** Factory — always returns a fresh default instance (prevents cross-instance mutation). */
export function makeWeeklyBaselineDefault(): WeeklyBaselineShape {
  return { weekStart: null, players: {} };
}

/**
 * Read-side normalizer for weekly_baseline.
 * Does partial recovery on root shape; individual player entries are left as-is
 * (complex sub-validation deferred to PR4/PR5).
 */
export function normalizeWeeklyBaseline(raw: unknown): { shape: WeeklyBaselineShape; issues: string[] } {
  const issues: string[] = [];
  if (!isObj(raw)) {
    issues.push('root: expected object');
    return { shape: { ...WEEKLY_BASELINE_DEFAULT }, issues };
  }
  const weekStart = raw.weekStart === null || typeof raw.weekStart === 'string' ? raw.weekStart : null;
  if (raw.weekStart !== null && typeof raw.weekStart !== 'string' && raw.weekStart !== undefined) {
    issues.push('root.weekStart: expected string | null (substituted null)');
  }
  const players: Record<string, unknown> = isObj(raw.players) ? raw.players : {};
  if (!isObj(raw.players)) {
    issues.push('root.players: expected object (substituted empty)');
  }
  return { shape: { weekStart, players }, issues };
}

// ─── server_status_cache (read-side) ─────────────────────────────────────────

export interface ServerStatusCacheShape {
  onlineSince?: string | null;
  offlineSince?: string | null;
  lastOnline?: boolean | null;
  lastInfo?: Record<string, unknown> | null;
  lastPlayerList?: Record<string, unknown> | null;
  savedAt?: string | null;
}

export function makeServerStatusCacheDefault(): ServerStatusCacheShape {
  return {};
}

const SERVER_STATUS_INFO_STRING_FIELDS = ['name', 'day', 'time', 'season', 'weather', 'fps', 'ai', 'version'] as const;
const SERVER_STATUS_INFO_NUMBER_FIELDS = ['players', 'maxPlayers'] as const;

function normalizeServerStatusInfo(
  raw: unknown,
  issues: string[],
  path: string,
): Record<string, unknown> | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (!isObj(raw)) {
    issues.push(`${path}: expected server info object | null (dropped)`);
    return undefined;
  }

  const out: Record<string, unknown> = {};
  if (raw.raw !== undefined) {
    if (typeof raw.raw === 'string') out.raw = raw.raw;
    else issues.push(`${path}.raw: expected string (dropped)`);
  }
  if (raw.fields !== undefined) {
    if (isObj(raw.fields) && Object.values(raw.fields).every((value) => typeof value === 'string')) {
      out.fields = raw.fields;
    } else {
      issues.push(`${path}.fields: expected Record<string,string> (dropped)`);
    }
  }
  for (const field of SERVER_STATUS_INFO_STRING_FIELDS) {
    const value = raw[field];
    if (value === undefined) continue;
    if (typeof value === 'string') out[field] = value;
    else issues.push(`${path}.${field}: expected string (dropped)`);
  }
  for (const field of SERVER_STATUS_INFO_NUMBER_FIELDS) {
    const value = raw[field];
    if (value === undefined) continue;
    if (typeof value === 'number' && Number.isFinite(value)) out[field] = value;
    else issues.push(`${path}.${field}: expected finite number (dropped)`);
  }

  if (Object.keys(out).length === 0) {
    issues.push(`${path}: expected server info-like object (dropped)`);
    return undefined;
  }
  if (out.raw === undefined) out.raw = '';
  if (out.fields === undefined) out.fields = {};
  return out;
}

function normalizeServerStatusPlayerEntry(
  raw: unknown,
  issues: string[],
  path: string,
): { name: string; steamId: string } | null {
  if (typeof raw === 'string') {
    const name = raw.trim();
    if (name) return { name, steamId: 'N/A' };
    issues.push(`${path}: expected non-empty player name (dropped)`);
    return null;
  }
  if (!isObj(raw) || typeof raw.name !== 'string' || !raw.name.trim()) {
    issues.push(`${path}: expected player entry with name (dropped)`);
    return null;
  }
  if (raw.steamId !== undefined && typeof raw.steamId !== 'string') {
    issues.push(`${path}.steamId: expected string (substituted N/A)`);
  }
  return {
    name: raw.name.trim(),
    steamId: typeof raw.steamId === 'string' ? raw.steamId : 'N/A',
  };
}

function normalizeServerStatusPlayerList(
  raw: unknown,
  issues: string[],
  path: string,
): Record<string, unknown> | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (!isObj(raw)) {
    issues.push(`${path}: expected player list object | null (dropped)`);
    return undefined;
  }
  if (!Array.isArray(raw.players)) {
    issues.push(`${path}.players: expected array (dropped)`);
    return undefined;
  }

  const players = raw.players.flatMap((entry, index) => {
    const normalized = normalizeServerStatusPlayerEntry(entry, issues, `${path}.players[${index}]`);
    return normalized ? [normalized] : [];
  });

  const out: Record<string, unknown> = {
    count: players.length,
    players,
    raw: '',
  };
  if (raw.count !== undefined) {
    if (typeof raw.count === 'number' && Number.isFinite(raw.count)) out.count = raw.count;
    else issues.push(`${path}.count: expected finite number (substituted players.length)`);
  }
  if (raw.raw !== undefined) {
    if (typeof raw.raw === 'string') out.raw = raw.raw;
    else issues.push(`${path}.raw: expected string (substituted empty)`);
  }
  return out;
}

export function normalizeServerStatusCache(raw: unknown): { shape: ServerStatusCacheShape; issues: string[] } {
  const issues: string[] = [];
  if (!isObj(raw)) {
    issues.push('root: expected object');
    return { shape: {}, issues };
  }

  const shape: ServerStatusCacheShape = {};
  const onlineSince = optionalDateString(raw.onlineSince, issues, 'root.onlineSince');
  const offlineSince = optionalDateString(raw.offlineSince, issues, 'root.offlineSince');
  const savedAt = optionalDateString(raw.savedAt, issues, 'root.savedAt');
  const lastInfo = normalizeServerStatusInfo(raw.lastInfo, issues, 'root.lastInfo');
  const lastPlayerList = normalizeServerStatusPlayerList(raw.lastPlayerList, issues, 'root.lastPlayerList');

  if (onlineSince !== undefined) shape.onlineSince = onlineSince;
  if (offlineSince !== undefined) shape.offlineSince = offlineSince;
  if (savedAt !== undefined) shape.savedAt = savedAt;
  if (lastInfo !== undefined) shape.lastInfo = lastInfo;
  if (lastPlayerList !== undefined) shape.lastPlayerList = lastPlayerList;

  if (raw.lastOnline === undefined) {
    // optional
  } else if (raw.lastOnline === null || typeof raw.lastOnline === 'boolean') {
    shape.lastOnline = raw.lastOnline;
  } else {
    issues.push('root.lastOnline: expected boolean | null (dropped)');
  }

  return { shape, issues };
}

export function isServerStatusCacheFresh(
  cache: ServerStatusCacheShape,
  nowMs: number = Date.now(),
  maxAgeMs: number = 30_000,
): boolean {
  if (!cache.savedAt || typeof cache.savedAt !== 'string') return false;
  const savedAtMs = Date.parse(cache.savedAt);
  if (!Number.isFinite(savedAtMs)) return false;
  if (savedAtMs > nowMs) return false;
  return nowMs - savedAtMs <= maxAgeMs;
}

// ─── milestones (read-side) ─────────────────────────────────────────────────

export interface MilestoneStateShape {
  kills: Record<string, number[]>;
  playtime: Record<string, number[]>;
  survival: Record<string, number[]>;
  challenges: Record<string, string[]>;
  firsts: Record<string, string[]>;
  clans: Record<string, number[]>;
}

export function makeMilestoneStateDefault(): MilestoneStateShape {
  return { kills: {}, playtime: {}, survival: {}, challenges: {}, firsts: {}, clans: {} };
}

export function normalizeMilestoneState(raw: unknown): { shape: MilestoneStateShape; issues: string[] } {
  const issues: string[] = [];
  const defaults = makeMilestoneStateDefault();
  if (!isObj(raw)) {
    issues.push('root: expected object');
    return { shape: defaults, issues };
  }

  return {
    shape: {
      kills: normalizeArrayRecord(raw.kills, issues, 'root.kills', isNumberArray, 'number[]'),
      playtime: normalizeArrayRecord(raw.playtime, issues, 'root.playtime', isNumberArray, 'number[]'),
      survival: normalizeArrayRecord(raw.survival, issues, 'root.survival', isNumberArray, 'number[]'),
      challenges: normalizeArrayRecord(raw.challenges, issues, 'root.challenges', isStringArray, 'string[]'),
      firsts: normalizeArrayRecord(raw.firsts, issues, 'root.firsts', isStringArray, 'string[]'),
      clans: normalizeArrayRecord(raw.clans, issues, 'root.clans', isNumberArray, 'number[]'),
    },
    issues,
  };
}

// ─── recap_service (read-side) ──────────────────────────────────────────────

export interface RecapWeeklyStatsShape {
  uniquePlayers?: number;
  deaths?: number;
  pvpKills?: number;
  builds?: number;
  loots?: number;
  totalEvents?: number;
}

export interface RecapServiceShape {
  lastDaily?: Record<string, unknown>;
  lastWeekly?: RecapWeeklyStatsShape | null;
}

const RECAP_WEEKLY_NUMBER_FIELDS = ['uniquePlayers', 'deaths', 'pvpKills', 'builds', 'loots', 'totalEvents'] as const;

export function makeRecapServiceDefault(): RecapServiceShape {
  return {};
}

function normalizeRecapWeeklyStats(raw: unknown, issues: string[]): RecapWeeklyStatsShape | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (!isObj(raw)) {
    issues.push('root.lastWeekly: expected object | null (dropped)');
    return undefined;
  }

  const out: RecapWeeklyStatsShape = {};
  for (const field of RECAP_WEEKLY_NUMBER_FIELDS) {
    const val = raw[field];
    if (val === undefined) continue;
    if (typeof val === 'number') {
      out[field] = val;
    } else {
      issues.push(`root.lastWeekly.${field}: expected number (dropped)`);
    }
  }
  return out;
}

export function normalizeRecapService(raw: unknown): { shape: RecapServiceShape; issues: string[] } {
  const issues: string[] = [];
  if (!isObj(raw)) {
    issues.push('root: expected object');
    return { shape: {}, issues };
  }

  const shape: RecapServiceShape = {};
  if (raw.lastDaily !== undefined) {
    if (isObj(raw.lastDaily)) {
      if (raw.lastDaily.date !== undefined && typeof raw.lastDaily.date !== 'string') {
        issues.push('root.lastDaily.date: expected string (dropped lastDaily)');
      } else {
        shape.lastDaily = raw.lastDaily;
      }
    } else if (raw.lastDaily !== null) {
      issues.push('root.lastDaily: expected object (dropped)');
    }
  }

  const lastWeekly = normalizeRecapWeeklyStats(raw.lastWeekly, issues);
  if (lastWeekly !== undefined) shape.lastWeekly = lastWeekly;

  return { shape, issues };
}

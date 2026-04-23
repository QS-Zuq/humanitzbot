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

function validateKillObj(v: unknown, path: string): KillObjShape {
  if (!isObj(v)) throw new Error(`${path}: expected object`);
  for (const k of KILL_FIELDS) {
    if (typeof v[k] !== 'number') throw new Error(`${path}.${k}: expected number`);
  }
  return v as unknown as KillObjShape;
}

function validateSurvival(v: unknown, path: string): SurvivalObjShape {
  if (!isObj(v)) throw new Error(`${path}: expected object`);
  if (typeof v.daysSurvived !== 'number') throw new Error(`${path}.daysSurvived: expected number`);
  return v as unknown as SurvivalObjShape;
}

function softKillObj(v: unknown, issues: string[], path: string): KillObjShape {
  try {
    return validateKillObj(v, path);
  } catch (e) {
    issues.push((e as Error).message);
    return { ...EMPTY_KILL };
  }
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

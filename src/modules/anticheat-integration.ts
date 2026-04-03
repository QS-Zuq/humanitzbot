/**
 * Anticheat Integration Shim
 *
 * Tries to load @humanitzbot/qs-anticheat (private package). If unavailable,
 * all methods degrade to no-ops. The bot never crashes due to missing
 * anticheat — it simply runs without detection.
 *
 * The private package is the ONLY place where detection logic lives.
 * This file provides the DB handle, config, and event hooks.
 */

import _defaultConfig from '../config/index.js';
import { errMsg } from '../utils/error.js';

type ConfigType = typeof _defaultConfig;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- optional private package, shape unknown
let AnticheatEngine: any = null;
let _available = false;

try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- optional module, top-level await incompatible with CJS
  const _acMod = require('@humanitzbot/qs-anticheat') as Record<string, unknown>;
  AnticheatEngine = (_acMod as { default?: unknown }).default ?? _acMod;
  _available = true;
} catch {
  // Private package not installed — all methods are no-ops
}

interface AnticheatOpts {
  db?: DbLike | null;
  config?: ConfigType;
  logWatcher?: unknown;
}

interface DbLike {
  getStateJSON(key: string, defaultVal: null): Record<string, unknown> | null;
  setStateJSON?(key: string, value: unknown): void;
  insertAcFlag(flag: AcFlag): number;
  getAcFlagsBySteam(steamId: string, limit: number): AcFlag[];
  getAcFlags(status: string, limit: number): AcFlag[];
  updateAcFlagStatus(flagId: number, status: string, reviewedBy: string | null, notes: string | null): void;
  upsertRiskScore(data: RiskScoreData): void;
}

interface AcFlag {
  id?: number;
  steam_id: string;
  status: string;
  severity: string;
  score: number;
  created_at?: string;
}

interface RiskScoreData {
  steam_id: string;
  risk_score: number;
  open_flags: number;
  confirmed_flags: number;
  dismissed_flags: number;
  last_flag_at: string | null;
  baseline_data: Record<string, unknown>;
}

interface EngineInstance {
  init?(): Promise<void>;
  analyze(): Promise<AcFlag[] | null>;
  onSaveSync?(result: unknown): Promise<AcFlag[] | null>;
  recalibrateBaseline?(): Promise<void>;
  onFlagReview?(flagId: number, status: string, reviewedBy: string | null): void;
  getDiagnostics?(): Record<string, unknown>;
  shutdown?(): Promise<void>;
  create?(opts: { db: DbLike | null; config: ConfigType }): EngineInstance;
}

class AnticheatIntegration {
  private _db: DbLike | null;
  private _config: ConfigType;
  private _engine: EngineInstance | null;
  private _analyzeTimer: ReturnType<typeof setInterval> | null;
  private _baselineTimer: ReturnType<typeof setInterval> | null;

  /**
   * @param {object} opts
   * @param {object} opts.db        - HumanitZDB instance
   * @param {object} opts.config    - Bot config object
   * @param {object} [opts.logWatcher]  - LogWatcher instance (optional, for event hooks)
   */
  constructor(opts: AnticheatOpts = {}) {
    this._db = opts.db ?? null;
    this._config = opts.config || _defaultConfig;
    this._engine = null;
    this._analyzeTimer = null;
    this._baselineTimer = null;
  }

  /** Whether the private anticheat package is installed. */
  get available() {
    return _available;
  }

  /** The engine instance (null if not available). */
  get engine() {
    return this._engine;
  }

  /**
   * Start the anticheat engine. No-op if private package is missing.
   */
  async start() {
    if (!_available || !AnticheatEngine) {
      console.log('[ANTICHEAT] Private package not installed — running without detection');
      return;
    }

    try {
      /* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- dynamic optional package */
      this._engine =
        typeof AnticheatEngine === 'function'
          ? new AnticheatEngine({ db: this._db, config: this._config })
          : AnticheatEngine.create
            ? AnticheatEngine.create({ db: this._db, config: this._config })
            : null;
      /* eslint-enable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */

      if (!this._engine) {
        console.warn('[ANTICHEAT] Could not instantiate engine — check package version');
        _available = false;
        return;
      }

      // Initialise (loads baselines, detector registry)
      if (typeof this._engine.init === 'function') {
        await this._engine.init();
      }

      // Schedule periodic analysis (every save poll interval, default 60s)
      const analyzeInterval = this._config.anticheatAnalyzeInterval || 60_000;
      this._analyzeTimer = setInterval(() => void this._runAnalysis(), analyzeInterval);

      // Schedule baseline recalibration (every 15 min)
      const baselineInterval = this._config.anticheatBaselineInterval || 900_000;
      this._baselineTimer = setInterval(() => void this._recalibrateBaseline(), baselineInterval);

      console.log(
        '[ANTICHEAT] Engine started — analysis every %ds, baseline every %ds',
        analyzeInterval / 1000,
        baselineInterval / 1000,
      );
    } catch (err: unknown) {
      console.error('[ANTICHEAT] Failed to start engine:', errMsg(err));
      _available = false;
    }
  }

  /**
   * Run a single analysis cycle. Called on timer or after save sync.
   */
  async _runAnalysis() {
    if (!this._engine) return;
    try {
      const flags = await this._engine.analyze();
      if (flags && flags.length > 0) {
        this._processFlags(flags);
      }
    } catch (err: unknown) {
      console.error('[ANTICHEAT] Analysis error:', errMsg(err));
    }
  }

  /**
   * Trigger analysis immediately (called by SaveService on sync).
   */
  async onSaveSync(result: unknown) {
    if (!this._engine) return;
    try {
      if (typeof this._engine.onSaveSync === 'function') {
        const flags = await this._engine.onSaveSync(result);
        if (flags && flags.length > 0) {
          this._processFlags(flags);
        }
      }
    } catch (err: unknown) {
      console.error('[ANTICHEAT] Save sync analysis error:', errMsg(err));
    }
  }

  /**
   * Process flags returned by the engine — write to DB.
   */
  _processFlags(flags: AcFlag[]) {
    if (!this._db) return;
    for (const flag of flags) {
      try {
        const flagId = this._db.insertAcFlag(flag);
        flag.id = flagId;

        // Update risk score for the player
        this._updateRiskScore(flag.steam_id);
      } catch (err: unknown) {
        console.error('[ANTICHEAT] Failed to insert flag:', errMsg(err));
      }
    }
  }

  /**
   * Recalculate risk score for a player based on their flags.
   */
  _updateRiskScore(steamId: string) {
    if (!this._db) return;
    try {
      const flags = this._db.getAcFlagsBySteam(steamId, 500);
      let open = 0,
        confirmed = 0,
        dismissed = 0;
      let lastFlagAt: string | null = null;

      for (const f of flags) {
        if (f.status === 'open') open++;
        else if (f.status === 'confirmed') confirmed++;
        else if (f.status === 'dismissed') dismissed++;
        if (!lastFlagAt || (f.created_at && f.created_at > lastFlagAt)) lastFlagAt = f.created_at ?? null;
      }

      // Risk score: weighted sum of flag severities
      const SEVERITY_WEIGHT: Record<string, number> = {
        info: 0.01,
        low: 0.05,
        medium: 0.15,
        high: 0.35,
        critical: 0.6,
      };
      let rawScore = 0;
      for (const f of flags) {
        if (f.status === 'dismissed' || f.status === 'whitelisted') continue;
        const w = SEVERITY_WEIGHT[f.severity] ?? 0.05;
        const statusMult = f.status === 'confirmed' ? 1.5 : 1.0;
        rawScore += w * statusMult * (f.score || 0.5);
      }
      // Normalise to 0-1 range (sigmoid-like clamping)
      const riskScore = Math.min(1.0, rawScore / (rawScore + 1));

      this._db.upsertRiskScore({
        steam_id: steamId,
        risk_score: riskScore,
        open_flags: open,
        confirmed_flags: confirmed,
        dismissed_flags: dismissed,
        last_flag_at: lastFlagAt,
        baseline_data: {},
      });
    } catch (err: unknown) {
      console.error('[ANTICHEAT] Risk score update error:', errMsg(err));
    }
  }

  /**
   * Recalibrate baselines. Called on timer.
   */
  async _recalibrateBaseline() {
    if (!this._engine) return;
    try {
      if (typeof this._engine.recalibrateBaseline === 'function') {
        await this._engine.recalibrateBaseline();
      }
    } catch (err: unknown) {
      console.error('[ANTICHEAT] Baseline recalibration error:', errMsg(err));
    }
  }

  /**
   * Admin reviews a flag.
   */
  reviewFlag(flagId: number, status: string, reviewedBy: string | null = null, notes: string | null = null) {
    if (!this._db) return;
    this._db.updateAcFlagStatus(flagId, status, reviewedBy, notes);

    // Feed back to engine for self-tuning
    if (this._engine && typeof this._engine.onFlagReview === 'function') {
      this._engine.onFlagReview(flagId, status, reviewedBy);
    }
  }

  /**
   * Get diagnostic info for the panel channel.
   */
  getDiagnostics() {
    if (!_available) return { available: false, status: 'Not installed' };
    if (!this._engine) return { available: true, status: 'Not started' };
    const diag: Record<string, unknown> = {
      available: true,
      status: 'Active',
      detectorCount: 0,
      baselineReady: false,
      flagsOpen: 0,
    };
    if (typeof this._engine.getDiagnostics === 'function') {
      Object.assign(diag, this._engine.getDiagnostics());
    }
    if (this._db) {
      try {
        diag.flagsOpen = this._db.getAcFlags('open', 1000).length;
      } catch {
        /* table may not exist yet */
      }
    }
    return diag;
  }

  /**
   * Clean shutdown.
   */
  async stop() {
    if (this._analyzeTimer) {
      clearInterval(this._analyzeTimer);
      this._analyzeTimer = null;
    }
    if (this._baselineTimer) {
      clearInterval(this._baselineTimer);
      this._baselineTimer = null;
    }
    if (this._engine && typeof this._engine.shutdown === 'function') {
      await this._engine.shutdown();
    }
    this._engine = null;
  }
}

export default AnticheatIntegration;
export { AnticheatIntegration };

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- CJS compat
const _mod = module as { exports: any };
_mod.exports = AnticheatIntegration;
// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- CJS compat
_mod.exports.AnticheatIntegration = AnticheatIntegration;

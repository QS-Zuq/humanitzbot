/**
 * Player Presence Tracker — polls RCON for online players, tracks peak/unique stats,
 * seeds playtime sessions on startup, and emits join/leave events.
 *
 * Extracted from AutoMessages to separate infrastructure (always-on) from messaging (optional).
 *
 * @fires PlayerPresenceTracker#playerJoined
 * @fires PlayerPresenceTracker#playerLeft
 */
import EventEmitter from 'events';
import _defaultConfig from '../config/index.js';
import { createLogger, type Logger } from '../utils/log.js';
import { getPlayerList as _defaultGetPlayerList, type PlayerList } from '../rcon/server-info.js';
import _defaultPlaytime, { type PlaytimeTracker } from '../tracking/playtime-tracker.js';
import { errMsg } from '../utils/error.js';

type ConfigType = typeof _defaultConfig;
export const SESSION_DEDUPE_WINDOW_MS = 60_000;

interface PresenceDb {
  player?: {
    setAllPlayersOffline?: () => void;
    touchPresence?: (steamId: string, name: string, online: boolean) => void;
  };
  activityLog?: {
    hasRecentActivity?: (type: string, steamId: string, source: string, windowMs: number) => boolean;
    insertActivity?: (entry: Record<string, unknown>) => void;
  };
}

interface PresenceDeps {
  config?: ConfigType;
  db?: PresenceDb;
  playtime?: PlaytimeTracker;
  getPlayerList?: typeof _defaultGetPlayerList;
  label?: string;
}

class PlayerPresenceTracker extends EventEmitter {
  private _config: ConfigType;
  private _db: PresenceDb | null;
  private _playtime: PlaytimeTracker;
  private _getPlayerList: typeof _defaultGetPlayerList;
  private _log: Logger;
  private _onlinePlayers: Set<string>;
  private _onlinePlayerNames: Map<string, string>;
  private _pollTimer: ReturnType<typeof setInterval> | null;
  private _initialised: boolean;
  private _polling: boolean;

  constructor(deps: PresenceDeps = {}) {
    super();
    this._config = deps.config ?? _defaultConfig;
    this._db = deps.db ?? null;
    this._playtime = deps.playtime ?? _defaultPlaytime;
    this._getPlayerList = deps.getPlayerList ?? _defaultGetPlayerList;
    // Sanitize label — may originate from user-configurable server names in multi-server mode
    this._log = createLogger(deps.label, 'PRESENCE');

    this._onlinePlayers = new Set();
    this._onlinePlayerNames = new Map();
    this._pollTimer = null;
    this._initialised = false;
    this._polling = false;
  }

  // ── Lifecycle ─────────────────────────────────────────────

  async start() {
    this._log.info('Starting player presence tracker...');
    await this._seedPlayers();
    this._pollTimer = setInterval(() => void this._poll(), this._config.autoMsgJoinCheckInterval);
    this._log.info(`Polling every ${this._config.autoMsgJoinCheckInterval / 1000}s`);
  }

  stop() {
    if (this._pollTimer) clearInterval(this._pollTimer);
    this._pollTimer = null;
    this._log.info('Stopped.');
  }

  reconfigure(options: { autoMsgJoinCheckInterval?: unknown }): void {
    if (!Object.hasOwn(options, 'autoMsgJoinCheckInterval')) return;

    const previousInterval = this._config.autoMsgJoinCheckInterval;
    const nextInterval = this._coerceInterval(options.autoMsgJoinCheckInterval, previousInterval, 5_000);
    this._config.autoMsgJoinCheckInterval = nextInterval;

    if (!this._pollTimer || nextInterval === previousInterval) return;

    clearInterval(this._pollTimer);
    this._pollTimer = setInterval(() => void this._poll(), nextInterval);
    this._log.info(`Polling every ${nextInterval / 1000}s`);
  }

  // ── Public API ────────────────────────────────────────────

  /** Current set of online player IDs (SteamID or name fallback). */
  get onlinePlayers() {
    return this._onlinePlayers;
  }

  /** Whether the initial player list has been loaded. */
  get initialised() {
    return this._initialised;
  }

  private _coerceInterval(value: unknown, fallback: number, minMs: number): number {
    const parsed = typeof value === 'number' ? value : typeof value === 'string' ? parseInt(value, 10) : Number.NaN;
    const interval = Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
    return Math.max(interval || fallback, minMs);
  }

  // ── Private ───────────────────────────────────────────────

  /**
   * Seed the online player set at startup so we don't treat
   * already-online players as new joiners.
   */
  private async _seedPlayers() {
    try {
      const list = await this._getPlayerList();
      this._safeSetAllOffline();
      for (const p of list.players) {
        const hasSteamId = p.steamId && p.steamId !== 'N/A';
        const id = hasSteamId ? p.steamId : p.name;
        const name = p.name || 'Unknown';
        this._onlinePlayers.add(id);
        if (name) this._onlinePlayerNames.set(id, name);

        // Start playtime session for players with a real SteamID
        if (hasSteamId) {
          this._playtime.playerJoin(id, name);
          this._touchPresence(id, name, true);
        }
      }
      this._initialised = true;
      this._log.info(`Seeded ${this._onlinePlayers.size} online player(s) (playtime sessions started)`);
    } catch (err: unknown) {
      this._log.error('Failed to seed players:', errMsg(err));
      this._initialised = true; // continue anyway
    }
  }

  /**
   * Poll the RCON player list, update peak/unique stats,
   * and emit events for player joins and leaves.
   */
  private async _poll() {
    if (!this._initialised) return;
    if (this._polling) return;

    this._polling = true;
    try {
      let list: PlayerList;
      try {
        list = await this._getPlayerList();
      } catch {
        // RCON failure expected during server restarts — silently ignore
        return;
      }

      const currentOnline = new Set<string>();
      const currentNames = new Map<string, string>();
      const newJoiners: { id: string; name: string; steamId: string | null }[] = [];

      for (const p of list.players) {
        const hasSteamId = p.steamId && p.steamId !== 'N/A';
        const id = hasSteamId ? p.steamId : p.name;
        const name = p.name || 'Unknown';
        currentOnline.add(id);
        if (name) currentNames.set(id, name);

        if (!this._onlinePlayers.has(id)) {
          newJoiners.push({ id, name, steamId: hasSteamId ? p.steamId : null });
        }
      }

      // Detect leaves
      for (const id of this._onlinePlayers) {
        if (!currentOnline.has(id)) {
          const name = this._onlinePlayerNames.get(id) ?? id;
          if (/^\d{17}$/.test(id)) {
            this._playtime.playerLeave(id);
            this._touchPresence(id, name, false);
            this._recordSessionActivity('player_disconnect', id, name);
          }
          try {
            this.emit('playerLeft', { id, name, steamId: /^\d{17}$/.test(id) ? id : null });
          } catch (e: unknown) {
            this._log.error('Listener error on playerLeft:', e);
          }
        }
      }

      this._onlinePlayers = currentOnline;
      this._onlinePlayerNames = currentNames;

      // Record peak player count and unique players for today (SteamID only)
      const steamOnly = ([...currentOnline] as string[]).filter((id) => /^\d{17}$/.test(id));
      this._playtime.recordPlayerCount(steamOnly.length);
      for (const id of steamOnly) {
        this._playtime.recordUniqueToday(id);
      }

      // Emit join events (wrapped individually so one listener failure doesn't block others)
      for (const joiner of newJoiners) {
        if (joiner.steamId) {
          this._playtime.playerJoin(joiner.steamId, joiner.name);
          this._touchPresence(joiner.steamId, joiner.name, true);
          this._recordSessionActivity('player_connect', joiner.steamId, joiner.name);
        }
        try {
          this.emit('playerJoined', joiner);
        } catch (e: unknown) {
          this._log.error('Listener error on playerJoined:', e);
        }
      }
    } catch (err: unknown) {
      this._log.error('Unexpected poll error:', err);
    } finally {
      this._polling = false;
    }
  }

  private _safeSetAllOffline(): void {
    try {
      this._db?.player?.setAllPlayersOffline?.();
    } catch (err: unknown) {
      this._log.warn('Failed to reset presence online flags:', errMsg(err));
    }
  }

  private _touchPresence(steamId: string, name: string, online: boolean): void {
    try {
      this._db?.player?.touchPresence?.(steamId, name, online);
    } catch (err: unknown) {
      this._log.warn('Failed to update player presence:', errMsg(err));
    }
  }

  private _recordSessionActivity(type: 'player_connect' | 'player_disconnect', steamId: string, name: string): void {
    try {
      const activityLog = this._db?.activityLog;
      if (!activityLog?.insertActivity) return;
      const hasLogSourceDuplicate =
        activityLog.hasRecentActivity?.(type, steamId, 'log', SESSION_DEDUPE_WINDOW_MS) ?? false;
      if (hasLogSourceDuplicate) return;
      activityLog.insertActivity({
        type,
        category: 'session',
        actor: steamId,
        actorName: name,
        steamId,
        source: 'presence',
        details: { source: 'rcon_presence' },
      });
    } catch (err: unknown) {
      this._log.warn('Failed to write presence session activity:', errMsg(err));
    }
  }
}

export default PlayerPresenceTracker;
export { PlayerPresenceTracker };

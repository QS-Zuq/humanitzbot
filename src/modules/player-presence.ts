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
import { createLogger } from '../utils/log.js';
import { getPlayerList as _defaultGetPlayerList } from '../rcon/server-info.js';
import _defaultPlaytime from '../tracking/playtime-tracker.js';
import { errMsg } from '../utils/error.js';

type ConfigType = typeof _defaultConfig;

interface PresenceDeps {
  config?: ConfigType;
  playtime?: typeof _defaultPlaytime;
  getPlayerList?: typeof _defaultGetPlayerList;
  label?: string;
}

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- class uses dynamic this._xxx via index signature */
class PlayerPresenceTracker extends EventEmitter {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Phase 5: replace index signature with typed fields
  [key: string]: any;
  constructor(deps: PresenceDeps = {}) {
    super();
    this._config = deps.config || _defaultConfig;
    this._playtime = deps.playtime || _defaultPlaytime;
    this._getPlayerList = deps.getPlayerList || _defaultGetPlayerList;
    // Sanitize label — may originate from user-configurable server names in multi-server mode
    this._log = createLogger(deps.label, 'PRESENCE');

    this._onlinePlayers = new Set();
    this._pollTimer = null;
    this._initialised = false;
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

  // ── Public API ────────────────────────────────────────────

  /** Current set of online player IDs (SteamID or name fallback). */
  get onlinePlayers() {
    return this._onlinePlayers;
  }

  /** Whether the initial player list has been loaded. */
  get initialised() {
    return this._initialised;
  }

  // ── Private ───────────────────────────────────────────────

  /**
   * Seed the online player set at startup so we don't treat
   * already-online players as new joiners.
   */
  async _seedPlayers() {
    try {
      const list = await this._getPlayerList();
      if (list.players && list.players.length > 0) {
        for (const p of list.players) {
          const hasSteamId = p.steamId && p.steamId !== 'N/A';
          const id = hasSteamId ? p.steamId : p.name;
          this._onlinePlayers.add(id);

          // Start playtime session for players with a real SteamID
          if (hasSteamId) {
            this._playtime.playerJoin(id, p.name || 'Unknown');
          }
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
  async _poll() {
    if (!this._initialised) return;

    let list;
    try {
      list = await this._getPlayerList();
    } catch {
      // RCON failure expected during server restarts — silently ignore
      return;
    }

    try {
      const currentOnline = new Set();
      const newJoiners: { id: string; name: string; steamId: string | null }[] = [];

      if (list.players && list.players.length > 0) {
        for (const p of list.players) {
          const hasSteamId = p.steamId && p.steamId !== 'N/A';
          const id = hasSteamId ? p.steamId : p.name;
          currentOnline.add(id);

          if (!this._onlinePlayers.has(id)) {
            newJoiners.push({ id, name: p.name || 'Unknown', steamId: hasSteamId ? p.steamId : null });
          }
        }
      }

      // Detect leaves
      for (const id of this._onlinePlayers) {
        if (!currentOnline.has(id)) {
          try {
            this.emit('playerLeft', { id });
          } catch (e: unknown) {
            this._log.error('Listener error on playerLeft:', e);
          }
        }
      }

      this._onlinePlayers = currentOnline;

      // Record peak player count and unique players for today (SteamID only)
      const steamOnly = ([...currentOnline] as string[]).filter((id) => /^\d{17}$/.test(id));
      this._playtime.recordPlayerCount(steamOnly.length);
      for (const id of steamOnly) {
        this._playtime.recordUniqueToday(id);
      }

      // Emit join events (wrapped individually so one listener failure doesn't block others)
      for (const joiner of newJoiners) {
        try {
          this.emit('playerJoined', joiner);
        } catch (e: unknown) {
          this._log.error('Listener error on playerJoined:', e);
        }
      }
    } catch (err: unknown) {
      this._log.error('Unexpected poll error:', err);
    }
  }
}
/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return */

export default PlayerPresenceTracker;
export { PlayerPresenceTracker };

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- CJS compat
const _mod = module as { exports: any };
_mod.exports = PlayerPresenceTracker;
// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- CJS compat
_mod.exports.PlayerPresenceTracker = PlayerPresenceTracker;

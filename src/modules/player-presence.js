/**
 * Player Presence Tracker — polls RCON for online players, tracks peak/unique stats,
 * seeds playtime sessions on startup, and emits join/leave events.
 *
 * Extracted from AutoMessages to separate infrastructure (always-on) from messaging (optional).
 *
 * @fires PlayerPresenceTracker#playerJoined
 * @fires PlayerPresenceTracker#playerLeft
 */
const EventEmitter = require('events');
const _defaultConfig = require('../config');
const { getPlayerList: _defaultGetPlayerList } = require('../rcon/server-info');
const _defaultPlaytime = require('../tracking/playtime-tracker');

class PlayerPresenceTracker extends EventEmitter {
  constructor(deps = {}) {
    super();
    this._config = deps.config || _defaultConfig;
    this._playtime = deps.playtime || _defaultPlaytime;
    this._getPlayerList = deps.getPlayerList || _defaultGetPlayerList;
    this._label = deps.label || 'PRESENCE';

    this._onlinePlayers = new Set();
    this._pollTimer = null;
    this._initialised = false;
  }

  // ── Lifecycle ─────────────────────────────────────────────

  async start() {
    console.log(`[${this._label}] Starting player presence tracker...`);
    await this._seedPlayers();
    this._pollTimer = setInterval(() => this._poll(), this._config.autoMsgJoinCheckInterval);
    console.log(`[${this._label}] Polling every ${this._config.autoMsgJoinCheckInterval / 1000}s`);
  }

  stop() {
    if (this._pollTimer) clearInterval(this._pollTimer);
    this._pollTimer = null;
    console.log(`[${this._label}] Stopped.`);
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
      console.log(`[${this._label}] Seeded ${this._onlinePlayers.size} online player(s) (playtime sessions started)`);
    } catch (err) {
      console.error(`[${this._label}] Failed to seed players:`, err.message);
      this._initialised = true; // continue anyway
    }
  }

  /**
   * Poll the RCON player list, update peak/unique stats,
   * and emit events for player joins and leaves.
   */
  async _poll() {
    if (!this._initialised) return;

    try {
      const list = await this._getPlayerList();
      const currentOnline = new Set();
      const newJoiners = [];

      if (list.players && list.players.length > 0) {
        for (const p of list.players) {
          const hasSteamId = p.steamId && p.steamId !== 'N/A';
          const id = hasSteamId ? p.steamId : p.name;
          currentOnline.add(id);

          // Detect new joins — player wasn't in previous snapshot
          if (!this._onlinePlayers.has(id)) {
            newJoiners.push({ id, name: p.name || 'Unknown', steamId: hasSteamId ? p.steamId : null });
          }
        }
      }

      // Detect leaves — player was online but no longer present
      for (const id of this._onlinePlayers) {
        if (!currentOnline.has(id)) {
          this.emit('playerLeft', { id });
        }
      }

      this._onlinePlayers = currentOnline;

      // Record peak player count and unique players for today (SteamID only)
      const steamOnly = [...currentOnline].filter((id) => /^\d{17}$/.test(id));
      this._playtime.recordPlayerCount(steamOnly.length);
      for (const id of steamOnly) {
        this._playtime.recordUniqueToday(id);
      }

      // Emit join events
      for (const joiner of newJoiners) {
        this.emit('playerJoined', joiner);
      }
    } catch (_) {
      // Silently ignore — server might be restarting
    }
  }
}

module.exports = PlayerPresenceTracker;

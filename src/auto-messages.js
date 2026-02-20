const config = require('./config');
const { sendAdminMessage, getPlayerList } = require('./server-info');
const playtime = require('./playtime-tracker');

class AutoMessages {
  constructor() {
    this.discordLink = config.discordInviteLink;

    // Intervals (configurable via .env, defaults in ms)
    this.linkInterval = config.autoMsgLinkInterval;   // 30 min
    this.promoInterval = config.autoMsgPromoInterval;  // 45 min
    this.joinCheckInterval = config.autoMsgJoinCheckInterval; // 10 sec

    this._linkTimer = null;
    this._promoTimer = null;
    this._joinTimer = null;

    // Track currently online players (for join/leave detection)
    this._onlinePlayers = new Set();
    this._initialised = false;

    // Anti-spam: timestamp of last welcome message sent
    this._lastWelcomeTime = 0;
    this._welcomeCooldownMs = 300000;
  }

  async start() {
    console.log('[AUTO-MSG] Starting auto-messages...');

    // Seed the known player list so we don't welcome everyone already online
    await this._seedPlayers();

    // Periodic Discord link broadcast
    if (config.enableAutoMsgLink) {
      this._linkTimer = setInterval(() => this._sendDiscordLink(), this.linkInterval);
      console.log(`[AUTO-MSG] Discord link every ${this.linkInterval / 60000} min`);
    } else {
      console.log('[AUTO-MSG] Discord link broadcast disabled');
    }

    // Periodic promo message broadcast
    if (config.enableAutoMsgPromo) {
      this._promoTimer = setInterval(() => this._sendPromoMessage(), this.promoInterval);
      console.log(`[AUTO-MSG] Promo message every ${this.promoInterval / 60000} min`);
    } else {
      console.log('[AUTO-MSG] Promo message disabled');
    }

    // Player join detection
    if (config.enableAutoMsgWelcome) {
      this._joinTimer = setInterval(() => this._checkForNewPlayers(), this.joinCheckInterval);
      console.log(`[AUTO-MSG] Join detection every ${this.joinCheckInterval / 1000}s`);
    } else {
      console.log('[AUTO-MSG] Welcome messages disabled');
    }
  }

  stop() {
    if (this._linkTimer) clearInterval(this._linkTimer);
    if (this._promoTimer) clearInterval(this._promoTimer);
    if (this._joinTimer) clearInterval(this._joinTimer);
    this._linkTimer = null;
    this._promoTimer = null;
    this._joinTimer = null;
    console.log('[AUTO-MSG] Stopped.');
  }

  // ── Private methods ────────────────────────────────────────

  async _seedPlayers() {
    try {
      const list = await getPlayerList();
      if (list.players && list.players.length > 0) {
        for (const p of list.players) {
          const hasSteamId = p.steamId && p.steamId !== 'N/A';
          const id = hasSteamId ? p.steamId : p.name;
          this._onlinePlayers.add(id);

          // Only track playtime for players with a real SteamID
          // (name-only keys create ghost entries)
          if (hasSteamId) {
            playtime.playerJoin(id, p.name || 'Unknown');
          }
        }
      }
      this._initialised = true;
      console.log(`[AUTO-MSG] Seeded ${this._onlinePlayers.size} online player(s) (playtime sessions started)`);
    } catch (err) {
      console.error('[AUTO-MSG] Failed to seed players:', err.message);
      this._initialised = true; // continue anyway
    }
  }

  async _sendDiscordLink() {
    if (!this.discordLink) return;
    // Skip if a player joined recently (avoid spamming new players)
    if (Date.now() - this._lastWelcomeTime < this._welcomeCooldownMs) {
      console.log('[AUTO-MSG] Skipping Discord link — recent welcome sent');
      return;
    }
    try {
      await sendAdminMessage(`Join our Discord! ${this.discordLink}`);
      console.log('[AUTO-MSG] Sent Discord link to game chat');
    } catch (err) {
      console.error('[AUTO-MSG] Failed to send Discord link:', err.message);
    }
  }

  async _sendPromoMessage() {
    // Skip if a player joined recently (avoid spamming new players)
    if (Date.now() - this._lastWelcomeTime < this._welcomeCooldownMs) {
      console.log('[AUTO-MSG] Skipping promo message — recent welcome sent');
      return;
    }
    try {
      const msg = `Have any issues, suggestions or just want to keep in contact with other players? Join our Discord: ${this.discordLink}`;
      await sendAdminMessage(msg);
      console.log('[AUTO-MSG] Sent promo message to game chat');
    } catch (err) {
      console.error('[AUTO-MSG] Failed to send promo message:', err.message);
    }
  }

  async _checkForNewPlayers() {
    if (!this._initialised) return;

    try {
      const list = await getPlayerList();
      const currentOnline = new Set();
      const newJoiners = [];

      if (list.players && list.players.length > 0) {
        for (const p of list.players) {
          const hasSteamId = p.steamId && p.steamId !== 'N/A';
          const id = hasSteamId ? p.steamId : p.name;
          currentOnline.add(id);

          // Player is joining if they weren't in the previous online set
          // This catches first-time joins AND rejoins after leaving
          if (!this._onlinePlayers.has(id)) {
            console.log(`[AUTO-MSG] Player joined: ${p.name} (${id})`);
            newJoiners.push(p);
          }
        }
      }

      // Detect players who left (were in previous set but not current)
      // (playtime tracking is handled by log-watcher via PlayerConnectedLog.txt)

      // Replace the online set — players who left are removed, so if they
      // rejoin later they'll be detected as new again
      this._onlinePlayers = currentOnline;

      // Record peak player count and unique players for today (SteamID only)
      const steamOnly = [...currentOnline].filter(id => /^\d{17}$/.test(id));
      playtime.recordPlayerCount(steamOnly.length);
      for (const id of steamOnly) {
        playtime.recordUniqueToday(id);
      }

      // Welcome joiners
      for (const player of newJoiners) {
        await this._sendWelcome(player);
      }
    } catch (_) {
      // Silently ignore — server might be restarting
    }
  }

  _pvpScheduleText() {
    if (!config.enablePvpScheduler) return '';
    const startMin = !isNaN(config.pvpStartMinutes) ? config.pvpStartMinutes : config.pvpStartHour * 60;
    const endMin   = !isNaN(config.pvpEndMinutes) ? config.pvpEndMinutes : config.pvpEndHour * 60;
    if (isNaN(startMin) || isNaN(endMin)) return '';

    const fmt = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

    // Get current time in the configured timezone
    const now = new Date();
    const timeStr = now.toLocaleTimeString('en-GB', {
      hour: '2-digit', minute: '2-digit', hour12: false,
      timeZone: config.pvpTimezone,
    });
    const [h, m] = timeStr.split(':').map(Number);
    const nowMin = h * 60 + m;

    // Check if currently inside PvP window
    let insidePvp;
    if (startMin < endMin) {
      insidePvp = nowMin >= startMin && nowMin < endMin;
    } else {
      insidePvp = nowMin >= startMin || nowMin < endMin;
    }

    if (insidePvp) {
      // Calculate time remaining in PvP window
      let minsLeft = endMin > nowMin ? endMin - nowMin : (1440 - nowMin) + endMin;
      const hours = Math.floor(minsLeft / 60);
      const mins = minsLeft % 60;
      const timeLeft = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
      return ` PvP is enabled for ${timeLeft} (until ${fmt(endMin)} ${config.pvpTimezone}).`;
    } else {
      // Calculate time until PvP starts
      let minsUntil = startMin > nowMin ? startMin - nowMin : (1440 - nowMin) + startMin;
      const hours = Math.floor(minsUntil / 60);
      const mins = minsUntil % 60;
      const timeUntil = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
      return ` PvP starts in ${timeUntil} (${fmt(startMin)}–${fmt(endMin)} ${config.pvpTimezone}).`;
    }
  }

  async _sendWelcome(player) {
    try {
      const name = player.name || 'Survivor';
      const id = (player.steamId && player.steamId !== 'N/A') ? player.steamId : player.name;

      // Playtime session tracking is handled by log-watcher

      // Build the welcome message based on history
      const pt = playtime.getPlaytime(id);
      const pvpInfo = this._pvpScheduleText();
      let msg;

      if (pt && pt.isReturning) {
        const since = new Date(playtime.getTrackingSince()).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' });
        msg = `Welcome back, ${name}! Your total playtime since ${since} is ${pt.totalFormatted}.${pvpInfo} Type !admin in chat if you need help. Discord: ${this.discordLink}`;
      } else {
        msg = `Welcome to the server, ${name}!${pvpInfo} Type !admin in chat if you need help from an admin. Join our Discord: ${this.discordLink}`;
      }

      await sendAdminMessage(msg);
      this._lastWelcomeTime = Date.now();
      console.log(`[AUTO-MSG] Sent welcome for ${name} (returning: ${pt ? pt.isReturning : false}, playtime: ${pt ? pt.totalFormatted : '0m'})`);
    } catch (err) {
      console.error(`[AUTO-MSG] Failed to send welcome:`, err.message);
    }
  }
}

module.exports = AutoMessages;

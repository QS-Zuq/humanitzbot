const _defaultConfig = require('../config');
const { sendAdminMessage, getPlayerList, getServerInfo } = require('../rcon/server-info');
const _defaultPlaytime = require('../tracking/playtime-tracker');
const _defaultPlayerStats = require('../tracking/player-stats');
const SftpClient = require('ssh2-sftp-client');

// Content layer: text generation, color helpers, welcome file builder
const content = require('./auto-messages-content');
const { _rconColorLink, buildWelcomeContent } = content;

class AutoMessages {
  constructor(deps = {}) {
    this._config = deps.config || _defaultConfig;
    this._playtime = deps.playtime || _defaultPlaytime;
    this._playerStats = deps.playerStats || _defaultPlayerStats;
    this._getServerInfo = deps.getServerInfo || getServerInfo;
    this._getPlayerList = deps.getPlayerList || getPlayerList;
    this._sendAdminMessage = deps.sendAdminMessage || sendAdminMessage;
    this._label = deps.label || 'AUTO MSG';
    this._db = deps.db || null;

    this.discordLink = this._config.discordInviteLink;

    // Intervals (configurable via .env, defaults in ms)
    this.linkInterval = this._config.autoMsgLinkInterval; // 30 min
    this.promoInterval = this._config.autoMsgPromoInterval; // 45 min

    this._linkTimer = null;
    this._promoTimer = null;

    // Track currently online players (for join detection + playtime seeding)
    this._onlinePlayers = new Set();
    this._lastWelcomeTime = 0; // anti-spam: last RCON welcome sent
    this._welcomeCooldown = 5000; // ms between welcome messages
    this._initialised = false;
  }

  async start() {
    console.log(`[${this._label}] Starting auto-messages...`);

    // Seed the known player list so we don't welcome everyone already online
    await this._seedPlayers();

    // Periodic Discord link broadcast
    if (this._config.enableAutoMsgLink) {
      this._linkTimer = setInterval(() => this._sendDiscordLink(), this.linkInterval);
      console.log(`[${this._label}] Discord link every ${this.linkInterval / 60000} min`);
    } else {
      console.log(`[${this._label}] Discord link broadcast disabled`);
    }

    // Periodic promo message broadcast
    if (this._config.enableAutoMsgPromo) {
      this._promoTimer = setInterval(() => this._sendPromoMessage(), this.promoInterval);
      console.log(`[${this._label}] Promo message every ${this.promoInterval / 60000} min`);
    } else {
      console.log(`[${this._label}] Promo message disabled`);
    }

    // Player count polling (peak tracking, unique player tracking, join welcome)
    this._pollTimer = setInterval(() => this._pollPlayers(), this._config.autoMsgJoinCheckInterval);
    console.log(`[${this._label}] Player count polling every ${this._config.autoMsgJoinCheckInterval / 1000}s`);
    if (this._config.enableWelcomeMsg) {
      console.log(`[${this._label}] RCON welcome messages enabled (on player join)`);
    } else {
      console.log(`[${this._label}] RCON welcome messages disabled`);
    }

    // WelcomeMessage.txt is now managed exclusively by the Welcome File Editor
  }

  stop() {
    if (this._linkTimer) clearInterval(this._linkTimer);
    if (this._promoTimer) clearInterval(this._promoTimer);
    if (this._pollTimer) clearInterval(this._pollTimer);
    this._linkTimer = null;
    this._promoTimer = null;
    this._pollTimer = null;
    console.log(`[${this._label}] Stopped.`);
  }

  // ── Private methods ────────────────────────────────────────

  async _seedPlayers() {
    try {
      const list = await this._getPlayerList();
      if (list.players && list.players.length > 0) {
        for (const p of list.players) {
          const hasSteamId = p.steamId && p.steamId !== 'N/A';
          const id = hasSteamId ? p.steamId : p.name;
          this._onlinePlayers.add(id);

          // Only track playtime for players with a real SteamID
          // (name-only keys create ghost entries)
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

  /** Colorize a Discord invite link (instance wrapper). */
  _colorLink(link) {
    return content._colorLink(link);
  }

  async _sendDiscordLink() {
    if (!this.discordLink) return;
    try {
      const custom = this._config.autoMsgLinkText;
      const msg = custom
        ? await this._resolveMessagePlaceholders(custom)
        : `<FO>Join our </><CL>Discord</><FO>! ${_rconColorLink(this.discordLink)}`;
      await this._sendAdminMessage(msg);
      console.log(`[${this._label}] Sent Discord link to game chat`);
    } catch (err) {
      console.error(`[${this._label}] Failed to send Discord link:`, err.message);
    }
  }

  async _sendPromoMessage() {
    try {
      const custom = this._config.autoMsgPromoText;
      const msg = custom
        ? await this._resolveMessagePlaceholders(custom)
        : `<FO>Issues, suggestions, or just want to connect? ${_rconColorLink(this.discordLink)}`;
      await this._sendAdminMessage(msg);
      console.log(`[${this._label}] Sent promo message to game chat`);
    } catch (err) {
      console.error(`[${this._label}] Failed to send promo message:`, err.message);
    }
  }

  /** Resolve placeholders in custom broadcast messages. */
  async _resolveMessagePlaceholders(text) {
    const info = await this._getServerInfoSafe();
    return this._resolvePlaceholders(text, info);
  }

  async _pollPlayers() {
    if (!this._initialised) return;

    try {
      const list = await this._getPlayerList();
      const currentOnline = new Set();
      const newJoiners = []; // players who just appeared

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

      this._onlinePlayers = currentOnline;

      // Record peak player count and unique players for today (SteamID only)
      const steamOnly = [...currentOnline].filter((id) => /^\d{17}$/.test(id));
      this._playtime.recordPlayerCount(steamOnly.length);
      for (const id of steamOnly) {
        this._playtime.recordUniqueToday(id);
      }

      // Send RCON admin welcome messages to new joiners
      if (this._config.enableWelcomeMsg && newJoiners.length > 0) {
        for (const joiner of newJoiners) {
          await this._sendWelcomeMessage(joiner);
        }
      }
    } catch (_) {
      // Silently ignore — server might be restarting
    }
  }

  async _sendWelcomeMessage(joiner) {
    // Anti-spam: don't stack welcome messages too close together
    const now = Date.now();
    if (now - this._lastWelcomeTime < this._welcomeCooldown) {
      await new Promise((r) => setTimeout(r, this._welcomeCooldown));
    }

    try {
      const pt = joiner.steamId ? this._playtime.getPlaytime(joiner.steamId) : null;
      const diffInfo = this._difficultyText();
      const link = this.discordLink ? `</><SP> | ${_rconColorLink(this.discordLink)}` : '';

      const sep = '</><SP> | </>';
      let msg;
      if (pt && pt.isReturning) {
        msg = `<FO>Welcome back, </>${joiner.name}<FO>!${sep}<FO>Playtime: ${pt.totalFormatted}${diffInfo}${link}`;
      } else {
        msg = `<FO>Welcome, </>${joiner.name}<FO>!${diffInfo}${link}`;
      }

      await this._sendAdminMessage(msg);
      this._lastWelcomeTime = Date.now();
      console.log(`[${this._label}] Sent welcome to ${joiner.name} (${pt?.isReturning ? 'returning' : 'first-time'})`);
    } catch (err) {
      console.error(`[${this._label}] Failed to send welcome to ${joiner.name}:`, err.message);
    }
  }

  // ── SFTP WelcomeMessage.txt ─────────────────────────────────

  async _buildWelcomeFileContent() {
    const lines = this._config.welcomeFileLines;
    if (lines.length > 0) {
      // User-defined lines — resolve placeholders
      const info = await this._getServerInfoSafe();
      return lines.map((line) => this._resolvePlaceholders(line, info)).join('\n');
    }
    // Default: use the standalone builder (no RCON needed)
    return buildWelcomeContent({
      config: this._config,
      playtime: this._playtime,
      playerStats: this._playerStats,
      getServerInfo: this._getServerInfo,
      db: this._db,
    });
  }

  async _getServerInfoSafe() {
    try {
      return await this._getServerInfo();
    } catch {
      return {};
    }
  }

  _resolvePlaceholders(text, info) {
    const serverName = (info && info.name) || '';
    const day = (info && info.day) || '';
    const season = (info && info.season) || '';
    const weather = (info && info.weather) || '';
    return text
      .replace(/\{pvp_schedule\}/gi, (this._pvpScheduleText() || '').trim())
      .replace(/\{discord_link\}/gi, this.discordLink || '')
      .replace(/\{discord\}/gi, this.discordLink || '')
      .replace(/\{server_name\}/gi, serverName)
      .replace(/\{day\}/gi, day)
      .replace(/\{season\}/gi, season)
      .replace(/\{weather\}/gi, weather);
  }

  async _writeWelcomeFile() {
    const sftp = new SftpClient();
    try {
      await sftp.connect(this._config.sftpConnectConfig());

      const fileContent = await this._buildWelcomeFileContent();
      await sftp.put(Buffer.from(fileContent, 'utf8'), this._config.ftpWelcomePath);
      console.log(`[${this._label}] Updated WelcomeMessage.txt on server`);
    } catch (err) {
      console.error(`[${this._label}] Failed to write WelcomeMessage.txt:`, err.message);
    } finally {
      await sftp.end().catch(() => {});
    }
  }
}

// Mix in content-layer methods (difficulty text, PvP schedule text)
Object.assign(AutoMessages.prototype, {
  _difficultyText: content._difficultyText,
  _pvpScheduleText: content._pvpScheduleText,
});

module.exports = AutoMessages;
module.exports.buildWelcomeContent = buildWelcomeContent;

const _defaultConfig = require('../config');
const { sendAdminMessage, getServerInfo } = require('../rcon/server-info');
const _defaultPlaytime = require('../tracking/playtime-tracker');
const _defaultPlayerStats = require('../tracking/player-stats');

// Content layer: text generation, color helpers, welcome file builder
const content = require('./auto-messages-content');
const { _rconColorLink, buildWelcomeContent } = content;

class AutoMessages {
  constructor(deps = {}) {
    this._config = deps.config || _defaultConfig;
    this._playtime = deps.playtime || _defaultPlaytime;
    this._playerStats = deps.playerStats || _defaultPlayerStats;
    this._getServerInfo = deps.getServerInfo || getServerInfo;
    this._sendAdminMessage = deps.sendAdminMessage || sendAdminMessage;
    this._presenceTracker = deps.presenceTracker || null;
    this._label = String(deps.label || 'AUTO MSG')
      .replace(/[^\w\s:/-]/g, '')
      .slice(0, 40);
    this._db = deps.db || null;

    this.discordLink = this._config.discordInviteLink;

    // Intervals (configurable via .env, defaults in ms)
    this.linkInterval = this._config.autoMsgLinkInterval; // 30 min
    this.promoInterval = this._config.autoMsgPromoInterval; // 45 min

    this._linkTimer = null;
    this._promoTimer = null;
    this._onPlayerJoined = null; // bound listener reference for cleanup

    this._lastWelcomeTime = 0; // anti-spam: last RCON welcome sent
    this._welcomeCooldown = 5000; // ms between welcome messages
  }

  async start() {
    console.log(`[${this._label}] Starting auto-messages...`);

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

    // Welcome messages — subscribe to presence tracker join events
    if (this._config.enableWelcomeMsg && this._presenceTracker) {
      this._onPlayerJoined = (joiner) => this._sendWelcomeMessage(joiner);
      this._presenceTracker.on('playerJoined', this._onPlayerJoined);
      console.log(`[${this._label}] RCON welcome messages enabled (on player join)`);
    } else if (this._config.enableWelcomeMsg) {
      console.log(`[${this._label}] RCON welcome messages enabled but no presence tracker — skipping`);
    } else {
      console.log(`[${this._label}] RCON welcome messages disabled`);
    }
    // WelcomeMessage.txt is now managed exclusively by the Welcome File Editor
  }

  stop() {
    if (this._linkTimer) clearInterval(this._linkTimer);
    if (this._promoTimer) clearInterval(this._promoTimer);
    if (this._onPlayerJoined && this._presenceTracker) {
      this._presenceTracker.removeListener('playerJoined', this._onPlayerJoined);
      this._onPlayerJoined = null;
    }
    this._linkTimer = null;
    this._promoTimer = null;
    console.log(`[${this._label}] Stopped.`);
  }

  // ── Private methods ────────────────────────────────────────

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
}

// Mix in content-layer methods (difficulty text, PvP schedule text)
Object.assign(AutoMessages.prototype, {
  _difficultyText: content._difficultyText,
  _pvpScheduleText: content._pvpScheduleText,
});

module.exports = AutoMessages;
module.exports.buildWelcomeContent = buildWelcomeContent;

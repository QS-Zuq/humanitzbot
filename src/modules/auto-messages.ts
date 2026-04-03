import _defaultConfig from '../config/index.js';
import { sendAdminMessage, getServerInfo } from '../rcon/server-info.js';
import _defaultPlaytime from '../tracking/playtime-tracker.js';
import _defaultPlayerStats from '../tracking/player-stats.js';
import { createLogger } from '../utils/log.js';

// Content layer: text generation, color helpers, welcome file builder
import * as content from './auto-messages-content.js';
const { _rconColorLink, buildWelcomeContent } = content;

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- class uses dynamic this._xxx via index signature */
class AutoMessages {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Phase 5: replace index signature with typed fields
  [key: string]: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deps shape varies by caller
  constructor(deps: any = {}) {
    this._config = deps.config || _defaultConfig;
    this._playtime = deps.playtime || _defaultPlaytime;
    this._playerStats = deps.playerStats || _defaultPlayerStats;
    this._getServerInfo = deps.getServerInfo || getServerInfo;
    this._sendAdminMessage = deps.sendAdminMessage || sendAdminMessage;
    this._presenceTracker = deps.presenceTracker || null;
    this._log = createLogger(deps.label, 'AUTO MSG');
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

  start() {
    this._log.info('Starting auto-messages...');

    // Periodic Discord link broadcast
    if (this._config.enableAutoMsgLink) {
      this._linkTimer = setInterval(() => void this._sendDiscordLink(), this.linkInterval);
      this._log.info(`Discord link every ${this.linkInterval / 60000} min`);
    } else {
      this._log.info('Discord link broadcast disabled');
    }

    // Periodic promo message broadcast
    if (this._config.enableAutoMsgPromo) {
      this._promoTimer = setInterval(() => void this._sendPromoMessage(), this.promoInterval);
      this._log.info(`Promo message every ${this.promoInterval / 60000} min`);
    } else {
      this._log.info('Promo message disabled');
    }

    // Welcome messages — subscribe to presence tracker join events
    if (this._config.enableWelcomeMsg && this._presenceTracker) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- joiner shape from event emitter
      this._onPlayerJoined = (joiner: any) => void this._sendWelcomeMessage(joiner);
      this._presenceTracker.on('playerJoined', this._onPlayerJoined);
      this._log.info('RCON welcome messages enabled (on player join)');
    } else if (this._config.enableWelcomeMsg) {
      this._log.info('RCON welcome messages enabled but no presence tracker \u2014 skipping');
    } else {
      this._log.info('RCON welcome messages disabled');
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
    this._log.info('Stopped.');
  }

  // ── Private methods ────────────────────────────────────────

  /** Colorize a Discord invite link (instance wrapper). */
  _colorLink(link: string) {
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
      this._log.info('Sent Discord link to game chat');
    } catch (err: unknown) {
      this._log.error('Failed to send Discord link:', (err as Error).message);
    }
  }

  async _sendPromoMessage() {
    try {
      const custom = this._config.autoMsgPromoText;
      const msg = custom
        ? await this._resolveMessagePlaceholders(custom)
        : `<FO>Issues, suggestions, or just want to connect? ${_rconColorLink(this.discordLink)}`;
      await this._sendAdminMessage(msg);
      this._log.info('Sent promo message to game chat');
    } catch (err: unknown) {
      this._log.error('Failed to send promo message:', (err as Error).message);
    }
  }

  /** Resolve placeholders in custom broadcast messages. */
  async _resolveMessagePlaceholders(text: string) {
    const info = await this._getServerInfoSafe();
    return this._resolvePlaceholders(text, info);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- joiner shape from event emitter
  async _sendWelcomeMessage(joiner: any) {
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
      this._log.info(`Sent welcome to ${joiner.name} (${pt?.isReturning ? 'returning' : 'first-time'})`);
    } catch (err: unknown) {
      this._log.error(`Failed to send welcome to ${joiner.name}:`, (err as Error).message);
    }
  }
}
/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return */

// Mix in content-layer methods (difficulty text, PvP schedule text)
Object.assign(AutoMessages.prototype, {
  _difficultyText: content._difficultyText,
  _pvpScheduleText: content._pvpScheduleText,
});

export default AutoMessages;
export { AutoMessages };

export { buildWelcomeContent };

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- CJS compat
const _mod = module as { exports: any };
_mod.exports = AutoMessages;
// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- CJS compat
_mod.exports.AutoMessages = AutoMessages;
// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- CJS compat
_mod.exports.buildWelcomeContent = buildWelcomeContent;

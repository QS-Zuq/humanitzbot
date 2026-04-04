import _defaultConfig from '../config/index.js';
import { sendAdminMessage, getServerInfo, type ServerInfo } from '../rcon/server-info.js';
import _defaultPlaytime, { type PlaytimeTracker } from '../tracking/playtime-tracker.js';
import { createLogger, type Logger } from '../utils/log.js';

// Content layer: text generation, color helpers, welcome file builder
import * as content from './auto-messages-content.js';
import { errMsg } from '../utils/error.js';
const { _rconColorLink, buildWelcomeContent } = content;

type ConfigType = typeof _defaultConfig;
interface Joiner {
  name: string;
  steamId?: string;
}

interface PresenceTracker {
  on(event: string, listener: (...args: unknown[]) => void): void;
  removeListener(event: string, listener: (...args: unknown[]) => void): void;
}

interface AutoMessagesDeps {
  config?: ConfigType;
  playtime?: PlaytimeTracker;
  playerStats?: unknown;
  getServerInfo?: typeof getServerInfo;
  sendAdminMessage?: typeof sendAdminMessage;
  presenceTracker?: PresenceTracker | null;
  label?: string;
  db?: unknown;
}

class AutoMessages {
  private _config: ConfigType;
  private _playtime: PlaytimeTracker;
  private _getServerInfo: typeof getServerInfo;
  private _sendAdminMessage: typeof sendAdminMessage;
  private _presenceTracker: PresenceTracker | null;
  private _log: Logger;
  private discordLink: string;
  private linkInterval: number;
  private promoInterval: number;
  private _linkTimer: ReturnType<typeof setInterval> | null;
  private _promoTimer: ReturnType<typeof setInterval> | null;
  private _onPlayerJoined: ((joiner: Joiner) => void) | null;
  private _lastWelcomeTime: number;
  private _welcomeCooldown: number;

  // Mixed-in from auto-messages-content.ts via Object.assign
  declare _difficultyText: (this: AutoMessages) => string;
  declare _pvpScheduleText: (this: AutoMessages) => string;

  constructor(deps: AutoMessagesDeps = {}) {
    this._config = deps.config ?? _defaultConfig;
    this._playtime = deps.playtime ?? _defaultPlaytime;
    this._getServerInfo = deps.getServerInfo ?? getServerInfo;
    this._sendAdminMessage = deps.sendAdminMessage ?? sendAdminMessage;
    this._presenceTracker = deps.presenceTracker ?? null;
    this._log = createLogger(deps.label, 'AUTO MSG');
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
      this._onPlayerJoined = (joiner: Joiner) => void this._sendWelcomeMessage(joiner);
      this._presenceTracker.on('playerJoined', this._onPlayerJoined as (...args: unknown[]) => void);
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
      this._presenceTracker.removeListener('playerJoined', this._onPlayerJoined as (...args: unknown[]) => void);
      this._onPlayerJoined = null;
    }
    this._linkTimer = null;
    this._promoTimer = null;
    this._log.info('Stopped.');
  }

  // ── Private methods ────────────────────────────────────────

  private async _sendDiscordLink() {
    if (!this.discordLink) return;
    try {
      const custom = this._config.autoMsgLinkText;
      const msg = custom
        ? await this._resolveMessagePlaceholders(custom)
        : `<FO>Join our </><CL>Discord</><FO>! ${_rconColorLink(this.discordLink)}`;
      await this._sendAdminMessage(msg);
      this._log.info('Sent Discord link to game chat');
    } catch (err: unknown) {
      this._log.error('Failed to send Discord link:', errMsg(err));
    }
  }

  private async _sendPromoMessage() {
    try {
      const custom = this._config.autoMsgPromoText;
      const msg = custom
        ? await this._resolveMessagePlaceholders(custom)
        : `<FO>Issues, suggestions, or just want to connect? ${_rconColorLink(this.discordLink)}`;
      await this._sendAdminMessage(msg);
      this._log.info('Sent promo message to game chat');
    } catch (err: unknown) {
      this._log.error('Failed to send promo message:', errMsg(err));
    }
  }

  /** Resolve placeholders in custom broadcast messages. */
  private async _resolveMessagePlaceholders(text: string): Promise<string> {
    const info = await this._getServerInfoSafe();
    return this._resolvePlaceholders(text, info);
  }

  /** Safely fetch server info, returning an empty-fields object on failure. */
  private async _getServerInfoSafe(): Promise<ServerInfo> {
    try {
      return await this._getServerInfo();
    } catch {
      return { raw: '', fields: {} };
    }
  }

  /** Replace {placeholder} tokens in a text template with server info values. */
  private _resolvePlaceholders(text: string, info: ServerInfo): string {
    return text
      .replace(/\{players\}/gi, String(info.players ?? '?'))
      .replace(/\{maxPlayers\}/gi, String(info.maxPlayers ?? '?'))
      .replace(/\{serverName\}/gi, info.name ?? this._config.serverName)
      .replace(/\{time\}/gi, info.time ?? '?')
      .replace(/\{season\}/gi, info.season ?? '?')
      .replace(/\{day\}/gi, info.day ?? '?')
      .replace(/\{discord\}/gi, this.discordLink || '');
  }

  private async _sendWelcomeMessage(joiner: Joiner) {
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
      let msg: string;
      if (pt && pt.isReturning) {
        msg = `<FO>Welcome back, </>${joiner.name}<FO>!${sep}<FO>Playtime: ${pt.totalFormatted}${diffInfo}${link}`;
      } else {
        msg = `<FO>Welcome, </>${joiner.name}<FO>!${diffInfo}${link}`;
      }

      await this._sendAdminMessage(msg);
      this._lastWelcomeTime = Date.now();
      this._log.info(`Sent welcome to ${joiner.name} (${pt?.isReturning ? 'returning' : 'first-time'})`);
    } catch (err: unknown) {
      this._log.error(`Failed to send welcome to ${joiner.name}:`, errMsg(err));
    }
  }
}

// Mix in content-layer methods (difficulty text, PvP schedule text)
Object.assign(AutoMessages.prototype, {
  _difficultyText: content._difficultyText,
  _pvpScheduleText: content._pvpScheduleText,
});

export default AutoMessages;
export { AutoMessages };

export { buildWelcomeContent };

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

interface AutoMessagesReconfigureOptions {
  autoMsgLinkInterval?: unknown;
  autoMsgPromoInterval?: unknown;
  discordInviteLink?: unknown;
  autoMsgLinkText?: unknown;
  autoMsgPromoText?: unknown;
  enableAutoMsgLink?: unknown;
  enableAutoMsgPromo?: unknown;
  enableWelcomeMsg?: unknown;
}

function runtimeStringValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  return '';
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
      this._ensureLinkTimer();
      this._log.info(`Discord link every ${this.linkInterval / 60000} min`);
    } else {
      this._log.info('Discord link broadcast disabled');
    }

    // Periodic promo message broadcast
    if (this._config.enableAutoMsgPromo) {
      this._ensurePromoTimer();
      this._log.info(`Promo message every ${this.promoInterval / 60000} min`);
    } else {
      this._log.info('Promo message disabled');
    }

    // Welcome messages — subscribe to presence tracker join events
    if (this._config.enableWelcomeMsg && this._presenceTracker) {
      this._ensureWelcomeListener();
      this._log.info('RCON welcome messages enabled (on player join)');
    } else if (this._config.enableWelcomeMsg) {
      this._log.info('RCON welcome messages enabled but no presence tracker \u2014 skipping');
    } else {
      this._log.info('RCON welcome messages disabled');
    }
    // WelcomeMessage.txt is now managed exclusively by the Welcome File Editor
  }

  stop() {
    this._clearLinkTimer();
    this._clearPromoTimer();
    this._clearWelcomeListener();
    this._log.info('Stopped.');
  }

  reconfigure(options: AutoMessagesReconfigureOptions): void {
    if (Object.hasOwn(options, 'discordInviteLink')) {
      this.discordLink = runtimeStringValue(options.discordInviteLink);
      this._config.discordInviteLink = this.discordLink;
    }
    if (Object.hasOwn(options, 'autoMsgLinkText')) {
      this._config.autoMsgLinkText = runtimeStringValue(options.autoMsgLinkText);
    }
    if (Object.hasOwn(options, 'autoMsgPromoText')) {
      this._config.autoMsgPromoText = runtimeStringValue(options.autoMsgPromoText);
    }
    if (Object.hasOwn(options, 'autoMsgLinkInterval')) {
      this._reconfigureLinkInterval(options.autoMsgLinkInterval);
    }
    if (Object.hasOwn(options, 'autoMsgPromoInterval')) {
      this._reconfigurePromoInterval(options.autoMsgPromoInterval);
    }
    if (Object.hasOwn(options, 'enableAutoMsgLink')) {
      this._reconfigureLinkEnabled(options.enableAutoMsgLink);
    }
    if (Object.hasOwn(options, 'enableAutoMsgPromo')) {
      this._reconfigurePromoEnabled(options.enableAutoMsgPromo);
    }
    if (Object.hasOwn(options, 'enableWelcomeMsg')) {
      this._reconfigureWelcomeEnabled(options.enableWelcomeMsg);
    }
  }

  private _reconfigureLinkInterval(value: unknown): void {
    const previousInterval = this.linkInterval;
    const nextInterval = this._coerceInterval(value, previousInterval, 60_000);
    this._config.autoMsgLinkInterval = nextInterval;
    this.linkInterval = nextInterval;

    if (!this._linkTimer || nextInterval === previousInterval) return;

    this._clearLinkTimer();
    this._ensureLinkTimer();
    this._log.info(`Discord link every ${nextInterval / 60000} min`);
  }

  private _reconfigurePromoInterval(value: unknown): void {
    const previousInterval = this.promoInterval;
    const nextInterval = this._coerceInterval(value, previousInterval, 60_000);
    this._config.autoMsgPromoInterval = nextInterval;
    this.promoInterval = nextInterval;

    if (!this._promoTimer || nextInterval === previousInterval) return;

    this._clearPromoTimer();
    this._ensurePromoTimer();
    this._log.info(`Promo message every ${nextInterval / 60000} min`);
  }

  private _reconfigureLinkEnabled(value: unknown): void {
    const enabled = this._coerceBoolean(value, this._config.enableAutoMsgLink);
    this._config.enableAutoMsgLink = enabled;
    if (enabled) {
      this._ensureLinkTimer();
    } else {
      this._clearLinkTimer();
    }
  }

  private _reconfigurePromoEnabled(value: unknown): void {
    const enabled = this._coerceBoolean(value, this._config.enableAutoMsgPromo);
    this._config.enableAutoMsgPromo = enabled;
    if (enabled) {
      this._ensurePromoTimer();
    } else {
      this._clearPromoTimer();
    }
  }

  private _reconfigureWelcomeEnabled(value: unknown): void {
    const enabled = this._coerceBoolean(value, this._config.enableWelcomeMsg);
    this._config.enableWelcomeMsg = enabled;
    if (enabled) {
      this._ensureWelcomeListener();
    } else {
      this._clearWelcomeListener();
    }
  }

  private _ensureLinkTimer(): void {
    if (this._linkTimer) return;
    this._linkTimer = setInterval(() => void this._sendDiscordLink(), this.linkInterval);
  }

  private _ensurePromoTimer(): void {
    if (this._promoTimer) return;
    this._promoTimer = setInterval(() => void this._sendPromoMessage(), this.promoInterval);
  }

  private _clearLinkTimer(): void {
    if (!this._linkTimer) return;
    clearInterval(this._linkTimer);
    this._linkTimer = null;
  }

  private _clearPromoTimer(): void {
    if (!this._promoTimer) return;
    clearInterval(this._promoTimer);
    this._promoTimer = null;
  }

  private _ensureWelcomeListener(): void {
    if (!this._presenceTracker || this._onPlayerJoined) return;
    this._onPlayerJoined = (joiner: Joiner) => void this._sendWelcomeMessage(joiner);
    this._presenceTracker.on('playerJoined', this._onPlayerJoined as (...args: unknown[]) => void);
  }

  private _clearWelcomeListener(): void {
    if (!this._onPlayerJoined || !this._presenceTracker) {
      this._onPlayerJoined = null;
      return;
    }
    this._presenceTracker.removeListener('playerJoined', this._onPlayerJoined as (...args: unknown[]) => void);
    this._onPlayerJoined = null;
  }

  private _coerceInterval(value: unknown, fallback: number, minMs: number): number {
    const parsed = typeof value === 'number' ? value : typeof value === 'string' ? parseInt(value, 10) : Number.NaN;
    const interval = Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
    return Math.max(interval || fallback, minMs);
  }

  private _coerceBoolean(value: unknown, fallback: boolean): boolean {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value !== 'string') return fallback;
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'off'].includes(normalized)) return false;
    return fallback;
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

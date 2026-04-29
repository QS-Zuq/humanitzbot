import type { Client, Message, EmbedBuilder } from 'discord.js';
import _defaultConfig from '../config/index.js';
import { cleanOwnMessages, embedContentKey, safeEditMessage } from './discord-utils.js';
import _defaultPlaytime, { type PlaytimeTracker } from '../tracking/playtime-tracker.js';
import _defaultPlayerStats, { type PlayerStats } from '../tracking/player-stats.js';
import _defaultServerResources from '../server/server-resources.js';
import {
  getServerInfo as _defaultGetServerInfo,
  getPlayerList as _defaultGetPlayerList,
  sendAdminMessage as _defaultSendAdminMessage,
  type ServerInfo,
  type PlayerList,
} from '../rcon/server-info.js';
import { createLogger, type Logger } from '../utils/log.js';
import type { HumanitZDB } from '../db/database.js';
import {
  isServerStatusCacheFresh,
  makeServerStatusCacheDefault,
  normalizeServerStatusCache,
} from '../state/bot-state-schemas.js';

// Embed builders — presentation layer (mixed into prototype below)
import * as statusEmbeds from './server-status-embeds.js';

type ConfigType = typeof _defaultConfig;
type ServerResourcesType = typeof _defaultServerResources;
/** Discord channel with send/name — loose type for channels.fetch() result.
 *  Uses intersection to satisfy both runtime usage and discord-utils signatures. */
type DiscordChannel = import('discord.js').TextChannel;

interface ServerStatusDeps {
  config?: ConfigType;
  playtime?: PlaytimeTracker;
  playerStats?: PlayerStats;
  serverResources?: ServerResourcesType;
  getServerInfo?: typeof _defaultGetServerInfo;
  getPlayerList?: typeof _defaultGetPlayerList;
  sendAdminMessage?: typeof _defaultSendAdminMessage;
  db?: HumanitZDB | null;
  label?: string;
}

class ServerStatus {
  _config: ConfigType;
  _playtime: PlaytimeTracker;
  _playerStats: PlayerStats;
  _serverResources: ServerResourcesType;
  _getServerInfo: typeof _defaultGetServerInfo;
  _getPlayerList: typeof _defaultGetPlayerList;
  _sendAdminMessage: typeof _defaultSendAdminMessage;
  _db: HumanitZDB | null;
  _log: Logger;
  _label: string;
  client: Client;
  channel: DiscordChannel | null;
  statusMessage: Message | null;
  interval: ReturnType<typeof setInterval> | null;
  updateIntervalMs: number;
  _lastOnline: boolean | null;
  _offlineSince: Date | null;
  _onlineSince: Date | null;
  _lastInfo: ServerInfo | null;
  _lastPlayerList: PlayerList | null;
  _lastEmbedKey: string | null;

  // Embed builder methods mixed in via Object.assign (see bottom of file)
  declare _buildEmbed: (info: ServerInfo | null, playerList: PlayerList | null, resources?: unknown) => EmbedBuilder;
  declare _buildOfflineEmbed: () => Promise<EmbedBuilder>;

  constructor(client: Client, deps: ServerStatusDeps = {}) {
    this._config = deps.config || _defaultConfig;
    this._playtime = deps.playtime || _defaultPlaytime;
    this._playerStats = deps.playerStats || _defaultPlayerStats;
    this._serverResources = deps.serverResources || _defaultServerResources;

    this._getServerInfo = deps.getServerInfo || _defaultGetServerInfo;

    this._getPlayerList = deps.getPlayerList || _defaultGetPlayerList;

    this._sendAdminMessage = deps.sendAdminMessage || _defaultSendAdminMessage;
    this._db = deps.db || null;
    this._log = createLogger(deps.label, 'STATUS');
    this._label = this._log.label;

    this.client = client;
    this.channel = null;
    this.statusMessage = null;
    this.interval = null;
    this.updateIntervalMs = parseInt(String(this._config.serverStatusInterval), 10) || 30000;

    // Track online/offline state for transitions
    this._lastOnline = null;
    this._offlineSince = null;
    this._onlineSince = null;
    this._lastInfo = null;
    this._lastPlayerList = null;
    this._lastEmbedKey = null;

    // Load persisted state (uptime, cached info) so data survives bot restarts
    this._loadState();
  }

  async start() {
    this._log.info('Module starting...');
    this._log.info(`Channel ID from config: "${this._config.serverStatusChannelId}"`);
    try {
      if (!this._config.serverStatusChannelId) {
        this._log.info('No SERVER_STATUS_CHANNEL_ID set, skipping.');
        return;
      }

      this._log.info(`Fetching channel ${this._config.serverStatusChannelId}...`);
      this.channel = (await this.client.channels.fetch(this._config.serverStatusChannelId)) as DiscordChannel | null;
      if (!this.channel) {
        this._log.error('Channel not found! Check SERVER_STATUS_CHANNEL_ID.');
        return;
      }

      this._log.info(`Posting live status in #${this.channel.name} (every ${this.updateIntervalMs / 1000}s)`);

      // Delete previous own message (by saved ID), not all bot messages
      await this._cleanOwnMessage();

      // Post the initial embed
      const embed = this._buildEmbed(null, null);
      this.statusMessage = await this.channel.send({ embeds: [embed] });
      this._saveMessageId();

      // First real update
      await this._update();

      // Start the loop
      this.interval = setInterval(() => {
        void this._update();
      }, this.updateIntervalMs);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this._log.error('Failed to start:', msg);
      this._log.error('Full error:', String(err));
    }
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  async _cleanOwnMessage() {
    if (!this.channel) return;
    const savedId = this._loadMessageId();
    await cleanOwnMessages(this.channel, this.client, { savedIds: savedId ?? undefined, label: this._label });
  }

  _loadMessageId() {
    try {
      if (this._db) return this._db.botState.getState('msg_id_server_status') || null;
    } catch {}
    return null;
  }

  _saveMessageId() {
    if (!this.statusMessage) return;
    try {
      if (this._db) this._db.botState.setState('msg_id_server_status', this.statusMessage.id);
    } catch {}
  }

  async _update() {
    try {
      const [info, playerList] = await Promise.all([this._getServerInfo(), this._getPlayerList()]);

      // Fetch host resources (non-blocking — failure returns null)
      let resources = null;
      if (this._config.showHostResources && this._serverResources.backend) {
        try {
          resources = await this._serverResources.getResources();
        } catch {}
      }

      // Server is online — cache the data
      this._lastInfo = info;
      this._lastPlayerList = playerList;

      const wasOffline = this._lastOnline === false;
      if (wasOffline) {
        this._log.info('Server is back online');
      }
      const firstOnline = !this._onlineSince;
      if (firstOnline || wasOffline) {
        this._onlineSince = new Date();
      }
      this._lastOnline = true;
      this._offlineSince = null;
      if (wasOffline || firstOnline) this._saveState(); // persist on transition or first online

      const embed = this._buildEmbed(info, playerList, resources);

      if (this.statusMessage) {
        // Skip Discord API call if embed content hasn't changed
        const contentKey = embedContentKey(embed);
        if (contentKey === this._lastEmbedKey) return;
        this._lastEmbedKey = contentKey;

        this.statusMessage = await safeEditMessage(
          this.statusMessage,
          this.channel as import('discord.js').TextBasedChannel,
          { embeds: [embed] },
          {
            label: this._label,
            onRecreate: (msg: Message) => {
              this.statusMessage = msg;
              this._saveMessageId();
            },
          },
        );
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes('RCON not connected')) {
        // Server is offline — show offline embed with cached data
        if (this._lastOnline !== false) {
          this._offlineSince = new Date();
          this._log.info('Server appears offline');
        }
        this._lastOnline = false;
        this._saveState();

        const embed = await this._buildOfflineEmbed();
        if (this.statusMessage) {
          const contentKey = embedContentKey(embed);
          if (contentKey !== this._lastEmbedKey) {
            this._lastEmbedKey = contentKey;
            try {
              this.statusMessage = await safeEditMessage(
                this.statusMessage,
                this.channel as import('discord.js').TextBasedChannel,
                { embeds: [embed] },
                {
                  label: this._label,
                  onRecreate: (msg: Message) => {
                    this.statusMessage = msg;
                  },
                },
              );
            } catch {
              /* ignore */
            }
          }
        }
      } else {
        this._log.error('Update error:', errMsg);
      }
    }
  }

  /**
   * Load persisted state from disk so uptime and cached data survive bot restarts.
   */
  _loadState() {
    try {
      if (!this._db) return;
      const validated: unknown = this._db.botState.getStateJSONValidated(
        'server_status_cache',
        normalizeServerStatusCache,
        makeServerStatusCacheDefault(),
      );
      const { shape: data } = normalizeServerStatusCache(validated);
      if (!isServerStatusCacheFresh(data, Date.now(), this._config.statusCacheTtl)) return;
      if (data.onlineSince) this._onlineSince = new Date(data.onlineSince);
      if (data.offlineSince) this._offlineSince = new Date(data.offlineSince);
      if (data.lastOnline !== undefined && data.lastOnline !== null) this._lastOnline = data.lastOnline;
      if (data.lastInfo) this._lastInfo = data.lastInfo as unknown as ServerInfo;
      if (data.lastPlayerList) this._lastPlayerList = data.lastPlayerList as unknown as PlayerList;
      this._log.info(`Loaded cached state (online since: ${String(data.onlineSince) || 'unknown'})`);
    } catch (err: unknown) {
      this._log.info('Could not load cached state:', err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Persist current state to disk so it survives bot restarts.
   */
  _saveState() {
    try {
      if (!this._db) return;
      this._db.botState.setStateJSON('server_status_cache', {
        onlineSince: this._onlineSince?.toISOString() || null,
        offlineSince: this._offlineSince?.toISOString() || null,
        lastOnline: this._lastOnline,
        lastInfo: this._lastInfo,
        lastPlayerList: this._lastPlayerList,
        savedAt: new Date().toISOString(),
      });
    } catch (err: unknown) {
      this._log.error('Could not save state:', err instanceof Error ? err.message : String(err));
    }
  }

  _loadServerSettings(): Record<string, unknown> {
    try {
      if (this._db) {
        const data = this._db.botState.getStateJSON('server_settings', null) as Record<string, unknown> | null;
        if (data) return data;
      }
    } catch {}
    return {};
  }
}

// Mix in embed builders (presentation layer)
Object.assign(ServerStatus.prototype, statusEmbeds);

export default ServerStatus;
export { ServerStatus };

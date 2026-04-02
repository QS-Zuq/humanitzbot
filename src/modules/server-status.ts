/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment,
   @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call,
   @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return,
   @typescript-eslint/restrict-template-expressions, @typescript-eslint/no-misused-promises, @typescript-eslint/no-require-imports */

import _defaultConfig from '../config/index.js';
import { cleanOwnMessages, embedContentKey, safeEditMessage } from './discord-utils.js';
const _defaultPlaytime =
  require('../tracking/playtime-tracker') as import('../tracking/playtime-tracker.js').PlaytimeTracker;
const _defaultPlayerStats = require('../tracking/player-stats') as import('../tracking/player-stats.js').PlayerStats;
const _defaultServerResources =
  require('../server/server-resources') as import('../server/server-resources.js').ServerResources;
import { createLogger } from '../utils/log.js';

// Embed builders — presentation layer (mixed into prototype below)
import * as statusEmbeds from './server-status-embeds.js';

class ServerStatus {
  [key: string]: any;
  constructor(client: any, deps: any = {}) {
    this._config = deps.config || _defaultConfig;
    this._playtime = deps.playtime || _defaultPlaytime;
    this._playerStats = deps.playerStats || _defaultPlayerStats;
    this._serverResources = deps.serverResources || _defaultServerResources;

    this._getServerInfo = deps.getServerInfo || require('../rcon/server-info').getServerInfo;

    this._getPlayerList = deps.getPlayerList || require('../rcon/server-info').getPlayerList;

    this._sendAdminMessage = deps.sendAdminMessage || require('../rcon/server-info').sendAdminMessage;
    this._db = deps.db || null;
    this._log = createLogger(deps.label, 'STATUS');
    this._label = this._log.label;

    this.client = client;
    this.channel = null;
    this.statusMessage = null; // the single embed we keep editing
    this.interval = null;
    this.updateIntervalMs = parseInt(this._config.serverStatusInterval, 10) || 30000; // 30s default

    // Track online/offline state for transitions
    this._lastOnline = null; // null = unknown, true = online, false = offline
    this._offlineSince = null; // Date when server went offline
    this._onlineSince = null; // Date when server came online (for uptime)
    this._lastInfo = null; // cache last successful RCON info
    this._lastPlayerList = null; // cache last successful player list
    this._lastEmbedKey = null; // content hash to skip redundant edits

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
      this.channel = await this.client.channels.fetch(this._config.serverStatusChannelId);
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
      this.interval = setInterval(() => this._update(), this.updateIntervalMs);
    } catch (err: any) {
      this._log.error('Failed to start:', err.message);
      this._log.error('Full error:', err);
    }
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  async _cleanOwnMessage() {
    const savedId = this._loadMessageId();
    await cleanOwnMessages(this.channel, this.client, { savedIds: savedId, label: this._label });
  }

  _loadMessageId() {
    try {
      if (this._db) return this._db.getState('msg_id_server_status') || null;
    } catch {}
    return null;
  }

  _saveMessageId() {
    if (!this.statusMessage) return;
    try {
      if (this._db) this._db.setState('msg_id_server_status', this.statusMessage.id);
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
        } catch (_: any) {}
      }

      // Server is online — cache the data
      this._lastInfo = info;
      this._lastPlayerList = playerList;

      const wasOffline = this._lastOnline === false;
      if (wasOffline) {
        this._log.info('Server is back online');
      }
      if (!this._onlineSince || wasOffline) {
        this._onlineSince = new Date();
      }
      this._lastOnline = true;
      this._offlineSince = null;
      if (wasOffline || !this._onlineSince) this._saveState(); // only persist on transition

      const embed = this._buildEmbed(info, playerList, resources);

      if (this.statusMessage) {
        // Skip Discord API call if embed content hasn't changed
        const contentKey = embedContentKey(embed);
        if (contentKey === this._lastEmbedKey) return;
        this._lastEmbedKey = contentKey;

        this.statusMessage = await safeEditMessage(
          this.statusMessage,
          this.channel,
          { embeds: [embed] },
          {
            label: this._label,
            onRecreate: (msg: any) => {
              this.statusMessage = msg;
              this._saveMessageId();
            },
          },
        );
      }
    } catch (err: any) {
      if (err.message.includes('RCON not connected')) {
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
                this.channel,
                { embeds: [embed] },
                {
                  label: this._label,
                  onRecreate: (msg: any) => {
                    this.statusMessage = msg;
                  },
                },
              );
            } catch (_: any) {
              /* ignore */
            }
          }
        }
      } else {
        this._log.error('Update error:', err.message);
      }
    }
  }

  /**
   * Load persisted state from disk so uptime and cached data survive bot restarts.
   */
  _loadState() {
    try {
      if (!this._db) return;
      const data = this._db.getStateJSON('server_status_cache', null);
      if (!data) return;
      if (data.onlineSince) this._onlineSince = new Date(data.onlineSince);
      if (data.offlineSince) this._offlineSince = new Date(data.offlineSince);
      if (data.lastOnline !== undefined) this._lastOnline = data.lastOnline;
      if (data.lastInfo) this._lastInfo = data.lastInfo;
      if (data.lastPlayerList) this._lastPlayerList = data.lastPlayerList;
      this._log.info(`Loaded cached state (online since: ${data.onlineSince || 'unknown'})`);
    } catch (err: any) {
      this._log.info('Could not load cached state:', err.message);
    }
  }

  /**
   * Persist current state to disk so it survives bot restarts.
   */
  _saveState() {
    try {
      if (!this._db) return;
      this._db.setStateJSON('server_status_cache', {
        onlineSince: this._onlineSince?.toISOString() || null,
        offlineSince: this._offlineSince?.toISOString() || null,
        lastOnline: this._lastOnline,
        lastInfo: this._lastInfo,
        lastPlayerList: this._lastPlayerList,
        savedAt: new Date().toISOString(),
      });
    } catch (err: any) {
      this._log.error('Could not save state:', err.message);
    }
  }

  _loadServerSettings() {
    try {
      if (this._db) {
        const data = this._db.getStateJSON('server_settings', null);
        if (data) return data;
      }
    } catch (_: any) {}
    return {};
  }
}

// Mix in embed builders (presentation layer)
Object.assign(ServerStatus.prototype, statusEmbeds);

export default ServerStatus;
export { ServerStatus };

const _mod = module as { exports: any };
_mod.exports = ServerStatus;
_mod.exports.ServerStatus = ServerStatus;

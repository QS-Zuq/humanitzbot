/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any, @typescript-eslint/restrict-template-expressions, @typescript-eslint/no-misused-promises, @typescript-eslint/no-confusing-void-expression, @typescript-eslint/require-await, @typescript-eslint/use-unknown-in-catch-callback-variable */

import { ChannelType } from 'discord.js';
import _defaultConfig from '../config/index.js';
import { getPlayerList } from '../rcon/server-info.js';

const STATUS_CHANNELS = [{ key: 'players', template: '\u{1F465} Players: {value}', fallback: '\u{1F465} Players: --' }];

class StatusChannels {
  [key: string]: any;
  /**
   * @param {import('discord.js').Client} client
   * @param {object} [deps]
   * @param {object} [deps.config]        Config overrides (for multi-server)
   * @param {Function} [deps.getPlayerList] Custom getPlayerList function (bound to a specific rcon)
   * @param {string} [deps.categoryName]   Category name hint — used to find (NOT create) the category
   */
  constructor(client: any, deps: any = {}) {
    this.client = client;
    this.guild = null;
    this.channels = new Map(); // key -> channel
    this.interval = null;
    this._config = deps.config || _defaultConfig;
    this._getPlayerList = deps.getPlayerList || getPlayerList;
    this._categoryHint = deps.categoryName || '';
    this.updateIntervalMs = Math.max(this._config.statusChannelInterval || 60000, 60000); // min 60s (Discord rate limits)
  }

  async start() {
    try {
      this.guild = await this.client.guilds.fetch(this._config.guildId);
      if (!this.guild) {
        console.error('[STATUS] Guild not found! Check DISCORD_GUILD_ID.');
        return;
      }

      // Find existing voice channels matching the "👥 Players:" pattern.
      // Search in the hinted category first, then across all categories.
      // We NEVER create categories or channels — the user manages their own layout.
      for (const ch of STATUS_CHANNELS) {
        await this._findChannel(ch);
      }

      const found = this.channels.size;
      if (found === 0) {
        console.log('[STATUS] No voice channels matching "👥 Players:" found — skipping status channels');
        return;
      }

      console.log(`[STATUS] Found ${found} status channel(s) (updating every ${this.updateIntervalMs / 1000}s)`);

      // Initial update
      this._update().catch((err) => console.error('[STATUS] Initial update error:', err.message));

      // Start repeating updates
      this.interval = setInterval(() => this._update(), this.updateIntervalMs);
    } catch (err: any) {
      console.error('[STATUS] Failed to start:', err.message);
    }
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  /**
   * Find an existing voice channel matching the status pattern.
   * Searches by prefix ("👥 Pl") in any category. If a category hint is provided,
   * prefer channels inside that category.
   */
  async _findChannel(spec: any) {
    const prefix = spec.template.split('{value}')[0].substring(0, 5);
    const allChannels = this.guild.channels.cache;

    // Prefer channel in hinted category
    if (this._categoryHint) {
      const cat = allChannels.find(
        (c: any) =>
          c.type === ChannelType.GuildCategory &&
          c.name.toLowerCase().includes(this._categoryHint.replace(/📊\s*/g, '').toLowerCase().substring(0, 10)),
      );
      if (cat) {
        const inCat = allChannels.find(
          (c: any) => c.parentId === cat.id && c.type === ChannelType.GuildVoice && c.name.startsWith(prefix),
        );
        if (inCat) {
          this.channels.set(spec.key, inCat);
          return;
        }
      }
    }

    // Fallback: search across all categories
    const found = allChannels.find((c: any) => c.type === ChannelType.GuildVoice && c.name.startsWith(prefix));
    if (found) {
      this.channels.set(spec.key, found);
    }
  }

  async _update() {
    try {
      const playerList = await this._getPlayerList();

      const values: Record<string, string> = {
        players: `${playerList.count}`,
      };

      for (const spec of STATUS_CHANNELS) {
        const channel = this.channels.get(spec.key);
        if (!channel) continue;

        const value = values[spec.key] || '--';
        const newName = spec.template.replace('{value}', value);

        if (channel.name !== newName) {
          try {
            await channel.setName(newName);
          } catch (err: any) {
            if (err.code === 50013 || err.message.includes('rate')) {
              // silently skip rate limit / permission errors
            } else {
              console.error(`[STATUS] Failed to rename ${spec.key}:`, err.message);
            }
          }
        }
      }
    } catch (err: any) {
      if (err.message.includes('RCON not connected')) {
        // Server offline — show "Offline" in voice channel name
        for (const spec of STATUS_CHANNELS) {
          const channel = this.channels.get(spec.key);
          if (!channel) continue;

          const offlineName = spec.template.replace('{value}', 'Offline');
          if (channel.name !== offlineName) {
            try {
              await channel.setName(offlineName);
            } catch (_: any) {
              /* rate limit / permission — ignore */
            }
          }
        }
      } else {
        console.error('[STATUS] Update error:', err.message);
      }
    }
  }
}

export default StatusChannels;
export { StatusChannels };

const _mod = module as { exports: any };

_mod.exports = StatusChannels;
/* eslint-enable @typescript-eslint/no-unsafe-member-access */

const { ChannelType } = require('discord.js');
const _defaultConfig = require('../config');
const { getPlayerList } = require('../rcon/server-info');

const STATUS_CHANNELS = [
  { key: 'players', template: '\u{1F465} Players: {value}', fallback: '\u{1F465} Players: --' },
];

class StatusChannels {
  /**
   * @param {import('discord.js').Client} client
   * @param {object} [deps]
   * @param {object} [deps.config]        Config overrides (for multi-server)
   * @param {Function} [deps.getPlayerList] Custom getPlayerList function (bound to a specific rcon)
   * @param {string} [deps.categoryName]   Category name hint — used to find (NOT create) the category
   */
  constructor(client, deps = {}) {
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
      this._update().catch(err => console.error('[STATUS] Initial update error:', err.message));

      // Start repeating updates
      this.interval = setInterval(() => this._update(), this.updateIntervalMs);
    } catch (err) {
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
  async _findChannel(spec) {
    const prefix = spec.template.split('{value}')[0].substring(0, 5);
    const allChannels = this.guild.channels.cache;

    // Prefer channel in hinted category
    if (this._categoryHint) {
      const cat = allChannels.find(
        c => c.type === ChannelType.GuildCategory &&
             c.name.toLowerCase().includes(this._categoryHint.replace(/📊\s*/g, '').toLowerCase().substring(0, 10))
      );
      if (cat) {
        const inCat = allChannels.find(
          c => c.parentId === cat.id &&
               c.type === ChannelType.GuildVoice &&
               c.name.startsWith(prefix)
        );
        if (inCat) {
          this.channels.set(spec.key, inCat);
          return;
        }
      }
    }

    // Fallback: search across all categories
    const found = allChannels.find(
      c => c.type === ChannelType.GuildVoice && c.name.startsWith(prefix)
    );
    if (found) {
      this.channels.set(spec.key, found);
    }
  }

  async _update() {
    try {
      const playerList = await this._getPlayerList();

      const values = {
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
          } catch (err) {
            if (err.code === 50013 || err.message.includes('rate')) {
              // silently skip rate limit / permission errors
            } else {
              console.error(`[STATUS] Failed to rename ${spec.key}:`, err.message);
            }
          }
        }
      }
    } catch (err) {
      if (err.message.includes('RCON not connected')) {
        // Server offline — show "Offline" in voice channel name
        for (const spec of STATUS_CHANNELS) {
          const channel = this.channels.get(spec.key);
          if (!channel) continue;

          const offlineName = spec.template.replace('{value}', 'Offline');
          if (channel.name !== offlineName) {
            try {
              await channel.setName(offlineName);
            } catch (_) { /* rate limit / permission — ignore */ }
          }
        }
      } else {
        console.error('[STATUS] Update error:', err.message);
      }
    }
  }

}

module.exports = StatusChannels;

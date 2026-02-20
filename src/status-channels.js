const { ChannelType, PermissionFlagsBits } = require('discord.js');
const config = require('./config');
const { getPlayerList } = require('./server-info');

const STATUS_CHANNELS = [
  { key: 'players', template: '\u{1F465} Players: {value}', fallback: '\u{1F465} Players: --' },
];

const CATEGORY_NAME = '\u{1F4CA} HumanitZ Server Info';

class StatusChannels {
  constructor(client) {
    this.client = client;
    this.guild = null;
    this.category = null;
    this.channels = new Map(); // key -> channel
    this.interval = null;
    this.updateIntervalMs = Math.max(config.statusChannelInterval || 60000, 60000); // min 60s (Discord rate limits)
  }

  async start() {
    try {
      this.guild = await this.client.guilds.fetch(config.guildId);
      if (!this.guild) {
        console.error('[STATUS] Guild not found! Check DISCORD_GUILD_ID.');
        return;
      }

      // Find or create the category
      await this._ensureCategory();

      // Find or create the players channel
      for (const ch of STATUS_CHANNELS) {
        await this._ensureChannel(ch);
      }

      console.log(`[STATUS] Status channel ready in "${CATEGORY_NAME}" (updating every ${this.updateIntervalMs / 1000}s)`);

      // Initial update (don't await — voice channel renames can stall due to Discord rate limits)
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

  async _ensureCategory() {
    const existing = this.guild.channels.cache.find(
      c => c.type === ChannelType.GuildCategory && c.name === CATEGORY_NAME
    );

    if (existing) {
      this.category = existing;
      await this._ensureBotPermissions(existing);
    } else {
      this.category = await this.guild.channels.create({
        name: CATEGORY_NAME,
        type: ChannelType.GuildCategory,
        position: 0,
        permissionOverwrites: [
          {
            id: this.guild.id, // @everyone
            deny: [PermissionFlagsBits.Connect],
          },
          {
            id: this.client.user.id, // bot
            allow: [PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect],
          },
        ],
      });
      console.log(`[STATUS] Created category: ${CATEGORY_NAME}`);
    }

    // Try to move to top
    try {
      await this.category.setPosition(0);
    } catch (_) {
      // may fail if already at top
    }
  }

  async _ensureChannel(spec) {
    const prefix = spec.template.split('{value}')[0];
    const existing = this.guild.channels.cache.find(
      c => c.parentId === this.category.id &&
           c.type === ChannelType.GuildVoice &&
           c.name.startsWith(prefix.substring(0, 5))
    );

    if (existing) {
      this.channels.set(spec.key, existing);
      await this._ensureBotPermissions(existing);
    } else {
      const channel = await this.guild.channels.create({
        name: spec.fallback,
        type: ChannelType.GuildVoice,
        parent: this.category.id,
        permissionOverwrites: [
          {
            id: this.guild.id,
            deny: [PermissionFlagsBits.Connect],
          },
          {
            id: this.client.user.id,
            allow: [PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect],
          },
        ],
      });
      this.channels.set(spec.key, channel);
      console.log(`[STATUS] Created channel: ${spec.fallback}`);
    }
  }

  async _update() {
    try {
      const playerList = await getPlayerList();

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
      if (!err.message.includes('RCON not connected')) {
        console.error('[STATUS] Update error:', err.message);
      }
    }
  }

  async _ensureBotPermissions(channel) {
    try {
      await channel.permissionOverwrites.edit(this.client.user.id, {
        ManageChannels: true,
        ViewChannel: true,
        Connect: true,
      });
    } catch (err) {
      console.error(`[STATUS] Could not set bot permissions on ${channel.name}:`, err.message);
    }
  }
}

module.exports = StatusChannels;

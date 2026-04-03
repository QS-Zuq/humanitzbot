import { type Client, type Guild, type VoiceChannel, ChannelType, type GuildBasedChannel } from 'discord.js';
import _defaultConfig from '../config/index.js';
import { getPlayerList } from '../rcon/server-info.js';
import { errMsg } from '../utils/error.js';

type ConfigType = typeof _defaultConfig;

interface StatusSpec {
  key: string;
  template: string;
  fallback: string;
}

const STATUS_CHANNELS: StatusSpec[] = [
  { key: 'players', template: '\u{1F465} Players: {value}', fallback: '\u{1F465} Players: --' },
];

interface StatusChannelsDeps {
  config?: ConfigType;
  getPlayerList?: typeof getPlayerList;
  categoryName?: string;
}

class StatusChannels {
  private client: Client;
  private guild: Guild | null;
  private channels: Map<string, VoiceChannel>;
  private interval: ReturnType<typeof setInterval> | null;
  private _config: ConfigType;
  private _getPlayerList: typeof getPlayerList;
  private _categoryHint: string;
  private updateIntervalMs: number;

  constructor(client: Client, deps: StatusChannelsDeps = {}) {
    this.client = client;
    this.guild = null;
    this.channels = new Map(); // key -> channel
    this.interval = null;
    this._config = deps.config ?? _defaultConfig;
    this._getPlayerList = deps.getPlayerList ?? getPlayerList;
    this._categoryHint = deps.categoryName ?? '';
    this.updateIntervalMs = Math.max(this._config.statusChannelInterval || 60000, 60000); // min 60s (Discord rate limits)
  }

  async start() {
    try {
      const guildId = this._config.guildId;
      if (!guildId) {
        console.error('[STATUS] Guild not found! Check DISCORD_GUILD_ID.');
        return;
      }
      this.guild = await this.client.guilds.fetch(guildId);

      // Find existing voice channels matching the "👥 Players:" pattern.
      // Search in the hinted category first, then across all categories.
      // We NEVER create categories or channels — the user manages their own layout.
      for (const ch of STATUS_CHANNELS) {
        this._findChannel(ch);
      }

      const found = this.channels.size;
      if (found === 0) {
        console.log('[STATUS] No voice channels matching "👥 Players:" found — skipping status channels');
        return;
      }

      console.log(`[STATUS] Found ${found} status channel(s) (updating every ${this.updateIntervalMs / 1000}s)`);

      // Initial update
      void this._update().catch((err: unknown) => {
        console.error('[STATUS] Initial update error:', errMsg(err));
      });

      // Start repeating updates
      this.interval = setInterval(() => void this._update(), this.updateIntervalMs);
    } catch (err: unknown) {
      console.error('[STATUS] Failed to start:', errMsg(err));
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
  private _findChannel(spec: StatusSpec) {
    const prefix = (spec.template.split('{value}')[0] ?? '').substring(0, 5);
    if (!this.guild) return;
    const allChannels = this.guild.channels.cache;

    // Prefer channel in hinted category
    if (this._categoryHint) {
      const cat = allChannels.find(
        (c: GuildBasedChannel) =>
          c.type === ChannelType.GuildCategory &&
          c.name.toLowerCase().includes(this._categoryHint.replace(/📊\s*/g, '').toLowerCase().substring(0, 10)),
      );
      if (cat) {
        const inCat = allChannels.find(
          (c: GuildBasedChannel) =>
            c.parentId === cat.id && c.type === ChannelType.GuildVoice && c.name.startsWith(prefix),
        );
        if (inCat) {
          this.channels.set(spec.key, inCat as VoiceChannel);
          return;
        }
      }
    }

    // Fallback: search across all categories
    const found = allChannels.find(
      (c: GuildBasedChannel) => c.type === ChannelType.GuildVoice && c.name.startsWith(prefix),
    );
    if (found) {
      this.channels.set(spec.key, found as VoiceChannel);
    }
  }

  private async _update() {
    try {
      const playerList = await this._getPlayerList();

      const values: Record<string, string> = {
        players: `${playerList.count}`,
      };

      for (const spec of STATUS_CHANNELS) {
        const channel = this.channels.get(spec.key);
        if (!channel) continue;

        const value = values[spec.key] ?? '--';
        const newName = spec.template.replace('{value}', value);

        if (channel.name !== newName) {
          try {
            await channel.setName(newName);
          } catch (err: unknown) {
            const dErr = err as { code?: number; message: string };
            if (dErr.code === 50013 || dErr.message.includes('rate')) {
              // silently skip rate limit / permission errors
            } else {
              console.error(`[STATUS] Failed to rename ${spec.key}:`, dErr.message);
            }
          }
        }
      }
    } catch (err: unknown) {
      const e = err as Error;
      if (e.message.includes('RCON not connected')) {
        // Server offline — show "Offline" in voice channel name
        for (const spec of STATUS_CHANNELS) {
          const channel = this.channels.get(spec.key);
          if (!channel) continue;

          const offlineName = spec.template.replace('{value}', 'Offline');
          if (channel.name !== offlineName) {
            try {
              await channel.setName(offlineName);
            } catch {
              /* rate limit / permission — ignore */
            }
          }
        }
      } else {
        console.error('[STATUS] Update error:', e.message);
      }
    }
  }
}

export default StatusChannels;
export { StatusChannels };

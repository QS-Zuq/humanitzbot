const { EmbedBuilder } = require('discord.js');
const _defaultConfig = require('../config');
const { cleanOwnMessages, embedContentKey, safeEditMessage } = require('./discord-utils');
const { getServerInfo, getPlayerList } = require('../rcon/server-info');
const _defaultPlaytime = require('../tracking/playtime-tracker');
const _defaultPlayerStats = require('../tracking/player-stats');
const _defaultServerResources = require('../server/server-resources');
const { formatBytes } = require('../server/server-resources');
const {
  formatTime: _formatTime,
  weatherEmoji: _weatherEmoji,
  seasonEmoji: _seasonEmoji,
  timeEmoji: _timeEmoji,
  progressBar: _progressBar,
  buildScheduleField: _buildScheduleField,
  buildSettingsFields: _buildSettingsFields,
  buildLootScarcity: _buildLootScarcity,
  buildWeatherOdds: _buildWeatherOdds,
  buildResourceField: _buildResourceField,
} = require('../server/server-display');

// Formatting helpers imported from ../server/server-display.js:
// _formatTime, _weatherEmoji, _seasonEmoji, _timeEmoji, _progressBar,
// _buildScheduleField, _buildSettingsFields, _buildLootScarcity,
// _buildWeatherOdds, _buildResourceField

class ServerStatus {
  constructor(client, deps = {}) {
    this._config = deps.config || _defaultConfig;
    this._playtime = deps.playtime || _defaultPlaytime;
    this._playerStats = deps.playerStats || _defaultPlayerStats;
    this._serverResources = deps.serverResources || _defaultServerResources;
    this._getServerInfo = deps.getServerInfo || require('../rcon/server-info').getServerInfo;
    this._getPlayerList = deps.getPlayerList || require('../rcon/server-info').getPlayerList;
    this._sendAdminMessage = deps.sendAdminMessage || require('../rcon/server-info').sendAdminMessage;
    this._db = deps.db || null;
    this._label = deps.label || 'STATUS';

    this.client = client;
    this.channel = null;
    this.statusMessage = null; // the single embed we keep editing
    this.interval = null;
    this.updateIntervalMs = parseInt(this._config.serverStatusInterval, 10) || 30000; // 30s default

    // Track online/offline state for transitions
    this._lastOnline = null;       // null = unknown, true = online, false = offline
    this._offlineSince = null;     // Date when server went offline
    this._onlineSince = null;      // Date when server came online (for uptime)
    this._lastInfo = null;         // cache last successful RCON info
    this._lastPlayerList = null;   // cache last successful player list
    this._lastEmbedKey = null;     // content hash to skip redundant edits

    // Load persisted state (uptime, cached info) so data survives bot restarts
    this._loadState();
  }

  async start() {
    console.log(`[${this._label}] Module starting...`);
    console.log(`[${this._label}] Channel ID from config: "${this._config.serverStatusChannelId}"`);
    try {
      if (!this._config.serverStatusChannelId) {
        console.log(`[${this._label}] No SERVER_STATUS_CHANNEL_ID set, skipping.`);
        return;
      }

      console.log(`[${this._label}] Fetching channel ${this._config.serverStatusChannelId}...`);
      this.channel = await this.client.channels.fetch(this._config.serverStatusChannelId);
      if (!this.channel) {
        console.error(`[${this._label}] Channel not found! Check SERVER_STATUS_CHANNEL_ID.`);
        return;
      }

      console.log(`[${this._label}] Posting live status in #${this.channel.name} (every ${this.updateIntervalMs / 1000}s)`);

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
    } catch (err) {
      console.error(`[${this._label}] Failed to start:`, err.message);
      console.error(`[${this._label}] Full error:`, err);
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
      const [info, playerList] = await Promise.all([
        this._getServerInfo(),
        this._getPlayerList(),
      ]);

      // Fetch host resources (non-blocking — failure returns null)
      let resources = null;
      if (this._config.showHostResources && this._serverResources.backend) {
        try { resources = await this._serverResources.getResources(); } catch (_) {}
      }

      // Server is online — cache the data
      this._lastInfo = info;
      this._lastPlayerList = playerList;

      const wasOffline = this._lastOnline === false;
      if (wasOffline) {
        console.log(`[${this._label}] Server is back online`);
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

        this.statusMessage = await safeEditMessage(this.statusMessage, this.channel, { embeds: [embed] }, {
          label: this._label,
          onRecreate: (msg) => { this.statusMessage = msg; this._saveMessageId(); },
        });
      }
    } catch (err) {
      if (err.message.includes('RCON not connected')) {
        // Server is offline — show offline embed with cached data
        if (this._lastOnline !== false) {
          this._offlineSince = new Date();
          console.log(`[${this._label}] Server appears offline`);
        }
        this._lastOnline = false;
        this._saveState();

        const embed = await this._buildOfflineEmbed();
        if (this.statusMessage) {
          const contentKey = embedContentKey(embed);
          if (contentKey !== this._lastEmbedKey) {
            this._lastEmbedKey = contentKey;
            try {
              this.statusMessage = await safeEditMessage(this.statusMessage, this.channel, { embeds: [embed] }, {
                label: this._label,
                onRecreate: (msg) => { this.statusMessage = msg; },
              });
            } catch (_) { /* ignore */ }
          }
        }
      } else {
        console.error(`[${this._label}] Update error:`, err.message);
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
      console.log(`[${this._label}] Loaded cached state (online since: ${data.onlineSince || 'unknown'})`);
    } catch (err) {
      console.log(`[${this._label}] Could not load cached state:`, err.message);
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
    } catch (err) {
      console.error(`[${this._label}] Could not save state:`, err.message);
    }
  }

  _loadServerSettings() {
    try {
      if (this._db) {
        const data = this._db.getStateJSON('server_settings', null);
        if (data) return data;
      }
    } catch (_) {}
    return {};
  }

  _buildEmbed(info, playerList, resources) {
    const serverTag = this._config.serverName ? ` — ${this._config.serverName}` : '';
    const embed = new EmbedBuilder()
      .setTitle(`HumanitZ Server Status${serverTag}`)
      .setColor(0x2ecc71)
      .setTimestamp()
      .setFooter({ text: 'Last updated' });

    if (!info || !playerList) {
      embed.setDescription('Fetching server data...');
      return embed;
    }

    // Server name + status line
    const host = this._config.publicHost || this._config.rconHost || 'unknown';
    const port = this._config.gamePort || null;
    const connectStr = port ? `${host}:${port}` : host;
    const descParts = [];
    if (info.name) descParts.push(`**${info.name}**`);

    let uptimeStr = '';
    // Prefer panel API container uptime (actual server process) over bot tracking
    if (resources?.uptime != null) {
      const { formatUptime: fmtUp } = require('../server/server-resources');
      const up = fmtUp(resources.uptime);
      if (up) uptimeStr = ` · Uptime: ${up}`;
    } else if (this._onlineSince) {
      const ms = Date.now() - this._onlineSince.getTime();
      const mins = Math.floor(ms / 60000);
      if (mins < 60) {
        uptimeStr = ` · Uptime: ${mins}m`;
      } else {
        const hrs = Math.floor(mins / 60);
        const rem = mins % 60;
        uptimeStr = ` · Uptime: ${hrs}h ${rem}m`;
      }
    }

    descParts.push(`🟢 **Online**${uptimeStr}\n\`${connectStr}\``);
    embed.setDescription(descParts.join('\n'));

    // ── World Info (inline row) ──
    let playerCount = '--';
    let playerBar = '';
    if (info.players != null) {
      const max = parseInt(info.maxPlayers, 10) || 0;
      const cur = parseInt(info.players, 10) || 0;
      playerCount = max ? `${cur} / ${max}` : `${cur}`;
      if (max > 0) playerBar = `\n${_progressBar(cur / max, 12)}`;
    } else {
      playerCount = `${playerList.count}`;
    }

    const time = _formatTime(info.time) || '--';

    // Always load settings — save-derived fields are needed for day/season/weather/world stats fallbacks
    const settings = this._loadServerSettings();

    // Season & weather: prefer RCON, fall back to save-derived values
    const season = info.season || settings._currentSeason || '--';
    const weather = info.weather || settings._currentWeather || '--';

    embed.addFields(
      { name: '👥 Players Online', value: `${playerCount}${playerBar}`, inline: true },
      { name: `${_timeEmoji(time)}Time`, value: time, inline: true },
    );

    // Day number — prefer RCON, fall back to save file world state written by player-stats-channel
    const dayValue = info.day || (settings._daysPassed != null ? String(Math.floor(settings._daysPassed)) : null);
    if (this._config.showServerDay && dayValue) {
      embed.addFields({ name: '📅 Day', value: dayValue, inline: true });
    }

    // Season progress: compute day within current season
    let seasonDisplay = `${_seasonEmoji(season)}${season}`;
    if (this._config.showSeasonProgress && settings.DaysPerSeason) {
      const dps = parseInt(settings.DaysPerSeason, 10);
      // Prefer save-file currentSeasonDay (exact), fall back to manual calculation from total days
      if (dps > 0 && settings._currentSeasonDay != null) {
        const dayInSeason = Math.floor(settings._currentSeasonDay) + 1; // save is 0-indexed
        seasonDisplay = `${_seasonEmoji(season)}${season} (Day ${dayInSeason}/${dps})`;
      } else if (dps > 0 && dayValue) {
        const day = parseInt(dayValue, 10);
        if (day > 0) {
          const dayInSeason = ((day - 1) % dps) + 1;
          seasonDisplay = `${_seasonEmoji(season)}${season} (Day ${dayInSeason}/${dps})`;
        }
      }
    }

    embed.addFields(
      { name: '🌍 Season / Weather', value: `${seasonDisplay} · ${_weatherEmoji(weather)}${weather}`, inline: true },
    );

    // FPS + AI (from RCON info)
    if (this._config.showServerPerformance) {
      const perfParts = [];
      if (info.fps) perfParts.push(`FPS: **${info.fps}**`);
      if (info.ai) perfParts.push(`AI: **${info.ai}**`);
      if (perfParts.length > 0) {
        embed.addFields({ name: '⚡ Performance', value: perfParts.join('  ·  '), inline: true });
      }
    }

    // Version (from RCON info)
    if (this._config.showServerVersion && info.version) {
      embed.addFields({ name: '📋 Version', value: info.version, inline: true });
    }

    // Host Resources (from panel API or SSH)
    if (this._config.showHostResources && resources) {
      embed.addFields(..._buildResourceField(resources));
    }

    // ── Online Players ──
    if (playerList.players && playerList.players.length > 0) {
      const names = playerList.players.map(p => p.name).join(', ');
      embed.addFields({ name: '🎮 Online Now', value: names.substring(0, 1024) });
    } else {
      embed.addFields({ name: '🎮 Online Now', value: '*No players online*' });
    }

    // ── Server Settings (from GameServerSettings.ini) ──
    if (this._config.showServerSettings && Object.keys(settings).length > 0) {
      const settingsFields = _buildSettingsFields(settings, this._config);
      if (settingsFields.length > 0) {
        embed.addFields(...settingsFields);
      }
    }

    // ── Loot Scarcity + Weather Odds (side by side) ──
    {
      const lootLine = this._config.showLootScarcity && Object.keys(settings).length > 0
        ? _buildLootScarcity(settings) : null;
      const weatherLine = this._config.showWeatherOdds && Object.keys(settings).length > 0
        ? _buildWeatherOdds(settings) : null;
      if (lootLine && weatherLine) {
        embed.addFields(
          { name: '📦 Loot Scarcity', value: lootLine, inline: true },
          { name: '🌤️ Weather Odds', value: weatherLine, inline: true },
        );
      } else if (lootLine) {
        embed.addFields({ name: '📦 Loot Scarcity', value: lootLine });
      } else if (weatherLine) {
        embed.addFields({ name: '🌤️ Weather Odds', value: weatherLine });
      }
    }

    // ── Top 3 Playtime ──
    const leaderboard = this._playtime.getLeaderboard();
    if (leaderboard.length > 0) {
      const medals = ['🥇', '🥈', '🥉'];
      const top3 = leaderboard.slice(0, 3).map((entry, i) => {
        return `${medals[i]} **${entry.name}** — ${entry.totalFormatted}`;
      });
      embed.addFields({ name: '⏱️ Top Playtime', value: top3.join('\n') });
    }

    // ── World Stats (from save file) ──
    if (this._config.showWorldStats) {
      const worldParts = [];
      if (settings._totalPlayers != null) worldParts.push(`👥 Players: **${settings._totalPlayers}**`);
      if (settings._totalZombieKills != null) worldParts.push(`🧟 Zombies Killed: **${settings._totalZombieKills.toLocaleString()}**`);
      if (settings._totalStructures != null) worldParts.push(`🏗️ Structures: **${settings._totalStructures.toLocaleString()}**`);
      if (settings._totalVehicles != null) worldParts.push(`🚗 Vehicles: **${settings._totalVehicles}**`);
      if (settings._totalCompanions != null && settings._totalCompanions > 0) worldParts.push(`🐕 Companions: **${settings._totalCompanions}**`);
      if (worldParts.length > 0) {
        embed.addFields({ name: '🌎 World Stats', value: worldParts.join('  ·  ') });
      }
    }

    // ── Player Activity Stats ──
    const allTracked = this._playerStats.getAllPlayers();
    if (allTracked.length > 0) {
      const totalDeaths = allTracked.reduce((s, p) => s + p.deaths, 0);
      const totalBuilds = allTracked.reduce((s, p) => s + p.builds, 0);
      const totalLoots = allTracked.reduce((s, p) => s + p.containersLooted, 0);
      const parts = [
        `💀 Deaths: **${totalDeaths}**`,
        `🔨 Builds: **${totalBuilds}**`,
        `📦 Looted: **${totalLoots}**`,
      ];
      if (this._config.showRaidStats) {
        const totalRaids = allTracked.reduce((s, p) => s + p.raidsOut, 0);
        parts.push(`⚔️ Raids: **${totalRaids}**`);
      }
      embed.addFields({ name: `📊 Activity (${allTracked.length} players)`, value: parts.join('  ·  ') });
    }

    // ── Dynamic Difficulty Schedule ──
    const schedField = _buildScheduleField(this._config);
    if (schedField) {
      embed.addFields(schedField);
    }

    // ── Server Statistics ──
    const peaks = this._playtime.getPeaks();
    const trackingSince = new Date(this._playtime.getTrackingSince()).toLocaleDateString('en-GB', { timeZone: this._config.botTimezone });
    const peakDate = peaks.allTimePeakDate
      ? ` (${new Date(peaks.allTimePeakDate).toLocaleDateString('en-GB', { timeZone: this._config.botTimezone })})`
      : '';

    embed.addFields(
      { name: "📈 Today's Peak", value: `${peaks.todayPeak} online · ${peaks.uniqueToday} unique`, inline: true },
      { name: '🏆 Peak Online', value: `${peaks.allTimePeak}${peakDate}`, inline: true },
    );

    embed.setFooter({ text: `Tracking since ${trackingSince} · Last updated` });

    return embed;
  }

  /**
   * Build an offline-state embed showing connection details + cached data.
   * Shown when RCON cannot reach the server.
   */
  async _buildOfflineEmbed() {
    const serverTag = this._config.serverName ? ` — ${this._config.serverName}` : '';
    const embed = new EmbedBuilder()
      .setTitle(`HumanitZ Server Status${serverTag}`)
      .setColor(0xe74c3c) // red
      .setTimestamp()
      .setFooter({ text: 'Last updated' });

    // Connection info
    const host = this._config.publicHost || this._config.rconHost || 'unknown';
    const port = this._config.gamePort || null;
    const connectStr = port ? `\`${host}:${port}\`` : `\`${host}\``;

    // Offline duration
    let downtime = '';
    if (this._offlineSince) {
      const ms = Date.now() - this._offlineSince.getTime();
      const mins = Math.floor(ms / 60000);
      if (mins < 60) {
        downtime = ` (${mins}m)`;
      } else {
        const hrs = Math.floor(mins / 60);
        const rem = mins % 60;
        downtime = ` (${hrs}h ${rem}m)`;
      }
    }

    // Server name from cached info
    const serverName = this._lastInfo?.name || '';
    const desc = serverName
      ? `**${serverName}**\n\n🔴 **Server Offline**${downtime}`
      : `🔴 **Server Offline**${downtime}`;
    embed.setDescription(desc);

    embed.addFields(
      { name: '🔗 Direct Connect', value: connectStr, inline: true },
    );

    // Show last known server info if we have it
    if (this._lastInfo) {
      const lastInfo = this._lastInfo;
      if (lastInfo.version) {
        embed.addFields({ name: '📋 Version', value: lastInfo.version, inline: true });
      }
    }

    // Host Resources (from panel API or SSH — still works when game is offline)
    if (this._config.showHostResources && this._serverResources.backend) {
      try {
        const resources = await this._serverResources.getResources();
        if (resources) embed.addFields(_buildResourceField(resources));
      } catch (_) {}
    }

    // Cached server settings still available (loaded from file, not RCON)
    const settings = (this._config.showServerSettings || this._config.showLootScarcity)
      ? this._loadServerSettings() : {};

    if (this._config.showServerSettings && Object.keys(settings).length > 0) {
      const settingsFields = _buildSettingsFields(settings, this._config);
      if (settingsFields.length > 0) {
        embed.addFields(...settingsFields);
      }
    }

    // Loot Scarcity + Weather Odds (side by side)
    {
      const lootLine = this._config.showLootScarcity && Object.keys(settings).length > 0
        ? _buildLootScarcity(settings) : null;
      const weatherLine = this._config.showWeatherOdds && Object.keys(settings).length > 0
        ? _buildWeatherOdds(settings) : null;
      if (lootLine && weatherLine) {
        embed.addFields(
          { name: '📦 Loot Scarcity', value: lootLine, inline: true },
          { name: '🌤️ Weather Odds', value: weatherLine, inline: true },
        );
      } else if (lootLine) {
        embed.addFields({ name: '📦 Loot Scarcity', value: lootLine });
      } else if (weatherLine) {
        embed.addFields({ name: '🌤️ Weather Odds', value: weatherLine });
      }
    }

    // Playtime leaderboard (persisted locally, survives outage)
    const leaderboard = this._playtime.getLeaderboard();
    if (leaderboard.length > 0) {
      const medals = ['🥇', '🥈', '🥉'];
      const top3 = leaderboard.slice(0, 3).map((entry, i) => {
        return `${medals[i]} **${entry.name}** — ${entry.totalFormatted}`;
      });
      embed.addFields({ name: '⏱️ Top Playtime', value: top3.join('\n') });
    }

    // Activity stats (persisted locally)
    const allTracked = this._playerStats.getAllPlayers();
    if (allTracked.length > 0) {
      const totalDeaths = allTracked.reduce((s, p) => s + p.deaths, 0);
      const totalBuilds = allTracked.reduce((s, p) => s + p.builds, 0);
      const totalLoots = allTracked.reduce((s, p) => s + p.containersLooted, 0);
      const parts = [
        `💀 Deaths: **${totalDeaths}**`,
        `🔨 Builds: **${totalBuilds}**`,
        `📦 Looted: **${totalLoots}**`,
      ];
      if (this._config.showRaidStats) {
        const totalRaids = allTracked.reduce((s, p) => s + p.raidsOut, 0);
        parts.push(`⚔️ Raids: **${totalRaids}**`);
      }
      embed.addFields({ name: `📊 Activity (${allTracked.length} players)`, value: parts.join('  ·  ') });
    }

    // Peak stats (persisted locally)
    const peaks = this._playtime.getPeaks();
    const trackingSince = new Date(this._playtime.getTrackingSince()).toLocaleDateString('en-GB', { timeZone: this._config.botTimezone });

    embed.addFields(
      { name: "📈 Today's Peak", value: `${peaks.todayPeak} online · ${peaks.uniqueToday} unique`, inline: true },
      { name: '🏆 Peak Online', value: `${peaks.allTimePeak}`, inline: true },
    );

    embed.setFooter({ text: `Tracking since ${trackingSince} · Last updated` });

    return embed;
  }
}

module.exports = ServerStatus;

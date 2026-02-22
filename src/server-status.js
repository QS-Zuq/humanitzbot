const { EmbedBuilder } = require('discord.js');
const fs = require('fs');
const path = require('path');
const _defaultConfig = require('./config');
const { getServerInfo, getPlayerList } = require('./server-info');
const _defaultPlaytime = require('./playtime-tracker');
const _defaultPlayerStats = require('./player-stats');
const _defaultServerResources = require('./server-resources');
const { formatBytes } = require('./server-resources');

const _DEFAULT_DATA_DIR = path.join(__dirname, '..', 'data');

function _formatTime(timeStr) {
  if (!timeStr) return null;
  const match = timeStr.match(/^(\d{1,2}):(\d{1,2})$/);
  if (match) {
    return `${match[1]}:${match[2].padStart(2, '0')}`;
  }
  return timeStr;
}

/** Map in-game weather string to an emoji */
function _weatherEmoji(weather) {
  if (!weather) return '';
  const w = weather.toLowerCase();
  if (w.includes('thunder'))    return '⛈️ ';
  if (w.includes('blizzard'))   return '🌪️ ';
  if (w.includes('heavy') && w.includes('snow')) return '❄️ ';
  if (w.includes('snow'))       return '🌨️ ';
  if (w.includes('heavy') && w.includes('rain')) return '🌧️ ';
  if (w.includes('rain'))       return '🌦️ ';
  if (w.includes('fog'))        return '🌫️ ';
  if (w.includes('cloud') || w.includes('overcast')) return '☁️ ';
  if (w.includes('sun') || w.includes('clear')) return '☀️ ';
  return '🌤️ ';
}

/** Map in-game season string to an emoji */
function _seasonEmoji(season) {
  if (!season) return '';
  const s = season.toLowerCase();
  if (s.includes('summer')) return '☀️ ';
  if (s.includes('autumn') || s.includes('fall')) return '🍂 ';
  if (s.includes('winter')) return '❄️ ';
  if (s.includes('spring')) return '🌱 ';
  return '';
}

/** Map game time (HH:MM) to a time-of-day emoji */
function _timeEmoji(timeStr) {
  if (!timeStr) return '';
  const match = timeStr.match(/^(\d{1,2})/);
  if (!match) return '';
  const hour = parseInt(match[1], 10);
  if (hour >= 6 && hour < 8)   return '🌅 ';  // dawn
  if (hour >= 8 && hour < 17)  return '☀️ ';  // day
  if (hour >= 17 && hour < 19) return '🌇 ';  // dusk
  return '🌙 ';                                // night
}

class ServerStatus {
  constructor(client, deps = {}) {
    this._config = deps.config || _defaultConfig;
    this._playtime = deps.playtime || _defaultPlaytime;
    this._playerStats = deps.playerStats || _defaultPlayerStats;
    this._serverResources = deps.serverResources || _defaultServerResources;
    this._getServerInfo = deps.getServerInfo || require('./server-info').getServerInfo;
    this._getPlayerList = deps.getPlayerList || require('./server-info').getPlayerList;
    this._sendAdminMessage = deps.sendAdminMessage || require('./server-info').sendAdminMessage;
    this._label = deps.label || 'STATUS';
    this._dataDir = deps.dataDir || _DEFAULT_DATA_DIR;

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
    if (savedId) {
      // Have a saved ID — delete only that specific message
      try {
        const msg = await this.channel.messages.fetch(savedId);
        if (msg && msg.author.id === this.client.user.id) {
          await msg.delete();
          console.log(`[${this._label}] Cleaned previous message ${savedId}`);
          return; // success — no need for bulk sweep
        }
      } catch (err) {
        if (err.code !== 10008) {
          console.log(`[${this._label}] Could not clean saved message:`, err.message);
          return;
        }
        // 10008 = message gone — fall through to bulk sweep
        console.log(`[${this._label}] Saved message ${savedId} already gone, sweeping channel...`);
      }
    }
    // No saved ID, or saved message was already deleted — sweep old bot messages
    // Only delete messages older than this process start to avoid wiping
    // sibling multi-server embeds posted earlier in this same startup.
    const bootTime = Date.now() - process.uptime() * 1000;
    try {
      const messages = await this.channel.messages.fetch({ limit: 20 });
      const botMessages = messages.filter(m => m.author.id === this.client.user.id && m.createdTimestamp < bootTime);
      if (botMessages.size > 0) {
        console.log(`[${this._label}] Cleaning ${botMessages.size} old bot message(s)`);
        for (const [, msg] of botMessages) {
          try { await msg.delete(); } catch (_) {}
        }
      }
    } catch (err) {
      console.log(`[${this._label}] Could not clean old messages:`, err.message);
    }
  }

  _loadMessageId() {
    try {
      const fp = path.join(this._dataDir, 'message-ids.json');
      if (fs.existsSync(fp)) {
        const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
        return data.serverStatus || null;
      }
    } catch {} return null;
  }

  _saveMessageId() {
    if (!this.statusMessage) return;
    try {
      const fp = path.join(this._dataDir, 'message-ids.json');
      let data = {};
      try { if (fs.existsSync(fp)) data = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch {}
      data.serverStatus = this.statusMessage.id;
      fs.writeFileSync(fp, JSON.stringify(data, null, 2));
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
        const contentKey = JSON.stringify(embed.data);
        if (contentKey === this._lastEmbedKey) return;
        this._lastEmbedKey = contentKey;

        try {
          await this.statusMessage.edit({ embeds: [embed] });
        } catch (editErr) {
          // Message was deleted — re-create it
          if (editErr.code === 10008 || editErr.message?.includes('Unknown Message')) {
            console.log(`[${this._label}] Status message was deleted, re-creating...`);
            try {
              this.statusMessage = await this.channel.send({ embeds: [embed] });
              this._saveMessageId();
            } catch (createErr) {
              console.error(`[${this._label}] Failed to re-create message:`, createErr.message);
            }
          } else {
            throw editErr;
          }
        }
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
          const contentKey = JSON.stringify(embed.data);
          if (contentKey !== this._lastEmbedKey) {
            this._lastEmbedKey = contentKey;
            try {
              await this.statusMessage.edit({ embeds: [embed] });
            } catch (editErr) {
              if (editErr.code === 10008 || editErr.message?.includes('Unknown Message')) {
                try {
                  this.statusMessage = await this.channel.send({ embeds: [embed] });
                } catch (_) { /* ignore */ }
              }
            }
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
    const STATE_FILE = path.join(this._dataDir, 'server-status-cache.json');
    try {
      if (fs.existsSync(STATE_FILE)) {
        const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        if (data.onlineSince) this._onlineSince = new Date(data.onlineSince);
        if (data.offlineSince) this._offlineSince = new Date(data.offlineSince);
        if (data.lastOnline !== undefined) this._lastOnline = data.lastOnline;
        if (data.lastInfo) this._lastInfo = data.lastInfo;
        if (data.lastPlayerList) this._lastPlayerList = data.lastPlayerList;
        console.log(`[${this._label}] Loaded cached state (online since: ${data.onlineSince || 'unknown'})`);
      }
    } catch (err) {
      console.log(`[${this._label}] Could not load cached state:`, err.message);
    }
  }

  /**
   * Persist current state to disk so it survives bot restarts.
   */
  _saveState() {
    const STATE_FILE = path.join(this._dataDir, 'server-status-cache.json');
    try {
      const data = {
        onlineSince: this._onlineSince?.toISOString() || null,
        offlineSince: this._offlineSince?.toISOString() || null,
        lastOnline: this._lastOnline,
        lastInfo: this._lastInfo,
        lastPlayerList: this._lastPlayerList,
        savedAt: new Date().toISOString(),
      };
      fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2));
    } catch (err) {
      console.error(`[${this._label}] Could not save state:`, err.message);
    }
  }

  _loadServerSettings() {
    try {
      const settingsFile = path.join(this._dataDir, 'server-settings.json');
      if (fs.existsSync(settingsFile)) {
        return JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
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
    const host = this._config.rconHost || 'unknown';
    const port = this._config.gamePort || null;
    const connectStr = port ? `${host}:${port}` : host;
    const descParts = [];
    if (info.name) descParts.push(`**${info.name}**`);

    let uptimeStr = '';
    // Prefer panel API container uptime (actual server process) over bot tracking
    if (resources?.uptime != null) {
      const { formatUptime: fmtUp } = require('./server-resources');
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
    const season = info.season || '--';
    const weather = info.weather || '--';

    // Load settings early so we can use DaysPerSeason for season progress
    const settings = (this._config.showServerSettings || this._config.showLootScarcity || this._config.showSeasonProgress)
      ? this._loadServerSettings() : {};

    embed.addFields(
      { name: '👥 Players Online', value: `${playerCount}${playerBar}`, inline: true },
      { name: `${_timeEmoji(time)}Time`, value: time, inline: true },
    );

    // Day number (from RCON info)
    if (this._config.showServerDay && info.day) {
      embed.addFields({ name: '📅 Day', value: info.day, inline: true });
    }

    // Season progress: compute day within current season
    let seasonDisplay = `${_seasonEmoji(season)}${season}`;
    if (this._config.showSeasonProgress && info.day && settings.DaysPerSeason) {
      const day = parseInt(info.day, 10);
      const dps = parseInt(settings.DaysPerSeason, 10);
      if (day > 0 && dps > 0) {
        const dayInSeason = ((day - 1) % dps) + 1;
        seasonDisplay = `${_seasonEmoji(season)}${season} (Day ${dayInSeason}/${dps})`;
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
    const host = this._config.rconHost || 'unknown';
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

// ── Visual helpers ──────────────────────────────────────────

/** Unicode progress bar (thin style). filled/total in 0-1 range. */
function _progressBar(ratio, width = 10) {
  const r = Math.max(0, Math.min(1, ratio));
  const filled = Math.round(r * width);
  return '▓'.repeat(filled) + '░'.repeat(width - filled);
}

// ── Server Settings helpers ─────────────────────────────────

const DIFFICULTY_LABELS = ['Very Easy', 'Easy', 'Default', 'Hard', 'Very Hard', 'Nightmare'];
const SCARCITY_LABELS = ['Scarce', 'Low', 'Default', 'Plentiful', 'Abundant'];
const ON_DEATH_LABELS = ['Backpack + Weapon', 'Pockets + Backpack', 'Everything'];
const VITAL_DRAIN_LABELS = ['Slow', 'Normal', 'Fast'];
const SPAWN_LABELS = ['Low', 'Medium', 'High'];

function _spawnLabel(val) {
  if (val === undefined || val === null) return null;
  const num = parseFloat(val);
  if (isNaN(num)) return val;
  // Standard values: 0=Low, 1=Medium, 2=High; custom multipliers shown as "x0.5" etc.
  if (num === 0) return 'Low';
  if (num === 1) return 'Medium';
  if (num === 2) return 'High';
  return `x${num}`;
}

/** Compact difficulty bar: index 0-5 → "▓░░░░ V.Easy" */
function _difficultyBar(val) {
  if (val === undefined || val === null) return null;
  const idx = Math.round(parseFloat(val));
  if (isNaN(idx)) return val;
  const label = DIFFICULTY_LABELS[idx] || val;
  const bar = _progressBar((idx + 1) / DIFFICULTY_LABELS.length, 5);
  return `${bar} ${label}`;
}

/** Plain difficulty label without bar: index 0-5 → "Default" */
function _difficultyLabel(val) {
  if (val === undefined || val === null) return null;
  const idx = Math.round(parseFloat(val));
  if (isNaN(idx)) return val;
  return DIFFICULTY_LABELS[idx] || val;
}

function _settingBool(val) {
  if (val === undefined || val === null) return null;
  return val === '1' || val.toLowerCase() === 'true' ? 'On' : 'Off';
}

function _settingLabel(val, labels) {
  if (val === undefined || val === null) return null;
  const num = parseFloat(val);
  if (isNaN(num)) return val;
  const idx = Math.round(num);
  return labels[idx] || val;
}

/**
 * Build an embed field for host resource metrics (CPU, RAM, disk).
 * Uptime is shown in the status header when available, so omitted here to avoid duplication.
 * Returns an array of embed field objects (typically one field).
 */
function _buildResourceField(res) {
  const parts = [];
  if (res.cpu != null) parts.push(`🖥️ CPU: **${res.cpu}%**`);
  if (res.memUsed != null && res.memTotal != null) {
    parts.push(`🧠 RAM: **${formatBytes(res.memUsed)}** / ${formatBytes(res.memTotal)} (${res.memPercent ?? '?'}%)`);
  } else if (res.memPercent != null) {
    parts.push(`🧠 RAM: **${res.memPercent}%**`);
  }
  if (res.diskUsed != null && res.diskTotal != null) {
    parts.push(`💾 Disk: **${formatBytes(res.diskUsed)}** / ${formatBytes(res.diskTotal)} (${res.diskPercent ?? '?'}%)`);
  } else if (res.diskPercent != null) {
    parts.push(`💾 Disk: **${res.diskPercent}%**`);
  }
  if (parts.length === 0) return [];
  return [{ name: '📡 Host Resources', value: parts.join('\n'), inline: false }];
}

/**
 * Build server settings as an array of inline embed fields, one per section.
 * Each section becomes its own column in the Discord embed grid (3 per row).
 */
function _buildSettingsFields(s, cfg = _defaultConfig) {
  const fields = [];

  function section(emoji, title, entries) {
    const rows = entries.filter(([, val]) => val != null).map(([label, val]) => `**${label}:** ${val}`);
    if (rows.length > 0) {
      fields.push({ name: `${emoji} ${title}`, value: rows.join('\n'), inline: true });
    }
  }

  // ── General ──
  if (cfg.showSettingsGeneral) {
    section('⚔️', 'General', [
      ['PvP',           _settingBool(s.PVP)],
      ['Max Players',   s.MaxPlayers],
      ['On Death',      _settingLabel(s.OnDeath, ON_DEATH_LABELS)],
      ['Perma Death',   _settingLabel(s.PermaDeath, ['Off', 'Individual', 'All'])],
      ['Vital Drain',   _settingLabel(s.VitalDrain, VITAL_DRAIN_LABELS)],
      ['XP Multiplier', s.XpMultiplier != null ? `${s.XpMultiplier}x` : null],
    ]);
  }

  // ── Time & Seasons ──
  if (cfg.showSettingsTime) {
    section('🕐', 'Time & Seasons', [
      ['Day Length',    s.DayDur != null ? `${s.DayDur} min` : null],
      ['Night Length',  s.NightDur != null ? `${s.NightDur} min` : null],
      ['Season Length', s.DaysPerSeason != null ? `${s.DaysPerSeason} days` : null],
      ['Start Season',  _settingLabel(s.StartingSeason, ['Summer', 'Autumn', 'Winter', 'Spring'])],
    ]);
  }

  // ── Zombies ──
  if (cfg.showSettingsZombies) {
    section('🧟', 'Zombies', [
      ['Health',   _difficultyLabel(s.ZombieDiffHealth)],
      ['Speed',    _difficultyLabel(s.ZombieDiffSpeed)],
      ['Damage',   _difficultyLabel(s.ZombieDiffDamage)],
      ['Spawns',   _spawnLabel(s.ZombieAmountMulti)],
      ['Respawn',  s.ZombieRespawnTimer != null ? `${s.ZombieRespawnTimer} min` : null],
      ['Dogs',     _spawnLabel(s.ZombieDogMulti)],
    ]);
  }

  // ── Items ──
  if (cfg.showSettingsItems) {
    const itemEntries = [
      ['Weapon Break', _settingBool(s.WeaponBreak)],
      ['Food Decay',   _settingBool(s.FoodDecay)],
      ['Loot Respawn', s.LootRespawnTimer != null ? `${s.LootRespawnTimer} min` : null],
      ['Air Drops',    _settingBool(s.AirDrop)],
    ];
    if (s.AirDrop === '1' || s.AirDrop === 'true') {
      itemEntries.push(['  Interval', s.AirDropInterval != null ? `Every ${s.AirDropInterval} day${s.AirDropInterval === '1' ? '' : 's'}` : null]);
    }
    section('🎒', 'Items', itemEntries);
  }

  // ── Extended settings (toggled) ──
  if (cfg.showExtendedSettings) {
    // Bandits
    if (cfg.showSettingsBandits) {
      section('🔫', 'Bandits', [
        ['Health',  _difficultyLabel(s.HumanHealth)],
        ['Speed',   _difficultyLabel(s.HumanSpeed)],
        ['Damage',  _difficultyLabel(s.HumanDamage)],
        ['Spawns',  _spawnLabel(s.HumanAmountMulti)],
        ['Respawn', s.HumanRespawnTimer != null ? `${s.HumanRespawnTimer} min` : null],
        ['AI Events', _settingLabel(s.AIEvent, ['Off', 'Low', 'Default'])],
      ]);
    }

    // Companions
    if (cfg.showSettingsCompanions) {
      section('🐕', 'Companions', [
        ['Dog Companion', _settingBool(s.DogEnabled)],
        ['Companion HP',  _settingLabel(s.CompanionHealth, ['Low', 'Default', 'High'])],
        ['Companion Dmg', _settingLabel(s.CompanionDmg, ['Low', 'Default', 'High'])],
      ]);
    }

    // Building & Territory
    if (cfg.showSettingsBuilding) {
      section('🏗️', 'Building', [
        ['Building HP',     _settingLabel(s.BuildingHealth, VITAL_DRAIN_LABELS)],
        ['Building Decay',  _settingBool(s.BuildingDecay)],
        ['Gen Fuel Rate',   s.GenFuel != null ? `${s.GenFuel}x` : null],
        ['Territory',       _settingBool(s.Territory)],
        ['Dismantle Own',   _settingBool(s.AllowDismantle)],
        ['Dismantle House', _settingBool(s.AllowHouseDismantle)],
      ]);
    }

    // Vehicles
    if (cfg.showSettingsVehicles) {
      section('🚗', 'Vehicles', [
        ['Max Cars', s.MaxOwnedCars != null ? (s.MaxOwnedCars === '0' ? 'Disabled' : s.MaxOwnedCars) : null],
      ]);
    }

    // Animals
    if (cfg.showSettingsAnimals) {
      section('🦌', 'Animals', [
        ['Animal Spawns',  _spawnLabel(s.AnimalMulti)],
        ['Animal Respawn', s.AnimalRespawnTimer != null ? `${s.AnimalRespawnTimer} min` : null],
      ]);
    }
  }

  return fields;
}

function _buildLootScarcity(s) {
  const map = [
    ['🍖', 'Food',      s.RarityFood],
    ['🥤', 'Drink',     s.RarityDrink],
    ['🔪', 'Melee',     s.RarityMelee],
    ['🔫', 'Ranged',    s.RarityRanged],
    ['🛡️', 'Armor',     s.RarityArmor],
    ['🧱', 'Resources', s.RarityResources],
    ['🎯', 'Ammo',      s.RarityAmmo],
    ['📦', 'Other',     s.RarityOther],
  ];

  // Scarcity index: 0=Scarce → 4=Abundant (5 levels)
  const rows = map
    .filter(([, , val]) => val != null)
    .map(([emoji, label, val]) => {
      const idx = Math.round(parseFloat(val)) || 0;
      const name = SCARCITY_LABELS[idx] || val;
      return `${emoji} **${label}:** ${name}`;
    });

  return rows.length > 0 ? rows.join('\n') : null;
}

/** Build weather odds section (toggled) */
function _buildWeatherOdds(s) {
  const weatherKeys = [
    ['☀️', 'Clear Sky',    s.Weather_ClearSky],
    ['☁️', 'Cloudy',       s.Weather_Cloudy],
    ['🌫️', 'Foggy',        s.Weather_Foggy],
    ['🌦️', 'Light Rain',   s.Weather_LightRain],
    ['🌧️', 'Rain',         s.Weather_Rain],
    ['⛈️', 'Thunderstorm', s.Weather_Thunderstorm],
    ['🌨️', 'Light Snow',   s.Weather_LightSnow],
    ['❄️', 'Snow',         s.Weather_Snow],
    ['🌪️', 'Blizzard',     s.Weather_Blizzard],
  ];

  const rows = weatherKeys
    .filter(([, , val]) => val != null)
    .map(([emoji, label, val]) => {
      const num = parseFloat(val);
      const pct = isNaN(num) ? val : `${Math.round(num * 100)}%`;
      return `${emoji} **${label}:** ${pct}`;
    });

  return rows.length > 0 ? rows.join('\n') : null;
}

module.exports = ServerStatus;

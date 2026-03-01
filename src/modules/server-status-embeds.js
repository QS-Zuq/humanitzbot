/**
 * Server-status embed builders — presentation layer.
 *
 * Builds the Discord embeds for the live server-status channel.
 * All display helpers imported from server-display.js (single source of truth).
 *
 * Mixed into ServerStatus.prototype by server-status.js.
 *
 * Display hierarchy (online embed):
 *   1. Dynamic difficulty schedule   (THE selling point — always first)
 *   2. Server identity + connect     (name, status, uptime, address)
 *   3. World state                   (players, time, day, season, weather)
 *   4. Quick stats & peaks
 *   5. Performance + resources (compact)
 */

'use strict';

const { EmbedBuilder } = require('discord.js');
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

// ─── Shared helpers ──────────────────────────────────────────────

/** Build tracking footer text. */
function _footer(playtimeTracker, cfg) {
  const since = new Date(playtimeTracker.getTrackingSince())
    .toLocaleDateString('en-GB', { timeZone: cfg.botTimezone });
  return `Tracking since ${since} \xB7 Last updated`;
}

/** Build settings + loot + weather fields from cached settings. */
function _settingsBlock(settings, cfg) {
  const fields = [];
  if (cfg.showServerSettings && Object.keys(settings).length > 0) {
    const sf = _buildSettingsFields(settings, cfg);
    if (sf.length > 0) fields.push(...sf);
  }

  const lootLine = cfg.showLootScarcity && Object.keys(settings).length > 0
    ? _buildLootScarcity(settings) : null;
  const weatherLine = cfg.showWeatherOdds && Object.keys(settings).length > 0
    ? _buildWeatherOdds(settings) : null;

  if (lootLine && weatherLine) {
    fields.push(
      { name: '\uD83D\uDCE6 Loot Scarcity', value: lootLine, inline: true },
      { name: '\uD83C\uDF24\uFE0F Weather Odds', value: weatherLine, inline: true },
    );
  } else if (lootLine) {
    fields.push({ name: '\uD83D\uDCE6 Loot Scarcity', value: lootLine });
  } else if (weatherLine) {
    fields.push({ name: '\uD83C\uDF24\uFE0F Weather Odds', value: weatherLine });
  }

  return fields;
}

/** Build aggregate activity + playtime stats fields. */
function _statsBlock(playtimeTracker, playerStats, cfg) {
  const fields = [];

  // Playtime top 3
  const leaderboard = playtimeTracker.getLeaderboard();
  if (leaderboard.length > 0) {
    const medals = ['\uD83E\uDD47', '\uD83E\uDD48', '\uD83E\uDD49'];
    const top3 = leaderboard.slice(0, 3)
      .map((e, i) => `${medals[i]} **${e.name}** \u2014 ${e.totalFormatted}`);
    fields.push({ name: '\u23F1\uFE0F Top Playtime', value: top3.join('\n'), inline: true });
  }

  // Activity totals
  const all = playerStats.getAllPlayers();
  if (all.length > 0) {
    const parts = [
      `\uD83D\uDC80 **${all.reduce((s, p) => s + p.deaths, 0)}** deaths`,
      `\uD83D\uDD28 **${all.reduce((s, p) => s + p.builds, 0)}** builds`,
      `\uD83D\uDCE6 **${all.reduce((s, p) => s + p.containersLooted, 0)}** looted`,
    ];
    if (cfg.showRaidStats) {
      const r = all.reduce((s, p) => s + p.raidsOut, 0);
      if (r > 0) parts.push(`\u2694\uFE0F **${r}** raids`);
    }
    fields.push({ name: '\uD83D\uDCCA Activity', value: parts.join('  \xB7  '), inline: true });
  }

  // Peaks
  const peaks = playtimeTracker.getPeaks();
  fields.push(
    { name: "\uD83D\uDCC8 Today's Peak", value: `${peaks.todayPeak} online \xB7 ${peaks.uniqueToday} unique`, inline: true },
    { name: '\uD83C\uDFC6 All-Time Peak', value: `${peaks.allTimePeak}${peaks.allTimePeakDate ? ` (${new Date(peaks.allTimePeakDate).toLocaleDateString('en-GB', { timeZone: cfg.botTimezone })})` : ''}`, inline: true },
  );

  return fields;
}


// ═════════════════════════════════════════════════════════════════════
//  _buildEmbed — Online server status
// ═════════════════════════════════════════════════════════════════════

function _buildEmbed(info, playerList, resources) {
  const serverTag = this._config.serverName ? ` \u2014 ${this._config.serverName}` : '';
  const embed = new EmbedBuilder()
    .setTitle(`HumanitZ Server Status${serverTag}`)
    .setColor(0x2ecc71)
    .setTimestamp()
    .setFooter({ text: _footer(this._playtime, this._config) });

  if (!info || !playerList) {
    embed.setDescription('Fetching server data\u2026');
    return embed;
  }

  // ── 1. SCHEDULE — Always first ──
  const schedField = _buildScheduleField(this._config);
  if (schedField) embed.addFields(schedField);

  // ── 2. SERVER IDENTITY ──
  const host = this._config.publicHost || this._config.rconHost || 'unknown';
  const port = this._config.gamePort || null;
  const connectStr = port ? `${host}:${port}` : host;

  const descParts = [];
  if (info.name) descParts.push(`**${info.name}**`);

  let uptimeStr = '';
  if (resources?.uptime != null) {
    const { formatUptime: fmtUp } = require('../server/server-resources');
    const up = fmtUp(resources.uptime);
    if (up) uptimeStr = ` \xB7 Uptime: ${up}`;
  } else if (this._onlineSince) {
    const ms = Date.now() - this._onlineSince.getTime();
    const mins = Math.floor(ms / 60000);
    uptimeStr = mins < 60 ? ` \xB7 Uptime: ${mins}m` : ` \xB7 Uptime: ${Math.floor(mins / 60)}h ${mins % 60}m`;
  }
  descParts.push(`\uD83D\uDFE2 **Online**${uptimeStr}\n\`${connectStr}\``);
  embed.setDescription(descParts.join('\n'));

  // ── 3. WORLD STATE ──
  const settings = this._loadServerSettings();

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
  embed.addFields(
    { name: '\uD83D\uDC65 Players', value: `${playerCount}${playerBar}`, inline: true },
    { name: `${_timeEmoji(time)} Time`, value: time, inline: true },
  );

  const dayValue = info.day || (settings._daysPassed != null ? String(Math.floor(settings._daysPassed)) : null);
  if (this._config.showServerDay && dayValue) {
    embed.addFields({ name: '\uD83D\uDCC5 Day', value: dayValue, inline: true });
  }

  // Season + Weather (single combined field)
  const season = info.season || settings._currentSeason || '--';
  const weather = info.weather || settings._currentWeather || '--';
  let seasonDisplay = `${_seasonEmoji(season)}${season}`;
  if (this._config.showSeasonProgress && settings.DaysPerSeason) {
    const dps = parseInt(settings.DaysPerSeason, 10);
    if (dps > 0 && settings._currentSeasonDay != null) {
      const dayInSeason = Math.floor(settings._currentSeasonDay) + 1;
      seasonDisplay = `${_seasonEmoji(season)}${season} (Day ${dayInSeason}/${dps})`;
    } else if (dps > 0 && dayValue) {
      const day = parseInt(dayValue, 10);
      if (day > 0) seasonDisplay = `${_seasonEmoji(season)}${season} (Day ${((day - 1) % dps) + 1}/${dps})`;
    }
  }
  embed.addFields({ name: '\uD83C\uDF0D Season / Weather', value: `${seasonDisplay} \xB7 ${_weatherEmoji(weather)}${weather}`, inline: true });

  // Online player names
  if (playerList.players?.length > 0) {
    const names = playerList.players.map(p => p.name).join(', ');
    embed.addFields({ name: '\uD83C\uDFAE Online Now', value: names.substring(0, 1024) });
  }

  // ── 4. STATS + PEAKS ──
  embed.addFields(..._statsBlock(this._playtime, this._playerStats, this._config));

  // ── 5. PERFORMANCE + RESOURCES (compact) ──
  if (this._config.showServerPerformance) {
    const perfParts = [];
    if (info.fps) perfParts.push(`FPS: **${info.fps}**`);
    if (info.ai) perfParts.push(`AI: **${info.ai}**`);
    if (perfParts.length > 0) embed.addFields({ name: '\u26A1 Performance', value: perfParts.join('  \xB7  '), inline: true });
  }
  if (this._config.showServerVersion && info.version) {
    embed.addFields({ name: '\uD83D\uDCCB Version', value: info.version, inline: true });
  }
  if (this._config.showHostResources && resources) {
    embed.addFields(..._buildResourceField(resources));
  }

  // Settings + loot + weather
  embed.addFields(..._settingsBlock(settings, this._config));

  // World stats
  if (this._config.showWorldStats) {
    const wp = [];
    if (settings._totalPlayers != null) wp.push(`\uD83D\uDC65 **${settings._totalPlayers}** players`);
    if (settings._totalZombieKills != null) wp.push(`\uD83E\uDDDF **${settings._totalZombieKills.toLocaleString()}** killed`);
    if (settings._totalStructures != null) wp.push(`\uD83C\uDFD7\uFE0F **${settings._totalStructures.toLocaleString()}** structures`);
    if (settings._totalVehicles != null) wp.push(`\uD83D\uDE97 **${settings._totalVehicles}** vehicles`);
    if (settings._totalCompanions != null && settings._totalCompanions > 0) wp.push(`\uD83D\uDC15 **${settings._totalCompanions}** companions`);
    if (wp.length > 0) embed.addFields({ name: '\uD83C\uDF0E World', value: wp.join('  \xB7  ') });
  }

  return embed;
}


// ═════════════════════════════════════════════════════════════════════
//  _buildOfflineEmbed — Offline server status
// ═════════════════════════════════════════════════════════════════════

async function _buildOfflineEmbed() {
  const serverTag = this._config.serverName ? ` \u2014 ${this._config.serverName}` : '';
  const embed = new EmbedBuilder()
    .setTitle(`HumanitZ Server Status${serverTag}`)
    .setColor(0xe74c3c)
    .setTimestamp()
    .setFooter({ text: _footer(this._playtime, this._config) });

  const host = this._config.publicHost || this._config.rconHost || 'unknown';
  const port = this._config.gamePort || null;
  const connectStr = port ? `\`${host}:${port}\`` : `\`${host}\``;

  let downtime = '';
  if (this._offlineSince) {
    const ms = Date.now() - this._offlineSince.getTime();
    const mins = Math.floor(ms / 60000);
    downtime = mins < 60 ? ` (${mins}m)` : ` (${Math.floor(mins / 60)}h ${mins % 60}m)`;
  }

  const serverName = this._lastInfo?.name || '';
  embed.setDescription(serverName
    ? `**${serverName}**\n\n\uD83D\uDD34 **Server Offline**${downtime}`
    : `\uD83D\uDD34 **Server Offline**${downtime}`);

  embed.addFields({ name: '\uD83D\uDD17 Direct Connect', value: connectStr, inline: true });
  if (this._lastInfo?.version) embed.addFields({ name: '\uD83D\uDCCB Version', value: this._lastInfo.version, inline: true });

  // Schedule — still useful when offline (shows what's next)
  const schedField = _buildScheduleField(this._config);
  if (schedField) embed.addFields(schedField);

  // Resources (panel API may work when game is offline)
  if (this._config.showHostResources && this._serverResources.backend) {
    try {
      const resources = await this._serverResources.getResources();
      if (resources) embed.addFields(..._buildResourceField(resources));
    } catch (_) {}
  }

  // Cached settings + loot + weather
  const settings = (this._config.showServerSettings || this._config.showLootScarcity)
    ? this._loadServerSettings() : {};
  embed.addFields(..._settingsBlock(settings, this._config));

  // Stats + peaks (reuse same block as online)
  embed.addFields(..._statsBlock(this._playtime, this._playerStats, this._config));

  return embed;
}

module.exports = { _buildEmbed, _buildOfflineEmbed };

import { EmbedBuilder } from 'discord.js';
import {
  formatTime as _formatTime,
  weatherEmoji as _weatherEmoji,
  seasonEmoji as _seasonEmoji,
  timeEmoji as _timeEmoji,
  progressBar as _progressBar,
  buildScheduleField as _buildScheduleField,
  buildSettingsFields as _buildSettingsFields,
  buildLootScarcity as _buildLootScarcity,
  buildWeatherOdds as _buildWeatherOdds,
  buildResourceField as _buildResourceField,
} from '../server/server-display.js';
import { t, getLocale, fmtDate, fmtNumber } from '../i18n/index.js';
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/restrict-plus-operands, @typescript-eslint/no-unnecessary-template-expression -- Phase 5: type class fields */
// eslint-disable-next-line @typescript-eslint/no-require-imports -- CJS interop: _mod.exports = instance
const { formatUptime: fmtUp } = require('../server/server-resources') as typeof import('../server/server-resources');

function _ts(locale: any, key: any, vars: any = {}) {
  return t(`discord:status.${key}`, locale, vars);
}

function _normalizeLabel(value: any) {
  return String(value || '')
    .trim()
    .toLowerCase();
}

function _seasonLabel(locale: any, season: any) {
  const norm = _normalizeLabel(season);
  const keyMap: Record<string, string> = {
    spring: 'season_spring',
    summer: 'season_summer',
    autumn: 'season_autumn',
    fall: 'season_autumn',
    winter: 'season_winter',
  };
  return keyMap[norm] ? _ts(locale, keyMap[norm]) : season || '--';
}

function _weatherLabel(locale: any, weather: any) {
  const norm = _normalizeLabel(weather);
  const keyMap: Record<string, string> = {
    clear: 'weather_clear',
    'clear skies': 'weather_clear_skies',
    'partly cloudy': 'weather_partly_cloudy',
    cloudy: 'weather_cloudy',
    overcast: 'weather_overcast',
    foggy: 'weather_foggy',
    'light rain': 'weather_light_rain',
    rain: 'weather_rain',
    thunderstorm: 'weather_thunderstorm',
    'light snow': 'weather_light_snow',
    snow: 'weather_snow',
    blizzard: 'weather_blizzard',
    heatwave: 'weather_heatwave',
    sandstorm: 'weather_sandstorm',
  };
  return keyMap[norm] ? _ts(locale, keyMap[norm]) : weather || '--';
}

function _footer(playtimeTracker: any, cfg: any) {
  const locale = getLocale({ serverConfig: cfg });
  const since = fmtDate(playtimeTracker.getTrackingSince(), locale, cfg.botTimezone);
  return _ts(locale, 'tracking_footer', { since });
}

function _settingsBlock(settings: any, cfg: any, locale: any) {
  const fields = [];
  if (cfg.showServerSettings && Object.keys(settings).length > 0) {
    const sf = _buildSettingsFields(settings, cfg);
    if (sf.length > 0) fields.push(...sf);
  }

  const lootLine = cfg.showLootScarcity && Object.keys(settings).length > 0 ? _buildLootScarcity(settings) : null;
  const weatherLine = cfg.showWeatherOdds && Object.keys(settings).length > 0 ? _buildWeatherOdds(settings) : null;

  if (lootLine && weatherLine) {
    fields.push(
      { name: _ts(locale, 'loot_scarcity'), value: lootLine, inline: true },
      { name: _ts(locale, 'weather_odds'), value: weatherLine, inline: true },
    );
  } else if (lootLine) {
    fields.push({ name: _ts(locale, 'loot_scarcity'), value: lootLine });
  } else if (weatherLine) {
    fields.push({ name: _ts(locale, 'weather_odds'), value: weatherLine });
  }

  return fields;
}

function _statsBlock(playtimeTracker: any, playerStats: any, cfg: any, locale: any) {
  const fields = [];

  const leaderboard = playtimeTracker.getLeaderboard();
  if (leaderboard.length > 0) {
    const medals = ['\uD83E\uDD47', '\uD83E\uDD48', '\uD83E\uDD49'];
    const top3 = leaderboard
      .slice(0, 3)
      .map((e: any, i: any) => `${medals[i]} **${e.name}** \u2014 ${e.totalFormatted}`);
    fields.push({ name: _ts(locale, 'top_playtime'), value: top3.join('\n'), inline: true });
  }

  const all = playerStats.getAllPlayers();
  if (all.length > 0) {
    const parts = [
      _ts(locale, 'activity_deaths', {
        count: fmtNumber(
          all.reduce((s: any, p: any) => s + p.deaths, 0),
          locale,
        ),
      }),
      _ts(locale, 'activity_builds', {
        count: fmtNumber(
          all.reduce((s: any, p: any) => s + p.builds, 0),
          locale,
        ),
      }),
      _ts(locale, 'activity_looted', {
        count: fmtNumber(
          all.reduce((s: any, p: any) => s + p.containersLooted, 0),
          locale,
        ),
      }),
    ];
    if (cfg.showRaidStats) {
      const r = all.reduce((s: any, p: any) => s + p.raidsOut, 0);
      if (r > 0) parts.push(_ts(locale, 'activity_raids', { count: fmtNumber(r, locale) }));
    }
    fields.push({ name: _ts(locale, 'activity'), value: parts.join('  \xB7  '), inline: true });
  }

  const peaks = playtimeTracker.getPeaks();
  const allTimePeakDate = peaks.allTimePeakDate ? fmtDate(peaks.allTimePeakDate, locale, cfg.botTimezone) : '';
  fields.push(
    {
      name: _ts(locale, 'todays_peak'),
      value: _ts(locale, 'todays_peak_value', {
        online: fmtNumber(peaks.todayPeak, locale),
        unique: fmtNumber(peaks.uniqueToday, locale),
      }),
      inline: true,
    },
    {
      name: _ts(locale, 'all_time_peak'),
      value: _ts(locale, 'all_time_peak_value', {
        peak: fmtNumber(peaks.allTimePeak, locale),
        date_suffix: allTimePeakDate ? ` (${allTimePeakDate})` : '',
      }),
      inline: true,
    },
  );

  return fields;
}

function _buildEmbed(this: any, info: any, playerList: any, resources: any) {
  const locale = getLocale({ serverConfig: this._config });
  const serverTag = this._config.serverName ? ` \u2014 ${this._config.serverName}` : '';
  const embed = new EmbedBuilder()
    .setTitle(`${_ts(locale, 'title')}${serverTag}`)
    .setColor(0x2ecc71)
    .setTimestamp()
    .setFooter({ text: _footer(this._playtime, this._config) });

  if (!info || !playerList) {
    embed.setDescription(_ts(locale, 'fetching_server_data'));
    return embed;
  }

  const schedField = _buildScheduleField(this._config);
  if (schedField) embed.addFields(schedField);

  const host = this._config.publicHost || this._config.rconHost || _ts(locale, 'unknown');
  const port = this._config.gamePort || null;
  const connectStr = port ? `${host}:${port}` : host;

  const descParts = [];
  if (info.name) descParts.push(`**${info.name}**`);

  let uptimeStr = '';
  if (resources?.uptime != null) {
    const up = fmtUp(resources.uptime);
    if (up) uptimeStr = ` \xB7 ${_ts(locale, 'uptime')}: ${up}`;
  } else if (this._onlineSince) {
    const ms = Date.now() - this._onlineSince.getTime();
    const mins = Math.floor(ms / 60000);
    uptimeStr =
      mins < 60
        ? ` \xB7 ${_ts(locale, 'uptime')}: ${_ts(locale, 'uptime_minutes', { minutes: fmtNumber(mins, locale) })}`
        : ` \xB7 ${_ts(locale, 'uptime')}: ${_ts(locale, 'uptime_hours_minutes', { hours: fmtNumber(Math.floor(mins / 60), locale), minutes: fmtNumber(mins % 60, locale) })}`;
  }
  descParts.push(
    _ts(locale, 'online_status_line', {
      online: _ts(locale, 'online'),
      uptime: uptimeStr,
      connect: connectStr,
    }),
  );
  embed.setDescription(descParts.join('\n'));

  const settings = this._loadServerSettings();

  let playerCount;
  let playerBar = '';
  if (info.players != null) {
    const max = parseInt(info.maxPlayers, 10) || 0;
    const cur = parseInt(info.players, 10) || 0;
    playerCount = max ? `${fmtNumber(cur, locale)} / ${fmtNumber(max, locale)}` : `${fmtNumber(cur, locale)}`;
    if (max > 0) playerBar = `\n${_progressBar(cur / max, 12)}`;
  } else {
    playerCount = `${fmtNumber(playerList.count, locale)}`;
  }

  const time = _formatTime(info.time) || '--';
  embed.addFields(
    { name: _ts(locale, 'players'), value: `${playerCount}${playerBar}`, inline: true },
    { name: _ts(locale, 'time', { emoji: _timeEmoji(time) }), value: time, inline: true },
  );

  const dayValue = info.day || (settings._daysPassed != null ? String(Math.floor(settings._daysPassed)) : null);
  if (this._config.showServerDay && dayValue) {
    embed.addFields({ name: _ts(locale, 'day'), value: fmtNumber(dayValue, locale), inline: true });
  }

  const rawSeason = info.season || settings._currentSeason || '--';
  const season = _seasonLabel(locale, rawSeason);
  const rawWeather = info.weather || settings._currentWeather || '--';
  const weather = _weatherLabel(locale, rawWeather);
  let seasonDisplay = `${_seasonEmoji(rawSeason)}${season}`;
  if (this._config.showSeasonProgress && settings.DaysPerSeason) {
    const dps = parseInt(settings.DaysPerSeason, 10);
    if (dps > 0 && settings._currentSeasonDay != null) {
      const dayInSeason = Math.floor(settings._currentSeasonDay) + 1;
      seasonDisplay = _ts(locale, 'season_with_day', {
        season: `${_seasonEmoji(rawSeason)}${season}`,
        day: fmtNumber(dayInSeason, locale),
        total: fmtNumber(dps, locale),
      });
    } else if (dps > 0 && dayValue) {
      const day = parseInt(dayValue, 10);
      if (day > 0) {
        seasonDisplay = _ts(locale, 'season_with_day', {
          season: `${_seasonEmoji(rawSeason)}${season}`,
          day: fmtNumber(((day - 1) % dps) + 1, locale),
          total: fmtNumber(dps, locale),
        });
      }
    }
  }
  embed.addFields({
    name: _ts(locale, 'season_weather'),
    value: _ts(locale, 'season_weather_value', {
      season: seasonDisplay,
      weather: `${_weatherEmoji(rawWeather)}${weather}`,
    }),
    inline: true,
  });

  if (playerList.players?.length > 0) {
    const names = playerList.players.map((p: any) => p.name).join(', ');
    embed.addFields({ name: _ts(locale, 'online_now'), value: names.substring(0, 1024) });
  }

  embed.addFields(..._statsBlock(this._playtime, this._playerStats, this._config, locale));

  if (this._config.showServerPerformance) {
    const perfParts = [];
    if (info.fps) perfParts.push(_ts(locale, 'performance_fps', { value: fmtNumber(info.fps, locale) }));
    if (info.ai) perfParts.push(_ts(locale, 'performance_ai', { value: fmtNumber(info.ai, locale) }));
    if (perfParts.length > 0)
      embed.addFields({ name: _ts(locale, 'performance'), value: perfParts.join('  \xB7  '), inline: true });
  }
  if (this._config.showServerVersion && info.version) {
    embed.addFields({ name: _ts(locale, 'version'), value: info.version, inline: true });
  }
  if (this._config.showHostResources && resources) {
    embed.addFields(..._buildResourceField(resources));
  }

  embed.addFields(..._settingsBlock(settings, this._config, locale));

  if (this._config.showWorldStats) {
    const wp = [];
    if (settings._totalPlayers != null)
      wp.push(_ts(locale, 'world_players', { count: fmtNumber(settings._totalPlayers, locale) }));
    if (settings._totalZombieKills != null)
      wp.push(_ts(locale, 'world_killed', { count: fmtNumber(settings._totalZombieKills, locale) }));
    if (settings._totalStructures != null)
      wp.push(_ts(locale, 'world_structures', { count: fmtNumber(settings._totalStructures, locale) }));
    if (settings._totalVehicles != null)
      wp.push(_ts(locale, 'world_vehicles', { count: fmtNumber(settings._totalVehicles, locale) }));
    if (settings._totalCompanions != null && settings._totalCompanions > 0) {
      wp.push(_ts(locale, 'world_companions', { count: fmtNumber(settings._totalCompanions, locale) }));
    }
    if (wp.length > 0) embed.addFields({ name: _ts(locale, 'world'), value: wp.join('  \xB7  ') });
  }

  return embed;
}

async function _buildOfflineEmbed(this: any) {
  const locale = getLocale({ serverConfig: this._config });
  const serverTag = this._config.serverName ? ` \u2014 ${this._config.serverName}` : '';
  const embed = new EmbedBuilder()
    .setTitle(`${_ts(locale, 'title')}${serverTag}`)
    .setColor(0xe74c3c)
    .setTimestamp()
    .setFooter({ text: _footer(this._playtime, this._config) });

  const host = this._config.publicHost || this._config.rconHost || _ts(locale, 'unknown');
  const port = this._config.gamePort || null;
  const connectStr = port ? `\`${host}:${port}\`` : `\`${host}\``;

  let downtime = '';
  if (this._offlineSince) {
    const ms = Date.now() - this._offlineSince.getTime();
    const mins = Math.floor(ms / 60000);
    downtime =
      mins < 60
        ? _ts(locale, 'downtime_minutes', { minutes: fmtNumber(mins, locale) })
        : _ts(locale, 'downtime_hours_minutes', {
            hours: fmtNumber(Math.floor(mins / 60), locale),
            minutes: fmtNumber(mins % 60, locale),
          });
  }

  const serverName = this._lastInfo?.name || '';
  embed.setDescription(
    serverName
      ? _ts(locale, 'offline_with_name', { name: serverName, downtime })
      : _ts(locale, 'offline_no_name', { downtime }),
  );

  embed.addFields({ name: _ts(locale, 'direct_connect'), value: connectStr, inline: true });
  if (this._lastInfo?.version)
    embed.addFields({ name: _ts(locale, 'version'), value: this._lastInfo.version, inline: true });

  const schedField = _buildScheduleField(this._config);
  if (schedField) embed.addFields(schedField);

  if (this._config.showHostResources && this._serverResources.backend) {
    try {
      const resources = await this._serverResources.getResources();
      if (resources) embed.addFields(..._buildResourceField(resources));
    } catch (_: any) {}
  }

  const settings = this._config.showServerSettings || this._config.showLootScarcity ? this._loadServerSettings() : {};
  embed.addFields(..._settingsBlock(settings, this._config, locale));
  embed.addFields(..._statsBlock(this._playtime, this._playerStats, this._config, locale));

  return embed;
}

/* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/restrict-plus-operands, @typescript-eslint/no-unnecessary-template-expression */

export { _buildEmbed, _buildOfflineEmbed };

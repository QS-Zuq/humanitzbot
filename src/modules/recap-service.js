/**
 * Recap Service — automated daily and weekly summary embeds.
 *
 * Posts a rich "Daily Recap" at midnight (BOT_TIMEZONE) and a "Weekly Digest"
 * on the configured weekly reset day. Hooks into LogWatcher's day-rollover
 * event to trigger daily recaps, and checks for weekly boundary on each
 * rollover.
 *
 * All data is queried from the SQLite database — no external state needed.
 *
 * Daily Recap includes:
 *   - Unique players, peak concurrent
 *   - Total kills (zombie + PvP) with top killer
 *   - Structures built, fish caught, containers looted
 *   - New players who joined for the first time
 *   - MVP (weighted composite) and Unluckiest (most deaths)
 *
 * Weekly Digest includes:
 *   - Same stats aggregated over the week
 *   - Week-over-week comparisons
 *   - Player of the Week
 */

const { EmbedBuilder } = require('discord.js');
const { t, getLocale, fmtNumber } = require('../i18n');

const STATE_KEY = 'recap_service';

// ── Helpers ──────────────────────────────────────────────────────────────────

function _fmt(n, locale = 'en') {
  if (n == null) return '0';
  return fmtNumber(Number(n), locale);
}

function _tr(locale, key, vars = {}) {
  return t(`discord:recap.${key}`, locale, vars);
}

function _fmtHours(seconds, locale = 'en') {
  if (!seconds || seconds <= 0) {
    return _tr(locale, 'duration_minutes', { minutes: fmtNumber(0, locale) });
  }
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h === 0) return _tr(locale, 'duration_minutes', { minutes: fmtNumber(m, locale) });
  return _tr(locale, 'duration_hours_minutes', {
    hours: fmtNumber(h, locale),
    minutes: fmtNumber(m, locale),
  });
}

function _trend(current, previous) {
  if (!previous || previous === 0) return '';
  const pct = Math.round(((current - previous) / previous) * 100);
  if (pct > 0) return ` ↑ ${pct}%`;
  if (pct < 0) return ` ↓ ${Math.abs(pct)}%`;
  return ' →';
}

function _medal(rank) {
  if (rank === 0) return '🥇';
  if (rank === 1) return '🥈';
  if (rank === 2) return '🥉';
  return `**${rank + 1}.**`;
}

// ── RecapService class ───────────────────────────────────────────────────────

class RecapService {
  /**
   * @param {object} client - Discord.js Client
   * @param {object} opts
   * @param {object} opts.db - HumanitZDB instance
   * @param {object} [opts.logWatcher] - LogWatcher for posting target
   * @param {object} [opts.config] - config object
   * @param {object} [opts.playtime] - PlaytimeTracker for peak stats
   */
  constructor(client, opts = {}) {
    this._client = client;
    this._db = opts.db || null;
    this._logWatcher = opts.logWatcher || null;
    this._config = opts.config || require('../config');
    this._playtime = opts.playtime || null;
    this._label = opts.label || 'RECAP';
  }

  // ── Daily Recap ────────────────────────────────────────────

  /**
   * Post the daily recap for the given date (defaults to yesterday).
   * Called on LogWatcher day-rollover — the "yesterday" date is what just ended.
   * @param {string} [dateStr] - YYYY-MM-DD of the day to recap (default: yesterday)
   */
  async postDailyRecap(dateStr) {
    if (!this._db) return;

    try {
      // Default to yesterday in bot timezone
      const date = dateStr || this._getYesterday();
      const startOfDay = `${date}T00:00:00.000Z`;
      const endOfDay = `${date}T23:59:59.999Z`;

      const stats = this._gatherDayStats(startOfDay, endOfDay);
      if (!stats || stats.totalEvents === 0) {
        console.log(`[${this._label}] No events for ${date} — skipping daily recap`);
        return;
      }

      const dateLabel = this._config.getDateLabel(new Date(`${date}T12:00:00Z`));
      const embed = this._buildDailyEmbed(stats, dateLabel);

      await this._post([embed]);
      console.log(`[${this._label}] Posted daily recap for ${date}`);

      // Save stats for weekly comparison
      this._saveLastDaily(date, stats);
    } catch (err) {
      console.error(`[${this._label}] Daily recap error:`, err.message);
    }
  }

  /**
   * Gather all stats for a single day from the database.
   */
  _gatherDayStats(startOfDay, endOfDay) {
    const events = this._db.getActivitySince(startOfDay);
    // Filter to only this day (getActivitySince returns everything after the timestamp)
    const dayEvents = events.filter(e => e.timestamp <= endOfDay);

    if (dayEvents.length === 0) return null;

    // Count event types
    const counts = {};
    for (const e of dayEvents) {
      counts[e.type] = (counts[e.type] || 0) + 1;
    }

    // Unique players from connect events
    const uniquePlayers = new Set();
    const playerNames = {};
    for (const e of dayEvents) {
      if (e.steam_id) {
        uniquePlayers.add(e.steam_id);
        if (e.player_name) playerNames[e.steam_id] = e.player_name;
      }
    }

    // Per-player kill counts for the day
    const playerKills = {};
    const playerDeaths = {};
    const playerBuilds = {};
    for (const e of dayEvents) {
      const sid = e.steam_id;
      if (!sid) continue;
      if (e.type === 'player_death' || e.type === 'player_death_pvp') {
        playerDeaths[sid] = (playerDeaths[sid] || 0) + 1;
      }
      if (e.type === 'player_build') {
        playerBuilds[sid] = (playerBuilds[sid] || 0) + 1;
      }
    }

    // Get kill deltas from players table — use the day's log events for kill counts
    // Kill events are tracked as individual log lines, count them
    // Total kills: count from DB players table (more reliable)
    const allPlayers = this._db.getAllPlayers();
    let totalKills = 0;
    let topKiller = null;
    let topKillerKills = 0;
    for (const p of allPlayers) {
      if (p.lifetime_kills > 0) totalKills += p.lifetime_kills;
    }

    // Top killer today — use log_kills or lifetime as proxy
    const topKillers = this._db.topKillers(1);
    if (topKillers.length > 0) {
      topKiller = topKillers[0].name;
      topKillerKills = topKillers[0].lifetime_kills;
    }

    // New players (first_seen today)
    const newPlayers = allPlayers.filter(p => {
      const firstSeen = p.playtime_first_seen || p.updated_at;
      return firstSeen && firstSeen >= startOfDay && firstSeen <= endOfDay;
    });

    // MVP — weighted score: kills*2 + builds*1 + loots*0.5 + playtime_hours*3
    // Unluckiest — most deaths
    let mvp = null, mvpScore = 0;
    let unluckiest = null, unluckyDeaths = 0;

    for (const sid of uniquePlayers) {
      const name = playerNames[sid] || sid;
      const kills = playerKills[sid] || 0;
      const builds = playerBuilds[sid] || 0;
      const deaths = playerDeaths[sid] || 0;
      const score = kills * 2 + builds * 1;
      if (score > mvpScore) { mvp = name; mvpScore = score; }
      if (deaths > unluckyDeaths) { unluckiest = name; unluckyDeaths = deaths; }
    }

    // Peak concurrent from playtime tracker
    let peakConcurrent = 0;
    if (this._playtime) {
      const peaks = this._playtime.getPeaks();
      peakConcurrent = peaks.yesterdayPeak || peaks.todayPeak || 0;
    }

    return {
      totalEvents: dayEvents.length,
      uniquePlayers: uniquePlayers.size,
      peakConcurrent,
      connects: counts.player_connect || 0,
      disconnects: counts.player_disconnect || 0,
      deaths: (counts.player_death || 0) + (counts.player_death_pvp || 0),
      pvpKills: counts.player_death_pvp || 0,
      builds: counts.player_build || 0,
      loots: counts.container_loot || 0,
      raidHits: (counts.raid_damage || 0) + (counts.building_destroyed || 0),
      fish: counts.fish_caught || 0,
      totalKills,
      topKiller,
      topKillerKills,
      newPlayers: newPlayers.map(p => p.name),
      mvp,
      mvpScore,
      unluckiest,
      unluckyDeaths,
    };
  }

  /**
   * Build the daily recap embed.
   */
  _buildDailyEmbed(stats, dateLabel) {
    const locale = getLocale({ serverConfig: this._config });
    const lines = [];

    // Header stats
    lines.push(_tr(locale, 'daily_unique_peak_line', {
      unique_players: _fmt(stats.uniquePlayers, locale),
      peak: _fmt(stats.peakConcurrent, locale),
    }));
    lines.push('');

    // Activity breakdown
    if (stats.deaths > 0) {
      const pvpNote = stats.pvpKills > 0
        ? _tr(locale, 'daily_deaths_pvp_note', { pvp_kills: _fmt(stats.pvpKills, locale) })
        : '';
      lines.push(_tr(locale, 'daily_deaths_line', {
        deaths: _fmt(stats.deaths, locale),
        pvp_note: pvpNote,
      }));
    }
    if (stats.builds > 0) lines.push(_tr(locale, 'daily_built_line', { builds: _fmt(stats.builds, locale) }));
    if (stats.loots > 0) lines.push(_tr(locale, 'daily_looted_line', { loots: _fmt(stats.loots, locale) }));
    if (stats.raidHits > 0) lines.push(_tr(locale, 'daily_raid_hits_line', { raid_hits: _fmt(stats.raidHits, locale) }));
    if (stats.fish > 0) lines.push(_tr(locale, 'daily_fish_line', { fish: _fmt(stats.fish, locale) }));

    // Top killer
    if (stats.topKiller) {
      lines.push('');
      lines.push(_tr(locale, 'daily_top_killer_line', {
        top_killer: stats.topKiller,
        top_killer_kills: _fmt(stats.topKillerKills, locale),
      }));
    }

    // New players
    if (stats.newPlayers.length > 0) {
      lines.push('');
      const names = stats.newPlayers.slice(0, 5).join(', ');
      const extra = stats.newPlayers.length > 5
        ? _tr(locale, 'daily_new_survivors_extra', {
          count: _fmt(stats.newPlayers.length - 5, locale),
        })
        : '';
      lines.push(_tr(locale, 'daily_new_survivors_line', {
        names,
        extra,
      }));
    }

    // MVP and Unluckiest
    if (stats.mvp || stats.unluckiest) {
      lines.push('');
      if (stats.mvp) lines.push(_tr(locale, 'daily_mvp_line', { mvp: stats.mvp }));
      if (stats.unluckiest && stats.unluckyDeaths > 1) {
        lines.push(_tr(locale, 'daily_unluckiest_line', {
          unluckiest: stats.unluckiest,
          deaths: _fmt(stats.unluckyDeaths, locale),
        }));
      }
    }

    return new EmbedBuilder()
      .setTitle(_tr(locale, 'daily_recap_title', { date_label: dateLabel }))
      .setDescription(lines.join('\n'))
      .setColor(0x5865f2)
      .setFooter({ text: _tr(locale, 'total_events_footer', { count: _fmt(stats.totalEvents, locale) }) })
      .setTimestamp();
  }

  // ── Weekly Digest ──────────────────────────────────────────

  /**
   * Post the weekly digest. Called on day-rollover when today is the weekly reset day.
   */
  async postWeeklyDigest() {
    if (!this._db) return;

    try {
      const locale = getLocale({ serverConfig: this._config });
      // Get the last 7 days of data
      const today = this._config.getToday();
      const weekAgo = new Date(`${today}T00:00:00.000Z`);
      weekAgo.setDate(weekAgo.getDate() - 7);
      const startOfWeek = weekAgo.toISOString();

      const events = this._db.getActivitySince(startOfWeek);
      if (events.length === 0) {
        console.log(`[${this._label}] No events this week — skipping weekly digest`);
        return;
      }

      // Count event types
      const counts = {};
      const uniquePlayers = new Set();
      const playerDeaths = {};
      const playerNames = {};
      for (const e of events) {
        counts[e.type] = (counts[e.type] || 0) + 1;
        if (e.steam_id) {
          uniquePlayers.add(e.steam_id);
          if (e.player_name) playerNames[e.steam_id] = e.player_name;
          if (e.type === 'player_death' || e.type === 'player_death_pvp') {
            playerDeaths[e.steam_id] = (playerDeaths[e.steam_id] || 0) + 1;
          }
        }
      }

      // Previous week comparison
      const prevState = this._loadState();
      const prevWeek = prevState?.lastWeekly || null;

      const totalDeaths = (counts.player_death || 0) + (counts.player_death_pvp || 0);
      const totalBuilds = counts.player_build || 0;
      const totalLoots = counts.container_loot || 0;
      const pvpKills = counts.player_death_pvp || 0;

      // Player of the Week — from DB aggregates
      const topKillers = this._db.topKillers(1);
      const topPlaytime = this._db.topPlaytime(1);

      // Unluckiest of the week
      let unluckiest = null, unluckyDeaths = 0;
      for (const [sid, deaths] of Object.entries(playerDeaths)) {
        if (deaths > unluckyDeaths) {
          unluckiest = playerNames[sid] || sid;
          unluckyDeaths = deaths;
        }
      }

      const lines = [];
      lines.push(_tr(locale, 'weekly_unique_players_line', {
        unique_players: _fmt(uniquePlayers.size, locale),
        trend: _trend(uniquePlayers.size, prevWeek?.uniquePlayers),
      }));
      lines.push('');

      // Stats with trends
      lines.push(_tr(locale, 'weekly_deaths_line', {
        deaths: _fmt(totalDeaths, locale),
        trend: _trend(totalDeaths, prevWeek?.deaths),
      }));
      if (pvpKills > 0) {
        lines.push(_tr(locale, 'weekly_pvp_kills_line', {
          pvp_kills: _fmt(pvpKills, locale),
          trend: _trend(pvpKills, prevWeek?.pvpKills),
        }));
      }
      lines.push(_tr(locale, 'weekly_built_line', {
        builds: _fmt(totalBuilds, locale),
        trend: _trend(totalBuilds, prevWeek?.builds),
      }));
      lines.push(_tr(locale, 'weekly_looted_line', {
        loots: _fmt(totalLoots, locale),
        trend: _trend(totalLoots, prevWeek?.loots),
      }));
      lines.push('');

      // Player of the Week
      if (topKillers.length > 0) {
        lines.push(_tr(locale, 'weekly_top_killer_line', {
          top_killer: topKillers[0].name,
          top_killer_kills: _fmt(topKillers[0].lifetime_kills, locale),
        }));
      }
      if (topPlaytime.length > 0 && topPlaytime[0].playtime_seconds > 0) {
        lines.push(_tr(locale, 'weekly_most_active_line', {
          most_active: topPlaytime[0].name,
          most_active_hours: _fmtHours(topPlaytime[0].playtime_seconds, locale),
        }));
      }
      if (unluckiest && unluckyDeaths > 2) {
        lines.push(_tr(locale, 'weekly_unluckiest_line', {
          unluckiest,
          unlucky_deaths: _fmt(unluckyDeaths, locale),
        }));
      }

      lines.push('');
      lines.push(_tr(locale, 'weekly_total_events_line', {
        total_events: _fmt(events.length, locale),
        trend: _trend(events.length, prevWeek?.totalEvents),
      }));

      const embed = new EmbedBuilder()
        .setTitle(_tr(locale, 'weekly_digest_title'))
        .setDescription(lines.join('\n'))
        .setColor(0xf59e0b)
        .setFooter({
          text: _tr(locale, 'week_ending_footer', {
            date_label: this._config.getDateLabel(),
          }),
        })
        .setTimestamp();

      await this._post([embed]);
      console.log(`[${this._label}] Posted weekly digest`);

      // Save this week's stats for next week comparison
      this._saveWeeklyStats({
        uniquePlayers: uniquePlayers.size,
        deaths: totalDeaths,
        pvpKills,
        builds: totalBuilds,
        loots: totalLoots,
        totalEvents: events.length,
      });
    } catch (err) {
      console.error(`[${this._label}] Weekly digest error:`, err.message);
    }
  }

  /**
   * Called on each day rollover. Posts daily recap, and weekly digest if it's reset day.
   * @param {string} [yesterdayDate] - YYYY-MM-DD of the day that just ended
   */
  async onDayRollover(yesterdayDate) {
    await this.postDailyRecap(yesterdayDate);

    // Check if today is the weekly reset day
    const today = this._config.getToday();
    const todayNum = new Date(`${today}T12:00:00Z`).getUTCDay();

    if (todayNum === this._config.weeklyResetDay) {
      await this.postWeeklyDigest();
    }
  }

  // ── Posting ────────────────────────────────────────────────

  async _post(embeds) {
    const target = this._getPostTarget();
    if (!target) {
      console.warn(`[${this._label}] No channel available — recap dropped`);
      return;
    }
    try {
      await target.send({ embeds });
    } catch (err) {
      console.error(`[${this._label}] Failed to post recap:`, err.message);
    }
  }

  _getPostTarget() {
    // Post to the log channel directly (not the thread — recaps are top-level)
    if (this._logWatcher?.logChannel) {
      return this._logWatcher.logChannel;
    }
    const channelId = this._config.logChannelId;
    if (channelId && this._client) {
      return this._client.channels.cache.get(channelId) || null;
    }
    return null;
  }

  // ── State persistence ──────────────────────────────────────

  _loadState() {
    if (!this._db) return {};
    try {
      return this._db.getStateJSON(STATE_KEY, {});
    } catch { return {}; }
  }

  _saveLastDaily(date, stats) {
    if (!this._db) return;
    try {
      const state = this._loadState();
      state.lastDaily = { date, ...stats };
      this._db.setStateJSON(STATE_KEY, state);
    } catch (err) {
      console.error(`[${this._label}] Failed to save daily state:`, err.message);
    }
  }

  _saveWeeklyStats(stats) {
    if (!this._db) return;
    try {
      const state = this._loadState();
      state.lastWeekly = stats;
      this._db.setStateJSON(STATE_KEY, state);
    } catch (err) {
      console.error(`[${this._label}] Failed to save weekly state:`, err.message);
    }
  }

  // ── Utility ────────────────────────────────────────────────

  _getYesterday() {
    const today = this._config.getToday();
    const d = new Date(`${today}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().split('T')[0];
  }
}

RecapService.STATE_KEY = STATE_KEY;

module.exports = RecapService;

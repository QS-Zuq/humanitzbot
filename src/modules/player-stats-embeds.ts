/**
 * player-stats-embeds.js — Embed builders for PlayerStatsChannel.
 *
 * DB-first: all data comes from SQLite via the PSC instance.
 * Mixed into PlayerStatsChannel.prototype via Object.assign().
 *
 * Display hierarchy:
 *   Overview embed (persistent) — Schedule → Quick Stats → Leaderboards
 *   Player detail  (ephemeral)  — Identity → Combat → Vitals → Progression
 *   Clan detail    (ephemeral)  — Summary → Members → Activity
 */

import { EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder } from 'discord.js';
import { PERK_MAP } from '../parsers/save-parser.js';
import * as gameData from '../parsers/game-data.js';
import { cleanItemName as _rawClean, cleanItemArray, isHexGuid } from '../parsers/ue4-names.js';
import { buildScheduleField } from '../server/server-display.js';
import { t, getLocale, fmtDate, fmtTime, fmtNumber } from '../i18n/index.js';

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access,
   @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call,
   @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return,
   @typescript-eslint/restrict-template-expressions, @typescript-eslint/no-base-to-string,
   @typescript-eslint/restrict-plus-operands, @typescript-eslint/no-unnecessary-condition,
   @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/no-non-null-assertion
   -- embed builders receive untyped save/playtime/config data via prototype mixin */
// ─── Helpers ─────────────────────────────────────────────────────────

/** Clean a UE4 item name; returns '' for junk/null/hex GUIDs. */
function _clean(name: any) {
  if (!name) return '';
  if (typeof name === 'string' && isHexGuid(name)) return '';
  const c = _rawClean(name);
  return c === 'Unknown' ? '' : c;
}

/** Format milliseconds → "12h 34m" or "34m". */
function _fmtTime(ms: any, locale: any = 'en') {
  if (!ms || ms <= 0) {
    return t('discord:player_stats.duration_minutes', locale, {
      minutes: fmtNumber(0, locale),
    });
  }
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (h > 0) {
    return t('discord:player_stats.duration_hours_minutes', locale, {
      hours: fmtNumber(h, locale),
      minutes: fmtNumber(m, locale),
    });
  }
  return t('discord:player_stats.duration_minutes', locale, {
    minutes: fmtNumber(m, locale),
  });
}

/** Percentage bar — 10 chars wide. */
function _bar(value: any, max: any) {
  const pct = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  const filled = Math.round(pct * 10);
  return '\u2588'.repeat(filled) + '\u2591'.repeat(10 - filled);
}

/** Percentage string. */
function _pct(value: any, max: any) {
  if (!max || max <= 0) return '0%';
  return `${Math.round(Math.max(0, Math.min(100, (value / max) * 100)))}%`;
}

/** Medal array for leaderboards. */
const MEDALS = ['\u{1F947}', '\u{1F948}', '\u{1F949}', '4\uFE0F\u20E3', '5\uFE0F\u20E3'];

function _tp(locale: any, key: any, vars: any = {}) {
  return t(`discord:player_stats.${key}`, locale, vars);
}

// ─── Category enum → name ────────────────────────────────────────
const _SKILL_CAT: Record<string, string> = {
  NewEnumerator0: 'Survival',
  NewEnumerator1: 'Crafting',
  NewEnumerator2: 'Combat',
};

/** Build a lookup: { "Survival": [{ tier, column, name }, ...], ... } from SKILL_DETAILS. */
function _buildSkillLookup() {
  const byCategory: Record<string, any[]> = {};
  for (const sk of Object.values(gameData.SKILL_DETAILS || {})) {
    if (!sk.name || (sk as any).levelUnlock < 0) continue; // skip disabled placeholders
    const cat = String(sk.category || '');
    if (!byCategory[cat as string]) byCategory[cat as string] = [];
    byCategory[cat]!.push({ tier: (sk as any).tier ?? 0, column: (sk as any).column ?? 0, name: (sk as any).name });
  }
  return byCategory;
}

let _skillLookupCache: Record<string, any[]> | null = null;
function _getSkillLookup() {
  if (!_skillLookupCache) _skillLookupCache = _buildSkillLookup();
  return _skillLookupCache;
}

/**
 * Parse skill tree data (from DB skills_data JSON) into a display-friendly structure.
 * Uses `locked`/`unlockProgress` fields — NOT the unreliable GUID arrays.
 * @param {Array|string} raw — skillTree array or JSON string from DB
 * @returns {object|null} { Survival: { unlocked, total, names }, Crafting: ..., Combat: ... }
 */
function _parseSkillTree(raw: any) {
  if (!raw) return null;
  let tree = raw;
  if (typeof raw === 'string') {
    try {
      tree = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(tree) || tree.length === 0) return null;

  const lookup = _getSkillLookup();
  const result: Record<string, any> = {};

  for (const node of tree) {
    if (!node || typeof node !== 'object') continue;

    // Resolve category from type enum
    const typeStr = String(node.type || '');
    const enumKey = typeStr.replace(/^.*::/, '');
    const cat = _SKILL_CAT[enumKey];
    if (!cat) continue;

    const catSkills = lookup[cat];
    if (!catSkills) continue;

    if (!result[cat]) {
      result[cat] = { unlocked: 0, total: catSkills.length, names: [] };
    }

    // For Survival and Crafting: each tree node represents a tier.
    // unlockProgress array has 3 entries (one per column) — {x, y} where x/y >= 1 means unlocked.
    if ((cat === 'Survival' || cat === 'Crafting') && Array.isArray(node.unlockProgress)) {
      const tier = node.index ?? 0;
      for (let col = 0; col < node.unlockProgress.length; col++) {
        const prog = node.unlockProgress[col];
        if (prog && typeof prog === 'object' && prog.x >= prog.y && prog.y > 0) {
          result[cat].unlocked++;
          const skill = catSkills.find((s: any) => s.tier === tier && s.column === col);
          if (skill) result[cat].names.push(skill.name);
        }
      }
    }

    // Combat: flat sequential mapping — each node index = one skill
    if (cat === 'Combat') {
      const idx = node.index ?? 0;
      // Combat skills are ordered column-first, tier-second: col0tier0, col0tier1, ...
      const col = Math.floor(idx / 4);
      const tier = idx % 4;
      if (!node.locked && Array.isArray(node.unlockProgress)) {
        // Single skill per node in combat; check if the first progress entry is complete
        const prog = node.unlockProgress[0];
        if (prog && typeof prog === 'object' && prog.x >= prog.y && prog.y > 0) {
          result[cat].unlocked++;
          const skill = catSkills.find((s: any) => s.tier === tier && s.column === col);
          if (skill) result[cat].names.push(skill.name);
        }
      }
    }
  }

  // Only return if any data was found
  const hasData = Object.values(result).some((r: any) => r.unlocked > 0 || r.total > 0);
  return hasData ? result : null;
}

// ═════════════════════════════════════════════════════════════════════
//  _buildOverviewEmbed — Persistent channel embed
//
//  Layout priority:
//    1. Dynamic difficulty schedule  (THE selling point)
//    2. Server quick stats           (players, world state)
//    3. Leaderboards                 (kills, playtime, survival)
//    4. Weekly highlights
// ═════════════════════════════════════════════════════════════════════

function _buildOverviewEmbed(this: any) {
  const locale = getLocale({ serverConfig: this._config });
  const serverTag = this._config.serverName ? ` — ${this._config.serverName}` : '';
  const embed = new EmbedBuilder()
    .setTitle(`${_tp(locale, 'overview_title')}${serverTag}`)
    .setColor(0x5865f2)
    .setTimestamp()
    .setFooter({ text: _tp(locale, 'overview_footer') });

  // ┌──────────────────────────────────────────────────────────────┐
  // │  1. DYNAMIC DIFFICULTY SCHEDULE — The #1 feature            │
  // └──────────────────────────────────────────────────────────────┘
  const schedField = buildScheduleField(this._config);
  if (schedField) {
    embed.addFields({ name: schedField.name, value: schedField.value });
  }

  // ┌──────────────────────────────────────────────────────────────┐
  // │  2. SERVER QUICK STATS                                      │
  // └──────────────────────────────────────────────────────────────┘
  const roster = this._buildRoster();
  const players: any[] = Array.from(roster.values());
  const onlineCount = players.filter((p: any) => p.online).length;
  const totalKills = players.reduce((s: any, p: any) => s + p.kills, 0);
  const totalDeaths = players.reduce((s: any, p: any) => s + p.deaths, 0);

  const descLines = [
    _tp(locale, 'overview_online_summary', {
      online: fmtNumber(onlineCount, locale),
      total: fmtNumber(players.length, locale),
    }),
    _tp(locale, 'overview_kills_summary', {
      kills: fmtNumber(totalKills, locale),
      deaths: fmtNumber(totalDeaths, locale),
    }),
  ];
  embed.setDescription(descLines.join('\n'));

  // ┌──────────────────────────────────────────────────────────────┐
  // │  3. LEADERBOARDS — Side by side                             │
  // └──────────────────────────────────────────────────────────────┘

  // Top Killers
  const topKillers = players
    .filter((p: any) => p.kills > 0)
    .sort((a: any, b: any) => b.kills - a.kills)
    .slice(0, 5);
  if (topKillers.length > 0) {
    const lines = topKillers.map((p, i) => `${MEDALS[i]} **${p.name}** \u2014 ${fmtNumber(p.kills, locale)}`);
    embed.addFields({ name: _tp(locale, 'top_killers'), value: lines.join('\n'), inline: true });
  }

  // Top Playtime
  const topPlaytime = players
    .filter((p: any) => p.playtime > 0)
    .sort((a: any, b: any) => b.playtime - a.playtime)
    .slice(0, 5);
  if (topPlaytime.length > 0) {
    const lines = topPlaytime.map((p, i) => `${MEDALS[i]} **${p.name}** \u2014 ${_fmtTime(p.playtime, locale)}`);
    embed.addFields({ name: _tp(locale, 'most_active'), value: lines.join('\n'), inline: true });
  }

  // Top Survivors
  const topSurvivors = players
    .filter((p: any) => p.daysSurvived > 0)
    .sort((a: any, b: any) => b.daysSurvived - a.daysSurvived)
    .slice(0, 5);
  if (topSurvivors.length > 0) {
    const lines = topSurvivors.map(
      (p, i) =>
        `${MEDALS[i]} **${p.name}** \u2014 ${_tp(locale, 'days_short', { days: fmtNumber(p.daysSurvived, locale) })}`,
    );
    embed.addFields({ name: _tp(locale, 'longest_survival'), value: lines.join('\n'), inline: true });
  }

  // ┌──────────────────────────────────────────────────────────────┐
  // │  4. FUN STATS + WEEKLY                                      │
  // └──────────────────────────────────────────────────────────────┘

  const funLines = [];
  const mostBitten = players.filter((p: any) => p.bitten > 0).sort((a: any, b: any) => b.bitten - a.bitten)[0];
  if (mostBitten) {
    funLines.push(
      _tp(locale, 'fun_most_bitten', {
        name: mostBitten.name,
        count: fmtNumber(mostBitten.bitten, locale),
      }),
    );
  }
  const topFisher = players
    .filter((p: any) => p.fishCaught > 0)
    .sort((a: any, b: any) => b.fishCaught - a.fishCaught)[0];
  if (topFisher) {
    funLines.push(
      _tp(locale, 'fun_top_angler', {
        name: topFisher.name,
        count: fmtNumber(topFisher.fishCaught, locale),
      }),
    );
  }
  const topPvP = players.filter((p: any) => p.pvpKills > 0).sort((a: any, b: any) => b.pvpKills - a.pvpKills)[0];
  if (topPvP) {
    funLines.push(
      _tp(locale, 'fun_pvp_leader', {
        name: topPvP.name,
        count: fmtNumber(topPvP.pvpKills, locale),
      }),
    );
  }
  if (funLines.length > 0)
    embed.addFields({ name: _tp(locale, 'fun_stats'), value: funLines.join('\n'), inline: true });

  // Weekly highlights
  if (this._weeklyStats) {
    const ws = this._weeklyStats;
    const weekLines = [];
    const wk = ws.topKillers?.[0];
    if (wk) {
      weekLines.push(
        _tp(locale, 'week_top_killer', {
          name: wk.name,
          kills: fmtNumber(wk.kills, locale),
        }),
      );
    }
    const wp = ws.topPlaytime?.[0];
    if (wp) weekLines.push(_tp(locale, 'week_most_active', { name: wp.name, playtime: _fmtTime(wp.ms, locale) }));
    if (ws.newPlayers > 0) {
      weekLines.push(
        _tp(locale, 'week_new_players', {
          count: fmtNumber(ws.newPlayers, locale),
          plural_suffix: ws.newPlayers > 1 ? 's' : '',
        }),
      );
    }
    if (weekLines.length > 0)
      embed.addFields({ name: _tp(locale, 'this_week'), value: weekLines.join('\n'), inline: true });
  }

  // Last save update
  if (this._lastSaveUpdate) {
    const ago = Math.round((Date.now() - this._lastSaveUpdate) / 60000);
    if (ago >= 0) {
      embed.addFields({
        name: _tp(locale, 'last_save'),
        value: _tp(locale, 'last_save_value', { minutes: fmtNumber(ago, locale) }),
        inline: true,
      });
    }
  }

  return embed;
}

/**
 * Build merged roster Map<steamId, playerObj> from save + log + playtime.
 * Internal helper used by overview and select menus.
 * Cached for 5 seconds to avoid duplicate work when _buildOverviewEmbed()
 * and _buildPlayerRow() both call this in the same render cycle.
 */
function _buildRoster(this: any) {
  const now = Date.now();
  if (this._cachedRoster && this._rosterCacheTime && now - this._rosterCacheTime < 5000) {
    return this._cachedRoster;
  }

  const allLog = this._playerStats.getAllPlayers();
  const sessions = this._playtime.getActiveSessions() || {};
  const ptLeaderboard = this._playtime.getLeaderboard();

  const onlineNames = new Set(Object.keys(sessions));
  const recentMs = 10 * 60000;
  for (const s of allLog) {
    if (s.lastEvent && now - new Date(s.lastEvent).getTime() < recentMs) onlineNames.add(s.name);
  }

  const roster = new Map();

  // Save data players (richest source)
  if (this._saveData) {
    for (const [sid, sd] of this._saveData.entries()) {
      const at = this.getAllTimeKills(sid);
      roster.set(sid, {
        name: sd.name || sid,
        kills: at?.zeeksKilled || 0,
        deaths: 0,
        fishCaught: sd.fishCaught || 0,
        daysSurvived: sd.daysSurvived || 0,
        bitten: sd.timesBitten || 0,
        pvpKills: 0,
        playtime: 0,
        online: onlineNames.has(sd.name || sid),
      });
    }
  }

  // Merge log data
  for (const stats of allLog) {
    const sid = stats.id || stats.name;
    const existing = roster.get(sid);
    if (existing) {
      existing.deaths = Math.max(existing.deaths, stats.deaths || 0);
      existing.pvpKills = Math.max(existing.pvpKills, stats.pvpKills || 0);
    } else {
      roster.set(sid, {
        name: stats.name,
        kills: 0,
        deaths: stats.deaths || 0,
        fishCaught: 0,
        daysSurvived: 0,
        bitten: 0,
        pvpKills: stats.pvpKills || 0,
        playtime: 0,
        online: onlineNames.has(stats.name),
      });
    }
  }

  // Merge playtime
  for (const entry of ptLeaderboard) {
    const existing = roster.get(entry.id);
    if (existing) {
      existing.playtime = entry.totalMs || 0;
    } else {
      for (const [, r] of roster) {
        if (r.name === entry.name) {
          r.playtime = entry.totalMs || 0;
          break;
        }
      }
    }
  }

  this._cachedRoster = roster;
  this._rosterCacheTime = Date.now();
  return roster;
}

// ═════════════════════════════════════════════════════════════════════
//  _buildPlayerRow — Player select menu
// ═════════════════════════════════════════════════════════════════════

function _buildPlayerRow(this: any) {
  const locale = getLocale({ serverConfig: this._config });
  const roster = this._buildRoster();
  const players = (Array.from(roster.entries()) as [any, any][]).map(([sid, p]) => ({ steamId: sid, ...p }));

  players.sort((a: any, b: any) => {
    if (a.online !== b.online) return a.online ? -1 : 1;
    if (b.kills !== a.kills) return b.kills - a.kills;
    return a.name.localeCompare(b.name);
  });

  const options = players.slice(0, 25).map((p: any) => {
    const status = p.online ? '\uD83D\uDFE2 ' : '';
    const desc = _tp(locale, 'player_option_description', {
      kills: fmtNumber(p.kills, locale),
      deaths: fmtNumber(p.deaths, locale),
      days: fmtNumber(p.daysSurvived, locale),
    });
    return {
      label: `${status}${p.name}`.substring(0, 100),
      description: desc.substring(0, 100),
      value: p.steamId.substring(0, 100),
    };
  });

  if (options.length === 0) return [];

  return [
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`playerstats_player_select${this._serverId ? `:${this._serverId}` : ''}`)
        .setPlaceholder(_tp(locale, 'player_select_placeholder'))
        .addOptions(options),
    ),
  ];
}

// ═════════════════════════════════════════════════════════════════════
//  _buildClanRow — Clan select menu
// ═════════════════════════════════════════════════════════════════════

function _buildClanRow(this: any) {
  const locale = getLocale({ serverConfig: this._config });
  if (!this._clanData || this._clanData.length === 0) return [];

  const options = [];
  for (const clan of this._clanData) {
    if (!clan.name) continue;
    const memberCount = clan.members?.length || 0;
    let totalKills = 0;
    for (const m of clan.members || []) {
      const sid = m.steamId || m.steam_id;
      if (sid) {
        const at = this.getAllTimeKills(sid);
        totalKills += at?.zeeksKilled || 0;
      }
    }
    options.push({
      label: `[${clan.name}]`.substring(0, 100),
      description: _tp(locale, 'clan_option_description', {
        members: fmtNumber(memberCount, locale),
        kills: fmtNumber(totalKills, locale),
      }).substring(0, 100),
      value: `clan:${clan.name}`.substring(0, 100),
    });
  }

  if (options.length === 0) return [];

  return [
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`playerstats_clan_select${this._serverId ? `:${this._serverId}` : ''}`)
        .setPlaceholder(_tp(locale, 'clan_select_placeholder'))
        .addOptions(options.slice(0, 25)),
    ),
  ];
}

// ═════════════════════════════════════════════════════════════════════
//  buildClanEmbed — Ephemeral clan detail
//
//  Layout: Aggregate stats → Member roster → Recent activity
// ═════════════════════════════════════════════════════════════════════

function buildClanEmbed(this: any, clanName: any) {
  const clan = Array.isArray(this._clanData)
    ? this._clanData.find((c: any) => c.name === clanName)
    : this._clanData?.get?.(clanName);
  if (!clan) return null;

  const locale = getLocale({ serverConfig: this._config });

  const embed = new EmbedBuilder()
    .setTitle(_tp(locale, 'clan_title', { clan_name: clanName }))
    .setColor(0xe67e22)
    .setTimestamp();

  const members = clan.members || [];
  const sessions = this._playtime.getActiveSessions() || {};
  const allLog = this._playerStats.getAllPlayers();

  let totalKills = 0,
    totalDeaths = 0,
    bestDays = 0,
    totalPtMs = 0;
  const memberLines = [];

  for (const m of members) {
    const sid = m.steamId || m.steam_id;
    const name = m.name || sid;
    const save = sid ? this._saveData?.get(sid) : null;
    const at = sid ? this.getAllTimeKills(sid) : null;
    const kills = at?.zeeksKilled || 0;
    const logEntry = sid ? allLog.find((l: any) => l.id === sid) : null;
    const deaths = logEntry?.deaths || 0;
    const days = save?.daysSurvived || 0;
    const pt = sid ? this._playtime.getPlaytime(sid) : null;
    const ptMs = pt?.totalMs || 0;
    const online = !!sessions[name];

    totalKills += kills;
    totalDeaths += deaths;
    bestDays = Math.max(bestDays, days);
    totalPtMs += ptMs;

    const status = online ? '\uD83D\uDFE2' : '\u26AB';
    const role = m.canKick || m.can_kick ? ' \uD83D\uDC51' : '';
    memberLines.push(
      _tp(locale, 'clan_member_line', {
        status,
        role,
        name,
        kills: fmtNumber(kills, locale),
        days: fmtNumber(days, locale),
        playtime: _fmtTime(ptMs, locale),
      }),
    );
  }

  // Aggregate stats as description
  const desc = [
    _tp(locale, 'clan_members_count', {
      count: fmtNumber(members.length, locale),
      plural_suffix: members.length !== 1 ? 's' : '',
    }),
    _tp(locale, 'clan_kills_deaths', {
      kills: fmtNumber(totalKills, locale),
      deaths: fmtNumber(totalDeaths, locale),
    }),
  ];
  if (bestDays > 0) {
    desc.push(_tp(locale, 'clan_best_survival', { days: fmtNumber(bestDays, locale) }));
  }
  if (totalPtMs > 0) {
    desc.push(_tp(locale, 'clan_combined_playtime', { playtime: _fmtTime(totalPtMs, locale) }));
  }
  embed.setDescription(desc.join('\n'));

  // Member list
  if (memberLines.length > 0) {
    embed.addFields({
      name: _tp(locale, 'members'),
      value: memberLines.join('\n').substring(0, 1024),
    });
  }

  // Recent activity: last seen
  const activityLines = [];
  for (const m of members) {
    const sid = m.steamId || m.steam_id;
    const name = m.name || sid;
    const logEntry = allLog.find((l: any) => l.id === sid || l.name === name);
    if (logEntry?.lastEvent) {
      const d = new Date(logEntry.lastEvent);
      const dateStr = fmtDate(d, locale);
      activityLines.push(`${name}: ${dateStr}`);
    }
  }
  if (activityLines.length > 0) {
    embed.addFields({
      name: _tp(locale, 'last_active'),
      value: activityLines.slice(0, 8).join('\n'),
      inline: true,
    });
  }

  return embed;
}

// ═════════════════════════════════════════════════════════════════════
//  buildFullPlayerEmbed — Ephemeral player detail
//
//  Layout priority (what players actually care about):
//    1. Identity: name, profession, level, playtime
//    2. Combat:   kills (with breakdown), deaths, survival streak
//    3. Vitals:   health bars + status effects
//    4. Gear:     compact inventory (equipped + quick slots)
//    5. Progress: challenges completed, professions unlocked
//    6. Meta:     connections, location (admin), companions
//
//  Rules:
//    - No hex GUIDs ever displayed
//    - No massive comma-separated lists (truncate intelligently)
//    - Fields only shown if they have meaningful data
//    - Admin-gated data respects canShow() toggles
// ═════════════════════════════════════════════════════════════════════

function buildFullPlayerEmbed(this: any, steamId: any, { isAdmin = false } = {}) {
  const resolved = this._resolvePlayer(steamId);
  const log = resolved.log;
  const save = resolved.save;
  const pt = resolved.playtime;
  const locale = getLocale({ serverConfig: this._config });

  const serverTag = this._config.serverName ? ` [${this._config.serverName}]` : '';
  const embed = new EmbedBuilder().setColor(0x5865f2).setTimestamp();

  // Random loading tip for footer
  const tips = gameData.LOADING_TIPS.filter((t: any) => t.length > 20 && t.length < 120);
  const tip = tips.length > 0 ? tips[Math.floor(Math.random() * tips.length)] : null;
  embed.setFooter({ text: tip ? `\uD83D\uDCA1 ${tip}` : _tp(locale, 'player_stats_footer') });

  // ┌──────────────────────────────────────────────────────────────┐
  // │  1. IDENTITY — Title + Description                          │
  // └──────────────────────────────────────────────────────────────┘

  const titleParts = [resolved.name];
  if (save?.startingPerk && save.startingPerk !== 'Unknown') {
    titleParts.push(`\u00B7 ${save.startingPerk}`);
  }
  embed.setTitle(`${titleParts.join(' ')}${serverTag}`);

  const desc = [];

  // Profession perk description
  if (save?.startingPerk) {
    const prof = gameData.PROFESSION_DETAILS[save.startingPerk];
    if (prof) desc.push(`> *${prof.perk}*`);
  }

  // Level + XP progress + Skill points + Gender
  const identityBits = [];
  if (save) {
    identityBits.push(save.male ? '\u2642' : '\u2640');
    if (save.level > 0) identityBits.push(_tp(locale, 'level_short', { level: fmtNumber(save.level, locale) }));
    if (save.expCurrent != null && save.expRequired > 0) {
      identityBits.push(
        _tp(locale, 'xp_progress', {
          bar: _bar(save.expCurrent, save.expRequired),
          percent: _pct(save.expCurrent, save.expRequired),
        }),
      );
    } else if (save.exp > 0) {
      identityBits.push(_tp(locale, 'xp_amount', { xp: fmtNumber(Math.round(save.exp), locale) }));
    }
    if (save.skillPoints > 0) {
      identityBits.push(_tp(locale, 'skill_points', { points: fmtNumber(save.skillPoints, locale) }));
    }
  }
  if (pt) identityBits.push(_tp(locale, 'playtime_label', { playtime: pt.totalFormatted }));
  if (identityBits.length > 0) desc.push(identityBits.join(' \u00B7 '));

  // First seen + sessions
  const metaBits = [];
  if (resolved.firstSeen) {
    const fs = new Date(resolved.firstSeen);
    metaBits.push(_tp(locale, 'first_seen', { date: fmtDate(fs, locale) }));
  }
  if (pt?.sessions > 0) {
    metaBits.push(
      _tp(locale, 'session_count', {
        count: fmtNumber(pt.sessions, locale),
        plural_suffix: pt.sessions !== 1 ? 's' : '',
      }),
    );
  }
  if (metaBits.length > 0) desc.push(metaBits.join(' \u00B7 '));

  // Affliction warning
  if (
    save &&
    typeof save.affliction === 'number' &&
    save.affliction > 0 &&
    save.affliction < gameData.AFFLICTION_MAP.length
  ) {
    desc.push(`\u26A0\uFE0F **${gameData.AFFLICTION_MAP[save.affliction]}**`);
  }

  // Name history (compact)
  if (log?.nameHistory?.length > 0) {
    desc.push(_tp(locale, 'aka_names', { names: log.nameHistory.map((h: any) => h.name).join(', ') }));
  }

  if (desc.length > 0) embed.setDescription(desc.join('\n'));

  // ┌──────────────────────────────────────────────────────────────┐
  // │  2. COMBAT & SURVIVAL — The core stats                      │
  // └──────────────────────────────────────────────────────────────┘

  if (save) {
    const at = this.getAllTimeKills(steamId);
    const cl = this.getCurrentLifeKills(steamId);
    const hasExt = save.hasExtendedStats;

    const killTypes = [
      ['\uD83E\uDDDF', 'kill_type_zombie', 'zeeksKilled'],
      ['\uD83C\uDFAF', 'kill_type_headshot', 'headshots'],
      ['\u2694\uFE0F', 'kill_type_melee', 'meleeKills'],
      ['\uD83D\uDD2B', 'kill_type_ranged', 'gunKills'],
      ['\uD83D\uDCA5', 'kill_type_blast', 'blastKills'],
      ['\uD83D\uDC4A', 'kill_type_unarmed', 'fistKills'],
      ['\uD83D\uDDE1\uFE0F', 'kill_type_takedown', 'takedownKills'],
      ['\uD83D\uDE97', 'kill_type_vehicle', 'vehicleKills'],
    ];

    const killLines = [];
    for (const [emoji, labelKey, key] of killTypes) {
      const allTime = (at as any)?.[key as string] || 0;
      const life = (cl as any)?.[key as string] || 0;
      if (allTime <= 0 && life <= 0) continue;
      const label = _tp(locale, labelKey);
      if (hasExt && life > 0 && life !== allTime) {
        killLines.push(
          _tp(locale, 'kill_line_with_life', {
            emoji,
            label,
            all_time: fmtNumber(allTime, locale),
            life: fmtNumber(life, locale),
          }),
        );
      } else {
        killLines.push(
          _tp(locale, 'kill_line', {
            emoji,
            label,
            all_time: fmtNumber(allTime, locale),
          }),
        );
      }
    }

    const survLines = [];
    if (save.daysSurvived > 0) {
      const atSurv = this.getAllTimeSurvival(steamId);
      if (atSurv?.daysSurvived > save.daysSurvived) {
        survLines.push(
          _tp(locale, 'survived_with_best', {
            days: fmtNumber(save.daysSurvived, locale),
            best_days: fmtNumber(atSurv.daysSurvived, locale),
          }),
        );
      } else {
        survLines.push(_tp(locale, 'survived_line', { days: fmtNumber(save.daysSurvived, locale) }));
      }
    }
    if (log) survLines.push(_tp(locale, 'deaths_line', { count: fmtNumber(log.deaths, locale) }));
    if (save.timesBitten > 0) {
      survLines.push(_tp(locale, 'bitten_line', { count: fmtNumber(save.timesBitten, locale) }));
    }
    if (save.fishCaught > 0) {
      const pike =
        save.fishCaughtPike > 0
          ? _tp(locale, 'fish_pike_suffix', { count: fmtNumber(save.fishCaughtPike, locale) })
          : '';
      survLines.push(
        _tp(locale, 'fish_line', {
          count: fmtNumber(save.fishCaught, locale),
          pike_suffix: pike,
        }),
      );
    }

    const combatValue = [...killLines, ...survLines].join('\n');
    if (combatValue) {
      embed.addFields({ name: _tp(locale, 'combat_survival'), value: combatValue });
    }
  } else if (log) {
    embed.addFields({
      name: _tp(locale, 'combat'),
      value: _tp(locale, 'deaths_line', { count: fmtNumber(log.deaths, locale) }),
    });
  }

  // PvP (inline)
  if (log && ((log.pvpKills || 0) > 0 || (log.pvpDeaths || 0) > 0)) {
    const p = [];
    if (log.pvpKills > 0) p.push(_tp(locale, 'pvp_kills_line', { count: fmtNumber(log.pvpKills, locale) }));
    if (log.pvpDeaths > 0) p.push(_tp(locale, 'pvp_deaths_line', { count: fmtNumber(log.pvpDeaths, locale) }));
    const kd = log.pvpDeaths > 0 ? (log.pvpKills / log.pvpDeaths).toFixed(2) : log.pvpKills > 0 ? '\u221E' : '0';
    p.push(_tp(locale, 'pvp_kd_line', { kd }));
    embed.addFields({ name: _tp(locale, 'pvp'), value: p.join(' \u00B7 '), inline: true });
  }

  // ┌──────────────────────────────────────────────────────────────┐
  // │  3. VITALS — Health bars + status effects                   │
  // └──────────────────────────────────────────────────────────────┘

  if (this._config.canShow('showVitals', isAdmin) && save) {
    const vitals = [];
    if (this._config.showHealth)
      vitals.push(
        `\u2764\uFE0F \`${_bar(save.health, save.maxHealth || 100)}\` ${_pct(save.health, save.maxHealth || 100)}`,
      );
    if (this._config.showHunger)
      vitals.push(
        `\uD83C\uDF56 \`${_bar(save.hunger, save.maxHunger || 100)}\` ${_pct(save.hunger, save.maxHunger || 100)}`,
      );
    if (this._config.showThirst)
      vitals.push(
        `\uD83D\uDCA7 \`${_bar(save.thirst, save.maxThirst || 100)}\` ${_pct(save.thirst, save.maxThirst || 100)}`,
      );
    if (this._config.showStamina)
      vitals.push(
        `\u26A1 \`${_bar(save.stamina, save.maxStamina || 100)}\` ${_pct(save.stamina, save.maxStamina || 100)}`,
      );
    if (this._config.showImmunity)
      vitals.push(
        `\uD83D\uDEE1\uFE0F \`${_bar(save.infection, save.maxInfection || 100)}\` ${_pct(save.infection, save.maxInfection || 100)}`,
      );
    if (this._config.showBattery && save.battery > 0 && save.battery < 100)
      vitals.push(`\uD83D\uDD0B \`${_bar(save.battery, 100)}\` ${_pct(save.battery, 100)}`);
    if (save.energy > 0) {
      vitals.push(
        _tp(locale, 'energy_line', {
          bar: _bar(save.energy, 100),
          percent: _pct(save.energy, 100),
        }),
      );
    }
    if (save.wellRested) vitals.push(_tp(locale, 'well_rested'));

    // Status effects (compact single line)
    if (this._config.canShow('showStatusEffects', isAdmin)) {
      const statuses = [];
      if (save.playerStates?.length > 0) {
        for (const s of save.playerStates) {
          if (typeof s !== 'string') continue;
          const cleaned = _clean(s.replace('States.Player.', ''));
          if (cleaned) statuses.push(cleaned);
        }
      }
      if (save.bodyConditions?.length > 0) {
        for (const s of save.bodyConditions) {
          if (typeof s !== 'string') continue;
          const cleaned = _clean(s.replace('Attributes.Health.', ''));
          if (cleaned) statuses.push(cleaned);
        }
      }
      if (save.infectionBuildup > 0) {
        statuses.push(_tp(locale, 'infection_status', { percent: fmtNumber(save.infectionBuildup, locale) }));
      }
      if (save.fatigue > 0.5) statuses.push(_tp(locale, 'fatigued_status'));
      if (statuses.length > 0) vitals.push(_tp(locale, 'status_line', { statuses: statuses.join(', ') }));
    }

    if (vitals.length > 0) embed.addFields({ name: _tp(locale, 'vitals'), value: vitals.join('\n') });
  }

  // ┌──────────────────────────────────────────────────────────────┐
  // │  4. GEAR — Equipment + Quick Slots (compact)                │
  // └──────────────────────────────────────────────────────────────┘

  if (this._config.canShow('showInventory', isAdmin) && save) {
    const notEmpty = (i: any) => i?.item && !/^empty$/i.test(i.item) && !/^empty$/i.test(_clean(i.item));
    const fmtItem = (i: any) => {
      const name = _clean(i.item);
      if (!name) return '';
      const amt = i.amount > 1 ? ` \u00D7${i.amount}` : '';
      return `${name}${amt}`;
    };

    const sections = [];

    if (this._config.showEquipment) {
      const equip = (save.equipment || []).filter(notEmpty);
      if (equip.length > 0) {
        sections.push(_tp(locale, 'inventory_equipped', { items: equip.map(fmtItem).filter(Boolean).join(', ') }));
      }
    }
    if (this._config.showQuickSlots) {
      const quick = (save.quickSlots || []).filter(notEmpty);
      if (quick.length > 0) {
        sections.push(_tp(locale, 'inventory_quick', { items: quick.map(fmtItem).filter(Boolean).join(', ') }));
      }
    }
    if (this._config.showPockets) {
      const pockets = (save.inventory || []).filter(notEmpty);
      if (pockets.length > 0) {
        if (pockets.length <= 6) {
          sections.push(_tp(locale, 'inventory_pockets', { items: pockets.map(fmtItem).filter(Boolean).join(', ') }));
        } else {
          sections.push(_tp(locale, 'inventory_pockets_count', { count: fmtNumber(pockets.length, locale) }));
        }
      }
    }
    if (this._config.showBackpack) {
      const bp = (save.backpackItems || []).filter(notEmpty);
      if (bp.length > 0) {
        if (bp.length <= 6) {
          sections.push(_tp(locale, 'inventory_backpack', { items: bp.map(fmtItem).filter(Boolean).join(', ') }));
        } else {
          sections.push(_tp(locale, 'inventory_backpack_count', { count: fmtNumber(bp.length, locale) }));
        }
      }
    }

    if (sections.length > 0) {
      embed.addFields({ name: _tp(locale, 'inventory'), value: sections.join('\n').substring(0, 1024) });
    }
  }

  // ┌──────────────────────────────────────────────────────────────┐
  // │  5. DAMAGE / KILLED BY (inline pair)                        │
  // └──────────────────────────────────────────────────────────────┘

  if (log) {
    const dmgEntries = Object.entries(log.damageTaken || {});
    if (dmgEntries.length > 0) {
      const sorted = dmgEntries.sort((a: any, b: any) => b[1] - a[1]);
      const total = sorted.reduce((s: any, [, c]: any) => s + c, 0);
      const lines = sorted.slice(0, 4).map(([src, c]: [any, any]) => `${src}: **${fmtNumber(c, locale)}**`);
      if (sorted.length > 4) {
        lines.push(_tp(locale, 'list_more_count', { count: fmtNumber(sorted.length - 4, locale) }));
      }
      embed.addFields({
        name: _tp(locale, 'damage', { total: fmtNumber(total, locale) }),
        value: lines.join('\n'),
        inline: true,
      });
    }

    const killEntries = Object.entries(log.killedBy || {});
    if (killEntries.length > 0) {
      const sorted = killEntries.sort((a: any, b: any) => b[1] - a[1]);
      const lines = sorted.slice(0, 4).map(([src, c]: [any, any]) => `${src}: **${fmtNumber(c, locale)}**`);
      if (sorted.length > 4) {
        lines.push(_tp(locale, 'list_more_count', { count: fmtNumber(sorted.length - 4, locale) }));
      }
      embed.addFields({ name: _tp(locale, 'killed_by'), value: lines.join('\n'), inline: true });
    }
  }

  // ┌──────────────────────────────────────────────────────────────┐
  // │  6. BASE ACTIVITY (compact inline)                          │
  // └──────────────────────────────────────────────────────────────┘

  if (log) {
    const parts = [];
    if (log.builds > 0) parts.push(_tp(locale, 'base_built', { count: fmtNumber(log.builds, locale) }));
    if (log.containersLooted > 0)
      parts.push(_tp(locale, 'base_looted', { count: fmtNumber(log.containersLooted, locale) }));
    if (this._config.canShow('showRaidStats', isAdmin)) {
      if (log.raidsOut > 0) parts.push(_tp(locale, 'base_raids', { count: fmtNumber(log.raidsOut, locale) }));
      if (log.raidsIn > 0) parts.push(_tp(locale, 'base_raided', { count: fmtNumber(log.raidsIn, locale) }));
    }
    if (parts.length > 0) {
      embed.addFields({ name: _tp(locale, 'base'), value: parts.join(' \u00B7 '), inline: true });
    }
  }

  // ┌──────────────────────────────────────────────────────────────┐
  // │  7. PROGRESSION — Professions, Challenges (compact)         │
  // └──────────────────────────────────────────────────────────────┘

  // Unlocked professions
  if (save?.unlockedProfessions?.length > 1) {
    const profNames = save.unlockedProfessions
      .filter((p: any) => typeof p === 'string')
      .map((p: any) => PERK_MAP[p] || _clean(p))
      .filter(Boolean);
    if (profNames.length > 0) {
      embed.addFields({ name: _tp(locale, 'professions'), value: profNames.join(', '), inline: true });
    }
  }

  // Skill tree — unlocked skills per category
  if (save) {
    const tree = _parseSkillTree(save.skillsData || save.skillTree);
    if (tree) {
      const catEmoji: Record<string, string> = {
        Survival: '\uD83C\uDF3F',
        Crafting: '\uD83D\uDD27',
        Combat: '\u2694\uFE0F',
      };
      const catLabel: Record<string, string> = {
        Survival: _tp(locale, 'skill_category_survival'),
        Crafting: _tp(locale, 'skill_category_crafting'),
        Combat: _tp(locale, 'skill_category_combat'),
      };
      const lines = [];
      for (const [cat, info] of Object.entries(tree)) {
        const emoji = catEmoji[cat] || '\u2B50';
        const bar = `\`${_bar(info.unlocked, info.total)}\``;
        const names = info.names.length > 0 ? _tp(locale, 'skills_names_suffix', { names: info.names.join(', ') }) : '';
        lines.push(
          _tp(locale, 'skills_line', {
            emoji,
            category: catLabel[cat] || cat,
            bar,
            unlocked: fmtNumber(info.unlocked, locale),
            total: fmtNumber(info.total, locale),
            names_suffix: names,
          }),
        );
      }
      if (lines.length > 0) {
        embed.addFields({ name: _tp(locale, 'skills'), value: lines.join('\n').substring(0, 1024) });
      }
    }
  }

  // Challenges — completed vs in-progress
  if (save?.hasExtendedStats) {
    const descs = gameData.CHALLENGE_DESCRIPTIONS;
    const entries = [
      ['challengeKillZombies', save.challengeKillZombies],
      ['challengeKill50', save.challengeKill50],
      ['challengeCatch20Fish', save.challengeCatch20Fish],
      ['challengeRegularAngler', save.challengeRegularAngler],
      ['challengeKillZombieBear', save.challengeKillZombieBear],
      ['challenge9Squares', save.challenge9Squares],
      ['challengeCraftFirearm', save.challengeCraftFirearm],
      ['challengeCraftFurnace', save.challengeCraftFurnace],
      ['challengeCraftMeleeBench', save.challengeCraftMeleeBench],
      ['challengeCraftMeleeWeapon', save.challengeCraftMeleeWeapon],
      ['challengeCraftRainCollector', save.challengeCraftRainCollector],
      ['challengeCraftTablesaw', save.challengeCraftTablesaw],
      ['challengeCraftTreatment', save.challengeCraftTreatment],
      ['challengeCraftWeaponsBench', save.challengeCraftWeaponsBench],
      ['challengeCraftWorkbench', save.challengeCraftWorkbench],
      ['challengeFindDog', save.challengeFindDog],
      ['challengeFindHeli', save.challengeFindHeli],
      ['challengeLockpickSUV', save.challengeLockpickSUV],
      ['challengeRepairRadio', save.challengeRepairRadio],
    ].filter(([, val]) => val > 0);

    if (entries.length > 0) {
      const completed = [];
      const inProgress = [];
      for (const [key, val] of entries) {
        const info = descs[key];
        const target = info?.target || 1;
        if (val >= target) {
          completed.push(info?.name || key);
        } else {
          inProgress.push(`${info?.name || key} (${val}/${target})`);
        }
      }

      const lines = [];
      if (completed.length > 0) {
        lines.push(_tp(locale, 'challenges_completed_line', { items: completed.join(', ') }));
      }
      if (inProgress.length > 0) {
        const shown = inProgress.slice(0, 5);
        lines.push(
          _tp(locale, 'challenges_in_progress_line', {
            items: shown.join(', '),
            more_suffix:
              inProgress.length > 5
                ? _tp(locale, 'challenges_more_suffix', { count: fmtNumber(inProgress.length - 5, locale) })
                : '',
          }),
        );
      }
      embed.addFields({
        name: _tp(locale, 'challenges_title', {
          completed: fmtNumber(completed.length, locale),
          total: fmtNumber(19, locale),
        }),
        value: lines.join('\n').substring(0, 1024),
      });
    }
  }

  // Quest progress — mini-quests and completed quest spawners
  if (save) {
    const questBits = [];
    // Completed quest spawners (major story quests like helicopter, radio tower)
    const doneQuests = Array.isArray(save.questSpawnerDone) ? save.questSpawnerDone.filter(Boolean) : [];
    if (doneQuests.length > 0) {
      questBits.push(
        _tp(locale, 'quests_completed', {
          count: fmtNumber(doneQuests.length, locale),
          plural_suffix: doneQuests.length !== 1 ? 's' : '',
        }),
      );
    }
    // Active mini-quest
    const mq =
      typeof save.miniQuest === 'string'
        ? (() => {
            try {
              return JSON.parse(save.miniQuest);
            } catch {
              return null;
            }
          })()
        : save.miniQuest;
    if (mq && typeof mq === 'object') {
      const questId = mq.QuestID || mq.questID || mq.ID || '';
      const active = mq.Active ?? mq.active;
      if (active && questId) {
        // Try to look up quest name from game data
        const questRef = gameData.QUEST_DATA?.[questId];
        const questName = questRef?.name || _clean(questId) || _tp(locale, 'active_quest');
        questBits.push(`\uD83D\uDCCB ${questName}`);
      }
    }
    if (questBits.length > 0) {
      embed.addFields({ name: _tp(locale, 'quests'), value: questBits.join(' \u00B7 '), inline: true });
    }
  }

  // Recipes — counts only
  if (this._config.canShow('showRecipes', isAdmin) && save) {
    const craft = (save.craftingRecipes || []).length;
    const build = (save.buildingRecipes || []).length;
    if (craft > 0 || build > 0) {
      const parts = [];
      if (craft > 0) parts.push(_tp(locale, 'recipes_crafting', { count: fmtNumber(craft, locale) }));
      if (build > 0) parts.push(_tp(locale, 'recipes_building', { count: fmtNumber(build, locale) }));
      embed.addFields({ name: _tp(locale, 'recipes'), value: parts.join(' \u00B7 '), inline: true });
    }
  }

  // Collections — lore + unique items (names when available)
  const extraBits = [];
  if (this._config.canShow('showLore', isAdmin) && save?.lore?.length > 0) {
    extraBits.push(_tp(locale, 'collections_lore', { count: fmtNumber(save.lore.length, locale) }));
  }
  if (save) {
    const foundItems = cleanItemArray(save.lootItemUnique || []);
    const craftedItems = cleanItemArray(save.craftedUniques || []);
    if (foundItems.length > 0) {
      if (foundItems.length <= 5) {
        extraBits.push(`\u2B50 ${foundItems.join(', ')}`);
      } else {
        extraBits.push(_tp(locale, 'collections_unique_found', { count: fmtNumber(foundItems.length, locale) }));
      }
    }
    if (craftedItems.length > 0) {
      if (craftedItems.length <= 3) {
        extraBits.push(`\uD83D\uDD27 ${craftedItems.join(', ')}`);
      } else {
        extraBits.push(_tp(locale, 'collections_unique_crafted', { count: fmtNumber(craftedItems.length, locale) }));
      }
    }
  }
  if (extraBits.length > 0) {
    embed.addFields({ name: _tp(locale, 'collections'), value: extraBits.join(' \u00B7 '), inline: true });
  }

  // ┌──────────────────────────────────────────────────────────────┐
  // │  8. META — Connections, location, companions                │
  // └──────────────────────────────────────────────────────────────┘

  // Last active + connections
  const metaLines = [];
  if (resolved.lastActive) {
    const d = new Date(resolved.lastActive);
    metaLines.push(
      _tp(locale, 'last_seen', {
        date: fmtDate(d, locale),
        time: fmtTime(d, locale),
      }),
    );
  }
  if (this._config.canShow('showConnections', isAdmin) && log) {
    const conn = [];
    if (log.connects > 0) conn.push(_tp(locale, 'connections_joins', { count: fmtNumber(log.connects, locale) }));
    if (log.disconnects > 0)
      conn.push(_tp(locale, 'connections_leaves', { count: fmtNumber(log.disconnects, locale) }));
    if (log.adminAccess > 0) conn.push(_tp(locale, 'connections_admin', { count: fmtNumber(log.adminAccess, locale) }));
    if (conn.length > 0) metaLines.push(conn.join(' \u00B7 '));
  }
  if (metaLines.length > 0) {
    embed.addFields({ name: _tp(locale, 'activity'), value: metaLines.join('\n'), inline: true });
  }

  // Location (admin-gated)
  if (this._config.canShow('showCoordinates', isAdmin) && save && save.x != null && save.x !== 0) {
    embed.addFields({
      name: _tp(locale, 'location'),
      value: `${Math.round(save.x)}, ${Math.round(save.y)}, ${Math.round(save.z)}`,
      inline: true,
    });
  }

  // Horses + Companions
  if (this._config.canShow('showHorses', isAdmin) && save) {
    const lines = [];
    if (save.horses?.length > 0) {
      for (const h of save.horses) {
        const name = h.displayName || h.name || _clean(h.class || _tp(locale, 'horse_fallback'));
        const hp =
          h.health != null && h.maxHealth > 0
            ? _tp(locale, 'animals_hp_suffix', {
                health: fmtNumber(Math.round(h.health), locale),
                max_health: fmtNumber(Math.round(h.maxHealth), locale),
              })
            : '';
        lines.push(`\uD83D\uDC34 **${name}**${hp}`);
      }
    }
    if (save.companionData?.length > 0) {
      for (const c of save.companionData) {
        const name = c.displayName || c.name || _clean(c.class || _tp(locale, 'companion_fallback'));
        const bits = [];
        if (c.health != null) bits.push(_tp(locale, 'animals_hp', { hp: fmtNumber(Math.round(c.health), locale) }));
        if (c.energy > 0) bits.push(_tp(locale, 'animals_energy', { energy: fmtNumber(Math.round(c.energy), locale) }));
        if (c.command) bits.push(_clean(c.command));
        if (c.vest > 0) bits.push(_tp(locale, 'animals_vest'));
        const detail = bits.length > 0 ? ` \u2014 ${bits.join(' \u00B7 ')}` : '';
        lines.push(`\uD83D\uDC15 **${name}**${detail}`);
      }
    }
    if (lines.length > 0) {
      embed.addFields({ name: _tp(locale, 'animals'), value: lines.join('\n').substring(0, 1024) });
    }
  }

  // Anti-cheat flags (admin only)
  if (isAdmin && log?.cheatFlags?.length > 0) {
    const flags = log.cheatFlags.slice(-3);
    const lines = flags.map((f: any) => {
      const d = new Date(f.timestamp);
      return `${fmtDate(d, locale)} \u2014 \`${f.type}\``;
    });
    if (log.cheatFlags.length > 3) {
      lines.unshift(_tp(locale, 'ac_flags_total', { count: fmtNumber(log.cheatFlags.length, locale) }));
    }
    embed.addFields({ name: _tp(locale, 'ac_flags'), value: lines.join('\n'), inline: true });
  }

  return embed;
}

// ─── Exports ─────────────────────────────────────────────────────────

export { _buildOverviewEmbed, _buildRoster, _buildPlayerRow, _buildClanRow, buildClanEmbed, buildFullPlayerEmbed };

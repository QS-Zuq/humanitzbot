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

// ─── PSCThis — shape of `this` in all embed builder methods ──────────────────

interface ClanMemberEntry {
  steamId?: string;
  steam_id?: string;
  name?: string;
  canKick?: boolean | number;
  can_kick?: boolean | number;
}

interface ClanEntry {
  name?: string;
  members: ClanMemberEntry[];
}

interface PSCThis {
  _config: {
    locale?: string;
    serverName?: string;
    canShow(key: string, isAdmin: boolean): boolean;
    showHealth?: boolean;
    showHunger?: boolean;
    showThirst?: boolean;
    showStamina?: boolean;
    showImmunity?: boolean;
    showBattery?: boolean;
    showEquipment?: boolean;
    showQuickSlots?: boolean;
    showPockets?: boolean;
    showBackpack?: boolean;
  };
  _playtime: {
    getActiveSessions(): Record<string, unknown>;
    getLeaderboard(): Array<{ id: string; name: string; totalMs: number }>;
    getPlaytime(
      id: string,
    ): { totalMs: number; totalFormatted: string; sessions: number; lastSeen?: string; firstSeen?: string } | null;
  };
  _playerStats: {
    getAllPlayers(): Array<Record<string, unknown>>;
    getStats(id: string): Record<string, unknown> | null;
    getNameForId(id: string): string;
  };
  _saveData: Map<string, Record<string, unknown>>;
  _clanData: ClanEntry[];
  _lastSaveUpdate: Date | null;
  _weeklyStats: Record<string, unknown> | null;
  _serverId: string;
  _cachedRoster?: Map<string, RosterPlayer>;
  _rosterCacheTime?: number;
  getAllTimeKills(steamId: string): {
    zeeksKilled: number;
    headshots?: number;
    meleeKills?: number;
    gunKills?: number;
    blastKills?: number;
    fistKills?: number;
    takedownKills?: number;
    vehicleKills?: number;
  } | null;
  getCurrentLifeKills(steamId: string): {
    zeeksKilled: number;
    headshots?: number;
    meleeKills?: number;
    gunKills?: number;
    blastKills?: number;
    fistKills?: number;
    takedownKills?: number;
    vehicleKills?: number;
  } | null;
  getAllTimeSurvival(steamId: string): { daysSurvived: number } | null;
  _buildRoster(): Map<string, RosterPlayer>;
  _resolvePlayer(steamId: string): {
    name: string;
    firstSeen: string | null;
    lastActive: string | null;
    playtime: {
      totalMs: number;
      totalFormatted: string;
      sessions: number;
      lastSeen?: string;
      firstSeen?: string;
    } | null;
    log: Record<string, unknown> | null;
    save: Record<string, unknown> | undefined;
  };
}

interface RosterPlayer {
  name: string;
  kills: number;
  deaths: number;
  fishCaught: number;
  daysSurvived: number;
  bitten: number;
  pvpKills: number;
  playtime: number;
  online: boolean;
}

// ─── Helpers ─────────────────────────────────────────────────────────

/** Clean a UE4 item name; returns '' for junk/null/hex GUIDs. */
function _clean(name: unknown): string {
  if (!name) return '';
  if (typeof name !== 'string' && typeof name !== 'number') return '';
  const nameStr = typeof name === 'string' ? name : String(name);
  if (isHexGuid(nameStr)) return '';
  const c = _rawClean(nameStr);
  return c === 'Unknown' ? '' : c;
}

/** Format milliseconds → "12h 34m" or "34m". */
function _fmtTime(ms: number | null | undefined, locale = 'en'): string {
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
function _bar(value: number, max: number): string {
  const pct = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  const filled = Math.round(pct * 10);
  return '\u2588'.repeat(filled) + '\u2591'.repeat(10 - filled);
}

/** Percentage string. */
function _pct(value: number, max: number): string {
  if (!max || max <= 0) return '0%';
  return `${Math.round(Math.max(0, Math.min(100, (value / max) * 100)))}%`;
}

/** Medal array for leaderboards. */
const MEDALS = ['\u{1F947}', '\u{1F948}', '\u{1F949}', '4\uFE0F\u20E3', '5\uFE0F\u20E3'];

function _tp(locale: string, key: string, vars: Record<string, unknown> = {}): string {
  return t(`discord:player_stats.${key}`, locale, vars);
}

// ─── Category enum → name ────────────────────────────────────────
const _SKILL_CAT: Record<string, string> = {
  NewEnumerator0: 'Survival',
  NewEnumerator1: 'Crafting',
  NewEnumerator2: 'Combat',
};

interface SkillLookupEntry {
  tier: number;
  column: number;
  name: string;
}

/** Build a lookup: { "Survival": [{ tier, column, name }, ...], ... } from SKILL_DETAILS. */
function _buildSkillLookup(): Record<string, SkillLookupEntry[]> {
  const byCategory: Record<string, SkillLookupEntry[]> = {};
  for (const sk of Object.values(gameData.SKILL_DETAILS)) {
    const skName = sk['name'];
    const levelUnlock = sk['levelUnlock'];
    if (!skName || (typeof levelUnlock === 'number' && levelUnlock < 0)) continue;
    const rawCat = sk['category'];
    const cat = typeof rawCat === 'string' ? rawCat : '';
    if (!byCategory[cat]) byCategory[cat] = [];
    const tier = typeof sk['tier'] === 'number' ? sk['tier'] : 0;
    const column = typeof sk['column'] === 'number' ? sk['column'] : 0;
    byCategory[cat].push({ tier, column, name: typeof skName === 'string' ? skName : '' });
  }
  return byCategory;
}

let _skillLookupCache: Record<string, SkillLookupEntry[]> | null = null;
function _getSkillLookup(): Record<string, SkillLookupEntry[]> {
  if (!_skillLookupCache) _skillLookupCache = _buildSkillLookup();
  return _skillLookupCache;
}

interface SkillCatInfo {
  unlocked: number;
  total: number;
  names: string[];
}

interface SkillTreeNode {
  type?: unknown;
  index?: unknown;
  locked?: unknown;
  unlockProgress?: unknown;
}

interface UnlockProgressEntry {
  x: number;
  y: number;
}

/**
 * Parse skill tree data (from DB skills_data JSON) into a display-friendly structure.
 * Uses `locked`/`unlockProgress` fields — NOT the unreliable GUID arrays.
 * @param raw — skillTree array or JSON string from DB
 * @returns { Survival: { unlocked, total, names }, Crafting: ..., Combat: ... } or null
 */
function _parseSkillTree(raw: unknown): Record<string, SkillCatInfo> | null {
  if (!raw) return null;
  let tree: unknown = raw;
  if (typeof raw === 'string') {
    try {
      tree = JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
  }
  if (!Array.isArray(tree) || tree.length === 0) return null;

  const lookup = _getSkillLookup();
  const result: Record<string, SkillCatInfo> = {};

  for (const node of tree as (SkillTreeNode | null | undefined)[]) {
    if (!node || typeof node !== 'object') continue;

    const typeStr = typeof node.type === 'string' ? node.type : '';
    const enumKey = typeStr.replace(/^.*::/, '');
    const cat = _SKILL_CAT[enumKey];
    if (!cat) continue;

    const catSkills = lookup[cat];
    if (!catSkills) continue;

    if (!result[cat]) {
      result[cat] = { unlocked: 0, total: catSkills.length, names: [] };
    }

    const nodeIndex = typeof node.index === 'number' ? node.index : 0;
    const unlockProg = node.unlockProgress;

    if ((cat === 'Survival' || cat === 'Crafting') && Array.isArray(unlockProg)) {
      const tier = nodeIndex;
      for (let col = 0; col < unlockProg.length; col++) {
        const prog = unlockProg[col] as UnlockProgressEntry | undefined;
        if (prog && typeof prog === 'object' && prog.x >= prog.y && prog.y > 0) {
          result[cat].unlocked++;
          const skill = catSkills.find((s) => s.tier === tier && s.column === col);
          if (skill) result[cat].names.push(skill.name);
        }
      }
    }

    if (cat === 'Combat') {
      const idx = nodeIndex;
      const col = Math.floor(idx / 4);
      const tier = idx % 4;
      if (!node.locked && Array.isArray(unlockProg)) {
        const prog = unlockProg[0] as UnlockProgressEntry | undefined;
        if (prog && typeof prog === 'object' && prog.x >= prog.y && prog.y > 0) {
          result[cat].unlocked++;
          const skill = catSkills.find((s) => s.tier === tier && s.column === col);
          if (skill) result[cat].names.push(skill.name);
        }
      }
    }
  }

  const hasData = Object.values(result).some((r) => r.unlocked > 0 || r.total > 0);
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

function _buildOverviewEmbed(this: PSCThis): EmbedBuilder {
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
  const players: RosterPlayer[] = Array.from(roster.values());
  const onlineCount = players.filter((p) => p.online).length;
  const totalKills = players.reduce((s, p) => s + p.kills, 0);
  const totalDeaths = players.reduce((s, p) => s + p.deaths, 0);

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
    .filter((p) => p.kills > 0)
    .sort((a, b) => b.kills - a.kills)
    .slice(0, 5);
  if (topKillers.length > 0) {
    const lines = topKillers.map((p, i) => `${MEDALS[i]} **${p.name}** \u2014 ${fmtNumber(p.kills, locale)}`);
    embed.addFields({ name: _tp(locale, 'top_killers'), value: lines.join('\n'), inline: true });
  }

  // Top Playtime
  const topPlaytime = players
    .filter((p) => p.playtime > 0)
    .sort((a, b) => b.playtime - a.playtime)
    .slice(0, 5);
  if (topPlaytime.length > 0) {
    const lines = topPlaytime.map((p, i) => `${MEDALS[i]} **${p.name}** \u2014 ${_fmtTime(p.playtime, locale)}`);
    embed.addFields({ name: _tp(locale, 'most_active'), value: lines.join('\n'), inline: true });
  }

  // Top Survivors
  const topSurvivors = players
    .filter((p) => p.daysSurvived > 0)
    .sort((a, b) => b.daysSurvived - a.daysSurvived)
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
  const mostBitten = players.filter((p) => p.bitten > 0).sort((a, b) => b.bitten - a.bitten)[0];
  if (mostBitten) {
    funLines.push(
      _tp(locale, 'fun_most_bitten', {
        name: mostBitten.name,
        count: fmtNumber(mostBitten.bitten, locale),
      }),
    );
  }
  const topFisher = players.filter((p) => p.fishCaught > 0).sort((a, b) => b.fishCaught - a.fishCaught)[0];
  if (topFisher) {
    funLines.push(
      _tp(locale, 'fun_top_angler', {
        name: topFisher.name,
        count: fmtNumber(topFisher.fishCaught, locale),
      }),
    );
  }
  const topPvP = players.filter((p) => p.pvpKills > 0).sort((a, b) => b.pvpKills - a.pvpKills)[0];
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
    const topKillersArr = ws['topKillers'];
    const wk = Array.isArray(topKillersArr) ? (topKillersArr[0] as Record<string, unknown> | undefined) : undefined;
    if (wk) {
      weekLines.push(
        _tp(locale, 'week_top_killer', {
          name: typeof wk['name'] === 'string' ? wk['name'] : '',
          kills: fmtNumber(Number(wk['kills'] ?? 0), locale),
        }),
      );
    }
    const topPtArr = ws['topPlaytime'];
    const wp = Array.isArray(topPtArr) ? (topPtArr[0] as Record<string, unknown> | undefined) : undefined;
    if (wp)
      weekLines.push(
        _tp(locale, 'week_most_active', {
          name: typeof wp['name'] === 'string' ? wp['name'] : '',
          playtime: _fmtTime(Number(wp['ms'] ?? 0), locale),
        }),
      );
    const newPlayers = Number(ws['newPlayers'] ?? 0);
    if (newPlayers > 0) {
      weekLines.push(
        _tp(locale, 'week_new_players', {
          count: fmtNumber(newPlayers, locale),
          plural_suffix: newPlayers > 1 ? 's' : '',
        }),
      );
    }
    if (weekLines.length > 0)
      embed.addFields({ name: _tp(locale, 'this_week'), value: weekLines.join('\n'), inline: true });
  }

  // Last save update
  if (this._lastSaveUpdate) {
    const ago = Math.round((Date.now() - this._lastSaveUpdate.getTime()) / 60000);
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
function _buildRoster(this: PSCThis): Map<string, RosterPlayer> {
  const now = Date.now();
  if (this._cachedRoster && this._rosterCacheTime && now - this._rosterCacheTime < 5000) {
    return this._cachedRoster;
  }

  const allLog = this._playerStats.getAllPlayers();
  const sessions = this._playtime.getActiveSessions();
  const ptLeaderboard = this._playtime.getLeaderboard();

  const onlineNames = new Set(Object.keys(sessions));
  const recentMs = 10 * 60000;
  for (const s of allLog) {
    const lastEvent = s['lastEvent'];
    const sName = s['name'];
    if (
      lastEvent &&
      typeof lastEvent === 'string' &&
      now - new Date(lastEvent).getTime() < recentMs &&
      typeof sName === 'string'
    ) {
      onlineNames.add(sName);
    }
  }

  const roster = new Map<string, RosterPlayer>();

  // Save data players (richest source)
  for (const [sid, sd] of this._saveData.entries()) {
    const at = this.getAllTimeKills(sid);
    const sdName = typeof sd['name'] === 'string' ? sd['name'] : sid;
    roster.set(sid, {
      name: sdName,
      kills: at?.zeeksKilled ?? 0,
      deaths: 0,
      fishCaught: typeof sd['fishCaught'] === 'number' ? sd['fishCaught'] : 0,
      daysSurvived: typeof sd['daysSurvived'] === 'number' ? sd['daysSurvived'] : 0,
      bitten: typeof sd['timesBitten'] === 'number' ? sd['timesBitten'] : 0,
      pvpKills: 0,
      playtime: 0,
      online: onlineNames.has(sdName),
    });
  }

  // Merge log data
  for (const stats of allLog) {
    const sid = stats['id'] ?? stats['name'];
    if (typeof sid !== 'string') continue;
    const existing = roster.get(sid);
    const statsDeaths = typeof stats['deaths'] === 'number' ? stats['deaths'] : 0;
    const statsPvpKills = typeof stats['pvpKills'] === 'number' ? stats['pvpKills'] : 0;
    const statsName = typeof stats['name'] === 'string' ? stats['name'] : sid;
    if (existing) {
      existing.deaths = Math.max(existing.deaths, statsDeaths);
      existing.pvpKills = Math.max(existing.pvpKills, statsPvpKills);
    } else {
      roster.set(sid, {
        name: statsName,
        kills: 0,
        deaths: statsDeaths,
        fishCaught: 0,
        daysSurvived: 0,
        bitten: 0,
        pvpKills: statsPvpKills,
        playtime: 0,
        online: onlineNames.has(statsName),
      });
    }
  }

  // Merge playtime
  for (const entry of ptLeaderboard) {
    const existing = roster.get(entry.id);
    if (existing) {
      existing.playtime = entry.totalMs;
    } else {
      for (const [, r] of roster) {
        if (r.name === entry.name) {
          r.playtime = entry.totalMs;
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

function _buildPlayerRow(this: PSCThis): unknown[] {
  const locale = getLocale({ serverConfig: this._config });
  const roster = this._buildRoster();
  const players = Array.from(roster.entries()).map(([sid, p]) => ({ steamId: sid, ...p }));

  players.sort((a, b) => {
    if (a.online !== b.online) return a.online ? -1 : 1;
    if (b.kills !== a.kills) return b.kills - a.kills;
    return a.name.localeCompare(b.name);
  });

  const options = players.slice(0, 25).map((p) => {
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

function _buildClanRow(this: PSCThis): unknown[] {
  const locale = getLocale({ serverConfig: this._config });
  if (this._clanData.length === 0) return [];

  const options = [];
  for (const clan of this._clanData) {
    if (!clan.name) continue;
    const memberCount = clan.members.length;
    let totalKills = 0;
    for (const m of clan.members) {
      const sid = m.steamId ?? m.steam_id;
      if (sid) {
        const at = this.getAllTimeKills(sid);
        totalKills += at?.zeeksKilled ?? 0;
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

function buildClanEmbed(this: PSCThis, clanName: string): EmbedBuilder | null {
  const clan = Array.isArray(this._clanData) ? this._clanData.find((c) => c.name === clanName) : undefined;
  if (!clan) return null;

  const locale = getLocale({ serverConfig: this._config });

  const embed = new EmbedBuilder()
    .setTitle(_tp(locale, 'clan_title', { clan_name: clanName }))
    .setColor(0xe67e22)
    .setTimestamp();

  const members = clan.members;
  const sessions = this._playtime.getActiveSessions();
  const allLog = this._playerStats.getAllPlayers();

  let totalKills = 0,
    totalDeaths = 0,
    bestDays = 0,
    totalPtMs = 0;
  const memberLines = [];

  for (const m of members) {
    const sid = m.steamId ?? m.steam_id;
    const name = m.name ?? sid;
    const save = sid ? this._saveData.get(sid) : null;
    const at = sid ? this.getAllTimeKills(sid) : null;
    const kills = at?.zeeksKilled ?? 0;
    const logEntry = sid ? allLog.find((l) => l['id'] === sid) : null;
    const deaths = logEntry && typeof logEntry['deaths'] === 'number' ? logEntry['deaths'] : 0;
    const days = save && typeof save['daysSurvived'] === 'number' ? save['daysSurvived'] : 0;
    const pt = sid ? this._playtime.getPlaytime(sid) : null;
    const ptMs = pt?.totalMs ?? 0;
    const nameStr = name ?? '';
    const online = !!sessions[nameStr];

    totalKills += kills;
    totalDeaths += deaths;
    bestDays = Math.max(bestDays, days);
    totalPtMs += ptMs;

    const status = online ? '\uD83D\uDFE2' : '\u26AB';
    const role = (m.canKick ?? m.can_kick) ? ' \uD83D\uDC51' : '';
    memberLines.push(
      _tp(locale, 'clan_member_line', {
        status,
        role,
        name: nameStr,
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
    const sid = m.steamId ?? m.steam_id;
    const name = m.name ?? sid;
    const nameStr = name ?? '';
    const logEntry = allLog.find((l) => l['id'] === sid || l['name'] === nameStr);
    const lastEvent = logEntry?.['lastEvent'];
    if (lastEvent && typeof lastEvent === 'string') {
      const d = new Date(lastEvent);
      const dateStr = fmtDate(d, locale);
      activityLines.push(`${nameStr}: ${dateStr}`);
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

function buildFullPlayerEmbed(this: PSCThis, steamId: string, { isAdmin = false } = {}): EmbedBuilder {
  const resolved = this._resolvePlayer(steamId);
  const log = resolved.log;
  const save = resolved.save;
  const pt = resolved.playtime;
  const locale = getLocale({ serverConfig: this._config });

  const serverTag = this._config.serverName ? ` [${this._config.serverName}]` : '';
  const embed = new EmbedBuilder().setColor(0x5865f2).setTimestamp();

  // Random loading tip for footer
  const tips = gameData.LOADING_TIPS.filter((tip: string) => tip.length > 20 && tip.length < 120);
  const tip = tips.length > 0 ? tips[Math.floor(Math.random() * tips.length)] : null;
  embed.setFooter({ text: tip ? `\uD83D\uDCA1 ${tip}` : _tp(locale, 'player_stats_footer') });

  // ┌──────────────────────────────────────────────────────────────┐
  // │  1. IDENTITY — Title + Description                          │
  // └──────────────────────────────────────────────────────────────┘

  const titleParts = [resolved.name];
  const startingPerk = save?.['startingPerk'];
  const startingPerkStr = typeof startingPerk === 'string' ? startingPerk : '';
  if (startingPerkStr && startingPerkStr !== 'Unknown') {
    titleParts.push(`\u00B7 ${startingPerkStr}`);
  }
  embed.setTitle(`${titleParts.join(' ')}${serverTag}`);

  const desc = [];

  // Profession perk description
  if (startingPerkStr) {
    const prof = gameData.PROFESSION_DETAILS[startingPerkStr] as { perk?: string } | undefined;
    if (prof?.perk) desc.push(`> *${prof.perk}*`);
  }

  // Level + XP progress + Skill points + Gender
  const identityBits = [];
  if (save) {
    const male = save['male'];
    identityBits.push(male ? '\u2642' : '\u2640');
    const level = typeof save['level'] === 'number' ? save['level'] : 0;
    if (level > 0) identityBits.push(_tp(locale, 'level_short', { level: fmtNumber(level, locale) }));
    const expCurrent = typeof save['expCurrent'] === 'number' ? save['expCurrent'] : null;
    const expRequired = typeof save['expRequired'] === 'number' ? save['expRequired'] : 0;
    if (expCurrent != null && expRequired > 0) {
      identityBits.push(
        _tp(locale, 'xp_progress', {
          bar: _bar(expCurrent, expRequired),
          percent: _pct(expCurrent, expRequired),
        }),
      );
    } else {
      const exp = typeof save['exp'] === 'number' ? save['exp'] : 0;
      if (exp > 0) {
        identityBits.push(_tp(locale, 'xp_amount', { xp: fmtNumber(Math.round(exp), locale) }));
      }
    }
    const skillPoints = typeof save['skillPoints'] === 'number' ? save['skillPoints'] : 0;
    if (skillPoints > 0) {
      identityBits.push(_tp(locale, 'skill_points', { points: fmtNumber(skillPoints, locale) }));
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
  if (pt?.sessions && pt.sessions > 0) {
    metaBits.push(
      _tp(locale, 'session_count', {
        count: fmtNumber(pt.sessions, locale),
        plural_suffix: pt.sessions !== 1 ? 's' : '',
      }),
    );
  }
  if (metaBits.length > 0) desc.push(metaBits.join(' \u00B7 '));

  // Affliction warning
  if (save) {
    const affliction = save['affliction'];
    if (typeof affliction === 'number' && affliction > 0 && affliction < gameData.AFFLICTION_MAP.length) {
      desc.push(`\u26A0\uFE0F **${gameData.AFFLICTION_MAP[affliction]}**`);
    }
  }

  // Name history (compact)
  const nameHistory = log?.['nameHistory'];
  if (Array.isArray(nameHistory) && nameHistory.length > 0) {
    desc.push(
      _tp(locale, 'aka_names', {
        names: nameHistory
          .map((h: unknown) => {
            const n = (h as Record<string, unknown>)['name'];
            return typeof n === 'string' ? n : '';
          })
          .join(', '),
      }),
    );
  }

  if (desc.length > 0) embed.setDescription(desc.join('\n'));

  // ┌──────────────────────────────────────────────────────────────┐
  // │  2. COMBAT & SURVIVAL — The core stats                      │
  // └──────────────────────────────────────────────────────────────┘

  if (save) {
    const at = this.getAllTimeKills(steamId);
    const cl = this.getCurrentLifeKills(steamId);
    const hasExt = save['hasExtendedStats'];

    const killTypes: [string, string, keyof NonNullable<typeof at>][] = [
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
      const allTime = at?.[key] ?? 0;
      const life = cl?.[key] ?? 0;
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
    const daysSurvived = typeof save['daysSurvived'] === 'number' ? save['daysSurvived'] : 0;
    if (daysSurvived > 0) {
      const atSurv = this.getAllTimeSurvival(steamId);
      if (atSurv?.daysSurvived && atSurv.daysSurvived > daysSurvived) {
        survLines.push(
          _tp(locale, 'survived_with_best', {
            days: fmtNumber(daysSurvived, locale),
            best_days: fmtNumber(atSurv.daysSurvived, locale),
          }),
        );
      } else {
        survLines.push(_tp(locale, 'survived_line', { days: fmtNumber(daysSurvived, locale) }));
      }
    }
    if (log) {
      const deaths = typeof log['deaths'] === 'number' ? log['deaths'] : 0;
      survLines.push(_tp(locale, 'deaths_line', { count: fmtNumber(deaths, locale) }));
    }
    const timesBitten = typeof save['timesBitten'] === 'number' ? save['timesBitten'] : 0;
    if (timesBitten > 0) {
      survLines.push(_tp(locale, 'bitten_line', { count: fmtNumber(timesBitten, locale) }));
    }
    const fishCaught = typeof save['fishCaught'] === 'number' ? save['fishCaught'] : 0;
    if (fishCaught > 0) {
      const fishCaughtPike = typeof save['fishCaughtPike'] === 'number' ? save['fishCaughtPike'] : 0;
      const pike =
        fishCaughtPike > 0 ? _tp(locale, 'fish_pike_suffix', { count: fmtNumber(fishCaughtPike, locale) }) : '';
      survLines.push(
        _tp(locale, 'fish_line', {
          count: fmtNumber(fishCaught, locale),
          pike_suffix: pike,
        }),
      );
    }

    const combatValue = [...killLines, ...survLines].join('\n');
    if (combatValue) {
      embed.addFields({ name: _tp(locale, 'combat_survival'), value: combatValue });
    }
  } else if (log) {
    const deaths = typeof log['deaths'] === 'number' ? log['deaths'] : 0;
    embed.addFields({
      name: _tp(locale, 'combat'),
      value: _tp(locale, 'deaths_line', { count: fmtNumber(deaths, locale) }),
    });
  }

  // PvP (inline)
  if (log) {
    const pvpKills = typeof log['pvpKills'] === 'number' ? log['pvpKills'] : 0;
    const pvpDeaths = typeof log['pvpDeaths'] === 'number' ? log['pvpDeaths'] : 0;
    if (pvpKills > 0 || pvpDeaths > 0) {
      const p = [];
      if (pvpKills > 0) p.push(_tp(locale, 'pvp_kills_line', { count: fmtNumber(pvpKills, locale) }));
      if (pvpDeaths > 0) p.push(_tp(locale, 'pvp_deaths_line', { count: fmtNumber(pvpDeaths, locale) }));
      const kd = pvpDeaths > 0 ? (pvpKills / pvpDeaths).toFixed(2) : pvpKills > 0 ? '\u221E' : '0';
      p.push(_tp(locale, 'pvp_kd_line', { kd }));
      embed.addFields({ name: _tp(locale, 'pvp'), value: p.join(' \u00B7 '), inline: true });
    }
  }

  // ┌──────────────────────────────────────────────────────────────┐
  // │  3. VITALS — Health bars + status effects                   │
  // └──────────────────────────────────────────────────────────────┘

  if (this._config.canShow('showVitals', isAdmin) && save) {
    const vitals = [];
    const health = typeof save['health'] === 'number' ? save['health'] : 0;
    const maxHealth = typeof save['maxHealth'] === 'number' ? save['maxHealth'] : 100;
    const hunger = typeof save['hunger'] === 'number' ? save['hunger'] : 0;
    const maxHunger = typeof save['maxHunger'] === 'number' ? save['maxHunger'] : 100;
    const thirst = typeof save['thirst'] === 'number' ? save['thirst'] : 0;
    const maxThirst = typeof save['maxThirst'] === 'number' ? save['maxThirst'] : 100;
    const stamina = typeof save['stamina'] === 'number' ? save['stamina'] : 0;
    const maxStamina = typeof save['maxStamina'] === 'number' ? save['maxStamina'] : 100;
    const infection = typeof save['infection'] === 'number' ? save['infection'] : 0;
    const maxInfection = typeof save['maxInfection'] === 'number' ? save['maxInfection'] : 100;
    const battery = typeof save['battery'] === 'number' ? save['battery'] : 0;
    const energy = typeof save['energy'] === 'number' ? save['energy'] : 0;
    const wellRested = save['wellRested'];

    if (this._config.showHealth)
      vitals.push(`\u2764\uFE0F \`${_bar(health, maxHealth || 100)}\` ${_pct(health, maxHealth || 100)}`);
    if (this._config.showHunger)
      vitals.push(`\uD83C\uDF56 \`${_bar(hunger, maxHunger || 100)}\` ${_pct(hunger, maxHunger || 100)}`);
    if (this._config.showThirst)
      vitals.push(`\uD83D\uDCA7 \`${_bar(thirst, maxThirst || 100)}\` ${_pct(thirst, maxThirst || 100)}`);
    if (this._config.showStamina)
      vitals.push(`\u26A1 \`${_bar(stamina, maxStamina || 100)}\` ${_pct(stamina, maxStamina || 100)}`);
    if (this._config.showImmunity)
      vitals.push(
        `\uD83D\uDEE1\uFE0F \`${_bar(infection, maxInfection || 100)}\` ${_pct(infection, maxInfection || 100)}`,
      );
    if (this._config.showBattery && battery > 0 && battery < 100)
      vitals.push(`\uD83D\uDD0B \`${_bar(battery, 100)}\` ${_pct(battery, 100)}`);
    if (energy > 0) {
      vitals.push(
        _tp(locale, 'energy_line', {
          bar: _bar(energy, 100),
          percent: _pct(energy, 100),
        }),
      );
    }
    if (wellRested) vitals.push(_tp(locale, 'well_rested'));

    // Status effects (compact single line)
    if (this._config.canShow('showStatusEffects', isAdmin)) {
      const statuses = [];
      const playerStates = save['playerStates'];
      if (Array.isArray(playerStates) && playerStates.length > 0) {
        for (const s of playerStates) {
          if (typeof s !== 'string') continue;
          const cleaned = _clean(s.replace('States.Player.', ''));
          if (cleaned) statuses.push(cleaned);
        }
      }
      const bodyConditions = save['bodyConditions'];
      if (Array.isArray(bodyConditions) && bodyConditions.length > 0) {
        for (const s of bodyConditions) {
          if (typeof s !== 'string') continue;
          const cleaned = _clean(s.replace('Attributes.Health.', ''));
          if (cleaned) statuses.push(cleaned);
        }
      }
      const infectionBuildup = typeof save['infectionBuildup'] === 'number' ? save['infectionBuildup'] : 0;
      if (infectionBuildup > 0) {
        statuses.push(_tp(locale, 'infection_status', { percent: fmtNumber(infectionBuildup, locale) }));
      }
      const fatigue = typeof save['fatigue'] === 'number' ? save['fatigue'] : 0;
      if (fatigue > 0.5) statuses.push(_tp(locale, 'fatigued_status'));
      if (statuses.length > 0) vitals.push(_tp(locale, 'status_line', { statuses: statuses.join(', ') }));
    }

    if (vitals.length > 0) embed.addFields({ name: _tp(locale, 'vitals'), value: vitals.join('\n') });
  }

  // ┌──────────────────────────────────────────────────────────────┐
  // │  4. GEAR — Equipment + Quick Slots (compact)                │
  // └──────────────────────────────────────────────────────────────┘

  if (this._config.canShow('showInventory', isAdmin) && save) {
    type ItemEntry = Record<string, unknown>;
    const notEmpty = (i: unknown): i is ItemEntry => {
      const item = (i as ItemEntry | null)?.['item'];
      const itemStr = typeof item === 'string' ? item : '';
      return !!item && !/^empty$/i.test(itemStr) && !/^empty$/i.test(_clean(item));
    };
    const fmtItem = (i: ItemEntry): string => {
      const name = _clean(i['item']);
      if (!name) return '';
      const amount = typeof i['amount'] === 'number' ? i['amount'] : 1;
      const amt = amount > 1 ? ` \u00D7${amount}` : '';
      return `${name}${amt}`;
    };

    const sections = [];

    if (this._config.showEquipment) {
      const equipment = save['equipment'];
      const equip = (Array.isArray(equipment) ? equipment : []).filter(notEmpty);
      if (equip.length > 0) {
        sections.push(_tp(locale, 'inventory_equipped', { items: equip.map(fmtItem).filter(Boolean).join(', ') }));
      }
    }
    if (this._config.showQuickSlots) {
      const quickSlots = save['quickSlots'];
      const quick = (Array.isArray(quickSlots) ? quickSlots : []).filter(notEmpty);
      if (quick.length > 0) {
        sections.push(_tp(locale, 'inventory_quick', { items: quick.map(fmtItem).filter(Boolean).join(', ') }));
      }
    }
    if (this._config.showPockets) {
      const inventory = save['inventory'];
      const pockets = (Array.isArray(inventory) ? inventory : []).filter(notEmpty);
      if (pockets.length > 0) {
        if (pockets.length <= 6) {
          sections.push(_tp(locale, 'inventory_pockets', { items: pockets.map(fmtItem).filter(Boolean).join(', ') }));
        } else {
          sections.push(_tp(locale, 'inventory_pockets_count', { count: fmtNumber(pockets.length, locale) }));
        }
      }
    }
    if (this._config.showBackpack) {
      const backpackItems = save['backpackItems'];
      const bp = (Array.isArray(backpackItems) ? backpackItems : []).filter(notEmpty);
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
    const damageTaken = log['damageTaken'];
    if (damageTaken && typeof damageTaken === 'object') {
      const dmgEntries = Object.entries(damageTaken as Record<string, number>);
      if (dmgEntries.length > 0) {
        const sorted = dmgEntries.sort((a, b) => b[1] - a[1]);
        const total = sorted.reduce((s, [, c]) => s + c, 0);
        const lines = sorted.slice(0, 4).map(([src, c]) => `${src}: **${fmtNumber(c, locale)}**`);
        if (sorted.length > 4) {
          lines.push(_tp(locale, 'list_more_count', { count: fmtNumber(sorted.length - 4, locale) }));
        }
        embed.addFields({
          name: _tp(locale, 'damage', { total: fmtNumber(total, locale) }),
          value: lines.join('\n'),
          inline: true,
        });
      }
    }

    const killedBy = log['killedBy'];
    if (killedBy && typeof killedBy === 'object') {
      const killEntries = Object.entries(killedBy as Record<string, number>);
      if (killEntries.length > 0) {
        const sorted = killEntries.sort((a, b) => b[1] - a[1]);
        const lines = sorted.slice(0, 4).map(([src, c]) => `${src}: **${fmtNumber(c, locale)}**`);
        if (sorted.length > 4) {
          lines.push(_tp(locale, 'list_more_count', { count: fmtNumber(sorted.length - 4, locale) }));
        }
        embed.addFields({ name: _tp(locale, 'killed_by'), value: lines.join('\n'), inline: true });
      }
    }
  }

  // ┌──────────────────────────────────────────────────────────────┐
  // │  6. BASE ACTIVITY (compact inline)                          │
  // └──────────────────────────────────────────────────────────────┘

  if (log) {
    const parts = [];
    const builds = typeof log['builds'] === 'number' ? log['builds'] : 0;
    const containersLooted = typeof log['containersLooted'] === 'number' ? log['containersLooted'] : 0;
    const raidsOut = typeof log['raidsOut'] === 'number' ? log['raidsOut'] : 0;
    const raidsIn = typeof log['raidsIn'] === 'number' ? log['raidsIn'] : 0;
    if (builds > 0) parts.push(_tp(locale, 'base_built', { count: fmtNumber(builds, locale) }));
    if (containersLooted > 0) parts.push(_tp(locale, 'base_looted', { count: fmtNumber(containersLooted, locale) }));
    if (this._config.canShow('showRaidStats', isAdmin)) {
      if (raidsOut > 0) parts.push(_tp(locale, 'base_raids', { count: fmtNumber(raidsOut, locale) }));
      if (raidsIn > 0) parts.push(_tp(locale, 'base_raided', { count: fmtNumber(raidsIn, locale) }));
    }
    if (parts.length > 0) {
      embed.addFields({ name: _tp(locale, 'base'), value: parts.join(' \u00B7 '), inline: true });
    }
  }

  // ┌──────────────────────────────────────────────────────────────┐
  // │  7. PROGRESSION — Professions, Challenges (compact)         │
  // └──────────────────────────────────────────────────────────────┘

  // Unlocked professions
  const unlockedProfessions = save?.['unlockedProfessions'];
  if (Array.isArray(unlockedProfessions) && unlockedProfessions.length > 1) {
    const profNames = unlockedProfessions
      .filter((p): p is string => typeof p === 'string')
      .map((p) => PERK_MAP[p] ?? _clean(p))
      .filter(Boolean);
    if (profNames.length > 0) {
      embed.addFields({ name: _tp(locale, 'professions'), value: profNames.join(', '), inline: true });
    }
  }

  // Skill tree — unlocked skills per category
  if (save) {
    const skillsData = save['skillsData'] ?? save['skillTree'];
    const tree = _parseSkillTree(skillsData);
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
        const emoji = catEmoji[cat] ?? '\u2B50';
        const bar = `\`${_bar(info.unlocked, info.total)}\``;
        const names = info.names.length > 0 ? _tp(locale, 'skills_names_suffix', { names: info.names.join(', ') }) : '';
        lines.push(
          _tp(locale, 'skills_line', {
            emoji,
            category: catLabel[cat] ?? cat,
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
  if (save?.['hasExtendedStats']) {
    const descs = gameData.CHALLENGE_DESCRIPTIONS as Record<string, { name?: string; target?: number }>;
    type ChallengeEntry = [string, number];
    const entries: ChallengeEntry[] = (
      [
        ['challengeKillZombies', save['challengeKillZombies']],
        ['challengeKill50', save['challengeKill50']],
        ['challengeCatch20Fish', save['challengeCatch20Fish']],
        ['challengeRegularAngler', save['challengeRegularAngler']],
        ['challengeKillZombieBear', save['challengeKillZombieBear']],
        ['challenge9Squares', save['challenge9Squares']],
        ['challengeCraftFirearm', save['challengeCraftFirearm']],
        ['challengeCraftFurnace', save['challengeCraftFurnace']],
        ['challengeCraftMeleeBench', save['challengeCraftMeleeBench']],
        ['challengeCraftMeleeWeapon', save['challengeCraftMeleeWeapon']],
        ['challengeCraftRainCollector', save['challengeCraftRainCollector']],
        ['challengeCraftTablesaw', save['challengeCraftTablesaw']],
        ['challengeCraftTreatment', save['challengeCraftTreatment']],
        ['challengeCraftWeaponsBench', save['challengeCraftWeaponsBench']],
        ['challengeCraftWorkbench', save['challengeCraftWorkbench']],
        ['challengeFindDog', save['challengeFindDog']],
        ['challengeFindHeli', save['challengeFindHeli']],
        ['challengeLockpickSUV', save['challengeLockpickSUV']],
        ['challengeRepairRadio', save['challengeRepairRadio']],
      ] satisfies [string, unknown][]
    ).filter((pair): pair is ChallengeEntry => typeof pair[1] === 'number' && pair[1] > 0);

    if (entries.length > 0) {
      const completed: string[] = [];
      const inProgress: string[] = [];
      for (const [key, val] of entries) {
        const info = descs[key];
        const target = info?.target ?? 1;
        if (val >= target) {
          completed.push(info?.name ?? key);
        } else {
          inProgress.push(`${info?.name ?? key} (${String(val)}/${String(target)})`);
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
    const questSpawnerDone = save['questSpawnerDone'];
    const doneQuests = Array.isArray(questSpawnerDone) ? questSpawnerDone.filter(Boolean) : [];
    if (doneQuests.length > 0) {
      questBits.push(
        _tp(locale, 'quests_completed', {
          count: fmtNumber(doneQuests.length, locale),
          plural_suffix: doneQuests.length !== 1 ? 's' : '',
        }),
      );
    }
    const miniQuestRaw = save['miniQuest'];
    const mq =
      typeof miniQuestRaw === 'string'
        ? (() => {
            try {
              return JSON.parse(miniQuestRaw) as Record<string, unknown>;
            } catch {
              return null;
            }
          })()
        : ((miniQuestRaw as Record<string, unknown> | null | undefined) ?? null);
    if (mq && typeof mq === 'object') {
      const rawQuestId = mq['QuestID'] ?? mq['questID'] ?? mq['ID'];
      const questId = typeof rawQuestId === 'string' ? rawQuestId : '';
      const active = mq['Active'] ?? mq['active'];
      if (active && questId) {
        const questDataEntry = gameData.QUEST_DATA[questId];
        const rawQuestName = questDataEntry?.['name'];
        const questName =
          (typeof rawQuestName === 'string' ? rawQuestName : null) ?? (_clean(questId) || _tp(locale, 'active_quest'));
        questBits.push(`\uD83D\uDCCB ${questName}`);
      }
    }
    if (questBits.length > 0) {
      embed.addFields({ name: _tp(locale, 'quests'), value: questBits.join(' \u00B7 '), inline: true });
    }
  }

  // Recipes — counts only
  if (this._config.canShow('showRecipes', isAdmin) && save) {
    const craftingRecipes = save['craftingRecipes'];
    const buildingRecipes = save['buildingRecipes'];
    const craft = Array.isArray(craftingRecipes) ? craftingRecipes.length : 0;
    const build = Array.isArray(buildingRecipes) ? buildingRecipes.length : 0;
    if (craft > 0 || build > 0) {
      const parts = [];
      if (craft > 0) parts.push(_tp(locale, 'recipes_crafting', { count: fmtNumber(craft, locale) }));
      if (build > 0) parts.push(_tp(locale, 'recipes_building', { count: fmtNumber(build, locale) }));
      embed.addFields({ name: _tp(locale, 'recipes'), value: parts.join(' \u00B7 '), inline: true });
    }
  }

  // Collections — lore + unique items (names when available)
  const extraBits = [];
  const lore = save?.['lore'];
  if (this._config.canShow('showLore', isAdmin) && Array.isArray(lore) && lore.length > 0) {
    extraBits.push(_tp(locale, 'collections_lore', { count: fmtNumber(lore.length, locale) }));
  }
  if (save) {
    const lootItemUnique = save['lootItemUnique'];
    const craftedUniques = save['craftedUniques'];
    const foundItems = cleanItemArray(Array.isArray(lootItemUnique) ? lootItemUnique : []);
    const craftedItems = cleanItemArray(Array.isArray(craftedUniques) ? craftedUniques : []);
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
    const connects = typeof log['connects'] === 'number' ? log['connects'] : 0;
    const disconnects = typeof log['disconnects'] === 'number' ? log['disconnects'] : 0;
    const adminAccess = typeof log['adminAccess'] === 'number' ? log['adminAccess'] : 0;
    if (connects > 0) conn.push(_tp(locale, 'connections_joins', { count: fmtNumber(connects, locale) }));
    if (disconnects > 0) conn.push(_tp(locale, 'connections_leaves', { count: fmtNumber(disconnects, locale) }));
    if (adminAccess > 0) conn.push(_tp(locale, 'connections_admin', { count: fmtNumber(adminAccess, locale) }));
    if (conn.length > 0) metaLines.push(conn.join(' \u00B7 '));
  }
  if (metaLines.length > 0) {
    embed.addFields({ name: _tp(locale, 'activity'), value: metaLines.join('\n'), inline: true });
  }

  // Location (admin-gated)
  if (this._config.canShow('showCoordinates', isAdmin) && save) {
    const x = typeof save['x'] === 'number' ? save['x'] : null;
    const y = typeof save['y'] === 'number' ? save['y'] : null;
    const z = typeof save['z'] === 'number' ? save['z'] : null;
    if (x != null && x !== 0) {
      embed.addFields({
        name: _tp(locale, 'location'),
        value: `${Math.round(x)}, ${Math.round(y ?? 0)}, ${Math.round(z ?? 0)}`,
        inline: true,
      });
    }
  }

  // Horses + Companions
  if (this._config.canShow('showHorses', isAdmin) && save) {
    const lines = [];
    const horses = save['horses'];
    if (Array.isArray(horses) && horses.length > 0) {
      for (const h of horses as Record<string, unknown>[]) {
        const hClass = h['class'];
        const name = _clean(h['displayName'] ?? h['name'] ?? (hClass != null ? hClass : _tp(locale, 'horse_fallback')));
        const hHealth = typeof h['health'] === 'number' ? h['health'] : null;
        const hMaxHealth = typeof h['maxHealth'] === 'number' ? h['maxHealth'] : 0;
        const hp =
          hHealth != null && hMaxHealth > 0
            ? _tp(locale, 'animals_hp_suffix', {
                health: fmtNumber(Math.round(hHealth), locale),
                max_health: fmtNumber(Math.round(hMaxHealth), locale),
              })
            : '';
        lines.push(`\uD83D\uDC34 **${name}**${hp}`);
      }
    }
    const companionData = save['companionData'];
    if (Array.isArray(companionData) && companionData.length > 0) {
      for (const c of companionData as Record<string, unknown>[]) {
        const cClass = c['class'];
        const name = _clean(
          c['displayName'] ?? c['name'] ?? (cClass != null ? cClass : _tp(locale, 'companion_fallback')),
        );
        const bits = [];
        const cHealth = typeof c['health'] === 'number' ? c['health'] : null;
        const cEnergy = typeof c['energy'] === 'number' ? c['energy'] : 0;
        const cVest = typeof c['vest'] === 'number' ? c['vest'] : 0;
        if (cHealth != null) bits.push(_tp(locale, 'animals_hp', { hp: fmtNumber(Math.round(cHealth), locale) }));
        if (cEnergy > 0) bits.push(_tp(locale, 'animals_energy', { energy: fmtNumber(Math.round(cEnergy), locale) }));
        if (c['command']) bits.push(_clean(c['command']));
        if (cVest > 0) bits.push(_tp(locale, 'animals_vest'));
        const detail = bits.length > 0 ? ` \u2014 ${bits.join(' \u00B7 ')}` : '';
        lines.push(`\uD83D\uDC15 **${name}**${detail}`);
      }
    }
    if (lines.length > 0) {
      embed.addFields({ name: _tp(locale, 'animals'), value: lines.join('\n').substring(0, 1024) });
    }
  }

  // Anti-cheat flags (admin only)
  if (isAdmin && log) {
    const cheatFlags = log['cheatFlags'];
    if (Array.isArray(cheatFlags) && cheatFlags.length > 0) {
      const flags = cheatFlags.slice(-3) as Record<string, unknown>[];
      const lines = flags.map((f) => {
        const ts = f['timestamp'];
        const d = new Date(typeof ts === 'string' ? ts : 0);
        const flagType = f['type'];
        return `${fmtDate(d, locale)} \u2014 \`${typeof flagType === 'string' ? flagType : ''}\``;
      });
      if (cheatFlags.length > 3) {
        lines.unshift(_tp(locale, 'ac_flags_total', { count: fmtNumber(cheatFlags.length, locale) }));
      }
      embed.addFields({ name: _tp(locale, 'ac_flags'), value: lines.join('\n'), inline: true });
    }
  }

  return embed;
}

// ─── Exports ─────────────────────────────────────────────────────────

export { _buildOverviewEmbed, _buildRoster, _buildPlayerRow, _buildClanRow, buildClanEmbed, buildFullPlayerEmbed };

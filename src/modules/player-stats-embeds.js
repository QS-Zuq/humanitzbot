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

'use strict';

const { EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder } = require('discord.js');
const { PERK_MAP } = require('../parsers/save-parser');
const gameData = require('../parsers/game-data');
const { cleanItemName: _rawClean, cleanItemArray, isHexGuid } = require('../parsers/ue4-names');
const {
  buildScheduleField,
} = require('../server/server-display');

// ─── Helpers ─────────────────────────────────────────────────────────

/** Clean a UE4 item name; returns '' for junk/null/hex GUIDs. */
function _clean(name) {
  if (!name) return '';
  if (typeof name === 'string' && isHexGuid(name)) return '';
  const c = _rawClean(name);
  return c === 'Unknown' ? '' : c;
}

/** Format milliseconds → "12h 34m" or "34m". */
function _fmtTime(ms) {
  if (!ms || ms <= 0) return '0m';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** Percentage bar — 10 chars wide. */
function _bar(value, max) {
  const pct = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  const filled = Math.round(pct * 10);
  return '\u2588'.repeat(filled) + '\u2591'.repeat(10 - filled);
}

/** Percentage string. */
function _pct(value, max) {
  if (!max || max <= 0) return '0%';
  return `${Math.round(Math.max(0, Math.min(100, (value / max) * 100)))}%`;
}

/** Medal array for leaderboards. */
const MEDALS = ['\u{1F947}', '\u{1F948}', '\u{1F949}', '4\uFE0F\u20E3', '5\uFE0F\u20E3'];


// ═════════════════════════════════════════════════════════════════════
//  _buildOverviewEmbed — Persistent channel embed
//
//  Layout priority:
//    1. Dynamic difficulty schedule  (THE selling point)
//    2. Server quick stats           (players, world state)
//    3. Leaderboards                 (kills, playtime, survival)
//    4. Weekly highlights
// ═════════════════════════════════════════════════════════════════════

function _buildOverviewEmbed() {
  const serverTag = this._config.serverName ? ` — ${this._config.serverName}` : '';
  const embed = new EmbedBuilder()
    .setTitle(`\uD83D\uDCCA Player Statistics${serverTag}`)
    .setColor(0x5865F2)
    .setTimestamp()
    .setFooter({ text: 'Select a player or clan below \u00B7 Last updated' });

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
  const players = Array.from(roster.values());
  const onlineCount = players.filter(p => p.online).length;
  const totalKills = players.reduce((s, p) => s + p.kills, 0);
  const totalDeaths = players.reduce((s, p) => s + p.deaths, 0);

  const descLines = [
    `\uD83D\uDC65 **${onlineCount}** online \u00B7 **${players.length}** total survivors`,
    `\uD83E\uDDDF **${totalKills.toLocaleString()}** zombie kills \u00B7 \uD83D\uDC80 **${totalDeaths}** deaths`,
  ];
  embed.setDescription(descLines.join('\n'));

  // ┌──────────────────────────────────────────────────────────────┐
  // │  3. LEADERBOARDS — Side by side                             │
  // └──────────────────────────────────────────────────────────────┘

  // Top Killers
  const topKillers = players.filter(p => p.kills > 0)
    .sort((a, b) => b.kills - a.kills).slice(0, 5);
  if (topKillers.length > 0) {
    const lines = topKillers.map((p, i) =>
      `${MEDALS[i]} **${p.name}** \u2014 ${p.kills.toLocaleString()}`);
    embed.addFields({ name: '\uD83E\uDDDF Top Killers', value: lines.join('\n'), inline: true });
  }

  // Top Playtime
  const topPlaytime = players.filter(p => p.playtime > 0)
    .sort((a, b) => b.playtime - a.playtime).slice(0, 5);
  if (topPlaytime.length > 0) {
    const lines = topPlaytime.map((p, i) =>
      `${MEDALS[i]} **${p.name}** \u2014 ${_fmtTime(p.playtime)}`);
    embed.addFields({ name: '\u23F1\uFE0F Most Active', value: lines.join('\n'), inline: true });
  }

  // Top Survivors
  const topSurvivors = players.filter(p => p.daysSurvived > 0)
    .sort((a, b) => b.daysSurvived - a.daysSurvived).slice(0, 5);
  if (topSurvivors.length > 0) {
    const lines = topSurvivors.map((p, i) =>
      `${MEDALS[i]} **${p.name}** \u2014 ${p.daysSurvived}d`);
    embed.addFields({ name: '\uD83D\uDCC5 Longest Survival', value: lines.join('\n'), inline: true });
  }

  // ┌──────────────────────────────────────────────────────────────┐
  // │  4. FUN STATS + WEEKLY                                      │
  // └──────────────────────────────────────────────────────────────┘

  const funLines = [];
  const mostBitten = players.filter(p => p.bitten > 0).sort((a, b) => b.bitten - a.bitten)[0];
  if (mostBitten) funLines.push(`\uD83E\uDDB7 Most bitten: **${mostBitten.name}** (${mostBitten.bitten}\u00D7)`);
  const topFisher = players.filter(p => p.fishCaught > 0).sort((a, b) => b.fishCaught - a.fishCaught)[0];
  if (topFisher) funLines.push(`\uD83D\uDC1F Top angler: **${topFisher.name}** (${topFisher.fishCaught})`);
  const topPvP = players.filter(p => p.pvpKills > 0).sort((a, b) => b.pvpKills - a.pvpKills)[0];
  if (topPvP) funLines.push(`\u2694\uFE0F PvP leader: **${topPvP.name}** (${topPvP.pvpKills})`);
  if (funLines.length > 0) embed.addFields({ name: '\uD83C\uDFB2 Fun Stats', value: funLines.join('\n'), inline: true });

  // Weekly highlights
  if (this._weeklyStats) {
    const ws = this._weeklyStats;
    const weekLines = [];
    const wk = ws.topKillers?.[0];
    if (wk) weekLines.push(`\uD83E\uDDDF **${wk.name}** \u2014 ${wk.kills} kills`);
    const wp = ws.topPlaytime?.[0];
    if (wp) weekLines.push(`\u23F1\uFE0F **${wp.name}** \u2014 ${_fmtTime(wp.ms)}`);
    if (ws.newPlayers > 0) weekLines.push(`\uD83C\uDD95 ${ws.newPlayers} new player${ws.newPlayers > 1 ? 's' : ''}`);
    if (weekLines.length > 0) embed.addFields({ name: '\uD83D\uDCC5 This Week', value: weekLines.join('\n'), inline: true });
  }

  // Last save update
  if (this._lastSaveUpdate) {
    const ago = Math.round((Date.now() - this._lastSaveUpdate) / 60000);
    if (ago >= 0) embed.addFields({ name: '\uD83D\uDCBE Last Save', value: `${ago}m ago`, inline: true });
  }

  return embed;
}

/**
 * Build merged roster Map<steamId, playerObj> from save + log + playtime.
 * Internal helper used by overview and select menus.
 */
function _buildRoster() {
  const allLog = this._playerStats.getAllPlayers();
  const sessions = this._playtime.getActiveSessions() || {};
  const ptLeaderboard = this._playtime.getLeaderboard();

  const onlineNames = new Set(Object.keys(sessions));
  const now = Date.now();
  const recentMs = 10 * 60000;
  for (const s of allLog) {
    if (s.lastEvent && (now - new Date(s.lastEvent).getTime()) < recentMs)
      onlineNames.add(s.name);
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
        kills: 0, deaths: stats.deaths || 0, fishCaught: 0, daysSurvived: 0,
        bitten: 0, pvpKills: stats.pvpKills || 0, playtime: 0,
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
        if (r.name === entry.name) { r.playtime = entry.totalMs || 0; break; }
      }
    }
  }

  return roster;
}


// ═════════════════════════════════════════════════════════════════════
//  _buildPlayerRow — Player select menu
// ═════════════════════════════════════════════════════════════════════

function _buildPlayerRow() {
  const roster = this._buildRoster();
  const players = Array.from(roster.entries()).map(([sid, p]) => ({ steamId: sid, ...p }));

  players.sort((a, b) => {
    if (a.online !== b.online) return a.online ? -1 : 1;
    if (b.kills !== a.kills) return b.kills - a.kills;
    return a.name.localeCompare(b.name);
  });

  const options = players.slice(0, 25).map(p => {
    const status = p.online ? '\uD83D\uDFE2 ' : '';
    const desc = `${p.kills} kills \u00B7 ${p.deaths} deaths \u00B7 ${p.daysSurvived}d survived`;
    return {
      label: `${status}${p.name}`.substring(0, 100),
      description: desc.substring(0, 100),
      value: p.steamId.substring(0, 100),
    };
  });

  if (options.length === 0) return [];

  return [new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`playerstats_player_select${this._serverId ? `:${this._serverId}` : ''}`)
      .setPlaceholder('Select a player for detailed stats\u2026')
      .addOptions(options),
  )];
}


// ═════════════════════════════════════════════════════════════════════
//  _buildClanRow — Clan select menu
// ═════════════════════════════════════════════════════════════════════

function _buildClanRow() {
  if (!this._clanData || this._clanData.length === 0) return [];

  const options = [];
  for (const clan of this._clanData) {
    if (!clan.name) continue;
    const memberCount = clan.members?.length || 0;
    let totalKills = 0;
    for (const m of (clan.members || [])) {
      const sid = m.steamId || m.steam_id;
      if (sid) {
        const at = this.getAllTimeKills(sid);
        totalKills += at?.zeeksKilled || 0;
      }
    }
    options.push({
      label: `[${clan.name}]`.substring(0, 100),
      description: `${memberCount} members \u00B7 ${totalKills.toLocaleString()} kills`.substring(0, 100),
      value: `clan:${clan.name}`.substring(0, 100),
    });
  }

  if (options.length === 0) return [];

  return [new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`playerstats_clan_select${this._serverId ? `:${this._serverId}` : ''}`)
      .setPlaceholder('Select a clan for details\u2026')
      .addOptions(options.slice(0, 25)),
  )];
}


// ═════════════════════════════════════════════════════════════════════
//  buildClanEmbed — Ephemeral clan detail
//
//  Layout: Aggregate stats → Member roster → Recent activity
// ═════════════════════════════════════════════════════════════════════

function buildClanEmbed(clanName) {
  const clan = Array.isArray(this._clanData)
    ? this._clanData.find(c => c.name === clanName)
    : this._clanData?.get?.(clanName);
  if (!clan) return null;

  const embed = new EmbedBuilder()
    .setTitle(`\uD83C\uDFF0 Clan: ${clanName}`)
    .setColor(0xe67e22)
    .setTimestamp();

  const members = clan.members || [];
  const sessions = this._playtime.getActiveSessions() || {};
  const allLog = this._playerStats.getAllPlayers();

  let totalKills = 0, totalDeaths = 0, bestDays = 0, totalPtMs = 0;
  const memberLines = [];

  for (const m of members) {
    const sid = m.steamId || m.steam_id;
    const name = m.name || sid;
    const save = sid ? this._saveData?.get(sid) : null;
    const at = sid ? this.getAllTimeKills(sid) : null;
    const kills = at?.zeeksKilled || 0;
    const logEntry = sid ? allLog.find(l => l.id === sid) : null;
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
    const role = (m.canKick || m.can_kick) ? ' \uD83D\uDC51' : '';
    memberLines.push(`${status}${role} **${name}** \u2014 ${kills.toLocaleString()} kills \u00B7 ${days}d \u00B7 ${_fmtTime(ptMs)}`);
  }

  // Aggregate stats as description
  const desc = [
    `**${members.length}** member${members.length !== 1 ? 's' : ''}`,
    `\uD83E\uDDDF **${totalKills.toLocaleString()}** kills \u00B7 \uD83D\uDC80 **${totalDeaths}** deaths`,
  ];
  if (bestDays > 0) desc.push(`\uD83D\uDCC5 Best survival: **${bestDays}** days`);
  if (totalPtMs > 0) desc.push(`\u23F1\uFE0F Combined playtime: **${_fmtTime(totalPtMs)}**`);
  embed.setDescription(desc.join('\n'));

  // Member list
  if (memberLines.length > 0) {
    embed.addFields({
      name: 'Members',
      value: memberLines.join('\n').substring(0, 1024),
    });
  }

  // Recent activity: last seen
  const activityLines = [];
  for (const m of members) {
    const sid = m.steamId || m.steam_id;
    const name = m.name || sid;
    const logEntry = allLog.find(l => l.id === sid || l.name === name);
    if (logEntry?.lastEvent) {
      const d = new Date(logEntry.lastEvent);
      const dateStr = d.toLocaleDateString('en-GB', {
        day: 'numeric', month: 'short',
        timeZone: this._config.botTimezone,
      });
      activityLines.push(`${name}: ${dateStr}`);
    }
  }
  if (activityLines.length > 0) {
    embed.addFields({
      name: '\uD83D\uDCCB Last Active',
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

function buildFullPlayerEmbed(steamId, { isAdmin = false } = {}) {
  const resolved = this._resolvePlayer(steamId);
  const log  = resolved.log;
  const save = resolved.save;
  const pt   = resolved.playtime;

  const serverTag = this._config.serverName ? ` [${this._config.serverName}]` : '';
  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTimestamp();

  // Random loading tip for footer
  const tips = gameData.LOADING_TIPS.filter(t => t.length > 20 && t.length < 120);
  const tip = tips.length > 0 ? tips[Math.floor(Math.random() * tips.length)] : null;
  embed.setFooter({ text: tip ? `\uD83D\uDCA1 ${tip}` : 'HumanitZ Player Stats' });

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

  // Level + XP + Gender
  const identityBits = [];
  if (save) {
    identityBits.push(save.male ? '\u2642' : '\u2640');
    if (save.level > 0) identityBits.push(`Lv ${save.level}`);
    if (save.exp > 0) identityBits.push(`${Math.round(save.exp).toLocaleString()} XP`);
  }
  if (pt) identityBits.push(`${pt.totalFormatted} playtime`);
  if (identityBits.length > 0) desc.push(identityBits.join(' \u00B7 '));

  // First seen + sessions
  const metaBits = [];
  if (resolved.firstSeen) {
    const fs = new Date(resolved.firstSeen);
    metaBits.push(`First seen ${fs.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: this._config.botTimezone })}`);
  }
  if (pt?.sessions > 0) metaBits.push(`${pt.sessions} session${pt.sessions !== 1 ? 's' : ''}`);
  if (metaBits.length > 0) desc.push(metaBits.join(' \u00B7 '));

  // Affliction warning
  if (save && typeof save.affliction === 'number' && save.affliction > 0 && save.affliction < gameData.AFFLICTION_MAP.length) {
    desc.push(`\u26A0\uFE0F **${gameData.AFFLICTION_MAP[save.affliction]}**`);
  }

  // Name history (compact)
  if (log?.nameHistory?.length > 0) {
    desc.push(`*aka ${log.nameHistory.map(h => h.name).join(', ')}*`);
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
      ['\uD83E\uDDDF', 'Zombie',   'zeeksKilled'],
      ['\uD83C\uDFAF', 'Headshot', 'headshots'],
      ['\u2694\uFE0F', 'Melee',    'meleeKills'],
      ['\uD83D\uDD2B', 'Ranged',   'gunKills'],
      ['\uD83D\uDCA5', 'Blast',    'blastKills'],
      ['\uD83D\uDC4A', 'Unarmed',  'fistKills'],
      ['\uD83D\uDDE1\uFE0F', 'Takedown', 'takedownKills'],
      ['\uD83D\uDE97', 'Vehicle',  'vehicleKills'],
    ];

    const killLines = [];
    for (const [emoji, label, key] of killTypes) {
      const allTime = at?.[key] || 0;
      const life = cl?.[key] || 0;
      if (allTime <= 0 && life <= 0) continue;
      if (hasExt && life > 0 && life !== allTime) {
        killLines.push(`${emoji} ${label}: **${allTime}** *(this life: ${life})*`);
      } else {
        killLines.push(`${emoji} ${label}: **${allTime}**`);
      }
    }

    const survLines = [];
    if (save.daysSurvived > 0) {
      const atSurv = this.getAllTimeSurvival(steamId);
      if (atSurv?.daysSurvived > save.daysSurvived) {
        survLines.push(`\uD83D\uDCC5 Survived: **${save.daysSurvived}d** *(best: ${atSurv.daysSurvived}d)*`);
      } else {
        survLines.push(`\uD83D\uDCC5 Survived: **${save.daysSurvived}d**`);
      }
    }
    if (log) survLines.push(`\uD83D\uDC80 Deaths: **${log.deaths}**`);
    if (save.timesBitten > 0) survLines.push(`\uD83E\uDDB7 Bitten: **${save.timesBitten}\u00D7**`);
    if (save.fishCaught > 0) {
      const pike = save.fishCaughtPike > 0 ? ` (${save.fishCaughtPike} pike)` : '';
      survLines.push(`\uD83D\uDC1F Fish: **${save.fishCaught}**${pike}`);
    }

    const combatValue = [...killLines, ...survLines].join('\n');
    if (combatValue) {
      embed.addFields({ name: '\u2694\uFE0F Combat & Survival', value: combatValue });
    }
  } else if (log) {
    embed.addFields({ name: '\u2694\uFE0F Combat', value: `\uD83D\uDC80 Deaths: **${log.deaths}**` });
  }

  // PvP (inline)
  if (log && ((log.pvpKills || 0) > 0 || (log.pvpDeaths || 0) > 0)) {
    const p = [];
    if (log.pvpKills > 0) p.push(`Kills: **${log.pvpKills}**`);
    if (log.pvpDeaths > 0) p.push(`Deaths: **${log.pvpDeaths}**`);
    const kd = log.pvpDeaths > 0
      ? (log.pvpKills / log.pvpDeaths).toFixed(2)
      : (log.pvpKills > 0 ? '\u221E' : '0');
    p.push(`K/D: **${kd}**`);
    embed.addFields({ name: '\uD83C\uDFF4\u200D\u2620\uFE0F PvP', value: p.join(' \u00B7 '), inline: true });
  }

  // ┌──────────────────────────────────────────────────────────────┐
  // │  3. VITALS — Health bars + status effects                   │
  // └──────────────────────────────────────────────────────────────┘

  if (this._config.canShow('showVitals', isAdmin) && save) {
    const vitals = [];
    if (this._config.showHealth)   vitals.push(`\u2764\uFE0F \`${_bar(save.health, save.maxHealth || 100)}\` ${_pct(save.health, save.maxHealth || 100)}`);
    if (this._config.showHunger)   vitals.push(`\uD83C\uDF56 \`${_bar(save.hunger, save.maxHunger || 100)}\` ${_pct(save.hunger, save.maxHunger || 100)}`);
    if (this._config.showThirst)   vitals.push(`\uD83D\uDCA7 \`${_bar(save.thirst, save.maxThirst || 100)}\` ${_pct(save.thirst, save.maxThirst || 100)}`);
    if (this._config.showStamina)  vitals.push(`\u26A1 \`${_bar(save.stamina, save.maxStamina || 100)}\` ${_pct(save.stamina, save.maxStamina || 100)}`);
    if (this._config.showImmunity) vitals.push(`\uD83D\uDEE1\uFE0F \`${_bar(save.infection, save.maxInfection || 100)}\` ${_pct(save.infection, save.maxInfection || 100)}`);
    if (this._config.showBattery && save.battery > 0 && save.battery < 100)
      vitals.push(`\uD83D\uDD0B \`${_bar(save.battery, 100)}\` ${_pct(save.battery, 100)}`);

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
      if (save.infectionBuildup > 0) statuses.push(`Infection ${save.infectionBuildup}%`);
      if (save.fatigue > 0.5) statuses.push('Fatigued');
      if (statuses.length > 0) vitals.push(`**Status:** ${statuses.join(', ')}`);
    }

    if (vitals.length > 0) embed.addFields({ name: '\u2764\uFE0F Vitals', value: vitals.join('\n') });
  }

  // ┌──────────────────────────────────────────────────────────────┐
  // │  4. GEAR — Equipment + Quick Slots (compact)                │
  // └──────────────────────────────────────────────────────────────┘

  if (this._config.canShow('showInventory', isAdmin) && save) {
    const notEmpty = (i) => i?.item && !/^empty$/i.test(i.item) && !/^empty$/i.test(_clean(i.item));
    const fmtItem = (i) => {
      const name = _clean(i.item);
      if (!name) return '';
      const amt = i.amount > 1 ? ` \u00D7${i.amount}` : '';
      return `${name}${amt}`;
    };

    const sections = [];

    if (this._config.showEquipment) {
      const equip = (save.equipment || []).filter(notEmpty);
      if (equip.length > 0) sections.push(`**Equipped:** ${equip.map(fmtItem).filter(Boolean).join(', ')}`);
    }
    if (this._config.showQuickSlots) {
      const quick = (save.quickSlots || []).filter(notEmpty);
      if (quick.length > 0) sections.push(`**Quick:** ${quick.map(fmtItem).filter(Boolean).join(', ')}`);
    }
    if (this._config.showPockets) {
      const pockets = (save.inventory || []).filter(notEmpty);
      if (pockets.length > 0) {
        if (pockets.length <= 6) {
          sections.push(`**Pockets:** ${pockets.map(fmtItem).filter(Boolean).join(', ')}`);
        } else {
          sections.push(`**Pockets:** ${pockets.length} items`);
        }
      }
    }
    if (this._config.showBackpack) {
      const bp = (save.backpackItems || []).filter(notEmpty);
      if (bp.length > 0) {
        if (bp.length <= 6) {
          sections.push(`**Backpack:** ${bp.map(fmtItem).filter(Boolean).join(', ')}`);
        } else {
          sections.push(`**Backpack:** ${bp.length} items`);
        }
      }
    }

    if (sections.length > 0) {
      embed.addFields({ name: '\uD83C\uDF92 Inventory', value: sections.join('\n').substring(0, 1024) });
    }
  }

  // ┌──────────────────────────────────────────────────────────────┐
  // │  5. DAMAGE / KILLED BY (inline pair)                        │
  // └──────────────────────────────────────────────────────────────┘

  if (log) {
    const dmgEntries = Object.entries(log.damageTaken || {});
    if (dmgEntries.length > 0) {
      const sorted = dmgEntries.sort((a, b) => b[1] - a[1]);
      const total = sorted.reduce((s, [, c]) => s + c, 0);
      const lines = sorted.slice(0, 4).map(([src, c]) => `${src}: **${c}**`);
      if (sorted.length > 4) lines.push(`+${sorted.length - 4} more`);
      embed.addFields({ name: `\uD83E\uDE78 Damage (${total})`, value: lines.join('\n'), inline: true });
    }

    const killEntries = Object.entries(log.killedBy || {});
    if (killEntries.length > 0) {
      const sorted = killEntries.sort((a, b) => b[1] - a[1]);
      const lines = sorted.slice(0, 4).map(([src, c]) => `${src}: **${c}**`);
      if (sorted.length > 4) lines.push(`+${sorted.length - 4} more`);
      embed.addFields({ name: '\uD83D\uDC80 Killed By', value: lines.join('\n'), inline: true });
    }
  }

  // ┌──────────────────────────────────────────────────────────────┐
  // │  6. BASE ACTIVITY (compact inline)                          │
  // └──────────────────────────────────────────────────────────────┘

  if (log) {
    const parts = [];
    if (log.builds > 0) parts.push(`\uD83C\uDFD7\uFE0F **${log.builds}** built`);
    if (log.containersLooted > 0) parts.push(`\uD83D\uDCE6 **${log.containersLooted}** looted`);
    if (this._config.canShow('showRaidStats', isAdmin)) {
      if (log.raidsOut > 0) parts.push(`\u2692\uFE0F **${log.raidsOut}** raids`);
      if (log.raidsIn > 0) parts.push(`\uD83D\uDEE1\uFE0F **${log.raidsIn}** raided`);
    }
    if (parts.length > 0) {
      embed.addFields({ name: '\uD83C\uDFE0 Base', value: parts.join(' \u00B7 '), inline: true });
    }
  }

  // ┌──────────────────────────────────────────────────────────────┐
  // │  7. PROGRESSION — Professions, Challenges (compact)         │
  // └──────────────────────────────────────────────────────────────┘

  // Unlocked professions
  if (save?.unlockedProfessions?.length > 1) {
    const profNames = save.unlockedProfessions
      .filter(p => typeof p === 'string')
      .map(p => PERK_MAP[p] || _clean(p))
      .filter(Boolean);
    if (profNames.length > 0) {
      embed.addFields({ name: '\uD83C\uDF93 Professions', value: profNames.join(', '), inline: true });
    }
  }

  // Challenges — completed vs in-progress
  if (save?.hasExtendedStats) {
    const descs = gameData.CHALLENGE_DESCRIPTIONS;
    const entries = [
      ['challengeKillZombies',         save.challengeKillZombies],
      ['challengeKill50',              save.challengeKill50],
      ['challengeCatch20Fish',         save.challengeCatch20Fish],
      ['challengeRegularAngler',       save.challengeRegularAngler],
      ['challengeKillZombieBear',      save.challengeKillZombieBear],
      ['challenge9Squares',            save.challenge9Squares],
      ['challengeCraftFirearm',        save.challengeCraftFirearm],
      ['challengeCraftFurnace',        save.challengeCraftFurnace],
      ['challengeCraftMeleeBench',     save.challengeCraftMeleeBench],
      ['challengeCraftMeleeWeapon',    save.challengeCraftMeleeWeapon],
      ['challengeCraftRainCollector',  save.challengeCraftRainCollector],
      ['challengeCraftTablesaw',       save.challengeCraftTablesaw],
      ['challengeCraftTreatment',      save.challengeCraftTreatment],
      ['challengeCraftWeaponsBench',   save.challengeCraftWeaponsBench],
      ['challengeCraftWorkbench',      save.challengeCraftWorkbench],
      ['challengeFindDog',             save.challengeFindDog],
      ['challengeFindHeli',            save.challengeFindHeli],
      ['challengeLockpickSUV',         save.challengeLockpickSUV],
      ['challengeRepairRadio',         save.challengeRepairRadio],
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
      if (completed.length > 0) lines.push(`\u2705 ${completed.join(', ')}`);
      if (inProgress.length > 0) {
        const shown = inProgress.slice(0, 5);
        lines.push(`\u2B1C ${shown.join(', ')}${inProgress.length > 5 ? ` +${inProgress.length - 5} more` : ''}`);
      }
      embed.addFields({
        name: `\uD83C\uDFC6 Challenges (${completed.length}/${19})`,
        value: lines.join('\n').substring(0, 1024),
      });
    }
  }

  // Recipes — counts only
  if (this._config.canShow('showRecipes', isAdmin) && save) {
    const craft = (save.craftingRecipes || []).length;
    const build = (save.buildingRecipes || []).length;
    if (craft > 0 || build > 0) {
      const parts = [];
      if (craft > 0) parts.push(`Crafting: **${craft}**`);
      if (build > 0) parts.push(`Building: **${build}**`);
      embed.addFields({ name: '\uD83D\uDCDC Recipes', value: parts.join(' \u00B7 '), inline: true });
    }
  }

  // Collections — lore + unique items (counts only)
  const extraBits = [];
  if (this._config.canShow('showLore', isAdmin) && save?.lore?.length > 0) {
    extraBits.push(`\uD83D\uDCD6 **${save.lore.length}** lore`);
  }
  if (save) {
    const found = cleanItemArray(save.lootItemUnique || []).length;
    const crafted = cleanItemArray(save.craftedUniques || []).length;
    if (found > 0) extraBits.push(`\u2B50 **${found}** unique found`);
    if (crafted > 0) extraBits.push(`\uD83D\uDD27 **${crafted}** unique crafted`);
  }
  if (extraBits.length > 0) {
    embed.addFields({ name: '\uD83D\uDCDA Collections', value: extraBits.join(' \u00B7 '), inline: true });
  }

  // ┌──────────────────────────────────────────────────────────────┐
  // │  8. META — Connections, location, companions                │
  // └──────────────────────────────────────────────────────────────┘

  // Last active + connections
  const metaLines = [];
  if (resolved.lastActive) {
    const d = new Date(resolved.lastActive);
    metaLines.push(`Last seen: ${d.toLocaleDateString('en-GB', { timeZone: this._config.botTimezone })} ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: this._config.botTimezone })}`);
  }
  if (this._config.canShow('showConnections', isAdmin) && log) {
    const conn = [];
    if (log.connects > 0) conn.push(`${log.connects} joins`);
    if (log.disconnects > 0) conn.push(`${log.disconnects} leaves`);
    if (log.adminAccess > 0) conn.push(`${log.adminAccess} admin`);
    if (conn.length > 0) metaLines.push(conn.join(' \u00B7 '));
  }
  if (metaLines.length > 0) {
    embed.addFields({ name: '\uD83D\uDD17 Activity', value: metaLines.join('\n'), inline: true });
  }

  // Location (admin-gated)
  if (this._config.canShow('showCoordinates', isAdmin) && save && save.x != null && save.x !== 0) {
    embed.addFields({
      name: '\uD83D\uDCCD Location',
      value: `${Math.round(save.x)}, ${Math.round(save.y)}, ${Math.round(save.z)}`,
      inline: true,
    });
  }

  // Horses + Companions
  if (this._config.canShow('showHorses', isAdmin) && save) {
    const lines = [];
    if (save.horses?.length > 0) {
      for (const h of save.horses) {
        const name = h.displayName || h.name || _clean(h.class || 'Horse');
        const hp = h.health != null && h.maxHealth > 0
          ? ` \u2014 ${Math.round(h.health)}/${Math.round(h.maxHealth)} HP`
          : '';
        lines.push(`\uD83D\uDC34 **${name}**${hp}`);
      }
    }
    if (save.companionData?.length > 0) {
      for (const c of save.companionData) {
        const name = c.displayName || c.name || _clean(c.class || 'Companion');
        const hp = c.health != null ? ` \u2014 ${Math.round(c.health)} HP` : '';
        lines.push(`\uD83D\uDC15 **${name}**${hp}`);
      }
    }
    if (lines.length > 0) {
      embed.addFields({ name: '\uD83D\uDC3E Animals', value: lines.join('\n').substring(0, 1024) });
    }
  }

  // Anti-cheat flags (admin only)
  if (isAdmin && log?.cheatFlags?.length > 0) {
    const flags = log.cheatFlags.slice(-3);
    const lines = flags.map(f => {
      const d = new Date(f.timestamp);
      return `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: this._config.botTimezone })} \u2014 \`${f.type}\``;
    });
    if (log.cheatFlags.length > 3) lines.unshift(`*${log.cheatFlags.length} total flags*`);
    embed.addFields({ name: '\uD83D\uDEA9 AC Flags', value: lines.join('\n'), inline: true });
  }

  return embed;
}


// ─── Exports ─────────────────────────────────────────────────────────
module.exports = {
  _buildOverviewEmbed,
  _buildRoster,
  _buildPlayerRow,
  _buildClanRow,
  buildClanEmbed,
  buildFullPlayerEmbed,
};

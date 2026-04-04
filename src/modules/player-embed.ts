/**
 * player-embed.js — Log-based player stats embed (for /playerstats command).
 *
 * This is the LIGHT version — used when we only have log data (no save file).
 * The full version is in player-stats-embeds.js -> buildFullPlayerEmbed().
 *
 * Layout:
 *   1. Identity + playtime
 *   2. Combat (deaths, damage breakdown, killed by)
 *   3. Base activity (builds, raids, looting)
 *   4. PvP (if any)
 *   5. Connections + AC flags (admin-gated)
 */

import { EmbedBuilder } from 'discord.js';
import _defaultPlaytime from '../tracking/playtime-tracker.js';
import _defaultConfig from '../config/index.js';
import { t, getLocale, fmtDate, fmtTime, fmtNumber } from '../i18n/index.js';

type ConfigType = typeof _defaultConfig;

interface PlayerStats {
  id: string;
  name: string;
  lastEvent?: string;
  nameHistory?: { name: string }[];
  deaths: number;
  damageTaken?: Record<string, number>;
  killedBy?: Record<string, number>;
  pvpKills?: number;
  pvpDeaths?: number;
  builds: number;
  buildItems?: Record<string, number>;
  raidsOut?: number;
  destroyedOut?: number;
  raidsIn?: number;
  containersLooted?: number;
  connects?: number;
  disconnects?: number;
  adminAccess?: number;
  cheatFlags?: { timestamp: string; type: string }[];
}

interface PlayerEmbedOpts {
  isAdmin?: boolean;
  playtime?: typeof _defaultPlaytime;
  config?: ConfigType;
}

function _pe(locale: string, key: string, vars: Record<string, unknown> = {}) {
  return t(`discord:player_embed.${key}`, locale, vars);
}

function buildPlayerEmbed(stats: PlayerStats, opts: PlayerEmbedOpts = {}) {
  const { isAdmin = false, playtime, config } = opts;
  const pt_inst = playtime || _defaultPlaytime;
  const cfg = config || _defaultConfig;
  const locale = getLocale({ serverConfig: { locale: cfg.botLocale } });

  const embed = new EmbedBuilder().setTitle(stats.name).setColor(0x5865f2).setTimestamp();

  const pt = pt_inst.getPlaytime(stats.id);

  // ── Description: playtime, sessions, last active, name history ──
  const desc: string[] = [];
  if (pt) {
    desc.push(
      _pe(locale, 'playtime_sessions', {
        playtime: pt.totalFormatted,
        sessions: fmtNumber(pt.sessions, locale),
        plural_suffix: pt.sessions !== 1 ? 's' : '',
      }),
    );
  }
  if (stats.lastEvent) {
    const d = new Date(stats.lastEvent);
    desc.push(
      _pe(locale, 'last_seen', {
        date: fmtDate(d, locale, cfg.botTimezone),
        time: fmtTime(d, locale, cfg.botTimezone),
      }),
    );
  }
  if (stats.nameHistory && stats.nameHistory.length > 0) {
    desc.push(_pe(locale, 'aka_names', { names: stats.nameHistory.map((h) => h.name).join(', ') }));
  }
  if (desc.length > 0) embed.setDescription(desc.join('\n'));

  // ── Combat: deaths + damage + killed by ──
  const dmgEntries = Object.entries(stats.damageTaken || {});
  const killEntries = Object.entries(stats.killedBy || {});

  const combatLines: string[] = [];
  combatLines.push(_pe(locale, 'deaths_line', { count: fmtNumber(stats.deaths, locale) }));

  if (dmgEntries.length > 0) {
    const total = dmgEntries.reduce((s, [, c]) => s + c, 0);
    const sorted = dmgEntries.sort(([, a], [, b]) => b - a);
    const top = sorted.slice(0, 4).map(([src, c]) => `${src}: **${fmtNumber(c, locale)}**`);
    if (sorted.length > 4) top.push(_pe(locale, 'list_more_count', { count: fmtNumber(sorted.length - 4, locale) }));
    combatLines.push(`\n${_pe(locale, 'damage_taken_title', { total: fmtNumber(total, locale) })}\n${top.join('\n')}`);
  }

  if (killEntries.length > 0) {
    const sorted = killEntries.sort(([, a], [, b]) => b - a);
    const top = sorted.slice(0, 4).map(([src, c]) => `${src}: **${fmtNumber(c, locale)}**`);
    if (sorted.length > 4) top.push(_pe(locale, 'list_more_count', { count: fmtNumber(sorted.length - 4, locale) }));
    combatLines.push(`\n${_pe(locale, 'killed_by_title')}\n${top.join('\n')}`);
  }

  embed.addFields({ name: _pe(locale, 'combat'), value: combatLines.join('\n').substring(0, 1024) });

  // ── PvP (if any) ──
  if ((stats.pvpKills || 0) > 0 || (stats.pvpDeaths || 0) > 0) {
    const p: string[] = [];
    if ((stats.pvpKills ?? 0) > 0) p.push(_pe(locale, 'pvp_kills', { count: fmtNumber(stats.pvpKills ?? 0, locale) }));
    if ((stats.pvpDeaths ?? 0) > 0)
      p.push(_pe(locale, 'pvp_deaths', { count: fmtNumber(stats.pvpDeaths ?? 0, locale) }));
    const kd =
      (stats.pvpDeaths ?? 0) > 0
        ? ((stats.pvpKills ?? 0) / (stats.pvpDeaths ?? 1)).toFixed(2)
        : (stats.pvpKills ?? 0) > 0
          ? '\u221E'
          : '0';
    p.push(_pe(locale, 'pvp_kd', { kd }));
    embed.addFields({ name: _pe(locale, 'pvp'), value: p.join(' \xB7 '), inline: true });
  }

  // ── Base Activity (compact, no raw item dumps) ──
  const baseParts: string[] = [];
  if (stats.builds > 0) {
    const buildEntries = Object.entries(stats.buildItems || {});
    if (buildEntries.length > 0) {
      const top3 = buildEntries.sort(([, a], [, b]) => b - a).slice(0, 3);
      baseParts.push(
        _pe(locale, 'base_built_with_items', {
          count: fmtNumber(stats.builds, locale),
          items: top3.map(([item, c]) => `${item} \xD7${fmtNumber(c, locale)}`).join(', '),
        }),
      );
    } else {
      baseParts.push(_pe(locale, 'base_built', { count: fmtNumber(stats.builds, locale) }));
    }
  }
  if (cfg.canShow('showRaidStats', isAdmin)) {
    const raidParts: string[] = [];
    if ((stats.raidsOut ?? 0) > 0)
      raidParts.push(_pe(locale, 'base_attacked', { count: fmtNumber(stats.raidsOut ?? 0, locale) }));
    if ((stats.destroyedOut ?? 0) > 0)
      raidParts.push(_pe(locale, 'base_destroyed', { count: fmtNumber(stats.destroyedOut ?? 0, locale) }));
    if ((stats.raidsIn ?? 0) > 0)
      raidParts.push(_pe(locale, 'base_raided', { count: fmtNumber(stats.raidsIn ?? 0, locale) }));
    if (raidParts.length > 0) baseParts.push(_pe(locale, 'base_raid_summary', { parts: raidParts.join(' \xB7 ') }));
  }
  if ((stats.containersLooted ?? 0) > 0)
    baseParts.push(_pe(locale, 'base_looted', { count: fmtNumber(stats.containersLooted ?? 0, locale) }));
  if (baseParts.length > 0) embed.addFields({ name: _pe(locale, 'base_activity'), value: baseParts.join('\n') });

  // ── Connections (admin-gated) ──
  if (cfg.canShow('showConnections', isAdmin)) {
    const conn: string[] = [];
    if ((stats.connects ?? 0) > 0)
      conn.push(_pe(locale, 'connections_in', { count: fmtNumber(stats.connects ?? 0, locale) }));
    if ((stats.disconnects ?? 0) > 0)
      conn.push(_pe(locale, 'connections_out', { count: fmtNumber(stats.disconnects ?? 0, locale) }));
    if ((stats.adminAccess ?? 0) > 0)
      conn.push(_pe(locale, 'connections_admin', { count: fmtNumber(stats.adminAccess ?? 0, locale) }));
    if (conn.length > 0)
      embed.addFields({ name: _pe(locale, 'connections'), value: conn.join(' \xB7 '), inline: true });
  }

  // ── AC Flags (admin only) ──
  if (isAdmin && stats.cheatFlags && stats.cheatFlags.length > 0) {
    const flags = stats.cheatFlags.slice(-3);
    const lines = flags.map((f) => {
      const d = new Date(f.timestamp);
      return `${fmtDate(d, locale, cfg.botTimezone)} \u2014 \`${f.type}\``;
    });
    if (stats.cheatFlags.length > 3) {
      lines.unshift(_pe(locale, 'ac_flags_total', { count: fmtNumber(stats.cheatFlags.length, locale) }));
    }
    embed.addFields({ name: _pe(locale, 'ac_flags'), value: lines.join('\n'), inline: true });
  }

  return embed;
}

export { buildPlayerEmbed };

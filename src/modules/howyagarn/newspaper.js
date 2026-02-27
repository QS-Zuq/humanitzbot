'use strict';

/**
 * Server Newspaper — auto-generated server "newspaper" with sections.
 *
 * Dynamically generates a newspaper-style embed from real DB data:
 *   - BREAKING: Biggest server event
 *   - SPORTS: Kill rankings and rivalries
 *   - OBITUARIES: Recent deaths in humorous style
 *   - REAL ESTATE: Construction activity
 *   - WEATHER: Current conditions and season
 *   - CLASSIFIEDS: Abandoned vehicles, lost horses, incomplete challenges
 *
 * Used by:
 *   - /newspaper slash command
 *   - Web panel Newspaper page
 *   - Auto-posted weekly (optional)
 *
 * Toggle: ENABLE_NEWSPAPER (default: false)
 */

const { EmbedBuilder } = require('discord.js');

// ── Section generators ───────────────────────────────────────────────────────
// Each returns a { name, value } field for the embed, or null.

function _breaking(db) {
  // Biggest event: highest kill count player, or most structures, or newest clan
  const killers = db.topKillers(1);
  if (killers.length && killers[0].lifetime_kills > 100) {
    const p = killers[0];
    return {
      name: '📰 BREAKING NEWS',
      value: `**${p.name}** continues their reign of terror with ${p.lifetime_kills.toLocaleString()} confirmed zombie kills. Local undead population declines.`,
    };
  }

  try {
    const row = db.db.prepare('SELECT COUNT(*) as cnt FROM structures').get();
    if (row && row.cnt > 20) {
      return {
        name: '📰 BREAKING NEWS',
        value: `Building boom! ${row.cnt} structures now dot the landscape as survivors dig in for the long haul.`,
      };
    }
  } catch {}

  return {
    name: '📰 BREAKING NEWS',
    value: 'Survivors continue to hold the line against the undead hordes. Situation: stable.',
  };
}

function _sports(db) {
  const killers = db.topKillers(3);
  if (killers.length === 0) return null;

  const lines = killers.map((p, i) => {
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : '🥉';
    return `${medal} ${p.name} — ${p.lifetime_kills.toLocaleString()} kills`;
  });

  // PvP rivalry
  const pvp = db.topPvp(2);
  if (pvp.length >= 2) {
    lines.push('');
    lines.push(`⚔️ **Rivalry Watch:** ${pvp[0].name} (${pvp[0].log_pvp_kills}K) vs ${pvp[1].name} (${pvp[1].log_pvp_kills}K)`);
  }

  return { name: '🏆 SPORTS', value: lines.join('\n') };
}

function _obituaries(db) {
  const deaths = db.topDeaths(3);
  if (deaths.length === 0) return null;

  const obits = deaths.map(p => {
    const killedBy = p.log_killed_by || 'unknown causes';
    return `💐 **${p.name}** (died ${p.log_deaths}x) — Most recently to *${killedBy}*. They will be missed. Probably.`;
  });

  return { name: '⚰️ OBITUARIES', value: obits.join('\n') };
}

function _realEstate(db) {
  const builders = db.topBuilders(3);
  if (builders.length === 0) return null;

  const lines = builders.map(p =>
    `🏠 ${p.name} — ${p.log_builds.toLocaleString()} structures`
  );

  try {
    const row = db.db.prepare('SELECT COUNT(*) as cnt FROM structures').get();
    if (row && row.cnt > 0) {
      lines.unshift(`📊 **${row.cnt}** total structures on the market`);
    }
  } catch {}

  return { name: '🏗️ REAL ESTATE', value: lines.join('\n') };
}

function _weather(db) {
  try {
    const season = db.db.prepare("SELECT value FROM world_state WHERE key = 'season'").get();
    const day = db.db.prepare("SELECT value FROM world_state WHERE key = 'day'").get();

    if (!season && !day) return null;

    const parts = [];
    if (day) parts.push(`📅 Day **${day.value}**`);
    if (season) parts.push(`🌤️ Season: **${season.value}**`);

    return { name: '🌦️ WEATHER FORECAST', value: parts.join(' • ') };
  } catch { return null; }
}

function _classifieds(db) {
  const items = [];

  // Abandoned vehicles (no owner / low fuel)
  try {
    const row = db.db.prepare('SELECT COUNT(*) as cnt FROM vehicles WHERE fuel <= 0').get();
    if (row && row.cnt > 0) {
      items.push(`🚗 **${row.cnt}** abandoned vehicle${row.cnt > 1 ? 's' : ''} — free to a good home (bring fuel)`);
    }
  } catch {}

  // Horses
  try {
    const row = db.db.prepare('SELECT COUNT(*) as cnt FROM world_horses').get();
    if (row && row.cnt > 0) {
      items.push(`🐴 **${row.cnt}** horse${row.cnt > 1 ? 's' : ''} roaming the wasteland`);
    }
  } catch {}

  // Fish leaderboard gap
  const fish = db.topFish(2);
  if (fish.length >= 2) {
    const gap = fish[0].fish_caught - fish[1].fish_caught;
    if (gap > 0) {
      items.push(`🎣 Fishing championship: ${fish[0].name} leads by ${gap} fish`);
    }
  }

  if (items.length === 0) return null;
  return { name: '📋 CLASSIFIEDS', value: items.join('\n') };
}

// ── All section generators ───────────────────────────────────────────────────

const SECTIONS = [_breaking, _sports, _obituaries, _realEstate, _weather, _classifieds];

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Build a newspaper-style embed from live server data.
 *
 * @param {object} db - HumanitZDB instance
 * @param {object} [options]
 * @param {string} [options.serverName] - Server name for the header
 * @returns {import('discord.js').EmbedBuilder|null}
 */
function buildNewspaper(db, options = {}) {
  if (!db || !db.db) return null;

  const serverName = options.serverName || 'The Wasteland';
  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });

  const embed = new EmbedBuilder()
    .setTitle(`📰 The ${serverName} Times`)
    .setColor(0xf5f5dc)
    .setFooter({ text: `Published ${today} • All facts are real and current` });

  let hasContent = false;

  for (const genFn of SECTIONS) {
    try {
      const field = genFn(db);
      if (field) {
        embed.addFields({ name: field.name, value: field.value });
        hasContent = true;
      }
    } catch {}
  }

  if (!hasContent) return null;

  return embed;
}


module.exports = { buildNewspaper, SECTIONS };

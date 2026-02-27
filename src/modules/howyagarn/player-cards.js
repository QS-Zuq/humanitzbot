'use strict';

/**
 * Player Cards — collectible-style player embeds with rarity tiers.
 *
 * Generates a rich embed styled like a trading card for a player:
 *   - Name, clan, profession
 *   - Key stats (kills, deaths, fish, built, playtime, survival streak)
 *   - Auto-assigned traits based on standout stats
 *   - Rarity tier from percentile rank: Common → Uncommon → Rare → Epic → Legendary
 *
 * Used by:
 *   - /card slash command
 *   - Web panel player profile
 *
 * Toggle: ENABLE_PLAYER_CARDS (default: false)
 */

const { EmbedBuilder } = require('discord.js');

// ── Rarity tiers ─────────────────────────────────────────────────────────────

const TIERS = [
  { name: 'Legendary', color: 0xffa500, emoji: '🟠', minPercentile: 95 },
  { name: 'Epic',      color: 0xa855f7, emoji: '🟣', minPercentile: 80 },
  { name: 'Rare',      color: 0x3b82f6, emoji: '🔵', minPercentile: 60 },
  { name: 'Uncommon',  color: 0x22c55e, emoji: '🟢', minPercentile: 30 },
  { name: 'Common',    color: 0x9ca3af, emoji: '⚪', minPercentile: 0 },
];

// ── Trait detection ──────────────────────────────────────────────────────────
// Each trait is { emoji, label, test(player, allPlayers) → boolean }.
// A player gets a trait if they're in the top percentile for that stat.

const TRAITS = [
  { emoji: '🧟', label: 'Zombie Slayer',    stat: 'lifetime_kills',     min: 500 },
  { emoji: '🔫', label: 'Sharpshooter',     stat: 'lifetime_headshots', min: 100 },
  { emoji: '🎣', label: 'Fisherman',        stat: 'fish_caught',        min: 10 },
  { emoji: '🔨', label: 'Architect',        stat: 'log_builds',         min: 50 },
  { emoji: '⚔️', label: 'PvP Fighter',      stat: 'log_pvp_kills',      min: 3 },
  { emoji: '📦', label: 'Scavenger',        stat: 'log_loots',          min: 50 },
  { emoji: '💀', label: 'Reckless',         stat: 'log_deaths',         min: 20 },
  { emoji: '🦷', label: 'Zombie Magnet',    stat: 'times_bitten',       min: 20 },
  { emoji: '🏕️', label: 'Survivor',         stat: 'days_survived',      min: 14 },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function _fmt(n) {
  if (n == null || n === 0) return '0';
  return Number(n).toLocaleString();
}

function _fmtHours(seconds) {
  if (!seconds || seconds <= 0) return '0h';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h === 0) return `${m}m`;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

/**
 * Calculate a composite score for a player (used for percentile ranking).
 * Weighted across multiple dimensions to reward well-rounded play.
 */
function _compositeScore(p) {
  return (
    (p.lifetime_kills || 0) * 1.0 +
    (p.lifetime_headshots || 0) * 2.0 +
    (p.fish_caught || 0) * 5.0 +
    (p.log_builds || 0) * 3.0 +
    (p.log_pvp_kills || 0) * 10.0 +
    (p.playtime_seconds || 0) / 360 +    // ~10 pts per hour
    (p.days_survived || 0) * 20.0 +
    (p.log_loots || 0) * 0.5
  );
}

/**
 * Get the percentile rank of a value within a sorted array.
 * @returns {number} 0–100
 */
function _percentile(value, sortedValues) {
  if (sortedValues.length === 0) return 0;
  if (sortedValues.length === 1) return value >= sortedValues[0] ? 100 : 0;
  let below = 0;
  for (const v of sortedValues) {
    if (v < value) below++;
  }
  return Math.round((below / sortedValues.length) * 100);
}

// ── Card builder ─────────────────────────────────────────────────────────────

/**
 * Build a player card embed.
 *
 * @param {object} db - HumanitZDB instance
 * @param {string} steamId - Player's Steam ID
 * @returns {import('discord.js').EmbedBuilder|null} The card embed, or null if player not found
 */
function buildPlayerCard(db, steamId) {
  if (!db || !db.db) return null;

  const player = db.getPlayer(steamId);
  if (!player) return null;

  // Get all players for percentile calculation
  const allPlayers = db.getAllPlayers() || [];
  const scores = allPlayers.map(p => _compositeScore(p)).sort((a, b) => a - b);
  const myScore = _compositeScore(player);
  const pct = _percentile(myScore, scores);

  // Determine rarity tier
  const tier = TIERS.find(t => pct >= t.minPercentile) || TIERS[TIERS.length - 1];

  // Detect traits
  const traits = [];
  for (const trait of TRAITS) {
    const val = player[trait.stat] || 0;
    if (val >= trait.min) {
      traits.push(`${trait.emoji} ${trait.label}`);
    }
  }

  // Build the card
  const name = player.name || steamId;
  const clan = player.clan_name ? ` [${player.clan_name}]` : '';

  const embed = new EmbedBuilder()
    .setTitle(`${tier.emoji} ${name}${clan}`)
    .setColor(tier.color)
    .setFooter({ text: `${tier.name} • Top ${100 - pct}% of ${allPlayers.length} survivors` });

  // Profession line
  let profLine = '';
  try {
    const profs = typeof player.unlocked_professions === 'string'
      ? JSON.parse(player.unlocked_professions)
      : player.unlocked_professions;
    if (Array.isArray(profs) && profs.length > 0) {
      profLine = `**Profession:** ${profs.join(', ')}`;
    }
  } catch {}

  // Stats grid
  const stats = [
    `🧟 **Kills:** ${_fmt(player.lifetime_kills)}`,
    `💀 **Deaths:** ${_fmt(player.log_deaths)}`,
    `🎣 **Fish:** ${_fmt(player.fish_caught)}`,
    `🔨 **Built:** ${_fmt(player.log_builds)}`,
    `⏱️ **Playtime:** ${_fmtHours(player.playtime_seconds)}`,
    `🏕️ **Survived:** ${_fmt(player.days_survived)} days`,
  ];

  // Headshot rate
  if (player.lifetime_kills > 0 && player.lifetime_headshots > 0) {
    const hsRate = Math.round((player.lifetime_headshots / player.lifetime_kills) * 100);
    stats.push(`🎯 **Headshots:** ${_fmt(player.lifetime_headshots)} (${hsRate}%)`);
  }

  // PvP stats (only if any)
  if (player.log_pvp_kills > 0 || player.log_pvp_deaths > 0) {
    stats.push(`⚔️ **PvP:** ${_fmt(player.log_pvp_kills)}K / ${_fmt(player.log_pvp_deaths)}D`);
  }

  let desc = '';
  if (profLine) desc += profLine + '\n\n';
  desc += stats.join('\n');

  if (traits.length > 0) {
    desc += '\n\n**Traits:** ' + traits.join(' • ');
  }

  embed.setDescription(desc);

  return embed;
}

/**
 * Find a player by name (case-insensitive) and build their card.
 *
 * @param {object} db - HumanitZDB instance
 * @param {string} name - Player name to search for
 * @returns {{ embed: import('discord.js').EmbedBuilder, steamId: string }|null}
 */
function buildPlayerCardByName(db, name) {
  if (!db || !db.db || !name) return null;

  try {
    const row = db.db.prepare(
      'SELECT steam_id FROM players WHERE LOWER(name) = LOWER(?) LIMIT 1'
    ).get(name.trim());
    if (!row) return null;

    const embed = buildPlayerCard(db, row.steam_id);
    if (!embed) return null;
    return { embed, steamId: row.steam_id };
  } catch {
    return null;
  }
}


module.exports = { buildPlayerCard, buildPlayerCardByName, TIERS, TRAITS };

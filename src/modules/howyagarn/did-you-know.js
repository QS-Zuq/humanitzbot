'use strict';

/**
 * Did You Know — random server facts from live DB data.
 *
 * Generates interesting, always-true factoids by querying the SQLite database.
 * Each fact is a function that returns { text, emoji } or null (if insufficient data).
 *
 * Used by:
 *   - /didyouknow slash command
 *   - Dynamic MOTD / WelcomeMessage.txt rotation
 *   - Web panel dashboard widget
 *
 * Toggle: ENABLE_DID_YOU_KNOW (default: false)
 */

// ── Fact generators ──────────────────────────────────────────────────────────
// Each function takes (db) and returns { text, emoji } or null.

function _topKiller(db) {
  const rows = db.topKillers(1);
  if (!rows.length || rows[0].lifetime_kills < 10) return null;
  const p = rows[0];
  return {
    emoji: '🧟',
    text: `${p.name} leads the server with ${p.lifetime_kills.toLocaleString()} zombie kills.`,
  };
}

function _topPlaytime(db) {
  const rows = db.topPlaytime(1);
  if (!rows.length || rows[0].playtime_seconds < 3600) return null;
  const p = rows[0];
  const hours = Math.floor(p.playtime_seconds / 3600);
  return {
    emoji: '⏱️',
    text: `${p.name} has spent ${hours.toLocaleString()} hours in-game — more than anyone else.`,
  };
}

function _mostDeaths(db) {
  const rows = db.topDeaths(1);
  if (!rows.length || rows[0].log_deaths < 5) return null;
  const p = rows[0];
  return {
    emoji: '💀',
    text: `${p.name} has died ${p.log_deaths.toLocaleString()} times. Respect the persistence.`,
  };
}

function _totalStructures(db) {
  try {
    const row = db.db.prepare('SELECT COUNT(*) as cnt FROM structures').get();
    if (!row || row.cnt < 5) return null;
    return {
      emoji: '🏗️',
      text: `There are currently ${row.cnt.toLocaleString()} structures standing on the map.`,
    };
  } catch { return null; }
}

function _totalVehicles(db) {
  try {
    const row = db.db.prepare('SELECT COUNT(*) as cnt FROM vehicles').get();
    if (!row || row.cnt < 1) return null;
    const fuelRow = db.db.prepare('SELECT COUNT(*) as cnt FROM vehicles WHERE fuel <= 0').get();
    const noFuel = fuelRow?.cnt || 0;
    if (noFuel > 0 && noFuel < row.cnt) {
      return {
        emoji: '🚗',
        text: `There are ${row.cnt} vehicles on the map. ${noFuel} ${noFuel === 1 ? 'has' : 'have'} no fuel.`,
      };
    }
    return {
      emoji: '🚗',
      text: `There are ${row.cnt} vehicles scattered across the map.`,
    };
  } catch { return null; }
}

function _topFisher(db) {
  const rows = db.topFish(1);
  if (!rows.length || rows[0].fish_caught < 3) return null;
  const p = rows[0];
  return {
    emoji: '🎣',
    text: `${p.name} has caught ${p.fish_caught.toLocaleString()} fish. Master angler.`,
  };
}

function _topBitten(db) {
  const rows = db.topBitten(1);
  if (!rows.length || rows[0].times_bitten < 5) return null;
  const p = rows[0];
  return {
    emoji: '🦷',
    text: `${p.name} has been bitten ${p.times_bitten.toLocaleString()} times and is still alive.`,
  };
}

function _playerCount(db) {
  try {
    const row = db.db.prepare('SELECT COUNT(*) as cnt FROM players WHERE last_seen IS NOT NULL').get();
    if (!row || row.cnt < 2) return null;
    return {
      emoji: '👥',
      text: `${row.cnt} survivors have set foot on this server.`,
    };
  } catch { return null; }
}

function _topBuilder(db) {
  const rows = db.topBuilders(1);
  if (!rows.length || rows[0].log_builds < 10) return null;
  const p = rows[0];
  return {
    emoji: '🔨',
    text: `${p.name} has built ${p.log_builds.toLocaleString()} structures — the server's top architect.`,
  };
}

function _topLooter(db) {
  const rows = db.topLooters(1);
  if (!rows.length || rows[0].log_loots < 10) return null;
  const p = rows[0];
  return {
    emoji: '📦',
    text: `${p.name} has looted ${p.log_loots.toLocaleString()} containers. Nothing is safe.`,
  };
}

function _clanCount(db) {
  try {
    const clans = typeof db.getAllClans === 'function' ? db.getAllClans() : [];
    if (!Array.isArray(clans) || clans.length < 1) return null;
    if (clans.length === 1) {
      return {
        emoji: '🏰',
        text: `There is 1 clan on the server: ${clans[0].name}.`,
      };
    }
    return {
      emoji: '🏰',
      text: `There are ${clans.length} clans competing for dominance.`,
    };
  } catch { return null; }
}

function _pvpKills(db) {
  const rows = db.topPvp(1);
  if (!rows.length || rows[0].log_pvp_kills < 2) return null;
  const p = rows[0];
  return {
    emoji: '⚔️',
    text: `${p.name} has ${p.log_pvp_kills} PvP kills — the most dangerous survivor on the server.`,
  };
}

function _headshots(db) {
  const rows = db.topKillers(1);
  if (!rows.length || !rows[0].lifetime_headshots || rows[0].lifetime_headshots < 10) return null;
  const p = rows[0];
  const pct = Math.round((p.lifetime_headshots / p.lifetime_kills) * 100);
  return {
    emoji: '🎯',
    text: `${p.name} has landed ${p.lifetime_headshots.toLocaleString()} headshots (${pct}% headshot rate).`,
  };
}

function _worldDay(db) {
  try {
    const row = db.db.prepare("SELECT value FROM world_state WHERE key = 'day'").get();
    if (!row) return null;
    const day = parseInt(row.value, 10);
    if (isNaN(day) || day < 2) return null;
    return {
      emoji: '📅',
      text: `The server has survived ${day} days since the outbreak began.`,
    };
  } catch { return null; }
}

// ── All fact generators ──────────────────────────────────────────────────────

const FACT_GENERATORS = [
  _topKiller,
  _topPlaytime,
  _mostDeaths,
  _totalStructures,
  _totalVehicles,
  _topFisher,
  _topBitten,
  _playerCount,
  _topBuilder,
  _topLooter,
  _clanCount,
  _pvpKills,
  _headshots,
  _worldDay,
];

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Get a random fact from the database.
 * Returns null if no facts are available (empty server, no DB).
 *
 * @param {object} db - HumanitZDB instance
 * @returns {{ text: string, emoji: string } | null}
 */
function getRandomFact(db) {
  if (!db || !db.db) return null;

  // Gather all available facts (non-null results)
  const available = [];
  for (const gen of FACT_GENERATORS) {
    try {
      const fact = gen(db);
      if (fact) available.push(fact);
    } catch {
      // Skip broken generators
    }
  }

  if (available.length === 0) return null;

  // Pick a random one
  const idx = Math.floor(Math.random() * available.length);
  return available[idx];
}

/**
 * Get all available facts (for testing or display).
 * @param {object} db - HumanitZDB instance
 * @returns {Array<{ text: string, emoji: string }>}
 */
function getAllFacts(db) {
  if (!db || !db.db) return [];
  const results = [];
  for (const gen of FACT_GENERATORS) {
    try {
      const fact = gen(db);
      if (fact) results.push(fact);
    } catch {}
  }
  return results;
}


module.exports = { getRandomFact, getAllFacts, FACT_GENERATORS };

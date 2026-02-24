/**
 * Backward-compatible re-export shim.
 *
 * All parsing logic now lives in:
 *   - src/parsers/gvas-reader.js  -- low-level GVAS binary reader
 *   - src/parsers/save-parser.js  -- save file parser (parseSave, parseClanData)
 *
 * This file keeps the old require('./save-parser') path working for existing
 * consumers (player-stats-channel, web-map, tests) until they migrate fully.
 */

const {
  parseSave: _parseSave,
  parseClanData,
  createPlayerData,
  simplifyBlueprint,
  PERK_MAP,
  PERK_INDEX_MAP,
  CLAN_RANK_MAP,
  SEASON_MAP,
  STAT_TAG_MAP,
} = require('./parsers/save-parser');

const {
  createReader,
  parseHeader,
  readProperty,
  cleanName,
  recoverForward,
  MAP_CAPTURE,
} = require('./parsers/gvas-reader');

/**
 * Wrapper that returns parseSave result in the NEW rich format.
 * The full object contains: { players, worldState, structures, vehicles,
 * companions, deadBodies, containers, lootActors, quests, header }.
 *
 * Old code that did `const players = parseSave(buf)` should be updated to
 * `const { players } = parseSave(buf)` to access the player Map.
 */
function parseSave(buf) {
  return _parseSave(buf);
}

module.exports = {
  parseSave,
  parseClanData,
  createPlayerData,
  simplifyBlueprint,
  PERK_MAP,
  PERK_INDEX_MAP,
  CLAN_RANK_MAP,
  SEASON_MAP,
  STAT_TAG_MAP,
  // Low-level re-exports (from gvas-reader) for backward compat
  createReader,
  parseHeader,
  readProperty,
  cleanName,
  recoverForward,
  MAP_CAPTURE,
};

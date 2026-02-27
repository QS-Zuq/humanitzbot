/**
 * howyagarn — dev-only feature incubator.
 *
 * All modules in this directory are internal / experimental.
 * They default to DISABLED and are panel-only (no Discord notifications)
 * until the developer is happy with them.
 *
 * Existing toggle-gated modules (milestone-tracker, recap-service) stay in
 * src/modules/ since they're already wired into index.js. New features
 * incubate here first, then graduate to src/modules/ when ready.
 *
 * Current features:
 *   - player-cards.js    — Collectible-style player embeds with rarity tiers (Phase 6a)
 *   - newspaper.js       — Auto-generated server "newspaper" (Phase 6b)
 *   - server-timeline.js — Key event timeline as scrollable history (Phase 6d)
 *   - report-card.js     — Weekly player performance reports (Phase 6e)
 *   - did-you-know.js    — Random server facts from live DB data (Phase 5e)
 *   - bounty-board.js    — PvP bounty tracking system (Phase 5f)
 *
 * Usage:
 *   All features are gated by ENABLE_* toggles (default false).
 *   Wire into index.js when ready for testing.
 *
 * @module howyagarn
 */

module.exports = {
  didYouKnow: require('./did-you-know'),
  playerCards: require('./player-cards'),
  newspaper: require('./newspaper'),
};

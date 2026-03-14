'use strict';

// ── Player factory ──────────────────────────────────────────────────────────

/**
 * Build a mock player row.  All fields have sensible defaults and can be
 * overridden individually.
 *
 * @param {object} overrides
 * @returns {object}
 */
function makePlayer(overrides = {}) {
  return {
    steam_id: '76561198000000001',
    name: 'TestPlayer',
    lifetime_kills: 0,
    playtime_seconds: 0,
    days_survived: 0,
    challenges: '[]',
    unlocked_professions: '[]',
    log_deaths: 0,
    log_builds: 0,
    log_loots: 0,
    log_pvp_kills: 0,
    fish_caught: 0,
    playtime_first_seen: null,
    updated_at: null,
    ...overrides,
  };
}

// ── Event factory ───────────────────────────────────────────────────────────

/**
 * Build a mock activity event.
 *
 * @param {object} overrides
 * @returns {object}
 */
function makeEvent(overrides = {}) {
  return {
    type: 'player_connect',
    steam_id: '76561198000000001',
    player_name: 'TestPlayer',
    timestamp: '2026-02-26T12:00:00.000Z',
    ...overrides,
  };
}

// ── Discord client stub ─────────────────────────────────────────────────────

/**
 * Minimal Discord.js Client mock.
 *
 * @returns {object}
 */
function mockClient() {
  return { channels: { cache: new Map() } };
}

// ── Config stub ─────────────────────────────────────────────────────────────

/**
 * Minimal config mock used by services that depend on `config.*` helpers.
 *
 * @param {object} overrides
 * @returns {object}
 */
function mockConfig(overrides = {}) {
  return {
    botTimezone: 'UTC',
    logChannelId: null,
    weeklyResetDay: 1, // Monday
    getToday() {
      return '2026-02-27';
    },
    getDateLabel(date) {
      return (date || new Date()).toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      });
    },
    formatTime(date) {
      return date.toISOString();
    },
    ...overrides,
  };
}

module.exports = { makePlayer, makeEvent, mockClient, mockConfig };

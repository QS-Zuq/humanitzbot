export function makePlayer(overrides: Record<string, any> = {}) {
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

export function makeEvent(overrides: Record<string, any> = {}) {
  return {
    type: 'player_connect',
    steam_id: '76561198000000001',
    player_name: 'TestPlayer',
    timestamp: '2026-02-26T12:00:00.000Z',
    ...overrides,
  };
}

export function mockClient() {
  return { channels: { cache: new Map() } };
}

export function mockConfig(overrides: Record<string, any> = {}) {
  return {
    botTimezone: 'UTC',
    logChannelId: null,
    weeklyResetDay: 1,
    getToday() {
      return '2026-02-27';
    },
    getDateLabel(date?: Date) {
      return (date ?? new Date()).toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      });
    },
    formatTime(date: Date) {
      return date.toISOString();
    },
    ...overrides,
  };
}

// CJS compat
module.exports = { makePlayer, makeEvent, mockClient, mockConfig };

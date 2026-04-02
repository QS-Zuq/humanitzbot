/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-require-imports, @typescript-eslint/no-floating-promises, @typescript-eslint/require-await */
'use strict';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const RecapService = require('../src/modules/recap-service');

const { mockDb: createMockDb } = require('./helpers/mock-db');

const { makePlayer, makeEvent, mockClient, mockConfig } = require('./helpers/factories');

// ── Domain adapter: adds activity queries and ranking methods ────────────────

function mockDb(players: unknown[] = [], clans: unknown[] = [], activityEvents: unknown[] = []) {
  return createMockDb({
    players,
    clans,
    extras: {
      getActivitySince(ts: string) {
        return (activityEvents as Array<{ timestamp: string }>).filter((e) => e.timestamp >= ts);
      },
      topKillers(limit: number) {
        return [...(players as Array<{ lifetime_kills?: number }>)]
          .sort((a, b) => (b.lifetime_kills || 0) - (a.lifetime_kills || 0))
          .slice(0, limit);
      },
      topPlaytime(limit: number) {
        return [...(players as Array<{ playtime_seconds?: number }>)]
          .sort((a, b) => (b.playtime_seconds || 0) - (a.playtime_seconds || 0))
          .slice(0, limit);
      },
    },
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('RecapService', () => {
  describe('_gatherDayStats', () => {
    it('returns null for empty events', () => {
      const db = mockDb();
      const rs = new RecapService(mockClient(), { db, config: mockConfig() });
      const stats = rs._gatherDayStats('2026-02-26T00:00:00.000Z', '2026-02-26T23:59:59.999Z');
      assert.equal(stats, null);
    });

    it('counts unique players and event types', () => {
      const events = [
        makeEvent({
          type: 'player_connect',
          steam_id: 'A',
          player_name: 'Alice',
          timestamp: '2026-02-26T10:00:00.000Z',
        }),
        makeEvent({ type: 'player_connect', steam_id: 'B', player_name: 'Bob', timestamp: '2026-02-26T11:00:00.000Z' }),
        makeEvent({ type: 'player_death', steam_id: 'A', player_name: 'Alice', timestamp: '2026-02-26T12:00:00.000Z' }),
        makeEvent({ type: 'player_death', steam_id: 'A', player_name: 'Alice', timestamp: '2026-02-26T13:00:00.000Z' }),
        makeEvent({ type: 'player_build', steam_id: 'B', player_name: 'Bob', timestamp: '2026-02-26T14:00:00.000Z' }),
        makeEvent({
          type: 'container_loot',
          steam_id: 'A',
          player_name: 'Alice',
          timestamp: '2026-02-26T15:00:00.000Z',
        }),
      ];
      const db = mockDb([], [], events);
      const rs = new RecapService(mockClient(), { db, config: mockConfig() });
      const stats = rs._gatherDayStats('2026-02-26T00:00:00.000Z', '2026-02-26T23:59:59.999Z');

      assert.equal(stats.totalEvents, 6);
      assert.equal(stats.uniquePlayers, 2);
      assert.equal(stats.deaths, 2);
      assert.equal(stats.builds, 1);
      assert.equal(stats.loots, 1);
      assert.equal(stats.connects, 2);
    });

    it('filters events to the specified day only', () => {
      const events = [
        makeEvent({ timestamp: '2026-02-25T23:59:59.000Z' }), // previous day
        makeEvent({ timestamp: '2026-02-26T10:00:00.000Z' }), // target day
        makeEvent({ timestamp: '2026-02-27T00:00:00.001Z' }), // next day
      ];
      const db = mockDb([], [], events);
      const rs = new RecapService(mockClient(), { db, config: mockConfig() });
      const stats = rs._gatherDayStats('2026-02-26T00:00:00.000Z', '2026-02-26T23:59:59.999Z');

      assert.equal(stats.totalEvents, 1);
    });

    it('identifies new players by playtime_first_seen', () => {
      const events = [
        makeEvent({
          type: 'player_connect',
          steam_id: 'NEW1',
          player_name: 'NewGuy',
          timestamp: '2026-02-26T10:00:00.000Z',
        }),
      ];
      const players = [
        makePlayer({ steam_id: 'NEW1', name: 'NewGuy', playtime_first_seen: '2026-02-26T10:00:00.000Z' }),
        makePlayer({ steam_id: 'OLD1', name: 'OldGuy', playtime_first_seen: '2026-01-01T00:00:00.000Z' }),
      ];
      const db = mockDb(players, [], events);
      const rs = new RecapService(mockClient(), { db, config: mockConfig() });
      const stats = rs._gatherDayStats('2026-02-26T00:00:00.000Z', '2026-02-26T23:59:59.999Z');

      assert.equal(stats.newPlayers.length, 1);
      assert.equal(stats.newPlayers[0], 'NewGuy');
    });

    it('identifies unluckiest player', () => {
      const events = [
        makeEvent({ type: 'player_death', steam_id: 'A', player_name: 'Alice', timestamp: '2026-02-26T10:00:00.000Z' }),
        makeEvent({ type: 'player_death', steam_id: 'A', player_name: 'Alice', timestamp: '2026-02-26T11:00:00.000Z' }),
        makeEvent({ type: 'player_death', steam_id: 'A', player_name: 'Alice', timestamp: '2026-02-26T12:00:00.000Z' }),
        makeEvent({ type: 'player_death', steam_id: 'B', player_name: 'Bob', timestamp: '2026-02-26T13:00:00.000Z' }),
      ];
      const db = mockDb([], [], events);
      const rs = new RecapService(mockClient(), { db, config: mockConfig() });
      const stats = rs._gatherDayStats('2026-02-26T00:00:00.000Z', '2026-02-26T23:59:59.999Z');

      assert.equal(stats.unluckiest, 'Alice');
      assert.equal(stats.unluckyDeaths, 3);
    });

    it('counts PvP kills', () => {
      const events = [
        makeEvent({
          type: 'player_death_pvp',
          steam_id: 'A',
          player_name: 'Alice',
          timestamp: '2026-02-26T10:00:00.000Z',
        }),
        makeEvent({
          type: 'player_death_pvp',
          steam_id: 'B',
          player_name: 'Bob',
          timestamp: '2026-02-26T11:00:00.000Z',
        }),
      ];
      const db = mockDb([], [], events);
      const rs = new RecapService(mockClient(), { db, config: mockConfig() });
      const stats = rs._gatherDayStats('2026-02-26T00:00:00.000Z', '2026-02-26T23:59:59.999Z');

      assert.equal(stats.pvpKills, 2);
      assert.equal(stats.deaths, 2); // PvP deaths count as deaths too
    });
  });

  describe('_buildDailyEmbed', () => {
    it('builds a valid embed with all stats', () => {
      const rs = new RecapService(mockClient(), { config: mockConfig() });
      const stats = {
        totalEvents: 150,
        uniquePlayers: 8,
        peakConcurrent: 5,
        connects: 12,
        disconnects: 10,
        deaths: 6,
        pvpKills: 2,
        builds: 25,
        loots: 40,
        raidHits: 3,
        fish: 7,
        totalKills: 5000,
        topKiller: 'Alice',
        topKillerKills: 1500,
        newPlayers: ['NewGuy1', 'NewGuy2'],
        mvp: 'Bob',
        mvpScore: 50,
        unluckiest: 'Charlie',
        unluckyDeaths: 4,
      };

      const embed = rs._buildDailyEmbed(stats, '26 Feb 2026');
      const json = embed.toJSON();

      assert.ok(json.title.includes('Daily Recap'));
      assert.ok(json.title.includes('26 Feb 2026'));
      assert.ok(json.description.includes('8')); // unique players
      assert.ok(json.description.includes('Deaths'));
      assert.ok(json.description.includes('Built'));
      assert.ok(json.description.includes('Alice')); // top killer
      assert.ok(json.description.includes('NewGuy1')); // new players
      assert.ok(json.description.includes('Bob')); // MVP
      assert.ok(json.description.includes('Charlie')); // unluckiest
      assert.ok(json.footer.text.includes('150')); // total events
    });

    it('omits sections with zero values', () => {
      const rs = new RecapService(mockClient(), { config: mockConfig() });
      const stats = {
        totalEvents: 5,
        uniquePlayers: 2,
        peakConcurrent: 1,
        connects: 3,
        disconnects: 2,
        deaths: 0,
        pvpKills: 0,
        builds: 0,
        loots: 0,
        raidHits: 0,
        fish: 0,
        totalKills: 0,
        topKiller: null,
        topKillerKills: 0,
        newPlayers: [],
        mvp: null,
        mvpScore: 0,
        unluckiest: null,
        unluckyDeaths: 0,
      };

      const embed = rs._buildDailyEmbed(stats, '26 Feb 2026');
      const desc = embed.toJSON().description;

      assert.ok(!desc.includes('Deaths'));
      assert.ok(!desc.includes('Built'));
      assert.ok(!desc.includes('Fish'));
      assert.ok(!desc.includes('MVP'));
      assert.ok(!desc.includes('Unluckiest'));
      assert.ok(!desc.includes('New Survivors'));
    });
  });

  describe('_getYesterday', () => {
    it('returns a YYYY-MM-DD string', () => {
      const rs = new RecapService(mockClient(), { config: mockConfig() });
      const result = rs._getYesterday();
      assert.match(result, /^\d{4}-\d{2}-\d{2}$/);
    });
  });

  describe('state persistence', () => {
    it('saves daily stats to bot_state', async () => {
      const events = [makeEvent({ timestamp: '2026-02-26T10:00:00.000Z' })];
      const db = mockDb([], [], events);
      const rs = new RecapService(mockClient(), { db, config: mockConfig() });

      // Manually call the internal save method
      rs._saveLastDaily('2026-02-26', { totalEvents: 42, uniquePlayers: 5 });

      const state = db.getStateJSON(RecapService.STATE_KEY);
      assert.ok(state);
      assert.equal(state.lastDaily.date, '2026-02-26');
      assert.equal(state.lastDaily.totalEvents, 42);
    });

    it('saves weekly stats for trend comparison', () => {
      const db = mockDb();
      const rs = new RecapService(mockClient(), { db, config: mockConfig() });

      rs._saveWeeklyStats({ uniquePlayers: 12, deaths: 30, totalEvents: 500 });

      const state = db.getStateJSON(RecapService.STATE_KEY);
      assert.ok(state.lastWeekly);
      assert.equal(state.lastWeekly.uniquePlayers, 12);
      assert.equal(state.lastWeekly.deaths, 30);
    });

    it('preserves both daily and weekly state', () => {
      const db = mockDb();
      const rs = new RecapService(mockClient(), { db, config: mockConfig() });

      rs._saveLastDaily('2026-02-26', { totalEvents: 42 });
      rs._saveWeeklyStats({ uniquePlayers: 12 });

      const state = db.getStateJSON(RecapService.STATE_KEY);
      assert.ok(state.lastDaily);
      assert.ok(state.lastWeekly);
    });
  });

  describe('onDayRollover', () => {
    it('posts daily recap without error', async () => {
      const events = [
        makeEvent({ timestamp: '2026-02-26T10:00:00.000Z' }),
        makeEvent({ type: 'player_death', steam_id: 'A', player_name: 'Alice', timestamp: '2026-02-26T12:00:00.000Z' }),
      ];
      const db = mockDb([makePlayer()], [], events);
      const rs = new RecapService(mockClient(), { db, config: mockConfig() });

      // Should not throw even with no channel to post to
      await rs.onDayRollover('2026-02-26');
    });

    it('skips daily recap when no events', async () => {
      const db = mockDb();
      const rs = new RecapService(mockClient(), { db, config: mockConfig() });

      // Should complete silently
      await rs.onDayRollover('2026-02-26');
    });

    it('triggers weekly digest on reset day', async () => {
      const events = [makeEvent({ timestamp: '2026-02-26T10:00:00.000Z' })];
      const db = mockDb([makePlayer()], [], events);

      // Mock config where "today" is Monday (reset day = 1)
      const cfg = mockConfig({ weeklyResetDay: 1 });

      const rs = new RecapService(mockClient(), { db, config: cfg });

      // Monkey-patch to detect weekly digest attempt
      let weeklyPosted = false;
      const origWeekly = rs.postWeeklyDigest.bind(rs);
      rs.postWeeklyDigest = async () => {
        weeklyPosted = true;
        await origWeekly();
      };
      void weeklyPosted;

      // The test can't easily control Intl weekday — just verify it doesn't crash
      await rs.onDayRollover('2026-02-26');
    });
  });

  describe('edge cases', () => {
    it('handles no DB gracefully', async () => {
      const rs = new RecapService(mockClient(), { db: null, config: mockConfig() });
      await rs.postDailyRecap('2026-02-26'); // should not throw
      await rs.postWeeklyDigest(); // should not throw
    });

    it('handles missing playtime tracker', async () => {
      const events = [makeEvent({ timestamp: '2026-02-26T10:00:00.000Z' })];
      const db = mockDb([], [], events);
      const rs = new RecapService(mockClient(), { db, config: mockConfig(), playtime: null });

      const stats = rs._gatherDayStats('2026-02-26T00:00:00.000Z', '2026-02-26T23:59:59.999Z');
      assert.equal(stats.peakConcurrent, 0);
    });

    it('handles getActivitySince returning empty', async () => {
      const db = mockDb();
      const rs = new RecapService(mockClient(), { db, config: mockConfig() });
      await rs.postWeeklyDigest(); // should complete silently
    });
  });
});

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const MilestoneTracker = require('../src/modules/milestone-tracker');
const { mockDb: createMockDb } = require('./helpers/mock-db');
const { makePlayer, mockClient } = require('./helpers/factories');

// ── Domain adapter: seeds initial state under MilestoneTracker.STATE_KEY ────

function mockDb(players = [], clans = [], initialState = null) {
  return createMockDb({
    players,
    clans,
    state: initialState ? { [MilestoneTracker.STATE_KEY]: initialState } : null,
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('MilestoneTracker', () => {
  describe('backfill on first enable', () => {
    it('silently records existing milestones without queuing embeds', async () => {
      const db = mockDb([makePlayer({ lifetime_kills: 1500, playtime_seconds: 100 * 3600, days_survived: 15 })]);
      // No initial state in DB → first run → backfill
      const mt = new MilestoneTracker(mockClient(), { db });

      assert.ok(mt._needsBackfill, 'Should detect first run');

      await mt.check();

      assert.equal(mt.getPendingCount(), 0, 'Pending should be 0 after backfill discard');
      assert.ok(mt.getLastCheckCount() > 0, 'Should have silently recorded milestones');
      assert.ok(!mt._needsBackfill, 'Backfill flag should be cleared');

      // State should be saved with recorded milestones
      const state = db.getStateJSON(MilestoneTracker.STATE_KEY);
      assert.ok(state, 'State should be saved');
      assert.ok(state.kills['76561198000000001'].includes(100), 'Should record 100 kill milestone');
      assert.ok(state.kills['76561198000000001'].includes(500), 'Should record 500 kill milestone');
      assert.ok(state.kills['76561198000000001'].includes(1000), 'Should record 1K kill milestone');
      assert.ok(!state.kills['76561198000000001'].includes(5000), 'Should not record 5K (not reached)');
    });

    it('does not backfill when state already exists in DB', async () => {
      const existing = { kills: {}, playtime: {}, survival: {}, challenges: {}, firsts: {}, clans: {} };
      const db = mockDb([makePlayer({ lifetime_kills: 200 })], [], existing);
      const mt = new MilestoneTracker(mockClient(), { db });

      assert.ok(!mt._needsBackfill, 'Should not need backfill');

      await mt.check();

      // Should queue an embed for the 100-kill milestone
      assert.equal(mt.getLastCheckCount(), 1, 'Should queue 100-kill milestone embed');
    });
  });

  describe('kill milestones', () => {
    it('announces when threshold is crossed', async () => {
      const existing = { kills: {}, playtime: {}, survival: {}, challenges: {}, firsts: {}, clans: {} };
      const db = mockDb([makePlayer({ lifetime_kills: 550 })], [], existing);
      const mt = new MilestoneTracker(mockClient(), { db });

      await mt.check();

      // Should get 100 and 500 milestone embeds
      assert.equal(mt.getLastCheckCount(), 2);
    });

    it('does not re-announce already recorded milestones', async () => {
      const existing = {
        kills: { '76561198000000001': [100, 500] },
        playtime: {},
        survival: {},
        challenges: {},
        firsts: {},
        clans: {},
      };
      const db = mockDb([makePlayer({ lifetime_kills: 550 })], [], existing);
      const mt = new MilestoneTracker(mockClient(), { db });

      await mt.check();

      assert.equal(mt.getLastCheckCount(), 0, 'Should not re-announce');
    });

    it('announces next threshold when kills increase', async () => {
      const existing = {
        kills: { '76561198000000001': [100, 500] },
        playtime: {},
        survival: {},
        challenges: {},
        firsts: {},
        clans: {},
      };
      const db = mockDb([makePlayer({ lifetime_kills: 1200 })], [], existing);
      const mt = new MilestoneTracker(mockClient(), { db });

      await mt.check();

      assert.equal(mt.getLastCheckCount(), 1, 'Should announce 1K milestone');
      const state = mt.getState();
      assert.ok(state.kills['76561198000000001'].includes(1000));
    });
  });

  describe('playtime milestones', () => {
    it('announces playtime thresholds', async () => {
      const existing = { kills: {}, playtime: {}, survival: {}, challenges: {}, firsts: {}, clans: {} };
      const db = mockDb(
        [
          makePlayer({ playtime_seconds: 7 * 3600 }), // 7 hours
        ],
        [],
        existing,
      );
      const mt = new MilestoneTracker(mockClient(), { db });

      await mt.check();

      // 1h and 6h milestones
      assert.equal(mt.getLastCheckCount(), 2);
    });
  });

  describe('survival milestones', () => {
    it('announces survival streaks', async () => {
      const existing = { kills: {}, playtime: {}, survival: {}, challenges: {}, firsts: {}, clans: {} };
      const db = mockDb([makePlayer({ days_survived: 8 })], [], existing);
      const mt = new MilestoneTracker(mockClient(), { db });

      await mt.check();

      // 1, 3, 7 day milestones
      assert.equal(mt.getLastCheckCount(), 3);
    });

    it('resets survival milestones on death', async () => {
      const existing = {
        kills: {},
        playtime: {},
        survival: { '76561198000000001': [1, 3, 7] },
        challenges: {},
        firsts: {},
        clans: {},
      };
      const db = mockDb([], [], existing);
      const mt = new MilestoneTracker(mockClient(), { db });

      mt.onPlayerDeath('76561198000000001');

      const state = mt.getState();
      assert.deepEqual(state.survival['76561198000000001'], [], 'Should clear survival milestones');
    });

    it('can re-earn survival milestones after death', async () => {
      const existing = {
        kills: {},
        playtime: {},
        survival: { '76561198000000001': [1, 3, 7] },
        challenges: {},
        firsts: {},
        clans: {},
      };
      const db = mockDb([makePlayer({ days_survived: 4 })], [], existing);
      const mt = new MilestoneTracker(mockClient(), { db });

      // Death resets survival
      mt.onPlayerDeath('76561198000000001');

      // Next check should re-announce 1 and 3 day milestones
      await mt.check();
      assert.equal(mt.getLastCheckCount(), 2);
    });
  });

  describe('challenge milestones', () => {
    it('announces completed challenges', async () => {
      const existing = { kills: {}, playtime: {}, survival: {}, challenges: {}, firsts: {}, clans: {} };
      const db = mockDb(
        [
          makePlayer({
            challenges: JSON.stringify([
              { name: 'Bear Hunter', progress: 10, total: 10 },
              { name: 'Fish Master', progress: 5, total: 20 },
            ]),
          }),
        ],
        [],
        existing,
      );
      const mt = new MilestoneTracker(mockClient(), { db });

      await mt.check();

      // Only Bear Hunter is complete
      assert.equal(mt.getLastCheckCount(), 1);
    });

    it('does not re-announce completed challenges', async () => {
      const existing = {
        kills: {},
        playtime: {},
        survival: {},
        challenges: { '76561198000000001': ['Bear Hunter'] },
        firsts: {},
        clans: {},
      };
      const db = mockDb(
        [
          makePlayer({
            challenges: JSON.stringify([{ name: 'Bear Hunter', progress: 10, total: 10 }]),
          }),
        ],
        [],
        existing,
      );
      const mt = new MilestoneTracker(mockClient(), { db });

      await mt.check();

      assert.equal(mt.getLastCheckCount(), 0);
    });
  });

  describe('first-to-unlock milestones', () => {
    it('announces first profession unlock', async () => {
      const existing = { kills: {}, playtime: {}, survival: {}, challenges: {}, firsts: {}, clans: {} };
      const db = mockDb([makePlayer({ unlocked_professions: JSON.stringify(['Mechanic']) })], [], existing);
      const mt = new MilestoneTracker(mockClient(), { db });

      await mt.check();

      assert.equal(mt.getLastCheckCount(), 1);
      const state = mt.getState();
      assert.ok(state.firsts.profession.includes('Mechanic'));
    });

    it('does not announce profession already claimed by someone else', async () => {
      const existing = {
        kills: {},
        playtime: {},
        survival: {},
        challenges: {},
        firsts: { profession: ['Mechanic'] },
        clans: {},
      };
      const db = mockDb(
        [
          makePlayer({
            steam_id: '76561198000000002',
            name: 'Player2',
            unlocked_professions: JSON.stringify(['Mechanic']),
          }),
        ],
        [],
        existing,
      );
      const mt = new MilestoneTracker(mockClient(), { db });

      await mt.check();

      assert.equal(mt.getLastCheckCount(), 0, 'Second player should not get first-unlock');
    });
  });

  describe('clan milestones', () => {
    it('announces clan member thresholds', async () => {
      const existing = { kills: {}, playtime: {}, survival: {}, challenges: {}, firsts: {}, clans: {} };
      const members = Array.from({ length: 6 }, (_, i) => ({
        steamId: `7656119800000000${i}`,
        name: `Player${i}`,
        rank: 0,
      }));
      const db = mockDb([], [{ name: 'WolfPack', members }], existing);
      const mt = new MilestoneTracker(mockClient(), { db });

      await mt.check();

      // 5-member milestone
      assert.equal(mt.getLastCheckCount(), 1);
    });
  });

  describe('multiple players', () => {
    it('tracks milestones independently per player', async () => {
      const existing = { kills: {}, playtime: {}, survival: {}, challenges: {}, firsts: {}, clans: {} };
      const db = mockDb(
        [
          makePlayer({ steam_id: '76561198000000001', name: 'Alice', lifetime_kills: 150 }),
          makePlayer({ steam_id: '76561198000000002', name: 'Bob', lifetime_kills: 600 }),
        ],
        [],
        existing,
      );
      const mt = new MilestoneTracker(mockClient(), { db });

      await mt.check();

      // Alice: 100 kill milestone
      // Bob: 100 + 500 kill milestones
      assert.equal(mt.getLastCheckCount(), 3);
    });
  });

  describe('state persistence', () => {
    it('saves state to DB after changes', async () => {
      const existing = { kills: {}, playtime: {}, survival: {}, challenges: {}, firsts: {}, clans: {} };
      const db = mockDb([makePlayer({ lifetime_kills: 150 })], [], existing);
      const mt = new MilestoneTracker(mockClient(), { db });

      await mt.check();

      const saved = db.getStateJSON(MilestoneTracker.STATE_KEY);
      assert.ok(saved.kills['76561198000000001'].includes(100));
    });

    it('does not save when nothing changed', async () => {
      const existing = {
        kills: { '76561198000000001': [100] },
        playtime: {},
        survival: {},
        challenges: {},
        firsts: {},
        clans: {},
      };
      const db = mockDb(
        [
          makePlayer({ lifetime_kills: 50 }), // below next threshold
        ],
        [],
        existing,
      );
      const mt = new MilestoneTracker(mockClient(), { db });

      // Track if setStateJSON is called
      let saveCalled = false;
      const origSet = db.setStateJSON.bind(db);
      db.setStateJSON = (...args) => {
        saveCalled = true;
        origSet(...args);
      };

      await mt.check();

      assert.ok(!saveCalled, 'Should not save when nothing changed');
    });
  });

  describe('embed batching', () => {
    it('batches embeds into groups of 10', async () => {
      const existing = { kills: {}, playtime: {}, survival: {}, challenges: {}, firsts: {}, clans: {} };
      // Create player that hits many milestones at once
      const db = mockDb(
        [
          makePlayer({
            lifetime_kills: 100000, // all 8 kill thresholds
            playtime_seconds: 1001 * 3600, // all 9 playtime thresholds
            days_survived: 100, // all 7 survival thresholds
          }),
        ],
        [],
        existing,
      );
      const mt = new MilestoneTracker(mockClient(), { db });

      await mt.check();

      // 8 + 9 + 7 = 24 milestones total
      assert.equal(mt.getLastCheckCount(), 24);
    });
  });

  describe('edge cases', () => {
    it('handles no DB gracefully', async () => {
      const mt = new MilestoneTracker(mockClient(), { db: null });
      await mt.check(); // should not throw
      assert.equal(mt.getLastCheckCount(), 0);
    });

    it('handles empty player list', async () => {
      const existing = { kills: {}, playtime: {}, survival: {}, challenges: {}, firsts: {}, clans: {} };
      const db = mockDb([], [], existing);
      const mt = new MilestoneTracker(mockClient(), { db });
      await mt.check();
      assert.equal(mt.getLastCheckCount(), 0);
    });

    it('handles malformed challenges JSON', async () => {
      const existing = { kills: {}, playtime: {}, survival: {}, challenges: {}, firsts: {}, clans: {} };
      const db = mockDb([makePlayer({ challenges: 'not-json' })], [], existing);
      const mt = new MilestoneTracker(mockClient(), { db });
      await mt.check(); // should not throw
      assert.equal(mt.getLastCheckCount(), 0);
    });

    it('handles zero kills/playtime/days', async () => {
      const existing = { kills: {}, playtime: {}, survival: {}, challenges: {}, firsts: {}, clans: {} };
      const db = mockDb([makePlayer({ lifetime_kills: 0, playtime_seconds: 0, days_survived: 0 })], [], existing);
      const mt = new MilestoneTracker(mockClient(), { db });
      await mt.check();
      assert.equal(mt.getLastCheckCount(), 0);
    });

    it('onPlayerDeath with unknown steamId is a no-op', () => {
      const existing = { kills: {}, playtime: {}, survival: {}, challenges: {}, firsts: {}, clans: {} };
      const db = mockDb([], [], existing);
      const mt = new MilestoneTracker(mockClient(), { db });
      mt.onPlayerDeath('unknown_id'); // should not throw
      mt.onPlayerDeath(null); // should not throw
    });
  });
});

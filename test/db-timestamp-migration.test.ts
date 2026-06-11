/**
 * Tests for the v23 schema migration — normalizing legacy ISO 'T' playtime
 * timestamps on the players table to the canonical space-separated format.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import _database from '../src/db/database.js';
const HumanitZDB = _database as any;

function plantLegacyValues(db: any, steamId: string, values: Record<string, string | null>) {
  db.player.upsertFullPlaytime(steamId, {
    name: `P_${steamId.slice(-4)}`,
    totalMs: 60_000,
    sessions: 1,
  });
  db.db
    .prepare(
      `UPDATE players
       SET playtime_first_seen = ?, playtime_last_login = ?, playtime_last_seen = ?
       WHERE steam_id = ?`,
    )
    .run(values.first ?? null, values.login ?? null, values.seen ?? null, steamId);
}

function readPlaytimeColumns(db: any, steamId: string) {
  return db.db
    .prepare('SELECT playtime_first_seen, playtime_last_login, playtime_last_seen FROM players WHERE steam_id = ?')
    .get(steamId);
}

describe('Schema v23 — normalize legacy ISO playtime timestamps', () => {
  it('rewrites ISO rows to the canonical format, preserving the UTC instant', () => {
    const db = new HumanitZDB({ memory: true, label: 'TsMigrate' });
    db.init();
    try {
      plantLegacyValues(db, '76561198000000001', {
        first: '2026-04-01T10:20:30.000Z',
        login: '2026-05-02T08:00:00.000Z',
        seen: '2026-05-02T09:30:45.123Z',
      });
      plantLegacyValues(db, '76561198000000002', {
        first: '2026-04-01 10:20:30',
        login: null,
        seen: 'not-a-timestamp',
      });

      db._setMeta('schema_version', '22');
      db._applySchema();

      const migrated = readPlaytimeColumns(db, '76561198000000001');
      assert.equal(migrated.playtime_first_seen, '2026-04-01 10:20:30');
      assert.equal(migrated.playtime_last_login, '2026-05-02 08:00:00');
      assert.equal(migrated.playtime_last_seen, '2026-05-02 09:30:45');

      // Canonical, null, and non-timestamp values are untouched.
      const untouched = readPlaytimeColumns(db, '76561198000000002');
      assert.equal(untouched.playtime_first_seen, '2026-04-01 10:20:30');
      assert.equal(untouched.playtime_last_login, null);
      assert.equal(untouched.playtime_last_seen, 'not-a-timestamp');

      assert.equal(db._getMeta('schema_version'), '23');
    } finally {
      db.close();
    }
  });

  it('leaves a T-format value that strftime cannot parse untouched (COALESCE guard)', () => {
    const db = new HumanitZDB({ memory: true, label: 'TsMigrateBad' });
    db.init();
    try {
      plantLegacyValues(db, '76561198000000003', {
        first: '9999-99-99T99:99:99.000Z',
        login: null,
        seen: null,
      });

      db._setMeta('schema_version', '22');
      db._applySchema();

      const row = readPlaytimeColumns(db, '76561198000000003');
      assert.equal(row.playtime_first_seen, '9999-99-99T99:99:99.000Z');
    } finally {
      db.close();
    }
  });

  it('unsticks last_seen rows that lexicographic MAX kept pinned to the ISO value', () => {
    const db = new HumanitZDB({ memory: true, label: 'TsMigrateSticky' });
    db.init();
    try {
      const steamId = '76561198000000004';
      plantLegacyValues(db, steamId, {
        first: null,
        login: null,
        seen: '2026-05-02T09:00:00.000Z',
      });

      // Before the migration: a canonical same-day update that is
      // chronologically LATER still loses the string comparison
      // ('2026-05-02 10:..' < '2026-05-02T09:..' because ' ' < 'T').
      db.player.upsertFullPlaytime(steamId, {
        name: 'Sticky',
        totalMs: 120_000,
        sessions: 2,
        lastSeen: '2026-05-02 10:00:00',
      });
      assert.equal(readPlaytimeColumns(db, steamId).playtime_last_seen, '2026-05-02T09:00:00.000Z');

      db._setMeta('schema_version', '22');
      db._applySchema();
      assert.equal(readPlaytimeColumns(db, steamId).playtime_last_seen, '2026-05-02 09:00:00');

      // After normalization the same canonical update wins as expected.
      db.player.upsertFullPlaytime(steamId, {
        name: 'Sticky',
        totalMs: 180_000,
        sessions: 3,
        lastSeen: '2026-05-02 10:00:00',
      });
      assert.equal(readPlaytimeColumns(db, steamId).playtime_last_seen, '2026-05-02 10:00:00');
    } finally {
      db.close();
    }
  });
});

/**
 * Tests for the v22 schema migration — partial pos_x indexes backing the
 * getPositioned* world object queries used by the web map data polling.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import _database from '../src/db/database.js';
const HumanitZDB = _database as any;

const POS_INDEXES = [
  'idx_structures_pos',
  'idx_vehicles_pos',
  'idx_companions_pos',
  'idx_dead_bodies_pos',
  'idx_containers_pos',
];

function posIndexSql(db: any): Map<string, string> {
  const rows = db.db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%_pos'")
    .all() as Array<{ name: string; sql: string }>;
  return new Map(rows.filter((row) => POS_INDEXES.includes(row.name)).map((row) => [row.name, row.sql]));
}

function dropPosIndexes(db: any): void {
  db.db.exec(POS_INDEXES.map((name) => `DROP INDEX IF EXISTS ${name};`).join('\n'));
}

describe('Schema v22 — partial pos_x indexes', () => {
  it('creates partial pos_x indexes on a fresh database', () => {
    const db = new HumanitZDB({ memory: true, label: 'PosIndexFresh' });
    db.init();
    try {
      const indexes = posIndexSql(db);
      for (const name of POS_INDEXES) {
        const sql = indexes.get(name);
        assert.ok(sql, `${name} should exist on a fresh database`);
        assert.match(sql, /WHERE pos_x IS NOT NULL/);
      }
      assert.match(indexes.get('idx_containers_pos') as string, /pos_x != 0/);
    } finally {
      db.close();
    }
  });

  it('recreates the indexes when migrating from a v21 database', () => {
    const db = new HumanitZDB({ memory: true, label: 'PosIndexMigrate' });
    db.init();
    try {
      dropPosIndexes(db);
      assert.equal(posIndexSql(db).size, 0);

      db._setMeta('schema_version', '21');
      db._applySchema();

      const migrated = posIndexSql(db);
      for (const name of POS_INDEXES) {
        assert.ok(migrated.has(name), `${name} should be recreated by the v21→v22 migration`);
      }
      assert.equal(db._getMeta('schema_version'), '22');
    } finally {
      db.close();
    }
  });

  it('migration and fresh DDL produce identical index definitions', () => {
    const fresh = new HumanitZDB({ memory: true, label: 'PosIndexDdl' });
    const upgraded = new HumanitZDB({ memory: true, label: 'PosIndexUpgraded' });
    fresh.init();
    upgraded.init();
    try {
      dropPosIndexes(upgraded);
      upgraded._setMeta('schema_version', '21');
      upgraded._applySchema();

      const freshSql = posIndexSql(fresh);
      const upgradedSql = posIndexSql(upgraded);
      for (const name of POS_INDEXES) {
        assert.equal(
          upgradedSql.get(name),
          freshSql.get(name),
          `${name} definition should match between fresh DDL and migration`,
        );
      }
    } finally {
      fresh.close();
      upgraded.close();
    }
  });

  it('positioned world object queries use the partial indexes', () => {
    const db = new HumanitZDB({ memory: true, label: 'PosIndexPlan' });
    db.init();
    try {
      const planUses = (sql: string, index: string) => {
        const plan = db.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>;
        return plan.some((row) => row.detail.includes(index));
      };
      assert.ok(planUses('SELECT id FROM structures WHERE pos_x IS NOT NULL', 'idx_structures_pos'));
      assert.ok(planUses('SELECT id FROM vehicles WHERE pos_x IS NOT NULL', 'idx_vehicles_pos'));
      assert.ok(planUses('SELECT id FROM companions WHERE pos_x IS NOT NULL', 'idx_companions_pos'));
      assert.ok(planUses('SELECT actor_name FROM dead_bodies WHERE pos_x IS NOT NULL', 'idx_dead_bodies_pos'));
      assert.ok(
        planUses('SELECT actor_name FROM containers WHERE pos_x IS NOT NULL AND pos_x != 0', 'idx_containers_pos'),
      );
    } finally {
      db.close();
    }
  });
});

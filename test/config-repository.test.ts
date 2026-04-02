/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-require-imports, @typescript-eslint/no-floating-promises */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const HumanitZDB = require('../src/db/database');

const ConfigRepository = require('../src/db/config-repository');

describe('ConfigRepository', () => {
  let db: any;
  let repo: any;

  beforeEach(() => {
    db = new HumanitZDB({ memory: true, label: 'ConfigRepoTest' });
    db.init();
    repo = new ConfigRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  // ── 1. CRUD roundtrip ───────────────────────────────────────

  it('set() + get() roundtrips data', () => {
    repo.set('app', { showVitals: true, rconHost: '127.0.0.1' });
    const data = repo.get('app');
    assert.deepStrictEqual(data, { showVitals: true, rconHost: '127.0.0.1' });
  });

  it('get() returns null for missing scope', () => {
    assert.equal(repo.get('nonexistent'), null);
  });

  it('delete() removes a scope', () => {
    repo.set('app', { key: 'value' });
    repo.delete('app');
    assert.equal(repo.get('app'), null);
  });

  // ── 2. Merge-patch via update() ─────────────────────────────

  it('update() merges keys into existing document', () => {
    repo.set('app', { a: 1, b: 2 });
    const merged = repo.update('app', { b: 20, c: 30 });
    assert.deepStrictEqual(merged, { a: 1, b: 20, c: 30 });
    assert.deepStrictEqual(repo.get('app'), { a: 1, b: 20, c: 30 });
  });

  it('update() with undefined deletes keys', () => {
    repo.set('app', { a: 1, b: 2, c: 3 });
    const merged = repo.update('app', { b: undefined, d: 4 });
    assert.deepStrictEqual(merged, { a: 1, c: 3, d: 4 });
    assert.deepStrictEqual(repo.get('app'), { a: 1, c: 3, d: 4 });
  });

  it('update() creates document if missing', () => {
    const result = repo.update('new_scope', { hello: 'world' });
    assert.deepStrictEqual(result, { hello: 'world' });
    assert.deepStrictEqual(repo.get('new_scope'), { hello: 'world' });
  });

  // ── 3. Version auto-increment ───────────────────────────────

  it('version auto-increments on each set()', () => {
    repo.set('app', { v: 1 });
    const meta1 = repo.getMeta('app');
    assert.equal(meta1.version, 1);

    repo.set('app', { v: 2 });
    const meta2 = repo.getMeta('app');
    assert.equal(meta2.version, 2);

    repo.set('app', { v: 3 });
    const meta3 = repo.getMeta('app');
    assert.equal(meta3.version, 3);
  });

  // ── 4. JSON with unicode and nested objects ─────────────────

  it('handles unicode and deeply nested objects', () => {
    const complex = {
      serverName: '遊戲伺服器 🎮',
      nested: { deep: { value: [1, 2, 3] } },
      emoji: '🧟‍♂️',
      specialChars: 'line1\nline2\ttab',
    };
    repo.set('app', complex);
    assert.deepStrictEqual(repo.get('app'), complex);
  });

  // ── 5. loadAll() ────────────────────────────────────────────

  it('loadAll() returns all documents as Map', () => {
    repo.set('app', { global: true });
    repo.set('server:primary', { rconHost: '10.0.0.1' });
    repo.set('server:srv_001', { id: 'srv_001', rcon: { host: '10.0.0.2' } });

    const all = repo.loadAll();
    assert.equal(all.size, 3);
    assert.deepStrictEqual(all.get('app').data, { global: true });
    assert.deepStrictEqual(all.get('server:primary').data, { rconHost: '10.0.0.1' });
    assert.deepStrictEqual(all.get('server:srv_001').data, { id: 'srv_001', rcon: { host: '10.0.0.2' } });
    assert.equal(typeof all.get('app').version, 'number');
    assert.equal(typeof all.get('app').updatedAt, 'string');
  });

  // ── 6. getMeta() ────────────────────────────────────────────

  it('getMeta() returns null for missing scope', () => {
    assert.equal(repo.getMeta('missing'), null);
  });

  // ── 7. listServerScopes() ──────────────────────────────────

  it('listServerScopes() returns only server: scopes', () => {
    repo.set('app', { global: true });
    repo.set('server:primary', { rconHost: '10.0.0.1' });
    repo.set('server:srv_001', { id: 'srv_001' });
    repo.set('server:srv_002', { id: 'srv_002' });
    repo.set('other', { unrelated: true });

    const scopes = repo.listServerScopes();
    assert.equal(scopes.length, 3);
    assert.ok(scopes.includes('server:primary'));
    assert.ok(scopes.includes('server:srv_001'));
    assert.ok(scopes.includes('server:srv_002'));
    assert.ok(!scopes.includes('app'));
    assert.ok(!scopes.includes('other'));
  });
});

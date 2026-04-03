/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-floating-promises */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import * as _item_fingerprint from '../src/db/item-fingerprint.js';
const { generateFingerprint, normalizeSlot, normalizeInventory, buildFingerprintMap } = _item_fingerprint as any;

describe('generateFingerprint', () => {
  it('returns empty string for null/invalid input', () => {
    assert.equal(generateFingerprint(null), '');
    assert.equal(generateFingerprint({}), '');
    assert.equal(generateFingerprint({ item: '' }), '');
  });

  it('generates a 12-char hex string', () => {
    const fp = generateFingerprint({ item: 'AK47', durability: 0.847623 });
    assert.match(fp, /^[0-9a-f]{12}$/);
  });

  it('same inputs produce same fingerprint', () => {
    const a = generateFingerprint({ item: 'AK47', durability: 0.847623, ammo: 15 });
    const b = generateFingerprint({ item: 'AK47', durability: 0.847623, ammo: 15 });
    assert.equal(a, b);
  });

  it('different durability produces different fingerprint', () => {
    const a = generateFingerprint({ item: 'AK47', durability: 0.847623 });
    const b = generateFingerprint({ item: 'AK47', durability: 0.847624 });
    assert.notEqual(a, b);
  });

  it('different ammo produces different fingerprint', () => {
    const a = generateFingerprint({ item: 'AK47', durability: 0.85, ammo: 15 });
    const b = generateFingerprint({ item: 'AK47', durability: 0.85, ammo: 14 });
    assert.notEqual(a, b);
  });

  it('different items produce different fingerprint', () => {
    const a = generateFingerprint({ item: 'AK47', durability: 0.85 });
    const b = generateFingerprint({ item: 'Shotgun', durability: 0.85 });
    assert.notEqual(a, b);
  });

  it('attachments affect fingerprint', () => {
    const a = generateFingerprint({ item: 'AK47', durability: 0.85, attachments: ['Scope'] });
    const b = generateFingerprint({ item: 'AK47', durability: 0.85, attachments: [] });
    assert.notEqual(a, b);
  });

  it('attachment order does not matter (sorted)', () => {
    const a = generateFingerprint({ item: 'AK47', durability: 0.85, attachments: ['Scope', 'Silencer'] });
    const b = generateFingerprint({ item: 'AK47', durability: 0.85, attachments: ['Silencer', 'Scope'] });
    assert.equal(a, b);
  });

  it('cap and maxDur affect fingerprint', () => {
    const a = generateFingerprint({ item: 'WaterBottle', durability: 0.5, cap: 1.0 });
    const b = generateFingerprint({ item: 'WaterBottle', durability: 0.5, cap: 0.75 });
    assert.notEqual(a, b);
  });

  it('identical stackable items get same fingerprint', () => {
    const a = generateFingerprint({ item: 'Nails', durability: 1.0 });
    const b = generateFingerprint({ item: 'Nails', durability: 1.0 });
    assert.equal(a, b);
  });
});

describe('normalizeSlot', () => {
  it('returns null for empty/invalid input', () => {
    assert.equal(normalizeSlot(null), null);
    assert.equal(normalizeSlot({ item: 'None' }), null);
    assert.equal(normalizeSlot({ item: 'Empty' }), null);
    assert.equal(normalizeSlot({ item: '' }), null);
  });

  it('normalises clean agent format', () => {
    const result = normalizeSlot({
      item: 'AK47',
      amount: 1,
      durability: 0.847623,
      ammo: 15,
      attachments: ['Scope'],
    });
    assert.equal(result.item, 'AK47');
    assert.equal(result.amount, 1);
    assert.equal(result.durability, 0.847623);
    assert.equal(result.ammo, 15);
    assert.deepEqual(result.attachments, ['Scope']);
    assert.ok(result.fingerprint);
    assert.match(result.fingerprint, /^[0-9a-f]{12}$/);
  });

  it('normalises raw save-parser array format', () => {
    const rawSlot = [
      { name: 'Item', children: [{ name: 'RowName', value: 'Shotgun' }] },
      { name: 'Amount', value: 1 },
      { name: 'Durability', value: 0.65 },
      { name: 'Ammo', value: 5 },
    ];
    const result = normalizeSlot(rawSlot);
    assert.equal(result.item, 'Shotgun');
    assert.equal(result.amount, 1);
    assert.equal(result.durability, 0.65);
    assert.equal(result.ammo, 5);
    assert.ok(result.fingerprint);
  });

  it('handles raw format with no Item child', () => {
    const rawSlot = [
      { name: 'Item', children: [{ name: 'RowName', value: 'None' }] },
      { name: 'Amount', value: 0 },
    ];
    assert.equal(normalizeSlot(rawSlot), null);
  });
});

describe('normalizeInventory', () => {
  it('returns empty array for null/invalid', () => {
    assert.deepEqual(normalizeInventory(null), []);
    assert.deepEqual(normalizeInventory([]), []);
    assert.deepEqual(normalizeInventory('not an array'), []);
  });

  it('filters out empty slots', () => {
    const inv = [
      { item: 'AK47', amount: 1, durability: 0.85 },
      { item: 'None', amount: 0 },
      { item: 'Nails', amount: 50, durability: 1.0 },
      null,
    ];
    const result = normalizeInventory(inv);
    assert.equal(result.length, 2);
    assert.equal(result[0].item, 'AK47');
    assert.equal(result[1].item, 'Nails');
  });

  it('adds fingerprints to every item', () => {
    const inv = [
      { item: 'AK47', amount: 1, durability: 0.85 },
      { item: 'Shotgun', amount: 1, durability: 0.5 },
    ];
    const result = normalizeInventory(inv);
    assert.ok(result[0].fingerprint);
    assert.ok(result[1].fingerprint);
    assert.notEqual(result[0].fingerprint, result[1].fingerprint);
  });
});

describe('buildFingerprintMap', () => {
  it('groups items by fingerprint', () => {
    const items = [
      { item: 'Nails', durability: 1.0, fingerprint: 'aaa111bbb222' },
      { item: 'Nails', durability: 1.0, fingerprint: 'aaa111bbb222' },
      { item: 'AK47', durability: 0.85, fingerprint: 'ccc333ddd444' },
    ];
    const map = buildFingerprintMap(items);
    assert.equal(map.size, 2);
    assert.equal(map.get('aaa111bbb222').length, 2);
    assert.equal(map.get('ccc333ddd444').length, 1);
  });

  it('skips items without fingerprint', () => {
    const items = [
      { item: 'AK47', fingerprint: '' },
      { item: 'Shotgun' }, // no fingerprint property
    ];
    const map = buildFingerprintMap(items);
    assert.equal(map.size, 0);
  });
});

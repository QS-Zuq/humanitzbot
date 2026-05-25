import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  formatDbTimestampUtc,
  isDbTimestampUtc,
  normalizeDbTimestampUtc,
  parseDbTimestampUtc,
} from '../src/db/timestamp.js';

describe('DB timestamp helpers', () => {
  it('formats UTC instants as canonical SQLite UTC text', () => {
    assert.equal(formatDbTimestampUtc(new Date('2026-05-25T09:53:29.769Z')), '2026-05-25 09:53:29');
  });

  it('parses canonical SQLite UTC text as UTC, not local time', () => {
    const parsed = parseDbTimestampUtc('2026-05-25 09:53:29');
    assert.equal(parsed?.toISOString(), '2026-05-25T09:53:29.000Z');
  });

  it('accepts legacy ISO_Z and offset timestamps', () => {
    assert.equal(normalizeDbTimestampUtc('2026-05-25T09:53:29.769Z'), '2026-05-25 09:53:29');
    assert.equal(normalizeDbTimestampUtc('2026-05-25T17:53:29+08:00'), '2026-05-25 09:53:29');
  });

  it('returns null for invalid or empty values', () => {
    assert.equal(parseDbTimestampUtc(''), null);
    assert.equal(parseDbTimestampUtc('not a timestamp'), null);
    assert.equal(normalizeDbTimestampUtc(null), null);
  });

  it('checks canonical DB timestamp shape', () => {
    assert.equal(isDbTimestampUtc('2026-05-25 09:53:29'), true);
    assert.equal(isDbTimestampUtc('2026-05-25T09:53:29.000Z'), false);
  });
});

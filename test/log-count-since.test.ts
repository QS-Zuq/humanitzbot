import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import HumanitZDB from '../src/db/database.js';

describe('countActivitySince / countChatSince', () => {
  let db: HumanitZDB;

  beforeEach(() => {
    db = new HumanitZDB({ memory: true, label: 'CountSinceTest' });
    db.init();
  });

  afterEach(() => {
    db.close();
  });

  // ── ActivityLogRepository.countActivitySince ────────────────────────────────

  describe('countActivitySince', () => {
    it('matches getActivitySince().length for the same cutoff', () => {
      db.activityLog.insertActivitiesAt([
        { type: 'kill', category: 'pvp', actor: 'Alice', createdAt: '2026-06-09 12:00:00' },
        { type: 'kill', category: 'pvp', actor: 'Bob', createdAt: '2026-06-10 01:00:00' },
        { type: 'loot', category: 'loot', actor: 'Carol', createdAt: '2026-06-10 08:30:00' },
      ]);

      const cutoff = '2026-06-10 00:00:00';
      const rows = db.activityLog.getActivitySince(cutoff);
      assert.equal(rows.length, 2);
      assert.equal(db.activityLog.countActivitySince(cutoff), rows.length);
    });

    it('returns 0 when no rows match', () => {
      assert.equal(db.activityLog.countActivitySince('2026-06-10 00:00:00'), 0);
    });

    it('normalizes ISO cutoff input the same as the canonical DB format', () => {
      db.activityLog.insertActivitiesAt([
        { type: 'kill', category: 'pvp', actor: 'Alice', createdAt: '2026-06-09 12:00:00', source: 'log' },
        { type: 'kill', category: 'pvp', actor: 'Bob', createdAt: '2026-06-10 01:00:00', source: 'log' },
      ]);

      // ISO cutoffs with a 'T' separator must match rows stored in the
      // canonical space-separated DB format (string comparison would
      // otherwise exclude every same-day row because ' ' < 'T').
      const cutoffIso = '2026-06-10T00:00:00.000Z';
      assert.equal(db.activityLog.getActivitySince(cutoffIso).length, 1);
      assert.equal(db.activityLog.countActivitySince(cutoffIso), 1);
      assert.equal(db.activityLog.getActivitySinceBySource(cutoffIso, 'log').length, 1);
    });
  });

  // ── ChatLogRepository.countChatSince ────────────────────────────────────────

  describe('countChatSince', () => {
    it('matches getChatSince().length and normalizes ISO input the same way', () => {
      db.chatLog.insertChatAt({ type: 'chat', playerName: 'Alice', message: 'old', createdAt: '2026-06-09 12:00:00' });
      db.chatLog.insertChatAt({ type: 'chat', playerName: 'Bob', message: 'new', createdAt: '2026-06-10 01:00:00' });

      const cutoffIso = '2026-06-10T00:00:00.000Z';
      const rows = db.chatLog.getChatSince(cutoffIso);
      assert.equal(rows.length, 1);
      assert.equal(db.chatLog.countChatSince(cutoffIso), rows.length);
    });

    it('returns 0 when no rows match', () => {
      assert.equal(db.chatLog.countChatSince('2026-06-10 00:00:00'), 0);
    });
  });
});

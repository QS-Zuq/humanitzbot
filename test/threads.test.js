/**
 * Tests for /threads rebuild — log parsing and summary builders.
 * Run: node --test test/threads.test.js
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { _parseHmzLog, _parseConnectLog, _mergeDays, _buildSummaryEmbed, _dateKey, _fetchThreadMessages, _findMatchingThreads } = require('../src/commands/threads');

// ══════════════════════════════════════════════════════════
// _dateKey
// ══════════════════════════════════════════════════════════

describe('_dateKey', () => {
  it('returns YYYY-MM-DD string for a Date', () => {
    const key = _dateKey(new Date('2026-02-15T12:00:00Z'));
    assert.match(key, /^\d{4}-\d{2}-\d{2}$/);
  });

  it('returns consistent key for same day', () => {
    const a = _dateKey(new Date('2026-02-15T01:00:00Z'));
    const b = _dateKey(new Date('2026-02-15T10:00:00Z'));
    assert.equal(a, b);
  });
});

// ══════════════════════════════════════════════════════════
// _parseHmzLog
// ══════════════════════════════════════════════════════════

describe('_parseHmzLog', () => {
  it('returns empty object for empty input', () => {
    assert.deepEqual(_parseHmzLog(''), {});
  });

  it('ignores lines that do not match the timestamp regex', () => {
    assert.deepEqual(_parseHmzLog('random garbage line\nanother line'), {});
  });

  it('counts player deaths', () => {
    const log = '(15/02/2026 12:30) Player died (TestPlayer)\n';
    const days = _parseHmzLog(log);
    const keys = Object.keys(days);
    assert.equal(keys.length, 1);
    assert.equal(days[keys[0]].deaths, 1);
    assert.ok(days[keys[0]].players.has('TestPlayer'));
  });

  it('counts building completed', () => {
    const log = '(15/02/2026 14:00) Builder(12345678901234567) finished building WoodWall\n';
    const days = _parseHmzLog(log);
    const key = Object.keys(days)[0];
    assert.equal(days[key].builds, 1);
  });

  it('counts damage taken', () => {
    const log = '(15/02/2026 14:00) SomePlayer took 25.0 damage from Zombie\n';
    const days = _parseHmzLog(log);
    const key = Object.keys(days)[0];
    assert.equal(days[key].damage, 1);
  });

  it('counts container looted', () => {
    const log = '(15/02/2026 14:00) Looter (12345678901234567) looted a container\n';
    const days = _parseHmzLog(log);
    const key = Object.keys(days)[0];
    assert.equal(days[key].loots, 1);
  });

  it('counts raid hits and destroyed', () => {
    const log = [
      '(15/02/2026 14:00) Building (WoodWall) owned by (12345678901234567) damaged by Player',
      '(15/02/2026 14:05) Building (WoodWall) owned by (12345678901234567) damaged by Player (Destroyed)',
    ].join('\n');
    const days = _parseHmzLog(log);
    const key = Object.keys(days)[0];
    assert.equal(days[key].raidHits, 1);
    assert.equal(days[key].destroyed, 1);
  });

  it('counts admin access', () => {
    const log = '(15/02/2026 14:00) SomeAdmin gained admin access!\n';
    const days = _parseHmzLog(log);
    const key = Object.keys(days)[0];
    assert.equal(days[key].admin, 1);
  });

  it('counts multiple events across two days', () => {
    const log = [
      '(15/02/2026 12:00) Player died (Alice)',
      '(15/02/2026 13:00) Player died (Bob)',
      '(16/02/2026 08:00) Player died (Charlie)',
    ].join('\n');
    const days = _parseHmzLog(log);
    const keys = Object.keys(days).sort();
    assert.equal(keys.length, 2);
    assert.equal(days[keys[0]].deaths, 2);
    assert.equal(days[keys[1]].deaths, 1);
  });
});

// ══════════════════════════════════════════════════════════
// _parseConnectLog
// ══════════════════════════════════════════════════════════

describe('_parseConnectLog', () => {
  it('returns empty object for empty input', () => {
    assert.deepEqual(_parseConnectLog(''), {});
  });

  it('counts connects and disconnects', () => {
    const log = [
      'Player Connected TestPlayer NetID(12345678901234567) (15/02/2026 10:00)',
      'Player Disconnected TestPlayer NetID(12345678901234567) (15/02/2026 11:00)',
    ].join('\n');
    const days = _parseConnectLog(log);
    const keys = Object.keys(days);
    assert.equal(keys.length, 1);
    assert.equal(days[keys[0]].connects, 1);
    assert.equal(days[keys[0]].disconnects, 1);
    assert.ok(days[keys[0]].players.has('TestPlayer'));
  });
});

// ══════════════════════════════════════════════════════════
// _mergeDays
// ══════════════════════════════════════════════════════════

describe('_mergeDays', () => {
  it('merges hmz and connect data for same date', () => {
    const hmz = { '2026-02-15': { deaths: 3, builds: 1, damage: 5, loots: 2, raidHits: 0, destroyed: 0, admin: 0, cheat: 0, players: new Set(['Alice']) } };
    const conn = { '2026-02-15': { connects: 4, disconnects: 2, players: new Set(['Alice', 'Bob']) } };
    const merged = _mergeDays(hmz, conn);
    assert.equal(merged['2026-02-15'].deaths, 3);
    assert.equal(merged['2026-02-15'].connects, 4);
    assert.equal(merged['2026-02-15'].uniquePlayers, 2);
  });

  it('includes dates that appear in only one source', () => {
    const hmz = { '2026-02-15': { deaths: 1, builds: 0, damage: 0, loots: 0, raidHits: 0, destroyed: 0, admin: 0, cheat: 0, players: new Set() } };
    const conn = { '2026-02-16': { connects: 2, disconnects: 1, players: new Set(['X']) } };
    const merged = _mergeDays(hmz, conn);
    assert.ok('2026-02-15' in merged);
    assert.ok('2026-02-16' in merged);
  });
});

// ══════════════════════════════════════════════════════════
// _buildSummaryEmbed
// ══════════════════════════════════════════════════════════

describe('_buildSummaryEmbed', () => {
  it('returns an EmbedBuilder with title and description', () => {
    const embed = _buildSummaryEmbed('2026-02-15', {
      connects: 5, disconnects: 3, deaths: 2, builds: 1,
      damage: 10, loots: 4, raidHits: 0, destroyed: 0,
      admin: 0, cheat: 0, uniquePlayers: 3,
    });
    const json = embed.toJSON();
    assert.ok(json.title.includes('Daily Summary'));
    assert.ok(json.description.includes('Deaths'));
    assert.ok(json.description.includes('Connections'));
  });

  it('omits zero-count categories', () => {
    const embed = _buildSummaryEmbed('2026-02-15', {
      connects: 0, disconnects: 0, deaths: 1, builds: 0,
      damage: 0, loots: 0, raidHits: 0, destroyed: 0,
      admin: 0, cheat: 0, uniquePlayers: 1,
    });
    const desc = embed.toJSON().description;
    assert.ok(desc.includes('Deaths'));
    assert.ok(!desc.includes('Connections'));
    assert.ok(!desc.includes('Items Built'));
  });
});

// ══════════════════════════════════════════════════════════
// _fetchThreadMessages
// ══════════════════════════════════════════════════════════

describe('_fetchThreadMessages', () => {
  /** Build a mock thread that returns messages from a flat array. */
  function mockThread(messages) {
    // Discord.js messages.fetch returns a Collection (Map-like, ordered by ID descending)
    return {
      messages: {
        async fetch({ limit, before } = {}) {
          // Sort descending by id (simulates Discord behaviour)
          let pool = [...messages].sort((a, b) => Number(b.id) - Number(a.id));
          if (before) pool = pool.filter(m => Number(m.id) < Number(before));
          const batch = pool.slice(0, limit || 100);
          const map = new Map();
          for (const m of batch) map.set(m.id, m);
          // Needs .last() and .size like a discord.js Collection
          map.last = () => batch[batch.length - 1];
          return map;
        },
      },
    };
  }

  function msg(id, { embedTitle, embedDesc, content } = {}) {
    const embeds = [];
    if (embedTitle || embedDesc) {
      embeds.push({ data: { title: embedTitle || '', description: embedDesc || '' } });
    }
    return { id: String(id), content: content || '', embeds };
  }

  it('returns messages in chronological order', async () => {
    const thread = mockThread([msg(3), msg(1), msg(2)]);
    const result = await _fetchThreadMessages(thread);
    assert.deepEqual(result.map(m => m.id), ['1', '2', '3']);
  });

  it('filters out starter embeds with Activity Log title', async () => {
    const thread = mockThread([
      msg(1, { embedTitle: '📋 Activity Log — 15 Feb 2026' }),
      msg(2, { embedTitle: '💀 Player Death' }),
      msg(3, { embedTitle: '🔌 Player Connected' }),
    ]);
    const result = await _fetchThreadMessages(thread);
    assert.equal(result.length, 2);
    assert.equal(result[0].id, '2');
    assert.equal(result[1].id, '3');
  });

  it('filters out Log watcher connected startup message', async () => {
    const thread = mockThread([
      msg(1, { embedDesc: '📋 Log watcher connected. Monitoring game server activity.' }),
      msg(2, { embedTitle: '💀 Player Death' }),
    ]);
    const result = await _fetchThreadMessages(thread);
    assert.equal(result.length, 1);
    assert.equal(result[0].id, '2');
  });

  it('keeps text messages', async () => {
    const thread = mockThread([
      msg(1, { content: 'Hello world' }),
    ]);
    const result = await _fetchThreadMessages(thread);
    assert.equal(result.length, 1);
    assert.equal(result[0].content, 'Hello world');
  });

  it('returns empty array for empty thread', async () => {
    const thread = mockThread([]);
    const result = await _fetchThreadMessages(thread);
    assert.deepEqual(result, []);
  });

  it('handles pagination across multiple batches', async () => {
    // Create 150 messages — should require 2 fetch calls (100 + 50)
    const msgs = [];
    for (let i = 1; i <= 150; i++) msgs.push(msg(i, { embedTitle: `Event ${i}` }));
    const thread = mockThread(msgs);
    const result = await _fetchThreadMessages(thread);
    assert.equal(result.length, 150);
    assert.equal(result[0].id, '1');
    assert.equal(result[149].id, '150');
  });
});

// ══════════════════════════════════════════════════════════
// _findMatchingThreads
// ══════════════════════════════════════════════════════════

describe('_findMatchingThreads', () => {
  function mockChannel(activeThreads, archivedThreads) {
    return {
      threads: {
        async fetchActive() {
          const map = new Map();
          for (const t of activeThreads) map.set(t.id, t);
          return { threads: map };
        },
        async fetchArchived() {
          const map = new Map();
          for (const t of archivedThreads) map.set(t.id, t);
          return { threads: map };
        },
      },
    };
  }

  it('finds active threads by name', async () => {
    const ch = mockChannel(
      [{ id: '1', name: '📋 Activity Log — 15 Feb 2026' }],
      [],
    );
    const result = await _findMatchingThreads(ch, '📋 Activity Log — 15 Feb 2026');
    assert.equal(result.length, 1);
  });

  it('finds archived threads by name', async () => {
    const ch = mockChannel(
      [],
      [{ id: '2', name: '📋 Activity Log — 14 Feb 2026' }],
    );
    const result = await _findMatchingThreads(ch, '📋 Activity Log — 14 Feb 2026');
    assert.equal(result.length, 1);
  });

  it('returns empty array when no match', async () => {
    const ch = mockChannel(
      [{ id: '1', name: '📋 Activity Log — 15 Feb 2026' }],
      [],
    );
    const result = await _findMatchingThreads(ch, '📋 Activity Log — 20 Feb 2026');
    assert.equal(result.length, 0);
  });

  it('returns both active and archived matches', async () => {
    const ch = mockChannel(
      [{ id: '1', name: '📋 Activity Log — 15 Feb 2026' }],
      [{ id: '2', name: '📋 Activity Log — 15 Feb 2026' }],
    );
    const result = await _findMatchingThreads(ch, '📋 Activity Log — 15 Feb 2026');
    assert.equal(result.length, 2);
  });

  it('matches legacy thread names without emoji prefix', async () => {
    const ch = mockChannel(
      [{ id: '1', name: 'Activity Log — 15 Feb 2026' }],
      [{ id: '2', name: 'Activity Log - 15 Feb 2026' }],
    );
    const result = await _findMatchingThreads(ch, '📋 Activity Log — 15 Feb 2026', { dateLabel: '15 Feb 2026' });
    assert.equal(result.length, 2);
  });
});

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-require-imports, @typescript-eslint/no-floating-promises, @typescript-eslint/require-await */
'use strict';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { postAdminAlert } = require('../src/utils/admin-alert');

// ── Helpers ──────────────────────────────────────────────────

function mockEmbed() {
  return { title: 'Test', description: 'Alert' };
}

/**
 * Create a mock Discord client with channel stubs.
 */
function mockClient(channelMap: Map<string, object | null> = new Map()) {
  return {
    channels: {
      async fetch(id: string) {
        if (!channelMap.has(id)) return null;
        return channelMap.get(id);
      },
    },
  };
}

function mockChannel() {
  const sent: unknown[] = [];
  return {
    sent,
    send(payload: unknown) {
      sent.push(payload);
      return Promise.resolve();
    },
  };
}

// ══════════════════════════════════════════════════════════════
// postAdminAlert
// ══════════════════════════════════════════════════════════════

describe('postAdminAlert', () => {
  it('sends to all adminAlertChannelIds when provided', async () => {
    const ch1 = mockChannel();
    const ch2 = mockChannel();
    const client = mockClient(
      new Map([
        ['111', ch1],
        ['222', ch2],
      ]),
    );
    const embed = mockEmbed();
    await postAdminAlert(client, embed, { adminAlertChannelIds: ['111', '222'] });
    assert.equal(ch1.sent.length, 1);
    assert.deepEqual(ch1.sent[0], { embeds: [embed] });
    assert.equal(ch2.sent.length, 1);
  });

  it('falls back to fallbackChannelId when adminAlertChannelIds is empty', async () => {
    const ch = mockChannel();
    const client = mockClient(new Map([['999', ch]]));
    await postAdminAlert(client, mockEmbed(), {
      adminAlertChannelIds: [],
      fallbackChannelId: '999',
    });
    assert.equal(ch.sent.length, 1);
  });

  it('falls back to fallbackChannelId when adminAlertChannelIds is undefined', async () => {
    const ch = mockChannel();
    const client = mockClient(new Map([['999', ch]]));
    await postAdminAlert(client, mockEmbed(), { fallbackChannelId: '999' });
    assert.equal(ch.sent.length, 1);
  });

  it('does nothing when both are absent', async () => {
    const client = mockClient(new Map());
    // Should not throw
    await postAdminAlert(client, mockEmbed(), {});
    await postAdminAlert(client, mockEmbed());
  });

  it('skips channels that return null from fetch', async () => {
    const ch2 = mockChannel();
    const client = mockClient(
      new Map([
        ['bad', null],
        ['good', ch2],
      ]),
    );
    await postAdminAlert(client, mockEmbed(), { adminAlertChannelIds: ['bad', 'good'] });
    // 'bad' was skipped, 'good' received the embed
    assert.equal(ch2.sent.length, 1);
  });

  it('continues to next channel when fetch throws', async () => {
    const ch2 = mockChannel();
    const client = {
      channels: {
        async fetch(id: string) {
          if (id === 'broken') throw new Error('fetch failed');
          return ch2;
        },
      },
    };
    await postAdminAlert(client, mockEmbed(), { adminAlertChannelIds: ['broken', 'good'] });
    assert.equal(ch2.sent.length, 1);
  });

  it('continues to next channel when send throws', async () => {
    const failCh = {
      send() {
        return Promise.reject(new Error('send failed'));
      },
    };
    const goodCh = mockChannel();
    const client = mockClient(
      new Map<string, typeof failCh | typeof goodCh>([
        ['fail', failCh],
        ['good', goodCh],
      ]),
    );
    await postAdminAlert(client, mockEmbed(), { adminAlertChannelIds: ['fail', 'good'] });
    assert.equal(goodCh.sent.length, 1);
  });

  it('never throws even when all channels fail', async () => {
    const client = {
      channels: {
        async fetch() {
          throw new Error('everything is broken');
        },
      },
    };
    // Must not throw
    await postAdminAlert(client, mockEmbed(), { adminAlertChannelIds: ['a', 'b', 'c'] });
  });

  it('prefers adminAlertChannelIds over fallbackChannelId', async () => {
    const alertCh = mockChannel();
    const fallbackCh = mockChannel();
    const client = mockClient(
      new Map([
        ['alert', alertCh],
        ['fallback', fallbackCh],
      ]),
    );
    await postAdminAlert(client, mockEmbed(), {
      adminAlertChannelIds: ['alert'],
      fallbackChannelId: 'fallback',
    });
    assert.equal(alertCh.sent.length, 1);
    assert.equal(fallbackCh.sent.length, 0);
  });
});

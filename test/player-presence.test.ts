import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { PlayerPresenceTracker, SESSION_DEDUPE_WINDOW_MS } from '../src/modules/player-presence.js';

type AnyRecord = Record<string, any>;

function makeConfig() {
  return { autoMsgJoinCheckInterval: 60_000 } as any;
}

function makePlaytime() {
  const calls: AnyRecord[] = [];
  return {
    calls,
    playerJoin(id: string, name: string) {
      calls.push({ method: 'playerJoin', id, name });
    },
    playerLeave(id: string) {
      calls.push({ method: 'playerLeave', id });
    },
    recordPlayerCount(count: number) {
      calls.push({ method: 'recordPlayerCount', count });
    },
    recordUniqueToday(id: string) {
      calls.push({ method: 'recordUniqueToday', id });
    },
  };
}

function makeDb(overrides: AnyRecord = {}) {
  const calls: AnyRecord[] = [];
  const db = {
    calls,
    player: {
      setAllPlayersOffline() {
        calls.push({ method: 'setAllPlayersOffline' });
      },
      touchPresence(steamId: string, name: string, online: boolean) {
        calls.push({ method: 'touchPresence', steamId, name, online });
      },
    },
    activityLog: {
      hasRecentActivity(type: string, steamId: string, source: string, windowMs: number) {
        calls.push({ method: 'hasRecentActivity', type, steamId, source, windowMs });
        return false;
      },
      insertActivity(entry: AnyRecord) {
        calls.push({ method: 'insertActivity', entry });
      },
    },
    ...overrides,
  };
  return db;
}

describe('PlayerPresenceTracker session fallback', () => {
  it('seeds current RCON players as online without writing connect activity', async () => {
    const playtime = makePlaytime();
    const db = makeDb();
    const tracker = new PlayerPresenceTracker({
      config: makeConfig(),
      playtime: playtime as any,
      db,
      getPlayerList: async () => ({
        count: 1,
        raw: '',
        players: [{ name: 'Alice', steamId: '76561198000000031' }],
      }),
    });

    await (tracker as any)._seedPlayers();

    assert.deepEqual(db.calls, [
      { method: 'setAllPlayersOffline' },
      { method: 'touchPresence', steamId: '76561198000000031', name: 'Alice', online: true },
    ]);
    assert.deepEqual(playtime.calls, [{ method: 'playerJoin', id: '76561198000000031', name: 'Alice' }]);
    assert.equal((tracker as any)._onlinePlayers.has('76561198000000031'), true);
  });

  it('does not clear online state when initial RCON seed fails', async () => {
    const db = makeDb();
    const tracker = new PlayerPresenceTracker({
      config: makeConfig(),
      playtime: makePlaytime() as any,
      db,
      getPlayerList: async () => {
        throw new Error('rcon down');
      },
    });

    await (tracker as any)._seedPlayers();

    assert.deepEqual(db.calls, []);
    assert.equal((tracker as any)._initialised, true);
  });

  it('writes presence connect events on poll joins unless a recent log event exists', async () => {
    const playtime = makePlaytime();
    const db = makeDb({
      calls: [],
      player: {
        touchPresence(steamId: string, name: string, online: boolean) {
          db.calls.push({ method: 'touchPresence', steamId, name, online });
        },
      },
      activityLog: {
        hasRecentActivity(type: string, steamId: string, source: string, windowMs: number) {
          db.calls.push({ method: 'hasRecentActivity', type, steamId, source, windowMs });
          return steamId === '76561198000000032';
        },
        insertActivity(entry: AnyRecord) {
          db.calls.push({ method: 'insertActivity', entry });
        },
      },
    });
    const tracker = new PlayerPresenceTracker({
      config: makeConfig(),
      playtime: playtime as any,
      db,
      getPlayerList: async () => ({
        count: 2,
        raw: '',
        players: [
          { name: 'Alice', steamId: '76561198000000031' },
          { name: 'Bob', steamId: '76561198000000032' },
        ],
      }),
    });
    (tracker as any)._initialised = true;

    await (tracker as any)._poll();

    assert.ok(
      db.calls.some(
        (call) =>
          call.method === 'insertActivity' &&
          call.entry.type === 'player_connect' &&
          call.entry.category === 'session' &&
          call.entry.steamId === '76561198000000031' &&
          call.entry.source === 'presence',
      ),
    );
    assert.equal(
      db.calls.some((call) => call.method === 'insertActivity' && call.entry.steamId === '76561198000000032'),
      false,
    );
    assert.ok(
      db.calls.some(
        (call) =>
          call.method === 'hasRecentActivity' &&
          call.type === 'player_connect' &&
          call.source === 'log' &&
          call.windowMs === SESSION_DEDUPE_WINDOW_MS,
      ),
    );
    assert.deepEqual(
      playtime.calls.filter((call) => call.method === 'playerJoin').map((call) => call.id),
      ['76561198000000031', '76561198000000032'],
    );
  });

  it('writes presence disconnect events with the remembered player name on leaves', async () => {
    const playtime = makePlaytime();
    const db = makeDb();
    const tracker = new PlayerPresenceTracker({
      config: makeConfig(),
      playtime: playtime as any,
      db,
      getPlayerList: async () => ({ count: 0, raw: '', players: [] }),
    });
    (tracker as any)._initialised = true;
    (tracker as any)._onlinePlayers = new Set(['76561198000000031']);
    (tracker as any)._onlinePlayerNames = new Map([['76561198000000031', 'Alice']]);

    await (tracker as any)._poll();

    assert.ok(db.calls.some((call) => call.method === 'touchPresence' && call.online === false));
    assert.ok(
      db.calls.some(
        (call) =>
          call.method === 'insertActivity' &&
          call.entry.type === 'player_disconnect' &&
          call.entry.actorName === 'Alice' &&
          call.entry.steamId === '76561198000000031',
      ),
    );
    assert.ok(playtime.calls.some((call) => call.method === 'playerLeave' && call.id === '76561198000000031'));
  });
});

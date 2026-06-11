import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import HumanitZDB from '../src/db/database.js';

describe('HumanitZDB.rawQuery', () => {
  let db: HumanitZDB;

  beforeEach(() => {
    db = new HumanitZDB({ memory: true, label: 'RawQueryTest' });
    db.init();
  });

  afterEach(() => {
    db.close();
  });

  it('requires an audit context', () => {
    assert.throws(() => db.rawQuery('SELECT 1', [], { ctx: '' }), /ctx/);
  });

  it('supports read-only all/get queries with positional params', () => {
    db.botState.setState('raw_query_test', 'ok');

    const rows = db.rawQuery('SELECT key, value FROM bot_state WHERE key = ?', ['raw_query_test'], {
      ctx: 'test:all',
    }) as Array<{ key: string; value: string }>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.value, 'ok');

    const row = db.rawQuery('SELECT value FROM bot_state WHERE key = ?', ['raw_query_test'], {
      ctx: 'test:get',
      mode: 'get',
    }) as { value: string } | undefined;
    assert.equal(row?.value, 'ok');
  });

  it('supports named params for read-only queries', () => {
    db.botState.setState('raw_query_named_test', 'ok');

    const row = db.rawQuery(
      'SELECT value FROM bot_state WHERE key = @key',
      { key: 'raw_query_named_test' },
      {
        ctx: 'test:named',
        mode: 'get',
      },
    ) as { value: string } | undefined;

    assert.equal(row?.value, 'ok');
  });

  it('allowlists read-only PRAGMA and rejects mutating PRAGMA', () => {
    const rows = db.rawQuery('PRAGMA table_info("bot_state")', [], { ctx: 'test:pragma' });
    assert.ok(rows.some((row) => row.name === 'key'));

    assert.throws(
      () => db.rawQuery('PRAGMA journal_mode = WAL', [], { ctx: 'test:mutating-pragma' }),
      /mutating PRAGMA/,
    );
    assert.throws(
      () => db.rawQuery('PRAGMA optimize', [], { ctx: 'test:non-allowlisted-pragma' }),
      /non-allowlisted PRAGMA/,
    );
  });

  it('blocks mutations unless explicitly enabled', () => {
    assert.throws(
      () => db.rawQuery('DELETE FROM bot_state', [], { ctx: 'test:blocked', mode: 'get' }),
      /read mode only allows/,
    );
    assert.throws(
      () => db.rawQuery('DELETE FROM bot_state', [], { ctx: 'test:blocked-run', mode: 'run' } as never),
      /mutation=true/,
    );
    assert.throws(
      () =>
        db.rawQuery('DELETE FROM bot_state', [], {
          ctx: 'test:blocked-mutation-all',
          mode: 'all',
          mutation: true,
        } as never),
      /requires run mode/,
    );
  });

  it('allows explicit mutation mode for admin console operations', () => {
    const info = db.rawQuery('INSERT INTO bot_state (key, value) VALUES (?, ?)', ['raw_query_mutation', 'ok'], {
      ctx: 'test:mutation',
      mode: 'run',
      mutation: true,
    });
    assert.equal(info.changes, 1);
    assert.equal(db.botState.getState('raw_query_mutation'), 'ok');
  });
});

describe('PR3 repository migration helpers', () => {
  let db: HumanitZDB;

  beforeEach(() => {
    db = new HumanitZDB({ memory: true, label: 'RepositoryMigrationTest' });
    db.init();
  });

  afterEach(() => {
    db.close();
  });

  it('repairs numeric activity actors through ActivityLogRepository', () => {
    const steamId = '76561198000000000';
    db.activityLog.insertActivity({
      type: 'inventory',
      category: 'inventory',
      actor: steamId,
      actorName: steamId,
      item: 'Wood',
      details: { action: 'test' },
    });

    const fixed = db.activityLog.repairActorNames({ [steamId]: 'Alice' });
    const row = db.rawQuery('SELECT actor_name FROM activity_log WHERE actor = ?', [steamId], {
      ctx: 'test:repair-activity-actor',
      mode: 'get',
    }) as { actor_name: string } | undefined;

    assert.equal(fixed, 1);
    assert.equal(row?.actor_name, 'Alice');
  });

  it('normalizes activity steam attribution from numeric actor and attribution aliases', () => {
    const actorSteamId = '76561198000000001';
    const attributedSteamId = '76561198000000002';

    db.activityLog.insertActivity({
      type: 'inventory_item_added',
      category: 'inventory',
      actor: actorSteamId,
      actorName: 'Alice',
      item: 'Nails',
      details: '{"source":"inventory"}',
    });
    db.activityLog.insertActivities([
      {
        type: 'container_item_added',
        category: 'container',
        actor: 'House_Chest_1',
        actor_name: 'House Chest',
        item: 'Rope',
        details: { durability: 88 },
        attributed_steam_id: attributedSteamId,
        attributed_player: 'Bob',
      },
    ]);

    const rows = db.rawQuery('SELECT actor, actor_name, steam_id, details FROM activity_log ORDER BY id ASC', [], {
      ctx: 'test:activity-attribution-normalization',
    }) as Array<{ actor: string; actor_name: string; steam_id: string; details: string }>;

    const inventoryRow = rows[0];
    const containerRow = rows[1];
    assert.ok(inventoryRow);
    assert.ok(containerRow);
    assert.equal(inventoryRow.actor, actorSteamId);
    assert.equal(inventoryRow.steam_id, actorSteamId);
    assert.deepEqual(JSON.parse(inventoryRow.details || '{}'), { source: 'inventory' });

    assert.equal(containerRow.actor, 'House_Chest_1');
    assert.equal(containerRow.actor_name, 'House Chest');
    assert.equal(containerRow.steam_id, attributedSteamId);
    assert.deepEqual(JSON.parse(containerRow.details || '{}'), {
      durability: 88,
      attributedPlayer: 'Bob',
      attributedSteamId,
    });
  });

  it('searches activity with category scope, exact steam IDs, and escaped LIKE terms', () => {
    const steamId = '76561198000000003';
    db.activityLog.insertActivities([
      {
        type: 'container_item_added',
        category: 'container',
        actor: 'House_Chest_1',
        actorName: 'House Chest',
        item: 'Rope_100%',
        details: { note: 'literal wildcard item' },
        attributedSteamId: steamId,
        attributedPlayer: 'Carol',
      },
      {
        type: 'inventory_item_added',
        category: 'inventory',
        actor: steamId,
        actorName: 'Carol',
        item: 'Rope_100%',
        details: { note: 'inventory copy' },
      },
    ]);

    const scopedBySteamId = db.activityLog.searchActivity(steamId, { category: 'container', limit: 20 });
    assert.equal(scopedBySteamId.length, 1);
    const scopedMatch = scopedBySteamId[0];
    assert.ok(scopedMatch);
    assert.equal(scopedMatch.category, 'container');
    assert.equal(scopedMatch.actor, 'House_Chest_1');

    const escapedLike = db.activityLog.searchActivity('Rope_100%', { category: 'container', limit: 20 });
    assert.equal(escapedLike.length, 1);
    const escapedMatch = escapedLike[0];
    assert.ok(escapedMatch);
    assert.equal(escapedMatch.item, 'Rope_100%');

    assert.deepEqual(db.activityLog.searchActivity('A'), []);
  });

  it('searches explicit activity modes without treating ambiguous candidates as player events', () => {
    const steamId = '76561198000000003';
    db.activityLog.insertActivities([
      {
        type: 'container_item_removed',
        category: 'container',
        actor: 'BuildContainer_1134',
        actorName: 'BuildContainer_1134',
        item: 'Fork',
        amount: 1,
        details: {
          attribution: {
            status: 'attributed',
            source: 'save-diff-inventory-crossref',
            reason: 'unique matching inventory delta',
            matchAmount: 1,
            candidateCount: 1,
            matchedCandidates: [{ steamId, name: 'Carol', matchAmount: 1 }],
          },
        },
        attributedSteamId: steamId,
        attributedPlayer: 'Carol',
      },
      {
        type: 'container_item_added',
        category: 'container',
        actor: 'BuildContainer_9999',
        actorName: 'BuildContainer_9999',
        item: 'Fork',
        amount: 1,
        details: {
          attribution: {
            status: 'ambiguous',
            source: 'save-diff-inventory-crossref',
            reason: 'tie',
            matchAmount: 1,
            candidateCount: 2,
            matchedCandidates: [{ steamId, name: 'Carol', matchAmount: 1 }],
          },
        },
      },
      {
        type: 'player_death_pvp',
        category: 'combat',
        actor: '76561198000000004',
        actorName: 'Dave',
        targetSteamId: steamId,
        targetName: 'Carol',
      },
    ]);
    db.rawQuery(
      `INSERT INTO activity_log (type, category, actor, actor_name, item, details, steam_id, source)
       VALUES (?, ?, ?, ?, ?, ?, '', ?)`,
      ['inventory_item_removed', 'inventory', steamId, 'Carol', 'Fork', '{}', 'log'],
      { ctx: 'test:legacy-actor-only-player-activity', mode: 'run', mutation: true },
    );

    const playerRows = db.activityLog.searchActivityByPlayer(steamId, { limit: 20 });
    assert.equal(playerRows.length, 3);
    assert.ok(playerRows.some((row) => row?.actor === 'BuildContainer_1134'));
    assert.ok(playerRows.some((row) => row?.target_steam_id === steamId));
    assert.ok(playerRows.some((row) => row?.type === 'inventory_item_removed' && row.actor === steamId));
    assert.ok(!playerRows.some((row) => row?.actor === 'BuildContainer_9999'));

    const itemRows = db.activityLog.searchActivityByItem('Fork', { limit: 20 });
    assert.equal(itemRows.length, 3);

    const containerRows = db.activityLog.searchActivityByContainer('BuildContainer_1134', { limit: 20 });
    assert.equal(containerRows.length, 1);
    assert.equal(containerRows[0]?.actor, 'BuildContainer_1134');
  });

  it('separates reliable top players from container actors', () => {
    const steamId = '76561198000000003';
    db.activityLog.insertActivities([
      {
        type: 'inventory_item_added',
        category: 'inventory',
        actor: steamId,
        actorName: 'Carol',
        item: 'Fork',
      },
      {
        type: 'container_item_added',
        category: 'container',
        actor: 'BuildContainer_1134',
        actorName: 'BuildContainer_1134',
        item: 'Fork',
      },
      {
        type: 'container_item_removed',
        category: 'container',
        actor: 'BuildContainer_1134',
        actorName: 'BuildContainer_1134',
        item: 'Fork',
        details: {
          attribution: {
            status: 'attributed',
            source: 'save-diff-inventory-crossref',
            reason: 'unique matching inventory delta',
            matchAmount: 1,
            candidateCount: 1,
          },
        },
        attributedSteamId: steamId,
        attributedPlayer: 'Carol',
      },
    ]);
    db.rawQuery(
      `INSERT INTO activity_log (type, category, actor, actor_name, item, details, steam_id, source)
       VALUES (?, ?, ?, ?, ?, ?, '', ?)`,
      ['player_connect', 'session', steamId, 'Carol', '', '{}', 'log'],
      { ctx: 'test:legacy-actor-only-top-player', mode: 'run', mutation: true },
    );

    const topPlayers = db.activityLog.topPlayers(7, 10) as Array<{ steam_id: string; count: number }>;
    assert.equal(topPlayers.length, 1);
    const topPlayer = topPlayers[0];
    assert.ok(topPlayer);
    assert.equal(topPlayer.steam_id, steamId);
    assert.equal(topPlayer.count, 3);

    const topContainers = db.activityLog.topContainers(7, 10) as Array<{ actor: string; count: number }>;
    assert.equal(topContainers.length, 1);
    const topContainer = topContainers[0];
    assert.ok(topContainer);
    assert.equal(topContainer.actor, 'BuildContainer_1134');
    assert.equal(topContainer.count, 2);
  });

  it('loads diff player candidates only by explicit Steam IDs', () => {
    db.rawQuery(
      `INSERT INTO players (steam_id, name, online, inventory, equipment, quick_slots, backpack_items)
       VALUES (?, ?, ?, ?, '[]', '[]', '[]'), (?, ?, ?, ?, '[]', '[]', '[]')`,
      [
        '76561198000000011',
        'Online Alice',
        1,
        JSON.stringify([{ item: 'Nails', amount: 4 }]),
        '76561198000000012',
        'Offline Bob',
        0,
        JSON.stringify([{ item: 'Rope', amount: 1 }]),
      ],
      { ctx: 'test:seed-diff-candidates', mode: 'run', mutation: true },
    );

    assert.deepEqual(db.player.getPlayersForDiffBySteamIds([]), []);

    const rows = db.player.getPlayersForDiffBySteamIds(['76561198000000012', 'not-a-steam-id']);
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.ok(row);
    assert.equal(row.steam_id, '76561198000000012');
    assert.equal(row.online, false);
    assert.deepEqual(row.inventory, [{ item: 'Rope', amount: 1 }]);
  });

  it('touches presence without overwriting rich player columns and registers aliases', () => {
    const steamId = '76561198000000013';
    db.rawQuery(
      `INSERT INTO players (steam_id, name, online, inventory, equipment, pos_x, playtime_seconds)
       VALUES (?, ?, 0, ?, ?, 123, 999)`,
      [
        steamId,
        'OldName',
        JSON.stringify([{ item: 'Nails', amount: 1 }]),
        JSON.stringify([{ item: 'Axe', amount: 1 }]),
      ],
      { ctx: 'test:seed-presence-player', mode: 'run', mutation: true },
    );

    db.player.touchPresence(steamId, 'NewName', true);

    const row = db.rawQuery(
      'SELECT name, online, inventory, equipment, pos_x, playtime_seconds FROM players WHERE steam_id = ?',
      [steamId],
      { ctx: 'test:presence-player', mode: 'get' },
    ) as {
      name: string;
      online: number;
      inventory: string;
      equipment: string;
      pos_x: number;
      playtime_seconds: number;
    };

    assert.equal(row.name, 'NewName');
    assert.equal(row.online, 1);
    assert.equal(row.pos_x, 123);
    assert.equal(row.playtime_seconds, 999);
    assert.deepEqual(JSON.parse(row.inventory), [{ item: 'Nails', amount: 1 }]);
    assert.deepEqual(JSON.parse(row.equipment), [{ item: 'Axe', amount: 1 }]);
    assert.equal(db.player.resolveNameToSteamId('NewName')?.steamId, steamId);
  });

  it('detects recent activity by type, Steam ID, source, and window', () => {
    const steamId = '76561198000000014';
    const legacySteamId = '76561198000000015';
    db.activityLog.insertActivitiesAt([
      {
        type: 'player_connect',
        category: 'session',
        actor: steamId,
        actorName: 'Alice',
        steamId,
        source: 'log',
        createdAt: '2026-05-24T12:00:00.000Z',
      },
    ]);
    const handle = db.db;
    assert.ok(handle);
    handle
      .prepare(
        `INSERT INTO activity_log (type, category, actor, actor_name, steam_id, source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('player_connect', 'session', legacySteamId, 'LegacyAlice', legacySteamId, 'log', '2026-05-24T12:00:00.000Z');

    const stored = db.rawQuery('SELECT created_at FROM activity_log WHERE steam_id = ?', [steamId], {
      ctx: 'test:activity-recent-created-at',
      mode: 'get',
    }) as { created_at: string } | undefined;
    assert.equal(stored?.created_at, '2026-05-24 12:00:00');

    assert.equal(
      db.activityLog.hasRecentActivity('player_connect', steamId, 'log', 60_000, new Date('2026-05-24T12:00:30.000Z')),
      true,
    );
    assert.equal(
      db.activityLog.hasRecentActivity(
        'player_connect',
        legacySteamId,
        'log',
        60_000,
        new Date('2026-05-24T12:00:30.000Z'),
      ),
      true,
    );
    assert.equal(
      db.activityLog.hasRecentActivity('player_connect', steamId, 'log', 60_000, new Date('2026-05-24T12:02:00.000Z')),
      false,
    );
    assert.equal(
      db.activityLog.hasRecentActivity(
        'player_disconnect',
        steamId,
        'log',
        60_000,
        new Date('2026-05-24T12:00:30.000Z'),
      ),
      false,
    );

    const indexes = db.rawQuery('PRAGMA index_list("activity_log")', [], {
      ctx: 'test:activity-recent-index',
    }) as Array<{ name: string }>;
    assert.ok(indexes.some((row) => row.name === 'idx_activity_recent_dedupe'));
  });

  it('normalizes explicit DB wall-clock timestamp writes to canonical UTC text', () => {
    const steamId = '76561198000000123';

    db.chatLog.insertChatAt({
      type: 'game',
      playerName: 'Alice',
      steamId,
      message: 'hello',
      createdAt: '2026-05-25T09:53:29.769Z',
    });
    const chat = db.rawQuery('SELECT created_at FROM chat_log WHERE steam_id = ?', [steamId], {
      ctx: 'test:chat-timestamp-normalized',
      mode: 'get',
    }) as { created_at: string } | undefined;
    assert.equal(chat?.created_at, '2026-05-25 09:53:29');

    db.activityLog.insertActivitiesAt([
      {
        type: 'loot',
        category: 'inventory',
        actor: steamId,
        actorName: 'Alice',
        item: 'Bandage',
        createdAt: '2026-05-25T09:54:30.123Z',
      },
    ]);
    const activity = db.rawQuery('SELECT created_at FROM activity_log WHERE actor = ?', [steamId], {
      ctx: 'test:activity-timestamp-normalized',
      mode: 'get',
    }) as { created_at: string } | undefined;
    assert.equal(activity?.created_at, '2026-05-25 09:54:30');

    db.player.upsertFullPlaytime(steamId, {
      name: 'Alice',
      totalMs: 123_000,
      sessions: 1,
      firstSeen: '2026-05-25T09:53:29.769Z',
      lastLogin: new Date('2026-05-25T10:00:00.999Z'),
      lastSeen: '2026-05-25 10:01:02',
    });
    db.player.upsertFullLogStats(steamId, {
      name: 'Alice',
      cheatFlags: [{ type: 'speed', timestamp: '2026-05-25T10:02:03.456Z' }],
      lastEvent: '2026-05-25T10:03:04.567Z',
    });
    db.player.updatePlayerName(steamId, 'Alice2', [{ name: 'Alice', until: '2026-05-25T10:04:05.678Z' }]);
    db.player.setServerPeak('all_time_peak_date', '2026-05-25T10:05:06.789Z');
    db.player.setServerPeak('today_date', '2026-05-25');

    const player = db.rawQuery(
      `SELECT playtime_first_seen, playtime_last_login, playtime_last_seen,
              log_last_event, log_cheat_flags, name_history
       FROM players WHERE steam_id = ?`,
      [steamId],
      { ctx: 'test:player-timestamp-normalized', mode: 'get' },
    ) as {
      playtime_first_seen: string;
      playtime_last_login: string;
      playtime_last_seen: string;
      log_last_event: string;
      log_cheat_flags: string;
      name_history: string;
    };

    assert.equal(player.playtime_first_seen, '2026-05-25 09:53:29');
    assert.equal(player.playtime_last_login, '2026-05-25 10:00:00');
    assert.equal(player.playtime_last_seen, '2026-05-25 10:01:02');
    assert.equal(player.log_last_event, '2026-05-25 10:03:04');
    assert.deepEqual(JSON.parse(player.log_cheat_flags), [{ type: 'speed', timestamp: '2026-05-25 10:02:03' }]);
    assert.deepEqual(JSON.parse(player.name_history), [{ name: 'Alice', until: '2026-05-25 10:04:05' }]);

    const peaks = db.rawQuery(
      'SELECT key, value FROM server_peaks WHERE key IN (?, ?) ORDER BY key',
      ['all_time_peak_date', 'today_date'],
      {
        ctx: 'test:server-peak-timestamp-normalized',
      },
    ) as Array<{ key: string; value: string }>;
    assert.deepEqual(peaks, [
      { key: 'all_time_peak_date', value: '2026-05-25 10:05:06' },
      { key: 'today_date', value: '2026-05-25' },
    ]);
    assert.throws(() => {
      db.chatLog.insertChatAt({
        type: 'game',
        playerName: 'Alice',
        steamId,
        message: 'bad timestamp',
        createdAt: 'not-a-timestamp',
      });
    }, /Invalid chat createdAt timestamp/);
    assert.throws(() => {
      db.activityLog.insertActivitiesAt([
        {
          type: 'loot',
          category: 'inventory',
          actor: steamId,
          actorName: 'Alice',
          item: 'Bad Timestamp',
          createdAt: 'not-a-timestamp',
        },
      ]);
    }, /Invalid activity createdAt timestamp/);

    const invalidSteamId = '76561198000000124';
    db.player.upsertFullLogStats(invalidSteamId, {
      name: 'Bob',
      cheatFlags: [{ type: 'speed', timestamp: 'not-a-timestamp' }, { type: 'note' }],
      lastEvent: 'not-a-timestamp',
    });
    db.player.updatePlayerName(invalidSteamId, 'Bob2', [{ name: 'Bob', until: 'not-a-timestamp' }, { name: 'Bobby' }]);
    db.player.setServerPeak('unique_day_peak_date', 'not-a-timestamp');
    const invalidPlayer = db.rawQuery(
      'SELECT log_last_event, log_cheat_flags, name_history FROM players WHERE steam_id = ?',
      [invalidSteamId],
      {
        ctx: 'test:player-invalid-timestamp-normalized',
        mode: 'get',
      },
    ) as { log_last_event: string | null; log_cheat_flags: string; name_history: string };
    assert.equal(invalidPlayer.log_last_event, null);
    assert.deepEqual(JSON.parse(invalidPlayer.log_cheat_flags), [{ type: 'speed', timestamp: null }, { type: 'note' }]);
    assert.deepEqual(JSON.parse(invalidPlayer.name_history), [{ name: 'Bob', until: null }, { name: 'Bobby' }]);
    const invalidPeak = db.rawQuery('SELECT value FROM server_peaks WHERE key = ?', ['unique_day_peak_date'], {
      ctx: 'test:server-peak-invalid-timestamp-normalized',
      mode: 'get',
    }) as { value: string } | undefined;
    assert.equal(invalidPeak?.value, '');
  });

  it('self-heals the recent activity dedupe index when migrating from v16', () => {
    db.db?.exec('DROP INDEX IF EXISTS idx_activity_recent_dedupe');
    db._setMeta('schema_version', '16');
    db._applySchema();

    const indexes = db.rawQuery('PRAGMA index_list("activity_log")', [], {
      ctx: 'test:activity-recent-index-migration',
    }) as Array<{ name: string }>;
    assert.ok(indexes.some((row) => row.name === 'idx_activity_recent_dedupe'));
    assert.equal(db._getMeta('schema_version'), '22');
  });

  it('reads canonical activity categories across legacy category aliases without backfilling old rows', () => {
    db.activityLog.insertActivities([
      {
        type: 'building_destroyed',
        category: 'raid',
        actor: 'Alice',
        actorName: 'Alice',
        item: 'Wood Wall',
      },
      {
        type: 'container_loot',
        category: 'loot',
        actor: 'Bob',
        actorName: 'Bob',
        item: 'Crate',
      },
      {
        type: 'player_death',
        category: 'death',
        actor: 'Carol',
        actorName: 'Carol',
        item: 'Zombie',
      },
    ]);

    const before = db.rawQuery(
      "SELECT COUNT(*) AS count, SUM(CASE WHEN steam_id = '' THEN 1 ELSE 0 END) AS empty_ids FROM activity_log",
      [],
      {
        ctx: 'test:legacy-category-before',
        mode: 'get',
      },
    ) as { count: number; empty_ids: number };

    assert.equal(
      db.activityLog.getActivityByCategory('structure').some((row) => row?.category === 'raid'),
      true,
    );
    assert.equal(
      db.activityLog.getActivityByCategory('container').some((row) => row?.category === 'loot'),
      true,
    );
    assert.equal(
      db.activityLog.getActivityByCategory('combat').some((row) => row?.category === 'death'),
      true,
    );
    assert.equal(
      db.activityLog.getActivityByCategory('build').some((row) => row?.category === 'raid'),
      true,
    );
    assert.equal(
      db.activityLog.searchActivity('Carol', { category: 'combat' }).some((row) => row?.category === 'death'),
      true,
    );

    const after = db.rawQuery(
      "SELECT COUNT(*) AS count, SUM(CASE WHEN steam_id = '' THEN 1 ELSE 0 END) AS empty_ids FROM activity_log",
      [],
      {
        ctx: 'test:legacy-category-after',
        mode: 'get',
      },
    ) as { count: number; empty_ids: number };
    assert.deepEqual(after, before);
  });

  it('finds professions through the dedicated profession lookup fields', () => {
    db.gameData.seedGameProfessions([
      {
        id: 'Farmer',
        enumValue: 'Enum_Professions::NewEnumerator4',
        enumIndex: 4,
        perk: 'Grow food faster',
        description: 'Agricultural survivor',
        affliction: 'Hay Fever',
        skills: ['Farming'],
      },
    ]);

    const byId = db.gameData.findByName('game_professions', 'Farmer') as { id?: string } | undefined;
    const byPerk = db.gameData.findByName('game_professions', 'Grow food') as { id?: string } | undefined;

    assert.equal(byId?.id, 'Farmer');
    assert.equal(byPerk?.id, 'Farmer');
  });
});

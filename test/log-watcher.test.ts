/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-floating-promises, @typescript-eslint/require-await, @typescript-eslint/no-non-null-assertion */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Regex patterns extracted from LogWatcher for isolated testing

const LOG_LINE_RE = /^\((\d{1,2})[/\-.](\d{1,2})[/\-.](\d{1,2},?\d{3})\s+(\d{1,2}):(\d{1,2})(?::\d{1,2})?\)\s+(.+)$/;
const CONNECT_RE =
  /^Player (Connected|Disconnected)\s+(.+?)\s+NetID\((\d{17})[^)]*\)\s*\((\d{1,2})[/\-.](\d{1,2})[/\-.](\d{1,2},?\d{3})\s+(\d{1,2}):(\d{1,2})(?::\d{1,2})?\)/;
const DEATH_RE = /^Player died \((.+)\)$/;
const BUILD_RE = /^(.+?)\((\d{17})[^)]*\)\s*finished building\s+(.+)$/;
const DMG_RE = /^(.+?)\s+took\s+([\d.]+)\s+damage from\s+(.+)$/;
const LOOT_RE = /^(.+?)\s*\((\d{17})[^)]*\)\s*looted a container\s*\(([^)]+)\)\s*owner by\s*(\d{17})/;
const ADMIN_RE = /^(.+?)\s+gained admin access!$/;
const CHEAT_RE = /^(Stack limit detected in drop function|Odd behavior.*?Cheat)\s*\((.+?)\s*-\s*(\d{17})/;
const DROP_MISMATCH_RE = /^Client drop request count mismatch\s*\([^)]*\)\s*\((.+?)\s*-\s*amount\s*(\d+)/i;
const SPEED_WARN_RE = /^(.+?)\s+suspected of speed hacking\s+Warn\s*=>\s*(\d+)\/(\d+)/;
const SPEED_KICK_RE = /^(.+?)\s+will be kicked for speed-hack strong suspicion\s+ID\s*=\s*(\d{17})/;
const ADMIN_KICK_RE = /^(Kicked (?:for|player for)\s+.+?)(?:\.\s*|$)/;
const BAD_SPAWN_RE = /^(?:Detected )?[Bb]ad spawn location/i;
const RAID_RE =
  /^Building \(([^)]+)\) owned by \((\d{17}[^)]*)\) damaged \([\d.]+\) by (.+?)(?:\((\d{17})[^)]*\))?(\s*\(Destroyed\))?$/;

function simplifyBlueprintName(rawName: string): string {
  return rawName
    .replace(/^BP_/, '')
    .replace(/_C_\d+.*$/, '')
    .replace(/_C$/, '')
    .replace(/_/g, ' ')
    .trim();
}

describe('log line timestamp parsing', () => {
  it('parses standard format', () => {
    const m = LOG_LINE_RE.exec('(13/2/2026 12:35) Player died (TestPlayer)');
    assert.ok(m);
    assert.equal(m[1], '13');
    assert.equal(m[2], '2');
    assert.equal(m[3], '2026');
    assert.equal(m[4], '12');
    assert.equal(m[5], '35');
    assert.equal(m[6], 'Player died (TestPlayer)');
  });

  it('parses comma-in-year format', () => {
    const m = LOG_LINE_RE.exec('(13/2/2,026 12:35) Player died (TestPlayer)');
    assert.ok(m);
    assert.equal(m[3], '2,026');
  });

  it('parses with seconds', () => {
    const m = LOG_LINE_RE.exec('(13/2/2026 12:35:42) Player died (TestPlayer)');
    assert.ok(m);
    assert.equal(m[4], '12');
    assert.equal(m[5], '35');
  });

  it('parses dash separator', () => {
    const m = LOG_LINE_RE.exec('(13-2-2026 12:35) Player died (TestPlayer)');
    assert.ok(m);
  });

  it('parses dot separator', () => {
    const m = LOG_LINE_RE.exec('(13.2.2026 12:35) Player died (TestPlayer)');
    assert.ok(m);
  });

  it('rejects malformed lines', () => {
    assert.equal(LOG_LINE_RE.exec('not a log line'), null);
    assert.equal(LOG_LINE_RE.exec('(no_date) message'), null);
  });
});

describe('death regex', () => {
  it('matches player death', () => {
    const m = DEATH_RE.exec('Player died (TestPlayer)');
    assert.ok(m);
    assert.equal(m[1], 'TestPlayer');
  });

  it('matches death with spaces in name', () => {
    const m = DEATH_RE.exec('Player died (Some Player Name)');
    assert.ok(m);
    assert.equal(m[1], 'Some Player Name');
  });
});

describe('build regex', () => {
  it('matches building completed', () => {
    const m = BUILD_RE.exec('TestPlayer(76561100000000001) finished building BP_Wall_Wood_C');
    assert.ok(m);
    assert.equal(m[1], 'TestPlayer');
    assert.equal(m[2], '76561100000000001');
    assert.equal(m[3], 'BP_Wall_Wood_C');
  });

  it('matches name directly adjacent to parenthesis', () => {
    const m = BUILD_RE.exec('Some Player(76561100000000001) finished building BP_Floor_C');
    assert.ok(m);
    assert.equal(m[1], 'Some Player');
  });
});

describe('damage regex', () => {
  it('matches damage taken', () => {
    const m = DMG_RE.exec('TestPlayer took 15.5 damage from BP_Zombie_C_123');
    assert.ok(m);
    assert.equal(m[1], 'TestPlayer');
    assert.equal(m[2], '15.5');
    assert.equal(m[3], 'BP_Zombie_C_123');
  });

  it('matches integer damage', () => {
    const m = DMG_RE.exec('Player took 10 damage from BP_Wolf_C');
    assert.ok(m);
    assert.equal(m[2], '10');
  });
});

describe('loot regex', () => {
  it('matches container looting', () => {
    const m = LOOT_RE.exec('TestPlayer (76561100000000001) looted a container (Chest) owner by 76561100000000002');
    assert.ok(m);
    assert.equal(m[1], 'TestPlayer');
    assert.equal(m[2], '76561100000000001');
    assert.equal(m[3], 'Chest');
    assert.equal(m[4], '76561100000000002');
  });
});

describe('admin regex', () => {
  it('matches admin access', () => {
    const m = ADMIN_RE.exec('TestPlayer gained admin access!');
    assert.ok(m);
    assert.equal(m[1], 'TestPlayer');
  });
});

describe('cheat regex', () => {
  it('matches stack limit cheat', () => {
    const m = CHEAT_RE.exec('Stack limit detected in drop function (TestPlayer - 76561100000000001)');
    assert.ok(m);
    assert.equal(m[1], 'Stack limit detected in drop function');
    assert.equal(m[2], 'TestPlayer');
    assert.equal(m[3], '76561100000000001');
  });

  it('matches odd behavior cheat', () => {
    const m = CHEAT_RE.exec('Odd behavior Drop amount Cheat (BadPlayer - 76561100000000002)');
    assert.ok(m);
    assert.equal(m[1], 'Odd behavior Drop amount Cheat');
    assert.equal(m[2], 'BadPlayer');
    assert.equal(m[3], '76561100000000002');
  });

  it('matches client drop request count mismatch', () => {
    const m = DROP_MISMATCH_RE.exec('Client drop request count mismatch (Potential cheat) (Hacker - amount 5)');
    assert.ok(m);
    assert.equal(m[1], 'Hacker');
    assert.equal(m[2], '5');
  });
});

describe('speed hack detection', () => {
  it('matches speed hack warning', () => {
    const m = SPEED_WARN_RE.exec('TestPlayer suspected of speed hacking Warn => 2/3');
    assert.ok(m);
    assert.equal(m[1], 'TestPlayer');
    assert.equal(m[2], '2');
    assert.equal(m[3], '3');
  });

  it('matches first speed hack warning', () => {
    const m = SPEED_WARN_RE.exec('SomePlayer suspected of speed hacking Warn => 1/3');
    assert.ok(m);
    assert.equal(m[1], 'SomePlayer');
    assert.equal(m[2], '1');
    assert.equal(m[3], '3');
  });

  it('matches speed hack kick', () => {
    const m = SPEED_KICK_RE.exec('TestPlayer will be kicked for speed-hack strong suspicion ID = 76561100000000001');
    assert.ok(m);
    assert.equal(m[1], 'TestPlayer');
    assert.equal(m[2], '76561100000000001');
  });
});

describe('admin abuse detection', () => {
  it('matches unauthorised command kick', () => {
    const body = 'Kicked for executing unauthorised command';
    const m = ADMIN_KICK_RE.exec(body);
    assert.ok(m);
    assert.ok(/unauthoris/i.test(body));
  });

  it('matches admin panel kick', () => {
    const body = 'Kicked for opening admin panel with no admin privilege. Ban would be justified.';
    const m = ADMIN_KICK_RE.exec(body);
    assert.ok(m);
    assert.ok(/admin panel/i.test(body));
  });

  it('matches system message kick', () => {
    const body = 'Kicked player for trying to send a system message when not admin. Cheater probably.';
    const m = ADMIN_KICK_RE.exec(body);
    assert.ok(m);
    assert.ok(/system message/i.test(body));
  });

  it('matches suspicious behavior kick', () => {
    const body = 'Kicked player for suspicious behavior';
    const m = ADMIN_KICK_RE.exec(body);
    assert.ok(m);
    assert.ok(/suspicious behavior/i.test(body));
  });
});

describe('bad spawn detection', () => {
  it('matches detected bad spawn', () => {
    assert.ok(BAD_SPAWN_RE.test('Detected bad spawn location, adjusting to coast spawn, sorry for the inconvenience!'));
  });

  it('matches bad spawn forcing default', () => {
    assert.ok(BAD_SPAWN_RE.test('Bad spawn location, forcing default coast spawn location'));
  });
});

describe('raid regex', () => {
  it('matches building damage with destroyer', () => {
    const m = RAID_RE.exec(
      'Building (BP_Wall_C) owned by (76561100000000002) damaged (50.0) by attacker(76561100000000001) (Destroyed)',
    );
    assert.ok(m);
    assert.equal(m[1], 'BP_Wall_C');
    assert.ok(m[2]!.startsWith('76561100000000002'));
    assert.equal(m[4], '76561100000000001');
    assert.ok(m[5]);
  });

  it('matches building damage without Destroyed', () => {
    const m = RAID_RE.exec(
      'Building (BP_Wall_C) owned by (76561100000000002) damaged (25.0) by attacker(76561100000000001)',
    );
    assert.ok(m);
    assert.equal(m[5], undefined);
  });
});

describe('connect line parsing', () => {
  it('parses Connected line', () => {
    const line = 'Player Connected TestPlayer NetID(76561100000000001) (13/2/2026 12:35)';
    const m = CONNECT_RE.exec(line);
    assert.ok(m);
    assert.equal(m[1], 'Connected');
    assert.equal(m[2], 'TestPlayer');
    assert.equal(m[3], '76561100000000001');
  });

  it('parses Disconnected line', () => {
    const line = 'Player Disconnected TestPlayer NetID(76561100000000001) (13/2/2026 12:35)';
    const m = CONNECT_RE.exec(line);
    assert.ok(m);
    assert.equal(m[1], 'Disconnected');
  });

  it('handles name with spaces', () => {
    const line = 'Player Connected Some Player NetID(76561100000000001) (13/2/2026 12:35)';
    const m = CONNECT_RE.exec(line);
    assert.ok(m);
    assert.equal(m[2], 'Some Player');
  });

  it('handles comma in year', () => {
    const line = 'Player Connected TestPlayer NetID(76561100000000001) (13/2/2,026 12:35)';
    const m = CONNECT_RE.exec(line);
    assert.ok(m);
    assert.equal(m[6], '2,026');
  });

  it('rejects non-connect lines', () => {
    assert.equal(CONNECT_RE.exec('some random line'), null);
  });
});

describe('simplifyBlueprintName', () => {
  it('strips BP_ prefix', () => {
    assert.equal(simplifyBlueprintName('BP_WallWood'), 'WallWood');
  });

  it('strips _C suffix', () => {
    assert.equal(simplifyBlueprintName('BP_Wall_C'), 'Wall');
  });

  it('strips _C_12345 suffix', () => {
    assert.equal(simplifyBlueprintName('BP_WallWood_C_12345'), 'WallWood');
  });

  it('replaces underscores with spaces', () => {
    assert.equal(simplifyBlueprintName('BP_Wall_Wood_C'), 'Wall Wood');
  });

  it('handles plain names', () => {
    assert.equal(simplifyBlueprintName('SimpleItem'), 'SimpleItem');
  });

  it('handles complex UE4 names', () => {
    assert.equal(simplifyBlueprintName('BP_Item_Name_With_Parts_C_98765432'), 'Item Name With Parts');
  });
});

describe('_nukeActive thread suppression', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- dynamic require for test isolation
  const LogWatcher = require('../src/modules/log-watcher');

  // eslint-disable-next-line @typescript-eslint/no-require-imports -- dynamic require for test isolation
  const ChatRelay = require('../src/modules/chat-relay');

  const mockClient = { channels: { fetch: async () => null }, on: () => {}, user: { id: '1' } };
  const mockChannel = {
    id: '123',
    name: 'test',
    threads: { fetchActive: async () => ({ threads: new Map() }), fetchArchived: async () => ({ threads: new Map() }) },
    send: async () => ({ startThread: async () => ({ send: async () => {} }) }),
    messages: { fetch: async () => new Map() },
  };
  const fakeConfig = {
    getToday: () => '2026-01-01',
    getDateLabel: () => '01 Jan 2026',
    useActivityThreads: true,
    useChatThreads: true,
    logPollInterval: 600000,
    sftpHost: 'x',
    sftpPort: 22,
    sftpUser: 'x',
    sftpPassword: 'x',
    sftpLogPath: '/test',
    sftpConnectLogPath: '/test',
    logChannelId: '123',
    adminChannelId: '123',
    serverName: '',
    nukeBot: true,
    addAdminMembers: async () => {},
  };

  it('LogWatcher _getOrCreateDailyThread falls back to logChannel when _nukeActive', async () => {
    const lw = new LogWatcher(mockClient, { config: fakeConfig });
    lw.logChannel = mockChannel;
    lw._nukeActive = true;

    const result = await lw._getOrCreateDailyThread();
    assert.strictEqual(result, mockChannel, 'should return logChannel directly');
    assert.strictEqual(lw._dailyDate, '2026-01-01');

    clearInterval(lw._midnightCheckInterval);
    clearInterval(lw.interval);
  });

  it('ChatRelay _getOrCreateChatThread falls back to adminChannel when _nukeActive', async () => {
    const cr = new ChatRelay(mockClient, { config: fakeConfig });
    cr.adminChannel = mockChannel;
    cr._nukeActive = true;

    const result = await cr._getOrCreateChatThread();
    assert.strictEqual(result, mockChannel, 'should return adminChannel directly');
  });
});

describe('PvP NPC source detection', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- dynamic require for test isolation
  const LogWatcher = require('../src/modules/log-watcher');

  function createWatcher(): any {
    return new LogWatcher(
      { on: () => {}, channels: { fetch: async () => null }, user: { id: '1' } },
      {
        config: {
          getToday: () => '2026-01-01',
          getDateLabel: () => '01 Jan 2026',
          logPollInterval: 999999,
          sftpHost: '',
          enablePvpKillFeed: true,
          pvpKillWindow: 60000,
        },
      },
    );
  }

  function cleanup(lw: any): void {
    clearInterval(lw._midnightCheckInterval);
    clearInterval(lw.interval);
  }

  it('rejects NPC names with underscores (blueprint convention)', () => {
    const lw = createWatcher();
    assert.ok(lw._isNpcDamageSource('BP_Zombie_C_12345'));
    assert.ok(lw._isNpcDamageSource('Zombie_Normal'));
    assert.ok(lw._isNpcDamageSource('KaiHuman_Melee'));
    assert.ok(lw._isNpcDamageSource('Wolf_Alpha'));
    cleanup(lw);
  });

  it('rejects known NPC type names at start of string', () => {
    const lw = createWatcher();
    assert.ok(lw._isNpcDamageSource('Zombie'));
    assert.ok(lw._isNpcDamageSource('ZombieBear'));
    assert.ok(lw._isNpcDamageSource('KaiHuman'));
    assert.ok(lw._isNpcDamageSource('Mutant'));
    assert.ok(lw._isNpcDamageSource('Runner'));
    assert.ok(lw._isNpcDamageSource('Brute'));
    assert.ok(lw._isNpcDamageSource('Pudge'));
    assert.ok(lw._isNpcDamageSource('Dogzombie'));
    assert.ok(lw._isNpcDamageSource('Wolf'));
    assert.ok(lw._isNpcDamageSource('Bear'));
    assert.ok(lw._isNpcDamageSource('Deer'));
    assert.ok(lw._isNpcDamageSource('Snake'));
    assert.ok(lw._isNpcDamageSource('Spider'));
    assert.ok(lw._isNpcDamageSource('Police'));
    assert.ok(lw._isNpcDamageSource('Military'));
    assert.ok(lw._isNpcDamageSource('Hazmat'));
    assert.ok(lw._isNpcDamageSource('BellyToxic'));
    cleanup(lw);
  });

  it('allows normal player names', () => {
    const lw = createWatcher();
    assert.ok(!lw._isNpcDamageSource('TestPlayer'));
    assert.ok(!lw._isNpcDamageSource('Zuq'));
    assert.ok(!lw._isNpcDamageSource('fabien'));
    assert.ok(!lw._isNpcDamageSource('xXSlayerXx'));
    assert.ok(!lw._isNpcDamageSource('[PnBy] schlumpipuh05'));
    cleanup(lw);
  });

  it('allows player names containing NPC words mid-name', () => {
    const lw = createWatcher();
    assert.ok(!lw._isNpcDamageSource('HumanSlayer'));
    assert.ok(!lw._isNpcDamageSource('OnlyHuman'));
    assert.ok(!lw._isNpcDamageSource('DeadBear99'));
    assert.ok(!lw._isNpcDamageSource('GrizzlyBear'));
    assert.ok(!lw._isNpcDamageSource('LoneWolf'));
    assert.ok(!lw._isNpcDamageSource('SnakeEyes'));
    assert.ok(!lw._isNpcDamageSource('SpiderMan'));
    assert.ok(!lw._isNpcDamageSource('DeerHunter'));
    cleanup(lw);
  });
});

describe('PvP damage to death correlation', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- dynamic require for test isolation
  const LogWatcher = require('../src/modules/log-watcher');

  function createWatcher(): any {
    return new LogWatcher(
      { on: () => {}, channels: { fetch: async () => null }, user: { id: '1' } },
      {
        config: {
          getToday: () => '2026-01-01',
          getDateLabel: () => '01 Jan 2026',
          logPollInterval: 999999,
          sftpHost: '',
          enablePvpKillFeed: true,
          pvpKillWindow: 60000,
        },
      },
    );
  }

  it('attributes kill when death follows damage within window', () => {
    const lw = createWatcher();
    const t1 = new Date('2026-01-01T12:00:00Z');
    const t2 = new Date('2026-01-01T12:00:30Z');

    lw._recordPvpDamage('Victim', 'Killer', 50, t1);
    const result = lw._checkPvpKill('Victim', t2);
    assert.ok(result, 'should return kill attribution');
    assert.equal(result.attacker, 'Killer');
    assert.equal(result.totalDamage, 50);

    clearInterval(lw._midnightCheckInterval);
    clearInterval(lw.interval);
  });

  it('does not attribute kill when death is outside window', () => {
    const lw = createWatcher();
    const t1 = new Date('2026-01-01T12:00:00Z');
    const t2 = new Date('2026-01-01T12:05:00Z');

    lw._recordPvpDamage('Victim', 'Killer', 50, t1);
    const result = lw._checkPvpKill('Victim', t2);
    assert.equal(result, null);

    clearInterval(lw._midnightCheckInterval);
    clearInterval(lw.interval);
  });

  it('accumulates damage from same attacker', () => {
    const lw = createWatcher();
    const t1 = new Date('2026-01-01T12:00:00Z');
    const t2 = new Date('2026-01-01T12:00:10Z');
    const t3 = new Date('2026-01-01T12:00:20Z');

    lw._recordPvpDamage('Victim', 'Killer', 30, t1);
    lw._recordPvpDamage('Victim', 'Killer', 25, t2);
    const result = lw._checkPvpKill('Victim', t3);
    assert.ok(result);
    assert.equal(result.totalDamage, 55);

    clearInterval(lw._midnightCheckInterval);
    clearInterval(lw.interval);
  });

  it('replaces attacker on last-hit (different attacker overwrites)', () => {
    const lw = createWatcher();
    const t1 = new Date('2026-01-01T12:00:00Z');
    const t2 = new Date('2026-01-01T12:00:10Z');
    const t3 = new Date('2026-01-01T12:00:20Z');

    lw._recordPvpDamage('Victim', 'Killer1', 100, t1);
    lw._recordPvpDamage('Victim', 'Killer2', 15, t2);
    const result = lw._checkPvpKill('Victim', t3);
    assert.ok(result);
    assert.equal(result.attacker, 'Killer2');
    assert.equal(result.totalDamage, 15);

    clearInterval(lw._midnightCheckInterval);
    clearInterval(lw.interval);
  });

  it('is case-insensitive for victim lookup', () => {
    const lw = createWatcher();
    const t1 = new Date('2026-01-01T12:00:00Z');
    const t2 = new Date('2026-01-01T12:00:10Z');

    lw._recordPvpDamage('TestPlayer', 'Killer', 40, t1);
    const result = lw._checkPvpKill('testplayer', t2);
    assert.ok(result);

    clearInterval(lw._midnightCheckInterval);
    clearInterval(lw.interval);
  });

  it('returns null when no damage was tracked for victim', () => {
    const lw = createWatcher();
    const result = lw._checkPvpKill('Unknown', new Date());
    assert.equal(result, null);

    clearInterval(lw._midnightCheckInterval);
    clearInterval(lw.interval);
  });

  it('cleans up after successful attribution', () => {
    const lw = createWatcher();
    const t1 = new Date('2026-01-01T12:00:00Z');
    const t2 = new Date('2026-01-01T12:00:10Z');

    lw._recordPvpDamage('Victim', 'Killer', 50, t1);
    lw._checkPvpKill('Victim', t2);
    const second = lw._checkPvpKill('Victim', t2);
    assert.equal(second, null);

    clearInterval(lw._midnightCheckInterval);
    clearInterval(lw.interval);
  });

  it('prunes old entries beyond 2x window', () => {
    const lw = createWatcher();
    const old = new Date('2026-01-01T10:00:00Z');

    lw._recordPvpDamage('OldVictim', 'OldKiller', 50, old);
    assert.equal(lw._pvpDamageTracker.size, 1);
    lw._prunePvpTracker();
    assert.equal(lw._pvpDamageTracker.size, 0);

    clearInterval(lw._midnightCheckInterval);
    clearInterval(lw.interval);
  });

  it('handles death before damage (negative elapsed)', () => {
    const lw = createWatcher();
    const t1 = new Date('2026-01-01T12:01:00Z');
    const t2 = new Date('2026-01-01T12:00:00Z');

    lw._recordPvpDamage('Victim', 'Killer', 50, t1);
    const result = lw._checkPvpKill('Victim', t2);
    assert.equal(result, null);

    clearInterval(lw._midnightCheckInterval);
    clearInterval(lw.interval);
  });
});

/**
 * Tests for log-watcher.js parsing helpers and log line parsing.
 * Since LogWatcher is a class with heavy I/O deps, we test the pure logic
 * by reimplementing the core regex patterns from _processLine and _processConnectLine.
 * Run: npm test
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// ── Regex patterns extracted from LogWatcher for isolated testing ──

// Main log line timestamp regex (from _processLine)
const LOG_LINE_RE = /^\((\d{1,2})[/\-.](\d{1,2})[/\-.](\d{1,2},?\d{3})\s+(\d{1,2}):(\d{1,2})(?::\d{1,2})?\)\s+(.+)$/;

// Connect/disconnect regex (from _processConnectLine)
const CONNECT_RE = /^Player (Connected|Disconnected)\s+(.+?)\s+NetID\((\d{17})[^)]*\)\s*\((\d{1,2})[/\-.](\d{1,2})[/\-.](\d{1,2},?\d{3})\s+(\d{1,2}):(\d{1,2})(?::\d{1,2})?\)/;

// Event body regexes (from _processLine)
const DEATH_RE = /^Player died \((.+)\)$/;
const BUILD_RE = /^(.+?)\((\d{17})[^)]*\)\s*finished building\s+(.+)$/;
const DMG_RE = /^(.+?)\s+took\s+([\d.]+)\s+damage from\s+(.+)$/;
const LOOT_RE = /^(.+?)\s*\((\d{17})[^)]*\)\s*looted a container\s*\(([^)]+)\)\s*owner by\s*(\d{17})/;
const ADMIN_RE = /^(.+?)\s+gained admin access!$/;
const CHEAT_RE = /^(Stack limit detected in drop function|Odd behavior.*?Cheat)\s*\((.+?)\s*-\s*(\d{17})/;
const RAID_RE = /^Building \(([^)]+)\) owned by \((\d{17}[^)]*)\) damaged \([\d.]+\) by (.+?)(?:\((\d{17})[^)]*\))?(\s*\(Destroyed\))?$/;

// Blueprint name cleaner (from _simplifyBlueprintName)
function simplifyBlueprintName(rawName) {
  return rawName
    .replace(/^BP_/, '')
    .replace(/_C_\d+.*$/, '')
    .replace(/_C$/, '')
    .replace(/_/g, ' ')
    .trim();
}

// ══════════════════════════════════════════════════════════
// Log line timestamp parsing
// ══════════════════════════════════════════════════════════

describe('log line timestamp parsing', () => {
  it('parses standard format: (13/2/2026 12:35) message', () => {
    const m = LOG_LINE_RE.exec('(13/2/2026 12:35) Player died (TestPlayer)');
    assert.ok(m);
    assert.equal(m[1], '13');
    assert.equal(m[2], '2');
    assert.equal(m[3], '2026');
    assert.equal(m[4], '12');
    assert.equal(m[5], '35');
    assert.equal(m[6], 'Player died (TestPlayer)');
  });

  it('parses comma-in-year format: (13/2/2,026)', () => {
    const m = LOG_LINE_RE.exec('(13/2/2,026 12:35) Player died (TestPlayer)');
    assert.ok(m);
    assert.equal(m[3], '2,026');
  });

  it('parses with seconds: (13/2/2026 12:35:42)', () => {
    const m = LOG_LINE_RE.exec('(13/2/2026 12:35:42) Player died (TestPlayer)');
    assert.ok(m);
    assert.equal(m[4], '12');
    assert.equal(m[5], '35');
  });

  it('parses dash separator: (13-2-2026 12:35)', () => {
    const m = LOG_LINE_RE.exec('(13-2-2026 12:35) Player died (TestPlayer)');
    assert.ok(m);
  });

  it('parses dot separator: (13.2.2026 12:35)', () => {
    const m = LOG_LINE_RE.exec('(13.2.2026 12:35) Player died (TestPlayer)');
    assert.ok(m);
  });

  it('rejects malformed lines', () => {
    assert.equal(LOG_LINE_RE.exec('not a log line'), null);
    assert.equal(LOG_LINE_RE.exec('(no_date) message'), null);
  });
});

// ══════════════════════════════════════════════════════════
// Event body regexes
// ══════════════════════════════════════════════════════════

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
});

describe('raid regex', () => {
  it('matches building damage with destroyer', () => {
    const m = RAID_RE.exec('Building (BP_Wall_C) owned by (76561100000000002) damaged (50.0) by attacker(76561100000000001) (Destroyed)');
    assert.ok(m);
    assert.equal(m[1], 'BP_Wall_C');
    assert.ok(m[2].startsWith('76561100000000002'));
    assert.equal(m[4], '76561100000000001');
    assert.ok(m[5]); // Destroyed tag present
  });

  it('matches building damage without Destroyed', () => {
    const m = RAID_RE.exec('Building (BP_Wall_C) owned by (76561100000000002) damaged (25.0) by attacker(76561100000000001)');
    assert.ok(m);
    assert.equal(m[5], undefined); // No Destroyed
  });
});

// ══════════════════════════════════════════════════════════
// Connect/disconnect line parsing
// ══════════════════════════════════════════════════════════

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

// ══════════════════════════════════════════════════════════
// _simplifyBlueprintName
// ══════════════════════════════════════════════════════════

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

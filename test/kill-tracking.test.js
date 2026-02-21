/**
 * Tests for kill tracking and death checkpoint system.
 *
 * Uses Node's built-in test runner (node --test).
 * Run: node --test test/kill-tracking.test.js
 */
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// ── Stub out external dependencies before requiring the module ──
// We need to mock: discord.js, ssh2-sftp-client, config, playtime, playerStats, save-parser, game-data, fs (partially)

const KILL_KEYS = ['zeeksKilled', 'headshots', 'meleeKills', 'gunKills', 'blastKills', 'fistKills', 'takedownKills', 'vehicleKills'];
const SURVIVAL_KEYS = ['daysSurvived'];

const LIFETIME_KEY_MAP = {
  zeeksKilled:   'lifetimeKills',
  headshots:     'lifetimeHeadshots',
  meleeKills:    'lifetimeMeleeKills',
  gunKills:      'lifetimeGunKills',
  blastKills:    'lifetimeBlastKills',
  fistKills:     'lifetimeFistKills',
  takedownKills: 'lifetimeTakedownKills',
  vehicleKills:  'lifetimeVehicleKills',
};

// ── Minimal reimplementation of the key logic for isolated testing ──

function emptyKills() {
  const obj = {};
  for (const k of KILL_KEYS) obj[k] = 0;
  return obj;
}

function snapshotKills(save) {
  const obj = {};
  for (const k of KILL_KEYS) obj[k] = save[k] || 0;
  return obj;
}

/**
 * Compute all-time kills. Mirrors PlayerStatsChannel.getAllTimeKills().
 */
function getAllTimeKills(save, record) {
  if (!record && !save) return null;
  const allTime = emptyKills();
  if (save?.hasExtendedStats) {
    allTime.zeeksKilled    = save.lifetimeKills        || 0;
    allTime.headshots      = save.lifetimeHeadshots    || 0;
    allTime.meleeKills     = save.lifetimeMeleeKills   || 0;
    allTime.gunKills       = save.lifetimeGunKills     || 0;
    allTime.blastKills     = save.lifetimeBlastKills   || 0;
    allTime.fistKills      = save.lifetimeFistKills    || 0;
    allTime.takedownKills  = save.lifetimeTakedownKills || 0;
    allTime.vehicleKills   = save.lifetimeVehicleKills || 0;
    return allTime;
  }
  if (record) {
    for (const k of KILL_KEYS) allTime[k] += record.cumulative[k];
  }
  if (save) {
    for (const k of KILL_KEYS) allTime[k] += (save[k] || 0);
  }
  return allTime;
}

/**
 * Compute current-life kills. Mirrors PlayerStatsChannel.getCurrentLifeKills().
 */
function getCurrentLifeKills(save, record) {
  if (!save) return null;

  // If GameStats has non-zero kills, player is online — use directly
  const sessionKills = save.zeeksKilled || 0;
  if (sessionKills > 0) {
    return snapshotKills(save);
  }

  // ExtendedStats: compute from lifetime - checkpoint
  if (save.hasExtendedStats && record?.deathCheckpoint) {
    const life = {};
    for (const k of KILL_KEYS) {
      const lifetimeKey = LIFETIME_KEY_MAP[k];
      const lifetime = lifetimeKey ? (save[lifetimeKey] || 0) : 0;
      life[k] = Math.max(0, lifetime - (record.deathCheckpoint[k] || 0));
    }
    return life;
  }

  // ExtendedStats, never died: all lifetime kills are current life
  if (save.hasExtendedStats) {
    const life = {};
    for (const k of KILL_KEYS) {
      const lifetimeKey = LIFETIME_KEY_MAP[k];
      life[k] = lifetimeKey ? (save[lifetimeKey] || 0) : 0;
    }
    return life;
  }

  // Legacy: GameStats is the current-life value
  return snapshotKills(save);
}

/**
 * Compute death checkpoint when a death is detected. Mirrors the logic in _accumulateStats().
 */
function computeDeathCheckpoint(save, currentKills) {
  const cp = {};
  for (const k of KILL_KEYS) {
    const lifetimeKey = LIFETIME_KEY_MAP[k];
    const lifetime = lifetimeKey ? (save[lifetimeKey] || 0) : 0;
    cp[k] = lifetime - (currentKills[k] || 0);
  }
  return cp;
}

// ── Helper to build a mock save entry ──
function mockSave({ lifetime = 0, session = 0, headshots = 0, lifetimeHS = 0, hasExtended = true } = {}) {
  return {
    zeeksKilled: session,
    headshots: headshots,
    meleeKills: 0, gunKills: 0, blastKills: 0, fistKills: 0, takedownKills: 0, vehicleKills: 0,
    lifetimeKills: lifetime,
    lifetimeHeadshots: lifetimeHS,
    lifetimeMeleeKills: 0, lifetimeGunKills: 0, lifetimeBlastKills: 0,
    lifetimeFistKills: 0, lifetimeTakedownKills: 0, lifetimeVehicleKills: 0,
    hasExtendedStats: hasExtended,
  };
}

// ════════════════════════════════════════════════════════════
// Tests
// ════════════════════════════════════════════════════════════

describe('getAllTimeKills', () => {
  it('returns lifetime values from ExtendedStats', () => {
    const save = mockSave({ lifetime: 143, session: 9, lifetimeHS: 35, headshots: 5 });
    const at = getAllTimeKills(save, null);
    assert.equal(at.zeeksKilled, 143);
    assert.equal(at.headshots, 35);
  });

  it('returns null when no data', () => {
    assert.equal(getAllTimeKills(null, null), null);
  });

  it('uses cumulative + save for legacy (no ExtendedStats)', () => {
    const save = mockSave({ lifetime: 0, session: 10, hasExtended: false });
    const record = { cumulative: { ...emptyKills(), zeeksKilled: 50 } };
    const at = getAllTimeKills(save, record);
    assert.equal(at.zeeksKilled, 60); // 50 banked + 10 current
  });
});

describe('getCurrentLifeKills', () => {
  it('returns GameStats directly when non-zero (player online)', () => {
    const save = mockSave({ lifetime: 143, session: 9, lifetimeHS: 35, headshots: 5 });
    const record = { deathCheckpoint: { ...emptyKills(), zeeksKilled: 100 } };
    const cl = getCurrentLifeKills(save, record);
    // Should use GameStats directly since session > 0
    assert.equal(cl.zeeksKilled, 9);
    assert.equal(cl.headshots, 5);
  });

  it('computes from lifetime-checkpoint when offline (session=0, has checkpoint)', () => {
    const save = mockSave({ lifetime: 143, session: 0, lifetimeHS: 35, headshots: 0 });
    const record = { deathCheckpoint: { ...emptyKills(), zeeksKilled: 134, headshots: 30 } };
    const cl = getCurrentLifeKills(save, record);
    assert.equal(cl.zeeksKilled, 9);  // 143 - 134
    assert.equal(cl.headshots, 5);     // 35 - 30
  });

  it('returns full lifetime when never died (no checkpoint)', () => {
    const save = mockSave({ lifetime: 50, session: 0, lifetimeHS: 10 });
    const record = { deathCheckpoint: null };
    const cl = getCurrentLifeKills(save, record);
    assert.equal(cl.zeeksKilled, 50);
    assert.equal(cl.headshots, 10);
  });

  it('returns null with no save data', () => {
    assert.equal(getCurrentLifeKills(null, null), null);
  });

  it('returns legacy GameStats for non-ExtendedStats players', () => {
    const save = mockSave({ lifetime: 0, session: 15, hasExtended: false });
    const cl = getCurrentLifeKills(save, null);
    assert.equal(cl.zeeksKilled, 15);
  });

  it('handles zero lifetime-checkpoint difference', () => {
    const save = mockSave({ lifetime: 100, session: 0 });
    const record = { deathCheckpoint: { ...emptyKills(), zeeksKilled: 100 } };
    const cl = getCurrentLifeKills(save, record);
    assert.equal(cl.zeeksKilled, 0); // 100 - 100 = 0 kills this life
  });
});

describe('computeDeathCheckpoint', () => {
  it('computes checkpoint = lifetime - session kills', () => {
    const save = mockSave({ lifetime: 143, session: 3, lifetimeHS: 35, headshots: 1 });
    const currentKills = snapshotKills(save);
    const cp = computeDeathCheckpoint(save, currentKills);
    assert.equal(cp.zeeksKilled, 140);  // 143 - 3
    assert.equal(cp.headshots, 34);      // 35 - 1
  });

  it('checkpoint equals lifetime when session is 0 (just died)', () => {
    const save = mockSave({ lifetime: 143, session: 0, lifetimeHS: 35 });
    const currentKills = snapshotKills(save);
    const cp = computeDeathCheckpoint(save, currentKills);
    assert.equal(cp.zeeksKilled, 143);
    assert.equal(cp.headshots, 35);
  });
});

describe('end-to-end scenario', () => {
  it('tracks kills through online/offline/death cycle', () => {
    // Step 1: player is online, 9 kills this life, 143 lifetime, never died
    const save1 = mockSave({ lifetime: 143, session: 9 });
    const record1 = { deathCheckpoint: null, lastKnownDeaths: 0 };

    let cl = getCurrentLifeKills(save1, record1);
    assert.equal(cl.zeeksKilled, 9, 'Online: should show 9 from GameStats');

    let at = getAllTimeKills(save1, record1);
    assert.equal(at.zeeksKilled, 143, 'All-time: should show 143');

    // Step 2: player goes offline — GameStats zeroed, lifetime unchanged
    const save2 = mockSave({ lifetime: 143, session: 0 });
    cl = getCurrentLifeKills(save2, record1);
    assert.equal(cl.zeeksKilled, 143, 'Offline, never died: all 143 are this life');

    // Step 3: player dies (log death count goes from 0 to 1)
    // But player already killed 2 in new life by the time we detect it
    const save3 = mockSave({ lifetime: 145, session: 2 });
    const currentKills3 = snapshotKills(save3);
    const cp = computeDeathCheckpoint(save3, currentKills3);
    assert.equal(cp.zeeksKilled, 143, 'Checkpoint should be 145 - 2 = 143');

    const record3 = { deathCheckpoint: cp, lastKnownDeaths: 1 };
    cl = getCurrentLifeKills(save3, record3);
    assert.equal(cl.zeeksKilled, 2, 'After death + 2 kills: should show 2');

    at = getAllTimeKills(save3, record3);
    assert.equal(at.zeeksKilled, 145, 'All-time: should show 145');

    // Step 4: player goes offline again — GameStats zeroed
    const save4 = mockSave({ lifetime: 145, session: 0 });
    cl = getCurrentLifeKills(save4, record3);
    assert.equal(cl.zeeksKilled, 2, 'Offline after death: should still show 2 (145 - 143)');

    // Step 5: player comes back, kills 5 more
    const save5 = mockSave({ lifetime: 150, session: 7 });
    cl = getCurrentLifeKills(save5, record3);
    assert.equal(cl.zeeksKilled, 7, 'Online with 7 session kills: should show 7 from GameStats');

    at = getAllTimeKills(save5, record3);
    assert.equal(at.zeeksKilled, 150, 'All-time: should show 150');
  });

  it('handles first-time player with existing deaths', () => {
    // Player first tracked with 3 deaths already and 10 kills in current life
    const save = mockSave({ lifetime: 200, session: 10 });
    const logDeaths = 3;

    // Simulate first-time init with existing deaths
    const cp = computeDeathCheckpoint(save, snapshotKills(save));
    assert.equal(cp.zeeksKilled, 190, 'Checkpoint: 200 - 10 = 190');

    const record = { deathCheckpoint: cp, lastKnownDeaths: logDeaths };
    const cl = getCurrentLifeKills(save, record);
    assert.equal(cl.zeeksKilled, 10, 'Current life: 10 from GameStats (online)');

    // Goes offline
    const saveOffline = mockSave({ lifetime: 200, session: 0 });
    const clOffline = getCurrentLifeKills(saveOffline, record);
    assert.equal(clOffline.zeeksKilled, 10, 'Offline: 200 - 190 = 10');
  });
});

describe('display logic', () => {
  it('shows both when current-life differs from all-time', () => {
    const save = mockSave({ lifetime: 143, session: 0, lifetimeHS: 35 });
    const record = { deathCheckpoint: { ...emptyKills(), zeeksKilled: 134, headshots: 30 } };
    const at = getAllTimeKills(save, record);
    const cl = getCurrentLifeKills(save, record);

    // Zombies: life=9, all=143 → two-column display
    assert.equal(cl.zeeksKilled, 9);
    assert.equal(at.zeeksKilled, 143);
    assert.notEqual(cl.zeeksKilled, at.zeeksKilled);
  });

  it('shows single value when life equals all-time (never died)', () => {
    const save = mockSave({ lifetime: 50, session: 0 });
    const record = { deathCheckpoint: null };
    const at = getAllTimeKills(save, record);
    const cl = getCurrentLifeKills(save, record);
    assert.equal(cl.zeeksKilled, at.zeeksKilled, 'Should be equal — no AT suffix needed');
  });
});

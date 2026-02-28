/**
 * Tests for @humanitzbot/qs-anticheat — Phase AC-1 Foundation
 *
 * Covers: statistics, rolling-window, baseline modeler,
 * feature extractors, detectors, scoring, escalation, and AnticheatEngine.
 *
 * Run: npm test
 */
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

// ── Baseline: statistics ────────────────────────────────────────────

const {
  median, mad, modifiedZScore, calcPercentiles,
  normaliseSigmoid, distance2d, distance3d,
} = require('@humanitzbot/qs-anticheat/src/baseline/statistics');

describe('statistics', () => {
  describe('median', () => {
    it('returns median of odd-length sorted array', () => {
      assert.equal(median([1, 2, 3, 4, 5]), 3);
    });
    it('returns median of even-length sorted array', () => {
      assert.equal(median([1, 2, 3, 4]), 2.5);
    });
    it('returns the value for single element', () => {
      assert.equal(median([42]), 42);
    });
    it('returns 0 for empty array', () => {
      assert.equal(median([]), 0);
    });
  });

  describe('mad', () => {
    it('returns MAD of a uniform array as 0', () => {
      assert.equal(mad([5, 5, 5, 5, 5]), 0);
    });
    it('returns correct MAD', () => {
      // [1, 2, 3, 4, 5] → median=3, deviations=[2,1,0,1,2] sorted → [0,1,1,2,2] → MAD=1
      assert.equal(mad([1, 2, 3, 4, 5]), 1);
    });
  });

  describe('modifiedZScore', () => {
    it('returns 0 when MAD is 0 and value equals median', () => {
      assert.equal(modifiedZScore(5, 5, 0), 0);
    });
    it('returns positive score for outlier', () => {
      const score = modifiedZScore(100, 3, 1);
      assert.ok(score > 0);
    });
    it('handles MAD of 0 with non-equal value', () => {
      const score = modifiedZScore(10, 5, 0);
      assert.ok(score > 0, 'should return positive Z-score');
    });
  });

  describe('calcPercentiles', () => {
    it('returns correct percentile keys', () => {
      const sorted = Array.from({ length: 100 }, (_, i) => i);
      const pcts = calcPercentiles(sorted);
      assert.ok(pcts[5] != null);
      assert.ok(pcts[25] != null);
      assert.ok(pcts[50] != null);
      assert.ok(pcts[75] != null);
      assert.ok(pcts[95] != null);
      assert.ok(pcts[99] != null);
    });
    it('P50 equals median for sorted range', () => {
      const sorted = Array.from({ length: 101 }, (_, i) => i);
      const pcts = calcPercentiles(sorted);
      assert.equal(pcts[50], 50);
    });
  });

  describe('normaliseSigmoid', () => {
    it('returns 0 for 0', () => {
      assert.equal(normaliseSigmoid(0), 0);
    });
    it('returns ~0.5 for k', () => {
      const val = normaliseSigmoid(3, 3);
      assert.ok(Math.abs(val - 0.5) < 0.01);
    });
    it('approaches 1 for large values', () => {
      assert.ok(normaliseSigmoid(1000) > 0.99);
    });
  });

  describe('distance', () => {
    it('distance2d calculates correctly', () => {
      const d = distance2d({ x: 0, y: 0 }, { x: 3, y: 4 });
      assert.ok(Math.abs(d - 5) < 0.001);
    });
    it('distance3d calculates correctly', () => {
      const d = distance3d({ x: 0, y: 0, z: 0 }, { x: 1, y: 2, z: 2 });
      assert.ok(Math.abs(d - 3) < 0.001);
    });
  });
});

// ── Baseline: rolling-window ────────────────────────────────────────

const RollingWindow = require('@humanitzbot/qs-anticheat/src/baseline/rolling-window');

describe('RollingWindow', () => {
  it('tracks size correctly', () => {
    const w = new RollingWindow(5);
    w.push(10, 1000);
    w.push(20, 2000);
    assert.equal(w.size, 2);
  });

  it('evicts oldest when full', () => {
    const w = new RollingWindow(3);
    w.push(1, 100); w.push(2, 200); w.push(3, 300);
    assert.equal(w.size, 3);
    w.push(4, 400);
    assert.equal(w.size, 3);
    assert.deepEqual(w.sortedValues(), [2, 3, 4]);
  });

  it('valuesSince filters by timestamp', () => {
    const w = new RollingWindow(10);
    w.push(1, 100); w.push(2, 200); w.push(3, 300);
    const vals = w.valuesSince(150);
    assert.equal(vals.length, 2);
  });

  it('sortedValues returns sorted copy', () => {
    const w = new RollingWindow(10);
    w.push(5, 1); w.push(1, 2); w.push(3, 3);
    assert.deepEqual(w.sortedValues(), [1, 3, 5]);
  });

  it('latest returns most recent entry', () => {
    const w = new RollingWindow(10);
    w.push(10, 100); w.push(20, 200);
    assert.deepEqual(w.latest(), { value: 20, timestamp: 200 });
  });

  it('returns null for latest on empty', () => {
    const w = new RollingWindow(10);
    assert.equal(w.latest(), null);
  });

  it('serialises and deserialises', () => {
    const w = new RollingWindow(10);
    w.push(10, 100); w.push(20, 200);
    const json = w.toJSON();
    const w2 = RollingWindow.fromJSON(json);
    assert.equal(w2.size, 2);
    assert.deepEqual(w2.sortedValues(), [10, 20]);
  });

  it('trimBefore removes old entries', () => {
    const w = new RollingWindow(10);
    w.push(1, 100); w.push(2, 200); w.push(3, 300);
    w.trimBefore(150);
    assert.equal(w.size, 2);
  });

  it('lastN returns most recent N entries (most recent first)', () => {
    const w = new RollingWindow(10);
    w.push(1, 100); w.push(2, 200); w.push(3, 300);
    const last2 = w.lastN(2);
    assert.equal(last2.length, 2);
    assert.equal(last2[0].value, 3); // most recent first
    assert.equal(last2[1].value, 2);
  });

  it('clear empties the window', () => {
    const w = new RollingWindow(10);
    w.push(1, 100); w.push(2, 200);
    w.clear();
    assert.equal(w.size, 0);
  });
});

// ── Baseline: modeler ───────────────────────────────────────────────

const { BaselineModeler, MetricBaseline } = require('@humanitzbot/qs-anticheat/src/baseline/modeler');

describe('MetricBaseline', () => {
  it('is not ready before minSamples', () => {
    const mb = new MetricBaseline('test', { minSamples: 5 });
    for (let i = 0; i < 4; i++) mb.record(i, Date.now());
    assert.equal(mb.ready, false);
  });

  it('becomes ready at minSamples', () => {
    const mb = new MetricBaseline('test', { minSamples: 5 });
    for (let i = 0; i < 5; i++) mb.record(i, Date.now());
    assert.equal(mb.ready, true);
  });

  it('returns stats when ready', () => {
    const mb = new MetricBaseline('test', { minSamples: 5 });
    for (let i = 0; i < 10; i++) mb.record(i * 10, Date.now());
    const stats = mb.getStats();
    assert.ok(stats);
    assert.ok(stats.median >= 0);
    assert.ok(stats.sampleCount === 10);
  });

  it('scores a value when ready', () => {
    const mb = new MetricBaseline('test', { minSamples: 5 });
    for (let i = 0; i < 20; i++) mb.record(i, Date.now());
    const result = mb.score(100); // clear outlier
    assert.ok(result);
    assert.ok(result.zScore > 0);
    assert.ok(result.normalised > 0);
  });

  it('returns null from score when not ready', () => {
    const mb = new MetricBaseline('test', { minSamples: 50 });
    mb.record(1, Date.now());
    assert.equal(mb.score(100), null);
  });

  it('serialises and deserialises', () => {
    const mb = new MetricBaseline('test_metric', { minSamples: 3 });
    for (let i = 0; i < 5; i++) mb.record(i * 10, Date.now());
    const json = mb.toJSON();
    const mb2 = MetricBaseline.fromJSON(json);
    assert.equal(mb2.name, 'test_metric');
    assert.equal(mb2.ready, true);
    assert.equal(mb2.sampleCount, 5);
  });

  it('ignores NaN and Infinity', () => {
    const mb = new MetricBaseline('test', { minSamples: 3 });
    mb.record(NaN);
    mb.record(Infinity);
    mb.record(-Infinity);
    assert.equal(mb.sampleCount, 0);
  });
});

describe('BaselineModeler', () => {
  it('records and scores server metrics', () => {
    const model = new BaselineModeler();
    for (let i = 0; i < 50; i++) model.recordServer('speed', i * 10, Date.now());
    const result = model.scoreServer('speed', 5000);
    assert.ok(result.ready);
    assert.ok(result.zScore > 0);
  });

  it('records and scores player metrics', () => {
    const model = new BaselineModeler();
    for (let i = 0; i < 20; i++) model.recordPlayer('STEAM_1', 'kills', i, Date.now());
    const result = model.scorePlayer('STEAM_1', 'kills', 100);
    assert.ok(result.ready);
    assert.ok(result.zScore > 0);
  });

  it('returns not-ready for unknown metrics', () => {
    const model = new BaselineModeler();
    const result = model.scoreServer('unknown_metric', 42);
    assert.equal(result.ready, false);
  });

  it('returns diagnostics', () => {
    const model = new BaselineModeler();
    model.recordServer('speed', 100, Date.now());
    model.recordPlayer('S1', 'kills', 5, Date.now());
    const diag = model.getDiagnostics();
    assert.equal(diag.serverMetrics.length, 1);
    assert.equal(diag.playerCount, 1);
  });

  it('serialises and deserialises', () => {
    const model = new BaselineModeler();
    for (let i = 0; i < 35; i++) model.recordServer('speed', i * 10, Date.now());
    const json = model.toJSON();
    const model2 = BaselineModeler.fromJSON(json);
    assert.ok(model2.isReady('speed'));
    assert.equal(model2.getServerStats('speed').sampleCount, 35);
  });

  it('trimAll does not crash', () => {
    const model = new BaselineModeler();
    model.recordServer('speed', 100, Date.now());
    model.recordPlayer('S1', 'kills', 5, Date.now());
    model.trimAll(); // should not throw
    assert.ok(true);
  });
});

// ── Extractors ──────────────────────────────────────────────────────

const { extractKillFeatures, safePositiveDelta } = require('@humanitzbot/qs-anticheat/src/extractors/kills');
const { extractStatRegressions, extractVitalAnomalies, CUMULATIVE_FIELDS } = require('@humanitzbot/qs-anticheat/src/extractors/stats');

describe('extractors/kills', () => {
  it('safePositiveDelta returns 0 for nulls', () => {
    assert.equal(safePositiveDelta(null, 5), 0);
    assert.equal(safePositiveDelta(5, null), 0);
  });

  it('safePositiveDelta returns 0 for negative delta', () => {
    assert.equal(safePositiveDelta(3, 5), 0);
  });

  it('safePositiveDelta returns positive delta', () => {
    assert.equal(safePositiveDelta(10, 5), 5);
  });

  it('extracts kill features from stat deltas', () => {
    const prev = new Map([['S1', { zeeksKilled: 10, lifetimeKills: 15, headshots: 3, pvpKills: 0, animalKills: 1, banditKills: 0 }]]);
    const cur = new Map([['S1', { zeeksKilled: 25, lifetimeKills: 30, headshots: 8, pvpKills: 1, animalKills: 2, banditKills: 0 }]]);
    const features = extractKillFeatures(cur, prev, 60_000); // 1 minute
    assert.ok(features.has('S1'));
    const f = features.get('S1');
    assert.equal(f.zombieKillDelta, 15);
    assert.equal(f.pvpKillDelta, 1);
    assert.equal(f.killsPerMinute, 17); // 15+1+1+0 = 17 kills in 1 min
  });

  it('skips players with no kills', () => {
    const prev = new Map([['S1', { zeeksKilled: 10, lifetimeKills: 10, headshots: 0, pvpKills: 0, animalKills: 0, banditKills: 0 }]]);
    const cur = new Map([['S1', { zeeksKilled: 10, lifetimeKills: 10, headshots: 0, pvpKills: 0, animalKills: 0, banditKills: 0 }]]);
    const features = extractKillFeatures(cur, prev, 60_000);
    assert.equal(features.size, 0);
  });

  it('returns empty for zero elapsed time', () => {
    const features = extractKillFeatures(new Map(), new Map(), 0);
    assert.equal(features.size, 0);
  });
});

describe('extractors/stats', () => {
  it('detects stat regression', () => {
    const prev = new Map([['S1', { zeeksKilled: 100, lifetimeKills: 200, headshots: 50, lifetimeDaysSurvived: 10, fishCaught: 5, animalKills: 3, banditKills: 2 }]]);
    const cur = new Map([['S1', { zeeksKilled: 80, lifetimeKills: 200, headshots: 50, lifetimeDaysSurvived: 10, fishCaught: 5, animalKills: 3, banditKills: 2 }]]);
    const features = extractStatRegressions(cur, prev);
    assert.ok(features.has('S1'));
    assert.equal(features.get('S1').regressions.length, 1);
    assert.equal(features.get('S1').regressions[0].field, 'zeeksKilled');
    assert.equal(features.get('S1').regressions[0].delta, -20);
  });

  it('detects multiple regressions', () => {
    const prev = new Map([['S1', { zeeksKilled: 100, lifetimeKills: 200, headshots: 50, lifetimeDaysSurvived: 10, fishCaught: 5, animalKills: 3, banditKills: 2 }]]);
    const cur = new Map([['S1', { zeeksKilled: 50, lifetimeKills: 100, headshots: 50, lifetimeDaysSurvived: 10, fishCaught: 5, animalKills: 3, banditKills: 2 }]]);
    const features = extractStatRegressions(cur, prev);
    assert.equal(features.get('S1').regressions.length, 2);
  });

  it('does not flag normal stat increases', () => {
    const prev = new Map([['S1', { zeeksKilled: 100, lifetimeKills: 200, headshots: 50, lifetimeDaysSurvived: 10, fishCaught: 5, animalKills: 3, banditKills: 2 }]]);
    const cur = new Map([['S1', { zeeksKilled: 110, lifetimeKills: 215, headshots: 55, lifetimeDaysSurvived: 11, fishCaught: 7, animalKills: 4, banditKills: 3 }]]);
    const features = extractStatRegressions(cur, prev);
    assert.equal(features.size, 0);
  });

  it('CUMULATIVE_FIELDS is non-empty', () => {
    assert.ok(CUMULATIVE_FIELDS.length > 0);
  });

  it('detects vital anomalies', () => {
    const stats = new Map([['S1', { health: -10, hunger: 50, thirst: 200, stamina: 50, immunity: 50 }]]);
    const features = extractVitalAnomalies(stats);
    assert.ok(features.has('S1'));
    const anomalies = features.get('S1').anomalies;
    assert.ok(anomalies.length >= 2); // negative health + excessive thirst
  });

  it('does not flag normal vitals', () => {
    const stats = new Map([['S1', { health: 100, hunger: 80, thirst: 70, stamina: 90, immunity: 95 }]]);
    const features = extractVitalAnomalies(stats);
    assert.equal(features.size, 0);
  });
});

// ── Detectors ───────────────────────────────────────────────────────

const teleportDetector = require('@humanitzbot/qs-anticheat/src/detectors/teleportation');
const speedHackDetector = require('@humanitzbot/qs-anticheat/src/detectors/speed-hack');
const killRateDetector = require('@humanitzbot/qs-anticheat/src/detectors/kill-rate');
const statRegressionDetector = require('@humanitzbot/qs-anticheat/src/detectors/stat-regression');

describe('detectors/teleportation', () => {
  it('flags large position jump', () => {
    const features = new Map([['S1', {
      distance2d: 50_000,
      distance3d: 50_000,
      speed: 5000,
      elapsedSec: 5,
      elapsedMs: 5000,
      maxVehicleSpeed: 2800,
      maxSprintSpeed: 600,
      currentPos: { x: 50000, y: 0, z: 0 },
      previousPos: { x: 0, y: 0, z: 0 },
      isAlive: 1,
    }]]);
    const flags = teleportDetector.detect(features);
    assert.ok(flags.length >= 1);
    assert.equal(flags[0].detector, 'teleportation');
    assert.equal(flags[0].steamId, 'S1');
  });

  it('does not flag normal movement', () => {
    const features = new Map([['S1', {
      distance2d: 500,
      distance3d: 500,
      speed: 100,
      elapsedSec: 5,
      elapsedMs: 5000,
      maxVehicleSpeed: 2800,
      maxSprintSpeed: 600,
      currentPos: { x: 500, y: 0, z: 0 },
      previousPos: { x: 0, y: 0, z: 0 },
      isAlive: 1,
    }]]);
    const flags = teleportDetector.detect(features);
    assert.equal(flags.length, 0);
  });

  it('skips dead players', () => {
    const features = new Map([['S1', {
      distance2d: 100_000,
      distance3d: 100_000,
      speed: 20000,
      elapsedSec: 5,
      elapsedMs: 5000,
      maxVehicleSpeed: 2800,
      maxSprintSpeed: 600,
      currentPos: { x: 100000, y: 0, z: 0 },
      previousPos: { x: 0, y: 0, z: 0 },
      isAlive: 0,
    }]]);
    const flags = teleportDetector.detect(features);
    assert.equal(flags.length, 0);
  });

  it('trains baseline without crashing', () => {
    const { BaselineModeler } = require('@humanitzbot/qs-anticheat/src/baseline/modeler');
    const model = new BaselineModeler();
    const features = new Map([['S1', {
      distance2d: 500, distance3d: 500, speed: 100,
      elapsedSec: 5, maxVehicleSpeed: 2800,
      isAlive: 1,
    }]]);
    teleportDetector.train(features, model);
    assert.ok(true);
  });
});

describe('detectors/speed-hack', () => {
  beforeEach(() => speedHackDetector.reset());

  it('does not flag single high-speed poll', () => {
    const features = new Map([['S1', {
      speed: 10000, isAlive: 1, maxVehicleSpeed: 2800,
    }]]);
    const flags = speedHackDetector.detect(features);
    assert.equal(flags.length, 0); // needs MIN_CONSECUTIVE
  });

  it('flags sustained high speed', () => {
    // Need MIN_CONSECUTIVE (3) consecutive high-speed observations
    for (let i = 0; i < 3; i++) {
      const features = new Map([['S1', {
        speed: 10000, isAlive: 1, maxVehicleSpeed: 2800,
      }]]);
      const flags = speedHackDetector.detect(features);
      if (i < 2) assert.equal(flags.length, 0, `should not flag on observation ${i + 1}`);
      else {
        assert.ok(flags.length >= 1, 'should flag on 3rd consecutive high-speed');
        assert.equal(flags[0].detector, 'speed_hack');
      }
    }
  });

  it('resets on normal speed', () => {
    // Two high, then one normal, then two high → should not flag
    const highFeatures = new Map([['S1', { speed: 10000, isAlive: 1, maxVehicleSpeed: 2800 }]]);
    const normalFeatures = new Map([['S1', { speed: 100, isAlive: 1, maxVehicleSpeed: 2800 }]]);
    speedHackDetector.detect(highFeatures);
    speedHackDetector.detect(highFeatures);
    speedHackDetector.detect(normalFeatures); // reset
    speedHackDetector.detect(highFeatures);
    speedHackDetector.detect(highFeatures);
    const flags = speedHackDetector.detect(highFeatures); // 3rd after reset
    assert.ok(flags.length >= 1);
  });
});

describe('detectors/kill-rate', () => {
  it('flags impossible kill rate (hard cap)', () => {
    const features = new Map([['S1', {
      killsPerMinute: 200,
      totalKillDelta: 200,
      zombieKillDelta: 190,
      pvpKillDelta: 10,
      lifetimeKillDelta: 200,
      headshotRatio: 0.5,
      elapsedMin: 1,
    }]]);
    const flags = killRateDetector.detect(features);
    assert.ok(flags.length >= 1);
    assert.equal(flags[0].detector, 'impossible_kill_rate');
  });

  it('does not flag normal kill rate', () => {
    const features = new Map([['S1', {
      killsPerMinute: 5,
      totalKillDelta: 5,
      zombieKillDelta: 5,
      pvpKillDelta: 0,
      lifetimeKillDelta: 5,
      headshotRatio: 0.4,
      elapsedMin: 1,
    }]]);
    const flags = killRateDetector.detect(features);
    assert.equal(flags.length, 0);
  });

  it('skips when too few kills', () => {
    const features = new Map([['S1', {
      killsPerMinute: 100,
      totalKillDelta: 2, // below MIN_KILLS_TO_FLAG
      zombieKillDelta: 2,
      pvpKillDelta: 0,
      lifetimeKillDelta: 2,
      headshotRatio: 1.0,
      elapsedMin: 0.02,
    }]]);
    const flags = killRateDetector.detect(features);
    assert.equal(flags.length, 0);
  });

  it('trains baseline without crashing', () => {
    const { BaselineModeler } = require('@humanitzbot/qs-anticheat/src/baseline/modeler');
    const model = new BaselineModeler();
    const features = new Map([['S1', {
      killsPerMinute: 5, totalKillDelta: 5, lifetimeKillDelta: 5,
      headshotRatio: 0.4, elapsedMin: 1,
    }]]);
    killRateDetector.train(features, model);
    assert.ok(true);
  });
});

describe('detectors/stat-regression', () => {
  it('flags regressions', () => {
    const features = new Map([['S1', {
      regressions: [
        { field: 'zeeksKilled', previous: 100, current: 50, delta: -50 },
        { field: 'lifetimeKills', previous: 200, current: 100, delta: -100 },
      ],
    }]]);
    const flags = statRegressionDetector.detect(features);
    assert.ok(flags.length >= 1);
    assert.equal(flags[0].detector, 'stat_regression');
    assert.equal(flags[0].severity, 'high'); // 2 regressions → high
  });

  it('assigns critical severity for 3+ regressions', () => {
    const features = new Map([['S1', {
      regressions: [
        { field: 'zeeksKilled', previous: 100, current: 50, delta: -50 },
        { field: 'lifetimeKills', previous: 200, current: 100, delta: -100 },
        { field: 'fishCaught', previous: 10, current: 3, delta: -7 },
      ],
    }]]);
    const flags = statRegressionDetector.detect(features);
    assert.equal(flags[0].severity, 'critical');
  });

  it('returns empty for no regressions', () => {
    const features = new Map();
    const flags = statRegressionDetector.detect(features);
    assert.equal(flags.length, 0);
  });
});

// ── Scoring ─────────────────────────────────────────────────────────

const { sortFlags, computeRawRisk, normaliseRisk, deduplicateFlags, SEVERITY_WEIGHTS } = require('@humanitzbot/qs-anticheat/src/scoring/scorer');
const { checkEscalation, escalateOne } = require('@humanitzbot/qs-anticheat/src/scoring/escalation');

describe('scoring/scorer', () => {
  it('sortFlags puts highest severity first', () => {
    const flags = [
      { severity: 'low', score: 0.5 },
      { severity: 'critical', score: 0.9 },
      { severity: 'medium', score: 0.6 },
    ];
    const sorted = sortFlags(flags);
    assert.equal(sorted[0].severity, 'critical');
    assert.equal(sorted[1].severity, 'medium');
    assert.equal(sorted[2].severity, 'low');
  });

  it('sortFlags sorts by score within same severity', () => {
    const flags = [
      { severity: 'low', score: 0.3 },
      { severity: 'low', score: 0.9 },
      { severity: 'low', score: 0.6 },
    ];
    const sorted = sortFlags(flags);
    assert.equal(sorted[0].score, 0.9);
  });

  it('computeRawRisk sums weighted scores', () => {
    const flags = [
      { severity: 'high', score: 0.8 },
      { severity: 'low', score: 0.5 },
    ];
    const risk = computeRawRisk(flags);
    const expected = SEVERITY_WEIGHTS.high * 0.8 + SEVERITY_WEIGHTS.low * 0.5;
    assert.ok(Math.abs(risk - expected) < 0.001);
  });

  it('normaliseRisk returns 0 for 0', () => {
    assert.equal(normaliseRisk(0), 0);
  });

  it('normaliseRisk returns 0.5 for k', () => {
    assert.equal(normaliseRisk(1, 1), 0.5);
  });

  it('normaliseRisk caps at 1.0', () => {
    assert.ok(normaliseRisk(100, 1) <= 1.0);
  });

  it('deduplicateFlags keeps highest-scoring per player+detector', () => {
    const flags = [
      { steamId: 'S1', detector: 'teleportation', score: 0.3 },
      { steamId: 'S1', detector: 'teleportation', score: 0.8 },
      { steamId: 'S1', detector: 'speed_hack', score: 0.5 },
    ];
    const deduped = deduplicateFlags(flags);
    assert.equal(deduped.length, 2);
    const teleFlag = deduped.find(f => f.detector === 'teleportation');
    assert.equal(teleFlag.score, 0.8);
  });
});

describe('scoring/escalation', () => {
  it('escalateOne bumps severity by one level', () => {
    assert.equal(escalateOne('low'), 'medium');
    assert.equal(escalateOne('medium'), 'high');
    assert.equal(escalateOne('high'), 'critical');
    assert.equal(escalateOne('critical'), 'critical'); // can't go higher
  });

  it('escalates low to medium on 3 different detectors in 1 hour', () => {
    const recentFlags = [
      { detector: 'teleportation', severity: 'low', created_at: new Date().toISOString() },
      { detector: 'speed_hack', severity: 'low', created_at: new Date().toISOString() },
    ];
    const newFlag = { detector: 'kill_rate', severity: 'low' };
    const result = checkEscalation(recentFlags, newFlag, 0);
    assert.equal(result.escalated, true);
    assert.equal(result.newSeverity, 'medium');
    assert.ok(result.reason.includes('compound'));
  });

  it('does not escalate with only 2 detectors', () => {
    const recentFlags = [
      { detector: 'teleportation', severity: 'low', created_at: new Date().toISOString() },
    ];
    const newFlag = { detector: 'speed_hack', severity: 'low' };
    const result = checkEscalation(recentFlags, newFlag, 0);
    assert.equal(result.escalated, false);
    assert.equal(result.newSeverity, 'low');
  });

  it('escalates on high risk score', () => {
    const result = checkEscalation([], { detector: 'test', severity: 'low' }, 0.8);
    assert.equal(result.escalated, true);
    assert.equal(result.newSeverity, 'medium');
    assert.ok(result.reason.includes('risk_score'));
  });

  it('does not escalate critical severity even with high risk', () => {
    const result = checkEscalation([], { detector: 'test', severity: 'critical' }, 0.9);
    // severity stays critical (can't go higher)
    assert.equal(result.newSeverity, 'critical');
  });
});

// ── AnticheatEngine (integration) ──────────────────────────────────

const AnticheatEngine = require('@humanitzbot/qs-anticheat');

describe('AnticheatEngine', () => {
  let engine;

  beforeEach(() => {
    engine = new AnticheatEngine();
  });

  afterEach(() => {
    engine.shutdown();
  });

  it('has a version string', () => {
    assert.ok(engine.version);
    assert.equal(typeof engine.version, 'string');
  });

  it('init sets initialised state', () => {
    const fakeDb = { db: { prepare: () => ({ all: () => [], get: () => null }) } };
    engine.init(fakeDb);
    const diag = engine.getDiagnostics();
    assert.equal(diag.initialised, true);
  });

  it('analyze returns empty array when not initialised', () => {
    const flags = engine.analyze({});
    assert.deepEqual(flags, []);
  });

  it('analyze runs without crashing with minimal DB mock', () => {
    const fakeDb = {
      db: {
        prepare: () => ({
          all: () => [],
          get: () => null,
        }),
      },
    };
    engine.init(fakeDb);
    const flags = engine.analyze({ players: new Map(), elapsed: 30_000 });
    assert.ok(Array.isArray(flags));
  });

  it('detects stat regression via full pipeline', () => {
    const fakeDb = {
      db: {
        prepare: () => ({
          all: () => [],
          get: () => null,
        }),
      },
    };
    engine.init(fakeDb);

    // First sync — establishes previous stats
    engine.analyze({
      players: new Map([['S1', {
        zeeksKilled: 100, lifetimeKills: 200, headshots: 50,
        lifetimeDaysSurvived: 10, fishCaught: 5, animalKills: 3, banditKills: 2,
      }]]),
      elapsed: 30_000,
    });

    // Second sync — stat regression (zeeksKilled went down)
    const flags = engine.analyze({
      players: new Map([['S1', {
        zeeksKilled: 50, lifetimeKills: 200, headshots: 50,
        lifetimeDaysSurvived: 10, fishCaught: 5, animalKills: 3, banditKills: 2,
      }]]),
      elapsed: 30_000,
    });

    const regressionFlags = flags.filter(f => f.detector === 'stat_regression');
    assert.ok(regressionFlags.length >= 1, 'should detect stat regression');
  });

  it('applyEscalation works with mock lookups', () => {
    const flags = [
      { steamId: 'S1', detector: 'test', severity: 'low', score: 0.5 },
    ];
    const escalated = engine.applyEscalation(
      flags,
      () => [],   // no recent flags
      () => 0.8,  // high risk score
    );
    assert.ok(escalated[0].autoEscalated);
    assert.equal(escalated[0].severity, 'medium');
  });

  it('recalibrateBaseline does not crash', () => {
    const fakeDb = { db: { prepare: () => ({ all: () => [], get: () => null }) } };
    engine.init(fakeDb);
    engine.recalibrateBaseline();
    assert.ok(true);
  });

  it('exportBaseline returns serialisable object', () => {
    const fakeDb = { db: { prepare: () => ({ all: () => [], get: () => null }) } };
    engine.init(fakeDb);
    const baseline = engine.exportBaseline();
    assert.ok(baseline);
    assert.ok(typeof baseline === 'object');
    const json = JSON.stringify(baseline);
    assert.ok(json);
  });

  it('getDiagnostics returns status info', () => {
    const diag = engine.getDiagnostics();
    assert.equal(diag.initialised, false);
    assert.equal(diag.version, engine.version);
  });

  it('shutdown cleans up state', () => {
    const fakeDb = { db: { prepare: () => ({ all: () => [], get: () => null }) } };
    engine.init(fakeDb);
    engine.shutdown();
    const diag = engine.getDiagnostics();
    assert.equal(diag.initialised, false);
    assert.equal(diag.hasPreviousStats, false);
  });

  it('init restores saved baseline', () => {
    const fakeDb = { db: { prepare: () => ({ all: () => [], get: () => null }) } };
    // Build a baseline with enough data
    const tmpEngine = new AnticheatEngine();
    tmpEngine.init(fakeDb);
    // Record enough data to make baseline ready
    for (let i = 0; i < 40; i++) {
      tmpEngine._baseline.recordServer('test_metric', i * 10, Date.now());
    }
    const saved = tmpEngine.exportBaseline();
    tmpEngine.shutdown();

    // Restore into a new engine
    engine.init(fakeDb, saved);
    assert.ok(engine._baseline.isReady('test_metric'));
  });
});

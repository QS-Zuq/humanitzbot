const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

// Prevent auto-load from previous state
const fs = require('fs');
const path = require('path');
const LOCATIONS_FILE = path.join(__dirname, '..', 'data', 'player-locations.json');

describe('PlayerMapTracker', () => {
  let tracker;
  let _origWriteFileSync;

  before(() => {
    _origWriteFileSync = fs.writeFileSync;
  });

  beforeEach(() => {
    // Clean up any existing tracker timer before creating a new one
    if (tracker) {
      if (tracker._saveTimer) clearInterval(tracker._saveTimer);
      tracker._saveTimer = null;
    }

    // Get a fresh tracker by clearing the require cache
    delete require.cache[require.resolve('../src/player-map')];
    // Mock fs.existsSync for the locations file to return false
    const _origExists = fs.existsSync;
    fs.existsSync = (p) => {
      if (p === LOCATIONS_FILE || p === path.join(__dirname, '..', 'data', 'map-image.png')) return false;
      return _origExists(p);
    };
    // Mock writeFileSync to prevent disk writes
    fs.writeFileSync = () => {};
    tracker = require('../src/player-map');
    // Clear the auto-save timer immediately
    if (tracker._saveTimer) clearInterval(tracker._saveTimer);
    tracker._saveTimer = null;
    // Restore existsSync (writeFileSync stays mocked)
    fs.existsSync = _origExists;
  });

  after(() => {
    // Restore writeFileSync
    fs.writeFileSync = _origWriteFileSync;
    // Final cleanup
    if (tracker) {
      if (tracker._saveTimer) clearInterval(tracker._saveTimer);
      tracker._saveTimer = null;
    }
  });

  // Clean up after each test to prevent dangling timers
  afterEach(() => {
    if (tracker && tracker._saveTimer) {
      clearInterval(tracker._saveTimer);
      tracker._saveTimer = null;
    }
  });

  describe('updateFromSave()', () => {
    it('should track player positions from save data', () => {
      const players = new Map();
      players.set('76561198000000001', {
        x: 120000, y: -180000, z: 500, rotationYaw: 90,
        name: 'Player1', daysSurvived: 5,
      });
      players.set('76561198000000002', {
        x: 50000, y: -100000, z: 300, rotationYaw: 45,
        name: 'Player2', daysSurvived: 10,
      });

      const nameMap = new Map([
        ['76561198000000001', 'TestPlayer1'],
        ['76561198000000002', 'TestPlayer2'],
      ]);

      tracker.updateFromSave(players, new Set(['76561198000000001']), nameMap);

      const locs = tracker.getLocations();
      assert.equal(Object.keys(locs).length, 2);
      assert.equal(locs['76561198000000001'].name, 'TestPlayer1');
      assert.equal(locs['76561198000000001'].lastX, 120000);
      assert.equal(locs['76561198000000001'].lastY, -180000);
      assert.equal(locs['76561198000000001'].online, true);
      assert.equal(locs['76561198000000002'].online, false);
    });

    it('should skip players at origin (0,0,0)', () => {
      const players = new Map();
      players.set('76561198000000001', {
        x: 0, y: 0, z: 0, rotationYaw: 0,
        name: 'FreshSpawn',
      });
      players.set('76561198000000002', {
        x: 50000, y: -100000, z: 300, rotationYaw: 45,
        name: 'RealPlayer',
      });

      tracker.updateFromSave(players);

      const locs = tracker.getLocations();
      assert.equal(Object.keys(locs).length, 1);
      assert.ok(locs['76561198000000002']);
      assert.ok(!locs['76561198000000001']);
    });

    it('should skip players with null coordinates', () => {
      const players = new Map();
      players.set('76561198000000001', {
        x: null, y: null, z: null, rotationYaw: null,
        name: 'NoData',
      });

      tracker.updateFromSave(players);
      assert.equal(Object.keys(tracker.getLocations()).length, 0);
    });

    it('should append to history when position changes', () => {
      const players = new Map();
      players.set('76561198000000001', {
        x: 100000, y: -200000, z: 500, rotationYaw: 0,
      });

      tracker.updateFromSave(players);
      const loc1 = tracker.getPlayerLocation('76561198000000001');
      assert.equal(loc1.history.length, 1);

      // Move the player
      players.set('76561198000000001', {
        x: 110000, y: -210000, z: 500, rotationYaw: 90,
      });
      tracker.updateFromSave(players);
      const loc2 = tracker.getPlayerLocation('76561198000000001');
      assert.equal(loc2.history.length, 2);
    });

    it('should NOT append to history when position barely changes', () => {
      const players = new Map();
      players.set('76561198000000001', {
        x: 100000, y: -200000, z: 500, rotationYaw: 0,
      });

      tracker.updateFromSave(players);

      // Move only 50 units (below 100-unit threshold)
      players.set('76561198000000001', {
        x: 100030, y: -200040, z: 500, rotationYaw: 0,
      });
      tracker.updateFromSave(players);
      const loc = tracker.getPlayerLocation('76561198000000001');
      assert.equal(loc.history.length, 1);
    });

    it('should update heatmap grid', () => {
      const players = new Map();
      players.set('76561198000000001', {
        x: 120000, y: -180000, z: 500, rotationYaw: 0,
      });

      tracker.updateFromSave(players);
      const heatmap = tracker.getHeatmapData();
      assert.ok(Object.keys(heatmap).length > 0);
      // At least one cell should have count >= 1
      const vals = Object.values(heatmap);
      assert.ok(vals.some(v => v >= 1));
    });

    it('should mark previously-online players as offline', () => {
      const players = new Map();
      players.set('76561198000000001', {
        x: 100000, y: -200000, z: 500, rotationYaw: 0,
      });

      // First poll: player is online
      tracker.updateFromSave(players, new Set(['76561198000000001']));
      assert.equal(tracker.getPlayerLocation('76561198000000001').online, true);

      // Second poll: player is offline
      tracker.updateFromSave(players, new Set());
      assert.equal(tracker.getPlayerLocation('76561198000000001').online, false);
    });
  });

  describe('getLocations()', () => {
    it('should return empty object when no data', () => {
      assert.deepEqual(tracker.getLocations(), {});
    });
  });

  describe('getPlayerLocation()', () => {
    it('should return null for unknown player', () => {
      assert.equal(tracker.getPlayerLocation('76561198999999999'), null);
    });

    it('should return player data when tracked', () => {
      const players = new Map();
      players.set('76561198000000001', {
        x: 100000, y: -200000, z: 500, rotationYaw: 45,
      });
      tracker.updateFromSave(players);

      const loc = tracker.getPlayerLocation('76561198000000001');
      assert.equal(loc.lastX, 100000);
      assert.equal(loc.lastY, -200000);
      assert.equal(loc.lastZ, 500);
      assert.ok(loc.lastSeen);
      assert.ok(Array.isArray(loc.history));
    });
  });

  describe('getSummary()', () => {
    it('should return zeros when empty', () => {
      const summary = tracker.getSummary();
      assert.equal(summary.totalPlayers, 0);
      assert.equal(summary.online, 0);
      assert.equal(summary.offline, 0);
      assert.equal(summary.totalPoints, 0);
      assert.equal(summary.heatmapCells, 0);
    });

    it('should count online/offline/history correctly', () => {
      const players = new Map();
      players.set('76561198000000001', {
        x: 100000, y: -200000, z: 500, rotationYaw: 0,
      });
      players.set('76561198000000002', {
        x: 120000, y: -180000, z: 300, rotationYaw: 90,
      });

      tracker.updateFromSave(players, new Set(['76561198000000001']));

      const summary = tracker.getSummary();
      assert.equal(summary.totalPlayers, 2);
      assert.equal(summary.online, 1);
      assert.equal(summary.offline, 1);
      assert.equal(summary.totalPoints, 2); // 1 history point each
      assert.ok(summary.heatmapCells > 0);
      assert.ok(summary.lastUpdated);
    });
  });

  describe('_worldToPixel()', () => {
    it('should convert world coordinates to pixel coordinates', () => {
      // Test center of map
      const centerX = (-20000 + 260000) / 2; // 120000
      const centerY = (-370000 + 20000) / 2; // -175000
      const result = tracker._worldToPixel(centerX, centerY, 1000, 1000);
      // Should be roughly center of image
      assert.ok(result.px >= 400 && result.px <= 600, `px ${result.px} should be ~500`);
      assert.ok(result.py >= 400 && result.py <= 600, `py ${result.py} should be ~500`);
    });

    it('should handle min/max world bounds', () => {
      // Top-left of world → left edge of image
      const topLeft = tracker._worldToPixel(-20000, 20000, 1000, 1000);
      assert.equal(topLeft.px, 0);

      // Bottom-right of world → right edge of image  
      const bottomRight = tracker._worldToPixel(260000, -370000, 1000, 1000);
      assert.equal(bottomRight.px, 1000);
    });
  });

  describe('reset()', () => {
    it('should clear all tracking data', () => {
      const players = new Map();
      players.set('76561198000000001', {
        x: 100000, y: -200000, z: 500, rotationYaw: 0,
      });
      tracker.updateFromSave(players);
      // Clear the timer that _load() started
      if (tracker._saveTimer) clearInterval(tracker._saveTimer);
      tracker._saveTimer = null;

      assert.equal(Object.keys(tracker.getLocations()).length, 1);

      tracker.reset();

      assert.equal(Object.keys(tracker.getLocations()).length, 0);
      assert.equal(Object.keys(tracker.getHeatmapData()).length, 0);
    });
  });

  describe('destroy()', () => {
    it('should clear timer without error', () => {
      tracker._dirty = true;
      tracker._saveTimer = setInterval(() => {}, 99999);
      tracker.destroy();
      assert.equal(tracker._saveTimer, null);
      assert.equal(tracker._dirty, false); // _save() was called
    });
  });
});

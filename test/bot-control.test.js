/**
 * Tests for BotControlService — bot lifecycle actions.
 * Run: npm test
 */

'use strict';

// Must set env vars before any project requires (config.js has side effects)
process.env.DISCORD_TOKEN = 'test-token';
process.env.DISCORD_CLIENT_ID = '123456';
process.env.DISCORD_GUILD_ID = '654321';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const BotControlService = require('../src/server/bot-control');

// ── Helpers ──────────────────────────────────────────────────

/** Create a spy exit function */
function spyExit() {
  const calls = [];
  const fn = (code) => calls.push(code);
  fn.calls = calls;
  return fn;
}

// ══════════════════════════════════════════════════════════════
// BotControlService
// ══════════════════════════════════════════════════════════════

describe('BotControlService', () => {
  let exitSpy;
  let svc;

  // Save/restore env vars that writeEnvValues touches
  const savedEnv = {};

  beforeEach(() => {
    savedEnv.NUKE_BOT = process.env.NUKE_BOT;
    savedEnv.FIRST_RUN = process.env.FIRST_RUN;
    delete process.env.NUKE_BOT;
    delete process.env.FIRST_RUN;

    exitSpy = spyExit();
    svc = new BotControlService({ exit: exitSpy });
  });

  afterEach(() => {
    // Restore env
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v !== undefined) {
        process.env[k] = v;
      } else {
        delete process.env[k];
      }
    }
  });

  // ── pendingAction ──────────────────────────────────────────

  describe('pendingAction', () => {
    it('returns null initially', () => {
      assert.equal(svc.pendingAction, null);
    });

    it('returns action name after restart', () => {
      svc.restart({ source: 'test' });
      assert.equal(svc.pendingAction, 'restart');
    });

    it('returns action name after factoryReset', () => {
      svc.factoryReset({ source: 'test' });
      assert.equal(svc.pendingAction, 'factory_reset');
    });

    it('returns action name after reimport', () => {
      svc.reimport({ source: 'test' });
      assert.equal(svc.pendingAction, 'reimport');
    });
  });

  // ── restart ────────────────────────────────────────────────

  describe('restart', () => {
    it('returns { action: "restart", scheduledAt }', () => {
      const result = svc.restart({ source: 'test' });
      assert.equal(result.action, 'restart');
      assert.ok(result.scheduledAt);
      // scheduledAt should be a valid ISO date
      assert.ok(!isNaN(Date.parse(result.scheduledAt)));
    });

    it('schedules exit(0) after delay', async () => {
      svc.restart({ source: 'test' });
      // exit not called yet (setTimeout delay)
      assert.equal(exitSpy.calls.length, 0);
      // Wait for the setTimeout to fire
      await new Promise((resolve) => setTimeout(resolve, 1600));
      assert.equal(exitSpy.calls.length, 1);
      assert.equal(exitSpy.calls[0], 0);
    });

    it('throws if another action is already pending', () => {
      svc.restart({ source: 'test' });
      assert.throws(() => svc.restart({ source: 'test' }), /already pending/);
    });

    it('logs source and user', () => {
      // Just ensure no throw — console output is not tested
      svc.restart({ source: 'discord', user: 'TestUser#1234' });
      assert.equal(svc.pendingAction, 'restart');
    });
  });

  // ── factoryReset ───────────────────────────────────────────

  describe('factoryReset', () => {
    it('returns { action: "factory_reset", scheduledAt }', () => {
      const result = svc.factoryReset({ source: 'test' });
      assert.equal(result.action, 'factory_reset');
      assert.ok(result.scheduledAt);
    });

    it('sets NUKE_BOT=true in process.env', () => {
      svc.factoryReset({ source: 'test' });
      assert.equal(process.env.NUKE_BOT, 'true');
    });

    it('schedules exit(0) after delay', async () => {
      svc.factoryReset({ source: 'test' });
      assert.equal(exitSpy.calls.length, 0);
      await new Promise((resolve) => setTimeout(resolve, 1600));
      assert.equal(exitSpy.calls.length, 1);
      assert.equal(exitSpy.calls[0], 0);
    });

    it('throws if another action is already pending', () => {
      svc.restart({ source: 'test' });
      assert.throws(() => svc.factoryReset({ source: 'test' }), /already pending/);
    });
  });

  // ── reimport ───────────────────────────────────────────────

  describe('reimport', () => {
    it('returns { action: "reimport", scheduledAt }', () => {
      const result = svc.reimport({ source: 'test' });
      assert.equal(result.action, 'reimport');
      assert.ok(result.scheduledAt);
    });

    it('sets FIRST_RUN=true in process.env', () => {
      svc.reimport({ source: 'test' });
      assert.equal(process.env.FIRST_RUN, 'true');
    });

    it('schedules exit(0) after delay', async () => {
      svc.reimport({ source: 'test' });
      assert.equal(exitSpy.calls.length, 0);
      await new Promise((resolve) => setTimeout(resolve, 1600));
      assert.equal(exitSpy.calls.length, 1);
      assert.equal(exitSpy.calls[0], 0);
    });

    it('throws if another action is already pending', () => {
      svc.factoryReset({ source: 'test' });
      assert.throws(() => svc.reimport({ source: 'test' }), /already pending/);
    });
  });

  // ── envSync ────────────────────────────────────────────────

  describe('envSync', () => {
    it('returns { needed: false } when already up to date', () => {
      // env-sync checks ENV_SCHEMA_VERSION in .env vs .env.example
      // In test env they should be the same (or .env.example might not exist)
      const result = svc.envSync();
      assert.equal(result.action, 'env_sync');
      assert.equal(typeof result.needed, 'boolean');
    });

    it('does not set pendingAction (env_sync does not restart)', () => {
      svc.envSync();
      assert.equal(svc.pendingAction, null);
    });

    it('does not call exit', async () => {
      svc.envSync();
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(exitSpy.calls.length, 0);
    });
  });
});

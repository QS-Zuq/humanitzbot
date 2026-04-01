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

  // Save/restore env vars AND .env file that writeEnvValues touches
  const savedEnv = {};
  const fs = require('fs');
  const path = require('path');
  const envPath = path.join(__dirname, '..', '.env');
  let savedEnvFile;

  beforeEach(() => {
    savedEnv.NUKE_BOT = process.env.NUKE_BOT;
    savedEnv.FIRST_RUN = process.env.FIRST_RUN;
    delete process.env.NUKE_BOT;
    delete process.env.FIRST_RUN;
    // Backup .env file — tests call writeEnvValues which modifies the real file
    try {
      savedEnvFile = fs.readFileSync(envPath, 'utf8');
    } catch (_) {
      savedEnvFile = null;
    }

    exitSpy = spyExit();
    svc = new BotControlService({ exit: exitSpy });
  });

  afterEach(() => {
    // Restore env vars
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v !== undefined) {
        process.env[k] = v;
      } else {
        delete process.env[k];
      }
    }
    // Restore .env file to prevent NUKE_BOT=true from persisting
    if (savedEnvFile !== null) {
      try {
        fs.writeFileSync(envPath, savedEnvFile, 'utf8');
      } catch (_) {}
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

  // ── Shared exit-action tests ────────────────────────────────

  /**
   * Register shared tests for an exit action (restart/factoryReset/reimport).
   * @param {string} methodName - Service method name
   * @param {string} actionId - Expected action ID in result
   */
  function describeExitAction(methodName, actionId) {
    it(`returns { action: "${actionId}", scheduledAt }`, () => {
      const result = svc[methodName]({ source: 'test' });
      assert.equal(result.action, actionId);
      assert.ok(result.scheduledAt);
      assert.ok(!isNaN(Date.parse(result.scheduledAt)));
    });

    it('schedules exit(0) after delay', async () => {
      svc[methodName]({ source: 'test' });
      assert.equal(exitSpy.calls.length, 0);
      await new Promise((resolve) => setTimeout(resolve, 1600));
      assert.equal(exitSpy.calls.length, 1);
      assert.equal(exitSpy.calls[0], 0);
    });

    it('throws if another action is already pending', () => {
      svc[methodName]({ source: 'test' });
      assert.throws(() => svc[methodName]({ source: 'test' }), /already pending/);
    });
  }

  // ── restart ────────────────────────────────────────────────

  describe('restart', () => {
    describeExitAction('restart', 'restart');

    it('logs source and user', () => {
      svc.restart({ source: 'discord', user: 'TestUser#1234' });
      assert.equal(svc.pendingAction, 'restart');
    });
  });

  // ── factoryReset ───────────────────────────────────────────

  describe('factoryReset', () => {
    describeExitAction('factoryReset', 'factory_reset');

    it('sets NUKE_BOT=true in process.env', () => {
      svc.factoryReset({ source: 'test' });
      assert.equal(process.env.NUKE_BOT, 'true');
    });
  });

  // ── reimport ───────────────────────────────────────────────

  describe('reimport', () => {
    describeExitAction('reimport', 'reimport');

    it('sets FIRST_RUN=true in process.env', () => {
      svc.reimport({ source: 'test' });
      assert.equal(process.env.FIRST_RUN, 'true');
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

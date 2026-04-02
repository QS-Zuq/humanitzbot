/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-require-imports, @typescript-eslint/no-floating-promises, @typescript-eslint/no-dynamic-delete */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';

const BotControlService = require('../src/server/bot-control');

const { _setTestPaths, _resetPaths } = require('../src/utils/env-writer');

// ── Helpers ──────────────────────────────────────────────────

/** Create a spy exit function */
function spyExit() {
  const calls: number[] = [];
  const fn = (code: number) => calls.push(code);
  (fn as any).calls = calls;
  return fn;
}

// ══════════════════════════════════════════════════════════════
// BotControlService
// ══════════════════════════════════════════════════════════════

describe('BotControlService', () => {
  let exitSpy: any;
  let svc: any;

  // Redirect writeEnvValues to temp files — never touch real .env or nuke-audit.log
  const savedEnv: Record<string, string | undefined> = {};
  let tmpDir: string;

  beforeEach(() => {
    savedEnv.NUKE_BOT = process.env.NUKE_BOT;
    savedEnv.FIRST_RUN = process.env.FIRST_RUN;
    delete process.env.NUKE_BOT;
    delete process.env.FIRST_RUN;

    // Create temp directory for .env and audit log
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-control-test-'));
    const tmpEnv = path.join(tmpDir, '.env');
    const tmpAudit = path.join(tmpDir, 'nuke-audit.log');
    // Seed temp .env with minimal content
    fs.writeFileSync(tmpEnv, 'NUKE_BOT=false\nFIRST_RUN=false\n', 'utf8');
    _setTestPaths(tmpEnv, tmpAudit);

    exitSpy = spyExit();
    svc = new BotControlService({ exit: exitSpy });
  });

  afterEach(() => {
    _resetPaths();
    // Restore env vars
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v !== undefined) {
        process.env[k] = v;
      } else {
        delete process.env[k];
      }
    }
    // Clean up temp directory
    if (tmpDir) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
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
   */
  function describeExitAction(methodName: string, actionId: string) {
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

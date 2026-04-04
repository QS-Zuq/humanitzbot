/**
 * Tests for src/utils/setup-checks.js — checkPrerequisites + testRconReachability
 * Run: npm test
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import * as _setup_checks from '../src/utils/setup-checks.js';
const { checkPrerequisites, testRconReachability } = _setup_checks as any;

describe('setup-checks', () => {
  describe('checkPrerequisites', () => {
    const originalEnv: Record<string, string | undefined> = {};
    const KEYS = [
      'DISCORD_TOKEN',
      'DISCORD_CLIENT_ID',
      'DISCORD_GUILD_ID',
      'SFTP_HOST',
      'SFTP_USER',
      'SFTP_PASSWORD',
      'SFTP_PRIVATE_KEY_PATH',
      'FTP_HOST',
      'FTP_USER',
      'FTP_PASSWORD',
      'FTP_PRIVATE_KEY_PATH',
      'RCON_HOST',
      'RCON_PASSWORD',
    ];

    function setDiscordEnv() {
      process.env.DISCORD_TOKEN = 'valid';
      process.env.DISCORD_CLIENT_ID = 'valid';
      process.env.DISCORD_GUILD_ID = 'valid';
    }

    function setRconEnv() {
      process.env.RCON_HOST = '127.0.0.1';
      process.env.RCON_PASSWORD = 'secret';
    }

    beforeEach(() => {
      for (const key of KEYS) {
        originalEnv[key] = process.env[key];
        Reflect.deleteProperty(process.env, key);
      }
    });

    afterEach(() => {
      for (const [key, val] of Object.entries(originalEnv)) {
        if (val === undefined) Reflect.deleteProperty(process.env, key);
        else process.env[key] = val;
      }
    });

    it('reports missing Discord keys as errors', () => {
      const issues = checkPrerequisites();
      const errors = issues.filter((i: { type: string }) => i.type === 'missing');
      const keys = errors.map((i: { key: string }) => i.key);
      assert.ok(keys.includes('DISCORD_TOKEN'));
      assert.ok(keys.includes('DISCORD_CLIENT_ID'));
      assert.ok(keys.includes('DISCORD_GUILD_ID'));
    });

    it('reports missing RCON keys as warnings', () => {
      setDiscordEnv();
      const issues = checkPrerequisites();
      const warnings = issues.filter((i: { type: string }) => i.type === 'warning');
      assert.ok(warnings.some((w: { key: string }) => w.key === 'RCON_HOST'));
      assert.ok(warnings.some((w: { key: string }) => w.key === 'RCON_PASSWORD'));
    });

    it('returns empty when all keys present', () => {
      setDiscordEnv();
      process.env.SFTP_HOST = 'valid';
      process.env.SFTP_USER = 'valid';
      process.env.SFTP_PASSWORD = 'valid';
      setRconEnv();
      const issues = checkPrerequisites();
      assert.strictEqual(issues.length, 0);
    });

    it('skips SFTP when skipSftp is true', () => {
      setDiscordEnv();
      setRconEnv();
      const issues = checkPrerequisites({ skipSftp: true });
      assert.strictEqual(
        issues.filter((i: { key: string }) => i.key.startsWith('SFTP') || i.key.startsWith('FTP')).length,
        0,
      );
    });

    it('detects placeholder values', () => {
      process.env.DISCORD_TOKEN = 'your_token_here';
      const issues = checkPrerequisites();
      assert.ok(issues.some((i: { key: string; type: string }) => i.key === 'DISCORD_TOKEN' && i.type === 'missing'));
    });

    it('reports SFTP keys as errors by default', () => {
      setDiscordEnv();
      setRconEnv();
      // SFTP keys deliberately missing
      const issues = checkPrerequisites();
      const sftpErrors = issues.filter(
        (i: { key: string; type: string }) => i.key.startsWith('SFTP') && i.type === 'missing',
      );
      assert.strictEqual(sftpErrors.length, 3); // SFTP_HOST, SFTP_USER, SFTP_PASSWORD (or key path)
    });

    it('treats RCON placeholder values as warnings (not errors)', () => {
      setDiscordEnv();
      process.env.SFTP_HOST = 'valid';
      process.env.SFTP_USER = 'valid';
      process.env.SFTP_PASSWORD = 'valid';
      process.env.RCON_HOST = 'your_server_ip';
      process.env.RCON_PASSWORD = 'your_password';
      const issues = checkPrerequisites();
      const rconIssues = issues.filter((i: { key: string }) => i.key.startsWith('RCON'));
      assert.ok(rconIssues.every((i: { type: string }) => i.type === 'warning'));
      assert.strictEqual(rconIssues.length, 2);
    });

    it('detects SFTP placeholder values', () => {
      setDiscordEnv();
      setRconEnv();
      process.env.SFTP_HOST = 'your_ftp_host';
      process.env.SFTP_USER = 'your_ftp_user';
      process.env.SFTP_PASSWORD = 'your_ftp_password';
      const issues = checkPrerequisites();
      const sftpErrors = issues.filter(
        (i: { key: string; type: string }) => i.key.startsWith('SFTP') && i.type === 'missing',
      );
      assert.strictEqual(sftpErrors.length, 3);
    });

    // ── C1: SSH key auth ──────────────────────────────────────

    it('accepts SFTP_PRIVATE_KEY_PATH without SFTP_PASSWORD', () => {
      setDiscordEnv();
      setRconEnv();
      process.env.SFTP_HOST = 'valid';
      process.env.SFTP_USER = 'valid';
      process.env.SFTP_PRIVATE_KEY_PATH = '/path/to/key';
      const issues = checkPrerequisites();
      const sftpErrors = issues.filter(
        (i: { key: string; type: string }) => i.key.startsWith('SFTP') && i.type === 'missing',
      );
      assert.strictEqual(sftpErrors.length, 0);
    });

    it('reports missing when neither SFTP_PASSWORD nor SFTP_PRIVATE_KEY_PATH is set', () => {
      setDiscordEnv();
      setRconEnv();
      process.env.SFTP_HOST = 'valid';
      process.env.SFTP_USER = 'valid';
      const issues = checkPrerequisites();
      const credError = issues.find(
        (i: { key: string; type: string }) => i.key === 'SFTP_PASSWORD' && i.type === 'missing',
      );
      assert.ok(credError, 'Should report SFTP_PASSWORD as missing');
      assert.ok(credError.label.includes('SFTP_PRIVATE_KEY_PATH'), 'Label should mention key path alternative');
    });

    // ── C2: Legacy FTP_* fallback ─────────────────────────────

    it('accepts FTP_* fallback but warns about rename', () => {
      setDiscordEnv();
      setRconEnv();
      process.env.FTP_HOST = 'valid';
      process.env.FTP_USER = 'valid';
      process.env.FTP_PASSWORD = 'valid';
      const issues = checkPrerequisites();
      const sftpErrors = issues.filter(
        (i: { type: string; key: string }) =>
          i.type === 'missing' && (i.key.startsWith('SFTP') || i.key.startsWith('FTP')),
      );
      assert.strictEqual(sftpErrors.length, 0, 'No missing SFTP errors when FTP_* is set');
      const ftpWarnings = issues.filter(
        (i: { key: string; type: string }) => i.key.startsWith('FTP') && i.type === 'warning',
      );
      assert.ok(ftpWarnings.length > 0, 'Should warn about FTP_* rename');
    });

    it('does not warn about FTP_* when SFTP_* is set', () => {
      setDiscordEnv();
      setRconEnv();
      process.env.SFTP_HOST = 'valid';
      process.env.SFTP_USER = 'valid';
      process.env.SFTP_PASSWORD = 'valid';
      process.env.FTP_HOST = 'old_value'; // should be ignored
      const issues = checkPrerequisites();
      const ftpWarnings = issues.filter(
        (i: { key: string; type: string }) => i.key.startsWith('FTP') && i.type === 'warning',
      );
      assert.strictEqual(ftpWarnings.length, 0);
    });

    it('accepts FTP_PRIVATE_KEY_PATH as credential fallback', () => {
      setDiscordEnv();
      setRconEnv();
      process.env.SFTP_HOST = 'valid';
      process.env.SFTP_USER = 'valid';
      process.env.FTP_PRIVATE_KEY_PATH = '/path/to/key';
      const issues = checkPrerequisites();
      const credError = issues.find(
        (i: { key: string; type: string }) => i.key === 'SFTP_PASSWORD' && i.type === 'missing',
      );
      assert.strictEqual(credError, undefined, 'Should not report missing credentials with FTP key path');
    });
  });

  describe('testRconReachability', () => {
    const originalEnv: Record<string, string | undefined> = {};
    const KEYS = ['RCON_HOST', 'RCON_PORT', 'RCON_PASSWORD'];

    beforeEach(() => {
      for (const key of KEYS) {
        originalEnv[key] = process.env[key];
        Reflect.deleteProperty(process.env, key);
      }
    });

    afterEach(() => {
      for (const [key, val] of Object.entries(originalEnv)) {
        if (val === undefined) Reflect.deleteProperty(process.env, key);
        else process.env[key] = val;
      }
    });

    it('returns { ok: false } when RCON_HOST is missing', async () => {
      delete process.env.RCON_HOST;
      delete process.env.RCON_PASSWORD;
      const result = await testRconReachability();
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.error, 'NOT_CONFIGURED');
    });

    it('returns { ok: false } when RCON_PASSWORD is missing', async () => {
      process.env.RCON_HOST = '127.0.0.1';
      delete process.env.RCON_PASSWORD;
      const result = await testRconReachability();
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.error, 'NOT_CONFIGURED');
    });

    it('returns { ok: false } when credentials are placeholders', async () => {
      process.env.RCON_HOST = 'your_server_ip';
      process.env.RCON_PASSWORD = 'your_password';
      const result = await testRconReachability();
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.error, 'NOT_CONFIGURED');
    });

    it('returns { ok: false } with error details when connection is refused', async () => {
      process.env.RCON_HOST = '127.0.0.1';
      process.env.RCON_PORT = '19999'; // unlikely to be open
      process.env.RCON_PASSWORD = 'test';
      const result = await testRconReachability();
      assert.strictEqual(result.ok, false);
      assert.ok(result.error, 'Should have error code');
      assert.ok(result.message, 'Should have error message');
    });
  });
});

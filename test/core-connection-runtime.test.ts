import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import RuntimeConfigApplier from '../src/config/runtime-config-applier.js';
import { registerCoreConnectionRuntimeHandlers } from '../src/config/core-connection-runtime.js';

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    rconHost: 'old-rcon.example.test',
    rconPort: 14541,
    rconPassword: 'old-rcon-secret',
    sftpHost: 'old-sftp.example.test',
    sftpPort: 2022,
    sftpUser: 'old-user',
    sftpPassword: 'old-sftp-secret',
    sftpPrivateKeyPath: '',
    sftpBasePath: '',
    sftpLogPath: '/old/HMZLog.log',
    sftpConnectLogPath: '/old/PlayerConnectedLog.txt',
    sftpIdMapPath: '/old/PlayerIDMapped.txt',
    sftpSavePath: '/old/SaveList/Default/Save_DedicatedSaveMP.sav',
    sftpSettingsPath: '/old/GameServerSettings.ini',
    ...overrides,
  };
}

function registerWithFakes(
  options: {
    config?: Record<string, unknown>;
    rcon?: { reconnect(options: unknown): Promise<void>; disconnect(): void };
    saveService?: { reconfigure(options: unknown): void } | null;
    logWatcher?: { reconfigureSftpLogSource(options: unknown): Promise<void> } | null;
  } = {},
) {
  const applier = new RuntimeConfigApplier();
  const config = options.config ?? makeConfig();
  const rcon = options.rcon ?? {
    reconnect: async () => {},
    disconnect() {},
  };

  registerCoreConnectionRuntimeHandlers({
    runtimeConfigApplier: applier,
    config,
    rcon: rcon,
    getSaveService: () => options.saveService,
    getLogWatcher: () => options.logWatcher,
  });

  return { applier, config, rcon };
}

describe('core connection runtime handlers', () => {
  it('applies RCON credentials as a single combined reconnect snapshot', async () => {
    const reconnectCalls: unknown[] = [];
    const { applier, config } = registerWithFakes({
      rcon: {
        reconnect: async (options) => {
          reconnectCalls.push(options);
          assert.equal(config.rconHost, 'old-rcon.example.test', 'config mutates only after reconnect success');
        },
        disconnect() {},
      },
    });

    const result = await applier.applyConnectionReconnectBatch([
      { envKey: 'RCON_HOST', cfgKey: 'rconHost', value: 'new-rcon.example.test' },
      { envKey: 'RCON_PORT', cfgKey: 'rconPort', value: 14542 },
      { envKey: 'RCON_PASSWORD', cfgKey: 'rconPassword', value: 'new-rcon-secret' },
    ]);

    assert.deepEqual(result, { applied: ['RCON_HOST', 'RCON_PORT', 'RCON_PASSWORD'], errors: [] });
    assert.deepEqual(reconnectCalls, [{ host: 'new-rcon.example.test', port: 14542, password: 'new-rcon-secret' }]);
    assert.equal(config.rconHost, 'new-rcon.example.test');
    assert.equal(config.rconPort, 14542);
    assert.equal(config.rconPassword, 'new-rcon-secret');
  });

  it('leaves runtime RCON config unchanged when reconnect fails', async () => {
    const { applier, config } = registerWithFakes({
      rcon: {
        reconnect: async () => {
          throw new Error('rcon refused');
        },
        disconnect() {},
      },
    });

    const result = await applier.applyConnectionReconnectBatch([
      { envKey: 'RCON_HOST', cfgKey: 'rconHost', value: 'bad-rcon.example.test' },
      { envKey: 'RCON_PASSWORD', cfgKey: 'rconPassword', value: 'bad-rcon-secret' },
    ]);

    assert.deepEqual(result.errors, [
      { key: 'RCON_HOST', message: 'rcon refused' },
      { key: 'RCON_PASSWORD', message: 'rcon refused' },
    ]);
    assert.equal(config.rconHost, 'old-rcon.example.test');
    assert.equal(config.rconPassword, 'old-rcon-secret');
  });

  it('updates SFTP runtime config, SaveService fields, and LogWatcher log source', async () => {
    const saveCalls: unknown[] = [];
    const logCalls: unknown[] = [];
    const { applier, config } = registerWithFakes({
      saveService: {
        reconfigure(options) {
          saveCalls.push(options);
        },
      },
      logWatcher: {
        async reconfigureSftpLogSource(options) {
          logCalls.push(options);
        },
      },
    });

    const result = await applier.applyConnectionReconnectBatch([
      { envKey: 'SFTP_HOST', cfgKey: 'sftpHost', value: 'new-sftp.example.test' },
      { envKey: 'SFTP_PORT', cfgKey: 'sftpPort', value: 2222 },
      { envKey: 'SFTP_USER', cfgKey: 'sftpUser', value: 'new-user' },
      { envKey: 'SFTP_PASSWORD', cfgKey: 'sftpPassword', value: 'new-secret' },
      { envKey: 'SFTP_LOG_PATH', cfgKey: 'sftpLogPath', value: '/new/HMZLog.log' },
      { envKey: 'SFTP_CONNECT_LOG_PATH', cfgKey: 'sftpConnectLogPath', value: '/new/PlayerConnectedLog.txt' },
      {
        envKey: 'SFTP_SAVE_PATH',
        cfgKey: 'sftpSavePath',
        value: '/new/SaveList/Default/Save_DedicatedSaveMP.sav',
      },
      { envKey: 'SFTP_ID_MAP_PATH', cfgKey: 'sftpIdMapPath', value: '/new/PlayerIDMapped.txt' },
    ]);

    assert.deepEqual(result.errors, []);
    assert.equal(config.sftpHost, 'new-sftp.example.test');
    assert.equal(config.sftpPort, 2222);
    assert.equal(config.sftpUser, 'new-user');
    assert.equal(config.sftpPassword, 'new-secret');
    assert.deepEqual(logCalls, [{ sftpLogPath: '/new/HMZLog.log', sftpConnectLogPath: '/new/PlayerConnectedLog.txt' }]);
    assert.deepEqual(saveCalls, [
      {
        sftpConfig: { host: 'new-sftp.example.test', port: 2222, username: 'new-user', password: 'new-secret' },
        savePath: '/new/SaveList/Default/Save_DedicatedSaveMP.sav',
        clanSavePath: '/new/Save_ClanData.sav',
        agentIdMapPath: '/new/PlayerIDMapped.txt',
      },
    ]);
  });

  it('normalizes relative SFTP paths with SFTP_BASE_PATH for the runtime snapshot', async () => {
    const saveCalls: unknown[] = [];
    const logCalls: unknown[] = [];
    const { applier, config } = registerWithFakes({
      config: makeConfig({
        sftpLogPath: 'logs/HMZLog.log',
        sftpConnectLogPath: 'logs/PlayerConnectedLog.txt',
        sftpIdMapPath: 'PlayerIDMapped.txt',
        sftpSavePath: 'Saved/SaveGames/SaveList/Default/Save_DedicatedSaveMP.sav',
        sftpSettingsPath: 'GameServerSettings.ini',
      }),
      saveService: { reconfigure: (options) => saveCalls.push(options) },
      logWatcher: { reconfigureSftpLogSource: async (options) => void logCalls.push(options) },
    });

    const result = await applier.applyConnectionReconnectBatch([
      { envKey: 'SFTP_BASE_PATH', cfgKey: 'sftpBasePath', value: '/HumanitZServer' },
      { envKey: 'SFTP_SAVE_PATH', cfgKey: 'sftpSavePath', value: 'Saved/SaveGames/SaveList/Default/save.sav' },
    ]);

    assert.deepEqual(result.errors, []);
    assert.equal(config.sftpLogPath, '/HumanitZServer/logs/HMZLog.log');
    assert.equal(config.sftpConnectLogPath, '/HumanitZServer/logs/PlayerConnectedLog.txt');
    assert.equal(config.sftpIdMapPath, '/HumanitZServer/PlayerIDMapped.txt');
    assert.equal(config.sftpSavePath, '/HumanitZServer/Saved/SaveGames/SaveList/Default/save.sav');
    assert.equal(config.sftpSettingsPath, '/HumanitZServer/GameServerSettings.ini');
    assert.deepEqual(logCalls, [
      {
        sftpLogPath: '/HumanitZServer/logs/HMZLog.log',
        sftpConnectLogPath: '/HumanitZServer/logs/PlayerConnectedLog.txt',
      },
    ]);
    assert.equal(
      (saveCalls[0] as { savePath: string }).savePath,
      '/HumanitZServer/Saved/SaveGames/SaveList/Default/save.sav',
    );
  });

  it('rejects SFTP save paths that cannot derive a clan save path before mutating runtime state', async () => {
    const saveCalls: unknown[] = [];
    const logCalls: unknown[] = [];
    const { applier, config } = registerWithFakes({
      saveService: { reconfigure: (options) => saveCalls.push(options) },
      logWatcher: { reconfigureSftpLogSource: async (options) => void logCalls.push(options) },
    });

    const result = await applier.applyConnectionReconnectBatch([
      { envKey: 'SFTP_SAVE_PATH', cfgKey: 'sftpSavePath', value: '/new/NotARecognizedSavePath.sav' },
    ]);

    assert.deepEqual(result.applied, []);
    assert.deepEqual(result.errors, [
      { key: 'SFTP_SAVE_PATH', message: 'Cannot derive clan save path from SFTP_SAVE_PATH' },
    ]);
    assert.equal(config.sftpSavePath, '/old/SaveList/Default/Save_DedicatedSaveMP.sav');
    assert.deepEqual(saveCalls, []);
    assert.deepEqual(logCalls, []);
  });

  it('rejects unreadable SFTP private key paths without leaking the raw path in the error', async () => {
    const missingPath = path.join(os.tmpdir(), `missing-humanitz-key-${Date.now()}`);
    const { applier, config } = registerWithFakes();

    const result = await applier.applyConnectionReconnectBatch([
      { envKey: 'SFTP_PRIVATE_KEY_PATH', cfgKey: 'sftpPrivateKeyPath', value: missingPath },
    ]);

    assert.deepEqual(result.applied, []);
    assert.equal(result.errors.length, 1);
    const error = result.errors[0];
    assert.ok(error);
    assert.equal(error.key, 'SFTP_PRIVATE_KEY_PATH');
    assert.equal(error.message, 'SFTP private key path is not readable');
    assert.equal(error.message.includes(missingPath), false);
    assert.equal(config.sftpPrivateKeyPath, '');
  });

  it('rolls back SFTP config when LogWatcher source reconfigure fails', async () => {
    const saveCalls: unknown[] = [];
    const { applier, config } = registerWithFakes({
      saveService: { reconfigure: (options) => saveCalls.push(options) },
      logWatcher: {
        async reconfigureSftpLogSource() {
          throw new Error('log source refused');
        },
      },
    });

    const result = await applier.applyConnectionReconnectBatch([
      { envKey: 'SFTP_LOG_PATH', cfgKey: 'sftpLogPath', value: '/bad/HMZLog.log' },
      { envKey: 'SFTP_CONNECT_LOG_PATH', cfgKey: 'sftpConnectLogPath', value: '/bad/PlayerConnectedLog.txt' },
    ]);

    assert.deepEqual(result.applied, []);
    assert.deepEqual(result.errors, [
      { key: 'SFTP_LOG_PATH', message: 'log source refused' },
      { key: 'SFTP_CONNECT_LOG_PATH', message: 'log source refused' },
    ]);
    assert.equal(config.sftpLogPath, '/old/HMZLog.log');
    assert.equal(config.sftpConnectLogPath, '/old/PlayerConnectedLog.txt');
    assert.deepEqual(saveCalls, []);
  });

  it('rolls back LogWatcher source when SaveService reconfigure fails after log source apply', async () => {
    const logCalls: unknown[] = [];
    const { applier, config } = registerWithFakes({
      saveService: {
        reconfigure() {
          throw new Error('save source refused');
        },
      },
      logWatcher: {
        async reconfigureSftpLogSource(options) {
          logCalls.push(options);
        },
      },
    });

    const result = await applier.applyConnectionReconnectBatch([
      { envKey: 'SFTP_LOG_PATH', cfgKey: 'sftpLogPath', value: '/new/HMZLog.log' },
      { envKey: 'SFTP_CONNECT_LOG_PATH', cfgKey: 'sftpConnectLogPath', value: '/new/PlayerConnectedLog.txt' },
    ]);

    assert.deepEqual(result.applied, []);
    assert.deepEqual(result.errors, [
      { key: 'SFTP_LOG_PATH', message: 'save source refused' },
      { key: 'SFTP_CONNECT_LOG_PATH', message: 'save source refused' },
    ]);
    assert.equal(config.sftpLogPath, '/old/HMZLog.log');
    assert.equal(config.sftpConnectLogPath, '/old/PlayerConnectedLog.txt');
    assert.deepEqual(logCalls, [
      { sftpLogPath: '/new/HMZLog.log', sftpConnectLogPath: '/new/PlayerConnectedLog.txt' },
      { sftpLogPath: '/old/HMZLog.log', sftpConnectLogPath: '/old/PlayerConnectedLog.txt' },
    ]);
  });

  it('does not claim PR8-owned connection keys as applied by PR7 handlers', async () => {
    const { applier } = registerWithFakes();

    const result = await applier.applyConnectionReconnectBatch([
      { envKey: 'AGENT_MODE', cfgKey: 'agentMode', value: 'agent' },
      { envKey: 'HZMOD_SOCKET_PATH', cfgKey: 'hzmodSocketPath', value: '/tmp/hz.sock' },
      { envKey: 'PUBLIC_HOST', cfgKey: 'publicHost', value: 'example.test' },
    ]);

    assert.deepEqual(result, { applied: [], errors: [] });
  });

  it('accepts readable private key paths and passes key material to SaveService config', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'humanitz-key-'));
    const keyPath = path.join(dir, 'id_rsa');
    fs.writeFileSync(keyPath, 'fake-private-key');
    const saveCalls: unknown[] = [];
    const { applier, config } = registerWithFakes({
      saveService: { reconfigure: (options) => saveCalls.push(options) },
    });

    const result = await applier.applyConnectionReconnectBatch([
      { envKey: 'SFTP_PRIVATE_KEY_PATH', cfgKey: 'sftpPrivateKeyPath', value: keyPath },
      { envKey: 'SFTP_PASSWORD', cfgKey: 'sftpPassword', value: 'passphrase' },
    ]);

    assert.deepEqual(result.errors, []);
    assert.equal(config.sftpPrivateKeyPath, keyPath);
    assert.deepEqual((saveCalls[0] as { sftpConfig: { privateKey: Buffer; passphrase: string } }).sftpConfig, {
      host: 'old-sftp.example.test',
      port: 2022,
      username: 'old-user',
      privateKey: Buffer.from('fake-private-key'),
      passphrase: 'passphrase',
    });
  });
});

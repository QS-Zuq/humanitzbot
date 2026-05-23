import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import LogWatcher from '../src/modules/log-watcher.js';

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    sftpHost: 'sftp.example.test',
    sftpPort: 2022,
    sftpUser: 'user',
    sftpPassword: 'pass',
    sftpLogPath: '/old/HMZLog.log',
    sftpConnectLogPath: '/old/PlayerConnectedLog.txt',
    logPollInterval: 30_000,
    logChannelId: '',
    adminChannelId: '',
    useActivityThreads: false,
    sftpConnectConfig: () => ({ host: 'sftp.example.test', port: 2022, username: 'user', password: 'pass' }),
    ...overrides,
  };
}

function makeWatcher(config = makeConfig()) {
  return new LogWatcher({ channels: { fetch: async () => null } } as any, {
    config: config as any,
    label: 'LOG WATCHER TEST',
  });
}

describe('LogWatcher SFTP log-source runtime reconfigure', () => {
  it('updates inactive path config without opening SFTP', async () => {
    const config = makeConfig();
    const watcher = makeWatcher(config);
    let initCalls = 0;
    (watcher as any)._initSize = async () => {
      initCalls += 1;
    };

    await watcher.reconfigureSftpLogSource({
      sftpLogPath: '/new/HMZLog.log',
      sftpConnectLogPath: '/new/PlayerConnectedLog.txt',
    });

    assert.equal(initCalls, 0);
    assert.equal(config.sftpLogPath, '/new/HMZLog.log');
    assert.equal(config.sftpConnectLogPath, '/new/PlayerConnectedLog.txt');
  });

  it('resets active log-source state before reinitializing', async () => {
    const config = makeConfig();
    const watcher = makeWatcher(config);
    Object.assign(watcher as any, {
      interval: {},
      lastSize: 123,
      partialLine: 'partial',
      initialised: true,
      _connectLastSize: 456,
      _connectPartialLine: 'connect-partial',
      _connectInitialised: true,
      _useRotatedLogs: true,
      _hmzLogFile: '/old/rotated.log',
      _connectLogFile: '/old/connect.log',
    });

    let initCalls = 0;
    (watcher as any)._initSize = async () => {
      initCalls += 1;
      assert.equal((watcher as any).lastSize, 0);
      assert.equal((watcher as any).partialLine, '');
      assert.equal((watcher as any).initialised, false);
      assert.equal((watcher as any)._connectLastSize, 0);
      assert.equal((watcher as any)._connectPartialLine, '');
      assert.equal((watcher as any)._connectInitialised, false);
      assert.equal((watcher as any)._useRotatedLogs, false);
      assert.equal((watcher as any)._hmzLogFile, null);
      assert.equal((watcher as any)._connectLogFile, null);
      assert.equal((watcher as any)._ignoreSavedOffsetsOnce, true);
      (watcher as any).lastSize = 999;
      (watcher as any).initialised = true;
    };

    await watcher.reconfigureSftpLogSource({
      sftpLogPath: '/new/HMZLog.log',
      sftpConnectLogPath: '/new/PlayerConnectedLog.txt',
    });

    assert.equal(initCalls, 1);
    assert.equal(config.sftpLogPath, '/new/HMZLog.log');
    assert.equal(config.sftpConnectLogPath, '/new/PlayerConnectedLog.txt');
    assert.equal((watcher as any)._ignoreSavedOffsetsOnce, false);
    assert.equal((watcher as any).lastSize, 999);
  });

  it('rolls back active path config and state when reinitialization fails', async () => {
    const config = makeConfig();
    const watcher = makeWatcher(config);
    Object.assign(watcher as any, {
      interval: {},
      lastSize: 123,
      partialLine: 'partial',
      initialised: true,
      _connectLastSize: 456,
      _connectPartialLine: 'connect-partial',
      _connectInitialised: true,
      _useRotatedLogs: true,
      _hmzLogFile: '/old/rotated.log',
      _connectLogFile: '/old/connect.log',
    });
    (watcher as any)._initSize = async () => {
      throw new Error('sftp unavailable');
    };

    await assert.rejects(
      watcher.reconfigureSftpLogSource({
        sftpLogPath: '/new/HMZLog.log',
        sftpConnectLogPath: '/new/PlayerConnectedLog.txt',
      }),
      /sftp unavailable/,
    );

    assert.equal(config.sftpLogPath, '/old/HMZLog.log');
    assert.equal(config.sftpConnectLogPath, '/old/PlayerConnectedLog.txt');
    assert.equal((watcher as any).lastSize, 123);
    assert.equal((watcher as any).partialLine, 'partial');
    assert.equal((watcher as any).initialised, true);
    assert.equal((watcher as any)._connectLastSize, 456);
    assert.equal((watcher as any)._connectPartialLine, 'connect-partial');
    assert.equal((watcher as any)._connectInitialised, true);
    assert.equal((watcher as any)._useRotatedLogs, true);
    assert.equal((watcher as any)._hmzLogFile, '/old/rotated.log');
    assert.equal((watcher as any)._connectLogFile, '/old/connect.log');
  });
});

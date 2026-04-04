import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import _database from '../src/db/database.js';
const HumanitZDB = _database as any;

import _config_repository from '../src/db/config-repository.js';
const ConfigRepository = _config_repository as any;

import * as _multi_server from '../src/server/multi-server.js';
const { createServerConfig, _extractSaveName, SAVE_FILE_PATTERN } = _multi_server as any;

function makeServerDef(overrides: Record<string, any> = {}) {
  return {
    id: 'srv_test1',
    name: 'Test Server 1',
    enabled: true,
    rcon: { host: '10.0.0.1', port: 14541, password: 'test-rcon-not-real' },
    sftp: { host: '10.0.0.1', port: 22, user: 'game', password: 'test-pw-not-real' },
    paths: { logPath: '/home/game/HMZLog.log', savePath: '/home/game/Save_DedicatedSaveMP.sav' },
    channels: { serverStatus: '111', chat: '222' },
    ...overrides,
  };
}

function createTestManager(repo: any) {
  const instances = new Map<string, any>();

  return {
    _configRepo: repo,
    _instances: instances,

    _loadServerDefs() {
      if (this._configRepo) {
        try {
          const all = this._configRepo.loadAll();
          const defs: any[] = [];
          for (const [scope, { data }] of all) {
            if (scope.startsWith('server:') && scope !== 'server:primary' && data) {
              if (!data.id) data.id = scope.slice(7);
              defs.push(data);
            }
          }
          if (defs.length > 0) return defs;
        } catch (err: any) {
          console.error('[MULTI] Failed to load servers from DB:', err.message);
        }
      }
      return [];
    },

    _persistServer(id: string, serverDef: any) {
      if (this._configRepo) {
        this._configRepo.set('server:' + id, serverDef);
      }
    },

    _removeServerDef(id: string) {
      if (this._configRepo) {
        this._configRepo.delete('server:' + id);
      }
    },

    getAllServers() {
      return this._loadServerDefs();
    },

    getStatuses() {
      const servers = this._loadServerDefs();
      return servers.map((s: any) => {
        const instance = this._instances.get(s.id);
        return {
          ...s,
          running: instance?.running || false,
          modules: instance ? Object.keys(instance._modules) : [],
        };
      });
    },

    async addServer(serverDef: any) {
      if (!serverDef.id) serverDef.id = `srv_${Date.now().toString(36)}`;
      serverDef.enabled = serverDef.enabled !== false;
      this._persistServer(serverDef.id, serverDef);
      return serverDef;
    },

    async updateServer(id: string, updates: any) {
      const servers = this._loadServerDefs();
      const existing = servers.find((s: any) => s.id === id);
      if (!existing) throw new Error(`Server "${id}" not found`);

      if (updates.name !== undefined) existing.name = updates.name;
      if (updates.enabled !== undefined) existing.enabled = updates.enabled;
      if (updates.gamePort !== undefined) existing.gamePort = updates.gamePort;
      if (updates.rcon) existing.rcon = { ...existing.rcon, ...updates.rcon };
      if (updates.sftp) existing.sftp = { ...existing.sftp, ...updates.sftp };
      if (updates.paths !== undefined) {
        existing.paths = Object.keys(updates.paths).length > 0 ? { ...existing.paths, ...updates.paths } : {};
      }
      if (updates.channels) existing.channels = { ...existing.channels, ...updates.channels };

      this._persistServer(id, existing);
      return existing;
    },

    async removeServer(id: string) {
      const instance = this._instances.get(id);
      if (instance) {
        instance.running = false;
        this._instances.delete(id);
      }
      this._removeServerDef(id);
      return true;
    },

    async startServer(id: string) {
      const servers = this._loadServerDefs();
      const serverDef = servers.find((s: any) => s.id === id);
      if (!serverDef) throw new Error(`Server "${id}" not found`);
      this._instances.set(id, { running: true, _modules: {}, name: serverDef.name, id });
    },

    async stopServer(id: string) {
      const instance = this._instances.get(id);
      if (!instance) throw new Error(`Server "${id}" not running`);
      instance.running = false;
    },

    getInstance(id: string) {
      return this._instances.get(id);
    },
  };
}

describe('MultiServerManager', () => {
  let db: any;
  let repo: any;
  let manager: ReturnType<typeof createTestManager>;

  beforeEach(() => {
    db = new HumanitZDB({ memory: true, label: 'MultiServerTest' });
    db.init();
    repo = new ConfigRepository(db);
    manager = createTestManager(repo);
  });

  afterEach(() => {
    db.close();
  });

  describe('Constructor & Initialization', () => {
    it('creates manager with configRepo', () => {
      assert.ok(manager._configRepo);
      assert.ok(manager._instances instanceof Map);
      assert.equal(manager._instances.size, 0);
    });

    it('handles null configRepo gracefully', () => {
      const noRepoManager = createTestManager(null);
      noRepoManager._configRepo = null;
      const defs = noRepoManager._loadServerDefs();
      assert.ok(Array.isArray(defs));
    });
  });

  describe('_loadServerDefs()', () => {
    it('returns empty array when no server scopes in DB', () => {
      const defs = manager._loadServerDefs();
      assert.deepStrictEqual(defs, []);
    });

    it('returns server defs from configRepo', () => {
      repo.set('server:srv_001', { id: 'srv_001', name: 'Alpha', rcon: { host: '1.2.3.4' } });
      repo.set('server:srv_002', { id: 'srv_002', name: 'Bravo', rcon: { host: '5.6.7.8' } });

      const defs = manager._loadServerDefs();
      assert.equal(defs.length, 2);
      assert.ok(defs.some((d: any) => d.name === 'Alpha'));
      assert.ok(defs.some((d: any) => d.name === 'Bravo'));
    });

    it('excludes server:primary from results', () => {
      repo.set('server:primary', { rconHost: '127.0.0.1' });
      repo.set('server:srv_001', { id: 'srv_001', name: 'Extra' });

      const defs = manager._loadServerDefs();
      assert.equal(defs.length, 1);
      assert.equal(defs[0].name, 'Extra');
    });

    it('excludes non-server scopes from results', () => {
      repo.set('app', { global: true });
      repo.set('server:srv_001', { id: 'srv_001', name: 'Only' });

      const defs = manager._loadServerDefs();
      assert.equal(defs.length, 1);
      assert.equal(defs[0].name, 'Only');
    });

    it('assigns ID from scope when data has no id field', () => {
      repo.set('server:srv_auto', { name: 'AutoID' });

      const defs = manager._loadServerDefs();
      assert.equal(defs.length, 1);
      assert.equal(defs[0].id, 'srv_auto');
    });
  });

  describe('getAllServers()', () => {
    it('returns all server definitions from DB', () => {
      repo.set('server:srv_001', makeServerDef({ id: 'srv_001', name: 'Server A' }));
      repo.set('server:srv_002', makeServerDef({ id: 'srv_002', name: 'Server B' }));

      const all = manager.getAllServers();
      assert.equal(all.length, 2);
    });

    it('returns empty array for fresh install', () => {
      const all = manager.getAllServers();
      assert.deepStrictEqual(all, []);
    });
  });

  describe('getStatuses()', () => {
    it('returns status for all servers', () => {
      repo.set('server:srv_001', makeServerDef({ id: 'srv_001', name: 'A' }));
      repo.set('server:srv_002', makeServerDef({ id: 'srv_002', name: 'B' }));

      const statuses = manager.getStatuses();
      assert.equal(statuses.length, 2);
      assert.ok(statuses.every((s: any) => 'running' in s));
      assert.ok(statuses.every((s: any) => 'modules' in s));
    });

    it('shows running=false for servers without instances', () => {
      repo.set('server:srv_001', makeServerDef({ id: 'srv_001' }));

      const statuses = manager.getStatuses();
      assert.equal(statuses[0].running, false);
      assert.deepStrictEqual(statuses[0].modules, []);
    });

    it('includes running state from active instances', async () => {
      repo.set('server:srv_001', makeServerDef({ id: 'srv_001' }));
      await manager.startServer('srv_001');

      const statuses = manager.getStatuses();
      assert.equal(statuses[0].running, true);
    });
  });

  describe('addServer()', () => {
    it('creates server with valid serverDef', async () => {
      const def = makeServerDef();
      const result = await manager.addServer(def);

      assert.equal(result.id, 'srv_test1');
      assert.equal(result.name, 'Test Server 1');
      assert.equal(result.enabled, true);
    });

    it('stores in configRepo with correct scope format', async () => {
      const def = makeServerDef({ id: 'srv_abc' });
      await manager.addServer(def);

      const stored = repo.get('server:srv_abc');
      assert.ok(stored);
      assert.equal(stored.name, 'Test Server 1');
      assert.equal(stored.rcon.host, '10.0.0.1');
    });

    it('assigns auto-generated ID when none provided', async () => {
      const def = makeServerDef();
      delete (def as any).id;

      const result = await manager.addServer(def);
      assert.ok(result.id);
      assert.ok(result.id.startsWith('srv_'));
    });

    it('sets enabled=true by default', async () => {
      const def = makeServerDef();
      delete (def as any).enabled;

      const result = await manager.addServer(def);
      assert.equal(result.enabled, true);
    });

    it('respects enabled=false', async () => {
      const def = makeServerDef({ enabled: false });
      const result = await manager.addServer(def);
      assert.equal(result.enabled, false);
    });

    it('persists all fields including paths and channels', async () => {
      const def = makeServerDef({
        id: 'srv_full',
        paths: { logPath: '/log', savePath: '/save' },
        channels: { serverStatus: '111', chat: '222' },
      });
      await manager.addServer(def);

      const stored = repo.get('server:srv_full');
      assert.equal(stored.paths.logPath, '/log');
      assert.equal(stored.channels.chat, '222');
    });
  });

  describe('updateServer()', () => {
    it('updates existing server name', async () => {
      await manager.addServer(makeServerDef({ id: 'srv_u1' }));
      const updated = await manager.updateServer('srv_u1', { name: 'Renamed' });
      assert.equal(updated.name, 'Renamed');
    });

    it('merges RCON updates (partial update)', async () => {
      await manager.addServer(makeServerDef({ id: 'srv_u2' }));
      const updated = await manager.updateServer('srv_u2', { rcon: { port: 25575 } });

      assert.equal(updated.rcon.port, 25575);
      assert.equal(updated.rcon.host, '10.0.0.1');
      assert.equal(updated.rcon.password, 'test-rcon-not-real');
    });

    it('merges SFTP updates (partial update)', async () => {
      await manager.addServer(makeServerDef({ id: 'srv_u3' }));
      const updated = await manager.updateServer('srv_u3', { sftp: { password: 'test-new-pw-not-real' } });

      assert.equal(updated.sftp.password, 'test-new-pw-not-real');
      assert.equal(updated.sftp.host, '10.0.0.1');
    });

    it('updates enabled flag', async () => {
      await manager.addServer(makeServerDef({ id: 'srv_u4' }));
      const updated = await manager.updateServer('srv_u4', { enabled: false });
      assert.equal(updated.enabled, false);
    });

    it('clears paths when empty object is passed', async () => {
      await manager.addServer(makeServerDef({ id: 'srv_u5' }));
      const updated = await manager.updateServer('srv_u5', { paths: {} });
      assert.deepStrictEqual(updated.paths, {});
    });

    it('merges path updates (partial)', async () => {
      await manager.addServer(makeServerDef({ id: 'srv_u6' }));
      const updated = await manager.updateServer('srv_u6', { paths: { savePath: '/new/save.sav' } });
      assert.equal(updated.paths.savePath, '/new/save.sav');
      assert.equal(updated.paths.logPath, '/home/game/HMZLog.log');
    });

    it('rejects non-existent server ID', async () => {
      await assert.rejects(() => manager.updateServer('srv_ghost', { name: 'Nope' }), {
        message: 'Server "srv_ghost" not found',
      });
    });

    it('persists updates to configRepo', async () => {
      await manager.addServer(makeServerDef({ id: 'srv_u7' }));
      await manager.updateServer('srv_u7', { name: 'Persisted', gamePort: 7777 });

      const stored = repo.get('server:srv_u7');
      assert.equal(stored.name, 'Persisted');
      assert.equal(stored.gamePort, 7777);
    });

    it('updates channels via merge', async () => {
      await manager.addServer(makeServerDef({ id: 'srv_u8' }));
      const updated = await manager.updateServer('srv_u8', { channels: { log: '999' } });

      assert.equal(updated.channels.log, '999');
      assert.equal(updated.channels.serverStatus, '111');
      assert.equal(updated.channels.chat, '222');
    });
  });

  describe('removeServer()', () => {
    it('removes server definition from DB', async () => {
      await manager.addServer(makeServerDef({ id: 'srv_r1' }));
      assert.ok(repo.get('server:srv_r1'));

      await manager.removeServer('srv_r1');
      assert.equal(repo.get('server:srv_r1'), null);
    });

    it('returns true on successful removal', async () => {
      await manager.addServer(makeServerDef({ id: 'srv_r2' }));
      const result = await manager.removeServer('srv_r2');
      assert.equal(result, true);
    });

    it('removes instance from _instances map', async () => {
      await manager.addServer(makeServerDef({ id: 'srv_r3' }));
      await manager.startServer('srv_r3');
      assert.ok(manager.getInstance('srv_r3'));

      await manager.removeServer('srv_r3');
      assert.equal(manager.getInstance('srv_r3'), undefined);
    });

    it('handles removal of non-running server gracefully', async () => {
      await manager.addServer(makeServerDef({ id: 'srv_r4' }));
      const result = await manager.removeServer('srv_r4');
      assert.equal(result, true);
      assert.equal(repo.get('server:srv_r4'), null);
    });
  });

  describe('startServer() / stopServer()', () => {
    it('starts a stopped server', async () => {
      await manager.addServer(makeServerDef({ id: 'srv_s1' }));
      await manager.startServer('srv_s1');

      const instance = manager.getInstance('srv_s1');
      assert.ok(instance);
      assert.equal(instance.running, true);
    });

    it('stops a running server', async () => {
      await manager.addServer(makeServerDef({ id: 'srv_s2' }));
      await manager.startServer('srv_s2');
      await manager.stopServer('srv_s2');

      const instance = manager.getInstance('srv_s2');
      assert.equal(instance.running, false);
    });

    it('startServer rejects missing serverDef', async () => {
      await assert.rejects(() => manager.startServer('srv_nonexistent'), {
        message: 'Server "srv_nonexistent" not found',
      });
    });

    it('stopServer rejects non-running server', async () => {
      await assert.rejects(() => manager.stopServer('srv_nonexistent'), {
        message: 'Server "srv_nonexistent" not running',
      });
    });

    it('getInstance returns undefined for unknown ID', () => {
      assert.equal(manager.getInstance('srv_unknown'), undefined);
    });
  });
});

describe('createServerConfig()', () => {
  it('creates config with RCON overrides', () => {
    const cfg = createServerConfig({
      rcon: { host: '192.168.1.100', port: 25575, password: 'test-pw-not-real' },
    });
    assert.equal(cfg.rconHost, '192.168.1.100');
    assert.equal(cfg.rconPort, 25575);
    assert.equal(cfg.rconPassword, 'test-pw-not-real');
  });

  it('creates config with SFTP overrides', () => {
    const cfg = createServerConfig({
      sftp: { host: '10.0.0.5', port: 2222, user: 'admin', password: 'test-sftp-not-real' },
    });
    assert.equal(cfg.sftpHost, '10.0.0.5');
    assert.equal(cfg.sftpPort, 2222);
    assert.equal(cfg.sftpUser, 'admin');
    assert.equal(cfg.sftpPassword, 'test-sftp-not-real');
  });

  it('creates config with path overrides', () => {
    const cfg = createServerConfig({
      paths: { logPath: '/custom/log.txt', savePath: '/custom/save.sav' },
    });
    assert.equal(cfg.sftpLogPath, '/custom/log.txt');
    assert.equal(cfg.sftpSavePath, '/custom/save.sav');
  });

  it('creates config with channel overrides', () => {
    const cfg = createServerConfig({
      channels: { serverStatus: 'ch1', chat: 'ch2', log: 'ch3', admin: 'ch4', playerStats: 'ch5' },
    });
    assert.equal(cfg.serverStatusChannelId, 'ch1');
    assert.equal(cfg.chatChannelId, 'ch2');
    assert.equal(cfg.logChannelId, 'ch3');
    assert.equal(cfg.adminChannelId, 'ch4');
    assert.equal(cfg.playerStatsChannelId, 'ch5');
  });

  it('sets publicHost from serverDef or RCON host', () => {
    const cfg1 = createServerConfig({ publicHost: 'public.example.com' });
    assert.equal(cfg1.publicHost, 'public.example.com');

    const cfg2 = createServerConfig({ rcon: { host: 'rcon.example.com' } });
    assert.equal(cfg2.publicHost, 'rcon.example.com');
  });

  it('sets serverName from name or id', () => {
    const cfg1 = createServerConfig({ name: 'My Server', id: 'srv_1' });
    assert.equal(cfg1.serverName, 'My Server');

    const cfg2 = createServerConfig({ id: 'srv_2' });
    assert.equal(cfg2.serverName, 'srv_2');
  });

  it('explicitly breaks prototype chain for panel credentials', () => {
    const cfg = createServerConfig({});
    assert.equal(cfg.panelServerUrl, '');
    assert.equal(cfg.panelApiKey, '');
  });

  it('sets panel credentials when provided', () => {
    const cfg = createServerConfig({
      panel: { serverUrl: 'https://panel.example.com/api', apiKey: 'test-api-key-not-real' },
    });
    assert.equal(cfg.panelServerUrl, 'https://panel.example.com/api');
    assert.equal(cfg.panelApiKey, 'test-api-key-not-real');
  });

  it('defaults agentMode to direct when not specified', () => {
    const cfg = createServerConfig({});
    assert.equal(cfg.agentMode, 'direct');
  });

  it('breaks prototype chain for restart settings', () => {
    const cfg = createServerConfig({});
    assert.equal(cfg.restartTimes, null);
    assert.equal(cfg.restartProfiles, null);
    assert.equal(cfg.enableServerScheduler, false);
  });

  it('applies timezone and locale overrides', () => {
    const cfg = createServerConfig({
      botTimezone: 'Asia/Taipei',
      logTimezone: 'US/Eastern',
      locale: 'zh-TW',
    });
    assert.equal(cfg.botTimezone, 'Asia/Taipei');
    assert.equal(cfg.logTimezone, 'US/Eastern');
    assert.equal(cfg.locale, 'zh-TW');
    assert.equal(cfg.botLocale, 'zh-TW');
  });

  it('applies auto-message overrides', () => {
    const cfg = createServerConfig({
      autoMessages: {
        enableWelcomeMsg: false,
        linkText: 'Join us!',
        discordLink: 'https://discord.gg/test',
      },
    });
    assert.equal(cfg.enableWelcomeMsg, false);
    assert.equal(cfg.autoMsgLinkText, 'Join us!');
    assert.equal(cfg.discordInviteLink, 'https://discord.gg/test');
  });

  it('applies PvP overrides and breaks prototype chain', () => {
    const cfg = createServerConfig({
      pvpStartMinutes: 360,
      pvpEndMinutes: 1080,
    });
    assert.equal(cfg.pvpStartMinutes, 360);
    assert.equal(cfg.pvpEndMinutes, 1080);
    assert.equal(cfg.pvpSettingsOverrides, null);
  });
});

describe('_extractSaveName()', () => {
  it('extracts SaveName from ini text', () => {
    const ini = '[GameServerSettings]\nSaveName=MySave\nOtherKey=Value';
    assert.equal(_extractSaveName(ini), 'MySave');
  });

  it('extracts SaveName with quotes', () => {
    const ini = 'SaveName="CustomSave"';
    assert.equal(_extractSaveName(ini), 'CustomSave');
  });

  it('handles leading/trailing whitespace', () => {
    const ini = '  SaveName =  DedicatedSaveMP  ';
    assert.equal(_extractSaveName(ini), 'DedicatedSaveMP');
  });

  it('returns null when SaveName not found', () => {
    const ini = '[Settings]\nOtherKey=Value\n';
    assert.equal(_extractSaveName(ini), null);
  });

  it('returns null for empty string', () => {
    assert.equal(_extractSaveName(''), null);
  });
});

describe('SAVE_FILE_PATTERN', () => {
  it('matches standard save file', () => {
    assert.ok(SAVE_FILE_PATTERN.test('Save_DedicatedSaveMP.sav'));
  });

  it('matches custom save file names', () => {
    assert.ok(SAVE_FILE_PATTERN.test('Save_MyServer.sav'));
    assert.ok(SAVE_FILE_PATTERN.test('Save_TestWorld123.sav'));
  });

  it('does NOT match Save_ClanData.sav', () => {
    assert.ok(!SAVE_FILE_PATTERN.test('Save_ClanData.sav'));
  });

  it('does NOT match non-save files', () => {
    assert.ok(!SAVE_FILE_PATTERN.test('config.ini'));
    assert.ok(!SAVE_FILE_PATTERN.test('HMZLog.log'));
  });
});

/**
 * Tests for panel-api.js — Pterodactyl Panel API client.
 * Uses createPanelApi() factory to avoid singleton side effects.
 * Run: node --test test/panel-api.test.js
 */

// ── Env vars must be set BEFORE any require ─────────────────
process.env.DISCORD_TOKEN = 'test';
process.env.DISCORD_CLIENT_ID = '123';
process.env.DISCORD_GUILD_ID = '456';
process.env.PANEL_SERVER_URL = 'https://panel.test.com/server/abc123';
process.env.PANEL_API_KEY = 'test-api-key';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createPanelApi } = require('../src/server/panel-api');
const panelApi = require('../src/server/panel-api');

const SERVER_URL = 'https://panel.test.com/server/abc123';
const API_KEY = 'test-api-key';

// ── Helpers ─────────────────────────────────────────────────

/** Create a fresh PanelApi instance for testing. */
function makeApi() {
  return createPanelApi({ serverUrl: SERVER_URL, apiKey: API_KEY });
}

/** Build a mock Response object. */
function mockResponse(body, { status = 200, statusText = 'OK', headers = {} } = {}) {
  const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    headers: { get: (k) => headers[k] || null },
    text: async () => bodyStr,
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
    arrayBuffer: async () => new Uint8Array(Buffer.from(bodyStr)).buffer,
  };
}

// ══════════════════════════════════════════════════════════════
// createPanelApi factory
// ══════════════════════════════════════════════════════════════

describe('createPanelApi', () => {
  it('returns null when serverUrl is missing', () => {
    assert.equal(createPanelApi({ serverUrl: '', apiKey: 'key' }), null);
  });

  it('returns null when apiKey is missing', () => {
    assert.equal(createPanelApi({ serverUrl: SERVER_URL, apiKey: '' }), null);
  });

  it('returns null for malformed URL without slashes', () => {
    assert.equal(createPanelApi({ serverUrl: 'noslash', apiKey: 'key' }), null);
  });

  it('returns a PanelApi instance with available=true', () => {
    const api = makeApi();
    assert.notEqual(api, null);
    assert.equal(api.available, true);
    assert.equal(api.backend, 'pterodactyl');
  });
});

// ══════════════════════════════════════════════════════════════
// getResources
// ══════════════════════════════════════════════════════════════

describe('getResources', () => {
  let originalFetch;
  beforeEach(() => {
    originalFetch = global.fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('constructs the correct URL with /resources endpoint', async () => {
    let capturedUrl;
    global.fetch = async (url, _opts) => {
      capturedUrl = url;
      return mockResponse({
        attributes: {
          current_state: 'running',
          resources: {
            cpu_absolute: 45.123,
            memory_bytes: 1073741824,
            memory_limit_bytes: 2147483648,
            disk_bytes: 5368709120,
            disk_limit_bytes: 10737418240,
            uptime: 3600000,
          },
        },
      });
    };

    const api = makeApi();
    await api.getResources();
    assert.equal(capturedUrl, 'https://panel.test.com/api/client/servers/abc123/resources');
  });

  it('sends API key in Authorization header', async () => {
    let capturedHeaders;
    global.fetch = async (url, opts) => {
      capturedHeaders = opts.headers;
      return mockResponse({
        attributes: { current_state: 'offline', resources: {} },
      });
    };

    const api = makeApi();
    await api.getResources();
    assert.equal(capturedHeaders.Authorization, 'Bearer test-api-key');
    assert.equal(capturedHeaders.Accept, 'application/json');
  });

  it('parses resource data correctly (CPU rounding, mem/disk percent, uptime ms→s)', async () => {
    global.fetch = async () =>
      mockResponse({
        attributes: {
          current_state: 'running',
          resources: {
            cpu_absolute: 45.678,
            memory_bytes: 1073741824,
            memory_limit_bytes: 4294967296,
            disk_bytes: 2147483648,
            disk_limit_bytes: 10737418240,
            uptime: 7200000,
          },
        },
      });

    const api = makeApi();
    const res = await api.getResources();
    assert.equal(res.cpu, 45.7); // rounded to 1 decimal
    assert.equal(res.memUsed, 1073741824);
    assert.equal(res.memTotal, 4294967296);
    assert.equal(res.memPercent, 25); // 1GB / 4GB = 25%
    assert.equal(res.diskUsed, 2147483648);
    assert.equal(res.diskTotal, 10737418240);
    assert.equal(res.diskPercent, 20); // 2GB / 10GB = 20%
    assert.equal(res.uptime, 7200); // 7200000ms → 7200s
    assert.equal(res.state, 'running');
  });

  it('returns nulls for missing resource fields', async () => {
    global.fetch = async () => mockResponse({ attributes: { resources: {} } });

    const api = makeApi();
    const res = await api.getResources();
    assert.equal(res.cpu, null);
    assert.equal(res.memUsed, null);
    assert.equal(res.memPercent, null);
    assert.equal(res.uptime, null);
    assert.equal(res.state, null);
  });
});

// ══════════════════════════════════════════════════════════════
// sendPowerAction
// ══════════════════════════════════════════════════════════════

describe('sendPowerAction', () => {
  let originalFetch;
  beforeEach(() => {
    originalFetch = global.fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  for (const signal of ['start', 'stop', 'restart', 'kill']) {
    it(`sends correct signal for '${signal}'`, async () => {
      let capturedBody;
      global.fetch = async (url, opts) => {
        capturedBody = JSON.parse(opts.body);
        return mockResponse(null, { status: 204 });
      };

      const api = makeApi();
      await api.sendPowerAction(signal);
      assert.deepEqual(capturedBody, { signal });
    });
  }

  it('uses POST method for power actions', async () => {
    let capturedMethod;
    global.fetch = async (url, opts) => {
      capturedMethod = opts.method;
      return mockResponse(null, { status: 204 });
    };

    const api = makeApi();
    await api.sendPowerAction('start');
    assert.equal(capturedMethod, 'POST');
  });

  it('throws on invalid signal', async () => {
    const api = makeApi();
    await assert.rejects(() => api.sendPowerAction('invalid'), /Invalid power signal/);
  });
});

// ══════════════════════════════════════════════════════════════
// sendCommand
// ══════════════════════════════════════════════════════════════

describe('sendCommand', () => {
  let originalFetch;
  beforeEach(() => {
    originalFetch = global.fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('sends correct request body with command field', async () => {
    let capturedBody, capturedUrl;
    global.fetch = async (url, opts) => {
      capturedUrl = url;
      capturedBody = JSON.parse(opts.body);
      return mockResponse(null, { status: 204 });
    };

    const api = makeApi();
    await api.sendCommand('say Hello World');
    assert.deepEqual(capturedBody, { command: 'say Hello World' });
    assert.ok(capturedUrl.endsWith('/command'));
  });
});

// ══════════════════════════════════════════════════════════════
// readFile / writeFile — URL encoding
// ══════════════════════════════════════════════════════════════

describe('readFile', () => {
  let originalFetch;
  beforeEach(() => {
    originalFetch = global.fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('URL-encodes the file path in the query parameter', async () => {
    let capturedUrl;
    global.fetch = async (url) => {
      capturedUrl = url;
      return mockResponse('file content', { status: 200 });
    };

    const api = makeApi();
    await api.readFile('/HumanitZ Server/Settings.ini');
    assert.ok(capturedUrl.includes(encodeURIComponent('/HumanitZ Server/Settings.ini')));
  });

  it('returns file contents as text on success', async () => {
    global.fetch = async () => mockResponse('server-name=TestServer', { status: 200 });

    const api = makeApi();
    const content = await api.readFile('/config.ini');
    assert.equal(content, 'server-name=TestServer');
  });

  it('falls back to downloadFile on 405 response', async () => {
    let callCount = 0;
    global.fetch = async (_url) => {
      callCount++;
      // First call: files/contents → 405
      if (callCount === 1) {
        return mockResponse('', { status: 405, statusText: 'Method Not Allowed' });
      }
      // Second call: files/download → signed URL
      if (callCount === 2) {
        return mockResponse({ attributes: { url: 'https://cdn.test.com/download/abc' } });
      }
      // Third call: fetch the signed URL → file content
      return mockResponse('fallback content', { status: 200 });
    };

    const api = makeApi();
    const content = await api.readFile('/test.txt');
    assert.equal(content, 'fallback content');
    assert.equal(callCount, 3);
  });

  it('throws on non-ok response that is not 405/403', async () => {
    global.fetch = async () => mockResponse('', { status: 500, statusText: 'Internal Server Error' });

    const api = makeApi();
    await assert.rejects(() => api.readFile('/test.txt'), /Panel file read 500/);
  });
});

describe('writeFile', () => {
  let originalFetch;
  beforeEach(() => {
    originalFetch = global.fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('URL-encodes the file path and sends content as body', async () => {
    let capturedUrl, capturedBody, capturedHeaders;
    global.fetch = async (url, opts) => {
      capturedUrl = url;
      capturedBody = opts.body;
      capturedHeaders = opts.headers;
      return mockResponse('', { status: 204 });
    };

    const api = makeApi();
    await api.writeFile('/path/to file.txt', 'new content');
    assert.ok(capturedUrl.includes(encodeURIComponent('/path/to file.txt')));
    assert.equal(capturedBody, 'new content');
    assert.equal(capturedHeaders['Content-Type'], 'text/plain');
  });

  it('throws on non-ok response', async () => {
    global.fetch = async () => mockResponse('', { status: 500, statusText: 'Internal Server Error' });

    const api = makeApi();
    await assert.rejects(() => api.writeFile('/test.txt', 'data'), /Panel file write 500/);
  });
});

// ══════════════════════════════════════════════════════════════
// getWebsocketAuth
// ══════════════════════════════════════════════════════════════

describe('getWebsocketAuth', () => {
  let originalFetch;
  beforeEach(() => {
    originalFetch = global.fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('returns socket URL and token from response data', async () => {
    global.fetch = async () =>
      mockResponse({
        data: {
          token: 'ws-token-abc',
          socket: 'wss://panel.test.com/api/servers/abc123/ws',
        },
      });

    const api = makeApi();
    const auth = await api.getWebsocketAuth();
    assert.equal(auth.token, 'ws-token-abc');
    assert.equal(auth.socket, 'wss://panel.test.com/api/servers/abc123/ws');
  });
});

// ══════════════════════════════════════════════════════════════
// Error handling
// ══════════════════════════════════════════════════════════════

describe('error handling', () => {
  let originalFetch;
  beforeEach(() => {
    originalFetch = global.fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('throws with status code for non-ok responses', async () => {
    global.fetch = async () => mockResponse('Bad Request', { status: 400, statusText: 'Bad Request' });

    const api = makeApi();
    await assert.rejects(
      () => api.getResources(),
      (err) => {
        assert.ok(err.message.includes('400'));
        assert.ok(err.message.includes('Bad Request'));
        return true;
      },
    );
  });

  it('includes response body snippet in error message', async () => {
    global.fetch = async () => mockResponse('{"error":"Invalid token"}', { status: 401, statusText: 'Unauthorized' });

    const api = makeApi();
    await assert.rejects(
      () => api.sendCommand('test'),
      (err) => {
        assert.ok(err.message.includes('Invalid token'));
        return true;
      },
    );
  });

  it('handles network errors with meaningful message', async () => {
    global.fetch = async () => {
      throw new Error('fetch failed: ECONNREFUSED');
    };

    const api = makeApi();
    await assert.rejects(() => api.getResources(), /ECONNREFUSED/);
  });

  it('throws on 403 Forbidden (API key error)', async () => {
    global.fetch = async () => mockResponse('Forbidden', { status: 403, statusText: 'Forbidden' });

    const api = makeApi();
    await assert.rejects(
      () => api.getResources(),
      (err) => {
        assert.ok(err.message.includes('403'));
        assert.ok(err.message.includes('Forbidden'));
        return true;
      },
    );
  });

  it('throws on 429 Too Many Requests (rate limit)', async () => {
    global.fetch = async () => mockResponse('Rate limited', { status: 429, statusText: 'Too Many Requests' });

    const api = makeApi();
    await assert.rejects(
      () => api.listBackups(),
      (err) => {
        assert.ok(err.message.includes('429'));
        return true;
      },
    );
  });

  it('truncates long error bodies to 200 chars', async () => {
    const longBody = 'x'.repeat(500);
    global.fetch = async () => mockResponse(longBody, { status: 500, statusText: 'Internal Server Error' });

    const api = makeApi();
    await assert.rejects(
      () => api.getResources(),
      (err) => {
        // The error message should contain at most 200 chars of body
        const bodyPart = err.message.split(': ').slice(1).join(': ');
        assert.ok(bodyPart.length <= 200);
        return true;
      },
    );
  });
});

// ══════════════════════════════════════════════════════════════
// Headers
// ══════════════════════════════════════════════════════════════

describe('request headers', () => {
  let originalFetch;
  beforeEach(() => {
    originalFetch = global.fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('includes Authorization, Accept, and Content-Type in requests', async () => {
    let capturedHeaders;
    global.fetch = async (url, opts) => {
      capturedHeaders = opts.headers;
      return mockResponse({ data: [] });
    };

    const api = makeApi();
    await api.listBackups();
    assert.equal(capturedHeaders.Authorization, 'Bearer test-api-key');
    assert.equal(capturedHeaders.Accept, 'application/json');
    assert.equal(capturedHeaders['Content-Type'], 'application/json');
  });

  it('readFile uses Accept: text/plain instead of application/json', async () => {
    let capturedHeaders;
    global.fetch = async (url, opts) => {
      capturedHeaders = opts.headers;
      return mockResponse('file data');
    };

    const api = makeApi();
    await api.readFile('/test.txt');
    assert.equal(capturedHeaders.Accept, 'text/plain');
  });
});

// ══════════════════════════════════════════════════════════════
// Backup methods
// ══════════════════════════════════════════════════════════════

describe('backup methods', () => {
  let originalFetch;
  beforeEach(() => {
    originalFetch = global.fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('listBackups parses backup array', async () => {
    global.fetch = async () =>
      mockResponse({
        data: [
          {
            attributes: {
              uuid: 'backup-uuid-1',
              name: 'Daily Backup',
              bytes: 1048576,
              created_at: '2026-01-01T00:00:00Z',
              completed_at: '2026-01-01T00:05:00Z',
              is_successful: true,
              is_locked: false,
            },
          },
        ],
      });

    const api = makeApi();
    const backups = await api.listBackups();
    assert.equal(backups.length, 1);
    assert.equal(backups[0].uuid, 'backup-uuid-1');
    assert.equal(backups[0].name, 'Daily Backup');
    assert.equal(backups[0].bytes, 1048576);
    assert.equal(backups[0].is_successful, true);
  });

  it('createBackup sends POST with name', async () => {
    let capturedMethod, capturedBody;
    global.fetch = async (url, opts) => {
      capturedMethod = opts.method;
      capturedBody = JSON.parse(opts.body);
      return mockResponse({ attributes: { uuid: 'new-uuid', name: 'My Backup' } });
    };

    const api = makeApi();
    const result = await api.createBackup('My Backup');
    assert.equal(capturedMethod, 'POST');
    assert.deepEqual(capturedBody, { name: 'My Backup' });
    assert.equal(result.uuid, 'new-uuid');
  });

  it('deleteBackup sends DELETE to correct UUID endpoint', async () => {
    let capturedUrl, capturedMethod;
    global.fetch = async (url, opts) => {
      capturedUrl = url;
      capturedMethod = opts.method;
      return mockResponse(null, { status: 204 });
    };

    const api = makeApi();
    await api.deleteBackup('uuid-to-delete');
    assert.ok(capturedUrl.includes('backups/uuid-to-delete'));
    assert.equal(capturedMethod, 'DELETE');
  });

  it('getBackupDownloadUrl returns signed URL', async () => {
    global.fetch = async () =>
      mockResponse({
        attributes: { url: 'https://cdn.test.com/backups/download?token=abc' },
      });

    const api = makeApi();
    const url = await api.getBackupDownloadUrl('uuid-123');
    assert.equal(url, 'https://cdn.test.com/backups/download?token=abc');
  });
});

// ══════════════════════════════════════════════════════════════
// Other methods
// ══════════════════════════════════════════════════════════════

describe('other API methods', () => {
  let originalFetch;
  beforeEach(() => {
    originalFetch = global.fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('getServerDetails fetches server info', async () => {
    global.fetch = async () =>
      mockResponse({
        attributes: { name: 'HumanitZ Server', description: 'Test', limits: { memory: 4096 } },
      });

    const api = makeApi();
    const details = await api.getServerDetails();
    assert.equal(details.name, 'HumanitZ Server');
    assert.equal(details.limits.memory, 4096);
  });

  it('listFiles URL-encodes directory path', async () => {
    let capturedUrl;
    global.fetch = async (url) => {
      capturedUrl = url;
      return mockResponse({
        data: [
          { attributes: { name: 'test.ini', mode: '0644', size: 1024, is_file: true, modified_at: '2026-01-01' } },
        ],
      });
    };

    const api = makeApi();
    const files = await api.listFiles('/Game Server/config');
    assert.ok(capturedUrl.includes(encodeURIComponent('/Game Server/config')));
    assert.equal(files.length, 1);
    assert.equal(files[0].name, 'test.ini');
  });

  it('downloadFile fetches via signed URL', async () => {
    let callCount = 0;
    global.fetch = async (_url) => {
      callCount++;
      if (callCount === 1) {
        // files/download → signed URL
        return mockResponse({ attributes: { url: 'https://cdn.test.com/file' } });
      }
      // Actual download
      return mockResponse('binary-data');
    };

    const api = makeApi();
    const buf = await api.downloadFile('/save.sav');
    assert.ok(Buffer.isBuffer(buf));
    assert.equal(callCount, 2);
  });

  it('downloadFile throws when no URL is returned', async () => {
    global.fetch = async () => mockResponse({ attributes: {} });

    const api = makeApi();
    await assert.rejects(() => api.downloadFile('/missing.sav'), /No download URL/);
  });

  it('listSchedules returns schedule list', async () => {
    global.fetch = async () =>
      mockResponse({
        data: [{ attributes: { id: 1, name: 'Daily Restart', is_active: true } }],
      });

    const api = makeApi();
    const schedules = await api.listSchedules();
    assert.equal(schedules.length, 1);
    assert.equal(schedules[0].name, 'Daily Restart');
  });

  it('updateStartupVariable sends PUT with key/value', async () => {
    let capturedMethod, capturedBody;
    global.fetch = async (url, opts) => {
      capturedMethod = opts.method;
      capturedBody = JSON.parse(opts.body);
      return mockResponse({ attributes: { env_variable: 'MAX_PLAYERS', server_value: '20' } });
    };

    const api = makeApi();
    const result = await api.updateStartupVariable('MAX_PLAYERS', '20');
    assert.equal(capturedMethod, 'PUT');
    assert.deepEqual(capturedBody, { key: 'MAX_PLAYERS', value: '20' });
    assert.equal(result.env_variable, 'MAX_PLAYERS');
  });
});

// ══════════════════════════════════════════════════════════════
// Singleton export
// ══════════════════════════════════════════════════════════════

describe('singleton export', () => {
  let originalFetch;
  beforeEach(() => {
    originalFetch = global.fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('has available=true when panel env vars are set', () => {
    assert.equal(panelApi.available, true);
  });

  it('has backend=pterodactyl when configured', () => {
    assert.equal(panelApi.backend, 'pterodactyl');
  });

  it('can call getResources on singleton', async () => {
    global.fetch = async () =>
      mockResponse({
        attributes: {
          current_state: 'running',
          resources: {
            cpu_absolute: 10.5,
            memory_bytes: 1024,
            memory_limit_bytes: 2048,
            disk_bytes: 512,
            disk_limit_bytes: 1024,
            uptime: 60000,
          },
        },
      });
    const res = await panelApi.getResources();
    assert.equal(res.cpu, 10.5);
    assert.equal(res.state, 'running');
  });
});

// ══════════════════════════════════════════════════════════════
// Module export shape
// ══════════════════════════════════════════════════════════════

describe('module export shape', () => {
  it('exports all 21 methods + PanelApi + createPanelApi as own properties', () => {
    const expectedFunctions = [
      'getResources',
      'sendPowerAction',
      'sendCommand',
      'getServerDetails',
      'listBackups',
      'createBackup',
      'deleteBackup',
      'getBackupDownloadUrl',
      'getFileDownloadUrl',
      'downloadFile',
      'listFiles',
      'readFile',
      'writeFile',
      'getWebsocketAuth',
      'listSchedules',
      'createSchedule',
      'deleteSchedule',
      'getStartupVariables',
      'updateStartupVariable',
      'listAllocations',
      'listServers',
      'PanelApi',
      'createPanelApi',
    ];
    for (const name of expectedFunctions) {
      assert.ok(Object.prototype.hasOwnProperty.call(panelApi, name), `missing own property: ${name}`);
      assert.equal(typeof panelApi[name], 'function', `${name} should be a function`);
    }
  });

  it('exposes available and backend as prototype getters', () => {
    assert.ok('available' in panelApi, 'available not accessible');
    assert.equal(
      Object.prototype.hasOwnProperty.call(panelApi, 'available'),
      false,
      'available should NOT be own property',
    );
    assert.equal(typeof panelApi.available, 'boolean');
    assert.ok('backend' in panelApi, 'backend not accessible');
    assert.equal(
      Object.prototype.hasOwnProperty.call(panelApi, 'backend'),
      false,
      'backend should NOT be own property',
    );
    assert.equal(typeof panelApi.backend, 'string');
  });
});

// ══════════════════════════════════════════════════════════════
// Individual function exports
// ══════════════════════════════════════════════════════════════

describe('individual function exports', () => {
  let originalFetch;
  beforeEach(() => {
    originalFetch = global.fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('getResources works when destructured (no this context)', async () => {
    const { getResources } = require('../src/server/panel-api');
    global.fetch = async () =>
      mockResponse({
        attributes: {
          current_state: 'running',
          resources: {
            cpu_absolute: 22.3,
            memory_bytes: 1024,
            memory_limit_bytes: 2048,
            disk_bytes: 0,
            disk_limit_bytes: 0,
            uptime: 1000,
          },
        },
      });
    const res = await getResources();
    assert.equal(res.cpu, 22.3);
    assert.equal(res.state, 'running');
  });

  it('sendPowerAction works when destructured', async () => {
    const { sendPowerAction } = require('../src/server/panel-api');
    let capturedUrl, capturedBody;
    global.fetch = async (url, opts) => {
      capturedUrl = url;
      capturedBody = JSON.parse(opts.body);
      return mockResponse(null, { status: 204 });
    };
    await sendPowerAction('restart');
    assert.ok(capturedUrl.endsWith('/power'));
    assert.deepEqual(capturedBody, { signal: 'restart' });
  });
});

// ══════════════════════════════════════════════════════════════
// listServers
// ══════════════════════════════════════════════════════════════

describe('listServers', () => {
  let originalFetch;
  beforeEach(() => {
    originalFetch = global.fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('uses /api/client URL (not server-scoped)', async () => {
    let capturedUrl;
    global.fetch = async (url) => {
      capturedUrl = url;
      return mockResponse({ data: [], meta: { pagination: { total_pages: 1 } } });
    };
    const api = makeApi();
    await api.listServers();
    assert.ok(capturedUrl.includes('/api/client?page=1'));
    assert.ok(!capturedUrl.includes('/servers/abc123/'));
  });

  it('paginates when total_pages > 1', async () => {
    let callCount = 0;
    global.fetch = async () => {
      callCount++;
      if (callCount === 1) {
        return mockResponse({
          data: [
            {
              attributes: {
                identifier: 's1',
                uuid: 'u1',
                name: 'Server 1',
                description: '',
                node: '',
                sftp_details: {},
                egg: 0,
                docker_image: '',
                limits: {},
              },
            },
          ],
          meta: { pagination: { total_pages: 2 } },
        });
      }
      return mockResponse({
        data: [
          {
            attributes: {
              identifier: 's2',
              uuid: 'u2',
              name: 'Server 2',
              description: '',
              node: '',
              sftp_details: {},
              egg: 0,
              docker_image: '',
              limits: {},
            },
          },
        ],
        meta: { pagination: { total_pages: 2 } },
      });
    };
    const api = makeApi();
    const servers = await api.listServers();
    assert.equal(servers.length, 2);
    assert.equal(callCount, 2);
    assert.equal(servers[0].identifier, 's1');
    assert.equal(servers[1].identifier, 's2');
  });

  it('maps server attributes correctly', async () => {
    global.fetch = async () =>
      mockResponse({
        data: [
          {
            attributes: {
              identifier: 'abc',
              uuid: 'uuid-123',
              name: 'Test Server',
              description: 'desc',
              node: 'node1',
              sftp_details: { ip: '10.0.0.1', port: 2022 },
              relationships: {
                allocations: {
                  data: [{ attributes: { id: 1, ip: '10.0.0.1', ip_alias: null, port: 25565, is_default: true } }],
                },
              },
              egg: 5,
              docker_image: 'img',
              limits: { memory: 4096 },
            },
          },
        ],
        meta: { pagination: { total_pages: 1 } },
      });
    const api = makeApi();
    const servers = await api.listServers();
    assert.equal(servers[0].identifier, 'abc');
    assert.equal(servers[0].uuid, 'uuid-123');
    assert.equal(servers[0].allocations.length, 1);
    assert.equal(servers[0].allocations[0].port, 25565);
    assert.equal(servers[0].allocations[0].is_default, true);
  });
});

// ══════════════════════════════════════════════════════════════
// readFile 403 fallback
// ══════════════════════════════════════════════════════════════

describe('readFile 403 fallback', () => {
  let originalFetch;
  beforeEach(() => {
    originalFetch = global.fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('falls back to downloadFile on 403 response', async () => {
    let callCount = 0;
    global.fetch = async () => {
      callCount++;
      if (callCount === 1) return mockResponse('', { status: 403, statusText: 'Forbidden' });
      if (callCount === 2) return mockResponse({ attributes: { url: 'https://cdn.test.com/download/abc' } });
      return mockResponse('fallback content', { status: 200 });
    };
    const api = makeApi();
    const content = await api.readFile('/test.txt');
    assert.equal(content, 'fallback content');
    assert.equal(callCount, 3);
  });
});

// ══════════════════════════════════════════════════════════════
// listAllocations
// ══════════════════════════════════════════════════════════════

describe('listAllocations', () => {
  let originalFetch;
  beforeEach(() => {
    originalFetch = global.fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('maps allocation attributes correctly', async () => {
    global.fetch = async () =>
      mockResponse({
        data: [{ attributes: { id: 1, ip: '10.0.0.1', ip_alias: null, port: 25565, is_default: true } }],
      });
    const api = makeApi();
    const allocs = await api.listAllocations();
    assert.equal(allocs.length, 1);
    assert.equal(allocs[0].id, 1);
    assert.equal(allocs[0].ip, '10.0.0.1');
    assert.equal(allocs[0].ip_alias, null);
    assert.equal(allocs[0].port, 25565);
    assert.equal(allocs[0].is_default, true);
  });
});

// ══════════════════════════════════════════════════════════════
// getStartupVariables
// ══════════════════════════════════════════════════════════════

describe('getStartupVariables', () => {
  let originalFetch;
  beforeEach(() => {
    originalFetch = global.fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('maps startup variable attributes correctly', async () => {
    global.fetch = async () =>
      mockResponse({
        data: [
          {
            attributes: {
              env_variable: 'MAX_PLAYERS',
              server_value: '20',
              default_value: '10',
              name: 'Max Players',
              description: 'Max number of players',
            },
          },
        ],
      });
    const api = makeApi();
    const vars = await api.getStartupVariables();
    assert.equal(vars.length, 1);
    assert.equal(vars[0].env_variable, 'MAX_PLAYERS');
    assert.equal(vars[0].server_value, '20');
    assert.equal(vars[0].default_value, '10');
    assert.equal(vars[0].name, 'Max Players');
    assert.equal(vars[0].description, 'Max number of players');
  });
});

// ══════════════════════════════════════════════════════════════
// createSchedule
// ══════════════════════════════════════════════════════════════

describe('createSchedule', () => {
  let originalFetch;
  beforeEach(() => {
    originalFetch = global.fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('sends POST with schedule params', async () => {
    let capturedMethod, capturedBody;
    global.fetch = async (url, opts) => {
      capturedMethod = opts.method;
      capturedBody = JSON.parse(opts.body);
      return mockResponse({ attributes: { id: 1, name: 'Daily Restart', is_active: true } });
    };
    const api = makeApi();
    const result = await api.createSchedule({
      name: 'Daily Restart',
      minute: '0',
      hour: '6',
      day_of_week: '*',
      day_of_month: '*',
      month: '*',
      is_active: true,
    });
    assert.equal(capturedMethod, 'POST');
    assert.equal(capturedBody.name, 'Daily Restart');
    assert.equal(capturedBody.is_active, true);
    assert.equal(result.name, 'Daily Restart');
  });
});

// ══════════════════════════════════════════════════════════════
// deleteSchedule
// ══════════════════════════════════════════════════════════════

describe('deleteSchedule', () => {
  let originalFetch;
  beforeEach(() => {
    originalFetch = global.fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('sends DELETE to correct schedule ID endpoint', async () => {
    let capturedUrl, capturedMethod;
    global.fetch = async (url, opts) => {
      capturedUrl = url;
      capturedMethod = opts.method;
      return mockResponse(null, { status: 204 });
    };
    const api = makeApi();
    await api.deleteSchedule(42);
    assert.ok(capturedUrl.includes('schedules/42'));
    assert.equal(capturedMethod, 'DELETE');
  });
});

// ══════════════════════════════════════════════════════════════
// getFileDownloadUrl
// ══════════════════════════════════════════════════════════════

describe('getFileDownloadUrl', () => {
  let originalFetch;
  beforeEach(() => {
    originalFetch = global.fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('URL-encodes the file path and returns signed URL', async () => {
    let capturedUrl;
    global.fetch = async (url) => {
      capturedUrl = url;
      return mockResponse({ attributes: { url: 'https://cdn.test.com/download/signed' } });
    };
    const api = makeApi();
    const url = await api.getFileDownloadUrl('/path/to save.sav');
    assert.ok(capturedUrl.includes(encodeURIComponent('/path/to save.sav')));
    assert.equal(url, 'https://cdn.test.com/download/signed');
  });

  it('returns null when no url in response attributes', async () => {
    global.fetch = async () => mockResponse({ attributes: {} });
    const api = makeApi();
    const url = await api.getFileDownloadUrl('/test.sav');
    assert.equal(url, null);
  });
});

// ── _parseUrl ────────────────────────────────────────────────
describe('_parseUrl', () => {
  const { _parseUrl } = panelApi._test;

  // Valid URLs
  it('parses standard https panel URL', () => {
    const result = _parseUrl('https://panel.example.com/server/abc123');
    assert.deepStrictEqual(result, { baseUrl: 'https://panel.example.com', serverId: 'abc123' });
  });

  it('parses http panel URL', () => {
    const result = _parseUrl('http://panel.example.com/server/abc123');
    assert.deepStrictEqual(result, { baseUrl: 'http://panel.example.com', serverId: 'abc123' });
  });

  it('strips trailing slashes before parsing', () => {
    const result = _parseUrl('https://panel.example.com/server/abc123///');
    assert.deepStrictEqual(result, { baseUrl: 'https://panel.example.com', serverId: 'abc123' });
  });

  it('parses URL with port', () => {
    const result = _parseUrl('https://panel.example.com:8443/server/abc123');
    assert.deepStrictEqual(result, { baseUrl: 'https://panel.example.com:8443', serverId: 'abc123' });
  });

  it('parses URL with subpath before /server/', () => {
    const result = _parseUrl('https://panel.example.com/pterodactyl/server/abc123');
    assert.deepStrictEqual(result, { baseUrl: 'https://panel.example.com/pterodactyl', serverId: 'abc123' });
  });

  // Invalid URLs — must return null
  it('rejects URL without scheme', () => {
    assert.equal(_parseUrl('panel.example.com/server/abc123'), null);
  });

  it('rejects URL with extra path after serverId', () => {
    assert.equal(_parseUrl('https://panel.example.com/server/abc123/files'), null);
  });

  it('rejects URL ending with /server/ (no id)', () => {
    assert.equal(_parseUrl('https://panel.example.com/server/'), null);
  });

  it('rejects URL without /server/ segment', () => {
    assert.equal(_parseUrl('https://panel.example.com/abc123'), null);
  });

  it('rejects empty string', () => {
    assert.equal(_parseUrl(''), null);
  });

  it('rejects null/undefined', () => {
    assert.equal(_parseUrl(null), null);
    assert.equal(_parseUrl(undefined), null);
  });

  it('rejects ftp:// scheme', () => {
    assert.equal(_parseUrl('ftp://panel.example.com/server/abc123'), null);
  });

  it('rejects serverId with special characters', () => {
    assert.equal(_parseUrl('https://panel.example.com/server/abc-123'), null);
    assert.equal(_parseUrl('https://panel.example.com/server/abc_123'), null);
    assert.equal(_parseUrl('https://panel.example.com/server/abc 123'), null);
  });
});

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-require-imports, @typescript-eslint/no-floating-promises, @typescript-eslint/no-non-null-assertion, @typescript-eslint/require-await */
/**
 * Tests for panel-api.js — Pterodactyl Panel API client.
 * Uses createPanelApi() factory to avoid singleton side effects.
 * Run: node --test test/panel-api.test.js
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const { createPanelApi } = require('../src/server/panel-api');

const SERVER_URL = 'https://panel.test.com/server/abc123';
const API_KEY = 'test-api-key';

// ── Helpers ─────────────────────────────────────────────────

/** Create a fresh PanelApi instance for testing. */
function makeApi() {
  return createPanelApi({ serverUrl: SERVER_URL, apiKey: API_KEY });
}

/** Build a mock Response object. */
function mockResponse(body: unknown, { status = 200, statusText = 'OK', headers = {} as Record<string, string> } = {}) {
  const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    headers: { get: (k: string) => headers[k] || null },
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
  let originalFetch: typeof global.fetch;
  beforeEach(() => {
    originalFetch = global.fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('constructs the correct URL with /resources endpoint', async () => {
    let capturedUrl: string | undefined;
    (global as unknown as Record<string, unknown>).fetch = async (url: string) => {
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
    let capturedHeaders: Record<string, string> | undefined;
    (global as unknown as Record<string, unknown>).fetch = async (
      _url: string,
      opts: { headers: Record<string, string> },
    ) => {
      capturedHeaders = opts.headers;
      return mockResponse({
        attributes: { current_state: 'offline', resources: {} },
      });
    };

    const api = makeApi();
    await api.getResources();
    assert.equal(capturedHeaders!.Authorization, 'Bearer test-api-key');
    assert.equal(capturedHeaders!.Accept, 'application/json');
  });

  it('parses resource data correctly (CPU rounding, mem/disk percent, uptime ms→s)', async () => {
    (global as unknown as Record<string, unknown>).fetch = async () =>
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
    (global as unknown as Record<string, unknown>).fetch = async () => mockResponse({ attributes: { resources: {} } });

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
  let originalFetch: typeof global.fetch;
  beforeEach(() => {
    originalFetch = global.fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  for (const signal of ['start', 'stop', 'restart', 'kill']) {
    it(`sends correct signal for '${signal}'`, async () => {
      let capturedBody: unknown;
      (global as unknown as Record<string, unknown>).fetch = async (_url: string, opts: { body: string }) => {
        capturedBody = JSON.parse(opts.body);
        return mockResponse(null, { status: 204 });
      };

      const api = makeApi();
      await api.sendPowerAction(signal);
      assert.deepEqual(capturedBody, { signal });
    });
  }

  it('uses POST method for power actions', async () => {
    let capturedMethod: string | undefined;
    (global as unknown as Record<string, unknown>).fetch = async (_url: string, opts: { method: string }) => {
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
  let originalFetch: typeof global.fetch;
  beforeEach(() => {
    originalFetch = global.fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('sends correct request body with command field', async () => {
    let capturedBody: unknown, capturedUrl: string | undefined;
    (global as unknown as Record<string, unknown>).fetch = async (url: string, opts: { body: string }) => {
      capturedUrl = url;
      capturedBody = JSON.parse(opts.body);
      return mockResponse(null, { status: 204 });
    };

    const api = makeApi();
    await api.sendCommand('say Hello World');
    assert.deepEqual(capturedBody, { command: 'say Hello World' });
    assert.ok(capturedUrl!.endsWith('/command'));
  });
});

// ══════════════════════════════════════════════════════════════
// readFile / writeFile — URL encoding
// ══════════════════════════════════════════════════════════════

describe('readFile', () => {
  let originalFetch: typeof global.fetch;
  beforeEach(() => {
    originalFetch = global.fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('URL-encodes the file path in the query parameter', async () => {
    let capturedUrl: string | undefined;
    (global as unknown as Record<string, unknown>).fetch = async (url: string) => {
      capturedUrl = url;
      return mockResponse('file content', { status: 200 });
    };

    const api = makeApi();
    await api.readFile('/HumanitZ Server/Settings.ini');
    assert.ok(capturedUrl!.includes(encodeURIComponent('/HumanitZ Server/Settings.ini')));
  });

  it('returns file contents as text on success', async () => {
    (global as unknown as Record<string, unknown>).fetch = async () =>
      mockResponse('server-name=TestServer', { status: 200 });

    const api = makeApi();
    const content = await api.readFile('/config.ini');
    assert.equal(content, 'server-name=TestServer');
  });

  it('falls back to downloadFile on 405 response', async () => {
    let callCount = 0;
    (global as unknown as Record<string, unknown>).fetch = async () => {
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
    (global as unknown as Record<string, unknown>).fetch = async () =>
      mockResponse('', { status: 500, statusText: 'Internal Server Error' });

    const api = makeApi();
    await assert.rejects(() => api.readFile('/test.txt'), /Panel file read 500/);
  });
});

describe('writeFile', () => {
  let originalFetch: typeof global.fetch;
  beforeEach(() => {
    originalFetch = global.fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('URL-encodes the file path and sends content as body', async () => {
    let capturedUrl: string | undefined, capturedBody: unknown, capturedHeaders: Record<string, string> | undefined;
    (global as unknown as Record<string, unknown>).fetch = async (
      url: string,
      opts: { body: unknown; headers: Record<string, string> },
    ) => {
      capturedUrl = url;
      capturedBody = opts.body;
      capturedHeaders = opts.headers;
      return mockResponse('', { status: 204 });
    };

    const api = makeApi();
    await api.writeFile('/path/to file.txt', 'new content');
    assert.ok(capturedUrl!.includes(encodeURIComponent('/path/to file.txt')));
    assert.equal(capturedBody, 'new content');
    assert.equal(capturedHeaders!['Content-Type'], 'text/plain');
  });

  it('throws on non-ok response', async () => {
    (global as unknown as Record<string, unknown>).fetch = async () =>
      mockResponse('', { status: 500, statusText: 'Internal Server Error' });

    const api = makeApi();
    await assert.rejects(() => api.writeFile('/test.txt', 'data'), /Panel file write 500/);
  });
});

// ══════════════════════════════════════════════════════════════
// getWebsocketAuth
// ══════════════════════════════════════════════════════════════

describe('getWebsocketAuth', () => {
  let originalFetch: typeof global.fetch;
  beforeEach(() => {
    originalFetch = global.fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('returns socket URL and token from response data', async () => {
    (global as unknown as Record<string, unknown>).fetch = async () =>
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
  let originalFetch: typeof global.fetch;
  beforeEach(() => {
    originalFetch = global.fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('throws with status code for non-ok responses', async () => {
    (global as unknown as Record<string, unknown>).fetch = async () =>
      mockResponse('Bad Request', { status: 400, statusText: 'Bad Request' });

    const api = makeApi();
    await assert.rejects(
      () => api.getResources(),
      (err: Error) => {
        assert.ok(err.message.includes('400'));
        assert.ok(err.message.includes('Bad Request'));
        return true;
      },
    );
  });

  it('includes response body snippet in error message', async () => {
    (global as unknown as Record<string, unknown>).fetch = async () =>
      mockResponse('{"error":"Invalid token"}', { status: 401, statusText: 'Unauthorized' });

    const api = makeApi();
    await assert.rejects(
      () => api.sendCommand('test'),
      (err: Error) => {
        assert.ok(err.message.includes('Invalid token'));
        return true;
      },
    );
  });

  it('handles network errors with meaningful message', async () => {
    (global as unknown as Record<string, unknown>).fetch = async () => {
      throw new Error('fetch failed: ECONNREFUSED');
    };

    const api = makeApi();
    await assert.rejects(() => api.getResources(), /ECONNREFUSED/);
  });

  it('throws on 403 Forbidden (API key error)', async () => {
    (global as unknown as Record<string, unknown>).fetch = async () =>
      mockResponse('Forbidden', { status: 403, statusText: 'Forbidden' });

    const api = makeApi();
    await assert.rejects(
      () => api.getResources(),
      (err: Error) => {
        assert.ok(err.message.includes('403'));
        assert.ok(err.message.includes('Forbidden'));
        return true;
      },
    );
  });

  it('throws on 429 Too Many Requests (rate limit)', async () => {
    (global as unknown as Record<string, unknown>).fetch = async () =>
      mockResponse('Rate limited', { status: 429, statusText: 'Too Many Requests' });

    const api = makeApi();
    await assert.rejects(
      () => api.listBackups(),
      (err: Error) => {
        assert.ok(err.message.includes('429'));
        return true;
      },
    );
  });

  it('truncates long error bodies to 200 chars', async () => {
    const longBody = 'x'.repeat(500);
    (global as unknown as Record<string, unknown>).fetch = async () =>
      mockResponse(longBody, { status: 500, statusText: 'Internal Server Error' });

    const api = makeApi();
    await assert.rejects(
      () => api.getResources(),
      (err: Error) => {
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
  let originalFetch: typeof global.fetch;
  beforeEach(() => {
    originalFetch = global.fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('includes Authorization, Accept, and Content-Type in requests', async () => {
    let capturedHeaders: Record<string, string> | undefined;
    (global as unknown as Record<string, unknown>).fetch = async (
      _url: string,
      opts: { headers: Record<string, string> },
    ) => {
      capturedHeaders = opts.headers;
      return mockResponse({ data: [] });
    };

    const api = makeApi();
    await api.listBackups();
    assert.equal(capturedHeaders!.Authorization, 'Bearer test-api-key');
    assert.equal(capturedHeaders!.Accept, 'application/json');
    assert.equal(capturedHeaders!['Content-Type'], 'application/json');
  });

  it('readFile uses Accept: text/plain instead of application/json', async () => {
    let capturedHeaders: Record<string, string> | undefined;
    (global as unknown as Record<string, unknown>).fetch = async (
      _url: string,
      opts: { headers: Record<string, string> },
    ) => {
      capturedHeaders = opts.headers;
      return mockResponse('file data');
    };

    const api = makeApi();
    await api.readFile('/test.txt');
    assert.equal(capturedHeaders!.Accept, 'text/plain');
  });
});

// ══════════════════════════════════════════════════════════════
// Backup methods
// ══════════════════════════════════════════════════════════════

describe('backup methods', () => {
  let originalFetch: typeof global.fetch;
  beforeEach(() => {
    originalFetch = global.fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('listBackups parses backup array', async () => {
    (global as unknown as Record<string, unknown>).fetch = async () =>
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
    let capturedMethod: string | undefined, capturedBody: unknown;
    (global as unknown as Record<string, unknown>).fetch = async (
      _url: string,
      opts: { method: string; body: string },
    ) => {
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
    let capturedUrl: string | undefined, capturedMethod: string | undefined;
    (global as unknown as Record<string, unknown>).fetch = async (url: string, opts: { method: string }) => {
      capturedUrl = url;
      capturedMethod = opts.method;
      return mockResponse(null, { status: 204 });
    };

    const api = makeApi();
    await api.deleteBackup('uuid-to-delete');
    assert.ok(capturedUrl!.includes('backups/uuid-to-delete'));
    assert.equal(capturedMethod, 'DELETE');
  });

  it('getBackupDownloadUrl returns signed URL', async () => {
    (global as unknown as Record<string, unknown>).fetch = async () =>
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
  let originalFetch: typeof global.fetch;
  beforeEach(() => {
    originalFetch = global.fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('getServerDetails fetches server info', async () => {
    (global as unknown as Record<string, unknown>).fetch = async () =>
      mockResponse({
        attributes: { name: 'HumanitZ Server', description: 'Test', limits: { memory: 4096 } },
      });

    const api = makeApi();
    const details = await api.getServerDetails();
    assert.equal(details.name, 'HumanitZ Server');
    assert.equal(details.limits.memory, 4096);
  });

  it('listFiles URL-encodes directory path', async () => {
    let capturedUrl: string | undefined;
    (global as unknown as Record<string, unknown>).fetch = async (url: string) => {
      capturedUrl = url;
      return mockResponse({
        data: [
          { attributes: { name: 'test.ini', mode: '0644', size: 1024, is_file: true, modified_at: '2026-01-01' } },
        ],
      });
    };

    const api = makeApi();
    const files = await api.listFiles('/Game Server/config');
    assert.ok(capturedUrl!.includes(encodeURIComponent('/Game Server/config')));
    assert.equal(files.length, 1);
    assert.equal(files[0].name, 'test.ini');
  });

  it('downloadFile fetches via signed URL', async () => {
    let callCount = 0;
    (global as unknown as Record<string, unknown>).fetch = async () => {
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
    (global as unknown as Record<string, unknown>).fetch = async () => mockResponse({ attributes: {} });

    const api = makeApi();
    await assert.rejects(() => api.downloadFile('/missing.sav'), /No download URL/);
  });

  it('listSchedules returns schedule list', async () => {
    (global as unknown as Record<string, unknown>).fetch = async () =>
      mockResponse({ data: [{ attributes: { id: 1, name: 'Daily', is_active: true } }] });

    const api = makeApi();
    const schedules = await api.listSchedules();
    assert.ok(Array.isArray(schedules));
  });
});

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-require-imports, @typescript-eslint/no-floating-promises, @typescript-eslint/restrict-template-expressions */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { validateField, FIELD_VALIDATORS, ENV_KEY_VALIDATORS } = require('../src/db/config-validation');

// ── Port validator ───────────────────────────────────────────

describe('FIELD_VALIDATORS.port', () => {
  const port = FIELD_VALIDATORS.port;

  it('accepts valid ports (1, 80, 443, 27015, 65535)', () => {
    assert.deepStrictEqual(port('1'), { valid: true, value: 1 });
    assert.deepStrictEqual(port('80'), { valid: true, value: 80 });
    assert.deepStrictEqual(port('443'), { valid: true, value: 443 });
    assert.deepStrictEqual(port('27015'), { valid: true, value: 27015 });
    assert.deepStrictEqual(port('65535'), { valid: true, value: 65535 });
  });

  it('rejects invalid ports (0, 65536, -1, abc, empty)', () => {
    assert.strictEqual(port('0').valid, false);
    assert.strictEqual(port('65536').valid, false);
    assert.strictEqual(port('-1').valid, false);
    assert.strictEqual(port('abc').valid, false);
    assert.strictEqual(port('').valid, false);
    assert.strictEqual(port('3.14').valid, false);
  });
});

// ── Timezone validator ───────────────────────────────────────

describe('FIELD_VALIDATORS.timezone', () => {
  const tz = FIELD_VALIDATORS.timezone;

  it('accepts valid IANA timezones', () => {
    assert.strictEqual(tz('UTC').valid, true);
    assert.strictEqual(tz('America/New_York').valid, true);
    assert.strictEqual(tz('Asia/Taipei').valid, true);
    assert.strictEqual(tz('Europe/London').valid, true);
  });

  it('rejects invalid timezones', () => {
    assert.strictEqual(tz('NotATimezone').valid, false);
    assert.strictEqual(tz('').valid, false);
    assert.strictEqual(tz('UTC+8').valid, false);
    assert.strictEqual(tz('  ').valid, false);
  });
});

// ── Enum validator ───────────────────────────────────────────

describe('FIELD_VALIDATORS.enum', () => {
  const enumV = FIELD_VALIDATORS.enum;
  const options = ['auto', 'agent', 'direct', 'cache'];

  it('accepts valid option', () => {
    assert.deepStrictEqual(enumV('auto', options), { valid: true, value: 'auto' });
    assert.deepStrictEqual(enumV('direct', options), { valid: true, value: 'direct' });
  });

  it('rejects invalid option', () => {
    assert.strictEqual(enumV('invalid', options).valid, false);
    assert.ok(enumV('invalid', options).error.includes('Must be one of'));
  });

  it('is case-sensitive', () => {
    assert.strictEqual(enumV('Auto', options).valid, false);
    assert.strictEqual(enumV('DIRECT', options).valid, false);
  });

  it('trims whitespace', () => {
    assert.deepStrictEqual(enumV(' auto ', options), { valid: true, value: 'auto' });
  });
});

// ── Snowflake validator ──────────────────────────────────────

describe('FIELD_VALIDATORS.snowflake', () => {
  const sf = FIELD_VALIDATORS.snowflake;

  it('accepts valid snowflakes (17-20 digits)', () => {
    assert.strictEqual(sf('12345678901234567').valid, true); // 17 digits
    assert.strictEqual(sf('12345678901234567890').valid, true); // 20 digits
    assert.strictEqual(sf('123456789012345678').valid, true); // 18 digits
  });

  it('accepts comma-separated snowflakes', () => {
    const result = sf('12345678901234567,98765432109876543');
    assert.strictEqual(result.valid, true);
  });

  it('rejects invalid snowflakes', () => {
    assert.strictEqual(sf('abc').valid, false);
    assert.strictEqual(sf('123').valid, false); // too short
    assert.strictEqual(sf('123456789012345678901').valid, false); // 21 digits = too long
    assert.strictEqual(sf('').valid, false);
    assert.strictEqual(sf('   ').valid, false);
  });

  it('rejects if any ID in comma-separated list is invalid', () => {
    assert.strictEqual(sf('12345678901234567,bad').valid, false);
    assert.ok(sf('12345678901234567,bad').error.includes('"bad"'));
  });
});

// ── Time validator ───────────────────────────────────────────

describe('FIELD_VALIDATORS.time', () => {
  const time = FIELD_VALIDATORS.time;

  it('accepts valid HH:MM times', () => {
    assert.strictEqual(time('00:00').valid, true);
    assert.strictEqual(time('23:59').valid, true);
    assert.strictEqual(time('12:30').valid, true);
    assert.strictEqual(time('08:05').valid, true);
  });

  it('rejects invalid times', () => {
    assert.strictEqual(time('25:00').valid, false);
    assert.strictEqual(time('12:60').valid, false);
    assert.strictEqual(time('abc').valid, false);
    assert.strictEqual(time('1:30').valid, false); // missing leading zero
    assert.strictEqual(time('').valid, false);
    assert.strictEqual(time('24:00').valid, false);
  });
});

// ── JSON validator ───────────────────────────────────────────

describe('FIELD_VALIDATORS.json', () => {
  const json = FIELD_VALIDATORS.json;

  it('accepts valid JSON strings', () => {
    assert.strictEqual(json('{}').valid, true);
    assert.strictEqual(json('{"a":1}').valid, true);
    assert.strictEqual(json('[]').valid, true);
    assert.strictEqual(json('"hello"').valid, true);
    assert.strictEqual(json('{"OnDeath":"0","VitalDrain":"1"}').valid, true);
  });

  it('rejects invalid JSON', () => {
    assert.strictEqual(json('not json').valid, false);
    assert.strictEqual(json('{bad}').valid, false);
    assert.strictEqual(json('').valid, false);
    assert.ok(json('{bad}').error.includes('Invalid JSON'));
  });
});

// ── Interval validator ───────────────────────────────────────

describe('FIELD_VALIDATORS.interval', () => {
  const interval = FIELD_VALIDATORS.interval;

  it('accepts value >= min', () => {
    const result = interval('30000', 10000);
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.value, 30000);
    assert.strictEqual(result.warning, undefined);
  });

  it('clamps value < min with warning', () => {
    const result = interval('5000', 10000);
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.value, 10000);
    assert.ok(result.warning.includes('clamped'));
    assert.ok(result.warning.includes('5000'));
  });

  it('accepts value at exact min boundary', () => {
    const result = interval('10000', 10000);
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.value, 10000);
    assert.strictEqual(result.warning, undefined);
  });

  it('rejects non-integer', () => {
    assert.strictEqual(interval('abc', 1000).valid, false);
    assert.strictEqual(interval('', 1000).valid, false);
  });
});

// ── URL validator ────────────────────────────────────────────

describe('FIELD_VALIDATORS.url', () => {
  const url = FIELD_VALIDATORS.url;

  it('accepts valid URLs', () => {
    assert.strictEqual(url('https://example.com').valid, true);
    assert.strictEqual(url('http://localhost:3000').valid, true);
    assert.strictEqual(url('https://games.bisecthosting.com/server/abc123').valid, true);
  });

  it('rejects invalid URLs', () => {
    assert.strictEqual(url('not-a-url').valid, false);
    assert.strictEqual(url('ftp://files.example.com').valid, false);
    assert.strictEqual(url('').valid, false);
    assert.strictEqual(url('example.com').valid, false);
  });
});

// ── Host validator ───────────────────────────────────────────

describe('FIELD_VALIDATORS.host', () => {
  const host = FIELD_VALIDATORS.host;

  it('accepts valid hosts', () => {
    assert.strictEqual(host('1.2.3.4').valid, true);
    assert.strictEqual(host('example.com').valid, true);
    assert.strictEqual(host('localhost').valid, true);
    assert.strictEqual(host('my-server.hosting.com').valid, true);
  });

  it('rejects invalid hosts', () => {
    assert.strictEqual(host('').valid, false);
    assert.strictEqual(host('  ').valid, false);
    assert.strictEqual(host('host name').valid, false); // contains space
  });
});

// ── Path validator ───────────────────────────────────────────

describe('FIELD_VALIDATORS.path', () => {
  const path = FIELD_VALIDATORS.path;

  it('accepts valid paths', () => {
    assert.strictEqual(path('/path/to/file').valid, true);
    assert.strictEqual(path('/HumanitZServer/HMZLog.log').valid, true);
    assert.strictEqual(path('relative/path').valid, true);
  });

  it('rejects invalid paths', () => {
    assert.strictEqual(path('').valid, false);
    assert.strictEqual(path('  ').valid, false);
    assert.strictEqual(path('/path/with\0null').valid, false);
  });
});

// ── validateField integration ────────────────────────────────

describe('validateField', () => {
  it('applies port validator for RCON_PORT', () => {
    const result = validateField('RCON_PORT', '27015');
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.value, 27015);
  });

  it('rejects invalid RCON_PORT', () => {
    const result = validateField('RCON_PORT', '99999');
    assert.strictEqual(result.valid, false);
  });

  it('applies timezone validator for BOT_TIMEZONE', () => {
    assert.strictEqual(validateField('BOT_TIMEZONE', 'Asia/Taipei').valid, true);
    assert.strictEqual(validateField('BOT_TIMEZONE', 'Fake/Zone').valid, false);
  });

  it('applies enum validator for AGENT_MODE', () => {
    assert.strictEqual(validateField('AGENT_MODE', 'auto').valid, true);
    assert.strictEqual(validateField('AGENT_MODE', 'invalid').valid, false);
  });

  it('applies snowflake validator for ADMIN_USER_IDS', () => {
    assert.strictEqual(validateField('ADMIN_USER_IDS', '12345678901234567').valid, true);
    assert.strictEqual(validateField('ADMIN_USER_IDS', 'not-a-snowflake').valid, false);
  });

  it('applies time validator for PVP_START_TIME', () => {
    assert.strictEqual(validateField('PVP_START_TIME', '18:00').valid, true);
    assert.strictEqual(validateField('PVP_START_TIME', '25:00').valid, false);
  });

  it('applies json validator for PVP_SETTINGS_OVERRIDES', () => {
    assert.strictEqual(validateField('PVP_SETTINGS_OVERRIDES', '{"OnDeath":"0"}').valid, true);
    assert.strictEqual(validateField('PVP_SETTINGS_OVERRIDES', '{bad}').valid, false);
  });

  it('applies interval validator with clamping for CHAT_POLL_INTERVAL', () => {
    const result = validateField('CHAT_POLL_INTERVAL', '1000');
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.value, 5000); // clamped to min 5000
    assert.ok(result.warning);
  });

  it('applies url validator for PANEL_SERVER_URL', () => {
    assert.strictEqual(validateField('PANEL_SERVER_URL', 'https://panel.example.com').valid, true);
    assert.strictEqual(validateField('PANEL_SERVER_URL', 'not-a-url').valid, false);
  });

  it('applies host validator for RCON_HOST', () => {
    assert.strictEqual(validateField('RCON_HOST', '192.168.1.1').valid, true);
    assert.strictEqual(validateField('RCON_HOST', 'has space').valid, false);
  });

  it('applies path validator for SFTP_LOG_PATH', () => {
    assert.strictEqual(validateField('SFTP_LOG_PATH', '/HumanitZServer/HMZLog.log').valid, true);
  });

  it('falls back to bool type validation from fieldDef', () => {
    assert.strictEqual(validateField('UNKNOWN_BOOL', 'true', { type: 'bool' }).valid, true);
    assert.strictEqual(validateField('UNKNOWN_BOOL', 'true', { type: 'bool' }).value, true);
    assert.strictEqual(validateField('UNKNOWN_BOOL', 'maybe', { type: 'bool' }).valid, false);
  });

  it('falls back to int type validation from fieldDef', () => {
    assert.strictEqual(validateField('UNKNOWN_INT', '42', { type: 'int' }).valid, true);
    assert.strictEqual(validateField('UNKNOWN_INT', '42', { type: 'int' }).value, 42);
    assert.strictEqual(validateField('UNKNOWN_INT', 'abc', { type: 'int' }).valid, false);
  });

  it('passes generic string validation for unknown keys', () => {
    assert.strictEqual(validateField('UNKNOWN_KEY', 'hello').valid, true);
    assert.strictEqual(validateField('UNKNOWN_KEY', 'hello').value, 'hello');
  });

  it('rejects strings with newlines', () => {
    assert.strictEqual(validateField('SOME_KEY', 'line1\nline2').valid, false);
    assert.ok(validateField('SOME_KEY', 'line1\nline2').error.includes('newline'));
  });

  it('rejects strings exceeding 2000 chars', () => {
    const long = 'x'.repeat(2001);
    assert.strictEqual(validateField('SOME_KEY', long).valid, false);
    assert.ok(validateField('SOME_KEY', long).error.includes('2000'));
  });

  it('allows empty/null/undefined values (optional fields)', () => {
    assert.strictEqual(validateField('RCON_PORT', '').valid, true);
    assert.strictEqual(validateField('RCON_PORT', null).valid, true);
    assert.strictEqual(validateField('RCON_PORT', undefined).valid, true);
  });
});

// ── ENV_KEY_VALIDATORS coverage ──────────────────────────────

describe('ENV_KEY_VALIDATORS', () => {
  it('has validators for all port keys', () => {
    for (const key of ['RCON_PORT', 'SFTP_PORT', 'WEB_MAP_PORT', 'GAME_PORT', 'SSH_PORT']) {
      assert.strictEqual(ENV_KEY_VALIDATORS[key].type, 'port', `${key} should be port`);
    }
  });

  it('has validators for timezone keys', () => {
    assert.strictEqual(ENV_KEY_VALIDATORS.BOT_TIMEZONE.type, 'timezone');
    assert.strictEqual(ENV_KEY_VALIDATORS.LOG_TIMEZONE.type, 'timezone');
  });

  it('has interval validators with min values matching config.js', () => {
    assert.strictEqual(ENV_KEY_VALIDATORS.CHAT_POLL_INTERVAL.min, 5000);
    assert.strictEqual(ENV_KEY_VALIDATORS.SERVER_STATUS_INTERVAL.min, 15000);
    assert.strictEqual(ENV_KEY_VALIDATORS.LOG_POLL_INTERVAL.min, 10000);
    assert.strictEqual(ENV_KEY_VALIDATORS.SAVE_POLL_INTERVAL.min, 60000);
    assert.strictEqual(ENV_KEY_VALIDATORS.STATUS_CHANNEL_INTERVAL.min, 60000);
  });

  it('all validator types reference existing FIELD_VALIDATORS', () => {
    for (const [key, def] of Object.entries(ENV_KEY_VALIDATORS)) {
      assert.ok(FIELD_VALIDATORS[(def as any).type], `${key} references unknown validator type: ${(def as any).type}`);
    }
  });
});

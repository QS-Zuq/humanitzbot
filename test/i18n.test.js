const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const config = require('../src/config');
const {
  t,
  getLocale,
  fmtDate,
  fmtTime,
  fmtNumber,
  getSupportedLocales,
  getLocalizations
} = require('../src/i18n');

describe('i18n module', () => {
  let savedBotLocale;

  beforeEach(() => {
    savedBotLocale = config.botLocale;
    config.botLocale = 'en';
  });

  afterEach(() => {
    config.botLocale = savedBotLocale;
  });

  it('returns translated status for English', () => {
    assert.equal(t('common:status.online', 'en'), 'Online');
  });

  it('returns zh-TW translation when available', () => {
    assert.equal(t('common:status.online', 'zh-TW'), '線上');
  });

  it('prefers explicit locale in context', () => {
    assert.equal(getLocale({ locale: 'zh-TW' }), 'zh-TW');
  });

  it('uses server locale when explicit locale is not provided', () => {
    assert.equal(getLocale({ serverConfig: { locale: 'zh-CN' } }), 'zh-CN');
  });

  it('returns en when no locale context is provided', () => {
    assert.equal(getLocale({}), 'en');
  });

  it('returns en for unsupported explicit locale', () => {
    assert.equal(getLocale({ locale: 'invalid' }), 'en');
  });

  it('formats date in English locale', () => {
    const result = fmtDate(new Date('2026-01-15T00:00:00Z'), 'en');
    assert.match(result, /(Jan|15)/i);
  });

  it('formats date in Traditional Chinese locale', () => {
    const result = fmtDate(new Date('2026-01-15T00:00:00Z'), 'zh-TW');
    assert.match(result, /(1月|15)/);
  });

  it('formats numbers using locale separators', () => {
    const result = fmtNumber(1234567, 'en');
    assert.match(result, /1[,\s]234[,\s]567/);
  });

  it('returns supported locales list', () => {
    assert.deepEqual(getSupportedLocales(), ['en', 'zh-TW', 'zh-CN']);
  });

  it('returns object shape for localizations lookup', () => {
    const result = getLocalizations('some.key');
    assert.equal(typeof result, 'object');
    assert.equal(Array.isArray(result), false);
  });

  it('returns key itself when translation is missing', () => {
    assert.equal(t('missing.key', 'en'), 'missing.key');
  });

  it('formats time string in English locale', () => {
    const result = fmtTime(new Date('2026-01-15T13:45:00Z'), 'en');
    assert.equal(typeof result, 'string');
    assert.ok(result.length > 0);
  });

  // ── Translation completeness tests ──────────────────────────

  it('all zh-TW keys match en keys across all namespaces', () => {
    const path = require('path');
    const fs = require('fs');
    function leaves(o, p = '') {
      return Object.entries(o).flatMap(([k, v]) =>
        typeof v === 'object' && v !== null ? leaves(v, p + k + '.') : [p + k]
      );
    }
    const ns = ['common', 'web', 'discord', 'api', 'commands'];
    const localesDir = path.join(__dirname, '..', 'locales');
    for (const n of ns) {
      const en = leaves(JSON.parse(fs.readFileSync(path.join(localesDir, 'en', n + '.json'), 'utf8')));
      const tw = leaves(JSON.parse(fs.readFileSync(path.join(localesDir, 'zh-TW', n + '.json'), 'utf8')));
      const missing = en.filter(k => !tw.includes(k));
      assert.equal(missing.length, 0, `zh-TW/${n}.json missing keys: ${missing.slice(0, 5).join(', ')}`);
    }
  });

  it('all zh-CN keys match en keys across all namespaces', () => {
    const path = require('path');
    const fs = require('fs');
    function leaves(o, p = '') {
      return Object.entries(o).flatMap(([k, v]) =>
        typeof v === 'object' && v !== null ? leaves(v, p + k + '.') : [p + k]
      );
    }
    const ns = ['common', 'web', 'discord', 'api', 'commands'];
    const localesDir = path.join(__dirname, '..', 'locales');
    for (const n of ns) {
      const en = leaves(JSON.parse(fs.readFileSync(path.join(localesDir, 'en', n + '.json'), 'utf8')));
      const cn = leaves(JSON.parse(fs.readFileSync(path.join(localesDir, 'zh-CN', n + '.json'), 'utf8')));
      const missing = en.filter(k => !cn.includes(k));
      assert.equal(missing.length, 0, `zh-CN/${n}.json missing keys: ${missing.slice(0, 5).join(', ')}`);
    }
  });

  it('no empty string translations in zh-TW', () => {
    const path = require('path');
    const fs = require('fs');
    function checkEmpty(o, p = '') {
      const empties = [];
      for (const [k, v] of Object.entries(o)) {
        if (typeof v === 'object' && v !== null) empties.push(...checkEmpty(v, p + k + '.'));
        else if (v === '') empties.push(p + k);
      }
      return empties;
    }
    const ns = ['common', 'web', 'discord', 'api', 'commands'];
    const localesDir = path.join(__dirname, '..', 'locales');
    for (const n of ns) {
      const data = JSON.parse(fs.readFileSync(path.join(localesDir, 'zh-TW', n + '.json'), 'utf8'));
      const empties = checkEmpty(data);
      assert.equal(empties.length, 0, `zh-TW/${n}.json has empty values: ${empties.slice(0, 5).join(', ')}`);
    }
  });

  it('no empty string translations in zh-CN', () => {
    const path = require('path');
    const fs = require('fs');
    function checkEmpty(o, p = '') {
      const empties = [];
      for (const [k, v] of Object.entries(o)) {
        if (typeof v === 'object' && v !== null) empties.push(...checkEmpty(v, p + k + '.'));
        else if (v === '') empties.push(p + k);
      }
      return empties;
    }
    const ns = ['common', 'web', 'discord', 'api', 'commands'];
    const localesDir = path.join(__dirname, '..', 'locales');
    for (const n of ns) {
      const data = JSON.parse(fs.readFileSync(path.join(localesDir, 'zh-CN', n + '.json'), 'utf8'));
      const empties = checkEmpty(data);
      assert.equal(empties.length, 0, `zh-CN/${n}.json has empty values: ${empties.slice(0, 5).join(', ')}`);
    }
  });

  it('translations do not introduce unknown interpolation variables', () => {
    const path = require('path');
    const fs = require('fs');
    function extractVars(o, p = '') {
      const result = {};
      for (const [k, v] of Object.entries(o)) {
        if (typeof v === 'object' && v !== null) Object.assign(result, extractVars(v, p + k + '.'));
        else {
          const vars = (String(v).match(/\{\{\w+\}\}/g) || []).sort();
          if (vars.length > 0) result[p + k] = vars;
        }
      }
      return result;
    }
    const localesDir = path.join(__dirname, '..', 'locales');
    const ns = ['common', 'web', 'discord', 'api', 'commands'];
    for (const n of ns) {
      const enVars = extractVars(JSON.parse(fs.readFileSync(path.join(localesDir, 'en', n + '.json'), 'utf8')));
      for (const lng of ['zh-TW', 'zh-CN']) {
        const lngVars = extractVars(JSON.parse(fs.readFileSync(path.join(localesDir, lng, n + '.json'), 'utf8')));
        for (const [key, lngV] of Object.entries(lngVars)) {
          const enV = enVars[key] || [];
          // Check that translated vars are a SUBSET of English vars (no typos/unknown vars)
          const unknown = lngV.filter(v => !enV.includes(v));
          assert.equal(unknown.length, 0, `${lng}/${n}.json key '${key}' has unknown vars: ${unknown.join(', ')}`);
        }
      }
    }
  });
});

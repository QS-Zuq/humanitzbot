import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import fs from 'fs';

import _config from '../src/config/index.js';
const config = _config as any;

import * as _i18n from '../src/i18n/index.js';
const { t, getLocale, fmtDate, fmtTime, fmtNumber, getSupportedLocales, getLocalizations } = _i18n as any;

describe('i18n module', () => {
  let savedBotLocale: string;

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
    function leaves(o: Record<string, any>, p = ''): string[] {
      return Object.entries(o).flatMap(([k, v]) =>
        typeof v === 'object' && v !== null ? leaves(v, p + k + '.') : [p + k],
      );
    }
    const ns = ['common', 'web', 'discord', 'api', 'commands'];
    const localesDir = path.join(__dirname, '..', 'locales');
    for (const n of ns) {
      const en = leaves(JSON.parse(fs.readFileSync(path.join(localesDir, 'en', n + '.json'), 'utf8')));
      const tw = leaves(JSON.parse(fs.readFileSync(path.join(localesDir, 'zh-TW', n + '.json'), 'utf8')));
      const missing = en.filter((k) => !tw.includes(k));
      assert.equal(missing.length, 0, `zh-TW/${n}.json missing keys: ${missing.slice(0, 5).join(', ')}`);
    }
  });

  it('all zh-CN keys match en keys across all namespaces', () => {
    function leaves(o: Record<string, any>, p = ''): string[] {
      return Object.entries(o).flatMap(([k, v]) =>
        typeof v === 'object' && v !== null ? leaves(v, p + k + '.') : [p + k],
      );
    }
    const ns = ['common', 'web', 'discord', 'api', 'commands'];
    const localesDir = path.join(__dirname, '..', 'locales');
    for (const n of ns) {
      const en = leaves(JSON.parse(fs.readFileSync(path.join(localesDir, 'en', n + '.json'), 'utf8')));
      const cn = leaves(JSON.parse(fs.readFileSync(path.join(localesDir, 'zh-CN', n + '.json'), 'utf8')));
      const missing = en.filter((k) => !cn.includes(k));
      assert.equal(missing.length, 0, `zh-CN/${n}.json missing keys: ${missing.slice(0, 5).join(', ')}`);
    }
  });

  it('no empty string translations in zh-TW', () => {
    function checkEmpty(o: Record<string, any>, p = ''): string[] {
      const empties: string[] = [];
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
    function checkEmpty(o: Record<string, any>, p = ''): string[] {
      const empties: string[] = [];
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

  it('zh-CN values should not be identical to English when zh-TW has translated them', () => {
    function flatLeaves(o: Record<string, any>, p = ''): Record<string, string> {
      const result: Record<string, string> = {};
      for (const [k, v] of Object.entries(o)) {
        if (typeof v === 'object' && v !== null) Object.assign(result, flatLeaves(v, p + k + '.'));
        else result[p + k] = v as string;
      }
      return result;
    }
    const ns = ['common', 'web', 'discord', 'api', 'commands'];
    const localesDir = path.join(__dirname, '..', 'locales');
    for (const n of ns) {
      const enData = flatLeaves(JSON.parse(fs.readFileSync(path.join(localesDir, 'en', n + '.json'), 'utf8')));
      const twData = flatLeaves(JSON.parse(fs.readFileSync(path.join(localesDir, 'zh-TW', n + '.json'), 'utf8')));
      const cnData = flatLeaves(JSON.parse(fs.readFileSync(path.join(localesDir, 'zh-CN', n + '.json'), 'utf8')));
      const untranslated: string[] = [];
      for (const [key, enVal] of Object.entries(enData)) {
        const twVal = twData[key];
        const cnVal = cnData[key];
        // If zh-TW bothered to translate it (differs from en) but zh-CN is still identical to en
        if (twVal !== undefined && cnVal !== undefined && twVal !== enVal && cnVal === enVal) {
          untranslated.push(key);
        }
      }
      assert.equal(
        untranslated.length,
        0,
        `zh-CN/${n}.json has ${untranslated.length} untranslated values (identical to English but zh-TW differs): ${untranslated.slice(0, 10).join(', ')}`,
      );
    }
  });

  it('translations do not introduce unknown interpolation variables', () => {
    function extractVars(o: Record<string, any>, p = ''): Record<string, string[]> {
      const result: Record<string, string[]> = {};
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
          const unknown = lngV.filter((v) => !enV.includes(v));
          assert.equal(unknown.length, 0, `${lng}/${n}.json key '${key}' has unknown vars: ${unknown.join(', ')}`);
        }
      }
    }
  });
});

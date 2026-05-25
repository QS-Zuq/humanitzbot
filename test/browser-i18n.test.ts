import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function loadBrowserI18n(options: { rejectTimeZone?: string } = {}) {
  const warnings: unknown[][] = [];
  class MockDateTimeFormat {
    private opts: Intl.DateTimeFormatOptions;

    constructor(_lang: string, opts: Intl.DateTimeFormatOptions = {}) {
      if (opts.timeZone && opts.timeZone === options.rejectTimeZone) {
        throw new RangeError('Invalid time zone specified: ' + opts.timeZone);
      }
      this.opts = opts;
    }

    format(date: Date) {
      return (this.opts.timeZone || 'local') + '|' + date.toISOString();
    }
  }

  const context: Record<string, any> = {
    console: { ...console, warn: (...args: unknown[]) => warnings.push(args) },
    CustomEvent: function MockCustomEvent(_name: string, init: unknown) {
      return init;
    },
    Intl: {
      DateTimeFormat: MockDateTimeFormat,
      NumberFormat: Intl.NumberFormat,
    },
    location: { hostname: 'test.local' },
    document: {
      documentElement: {},
      querySelectorAll: () => [],
      getElementById: () => null,
      dispatchEvent: () => undefined,
    },
    i18nextHttpBackend: {},
    i18nextBrowserLanguageDetector: {},
    i18next: {
      resolvedLanguage: 'zh-TW',
      language: 'zh-TW',
      use() {
        return this;
      },
      init() {
        return {
          then: (fn: () => void) => {
            fn();
            return Promise.resolve();
          },
        };
      },
      dir: () => 'ltr',
      changeLanguage: () => Promise.resolve(),
      t: (key: string) => key,
    },
  };
  context.window = context;

  vm.runInNewContext(readFileSync('src/web-map/public/js/i18n.js', 'utf8'), context, {
    filename: 'i18n.js',
  });

  return { context, warnings };
}

describe('browser i18n formatters', () => {
  it('falls back to a fixed Taiwan offset when Intl rejects Asia/Taipei', () => {
    const { context, warnings } = loadBrowserI18n({ rejectTimeZone: 'Asia/Taipei' });

    const result = context.fmtTime(new Date('2026-05-24T17:40:01Z'), ' Asia/Taipei ');

    assert.equal(result, 'Etc/GMT-8|2026-05-24T17:40:01.000Z');
    assert.equal(warnings.length, 1);
    const firstWarning = warnings[0]?.[0];
    assert.equal(typeof firstWarning, 'string');
    assert.match(firstWarning as string, /Browser rejected timezone/);
  });

  it('uses timezone formatting when the browser accepts the timezone', () => {
    const { context, warnings } = loadBrowserI18n({ rejectTimeZone: 'Asia/Taipei' });

    const result = context.fmtDate(new Date('2026-05-24T17:40:01Z'), 'UTC');

    assert.equal(result, 'UTC|2026-05-24T17:40:01.000Z');
    assert.equal(warnings.length, 0);
  });
});

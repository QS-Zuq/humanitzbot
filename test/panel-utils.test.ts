import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function loadPanelUtils(options: { activityTimeZone?: string; timezone?: string } = {}) {
  const context: Record<string, any> = {
    window: {},
    document: {
      getElementById: () => null,
    },
    i18next: {
      t: (key: string, opts?: Record<string, unknown>) => opts?.defaultValue || key,
    },
    fmtDate: (date: Date, timeZone?: string) => `date:${timeZone || 'local'}:${date.toISOString()}`,
    fmtTime: (date: Date, timeZone?: string) => `time:${timeZone || 'local'}:${date.toISOString()}`,
  };
  context.window = context;
  context.Panel = {
    core: {
      S: {
        activityTimeZone: options.activityTimeZone || '',
        timezone: options.timezone || '',
      },
      toI18nSnakeCase: (value: string) => value,
      esc: (value: unknown) => String(value),
    },
  };

  vm.runInNewContext(readFileSync('src/web-map/public/js/panel-utils.js', 'utf8'), context, {
    filename: 'panel-utils.js',
  });

  return context.Panel.core.utils;
}

describe('panel timestamp utilities', () => {
  it('parses canonical SQLite UTC timestamps as UTC instants', () => {
    const utils = loadPanelUtils();

    const parsed = utils.parseDbTimestamp('2026-05-25 09:53:29');

    assert.equal(parsed?.toISOString(), '2026-05-25T09:53:29.000Z');
  });

  it('preserves fractional seconds from SQLite UTC timestamps', () => {
    const utils = loadPanelUtils();

    const parsed = utils.parseDbTimestamp('2026-05-25 09:53:29.769');

    assert.equal(parsed?.toISOString(), '2026-05-25T09:53:29.769Z');
  });

  it('formats DB timestamps through the configured panel timezone', () => {
    const utils = loadPanelUtils({ timezone: 'Asia/Taipei' });

    const formatted = utils.fmtDateTime('2026-05-25 09:53:29');

    assert.equal(formatted, 'date:Asia/Taipei:2026-05-25T09:53:29.000Z time:Asia/Taipei:2026-05-25T09:53:29.000Z');
  });

  it('uses panel timezone by default even when an activity timezone is loaded', () => {
    const utils = loadPanelUtils({ activityTimeZone: 'Europe/Tallinn', timezone: 'Asia/Taipei' });

    const formatted = utils.fmtDateTime('2026-05-25T09:53:29.000Z');

    assert.match(formatted, /^date:Asia\/Taipei:/);
  });

  it('lets callers pass an activity timezone for activity-derived views', () => {
    const utils = loadPanelUtils({ activityTimeZone: 'Europe/Tallinn', timezone: 'Asia/Taipei' });

    const formatted = utils.fmtDateTime('2026-05-25T09:53:29.000Z', 'Europe/Tallinn');

    assert.match(formatted, /^date:Europe\/Tallinn:/);
  });

  it('returns empty output for invalid timestamps', () => {
    const utils = loadPanelUtils({ timezone: 'Asia/Taipei' });

    assert.equal(utils.parseDbTimestamp('not a timestamp'), null);
    assert.equal(utils.fmtDateTime('not a timestamp'), '');
  });
});

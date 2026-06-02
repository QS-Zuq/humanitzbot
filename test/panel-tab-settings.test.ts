import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function esc(value: unknown): string {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function makeClassList() {
  const classes = new Set<string>();
  return {
    add: (...names: string[]) => {
      names.forEach((name) => classes.add(name));
    },
    remove: (...names: string[]) => {
      names.forEach((name) => classes.delete(name));
    },
    toggle: (name: string, force?: boolean) => {
      const enabled = force ?? !classes.has(name);
      if (enabled) classes.add(name);
      else classes.delete(name);
      return enabled;
    },
    contains: (name: string) => classes.has(name),
  };
}

function makeControl(value: string, dataset: Record<string, string>) {
  const errorEl = {
    textContent: '',
    classList: makeClassList(),
  };
  const row = {
    classList: makeClassList(),
    querySelector: (selector: string) => (selector === '.setting-error' ? errorEl : null),
  };
  return {
    value,
    type: 'text',
    dataset,
    classList: makeClassList(),
    closest: (selector: string) => (selector === '.setting-row' ? row : null),
    _errorEl: errorEl,
  };
}

function makeTimezoneComboboxInput(value: string, dataset: Record<string, string>) {
  const list = {
    innerHTML: '',
    classList: makeClassList(),
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  list.classList.add('hidden');

  const wrapper = {
    classList: makeClassList(),
    querySelector: (selector: string) => (selector === '.bot-config-combobox-list' ? list : null),
  };
  const row = { classList: makeClassList() };
  const group = { classList: makeClassList() };
  const attrs = new Map<string, string>();

  return {
    value,
    type: 'text',
    dataset,
    classList: makeClassList(),
    setAttribute: (name: string, attrValue: string) => attrs.set(name, attrValue),
    getAttribute: (name: string) => attrs.get(name) ?? null,
    closest: (selector: string) => {
      if (selector === '.bot-config-combobox') return wrapper;
      if (selector === '.setting-row') return row;
      if (selector === '.bot-config-group') return group;
      return null;
    },
    _attrs: attrs,
    _group: group,
    _list: list,
    _row: row,
    _wrapper: wrapper,
  };
}

function loadSettingsTab(queryAll: () => unknown[] = () => []) {
  const context: Record<string, any> = {
    console,
    i18next: {
      t: (_key: string, opts?: { defaultValue?: string }) => opts?.defaultValue || _key,
    },
  };
  context.window = context;
  context.Panel = {
    core: {
      S: {},
      $: () => null,
      $$: queryAll,
      el: () => ({
        appendChild: () => undefined,
        addEventListener: () => undefined,
        dataset: {},
        classList: makeClassList(),
      }),
      esc,
      apiFetch: () => Promise.resolve({ ok: false }),
      ENV_BOOLEANS: new Set(),
      getSettingCategories: () => ({}),
      getSettingDescs: () => ({}),
      getEnvDescs: () => ({}),
      getCssColor: () => '',
      utils: {
        humanizeSettingKey: (key: string) => key,
        showToast: () => undefined,
      },
    },
    tabs: {},
  };

  vm.runInNewContext(readFileSync('src/web-map/public/js/panel-tab-settings.js', 'utf8'), context, {
    filename: 'panel-tab-settings.js',
  });

  return context.Panel.tabs.settings._test;
}

describe('panel settings tab bot-config helpers', () => {
  it('escapes quotes in bot-config attribute values', () => {
    const helpers = loadSettingsTab();

    assert.equal(helpers.attrEsc('" autofocus onfocus="alert(1)\''), '&quot; autofocus onfocus=&quot;alert(1)&#39;');
  });

  it('validates timezone combobox values against the supplied option set', () => {
    const helpers = loadSettingsTab();

    const invalid = makeControl('Mars/Base', {
      validator: 'timezone',
      options: JSON.stringify(['UTC', 'Asia/Taipei']),
    });
    const valid = makeControl('Asia/Taipei', {
      validator: 'timezone',
      options: JSON.stringify(['UTC', 'Asia/Taipei']),
    });

    assert.equal(helpers.validateBotConfigControl(invalid), false);
    assert.equal(invalid.classList.contains('invalid'), true);
    assert.match(invalid._errorEl.textContent, /timezone/i);

    assert.equal(helpers.validateBotConfigControl(valid), true);
    assert.equal(valid.classList.contains('invalid'), false);
    assert.equal(valid._errorEl.textContent, '');
  });

  it('allows server-valid timezone aliases outside the suggested option set', () => {
    const helpers = loadSettingsTab();
    const alias = makeControl('US/Eastern', {
      validator: 'timezone',
      options: JSON.stringify(['UTC', 'America/New_York']),
      freeform: 'true',
    });

    assert.doesNotThrow(() => new Intl.DateTimeFormat(undefined, { timeZone: 'US/Eastern' }));
    assert.equal(helpers.validateBotConfigControl(alias), true);
    assert.equal(alias.classList.contains('invalid'), false);
    assert.equal(alias._errorEl.textContent, '');
  });

  it('labels timezone options with UTC offsets while preserving IANA values', () => {
    const helpers = loadSettingsTab();
    const option = helpers.buildTimezoneOption('Asia/Taipei', new Date('2026-01-01T00:00:00Z'));

    assert.equal(option.value, 'Asia/Taipei');
    assert.equal(option.offset, 'UTC+08:00');
    assert.match(option.label, /^Asia\/Taipei — UTC\+08:00$/);
  });

  it('matches timezone search by city, region, and UTC offset aliases', () => {
    const helpers = loadSettingsTab();
    const option = helpers.buildTimezoneOption('Asia/Taipei', new Date('2026-01-01T00:00:00Z'));

    assert.equal(helpers.timezoneOptionMatchesQuery(option, 'taipei'), true);
    assert.equal(helpers.timezoneOptionMatchesQuery(option, 'asia'), true);
    assert.equal(helpers.timezoneOptionMatchesQuery(option, 'UTC+8'), true);
    assert.equal(helpers.timezoneOptionMatchesQuery(option, 'UTC+08:00'), true);
    assert.equal(helpers.timezoneOptionMatchesQuery(option, 'new york'), false);
  });

  it('uses UTC offsets for search labels but does not accept raw UTC offsets as stored values', () => {
    const helpers = loadSettingsTab();
    const rawOffset = makeControl('UTC+8', {
      validator: 'timezone',
      options: JSON.stringify(['UTC', 'Asia/Taipei']),
      freeform: 'true',
    });

    assert.equal(helpers.validateBotConfigControl(rawOffset), false);
    assert.match(rawOffset._errorEl.textContent, /timezone/i);
  });

  it('deduplicates timezone option values before rendering searchable entries', () => {
    const helpers = loadSettingsTab();
    const options = helpers.buildTimezoneOptions(['UTC', 'Asia/Taipei', 'UTC'], new Date('2026-01-01T00:00:00Z'));
    const values = Array.from(options, (option: unknown) => (option as { value: string }).value);

    assert.deepEqual(values, ['UTC', 'Asia/Taipei']);
  });

  it('caches timezone options without retaining one-off current values', () => {
    const helpers = loadSettingsTab();
    const dataset = {
      validator: 'timezone',
      options: JSON.stringify(['UTC', 'Asia/Taipei']),
      freeform: 'true',
    };
    const withAlias = makeTimezoneComboboxInput('US/Eastern', dataset);
    const withoutAlias = makeTimezoneComboboxInput('', dataset);

    const first = helpers.getTimezoneComboboxOptions(withAlias);
    const second = helpers.getTimezoneComboboxOptions(withoutAlias);

    assert.equal(first[0].value, 'US/Eastern');
    assert.equal(JSON.stringify(second.map((option: { value: string }) => option.value)), '["UTC","Asia/Taipei"]');
    assert.notEqual(first, second);
  });

  it('closes an already open timezone dropdown before opening another one', () => {
    let inputs: unknown[] = [];
    const helpers = loadSettingsTab(() => inputs);
    const dataset = {
      validator: 'timezone',
      options: JSON.stringify(['UTC', 'Asia/Taipei', 'Europe/London']),
    };
    const first = makeTimezoneComboboxInput('Asia/Taipei', dataset);
    const second = makeTimezoneComboboxInput('Europe/London', dataset);
    inputs = [first, second];

    helpers.openTimezoneCombobox(first, true);
    assert.equal(first.getAttribute('aria-expanded'), 'true');
    assert.equal(first._wrapper.classList.contains('open'), true);
    assert.equal(first._group.classList.contains('bot-config-group-open-dropdown'), true);

    helpers.openTimezoneCombobox(second, true);

    assert.equal(first.getAttribute('aria-expanded'), 'false');
    assert.equal(first._wrapper.classList.contains('open'), false);
    assert.equal(first._list.classList.contains('hidden'), true);
    assert.equal(first._group.classList.contains('bot-config-group-open-dropdown'), false);
    assert.equal(second.getAttribute('aria-expanded'), 'true');
    assert.equal(second._wrapper.classList.contains('open'), true);
    assert.equal(second._row.classList.contains('setting-combobox-open'), true);
    assert.equal(second._group.classList.contains('bot-config-group-open-dropdown'), true);
  });

  it('keeps an empty select value valid so cleared optional fields round-trip', () => {
    const helpers = loadSettingsTab();
    const empty = makeControl('', {
      validator: 'enum',
      options: JSON.stringify(['memory', 'sqlite', 'redis']),
    });

    assert.equal(helpers.validateBotConfigControl(empty), true);
    assert.equal(empty.classList.contains('invalid'), false);
  });

  it('rejects empty required bot-config controls', () => {
    const helpers = loadSettingsTab();
    const emptyTime = makeControl('', {
      validator: 'time',
      required: 'true',
    });

    assert.equal(helpers.validateBotConfigControl(emptyTime), false);
    assert.equal(emptyTime.classList.contains('invalid'), true);
    assert.match(emptyTime._errorEl.textContent, /required/i);
  });

  it('rejects JSON override objects with nested values', () => {
    const helpers = loadSettingsTab();
    const nested = makeControl('{"OnDeath":{"nested":"0"}}', {
      validator: 'json',
    });

    assert.equal(helpers.validateBotConfigControl(nested), false);
    assert.equal(nested.classList.contains('invalid'), true);
    assert.match(nested._errorEl.textContent, /JSON object/i);
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function esc(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function makeElement() {
  const classes = new Set<string>();
  return {
    value: '',
    innerHTML: '',
    textContent: '',
    title: '',
    className: '',
    classList: {
      add: (cls: string) => classes.add(cls),
      remove: (cls: string) => classes.delete(cls),
      toggle: (cls: string, force?: boolean) => {
        const next = force === undefined ? !classes.has(cls) : force;
        if (next) classes.add(cls);
        else classes.delete(cls);
        return next;
      },
      contains: (cls: string) => classes.has(cls),
    },
    appendChild: () => undefined,
    querySelector: () => null,
  };
}

function loadActivityTab(
  stats: Record<string, unknown>,
  options: {
    apiFetch?: (url: string) => Promise<{ ok?: boolean; status?: number; json: () => Promise<unknown> }>;
    consoleError?: (...args: unknown[]) => void;
  } = {},
) {
  const elements = new Map<string, ReturnType<typeof makeElement>>();
  for (const id of [
    'act-total',
    'act-types-count',
    'act-date-range',
    'act-top-actor',
    'activity-feed',
    'activity-search',
    'activity-range-preset',
    'activity-date-from',
    'activity-date-to',
    'activity-date-separator',
    'activity-load-more',
    'fingerprint-tracker',
    'fp-item-name',
    'fp-hash',
    'fp-instance-info',
    'fp-ownership',
    'fp-ownership-chain',
    'fp-movements',
    'fp-loading',
    'fp-empty',
    'fp-limit',
  ]) {
    elements.set(id, makeElement());
  }
  const rangePreset = elements.get('activity-range-preset');
  assert.ok(rangePreset);
  rangePreset.value = 'today';
  const apiCalls: string[] = [];

  const context: Record<string, any> = {
    console: { ...console, error: options.consoleError || console.error },
    URLSearchParams,
    Chart: function MockChart() {
      return { destroy: () => undefined };
    },
    i18next: { t: (key: string) => key },
    document: {
      createElement: () => makeElement(),
    },
  };
  context.window = context;
  context.Panel = {
    core: {
      S: {
        currentServer: 'default',
        activityCategory: '',
        activitySearchMode: '',
        activitySearchSteamId: '',
        activityRangePreset: 'today',
        activitySelectedRange: null,
        activityTimeZone: '',
        activityCharts: {},
        activityStats: null,
        activityChartsLoaded: false,
      },
      $: (selector: string) => (selector.startsWith('#') ? elements.get(selector.slice(1)) || null : null),
      $$: () => [],
      esc,
      apiFetch: async (url: string) => {
        apiCalls.push(url);
        if (options.apiFetch) return options.apiFetch(url);
        return { ok: true, json: async () => stats };
      },
      utils: {
        fmtNum: (n: unknown) => String(n),
        setTabUnavailable: () => undefined,
      },
    },
    shared: {
      activityFeed: {
        render: () => undefined,
        resetPaging: () => undefined,
        getPageSize: () => 100,
        getOffset: () => 0,
        setOffset: () => undefined,
        getHasMore: () => false,
        setHasMore: () => undefined,
      },
    },
    tabs: {},
  };

  vm.runInNewContext(readFileSync('src/web-map/public/js/panel-tab-activity.js', 'utf8'), context, {
    filename: 'panel-tab-activity.js',
  });

  return { activityTab: context.Panel.tabs.activity, elements, state: context.Panel.core.S, apiCalls };
}

describe('panel activity tab', () => {
  it('renders date range as compact dates when API returns SQLite datetime strings', async () => {
    const { activityTab, elements } = loadActivityTab({
      total: 1043363,
      types: { player_connect: 3 },
      categories: {},
      hourly: [],
      daily: [],
      topPlayers: [{ actor: 'Alice', count: 4 }],
      topActors: [{ actor: 'Container', count: 1331 }],
      dateRange: {
        earliest: '2026-05-08 04:53:59',
        latest: '2026-05-24 15:03:12',
      },
    });

    await activityTab.loadActivityStats();

    const rangeEl = elements.get('act-date-range');
    assert.ok(rangeEl);
    assert.equal(rangeEl.textContent, '2026-05-08 — 2026-05-24');
    assert.equal(rangeEl.title, '2026-05-08 04:53:59 | 2026-05-24 15:03:12');
    assert.equal(elements.get('act-top-actor')?.textContent, 'Alice (4)');
  });

  it('uses explicit item/container/player activity query modes', async () => {
    const { activityTab, elements, state, apiCalls } = loadActivityTab({ events: [] });
    const searchEl = elements.get('activity-search');
    assert.ok(searchEl);

    state.activitySearchMode = 'item';
    searchEl.value = 'Fork';
    await activityTab.loadActivity();
    const itemUrl = apiCalls.pop() || '';
    assert.match(itemUrl, /mode=item/);
    assert.match(itemUrl, /q=Fork/);

    searchEl.value = 'Fork#abc123def456';
    await activityTab.loadActivity();
    const fingerprintItemUrl = apiCalls.pop() || '';
    assert.match(fingerprintItemUrl, /mode=item/);
    assert.match(fingerprintItemUrl, /q=Fork/);
    assert.doesNotMatch(fingerprintItemUrl, /q=Fork%23abc123def456/);

    state.activitySearchMode = 'container';
    searchEl.value = 'BuildContainer_1134';
    await activityTab.loadActivity();
    assert.match(apiCalls.pop() || '', /mode=container/);

    state.activitySearchMode = 'player';
    state.activitySearchSteamId = '76561198033176898';
    searchEl.value = '76561198033176898';
    await activityTab.loadActivity();
    const playerUrl = apiCalls.pop() || '';
    assert.match(playerUrl, /mode=player/);
    assert.match(playerUrl, /steamId=76561198033176898/);
    assert.doesNotMatch(playerUrl, /q=/);
  });

  it('defaults activity queries to today and sends custom date ranges only when selected', async () => {
    const { activityTab, elements, apiCalls } = loadActivityTab({ events: [] });

    await activityTab.loadActivity();
    assert.match(apiCalls.pop() || '', /range=today/);

    const rangePreset = elements.get('activity-range-preset');
    const dateFrom = elements.get('activity-date-from');
    const dateTo = elements.get('activity-date-to');
    assert.ok(rangePreset);
    assert.ok(dateFrom);
    assert.ok(dateTo);
    rangePreset.value = 'custom';
    dateFrom.value = '2026-05-24';
    dateTo.value = '2026-05-25';
    await activityTab.loadActivity();
    const customUrl = apiCalls.pop() || '';
    assert.match(customUrl, /range=custom/);
    assert.match(customUrl, /from=2026-05-24/);
    assert.match(customUrl, /to=2026-05-25/);
  });

  it('shows the server-selected activity range and timezone in stats', async () => {
    const { activityTab, elements, state } = loadActivityTab({
      total: 4,
      types: { inventory_item_added: 4 },
      categories: { inventory: 4 },
      hourly: [],
      daily: [],
      topPlayers: [],
      dateRange: { earliest: '2026-05-24 00:01:00', latest: '2026-05-24 03:00:00' },
      selectedRange: {
        preset: 'today',
        timezone: 'Asia/Taipei',
        from: '2026-05-24',
        to: '2026-05-24',
        dateFrom: '2026-05-23 16:00:00',
        dateTo: '2026-05-24 16:00:00',
      },
      timezone: 'Asia/Taipei',
    });

    await activityTab.loadActivityStats();

    assert.equal(elements.get('act-date-range')?.textContent, '2026-05-24 — 2026-05-24');
    assert.match(elements.get('act-date-range')?.title || '', /Asia\/Taipei/);
    assert.equal(state.activityTimeZone, 'Asia/Taipei');
  });

  it('shows a diagnostic when activity feed API returns an invalid response', async () => {
    const errors: unknown[][] = [];
    const { activityTab, elements } = loadActivityTab(
      {},
      {
        apiFetch: async () => ({
          ok: false,
          status: 500,
          json: async () => ({ error: 'boom from API' }),
        }),
        consoleError: (...args: unknown[]) => errors.push(args),
      },
    );

    await activityTab.loadActivity();

    const feed = elements.get('activity-feed');
    assert.ok(feed);
    assert.match(feed.innerHTML, /web:empty_states\.failed_to_load_activity/);
    assert.match(feed.innerHTML, /boom from API/);
    assert.equal(errors.length, 1);
    const firstLog = errors[0]?.[0];
    assert.equal(typeof firstLog, 'string');
    assert.match(firstLog as string, /failed to load activity feed/);
  });

  it('shows a tracker failure message when fingerprint lookup fails', async () => {
    const { activityTab, elements, state } = loadActivityTab(
      { events: [] },
      {
        apiFetch: async (url: string) => {
          if (url.startsWith('/api/panel/items/lookup?')) {
            return { ok: false, status: 500, json: async () => ({ error: 'lookup failed' }) };
          }
          return { ok: true, json: async () => ({ events: [] }) };
        },
      },
    );
    const searchEl = elements.get('activity-search');
    assert.ok(searchEl);
    state.activitySearchMode = 'item';
    searchEl.value = 'Fork#abc123def456';

    await activityTab.loadActivity();
    await Promise.resolve();
    await Promise.resolve();

    const movementsEl = elements.get('fp-movements');
    assert.ok(movementsEl);
    assert.match(movementsEl.innerHTML, /web:activity\.failed_to_load_tracker_data/);
  });
});

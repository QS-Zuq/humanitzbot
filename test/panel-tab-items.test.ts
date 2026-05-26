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

function makeElement(initialValue = '') {
  const listeners = new Map<string, Array<(event: any) => void>>();
  const element: Record<string, any> = {
    value: initialValue,
    innerHTML: '',
    textContent: '',
    className: '',
    dataset: {},
    options: [],
    classList: {
      add: () => undefined,
      remove: () => undefined,
      toggle: () => false,
      contains: () => false,
    },
    addEventListener: (type: string, handler: (event: any) => void) => {
      const handlers = listeners.get(type) || [];
      handlers.push(handler);
      listeners.set(type, handlers);
    },
    appendChild: (child: any) => {
      element.options.push(child);
    },
    querySelector: () => null,
    closest: () => null,
    dispatch: (type: string, event: any) => {
      for (const handler of listeners.get(type) || []) handler(event);
    },
  };
  return element;
}

function loadItemsTab(options: {
  apiFetch: (url: string) => Promise<{ ok?: boolean; status?: number; json: () => Promise<unknown> }>;
  consoleError?: (...args: unknown[]) => void;
}) {
  const elements = new Map<string, any>();
  for (const id of [
    'items-search',
    'items-view',
    'items-location-filter',
    'items-content',
    'items-list',
    'items-recent-movements',
    'item-detail-close',
    'item-detail-modal',
    'item-detail-content',
    'items-unique-count',
    'items-group-count',
    'items-location-count',
    'items-movement-count',
    'activity-search',
  ]) {
    elements.set(id, makeElement());
  }
  elements.get('items-view').value = 'all';

  const context: Record<string, any> = {
    console: { ...console, error: options.consoleError || console.error },
    URLSearchParams,
    setTimeout,
    clearTimeout,
    i18next: { t: (key: string) => key },
    document: {
      createElement: () => makeElement(),
    },
  };
  context.window = context;
  context.Panel = {
    core: {
      S: {
        currentTab: 'items',
        activitySearchMode: '',
        activitySearchSteamId: '',
      },
      $: (selector: string) => (selector.startsWith('#') ? elements.get(selector.slice(1)) || null : null),
      esc,
      apiFetch: options.apiFetch,
    },
    nav: {
      switchTab: () => undefined,
    },
    shared: {
      activityFeed: {
        resetPaging: () => undefined,
      },
    },
    tabs: {
      activity: {
        loadActivity: () => undefined,
      },
    },
  };

  vm.runInNewContext(readFileSync('src/web-map/public/js/panel-tab-items.js', 'utf8'), context, {
    filename: 'panel-tab-items.js',
  });

  return { itemsTab: context.Panel.tabs.items, elements };
}

describe('panel items tab', () => {
  it('does not issue duplicate item page requests while Load More is already loading', async () => {
    let itemRequestCount = 0;
    let resolveSecondItemRequest!: (value: { ok: boolean; json: () => Promise<unknown> }) => void;
    const pendingSecondItemRequest = new Promise<{ ok: boolean; json: () => Promise<unknown> }>((resolve) => {
      resolveSecondItemRequest = resolve;
    });
    const { itemsTab, elements } = loadItemsTab({
      apiFetch: async (url: string) => {
        if (url.startsWith('/api/panel/movements?')) {
          return { ok: true, json: async () => ({ movements: [] }) };
        }
        if (url.startsWith('/api/panel/items?')) {
          itemRequestCount++;
          if (itemRequestCount === 1) {
            return {
              ok: true,
              json: async () => ({
                instances: [],
                groups: [],
                counts: { instances: 0, groups: 0 },
                pagination: { nextOffset: 100, hasMoreInstances: false, hasMoreGroups: true },
              }),
            };
          }
          return pendingSecondItemRequest;
        }
        throw new Error('Unexpected API call: ' + url);
      },
    });

    itemsTab.init();
    await itemsTab.load({ reset: true });
    assert.equal(itemRequestCount, 1);

    const content = elements.get('items-content');
    const loadMoreTarget = {
      closest: (selector: string) => (selector === '#items-load-more' ? {} : null),
    };
    content.dispatch('click', { target: loadMoreTarget });
    content.dispatch('click', { target: loadMoreTarget });
    await Promise.resolve();

    assert.equal(itemRequestCount, 2);

    resolveSecondItemRequest({
      ok: true,
      json: async () => ({
        instances: [],
        groups: [],
        counts: { instances: 0, groups: 0 },
        pagination: { nextOffset: 200, hasMoreInstances: false, hasMoreGroups: false },
      }),
    });
  });

  it('shows a visible location filter error when lazy location loading fails', async () => {
    const errors: unknown[][] = [];
    const { itemsTab, elements } = loadItemsTab({
      apiFetch: async (url: string) => {
        if (url.startsWith('/api/panel/items/locations?')) throw new Error('location lookup failed');
        throw new Error('Unexpected API call: ' + url);
      },
      consoleError: (...args: unknown[]) => errors.push(args),
    });

    itemsTab.init();
    elements.get('items-location-filter').dispatch('focus', {});
    await new Promise((resolve) => setImmediate(resolve));

    const locFilter = elements.get('items-location-filter');
    assert.equal(elements.get('items-location-count').textContent, '!');
    assert.equal(locFilter.options.length, 1);
    assert.equal(locFilter.options[0].disabled, true);
    assert.match(locFilter.options[0].textContent, /web:empty_states\.failed_to_load_item_data/);
    assert.equal(errors.length, 1);
  });
});

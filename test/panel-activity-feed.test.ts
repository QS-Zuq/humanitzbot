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

function loadActivityFeed(
  options: {
    t?: (key: string) => string;
    consoleError?: (...args: unknown[]) => void;
    tier?: number;
    document?: any;
    elements?: Record<string, any>;
  } = {},
) {
  const children: Array<Record<string, string>> = [];
  const context: Record<string, any> = {
    console: { ...console, error: options.consoleError || console.error },
    i18next: {
      t: options.t || ((key: string) => key.split('.').pop() || key),
    },
    fmtTime: (date: Date, timeZone?: string) => `${date.toISOString()}|${timeZone || ''}`,
  };
  context.__children = children;
  context.window = context;
  context.scrollX = 0;
  context.scrollY = 0;
  context.innerWidth = 1024;
  context.setTimeout = (fn: () => void) => {
    fn();
    return 0;
  };
  if (options.document) context.document = options.document;
  context.Panel = {
    core: {
      S: { activityTimeZone: 'Asia/Taipei', tier: options.tier ?? 1 },
      $: (selector: string) => (options.elements ? options.elements[selector] || null : null),
      el: () => ({
        innerHTML: '',
        title: '',
        style: {},
        classList: {
          add: () => undefined,
          remove: () => undefined,
          contains: () => false,
        },
        addEventListener: () => undefined,
        appendChild: () => undefined,
        remove: () => undefined,
      }),
      esc,
      utils: {},
    },
    shared: {},
  };

  vm.runInNewContext(readFileSync('src/web-map/public/js/panel-shared-activity-feed.js', 'utf8'), context, {
    filename: 'panel-shared-activity-feed.js',
  });

  return { feed: context.Panel.shared.activityFeed, context };
}

describe('panel shared activity feed formatter', () => {
  it('keeps non-player actor entities separate from attributed player links', () => {
    const { feed } = loadActivityFeed();

    const formatted = feed.format({
      type: 'container_item_added',
      actor: 'House_Chest_1',
      actor_name: 'House Chest',
      steam_id: '76561198000000001',
      attributed_name: 'Alice',
      item: 'Rope',
      amount: 1,
      details: { attributedPlayer: 'Alice', attributedSteamId: '76561198000000001' },
    });

    assert.match(formatted.text, /data-entity-table="containers"/);
    assert.match(formatted.text, /data-mode="container"/);
    assert.match(formatted.text, /data-entity-search="House Chest"/);
    assert.match(formatted.text, /data-steam-id="76561198000000001">Alice/);
    assert.match(formatted.text, /data-mode="item"[^>]*>Rope/);
    assert.doesNotMatch(formatted.text, /data-steam-id="76561198000000001">House Chest/);
  });

  it('renders item action metadata when an activity event has a fingerprint', () => {
    const { feed } = loadActivityFeed();

    const formatted = feed.format({
      type: 'inventory_item_added',
      actor: 'Alice',
      actor_name: 'Alice',
      steam_id: '76561198000000001',
      item: 'Fork',
      amount: 1,
      details: { fingerprint: 'abc123def456' },
    });

    assert.match(formatted.text, /activity-item-action/);
    assert.match(formatted.text, /data-mode="item"/);
    assert.match(formatted.text, /data-item-name="Fork"/);
    assert.match(formatted.text, /data-fingerprint="abc123def456"/);
    assert.match(formatted.text, /data-search="Fork"/);
    assert.doesNotMatch(formatted.text, /activity-item-action entity-link/);
    assert.doesNotMatch(formatted.text, /data-entity-table="item_instances"/);
  });

  it('keeps unambiguous item fingerprints on grouped activity summaries', () => {
    const { feed } = loadActivityFeed();
    const rows: Array<{ innerHTML: string }> = [];
    const container = {
      innerHTML: '',
      appendChild: (item: { innerHTML: string }) => rows.push(item),
    };

    feed.render(
      container,
      [
        {
          type: 'inventory_item_removed',
          actor: 'Alice',
          actor_name: 'Alice',
          steam_id: '76561198000000001',
          item: 'Spoon',
          amount: 1,
          details: { fingerprint: 'spoonhash1234' },
          created_at: '2026-05-25 17:02:12',
        },
        {
          type: 'inventory_item_removed',
          actor: 'Alice',
          actor_name: 'Alice',
          steam_id: '76561198000000001',
          item: 'Fork',
          amount: 1,
          details: { fingerprint: 'forkhash12345' },
          created_at: '2026-05-25 17:02:12',
        },
      ],
      false,
      false,
    );

    assert.equal(rows.length, 1);
    assert.match(rows[0]?.innerHTML || '', /data-item-name="Spoon"[^>]*data-fingerprint="spoonhash1234"/);
    assert.match(rows[0]?.innerHTML || '', /data-item-name="Fork"[^>]*data-fingerprint="forkhash12345"/);
  });

  it('leaves grouped same-name items untracked when their fingerprints are ambiguous', () => {
    const { feed } = loadActivityFeed();
    const rows: Array<{ innerHTML: string }> = [];
    const container = {
      innerHTML: '',
      appendChild: (item: { innerHTML: string }) => rows.push(item),
    };

    feed.render(
      container,
      [
        {
          type: 'inventory_item_removed',
          actor: 'Alice',
          actor_name: 'Alice',
          steam_id: '76561198000000001',
          item: 'Spoon',
          amount: 1,
          details: { fingerprint: 'spoonhash1234' },
          created_at: '2026-05-25 17:02:12',
        },
        {
          type: 'inventory_item_removed',
          actor: 'Alice',
          actor_name: 'Alice',
          steam_id: '76561198000000001',
          item: 'Spoon',
          amount: 1,
          details: { fingerprint: 'otherspoon567' },
          created_at: '2026-05-25 17:02:12',
        },
      ],
      false,
      false,
    );

    assert.equal(rows.length, 1);
    assert.match(rows[0]?.innerHTML || '', /data-item-name="Spoon"/);
    assert.doesNotMatch(rows[0]?.innerHTML || '', /data-fingerprint=/);
    assert.match(rows[0]?.innerHTML || '', /Spoon<\/span> ×2/);
  });

  it('keeps item action/filter metadata without faking fingerprint for old activity events', () => {
    const { feed } = loadActivityFeed();

    const formatted = feed.format({
      type: 'inventory_item_added',
      actor: 'Alice',
      actor_name: 'Alice',
      steam_id: '76561198000000001',
      item: 'Fork',
      amount: 1,
      details: {},
    });

    assert.match(formatted.text, /activity-item-action/);
    assert.match(formatted.text, /data-mode="item"/);
    assert.match(formatted.text, /data-item-name="Fork"/);
    assert.doesNotMatch(formatted.text, /data-fingerprint=/);
  });

  it('gates the activity item DB action to admins', () => {
    const admin = loadActivityFeed({ tier: 3 }).feed.buildItemPopoverHtml('Fork', 'abc123def456');
    const survivor = loadActivityFeed({ tier: 1 }).feed.buildItemPopoverHtml('Fork', 'abc123def456');

    assert.match(admin, /db-link/);
    assert.match(admin, /data-table="item_instances"/);
    assert.match(admin, /data-search="abc123def456"/);
    assert.match(admin, /activity-item-popover-action text-\[10px\] text-accent hover:underline cursor-pointer/);
    assert.match(admin, /track_item →/);
    assert.match(admin, /filter_same_item →/);
    assert.doesNotMatch(admin, /hover:bg-panel/);
    assert.doesNotMatch(admin, /hover:bg-accent\/30/);
    assert.doesNotMatch(survivor, /db-link/);
  });

  it('shows a disabled no-fingerprint state in the activity item popover', () => {
    const { feed } = loadActivityFeed();
    const html = feed.buildItemPopoverHtml('Fork', '');

    assert.match(html, /disabled/);
    assert.match(html, /track_unavailable/);
    assert.match(html, /hover:underline cursor-pointer" data-action="filter"/);
    assert.match(html, /filter_same_item →/);
    assert.doesNotMatch(html, /data-action="track"/);
  });

  it('stops same-click propagation after opening the activity item popover', () => {
    const listeners: Partial<Record<string, Array<(event: any) => void>>> = { click: [], keydown: [] };
    let popup: any = null;
    const fakeDocument = {
      body: {
        appendChild: (node: any) => {
          popup = node;
        },
      },
      addEventListener: (type: string, handler: (event: any) => void) => {
        (listeners[type] ??= []).push(handler);
      },
      createElement: () => ({
        innerHTML: '',
        get firstElementChild() {
          return {
            style: {},
            remove: () => undefined,
          };
        },
      }),
      querySelector: () => null,
    };
    loadActivityFeed({ document: fakeDocument });

    let stopped = false;
    let prevented = false;
    const anchor = {
      dataset: { itemName: 'Fork', search: 'Fork', fingerprint: 'abc123def456' },
      textContent: 'Fork',
      getBoundingClientRect: () => ({ bottom: 10, left: 20 }),
      closest: (selector: string) => (selector === '.activity-item-action' ? anchor : null),
    };

    const clickHandler = listeners.click?.[0];
    if (!clickHandler) throw new Error('Expected click handler registration');
    clickHandler({
      target: anchor,
      preventDefault: () => {
        prevented = true;
      },
      stopImmediatePropagation: () => {
        stopped = true;
      },
    });

    assert.equal(prevented, true);
    assert.equal(stopped, true);
    assert.ok(popup);
  });

  it('applies track and filter actions from the activity item popover', () => {
    const listeners: Partial<Record<string, Array<(event: any) => void>>> = { click: [], keydown: [] };
    const searchInput = { value: '' };
    const filterInput = { value: 'inventory' };
    const fakeDocument = {
      body: { appendChild: () => undefined },
      addEventListener: (type: string, handler: (event: any) => void) => {
        (listeners[type] ??= []).push(handler);
      },
      createElement: () => ({ innerHTML: '', firstElementChild: null }),
      querySelector: () => null,
    };
    const { context } = loadActivityFeed({
      document: fakeDocument,
      elements: {
        '#activity-search': searchInput,
        '#activity-filter': filterInput,
      },
    });

    let switchedTab = '';
    let resetCount = 0;
    let loadCount = 0;
    let popupRemoved = 0;
    context.Panel.nav = { switchTab: (tab: string) => (switchedTab = tab) };
    context.Panel.tabs = { activity: { load: () => loadCount++ } };
    context.Panel.shared.activityFeed.resetPaging = () => resetCount++;

    const clickHandler = listeners.click?.[0];
    if (!clickHandler) throw new Error('Expected click handler registration');
    const popup = { remove: () => popupRemoved++ };
    const actionEl = {
      dataset: { itemName: 'Fork', action: 'track', fingerprint: 'abc123def456' },
      closest: (selector: string) => {
        if (selector === '.activity-item-popover-action') return actionEl;
        if (selector === '.item-popup') return popup;
        return null;
      },
    };

    clickHandler({
      target: actionEl,
      preventDefault: () => undefined,
      stopImmediatePropagation: () => undefined,
    });

    assert.equal(context.Panel.core.S.activitySearchMode, 'item');
    assert.equal(context.Panel.core.S.activityCategory, '');
    assert.equal(searchInput.value, 'Fork#abc123def456');
    assert.equal(filterInput.value, '');
    assert.equal(switchedTab, 'activity');
    assert.equal(resetCount, 1);
    assert.equal(loadCount, 1);
    assert.equal(popupRemoved, 1);

    actionEl.dataset.action = 'filter';
    filterInput.value = 'inventory';
    clickHandler({
      target: actionEl,
      preventDefault: () => undefined,
      stopImmediatePropagation: () => undefined,
    });

    assert.equal(searchInput.value, 'Fork');
    assert.equal(filterInput.value, '');
    assert.equal(resetCount, 2);
    assert.equal(loadCount, 2);
  });

  it('closes the activity item popover on outside click and Escape', () => {
    const listeners: Partial<Record<string, Array<(event: any) => void>>> = { click: [], keydown: [] };
    let removeCount = 0;
    const popup = { remove: () => removeCount++ };
    const fakeDocument = {
      body: { appendChild: () => undefined },
      addEventListener: (type: string, handler: (event: any) => void) => {
        (listeners[type] ??= []).push(handler);
      },
      createElement: () => ({ innerHTML: '', firstElementChild: null }),
      querySelector: (selector: string) => (selector === '.activity-item-popover' ? popup : null),
    };
    loadActivityFeed({ document: fakeDocument });

    const clickHandler = listeners.click?.[0];
    const keydownHandler = listeners.keydown?.[0];
    if (!clickHandler || !keydownHandler) throw new Error('Expected popover handlers');

    const outside = { closest: () => null };
    clickHandler({ target: outside });
    assert.equal(removeCount, 1);

    keydownHandler({ key: 'Escape' });
    assert.equal(removeCount, 2);
  });

  it('ignores non-element click targets without breaking global activity item delegation', () => {
    const listeners: Partial<Record<string, Array<(event: any) => void>>> = { click: [], keydown: [] };
    let removeCount = 0;
    const popup = { remove: () => removeCount++ };
    const fakeDocument = {
      body: { appendChild: () => undefined },
      addEventListener: (type: string, handler: (event: any) => void) => {
        (listeners[type] ??= []).push(handler);
      },
      createElement: () => ({ innerHTML: '', firstElementChild: null }),
      querySelector: (selector: string) => (selector === '.activity-item-popover' ? popup : null),
    };
    loadActivityFeed({ document: fakeDocument });

    const clickHandler = listeners.click?.[0];
    if (!clickHandler) throw new Error('Expected popover click handler');

    assert.doesNotThrow(() => {
      clickHandler({ target: {} });
    });
    assert.equal(removeCount, 1);
  });

  it('shows attribution status badges without creating fake player links', () => {
    const { feed } = loadActivityFeed();

    const formatted = feed.format({
      type: 'container_item_added',
      actor: 'BuildContainer_1134',
      actor_name: 'BuildContainer_1134',
      item: 'Fork',
      amount: 1,
      details: {
        attribution: {
          status: 'no_inventory_delta',
          reason: 'no matching inventory delta events in this sync batch',
        },
      },
    });

    assert.match(formatted.text, />unattributed_no_inventory_delta</);
    assert.match(formatted.text, /data-mode="container"/);
    assert.match(formatted.text, /data-mode="item"[^>]*>Fork/);
    assert.doesNotMatch(formatted.text, /data-steam-id=/);
  });

  it('distinguishes ambiguous and unmatched attribution reasons', () => {
    const { feed } = loadActivityFeed();

    const ambiguous = feed.format({
      type: 'container_item_removed',
      actor: 'BuildContainer_1134',
      actor_name: 'BuildContainer_1134',
      item: 'Fork',
      details: {
        attribution: {
          status: 'ambiguous',
          reason: 'multiple matching player inventory deltas',
        },
      },
    });
    const unmatched = feed.format({
      type: 'container_item_removed',
      actor: 'BuildContainer_1134',
      actor_name: 'BuildContainer_1134',
      item: 'Fork',
      details: {
        attribution: {
          status: 'unmatched',
          reason: 'inventory deltas did not match this item',
        },
      },
    });

    assert.match(ambiguous.text, />unattributed_ambiguous</);
    assert.match(ambiguous.text, /multiple matching player inventory deltas/);
    assert.match(unmatched.text, />unattributed_unmatched</);
    assert.match(unmatched.text, /inventory deltas did not match this item/);
    assert.doesNotMatch(String(ambiguous.text) + String(unmatched.text), /data-steam-id=/);
  });

  it('keeps player actor events as player links when actor is a name plus steam_id', () => {
    const { feed } = loadActivityFeed();

    const formatted = feed.format({
      type: 'player_build',
      actor: 'Alice',
      actor_name: 'Alice',
      steam_id: '76561198000000001',
      item: 'Wood Wall',
      amount: 1,
    });

    assert.match(formatted.text, /data-steam-id="76561198000000001">Alice/);
    assert.doesNotMatch(formatted.text, /data-entity-table="structures"[^>]*>Alice/);
  });

  it('renders structure upgrades without leaking the internal structure trace key', () => {
    const { feed } = loadActivityFeed();

    const formatted = feed.format({
      type: 'structure_upgraded',
      category: 'structure',
      actor: '::76561198963770601::854,-1651',
      actor_name: '::76561198963770601::854,-1651',
      steam_id: '76561198963770601',
      attributed_name: 'Bols',
      item: '',
      amount: 1,
      pos_x: 85412,
      pos_y: -165099,
    });

    assert.match(formatted.text, />structure</i);
    assert.match(formatted.text, new RegExp('<strong>upgraded</strong>'));
    assert.match(formatted.text, /owner/);
    assert.match(formatted.text, /data-steam-id="76561198963770601">Bols/);
    assert.match(formatted.text, /location 85412, -165099/);
    assert.doesNotMatch(formatted.text, /76561198963770601::854,-1651/);
  });

  it('adds location metadata whenever an activity event has save-cache coordinates', () => {
    const { feed } = loadActivityFeed();

    const formatted = feed.format({
      type: 'inventory_item_added',
      category: 'inventory',
      actor: 'Alice',
      actor_name: 'Alice',
      steam_id: '76561198000000001',
      item: 'Fork',
      amount: 1,
      pos_x: 1200.4,
      pos_y: -3400.6,
    });

    assert.match(formatted.text, /location 1200, -3401/);
  });

  it('renders SQLite UTC activity timestamps in the selected activity timezone', () => {
    const { feed } = loadActivityFeed();
    const rows: Array<{ innerHTML: string }> = [];
    const container = {
      innerHTML: '',
      appendChild: (item: { innerHTML: string }) => rows.push(item),
    };

    feed.render(
      container,
      [
        {
          type: 'inventory_item_added',
          actor: 'Alice',
          actor_name: 'Alice',
          steam_id: '76561198000000001',
          item: 'Fork',
          amount: 1,
          created_at: '2026-05-24 15:03:12',
        },
      ],
      false,
      false,
    );

    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.ok(row);
    assert.match(row.innerHTML, /2026-05-24T15:03:12\.000Z\|Asia\/Taipei/);
  });

  it('preserves sub-second precision when parsing SQLite UTC timestamps', () => {
    const { feed } = loadActivityFeed();
    const rows: Array<{ innerHTML: string }> = [];
    const container = {
      innerHTML: '',
      appendChild: (item: { innerHTML: string }) => rows.push(item),
    };

    feed.render(
      container,
      [
        {
          type: 'inventory_item_added',
          actor: 'Alice',
          actor_name: 'Alice',
          steam_id: '76561198000000001',
          item: 'Fork',
          amount: 1,
          created_at: '2026-05-24 15:03:12.789',
        },
      ],
      false,
      false,
    );

    assert.equal(rows.length, 1);
    assert.match(rows[0]?.innerHTML || '', /2026-05-24T15:03:12\.789Z\|Asia\/Taipei/);
  });

  it('keeps rendering the feed when a single event formatter throws', () => {
    const errors: unknown[][] = [];
    const { feed } = loadActivityFeed({
      t: (key: string) => {
        if (key === 'web:activity.picked_up') throw new Error('translator boom');
        return key.split('.').pop() || key;
      },
      consoleError: (...args: unknown[]) => errors.push(args),
    });
    const rows: Array<{ innerHTML: string }> = [];
    const container = {
      innerHTML: '',
      appendChild: (item: { innerHTML: string }) => rows.push(item),
    };

    feed.render(
      container,
      [
        {
          type: 'inventory_item_added',
          actor: 'Alice',
          actor_name: 'Alice',
          steam_id: '76561198000000001',
          item: 'Fork',
          amount: 1,
          created_at: '2026-05-24 15:03:12',
        },
      ],
      false,
      false,
    );

    assert.equal(rows.length, 1);
    assert.match(rows[0]?.innerHTML || '', /Alice — inventory_item_added/);
    assert.match(rows[0]?.innerHTML || '', /Fork/);
    assert.match(rows[0]?.innerHTML || '', /partial/);
    assert.equal(errors.length, 1);
    const firstLog = errors[0]?.[0];
    assert.equal(typeof firstLog, 'string');
    assert.match(firstLog as string, /failed to format activity event/);
  });
});

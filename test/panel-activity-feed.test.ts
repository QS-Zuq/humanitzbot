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

function loadActivityFeed(options: { t?: (key: string) => string; consoleError?: (...args: unknown[]) => void } = {}) {
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
  context.Panel = {
    core: {
      S: { activityTimeZone: 'Asia/Taipei' },
      $: () => null,
      el: () => ({ innerHTML: '', appendChild: () => undefined }),
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

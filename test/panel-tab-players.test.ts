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

function makeClassList(initial = '') {
  const classes = new Set(initial.split(/\s+/).filter(Boolean));
  return {
    add: (...names: string[]) => {
      names.forEach((name) => classes.add(name));
    },
    remove: (...names: string[]) => {
      names.forEach((name) => classes.delete(name));
    },
    contains: (name: string) => classes.has(name),
    toString: () => Array.from(classes).join(' '),
  };
}

function makeElement(initialClassName = '') {
  return {
    className: initialClassName,
    classList: makeClassList(initialClassName),
    innerHTML: '',
    style: {} as Record<string, string>,
    dataset: {} as Record<string, string>,
    removed: false,
    appendChild: () => undefined,
    remove() {
      this.removed = true;
    },
    getBoundingClientRect: () => ({ right: 240, top: 80, bottom: 220, width: 320, height: 160 }),
    querySelector: () => null,
    closest: (_selector: string) => null as ReturnType<typeof makeElement> | null,
  };
}

function loadPlayersTab() {
  const bodyChildren: Array<ReturnType<typeof makeElement>> = [];
  const elements = new Map<string, ReturnType<typeof makeElement>>([
    ['player-modal', makeElement('hidden')],
    ['player-modal-content', makeElement()],
  ]);
  const playerModal = elements.get('player-modal');
  const hiddenPlayersTab = makeElement('tab-content hidden');
  if (playerModal) {
    playerModal.closest = (selector: string) => (selector === '.tab-content' ? hiddenPlayersTab : null);
  }
  const context: Record<string, any> = {
    console,
    innerWidth: 1280,
    innerHeight: 720,
    i18next: {
      t: (_key: string, opts?: { defaultValue?: string }) => opts?.defaultValue || _key,
    },
    document: {
      createElement: () => makeElement(),
      querySelector: (selector: string) =>
        selector === '.item-popup' ? bodyChildren.find((child) => !child.removed) || null : null,
      body: {
        appendChild: (child: ReturnType<typeof makeElement>) => {
          bodyChildren.push(child);
        },
      },
    },
  };
  context.window = context;
  context.Panel = {
    core: {
      S: {
        currentServer: 'default',
        currentTab: 'players',
        players: [],
        toggles: {},
        playerSort: { col: 'online', dir: 'desc' },
        playerViewMode: 'table',
      },
      $: (selector: string) => (selector.startsWith('#') ? elements.get(selector.slice(1)) || null : null),
      el: () => ({ appendChild: () => undefined }),
      esc,
      apiFetch: () => Promise.resolve({ ok: false }),
      utils: {
        fmtNum: (n: unknown) => String(typeof n === 'number' || typeof n === 'string' ? n : 0),
        formatPlaytime: (n: unknown) => String(typeof n === 'number' || typeof n === 'string' ? n : 0),
        setTabUnavailable: () => undefined,
        entityLink: (name: string, type: string) =>
          '<span class="entity-link" data-entity-table="' +
          esc(type) +
          '" data-entity-search="' +
          esc(name) +
          '">' +
          esc(name) +
          '</span>',
      },
    },
    nav: {
      setBreadcrumbs: () => undefined,
      getTabLabels: () => ({ players: 'Players' }),
    },
    tabs: {},
  };

  vm.runInNewContext(readFileSync('src/web-map/public/js/panel-tab-players.js', 'utf8'), context, {
    filename: 'panel-tab-players.js',
  });

  return { playersTab: context.Panel.tabs.players, bodyChildren, elements };
}

describe('panel players tab', () => {
  it('adds a player activity log link filtered by Steam ID', () => {
    const { playersTab } = loadPlayersTab();

    const html = playersTab.buildPlayerDetail({
      name: 'Alice',
      steamId: '76561198000000001',
      profession: 'Farmer',
      male: true,
      health: 100,
      maxHealth: 100,
      hunger: 0,
      thirst: 0,
      stamina: 0,
      infection: 0,
      battery: 0,
      fatigue: 0,
      equipment: [],
      quickSlots: [],
      inventory: [],
      backpack: [],
      craftingRecipes: [],
      unlockedSkills: [],
    });

    assert.match(html, /class="activity-link[^"]*"/);
    assert.match(html, /data-search="76561198000000001"/);
    assert.match(html, /Activity log →/);
  });

  it('renders a compact player popup with detail and activity actions', async () => {
    const { playersTab, bodyChildren } = loadPlayersTab();
    const trigger = { getBoundingClientRect: () => ({ right: 100, top: 40 }) };

    await playersTab.showPlayerPopup(trigger, {
      name: 'Alice',
      steamId: '76561198000000001',
      isOnline: true,
      level: 7,
      clanName: 'CAT',
      clanRank: 'Leader',
      profession: 'Farmer',
    });

    const popup = bodyChildren.find((child) => !child.removed);
    assert.ok(popup);
    assert.match(popup.className, /item-popup/);
    assert.match(popup.className, /player-popup/);
    assert.match(popup.innerHTML, /Alice/);
    assert.match(popup.innerHTML, /data-mode="player"/);
    assert.match(popup.innerHTML, /data-steam-id="76561198000000001"/);
    assert.match(popup.innerHTML, /player-detail-link/);
    assert.match(popup.innerHTML, /Steam profile/);
  });

  it('opens the full player details modal from compact popup cache', async () => {
    const { playersTab, bodyChildren, elements } = loadPlayersTab();
    const trigger = { getBoundingClientRect: () => ({ right: 100, top: 40 }) };
    const steamId = '76561198000000001';

    await playersTab.showPlayerPopup(trigger, {
      name: 'Alice',
      steamId,
      isOnline: true,
      level: 7,
      clanName: 'CAT',
      clanRank: 'Leader',
      profession: 'Farmer',
      male: true,
      equipment: [],
      quickSlots: [],
      inventory: [],
      backpackItems: [],
      craftingRecipes: [],
      unlockedSkills: [],
    });

    const playerModal = elements.get('player-modal');
    assert.ok(playerModal);
    assert.equal(await playersTab.showPlayerDetails(steamId), true);
    assert.ok(bodyChildren.includes(playerModal));
    assert.equal(playerModal.classList.contains('hidden'), false);
    assert.equal(elements.get('player-modal-content')?.dataset.steamId, steamId);
    assert.match(elements.get('player-modal-content')?.innerHTML || '', /Alice/);
  });
});

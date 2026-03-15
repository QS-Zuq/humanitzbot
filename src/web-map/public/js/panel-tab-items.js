/**
 * Panel Tab: Items — item tracking, fingerprint search, and item popup.
 * @namespace Panel.tabs.items
 */
window.Panel = window.Panel || {};
Panel.tabs = Panel.tabs || {};

(function () {
  'use strict';

  const S = Panel.core.S;
  const $ = Panel.core.$;
  const $$ = Panel.core.$$;
  const esc = Panel.core.esc;
  const apiFetch = Panel.core.apiFetch;
  const switchTab = Panel.nav.switchTab;

  let _inited = false;
  let _itemsData = { instances: [], groups: [], locations: [], counts: {} };
  let _itemsMovements = [];

  function init() {
    if (_inited) return;
    _inited = true;

    // Wire up event handlers
    const searchInput = $('#items-search');
    if (searchInput) {
      let debounceTimer = null;
      searchInput.addEventListener('input', function () {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(function () {
          if (S.currentTab === 'items') loadItems();
        }, 300);
      });
    }
    const viewSelect = $('#items-view');
    if (viewSelect)
      viewSelect.addEventListener('change', function () {
        if (S.currentTab === 'items') loadItems();
      });
    const locFilter = $('#items-location-filter');
    if (locFilter)
      locFilter.addEventListener('change', function () {
        if (S.currentTab === 'items') loadItems();
      });
    const closeBtn = $('#item-detail-close');
    if (closeBtn)
      closeBtn.addEventListener('click', function () {
        $('#item-detail-modal').classList.add('hidden');
      });
    const modal = $('#item-detail-modal');
    if (modal)
      modal.addEventListener('click', function (e) {
        if (e.target === modal) modal.classList.add('hidden');
      });
  }

  // ── Data Loading ────────────────────────────────────────────────

  async function loadItems() {
    try {
      let search = ($('#items-search') ? $('#items-search').value : '').trim();
      const view = $('#items-view') ? $('#items-view').value : 'all';

      let url = '/api/panel/items?limit=500';
      if (search) url += '&search=' + encodeURIComponent(search);
      const locFilter = $('#items-location-filter') ? $('#items-location-filter').value : '';
      if (locFilter) {
        const parts = locFilter.split('|');
        url += '&locationType=' + encodeURIComponent(parts[0]) + '&locationId=' + encodeURIComponent(parts[1]);
      }

      const resp = await apiFetch(url);
      _itemsData = await resp.json();

      const movResp = await apiFetch('/api/panel/movements?limit=50');
      const movData = await movResp.json();
      _itemsMovements = movData.movements || [];

      const uc = $('#items-unique-count');
      if (uc) uc.textContent = _itemsData.counts?.instances ?? _itemsData.instances.length;
      const gc = $('#items-group-count');
      if (gc) gc.textContent = _itemsData.counts?.groups ?? _itemsData.groups.length;
      const lc = $('#items-location-count');
      if (lc) lc.textContent = _itemsData.locations?.length ?? '-';
      const mc = $('#items-movement-count');
      if (mc) mc.textContent = _itemsMovements.length;

      const locSelect = $('#items-location-filter');
      if (locSelect && locSelect.options.length <= 1 && _itemsData.locations) {
        _itemsData.locations.sort(function (a, b) {
          return (a.type + a.id).localeCompare(b.type + b.id);
        });
        for (let i = 0; i < _itemsData.locations.length; i++) {
          const loc = _itemsData.locations[i];
          const opt = document.createElement('option');
          opt.value = loc.type + '|' + loc.id;
          opt.textContent = _formatLocationType(loc.type) + ': ' + _shortenId(loc.id) + ' (' + loc.totalItems + ')';
          locSelect.appendChild(opt);
        }
      }

      const container = $('#items-content');
      if (!container) return;

      if (view === 'movements') {
        _renderMovements(container, _itemsMovements);
      } else if (view === 'instances') {
        _renderItemTable(container, _itemsData.instances, 'instance');
      } else if (view === 'groups') {
        _renderGroupTable(container, _itemsData.groups);
      } else {
        _renderCombinedView(container, _itemsData);
      }
    } catch (err) {
      console.error('Failed to load items:', err);
      const c = $('#items-content');
      if (c)
        c.innerHTML =
          '<div class="text-xs text-horde">' +
          i18next.t('web:empty_states.failed_to_load_item_data', { defaultValue: 'Failed to load item data' }) +
          '</div>';
    }
  }

  // ── Rendering ───────────────────────────────────────────────────

  function _renderCombinedView(container, data) {
    let html = '';

    if (data.groups.length > 0) {
      html +=
        '<div class="card"><h3 class="card-title">' +
        i18next.t('web:items.fungible_groups') +
        ' <span class="text-xs text-muted font-normal">(' +
        data.groups.length +
        ')</span></h3>';
      html += '<div class="overflow-x-auto"><table class="w-full text-xs">';
      html +=
        '<thead><tr class="text-muted text-left border-b border-border"><th class="px-2 py-1.5">' +
        i18next.t('web:table.item', { defaultValue: 'Item' }) +
        '</th><th class="px-2 py-1.5">' +
        i18next.t('web:table.qty', { defaultValue: 'Qty' }) +
        '</th><th class="px-2 py-1.5">' +
        i18next.t('web:table.stack', { defaultValue: 'Stack' }) +
        '</th><th class="px-2 py-1.5">' +
        i18next.t('web:table.location', { defaultValue: 'Location' }) +
        '</th><th class="px-2 py-1.5">' +
        i18next.t('web:table.fingerprint', { defaultValue: 'Fingerprint' }) +
        '</th><th class="px-2 py-1.5">' +
        i18next.t('web:table.last_seen', { defaultValue: 'Last Seen' }) +
        '</th><th class="px-2 py-1.5"></th></tr></thead><tbody>';
      for (let i = 0; i < data.groups.length; i++) {
        const g = data.groups[i];
        html += '<tr class="border-b border-border/30 hover:bg-surface-50/50">';
        html += '<td class="px-2 py-1.5 text-white font-medium">' + esc(g.item) + '</td>';
        html += '<td class="px-2 py-1.5"><span class="text-surge font-mono">' + g.quantity + '×</span></td>';
        html += '<td class="px-2 py-1.5 text-muted">' + (g.stack_size || 1) + '</td>';
        html += '<td class="px-2 py-1.5">' + _locationBadge(g.location_type, g.location_id, g.location_slot) + '</td>';
        html +=
          '<td class="px-2 py-1.5 font-mono text-[10px]"><span class="text-emerald-400 cursor-pointer hover:underline fp-track-link" data-fp="' +
          esc(g.fingerprint) +
          '" data-item="' +
          esc(g.item) +
          '" title="' +
          i18next.t('web:items.track_item', { defaultValue: 'Track this item' }) +
          '">' +
          esc(g.fingerprint) +
          '</span></td>';
        html += '<td class="px-2 py-1.5 text-muted">' + _timeAgo(g.last_seen) + '</td>';
        html +=
          '<td class="px-2 py-1.5"><button class="text-accent hover:text-accent-hover text-[10px] item-grp-detail" data-id="' +
          g.id +
          '">' +
          i18next.t('web:items.history', { defaultValue: 'History' }) +
          '</button></td>';
        html += '</tr>';
      }
      html += '</tbody></table></div></div>';
    }

    if (data.instances.length > 0) {
      html +=
        '<div class="card"><h3 class="card-title">' +
        i18next.t('web:items.unique_items') +
        ' <span class="text-xs text-muted font-normal">(' +
        data.instances.length +
        ')</span></h3>';
      html += _buildInstanceTable(data.instances);
      html += '</div>';
    }

    if (_itemsMovements.length > 0) {
      html +=
        '<div class="card"><h3 class="card-title">' +
        i18next.t('web:items.recent_movements') +
        ' <span class="text-xs text-muted font-normal">(' +
        i18next.t('web:items.last_n', { count: 50, defaultValue: 'last {{count}}' }) +
        ')</span></h3>';
      html += _buildMovementList(_itemsMovements);
      html += '</div>';
    }

    if (!data.groups.length && !data.instances.length) {
      html =
        '<div class="text-sm text-muted py-8 text-center">' +
        i18next.t('web:empty_states.no_tracked_items_found') +
        '</div>';
    }

    container.innerHTML = html;
    _bindItemDetailHandlers();
  }

  function _renderItemTable(container, instances, _type) {
    if (!instances.length) {
      container.innerHTML =
        '<div class="text-sm text-muted py-8 text-center">' +
        i18next.t('web:empty_states.no_unique_items_found') +
        '</div>';
      return;
    }
    container.innerHTML = '<div class="card">' + _buildInstanceTable(instances) + '</div>';
    _bindItemDetailHandlers();
  }

  function _renderGroupTable(container, groups) {
    if (!groups.length) {
      container.innerHTML =
        '<div class="text-sm text-muted py-8 text-center">' +
        i18next.t('web:empty_states.no_fungible_groups_found') +
        '</div>';
      return;
    }
    _renderCombinedView(container, { groups: groups, instances: [], locations: [] });
  }

  function _renderMovements(container, movements) {
    if (!movements.length) {
      container.innerHTML =
        '<div class="text-sm text-muted py-8 text-center">' +
        i18next.t('web:empty_states.no_movements_recorded_yet') +
        '</div>';
      return;
    }
    container.innerHTML =
      '<div class="card"><h3 class="card-title">' +
      i18next.t('web:items.movements') +
      '</h3>' +
      _buildMovementList(movements) +
      '</div>';
  }

  function _buildInstanceTable(instances) {
    let html = '<div class="overflow-x-auto"><table class="w-full text-xs">';
    html +=
      '<thead><tr class="text-muted text-left border-b border-border"><th class="px-2 py-1.5">' +
      i18next.t('web:table.item', { defaultValue: 'Item' }) +
      '</th><th class="px-2 py-1.5">' +
      i18next.t('web:table.amount', { defaultValue: 'Amt' }) +
      '</th><th class="px-2 py-1.5">' +
      i18next.t('web:table.durability', { defaultValue: 'Durability' }) +
      '</th><th class="px-2 py-1.5">' +
      i18next.t('web:table.location', { defaultValue: 'Location' }) +
      '</th><th class="px-2 py-1.5">' +
      i18next.t('web:table.fingerprint', { defaultValue: 'Fingerprint' }) +
      '</th><th class="px-2 py-1.5">' +
      i18next.t('web:table.last_seen', { defaultValue: 'Last Seen' }) +
      '</th><th class="px-2 py-1.5"></th></tr></thead><tbody>';
    for (let i = 0; i < instances.length; i++) {
      const inst = instances[i];
      const durPct =
        inst.max_dur > 0
          ? Math.round((inst.durability / inst.max_dur) * 100)
          : inst.durability > 0
            ? Math.round(inst.durability * 100)
            : 0;
      const durColor = durPct > 60 ? 'text-calm' : durPct > 25 ? 'text-surge' : 'text-horde';
      html += '<tr class="border-b border-border/30 hover:bg-surface-50/50">';
      html +=
        '<td class="px-2 py-1.5 text-white font-medium">' +
        esc(inst.item) +
        (inst.ammo ? ' <span class="text-muted">(' + inst.ammo + ')</span>' : '') +
        '</td>';
      html += '<td class="px-2 py-1.5">' + (inst.amount || 1) + '</td>';
      html += '<td class="px-2 py-1.5 ' + durColor + ' font-mono">' + durPct + '%</td>';
      html +=
        '<td class="px-2 py-1.5">' + _locationBadge(inst.location_type, inst.location_id, inst.location_slot) + '</td>';
      html +=
        '<td class="px-2 py-1.5 font-mono text-[10px]"><span class="text-emerald-400 cursor-pointer hover:underline fp-track-link" data-fp="' +
        esc(inst.fingerprint) +
        '" data-item="' +
        esc(inst.item) +
        '" title="' +
        i18next.t('web:items.track_item', { defaultValue: 'Track this item' }) +
        '">' +
        esc(inst.fingerprint) +
        '</span></td>';
      html += '<td class="px-2 py-1.5 text-muted">' + _timeAgo(inst.last_seen) + '</td>';
      html +=
        '<td class="px-2 py-1.5"><button class="text-accent hover:text-accent-hover text-[10px] item-inst-detail" data-id="' +
        inst.id +
        '">' +
        i18next.t('web:items.history', { defaultValue: 'History' }) +
        '</button></td>';
      html += '</tr>';
    }
    html += '</tbody></table></div>';
    return html;
  }

  function _buildMovementList(movements) {
    let html = '<div class="space-y-1 max-h-96 overflow-y-auto">';
    for (let i = 0; i < movements.length; i++) {
      const m = movements[i];
      const icon = m.move_type === 'group_transfer' ? '⇄' : m.move_type === 'move' ? '→' : '↔';
      const typeLabel =
        m.move_type === 'group_transfer'
          ? '<span class="text-surge">group</span>'
          : '<span class="text-accent">move</span>';
      html += '<div class="flex items-center gap-2 text-xs py-1 border-b border-border/20">';
      html += '<span class="text-muted w-20 shrink-0">' + _timeAgo(m.created_at) + '</span>';
      html += '<span class="font-medium">' + icon + '</span>';
      html += '<span class="text-white">' + esc(m.item) + '</span>';
      html += '<span class="text-muted">×' + (m.amount || 1) + '</span>';
      html += '<span class="text-muted">from</span>' + _locationBadge(m.from_type, m.from_id, m.from_slot);
      html += '<span class="text-muted">to</span>' + _locationBadge(m.to_type, m.to_id, m.to_slot);
      if (m.attributed_name) {
        const attrSid = m.attributed_steam_id || '';
        if (attrSid) {
          html +=
            '<span class="text-calm ml-auto player-link cursor-pointer hover:underline" data-steam-id="' +
            esc(attrSid) +
            '">by ' +
            esc(m.attributed_name) +
            '</span>';
        } else {
          html += '<span class="text-calm ml-auto">by ' + esc(m.attributed_name) + '</span>';
        }
      }
      html += '<span class="ml-auto">' + typeLabel + '</span>';
      html += '</div>';
    }
    html += '</div>';
    return html;
  }

  // ── Location Helpers ────────────────────────────────────────────

  function _locationBadge(type, id, slot) {
    const colors = {
      player: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
      container: 'bg-purple-500/15 text-purple-400 border-purple-500/30',
      vehicle: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
      horse: 'bg-pink-500/15 text-pink-400 border-pink-500/30',
      structure: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
      world_drop: 'bg-gray-500/15 text-gray-400 border-gray-500/30',
      backpack: 'bg-orange-500/15 text-orange-400 border-orange-500/30',
      global_container: 'bg-indigo-500/15 text-indigo-400 border-indigo-500/30',
    };
    const cls = colors[type] || 'bg-surface-50 text-muted border-border';
    let label = _formatLocationType(type) + ': ' + _resolveLocationLabel(type, id);
    if (slot && slot !== 'items' && slot !== 'ground') label += ' (' + slot + ')';

    if (type === 'player' && id && /^\d{17}$/.test(id)) {
      return (
        '<span class="inline-flex px-1.5 py-0.5 rounded text-[10px] border cursor-pointer hover:brightness-125 player-link ' +
        cls +
        '" data-steam-id="' +
        esc(id) +
        '">' +
        esc(label) +
        '</span>'
      );
    }

    if ((type === 'container' || type === 'vehicle' || type === 'structure' || type === 'horse') && id) {
      const entityTable = type === 'horse' ? 'world_horses' : type + 's';
      return (
        '<span class="inline-flex px-1.5 py-0.5 rounded text-[10px] border cursor-pointer hover:brightness-125 entity-link ' +
        cls +
        '" data-entity-table="' +
        entityTable +
        '" data-entity-search="' +
        esc(id) +
        '">' +
        esc(label) +
        '</span>'
      );
    }
    return '<span class="inline-flex px-1.5 py-0.5 rounded text-[10px] border ' + cls + '">' + esc(label) + '</span>';
  }

  function _formatLocationType(type) {
    const map = {
      player: i18next.t('web:location_type.player'),
      container: i18next.t('web:location_type.container'),
      vehicle: i18next.t('web:location_type.vehicle'),
      horse: i18next.t('web:location_type.horse'),
      structure: i18next.t('web:location_type.structure'),
      world_drop: i18next.t('web:location_type.world'),
      backpack: i18next.t('web:location_type.backpack'),
      global_container: i18next.t('web:location_type.global'),
    };
    return map[type] || type;
  }

  function _resolveLocationLabel(type, id) {
    if (!id) return '?';
    if (type === 'player' && /^\d{17}$/.test(id)) {
      const p = S.players.find(function (pl) {
        return pl.steamId === id;
      });
      if (p && p.name) return p.name;
      return '\u2026' + id.slice(-6);
    }
    return _shortenId(id);
  }

  function _shortenId(id) {
    if (!id) return '?';
    if (/^\d{17}$/.test(id)) return '…' + id.slice(-6);
    if (id.startsWith('pickup_') || id.startsWith('backpack_')) {
      const parts = id.split('_');
      return parts[0] + ' @' + parts.slice(1).join(',');
    }
    if (id.length > 24) return id.slice(0, 20) + '…';
    return id;
  }

  function _timeAgo(dateStr) {
    if (!dateStr) return '-';
    const d = new Date(dateStr + 'Z');
    const now = Date.now();
    const diff = Math.max(0, now - d.getTime());
    if (diff < 60000) return 'now';
    if (diff < 3600000) return Math.floor(diff / 60000) + 'm';
    if (diff < 86400000) return Math.floor(diff / 3600000) + 'h';
    return Math.floor(diff / 86400000) + 'd';
  }

  // ── Detail Handlers ─────────────────────────────────────────────

  function _bindItemDetailHandlers() {
    $$('.item-inst-detail').forEach(function (btn) {
      btn.addEventListener('click', function () {
        _showItemDetail('instance', parseInt(btn.dataset.id, 10));
      });
    });
    $$('.item-grp-detail').forEach(function (btn) {
      btn.addEventListener('click', function () {
        _showItemDetail('group', parseInt(btn.dataset.id, 10));
      });
    });
    // Fingerprint → Activity tracker navigation
    $$('.fp-track-link').forEach(function (fpEl) {
      fpEl.addEventListener('click', function () {
        const fpHash = fpEl.dataset.fp;
        const fpItem = fpEl.dataset.item;
        if (fpHash && fpItem) {
          const searchEl = $('#activity-search');
          if (searchEl) searchEl.value = fpItem + '#' + fpHash;
          switchTab('activity');
          setTimeout(function () {
            if (Panel.shared.activityFeed) Panel.shared.activityFeed.resetPaging();
            if (Panel.tabs.activity && Panel.tabs.activity.loadActivity) Panel.tabs.activity.loadActivity();
          }, 100);
        }
      });
    });
  }

  async function _showItemDetail(type, id) {
    const modal = $('#item-detail-modal');
    const content = $('#item-detail-content');
    if (!modal || !content) return;

    content.innerHTML =
      '<div class="text-muted text-sm">' + i18next.t('web:loading.generic', { defaultValue: 'Loading...' }) + '</div>';
    modal.classList.remove('hidden');

    try {
      const url = type === 'group' ? '/api/panel/groups/' + id : '/api/panel/items/' + id + '/movements';
      const resp = await apiFetch(url);
      const data = await resp.json();

      let html = '';

      if (type === 'group') {
        const g = data.group;
        html +=
          '<h2 class="text-lg font-semibold text-white mb-1">' +
          esc(g.item) +
          ' <span class="text-surge">×' +
          g.quantity +
          '</span></h2>';
        html +=
          '<div class="text-xs text-muted mb-4">' +
          i18next.t('web:item_detail.fungible_group', { id: g.id, defaultValue: 'Fungible Group #{{id}}' }) +
          ' · ' +
          i18next.t('web:table.fingerprint', { defaultValue: 'Fingerprint' }) +
          ': <span class="font-mono">' +
          esc(g.fingerprint) +
          '</span></div>';
        html += '<div class="grid grid-cols-2 gap-2 mb-4 text-xs">';
        html +=
          '<div><span class="text-muted">' +
          i18next.t('web:table.location', { defaultValue: 'Location' }) +
          ':</span> ' +
          _locationBadge(g.location_type, g.location_id, g.location_slot) +
          '</div>';
        html +=
          '<div><span class="text-muted">' +
          i18next.t('web:table.stack', { defaultValue: 'Stack' }) +
          ':</span> ' +
          (g.stack_size || 1) +
          '</div>';
        html +=
          '<div><span class="text-muted">' +
          i18next.t('web:table.first_seen', { defaultValue: 'First seen' }) +
          ':</span> ' +
          (g.first_seen || '-') +
          '</div>';
        html +=
          '<div><span class="text-muted">' +
          i18next.t('web:table.last_seen', { defaultValue: 'Last seen' }) +
          ':</span> ' +
          (g.last_seen || '-') +
          '</div>';
        html += '</div>';
      } else {
        const inst = data.instance;
        const durPct =
          inst.max_dur > 0
            ? Math.round((inst.durability / inst.max_dur) * 100)
            : inst.durability > 0
              ? Math.round(inst.durability * 100)
              : 0;
        html += '<h2 class="text-lg font-semibold text-white mb-1">' + esc(inst.item) + '</h2>';
        html +=
          '<div class="text-xs text-muted mb-4">' +
          i18next.t('web:item_detail.instance', { id: inst.id, defaultValue: 'Instance #{{id}}' }) +
          ' · ' +
          i18next.t('web:table.fingerprint', { defaultValue: 'Fingerprint' }) +
          ': <span class="font-mono">' +
          esc(inst.fingerprint) +
          '</span></div>';
        html += '<div class="grid grid-cols-2 gap-2 mb-4 text-xs">';
        html +=
          '<div><span class="text-muted">' +
          i18next.t('web:table.location', { defaultValue: 'Location' }) +
          ':</span> ' +
          _locationBadge(inst.location_type, inst.location_id, inst.location_slot) +
          '</div>';
        html +=
          '<div><span class="text-muted">' +
          i18next.t('web:table.durability', { defaultValue: 'Durability' }) +
          ':</span> ' +
          durPct +
          '%</div>';
        if (inst.ammo)
          html +=
            '<div><span class="text-muted">' +
            i18next.t('web:table.ammo', { defaultValue: 'Ammo' }) +
            ':</span> ' +
            inst.ammo +
            '</div>';
        html +=
          '<div><span class="text-muted">' +
          i18next.t('web:table.amount', { defaultValue: 'Amount' }) +
          ':</span> ' +
          (inst.amount || 1) +
          '</div>';
        html +=
          '<div><span class="text-muted">' +
          i18next.t('web:table.first_seen', { defaultValue: 'First seen' }) +
          ':</span> ' +
          (inst.first_seen || '-') +
          '</div>';
        html +=
          '<div><span class="text-muted">' +
          i18next.t('web:table.last_seen', { defaultValue: 'Last seen' }) +
          ':</span> ' +
          (inst.last_seen || '-') +
          '</div>';
        html += '</div>';
      }

      const movements = data.movements || [];
      if (movements.length > 0) {
        html +=
          '<h3 class="text-sm font-semibold text-white mb-2">' +
          i18next.t('web:item_detail.movement_history', {
            count: movements.length,
            defaultValue: 'Movement History ({{count}})',
          }) +
          '</h3>';
        html += '<div class="space-y-1 max-h-80 overflow-y-auto">';
        for (let i = 0; i < movements.length; i++) {
          const m = movements[i];
          html += '<div class="flex items-center gap-2 text-xs py-1.5 border-b border-border/20">';
          html += '<span class="text-muted w-32 shrink-0 font-mono text-[10px]">' + esc(m.created_at || '') + '</span>';
          html += '<span class="text-white">' + (m.move_type || 'move') + '</span>';
          html += '<span class="text-muted">×' + (m.amount || 1) + '</span>';
          html += _locationBadge(m.from_type, m.from_id, m.from_slot);
          html += '<span class="text-muted">→</span>';
          html += _locationBadge(m.to_type, m.to_id, m.to_slot);
          if (m.attributed_name) {
            const attrSteamId = m.attributed_steam_id || '';
            if (attrSteamId) {
              html +=
                '<span class="text-calm ml-auto player-link cursor-pointer hover:underline" data-steam-id="' +
                esc(attrSteamId) +
                '">' +
                esc(m.attributed_name) +
                '</span>';
            } else {
              html += '<span class="text-calm ml-auto">' + esc(m.attributed_name) + '</span>';
            }
          }
          html += '</div>';
        }
        html += '</div>';
      } else {
        html +=
          '<div class="text-xs text-muted mt-4">' +
          i18next.t('web:empty_states.no_movement_history_recorded') +
          '</div>';
      }

      content.innerHTML = html;
    } catch (err) {
      content.innerHTML =
        '<div class="text-horde text-sm">' +
        i18next.t('web:item_detail.failed_to_load_details', {
          message: esc(err.message),
          defaultValue: 'Failed to load details: {{message}}',
        }) +
        '</div>';
    }
  }

  // ── Item Popup (showItemPopup) ──────────────────────────────────
  // This is the inventory item popup used from player detail views.
  // The full showItemPopup, _fetchItemTrackingData, _locationBadgeMini,
  // countItemInPlayer functions are kept in panel.js for now since they
  // are tightly coupled with the dashboard/player context and will be
  // extracted in Phase 5 with the dashboard.

  function reset() {
    _inited = false;
  }

  Panel.tabs.items = {
    init: init,
    load: loadItems,
    reset: reset,
    showFingerprintTracker: function (n, f) {
      if (Panel.tabs.activity && Panel.tabs.activity.showFingerprintTracker) {
        Panel.tabs.activity.showFingerprintTracker(n, f);
      }
    },
    hideFingerprintTracker: function () {
      if (Panel.tabs.activity && Panel.tabs.activity.hideFingerprintTracker) {
        Panel.tabs.activity.hideFingerprintTracker();
      }
    },
  };
})();

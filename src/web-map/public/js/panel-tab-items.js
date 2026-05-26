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
  const esc = Panel.core.esc;
  const apiFetch = Panel.core.apiFetch;
  const switchTab = Panel.nav.switchTab;
  const ITEMS_PAGE_SIZE = 100;
  const LOCATIONS_PAGE_SIZE = 100;

  let _inited = false;
  let _itemsData = { instances: [], groups: [], locations: [], counts: {}, pagination: {} };
  let _itemsMovements = [];
  let _itemsOffset = 0;
  let _itemsHasMoreInstances = false;
  let _itemsHasMoreGroups = false;
  let _itemsLoadSeq = 0;
  let _itemsPageLoading = false;
  let _locationsLoaded = false;
  let _locationsLoading = false;

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
          if (S.currentTab === 'items') loadItems({ reset: true });
        }, 300);
      });
    }
    const viewSelect = $('#items-view');
    if (viewSelect)
      viewSelect.addEventListener('change', function () {
        if (S.currentTab === 'items') loadItems({ reset: true });
      });
    const locFilter = $('#items-location-filter');
    if (locFilter) {
      locFilter.addEventListener('change', function () {
        if (S.currentTab === 'items') loadItems({ reset: true });
      });
      locFilter.addEventListener('focus', function () {
        _loadLocationOptions();
      });
      locFilter.addEventListener('mousedown', function () {
        _loadLocationOptions();
      });
    }
    const content = $('#items-content');
    if (content) content.addEventListener('click', _handleItemsContentClick);
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

  async function loadItems(options) {
    const reset = !options || options.reset !== false;
    const view = _getItemsView();
    const loadSeq = ++_itemsLoadSeq;
    if (reset) {
      _itemsOffset = 0;
      _itemsHasMoreInstances = false;
      _itemsHasMoreGroups = false;
      _itemsData = { instances: [], groups: [], locations: _itemsData.locations || [], counts: {}, pagination: {} };
      _itemsMovements = [];
      _setItemCountersLoading();
      _renderItemsShell(view);
    }

    const pending = [_loadRecentMovements(loadSeq)];
    if (view !== 'movements') pending.push(_loadItemPage({ reset: reset, loadSeq: loadSeq, view: view }));
    await Promise.allSettled(pending);
  }

  function _getItemsView() {
    const value = $('#items-view') ? $('#items-view').value : 'all';
    return value === 'instances' || value === 'groups' || value === 'movements' ? value : 'all';
  }

  function _getItemQueryParams(view) {
    const params = new URLSearchParams();
    params.set('limit', String(ITEMS_PAGE_SIZE));
    params.set('offset', String(_itemsOffset));
    params.set('view', view === 'movements' ? 'all' : view);
    const search = ($('#items-search') ? $('#items-search').value : '').trim();
    if (search) params.set('search', search);
    const locFilter = $('#items-location-filter') ? $('#items-location-filter').value : '';
    if (locFilter) {
      const parts = locFilter.split('|');
      if (parts[0] && parts[1]) {
        params.set('locationType', parts[0]);
        params.set('locationId', parts[1]);
      }
    }
    return params;
  }

  async function _parseItemResponse(resp) {
    let data;
    try {
      data = await resp.json();
    } catch (err) {
      if (resp && resp.ok === false)
        throw new Error('HTTP ' + (resp.status || 'error') + ': invalid JSON response', { cause: err });
      throw err;
    }
    if (resp && resp.ok === false) {
      const message = (data && (data.error || data.message || data.code)) || 'HTTP ' + (resp.status || 'error');
      throw new Error(String(message));
    }
    return data || {};
  }

  async function _loadRecentMovements(loadSeq) {
    _renderRecentMovementsLoading();
    try {
      const movResp = await apiFetch('/api/panel/movements?limit=50');
      const movData = await _parseItemResponse(movResp);
      if (loadSeq !== _itemsLoadSeq) return;
      _itemsMovements = movData.movements || [];
      const mc = $('#items-movement-count');
      if (mc) mc.textContent = _itemsMovements.length;
      _renderRecentMovements();
    } catch (err) {
      if (loadSeq !== _itemsLoadSeq) return;
      console.error('Failed to load item movements:', err);
      _renderRecentMovementsError();
    }
  }

  async function _loadItemPage(opts) {
    const view = opts.view;
    const target = $('#items-list');
    let failed = false;
    _itemsPageLoading = true;
    if (!opts.reset) _renderItemsList(view);
    try {
      const resp = await apiFetch('/api/panel/items?' + _getItemQueryParams(view).toString());
      const data = await _parseItemResponse(resp);
      if (opts.loadSeq !== _itemsLoadSeq) return;
      const instances = data.instances || [];
      const groups = data.groups || [];
      _itemsData = {
        instances: opts.reset ? instances : _itemsData.instances.concat(instances),
        groups: opts.reset ? groups : _itemsData.groups.concat(groups),
        locations: _itemsData.locations || [],
        counts: data.counts || {},
        pagination: data.pagination || {},
      };
      _itemsHasMoreInstances = !!data.pagination?.hasMoreInstances;
      _itemsHasMoreGroups = !!data.pagination?.hasMoreGroups;
      _itemsOffset = data.pagination?.nextOffset ?? _itemsOffset + ITEMS_PAGE_SIZE;
      _updateItemCounters();
      _renderItemsList(view);
    } catch (err) {
      if (opts.loadSeq !== _itemsLoadSeq) return;
      failed = true;
      console.error('Failed to load items:', err);
      if (target)
        target.innerHTML =
          '<div class="card"><div class="text-xs text-horde">' +
          i18next.t('web:empty_states.failed_to_load_item_data', { defaultValue: 'Failed to load item data' }) +
          '</div></div>';
    } finally {
      if (opts.loadSeq === _itemsLoadSeq) {
        _itemsPageLoading = false;
        if (view !== 'movements' && !failed) _renderItemsList(view);
      }
    }
  }

  async function _loadLocationOptions() {
    if (_locationsLoaded || _locationsLoading) return;
    _locationsLoading = true;
    try {
      const resp = await apiFetch('/api/panel/items/locations?limit=' + LOCATIONS_PAGE_SIZE);
      const data = await _parseItemResponse(resp);
      _itemsData.locations = data.locations || [];
      _locationsLoaded = true;
      _populateLocationOptions(data.pagination);
    } catch (err) {
      console.error('Failed to load item locations:', err);
      _renderLocationOptionsError();
    } finally {
      _locationsLoading = false;
    }
  }

  function _renderLocationOptionsError() {
    const locSelect = $('#items-location-filter');
    if (locSelect) {
      const hasErrorOption = Array.from(locSelect.options || []).some(function (opt) {
        return opt.dataset && opt.dataset.itemsLoadError === 'true';
      });
      if (!hasErrorOption) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.disabled = true;
        opt.dataset.itemsLoadError = 'true';
        opt.textContent = i18next.t('web:empty_states.failed_to_load_item_data', {
          defaultValue: 'Failed to load item data',
        });
        locSelect.appendChild(opt);
      }
    }
    const lc = $('#items-location-count');
    if (lc) lc.textContent = '!';
  }

  function _populateLocationOptions(pagination) {
    const locSelect = $('#items-location-filter');
    if (!locSelect) return;
    const selected = locSelect.value;
    locSelect.innerHTML =
      '<option value="">' + i18next.t('web:items.all_locations', { defaultValue: 'All Locations' }) + '</option>';
    const locations = (_itemsData.locations || []).slice().sort(function (a, b) {
      return (a.type + a.id).localeCompare(b.type + b.id);
    });
    for (let i = 0; i < locations.length; i++) {
      const loc = locations[i];
      const opt = document.createElement('option');
      opt.value = loc.type + '|' + loc.id;
      opt.textContent = _formatLocationType(loc.type) + ': ' + _shortenId(loc.id) + ' (' + loc.totalItems + ')';
      locSelect.appendChild(opt);
    }
    if (
      selected &&
      !Array.from(locSelect.options).some(function (opt) {
        return opt.value === selected;
      })
    ) {
      const opt = document.createElement('option');
      opt.value = selected;
      const parts = selected.split('|');
      opt.textContent = parts.length === 2 ? _formatLocationType(parts[0]) + ': ' + _shortenId(parts[1]) : selected;
      locSelect.appendChild(opt);
    }
    locSelect.value = selected || '';
    const lc = $('#items-location-count');
    if (lc) lc.textContent = String(locations.length) + (pagination?.hasMore ? '+' : '');
  }

  function _setItemCountersLoading() {
    const uc = $('#items-unique-count');
    if (uc) uc.textContent = '…';
    const gc = $('#items-group-count');
    if (gc) gc.textContent = '…';
    const mc = $('#items-movement-count');
    if (mc) mc.textContent = '…';
  }

  function _updateItemCounters() {
    const uc = $('#items-unique-count');
    if (uc) uc.textContent = _itemsData.counts?.instances ?? _itemsData.instances.length;
    const gc = $('#items-group-count');
    if (gc) gc.textContent = _itemsData.counts?.groups ?? _itemsData.groups.length;
  }

  // ── Rendering ───────────────────────────────────────────────────

  function _renderItemsShell(view) {
    const container = $('#items-content');
    if (!container) return;
    container.innerHTML =
      '<div id="items-recent-movements">' +
      _buildLoadingCard(
        'items-recent-loading',
        i18next.t('web:items.recent_movements', { defaultValue: 'Recent Movements' }),
      ) +
      '</div>' +
      (view === 'movements'
        ? ''
        : '<div id="items-list" class="space-y-2">' +
          _buildLoadingCard('items-loading', i18next.t('web:loading.generic', { defaultValue: 'Loading...' })) +
          '</div>');
  }

  function _buildLoadingCard(id, label) {
    return (
      '<div id="' +
      id +
      '" class="card" role="status" aria-live="polite">' +
      '<div class="flex items-center gap-2 text-xs text-muted">' +
      '<span class="inline-block h-3 w-3 rounded-full border-2 border-accent border-t-transparent animate-spin"></span>' +
      '<span>' +
      esc(label) +
      '</span></div>' +
      '<div class="mt-3 space-y-2">' +
      '<div class="h-3 w-2/3 rounded bg-surface-50/70"></div>' +
      '<div class="h-3 w-1/2 rounded bg-surface-50/50"></div>' +
      '</div></div>'
    );
  }

  function _renderRecentMovementsLoading() {
    const target = $('#items-recent-movements');
    if (target)
      target.innerHTML = _buildLoadingCard(
        'items-recent-loading',
        i18next.t('web:items.recent_movements', { defaultValue: 'Recent Movements' }),
      );
  }

  function _renderRecentMovementsError() {
    const target = $('#items-recent-movements');
    if (target)
      target.innerHTML =
        '<div class="card"><h3 class="card-title">' +
        i18next.t('web:items.recent_movements', { defaultValue: 'Recent Movements' }) +
        '</h3><div class="text-xs text-horde">' +
        i18next.t('web:empty_states.failed_to_load_item_data', { defaultValue: 'Failed to load item data' }) +
        '</div></div>';
  }

  function _renderRecentMovements() {
    const target = $('#items-recent-movements') || $('#items-content');
    if (!target) return;
    if (!_itemsMovements.length) {
      target.innerHTML =
        '<div class="card"><h3 class="card-title">' +
        i18next.t('web:items.recent_movements', { defaultValue: 'Recent Movements' }) +
        '</h3><div class="text-sm text-muted py-4 text-center">' +
        i18next.t('web:empty_states.no_movements_recorded_yet') +
        '</div></div>';
      return;
    }
    target.innerHTML =
      '<div class="card"><h3 class="card-title">' +
      i18next.t('web:items.recent_movements', { defaultValue: 'Recent Movements' }) +
      ' <span class="text-xs text-muted font-normal">(' +
      i18next.t('web:items.last_n', { count: 50, defaultValue: 'last {{count}}' }) +
      ')</span></h3>' +
      _buildMovementList(_itemsMovements) +
      '</div>';
  }

  function _renderItemsList(view) {
    if (view === 'movements') return;
    const target = $('#items-list');
    if (!target) return;
    let html = '';

    if (view !== 'instances' && _itemsData.groups.length > 0) {
      html +=
        '<div class="card"><h3 class="card-title">' +
        i18next.t('web:items.fungible_groups') +
        ' <span class="text-xs text-muted font-normal">(' +
        _itemsData.groups.length +
        (_itemsHasMoreGroups ? '+' : '') +
        ')</span></h3>' +
        _buildGroupTable(_itemsData.groups) +
        '</div>';
    }

    if (view !== 'groups' && _itemsData.instances.length > 0) {
      html +=
        '<div class="card"><h3 class="card-title">' +
        i18next.t('web:items.unique_items') +
        ' <span class="text-xs text-muted font-normal">(' +
        _itemsData.instances.length +
        (_itemsHasMoreInstances ? '+' : '') +
        ')</span></h3>' +
        _buildInstanceTable(_itemsData.instances) +
        '</div>';
    }

    if (!_itemsData.groups.length && !_itemsData.instances.length && !_itemsPageLoading) {
      html =
        '<div class="card"><div class="text-sm text-muted py-8 text-center">' +
        i18next.t('web:empty_states.no_tracked_items_found') +
        '</div></div>';
    }

    if (_itemsPageLoading) {
      html += _buildLoadingCard('items-loading', i18next.t('web:loading.generic', { defaultValue: 'Loading...' }));
    } else if (_shouldShowLoadMore(view)) {
      html +=
        '<div class="text-center py-2"><button id="items-load-more" class="btn btn-secondary text-xs" type="button">' +
        i18next.t('web:activity.load_more', { defaultValue: 'Load More' }) +
        '</button></div>';
    }

    target.innerHTML = html;
  }

  function _shouldShowLoadMore(view) {
    return (view !== 'instances' && _itemsHasMoreGroups) || (view !== 'groups' && _itemsHasMoreInstances);
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

  function _buildGroupTable(groups) {
    let html = '<div class="overflow-x-auto"><table class="w-full text-xs">';
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
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
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

  function _handleItemsContentClick(e) {
    const target = e.target;
    if (!target || !target.closest) return;
    const loadMore = target.closest('#items-load-more');
    if (loadMore) {
      if (_itemsPageLoading) return;
      _loadItemPage({ reset: false, loadSeq: _itemsLoadSeq, view: _getItemsView() });
      return;
    }
    const instanceBtn = target.closest('.item-inst-detail');
    if (instanceBtn) {
      _showItemDetail('instance', parseInt(instanceBtn.dataset.id, 10));
      return;
    }
    const groupBtn = target.closest('.item-grp-detail');
    if (groupBtn) {
      _showItemDetail('group', parseInt(groupBtn.dataset.id, 10));
      return;
    }
    const fpEl = target.closest('.fp-track-link');
    if (!fpEl) return;
    const fpHash = fpEl.dataset.fp;
    const fpItem = fpEl.dataset.item;
    if (!fpHash || !fpItem) return;
    const searchEl = $('#activity-search');
    if (searchEl) searchEl.value = fpItem + '#' + fpHash;
    S.activitySearchMode = '';
    S.activitySearchSteamId = '';
    switchTab('activity');
    setTimeout(function () {
      if (Panel.shared.activityFeed) Panel.shared.activityFeed.resetPaging();
      if (Panel.tabs.activity && Panel.tabs.activity.loadActivity) Panel.tabs.activity.loadActivity();
    }, 100);
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

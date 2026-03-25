/**
 * Panel Main — authentication, initialization, bootstrap, and global utilities.
 *
 * This file MUST load last (after all tab/landing modules).
 * Contains: DOMContentLoaded handler, login flow, server switching,
 * item popup, escape handler, copy button, debounce, and Panel._internal bindings.
 */
window.Panel = window.Panel || {};

(function () {
  'use strict';

  const S = Panel.core.S;
  const $ = Panel.core.$;
  const $$ = Panel.core.$$;
  const el = Panel.core.el;
  const esc = Panel.core.esc;
  const apiFetch = Panel.core.apiFetch;
  const getDbTables = Panel.core.getDbTables;
  const switchTab = Panel.nav.switchTab;
  const setBreadcrumbs = Panel.nav.setBreadcrumbs;
  const getTabLabels = Panel.nav.getTabLabels;
  const showToast = Panel.core.utils.showToast;
  const clampToViewport = Panel.core.utils.clampToViewport;
  const resetActivityPaging = Panel.shared.activityFeed.resetPaging;
  const showEntityPopup = Panel.shared.entityPopup.show;

  // ══════════════════════════════════════════════════
  //  UTILITIES
  // ══════════════════════════════════════════════════

  function debounce(fn, ms) {
    let timer;
    return function () {
      const args = arguments;
      clearTimeout(timer);
      timer = setTimeout(function () {
        fn.apply(null, args);
      }, ms);
    };
  }

  function appendLog(container, text, cls) {
    if (!container) return;
    const placeholder = container.querySelector('.text-muted');
    if (
      placeholder &&
      (placeholder.textContent === 'No actions yet' ||
        placeholder.textContent === i18next.t('web:controls.no_actions_yet'))
    )
      placeholder.remove();
    const line = el('div', 'text-xs ' + (cls || ''));
    line.textContent = text;
    container.appendChild(line);
    container.scrollTop = container.scrollHeight;
  }

  // ══════════════════════════════════════════════════
  //  COPY IP
  // ══════════════════════════════════════════════════

  function setupCopyBtn(btnSel, textSel) {
    const btn = $(btnSel);
    const textEl = $(textSel);
    if (!btn || !textEl) return;
    btn.addEventListener('click', async function (e) {
      e.preventDefault();
      e.stopPropagation();
      const text = textEl.textContent.trim();
      if (!text || text === '-') return;
      try {
        await navigator.clipboard.writeText(text);
        showCopyFeedback(btn);
      } catch (_err) {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.left = '-999px';
        document.body.appendChild(ta);
        ta.select();
        try {
          document.execCommand('copy');
          showCopyFeedback(btn);
        } catch (_e2) {
          /* silent */
        }
        document.body.removeChild(ta);
      }
    });
  }

  function showCopyFeedback(btn) {
    // Works with both Lucide <i> elements and raw <svg>
    const icon = btn.querySelector('svg') || btn.querySelector('i[data-lucide]');
    if (icon) {
      const origHtml = icon.outerHTML;
      icon.outerHTML = '<i data-lucide="check" class="w-4 h-4 text-calm"></i>';
      if (window.lucide) lucide.createIcons({ nodes: [btn] });
      setTimeout(function () {
        const check = btn.querySelector('svg') || btn.querySelector('i[data-lucide]');
        if (check) {
          check.outerHTML = origHtml;
          if (window.lucide) lucide.createIcons({ nodes: [btn] });
        }
      }, 1500);
    }
  }

  // ══════════════════════════════════════════════════
  //  ESCAPE KEY — close modals/popups
  // ══════════════════════════════════════════════════

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    // Item popup
    const popup = document.querySelector('.item-popup');
    if (popup) {
      popup.remove();
      return;
    }
    // Settings diff modal
    const sdm = $('#settings-diff-modal');
    if (sdm && !sdm.classList.contains('hidden')) {
      sdm.classList.add('hidden');
      return;
    }
    // Player modal
    const pm = $('#player-modal');
    if (pm && !pm.classList.contains('hidden')) {
      pm.classList.add('hidden');
      setBreadcrumbs([{ label: getTabLabels()[S.currentTab] || S.currentTab }]);
      return;
    }
    // Item detail modal
    const idm = $('#item-detail-modal');
    if (idm && !idm.classList.contains('hidden')) {
      idm.classList.add('hidden');
      setBreadcrumbs([{ label: getTabLabels()[S.currentTab] || S.currentTab }]);
      return;
    }
    // Map detail panel
    const mdp = $('#map-player-detail');
    if (mdp && !mdp.classList.contains('hidden')) {
      mdp.classList.add('hidden');
      return;
    }
  });

  // ══════════════════════════════════════════════════
  //  ITEM POPUP
  // ══════════════════════════════════════════════════

  function _timeAgo(dateStr) {
    if (!dateStr) return '-';
    let d = new Date(dateStr + 'Z');
    const now = Date.now();
    const diff = Math.max(0, now - d.getTime());
    if (diff < 60000) return 'now';
    if (diff < 3600000) return Math.floor(diff / 60000) + 'm';
    if (diff < 86400000) return Math.floor(diff / 3600000) + 'h';
    return Math.floor(diff / 86400000) + 'd';
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

  function showItemPopup(slot) {
    // Remove any existing popup
    const old = document.querySelector('.item-popup');
    if (old) old.remove();

    const name = slot.dataset.itemName || 'Unknown';
    const qty = slot.dataset.itemQty || '';
    const dur = slot.dataset.itemDur || '';
    const fp = slot.dataset.itemFp || '';
    const ammo = slot.dataset.itemAmmo || '';
    const attachStr = slot.dataset.itemAttach || '';
    const maxDur = slot.dataset.itemMaxdur || '';

    // Parse attachments
    let attachments = [];
    if (attachStr) {
      try {
        attachments = JSON.parse(attachStr);
      } catch (_e) {}
    }

    // Determine the player context (whose inventory is this item in?)
    let contextSteamId = '';
    const parentContent = slot.closest('#player-modal-content, #map-detail-content');
    if (parentContent) contextSteamId = parentContent.dataset.steamId || '';

    // Count how many players have this item (client-side scan)
    const owners = [];
    for (let i = 0; i < S.players.length; i++) {
      const p = S.players[i];
      let count = countItemInPlayer(p, name);
      if (count > 0) owners.push({ name: p.name, steamId: p.steamId, count: count });
    }
    owners.sort(function (a, b) {
      return b.count - a.count;
    });

    // If this specific item has a fingerprint, identify who holds THIS instance
    const isTrackedInstance = !!fp;
    let instanceHolder = '';
    if (isTrackedInstance && contextSteamId) {
      const holder = S.players.find(function (pl) {
        return pl.steamId === contextSteamId;
      });
      if (holder) instanceHolder = holder.name;
    }

    const popup = document.createElement('div');
    popup.className = 'item-popup';

    // Build header with close button
    let html = `<div class="item-popup-header">${esc(name)}<span class="item-popup-close" style="cursor:pointer;color:var(--color-horde, #c45a4a);font-size:14px;line-height:1;padding:2px 4px;border-radius:3px;margin:-2px -4px -2px 0" title="Close">&times;</span></div>`;
    html += '<div class="item-popup-body">';

    // Instance badge — highlight that this is a tracked specific item
    if (isTrackedInstance) {
      html +=
        '<div class="text-[10px] font-medium text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded px-2 py-1 mb-2 flex items-center gap-1">';
      html += `\ud83d\udd0d ${i18next.t('web:item_popup.tracked_instance')}`;
      if (instanceHolder)
        html += ` \u2014 ${i18next.t('web:item_popup.held_by')} <span class="player-link cursor-pointer hover:underline text-accent" data-steam-id="${esc(contextSteamId)}">${esc(instanceHolder)}</span>`;
      html += '</div>';
    }

    // Basic stats grid
    html += '<div class="grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs mb-2">';
    if (qty) html += `<div><span class="text-muted">${i18next.t('web:item_popup.quantity')}:</span> ${qty}</div>`;
    if (dur) {
      const durN = parseInt(dur, 10);
      const durCol = durN > 60 ? 'text-emerald-400' : durN > 25 ? 'text-amber-400' : 'text-red-400';
      html += `<div><span class="text-muted">${i18next.t('web:item_popup.durability')}:</span> <span class="${durCol}">${dur}%</span>`;
      if (maxDur)
        html += ` <span class="text-muted text-[10px]">(${i18next.t('web:item_popup.max')} ${parseFloat(maxDur).toFixed(1)})</span>`;
      html += '</div>';
    }
    if (ammo) html += `<div><span class="text-muted">${i18next.t('web:item_popup.ammo')}:</span> ${ammo}</div>`;
    if (fp)
      html += `<div><span class="text-muted">${i18next.t('web:item_popup.fingerprint')}:</span> <span class="font-mono text-[10px]">${esc(fp)}</span></div>`;
    html += '</div>';

    // Attachments
    if (attachments.length > 0) {
      html += `<div class="text-xs mb-2"><span class="text-muted">${i18next.t('web:item_popup.attachments')}:</span> <span class="text-accent">${attachments
        .map(function (a) {
          return esc(a);
        })
        .join(', ')}</span></div>`;
    }

    // Owners section — for tracked instances, show as "Other holders of this item type" (secondary)
    if (owners.length > 0) {
      if (isTrackedInstance) {
        html += `<div class="text-xs text-muted mt-1 mb-1">${i18next.t('web:item_popup.players_hold', { count: owners.length, name: esc(name) })}</div>`;
      } else {
        html += `<div class="text-xs text-muted mt-1 mb-1">${i18next.t('web:item_popup.held_by_players', { count: owners.length })}</div>`;
      }
      html += '<div class="item-popup-owners">';
      for (let oi = 0; oi < Math.min(owners.length, 6); oi++) {
        html += `<div class="text-xs"><span class="player-link cursor-pointer hover:underline text-accent" data-steam-id="${esc(owners[oi].steamId)}">${esc(owners[oi].name)}</span> <span class="text-muted">\u00d7${owners[oi].count}</span></div>`;
      }
      if (owners.length > 6)
        html += `<div class="text-[10px] text-muted">+${owners.length - 6} ${i18next.t('web:item_popup.more')}</div>`;
      html += '</div>';
    }

    // Tracking data container — will be populated async (prioritizes fingerprint-specific data)
    html += '<div id="item-tracking-data" class="mt-2 border-t border-border/30 pt-2">';
    if (fp) {
      html += `<div class="text-[10px] text-muted">${i18next.t('web:item_popup.loading_instance')}</div>`;
    } else if (name) {
      html += `<div class="text-[10px] text-muted">${i18next.t('web:item_popup.loading_tracking')}</div>`;
    }
    html += '</div>';

    // Quick links
    html += '<div class="mt-2 flex gap-2 flex-wrap">';
    const actSearchVal = fp ? name + '#' + fp : name;
    html += `<span class="activity-link text-[10px] text-accent hover:underline cursor-pointer" data-search="${esc(actSearchVal)}">${fp ? '\ud83d\udd0d ' + i18next.t('web:item_popup.track_item') : i18next.t('web:item_popup.activity_log')} \u2192</span>`;
    if (S.tier >= 3) {
      // admin
      const dbSearch = fp || name;
      html += `<span class="db-link text-[10px] text-accent hover:underline cursor-pointer" data-table="item_instances" data-search="${esc(dbSearch)}">${i18next.t('web:item_popup.item_db')} \u2192</span>`;
      html += `<span class="db-link text-[10px] text-accent hover:underline cursor-pointer" data-table="item_movements" data-search="${esc(dbSearch)}">${i18next.t('web:item_popup.movements')} \u2192</span>`;
    }
    html += '</div>';
    html += '</div>';
    popup.innerHTML = html;

    // Position near the slot, then clamp to viewport
    const rect = slot.getBoundingClientRect();
    popup.style.position = 'fixed';
    popup.style.left = Math.min(rect.right + 8, window.innerWidth - 320) + 'px';
    popup.style.top = Math.max(rect.top - 20, 8) + 'px';
    popup.style.zIndex = '10000';
    popup.style.maxWidth = '320px';
    document.body.appendChild(popup);
    clampToViewport(popup);

    // Async: Fetch tracking data from item fingerprint API
    if (fp || name) {
      _fetchItemTrackingData(fp, name, contextSteamId);
    }
  }

  /** Fetch item tracking data from the fingerprint API and update the popup */
  async function _fetchItemTrackingData(fingerprint, itemName, steamId) {
    const container = document.getElementById('item-tracking-data');
    if (!container) return;

    try {
      const params = [];
      if (fingerprint) params.push('fingerprint=' + encodeURIComponent(fingerprint));
      if (itemName) params.push('item=' + encodeURIComponent(itemName));
      if (steamId) params.push('steamId=' + encodeURIComponent(steamId));
      const url = '/api/panel/items/lookup?' + params.join('&');

      const r = await apiFetch(url);
      if (!r.ok) {
        container.innerHTML = '<div class="text-[10px] text-muted">No tracking data available</div>';
        return;
      }

      const data = await r.json();
      if (!data.match) {
        container.innerHTML = `<div class="text-[10px] text-muted">${i18next.t('web:item_popup.not_tracked')}</div>`;
        return;
      }

      let html = '';
      const m = data.match;

      // Instance/group identity
      html += '<div class="text-[10px] font-semibold text-white mb-1">';
      html +=
        data.matchType === 'group'
          ? `\ud83d\udce6 ${i18next.t('web:item_popup.fungible_group')}`
          : `\ud83d\udd0d ${i18next.t('web:item_popup.tracked_instance')}`;
      html += ` #${m.id}</div>`;

      // Tracking metadata
      html += '<div class="grid grid-cols-2 gap-x-2 gap-y-0.5 text-[10px] mb-1.5">';
      if (m.first_seen)
        html += `<div><span class="text-muted">${i18next.t('web:item_popup.first_seen')}:</span> ${_timeAgo(m.first_seen)}</div>`;
      if (m.last_seen)
        html += `<div><span class="text-muted">${i18next.t('web:item_popup.last_seen')}:</span> ${_timeAgo(m.last_seen)}</div>`;
      if (data.matchType === 'group') {
        html += `<div><span class="text-muted">${i18next.t('web:item_popup.qty_tracked')}:</span> ${m.quantity || 0}</div>`;
      }
      html += `<div><span class="text-muted">${i18next.t('web:item_popup.movements')}:</span> ${data.totalMovements}</div>`;
      html += '</div>';

      // Ownership chain
      if (data.ownershipChain && data.ownershipChain.length > 0) {
        html += `<div class="text-[10px] text-muted mb-0.5">${i18next.t('web:item_popup.ownership_chain')}:</div>`;
        html += '<div class="flex flex-wrap gap-1 mb-1.5">';
        for (let oi = 0; oi < Math.min(data.ownershipChain.length, 8); oi++) {
          const owner = data.ownershipChain[oi];
          html += `<span class="player-link cursor-pointer hover:underline inline-flex items-center gap-0.5 px-1 py-0.5 rounded text-[10px] bg-emerald-500/15 text-emerald-400 border border-emerald-500/30" data-steam-id="${esc(owner.steamId)}">`;
          html += esc(owner.name);
          html += '</span>';
          if (oi < Math.min(data.ownershipChain.length, 8) - 1)
            html += '<span class="text-muted text-[10px]">\u2192</span>';
        }
        if (data.ownershipChain.length > 8)
          html += `<span class="text-[10px] text-muted">+${data.ownershipChain.length - 8} more</span>`;
        html += '</div>';
      }

      // Recent movements (last 5)
      const movements = data.movements || [];
      if (movements.length > 0) {
        const showCount = Math.min(movements.length, 5);
        html += '<div class="text-[10px] text-muted mb-0.5">Recent movements:</div>';
        html += '<div class="space-y-0.5 max-h-28 overflow-y-auto">';
        // Show most recent first
        const recentMovements = movements.slice(-showCount).reverse();
        for (let mi = 0; mi < recentMovements.length; mi++) {
          const mv = recentMovements[mi];
          html += '<div class="flex items-center gap-1 text-[10px] py-0.5">';
          html += `<span class="text-muted font-mono shrink-0">${_timeAgo(mv.created_at)}</span>`;
          html += _locationBadgeMini(mv.from_type, mv.from_id, mv.from_name);
          html += '<span class="text-muted">\u2192</span>';
          html += _locationBadgeMini(mv.to_type, mv.to_id, mv.to_name);
          if (mv.attributed_name) {
            html += `<span class="text-calm ml-auto player-link cursor-pointer hover:underline" data-steam-id="${esc(mv.attributed_steam_id || '')}">${esc(mv.attributed_name)}</span>`;
          }
          html += '</div>';
        }
        html += '</div>';
        if (movements.length > 5) {
          html += `<div class="text-[10px] text-muted mt-0.5">${movements.length - 5} more movements \u2014 `;
          html += '<span class="text-accent cursor-pointer hover:underline" data-nav="items" data-require-tier="3">';
          html += 'view in Items tab</span></div>';
        }
      }

      container.innerHTML = html;
    } catch (_err) {
      container.innerHTML = '<div class="text-[10px] text-muted">Tracking data unavailable</div>';
    }
  }

  /** Mini location badge for item popup movement history */
  function _locationBadgeMini(type, id, resolvedName) {
    const colors = {
      player: 'text-emerald-400',
      container: 'text-purple-400',
      vehicle: 'text-amber-400',
      horse: 'text-pink-400',
      structure: 'text-blue-400',
      world_drop: 'text-gray-400',
      backpack: 'text-orange-400',
      global_container: 'text-indigo-400',
    };
    const cls = colors[type] || 'text-muted';
    const label = resolvedName || _shortenId(id);
    if (type === 'player') {
      return `<span class="${cls} player-link cursor-pointer hover:underline" data-steam-id="${esc(id || '')}">${esc(label)}</span>`;
    }
    if ((type === 'container' || type === 'vehicle' || type === 'structure' || type === 'horse') && id) {
      const entityTable = type === 'horse' ? 'world_horses' : type + 's';
      return `<span class="${cls} entity-link cursor-pointer hover:underline" data-entity-table="${entityTable}" data-entity-search="${esc(id)}">${esc(_formatLocationType(type))}:${esc(label)}</span>`;
    }
    return `<span class="${cls}">${esc(_formatLocationType(type))}:${esc(label)}</span>`;
  }

  function countItemInPlayer(player, itemName) {
    let count = 0;
    const bags = [player.equipment, player.quickSlots, player.inventory, player.backpackItems];
    for (let b = 0; b < bags.length; b++) {
      const bag = bags[b];
      if (!bag) continue;
      for (let j = 0; j < bag.length; j++) {
        const item = bag[j];
        if (!item) continue;
        const n = typeof item === 'string' ? item : item.item || item.name || '';
        if (n === itemName) count += typeof item === 'object' ? item.amount || item.quantity || 1 : 1;
      }
    }
    return count;
  }

  // ══════════════════════════════════════════════════
  //  SERVER SWITCHING
  // ══════════════════════════════════════════════════

  /** Load server list and build the scope switcher */
  async function loadServerList() {
    try {
      const r = await fetch('/api/servers');
      if (!r.ok) return;
      let d = await r.json();
      S.multiServer = d.multiServer || false;
      S.serverList = d.servers || [];

      // Always show server bar and initialize switcher (even single-server)
      const bar = $('#server-bar');
      if (bar) bar.classList.remove('hidden');
      await updateServerStatuses();
      if (Panel.switcher) {
        Panel.switcher.init();
        Panel.switcher.refresh();
      }
    } catch (_e) {
      console.warn('[Panel] loadServerList failed:', _e.message || _e);
    }
  }

  function populateDbTableSelects() {
    const dbTables = getDbTables();
    const dbSelect = $('#db-table');
    if (dbSelect) {
      const prevDb = dbSelect.value;
      dbSelect.innerHTML = '';
      for (let i = 0; i < dbTables.length; i++) {
        const opt = document.createElement('option');
        opt.value = dbTables[i].value;
        opt.textContent = dbTables[i].label;
        dbSelect.appendChild(opt);
      }
      if (prevDb) dbSelect.value = prevDb;
    }

    const qbTableSelect = $('#qb-table');
    if (qbTableSelect) {
      const prevQb = qbTableSelect.value;
      qbTableSelect.innerHTML = '';
      for (let j = 0; j < dbTables.length; j++) {
        const opt2 = document.createElement('option');
        opt2.value = dbTables[j].value;
        opt2.textContent = dbTables[j].label;
        qbTableSelect.appendChild(opt2);
      }
      if (prevQb) qbTableSelect.value = prevQb;
    }
  }

  // Note: renderServerCarousel() removed — replaced by Panel.switcher dropdown

  /** Fetch server statuses from landing API and update switcher */
  async function updateServerStatuses() {
    try {
      const r = await fetch('/api/landing');
      if (!r.ok) return;
      let d = await r.json();
      const allServers = [];
      if (d.primary) allServers.push(d.primary);
      if (d.servers) for (let i = 0; i < d.servers.length; i++) allServers.push(d.servers[i]);
      S.serverStatuses = {};
      for (let j = 0; j < allServers.length; j++) {
        const s = allServers[j];
        S.serverStatuses[s.id || 'primary'] = s;
      }
      // Refresh switcher with updated statuses
      if (Panel.switcher) Panel.switcher.refresh();
    } catch (_e) {
      /* non-critical */
    }
  }

  /** Switch active server across all tabs */
  function switchServer(id) {
    S.currentServer = id;
    // Refresh switcher display
    if (Panel.switcher) Panel.switcher.refresh();

    // ── Reset ALL server-specific cached state ──
    // Player data
    S.players = [];
    S.toggles = {};
    S.worldBounds = null;

    // Dashboard
    S.dashHistory = { online: [], events: [] };
    Object.keys(S.sparkCharts).forEach(function (k) {
      if (S.sparkCharts[k]) {
        S.sparkCharts[k].destroy();
        delete S.sparkCharts[k];
      }
    });
    S.scheduleData = null;

    // Map
    S.mapReady = false;

    // Settings
    S.settingsOriginal = {};
    S.settingsChanged = {};
    // Bot config — must reset to prevent cross-server saves
    S.botConfigOriginal = {};
    S.botConfigChanged = {};
    S.botConfigSections = [];

    // Activity tab — reset charts flag so they reload for new server
    S.activityCategory = '';
    S.activityChartsLoaded = false;
    if (S.activityCharts) {
      Object.keys(S.activityCharts).forEach(function (k) {
        if (S.activityCharts[k] && S.activityCharts[k].destroy) S.activityCharts[k].destroy();
      });
    }
    S.activityCharts = {};
    S.activityStats = null;
    // Reset activity paging (module-level vars)
    resetActivityPaging();

    // Console — clear output so old server responses don't bleed through
    S.consoleBuf = [];
    const consoleEl = $('#console-output');
    if (consoleEl) consoleEl.innerHTML = '';

    // Database tab
    S.dbLastResult = null;
    S.dbTablesLive = [];
    S.dbSchemaCache = {};

    // Items tab (module-level vars)
    S._itemsData = { instances: [], groups: [], locations: [], counts: {} };
    S._itemsMovements = [];

    // Timeline — stop playback and reset state
    if (Panel.tabs.timeline && Panel.tabs.timeline.reset) Panel.tabs.timeline.reset();

    // Dashboard cards — hide all so they don't carry between servers
    const hideDash = ['schedule-card', 'resources-card', 'hzmod-card', 'dashboard-connect'];
    hideDash.forEach(function (elId) {
      const elem = document.getElementById(elId);
      if (elem) elem.classList.add('hidden');
    });

    // Reload current tab
    loadPlayersInBackground();
    switchTab(S.currentTab);
  }

  // ══════════════════════════════════════════════════
  //  PLAYER LOADING / VIEW MODE
  // ══════════════════════════════════════════════════

  async function loadPlayersInBackground() {
    try {
      const r = await apiFetch('/api/players');
      if (!r.ok) return;
      let d = await r.json();
      S.players = d.players || [];
      S.toggles = d.toggles || {};
      S.worldBounds = d.worldBounds || null;
    } catch (_e) {}
  }

  function toggleViewMode() {
    if (S.tier < 3) return;
    S.viewMode = S.viewMode === 'admin' ? 'survivor' : 'admin';
    const badge = $('#view-mode-badge');
    if (badge) badge.classList.toggle('hidden', S.viewMode === 'admin');
    $$('[data-min-tier]').forEach(function (elem) {
      const min = parseInt(elem.dataset.minTier, 10);
      const effectiveTier = S.viewMode === 'survivor' ? 1 : S.tier;
      if (effectiveTier < min) elem.classList.add('tier-hidden');
      else elem.classList.remove('tier-hidden');
    });
  }

  // ══════════════════════════════════════════════════
  //  LANGUAGE CHANGE HANDLER
  // ══════════════════════════════════════════════════

  document.addEventListener('languageChanged', function () {
    // Re-translate all static data-i18n elements
    if (window.translateDOM) translateDOM();

    populateDbTableSelects();

    // Update breadcrumbs with new language
    if (S.breadcrumbs && S.breadcrumbs.length) {
      const rootLabel = getTabLabels()[S.currentTab] || S.currentTab;
      if (S.breadcrumbs.length > 1) {
        const nextCrumbs = [{ label: rootLabel, action: 'tab' }];
        for (let i = 1; i < S.breadcrumbs.length; i++) nextCrumbs.push(S.breadcrumbs[i]);
        setBreadcrumbs(nextCrumbs);
      } else {
        setBreadcrumbs([{ label: rootLabel }]);
      }
    }

    // Re-render current tab content with new language
    if (S.currentTab === 'settings') {
      const settingsContainer = $('#settings-grid');
      if (!settingsContainer) return;
      if (S.settingsMode === 'bot') {
        if (S.botConfigSections && S.botConfigSections.length && Panel.tabs.settings)
          Panel.tabs.settings.loadBotConfig(settingsContainer, S.botConfigSections);
      } else if (S.settingsMode === 'schedule') {
        if (Panel.tabs.settings) Panel.tabs.settings.loadScheduleEditor();
      } else if (S.settingsMode === 'welcome') {
        if (Panel.tabs.settings) Panel.tabs.settings.loadWelcomeEditor();
      } else if (Object.keys(S.settingsOriginal || {}).length) {
        if (Panel.tabs.settings) Panel.tabs.settings.loadSettings(settingsContainer, S.settingsOriginal);
      }
    } else {
      // Re-render other tabs by reloading their content
      const tabLoaders = {
        dashboard: Panel.tabs.dashboard ? Panel.tabs.dashboard.load : null,
        players: Panel.tabs.players ? Panel.tabs.players.load : null,
        activity: Panel.tabs.activity ? Panel.tabs.activity.loadActivity : null,
        chat: Panel.tabs.chat ? Panel.tabs.chat.load : null,
        clans: Panel.tabs.clans ? Panel.tabs.clans.load : null,
        servers: Panel.tabs.servers ? Panel.tabs.servers.load : null,
      };
      if (tabLoaders[S.currentTab]) tabLoaders[S.currentTab]();
    }

    // Re-render map player detail sidebar if open
    const mapDetail = $('#map-player-detail');
    if (mapDetail && !mapDetail.classList.contains('hidden')) {
      const steamId = $('#map-detail-content')?.dataset?.steamId;
      if (steamId && S.players) {
        const p = S.players.find(function (pl) {
          return pl.steamId === steamId;
        });
        if (p && Panel.tabs.map) Panel.tabs.map.showPlayerDetail(p);
      }
    }

    // Re-render player modal if open
    const playerModal = $('#player-modal');
    if (playerModal && !playerModal.classList.contains('hidden')) {
      const modalSteamId = $('#player-modal-content')?.dataset?.steamId;
      if (modalSteamId && S.players) {
        const mp = S.players.find(function (pl) {
          return pl.steamId === modalSteamId;
        });
        if (mp && Panel.tabs.players) Panel.tabs.players.showPlayerModal(mp);
      }
    }

    // Update Chart.js instances with new locale labels
    if (window.Chart) {
      Object.keys(Chart.instances || {}).forEach(function (id) {
        try {
          Chart.instances[id].update();
        } catch (_e) {
          /* chart may not need update */
        }
      });
    }
  });

  // ══════════════════════════════════════════════════
  //  SHOW PANEL (main UI init)
  // ══════════════════════════════════════════════════

  function showPanel() {
    if (S._refreshPoll) {
      clearInterval(S._refreshPoll);
      S._refreshPoll = null;
    }
    if (Panel.landing) Panel.landing.stopAuto(); // stop landing carousel
    $('#landing').classList.add('hidden');
    $('#panel').classList.remove('hidden');

    // Periodically re-check roles while in the panel (detects role revocation)
    S._panelRefreshPoll = setInterval(async function () {
      try {
        const r = await fetch('/auth/refresh');
        let d = await r.json();
        if (!d.authenticated || d.tierLevel < 1) {
          clearInterval(S._panelRefreshPoll);
          location.reload();
          return;
        }
        if (d.tierLevel !== S.tier) {
          S.user = d;
          S.tier = d.tierLevel;
          $('#user-tier').textContent = d.tier || '-';
          // Re-apply tier visibility on tab elements
          $$('[data-min-tier]').forEach(function (elem) {
            const min = parseInt(elem.dataset.minTier, 10);
            elem.classList.toggle('tier-hidden', S.tier < min);
          });
        }
      } catch (_e) {
        /* ignore */
      }
    }, 120000); // every 2 minutes
    const skyBg = $('#skyline-bg');
    if (skyBg) skyBg.classList.add('panel-active');

    if (typeof gsap !== 'undefined') {
      gsap.fromTo('#sidebar', { x: -12, opacity: 0 }, { x: 0, opacity: 1, duration: 0.25, ease: 'power2.out' });
    }

    if (S.user.avatar) {
      const av = $('#user-avatar');
      av.src = S.user.avatar;
      av.classList.remove('hidden');
    }
    $('#user-name').textContent = S.user.displayName || S.user.username || '-';
    $('#user-tier').textContent = S.user.tier || '-';

    $$('[data-min-tier]').forEach(function (elem) {
      const min = parseInt(elem.dataset.minTier, 10);
      if (S.tier < min) elem.classList.add('tier-hidden');
    });

    const userBlock = $('#user-block');
    if (userBlock && S.tier >= 3) userBlock.addEventListener('click', toggleViewMode);

    $$('.nav-link').forEach(function (link) {
      link.addEventListener('click', function (e) {
        e.preventDefault();
        if (link.classList.contains('tier-hidden')) return;
        switchTab(link.dataset.tab);
      });
    });

    setupCopyBtn('#copy-address-btn', '#landing-address');
    setupCopyBtn('#d-copy-btn', '#d-address');

    const chatSendBtn = $('#chat-send-btn');
    if (chatSendBtn) {
      chatSendBtn.addEventListener('click', function () {
        Panel.tabs.chat.send();
      });
      const chatInput = $('#chat-msg-input');
      if (chatInput)
        chatInput.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') Panel.tabs.chat.send();
        });
    }
    const chatSearchInput = $('#chat-search');
    if (chatSearchInput) chatSearchInput.addEventListener('input', debounce(Panel.tabs.chat.load, 400));

    const rconSendBtn = $('#rcon-send-btn');
    if (rconSendBtn) {
      rconSendBtn.addEventListener('click', function () {
        if (Panel.tabs.console) Panel.tabs.console.sendRcon();
      });
      const rconInput = $('#rcon-input');
      if (rconInput)
        rconInput.addEventListener('keydown', function (e) {
          if (Panel.tabs.console) Panel.tabs.console.handleKeydown(e);
        });
    }
    const clearBtn = $('#console-clear-btn');
    if (clearBtn)
      clearBtn.addEventListener('click', function () {
        S.consoleBuf = [];
        const out = $('#console-output');
        if (out) out.innerHTML = '<div class="console-line sys">Console cleared</div>';
      });

    const cmdBtn = $('#cmd-helper-btn');
    const cmdList = $('#cmd-helper-list');
    if (cmdBtn && cmdList) {
      cmdBtn.addEventListener('click', function () {
        cmdList.classList.toggle('hidden');
      });
      document.addEventListener('click', function (e) {
        const wrap = $('#cmd-helper-wrap');
        if (wrap && !wrap.contains(e.target)) cmdList.classList.add('hidden');
      });
      $$('.cmd-item', cmdList).forEach(function (item) {
        item.addEventListener('click', function () {
          const input = $('#rcon-input');
          if (input) {
            input.value = item.dataset.cmd;
            input.focus();
          }
          cmdList.classList.add('hidden');
        });
      });
    }

    const acWrap = $('#console-autocomplete');
    if (acWrap) {
      acWrap.addEventListener('click', function (e) {
        const item = e.target.closest('.cmd-item');
        if (!item) return;
        const input = $('#rcon-input');
        if (input) {
          input.value = item.dataset.cmd;
          input.focus();
        }
        if (Panel.tabs.console) Panel.tabs.console.hideAutocomplete();
      });
    }

    $$('[data-action]').forEach(function (btn) {
      if (btn.classList.contains('quick-cmd')) return;
      btn.addEventListener('click', function () {
        Panel._internal.doPowerAction(btn.dataset.action);
      });
    });

    const mapRefreshBtn = $('#map-refresh-btn');
    if (mapRefreshBtn)
      mapRefreshBtn.addEventListener('click', function () {
        if (Panel.tabs.map) Panel.tabs.map.refreshSnapshot();
      });

    $$('.quick-cmd[data-cmd]').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        const log = $('#controls-log');
        const time = window.fmtTime ? window.fmtTime(new Date()) : new Date().toLocaleTimeString();
        appendLog(log, '[' + time + '] > ' + btn.dataset.cmd, 'text-muted');
        try {
          const r = await apiFetch('/api/panel/rcon', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ command: btn.dataset.cmd }),
          });
          let d = await r.json();
          const resp = d.response || d.error || i18next.t('web:rcon.no_response');
          appendLog(log, '[' + time + '] ' + resp, d.ok ? 'text-calm' : 'text-red-400');
          if (Panel.tabs.console) {
            Panel.tabs.console.appendConsole(btn.dataset.cmd, 'cmd');
            Panel.tabs.console.appendConsole(resp, d.ok ? 'resp' : 'err');
          }
        } catch (err) {
          appendLog(log, '[' + time + '] \u2715 ' + err.message, 'text-red-400');
          if (Panel.tabs.console)
            Panel.tabs.console.appendConsole(i18next.t('web:toast.error', { message: err.message }), 'err');
        }
      });
    });

    const ps = $('#player-search');
    if (ps)
      ps.addEventListener('input', function () {
        if (Panel.tabs.players) Panel.tabs.players.renderPlayers();
      });
    const pso = $('#player-sort');
    if (pso)
      pso.addEventListener('change', function () {
        if (Panel.tabs.players) Panel.tabs.players.renderPlayers();
      });

    const pvTable = $('#player-view-table');
    const pvCards = $('#player-view-cards');
    if (pvTable)
      pvTable.addEventListener('click', function () {
        S.playerViewMode = 'table';
        pvTable.className = 'p-1.5 rounded text-accent bg-accent/10 border border-accent/20';
        if (pvCards) pvCards.className = 'p-1.5 rounded text-muted hover:text-text transition-colors';
        if (Panel.tabs.players) Panel.tabs.players.renderPlayers();
      });
    if (pvCards)
      pvCards.addEventListener('click', function () {
        S.playerViewMode = 'cards';
        if (pvTable) pvTable.className = 'p-1.5 rounded text-muted hover:text-text transition-colors';
        pvCards.className = 'p-1.5 rounded text-accent bg-accent/10 border border-accent/20';
        if (Panel.tabs.players) Panel.tabs.players.renderPlayers();
      });

    const pmc = $('#player-modal-close');
    if (pmc)
      pmc.addEventListener('click', function () {
        const m = $('#player-modal');
        if (m) m.classList.add('hidden');
        setBreadcrumbs([{ label: getTabLabels()[S.currentTab] || S.currentTab }]);
      });
    const pm = $('#player-modal');
    if (pm)
      pm.addEventListener('click', function (e) {
        if (e.target.id === 'player-modal') {
          e.target.classList.add('hidden');
          setBreadcrumbs([{ label: getTabLabels()[S.currentTab] || S.currentTab }]);
        }
      });

    const mdc = $('#map-detail-close');
    if (mdc)
      mdc.addEventListener('click', function () {
        const mapPanel = $('#map-player-detail');
        if (mapPanel) mapPanel.classList.add('hidden');
      });

    const ms = $('#map-search');
    if (ms)
      ms.addEventListener('input', function () {
        if (Panel.tabs.map) Panel.tabs.map.filterPlayers();
      });
    const mso = $('#map-show-offline');
    if (mso)
      mso.addEventListener('change', function () {
        if (Panel.tabs.map) {
          Panel.tabs.map.updateMarkers();
          Panel.tabs.map.filterPlayers();
        }
      });

    ['structures', 'vehicles', 'containers', 'companions'].forEach(function (layer) {
      const cb = $('#map-layer-' + layer);
      if (cb)
        cb.addEventListener('change', function () {
          if (Panel.tabs.map) Panel.tabs.map.load();
        });
    });

    // Activity category pills
    const pills = $$('.activity-pill');
    pills.forEach(function (pill) {
      pill.addEventListener('click', function () {
        pills.forEach(function (p2) {
          p2.classList.remove('active');
        });
        pill.classList.add('active');
        S.activityCategory = pill.dataset.category || '';
        resetActivityPaging();
        if (Panel.tabs.activity) Panel.tabs.activity.loadActivity();
      });
    });
    const as = $('#activity-search');
    if (as)
      as.addEventListener(
        'input',
        debounce(function () {
          resetActivityPaging();
          if (Panel.tabs.activity) Panel.tabs.activity.loadActivity();
        }, 300),
      );
    const ad = $('#activity-date');
    if (ad)
      ad.addEventListener('change', function () {
        resetActivityPaging();
        if (Panel.tabs.activity) Panel.tabs.activity.loadActivity();
      });
    // Charts toggle
    const actChartToggle = $('#activity-toggle-charts');
    if (actChartToggle)
      actChartToggle.addEventListener('click', function () {
        const chartPanel = $('#activity-charts-panel');
        if (chartPanel) {
          const show = chartPanel.classList.toggle('hidden');
          if (!show && !S.activityChartsLoaded) {
            if (Panel.tabs.activity) Panel.tabs.activity.loadActivityStats();
            S.activityChartsLoaded = true;
          }
        }
      });

    // Fingerprint tracker controls
    const fpClose = $('#fp-close');
    if (fpClose)
      fpClose.addEventListener('click', function () {
        if (Panel.tabs.items) Panel.tabs.items.hideFingerprintTracker();
        const searchEl = $('#activity-search');
        if (searchEl) {
          // Strip the #fingerprint part, keep just the item name
          const val = searchEl.value;
          const hashIdx = val.indexOf('#');
          if (hashIdx > -1) {
            searchEl.value = val.slice(0, hashIdx);
            resetActivityPaging();
            if (Panel.tabs.activity) Panel.tabs.activity.loadActivity();
          }
        }
      });
    const fpLimit = $('#fp-limit');
    if (fpLimit)
      fpLimit.addEventListener('change', function () {
        // Re-trigger the tracker with updated limit
        const searchEl = $('#activity-search');
        if (searchEl) {
          const val = searchEl.value;
          const fpMatch = val.match(/^(.+)#([a-f0-9]{6,})$/i);
          if (fpMatch && Panel.tabs.items)
            Panel.tabs.items.showFingerprintTracker(fpMatch[1].trim(), fpMatch[2].trim());
        }
      });

    const cs = $('#clan-search');
    if (cs)
      cs.addEventListener(
        'input',
        debounce(function () {
          if (Panel.tabs.clans) Panel.tabs.clans.load();
        }, 300),
      );
    const cso = $('#clan-sort');
    if (cso)
      cso.addEventListener('change', function () {
        if (Panel.tabs.clans) Panel.tabs.clans.load();
      });

    const ss = $('#settings-search');
    if (ss)
      ss.addEventListener('input', function () {
        if (Panel.tabs.settings) Panel.tabs.settings.filterSettings();
      });
    const sb = $('#settings-save-btn');
    if (sb)
      sb.addEventListener('click', function () {
        if (Panel.tabs.settings) Panel.tabs.settings.showSettingsDiff();
      });
    const srb = $('#settings-reset-btn');
    if (srb)
      srb.addEventListener('click', function () {
        if (Panel.tabs.settings) Panel.tabs.settings.resetSettingsChanges();
      });

    const sdc = $('#settings-diff-close');
    if (sdc)
      sdc.addEventListener('click', function () {
        $('#settings-diff-modal').classList.add('hidden');
      });
    const sdCancel = $('#settings-diff-cancel');
    if (sdCancel)
      sdCancel.addEventListener('click', function () {
        $('#settings-diff-modal').classList.add('hidden');
      });
    const sdConfirm = $('#settings-diff-confirm');
    if (sdConfirm)
      sdConfirm.addEventListener('click', function () {
        $('#settings-diff-modal').classList.add('hidden');
        if (Panel.tabs.settings) Panel.tabs.settings.commitSettings();
      });
    const sdModal = $('#settings-diff-modal');
    if (sdModal)
      sdModal.addEventListener('click', function (e) {
        if (e.target === sdModal) sdModal.classList.add('hidden');
      });

    // Settings mode toggle (Game Server / Bot Config / Schedule / Welcome File)
    $$('.settings-mode-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const mode = btn.dataset.mode;
        if (mode === S.settingsMode) return;
        S.settingsMode = mode;
        $$('.settings-mode-btn').forEach(function (b) {
          b.classList.toggle('active', b.dataset.mode === mode);
        });
        const searchEl = $('#settings-search');
        if (searchEl) searchEl.value = '';
        const restartBadge = $('#settings-restart-badge');
        if (restartBadge) restartBadge.classList.add('hidden');
        // Hide/show settings-specific toolbar items based on mode
        const saveBtn = $('#settings-save-btn');
        const resetBtn = $('#settings-reset-btn');
        const changeCount = $('#settings-change-count');
        const settingsCount = $('#settings-count');
        const hideToolbar = mode === 'schedule' || mode === 'welcome';
        if (saveBtn) saveBtn.classList.toggle('hidden', hideToolbar);
        if (resetBtn) resetBtn.classList.toggle('hidden', hideToolbar);
        if (changeCount) changeCount.classList.toggle('hidden', hideToolbar);
        if (settingsCount) settingsCount.classList.toggle('hidden', hideToolbar);
        if (searchEl) searchEl.parentElement.classList.toggle('hidden', hideToolbar);
        if (Panel.tabs.settings) {
          if (mode === 'game') {
            Panel.tabs.settings.loadSettings();
          } else if (mode === 'schedule') {
            Panel.tabs.settings.loadScheduleEditor();
          } else if (mode === 'welcome') {
            Panel.tabs.settings.loadWelcomeEditor();
          } else {
            Panel.tabs.settings.loadBotConfig();
          }
        }
      });
    });

    const dbt = $('#db-table');
    if (dbt)
      dbt.addEventListener('change', function () {
        if (Panel.tabs.database) {
          Panel.tabs.database.load();
          Panel.tabs.database.showSchema();
        }
      });
    const dbs = $('#db-search');
    if (dbs)
      dbs.addEventListener(
        'input',
        debounce(function () {
          if (Panel.tabs.database) Panel.tabs.database.load();
        }, 300),
      );
    const dbl = $('#db-limit');
    if (dbl)
      dbl.addEventListener('change', function () {
        if (Panel.tabs.database) Panel.tabs.database.load();
      });
    const dbCsv = $('#db-export-csv');
    if (dbCsv)
      dbCsv.addEventListener('click', function () {
        if (Panel.tabs.database) Panel.tabs.database.exportCsv();
      });

    // DB mode toggle (Browse / Query)
    $$('#db-mode-browse, #db-mode-query').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const mode = btn.dataset.mode;
        S.dbMode = mode;
        $$('#db-mode-browse, #db-mode-query').forEach(function (b) {
          b.classList.toggle('active', b.dataset.mode === mode);
        });
        const browsePanel = $('#db-browse-panel');
        const queryPanel = $('#db-query-panel');
        if (browsePanel) browsePanel.classList.toggle('hidden', mode !== 'browse');
        if (queryPanel) queryPanel.classList.toggle('hidden', mode !== 'query');
      });
    });

    // Query builder event wiring
    const qbTable = $('#qb-table');
    if (qbTable)
      qbTable.addEventListener('change', function () {
        if (Panel.tabs.database) {
          Panel.tabs.database.updateQbColumns();
          Panel.tabs.database.updateQbPreview();
        }
      });
    const qbCols = $('#qb-columns');
    if (qbCols)
      qbCols.addEventListener('input', function () {
        if (Panel.tabs.database) Panel.tabs.database.updateQbPreview();
      });
    const qbWhereCol = $('#qb-where-col');
    if (qbWhereCol)
      qbWhereCol.addEventListener('change', function () {
        if (Panel.tabs.database) Panel.tabs.database.updateQbPreview();
      });
    const qbWhereOp = $('#qb-where-op');
    if (qbWhereOp)
      qbWhereOp.addEventListener('change', function () {
        if (Panel.tabs.database) Panel.tabs.database.updateQbPreview();
      });
    const qbWhereVal = $('#qb-where-val');
    if (qbWhereVal)
      qbWhereVal.addEventListener('input', function () {
        if (Panel.tabs.database) Panel.tabs.database.updateQbPreview();
      });
    const qbOrderCol = $('#qb-order-col');
    if (qbOrderCol)
      qbOrderCol.addEventListener('change', function () {
        if (Panel.tabs.database) Panel.tabs.database.updateQbPreview();
      });
    const qbOrderDir = $('#qb-order-dir');
    if (qbOrderDir)
      qbOrderDir.addEventListener('change', function () {
        if (Panel.tabs.database) Panel.tabs.database.updateQbPreview();
      });
    const qbLimit = $('#qb-limit');
    if (qbLimit)
      qbLimit.addEventListener('input', function () {
        if (Panel.tabs.database) Panel.tabs.database.updateQbPreview();
      });
    const qbRun = $('#qb-run');
    if (qbRun)
      qbRun.addEventListener('click', function () {
        if (Panel.tabs.database) Panel.tabs.database.runQueryBuilder();
      });
    const qbCopy = $('#qb-copy-sql');
    if (qbCopy)
      qbCopy.addEventListener('click', function () {
        const sql = Panel.tabs.database && Panel.tabs.database.buildQbSql ? Panel.tabs.database.buildQbSql() : '';
        navigator.clipboard.writeText(sql).then(function () {
          showToast(i18next.t('web:toast.sql_copied'));
        });
      });
    const rawRun = $('#db-raw-run');
    if (rawRun)
      rawRun.addEventListener('click', function () {
        if (Panel.tabs.database) Panel.tabs.database.runRawSql();
      });
    const rawInput = $('#db-raw-sql');
    if (rawInput)
      rawInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && Panel.tabs.database) Panel.tabs.database.runRawSql();
      });

    // Populate DB table dropdowns
    populateDbTableSelects();
    // Try to fetch live table list with row counts (overrides static list)
    if (Panel.tabs.database) Panel.tabs.database.fetchTableList();

    loadPlayersInBackground();
    loadServerList();

    switchTab('dashboard');
  }

  // ══════════════════════════════════════════════════
  //  BOOTSTRAP (DOMContentLoaded)
  // ══════════════════════════════════════════════════

  document.addEventListener('DOMContentLoaded', async () => {
    // Wait for i18next to load translation files before rendering any UI
    if (window.i18nReady) await window.i18nReady;

    if (window.lucide) lucide.createIcons();

    if (window.tippy) tippy('[data-tippy-content]', { theme: 'translucent', delay: [200, 0] });

    const res = await fetch('/auth/me');
    S.user = await res.json();
    if (S.user.csrfToken) Panel.core.setCsrfToken(S.user.csrfToken);
    S.tier = S.user.tierLevel || 0;
    if (!S.user.authenticated || S.tier < 1) {
      if (Panel.landing) Panel.landing.show();
      else {
        $('#landing').classList.remove('hidden');
        $('#panel').classList.add('hidden');
      }
      // Non-guild member: swap button to open invite in new tab + poll for join
      if (S.user.authenticated && S.tier < 1) {
        const authBtn = $('#landing-auth-btn');
        if (authBtn) {
          authBtn.innerHTML =
            '<svg width="18" height="14" viewBox="0 0 71 55" fill="currentColor"><path d="M60.1 4.9A58.5 58.5 0 0045.4.2a.2.2 0 00-.2.1 40.7 40.7 0 00-1.8 3.7c-5.5-.8-11-.8-16.3 0A37.3 37.3 0 0025.3.3a.2.2 0 00-.2-.1A58.4 58.4 0 0010.4 4.9a.2.2 0 00-.1.1C1.5 18.7-.9 32 .3 45.1v.1a58.8 58.8 0 0017.8 9 .2.2 0 00.3-.1c1.4-1.9 2.6-3.9 3.6-6a.2.2 0 00-.1-.3 38.8 38.8 0 01-5.5-2.6.2.2 0 010-.4l1.1-.9a.2.2 0 01.2 0 42 42 0 0035.8 0 .2.2 0 01.2 0l1.1.9a.2.2 0 010 .3 36.4 36.4 0 01-5.5 2.7.2.2 0 00-.1.3c1.1 2.1 2.3 4.1 3.7 6a.2.2 0 00.2.1 58.6 58.6 0 0017.9-9v-.1c1.4-15-2.3-28-9.8-39.6a.2.2 0 00-.1-.1zM23.7 37c-3.4 0-6.3-3.2-6.3-7s2.8-7 6.3-7 6.4 3.1 6.3 7-2.8 7-6.3 7zm23.2 0c-3.4 0-6.3-3.2-6.3-7s2.8-7 6.3-7 6.4 3.1 6.3 7-2.8 7-6.3 7z"/></svg> Join our Discord for full access';
          authBtn.classList.replace('bg-[#5865F2]', 'bg-accent/80');
          authBtn.classList.replace('hover:bg-[#4752C4]', 'hover:bg-accent');
          authBtn.target = '_blank';
          authBtn.rel = 'noopener';
          // href gets set below when landing API returns the invite URL
        }
        // Poll /auth/refresh every 5s — bot checks guild membership server-side
        // When user joins Discord and we detect it, auto-redirect to panel
        S._refreshPoll = setInterval(async function () {
          try {
            const r = await fetch('/auth/refresh');
            const d = await r.json();
            if (d.csrfToken) Panel.core.setCsrfToken(d.csrfToken);
            if (d.tierLevel >= 1) {
              clearInterval(S._refreshPoll);
              S.user = d;
              S.tier = d.tierLevel;
              showPanel();
            }
          } catch (_e) {
            /* ignore */
          }
        }, 5000);
      }
    } else showPanel();
  });

  // ══════════════════════════════════════════════════
  //  Panel._internal — expose functions for click delegation
  // ══════════════════════════════════════════════════

  Panel._internal = Panel._internal || {};
  Panel._internal.showPlayerModal = function (p) {
    if (Panel.tabs.players) Panel.tabs.players.showPlayerModal(p);
  };
  Panel._internal.fetchAndShowPlayer = function (id) {
    if (Panel.tabs.players) Panel.tabs.players.fetchAndShowPlayer(id);
  };
  Panel._internal.showToast = showToast;
  Panel._internal.showItemPopup = showItemPopup;
  Panel._internal.showEntityPopup = showEntityPopup;
  Panel._internal.resetActivityPaging = resetActivityPaging;
  Panel._internal.switchServer = switchServer;
  Panel._internal.buildPlayerDetail = function (p) {
    return Panel.tabs.players ? Panel.tabs.players.buildPlayerDetail(p) : '';
  };
})();

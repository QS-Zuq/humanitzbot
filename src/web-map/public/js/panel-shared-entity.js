/**
 * Panel Shared: Entity Popup — info popup for items, structures, vehicles, animals.
 * Used by Map, Items, Activity, Database tabs.
 * @namespace Panel.shared.entityPopup
 */
window.Panel = window.Panel || {};
Panel.shared = Panel.shared || {};

(function () {
  'use strict';

  const S = Panel.core.S;
  const esc = Panel.core.esc;
  const apiFetch = Panel.core.apiFetch;
  const fmtNum = Panel.core.utils.fmtNum;

  // ── Utilities (also exposed on Panel.core.utils) ────────────────

  /** Clamp a popup element within the viewport so it never goes off-screen */
  function clampToViewport(popup) {
    requestAnimationFrame(function () {
      const rect = popup.getBoundingClientRect();
      const pad = 8;
      if (rect.right > window.innerWidth - pad)
        popup.style.left = Math.max(pad, window.innerWidth - rect.width - pad) + 'px';
      if (rect.bottom > window.innerHeight - pad)
        popup.style.top = Math.max(pad, window.innerHeight - rect.height - pad) + 'px';
      if (rect.left < pad) popup.style.left = pad + 'px';
      if (rect.top < pad) popup.style.top = pad + 'px';
    });
  }

  /** Show a brief toast notification at the bottom of the screen */
  function showToast(message, duration) {
    const el = Panel.core.el;
    const t = el(
      'div',
      'fixed bottom-4 left-1/2 -translate-x-1/2 bg-surface-200 border border-border text-text text-xs px-4 py-2 rounded-lg shadow-lg z-10001 fade-in',
    );
    t.textContent = message;
    document.body.appendChild(t);
    setTimeout(function () {
      t.remove();
    }, duration || 3000);
  }

  Panel.core.utils.clampToViewport = clampToViewport;
  Panel.core.utils.showToast = showToast;

  // ── Entity info popup ───────────────────────────────────────────

  const ENTITY_TABLE_TO_TYPE = {
    item_instances: 'item',
    game_items: 'item',
    item_movements: 'item',
    item_groups: 'item',
    structures: 'structure',
    game_buildings: 'structure',
    vehicles: 'vehicle',
    game_vehicles_ref: 'vehicle',
    containers: 'container',
    world_horses: 'animal',
    game_animals: 'animal',
    companions: 'animal',
    game_recipes: 'recipe',
    game_afflictions: 'affliction',
    game_skills: 'skill',
    activity_log: 'item',
  };

  // Properties to hide in entity popups (internal/noisy fields)
  const ENTITY_HIDE_KEYS = new Set([
    'id',
    'rowid',
    'created_at',
    'updated_at',
    'raw_name',
    'blueprint_path',
    'category_raw',
    'categoryRaw',
    'effects',
    'attributeModifiers',
    'skillModifiers',
    'icon_path',
    'mesh_path',
    'thumbnail_path',
  ]);

  function _formatEntityValue(key, val) {
    if (val == null || val === '') return null;
    if (typeof val === 'boolean') return val ? 'Yes' : 'No';
    if (typeof val === 'number') {
      if (key.toLowerCase().includes('percent') || key.toLowerCase().includes('multiplier')) return val.toFixed(2);
      if (val !== Math.floor(val)) return val.toFixed(2);
      return fmtNum(val);
    }
    const s = String(val);
    if (s.length > 200) return s.slice(0, 200) + '\u2026';
    return s;
  }

  function _formatEntityKey(key) {
    return key
      .replace(/_/g, ' ')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/\b\w/g, function (c) {
        return c.toUpperCase();
      });
  }

  function showEntityPopup(triggerEl, name, table) {
    const old = document.querySelector('.item-popup');
    if (old) old.remove();

    const type = ENTITY_TABLE_TO_TYPE[table] || 'item';

    const popup = document.createElement('div');
    popup.className = 'item-popup';

    let html =
      '<div class="item-popup-header">' +
      esc(name) +
      '<span class="item-popup-close" style="cursor:pointer;color:#c45a4a;font-size:14px;line-height:1;padding:2px 4px;border-radius:3px;margin:-2px -4px -2px 0" title="Close">&times;</span></div>';
    html += '<div class="item-popup-body">';
    html += '<div class="text-[10px] text-muted mb-1">' + _formatEntityKey(type) + '</div>';
    html += '<div id="entity-popup-data"><div class="text-[10px] text-muted">Loading\u2026</div></div>';

    // Quick links
    html += '<div class="mt-2 flex gap-2 flex-wrap" id="entity-popup-links">';
    html +=
      '<span class="activity-link text-[10px] text-accent hover:underline cursor-pointer" data-search="' +
      esc(name) +
      '">Activity log \u2192</span>';
    html += '</div>';

    html += '</div>';
    popup.innerHTML = html;

    const rect = triggerEl.getBoundingClientRect();
    popup.style.position = 'fixed';
    popup.style.left = Math.min(rect.right + 8, window.innerWidth - 320) + 'px';
    popup.style.top = Math.max(rect.top - 20, 8) + 'px';
    popup.style.zIndex = '10000';
    popup.style.maxWidth = '340px';
    document.body.appendChild(popup);
    clampToViewport(popup);

    // Fetch entity data
    _fetchEntityData(name, type, table);
  }

  async function _fetchEntityData(name, type, _table) {
    const container = document.getElementById('entity-popup-data');
    const linksContainer = document.getElementById('entity-popup-links');
    if (!container) return;

    try {
      const r = await (typeof authFetch === 'function' ? authFetch : apiFetch)(
        '/api/panel/lookup/' + encodeURIComponent(type) + '/' + encodeURIComponent(name),
      );
      if (!r.ok) {
        container.innerHTML = '<div class="text-[10px] text-muted">No data available</div>';
        return;
      }
      const result = await r.json();

      if (!result.found) {
        container.innerHTML = '<div class="text-[10px] text-muted">Not found in game reference data</div>';
        if (result.activityCount > 0) {
          container.innerHTML +=
            '<div class="text-[10px] text-muted mt-1">' +
            fmtNum(result.activityCount) +
            ' activity log references</div>';
        }
        return;
      }

      const data = result.data;
      let html = '<div class="grid gap-y-0.5 text-xs" style="grid-template-columns: auto 1fr">';
      let shown = 0;
      for (const key in data) {
        if (ENTITY_HIDE_KEYS.has(key)) continue;
        const val = _formatEntityValue(key, data[key]);
        if (val == null) continue;
        html += '<div class="text-muted pr-2 whitespace-nowrap">' + esc(_formatEntityKey(key)) + '</div>';
        html += '<div class="text-gray-300 truncate" title="' + esc(val) + '">' + esc(val) + '</div>';
        shown++;
        if (shown >= 16) {
          html += '<div class="text-muted text-[10px] col-span-2 mt-1">\u2026and more</div>';
          break;
        }
      }
      html += '</div>';

      if (result.activityCount > 0) {
        html +=
          '<div class="text-[10px] text-muted mt-1.5">' +
          fmtNum(result.activityCount) +
          ' activity log references</div>';
      }

      container.innerHTML = html;

      // Add DB links for admins
      if (S.tier >= 3 && linksContainer && result.refTable) {
        linksContainer.innerHTML +=
          '<span class="db-link text-[10px] text-accent hover:underline cursor-pointer" data-table="' +
          esc(result.refTable) +
          '" data-search="' +
          esc(name) +
          '">View in DB \u2192</span>';
      }
    } catch (_e) {
      container.innerHTML = '<div class="text-[10px] text-muted">Failed to load data</div>';
    }
  }

  Panel.shared.entityPopup = { show: showEntityPopup };
})();

/**
 * Panel Tab: Map — Leaflet interactive map with player markers and world layers.
 * @namespace Panel.tabs.map
 */
window.Panel = window.Panel || {};
Panel.tabs = Panel.tabs || {};

(function () {
  'use strict';

  const S = Panel.core.S;
  const $ = Panel.core.$;
  const $$ = Panel.core.$$;
  const el = Panel.core.el;
  const esc = Panel.core.esc;
  const apiFetch = Panel.core.apiFetch;
  const entityLink = Panel.core.utils.entityLink;
  var getCssColor = Panel.core.getCssColor;

  let _inited = false;
  let mapWorldLayers = {};

  function init() {
    if (_inited) return;
    _inited = true;
    initMap();
  }

  // ── Map Initialization ──────────────────────────────────────────

  function initMap() {
    if (S.mapReady && S.map) return;
    const container = $('#map-container');
    if (!container || !window.L) return;
    // Destroy existing map instance before creating a new one (e.g. after server switch)
    if (S.map) {
      clearMapWorldLayers();
      for (const id in S.mapMarkers) {
        S.map.removeLayer(S.mapMarkers[id]);
      }
      S.mapMarkers = {};
      S.map.remove();
      S.map = null;
    }
    S.map = L.map(container, {
      crs: L.CRS.Simple,
      minZoom: -2,
      maxZoom: 3,
      zoomControl: true,
      attributionControl: false,
    });
    const bounds = [
      [0, 0],
      [4096, 4096],
    ];
    L.imageOverlay('/terrain.png', bounds, { className: 'map-terrain' }).addTo(S.map);
    S.map.fitBounds(bounds);
    S.mapReady = true;
  }

  // ── Map Data Loading ────────────────────────────────────────────

  async function loadMapData() {
    Panel.core.utils.setTabUnavailable('tab-map', S.currentServer === 'all');
    if (S.currentServer === 'all') return;
    if (S.map) {
      setTimeout(function () {
        S.map.invalidateSize();
      }, 100);
    }
    try {
      const r = await apiFetch('/api/players');
      if (!r.ok) return;
      const d = await r.json();
      S.players = d.players || [];
      S.toggles = d.toggles || {};
      S.worldBounds = d.worldBounds || null;
      updateMapMarkers();
      updateMapSidebar();

      const wantLayers = [];
      ['structures', 'vehicles', 'containers', 'companions', 'zombies', 'animals', 'bandits'].forEach(function (l) {
        const cb = $('#map-layer-' + l);
        if (cb && cb.checked) wantLayers.push(l);
      });
      if (wantLayers.length > 0) {
        try {
          const lr = await apiFetch('/api/panel/mapdata?layers=' + wantLayers.join(','));
          if (lr.ok) {
            const ld = await lr.json();
            updateMapWorldLayers(ld, wantLayers);
          }
        } catch (_e) {}
      } else {
        clearMapWorldLayers();
      }
    } catch (e) {
      console.error('Map data error:', e);
    }
  }

  // ── World Layers ────────────────────────────────────────────────

  function clearMapWorldLayers() {
    for (const k in mapWorldLayers) {
      if (mapWorldLayers[k] && S.map) S.map.removeLayer(mapWorldLayers[k]);
    }
    mapWorldLayers = {};
  }

  function updateMapWorldLayers(data, layers) {
    if (!S.map || !window.L) return;
    clearMapWorldLayers();

    // Cache CSS colors once per call to avoid repeated DOM queries inside loops
    var palette = {
      surface300: getCssColor('surface-300', '#12100e'),
      calm: getCssColor('calm', '#6dba82'),
      horde: getCssColor('horde', '#c45a4a'),
      surge: getCssColor('surge', '#d4a843'),
      muted: getCssColor('muted', '#7a746c'),
      mapZombie: getCssColor('map-zombie', '#9b59b6'),
      mapAnimal: getCssColor('map-animal', '#e67e22'),
      mapBandit: getCssColor('map-bandit', '#e74c3c'),
    };

    if (layers.indexOf('structures') !== -1 && data.structures) {
      mapWorldLayers.structures = L.layerGroup();
      data.structures.forEach(function (s) {
        if (s.lat == null) return;
        const icon = L.divIcon({
          className: '',
          html:
            '<div style="width:5px;height:5px;background:#3b82f6;border-radius:1px;border:1px solid ' +
            palette.surface300 +
            '"></div>',
          iconSize: [5, 5],
          iconAnchor: [2.5, 2.5],
        });
        const m = L.marker([s.lat, s.lng], { icon: icon });
        m.bindTooltip(esc(s.name || i18next.t('web:activity.structure')), { direction: 'top', offset: [0, -4] });
        const ownerName = s.owner && data.nameMap ? data.nameMap[s.owner] || s.owner : 'Unknown';
        const hpPct = s.maxHealth ? Math.round((s.health / s.maxHealth) * 100) : 0;
        const ownerHtml = s.owner
          ? '<span class="player-link" data-steam-id="' + esc(s.owner) + '">' + esc(ownerName) + '</span>'
          : esc(ownerName);
        const popupHtml =
          '<div class="tl-popup" style="min-width:160px"><b>' +
          entityLink(s.name || i18next.t('web:activity.structure'), 'structure') +
          '</b>' +
          (s.upgrade ? '<br><span style="color:' + palette.muted + '">Level ' + s.upgrade + '</span>' : '') +
          '<br>\u2764\ufe0f ' +
          hpPct +
          '%' +
          '<br>\ud83d\udc64 ' +
          ownerHtml +
          (s.itemCount ? '<br>\ud83d\udce6 ' + s.itemCount + ' items' : '') +
          '</div>';
        m.bindPopup(popupHtml);
        m.addTo(mapWorldLayers.structures);
      });
      mapWorldLayers.structures.addTo(S.map);
    }

    if (layers.indexOf('vehicles') !== -1 && data.vehicles) {
      mapWorldLayers.vehicles = L.layerGroup();
      data.vehicles.forEach(function (v) {
        if (v.lat == null) return;
        const icon = L.divIcon({
          className: '',
          html:
            '<div style="width:7px;height:7px;background:' +
            palette.surge +
            ';border-radius:1px;border:1px solid ' +
            palette.surface300 +
            '"></div>',
          iconSize: [7, 7],
          iconAnchor: [3.5, 3.5],
        });
        const m = L.marker([v.lat, v.lng], { icon: icon });
        m.bindTooltip(esc(v.name || i18next.t('web:activity.vehicle')), { direction: 'top', offset: [0, -5] });
        const hpPct = v.maxHealth ? Math.round((v.health / v.maxHealth) * 100) : 0;
        const hpColor = hpPct > 60 ? palette.calm : hpPct > 30 ? palette.surge : palette.horde;
        const popupHtml =
          '<div class="tl-popup" style="min-width:160px"><b>' +
          entityLink(v.name || i18next.t('web:activity.vehicle'), 'vehicle') +
          '</b>' +
          '<br><span style="color:' +
          palette.muted +
          '">' +
          i18next.t('web:item_popup.durability') +
          '</span> <span style="color:' +
          hpColor +
          '">' +
          hpPct +
          '%</span>' +
          '<br>\u26fd ' +
          i18next.t('web:dashboard.fuel') +
          ': ' +
          (v.fuel || 0) +
          'L</div>';
        m.bindPopup(popupHtml);
        m.addTo(mapWorldLayers.vehicles);
      });
      mapWorldLayers.vehicles.addTo(S.map);
    }

    if (layers.indexOf('containers') !== -1 && data.containers) {
      mapWorldLayers.containers = L.layerGroup();
      data.containers.forEach(function (c) {
        if (c.lat == null) return;
        const icon = L.divIcon({
          className: '',
          html:
            '<div style="width:4px;height:4px;background:#a855f7;border-radius:50%;border:1px solid ' +
            palette.surface300 +
            '"></div>',
          iconSize: [4, 4],
          iconAnchor: [2, 2],
        });
        const m = L.marker([c.lat, c.lng], { icon: icon });
        m.bindTooltip(esc(c.name || 'Container') + ' (' + (c.itemCount || 0) + ')', {
          direction: 'top',
          offset: [0, -4],
        });
        const popupHtml =
          '<div class="tl-popup" style="min-width:140px"><b>' +
          entityLink(c.name || 'Container', 'container') +
          '</b>' +
          '<br>\ud83d\udce6 ' +
          (c.itemCount || 0) +
          ' items' +
          (c.locked ? '<br>\ud83d\udd12 Locked' : '') +
          '</div>';
        m.bindPopup(popupHtml);
        m.addTo(mapWorldLayers.containers);
      });
      mapWorldLayers.containers.addTo(S.map);
    }

    if (layers.indexOf('companions') !== -1 && data.companions) {
      mapWorldLayers.companions = L.layerGroup();
      data.companions.forEach(function (c) {
        if (c.lat == null) return;
        const icon = L.divIcon({
          className: '',
          html:
            '<div style="width:6px;height:6px;background:#ec4899;border-radius:50%;border:1px solid ' +
            palette.surface300 +
            '"></div>',
          iconSize: [6, 6],
          iconAnchor: [3, 3],
        });
        const m = L.marker([c.lat, c.lng], { icon: icon });
        m.bindTooltip(esc(c.type || 'Companion'), { direction: 'top', offset: [0, -4] });
        const ownerName = c.owner && data.nameMap ? data.nameMap[c.owner] || c.owner : 'Unknown';
        const ownerHtml = c.owner
          ? '<span class="player-link" data-steam-id="' + esc(c.owner) + '">' + esc(ownerName) + '</span>'
          : esc(ownerName);
        const popupHtml =
          '<div class="tl-popup" style="min-width:140px"><b>' +
          entityLink(c.type || 'Companion', 'animal') +
          '</b>' +
          '<br>\ud83d\udc64 ' +
          ownerHtml +
          (c.health != null ? '<br>\u2764\ufe0f ' + Math.round(c.health) : '') +
          '</div>';
        m.bindPopup(popupHtml);
        m.addTo(mapWorldLayers.companions);
      });
      mapWorldLayers.companions.addTo(S.map);
    }

    if (layers.indexOf('zombies') !== -1 && data.zombies) {
      mapWorldLayers.zombies = L.layerGroup();
      data.zombies.forEach(function (z) {
        if (z.lat == null) return;
        const icon = L.divIcon({
          className: 'timeline-marker',
          html:
            '<div style="width:6px;height:6px;border-radius:50%;background:' +
            palette.mapZombie +
            ';border:1.5px solid rgba(255,255,255,0.4);box-shadow:0 0 4px ' +
            palette.mapZombie +
            '60;" title="Zombie"></div>',
          iconSize: [6, 6],
          iconAnchor: [3, 3],
        });
        const m = L.marker([z.lat, z.lng], { icon: icon });
        m.bindTooltip(z.name || 'Zombie', { direction: 'top', offset: [0, -4] });
        m.addTo(mapWorldLayers.zombies);
      });
      mapWorldLayers.zombies.addTo(S.map);
    }

    if (layers.indexOf('animals') !== -1 && data.animals) {
      mapWorldLayers.animals = L.layerGroup();
      data.animals.forEach(function (a) {
        if (a.lat == null) return;
        const icon = L.divIcon({
          className: 'timeline-marker',
          html:
            '<div style="width:7px;height:7px;transform:rotate(45deg);border-radius:2px;background:' +
            palette.mapAnimal +
            ';border:1.5px solid rgba(255,255,255,0.4);box-shadow:0 0 4px ' +
            palette.mapAnimal +
            '60;" title="Animal"></div>',
          iconSize: [7, 7],
          iconAnchor: [3.5, 3.5],
        });
        const m = L.marker([a.lat, a.lng], { icon: icon });
        m.bindTooltip(a.name || 'Animal', { direction: 'top', offset: [0, -4] });
        m.addTo(mapWorldLayers.animals);
      });
      mapWorldLayers.animals.addTo(S.map);
    }

    if (layers.indexOf('bandits') !== -1 && data.bandits) {
      mapWorldLayers.bandits = L.layerGroup();
      data.bandits.forEach(function (b) {
        if (b.lat == null) return;
        const icon = L.divIcon({
          className: 'timeline-marker',
          html:
            '<div style="width:8px;height:8px;border-radius:2px;background:' +
            palette.mapBandit +
            ';border:1.5px solid rgba(255,255,255,0.4);box-shadow:0 0 4px ' +
            palette.mapBandit +
            '60;" title="Bandit"></div>',
          iconSize: [8, 8],
          iconAnchor: [4, 4],
        });
        const m = L.marker([b.lat, b.lng], { icon: icon });
        m.bindTooltip(b.name || 'Bandit', { direction: 'top', offset: [0, -4] });
        m.addTo(mapWorldLayers.bandits);
      });
      mapWorldLayers.bandits.addTo(S.map);
    }
  }

  // ── Player Markers ──────────────────────────────────────────────

  function updateMapMarkers() {
    if (!S.map) return;
    let showOffline = true;
    const offlineChk = $('#map-show-offline');
    if (offlineChk) showOffline = offlineChk.checked;

    // Cache CSS colors once to avoid repeated DOM queries inside the player loop
    var colorCalm = getCssColor('calm', '#6dba82');
    var colorMuted = getCssColor('muted', '#7a746c');
    var colorBorder = getCssColor('surface-300', '#12100e');

    for (const id in S.mapMarkers) {
      S.map.removeLayer(S.mapMarkers[id]);
      delete S.mapMarkers[id];
    }

    for (let i = 0; i < S.players.length; i++) {
      const p = S.players[i];
      if (!p.hasPosition) continue;
      if (!showOffline && !p.isOnline) continue;
      if (p.lat == null || p.lng == null) continue;

      const color = p.isOnline ? colorCalm : colorMuted;
      const icon = L.divIcon({
        className: '',
        html:
          '<div style="width:10px;height:10px;border-radius:50%;background:' +
          color +
          ';border:2px solid ' +
          colorBorder +
          '"></div>',
        iconSize: [10, 10],
        iconAnchor: [5, 5],
      });

      const marker = L.marker([p.lat, p.lng], { icon: icon }).addTo(S.map);
      marker.bindTooltip(p.name, { className: 'leaflet-tooltip-dark', offset: [8, 0] });
      (function (player) {
        marker.on('click', function () {
          showMapPlayerDetail(player);
        });
      })(p);
      S.mapMarkers[p.steamId] = marker;
    }

    const count = S.players.filter(function (p) {
      return p.isOnline;
    }).length;
    const cEl = $('#map-player-count');
    if (cEl) cEl.textContent = count + ' ' + i18next.t('web:map.online');
  }

  // ── Sidebar ─────────────────────────────────────────────────────

  function updateMapSidebar() {
    const list = $('#map-player-list');
    if (!list) return;
    list.innerHTML = '';
    const sorted = S.players.slice().sort(function (a, b) {
      if (a.isOnline !== b.isOnline) return a.isOnline ? -1 : 1;
      return (a.name || '').localeCompare(b.name || '');
    });
    for (let i = 0; i < sorted.length; i++) {
      const p = sorted[i];
      const entry = el('div', 'map-player-entry');
      entry.innerHTML =
        '<span class="status-dot ' +
        (p.isOnline ? 'online' : 'offline') +
        '"></span><span class="mp-name player-link ' +
        (p.isOnline ? 'online' : '') +
        '" data-steam-id="' +
        esc(p.steamId || '') +
        '">' +
        esc(p.name) +
        '</span>';
      (function (player) {
        entry.addEventListener('click', function () {
          if (player.hasPosition && player.lat != null && S.map) S.map.setView([player.lat, player.lng], 1);
          showMapPlayerDetail(player);
        });
      })(p);
      list.appendChild(entry);
    }
  }

  function filterMapPlayers() {
    const q = ($('#map-search') ? $('#map-search').value : '').toLowerCase();
    $$('.map-player-entry', $('#map-player-list')).forEach(function (entry) {
      const name = entry.querySelector('.mp-name');
      const text = name ? name.textContent.toLowerCase() : '';
      entry.style.display = text.includes(q) ? '' : 'none';
    });
  }

  // ── Snapshot Refresh ────────────────────────────────────────────

  async function refreshMapSnapshot() {
    const btn = $('#map-refresh-btn');
    if (!btn) return;
    const origHTML = btn.innerHTML;
    btn.innerHTML = '<i data-lucide="loader" class="w-3 h-3 animate-spin"></i> Saving…';
    if (window.lucide) lucide.createIcons({ nodes: [btn] });
    btn.disabled = true;
    try {
      const r = await (typeof authFetch === 'function' ? authFetch : apiFetch)('/api/panel/refresh-snapshot', {
        method: 'POST',
      });
      if (r.ok) {
        btn.innerHTML = '<i data-lucide="check" class="w-3 h-3"></i> Done';
        if (window.lucide) lucide.createIcons({ nodes: [btn] });
        setTimeout(function () {
          loadMapData();
          btn.innerHTML = origHTML;
          if (window.lucide) lucide.createIcons({ nodes: [btn] });
          btn.disabled = false;
        }, 1000);
      } else {
        const d = await r.json().catch(function () {
          return {};
        });
        btn.innerHTML = '<i data-lucide="x" class="w-3 h-3"></i> ' + (d.error || 'Failed');
        if (window.lucide) lucide.createIcons({ nodes: [btn] });
        setTimeout(function () {
          btn.innerHTML = origHTML;
          if (window.lucide) lucide.createIcons({ nodes: [btn] });
          btn.disabled = false;
        }, 3000);
      }
    } catch (_e) {
      btn.innerHTML = '<i data-lucide="x" class="w-3 h-3"></i> Error';
      if (window.lucide) lucide.createIcons({ nodes: [btn] });
      setTimeout(function () {
        btn.innerHTML = origHTML;
        if (window.lucide) lucide.createIcons({ nodes: [btn] });
        btn.disabled = false;
      }, 3000);
    }
  }

  function showMapPlayerDetail(p) {
    const panel = $('#map-player-detail');
    const content = $('#map-detail-content');
    if (!panel || !content) return;
    // buildPlayerDetail is on Panel.tabs.players (or fallback to Panel._internal)
    const buildFn =
      (Panel.tabs.players && Panel.tabs.players.buildPlayerDetail) || Panel._internal.buildPlayerDetail || null;
    if (buildFn) {
      content.innerHTML = buildFn(p);
      content.dataset.steamId = p.steamId || '';
      panel.classList.remove('hidden');
    }
  }

  function reset() {
    _inited = false;
    clearMapWorldLayers();
    if (S.map) {
      for (const id in S.mapMarkers) {
        S.map.removeLayer(S.mapMarkers[id]);
      }
      S.mapMarkers = {};
      S.map.remove();
      S.map = null;
    }
    S.mapReady = false;
  }

  Panel.tabs.map = {
    init: init,
    load: loadMapData,
    reset: reset,
    filterPlayers: filterMapPlayers,
    refreshSnapshot: refreshMapSnapshot,
    showPlayerDetail: showMapPlayerDetail,
    updateMarkers: updateMapMarkers,
  };
})();

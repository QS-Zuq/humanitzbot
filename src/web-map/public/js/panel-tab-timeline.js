/**
 * Panel Tab: Timeline — time-scroll playback of world state snapshots.
 * @namespace Panel.tabs.timeline
 */
window.Panel = window.Panel || {};
Panel.tabs = Panel.tabs || {};

(function () {
  'use strict';

  const S = Panel.core.S;
  const $ = Panel.core.$;
  const $$ = Panel.core.$$;
  const _el = Panel.core.el;
  const esc = Panel.core.esc;
  const apiFetch = Panel.core.apiFetch;
  const fmtDateTime = Panel.core.utils.fmtDateTime;

  // ── Timeline State (self-contained) ──
  const TL = {
    map: null,
    ready: false,
    snapshots: [], // metadata list
    idx: -1, // current index in snapshots[]
    data: null, // full entity data for current snapshot
    playing: false,
    timer: null,
    speed: 5,
    layers: {}, // L.layerGroup per entity type
    visible: {
      players: true,
      zombies: true,
      animals: true,
      bandits: true,
      vehicles: true,
      structures: false,
      companions: true,
      backpacks: false,
      deaths: true,
    },
    deathMarkers: null,
    nameMap: {},
  };

  function tlIcon(color, size, shape, title) {
    const css =
      shape === 'diamond'
        ? 'width:' + size + 'px;height:' + size + 'px;transform:rotate(45deg);border-radius:2px;'
        : shape === 'square'
          ? 'width:' + size + 'px;height:' + size + 'px;border-radius:2px;'
          : 'width:' + size + 'px;height:' + size + 'px;border-radius:50%;';
    return L.divIcon({
      className: 'tl-marker',
      html:
        '<div style="' +
        css +
        'background:' +
        color +
        ';border:1.5px solid rgba(255,255,255,0.35);box-shadow:0 0 4px ' +
        color +
        '60" title="' +
        (title || '') +
        '"></div>',
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2],
    });
  }

  async function initTimeline() {
    if (S.currentServer === 'all') {
      var tabEl = document.getElementById('tab-timeline');
      if (tabEl) tabEl.innerHTML = Panel.core.utils.scopeEmptyState('timeline');
      if (window.lucide) lucide.createIcons();
      return;
    }
    // Init map
    if (!TL.ready) {
      const c = $('#tl-map');
      if (!c || !window.L) return;
      TL.map = L.map(c, { crs: L.CRS.Simple, minZoom: -2, maxZoom: 4, zoomControl: true, attributionControl: false });
      L.imageOverlay(
        '/terrain.png',
        [
          [0, 0],
          [4096, 4096],
        ],
        { className: 'map-terrain' },
      ).addTo(TL.map);
      TL.map.fitBounds([
        [0, 0],
        [4096, 4096],
      ]);

      // Create layer groups
      [
        'players',
        'zombies',
        'animals',
        'bandits',
        'vehicles',
        'structures',
        'companions',
        'backpacks',
        'deaths',
      ].forEach(function (k) {
        TL.layers[k] = L.layerGroup();
        if (TL.visible[k]) TL.layers[k].addTo(TL.map);
      });

      // Wire controls
      const playBtn = $('#tl-play');
      if (playBtn) playBtn.addEventListener('click', tlTogglePlay);
      const stepBack = $('#tl-step-back');
      if (stepBack)
        stepBack.addEventListener('click', function () {
          tlStop();
          tlStep(-1);
        });
      const stepFwd = $('#tl-step-fwd');
      if (stepFwd)
        stepFwd.addEventListener('click', function () {
          tlStop();
          tlStep(1);
        });
      const latest = $('#tl-go-latest');
      if (latest)
        latest.addEventListener('click', function () {
          tlStop();
          tlGoTo(TL.snapshots.length - 1);
        });
      const slider = $('#tl-slider');
      if (slider)
        slider.addEventListener('input', function () {
          tlStop();
          tlGoTo(parseInt(this.value, 10));
        });

      // Speed buttons
      $$('.tl-speed').forEach(function (b) {
        b.addEventListener('click', function () {
          TL.speed = parseInt(this.dataset.speed, 10) || 5;
          $$('.tl-speed').forEach(function (x) {
            x.classList.toggle('active', parseInt(x.dataset.speed, 10) === TL.speed);
          });
          if (TL.playing) {
            tlStop();
            tlPlay();
          }
        });
      });

      // Layer toggles
      [
        'players',
        'zombies',
        'animals',
        'bandits',
        'vehicles',
        'structures',
        'companions',
        'backpacks',
        'deaths',
      ].forEach(function (k) {
        const cb = $('#tl-l-' + k);
        if (cb)
          cb.addEventListener('change', function () {
            TL.visible[k] = this.checked;
            if (this.checked) TL.layers[k].addTo(TL.map);
            else TL.map.removeLayer(TL.layers[k]);
            if (TL.data) tlRender();
          });
      });

      // Keyboard
      document.addEventListener('keydown', function (e) {
        if (S.currentTab !== 'timeline') return;
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
        if (e.key === ' ') {
          e.preventDefault();
          tlTogglePlay();
        }
        if (e.key === 'ArrowLeft') {
          e.preventDefault();
          tlStop();
          tlStep(-1);
        }
        if (e.key === 'ArrowRight') {
          e.preventDefault();
          tlStop();
          tlStep(1);
        }
        if (e.key === 'End') {
          e.preventDefault();
          tlStop();
          tlGoTo(TL.snapshots.length - 1);
        }
      });

      TL.ready = true;
    }

    // After a brief delay, invalidate map size (tab may not be visible yet)
    setTimeout(function () {
      if (TL.map) TL.map.invalidateSize();
    }, 100);

    // Load snapshot list
    try {
      const bounds = await apiFetch('/api/timeline/bounds').then(function (r) {
        return r.json();
      });
      if (!bounds || !bounds.count) {
        $('#tl-info').textContent = i18next.t('web:timeline.no_snapshots', { interval: 5 });
        return;
      }
      TL.snapshots = await apiFetch('/api/timeline/snapshots?from=' + bounds.earliest + '&to=' + bounds.latest).then(
        function (r) {
          return r.json();
        },
      );
      if (!TL.snapshots.length) return;

      const slider = $('#tl-slider');
      if (slider) {
        slider.min = 0;
        slider.max = TL.snapshots.length - 1;
        slider.value = TL.snapshots.length - 1;
      }

      // Load latest snapshot
      tlGoTo(TL.snapshots.length - 1);
      // Load death markers
      tlLoadDeaths();
    } catch (e) {
      console.warn('[TL] Init error:', e);
      $('#tl-info').textContent = 'Timeline unavailable';
    }
  }

  async function tlGoTo(idx) {
    if (idx < 0 || idx >= TL.snapshots.length) return;
    TL.idx = idx;
    const slider = $('#tl-slider');
    if (slider) slider.value = idx;
    tlUpdateInfo();

    try {
      const snap = TL.snapshots[idx];
      TL.data = await apiFetch('/api/timeline/snapshot/' + snap.id).then(function (r) {
        return r.json();
      });
      TL.nameMap = TL.data.nameMap || {};
      tlRender();
    } catch (e) {
      console.warn('[TL] Snapshot load error:', e);
    }
  }

  function tlUpdateInfo() {
    const info = $('#tl-info');
    if (!info) return;
    const s = TL.snapshots[TL.idx];
    if (!s) {
      info.textContent = i18next.t('web:timeline.no_data');
      return;
    }
    const d = new Date(s.created_at + (s.created_at.endsWith('Z') ? '' : 'Z'));
    const time = window.fmtTime ? window.fmtTime(d) : d.toLocaleTimeString();
    const date = window.fmtDate ? window.fmtDate(d) : d.toLocaleDateString();
    const w = s.weather_type || '';
    const sn = s.season || '';
    const day = s.game_day ? i18next.t('web:dashboard.day') + ' ' + s.game_day : '';
    info.innerHTML =
      '<b>' +
      date +
      ' ' +
      time +
      '</b> · ' +
      day +
      ' · ' +
      w +
      ' · ' +
      sn +
      ' · 👤' +
      (s.online_count || 0) +
      '/' +
      (s.player_count || 0) +
      ' 🧟' +
      (s.ai_count || 0) +
      ' 🚗' +
      (s.vehicle_count || 0) +
      ' 🏗️' +
      (s.structure_count || 0) +
      ' <span class="text-muted text-[10px]">(' +
      (TL.idx + 1) +
      '/' +
      TL.snapshots.length +
      ')</span>';
  }

  function tlRender() {
    if (!TL.data || !TL.map) return;
    const d = TL.data;

    // Clear entity layers (not deaths — those are loaded separately)
    ['players', 'zombies', 'animals', 'bandits', 'vehicles', 'structures', 'companions', 'backpacks'].forEach(
      function (k) {
        TL.layers[k].clearLayers();
      },
    );

    // Players
    if (TL.visible.players && d.players) {
      d.players.forEach(function (p) {
        if (p.lat == null) return;
        const online = !!p.online;
        const icon = tlIcon(online ? '#6dba82' : '#7a746c', online ? 14 : 10, 'circle', p.name);
        const m = L.marker([p.lat, p.lng], { icon: icon, zIndexOffset: online ? 1000 : 500 });
        m.bindTooltip((online ? '🟢 ' : '') + p.name, { direction: 'top', offset: [0, -8] });
        m.bindPopup(
          '<div class="tl-popup"><b>' +
            esc(p.name) +
            '</b> ' +
            (online ? '🟢' : '🔴') +
            '<br>' +
            '❤️ ' +
            Math.round(p.health || 0) +
            '/' +
            (p.max_health || 100) +
            ' | 🍖 ' +
            Math.round(p.hunger || 0) +
            ' | 💧 ' +
            Math.round(p.thirst || 0) +
            '<br>' +
            '🧟 Kills: ' +
            (p.zeeks_killed || 0) +
            ' | ⭐ Lvl ' +
            (p.level || 0) +
            '<br>' +
            '📅 Days: ' +
            (p.days_survived || 0) +
            '</div>',
        );
        m.addTo(TL.layers.players);
      });
    }

    // AI
    if (d.ai) {
      d.ai.forEach(function (a) {
        if (a.lat == null) return;
        const cat = a.category || 'zombie';
        if (cat === 'zombie' && !TL.visible.zombies) return;
        if (cat === 'animal' && !TL.visible.animals) return;
        if (cat === 'bandit' && !TL.visible.bandits) return;
        const icon =
          cat === 'animal'
            ? tlIcon('#e67e22', 6, 'diamond')
            : cat === 'bandit'
              ? tlIcon('#e74c3c', 7, 'square')
              : tlIcon('#9b59b6', 5, 'circle');
        const layerKey = cat === 'animal' ? 'animals' : cat === 'bandit' ? 'bandits' : 'zombies';
        const m = L.marker([a.lat, a.lng], { icon: icon });
        m.bindTooltip(a.display_name || a.ai_type, { direction: 'top', offset: [0, -5] });
        m.addTo(TL.layers[layerKey]);
      });
    }

    // Vehicles
    if (TL.visible.vehicles && d.vehicles) {
      d.vehicles.forEach(function (v) {
        if (v.lat == null) return;
        const m = L.marker([v.lat, v.lng], { icon: tlIcon('#3498db', 9, 'square') });
        const name = v.display_name || v.class || i18next.t('web:activity.vehicle');
        m.bindTooltip(name, { direction: 'top', offset: [0, -7] });
        m.bindPopup(
          '<div class="tl-popup"><b>' +
            esc(name) +
            '</b><br>❤️ ' +
            Math.round(v.health || 0) +
            '/' +
            (v.max_health || 0) +
            '<br>⛽ ' +
            Math.round((v.fuel || 0) * 10) / 10 +
            'L<br>📦 ' +
            (v.item_count || 0) +
            ' items</div>',
        );
        m.addTo(TL.layers.vehicles);
      });
    }

    // Structures
    if (TL.visible.structures && d.structures) {
      d.structures.forEach(function (s) {
        if (s.lat == null) return;
        const m = L.marker([s.lat, s.lng], { icon: tlIcon('#95a5a6', 4, 'square') });
        const name = s.display_name || s.actor_class || i18next.t('web:activity.structure');
        const owner = TL.nameMap[s.owner_steam_id] || s.owner_steam_id || '?';
        m.bindTooltip(name, { direction: 'top', offset: [0, -5] });
        m.bindPopup(
          '<div class="tl-popup"><b>' +
            esc(name) +
            '</b><br>Owner: ' +
            esc(owner) +
            '<br>❤️ ' +
            Math.round(s.current_health || 0) +
            '/' +
            (s.max_health || 0) +
            '<br>⬆️ Tier ' +
            (s.upgrade_level || 0) +
            '</div>',
        );
        m.addTo(TL.layers.structures);
      });
    }

    // Companions
    if (TL.visible.companions && d.companions) {
      d.companions.forEach(function (c) {
        if (c.lat == null) return;
        const m = L.marker([c.lat, c.lng], { icon: tlIcon('#f1c40f', 7, 'diamond') });
        const name = c.display_name || c.entity_type || 'Companion';
        const owner = TL.nameMap[c.owner_steam_id] || '';
        m.bindTooltip(name + (owner ? ' (' + owner + ')' : ''), { direction: 'top', offset: [0, -6] });
        m.addTo(TL.layers.companions);
      });
    }

    // Backpacks
    if (TL.visible.backpacks && d.backpacks) {
      d.backpacks.forEach(function (b) {
        if (b.lat == null) return;
        const m = L.marker([b.lat, b.lng], { icon: tlIcon('#8e44ad', 6, 'square') });
        m.bindTooltip('Backpack (' + (b.item_count || 0) + ' items)', { direction: 'top', offset: [0, -5] });
        m.addTo(TL.layers.backpacks);
      });
    }

    // Update counts
    const counts = {
      players: d.players ? d.players.length : 0,
      zombies: d.ai
        ? d.ai.filter(function (a) {
            return a.category === 'zombie';
          }).length
        : 0,
      animals: d.ai
        ? d.ai.filter(function (a) {
            return a.category === 'animal';
          }).length
        : 0,
      bandits: d.ai
        ? d.ai.filter(function (a) {
            return a.category === 'bandit';
          }).length
        : 0,
      vehicles: d.vehicles ? d.vehicles.length : 0,
      structures: d.structures ? d.structures.length : 0,
      companions: d.companions ? d.companions.length : 0,
      backpacks: d.backpacks ? d.backpacks.length : 0,
    };
    for (const k in counts) {
      const countEl = $('#tl-c-' + k);
      if (countEl) countEl.textContent = counts[k];
    }
  }

  async function tlLoadDeaths() {
    try {
      const deaths = await apiFetch('/api/timeline/deaths?limit=200').then(function (r) {
        return r.json();
      });
      TL.layers.deaths.clearLayers();
      deaths.forEach(function (d) {
        if (d.lat == null) return;
        const m = L.marker([d.lat, d.lng], { icon: tlIcon('#ff0000', 8, 'circle', 'Death'), zIndexOffset: -100 });
        const cause = d.cause_name || d.cause_type || 'Unknown';
        const t = fmtDateTime(d.created_at);
        m.bindPopup(
          '<div class="tl-popup"><b>💀 ' +
            esc(d.victim_name || '?') +
            '</b><br>Killed by: ' +
            esc(cause) +
            ' (' +
            esc(d.cause_type || '') +
            ')<br>Dmg: ' +
            Math.round(d.damage_total || 0) +
            '<br><small>' +
            t +
            '</small></div>',
        );
        m.addTo(TL.layers.deaths);
      });
    } catch (e) {
      console.warn('[TL] Deaths error:', e);
    }
  }

  function tlTogglePlay() {
    TL.playing ? tlStop() : tlPlay();
  }

  function tlPlay() {
    if (TL.playing || !TL.snapshots.length) return;
    TL.playing = true;
    const btn = $('#tl-play');
    if (btn) {
      btn.innerHTML = '<i data-lucide="pause" class="w-3.5 h-3.5"></i>';
      if (window.lucide) lucide.createIcons({ nodes: [btn] });
    }
    const interval = Math.max(200, 2000 / TL.speed);
    TL.timer = setInterval(function () {
      if (TL.idx >= TL.snapshots.length - 1) {
        tlStop();
        return;
      }
      tlGoTo(TL.idx + 1);
    }, interval);
  }

  function tlStop() {
    TL.playing = false;
    if (TL.timer) {
      clearInterval(TL.timer);
      TL.timer = null;
    }
    const btn = $('#tl-play');
    if (btn) {
      btn.innerHTML = '<i data-lucide="play" class="w-3.5 h-3.5"></i>';
      if (window.lucide) lucide.createIcons({ nodes: [btn] });
    }
  }

  function tlStep(dir) {
    const next = TL.idx + dir;
    if (next >= 0 && next < TL.snapshots.length) tlGoTo(next);
  }

  function reset() {
    if (TL.timer) clearInterval(TL.timer);
    TL.playing = false;
    TL.timer = null;
    TL.snapshots = [];
    TL.idx = -1;
    TL.data = null;
    TL.nameMap = {};
    if (TL.map) {
      Object.keys(TL.layers).forEach(function (k) {
        TL.layers[k].clearLayers();
      });
    }
  }

  Panel.tabs.timeline = { init: initTimeline, load: function () {}, reset: reset };
})();

/* eslint-env browser */
/* global L, map, authFetch, simplifyName */

/**
 * Timeline Controller — time-scroll playback of world state snapshots.
 *
 * Adds a timeline slider, playback controls, and layer toggles to the
 * Leaflet map. Fetches snapshot data from /api/timeline/* endpoints and
 * renders entity markers on the map.
 */

// ── Layer groups for each entity type ──────────────────────
const timelineLayers = {
  players:    L.layerGroup(),
  zombies:    L.layerGroup(),
  animals:    L.layerGroup(),
  bandits:    L.layerGroup(),
  vehicles:   L.layerGroup(),
  structures: L.layerGroup(),
  companions: L.layerGroup(),
  backpacks:  L.layerGroup(),
  trails:     L.layerGroup(),
  deaths:     L.layerGroup(),
};

// ── State ──────────────────────────────────────────────────
let timelineActive = false;
let snapshots = [];         // metadata list for slider
let currentSnapIndex = -1;  // current position in snapshots[]
let currentSnapData = null; // full entity data for current snapshot
let playbackTimer = null;
let playbackSpeed = 1;      // 1 = 1x, 2 = 2x, etc.
let selectedTrailPlayer = null;
let trailData = [];

// Layer visibility
const layerVisibility = {
  players: true, zombies: true, animals: true, bandits: true,
  vehicles: true, structures: false, companions: true, backpacks: false,
  trails: true, deaths: true,
};

function tTimeline(key, vars) {
  return i18next.t(`web:timeline.${key}`, vars);
}

// ── Entity Icons ───────────────────────────────────────────

function makeIcon(color, size, shape = 'circle', label = '') {
  const shapeCSS = shape === 'diamond'
    ? `width:${size}px;height:${size}px;transform:rotate(45deg);border-radius:2px;`
    : shape === 'square'
      ? `width:${size}px;height:${size}px;border-radius:2px;`
      : `width:${size}px;height:${size}px;border-radius:50%;`;

  return L.divIcon({
    className: 'timeline-marker',
    html: `<div style="${shapeCSS}background:${color};border:1.5px solid rgba(255,255,255,0.4);box-shadow:0 0 4px ${color}60;" title="${label}"></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

const ICONS = {
  playerOnline:  (name) => makeIcon('#3fb950', 14, 'circle', name),
  playerOffline: (name) => makeIcon('#da3633', 10, 'circle', name),
  zombie:    makeIcon('#9b59b6', 6, 'circle', tTimeline('entity_labels.zombie')),
  animal:    makeIcon('#e67e22', 7, 'diamond', tTimeline('entity_labels.animal')),
  bandit:    makeIcon('#e74c3c', 8, 'square', tTimeline('entity_labels.bandit')),
  vehicle:   makeIcon('#3498db', 10, 'square', tTimeline('entity_labels.vehicle')),
  structure: makeIcon('#95a5a6', 5, 'square', tTimeline('entity_labels.structure')),
  companion: makeIcon('#f1c40f', 8, 'diamond', tTimeline('entity_labels.companion')),
  backpack:  makeIcon('#8e44ad', 7, 'square', tTimeline('entity_labels.backpack')),
  death:     makeIcon('#ff0000', 10, 'circle', tTimeline('entity_labels.death')),
};

// ── Fetch helpers ──────────────────────────────────────────

async function fetchJSON(url) {
  const res = typeof authFetch === 'function' ? await authFetch(url) : await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

// ── Timeline Controller ────────────────────────────────────

async function initTimeline() {
  try {
    const bounds = await fetchJSON('/api/timeline/bounds');
    if (!bounds || !bounds.count || bounds.count === 0) {
      console.log('[TIMELINE]', tTimeline('status.no_snapshot_data'));
      return;
    }

    // Show timeline controls
    const panel = document.getElementById('timeline-panel');
    if (panel) panel.style.display = 'flex';

    // Load all snapshot metadata
    snapshots = await fetchJSON(`/api/timeline/snapshots?from=${bounds.earliest}&to=${bounds.latest}`);
    if (!snapshots.length) return;

    // Configure slider
    const slider = document.getElementById('timeline-slider');
    if (slider) {
      slider.min = 0;
      slider.max = snapshots.length - 1;
      slider.value = snapshots.length - 1;
      slider.addEventListener('input', onSliderChange);
    }

    updateSnapshotInfo(snapshots.length - 1);
    console.log(`[TIMELINE] Loaded ${snapshots.length} snapshots (${bounds.earliest} → ${bounds.latest})`);
  } catch (err) {
    console.warn('[TIMELINE] Init failed:', err.message);
  }
}

function onSliderChange(e) {
  const idx = parseInt(e.target.value, 10);
  loadSnapshot(idx);
}

async function loadSnapshot(idx) {
  if (idx < 0 || idx >= snapshots.length) return;
  currentSnapIndex = idx;
  updateSnapshotInfo(idx);

  const snap = snapshots[idx];
  try {
    currentSnapData = await fetchJSON(`/api/timeline/snapshot/${snap.id}`);
    renderTimelineEntities();
  } catch (err) {
    console.warn('[TIMELINE] Failed to load snapshot', snap.id, err.message);
  }
}

function updateSnapshotInfo(idx) {
  const snap = snapshots[idx];
  if (!snap) return;
  const infoEl = document.getElementById('timeline-info');
  if (!infoEl) return;

  const date = new Date(snap.created_at);
  const time = window.fmtTime ? window.fmtTime(date) : date.toLocaleTimeString();
  const dateStr = window.fmtDate ? window.fmtDate(date) : date.toLocaleDateString();
  const weather = snap.weather_type || '—';
  const season = snap.season || '—';
  const dayInfo = snap.game_day ? tTimeline('snapshot.day', { day: snap.game_day }) : '';

  infoEl.innerHTML = `
    <span class="tl-date">${dateStr} ${time}</span>
    <span class="tl-sep">|</span>
    <span class="tl-day">${dayInfo}</span>
    <span class="tl-sep">|</span>
    <span class="tl-weather">${weather}</span>
    <span class="tl-sep">|</span>
    <span class="tl-season">${season}</span>
    <span class="tl-sep">|</span>
    <span class="tl-counts">
      👤${snap.online_count || 0}/${snap.player_count || 0}
      🧟${snap.ai_count || 0}
      🚗${snap.vehicle_count || 0}
      🏗️${snap.structure_count || 0}
    </span>
  `;
}

// ── Render entities for current snapshot ────────────────────

function renderTimelineEntities() {
  if (!currentSnapData) return;

  // Clear all timeline layers
  Object.values(timelineLayers).forEach(layer => {
    layer.clearLayers();
  });

  const d = currentSnapData;
  const nameMap = d.nameMap || {};

  // Players
  if (layerVisibility.players && d.players) {
    for (const p of d.players) {
      if (p.lat == null || p.lng == null) continue;
      const icon = p.online ? ICONS.playerOnline(p.name) : ICONS.playerOffline(p.name);
      const m = L.marker([p.lat, p.lng], { icon, zIndexOffset: p.online ? 1000 : 500 });
      const statusIcon = p.online ? '🟢' : '🔴';
      m.bindTooltip(`${statusIcon} ${p.name}`, { direction: 'top', offset: [0, -8] });
      m.bindPopup(`
        <div class="tl-popup">
          <b>${p.name}</b> ${statusIcon}<br>
          <small>${p.steam_id}</small><br>
          ❤️ ${Math.round(p.health)}/${p.max_health} |
          🍖 ${Math.round(p.hunger)} | 💧 ${Math.round(p.thirst)}<br>
          🧟 ${tTimeline('popup.kills')}: ${p.zeeks_killed} | ⭐ ${tTimeline('popup.level_short')} ${p.level}<br>
          📅 ${tTimeline('popup.days')}: ${p.days_survived}
        </div>
      `);
      m.on('click', () => {
        selectedTrailPlayer = p.steam_id;
        loadPlayerTrail(p.steam_id, p.name);
      });
      m.addTo(timelineLayers.players);
    }
  }

  // Zombies / Animals / Bandits
  if (d.ai) {
    for (const a of d.ai) {
      if (a.lat == null || a.lng == null) continue;
      const cat = a.category || 'zombie';
      if (cat === 'zombie' && !layerVisibility.zombies) continue;
      if (cat === 'animal' && !layerVisibility.animals) continue;
      if (cat === 'bandit' && !layerVisibility.bandits) continue;

      const icon = cat === 'animal' ? ICONS.animal : cat === 'bandit' ? ICONS.bandit : ICONS.zombie;
      const layerKey = cat === 'animal' ? 'animals' : cat === 'bandit' ? 'bandits' : 'zombies';
      const m = L.marker([a.lat, a.lng], { icon });
      m.bindTooltip(a.display_name || a.ai_type, { direction: 'top', offset: [0, -6] });
      m.addTo(timelineLayers[layerKey]);
    }
  }

  // Vehicles
  if (layerVisibility.vehicles && d.vehicles) {
    for (const v of d.vehicles) {
      if (v.lat == null || v.lng == null) continue;
      const m = L.marker([v.lat, v.lng], { icon: ICONS.vehicle });
      const name = v.display_name || simplifyName(v.class) || tTimeline('entity_labels.vehicle');
      const fuelPct = v.max_health > 0 ? Math.round((v.health / v.max_health) * 100) : 0;
      m.bindTooltip(name, { direction: 'top', offset: [0, -8] });
      m.bindPopup(`
        <div class="tl-popup">
          <b>${name}</b><br>
          ❤️ ${Math.round(v.health)}/${v.max_health}<br>
          ⛽ ${Math.round(v.fuel * 10) / 10}L<br>
          📦 ${v.item_count} ${tTimeline('popup.items')}
        </div>
      `);
      m.addTo(timelineLayers.vehicles);
    }
  }

  // Structures
  if (layerVisibility.structures && d.structures) {
    for (const s of d.structures) {
      if (s.lat == null || s.lng == null) continue;
      const m = L.marker([s.lat, s.lng], { icon: ICONS.structure });
      const name = s.display_name || simplifyName(s.actor_class) || tTimeline('entity_labels.structure');
      const owner = nameMap[s.owner_steam_id] || s.owner_steam_id || tTimeline('popup.unknown');
      m.bindTooltip(name, { direction: 'top', offset: [0, -6] });
      m.bindPopup(`
        <div class="tl-popup">
          <b>${name}</b><br>
          ${tTimeline('popup.owner')}: ${owner}<br>
          ❤️ ${Math.round(s.current_health)}/${s.max_health}<br>
          ⬆️ ${tTimeline('popup.upgrade')}: ${s.upgrade_level}
        </div>
      `);
      m.addTo(timelineLayers.structures);
    }
  }

  // Companions
  if (layerVisibility.companions && d.companions) {
    for (const c of d.companions) {
      if (c.lat == null || c.lng == null) continue;
      const m = L.marker([c.lat, c.lng], { icon: ICONS.companion });
      const name = c.display_name || c.entity_type || tTimeline('entity_labels.companion');
      const owner = nameMap[c.owner_steam_id] || c.owner_steam_id || tTimeline('popup.unknown');
      m.bindTooltip(`${name} (${owner})`, { direction: 'top', offset: [0, -8] });
      m.addTo(timelineLayers.companions);
    }
  }

  // Backpacks
  if (layerVisibility.backpacks && d.backpacks) {
    for (const b of d.backpacks) {
      if (b.lat == null || b.lng == null) continue;
      const m = L.marker([b.lat, b.lng], { icon: ICONS.backpack });
      m.bindTooltip(tTimeline('popup.backpack_items', { count: b.item_count }), { direction: 'top', offset: [0, -6] });
      m.addTo(timelineLayers.backpacks);
    }
  }

  // Update entity count displays
  updateLayerCounts(d);
}

function updateLayerCounts(d) {
  const counts = {
    players: d.players?.length || 0,
    zombies: d.ai?.filter(a => a.category === 'zombie').length || 0,
    animals: d.ai?.filter(a => a.category === 'animal').length || 0,
    bandits: d.ai?.filter(a => a.category === 'bandit').length || 0,
    vehicles: d.vehicles?.length || 0,
    structures: d.structures?.length || 0,
    companions: d.companions?.length || 0,
    backpacks: d.backpacks?.length || 0,
  };
  for (const [key, count] of Object.entries(counts)) {
    const el = document.getElementById(`tl-count-${key}`);
    if (el) el.textContent = count;
  }
}

// ── Player trail ───────────────────────────────────────────

async function loadPlayerTrail(steamId, name) {
  if (!snapshots.length) return;
  const from = snapshots[0].created_at;
  const to = snapshots[snapshots.length - 1].created_at;

  try {
    trailData = await fetchJSON(`/api/timeline/player/${steamId}/trail?from=${from}&to=${to}`);
    renderTrail(name);
  } catch (err) {
    console.warn('[TIMELINE] Trail load failed:', err.message);
  }
}

function renderTrail(name) {
  timelineLayers.trails.clearLayers();
  if (!layerVisibility.trails || !trailData.length) return;

  // Build polyline from positions
  const latlngs = trailData.map(p => [p.lat, p.lng]);
  const trail = L.polyline(latlngs, {
    color: '#58a6ff',
    weight: 2,
    opacity: 0.7,
    dashArray: '5, 5',
  });
  trail.bindTooltip(tTimeline('trail.tooltip', {
    name: name || tTimeline('trail.player'),
    points: trailData.length,
  }), { sticky: true });
  trail.addTo(timelineLayers.trails);

  // Add start/end markers
  if (latlngs.length >= 2) {
    L.circleMarker(latlngs[0], { radius: 5, color: '#3fb950', fillOpacity: 0.8, weight: 1 })
      .bindTooltip(tTimeline('trail.start')).addTo(timelineLayers.trails);
    L.circleMarker(latlngs[latlngs.length - 1], { radius: 5, color: '#da3633', fillOpacity: 0.8, weight: 1 })
      .bindTooltip(tTimeline('trail.end')).addTo(timelineLayers.trails);
  }
}

// ── Death markers ──────────────────────────────────────────

async function loadDeaths() {
  try {
    const deaths = await fetchJSON('/api/timeline/deaths?limit=100');
    timelineLayers.deaths.clearLayers();
    if (!layerVisibility.deaths) return;
    for (const d of deaths) {
      if (d.lat == null || d.lng == null) continue;
      const m = L.marker([d.lat, d.lng], { icon: ICONS.death, zIndexOffset: -100 });
      const cause = d.cause_name || d.cause_type || tTimeline('popup.unknown');
      const deathDate = new Date(d.created_at);
      const time = window.fmtDate && window.fmtTime
        ? `${window.fmtDate(deathDate)} ${window.fmtTime(deathDate)}`
        : deathDate.toLocaleString();
      m.bindPopup(`
        <div class="tl-popup">
          <b>💀 ${d.victim_name}</b><br>
          ${tTimeline('popup.killed_by')}: ${cause} (${d.cause_type})<br>
          ${tTimeline('popup.damage')}: ${Math.round(d.damage_total)}<br>
          <small>${time}</small>
        </div>
      `);
      m.addTo(timelineLayers.deaths);
    }
  } catch (err) {
    console.warn('[TIMELINE] Deaths load failed:', err.message);
  }
}

// ── Playback controls ──────────────────────────────────────

function togglePlayback() {
  if (playbackTimer) {
    stopPlayback();
  } else {
    startPlayback();
  }
}

function startPlayback() {
  if (playbackTimer) return;
  if (currentSnapIndex < 0) currentSnapIndex = 0;

  const btn = document.getElementById('tl-play-btn');
  if (btn) {
    btn.textContent = '⏸';
    btn.title = tTimeline('controls.pause');
    btn.setAttribute('aria-label', tTimeline('controls.pause'));
  }

  const interval = Math.max(200, 2000 / playbackSpeed);
  playbackTimer = setInterval(() => {
    if (currentSnapIndex >= snapshots.length - 1) {
      stopPlayback();
      return;
    }
    currentSnapIndex++;
    const slider = document.getElementById('timeline-slider');
    if (slider) slider.value = currentSnapIndex;
    loadSnapshot(currentSnapIndex);
  }, interval);
}

function stopPlayback() {
  if (playbackTimer) {
    clearInterval(playbackTimer);
    playbackTimer = null;
  }
  const btn = document.getElementById('tl-play-btn');
  if (btn) {
    btn.textContent = '▶';
    btn.title = tTimeline('controls.play');
    btn.setAttribute('aria-label', tTimeline('controls.play'));
  }
}

function setPlaybackSpeed(speed) {
  playbackSpeed = speed;
  const wasPlaying = !!playbackTimer;
  if (wasPlaying) {
    stopPlayback();
    startPlayback();
  }
  // Update speed button styles
  document.querySelectorAll('.tl-speed-btn').forEach(b => {
    b.classList.toggle('active', parseInt(b.dataset.speed, 10) === speed);
    b.title = tTimeline('controls.speed', { speed: b.dataset.speed });
    b.setAttribute('aria-label', tTimeline('controls.speed', { speed: b.dataset.speed }));
  });
}

function stepBackward() {
  stopPlayback();
  if (currentSnapIndex > 0) {
    currentSnapIndex--;
    const slider = document.getElementById('timeline-slider');
    if (slider) slider.value = currentSnapIndex;
    loadSnapshot(currentSnapIndex);
  }
}

function stepForward() {
  stopPlayback();
  if (currentSnapIndex < snapshots.length - 1) {
    currentSnapIndex++;
    const slider = document.getElementById('timeline-slider');
    if (slider) slider.value = currentSnapIndex;
    loadSnapshot(currentSnapIndex);
  }
}

function goToLatest() {
  stopPlayback();
  currentSnapIndex = snapshots.length - 1;
  const slider = document.getElementById('timeline-slider');
  if (slider) slider.value = currentSnapIndex;
  loadSnapshot(currentSnapIndex);
}

// ── Toggle timeline mode (live vs timeline) ────────────────

function toggleTimelineMode() {
  timelineActive = !timelineActive;
  const panel = document.getElementById('timeline-panel');
  const btn = document.getElementById('btn-timeline');
  const liveControls = document.getElementById('topbar');

  if (timelineActive) {
    if (btn) btn.classList.add('active');
    // Add all timeline layers to map
    Object.entries(timelineLayers).forEach(([key, layer]) => {
      if (layerVisibility[key]) layer.addTo(map);
    });
    // Hide live player markers
    if (typeof markersGroup !== 'undefined') map.removeLayer(markersGroup);
    // Load latest snapshot
    if (snapshots.length) {
      loadSnapshot(snapshots.length - 1);
    }
    loadDeaths();
  } else {
    if (btn) btn.classList.remove('active');
    // Remove all timeline layers
    Object.values(timelineLayers).forEach(layer => {
      map.removeLayer(layer);
    });
    // Restore live player markers
    if (typeof markersGroup !== 'undefined') markersGroup.addTo(map);
    stopPlayback();
  }
}

// ── Layer toggle ───────────────────────────────────────────

function toggleLayer(layerKey) {
  layerVisibility[layerKey] = !layerVisibility[layerKey];
  const cb = document.getElementById(`tl-layer-${layerKey}`);
  if (cb) cb.checked = layerVisibility[layerKey];

  if (timelineActive) {
    if (layerVisibility[layerKey]) {
      timelineLayers[layerKey].addTo(map);
    } else {
      map.removeLayer(timelineLayers[layerKey]);
    }
    // Re-render to apply visibility changes
    if (currentSnapData) renderTimelineEntities();
    if (layerKey === 'trails' && trailData.length) renderTrail(selectedTrailPlayer);
    if (layerKey === 'deaths') loadDeaths();
  }
}

// ── Keyboard shortcuts ─────────────────────────────────────

document.addEventListener('keydown', (e) => {
  if (!timelineActive) return;
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

  switch (e.key) {
    case ' ':
      e.preventDefault();
      togglePlayback();
      break;
    case 'ArrowLeft':
      e.preventDefault();
      stepBackward();
      break;
    case 'ArrowRight':
      e.preventDefault();
      stepForward();
      break;
    case 'End':
      e.preventDefault();
      goToLatest();
      break;
  }
});

// ── Init on load ───────────────────────────────────────────
// Wait for the map to be ready, then initialise
if (typeof map !== 'undefined') {
  initTimeline();
}

/* exported selectPlayer, closePlayerPanel, refreshPlayers, kickPlayer, banPlayer, sendMessage */
// ── Map setup ──────────────────────────────────────────────
const MAP_SIZE = 4096;
const mapBounds = [
  [0, 0],
  [MAP_SIZE, MAP_SIZE],
];

const map = L.map('map', {
  crs: L.CRS.Simple,
  minZoom: -2,
  maxZoom: 4,
  zoomSnap: 0.5,
  zoomDelta: 0.5,
  attributionControl: false,
});

const _mapImage = L.imageOverlay('terrain.png', mapBounds, { className: 'map-terrain' }).addTo(map);
map.fitBounds(mapBounds);

// Adjust map size for flex layout
map.invalidateSize();

// ── Player markers layer group ─────────────────────────────
const markersGroup = L.layerGroup().addTo(map);
let playerData = [];
let showOffline = true;
let autoRefreshTimer = null;
let currentServer = 'primary'; // multi-server: currently selected server ID

// 3-tier player status: online (green), offline (red), inactive 3+ days (grey)
const INACTIVE_DAYS = 3;

function getPlayerStatus(p) {
  if (p.isOnline) return 'online';
  if (p.lastSeen) {
    const daysSince = (Date.now() - new Date(p.lastSeen).getTime()) / (1000 * 60 * 60 * 24);
    if (daysSince >= INACTIVE_DAYS) return 'inactive';
  }
  return 'offline';
}

function createPlayerIcon(status) {
  const styles = {
    online: {
      size: 16,
      bg: '#3fb950',
      border: '#238636',
      shadow: '0 0 10px rgba(63,185,80,0.6)',
      cls: 'marker-online',
    },
    offline: { size: 12, bg: '#da3633', border: '#b62324', shadow: 'none', cls: 'marker-offline' },
    inactive: { size: 10, bg: '#484f58', border: '#30363d', shadow: 'none', cls: 'marker-inactive' },
  };
  const s = styles[status] || styles.offline;
  return L.divIcon({
    className: `player-marker ${s.cls}`,
    html: `<div style="
      width: ${s.size}px; height: ${s.size}px; border-radius: 50%;
      background: ${s.bg}; border: 2px solid ${s.border};
      box-shadow: ${s.shadow};
      transition: all 0.3s;
    "></div>`,
    iconSize: [s.size, s.size],
    iconAnchor: [s.size / 2, s.size / 2],
  });
}

// ── Utility: format playtime ───────────────────────────────
function formatPlaytime(minutes) {
  if (!minutes) return '—';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// ── Utility: format vital bar ──────────────────────────────
function vitalBar(label, value, max, color) {
  if (value === null || value === undefined) return '';
  const pct = Math.min(100, Math.max(0, (value / max) * 100));
  return `
    <div class="vital-bar">
      <span class="bar-label">${label}</span>
      <span class="bar-bg"><span class="bar-fill" style="width:${pct}%;background:${color}"></span></span>
      <span class="bar-val">${Math.round(value)}/${max}</span>
    </div>`;
}

// ── Utility: simplify blueprint name ───────────────────────
function simplifyName(raw) {
  if (!raw) return raw;
  if (typeof raw === 'object') raw = raw.item || raw.name || String(raw);
  if (typeof raw !== 'string') return String(raw);
  return raw
    .replace(/^BP_/i, '')
    .replace(/_C$/i, '')
    .replace(/_\d+$/, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2');
}

// ── Server-provided display toggles (updated on each fetch) ──
let displayToggles = {};

// ── Build detail panel content for a player ────────────────
function buildPlayerDetail(p) {
  const t = displayToggles;
  const td = (key, vars) => i18next.t(`web:map.player_detail.${key}`, vars);
  const status = getPlayerStatus(p);
  const statusLabel =
    status === 'online'
      ? `<span style="color:#3fb950">● ${i18next.t('web:map.online')}</span>`
      : status === 'inactive'
        ? `<span style="color:#484f58">● ${i18next.t('web:map.inactive')}</span>`
        : `<span style="color:#da3633">● ${i18next.t('web:map.offline')}</span>`;
  const lastSeenStr = p.lastSeen ? new Date(p.lastSeen).toLocaleString() : td('unknown');

  let html = `<div class="player-popup">`;
  html += `<h3>${escapeHtml(p.name)} ${statusLabel}</h3>`;
  html += `<div class="steam-id">${p.steamId}</div>`;
  if (t.showCoordinates && p.hasPosition) {
    html += `<div class="coordinates">${td('world_coordinates', { x: p.worldX, y: p.worldY, z: p.worldZ })}</div>`;
  }
  html += `<div class="coordinates">${td('last_seen', { value: lastSeenStr })}</div>`;
  html += `<div class="coordinates">${td('playtime', { value: formatPlaytime(p.totalPlaytime) })}</div>`;

  // ── Character & Survival stats ──
  html += `<div class="stat-grid">`;
  html += `<span class="label">${td('profession')}</span><span class="value">${p.profession || '\u2014'}</span>`;
  html += `<span class="label">${td('affliction')}</span><span class="value">${p.affliction || '\u2014'}</span>`;
  html += `<span class="label">${td('days_survived')}</span><span class="value">${p.daysSurvived || 0}</span>`;
  if (p.hasExtendedStats) {
    html += `<span class="label">${td('lifetime_days')}</span><span class="value">${p.lifetimeDaysSurvived || 0}</span>`;
  }
  html += `<span class="label">${td('z_kills')}</span><span class="value">${(p.zeeksKilled || 0).toLocaleString()}</span>`;
  html += `<span class="label">${td('headshots')}</span><span class="value">${(p.headshots || 0).toLocaleString()}</span>`;
  html += `<span class="label">${td('melee_kills')}</span><span class="value">${(p.meleeKills || 0).toLocaleString()}</span>`;
  html += `<span class="label">${td('gun_kills')}</span><span class="value">${(p.gunKills || 0).toLocaleString()}</span>`;
  if (p.blastKills)
    html += `<span class="label">${td('blast_kills')}</span><span class="value">${p.blastKills.toLocaleString()}</span>`;
  if (p.fistKills)
    html += `<span class="label">${td('fist_kills')}</span><span class="value">${p.fistKills.toLocaleString()}</span>`;
  if (p.takedownKills)
    html += `<span class="label">${td('takedowns')}</span><span class="value">${p.takedownKills.toLocaleString()}</span>`;
  if (p.vehicleKills)
    html += `<span class="label">${td('vehicle_kills')}</span><span class="value">${p.vehicleKills.toLocaleString()}</span>`;
  if (p.hasExtendedStats) {
    html += `<span class="label">${td('lifetime_kills')}</span><span class="value">${(p.lifetimeKills || 0).toLocaleString()}</span>`;
  }
  const fishPikeSuffix = p.fishCaughtPike ? ` ${td('pike_suffix', { count: p.fishCaughtPike })}` : '';
  html += `<span class="label">${td('fish_caught')}</span><span class="value">${p.fishCaught || 0}${fishPikeSuffix}</span>`;
  html += `<span class="label">${td('times_bitten')}</span><span class="value">${p.timesBitten || 0}</span>`;
  // Log-derived stats
  html += `<span class="label">${td('deaths')}</span><span class="value">${p.deaths || 0}</span>`;
  if (t.showPvpKills) {
    html += `<span class="label">${td('pvp_kills')}</span><span class="value">${p.pvpKills || 0}</span>`;
    html += `<span class="label">${td('pvp_deaths')}</span><span class="value">${p.pvpDeaths || 0}</span>`;
  }
  html += `<span class="label">${td('builds')}</span><span class="value">${p.builds || 0}</span>`;
  html += `<span class="label">${td('containers_looted')}</span><span class="value">${p.containersLooted || 0}</span>`;
  if (t.showRaidStats) {
    html += `<span class="label">${td('raids_out')}</span><span class="value">${p.raidsOut || 0}</span>`;
    html += `<span class="label">${td('raids_in')}</span><span class="value">${p.raidsIn || 0}</span>`;
  }
  if (t.showConnections) {
    html += `<span class="label">${td('connections')}</span><span class="value">${p.connects || 0}</span>`;
  }
  html += `</div>`;

  // ── Unlocked Professions ──
  if (p.unlockedProfessions && p.unlockedProfessions.length > 1) {
    html += `<div class="section-title">${td('unlocked_professions')}</div>`;
    html += `<div class="item-list">${p.unlockedProfessions.map((pr) => `<div>\u2022 ${pr}</div>`).join('')}</div>`;
  }

  // ── Skills ──
  if (p.unlockedSkills && p.unlockedSkills.length > 0) {
    html += `<div class="section-title">${td('skills_count', { count: p.unlockedSkills.length })}</div>`;
    html += `<div class="item-list">${p.unlockedSkills.map((s) => `<div>\u2022 ${simplifyName(s)}</div>`).join('')}</div>`;
  }

  // ── Recipes ──
  if (t.showRecipes !== false) {
    const craft = p.craftingRecipes || [];
    const build = p.buildingRecipes || [];
    if (t.showCraftingRecipes !== false && craft.length > 0) {
      html += `<div class="section-title">${td('crafting_recipes_count', { count: craft.length })}</div>`;
      html += `<div class="item-list">${craft.map((r) => `<div>\u2022 ${simplifyName(r)}</div>`).join('')}</div>`;
    }
    if (t.showBuildingRecipes !== false && build.length > 0) {
      html += `<div class="section-title">${td('building_recipes_count', { count: build.length })}</div>`;
      html += `<div class="item-list">${build.map((r) => `<div>\u2022 ${simplifyName(r)}</div>`).join('')}</div>`;
    }
  }

  // ── Vitals ──
  if (t.showVitals !== false) {
    html += `<div class="vitals">`;
    if (t.showHealth !== false) html += vitalBar(td('health'), p.health, p.maxHealth || 100, '#da3633');
    if (t.showHunger !== false) html += vitalBar(td('hunger'), p.hunger, p.maxHunger || 100, '#d29922');
    if (t.showThirst !== false) html += vitalBar(td('thirst'), p.thirst, p.maxThirst || 100, '#58a6ff');
    if (t.showStamina !== false) html += vitalBar(td('stamina'), p.stamina, p.maxStamina || 100, '#3fb950');
    if (t.showImmunity !== false) html += vitalBar(td('immunity'), p.infection, p.maxInfection || 100, '#bc8cff');
    if (t.showBattery !== false) html += vitalBar(td('battery'), p.battery, 100, '#d29922');
    html += `</div>`;
  }

  // ── Status Effects ──
  if (t.showStatusEffects !== false) {
    if (t.showFatigue !== false && p.fatigue) {
      html += `<div class="section-title">${td('fatigue')}</div>`;
      html += `<div class="item-list"><div>\u2022 ${Math.round(p.fatigue)}%</div></div>`;
    }
    if (t.showInfectionBuildup !== false && p.infectionBuildup) {
      html += `<div class="section-title">${td('infection_buildup')}</div>`;
      html += `<div class="item-list"><div>\u2022 ${Math.round(p.infectionBuildup)}%</div></div>`;
    }
    if (t.showPlayerStates !== false && p.playerStates && p.playerStates.length > 0) {
      html += `<div class="section-title">${td('status_effects_count', { count: p.playerStates.length })}</div>`;
      html += `<div class="item-list">${p.playerStates.map((s) => `<div>\u2022 ${simplifyName(s)}</div>`).join('')}</div>`;
    }
    if (t.showBodyConditions !== false && p.bodyConditions && p.bodyConditions.length > 0) {
      html += `<div class="section-title">${td('body_conditions_count', { count: p.bodyConditions.length })}</div>`;
      html += `<div class="item-list">${p.bodyConditions.map((s) => `<div>\u2022 ${simplifyName(s)}</div>`).join('')}</div>`;
    }
  }

  // ── Equipment ──
  if (t.showInventory !== false && t.showEquipment !== false && p.equipment && p.equipment.length > 0) {
    const items = p.equipment.filter((i) => {
      const n = typeof i === 'object' ? i.item : i;
      return n && n !== 'Empty';
    });
    if (items.length > 0) {
      html += `<div class="section-title">${td('equipment')}</div>`;
      html += `<div class="item-list">${items
        .map((i) => {
          const name = simplifyName(i);
          const dur =
            typeof i === 'object' && i.durability != null
              ? ` <span class="item-dur">(${Math.round(i.durability)}%)</span>`
              : '';
          return `<div>\u2022 ${name}${dur}</div>`;
        })
        .join('')}</div>`;
    }
  }

  // ── Quick Slots ──
  if (t.showInventory !== false && t.showQuickSlots !== false && p.quickSlots && p.quickSlots.length > 0) {
    const items = p.quickSlots.filter((i) => {
      const n = typeof i === 'object' ? i.item : i;
      return n && n !== 'Empty';
    });
    if (items.length > 0) {
      html += `<div class="section-title">${td('quick_slots')}</div>`;
      html += `<div class="item-list">${items.map((i) => `<div>\u2022 ${simplifyName(i)}</div>`).join('')}</div>`;
    }
  }

  // ── Pockets (inventory) ──
  if (t.showInventory !== false && t.showPockets !== false && p.inventory && p.inventory.length > 0) {
    const items = p.inventory.filter((i) => {
      const n = typeof i === 'object' ? i.item : i;
      return n && n !== 'Empty';
    });
    if (items.length > 0) {
      html += `<div class="section-title">${td('pockets_count', { count: items.length })}</div>`;
      html += `<div class="item-list">${items
        .map((i) => {
          const name = simplifyName(i);
          const dur =
            typeof i === 'object' && i.durability != null
              ? ` <span class="item-dur">(${Math.round(i.durability)}%)</span>`
              : '';
          return `<div>\u2022 ${name}${dur}</div>`;
        })
        .join('')}</div>`;
    }
  }

  // ── Backpack ──
  if (t.showInventory !== false && t.showBackpack !== false && p.backpackItems && p.backpackItems.length > 0) {
    const items = p.backpackItems.filter((i) => {
      const n = typeof i === 'object' ? i.item : i;
      return n && n !== 'Empty';
    });
    if (items.length > 0) {
      html += `<div class="section-title">${td('backpack_count', { count: items.length })}</div>`;
      html += `<div class="item-list">${items
        .map((i) => {
          const name = simplifyName(i);
          const dur =
            typeof i === 'object' && i.durability != null
              ? ` <span class="item-dur">(${Math.round(i.durability)}%)</span>`
              : '';
          return `<div>\u2022 ${name}${dur}</div>`;
        })
        .join('')}</div>`;
    }
  }

  // ── Lore ──
  if (t.showLore !== false && p.lore && p.lore.length > 0) {
    html += `<div class="section-title">${td('lore_found_count', { count: p.lore.length })}</div>`;
  }

  // ── Unique Items ──
  const uniques = [...(p.uniqueLoots || []), ...(p.craftedUniques || [])];
  if (uniques.length > 0) {
    html += `<div class="section-title">${td('unique_items_count', { count: uniques.length })}</div>`;
    html += `<div class="item-list">${uniques.map((u) => `<div>\u2022 ${simplifyName(u)}</div>`).join('')}</div>`;
  }

  // ── Companions ──
  if (p.companionData && p.companionData.length > 0) {
    html += `<div class="section-title">${td('companions_count', { count: p.companionData.length })}</div>`;
    html += `<div class="item-list">${p.companionData.map((c) => `<div>\u2022 ${simplifyName(c.type || c)}</div>`).join('')}</div>`;
  }
  if (p.horses && p.horses.length > 0) {
    html += `<div class="section-title">${td('horses_count', { count: p.horses.length })}</div>`;
  }

  html += `</div>`;
  return html;
}

// ── Sidebar: player list vs detail view ────────────────────
function renderPlayerList() {
  const content = document.getElementById('player-panel-content');
  const title = document.getElementById('panel-title');
  const backBtn = document.querySelector('#player-panel-header .back-btn');
  const listT = (key, vars) => i18next.t(`web:map.player_list.${key}`, vars);
  title.textContent = i18next.t('web:map.players');
  backBtn.style.display = 'none';

  // Sort: online first, then offline, then inactive; alpha within each
  const sorted = [...playerData].sort((a, b) => {
    const order = { online: 0, offline: 1, inactive: 2 };
    const sa = order[getPlayerStatus(a)] ?? 2;
    const sb = order[getPlayerStatus(b)] ?? 2;
    if (sa !== sb) return sa - sb;
    return (a.name || '').localeCompare(b.name || '');
  });

  let html = '';
  let lastSection = '';
  for (const p of sorted) {
    const status = getPlayerStatus(p);
    const section = status === 'online' ? 'online' : status === 'offline' ? 'offline' : 'inactive';
    if (section !== lastSection) {
      const count = sorted.filter((x) => getPlayerStatus(x) === status).length;
      const sectionLabel =
        section === 'online'
          ? listT('online_count', { count })
          : section === 'offline'
            ? listT('offline_count', { count })
            : listT('inactive_count', { count });
      html += `<div class="player-list-section">${sectionLabel}</div>`;
      lastSection = section;
    }
    let extra = '';
    if (status === 'online') {
      extra = listT('now');
    } else if (p.lastSeen) {
      const days = Math.floor((Date.now() - new Date(p.lastSeen).getTime()) / (1000 * 60 * 60 * 24));
      extra = days === 0 ? listT('today') : listT('days_ago', { days });
    }
    html += `<div class="player-list-item" onclick="selectPlayer('${p.steamId}')">`;
    html += `<span class="dot ${status}"></span>`;
    html += `<span class="player-name">${escapeHtml(p.name)}</span>`;
    html += `<span class="player-extra">${extra}</span>`;
    html += `</div>`;
  }
  if (!sorted.length)
    html = `<div style="color:#6e7681;padding:16px 0;text-align:center">${listT('no_players_yet')}</div>`;
  content.innerHTML = html;
}

function selectPlayer(steamId) {
  const p = playerData.find((x) => x.steamId === steamId);
  if (!p) return;
  showPlayerDetail(p);
  // Pan map to player if they have a position
  if (p.hasPosition && p.lat != null && p.lng != null) {
    map.setView([p.lat, p.lng], Math.max(map.getZoom(), 1), { animate: true });
  }
}

function showPlayerDetail(p) {
  const content = document.getElementById('player-panel-content');
  const title = document.getElementById('panel-title');
  const backBtn = document.querySelector('#player-panel-header .back-btn');
  const footer = document.getElementById('player-panel-footer');
  title.textContent = p.name;
  backBtn.style.display = 'inline-block';
  content.innerHTML = buildPlayerDetail(p);
  content.scrollTop = 0;
  // Show admin footer
  footer.style.display = 'flex';
  footer.innerHTML =
    `<button class="btn-msg" onclick="sendMessage('${p.steamId}','${escapeHtml(p.name)}')">${i18next.t('web:map.actions.message')}</button>` +
    `<button class="btn-kick" onclick="kickPlayer('${p.steamId}','${escapeHtml(p.name)}')">${i18next.t('web:map.actions.kick')}</button>` +
    `<button class="btn-ban" onclick="banPlayer('${p.steamId}','${escapeHtml(p.name)}')">${i18next.t('web:map.actions.ban')}</button>`;
}

function showPlayerPanel(p) {
  showPlayerDetail(p);
}

function showPlayerList() {
  document.getElementById('player-panel-footer').style.display = 'none';
  renderPlayerList();
}

function closePlayerPanel() {
  // Panel is always visible now — go back to list
  showPlayerList();
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

// ── Auth-aware fetch — redirects to login on 401 ───────────
async function authFetch(url, opts) {
  const res = await fetch(url, opts);
  if (res.status === 401) {
    window.location.href = '/auth/login';
    throw new Error('Not authenticated');
  }
  return res;
}

// ── Fetch players (fast, local data) ───────────────────────
async function fetchPlayersQuick() {
  const url = currentServer === 'primary' ? '/api/players' : `/api/players?server=${encodeURIComponent(currentServer)}`;
  const res = await authFetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  playerData = data.players || [];
  if (data.toggles) displayToggles = data.toggles;
  renderMarkers();
  document.getElementById('last-update').textContent = new Date().toLocaleTimeString();
}

// ── Full refresh via SSE (downloads from SFTP with progress) ──
function refreshPlayers() {
  const btn = document.getElementById('btn-refresh');
  const progressEl = document.getElementById('refresh-progress');
  btn.disabled = true;
  btn.textContent = i18next.t('web:map.syncing');
  progressEl.style.display = 'block';
  progressEl.style.opacity = '1';
  progressEl.classList.remove('fade-out');
  progressEl.innerHTML = '';

  const es = new EventSource('/api/refresh');
  let finished = false;

  function addStep(text, cls) {
    const step = document.createElement('div');
    step.className = 'progress-step' + (cls ? ' ' + cls : '');
    step.textContent = text;
    progressEl.appendChild(step);
    progressEl.scrollTop = progressEl.scrollHeight;
  }

  function finish() {
    if (finished) return;
    finished = true;
    clearTimeout(safetyTimer);
    try {
      es.close();
    } catch (_) {}
    btn.textContent = i18next.t('web:map.refresh');
    btn.disabled = false;
    progressEl.classList.add('fade-out');
    setTimeout(() => {
      progressEl.style.display = 'none';
      progressEl.classList.remove('fade-out');
      progressEl.style.opacity = '1';
    }, 1500);
  }

  // Safety timeout: if SSE takes longer than 30s, force finish
  const safetyTimer = setTimeout(() => {
    if (!finished) {
      addStep(i18next.t('web:map.refresh_timed_out'), 'error');
      finish();
    }
  }, 90000);

  es.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'progress') {
        addStep(msg.message);
      } else if (msg.type === 'done') {
        addStep(msg.message, 'done');
        // Fetch the actual player data from the fast endpoint
        fetchPlayersQuick().finally(() => finish());
      } else if (msg.type === 'error') {
        addStep(msg.message, 'error');
        finish();
      }
    } catch (e) {
      console.error('[SSE] parse error:', e);
    }
  };

  es.onerror = () => {
    // SSE endpoint may not exist — fall back to quick fetch
    fetchPlayersQuick()
      .catch(() => {})
      .finally(() => {
        addStep(i18next.t('web:map.loaded_from_cache'), 'done');
        finish();
      });
  };
}

function renderMarkers() {
  markersGroup.clearLayers();

  let onlineCount = 0;
  let totalCount = playerData.length; // ALL players including those without positions
  let mappedCount = 0;

  for (const p of playerData) {
    if (p.isOnline) onlineCount++;
    const status = getPlayerStatus(p);

    // Skip players without valid map coordinates
    if (!p.hasPosition || p.lat === null || p.lng === null) continue;
    if (isNaN(p.lat) || isNaN(p.lng)) {
      console.warn('[map] NaN coords for', p.name);
      continue;
    }
    if (!showOffline && status !== 'online') continue;

    mappedCount++;
    const marker = L.marker([p.lat, p.lng], {
      icon: createPlayerIcon(status),
      title: p.name,
      zIndexOffset: status === 'online' ? 1000 : status === 'offline' ? 500 : 0,
    });

    // Hover tooltip with name + status
    const tooltipSuffix =
      status === 'online' ? ' 🟢' : status === 'inactive' ? ` (${i18next.t('web:map.inactive')})` : '';
    marker.bindTooltip(p.name + tooltipSuffix, {
      permanent: false,
      direction: 'top',
      offset: [0, -10],
      className: 'player-tooltip',
    });

    // Click opens side panel
    marker.on('click', function (e) {
      L.DomEvent.stopPropagation(e);
      showPlayerPanel(p);
    });

    marker.addTo(markersGroup);
  }

  document.getElementById('online-count').textContent = onlineCount;
  document.getElementById('total-count').textContent = totalCount;
  console.log('[map] Rendered', mappedCount, 'markers,', onlineCount, 'online,', totalCount, 'total players');

  // Update sidebar player list (only if showing list view, not detail)
  const backBtn = document.querySelector('#player-panel-header .back-btn');
  if (!backBtn || backBtn.style.display === 'none') {
    renderPlayerList();
  }
}

// ── Admin actions ──────────────────────────────────────────
async function kickPlayer(steamId, name) {
  if (!window.uiConfirm('web:dialog.confirm_kick', { name, steamId })) return;
  try {
    const res = await authFetch('/api/admin/kick', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ steamId }),
    });
    const data = await res.json();
    window.uiAlert(data.ok ? 'web:dialog.kicked' : 'web:dialog.failed', data.ok ? { name } : { error: data.error });
  } catch (err) {
    window.uiAlert('web:dialog.failed', { error: err.message });
  }
}

async function banPlayer(steamId, name) {
  if (!window.uiConfirm('web:dialog.confirm_ban', { name, steamId })) return;
  if (!window.uiConfirm('web:dialog.confirm_ban_double', { name })) return;
  try {
    const res = await authFetch('/api/admin/ban', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ steamId }),
    });
    const data = await res.json();
    window.uiAlert(data.ok ? 'web:dialog.banned' : 'web:dialog.failed', data.ok ? { name } : { error: data.error });
  } catch (err) {
    window.uiAlert('web:dialog.failed', { error: err.message });
  }
}

async function sendMessage(steamId, name) {
  const msg = window.uiPrompt('web:dialog.message_prompt', { name });
  if (!msg) return;
  try {
    const res = await authFetch('/api/admin/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: `@${name}: ${msg}` }),
    });
    const data = await res.json();
    window.uiAlert(data.ok ? 'web:dialog.message_sent' : 'web:dialog.failed', data.ok ? {} : { error: data.error });
  } catch (err) {
    window.uiAlert('web:dialog.failed', { error: err.message });
  }
}

// ── Zoom controls ──────────────────────────────────────────
function _zoomToFit() {
  map.fitBounds(mapBounds, { padding: [20, 20] });
}

function _focusOnlinePlayers() {
  const onlinePlayers = playerData.filter((p) => p.isOnline && p.hasPosition && p.lat !== null);
  if (onlinePlayers.length === 0) {
    window.uiAlert('web:dialog.no_players_on_map');
    return;
  }
  if (onlinePlayers.length === 1) {
    map.setView([onlinePlayers[0].lat, onlinePlayers[0].lng], 2);
  } else {
    const bounds = L.latLngBounds(onlinePlayers.map((p) => [p.lat, p.lng]));
    map.fitBounds(bounds.pad(0.3));
  }
}

// ── Auto-refresh ───────────────────────────────────────────
function startAutoRefresh(intervalMs = 60000) {
  if (autoRefreshTimer) clearInterval(autoRefreshTimer);
  autoRefreshTimer = setInterval(fetchPlayersQuick, intervalMs); // quick poll, not full SFTP
}

// ── Coordinate display on hover ────────────────────────────
const coordDisplay = L.control({ position: 'bottomleft' });
coordDisplay.onAdd = function () {
  const div = L.DomUtil.create('div', 'coord-display');
  div.style.cssText =
    'background:rgba(13,17,23,0.85);color:#8b949e;padding:4px 8px;border-radius:4px;font-size:11px;font-family:monospace;border:1px solid #30363d;';
  div.innerHTML = i18next.t('web:map.coordinates.move_mouse');
  this._div = div;
  return div;
};
coordDisplay.update = function (lat, lng) {
  this._div.innerHTML = i18next.t('web:map.coordinates.lat_lng', { lat: lat.toFixed(0), lng: lng.toFixed(0) });
};
coordDisplay.addTo(map);

map.on('mousemove', function (e) {
  coordDisplay.update(e.latlng.lat, e.latlng.lng);
});

// Click on map (not a marker) → go back to player list
map.on('click', function () {
  showPlayerList();
});

// ── Auth: show user badge if authenticated ─────────────────
(async function initAuth() {
  try {
    const res = await fetch('/auth/me');
    if (!res.ok) return;
    const data = await res.json();
    if (!data.authenticated) return;
    const bar = document.getElementById('topbar');
    const badge = document.createElement('span');
    badge.className = 'stat';
    badge.style.cssText = 'display:flex;align-items:center;gap:6px;';
    const img = data.avatar
      ? `<img src="${data.avatar}?size=32" style="width:20px;height:20px;border-radius:50%;vertical-align:middle;">`
      : '';
    badge.innerHTML = `${img}<span style="color:#c9d1d9">${data.username}</span><a href="/auth/logout" style="color:#6e7681;font-size:11px;text-decoration:none;" title="${i18next.t('web:auth.sign_out')}">✕</a>`;
    bar.appendChild(badge);
  } catch (_) {
    /* auth not enabled */
  }
})();

// ── Multi-server dropdown ──────────────────────────────────
(async function initMultiServer() {
  try {
    const res = await fetch('/api/servers');
    if (!res.ok) return;
    const data = await res.json();
    if (!data.multiServer || data.servers.length <= 1) return;

    const select = document.getElementById('server-select');
    select.style.display = 'inline-block';
    select.innerHTML = '';
    for (const s of data.servers) {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.name;
      if (s.id === currentServer) opt.selected = true;
      select.appendChild(opt);
    }
    select.addEventListener('change', function () {
      currentServer = this.value;
      playerData = [];
      markersGroup.clearLayers();
      fetchPlayersQuick();
      showPlayerList();
    });
  } catch (_) {
    /* multi-server not available */
  }
})();

// ── Init ───────────────────────────────────────────────────
fetchPlayersQuick().catch((err) => console.warn('[MAP] Initial fetch failed:', err));
startAutoRefresh(30000); // quick poll every 30s after that

/**
 * HumanitZ Server Panel — Frontend Controller
 *
 * Handles: auth state, tier-based UI visibility, dashboard polling,
 * live map (Leaflet), player table, activity/chat feeds, RCON console,
 * settings editor, and server power controls.
 */

(function () {
  'use strict';

  // ── State ──
  let user = null;       // { authenticated, tier, tierLevel, username, avatar, ... }
  let mapInstance = null; // Leaflet map
  let mapMarkers = {};   // steamId → marker
  let refreshTimer = null;
  let activeTab = 'dashboard';
  let settingsOriginal = {};
  let settingsChanged = {};

  const TIER = { public: 0, survivor: 1, mod: 2, admin: 3 };

  // ── Init ──
  async function init() {
    try {
      const res = await fetch('/auth/me');
      user = await res.json();
    } catch {
      user = { authenticated: false, tier: 'public', tierLevel: 0 };
    }

    if (!user.authenticated || user.tier === 'public') {
      showLanding();
    } else {
      showPanel();
    }
  }

  // ── Landing Page ──
  async function showLanding() {
    document.getElementById('landing').style.display = '';
    document.getElementById('panel').style.display = 'none';

    // Load public landing data from unified endpoint
    try {
      const data = await fetch('/api/landing').then(r => r.ok ? r.json() : null).catch(() => null);

      if (data && data.primary) {
        const p = data.primary;
        setText('landing-server-name', p.name || 'HumanitZ Server');
        setText('ls-status', p.status === 'online' ? '🟢 Online' : '🔴 Offline');
        setText('ls-day', p.gameDay || '-');
        setText('ls-players', p.onlineCount ?? '-');
        setText('ls-total', p.totalPlayers || '-');

        // Connect info
        if (p.host && p.gamePort) {
          const addr = `${p.host}:${p.gamePort}`;
          document.getElementById('landing-connect').style.display = '';
          document.getElementById('landing-address').textContent = addr;
          document.getElementById('copy-address-btn').addEventListener('click', () => {
            navigator.clipboard.writeText(addr).then(() => {
              const btn = document.getElementById('copy-address-btn');
              btn.textContent = '✅';
              setTimeout(() => { btn.textContent = '📋'; }, 1500);
            }).catch(() => {});
          });
        }
      }

      // Multi-server cards
      if (data && data.servers && data.servers.length > 0) {
        document.getElementById('landing-servers').style.display = '';
        const container = document.getElementById('server-cards');
        container.innerHTML = '';

        // Include primary as the first card
        const primary = data.primary;
        const allServers = [
          { name: primary.name, host: primary.host, gamePort: primary.gamePort,
            status: primary.status, onlineCount: primary.onlineCount, totalPlayers: primary.totalPlayers },
          ...data.servers,
        ];

        for (const s of allServers) {
          const card = document.createElement('div');
          card.className = 'server-card';
          const statusIcon = s.status === 'online' ? '🟢' : s.status === 'stale' ? '🟡' : '🔴';
          const connectHtml = s.host && s.gamePort
            ? `<div class="sc-connect">Connect: <code>${esc(s.host)}:${esc(s.gamePort)}</code></div>`
            : '';
          card.innerHTML = `
            <div class="sc-name">${esc(s.name || 'Server')}</div>
            <div class="sc-status">${statusIcon} ${esc(s.status || 'unknown')} · ${s.onlineCount || 0} online · ${s.totalPlayers || 0} total</div>
            ${connectHtml}
          `;
          container.appendChild(card);
        }
      }

      // Schedule
      if (data && data.schedule && data.schedule.active) {
        const sched = data.schedule;
        document.getElementById('landing-schedule').style.display = '';
        setText('ls-profile', `Current: ${sched.currentProfileDisplay || sched.currentProfile || '-'}`);
        const next = sched.nextRestart;
        const mins = sched.minutesUntilRestart;
        setText('ls-next-restart', next ? `Next restart: ${next} (${mins} min)` : 'No upcoming restarts');
      }
    } catch { /* landing stats failed — non-critical */ }
  }

  // ── Panel ──
  function showPanel() {
    document.getElementById('landing').style.display = 'none';
    document.getElementById('panel').style.display = '';

    // Set user info
    const avatarEl = document.getElementById('user-avatar');
    if (user.avatar) { avatarEl.src = user.avatar; avatarEl.style.display = ''; }
    else avatarEl.style.display = 'none';
    setText('user-name', user.displayName || user.username || '—');
    setText('user-tier', user.tier);

    // Tier badge
    const badge = document.getElementById('tier-badge');
    badge.textContent = user.tier;
    badge.className = 'tier-badge ' + user.tier;

    // Show/hide nav items based on tier
    const tierLevel = user.tierLevel || TIER[user.tier] || 0;
    document.querySelectorAll('[data-min-tier]').forEach(el => {
      const minTier = parseInt(el.dataset.minTier, 10);
      if (tierLevel < minTier) {
        el.classList.add('hidden');
      } else {
        el.classList.remove('hidden');
      }
    });

    // Tab navigation
    document.querySelectorAll('.nav-item[data-tab]').forEach(item => {
      item.addEventListener('click', e => {
        e.preventDefault();
        switchTab(item.dataset.tab);
      });
    });

    // Event listeners
    setupConsole();
    setupChat();
    setupSettings();
    setupControls();
    setupActivityFilter();
    setupPlayerSearch();

    // Load connect info for dashboard
    loadConnectInfo();

    // Load initial data
    switchTab('dashboard');
    startRefresh();
  }

  /** Fetch connect info once and display in the dashboard header. */
  async function loadConnectInfo() {
    try {
      const data = await fetchJSON('/api/landing');
      if (data && data.primary && data.primary.host && data.primary.gamePort) {
        const addr = `${data.primary.host}:${data.primary.gamePort}`;
        document.getElementById('dashboard-connect').style.display = '';
        document.getElementById('d-address').textContent = addr;
        const btn = document.getElementById('d-copy-btn');
        btn.addEventListener('click', () => {
          navigator.clipboard.writeText(addr).then(() => {
            btn.textContent = '✅';
            setTimeout(() => { btn.textContent = '📋'; }, 1500);
          }).catch(() => {});
        });
      }
    } catch { /* non-critical */ }
  }

  // ── Tab Switching ──
  function switchTab(tab) {
    activeTab = tab;

    // Update nav active state
    document.querySelectorAll('.nav-item').forEach(el => {
      el.classList.toggle('active', el.dataset.tab === tab);
    });

    // Show/hide tab content
    document.querySelectorAll('.tab').forEach(el => {
      el.classList.toggle('active', el.id === 'tab-' + tab);
    });

    // Load tab data
    switch (tab) {
      case 'dashboard': loadDashboard(); break;
      case 'map': initMap(); loadMapData(); break;
      case 'players': loadPlayers(); break;
      case 'activity': loadActivity(); break;
      case 'chat': loadChat(); break;
      case 'settings': loadSettings(); break;
    }
  }

  // ── Auto-refresh ──
  function startRefresh() {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(() => {
      if (activeTab === 'dashboard') loadDashboard();
      else if (activeTab === 'map') loadMapData();
    }, 30000);
  }

  // ── Dashboard ──
  async function loadDashboard() {
    try {
      const [status, stats, sched] = await Promise.all([
        fetchJSON('/api/panel/status'),
        fetchJSON('/api/panel/stats'),
        fetchJSON('/api/panel/scheduler'),
      ]);

      if (status) {
        setText('d-status', status.serverState === 'running' ? '🟢 Online' : '🔴 Offline');
        setText('d-online', `${status.onlineCount ?? 0}/${status.playerCount ?? '?'}`);
        setText('d-day', status.gameDay || '—');

        // Resources (admin only)
        const resCard = document.getElementById('resources-card');
        if (status.resources && resCard && !resCard.classList.contains('hidden')) {
          resCard.style.display = '';
          const ri = document.getElementById('resources-info');
          ri.innerHTML = buildResourceBars(status.resources);
        }
      }

      if (stats) {
        setText('d-total', stats.totalPlayers || '0');
      }

      // Scheduler
      if (sched && sched.active) {
        const card = document.getElementById('schedule-card');
        card.style.display = '';
        const info = document.getElementById('schedule-info');
        const lines = [];
        lines.push(`<div class="resource-row"><span class="resource-label">Current Profile</span><span class="resource-value">${esc(sched.currentProfileDisplay || sched.currentProfile)}</span></div>`);
        if (sched.nextRestart) {
          lines.push(`<div class="resource-row"><span class="resource-label">Next Restart</span><span class="resource-value">${sched.nextRestart} (${sched.minutesUntilRestart} min)</span></div>`);
        }
        lines.push(`<div class="resource-row"><span class="resource-label">Schedule</span><span class="resource-value">${sched.restartTimes.join(', ')}</span></div>`);
        if (sched.profiles.length > 1) {
          lines.push(`<div class="resource-row"><span class="resource-label">Profiles</span><span class="resource-value">${sched.profiles.join(' → ')}</span></div>`);
        }
        info.innerHTML = lines.join('');
      }
    } catch { /* dashboard load failed */ }

    // Recent activity + chat (survivor+)
    if ((user.tierLevel || 0) >= TIER.survivor) {
      try {
        const [actRes, chatRes] = await Promise.all([
          fetchJSON('/api/panel/activity?limit=10'),
          fetchJSON('/api/panel/chat?limit=10'),
        ]);
        if (actRes) renderActivityFeed(actRes.events || [], 'd-activity', true);
        if (chatRes) renderChatFeed(chatRes.messages || [], 'd-chat', true);
      } catch { /* feeds unavailable */ }
    }
  }

  function buildResourceBars(res) {
    const bars = [];
    if (res.cpu != null) {
      bars.push(`<div class="resource-row"><span class="resource-label">CPU</span><span class="resource-value">${res.cpu.toFixed(1)}%</span></div><div class="resource-bar-track"><div class="resource-bar-fill cpu" style="width:${Math.min(res.cpu, 100)}%"></div></div>`);
    }
    if (res.memPercent != null) {
      bars.push(`<div class="resource-row"><span class="resource-label">Memory</span><span class="resource-value">${res.memFormatted || res.memPercent.toFixed(1) + '%'}</span></div><div class="resource-bar-track"><div class="resource-bar-fill mem" style="width:${Math.min(res.memPercent, 100)}%"></div></div>`);
    }
    if (res.diskPercent != null) {
      bars.push(`<div class="resource-row"><span class="resource-label">Disk</span><span class="resource-value">${res.diskFormatted || res.diskPercent.toFixed(1) + '%'}</span></div><div class="resource-bar-track"><div class="resource-bar-fill disk" style="width:${Math.min(res.diskPercent, 100)}%"></div></div>`);
    }
    return bars.join('');
  }

  // ── Live Map ──
  function initMap() {
    if (mapInstance) return;
    const container = document.getElementById('map-container');
    if (!container) return;

    // Create a div inside the container for Leaflet
    let mapDiv = container.querySelector('.leaflet-container');
    if (!mapDiv) {
      mapDiv = document.createElement('div');
      mapDiv.style.height = '100%';
      mapDiv.style.width = '100%';
      container.appendChild(mapDiv);
    }

    mapInstance = L.map(mapDiv, {
      crs: L.CRS.Simple,
      minZoom: -2,
      maxZoom: 4,
      attributionControl: false,
    });

    const bounds = [[0, 0], [4096, 4096]];
    L.imageOverlay('/tiles/map_4k.png', bounds).addTo(mapInstance);
    mapInstance.fitBounds(bounds);
    mapInstance.setMaxBounds([[-500, -500], [4596, 4596]]);
  }

  async function loadMapData() {
    if (!mapInstance) return;
    try {
      const data = await fetchJSON('/api/players');
      if (!data || !data.players) return;

      const playerCount = document.getElementById('map-player-count');
      const online = data.players.filter(p => p.isOnline);
      if (playerCount) playerCount.textContent = `${online.length} online`;

      const seen = new Set();
      for (const p of data.players) {
        if (!p.hasPosition) continue;
        seen.add(p.steamId);

        if (mapMarkers[p.steamId]) {
          mapMarkers[p.steamId].setLatLng([p.lat, p.lng]);
        } else {
          const color = p.isOnline ? '#22c55e' : '#6b7280';
          const marker = L.circleMarker([p.lat, p.lng], {
            radius: 6, fillColor: color, color: '#fff', weight: 1, fillOpacity: 0.9,
          }).addTo(mapInstance);
          marker.bindTooltip(p.name, { permanent: false, direction: 'top', offset: [0, -8] });
          marker.bindPopup(`<b>${esc(p.name)}</b><br>Profession: ${esc(p.profession)}<br>Kills: ${p.zeeksKilled}<br>${p.isOnline ? '🟢 Online' : '⚫ Offline'}`);
          mapMarkers[p.steamId] = marker;
        }
      }

      // Remove markers for players no longer in data
      for (const id of Object.keys(mapMarkers)) {
        if (!seen.has(id)) {
          mapInstance.removeLayer(mapMarkers[id]);
          delete mapMarkers[id];
        }
      }
    } catch { /* map data failed */ }
  }

  // ── Players Table ──
  async function loadPlayers() {
    try {
      const data = await fetchJSON('/api/players');
      if (!data || !data.players) return;

      const players = data.players.sort((a, b) => (b.isOnline ? 1 : 0) - (a.isOnline ? 1 : 0) || a.name.localeCompare(b.name));
      const container = document.getElementById('player-list');

      const isMod = (user.tierLevel || 0) >= TIER.mod;
      let html = '<table><thead><tr><th>Status</th><th>Name</th><th>Profession</th><th>Kills</th><th>Days</th><th>Playtime</th>';
      if (isMod) html += '<th>Actions</th>';
      html += '</tr></thead><tbody>';

      for (const p of players) {
        html += `<tr>`;
        html += `<td><span class="online-dot ${p.isOnline ? 'on' : 'off'}"></span>${p.isOnline ? 'Online' : 'Offline'}</td>`;
        html += `<td><strong>${esc(p.name)}</strong></td>`;
        html += `<td>${esc(p.profession)}</td>`;
        html += `<td>${p.zeeksKilled}</td>`;
        html += `<td>${p.daysSurvived}</td>`;
        html += `<td>${formatPlaytime(p.totalPlaytime)}</td>`;
        if (isMod) {
          html += `<td><button class="btn btn-sm btn-ghost" onclick="Panel.kickPlayer('${p.steamId}', '${esc(p.name)}')">Kick</button></td>`;
        }
        html += '</tr>';
      }

      html += '</tbody></table>';
      container.innerHTML = html;
    } catch { /* player load failed */ }
  }

  function setupPlayerSearch() {
    const input = document.getElementById('player-search');
    if (!input) return;
    input.addEventListener('input', () => {
      const q = input.value.toLowerCase();
      const rows = document.querySelectorAll('#player-list tbody tr');
      rows.forEach(row => {
        const name = row.querySelector('td:nth-child(2)')?.textContent?.toLowerCase() || '';
        row.style.display = name.includes(q) ? '' : 'none';
      });
    });
  }

  // ── Activity Feed ──
  async function loadActivity() {
    const filter = document.getElementById('activity-filter')?.value || '';
    try {
      const url = filter ? `/api/panel/activity?limit=100&type=${filter}` : '/api/panel/activity?limit=100';
      const data = await fetchJSON(url);
      renderActivityFeed(data?.events || [], 'activity-feed', false);
    } catch { /* activity failed */ }
  }

  function setupActivityFilter() {
    const sel = document.getElementById('activity-filter');
    if (sel) sel.addEventListener('change', loadActivity);
  }

  const EVENT_ICONS = {
    player_connect: '🟢', player_disconnect: '🔴', player_death: '💀',
    player_death_pvp: '⚔️', player_build: '🔨', container_loot: '📦',
    raid_damage: '💥', building_destroyed: '🏚️', admin_access: '🛡️',
    anticheat_flag: '🚨', damage_taken: '🩸',
  };

  function renderActivityFeed(events, containerId, compact) {
    const container = document.getElementById(containerId);
    if (!container) return;

    if (!events.length) {
      container.innerHTML = '<div class="feed-empty">No activity</div>';
      return;
    }

    const items = events.slice(0, compact ? 10 : 100).map(e => {
      const time = formatTime(e.created_at || e.timestamp);
      const icon = EVENT_ICONS[e.event_type] || '📋';
      const name = e.player_name || e.actor || 'Unknown';
      const detail = e.detail || e.event_type?.replace(/_/g, ' ') || '';
      return `<div class="feed-item"><span class="feed-time">${time}</span><span class="feed-icon">${icon}</span><span class="feed-text"><strong>${esc(name)}</strong> ${esc(detail)}</span></div>`;
    });

    container.innerHTML = items.join('');
  }

  // ── Chat Feed ──
  async function loadChat() {
    try {
      const data = await fetchJSON('/api/panel/chat?limit=200');
      renderChatFeed(data?.messages || [], 'chat-feed', false);
    } catch { /* chat failed */ }
  }

  function renderChatFeed(messages, containerId, compact) {
    const container = document.getElementById(containerId);
    if (!container) return;

    if (!messages.length) {
      container.innerHTML = '<div class="feed-empty">No chat messages</div>';
      return;
    }

    const items = messages.slice(0, compact ? 10 : 200).map(m => {
      const time = formatTime(m.created_at || m.timestamp);
      const author = m.player_name || m.discord_user || 'System';
      const msg = m.message || '';
      const dirIcon = m.direction === 'outbound' ? '📤' : '📥';
      return `<div class="feed-item chat-item"><span class="feed-time">${time}</span><span class="feed-icon">${dirIcon}</span><span class="feed-text"><span class="chat-author">${esc(author)}</span> <span class="chat-msg">${esc(msg)}</span></span></div>`;
    });

    container.innerHTML = items.join('');
  }

  function setupChat() {
    const input = document.getElementById('chat-msg-input');
    const btn = document.getElementById('chat-send-btn');
    if (!input || !btn) return;

    const send = async () => {
      const msg = input.value.trim();
      if (!msg) return;
      input.value = '';
      try {
        await fetch('/api/admin/message', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: msg }),
        });
        setTimeout(loadChat, 1000);
      } catch { /* send failed */ }
    };

    btn.addEventListener('click', send);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') send(); });
  }

  // ── RCON Console ──
  function setupConsole() {
    const input = document.getElementById('rcon-input');
    const btn = document.getElementById('rcon-send-btn');
    const output = document.getElementById('console-output');
    if (!input || !btn || !output) return;

    // Initial system lines
    output.innerHTML = '<div class="console-line system">RCON Console — type commands below and press Enter</div>';

    const send = async () => {
      const cmd = input.value.trim();
      if (!cmd) return;
      input.value = '';

      // Add command line
      const cmdLine = document.createElement('div');
      cmdLine.className = 'console-line cmd';
      cmdLine.textContent = cmd;
      output.appendChild(cmdLine);

      try {
        const res = await fetch('/api/panel/rcon', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ command: cmd }),
        });
        const data = await res.json();

        const respLine = document.createElement('div');
        if (res.ok) {
          respLine.className = 'console-line response';
          respLine.textContent = data.response || '(no response)';
        } else {
          respLine.className = 'console-line error';
          respLine.textContent = data.error || 'Command failed';
        }
        output.appendChild(respLine);
      } catch (err) {
        const errLine = document.createElement('div');
        errLine.className = 'console-line error';
        errLine.textContent = 'Network error: ' + err.message;
        output.appendChild(errLine);
      }

      output.scrollTop = output.scrollHeight;
    };

    btn.addEventListener('click', send);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') send(); });
  }

  // ── Settings ──
  async function loadSettings() {
    try {
      const data = await fetchJSON('/api/panel/settings');
      if (!data || !data.settings) return;

      settingsOriginal = { ...data.settings };
      settingsChanged = {};
      const container = document.getElementById('settings-grid');
      const saveBtn = document.getElementById('settings-save-btn');
      if (saveBtn) saveBtn.disabled = true;

      const items = Object.entries(data.settings)
        .filter(([k]) => !k.startsWith('[') && !k.startsWith('#'))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => {
          return `<div class="setting-item"><div><div class="setting-name">${esc(key)}</div></div><input class="setting-input" data-key="${esc(key)}" value="${esc(value)}" /></div>`;
        });

      container.innerHTML = items.join('');

      // Track changes
      container.querySelectorAll('.setting-input').forEach(input => {
        input.addEventListener('input', () => {
          const key = input.dataset.key;
          const orig = settingsOriginal[key];
          if (input.value !== orig) {
            settingsChanged[key] = input.value;
            input.classList.add('changed');
          } else {
            delete settingsChanged[key];
            input.classList.remove('changed');
          }
          if (saveBtn) saveBtn.disabled = Object.keys(settingsChanged).length === 0;
        });
      });
    } catch { /* settings failed */ }
  }

  function setupSettings() {
    const saveBtn = document.getElementById('settings-save-btn');
    if (!saveBtn) return;
    saveBtn.addEventListener('click', async () => {
      if (Object.keys(settingsChanged).length === 0) return;
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving...';
      try {
        const res = await fetch('/api/panel/settings', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ settings: settingsChanged }),
        });
        if (res.ok) {
          Object.assign(settingsOriginal, settingsChanged);
          settingsChanged = {};
          document.querySelectorAll('.setting-input.changed').forEach(el => el.classList.remove('changed'));
          saveBtn.textContent = '✓ Saved';
          setTimeout(() => { saveBtn.textContent = 'Save Changes'; }, 2000);
        } else {
          const data = await res.json();
          alert('Failed to save: ' + (data.error || 'Unknown error'));
          saveBtn.textContent = 'Save Changes';
          saveBtn.disabled = false;
        }
      } catch (err) {
        alert('Save error: ' + err.message);
        saveBtn.textContent = 'Save Changes';
        saveBtn.disabled = false;
      }
    });
  }

  // ── Server Controls ──
  function setupControls() {
    document.querySelectorAll('.power-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const action = btn.dataset.action;
        if (!action) return;
        if (['stop', 'restart'].includes(action) && !confirm(`Are you sure you want to ${action} the server?`)) return;

        btn.disabled = true;
        const origText = btn.textContent;
        btn.textContent = 'Working...';

        try {
          const res = await fetch('/api/panel/power', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action }),
          });
          const data = await res.json();
          const log = document.getElementById('controls-log');
          if (log) {
            const entry = document.createElement('div');
            entry.className = 'feed-item';
            entry.innerHTML = `<span class="feed-time">${formatTime(new Date().toISOString())}</span><span class="feed-icon">${res.ok ? '✅' : '❌'}</span><span class="feed-text">${esc(data.message || data.error || action)}</span>`;
            log.prepend(entry);
          }
        } catch (err) {
          alert('Error: ' + err.message);
        }

        btn.textContent = origText;
        btn.disabled = false;
      });
    });
  }

  // ── Player Actions ──
  async function kickPlayer(steamId, name) {
    if (!confirm(`Kick player ${name}?`)) return;
    try {
      await fetch('/api/admin/kick', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ steamId }),
      });
      setTimeout(loadPlayers, 2000);
    } catch { /* kick failed */ }
  }

  // ── Helpers ──
  async function fetchJSON(url) {
    const res = await fetch(url);
    if (!res.ok) return null;
    return res.json();
  }

  function setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  function esc(str) {
    if (str == null) return '';
    const div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
  }

  function formatTime(isoStr) {
    if (!isoStr) return '';
    try {
      const d = new Date(isoStr);
      return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    } catch { return ''; }
  }

  function formatPlaytime(minutes) {
    if (!minutes) return '0m';
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  }

  // ── Expose for inline handlers ──
  window.Panel = { kickPlayer };

  // ── Go ──
  document.addEventListener('DOMContentLoaded', init);
})();

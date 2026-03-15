/**
 * Panel Tab: Activity — event feed with category filtering, charts, and fingerprint tracker.
 * @namespace Panel.tabs.activity
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
  const fmtNum = Panel.core.utils.fmtNum;
  const renderActivityFeed = Panel.shared.activityFeed.render;

  let _inited = false;

  function init() {
    if (_inited) return;
    _inited = true;
    // One-time event bindings are handled in the IIFE below
  }

  // ── Activity Loading ────────────────────────────────────────────

  async function loadActivity(append) {
    const container = $('#activity-feed');
    if (!container) return;
    const category = S.activityCategory || '';
    const rawSearch = $('#activity-search') ? $('#activity-search').value : '';
    let search = rawSearch.toLowerCase();
    const date = $('#activity-date') ? $('#activity-date').value : '';

    const paging = Panel.shared.activityFeed;

    // Detect fingerprint search pattern: ItemName#abcdef123456
    const fpMatch = rawSearch.match(/^(.+)#([a-f0-9]{6,})$/i);
    if (fpMatch) {
      const fpItem = fpMatch[1].trim();
      const fpHash = fpMatch[2].trim();
      showFingerprintTracker(fpItem, fpHash);
      // Also load normal activity filtered by item name
      search = fpItem.toLowerCase();
    } else {
      hideFingerprintTracker();
    }

    if (!append) {
      paging.setOffset(0);
    }
    const pageSize = paging.getPageSize();
    const params = new URLSearchParams({ limit: String(pageSize), offset: String(paging.getOffset()) });
    if (category) params.set('type', category);
    if (search) params.set('actor', search);
    try {
      const r = await apiFetch('/api/panel/activity?' + params);
      const d = await r.json();
      let events = d.events || [];
      if (date)
        events = events.filter(function (e) {
          return (e.created_at || '').startsWith(date);
        });
      paging.setHasMore(events.length >= pageSize);
      paging.setOffset(paging.getOffset() + events.length);
      renderActivityFeed(container, events, false, append);
      const btn = $('#activity-load-more');
      if (btn) btn.classList.toggle('hidden', !paging.getHasMore());
    } catch (_e) {
      if (!append)
        container.innerHTML =
          '<div class="feed-empty">' + i18next.t('web:empty_states.failed_to_load_activity') + '</div>';
    }
  }

  // Wire window global for load-more
  window.__loadMoreActivity = function () {
    loadActivity(true);
  };

  // ── Fingerprint Tracker ─────────────────────────────────────────

  function hideFingerprintTracker() {
    const panel = $('#fingerprint-tracker');
    if (panel) panel.classList.add('hidden');
  }

  async function showFingerprintTracker(itemName, fingerprint) {
    const panel = $('#fingerprint-tracker');
    if (!panel) return;

    // Show panel + loading state
    panel.classList.remove('hidden');
    if (window.lucide) lucide.createIcons({ nodes: [panel] });
    const nameEl = $('#fp-item-name');
    const hashEl = $('#fp-hash');
    const infoEl = $('#fp-instance-info');
    const ownershipEl = $('#fp-ownership');
    const chainEl = $('#fp-ownership-chain');
    const movementsEl = $('#fp-movements');
    const loadingEl = $('#fp-loading');
    const emptyEl = $('#fp-empty');

    if (nameEl) nameEl.textContent = itemName;
    if (hashEl) hashEl.textContent = '#' + fingerprint;
    if (infoEl) infoEl.innerHTML = '';
    if (chainEl) chainEl.innerHTML = '';
    if (movementsEl) movementsEl.innerHTML = '';
    if (ownershipEl) ownershipEl.classList.add('hidden');
    if (loadingEl) loadingEl.classList.remove('hidden');
    if (emptyEl) emptyEl.classList.add('hidden');

    const limit = parseInt(($('#fp-limit') || {}).value || '50', 10);

    try {
      const params = new URLSearchParams({ fingerprint: fingerprint, item: itemName });
      const r = await apiFetch('/api/panel/items/lookup?' + params);
      if (!r.ok) throw new Error('API error');
      const data = await r.json();

      if (loadingEl) loadingEl.classList.add('hidden');

      const match = data.match;
      const movements = data.movements || [];
      const ownership = data.ownershipChain || [];

      if (!match && movements.length === 0) {
        if (emptyEl) emptyEl.classList.remove('hidden');
        return;
      }

      // Render instance info badges
      if (match && infoEl) {
        let infoBadges = '';

        // Current location
        const locLabel = _fpFormatLocation(match.location_type, match.location_id);
        infoBadges +=
          '<div class="fp-info-badge"><div class="fp-info-label">Location</div><div class="fp-info-value">' +
          locLabel +
          '</div></div>';

        // Durability
        if (match.durability != null && match.durability > 0) {
          const durPct =
            match.max_dur > 0 ? Math.round((match.durability / match.max_dur) * 100) : Math.round(match.durability);
          const durCol = durPct > 60 ? 'text-emerald-400' : durPct > 25 ? 'text-amber-400' : 'text-red-400';
          infoBadges +=
            '<div class="fp-info-badge"><div class="fp-info-label">Durability</div><div class="fp-info-value ' +
            durCol +
            '">' +
            durPct +
            '%</div></div>';
        }

        // Amount
        if (match.amount > 1) {
          infoBadges +=
            '<div class="fp-info-badge"><div class="fp-info-label">Amount</div><div class="fp-info-value">' +
            match.amount +
            '</div></div>';
        }

        // Total movements
        infoBadges +=
          '<div class="fp-info-badge"><div class="fp-info-label">Movements</div><div class="fp-info-value">' +
          fmtNum(data.totalMovements || movements.length) +
          '</div></div>';

        // Status
        const status = match.lost
          ? '<span class="text-red-400">Lost</span>'
          : '<span class="text-emerald-400">Active</span>';
        infoBadges +=
          '<div class="fp-info-badge"><div class="fp-info-label">Status</div><div class="fp-info-value">' +
          status +
          '</div></div>';

        // First seen
        if (match.first_seen) {
          infoBadges +=
            '<div class="fp-info-badge"><div class="fp-info-label">First Seen</div><div class="fp-info-value text-xs">' +
            _fpShortDate(match.first_seen) +
            '</div></div>';
        }

        // Last seen
        if (match.last_seen) {
          infoBadges +=
            '<div class="fp-info-badge"><div class="fp-info-label">Last Seen</div><div class="fp-info-value text-xs">' +
            _fpShortDate(match.last_seen) +
            '</div></div>';
        }

        // Ammo
        if (match.ammo > 0) {
          infoBadges +=
            '<div class="fp-info-badge"><div class="fp-info-label">Ammo</div><div class="fp-info-value">' +
            match.ammo +
            '</div></div>';
        }

        infoEl.innerHTML = infoBadges;
      }

      // Render ownership chain
      if (ownership.length > 0 && ownershipEl && chainEl) {
        ownershipEl.classList.remove('hidden');
        let chainHtml = '';
        for (let ci = 0; ci < ownership.length; ci++) {
          if (ci > 0) chainHtml += '<span class="fp-custody-arrow">\u2192</span>';
          chainHtml +=
            '<span class="fp-custody-player player-link" data-steam-id="' +
            esc(ownership[ci].steamId || '') +
            '">' +
            esc(ownership[ci].name || ownership[ci].steamId) +
            '</span>';
          chainHtml += '<span class="fp-custody-time">' + _fpShortDate(ownership[ci].at) + '</span>';
        }
        chainEl.innerHTML = chainHtml;
      }

      // Render movement timeline (limited)
      const limited = movements.slice(0, limit);
      if (limited.length > 0 && movementsEl) {
        let movHtml = '';
        for (let mi = 0; mi < limited.length; mi++) {
          const m = limited[mi];
          movHtml += _fpRenderMovementRow(m);
        }
        if (movements.length > limit) {
          movHtml +=
            '<div class="text-[10px] text-muted text-center py-2">' +
            (movements.length - limit) +
            ' older movements not shown. Increase limit to see more.</div>';
        }
        movementsEl.innerHTML = movHtml;
      } else if (emptyEl) {
        emptyEl.classList.remove('hidden');
      }
    } catch (_err) {
      if (loadingEl) loadingEl.classList.add('hidden');
      if (movementsEl)
        movementsEl.innerHTML =
          '<div class="text-xs text-red-400 text-center py-2">' +
          i18next.t('web:activity.loading_tracker_data') +
          '</div>';
    }
  }

  function _fpFormatLocation(type, id, resolvedName) {
    if (!type) return '<span class="text-muted">Unknown</span>';
    if (type === 'player') {
      // Use resolved name from API, or try to look up from player list, or fallback to steam ID
      let pName = resolvedName || id;
      const steamId = id;
      if (!resolvedName) {
        for (let pi = 0; pi < S.players.length; pi++) {
          if (S.players[pi].steamId === id) {
            pName = S.players[pi].name;
            break;
          }
        }
      }
      return (
        '<span class="player-link cursor-pointer hover:underline text-accent" data-steam-id="' +
        esc(steamId) +
        '">' +
        esc(pName) +
        '</span>'
      );
    }
    if (type === 'container') {
      const cleanId = id
        .replace(/ChildActor_GEN_VARIABLE_|_C_CAT_\d+|BP_/g, '')
        .replace(/_/g, ' ')
        .trim();
      return '<span class="text-gray-300" title="' + esc(id) + '">' + esc(cleanId || id) + '</span>';
    }
    if (type === 'world_drop') {
      return '<span class="text-amber-400">World Drop</span>';
    }
    if (type === 'global_container') {
      return '<span class="text-blue-400">Global Container</span>';
    }
    return '<span class="text-gray-300">' + esc(type) + ': ' + esc(id) + '</span>';
  }

  function _fpShortDate(dateStr) {
    if (!dateStr) return '';
    try {
      const d = new Date(dateStr + 'Z');
      const now = new Date();
      const diff = now - d;
      if (diff < 60000) return 'just now';
      if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
      if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
      const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()];
      return (
        month +
        ' ' +
        d.getDate() +
        ', ' +
        String(d.getHours()).padStart(2, '0') +
        ':' +
        String(d.getMinutes()).padStart(2, '0')
      );
    } catch (_e) {
      return dateStr.slice(0, 16);
    }
  }

  function _fpRenderMovementRow(m) {
    const fromLoc = _fpFormatLocation(m.from_type, m.from_id, m.from_name);
    const toLoc = _fpFormatLocation(m.to_type, m.to_id, m.to_name);
    const time = _fpShortDate(m.created_at);
    const attrName = m.attributed_name || '';

    let html = '<div class="fp-movement-row">';
    html += '<span class="fp-time">' + esc(time) + '</span>';
    html += '<span class="fp-loc">' + fromLoc + '</span>';
    html += '<span class="fp-arrow">\u2192</span>';
    html += '<span class="fp-loc">' + toLoc + '</span>';
    if (attrName) {
      html += '<span class="text-muted text-[10px] ml-auto">by ' + esc(attrName) + '</span>';
    }
    if (m.amount > 1) {
      html += '<span class="text-muted text-[10px]">\u00d7' + m.amount + '</span>';
    }
    html += '</div>';
    return html;
  }

  // ── Activity Stats & Charts ─────────────────────────────────────

  const CHART_COLORS = {
    container: '#60a5fa', // blue
    inventory: '#34d399', // green
    vehicle: '#fbbf24', // yellow
    session: '#a78bfa', // purple
    combat: '#f87171', // red
    structure: '#fb923c', // orange
    horse: '#2dd4bf', // teal
    admin: '#f472b6', // pink
  };

  async function loadActivityStats() {
    try {
      const r = await apiFetch('/api/panel/activity-stats');
      const d = await r.json();
      S.activityStats = d;

      // Populate stat cards
      const totalEl = $('#act-total');
      if (totalEl) totalEl.textContent = (d.total || 0).toLocaleString();
      const typesEl = $('#act-types-count');
      if (typesEl) typesEl.textContent = Object.keys(d.types || {}).length;
      const rangeEl = $('#act-date-range');
      if (rangeEl && d.dateRange) {
        const e0 = d.dateRange.earliest ? d.dateRange.earliest.split('T')[0] : '?';
        const e1 = d.dateRange.latest ? d.dateRange.latest.split('T')[0] : '?';
        rangeEl.textContent = e0 + ' \u2014 ' + e1;
      }
      const topEl = $('#act-top-actor');
      if (topEl && d.topActors && d.topActors.length) {
        topEl.textContent = d.topActors[0].actor + ' (' + d.topActors[0].count.toLocaleString() + ')';
      }

      // Update pill counts
      const pills = $$('.activity-pill');
      for (let i = 0; i < pills.length; i++) {
        const pill = pills[i];
        const cat = pill.dataset.category || '';
        const badge = pill.querySelector('.pill-count');
        let count = 0;
        if (cat === '') count = d.total || 0;
        else count = (d.categories || {})[cat] || 0;
        if (badge) {
          badge.textContent = formatCompact(count);
        } else if (count > 0) {
          const span = document.createElement('span');
          span.className = 'pill-count';
          span.textContent = formatCompact(count);
          pill.appendChild(span);
        }
      }

      // Render charts
      renderDailyChart(d.daily || []);
      renderHourlyChart(d.hourly || []);
      renderCategoryChart(d.categories || {});
      renderTopActorsChart(d.topActors || []);
    } catch (e) {
      console.error('Failed to load activity stats:', e);
    }
  }

  function formatCompact(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return String(n);
  }

  function destroyChart(key) {
    if (S.activityCharts[key]) {
      S.activityCharts[key].destroy();
      S.activityCharts[key] = null;
    }
  }

  function chartDefaults() {
    return {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(15,15,20,0.95)',
          titleColor: '#e2e8f0',
          bodyColor: '#94a3b8',
          borderColor: 'rgba(255,255,255,0.1)',
          borderWidth: 1,
          cornerRadius: 6,
          padding: 8,
        },
      },
      scales: {
        x: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#64748b', font: { size: 10 } } },
        y: {
          grid: { color: 'rgba(255,255,255,0.04)' },
          ticks: { color: '#64748b', font: { size: 10 } },
          beginAtZero: true,
        },
      },
    };
  }

  function renderDailyChart(daily) {
    const canvas = $('#chart-daily-activity');
    if (!canvas) return;
    destroyChart('daily');
    const labels = daily.map(function (d) {
      return d.day ? d.day.slice(5) : '';
    });
    const data = daily.map(function (d) {
      return d.count;
    });
    S.activityCharts.daily = new Chart(canvas, {
      type: 'line',
      data: {
        labels: labels,
        datasets: [
          {
            data: data,
            borderColor: '#60a5fa',
            backgroundColor: 'rgba(96,165,250,0.15)',
            fill: true,
            tension: 0.35,
            borderWidth: 2,
            pointRadius: 1.5,
            pointHoverRadius: 4,
            pointBackgroundColor: '#60a5fa',
          },
        ],
      },
      options: chartDefaults(),
    });
  }

  function renderHourlyChart(hourly) {
    const canvas = $('#chart-hourly-activity');
    if (!canvas) return;
    destroyChart('hourly');
    const labels = [];
    const data = [];
    const hourMap = {};
    for (let i = 0; i < hourly.length; i++) hourMap[hourly[i].hour] = hourly[i].count;
    for (let h = 0; h < 24; h++) {
      labels.push(h.toString().padStart(2, '0') + ':00');
      data.push(hourMap[h] || 0);
    }
    S.activityCharts.hourly = new Chart(canvas, {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [
          {
            data: data,
            backgroundColor: 'rgba(167,139,250,0.5)',
            borderColor: '#a78bfa',
            borderWidth: 1,
            borderRadius: 3,
          },
        ],
      },
      options: chartDefaults(),
    });
  }

  function renderCategoryChart(categories) {
    const canvas = $('#chart-category-activity');
    if (!canvas) return;
    destroyChart('category');
    const cats = Object.keys(categories);
    if (!cats.length) return;
    const labels = cats.map(function (c) {
      return c.charAt(0).toUpperCase() + c.slice(1);
    });
    const data = cats.map(function (c) {
      return categories[c];
    });
    const colors = cats.map(function (c) {
      return CHART_COLORS[c] || '#64748b';
    });
    S.activityCharts.category = new Chart(canvas, {
      type: 'doughnut',
      data: {
        labels: labels,
        datasets: [
          {
            data: data,
            backgroundColor: colors,
            borderColor: 'rgba(15,15,20,0.8)',
            borderWidth: 2,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '55%',
        plugins: {
          legend: {
            position: 'right',
            labels: { color: '#94a3b8', font: { size: 11 }, padding: 8, usePointStyle: true, pointStyleWidth: 8 },
          },
          tooltip: {
            backgroundColor: 'rgba(15,15,20,0.95)',
            titleColor: '#e2e8f0',
            bodyColor: '#94a3b8',
            borderColor: 'rgba(255,255,255,0.1)',
            borderWidth: 1,
            cornerRadius: 6,
            padding: 8,
          },
        },
      },
    });
  }

  function renderTopActorsChart(topActors) {
    const canvas = $('#chart-top-actors');
    if (!canvas) return;
    destroyChart('topActors');
    if (!topActors.length) return;
    const labels = topActors.map(function (a) {
      return a.actor || 'Unknown';
    });
    const data = topActors.map(function (a) {
      return a.count;
    });
    S.activityCharts.topActors = new Chart(canvas, {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [
          {
            data: data,
            backgroundColor: 'rgba(52,211,153,0.5)',
            borderColor: '#34d399',
            borderWidth: 1,
            borderRadius: 3,
          },
        ],
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: 'rgba(15,15,20,0.95)',
            titleColor: '#e2e8f0',
            bodyColor: '#94a3b8',
            borderColor: 'rgba(255,255,255,0.1)',
            borderWidth: 1,
            cornerRadius: 6,
            padding: 8,
          },
        },
        scales: {
          x: {
            grid: { color: 'rgba(255,255,255,0.04)' },
            ticks: { color: '#64748b', font: { size: 10 } },
            beginAtZero: true,
          },
          y: { grid: { display: false }, ticks: { color: '#94a3b8', font: { size: 11 } } },
        },
      },
    });
  }

  function reset() {
    _inited = false;
  }

  Panel.tabs.activity = {
    init: init,
    load: function () {
      loadActivity();
      if (!S.activityChartsLoaded) {
        loadActivityStats();
        S.activityChartsLoaded = true;
      }
    },
    reset: reset,
    loadActivity: loadActivity,
    loadActivityStats: loadActivityStats,
    resetPaging: Panel.shared.activityFeed.resetPaging,
    showFingerprintTracker: showFingerprintTracker,
    hideFingerprintTracker: hideFingerprintTracker,
  };
})();

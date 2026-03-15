/**
 * Panel Tab: Dashboard — server overview, resource cards, world stats, quick actions.
 *
 * @namespace Panel.tabs.dashboard
 */
window.Panel = window.Panel || {};
Panel.tabs = Panel.tabs || {};

(function () {
  'use strict';

  const S = Panel.core.S;
  const $ = Panel.core.$;
  const el = Panel.core.el;
  const esc = Panel.core.esc;
  const apiFetch = Panel.core.apiFetch;
  const fmtNum = Panel.core.utils.fmtNum;

  // ── Sparkline Charts ──────────────────────────────

  function renderSparkline(canvasId, data, color) {
    const canvas = $('#' + canvasId);
    if (!canvas || !window.Chart) return;
    if (S.sparkCharts[canvasId]) {
      S.sparkCharts[canvasId].data.labels = data.map(function (_, i) {
        return i;
      });
      S.sparkCharts[canvasId].data.datasets[0].data = data;
      S.sparkCharts[canvasId].update('none');
      return;
    }
    S.sparkCharts[canvasId] = new Chart(canvas, {
      type: 'line',
      data: {
        labels: data.map(function (_, i) {
          return i;
        }),
        datasets: [
          {
            data: data,
            borderColor: color,
            borderWidth: 1.5,
            pointRadius: 0,
            tension: 0.3,
            fill: { target: 'origin', above: color + '15' },
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        resizeDelay: 0,
        animation: false,
        plugins: { legend: { display: false }, tooltip: { enabled: false } },
        scales: {
          x: { display: false },
          y: { display: false, beginAtZero: true },
        },
        layout: { padding: 0 },
        elements: { line: { borderCapStyle: 'round' } },
      },
    });
  }

  // ── Dashboard Load ────────────────────────────────

  async function loadDashboard() {
    // Always use full single-server dashboard — carousel handles server switching
    const singleEl = $('#dash-single');
    if (singleEl) singleEl.classList.remove('hidden');
    await loadSingleDashboard();
  }

  /** Single-server dashboard — the original loadDashboard logic */
  async function loadSingleDashboard() {
    try {
      const results = await Promise.all([
        apiFetch('/api/panel/status'),
        apiFetch('/api/panel/stats'),
        apiFetch('/api/panel/capabilities'),
      ]);
      const status = results[0].ok ? await results[0].json() : {};
      const stats = results[1].ok ? await results[1].json() : {};
      const caps = results[2].ok ? await results[2].json() : {};

      const isOn = status.serverState === 'running';
      const stEl = $('#d-status');
      if (stEl) {
        if (status.serverState) {
          stEl.textContent = isOn ? i18next.t('web:dashboard.online') : i18next.t('web:map.offline');
          stEl.style.color = isOn ? '#6dba82' : '#c45a4a';
        } else {
          stEl.textContent = '-';
          stEl.style.color = '';
        }
      }

      const onEl = $('#d-online');
      if (onEl)
        onEl.textContent = stats.onlinePlayers != null ? stats.onlinePlayers + ' / ' + (status.maxPlayers || '?') : '-';

      const totEl = $('#d-total');
      if (totEl) {
        if (stats.totalPlayers != null) {
          const offline = (stats.totalPlayers || 0) - (stats.onlinePlayers || 0);
          totEl.textContent = stats.totalPlayers + ' (' + offline + ' ' + i18next.t('web:dashboard.offline') + ')';
        } else {
          totEl.textContent = '-';
        }
      }

      const wEl = $('#d-world');
      if (wEl) {
        const parts = [];
        if (status.gameTime) parts.push(status.gameTime);
        if (status.gameDay != null) {
          const dps = status.daysPerSeason || 28;
          const dayInSeason = (status.gameDay % dps) + 1;
          const year = Math.floor(status.gameDay / (dps * 4)) + 1;
          const seasonNames = [
            i18next.t('web:dashboard.spring'),
            i18next.t('web:dashboard.summer'),
            i18next.t('web:dashboard.autumn'),
            i18next.t('web:dashboard.winter'),
          ];
          const seasonNum = Math.floor((status.gameDay % (dps * 4)) / dps);
          parts.push(
            i18next.t('web:dashboard.day_of_season', {
              day: dayInSeason,
              season: status.season || seasonNames[seasonNum],
            }),
          );
          parts.push(i18next.t('web:dashboard.year', { year: year }));
        }
        wEl.textContent = parts.length ? parts.join(' \u00b7 ') : '-';
      }

      const evEl = $('#d-events');
      if (evEl) evEl.textContent = fmtNum(stats.eventsToday || 0);

      const maxPts = 20;
      S.dashHistory.online.push(stats.onlinePlayers || 0);
      S.dashHistory.events.push(stats.eventsToday || 0);
      if (S.dashHistory.online.length > maxPts) S.dashHistory.online.shift();
      if (S.dashHistory.events.length > maxPts) S.dashHistory.events.shift();
      if (window.Chart && S.dashHistory.online.length > 1) {
        renderSparkline('spark-online', S.dashHistory.online, '#6dba82');
        renderSparkline('spark-events', S.dashHistory.events, '#d4915c');
      }

      const tzEl = $('#d-tz');
      if (tzEl && status.timezone) tzEl.textContent = status.timezone;

      try {
        const landing = await fetch('/api/landing');
        const ld = await landing.json();
        let srvData = null;
        if (S.currentServer === 'primary') {
          srvData = ld.primary;
        } else if (ld.servers) {
          for (let si = 0; si < ld.servers.length; si++) {
            if (ld.servers[si].id === S.currentServer) {
              srvData = ld.servers[si];
              break;
            }
          }
        }
        if (!srvData) srvData = ld.primary;
        if (srvData.host) {
          const addr = srvData.gamePort ? srvData.host + ':' + srvData.gamePort : srvData.host;
          const dAddr = $('#d-address');
          if (dAddr) dAddr.textContent = addr;
          const dc = $('#dashboard-connect');
          if (dc) dc.classList.remove('hidden');
        }

        // Server Info card — reuse landing settings + status data
        const infoCol = $('#dash-info-col');
        const infoBox = $('#dash-server-info');
        if (infoCol && infoBox && srvData.settings) {
          const infoHtml = renderServerInfo(srvData.settings, {
            gameDay: status.gameDay,
            season: status.season,
            gameTime: status.gameTime,
            daysPerSeason: srvData.daysPerSeason || status.daysPerSeason,
          });
          if (infoHtml) {
            infoBox.innerHTML = '<div class="srv-info-panel">' + infoHtml + '</div>';
            infoCol.classList.remove('hidden');
            if (window.lucide) lucide.createIcons({ nodes: [infoBox] });
            if (window.tippy)
              tippy(infoBox.querySelectorAll('[data-tippy-content]'), {
                theme: 'translucent',
                placement: 'top',
                delay: [150, 0],
              });
          } else {
            infoCol.classList.add('hidden');
          }
        } else if (infoCol) {
          infoCol.classList.add('hidden');
        }
      } catch (_e) {}

      // Schedule card — only if this server has a scheduler
      const sc = $('#schedule-card');
      if (caps.scheduler) {
        try {
          const schedRes = await apiFetch('/api/panel/scheduler');
          const sched = await schedRes.json();
          if (sched.active) {
            S.scheduleData = sched;
            if (sc) sc.classList.remove('hidden');
            if (Panel.tabs.settings) {
              Panel.tabs.settings.renderSchedule($('#schedule-info'), sched, 'dashboard');
              if (sched.rotateDaily && sched.tomorrowSchedule) {
                Panel.tabs.settings.renderTomorrowSchedule($('#schedule-info'), sched);
              }
            }
          } else {
            if (sc) sc.classList.add('hidden');
          }
        } catch (_e) {
          if (sc) sc.classList.add('hidden');
        }
      } else {
        if (sc) sc.classList.add('hidden');
      }

      // Plugin dashboard hooks — only if this server has hzmod
      if (caps.hzmod && window.__panelPlugins?.hzmod?.onDashboardLoad) {
        try {
          await window.__panelPlugins.hzmod.onDashboardLoad(apiFetch, $);
        } catch (_e) {}
      }

      // Resources card — only if this server exposes resources
      const rc = $('#resources-card');
      if (caps.resources && status.resources && S.tier >= 3 && S.viewMode === 'admin') {
        if (rc) rc.classList.remove('hidden');
        renderResources(status.resources, status.uptime);
      } else if (rc) {
        rc.classList.add('hidden');
      }
    } catch (e) {
      console.error('Dashboard error:', e);
    }
  }

  // ═══════════════════════════════════════════════════
  // Server Info Panel — dynamic info for landing cards
  // ═══════════════════════════════════════════════════

  function _diffLabel(v) {
    const k = { 1: 'low', 2: 'normal', 3: 'high', 4: 'very_high', 5: 'nightmare' };
    return i18next.t('web:difficulty.' + (k[v] || 'normal'));
  }
  function _lootLabel(v) {
    const k = { 1: 'scarce', 2: 'normal', 3: 'plenty', 4: 'abundant' };
    return i18next.t('web:loot_level.' + (k[v] || 'normal'));
  }
  function _deathLabel(v) {
    const k = { 0: 'keep_items', 1: 'drop_items', 2: 'destroy_items' };
    return i18next.t('web:on_death.' + (k[v] || 'drop_items'));
  }
  function _ffLabel(v) {
    const k = { 0: 'off', 1: 'individual', 2: 'all' };
    return i18next.t('web:friendly_fire.' + (k[v] || 'on'));
  }

  /**
   * Render dynamic server info panel for a landing card.
   * Uses Lucide icons (data-lucide) and Tippy tooltips (data-tippy-content).
   * @param {object} st — settings from _extractLandingSettings()
   * @param {object} srv — full server data (gameDay, season, gameTime etc.)
   * @returns {string} HTML string
   */
  function renderServerInfo(st, srv) {
    if (!st) return '';
    let h = '';

    // ── Day/Night Cycle ──
    const dayLen = st.dayLength || 40;
    const nightLen = st.nightLength || 20;
    const totalCycle = dayLen + nightLen;
    const _dayPct = Math.round((dayLen / totalCycle) * 100);
    let isNight = false;
    if (srv.gameTime) {
      const tp = srv.gameTime.match(/(\d+):(\d+)/);
      if (tp) {
        const hr = parseInt(tp[1], 10);
        isNight = hr >= 20 || hr < 6;
      }
    }
    const cycleIcon = isNight ? 'moon' : 'sun';
    const cycleLabel = isNight ? i18next.t('web:dashboard.night') : i18next.t('web:dashboard.day');
    h += '<div class="srv-info-section">';
    h += '<div class="srv-info-row">';
    h +=
      '<span class="srv-info-item" data-tippy-content="' +
      i18next.t('web:dashboard.cycle_tip', { dayLen: dayLen, nightLen: nightLen }) +
      '">';
    h += '<i data-lucide="' + cycleIcon + '" class="srv-ico"></i>';
    h += '<span class="srv-info-label">' + cycleLabel + '</span>';
    h += '<span class="srv-info-val">' + dayLen + '/' + nightLen + 'm</span>';
    h += '</span>';

    // XP Multiplier
    if (st.xpMultiplier && st.xpMultiplier !== 1) {
      h += '<span class="srv-info-item" data-tippy-content="' + i18next.t('web:dashboard.xp_tip') + '">';
      h += '<i data-lucide="trending-up" class="srv-ico"></i>';
      h += '<span class="srv-info-label">XP</span>';
      h += '<span class="srv-info-val">' + st.xpMultiplier + 'x</span>';
      h += '</span>';
    }

    // Max vehicles
    if (st.maxVehicles) {
      h += '<span class="srv-info-item" data-tippy-content="' + i18next.t('web:dashboard.vehicles_tip') + '">';
      h += '<i data-lucide="car" class="srv-ico"></i>';
      h += '<span class="srv-info-label">' + i18next.t('web:dashboard.vehicles') + '</span>';
      h += '<span class="srv-info-val">' + st.maxVehicles + '/' + i18next.t('web:dashboard.per_player') + '</span>';
      h += '</span>';
    }
    h += '</div></div>';

    // ── Rules ──
    const rules = [];
    rules.push({
      icon: st.pvp ? 'swords' : 'shield',
      label: st.pvp ? i18next.t('web:dashboard.pvp_on') : i18next.t('web:dashboard.pve'),
      cls: st.pvp ? 'rule-pvp' : 'rule-pve',
      tip: st.pvp ? i18next.t('web:dashboard.pvp_on_tip') : i18next.t('web:dashboard.pve_tip'),
    });
    rules.push({
      icon: 'skull',
      label: _deathLabel(st.onDeath),
      cls: st.onDeath === 0 ? 'rule-easy' : st.onDeath === 2 ? 'rule-hard' : 'rule-mid',
      tip: i18next.t('web:dashboard.on_death_tip') + ': ' + _deathLabel(st.onDeath),
    });
    if (st.friendlyFire)
      rules.push({
        icon: 'users',
        label: i18next.t('web:dashboard.ff') + ': ' + _ffLabel(st.friendlyFire),
        cls: 'rule-mid',
        tip: i18next.t('web:dashboard.ff_tip') + ': ' + _ffLabel(st.friendlyFire),
      });
    if (st.lootRespawn)
      rules.push({
        icon: 'refresh-cw',
        label: i18next.t('web:dashboard.loot_respawn'),
        cls: 'rule-on',
        tip: i18next.t('web:dashboard.loot_respawn_tip'),
      });
    if (st.airDrops)
      rules.push({
        icon: 'package',
        label: i18next.t('web:dashboard.air_drops'),
        cls: 'rule-on',
        tip: i18next.t('web:dashboard.air_drops_tip'),
      });
    if (st.dogCompanion)
      rules.push({
        icon: 'dog',
        label: i18next.t('web:dashboard.companion'),
        cls: 'rule-on',
        tip: i18next.t('web:dashboard.companion_tip'),
      });
    if (st.weaponBreak)
      rules.push({
        icon: 'wrench',
        label: i18next.t('web:dashboard.durability'),
        cls: 'rule-mid',
        tip: i18next.t('web:dashboard.durability_tip'),
      });

    h += '<div class="srv-info-section">';
    h += '<div class="srv-info-rules">';
    for (let ri = 0; ri < rules.length; ri++) {
      const r = rules[ri];
      h += '<span class="srv-rule ' + r.cls + '" data-tippy-content="' + esc(r.tip) + '">';
      h += '<i data-lucide="' + r.icon + '" class="srv-rule-ico"></i>';
      h += r.label;
      h += '</span>';
    }
    h += '</div></div>';

    // ── Threat Level (zombies & bandits) ──
    h += '<div class="srv-info-section">';
    h += '<div class="srv-info-threats">';
    h += _renderThreatBar(
      i18next.t('web:dashboard.zombies'),
      st.zombieHealth,
      st.zombieDamage,
      st.zombieSpeed,
      st.zombieAmount,
      'skull',
    );
    h += _renderThreatBar(
      i18next.t('web:dashboard.bandits'),
      st.banditHealth,
      st.banditDamage,
      null,
      st.banditAmount,
      'crosshair',
    );
    h += '</div></div>';

    // ── Loot Rarity ──
    const lootItems = [
      { key: 'rarityFood', label: i18next.t('web:dashboard.food'), icon: 'apple' },
      { key: 'rarityDrink', label: i18next.t('web:dashboard.drinks'), icon: 'droplets' },
      { key: 'rarityMelee', label: i18next.t('web:dashboard.melee'), icon: 'axe' },
      { key: 'rarityRanged', label: i18next.t('web:dashboard.ranged'), icon: 'target' },
      { key: 'rarityAmmo', label: i18next.t('web:dashboard.ammo'), icon: 'zap' },
      { key: 'rarityArmor', label: i18next.t('web:dashboard.armor'), icon: 'shield' },
      { key: 'rarityResources', label: i18next.t('web:dashboard.resources'), icon: 'hammer' },
    ];
    let hasLoot = false;
    for (let li = 0; li < lootItems.length; li++) {
      if (st[lootItems[li].key]) {
        hasLoot = true;
        break;
      }
    }
    if (hasLoot) {
      h += '<div class="srv-info-section">';
      h += '<div class="srv-info-loot">';
      for (let li2 = 0; li2 < lootItems.length; li2++) {
        const lt = lootItems[li2];
        const val = st[lt.key] || 2;
        const lootLabel = _lootLabel(val);
        const lootCls =
          val <= 1 ? 'loot-scarce' : val >= 4 ? 'loot-abundant' : val >= 3 ? 'loot-plenty' : 'loot-normal';
        h += '<span class="srv-loot ' + lootCls + '" data-tippy-content="' + lt.label + ': ' + lootLabel + '">';
        h += '<i data-lucide="' + lt.icon + '" class="srv-loot-ico"></i>';
        h += '<span class="srv-loot-label">' + lt.label + '</span>';
        h += '</span>';
      }
      h += '</div></div>';
    }

    // ── World Stats (if available from save data) ──
    const statsArr = [];
    if (st.worldStructures)
      statsArr.push({
        icon: 'building',
        val: st.worldStructures,
        label: i18next.t('web:dashboard.structures'),
        tip: i18next.t('web:dashboard.structures_tip'),
      });
    if (st.worldVehicles)
      statsArr.push({
        icon: 'car',
        val: st.worldVehicles,
        label: i18next.t('web:dashboard.vehicles'),
        tip: i18next.t('web:dashboard.vehicles_map_tip'),
      });
    if (st.worldCompanions)
      statsArr.push({
        icon: 'dog',
        val: st.worldCompanions,
        label: i18next.t('web:dashboard.companions'),
        tip: i18next.t('web:dashboard.companions_tip'),
      });
    if (st.totalKills)
      statsArr.push({
        icon: 'skull',
        val: _formatK(st.totalKills),
        label: i18next.t('web:dashboard.kills'),
        tip: i18next.t('web:dashboard.kills_tip'),
      });
    if (statsArr.length) {
      h += '<div class="srv-info-section">';
      h += '<div class="srv-info-stats">';
      for (let wi = 0; wi < statsArr.length; wi++) {
        const ws = statsArr[wi];
        h += '<span class="srv-stat" data-tippy-content="' + esc(ws.tip) + '">';
        h += '<i data-lucide="' + ws.icon + '" class="srv-stat-ico"></i>';
        h += '<span class="srv-stat-val">' + ws.val + '</span>';
        h += '<span class="srv-stat-label">' + ws.label + '</span>';
        h += '</span>';
      }
      h += '</div></div>';
    }

    return h;
  }

  /** Render a compact threat bar for zombies/bandits */
  function _renderThreatBar(label, health, damage, speed, amount, icon) {
    // Average threat score: 1-4 scale (from the difficulty values)
    const vals = [health || 2, damage || 2];
    if (speed != null) vals.push(speed);
    let avg = 0;
    for (let i = 0; i < vals.length; i++) avg += vals[i];
    avg = avg / vals.length;
    const pct = Math.round(((avg - 1) / 3) * 100); // 1=0%, 4=100%
    const amtStr = amount ? (amount === 1 ? '1x' : amount + 'x') : '';
    const threatCls = avg <= 1.5 ? 'threat-low' : avg >= 3 ? 'threat-high' : 'threat-mid';

    const tipParts = [];
    tipParts.push(i18next.t('web:dashboard.health') + ': ' + _diffLabel(health));
    tipParts.push(i18next.t('web:dashboard.damage') + ': ' + _diffLabel(damage));
    if (speed != null) tipParts.push(i18next.t('web:dashboard.speed') + ': ' + _diffLabel(speed));
    if (amtStr) tipParts.push(i18next.t('web:dashboard.amount') + ': ' + amtStr);
    const tip = label + ' — ' + tipParts.join(', ');

    let h = '<div class="srv-threat ' + threatCls + '" data-tippy-content="' + esc(tip) + '">';
    h += '<div class="srv-threat-head">';
    h += '<i data-lucide="' + icon + '" class="srv-threat-ico"></i>';
    h += '<span class="srv-threat-label">' + label + '</span>';
    if (amtStr) h += '<span class="srv-threat-amt">' + amtStr + '</span>';
    h += '</div>';
    h += '<div class="srv-threat-track"><div class="srv-threat-fill" style="width:' + pct + '%"></div></div>';
    h += '</div>';
    return h;
  }

  /** Format large numbers: 1000 → 1K, 15000 → 15K */
  function _formatK(n) {
    if (n >= 1000) return Math.round(n / 1000) + 'K';
    return '' + n;
  }

  // ── Resources ─────────────────────────────────────

  function renderResources(res, uptime) {
    const container = $('#resources-info');
    if (!container) return;
    container.innerHTML = '';
    const bars = [
      {
        label: i18next.t('web:resources.cpu'),
        val: res.cpu,
        cls: 'cpu',
        fmt: (res.cpu || 0).toFixed(1) + '%',
        color: '#5b8fd4',
      },
      {
        label: i18next.t('web:resources.memory'),
        val: res.memPercent,
        cls: 'mem',
        fmt: res.memFormatted || (res.memPercent || 0).toFixed(1) + '%',
        color: '#9b72cf',
      },
      {
        label: i18next.t('web:resources.disk'),
        val: res.diskPercent,
        cls: 'disk',
        fmt: res.diskFormatted || (res.diskPercent || 0).toFixed(1) + '%',
        color: '#d4a843',
      },
    ];
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i];
      const pct = Math.min(b.val || 0, 100);
      const row = el('div', 'space-y-1.5');
      row.innerHTML =
        '<div class="flex justify-between text-xs"><span class="text-muted">' +
        b.label +
        '</span><span class="text-gray-300 font-mono text-[11px]">' +
        b.fmt +
        '</span></div><div class="res-bar-track"><div class="res-bar-fill ' +
        b.cls +
        '" style="width:0%"></div></div>';
      container.appendChild(row);

      if (typeof gsap !== 'undefined') {
        const fill = row.querySelector('.res-bar-fill');
        if (fill) gsap.to(fill, { width: pct + '%', duration: 0.5, ease: 'power2.out' });
      } else {
        const fill2 = row.querySelector('.res-bar-fill');
        if (fill2) fill2.style.width = pct + '%';
      }
    }
    if (uptime) {
      const up = el('div', 'flex justify-between text-xs mt-2');
      up.innerHTML =
        '<span class="text-muted">' +
        i18next.t('web:resources.uptime') +
        '</span><span class="text-gray-300 font-mono text-[11px]">' +
        esc(uptime) +
        '</span>';
      container.appendChild(up);
    }
  }

  // ── Init / Reset ──────────────────────────────────

  let _inited = false;
  function init() {
    if (_inited) return;
    _inited = true;
  }

  function reset() {
    _inited = false;
  }

  Panel.tabs.dashboard = {
    init: init,
    load: loadDashboard,
    reset: reset,
    renderServerInfo: renderServerInfo,
  };
})();

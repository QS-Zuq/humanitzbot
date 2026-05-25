/**
 * Panel Tab: Players — player list, sorting, modal, and detail views.
 * @namespace Panel.tabs.players
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
  const formatPlaytime = Panel.core.utils.formatPlaytime;
  const entityLink = Panel.core.utils.entityLink;
  const clampToViewport =
    Panel.core.utils.clampToViewport ||
    function (popup) {
      if (!popup) return;
      const rect = popup.getBoundingClientRect();
      if (rect.right > window.innerWidth - 8) popup.style.left = Math.max(8, window.innerWidth - rect.width - 8) + 'px';
      if (rect.bottom > window.innerHeight - 8)
        popup.style.top = Math.max(8, window.innerHeight - rect.height - 8) + 'px';
    };
  const setBreadcrumbs = Panel.nav.setBreadcrumbs;
  const getTabLabels = Panel.nav.getTabLabels;

  let _inited = false;
  const _playerDetailCache = new Map();

  function init() {
    if (_inited) return;
    _inited = true;
  }

  // ── Data Loading ────────────────────────────────────────────────

  async function loadPlayers() {
    Panel.core.utils.setTabUnavailable('tab-players', S.currentServer === 'all');
    if (S.currentServer === 'all') return;
    try {
      const r = await apiFetch('/api/players');
      if (!r.ok) return;
      const d = await r.json();
      S.players = d.players || [];
      S.toggles = d.toggles || {};
      renderPlayers();
    } catch (e) {
      console.error('Players error:', e);
    }
  }

  function renderPlayers() {
    if (S.playerViewMode === 'cards') renderPlayerCards();
    else renderPlayerTable();
  }

  // ── Table View ──────────────────────────────────────────────────

  function renderPlayerTable() {
    const container = $('#player-list');
    if (!container) return;

    const query = ($('#player-search') ? $('#player-search').value : '').toLowerCase();
    const sort = $('#player-sort') ? $('#player-sort').value : 'online';

    let list = S.players.slice();

    if (query) {
      list = list.filter(function (p) {
        return (
          (p.name || '').toLowerCase().includes(query) ||
          (p.steamId || '').includes(query) ||
          (p.profession || '').toLowerCase().includes(query) ||
          (p.clanName || '').toLowerCase().includes(query)
        );
      });
    }

    list.sort(function (a, b) {
      switch (sort) {
        case 'online':
          return (b.isOnline ? 1 : 0) - (a.isOnline ? 1 : 0) || (a.name || '').localeCompare(b.name || '');
        case 'name':
          return (a.name || '').localeCompare(b.name || '');
        case 'kills':
          return (b.zeeksKilled || 0) - (a.zeeksKilled || 0);
        case 'playtime':
          return (b.totalPlaytime || 0) - (a.totalPlaytime || 0);
        case 'lastSeen':
          return new Date(b.lastSeen || 0) - new Date(a.lastSeen || 0);
        case 'daysSurvived':
          return (b.daysSurvived || 0) - (a.daysSurvived || 0);
        default:
          return 0;
      }
    });

    const sortCol = S.playerSort.col;
    const sortDir = S.playerSort.dir;
    if (sortCol !== 'online') {
      list.sort(function (a, b) {
        let va, vb;
        switch (sortCol) {
          case 'name':
            va = a.name || '';
            vb = b.name || '';
            return sortDir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
          case 'profession':
            va = a.profession || '';
            vb = b.profession || '';
            return sortDir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
          case 'clan':
            va = a.clanName || '';
            vb = b.clanName || '';
            return sortDir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
          case 'kills':
            return sortDir === 'asc'
              ? (a.zeeksKilled || 0) - (b.zeeksKilled || 0)
              : (b.zeeksKilled || 0) - (a.zeeksKilled || 0);
          case 'days':
            return sortDir === 'asc'
              ? (a.daysSurvived || 0) - (b.daysSurvived || 0)
              : (b.daysSurvived || 0) - (a.daysSurvived || 0);
          case 'health': {
            const ha = a.maxHealth > 0 ? a.health / a.maxHealth : 0;
            const hb = b.maxHealth > 0 ? b.health / b.maxHealth : 0;
            return sortDir === 'asc' ? ha - hb : hb - ha;
          }
          case 'playtime':
            return sortDir === 'asc'
              ? (a.totalPlaytime || 0) - (b.totalPlaytime || 0)
              : (b.totalPlaytime || 0) - (a.totalPlaytime || 0);
          default:
            return 0;
        }
      });
    }

    let table = el('table', 'player-table');
    const headers = [
      { key: '', label: '' },
      { key: 'name', label: i18next.t('web:players.name') },
      { key: 'profession', label: i18next.t('web:table.profession', { defaultValue: 'Profession' }) },
      { key: 'clan', label: i18next.t('web:clans.name') },
      { key: 'kills', label: i18next.t('web:players.kills') },
      { key: 'days', label: i18next.t('web:table.days', { defaultValue: 'Days' }) },
      { key: 'health', label: i18next.t('web:table.health', { defaultValue: 'Health' }) },
      { key: 'playtime', label: i18next.t('web:players.playtime') },
      { key: '', label: i18next.t('web:table.steam_id', { defaultValue: 'Steam ID' }) },
    ];

    const thead = el('thead');
    const headRow = el('tr');
    for (let hi = 0; hi < headers.length; hi++) {
      const h = headers[hi];
      const th = el('th');
      const arrow = sortCol === h.key ? (sortDir === 'asc' ? ' \u25B2' : ' \u25BC') : '';
      th.textContent = h.label + arrow;
      if (h.key) {
        th.style.cursor = 'pointer';
        (function (key) {
          th.addEventListener('click', function () {
            if (S.playerSort.col === key) S.playerSort.dir = S.playerSort.dir === 'asc' ? 'desc' : 'asc';
            else {
              S.playerSort.col = key;
              S.playerSort.dir = 'desc';
            }
            renderPlayerTable();
          });
        })(h.key);
      }
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = el('tbody');
    for (let pi = 0; pi < list.length; pi++) {
      const p = list[pi];
      const tr = el('tr', 'clickable');
      const healthPct = p.maxHealth > 0 ? Math.round((p.health / p.maxHealth) * 100) : p.health || 0;
      const healthColor = healthPct > 60 ? '#6dba82' : healthPct > 30 ? '#d4a843' : '#c45a4a';

      tr.innerHTML =
        '<td><span class="status-dot ' +
        (p.isOnline ? 'online' : 'offline') +
        '"></span></td>' +
        '<td><span class="player-link">' +
        esc(p.name) +
        '</span></td>' +
        '<td class="text-muted">' +
        esc(p.profession || '-') +
        '</td>' +
        '<td class="text-muted">' +
        (p.clanName
          ? '<span class="entity-link" data-entity-table="clans" data-entity-search="' +
            esc(p.clanName) +
            '">[' +
            esc(p.clanName) +
            ']</span>'
          : '-') +
        '</td>' +
        '<td>' +
        fmtNum(p.zeeksKilled || 0) +
        '</td>' +
        '<td>' +
        (p.daysSurvived || 0) +
        '</td>' +
        '<td><span style="color:' +
        healthColor +
        '">' +
        healthPct +
        '%</span></td>' +
        '<td class="text-muted">' +
        formatPlaytime(p.totalPlaytime) +
        '</td>' +
        '<td class="font-mono text-xs text-muted"><a href="https://steamcommunity.com/profiles/' +
        esc(p.steamId) +
        '" target="_blank" class="hover:text-accent transition-colors" title="Open Steam profile">' +
        esc(p.steamId) +
        '</a></td>';
      (function (player) {
        tr.addEventListener('click', function (e) {
          if (e.target.closest('a, .player-link, .entity-link')) return;
          showPlayerModal(player);
        });
      })(p);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    container.innerHTML = '';
    if (list.length === 0) {
      container.innerHTML =
        '<p class="text-muted text-center py-8">' + i18next.t('web:empty_states.no_players_found') + '</p>';
    } else {
      container.appendChild(table);
    }
  }

  // ── Card View ───────────────────────────────────────────────────

  function renderPlayerCards() {
    const container = $('#player-list');
    if (!container) return;

    const query = ($('#player-search') ? $('#player-search').value : '').toLowerCase();
    const sort = $('#player-sort') ? $('#player-sort').value : 'online';

    let list = S.players.slice();

    if (query) {
      list = list.filter(function (p) {
        return (
          (p.name || '').toLowerCase().includes(query) ||
          (p.steamId || '').includes(query) ||
          (p.profession || '').toLowerCase().includes(query) ||
          (p.clanName || '').toLowerCase().includes(query)
        );
      });
    }

    list.sort(function (a, b) {
      switch (sort) {
        case 'online':
          return (b.isOnline ? 1 : 0) - (a.isOnline ? 1 : 0) || (a.name || '').localeCompare(b.name || '');
        case 'name':
          return (a.name || '').localeCompare(b.name || '');
        case 'kills':
          return (b.zeeksKilled || 0) - (a.zeeksKilled || 0);
        case 'playtime':
          return (b.totalPlaytime || 0) - (a.totalPlaytime || 0);
        case 'lastSeen':
          return new Date(b.lastSeen || 0) - new Date(a.lastSeen || 0);
        case 'daysSurvived':
          return (b.daysSurvived || 0) - (a.daysSurvived || 0);
        default:
          return 0;
      }
    });

    const grid = el('div', 'player-cards-grid');

    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      const healthPct = p.maxHealth > 0 ? Math.round((p.health / p.maxHealth) * 100) : p.health || 0;
      const healthColor = healthPct > 60 ? '#6dba82' : healthPct > 30 ? '#d4a843' : '#c45a4a';
      const barWidth = Math.max(0, Math.min(100, healthPct));

      const card = el('div', 'player-card');
      if (p.isOnline) card.classList.add('is-online');

      const profLabel = p.profession || i18next.t('web:player_detail.default_survivor', { defaultValue: 'Survivor' });
      const clanTag = p.clanName
        ? ' <span class="pc-clan entity-link" data-entity-table="clans" data-entity-search="' +
          esc(p.clanName) +
          '">[' +
          esc(p.clanName) +
          ']</span>'
        : '';

      card.innerHTML =
        '<div class="pc-header">' +
        '<span class="status-dot ' +
        (p.isOnline ? 'online' : 'offline') +
        '"></span>' +
        '<span class="pc-name">' +
        esc(p.name) +
        '</span>' +
        clanTag +
        '</div>' +
        '<div class="pc-profession">' +
        esc(profLabel) +
        '</div>' +
        '<div class="pc-health">' +
        '<div class="pc-health-bar" style="width:' +
        barWidth +
        '%;background:' +
        healthColor +
        '"></div>' +
        '<span class="pc-health-label">' +
        healthPct +
        '%</span>' +
        '</div>' +
        '<div class="pc-stats">' +
        '<div class="pc-stat"><span class="pc-stat-val">' +
        fmtNum(p.zeeksKilled || 0) +
        '</span><span class="pc-stat-lbl">' +
        i18next.t('web:players.kills') +
        '</span></div>' +
        '<div class="pc-stat"><span class="pc-stat-val">' +
        (p.daysSurvived || 0) +
        '</span><span class="pc-stat-lbl">' +
        i18next.t('web:table.days', { defaultValue: 'Days' }) +
        '</span></div>' +
        '<div class="pc-stat"><span class="pc-stat-val">' +
        formatPlaytime(p.totalPlaytime) +
        '</span><span class="pc-stat-lbl">' +
        i18next.t('web:players.playtime') +
        '</span></div>' +
        '</div>';

      (function (player) {
        card.addEventListener('click', function () {
          showPlayerModal(player);
        });
      })(p);

      grid.appendChild(card);
    }

    container.innerHTML = '';
    if (list.length === 0) {
      container.innerHTML =
        '<p class="text-muted text-center py-8">' + i18next.t('web:empty_states.no_players_found') + '</p>';
    } else {
      container.appendChild(grid);
    }
  }

  // ── Player Modal ────────────────────────────────────────────────

  function showPlayerModal(p) {
    const modal = $('#player-modal');
    const content = $('#player-modal-content');
    if (!modal || !content) return false;
    if (modal.closest && modal.closest('.tab-content')) document.body.appendChild(modal);
    if (p && p.steamId) _playerDetailCache.set(p.steamId, p);
    content.innerHTML = buildPlayerDetail(p);
    content.dataset.steamId = p.steamId || '';
    modal.classList.remove('hidden');

    setBreadcrumbs([
      { label: getTabLabels()[S.currentTab] || S.currentTab, action: 'tab' },
      { label: p.name || i18next.t('web:player_detail.player_fallback', { defaultValue: 'Player' }) },
    ]);

    if (typeof gsap !== 'undefined') {
      const inner = modal.querySelector('.bg-surface-100');
      if (inner) gsap.fromTo(inner, { opacity: 0, y: 12 }, { opacity: 1, y: 0, duration: 0.2, ease: 'power2.out' });
    }
    return true;
  }

  function _playerPopupValue(label, value) {
    if (value == null || value === '') return '';
    return (
      '<div class="flex justify-between gap-3 text-xs">' +
      '<span class="text-muted">' +
      esc(label) +
      '</span><span class="text-gray-300 truncate text-right" title="' +
      esc(value) +
      '">' +
      esc(value) +
      '</span></div>'
    );
  }

  function _playerName(p) {
    return (p && p.name) || i18next.t('web:player_detail.player_fallback', { defaultValue: 'Unknown Player' });
  }

  function _renderPlayerPopup(triggerEl, p, loading) {
    const old = document.querySelector('.item-popup');
    if (old) old.remove();

    const popup = document.createElement('div');
    popup.className = 'item-popup player-popup';

    const steamId = (p && p.steamId) || '';
    const playerName = _playerName(p);
    const isOnline = !!(p && p.isOnline);
    const statusLabel = isOnline
      ? i18next.t('web:dashboard.online', { defaultValue: 'Online' })
      : i18next.t('web:dashboard.offline', { defaultValue: 'Offline' });

    let html =
      '<div class="item-popup-header">' +
      esc(playerName) +
      '<span class="item-popup-close" style="cursor:pointer;color:var(--color-horde, #c45a4a);font-size:14px;line-height:1;padding:2px 4px;border-radius:3px;margin:-2px -4px -2px 0" title="Close">&times;</span></div>';
    html += '<div class="item-popup-body">';
    html +=
      '<div class="flex items-center gap-1.5 text-[10px] mb-2 ' +
      (isOnline ? 'text-emerald-400' : 'text-muted') +
      '"><span class="status-dot ' +
      (isOnline ? 'online' : 'offline') +
      '" style="width:7px;height:7px"></span>' +
      esc(statusLabel) +
      '</div>';

    if (loading)
      html +=
        '<div class="text-[10px] text-muted mb-2">' +
        i18next.t('web:loading.generic', { defaultValue: 'Loading...' }) +
        '</div>';

    html += '<div class="grid gap-y-0.5 mb-2">';
    html += _playerPopupValue(i18next.t('web:player_detail.steam_id', { defaultValue: 'Steam ID' }), steamId);
    if (p && p.level)
      html += _playerPopupValue(i18next.t('web:player_detail.level', { defaultValue: 'Level' }), p.level);
    if (p && p.clanName)
      html += _playerPopupValue(
        i18next.t('web:player_detail.clan', { defaultValue: 'Clan' }),
        p.clanName + (p.clanRank ? ' (' + p.clanRank + ')' : ''),
      );
    if (p && p.profession)
      html += _playerPopupValue(
        i18next.t('web:player_detail.profession', { defaultValue: 'Profession' }),
        p.profession,
      );
    html += '</div>';

    html += '<div class="mt-2 flex gap-2 flex-wrap">';
    if (steamId) {
      html +=
        '<span class="activity-link text-[10px] text-accent hover:underline cursor-pointer" data-search="' +
        esc(steamId) +
        '" data-mode="player" data-steam-id="' +
        esc(steamId) +
        '">' +
        i18next.t('web:player_detail.activity_log', { defaultValue: 'Activity log' }) +
        ' \u2192</span>';
      html +=
        '<span class="player-detail-link text-[10px] text-accent hover:underline cursor-pointer" data-steam-id="' +
        esc(steamId) +
        '">' +
        i18next.t('web:player_detail.view_details', { defaultValue: 'View details' }) +
        ' \u2192</span>';
      html +=
        '<a href="https://steamcommunity.com/profiles/' +
        esc(steamId) +
        '" target="_blank" class="text-[10px] text-accent hover:underline">' +
        i18next.t('web:player_detail.steam_profile', { defaultValue: 'Steam profile' }) +
        ' \u2197</a>';
    }
    html += '</div></div>';

    popup.innerHTML = html;

    const rect = triggerEl.getBoundingClientRect();
    popup.style.position = 'fixed';
    popup.style.left = Math.min(rect.right + 8, window.innerWidth - 320) + 'px';
    popup.style.top = Math.max(rect.top - 20, 8) + 'px';
    popup.style.zIndex = '10000';
    popup.style.maxWidth = '320px';
    document.body.appendChild(popup);
    clampToViewport(popup);
  }

  async function showPlayerPopup(triggerEl, playerOrRef) {
    if (!triggerEl) return;
    const steamId = (playerOrRef && playerOrRef.steamId) || '';
    const cached = steamId
      ? S.players.find(function (p) {
          return p.steamId === steamId;
        })
      : null;
    const player = cached || _playerDetailCache.get(steamId) || playerOrRef || {};
    if (steamId && player && player.steamId) _playerDetailCache.set(steamId, player);
    _renderPlayerPopup(triggerEl, player, !!steamId && !cached);

    if (steamId && !cached) {
      try {
        const r = await apiFetch('/api/players/' + encodeURIComponent(steamId));
        if (r.ok) {
          const fetched = await r.json();
          if (fetched && fetched.steamId) _playerDetailCache.set(fetched.steamId, fetched);
          _renderPlayerPopup(triggerEl, fetched, false);
        }
      } catch (_e) {
        /* keep the lightweight fallback popup */
      }
    }
  }

  // ── Player Detail Builder ───────────────────────────────────────

  function buildPlayerDetail(p) {
    let html = '';

    html += '<div class="flex items-center gap-3 mb-4">';
    html +=
      '<span class="status-dot ' + (p.isOnline ? 'online' : 'offline') + '" style="width:10px;height:10px"></span>';
    html += '<div>';
    html += '<h2 class="text-lg font-semibold text-white">' + esc(p.name) + '</h2>';
    html +=
      '<div class="text-xs text-muted">' +
      entityLink(
        p.profession || i18next.t('web:player_detail.profession_unknown', { defaultValue: 'Unknown' }),
        'profession',
      ) +
      ' \u00b7 ' +
      (p.male
        ? i18next.t('web:player_detail.gender.male', { defaultValue: 'Male' })
        : i18next.t('web:player_detail.gender.female', { defaultValue: 'Female' }));
    if (p.affliction && p.affliction !== 'Unknown') html += ' \u00b7 ' + entityLink(p.affliction, 'affliction');
    if (p.clanName)
      html +=
        ' \u00b7 <span class="entity-link" data-entity-table="clans" data-entity-search="' +
        esc(p.clanName) +
        '">[' +
        esc(p.clanName) +
        ']</span>' +
        (p.clanRank ? ' (' + esc(p.clanRank) + ')' : '');
    html += '</div>';
    html +=
      '<div class="flex items-center gap-3 flex-wrap mt-0.5"><a href="https://steamcommunity.com/profiles/' +
      esc(p.steamId) +
      '" target="_blank" class="text-[11px] text-accent hover:underline font-mono">' +
      esc(p.steamId) +
      '</a>';
    if (p.steamId) {
      html +=
        '<span class="activity-link text-[11px] text-accent hover:underline cursor-pointer" data-search="' +
        esc(p.steamId) +
        '" data-mode="player" data-steam-id="' +
        esc(p.steamId) +
        '">' +
        i18next.t('web:player_detail.activity_log', { defaultValue: 'Activity log' }) +
        ' \u2192</span>';
    }
    html += '</div>';
    html += '</div></div>';

    if (p.level || p.expCurrent) {
      const expPct = p.expRequired > 0 ? Math.round((p.expCurrent / p.expRequired) * 100) : 0;
      html +=
        '<div class="mb-4"><div class="flex items-center justify-between mb-1"><span class="text-xs font-medium text-muted">' +
        i18next.t('web:player_detail.level', { defaultValue: 'Level' }) +
        ' ' +
        (p.level || 0) +
        '</span>';
      html +=
        '<span class="text-[10px] text-muted">' +
        fmtNum(Math.round(p.expCurrent || 0)) +
        ' / ' +
        fmtNum(Math.round(p.expRequired || 0)) +
        ' ' +
        i18next.t('web:player_detail.xp', { defaultValue: 'XP' }) +
        '</span></div>';
      html +=
        '<div class="vital-track"><div class="vital-fill" style="width:' +
        expPct +
        '%;background:#60a5fa"></div></div>';
      if (p.skillsPoint)
        html +=
          '<div class="text-[10px] text-accent mt-0.5">' +
          i18next.t('web:player_detail.skill_points_available', {
            count: p.skillsPoint,
            defaultValue: '{{count}} skill point available',
            defaultValue_plural: '{{count}} skill points available',
          }) +
          '</div>';
      html += '</div>';
    }

    html +=
      '<div class="mb-4"><h3 class="text-xs font-medium text-muted uppercase tracking-wider mb-2">' +
      i18next.t('web:player_detail.sections.kill_stats_current_life', { defaultValue: 'Kill Stats (Current Life)' }) +
      '</h3>';
    html += '<div class="grid grid-cols-4 gap-2">';
    const killStats = [
      [i18next.t('web:player_detail.stats.zombies', { defaultValue: 'Zombies' }), p.zeeksKilled],
      [i18next.t('web:player_detail.stats.headshots', { defaultValue: 'Headshots' }), p.headshots],
      [i18next.t('web:player_detail.stats.melee', { defaultValue: 'Melee' }), p.meleeKills],
      [i18next.t('web:player_detail.stats.gun', { defaultValue: 'Gun' }), p.gunKills],
      [i18next.t('web:player_detail.stats.blast', { defaultValue: 'Blast' }), p.blastKills],
      [i18next.t('web:player_detail.stats.fist', { defaultValue: 'Fist' }), p.fistKills],
      [i18next.t('web:player_detail.stats.takedown', { defaultValue: 'Takedown' }), p.takedownKills],
      [i18next.t('web:player_detail.stats.vehicle', { defaultValue: 'Vehicle' }), p.vehicleKills],
    ];
    for (let ki = 0; ki < killStats.length; ki++) {
      html +=
        '<div class="text-center"><div class="text-sm font-semibold text-white">' +
        fmtNum(killStats[ki][1] || 0) +
        '</div><div class="text-[10px] text-muted">' +
        killStats[ki][0] +
        '</div></div>';
    }
    html += '</div></div>';

    if (p.hasExtendedStats) {
      html +=
        '<div class="mb-4"><h3 class="text-xs font-medium text-muted uppercase tracking-wider mb-2">' +
        i18next.t('web:player_detail.sections.lifetime_kills', { defaultValue: 'Lifetime Kills' }) +
        '</h3>';
      html += '<div class="grid grid-cols-4 gap-2">';
      const ltStats = [
        [i18next.t('web:player_detail.stats.total', { defaultValue: 'Total' }), p.lifetimeKills],
        [i18next.t('web:player_detail.stats.headshots', { defaultValue: 'Headshots' }), p.lifetimeHeadshots],
        [i18next.t('web:player_detail.stats.melee', { defaultValue: 'Melee' }), p.lifetimeMeleeKills],
        [i18next.t('web:player_detail.stats.gun', { defaultValue: 'Gun' }), p.lifetimeGunKills],
        [i18next.t('web:player_detail.stats.blast', { defaultValue: 'Blast' }), p.lifetimeBlastKills],
        [i18next.t('web:player_detail.stats.fist', { defaultValue: 'Fist' }), p.lifetimeFistKills],
        [i18next.t('web:player_detail.stats.takedown', { defaultValue: 'Takedown' }), p.lifetimeTakedownKills],
        [i18next.t('web:player_detail.stats.vehicle', { defaultValue: 'Vehicle' }), p.lifetimeVehicleKills],
      ];
      for (let li = 0; li < ltStats.length; li++) {
        html +=
          '<div class="text-center"><div class="text-sm font-semibold text-white">' +
          fmtNum(ltStats[li][1] || 0) +
          '</div><div class="text-[10px] text-muted">' +
          ltStats[li][0] +
          '</div></div>';
      }
      html += '</div></div>';
    }

    html +=
      '<div class="mb-4"><h3 class="text-xs font-medium text-muted uppercase tracking-wider mb-2">' +
      i18next.t('web:player_detail.sections.survival', { defaultValue: 'Survival' }) +
      '</h3>';
    html += '<div class="grid grid-cols-4 gap-2">';
    const survStats = [
      [i18next.t('web:player_detail.stats.days_survived', { defaultValue: 'Days Survived' }), p.daysSurvived],
      [i18next.t('web:player_detail.stats.lifetime_days', { defaultValue: 'Lifetime Days' }), p.lifetimeDaysSurvived],
      [i18next.t('web:player_detail.stats.times_bitten', { defaultValue: 'Times Bitten' }), p.timesBitten],
      [i18next.t('web:player_detail.stats.fish_caught', { defaultValue: 'Fish Caught' }), p.fishCaught],
      [i18next.t('web:player_detail.stats.deaths', { defaultValue: 'Deaths' }), p.deaths],
      [i18next.t('web:player_detail.stats.pvp_kills', { defaultValue: 'PvP Kills' }), p.pvpKills],
      [i18next.t('web:player_detail.stats.pvp_deaths', { defaultValue: 'PvP Deaths' }), p.pvpDeaths],
      [i18next.t('web:player_detail.stats.builds', { defaultValue: 'Builds' }), p.builds],
      [i18next.t('web:player_detail.stats.containers', { defaultValue: 'Containers' }), p.containersLooted],
      [i18next.t('web:player_detail.stats.raids_out', { defaultValue: 'Raids Out' }), p.raidsOut],
      [i18next.t('web:player_detail.stats.raids_in', { defaultValue: 'Raids In' }), p.raidsIn],
      [i18next.t('web:player_detail.stats.connects', { defaultValue: 'Connects' }), p.connects],
    ];
    for (let si = 0; si < survStats.length; si++) {
      html +=
        '<div class="text-center"><div class="text-sm font-semibold text-white">' +
        fmtNum(survStats[si][1] || 0) +
        '</div><div class="text-[10px] text-muted">' +
        survStats[si][0] +
        '</div></div>';
    }
    html += '</div>';
    html += '<div class="flex items-center justify-between mt-2 pt-2 border-t border-border/30 text-xs">';
    html +=
      '<div><span class="text-muted">' +
      i18next.t('web:players.playtime') +
      ':</span> <span class="text-white font-medium">' +
      formatPlaytime(p.totalPlaytime) +
      '</span></div>';
    html +=
      '<div><span class="text-muted">' +
      i18next.t('web:players.last_seen') +
      ':</span> <span class="text-white">' +
      (p.lastSeen ? new Date(p.lastSeen).toLocaleDateString() : '-') +
      '</span></div>';
    html += '</div></div>';

    if (S.toggles.showVitals !== false) {
      html +=
        '<div class="mb-4"><h3 class="text-xs font-medium text-muted uppercase tracking-wider mb-2">' +
        i18next.t('web:player_detail.sections.vitals', { defaultValue: 'Vitals' }) +
        '</h3>';
      html += '<div class="space-y-1.5">';
      const vitals = [
        {
          label: i18next.t('web:player_detail.vitals.health', { defaultValue: 'Health' }),
          cur: p.health,
          max: p.maxHealth,
          color: '#6dba82',
        },
        {
          label: i18next.t('web:player_detail.vitals.hunger', { defaultValue: 'Hunger' }),
          cur: p.hunger,
          max: p.maxHunger,
          color: '#d4a843',
        },
        {
          label: i18next.t('web:player_detail.vitals.thirst', { defaultValue: 'Thirst' }),
          cur: p.thirst,
          max: p.maxThirst,
          color: '#3b82f6',
        },
        {
          label: i18next.t('web:player_detail.vitals.stamina', { defaultValue: 'Stamina' }),
          cur: p.stamina,
          max: p.maxStamina,
          color: '#a855f7',
        },
        {
          label: i18next.t('web:player_detail.vitals.infection', { defaultValue: 'Infection' }),
          cur: p.infection,
          max: p.maxInfection,
          color: '#c45a4a',
        },
      ];
      if (p.battery != null)
        vitals.push({
          label: i18next.t('web:player_detail.vitals.battery', { defaultValue: 'Battery' }),
          cur: p.battery,
          max: 100,
          color: '#38bdf8',
        });
      if (p.fatigue != null)
        vitals.push({
          label: i18next.t('web:player_detail.vitals.fatigue', { defaultValue: 'Fatigue' }),
          cur: p.fatigue,
          max: 100,
          color: '#818cf8',
        });
      for (let vi = 0; vi < vitals.length; vi++) {
        const v = vitals[vi];
        const max = v.max || 100;
        const pct = max > 0 ? Math.round((v.cur / max) * 100) : 0;
        html +=
          '<div class="vital-row"><span class="vital-label">' +
          v.label +
          '</span><div class="vital-track"><div class="vital-fill" style="width:' +
          pct +
          '%;background:' +
          v.color +
          '"></div></div><span class="vital-val">' +
          Math.round(v.cur || 0) +
          ' / ' +
          Math.round(max) +
          '</span></div>';
      }
      html += '</div></div>';
    }

    if ((p.playerStates && p.playerStates.length) || (p.bodyConditions && p.bodyConditions.length)) {
      html +=
        '<div class="mb-4"><h3 class="text-xs font-medium text-muted uppercase tracking-wider mb-2">' +
        i18next.t('web:player_detail.sections.status_effects', { defaultValue: 'Status Effects' }) +
        '</h3>';
      html += '<div class="flex flex-wrap gap-1">';
      const ps2 = p.playerStates || [];
      for (let psi = 0; psi < ps2.length; psi++)
        html +=
          '<span class="text-[11px] bg-amber-400/10 text-amber-400 px-1.5 py-0.5 rounded entity-link" data-entity-table="game_afflictions" data-entity-search="' +
          esc(ps2[psi]) +
          '">' +
          esc(ps2[psi]) +
          '</span>';
      const bc = p.bodyConditions || [];
      for (let bci = 0; bci < bc.length; bci++)
        html +=
          '<span class="text-[11px] bg-red-400/10 text-red-400 px-1.5 py-0.5 rounded entity-link" data-entity-table="game_afflictions" data-entity-search="' +
          esc(bc[bci]) +
          '">' +
          esc(bc[bci]) +
          '</span>';
      html += '</div></div>';
    }

    if (S.toggles.showInventory !== false) {
      html += buildInventorySection(
        i18next.t('web:player_detail.inventory.equipment', { defaultValue: 'Equipment' }),
        p.equipment,
        'equipment',
      );
      html += buildInventorySection(
        i18next.t('web:player_detail.inventory.quick_slots', { defaultValue: 'Quick Slots' }),
        p.quickSlots,
        'quickslots',
      );
      html += buildInventorySection(
        i18next.t('web:player_detail.inventory.inventory', { defaultValue: 'Inventory' }),
        p.inventory,
        'storage',
      );
      html += buildInventorySection(
        i18next.t('web:player_detail.inventory.backpack', { defaultValue: 'Backpack' }),
        p.backpackItems,
        'storage',
      );
    }

    if (S.toggles.showRecipes !== false && p.craftingRecipes && p.craftingRecipes.length) {
      html +=
        '<div class="mb-3"><h3 class="text-xs font-medium text-muted uppercase tracking-wider mb-1.5">' +
        i18next.t('web:player_detail.sections.crafting_recipes', {
          count: p.craftingRecipes.length,
          defaultValue: 'Crafting Recipes ({{count}})',
        }) +
        '</h3>';
      html += '<div class="flex flex-wrap gap-1">';
      for (let ri = 0; ri < p.craftingRecipes.length; ri++) {
        const recipeName = p.craftingRecipes[ri];
        html +=
          '<span class="text-[10px] bg-surface-50 border border-border px-1.5 py-0.5 rounded text-muted cursor-pointer hover:text-accent hover:border-accent/40 transition-colors inv-clickable" data-item-name="' +
          esc(recipeName) +
          '">' +
          esc(recipeName) +
          '</span>';
      }
      html += '</div></div>';
    }

    if (p.unlockedSkills && p.unlockedSkills.length) {
      html +=
        '<div class="mb-3"><h3 class="text-xs font-medium text-muted uppercase tracking-wider mb-1.5">' +
        i18next.t('web:player_detail.sections.unlocked_skills', {
          count: p.unlockedSkills.length,
          defaultValue: 'Unlocked Skills ({{count}})',
        }) +
        '</h3>';
      html += '<div class="flex flex-wrap gap-1">';
      for (let ski = 0; ski < p.unlockedSkills.length; ski++)
        html +=
          '<span class="text-[10px] bg-accent/10 text-accent px-1.5 py-0.5 rounded entity-link" data-entity-table="game_skills" data-entity-search="' +
          esc(p.unlockedSkills[ski]) +
          '">' +
          esc(p.unlockedSkills[ski]) +
          '</span>';
      html += '</div></div>';
    }

    if (S.toggles.showCoordinates !== false && p.hasPosition) {
      html +=
        '<div class="mt-3 text-[11px] text-muted font-mono">' +
        i18next.t('web:player_detail.position', { defaultValue: 'Position' }) +
        ': ' +
        p.worldX +
        ', ' +
        p.worldY +
        ', ' +
        p.worldZ +
        '</div>';
    }

    return html;
  }

  // ── Inventory Section Builder ───────────────────────────────────

  function buildInventorySection(title, items, gridType) {
    if (!items || !items.length) return '';
    const filled = items.filter(function (i) {
      if (!i) return false;
      if (typeof i === 'string') return i !== 'Empty' && i !== 'None' && i !== '';
      return i.item || i.name;
    });
    if (!filled.length) return '';

    let html =
      '<div class="mb-3"><h3 class="text-xs font-medium text-muted uppercase tracking-wider mb-1.5">' + title + '</h3>';
    html += '<div class="inv-grid ' + gridType + '">';

    for (let ii = 0; ii < items.length; ii++) {
      const item = items[ii];
      if (!item) {
        html +=
          '<div class="inv-slot empty"><span class="inv-name">' +
          i18next.t('web:player_detail.inventory.empty_slot', { defaultValue: 'Empty' }) +
          '</span></div>';
        continue;
      }
      if (typeof item === 'string') {
        if (item === 'Empty' || item === 'None' || item === '')
          html +=
            '<div class="inv-slot empty"><span class="inv-name">' +
            i18next.t('web:player_detail.inventory.empty_slot', { defaultValue: 'Empty' }) +
            '</span></div>';
        else
          html +=
            '<div class="inv-slot inv-clickable" data-item-name="' +
            esc(item) +
            '"><span class="inv-name">' +
            esc(item) +
            '</span></div>';
        continue;
      }
      let name = item.item || item.name || '';
      let qty = item.amount || item.quantity || 1;
      if (!name || name === 'Empty' || name === 'None') {
        html +=
          '<div class="inv-slot empty"><span class="inv-name">' +
          i18next.t('web:player_detail.inventory.empty_slot', { defaultValue: 'Empty' }) +
          '</span></div>';
      } else {
        const durPct = item.durability != null ? Math.round(item.durability) : null;
        const durColor = durPct != null ? (durPct > 60 ? '#6dba82' : durPct > 25 ? '#d4a843' : '#c45a4a') : '';
        const durBar =
          durPct != null
            ? '<div class="inv-dur-track"><div class="inv-dur-fill" style="width:' +
              durPct +
              '%;background:' +
              durColor +
              '"></div></div>'
            : '';
        const fpAttr = item.fingerprint ? ' data-item-fp="' + esc(item.fingerprint) + '"' : '';
        const ammoAttr = item.ammo ? ' data-item-ammo="' + item.ammo + '"' : '';
        const attachAttr =
          item.attachments && item.attachments.length
            ? ' data-item-attach="' + esc(JSON.stringify(item.attachments)) + '"'
            : '';
        const maxDurAttr = item.maxDur ? ' data-item-maxdur="' + item.maxDur + '"' : '';
        html +=
          '<div class="inv-slot inv-clickable" data-item-name="' +
          esc(name) +
          '" data-item-qty="' +
          qty +
          '" data-item-dur="' +
          (durPct != null ? durPct : '') +
          '"' +
          fpAttr +
          ammoAttr +
          attachAttr +
          maxDurAttr +
          '><span class="inv-name">' +
          esc(name) +
          '</span>' +
          (qty > 1 ? '<span class="inv-qty">\u00d7' + qty + '</span>' : '') +
          durBar +
          '</div>';
      }
    }
    html += '</div></div>';
    return html;
  }

  // ── Fetch and Show Player (for cross-tab navigation) ────────────

  async function fetchAndShowPlayer(steamId) {
    try {
      const r = await apiFetch('/api/players/' + encodeURIComponent(steamId));
      if (r.ok) {
        const p = await r.json();
        if (p && p.steamId) _playerDetailCache.set(p.steamId, p);
        return showPlayerModal(p);
      }
    } catch (_e) {
      /* silent */
    }
    return false;
  }

  async function showPlayerDetails(steamId) {
    if (!steamId) return false;
    const player =
      S.players.find(function (p) {
        return p.steamId === steamId;
      }) || _playerDetailCache.get(steamId);

    if (player) return showPlayerModal(player);
    return fetchAndShowPlayer(steamId);
  }

  function reset() {
    _inited = false;
  }

  Panel.tabs.players = {
    init: init,
    load: loadPlayers,
    reset: reset,
    showPlayerModal: showPlayerModal,
    showPlayerPopup: showPlayerPopup,
    showPlayerDetails: showPlayerDetails,
    buildPlayerDetail: buildPlayerDetail,
    fetchAndShowPlayer: fetchAndShowPlayer,
    renderPlayers: renderPlayers,
  };
})();

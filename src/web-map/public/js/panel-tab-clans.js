/**
 * Panel Tab: Clans — clan membership, territories, and member details.
 * @namespace Panel.tabs.clans
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

  let _inited = false;

  function init() {
    if (_inited) return;
    _inited = true;
  }

  async function loadClans() {
    const container = $('#clan-list');
    if (!container) return;

    let allClans = [];
    function _clanRankLabel(rank) {
      const m = {
        Leader: 'leader',
        'Co-Leader': 'co_leader',
        Officer: 'officer',
        Member: 'member',
        Recruit: 'recruit',
      };
      return m[rank] ? i18next.t('web:clans.' + m[rank]) : rank;
    }

    try {
      const r = await apiFetch('/api/panel/clans');
      if (r.ok) {
        const d = await r.json();
        allClans = d.clans || [];
      }
    } catch (_e) {}

    if (allClans.length === 0) {
      if (!S.players.length) {
        try {
          const r2 = await apiFetch('/api/players');
          if (r2.ok) {
            const d2 = await r2.json();
            S.players = d2.players || [];
          }
        } catch (_e) {}
      }

      const clanMap = {};
      for (let i = 0; i < S.players.length; i++) {
        const p = S.players[i];
        const tag = p.clanName || null;
        if (!tag) continue;
        if (!clanMap[tag]) clanMap[tag] = { name: tag, members: [] };
        clanMap[tag].members.push({
          name: p.name,
          steam_id: p.steamId,
          rank: p.clanRank || '',
          is_online: p.isOnline || false,
          kills: p.kills || 0,
          deaths: p.deaths || 0,
          profession: p.profession || '',
          days_survived: p.daysSurvived || 0,
          playtime: p.playtime || 0,
        });
      }
      for (const key in clanMap) {
        if (clanMap.hasOwnProperty(key)) allClans.push(clanMap[key]);
      }
    }

    for (let ci = 0; ci < allClans.length; ci++) {
      const clan = allClans[ci];
      clan._onlineCount = 0;
      clan._totalKills = 0;
      clan._totalDeaths = 0;
      clan._totalPlaytime = 0;
      for (let mi = 0; mi < (clan.members || []).length; mi++) {
        const m = clan.members[mi];
        const player = S.players.find(function (p) {
          return p.steamId === m.steam_id;
        });
        if (player) {
          m.is_online = player.isOnline || false;
          m.kills = m.kills || player.kills || 0;
          m.deaths = m.deaths || player.deaths || 0;
          m.profession = m.profession || player.profession || '';
          m.days_survived = m.days_survived || player.daysSurvived || 0;
          m.playtime = m.playtime || player.playtime || 0;
        }
        if (m.is_online) clan._onlineCount++;
        clan._totalKills += m.kills || 0;
        clan._totalDeaths += m.deaths || 0;
        clan._totalPlaytime += m.playtime || 0;
      }
    }

    const searchVal = ($('#clan-search') ? $('#clan-search').value : '').toLowerCase();
    let filtered = allClans;
    if (searchVal) {
      filtered = allClans.filter(function (c) {
        if (c.name.toLowerCase().indexOf(searchVal) !== -1) return true;
        for (let mi = 0; mi < (c.members || []).length; mi++) {
          if ((c.members[mi].name || '').toLowerCase().indexOf(searchVal) !== -1) return true;
        }
        return false;
      });
    }

    const sortVal = $('#clan-sort') ? $('#clan-sort').value : 'members';
    filtered.sort(function (a, b) {
      if (sortVal === 'name') return (a.name || '').localeCompare(b.name || '');
      if (sortVal === 'online') return (b._onlineCount || 0) - (a._onlineCount || 0);
      if (sortVal === 'kills') return (b._totalKills || 0) - (a._totalKills || 0);
      return (b.members || []).length - (a.members || []).length;
    });

    let totalPlayers = 0;
    let totalOnline = 0;
    let largestName = '-';
    let largestSize = 0;
    for (let si = 0; si < allClans.length; si++) {
      const sc = allClans[si];
      const ml = (sc.members || []).length;
      totalPlayers += ml;
      totalOnline += sc._onlineCount || 0;
      if (ml > largestSize) {
        largestSize = ml;
        largestName = sc.name;
      }
    }
    const clsTotalEl = $('#clans-total');
    if (clsTotalEl) clsTotalEl.textContent = allClans.length;
    const clsPlayersEl = $('#clans-players');
    if (clsPlayersEl) clsPlayersEl.textContent = totalPlayers;
    const clsLargestEl = $('#clans-largest');
    if (clsLargestEl) clsLargestEl.textContent = largestSize > 0 ? '[' + largestName + '] (' + largestSize + ')' : '-';
    const clsOnlineEl = $('#clans-online');
    if (clsOnlineEl) clsOnlineEl.textContent = totalOnline;
    const clsCountEl = $('#clan-count');
    if (clsCountEl) clsCountEl.textContent = i18next.t('web:clans.clan_count', { count: filtered.length });

    if (filtered.length === 0) {
      container.innerHTML =
        '<div class="feed-empty col-span-full">' + i18next.t('web:empty_states.no_clans_found') + '</div>';
      return;
    }

    container.innerHTML = '';
    for (let ci2 = 0; ci2 < filtered.length; ci2++) {
      const clan2 = filtered[ci2];
      const members2 = clan2.members || [];
      const card = el('div', 'card clan-card');
      const online2 = clan2._onlineCount || 0;

      let html = '';

      html += '<div class="flex items-center justify-between mb-3">';
      html += '<div>';
      html += '<h3 class="text-base font-semibold text-white">[' + esc(clan2.name) + ']</h3>';
      html += '<span class="text-xs text-muted">' + i18next.t('web:clans.members', { count: members2.length });
      if (online2 > 0)
        html += ' · <span class="text-calm">' + online2 + ' ' + i18next.t('web:dashboard.online') + '</span>';
      html += '</span>';
      html += '</div>';

      html += '<div class="flex items-center gap-1.5">';
      if (online2 > 0) html += '<span class="w-2.5 h-2.5 rounded-full bg-calm animate-pulse"></span>';
      else html += '<span class="w-2.5 h-2.5 rounded-full bg-muted/30"></span>';
      html += '</div>';
      html += '</div>';

      html += '<div class="grid grid-cols-3 gap-2 mb-3">';
      html += '<div class="text-center bg-surface-300 rounded-lg py-1.5 px-1">';
      html += '<div class="text-[10px] text-muted uppercase">' + i18next.t('web:clans.kills') + '</div>';
      html += '<div class="text-sm font-semibold text-horde">' + (clan2._totalKills || 0) + '</div>';
      html += '</div>';
      html += '<div class="text-center bg-surface-300 rounded-lg py-1.5 px-1">';
      html += '<div class="text-[10px] text-muted uppercase">' + i18next.t('web:clans.deaths') + '</div>';
      html += '<div class="text-sm font-semibold text-surge">' + (clan2._totalDeaths || 0) + '</div>';
      html += '</div>';
      html += '<div class="text-center bg-surface-300 rounded-lg py-1.5 px-1">';
      html += '<div class="text-[10px] text-muted uppercase">' + i18next.t('web:clans.playtime') + '</div>';
      html +=
        '<div class="text-sm font-semibold text-accent">' + formatPlaytimeShort(clan2._totalPlaytime || 0) + '</div>';
      html += '</div>';
      html += '</div>';

      html += '<div class="space-y-1">';

      members2.sort(function (a, b) {
        if (a.is_online !== b.is_online) return a.is_online ? -1 : 1;
        return (b.kills || 0) - (a.kills || 0);
      });
      for (let mi2 = 0; mi2 < members2.length; mi2++) {
        const m2 = members2[mi2];
        const displayName = m2.name || m2.steam_id || 'Unknown';
        html +=
          '<div class="flex items-center gap-2 py-1 px-2 rounded hover:bg-surface-300/50 transition-colors group">';
        html += '<span class="status-dot ' + (m2.is_online ? 'online' : 'offline') + ' shrink-0"></span>';
        html +=
          '<span class="player-link text-sm truncate flex-1" data-steam-id="' +
          esc(m2.steam_id || '') +
          '">' +
          esc(displayName) +
          '</span>';
        if (m2.rank)
          html +=
            '<span class="text-[10px] font-medium text-accent bg-accent/10 px-1.5 py-0.5 rounded shrink-0">' +
            esc(_clanRankLabel(m2.rank)) +
            '</span>';
        if (m2.profession)
          html +=
            '<span class="text-[10px] text-muted hidden group-hover:inline shrink-0">' + esc(m2.profession) + '</span>';
        html +=
          '<span class="text-[11px] text-muted ml-auto shrink-0 tabular-nums">' +
          (m2.kills || 0) +
          'K/' +
          (m2.deaths || 0) +
          'D</span>';
        html += '</div>';
      }
      html += '</div>';

      card.innerHTML = html;
      container.appendChild(card);
    }
  }

  function formatPlaytimeShort(seconds) {
    if (!seconds || seconds <= 0) return '0h';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (h > 0) return h + 'h ' + m + 'm';
    return m + 'm';
  }

  function reset() {
    _inited = false;
  }

  Panel.tabs.clans = { init: init, load: loadClans, reset: reset };
})();

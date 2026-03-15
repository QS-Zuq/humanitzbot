/**
 * Panel Shared: Activity Feed — rendering, grouping, and format helpers.
 * Used by Dashboard + Activity tabs.
 * @namespace Panel.shared.activityFeed
 */
window.Panel = window.Panel || {};
Panel.shared = Panel.shared || {};

(function () {
  'use strict';

  const $ = Panel.core.$;
  const el = Panel.core.el;
  const esc = Panel.core.esc;

  // ── Utilities (also exposed on Panel.core.utils for other modules) ──

  /** Strip RCON color tags (<SP>, <FO>, <PN>, <PR>, <CL>, </>) from text */
  function stripRconTags(str) {
    if (!str) return '';
    return String(str)
      .replace(/<(?:PN|PR|SP|FO|CL|\/)>/g, '')
      .trim();
  }

  function fmtNum(n) {
    if (n == null) return '0';
    return window.fmtNumber ? window.fmtNumber(Number(n)) : Number(n).toLocaleString();
  }

  /**
   * Render a clickable entity link for any game-world object.
   * Clicking navigates to the DB tab filtered for that entity.
   * @param {string} name - Display name
   * @param {string} [type] - Entity type hint: 'item','player','vehicle','container','structure','building','animal','ai'
   * @param {object} [opts] - { steamId, table, search, cls }
   */
  function entityLink(name, type, opts) {
    if (!name) return '';
    opts = opts || {};
    const escaped = esc(name);
    // Players — use player-link with steam ID
    if (type === 'player') {
      return (
        '<span class="player-link entity-link cursor-pointer hover:underline text-accent" data-steam-id="' +
        esc(opts.steamId || '') +
        '">' +
        escaped +
        '</span>'
      );
    }
    // Everything else — use entity-link which navigates to DB tab
    let table = opts.table || '';
    let search = opts.search || name;
    if (!table) {
      // Infer table from type
      if (type === 'item') table = 'item_instances';
      else if (type === 'vehicle') table = 'vehicles';
      else if (type === 'container') table = 'containers';
      else if (type === 'structure' || type === 'building') table = 'structures';
      else if (type === 'animal') table = 'game_animals';
      else if (type === 'ai' || type === 'zombie') table = 'activity_log';
      else table = 'activity_log';
    }
    const cls = opts.cls || 'text-accent';
    return (
      '<span class="entity-link cursor-pointer hover:underline ' +
      cls +
      '" data-entity-table="' +
      esc(table) +
      '" data-entity-search="' +
      esc(search) +
      '">' +
      escaped +
      '</span>'
    );
  }

  function tryParseDetails(details, key) {
    if (!details) return '';
    if (typeof details === 'string') {
      try {
        details = JSON.parse(details);
      } catch (_e) {
        return details;
      }
    }
    return details[key] || '';
  }

  // Promote utilities to Panel.core.utils so extracted tabs can use them
  Panel.core.utils.stripRconTags = stripRconTags;
  Panel.core.utils.entityLink = entityLink;
  Panel.core.utils.fmtNum = fmtNum;
  Panel.core.utils.tryParseDetails = tryParseDetails;

  // ── Activity Feed Rendering ─────────────────────────────────────

  function groupActivityEvents(events) {
    if (!events || !events.length) return [];
    const grouped = [];
    let i = 0;
    while (i < events.length) {
      const e = events[i];
      const groupable =
        e.type === 'container_loot' ||
        e.type === 'player_build' ||
        e.type === 'container_item_added' ||
        e.type === 'container_item_removed' ||
        e.type === 'structure_placed' ||
        e.type === 'structure_destroyed' ||
        e.type === 'inventory_item_added' ||
        e.type === 'inventory_item_removed' ||
        e.type === 'container_destroyed';
      if (!groupable) {
        grouped.push({ events: [e], count: 1 });
        i++;
        continue;
      }
      const batch = [e];
      let j = i + 1;
      while (
        j < events.length &&
        events[j].type === e.type &&
        (events[j].actor || events[j].steam_id) === (e.actor || e.steam_id)
      ) {
        const tA = e.created_at ? new Date(e.created_at).getTime() : 0;
        const tB = events[j].created_at ? new Date(events[j].created_at).getTime() : 0;
        if (Math.abs(tA - tB) > 120000) break;
        batch.push(events[j]);
        j++;
      }
      grouped.push({ events: batch, count: batch.length });
      i = j;
    }
    return grouped;
  }

  function formatActivityEvent(e) {
    const actor = stripRconTags(e.actor_name || e.actor || e.steam_id || 'Unknown');
    const target = stripRconTags(e.target_name || e.target_steam_id || '');
    const actorHtml =
      '<span class="player-link" data-steam-id="' + esc(e.steam_id || e.actor || '') + '">' + esc(actor) + '</span>';
    const targetHtml = target
      ? '<span class="player-link" data-steam-id="' + esc(e.target_steam_id || '') + '">' + esc(target) + '</span>'
      : '';
    const itemName = stripRconTags(e.item || '');

    let _itype = 'item';
    if (
      e.type === 'player_build' ||
      e.type === 'structure_placed' ||
      e.type === 'structure_destroyed' ||
      e.type === 'structure_damaged' ||
      e.type === 'building_destroyed'
    )
      _itype = 'structure';
    else if (
      e.type === 'vehicle_change' ||
      e.type === 'vehicle_fuel_changed' ||
      e.type === 'vehicle_health_changed' ||
      e.type === 'vehicle_appeared' ||
      e.type === 'vehicle_destroyed'
    )
      _itype = 'vehicle';
    else if (
      e.type === 'container_loot' ||
      e.type === 'container_item_added' ||
      e.type === 'container_item_removed' ||
      e.type === 'container_destroyed'
    )
      _itype = 'item';
    else if (e.type === 'raid_damage') _itype = 'structure';
    const itemHtml = itemName ? entityLink(itemName, _itype) : '';

    const _a = function (k) {
      return i18next.t('web:activity.' + k);
    };
    const map = {
      player_connect: { icon: '\u2192', text: actorHtml + ' <strong>' + _a('connected') + '</strong>' },
      player_disconnect: { icon: '\u2190', text: actorHtml + ' <strong>' + _a('disconnected') + '</strong>' },
      player_death: {
        icon: '\u2715',
        text:
          actorHtml +
          ' <strong>' +
          _a('died') +
          '</strong>' +
          (e.details ? ' \u2014 ' + esc(tryParseDetails(e.details, 'cause') || '') : ''),
      },
      player_death_pvp: { icon: '\u2694', text: actorHtml + ' <strong>' + _a('killed') + '</strong> ' + targetHtml },
      player_build: {
        icon: '\u25AA',
        text:
          actorHtml + ' <strong>' + _a('built') + '</strong> ' + itemHtml + (e.amount > 1 ? ' \u00d7' + e.amount : ''),
      },
      container_loot: {
        icon: '\u25C7',
        text:
          actorHtml +
          ' <strong>' +
          _a('looted') +
          '</strong> ' +
          (itemHtml || _a('container')) +
          (e.amount > 1 ? ' \u00d7' + e.amount : ''),
      },
      damage_taken: {
        icon: '!',
        text:
          actorHtml +
          ' <strong>' +
          _a('took_damage') +
          '</strong>' +
          (itemName ? ' ' + _a('from') + ' ' + itemHtml : ''),
      },
      raid_damage: {
        icon: '\u26A0',
        text:
          actorHtml + ' <strong>' + _a('raided') + '</strong> ' + targetHtml + (itemName ? ' (' + itemHtml + ')' : ''),
      },
      building_destroyed: {
        icon: '\u2715',
        text:
          (itemHtml || entityLink(_a('structure'), 'structure')) +
          ' <strong>' +
          _a('destroyed') +
          '</strong>' +
          (target ? ' ' + _a('by') + ' ' + targetHtml : ''),
      },
      admin_access: {
        icon: '\u2605',
        text: actorHtml + ' <strong>' + _a('admin_action') + '</strong>' + (itemName ? ': ' + itemHtml : ''),
      },
      anticheat_flag: {
        icon: '\u2691',
        text: actorHtml + ' <strong>' + _a('flagged') + '</strong>' + (itemName ? ' \u2014 ' + itemHtml : ''),
      },
      container_item_added: {
        icon: '+',
        text:
          (itemHtml || esc(itemName)) +
          ' <strong>' +
          _a('added') +
          '</strong> ' +
          _a('to_container') +
          (actor !== 'Unknown' ? ' (' + actorHtml + ')' : ''),
      },
      container_item_removed: {
        icon: '\u2212',
        text:
          (itemHtml || esc(itemName)) +
          ' <strong>' +
          _a('removed') +
          '</strong> ' +
          _a('from_container') +
          (actor !== 'Unknown' ? ' (' + actorHtml + ')' : ''),
      },
      container_destroyed: {
        icon: '\u2715',
        text:
          (itemHtml || entityLink(_a('container'), 'item')) +
          ' <strong>' +
          _a('destroyed') +
          '</strong>' +
          (e.amount > 1 ? ' \u00d7' + e.amount : ''),
      },
      structure_destroyed: {
        icon: '\u2715',
        text:
          (itemHtml || entityLink(_a('structure'), 'structure')) +
          ' <strong>' +
          _a('destroyed') +
          '</strong>' +
          (e.amount > 1 ? ' \u00d7' + e.amount : ''),
      },
      structure_damaged: {
        icon: '\u26A0',
        text:
          (itemHtml || entityLink(_a('structure'), 'structure')) +
          ' <strong>' +
          _a('damaged') +
          '</strong>' +
          (target ? ' ' + _a('by') + ' ' + targetHtml : ''),
      },
      structure_placed: {
        icon: '\u25AA',
        text:
          (itemHtml || entityLink(_a('structure'), 'structure')) +
          ' <strong>' +
          _a('placed') +
          '</strong>' +
          (e.amount > 1 ? ' \u00d7' + e.amount : ''),
      },
      inventory_item_added: {
        icon: '+',
        text:
          actorHtml +
          ' <strong>' +
          _a('picked_up') +
          '</strong> ' +
          (itemHtml || _a('item')) +
          (e.amount > 1 ? ' \u00d7' + e.amount : ''),
      },
      inventory_item_removed: {
        icon: '\u2212',
        text:
          actorHtml +
          ' <strong>' +
          _a('dropped') +
          '</strong> ' +
          (itemHtml || _a('item')) +
          (e.amount > 1 ? ' \u00d7' + e.amount : ''),
      },
      vehicle_fuel_changed: {
        icon: '\u26FD',
        text:
          entityLink(_a('vehicle') + (itemName ? ' ' + itemName : ''), 'vehicle') +
          ' <strong>' +
          _a('fuel_changed') +
          '</strong>' +
          (e.amount ? ' (' + e.amount + ')' : ''),
      },
      vehicle_health_changed: {
        icon: '\u2695',
        text:
          entityLink(_a('vehicle') + (itemName ? ' ' + itemName : ''), 'vehicle') +
          ' <strong>' +
          _a('health_changed') +
          '</strong>' +
          (e.amount ? ' (' + e.amount + ')' : ''),
      },
      vehicle_appeared: {
        icon: '\u25CE',
        text:
          entityLink(_a('vehicle') + (itemName ? ' ' + itemName : ''), 'vehicle') +
          ' <strong>' +
          _a('appeared') +
          '</strong>',
      },
      vehicle_destroyed: {
        icon: '\u2715',
        text:
          entityLink(_a('vehicle') + (itemName ? ' ' + itemName : ''), 'vehicle') +
          ' <strong>' +
          _a('destroyed') +
          '</strong>',
      },
      vehicle_change: {
        icon: '\u25CE',
        text:
          entityLink(_a('vehicle') + (itemName ? ' ' + itemName : ''), 'vehicle') +
          ' <strong>' +
          _a('state_changed') +
          '</strong>',
      },
      horse_appeared: {
        icon: '\u25CE',
        text: _a('horse') + ' <strong>' + _a('appeared') + '</strong>' + (itemName ? ' (' + itemHtml + ')' : ''),
      },
      horse_disappeared: {
        icon: '\u2715',
        text: _a('horse') + ' <strong>' + _a('disappeared') + '</strong>' + (itemName ? ' (' + itemHtml + ')' : ''),
      },
      horse_change: {
        icon: '\u25CE',
        text: _a('horse') + ' <strong>' + _a('status_changed') + '</strong>' + (itemName ? ': ' + itemHtml : ''),
      },
      world_change: { icon: '\u25CE', text: _a('world') + ' <strong>' + esc(itemName || _a('updated')) + '</strong>' },
    };

    return (
      map[e.type] || {
        icon: '\u00b7',
        text: actorHtml + ' \u2014 ' + esc(e.type || 'event') + (itemName ? ' (' + itemHtml + ')' : ''),
      }
    );
  }

  function renderActivityFeed(container, events, compact, append) {
    if (!container) return;
    if (!append) container.innerHTML = '';
    if (!events || !events.length) {
      if (!append)
        container.innerHTML = '<div class="feed-empty">' + i18next.t('web:empty_states.no_events') + '</div>';
      return;
    }
    const limit = compact ? 15 : events.length;
    const sliced = events.slice(0, limit);
    const groups = groupActivityEvents(sliced);
    for (let g = 0; g < groups.length; g++) {
      const group = groups[g];
      const e = group.events[0];
      if (group.count === 1) {
        const item = el('div', 'feed-item fade-in');
        const time = e.created_at
          ? window.fmtTime
            ? window.fmtTime(new Date(e.created_at))
            : new Date(e.created_at).toLocaleTimeString()
          : '';
        const fmt = formatActivityEvent(e);
        item.innerHTML =
          '<span class="feed-time">' +
          time +
          '</span><span class="feed-ico">' +
          fmt.icon +
          '</span><span class="feed-txt">' +
          fmt.text +
          '</span>';
        container.appendChild(item);
      } else {
        const items = {};
        for (let k = 0; k < group.events.length; k++) {
          const ev = group.events[k];
          const name = stripRconTags(ev.item || ev.type);
          items[name] = (items[name] || 0) + (ev.amount || 1);
        }
        const summary = Object.keys(items)
          .map(function (n) {
            const t = /built|placed|destroyed/.test(e.type) ? 'structure' : 'item';
            return entityLink(n, t) + (items[n] > 1 ? ' \u00d7' + items[n] : '');
          })
          .join(', ');
        const fmt0 = formatActivityEvent(e);
        const actor = stripRconTags(e.actor_name || e.actor || e.steam_id || 'Unknown');
        const actorHtml =
          '<span class="player-link" data-steam-id="' +
          esc(e.steam_id || e.actor || '') +
          '">' +
          esc(actor) +
          '</span>';
        const time0 = e.created_at
          ? window.fmtTime
            ? window.fmtTime(new Date(e.created_at))
            : new Date(e.created_at).toLocaleTimeString()
          : '';
        const actionWord =
          {
            container_loot: i18next.t('web:activity.looted'),
            player_build: i18next.t('web:activity.built'),
            container_item_added: i18next.t('web:activity.added'),
            container_item_removed: i18next.t('web:activity.removed'),
            structure_placed: i18next.t('web:activity.placed'),
            structure_destroyed: i18next.t('web:activity.destroyed'),
            inventory_item_added: i18next.t('web:activity.picked_up'),
            inventory_item_removed: i18next.t('web:activity.dropped'),
            container_destroyed: i18next.t('web:activity.destroyed'),
          }[e.type] || i18next.t('web:activity.did');
        const groupEl = el('div', 'feed-item feed-group fade-in');
        groupEl.innerHTML =
          '<span class="feed-time">' +
          time0 +
          '</span><span class="feed-ico">' +
          fmt0.icon +
          '</span><span class="feed-txt">' +
          actorHtml +
          ' <strong>' +
          actionWord +
          '</strong> ' +
          group.count +
          ' items: ' +
          summary +
          '</span>';
        groupEl.title = i18next.t('web:activity.click_to_expand', { count: group.count });
        groupEl.style.cursor = 'pointer';
        (function (groupEl2, groupEvents) {
          let expanded = false;
          groupEl2.addEventListener('click', function () {
            if (expanded) {
              let next = groupEl2.nextSibling;
              while (next && next.classList && next.classList.contains('feed-group-detail')) {
                const rm = next;
                next = next.nextSibling;
                rm.remove();
              }
              expanded = false;
              groupEl2.classList.remove('feed-group-open');
            } else {
              const frag = document.createDocumentFragment();
              for (let d = 0; d < groupEvents.length; d++) {
                const de = groupEvents[d];
                const di = el('div', 'feed-item feed-group-detail fade-in');
                const dt = de.created_at
                  ? window.fmtTime
                    ? window.fmtTime(new Date(de.created_at))
                    : new Date(de.created_at).toLocaleTimeString()
                  : '';
                const df = formatActivityEvent(de);
                di.innerHTML =
                  '<span class="feed-time">' +
                  dt +
                  '</span><span class="feed-ico">' +
                  df.icon +
                  '</span><span class="feed-txt">' +
                  df.text +
                  '</span>';
                frag.appendChild(di);
              }
              groupEl2.parentNode.insertBefore(frag, groupEl2.nextSibling);
              expanded = true;
              groupEl2.classList.add('feed-group-open');
            }
          });
        })(groupEl, group.events);
        container.appendChild(groupEl);
      }
    }
  }

  // ── Paging state (shared so nav can reset) ──────────────────────

  const ACTIVITY_PAGE_SIZE = 100;
  let activityOffset = 0;
  let activityHasMore = false;

  function resetActivityPaging() {
    activityOffset = 0;
    activityHasMore = false;
    const container = $('#activity-feed');
    if (container) container.innerHTML = '';
    const btn = $('#activity-load-more');
    if (btn) btn.classList.add('hidden');
  }

  function loadMore() {
    if (window.__loadMoreActivity) window.__loadMoreActivity();
  }

  // Wire up the "Load More" button (no inline onclick needed)
  const _lmBtn = $('#activity-load-more-btn');
  if (_lmBtn)
    _lmBtn.addEventListener('click', function () {
      loadMore();
    });

  Panel.shared.activityFeed = {
    render: renderActivityFeed,
    group: groupActivityEvents,
    format: formatActivityEvent,
    loadMore: loadMore,
    resetPaging: resetActivityPaging,
    // Expose paging state getters/setters for the activity tab
    getPageSize: function () {
      return ACTIVITY_PAGE_SIZE;
    },
    getOffset: function () {
      return activityOffset;
    },
    setOffset: function (v) {
      activityOffset = v;
    },
    getHasMore: function () {
      return activityHasMore;
    },
    setHasMore: function (v) {
      activityHasMore = v;
    },
  };
})();

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
  const S = Panel.core.S;

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
    const activityAttrs = opts.activityMode
      ? ' data-mode="' +
        esc(opts.activityMode) +
        '" data-search="' +
        esc(opts.activitySearch || opts.search || name) +
        '"'
      : '';
    // Players — use player-link with steam ID
    if (type === 'player') {
      return (
        '<span class="player-link entity-link cursor-pointer hover:underline text-accent" data-steam-id="' +
        esc(opts.steamId || '') +
        activityAttrs +
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
      else if (type === 'profession') table = 'game_professions';
      else if (type === 'affliction') table = 'game_afflictions';
      else if (type === 'skill') table = 'game_skills';
      else if (type === 'recipe') table = 'game_recipes';
      else if (type === 'ai' || type === 'zombie') table = 'activity_log';
      else table = 'activity_log';
    }
    const cls = opts.cls || 'text-accent';
    return (
      '<span class="' +
      (opts.activityMode ? 'activity-link ' : '') +
      'entity-link cursor-pointer hover:underline ' +
      cls +
      '" data-entity-table="' +
      esc(table) +
      '" data-entity-search="' +
      esc(search) +
      '"' +
      activityAttrs +
      '>' +
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

  function parseDetails(details) {
    if (!details) return {};
    if (typeof details === 'string') {
      try {
        return JSON.parse(details);
      } catch (_e) {
        return {};
      }
    }
    return details;
  }

  function parseActivityTimestamp(value) {
    if (!value) return null;
    if (value instanceof Date) return value;
    const raw = String(value).trim();
    if (!raw) return null;
    const sqliteUtc = raw.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.\d+)?$/);
    const parsed = new Date(sqliteUtc ? sqliteUtc[1] + 'T' + sqliteUtc[2] + 'Z' : raw);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  function formatActivityTime(value) {
    const date = parseActivityTimestamp(value);
    if (!date) return '';
    const timezone = S.activityTimeZone || (S.activitySelectedRange && S.activitySelectedRange.timezone) || '';
    if (window.fmtTime) return window.fmtTime(date, timezone || undefined);
    return date.toLocaleTimeString();
  }

  function attributionBadge(details) {
    const attribution = parseDetails(details).attribution || {};
    const status = attribution.status || '';
    const title = attribution.reason || i18next.t('web:activity.attribution_unknown_title');
    if (status === 'ambiguous') {
      return (
        ' <span class="activity-attribution-badge text-amber-400" title="' +
        esc(title) +
        '">' +
        i18next.t('web:activity.unattributed_ambiguous') +
        '</span>'
      );
    }
    if (status === 'no_inventory_delta') {
      return (
        ' <span class="activity-attribution-badge text-muted" title="' +
        esc(title) +
        '">' +
        i18next.t('web:activity.unattributed_no_inventory_delta') +
        '</span>'
      );
    }
    if (status === 'unmatched') {
      return (
        ' <span class="activity-attribution-badge text-muted" title="' +
        esc(title) +
        '">' +
        i18next.t('web:activity.unattributed_unmatched') +
        '</span>'
      );
    }
    return '';
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
        const parsedA = parseActivityTimestamp(e.created_at);
        const parsedB = parseActivityTimestamp(events[j].created_at);
        const tA = parsedA ? parsedA.getTime() : 0;
        const tB = parsedB ? parsedB.getTime() : 0;
        if (Math.abs(tA - tB) > 120000) break;
        batch.push(events[j]);
        j++;
      }
      grouped.push({ events: batch, count: batch.length });
      i = j;
    }
    return grouped;
  }

  function actorEntityType(eventType) {
    if (String(eventType || '').startsWith('container_')) return 'container';
    if (String(eventType || '').startsWith('structure_')) return 'structure';
    if (String(eventType || '').startsWith('vehicle_')) return 'vehicle';
    if (String(eventType || '').startsWith('horse_')) return 'animal';
    return '';
  }

  function activityCoord(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function formatActivityEvent(e) {
    const rawActor = e.actor || '';
    const actorIsSteamId = /^\d{17}$/.test(String(rawActor));
    const actor = stripRconTags(e.actor_name || rawActor || e.steam_id || 'Unknown');
    const target = stripRconTags(e.target_name || e.target_steam_id || '');
    const actorSteamId = actorIsSteamId ? rawActor : e.steam_id || '';
    const actorType = actorEntityType(e.type);
    const actorHtml =
      actorIsSteamId || (!actorType && actorSteamId)
        ? entityLink(actor, 'player', { steamId: actorSteamId })
        : actorType
          ? entityLink(actor, actorType, actorType === 'container' ? { activityMode: 'container' } : {})
          : esc(actor);
    const targetHtml = target
      ? '<span class="player-link" data-steam-id="' + esc(e.target_steam_id || '') + '">' + esc(target) + '</span>'
      : '';
    const itemName = stripRconTags(e.item || '');
    const attributedName = stripRconTags(e.attributed_name || tryParseDetails(e.details, 'attributedPlayer') || '');
    const attributedSteamId = e.steam_id || tryParseDetails(e.details, 'attributedSteamId') || '';
    const attributedHtml = attributedName ? entityLink(attributedName, 'player', { steamId: attributedSteamId }) : '';

    let _itype = 'item';
    if (
      e.type === 'player_build' ||
      e.type === 'structure_placed' ||
      e.type === 'structure_destroyed' ||
      e.type === 'structure_damaged' ||
      e.type === 'structure_upgraded' ||
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
    const itemHtml = itemName ? entityLink(itemName, _itype, _itype === 'item' ? { activityMode: 'item' } : {}) : '';

    const _a = function (k) {
      return i18next.t('web:activity.' + k);
    };
    const attributionSuffix = attributedHtml ? ' ' + _a('by') + ' ' + attributedHtml : '';
    const attributionStateSuffix = attributedHtml ? '' : attributionBadge(e.details);
    const ownerSteamId =
      String(
        tryParseDetails(e.details, 'owner') ||
          tryParseDetails(e.details, 'newOwner') ||
          tryParseDetails(e.details, 'ownerSteamId') ||
          '',
      ) ||
      ((actorType === 'structure' || actorType === 'animal') && attributedSteamId ? String(attributedSteamId) : '');
    const ownerName =
      actorType === 'structure' || actorType === 'animal' ? stripRconTags(e.owner_name || attributedName || '') : '';
    const ownerHtml =
      ownerName || ownerSteamId ? entityLink(ownerName || ownerSteamId, 'player', { steamId: ownerSteamId }) : '';
    const ownerSuffix = ownerHtml
      ? ' <span class="text-[10px] text-muted">\u00b7 ' + _a('owner') + ' ' + ownerHtml + '</span>'
      : '';
    const coordX = activityCoord(e.pos_x ?? e.x);
    const coordY = activityCoord(e.pos_y ?? e.y);
    const coordSuffix =
      coordX != null && coordY != null && !(coordX === 0 && coordY === 0)
        ? ' <span class="text-[10px] text-muted">\u00b7 ' +
          _a('location') +
          ' ' +
          esc(Math.round(coordX) + ', ' + Math.round(coordY)) +
          '</span>'
        : '';
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
          (actor !== 'Unknown' ? ' (' + actorHtml + ')' : '') +
          attributionSuffix +
          attributionStateSuffix,
      },
      container_item_removed: {
        icon: '\u2212',
        text:
          (itemHtml || esc(itemName)) +
          ' <strong>' +
          _a('removed') +
          '</strong> ' +
          _a('from_container') +
          (actor !== 'Unknown' ? ' (' + actorHtml + ')' : '') +
          attributionSuffix +
          attributionStateSuffix,
      },
      container_destroyed: {
        icon: '\u2715',
        text:
          (itemHtml || entityLink(_a('container'), 'container')) +
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
      structure_upgraded: {
        icon: '\u25B3',
        text:
          (itemHtml || entityLink(_a('structure'), 'structure')) +
          ' <strong>' +
          _a('upgraded') +
          '</strong>' +
          (e.amount > 1 ? ' \u00d7' + e.amount : ''),
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

    const formatted = map[e.type] || {
      icon: '\u00b7',
      text: actorHtml + ' \u2014 ' + esc(e.type || 'event') + (itemName ? ' (' + itemHtml + ')' : ''),
    };
    return { icon: formatted.icon, text: formatted.text + ownerSuffix + coordSuffix };
  }

  function fallbackActivityEvent(e, err) {
    const event = e || {};
    const actor = stripRconTags(event.actor_name || event.actor || event.steam_id || 'Unknown') || 'Unknown';
    const type = event.type || 'event';
    const detail = err && err.message ? err.message : err ? String(err) : '';
    return {
      icon: '\u00b7',
      text:
        esc(actor) +
        ' \u2014 ' +
        esc(type) +
        (event.item ? ' (' + esc(stripRconTags(event.item)) + ')' : '') +
        (detail
          ? ' <span class="activity-attribution-badge text-amber-400" title="' +
            esc(detail) +
            '">' +
            safeActivityLabel('render_partial', 'partial') +
            '</span>'
          : ''),
    };
  }

  function safeActivityLabel(key, fallback) {
    try {
      return i18next.t('web:activity.' + key) || fallback;
    } catch (_err) {
      return fallback;
    }
  }

  function safeFormatActivityEvent(e) {
    try {
      return formatActivityEvent(e || {});
    } catch (err) {
      console.error('[Activity] failed to format activity event:', err, e);
      return fallbackActivityEvent(e, err);
    }
  }

  function appendActivityFallbackRow(container, e, err) {
    const item = el('div', 'feed-item fade-in');
    const time = formatActivityTime(e && e.created_at);
    const fmt = fallbackActivityEvent(e, err);
    item.innerHTML =
      '<span class="feed-time">' +
      time +
      '</span><span class="feed-ico">' +
      fmt.icon +
      '</span><span class="feed-txt">' +
      fmt.text +
      '</span>';
    container.appendChild(item);
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
      try {
        if (group.count === 1) {
          const item = el('div', 'feed-item fade-in');
          const time = formatActivityTime(e.created_at);
          const fmt = safeFormatActivityEvent(e);
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
              return (
                entityLink(n, t, t === 'item' ? { activityMode: 'item' } : {}) +
                (items[n] > 1 ? ' \u00d7' + items[n] : '')
              );
            })
            .join(', ');
          const fmt0 = safeFormatActivityEvent(e);
          const actor = stripRconTags(e.actor_name || e.actor || e.steam_id || 'Unknown');
          const groupActorType = actorEntityType(e.type);
          const groupActorSteamId = /^\d{17}$/.test(String(e.actor || '')) ? e.actor : e.steam_id || '';
          const actorHtml =
            groupActorType === 'container'
              ? entityLink(actor, 'container', { activityMode: 'container' })
              : entityLink(actor, 'player', { steamId: groupActorSteamId });
          const time0 = formatActivityTime(e.created_at);
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
                  const dt = formatActivityTime(de.created_at);
                  const df = safeFormatActivityEvent(de);
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
      } catch (err) {
        console.error('[Activity] failed to render activity row:', err, e);
        appendActivityFallbackRow(container, e, err);
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

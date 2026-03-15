/**
 * Panel Nav — Navigation router, breadcrumbs, and centralized click delegation.
 *
 * @namespace Panel.nav
 */
window.Panel = window.Panel || {};

(function () {
  'use strict';

  var S = Panel.core.S;
  var $ = Panel.core.$;
  var $$ = Panel.core.$$;
  var esc = Panel.core.esc;

  // ── Tab Labels ────────────────────────────────────

  function getTabLabels() {
    return {
      dashboard: i18next.t('web:tabs.dashboard'),
      map: i18next.t('web:tabs.map'),
      timeline: i18next.t('web:tabs.timeline'),
      players: i18next.t('web:tabs.players'),
      clans: i18next.t('web:tabs.clans'),
      activity: i18next.t('web:tabs.activity'),
      chat: i18next.t('web:tabs.chat'),
      items: i18next.t('web:tabs.items'),
      console: i18next.t('web:tabs.console'),
      settings: i18next.t('web:tabs.settings'),
      controls: i18next.t('web:tabs.controls'),
      database: i18next.t('web:tabs.database'),
      anticheat: i18next.t('web:tabs.anticheat'),
    };
  }

  // ── Breadcrumbs ───────────────────────────────────

  S.breadcrumbs = [];

  function setBreadcrumbs(crumbs) {
    S.breadcrumbs = crumbs;
    var bars = $$('.breadcrumb-bar');
    bars.forEach(function (bar) {
      if (!crumbs || crumbs.length <= 1) {
        bar.innerHTML = '';
        return;
      }
      var html = '';
      for (var i = 0; i < crumbs.length; i++) {
        if (i > 0) html += '<span class="breadcrumb-sep"></span>';
        var isLast = i === crumbs.length - 1;
        if (isLast) {
          html += '<span class="breadcrumb-item current">' + esc(crumbs[i].label) + '</span>';
        } else {
          html +=
            '<span class="breadcrumb-item" data-action="' +
            esc(crumbs[i].action || '') +
            '">' +
            esc(crumbs[i].label) +
            '</span>';
        }
      }
      bar.innerHTML = html;
    });
  }

  // ── Breadcrumb Click Delegation ───────────────────

  document.addEventListener('click', function (e) {
    var bc = e.target.closest('.breadcrumb-item:not(.current)');
    if (!bc) return;
    var action = bc.dataset.action;
    if (action === 'tab') {
      setBreadcrumbs([{ label: getTabLabels()[S.currentTab] || S.currentTab }]);

      var pm = $('#player-modal');
      if (pm) pm.classList.add('hidden');
      var idm = $('#item-detail-modal');
      if (idm) idm.classList.add('hidden');
    } else if (action && action.startsWith('switchTab:')) {
      switchTab(action.split(':')[1]);
    }
  });

  // ── Switch Tab ────────────────────────────────────

  function switchTab(tab) {
    S.currentTab = tab;
    setBreadcrumbs([{ label: getTabLabels()[tab] || tab }]);
    $$('.tab-content').forEach(function (s) {
      s.classList.add('hidden');
    });
    var tabEl = $('#tab-' + tab);
    if (tabEl) {
      tabEl.classList.remove('hidden');

      if (typeof gsap !== 'undefined') {
        gsap.fromTo(tabEl, { opacity: 0 }, { opacity: 1, duration: 0.15, ease: 'power2.out' });
      }
    }
    $$('.nav-link').forEach(function (l) {
      l.classList.toggle('active', l.dataset.tab === tab);
    });

    // Clear polling timers
    S.pollTimers.forEach(clearInterval);
    S.pollTimers = [];

    // Call tab handler via namespace contract
    var handler = Panel.tabs && Panel.tabs[tab];
    if (handler) {
      try {
        if (handler.init) handler.init();
        if (handler.load) handler.load();
      } catch (err) {
        console.error('[Panel] Tab "' + tab + '" failed to load:', err);
      }
    }

    // Set up polling where needed
    switch (tab) {
      case 'dashboard':
        S.pollTimers.push(
          setInterval(function () {
            if (Panel.tabs.dashboard) Panel.tabs.dashboard.load();
          }, 30000),
        );
        break;
      case 'map':
        S.pollTimers.push(
          setInterval(function () {
            if (Panel.tabs.map) Panel.tabs.map.load();
          }, 15000),
        );
        break;
      case 'chat':
        S.pollTimers.push(
          setInterval(function () {
            if (Panel.tabs.chat) Panel.tabs.chat.load();
          }, 8000),
        );
        break;
    }
  }

  // ══════════════════════════════════════════════════
  //  CLICK-TO-PROFILE DELEGATION
  // ══════════════════════════════════════════════════

  // ── data-nav click delegation (e.g. "view in Items tab") ──

  document.addEventListener('click', function (e) {
    var navTarget = e.target.closest('[data-nav]');
    if (!navTarget) return;
    var requiredTier = parseInt(navTarget.dataset.requireTier, 10) || 0;
    if (S.tier >= requiredTier) {
      switchTab(navTarget.dataset.nav);
    }
  });

  document.addEventListener('click', function (e) {
    // Player link click → open player modal
    var link = e.target.closest('.player-link');
    if (link) {
      e.preventDefault();
      var steamId = link.dataset.steamId;
      var name = link.textContent;
      var player = S.players.find(function (p) {
        return (
          (steamId && p.steamId === steamId) ||
          (name && p.name === name) ||
          (name && p.name && p.name.toLowerCase() === name.toLowerCase())
        );
      });
      if (player && Panel._internal.showPlayerModal) Panel._internal.showPlayerModal(player);
      else if (steamId && Panel._internal.fetchAndShowPlayer) Panel._internal.fetchAndShowPlayer(steamId);
      else if (Panel._internal.showToast) {
        Panel._internal.showToast(i18next.t('web:toast.player_not_found', { name: name || 'Unknown' }), 2500);
      }
      return;
    }

    // Inventory item click → show item popup
    var slot = e.target.closest('.inv-clickable');
    if (slot) {
      e.preventDefault();
      if (Panel._internal.showItemPopup) Panel._internal.showItemPopup(slot);
      return;
    }

    // Activity cross-reference click → navigate to activity tab with filter
    var actLink = e.target.closest('.activity-link');
    if (actLink) {
      e.preventDefault();
      var actSearch = actLink.dataset.search || '';
      var actType = actLink.dataset.type || '';
      var as = $('#activity-search');
      if (as) as.value = actSearch;
      var af = $('#activity-filter');
      if (af && actType) af.value = actType;
      // Close any open popup/modal before navigating
      var openPopup = document.querySelector('.item-popup');
      if (openPopup) openPopup.remove();
      var openModal = $('#player-modal');
      if (openModal && !openModal.classList.contains('hidden')) openModal.classList.add('hidden');
      switchTab('activity');
      // Force reload with the pre-populated filters
      setTimeout(function () {
        if (Panel._internal.resetActivityPaging) Panel._internal.resetActivityPaging();
        if (Panel.tabs.activity) Panel.tabs.activity.load();
      }, 100);
      return;
    }

    // Close item popup via close button
    var popupClose = e.target.closest('.item-popup-close');
    if (popupClose) {
      var popup = popupClose.closest('.item-popup');
      if (popup) popup.remove();
      return;
    }

    // DB cross-reference click → navigate to related data
    var dbLink = e.target.closest('.db-link');
    if (dbLink) {
      e.preventDefault();
      var table = dbLink.dataset.table;
      var search = dbLink.dataset.search;
      if (table) {
        var sel = $('#db-table');
        if (sel) {
          sel.value = table;
        }
        var srch = $('#db-search');
        if (srch) {
          srch.value = search || '';
        }
        // Close any open popup/modal before navigating
        var openPopup2 = document.querySelector('.item-popup');
        if (openPopup2) openPopup2.remove();
        var openModal2 = $('#player-modal');
        if (openModal2 && !openModal2.classList.contains('hidden')) openModal2.classList.add('hidden');
        switchTab('database');
        setTimeout(function () {
          if (Panel.tabs.database) Panel.tabs.database.load();
        }, 100);
      }
      return;
    }

    // Entity link click → show entity info popup (or navigate for clans)
    var entLink = e.target.closest('.entity-link:not(.player-link)');
    if (entLink) {
      e.preventDefault();
      e.stopPropagation();
      var eTable = entLink.dataset.entityTable;
      var eSearch = entLink.dataset.entitySearch;
      if (eTable === 'clans' && eSearch) {
        var openPopup3 = document.querySelector('.item-popup');
        if (openPopup3) openPopup3.remove();
        var openModal3 = $('#player-modal');
        if (openModal3 && !openModal3.classList.contains('hidden')) openModal3.classList.add('hidden');
        switchTab('clans');
        setTimeout(function () {
          var cs = $('#clan-search');
          if (cs) {
            cs.value = eSearch;
            cs.dispatchEvent(new Event('input'));
          }
        }, 100);
      } else if (eSearch && Panel._internal.showEntityPopup) {
        Panel._internal.showEntityPopup(entLink, eSearch, eTable);
      }
      return;
    }

    // Item popup close button
    var popupClose2 = e.target.closest('.item-popup-close');
    if (popupClose2) {
      var parentPopup = popupClose2.closest('.item-popup');
      if (parentPopup) parentPopup.remove();
      return;
    }

    // Close item popup on outside click
    var existingPopup = document.querySelector('.item-popup');
    if (existingPopup && !e.target.closest('.item-popup') && !e.target.closest('.inv-clickable')) {
      existingPopup.remove();
    }
  });

  // ── Expose API ────────────────────────────────────

  Panel.nav = {
    switchTab: switchTab,
    setBreadcrumbs: setBreadcrumbs,
    getTabLabels: getTabLabels,
  };

  // Make switchTab globally accessible for any remaining inline references
  window.switchTab = switchTab;
})();

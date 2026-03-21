/**
 * Panel Nav — Navigation router, breadcrumbs, and centralized click delegation.
 *
 * @namespace Panel.nav
 */
window.Panel = window.Panel || {};

(function () {
  'use strict';

  const S = Panel.core.S;
  const $ = Panel.core.$;
  const $$ = Panel.core.$$;
  const esc = Panel.core.esc;

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
      servers: i18next.t('web:servers.tab'),
    };
  }

  // ── Breadcrumbs ───────────────────────────────────

  S.breadcrumbs = [];

  function setBreadcrumbs(crumbs) {
    S.breadcrumbs = crumbs;
    const bars = $$('.breadcrumb-bar');
    bars.forEach(function (bar) {
      if (!crumbs || crumbs.length <= 1) {
        bar.innerHTML = '';
        return;
      }
      let html = '';
      for (let i = 0; i < crumbs.length; i++) {
        if (i > 0) html += '<span class="breadcrumb-sep"></span>';
        const isLast = i === crumbs.length - 1;
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
    const bc = e.target.closest('.breadcrumb-item:not(.current)');
    if (!bc) return;
    const action = bc.dataset.action;
    if (action === 'tab') {
      setBreadcrumbs([{ label: getTabLabels()[S.currentTab] || S.currentTab }]);

      const pm = $('#player-modal');
      if (pm) pm.classList.add('hidden');
      const idm = $('#item-detail-modal');
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
    const tabEl = $('#tab-' + tab);
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
    const handler = Panel.tabs && Panel.tabs[tab];
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
    const navTarget = e.target.closest('[data-nav]');
    if (!navTarget) return;
    const requiredTier = parseInt(navTarget.dataset.requireTier, 10) || 0;
    if (S.tier >= requiredTier) {
      switchTab(navTarget.dataset.nav);
    }
  });

  document.addEventListener('click', function (e) {
    // Player link click → open player modal
    const link = e.target.closest('.player-link');
    if (link) {
      e.preventDefault();
      const steamId = link.dataset.steamId;
      const name = link.textContent;
      const player = S.players.find(function (p) {
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
    const slot = e.target.closest('.inv-clickable');
    if (slot) {
      e.preventDefault();
      if (Panel._internal.showItemPopup) Panel._internal.showItemPopup(slot);
      return;
    }

    // Activity cross-reference click → navigate to activity tab with filter
    const actLink = e.target.closest('.activity-link');
    if (actLink) {
      e.preventDefault();
      const actSearch = actLink.dataset.search || '';
      const actType = actLink.dataset.type || '';
      const as = $('#activity-search');
      if (as) as.value = actSearch;
      const af = $('#activity-filter');
      if (af && actType) af.value = actType;
      // Close any open popup/modal before navigating
      const openPopup = document.querySelector('.item-popup');
      if (openPopup) openPopup.remove();
      const openModal = $('#player-modal');
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
    const popupClose = e.target.closest('.item-popup-close');
    if (popupClose) {
      const popup = popupClose.closest('.item-popup');
      if (popup) popup.remove();
      return;
    }

    // DB cross-reference click → navigate to related data
    const dbLink = e.target.closest('.db-link');
    if (dbLink) {
      e.preventDefault();
      const table = dbLink.dataset.table;
      const search = dbLink.dataset.search;
      if (table) {
        const sel = $('#db-table');
        if (sel) {
          sel.value = table;
        }
        const srch = $('#db-search');
        if (srch) {
          srch.value = search || '';
        }
        // Close any open popup/modal before navigating
        const openPopup2 = document.querySelector('.item-popup');
        if (openPopup2) openPopup2.remove();
        const openModal2 = $('#player-modal');
        if (openModal2 && !openModal2.classList.contains('hidden')) openModal2.classList.add('hidden');
        switchTab('database');
        setTimeout(function () {
          if (Panel.tabs.database) Panel.tabs.database.load();
        }, 100);
      }
      return;
    }

    // Entity link click → show entity info popup (or navigate for clans)
    const entLink = e.target.closest('.entity-link:not(.player-link)');
    if (entLink) {
      e.preventDefault();
      e.stopPropagation();
      const eTable = entLink.dataset.entityTable;
      const eSearch = entLink.dataset.entitySearch;
      if (eTable === 'clans' && eSearch) {
        const openPopup3 = document.querySelector('.item-popup');
        if (openPopup3) openPopup3.remove();
        const openModal3 = $('#player-modal');
        if (openModal3 && !openModal3.classList.contains('hidden')) openModal3.classList.add('hidden');
        switchTab('clans');
        setTimeout(function () {
          const cs = $('#clan-search');
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
    const popupClose2 = e.target.closest('.item-popup-close');
    if (popupClose2) {
      const parentPopup = popupClose2.closest('.item-popup');
      if (parentPopup) parentPopup.remove();
      return;
    }

    // Close item popup on outside click
    const existingPopup = document.querySelector('.item-popup');
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

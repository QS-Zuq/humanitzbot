/**
 * Panel Switcher — Global server scope dropdown for multi-server mode.
 *
 * Replaces the carousel with a compact dropdown in the server bar header.
 * Shows server status dots and allows switching between "All Servers",
 * "Primary Server", and individual managed servers.
 *
 * @namespace Panel.switcher
 */
window.Panel = window.Panel || {};

(function () {
  'use strict';

  var S = Panel.core.S;
  var $ = Panel.core.$;
  var esc = Panel.core.esc;

  var _open = false;
  var _initialized = false;

  // ── Build Dropdown Items ──────────────────────────

  /** Build the dropdown menu HTML from server list + statuses */
  function _buildMenu() {
    var menu = $('#switcher-menu');
    if (!menu) return;

    var html = '';

    // "All Servers" option
    var allActive = S.currentServer === 'all' ? ' switcher-item-active' : '';
    html +=
      '<button class="switcher-item' +
      allActive +
      '" data-server="all">' +
      '<i data-lucide="globe" class="w-3.5 h-3.5 text-accent shrink-0"></i>' +
      '<span>' +
      esc(i18next.t('web:switcher.all_servers')) +
      '</span>' +
      '</button>';

    // Separator
    html += '<div class="switcher-sep"></div>';

    // Primary server
    var primaryStatus = S.serverStatuses.primary || {};
    var primaryDotCls = _dotClass(primaryStatus.status);
    var primaryActive = S.currentServer === 'primary' ? ' switcher-item-active' : '';
    var primaryName = primaryStatus.name || i18next.t('web:switcher.primary_server');
    html +=
      '<button class="switcher-item' +
      primaryActive +
      '" data-server="primary">' +
      '<span class="switcher-dot ' +
      primaryDotCls +
      '"></span>' +
      '<span class="truncate">' +
      esc(primaryName) +
      '</span>' +
      '</button>';

    // Additional servers
    var servers = S.serverList || [];
    for (var i = 0; i < servers.length; i++) {
      var srv = servers[i];
      if (srv.id === 'primary') continue;
      var st = S.serverStatuses[srv.id] || {};
      var dotCls = _dotClass(st.status);
      var active = S.currentServer === srv.id ? ' switcher-item-active' : '';
      html +=
        '<button class="switcher-item' +
        active +
        '" data-server="' +
        esc(srv.id) +
        '">' +
        '<span class="switcher-dot ' +
        dotCls +
        '"></span>' +
        '<span class="truncate">' +
        esc(srv.name || srv.id) +
        '</span>' +
        '</button>';
    }

    menu.innerHTML = html;
    if (window.lucide) lucide.createIcons({ nodes: [menu] });

    // Wire click handlers
    var items = menu.querySelectorAll('.switcher-item');
    for (var j = 0; j < items.length; j++) {
      items[j].addEventListener('click', _onItemClick);
    }
  }

  /** Determine dot CSS class from server status string */
  function _dotClass(status) {
    if (status === 'online') return 'switcher-dot-online';
    if (status === 'stale' || status === 'starting') return 'switcher-dot-starting';
    if (status === 'offline' || status === 'stopped') return 'switcher-dot-offline';
    return 'switcher-dot-offline';
  }

  // ── Update Button Label ───────────────────────────

  /** Update the dropdown trigger button to reflect current selection */
  function _updateButton() {
    var label = $('#switcher-label');
    var dot = $('#switcher-btn-dot');
    if (!label) return;

    if (S.currentServer === 'all') {
      label.textContent = i18next.t('web:switcher.all_servers');
      if (dot) {
        dot.className = 'switcher-dot switcher-dot-online';
        dot.style.display = 'none';
      }
    } else {
      var st = S.serverStatuses[S.currentServer] || {};
      var name = st.name;
      if (!name) {
        // Try to find in server list
        for (var i = 0; i < (S.serverList || []).length; i++) {
          if (S.serverList[i].id === S.currentServer) {
            name = S.serverList[i].name;
            break;
          }
        }
      }
      if (!name && S.currentServer === 'primary') {
        name = i18next.t('web:switcher.primary_server');
      }
      label.textContent = name || S.currentServer;
      if (dot) {
        dot.className = 'switcher-dot ' + _dotClass(st.status);
        dot.style.display = '';
      }
    }
  }

  // ── Toggle Dropdown ───────────────────────────────

  function _toggle() {
    _open = !_open;
    var menu = $('#switcher-menu');
    var chevron = $('#switcher-chevron');
    if (menu) menu.classList.toggle('hidden', !_open);
    if (chevron) chevron.style.transform = _open ? 'rotate(180deg)' : '';
    if (_open) _buildMenu();
  }

  function _close() {
    if (!_open) return;
    _open = false;
    var menu = $('#switcher-menu');
    var chevron = $('#switcher-chevron');
    if (menu) menu.classList.add('hidden');
    if (chevron) chevron.style.transform = '';
  }

  // ── Item Click Handler ────────────────────────────

  function _onItemClick(e) {
    var btn = e.currentTarget;
    var serverId = btn.dataset.server;
    if (!serverId || serverId === S.currentServer) {
      _close();
      return;
    }

    // Update URL param
    var url = new URL(window.location);
    url.searchParams.set('server', serverId);
    window.history.replaceState(null, '', url);

    // Close dropdown
    _close();

    // Delegate to panel-main switchServer (which resets state + reloads tab)
    if (Panel._internal && Panel._internal.switchServer) {
      Panel._internal.switchServer(serverId);
    } else {
      // Fallback: update state directly
      S.currentServer = serverId;
    }

    // Update button text
    _updateButton();
  }

  // ── Close on Outside Click ────────────────────────

  document.addEventListener('click', function (e) {
    if (!_open) return;
    var wrap = $('#switcher-wrap');
    if (wrap && !wrap.contains(e.target)) _close();
  });

  // Close on Escape
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && _open) _close();
  });

  // ── Init ──────────────────────────────────────────

  /** Initialize the switcher — called after server list is loaded */
  function init() {
    if (_initialized) return;
    var bar = $('#server-bar');
    if (!bar) return;

    // Always show — even single-server users can select primary

    // Read initial server from URL
    var urlParams = new URLSearchParams(window.location.search);
    var urlServer = urlParams.get('server');
    if (urlServer) {
      // In single-server mode, don't allow 'all' scope — fallback to primary
      if (urlServer === 'all' && !S.multiServer) {
        S.currentServer = 'primary';
      } else {
        S.currentServer = urlServer;
      }
    }

    // Wire the toggle button
    var toggleBtn = $('#switcher-btn');
    if (toggleBtn) {
      toggleBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        _toggle();
      });
    }

    _updateButton();
    _initialized = true;
  }

  /** Refresh the switcher display (after status updates) */
  function refresh() {
    _updateButton();
    if (_open) _buildMenu();
  }

  /** Get current scope descriptor */
  function getCurrentScope() {
    return S.currentServer;
  }

  // ── Expose API ────────────────────────────────────

  Panel.switcher = {
    init: init,
    refresh: refresh,
    getCurrentScope: getCurrentScope,
  };
})();

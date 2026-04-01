/**
 * Panel Tab: Servers — Fleet management grid, creation wizard, and server actions.
 * Admin-only tab for managing multiple game servers.
 * @namespace Panel.tabs.servers
 */
window.Panel = window.Panel || {};
Panel.tabs = Panel.tabs || {};

(function () {
  'use strict';

  var $ = Panel.core.$;
  var el = Panel.core.el;
  var esc = Panel.core.esc;
  var apiFetch = Panel.core.apiFetch;

  var _inited = false;
  var _refreshTimer = null;
  var _servers = [];

  // ── Helpers ──────────────────────────────────────

  function t(key, opts) {
    return i18next.t('web:servers.' + key, opts);
  }

  function showToast(msg) {
    if (Panel.core.utils && Panel.core.utils.showToast) {
      Panel.core.utils.showToast(msg);
    }
  }

  function relativeTime(dateStr) {
    if (!dateStr) return t('card_last_sync_never');
    var diff = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
    if (diff < 60) return diff + 's ago';
    if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    return Math.floor(diff / 86400) + 'd ago';
  }

  function statusDotClass(status) {
    if (status === 'online' || status === 'running') return 'srv-dot-online';
    if (status === 'starting') return 'srv-dot-starting';
    if (status === 'stopping') return 'srv-dot-starting';
    return 'srv-dot-offline';
  }

  function statusLabel(status) {
    if (status === 'online' || status === 'running') return t('status_online');
    if (status === 'starting') return t('status_starting');
    if (status === 'stopping') return t('status_stopping');
    if (status === 'offline' || status === 'stopped') return t('status_offline');
    return t('status_unknown');
  }

  // ── Init ────────────────────────────────────────

  function init() {
    if (_inited) return;
    _inited = true;

    var addBtn = $('#srv-add-btn');
    if (addBtn) {
      addBtn.addEventListener('click', function () {
        openWizard();
      });
    }
  }

  // ── Load ────────────────────────────────────────

  async function load() {
    clearInterval(_refreshTimer);
    await fetchServers();
    _refreshTimer = setInterval(fetchServers, 15000);
    Panel.core.S.pollTimers.push(_refreshTimer);
  }

  async function fetchServers() {
    try {
      var r = await apiFetch('/api/panel/servers');
      if (!r.ok) {
        console.warn('[Servers] fetchServers HTTP', r.status);
        return;
      }
      var d = await r.json();
      _servers = d.servers || [];
      renderGrid();
    } catch (err) {
      console.warn('[Servers] fetchServers error:', err.message);
    }
  }

  // ── Grid Rendering ─────────────────────────────

  function renderGrid() {
    var grid = $('#srv-grid');
    if (!grid) return;

    if (!_servers.length) {
      grid.innerHTML =
        '<div class="col-span-full flex flex-col items-center justify-center py-16 text-center">' +
        '<i data-lucide="server-off" class="w-12 h-12 text-muted/30 mb-4"></i>' +
        '<p class="text-muted text-sm">' +
        esc(t('no_servers')) +
        '</p>' +
        '<p class="text-muted/50 text-xs mt-1">' +
        esc(t('no_servers_hint')) +
        '</p>' +
        '</div>';
      if (window.lucide) lucide.createIcons({ nodes: [grid] });
      return;
    }

    var html = '';
    for (var i = 0; i < _servers.length; i++) {
      html += renderCard(_servers[i]);
    }
    grid.innerHTML = html;

    // Wire action buttons
    var btns = grid.querySelectorAll('[data-srv-action]');
    for (var j = 0; j < btns.length; j++) {
      btns[j].addEventListener('click', onActionClick);
    }

    if (window.lucide) lucide.createIcons({ nodes: [grid] });
  }

  function renderCard(srv) {
    var isOnline = srv.status === 'running' || srv.status === 'online';
    var dotCls = statusDotClass(srv.status);
    var label = statusLabel(srv.status);
    var borderCls =
      srv.status === 'online'
        ? 'border-emerald-500/20'
        : srv.status === 'starting' || srv.status === 'stopping'
          ? 'border-amber-500/20'
          : 'border-border';

    var playersText = srv.players
      ? i18next.t('web:servers.card_players', { current: srv.players.current || 0, max: srv.players.max || '?' })
      : t('card_players_unknown');

    var syncText = srv.lastSync ? t('card_last_sync', { time: relativeTime(srv.lastSync) }) : t('card_last_sync_never');

    var primaryBadge = srv.isPrimary
      ? '<span class="text-[9px] font-semibold bg-accent/10 text-accent px-1.5 py-0.5 rounded">' +
        esc(t('card_primary')) +
        '</span>'
      : '';

    var moduleCount = Array.isArray(srv.modules) ? srv.modules.length : 0;

    var toggleAction = isOnline ? 'stop' : 'start';
    var toggleLabel = isOnline ? t('action_stop') : t('action_start');
    var toggleIcon = isOnline ? 'square' : 'play';
    var toggleCls = isOnline ? 'text-red-400 hover:bg-red-400/10' : 'text-emerald-400 hover:bg-emerald-400/10';

    return (
      '<div class="srv-card ' +
      borderCls +
      '" data-srv-id="' +
      esc(srv.id) +
      '">' +
      '<div class="flex items-center justify-between mb-3">' +
      '<div class="flex items-center gap-2 min-w-0">' +
      '<span class="srv-dot ' +
      dotCls +
      '"></span>' +
      '<h3 class="text-sm font-semibold text-text-bright truncate">' +
      esc(srv.name || srv.id) +
      '</h3>' +
      primaryBadge +
      '</div>' +
      '<span class="text-[10px] text-muted shrink-0">' +
      esc(label) +
      '</span>' +
      '</div>' +
      '<div class="flex items-center gap-4 text-xs text-muted mb-4">' +
      '<span class="flex items-center gap-1"><i data-lucide="users" class="w-3 h-3"></i> ' +
      esc(playersText) +
      '</span>' +
      '<span class="flex items-center gap-1"><i data-lucide="refresh-cw" class="w-3 h-3"></i> ' +
      esc(syncText) +
      '</span>' +
      (moduleCount
        ? '<span class="flex items-center gap-1"><i data-lucide="puzzle" class="w-3 h-3"></i> ' +
          esc(t('card_modules', { count: moduleCount })) +
          '</span>'
        : '') +
      '</div>' +
      '<div class="flex items-center gap-1.5 border-t border-border/40 pt-3">' +
      '<button data-srv-action="' +
      toggleAction +
      '" data-srv-id="' +
      esc(srv.id) +
      '" class="srv-action-btn ' +
      toggleCls +
      '"><i data-lucide="' +
      toggleIcon +
      '" class="w-3 h-3"></i> ' +
      esc(toggleLabel) +
      '</button>' +
      '<button data-srv-action="restart" data-srv-id="' +
      esc(srv.id) +
      '" class="srv-action-btn text-amber-400 hover:bg-amber-400/10"><i data-lucide="rotate-cw" class="w-3 h-3"></i> ' +
      esc(t('action_restart')) +
      '</button>' +
      '<div class="ml-auto flex items-center gap-1">' +
      '<button data-srv-action="game-settings" data-srv-id="' +
      esc(srv.id) +
      '" class="srv-action-btn text-muted hover:text-text" title="Game Settings"><i data-lucide="sliders" class="w-3 h-3"></i></button>' +
      '<button data-srv-action="welcome" data-srv-id="' +
      esc(srv.id) +
      '" class="srv-action-btn text-muted hover:text-text" title="Welcome Message"><i data-lucide="message-square" class="w-3 h-3"></i></button>' +
      '<button data-srv-action="auto-messages" data-srv-id="' +
      esc(srv.id) +
      '" class="srv-action-btn text-muted hover:text-text" title="Auto-Messages"><i data-lucide="megaphone" class="w-3 h-3"></i></button>' +
      '<button data-srv-action="edit" data-srv-id="' +
      esc(srv.id) +
      '" class="srv-action-btn text-muted hover:text-text"><i data-lucide="pencil" class="w-3 h-3"></i></button>' +
      (srv.isPrimary
        ? ''
        : '<button data-srv-action="delete" data-srv-id="' +
          esc(srv.id) +
          '" data-srv-name="' +
          esc(srv.name || srv.id) +
          '" class="srv-action-btn text-red-400/50 hover:text-red-400 hover:bg-red-400/10"><i data-lucide="trash-2" class="w-3 h-3"></i></button>') +
      '</div>' +
      '</div>' +
      '</div>'
    );
  }

  // ── Action Handlers ────────────────────────────

  function onActionClick(e) {
    var btn = e.currentTarget;
    var action = btn.dataset.srvAction;
    var serverId = btn.dataset.srvId;
    var serverName = btn.dataset.srvName || serverId;

    switch (action) {
      case 'start':
        doServerAction(serverId, 'start');
        break;
      case 'stop':
        showConfirm(t('confirm_stop_title'), t('confirm_stop_msg'), function () {
          doServerAction(serverId, 'stop');
        });
        break;
      case 'restart':
        showConfirm(t('confirm_restart_title'), t('confirm_restart_msg'), function () {
          doServerAction(serverId, 'restart');
        });
        break;
      case 'delete':
        showDeleteConfirm(serverName, serverId);
        break;
      case 'edit':
        editServer(serverId);
        break;
      case 'game-settings':
        openGameSettings(serverId);
        break;
      case 'welcome':
        openWelcome(serverId);
        break;
      case 'auto-messages':
        openAutoMessages(serverId);
        break;
    }
  }

  async function doServerAction(serverId, action) {
    try {
      var r;
      if (serverId === 'primary') {
        // Primary server uses the power endpoint
        r = await apiFetch('/api/panel/power', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: action }),
        });
      } else {
        r = await apiFetch('/api/panel/servers/' + encodeURIComponent(serverId) + '/actions/' + action, {
          method: 'POST',
        });
      }
      var d = await r.json();
      if (d.ok) {
        showToast(t('toast_' + action + '_ok'));
        await fetchServers();
      } else {
        showToast(t('toast_action_fail', { error: d.error || 'Unknown error' }));
      }
    } catch (err) {
      showToast(t('toast_action_fail', { error: err.message }));
    }
  }

  function editServer(serverId) {
    // Switch to the server scope and open settings tab
    if (Panel._internal && Panel._internal.switchServer) {
      Panel._internal.switchServer(serverId);
    } else {
      Panel.core.S.currentServer = serverId;
    }
    if (Panel.nav && Panel.nav.switchTab) {
      Panel.nav.switchTab('settings');
    }
  }

  // ── Confirmation Dialogs ─────────────────────

  function showConfirm(title, message, onConfirm) {
    removeModal();
    var overlay = el('div', 'srv-modal-overlay');
    var modal = el('div', 'srv-modal');
    modal.innerHTML =
      '<h3 class="text-base font-semibold text-text-bright mb-3">' +
      esc(title) +
      '</h3>' +
      '<p class="text-sm text-muted mb-6">' +
      esc(message) +
      '</p>' +
      '<div class="flex justify-end gap-2">' +
      '<button class="srv-modal-cancel btn-secondary text-xs px-4 py-2">' +
      esc(t('cancel_btn')) +
      '</button>' +
      '<button class="srv-modal-confirm btn-primary text-xs px-4 py-2">' +
      esc(t('confirm_btn')) +
      '</button>' +
      '</div>';

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    overlay.querySelector('.srv-modal-cancel').addEventListener('click', removeModal);
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) removeModal();
    });
    overlay.querySelector('.srv-modal-confirm').addEventListener('click', function () {
      removeModal();
      onConfirm();
    });
  }

  function showDeleteConfirm(serverName, serverId) {
    removeModal();
    var overlay = el('div', 'srv-modal-overlay');
    var modal = el('div', 'srv-modal');
    modal.innerHTML =
      '<h3 class="text-base font-semibold text-red-400 mb-3">' +
      esc(t('confirm_delete_title')) +
      '</h3>' +
      '<p class="text-sm text-muted mb-2">' +
      esc(t('confirm_delete_msg')) +
      '</p>' +
      '<p class="text-sm text-text-bright font-mono mb-4">' +
      esc(serverName) +
      '</p>' +
      '<input type="text" class="input-field w-full mb-4 text-sm" id="srv-delete-input" placeholder="' +
      esc(t('confirm_delete_placeholder')) +
      '">' +
      '<div class="flex justify-end gap-2">' +
      '<button class="srv-modal-cancel btn-secondary text-xs px-4 py-2">' +
      esc(t('cancel_btn')) +
      '</button>' +
      '<button class="srv-modal-delete btn-primary text-xs px-4 py-2 opacity-50 cursor-not-allowed" disabled style="background:rgba(196,90,74,0.2);border-color:rgba(196,90,74,0.3);color:var(--color-horde, #c45a4a)">' +
      esc(t('action_delete')) +
      '</button>' +
      '</div>';

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    var input = overlay.querySelector('#srv-delete-input');
    var deleteBtn = overlay.querySelector('.srv-modal-delete');

    input.addEventListener('input', function () {
      var matches = input.value === serverName;
      deleteBtn.disabled = !matches;
      deleteBtn.classList.toggle('opacity-50', !matches);
      deleteBtn.classList.toggle('cursor-not-allowed', !matches);
    });

    overlay.querySelector('.srv-modal-cancel').addEventListener('click', removeModal);
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) removeModal();
    });
    deleteBtn.addEventListener('click', async function () {
      if (deleteBtn.disabled) return;
      removeModal();
      try {
        var r = await apiFetch('/api/panel/servers/' + encodeURIComponent(serverId) + '?confirm=true', {
          method: 'DELETE',
        });
        var d = await r.json();
        if (d.ok) {
          showToast(t('toast_deleted', { name: serverName }));
          await fetchServers();
        } else {
          showToast(t('toast_delete_fail', { error: d.error || 'Unknown error' }));
        }
      } catch (err) {
        showToast(t('toast_delete_fail', { error: err.message }));
      }
    });
  }

  function removeModal() {
    var existing = document.querySelector('.srv-modal-overlay');
    if (existing) existing.remove();
  }

  // ── Wizard ─────────────────────────────────────

  var _wizardStep = 0;
  var _wizardData = {};
  var _discoveryJobId = null;
  var _discoveryTimer = null;

  function openWizard() {
    _wizardStep = 0;
    _wizardData = {
      name: '',
      port: '',
      enabled: true,
      rconHost: '',
      rconPort: '27015',
      rconPassword: '',
      sftpHost: '',
      sftpPort: '22',
      sftpUsername: '',
      sftpPassword: '',
      savePath: '',
      logPath: '',
      settingsPath: '',
      startImmediately: false,
    };
    _discoveryJobId = null;
    clearInterval(_discoveryTimer);
    renderWizard();
  }

  function renderWizard() {
    removeModal();
    var overlay = el('div', 'srv-modal-overlay');
    var modal = el('div', 'srv-modal srv-wizard');

    // Step indicator
    var steps = [
      t('wizard_step_basic'),
      t('wizard_step_connection'),
      t('wizard_step_discovery'),
      t('wizard_step_review'),
    ];
    var stepHtml = '<div class="flex items-center gap-1 mb-6">';
    for (var i = 0; i < steps.length; i++) {
      var active = i === _wizardStep;
      var done = i < _wizardStep;
      var cls = active ? 'srv-step-active' : done ? 'srv-step-done' : 'srv-step-pending';
      stepHtml +=
        '<div class="srv-step ' +
        cls +
        '">' +
        '<span class="srv-step-num">' +
        (i + 1) +
        '</span>' +
        '<span class="srv-step-label">' +
        esc(steps[i]) +
        '</span>' +
        '</div>';
      if (i < steps.length - 1)
        stepHtml += '<div class="srv-step-connector' + (done ? ' srv-step-connector-done' : '') + '"></div>';
    }
    stepHtml += '</div>';

    // Title
    var html =
      '<div class="flex items-center justify-between mb-2">' +
      '<h3 class="text-base font-semibold text-text-bright">' +
      esc(t('wizard_title')) +
      '</h3>' +
      '<button class="srv-wizard-close modal-close" style="position:static"><i data-lucide="x" class="w-3.5 h-3.5"></i></button>' +
      '</div>' +
      stepHtml;

    // Step content
    switch (_wizardStep) {
      case 0:
        html += renderStepBasic();
        break;
      case 1:
        html += renderStepConnection();
        break;
      case 2:
        html += renderStepDiscovery();
        break;
      case 3:
        html += renderStepReview();
        break;
    }

    modal.innerHTML = html;
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    if (window.lucide) lucide.createIcons({ nodes: [modal] });

    // Wire events
    wireWizardEvents(overlay);
  }

  function renderStepBasic() {
    return (
      '<div class="space-y-4">' +
      '<div>' +
      '<label class="block text-xs text-muted mb-1">' +
      esc(t('field_name')) +
      ' <span class="text-red-400">*</span></label>' +
      '<input type="text" id="wiz-name" class="input-field w-full" placeholder="' +
      esc(t('field_name_placeholder')) +
      '" value="' +
      esc(_wizardData.name) +
      '">' +
      '<p id="wiz-name-err" class="text-red-400 text-[10px] mt-1 hidden">' +
      esc(t('field_name_required')) +
      '</p>' +
      '</div>' +
      '<div>' +
      '<label class="block text-xs text-muted mb-1">' +
      esc(t('field_port')) +
      '</label>' +
      '<input type="number" id="wiz-port" class="input-field w-full" placeholder="' +
      esc(t('field_port_placeholder')) +
      '" value="' +
      esc(_wizardData.port) +
      '">' +
      '</div>' +
      '<div class="flex items-center gap-2">' +
      '<input type="checkbox" id="wiz-enabled" class="accent-accent w-4 h-4"' +
      (_wizardData.enabled ? ' checked' : '') +
      '>' +
      '<label for="wiz-enabled" class="text-sm text-text cursor-pointer">' +
      esc(t('field_enabled')) +
      '</label>' +
      '</div>' +
      '</div>' +
      wizardFooter(false, true)
    );
  }

  function renderStepConnection() {
    return (
      '<div class="space-y-4">' +
      '<div class="card-title text-xs flex items-center gap-1.5"><i data-lucide="terminal" class="w-3.5 h-3.5"></i> RCON</div>' +
      '<div class="grid grid-cols-2 gap-3">' +
      fieldInput('wiz-rcon-host', t('field_rcon_host'), _wizardData.rconHost, '') +
      fieldInput('wiz-rcon-port', t('field_rcon_port'), _wizardData.rconPort, '27015') +
      '</div>' +
      fieldInput('wiz-rcon-pass', t('field_rcon_password'), _wizardData.rconPassword, '', 'password') +
      '<div class="card-title text-xs flex items-center gap-1.5 mt-4"><i data-lucide="folder" class="w-3.5 h-3.5"></i> SFTP</div>' +
      '<div class="grid grid-cols-2 gap-3">' +
      fieldInput('wiz-sftp-host', t('field_sftp_host'), _wizardData.sftpHost, '') +
      fieldInput('wiz-sftp-port', t('field_sftp_port'), _wizardData.sftpPort, '22') +
      '</div>' +
      '<div class="grid grid-cols-2 gap-3">' +
      fieldInput('wiz-sftp-user', t('field_sftp_username'), _wizardData.sftpUsername, '') +
      fieldInput('wiz-sftp-pass', t('field_sftp_password'), _wizardData.sftpPassword, '', 'password') +
      '</div>' +
      '<div>' +
      '<button id="wiz-test-conn" class="btn-secondary text-xs px-3 py-1.5 flex items-center gap-1.5">' +
      '<i data-lucide="plug" class="w-3 h-3"></i> ' +
      esc(t('test_connection')) +
      '</button>' +
      '<div id="wiz-test-results" class="mt-2 text-xs space-y-1 hidden"></div>' +
      '</div>' +
      '</div>' +
      wizardFooter(true, true)
    );
  }

  function renderStepDiscovery() {
    var hasSftp = _wizardData.sftpHost && _wizardData.sftpUsername;
    if (!hasSftp) {
      return (
        '<div class="space-y-4">' +
        '<div class="text-sm text-muted flex items-center gap-2 mb-2">' +
        '<i data-lucide="info" class="w-4 h-4 text-amber-400 shrink-0"></i>' +
        esc(t('discovery_no_sftp')) +
        '</div>' +
        renderManualPaths() +
        '</div>' +
        wizardFooter(true, true)
      );
    }

    return (
      '<div class="space-y-4">' +
      '<div id="wiz-discovery-status" class="text-sm text-muted">' +
      '<div class="flex items-center gap-2"><i data-lucide="loader-2" class="w-4 h-4 animate-spin"></i> ' +
      esc(t('discovery_running')) +
      '</div>' +
      '</div>' +
      '<div id="wiz-discovery-paths" class="hidden">' +
      renderManualPaths() +
      '</div>' +
      '<button id="wiz-skip-discovery" class="btn-secondary text-xs px-3 py-1.5">' +
      esc(t('discovery_skip')) +
      '</button>' +
      '</div>' +
      wizardFooter(true, true)
    );
  }

  function renderManualPaths() {
    return (
      fieldInput('wiz-save-path', t('field_save_path'), _wizardData.savePath, '') +
      '<div class="mt-3">' +
      fieldInput('wiz-log-path', t('field_log_path'), _wizardData.logPath, '') +
      '</div>' +
      '<div class="mt-3">' +
      fieldInput('wiz-settings-path', t('field_settings_path'), _wizardData.settingsPath, '') +
      '</div>'
    );
  }

  function renderStepReview() {
    var rconConfigured = _wizardData.rconHost && _wizardData.rconPassword;
    var sftpConfigured = _wizardData.sftpHost && _wizardData.sftpUsername;

    return (
      '<div class="space-y-3">' +
      '<table class="w-full text-sm">' +
      reviewRow(t('review_name'), _wizardData.name) +
      reviewRow(t('review_port'), _wizardData.port || '\u2014') +
      reviewRow(t('review_enabled'), _wizardData.enabled ? t('review_yes') : t('review_no')) +
      reviewRow(t('review_rcon'), rconConfigured ? t('review_configured') : t('review_not_configured')) +
      reviewRow(t('review_sftp'), sftpConfigured ? t('review_configured') : t('review_not_configured')) +
      reviewRow(
        t('review_paths'),
        _wizardData.savePath || _wizardData.logPath || _wizardData.settingsPath
          ? t('review_configured')
          : t('review_not_configured'),
      ) +
      '</table>' +
      '<div class="flex items-center gap-2 mt-4">' +
      '<input type="checkbox" id="wiz-start-imm" class="accent-accent w-4 h-4"' +
      (_wizardData.startImmediately ? ' checked' : '') +
      '>' +
      '<label for="wiz-start-imm" class="text-sm text-text cursor-pointer">' +
      esc(t('start_immediately')) +
      '</label>' +
      '</div>' +
      '</div>' +
      '<div class="flex justify-between mt-6">' +
      '<button class="wiz-back btn-secondary text-xs px-4 py-2">' +
      esc(t('back_btn')) +
      '</button>' +
      '<button class="wiz-create btn-primary text-xs px-4 py-2 flex items-center gap-1.5">' +
      '<i data-lucide="plus" class="w-3 h-3"></i> ' +
      esc(t('create_btn')) +
      '</button>' +
      '</div>'
    );
  }

  function reviewRow(label, value) {
    return (
      '<tr class="border-b border-border/30">' +
      '<td class="py-2 text-muted pr-4">' +
      esc(label) +
      '</td>' +
      '<td class="py-2 text-text-bright">' +
      esc(value) +
      '</td>' +
      '</tr>'
    );
  }

  function fieldInput(id, label, value, placeholder, type) {
    return (
      '<div>' +
      '<label class="block text-xs text-muted mb-1">' +
      esc(label) +
      '</label>' +
      '<input type="' +
      (type || 'text') +
      '" id="' +
      id +
      '" class="input-field w-full" placeholder="' +
      esc(placeholder) +
      '" value="' +
      esc(value) +
      '">' +
      '</div>'
    );
  }

  function wizardFooter(showBack, showNext) {
    var html = '<div class="flex justify-between mt-6">';
    if (showBack) {
      html += '<button class="wiz-back btn-secondary text-xs px-4 py-2">' + esc(t('back_btn')) + '</button>';
    } else {
      html += '<div></div>';
    }
    if (showNext) {
      html += '<button class="wiz-next btn-primary text-xs px-4 py-2">' + esc(t('next_btn')) + '</button>';
    }
    html += '</div>';
    return html;
  }

  // ── Wizard Events ──────────────────────────────

  function wireWizardEvents(overlay) {
    var closeBtn = overlay.querySelector('.srv-wizard-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', removeModal);
    }

    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) removeModal();
    });

    var backBtn = overlay.querySelector('.wiz-back');
    if (backBtn) {
      backBtn.addEventListener('click', function () {
        collectWizardData();
        _wizardStep--;
        clearInterval(_discoveryTimer);
        renderWizard();
      });
    }

    var nextBtn = overlay.querySelector('.wiz-next');
    if (nextBtn) {
      nextBtn.addEventListener('click', function () {
        collectWizardData();
        if (_wizardStep === 0 && !_wizardData.name.trim()) {
          var errEl = overlay.querySelector('#wiz-name-err');
          if (errEl) errEl.classList.remove('hidden');
          var nameEl = overlay.querySelector('#wiz-name');
          if (nameEl) nameEl.classList.add('border-red-400');
          return;
        }
        _wizardStep++;
        renderWizard();
        if (_wizardStep === 2) startDiscovery();
      });
    }

    var testBtn = overlay.querySelector('#wiz-test-conn');
    if (testBtn) {
      testBtn.addEventListener('click', function () {
        testConnection(overlay);
      });
    }

    var skipBtn = overlay.querySelector('#wiz-skip-discovery');
    if (skipBtn) {
      skipBtn.addEventListener('click', function () {
        clearInterval(_discoveryTimer);
        var statusEl = overlay.querySelector('#wiz-discovery-status');
        if (statusEl) statusEl.classList.add('hidden');
        var pathsEl = overlay.querySelector('#wiz-discovery-paths');
        if (pathsEl) pathsEl.classList.remove('hidden');
        if (skipBtn) skipBtn.classList.add('hidden');
      });
    }

    var createBtn = overlay.querySelector('.wiz-create');
    if (createBtn) {
      createBtn.addEventListener('click', function () {
        collectWizardData();
        createServer();
      });
    }
  }

  function collectWizardData() {
    var v = function (id) {
      var el = document.getElementById(id);
      return el ? el.value : '';
    };
    var c = function (id) {
      var el = document.getElementById(id);
      return el ? el.checked : false;
    };

    if (_wizardStep === 0) {
      _wizardData.name = v('wiz-name');
      _wizardData.port = v('wiz-port');
      _wizardData.enabled = c('wiz-enabled');
    } else if (_wizardStep === 1) {
      _wizardData.rconHost = v('wiz-rcon-host');
      _wizardData.rconPort = v('wiz-rcon-port');
      _wizardData.rconPassword = v('wiz-rcon-pass');
      _wizardData.sftpHost = v('wiz-sftp-host');
      _wizardData.sftpPort = v('wiz-sftp-port');
      _wizardData.sftpUsername = v('wiz-sftp-user');
      _wizardData.sftpPassword = v('wiz-sftp-pass');
    } else if (_wizardStep === 2) {
      _wizardData.savePath = v('wiz-save-path');
      _wizardData.logPath = v('wiz-log-path');
      _wizardData.settingsPath = v('wiz-settings-path');
    } else if (_wizardStep === 3) {
      _wizardData.startImmediately = c('wiz-start-imm');
    }
  }

  // ── Test Connection ───────────────────────────

  async function testConnection(overlay) {
    collectWizardData();
    var testBtn = overlay.querySelector('#wiz-test-conn');
    var results = overlay.querySelector('#wiz-test-results');
    if (!results || !testBtn) return;

    testBtn.disabled = true;
    testBtn.innerHTML = '<i data-lucide="loader-2" class="w-3 h-3 animate-spin"></i> ' + esc(t('testing_connection'));
    if (window.lucide) lucide.createIcons({ nodes: [testBtn] });
    results.classList.remove('hidden');
    results.innerHTML = '';

    try {
      var r = await apiFetch('/api/panel/servers/test-connection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rcon: {
            host: _wizardData.rconHost,
            port: parseInt(_wizardData.rconPort, 10) || 27015,
            password: _wizardData.rconPassword,
          },
          sftp: {
            host: _wizardData.sftpHost,
            port: parseInt(_wizardData.sftpPort, 10) || 22,
            user: _wizardData.sftpUsername,
            password: _wizardData.sftpPassword,
          },
        }),
      });
      var d = await r.json();

      var rconHtml =
        d.rcon && d.rcon.ok
          ? '<div class="flex items-center gap-1.5 text-emerald-400"><i data-lucide="check-circle" class="w-3.5 h-3.5"></i> ' +
            esc(t('test_rcon_ok')) +
            '</div>'
          : '<div class="flex items-center gap-1.5 text-red-400"><i data-lucide="x-circle" class="w-3.5 h-3.5"></i> ' +
            esc(t('test_rcon_fail')) +
            (d.rcon && d.rcon.error ? ' — ' + esc(d.rcon.error) : '') +
            '</div>';

      var sftpHtml =
        d.sftp && d.sftp.ok
          ? '<div class="flex items-center gap-1.5 text-emerald-400"><i data-lucide="check-circle" class="w-3.5 h-3.5"></i> ' +
            esc(t('test_sftp_ok')) +
            '</div>'
          : '<div class="flex items-center gap-1.5 text-red-400"><i data-lucide="x-circle" class="w-3.5 h-3.5"></i> ' +
            esc(t('test_sftp_fail')) +
            (d.sftp && d.sftp.error ? ' — ' + esc(d.sftp.error) : '') +
            '</div>';

      results.innerHTML = rconHtml + sftpHtml;
    } catch (err) {
      results.innerHTML = '<div class="text-red-400">' + esc(err.message) + '</div>';
    }

    testBtn.disabled = false;
    testBtn.innerHTML = '<i data-lucide="plug" class="w-3 h-3"></i> ' + esc(t('test_connection'));
    if (window.lucide) lucide.createIcons({ nodes: [testBtn, results] });
  }

  // ── Discovery ──────────────────────────────────

  async function startDiscovery() {
    var hasSftp = _wizardData.sftpHost && _wizardData.sftpUsername;
    if (!hasSftp) return;

    try {
      var r = await apiFetch('/api/panel/servers/discover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sftp: {
            host: _wizardData.sftpHost,
            port: parseInt(_wizardData.sftpPort, 10) || 22,
            user: _wizardData.sftpUsername,
            password: _wizardData.sftpPassword,
          },
        }),
      });
      var d = await r.json();
      if (!r.ok || !d.ok) {
        showDiscoveryResult(null, true);
        return;
      }
      _discoveryJobId = d.jobId;
      if (_discoveryJobId) {
        _discoveryTimer = setInterval(pollDiscovery, 2000);
      }
    } catch (err) {
      console.warn('[Servers] startDiscovery error:', err.message);
      showDiscoveryResult(null, true);
    }
  }

  async function pollDiscovery() {
    if (!_discoveryJobId) return;
    try {
      var r = await apiFetch('/api/panel/servers/discover/' + encodeURIComponent(_discoveryJobId));
      var d = await r.json();

      var statusEl = document.querySelector('#wiz-discovery-status');
      if (!statusEl) {
        clearInterval(_discoveryTimer);
        return;
      }

      if (d.state === 'running' || d.state === 'pending') {
        var stepText = d.currentStep
          ? t('discovery_step', {
              current: d.currentStep.current || '?',
              total: d.currentStep.total || '?',
              name: d.currentStep.name || '',
            })
          : t('discovery_running');
        statusEl.innerHTML =
          '<div class="flex items-center gap-2"><i data-lucide="loader-2" class="w-4 h-4 animate-spin"></i> ' +
          esc(stepText) +
          '</div>';
        if (window.lucide) lucide.createIcons({ nodes: [statusEl] });
      } else if (d.state === 'completed') {
        clearInterval(_discoveryTimer);
        showDiscoveryResult(d.result, false);
      } else {
        clearInterval(_discoveryTimer);
        showDiscoveryResult(null, true);
      }
    } catch (_e) {
      clearInterval(_discoveryTimer);
      showDiscoveryResult(null, true);
    }
  }

  function showDiscoveryResult(result, failed) {
    var statusEl = document.querySelector('#wiz-discovery-status');
    var pathsEl = document.querySelector('#wiz-discovery-paths');
    var skipBtn = document.querySelector('#wiz-skip-discovery');

    if (failed) {
      if (statusEl) {
        statusEl.innerHTML =
          '<div class="flex items-center gap-2 text-red-400"><i data-lucide="alert-triangle" class="w-4 h-4"></i> ' +
          esc(t('discovery_failed')) +
          '</div>';
        if (window.lucide) lucide.createIcons({ nodes: [statusEl] });
      }
      if (pathsEl) pathsEl.classList.remove('hidden');
      if (skipBtn) skipBtn.classList.add('hidden');
      return;
    }

    // Success — populate paths
    if (result) {
      if (result.savePath) _wizardData.savePath = result.savePath;
      if (result.logPath) _wizardData.logPath = result.logPath;
      if (result.settingsPath) _wizardData.settingsPath = result.settingsPath;
    }

    if (statusEl) {
      statusEl.innerHTML =
        '<div class="flex items-center gap-2 text-emerald-400"><i data-lucide="check-circle" class="w-4 h-4"></i> ' +
        esc(t('discovery_complete')) +
        '</div>';
      if (window.lucide) lucide.createIcons({ nodes: [statusEl] });
    }

    // Show paths with discovered values
    if (pathsEl) {
      pathsEl.classList.remove('hidden');
      var saveInput = document.getElementById('wiz-save-path');
      var logInput = document.getElementById('wiz-log-path');
      var settingsInput = document.getElementById('wiz-settings-path');
      if (saveInput) saveInput.value = _wizardData.savePath;
      if (logInput) logInput.value = _wizardData.logPath;
      if (settingsInput) settingsInput.value = _wizardData.settingsPath;
    }
    if (skipBtn) skipBtn.classList.add('hidden');
  }

  // ── Create Server ──────────────────────────────

  async function createServer() {
    var payload = {
      name: _wizardData.name.trim(),
      enabled: _wizardData.enabled,
    };
    if (_wizardData.port) payload.port = parseInt(_wizardData.port, 10);
    if (_wizardData.rconHost) {
      payload.rcon = {
        host: _wizardData.rconHost,
        port: parseInt(_wizardData.rconPort, 10) || 27015,
        password: _wizardData.rconPassword,
      };
    }
    if (_wizardData.sftpHost) {
      payload.sftp = {
        host: _wizardData.sftpHost,
        port: parseInt(_wizardData.sftpPort, 10) || 22,
        user: _wizardData.sftpUsername,
        password: _wizardData.sftpPassword,
      };
    }
    if (_wizardData.savePath || _wizardData.logPath || _wizardData.settingsPath) {
      payload.paths = {};
      if (_wizardData.savePath) payload.paths.save = _wizardData.savePath;
      if (_wizardData.logPath) payload.paths.log = _wizardData.logPath;
      if (_wizardData.settingsPath) payload.paths.settings = _wizardData.settingsPath;
    }
    payload.startImmediately = _wizardData.startImmediately;

    try {
      var r = await apiFetch('/api/panel/servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      var d = await r.json();
      if (d.ok) {
        removeModal();
        showToast(t('toast_created', { name: payload.name }));
        await fetchServers();
      } else {
        showToast(t('toast_create_fail', { error: d.error || 'Unknown error' }));
      }
    } catch (err) {
      showToast(t('toast_create_fail', { error: err.message }));
    }
  }

  // ── Game Settings Modal ────────────────────────

  async function openGameSettings(serverId) {
    removeModal();
    var overlay = el('div', 'srv-modal-overlay');
    var modal = el('div', 'srv-modal');
    var titleHtml =
      '<div class="flex items-center justify-between mb-4">' +
      '<h3 class="text-base font-semibold text-text-bright flex items-center gap-2">' +
      '<i data-lucide="sliders" class="w-4 h-4"></i> Game Settings' +
      '</h3>' +
      '<button class="srv-modal-close modal-close" style="position:static"><i data-lucide="x" class="w-3.5 h-3.5"></i></button>' +
      '</div>' +
      '<div id="srv-gs-body" class="text-sm text-muted">Loading\u2026</div>' +
      '<div class="flex justify-end gap-2 mt-4">' +
      '<button class="srv-gs-cancel btn-secondary text-xs px-4 py-2">Cancel</button>' +
      '<button class="srv-gs-save btn-primary text-xs px-4 py-2">Save</button>' +
      '</div>';
    modal.innerHTML = titleHtml;
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    if (window.lucide) lucide.createIcons({ nodes: [modal] });

    overlay.querySelector('.srv-modal-close').addEventListener('click', removeModal);
    overlay.querySelector('.srv-gs-cancel').addEventListener('click', removeModal);
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) removeModal();
    });

    var body = modal.querySelector('#srv-gs-body');

    try {
      var schemaResp = await apiFetch('/api/panel/settings-schema');
      if (!schemaResp.ok) throw new Error(t('gs_load_fail', { error: schemaResp.status }));
      var schemaData = await schemaResp.json();
      var settingsResp = await apiFetch('/api/panel/settings?server=' + encodeURIComponent(serverId));
      if (!settingsResp.ok) throw new Error(t('gs_load_fail', { error: settingsResp.status }));
      var settingsData = await settingsResp.json();

      var categories = (schemaData && schemaData.categories) || [];
      var current = (settingsData && settingsData.settings) || {};

      if (!categories.length) {
        body.textContent = t('gs_no_categories');
        return;
      }

      var html = '<div class="space-y-4 max-h-96 overflow-y-auto pr-1">';
      for (var ci = 0; ci < categories.length; ci++) {
        var cat = categories[ci];
        html +=
          '<div><div class="text-xs font-semibold text-accent mb-2">' +
          esc((cat.emoji || '') + ' ' + (cat.label || cat.id)) +
          '</div><div class="space-y-2">';
        var fields = cat.settings || [];
        for (var fi = 0; fi < fields.length; fi++) {
          var f = fields[fi];
          var val = current[f.ini] !== undefined ? current[f.ini] : '';
          html +=
            '<div class="flex items-center gap-3">' +
            '<label class="text-xs text-muted w-40 shrink-0">' +
            esc(f.label || f.ini) +
            '</label>' +
            '<input type="text" class="gs-field input-field flex-1 text-xs py-1" data-key="' +
            esc(f.ini) +
            '" value="' +
            esc(String(val)) +
            '">' +
            '</div>';
        }
        html += '</div></div>';
      }
      html += '</div>';
      body.innerHTML = html;
    } catch (err) {
      body.textContent = t('modal_load_fail', { error: err.message });
      return;
    }

    overlay.querySelector('.srv-gs-save').addEventListener('click', async function () {
      var inputs = modal.querySelectorAll('.gs-field');
      var payload = {};
      for (var i = 0; i < inputs.length; i++) {
        var inp = inputs[i];
        var key = inp.dataset.key;
        payload[key] = inp.type === 'checkbox' ? String(inp.checked) : inp.value;
      }
      try {
        var r = await apiFetch('/api/panel/settings?server=' + encodeURIComponent(serverId), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ settings: payload }),
        });
        var d = await r.json();
        if (d.ok) {
          removeModal();
          showToast(t('gs_toast_saved'));
        } else {
          showToast(t('modal_save_fail', { error: d.error || 'Unknown error' }));
        }
      } catch (saveErr) {
        showToast(t('modal_save_fail', { error: saveErr.message }));
      }
    });
  }

  // ── Welcome Message Modal ──────────────────────

  async function openWelcome(serverId) {
    removeModal();
    var overlay = el('div', 'srv-modal-overlay');
    var modal = el('div', 'srv-modal');
    var titleHtml =
      '<div class="flex items-center justify-between mb-4">' +
      '<h3 class="text-base font-semibold text-text-bright flex items-center gap-2">' +
      '<i data-lucide="message-square" class="w-4 h-4"></i> Welcome Message' +
      '</h3>' +
      '<button class="srv-modal-close modal-close" style="position:static"><i data-lucide="x" class="w-3.5 h-3.5"></i></button>' +
      '</div>' +
      '<div id="srv-wm-body" class="text-sm text-muted">Loading\u2026</div>' +
      '<div class="flex justify-end gap-2 mt-4">' +
      '<button class="srv-wm-cancel btn-secondary text-xs px-4 py-2">Cancel</button>' +
      '<button class="srv-wm-save btn-primary text-xs px-4 py-2">Save</button>' +
      '</div>';
    modal.innerHTML = titleHtml;
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    if (window.lucide) lucide.createIcons({ nodes: [modal] });

    overlay.querySelector('.srv-modal-close').addEventListener('click', removeModal);
    overlay.querySelector('.srv-wm-cancel').addEventListener('click', removeModal);
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) removeModal();
    });

    var body = modal.querySelector('#srv-wm-body');

    try {
      var r = await apiFetch('/api/panel/welcome-file?server=' + encodeURIComponent(serverId));
      if (!r.ok) throw new Error(t('modal_load_fail', { error: r.status }));
      var d = await r.json();
      var content = (d && d.content) || '';
      var placeholders = (d && d.placeholders) || [];

      var phText = placeholders.length ? 'Placeholders: ' + placeholders.join(' ') : '';

      var wrapper = document.createElement('div');
      if (phText) {
        var phP = document.createElement('p');
        phP.className = 'text-[10px] text-muted/70 mb-2 font-mono';
        phP.textContent = phText;
        wrapper.appendChild(phP);
      }
      var textarea = document.createElement('textarea');
      textarea.id = 'srv-wm-textarea';
      textarea.className = 'input-field w-full text-xs font-mono';
      textarea.rows = 10;
      textarea.maxLength = 4000;
      textarea.style.resize = 'vertical';
      textarea.value = content;
      wrapper.appendChild(textarea);
      var hint = document.createElement('p');
      hint.className = 'text-[10px] text-muted/50 mt-1';
      hint.textContent = 'Max 4000 characters';
      wrapper.appendChild(hint);
      body.textContent = '';
      body.appendChild(wrapper);
    } catch (err) {
      body.textContent = 'Failed to load: ' + err.message;
      return;
    }

    overlay.querySelector('.srv-wm-save').addEventListener('click', async function () {
      var textarea = modal.querySelector('#srv-wm-textarea');
      var content = textarea ? textarea.value : '';
      if (content.length > 4000) {
        showToast('Content too long (max 4000 characters).');
        return;
      }
      try {
        var r = await apiFetch('/api/panel/welcome-file?server=' + encodeURIComponent(serverId), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: content }),
        });
        var d = await r.json();
        if (d.ok) {
          removeModal();
          showToast('Welcome message saved.');
        } else {
          showToast('Save failed: ' + (d.error || 'Unknown error'));
        }
      } catch (saveErr) {
        showToast('Save failed: ' + saveErr.message);
      }
    });
  }

  // ── Auto-Messages Modal ────────────────────────

  async function openAutoMessages(serverId) {
    removeModal();
    var overlay = el('div', 'srv-modal-overlay');
    var modal = el('div', 'srv-modal');
    var titleHtml =
      '<div class="flex items-center justify-between mb-4">' +
      '<h3 class="text-base font-semibold text-text-bright flex items-center gap-2">' +
      '<i data-lucide="megaphone" class="w-4 h-4"></i> Auto-Messages' +
      '</h3>' +
      '<button class="srv-modal-close modal-close" style="position:static"><i data-lucide="x" class="w-3.5 h-3.5"></i></button>' +
      '</div>' +
      '<div id="srv-am-body" class="text-sm text-muted">Loading\u2026</div>' +
      '<div class="flex items-center justify-between mt-4">' +
      '<p class="text-[10px] text-amber-400 flex items-center gap-1"><i data-lucide="alert-triangle" class="w-3 h-3"></i> Changes apply after restart</p>' +
      '<div class="flex gap-2">' +
      '<button class="srv-am-cancel btn-secondary text-xs px-4 py-2">Cancel</button>' +
      '<button class="srv-am-save btn-primary text-xs px-4 py-2">Save</button>' +
      '</div>' +
      '</div>';
    modal.innerHTML = titleHtml;
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    if (window.lucide) lucide.createIcons({ nodes: [modal] });

    overlay.querySelector('.srv-modal-close').addEventListener('click', removeModal);
    overlay.querySelector('.srv-am-cancel').addEventListener('click', removeModal);
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) removeModal();
    });

    var body = modal.querySelector('#srv-am-body');

    function makeToggleRow(inputId, labelText, checked) {
      var row = document.createElement('div');
      row.className = 'flex items-center justify-between py-2 border-b border-border/30';
      var span = document.createElement('span');
      span.className = 'text-sm';
      span.textContent = labelText;
      var lbl = document.createElement('label');
      lbl.className = 'relative inline-flex items-center cursor-pointer';
      var inp = document.createElement('input');
      inp.type = 'checkbox';
      inp.id = inputId;
      inp.className = 'sr-only peer';
      if (checked) inp.checked = true;
      var div = document.createElement('div');
      div.className = 'w-9 h-5 bg-border rounded-full relative';
      div.style.cssText = 'transition:background 0.2s';
      var knob = document.createElement('div');
      knob.className = 'absolute top-[2px] left-[2px] bg-white w-4 h-4 rounded-full';
      knob.style.cssText = 'transition:transform 0.2s';
      if (checked) {
        div.style.background = 'var(--color-accent, #7c6af7)';
        knob.style.transform = 'translateX(16px)';
      }
      inp.addEventListener('change', function () {
        div.style.background = inp.checked ? 'var(--color-accent, #7c6af7)' : '';
        knob.style.transform = inp.checked ? 'translateX(16px)' : 'translateX(0)';
      });
      div.appendChild(knob);
      lbl.appendChild(inp);
      lbl.appendChild(div);
      row.appendChild(span);
      row.appendChild(lbl);
      return row;
    }

    function makeTextRow(inputId, labelText, value) {
      var row = document.createElement('div');
      row.className = 'py-2 border-b border-border/30';
      var lbl = document.createElement('label');
      lbl.className = 'block text-xs text-muted mb-1';
      lbl.textContent = labelText;
      lbl.htmlFor = inputId;
      var inp = document.createElement('input');
      inp.type = 'text';
      inp.id = inputId;
      inp.className = 'input-field w-full text-xs';
      inp.value = value || '';
      row.appendChild(lbl);
      row.appendChild(inp);
      return row;
    }

    try {
      var r = await apiFetch('/api/panel/servers/' + encodeURIComponent(serverId) + '/auto-messages');
      var d = await r.json();
      var cfg = (d && d.data) || d || {};

      var container = document.createElement('div');
      container.className = 'space-y-0';
      container.appendChild(makeToggleRow('am-welcome-msg', 'Enable Welcome Message', !!cfg.enableWelcomeMsg));
      container.appendChild(makeToggleRow('am-welcome-file', 'Enable Welcome File', !!cfg.enableWelcomeFile));
      container.appendChild(makeToggleRow('am-link', 'Enable Auto-Message: Link', !!cfg.enableAutoMsgLink));
      container.appendChild(makeToggleRow('am-promo', 'Enable Auto-Message: Promo', !!cfg.enableAutoMsgPromo));
      container.appendChild(makeTextRow('am-link-text', 'Link Text', cfg.linkText));
      container.appendChild(makeTextRow('am-promo-text', 'Promo Text', cfg.promoText));
      container.appendChild(makeTextRow('am-discord-link', 'Discord Link', cfg.discordLink));
      body.textContent = '';
      body.appendChild(container);
    } catch (err) {
      body.textContent = 'Failed to load: ' + err.message;
      return;
    }

    overlay.querySelector('.srv-am-save').addEventListener('click', async function () {
      var payload = {
        enableWelcomeMsg: !!modal.querySelector('#am-welcome-msg').checked,
        enableWelcomeFile: !!modal.querySelector('#am-welcome-file').checked,
        enableAutoMsgLink: !!modal.querySelector('#am-link').checked,
        enableAutoMsgPromo: !!modal.querySelector('#am-promo').checked,
        linkText: modal.querySelector('#am-link-text').value,
        promoText: modal.querySelector('#am-promo-text').value,
        discordLink: modal.querySelector('#am-discord-link').value,
      };
      try {
        var r = await apiFetch('/api/panel/servers/' + encodeURIComponent(serverId) + '/auto-messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        var d = await r.json();
        if (d.ok) {
          removeModal();
          showToast('Auto-messages saved. Restart required to apply changes.');
        } else {
          showToast('Save failed: ' + (d.error || 'Unknown error'));
        }
      } catch (saveErr) {
        showToast('Save failed: ' + saveErr.message);
      }
    });
  }

  // ── Reset ──────────────────────────────────────

  function reset() {
    _inited = false;
    clearInterval(_refreshTimer);
    clearInterval(_discoveryTimer);
  }

  // ── Expose API ─────────────────────────────────

  Panel.tabs.servers = { init: init, load: load, reset: reset };
})();

/**
 * Panel Tab: Controls — server power controls and backup management.
 * @namespace Panel.tabs.controls
 */
window.Panel = window.Panel || {};
Panel.tabs = Panel.tabs || {};

(function () {
  'use strict';

  const $ = Panel.core.$;
  const el = Panel.core.el;
  const apiFetch = Panel.core.apiFetch;
  const fmtDateTime = Panel.core.utils.fmtDateTime;

  let _inited = false;

  function init() {
    if (_inited) return;
    _inited = true;

    // Bot management buttons
    const btnRestart = $('#btn-bot-restart');
    const btnReimport = $('#btn-bot-reimport');
    const btnEnvSync = $('#btn-bot-env-sync');
    const btnFactoryReset = $('#btn-bot-factory-reset');

    if (btnRestart)
      btnRestart.addEventListener('click', () => {
        if (confirm(i18next.t('web:controls.confirm_bot_restart'))) doBotAction('restart');
      });
    if (btnReimport)
      btnReimport.addEventListener('click', () => {
        if (confirm(i18next.t('web:controls.confirm_bot_reimport'))) doBotAction('reimport');
      });
    if (btnEnvSync) btnEnvSync.addEventListener('click', () => doBotAction('env_sync'));
    if (btnFactoryReset)
      btnFactoryReset.addEventListener('click', () => {
        const input = prompt(i18next.t('web:controls.confirm_factory_reset_prompt'));
        if (input && input.toUpperCase() === 'NUKE') {
          doBotAction('factory_reset', { confirm: 'NUKE' });
        }
      });
  }

  async function doPowerAction(action) {
    const log = $('#controls-log');
    const time = window.fmtTime ? window.fmtTime(new Date()) : new Date().toLocaleTimeString();
    appendLog(log, '[' + time + '] Sending ' + action + '...', 'text-muted');
    try {
      const r = await apiFetch('/api/panel/power', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: action }),
      });
      const d = await r.json();
      if (d.ok) appendLog(log, '[' + time + '] \u2713 ' + d.message, 'text-calm');
      else appendLog(log, '[' + time + '] \u2715 ' + (d.error || 'Failed'), 'text-red-400');
    } catch (e) {
      appendLog(log, '[' + time + '] \u2715 ' + e.message, 'text-red-400');
    }
  }

  async function doBotAction(action, body) {
    const log = $('#controls-log');
    const time = window.fmtTime ? window.fmtTime(new Date()) : new Date().toLocaleTimeString();
    appendLog(log, '[' + time + '] Bot action: ' + action + '...', 'text-muted');
    try {
      const opts = { method: 'POST', headers: { 'Content-Type': 'application/json' } };
      if (body) opts.body = JSON.stringify(body);
      const r = await apiFetch('/api/panel/bot-actions/' + action, opts);
      const d = await r.json();
      if (d.ok) {
        appendLog(log, '[' + time + '] \u2713 ' + action + ' initiated', 'text-calm');
      } else {
        appendLog(log, '[' + time + '] \u2715 ' + (d.error || 'Failed'), 'text-red-400');
      }
    } catch (e) {
      appendLog(log, '[' + time + '] \u2715 ' + e.message, 'text-red-400');
    }
  }

  function appendLog(container, text, cls) {
    if (!container) return;
    const placeholder = container.querySelector('.text-muted');
    if (
      placeholder &&
      (placeholder.textContent === 'No actions yet' ||
        placeholder.textContent === i18next.t('web:controls.no_actions_yet'))
    )
      placeholder.remove();
    const line = el('div', 'text-xs ' + (cls || ''));
    line.textContent = text;
    container.appendChild(line);
    container.scrollTop = container.scrollHeight;
  }

  async function loadBackupList() {
    const container = $('#backup-list');
    if (!container) return;
    try {
      const r = await apiFetch('/api/panel/backups');
      if (!r.ok) return;
      const d = await r.json();
      const backups = d.backups || [];
      if (!backups.length) {
        container.classList.add('hidden');
        return;
      }
      container.classList.remove('hidden');
      container.innerHTML = '<div class="text-[10px] text-muted uppercase tracking-wider mb-1">Recent Backups</div>';
      for (let i = 0; i < Math.min(backups.length, 10); i++) {
        const b = backups[i];
        const row = el('div', 'flex items-center justify-between text-xs py-1 border-b border-border/20');
        const dateStr = b.created ? fmtDateTime(b.created) : '-';
        const sizeStr = b.size > 0 ? formatBytes(b.size) : '';
        const sourceBadge =
          b.source === 'panel'
            ? '<span class="text-[9px] bg-accent/10 text-accent px-1 py-0.5 rounded">Panel</span>'
            : '<span class="text-[9px] bg-surface-50 text-muted px-1 py-0.5 rounded">Local</span>';
        row.innerHTML =
          '<div class="flex items-center gap-2"><span class="text-muted">' +
          dateStr +
          '</span>' +
          sourceBadge +
          '</div>' +
          '<span class="text-muted font-mono text-[10px]">' +
          sizeStr +
          '</span>';
        container.appendChild(row);
      }
    } catch (_e) {}
  }

  function formatBytes(bytes) {
    if (!bytes || bytes <= 0) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
    return (bytes / 1073741824).toFixed(2) + ' GB';
  }

  function reset() {
    _inited = false;
  }

  Panel.tabs.controls = { init: init, load: loadBackupList, reset: reset };

  // Expose doPowerAction for inline onclick handlers in panel.html
  Panel._internal = Panel._internal || {};
  Panel._internal.doPowerAction = doPowerAction;
})();

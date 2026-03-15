/**
 * Panel Tab: Console — RCON input with history and autocomplete.
 * @namespace Panel.tabs.console
 */
window.Panel = window.Panel || {};
Panel.tabs = Panel.tabs || {};

(function () {
  'use strict';

  const $ = Panel.core.$;
  const el = Panel.core.el;
  const esc = Panel.core.esc;
  const apiFetch = Panel.core.apiFetch;

  let _inited = false;

  const RCON_COMMANDS = [
    'info',
    'players',
    'save',
    'say ',
    'admin ',
    'servermsg ',
    'kick ',
    'ban ',
    'unban ',
    'whitelist ',
    'removewhitelist ',
    'addadmin ',
    'removeadmin ',
    'fetchbanned',
    'fetchwhitelist',
    'fetchadmins',
    'teleport ',
    'unstuck ',
    'giveitem ',
    'weather ',
    'season ',
    'settime ',
    'setday',
    'setnight',
    'setzombiemultiplier ',
    'setanimalmultiplier ',
    'setzombies ',
    'setanimals ',
    'restart ',
    'QuickRestart',
    'RestartNow',
    'CancelRestart',
    'shutdown ',
  ];
  let consoleHistory = [];
  let consoleHistoryIdx = -1;
  try {
    consoleHistory = JSON.parse(localStorage.getItem('hmz_console_history') || '[]');
  } catch (_e) {}

  function init() {
    if (_inited) return;
    _inited = true;

    // Wire up console autocomplete clicks
    const wrap = $('#console-autocomplete');
    if (wrap) {
      wrap.addEventListener('click', function (e) {
        const item = e.target.closest('.cmd-item');
        if (item) {
          const input = $('#rcon-input');
          if (input) input.value = item.dataset.cmd || '';
          hideConsoleAutocomplete();
        }
      });
    }
  }

  function saveConsoleHistory() {
    try {
      localStorage.setItem('hmz_console_history', JSON.stringify(consoleHistory.slice(-50)));
    } catch (_e) {}
  }

  async function sendRcon() {
    const input = $('#rcon-input');
    if (!input) return;
    const cmd = input.value.trim();
    if (!cmd) return;

    if (consoleHistory[consoleHistory.length - 1] !== cmd) consoleHistory.push(cmd);
    if (consoleHistory.length > 50) consoleHistory.shift();
    saveConsoleHistory();
    consoleHistoryIdx = -1;
    hideConsoleAutocomplete();
    appendConsole(cmd, 'cmd');
    input.value = '';
    try {
      const r = await apiFetch('/api/panel/rcon', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: cmd }),
      });
      const d = await r.json();
      if (d.ok) appendConsole(d.response || '(no response)', 'resp');
      else
        appendConsole(
          i18next.t('web:toast.error', { message: d.error || i18next.t('web:console.unknown_error') }),
          'err',
        );
    } catch (e) {
      appendConsole(i18next.t('web:console.connection_error', { message: e.message }), 'err');
    }
  }

  function handleConsoleKeydown(e) {
    const input = $('#rcon-input');
    if (!input) return;
    if (e.key === 'Enter') {
      sendRcon();
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (consoleHistory.length === 0) return;
      if (consoleHistoryIdx === -1) consoleHistoryIdx = consoleHistory.length;
      consoleHistoryIdx = Math.max(0, consoleHistoryIdx - 1);
      input.value = consoleHistory[consoleHistoryIdx] || '';
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (consoleHistoryIdx === -1) return;
      consoleHistoryIdx = Math.min(consoleHistory.length, consoleHistoryIdx + 1);
      input.value = consoleHistoryIdx < consoleHistory.length ? consoleHistory[consoleHistoryIdx] : '';
      if (consoleHistoryIdx >= consoleHistory.length) consoleHistoryIdx = -1;
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      const val = input.value.toLowerCase();
      if (!val) return;
      const match = RCON_COMMANDS.find(function (c) {
        return c.startsWith(val);
      });
      if (match) input.value = match;
      hideConsoleAutocomplete();
      return;
    }
    if (e.key === 'Escape') {
      hideConsoleAutocomplete();
      return;
    }

    setTimeout(function () {
      showConsoleAutocomplete(input.value);
    }, 0);
  }

  function showConsoleAutocomplete(val) {
    const wrap = $('#console-autocomplete');
    if (!wrap) return;
    val = (val || '').toLowerCase().trim();
    if (!val) {
      wrap.classList.add('hidden');
      return;
    }
    const matches = RCON_COMMANDS.filter(function (c) {
      return c.startsWith(val) && c !== val;
    });

    const histMatches = [];
    for (let i = consoleHistory.length - 1; i >= 0 && histMatches.length < 3; i--) {
      if (consoleHistory[i].toLowerCase().startsWith(val) && matches.indexOf(consoleHistory[i]) === -1) {
        histMatches.push(consoleHistory[i]);
      }
    }
    const all = matches.concat(histMatches);
    if (all.length === 0) {
      wrap.classList.add('hidden');
      return;
    }
    wrap.innerHTML = all
      .map(function (c) {
        return '<div class="cmd-item" data-cmd="' + esc(c) + '">' + esc(c) + '</div>';
      })
      .join('');
    wrap.classList.remove('hidden');
  }

  function hideConsoleAutocomplete() {
    const wrap = $('#console-autocomplete');
    if (wrap) wrap.classList.add('hidden');
  }

  function appendConsole(text, cls) {
    const out = $('#console-output');
    if (!out) return;
    const line = el('div', 'console-line ' + cls);
    line.textContent = text;
    out.appendChild(line);
    out.scrollTop = out.scrollHeight;
  }

  function reset() {
    _inited = false;
  }

  Panel.tabs.console = {
    init: init,
    load: function () {},
    reset: reset,
    sendRcon: sendRcon,
    handleKeydown: handleConsoleKeydown,
    appendConsole: appendConsole,
    hideAutocomplete: hideConsoleAutocomplete,
  };
})();

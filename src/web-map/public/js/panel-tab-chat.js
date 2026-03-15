/**
 * Panel Tab: Chat — searchable chat history with Discord/in-game indicators.
 * @namespace Panel.tabs.chat
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
    // One-time DOM event bindings for chat tab (search, filters)
  }

  // ── Utilities ─────────────────────────────────────────────

  /** Strip RCON color tags (<SP>, <FO>, <PN>, <PR>, <CL>, </>) from text */
  function stripRconTags(str) {
    if (!str) return '';
    return String(str)
      .replace(/<(?:PN|PR|SP|FO|CL|\/)>/g, '')
      .trim();
  }

  // ── Chat Functions ─────────────────────────────────────────

  async function loadChat() {
    const container = $('#chat-feed');
    if (!container) return;
    const search = ($('#chat-search') ? $('#chat-search').value : '').trim();
    try {
      const params = new URLSearchParams({ limit: '200' });
      if (search) params.set('search', search);
      const r = await apiFetch('/api/panel/chat?' + params);
      const d = await r.json();
      const messages = d.messages || [];
      renderChatFeed(container, messages, false);
      const countEl = $('#chat-count');
      if (countEl) countEl.textContent = messages.length + ' messages' + (search ? ' (filtered)' : '');
      container.scrollTop = container.scrollHeight;
    } catch (_e) {
      container.innerHTML = '<div class="feed-empty">' + i18next.t('web:empty_states.failed_to_load_chat') + '</div>';
    }
  }

  function renderChatFeed(container, messages, compact) {
    if (!container) return;
    if (!messages || !messages.length) {
      container.innerHTML = '<div class="feed-empty">' + i18next.t('web:empty_states.no_messages') + '</div>';
      return;
    }
    container.innerHTML = '';
    const limit = compact ? 15 : messages.length;
    const slice = messages.slice(0, limit);

    const chrono = compact ? slice : slice.slice().reverse();
    let lastDateKey = '';
    for (let i = 0; i < chrono.length; i++) {
      const m = chrono[i];

      if (!compact && m.created_at) {
        const d = new Date(m.created_at);
        const dateKey = window.fmtDate ? window.fmtDate(d) : d.toLocaleDateString();
        const timeKey = dateKey + '-' + Math.floor(d.getTime() / 1800000);
        if (timeKey !== lastDateKey) {
          const sep = el('div', 'chat-time-sep');
          let label = dateKey;
          if (i > 0) {
            label += ' \u00b7 ' + (window.fmtTime ? window.fmtTime(d) : d.toLocaleTimeString());
          }
          sep.innerHTML = '<span>' + esc(label) + '</span>';
          container.appendChild(sep);
          lastDateKey = timeKey;
        }
      }
      const msg = el('div', 'chat-msg');
      const isSystem = m.type === 'join' || m.type === 'leave' || m.type === 'death';
      const isOutbound = m.direction === 'outbound';
      const timestamp =
        !compact && m.created_at
          ? window.fmtTime
            ? window.fmtTime(new Date(m.created_at))
            : new Date(m.created_at).toLocaleTimeString()
          : '';
      const timeHtml = timestamp ? '<span class="chat-time-inline">' + timestamp + '</span>' : '';
      if (isSystem) {
        const action = m.type === 'join' ? 'joined' : m.type === 'leave' ? 'left' : 'died';
        const pLink =
          '<span class="player-link" data-steam-id="' +
          esc(m.steam_id || '') +
          '">' +
          esc(stripRconTags(m.player_name || 'Player')) +
          '</span>';
        msg.innerHTML =
          timeHtml +
          '<span class="chat-author system">System</span><span class="chat-text text-muted">' +
          pLink +
          ' ' +
          action +
          '</span>';
      } else {
        const authorCls = isOutbound ? 'outbound' : '';
        const author = isOutbound ? m.discord_user || 'Discord' : m.player_name || 'Player';
        const isAdmin = m.is_admin ? ' chat-admin' : '';
        const cleanMsg = stripRconTags(m.message || '');
        const cleanAuthor = stripRconTags(author);
        msg.innerHTML =
          timeHtml +
          '<span class="chat-author player-link' +
          isAdmin +
          ' ' +
          authorCls +
          '" data-steam-id="' +
          esc(m.steam_id || '') +
          '">' +
          esc(cleanAuthor) +
          '</span><span class="chat-text' +
          isAdmin +
          '">' +
          esc(cleanMsg) +
          '</span>';
      }
      container.appendChild(msg);
    }
  }

  async function sendChat() {
    if (S.tier < 2) return;
    const input = $('#chat-msg-input');
    if (!input) return;
    const msg = input.value.trim();
    if (!msg) return;
    try {
      await apiFetch('/api/admin/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: '[Panel] ' + (S.user ? S.user.displayName || 'Admin' : 'Admin') + ': ' + msg }),
      });
      input.value = '';
      const feed = $('#chat-feed');
      if (feed) {
        const div = el('div', 'chat-msg fade-in');
        div.innerHTML =
          '<span class="chat-author outbound">' +
          esc(S.user ? S.user.displayName || i18next.t('web:chat.you') : i18next.t('web:chat.you')) +
          '</span><span class="chat-text">' +
          esc(msg) +
          '</span>';
        feed.appendChild(div);
        feed.scrollTop = feed.scrollHeight;
      }
      setTimeout(loadChat, 2000);
    } catch (e) {
      console.error('Chat send error:', e);
    }
  }

  function reset() {
    _inited = false;
  }

  Panel.tabs.chat = { init: init, load: loadChat, send: sendChat, renderFeed: renderChatFeed, reset: reset };
})();

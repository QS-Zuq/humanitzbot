/**
 * Panel Utils — Pure utility/formatting functions used across multiple tabs.
 *
 * @namespace Panel.core.utils
 */
window.Panel = window.Panel || {};
Panel.core = Panel.core || {};

(function () {
  'use strict';

  function formatPlaytime(minutes) {
    if (!minutes) return '0m';
    if (minutes < 60) return minutes + 'm';
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m > 0 ? h + 'h ' + m + 'm' : h + 'h';
  }

  function fmtDateTime(value) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    if (window.fmtDate && window.fmtTime) return window.fmtDate(date) + ' ' + window.fmtTime(date);
    return date.toLocaleString();
  }

  function humanizeSettingKey(key) {
    if (!key) return '';
    return key
      .replace(/_/g, ' ')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .replace(/\b\w/g, function (c) {
        return c.toUpperCase();
      });
  }

  /**
   * Build 'Select a Server' empty state HTML for tabs when scope is 'all'.
   * @param {string} tabType - Tab name (map, players, chat, activity, timeline)
   * @returns {string} HTML string
   */
  function scopeEmptyState(tabType) {
    var hintKey = 'web:empty_states.' + tabType + '_hint';
    var fallback = i18next.t('web:empty_states.select_hint');
    return (
      '<div class="flex flex-col items-center justify-center py-16 text-center">' +
      '<i data-lucide="server" class="w-10 h-10 text-muted/30 mb-4"></i>' +
      '<p class="text-sm text-muted font-medium">' +
      Panel.core.esc(i18next.t('web:empty_states.select_server')) +
      '</p>' +
      '<p class="text-xs text-muted/50 mt-1">' +
      Panel.core.esc(i18next.t(hintKey, { defaultValue: fallback })) +
      '</p>' +
      '</div>'
    );
  }

  /**
   * Show/hide an "unavailable" placeholder over a tab without destroying its DOM.
   * @param {string} tabId - e.g. 'tab-chat', 'tab-players'
   * @param {boolean} show - true to show placeholder, false to restore tab
   * @param {string} [message] - optional message text
   */
  function setTabUnavailable(tabId, show, message) {
    var tab = document.getElementById(tabId);
    if (!tab) return;

    var placeholderId = tabId + '-unavailable';
    var existing = document.getElementById(placeholderId);

    if (show) {
      // Hide all direct children
      for (var i = 0; i < tab.children.length; i++) {
        if (tab.children[i].id !== placeholderId) {
          tab.children[i].style.display = 'none';
        }
      }
      // Create or show placeholder
      if (!existing) {
        var div = document.createElement('div');
        div.id = placeholderId;
        div.className = 'feed-empty';
        div.style.marginTop = '4rem';
        div.textContent =
          message || i18next.t('web:common.select_server', { defaultValue: 'Select a server to view this tab' });
        tab.appendChild(div);
      } else {
        existing.style.display = '';
        if (message) existing.textContent = message;
      }
    } else {
      // Restore children
      for (var i = 0; i < tab.children.length; i++) {
        if (tab.children[i].id !== placeholderId) {
          tab.children[i].style.display = '';
        }
      }
      // Hide placeholder
      if (existing) existing.style.display = 'none';
    }
  }

  // ── Expose API ────────────────────────────────────

  Panel.core.utils = {
    toI18nSnakeCase: Panel.core.toI18nSnakeCase,
    fmtDateTime: fmtDateTime,
    formatPlaytime: formatPlaytime,
    humanizeSettingKey: humanizeSettingKey,
    scopeEmptyState: scopeEmptyState,
    setTabUnavailable: setTabUnavailable,
  };
})();

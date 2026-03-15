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

  // ── Expose API ────────────────────────────────────

  Panel.core.utils = {
    toI18nSnakeCase: Panel.core.toI18nSnakeCase,
    fmtDateTime: fmtDateTime,
    formatPlaytime: formatPlaytime,
    humanizeSettingKey: humanizeSettingKey,
  };
})();

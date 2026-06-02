/**
 * Panel Tab: Settings — game settings, bot config (.env), schedule editor, and welcome file editor.
 * @namespace Panel.tabs.settings
 */
window.Panel = window.Panel || {};
Panel.tabs = Panel.tabs || {};

(function () {
  'use strict';

  const S = Panel.core.S;
  const $ = Panel.core.$;
  const $$ = Panel.core.$$;
  const el = Panel.core.el;
  const esc = Panel.core.esc;
  const apiFetch = Panel.core.apiFetch;
  const ENV_BOOLEANS = Panel.core.ENV_BOOLEANS;
  const getSettingCategories = Panel.core.getSettingCategories;
  const getSettingDescs = Panel.core.getSettingDescs;
  const getEnvDescs = Panel.core.getEnvDescs;
  const humanizeSettingKey = Panel.core.utils.humanizeSettingKey;
  const showToast = Panel.core.utils.showToast;
  var getCssColor = Panel.core.getCssColor;

  let _inited = false;

  function attrEsc(value) {
    return esc(value).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  const RELOAD_STRATEGY_BADGE_STYLES = {
    live: 'color:var(--color-calm, #6dba82);border-color:rgba(109,186,130,0.2);background:rgba(109,186,130,0.08)',
    'module-reconfigure':
      'color:var(--color-accent, #78a8ff);border-color:rgba(120,168,255,0.2);background:rgba(120,168,255,0.08)',
    'module-restart':
      'color:var(--color-surge, #d4a843);border-color:rgba(212,168,67,0.2);background:rgba(212,168,67,0.08)',
    'connection-reconnect':
      'color:var(--color-accent, #78a8ff);border-color:rgba(120,168,255,0.2);background:rgba(120,168,255,0.08)',
    'bot-restart': 'color:var(--color-horde, #c45a4a);border-color:rgba(196,90,74,0.2);background:rgba(196,90,74,0.08)',
    'game-restart':
      'color:var(--color-horde, #c45a4a);border-color:rgba(196,90,74,0.2);background:rgba(196,90,74,0.08)',
  };

  const COMMON_TIMEZONE_VALUES = [
    'UTC',
    'Etc/UTC',
    'Asia/Taipei',
    'Asia/Tokyo',
    'Asia/Seoul',
    'Asia/Hong_Kong',
    'Asia/Singapore',
    'Asia/Shanghai',
    'Asia/Bangkok',
    'Asia/Jakarta',
    'Asia/Kolkata',
    'Australia/Sydney',
    'Europe/London',
    'Europe/Berlin',
    'Europe/Paris',
    'America/New_York',
    'America/Chicago',
    'America/Denver',
    'America/Los_Angeles',
    'America/Sao_Paulo',
  ];

  function normalizeTimezoneSearch(value) {
    return String(value || '')
      .toLowerCase()
      .replace(/[_/,-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function compactTimezoneSearch(value) {
    return normalizeTimezoneSearch(value).replace(/[\s:]+/g, '');
  }

  function getTimezoneOffsetMinutes(zone, date) {
    if (!zone || typeof Intl === 'undefined' || typeof Intl.DateTimeFormat !== 'function') return null;
    try {
      var at = date instanceof Date ? date : new Date();
      var parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: zone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      }).formatToParts(at);
      var getPart = function (type, fallback) {
        var part = parts.find(function (p) {
          return p.type === type;
        });
        return part ? part.value : fallback;
      };
      var hour = getPart('hour', '00');
      if (hour === '24') hour = '00';
      var asUtc = Date.UTC(
        parseInt(getPart('year', '1970'), 10),
        parseInt(getPart('month', '01'), 10) - 1,
        parseInt(getPart('day', '01'), 10),
        parseInt(hour, 10),
        parseInt(getPart('minute', '00'), 10),
        parseInt(getPart('second', '00'), 10),
      );
      return Math.round((asUtc - at.getTime()) / 60000);
    } catch (_err) {
      return null;
    }
  }

  function formatUtcOffset(minutes) {
    if (typeof minutes !== 'number' || !Number.isFinite(minutes)) return '';
    var sign = minutes >= 0 ? '+' : '-';
    var abs = Math.abs(minutes);
    var hours = Math.floor(abs / 60);
    var mins = abs % 60;
    return 'UTC' + sign + String(hours).padStart(2, '0') + ':' + String(mins).padStart(2, '0');
  }

  function timezoneOffsetAliases(offsetLabel) {
    var aliases = [offsetLabel];
    var match = String(offsetLabel || '').match(/^UTC([+-])(\d{2}):(\d{2})$/);
    if (!match) return aliases;
    var sign = match[1];
    var hours = match[2];
    var minutes = match[3];
    var hourNumber = String(parseInt(hours, 10));
    aliases.push('GMT' + sign + hours + ':' + minutes);
    aliases.push('UTC' + sign + hours + minutes);
    aliases.push('GMT' + sign + hours + minutes);
    aliases.push(sign + hours + ':' + minutes);
    aliases.push(sign + hours + minutes);
    if (minutes === '00') {
      aliases.push('UTC' + sign + hourNumber);
      aliases.push('GMT' + sign + hourNumber);
      aliases.push(sign + hourNumber);
    }
    return aliases;
  }

  function buildTimezoneOption(value, date) {
    var zone = String(value || '').trim();
    var pieces = zone.split('/');
    var city = (pieces[pieces.length - 1] || zone).replace(/_/g, ' ');
    var region = pieces.length > 1 ? pieces[0] : 'UTC';
    var offset = formatUtcOffset(getTimezoneOffsetMinutes(zone, date));
    var label = offset ? zone + ' — ' + offset : zone;
    var searchParts = [zone, zone.replace(/_/g, ' '), city, region, label].concat(timezoneOffsetAliases(offset));
    var searchText = normalizeTimezoneSearch(searchParts.join(' '));
    return {
      value: zone,
      label: label,
      city: city,
      region: region,
      offset: offset,
      searchText: searchText,
      searchCompact: searchText.replace(/[\s:]+/g, ''),
    };
  }

  function buildTimezoneOptions(values, date) {
    var seen = {};
    var entries = [];
    var source = Array.isArray(values) ? values : [];
    for (var i = 0; i < source.length; i++) {
      var zone = String(source[i] || '').trim();
      if (!zone || seen[zone]) continue;
      seen[zone] = true;
      entries.push(buildTimezoneOption(zone, date));
    }
    return entries;
  }

  function sortTimezoneOptionsForQuery(options, query) {
    var q = normalizeTimezoneSearch(query);
    var commonRank = {};
    for (var i = 0; i < COMMON_TIMEZONE_VALUES.length; i++) commonRank[COMMON_TIMEZONE_VALUES[i]] = i + 1;
    return options.slice().sort(function (a, b) {
      if (q) {
        var aExact = normalizeTimezoneSearch(a.value) === q || normalizeTimezoneSearch(a.city) === q ? 0 : 1;
        var bExact = normalizeTimezoneSearch(b.value) === q || normalizeTimezoneSearch(b.city) === q ? 0 : 1;
        if (aExact !== bExact) return aExact - bExact;
      } else {
        var ar = commonRank[a.value] || 9999;
        var br = commonRank[b.value] || 9999;
        if (ar !== br) return ar - br;
      }
      return a.value.localeCompare(b.value);
    });
  }

  function timezoneOptionMatchesQuery(option, query) {
    var q = normalizeTimezoneSearch(query);
    if (!q) return true;
    var compact = compactTimezoneSearch(query);
    return option.searchText.includes(q) || (compact && option.searchCompact.includes(compact));
  }

  function init() {
    if (_inited) return;
    _inited = true;
  }

  // ══════════════════════════════════════════════════════════════════
  //  Game Settings
  // ══════════════════════════════════════════════════════════════════

  async function loadSettings() {
    const container = $('#settings-grid');
    if (!container) return;
    try {
      const r = await apiFetch('/api/panel/settings');
      if (!r.ok) {
        container.innerHTML =
          '<div class="feed-empty">' + i18next.t('web:empty_states.settings_unavailable') + '</div>';
        return;
      }
      const d = await r.json();
      const settings = d.settings || {};
      S.settingsOriginal = Object.assign({}, settings);
      S.settingsChanged = {};
      renderSettingsCategories(container, settings);
      const countEl = $('#settings-count');
      if (countEl) countEl.textContent = Object.keys(settings).length + ' settings';
    } catch (_e) {
      container.innerHTML =
        '<div class="feed-empty">' + i18next.t('web:empty_states.failed_to_load_settings') + '</div>';
    }
  }

  function renderSettingsCategories(container, settings) {
    container.innerHTML = '';
    const assigned = {};
    const categories = [];

    const settingCategories = getSettingCategories();
    const settingDescs = getSettingDescs();
    for (const catName in settingCategories) {
      if (!settingCategories.hasOwnProperty(catName)) continue;
      const keys = settingCategories[catName];
      const items = [];
      for (let ki = 0; ki < keys.length; ki++) {
        if (keys[ki] in settings) {
          items.push({ key: keys[ki], value: settings[keys[ki]] });
          assigned[keys[ki]] = true;
        }
      }
      if (items.length) categories.push({ name: catName, items: items });
    }

    const other = [];
    for (const key in settings) {
      if (!settings.hasOwnProperty(key)) continue;
      if (!assigned[key]) other.push({ key: key, value: settings[key] });
    }
    if (other.length)
      categories.push({ name: i18next.t('web:settings.other', { defaultValue: 'Other' }), items: other });

    for (let ci = 0; ci < categories.length; ci++) {
      const cat = categories[ci];
      const section = el('div', 'settings-category');
      const header = el('div', 'settings-category-header');
      header.innerHTML =
        '<span class="cat-arrow">\u25B8</span><span class="cat-label">' +
        cat.name +
        '</span><span class="cat-count">' +
        cat.items.length +
        '</span>';

      const body = el('div', 'settings-category-items');
      for (let ii = 0; ii < cat.items.length; ii++) {
        const item = cat.items[ii];
        const row = el('div', 'setting-row');
        row.dataset.key = item.key;
        const desc = settingDescs[item.key] || '';
        row.innerHTML =
          '<div class="setting-name">' +
          esc(humanizeSettingKey(item.key)) +
          '</div>' +
          (desc ? '<div class="setting-desc">' + esc(desc) + '</div>' : '') +
          '<input type="text" class="setting-input" value="' +
          esc(String(item.value)) +
          '" data-key="' +
          esc(item.key) +
          '" data-original="' +
          esc(String(item.value)) +
          '">';
        body.appendChild(row);
      }

      (function (bodyEl, headerEl) {
        headerEl.addEventListener('click', function () {
          bodyEl.classList.toggle('open');
          headerEl.querySelector('.cat-arrow').classList.toggle('open');
        });
      })(body, header);

      if (ci === 0) {
        body.classList.add('open');
        header.querySelector('.cat-arrow').classList.add('open');
      }

      section.appendChild(header);
      section.appendChild(body);
      container.appendChild(section);
    }

    container.addEventListener('input', function (e) {
      if (!e.target.classList.contains('setting-input')) return;
      let key = e.target.dataset.key;
      const orig = e.target.dataset.original;
      const val = e.target.value;
      if (val !== orig) {
        S.settingsChanged[key] = val;
        e.target.classList.add('changed');
      } else {
        delete S.settingsChanged[key];
        e.target.classList.remove('changed');
      }

      const changeCount = Object.keys(S.settingsChanged).length;
      const hasChanges = changeCount > 0;
      const btn = $('#settings-save-btn');
      if (btn) {
        btn.disabled = !hasChanges;
        btn.classList.toggle('opacity-50', !hasChanges);
        btn.classList.toggle('cursor-not-allowed', !hasChanges);
      }
      const countBadge = $('#settings-change-count');
      if (countBadge) {
        countBadge.classList.toggle('hidden', !hasChanges);
        countBadge.textContent = changeCount + ' change' + (changeCount !== 1 ? 's' : '');
      }
      const resetBtn = $('#settings-reset-btn');
      if (resetBtn) resetBtn.classList.toggle('hidden', !hasChanges);
    });
  }

  function filterSettings() {
    const q = ($('#settings-search') ? $('#settings-search').value : '').toLowerCase();
    $$('.setting-row').forEach(function (row) {
      let key = (row.dataset.key || '').toLowerCase();
      const nameEl = row.querySelector('.setting-name');
      const descEl = row.querySelector('.setting-desc');
      const name = nameEl ? nameEl.textContent.toLowerCase() : '';
      const desc = descEl ? descEl.textContent.toLowerCase() : '';
      row.style.display = key.includes(q) || name.includes(q) || desc.includes(q) ? '' : 'none';
    });
    $$('.settings-category').forEach(function (cat) {
      const visibleRows = cat.querySelectorAll('.setting-row:not([style*="display: none"])');
      cat.style.display = visibleRows.length ? '' : 'none';
      if (q && visibleRows.length) {
        const items = cat.querySelector('.settings-category-items');
        if (items) items.classList.add('open');
        const arrow = cat.querySelector('.cat-arrow');
        if (arrow) arrow.classList.add('open');
      }
    });
  }

  function showSettingsDiff() {
    const changed = S.settingsMode === 'bot' ? S.botConfigChanged : S.settingsChanged;
    const originals = S.settingsMode === 'bot' ? S.botConfigOriginal : S.settingsOriginal;
    const keys = Object.keys(changed);
    if (keys.length === 0) return;

    let content = $('#settings-diff-content');
    if (!content) return;
    content.innerHTML = '';

    const catOrder = {};
    let orderIdx = 0;
    const settingCategories = getSettingCategories();
    for (const catName in settingCategories) {
      if (!settingCategories.hasOwnProperty(catName)) continue;
      const catKeys = settingCategories[catName];
      for (let ci = 0; ci < catKeys.length; ci++) {
        catOrder[catKeys[ci]] = orderIdx++;
      }
    }
    keys.sort(function (a, b) {
      const oa = catOrder[a] != null ? catOrder[a] : 9999;
      const ob = catOrder[b] != null ? catOrder[b] : 9999;
      return oa - ob;
    });

    for (let i = 0; i < keys.length; i++) {
      let key = keys[i];
      const oldVal = originals[key] != null ? String(originals[key]) : '';
      const newVal = changed[key];
      const isSensitive = S.settingsMode === 'bot' && !oldVal && newVal;
      const displayOld = isSensitive ? '(hidden)' : oldVal;
      const displayNew = isSensitive ? '(updated)' : newVal;
      const row = el('div', 'diff-row');
      const descKey = S.settingsMode === 'bot' ? key : humanizeSettingKey(key);
      row.innerHTML =
        '<div class="diff-key">' +
        esc(descKey) +
        '<div class="diff-key-raw">' +
        esc(key) +
        '</div></div>' +
        '<div class="diff-values">' +
        '<span class="diff-old">' +
        esc(displayOld) +
        '</span>' +
        '<span class="diff-arrow">\u2192</span>' +
        '<span class="diff-new">' +
        esc(String(displayNew)) +
        '</span>' +
        '</div>';
      content.appendChild(row);
    }

    const modal = $('#settings-diff-modal');
    if (modal) modal.classList.remove('hidden');

    if (window.lucide) lucide.createIcons();
  }

  function resetSettingsChanges() {
    if (S.settingsMode === 'bot') return resetBotConfigChanges();

    const keys = Object.keys(S.settingsChanged);
    for (let i = 0; i < keys.length; i++) {
      let input = $('input[data-key="' + keys[i] + '"]');
      if (input) {
        input.value = input.dataset.original;
        input.classList.remove('changed');
      }
    }
    S.settingsChanged = {};
    const btn = $('#settings-save-btn');
    if (btn) {
      btn.disabled = true;
      btn.classList.add('opacity-50', 'cursor-not-allowed');
    }
    const countBadge = $('#settings-change-count');
    if (countBadge) countBadge.classList.add('hidden');
    const resetBtn = $('#settings-reset-btn');
    if (resetBtn) resetBtn.classList.add('hidden');
  }

  async function commitSettings() {
    if (S.settingsMode === 'bot') return commitBotConfig();
    if (Object.keys(S.settingsChanged).length === 0) return;
    const btn = $('#settings-save-btn');
    if (btn) {
      btn.disabled = true;
      btn.textContent = i18next.t('web:schedule_editor.saving');
    }
    try {
      const r = await apiFetch('/api/panel/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: S.settingsChanged }),
      });
      const d = await r.json();
      if (d.ok) {
        const updated = d.updated || [];
        for (let ui = 0; ui < updated.length; ui++) {
          let key = updated[ui];
          S.settingsOriginal[key] = S.settingsChanged[key];
          let input = $('input[data-key="' + key + '"]');
          if (input) {
            input.dataset.original = S.settingsChanged[key];
            input.classList.remove('changed');
          }
        }
        S.settingsChanged = {};
        if (btn) btn.textContent = i18next.t('web:schedule_editor.saved') + ' ✓';
        const countBadge = $('#settings-change-count');
        if (countBadge) countBadge.classList.add('hidden');
        const resetBtn = $('#settings-reset-btn');
        if (resetBtn) resetBtn.classList.add('hidden');
        setTimeout(function () {
          if (btn) {
            btn.textContent = i18next.t('web:settings.save_changes');
            btn.disabled = true;
            btn.classList.add('opacity-50', 'cursor-not-allowed');
          }
        }, 2000);
      } else throw new Error(d.error || i18next.t('web:toast.save_failed'));
    } catch (e) {
      if (btn) {
        btn.textContent = i18next.t('web:dashboard.error');
        btn.disabled = false;
      }
      console.error('Settings save error:', e);
      setTimeout(function () {
        if (btn) btn.textContent = i18next.t('web:settings.save_changes');
      }, 2000);
    }
  }

  // ══════════════════════════════════════════════════════════════════
  //  Bot Configuration (.env editor)
  // ══════════════════════════════════════════════════════════════════

  // Server-scoped category IDs — hidden when scope is "all"
  var SERVER_SCOPED_CATS = {
    credentials: 1,
    sftp: 1,
    sftp_paths: 1,
    agent: 1,
    channels: 1,
    restart_schedule: 1,
    server_advanced: 1,
  };

  async function loadBotConfig() {
    var container = $('#settings-grid');
    if (!container) return;
    try {
      var r = await apiFetch('/api/panel/bot-config');
      if (!r.ok) {
        container.innerHTML =
          '<div class="feed-empty">' + i18next.t('web:empty_states.bot_configuration_unavailable') + '</div>';
        return;
      }
      var d = await r.json();
      var allSections = d.sections || [];

      // ── Scope filtering: when 'all', show only app-global categories ──
      var sections = allSections;
      if (S.currentServer === 'all') {
        sections = [];
        for (var fi = 0; fi < allSections.length; fi++) {
          if (!allSections[fi].id || !SERVER_SCOPED_CATS[allSections[fi].id]) {
            sections.push(allSections[fi]);
          }
        }
      }

      S.botConfigGroups = d.groups || [];
      S.botConfigOptionSets = d.optionSets || {};
      S.botConfigSections = sections;
      S.botConfigOriginal = {};
      S.botConfigChanged = {};
      for (var si = 0; si < S.botConfigSections.length; si++) {
        var sec = S.botConfigSections[si];
        for (var ki = 0; ki < sec.keys.length; ki++) {
          var k = sec.keys[ki];
          S.botConfigOriginal[k.key] = k.value;
        }
      }

      // Render banner + filtered sections
      container.innerHTML = '';
      if (S.currentServer === 'all') {
        var banner = el(
          'div',
          'flex items-center gap-2 text-xs px-3 py-2 rounded-lg border bg-accent/5 border-accent/20 text-accent mb-3',
        );
        banner.innerHTML =
          '<i data-lucide="info" class="w-3.5 h-3.5 shrink-0"></i><span>' +
          esc(i18next.t('web:settings.scope_banner_global')) +
          '</span>';
        container.appendChild(banner);
      }

      renderBotConfig(container, S.botConfigSections, S.botConfigGroups, S.botConfigOptionSets);
      var countEl = $('#settings-count');
      var total = S.botConfigSections.reduce(function (sum, s) {
        return sum + s.keys.length;
      }, 0);
      if (countEl) countEl.textContent = total + ' settings';
      if (S.botConfigFilterRefresh) S.botConfigFilterRefresh();
      var btn = $('#settings-save-btn');
      if (btn) {
        btn.disabled = true;
        btn.classList.add('opacity-50', 'cursor-not-allowed');
      }
      var countBadge = $('#settings-change-count');
      if (countBadge) countBadge.classList.add('hidden');
      var resetBtn = $('#settings-reset-btn');
      if (resetBtn) resetBtn.classList.add('hidden');
      var restartBadge = $('#settings-restart-badge');
      if (restartBadge) restartBadge.classList.add('hidden');
      if (window.lucide) lucide.createIcons({ attrs: { class: '' } });
    } catch (e) {
      container.innerHTML =
        '<div class="feed-empty">' + i18next.t('web:empty_states.failed_to_load_bot_configuration') + '</div>';
      console.error('Bot config error:', e);
    }
  }

  function renderBotConfig(container, sections, groups, optionSets) {
    // Keep existing banner if any, else clear
    var banner = container.querySelector('.bg-accent\\/5');
    container.innerHTML = '';
    if (banner) container.appendChild(banner);

    // Use the existing header search bar (#settings-search) instead of a duplicate inline search

    // ── 2. Group Sections ──
    groups = groups || [];
    optionSets = optionSets || {};
    var activeFilters = {};
    var sectionById = {};
    for (var i = 0; i < sections.length; i++) {
      if (sections[i].id) sectionById[sections[i].id] = sections[i];
    }

    var renderedSectionIds = {};
    var envDescs = getEnvDescs();

    function reloadStrategyBadge(strategy, reasonKey) {
      if (!strategy) return '';
      var normalized = String(strategy).replace(/-/g, '_');
      var label = i18next.t('web:settings.reload_strategy.' + normalized, { defaultValue: strategy });
      var title = i18next.t('web:' + (reasonKey || 'settings.reload_strategy_desc.' + normalized), {
        defaultValue: '',
      });
      var style = RELOAD_STRATEGY_BADGE_STYLES[strategy] || RELOAD_STRATEGY_BADGE_STYLES['bot-restart'];
      return (
        ' <span class="setting-sensitive-badge" data-reload-strategy="' +
        attrEsc(strategy) +
        '" style="' +
        attrEsc(style) +
        '"' +
        (title ? ' title="' + attrEsc(title) + '"' : '') +
        '>' +
        esc(label) +
        '</span>'
      );
    }

    function controlAttrs(item, extraAttrs) {
      var optionValues = Array.isArray(item.options)
        ? item.options.map(function (option) {
            return typeof option === 'string' ? option : option.value;
          })
        : [];
      var attrs =
        ' class="setting-input bot-config-input bot-config-control" data-key="' +
        attrEsc(item.key) +
        '" data-original="' +
        attrEsc(item.value || '') +
        '" data-control="' +
        attrEsc(item.control || 'text') +
        '"';
      if (item.validator) attrs += ' data-validator="' + attrEsc(item.validator) + '"';
      if (item.valueType) attrs += ' data-value-type="' + attrEsc(item.valueType) + '"';
      if (item.singleLine) attrs += ' data-single-line="true"';
      if (item.sensitive) attrs += ' data-sensitive="true"';
      if (item.required) attrs += ' data-required="true"';
      if (item.freeform) attrs += ' data-freeform="true"';
      if (optionValues.length) attrs += ' data-options="' + attrEsc(JSON.stringify(optionValues)) + '"';
      return attrs + (extraAttrs || '');
    }

    function renderSelectControl(item) {
      var options = Array.isArray(item.options) ? item.options : [];
      var html = '<select' + controlAttrs(item, '') + '>';
      var current = item.value == null ? '' : String(item.value);
      var hasCurrent = false;
      html +=
        '<option value=""' +
        (current === '' ? ' selected' : '') +
        '>' +
        esc(i18next.t('web:settings.empty_option', { defaultValue: 'Not set' })) +
        '</option>';
      for (var oi = 0; oi < options.length; oi++) {
        var opt = options[oi];
        var value = typeof opt === 'string' ? opt : opt.value;
        var label = typeof opt === 'string' ? opt : opt.label || opt.value;
        if (value === current) hasCurrent = true;
        html +=
          '<option value="' +
          attrEsc(value) +
          '"' +
          (value === current ? ' selected' : '') +
          (opt && opt.deprecated ? ' data-deprecated="true"' : '') +
          '>' +
          esc(label) +
          '</option>';
      }
      if (current && !hasCurrent) {
        html += '<option value="' + attrEsc(current) + '" selected>' + esc(current) + '</option>';
      }
      html += '</select>';
      return html;
    }

    function renderComboboxControl(item) {
      var setName = item.optionSet || '';
      var values = optionSets[setName] || [];
      if (item.validator === 'timezone') return renderTimezoneComboboxControl(item, values);
      var listId = 'bot-config-options-' + item.key;
      var controlItem = Object.assign({}, item, { options: values });
      var html =
        '<input type="text" list="' +
        attrEsc(listId) +
        '"' +
        controlAttrs(controlItem, ' value="' + attrEsc(item.value || '') + '" autocomplete="off"') +
        '>';
      html += '<datalist id="' + attrEsc(listId) + '">';
      for (var zi = 0; zi < values.length; zi++) {
        html += '<option value="' + attrEsc(values[zi]) + '"></option>';
      }
      html += '</datalist>';
      return html;
    }

    function renderTimezoneComboboxControl(item, values) {
      var listId = 'bot-config-options-' + item.key;
      var controlItem = Object.assign({}, item, { options: values });
      var placeholder = i18next.t('web:settings.timezone_placeholder', {
        defaultValue: 'Search city, region, or UTC offset...',
      });
      var showOptions = i18next.t('web:settings.timezone_show_options', {
        defaultValue: 'Show timezone options',
      });
      return (
        '<div class="bot-config-combobox" data-key="' +
        attrEsc(item.key) +
        '">' +
        '<div class="bot-config-combobox-shell">' +
        '<input type="text"' +
        controlAttrs(
          controlItem,
          ' value="' +
            attrEsc(item.value || '') +
            '" autocomplete="off" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="' +
            attrEsc(listId) +
            '" placeholder="' +
            attrEsc(placeholder) +
            '"',
        ) +
        '>' +
        '<button type="button" class="bot-config-combobox-toggle" aria-label="' +
        attrEsc(showOptions) +
        '" title="' +
        attrEsc(showOptions) +
        '"><i data-lucide="chevron-down" class="w-3.5 h-3.5"></i></button>' +
        '</div>' +
        '<div id="' +
        attrEsc(listId) +
        '" class="bot-config-combobox-list hidden" role="listbox"></div>' +
        '<div class="setting-help text-xs text-muted mt-1">' +
        esc(
          i18next.t('web:settings.timezone_hint', {
            defaultValue: 'Stores IANA names; search by city, region, or UTC offset.',
          }),
        ) +
        '</div>' +
        '</div>'
      );
    }

    function renderBotConfigControl(item) {
      var control = item.control || (ENV_BOOLEANS.has(item.key) ? 'toggle' : 'text');
      var supportedControls = {
        readonly: true,
        password: true,
        toggle: true,
        select: true,
        combobox: true,
        textarea: true,
        time: true,
        number: true,
        url: true,
        text: true,
      };
      if (!supportedControls[control]) {
        console.warn('[SETTINGS] Unknown bot-config control type:', control, item.key);
        control = 'text';
      }
      if (item.readOnly || control === 'readonly') {
        return '<span class="text-xs text-muted font-mono">' + esc(item.value || '-') + '</span>';
      }
      if (item.sensitive || control === 'password') {
        var secretHtml = '<div class="flex items-center gap-2">';
        if (item.hasValue)
          secretHtml +=
            '<span class="text-xs text-calm font-mono">\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022 <i data-lucide="check" class="w-3 h-3 inline"></i> ' +
            esc(i18next.t('web:settings.secret_set')) +
            '</span>';
        else
          secretHtml +=
            '<span class="text-xs text-red-400/70">' + esc(i18next.t('web:settings.secret_not_set')) + '</span>';
        secretHtml +=
          '<input type="password"' +
          controlAttrs(
            Object.assign({}, item, { control: 'password', value: '' }),
            ' style="width:180px" placeholder="Enter new value..." autocomplete="off"',
          ) +
          '>';
        return secretHtml + '</div>';
      }
      if (control === 'toggle') {
        var isOn = item.value === 'true';
        return (
          '<label class="setting-toggle"><input type="checkbox" class="bot-config-toggle bot-config-control" data-key="' +
          attrEsc(item.key) +
          '" data-original="' +
          attrEsc(item.value) +
          '" data-control="toggle"' +
          (isOn ? ' checked' : '') +
          '><span class="toggle-track"></span><span class="toggle-thumb"></span></label>'
        );
      }
      if (control === 'select') return renderSelectControl(item);
      if (control === 'combobox') return renderComboboxControl(item);
      if (control === 'textarea') {
        var hint = item.singleLine
          ? '<div class="setting-help text-xs text-muted mt-1">' +
            esc(
              i18next.t('web:settings.validation.single_line_json_hint', { defaultValue: 'Single-line JSON only.' }),
            ) +
            '</div>'
          : '';
        return (
          '<textarea' +
          controlAttrs(item, ' rows="' + attrEsc(item.rows || 3) + '"') +
          '>' +
          esc(item.value || '') +
          '</textarea>' +
          hint
        );
      }
      var inputType =
        control === 'time' ? 'time' : control === 'number' ? 'number' : control === 'url' ? 'url' : 'text';
      var extra =
        ' value="' +
        attrEsc(item.value || '') +
        '"' +
        (item.inputMode ? ' inputmode="' + attrEsc(item.inputMode) + '"' : '') +
        (item.min != null ? ' min="' + attrEsc(item.min) + '"' : '') +
        (item.max != null ? ' max="' + attrEsc(item.max) + '"' : '');
      return '<input type="' + attrEsc(inputType) + '"' + controlAttrs(item, extra) + '>';
    }

    // Helper to render a single section (category)
    function renderSection(sec, groupId) {
      if (!sec || !sec.keys.length) return null;
      var sectionEl = el('div', 'settings-category mb-2');
      sectionEl.dataset.sectionId = sec.id || '';
      sectionEl.dataset.sectionLabel = (sec.label || '').toLowerCase();

      var header = el(
        'div',
        'settings-section-label text-xs font-medium text-muted uppercase tracking-wider mt-3 mb-1 px-1',
      );
      header.innerHTML =
        '<span class="cat-label">' + esc(sec.label) + '</span><span class="cat-count">' + sec.keys.length + '</span>';

      var body = el('div', 'settings-category-items open');
      for (var ki = 0; ki < sec.keys.length; ki++) {
        var item = sec.keys[ki];
        var row = el('div', 'setting-row' + (item.commented ? ' setting-commented' : ''));
        row.dataset.key = item.key;
        row.dataset.reloadStrategy = item.reloadStrategy || '';
        row.dataset.control = item.control || '';
        row.dataset.validator = item.validator || '';
        row.dataset.sensitive = item.sensitive ? 'true' : 'false';
        row.dataset.groupId = groupId || '';
        row.dataset.advanced =
          groupId === 'advanced' || (sec.id && (sec.id.indexOf('advanced') >= 0 || sec.id === 'intervals'))
            ? 'true'
            : 'false';
        var desc = envDescs[item.key] || '';
        row.dataset.desc = desc.toLowerCase();

        var nameHtml = '<div class="setting-name">' + esc(humanizeEnvKey(item.key));
        if (item.sensitive) nameHtml += ' <span class="setting-sensitive-badge">secret</span>';
        if (item.readOnly)
          nameHtml +=
            ' <span class="setting-sensitive-badge" style="color:var(--color-surge, #d4a843);border-color:rgba(212,168,67,0.15);background:rgba(212,168,67,0.08)">' +
            esc(i18next.t('web:settings.read_only')) +
            '</span>';
        nameHtml += reloadStrategyBadge(item.reloadStrategy, item.reloadStrategyReasonKey);
        nameHtml += '<div class="setting-env-key">' + esc(item.key) + '</div></div>';

        var inputHtml = renderBotConfigControl(item);

        row.innerHTML =
          nameHtml +
          (desc ? '<div class="setting-desc">' + esc(desc) + '</div>' : '') +
          inputHtml +
          '<div class="setting-error text-xs text-horde mt-1 hidden"></div>';
        body.appendChild(row);
      }

      sectionEl.appendChild(header);

      // Add SFTP discovery button for sftp_paths category
      if (sec.id === 'sftp_paths') {
        var discoverBtn = el(
          'button',
          'text-xs px-3 py-1.5 rounded bg-accent/20 text-accent hover:bg-accent/30 transition-colors flex items-center gap-1.5 mt-2 mb-1',
        );
        discoverBtn.innerHTML =
          '<i data-lucide="search" class="w-3 h-3"></i> ' + esc(i18next.t('web:settings.discover_paths'));
        discoverBtn.addEventListener('click', async function () {
          discoverBtn.disabled = true;
          discoverBtn.innerHTML =
            '<i data-lucide="loader-2" class="w-3 h-3 animate-spin"></i> ' + esc(i18next.t('web:settings.discovering'));
          if (window.lucide) lucide.createIcons({ nodes: [discoverBtn] });
          try {
            // Use server's existing SFTP config (includes password/key from config singleton)
            var r = await apiFetch('/api/panel/servers/discover', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ useCurrentConfig: true }),
            });
            if (!r.ok) {
              throw new Error('HTTP ' + r.status);
            }
            var d = await r.json();
            if (!d.jobId) {
              throw new Error('No job ID');
            }
            var jobId = d.jobId;
            var poll = setInterval(async function () {
              try {
                var pr = await apiFetch('/api/panel/servers/discover/' + encodeURIComponent(jobId));
                var pd = await pr.json();
                if (pd.state === 'completed' && pd.result) {
                  clearInterval(poll);
                  discoverBtn.disabled = false;
                  discoverBtn.innerHTML =
                    '<i data-lucide="check" class="w-3 h-3"></i> ' + esc(i18next.t('web:settings.discover_done'));
                  if (window.lucide) lucide.createIcons({ nodes: [discoverBtn] });
                  // Fill discovered paths into inputs
                  var paths = pd.result.paths || pd.result;
                  var pathMap = {
                    SFTP_LOG_PATH: paths.logPath,
                    SFTP_CONNECT_LOG_PATH: paths.connectLogPath,
                    SFTP_ID_MAP_PATH: paths.idMapPath,
                    SFTP_SAVE_PATH: paths.savePath,
                    SFTP_SETTINGS_PATH: paths.settingsPath,
                  };
                  for (var pk in pathMap) {
                    if (pathMap[pk]) {
                      var inp = body.querySelector('input[data-key="' + pk + '"]');
                      if (inp) {
                        inp.value = pathMap[pk];
                        inp.dispatchEvent(new Event('input', { bubbles: true }));
                      }
                    }
                  }
                } else if (pd.state === 'failed') {
                  clearInterval(poll);
                  discoverBtn.disabled = false;
                  discoverBtn.innerHTML =
                    '<i data-lucide="alert-triangle" class="w-3 h-3"></i> ' +
                    esc(pd.error || i18next.t('web:settings.discover_failed'));
                  if (window.lucide) lucide.createIcons({ nodes: [discoverBtn] });
                }
              } catch (_e) {
                clearInterval(poll);
                discoverBtn.disabled = false;
                discoverBtn.innerHTML =
                  '<i data-lucide="alert-triangle" class="w-3 h-3"></i> ' +
                  esc(_e.message || i18next.t('web:settings.discover_failed'));
                if (window.lucide) lucide.createIcons({ nodes: [discoverBtn] });
              }
            }, 2000);
          } catch (err) {
            discoverBtn.disabled = false;
            discoverBtn.innerHTML = '<i data-lucide="alert-triangle" class="w-3 h-3"></i> ' + esc(err.message);
            if (window.lucide) lucide.createIcons({ nodes: [discoverBtn] });
          }
        });
        body.insertBefore(discoverBtn, body.firstChild);
      }
      sectionEl.appendChild(body);
      return sectionEl;
    }

    var filterBar = el('div', 'bot-config-filterbar flex flex-wrap items-center gap-2 mb-3');
    var filterDefs = [
      { id: 'changed', label: i18next.t('web:settings.filters.changed', { defaultValue: 'Changed' }) },
      { id: 'invalid', label: i18next.t('web:settings.filters.invalid', { defaultValue: 'Invalid' }) },
      { id: 'live', label: i18next.t('web:settings.filters.live', { defaultValue: 'Live' }) },
      {
        id: 'restart',
        label: i18next.t('web:settings.filters.restart_required', { defaultValue: 'Restart required' }),
      },
      { id: 'secrets', label: i18next.t('web:settings.filters.secrets', { defaultValue: 'Secrets' }) },
      { id: 'advanced', label: i18next.t('web:settings.filters.advanced', { defaultValue: 'Advanced' }) },
    ];
    filterBar.innerHTML =
      '<span class="text-xs text-muted mr-1">' +
      esc(i18next.t('web:settings.filters.label', { defaultValue: 'Quick filters' })) +
      '</span>';
    for (var fdi = 0; fdi < filterDefs.length; fdi++) {
      var filterBtn = el(
        'button',
        'bot-config-filter-chip text-xs px-2 py-1 rounded-full border border-border text-muted hover:text-accent hover:border-accent/40 transition-colors',
      );
      filterBtn.type = 'button';
      filterBtn.dataset.filter = filterDefs[fdi].id;
      filterBtn.textContent = filterDefs[fdi].label;
      filterBar.appendChild(filterBtn);
    }
    var filterCount = el('span', 'bot-config-filter-count text-xs text-muted ml-1');
    filterBar.appendChild(filterCount);
    container.appendChild(filterBar);

    // Render groups
    var hasGroups = groups && groups.length > 0;
    if (hasGroups) {
      for (var gi = 0; gi < groups.length; gi++) {
        var group = groups[gi];
        var groupSecs = [];
        for (var ci = 0; ci < group.categories.length; ci++) {
          var cId = group.categories[ci];
          if (sectionById[cId]) {
            groupSecs.push(sectionById[cId]);
            renderedSectionIds[cId] = true;
          }
        }

        if (groupSecs.length === 0) continue;

        var groupEl = el('div', 'bot-config-group mb-4 bg-surface rounded-lg border border-border overflow-hidden');
        var groupHeader = el(
          'div',
          'bot-config-group-header flex items-center justify-between p-3 bg-surface-50 cursor-pointer select-none hover:bg-surface-100 transition-colors border-l-2 border-l-accent',
        );

        var gLabel = i18next.t('web:settings.bot_groups.' + group.id, {
          defaultValue: group.id.charAt(0).toUpperCase() + group.id.slice(1),
        });
        groupHeader.innerHTML =
          '<div class="flex items-center gap-2">' +
          '<i data-lucide="' +
          (group.icon || 'folder') +
          '" class="w-4 h-4 text-accent"></i>' +
          '<span class="font-bold text-sm">' +
          esc(gLabel) +
          '</span>' +
          '</div>' +
          '<div class="flex items-center gap-3">' +
          '<span class="text-xs text-muted bg-surface border border-border px-2 py-0.5 rounded-full">' +
          groupSecs.length +
          ' ' +
          i18next.t('web:settings.categories', { defaultValue: 'categories' }) +
          '</span>' +
          '<i data-lucide="chevron-down" class="w-4 h-4 text-muted group-chevron transition-transform duration-200"></i>' +
          '</div>';

        var groupBody = el('div', 'bot-config-group-body p-3 hidden');

        for (var gsi = 0; gsi < groupSecs.length; gsi++) {
          var secEl = renderSection(groupSecs[gsi], group.id);
          if (secEl) groupBody.appendChild(secEl);
        }

        (function (bodyEl, headerEl) {
          headerEl.addEventListener('click', function () {
            var isHidden = bodyEl.classList.contains('hidden');
            if (isHidden) {
              bodyEl.classList.remove('hidden');
              headerEl.querySelector('.group-chevron').style.transform = 'rotate(180deg)';
            } else {
              bodyEl.classList.add('hidden');
              headerEl.querySelector('.group-chevron').style.transform = '';
            }
          });
        })(groupBody, groupHeader);

        // Auto-expand the first group
        if (gi === 0) {
          groupBody.classList.remove('hidden');
          var chev = groupHeader.querySelector('.group-chevron');
          if (chev) chev.style.transform = 'rotate(180deg)';
        }

        groupEl.appendChild(groupHeader);
        groupEl.appendChild(groupBody);
        container.appendChild(groupEl);
      }
    }

    // Render orphans (if any) or if groups is not provided
    var orphans = [];
    for (var i = 0; i < sections.length; i++) {
      if (!renderedSectionIds[sections[i].id || sections[i].label]) {
        orphans.push(sections[i]);
      }
    }

    if (orphans.length > 0) {
      var orphanContainer = container;
      if (hasGroups) {
        var groupEl = el('div', 'bot-config-group mb-4 bg-surface rounded-lg border border-border overflow-hidden');
        var groupHeader = el(
          'div',
          'bot-config-group-header flex items-center justify-between p-3 bg-surface-50 cursor-pointer select-none hover:bg-surface-100 transition-colors border-l-2 border-l-muted',
        );
        groupHeader.innerHTML =
          '<div class="flex items-center gap-2">' +
          '<i data-lucide="archive" class="w-4 h-4 text-muted"></i>' +
          '<span class="font-bold text-sm">' +
          esc(i18next.t('web:settings.bot_groups.other', { defaultValue: 'Other' })) +
          '</span>' +
          '</div>' +
          '<div class="flex items-center gap-3">' +
          '<span class="text-xs text-muted bg-surface border border-border px-2 py-0.5 rounded-full">' +
          orphans.length +
          ' categories</span>' +
          '<i data-lucide="chevron-down" class="w-4 h-4 text-muted group-chevron transition-transform duration-200 rotate-180"></i>' +
          '</div>';
        var groupBody = el('div', 'bot-config-group-body p-3');
        groupEl.appendChild(groupHeader);
        groupEl.appendChild(groupBody);
        container.appendChild(groupEl);
        orphanContainer = groupBody;

        (function (bodyEl, headerEl) {
          headerEl.addEventListener('click', function () {
            var isHidden = bodyEl.classList.contains('hidden');
            if (isHidden) {
              bodyEl.classList.remove('hidden');
              headerEl.querySelector('.group-chevron').style.transform = 'rotate(180deg)';
            } else {
              bodyEl.classList.add('hidden');
              headerEl.querySelector('.group-chevron').style.transform = '';
            }
          });
        })(groupBody, groupHeader);
      }

      for (var oi = 0; oi < orphans.length; oi++) {
        var secEl = renderSection(orphans[oi], '');
        if (secEl) {
          // Body already has 'open' class by default from renderSection
          orphanContainer.appendChild(secEl);
        }
      }
    }

    // Re-initialize icons
    if (window.lucide) window.lucide.createIcons();
    initializeTimezoneComboboxes(container);

    // ── 3. Wire Events ──

    // Search + quick filter logic
    var searchInput = $('#settings-search');
    var searchClear = null; // header search has no dedicated clear button
    function hasActiveBotConfigFilters() {
      for (var filterId in activeFilters) {
        if (activeFilters[filterId]) return true;
      }
      return false;
    }

    function rowMatchesQuickFilters(row) {
      if (activeFilters.changed && !row.classList.contains('setting-changed')) return false;
      if (activeFilters.invalid && !row.classList.contains('setting-invalid')) return false;
      if (activeFilters.live && row.dataset.reloadStrategy !== 'live') return false;
      if (activeFilters.restart && (!row.dataset.reloadStrategy || row.dataset.reloadStrategy === 'live')) return false;
      if (activeFilters.secrets && row.dataset.sensitive !== 'true') return false;
      if (activeFilters.advanced && row.dataset.advanced !== 'true') return false;
      return true;
    }

    function applyBotConfigFilters() {
      var q = searchInput ? searchInput.value.toLowerCase().trim() : '';
      var hasFilters = hasActiveBotConfigFilters();
      var hasConditions = Boolean(q || hasFilters);
      var groups = container.querySelectorAll('.bot-config-group');
      var categories = container.querySelectorAll('.settings-category');
      var totalRows = 0;
      var visibleRows = 0;

      categories.forEach(function (c) {
        var catLabel = c.dataset.sectionLabel || '';
        var rows = c.querySelectorAll('.setting-row');
        var catHasVisible = false;

        rows.forEach(function (r) {
          totalRows++;
          var key = (r.dataset.key || '').toLowerCase();
          var nameEl = r.querySelector('.setting-name');
          var name = nameEl ? nameEl.textContent.toLowerCase() : '';
          var desc = r.dataset.desc || '';
          var textMatches = !q || catLabel.includes(q) || key.includes(q) || name.includes(q) || desc.includes(q);
          var visible = textMatches && rowMatchesQuickFilters(r);
          r.style.display = visible ? '' : 'none';
          if (visible) {
            visibleRows++;
            catHasVisible = true;
          }
        });

        c.style.display = catHasVisible ? '' : 'none';
        if (catHasVisible && hasConditions) {
          var items = c.querySelector('.settings-category-items');
          if (items) items.classList.add('open');
        }
      });

      groups.forEach(function (g) {
        var groupHasVisible = false;
        var cats = g.querySelectorAll('.settings-category');
        cats.forEach(function (c) {
          if (c.style.display !== 'none') groupHasVisible = true;
        });
        g.style.display = groupHasVisible ? '' : 'none';
        if (groupHasVisible && hasConditions) {
          var body = g.querySelector('.bot-config-group-body');
          if (body) body.classList.remove('hidden');
          var chev = g.querySelector('.group-chevron');
          if (chev) chev.style.transform = 'rotate(180deg)';
        }
      });

      var countEl = $('#settings-count');
      if (countEl) {
        countEl.textContent = hasConditions ? visibleRows + ' / ' + totalRows + ' settings' : totalRows + ' settings';
      }
      filterCount.textContent = hasConditions
        ? i18next.t('web:settings.filters.result_count', {
            count: visibleRows,
            total: totalRows,
            defaultValue: visibleRows + ' matching',
          })
        : '';
    }

    filterBar.addEventListener('click', function (e) {
      var btn = e.target.closest('.bot-config-filter-chip');
      if (!btn) return;
      var id = btn.dataset.filter;
      activeFilters[id] = !activeFilters[id];
      btn.classList.toggle('text-accent', Boolean(activeFilters[id]));
      btn.classList.toggle('border-accent/40', Boolean(activeFilters[id]));
      btn.classList.toggle('bg-accent/10', Boolean(activeFilters[id]));
      applyBotConfigFilters();
    });

    if (searchInput) {
      searchInput.oninput = function () {
        var q = this.value.toLowerCase().trim();
        if (q) {
          if (searchClear) searchClear.classList.remove('hidden');
        } else {
          if (searchClear) searchClear.classList.add('hidden');
        }
        applyBotConfigFilters();
      };

      if (searchClear) {
        searchClear.addEventListener('click', function () {
          searchInput.value = '';
          searchInput.dispatchEvent(new Event('input'));
          searchInput.focus();
        });
      }
    }
    S.botConfigFilterRefresh = applyBotConfigFilters;
    applyBotConfigFilters();

    if (container.dataset.botConfigEventsWired !== 'true') {
      // Input changes
      container.addEventListener('input', function (e) {
        if (!e.target.classList.contains('bot-config-input')) return;
        markBotConfigControlChanged(e.target);
      });

      // Selects + toggles
      container.addEventListener('change', function (e) {
        if (!e.target.classList.contains('bot-config-toggle') && !e.target.classList.contains('bot-config-input'))
          return;
        markBotConfigControlChanged(e.target);
      });
      container.dataset.botConfigEventsWired = 'true';
    }
  }

  function getBotConfigControlValue(control) {
    if (!control) return '';
    if (control.type === 'checkbox') return control.checked ? 'true' : 'false';
    return control.value || '';
  }

  function setBotConfigControlValue(control, value) {
    if (!control) return;
    if (control.type === 'checkbox') control.checked = String(value) === 'true';
    else control.value = value || '';
  }

  function findBotConfigControl(key) {
    return (
      $('#settings-grid .bot-config-input[data-key="' + key + '"]') ||
      $('#settings-grid .bot-config-toggle[data-key="' + key + '"]')
    );
  }

  function getBotConfigControlOptions(control) {
    if (!control || !control.dataset.options) return [];
    try {
      var parsed = JSON.parse(control.dataset.options);
      return Array.isArray(parsed) ? parsed : [];
    } catch (_e) {
      return [];
    }
  }

  function setBotConfigControlError(control, message) {
    var row = control ? control.closest('.setting-row') : null;
    if (!row) return;
    var errorEl = row.querySelector('.setting-error');
    row.classList.toggle('setting-invalid', Boolean(message));
    control.classList.toggle('invalid', Boolean(message));
    if (errorEl) {
      errorEl.textContent = message || '';
      errorEl.classList.toggle('hidden', !message);
    }
  }

  function validateBotConfigControl(control) {
    var value = getBotConfigControlValue(control);
    var validator = control.dataset.validator || '';
    var options = getBotConfigControlOptions(control);
    var message = '';
    if (control.dataset.required === 'true' && !String(value).trim()) {
      message = i18next.t('web:settings.validation.required', { defaultValue: 'This setting is required.' });
    } else if (value) {
      if (control.dataset.singleLine === 'true' && /[\r\n]/.test(value)) {
        message = i18next.t('web:settings.validation.single_line_json', {
          defaultValue: 'Use single-line JSON here; line breaks are rejected.',
        });
      } else if (validator === 'enum' && options.length && options.indexOf(value) === -1) {
        message = i18next.t('web:settings.validation.invalid_option', { defaultValue: 'Choose a listed option.' });
      } else if (
        validator === 'timezone' &&
        !isBotConfigTimezoneValueValid(value, options, control.dataset.freeform === 'true')
      ) {
        message = i18next.t('web:settings.validation.invalid_timezone', {
          defaultValue: 'Choose a listed IANA timezone.',
        });
      } else if (validator === 'time' && !/^\d{2}:\d{2}$/.test(value)) {
        message = i18next.t('web:settings.validation.invalid_time', { defaultValue: 'Use HH:MM, for example 08:30.' });
      } else if (validator === 'time') {
        var parts = value.split(':');
        var hours = parseInt(parts[0], 10);
        var minutes = parseInt(parts[1], 10);
        if (hours > 23 || minutes > 59) {
          message = i18next.t('web:settings.validation.invalid_time', {
            defaultValue: 'Use HH:MM, for example 08:30.',
          });
        }
      } else if (validator === 'json') {
        try {
          var parsed = JSON.parse(value);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('JSON value must be an object');
          }
          for (var jsonKey in parsed) {
            if (!Object.prototype.hasOwnProperty.call(parsed, jsonKey)) continue;
            var jsonValue = parsed[jsonKey];
            if (typeof jsonValue !== 'string' && typeof jsonValue !== 'number' && typeof jsonValue !== 'boolean') {
              message = i18next.t('web:settings.validation.invalid_json_object', {
                defaultValue: 'Use a JSON object with string, number, or boolean values.',
              });
              break;
            }
          }
        } catch (_jsonErr) {
          if (!message) {
            message = i18next.t('web:settings.validation.invalid_json', { defaultValue: 'Enter valid JSON.' });
          }
        }
      } else if ((control.type === 'number' || control.dataset.valueType === 'integer') && !/^-?\d+$/.test(value)) {
        message = i18next.t('web:settings.validation.invalid_number', { defaultValue: 'Enter a whole number.' });
      }
    }
    setBotConfigControlError(control, message);
    return !message;
  }

  function isBotConfigTimezoneValueValid(value, options, freeform) {
    if (!value) return true;
    if (options.indexOf(value) !== -1) return true;
    if (isIntlTimezoneValueValid(value)) return true;
    if (typeof Intl !== 'undefined' && typeof Intl.DateTimeFormat === 'function') return false;
    return freeform || options.length === 0;
  }

  function isIntlTimezoneValueValid(value) {
    if (!value || typeof Intl === 'undefined' || typeof Intl.DateTimeFormat !== 'function') return false;
    try {
      new Intl.DateTimeFormat(undefined, { timeZone: value });
      return true;
    } catch (_err) {
      return false;
    }
  }

  var timezoneComboboxOptionsCache = {};

  function getTimezoneComboboxOptions(input) {
    var optionValues = getBotConfigControlOptions(input);
    var cacheKey = optionValues.join('\u0000');
    if (!timezoneComboboxOptionsCache[cacheKey]) {
      timezoneComboboxOptionsCache[cacheKey] = buildTimezoneOptions(optionValues);
    }
    var options = timezoneComboboxOptionsCache[cacheKey].slice();
    var current = getBotConfigControlValue(input).trim();
    if (
      current &&
      isIntlTimezoneValueValid(current) &&
      options.every(function (option) {
        return option.value !== current;
      })
    ) {
      options.unshift(buildTimezoneOption(current));
    }
    return options;
  }

  function closeTimezoneCombobox(input) {
    var wrapper = input ? input.closest('.bot-config-combobox') : null;
    if (!wrapper) return;
    var list = wrapper.querySelector('.bot-config-combobox-list');
    var row = input.closest('.setting-row');
    var group = input.closest('.bot-config-group');
    if (list) list.classList.add('hidden');
    input.setAttribute('aria-expanded', 'false');
    wrapper.classList.remove('open');
    if (row) row.classList.remove('setting-combobox-open');
    if (group) group.classList.remove('bot-config-group-open-dropdown');
  }

  function closeOtherTimezoneComboboxes(activeInput) {
    $$('.bot-config-input[data-validator="timezone"]').forEach(function (input) {
      if (input !== activeInput) closeTimezoneCombobox(input);
    });
  }

  function renderTimezoneComboboxList(input, showAll) {
    var wrapper = input.closest('.bot-config-combobox');
    var list = wrapper ? wrapper.querySelector('.bot-config-combobox-list') : null;
    if (!list) return;
    var query = showAll ? '' : input.value;
    var current = getBotConfigControlValue(input).trim();
    var options = sortTimezoneOptionsForQuery(
      getTimezoneComboboxOptions(input).filter(function (option) {
        return timezoneOptionMatchesQuery(option, query);
      }),
      query,
    );

    if (!options.length) {
      list.innerHTML =
        '<div class="bot-config-combobox-empty">' +
        esc(i18next.t('web:settings.timezone_no_results', { defaultValue: 'No matching timezone.' })) +
        '</div>';
      return;
    }

    var html = '';
    for (var i = 0; i < options.length; i++) {
      var option = options[i];
      var selected = option.value === current;
      html +=
        '<button type="button" class="bot-config-combobox-option' +
        (selected ? ' selected' : '') +
        '" role="option" aria-selected="' +
        (selected ? 'true' : 'false') +
        '" aria-label="' +
        attrEsc(option.offset ? option.value + ' ' + option.offset : option.value) +
        '" data-timezone-value="' +
        attrEsc(option.value) +
        '">' +
        '<span class="bot-config-combobox-option-main">' +
        esc(option.value) +
        '</span>' +
        (option.offset ? '<span class="bot-config-combobox-option-offset">' + esc(option.offset) + '</span>' : '') +
        '</button>';
    }
    list.innerHTML = html;
  }

  function openTimezoneCombobox(input, showAll) {
    var wrapper = input.closest('.bot-config-combobox');
    var list = wrapper ? wrapper.querySelector('.bot-config-combobox-list') : null;
    if (!wrapper || !list) return;
    closeOtherTimezoneComboboxes(input);
    renderTimezoneComboboxList(input, showAll);
    var row = input.closest('.setting-row');
    var group = input.closest('.bot-config-group');
    list.classList.remove('hidden');
    input.setAttribute('aria-expanded', 'true');
    wrapper.classList.add('open');
    if (row) row.classList.add('setting-combobox-open');
    if (group) group.classList.add('bot-config-group-open-dropdown');
  }

  function selectTimezoneOption(input, value) {
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    closeTimezoneCombobox(input);
    input.focus();
  }

  function initializeTimezoneComboboxes(container) {
    var inputs = container.querySelectorAll('.bot-config-input[data-validator="timezone"]');
    inputs.forEach(function (input) {
      if (input.dataset.timezoneComboboxWired === 'true') return;
      input.dataset.timezoneComboboxWired = 'true';
      var wrapper = input.closest('.bot-config-combobox');
      var toggle = wrapper ? wrapper.querySelector('.bot-config-combobox-toggle') : null;
      var list = wrapper ? wrapper.querySelector('.bot-config-combobox-list') : null;

      input.addEventListener('focus', function () {
        openTimezoneCombobox(input, true);
      });
      input.addEventListener('input', function () {
        openTimezoneCombobox(input, false);
      });
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') {
          closeTimezoneCombobox(input);
        } else if (e.key === 'ArrowDown') {
          e.preventDefault();
          openTimezoneCombobox(input, true);
          var first = list ? list.querySelector('.bot-config-combobox-option') : null;
          if (first) first.focus();
        }
      });

      if (toggle) {
        toggle.addEventListener('click', function (e) {
          e.preventDefault();
          e.stopPropagation();
          var isOpen = input.getAttribute('aria-expanded') === 'true';
          if (isOpen) closeTimezoneCombobox(input);
          else openTimezoneCombobox(input, true);
        });
      }

      if (list) {
        list.addEventListener('mousedown', function (e) {
          e.preventDefault();
        });
        list.addEventListener('click', function (e) {
          var option = e.target && e.target.closest ? e.target.closest('[data-timezone-value]') : null;
          if (!option) return;
          selectTimezoneOption(input, option.dataset.timezoneValue || '');
        });
        list.addEventListener('keydown', function (e) {
          if (e.key === 'Escape') {
            closeTimezoneCombobox(input);
            input.focus();
            return;
          }
          if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Enter') return;
          var options = Array.prototype.slice.call(list.querySelectorAll('.bot-config-combobox-option'));
          var index = options.indexOf(document.activeElement);
          if (e.key === 'Enter' && index >= 0) {
            e.preventDefault();
            selectTimezoneOption(input, options[index].dataset.timezoneValue || '');
            return;
          }
          e.preventDefault();
          var nextIndex = e.key === 'ArrowUp' ? Math.max(0, index - 1) : Math.min(options.length - 1, index + 1);
          if (options[nextIndex]) options[nextIndex].focus();
        });
      }
    });

    if (!S.timezoneComboboxDocumentWired) {
      document.addEventListener('click', function (e) {
        if (e.target && e.target.closest && e.target.closest('.bot-config-combobox')) return;
        $$('.bot-config-input[data-validator="timezone"]').forEach(function (input) {
          closeTimezoneCombobox(input);
        });
      });
      S.timezoneComboboxDocumentWired = true;
    }
  }

  function markBotConfigControlChanged(control) {
    var key = control.dataset.key;
    var orig = control.dataset.original || '';
    var val = getBotConfigControlValue(control);
    var isSensitive = control.dataset.sensitive === 'true';
    var row = control.closest('.setting-row');
    var changed = isSensitive ? val.length > 0 : val !== orig;

    if (changed) {
      S.botConfigChanged[key] = val;
      control.classList.add('changed');
    } else {
      delete S.botConfigChanged[key];
      control.classList.remove('changed');
    }
    if (row) row.classList.toggle('setting-changed', changed);
    validateBotConfigControl(control);
    updateBotConfigBadges();
    if (S.botConfigFilterRefresh) S.botConfigFilterRefresh();
  }

  function updateBotConfigBadges() {
    const changeCount = Object.keys(S.botConfigChanged).length;
    const hasChanges = changeCount > 0;
    const invalidCount = $$('#settings-grid .setting-row.setting-invalid').length;
    const canSave = hasChanges && invalidCount === 0;
    const btn = $('#settings-save-btn');
    if (btn) {
      btn.disabled = !canSave;
      btn.classList.toggle('opacity-50', !canSave);
      btn.classList.toggle('cursor-not-allowed', !canSave);
    }
    const countBadge = $('#settings-change-count');
    if (countBadge) {
      countBadge.classList.toggle('hidden', !hasChanges && invalidCount === 0);
      if (invalidCount > 0) {
        countBadge.textContent = i18next.t('web:settings.validation.invalid_count', {
          count: invalidCount,
          defaultValue: invalidCount + ' invalid',
        });
      } else {
        countBadge.textContent = changeCount + ' change' + (changeCount !== 1 ? 's' : '');
      }
    }
    const resetBtn = $('#settings-reset-btn');
    if (resetBtn) resetBtn.classList.toggle('hidden', !hasChanges);
    setSettingsRestartBadge(false);
  }

  function setSettingsRestartBadge(visible) {
    const restartBadge = $('#settings-restart-badge');
    if (restartBadge) restartBadge.classList.toggle('hidden', !visible);
  }

  function humanizeEnvKey(key) {
    return key.replace(/_/g, ' ').replace(/\b([A-Z]+)\b/g, function (m) {
      if (/^(ID|IP|RCON|SFTP|FTP|SSH|PVP|API|URL|TTL|CSV|DB|OAUTH|MSG|XP|AI|DM|UI|NPC|ADMIN)$/.test(m)) return m;
      return m.charAt(0) + m.slice(1).toLowerCase();
    });
  }

  function resetBotConfigChanges() {
    const keys = Object.keys(S.botConfigChanged);
    for (let i = 0; i < keys.length; i++) {
      let key = keys[i];
      let control = findBotConfigControl(key);
      if (control) {
        if (control.dataset.sensitive === 'true') setBotConfigControlValue(control, '');
        else setBotConfigControlValue(control, control.dataset.original || '');
        control.classList.remove('changed', 'invalid');
        const row = control.closest('.setting-row');
        if (row) row.classList.remove('setting-changed', 'setting-invalid');
        validateBotConfigControl(control);
      }
    }
    S.botConfigChanged = {};
    updateBotConfigBadges();
    if (S.botConfigFilterRefresh) S.botConfigFilterRefresh();
  }

  async function commitBotConfig() {
    if (Object.keys(S.botConfigChanged).length === 0) return;
    const invalidCount = $$('#settings-grid .setting-row.setting-invalid').length;
    if (invalidCount > 0) {
      showToast(
        i18next.t('web:settings.validation.save_blocked_invalid', {
          count: invalidCount,
          defaultValue: 'Fix invalid settings before saving.',
        }),
        5000,
      );
      updateBotConfigBadges();
      return;
    }
    const btn = $('#settings-save-btn');
    if (btn) {
      btn.disabled = true;
      btn.textContent = i18next.t('web:schedule_editor.saving');
    }
    try {
      const r = await apiFetch('/api/panel/bot-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ changes: S.botConfigChanged }),
      });
      const d = await r.json();
      if (d.ok) {
        const updated = d.updated || [];
        for (let ui = 0; ui < updated.length; ui++) {
          let key = updated[ui];
          const newVal = S.botConfigChanged[key];
          const control = findBotConfigControl(key);
          if (control && control.dataset.sensitive === 'true') {
            setBotConfigControlValue(control, '');
            control.classList.remove('changed', 'invalid');
            const sensRow = control.closest('.setting-row');
            if (sensRow) sensRow.classList.remove('setting-changed', 'setting-invalid');
          } else {
            S.botConfigOriginal[key] = newVal;
            if (control) {
              control.dataset.original = newVal;
              control.classList.remove('changed', 'invalid');
              const row = control.closest('.setting-row');
              if (row) row.classList.remove('setting-changed', 'setting-invalid');
            }
          }
        }
        S.botConfigChanged = {};
        if (btn) btn.textContent = i18next.t('web:schedule_editor.saved') + ' ✓';
        updateBotConfigBadges();
        if (S.botConfigFilterRefresh) S.botConfigFilterRefresh();
        setSettingsRestartBadge(Boolean(d.restartRequired));
        showToast(
          d.code ? i18next.t('api:errors.' + d.code) : d.message || i18next.t('web:toast.settings_saved'),
          5000,
        );
        setTimeout(function () {
          if (btn) {
            btn.textContent = i18next.t('web:settings.save_changes');
            btn.disabled = true;
            btn.classList.add('opacity-50', 'cursor-not-allowed');
          }
        }, 2000);
      } else throw new Error(d.error || i18next.t('web:toast.save_failed'));
    } catch (e) {
      if (btn) {
        btn.textContent = i18next.t('web:dashboard.error');
        btn.disabled = false;
      }
      console.error('Bot config save error:', e);
      showToast(i18next.t('web:toast.error', { message: e.message }), 5000);
      setTimeout(function () {
        if (btn) btn.textContent = i18next.t('web:settings.save_changes');
      }, 2000);
    }
  }

  // ══════════════════════════════════════════════════════════════════
  //  Schedule Editor
  // ══════════════════════════════════════════════════════════════════

  const SCHED_SKIP_KEYS = { ServerName: 1, MaxPlayers: 1, PVP: 1 };
  const _schedEdit = { times: [], profiles: [], settings: {}, rotateDaily: false, serverNameTemplate: '' };

  function _deathLabel(v) {
    const k = { 0: 'keep_items', 1: 'drop_items', 2: 'destroy_items' };
    return i18next.t('web:on_death.' + (k[v] || 'drop_items'));
  }

  function _schedLabel(k) {
    const m = {
      ZombieAmountMulti: 'schedule.zombies',
      ZombieDiffHealth: 'schedule.zombie_hp',
      ZombieDiffDamage: 'schedule.zombie_damage',
      ZombieDiffSpeed: 'schedule.zombie_speed',
      HumanAmountMulti: 'schedule.bandits',
      AnimalMulti: 'schedule.animals',
      AIEvent: 'schedule.ai_events',
      XpMultiplier: 'schedule.xp_multiplier',
      OnDeath: 'schedule.on_death',
      RarityFood: 'schedule.food_loot',
      RarityDrink: 'schedule.drink_loot',
      RarityMelee: 'schedule.melee_loot',
      RarityRanged: 'schedule.ranged_loot',
      RarityAmmo: 'schedule.ammo_loot',
      RarityArmor: 'schedule.armor_loot',
      RarityResources: 'schedule.resource_loot',
      RarityOther: 'schedule.other_loot',
      PVP: 'schedule.pvp',
      MaxPlayers: 'schedule.max_players',
    };
    return m[k] ? i18next.t('web:' + m[k]) : null;
  }

  function _schedDiffLabel(v) {
    const k = { 1: 'low', 2: 'normal', 3: 'high', 4: 'very_high' };
    return i18next.t('web:difficulty.' + (k[v] || v));
  }

  function _schedRarityLabel(v) {
    const k = { 1: 'scarce', 2: 'normal', 3: 'plenty', 4: 'abundant' };
    return i18next.t('web:loot_level.' + (k[v] || v));
  }

  function formatSettingVal(key, val) {
    const s = String(val).replace(/^"|"$/g, '');
    if (/^ZombieDiff/.test(key)) return _schedDiffLabel(s);
    if (/^Rarity/.test(key)) return _schedRarityLabel(s);
    if (/Multi$|Multiplier$/.test(key))
      return parseFloat(s) !== 1 ? s + 'x' : '1x (' + i18next.t('web:schedule.default') + ')';
    if (key === 'AIEvent') return _schedDiffLabel(s);
    if (key === 'OnDeath') {
      return _deathLabel(parseInt(s, 10));
    }
    if (key === 'PVP') return s === '1' || s === 'true' ? i18next.t('web:schedule.on') : i18next.t('web:schedule.off');
    return s;
  }

  function buildScheduleTip(name, colorCls, ps) {
    const accent =
      colorCls === 'calm'
        ? getCssColor('calm', '#6dba82')
        : colorCls === 'surge'
          ? getCssColor('surge', '#d4a843')
          : colorCls === 'horde'
            ? getCssColor('horde', '#c45a4a')
            : getCssColor('text', '#c8c2b8');
    let h = '<div class="sched-tip"><div class="sched-tip-title" style="color:' + accent + '">' + esc(name) + '</div>';
    for (const k in ps) {
      if (!ps.hasOwnProperty(k) || SCHED_SKIP_KEYS[k]) continue;
      const label = _schedLabel(k) || humanizeSettingKey(k);
      const val = formatSettingVal(k, ps[k]);
      h +=
        '<div class="sched-tip-row"><span class="sched-tip-key">' +
        esc(label) +
        '</span><span class="sched-tip-val">' +
        esc(val) +
        '</span></div>';
    }
    h += '</div>';
    return h;
  }

  function getRelativeHint(slot, sched) {
    if (!sched.todaySchedule) return '';
    const now = minutesFromTimeStr(getCurrentTimeInTz(sched.timezone));
    const start = minutesFromTimeStr(slot.startTime);
    const diff = start - now;
    if (diff <= 0) return '';
    if (diff < 60) return i18next.t('web:schedule.in_minutes', { m: diff });
    const h = Math.floor(diff / 60);
    const m = diff % 60;
    return m > 0
      ? i18next.t('web:schedule.in_hours_minutes', { h: h, m: m })
      : i18next.t('web:schedule.in_hours', { h: h });
  }

  function minutesFromTimeStr(ts) {
    if (!ts) return 0;
    const parts = ts.split(':');
    return parseInt(parts[0], 10) * 60 + (parseInt(parts[1], 10) || 0);
  }

  function getCurrentTimeInTz(tz) {
    try {
      return new Date().toLocaleTimeString(undefined, {
        timeZone: tz,
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch (_e) {
      return new Date().toTimeString().slice(0, 5);
    }
  }

  function renderSchedule(container, sched, _context) {
    if (!container || !sched || !sched.todaySchedule) return;
    container.innerHTML = '';
    const profileSettings = sched.profileSettings || {};
    const slots = sched.todaySchedule.slots || [];
    if (!slots.length) return;
    const now = getCurrentTimeInTz(sched.timezone);
    const nowMins = minutesFromTimeStr(now);

    let html = '<div class="sched-timeline">';
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      const startMins = minutesFromTimeStr(slot.startTime);
      const endMins = i + 1 < slots.length ? minutesFromTimeStr(slots[i + 1].startTime) : 1440;
      let duration = endMins - startMins;
      if (duration < 0) duration += 1440;
      const pct = (duration / 1440) * 100;
      const profile = slot.profile || 'default';
      const colorCls = profile.includes('calm')
        ? 'calm'
        : profile.includes('surge')
          ? 'surge'
          : profile.includes('horde')
            ? 'horde'
            : 'text';
      const isActive =
        nowMins >= startMins && (i + 1 >= slots.length || nowMins < minutesFromTimeStr(slots[i + 1].startTime));
      const hint = getRelativeHint(slot, sched);
      const ps = profileSettings[profile] || {};
      const tip = buildScheduleTip(profile.charAt(0).toUpperCase() + profile.slice(1), colorCls, ps);

      html +=
        '<div class="sched-slot' +
        (isActive ? ' sched-active' : '') +
        '" style="flex:' +
        pct +
        '" data-tippy-content="' +
        esc(tip) +
        '">';
      html += '<div class="sched-slot-label text-' + colorCls + '">';
      html += '<span class="sched-time">' + slot.startTime + '</span>';
      html += '<span class="sched-profile">' + esc(profile.charAt(0).toUpperCase() + profile.slice(1)) + '</span>';
      if (isActive) html += '<span class="sched-now">' + i18next.t('web:schedule.now') + '</span>';
      else if (hint) html += '<span class="sched-hint">' + hint + '</span>';
      html += '</div></div>';
    }
    html += '</div>';
    container.innerHTML = html;
    if (window.tippy)
      tippy(container.querySelectorAll('[data-tippy-content]'), {
        theme: 'translucent',
        allowHTML: true,
        placement: 'top',
        delay: [150, 0],
      });
  }

  function renderTomorrowSchedule(container, sched) {
    if (!container || !sched.tomorrowSchedule) return;
    const tmrw = sched.tomorrowSchedule;
    const slots = tmrw.slots || [];
    if (!slots.length) return;
    const profileSettings = sched.profileSettings || {};

    let html = '<div class="mt-3">';
    html +=
      '<div class="text-[10px] text-muted mb-1">' +
      i18next.t('web:schedule.tomorrow', { defaultValue: 'Tomorrow' }) +
      '</div>';
    html += '<div class="sched-timeline sched-tomorrow">';
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      const startMins = minutesFromTimeStr(slot.startTime);
      const endMins = i + 1 < slots.length ? minutesFromTimeStr(slots[i + 1].startTime) : 1440;
      let duration = endMins - startMins;
      if (duration < 0) duration += 1440;
      const pct = (duration / 1440) * 100;
      const profile = slot.profile || 'default';
      const colorCls = profile.includes('calm')
        ? 'calm'
        : profile.includes('surge')
          ? 'surge'
          : profile.includes('horde')
            ? 'horde'
            : 'text';
      const ps = profileSettings[profile] || {};
      const tip = buildScheduleTip(profile.charAt(0).toUpperCase() + profile.slice(1), colorCls, ps);

      html += '<div class="sched-slot" style="flex:' + pct + '" data-tippy-content="' + esc(tip) + '">';
      html += '<div class="sched-slot-label text-' + colorCls + '">';
      html += '<span class="sched-time">' + slot.startTime + '</span>';
      html += '<span class="sched-profile">' + esc(profile.charAt(0).toUpperCase() + profile.slice(1)) + '</span>';
      html += '</div></div>';
    }
    html += '</div></div>';
    container.innerHTML += html;
    if (window.tippy)
      tippy(container.querySelectorAll('.sched-tomorrow [data-tippy-content]'), {
        theme: 'translucent',
        allowHTML: true,
        placement: 'top',
        delay: [150, 0],
      });
  }

  // ── Schedule Editor Core ────────────────────────────────────────

  function _getSchedSettingGroups() {
    const _d = function () {
      return {
        1: i18next.t('web:difficulty.low'),
        2: i18next.t('web:difficulty.normal'),
        3: i18next.t('web:difficulty.high'),
        4: i18next.t('web:difficulty.very_high'),
      };
    };
    const _r = function () {
      return {
        1: i18next.t('web:loot_level.scarce'),
        2: i18next.t('web:loot_level.normal'),
        3: i18next.t('web:loot_level.plenty'),
        4: i18next.t('web:loot_level.abundant'),
      };
    };
    return [
      {
        header: i18next.t('web:schedule_editor.zombies'),
        icon: 'skull',
        items: [
          { key: 'ZombieAmountMulti', label: i18next.t('web:dashboard.amount'), type: 'number', step: '0.1' },
          { key: 'ZombieDiffHealth', label: i18next.t('web:dashboard.health'), type: 'select', opts: _d() },
          { key: 'ZombieDiffDamage', label: i18next.t('web:dashboard.damage'), type: 'select', opts: _d() },
          { key: 'ZombieDiffSpeed', label: i18next.t('web:dashboard.speed'), type: 'select', opts: _d() },
        ],
      },
      {
        header: i18next.t('web:schedule_editor.enemies'),
        icon: 'swords',
        items: [
          { key: 'HumanAmountMulti', label: i18next.t('web:dashboard.bandits'), type: 'number', step: '0.1' },
          { key: 'AnimalMulti', label: i18next.t('web:schedule.animals'), type: 'number', step: '0.1' },
          { key: 'AIEvent', label: i18next.t('web:schedule.ai_events'), type: 'select', opts: _d() },
        ],
      },
      {
        header: i18next.t('web:schedule_editor.loot'),
        icon: 'package',
        items: [
          { key: 'RarityFood', label: i18next.t('web:dashboard.food'), type: 'select', opts: _r() },
          { key: 'RarityDrink', label: i18next.t('web:dashboard.drinks'), type: 'select', opts: _r() },
          { key: 'RarityMelee', label: i18next.t('web:dashboard.melee'), type: 'select', opts: _r() },
          { key: 'RarityRanged', label: i18next.t('web:dashboard.ranged'), type: 'select', opts: _r() },
          { key: 'RarityAmmo', label: i18next.t('web:dashboard.ammo'), type: 'select', opts: _r() },
          { key: 'RarityArmor', label: i18next.t('web:dashboard.armor'), type: 'select', opts: _r() },
          { key: 'RarityResources', label: i18next.t('web:dashboard.resources'), type: 'select', opts: _r() },
          { key: 'RarityOther', label: i18next.t('web:schedule_editor.other'), type: 'select', opts: _r() },
        ],
      },
      {
        header: i18next.t('web:schedule_editor.gameplay'),
        icon: 'settings',
        items: [
          {
            key: 'PVP',
            label: 'PvP',
            type: 'select',
            opts: { 0: i18next.t('web:schedule.off'), 1: i18next.t('web:schedule.on') },
          },
          {
            key: 'OnDeath',
            label: i18next.t('web:schedule.on_death'),
            type: 'select',
            opts: {
              0: i18next.t('web:on_death.keep_items'),
              1: i18next.t('web:on_death.drop_items'),
              2: i18next.t('web:on_death.destroy_items'),
            },
          },
          { key: 'XpMultiplier', label: i18next.t('web:schedule.xp_multiplier'), type: 'number', step: '0.1' },
          { key: 'MaxPlayers', label: i18next.t('web:schedule.max_players'), type: 'number', step: '1' },
        ],
      },
    ];
  }

  function _getSchedSettingOptions() {
    return _getSchedSettingGroups().reduce(function (a, g) {
      return a.concat(g.items);
    }, []);
  }

  async function loadScheduleEditor() {
    const container = $('#settings-grid');
    if (!container) return;
    container.innerHTML =
      '<div class="feed-empty">' +
      i18next.t('web:empty_states.loading_schedule', { defaultValue: 'Loading schedule...' }) +
      '</div>';

    try {
      const r = await apiFetch('/api/panel/scheduler');
      const sched = await r.json();
      S.scheduleData = sched;
    } catch (_e) {
      S.scheduleData = null;
    }

    const data = S.scheduleData || {};
    _schedEdit.times = (data.restartTimes || []).slice();
    _schedEdit.profiles = (data.profiles || []).slice();
    _schedEdit.settings = {};
    const ps = data.profileSettings || {};
    for (let i = 0; i < _schedEdit.profiles.length; i++) {
      const n = _schedEdit.profiles[i];
      _schedEdit.settings[n] = ps[n] ? Object.assign({}, ps[n]) : {};
    }
    _schedEdit.rotateDaily = !!data.rotateDaily;
    _schedEdit.serverNameTemplate = data.serverNameTemplate || '';
    if (!_schedEdit.serverNameTemplate) {
      for (let pi = 0; pi < _schedEdit.profiles.length; pi++) {
        const pSettings = _schedEdit.settings[_schedEdit.profiles[pi]] || {};
        let sn = pSettings.ServerName;
        if (sn) {
          sn = sn.replace(/^"|"$/g, '');
          const pName = _schedEdit.profiles[pi];
          const capName = pName.charAt(0).toUpperCase() + pName.slice(1);
          if (sn.includes(capName)) {
            _schedEdit.serverNameTemplate = sn.replace(capName, '{mode}');
          }
          break;
        }
      }
    }

    _renderScheduleInline(container, data);
  }

  // The schedule editor inline render and wire functions are very long.
  // They are included below but condensed for module extraction.
  // All original logic is preserved exactly.

  function _renderScheduleInline(container, data) {
    container.innerHTML = '';
    const isActive = data && data.active;
    const banner = el(
      'div',
      'flex items-center gap-2 text-xs px-3 py-2 rounded-lg border ' +
        (isActive ? 'bg-accent/5 border-accent/20 text-accent' : 'bg-surface-50 border-border text-muted'),
    );
    banner.innerHTML =
      '<i data-lucide="' +
      (isActive ? 'check-circle' : 'info') +
      '" class="w-3.5 h-3.5"></i>' +
      (isActive
        ? i18next.t('web:settings.schedule_active_banner', {
            profiles: _schedEdit.profiles.length || 0,
            restarts: _schedEdit.times.length || 0,
            defaultValue: 'Schedule is active — {{profiles}} profile(s), {{restarts}} restart time(s)',
          })
        : i18next.t('web:settings.schedule_inactive_banner', {
            defaultValue: 'No schedule configured — add restart times and profiles below',
          }));
    container.appendChild(banner);

    if (isActive) {
      const preview = el('div', 'card');
      const prevHdr = el('div', 'flex items-center justify-between mb-3');
      prevHdr.innerHTML =
        '<h3 class="card-title mb-0">' +
        i18next.t('web:settings.current_schedule', { defaultValue: 'Current Schedule' }) +
        '</h3>';
      preview.appendChild(prevHdr);
      const prevBody = el('div', 'space-y-2');
      prevBody.id = 'sched-inline-preview';
      renderSchedule(prevBody, data, 'dashboard');
      if (data.rotateDaily && data.tomorrowSchedule) {
        renderTomorrowSchedule(prevBody, data);
      }
      preview.appendChild(prevBody);
      container.appendChild(preview);
    }

    if (S.tier < 3) {
      if (!isActive)
        container.innerHTML =
          '<div class="feed-empty">' + i18next.t('web:empty_states.no_schedule_configured_for_server') + '</div>';
      lucide.createIcons({ attrs: { class: '' } });
      return;
    }

    const editorWrap = el('div', 'space-y-5');

    // Restart Times
    const timesSection = el('div', 'card');
    timesSection.innerHTML =
      '<h3 class="card-title flex items-center gap-2"><i data-lucide="clock" class="w-4 h-4 text-muted"></i> ' +
      i18next.t('web:settings.restart_times') +
      '</h3>' +
      '<p class="text-[10px] text-muted mb-3">' +
      i18next.t('web:settings.restart_times_description') +
      '</p>';
    const timesList = el('div', 'flex flex-wrap gap-2 mb-3');
    timesList.id = 'sched-times-list';
    timesSection.appendChild(timesList);
    const addTimeRow = el('div', 'flex items-center gap-2');
    addTimeRow.innerHTML =
      '<input type="time" id="sched-add-time" class="input-field w-28 text-xs py-1">' +
      '<button id="sched-add-time-btn" class="text-xs px-2.5 py-1 rounded bg-accent/20 text-accent hover:bg-accent/30 transition-colors">' +
      i18next.t('web:settings.add_time') +
      '</button>';
    timesSection.appendChild(addTimeRow);
    editorWrap.appendChild(timesSection);

    // Profiles
    const profilesSection = el('div', 'card');
    profilesSection.innerHTML =
      '<h3 class="card-title flex items-center gap-2"><i data-lucide="layers" class="w-4 h-4 text-muted"></i> ' +
      i18next.t('web:settings.profiles') +
      '</h3>' +
      '<p class="text-[10px] text-muted mb-3">' +
      i18next.t('web:settings.profiles_description') +
      '</p>';
    const profilesList = el('div', '');
    profilesList.id = 'sched-profiles-list';
    profilesSection.appendChild(profilesList);
    const addProfileRow = el('div', 'flex items-center gap-2 mt-3');
    addProfileRow.innerHTML =
      '<input type="text" id="sched-add-profile" placeholder="' +
      i18next.t('web:settings.profile_name_placeholder') +
      '" class="input-field w-40 text-xs py-1">' +
      '<button id="sched-add-profile-btn" class="text-xs px-2.5 py-1 rounded bg-accent/20 text-accent hover:bg-accent/30 transition-colors">' +
      i18next.t('web:settings.add_profile') +
      '</button>';
    profilesSection.appendChild(addProfileRow);
    editorWrap.appendChild(profilesSection);

    // Server Name Template
    const nameSection = el('div', 'card');
    nameSection.innerHTML =
      '<h3 class="card-title flex items-center gap-2"><i data-lucide="type" class="w-4 h-4 text-muted"></i> ' +
      i18next.t('web:settings.server_name_template') +
      '</h3>' +
      '<p class="text-[10px] text-muted mb-3">' +
      i18next.t('web:settings.server_name_template_description') +
      '</p>' +
      '<input type="text" id="sched-name-template" placeholder="' +
      i18next.t('web:settings.server_name_template_placeholder') +
      '" class="input-field w-full text-xs py-1.5 font-mono" value="' +
      esc(_schedEdit.serverNameTemplate) +
      '">';
    editorWrap.appendChild(nameSection);

    // Options
    const optSection = el('div', 'card');
    const rotateLabel = el('label', 'flex items-center gap-2 text-xs text-text cursor-pointer select-none');
    rotateLabel.innerHTML =
      '<input type="checkbox" id="sched-rotate-daily" class="accent-accent rounded w-3.5 h-3.5"' +
      (_schedEdit.rotateDaily ? ' checked' : '') +
      '> ' +
      i18next.t('web:settings.rotate_profiles_daily');
    optSection.appendChild(rotateLabel);
    editorWrap.appendChild(optSection);

    // Save bar
    const saveBar = el('div', 'flex items-center justify-end gap-3 pt-2');
    saveBar.innerHTML =
      '<span id="sched-editor-status" class="text-[10px] text-muted"></span>' +
      '<button id="sched-editor-save" class="btn-primary flex items-center gap-1.5"><i data-lucide="save" class="w-3.5 h-3.5"></i> ' +
      i18next.t('web:settings.save_schedule') +
      '</button>';
    editorWrap.appendChild(saveBar);

    container.appendChild(editorWrap);
    _renderSchedTimes();
    _renderSchedProfiles();
    _wireScheduleEvents();
    lucide.createIcons({ attrs: { class: '' } });
  }

  function _wireScheduleEvents() {
    const addTimeBtn = $('#sched-add-time-btn');
    if (addTimeBtn)
      addTimeBtn.onclick = function () {
        const inp = $('#sched-add-time');
        const val = inp.value;
        if (!val) return;
        const parts = val.split(':');
        const t =
          String(parseInt(parts[0], 10)).padStart(2, '0') + ':' + String(parseInt(parts[1], 10) || 0).padStart(2, '0');
        if (_schedEdit.times.indexOf(t) === -1) _schedEdit.times.push(t);
        inp.value = '';
        _renderSchedTimes();
      };

    const addProfileBtn = $('#sched-add-profile-btn');
    if (addProfileBtn)
      addProfileBtn.onclick = function () {
        const inp = $('#sched-add-profile');
        const name = inp.value
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9_-]/g, '');
        if (!name) return;
        if (_schedEdit.profiles.indexOf(name) === -1) {
          _schedEdit.profiles.push(name);
          _schedEdit.settings[name] = {};
        }
        inp.value = '';
        _renderSchedProfiles();
      };

    const rotateCb = $('#sched-rotate-daily');
    if (rotateCb)
      rotateCb.onchange = function () {
        _schedEdit.rotateDaily = rotateCb.checked;
      };

    const tplInput = $('#sched-name-template');
    if (tplInput)
      tplInput.oninput = function () {
        _schedEdit.serverNameTemplate = tplInput.value;
      };

    const saveBtn = $('#sched-editor-save');
    if (saveBtn) saveBtn.onclick = _saveSchedule;
  }

  function _renderSchedTimes() {
    const c = $('#sched-times-list');
    if (!c) return;
    c.innerHTML = '';
    _schedEdit.times.sort();
    for (let i = 0; i < _schedEdit.times.length; i++) {
      (function (idx) {
        const t = _schedEdit.times[idx];
        const chip = el(
          'div',
          'flex items-center gap-1.5 bg-surface-50 border border-border rounded px-2.5 py-1 text-xs font-mono',
        );
        chip.innerHTML = '<span>' + esc(t) + '</span>';
        const btn = el('button', 'text-muted hover:text-horde transition-colors');
        btn.innerHTML = '<i data-lucide="x" class="w-3 h-3"></i>';
        btn.onclick = function () {
          _schedEdit.times.splice(idx, 1);
          _renderSchedTimes();
        };
        chip.appendChild(btn);
        c.appendChild(chip);
      })(i);
    }
    lucide.createIcons({ attrs: { class: '' } });
  }

  function _renderSchedProfiles() {
    const c = $('#sched-profiles-list');
    if (!c) return;
    c.innerHTML = '';
    for (let i = 0; i < _schedEdit.profiles.length; i++) {
      (function (idx) {
        const name = _schedEdit.profiles[idx];
        const settings = _schedEdit.settings[name] || {};
        const card = el('div', 'sched-profile-card');
        const hdr = el('div', 'sched-profile-hdr');
        const colorCls = name.includes('calm')
          ? 'text-calm'
          : name.includes('surge')
            ? 'text-surge'
            : name.includes('horde')
              ? 'text-horde'
              : 'text-accent';
        hdr.innerHTML =
          '<span class="text-sm font-medium ' +
          colorCls +
          '">' +
          esc(name.charAt(0).toUpperCase() + name.slice(1)) +
          '</span>';
        const actions = el('div', 'flex items-center gap-2');
        const dupeBtn = el('button', 'text-[10px] text-muted hover:text-accent transition-colors');
        dupeBtn.textContent = i18next.t('web:schedule_editor.duplicate');
        dupeBtn.onclick = function () {
          let newName = name + '-copy';
          let suffix = 2;
          while (_schedEdit.profiles.indexOf(newName) >= 0) newName = name + '-copy' + suffix++;
          _schedEdit.profiles.push(newName);
          _schedEdit.settings[newName] = Object.assign({}, _schedEdit.settings[name] || {});
          delete _schedEdit.settings[newName].ServerName;
          _renderSchedProfiles();
        };
        actions.appendChild(dupeBtn);
        const removeBtn = el('button', 'text-[10px] text-muted hover:text-horde transition-colors');
        removeBtn.textContent = i18next.t('web:schedule_editor.remove');
        removeBtn.onclick = function () {
          _schedEdit.profiles.splice(idx, 1);
          delete _schedEdit.settings[name];
          _renderSchedProfiles();
        };
        actions.appendChild(removeBtn);
        hdr.appendChild(actions);
        card.appendChild(hdr);

        const _groups = _getSchedSettingGroups();
        for (let gi = 0; gi < _groups.length; gi++) {
          (function (group) {
            const section = el('div', 'sched-settings-group');
            const groupHdr = el('div', 'sched-group-hdr');
            groupHdr.innerHTML =
              '<i data-lucide="' + group.icon + '" class="w-3 h-3"></i><span>' + group.header + '</span>';
            section.appendChild(groupHdr);
            const grid = el('div', 'sched-settings-grid');
            for (let si = 0; si < group.items.length; si++) {
              (function (opt) {
                const row = el('div', 'sched-setting-row');
                const lbl = el('span', 'sched-setting-label');
                lbl.textContent = opt.label;
                row.appendChild(lbl);
                const curVal = settings[opt.key] != null ? String(settings[opt.key]) : '';
                let input;
                if (opt.type === 'select') {
                  input = document.createElement('select');
                  input.className = 'input-field text-[10px] py-0.5 px-1.5 w-24';
                  const emptyOpt = document.createElement('option');
                  emptyOpt.value = '';
                  emptyOpt.textContent = '— ' + i18next.t('web:schedule.default') + ' —';
                  input.appendChild(emptyOpt);
                  for (const val in opt.opts) {
                    const o = document.createElement('option');
                    o.value = val;
                    o.textContent = opt.opts[val];
                    if (val === curVal) o.selected = true;
                    input.appendChild(o);
                  }
                } else {
                  input = document.createElement('input');
                  input.type = 'number';
                  input.step = opt.step || '1';
                  input.min = '0';
                  input.className = 'input-field text-[10px] py-0.5 px-1.5 w-20';
                  input.placeholder = i18next.t('web:schedule.default');
                  if (curVal) input.value = curVal;
                }
                input.onchange = function () {
                  if (!_schedEdit.settings[name]) _schedEdit.settings[name] = {};
                  if (input.value === '') delete _schedEdit.settings[name][opt.key];
                  else _schedEdit.settings[name][opt.key] = input.value;
                };
                row.appendChild(input);
                grid.appendChild(row);
              })(group.items[si]);
            }
            section.appendChild(grid);
            card.appendChild(section);
          })(_groups[gi]);
        }
        c.appendChild(card);
      })(i);
    }
    lucide.createIcons({ attrs: { class: '' } });
  }

  function _saveSchedule() {
    const statusEl = $('#sched-editor-status');
    if (statusEl) {
      statusEl.textContent = i18next.t('web:schedule_editor.saving');
      statusEl.style.color = getCssColor('surge', '#d4a843');
    }
    const tpl = ($('#sched-name-template') || {}).value || '';
    if (tpl) {
      for (let pi = 0; pi < _schedEdit.profiles.length; pi++) {
        const pn = _schedEdit.profiles[pi];
        const capName = pn.charAt(0).toUpperCase() + pn.slice(1);
        if (!_schedEdit.settings[pn]) _schedEdit.settings[pn] = {};
        _schedEdit.settings[pn].ServerName = '"' + tpl.replace(/\{mode\}/gi, capName) + '"';
      }
    }
    const payload = {
      restartTimes: _schedEdit.times,
      profiles: _schedEdit.profiles,
      profileSettings: _schedEdit.settings,
      rotateDaily: $('#sched-rotate-daily').checked,
      serverNameTemplate: tpl,
    };
    apiFetch('/api/panel/scheduler', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
      .then(function (r) {
        return r.json();
      })
      .then(function (data) {
        if (data.ok) {
          if (statusEl) {
            statusEl.textContent = i18next.t('web:schedule_editor.saved_restart');
            statusEl.style.color = getCssColor('calm', '#6dba82');
          }
          setTimeout(function () {
            loadScheduleEditor();
          }, 1200);
        } else {
          if (statusEl) {
            statusEl.textContent = data.error || i18next.t('web:toast.save_failed');
            statusEl.style.color = getCssColor('horde', '#c45a4a');
          }
        }
      })
      .catch(function (_e) {
        if (statusEl) {
          statusEl.textContent = i18next.t('web:schedule_editor.network_error');
          statusEl.style.color = getCssColor('horde', '#c45a4a');
        }
      });
  }

  // Wire up schedule editor modal close buttons
  (function () {
    const closeBtn = $('#sched-editor-close');
    if (closeBtn)
      closeBtn.onclick = function () {
        $('#sched-editor-modal').classList.add('hidden');
      };
    const cancelBtn = $('#sched-editor-cancel');
    if (cancelBtn)
      cancelBtn.onclick = function () {
        $('#sched-editor-modal').classList.add('hidden');
      };
  })();

  // ══════════════════════════════════════════════════════════════════
  //  Welcome File Editor
  // ══════════════════════════════════════════════════════════════════

  async function loadWelcomeEditor() {
    var container = $('#settings-grid');
    if (!container) return;
    container.innerHTML = '<div class="feed-empty">Loading...</div>';

    try {
      var r = await apiFetch('/api/panel/welcome-file');
      if (!r.ok) throw new Error('Failed to load');
      var d = await r.json();
      var content = d.content || '';
      var placeholders = d.placeholders || [];
      renderWelcomeEditor(container, content, placeholders);
    } catch (_err) {
      container.innerHTML = '<div class="feed-empty">' + i18next.t('web:settings.welcome_load_failed') + '</div>';
    }
  }

  function renderWelcomeEditor(container, content, placeholders) {
    container.innerHTML = '';

    // ── Header ──
    var header = el('div', 'mb-4');
    header.innerHTML =
      '<h3 class="card-title flex items-center gap-2"><i data-lucide="scroll-text" class="w-4 h-4 text-muted"></i> ' +
      i18next.t('web:settings.welcome_editor_title') +
      '</h3>' +
      '<p class="text-[10px] text-muted mt-1">' +
      i18next.t('web:settings.welcome_editor_desc') +
      '</p>';
    container.appendChild(header);

    // ── Editor grid (split pane) ──
    var editorGrid = el('div', 'welcome-editor');

    // Left pane
    var leftPane = el('div', '');

    // Toolbar
    var toolbar = el('div', 'welcome-toolbar');

    // Color tag label
    var tagLabel = el('span', 'text-[10px] text-muted');
    tagLabel.textContent = i18next.t('web:settings.welcome_insert_tag');
    toolbar.appendChild(tagLabel);

    // Color tag buttons
    var tags = [
      { tag: 'PR', label: i18next.t('web:settings.welcome_tag_green'), cls: 'PR' },
      { tag: 'SP', label: i18next.t('web:settings.welcome_tag_orange'), cls: 'SP' },
      { tag: 'CL', label: i18next.t('web:settings.welcome_tag_blue'), cls: 'CL' },
      { tag: 'FO', label: i18next.t('web:settings.welcome_tag_gray'), cls: 'FO' },
      { tag: 'PN', label: i18next.t('web:settings.welcome_tag_red'), cls: 'PN' },
    ];
    for (var ti = 0; ti < tags.length; ti++) {
      var tagBtn = el('button', 'welcome-tag-btn');
      tagBtn.dataset.tag = tags[ti].cls;
      tagBtn.textContent = tags[ti].label;
      toolbar.appendChild(tagBtn);
    }

    // Divider
    var divider = el('div', 'w-px h-4 bg-border mx-1');
    toolbar.appendChild(divider);

    // Placeholder label
    var phLabel = el('span', 'text-[10px] text-muted');
    phLabel.textContent = i18next.t('web:settings.welcome_insert_placeholder');
    toolbar.appendChild(phLabel);

    // Placeholder buttons
    var defaultPlaceholders = ['{server_name}', '{discord_link}', '{pvp_schedule}', '{day}', '{season}', '{weather}'];
    var phList = placeholders.length ? placeholders : defaultPlaceholders;
    for (var pi = 0; pi < phList.length; pi++) {
      var phBtn = el('button', 'welcome-tag-btn');
      phBtn.dataset.placeholder = phList[pi];
      phBtn.textContent = phList[pi];
      toolbar.appendChild(phBtn);
    }

    leftPane.appendChild(toolbar);

    // Textarea
    var textarea = document.createElement('textarea');
    textarea.className = 'welcome-textarea';
    textarea.id = 'welcome-textarea';
    textarea.value = content;
    textarea.spellcheck = false;
    leftPane.appendChild(textarea);

    editorGrid.appendChild(leftPane);

    // Right pane
    var rightPane = el('div', '');
    var previewLabel = el('div', 'text-[10px] text-muted mb-2 flex items-center gap-1.5');
    previewLabel.innerHTML = '<i data-lucide="eye" class="w-3 h-3"></i> ' + i18next.t('web:settings.welcome_preview');
    rightPane.appendChild(previewLabel);

    var previewBox = el('div', 'welcome-preview-box');
    previewBox.id = 'welcome-preview';
    rightPane.appendChild(previewBox);

    editorGrid.appendChild(rightPane);
    container.appendChild(editorGrid);

    // ── Footer ──
    var footer = el('div', 'welcome-footer');
    var charCount = el('span', 'text-[10px] text-muted');
    charCount.id = 'welcome-char-count';
    charCount.textContent = i18next.t('web:settings.welcome_char_count', { count: content.length });
    footer.appendChild(charCount);

    var saveBtn = el('button', 'btn-primary flex items-center gap-1.5');
    saveBtn.id = 'welcome-save-btn';
    saveBtn.innerHTML = '<i data-lucide="upload" class="w-3.5 h-3.5"></i> ' + i18next.t('web:settings.welcome_save');
    footer.appendChild(saveBtn);

    container.appendChild(footer);

    // ── Initial preview render ──
    renderWelcomePreview(previewBox, content);

    // ── Wire events ──
    textarea.addEventListener('input', function () {
      renderWelcomePreview(previewBox, textarea.value);
      charCount.textContent = i18next.t('web:settings.welcome_char_count', { count: textarea.value.length });
    });

    // Color tag buttons — wrap selected text or insert at cursor
    toolbar.addEventListener('click', function (e) {
      var btn = e.target.closest('.welcome-tag-btn');
      if (!btn) return;
      if (btn.dataset.tag) {
        insertAtCursor(textarea, '<' + btn.dataset.tag + '>', '</>');
      } else if (btn.dataset.placeholder) {
        insertAtCursor(textarea, btn.dataset.placeholder, '');
      }
    });

    saveBtn.addEventListener('click', function () {
      saveWelcomeFile(textarea);
    });

    if (typeof lucide !== 'undefined') lucide.createIcons();
  }

  function renderWelcomePreview(previewEl, text) {
    var lines = text.split('\n');
    var html = '';
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      // Escape HTML first, then replace escaped tag patterns
      var rendered = esc(line).replace(/&lt;(PR|SP|CL|FO|PN)&gt;(.*?)&lt;\/&gt;/gi, function (_, tag, inner) {
        return '<span class="wc-' + tag.toLowerCase() + '">' + inner + '</span>';
      });
      html += '<div class="welcome-preview-line">' + (rendered || '&nbsp;') + '</div>';
    }
    previewEl.innerHTML = html;
  }

  function insertAtCursor(textarea, before, after) {
    var start = textarea.selectionStart;
    var end = textarea.selectionEnd;
    var text = textarea.value;
    var selected = text.substring(start, end);
    var replacement = before + selected + (after || '');
    textarea.value = text.substring(0, start) + replacement + text.substring(end);
    var newPos = start + before.length + selected.length + (after ? after.length : 0);
    textarea.selectionStart = textarea.selectionEnd = newPos;
    textarea.focus();
    textarea.dispatchEvent(new Event('input'));
  }

  async function saveWelcomeFile(textarea) {
    var saveBtn = $('#welcome-save-btn');
    if (!saveBtn) return;
    saveBtn.disabled = true;
    saveBtn.textContent = i18next.t('web:settings.welcome_saving');
    try {
      var r = await apiFetch('/api/panel/welcome-file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: textarea.value }),
      });
      if (!r.ok) throw new Error('Save failed');
      showToast(i18next.t('web:settings.welcome_saved'));
    } catch (_err) {
      showToast(i18next.t('web:settings.welcome_save_failed'));
    } finally {
      saveBtn.disabled = false;
      saveBtn.innerHTML = '<i data-lucide="upload" class="w-3.5 h-3.5"></i> ' + i18next.t('web:settings.welcome_save');
      if (typeof lucide !== 'undefined') lucide.createIcons();
    }
  }

  function reset() {
    _inited = false;
  }

  Panel.tabs.settings = {
    init: init,
    load: function () {
      // When scope is 'all', game settings and schedule are server-specific — force bot mode
      if (S.currentServer === 'all' && (S.settingsMode === 'game' || S.settingsMode === 'schedule')) {
        S.settingsMode = 'bot';
        var btns = $$('.settings-mode-btn');
        for (var bi = 0; bi < btns.length; bi++) btns[bi].classList.toggle('active', btns[bi].dataset.mode === 'bot');
      }
      if (S.settingsMode === 'bot') loadBotConfig();
      else if (S.settingsMode === 'schedule') loadScheduleEditor();
      else if (S.settingsMode === 'welcome') loadWelcomeEditor();
      else loadSettings();
    },
    reset: reset,
    loadSettings: loadSettings,
    loadBotConfig: loadBotConfig,
    loadScheduleEditor: loadScheduleEditor,
    filterSettings: filterSettings,
    showSettingsDiff: showSettingsDiff,
    resetSettingsChanges: resetSettingsChanges,
    commitSettings: commitSettings,
    commitBotConfig: commitBotConfig,
    // Exposed for dashboard schedule rendering
    renderSchedule: renderSchedule,
    renderTomorrowSchedule: renderTomorrowSchedule,
    loadWelcomeEditor: loadWelcomeEditor,
    _test: {
      attrEsc: attrEsc,
      buildTimezoneOption: buildTimezoneOption,
      buildTimezoneOptions: buildTimezoneOptions,
      formatUtcOffset: formatUtcOffset,
      getTimezoneComboboxOptions: getTimezoneComboboxOptions,
      getTimezoneOffsetMinutes: getTimezoneOffsetMinutes,
      timezoneOptionMatchesQuery: timezoneOptionMatchesQuery,
      validateBotConfigControl: validateBotConfigControl,
      isBotConfigTimezoneValueValid: isBotConfigTimezoneValueValid,
      closeTimezoneCombobox: closeTimezoneCombobox,
      openTimezoneCombobox: openTimezoneCombobox,
    },
  };
})();

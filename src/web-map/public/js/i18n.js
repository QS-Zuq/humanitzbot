// i18n.js — Browser-side i18n initialization
// Depends on CDN-loaded: i18next, i18nextHttpBackend, i18nextBrowserLanguageDetector

(function() {
  'use strict';

  window.i18nReady = i18next
    .use(i18nextHttpBackend)
    .use(i18nextBrowserLanguageDetector)
    .init({
      supportedLngs: ['en', 'zh-TW', 'zh-CN'],
      fallbackLng: {
        'zh-TW': ['zh-CN', 'en'],
        'zh-CN': ['zh-TW', 'en'],
        default: ['en']
      },
      detection: {
        order: ['localStorage', 'querystring', 'navigator'],
        lookupQuerystring: 'lang',
        lookupLocalStorage: 'i18nextLng',
        caches: ['localStorage'],
      },
      backend: {
        loadPath: '/locales/{{lng}}/{{ns}}.json',
      },
      ns: ['common', 'web', 'api'],
      defaultNS: 'common',
      fallbackNS: 'common',
      interpolation: { escapeValue: false },
      debug: location.hostname === 'localhost',
    })
    .then(function() {
      translateDOM();
      updateHtmlLang();
      initLangSwitcher();
    });

  // ── DOM Translation ──────────────────────────────────────

  /**
   * Translate all elements with data-i18n attributes
   * @param {Element} [root=document] - Root element to scan
   */
  function translateDOM(root) {
    root = root || document;

    // Text content: <span data-i18n="web:nav.dashboard">Dashboard</span>
    root.querySelectorAll('[data-i18n]').forEach(function(el) {
      var key = el.getAttribute('data-i18n');
      var varsAttr = el.getAttribute('data-i18n-vars');
      var vars = varsAttr ? JSON.parse(varsAttr) : {};
      el.textContent = i18next.t(key, vars);
    });

    // HTML content: <p data-i18n-html="web:help.text"></p>
    root.querySelectorAll('[data-i18n-html]').forEach(function(el) {
      el.innerHTML = i18next.t(el.getAttribute('data-i18n-html'));
    });

    // Attributes: <input data-i18n-attr='{"placeholder":"web:search.placeholder"}'>
    root.querySelectorAll('[data-i18n-attr]').forEach(function(el) {
      var attrs = JSON.parse(el.getAttribute('data-i18n-attr'));
      Object.keys(attrs).forEach(function(attr) {
        el.setAttribute(attr, i18next.t(attrs[attr]));
      });
    });
  }

  /**
   * Update <html> lang and dir attributes
   */
  function updateHtmlLang() {
    var lang = i18next.resolvedLanguage || i18next.language || 'en';
    document.documentElement.lang = lang;
    document.documentElement.dir = i18next.dir(lang);
  }

  /**
   * Switch language without page reload
   */
  function switchLanguage(lang) {
    i18next.changeLanguage(lang).then(function() {
      translateDOM();
      updateHtmlLang();
      // Update switcher UI
      var switcher = document.getElementById('lang-switcher');
      if (switcher) switcher.value = lang;
      // Notify other modules (Chart.js, Leaflet, etc.)
      document.dispatchEvent(new CustomEvent('languageChanged', { detail: { lang: lang } }));
    });
  }

  /**
   * Initialize language switcher dropdown
   */
  function initLangSwitcher() {
    var switcher = document.getElementById('lang-switcher');
    if (!switcher) return;
    // Set initial value
    switcher.value = i18next.resolvedLanguage || i18next.language || 'en';
    switcher.addEventListener('change', function() {
      switchLanguage(this.value);
    });
  }

  // ── Intl Formatters ──────────────────────────────────────

  function fmtDate(date) {
    var lang = i18next.resolvedLanguage || 'en';
    return new Intl.DateTimeFormat(lang, { dateStyle: 'medium' }).format(date instanceof Date ? date : new Date(date));
  }

  function fmtTime(date) {
    var lang = i18next.resolvedLanguage || 'en';
    return new Intl.DateTimeFormat(lang, { timeStyle: 'short' }).format(date instanceof Date ? date : new Date(date));
  }

  function fmtNumber(num) {
    var lang = i18next.resolvedLanguage || 'en';
    return new Intl.NumberFormat(lang).format(num);
  }

  // ── Dialog Wrappers ──────────────────────────────────────

  function uiAlert(key, vars) { alert(i18next.t(key, vars)); }
  function uiConfirm(key, vars) { return confirm(i18next.t(key, vars)); }
  function uiPrompt(key, vars) { return prompt(i18next.t(key, vars)); }

  // ── Expose Globals ───────────────────────────────────────

  window.translateDOM = translateDOM;
  window.switchLanguage = switchLanguage;
  window.fmtDate = fmtDate;
  window.fmtTime = fmtTime;
  window.fmtNumber = fmtNumber;
  window.uiAlert = uiAlert;
  window.uiConfirm = uiConfirm;
  window.uiPrompt = uiPrompt;
})();

// biome-ignore lint/suspicious/noRedundantUseStrict: explicit CommonJS strict mode for consistency.
'use strict';

const i18next = require('i18next');
const path = require('node:path');
const config = require('../config');

const LOCALES_DIR = path.join(__dirname, '../../locales');
const SUPPORTED_LANGS = ['en', 'zh-TW', 'zh-CN'];
const NAMESPACES = ['common', 'web', 'discord', 'api', 'commands'];

const resources = {};
for (const lng of SUPPORTED_LANGS) {
  resources[lng] = {};
  for (const ns of NAMESPACES) {
    try {
      resources[lng][ns] = require(path.join(LOCALES_DIR, lng, `${ns}.json`));
    } catch {
      resources[lng][ns] = {};
    }
  }
}

i18next.init({
  lng: 'en',
  supportedLngs: SUPPORTED_LANGS,
  fallbackLng: {
    'zh-TW': ['zh-CN', 'en'],
    'zh-CN': ['zh-TW', 'en'],
    default: ['en']
  },
  ns: NAMESPACES,
  defaultNS: 'common',
  resources,
  interpolation: { escapeValue: false },
  initImmediate: false
});

function t(key, lng, vars = {}) {
  return i18next.t(key, { lng, ...vars });
}

function getLocale(context = {}) {
  if (context.locale && SUPPORTED_LANGS.includes(context.locale)) return context.locale;

  const serverLocale = context.serverConfig?.locale;
  if (serverLocale && SUPPORTED_LANGS.includes(serverLocale)) return serverLocale;

  const globalLocale = config.botLocale;
  if (globalLocale && SUPPORTED_LANGS.includes(globalLocale)) return globalLocale;

  return 'en';
}

function fmtDate(date, lng = 'en') {
  return new Intl.DateTimeFormat(lng, { dateStyle: 'medium' }).format(date instanceof Date ? date : new Date(date));
}

function fmtTime(date, lng = 'en') {
  return new Intl.DateTimeFormat(lng, { timeStyle: 'short' }).format(date instanceof Date ? date : new Date(date));
}

function fmtNumber(num, lng = 'en') {
  return new Intl.NumberFormat(lng).format(num);
}

function getSupportedLocales() {
  return [...SUPPORTED_LANGS];
}

function getLocalizations(key) {
  const result = {};
  const bareKey = key.includes(':') ? key.split(':').slice(1).join(':') : key;
  const enVal = i18next.t(key, { lng: 'en' });

  for (const lng of SUPPORTED_LANGS) {
    if (lng === 'en') continue;
    const val = i18next.t(key, { lng });
    // Skip if: missing (equals key), key path leak, or same as English (no real translation)
    if (val && val !== key && val !== bareKey && val !== enVal) {
      result[lng] = val;
    }
  }

  return result;
}

module.exports = {
  t,
  getLocale,
  fmtDate,
  fmtTime,
  fmtNumber,
  getSupportedLocales,
  getLocalizations,
  i18next
};

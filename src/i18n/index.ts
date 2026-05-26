import i18next from 'i18next';
import path from 'node:path';
import fs from 'node:fs';
import config from '../config/index.js';
import { getDirname } from '../utils/paths.js';

const __dirname = getDirname(import.meta.url);

const LOCALES_DIR = path.join(__dirname, '../../locales');
const SUPPORTED_LANGS = ['en', 'zh-TW', 'zh-CN'] as const;
type SupportedLang = (typeof SUPPORTED_LANGS)[number];
const NAMESPACES = ['common', 'web', 'discord', 'api', 'commands'] as const;

const resources: Record<string, Record<string, Record<string, unknown>>> = {};
for (const lng of SUPPORTED_LANGS) {
  resources[lng] = {};
  for (const ns of NAMESPACES) {
    try {
      const filePath = path.join(LOCALES_DIR, lng, `${ns}.json`);
      const content = fs.readFileSync(filePath, 'utf8');
      resources[lng][ns] = JSON.parse(content) as Record<string, unknown>;
    } catch {
      resources[lng][ns] = {};
    }
  }
}

const I18N_OPTIONS = {
  lng: 'en',
  supportedLngs: [...SUPPORTED_LANGS],
  fallbackLng: {
    'zh-TW': ['zh-CN', 'en'],
    'zh-CN': ['zh-TW', 'en'],
    default: ['en'],
  },
  ns: [...NAMESPACES],
  defaultNS: 'common',
  resources,
  interpolation: { escapeValue: false },
  initImmediate: false,
} as const;

/**
 * Initialize i18next. Safe to await at startup; initImmediate:false also
 * means the first call completes synchronously, so modules that import and
 * use t() before awaiting this function will still get translations.
 */
export async function initI18n(): Promise<void> {
  await i18next.init(I18N_OPTIONS);
}

// Kick off init at module load so translations are available immediately for
// modules that call t() without awaiting initI18n().
void initI18n();

interface LocaleContext {
  locale?: string;
  serverConfig?: { locale?: string };
}

export function t(key: string, lng: string, vars: Record<string, unknown> = {}): string {
  return i18next.t(key, { lng, ...vars });
}

export function getLocale(context: LocaleContext = {}): string {
  if (context.locale && (SUPPORTED_LANGS as readonly string[]).includes(context.locale)) return context.locale;

  const serverLocale = context.serverConfig?.locale;
  if (serverLocale && (SUPPORTED_LANGS as readonly string[]).includes(serverLocale)) return serverLocale;

  const globalLocale = config.botLocale;
  if (globalLocale && (SUPPORTED_LANGS as readonly string[]).includes(globalLocale)) return globalLocale;

  return 'en';
}

export function fmtDate(date: Date | string | number, lng = 'en', timeZone?: string): string {
  const opts: Intl.DateTimeFormatOptions = { dateStyle: 'medium' };
  if (timeZone) opts.timeZone = timeZone;
  return new Intl.DateTimeFormat(lng, opts).format(date instanceof Date ? date : new Date(date));
}

export function fmtTime(date: Date | string | number, lng = 'en', timeZone?: string): string {
  const opts: Intl.DateTimeFormatOptions = { timeStyle: 'short' };
  if (timeZone) opts.timeZone = timeZone;
  return new Intl.DateTimeFormat(lng, opts).format(date instanceof Date ? date : new Date(date));
}

export function fmtNumber(num: number, lng = 'en'): string {
  return new Intl.NumberFormat(lng).format(num);
}

export function getSupportedLocales(): SupportedLang[] {
  return [...SUPPORTED_LANGS];
}

export function getLocalizations(key: string): Record<string, string> {
  const result: Record<string, string> = {};
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

export { i18next };

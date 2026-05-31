/**
 * ServerDisplay — shared formatting helpers for server status data.
 *
 * Pure functions for formatting server settings, loot scarcity, weather odds,
 * difficulty schedules, resource metrics, and visual helpers. Zero Discord
 * coupling — returns plain objects / strings consumable by Discord embeds,
 * web panel, RCON messages, and anywhere else.
 *
 * @module server/server-display
 */

import { getDayOffset, getRotatedProfileIndex } from '../modules/schedule-utils.js';
import { formatBytes as _fmtBytes } from './server-resources.js';
import { t } from '../i18n/index.js';

// ═══════════════════════════════════════════════════════════════════════════
//  Label constants
// ═══════════════════════════════════════════════════════════════════════════

const DIFFICULTY_LABELS = ['Very Easy', 'Easy', 'Default', 'Hard', 'Very Hard', 'Nightmare'];
const SCARCITY_LABELS = ['Scarce', 'Low', 'Default', 'Plentiful', 'Abundant'];
const ON_DEATH_LABELS = ['Lose Nothing', 'Backpack + Weapon', 'Pockets + Backpack', 'Everything'];
const VITAL_DRAIN_LABELS = ['Slow', 'Normal', 'Fast'];
const AI_EVENT_LABELS = ['Off', 'Low', 'Default', 'High', 'Insane'];

type DisplayLocale = string | undefined;

const DIFFICULTY_KEYS = [
  'values.very_easy',
  'values.easy',
  'values.default',
  'values.hard',
  'values.very_hard',
  'values.nightmare',
];
const SCARCITY_KEYS = ['values.scarce', 'values.low', 'values.default', 'values.plentiful', 'values.abundant'];
const ON_DEATH_KEYS = ['values.lose_nothing', 'values.backpack_weapon', 'values.pockets_backpack', 'values.everything'];
const VITAL_DRAIN_KEYS = ['values.slow', 'values.normal', 'values.fast'];
const AI_EVENT_KEYS = ['values.off', 'values.low', 'values.default', 'values.high', 'values.insane'];
const SEASON_KEYS = ['values.summer', 'values.autumn', 'values.winter', 'values.spring'];
const COMPANION_LEVEL_KEYS = ['values.low', 'values.default', 'values.high'];

function displayLocale(locale: DisplayLocale): string {
  return typeof locale === 'string' && locale.trim() ? locale.trim() : 'en';
}

function displayTimeZone(timeZone: unknown): string {
  const normalized = typeof timeZone === 'string' ? timeZone.trim() : '';
  for (const candidate of displayTimeZoneCandidates(normalized)) {
    if (isSupportedTimeZone(candidate)) return candidate;
  }
  return 'UTC';
}

function displayTimeZoneCandidates(timeZone: string): string[] {
  const candidates = timeZone ? [timeZone] : [];
  if (timeZone === 'Asia/Taipei') {
    candidates.push('Etc/GMT-8');
  }
  candidates.push('UTC');
  return candidates;
}

function isSupportedTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

function formatScheduleClockTime(now: Date, timeZone: string): string {
  const options: Intl.DateTimeFormatOptions = {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone,
  };
  try {
    return now.toLocaleTimeString('en-GB', options);
  } catch {
    return now.toLocaleTimeString('en-GB', { ...options, timeZone: 'UTC' });
  }
}

function sd(locale: DisplayLocale, key: string, vars: Record<string, unknown> = {}): string {
  return t(`discord:server_display.${key}`, displayLocale(locale), vars);
}

function minutesLabel(val: unknown, locale: DisplayLocale): string | null {
  if (val === undefined || val === null) return null;
  return sd(locale, 'formats.minutes', { count: _valStr(val) });
}

function daysLabel(val: unknown, locale: DisplayLocale): string | null {
  if (val === undefined || val === null) return null;
  return sd(locale, 'formats.days', { count: _valStr(val) });
}

function everyDaysLabel(val: unknown, locale: DisplayLocale): string | null {
  if (val === undefined || val === null) return null;
  const count = _valStr(val);
  return sd(locale, count === '1' ? 'formats.every_day' : 'formats.every_days', { count });
}

// ═══════════════════════════════════════════════════════════════════════════
//  Value formatters
// ═══════════════════════════════════════════════════════════════════════════

function formatTime(timeStr: string | null | undefined): string | null {
  if (!timeStr) return null;
  const match = timeStr.match(/^(\d{1,2}):(\d{1,2})$/);
  if (match) return `${match[1]}:${match[2]?.padStart(2, '0')}`;
  return timeStr;
}

function _valStr(val: unknown): string {
  if (typeof val === 'string') return val;
  if (typeof val === 'number' || typeof val === 'boolean' || typeof val === 'bigint') return String(val);
  return '';
}

function spawnLabel(val: unknown, locale: DisplayLocale = 'en'): string | null {
  if (val === undefined || val === null) return null;
  const num = parseFloat(_valStr(val));
  if (isNaN(num)) return _valStr(val);
  if (num === 0) return sd(locale, 'values.none');
  if (num === 1) return sd(locale, 'formats.multiplier_default');
  return `x${String(num)}`;
}

function difficultyLabel(val: unknown, locale: DisplayLocale = 'en'): string | null {
  if (val === undefined || val === null) return null;
  const idx = Math.round(parseFloat(_valStr(val)));
  if (isNaN(idx)) return _valStr(val);
  return DIFFICULTY_KEYS[idx] ? sd(locale, DIFFICULTY_KEYS[idx]) : DIFFICULTY_LABELS[idx] || _valStr(val);
}

function difficultyBar(val: unknown, locale: DisplayLocale = 'en'): string | null {
  if (val === undefined || val === null) return null;
  const idx = Math.round(parseFloat(_valStr(val)));
  if (isNaN(idx)) return _valStr(val);
  const label = DIFFICULTY_KEYS[idx] ? sd(locale, DIFFICULTY_KEYS[idx]) : DIFFICULTY_LABELS[idx] || _valStr(val);
  const bar = progressBar((idx + 1) / DIFFICULTY_LABELS.length, 5);
  return `${bar} ${label}`;
}

function settingBool(val: unknown, locale: DisplayLocale = 'en'): string | null {
  if (val === undefined || val === null) return null;
  return val === '1' || _valStr(val).toLowerCase() === 'true' ? sd(locale, 'values.on') : sd(locale, 'values.off');
}

function settingLabel(
  val: unknown,
  labels: string[],
  locale: DisplayLocale = 'en',
  labelKeys?: readonly string[],
): string | null {
  if (val === undefined || val === null) return null;
  const num = parseFloat(_valStr(val));
  if (isNaN(num)) return _valStr(val);
  const idx = Math.round(num);
  if (labelKeys?.[idx]) return sd(locale, labelKeys[idx]);
  return labels[idx] || _valStr(val);
}

function settingMultiplier(val: unknown, locale: DisplayLocale = 'en'): string | null {
  if (val === undefined || val === null) return null;
  const num = parseFloat(_valStr(val));
  if (isNaN(num)) return _valStr(val);
  if (num === 0) return sd(locale, 'values.off');
  if (num === 1) return sd(locale, 'values.default');
  return `${String(num)}x`;
}

function settingDays(val: unknown, unit = 'days', locale: DisplayLocale = 'en'): string | null {
  if (val === undefined || val === null) return null;
  const num = parseFloat(_valStr(val));
  if (isNaN(num)) return _valStr(val);
  if (num === 0) return sd(locale, 'values.off');
  if (unit === 'days') return sd(locale, 'formats.days', { count: String(num) });
  return `${String(num)} ${unit}`;
}

function settingPermaDeath(val: unknown, locale: DisplayLocale = 'en'): string | null {
  if (val === undefined || val === null) return null;
  const s = _valStr(val).toLowerCase();
  if (s === 'true') return sd(locale, 'values.on');
  if (s === 'false') return sd(locale, 'values.off');
  return settingLabel(val, ['Off', 'Individual', 'All'], locale, ['values.off', 'values.individual', 'values.all']);
}

// ═══════════════════════════════════════════════════════════════════════════
//  Visual helpers
// ═══════════════════════════════════════════════════════════════════════════

function progressBar(ratio: number, width = 10, filledChar = '\u2593', emptyChar = '\u2591'): string {
  const r = Math.max(0, Math.min(1, ratio));
  const filled = Math.round(r * width);
  return filledChar.repeat(filled) + emptyChar.repeat(width - filled);
}

function blockBar(ratio: number, width = 12): string {
  return progressBar(ratio, width, '\u2588', '\u2591');
}

// ═══════════════════════════════════════════════════════════════════════════
//  Emoji helpers
// ═══════════════════════════════════════════════════════════════════════════

function weatherEmoji(weather: string | null | undefined): string {
  if (!weather) return '';
  const w = weather.toLowerCase();
  if (w.includes('thunder')) return '\u26C8\uFE0F ';
  if (w.includes('blizzard')) return '\uD83C\uDF2A\uFE0F ';
  if (w.includes('heavy') && w.includes('snow')) return '\u2744\uFE0F ';
  if (w.includes('snow')) return '\uD83C\uDF28\uFE0F ';
  if (w.includes('heavy') && w.includes('rain')) return '\uD83C\uDF27\uFE0F ';
  if (w.includes('rain')) return '\uD83C\uDF26\uFE0F ';
  if (w.includes('fog')) return '\uD83C\uDF2B\uFE0F ';
  if (w.includes('cloud') || w.includes('overcast')) return '\u2601\uFE0F ';
  if (w.includes('sun') || w.includes('clear')) return '\u2600\uFE0F ';
  return '\uD83C\uDF24\uFE0F ';
}

function seasonEmoji(season: string | null | undefined): string {
  if (!season) return '';
  const s = season.toLowerCase();
  if (s.includes('summer')) return '\u2600\uFE0F ';
  if (s.includes('autumn') || s.includes('fall')) return '\uD83C\uDF42 ';
  if (s.includes('winter')) return '\u2744\uFE0F ';
  if (s.includes('spring')) return '\uD83C\uDF31 ';
  return '';
}

function timeEmoji(timeStr: string | null | undefined): string {
  if (!timeStr) return '';
  const match = timeStr.match(/^(\d{1,2})/);
  if (!match) return '';
  const hour = parseInt(match[1] || '0', 10);
  if (hour >= 6 && hour < 8) return '\uD83C\uDF05 '; // dawn
  if (hour >= 8 && hour < 17) return '\u2600\uFE0F '; // day
  if (hour >= 17 && hour < 19) return '\uD83C\uDF07 '; // dusk
  return '\uD83C\uDF19 '; // night
}

// ═══════════════════════════════════════════════════════════════════════════
//  Compound field builders
// ═══════════════════════════════════════════════════════════════════════════

interface FieldEntry {
  name: string;
  value: string;
  inline: boolean;
}

function buildSettingsFields(
  s: Record<string, unknown>,
  cfgInput: unknown = {},
  locale: DisplayLocale = 'en',
): FieldEntry[] {
  const cfg = (cfgInput && typeof cfgInput === 'object' ? cfgInput : {}) as Record<string, unknown>;
  const fields: FieldEntry[] = [];

  function section(emoji: string, title: string, entries: [string, string | null][]): void {
    const rows = entries.filter(([, val]) => val != null).map(([label, val]) => `**${label}:** ${val}`);
    if (rows.length > 0) {
      fields.push({ name: `${emoji} ${title}`, value: rows.join('\n'), inline: true });
    }
  }

  // ── General ──
  if (cfg.showSettingsGeneral !== false) {
    section('\u2694\uFE0F', sd(locale, 'sections.general'), [
      [sd(locale, 'labels.pvp'), settingBool(s.PVP, locale)],
      [sd(locale, 'labels.max_players'), s.MaxPlayers as string | null],
      [sd(locale, 'labels.on_death'), settingLabel(s.OnDeath, ON_DEATH_LABELS, locale, ON_DEATH_KEYS)],
      [sd(locale, 'labels.perma_death'), settingPermaDeath(s.PermaDeath, locale)],
      [sd(locale, 'labels.vital_drain'), settingLabel(s.VitalDrain, VITAL_DRAIN_LABELS, locale, VITAL_DRAIN_KEYS)],
      [sd(locale, 'labels.xp_multiplier'), s.XpMultiplier != null ? `${s.XpMultiplier as string}x` : null],
    ]);
  }

  // ── Time & Seasons ──
  if (cfg.showSettingsTime !== false) {
    section('\uD83D\uDD50', sd(locale, 'sections.time_seasons'), [
      [sd(locale, 'labels.day_length'), minutesLabel(s.DayDur, locale)],
      [sd(locale, 'labels.night_length'), minutesLabel(s.NightDur, locale)],
      [sd(locale, 'labels.season_length'), daysLabel(s.DaysPerSeason, locale)],
      [
        sd(locale, 'labels.start_season'),
        settingLabel(s.StartingSeason, ['Summer', 'Autumn', 'Winter', 'Spring'], locale, SEASON_KEYS),
      ],
    ]);
  }

  // ── Zombies ──
  if (cfg.showSettingsZombies !== false) {
    section('\uD83E\uDDDF', sd(locale, 'sections.zombies'), [
      [sd(locale, 'labels.health'), difficultyLabel(s.ZombieDiffHealth, locale)],
      [sd(locale, 'labels.speed'), difficultyLabel(s.ZombieDiffSpeed, locale)],
      [sd(locale, 'labels.damage'), difficultyLabel(s.ZombieDiffDamage, locale)],
      [sd(locale, 'labels.spawns'), spawnLabel(s.ZombieAmountMulti, locale)],
      [sd(locale, 'labels.respawn'), minutesLabel(s.ZombieRespawnTimer, locale)],
      [sd(locale, 'labels.dogs'), spawnLabel(s.ZombieDogMulti, locale)],
    ]);
  }

  // ── Items ──
  if (cfg.showSettingsItems !== false) {
    const itemEntries: [string, string | null][] = [
      [sd(locale, 'labels.weapon_break'), settingBool(s.WeaponBreak, locale)],
      [sd(locale, 'labels.food_decay'), settingMultiplier(s.FoodDecay, locale)],
      [sd(locale, 'labels.loot_respawn'), minutesLabel(s.LootRespawnTimer, locale)],
      [sd(locale, 'labels.air_drops'), settingBool(s.AirDrop, locale)],
    ];
    if (s.AirDrop === '1' || s.AirDrop === 'true') {
      itemEntries.push([`  ${sd(locale, 'labels.interval')}`, everyDaysLabel(s.AirDropInterval, locale)]);
    }
    section('\uD83C\uDF92', sd(locale, 'sections.items'), itemEntries);
  }

  // ── Extended settings (toggled) ──
  if (cfg.showExtendedSettings !== false) {
    if (cfg.showSettingsBandits !== false) {
      section('\uD83D\uDD2B', sd(locale, 'sections.bandits'), [
        [sd(locale, 'labels.health'), difficultyLabel(s.HumanHealth, locale)],
        [sd(locale, 'labels.speed'), difficultyLabel(s.HumanSpeed, locale)],
        [sd(locale, 'labels.damage'), difficultyLabel(s.HumanDamage, locale)],
        [sd(locale, 'labels.spawns'), spawnLabel(s.HumanAmountMulti, locale)],
        [sd(locale, 'labels.respawn'), minutesLabel(s.HumanRespawnTimer, locale)],
        [sd(locale, 'labels.ai_events'), settingLabel(s.AIEvent, AI_EVENT_LABELS, locale, AI_EVENT_KEYS)],
      ]);
    }

    if (cfg.showSettingsCompanions !== false) {
      section('\uD83D\uDC15', sd(locale, 'sections.companions'), [
        [sd(locale, 'labels.dog_companion'), settingBool(s.DogEnabled, locale)],
        [
          sd(locale, 'labels.companion_hp'),
          settingLabel(s.CompanionHealth, ['Low', 'Default', 'High'], locale, COMPANION_LEVEL_KEYS),
        ],
        [
          sd(locale, 'labels.companion_dmg'),
          settingLabel(s.CompanionDmg, ['Low', 'Default', 'High'], locale, COMPANION_LEVEL_KEYS),
        ],
      ]);
    }

    if (cfg.showSettingsBuilding !== false) {
      section('\uD83C\uDFD7\uFE0F', sd(locale, 'sections.building'), [
        [sd(locale, 'labels.building_hp'), settingMultiplier(s.BuildingHealth, locale)],
        [sd(locale, 'labels.building_decay'), settingDays(s.BuildingDecay, 'days', locale)],
        [sd(locale, 'labels.gen_fuel_rate'), s.GenFuel != null ? `${s.GenFuel as string}x` : null],
        [sd(locale, 'labels.territory'), settingBool(s.Territory, locale)],
        [sd(locale, 'labels.dismantle_own'), settingBool(s.AllowDismantle, locale)],
        [sd(locale, 'labels.dismantle_house'), settingBool(s.AllowHouseDismantle, locale)],
      ]);
    }

    if (cfg.showSettingsVehicles !== false) {
      section('\uD83D\uDE97', sd(locale, 'sections.vehicles'), [
        [
          sd(locale, 'labels.max_cars'),
          s.MaxOwnedCars != null
            ? s.MaxOwnedCars === '0'
              ? sd(locale, 'values.disabled')
              : (s.MaxOwnedCars as string)
            : null,
        ],
      ]);
    }

    if (cfg.showSettingsAnimals !== false) {
      section('\uD83E\uDD8C', sd(locale, 'sections.animals'), [
        [sd(locale, 'labels.animal_spawns'), spawnLabel(s.AnimalMulti, locale)],
        [sd(locale, 'labels.animal_respawn'), minutesLabel(s.AnimalRespawnTimer, locale)],
      ]);
    }
  }

  return fields;
}

function buildLootScarcity(s: Record<string, unknown>, locale: DisplayLocale = 'en'): string | null {
  const fb = s.LootRarity ?? undefined;
  const map: [string, string, unknown][] = [
    ['\uD83C\uDF56', 'labels.food', s.RarityFood ?? fb],
    ['\uD83E\uDD64', 'labels.drink', s.RarityDrink ?? fb],
    ['\uD83D\uDD2A', 'labels.melee', s.RarityMelee ?? fb],
    ['\uD83D\uDD2B', 'labels.ranged', s.RarityRanged ?? fb],
    ['\uD83D\uDEE1\uFE0F', 'labels.armor', s.RarityArmor ?? fb],
    ['\uD83E\uDDF1', 'labels.resources', s.RarityResources ?? fb],
    ['\uD83C\uDFAF', 'labels.ammo', s.RarityAmmo ?? fb],
    ['\uD83D\uDCE6', 'labels.other', s.RarityOther ?? fb],
  ];

  const rows = map
    .filter(([, , val]) => val != null)
    .map(([emoji, labelKey, val]) => {
      const idx = Math.round(parseFloat(String(val))) || 0;
      const name = SCARCITY_KEYS[idx] ? sd(locale, SCARCITY_KEYS[idx]) : SCARCITY_LABELS[idx] || String(val);
      const label = sd(locale, labelKey);
      return `${emoji} **${label}:** ${name}`;
    });

  return rows.length > 0 ? rows.join('\n') : null;
}

function buildWeatherOdds(s: Record<string, unknown>, locale: DisplayLocale = 'en'): string | null {
  const weatherKeys: [string, string, unknown][] = [
    ['\u2600\uFE0F', 'labels.clear_sky', s.Weather_ClearSky],
    ['\u2601\uFE0F', 'labels.cloudy', s.Weather_Cloudy],
    ['\uD83C\uDF2B\uFE0F', 'labels.foggy', s.Weather_Foggy],
    ['\uD83C\uDF26\uFE0F', 'labels.light_rain', s.Weather_LightRain],
    ['\uD83C\uDF27\uFE0F', 'labels.rain', s.Weather_Rain],
    ['\u26C8\uFE0F', 'labels.thunderstorm', s.Weather_Thunderstorm],
    ['\uD83C\uDF28\uFE0F', 'labels.light_snow', s.Weather_LightSnow],
    ['\u2744\uFE0F', 'labels.snow', s.Weather_Snow],
    ['\uD83C\uDF2A\uFE0F', 'labels.blizzard', s.Weather_Blizzard],
  ];

  const rows = weatherKeys
    .filter(([, , val]) => val != null)
    .map(([emoji, labelKey, val]) => {
      const num = parseFloat(String(val));
      const pct = isNaN(num) ? String(val) : `${String(Math.round(num * 100))}%`;
      const label = sd(locale, labelKey);
      return `${emoji} **${label}:** ${pct}`;
    });

  return rows.length > 0 ? rows.join('\n') : null;
}

function buildResourceField(
  res: Record<string, unknown>,
  fmtBytes?: (v: number) => string,
  locale: DisplayLocale = 'en',
): FieldEntry[] {
  if (!fmtBytes) {
    try {
      fmtBytes = _fmtBytes;
    } catch {
      fmtBytes = (v: number) => String(v);
    }
  }
  const parts: string[] = [];
  if (res.cpu != null) parts.push(`\uD83D\uDDA5\uFE0F ${sd(locale, 'labels.cpu')}: **${res.cpu as number}%**`);
  if (res.memUsed != null && res.memTotal != null) {
    parts.push(
      `\uD83E\uDDE0 ${sd(locale, 'labels.ram')}: **${fmtBytes(res.memUsed as number)}** / ${fmtBytes(res.memTotal as number)} (${(res.memPercent as number | undefined) ?? '?'}%)`,
    );
  } else if (res.memPercent != null) {
    parts.push(`\uD83E\uDDE0 ${sd(locale, 'labels.ram')}: **${res.memPercent as number}%**`);
  }
  if (res.diskUsed != null && res.diskTotal != null) {
    parts.push(
      `\uD83D\uDCBE ${sd(locale, 'labels.disk')}: **${fmtBytes(res.diskUsed as number)}** / ${fmtBytes(res.diskTotal as number)} (${(res.diskPercent as number | undefined) ?? '?'}%)`,
    );
  } else if (res.diskPercent != null) {
    parts.push(`\uD83D\uDCBE ${sd(locale, 'labels.disk')}: **${res.diskPercent as number}%**`);
  }
  if (parts.length === 0) return [];
  return [{ name: `\uD83D\uDCE1 ${sd(locale, 'sections.host_resources')}`, value: parts.join('\n'), inline: false }];
}

function buildScheduleField(cfgInput: unknown, locale: DisplayLocale = 'en'): { name: string; value: string } | null {
  if (!cfgInput || typeof cfgInput !== 'object') return null;
  const cfg = cfgInput as Record<string, unknown>;
  if (!cfg.enableServerScheduler) return null;
  const timesStr = (cfg.restartTimes as string) || process.env.RESTART_TIMES || '';
  const profilesStr = (cfg.restartProfiles as string) || process.env.RESTART_PROFILES || '';
  const times = timesStr
    .split(',')
    .map((s: string) => s.trim())
    .filter(Boolean);
  const profiles = profilesStr
    .split(',')
    .map((s: string) => s.trim().toLowerCase())
    .filter(Boolean);
  if (times.length === 0 || profiles.length === 0) return null;

  const timeZone = displayTimeZone(cfg.botTimezone);

  // Daily rotation offset
  const dayOffset = getDayOffset(timeZone, profiles.length, cfg.restartRotateDaily as boolean);

  // Determine active time slot
  const now = new Date();
  const timeStr = formatScheduleClockTime(now, timeZone);
  const [h, m] = timeStr.split(':').map(Number);
  const nowMin = (h ?? 0) * 60 + (m ?? 0);
  const timeMins = times.map((t: string) => {
    const [th, tm] = t.split(':').map(Number);
    return (th ?? 0) * 60 + (tm ?? 0);
  });
  let activeSlot = 0;
  for (let i = timeMins.length - 1; i >= 0; i--) {
    if (nowMin >= (timeMins[i] ?? 0)) {
      activeSlot = i;
      break;
    }
  }

  // Build schedule lines
  const lines = times.map((startTime: string, slotIdx: number) => {
    const profileIdx = getRotatedProfileIndex(slotIdx, profiles.length, dayOffset);
    const name = profiles[profileIdx] ?? '';
    const envKey = `RESTART_PROFILE_${name.toUpperCase()}`;
    let settings: Record<string, string> = {};
    try {
      settings = JSON.parse(process.env[envKey] || '{}') as Record<string, string>;
    } catch {
      // ignore parse errors
    }
    const endTime = times[(slotIdx + 1) % times.length] || times[0];
    const desc: string[] = [];
    const zombieAmt = parseFloat(settings.ZombieAmountMulti ?? '');
    const xp = parseFloat(settings.XpMultiplier ?? '');
    if (!isNaN(zombieAmt)) desc.push(sd(locale, 'formats.profile_zombies', { count: String(zombieAmt) }));
    if (!isNaN(xp) && xp > 1) desc.push(sd(locale, 'formats.profile_xp', { count: String(xp) }));
    const loot = parseInt(settings.RarityMelee || settings.RarityFood || '', 10);
    if (!isNaN(loot) && loot > 2) desc.push(sd(locale, 'formats.better_loot'));
    const displayName = name.charAt(0).toUpperCase() + name.slice(1);
    const marker = slotIdx === activeSlot ? ' \u25C0' : '';
    return `${startTime}\u2013${endTime as string} \u00B7 **${displayName}**${desc.length ? ' \u2014 ' + desc.join(', ') : ''}${marker}`;
  });

  return { name: `\uD83D\uDD04 ${sd(locale, 'sections.difficulty_schedule')}`, value: lines.join('\n') };
}

// ═══════════════════════════════════════════════════════════════════════════
//  Exports
// ═══════════════════════════════════════════════════════════════════════════

export {
  // Label constants
  DIFFICULTY_LABELS,
  SCARCITY_LABELS,
  ON_DEATH_LABELS,
  VITAL_DRAIN_LABELS,
  AI_EVENT_LABELS,

  // Value formatters
  formatTime,
  spawnLabel,
  difficultyLabel,
  difficultyBar,
  settingBool,
  settingLabel,
  settingMultiplier,
  settingDays,
  settingPermaDeath,

  // Visual helpers
  progressBar,
  blockBar,

  // Emoji helpers
  weatherEmoji,
  seasonEmoji,
  timeEmoji,

  // Compound builders
  buildSettingsFields,
  buildLootScarcity,
  buildWeatherOdds,
  buildResourceField,
  buildScheduleField,
};

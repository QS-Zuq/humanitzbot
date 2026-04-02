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

/* eslint-disable @typescript-eslint/no-unsafe-argument,
   @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any,
   @typescript-eslint/restrict-template-expressions */

import { getDayOffset, getRotatedProfileIndex } from '../modules/schedule-utils.js';

// ═══════════════════════════════════════════════════════════════════════════
//  Label constants
// ═══════════════════════════════════════════════════════════════════════════

const DIFFICULTY_LABELS = ['Very Easy', 'Easy', 'Default', 'Hard', 'Very Hard', 'Nightmare'];
const SCARCITY_LABELS = ['Scarce', 'Low', 'Default', 'Plentiful', 'Abundant'];
const ON_DEATH_LABELS = ['Lose Nothing', 'Backpack + Weapon', 'Pockets + Backpack', 'Everything'];
const VITAL_DRAIN_LABELS = ['Slow', 'Normal', 'Fast'];
const AI_EVENT_LABELS = ['Off', 'Low', 'Default', 'High', 'Insane'];

// ═══════════════════════════════════════════════════════════════════════════
//  Value formatters
// ═══════════════════════════════════════════════════════════════════════════

function formatTime(timeStr: string | null | undefined): string | null {
  if (!timeStr) return null;
  const match = timeStr.match(/^(\d{1,2}):(\d{1,2})$/);
  if (match) return `${match[1]}:${match[2]?.padStart(2, '0')}`;
  return timeStr;
}

function spawnLabel(val: string | number | null | undefined): string | null {
  if (val === undefined || val === null) return null;
  const num = parseFloat(String(val));
  if (isNaN(num)) return String(val);
  if (num === 0) return 'None';
  if (num === 1) return 'x1 (Default)';
  return `x${String(num)}`;
}

function difficultyLabel(val: string | number | null | undefined): string | null {
  if (val === undefined || val === null) return null;
  const idx = Math.round(parseFloat(String(val)));
  if (isNaN(idx)) return String(val);
  return DIFFICULTY_LABELS[idx] || String(val);
}

function difficultyBar(val: string | number | null | undefined): string | null {
  if (val === undefined || val === null) return null;
  const idx = Math.round(parseFloat(String(val)));
  if (isNaN(idx)) return String(val);
  const label = DIFFICULTY_LABELS[idx] || String(val);
  const bar = progressBar((idx + 1) / DIFFICULTY_LABELS.length, 5);
  return `${bar} ${label}`;
}

function settingBool(val: string | null | undefined): string | null {
  if (val === undefined || val === null) return null;
  return val === '1' || val.toLowerCase() === 'true' ? 'On' : 'Off';
}

function settingLabel(val: string | number | null | undefined, labels: string[]): string | null {
  if (val === undefined || val === null) return null;
  const num = parseFloat(String(val));
  if (isNaN(num)) return String(val);
  const idx = Math.round(num);
  return labels[idx] || String(val);
}

function settingMultiplier(val: string | number | null | undefined): string | null {
  if (val === undefined || val === null) return null;
  const num = parseFloat(String(val));
  if (isNaN(num)) return String(val);
  if (num === 0) return 'Off';
  if (num === 1) return 'Default';
  return `${String(num)}x`;
}

function settingDays(val: string | number | null | undefined, unit = 'days'): string | null {
  if (val === undefined || val === null) return null;
  const num = parseFloat(String(val));
  if (isNaN(num)) return String(val);
  if (num === 0) return 'Off';
  return `${String(num)} ${unit}`;
}

function settingPermaDeath(val: string | number | null | undefined): string | null {
  if (val === undefined || val === null) return null;
  const s = String(val).toLowerCase();
  if (s === 'true') return 'On';
  if (s === 'false') return 'Off';
  return settingLabel(val, ['Off', 'Individual', 'All']);
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

function buildSettingsFields(s: Record<string, any>, cfg: Record<string, any> = {}): FieldEntry[] {
  const fields: FieldEntry[] = [];

  function section(emoji: string, title: string, entries: [string, string | null][]): void {
    const rows = entries.filter(([, val]) => val != null).map(([label, val]) => `**${label}:** ${val}`);
    if (rows.length > 0) {
      fields.push({ name: `${emoji} ${title}`, value: rows.join('\n'), inline: true });
    }
  }

  // ── General ──
  if (cfg.showSettingsGeneral !== false) {
    section('\u2694\uFE0F', 'General', [
      ['PvP', settingBool(s.PVP)],
      ['Max Players', s.MaxPlayers as string | null],
      ['On Death', settingLabel(s.OnDeath, ON_DEATH_LABELS)],
      ['Perma Death', settingPermaDeath(s.PermaDeath)],
      ['Vital Drain', settingLabel(s.VitalDrain, VITAL_DRAIN_LABELS)],
      ['XP Multiplier', s.XpMultiplier != null ? `${s.XpMultiplier as string}x` : null],
    ]);
  }

  // ── Time & Seasons ──
  if (cfg.showSettingsTime !== false) {
    section('\uD83D\uDD50', 'Time & Seasons', [
      ['Day Length', s.DayDur != null ? `${s.DayDur as string} min` : null],
      ['Night Length', s.NightDur != null ? `${s.NightDur as string} min` : null],
      ['Season Length', s.DaysPerSeason != null ? `${s.DaysPerSeason as string} days` : null],
      ['Start Season', settingLabel(s.StartingSeason, ['Summer', 'Autumn', 'Winter', 'Spring'])],
    ]);
  }

  // ── Zombies ──
  if (cfg.showSettingsZombies !== false) {
    section('\uD83E\uDDDF', 'Zombies', [
      ['Health', difficultyLabel(s.ZombieDiffHealth)],
      ['Speed', difficultyLabel(s.ZombieDiffSpeed)],
      ['Damage', difficultyLabel(s.ZombieDiffDamage)],
      ['Spawns', spawnLabel(s.ZombieAmountMulti)],
      ['Respawn', s.ZombieRespawnTimer != null ? `${s.ZombieRespawnTimer as string} min` : null],
      ['Dogs', spawnLabel(s.ZombieDogMulti)],
    ]);
  }

  // ── Items ──
  if (cfg.showSettingsItems !== false) {
    const itemEntries: [string, string | null][] = [
      ['Weapon Break', settingBool(s.WeaponBreak)],
      ['Food Decay', settingMultiplier(s.FoodDecay)],
      ['Loot Respawn', s.LootRespawnTimer != null ? `${s.LootRespawnTimer as string} min` : null],
      ['Air Drops', settingBool(s.AirDrop)],
    ];
    if (s.AirDrop === '1' || s.AirDrop === 'true') {
      itemEntries.push([
        '  Interval',
        s.AirDropInterval != null
          ? `Every ${s.AirDropInterval as string} day${s.AirDropInterval === '1' ? '' : 's'}`
          : null,
      ]);
    }
    section('\uD83C\uDF92', 'Items', itemEntries);
  }

  // ── Extended settings (toggled) ──
  if (cfg.showExtendedSettings !== false) {
    if (cfg.showSettingsBandits !== false) {
      section('\uD83D\uDD2B', 'Bandits', [
        ['Health', difficultyLabel(s.HumanHealth)],
        ['Speed', difficultyLabel(s.HumanSpeed)],
        ['Damage', difficultyLabel(s.HumanDamage)],
        ['Spawns', spawnLabel(s.HumanAmountMulti)],
        ['Respawn', s.HumanRespawnTimer != null ? `${s.HumanRespawnTimer as string} min` : null],
        ['AI Events', settingLabel(s.AIEvent, AI_EVENT_LABELS)],
      ]);
    }

    if (cfg.showSettingsCompanions !== false) {
      section('\uD83D\uDC15', 'Companions', [
        ['Dog Companion', settingBool(s.DogEnabled)],
        ['Companion HP', settingLabel(s.CompanionHealth, ['Low', 'Default', 'High'])],
        ['Companion Dmg', settingLabel(s.CompanionDmg, ['Low', 'Default', 'High'])],
      ]);
    }

    if (cfg.showSettingsBuilding !== false) {
      section('\uD83C\uDFD7\uFE0F', 'Building', [
        ['Building HP', settingMultiplier(s.BuildingHealth)],
        ['Building Decay', settingDays(s.BuildingDecay)],
        ['Gen Fuel Rate', s.GenFuel != null ? `${s.GenFuel as string}x` : null],
        ['Territory', settingBool(s.Territory)],
        ['Dismantle Own', settingBool(s.AllowDismantle)],
        ['Dismantle House', settingBool(s.AllowHouseDismantle)],
      ]);
    }

    if (cfg.showSettingsVehicles !== false) {
      section('\uD83D\uDE97', 'Vehicles', [
        [
          'Max Cars',
          s.MaxOwnedCars != null ? (s.MaxOwnedCars === '0' ? 'Disabled' : (s.MaxOwnedCars as string)) : null,
        ],
      ]);
    }

    if (cfg.showSettingsAnimals !== false) {
      section('\uD83E\uDD8C', 'Animals', [
        ['Animal Spawns', spawnLabel(s.AnimalMulti)],
        ['Animal Respawn', s.AnimalRespawnTimer != null ? `${s.AnimalRespawnTimer as string} min` : null],
      ]);
    }
  }

  return fields;
}

function buildLootScarcity(s: Record<string, any>): string | null {
  const fb = s.LootRarity ?? undefined;
  const map: [string, string, any][] = [
    ['\uD83C\uDF56', 'Food', s.RarityFood ?? fb],
    ['\uD83E\uDD64', 'Drink', s.RarityDrink ?? fb],
    ['\uD83D\uDD2A', 'Melee', s.RarityMelee ?? fb],
    ['\uD83D\uDD2B', 'Ranged', s.RarityRanged ?? fb],
    ['\uD83D\uDEE1\uFE0F', 'Armor', s.RarityArmor ?? fb],
    ['\uD83E\uDDF1', 'Resources', s.RarityResources ?? fb],
    ['\uD83C\uDFAF', 'Ammo', s.RarityAmmo ?? fb],
    ['\uD83D\uDCE6', 'Other', s.RarityOther ?? fb],
  ];

  const rows = map
    .filter(([, , val]) => val != null)
    .map(([emoji, label, val]) => {
      const idx = Math.round(parseFloat(String(val))) || 0;
      const name = SCARCITY_LABELS[idx] || String(val);
      return `${emoji} **${label}:** ${name}`;
    });

  return rows.length > 0 ? rows.join('\n') : null;
}

function buildWeatherOdds(s: Record<string, any>): string | null {
  const weatherKeys: [string, string, any][] = [
    ['\u2600\uFE0F', 'Clear Sky', s.Weather_ClearSky],
    ['\u2601\uFE0F', 'Cloudy', s.Weather_Cloudy],
    ['\uD83C\uDF2B\uFE0F', 'Foggy', s.Weather_Foggy],
    ['\uD83C\uDF26\uFE0F', 'Light Rain', s.Weather_LightRain],
    ['\uD83C\uDF27\uFE0F', 'Rain', s.Weather_Rain],
    ['\u26C8\uFE0F', 'Thunderstorm', s.Weather_Thunderstorm],
    ['\uD83C\uDF28\uFE0F', 'Light Snow', s.Weather_LightSnow],
    ['\u2744\uFE0F', 'Snow', s.Weather_Snow],
    ['\uD83C\uDF2A\uFE0F', 'Blizzard', s.Weather_Blizzard],
  ];

  const rows = weatherKeys
    .filter(([, , val]) => val != null)
    .map(([emoji, label, val]) => {
      const num = parseFloat(String(val));
      const pct = isNaN(num) ? String(val) : `${String(Math.round(num * 100))}%`;
      return `${emoji} **${label}:** ${pct}`;
    });

  return rows.length > 0 ? rows.join('\n') : null;
}

function buildResourceField(res: Record<string, any>, fmtBytes?: (v: number) => string): FieldEntry[] {
  if (!fmtBytes) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      fmtBytes = (require('./server-resources') as { formatBytes: (v: number) => string }).formatBytes;
    } catch {
      fmtBytes = (v: number) => String(v);
    }
  }
  const parts: string[] = [];
  if (res.cpu != null) parts.push(`\uD83D\uDDA5\uFE0F CPU: **${res.cpu as number}%**`);
  if (res.memUsed != null && res.memTotal != null) {
    parts.push(
      `\uD83E\uDDE0 RAM: **${fmtBytes(res.memUsed as number)}** / ${fmtBytes(res.memTotal as number)} (${(res.memPercent as number | undefined) ?? '?'}%)`,
    );
  } else if (res.memPercent != null) {
    parts.push(`\uD83E\uDDE0 RAM: **${res.memPercent as number}%**`);
  }
  if (res.diskUsed != null && res.diskTotal != null) {
    parts.push(
      `\uD83D\uDCBE Disk: **${fmtBytes(res.diskUsed as number)}** / ${fmtBytes(res.diskTotal as number)} (${(res.diskPercent as number | undefined) ?? '?'}%)`,
    );
  } else if (res.diskPercent != null) {
    parts.push(`\uD83D\uDCBE Disk: **${res.diskPercent as number}%**`);
  }
  if (parts.length === 0) return [];
  return [{ name: '\uD83D\uDCE1 Host Resources', value: parts.join('\n'), inline: false }];
}

function buildScheduleField(cfg: Record<string, any>): { name: string; value: string } | null {
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

  // Daily rotation offset
  const dayOffset = getDayOffset(cfg.botTimezone as string, profiles.length, cfg.restartRotateDaily as boolean);

  // Determine active time slot
  const now = new Date();
  const timeStr = now.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: cfg.botTimezone as string,
  });
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
    if (!isNaN(zombieAmt)) desc.push(`${String(zombieAmt)}x zombies`);
    if (!isNaN(xp) && xp > 1) desc.push(`${String(xp)}x XP`);
    const loot = parseInt(settings.RarityMelee || settings.RarityFood || '', 10);
    if (!isNaN(loot) && loot > 2) desc.push('better loot');
    const displayName = name.charAt(0).toUpperCase() + name.slice(1);
    const marker = slotIdx === activeSlot ? ' \u25C0' : '';
    return `${startTime}\u2013${endTime as string} \u00B7 **${displayName}**${desc.length ? ' \u2014 ' + desc.join(', ') : ''}${marker}`;
  });

  return { name: '\uD83D\uDD04 Difficulty Schedule', value: lines.join('\n') };
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

const _mod = module as { exports: any };

_mod.exports = {
  DIFFICULTY_LABELS,
  SCARCITY_LABELS,
  ON_DEATH_LABELS,
  VITAL_DRAIN_LABELS,
  AI_EVENT_LABELS,
  formatTime,
  spawnLabel,
  difficultyLabel,
  difficultyBar,
  settingBool,
  settingLabel,
  settingMultiplier,
  settingDays,
  settingPermaDeath,
  progressBar,
  blockBar,
  weatherEmoji,
  seasonEmoji,
  timeEmoji,
  buildSettingsFields,
  buildLootScarcity,
  buildWeatherOdds,
  buildResourceField,
  buildScheduleField,
};

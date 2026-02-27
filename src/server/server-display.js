/**
 * ServerDisplay — shared formatting helpers for server status data.
 *
 * Pure functions for formatting server settings, loot scarcity, weather odds,
 * difficulty schedules, resource metrics, and visual helpers. Zero Discord
 * coupling — returns plain objects / strings consumable by Discord embeds,
 * web panel, RCON messages, and anywhere else.
 *
 * Consumers:
 *   - ServerStatus (Discord embed)
 *   - PanelChannel (admin dashboard)
 *   - AutoMessages (RCON welcome / broadcast)
 *   - Web panel API (dashboard, status cards)
 *   - RecapService, DidYouKnow, etc.
 *
 * @module server/server-display
 */

const { getDayOffset, getRotatedProfileIndex } = require('../modules/schedule-utils');

// ═══════════════════════════════════════════════════════════════════════════
//  Label constants
// ═══════════════════════════════════════════════════════════════════════════

const DIFFICULTY_LABELS = ['Very Easy', 'Easy', 'Default', 'Hard', 'Very Hard', 'Nightmare'];
const SCARCITY_LABELS   = ['Scarce', 'Low', 'Default', 'Plentiful', 'Abundant'];
const ON_DEATH_LABELS   = ['Backpack + Weapon', 'Pockets + Backpack', 'Everything'];
const VITAL_DRAIN_LABELS = ['Slow', 'Normal', 'Fast'];
const SPAWN_LABELS      = ['Low', 'Medium', 'High'];

// ═══════════════════════════════════════════════════════════════════════════
//  Value formatters
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Format a time string from RCON (e.g. "8:5" → "8:05").
 * @param {string} timeStr
 * @returns {string|null}
 */
function formatTime(timeStr) {
  if (!timeStr) return null;
  const match = timeStr.match(/^(\d{1,2}):(\d{1,2})$/);
  if (match) return `${match[1]}:${match[2].padStart(2, '0')}`;
  return timeStr;
}

/**
 * Spawn amount label: 0→Low, 1→Medium, 2→High, other→"x{n}".
 * @param {string|number} val
 * @returns {string|null}
 */
function spawnLabel(val) {
  if (val === undefined || val === null) return null;
  const num = parseFloat(val);
  if (isNaN(num)) return String(val);
  if (num === 0) return 'Low';
  if (num === 1) return 'Medium';
  if (num === 2) return 'High';
  return `x${num}`;
}

/**
 * Difficulty index (0–5) → label string.
 * @param {string|number} val
 * @returns {string|null}
 */
function difficultyLabel(val) {
  if (val === undefined || val === null) return null;
  const idx = Math.round(parseFloat(val));
  if (isNaN(idx)) return String(val);
  return DIFFICULTY_LABELS[idx] || String(val);
}

/**
 * Difficulty index → compact bar + label: "▓░░░░ V.Easy".
 * @param {string|number} val
 * @returns {string|null}
 */
function difficultyBar(val) {
  if (val === undefined || val === null) return null;
  const idx = Math.round(parseFloat(val));
  if (isNaN(idx)) return String(val);
  const label = DIFFICULTY_LABELS[idx] || String(val);
  const bar = progressBar((idx + 1) / DIFFICULTY_LABELS.length, 5);
  return `${bar} ${label}`;
}

/**
 * Boolean setting value → "On" / "Off".
 * @param {string} val
 * @returns {string|null}
 */
function settingBool(val) {
  if (val === undefined || val === null) return null;
  return val === '1' || String(val).toLowerCase() === 'true' ? 'On' : 'Off';
}

/**
 * Numeric setting → label from a provided array.
 * @param {string|number} val
 * @param {string[]} labels
 * @returns {string|null}
 */
function settingLabel(val, labels) {
  if (val === undefined || val === null) return null;
  const num = parseFloat(val);
  if (isNaN(num)) return String(val);
  const idx = Math.round(num);
  return labels[idx] || String(val);
}

// ═══════════════════════════════════════════════════════════════════════════
//  Visual helpers
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Unicode progress bar. Default style uses ▓░ (thin); pass chars for other styles.
 * @param {number} ratio - 0–1
 * @param {number} [width=10]
 * @param {string} [filledChar='▓']
 * @param {string} [emptyChar='░']
 * @returns {string}
 */
function progressBar(ratio, width = 10, filledChar = '▓', emptyChar = '░') {
  const r = Math.max(0, Math.min(1, ratio));
  const filled = Math.round(r * width);
  return filledChar.repeat(filled) + emptyChar.repeat(width - filled);
}

/**
 * Block-style progress bar (█░) used by panel-channel.
 * @param {number} ratio - 0–1
 * @param {number} [width=12]
 * @returns {string}
 */
function blockBar(ratio, width = 12) {
  return progressBar(ratio, width, '█', '░');
}

// ═══════════════════════════════════════════════════════════════════════════
//  Emoji helpers
// ═══════════════════════════════════════════════════════════════════════════

/** Map in-game weather string to an emoji. */
function weatherEmoji(weather) {
  if (!weather) return '';
  const w = weather.toLowerCase();
  if (w.includes('thunder'))    return '⛈️ ';
  if (w.includes('blizzard'))   return '🌪️ ';
  if (w.includes('heavy') && w.includes('snow')) return '❄️ ';
  if (w.includes('snow'))       return '🌨️ ';
  if (w.includes('heavy') && w.includes('rain')) return '🌧️ ';
  if (w.includes('rain'))       return '🌦️ ';
  if (w.includes('fog'))        return '🌫️ ';
  if (w.includes('cloud') || w.includes('overcast')) return '☁️ ';
  if (w.includes('sun') || w.includes('clear')) return '☀️ ';
  return '🌤️ ';
}

/** Map in-game season string to an emoji. */
function seasonEmoji(season) {
  if (!season) return '';
  const s = season.toLowerCase();
  if (s.includes('summer')) return '☀️ ';
  if (s.includes('autumn') || s.includes('fall')) return '🍂 ';
  if (s.includes('winter')) return '❄️ ';
  if (s.includes('spring')) return '🌱 ';
  return '';
}

/** Map game time (HH:MM) to a time-of-day emoji. */
function timeEmoji(timeStr) {
  if (!timeStr) return '';
  const match = timeStr.match(/^(\d{1,2})/);
  if (!match) return '';
  const hour = parseInt(match[1], 10);
  if (hour >= 6 && hour < 8)   return '🌅 ';  // dawn
  if (hour >= 8 && hour < 17)  return '☀️ ';  // day
  if (hour >= 17 && hour < 19) return '🌇 ';  // dusk
  return '🌙 ';                                // night
}

// ═══════════════════════════════════════════════════════════════════════════
//  Compound field builders (return plain objects, not EmbedBuilder fields)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build server settings as an array of { name, value, inline } objects.
 * Each section becomes its own column in a Discord embed grid (3 per row).
 *
 * @param {object} s - Server settings (flat key→value from GameServerSettings.ini)
 * @param {object} [cfg] - Config object with SHOW_* toggles
 * @returns {Array<{name: string, value: string, inline: boolean}>}
 */
function buildSettingsFields(s, cfg = {}) {
  const fields = [];

  function section(emoji, title, entries) {
    const rows = entries.filter(([, val]) => val != null).map(([label, val]) => `**${label}:** ${val}`);
    if (rows.length > 0) {
      fields.push({ name: `${emoji} ${title}`, value: rows.join('\n'), inline: true });
    }
  }

  // ── General ──
  if (cfg.showSettingsGeneral !== false) {
    section('⚔️', 'General', [
      ['PvP',           settingBool(s.PVP)],
      ['Max Players',   s.MaxPlayers],
      ['On Death',      settingLabel(s.OnDeath, ON_DEATH_LABELS)],
      ['Perma Death',   settingLabel(s.PermaDeath, ['Off', 'Individual', 'All'])],
      ['Vital Drain',   settingLabel(s.VitalDrain, VITAL_DRAIN_LABELS)],
      ['XP Multiplier', s.XpMultiplier != null ? `${s.XpMultiplier}x` : null],
    ]);
  }

  // ── Time & Seasons ──
  if (cfg.showSettingsTime !== false) {
    section('🕐', 'Time & Seasons', [
      ['Day Length',    s.DayDur != null ? `${s.DayDur} min` : null],
      ['Night Length',  s.NightDur != null ? `${s.NightDur} min` : null],
      ['Season Length', s.DaysPerSeason != null ? `${s.DaysPerSeason} days` : null],
      ['Start Season',  settingLabel(s.StartingSeason, ['Summer', 'Autumn', 'Winter', 'Spring'])],
    ]);
  }

  // ── Zombies ──
  if (cfg.showSettingsZombies !== false) {
    section('🧟', 'Zombies', [
      ['Health',   difficultyLabel(s.ZombieDiffHealth)],
      ['Speed',    difficultyLabel(s.ZombieDiffSpeed)],
      ['Damage',   difficultyLabel(s.ZombieDiffDamage)],
      ['Spawns',   spawnLabel(s.ZombieAmountMulti)],
      ['Respawn',  s.ZombieRespawnTimer != null ? `${s.ZombieRespawnTimer} min` : null],
      ['Dogs',     spawnLabel(s.ZombieDogMulti)],
    ]);
  }

  // ── Items ──
  if (cfg.showSettingsItems !== false) {
    const itemEntries = [
      ['Weapon Break', settingBool(s.WeaponBreak)],
      ['Food Decay',   settingBool(s.FoodDecay)],
      ['Loot Respawn', s.LootRespawnTimer != null ? `${s.LootRespawnTimer} min` : null],
      ['Air Drops',    settingBool(s.AirDrop)],
    ];
    if (s.AirDrop === '1' || s.AirDrop === 'true') {
      itemEntries.push(['  Interval', s.AirDropInterval != null ? `Every ${s.AirDropInterval} day${s.AirDropInterval === '1' ? '' : 's'}` : null]);
    }
    section('🎒', 'Items', itemEntries);
  }

  // ── Extended settings (toggled) ──
  if (cfg.showExtendedSettings !== false) {
    // Bandits
    if (cfg.showSettingsBandits !== false) {
      section('🔫', 'Bandits', [
        ['Health',  difficultyLabel(s.HumanHealth)],
        ['Speed',   difficultyLabel(s.HumanSpeed)],
        ['Damage',  difficultyLabel(s.HumanDamage)],
        ['Spawns',  spawnLabel(s.HumanAmountMulti)],
        ['Respawn', s.HumanRespawnTimer != null ? `${s.HumanRespawnTimer} min` : null],
        ['AI Events', settingLabel(s.AIEvent, ['Off', 'Low', 'Default'])],
      ]);
    }

    // Companions
    if (cfg.showSettingsCompanions !== false) {
      section('🐕', 'Companions', [
        ['Dog Companion', settingBool(s.DogEnabled)],
        ['Companion HP',  settingLabel(s.CompanionHealth, ['Low', 'Default', 'High'])],
        ['Companion Dmg', settingLabel(s.CompanionDmg, ['Low', 'Default', 'High'])],
      ]);
    }

    // Building & Territory
    if (cfg.showSettingsBuilding !== false) {
      section('🏗️', 'Building', [
        ['Building HP',     settingLabel(s.BuildingHealth, VITAL_DRAIN_LABELS)],
        ['Building Decay',  settingBool(s.BuildingDecay)],
        ['Gen Fuel Rate',   s.GenFuel != null ? `${s.GenFuel}x` : null],
        ['Territory',       settingBool(s.Territory)],
        ['Dismantle Own',   settingBool(s.AllowDismantle)],
        ['Dismantle House', settingBool(s.AllowHouseDismantle)],
      ]);
    }

    // Vehicles
    if (cfg.showSettingsVehicles !== false) {
      section('🚗', 'Vehicles', [
        ['Max Cars', s.MaxOwnedCars != null ? (s.MaxOwnedCars === '0' ? 'Disabled' : s.MaxOwnedCars) : null],
      ]);
    }

    // Animals
    if (cfg.showSettingsAnimals !== false) {
      section('🦌', 'Animals', [
        ['Animal Spawns',  spawnLabel(s.AnimalMulti)],
        ['Animal Respawn', s.AnimalRespawnTimer != null ? `${s.AnimalRespawnTimer} min` : null],
      ]);
    }
  }

  return fields;
}

/**
 * Build loot scarcity lines from server settings.
 * @param {object} s - Server settings
 * @returns {string|null} Formatted multi-line string, or null if no data
 */
function buildLootScarcity(s) {
  const map = [
    ['🍖', 'Food',      s.RarityFood],
    ['🥤', 'Drink',     s.RarityDrink],
    ['🔪', 'Melee',     s.RarityMelee],
    ['🔫', 'Ranged',    s.RarityRanged],
    ['🛡️', 'Armor',     s.RarityArmor],
    ['🧱', 'Resources', s.RarityResources],
    ['🎯', 'Ammo',      s.RarityAmmo],
    ['📦', 'Other',     s.RarityOther],
  ];

  const rows = map
    .filter(([, , val]) => val != null)
    .map(([emoji, label, val]) => {
      const idx = Math.round(parseFloat(val)) || 0;
      const name = SCARCITY_LABELS[idx] || val;
      return `${emoji} **${label}:** ${name}`;
    });

  return rows.length > 0 ? rows.join('\n') : null;
}

/**
 * Build weather odds lines from server settings.
 * @param {object} s - Server settings
 * @returns {string|null} Formatted multi-line string, or null if no data
 */
function buildWeatherOdds(s) {
  const weatherKeys = [
    ['☀️', 'Clear Sky',    s.Weather_ClearSky],
    ['☁️', 'Cloudy',       s.Weather_Cloudy],
    ['🌫️', 'Foggy',        s.Weather_Foggy],
    ['🌦️', 'Light Rain',   s.Weather_LightRain],
    ['🌧️', 'Rain',         s.Weather_Rain],
    ['⛈️', 'Thunderstorm', s.Weather_Thunderstorm],
    ['🌨️', 'Light Snow',   s.Weather_LightSnow],
    ['❄️', 'Snow',         s.Weather_Snow],
    ['🌪️', 'Blizzard',     s.Weather_Blizzard],
  ];

  const rows = weatherKeys
    .filter(([, , val]) => val != null)
    .map(([emoji, label, val]) => {
      const num = parseFloat(val);
      const pct = isNaN(num) ? val : `${Math.round(num * 100)}%`;
      return `${emoji} **${label}:** ${pct}`;
    });

  return rows.length > 0 ? rows.join('\n') : null;
}

/**
 * Build host resource metrics as an array of { name, value, inline } objects.
 * @param {object} res - { cpu, memUsed, memTotal, memPercent, diskUsed, diskTotal, diskPercent }
 * @param {Function} [fmtBytes] - Byte formatter (defaults to server-resources.formatBytes)
 * @returns {Array<{name: string, value: string, inline: boolean}>}
 */
function buildResourceField(res, fmtBytes) {
  if (!fmtBytes) {
    try { fmtBytes = require('./server-resources').formatBytes; } catch (_) { fmtBytes = v => `${v}`; }
  }
  const parts = [];
  if (res.cpu != null) parts.push(`🖥️ CPU: **${res.cpu}%**`);
  if (res.memUsed != null && res.memTotal != null) {
    parts.push(`🧠 RAM: **${fmtBytes(res.memUsed)}** / ${fmtBytes(res.memTotal)} (${res.memPercent ?? '?'}%)`);
  } else if (res.memPercent != null) {
    parts.push(`🧠 RAM: **${res.memPercent}%**`);
  }
  if (res.diskUsed != null && res.diskTotal != null) {
    parts.push(`💾 Disk: **${fmtBytes(res.diskUsed)}** / ${fmtBytes(res.diskTotal)} (${res.diskPercent ?? '?'}%)`);
  } else if (res.diskPercent != null) {
    parts.push(`💾 Disk: **${res.diskPercent}%**`);
  }
  if (parts.length === 0) return [];
  return [{ name: '📡 Host Resources', value: parts.join('\n'), inline: false }];
}

/**
 * Build a difficulty schedule field from config.
 * Returns { name, value } or null if scheduler is disabled.
 *
 * @param {object} cfg - Config with enableServerScheduler, restartTimes, etc.
 * @returns {{ name: string, value: string }|null}
 */
function buildScheduleField(cfg) {
  if (!cfg.enableServerScheduler) return null;
  const timesStr = cfg.restartTimes || process.env.RESTART_TIMES || '';
  const profilesStr = cfg.restartProfiles || process.env.RESTART_PROFILES || '';
  const times = timesStr.split(',').map(s => s.trim()).filter(Boolean);
  const profiles = profilesStr.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (times.length === 0 || profiles.length === 0) return null;

  // Daily rotation offset
  const dayOffset = getDayOffset(cfg.botTimezone, profiles.length, cfg.restartRotateDaily);

  // Determine active time slot
  const now = new Date();
  const timeStr = now.toLocaleTimeString('en-GB', {
    hour: '2-digit', minute: '2-digit', hour12: false,
    timeZone: cfg.botTimezone,
  });
  const [h, m] = timeStr.split(':').map(Number);
  const nowMin = h * 60 + m;
  const timeMins = times.map(t => { const [th, tm] = t.split(':').map(Number); return th * 60 + (tm || 0); });
  let activeSlot = 0;
  for (let i = timeMins.length - 1; i >= 0; i--) {
    if (nowMin >= timeMins[i]) { activeSlot = i; break; }
  }

  // Build schedule lines
  const lines = times.map((startTime, slotIdx) => {
    const profileIdx = getRotatedProfileIndex(slotIdx, profiles.length, dayOffset);
    const name = profiles[profileIdx];
    const envKey = `RESTART_PROFILE_${name.toUpperCase()}`;
    let settings = {};
    try { settings = JSON.parse(process.env[envKey] || '{}'); } catch {}
    const endTime = times[(slotIdx + 1) % times.length] || times[0];
    const desc = [];
    const zombieAmt = parseFloat(settings.ZombieAmountMulti);
    const xp = parseFloat(settings.XpMultiplier);
    if (!isNaN(zombieAmt)) desc.push(`${zombieAmt}x zombies`);
    if (!isNaN(xp) && xp > 1) desc.push(`${xp}x XP`);
    const loot = parseInt(settings.RarityMelee || settings.RarityFood, 10);
    if (!isNaN(loot) && loot > 2) desc.push('better loot');
    const displayName = name.charAt(0).toUpperCase() + name.slice(1);
    const marker = slotIdx === activeSlot ? ' ◀' : '';
    return `${startTime}–${endTime} · **${displayName}**${desc.length ? ' — ' + desc.join(', ') : ''}${marker}`;
  });

  return { name: '🔄 Difficulty Schedule', value: lines.join('\n') };
}

// ═══════════════════════════════════════════════════════════════════════════
//  Exports
// ═══════════════════════════════════════════════════════════════════════════

module.exports = {
  // Label constants
  DIFFICULTY_LABELS,
  SCARCITY_LABELS,
  ON_DEATH_LABELS,
  VITAL_DRAIN_LABELS,
  SPAWN_LABELS,

  // Value formatters
  formatTime,
  spawnLabel,
  difficultyLabel,
  difficultyBar,
  settingBool,
  settingLabel,

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

/**
 * Auto-messages content layer — text generation for RCON and WelcomeMessage.txt.
 *
 * All functions here are pure text generators with no Discord, RCON, or SFTP
 * dependency. They can be reused by the web panel, recap service, etc.
 *
 * Standalone functions are exported directly.
 * Instance methods (_difficultyText, _pvpScheduleText) are mixed into
 * AutoMessages.prototype by auto-messages.js.
 */

const _defaultConfig = require('../config');
const _defaultPlaytime = require('../tracking/playtime-tracker');
const _defaultPlayerStats = require('../tracking/player-stats');
const { getServerInfo } = require('../rcon/server-info');
const { getDayOffset, getRotatedProfileIndex } = require('./schedule-utils');
const { difficultyLabel: diffLabel, spawnLabel, DIFFICULTY_LABELS } = require('../server/server-display');

// ── Color tag helpers for RCON messages ──────────────────
const { COLOR } = require('../rcon/rcon-colors');

/**
 * Color helper for WelcomeMessage.txt file context.
 * Unlike RCON admin commands, the welcome file needs explicit closing tags:
 *   <TAG>text</>
 * This matches the game's rich text parser for the welcome popup.
 */
function fileColor(tag, text) {
  return `<${COLOR[tag] || tag}>${text}</>`;
}

/**
 * Colorize a Discord invite link for WelcomeMessage.txt:
 * "Discord" portion → blue, rest unchanged.
 */
function _colorLink(link) {
  if (!link) return '';
  return link.replace(/discord/i, (m) => fileColor('blue', m));
}

/**
 * Colorize a Discord invite link for RCON admin messages:
 * "discord.gg" → blue, the ID after → back to gray.
 * Caller is responsible for the surrounding color context.
 */
function _rconColorLink(link) {
  if (!link) return '';
  const m = link.match(/^(.*?discord\.gg)(\/.*)$/i);
  if (!m) return link;
  return `</><CL>${m[1]}</><FO>${m[2] || ''}`;
}

// ── Standalone helpers ───────────────────────────────────────

function loadCachedSettings(db) {
  try {
    if (db) {
      const data = db.getStateJSON('server_settings', null);
      if (data) return data;
    }
  } catch (_) {}
  return {};
}

function loadWelcomeStats(db) {
  try {
    if (db) {
      const data = db.getStateJSON('welcome_stats', null);
      if (data) return data;
    }
  } catch (_) {}
  return {};
}

function formatMs(ms) {
  if (!ms || ms <= 0) return '0m';
  const totalMin = Math.floor(ms / 60000);
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const mins = totalMin % 60;
  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (mins > 0 || parts.length === 0) parts.push(`${mins}m`);
  return parts.join(' ');
}

function _getTimePartsInTz(date, timeZone) {
  const parts = new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone,
  }).formatToParts(date);
  const hour = parseInt(parts.find((p) => p.type === 'hour')?.value || '0', 10);
  const minute = parseInt(parts.find((p) => p.type === 'minute')?.value || '0', 10);
  return { hour, minute };
}

function _getWeekdayInTz(date, timeZone) {
  const parts = new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone,
  }).formatToParts(date);
  const year = parseInt(parts.find((p) => p.type === 'year')?.value || '1970', 10);
  const month = parseInt(parts.find((p) => p.type === 'month')?.value || '1', 10);
  const day = parseInt(parts.find((p) => p.type === 'day')?.value || '1', 10);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/**
 * Static PvP schedule label (no live countdown).
 * Returns e.g. "PvP Schedule: Mon, Wed, Fri 18:00-22:00 UTC" or ''.
 */
function pvpScheduleLabel() {
  if (!_defaultConfig.enablePvpScheduler) return '';
  const startMin = _defaultConfig.pvpStartMinutes;
  const endMin   = _defaultConfig.pvpEndMinutes;
  if (isNaN(startMin) || isNaN(endMin)) return '';
  const fmt = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const pvpDays = _defaultConfig.pvpDays;
  const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const daysLabel = pvpDays
    ? [...pvpDays].sort().map(d => DAY_NAMES[d]).join(', ') + ' '
    : '';
  return `PvP Schedule: ${daysLabel}${fmt(startMin)}\u2013${fmt(endMin)} ${_defaultConfig.botTimezone}`;
}

/**
 * Build dynamic difficulty schedule lines for WelcomeMessage.txt.
 * Reads RESTART_TIMES + RESTART_PROFILES from env to show the rotating windows.
 * Highlights the currently active profile based on time.
 * When RESTART_ROTATE_DAILY is on, profile↔slot mapping shifts each day.
 */
function difficultyScheduleLines(cfg) {
  if (!cfg.enableServerScheduler) return [];
  const timesStr = cfg.restartTimes || process.env.RESTART_TIMES || '';
  const profilesStr = cfg.restartProfiles || process.env.RESTART_PROFILES || '';
  const times = timesStr.split(',').map(s => s.trim()).filter(Boolean);
  const profiles = profilesStr.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (times.length === 0 || profiles.length === 0) return [];

  // Daily rotation offset
  const dayOffset = getDayOffset(cfg.botTimezone, profiles.length, cfg.restartRotateDaily);

  // Determine active time slot
  const now = new Date();
  const { hour: h, minute: m } = _getTimePartsInTz(now, cfg.botTimezone);
  const nowMin = h * 60 + m;
  const timeMins = times.map(t => {
    const [th, tm] = t.split(':').map(Number);
    return th * 60 + (tm || 0);
  });
  let activeSlot = 0;
  for (let i = timeMins.length - 1; i >= 0; i--) {
    if (nowMin >= timeMins[i]) { activeSlot = i; break; }
  }

  // Build lines — iterate by time slot, resolve profile via rotation
  const lines = [];
  lines.push(fileColor('ember', '--- Difficulty Schedule ---'));
  for (let slotIdx = 0; slotIdx < times.length; slotIdx++) {
    const profileIdx = getRotatedProfileIndex(slotIdx, profiles.length, dayOffset);
    const name = profiles[profileIdx];
    const envKey = `RESTART_PROFILE_${name.toUpperCase()}`;
    let settings = {};
    try { settings = JSON.parse(process.env[envKey] || '{}'); } catch {}
    const startTime = times[slotIdx];
    const endTime = times[(slotIdx + 1) % times.length] || times[0];
    // Build a short description
    const zombieAmt = parseFloat(settings.ZombieAmountMulti);
    const xp = parseFloat(settings.XpMultiplier);
    const desc = [];
    if (!isNaN(zombieAmt)) {
      if (zombieAmt <= 0.6) desc.push('Few Zombies');
      else if (zombieAmt <= 1.2) desc.push('More Zombies');
      else desc.push(`${zombieAmt}x Zombies`);
    }
    if (!isNaN(xp) && xp > 1) desc.push(`${xp}x XP`);
    const lootLevel = parseInt(settings.RarityMelee || settings.RarityFood, 10);
    if (!isNaN(lootLevel) && lootLevel > 2) desc.push('Better Loot');
    const descStr = desc.join(', ') || name;
    const label = `${startTime}\u2013${endTime}`;
    const isActive = slotIdx === activeSlot;
    const marker = isActive ? ' \u25c0 NOW' : '';
    const nameDisplay = name.charAt(0).toUpperCase() + name.slice(1);
    const profileColors = { calm: 'green', surge: 'ember', horde: 'red' };
    const nameColor = profileColors[name] || 'gray';
    if (isActive) {
      lines.push(`${fileColor(nameColor, nameDisplay)} ${fileColor('gray', label)} ${fileColor('gray', descStr)}${fileColor('ember', marker)}`);
    } else {
      lines.push(`${fileColor(nameColor, nameDisplay)} ${fileColor('gray', label)} ${fileColor('gray', descStr)}`);
    }
  }
  return lines;
}

/**
 * Build the WelcomeMessage.txt content using cached data files.
 * Exported so player-stats-channel can call it after save polls.
 * No RCON required — uses cached server-settings.json for server name.
 */
async function buildWelcomeContent(deps = {}) {
  const cfg = deps.config || _defaultConfig;
  const pt = deps.playtime || _defaultPlaytime;
  const ps = deps.playerStats || _defaultPlayerStats;
  const getInfo = deps.getServerInfo || getServerInfo;
  const db = deps.db || null;
  const settings = loadCachedSettings(db);
  const parts = [];

  // ── Title ──
  let serverName = '';
  try { serverName = (await getInfo()).name || ''; } catch {}
  if (!serverName && settings.ServerName) {
    serverName = settings.ServerName.replace(/^"|"$/g, '');
  }
  serverName = serverName.replace(/\s*[-\u2013\u2014|\xb7:]*\s*discord\.\w+\/\S*/gi, '').trim();
  if (serverName.length > 60) serverName = serverName.substring(0, 57) + '...';
  parts.push(fileColor('ember', serverName ? `Welcome to ${serverName}!` : 'Welcome to the server!'));

  // ── Key Settings ──
  if (Object.keys(settings).length > 0) {
    const sp = [];
    const zombieHealth = diffLabel(settings.ZombieDiffHealth);
    const zombieSpawns = spawnLabel(settings.ZombieAmountMulti);
    if (zombieHealth) sp.push(`Zombies: ${zombieHealth}`);
    if (zombieSpawns && zombieSpawns !== 'Medium') sp.push(`Spawns: ${zombieSpawns}`);
    if (settings.LootRespawnTimer) sp.push(`Loot: ${settings.LootRespawnTimer}m`);
    const pvpOn = settings.PVP === '1' || settings.PVP === 'true';
    sp.push(`PvP: ${pvpOn ? 'On' : 'Off'}`);
    if (sp.length > 0) parts.push(fileColor('gray', sp.join('  |  ')));
  }

  // ── PvP schedule ──
  const pvpLabel = pvpScheduleLabel();
  if (pvpLabel) parts.push(fileColor('ember', pvpLabel));

  // ── Dynamic difficulty schedule ──
  const scheduleLines = difficultyScheduleLines(cfg);
  if (scheduleLines.length > 0) {
    parts.push('');
    parts.push(...scheduleLines);
  }

  // ── Helper: build an inline row of top entries ──
  const RANKS = ['1st', '2nd', '3rd'];
  function inlineRow(entries, colorTag) {
    return entries.map((text, i) =>
      `${fileColor(colorTag, RANKS[i])} ${text}`
    ).join('  |  ');
  }

  // ── Leaderboards ──
  const leaderboard = pt.getLeaderboard();
  const welcomeStats = loadWelcomeStats(db);

  if (leaderboard.length > 0) {
    parts.push('');
    parts.push(fileColor('ember', '--- Top Survivors ---'));
    const top = leaderboard.slice(0, 3).map(e =>
      `${fileColor('green', e.name)} - ${fileColor('gray', formatMs(e.totalMs))}`
    );
    parts.push(inlineRow(top, 'ember'));
  }

  if (welcomeStats.topKillers && welcomeStats.topKillers.length > 0) {
    parts.push(fileColor('ember', '--- Top Zombie Killers ---'));
    const topK = welcomeStats.topKillers.slice(0, 3).map(e =>
      `${fileColor('green', e.name)} - ${fileColor('gray', e.kills.toLocaleString() + ' kills')}`
    );
    parts.push(inlineRow(topK, 'ember'));
  }

  if (welcomeStats.topPvpKillers && welcomeStats.topPvpKillers.length > 0) {
    parts.push(fileColor('ember', '--- Top PvP Killers ---'));
    const topP = welcomeStats.topPvpKillers.slice(0, 3).map(e =>
      `${fileColor('green', e.name)} - ${fileColor('gray', e.kills + ' kills')}`
    );
    parts.push(inlineRow(topP, 'ember'));
  }

  // ── Fun stats (compact single-line: top fisher + most bitten) ──
  const funParts = [];
  if (welcomeStats.topFishers && welcomeStats.topFishers.length > 0) {
    const f = welcomeStats.topFishers[0];
    funParts.push(`${fileColor('ember', 'Top Fisher:')} ${fileColor('green', f.name)} ${fileColor('gray', f.count + ' fish')}`);
  }
  if (welcomeStats.topBitten && welcomeStats.topBitten.length > 0) {
    const b = welcomeStats.topBitten[0];
    funParts.push(`${fileColor('ember', 'Most Bitten:')} ${fileColor('green', b.name)} ${fileColor('gray', b.count + ' bites')}`);
  }
  if (funParts.length > 0) {
    parts.push(funParts.join('  |  '));
  }

  // ── Clans (each on own line for clarity) ──
  if (welcomeStats.topClans && welcomeStats.topClans.length > 0) {
    parts.push(fileColor('ember', '--- Top Clans ---'));
    const topC = welcomeStats.topClans.slice(0, 3);
    topC.forEach((c, i) => {
      const pt = formatMs(c.playtimeMs || 0);
      const mem = c.members === 1 ? '1 member' : `${c.members} members`;
      parts.push(`${fileColor('ember', RANKS[i])} ${fileColor('green', c.name)} ${fileColor('gray', '(' + mem + ')')} - ${fileColor('gray', c.kills.toLocaleString() + ' kills')} - ${fileColor('gray', pt + ' played')}`);
    });
  }

  // ── Weekly Highlights (single line, #1 per category) ──
  const w = welcomeStats.weekly;
  if (w) {
    const wp = [];
    if (w.topKillers?.length > 0)    wp.push(`${fileColor('ember', 'Kills:')} ${fileColor('green', w.topKillers[0].name)} ${fileColor('gray', String(w.topKillers[0].kills))}`);
    if (w.topPvpKillers?.length > 0) wp.push(`${fileColor('ember', 'PvP:')} ${fileColor('green', w.topPvpKillers[0].name)} ${fileColor('gray', String(w.topPvpKillers[0].kills))}`);
    if (w.topPlaytime?.length > 0)   wp.push(`${fileColor('ember', 'Time:')} ${fileColor('green', w.topPlaytime[0].name)} ${fileColor('gray', formatMs(w.topPlaytime[0].ms))}`);
    if (w.topFishers?.length > 0)    wp.push(`${fileColor('ember', 'Fish:')} ${fileColor('green', w.topFishers[0].name)} ${fileColor('gray', String(w.topFishers[0].count))}`);
    if (wp.length > 0) {
      parts.push(fileColor('ember', '--- This Week ---'));
      parts.push(wp.join('  |  '));
    }
  }

  // ── Footer ──
  const allLog = ps.getAllPlayers();
  if (allLog.length > 0) {
    const totalDeaths = allLog.reduce((s, p) => s + p.deaths, 0);
    const totalBuilds = allLog.reduce((s, p) => s + p.builds, 0);
    const totalLooted = allLog.reduce((s, p) => s + p.containersLooted, 0);
    const sp = [];
    if (totalDeaths > 0) sp.push(`${totalDeaths} Deaths`);
    if (totalBuilds > 0) sp.push(`${totalBuilds} Builds`);
    if (totalLooted > 0) sp.push(`${totalLooted} Looted`);
    if (sp.length > 0) {
      parts.push(fileColor('gray', sp.join('  |  ')));
    }
  }

  // ── Update note ──
  const updateInfo = fileColor('gray', 'Updated each restart');

  if (cfg.discordInviteLink) {
    parts.push(`Type ${fileColor('red', '!admin')} for help  |  Join our ${fileColor('blue', 'Discord:')} ${_colorLink(cfg.discordInviteLink)}  |  ${updateInfo}`);
  } else {
    parts.push(`Type ${fileColor('red', '!admin')} in chat for help  |  ${updateInfo}`);
  }

  return parts.join('\n');
}

// ── Instance methods (mixed into AutoMessages.prototype) ─────

/** Short inline text about current difficulty profile for RCON welcome. */
function _difficultyText() {
  const cfg = this._config;
  if (!cfg.enableServerScheduler) return '';
  const profilesStr = cfg.restartProfiles || process.env.RESTART_PROFILES || '';
  const timesStr = cfg.restartTimes || process.env.RESTART_TIMES || '';
  const profiles = profilesStr.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const times = timesStr.split(',').map(s => s.trim()).filter(Boolean);
  if (profiles.length === 0 || times.length === 0) return '';

  // Daily rotation offset
  const dayOffset = getDayOffset(cfg.botTimezone, profiles.length, cfg.restartRotateDaily);

  // Determine active time slot
  const now = new Date();
  const { hour: h, minute: m } = _getTimePartsInTz(now, cfg.botTimezone);
  const nowMin = h * 60 + m;
  const timeMins = times.map(t => { const [th, tm] = t.split(':').map(Number); return th * 60 + (tm || 0); });
  let activeSlot = 0;
  for (let i = timeMins.length - 1; i >= 0; i--) {
    if (nowMin >= timeMins[i]) { activeSlot = i; break; }
  }

  // Resolve profile for this slot via rotation
  const profileIdx = getRotatedProfileIndex(activeSlot, profiles.length, dayOffset);
  const name = profiles[profileIdx];
  const displayName = name.charAt(0).toUpperCase() + name.slice(1);
  // Find next restart
  let nextTime = null;
  for (const t of timeMins) { if (t > nowMin) { nextTime = t; break; } }
  if (nextTime === null) nextTime = timeMins[0] + 1440; // tomorrow
  const minsLeft = nextTime - nowMin;
  const hrs = Math.floor(minsLeft / 60);
  const mins = minsLeft % 60;
  const timeLeft = hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;
  // Profile color: calm=green, surge=ember, horde=red
  const profileColors = { calm: 'PR', surge: 'SP', horde: 'PN' };
  const ptag = profileColors[name] || 'FO';
  return `</><SP> | </><FO>Difficulty: </><${ptag}>${displayName}</><FO> (</><PR>${timeLeft}</><FO> left)`;
}

function _pvpScheduleText() {
  if (!this._config.enablePvpScheduler) return '';
  const defaultStart = this._config.pvpStartMinutes;
  const defaultEnd   = this._config.pvpEndMinutes;
  const pvpDayHours  = this._config.pvpDayHours; // Map<dayNum, { start, end }> | null

  // Need at least global defaults OR per-day overrides
  const hasDefaults = !isNaN(defaultStart) && !isNaN(defaultEnd);
  if (!hasDefaults && (!pvpDayHours || pvpDayHours.size === 0)) return '';

  const fmt = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const pvpDays = this._config.pvpDays; // null = every day

  // Get current time in the configured timezone
  const now = new Date();
  const { hour: h, minute: m } = _getTimePartsInTz(now, this._config.botTimezone);
  const nowMin = h * 60 + m;

  // Day of week in bot timezone
  const dayOfWeek = _getWeekdayInTz(now, this._config.botTimezone);

  // Resolve hours for a given day (per-day override or global default)
  const getHours = (day) => {
    if (pvpDayHours && pvpDayHours.has(day)) return pvpDayHours.get(day);
    if (hasDefaults) return { start: defaultStart, end: defaultEnd };
    return { start: undefined, end: undefined };
  };

  const { start: startMin, end: endMin } = getHours(dayOfWeek);

  // Check if currently inside PvP window (same logic as pvp-scheduler)
  let insidePvp = false;
  if (startMin !== undefined && endMin !== undefined) {
    if (startMin < endMin) {
      const dayOk = !pvpDays || pvpDays.has(dayOfWeek);
      insidePvp = dayOk && nowMin >= startMin && nowMin < endMin;
    } else {
      const prevDay = (dayOfWeek + 6) % 7;
      const prev = getHours(prevDay);
      const startDayOk = !pvpDays || pvpDays.has(dayOfWeek);
      const prevDayOk  = !pvpDays || pvpDays.has(prevDay);
      if (prevDayOk && prev.start !== undefined && prev.end !== undefined && prev.start > prev.end && nowMin < prev.end) {
        insidePvp = true;
      } else {
        insidePvp = startDayOk && nowMin >= startMin;
      }
    }
  } else {
    // Check yesterday's overnight tail
    const prevDay = (dayOfWeek + 6) % 7;
    const prev = getHours(prevDay);
    const prevDayOk = !pvpDays || pvpDays.has(prevDay);
    if (prevDayOk && prev.start !== undefined && prev.end !== undefined && prev.start > prev.end && nowMin < prev.end) {
      insidePvp = true;
    }
  }

  // Day schedule label (e.g. "Mon, Wed, Fri")
  const daysLabel = pvpDays
    ? [...pvpDays].sort().map(d => DAY_NAMES[d]).join(', ')
    : '';

  if (insidePvp) {
    // Determine end time for the active window
    let activeEnd = endMin;
    if (startMin === undefined || endMin === undefined || (startMin < endMin && (nowMin < startMin || nowMin >= endMin))) {
      // Must be in yesterday's overnight tail
      const prevDay = (dayOfWeek + 6) % 7;
      const prev = getHours(prevDay);
      activeEnd = prev.end;
    }
    let minsLeft = activeEnd > nowMin ? activeEnd - nowMin : (1440 - nowMin) + activeEnd;
    const hours = Math.floor(minsLeft / 60);
    const mins = minsLeft % 60;
    const timeLeft = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
    return ` PvP is enabled for ${timeLeft} (until ${fmt(activeEnd)} ${this._config.botTimezone}).`;
  } else {
    // Calculate time until next PvP start
    let minsUntil = Infinity;
    const checkDays = pvpDays ? pvpDays : new Set([0, 1, 2, 3, 4, 5, 6]);
    for (let d = 0; d <= 7; d++) {
      const checkDay = (dayOfWeek + d) % 7;
      if (!checkDays.has(checkDay)) continue;
      const h2 = getHours(checkDay);
      if (h2.start === undefined || isNaN(h2.start)) continue;
      if (d === 0 && nowMin < h2.start) {
        minsUntil = h2.start - nowMin;
        break;
      }
      if (d === 0) continue;
      minsUntil = (d * 1440) - nowMin + h2.start;
      break;
    }
    if (minsUntil === Infinity) return '';

    const days = Math.floor(minsUntil / 1440);
    const hours = Math.floor((minsUntil % 1440) / 60);
    const mins = minsUntil % 60;
    const parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (mins > 0 || parts.length === 0) parts.push(`${mins}m`);
    const timeUntil = parts.join(' ');

    // Show the next day's specific schedule if using per-day hours
    let nextStart = startMin;
    if (minsUntil > 0) {
      const nextDay = (dayOfWeek + Math.ceil(minsUntil / 1440)) % 7;
      const nextH = getHours(nextDay === dayOfWeek && nowMin < (getHours(dayOfWeek).start || 0) ? dayOfWeek : nextDay);
      if (nextH.start !== undefined) nextStart = nextH.start;
    }
    const schedStart = nextStart !== undefined ? fmt(nextStart) : fmt(defaultStart);
    const nextEnd = getHours(pvpDays ? [...checkDays].find(d2 => getHours(d2).start !== undefined) ?? dayOfWeek : dayOfWeek).end;
    const schedEnd = nextEnd !== undefined ? fmt(nextEnd) : fmt(defaultEnd);

    const schedule = daysLabel
      ? `${daysLabel} ${schedStart}–${schedEnd} ${this._config.botTimezone}`
      : `${schedStart}–${schedEnd} ${this._config.botTimezone}`;
    return ` PvP starts in ${timeUntil} (${schedule}).`;
  }
}

// ── Exports ──────────────────────────────────────────────────

module.exports = {
  // Standalone functions (available to external consumers)
  fileColor,
  _colorLink,
  _rconColorLink,
  loadCachedSettings,
  loadWelcomeStats,
  formatMs,
  pvpScheduleLabel,
  difficultyScheduleLines,
  buildWelcomeContent,

  // Prototype methods (mixed into AutoMessages)
  _difficultyText,
  _pvpScheduleText,
};

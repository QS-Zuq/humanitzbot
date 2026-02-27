const _defaultConfig = require('../config');
const { sendAdminMessage, getPlayerList, getServerInfo } = require('../rcon/server-info');
const _defaultPlaytime = require('../tracking/playtime-tracker');
const _defaultPlayerStats = require('../tracking/player-stats');
const SftpClient = require('ssh2-sftp-client');
const { getDayOffset, getRotatedProfileIndex } = require('./schedule-utils');

// Shared formatting helpers (single source of truth in server-display.js)
const { difficultyLabel: diffLabel, spawnLabel, DIFFICULTY_LABELS } = require('../server/server-display');

// ── Color tag helpers for RCON messages ──────────────────
const { COLOR, color, rconColor, colorOpen, white } = require('../rcon/rcon-colors');

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

// ── Standalone helpers (used by buildWelcomeContent and class) ──

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
  const timeStr = now.toLocaleTimeString('en-GB', {
    hour: '2-digit', minute: '2-digit', hour12: false,
    timeZone: cfg.botTimezone,
  });
  const [h, m] = timeStr.split(':').map(Number);
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
  // e.g. "<PR>1st</> Alice 21h  |  <PR>2nd</> Bob 11h  |  <PR>3rd</> Cat 7h"
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

class AutoMessages {
  constructor(deps = {}) {
    this._config = deps.config || _defaultConfig;
    this._playtime = deps.playtime || _defaultPlaytime;
    this._playerStats = deps.playerStats || _defaultPlayerStats;
    this._getServerInfo = deps.getServerInfo || getServerInfo;
    this._getPlayerList = deps.getPlayerList || getPlayerList;
    this._sendAdminMessage = deps.sendAdminMessage || sendAdminMessage;
    this._label = deps.label || 'AUTO MSG';
    this._db = deps.db || null;

    this.discordLink = this._config.discordInviteLink;

    // Intervals (configurable via .env, defaults in ms)
    this.linkInterval = this._config.autoMsgLinkInterval;   // 30 min
    this.promoInterval = this._config.autoMsgPromoInterval;  // 45 min

    this._linkTimer = null;
    this._promoTimer = null;

    // Track currently online players (for join detection + playtime seeding)
    this._onlinePlayers = new Set();
    this._lastWelcomeTime = 0;      // anti-spam: last RCON welcome sent
    this._welcomeCooldown = 5000;   // ms between welcome messages
    this._initialised = false;
  }

  async start() {
    console.log(`[${this._label}] Starting auto-messages...`);

    // Seed the known player list so we don't welcome everyone already online
    await this._seedPlayers();

    // Periodic Discord link broadcast
    if (this._config.enableAutoMsgLink) {
      this._linkTimer = setInterval(() => this._sendDiscordLink(), this.linkInterval);
      console.log(`[${this._label}] Discord link every ${this.linkInterval / 60000} min`);
    } else {
      console.log(`[${this._label}] Discord link broadcast disabled`);
    }

    // Periodic promo message broadcast
    if (this._config.enableAutoMsgPromo) {
      this._promoTimer = setInterval(() => this._sendPromoMessage(), this.promoInterval);
      console.log(`[${this._label}] Promo message every ${this.promoInterval / 60000} min`);
    } else {
      console.log(`[${this._label}] Promo message disabled`);
    }

    // Player count polling (peak tracking, unique player tracking, join welcome)
    this._pollTimer = setInterval(() => this._pollPlayers(), this._config.autoMsgJoinCheckInterval);
    console.log(`[${this._label}] Player count polling every ${this._config.autoMsgJoinCheckInterval / 1000}s`);
    if (this._config.enableWelcomeMsg) {
      console.log(`[${this._label}] RCON welcome messages enabled (on player join)`);
    } else {
      console.log(`[${this._label}] RCON welcome messages disabled`);
    }

    // SFTP WelcomeMessage.txt — write once at startup, then refreshed after each save poll
    if (this._config.enableWelcomeFile && this._config.ftpHost) {
      await this._writeWelcomeFile();
      console.log(`[${this._label}] WelcomeMessage.txt written (updates after each save poll)`);
    } else if (this._config.enableWelcomeFile) {
      console.log(`[${this._label}] WelcomeMessage.txt disabled — no SFTP credentials`);
    }
  }

  stop() {
    if (this._linkTimer) clearInterval(this._linkTimer);
    if (this._promoTimer) clearInterval(this._promoTimer);
    if (this._pollTimer) clearInterval(this._pollTimer);
    this._linkTimer = null;
    this._promoTimer = null;
    this._pollTimer = null;
    console.log(`[${this._label}] Stopped.`);
  }

  // ── Private methods ────────────────────────────────────────

  async _seedPlayers() {
    try {
      const list = await this._getPlayerList();
      if (list.players && list.players.length > 0) {
        for (const p of list.players) {
          const hasSteamId = p.steamId && p.steamId !== 'N/A';
          const id = hasSteamId ? p.steamId : p.name;
          this._onlinePlayers.add(id);

          // Only track playtime for players with a real SteamID
          // (name-only keys create ghost entries)
          if (hasSteamId) {
            this._playtime.playerJoin(id, p.name || 'Unknown');
          }
        }
      }
      this._initialised = true;
      console.log(`[${this._label}] Seeded ${this._onlinePlayers.size} online player(s) (playtime sessions started)`);
    } catch (err) {
      console.error(`[${this._label}] Failed to seed players:`, err.message);
      this._initialised = true; // continue anyway
    }
  }

  /** Colorize a Discord invite link (instance wrapper). */
  _colorLink(link) { return _colorLink(link); }

  async _sendDiscordLink() {
    if (!this.discordLink) return;
    try {
      const custom = this._config.autoMsgLinkText;
      const msg = custom
        ? await this._resolveMessagePlaceholders(custom)
        : `<FO>Join our </><CL>Discord</><FO>! ${_rconColorLink(this.discordLink)}`;
      await this._sendAdminMessage(msg);
      console.log(`[${this._label}] Sent Discord link to game chat`);
    } catch (err) {
      console.error(`[${this._label}] Failed to send Discord link:`, err.message);
    }
  }

  async _sendPromoMessage() {
    try {
      const custom = this._config.autoMsgPromoText;
      const msg = custom
        ? await this._resolveMessagePlaceholders(custom)
        : `<FO>Issues, suggestions, or just want to connect? ${_rconColorLink(this.discordLink)}`;
      await this._sendAdminMessage(msg);
      console.log(`[${this._label}] Sent promo message to game chat`);
    } catch (err) {
      console.error(`[${this._label}] Failed to send promo message:`, err.message);
    }
  }

  /** Resolve placeholders in custom broadcast messages. */
  async _resolveMessagePlaceholders(text) {
    const info = await this._getServerInfoSafe();
    return this._resolvePlaceholders(text, info);
  }

  async _pollPlayers() {
    if (!this._initialised) return;

    try {
      const list = await this._getPlayerList();
      const currentOnline = new Set();
      const newJoiners = [];   // players who just appeared

      if (list.players && list.players.length > 0) {
        for (const p of list.players) {
          const hasSteamId = p.steamId && p.steamId !== 'N/A';
          const id = hasSteamId ? p.steamId : p.name;
          currentOnline.add(id);

          // Detect new joins — player wasn't in previous snapshot
          if (!this._onlinePlayers.has(id)) {
            newJoiners.push({ id, name: p.name || 'Unknown', steamId: hasSteamId ? p.steamId : null });
          }
        }
      }

      this._onlinePlayers = currentOnline;

      // Record peak player count and unique players for today (SteamID only)
      const steamOnly = [...currentOnline].filter(id => /^\d{17}$/.test(id));
      this._playtime.recordPlayerCount(steamOnly.length);
      for (const id of steamOnly) {
        this._playtime.recordUniqueToday(id);
      }

      // Send RCON admin welcome messages to new joiners
      if (this._config.enableWelcomeMsg && newJoiners.length > 0) {
        for (const joiner of newJoiners) {
          await this._sendWelcomeMessage(joiner);
        }
      }
    } catch (_) {
      // Silently ignore — server might be restarting
    }
  }

  async _sendWelcomeMessage(joiner) {
    // Anti-spam: don't stack welcome messages too close together
    const now = Date.now();
    if (now - this._lastWelcomeTime < this._welcomeCooldown) {
      await new Promise(r => setTimeout(r, this._welcomeCooldown));
    }

    try {
      const pt = joiner.steamId ? this._playtime.getPlaytime(joiner.steamId) : null;
      const diffInfo = this._difficultyText();
      const link = this.discordLink ? `</><SP> | ${_rconColorLink(this.discordLink)}` : '';

      const sep = '</><SP> | </>';
      let msg;
      if (pt && pt.isReturning) {
        msg = `<FO>Welcome back, </>${joiner.name}<FO>!${sep}<FO>Playtime: ${pt.totalFormatted}${diffInfo}${link}`;
      } else {
        msg = `<FO>Welcome, </>${joiner.name}<FO>!${diffInfo}${link}`;
      }

      await this._sendAdminMessage(msg);
      this._lastWelcomeTime = Date.now();
      console.log(`[${this._label}] Sent welcome to ${joiner.name} (${pt?.isReturning ? 'returning' : 'first-time'})`);
    } catch (err) {
      console.error(`[${this._label}] Failed to send welcome to ${joiner.name}:`, err.message);
    }
  }

  /** Short inline text about current difficulty profile for RCON welcome. */
  _difficultyText() {
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

  _pvpScheduleText() {
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
    const timeStr = now.toLocaleTimeString('en-GB', {
      hour: '2-digit', minute: '2-digit', hour12: false,
      timeZone: this._config.botTimezone,
    });
    const [h, m] = timeStr.split(':').map(Number);
    const nowMin = h * 60 + m;

    // Day of week in bot timezone
    const dayStr = now.toLocaleDateString('en-US', {
      weekday: 'short',
      timeZone: this._config.botTimezone,
    });
    const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const dayOfWeek = dayMap[dayStr] ?? now.getDay();

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

  // ── SFTP WelcomeMessage.txt ─────────────────────────────────

  async _buildWelcomeFileContent() {
    const lines = this._config.welcomeFileLines;
    if (lines.length > 0) {
      // User-defined lines — resolve placeholders
      const info = await this._getServerInfoSafe();
      return lines.map(line => this._resolvePlaceholders(line, info)).join('\n');
    }
    // Default: use the standalone builder (no RCON needed)
    return buildWelcomeContent({
      config: this._config,
      playtime: this._playtime,
      playerStats: this._playerStats,
      getServerInfo: this._getServerInfo,
      db: this._db,
    });
  }

  async _getServerInfoSafe() {
    try {
      return await this._getServerInfo();
    } catch {
      return {};
    }
  }

  _resolvePlaceholders(text, info) {
    const serverName = (info && info.name) || '';
    const day = (info && info.day) || '';
    const season = (info && info.season) || '';
    const weather = (info && info.weather) || '';
    return text
      .replace(/\{pvp_schedule\}/gi, (this._pvpScheduleText() || '').trim())
      .replace(/\{discord_link\}/gi, this.discordLink || '')
      .replace(/\{discord\}/gi, this.discordLink || '')
      .replace(/\{server_name\}/gi, serverName)
      .replace(/\{day\}/gi, day)
      .replace(/\{season\}/gi, season)
      .replace(/\{weather\}/gi, weather);
  }

  async _writeWelcomeFile() {
    const sftp = new SftpClient();
    try {
      await sftp.connect(this._config.sftpConnectConfig());

      const content = await this._buildWelcomeFileContent();
      await sftp.put(Buffer.from(content, 'utf8'), this._config.ftpWelcomePath);
      console.log(`[${this._label}] Updated WelcomeMessage.txt on server`);
    } catch (err) {
      console.error(`[${this._label}] Failed to write WelcomeMessage.txt:`, err.message);
    } finally {
      await sftp.end().catch(() => {});
    }
  }
}

module.exports = AutoMessages;
module.exports.buildWelcomeContent = buildWelcomeContent;

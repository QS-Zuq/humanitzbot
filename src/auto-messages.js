const fs = require('fs');
const path = require('path');
const config = require('./config');
const { sendAdminMessage, getPlayerList, getServerInfo } = require('./server-info');
const playtime = require('./playtime-tracker');
const playerStats = require('./player-stats');
const SftpClient = require('ssh2-sftp-client');

const SETTINGS_FILE = path.join(__dirname, '..', 'data', 'server-settings.json');
const WELCOME_STATS_FILE = path.join(__dirname, '..', 'data', 'welcome-stats.json');

// Difficulty index → label (same as server-status.js)
const DIFFICULTY_LABELS = ['Very Easy', 'Easy', 'Default', 'Hard', 'Very Hard', 'Nightmare'];
function diffLabel(val) {
  if (val == null) return null;
  const idx = Math.round(parseFloat(val));
  return DIFFICULTY_LABELS[idx] || val;
}
function spawnLabel(val) {
  if (val == null) return null;
  const n = parseFloat(val);
  if (n === 0) return 'Low';
  if (n === 1) return 'Medium';
  if (n === 2) return 'High';
  return `x${n}`;
}

// ── Color tag helpers for WelcomeMessage.txt ──────────────────
// Game supports: <PN> dark red, <PR> green, <SP> ember, <FO> gray, <CL> blue
const COLOR = {
  red: 'PN',
  green: 'PR',
  ember: 'SP',
  gray: 'FO',
  blue: 'CL',
};
function color(tag, text) {
  return `<${COLOR[tag] || tag}>${text}</>`;
}

// ── Standalone helpers (used by buildWelcomeContent and class) ──

function loadCachedSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    }
  } catch (_) {}
  return {};
}

function loadWelcomeStats() {
  try {
    if (fs.existsSync(WELCOME_STATS_FILE)) {
      return JSON.parse(fs.readFileSync(WELCOME_STATS_FILE, 'utf8'));
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
  if (!config.enablePvpScheduler) return '';
  const startMin = config.pvpStartMinutes;
  const endMin   = config.pvpEndMinutes;
  if (isNaN(startMin) || isNaN(endMin)) return '';
  const fmt = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const pvpDays = config.pvpDays;
  const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const daysLabel = pvpDays
    ? [...pvpDays].sort().map(d => DAY_NAMES[d]).join(', ') + ' '
    : '';
  return `PvP Schedule: ${daysLabel}${fmt(startMin)}\u2013${fmt(endMin)} ${config.pvpTimezone}`;
}

/**
 * Build the WelcomeMessage.txt content using cached data files.
 * Exported so player-stats-channel can call it after save polls.
 * No RCON required — uses cached server-settings.json for server name.
 */
async function buildWelcomeContent() {
  const settings = loadCachedSettings();
  const parts = [];

  // ── Title ──
  let serverName = '';
  try { serverName = (await getServerInfo()).name || ''; } catch {}
  if (!serverName && settings.ServerName) {
    serverName = settings.ServerName.replace(/^"|"$/g, '');
  }
  serverName = serverName.replace(/\s*[-\u2013\u2014|\xb7:]*\s*discord\.\w+\/\S*/gi, '').trim();
  if (serverName.length > 60) serverName = serverName.substring(0, 57) + '...';
  parts.push(color('ember', serverName ? `Welcome to ${serverName}!` : 'Welcome to the server!'));

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
    if (sp.length > 0) parts.push(color('gray', sp.join('  |  ')));
  }

  // ── PvP schedule ──
  const pvpLabel = pvpScheduleLabel();
  if (pvpLabel) parts.push(color('ember', pvpLabel));

  // ── Helper: build an inline row of top entries ──
  // e.g. "<PR>1st</> Zuq 21h  |  <PR>2nd</> Bob 11h  |  <PR>3rd</> Cat 7h"
  const RANKS = ['1st', '2nd', '3rd'];
  function inlineRow(entries, colorTag) {
    return entries.map((text, i) =>
      `${color(colorTag, RANKS[i])} ${text}`
    ).join('  |  ');
  }

  // ── Leaderboards ──
  const leaderboard = playtime.getLeaderboard();
  const welcomeStats = loadWelcomeStats();

  if (leaderboard.length > 0) {
    parts.push('');
    parts.push(color('ember', '--- Top Survivors ---'));
    const top = leaderboard.slice(0, 3).map(e =>
      `${color('green', e.name)} - ${color('gray', formatMs(e.totalMs))}`
    );
    parts.push(inlineRow(top, 'ember'));
  }

  if (welcomeStats.topKillers && welcomeStats.topKillers.length > 0) {
    parts.push(color('ember', '--- Top Zombie Killers ---'));
    const topK = welcomeStats.topKillers.slice(0, 3).map(e =>
      `${color('green', e.name)} - ${color('gray', e.kills.toLocaleString() + ' kills')}`
    );
    parts.push(inlineRow(topK, 'ember'));
  }

  if (welcomeStats.topPvpKillers && welcomeStats.topPvpKillers.length > 0) {
    parts.push(color('ember', '--- Top PvP Killers ---'));
    const topP = welcomeStats.topPvpKillers.slice(0, 3).map(e =>
      `${color('green', e.name)} - ${color('gray', e.kills + ' kills')}`
    );
    parts.push(inlineRow(topP, 'ember'));
  }

  // ── Fun stats (compact single-line each) ──
  if (welcomeStats.topFishers && welcomeStats.topFishers.length > 0) {
    parts.push(color('ember', '--- Top Fishers ---'));
    const topF = welcomeStats.topFishers.slice(0, 3).map(e =>
      `${color('green', e.name)} - ${color('gray', e.count + ' fish')}`
    );
    parts.push(inlineRow(topF, 'ember'));
  }

  if (welcomeStats.topBitten && welcomeStats.topBitten.length > 0) {
    parts.push(color('ember', '--- Most Bitten ---'));
    const topB = welcomeStats.topBitten.slice(0, 3).map(e =>
      `${color('green', e.name)} - ${color('gray', e.count + ' bites')}`
    );
    parts.push(inlineRow(topB, 'ember'));
  }

  // ── Clans (each on own line for clarity) ──
  if (welcomeStats.topClans && welcomeStats.topClans.length > 0) {
    parts.push(color('ember', '--- Top Clans ---'));
    const topC = welcomeStats.topClans.slice(0, 3);
    topC.forEach((c, i) => {
      const pt = formatMs(c.playtimeMs || 0);
      const mem = c.members === 1 ? '1 member' : `${c.members} members`;
      parts.push(`${color('ember', RANKS[i])} ${color('green', c.name)} ${color('gray', '(' + mem + ')')} - ${color('gray', c.kills.toLocaleString() + ' kills')} - ${color('gray', pt + ' played')}`);
    });
  }

  // ── Weekly Highlights (single line, #1 per category) ──
  const w = welcomeStats.weekly;
  if (w) {
    const wp = [];
    if (w.topKillers?.length > 0)    wp.push(`${color('ember', 'Kills:')} ${color('green', w.topKillers[0].name)} ${color('gray', String(w.topKillers[0].kills))}`);
    if (w.topPvpKillers?.length > 0) wp.push(`${color('ember', 'PvP:')} ${color('green', w.topPvpKillers[0].name)} ${color('gray', String(w.topPvpKillers[0].kills))}`);
    if (w.topPlaytime?.length > 0)   wp.push(`${color('ember', 'Time:')} ${color('green', w.topPlaytime[0].name)} ${color('gray', formatMs(w.topPlaytime[0].ms))}`);
    if (w.topFishers?.length > 0)    wp.push(`${color('ember', 'Fish:')} ${color('green', w.topFishers[0].name)} ${color('gray', String(w.topFishers[0].count))}`);
    if (wp.length > 0) {
      parts.push(color('ember', '--- This Week ---'));
      parts.push(wp.join('  |  '));
    }
  }

  // ── Footer ──
  const allLog = playerStats.getAllPlayers();
  if (allLog.length > 0) {
    const totalDeaths = allLog.reduce((s, p) => s + p.deaths, 0);
    const totalBuilds = allLog.reduce((s, p) => s + p.builds, 0);
    const totalLooted = allLog.reduce((s, p) => s + p.containersLooted, 0);
    const sp = [];
    if (totalDeaths > 0) sp.push(`${totalDeaths} Deaths`);
    if (totalBuilds > 0) sp.push(`${totalBuilds} Builds`);
    if (totalLooted > 0) sp.push(`${totalLooted} Looted`);
    if (sp.length > 0) {
      parts.push('');
      parts.push(color('gray', sp.join('  |  ')));
    }
  }

  if (config.discordInviteLink) {
    parts.push(`${color('gray', '!admin for help')}  |  ${color('green', config.discordInviteLink)}`);
  } else {
    parts.push(color('gray', '!admin in chat for help'));
  }

  return parts.join('\n');
}

class AutoMessages {
  constructor() {
    this.discordLink = config.discordInviteLink;

    // Intervals (configurable via .env, defaults in ms)
    this.linkInterval = config.autoMsgLinkInterval;   // 30 min
    this.promoInterval = config.autoMsgPromoInterval;  // 45 min

    this._linkTimer = null;
    this._promoTimer = null;

    // Track currently online players (for playtime seeding)
    this._onlinePlayers = new Set();
    this._initialised = false;
  }

  async start() {
    console.log('[AUTO-MSG] Starting auto-messages...');

    // Seed the known player list so we don't welcome everyone already online
    await this._seedPlayers();

    // Periodic Discord link broadcast
    if (config.enableAutoMsgLink) {
      this._linkTimer = setInterval(() => this._sendDiscordLink(), this.linkInterval);
      console.log(`[AUTO-MSG] Discord link every ${this.linkInterval / 60000} min`);
    } else {
      console.log('[AUTO-MSG] Discord link broadcast disabled');
    }

    // Periodic promo message broadcast
    if (config.enableAutoMsgPromo) {
      this._promoTimer = setInterval(() => this._sendPromoMessage(), this.promoInterval);
      console.log(`[AUTO-MSG] Promo message every ${this.promoInterval / 60000} min`);
    } else {
      console.log('[AUTO-MSG] Promo message disabled');
    }

    // Player count polling (peak tracking, unique player tracking)
    this._pollTimer = setInterval(() => this._pollPlayers(), config.autoMsgJoinCheckInterval);
    console.log(`[AUTO-MSG] Player count polling every ${config.autoMsgJoinCheckInterval / 1000}s`);

    // SFTP WelcomeMessage.txt — write once at startup, then refreshed after each save poll
    if (config.enableWelcomeFile && config.ftpHost) {
      await this._writeWelcomeFile();
      console.log('[AUTO-MSG] WelcomeMessage.txt written (updates after each save poll)');
    } else if (config.enableWelcomeFile) {
      console.log('[AUTO-MSG] WelcomeMessage.txt disabled — no SFTP credentials');
    }
  }

  stop() {
    if (this._linkTimer) clearInterval(this._linkTimer);
    if (this._promoTimer) clearInterval(this._promoTimer);
    if (this._pollTimer) clearInterval(this._pollTimer);
    this._linkTimer = null;
    this._promoTimer = null;
    this._pollTimer = null;
    console.log('[AUTO-MSG] Stopped.');
  }

  // ── Private methods ────────────────────────────────────────

  async _seedPlayers() {
    try {
      const list = await getPlayerList();
      if (list.players && list.players.length > 0) {
        for (const p of list.players) {
          const hasSteamId = p.steamId && p.steamId !== 'N/A';
          const id = hasSteamId ? p.steamId : p.name;
          this._onlinePlayers.add(id);

          // Only track playtime for players with a real SteamID
          // (name-only keys create ghost entries)
          if (hasSteamId) {
            playtime.playerJoin(id, p.name || 'Unknown');
          }
        }
      }
      this._initialised = true;
      console.log(`[AUTO-MSG] Seeded ${this._onlinePlayers.size} online player(s) (playtime sessions started)`);
    } catch (err) {
      console.error('[AUTO-MSG] Failed to seed players:', err.message);
      this._initialised = true; // continue anyway
    }
  }

  async _sendDiscordLink() {
    if (!this.discordLink) return;
    try {
      await sendAdminMessage(`Join our Discord! ${this.discordLink}`);
      console.log('[AUTO-MSG] Sent Discord link to game chat');
    } catch (err) {
      console.error('[AUTO-MSG] Failed to send Discord link:', err.message);
    }
  }

  async _sendPromoMessage() {
    try {
      const msg = `Have any issues, suggestions or just want to keep in contact with other players? Join our Discord: ${this.discordLink}`;
      await sendAdminMessage(msg);
      console.log('[AUTO-MSG] Sent promo message to game chat');
    } catch (err) {
      console.error('[AUTO-MSG] Failed to send promo message:', err.message);
    }
  }

  async _pollPlayers() {
    if (!this._initialised) return;

    try {
      const list = await getPlayerList();
      const currentOnline = new Set();

      if (list.players && list.players.length > 0) {
        for (const p of list.players) {
          const hasSteamId = p.steamId && p.steamId !== 'N/A';
          const id = hasSteamId ? p.steamId : p.name;
          currentOnline.add(id);
        }
      }

      this._onlinePlayers = currentOnline;

      // Record peak player count and unique players for today (SteamID only)
      const steamOnly = [...currentOnline].filter(id => /^\d{17}$/.test(id));
      playtime.recordPlayerCount(steamOnly.length);
      for (const id of steamOnly) {
        playtime.recordUniqueToday(id);
      }
    } catch (_) {
      // Silently ignore — server might be restarting
    }
  }

  _pvpScheduleText() {
    if (!config.enablePvpScheduler) return '';
    const startMin = config.pvpStartMinutes;
    const endMin   = config.pvpEndMinutes;
    if (isNaN(startMin) || isNaN(endMin)) return '';

    const fmt = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const pvpDays = config.pvpDays; // null = every day

    // Get current time in the configured timezone
    const now = new Date();
    const timeStr = now.toLocaleTimeString('en-GB', {
      hour: '2-digit', minute: '2-digit', hour12: false,
      timeZone: config.pvpTimezone,
    });
    const [h, m] = timeStr.split(':').map(Number);
    const nowMin = h * 60 + m;

    // Day of week in PvP timezone
    const dayStr = now.toLocaleDateString('en-US', {
      weekday: 'short',
      timeZone: config.pvpTimezone,
    });
    const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const dayOfWeek = dayMap[dayStr] ?? now.getDay();

    // Check if currently inside PvP window (same logic as pvp-scheduler)
    let insidePvp;
    if (startMin < endMin) {
      const dayOk = !pvpDays || pvpDays.has(dayOfWeek);
      insidePvp = dayOk && nowMin >= startMin && nowMin < endMin;
    } else {
      const prevDay = (dayOfWeek + 6) % 7;
      const startDayOk = !pvpDays || pvpDays.has(dayOfWeek);
      const prevDayOk  = !pvpDays || pvpDays.has(prevDay);
      insidePvp = (startDayOk && nowMin >= startMin) || (prevDayOk && nowMin < endMin);
    }

    // Day schedule label (e.g. "Mon, Wed, Fri")
    const daysLabel = pvpDays
      ? [...pvpDays].sort().map(d => DAY_NAMES[d]).join(', ')
      : '';

    if (insidePvp) {
      // Calculate time remaining in PvP window
      let minsLeft = endMin > nowMin ? endMin - nowMin : (1440 - nowMin) + endMin;
      const hours = Math.floor(minsLeft / 60);
      const mins = minsLeft % 60;
      const timeLeft = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
      return ` PvP is enabled for ${timeLeft} (until ${fmt(endMin)} ${config.pvpTimezone}).`;
    } else {
      // Calculate time until next PvP start
      let minsUntil;
      if (!pvpDays) {
        minsUntil = startMin > nowMin ? startMin - nowMin : (1440 - nowMin) + startMin;
      } else {
        minsUntil = Infinity;
        for (let d = 0; d <= 7; d++) {
          const checkDay = (dayOfWeek + d) % 7;
          if (!pvpDays.has(checkDay)) continue;
          if (d === 0 && nowMin < startMin) {
            minsUntil = startMin - nowMin;
            break;
          }
          if (d === 0) continue;
          minsUntil = (d * 1440) - nowMin + startMin;
          break;
        }
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

      const schedule = daysLabel
        ? `${daysLabel} ${fmt(startMin)}–${fmt(endMin)} ${config.pvpTimezone}`
        : `${fmt(startMin)}–${fmt(endMin)} ${config.pvpTimezone}`;
      return ` PvP starts in ${timeUntil} (${schedule}).`;
    }
  }

  // ── SFTP WelcomeMessage.txt ─────────────────────────────────

  async _buildWelcomeFileContent() {
    const lines = config.welcomeFileLines;
    if (lines.length > 0) {
      // User-defined lines — resolve placeholders
      const info = await this._getServerInfoSafe();
      return lines.map(line => this._resolvePlaceholders(line, info)).join('\n');
    }
    // Default: use the standalone builder (no RCON needed)
    return buildWelcomeContent();
  }

  async _getServerInfoSafe() {
    try {
      return await getServerInfo();
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
      await sftp.connect({
        host: config.ftpHost,
        port: config.ftpPort,
        username: config.ftpUser,
        password: config.ftpPassword,
      });

      const content = await this._buildWelcomeFileContent();
      await sftp.put(Buffer.from(content, 'utf8'), config.ftpWelcomePath);
      console.log('[AUTO-MSG] Updated WelcomeMessage.txt on server');
    } catch (err) {
      console.error('[AUTO-MSG] Failed to write WelcomeMessage.txt:', err.message);
    } finally {
      await sftp.end().catch(() => {});
    }
  }
}

module.exports = AutoMessages;
module.exports.buildWelcomeContent = buildWelcomeContent;

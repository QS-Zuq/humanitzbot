/**
 * Server Scheduler — Timed server restarts with dynamic settings profiles.
 *
 * Replaces the PvP-only scheduler with a general-purpose system that can:
 * - Run 2+ scheduled restarts per day at configurable times
 * - Apply different game settings profiles on each restart (difficulty, loot, XP, etc.)
 * - Cycle through profiles automatically (round-robin) or use time-based selection
 * - Announce countdowns in-game (RCON) and Discord (activity thread)
 * - Restart the server via Docker CLI, RCON, or Panel API
 *
 * Configuration via .env:
 *   ENABLE_SERVER_SCHEDULER=true
 *   RESTART_TIMES=06:00,18:00              # comma-separated HH:MM in BOT_TIMEZONE
 *   RESTART_DELAY=10                       # countdown minutes before restart
 *   RESTART_PROFILES=day,night             # comma-separated profile names (cycle order)
 *   RESTART_PROFILE_<NAME>=JSON            # settings overrides for each profile
 *
 * Example profiles:
 *   RESTART_PROFILE_DAY={"ZombieAmountMulti":"0.5","ZombieDiffHealth":"2","ZombieDiffDamage":"2","XpMultiplier":"1"}
 *   RESTART_PROFILE_NIGHT={"ZombieAmountMulti":"1.5","ZombieDiffHealth":"3","ZombieDiffDamage":"3","XpMultiplier":"2"}
 */

const { EmbedBuilder } = require('discord.js');
const SftpClient = require('ssh2-sftp-client');
const _defaultConfig = require('../config');
const _defaultRcon = require('../rcon/rcon');
const _defaultPanelApi = require('../server/panel-api');
const { getDayOffset, getRotatedProfileIndex, getTodaySchedule } = require('./schedule-utils');
const { createLogger } = require('../utils/log');

const WARNINGS = [10, 5, 3, 2, 1]; // countdown warnings in minutes

// Profile name → RCON color tag for in-game messages
// NOTE: Never use PN — that's the player name tag, chat parser treats it specially
const PROFILE_COLORS = { calm: 'PR', surge: 'SP', horde: 'CL' };
function profileTag(name) {
  return PROFILE_COLORS[name] || 'FO';
}

class ServerScheduler {
  constructor(client, logWatcher, deps = {}) {
    this._config = deps.config || _defaultConfig;
    this._rcon = deps.rcon || _defaultRcon;
    this._panelApi = deps.panelApi || _defaultPanelApi;
    this._log = createLogger(deps.label, 'SCHEDULER');
    this._client = client;
    this._logWatcher = logWatcher || null;
    this._interval = null;
    this._countdownTimer = null;
    this._transitioning = false;
    this._adminChannel = null;

    // Profile state
    this._profiles = []; // ordered list of profile names
    this._profileSettings = {}; // name → { key: value } overrides
    this._currentProfileIndex = -1; // which profile is currently active
    this._currentProfileName = null;
    this._restartTimes = []; // sorted array of { hour, minute, totalMinutes }
    this._lastRestartMinute = -1; // prevent double-restart in same minute
  }

  async start() {
    // Parse restart times
    const timesStr = this._config.restartTimes || process.env.RESTART_TIMES || '';
    this._restartTimes = timesStr
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => {
        const [h, m] = s.split(':').map(Number);
        return { hour: h, minute: m || 0, totalMinutes: h * 60 + (m || 0) };
      })
      .filter((t) => !isNaN(t.hour))
      .sort((a, b) => a.totalMinutes - b.totalMinutes);

    if (this._restartTimes.length === 0) {
      this._log.info('No RESTART_TIMES configured — scheduler idle');
      return;
    }

    // Parse profiles
    const profilesStr = this._config.restartProfiles || process.env.RESTART_PROFILES || '';
    this._profiles = profilesStr
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);

    // Load profile settings from config (multi-server) or env
    const preloaded = this._config.restartProfileSettings || {};
    for (const name of this._profiles) {
      if (preloaded[name]) {
        this._profileSettings[name] = preloaded[name];
      } else {
        const envKey = `RESTART_PROFILE_${name.toUpperCase()}`;
        const raw = process.env[envKey];
        if (raw) {
          try {
            this._profileSettings[name] = JSON.parse(raw);
          } catch (e) {
            this._log.error(`Invalid JSON in ${envKey}:`, e.message);
          }
        }
      }
    }

    // If no named profiles, create a default "restart-only" with no settings changes
    if (this._profiles.length === 0) {
      this._profiles = ['default'];
      this._log.info('No profiles configured — restarts only (no settings changes)');
    }

    const delay = parseInt(process.env.RESTART_DELAY, 10) || this._config.pvpRestartDelay || 10;
    this._restartDelay = delay;

    // Log configuration
    const fmt = (t) => `${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}`;
    this._log.info(`Scheduled restarts: ${this._restartTimes.map(fmt).join(', ')} (${this._config.botTimezone})`);
    this._log.info(`Countdown: ${delay} minutes before each restart`);
    if (this._profiles.length > 0 && this._profiles[0] !== 'default') {
      this._log.info(`Profiles: ${this._profiles.join(' → ')} (cycling)`);
      for (const name of this._profiles) {
        const settings = this._profileSettings[name];
        if (settings) {
          const keys = Object.keys(settings).join(', ');
          this._log.info(`  ${name}: ${keys}`);
        }
      }
    }

    // Determine current profile based on time
    this._currentProfileIndex = this._determineCurrentProfile();
    this._currentProfileName = this._profiles[this._currentProfileIndex] || this._profiles[0];
    this._log.info(`Current profile: ${this._currentProfileName}`);

    // Resolve admin channel
    if (this._config.adminChannelId) {
      try {
        this._adminChannel = await this._client.channels.fetch(this._config.adminChannelId);
      } catch {
        /* no channel */
      }
    }

    // Check every 30 seconds
    this._interval = setInterval(() => this._tick(), 30_000);
    this._tick();
  }

  stop() {
    if (this._interval) clearInterval(this._interval);
    if (this._countdownTimer) clearTimeout(this._countdownTimer);
    this._interval = null;
    this._countdownTimer = null;
  }

  /** Determine which profile should be active based on current time. */
  _determineCurrentProfile() {
    if (this._profiles.length <= 1) return 0;
    if (this._restartTimes.length === 0) return 0;

    const { totalMinutes } = this._getCurrentTime();
    const dayOffset = getDayOffset(this._config.botTimezone, this._profiles.length, this._config.restartRotateDaily);

    // Find which restart window we're in:
    // If we're past restart[i] but before restart[i+1], time slot i should be active
    let slotIndex = 0;
    for (let i = this._restartTimes.length - 1; i >= 0; i--) {
      if (totalMinutes >= this._restartTimes[i].totalMinutes) {
        slotIndex = i;
        break;
      }
    }

    return getRotatedProfileIndex(slotIndex, this._profiles.length, dayOffset);
  }

  _getCurrentTime() {
    const now = new Date();
    const parts = new Intl.DateTimeFormat('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      hourCycle: 'h23',
      timeZone: this._config.botTimezone,
    }).formatToParts(now);
    const h = parseInt(parts.find((p) => p.type === 'hour')?.value || '0', 10);
    const m = parseInt(parts.find((p) => p.type === 'minute')?.value || '0', 10);
    return { hour: h, minute: m, totalMinutes: h * 60 + m };
  }

  _tick() {
    if (this._transitioning) return;

    const { totalMinutes } = this._getCurrentTime();
    const delay = this._restartDelay;

    // Find the next upcoming restart
    for (const restartTime of this._restartTimes) {
      const minutesUntil = restartTime.totalMinutes - totalMinutes;

      // Skip if already passed today
      if (minutesUntil < 0) continue;

      // Skip if we already handled this restart
      if (restartTime.totalMinutes === this._lastRestartMinute) continue;

      // Start countdown when within the delay window
      if (minutesUntil <= delay && minutesUntil >= 0) {
        // Calculate next profile using day-aware rotation
        const dayOffset = getDayOffset(
          this._config.botTimezone,
          this._profiles.length,
          this._config.restartRotateDaily,
        );
        const nextSlotIndex = this._restartTimes.indexOf(restartTime);
        const nextProfileIdx = getRotatedProfileIndex(nextSlotIndex, this._profiles.length, dayOffset);
        const nextProfile = this._profiles[nextProfileIdx];
        this._log.info(`Restart in ${minutesUntil} min — switching to profile: ${nextProfile}`);
        this._lastRestartMinute = restartTime.totalMinutes;
        this._startCountdown(nextProfile, nextProfileIdx, minutesUntil);
        return;
      }
    }

    // Check if we need to wrap around to tomorrow's first restart
    // (Only relevant for countdown start — actual day rollover handled naturally)
  }

  _startCountdown(profileName, profileIndex, minutesUntilRestart) {
    this._transitioning = true;
    const delay = minutesUntilRestart;
    const profileSettings = this._profileSettings[profileName] || {};
    const hasSettings = Object.keys(profileSettings).length > 0;

    // Build warning schedule
    const warnings = WARNINGS.filter((m) => m <= delay);
    if (warnings.length === 0 || warnings[0] < delay) {
      warnings.unshift(Math.ceil(delay));
    }

    let stepIndex = 0;

    const scheduleNext = () => {
      if (stepIndex >= warnings.length) {
        // Countdown complete — execute
        this._executeRestart(profileName, profileIndex, profileSettings);
        return;
      }

      const minutesLeft = warnings[stepIndex];
      const nextMinutes = stepIndex + 1 < warnings.length ? warnings[stepIndex + 1] : 0;
      const waitMs = (minutesLeft - nextMinutes) * 60_000;

      // Build warning message
      let msg = `Server restart in ${minutesLeft} minute${minutesLeft > 1 ? 's' : ''}`;
      let rconMsg = `</><FO>${msg}`;
      if (hasSettings && minutesLeft === warnings[0]) {
        const display = this._getProfileDisplayName(profileName);
        msg += ` \u2014 switching to ${display}`;
        const tag = profileTag(profileName);
        const { name: pName, desc: pDesc } = this._getProfileParts(profileName);
        rconMsg = `</><FO>Server restart in ${minutesLeft} minute${minutesLeft > 1 ? 's' : ''} \u2014 switching to </><${tag}>${pName}</><FO>${pDesc}`;
      }

      this._announce(msg, 0xf39c12);
      this._rcon.send(`admin ${rconMsg}`).catch((err) => {
        this._log.error('Failed to send in-game warning:', err.message);
      });

      stepIndex++;

      if (waitMs > 0) {
        this._countdownTimer = setTimeout(scheduleNext, waitMs);
      } else {
        scheduleNext();
      }
    };

    scheduleNext();
  }

  /** Get a human-readable display name for a profile. */
  _getProfileDisplayName(name) {
    const settings = this._profileSettings[name] || {};
    const parts = [];

    // Build a description from key settings
    const zombieAmount = parseFloat(settings.ZombieAmountMulti);
    if (!isNaN(zombieAmount)) {
      if (zombieAmount <= 0.3) parts.push('Minimal Zombies');
      else if (zombieAmount <= 0.6) parts.push('Fewer Zombies');
      else if (zombieAmount <= 1.0) parts.push('Normal Zombies');
      else if (zombieAmount <= 1.5) parts.push('More Zombies');
      else parts.push('Zombie Horde');
    }

    const xp = parseFloat(settings.XpMultiplier);
    if (!isNaN(xp) && xp !== 1) {
      parts.push(`${xp}x XP`);
    }

    const difficulty = parseInt(settings.ZombieDiffDamage, 10);
    if (!isNaN(difficulty)) {
      const labels = { 1: 'Easy', 2: 'Normal', 3: 'Hard', 4: 'Brutal' };
      parts.push(labels[difficulty] || `Difficulty ${difficulty}`);
    }

    // PVP indicator — show when PVP is explicitly enabled for this profile
    const pvpEnabled = settings.PVP === '1' || settings.PVP === 'true';
    const capName = name.charAt(0).toUpperCase() + name.slice(1);
    const pvpSuffix = pvpEnabled ? ' - PVP!' : '';

    if (parts.length > 0) {
      return `${capName}${pvpSuffix} (${parts.join(', ')})`;
    }

    return `${capName}${pvpSuffix}`;
  }

  /** Get profile name and description as separate strings for colored RCON output. */
  _getProfileParts(name) {
    const capName = name.charAt(0).toUpperCase() + name.slice(1);
    const full = this._getProfileDisplayName(name);
    const parenIdx = full.indexOf(' (');
    if (parenIdx >= 0) {
      return { name: capName, desc: full.slice(parenIdx) };
    }
    return { name: capName, desc: '' };
  }

  async _executeRestart(profileName, profileIndex, profileSettings) {
    this._log.info(`Executing restart → profile: ${profileName}`);

    const hasSettings = Object.keys(profileSettings).length > 0;

    // Apply settings changes via SFTP
    if (hasSettings) {
      const sftp = new SftpClient();
      try {
        await sftp.connect(this._config.sftpConnectConfig());
        const settingsPath = this._config.ftpSettingsPath;

        // Make writable if needed
        let originalMode = null;
        try {
          const stat = await sftp.stat(settingsPath);
          const mode = stat.mode & 0o777;
          if (!(mode & 0o200)) {
            originalMode = mode;
            await sftp.chmod(settingsPath, mode | 0o220);
          }
        } catch {
          /* ignore */
        }

        // Read, modify, write
        const content = (await sftp.get(settingsPath)).toString('utf8');
        let updated = content;

        for (const [key, value] of Object.entries(profileSettings)) {
          const regex = new RegExp(`^(${key}\\s*=\\s*)(.+?)\\s*$`, 'm');
          if (regex.test(updated)) {
            updated = updated.replace(regex, `$1${value}`);
            this._log.info(`${profileName}: ${key} → ${value}`);
          } else {
            this._log.warn(`${profileName}: ${key} not found in settings`);
          }
        }

        if (updated !== content) {
          await sftp.put(Buffer.from(updated, 'utf8'), settingsPath);
          this._log.info(`Settings updated for profile: ${profileName}`);
        }

        // Restore permissions
        if (originalMode !== null) {
          await sftp.chmod(settingsPath, originalMode).catch(() => {});
        }
      } catch (err) {
        this._log.error('SFTP settings update failed:', err.message);
      } finally {
        await sftp.end().catch(() => {});
      }
    }

    // Announce restart
    const displayName = this._getProfileDisplayName(profileName);
    const msg = `Server restarting \u2014 ${displayName}`;
    const tag = profileTag(profileName);
    const { name: pName, desc: pDesc } = this._getProfileParts(profileName);
    const rconMsg = `</><FO>Server restarting \u2014 </><${tag}>${pName}</><FO>${pDesc}`;
    this._announce(msg, 0x3498db);
    await this._rcon.send(`admin ${rconMsg}`).catch(() => {});

    // Update server name via Panel API (Bisect/Pterodactyl overrides INI with
    // the -steamservername= command-line arg, so SFTP writes don't affect it)
    if (this._panelApi.available && this._config.serverNameTemplate) {
      try {
        const capName = profileName.charAt(0).toUpperCase() + profileName.slice(1);
        const serverName = this._config.serverNameTemplate.replace('{mode}', capName);
        await this._panelApi.updateStartupVariable('SERVER_NAME', serverName);
        this._log.info(`Panel API: SERVER_NAME → ${serverName}`);
      } catch (err) {
        this._log.warn('Panel API server name update failed:', err.message);
      }
    }

    // WelcomeMessage.txt is now managed exclusively by the Welcome File Editor

    // Post to activity thread
    await this._postToActivityLog(profileName, profileSettings);

    // Execute restart
    let restartSucceeded = false;
    const container = this._config.dockerContainer || process.env.DOCKER_CONTAINER;

    // Prefer LinuxGSM restart inside the container — restarts the game process
    // without touching the container itself. LinuxGSM gracefully stops the game,
    // waits for clean exit, then starts fresh. RCON port binds correctly because
    // the old process fully releases it before the new one starts.
    // Falls back to docker stop+start if LinuxGSM restart fails.
    if (container) {
      try {
        const { exec } = require('child_process');
        await new Promise((resolve, reject) => {
          exec(`docker exec -u linuxgsm ${container} /app/hzserver restart`, { timeout: 120000 }, (err, stdout) => {
            if (err) reject(err);
            else {
              if (stdout) this._log.info(`LinuxGSM: ${stdout.trim().split('\n').pop()}`);
              resolve();
            }
          });
        });
        this._log.info(`Restart via LinuxGSM (${container})`);
        restartSucceeded = true;
      } catch (lgsmErr) {
        this._log.warn(`LinuxGSM restart failed: ${lgsmErr.message}, falling back to docker stop+start`);
        try {
          const { exec } = require('child_process');
          await new Promise((resolve, reject) => {
            exec(`docker stop ${container} && docker start ${container}`, { timeout: 120000 }, (err) => {
              if (err) reject(err);
              else resolve();
            });
          });
          this._log.info(`Restart via Docker stop+start (${container})`);
          restartSucceeded = true;
        } catch (dockerErr) {
          this._log.warn('Docker restart also failed:', dockerErr.message);
        }
      }
    }

    // Fallback: Panel API restart (Bisect/Pterodactyl — no Docker needed)
    if (!restartSucceeded && this._panelApi.available) {
      try {
        await this._panelApi.sendPowerAction('restart');
        this._log.info('Restart via Panel API');
        restartSucceeded = true;
      } catch (err) {
        this._log.warn('Panel API restart failed:', err.message);
      }
    }

    // Fallback: RCON restart (non-Docker, non-Panel setups, or if above failed)
    if (!restartSucceeded) {
      try {
        await this._rcon.send('RestartNow');
        this._log.info('Restart command sent via RCON');
        restartSucceeded = true;
      } catch (err) {
        this._log.warn('RCON RestartNow failed:', err.message);
        try {
          await this._rcon.send('QuickRestart');
          this._log.info('Restart via RCON QuickRestart');
          restartSucceeded = true;
        } catch {
          this._log.error('All restart methods failed');
        }
      }
    }

    if (restartSucceeded) {
      this._currentProfileIndex = profileIndex;
      this._currentProfileName = profileName;

      // Post-restart RCON health check — if RCON doesn't reconnect within 90s,
      // the game server likely failed to bind the RCON port.
      // Trigger a recovery restart via Docker, Panel API, or RCON.
      this._scheduleRconHealthCheck(container);
    }

    this._transitioning = false;
  }

  async _announce(message, color = 0xf39c12) {
    this._log.info(message);
    const embed = new EmbedBuilder()
      .setAuthor({ name: '🔄 Server Scheduler' })
      .setDescription(message)
      .setColor(color)
      .setTimestamp();

    if (this._logWatcher) {
      try {
        await this._logWatcher.sendToThread(embed);
        return;
      } catch {
        /* fall through */
      }
    }
    if (this._adminChannel) {
      try {
        await this._adminChannel.send({ embeds: [embed] });
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * After a restart, poll RCON connectivity for up to 90s.
   * If RCON doesn't come back, the game server likely failed to bind the port.
   * Trigger a recovery restart via Docker, Panel API, or RCON.
   */
  _scheduleRconHealthCheck(container) {
    const checkInterval = 10_000; // check every 10s
    const maxWait = 90_000; // give up after 90s
    const start = Date.now();
    this._log.info(`RCON health check started — will verify within ${maxWait / 1000}s`);

    const timer = setInterval(async () => {
      // RCON reconnected successfully
      if (this._rcon.connected && this._rcon.authenticated) {
        clearInterval(timer);
        this._log.info('RCON health check passed — connected');
        return;
      }

      // Timed out — RCON never came back
      if (Date.now() - start >= maxWait) {
        clearInterval(timer);
        this._log.warn(`RCON health check FAILED — no connection after ${maxWait / 1000}s, restarting game process`);

        // Try Docker first (if configured)
        if (container) {
          try {
            const { exec } = require('child_process');
            await new Promise((resolve, reject) => {
              exec(`docker exec -u linuxgsm ${container} /app/hzserver restart`, { timeout: 120000 }, (err) => {
                if (err) {
                  exec(`docker stop ${container} && docker start ${container}`, { timeout: 120000 }, (err2) => {
                    if (err2) reject(err2);
                    else resolve();
                  });
                } else resolve();
              });
            });
            this._log.info(`Recovery restart sent (${container})`);
            return;
          } catch (err) {
            this._log.error('Docker recovery restart failed:', err.message);
          }
        }

        // Try Panel API (Bisect/Pterodactyl)
        if (this._panelApi.available) {
          try {
            await this._panelApi.sendPowerAction('restart');
            this._log.info('Recovery restart sent via Panel API');
            return;
          } catch (err) {
            this._log.error('Panel API recovery restart failed:', err.message);
          }
        }

        this._log.error('All recovery restart methods exhausted');
      }
    }, checkInterval);
  }

  async _postToActivityLog(profileName, profileSettings) {
    if (!this._logWatcher) return;

    const displayName = this._getProfileDisplayName(profileName);
    const settingsList = Object.entries(profileSettings || {})
      .map(([k, v]) => `• **${k}**: ${v}`)
      .join('\n');

    const description = settingsList
      ? `Server restarting with profile **${displayName}**\n\n${settingsList}`
      : `Server restarting — profile: **${displayName}**`;

    const embed = new EmbedBuilder()
      .setAuthor({ name: '🔄 Scheduled Restart' })
      .setDescription(description)
      .setColor(0x3498db)
      .setTimestamp();

    try {
      await this._logWatcher.sendToThread(embed);
    } catch (err) {
      this._log.error('Failed to post to activity thread:', err.message);
    }
  }

  /** Whether the scheduler has active restart times configured. */
  isActive() {
    return this._restartTimes.length > 0;
  }

  /** Get current profile info for external consumers (web panel, status embed). */
  getStatus() {
    const { totalMinutes } = this._getCurrentTime();
    const fmt = (t) => `${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}`;

    // Find next restart
    let nextRestart = null;
    let minutesUntilNext = Infinity;
    for (const t of this._restartTimes) {
      const diff = t.totalMinutes - totalMinutes;
      if (diff > 0 && diff < minutesUntilNext) {
        minutesUntilNext = diff;
        nextRestart = t;
      }
    }
    // Wrap around to tomorrow
    if (!nextRestart && this._restartTimes.length > 0) {
      nextRestart = this._restartTimes[0];
      minutesUntilNext = 1440 - totalMinutes + nextRestart.totalMinutes;
    }

    // Build today's schedule with rotation
    const dayOffset = getDayOffset(this._config.botTimezone, this._profiles.length, this._config.restartRotateDaily);
    const timeStrs = this._restartTimes.map(fmt);
    const todaySchedule = getTodaySchedule(timeStrs, this._profiles, dayOffset);

    // Build tomorrow's schedule (useful when rotation is on)
    const tomorrowSchedule = this._config.restartRotateDaily
      ? getTodaySchedule(timeStrs, this._profiles, (dayOffset + 1) % this._profiles.length)
      : null;

    // Build per-profile settings map for external consumers (web panel hover)
    const profileSettings = {};
    const profileDisplayNames = {};
    for (const name of this._profiles) {
      if (this._profileSettings[name]) {
        profileSettings[name] = { ...this._profileSettings[name] };
      }
      profileDisplayNames[name] = this._getProfileDisplayName(name);
    }

    // Enrich schedule slots with display names
    const enrichSlots = (slots) => {
      if (!slots) return null;
      return slots.map((s) => ({
        ...s,
        profileDisplayName: profileDisplayNames[s.profileName] || s.profileName,
      }));
    };

    return {
      active: this._restartTimes.length > 0,
      currentProfile: this._currentProfileName,
      currentProfileDisplay: this._currentProfileName ? this._getProfileDisplayName(this._currentProfileName) : null,
      nextRestart: nextRestart ? fmt(nextRestart) : null,
      minutesUntilRestart: minutesUntilNext === Infinity ? null : minutesUntilNext,
      restartTimes: timeStrs,
      profiles: this._profiles,
      profileSettings,
      profileDisplayNames,
      todaySchedule: enrichSlots(todaySchedule),
      tomorrowSchedule: enrichSlots(tomorrowSchedule),
      rotateDaily: this._config.restartRotateDaily,
      transitioning: this._transitioning,
      timezone: this._config.botTimezone || 'UTC',
    };
  }
}

module.exports = ServerScheduler;

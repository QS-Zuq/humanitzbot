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
const _defaultConfig = require('./config');
const _defaultRcon = require('./rcon');

const WARNINGS = [10, 5, 3, 2, 1]; // countdown warnings in minutes

class ServerScheduler {
  constructor(client, logWatcher, deps = {}) {
    this._config = deps.config || _defaultConfig;
    this._rcon = deps.rcon || _defaultRcon;
    this._label = deps.label || 'SCHEDULER';
    this._client = client;
    this._logWatcher = logWatcher || null;
    this._interval = null;
    this._countdownTimer = null;
    this._transitioning = false;
    this._adminChannel = null;

    // Profile state
    this._profiles = [];            // ordered list of profile names
    this._profileSettings = {};     // name → { key: value } overrides
    this._currentProfileIndex = -1; // which profile is currently active
    this._currentProfileName = null;
    this._restartTimes = [];        // sorted array of { hour, minute, totalMinutes }
    this._lastRestartMinute = -1;   // prevent double-restart in same minute
  }

  async start() {
    // Parse restart times
    const timesStr = this._config.restartTimes || process.env.RESTART_TIMES || '';
    this._restartTimes = timesStr.split(',')
      .map(s => s.trim())
      .filter(Boolean)
      .map(s => {
        const [h, m] = s.split(':').map(Number);
        return { hour: h, minute: m || 0, totalMinutes: h * 60 + (m || 0) };
      })
      .filter(t => !isNaN(t.hour))
      .sort((a, b) => a.totalMinutes - b.totalMinutes);

    if (this._restartTimes.length === 0) {
      console.log(`[${this._label}] No RESTART_TIMES configured — scheduler idle`);
      return;
    }

    // Parse profiles
    const profilesStr = this._config.restartProfiles || process.env.RESTART_PROFILES || '';
    this._profiles = profilesStr.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

    // Load profile settings from env
    for (const name of this._profiles) {
      const envKey = `RESTART_PROFILE_${name.toUpperCase()}`;
      const raw = process.env[envKey];
      if (raw) {
        try {
          this._profileSettings[name] = JSON.parse(raw);
        } catch (e) {
          console.error(`[${this._label}] Invalid JSON in ${envKey}:`, e.message);
        }
      }
    }

    // If no named profiles, create a default "restart-only" with no settings changes
    if (this._profiles.length === 0) {
      this._profiles = ['default'];
      console.log(`[${this._label}] No profiles configured — restarts only (no settings changes)`);
    }

    const delay = parseInt(process.env.RESTART_DELAY, 10) || this._config.pvpRestartDelay || 10;
    this._restartDelay = delay;

    // Log configuration
    const fmt = (t) => `${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}`;
    console.log(`[${this._label}] Scheduled restarts: ${this._restartTimes.map(fmt).join(', ')} (${this._config.botTimezone})`);
    console.log(`[${this._label}] Countdown: ${delay} minutes before each restart`);
    if (this._profiles.length > 0 && this._profiles[0] !== 'default') {
      console.log(`[${this._label}] Profiles: ${this._profiles.join(' → ')} (cycling)`);
      for (const name of this._profiles) {
        const settings = this._profileSettings[name];
        if (settings) {
          const keys = Object.keys(settings).join(', ');
          console.log(`[${this._label}]   ${name}: ${keys}`);
        }
      }
    }

    // Determine current profile based on time
    this._currentProfileIndex = this._determineCurrentProfile();
    this._currentProfileName = this._profiles[this._currentProfileIndex] || this._profiles[0];
    console.log(`[${this._label}] Current profile: ${this._currentProfileName}`);

    // Resolve admin channel
    if (this._config.adminChannelId) {
      try {
        this._adminChannel = await this._client.channels.fetch(this._config.adminChannelId);
      } catch { /* no channel */ }
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

    // Find which restart window we're in:
    // If we're past restart[i] but before restart[i+1], profile[i] should be active
    let idx = 0;
    for (let i = this._restartTimes.length - 1; i >= 0; i--) {
      if (totalMinutes >= this._restartTimes[i].totalMinutes) {
        idx = i;
        break;
      }
    }

    return idx % this._profiles.length;
  }

  _getCurrentTime() {
    const now = new Date();
    const timeStr = now.toLocaleTimeString('en-GB', {
      hour: '2-digit', minute: '2-digit', hour12: false,
      timeZone: this._config.botTimezone,
    });
    const [h, m] = timeStr.split(':').map(Number);
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
        // Calculate next profile
        const nextIdx = (this._currentProfileIndex + 1) % this._profiles.length;
        const nextProfile = this._profiles[nextIdx];
        console.log(`[${this._label}] Restart in ${minutesUntil} min — switching to profile: ${nextProfile}`);
        this._lastRestartMinute = restartTime.totalMinutes;
        this._startCountdown(nextProfile, nextIdx, minutesUntil);
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
    const warnings = WARNINGS.filter(m => m <= delay);
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
      let msg = `⏰ Server restart in ${minutesLeft} minute${minutesLeft > 1 ? 's' : ''}`;
      if (hasSettings && minutesLeft === warnings[0]) {
        // First warning — mention the profile change
        msg += ` — switching to ${this._getProfileDisplayName(profileName)}`;
      }

      this._announce(msg, 0xf39c12);
      this._rcon.send(`admin ${msg}`).catch(err => {
        console.error(`[${this._label}] Failed to send in-game warning:`, err.message);
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

    if (parts.length > 0) {
      return `${name.charAt(0).toUpperCase() + name.slice(1)} (${parts.join(', ')})`;
    }

    return name.charAt(0).toUpperCase() + name.slice(1);
  }

  async _executeRestart(profileName, profileIndex, profileSettings) {
    console.log(`[${this._label}] Executing restart → profile: ${profileName}`);

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
        } catch { /* ignore */ }

        // Read, modify, write
        const content = (await sftp.get(settingsPath)).toString('utf8');
        let updated = content;

        for (const [key, value] of Object.entries(profileSettings)) {
          const regex = new RegExp(`^(${key}\\s*=\\s*)(.+?)\\s*$`, 'm');
          if (regex.test(updated)) {
            updated = updated.replace(regex, `$1${value}`);
            console.log(`[${this._label}] ${profileName}: ${key} → ${value}`);
          } else {
            console.warn(`[${this._label}] ${profileName}: ${key} not found in settings`);
          }
        }

        if (updated !== content) {
          await sftp.put(Buffer.from(updated, 'utf8'), settingsPath);
          console.log(`[${this._label}] Settings updated for profile: ${profileName}`);
        }

        // Restore permissions
        if (originalMode !== null) {
          await sftp.chmod(settingsPath, originalMode).catch(() => {});
        }
      } catch (err) {
        console.error(`[${this._label}] SFTP settings update failed:`, err.message);
      } finally {
        await sftp.end().catch(() => {});
      }
    }

    // Announce restart
    const displayName = this._getProfileDisplayName(profileName);
    const msg = `🔄 Server restarting — ${displayName}`;
    this._announce(msg, 0x3498db);
    await this._rcon.send(`admin ${msg}`).catch(() => {});

    // Post to activity thread
    await this._postToActivityLog(profileName, profileSettings);

    // Execute restart
    let restartSucceeded = false;

    // Try RCON restart first
    try {
      await this._rcon.send('RestartNow');
      console.log(`[${this._label}] Restart command sent via RCON`);
      restartSucceeded = true;
    } catch (err) {
      console.warn(`[${this._label}] RCON RestartNow failed:`, err.message);
      // Try QuickRestart
      try {
        await this._rcon.send('QuickRestart');
        restartSucceeded = true;
      } catch {
        // Try Docker restart as last resort
        try {
          const { exec } = require('child_process');
          const container = process.env.DOCKER_CONTAINER || 'hzserver';
          await new Promise((resolve, reject) => {
            exec(`docker restart ${container}`, { timeout: 60000 }, (err) => {
              if (err) reject(err); else resolve();
            });
          });
          console.log(`[${this._label}] Restart via Docker CLI`);
          restartSucceeded = true;
        } catch (dockerErr) {
          console.error(`[${this._label}] All restart methods failed:`, dockerErr.message);
        }
      }
    }

    if (restartSucceeded) {
      this._currentProfileIndex = profileIndex;
      this._currentProfileName = profileName;
    }

    this._transitioning = false;
  }

  async _announce(message, color = 0xf39c12) {
    console.log(`[${this._label}] ${message}`);
    const embed = new EmbedBuilder()
      .setAuthor({ name: '🔄 Server Scheduler' })
      .setDescription(message)
      .setColor(color)
      .setTimestamp();

    if (this._logWatcher) {
      try {
        await this._logWatcher.sendToThread(embed);
        return;
      } catch { /* fall through */ }
    }
    if (this._adminChannel) {
      try {
        await this._adminChannel.send({ embeds: [embed] });
      } catch { /* ignore */ }
    }
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
      console.error(`[${this._label}] Failed to post to activity thread:`, err.message);
    }
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
      minutesUntilNext = (1440 - totalMinutes) + nextRestart.totalMinutes;
    }

    return {
      active: this._restartTimes.length > 0,
      currentProfile: this._currentProfileName,
      currentProfileDisplay: this._currentProfileName
        ? this._getProfileDisplayName(this._currentProfileName) : null,
      nextRestart: nextRestart ? fmt(nextRestart) : null,
      minutesUntilRestart: minutesUntilNext === Infinity ? null : minutesUntilNext,
      restartTimes: this._restartTimes.map(fmt),
      profiles: this._profiles,
      transitioning: this._transitioning,
    };
  }
}

module.exports = ServerScheduler;

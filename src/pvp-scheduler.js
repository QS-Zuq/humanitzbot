/**
 * PvP Scheduler — toggles PvP on/off at configured real-world hours.
 *
 * Flow:
 *   1. Every minute, check if current time is inside or outside the PvP window.
 *   2. When the state needs to change, start a countdown (10, 5, 3, 2, 1 min warnings).
 *   3. At 0: download GameServerSettings.ini via SFTP → toggle PVP=0/1 → upload → restart.
 *
 * Config (.env):
 *   ENABLE_PVP_SCHEDULER=false         # off by default
 *   PVP_START_HOUR=18                  # PvP turns ON at 18:00
 *   PVP_END_HOUR=22                    # PvP turns OFF at 22:00
 *   PVP_TIMEZONE=UTC                   # IANA timezone (e.g. UTC, America/New_York, Europe/London)
 *   PVP_RESTART_DELAY=10               # minutes of warning before restart (default 10)
 *   FTP_SETTINGS_PATH=/HumanitZServer/GameServerSettings.ini
 */

const { EmbedBuilder } = require('discord.js');
const SftpClient = require('ssh2-sftp-client');
const config = require('./config');
const rcon = require('./rcon');

const WARNINGS = [10, 5, 3, 2, 1]; // countdown warnings in minutes

class PvpScheduler {
  constructor(client, logWatcher) {
    this._client = client;       // Discord client (for posting announcements)
    this._logWatcher = logWatcher || null; // for posting to activity thread
    this._interval = null;
    this._countdownTimer = null;
    this._transitioning = false;
    this._currentPvp = null; // true = PvP ON, false = PvP OFF, null = unknown
    this._adminChannel = null;
  }

  async start() {
    if (isNaN(config.pvpStartHour) || isNaN(config.pvpEndHour)) {
      console.log('[PVP] PVP_START_HOUR or PVP_END_HOUR not configured, scheduler idle');
      return;
    }
    if (config.pvpStartHour === config.pvpEndHour) {
      console.error('[PVP] PVP_START_HOUR and PVP_END_HOUR are the same — scheduler disabled to prevent 24/7 PvP');
      return;
    }

    console.log(`[PVP] Scheduler active: PvP ${config.pvpStartHour}:00–${config.pvpEndHour}:00 (${config.pvpTimezone})`);
    console.log(`[PVP] Restart delay: ${config.pvpRestartDelay} minutes`);

    // Resolve admin channel for announcements
    if (config.adminChannelId) {
      try {
        this._adminChannel = await this._client.channels.fetch(config.adminChannelId);
      } catch { /* no channel, just log to console */ }
    }

    // Read current PvP state from server
    await this._readCurrentState();

    // Check every 60 seconds
    this._interval = setInterval(() => this._tick(), 60_000);
    this._tick(); // immediate first check
  }

  stop() {
    if (this._interval) clearInterval(this._interval);
    if (this._countdownTimer) clearTimeout(this._countdownTimer);
    this._interval = null;
    this._countdownTimer = null;
  }

  /**
   * Read the current PVP setting from the server ini file.
   */
  async _readCurrentState() {
    const sftp = new SftpClient();
    try {
      await sftp.connect({
        host: config.ftpHost,
        port: config.ftpPort,
        username: config.ftpUser,
        password: config.ftpPassword,
      });
      const content = (await sftp.get(config.ftpSettingsPath)).toString('utf8');
      const match = content.match(/^PVP\s*=\s*(\d)/m);
      this._currentPvp = match ? match[1] === '1' : false;
      console.log(`[PVP] Current server PvP state: ${this._currentPvp ? 'ON' : 'OFF'}`);
    } catch (err) {
      console.error('[PVP] Failed to read server settings:', err.message);
      this._currentPvp = null;
    } finally {
      await sftp.end().catch(() => {});
    }
  }

  /**
   * Get the current hour in the configured timezone.
   */
  _getCurrentHour() {
    const now = new Date();
    const timeStr = now.toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: config.pvpTimezone,
    });
    return parseInt(timeStr.split(':')[0], 10);
  }

  /**
   * Check if the current time is within the PvP window.
   */
  _shouldBePvp() {
    const hour = this._getCurrentHour();
    const start = config.pvpStartHour;
    const end = config.pvpEndHour;

    // Handle overnight windows (e.g. 22:00–06:00)
    if (start < end) {
      return hour >= start && hour < end;
    } else {
      return hour >= start || hour < end;
    }
  }

  /**
   * Main tick — runs every 60 seconds.
   */
  _tick() {
    if (this._transitioning) return; // countdown already in progress

    const shouldBePvp = this._shouldBePvp();

    // If state is unknown, retry reading from server
    if (this._currentPvp === null) {
      this._readCurrentState().catch(() => {});
      return;
    }

    // No change needed
    if (shouldBePvp === this._currentPvp) return;

    // State change needed — start countdown
    const targetLabel = shouldBePvp ? 'ON' : 'OFF';
    console.log(`[PVP] PvP needs to turn ${targetLabel} — starting ${config.pvpRestartDelay}-minute countdown`);
    this._startCountdown(shouldBePvp);
  }

  /**
   * Start the countdown sequence before restart.
   */
  _startCountdown(targetPvp) {
    this._transitioning = true;
    const targetLabel = targetPvp ? 'ON' : 'OFF';
    const delay = config.pvpRestartDelay;

    // Build warning schedule: which warnings fit within the delay
    const warnings = WARNINGS.filter(m => m <= delay);
    if (warnings.length === 0 || warnings[0] < delay) {
      warnings.unshift(delay);
    }

    let stepIndex = 0;

    const scheduleNext = () => {
      if (stepIndex >= warnings.length) {
        // Countdown complete — execute the toggle
        this._executeToggle(targetPvp);
        return;
      }

      const minutesLeft = warnings[stepIndex];
      const nextMinutes = stepIndex + 1 < warnings.length ? warnings[stepIndex + 1] : 0;
      const waitMs = (minutesLeft - nextMinutes) * 60_000;

      // Send warning
      const msg = `Server restart in ${minutesLeft} minute${minutesLeft > 1 ? 's' : ''} — PvP turning ${targetLabel}`;
      this._announce(msg);
      rcon.send(`admin ${msg}`).catch(err => {
        console.error('[PVP] Failed to send in-game warning:', err.message);
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

  /**
   * Download ini, toggle PVP, upload, restart server.
   */
  async _executeToggle(targetPvp) {
    const targetLabel = targetPvp ? 'ON' : 'OFF';
    const targetValue = targetPvp ? '1' : '0';

    console.log(`[PVP] Executing PvP toggle → ${targetLabel}`);

    const sftp = new SftpClient();
    try {
      await sftp.connect({
        host: config.ftpHost,
        port: config.ftpPort,
        username: config.ftpUser,
        password: config.ftpPassword,
      });

      // Download current ini
      const content = (await sftp.get(config.ftpSettingsPath)).toString('utf8');

      // Toggle the PVP line
      if (!content.match(/^PVP\s*=\s*\d/m)) {
        console.error('[PVP] Could not find PVP= line in settings file!');
        this._transitioning = false;
        return;
      }
      const updated = content.replace(/^(PVP\s*=\s*)\d/m, `$1${targetValue}`);

      if (updated === content) {
        console.log(`[PVP] Settings file already has PVP=${targetValue}, skipping upload`);
        // Still restart to ensure server is in sync
      } else {
        // Upload modified ini
        await sftp.put(Buffer.from(updated, 'utf8'), config.ftpSettingsPath);
        console.log(`[PVP] Uploaded settings with PVP=${targetValue}`);
      }

    } catch (err) {
      console.error('[PVP] SFTP toggle failed:', err.message);
      this._transitioning = false;
      return;
    } finally {
      await sftp.end().catch(() => {});
    }

    // Announce and restart
    const restartMsg = `PvP is now ${targetLabel}! Server restarting...`;
    this._announce(restartMsg);
    await rcon.send(`admin ${restartMsg}`).catch(() => {});

    // Post to daily activity thread
    await this._postToActivityLog(targetPvp);

    let restartSucceeded = false;
    try {
      await rcon.send('RestartNow');
      console.log('[PVP] Server restart command sent');
      restartSucceeded = true;
    } catch (err) {
      console.error('[PVP] Restart command failed:', err.message);
      // Try QuickRestart as fallback
      try {
        await rcon.send('QuickRestart');
        restartSucceeded = true;
      } catch (err2) {
        console.error('[PVP] QuickRestart also failed:', err2.message);
      }
    }

    if (restartSucceeded) {
      this._currentPvp = targetPvp;
    } else {
      console.error('[PVP] Server restart failed — PvP state unchanged, will retry next tick');
    }
    this._transitioning = false;
  }

  /**
   * Post an announcement to the admin Discord channel.
   */
  async _announce(message) {
    console.log(`[PVP] ${message}`);
    if (this._adminChannel) {
      try {
        await this._adminChannel.send(`**[PvP Scheduler]** ${message}`);
      } catch (err) {
        console.error('[PVP] Failed to post to Discord:', err.message);
      }
    }
  }

  /**
   * Post a PvP state-change embed to the daily activity thread.
   */
  async _postToActivityLog(targetPvp) {
    if (!this._logWatcher) return;
    const label = targetPvp ? 'ENABLED' : 'DISABLED';
    const color = targetPvp ? 0xe74c3c : 0x2ecc71; // red for PvP on, green for PvP off
    const embed = new EmbedBuilder()
      .setAuthor({ name: `PvP ${label}` })
      .setDescription(`PvP has been **${label.toLowerCase()}** by the PvP scheduler.\nServer is restarting to apply the change.`)
      .setColor(color)
      .setTimestamp();
    try {
      await this._logWatcher.sendToThread(embed);
    } catch (err) {
      console.error('[PVP] Failed to post to activity thread:', err.message);
    }
  }
}

module.exports = PvpScheduler;

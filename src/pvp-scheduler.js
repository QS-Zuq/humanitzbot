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
    this._originalServerName = null; // cached base server name (before PvP suffix)
  }

  async start() {
    // Resolve start/end as total minutes from midnight.
    this._pvpStart = config.pvpStartMinutes;
    this._pvpEnd   = config.pvpEndMinutes;

    if (isNaN(this._pvpStart) || isNaN(this._pvpEnd)) {
      console.log('[PVP] PVP start/end time not configured, scheduler idle');
      return;
    }
    if (this._pvpStart === this._pvpEnd) {
      console.error('[PVP] PVP start and end times are the same — scheduler disabled');
      return;
    }

    const fmt = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    const dayLabel = config.pvpDays
      ? [...config.pvpDays].sort().map(d => ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d]).join(', ')
      : 'every day';
    console.log(`[PVP] Scheduler active: PvP ${fmt(this._pvpStart)}–${fmt(this._pvpEnd)} (${config.botTimezone}), days: ${dayLabel}`);
    console.log(`[PVP] Restart delay: ${config.pvpRestartDelay} minutes (warnings start before scheduled time)`);

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

  _getCurrentTime() {
    const now = new Date();
    const timeStr = now.toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: config.botTimezone,
    });
    const [h, m] = timeStr.split(':').map(Number);

    // Day of week (0=Sun … 6=Sat) in bot timezone
    const dayStr = now.toLocaleDateString('en-US', {
      weekday: 'short',
      timeZone: config.botTimezone,
    });
    const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const dayOfWeek = dayMap[dayStr] ?? now.getDay();

    return { hour: h, minute: m, totalMinutes: h * 60 + m, dayOfWeek };
  }

  _isInsidePvpWindow(totalMinutes, dayOfWeek) {
    const start = this._pvpStart;
    const end = this._pvpEnd;
    const pvpDays = config.pvpDays; // null = every day

    // Handle overnight windows (e.g. 22:00–06:00)
    if (start < end) {
      // Same-day window: must be a PvP day
      const dayOk = !pvpDays || pvpDays.has(dayOfWeek);
      return dayOk && totalMinutes >= start && totalMinutes < end;
    } else {
      // Overnight window: started on PvP day OR ended from yesterday's PvP day
      const prevDay = (dayOfWeek + 6) % 7;
      const startDayOk = !pvpDays || pvpDays.has(dayOfWeek);
      const prevDayOk  = !pvpDays || pvpDays.has(prevDay);
      return (startDayOk && totalMinutes >= start) || (prevDayOk && totalMinutes < end);
    }
  }

  _minutesUntilNextTransition() {
    const { totalMinutes, dayOfWeek } = this._getCurrentTime();
    const start = this._pvpStart; // PvP turns ON
    const end = this._pvpEnd;     // PvP turns OFF
    const insidePvp = this._isInsidePvpWindow(totalMinutes, dayOfWeek);
    const pvpDays = config.pvpDays; // null = every day

    let minutesUntil;
    let targetPvp;

    if (insidePvp) {
      // Currently inside PvP window — next transition is PvP OFF at end hour
      targetPvp = false;
      minutesUntil = end > totalMinutes ? end - totalMinutes : (1440 - totalMinutes) + end;
    } else {
      // Currently outside PvP window — next transition is PvP ON at start hour
      targetPvp = true;

      if (!pvpDays) {
        // Every day — same as before
        minutesUntil = start > totalMinutes ? start - totalMinutes : (1440 - totalMinutes) + start;
      } else {
        // Find the next PvP day
        minutesUntil = Infinity;
        for (let d = 0; d <= 7; d++) {
          const checkDay = (dayOfWeek + d) % 7;
          if (!pvpDays.has(checkDay)) continue;
          if (d === 0) {
            // Today — only valid if start hasn't passed yet
            if (totalMinutes < start) {
              minutesUntil = start - totalMinutes;
              break;
            }
            continue; // start already passed today
          }
          // Future day
          minutesUntil = (d * 1440) - totalMinutes + start;
          break;
        }
      }
    }

    return { minutesUntil, targetPvp };
  }

  _tick() {
    if (this._transitioning) return; // countdown already in progress

    // If state is unknown, retry reading from server
    if (this._currentPvp === null) {
      this._readCurrentState().catch(() => {});
      return;
    }

    const { minutesUntil, targetPvp } = this._minutesUntilNextTransition();
    const delay = config.pvpRestartDelay;

    // Skip if the server is already in the target state (e.g. after a manual toggle)
    if (targetPvp === this._currentPvp) return;

    // Start countdown when we're within the restart-delay window
    if (minutesUntil <= delay) {
      const targetLabel = targetPvp ? 'ON' : 'OFF';
      console.log(`[PVP] PvP turning ${targetLabel} in ${minutesUntil} minutes — starting countdown`);
      this._startCountdown(targetPvp, minutesUntil);
    }
  }

  _startCountdown(targetPvp, minutesUntilToggle) {
    this._transitioning = true;
    const targetLabel = targetPvp ? 'ON' : 'OFF';
    const delay = minutesUntilToggle !== undefined ? minutesUntilToggle : config.pvpRestartDelay;

    // Build warning schedule: which standard warnings fit within the remaining time
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
      let updated = content.replace(/^(PVP\s*=\s*)\d/m, `$1${targetValue}`);

      // Optionally update the ServerName with PvP schedule info
      if (config.pvpUpdateServerName) {
        updated = this._updateServerName(updated, targetPvp);
      }

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

  async _announce(message) {
    console.log(`[PVP] ${message}`);
    const embed = new EmbedBuilder()
      .setAuthor({ name: 'PvP Scheduler' })
      .setDescription(message)
      .setColor(0xf39c12)
      .setTimestamp();
    if (this._logWatcher) {
      try {
        await this._logWatcher.sendToThread(embed);
        return;
      } catch (err) {
        console.error('[PVP] Failed to post to activity thread:', err.message);
      }
    }
    if (this._adminChannel) {
      try {
        await this._adminChannel.send({ embeds: [embed] });
      } catch (err) {
        console.error('[PVP] Failed to post to Discord:', err.message);
      }
    }
  }

  // ── Server-name helpers ─────────────────────────────────────

  _formatPvpTimeRange() {
    const fmt = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    return `${fmt(this._pvpStart)}-${fmt(this._pvpEnd)} ${config.botTimezone}`;
  }

  _updateServerName(content, pvpOn) {
    // Match ServerName="value" or ServerName=value (greedy inside quotes)
    const nameMatch = content.match(/^ServerName\s*=\s*"([^"]*)"\s*$/m)
                   || content.match(/^ServerName\s*=\s*(.+?)\s*$/m);
    if (!nameMatch) {
      console.error('[PVP] Could not find ServerName= line in settings file');
      return content;
    }

    const currentName = nameMatch[1];
    console.log(`[PVP] Current ServerName: ${currentName}`);

    // Cache the original (suffix-free) server name on first encounter
    if (!this._originalServerName) {
      // Strip any existing PvP suffix so we always have the clean base name
      this._originalServerName = currentName.replace(/\s*-\s*PVP Enabled\s+\d{2}:\d{2}-\d{2}:\d{2}\s+\S+/, '').trim();
      console.log(`[PVP] Cached original server name: ${this._originalServerName}`);
    }

    let newName;
    if (pvpOn) {
      newName = `${this._originalServerName} - PVP Enabled ${this._formatPvpTimeRange()}`;
    } else {
      newName = this._originalServerName;
    }

    // Replace the entire ServerName line (handles both quoted and unquoted)
    const updatedContent = content.replace(
      /^ServerName\s*=.*$/m,
      `ServerName="${newName}"`
    );
    console.log(`[PVP] ServerName → ${newName}`);
    return updatedContent;
  }

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

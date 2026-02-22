const { EmbedBuilder } = require('discord.js');
const SftpClient = require('ssh2-sftp-client');
const _defaultConfig = require('./config');
const _defaultRcon = require('./rcon');

const WARNINGS = [10, 5, 3, 2, 1]; // countdown warnings in minutes

class PvpScheduler {
  constructor(client, logWatcher, deps = {}) {
    this._config = deps.config || _defaultConfig;
    this._rcon = deps.rcon || _defaultRcon;
    this._label = deps.label || 'PVP';
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
    // Resolve default start/end as total minutes from midnight.
    this._pvpStart = this._config.pvpStartMinutes;
    this._pvpEnd   = this._config.pvpEndMinutes;
    this._pvpDayHours = this._config.pvpDayHours; // Map<dayNum, { start, end }> | null

    if (isNaN(this._pvpStart) || isNaN(this._pvpEnd)) {
      // Per-day hours can still work without global defaults, but at least one must exist
      if (!this._pvpDayHours || this._pvpDayHours.size === 0) {
        console.log(`[${this._label}] PVP start/end time not configured, scheduler idle`);
        return;
      }
      console.log(`[${this._label}] No global PVP_START/END_TIME — using per-day overrides only`);
    } else if (this._pvpStart === this._pvpEnd) {
      console.error(`[${this._label}] PVP start and end times are the same — scheduler disabled`);
      return;
    }

    const fmt = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    const dayLabel = this._config.pvpDays
      ? [...this._config.pvpDays].sort().map(d => ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d]).join(', ')
      : 'every day';
    const defaultRange = (!isNaN(this._pvpStart) && !isNaN(this._pvpEnd))
      ? `${fmt(this._pvpStart)}–${fmt(this._pvpEnd)}`
      : 'none (per-day only)';
    console.log(`[${this._label}] Scheduler active: default ${defaultRange} (${this._config.botTimezone}), days: ${dayLabel}`);
    if (this._pvpDayHours) {
      const dayKeys = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
      for (const [d, h] of this._pvpDayHours) {
        console.log(`[${this._label}]   ${dayKeys[d]}: ${fmt(h.start)}–${fmt(h.end)}`);
      }
    }
    console.log(`[${this._label}] Restart delay: ${this._config.pvpRestartDelay} minutes (warnings start before scheduled time)`);

    // Resolve admin channel for announcements
    if (this._config.adminChannelId) {
      try {
        this._adminChannel = await this._client.channels.fetch(this._config.adminChannelId);
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
        host: this._config.ftpHost,
        port: this._config.ftpPort,
        username: this._config.ftpUser,
        password: this._config.ftpPassword,
      });
      const content = (await sftp.get(this._config.ftpSettingsPath)).toString('utf8');
      const match = content.match(/^PVP\s*=\s*(\d)/m);
      this._currentPvp = match ? match[1] === '1' : false;
      console.log(`[${this._label}] Current server PvP state: ${this._currentPvp ? 'ON' : 'OFF'}`);
    } catch (err) {
      console.error(`[${this._label}] Failed to read server settings:`, err.message);
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
      timeZone: this._config.botTimezone,
    });
    const [h, m] = timeStr.split(':').map(Number);

    // Day of week (0=Sun … 6=Sat) in bot timezone
    const dayStr = now.toLocaleDateString('en-US', {
      weekday: 'short',
      timeZone: this._config.botTimezone,
    });
    const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const dayOfWeek = dayMap[dayStr] ?? now.getDay();

    return { hour: h, minute: m, totalMinutes: h * 60 + m, dayOfWeek };
  }

  _isInsidePvpWindow(totalMinutes, dayOfWeek) {
    const pvpDays = this._config.pvpDays; // null = every day

    // Resolve time window for the given day (per-day override or global default)
    const { start, end } = this._getHoursForDay(dayOfWeek);
    if (start === undefined || end === undefined) return false;

    // Handle overnight windows (e.g. 22:00–06:00)
    if (start < end) {
      // Same-day window: must be a PvP day
      const dayOk = !pvpDays || pvpDays.has(dayOfWeek);
      return dayOk && totalMinutes >= start && totalMinutes < end;
    } else {
      // Overnight window: started on PvP day OR ended from yesterday's PvP day
      const prevDay = (dayOfWeek + 6) % 7;
      const { start: prevStart, end: prevEnd } = this._getHoursForDay(prevDay);
      const startDayOk = !pvpDays || pvpDays.has(dayOfWeek);
      const prevDayOk  = !pvpDays || pvpDays.has(prevDay);
      // Tail end from yesterday's overnight window
      if (prevDayOk && prevStart !== undefined && prevEnd !== undefined && prevStart > prevEnd && totalMinutes < prevEnd) return true;
      // Start of today's overnight window
      return startDayOk && totalMinutes >= start;
    }
  }

  /** Get PvP hours for a specific day (per-day override or global default). */
  _getHoursForDay(dayOfWeek) {
    if (this._pvpDayHours && this._pvpDayHours.has(dayOfWeek)) {
      return this._pvpDayHours.get(dayOfWeek);
    }
    return { start: this._pvpStart, end: this._pvpEnd };
  }

  _minutesUntilNextTransition() {
    const { totalMinutes, dayOfWeek } = this._getCurrentTime();
    const insidePvp = this._isInsidePvpWindow(totalMinutes, dayOfWeek);
    const pvpDays = this._config.pvpDays; // null = every day

    let minutesUntil;
    let targetPvp;

    if (insidePvp) {
      // Currently inside PvP window — next transition is PvP OFF at end hour
      targetPvp = false;
      // Determine which window we're in (today's start or yesterday's overnight tail)
      const { start, end } = this._getHoursForDay(dayOfWeek);
      if (start !== undefined && end !== undefined && start < end && totalMinutes >= start && totalMinutes < end) {
        // Normal same-day window
        minutesUntil = end - totalMinutes;
      } else {
        // Overnight: we might be in yesterday's tail (totalMinutes < prevEnd) or today's start (totalMinutes >= start)
        const prevDay = (dayOfWeek + 6) % 7;
        const prev = this._getHoursForDay(prevDay);
        if (prev.start !== undefined && prev.end !== undefined && prev.start > prev.end && totalMinutes < prev.end) {
          minutesUntil = prev.end - totalMinutes;
        } else {
          // Today's overnight start — end is tomorrow
          minutesUntil = (1440 - totalMinutes) + end;
        }
      }
    } else {
      // Currently outside PvP window — next transition is PvP ON at start hour
      targetPvp = true;

      if (!pvpDays) {
        // Every day — find the next day that has hours configured
        minutesUntil = Infinity;
        for (let d = 0; d <= 7; d++) {
          const checkDay = (dayOfWeek + d) % 7;
          const h = this._getHoursForDay(checkDay);
          if (h.start === undefined || isNaN(h.start)) continue;
          if (d === 0) {
            if (totalMinutes < h.start) {
              minutesUntil = h.start - totalMinutes;
              break;
            }
            continue;
          }
          minutesUntil = (d * 1440) - totalMinutes + h.start;
          break;
        }
      } else {
        // Find the next PvP day
        minutesUntil = Infinity;
        for (let d = 0; d <= 7; d++) {
          const checkDay = (dayOfWeek + d) % 7;
          if (!pvpDays.has(checkDay)) continue;
          const h = this._getHoursForDay(checkDay);
          if (h.start === undefined || isNaN(h.start)) continue;
          if (d === 0) {
            // Today — only valid if start hasn't passed yet
            if (totalMinutes < h.start) {
              minutesUntil = h.start - totalMinutes;
              break;
            }
            continue; // start already passed today
          }
          // Future day
          minutesUntil = (d * 1440) - totalMinutes + h.start;
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
    const delay = this._config.pvpRestartDelay;

    // Skip if the server is already in the target state (e.g. after a manual toggle)
    if (targetPvp === this._currentPvp) return;

    // Start countdown when we're within the restart-delay window
    if (minutesUntil <= delay) {
      const targetLabel = targetPvp ? 'ON' : 'OFF';
      console.log(`[${this._label}] PvP turning ${targetLabel} in ${minutesUntil} minutes — starting countdown`);
      this._startCountdown(targetPvp, minutesUntil);
    }
  }

  _startCountdown(targetPvp, minutesUntilToggle) {
    this._transitioning = true;
    const targetLabel = targetPvp ? 'ON' : 'OFF';
    const delay = minutesUntilToggle !== undefined ? minutesUntilToggle : this._config.pvpRestartDelay;

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

  async _executeToggle(targetPvp) {
    const targetLabel = targetPvp ? 'ON' : 'OFF';
    const targetValue = targetPvp ? '1' : '0';

    console.log(`[${this._label}] Executing PvP toggle → ${targetLabel}`);

    const sftp = new SftpClient();
    try {
      await sftp.connect({
        host: this._config.ftpHost,
        port: this._config.ftpPort,
        username: this._config.ftpUser,
        password: this._config.ftpPassword,
      });

      // Download current ini
      const content = (await sftp.get(this._config.ftpSettingsPath)).toString('utf8');

      // Toggle the PVP line
      if (!content.match(/^PVP\s*=\s*\d/m)) {
        console.error(`[${this._label}] Could not find PVP= line in settings file!`);
        this._transitioning = false;
        return;
      }
      let updated = content.replace(/^(PVP\s*=\s*)\d/m, `$1${targetValue}`);

      // Optionally update the ServerName with PvP schedule info
      if (this._config.pvpUpdateServerName) {
        updated = this._updateServerName(updated, targetPvp);
      }

      if (updated === content) {
        console.log(`[${this._label}] Settings file already has PVP=${targetValue}, skipping upload`);
        // Still restart to ensure server is in sync
      } else {
        // Upload modified ini
        await sftp.put(Buffer.from(updated, 'utf8'), this._config.ftpSettingsPath);
        console.log(`[${this._label}] Uploaded settings with PVP=${targetValue}`);
      }

    } catch (err) {
      console.error(`[${this._label}] SFTP toggle failed:`, err.message);
      this._transitioning = false;
      return;
    } finally {
      await sftp.end().catch(() => {});
    }

    // Announce and restart
    const restartMsg = `PvP is now ${targetLabel}! Server restarting...`;
    this._announce(restartMsg);
    await this._rcon.send(`admin ${restartMsg}`).catch(() => {});

    // Post to daily activity thread
    await this._postToActivityLog(targetPvp);

    let restartSucceeded = false;
    try {
      await this._rcon.send('RestartNow');
      console.log(`[${this._label}] Server restart command sent`);
      restartSucceeded = true;
    } catch (err) {
      console.error(`[${this._label}] Restart command failed:`, err.message);
      // Try QuickRestart as fallback
      try {
        await this._rcon.send('QuickRestart');
        restartSucceeded = true;
      } catch (err2) {
        console.error(`[${this._label}] QuickRestart also failed:`, err2.message);
      }
    }

    if (restartSucceeded) {
      this._currentPvp = targetPvp;
    } else {
      console.error(`[${this._label}] Server restart failed — PvP state unchanged, will retry next tick`);
    }
    this._transitioning = false;
  }

  async _announce(message) {
    console.log(`[${this._label}] ${message}`);
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
        console.error(`[${this._label}] Failed to post to activity thread:`, err.message);
      }
    }
    if (this._adminChannel) {
      try {
        await this._adminChannel.send({ embeds: [embed] });
      } catch (err) {
        console.error(`[${this._label}] Failed to post to Discord:`, err.message);
      }
    }
  }

  // ── Server-name helpers ─────────────────────────────────────

  _formatPvpTimeRange() {
    const fmt = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    // Use today's hours (per-day override or global default)
    const { dayOfWeek } = this._getCurrentTime();
    const { start, end } = this._getHoursForDay(dayOfWeek);
    if (start === undefined || end === undefined) {
      return `${fmt(this._pvpStart)}-${fmt(this._pvpEnd)} ${this._config.botTimezone}`;
    }
    return `${fmt(start)}-${fmt(end)} ${this._config.botTimezone}`;
  }

  _updateServerName(content, pvpOn) {
    // Match ServerName="value" or ServerName=value (greedy inside quotes)
    const nameMatch = content.match(/^ServerName\s*=\s*"([^"]*)"\s*$/m)
                   || content.match(/^ServerName\s*=\s*(.+?)\s*$/m);
    if (!nameMatch) {
      console.error(`[${this._label}] Could not find ServerName= line in settings file`);
      return content;
    }

    const currentName = nameMatch[1];
    console.log(`[${this._label}] Current ServerName: ${currentName}`);

    // Cache the original (suffix-free) server name on first encounter
    if (!this._originalServerName) {
      // Strip any existing PvP suffix so we always have the clean base name
      this._originalServerName = currentName.replace(/\s*-\s*PVP Enabled\s+\d{2}:\d{2}-\d{2}:\d{2}\s+\S+/, '').trim();
      console.log(`[${this._label}] Cached original server name: ${this._originalServerName}`);
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
    console.log(`[${this._label}] ServerName → ${newName}`);
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
      console.error(`[${this._label}] Failed to post to activity thread:`, err.message);
    }
  }
}

module.exports = PvpScheduler;

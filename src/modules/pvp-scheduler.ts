import { EmbedBuilder, type Client, type Message } from 'discord.js';
import SftpClient from 'ssh2-sftp-client';
import { exec } from 'child_process';
import _defaultConfig from '../config/index.js';
import _defaultRcon from '../rcon/rcon.js';
import { createLogger, type Logger } from '../utils/log.js';
import { errMsg } from '../utils/error.js';

const WARNINGS = [10, 5, 3, 2, 1]; // countdown warnings in minutes

type ConfigType = typeof _defaultConfig;
type RconType = typeof _defaultRcon;

interface PvpSchedulerDeps {
  config?: ConfigType;
  rcon?: RconType;
  label?: string;
}

// LogWatcher mixes in sendToThread at runtime via Object.assign.
interface LogWatcherLike {
  sendToThread(embed: EmbedBuilder): Promise<unknown>;
}

interface ChannelLike {
  send(options: { embeds: EmbedBuilder[] }): Promise<Message>;
}

interface DateTimeParts {
  type: string;
  value: string;
}

interface PvpHours {
  start: number | undefined;
  end: number | undefined;
}

class PvpScheduler {
  private _config: ConfigType;
  private _rcon: RconType;
  private _log: Logger;
  private _client: Client;
  private _logWatcher: LogWatcherLike | null;
  private _interval: ReturnType<typeof setInterval> | null;
  private _countdownTimer: ReturnType<typeof setTimeout> | null;
  private _transitioning: boolean;
  private _currentPvp: boolean | null;
  private _adminChannel: ChannelLike | null;
  private _originalServerName: string | null;
  private _originalSettings: Record<string, string> | null;
  private _pvpStart: number;
  private _pvpEnd: number;
  private _pvpDayHours: Map<number, { start: number; end: number }> | null;

  constructor(client: Client, logWatcher: LogWatcherLike | null | undefined, deps: PvpSchedulerDeps = {}) {
    this._config = deps.config ?? _defaultConfig;
    this._rcon = deps.rcon ?? _defaultRcon;
    this._log = createLogger(deps.label, 'PVP');
    this._client = client; // Discord client (for posting announcements)
    this._logWatcher = logWatcher ?? null; // for posting to activity thread
    this._interval = null;
    this._countdownTimer = null;
    this._transitioning = false;
    this._currentPvp = null; // true = PvP ON, false = PvP OFF, null = unknown
    this._adminChannel = null;
    this._originalServerName = null; // cached base server name (before PvP suffix)
    this._originalSettings = null; // cached original .ini values before PvP overrides
    this._pvpStart = 0;
    this._pvpEnd = 0;
    this._pvpDayHours = null;
  }

  async start() {
    // Resolve default start/end as total minutes from midnight.
    this._pvpStart = this._config.pvpStartMinutes;
    this._pvpEnd = this._config.pvpEndMinutes;
    this._pvpDayHours = this._config.pvpDayHours; // Map<dayNum, { start, end }> | null

    if (isNaN(this._pvpStart) || isNaN(this._pvpEnd)) {
      // Per-day hours can still work without global defaults, but at least one must exist
      if (!this._pvpDayHours || this._pvpDayHours.size === 0) {
        this._log.info('PVP start/end time not configured, scheduler idle');
        return;
      }
      this._log.info('No global PVP_START/END_TIME — using per-day overrides only');
    } else if (this._pvpStart === this._pvpEnd) {
      this._log.error('PVP start and end times are the same — scheduler disabled');
      return;
    }

    const fmt = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    const dayLabel = this._config.pvpDays
      ? [...this._config.pvpDays]
          .sort()
          .map((d: number) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d])
          .join(', ')
      : 'every day';
    const defaultRange =
      !isNaN(this._pvpStart) && !isNaN(this._pvpEnd)
        ? `${fmt(this._pvpStart)}–${fmt(this._pvpEnd)}`
        : 'none (per-day only)';
    this._log.info(`Scheduler active: default ${defaultRange} (${this._config.botTimezone}), days: ${dayLabel}`);
    if (this._pvpDayHours) {
      const dayKeys = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      for (const [d, h] of this._pvpDayHours) {
        this._log.info(`  ${dayKeys[d]}: ${fmt(h.start)}–${fmt(h.end)}`);
      }
    }
    this._log.info(`Restart delay: ${this._config.pvpRestartDelay} minutes (warnings start before scheduled time)`);

    // Resolve admin channel for announcements
    if (this._config.adminChannelId) {
      try {
        this._adminChannel = (await this._client.channels.fetch(this._config.adminChannelId)) as ChannelLike | null;
      } catch {
        /* no channel, just log to console */
      }
    }

    // Read current PvP state from server
    await this._readCurrentState();

    // Check every 60 seconds
    this._interval = setInterval(() => {
      this._tick();
    }, 60_000);
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
      await sftp.connect(this._config.sftpConnectConfig());
      const content = ((await sftp.get(this._config.sftpSettingsPath)) as Buffer).toString('utf8');
      const match = content.match(/^PVP\s*=\s*(\d)/m);
      this._currentPvp = match ? match[1] === '1' : false;
      this._log.info(`Current server PvP state: ${this._currentPvp ? 'ON' : 'OFF'}`);

      // Pre-cache original values for PvP settings overrides (so we can revert if bot started mid-PvP)
      const overrides = this._config.pvpSettingsOverrides;
      if (overrides && !this._originalSettings && !this._currentPvp) {
        this._originalSettings = {};
        for (const key of Object.keys(overrides)) {
          const m = content.match(new RegExp(`^${key}\\s*=\\s*(.+?)\\s*$`, 'm'));
          if (m?.[1]) this._originalSettings[key] = m[1];
        }
        if (Object.keys(this._originalSettings).length > 0) {
          this._log.info(
            `Pre-cached ${Object.keys(this._originalSettings).length} PvE setting(s) for PvP override revert`,
          );
        }
      }
    } catch (err: unknown) {
      this._log.error('Failed to read server settings:', errMsg(err));
      this._currentPvp = null;
    } finally {
      await sftp.end().catch(() => {});
    }
  }

  _getCurrentTime(): { hour: number; minute: number; totalMinutes: number; dayOfWeek: number } {
    const now = new Date();
    const timeParts = new Intl.DateTimeFormat('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      hourCycle: 'h23',
      timeZone: this._config.botTimezone,
    }).formatToParts(now) as DateTimeParts[];
    const h = parseInt(timeParts.find((p) => p.type === 'hour')?.value ?? '0', 10);
    const m = parseInt(timeParts.find((p) => p.type === 'minute')?.value ?? '0', 10);

    // Day of week (0=Sun … 6=Sat) in bot timezone
    const dateParts = new Intl.DateTimeFormat('en-US', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      timeZone: this._config.botTimezone,
    }).formatToParts(now) as DateTimeParts[];
    const year = parseInt(dateParts.find((p) => p.type === 'year')?.value ?? '1970', 10);
    const month = parseInt(dateParts.find((p) => p.type === 'month')?.value ?? '1', 10);
    const day = parseInt(dateParts.find((p) => p.type === 'day')?.value ?? '1', 10);
    const dayOfWeek = new Date(Date.UTC(year, month - 1, day)).getUTCDay();

    return { hour: h, minute: m, totalMinutes: h * 60 + m, dayOfWeek };
  }

  _isInsidePvpWindow(totalMinutes: number, dayOfWeek: number): boolean {
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
      const prevDayOk = !pvpDays || pvpDays.has(prevDay);
      // Tail end from yesterday's overnight window
      if (
        prevDayOk &&
        prevStart !== undefined &&
        prevEnd !== undefined &&
        prevStart > prevEnd &&
        totalMinutes < prevEnd
      )
        return true;
      // Start of today's overnight window
      return startDayOk && totalMinutes >= start;
    }
  }

  /** Get PvP hours for a specific day (per-day override or global default). */
  _getHoursForDay(dayOfWeek: number): PvpHours {
    const dayHours = this._pvpDayHours?.get(dayOfWeek);
    if (dayHours) {
      return dayHours;
    }
    return { start: this._pvpStart, end: this._pvpEnd };
  }

  _minutesUntilNextTransition(): { minutesUntil: number; targetPvp: boolean } {
    const { totalMinutes, dayOfWeek } = this._getCurrentTime();
    const insidePvp = this._isInsidePvpWindow(totalMinutes, dayOfWeek);
    const pvpDays = this._config.pvpDays; // null = every day

    let minutesUntil: number;
    let targetPvp: boolean;

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
          minutesUntil = 1440 - totalMinutes + (end ?? 0);
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
          minutesUntil = d * 1440 - totalMinutes + h.start;
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
          minutesUntil = d * 1440 - totalMinutes + h.start;
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
      void this._readCurrentState().catch(() => {});
      return;
    }

    const { minutesUntil, targetPvp } = this._minutesUntilNextTransition();
    const delay = this._config.pvpRestartDelay;

    // Skip if the server is already in the target state (e.g. after a manual toggle)
    if (targetPvp === this._currentPvp) return;

    // Start countdown when we're within the restart-delay window
    if (minutesUntil <= delay) {
      const targetLabel = targetPvp ? 'ON' : 'OFF';
      this._log.info(`PvP turning ${targetLabel} in ${minutesUntil} minutes — starting countdown`);
      this._startCountdown(targetPvp, minutesUntil);
    }
  }

  _startCountdown(targetPvp: boolean, minutesUntilToggle: number) {
    this._transitioning = true;
    const targetLabel = targetPvp ? 'ON' : 'OFF';
    const delay = minutesUntilToggle;

    // Build warning schedule: which standard warnings fit within the remaining time
    const warnings = WARNINGS.filter((m) => m <= delay);
    if (warnings.length === 0 || (warnings[0] ?? 0) < delay) {
      warnings.unshift(delay);
    }

    let stepIndex = 0;

    const scheduleNext = () => {
      if (stepIndex >= warnings.length) {
        // Countdown complete — execute the toggle
        void this._executeToggle(targetPvp);
        return;
      }

      const minutesLeft = warnings[stepIndex] ?? 0;
      const nextMinutes = stepIndex + 1 < warnings.length ? (warnings[stepIndex + 1] ?? 0) : 0;
      const waitMs = (minutesLeft - nextMinutes) * 60_000;

      // Send warning
      const msg = `Server restart in ${minutesLeft} minute${minutesLeft > 1 ? 's' : ''} — PvP turning ${targetLabel}`;
      void this._announce(msg);
      void this._rcon.send(`admin ${msg}`).catch((err: unknown) => {
        this._log.error('Failed to send in-game warning:', errMsg(err));
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

  async _executeToggle(targetPvp: boolean) {
    const targetLabel = targetPvp ? 'ON' : 'OFF';
    const targetValue = targetPvp ? '1' : '0';

    this._log.info(`Executing PvP toggle → ${targetLabel}`);

    const sftp = new SftpClient();
    try {
      await sftp.connect(this._config.sftpConnectConfig());

      // Ensure the file is writable (Bisect hosting defaults to 444)
      const settingsPath = this._config.sftpSettingsPath;
      let originalMode: number | null = null;
      try {
        const stat = await sftp.stat(settingsPath);
        const mode = stat.mode & 0o777;
        if (!(mode & 0o200)) {
          // Owner-write bit is not set — temporarily make writable
          originalMode = mode;
          await sftp.chmod(settingsPath, mode | 0o220); // add group+owner write
          this._log.info(`Temporarily set ${settingsPath} writable (was ${mode.toString(8)})`);
        }
      } catch (err: unknown) {
        this._log.warn('Could not check/set file permissions:', errMsg(err));
      }

      // Download current ini
      const content = ((await sftp.get(settingsPath)) as Buffer).toString('utf8');

      // Toggle the PVP line
      if (!content.match(/^PVP\s*=\s*\d/m)) {
        this._log.error('Could not find PVP= line in settings file!');
        this._transitioning = false;
        return;
      }
      let updated = content.replace(/^(PVP\s*=\s*)\d/m, `$1${targetValue}`);

      // Apply / revert PvP settings overrides
      updated = this._applySettingsOverrides(updated, targetPvp, content);

      // Optionally update the ServerName with PvP schedule info
      if (this._config.pvpUpdateServerName) {
        updated = this._updateServerName(updated, targetPvp);
      }

      if (updated === content) {
        this._log.info(`Settings file already has PVP=${targetValue}, skipping upload`);
        // Still restart to ensure server is in sync
      } else {
        // Upload modified ini
        await sftp.put(Buffer.from(updated, 'utf8'), settingsPath);
        this._log.info(`Uploaded settings with PVP=${targetValue}`);
      }

      // Restore original permissions if we changed them
      if (originalMode !== null) {
        try {
          await sftp.chmod(settingsPath, originalMode);
          this._log.info(`Restored permissions to ${originalMode.toString(8)}`);
        } catch (err: unknown) {
          this._log.warn('Could not restore permissions:', errMsg(err));
        }
      }
    } catch (err: unknown) {
      this._log.error('SFTP toggle failed:', errMsg(err));
      this._transitioning = false;
      return;
    } finally {
      await sftp.end().catch(() => {});
    }

    // Announce and restart
    const restartMsg = `PvP is now ${targetLabel}! Server restarting...`;
    void this._announce(restartMsg);
    await this._rcon.send(`admin ${restartMsg}`).catch(() => {});

    // Post to daily activity thread
    await this._postToActivityLog(targetPvp);

    // Execute restart
    let restartSucceeded = false;
    const container = this._config.dockerContainer || process.env.DOCKER_CONTAINER;

    // Prefer LinuxGSM restart inside the container — restarts the game process
    // without touching the container itself. LinuxGSM gracefully stops the game,
    // waits for clean exit, then starts fresh so RCON port binds correctly.
    // Falls back to docker stop+start if LinuxGSM fails.
    if (container) {
      try {
        await new Promise<void>((resolve, reject) => {
          exec(`docker exec -u linuxgsm ${container} /app/hzserver restart`, { timeout: 120000 }, (err, stdout) => {
            if (err) reject(err as Error);
            else {
              if (stdout) this._log.info(`LinuxGSM: ${stdout.trim().split('\n').pop() ?? ''}`);
              resolve();
            }
          });
        });
        this._log.info(`Restart via LinuxGSM (${container})`);
        restartSucceeded = true;
      } catch (lgsmErr: unknown) {
        this._log.warn(`LinuxGSM restart failed: ${errMsg(lgsmErr)}, falling back to docker stop+start`);
        try {
          await new Promise<void>((resolve, reject) => {
            exec(`docker stop ${container} && docker start ${container}`, { timeout: 120000 }, (err) => {
              if (err) reject(err as Error);
              else resolve();
            });
          });
          this._log.info(`Restart via Docker stop+start (${container})`);
          restartSucceeded = true;
        } catch (dockerErr: unknown) {
          this._log.warn('Docker restart also failed:', errMsg(dockerErr));
        }
      }
    }

    // Fallback: RCON restart (non-Docker setups, or if Docker failed)
    if (!restartSucceeded) {
      try {
        await this._rcon.send('RestartNow');
        this._log.info('Restart command sent via RCON');
        restartSucceeded = true;
      } catch (err: unknown) {
        this._log.warn('RCON RestartNow failed:', errMsg(err));
        try {
          await this._rcon.send('QuickRestart');
          this._log.info('Restart via RCON QuickRestart');
          restartSucceeded = true;
        } catch (err2: unknown) {
          this._log.error('All restart methods failed:', errMsg(err2));
        }
      }
    }

    if (restartSucceeded) {
      this._currentPvp = targetPvp;

      // Post-restart RCON health check — if RCON doesn't reconnect within 90s,
      // the game server likely failed to bind the RCON port.
      // Trigger a LinuxGSM restart (or docker stop+start) to recover.
      if (container) {
        this._scheduleRconHealthCheck(container);
      }
    } else {
      this._log.error('Server restart failed — PvP state unchanged, will retry next tick');
    }
    this._transitioning = false;
  }

  /**
   * After a restart, poll RCON connectivity for up to 90s.
   * If RCON doesn't come back, the game server likely failed to bind the port.
   * Trigger a LinuxGSM restart (or docker stop+start fallback) to recover.
   */
  _scheduleRconHealthCheck(container: string) {
    const checkInterval = 10_000;
    const maxWait = 90_000;
    const start = Date.now();
    this._log.info(`RCON health check started — will verify within ${maxWait / 1000}s`);

    const timer = setInterval(() => {
      if (this._rcon.connected && this._rcon.authenticated) {
        clearInterval(timer);
        this._log.info('RCON health check passed — connected');
        return;
      }
      if (Date.now() - start >= maxWait) {
        clearInterval(timer);
        this._log.warn(`RCON health check FAILED — no connection after ${maxWait / 1000}s, restarting game process`);
        void (async () => {
          try {
            await new Promise<void>((resolve, reject) => {
              exec(`docker exec -u linuxgsm ${container} /app/hzserver restart`, { timeout: 120000 }, (err) => {
                if (err) {
                  exec(`docker stop ${container} && docker start ${container}`, { timeout: 120000 }, (err2) => {
                    if (err2) reject(err2 as Error);
                    else resolve();
                  });
                } else resolve();
              });
            });
            this._log.info(`Recovery restart sent (${container})`);
          } catch (err: unknown) {
            this._log.error('Recovery restart failed:', errMsg(err));
          }
        })();
      }
    }, checkInterval);
  }

  async _announce(message: string) {
    this._log.info(message);
    const embed = new EmbedBuilder()
      .setAuthor({ name: '⚔️ PvP Scheduler' })
      .setDescription(message)
      .setColor(0xf39c12)
      .setTimestamp();
    if (this._logWatcher) {
      try {
        await this._logWatcher.sendToThread(embed);
        return;
      } catch (err: unknown) {
        this._log.error('Failed to post to activity thread:', errMsg(err));
      }
    }
    if (this._adminChannel) {
      try {
        await this._adminChannel.send({ embeds: [embed] });
      } catch (err: unknown) {
        this._log.error('Failed to post to Discord:', errMsg(err));
      }
    }
  }

  // ── Settings overrides ─────────────────────────────────────

  /**
   * Apply or revert PVP_SETTINGS_OVERRIDES to ini content.
   * When turning PvP ON: cache current values, apply overrides.
   * When turning PvP OFF: restore cached originals.
   */
  _applySettingsOverrides(content: string, targetPvp: boolean, rawContent: string): string {
    const overrides = this._config.pvpSettingsOverrides;
    if (!overrides || Object.keys(overrides).length === 0) return content;

    let updated = content;

    if (targetPvp) {
      // Turning ON — cache originals and apply overrides
      if (!this._originalSettings) {
        this._originalSettings = {};
        for (const key of Object.keys(overrides)) {
          const match = rawContent.match(new RegExp(`^${key}\\s*=\\s*(.+?)\\s*$`, 'm'));
          if (match?.[1]) {
            this._originalSettings[key] = match[1];
          }
        }
        this._log.info(`Cached ${Object.keys(this._originalSettings).length} original setting(s) for PvP revert`);
      }

      for (const [key, value] of Object.entries(overrides)) {
        const regex = new RegExp(`^(${key}\\s*=\\s*)(.+?)\\s*$`, 'm');
        if (regex.test(updated)) {
          updated = updated.replace(regex, `$1${value}`);
          this._log.info(`PvP override: ${key} → ${value}`);
        } else {
          this._log.warn(`PvP override: ${key} not found in settings file`);
        }
      }
    } else {
      // Turning OFF — restore originals
      if (this._originalSettings) {
        for (const [key, originalValue] of Object.entries(this._originalSettings)) {
          const regex = new RegExp(`^(${key}\\s*=\\s*)(.+?)\\s*$`, 'm');
          if (regex.test(updated)) {
            updated = updated.replace(regex, `$1${originalValue}`);
            this._log.info(`PvP revert: ${key} → ${originalValue}`);
          }
        }
        this._log.info(`Restored ${Object.keys(this._originalSettings).length} original setting(s)`);
      } else {
        this._log.warn('No cached originals to revert — settings may already be in PvE state');
      }
    }

    return updated;
  }

  // ── Server-name helpers ─────────────────────────────────────

  _formatPvpTimeRange(): string {
    const fmt = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    // Use today's hours (per-day override or global default)
    const { dayOfWeek } = this._getCurrentTime();
    const { start, end } = this._getHoursForDay(dayOfWeek);
    if (start === undefined || end === undefined) {
      return `${fmt(this._pvpStart)}-${fmt(this._pvpEnd)} ${this._config.botTimezone}`;
    }
    return `${fmt(start)}-${fmt(end)} ${this._config.botTimezone}`;
  }

  _updateServerName(content: string, pvpOn: boolean): string {
    // Match ServerName="value" or ServerName=value (greedy inside quotes)
    const nameMatch =
      content.match(/^ServerName\s*=\s*"([^"]*)"\s*$/m) || content.match(/^ServerName\s*=\s*(.+?)\s*$/m);
    if (!nameMatch) {
      this._log.error('Could not find ServerName= line in settings file');
      return content;
    }

    const currentName = nameMatch[1] ?? '';
    this._log.info(`Current ServerName: ${currentName}`);

    // Cache the original (suffix-free) server name on first encounter
    if (!this._originalServerName) {
      // Strip any existing PvP suffix so we always have the clean base name
      this._originalServerName = currentName.replace(/\s*-\s*PVP Enabled\s+\d{2}:\d{2}-\d{2}:\d{2}\s+\S+/, '').trim();
      this._log.info(`Cached original server name: ${this._originalServerName}`);
    }

    let newName: string;
    if (pvpOn) {
      newName = `${this._originalServerName} - PvP Enabled ${this._formatPvpTimeRange()}`;
    } else {
      newName = this._originalServerName;
    }

    // Replace the entire ServerName line (handles both quoted and unquoted)
    const updatedContent = content.replace(/^ServerName\s*=.*$/m, `ServerName="${newName}"`);
    this._log.info(`ServerName → ${newName}`);
    return updatedContent;
  }

  async _postToActivityLog(targetPvp: boolean) {
    if (!this._logWatcher) return;
    const label = targetPvp ? 'ENABLED' : 'DISABLED';
    const color = targetPvp ? 0xe74c3c : 0x2ecc71; // red for PvP on, green for PvP off
    const embed = new EmbedBuilder()
      .setAuthor({ name: `⚔️ PvP ${label}` })
      .setDescription(
        `PvP has been **${label.toLowerCase()}** by the PvP scheduler.\nServer is restarting to apply the change.`,
      )
      .setColor(color)
      .setTimestamp();
    try {
      await this._logWatcher.sendToThread(embed);
    } catch (err: unknown) {
      this._log.error('Failed to post to activity thread:', errMsg(err));
    }
  }
}

export default PvpScheduler;
export { PvpScheduler };

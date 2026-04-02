/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment,
   @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call,
   @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return,
   @typescript-eslint/restrict-template-expressions,
   @typescript-eslint/restrict-plus-operands, @typescript-eslint/no-misused-promises,
   @typescript-eslint/no-confusing-void-expression */

import { EmbedBuilder } from 'discord.js';
// @ts-expect-error — no type declarations for ssh2-sftp-client
import SftpClient from 'ssh2-sftp-client';
import path from 'path';
import _defaultConfig from '../config/index.js';
import { cleanName } from '../parsers/ue4-names.js';
import _defaultPlaytime from '../tracking/playtime-tracker.js';
import _defaultPlayerStats from '../tracking/player-stats.js';
import { classifyDamageSource, isNpcDamageSource } from '../tracking/damage-classifier.js';
import { createLogger } from '../utils/log.js';

class LogWatcher {
  [key: string]: any;
  constructor(client: any, deps: any = {}) {
    this._config = deps.config || _defaultConfig;
    this._playtime = deps.playtime || _defaultPlaytime;
    this._playerStats = deps.playerStats || _defaultPlayerStats;
    this._db = deps.db || null;
    this._log = createLogger(deps.label, 'LOGS');
    this._label = this._log.label;
    this._dataDir = deps.dataDir || null;
    this._panelApi = deps.panelApi || null;

    this.client = client;
    this.logChannel = null;
    this._headless = false; // true when running without a Discord channel (web-panel-only data collection)
    this.interval = null;

    // HMZLog.log state
    this.lastSize = 0;
    this.partialLine = '';
    this.initialised = false;

    // PlayerConnectedLog.txt state
    this._connectLastSize = 0;
    this._connectPartialLine = '';
    this._connectInitialised = false;

    // Per-restart rotated logs (HZLogs/ directory — game update Feb 28 2026)
    // When detected, we tail the latest file in HZLogs/ instead of the old monolithic files.
    // File naming: {D}-{M}_{H}-{m}_HMZLog.log, Chat/{same}_Chat.log, Login/{same}_ConnectLog.txt
    this._useRotatedLogs = false;
    this._hmzLogFile = null; // current HMZLog file path being tailed
    this._connectLogFile = null; // current ConnectLog file path being tailed

    // Daily thread
    this._dailyThread = null;
    this._dailyDate = null; // 'YYYY-MM-DD'
    this._dayRolloverCb = null; // callback after daily thread created on rollover
    this._nukeActive = false; // true during NUKE_BOT — suppresses thread creation

    // Batching (reduces Discord spam)
    this._lootBatch = {}; // key → { looter, looterId, ownerSteamId, count, containers }
    this._lootTimer = null;
    this._buildBatch = {}; // steamId → { name, items: { item: count }, timestamp }
    this._buildTimer = null;
    this._raidBatch = {}; // attacker|owner → { attacker, owner, hits, destroyed, buildings, timestamp }
    this._raidTimer = null;

    // Daily counters for the summary
    this._dayCounts = {
      connects: 0,
      disconnects: 0,
      deaths: 0,
      builds: 0,
      damage: 0,
      loots: 0,
      raidHits: 0,
      destroyed: 0,
      admin: 0,
      cheat: 0,
      pvpKills: 0,
    };
    this._dayCountsDirty = false;
    this._loadDayCounts();

    // Online player tracking (for peak stats)
    this._onlinePlayers = new Set();

    // PlayerIDMapped.txt warning flag
    this._idMapWarned = false;
    this._idMapLastSize = 0;

    // PvP damage tracker: Map<victimNameLower, { attacker, attackerLower, timestamp, totalDamage }>
    // Used to correlate damage → death for PvP kill attribution
    this._pvpDamageTracker = new Map();

    // PvP kill log: last N kills for the "Last 10 Kills" display
    // Persisted to bot_state DB table
    this._pvpKills = [];
    this._pvpKillsDirty = false;
    this._loadPvpKills();

    // Death loop detection: Map<playerNameLower, { count, firstTimestamp, lastTimestamp, suppressed }>
    this._deathLoopTracker = new Map();

    // Container access tracker: tracks who opened which container type recently.
    // Used by ActivityLog to attribute container item changes to players.
    // Map<containerTypeNorm, { player, steamId, ownerSteamId, timestamp }>
    this._recentContainerAccess = new Map();

    // Death cause tracker: tracks ALL damage sources (NPC, animal, zombie, player)
    // for death attribution. Same pattern as _pvpDamageTracker but covers everything.
    // Map<victimNameLower, { source, sourceRaw, timestamp, totalDamage }>
    this._deathCauseTracker = new Map();
  }

  // ── Damage source classification (delegated to shared damage-classifier.js) ──

  _classifyDamageSource(source: any) {
    return classifyDamageSource(source);
  }

  // ── Day Counts Persistence ─────────────────────────────────

  _loadDayCounts() {
    try {
      if (!this._db) return;
      const raw = this._db.getStateJSON('day_counts', null);
      if (raw && raw.date === this._config.getToday()) {
        this._dayCounts = { ...this._dayCounts, ...raw.counts };
        this._log.info(`Restored day counts for ${raw.date} (DB)`);
      }
    } catch (err: any) {
      this._log.warn('Could not load day counts:', err.message);
    }
  }

  _saveDayCounts() {
    if (!this._dayCountsDirty) return;
    try {
      if (!this._db) return;
      const data = { date: this._dailyDate || this._config.getToday(), counts: this._dayCounts };
      this._db.setStateJSON('day_counts', data);
      this._dayCountsDirty = false;
    } catch (err: any) {
      this._log.warn('Could not save day counts:', err.message);
    }
  }

  _incDayCount(key: any) {
    this._dayCounts[key]++;
    this._dayCountsDirty = true;
  }

  // ── PvP Kill Tracking ──────────────────────────────────────

  _loadPvpKills() {
    try {
      if (!this._db) return;
      const raw = this._db.getStateJSON('pvp_kills', null);
      if (Array.isArray(raw)) {
        this._pvpKills = raw;
        this._log.info(`PVP: Loaded ${raw.length} PvP kill(s) from DB`);
      }
    } catch (err: any) {
      this._log.warn('PVP: Could not load pvp kills:', err.message);
      this._pvpKills = [];
    }
  }

  _savePvpKills() {
    if (!this._pvpKillsDirty) return;
    try {
      if (!this._db) return;
      this._db.setStateJSON('pvp_kills', this._pvpKills);
      this._pvpKillsDirty = false;
    } catch (err: any) {
      this._log.warn('PVP: Could not save pvp kills:', err.message);
    }
  }

  _recordPvpDamage(victim: any, attacker: any, damage: any, timestamp: any) {
    const key = victim.toLowerCase();
    const existing = this._pvpDamageTracker.get(key);
    const ts = timestamp.getTime();

    if (existing && existing.attackerLower === attacker.toLowerCase()) {
      // Same attacker — accumulate damage
      existing.totalDamage += damage;
      existing.timestamp = ts;
      existing.attacker = attacker; // keep most recent casing
    } else {
      // New/different attacker — replace (last-hit attribution)
      this._pvpDamageTracker.set(key, {
        attacker,
        attackerLower: attacker.toLowerCase(),
        timestamp: ts,
        totalDamage: damage,
      });
    }
  }

  _checkPvpKill(victim: any, deathTimestamp: any) {
    const key = victim.toLowerCase();
    const entry = this._pvpDamageTracker.get(key);
    if (!entry) return null;

    const elapsed = deathTimestamp.getTime() - entry.timestamp;
    // Use configurable window (default 5 min). Since log timestamps are only
    // minute-precision (HH:MM), we need a generous window.
    if (elapsed <= this._config.pvpKillWindow && elapsed >= 0) {
      // Clean up after attribution
      this._pvpDamageTracker.delete(key);
      return { attacker: entry.attacker, totalDamage: entry.totalDamage };
    }

    // Expired — clean up
    if (elapsed > this._config.pvpKillWindow) {
      this._pvpDamageTracker.delete(key);
    }
    return null;
  }

  _isNpcDamageSource(source: any) {
    return isNpcDamageSource(source);
  }

  _prunePvpTracker() {
    const now = Date.now();
    for (const [key, entry] of this._pvpDamageTracker) {
      if (now - entry.timestamp > this._config.pvpKillWindow * 2) {
        this._pvpDamageTracker.delete(key);
      }
    }
    // Also prune death cause tracker
    for (const [key, entry] of this._deathCauseTracker) {
      if (now - entry.timestamp > this._config.pvpKillWindow * 2) {
        this._deathCauseTracker.delete(key);
      }
    }
  }

  /**
   * Record damage from ANY source for death cause attribution.
   * Last-hit attribution: the most recent damage source before death is the cause.
   */
  _recordDeathCauseDamage(victim: any, source: any, damage: any, timestamp: any) {
    const key = victim.toLowerCase();
    const ts = timestamp.getTime();
    const existing = this._deathCauseTracker.get(key);

    if (existing && existing.sourceRaw === source) {
      // Same source — accumulate
      existing.totalDamage += damage;
      existing.timestamp = ts;
    } else {
      // New/different source — replace (last-hit)
      this._deathCauseTracker.set(key, {
        sourceRaw: source,
        timestamp: ts,
        totalDamage: damage,
      });
    }
  }

  /**
   * Check death cause: look up the most recent damage source for a victim.
   * Returns classified cause or null.
   */
  _checkDeathCause(victim: any, deathTimestamp: any) {
    const key = victim.toLowerCase();
    const entry = this._deathCauseTracker.get(key);
    if (!entry) return null;

    const elapsed = deathTimestamp.getTime() - entry.timestamp;
    if (elapsed <= this._config.pvpKillWindow && elapsed >= 0) {
      this._deathCauseTracker.delete(key);
      const classified = this._classifyDamageSource(entry.sourceRaw);
      return {
        ...classified,
        raw: entry.sourceRaw,
        totalDamage: entry.totalDamage,
      };
    }

    if (elapsed > this._config.pvpKillWindow) {
      this._deathCauseTracker.delete(key);
    }
    return null;
  }

  getPvpKills(count: any = 10) {
    return this._pvpKills.slice(-count);
  }

  async start() {
    // Validate required SFTP config
    if (!this._config.sftpHost || this._config.sftpHost.startsWith('PASTE_')) {
      this._log.info('SFTP not configured, skipping log watcher.');
      return;
    }

    const channelId = this._config.logChannelId || this._config.adminChannelId;
    if (!channelId) {
      // No Discord channel — run in headless mode (DB writes only, no Discord posting).
      // This is used by multi-server instances that only serve the web panel.
      this._headless = true;
      this._log.info('No LOG_CHANNEL_ID — running in headless mode (DB-only, no Discord posting)');
    }

    if (!this._headless) {
      try {
        this.logChannel = await this.client.channels.fetch(channelId);
        if (!this.logChannel) {
          this._log.error('Log channel not found! Check LOG_CHANNEL_ID.');
          return;
        }
      } catch (err: any) {
        this._log.error('Failed to fetch log channel:', err.message);
        return;
      }
      this._log.info(
        `Posting events to ${this._config.useActivityThreads ? 'daily threads in' : ''} #${this.logChannel.name}`,
      );
    }

    this._log.info(`Connecting to ${this._config.sftpHost}:${this._config.sftpPort} for log watching...`);

    // First poll — detect HZLogs or legacy, get current file size
    await this._initSize();

    if (this._useRotatedLogs) {
      this._log.info('Using rotated logs (HZLogs/ per-restart files)');
    } else {
      this._log.info(`Using legacy monolithic logs: ${this._config.sftpLogPath}, ${this._config.sftpConnectLogPath}`);
    }

    // Initialise today's thread (skip during nuke — phase 2 rebuilds them)
    if (!this._nukeActive && !this._headless) {
      await this._getOrCreateDailyThread();
    }

    // Start polling
    this.interval = setInterval(() => this._poll(), this._config.logPollInterval);

    // Proactive midnight rollover check — ensures the daily summary posts
    // even if no log events happen around midnight in the configured timezone.
    if (!this._headless) {
      this._midnightCheckInterval = setInterval(() => this._checkDayRollover(), 60000);
    }

    // Send startup notification (skip during nuke and headless — would appear out of order)
    if (!this._nukeActive && !this._headless) {
      const thread = await this._getOrCreateDailyThread();
      const embed = new EmbedBuilder()
        .setDescription('Log watcher connected. Monitoring game server activity.')
        .setColor(0x3498db)
        .setTimestamp();
      await thread.send({ embeds: [embed] }).catch(() => {});
    }
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    if (this._midnightCheckInterval) {
      clearInterval(this._midnightCheckInterval);
      this._midnightCheckInterval = null;
    }
    if (this._lootTimer) {
      clearTimeout(this._lootTimer);
      this._lootTimer = null;
    }
    if (this._buildTimer) {
      clearTimeout(this._buildTimer);
      this._buildTimer = null;
    }
    if (this._raidTimer) {
      clearTimeout(this._raidTimer);
      this._raidTimer = null;
    }
    this._flushLootBatch();
    this._flushBuildBatch();
    this._flushRaidBatch();
    this._savePvpKills();
  }

  // ─── INTERNAL ─────────────────────────────────────────────

  _loadOffsets() {
    try {
      if (this._db) {
        const raw = this._db.getStateJSON('log_offsets', null);
        if (raw) {
          return {
            hmzLogSize: typeof raw.hmzLogSize === 'number' ? raw.hmzLogSize : 0,
            connectLogSize: typeof raw.connectLogSize === 'number' ? raw.connectLogSize : 0,
            hmzLogFile: raw.hmzLogFile || null,
            connectLogFile: raw.connectLogFile || null,
            useRotatedLogs: !!raw.useRotatedLogs,
          };
        }
      }
    } catch (err: any) {
      this._log.warn('Could not load saved offsets:', err.message);
    }
    return null;
  }

  _saveOffsets() {
    try {
      const data = {
        hmzLogSize: this.lastSize,
        connectLogSize: this._connectLastSize,
        useRotatedLogs: this._useRotatedLogs,
        hmzLogFile: this._hmzLogFile || null,
        connectLogFile: this._connectLogFile || null,
        savedAt: new Date().toISOString(),
      };
      if (this._db) {
        this._db.setStateJSON('log_offsets', data);
      }
    } catch (err: any) {
      this._log.warn('Could not save offsets:', err.message);
    }
  }

  /**
   * Find the latest (newest) file in a directory matching a suffix.
   * Game names files as {D}-{M}_{H}-{m}_{suffix}, e.g. "1-3_7-0_HMZLog.log".
   * We parse the timestamp from the filename to sort. Falls back to alphabetical.
   * @returns {string|null} Full remote path of the newest file, or null if none found.
   */
  async _findLatestFile(sftp: any, dir: any, suffix: any) {
    try {
      const items = await sftp.list(dir);
      const matching = items.filter((i: any) => i.type !== 'd' && i.name.endsWith(suffix));
      if (matching.length === 0) return null;

      // Parse timestamp from filename: D-M_H-m_suffix → sortable date
      const parsed = matching.map((i: any) => {
        const m = i.name.match(/^(\d{1,2})-(\d{1,2})_(\d{1,2})-(\d{1,2})_/);
        let sortKey = 0;
        if (m) {
          // Build sortable int: MMDDHHMM (zero-padded mentally, but int comparison works)
          sortKey =
            parseInt(m[2], 10) * 1000000 + parseInt(m[1], 10) * 10000 + parseInt(m[3], 10) * 100 + parseInt(m[4], 10);
        }
        return { name: i.name, sortKey, modifyTime: i.modifyTime };
      });

      // Sort by parsed timestamp descending; fall back to modifyTime
      parsed.sort((a: any, b: any) => {
        if (a.sortKey !== b.sortKey) return b.sortKey - a.sortKey;
        return (b.modifyTime || 0) - (a.modifyTime || 0);
      });

      return dir.replace(/\/+$/, '') + '/' + parsed[0].name;
    } catch {
      return null;
    }
  }

  /**
   * Detect and resolve the HZLogs rotated log directory.
   * Returns { hmzLogDir, chatLogDir, loginLogDir } or null if HZLogs doesn't exist.
   */
  _resolveLogDirs() {
    // Derive HZLogs path from the configured ftpLogPath.
    // Old path: .../HumanitZServer/Saved/Logs/HMZLog.log  →  HZLogs is at .../HumanitZServer/HZLogs
    // New path: .../HumanitZServer/HMZLog.log              →  HZLogs is at .../HumanitZServer/HZLogs
    // We need the HumanitZServer/ root, so we walk up from the log file path.
    const logPath = this._config.sftpLogPath || '/HumanitZServer/HMZLog.log';
    let serverRoot = logPath.substring(0, logPath.lastIndexOf('/')) || '/HumanitZServer';
    // If the log is under Saved/Logs/, walk up two levels to get to HumanitZServer/
    if (serverRoot.endsWith('/Saved/Logs') || serverRoot.endsWith('/Saved/Logs/')) {
      serverRoot = serverRoot.replace(/\/Saved\/Logs\/?$/, '');
    }
    return {
      hmzLogDir: serverRoot + '/HZLogs',
      chatLogDir: serverRoot + '/HZLogs/Chat',
      loginLogDir: serverRoot + '/HZLogs/Login',
    };
  }

  async _initSize() {
    const saved = this._loadOffsets();
    const sftp = new SftpClient();
    try {
      await sftp.connect(this._config.sftpConnectConfig());

      // ── Detect HZLogs rotated log directory (game update Feb 28 2026) ──
      const dirs = this._resolveLogDirs();
      let rotatedHmz = null;
      let rotatedConnect = null;
      try {
        await sftp.stat(dirs.hmzLogDir);
        rotatedHmz = await this._findLatestFile(sftp, dirs.hmzLogDir, '_HMZLog.log');
        rotatedConnect = await this._findLatestFile(sftp, dirs.loginLogDir, '_ConnectLog.txt');
      } catch {
        // HZLogs directory doesn't exist — old-style monolithic logs
      }

      if (rotatedHmz) {
        // ── Per-restart rotated logs mode ──
        this._useRotatedLogs = true;
        this._hmzLogFile = rotatedHmz;
        this._connectLogFile = rotatedConnect;
        this._log.info('Detected HZLogs directory — using per-restart log files');
        this._log.info(`  HMZLog: ${rotatedHmz}`);
        if (rotatedConnect) this._log.info(`  ConnectLog: ${rotatedConnect}`);

        // If saved offsets match the same file, resume; otherwise start fresh
        try {
          const stat = await sftp.stat(rotatedHmz);
          if (saved && saved.hmzLogFile === rotatedHmz && saved.hmzLogSize > 0 && saved.hmzLogSize <= stat.size) {
            this.lastSize = saved.hmzLogSize;
            this.initialised = true;
            this._log.info(
              `HMZLog: resuming from saved offset ${this.lastSize} (${stat.size - this.lastSize} bytes to catch up)`,
            );
          } else {
            this.lastSize = stat.size;
            this.initialised = true;
            this._log.info(`HMZLog: tailing from ${this.lastSize} bytes`);
          }
        } catch {
          this.lastSize = 0;
          this.initialised = false;
        }

        if (rotatedConnect) {
          try {
            const stat2 = await sftp.stat(rotatedConnect);
            if (
              saved &&
              saved.connectLogFile === rotatedConnect &&
              saved.connectLogSize > 0 &&
              saved.connectLogSize <= stat2.size
            ) {
              this._connectLastSize = saved.connectLogSize;
              this._connectInitialised = true;
              this._log.info(
                `ConnectLog: resuming from saved offset ${this._connectLastSize} (${stat2.size - this._connectLastSize} bytes to catch up)`,
              );
            } else {
              this._connectLastSize = stat2.size;
              this._connectInitialised = true;
              this._log.info(`ConnectLog: tailing from ${this._connectLastSize} bytes`);
            }
          } catch {
            this._connectLastSize = 0;
            this._connectInitialised = false;
          }
        }
      } else {
        // ── Legacy monolithic log mode ──
        try {
          const stat = await sftp.stat(this._config.sftpLogPath);
          if (saved && saved.hmzLogSize > 0 && saved.hmzLogSize <= stat.size) {
            this.lastSize = saved.hmzLogSize;
            this.initialised = true;
            const behind = stat.size - saved.hmzLogSize;
            this._log.info(`HMZLog: resuming from saved offset ${this.lastSize} (${behind} bytes to catch up)`);
          } else {
            this.lastSize = stat.size;
            this.initialised = true;
            this._log.info(`HMZLog size: ${this.lastSize} bytes — tailing from here`);
          }
        } catch (err: any) {
          this._log.warn('HMZLog.log not found, will retry:', err.message);
          this.lastSize = 0;
          this.initialised = false;
        }

        // PlayerConnectedLog.txt
        try {
          const stat2 = await sftp.stat(this._config.sftpConnectLogPath);
          if (saved && saved.connectLogSize > 0 && saved.connectLogSize <= stat2.size) {
            this._connectLastSize = saved.connectLogSize;
            this._connectInitialised = true;
            const behind = stat2.size - saved.connectLogSize;
            this._log.info(
              `ConnectLog: resuming from saved offset ${this._connectLastSize} (${behind} bytes to catch up)`,
            );
          } else {
            this._connectLastSize = stat2.size;
            this._connectInitialised = true;
            this._log.info(`ConnectLog size: ${this._connectLastSize} bytes — tailing from here`);
          }
        } catch (err: any) {
          this._log.warn('PlayerConnectedLog.txt not found, will retry:', err.message);
          this._connectLastSize = 0;
          this._connectInitialised = false;
        }
      }
    } catch (err: any) {
      this._log.error('SFTP init failed:', err.message);
      this.lastSize = 0;
      this.initialised = false;
      this._connectLastSize = 0;
      this._connectInitialised = false;
    } finally {
      await sftp.end().catch(() => {});
    }
  }

  /** Returns the display name for this server (from SERVER_NAME env or servers.json name). */
  _getServerLabel() {
    return this._config.serverName || '';
  }

  async _poll() {
    const sftp = new SftpClient();
    try {
      await sftp.connect(this._config.sftpConnectConfig());

      // ── Resolve current log file paths ──────────────
      let hmzPath, connectPath;
      if (this._useRotatedLogs) {
        const dirs = this._resolveLogDirs();

        // Check for new rotated file (server restart → new file appeared)
        const latestHmz = await this._findLatestFile(sftp, dirs.hmzLogDir, '_HMZLog.log');
        const latestConnect = await this._findLatestFile(sftp, dirs.loginLogDir, '_ConnectLog.txt');

        if (latestHmz && latestHmz !== this._hmzLogFile) {
          // Server restarted — new log file. Read remaining from old, then switch.
          if (this._hmzLogFile) {
            this._log.info(`HMZLog rotated: ${this._hmzLogFile} → ${latestHmz}`);
            // Flush remaining bytes from old file first
            await this._pollFile(sftp, {
              path: this._hmzLogFile,
              label: 'HMZLog(old)',
              getSize: () => this.lastSize,
              setSize: (s: any) => {
                this.lastSize = s;
              },
              getInit: () => this.initialised,
              setInit: (v: any) => {
                this.initialised = v;
              },
              getPartial: () => this.partialLine,
              setPartial: (p: any) => {
                this.partialLine = p;
              },
              processLine: (line: any) => this._processLine(line),
            });
          }
          this._hmzLogFile = latestHmz;
          this.lastSize = 0;
          this.partialLine = '';
          this.initialised = true; // Read from byte 0, don't skip
        }

        if (latestConnect && latestConnect !== this._connectLogFile) {
          if (this._connectLogFile) {
            this._log.info(`ConnectLog rotated: ${this._connectLogFile} → ${latestConnect}`);
            await this._pollFile(sftp, {
              path: this._connectLogFile,
              label: 'ConnectLog(old)',
              getSize: () => this._connectLastSize,
              setSize: (s: any) => {
                this._connectLastSize = s;
              },
              getInit: () => this._connectInitialised,
              setInit: (v: any) => {
                this._connectInitialised = v;
              },
              getPartial: () => this._connectPartialLine,
              setPartial: (p: any) => {
                this._connectPartialLine = p;
              },
              processLine: (line: any) => this._processConnectLine(line),
            });
          }
          this._connectLogFile = latestConnect;
          this._connectLastSize = 0;
          this._connectPartialLine = '';
          this._connectInitialised = true;
        }

        hmzPath = this._hmzLogFile;
        connectPath = this._connectLogFile;
      } else {
        hmzPath = this._config.sftpLogPath;
        connectPath = this._config.sftpConnectLogPath;
      }

      // ── HMZLog ──────────────────────────────────────
      if (hmzPath) {
        await this._pollFile(sftp, {
          path: hmzPath,
          label: 'HMZLog',
          getSize: () => this.lastSize,
          setSize: (s: any) => {
            this.lastSize = s;
          },
          getInit: () => this.initialised,
          setInit: (v: any) => {
            this.initialised = v;
          },
          getPartial: () => this.partialLine,
          setPartial: (p: any) => {
            this.partialLine = p;
          },
          processLine: (line: any) => this._processLine(line),
        });
      }

      // ── ConnectLog ──────────────────────────────────
      if (connectPath) {
        await this._pollFile(sftp, {
          path: connectPath,
          label: 'ConnectLog',
          getSize: () => this._connectLastSize,
          setSize: (s: any) => {
            this._connectLastSize = s;
          },
          getInit: () => this._connectInitialised,
          setInit: (v: any) => {
            this._connectInitialised = v;
          },
          getPartial: () => this._connectPartialLine,
          setPartial: (p: any) => {
            this._connectPartialLine = p;
          },
          processLine: (line: any) => this._processConnectLine(line),
        });
      }

      // ── PlayerIDMapped.txt (name→SteamID resolver) ─────
      await this._refreshIdMap(sftp);

      // Persist offsets so next restart catches up from here
      this._saveOffsets();

      // Prune stale PvP damage entries + persist kill log
      this._prunePvpTracker();
      this._savePvpKills();

      // Persist day counts
      this._saveDayCounts();
    } catch (err: any) {
      this._log.error('Poll error:', err.message);
    } finally {
      await sftp.end().catch(() => {});
    }
  }

  async _pollFile(sftp: any, opts: any) {
    try {
      const stat = await sftp.stat(opts.path);
      const currentSize = stat.size;
      const lastSize = opts.getSize();

      // File was truncated/rotated (server restart)
      if (currentSize < lastSize) {
        this._log.info(`${opts.label} rotated — resetting`);
        opts.setSize(0);
        opts.setPartial('');
      }

      if (currentSize === lastSize) return;

      // First poll — skip old data
      if (!opts.getInit()) {
        opts.setSize(currentSize);
        opts.setInit(true);
        this._log.info(`${opts.label} initialised at ${currentSize} bytes`);
        return;
      }

      const bytesNew = currentSize - opts.getSize();
      this._log.info(`${opts.label}: ${bytesNew} new bytes`);

      const newBytes = await this._downloadFrom(sftp, opts.path, opts.getSize(), currentSize);
      opts.setSize(currentSize);

      if (newBytes && (newBytes as string).length > 0) {
        const text = opts.getPartial() + newBytes;
        const lines = text.split('\n');
        opts.setPartial(lines.pop() || '');

        let totalLines = 0;
        let eventLines = 0;
        for (const line of lines) {
          const trimmed = line.replace(/^\uFEFF/, '').trim();
          if (!trimmed) continue;
          totalLines++;
          if (opts.processLine(trimmed)) eventLines++;
        }
        this._log.info(`${opts.label}: ${totalLines} lines (${eventLines} events)`);
      }
    } catch (err: any) {
      // File may not exist yet — that's OK
      if (err.code === 2 || err.message.includes('No such file')) {
        return; // silently skip missing files
      }
      this._log.warn(`${opts.label} poll error:`, err.message);
    }
  }

  async _downloadFrom(sftpClient: any, remotePath: any, startAt: any, endAt: any) {
    const bytesToRead = endAt - startAt;
    if (bytesToRead <= 0) return '';

    // Use the underlying sftp session to create a read stream with offset
    return new Promise((resolve, reject) => {
      const sftpSession = sftpClient.sftp;
      if (!sftpSession) {
        reject(new Error('No underlying SFTP session available'));
        return;
      }

      const readStream = sftpSession.createReadStream(remotePath, {
        start: startAt,
        end: endAt - 1,
        encoding: 'utf8',
      });

      const chunks: string[] = [];
      readStream.on('data', (chunk: any) => chunks.push(chunk));
      readStream.on('end', () => resolve(chunks.join('')));
      readStream.on('error', (err: any) => {
        this._log.warn('Stream read failed, trying full download:', err.message);
        // Fallback: download full file and slice
        sftpClient
          .get(remotePath)
          .then((buf: any) => resolve(buf.slice(startAt, endAt).toString('utf8')))
          .catch(reject);
      });
    });
  }

  _processLine(line: any) {
    // Extract timestamp and message body
    // Format: (13/2/2026 12:35) message here  — also handles :SS seconds, - . separators, and comma in year (2,026)
    const lineMatch = line.match(
      /^\((\d{1,2})[/\-.](\d{1,2})[/\-.](\d{1,2},?\d{3})\s+(\d{1,2}):(\d{1,2})(?::\d{1,2})?\)\s+(.+)$/,
    );
    if (!lineMatch) return false;

    const [, day, month, rawYear, hour, min, body] = lineMatch;
    const year = rawYear.replace(',', '');
    const timestamp = this._config.parseLogTimestamp(year, month, day, hour, min);

    // ── Player death ───────────────────────────────────────
    // Player died (PlayerName)
    const deathMatch = body.match(/^Player died \((.+)\)$/);
    if (deathMatch) {
      this._onDeath(deathMatch[1].trim(), timestamp);
      return true;
    }

    // ── Building completed ─────────────────────────────────
    // PlayerName(SteamID) finished building ItemName
    // [ClanTag] PlayerName(SteamID) finished building ItemName
    const buildMatch = body.match(/^(.+?)\((\d{17})[^)]*\)\s*finished building\s+(.+)$/);
    if (buildMatch) {
      this._onBuild(buildMatch[1].trim(), buildMatch[2], buildMatch[3].trim(), timestamp);
      return true;
    }

    // ── Player damage taken ────────────────────────────────
    // PlayerName took X damage from Source
    // Tracked for stats; not posted to Discord individually (too spammy)
    const dmgMatch = body.match(/^(.+?)\s+took\s+([\d.]+)\s+damage from\s+(.+)$/);
    if (dmgMatch) {
      const dmgVictim = dmgMatch[1].trim();
      const dmgAmount = parseFloat(dmgMatch[2]);
      const dmgSource = dmgMatch[3].trim();
      if (dmgAmount > 0) {
        this._playerStats.recordDamageTaken(dmgVictim, dmgSource, timestamp);
        this._incDayCount('damage');

        // DB: log damage event (classify source for clean display)
        const dmgClassified = this._classifyDamageSource(dmgSource);
        this._logEvent({
          type: 'damage_taken',
          category: 'combat',
          actorName: dmgVictim,
          item: dmgClassified.name,
          amount: Math.round(dmgAmount),
          timestamp,
        });

        // Track PvP damage for kill attribution.
        // NPC damage sources always start with BP_ (e.g. BP_Zombie_C_123) — already
        // excluded above.  The secondary regex is a safety net that catches any edge
        // cases where the game might log an NPC name without the BP_ prefix.  We use
        // start-of-string anchors (^) and underscores to avoid false positives on
        // player names that happen to contain words like "Human" or "Bear".
        if (this._config.enablePvpKillFeed && !dmgSource.startsWith('BP_') && !this._isNpcDamageSource(dmgSource)) {
          this._recordPvpDamage(dmgVictim, dmgSource, dmgAmount, timestamp);
        }

        // Track ALL damage for death cause attribution (PvE, PvP, everything)
        this._recordDeathCauseDamage(dmgVictim, dmgSource, dmgAmount, timestamp);
      }
      return true;
    }

    // ── Container looted ───────────────────────────────────
    // [ClanTag] PlayerName (SteamID) looted a container (Type) owner by OwnerSteamID
    const lootMatch = body.match(/^(.+?)\s*\((\d{17})[^)]*\)\s*looted a container\s*\(([^)]+)\)\s*owner by\s*(\d{17})/);
    if (lootMatch) {
      const looterName = lootMatch[1].trim();
      const looterId = lootMatch[2];
      const containerType = lootMatch[3];
      const ownerSteamId = lootMatch[4];
      const isClanAccess = looterId !== ownerSteamId && this._db?.areClanmates?.(looterId, ownerSteamId);
      this._playerStats.recordLoot(looterName, looterId, ownerSteamId, timestamp);
      this._incDayCount('loots');
      // Only batch for Discord if it's not a clanmate accessing shared containers
      if (!isClanAccess) {
        this._batchLoot(looterName, looterId, containerType, ownerSteamId, timestamp);
      }

      // DB: always log — tag clan access separately so the web panel can filter
      this._logEvent({
        type: isClanAccess ? 'clan_container_access' : 'container_loot',
        category: isClanAccess ? 'clan' : 'loot',
        actorName: looterName,
        steamId: looterId,
        item: this._simplifyContainerName(containerType),
        targetSteamId: ownerSteamId,
        timestamp,
      });

      // Track container access for attribution in activity log
      const cleanType = this._simplifyContainerName(containerType).toLowerCase();
      this._recentContainerAccess.set(cleanType, {
        player: looterName,
        steamId: looterId,
        ownerSteamId,
        rawType: containerType,
        timestamp: Date.now(),
      });
      // Expire old entries (older than 5 min)
      const cutoff = Date.now() - 5 * 60 * 1000;
      for (const [k, v] of this._recentContainerAccess) {
        if (v.timestamp < cutoff) this._recentContainerAccess.delete(k);
      }
      return true;
    }

    // ── Building damaged by player (raiding) ───────────────
    // Building (Type) owned by (OwnerSteamID) damaged (X) by AttackerName(SteamID)
    // Building (Type) owned by (OwnerSteamID) damaged (X) by AttackerName(SteamID) (Destroyed)
    // Skip: Decayfalse, Zeek (NPC), unowned buildings (empty owner)
    const raidMatch = body.match(
      /^Building \(([^)]+)\) owned by \((\d{17}[^)]*)\) damaged \([\d.]+\) by (.+?)(?:\((\d{17})[^)]*\))?(\s*\(Destroyed\))?$/,
    );
    if (raidMatch) {
      const buildingType = raidMatch[1];
      const ownerSteamId = raidMatch[2].match(/^(\d{17})/)?.[1];
      const attackerRaw = raidMatch[3].trim();
      const attackerSteamId = raidMatch[4];
      const destroyed = !!raidMatch[5];

      // Skip decay damage and NPC damage
      if (attackerRaw === 'Decayfalse' || attackerRaw === 'Zeek') return false;
      // Skip self-damage (player damaging their own building)
      if (attackerSteamId && ownerSteamId && attackerSteamId === ownerSteamId) return false;
      // Skip clanmates hitting clan buildings — not a raid, just building/upgrading.
      // Still logged to DB via _logEvent for the web panel.
      if (attackerSteamId && ownerSteamId && this._db?.areClanmates?.(attackerSteamId, ownerSteamId)) {
        this._logEvent({
          type: 'clan_building_damage',
          category: 'clan',
          actorName: attackerRaw,
          steamId: attackerSteamId,
          targetSteamId: ownerSteamId,
          item: this._simplifyBlueprintName(buildingType),
          amount: destroyed ? 1 : 0,
          details: { destroyed },
          timestamp,
        });
        return true;
      }

      this._onRaid(attackerRaw, attackerSteamId, ownerSteamId, buildingType, destroyed, timestamp);
      return true;
    }

    // ── Building damaged (unowned) ─────────────────────
    // Building (Type) owned by () damaged (X) by AttackerName(SteamID) (Destroyed)
    // Only post if destroyed by a player (not Zeek/Decay)
    const unownedMatch = body.match(
      /^Building \(([^)]+)\) owned by \(\) damaged \([\d.]+\) by (.+?)(?:\((\d{17})[^)]*\))?(\s*\(Destroyed\))?$/,
    );
    if (unownedMatch) {
      const buildingType = unownedMatch[1];
      const attackerRaw = unownedMatch[2].trim();
      const destroyed = !!unownedMatch[4];
      if (attackerRaw !== 'Zeek' && attackerRaw !== 'Decayfalse' && destroyed) {
        this._incDayCount('destroyed');
        const cleanBuilding = this._simplifyBlueprintName(buildingType);

        // DB: log building destroyed event
        this._logEvent({
          type: 'building_destroyed',
          category: 'raid',
          actorName: attackerRaw,
          item: cleanBuilding,
          timestamp,
        });

        const embed = new EmbedBuilder()
          .setAuthor({ name: '🏠 Building Destroyed' })
          .setDescription(`**${attackerRaw}** destroyed **${cleanBuilding}**`)
          .setColor(0x95a5a6)
          .setFooter({ text: timestamp ? this._formatTime(timestamp) : 'Just now' });
        this._sendToThread(embed);
      }
      return true;
    }

    // ── Admin access granted ───────────────────────────────
    // PlayerName gained admin access!
    const adminMatch = body.match(/^(.+?)\s+gained admin access!$/);
    if (adminMatch) {
      const playerName = adminMatch[1].trim();
      this._playerStats.recordAdminAccess(playerName, timestamp);
      this._incDayCount('admin');

      // DB: log admin access event
      this._logEvent({ type: 'admin_access', category: 'admin', actorName: playerName, timestamp });

      const embed = new EmbedBuilder()
        .setAuthor({ name: '🔑 Admin Access' })
        .setDescription(`**${playerName}** gained admin access`)
        .setColor(0x9b59b6)
        .setFooter({ text: this._formatTime(timestamp) });
      this._sendToThread(embed);
      return true;
    }

    // ── Anti-cheat flags ───────────────────────────────────
    // Item manipulation (with SteamID):
    //   Stack limit detected in drop function (PlayerName - SteamID)
    //   Odd behavior Drop amount Cheat (PlayerName - SteamID)
    const cheatMatch = body.match(
      /^(Stack limit detected in drop function|Odd behavior.*?Cheat)\s*\((.+?)\s*-\s*(\d{17})/,
    );
    if (cheatMatch) {
      const type = cheatMatch[1].trim();
      const playerName = cheatMatch[2].trim();
      const steamId = cheatMatch[3];
      this._playerStats.recordCheatFlag(playerName, steamId, type, timestamp);
      this._incDayCount('cheat');
      this._logEvent({
        type: 'anticheat_flag',
        category: 'admin',
        actorName: playerName,
        steamId,
        item: type,
        timestamp,
      });

      const embed = new EmbedBuilder()
        .setAuthor({ name: '🚨 Anti-Cheat Alert' })
        .setDescription(`**${playerName}**\n\`${type}\``)
        .setColor(0xe74c3c)
        .setFooter({ text: this._formatTime(timestamp) });
      this._sendToThread(embed);
      return true;
    }

    // Client drop mismatch (no SteamID in log):
    //   Client drop request count mismatch (Potential cheat) (PlayerName - amount X)
    const dropMismatch = body.match(/^Client drop request count mismatch\s*\([^)]*\)\s*\((.+?)\s*-\s*amount\s*(\d+)/i);
    if (dropMismatch) {
      const playerName = dropMismatch[1].trim();
      const amount = dropMismatch[2];
      const type = `Client drop mismatch (amount ${amount})`;
      this._incDayCount('cheat');
      this._logEvent({ type: 'anticheat_flag', category: 'admin', actorName: playerName, item: type, timestamp });

      const embed = new EmbedBuilder()
        .setAuthor({ name: '🚨 Anti-Cheat Alert' })
        .setDescription(`**${playerName}**\n\`${type}\``)
        .setColor(0xe74c3c)
        .setFooter({ text: this._formatTime(timestamp) });
      this._sendToThread(embed);
      return true;
    }

    // Speed hack detection:
    //   PlayerName suspected of speed hacking Warn => 2/3
    const speedWarnMatch = body.match(/^(.+?)\s+suspected of speed hacking\s+Warn\s*=>\s*(\d+)\/(\d+)/);
    if (speedWarnMatch) {
      const playerName = speedWarnMatch[1].trim();
      const current = speedWarnMatch[2];
      const max = speedWarnMatch[3];
      const type = `Speed hack warning ${current}/${max}`;
      this._incDayCount('cheat');
      this._logEvent({ type: 'anticheat_flag', category: 'admin', actorName: playerName, item: type, timestamp });

      const embed = new EmbedBuilder()
        .setAuthor({ name: '⚡ Speed Hack Warning' })
        .setDescription(`**${playerName}** — Warn ${current}/${max}`)
        .setColor(0xf39c12)
        .setFooter({ text: this._formatTime(timestamp) });
      this._sendToThread(embed);
      return true;
    }

    // Speed hack kick:
    //   PlayerName will be kicked for speed-hack strong suspicion ID = SteamID
    const speedKickMatch = body.match(/^(.+?)\s+will be kicked for speed-hack strong suspicion\s+ID\s*=\s*(\d{17})/);
    if (speedKickMatch) {
      const playerName = speedKickMatch[1].trim();
      const steamId = speedKickMatch[2];
      const type = 'Speed hack kick';
      this._playerStats.recordCheatFlag(playerName, steamId, type, timestamp);
      this._incDayCount('cheat');
      this._logEvent({
        type: 'anticheat_flag',
        category: 'admin',
        actorName: playerName,
        steamId,
        item: type,
        timestamp,
      });

      const embed = new EmbedBuilder()
        .setAuthor({ name: '🚫 Speed Hack Kick' })
        .setDescription(`**${playerName}** kicked for speed hacking`)
        .setColor(0xe74c3c)
        .setFooter({ text: this._formatTime(timestamp) });
      this._sendToThread(embed);
      return true;
    }

    // Admin abuse kicks:
    //   Kicked for executing unauthorised command
    //   Kicked for opening admin panel with no admin privilege...
    //   Kicked player for trying to send a system message when not admin...
    //   Kicked player for suspicious behavior
    const adminKickMatch = body.match(/^(Kicked (?:for|player for)\s+.+?)(?:\.\s*|$)/);
    if (adminKickMatch && /unauthoris|admin panel|system message|suspicious behavior/i.test(body)) {
      const type = adminKickMatch[1].trim();
      this._incDayCount('cheat');
      this._logEvent({ type: 'anticheat_flag', category: 'admin', item: type, timestamp });

      const embed = new EmbedBuilder()
        .setAuthor({ name: '🔒 Security Kick' })
        .setDescription(`\`${type}\``)
        .setColor(0xe74c3c)
        .setFooter({ text: this._formatTime(timestamp) });
      this._sendToThread(embed);
      return true;
    }

    // Bad spawn detection:
    //   Detected bad spawn location, adjusting to coast spawn...
    //   Bad spawn location, forcing default coast spawn location
    if (/^(?:Detected )?[Bb]ad spawn location/i.test(body)) {
      this._incDayCount('cheat');
      this._logEvent({ type: 'anticheat_flag', category: 'admin', item: 'Bad spawn location', timestamp });
      return true; // log silently — not worth an embed, it auto-corrects
    }

    return false;
  }

  _processConnectLine(line: any) {
    // Flexible: handles optional seconds, - . separators, and comma in year (2,026)
    const connectMatch = line.match(
      /^Player (Connected|Disconnected)\s+(.+?)\s+NetID\((\d{17})[^)]*\)\s*\((\d{1,2})[/\-.](\d{1,2})[/\-.](\d{1,2},?\d{3})\s+(\d{1,2}):(\d{1,2})(?::\d{1,2})?\)/,
    );
    if (!connectMatch) return false;

    const [, action, name, steamId, day, month, rawYear, hour, min] = connectMatch;
    const year = rawYear.replace(',', '');
    const timestamp = this._config.parseLogTimestamp(year, month, day, hour, min);

    if (action === 'Connected') {
      this._playerStats.recordConnect(name, steamId, timestamp);
      this._playtime.playerJoin(steamId, name, timestamp);
      this._incDayCount('connects');

      // DB: log connect event
      this._logEvent({ type: 'player_connect', category: 'session', actorName: name, steamId, timestamp });

      // Track online players for peak stats
      this._onlinePlayers.add(steamId);
      this._playtime.recordPlayerCount(this._onlinePlayers.size);
      this._playtime.recordUniqueToday(steamId);

      const embed = new EmbedBuilder()
        .setAuthor({ name: '📥 Player Connected' })
        .setDescription(`**${name}** joined the server`)
        .setColor(0x2ecc71)
        .setFooter({ text: this._formatTime(timestamp) });
      this._sendToThread(embed);
    } else {
      this._playerStats.recordDisconnect(name, steamId, timestamp);
      this._playtime.playerLeave(steamId, timestamp);
      this._incDayCount('disconnects');

      // DB: log disconnect event
      this._logEvent({ type: 'player_disconnect', category: 'session', actorName: name, steamId, timestamp });

      // Update online tracking
      this._onlinePlayers.delete(steamId);

      const embed = new EmbedBuilder()
        .setAuthor({ name: '📤 Player Disconnected' })
        .setDescription(`**${name}** left the server`)
        .setColor(0x95a5a6)
        .setFooter({ text: this._formatTime(timestamp) });
      this._sendToThread(embed);
    }

    return true;
  }

  // ─── DB EVENT LOGGING ─────────────────────────────────────

  /**
   * Log an event to the activity_log database table.
   * Silently no-ops if no DB is available.
   * @param {object} entry - { type, category, actorName, steamId, item, amount, details, targetName, targetSteamId, timestamp }
   */
  _logEvent(entry: any) {
    if (!this._db) return;
    try {
      if (entry.timestamp) {
        this._db.insertActivitiesAt([
          {
            type: entry.type,
            category: entry.category || '',
            actor: entry.steamId || entry.actorName || '',
            actorName: entry.actorName || '',
            steamId: entry.steamId || '',
            item: entry.item || '',
            amount: entry.amount || 0,
            details: entry.details || {},
            source: 'log',
            targetName: entry.targetName || '',
            targetSteamId: entry.targetSteamId || '',
            createdAt: entry.timestamp instanceof Date ? entry.timestamp.toISOString() : entry.timestamp,
          },
        ]);
      } else {
        this._db.insertActivity({
          type: entry.type,
          category: entry.category || '',
          actor: entry.steamId || entry.actorName || '',
          actorName: entry.actorName || '',
          steamId: entry.steamId || '',
          item: entry.item || '',
          amount: entry.amount || 0,
          details: entry.details || {},
          source: 'log',
          targetName: entry.targetName || '',
          targetSteamId: entry.targetSteamId || '',
        });
      }
    } catch (err: any) {
      // DB errors should never disrupt event processing
      this._log.warn(`Failed to log event ${entry.type}:`, err.message);
    }
  }

  // ─── ID MAP ───────────────────────────────────────────────

  async _refreshIdMap(sftp: any) {
    try {
      let text;
      // Prefer Panel API (Pterodactyl file download) when available
      if (this._panelApi && this._panelApi.available) {
        const buf = await this._panelApi.downloadFile(this._config.sftpIdMapPath);
        if (buf.length === this._idMapLastSize) return;
        this._idMapLastSize = buf.length;
        text = buf.toString('utf8');
      } else {
        // Stat first to skip full download if file hasn't changed
        const stat = await sftp.stat(this._config.sftpIdMapPath);
        if (stat.size === this._idMapLastSize) return;
        const buf = await sftp.get(this._config.sftpIdMapPath);
        this._idMapLastSize = stat.size;
        text = buf.toString('utf8');
      }
      const entries = [];
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        // Extract SteamID (before _+_|) and name (after @)
        const match = trimmed.match(/^(\d{17})_\+_\|[^@]+@(.+)$/);
        if (match) {
          entries.push({ steamId: match[1], name: match[2].trim() });
        }
      }
      if (entries.length > 0) {
        this._playerStats.loadIdMap(entries);

        // Cache locally so the web panel can resolve names without SFTP
        if (this._dataDir) {
          try {
            const logsDir = path.join(this._dataDir, 'logs');
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const fs = require('fs') as typeof import('fs');
            if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
            fs.writeFileSync(path.join(logsDir, 'PlayerIDMapped.txt'), text, 'utf8');
          } catch (_: any) {
            /* non-critical — web panel will fall back to DB names */
          }
        }

        // Notify external listeners (SaveService, WebMap, etc.) with steamId→name map
        if (this._onIdMapRefresh) {
          const idMap: Record<string, string> = {};
          for (const { steamId, name } of entries) idMap[steamId] = name;
          try {
            this._onIdMapRefresh(idMap);
          } catch (_: any) {}
        }
      }
    } catch (err: any) {
      // Not critical — file may not exist yet
      if (!this._idMapWarned) {
        this._log.warn('Could not read PlayerIDMapped.txt:', err.message);
        this._idMapWarned = true;
      }
    }
  }

  _simplifyContainerName(rawName: any) {
    return cleanName(rawName);
  }

  _simplifyBlueprintName(rawName: any) {
    return cleanName(rawName);
  }

  _formatTime(date: any) {
    return this._config.formatTime(date);
  }
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
Object.assign(LogWatcher.prototype, require('./log-watcher-threads'));
// eslint-disable-next-line @typescript-eslint/no-require-imports
Object.assign(LogWatcher.prototype, require('./log-watcher-events'));

export default LogWatcher;

const _mod = module as { exports: any };

_mod.exports = LogWatcher;
/* eslint-enable @typescript-eslint/no-unsafe-member-access */

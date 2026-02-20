const { EmbedBuilder } = require('discord.js');
const SftpClient = require('ssh2-sftp-client');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const playtime = require('./playtime-tracker');
const playerStats = require('./player-stats');

const OFFSETS_PATH = path.join(__dirname, '..', 'data', 'log-offsets.json');
const PVP_KILLS_PATH = path.join(__dirname, '..', 'data', 'pvp-kills.json');

/**
 * LogWatcher — connects to the game server via SFTP, polls HMZLog.log
 * and PlayerConnectedLog.txt for new entries, parses all events, records
 * stats, and posts them to a Discord channel.
 *
 * Uses SFTP partial download (read from offset) to only fetch new bytes.
 */
class LogWatcher {
  constructor(client) {
    this.client = client;
    this.logChannel = null;
    this.interval = null;

    // HMZLog.log state
    this.lastSize = 0;
    this.partialLine = '';
    this.initialised = false;

    // PlayerConnectedLog.txt state
    this._connectLastSize = 0;
    this._connectPartialLine = '';
    this._connectInitialised = false;

    // Daily thread
    this._dailyThread = null;
    this._dailyDate = null;   // 'YYYY-MM-DD'

    // Batching (reduces Discord spam)
    this._lootBatch = {};     // key → { looter, looterId, ownerSteamId, count, containers }
    this._lootTimer = null;
    this._buildBatch = {};    // steamId → { name, items: { item: count }, timestamp }
    this._buildTimer = null;
    this._raidBatch = {};     // attacker|owner → { attacker, owner, hits, destroyed, buildings, timestamp }
    this._raidTimer = null;

    // Daily counters for the summary
    this._dayCounts = { connects: 0, disconnects: 0, deaths: 0, builds: 0, damage: 0, loots: 0, raidHits: 0, destroyed: 0, admin: 0, cheat: 0, pvpKills: 0 };

    // Online player tracking (for peak stats)
    this._onlinePlayers = new Set();

    // PlayerIDMapped.txt warning flag
    this._idMapWarned = false;

    // PvP damage tracker: Map<victimNameLower, { attacker, attackerLower, timestamp, totalDamage }>
    // Used to correlate damage → death for PvP kill attribution
    this._pvpDamageTracker = new Map();

    // PvP kill log: last N kills for the "Last 10 Kills" display
    // Persisted to data/pvp-kills.json
    this._pvpKills = [];
    this._pvpKillsDirty = false;
    this._loadPvpKills();
  }

  // ── PvP Kill Tracking ──────────────────────────────────────

  /** Load persisted PvP kill history from disk */
  _loadPvpKills() {
    try {
      if (fs.existsSync(PVP_KILLS_PATH)) {
        const raw = JSON.parse(fs.readFileSync(PVP_KILLS_PATH, 'utf8'));
        if (Array.isArray(raw)) {
          this._pvpKills = raw;
          console.log(`[PVP KILLFEED] Loaded ${raw.length} PvP kill(s) from history`);
        }
      }
    } catch (err) {
      console.warn('[PVP KILLFEED] Could not load pvp-kills.json:', err.message);
      this._pvpKills = [];
    }
  }

  /** Save PvP kill history to disk */
  _savePvpKills() {
    if (!this._pvpKillsDirty) return;
    try {
      const dir = path.dirname(PVP_KILLS_PATH);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(PVP_KILLS_PATH, JSON.stringify(this._pvpKills, null, 2), 'utf8');
      this._pvpKillsDirty = false;
    } catch (err) {
      console.warn('[PVP KILLFEED] Could not save pvp-kills.json:', err.message);
    }
  }

  /**
   * Record PvP damage for kill attribution.
   * Updates or creates an entry tracking the most recent attacker for this victim.
   * @param {string} victim - victim player name
   * @param {string} attacker - attacker player name (raw from log)
   * @param {number} damage - damage amount
   * @param {Date} timestamp - log timestamp
   */
  _recordPvpDamage(victim, attacker, damage, timestamp) {
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

  /**
   * Check if a dying player was recently damaged by another player.
   * Returns the attacker info if within the kill attribution window, or null.
   * @param {string} victim - victim player name
   * @param {Date} deathTimestamp - death event timestamp
   * @returns {{ attacker: string, totalDamage: number }|null}
   */
  _checkPvpKill(victim, deathTimestamp) {
    const key = victim.toLowerCase();
    const entry = this._pvpDamageTracker.get(key);
    if (!entry) return null;

    const elapsed = deathTimestamp.getTime() - entry.timestamp;
    // Use configurable window (default 5 min). Since log timestamps are only
    // minute-precision (HH:MM), we need a generous window.
    if (elapsed <= config.pvpKillWindow && elapsed >= 0) {
      // Clean up after attribution
      this._pvpDamageTracker.delete(key);
      return { attacker: entry.attacker, totalDamage: entry.totalDamage };
    }

    // Expired — clean up
    if (elapsed > config.pvpKillWindow) {
      this._pvpDamageTracker.delete(key);
    }
    return null;
  }

  /**
   * Periodically prune stale entries from the PvP damage tracker.
   * Called during each poll cycle.
   */
  _prunePvpTracker() {
    const now = Date.now();
    for (const [key, entry] of this._pvpDamageTracker) {
      if (now - entry.timestamp > config.pvpKillWindow * 2) {
        this._pvpDamageTracker.delete(key);
      }
    }
  }

  /**
   * Get the last N PvP kills (for the stats embed).
   * @param {number} [count=10] - how many kills to return
   * @returns {Array<{ killer: string, victim: string, timestamp: string }>}
   */
  getPvpKills(count = 10) {
    return this._pvpKills.slice(-count);
  }

  /**
   * Start the log watcher.
   */
  async start() {
    // Validate required FTP config
    if (!config.ftpHost || config.ftpHost.startsWith('PASTE_')) {
      console.log('[LOG WATCHER] FTP not configured, skipping log watcher.');
      return;
    }

    const channelId = config.logChannelId || config.adminChannelId;
    if (!channelId) {
      console.log('[LOG WATCHER] No LOG_CHANNEL_ID or ADMIN_CHANNEL_ID configured, skipping log watcher.');
      return;
    }
    try {
      this.logChannel = await this.client.channels.fetch(channelId);
      if (!this.logChannel) {
        console.error('[LOG WATCHER] Log channel not found! Check LOG_CHANNEL_ID.');
        return;
      }
    } catch (err) {
      console.error('[LOG WATCHER] Failed to fetch log channel:', err.message);
      return;
    }

    console.log(`[LOG WATCHER] Watching ${config.ftpLogPath} on ${config.ftpHost}:${config.ftpPort}`);
    console.log(`[LOG WATCHER] Watching ${config.ftpConnectLogPath}`);
    console.log(`[LOG WATCHER] Posting events to #${this.logChannel.name}`);

    // First poll — just get current file size so we don't replay old history
    await this._initSize();

    // Initialise today's thread
    await this._getOrCreateDailyThread();

    // Start polling
    this.interval = setInterval(() => this._poll(), config.logPollInterval);

    // Proactive midnight rollover check — ensures the daily summary posts
    // even if no log events happen around midnight in the configured timezone.
    this._midnightCheckInterval = setInterval(() => this._checkDayRollover(), 60000);

    // Send startup notification
    const thread = await this._getOrCreateDailyThread();
    const embed = new EmbedBuilder()
      .setDescription('📋 Log watcher connected. Monitoring game server activity.')
      .setColor(0x3498db)
      .setTimestamp();
    await thread.send({ embeds: [embed] }).catch(() => {});
  }

  /**
   * Stop the log watcher.
   */
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

  /**
   * Load saved byte offsets from disk so we can catch up on events
   * that happened while the bot was offline.
   */
  _loadOffsets() {
    try {
      if (fs.existsSync(OFFSETS_PATH)) {
        const raw = JSON.parse(fs.readFileSync(OFFSETS_PATH, 'utf8'));
        return {
          hmzLogSize: typeof raw.hmzLogSize === 'number' ? raw.hmzLogSize : 0,
          connectLogSize: typeof raw.connectLogSize === 'number' ? raw.connectLogSize : 0,
        };
      }
    } catch (err) {
      console.warn('[LOG WATCHER] Could not load saved offsets:', err.message);
    }
    return null;
  }

  /**
   * Persist current byte offsets so a future restart can catch up.
   */
  _saveOffsets() {
    try {
      const dir = path.dirname(OFFSETS_PATH);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(OFFSETS_PATH, JSON.stringify({
        hmzLogSize: this.lastSize,
        connectLogSize: this._connectLastSize,
        savedAt: new Date().toISOString(),
      }, null, 2));
    } catch (err) {
      console.warn('[LOG WATCHER] Could not save offsets:', err.message);
    }
  }

  /**
   * Get initial file sizes. If we have saved offsets from the last run,
   * resume from there so we catch up on events that happened while offline.
   * Otherwise start from the current file size (no replay on first-ever run).
   */
  async _initSize() {
    const saved = this._loadOffsets();
    const sftp = new SftpClient();
    try {
      await sftp.connect({
        host: config.ftpHost,
        port: config.ftpPort,
        username: config.ftpUser,
        password: config.ftpPassword,
      });

      // HMZLog.log
      try {
        const stat = await sftp.stat(config.ftpLogPath);
        if (saved && saved.hmzLogSize > 0 && saved.hmzLogSize <= stat.size) {
          this.lastSize = saved.hmzLogSize;
          this.initialised = true;
          const behind = stat.size - saved.hmzLogSize;
          console.log(`[LOG WATCHER] HMZLog: resuming from saved offset ${this.lastSize} (${behind} bytes to catch up)`);
        } else {
          this.lastSize = stat.size;
          this.initialised = true;
          console.log(`[LOG WATCHER] HMZLog size: ${this.lastSize} bytes — tailing from here`);
        }
      } catch (err) {
        console.warn('[LOG WATCHER] HMZLog.log not found, will retry:', err.message);
        this.lastSize = 0;
        this.initialised = false;
      }

      // PlayerConnectedLog.txt
      try {
        const stat2 = await sftp.stat(config.ftpConnectLogPath);
        if (saved && saved.connectLogSize > 0 && saved.connectLogSize <= stat2.size) {
          this._connectLastSize = saved.connectLogSize;
          this._connectInitialised = true;
          const behind = stat2.size - saved.connectLogSize;
          console.log(`[LOG WATCHER] ConnectLog: resuming from saved offset ${this._connectLastSize} (${behind} bytes to catch up)`);
        } else {
          this._connectLastSize = stat2.size;
          this._connectInitialised = true;
          console.log(`[LOG WATCHER] ConnectLog size: ${this._connectLastSize} bytes — tailing from here`);
        }
      } catch (err) {
        console.warn('[LOG WATCHER] PlayerConnectedLog.txt not found, will retry:', err.message);
        this._connectLastSize = 0;
        this._connectInitialised = false;
      }
    } catch (err) {
      console.error('[LOG WATCHER] SFTP init failed:', err.message);
      this.lastSize = 0;
      this.initialised = false;
      this._connectLastSize = 0;
      this._connectInitialised = false;
    } finally {
      await sftp.end().catch(() => {});
    }
  }

  /**
   * Poll both log files for new bytes in a single SFTP connection.
   */
  async _poll() {
    const sftp = new SftpClient();
    try {
      await sftp.connect({
        host: config.ftpHost,
        port: config.ftpPort,
        username: config.ftpUser,
        password: config.ftpPassword,
      });

      // ── HMZLog.log ──────────────────────────────────
      await this._pollFile(sftp, {
        path: config.ftpLogPath,
        label: 'HMZLog',
        getSize: () => this.lastSize,
        setSize: (s) => { this.lastSize = s; },
        getInit: () => this.initialised,
        setInit: (v) => { this.initialised = v; },
        getPartial: () => this.partialLine,
        setPartial: (p) => { this.partialLine = p; },
        processLine: (line) => this._processLine(line),
      });

      // ── PlayerConnectedLog.txt ──────────────────────
      await this._pollFile(sftp, {
        path: config.ftpConnectLogPath,
        label: 'ConnectLog',
        getSize: () => this._connectLastSize,
        setSize: (s) => { this._connectLastSize = s; },
        getInit: () => this._connectInitialised,
        setInit: (v) => { this._connectInitialised = v; },
        getPartial: () => this._connectPartialLine,
        setPartial: (p) => { this._connectPartialLine = p; },
        processLine: (line) => this._processConnectLine(line),
      });

      // ── PlayerIDMapped.txt (name→SteamID resolver) ─────
      await this._refreshIdMap(sftp);

      // Persist offsets so next restart catches up from here
      this._saveOffsets();

      // Prune stale PvP damage entries + persist kill log
      this._prunePvpTracker();
      this._savePvpKills();

    } catch (err) {
      console.error('[LOG WATCHER] Poll error:', err.message);
    } finally {
      await sftp.end().catch(() => {});
    }
  }

  /**
   * Generic file poller — checks a single file for new bytes and processes them.
   */
  async _pollFile(sftp, opts) {
    try {
      const stat = await sftp.stat(opts.path);
      const currentSize = stat.size;
      const lastSize = opts.getSize();

      // File was truncated/rotated (server restart)
      if (currentSize < lastSize) {
        console.log(`[LOG WATCHER] ${opts.label} rotated — resetting`);
        opts.setSize(0);
        opts.setPartial('');
      }

      if (currentSize === lastSize) return;

      // First poll — skip old data
      if (!opts.getInit()) {
        opts.setSize(currentSize);
        opts.setInit(true);
        console.log(`[LOG WATCHER] ${opts.label} initialised at ${currentSize} bytes`);
        return;
      }

      const bytesNew = currentSize - opts.getSize();
      console.log(`[LOG WATCHER] ${opts.label}: ${bytesNew} new bytes`);

      const newBytes = await this._downloadFrom(sftp, opts.path, opts.getSize(), currentSize);
      opts.setSize(currentSize);

      if (newBytes && newBytes.length > 0) {
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
        console.log(`[LOG WATCHER] ${opts.label}: ${totalLines} lines (${eventLines} events)`);
      }
    } catch (err) {
      // File may not exist yet — that's OK
      if (err.code === 2 || err.message.includes('No such file')) {
        return; // silently skip missing files
      }
      console.warn(`[LOG WATCHER] ${opts.label} poll error:`, err.message);
    }
  }

  // ─── DAILY THREADS ────────────────────────────────────────

  /**
   * Proactive midnight rollover — called every 60s to ensure the daily summary
   * posts promptly at midnight (BOT_TIMEZONE) even if no log events arrive.
   */
  async _checkDayRollover() {
    if (!this._dailyDate) return; // not initialised yet
    const today = config.getToday();
    if (this._dailyDate !== today) {
      console.log(`[LOG WATCHER] Day rollover detected: ${this._dailyDate} → ${today}`);
      await this._getOrCreateDailyThread(); // triggers summary + new thread
    }
  }

  /**
   * Get or create today's activity thread. If the day has rolled over,
   * post a summary of the previous day to the main channel first.
   */
  async _getOrCreateDailyThread() {
    const today = config.getToday(); // timezone-aware 'YYYY-MM-DD'

    // Already have today's thread
    if (this._dailyThread && this._dailyDate === today) {
      return this._dailyThread;
    }

    // Day rollover — summarise the old day
    if (this._dailyDate && this._dailyDate !== today) {
      await this._postDailySummary();
      // Reset counters
      this._dayCounts = { connects: 0, disconnects: 0, deaths: 0, builds: 0, damage: 0, loots: 0, raidHits: 0, destroyed: 0, admin: 0, cheat: 0, pvpKills: 0 };
    }

    // Look for an existing thread for today
    const dateLabel = config.getDateLabel();
    const threadName = `📋 Activity Log — ${dateLabel}`;

    try {
      // Check active threads
      const active = await this.logChannel.threads.fetchActive();
      const existing = active.threads.find(t => t.name === threadName);
      if (existing) {
        this._dailyThread = existing;
        this._dailyDate = today;
        console.log(`[LOG WATCHER] Using existing thread: ${threadName}`);
        return this._dailyThread;
      }

      // Check archived threads (in case bot restarted mid-day)
      const archived = await this.logChannel.threads.fetchArchived({ limit: 5 });
      const archivedMatch = archived.threads.find(t => t.name === threadName);
      if (archivedMatch) {
        // Unarchive it
        await archivedMatch.setArchived(false);
        this._dailyThread = archivedMatch;
        this._dailyDate = today;
        console.log(`[LOG WATCHER] Unarchived existing thread: ${threadName}`);
        return this._dailyThread;
      }
    } catch (err) {
      console.warn('[LOG WATCHER] Could not search for threads:', err.message);
    }

    // Create a new thread (from a starter message so it appears inline in the channel)
    try {
      const starterMsg = await this.logChannel.send({
        embeds: [
          new EmbedBuilder()
            .setTitle(`📋 Activity Log — ${dateLabel}`)
            .setDescription('All server events for today are logged in this thread.')
            .setColor(0x3498db)
            .setTimestamp(),
        ],
      });
      this._dailyThread = await starterMsg.startThread({
        name: threadName,
        autoArchiveDuration: 1440, // keep alive 24h
        reason: 'Daily activity log thread',
      });
      this._dailyDate = today;
      console.log(`[LOG WATCHER] Created daily thread: ${threadName}`);
    } catch (err) {
      console.error('[LOG WATCHER] Failed to create daily thread:', err.message);
      // Fallback — use the main channel directly
      this._dailyThread = this.logChannel;
      this._dailyDate = today;
    }

    return this._dailyThread;
  }

  /**
   * Post a summary of the day's activity to the main log channel.
   */
  async _postDailySummary() {
    const c = this._dayCounts;
    const total = c.connects + c.deaths + c.builds + c.loots + c.raidHits + c.cheat + c.admin;
    if (total === 0) return; // nothing happened

    const dateLabel = this._dailyDate
      ? config.getDateLabel(new Date(this._dailyDate + 'T12:00:00Z'))
      : 'Unknown';

    const lines = [];
    if (c.connects > 0)    lines.push(`📥  **Connections:** ${c.connects}`);
    if (c.disconnects > 0)  lines.push(`📤  **Disconnections:** ${c.disconnects}`);
    if (c.deaths > 0)       lines.push(`💀  **Deaths:** ${c.deaths}`);
    if (c.builds > 0)       lines.push(`🔨  **Items Built:** ${c.builds}`);
    if (c.damage > 0)       lines.push(`🩸  **Damage Hits:** ${c.damage}`);
    if (c.loots > 0)        lines.push(`📦  **Containers Looted:** ${c.loots}`);
    if (c.raidHits > 0)     lines.push(`⚠️  **Raid Hits:** ${c.raidHits}`);
    if (c.destroyed > 0)    lines.push(`💥  **Structures Destroyed:** ${c.destroyed}`);
    if (c.admin > 0)        lines.push(`🔑  **Admin Access:** ${c.admin}`);
    if (c.cheat > 0)        lines.push(`🚨  **Anti-Cheat Flags:** ${c.cheat}`);
    if (c.pvpKills > 0)     lines.push(`⚔️  **PvP Kills:** ${c.pvpKills}`);

    const embed = new EmbedBuilder()
      .setTitle(`📊 Daily Summary — ${dateLabel}`)
      .setDescription(lines.join('\n'))
      .setColor(0x3498db)
      .setFooter({ text: `${total} total events` })
      .setTimestamp();

    try {
      await this.logChannel.send({ embeds: [embed] });
    } catch (err) {
      console.error('[LOG WATCHER] Failed to post daily summary:', err.message);
    }
  }

  /**
   * Public API: send an embed to today's daily thread.
   * Used by external modules (player-stats-channel, pvp-scheduler).
   */
  sendToThread(embed) {
    return this._sendToThread(embed);
  }

  /**
   * Helper: send an embed to today's daily thread.
   */
  async _sendToThread(embed) {
    const thread = await this._getOrCreateDailyThread();
    return thread.send({ embeds: [embed] }).catch(err => {
      console.error('[LOG WATCHER] Failed to send to thread:', err.message);
    });
  }

  /**
   * Download file contents starting from a byte offset using SFTP.
   * Uses a read stream with start/end for efficient partial reads.
   */
  async _downloadFrom(sftpClient, remotePath, startAt, endAt) {
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

      const chunks = [];
      readStream.on('data', chunk => chunks.push(chunk));
      readStream.on('end', () => resolve(chunks.join('')));
      readStream.on('error', err => {
        console.warn('[LOG WATCHER] Stream read failed, trying full download:', err.message);
        // Fallback: download full file and slice
        sftpClient.get(remotePath)
          .then(buf => resolve(buf.slice(startAt, endAt).toString('utf8')))
          .catch(reject);
      });
    });
  }

  /**
   * Parse a single HMZLog.log line and dispatch to the appropriate handler.
   * Format: (DD/MM/YYYY HH:MM) EventMessage
   * Returns true if the line was a recognised event.
   */
  _processLine(line) {
    // Extract timestamp and message body
    // Format: (13/2/2026 12:35) message here  — also handles :SS seconds, - . separators, and comma in year (2,026)
    const lineMatch = line.match(/^\((\d{1,2})[/\-.](\d{1,2})[/\-.](\d{1,2},?\d{3})\s+(\d{1,2}):(\d{1,2})(?::\d{1,2})?\)\s+(.+)$/);
    if (!lineMatch) return false;

    const [, day, month, rawYear, hour, min, body] = lineMatch;
    const year = rawYear.replace(',', '');
    const timestamp = new Date(`${year}-${month.padStart(2,'0')}-${day.padStart(2,'0')}T${hour.padStart(2,'0')}:${min.padStart(2,'0')}:00Z`);

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
        playerStats.recordDamageTaken(dmgVictim, dmgSource, timestamp);
        this._dayCounts.damage++;

        // Track PvP damage for kill attribution (source is a player name if no BP_ prefix)
        if (config.enablePvpKillFeed && !dmgSource.startsWith('BP_') && !(/Zombie|Wolf|Bear|Deer|Snake|Spider|Human|KaiHuman|Mutant|Runner|Brute|Pudge|Dogzombie|Police|Cop|Military|Hazmat|Camo/i.test(dmgSource))) {
          this._recordPvpDamage(dmgVictim, dmgSource, dmgAmount, timestamp);
        }
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
      playerStats.recordLoot(looterName, looterId, ownerSteamId, timestamp);
      this._dayCounts.loots++;
      this._batchLoot(looterName, looterId, containerType, ownerSteamId, timestamp);
      return true;
    }

    // ── Building damaged by player (raiding) ───────────────
    // Building (Type) owned by (OwnerSteamID) damaged (X) by AttackerName(SteamID)
    // Building (Type) owned by (OwnerSteamID) damaged (X) by AttackerName(SteamID) (Destroyed)
    // Skip: Decayfalse, Zeek (NPC), unowned buildings (empty owner)
    const raidMatch = body.match(
      /^Building \(([^)]+)\) owned by \((\d{17}[^)]*)\) damaged \([\d.]+\) by (.+?)(?:\((\d{17})[^)]*\))?(\s*\(Destroyed\))?$/
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

      this._onRaid(attackerRaw, attackerSteamId, ownerSteamId, buildingType, destroyed, timestamp);
      return true;
    }

    // ── Building damaged (unowned) ─────────────────────
    // Building (Type) owned by () damaged (X) by AttackerName(SteamID) (Destroyed)
    // Only post if destroyed by a player (not Zeek/Decay)
    const unownedMatch = body.match(
      /^Building \(([^)]+)\) owned by \(\) damaged \([\d.]+\) by (.+?)(?:\((\d{17})[^)]*\))?(\s*\(Destroyed\))?$/
    );
    if (unownedMatch) {
      const buildingType = unownedMatch[1];
      const attackerRaw = unownedMatch[2].trim();
      const destroyed = !!unownedMatch[4];
      if (attackerRaw !== 'Zeek' && attackerRaw !== 'Decayfalse' && destroyed) {
        this._dayCounts.destroyed++;
        const cleanBuilding = this._simplifyBlueprintName(buildingType);
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
      playerStats.recordAdminAccess(playerName, timestamp);
      this._dayCounts.admin++;

      const embed = new EmbedBuilder()
        .setAuthor({ name: '🔑 Admin Access' })
        .setDescription(`**${playerName}** gained admin access`)
        .setColor(0x9b59b6)
        .setFooter({ text: this._formatTime(timestamp) });
      this._sendToThread(embed);
      return true;
    }

    // ── Anti-cheat flags ───────────────────────────────────
    // Stack limit detected in drop function (PlayerName - SteamID)
    // Odd behavior Drop amount Cheat (PlayerName - SteamID)
    const cheatMatch = body.match(/^(Stack limit detected in drop function|Odd behavior.*?Cheat)\s*\((.+?)\s*-\s*(\d{17})/);
    if (cheatMatch) {
      const type = cheatMatch[1].trim();
      const playerName = cheatMatch[2].trim();
      const steamId = cheatMatch[3];
      playerStats.recordCheatFlag(playerName, steamId, type, timestamp);
      this._dayCounts.cheat++;

      const embed = new EmbedBuilder()
        .setAuthor({ name: '🚨 Anti-Cheat Alert' })
        .setDescription(`**${playerName}**\n\`${type}\``)
        .setColor(0xe74c3c)
        .setFooter({ text: this._formatTime(timestamp) });
      this._sendToThread(embed);
      return true;
    }

    return false;
  }

  /**
   * Parse a single PlayerConnectedLog.txt line.
   * Format: Player Connected Name NetID(SteamID_+_...) (DD/MM/YYYY HH:MM)
   *         Player Disconnected Name NetID(SteamID_+_...) (DD/MM/YYYY HH:MM)
   */
  _processConnectLine(line) {
    // Flexible: handles optional seconds, - . separators, and comma in year (2,026)
    const connectMatch = line.match(
      /^Player (Connected|Disconnected)\s+(.+?)\s+NetID\((\d{17})[^)]*\)\s*\((\d{1,2})[/\-.](\d{1,2})[/\-.](\d{1,2},?\d{3})\s+(\d{1,2}):(\d{1,2})(?::\d{1,2})?\)/
    );
    if (!connectMatch) return false;

    const [, action, name, steamId, day, month, rawYear, hour, min] = connectMatch;
    const year = rawYear.replace(',', '');
    const timestamp = new Date(
      `${year}-${month.padStart(2,'0')}-${day.padStart(2,'0')}T${hour.padStart(2,'0')}:${min.padStart(2,'0')}:00Z`
    );

    if (action === 'Connected') {
      playerStats.recordConnect(name, steamId, timestamp);
      playtime.playerJoin(steamId, name, timestamp);
      this._dayCounts.connects++;

      // Track online players for peak stats
      this._onlinePlayers.add(steamId);
      playtime.recordPlayerCount(this._onlinePlayers.size);
      playtime.recordUniqueToday(steamId);

      const embed = new EmbedBuilder()
        .setAuthor({ name: '📥 Player Connected' })
        .setDescription(`**${name}** joined the server`)
        .setColor(0x2ecc71)
        .setFooter({ text: this._formatTime(timestamp) });
      this._sendToThread(embed);
    } else {
      playerStats.recordDisconnect(name, steamId, timestamp);
      playtime.playerLeave(steamId, timestamp);
      this._dayCounts.disconnects++;

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

  // ─── EVENT HANDLERS ───────────────────────────────────────

  /**
   * Player finished building something.
   */
  _onBuild(playerName, steamId, itemName, timestamp) {
    // Clean up item name — remove BP_ prefix and trailing IDs
    const cleanItem = this._simplifyBlueprintName(itemName);

    // Record stats
    playerStats.recordBuild(playerName, steamId, cleanItem, timestamp);
    this._dayCounts.builds++;

    // Batch builds to reduce spam
    if (!this._buildBatch[steamId]) {
      this._buildBatch[steamId] = {
        playerName,
        items: {},
        timestamp,
      };
    }
    this._buildBatch[steamId].items[cleanItem] = (this._buildBatch[steamId].items[cleanItem] || 0) + 1;

    if (!this._buildTimer) {
      this._buildTimer = setTimeout(() => {
        this._flushBuildBatch();
        this._buildTimer = null;
      }, 60000);
    }
  }

  /**
   * Player died.
   */
  _onDeath(playerName, timestamp) {
    // Record stats
    playerStats.recordDeath(playerName, timestamp);
    this._dayCounts.deaths++;

    // Check for PvP kill attribution
    const pvpKill = config.enablePvpKillFeed ? this._checkPvpKill(playerName, timestamp) : null;

    if (pvpKill) {
      // PvP kill confirmed — post killfeed embed
      this._dayCounts.pvpKills++;

      // Record to persistent kill log
      const killEntry = {
        killer: pvpKill.attacker,
        victim: playerName,
        damage: pvpKill.totalDamage,
        timestamp: timestamp.toISOString(),
      };
      this._pvpKills.push(killEntry);
      // Keep last 50 kills in memory (display only shows 10)
      if (this._pvpKills.length > 50) this._pvpKills = this._pvpKills.slice(-50);
      this._pvpKillsDirty = true;

      // Record PvP kill/death stats
      playerStats.recordPvpKill(pvpKill.attacker, playerName, timestamp);

      // Post PvP kill to activity thread
      const killEmbed = new EmbedBuilder()
        .setAuthor({ name: '⚔️ PvP Kill' })
        .setDescription(`**${pvpKill.attacker}** killed **${playerName}**`)
        .setColor(0xe74c3c)
        .setFooter({ text: `${pvpKill.totalDamage.toFixed(0)} damage dealt · ${this._formatTime(timestamp)}` });
      this._sendToThread(killEmbed);

      // Also post the death notification (with kill context)
      const deathEmbed = new EmbedBuilder()
        .setAuthor({ name: '💀 Player Death' })
        .setDescription(`**${playerName}** was killed by **${pvpKill.attacker}**`)
        .setColor(0x992d22)
        .setFooter({ text: timestamp ? this._formatTime(timestamp) : 'Just now' });
      this._sendToThread(deathEmbed);
    } else {
      // Normal death (PvE/environment/unknown cause)
      const embed = new EmbedBuilder()
        .setAuthor({ name: '💀 Player Death' })
        .setDescription(`**${playerName}** died`)
        .setColor(0x992d22)
        .setFooter({ text: timestamp ? this._formatTime(timestamp) : 'Just now' });
      this._sendToThread(embed);
    }
  }

  /**
   * Player raided another player's building (structure damage by another player).
   */
  _onRaid(attackerName, attackerSteamId, ownerSteamId, buildingType, destroyed, timestamp) {
    // Clean up attacker name
    const attacker = attackerName.replace(/\s*$/, '');
    const cleanBuilding = this._simplifyBlueprintName(buildingType);

    // Record stats
    playerStats.recordRaid(attacker, attackerSteamId, ownerSteamId, destroyed, timestamp);
    this._dayCounts.raidHits++;

    // Batch raid events to reduce spam — group by attacker|owner pair
    const key = `${attackerSteamId}|${ownerSteamId}`;
    if (!this._raidBatch[key]) {
      this._raidBatch[key] = {
        attacker,
        attackerSteamId,
        ownerSteamId,
        buildings: {},
        destroyedCount: 0,
        damagedCount: 0,
        timestamp,
      };
    }
    const batch = this._raidBatch[key];
    batch.buildings[cleanBuilding] = (batch.buildings[cleanBuilding] || 0) + 1;
    if (destroyed) batch.destroyedCount++;
    else batch.damagedCount++;

    if (!this._raidTimer) {
      this._raidTimer = setTimeout(() => {
        this._flushRaidBatch();
        this._raidTimer = null;
      }, 60000);
    }
  }

  // ─── ID MAP ───────────────────────────────────────────────

  /**
   * Read PlayerIDMapped.txt and feed the name→SteamID map to player-stats.
   * Format: 76561198000000000_+_|<guid>@PlayerName
   */
  async _refreshIdMap(sftp) {
    try {
      const buf = await sftp.get(config.ftpIdMapPath);
      const text = buf.toString('utf8');
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
        playerStats.loadIdMap(entries);
      }
    } catch (err) {
      // Not critical — file may not exist yet
      if (!this._idMapWarned) {
        console.warn('[LOG WATCHER] Could not read PlayerIDMapped.txt:', err.message);
        this._idMapWarned = true;
      }
    }
  }

  // ─── HELPERS ──────────────────────────────────────────────

  /**
   * Batch loot events to reduce spam — groups by looter|owner pair.
   * Flushes after 60 seconds of accumulation.
   */
  _batchLoot(playerName, steamId, containerType, ownerSteamId, timestamp) {
    // Don't report self-looting
    if (steamId === ownerSteamId) return;

    const key = `${steamId}|${ownerSteamId}`;
    if (!this._lootBatch[key]) {
      this._lootBatch[key] = {
        looter: playerName,
        looterId: steamId,
        ownerSteamId,
        count: 0,
        containers: new Set(),
        timestamp,
      };
    }
    this._lootBatch[key].count++;
    this._lootBatch[key].containers.add(this._simplifyContainerName(containerType));

    if (!this._lootTimer) {
      this._lootTimer = setTimeout(() => {
        this._flushLootBatch();
        this._lootTimer = null;
      }, 60000);
    }
  }

  /**
   * Flush accumulated loot batch to Discord.
   */
  _flushLootBatch() {
    const entries = Object.values(this._lootBatch);
    if (entries.length === 0) return;
    this._lootBatch = {};

    const lines = entries.map(entry => {
      const ownerData = playtime.getPlaytime(entry.ownerSteamId);
      const ownerName = ownerData ? ownerData.name : `Unknown (${entry.ownerSteamId.slice(0, 8)}...)`;
      const containerList = [...entry.containers].join(', ');
      return `**${entry.looter}** opened **${entry.count}** container(s) owned by **${ownerName}**\n> ${containerList}`;
    });

    const embed = new EmbedBuilder()
      .setAuthor({ name: '📦 Container Activity' })
      .setDescription(lines.join('\n\n'))
      .setColor(0xe67e22)
      .setTimestamp();

    this._sendToThread(embed);
  }

  /**
   * Flush accumulated build batch to Discord.
   */
  _flushBuildBatch() {
    const entries = Object.values(this._buildBatch);
    if (entries.length === 0) return;
    this._buildBatch = {};

    const lines = entries.map(entry => {
      const itemList = Object.entries(entry.items)
        .map(([item, count]) => count > 1 ? `${item} ×${count}` : item)
        .join(', ');
      return `**${entry.playerName}** built ${itemList}`;
    });

    const embed = new EmbedBuilder()
      .setAuthor({ name: '🔨 Build Activity' })
      .setDescription(lines.join('\n'))
      .setColor(0xf39c12)
      .setTimestamp();

    this._sendToThread(embed);
  }

  /**
   * Flush accumulated raid batch to Discord.
   */
  _flushRaidBatch() {
    const entries = Object.values(this._raidBatch);
    if (entries.length === 0) return;
    this._raidBatch = {};

    const lines = entries.map(entry => {
      const ownerData = playtime.getPlaytime(entry.ownerSteamId);
      const ownerName = ownerData ? ownerData.name : `Unknown (${entry.ownerSteamId.slice(0, 8)}...)`;
      const buildingList = Object.entries(entry.buildings)
        .map(([b, count]) => count > 1 ? `${b} ×${count}` : b)
        .join(', ');
      const summary = [];
      if (entry.destroyedCount > 0) summary.push(`**${entry.destroyedCount}** destroyed`);
      if (entry.damagedCount > 0) summary.push(`**${entry.damagedCount}** damaged`);
      return `**${entry.attacker}** raided **${ownerName}** — ${summary.join(', ')}\n> ${buildingList}`;
    });

    const hasDestruction = entries.some(e => e.destroyedCount > 0);
    const embed = new EmbedBuilder()
      .setAuthor({ name: hasDestruction ? '💥 Raid Alert' : '⚠️ Raid Activity' })
      .setDescription(lines.join('\n\n'))
      .setColor(hasDestruction ? 0xe74c3c : 0xe67e22)
      .setTimestamp();

    this._sendToThread(embed);
  }

  /**
   * Simplify container class names.
   */
  _simplifyContainerName(rawName) {
    if (rawName.includes('VehicleStorage')) return 'Vehicle Storage';
    if (rawName.includes('CupboardContainer')) return 'Cupboard';
    if (rawName.includes('StorageContainer')) return 'Storage Container';
    if (rawName.includes('Fridge')) return 'Fridge';
    if (rawName.includes('Barrel')) return 'Barrel';
    return rawName.replace(/^(ChildActor_GEN_VARIABLE_|Storage_GEN_VARIABLE_)?BP_/, '').replace(/_C_\w+$/, '').replace(/_C_CAT_\w+$/, '').replace(/_/g, ' ').trim();
  }

  /**
   * Simplify UE blueprint class names into human‐readable names.
   * BP_GlassWindow_C_2147481025 → Glass Window
   * BP_Campfire_C_123 → Campfire
   * BP_StorageContainer_A_C_2147481025 → Storage Container
   */
  _simplifyBlueprintName(rawName) {
    return rawName
      .replace(/^BP_/, '')
      .replace(/_C_\d+.*$/, '')
      .replace(/_C$/, '')
      .replace(/_/g, ' ')
      .trim();
  }

  /**
   * Format a Date into a short readable time string.
   */
  _formatTime(date) {
    return config.formatTime(date);
  }
}

module.exports = LogWatcher;

const { EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder } = require('discord.js');
const SftpClient = require('ssh2-sftp-client');
const fs = require('fs');
const path = require('path');
const _defaultConfig = require('./config');
const _defaultPlaytime = require('./playtime-tracker');
const _defaultPlayerStats = require('./player-stats');
const playerMap = require('./player-map');
const { parseSave, parseClanData, PERK_MAP, PERK_INDEX_MAP } = require('./save-parser');
const { buildWelcomeContent } = require('./auto-messages');
const gameData = require('./game-data');
const os = require('os');

const _DEFAULT_DATA_DIR = path.join(__dirname, '..', 'data');

class PlayerStatsChannel {
  constructor(client, logWatcher, deps = {}) {
    this._config = deps.config || _defaultConfig;
    this._playtime = deps.playtime || _defaultPlaytime;
    this._playerStats = deps.playerStats || _defaultPlayerStats;
    this._label = deps.label || 'PLAYER STATS CH';
    this._dataDir = deps.dataDir || _DEFAULT_DATA_DIR;
    this._serverId = deps.serverId || '';  // unique suffix for select menu IDs

    this.client = client;
    this._logWatcher = logWatcher || null; // for posting kill feed to activity thread
    this.channel = null;
    this.statusMessage = null; // the single embed we keep editing
    this.saveInterval = null;
    this._saveData = new Map(); // steamId -> save data
    this._clanData = [];           // array of { name, members: [{ name, steamId, rank }] }
    this._lastSaveUpdate = null;
    this._embedInterval = null;
    // Kill tracker: { players: { steamId: { cumulative: {...}, lastSnapshot: {...} } } }
    this._killData = { players: {} };
    this._killDirty = false;
    this._serverSettings = {};  // parsed GameServerSettings.ini
    this._weeklyStats = null;   // cached weekly delta leaderboards
  }

  // ── Cross-validated player resolver ─────────────────────────

  _resolvePlayer(steamId) {
    const pt  = this._playtime.getPlaytime(steamId);
    const log = this._playerStats.getStats(steamId);
    const save = this._saveData.get(steamId);

    // ── Name resolution: most-recent-event wins ──
    let name = steamId;
    const ptName  = pt?.name;
    const logName = log?.name;

    if (ptName && logName) {
      if (ptName !== logName) {
        // Compare timestamps — whichever source was updated more recently wins
        const ptTime  = pt.lastSeen  ? new Date(pt.lastSeen).getTime()  : 0;
        const logTime = log.lastEvent ? new Date(log.lastEvent).getTime() : 0;
        name = ptTime >= logTime ? ptName : logName;
      } else {
        name = ptName; // they agree
      }
    } else {
      name = ptName || logName || this._playerStats.getNameForId(steamId) || steamId;
    }

    // ── Last active: max of both timestamps ──
    const ptLastSeen  = pt?.lastSeen  ? new Date(pt.lastSeen).getTime()  : 0;
    const logLastEvent = log?.lastEvent ? new Date(log.lastEvent).getTime() : 0;
    const lastActiveMs = Math.max(ptLastSeen, logLastEvent);
    const lastActive = lastActiveMs > 0 ? new Date(lastActiveMs).toISOString() : null;

    // ── First seen (playtime only) ──
    const firstSeen = pt?.firstSeen || null;

    return { name, firstSeen, lastActive, playtime: pt, log, save };
  }

  async start() {
    if (!this._config.playerStatsChannelId) {
      console.log(`[${this._label}] No PLAYER_STATS_CHANNEL_ID set, skipping.`);
      return;
    }

    try {
      this.channel = await this.client.channels.fetch(this._config.playerStatsChannelId);
      if (!this.channel) {
        console.error(`[${this._label}] Channel not found! Check PLAYER_STATS_CHANNEL_ID.`);
        return;
      }
    } catch (err) {
      console.error(`[${this._label}] Failed to fetch channel:`, err.message);
      return;
    }

    console.log(`[${this._label}] Posting in #${this.channel.name}`);

    // Load persistent kill tracker
    this._loadKillData();

    // Delete previous own message (by saved ID), not all bot messages
    await this._cleanOwnMessage();

    // Post the initial embed
    const embed = this._buildOverviewEmbed();
    const components = [...this._buildPlayerRow(), ...this._buildClanRow()];
    this.statusMessage = await this.channel.send({
      embeds: [embed],
      ...(components.length > 0 && { components }),
    });
    this._saveMessageId();

    // Do initial save parse
    await this._pollSave();

    // Update the embed after initial parse
    await this._updateEmbed();

    // Start save poll loop — use faster agent interval if agent mode is active
    const pollMs = typeof this._config.getEffectiveSavePollInterval === 'function'
      ? this._config.getEffectiveSavePollInterval()
      : Math.max(this._config.savePollInterval || 300000, 60000);
    this.saveInterval = setInterval(() => {
      this._pollSave()
        .then(() => this._updateEmbed())
        .catch(err => console.error(`[${this._label}] Save poll error:`, err.message));
    }, pollMs);
    console.log(`[${this._label}] Save poll every ${pollMs / 1000}s (agent mode: ${this._config.agentMode || 'direct'})`);

    // Update embed every 60s (for playtime changes etc.)
    this._embedInterval = setInterval(() => this._updateEmbed(), 60000);
  }

  stop() {
    if (this.saveInterval) { clearInterval(this.saveInterval); this.saveInterval = null; }
    if (this._embedInterval) { clearInterval(this._embedInterval); this._embedInterval = null; }
    this._saveKillData();
  }

  async _pollSave() {
    if (!this._config.ftpHost || this._config.ftpHost.startsWith('PASTE_')) return;

    const sftp = new SftpClient();
    try {
      await sftp.connect(this._config.sftpConnectConfig());

      // Load PlayerIDMapped.txt early so names resolve on first embed
      await this._refreshIdMap(sftp);

      const buf = await this._downloadSave(sftp);
      const { players, worldState } = parseSave(buf);
      this._saveData = players;
      this._lastSaveUpdate = new Date();

      // Track world state changes (season, day, airdrop)
      const prevWorldState = this._worldState || null;
      this._worldState = worldState || {};
      console.log(`[${this._label}] Parsed save: ${players.size} players (${(buf.length / 1024 / 1024).toFixed(1)}MB)`);

      // Accumulate lifetime stats across deaths (kills + survival + activity)
      this._accumulateStats();

      // Detect world state changes (season, day milestones, airdrops)
      if (prevWorldState && this._config.enableWorldEventFeed && this._logWatcher) {
        this._detectWorldEvents(prevWorldState, this._worldState);
      }

      // Feed coordinates to player map tracker
      if (this._config.enablePlayerMap) {
        try {
          const nameMap = new Map();
          if (this._playerStats._idMap) {
            for (const [nameLower, steamId] of this._playerStats._idMap) {
              // Use the proper-cased name from player records when available
              const rec = this._playerStats._data?.players?.[steamId];
              nameMap.set(steamId, rec?.name || nameLower);
            }
          }
          playerMap.updateFromSave(players, new Set(), nameMap);
        } catch (err) {
          console.error(`[${this._label}] Player map update error:`, err.message);
        }
      }

      // Parse clan data (separate small file)
      try {
        const clanPath = this._config.ftpSavePath.replace(/SaveList\/.*$/, 'Save_ClanData.sav');
        const clanBuf = await sftp.get(clanPath);
        this._clanData = parseClanData(clanBuf);
        console.log(`[${this._label}] Parsed clans: ${this._clanData.length} clans`);
      } catch (err) {
        if (!err.message.includes('No such file')) {
          console.error(`[${this._label}] Clan data error:`, err.message);
        }
      }

      // Fetch server settings (INI file)
      try {
        const settingsPath = this._config.ftpSettingsPath || '/HumanitZServer/GameServerSettings.ini';
        const settingsBuf = await sftp.get(settingsPath);
        const settingsText = settingsBuf.toString('utf8');
        this._serverSettings = _parseIni(settingsText);
        // Inject world state from save file so server-status can use it as fallback
        if (this._worldState) {
          if (this._worldState.daysPassed != null) this._serverSettings._daysPassed = this._worldState.daysPassed;
          if (this._worldState.currentSeason) this._serverSettings._currentSeason = this._worldState.currentSeason;
          if (this._worldState.currentSeasonDay != null) this._serverSettings._currentSeasonDay = this._worldState.currentSeasonDay;
          if (this._worldState.totalStructures != null) this._serverSettings._totalStructures = this._worldState.totalStructures;
          if (this._worldState.totalVehicles != null) this._serverSettings._totalVehicles = this._worldState.totalVehicles;
          if (this._worldState.totalCompanions != null) this._serverSettings._totalCompanions = this._worldState.totalCompanions;
          if (this._worldState.totalPlayers != null) this._serverSettings._totalPlayers = this._worldState.totalPlayers;
          // Extract weather from UDS weather state stored in save
          if (Array.isArray(this._worldState.weatherState)) {
            const weatherProp = this._worldState.weatherState.find(p => p.name === 'CurrentWeather');
            if (weatherProp && typeof weatherProp.value === 'string') {
              this._serverSettings._currentWeather = _resolveUdsWeather(weatherProp.value);
            }
          }
          // Compute total zombie kills across all players from lifetime stats
          let totalZombieKills = 0;
          for (const [, p] of this._saveData) {
            totalZombieKills += p.lifetimeKills || p.zeeksKilled || 0;
          }
          this._serverSettings._totalZombieKills = totalZombieKills;
        }
        // Cache to disk for other modules
        try { fs.writeFileSync(path.join(this._dataDir, 'server-settings.json'), JSON.stringify(this._serverSettings, null, 2)); } catch (_) {}
        console.log(`[${this._label}] Parsed server settings: ${Object.keys(this._serverSettings).length} keys`);
      } catch (err) {
        // Try loading cached settings
        try {
          const _settingsFile = path.join(this._dataDir, 'server-settings.json');
          if (fs.existsSync(_settingsFile)) {
            this._serverSettings = JSON.parse(fs.readFileSync(_settingsFile, 'utf8'));
          }
        } catch (_) {}
        if (!err.message.includes('No such file')) {
          console.error(`[${this._label}] Server settings error:`, err.message);
        }
      }
      // Cache leaderboard data for WelcomeMessage.txt
      this._cacheWelcomeStats();

      // Write updated WelcomeMessage.txt to server (reuse open SFTP connection)
      if (this._config.enableWelcomeFile) {
        try {
          const content = await buildWelcomeContent({
            config: this._config,
            playtime: this._playtime,
            playerStats: this._playerStats,
            dataDir: this._dataDir,
          });
          await sftp.put(Buffer.from(content, 'utf8'), this._config.ftpWelcomePath);
          console.log(`[${this._label}] Updated WelcomeMessage.txt on server`);
        } catch (err) {
          console.error(`[${this._label}] Failed to write WelcomeMessage.txt:`, err.message);
        }
      }

      // Write parsed save data cache for web map
      this._writeSaveCache();

    } catch (err) {
      console.error(`[${this._label}] Save poll error:`, err.message);
    } finally {
      await sftp.end().catch(() => {});
    }
  }

  /**
   * Download the save file using fastGet (parallel chunks) for reliability.
   * Falls back to buffered get() if fastGet fails (e.g. permissions issue).
   * Validates file size against remote to detect truncated downloads.
   */
  async _downloadSave(sftp) {
    const remotePath = this._config.ftpSavePath;
    const tmpFile = path.join(os.tmpdir(), `humanitzbot-save-${process.pid}.sav`);

    try {
      // Use fastGet — parallel chunked download, much faster for large files
      const remoteStat = await sftp.stat(remotePath);
      await sftp.fastGet(remotePath, tmpFile);
      const localStat = fs.statSync(tmpFile);

      if (remoteStat.size && localStat.size !== remoteStat.size) {
        console.warn(`[${this._label}] Save download size mismatch: remote=${remoteStat.size} local=${localStat.size}, retrying with buffered get`);
        const buf = await sftp.get(remotePath);
        try { fs.unlinkSync(tmpFile); } catch (_) {}
        return buf;
      }

      const buf = fs.readFileSync(tmpFile);
      try { fs.unlinkSync(tmpFile); } catch (_) {}
      return buf;
    } catch (err) {
      // fastGet can fail on some SFTP servers — fall back to buffered get
      console.warn(`[${this._label}] fastGet failed (${err.message}), using buffered get`);
      try { fs.unlinkSync(tmpFile); } catch (_) {}
      return sftp.get(remotePath);
    }
  }

  /**
   * Write a lightweight JSON cache with top-player and top-clan leaderboards
   * for the WelcomeMessage.txt builder in auto-messages.js.
   * Also manages the weekly baseline snapshot for "This Week" leaderboards.
   */
  _cacheWelcomeStats() {
    try {
      const allLog = this._playerStats.getAllPlayers();

      // ── Top players by lifetime kills ──
      const topKillers = [];
      for (const [id, save] of this._saveData) {
        const at = this.getAllTimeKills(id);
        const kills = at?.zeeksKilled || 0;
        if (kills <= 0) continue;
        const resolved = this._resolvePlayer(id);
        topKillers.push({ name: resolved.name, kills });
      }
      topKillers.sort((a, b) => b.kills - a.kills);

      // ── Top PvP Killers (from logs) ──
      const topPvpKillers = allLog
        .filter(p => (p.pvpKills || 0) > 0)
        .map(p => {
          const resolved = this._resolvePlayer(p.id);
          return { name: resolved.name, kills: p.pvpKills };
        })
        .sort((a, b) => b.kills - a.kills);

      // ── Top Fishers (from save) ──
      const topFishers = [];
      for (const [id, save] of this._saveData) {
        const count = save.fishCaught || 0;
        if (count <= 0) continue;
        const resolved = this._resolvePlayer(id);
        topFishers.push({ name: resolved.name, count, pike: save.fishCaughtPike || 0 });
      }
      topFishers.sort((a, b) => b.count - a.count);

      // ── Most Bitten (from save) ──
      const topBitten = [];
      for (const [id, save] of this._saveData) {
        const count = save.timesBitten || 0;
        if (count <= 0) continue;
        const resolved = this._resolvePlayer(id);
        topBitten.push({ name: resolved.name, count });
      }
      topBitten.sort((a, b) => b.count - a.count);

      // ── Top clans by combined lifetime kills and playtime ──
      const topClans = [];
      for (const clan of this._clanData) {
        let totalKills = 0;
        let totalPlaytimeMs = 0;
        for (const m of clan.members) {
          const at = this.getAllTimeKills(m.steamId);
          if (at) totalKills += at.zeeksKilled || 0;
          const pt = this._playtime.getPlaytime(m.steamId);
          if (pt) totalPlaytimeMs += pt.totalMs || 0;
        }
        topClans.push({
          name: clan.name,
          members: clan.members.length,
          kills: totalKills,
          playtimeMs: totalPlaytimeMs,
        });
      }
      topClans.sort((a, b) => b.kills - a.kills);

      // ── Weekly baseline management ──
      const weekly = this._computeWeeklyStats();
      this._weeklyStats = weekly;

      const cache = {
        updatedAt: new Date().toISOString(),
        topKillers: topKillers.slice(0, 5),
        topPvpKillers: topPvpKillers.slice(0, 5),
        topFishers: topFishers.slice(0, 5),
        topBitten: topBitten.slice(0, 5),
        topClans: topClans.slice(0, 5),
        weekly,
      };
      fs.writeFileSync(path.join(this._dataDir, 'welcome-stats.json'), JSON.stringify(cache, null, 2));
    } catch (err) {
      console.error(`[${this._label}] Failed to cache welcome stats:`, err.message);
    }
  }

  /**
   * Write a compact save-data cache to disk for the web map.
   * Contains player positions, vitals, inventory, kills, etc. —
   * everything the web map needs without having to re-parse the .sav.
   */
  _writeSaveCache() {
    if (!this._saveData || this._saveData.size === 0) return;
    try {
      const players = {};
      for (const [steamId, data] of this._saveData) {
        players[steamId] = data;
      }
      const cache = {
        updatedAt: new Date().toISOString(),
        playerCount: this._saveData.size,
        worldState: this._worldState || {},
        players,
      };
      fs.writeFileSync(path.join(this._dataDir, 'save-cache.json'), JSON.stringify(cache));
    } catch (err) {
      console.error(`[${this._label}] Failed to write save cache:`, err.message);
    }
  }

  /**
   * Load or create the weekly baseline, reset if the week has turned over,
   * and return top-5 weekly delta leaderboards.
   */
  _computeWeeklyStats() {
    if (!this._config.showWeeklyStats) return null;

    // Load existing baseline
    let baseline = { weekStart: null, players: {} };
    try {
      const _weeklyFile = path.join(this._dataDir, 'weekly-baseline.json');
      if (fs.existsSync(_weeklyFile)) {
        baseline = JSON.parse(fs.readFileSync(_weeklyFile, 'utf8'));
      }
    } catch (_) {}

    // Check if we need to reset (different week)
    const now = new Date();
    const needsReset = !baseline.weekStart || this._isNewWeek(baseline.weekStart, now);

    if (needsReset) {
      // Snapshot current stats as baseline
      baseline = { weekStart: now.toISOString(), players: {} };
      for (const [id] of this._saveData) {
        baseline.players[id] = this._snapshotPlayerStats(id);
      }
      try {
        fs.writeFileSync(path.join(this._dataDir, 'weekly-baseline.json'), JSON.stringify(baseline, null, 2));
        console.log(`[${this._label}] Weekly baseline reset`);
      } catch (err) {
        console.error(`[${this._label}] Failed to write weekly baseline:`, err.message);
      }
    }

    // Compute deltas: current - baseline
    const allLog = this._playerStats.getAllPlayers();
    const logMap = new Map(allLog.map(p => [p.id, p]));

    const weeklyKillers = [];
    const weeklyPvpKillers = [];
    const weeklyFishers = [];
    const weeklyBitten = [];
    const weeklyPlaytime = [];

    const allIds = new Set([...this._saveData.keys(), ...allLog.map(p => p.id)]);
    for (const id of allIds) {
      const resolved = this._resolvePlayer(id);
      const snap = baseline.players[id] || {};

      // Zombie kills (from save/tracker)
      const at = this.getAllTimeKills(id);
      const kills = (at?.zeeksKilled || 0) - (snap.kills || 0);
      if (kills > 0) weeklyKillers.push({ name: resolved.name, kills });

      // PvP kills (from logs)
      const log = logMap.get(id);
      const pvp = (log?.pvpKills || 0) - (snap.pvpKills || 0);
      if (pvp > 0) weeklyPvpKillers.push({ name: resolved.name, kills: pvp });

      // Fish caught (from save)
      const save = this._saveData.get(id);
      const fish = (save?.fishCaught || 0) - (snap.fish || 0);
      if (fish > 0) weeklyFishers.push({ name: resolved.name, count: fish });

      // Bitten (from save)
      const bites = (save?.timesBitten || 0) - (snap.bitten || 0);
      if (bites > 0) weeklyBitten.push({ name: resolved.name, count: bites });

      // Playtime
      const pt = this._playtime.getPlaytime(id);
      const ptMs = (pt?.totalMs || 0) - (snap.playtimeMs || 0);
      if (ptMs > 60000) weeklyPlaytime.push({ name: resolved.name, ms: ptMs });
    }

    weeklyKillers.sort((a, b) => b.kills - a.kills);
    weeklyPvpKillers.sort((a, b) => b.kills - a.kills);
    weeklyFishers.sort((a, b) => b.count - a.count);
    weeklyBitten.sort((a, b) => b.count - a.count);
    weeklyPlaytime.sort((a, b) => b.ms - a.ms);

    return {
      weekStart: baseline.weekStart,
      topKillers: weeklyKillers.slice(0, 5),
      topPvpKillers: weeklyPvpKillers.slice(0, 5),
      topFishers: weeklyFishers.slice(0, 5),
      topBitten: weeklyBitten.slice(0, 5),
      topPlaytime: weeklyPlaytime.slice(0, 5),
    };
  }

  /**
   * Snapshot a player's current stats for weekly baseline comparison.
   */
  _snapshotPlayerStats(id) {
    const at = this.getAllTimeKills(id);
    const log = this._playerStats.getStats(id);
    const save = this._saveData.get(id);
    const pt = this._playtime.getPlaytime(id);
    return {
      kills: at?.zeeksKilled || 0,
      pvpKills: log?.pvpKills || 0,
      fish: save?.fishCaught || 0,
      bitten: save?.timesBitten || 0,
      playtimeMs: pt?.totalMs || 0,
      // New weekly-tracked fields
      craftingRecipes: save?.craftingRecipes?.length || 0,
      buildingRecipes: save?.buildingRecipes?.length || 0,
      unlockedSkills: save?.unlockedSkills?.length || 0,
      unlockedProfessions: save?.unlockedProfessions?.length || 0,
      lore: save?.lore?.length || 0,
      uniqueLoots: save?.uniqueLoots?.length || 0,
      craftedUniques: save?.craftedUniques?.length || 0,
      companions: (save?.companionData?.length || 0) + (save?.horses?.length || 0),
    };
  }

  /**
   * Check if the baseline's weekStart falls in a previous week
   * relative to `now`, using the configured reset day.
   *
   * All date comparisons are done as YYYY-MM-DD strings in the bot timezone
   * to avoid mismatches between system-timezone midnight and bot-timezone
   * day-of-week boundaries. (setHours(0,0,0,0) operates in the system
   * timezone, which may differ from BOT_TIMEZONE.)
   */
  _isNewWeek(weekStartIso, now) {
    const resetDay = this._config.weeklyResetDay; // 0=Sun, 1=Mon, … 6=Sat

    // Current day-of-week in bot timezone
    const dayStr = now.toLocaleDateString('en-US', {
      weekday: 'short',
      timeZone: this._config.botTimezone,
    });
    const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const currentDay = dayMap[dayStr] ?? now.getDay();
    const daysSinceReset = (currentDay - resetDay + 7) % 7;

    // Today's date in bot timezone as 'YYYY-MM-DD'
    const todayStr = now.toLocaleDateString('en-CA', {
      timeZone: this._config.botTimezone,
    });
    // Reset boundary = todayStr minus daysSinceReset (as a date-only value in UTC avoids DST)
    const [y, m, d] = todayStr.split('-').map(Number);
    const resetDate = new Date(Date.UTC(y, m - 1, d - daysSinceReset));
    const resetDateStr = resetDate.toISOString().slice(0, 10);

    // weekStart's date in bot timezone
    const weekStart = new Date(weekStartIso);
    const weekStartDateStr = weekStart.toLocaleDateString('en-CA', {
      timeZone: this._config.botTimezone,
    });

    return weekStartDateStr < resetDateStr;
  }

  async _updateEmbed() {
    if (!this.statusMessage) return;
    try {
      const embed = this._buildOverviewEmbed();
      const components = [...this._buildPlayerRow(), ...this._buildClanRow()];

      // Skip Discord API call if content hasn't changed since last edit
      const contentKey = JSON.stringify(embed.data) + JSON.stringify(components.map(c => c.toJSON()));
      if (contentKey === this._lastEmbedKey) return;
      this._lastEmbedKey = contentKey;

      await this.statusMessage.edit({
        embeds: [embed],
        ...(components.length > 0 && { components }),
      });
    } catch (err) {
      // Message was deleted externally — re-create it
      if (err.code === 10008) {
        console.log(`[${this._label}] Embed message was deleted, re-creating...`);
        try {
          const freshEmbed = this._buildOverviewEmbed();
          const components = [...this._buildPlayerRow(), ...this._buildClanRow()];
          this.statusMessage = await this.channel.send({
            embeds: [freshEmbed],
            ...(components.length > 0 && { components }),
          });
          this._saveMessageId();
        } catch (createErr) {
          console.error(`[${this._label}] Failed to re-create message:`, createErr.message);
        }
      } else {
        console.error(`[${this._label}] Embed update error:`, err.message);
      }
    }
  }

  async _cleanOwnMessage() {
    const savedId = this._loadMessageId();
    if (savedId) {
      // Have a saved ID — delete only that specific message
      try {
        const msg = await this.channel.messages.fetch(savedId);
        if (msg && msg.author.id === this.client.user.id) {
          await msg.delete();
          console.log(`[${this._label}] Cleaned previous message ${savedId}`);
          return; // success — no need for bulk sweep
        }
      } catch (err) {
        if (err.code !== 10008) {
          console.log(`[${this._label}] Could not clean saved message:`, err.message);
          return;
        }
        // 10008 = message gone — fall through to bulk sweep
        console.log(`[${this._label}] Saved message ${savedId} already gone, sweeping channel...`);
      }
    }
    // No saved ID, or saved message was already deleted — sweep old bot messages
    // Only delete messages older than this process start to avoid wiping
    // sibling multi-server embeds posted earlier in this same startup.
    const bootTime = Date.now() - process.uptime() * 1000;
    try {
      const messages = await this.channel.messages.fetch({ limit: 20 });
      const botMessages = messages.filter(m => m.author.id === this.client.user.id && m.createdTimestamp < bootTime);
      if (botMessages.size > 0) {
        console.log(`[${this._label}] Cleaning ${botMessages.size} old bot message(s)`);
        for (const [, msg] of botMessages) {
          try { await msg.delete(); } catch (_) {}
        }
      }
    } catch (err) {
      console.log(`[${this._label}] Could not clean old messages:`, err.message);
    }
  }

  _loadMessageId() {
    try {
      const fp = path.join(this._dataDir, 'message-ids.json');
      if (fs.existsSync(fp)) {
        const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
        return data.playerStats || null;
      }
    } catch {} return null;
  }

  _saveMessageId() {
    if (!this.statusMessage) return;
    try {
      const fp = path.join(this._dataDir, 'message-ids.json');
      let data = {};
      try { if (fs.existsSync(fp)) data = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch {}
      data.playerStats = this.statusMessage.id;
      fs.writeFileSync(fp, JSON.stringify(data, null, 2));
    } catch {}
  }

  /**
   * Download PlayerIDMapped.txt and feed it to PlayerStats so names resolve
   * before the overview embed is built. Reuses the already-open SFTP connection.
   */
  async _refreshIdMap(sftp) {
    try {
      const idMapPath = this._config.ftpIdMapPath;
      if (!idMapPath) return;
      const buf = await sftp.get(idMapPath);
      const text = buf.toString('utf8');
      const entries = [];
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const match = trimmed.match(/^(\d{17})_\+_\|[^@]+@(.+)$/);
        if (match) entries.push({ steamId: match[1], name: match[2].trim() });
      }
      if (entries.length > 0) {
        this._playerStats.loadIdMap(entries);
        // Cache locally for fast startup next time
        try { fs.writeFileSync(path.join(this._dataDir, 'PlayerIDMapped.txt'), text); } catch (_) {}
        console.log(`[${this._label}] Loaded ${entries.length} name(s) from PlayerIDMapped.txt`);
      }
    } catch (err) {
      // Not critical — file may not exist on this server
      if (!err.message.includes('No such file')) {
        console.log(`[${this._label}] Could not read PlayerIDMapped.txt:`, err.message);
      }
    }
  }

  // ── Lifetime Stat Tracker (accumulates across deaths) ─────

  static KILL_KEYS = ['zeeksKilled', 'headshots', 'meleeKills', 'gunKills', 'blastKills', 'fistKills', 'takedownKills', 'vehicleKills'];
  static SURVIVAL_KEYS = ['daysSurvived'];

  // Scalar activity fields tracked via save diffs (simple number deltas)
  static ACTIVITY_SCALAR_KEYS = ['fishCaught', 'fishCaughtPike', 'timesBitten'];

  // Challenge progress keys — tracked for completion feed
  static CHALLENGE_KEYS = [
    'challengeKillZombies', 'challengeKill50', 'challengeCatch20Fish', 'challengeRegularAngler',
    'challengeKillZombieBear', 'challenge9Squares', 'challengeCraftFirearm', 'challengeCraftFurnace',
    'challengeCraftMeleeBench', 'challengeCraftMeleeWeapon', 'challengeCraftRainCollector',
    'challengeCraftTablesaw', 'challengeCraftTreatment', 'challengeCraftWeaponsBench',
    'challengeCraftWorkbench', 'challengeFindDog', 'challengeFindHeli', 'challengeLockpickSUV',
    'challengeRepairRadio',
  ];

  // Array-based activity fields tracked via save diffs (new items = set difference)
  static ACTIVITY_ARRAY_KEYS = [
    'craftingRecipes', 'buildingRecipes', 'unlockedSkills',
    'unlockedProfessions', 'lore', 'lootItemUnique', 'craftedUniques',
    'companionData', 'horses',
  ];

  // Maps GameStats key → ExtendedStats (lifetime) save field
  static LIFETIME_KEY_MAP = {
    zeeksKilled:   'lifetimeKills',
    headshots:     'lifetimeHeadshots',
    meleeKills:    'lifetimeMeleeKills',
    gunKills:      'lifetimeGunKills',
    blastKills:    'lifetimeBlastKills',
    fistKills:     'lifetimeFistKills',
    takedownKills: 'lifetimeTakedownKills',
    vehicleKills:  'lifetimeVehicleKills',
  };

  _loadKillData() {
    try {
      const _killFile = path.join(this._dataDir, 'kill-tracker.json');
      if (fs.existsSync(_killFile)) {
        this._killData = JSON.parse(fs.readFileSync(_killFile, 'utf8'));
        const count = Object.keys(this._killData.players).length;
        console.log(`[${this._label}] Loaded ${count} player(s) from kill-tracker.json`);
        // Migrate old records: add missing fields
        for (const record of Object.values(this._killData.players)) {
          if (!record.survivalCumulative) record.survivalCumulative = PlayerStatsChannel._emptyObj(PlayerStatsChannel.SURVIVAL_KEYS);
          if (!record.survivalSnapshot) record.survivalSnapshot = PlayerStatsChannel._emptyObj(PlayerStatsChannel.SURVIVAL_KEYS);
          // Death checkpoint: lifetime kills at the moment of last death
          if (!record.deathCheckpoint) record.deathCheckpoint = null;
          if (record.lastKnownDeaths === undefined) record.lastKnownDeaths = 0;
          // Cached lifetime values for when player goes offline
          if (!record.lifetimeSnapshot) record.lifetimeSnapshot = null;
          if (!record.survivalLifetimeSnapshot) record.survivalLifetimeSnapshot = null;
          // Last lifetime snapshot for delta computation
          if (!record.lastLifetimeSnapshot) record.lastLifetimeSnapshot = record.lifetimeSnapshot ? { ...record.lifetimeSnapshot } : null;
          if (!record.lastSurvivalLifetimeSnapshot) record.lastSurvivalLifetimeSnapshot = record.survivalLifetimeSnapshot ? { ...record.survivalLifetimeSnapshot } : null;
          // Activity tracking snapshots (scalar + array diffs)
          if (!record.activitySnapshot) record.activitySnapshot = PlayerStatsChannel._emptyObj(PlayerStatsChannel.ACTIVITY_SCALAR_KEYS);
          if (!record.activityArraySnapshot) {
            record.activityArraySnapshot = {};
            for (const k of PlayerStatsChannel.ACTIVITY_ARRAY_KEYS) record.activityArraySnapshot[k] = [];
          }
          // Challenge progress snapshot (for completion feed)
          if (!record.challengeSnapshot) record.challengeSnapshot = PlayerStatsChannel._emptyObj(PlayerStatsChannel.CHALLENGE_KEYS);
        }
      }
    } catch (err) {
      console.error(`[${this._label}] Failed to load kill tracker, starting fresh:`, err.message);
      this._killData = { players: {} };
    }
  }

  _saveKillData() {
    if (!this._killDirty) return;
    try {
      if (!fs.existsSync(this._dataDir)) fs.mkdirSync(this._dataDir, { recursive: true });
      fs.writeFileSync(path.join(this._dataDir, 'kill-tracker.json'), JSON.stringify(this._killData, null, 2), 'utf8');
      this._killDirty = false;
    } catch (err) {
      console.error(`[${this._label}] Failed to save kill tracker:`, err.message);
    }
  }

  static _emptyObj(keys) {
    const obj = {};
    for (const k of keys) obj[k] = 0;
    return obj;
  }

  static _emptyKills() { return PlayerStatsChannel._emptyObj(PlayerStatsChannel.KILL_KEYS); }

  static _snapshotKills(save) {
    const obj = {};
    for (const k of PlayerStatsChannel.KILL_KEYS) obj[k] = save[k] || 0;
    return obj;
  }

  static _snapshotSurvival(save) {
    const obj = {};
    for (const k of PlayerStatsChannel.SURVIVAL_KEYS) obj[k] = save[k] || 0;
    return obj;
  }

  static _snapshotChallenges(save) {
    const obj = {};
    for (const k of PlayerStatsChannel.CHALLENGE_KEYS) obj[k] = save[k] || 0;
    return obj;
  }

  _accumulateStats() {
    const today = this._config.getToday();  // timezone-aware 'YYYY-MM-DD'

    // Determine which date's thread these deltas belong to.
    // If kill-tracker has a lastPollDate from a previous day, the first poll's
    // deltas represent activity that happened on that day — post to the old thread.
    const lastPollDate = this._killData.lastPollDate || null;
    const targetDate = (lastPollDate && lastPollDate !== today) ? lastPollDate : today;
    this._killData.lastPollDate = today;
    this._killDirty = true;

    if (targetDate !== today) {
      console.log(`[${this._label}] First poll after restart — posting pending deltas to ${targetDate} thread`);
    }

    const killDeltas = [];    // per-player kill deltas for the kill feed
    const survivalDeltas = []; // per-player survival deltas for the survival feed
    const fishingDeltas = [];  // per-player fishing deltas
    const recipeDeltas = [];   // per-player new recipes
    const skillDeltas = [];    // per-player new skills
    const professionDeltas = []; // per-player new professions
    const loreDeltas = [];     // per-player new lore entries
    const uniqueDeltas = [];   // per-player new unique items
    const companionDeltas = []; // per-player new companions/horses
    const challengeDeltas = []; // per-player challenge completions

    for (const [id, save] of this._saveData) {
      const currentKills = PlayerStatsChannel._snapshotKills(save);
      const currentSurvival = PlayerStatsChannel._snapshotSurvival(save);

      if (!this._killData.players[id]) {
        // First time seeing this player — initialise both trackers
        const logDeaths = this._playerStats.getStats(id)?.deaths || 0;
        const actSnapshot = {};
        for (const k of PlayerStatsChannel.ACTIVITY_SCALAR_KEYS) actSnapshot[k] = save[k] || 0;
        const arrSnapshot = {};
        for (const k of PlayerStatsChannel.ACTIVITY_ARRAY_KEYS) arrSnapshot[k] = Array.isArray(save[k]) ? [...save[k]] : [];
        this._killData.players[id] = {
          cumulative: PlayerStatsChannel._emptyKills(),
          lastSnapshot: currentKills,
          survivalCumulative: PlayerStatsChannel._emptyObj(PlayerStatsChannel.SURVIVAL_KEYS),
          survivalSnapshot: currentSurvival,
          hasExtendedStats: !!save.hasExtendedStats,
          deathCheckpoint: null,
          lastKnownDeaths: logDeaths,
          lifetimeSnapshot: null,
          survivalLifetimeSnapshot: null,
          lastLifetimeSnapshot: null,
          lastSurvivalLifetimeSnapshot: null,
          activitySnapshot: actSnapshot,
          activityArraySnapshot: arrSnapshot,
          challengeSnapshot: PlayerStatsChannel._snapshotChallenges(save),
        };
        // Cache lifetime values if available
        if (save.hasExtendedStats) {
          const ls = {};
          for (const k of PlayerStatsChannel.KILL_KEYS) {
            const lifetimeKey = PlayerStatsChannel.LIFETIME_KEY_MAP[k];
            ls[k] = lifetimeKey ? (save[lifetimeKey] || 0) : 0;
          }
          this._killData.players[id].lifetimeSnapshot = ls;
          this._killData.players[id].lastLifetimeSnapshot = { ...ls }; // seed delta baseline
          this._killData.players[id].survivalLifetimeSnapshot = {
            daysSurvived: save.lifetimeDaysSurvived || save.daysSurvived || 0,
          };
          this._killData.players[id].lastSurvivalLifetimeSnapshot = {
            ...this._killData.players[id].survivalLifetimeSnapshot,
          };
        }
        // Don't set initial checkpoint — GameStats is often stale and would
        // produce a wrong checkpoint.  Leave null until the bot actually
        // observes a death via LogWatcher, then _accumulateStats sets it
        // precisely from the death-time lifetime snapshot.
        this._killDirty = true;
        continue;
      }

      const record = this._killData.players[id];
      const lastKills = record.lastSnapshot;
      const lastSurvival = record.survivalSnapshot || PlayerStatsChannel._emptyObj(PlayerStatsChannel.SURVIVAL_KEYS);
      const playerName = this._resolvePlayer(id).name;

      // ExtendedStats values are already lifetime cumulative — skip legacy death detection
      if (save.hasExtendedStats) {
        record.hasExtendedStats = true;
        // Clear stale cumulative data (ExtendedStats replaces the banking system)
        if (record.cumulative.zeeksKilled > 0 || record.survivalCumulative?.daysSurvived > 0) {
          console.log(`[${this._label}] ${id}: ExtendedStats available — clearing banked cumulative`);
          record.cumulative = PlayerStatsChannel._emptyKills();
          record.survivalCumulative = PlayerStatsChannel._emptyObj(PlayerStatsChannel.SURVIVAL_KEYS);
        }
        // Cache lifetime values so they persist when player goes offline
        const ls = {};
        for (const k of PlayerStatsChannel.KILL_KEYS) {
          const lifetimeKey = PlayerStatsChannel.LIFETIME_KEY_MAP[k];
          ls[k] = lifetimeKey ? (save[lifetimeKey] || 0) : 0;
        }
        record.lifetimeSnapshot = ls;
        record.survivalLifetimeSnapshot = {
          daysSurvived: save.lifetimeDaysSurvived || save.daysSurvived || 0,
        };

        // Death checkpoint: detect new deaths via log data and snapshot lifetime kills
        const logDeaths = this._playerStats.getStats(id)?.deaths || 0;
        const prevDeaths = record.lastKnownDeaths || 0;
        if (logDeaths > prevDeaths) {
          // Death occurred — set checkpoint = lifetimeKills - current GameStats kills
          // GameStats shows kills in the NEW life (may be 0 if just died or offline)
          const cp = {};
          for (const k of PlayerStatsChannel.KILL_KEYS) {
            const lifetimeKey = PlayerStatsChannel.LIFETIME_KEY_MAP[k];
            const lifetime = lifetimeKey ? (save[lifetimeKey] || 0) : 0;
            cp[k] = lifetime - (currentKills[k] || 0);
          }
          record.deathCheckpoint = cp;
          record.lastKnownDeaths = logDeaths;
          console.log(`[${this._label}] ${id}: death #${logDeaths} — checkpoint set (lifetime ${save.lifetimeKills || 0}, session ${currentKills.zeeksKilled})`);
          this._killDirty = true;
        } else if (record.lastKnownDeaths !== logDeaths) {
          record.lastKnownDeaths = logDeaths;
          this._killDirty = true;
        }
      } else {
        // Legacy fallback: detect death reset (main kill count dropped)
        const deathReset = currentKills.zeeksKilled < lastKills.zeeksKilled;
        if (deathReset) {
          for (const k of PlayerStatsChannel.KILL_KEYS) {
            record.cumulative[k] += lastKills[k];
          }
          if (!record.survivalCumulative) record.survivalCumulative = PlayerStatsChannel._emptyObj(PlayerStatsChannel.SURVIVAL_KEYS);
          for (const k of PlayerStatsChannel.SURVIVAL_KEYS) {
            record.survivalCumulative[k] += lastSurvival[k];
          }
          console.log(`[${this._label}] ${id}: death detected — banked ${lastKills.zeeksKilled} kills, ${lastSurvival.daysSurvived} days`);
          record.lastSnapshot = currentKills;
          record.survivalSnapshot = currentSurvival;
          this._killDirty = true;
          continue;
        }
      }

      // Compute kill deltas since last poll
      // For ExtendedStats players: use lifetime values (never reset on death)
      // For legacy players: use GameStats values (session-based)
      const killDelta = {};
      let hasKills = false;
      if (record.hasExtendedStats && record.lifetimeSnapshot) {
        const prevLifetime = record.lastLifetimeSnapshot || PlayerStatsChannel._emptyKills();
        for (const k of PlayerStatsChannel.KILL_KEYS) {
          const diff = (record.lifetimeSnapshot[k] || 0) - (prevLifetime[k] || 0);
          if (diff > 0) { killDelta[k] = diff; hasKills = true; }
        }
        record.lastLifetimeSnapshot = { ...record.lifetimeSnapshot };
      } else {
        for (const k of PlayerStatsChannel.KILL_KEYS) {
          const diff = currentKills[k] - lastKills[k];
          if (diff > 0) { killDelta[k] = diff; hasKills = true; }
        }
      }
      if (hasKills) {
        killDeltas.push({ steamId: id, name: playerName, delta: killDelta });
      }

      // Compute survival deltas since last poll
      // For ExtendedStats: use lifetime values (reliable); legacy: use GameStats
      const survDelta = {};
      let hasSurv = false;
      if (record.hasExtendedStats && record.survivalLifetimeSnapshot) {
        const prevSurvLifetime = record.lastSurvivalLifetimeSnapshot || PlayerStatsChannel._emptyObj(PlayerStatsChannel.SURVIVAL_KEYS);
        for (const k of PlayerStatsChannel.SURVIVAL_KEYS) {
          const diff = (record.survivalLifetimeSnapshot[k] || 0) - (prevSurvLifetime[k] || 0);
          if (diff > 0) { survDelta[k] = diff; hasSurv = true; }
        }
        record.lastSurvivalLifetimeSnapshot = { ...record.survivalLifetimeSnapshot };
      } else {
        for (const k of PlayerStatsChannel.SURVIVAL_KEYS) {
          const diff = currentSurvival[k] - lastSurvival[k];
          if (diff > 0) { survDelta[k] = diff; hasSurv = true; }
        }
      }
      if (hasSurv) {
        survivalDeltas.push({ steamId: id, name: playerName, delta: survDelta });
      }

      // ── Activity scalar diffs (fishing, bites) ──
      const prevAct = record.activitySnapshot || PlayerStatsChannel._emptyObj(PlayerStatsChannel.ACTIVITY_SCALAR_KEYS);
      const fishDelta = {};
      let hasFish = false;
      for (const k of PlayerStatsChannel.ACTIVITY_SCALAR_KEYS) {
        const diff = (save[k] || 0) - (prevAct[k] || 0);
        if (diff > 0) { fishDelta[k] = diff; hasFish = true; }
      }
      if (hasFish) {
        fishingDeltas.push({ steamId: id, name: playerName, delta: fishDelta });
      }
      // Update scalar snapshot
      const newActSnapshot = {};
      for (const k of PlayerStatsChannel.ACTIVITY_SCALAR_KEYS) newActSnapshot[k] = save[k] || 0;
      record.activitySnapshot = newActSnapshot;

      // ── Activity array diffs (recipes, skills, professions, lore, uniques, companions) ──
      const prevArr = record.activityArraySnapshot || {};
      const newArrSnapshot = {};
      for (const k of PlayerStatsChannel.ACTIVITY_ARRAY_KEYS) {
        const current = Array.isArray(save[k]) ? save[k] : [];
        const prev = Array.isArray(prevArr[k]) ? prevArr[k] : [];
        newArrSnapshot[k] = [...current];

        // Find new entries (in current but not in previous)
        if (current.length > prev.length) {
          const prevSet = new Set(prev.map(v => typeof v === 'object' ? JSON.stringify(v) : String(v)));
          const newItems = current.filter(v => {
            const key = typeof v === 'object' ? JSON.stringify(v) : String(v);
            return !prevSet.has(key);
          });
          if (newItems.length > 0) {
            if (k === 'craftingRecipes' || k === 'buildingRecipes') {
              recipeDeltas.push({ steamId: id, name: playerName, type: k === 'craftingRecipes' ? 'Crafting' : 'Building', items: newItems });
            } else if (k === 'unlockedSkills') {
              skillDeltas.push({ steamId: id, name: playerName, items: newItems });
            } else if (k === 'unlockedProfessions') {
              professionDeltas.push({ steamId: id, name: playerName, items: newItems });
            } else if (k === 'lore') {
              loreDeltas.push({ steamId: id, name: playerName, items: newItems });
            } else if (k === 'lootItemUnique' || k === 'craftedUniques') {
              uniqueDeltas.push({ steamId: id, name: playerName, type: k === 'lootItemUnique' ? 'found' : 'crafted', items: newItems });
            } else if (k === 'companionData' || k === 'horses') {
              companionDeltas.push({ steamId: id, name: playerName, type: k === 'horses' ? 'horse' : 'companion', items: newItems });
            }
          }
        }
      }
      record.activityArraySnapshot = newArrSnapshot;

      // ── Challenge completion detection ──
      if (save.hasExtendedStats) {
        const prevChal = record.challengeSnapshot || PlayerStatsChannel._emptyObj(PlayerStatsChannel.CHALLENGE_KEYS);
        const completedNow = [];
        for (const k of PlayerStatsChannel.CHALLENGE_KEYS) {
          const cur = save[k] || 0;
          const prev = prevChal[k] || 0;
          if (cur > prev) {
            const info = gameData.CHALLENGE_DESCRIPTIONS[k];
            // Check if the challenge was just completed (reached or exceeded target)
            // For challenges without a numeric target (e.g., "find a dog"), any increase = completion
            if (info) {
              const wasComplete = info.target ? prev >= info.target : prev > 0;
              const isComplete = info.target ? cur >= info.target : cur > 0;
              if (!wasComplete && isComplete) {
                completedNow.push({ key: k, name: info.name, desc: info.desc });
              }
            }
          }
        }
        if (completedNow.length > 0) {
          challengeDeltas.push({ steamId: id, name: playerName, completed: completedNow });
        }
        record.challengeSnapshot = PlayerStatsChannel._snapshotChallenges(save);
      }

      record.lastSnapshot = currentKills;
      record.survivalSnapshot = currentSurvival;
      this._killDirty = true;
    }

    this._saveKillData();

    // Post feeds to activity thread (may be a previous day's thread on first poll after restart)
    const feedTarget = targetDate;  // 'YYYY-MM-DD' — routed to correct thread
    if (killDeltas.length > 0 && this._config.enableKillFeed && this._logWatcher) {
      this._postKillFeed(killDeltas, feedTarget);
    }
    // Post survival feed to activity thread if enabled
    if (survivalDeltas.length > 0 && this._config.enableKillFeed && this._logWatcher) {
      this._postSurvivalFeed(survivalDeltas, feedTarget);
    }
    // Post activity feeds to activity thread if enabled
    if (fishingDeltas.length > 0 && this._config.enableFishingFeed && this._logWatcher) {
      this._postFishingFeed(fishingDeltas, feedTarget);
    }
    if (recipeDeltas.length > 0 && this._config.enableRecipeFeed && this._logWatcher) {
      this._postRecipeFeed(recipeDeltas, feedTarget);
    }
    if (skillDeltas.length > 0 && this._config.enableSkillFeed && this._logWatcher) {
      this._postSkillFeed(skillDeltas, feedTarget);
    }
    if (professionDeltas.length > 0 && this._config.enableProfessionFeed && this._logWatcher) {
      this._postProfessionFeed(professionDeltas, feedTarget);
    }
    if (loreDeltas.length > 0 && this._config.enableLoreFeed && this._logWatcher) {
      this._postLoreFeed(loreDeltas, feedTarget);
    }
    if (uniqueDeltas.length > 0 && this._config.enableUniqueFeed && this._logWatcher) {
      this._postUniqueFeed(uniqueDeltas, feedTarget);
    }
    if (companionDeltas.length > 0 && this._config.enableCompanionFeed && this._logWatcher) {
      this._postCompanionFeed(companionDeltas, feedTarget);
    }
    if (challengeDeltas.length > 0 && this._config.enableChallengeFeed && this._logWatcher) {
      this._postChallengeFeed(challengeDeltas, feedTarget);
    }
  }

  /**
   * Send an embed to the correct activity thread for the given date.
   * @param {EmbedBuilder} embed
   * @param {string} [targetDate] - 'YYYY-MM-DD'; defaults to today's thread
   */
  async _sendFeedEmbed(embed, targetDate) {
    const today = this._config.getToday();
    if (targetDate && targetDate !== today && this._logWatcher.sendToDateThread) {
      return this._logWatcher.sendToDateThread(embed, targetDate);
    }
    return this._logWatcher.sendToThread(embed);
  }

  async _postKillFeed(deltas, targetDate) {
    const lines = deltas.map(({ name, delta }) => {
      const total = delta.zeeksKilled || 0;
      const parts = [];
      if (delta.headshots)     parts.push(`${delta.headshots} headshot${delta.headshots > 1 ? 's' : ''}`);
      if (delta.meleeKills)    parts.push(`${delta.meleeKills} melee`);
      if (delta.gunKills)      parts.push(`${delta.gunKills} gun`);
      if (delta.blastKills)    parts.push(`${delta.blastKills} blast`);
      if (delta.fistKills)     parts.push(`${delta.fistKills} fist`);
      if (delta.takedownKills) parts.push(`${delta.takedownKills} takedown`);
      if (delta.vehicleKills)  parts.push(`${delta.vehicleKills} vehicle`);
      const detail = parts.length > 0 ? ` (${parts.join(', ')})` : '';
      return `**${name}** killed **${total} zeek${total !== 1 ? 's' : ''}**${detail}`;
    });

    const embed = new EmbedBuilder()
      .setAuthor({ name: '🧟 Kill Activity' })
      .setDescription(lines.join('\n'))
      .setColor(0x1abc9c)
      .setTimestamp();

    try {
      await this._sendFeedEmbed(embed, targetDate);
    } catch (err) {
      console.error(`[${this._label}] Failed to post kill feed to activity thread:`, err.message);
    }
  }

  async _postSurvivalFeed(deltas, targetDate) {
    const lines = deltas.map(({ name, delta }) => {
      const parts = [];
      if (delta.daysSurvived)  parts.push(`+${delta.daysSurvived} day${delta.daysSurvived > 1 ? 's' : ''} survived`);
      return `**${name}** — ${parts.join(', ')}`;
    });

    const embed = new EmbedBuilder()
      .setAuthor({ name: '🏕️ Survival Activity' })
      .setDescription(lines.join('\n'))
      .setColor(0x2ecc71)
      .setTimestamp();

    try {
      await this._sendFeedEmbed(embed, targetDate);
    } catch (err) {
      console.error(`[${this._label}] Failed to post survival feed to activity thread:`, err.message);
    }
  }

  async _postFishingFeed(deltas, targetDate) {
    const lines = deltas.map(({ name, delta }) => {
      const total = delta.fishCaught || 0;
      const pike = delta.fishCaughtPike || 0;
      const bitten = delta.timesBitten || 0;
      const parts = [];
      if (total > 0) {
        const pikeNote = pike > 0 ? ` (${pike} pike)` : '';
        parts.push(`caught **${total} fish**${pikeNote}`);
      }
      if (bitten > 0) parts.push(`was bitten **${bitten} time${bitten > 1 ? 's' : ''}**`);
      return `**${name}** ${parts.join(', ')}`;
    });

    const embed = new EmbedBuilder()
      .setAuthor({ name: '🎣 Fishing Activity' })
      .setDescription(lines.join('\n'))
      .setColor(0x3498db)
      .setTimestamp();

    try {
      await this._sendFeedEmbed(embed, targetDate);
    } catch (err) {
      console.error(`[${this._label}] Failed to post fishing feed to activity thread:`, err.message);
    }
  }

  async _postRecipeFeed(deltas, targetDate) {
    const lines = deltas.map(({ name, type, items }) => {
      const names = items.map(r => _cleanItemName(r)).filter(Boolean);
      const display = names.length <= 5 ? names.join(', ') : `${names.slice(0, 5).join(', ')} +${names.length - 5} more`;
      return `**${name}** learned ${type}: ${display}`;
    });

    const embed = new EmbedBuilder()
      .setAuthor({ name: '📖 Recipe Unlocked' })
      .setDescription(lines.join('\n'))
      .setColor(0xe67e22)
      .setTimestamp();

    try {
      await this._sendFeedEmbed(embed, targetDate);
    } catch (err) {
      console.error(`[${this._label}] Failed to post recipe feed to activity thread:`, err.message);
    }
  }

  async _postSkillFeed(deltas, targetDate) {
    const lines = deltas.map(({ name, items }) => {
      const names = items.map(s => {
        const clean = _cleanItemName(s).toUpperCase();
        return clean;
      });
      return `**${name}** unlocked skill${names.length > 1 ? 's' : ''}: **${names.join(', ')}**`;
    });

    const embed = new EmbedBuilder()
      .setAuthor({ name: '⚡ Skill Unlocked' })
      .setDescription(lines.join('\n'))
      .setColor(0x9b59b6)
      .setTimestamp();

    try {
      await this._sendFeedEmbed(embed, targetDate);
    } catch (err) {
      console.error(`[${this._label}] Failed to post skill feed to activity thread:`, err.message);
    }
  }

  async _postProfessionFeed(deltas, targetDate) {
    const lines = deltas.map(({ name, items }) => {
      const names = items.map(p => {
        // Try to resolve enum → friendly name
        if (typeof p === 'number') return PERK_INDEX_MAP[p] || `Profession #${p}`;
        if (typeof p === 'string') return PERK_MAP[p] || _cleanItemName(p);
        return String(p);
      });
      return `**${name}** unlocked profession${names.length > 1 ? 's' : ''}: **${names.join(', ')}**`;
    });

    const embed = new EmbedBuilder()
      .setAuthor({ name: '🎓 Profession Unlocked' })
      .setDescription(lines.join('\n'))
      .setColor(0xf1c40f)
      .setTimestamp();

    try {
      await this._sendFeedEmbed(embed, targetDate);
    } catch (err) {
      console.error(`[${this._label}] Failed to post profession feed to activity thread:`, err.message);
    }
  }

  async _postLoreFeed(deltas, targetDate) {
    const lines = deltas.map(({ name, items }) => {
      const count = items.length;
      const names = items.map(l => _cleanItemName(typeof l === 'object' ? (l.name || l.id || JSON.stringify(l)) : l)).filter(Boolean);
      const display = names.length > 0 && names.length <= 3 ? `: ${names.join(', ')}` : '';
      return `**${name}** discovered **${count} lore entr${count > 1 ? 'ies' : 'y'}**${display}`;
    });

    const embed = new EmbedBuilder()
      .setAuthor({ name: '📜 Lore Discovered' })
      .setDescription(lines.join('\n'))
      .setColor(0x8e44ad)
      .setTimestamp();

    try {
      await this._sendFeedEmbed(embed, targetDate);
    } catch (err) {
      console.error(`[${this._label}] Failed to post lore feed to activity thread:`, err.message);
    }
  }

  async _postUniqueFeed(deltas, targetDate) {
    const lines = deltas.map(({ name, type, items }) => {
      const names = items.map(u => _cleanItemName(typeof u === 'object' ? (u.name || u.id || JSON.stringify(u)) : u)).filter(Boolean);
      const display = names.length <= 5 ? names.join(', ') : `${names.slice(0, 5).join(', ')} +${names.length - 5} more`;
      return `**${name}** ${type} unique item${items.length > 1 ? 's' : ''}: **${display}**`;
    });

    const embed = new EmbedBuilder()
      .setAuthor({ name: '✨ Unique Item' })
      .setDescription(lines.join('\n'))
      .setColor(0xe74c3c)
      .setTimestamp();

    try {
      await this._sendFeedEmbed(embed, targetDate);
    } catch (err) {
      console.error(`[${this._label}] Failed to post unique feed to activity thread:`, err.message);
    }
  }

  async _postCompanionFeed(deltas, targetDate) {
    const lines = deltas.map(({ name, type, items }) => {
      const count = items.length;
      const emoji = type === 'horse' ? '🐴' : '🐕';
      const label = type === 'horse'
        ? `${count} horse${count > 1 ? 's' : ''}`
        : `${count} companion${count > 1 ? 's' : ''}`;
      return `${emoji} **${name}** tamed **${label}**`;
    });

    const embed = new EmbedBuilder()
      .setAuthor({ name: '🐾 Companion Tamed' })
      .setDescription(lines.join('\n'))
      .setColor(0x27ae60)
      .setTimestamp();

    try {
      await this._sendFeedEmbed(embed, targetDate);
    } catch (err) {
      console.error(`[${this._label}] Failed to post companion feed to activity thread:`, err.message);
    }
  }

  async _postChallengeFeed(deltas, targetDate) {
    const lines = deltas.flatMap(({ name, completed }) =>
      completed.map(c => `**${name}** completed **${c.name}** — *${c.desc}*`)
    );

    const embed = new EmbedBuilder()
      .setAuthor({ name: '🏆 Challenge Completed' })
      .setDescription(lines.join('\n'))
      .setColor(0xf39c12)
      .setTimestamp();

    try {
      await this._sendFeedEmbed(embed, targetDate);
    } catch (err) {
      console.error(`[${this._label}] Failed to post challenge feed to activity thread:`, err.message);
    }
  }

  async _detectWorldEvents(prev, current) {
    const lines = [];

    // Season change
    if (prev.currentSeason && current.currentSeason && prev.currentSeason !== current.currentSeason) {
      const seasonEmoji = { Spring: '🌱', Summer: '☀️', Autumn: '🍂', Winter: '❄️' };
      const emoji = seasonEmoji[current.currentSeason] || '🔄';
      lines.push(`${emoji} Season changed to **${current.currentSeason}**`);
    }

    // Day milestone (every 10 days)
    if (prev.daysPassed != null && current.daysPassed != null) {
      const prevDay = Math.floor(prev.daysPassed);
      const curDay = Math.floor(current.daysPassed);
      if (curDay > prevDay) {
        // Post milestone at every 10th day, or the first day change after bot start
        if (curDay % 10 === 0 || Math.floor(prevDay / 10) < Math.floor(curDay / 10)) {
          lines.push(`📅 **Day ${curDay}** reached`);
        }
      }
    }

    // Airdrop detected
    if (!prev.airdropActive && current.airdropActive) {
      lines.push('📦 **Airdrop incoming!**');
    }

    if (lines.length === 0) return;

    const embed = new EmbedBuilder()
      .setAuthor({ name: '🌍 World Event' })
      .setDescription(lines.join('\n'))
      .setColor(0x2c3e50)
      .setTimestamp();

    try {
      await this._sendFeedEmbed(embed);
    } catch (err) {
      console.error(`[${this._label}] Failed to post world event feed to activity thread:`, err.message);
    }
  }

  getAllTimeKills(steamId) {
    const record = this._killData.players[steamId];
    const save = this._saveData.get(steamId);
    if (!record && !save) return null;

    const allTime = PlayerStatsChannel._emptyKills();

    // ExtendedStats lifetime values (persist across deaths)
    if (save?.hasExtendedStats) {
      allTime.zeeksKilled    = save.lifetimeKills        || 0;
      allTime.headshots      = save.lifetimeHeadshots    || 0;
      allTime.meleeKills     = save.lifetimeMeleeKills   || 0;
      allTime.gunKills       = save.lifetimeGunKills     || 0;
      allTime.blastKills     = save.lifetimeBlastKills   || 0;
      allTime.fistKills      = save.lifetimeFistKills    || 0;
      allTime.takedownKills  = save.lifetimeTakedownKills || 0;
      allTime.vehicleKills   = save.lifetimeVehicleKills || 0;
      return allTime;
    }

    // Player was previously seen with ExtendedStats but is now offline — use cached lifetime values
    if (record?.hasExtendedStats && record.lifetimeSnapshot) {
      for (const k of PlayerStatsChannel.KILL_KEYS) {
        allTime[k] = record.lifetimeSnapshot[k] || 0;
      }
      return allTime;
    }

    // Fallback: cumulative (banked from deaths) + current save
    if (record) {
      for (const k of PlayerStatsChannel.KILL_KEYS) {
        allTime[k] += record.cumulative[k];
      }
    }
    if (save) {
      for (const k of PlayerStatsChannel.KILL_KEYS) {
        allTime[k] += (save[k] || 0);
      }
    }
    return allTime;
  }

  /**
   * Get current-life kills for a player.
   * For ExtendedStats players: lifetime - deathCheckpoint (most reliable).
   * Falls back to GameStats for legacy (non-ExtendedStats) players only.
   * Returns { zeeksKilled, headshots, ... } or null.
   */
  getCurrentLifeKills(steamId) {
    const record = this._killData.players[steamId];
    const save = this._saveData.get(steamId);
    if (!save) return null;

    // ExtendedStats: compute from lifetime - checkpoint (most reliable source;
    // GameStats writes infrequently and is often stale)
    if (save.hasExtendedStats && record?.deathCheckpoint) {
      const life = {};
      for (const k of PlayerStatsChannel.KILL_KEYS) {
        const lifetimeKey = PlayerStatsChannel.LIFETIME_KEY_MAP[k];
        const lifetime = lifetimeKey ? (save[lifetimeKey] || 0) : 0;
        life[k] = Math.max(0, lifetime - (record.deathCheckpoint[k] || 0));
      }
      return life;
    }

    // ExtendedStats, never died (or no checkpoint yet): all lifetime kills are current life
    if (save.hasExtendedStats) {
      const life = {};
      for (const k of PlayerStatsChannel.KILL_KEYS) {
        const lifetimeKey = PlayerStatsChannel.LIFETIME_KEY_MAP[k];
        life[k] = lifetimeKey ? (save[lifetimeKey] || 0) : 0;
      }
      return life;
    }

    // Player offline but was previously seen with ExtendedStats — use cached lifetime - checkpoint
    if (record?.hasExtendedStats && record.lifetimeSnapshot) {
      if (record.deathCheckpoint) {
        const life = {};
        for (const k of PlayerStatsChannel.KILL_KEYS) {
          life[k] = Math.max(0, (record.lifetimeSnapshot[k] || 0) - (record.deathCheckpoint[k] || 0));
        }
        return life;
      }
      // Never died — all lifetime kills are current life
      return { ...record.lifetimeSnapshot };
    }

    // Legacy: GameStats is the current-life value
    return PlayerStatsChannel._snapshotKills(save);
  }

  getAllTimeSurvival(steamId) {
    const record = this._killData.players[steamId];
    const save = this._saveData.get(steamId);
    if (!record && !save) return null;

    const allTime = PlayerStatsChannel._emptyObj(PlayerStatsChannel.SURVIVAL_KEYS);

    // ExtendedStats lifetime values (persist across deaths)
    if (save?.hasExtendedStats) {
      allTime.daysSurvived = save.lifetimeDaysSurvived || save.daysSurvived || 0;
      return allTime;
    }

    // Player was previously seen with ExtendedStats but is now offline — use cached lifetime values
    if (record?.hasExtendedStats && record.survivalLifetimeSnapshot) {
      allTime.daysSurvived = record.survivalLifetimeSnapshot.daysSurvived || 0;
      return allTime;
    }

    // Fallback: cumulative (banked from deaths) + current save
    if (record?.survivalCumulative) {
      for (const k of PlayerStatsChannel.SURVIVAL_KEYS) {
        allTime[k] += record.survivalCumulative[k];
      }
    }
    if (save) {
      for (const k of PlayerStatsChannel.SURVIVAL_KEYS) {
        allTime[k] += (save[k] || 0);
      }
    }
    return allTime;
  }

  _buildOverviewEmbed() {
    const serverTag = this._config.serverName ? ` — ${this._config.serverName}` : '';
    const embed = new EmbedBuilder()
      .setTitle(`Player Statistics${serverTag}`)
      .setColor(0x9b59b6)
      .setTimestamp()
      .setFooter({ text: 'Select a player below for full stats · Last updated' });

    // ── Merge all player data ──
    const allLog = this._playerStats.getAllPlayers();
    const allPlaytime = this._playtime.getLeaderboard();

    // Build merged roster — use _resolvePlayer() for consistent name + timestamp resolution
    const roster = new Map();
    const allIds = new Set([
      ...allLog.map(p => p.id),
      ...allPlaytime.map(p => p.id),
      ...this._saveData.keys(),
    ]);
    for (const id of allIds) {
      const resolved = this._resolvePlayer(id);
      roster.set(id, {
        name: resolved.name,
        log: resolved.log,
        save: resolved.save,
      });
    }

    const playerCount = roster.size;

    // Combined set of all known player IDs (save file + kill tracker)
    const allTrackedIds = new Set([
      ...this._saveData.keys(),
      ...Object.keys(this._killData.players || {}),
    ]);

    // ── Kill Leaderboard (all-time) ──
    if (allTrackedIds.size > 0) {
      const killers = [...allTrackedIds]
        .map(id => {
          const at = this.getAllTimeKills(id);
          return { id, name: roster.get(id)?.name || id, kills: at?.zeeksKilled || 0 };
        })
        .filter(e => e.kills > 0)
        .sort((a, b) => b.kills - a.kills);

      if (killers.length > 0) {
        const medals = ['🥇', '🥈', '🥉'];
        const lines = killers.slice(0, 5).map((e, i) => {
          const medal = medals[i] || `\`${i + 1}.\``;
          const at = this.getAllTimeKills(e.id);
          const detail = [];
          if (at.headshots > 0) detail.push(`${at.headshots} HS`);
          if (at.meleeKills > 0) detail.push(`${at.meleeKills} melee`);
          if (at.gunKills > 0) detail.push(`${at.gunKills} gun`);
          const extra = detail.length > 0 ? ` *(${detail.join(', ')})*` : '';
          return `${medal} **${e.name}** — ${e.kills} kills${extra}`;
        });
        embed.addFields({ name: 'Top Killers', value: lines.join('\n') });
      }

      // ── Server Kill Totals (code block grid) ──
      let totalKills = 0, totalHS = 0, totalMelee = 0, totalGun = 0;
      let totalDays = 0;
      for (const id of allTrackedIds) {
        const at = this.getAllTimeKills(id);
        if (at) {
          totalKills += at.zeeksKilled;
          totalHS += at.headshots;
          totalMelee += at.meleeKills;
          totalGun += at.gunKills;
        }
        const atSurv = this.getAllTimeSurvival(id);
        if (atSurv) totalDays += atSurv.daysSurvived;
      }
      const totals = [
        `Kills: **${totalKills}**  ·  Headshots: **${totalHS}**`,
        `Melee: **${totalMelee}**  ·  Ranged: **${totalGun}**`,
        `Days: **${totalDays}**  ·  Players: **${allTrackedIds.size}**`,
      ];
      embed.addFields({ name: 'Server Totals (All Time)', value: totals.join('\n') });
    }

    // ── Top Playtime ──
    const leaderboard = this._playtime.getLeaderboard();
    if (leaderboard.length > 0) {
      const medals = ['🥇', '🥈', '🥉'];
      const top5 = leaderboard.slice(0, 5).map((entry, i) => {
        const medal = medals[i] || `\`${i + 1}.\``;
        return `${medal} **${entry.name}** — ${entry.totalFormatted}`;
      });
      embed.addFields({ name: 'Top Playtime', value: top5.join('\n') });
    }

    // ── Activity Stats (from logs) ──
    if (allLog.length > 0) {
      const totalDeaths = allLog.reduce((s, p) => s + p.deaths, 0);
      const totalBuilds = allLog.reduce((s, p) => s + p.builds, 0);
      const totalLoots = allLog.reduce((s, p) => s + p.containersLooted, 0);
      const totalDmg = allLog.reduce((s, p) => s + Object.values(p.damageTaken).reduce((a, b) => a + b, 0), 0);
      const totalPvpKills = allLog.reduce((s, p) => s + (p.pvpKills || 0), 0);
      const parts = [`Deaths: **${totalDeaths}**`, `Builds: **${totalBuilds}**`, `Looted: **${totalLoots}**`, `Hits: **${totalDmg}**`];
      if (totalPvpKills > 0) parts.push(`PvP Kills: **${totalPvpKills}**`);
      if (this._config.showRaidStats) {
        const totalRaids = allLog.reduce((s, p) => s + p.raidsOut, 0);
        parts.push(`Raids: **${totalRaids}**`);
      }
      embed.addFields({ name: 'Log Activity', value: parts.join('  ·  ') });
    }

    // ── Last 10 PvP Kills ──
    if (this._config.showPvpKills && this._logWatcher) {
      const recentKills = this._logWatcher.getPvpKills(10);
      if (recentKills.length > 0) {
        const killLines = recentKills.slice().reverse().map(k => {
          const ts = new Date(k.timestamp);
          const timeStr = ts.toLocaleDateString('en-GB', { timeZone: this._config.botTimezone, day: 'numeric', month: 'short' }) +
            ' ' + ts.toLocaleTimeString('en-GB', { timeZone: this._config.botTimezone, hour: '2-digit', minute: '2-digit' });
          return `**${k.killer}** killed **${k.victim}** — ${timeStr}`;
        });
        embed.addFields({ name: 'Recent PvP Kills', value: killLines.join('\n') });
      }
    }

    // ── Survival Leaderboard (all-time from tracker) ──
    if (allTrackedIds.size > 0) {
      const survivors = [...allTrackedIds]
        .map(id => {
          const atSurv = this.getAllTimeSurvival(id);
          return { id, name: roster.get(id)?.name || id, days: atSurv?.daysSurvived || 0 };
        })
        .filter(e => e.days > 0)
        .sort((a, b) => b.days - a.days);

      if (survivors.length > 0) {
        const medals = ['🥇', '🥈', '🥉'];
        const lines = survivors.slice(0, 5).map((e, i) => {
          const medal = medals[i] || `\`${i + 1}.\``;
          return `${medal} **${e.name}** — ${e.days} days`;
        });
        embed.addFields({ name: 'Longest Survivors', value: lines.join('\n') });
      }
    }

    // ── Most Bitten Leaderboard (from save data) ──
    if (this._config.showMostBitten && this._saveData.size > 0) {
      const bitten = [...this._saveData.entries()]
        .map(([id, save]) => ({ id, name: roster.get(id)?.name || id, count: save.timesBitten || 0 }))
        .filter(e => e.count > 0)
        .sort((a, b) => b.count - a.count);

      if (bitten.length > 0) {
        const medals = ['🥇', '🥈', '🥉'];
        const lines = bitten.slice(0, 5).map((e, i) => {
          const medal = medals[i] || `\`${i + 1}.\``;
          return `${medal} **${e.name}** — ${e.count} bites`;
        });
        embed.addFields({ name: 'Most Bitten', value: lines.join('\n') });
      }
    }

    // ── Most Fish Caught Leaderboard (from save data) ──
    if (this._config.showMostFish && this._saveData.size > 0) {
      const fishers = [...this._saveData.entries()]
        .map(([id, save]) => {
          const pike = save.fishCaughtPike || 0;
          return { id, name: roster.get(id)?.name || id, count: save.fishCaught || 0, pike };
        })
        .filter(e => e.count > 0)
        .sort((a, b) => b.count - a.count);

      if (fishers.length > 0) {
        const medals = ['🥇', '🥈', '🥉'];
        const lines = fishers.slice(0, 5).map((e, i) => {
          const medal = medals[i] || `\`${i + 1}.\``;
          const pikeStr = e.pike > 0 ? ` (${e.pike} pike)` : '';
          return `${medal} **${e.name}** — ${e.count} fish${pikeStr}`;
        });
        embed.addFields({ name: 'Most Fish Caught', value: lines.join('\n') });
      }
    }

    // ── Top PvP Killers (all-time, from logs) ──
    if (this._config.showPvpKills && allLog.length > 0) {
      const pvpKillers = allLog
        .filter(p => (p.pvpKills || 0) > 0)
        .map(p => ({ name: roster.get(p.id)?.name || p.id, kills: p.pvpKills }))
        .sort((a, b) => b.kills - a.kills);

      if (pvpKillers.length > 0) {
        const medals = ['🥇', '🥈', '🥉'];
        const lines = pvpKillers.slice(0, 5).map((e, i) => {
          const medal = medals[i] || `\`${i + 1}.\``;
          return `${medal} **${e.name}** — ${e.kills} kills`;
        });
        embed.addFields({ name: 'Top PvP Killers', value: lines.join('\n') });
      }
    }

    // ── Weekly Leaderboards ──
    const w = this._weeklyStats;
    if (w) {
      const weekLabel = w.weekStart
        ? `Since ${new Date(w.weekStart).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: this._config.botTimezone })}`
        : 'This Week';
      const weeklyParts = [];

      if (w.topKillers?.length > 0) {
        const medals = ['🥇', '🥈', '🥉'];
        const lines = w.topKillers.slice(0, 3).map((e, i) => {
          const medal = medals[i] || `\`${i + 1}.\``;
          return `${medal} **${e.name}** — ${e.kills}`;
        });
        weeklyParts.push({ name: `Zombie Kills · ${weekLabel}`, value: lines.join('\n'), inline: true });
      }

      if (w.topPvpKillers?.length > 0) {
        const medals = ['🥇', '🥈', '🥉'];
        const lines = w.topPvpKillers.slice(0, 3).map((e, i) => {
          const medal = medals[i] || `\`${i + 1}.\``;
          return `${medal} **${e.name}** — ${e.kills}`;
        });
        weeklyParts.push({ name: `PvP Kills · ${weekLabel}`, value: lines.join('\n'), inline: true });
      }

      if (w.topPlaytime?.length > 0) {
        const medals = ['🥇', '🥈', '🥉'];
        const fmtMs = (ms) => {
          const h = Math.floor(ms / 3600000);
          const m = Math.floor((ms % 3600000) / 60000);
          return h > 0 ? `${h}h ${m}m` : `${m}m`;
        };
        const lines = w.topPlaytime.slice(0, 3).map((e, i) => {
          const medal = medals[i] || `\`${i + 1}.\``;
          return `${medal} **${e.name}** — ${fmtMs(e.ms)}`;
        });
        weeklyParts.push({ name: `Playtime · ${weekLabel}`, value: lines.join('\n'), inline: true });
      }

      if (w.topFishers?.length > 0) {
        const medals = ['🥇', '🥈', '🥉'];
        const lines = w.topFishers.slice(0, 3).map((e, i) => {
          const medal = medals[i] || `\`${i + 1}.\``;
          return `${medal} **${e.name}** — ${e.count}`;
        });
        weeklyParts.push({ name: `Fish Caught · ${weekLabel}`, value: lines.join('\n'), inline: true });
      }

      if (w.topBitten?.length > 0) {
        const medals = ['🥇', '🥈', '🥉'];
        const lines = w.topBitten.slice(0, 3).map((e, i) => {
          const medal = medals[i] || `\`${i + 1}.\``;
          return `${medal} **${e.name}** — ${e.count}`;
        });
        weeklyParts.push({ name: `Most Bitten · ${weekLabel}`, value: lines.join('\n'), inline: true });
      }

      if (weeklyParts.length > 0) {
        // Add a separator then the weekly inline fields
        embed.addFields({ name: '\u200b', value: '**── This Week ──**' });
        embed.addFields(weeklyParts);
      }
    }

    // ── Server Info ──
    const peaks = this._playtime.getPeaks();
    const trackingSince = new Date(this._playtime.getTrackingSince()).toLocaleDateString('en-GB', { timeZone: this._config.botTimezone });

    embed.addFields(
      { name: "Today's Peak", value: `${peaks.todayPeak} online · ${peaks.uniqueToday} unique`, inline: true },
      { name: 'Peak Online', value: `${peaks.allTimePeak}`, inline: true },
      { name: 'Total Players', value: `${playerCount}`, inline: true },
    );

    const updateNote = this._lastSaveUpdate
      ? `Save data: ${this._lastSaveUpdate.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: this._config.botTimezone })}`
      : 'Save data: loading...';
    embed.setFooter({ text: `${updateNote} · Tracking since ${trackingSince} · Last updated` });

    return embed;
  }

  _buildPlayerRow() {
    const merged = new Map();

    // Add from player-stats (use resolver for consistent names)
    for (const p of this._playerStats.getAllPlayers()) {
      const resolved = this._resolvePlayer(p.id);
      const at = this.getAllTimeKills(p.id);
      const atSurv = this.getAllTimeSurvival(p.id);
      merged.set(p.id, {
        name: resolved.name,
        kills: at?.zeeksKilled || 0,
        deaths: p.deaths,
        days: atSurv?.daysSurvived || 0,
      });
    }

    // Add from playtime + save data (catch players not in player-stats)
    const extraIds = new Set([
      ...this._playtime.getLeaderboard().map(p => p.id),
      ...this._saveData.keys(),
    ]);
    for (const id of extraIds) {
      if (merged.has(id)) continue;
      const resolved = this._resolvePlayer(id);
      const at = this.getAllTimeKills(id);
      const atSurv = this.getAllTimeSurvival(id);
      const save = this._saveData.get(id);
      merged.set(id, {
        name: resolved.name,
        kills: at?.zeeksKilled || save?.zeeksKilled || 0,
        deaths: resolved.log?.deaths || 0,
        days: atSurv?.daysSurvived || save?.daysSurvived || 0,
      });
    }

    if (merged.size === 0) return [];

    // Sort by kills desc, then days, then name
    const sorted = [...merged.entries()].sort((a, b) => {
      if (b[1].kills !== a[1].kills) return b[1].kills - a[1].kills;
      if (b[1].days !== a[1].days) return b[1].days - a[1].days;
      return a[1].name.localeCompare(b[1].name);
    });

    const options = sorted.slice(0, 25).map(([id, p]) => ({
      label: p.name.substring(0, 100),
      description: `Kills: ${p.kills} | Deaths: ${p.deaths} | Days: ${p.days}`,
      value: id,
    }));

    const idSuffix = this._serverId ? `:${this._serverId}` : '';
    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId(`playerstats_player_select${idSuffix}`)
      .setPlaceholder('Select a player to view full stats...')
      .addOptions(options);

    return [new ActionRowBuilder().addComponents(selectMenu)];
  }

  _buildClanRow() {
    if (this._clanData.length === 0) return [];

    const options = this._clanData.map(clan => {
      // Aggregate kills and days for the description
      let totalKills = 0, totalDays = 0;
      for (const m of clan.members) {
        const at = this.getAllTimeKills(m.steamId);
        const atSurv = this.getAllTimeSurvival(m.steamId);
        totalKills += at?.zeeksKilled || 0;
        totalDays += atSurv?.daysSurvived || 0;
      }
      return {
        label: clan.name.substring(0, 100),
        description: `${clan.members.length} members · ${totalKills} kills · ${totalDays} days`,
        value: `clan:${clan.name}`,
      };
    });

    const idSuffix = this._serverId ? `:${this._serverId}` : '';
    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId(`playerstats_clan_select${idSuffix}`)
      .setPlaceholder('Select a clan to view group stats...')
      .addOptions(options.slice(0, 25));

    return [new ActionRowBuilder().addComponents(selectMenu)];
  }

  buildClanEmbed(clanName, { isAdmin = false } = {}) {
    const clan = this._clanData.find(c => c.name === clanName);
    if (!clan) {
      return new EmbedBuilder()
        .setDescription('Clan not found.')
        .setColor(0xe74c3c);
    }

    const serverTag = this._config.serverName ? ` [${this._config.serverName}]` : '';
    const embed = new EmbedBuilder()
      .setTitle(`${clan.name}${serverTag}`)
      .setColor(0xe67e22)
      .setTimestamp();

    // ── Aggregate stats from save data (all-time) ──
    let totalKills = 0, totalHS = 0, totalMelee = 0, totalGun = 0;
    let totalDays = 0;
    let membersWithSave = 0;

    for (const m of clan.members) {
      const at = this.getAllTimeKills(m.steamId);
      const atSurv = this.getAllTimeSurvival(m.steamId);
      if (at) {
        membersWithSave++;
        totalKills += at.zeeksKilled;
        totalHS += at.headshots;
        totalMelee += at.meleeKills;
        totalGun += at.gunKills;
      } else {
        const save = this._saveData.get(m.steamId);
        if (save) {
          membersWithSave++;
          totalKills += save.zeeksKilled;
          totalHS += save.headshots;
          totalMelee += save.meleeKills;
          totalGun += save.gunKills;
        }
      }
      if (atSurv) {
        totalDays += atSurv.daysSurvived;
      } else {
        const save = this._saveData.get(m.steamId);
        if (save) {
          totalDays += save.daysSurvived;
        }
      }
    }

    // ── Aggregate stats from logs ──
    let totalDeaths = 0, totalBuilds = 0, totalLoots = 0, totalDmg = 0;
    let totalRaidsOut = 0, totalRaidsIn = 0;
    let totalPlaytimeMs = 0;

    for (const m of clan.members) {
      const log = this._playerStats.getStats(m.steamId);
      if (log) {
        totalDeaths += log.deaths;
        totalBuilds += log.builds;
        totalLoots += log.containersLooted;
        totalDmg += Object.values(log.damageTaken).reduce((a, b) => a + b, 0);
        totalRaidsOut += log.raidsOut;
        totalRaidsIn += log.raidsIn;
      }
      const pt = this._playtime.getPlaytime(m.steamId);
      if (pt) totalPlaytimeMs += pt.totalMs;
    }

    // ── Overview line ──
    const ptHours = Math.floor(totalPlaytimeMs / 3600000);
    const ptMins = Math.floor((totalPlaytimeMs % 3600000) / 60000);
    const ptStr = ptHours > 0 ? `${ptHours}h ${ptMins}m` : `${ptMins}m`;
    embed.setDescription(`**${clan.members.length}** members · **${ptStr}** combined playtime`);

    // ── Kill Stats ──
    if (totalKills > 0) {
      const parts = [`Kills: **${totalKills}**`, `Headshots: **${totalHS}**`, `Melee: **${totalMelee}**`, `Ranged: **${totalGun}**`];
      embed.addFields({ name: 'Kill Stats', value: parts.join('  ·  ') });
    }

    // ── Survival ──
    const survParts = [];
    if (totalDays > 0) survParts.push(`Days: **${totalDays}**`);
    if (totalDeaths > 0) survParts.push(`Deaths: **${totalDeaths}**`);
    if (survParts.length > 0) embed.addFields({ name: 'Survival', value: survParts.join('  ·  '), inline: true });

    // ── Activity ──
    const actParts = [];
    if (totalBuilds > 0) actParts.push(`Builds: **${totalBuilds}**`);
    if (totalLoots > 0) actParts.push(`Looted: **${totalLoots}**`);
    if (totalDmg > 0) actParts.push(`Hits: **${totalDmg}**`);
    if (this._config.canShow('showRaidStats', isAdmin)) {
      if (totalRaidsOut > 0) actParts.push(`Raids Out: **${totalRaidsOut}**`);
      if (totalRaidsIn > 0) actParts.push(`Raided: **${totalRaidsIn}**`);
    }
    if (actParts.length > 0) embed.addFields({ name: 'Activity', value: actParts.join('  ·  '), inline: true });

    // ── Member List with individual stats ──
    const memberLines = clan.members.map(m => {
      const save = this._saveData.get(m.steamId);
      const at = this.getAllTimeKills(m.steamId);
      const pt = this._playtime.getPlaytime(m.steamId);
      const log = this._playerStats.getStats(m.steamId);

      const displayName = m.name;

      const parts = [];
      const kills = at?.zeeksKilled || save?.zeeksKilled || 0;
      if (kills > 0) parts.push(`${kills} kills`);
      const atSurv = this.getAllTimeSurvival(m.steamId);
      const days = atSurv?.daysSurvived || save?.daysSurvived || 0;
      if (days > 0) parts.push(`${days}d`);
      if (log && log.deaths > 0) parts.push(`${log.deaths} deaths`);
      if (pt) parts.push(pt.totalFormatted);

      const rankIcon = m.rank === 'Leader' ? '[Leader] ' : '';
      const stats = parts.length > 0 ? ` — ${parts.join(' · ')}` : '';
      return `${rankIcon}**${displayName}**${stats}`;
    });

    embed.addFields({ name: 'Members', value: memberLines.join('\n') || 'No members' });

    return embed;
  }

  buildFullPlayerEmbed(steamId, { isAdmin = false } = {}) {
    const resolved = this._resolvePlayer(steamId);
    const logData = resolved.log;
    const saveData = resolved.save;
    const pt = resolved.playtime;

    // Pick a random loading tip for the footer
    const tips = gameData.LOADING_TIPS.filter(t => t.length > 20 && t.length < 120);
    const tip = tips.length > 0 ? tips[Math.floor(Math.random() * tips.length)] : null;

    const serverTag = this._config.serverName ? ` [${this._config.serverName}]` : '';
    const embed = new EmbedBuilder()
      .setTitle(`${resolved.name}${serverTag}`)
      .setColor(0x9b59b6)
      .setTimestamp()
      .setFooter({ text: tip ? `Tip: ${tip}` : 'HumanitZ Player Stats' });

    // ── Character Info ──
    if (saveData || pt) {
      const lines = [];
      if (saveData) {
        const gender = saveData.male ? 'Male' : 'Female';
        if (saveData.startingPerk && saveData.startingPerk !== 'Unknown') {
          const profDetails = gameData.PROFESSION_DETAILS[saveData.startingPerk];
          lines.push(`**${saveData.startingPerk}** · ${gender}`);
          if (profDetails) lines.push(`> *${profDetails.perk}*`);
        } else {
          lines.push(gender);
        }
        // Unlocked professions
        if (saveData.unlockedProfessions?.length > 1) {
          const profNames = saveData.unlockedProfessions
            .filter(p => typeof p === 'string')
            .map(p => PERK_MAP[p] || _cleanItemName(p))
            .filter(Boolean);
          if (profNames.length > 0) lines.push(`Unlocked: ${profNames.join(', ')}`);
        }
        // Affliction
        if (typeof saveData.affliction === 'number' && saveData.affliction > 0 && saveData.affliction < gameData.AFFLICTION_MAP.length) {
          lines.push(`**Affliction:** ${gameData.AFFLICTION_MAP[saveData.affliction]}`);
        }
      }
      if (pt) lines.push(`**Playtime:** ${pt.totalFormatted}  ·  **Sessions:** ${pt.sessions}`);
      if (resolved.firstSeen) {
        const fs = new Date(resolved.firstSeen);
        lines.push(`**First Seen:** ${fs.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: this._config.botTimezone })}`);
      }
      if (lines.length > 0) embed.addFields({ name: 'Character', value: lines.join('\n') });
    }

    // ── Name History ──
    if (logData?.nameHistory && logData.nameHistory.length > 0) {
      embed.addFields({ name: 'Previous Names', value: logData.nameHistory.map(h => h.name).join(', ') });
    }

    // ── Kill Stats ──
    if (saveData) {
      const at = this.getAllTimeKills(steamId);
      const cl = this.getCurrentLifeKills(steamId);
      const types = [
        ['Zombie Kills', 'zeeksKilled'],
        ['Headshots',    'headshots'],
        ['Melee',     'meleeKills'],
        ['Ranged',    'gunKills'],
        ['Blast',     'blastKills'],
        ['Unarmed',   'fistKills'],
        ['Takedowns', 'takedownKills'],
        ['Vehicle',   'vehicleKills'],
      ];
      const rows = [];
      const hasExt = saveData.hasExtendedStats;
      let hasDiff = false;
      for (const [, key] of types) {
        if ((cl?.[key] || 0) !== (at?.[key] || 0)) { hasDiff = true; break; }
      }
      for (const [label, key] of types) {
        const all = at?.[key] || 0;
        const life = cl?.[key] || 0;
        if (all > 0 || life > 0) {
          if (hasExt && hasDiff && life > 0) {
            rows.push(`${label}: **${all}** (Life: **${life}**)`);
          } else {
            rows.push(`${label}: **${all}**`);
          }
        }
      }
      if (rows.length > 0) {
        embed.addFields({ name: 'Kills', value: rows.join('\n') });
      } else {
        embed.addFields({ name: 'Kills', value: '*No kills yet*' });
      }
    }

    // ── Survival & PvP (inline pair) ──
    {
      const survLines = [];
      if (saveData?.daysSurvived > 0) survLines.push(`**Days:** ${saveData.daysSurvived}`);
      if (saveData) {
        const atSurv = this.getAllTimeSurvival(steamId);
        if (atSurv?.daysSurvived > saveData.daysSurvived) survLines.push(`**All-Time:** ${atSurv.daysSurvived} days`);
      }
      if (logData) survLines.push(`**Deaths:** ${logData.deaths}`);
      // Bites & Fish
      if (saveData?.timesBitten > 0) survLines.push(`**Bitten:** ${saveData.timesBitten} times`);
      if (saveData?.fishCaught > 0) {
        let fishStr = `**Fish Caught:** ${saveData.fishCaught}`;
        if (saveData.fishCaughtPike > 0) fishStr += ` (${saveData.fishCaughtPike} pike)`;
        survLines.push(fishStr);
      }
      if (survLines.length > 0) embed.addFields({ name: 'Survival', value: survLines.join('\n'), inline: true });
    }

    // ── PvP Stats ──
    if (logData && ((logData.pvpKills || 0) > 0 || (logData.pvpDeaths || 0) > 0)) {
      const pvpParts = [];
      if (logData.pvpKills > 0) pvpParts.push(`**Kills:** ${logData.pvpKills}`);
      if (logData.pvpDeaths > 0) pvpParts.push(`**Deaths:** ${logData.pvpDeaths}`);
      const kd = logData.pvpDeaths > 0 ? (logData.pvpKills / logData.pvpDeaths).toFixed(2) : logData.pvpKills > 0 ? '∞' : '0';
      pvpParts.push(`**K/D:** ${kd}`);
      embed.addFields({ name: 'PvP', value: pvpParts.join('\n'), inline: true });
    }

    // ── Vitals ──
    if (this._config.canShow('showVitals', isAdmin) && saveData) {
      const pct = (v) => `**${Math.round(Math.max(0, Math.min(100, v)))}%**`;
      const row1 = [];
      const row2 = [];
      if (this._config.showHealth)   row1.push(`Health: ${pct(saveData.health)}`);
      if (this._config.showHunger)   row1.push(`Hunger: ${pct(saveData.hunger)}`);
      if (this._config.showThirst)   row1.push(`Thirst: ${pct(saveData.thirst)}`);
      if (this._config.showStamina)  row2.push(`Stamina: ${pct(saveData.stamina)}`);
      if (this._config.showImmunity) row2.push(`Immunity: ${pct(saveData.infection)}`);
      if (this._config.showBattery)  row2.push(`Battery: ${pct(saveData.battery)}`);
      const vitals = [row1.join('  ·  '), row2.join('  ·  ')].filter(Boolean);
      if (vitals.length > 0) embed.addFields({ name: 'Vitals', value: vitals.join('\n') });
    }

    // ── Status Effects ──
    if (this._config.canShow('showStatusEffects', isAdmin) && saveData) {
      const statuses = [];
      if (this._config.showPlayerStates && saveData.playerStates?.length > 0) {
        for (const s of saveData.playerStates) {
          if (typeof s !== 'string') continue;
          statuses.push(s.replace('States.Player.', ''));
        }
      }
      if (this._config.showBodyConditions && saveData.bodyConditions?.length > 0) {
        for (const s of saveData.bodyConditions) {
          if (typeof s !== 'string') continue;
          statuses.push(s.replace('Attributes.Health.', ''));
        }
      }
      if (this._config.showInfectionBuildup && saveData.infectionBuildup > 0) statuses.push(`Infection: ${saveData.infectionBuildup}%`);
      if (this._config.showFatigue && saveData.fatigue > 0.5) statuses.push('Fatigued');
      if (statuses.length > 0) embed.addFields({ name: 'Status Effects', value: statuses.join(', ') });
    }

    // ── Damage Taken ──
    if (logData) {
      const dmgEntries = Object.entries(logData.damageTaken);
      const dmgTotal = dmgEntries.reduce((s, [, c]) => s + c, 0);
      if (dmgTotal > 0) {
        const dmgSorted = dmgEntries.sort((a, b) => b[1] - a[1]);
        const dmgLines = dmgSorted.slice(0, 6).map(([src, count]) => `${src}: **${count}**`);
        if (dmgEntries.length > 6) dmgLines.push(`_+${dmgEntries.length - 6} more_`);
        embed.addFields({ name: `Damage Taken (${dmgTotal} hits)`, value: dmgLines.join('\n'), inline: true });
      }
    }

    // ── Building ──
    if (logData && logData.builds > 0) {
      const buildEntries = Object.entries(logData.buildItems);
      if (buildEntries.length > 0) {
        const topBuilds = buildEntries.sort((a, b) => b[1] - a[1]).slice(0, 6);
        const buildLines = topBuilds.map(([item, count]) => `${item}: **${count}**`);
        if (buildEntries.length > 6) buildLines.push(`_+${buildEntries.length - 6} more_`);
        embed.addFields({ name: `Building (${logData.builds} placed)`, value: buildLines.join('\n'), inline: true });
      }
    }

    // ── Raid Stats ──
    if (this._config.canShow('showRaidStats', isAdmin) && logData) {
      const raidParts = [];
      if (this._config.showRaidsOut && logData.raidsOut > 0) raidParts.push(`Attacked: **${logData.raidsOut}**`);
      if (this._config.showRaidsOut && logData.destroyedOut > 0) raidParts.push(`Destroyed: **${logData.destroyedOut}**`);
      if (this._config.showRaidsIn && logData.raidsIn > 0) raidParts.push(`Raided: **${logData.raidsIn}**`);
      if (this._config.showRaidsIn && logData.destroyedIn > 0) raidParts.push(`Lost: **${logData.destroyedIn}**`);
      if (raidParts.length > 0) embed.addFields({ name: 'Raids', value: raidParts.join('  ·  '), inline: true });
    }

    // ── Looting ──
    if (logData && logData.containersLooted > 0) {
      embed.addFields({ name: 'Looted', value: `**${logData.containersLooted}** containers`, inline: true });
    }

    // ── Inventory (inline grid) ──
    if (this._config.canShow('showInventory', isAdmin) && saveData) {
      const notEmpty = (i) => i.item && !/^empty$/i.test(i.item) && !/^empty$/i.test(_cleanItemName(i.item));
      const fmt = (i) => {
        const amt = i.amount > 1 ? ` x${i.amount}` : '';
        const dur = i.durability > 0 ? ` (${i.durability}%)` : '';
        return `${_cleanItemName(i.item)}${amt}${dur}`;
      };

      const equip = saveData.equipment.filter(notEmpty);
      const quick = saveData.quickSlots.filter(notEmpty);
      const bpItems = (saveData.backpackItems || []).filter(notEmpty);
      const pockets = saveData.inventory.filter(notEmpty);

      // If player has backpack items, note backpack is equipped in equipment section
      const equipLines = equip.map(fmt);
      if (bpItems.length > 0 && !equip.some(i => /backpack/i.test(i.item))) {
        equipLines.push('Backpack');
      }

      if (this._config.showEquipment && equipLines.length > 0) embed.addFields({ name: `Equipment (${equipLines.length})`, value: equipLines.join('\n').substring(0, 1024), inline: true });
      if (this._config.showQuickSlots && quick.length > 0) embed.addFields({ name: `Quick Slots (${quick.length})`, value: quick.map(fmt).join('\n').substring(0, 1024), inline: true });
      if (this._config.showPockets && pockets.length > 0) embed.addFields({ name: `Pockets (${pockets.length})`, value: pockets.map(fmt).join('\n').substring(0, 1024), inline: true });
      if (this._config.showBackpack && bpItems.length > 0) embed.addFields({ name: `Backpack (${bpItems.length})`, value: bpItems.map(fmt).join('\n').substring(0, 1024), inline: true });
    }

    // ── Recipes ──
    if (this._config.canShow('showRecipes', isAdmin) && saveData) {
      const recipeParts = [];
      if (this._config.showCraftingRecipes && saveData.craftingRecipes.length > 0) recipeParts.push(`**Crafting:** ${saveData.craftingRecipes.map(_cleanItemName).join(', ')}`);
      if (this._config.showBuildingRecipes && saveData.buildingRecipes.length > 0) recipeParts.push(`**Building:** ${saveData.buildingRecipes.map(_cleanItemName).join(', ')}`);
      if (recipeParts.length > 0) embed.addFields({ name: 'Recipes', value: recipeParts.join('\n').substring(0, 1024) });
    }

    // ── Lore ──
    if (this._config.canShow('showLore', isAdmin) && saveData && saveData.lore.length > 0) {
      embed.addFields({ name: 'Lore', value: `${saveData.lore.length} entries collected`, inline: true });
    }

    // ── Unlocked Skills ──
    if (saveData && saveData.unlockedSkills && saveData.unlockedSkills.length > 0) {
      const skillLines = saveData.unlockedSkills.filter(s => typeof s === 'string').map(s => {
        const clean = s.replace(/^skills\./i, '').replace(/([a-z])([A-Z])/g, '$1 $2').toUpperCase();
        const effect = gameData.SKILL_EFFECTS[clean];
        return effect ? `**${clean}** — ${effect}` : `**${clean}**`;
      });
      if (skillLines.length > 0) embed.addFields({ name: 'Skills', value: skillLines.join('\n').substring(0, 1024) });
    }

    // ── Challenge Progress ──
    if (saveData && saveData.hasExtendedStats) {
      const challengeEntries = [
        ['challengeKillZombies',        saveData.challengeKillZombies],
        ['challengeKill50',             saveData.challengeKill50],
        ['challengeCatch20Fish',        saveData.challengeCatch20Fish],
        ['challengeRegularAngler',      saveData.challengeRegularAngler],
        ['challengeKillZombieBear',     saveData.challengeKillZombieBear],
        ['challenge9Squares',           saveData.challenge9Squares],
        ['challengeCraftFirearm',       saveData.challengeCraftFirearm],
        ['challengeCraftFurnace',       saveData.challengeCraftFurnace],
        ['challengeCraftMeleeBench',    saveData.challengeCraftMeleeBench],
        ['challengeCraftMeleeWeapon',   saveData.challengeCraftMeleeWeapon],
        ['challengeCraftRainCollector', saveData.challengeCraftRainCollector],
        ['challengeCraftTablesaw',      saveData.challengeCraftTablesaw],
        ['challengeCraftTreatment',     saveData.challengeCraftTreatment],
        ['challengeCraftWeaponsBench',  saveData.challengeCraftWeaponsBench],
        ['challengeCraftWorkbench',     saveData.challengeCraftWorkbench],
        ['challengeFindDog',            saveData.challengeFindDog],
        ['challengeFindHeli',           saveData.challengeFindHeli],
        ['challengeLockpickSUV',        saveData.challengeLockpickSUV],
        ['challengeRepairRadio',        saveData.challengeRepairRadio],
      ].filter(([, val]) => val > 0);

      if (challengeEntries.length > 0) {
        const descs = gameData.CHALLENGE_DESCRIPTIONS;
        const lines = challengeEntries.map(([key, val]) => {
          const info = descs[key];
          if (info) {
            const target = info.target ? `/${info.target}` : '';
            const desc = this._config.canShow('showChallengeDescriptions', isAdmin) ? ` — *${info.desc}*` : '';
            return `**${info.name}**: ${val}${target}${desc}`;
          }
          return `**${key}**: ${val}`;
        });
        embed.addFields({ name: `Challenges (${challengeEntries.length}/19)`, value: lines.join('\n').substring(0, 1024) });
      }
    }

    // ── Unique Items ──
    if (saveData) {
      const uniques = [];
      const foundItems = (saveData.lootItemUnique || []).map(_cleanItemName).filter(n => n.length > 0);
      const craftedItems = (saveData.craftedUniques || []).map(_cleanItemName).filter(n => n.length > 0);
      if (foundItems.length > 0) uniques.push(`**Found:** ${foundItems.join(', ')}`);
      if (craftedItems.length > 0) uniques.push(`**Crafted:** ${craftedItems.join(', ')}`);
      if (uniques.length > 0) embed.addFields({ name: 'Unique Items', value: uniques.join('\n').substring(0, 1024) });
    }

    // ── Connections ──
    if (this._config.canShow('showConnections', isAdmin) && logData) {
      const connParts = [];
      if (this._config.showConnectCount && logData.connects > 0) connParts.push(`In: **${logData.connects}**`);
      if (this._config.showConnectCount && logData.disconnects > 0) connParts.push(`Out: **${logData.disconnects}**`);
      if (this._config.showAdminAccess && logData.adminAccess > 0) connParts.push(`Admin: **${logData.adminAccess}**`);
      if (connParts.length > 0) embed.addFields({ name: 'Connections', value: connParts.join('  ·  '), inline: true });
    }

    // ── Last Activity ──
    if (resolved.lastActive) {
      const lastDate = new Date(resolved.lastActive);
      const dateStr = `${lastDate.toLocaleDateString('en-GB')} ${lastDate.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
      embed.addFields({ name: 'Last Active', value: dateStr, inline: true });
    }

    // ── Coordinates ──
    if (this._config.canShow('showCoordinates', isAdmin) && saveData && saveData.x !== null && saveData.x !== 0) {
      const dir = saveData.rotationYaw !== null
        ? ` | Facing: ${saveData.rotationYaw}°`
        : '';
      embed.addFields({ name: '📍 Location', value: `X: **${Math.round(saveData.x)}** · Y: **${Math.round(saveData.y)}** · Z: **${Math.round(saveData.z)}**${dir}`, inline: true });
    }

    // ── Anti-Cheat Flags (admin only) ──
    if (isAdmin && logData?.cheatFlags && logData.cheatFlags.length > 0) {
      const flagLines = logData.cheatFlags.slice(-5).map(f => {
        const d = new Date(f.timestamp);
        const dateStr = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
        return `${dateStr} — \`${f.type}\``;
      });
      if (logData.cheatFlags.length > 5) flagLines.unshift(`_Showing last 5 of ${logData.cheatFlags.length} flags_`);
      embed.addFields({ name: 'Anti-Cheat Flags', value: flagLines.join('\n') });
    }

    return embed;
  }

  getSaveData() { return this._saveData; }

  getClanData() { return this._clanData; }

  getServerSettings() { return this._serverSettings; }
}

function _parseIni(text) {
  const result = {};
  let section = '';
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) continue;
    const secMatch = trimmed.match(/^\[(.+)\]$/);
    if (secMatch) { section = secMatch[1]; continue; }
    const kvMatch = trimmed.match(/^([^=]+?)=(.*)$/);
    if (kvMatch) {
      const key = kvMatch[1].trim();
      const val = kvMatch[2].trim();
      // Store with section prefix for disambiguation if needed
      result[key] = val;
    }
  }
  return result;
}

function _cleanItemName(name) {
  if (!name) return '';
  if (typeof name !== 'string') name = String(name);
  return name
    .replace(/([a-z])([A-Z])/g, '$1 $2')           // camelCase → words
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')     // ABCDef → ABC Def
    .replace(/^BP_|_C$/g, '')                        // strip UE prefixes
    .replace(/_/g, ' ')
    .replace(/Lv(\d)/, 'Lvl $1')
    .trim();
}

/** Map UDS (Ultra Dynamic Sky) weather enum values to human-readable names */
const UDS_WEATHER_MAP = {
  'UDS_WeatherTypes::NewEnumerator0': 'Clear Skies',
  'UDS_WeatherTypes::NewEnumerator1': 'Partly Cloudy',
  'UDS_WeatherTypes::NewEnumerator2': 'Cloudy',
  'UDS_WeatherTypes::NewEnumerator3': 'Overcast',
  'UDS_WeatherTypes::NewEnumerator4': 'Foggy',
  'UDS_WeatherTypes::NewEnumerator5': 'Light Rain',
  'UDS_WeatherTypes::NewEnumerator6': 'Rain',
  'UDS_WeatherTypes::NewEnumerator7': 'Thunderstorm',
  'UDS_WeatherTypes::NewEnumerator8': 'Light Snow',
  'UDS_WeatherTypes::NewEnumerator9': 'Snow',
  'UDS_WeatherTypes::NewEnumerator10': 'Blizzard',
  'UDS_WeatherTypes::NewEnumerator11': 'Heatwave',
  'UDS_WeatherTypes::NewEnumerator12': 'Sandstorm',
};

function _resolveUdsWeather(enumValue) {
  if (!enumValue) return null;
  return UDS_WEATHER_MAP[enumValue] || enumValue.replace(/^UDS_WeatherTypes::/, '').replace(/NewEnumerator/, 'Weather ');
}

module.exports = PlayerStatsChannel;
module.exports._parseIni = _parseIni;
module.exports._cleanItemName = _cleanItemName;
module.exports._resolveUdsWeather = _resolveUdsWeather;

const { EmbedBuilder } = require('discord.js');
const SftpClient = require('ssh2-sftp-client');
const fs = require('node:fs');
const path = require('node:path');
const _defaultConfig = require('../config');
const { cleanOwnMessages, embedContentKey } = require('./discord-utils');
const _defaultPlaytime = require('../tracking/playtime-tracker');
const _defaultPlayerStats = require('../tracking/player-stats');
const KillTracker = require('../tracking/kill-tracker');
const { parseSave, parseClanData, PERK_MAP, PERK_INDEX_MAP } = require('../parsers/save-parser');
const { buildWelcomeContent } = require('./auto-messages');
const gameData = require('../parsers/game-data');
const { cleanItemName: _sharedCleanItemName } = require('../parsers/ue4-names');
const os = require('node:os');
const { t, getLocale, fmtNumber } = require('../i18n');

/**
 * Convert a DB player row (snake_case, from _parsePlayerRow) to camelCase
 * save-data format matching parseSave() output.  This allows all embed
 * builders and the kill tracker to work unchanged after the DB-first switch.
 */
function _dbRowToSave(row) {
  if (!row) return null;
  return {
    name:               row.name,
    male:               row.male,
    startingPerk:       row.starting_perk,
    affliction:         row.affliction,
    charProfile:        row.char_profile,
    zeeksKilled:        row.zeeks_killed,
    headshots:          row.headshots,
    meleeKills:         row.melee_kills,
    gunKills:           row.gun_kills,
    blastKills:         row.blast_kills,
    fistKills:          row.fist_kills,
    takedownKills:      row.takedown_kills,
    vehicleKills:       row.vehicle_kills,
    lifetimeKills:      row.lifetime_kills,
    lifetimeHeadshots:  row.lifetime_headshots,
    lifetimeMeleeKills: row.lifetime_melee_kills,
    lifetimeGunKills:   row.lifetime_gun_kills,
    lifetimeBlastKills: row.lifetime_blast_kills,
    lifetimeFistKills:  row.lifetime_fist_kills,
    lifetimeTakedownKills: row.lifetime_takedown_kills,
    lifetimeVehicleKills: row.lifetime_vehicle_kills,
    lifetimeDaysSurvived: row.lifetime_days_survived,
    hasExtendedStats:   row.has_extended_stats,
    daysSurvived:       row.days_survived,
    timesBitten:        row.times_bitten,
    bites:              row.bites,
    fishCaught:         row.fish_caught,
    fishCaughtPike:     row.fish_caught_pike,
    health:             row.health,
    maxHealth:          row.max_health,
    hunger:             row.hunger,
    maxHunger:          row.max_hunger,
    thirst:             row.thirst,
    maxThirst:          row.max_thirst,
    stamina:            row.stamina,
    maxStamina:         row.max_stamina,
    infection:          row.infection,
    maxInfection:       row.max_infection,
    battery:            row.battery,
    fatigue:            row.fatigue,
    infectionBuildup:   row.infection_buildup,
    wellRested:         row.well_rested,
    energy:             row.energy,
    hood:               row.hood,
    hypoHandle:         row.hypo_handle,
    exp:                row.exp,
    level:              row.level,
    expCurrent:         row.exp_current,
    expRequired:        row.exp_required,
    skillPoints:        row.skills_point,
    x:                  row.pos_x,
    y:                  row.pos_y,
    z:                  row.pos_z,
    rotationYaw:        row.rotation_yaw,
    respawnX:           row.respawn_x,
    respawnY:           row.respawn_y,
    respawnZ:           row.respawn_z,
    cbRadioCooldown:    row.cb_radio_cooldown,
    dayIncremented:     row.day_incremented,
    infectionTimer:     row.infection_timer,
    playerStates:       row.player_states || [],
    bodyConditions:     row.body_conditions || [],
    craftingRecipes:    row.crafting_recipes || [],
    buildingRecipes:    row.building_recipes || [],
    unlockedProfessions: row.unlocked_professions || [],
    unlockedSkills:     row.unlocked_skills || [],
    skillTree:          row.skills_data,
    skillsData:         row.skills_data,
    inventory:          row.inventory || [],
    equipment:          row.equipment || [],
    quickSlots:         row.quick_slots || [],
    backpackItems:      row.backpack_items || [],
    backpackData:       row.backpack_data,
    lore:               row.lore || [],
    uniqueLoots:        row.unique_loots || [],
    craftedUniques:     row.crafted_uniques || [],
    lootItemUnique:     row.loot_item_unique || [],
    questData:          row.quest_data,
    miniQuest:          row.mini_quest,
    challenges:         row.challenges,
    questSpawnerDone:   row.quest_spawner_done,
    companionData:      row.companion_data || [],
    horses:             row.horses || [],
    extendedStats:      row.extended_stats,
    challengeKillZombies:     row.challenge_kill_zombies,
    challengeKill50:          row.challenge_kill_50,
    challengeCatch20Fish:     row.challenge_catch_20_fish,
    challengeRegularAngler:   row.challenge_regular_angler,
    challengeKillZombieBear:  row.challenge_kill_zombie_bear,
    challenge9Squares:        row.challenge_9_squares,
    challengeCraftFirearm:    row.challenge_craft_firearm,
    challengeCraftFurnace:    row.challenge_craft_furnace,
    challengeCraftMeleeBench: row.challenge_craft_melee_bench,
    challengeCraftMeleeWeapon: row.challenge_craft_melee_weapon,
    challengeCraftRainCollector: row.challenge_craft_rain_collector,
    challengeCraftTablesaw:   row.challenge_craft_tablesaw,
    challengeCraftTreatment:  row.challenge_craft_treatment,
    challengeCraftWeaponsBench: row.challenge_craft_weapons_bench,
    challengeCraftWorkbench:  row.challenge_craft_workbench,
    challengeFindDog:         row.challenge_find_dog,
    challengeFindHeli:        row.challenge_find_heli,
    challengeLockpickSUV:     row.challenge_lockpick_suv,
    challengeRepairRadio:     row.challenge_repair_radio,
    customData:         row.custom_data,
  };
}

function _tsc(locale, key, vars = {}) {
  return t(`discord:stats_channel.${key}`, locale, vars);
}

function _tstatus(locale, key, vars = {}) {
  return t(`discord:status.${key}`, locale, vars);
}

function _seasonLabel(locale, season) {
  const normalized = String(season || '').trim().toLowerCase();
  const keyMap = {
    spring: 'season_spring',
    summer: 'season_summer',
    autumn: 'season_autumn',
    fall: 'season_autumn',
    winter: 'season_winter',
  };
  return keyMap[normalized] ? _tstatus(locale, keyMap[normalized]) : season;
}

class PlayerStatsChannel {
  constructor(client, logWatcher, deps = {}) {
    this._config = deps.config || _defaultConfig;
    this._playtime = deps.playtime || _defaultPlaytime;
    this._playerStats = deps.playerStats || _defaultPlayerStats;
    this._db = deps.db || null;
    this._label = deps.label || 'PLAYER STATS CH';
    this._serverId = deps.serverId || '';  // unique suffix for select menu IDs
    this._dataDir = deps.dataDir || null;  // for writing save-cache.json (multi-server)

    this.client = client;
    this._logWatcher = logWatcher || null; // for posting kill feed to activity thread
    this.channel = null;
    this.statusMessage = null; // the single embed we keep editing
    this.saveInterval = null;
    this._saveData = new Map(); // steamId -> save data
    this._clanData = [];           // array of { name, members: [{ name, steamId, rank }] }
    this._lastSaveUpdate = null;
    this._embedInterval = null;
    // Kill/stat tracker (shared data layer)
    this._killTracker = new KillTracker(deps);
    this._serverSettings = {};  // parsed GameServerSettings.ini
    this._weeklyStats = null;   // cached weekly delta leaderboards
    this._headless = false;     // true when running without Discord channel (data-only mode)
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
      // No Discord channel — run in headless mode.
      // Still poll save data to write save-cache.json for the web panel.
      this._headless = true;
      console.log(`[${this._label}] No PLAYER_STATS_CHANNEL_ID — running in headless mode (save-cache only)`);
    }

    if (!this._headless) {
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
      this._killTracker.load();

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
    } else {
      // Headless — still load kill tracker for data accumulation
      this._killTracker.load();
    }

    // Do initial save parse (works in both normal and headless mode)
    await this._pollSave();

    // Update the embed after initial parse (skip in headless mode)
    if (!this._headless) {
      await this._updateEmbed();
    }

    // Start save poll loop — use faster agent interval if agent mode is active
    const pollMs = typeof this._config.getEffectiveSavePollInterval === 'function'
      ? this._config.getEffectiveSavePollInterval()
      : Math.max(this._config.savePollInterval || 300000, 60000);
    this.saveInterval = setInterval(() => {
      this._pollSave()
        .then(() => { if (!this._headless) this._updateEmbed(); })
        .catch(err => console.error(`[${this._label}] Save poll error:`, err.message));
    }, pollMs);
    console.log(`[${this._label}] Save poll every ${pollMs / 1000}s${this._headless ? ' (headless)' : ''}`);

    // Update embed every 60s (for playtime changes etc.) — skip in headless mode
    if (!this._headless) {
      this._embedInterval = setInterval(() => this._updateEmbed(), 60000);
    }
  }

  stop() {
    if (this.saveInterval) { clearInterval(this.saveInterval); this.saveInterval = null; }
    if (this._embedInterval) { clearInterval(this._embedInterval); this._embedInterval = null; }
    this._killTracker.save();
  }

  async _pollSave() {
    // ── DB-first: read player/world/clan data from SQLite ──
    // SaveService populates these tables on its own SFTP poll cycle.
    // PSC no longer downloads or parses the save file itself.
    const dbLoaded = this._loadFromDb();

    if (!dbLoaded) {
      // DB has no player data yet (SaveService hasn't run, or DB not available).
      // Fall back to legacy SFTP download if credentials exist.
      if (this._config.ftpHost && !this._config.ftpHost.startsWith('PASTE_')) {
        await this._pollSaveLegacy();
        return;
      }
      console.log(`[${this._label}] No save data in DB and no SFTP credentials — skipping poll`);
      return;
    }

    // ── SFTP side-channel: server settings, ID map, welcome file ──
    // These are lightweight operations that don't download the 60MB save.
    if (this._config.ftpHost && !this._config.ftpHost.startsWith('PASTE_')) {
      const sftp = new SftpClient();
      try {
        await sftp.connect(this._config.sftpConnectConfig());

        // Refresh PlayerIDMapped.txt → PlayerStats name resolution
        await this._refreshIdMap(sftp);

        // Fetch + cache server settings INI
        await this._fetchServerSettings(sftp);

        // Upload welcome file if enabled
        if (this._config.enableWelcomeFile) {
          try {
            const content = await buildWelcomeContent({
              config: this._config,
              playtime: this._playtime,
              playerStats: this._playerStats,
              db: this._db,
            });
            await sftp.put(Buffer.from(content, 'utf8'), this._config.ftpWelcomePath);
            console.log(`[${this._label}] Updated WelcomeMessage.txt on server`);
          } catch (err) {
            console.error(`[${this._label}] Failed to write WelcomeMessage.txt:`, err.message);
          }
        }
      } catch (err) {
        console.error(`[${this._label}] SFTP side-channel error:`, err.message);
      } finally {
        await sftp.end().catch(() => {});
      }
    } else {
      // No SFTP — load cached server settings from DB
      this._loadCachedServerSettings();
    }

    // Cache leaderboard data for WelcomeMessage.txt
    this._cacheWelcomeStats();
  }

  /**
   * Load player, world, and clan data from the DB (populated by SaveService).
   * Populates this._saveData, this._worldState, this._clanData, entity arrays.
   * Returns true if data was loaded, false if DB has no players.
   */
  _loadFromDb() {
    if (!this._db) return false;
    try {
      const dbPlayers = this._db.getAllPlayers();
      if (!dbPlayers || dbPlayers.length === 0) return false;

      // Convert DB rows (snake_case) → save format (camelCase)
      const players = new Map();
      for (const row of dbPlayers) {
        players.set(row.steam_id, _dbRowToSave(row));
      }

      const prevWorldState = this._worldState || null;
      this._saveData = players;
      this._lastSaveUpdate = new Date();

      // World state from DB
      this._worldState = this._db.getAllWorldState() || {};

      // Clan data from DB
      try {
        this._clanData = this._db.getAllClans() || [];
      } catch (err) {
        console.error(`[${this._label}] Clan DB read error:`, err.message);
      }

      console.log(`[${this._label}] DB-first load: ${players.size} players`);

      // Load entity data from DB for save-cache.json (map data)
      try {
        this._vehicles = this._db.getAllVehicles?.() || [];
        this._horses = this._db.getAllWorldHorses?.() || [];
        this._containers = this._db.getAllContainers?.() || [];
        this._companions = this._db.getAllCompanions?.() || [];
        // Structures: read directly from DB (no getAllStructures method — use raw query)
        try {
          this._structures = this._db.db?.prepare('SELECT * FROM structures').all() || [];
        } catch { this._structures = []; }
      } catch (err) {
        console.warn(`[${this._label}] Entity load from DB:`, err.message);
      }

      // Accumulate lifetime stats across deaths (kills + survival + activity)
      this._runAccumulate();

      // Detect world state changes (season, day milestones, airdrops)
      if (prevWorldState && this._config.enableWorldEventFeed && this._logWatcher) {
        this._detectWorldEvents(prevWorldState, this._worldState);
      }

      // Write save-cache.json for web panel (multi-server instances)
      this._writeSaveCache();

      return true;
    } catch (err) {
      console.error(`[${this._label}] DB load error:`, err.message);
      return false;
    }
  }

  /**
   * Write save-cache.json for the web panel landing page.
   * Only writes for multi-server instances (that have _dataDir set).
   * Primary server's cache is written by SaveService in index.js.
   */
  _writeSaveCache() {
    if (!this._dataDir) return;
    try {
      const cacheData = {
        updatedAt: new Date().toISOString(),
        playerCount: this._saveData.size,
        worldState: this._worldState || {},
        players: {},
        structures: this._structures || [],
        vehicles: this._vehicles || [],
        horses: this._horses || [],
        containers: this._containers || [],
        companions: this._companions || [],
      };
      if (this._saveData instanceof Map) {
        for (const [steamId, pData] of this._saveData) {
          cacheData.players[steamId] = pData;
        }
      }
      const cachePath = path.join(this._dataDir, 'save-cache.json');
      fs.writeFileSync(cachePath, JSON.stringify(cacheData), 'utf8');
    } catch (err) {
      console.error(`[${this._label}] Failed to write save-cache.json:`, err.message);
    }
  }

  /**
   * Fetch server settings INI via SFTP, enrich with world state, and cache to DB.
   */
  async _fetchServerSettings(sftp) {
    try {
      const settingsPath = this._config.ftpSettingsPath || '/HumanitZServer/GameServerSettings.ini';
      const settingsBuf = await sftp.get(settingsPath);
      const settingsText = settingsBuf.toString('utf8');
      this._serverSettings = _parseIni(settingsText);
      this._enrichServerSettings();
      // Cache to DB
      try {
        if (this._db) this._db.setStateJSON('server_settings', this._serverSettings);
      } catch (_) {}
      console.log(`[${this._label}] Parsed server settings: ${Object.keys(this._serverSettings).length} keys`);
    } catch (err) {
      this._loadCachedServerSettings();
      if (!err.message.includes('No such file')) {
        console.error(`[${this._label}] Server settings error:`, err.message);
      }
    }
  }

  /**
   * Inject world state values into server settings for ServerStatus consumption.
   */
  _enrichServerSettings() {
    if (!this._worldState) return;
    const ws = this._worldState;
    if (ws.daysPassed != null) this._serverSettings._daysPassed = ws.daysPassed;
    if (ws.currentSeason) this._serverSettings._currentSeason = ws.currentSeason;
    if (ws.currentSeasonDay != null) this._serverSettings._currentSeasonDay = ws.currentSeasonDay;
    if (ws.totalStructures != null) this._serverSettings._totalStructures = ws.totalStructures;
    if (ws.totalVehicles != null) this._serverSettings._totalVehicles = ws.totalVehicles;
    if (ws.totalCompanions != null) this._serverSettings._totalCompanions = ws.totalCompanions;
    if (ws.totalPlayers != null) this._serverSettings._totalPlayers = ws.totalPlayers;
    // Extract weather from UDS weather state stored in save
    if (Array.isArray(ws.weatherState)) {
      const weatherProp = ws.weatherState.find(p => p.name === 'CurrentWeather');
      if (weatherProp && typeof weatherProp.value === 'string') {
        const locale = getLocale({ serverConfig: this._config });
        this._serverSettings._currentWeather = _resolveUdsWeather(weatherProp.value, locale);
      }
    }
    // Compute total zombie kills across all players from lifetime stats
    let totalZombieKills = 0;
    for (const [, p] of this._saveData) {
      totalZombieKills += p.lifetimeKills || p.zeeksKilled || 0;
    }
    this._serverSettings._totalZombieKills = totalZombieKills;
  }

  /**
   * Load cached server settings from DB fallback.
   */
  _loadCachedServerSettings() {
    try {
      if (this._db) {
        const cached = this._db.getStateJSON('server_settings', null);
        if (cached) this._serverSettings = cached;
      }
    } catch (_) {}
  }

  /**
   * Legacy SFTP-based save polling — used only when DB has no data
   * (SaveService hasn't synced yet). Once SaveService populates the DB,
   * subsequent polls will use _loadFromDb() instead.
   */
  async _pollSaveLegacy() {
    const sftp = new SftpClient();
    try {
      await sftp.connect(this._config.sftpConnectConfig());
      await this._refreshIdMap(sftp);

      const buf = await this._downloadSave(sftp);
      const { players, worldState, structures, vehicles, horses, containers, companions } = parseSave(buf);
      this._saveData = players;
      this._structures = structures || [];
      this._vehicles = vehicles || [];
      this._horses = horses || [];
      this._containers = containers || [];
      this._companions = companions || [];
      this._lastSaveUpdate = new Date();

      const prevWorldState = this._worldState || null;
      this._worldState = worldState || {};
      console.log(`[${this._label}] Legacy parse: ${players.size} players (${(buf.length / 1024 / 1024).toFixed(1)}MB)`);

      this._runAccumulate();

      if (prevWorldState && this._config.enableWorldEventFeed && this._logWatcher) {
        this._detectWorldEvents(prevWorldState, this._worldState);
      }

      // Clan data
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

      // Server settings
      await this._fetchServerSettings(sftp);

      // Cache leaderboard data
      this._cacheWelcomeStats();

      // Write save-cache.json for web panel (multi-server instances)
      this._writeSaveCache();

      // Welcome file
      if (this._config.enableWelcomeFile) {
        try {
          const content = await buildWelcomeContent({
            config: this._config,
            playtime: this._playtime,
            playerStats: this._playerStats,
            db: this._db,
          });
          await sftp.put(Buffer.from(content, 'utf8'), this._config.ftpWelcomePath);
          console.log(`[${this._label}] Updated WelcomeMessage.txt on server`);
        } catch (err) {
          console.error(`[${this._label}] Failed to write WelcomeMessage.txt:`, err.message);
        }
      }
    } catch (err) {
      console.error(`[${this._label}] Legacy save poll error:`, err.message);
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
      for (const [id] of this._saveData) {
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
      if (this._db) this._db.setStateJSON('welcome_stats', cache);
    } catch (err) {
      console.error(`[${this._label}] Failed to cache welcome stats:`, err.message);
    }
  }

  /** Delegate weekly stats to KillTracker */
  _computeWeeklyStats() {
    return this._killTracker.computeWeeklyStats(this._saveData);
  }

  async _updateEmbed() {
    if (!this.statusMessage) return;
    try {
      const embed = this._buildOverviewEmbed();
      const components = [...this._buildPlayerRow(), ...this._buildClanRow()];

      // Skip Discord API call if content hasn't changed since last edit
      const contentKey = embedContentKey(embed, components);
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
    await cleanOwnMessages(this.channel, this.client, { savedIds: savedId, label: this._label });
  }

  _loadMessageId() {
    try {
      if (this._db) return this._db.getState('msg_id_player_stats') || null;
    } catch {} return null;
  }

  _saveMessageId() {
    if (!this.statusMessage) return;
    try {
      if (this._db) this._db.setState('msg_id_player_stats', this.statusMessage.id);
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
        console.log(`[${this._label}] Loaded ${entries.length} name(s) from PlayerIDMapped.txt`);
      }
    } catch (err) {
      // Not critical — file may not exist on this server
      if (!err.message.includes('No such file')) {
        console.log(`[${this._label}] Could not read PlayerIDMapped.txt:`, err.message);
      }
    }
  }

  // ── Key arrays re-exported from KillTracker for embed builders ──
  static KILL_KEYS = KillTracker.KILL_KEYS;
  static SURVIVAL_KEYS = KillTracker.SURVIVAL_KEYS;
  static LIFETIME_KEY_MAP = KillTracker.LIFETIME_KEY_MAP;

  /**
   * Run KillTracker.accumulate() and post the resulting deltas to the
   * activity thread. This is the thin bridge between data (KillTracker)
   * and presentation (PSC embeds / activity feed).
   */
  _runAccumulate() {
    const { deltas, targetDate } = this._killTracker.accumulate(this._saveData, { gameData });
    if (this._logWatcher) {
      this._postActivitySummary(deltas, targetDate);
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

  /**
   * Build a consolidated activity summary embed from all delta types and post
   * a single message to the daily activity thread. This replaces the previous
   * approach of posting 1-10 individual embeds per save poll cycle.
   */
  async _postActivitySummary(deltas, targetDate) {
    const locale = getLocale({ serverConfig: this._config });
    const sections = [];

    // ── Kills ──
    if (deltas.killDeltas.length > 0 && this._config.enableKillFeed) {
      const lines = deltas.killDeltas.map(({ name, delta }) => {
        const total = delta.zeeksKilled || 0;
        const parts = [];
        if (delta.headshots) {
          parts.push(_tsc(locale, 'kills_detail_headshots', {
            count: fmtNumber(delta.headshots, locale),
            plural_suffix: delta.headshots > 1 ? 's' : '',
          }));
        }
        if (delta.meleeKills) parts.push(_tsc(locale, 'kills_detail_melee', { count: fmtNumber(delta.meleeKills, locale) }));
        if (delta.gunKills) parts.push(_tsc(locale, 'kills_detail_gun', { count: fmtNumber(delta.gunKills, locale) }));
        if (delta.blastKills) parts.push(_tsc(locale, 'kills_detail_blast', { count: fmtNumber(delta.blastKills, locale) }));
        if (delta.fistKills) parts.push(_tsc(locale, 'kills_detail_fist', { count: fmtNumber(delta.fistKills, locale) }));
        if (delta.takedownKills) parts.push(_tsc(locale, 'kills_detail_takedown', { count: fmtNumber(delta.takedownKills, locale) }));
        if (delta.vehicleKills) parts.push(_tsc(locale, 'kills_detail_vehicle', { count: fmtNumber(delta.vehicleKills, locale) }));
        const detail = parts.length > 0
          ? _tsc(locale, 'kills_detail_suffix', { details: parts.join(', ') })
          : '';
        return _tsc(locale, 'kills_line', {
          name,
          total: fmtNumber(total, locale),
          plural_suffix: total !== 1 ? 's' : '',
          detail,
        });
      });
      sections.push({ header: _tsc(locale, 'header_kills'), lines });
    }

    // ── Survival ──
    if (deltas.survivalDeltas.length > 0 && this._config.enableKillFeed) {
      const lines = deltas.survivalDeltas.map(({ name, delta }) => {
        const parts = [];
        if (delta.daysSurvived) {
          parts.push(_tsc(locale, 'survival_days', {
            days: fmtNumber(delta.daysSurvived, locale),
            plural_suffix: delta.daysSurvived > 1 ? 's' : '',
          }));
        }
        return _tsc(locale, 'survival_line', { name, details: parts.join(', ') });
      });
      sections.push({ header: _tsc(locale, 'header_survival'), lines });
    }

    // ── Fishing ──
    if (deltas.fishingDeltas.length > 0 && this._config.enableFishingFeed) {
      const lines = deltas.fishingDeltas.map(({ name, delta }) => {
        const total = delta.fishCaught || 0;
        const pike = delta.fishCaughtPike || 0;
        const bitten = delta.timesBitten || 0;
        const parts = [];
        if (total > 0) {
          const pikeNote = pike > 0
            ? _tsc(locale, 'fishing_pike_note', { count: fmtNumber(pike, locale) })
            : '';
          parts.push(_tsc(locale, 'fishing_caught', {
            count: fmtNumber(total, locale),
            pike_note: pikeNote,
          }));
        }
        if (bitten > 0) {
          parts.push(_tsc(locale, 'fishing_bitten', {
            count: fmtNumber(bitten, locale),
            plural_suffix: bitten > 1 ? 's' : '',
          }));
        }
        return _tsc(locale, 'fishing_line', { name, details: parts.join(', ') });
      });
      sections.push({ header: _tsc(locale, 'header_fishing'), lines });
    }

    // ── Recipes ──
    if (deltas.recipeDeltas.length > 0 && this._config.enableRecipeFeed) {
      const lines = deltas.recipeDeltas.map(({ name, type, items }) => {
        const names = items.map(r => _cleanItemName(r)).filter(Boolean);
        const typeLabel = type === 'crafting'
          ? _tsc(locale, 'recipe_type_crafting')
          : (type === 'building' ? _tsc(locale, 'recipe_type_building') : type);
        const display = names.length <= 5
          ? names.join(', ')
          : _tsc(locale, 'list_with_more', {
            items: names.slice(0, 5).join(', '),
            count: fmtNumber(names.length - 5, locale),
          });
        return _tsc(locale, 'recipes_line', { name, type: typeLabel, display });
      });
      sections.push({ header: _tsc(locale, 'header_recipes'), lines });
    }

    // ── Skills ──
    if (deltas.skillDeltas.length > 0 && this._config.enableSkillFeed) {
      const lines = deltas.skillDeltas.map(({ name, items }) => {
        const names = items.map(s => _cleanItemName(s).toUpperCase());
        return _tsc(locale, 'skills_line', {
          name,
          plural_suffix: names.length > 1 ? 's' : '',
          names: names.join(', '),
        });
      });
      sections.push({ header: _tsc(locale, 'header_skills'), lines });
    }

    // ── Professions ──
    if (deltas.professionDeltas.length > 0 && this._config.enableProfessionFeed) {
      const lines = deltas.professionDeltas.map(({ name, items }) => {
        const names = items.map(p => {
          if (typeof p === 'number') {
            return PERK_INDEX_MAP[p] || _tsc(locale, 'profession_fallback', { id: fmtNumber(p, locale) });
          }
          if (typeof p === 'string') return PERK_MAP[p] || _cleanItemName(p);
          return String(p);
        });
        return _tsc(locale, 'professions_line', {
          name,
          plural_suffix: names.length > 1 ? 's' : '',
          names: names.join(', '),
        });
      });
      sections.push({ header: _tsc(locale, 'header_professions'), lines });
    }

    // ── Lore ──
    if (deltas.loreDeltas.length > 0 && this._config.enableLoreFeed) {
      const lines = deltas.loreDeltas.map(({ name, items }) => {
        const count = items.length;
        const names = items.map(l => _cleanItemName(typeof l === 'object' ? (l.name || l.id || JSON.stringify(l)) : l)).filter(Boolean);
        const display = names.length > 0 && names.length <= 3
          ? _tsc(locale, 'lore_display_suffix', { names: names.join(', ') })
          : '';
        return _tsc(locale, 'lore_line', {
          name,
          count: fmtNumber(count, locale),
          plural_suffix: count > 1 ? 'ies' : 'y',
          display,
        });
      });
      sections.push({ header: _tsc(locale, 'header_lore'), lines });
    }

    // ── Unique Items ──
    if (deltas.uniqueDeltas.length > 0 && this._config.enableUniqueFeed) {
      const lines = deltas.uniqueDeltas.map(({ name, type, items }) => {
        const names = items.map(u => _cleanItemName(typeof u === 'object' ? (u.name || u.id || JSON.stringify(u)) : u)).filter(Boolean);
        const typeLabel = type === 'found'
          ? _tsc(locale, 'unique_type_found')
          : (type === 'crafted' ? _tsc(locale, 'unique_type_crafted') : type);
        const display = names.length <= 5
          ? names.join(', ')
          : _tsc(locale, 'list_with_more', {
            items: names.slice(0, 5).join(', '),
            count: fmtNumber(names.length - 5, locale),
          });
        return _tsc(locale, 'unique_line', {
          name,
          type: typeLabel,
          plural_suffix: items.length > 1 ? 's' : '',
          display,
        });
      });
      sections.push({ header: _tsc(locale, 'header_unique_items'), lines });
    }

    // ── Companions ──
    if (deltas.companionDeltas.length > 0 && this._config.enableCompanionFeed) {
      const lines = deltas.companionDeltas.map(({ name, type, items }) => {
        const count = items.length;
        const emoji = type === 'horse' ? '🐴' : '🐕';
        const label = type === 'horse'
          ? _tsc(locale, 'companion_horse_label', {
            count: fmtNumber(count, locale),
            plural_suffix: count > 1 ? 's' : '',
          })
          : _tsc(locale, 'companion_companion_label', {
            count: fmtNumber(count, locale),
            plural_suffix: count > 1 ? 's' : '',
          });
        return _tsc(locale, 'companion_line', { emoji, name, label });
      });
      sections.push({ header: _tsc(locale, 'header_companions'), lines });
    }

    // ── Challenges ──
    if (deltas.challengeDeltas.length > 0 && this._config.enableChallengeFeed) {
      const lines = deltas.challengeDeltas.flatMap(({ name, completed }) =>
        completed.map(c => _tsc(locale, 'challenge_line', {
          name,
          challenge: c.name,
          description: c.desc,
        }))
      );
      sections.push({ header: _tsc(locale, 'header_challenges'), lines });
    }

    if (sections.length === 0) return;

    // Build consolidated description with section headers, splitting across
    // multiple embeds when the 4096-char description limit would be exceeded.
    const LIMIT = 4000; // margin below Discord's 4096
    const descParts = sections.map(s =>
      `**${s.header}**\n${s.lines.join('\n')}`
    );

    const chunks = [];
    let current = '';
    for (const part of descParts) {
      const addition = current ? `\n\n${part}` : part;
      if (current && (current.length + addition.length) > LIMIT) {
        chunks.push(current);
        current = part;
      } else {
        current += addition;
      }
    }
    if (current) chunks.push(current);

    try {
      for (let i = 0; i < chunks.length; i++) {
        const embed = new EmbedBuilder()
          .setDescription(chunks[i])
          .setColor(0x5865F2);
        if (i === 0) embed.setAuthor({ name: _tsc(locale, 'activity_summary') });
        if (i === chunks.length - 1) embed.setTimestamp();
        await this._sendFeedEmbed(embed, targetDate);
      }
    } catch (err) {
      console.error(`[${this._label}] Failed to post activity summary to thread:`, err.message);
    }
  }

  async _detectWorldEvents(prev, current) {
    const locale = getLocale({ serverConfig: this._config });
    const lines = [];

    // Season change
    if (prev.currentSeason && current.currentSeason && prev.currentSeason !== current.currentSeason) {
      const seasonEmoji = { Spring: '🌱', Summer: '☀️', Autumn: '🍂', Winter: '❄️' };
      const emoji = seasonEmoji[current.currentSeason] || '🔄';
      lines.push(_tsc(locale, 'world_season_changed', {
        emoji,
        season: _seasonLabel(locale, current.currentSeason),
      }));
    }

    // Day milestone (every 10 days)
    if (prev.daysPassed != null && current.daysPassed != null) {
      const prevDay = Math.floor(prev.daysPassed);
      const curDay = Math.floor(current.daysPassed);
      if (curDay > prevDay) {
        // Post milestone at every 10th day, or the first day change after bot start
        if (curDay % 10 === 0 || Math.floor(prevDay / 10) < Math.floor(curDay / 10)) {
          lines.push(_tsc(locale, 'world_day_reached', { day: fmtNumber(curDay, locale) }));
        }
      }
    }

    // Airdrop detected
    if (!prev.airdropActive && current.airdropActive) {
      lines.push(_tsc(locale, 'world_airdrop_incoming'));
    }

    if (lines.length === 0) return;

    const embed = new EmbedBuilder()
      .setAuthor({ name: _tsc(locale, 'world_event') })
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
    return this._killTracker.getAllTimeKills(steamId, this._saveData);
  }

  getCurrentLifeKills(steamId) {
    return this._killTracker.getCurrentLifeKills(steamId, this._saveData);
  }

  getAllTimeSurvival(steamId) {
    return this._killTracker.getAllTimeSurvival(steamId, this._saveData);
  }

  getSaveData() { return this._saveData; }

  getClanData() { return this._clanData; }

  getServerSettings() { return this._serverSettings; }
}

function _parseIni(text) {
  const result = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) continue;
    const secMatch = trimmed.match(/^\[(.+)\]$/);
    if (secMatch) continue;
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

/**
 * Clean an item name using the shared cleaner from ue4-names.js.
 * Returns '' for null/undefined (not 'Unknown') to preserve .filter(Boolean) patterns.
 */
function _cleanItemName(name) {
  if (!name) return '';
  const cleaned = _sharedCleanItemName(name);
  return cleaned === 'Unknown' ? '' : cleaned;
}

/** Map UDS (Ultra Dynamic Sky) weather enum values to human-readable names */
const UDS_WEATHER_MAP = {
  'UDS_WeatherTypes::NewEnumerator0': 'weather_clear_skies',
  'UDS_WeatherTypes::NewEnumerator1': 'weather_partly_cloudy',
  'UDS_WeatherTypes::NewEnumerator2': 'weather_cloudy',
  'UDS_WeatherTypes::NewEnumerator3': 'weather_overcast',
  'UDS_WeatherTypes::NewEnumerator4': 'weather_foggy',
  'UDS_WeatherTypes::NewEnumerator5': 'weather_light_rain',
  'UDS_WeatherTypes::NewEnumerator6': 'weather_rain',
  'UDS_WeatherTypes::NewEnumerator7': 'weather_thunderstorm',
  'UDS_WeatherTypes::NewEnumerator8': 'weather_light_snow',
  'UDS_WeatherTypes::NewEnumerator9': 'weather_snow',
  'UDS_WeatherTypes::NewEnumerator10': 'weather_blizzard',
  'UDS_WeatherTypes::NewEnumerator11': 'weather_heatwave',
  'UDS_WeatherTypes::NewEnumerator12': 'weather_sandstorm',
};

function _resolveUdsWeather(enumValue, locale = 'en') {
  if (!enumValue) return null;
  const key = UDS_WEATHER_MAP[enumValue];
  if (key) return _tstatus(locale, key);
  const fallback = enumValue.replace(/^UDS_WeatherTypes::/, '').replace(/NewEnumerator/, '').trim();
  return _tstatus(locale, 'weather_fallback', { value: fallback || enumValue });
}

Object.assign(PlayerStatsChannel.prototype, require('./player-stats-embeds'));

module.exports = PlayerStatsChannel;
module.exports._parseIni = _parseIni;
module.exports._cleanItemName = _cleanItemName;
module.exports._resolveUdsWeather = _resolveUdsWeather;
module.exports._dbRowToSave = _dbRowToSave;

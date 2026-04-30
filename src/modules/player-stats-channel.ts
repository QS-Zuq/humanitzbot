import type { Client, TextChannel, Message, MessageCreateOptions, MessageEditOptions } from 'discord.js';
import { EmbedBuilder, ActionRowBuilder } from 'discord.js';
import SftpClient from 'ssh2-sftp-client';
import fs from 'fs';
import path from 'path';
import { createLogger } from '../utils/log.js';
import { errMsg } from '../utils/error.js';
import _defaultConfig from '../config/index.js';
import { cleanOwnMessages, embedContentKey } from './discord-utils.js';
import _defaultPlaytime from '../tracking/playtime-tracker.js';
import _defaultPlayerStats from '../tracking/player-stats.js';
import { KillTracker } from '../tracking/kill-tracker.js';
import { parseSave, parseClanData, PERK_MAP, PERK_INDEX_MAP } from '../parsers/save-parser.js';
import * as gameData from '../parsers/game-data.js';
import { cleanItemName as _sharedCleanItemName } from '../parsers/ue4-names.js';
import * as playerStatsEmbeds from './player-stats-embeds.js';
import os from 'os';
import type { HumanitZDB } from '../db/database.js';

interface DbPlayerRow {
  steam_id: string;
  name: string;
  male: number;
  starting_perk: string;
  affliction: number;
  char_profile: unknown;
  zeeks_killed: number;
  headshots: number;
  melee_kills: number;
  gun_kills: number;
  blast_kills: number;
  fist_kills: number;
  takedown_kills: number;
  vehicle_kills: number;
  lifetime_kills: number;
  lifetime_headshots: number;
  lifetime_melee_kills: number;
  lifetime_gun_kills: number;
  lifetime_blast_kills: number;
  lifetime_fist_kills: number;
  lifetime_takedown_kills: number;
  lifetime_vehicle_kills: number;
  lifetime_days_survived: number;
  has_extended_stats: number;
  days_survived: number;
  times_bitten: number;
  bites: number;
  fish_caught: number;
  fish_caught_pike: number;
  health: number;
  max_health: number;
  hunger: number;
  max_hunger: number;
  thirst: number;
  max_thirst: number;
  stamina: number;
  max_stamina: number;
  infection: number;
  max_infection: number;
  battery: number;
  fatigue: number;
  infection_buildup: number;
  well_rested: number;
  energy: number;
  hood: number;
  hypo_handle: number;
  exp: number;
  level: number;
  exp_current: number;
  exp_required: number;
  skills_point: number;
  pos_x: number | null;
  pos_y: number | null;
  pos_z: number | null;
  rotation_yaw: number | null;
  respawn_x: number | null;
  respawn_y: number | null;
  respawn_z: number | null;
  cb_radio_cooldown: number;
  day_incremented: number;
  infection_timer: unknown;
  player_states: unknown[] | null;
  body_conditions: unknown[] | null;
  crafting_recipes: unknown[] | null;
  building_recipes: unknown[] | null;
  unlocked_professions: unknown[] | null;
  unlocked_skills: unknown[] | null;
  skills_data: unknown;
  inventory: unknown[] | null;
  equipment: unknown[] | null;
  quick_slots: unknown[] | null;
  backpack_items: unknown[] | null;
  backpack_data: unknown;
  lore: unknown[] | null;
  unique_loots: unknown[] | null;
  crafted_uniques: unknown[] | null;
  loot_item_unique: unknown[] | null;
  quest_data: unknown;
  mini_quest: unknown;
  challenges: unknown;
  quest_spawner_done: unknown;
  companion_data: unknown[] | null;
  horses: unknown[] | null;
  extended_stats: unknown;
  challenge_kill_zombies: number;
  challenge_kill_50: number;
  challenge_catch_20_fish: number;
  challenge_regular_angler: number;
  challenge_kill_zombie_bear: number;
  challenge_9_squares: number;
  challenge_craft_firearm: number;
  challenge_craft_furnace: number;
  challenge_craft_melee_bench: number;
  challenge_craft_melee_weapon: number;
  challenge_craft_rain_collector: number;
  challenge_craft_tablesaw: number;
  challenge_craft_treatment: number;
  challenge_craft_weapons_bench: number;
  challenge_craft_workbench: number;
  challenge_find_dog: number;
  challenge_find_heli: number;
  challenge_lockpick_suv: number;
  challenge_repair_radio: number;
  custom_data: unknown;
}

interface ClanMemberObj {
  steamId?: unknown;
  steam_id?: unknown;
  name?: unknown;
  canKick?: unknown;
  can_kick?: unknown;
  canInvite?: unknown;
  can_invite?: unknown;
  rank?: unknown;
}

interface ClanObj {
  name?: unknown;
  members: ClanMemberObj[];
}

interface PSCDeps {
  config?: typeof _defaultConfig;
  playtime?: typeof _defaultPlaytime;
  playerStats?: typeof _defaultPlayerStats;
  db?: HumanitZDB | null;
  label?: string;
  serverId?: string;
  dataDir?: string | null;
  panelApi?: PanelApi | null;
  [key: string]: unknown;
}

interface PanelApi {
  available: boolean;
  downloadFile(path: string): Promise<Buffer>;
}

interface LogWatcher {
  sendToThread(embed: EmbedBuilder): Promise<unknown>;
  sendToDateThread?(embed: EmbedBuilder, date: string | Date): Promise<unknown>;
}

/**
 * Convert a DB player row (snake_case, from _parsePlayerRow) to camelCase
 * save-data format matching parseSave() output.  This allows all embed
 * builders and the kill tracker to work unchanged after the DB-first switch.
 */
function _dbRowToSave(row: DbPlayerRow | null): Record<string, unknown> | null {
  if (!row) return null;
  return {
    name: row.name,
    male: row.male,
    startingPerk: row.starting_perk,
    affliction: row.affliction,
    charProfile: row.char_profile,
    zeeksKilled: row.zeeks_killed,
    headshots: row.headshots,
    meleeKills: row.melee_kills,
    gunKills: row.gun_kills,
    blastKills: row.blast_kills,
    fistKills: row.fist_kills,
    takedownKills: row.takedown_kills,
    vehicleKills: row.vehicle_kills,
    lifetimeKills: row.lifetime_kills,
    lifetimeHeadshots: row.lifetime_headshots,
    lifetimeMeleeKills: row.lifetime_melee_kills,
    lifetimeGunKills: row.lifetime_gun_kills,
    lifetimeBlastKills: row.lifetime_blast_kills,
    lifetimeFistKills: row.lifetime_fist_kills,
    lifetimeTakedownKills: row.lifetime_takedown_kills,
    lifetimeVehicleKills: row.lifetime_vehicle_kills,
    lifetimeDaysSurvived: row.lifetime_days_survived,
    hasExtendedStats: row.has_extended_stats,
    daysSurvived: row.days_survived,
    timesBitten: row.times_bitten,
    bites: row.bites,
    fishCaught: row.fish_caught,
    fishCaughtPike: row.fish_caught_pike,
    health: row.health,
    maxHealth: row.max_health,
    hunger: row.hunger,
    maxHunger: row.max_hunger,
    thirst: row.thirst,
    maxThirst: row.max_thirst,
    stamina: row.stamina,
    maxStamina: row.max_stamina,
    infection: row.infection,
    maxInfection: row.max_infection,
    battery: row.battery,
    fatigue: row.fatigue,
    infectionBuildup: row.infection_buildup,
    wellRested: row.well_rested,
    energy: row.energy,
    hood: row.hood,
    hypoHandle: row.hypo_handle,
    exp: row.exp,
    level: row.level,
    expCurrent: row.exp_current,
    expRequired: row.exp_required,
    skillPoints: row.skills_point,
    x: row.pos_x,
    y: row.pos_y,
    z: row.pos_z,
    rotationYaw: row.rotation_yaw,
    respawnX: row.respawn_x,
    respawnY: row.respawn_y,
    respawnZ: row.respawn_z,
    cbRadioCooldown: row.cb_radio_cooldown,
    dayIncremented: row.day_incremented,
    infectionTimer: row.infection_timer,
    playerStates: row.player_states || [],
    bodyConditions: row.body_conditions || [],
    craftingRecipes: row.crafting_recipes || [],
    buildingRecipes: row.building_recipes || [],
    unlockedProfessions: row.unlocked_professions || [],
    unlockedSkills: row.unlocked_skills || [],
    skillTree: row.skills_data,
    skillsData: row.skills_data,
    inventory: row.inventory || [],
    equipment: row.equipment || [],
    quickSlots: row.quick_slots || [],
    backpackItems: row.backpack_items || [],
    backpackData: row.backpack_data,
    lore: row.lore || [],
    uniqueLoots: row.unique_loots || [],
    craftedUniques: row.crafted_uniques || [],
    lootItemUnique: row.loot_item_unique || [],
    questData: row.quest_data,
    miniQuest: row.mini_quest,
    challenges: row.challenges,
    questSpawnerDone: row.quest_spawner_done,
    companionData: row.companion_data || [],
    horses: row.horses || [],
    extendedStats: row.extended_stats,
    challengeKillZombies: row.challenge_kill_zombies,
    challengeKill50: row.challenge_kill_50,
    challengeCatch20Fish: row.challenge_catch_20_fish,
    challengeRegularAngler: row.challenge_regular_angler,
    challengeKillZombieBear: row.challenge_kill_zombie_bear,
    challenge9Squares: row.challenge_9_squares,
    challengeCraftFirearm: row.challenge_craft_firearm,
    challengeCraftFurnace: row.challenge_craft_furnace,
    challengeCraftMeleeBench: row.challenge_craft_melee_bench,
    challengeCraftMeleeWeapon: row.challenge_craft_melee_weapon,
    challengeCraftRainCollector: row.challenge_craft_rain_collector,
    challengeCraftTablesaw: row.challenge_craft_tablesaw,
    challengeCraftTreatment: row.challenge_craft_treatment,
    challengeCraftWeaponsBench: row.challenge_craft_weapons_bench,
    challengeCraftWorkbench: row.challenge_craft_workbench,
    challengeFindDog: row.challenge_find_dog,
    challengeFindHeli: row.challenge_find_heli,
    challengeLockpickSUV: row.challenge_lockpick_suv,
    challengeRepairRadio: row.challenge_repair_radio,
    customData: row.custom_data,
  };
}

class PlayerStatsChannel {
  _config: typeof _defaultConfig;
  _playtime: typeof _defaultPlaytime;
  _playerStats: typeof _defaultPlayerStats;
  _db: HumanitZDB | null;
  _log: ReturnType<typeof createLogger>;
  _label: string;
  _serverId: string;
  _dataDir: string | null;
  _panelApi: PanelApi | null;
  client: Client;
  _logWatcher: LogWatcher | null;
  channel: TextChannel | null;
  statusMessage: Message | null;
  saveInterval: ReturnType<typeof setInterval> | null;
  _saveData: Map<string, Record<string, unknown>>;
  _clanData: ClanObj[];
  _lastSaveUpdate: Date | null;
  _embedInterval: ReturnType<typeof setInterval> | null;
  _killTracker: KillTracker;
  _serverSettings: Record<string, unknown>;
  _weeklyStats: Record<string, unknown> | null;
  _headless: boolean;
  _worldState: Record<string, unknown> | null;
  _structures: unknown[];
  _vehicles: unknown[];
  _horses: unknown[];
  _containers: unknown[];
  _companions: unknown[];
  _lastEmbedKey: string | null;

  // Embed builder methods mixed in via Object.assign (see bottom of file)
  declare _buildOverviewEmbed: () => EmbedBuilder;
  declare _buildPlayerRow: () => unknown[];
  declare _buildClanRow: () => unknown[];

  constructor(client: Client, logWatcher: LogWatcher | null | undefined, deps: PSCDeps = {}) {
    this._config = deps.config || _defaultConfig;
    this._playtime = deps.playtime || _defaultPlaytime;
    this._playerStats = deps.playerStats || _defaultPlayerStats;
    this._db = deps.db || null;
    this._log = createLogger(deps.label, 'PLAYER STATS CH');
    this._label = this._log.label;
    this._serverId = deps.serverId || '';
    this._dataDir = deps.dataDir || null;
    this._panelApi = deps.panelApi || null;

    this.client = client;
    this._logWatcher = logWatcher || null;
    this.channel = null;
    this.statusMessage = null;
    this.saveInterval = null;
    this._saveData = new Map();
    this._clanData = [];
    this._lastSaveUpdate = null;
    this._embedInterval = null;
    this._killTracker = new KillTracker(deps);
    this._serverSettings = {};
    this._weeklyStats = null;
    this._headless = false;
    this._worldState = null;
    this._structures = [];
    this._vehicles = [];
    this._horses = [];
    this._containers = [];
    this._companions = [];
    this._lastEmbedKey = null;
  }

  // ── Cross-validated player resolver ─────────────────────────

  _resolvePlayer(steamId: string) {
    const pt = this._playtime.getPlaytime(steamId);
    const log = this._playerStats.getStats(steamId);
    const save = this._saveData.get(steamId);

    // ── Name resolution: most-recent-event wins ──
    let name: string;
    const ptName = pt?.name;
    const logName = log?.name;

    if (ptName && logName) {
      if (ptName !== logName) {
        // Compare timestamps — whichever source was updated more recently wins
        const ptTime = pt.lastSeen ? new Date(pt.lastSeen).getTime() : 0;
        const logTime = log.lastEvent ? new Date(log.lastEvent).getTime() : 0;
        name = ptTime >= logTime ? ptName : logName;
      } else {
        name = ptName; // they agree
      }
    } else {
      name = ptName ?? logName ?? this._playerStats.getNameForId(steamId);
    }

    // ── Last active: max of both timestamps ──
    const ptLastSeen = pt?.lastSeen ? new Date(pt.lastSeen).getTime() : 0;
    const logLastEvent = log?.lastEvent ? new Date(log.lastEvent).getTime() : 0;
    const lastActiveMs = Math.max(ptLastSeen, logLastEvent);
    const lastActive = lastActiveMs > 0 ? new Date(lastActiveMs).toISOString() : null;

    // ── First seen (playtime only) ──
    const firstSeen = pt?.firstSeen ?? null;

    return { name, firstSeen, lastActive, playtime: pt, log, save };
  }

  async start() {
    if (!this._config.playerStatsChannelId) {
      // No Discord channel — run in headless mode.
      // Still poll save data to write save-cache.json for the web panel.
      this._headless = true;
      this._log.info('No PLAYER_STATS_CHANNEL_ID — running in headless mode (save-cache only)');
    }

    if (!this._headless) {
      try {
        const fetched = await this.client.channels.fetch(this._config.playerStatsChannelId);
        if (!fetched) {
          this._log.error('Channel not found! Check PLAYER_STATS_CHANNEL_ID.');
          return;
        }
        this.channel = fetched as TextChannel;
      } catch (err: unknown) {
        this._log.error('Failed to fetch channel:', (err as Error).message);
        return;
      }

      this._log.info(`Posting in #${this.channel.name}`);

      // Load persistent kill tracker
      this._killTracker.load();

      // Delete previous own message (by saved ID), not all bot messages
      await this._cleanOwnMessage();

      // Post the initial embed
      const embed = this._buildOverviewEmbed();
      const components = [...this._buildPlayerRow(), ...this._buildClanRow()] as ActionRowBuilder[];
      this.statusMessage = await this.channel.send({
        embeds: [embed],
        ...(components.length > 0 && { components }),
      } as MessageCreateOptions);
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
    const pollMs =
      typeof this._config.getEffectiveSavePollInterval === 'function'
        ? this._config.getEffectiveSavePollInterval()
        : Math.max(this._config.savePollInterval || 300000, 60000);
    this.saveInterval = setInterval(() => {
      void this._pollSave()
        .then(() => {
          if (!this._headless) void this._updateEmbed();
        })
        .catch((err: unknown) => {
          this._log.error('Save poll error:', (err as Error).message);
        });
    }, pollMs);
    this._log.info(`Save poll every ${pollMs / 1000}s${this._headless ? ' (headless)' : ''}`);

    // Update embed every 60s (for playtime changes etc.) — skip in headless mode
    if (!this._headless) {
      this._embedInterval = setInterval(() => {
        void this._updateEmbed();
      }, 60000);
    }
  }

  stop() {
    if (this.saveInterval) {
      clearInterval(this.saveInterval);
      this.saveInterval = null;
    }
    if (this._embedInterval) {
      clearInterval(this._embedInterval);
      this._embedInterval = null;
    }
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
      if (this._config.sftpHost && !this._config.sftpHost.startsWith('PASTE_')) {
        await this._pollSaveLegacy();
        return;
      }
      this._log.info('No save data in DB and no SFTP credentials — skipping poll');
      return;
    }

    // ── Side-channel: server settings, ID map, welcome file ──
    // These are lightweight operations that don't download the 60MB save.
    // Prefer Panel API when available; fall back to SFTP.
    const hasPanelApi = this._panelApi && this._panelApi.available;
    const hasSftp = this._config.sftpHost && !this._config.sftpHost.startsWith('PASTE_');
    if (hasPanelApi || hasSftp) {
      const sftp = hasSftp ? new SftpClient() : null;
      try {
        if (sftp) await sftp.connect(this._config.sftpConnectConfig());

        // Refresh PlayerIDMapped.txt → PlayerStats name resolution
        await this._refreshIdMap(sftp);

        // Fetch + cache server settings INI
        await this._fetchServerSettings(sftp);

        // WelcomeMessage.txt is now managed exclusively by the Welcome File Editor
      } catch (err: unknown) {
        this._log.error('Side-channel error:', (err as Error).message);
      } finally {
        if (sftp) await sftp.end().catch(() => {});
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
      const dbPlayers = this._db.player.getAllPlayers();
      if (dbPlayers.length === 0) return false;

      // Convert DB rows (snake_case) → save format (camelCase)
      const players = new Map<string, Record<string, unknown>>();
      for (const row of dbPlayers) {
        const steamId = row['steam_id'];
        if (typeof steamId === 'string') {
          const save = _dbRowToSave(row as unknown as DbPlayerRow); // SAFETY: DB row shape validated by schema
          if (save) players.set(steamId, save);
        }
      }

      const prevWorldState = this._worldState;
      this._saveData = players;
      this._lastSaveUpdate = new Date();

      // World state from DB
      this._worldState = this._db.worldState.getAllWorldState();

      // Clan data from DB
      try {
        this._clanData = this._db.clan.getAllClans();
      } catch (err: unknown) {
        this._log.error('Clan DB read error:', (err as Error).message);
      }

      this._log.info(`DB-first load: ${players.size} players`);

      // Load entity data from DB for save-cache.json (map data)
      try {
        this._vehicles = this._db.worldObject.getAllVehicles();
        this._horses = this._db.worldObject.getAllWorldHorses();
        this._containers = this._db.worldObject.getAllContainers();
        this._companions = this._db.worldObject.getAllCompanions();
        try {
          this._structures = this._db.worldObject.getStructures();
        } catch {
          this._structures = [];
        }
      } catch (err: unknown) {
        this._log.warn('Entity load from DB:', (err as Error).message);
      }

      // Accumulate lifetime stats across deaths (kills + survival + activity)
      this._runAccumulate();

      // Detect world state changes (season, day milestones, airdrops)
      if (prevWorldState && this._config.enableWorldEventFeed && this._logWatcher) {
        void this._detectWorldEvents(prevWorldState, this._worldState);
      }

      // Write save-cache.json for web panel (multi-server instances)
      this._writeSaveCache();

      return true;
    } catch (err: unknown) {
      this._log.error('DB load error:', (err as Error).message);
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
      const players: Record<string, unknown> = {};
      for (const [steamId, pData] of this._saveData) {
        players[steamId] = pData;
      }
      const cacheData: Record<string, unknown> = {
        updatedAt: new Date().toISOString(),
        playerCount: this._saveData.size,
        worldState: this._worldState ?? {},
        players,
        structures: this._structures,
        vehicles: this._vehicles,
        horses: this._horses,
        containers: this._containers,
        companions: this._companions,
      };
      const cachePath = path.join(this._dataDir, 'save-cache.json');
      fs.writeFileSync(cachePath, JSON.stringify(cacheData), 'utf8');
    } catch (err: unknown) {
      this._log.error('Failed to write save-cache.json:', (err as Error).message);
    }
  }

  /**
   * Fetch server settings INI via SFTP, enrich with world state, and cache to DB.
   */
  async _fetchServerSettings(sftp: SftpClient | null) {
    try {
      const settingsPath = this._config.sftpSettingsPath || '/HumanitZServer/GameServerSettings.ini';
      const settingsBuf: Buffer = this._panelApi?.available
        ? await this._panelApi.downloadFile(settingsPath)
        : ((await (sftp as SftpClient).get(settingsPath)) as Buffer);
      this._serverSettings = _parseIni(settingsBuf.toString('utf8'));
      this._enrichServerSettings();
      // Cache to DB
      try {
        if (this._db) this._db.botState.setStateJSON('server_settings', this._serverSettings);
      } catch (err: unknown) {
        this._log.warn('server_settings cache write failed:', errMsg(err));
      }
      this._log.info(`Parsed server settings: ${Object.keys(this._serverSettings).length} keys`);
    } catch (err: unknown) {
      this._loadCachedServerSettings();
      const msg = (err as Error).message;
      if (!msg.includes('No such file')) {
        this._log.error('Server settings error:', msg);
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
    if (Array.isArray(ws['weatherState'])) {
      const weatherProp = (ws['weatherState'] as unknown[]).find(
        (p): p is { name: string; value: string } =>
          typeof p === 'object' && p !== null && (p as Record<string, unknown>)['name'] === 'CurrentWeather',
      );
      if (weatherProp) {
        this._serverSettings._currentWeather = _resolveUdsWeather(weatherProp.value);
      }
    }
    // Compute total zombie kills across all players from lifetime stats
    let totalZombieKills = 0;
    for (const [, p] of this._saveData) {
      totalZombieKills += Number(p['lifetimeKills']) || Number(p['zeeksKilled']) || 0;
    }
    this._serverSettings._totalZombieKills = totalZombieKills;
  }

  /**
   * Load cached server settings from DB fallback.
   */
  _loadCachedServerSettings() {
    try {
      if (this._db) {
        const cached = this._db.botState.getStateJSON('server_settings', null);
        if (cached && typeof cached === 'object') this._serverSettings = cached as Record<string, unknown>;
      }
    } catch (err: unknown) {
      this._log.warn('server_settings cache read failed:', errMsg(err));
    }
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
      this._structures = structures;
      this._vehicles = vehicles;
      this._horses = horses;
      this._containers = containers;
      this._companions = companions;
      this._lastSaveUpdate = new Date();

      const prevWorldState = this._worldState;
      this._worldState = worldState as Record<string, unknown>;
      this._log.info(`Legacy parse: ${players.size} players (${(buf.length / 1024 / 1024).toFixed(1)}MB)`);

      this._runAccumulate();

      if (prevWorldState && this._config.enableWorldEventFeed && this._logWatcher) {
        void this._detectWorldEvents(prevWorldState, this._worldState);
      }

      // Clan data
      try {
        const _savePath = this._config.sftpSavePath;
        const _slIdx = _savePath.indexOf('SaveList/');
        const clanPath = _slIdx !== -1 ? _savePath.slice(0, _slIdx) + 'Save_ClanData.sav' : _savePath;
        const clanBuf = (await sftp.get(clanPath)) as Buffer;
        this._clanData = parseClanData(clanBuf);
        this._log.info(`Parsed clans: ${this._clanData.length} clans`);
      } catch (err: unknown) {
        const msg = (err as Error).message;
        if (!msg.includes('No such file')) {
          this._log.error('Clan data error:', msg);
        }
      }

      // Server settings
      await this._fetchServerSettings(sftp);

      // Cache leaderboard data
      this._cacheWelcomeStats();

      // Write save-cache.json for web panel (multi-server instances)
      this._writeSaveCache();

      // WelcomeMessage.txt is now managed exclusively by the Welcome File Editor
    } catch (err: unknown) {
      this._log.error('Legacy save poll error:', (err as Error).message);
    } finally {
      await sftp.end().catch(() => {
        // expected: SFTP close may fail after a connection/download error.
      });
    }
  }

  /**
   * Download the save file using fastGet (parallel chunks) for reliability.
   * Falls back to buffered get() if fastGet fails (e.g. permissions issue).
   * Validates file size against remote to detect truncated downloads.
   */
  async _downloadSave(sftp: SftpClient): Promise<Buffer> {
    const remotePath = this._config.sftpSavePath;
    const tmpFile = path.join(os.tmpdir(), `humanitzbot-save-${process.pid}.sav`);

    try {
      // Use fastGet — parallel chunked download, much faster for large files
      const remoteStat = await sftp.stat(remotePath);
      await sftp.fastGet(remotePath, tmpFile);
      const localStat = fs.statSync(tmpFile);

      if (remoteStat.size && localStat.size !== remoteStat.size) {
        this._log.warn(
          `Save download size mismatch: remote=${String(remoteStat.size)} local=${localStat.size}, retrying with buffered get`,
        );
        const buf = (await sftp.get(remotePath)) as Buffer;
        try {
          fs.unlinkSync(tmpFile);
        } catch (_: unknown) {
          // expected: temp file may already be absent after failed fastGet cleanup.
        }
        return buf;
      }

      const buf = fs.readFileSync(tmpFile);
      try {
        fs.unlinkSync(tmpFile);
      } catch (_: unknown) {
        // expected: temp file cleanup is best-effort after a successful read.
      }
      return buf;
    } catch (err: unknown) {
      // fastGet can fail on some SFTP servers — fall back to buffered get
      this._log.warn(`fastGet failed (${(err as Error).message}), using buffered get`);
      try {
        fs.unlinkSync(tmpFile);
      } catch (_: unknown) {
        // expected: temp file may not exist when fastGet fails before writing.
      }
      return sftp.get(remotePath) as Promise<Buffer>;
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
      for (const [id, _save] of this._saveData) {
        const at = this.getAllTimeKills(id);
        const kills = at?.zeeksKilled || 0;
        if (kills <= 0) continue;
        const resolved = this._resolvePlayer(id);
        topKillers.push({ name: resolved.name, kills });
      }
      topKillers.sort((a: { kills: number }, b: { kills: number }) => b.kills - a.kills);

      // ── Top PvP Killers (from logs) ──
      type LogEntry = { id?: string; name?: string; pvpKills?: number };
      const topPvpKillers = (allLog as LogEntry[])
        .filter((p) => (p.pvpKills ?? 0) > 0)
        .map((p) => {
          const resolved = this._resolvePlayer(p.id ?? p.name ?? '');
          return { name: resolved.name, kills: p.pvpKills ?? 0 };
        })
        .sort((a: { kills: number }, b: { kills: number }) => b.kills - a.kills);

      // ── Top Fishers (from save) ──
      const topFishers = [];
      for (const [id, save] of this._saveData) {
        const count = Number(save['fishCaught']) || 0;
        if (count <= 0) continue;
        const resolved = this._resolvePlayer(id);
        topFishers.push({ name: resolved.name, count, pike: Number(save['fishCaughtPike']) || 0 });
      }
      topFishers.sort((a: { count: number }, b: { count: number }) => b.count - a.count);

      // ── Most Bitten (from save) ──
      const topBitten = [];
      for (const [id, save] of this._saveData) {
        const count = Number(save['timesBitten']) || 0;
        if (count <= 0) continue;
        const resolved = this._resolvePlayer(id);
        topBitten.push({ name: resolved.name, count });
      }
      topBitten.sort((a: { count: number }, b: { count: number }) => b.count - a.count);

      // ── Top clans by combined lifetime kills and playtime ──
      const topClans = [];
      for (const clan of this._clanData) {
        let totalKills = 0;
        let totalPlaytimeMs = 0;
        for (const m of clan.members) {
          const sidRaw = m.steamId ?? m.steam_id;
          const sid = typeof sidRaw === 'string' ? sidRaw : undefined;
          const at = sid ? this.getAllTimeKills(sid) : null;
          if (at) totalKills += at.zeeksKilled || 0;
          const pt = sid ? this._playtime.getPlaytime(sid) : null;
          if (pt) totalPlaytimeMs += pt.totalMs || 0;
        }
        topClans.push({
          name: clan.name,
          members: clan.members.length,
          kills: totalKills,
          playtimeMs: totalPlaytimeMs,
        });
      }
      topClans.sort((a: { kills: number }, b: { kills: number }) => b.kills - a.kills);

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
      if (this._db) this._db.botState.setStateJSON('welcome_stats', cache);
    } catch (err: unknown) {
      this._log.error('Failed to cache welcome stats:', (err as Error).message);
    }
  }

  /** Delegate weekly stats to KillTracker */
  _computeWeeklyStats(): Record<string, unknown> | null {
    return this._killTracker.computeWeeklyStats(this._saveData) as Record<string, unknown> | null;
  }

  async _updateEmbed() {
    if (!this.statusMessage) return;
    try {
      const embed = this._buildOverviewEmbed();
      const components = [...this._buildPlayerRow(), ...this._buildClanRow()] as ActionRowBuilder[];

      // Skip Discord API call if content hasn't changed since last edit
      const contentKey = embedContentKey(embed, components);
      if (contentKey === this._lastEmbedKey) return;
      this._lastEmbedKey = contentKey;

      await this.statusMessage.edit({
        embeds: [embed],
        ...(components.length > 0 && { components }),
      } as MessageEditOptions);
    } catch (err: unknown) {
      const discordErr = err as { code?: number; message?: string };
      // Message was deleted externally — re-create it
      if (discordErr.code === 10008) {
        this._log.info('Embed message was deleted, re-creating...');
        try {
          const freshEmbed = this._buildOverviewEmbed();
          const components = [...this._buildPlayerRow(), ...this._buildClanRow()] as ActionRowBuilder[];
          if (this.channel) {
            this.statusMessage = await this.channel.send({
              embeds: [freshEmbed],
              ...(components.length > 0 && { components }),
            } as MessageCreateOptions);
            this._saveMessageId();
          }
        } catch (createErr: unknown) {
          this._log.error('Failed to re-create message:', (createErr as Error).message);
        }
      } else {
        this._log.error('Embed update error:', discordErr.message);
      }
    }
  }

  async _cleanOwnMessage() {
    const savedId = this._loadMessageId();
    type FetchableChannel = import('discord.js').TextBasedChannel & {
      messages: {
        fetch(idOrOpts: string | { limit: number }): Promise<
          Map<string, import('discord.js').Message> & {
            filter(
              fn: (m: import('discord.js').Message) => boolean,
            ): Map<string, import('discord.js').Message> & { size: number };
          }
        >;
      };
    };
    await cleanOwnMessages(this.channel as FetchableChannel, this.client, {
      savedIds: savedId ?? undefined,
      label: this._label,
    });
  }

  _loadMessageId(): string | null {
    try {
      if (this._db) {
        const val = this._db.botState.getState('msg_id_player_stats');
        return val != null && typeof val === 'string' ? val : null;
      }
    } catch {
      // expected: missing/corrupt message-id cache should fall back to creating a fresh status message.
    }
    return null;
  }

  _saveMessageId() {
    if (!this.statusMessage) return;
    try {
      if (this._db) this._db.botState.setState('msg_id_player_stats', this.statusMessage.id);
    } catch {
      // expected: message-id persistence is best-effort and should not block Discord updates.
    }
  }

  /**
   * Download PlayerIDMapped.txt and feed it to PlayerStats so names resolve
   * before the overview embed is built. Reuses the already-open SFTP connection.
   */
  async _refreshIdMap(sftp: SftpClient | null) {
    try {
      const idMapPath = this._config.sftpIdMapPath;
      if (!idMapPath) return;
      const buf: Buffer = this._panelApi?.available
        ? await this._panelApi.downloadFile(idMapPath)
        : ((await (sftp as SftpClient).get(idMapPath)) as Buffer);
      const text = buf.toString('utf8');
      const entries = [];
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const match = trimmed.match(/^(\d{17})_\+_\|[^@]+@(.+)$/);
        if (match?.[1] && match[2]) entries.push({ steamId: match[1], name: match[2].trim() });
      }
      if (entries.length > 0) {
        this._playerStats.loadIdMap(entries);
        this._log.info(`Loaded ${entries.length} name(s) from PlayerIDMapped.txt`);
      }
    } catch (err: unknown) {
      // Not critical — file may not exist on this server
      const msg = (err as Error).message;
      if (!msg.includes('No such file')) {
        this._log.info('Could not read PlayerIDMapped.txt:', msg);
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
    const { deltas, targetDate } = this._killTracker.accumulate(
      this._saveData,
      { gameData: gameData as unknown as NonNullable<Parameters<KillTracker['accumulate']>[1]>['gameData'] }, // SAFETY: game-data types lack generics
    );
    if (this._logWatcher) {
      void this._postActivitySummary(deltas, targetDate);
    }
  }

  /**
   * Send an embed to the correct activity thread for the given date.
   * @param {EmbedBuilder} embed
   * @param {string} [targetDate] - 'YYYY-MM-DD'; defaults to today's thread
   */
  _sendFeedEmbed(embed: EmbedBuilder, targetDate?: string): Promise<unknown> {
    const today = this._config.getToday();
    if (targetDate && targetDate !== today && this._logWatcher?.sendToDateThread) {
      return this._logWatcher.sendToDateThread(embed, targetDate);
    }
    return (this._logWatcher as LogWatcher).sendToThread(embed);
  }

  /**
   * Build a consolidated activity summary embed from all delta types and post
   * a single message to the daily activity thread. This replaces the previous
   * approach of posting 1-10 individual embeds per save poll cycle.
   */
  async _postActivitySummary(deltas: ReturnType<KillTracker['accumulate']>['deltas'], targetDate: string) {
    const sections = [];

    type Deltas = ReturnType<KillTracker['accumulate']>['deltas'];
    type KillDeltaItem = Deltas['killDeltas'][number];
    type SurvDeltaItem = Deltas['survivalDeltas'][number];
    type FishDeltaItem = Deltas['fishingDeltas'][number];
    type RecipeDeltaItem = Deltas['recipeDeltas'][number];
    type SkillDeltaItem = Deltas['skillDeltas'][number];
    type ProfDeltaItem = Deltas['professionDeltas'][number];
    type LoreDeltaItem = Deltas['loreDeltas'][number];
    type UniqueDeltaItem = Deltas['uniqueDeltas'][number];
    type CompDeltaItem = Deltas['companionDeltas'][number];
    type ChallDeltaItem = Deltas['challengeDeltas'][number];

    // ── Kills ──
    if (deltas.killDeltas.length > 0 && this._config.enableKillFeed) {
      const lines = deltas.killDeltas.map(({ name, delta }: KillDeltaItem) => {
        const total = delta.zeeksKilled || 0;
        const parts: string[] = [];
        if (delta.headshots) parts.push(`${delta.headshots} headshot${delta.headshots > 1 ? 's' : ''}`);
        if (delta.meleeKills) parts.push(`${delta.meleeKills} melee`);
        if (delta.gunKills) parts.push(`${delta.gunKills} gun`);
        if (delta.blastKills) parts.push(`${delta.blastKills} blast`);
        if (delta.fistKills) parts.push(`${delta.fistKills} fist`);
        if (delta.takedownKills) parts.push(`${delta.takedownKills} takedown`);
        if (delta.vehicleKills) parts.push(`${delta.vehicleKills} vehicle`);
        const detail = parts.length > 0 ? ` (${parts.join(', ')})` : '';
        return `**${name}** killed **${total} zeek${total !== 1 ? 's' : ''}**${detail}`;
      });
      sections.push({ header: '🧟 Kills', lines });
    }

    // ── Survival ──
    if (deltas.survivalDeltas.length > 0 && this._config.enableKillFeed) {
      const lines = deltas.survivalDeltas.map(({ name, delta }: SurvDeltaItem) => {
        const parts: string[] = [];
        if (delta.daysSurvived) parts.push(`+${delta.daysSurvived} day${delta.daysSurvived > 1 ? 's' : ''} survived`);
        return `**${name}** — ${parts.join(', ')}`;
      });
      sections.push({ header: '🏕️ Survival', lines });
    }

    // ── Fishing ──
    if (deltas.fishingDeltas.length > 0 && this._config.enableFishingFeed) {
      const lines = deltas.fishingDeltas.map(({ name, delta }: FishDeltaItem) => {
        const total = delta.fishCaught || 0;
        const pike = delta.fishCaughtPike || 0;
        const bitten = delta.timesBitten || 0;
        const parts: string[] = [];
        if (total > 0) {
          const pikeNote = pike > 0 ? ` (${pike} pike)` : '';
          parts.push(`caught **${total} fish**${pikeNote}`);
        }
        if (bitten > 0) parts.push(`was bitten **${bitten} time${bitten > 1 ? 's' : ''}**`);
        return `**${name}** ${parts.join(', ')}`;
      });
      sections.push({ header: '🎣 Fishing', lines });
    }

    // ── Recipes ──
    if (deltas.recipeDeltas.length > 0 && this._config.enableRecipeFeed) {
      const lines = deltas.recipeDeltas.map(({ name, type, items }: RecipeDeltaItem) => {
        const names = items.map((r) => _cleanItemName(r)).filter(Boolean);
        const display =
          names.length <= 5 ? names.join(', ') : `${names.slice(0, 5).join(', ')} +${names.length - 5} more`;
        return `**${name}** learned ${type}: ${display}`;
      });
      sections.push({ header: '📖 Recipes', lines });
    }

    // ── Skills ──
    if (deltas.skillDeltas.length > 0 && this._config.enableSkillFeed) {
      const lines = deltas.skillDeltas.map(({ name, items }: SkillDeltaItem) => {
        const names = items.map((s) => _cleanItemName(s).toUpperCase());
        return `**${name}** unlocked skill${names.length > 1 ? 's' : ''}: **${names.join(', ')}**`;
      });
      sections.push({ header: '⚡ Skills', lines });
    }

    // ── Professions ──
    if (deltas.professionDeltas.length > 0 && this._config.enableProfessionFeed) {
      const lines = deltas.professionDeltas.map(({ name, items }: ProfDeltaItem) => {
        const names = items.map((p) => {
          if (typeof p === 'number') return PERK_INDEX_MAP[p] || `Profession #${p}`;
          if (typeof p === 'string') return PERK_MAP[p] || _cleanItemName(p);
          return '';
        });
        return `**${name}** unlocked profession${names.length > 1 ? 's' : ''}: **${names.join(', ')}**`;
      });
      sections.push({ header: '🎓 Professions', lines });
    }

    // ── Lore ──
    if (deltas.loreDeltas.length > 0 && this._config.enableLoreFeed) {
      const lines = deltas.loreDeltas.map(({ name, items }: LoreDeltaItem) => {
        const count = items.length;
        const names = items
          .map((l) => {
            if (typeof l === 'object' && l !== null) {
              const lo = l as Record<string, unknown>;
              return _cleanItemName((lo['name'] ?? lo['id'] ?? JSON.stringify(l)) as string);
            }
            return _cleanItemName(l as string);
          })
          .filter(Boolean);
        const display = names.length > 0 && names.length <= 3 ? `: ${names.join(', ')}` : '';
        return `**${name}** discovered **${count} lore entr${count > 1 ? 'ies' : 'y'}**${display}`;
      });
      sections.push({ header: '📜 Lore', lines });
    }

    // ── Unique Items ──
    if (deltas.uniqueDeltas.length > 0 && this._config.enableUniqueFeed) {
      const lines = deltas.uniqueDeltas.map(({ name, type, items }: UniqueDeltaItem) => {
        const names = items
          .map((u) => {
            if (typeof u === 'object' && u !== null) {
              const uo = u as Record<string, unknown>;
              return _cleanItemName((uo['name'] ?? uo['id'] ?? JSON.stringify(u)) as string);
            }
            return _cleanItemName(u as string);
          })
          .filter(Boolean);
        const display =
          names.length <= 5 ? names.join(', ') : `${names.slice(0, 5).join(', ')} +${names.length - 5} more`;
        return `**${name}** ${type} unique item${items.length > 1 ? 's' : ''}: **${display}**`;
      });
      sections.push({ header: '✨ Unique Items', lines });
    }

    // ── Companions ──
    if (deltas.companionDeltas.length > 0 && this._config.enableCompanionFeed) {
      const lines = deltas.companionDeltas.map(({ name, type, items }: CompDeltaItem) => {
        const count = items.length;
        const emoji = type === 'horse' ? '🐴' : '🐕';
        const label =
          type === 'horse' ? `${count} horse${count > 1 ? 's' : ''}` : `${count} companion${count > 1 ? 's' : ''}`;
        return `${emoji} **${name}** tamed **${label}**`;
      });
      sections.push({ header: '🐾 Companions', lines });
    }

    // ── Challenges ──
    if (deltas.challengeDeltas.length > 0 && this._config.enableChallengeFeed) {
      const lines = deltas.challengeDeltas.flatMap(({ name, completed }: ChallDeltaItem) =>
        (completed as { name: string; desc: string }[]).map((c) => `**${name}** completed **${c.name}** — *${c.desc}*`),
      );
      sections.push({ header: '🏆 Challenges', lines });
    }

    if (sections.length === 0) return;

    // Build consolidated description with section headers, splitting across
    // multiple embeds when the 4096-char description limit would be exceeded.
    const LIMIT = 4000; // margin below Discord's 4096
    const descParts = sections.map(
      (s: { header: string; lines: string[] }) => `**${s.header}**\n${s.lines.join('\n')}`,
    );

    const chunks = [];
    let current = '';
    for (const part of descParts) {
      const addition = current ? `\n\n${part}` : part;
      if (current && current.length + addition.length > LIMIT) {
        chunks.push(current);
        current = part;
      } else {
        current += addition;
      }
    }
    if (current) chunks.push(current);

    try {
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i] ?? '';
        const embed = new EmbedBuilder().setDescription(chunk).setColor(0x5865f2);
        if (i === 0) embed.setAuthor({ name: '📊 Activity Summary' });
        if (i === chunks.length - 1) embed.setTimestamp();
        await this._sendFeedEmbed(embed, targetDate);
      }
    } catch (err: unknown) {
      this._log.error('Failed to post activity summary to thread:', (err as Error).message);
    }
  }

  async _detectWorldEvents(prev: Record<string, unknown>, current: Record<string, unknown>) {
    const lines: string[] = [];

    // Season change
    const prevSeason = typeof prev['currentSeason'] === 'string' ? prev['currentSeason'] : null;
    const curSeason = typeof current['currentSeason'] === 'string' ? current['currentSeason'] : null;
    if (prevSeason && curSeason && prevSeason !== curSeason) {
      const seasonEmoji: Record<string, string> = { Spring: '🌱', Summer: '☀️', Autumn: '🍂', Winter: '❄️' };
      const emoji = seasonEmoji[curSeason] ?? '🔄';
      lines.push(`${emoji} Season changed to **${curSeason}**`);
    }

    // Day milestone (every 10 days)
    const prevDays = prev['daysPassed'];
    const curDays = current['daysPassed'];
    if (prevDays != null && curDays != null) {
      const prevDay = Math.floor(Number(prevDays));
      const curDay = Math.floor(Number(curDays));
      if (curDay > prevDay) {
        // Post milestone at every 10th day, or the first day change after bot start
        if (curDay % 10 === 0 || Math.floor(prevDay / 10) < Math.floor(curDay / 10)) {
          lines.push(`📅 **Day ${curDay}** reached`);
        }
      }
    }

    // Airdrop detected
    if (!prev['airdropActive'] && current['airdropActive']) {
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
    } catch (err: unknown) {
      this._log.error('Failed to post world event feed to activity thread:', (err as Error).message);
    }
  }

  getAllTimeKills(steamId: string) {
    return this._killTracker.getAllTimeKills(steamId, this._saveData);
  }

  getCurrentLifeKills(steamId: string) {
    return this._killTracker.getCurrentLifeKills(steamId, this._saveData);
  }

  getAllTimeSurvival(steamId: string) {
    return this._killTracker.getAllTimeSurvival(steamId, this._saveData);
  }

  getSaveData() {
    return this._saveData;
  }

  getClanData() {
    return this._clanData;
  }

  getServerSettings() {
    return this._serverSettings;
  }
}

function _parseIni(text: string) {
  const result: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) continue;
    const secMatch = trimmed.match(/^\[(.+)\]$/);
    if (secMatch) {
      continue;
    }
    const kvMatch = trimmed.match(/^([^=]+?)=(.*)$/);
    if (kvMatch?.[1] && kvMatch[2] !== undefined) {
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
function _cleanItemName(name: unknown) {
  if (!name) return '';
  const str =
    typeof name === 'string' ? name : typeof name === 'number' || typeof name === 'boolean' ? String(name) : '';
  if (!str) return '';
  const cleaned = _sharedCleanItemName(str);
  return cleaned === 'Unknown' ? '' : cleaned;
}

/** Map UDS (Ultra Dynamic Sky) weather enum values to human-readable names */
const UDS_WEATHER_MAP: Record<string, string> = {
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

function _resolveUdsWeather(enumValue: string) {
  if (!enumValue) return null;
  return (
    UDS_WEATHER_MAP[enumValue] ?? enumValue.replace(/^UDS_WeatherTypes::/, '').replace(/NewEnumerator/, 'Weather ')
  );
}

Object.assign(PlayerStatsChannel.prototype, playerStatsEmbeds);

export default PlayerStatsChannel;
export { PlayerStatsChannel };

export { _parseIni, _cleanItemName, _resolveUdsWeather, _dbRowToSave };

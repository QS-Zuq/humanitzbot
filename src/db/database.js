/**
 * Database manager for the HumanitZ bot.
 *
 * Wraps better-sqlite3 with:
 *   - Auto-initialisation (creates tables on first run)
 *   - Schema versioning & migration
 *   - Convenience query helpers for every data domain
 *   - WAL mode for concurrent reads during bot operation
 *
 * Usage:
 *   const db = require('./db/database');
 *   db.init();                           // call once at startup
 *   db.upsertPlayer(steamId, data);      // write parsed save data
 *   const p = db.getPlayer(steamId);     // read back
 *   db.close();                          // on shutdown
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { SCHEMA_VERSION, ALL_TABLES } = require('./schema');

const DEFAULT_DB_PATH = path.join(__dirname, '..', '..', 'data', 'humanitz.db');

class HumanitZDB {
  /**
   * @param {object} [options]
   * @param {string} [options.dbPath]   - Path to the SQLite file (default: data/humanitz.db)
   * @param {boolean} [options.memory]  - Use in-memory DB (for testing)
   * @param {string} [options.label]    - Log prefix
   */
  constructor(options = {}) {
    this._dbPath = options.dbPath || DEFAULT_DB_PATH;
    this._memory = options.memory || false;
    this._label = options.label || 'DB';
    this._db = null;
    this._stmts = {};  // cached prepared statements
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Lifecycle
  // ═══════════════════════════════════════════════════════════════════════════

  init() {
    if (this._db) return;

    // Ensure data directory exists
    if (!this._memory) {
      const dir = path.dirname(this._dbPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }

    this._db = new Database(this._memory ? ':memory:' : this._dbPath);
    this._db.pragma('journal_mode = WAL');
    this._db.pragma('foreign_keys = ON');
    this._db.pragma('busy_timeout = 5000');

    this._applySchema();
    this._prepareStatements();

    const version = this._getMeta('schema_version');
    console.log(`[${this._label}] Database ready (v${version}, ${this._memory ? 'in-memory' : this._dbPath})`);
  }

  close() {
    if (this._db) {
      this._db.close();
      this._db = null;
      this._stmts = {};
    }
  }

  get db() { return this._db; }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Schema management
  // ═══════════════════════════════════════════════════════════════════════════

  _applySchema() {
    const currentVersion = this._getMetaRaw('schema_version');

    if (!currentVersion) {
      // First run — create all tables
      this._db.exec('BEGIN');
      for (const sql of ALL_TABLES) {
        this._db.exec(sql);
      }
      this._setMeta('schema_version', String(SCHEMA_VERSION));
      this._db.exec('COMMIT');
      console.log(`[${this._label}] Schema created (v${SCHEMA_VERSION})`);
    } else if (parseInt(currentVersion, 10) < SCHEMA_VERSION) {
      // Future: run migration scripts here
      this._setMeta('schema_version', String(SCHEMA_VERSION));
      console.log(`[${this._label}] Schema migrated to v${SCHEMA_VERSION}`);
    }
  }

  _getMetaRaw(key) {
    try {
      // meta table may not exist yet on very first run
      const row = this._db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
      return row ? row.value : null;
    } catch {
      return null;
    }
  }

  _getMeta(key) {
    const row = this._db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
    return row ? row.value : null;
  }

  /** Public meta getter. */
  getMeta(key) { return this._getMeta(key); }

  /** Public meta setter. */
  setMeta(key, value) { return this._setMeta(key, value); }

  _setMeta(key, value) {
    this._db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Prepared statements
  // ═══════════════════════════════════════════════════════════════════════════

  _prepareStatements() {
    // Player upsert — all columns
    this._stmts.upsertPlayer = this._db.prepare(`
      INSERT INTO players (
        steam_id, name, male, starting_perk, affliction, char_profile,
        zeeks_killed, headshots, melee_kills, gun_kills, blast_kills,
        fist_kills, takedown_kills, vehicle_kills,
        lifetime_kills, lifetime_headshots, lifetime_melee_kills,
        lifetime_gun_kills, lifetime_blast_kills, lifetime_fist_kills,
        lifetime_takedown_kills, lifetime_vehicle_kills, lifetime_days_survived,
        has_extended_stats,
        days_survived, times_bitten, bites, fish_caught, fish_caught_pike,
        health, max_health, hunger, max_hunger, thirst, max_thirst,
        stamina, max_stamina, infection, max_infection, battery,
        fatigue, infection_buildup, well_rested, energy, hood, hypo_handle,
        exp,
        pos_x, pos_y, pos_z, rotation_yaw,
        respawn_x, respawn_y, respawn_z,
        cb_radio_cooldown,
        player_states, body_conditions,
        crafting_recipes, building_recipes,
        unlocked_professions, unlocked_skills, skills_data,
        inventory, equipment, quick_slots, backpack_items, backpack_data,
        lore, unique_loots, crafted_uniques, loot_item_unique,
        quest_data, mini_quest, challenges, quest_spawner_done,
        companion_data, horses, extended_stats,
        challenge_kill_zombies, challenge_kill_50, challenge_catch_20_fish,
        challenge_regular_angler, challenge_kill_zombie_bear, challenge_9_squares,
        challenge_craft_firearm, challenge_craft_furnace, challenge_craft_melee_bench,
        challenge_craft_melee_weapon, challenge_craft_rain_collector, challenge_craft_tablesaw,
        challenge_craft_treatment, challenge_craft_weapons_bench, challenge_craft_workbench,
        challenge_find_dog, challenge_find_heli, challenge_lockpick_suv, challenge_repair_radio,
        custom_data, updated_at
      ) VALUES (
        @steam_id, @name, @male, @starting_perk, @affliction, @char_profile,
        @zeeks_killed, @headshots, @melee_kills, @gun_kills, @blast_kills,
        @fist_kills, @takedown_kills, @vehicle_kills,
        @lifetime_kills, @lifetime_headshots, @lifetime_melee_kills,
        @lifetime_gun_kills, @lifetime_blast_kills, @lifetime_fist_kills,
        @lifetime_takedown_kills, @lifetime_vehicle_kills, @lifetime_days_survived,
        @has_extended_stats,
        @days_survived, @times_bitten, @bites, @fish_caught, @fish_caught_pike,
        @health, @max_health, @hunger, @max_hunger, @thirst, @max_thirst,
        @stamina, @max_stamina, @infection, @max_infection, @battery,
        @fatigue, @infection_buildup, @well_rested, @energy, @hood, @hypo_handle,
        @exp,
        @pos_x, @pos_y, @pos_z, @rotation_yaw,
        @respawn_x, @respawn_y, @respawn_z,
        @cb_radio_cooldown,
        @player_states, @body_conditions,
        @crafting_recipes, @building_recipes,
        @unlocked_professions, @unlocked_skills, @skills_data,
        @inventory, @equipment, @quick_slots, @backpack_items, @backpack_data,
        @lore, @unique_loots, @crafted_uniques, @loot_item_unique,
        @quest_data, @mini_quest, @challenges, @quest_spawner_done,
        @companion_data, @horses, @extended_stats,
        @challenge_kill_zombies, @challenge_kill_50, @challenge_catch_20_fish,
        @challenge_regular_angler, @challenge_kill_zombie_bear, @challenge_9_squares,
        @challenge_craft_firearm, @challenge_craft_furnace, @challenge_craft_melee_bench,
        @challenge_craft_melee_weapon, @challenge_craft_rain_collector, @challenge_craft_tablesaw,
        @challenge_craft_treatment, @challenge_craft_weapons_bench, @challenge_craft_workbench,
        @challenge_find_dog, @challenge_find_heli, @challenge_lockpick_suv, @challenge_repair_radio,
        @custom_data, datetime('now')
      )
      ON CONFLICT(steam_id) DO UPDATE SET
        name = excluded.name,
        male = excluded.male,
        starting_perk = excluded.starting_perk,
        affliction = excluded.affliction,
        char_profile = excluded.char_profile,
        zeeks_killed = excluded.zeeks_killed,
        headshots = excluded.headshots,
        melee_kills = excluded.melee_kills,
        gun_kills = excluded.gun_kills,
        blast_kills = excluded.blast_kills,
        fist_kills = excluded.fist_kills,
        takedown_kills = excluded.takedown_kills,
        vehicle_kills = excluded.vehicle_kills,
        lifetime_kills = excluded.lifetime_kills,
        lifetime_headshots = excluded.lifetime_headshots,
        lifetime_melee_kills = excluded.lifetime_melee_kills,
        lifetime_gun_kills = excluded.lifetime_gun_kills,
        lifetime_blast_kills = excluded.lifetime_blast_kills,
        lifetime_fist_kills = excluded.lifetime_fist_kills,
        lifetime_takedown_kills = excluded.lifetime_takedown_kills,
        lifetime_vehicle_kills = excluded.lifetime_vehicle_kills,
        lifetime_days_survived = excluded.lifetime_days_survived,
        has_extended_stats = excluded.has_extended_stats,
        days_survived = excluded.days_survived,
        times_bitten = excluded.times_bitten,
        bites = excluded.bites,
        fish_caught = excluded.fish_caught,
        fish_caught_pike = excluded.fish_caught_pike,
        health = excluded.health,
        max_health = excluded.max_health,
        hunger = excluded.hunger,
        max_hunger = excluded.max_hunger,
        thirst = excluded.thirst,
        max_thirst = excluded.max_thirst,
        stamina = excluded.stamina,
        max_stamina = excluded.max_stamina,
        infection = excluded.infection,
        max_infection = excluded.max_infection,
        battery = excluded.battery,
        fatigue = excluded.fatigue,
        infection_buildup = excluded.infection_buildup,
        well_rested = excluded.well_rested,
        energy = excluded.energy,
        hood = excluded.hood,
        hypo_handle = excluded.hypo_handle,
        exp = excluded.exp,
        pos_x = excluded.pos_x,
        pos_y = excluded.pos_y,
        pos_z = excluded.pos_z,
        rotation_yaw = excluded.rotation_yaw,
        respawn_x = excluded.respawn_x,
        respawn_y = excluded.respawn_y,
        respawn_z = excluded.respawn_z,
        cb_radio_cooldown = excluded.cb_radio_cooldown,
        player_states = excluded.player_states,
        body_conditions = excluded.body_conditions,
        crafting_recipes = excluded.crafting_recipes,
        building_recipes = excluded.building_recipes,
        unlocked_professions = excluded.unlocked_professions,
        unlocked_skills = excluded.unlocked_skills,
        skills_data = excluded.skills_data,
        inventory = excluded.inventory,
        equipment = excluded.equipment,
        quick_slots = excluded.quick_slots,
        backpack_items = excluded.backpack_items,
        backpack_data = excluded.backpack_data,
        lore = excluded.lore,
        unique_loots = excluded.unique_loots,
        crafted_uniques = excluded.crafted_uniques,
        loot_item_unique = excluded.loot_item_unique,
        quest_data = excluded.quest_data,
        mini_quest = excluded.mini_quest,
        challenges = excluded.challenges,
        quest_spawner_done = excluded.quest_spawner_done,
        companion_data = excluded.companion_data,
        horses = excluded.horses,
        extended_stats = excluded.extended_stats,
        challenge_kill_zombies = excluded.challenge_kill_zombies,
        challenge_kill_50 = excluded.challenge_kill_50,
        challenge_catch_20_fish = excluded.challenge_catch_20_fish,
        challenge_regular_angler = excluded.challenge_regular_angler,
        challenge_kill_zombie_bear = excluded.challenge_kill_zombie_bear,
        challenge_9_squares = excluded.challenge_9_squares,
        challenge_craft_firearm = excluded.challenge_craft_firearm,
        challenge_craft_furnace = excluded.challenge_craft_furnace,
        challenge_craft_melee_bench = excluded.challenge_craft_melee_bench,
        challenge_craft_melee_weapon = excluded.challenge_craft_melee_weapon,
        challenge_craft_rain_collector = excluded.challenge_craft_rain_collector,
        challenge_craft_tablesaw = excluded.challenge_craft_tablesaw,
        challenge_craft_treatment = excluded.challenge_craft_treatment,
        challenge_craft_weapons_bench = excluded.challenge_craft_weapons_bench,
        challenge_craft_workbench = excluded.challenge_craft_workbench,
        challenge_find_dog = excluded.challenge_find_dog,
        challenge_find_heli = excluded.challenge_find_heli,
        challenge_lockpick_suv = excluded.challenge_lockpick_suv,
        challenge_repair_radio = excluded.challenge_repair_radio,
        custom_data = excluded.custom_data,
        updated_at = datetime('now')
    `);

    // Fast lookups
    this._stmts.getPlayer = this._db.prepare('SELECT * FROM players WHERE steam_id = ?');
    this._stmts.getAllPlayers = this._db.prepare('SELECT * FROM players ORDER BY lifetime_kills DESC');
    this._stmts.getOnlinePlayers = this._db.prepare('SELECT * FROM players WHERE online = 1');
    this._stmts.setPlayerOnline = this._db.prepare('UPDATE players SET online = ?, last_seen = datetime(\'now\') WHERE steam_id = ?');
    this._stmts.setAllOffline = this._db.prepare('UPDATE players SET online = 0');

    // Leaderboards
    this._stmts.topKillers = this._db.prepare('SELECT steam_id, name, lifetime_kills, lifetime_headshots, lifetime_melee_kills, lifetime_gun_kills FROM players ORDER BY lifetime_kills DESC LIMIT ?');
    this._stmts.topPlaytime = this._db.prepare('SELECT steam_id, name, playtime_seconds, session_count FROM players ORDER BY playtime_seconds DESC LIMIT ?');
    this._stmts.topSurvival = this._db.prepare('SELECT steam_id, name, lifetime_days_survived, days_survived FROM players ORDER BY lifetime_days_survived DESC LIMIT ?');
    this._stmts.topFish = this._db.prepare('SELECT steam_id, name, fish_caught, fish_caught_pike FROM players WHERE fish_caught > 0 ORDER BY fish_caught DESC LIMIT ?');
    this._stmts.topBitten = this._db.prepare('SELECT steam_id, name, times_bitten FROM players WHERE times_bitten > 0 ORDER BY times_bitten DESC LIMIT ?');
    this._stmts.topPvp = this._db.prepare('SELECT steam_id, name, log_pvp_kills, log_pvp_deaths FROM players WHERE log_pvp_kills > 0 ORDER BY log_pvp_kills DESC LIMIT ?');

    // Clans
    this._stmts.upsertClan = this._db.prepare('INSERT OR REPLACE INTO clans (name, updated_at) VALUES (?, datetime(\'now\'))');
    this._stmts.deleteClanMembers = this._db.prepare('DELETE FROM clan_members WHERE clan_name = ?');
    this._stmts.insertClanMember = this._db.prepare('INSERT OR REPLACE INTO clan_members (clan_name, steam_id, name, rank, can_invite, can_kick) VALUES (?, ?, ?, ?, ?, ?)');
    this._stmts.getAllClans = this._db.prepare('SELECT * FROM clans ORDER BY name');
    this._stmts.getClanMembers = this._db.prepare('SELECT * FROM clan_members WHERE clan_name = ? ORDER BY rank DESC, name');

    // World state
    this._stmts.setWorldState = this._db.prepare('INSERT OR REPLACE INTO world_state (key, value, updated_at) VALUES (?, ?, datetime(\'now\'))');
    this._stmts.getWorldState = this._db.prepare('SELECT value FROM world_state WHERE key = ?');
    this._stmts.getAllWorldState = this._db.prepare('SELECT * FROM world_state');

    // Structures
    this._stmts.clearStructures = this._db.prepare('DELETE FROM structures');
    this._stmts.insertStructure = this._db.prepare(`
      INSERT INTO structures (actor_class, display_name, owner_steam_id, pos_x, pos_y, pos_z,
        current_health, max_health, upgrade_level, attached_to_trailer, inventory, no_spawn, extra_data, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `);
    this._stmts.getStructures = this._db.prepare('SELECT * FROM structures ORDER BY actor_class');
    this._stmts.getStructuresByOwner = this._db.prepare('SELECT * FROM structures WHERE owner_steam_id = ?');
    this._stmts.countStructuresByOwner = this._db.prepare('SELECT owner_steam_id, COUNT(*) as count FROM structures GROUP BY owner_steam_id ORDER BY count DESC');

    // Vehicles
    this._stmts.clearVehicles = this._db.prepare('DELETE FROM vehicles');
    this._stmts.insertVehicle = this._db.prepare(`
      INSERT INTO vehicles (class, display_name, pos_x, pos_y, pos_z, health, max_health, fuel, inventory, upgrades, extra, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `);
    this._stmts.getAllVehicles = this._db.prepare('SELECT * FROM vehicles');

    // Companions
    this._stmts.clearCompanions = this._db.prepare('DELETE FROM companions');
    this._stmts.insertCompanion = this._db.prepare(`
      INSERT INTO companions (type, actor_name, owner_steam_id, pos_x, pos_y, pos_z, health, extra, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `);
    this._stmts.getAllCompanions = this._db.prepare('SELECT * FROM companions');

    // Dead bodies
    this._stmts.clearDeadBodies = this._db.prepare('DELETE FROM dead_bodies');
    this._stmts.insertDeadBody = this._db.prepare('INSERT OR REPLACE INTO dead_bodies (actor_name, pos_x, pos_y, pos_z, updated_at) VALUES (?, ?, ?, ?, datetime(\'now\'))');

    // Containers
    this._stmts.clearContainers = this._db.prepare('DELETE FROM containers');
    this._stmts.insertContainer = this._db.prepare('INSERT OR REPLACE INTO containers (actor_name, items, pos_x, pos_y, pos_z, updated_at) VALUES (?, ?, ?, ?, ?, datetime(\'now\'))');

    // Loot actors
    this._stmts.clearLootActors = this._db.prepare('DELETE FROM loot_actors');
    this._stmts.insertLootActor = this._db.prepare('INSERT INTO loot_actors (name, type, pos_x, pos_y, pos_z, items, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime(\'now\'))');

    // Quests
    this._stmts.clearQuests = this._db.prepare('DELETE FROM quests');
    this._stmts.insertQuest = this._db.prepare('INSERT INTO quests (id, type, state, data, updated_at) VALUES (?, ?, ?, ?, datetime(\'now\'))');

    // Server settings
    this._stmts.upsertSetting = this._db.prepare('INSERT OR REPLACE INTO server_settings (key, value, updated_at) VALUES (?, ?, datetime(\'now\'))');
    this._stmts.getSetting = this._db.prepare('SELECT value FROM server_settings WHERE key = ?');
    this._stmts.getAllSettings = this._db.prepare('SELECT * FROM server_settings ORDER BY key');

    // Game reference
    this._stmts.upsertGameItem = this._db.prepare('INSERT OR REPLACE INTO game_items (id, name, description, category, icon, blueprint, stack_size, extra) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    this._stmts.getGameItem = this._db.prepare('SELECT * FROM game_items WHERE id = ?');
    this._stmts.searchGameItems = this._db.prepare('SELECT * FROM game_items WHERE name LIKE ? OR id LIKE ? LIMIT 20');

    // Snapshots
    this._stmts.insertSnapshot = this._db.prepare('INSERT INTO snapshots (type, steam_id, data) VALUES (?, ?, ?)');
    this._stmts.getLatestSnapshot = this._db.prepare('SELECT * FROM snapshots WHERE type = ? AND steam_id = ? ORDER BY created_at DESC LIMIT 1');
    this._stmts.purgeOldSnapshots = this._db.prepare('DELETE FROM snapshots WHERE created_at < datetime(\'now\', ?)');

    // Meta
    this._stmts.getMeta = this._db.prepare('SELECT value FROM meta WHERE key = ?');
    this._stmts.setMeta = this._db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Player CRUD
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Upsert a player record from parsed save data.
   * @param {string} steamId
   * @param {object} data - Flat object matching column names (from save parser)
   */
  upsertPlayer(steamId, data) {
    const params = {
      steam_id: steamId,
      name: data.name || '',
      male: data.male ? 1 : 0,
      starting_perk: data.startingPerk || 'Unknown',
      affliction: data.affliction || 0,
      char_profile: _json(data.charProfile),
      zeeks_killed: data.zeeksKilled || 0,
      headshots: data.headshots || 0,
      melee_kills: data.meleeKills || 0,
      gun_kills: data.gunKills || 0,
      blast_kills: data.blastKills || 0,
      fist_kills: data.fistKills || 0,
      takedown_kills: data.takedownKills || 0,
      vehicle_kills: data.vehicleKills || 0,
      lifetime_kills: data.lifetimeKills || 0,
      lifetime_headshots: data.lifetimeHeadshots || 0,
      lifetime_melee_kills: data.lifetimeMeleeKills || 0,
      lifetime_gun_kills: data.lifetimeGunKills || 0,
      lifetime_blast_kills: data.lifetimeBlastKills || 0,
      lifetime_fist_kills: data.lifetimeFistKills || 0,
      lifetime_takedown_kills: data.lifetimeTakedownKills || 0,
      lifetime_vehicle_kills: data.lifetimeVehicleKills || 0,
      lifetime_days_survived: data.lifetimeDaysSurvived || 0,
      has_extended_stats: data.hasExtendedStats ? 1 : 0,
      days_survived: data.daysSurvived || 0,
      times_bitten: data.timesBitten || 0,
      bites: data.bites || 0,
      fish_caught: data.fishCaught || 0,
      fish_caught_pike: data.fishCaughtPike || 0,
      health: data.health || 0,
      max_health: data.maxHealth || 0,
      hunger: data.hunger || 0,
      max_hunger: data.maxHunger || 0,
      thirst: data.thirst || 0,
      max_thirst: data.maxThirst || 0,
      stamina: data.stamina || 0,
      max_stamina: data.maxStamina || 0,
      infection: data.infection || 0,
      max_infection: data.maxInfection || 0,
      battery: data.battery || 100,
      fatigue: data.fatigue || 0,
      infection_buildup: data.infectionBuildup || 0,
      well_rested: data.wellRested || 0,
      energy: data.energy || 0,
      hood: data.hood || 0,
      hypo_handle: data.hypoHandle || 0,
      exp: data.exp || 0,
      pos_x: data.x ?? null,
      pos_y: data.y ?? null,
      pos_z: data.z ?? null,
      rotation_yaw: data.rotationYaw ?? null,
      respawn_x: data.respawnX ?? null,
      respawn_y: data.respawnY ?? null,
      respawn_z: data.respawnZ ?? null,
      cb_radio_cooldown: data.cbRadioCooldown || 0,
      player_states: _json(data.playerStates),
      body_conditions: _json(data.bodyConditions),
      crafting_recipes: _json(data.craftingRecipes),
      building_recipes: _json(data.buildingRecipes),
      unlocked_professions: _json(data.unlockedProfessions),
      unlocked_skills: _json(data.unlockedSkills),
      skills_data: _json(data.skillsData),
      inventory: _json(data.inventory),
      equipment: _json(data.equipment),
      quick_slots: _json(data.quickSlots),
      backpack_items: _json(data.backpackItems),
      backpack_data: _json(data.backpackData),
      lore: _json(data.lore),
      unique_loots: _json(data.uniqueLoots),
      crafted_uniques: _json(data.craftedUniques),
      loot_item_unique: _json(data.lootItemUnique),
      quest_data: _json(data.questData),
      mini_quest: _json(data.miniQuest),
      challenges: _json(data.challenges),
      quest_spawner_done: _json(data.questSpawnerDone),
      companion_data: _json(data.companionData),
      horses: _json(data.horses),
      extended_stats: _json(data.extendedStats),
      challenge_kill_zombies: data.challengeKillZombies || 0,
      challenge_kill_50: data.challengeKill50 || 0,
      challenge_catch_20_fish: data.challengeCatch20Fish || 0,
      challenge_regular_angler: data.challengeRegularAngler || 0,
      challenge_kill_zombie_bear: data.challengeKillZombieBear || 0,
      challenge_9_squares: data.challenge9Squares || 0,
      challenge_craft_firearm: data.challengeCraftFirearm || 0,
      challenge_craft_furnace: data.challengeCraftFurnace || 0,
      challenge_craft_melee_bench: data.challengeCraftMeleeBench || 0,
      challenge_craft_melee_weapon: data.challengeCraftMeleeWeapon || 0,
      challenge_craft_rain_collector: data.challengeCraftRainCollector || 0,
      challenge_craft_tablesaw: data.challengeCraftTablesaw || 0,
      challenge_craft_treatment: data.challengeCraftTreatment || 0,
      challenge_craft_weapons_bench: data.challengeCraftWeaponsBench || 0,
      challenge_craft_workbench: data.challengeCraftWorkbench || 0,
      challenge_find_dog: data.challengeFindDog || 0,
      challenge_find_heli: data.challengeFindHeli || 0,
      challenge_lockpick_suv: data.challengeLockpickSUV || 0,
      challenge_repair_radio: data.challengeRepairRadio || 0,
      custom_data: _json(data.customData),
    };

    this._stmts.upsertPlayer.run(params);
  }

  getPlayer(steamId) {
    const row = this._stmts.getPlayer.get(steamId);
    return row ? _parsePlayerRow(row) : null;
  }

  getAllPlayers() {
    return this._stmts.getAllPlayers.all().map(_parsePlayerRow);
  }

  getOnlinePlayers() {
    return this._stmts.getOnlinePlayers.all().map(_parsePlayerRow);
  }

  setPlayerOnline(steamId, online) {
    this._stmts.setPlayerOnline.run(online ? 1 : 0, steamId);
  }

  setAllPlayersOffline() {
    this._stmts.setAllOffline.run();
  }

  /** Update log-based stats for a player. */
  updatePlayerLogStats(steamId, logData) {
    const existing = this._stmts.getPlayer.get(steamId);
    if (!existing) return;

    this._db.prepare(`
      UPDATE players SET
        log_deaths = ?, log_pvp_kills = ?, log_pvp_deaths = ?,
        log_builds = ?, log_loots = ?, log_damage_taken = ?,
        log_raids_out = ?, log_raids_in = ?, log_last_event = ?,
        updated_at = datetime('now')
      WHERE steam_id = ?
    `).run(
      logData.deaths || 0, logData.pvpKills || 0, logData.pvpDeaths || 0,
      logData.builds || 0, logData.loots || 0, logData.damageTaken || 0,
      logData.raidsOut || 0, logData.raidsIn || 0, logData.lastEvent || null,
      steamId
    );
  }

  /** Update playtime for a player. */
  updatePlayerPlaytime(steamId, playtimeSeconds, sessionCount) {
    this._db.prepare(`
      UPDATE players SET playtime_seconds = ?, session_count = ?, updated_at = datetime('now')
      WHERE steam_id = ?
    `).run(playtimeSeconds, sessionCount, steamId);
  }

  /** Update kill tracker JSON for a player. */
  updateKillTracker(steamId, killData) {
    this._db.prepare('UPDATE players SET kill_tracker = ?, updated_at = datetime(\'now\') WHERE steam_id = ?')
      .run(JSON.stringify(killData), steamId);
  }

  /** Update name and name history. */
  updatePlayerName(steamId, name, nameHistory) {
    this._db.prepare('UPDATE players SET name = ?, name_history = ?, updated_at = datetime(\'now\') WHERE steam_id = ?')
      .run(name, JSON.stringify(nameHistory || []), steamId);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Leaderboards
  // ═══════════════════════════════════════════════════════════════════════════

  topKillers(limit = 10) { return this._stmts.topKillers.all(limit); }
  topPlaytime(limit = 10) { return this._stmts.topPlaytime.all(limit); }
  topSurvival(limit = 10) { return this._stmts.topSurvival.all(limit); }
  topFish(limit = 10) { return this._stmts.topFish.all(limit); }
  topBitten(limit = 10) { return this._stmts.topBitten.all(limit); }
  topPvp(limit = 10) { return this._stmts.topPvp.all(limit); }

  /** Aggregate server totals. */
  getServerTotals() {
    return this._db.prepare(`
      SELECT
        COUNT(*) as total_players,
        SUM(CASE WHEN online = 1 THEN 1 ELSE 0 END) as online_players,
        SUM(lifetime_kills) as total_kills,
        SUM(lifetime_headshots) as total_headshots,
        SUM(lifetime_days_survived) as total_days,
        SUM(log_deaths) as total_deaths,
        SUM(log_pvp_kills) as total_pvp_kills,
        SUM(log_builds) as total_builds,
        SUM(log_loots) as total_loots,
        SUM(fish_caught) as total_fish,
        SUM(playtime_seconds) as total_playtime
      FROM players
    `).get();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Clans
  // ═══════════════════════════════════════════════════════════════════════════

  upsertClan(name, members) {
    this._stmts.upsertClan.run(name);
    this._stmts.deleteClanMembers.run(name);
    for (const m of members) {
      this._stmts.insertClanMember.run(name, m.steamId, m.name, m.rank, m.canInvite ? 1 : 0, m.canKick ? 1 : 0);
    }
  }

  getAllClans() {
    const clans = this._stmts.getAllClans.all();
    return clans.map(c => ({
      ...c,
      members: this._stmts.getClanMembers.all(c.name),
    }));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  World state
  // ═══════════════════════════════════════════════════════════════════════════

  setWorldState(key, value) { this._stmts.setWorldState.run(key, String(value)); }
  getWorldState(key) { const r = this._stmts.getWorldState.get(key); return r ? r.value : null; }
  getAllWorldState() {
    const rows = this._stmts.getAllWorldState.all();
    const result = {};
    for (const r of rows) result[r.key] = r.value;
    return result;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Structures
  // ═══════════════════════════════════════════════════════════════════════════

  replaceStructures(structures) {
    const insert = this._db.transaction((items) => {
      this._stmts.clearStructures.run();
      for (const s of items) {
        this._stmts.insertStructure.run(
          s.actorClass, s.displayName || '', s.ownerSteamId || '',
          s.x ?? null, s.y ?? null, s.z ?? null,
          s.currentHealth || 0, s.maxHealth || 0, s.upgradeLevel || 0,
          s.attachedToTrailer ? 1 : 0, _json(s.inventory), s.noSpawn ? 1 : 0,
          s.extraData || ''
        );
      }
    });
    insert(structures);
  }

  getStructures() { return this._stmts.getStructures.all(); }
  getStructuresByOwner(steamId) { return this._stmts.getStructuresByOwner.all(steamId); }
  getStructureCounts() { return this._stmts.countStructuresByOwner.all(); }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Vehicles
  // ═══════════════════════════════════════════════════════════════════════════

  replaceVehicles(vehicles) {
    const insert = this._db.transaction((items) => {
      this._stmts.clearVehicles.run();
      for (const v of items) {
        this._stmts.insertVehicle.run(
          v.class, v.displayName || '',
          v.x ?? null, v.y ?? null, v.z ?? null,
          v.health || 0, v.maxHealth || 0, v.fuel || 0,
          _json(v.inventory), _json(v.upgrades), _json(v.extra)
        );
      }
    });
    insert(vehicles);
  }

  getAllVehicles() { return this._stmts.getAllVehicles.all(); }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Companions
  // ═══════════════════════════════════════════════════════════════════════════

  replaceCompanions(companions) {
    const insert = this._db.transaction((items) => {
      this._stmts.clearCompanions.run();
      for (const c of items) {
        this._stmts.insertCompanion.run(
          c.type, c.actorName,
          c.ownerSteamId || '',
          c.x ?? null, c.y ?? null, c.z ?? null,
          c.health || 0, _json(c.extra)
        );
      }
    });
    insert(companions);
  }

  getAllCompanions() { return this._stmts.getAllCompanions.all(); }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Dead bodies
  // ═══════════════════════════════════════════════════════════════════════════

  replaceDeadBodies(bodies) {
    const insert = this._db.transaction((items) => {
      this._stmts.clearDeadBodies.run();
      for (const b of items) {
        this._stmts.insertDeadBody.run(
          b.actorName, b.x ?? null, b.y ?? null, b.z ?? null
        );
      }
    });
    insert(bodies);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Containers
  // ═══════════════════════════════════════════════════════════════════════════

  replaceContainers(containers) {
    const insert = this._db.transaction((items) => {
      this._stmts.clearContainers.run();
      for (const c of items) {
        this._stmts.insertContainer.run(
          c.actorName, JSON.stringify(c.items), c.x ?? null, c.y ?? null, c.z ?? null
        );
      }
    });
    insert(containers);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Loot actors
  // ═══════════════════════════════════════════════════════════════════════════

  replaceLootActors(lootActors) {
    const insert = this._db.transaction((items) => {
      this._stmts.clearLootActors.run();
      for (const la of items) {
        this._stmts.insertLootActor.run(
          la.name, la.type, la.x ?? null, la.y ?? null, la.z ?? null, JSON.stringify(la.items)
        );
      }
    });
    insert(lootActors);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Quests
  // ═══════════════════════════════════════════════════════════════════════════

  replaceQuests(quests) {
    const insert = this._db.transaction((items) => {
      this._stmts.clearQuests.run();
      for (const q of items) {
        this._stmts.insertQuest.run(
          q.id, q.type, q.state, JSON.stringify(q.data)
        );
      }
    });
    insert(quests);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Server settings
  // ═══════════════════════════════════════════════════════════════════════════

  upsertSettings(settings) {
    const upsert = this._db.transaction((obj) => {
      for (const [key, value] of Object.entries(obj)) {
        this._stmts.upsertSetting.run(key, String(value));
      }
    });
    upsert(settings);
  }

  getSetting(key) { const r = this._stmts.getSetting.get(key); return r ? r.value : null; }
  getAllSettings() {
    const rows = this._stmts.getAllSettings.all();
    const result = {};
    for (const r of rows) result[r.key] = r.value;
    return result;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Snapshots (for weekly/daily deltas)
  // ═══════════════════════════════════════════════════════════════════════════

  createSnapshot(type, steamId, data) {
    this._stmts.insertSnapshot.run(type, steamId, JSON.stringify(data));
  }

  getLatestSnapshot(type, steamId) {
    const row = this._stmts.getLatestSnapshot.get(type, steamId);
    return row ? { ...row, data: JSON.parse(row.data || '{}') } : null;
  }

  purgeSnapshots(olderThan) {
    this._stmts.purgeOldSnapshots.run(olderThan);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Bulk operations (for save-to-DB sync)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Bulk-upsert all players from a parsed save file.
   * Runs in a single transaction for performance (~1ms for 50 players).
   * @param {Map<string, object>} players - steamId → parsed player data
   */
  bulkUpsertPlayers(players) {
    const tx = this._db.transaction((entries) => {
      for (const [steamId, data] of entries) {
        this.upsertPlayer(steamId, data);
      }
    });
    tx([...players.entries()]);
  }

  /**
   * Full save sync: replace all player data, structures, vehicles, etc.
   * Everything in one transaction for atomicity.
   */
  syncFromSave(parsed) {
    const tx = this._db.transaction(() => {
      // Players
      if (parsed.players) {
        for (const [steamId, data] of parsed.players) {
          this.upsertPlayer(steamId, data);
        }
      }

      // World state
      if (parsed.worldState) {
        for (const [key, value] of Object.entries(parsed.worldState)) {
          this._stmts.setWorldState.run(key, String(value));
        }
      }

      // Structures
      if (parsed.structures) {
        this._stmts.clearStructures.run();
        for (const s of parsed.structures) {
          this._stmts.insertStructure.run(
            s.actorClass, s.displayName || '', s.ownerSteamId || '',
            s.x ?? null, s.y ?? null, s.z ?? null,
            s.currentHealth || 0, s.maxHealth || 0, s.upgradeLevel || 0,
            s.attachedToTrailer ? 1 : 0, _json(s.inventory), s.noSpawn ? 1 : 0,
            s.extraData || ''
          );
        }
      }

      // Vehicles
      if (parsed.vehicles) {
        this._stmts.clearVehicles.run();
        for (const v of parsed.vehicles) {
          this._stmts.insertVehicle.run(
            v.class, v.displayName || '',
            v.x ?? null, v.y ?? null, v.z ?? null,
            v.health || 0, v.maxHealth || 0, v.fuel || 0,
            _json(v.inventory), _json(v.upgrades), _json(v.extra)
          );
        }
      }

      // Companions
      if (parsed.companions) {
        this._stmts.clearCompanions.run();
        for (const c of parsed.companions) {
          this._stmts.insertCompanion.run(
            c.type, c.actorName, c.ownerSteamId || '',
            c.x ?? null, c.y ?? null, c.z ?? null,
            c.health || 0, _json(c.extra)
          );
        }
      }

      // Clans
      if (parsed.clans) {
        for (const clan of parsed.clans) {
          this._stmts.upsertClan.run(clan.name);
          this._stmts.deleteClanMembers.run(clan.name);
          for (const m of clan.members) {
            this._stmts.insertClanMember.run(clan.name, m.steamId, m.name, m.rank, m.canInvite ? 1 : 0, m.canKick ? 1 : 0);
          }
        }
      }

      // Server settings
      if (parsed.serverSettings) {
        for (const [key, value] of Object.entries(parsed.serverSettings)) {
          this._stmts.upsertSetting.run(key, String(value));
        }
      }
    });

    tx();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Game reference data seeding
  // ═══════════════════════════════════════════════════════════════════════════

  seedGameItems(items) {
    const tx = this._db.transaction((list) => {
      for (const item of list) {
        this._stmts.upsertGameItem.run(
          item.id, item.name, item.description || '', item.category || '',
          item.icon || '', item.blueprint || '', item.stackSize || 1,
          _json(item.extra)
        );
      }
    });
    tx(items);
  }

  getGameItem(id) { return this._stmts.getGameItem.get(id); }
  searchGameItems(query) { const q = `%${query}%`; return this._stmts.searchGameItems.all(q, q); }

  seedGameProfessions(professions) {
    const stmt = this._db.prepare('INSERT OR REPLACE INTO game_professions (id, enum_value, enum_index, perk, description, affliction, skills) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const tx = this._db.transaction((list) => {
      for (const p of list) {
        stmt.run(p.id, p.enumValue || '', p.enumIndex || 0, p.perk || '', p.description || '', p.affliction || '', _json(p.skills));
      }
    });
    tx(professions);
  }

  seedGameAfflictions(afflictions) {
    const stmt = this._db.prepare('INSERT OR REPLACE INTO game_afflictions (idx, name, description, icon) VALUES (?, ?, ?, ?)');
    const tx = this._db.transaction((list) => {
      for (const a of list) {
        stmt.run(a.idx, a.name, a.description || '', a.icon || '');
      }
    });
    tx(afflictions);
  }

  seedGameSkills(skills) {
    const stmt = this._db.prepare('INSERT OR REPLACE INTO game_skills (id, name, description, effect, category, icon) VALUES (?, ?, ?, ?, ?, ?)');
    const tx = this._db.transaction((list) => {
      for (const s of list) {
        stmt.run(s.id, s.name, s.description || '', s.effect || '', s.category || '', s.icon || '');
      }
    });
    tx(skills);
  }

  seedGameChallenges(challenges) {
    const stmt = this._db.prepare('INSERT OR REPLACE INTO game_challenges (id, name, description, save_field, target) VALUES (?, ?, ?, ?, ?)');
    const tx = this._db.transaction((list) => {
      for (const c of list) {
        stmt.run(c.id, c.name, c.description || '', c.saveField || '', c.target || 0);
      }
    });
    tx(challenges);
  }

  seedLoadingTips(tips) {
    const stmt = this._db.prepare('INSERT OR REPLACE INTO game_loading_tips (id, text, category) VALUES (?, ?, ?)');
    const tx = this._db.transaction((list) => {
      for (let i = 0; i < list.length; i++) {
        stmt.run(i + 1, list[i].text || list[i], list[i].category || '');
      }
    });
    tx(tips);
  }

  getRandomTip() {
    return this._db.prepare('SELECT text FROM game_loading_tips ORDER BY RANDOM() LIMIT 1').get();
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function _json(value) {
  if (value === undefined || value === null) return '[]';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function _parsePlayerRow(row) {
  if (!row) return null;
  // Parse JSON columns back to objects
  const jsonCols = [
    'name_history', 'char_profile', 'player_states', 'body_conditions',
    'crafting_recipes', 'building_recipes', 'unlocked_professions', 'unlocked_skills',
    'skills_data', 'inventory', 'equipment', 'quick_slots', 'backpack_items',
    'backpack_data', 'lore', 'unique_loots', 'crafted_uniques', 'loot_item_unique',
    'quest_data', 'mini_quest', 'challenges', 'quest_spawner_done',
    'companion_data', 'horses', 'extended_stats', 'kill_tracker', 'custom_data',
  ];
  const parsed = { ...row };
  for (const col of jsonCols) {
    if (parsed[col] && typeof parsed[col] === 'string') {
      try { parsed[col] = JSON.parse(parsed[col]); } catch { /* leave as string */ }
    }
  }
  // Convert SQLite integers to booleans where appropriate
  parsed.male = !!parsed.male;
  parsed.online = !!parsed.online;
  parsed.has_extended_stats = !!parsed.has_extended_stats;
  return parsed;
}

module.exports = HumanitZDB;

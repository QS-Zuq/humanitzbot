import type Database from 'better-sqlite3';
import { BaseRepository } from './base-repository.js';
import { _json, type DbRow } from './db-utils.js';

function _parsePlayerRow(row: unknown): DbRow | null {
  if (!row) return null;
  // Parse JSON columns back to objects
  const jsonCols = [
    'name_history',
    'char_profile',
    'player_states',
    'body_conditions',
    'crafting_recipes',
    'building_recipes',
    'unlocked_professions',
    'unlocked_skills',
    'skills_data',
    'inventory',
    'equipment',
    'quick_slots',
    'backpack_items',
    'backpack_data',
    'lore',
    'unique_loots',
    'crafted_uniques',
    'loot_item_unique',
    'quest_data',
    'mini_quest',
    'challenges',
    'quest_spawner_done',
    'companion_data',
    'horses',
    'extended_stats',
    'kill_tracker',
    'custom_data',
  ];
  const parsed: DbRow = { ...(row as DbRow) };
  for (const col of jsonCols) {
    if (parsed[col] && typeof parsed[col] === 'string') {
      try {
        parsed[col] = JSON.parse(parsed[col]) as unknown;
      } catch {
        /* leave as string */
      }
    }
  }
  // Convert SQLite integers to booleans where appropriate
  parsed.male = !!parsed.male;
  parsed.online = !!parsed.online;
  parsed.has_extended_stats = !!parsed.has_extended_stats;
  return parsed;
}

/**
 * Lightweight player row parser for the diff engine.
 * Only parses the 4 inventory JSON columns needed by diffPlayerInventories().
 * Avoids the { ...row } spread + 27-column JSON.parse of _parsePlayerRow().
 */

function _parsePlayerRowForDiff(row: unknown): DbRow | null {
  if (!row) return null;
  const r = row as DbRow;
  const parsed: DbRow = {
    steam_id: r.steam_id,
    name: r.name,
    online: !!r.online,
    pos_x: r.pos_x,
    pos_y: r.pos_y,
    pos_z: r.pos_z,
    inventory: null,
    equipment: null,
    quick_slots: null,
    backpack_items: null,
  };
  for (const col of ['inventory', 'equipment', 'quick_slots', 'backpack_items'] as const) {
    if (r[col] && typeof r[col] === 'string') {
      try {
        parsed[col] = JSON.parse(r[col]) as unknown;
      } catch {
        parsed[col] = r[col];
      }
    }
  }
  return parsed;
}

export class PlayerRepository extends BaseRepository {
  declare private _stmts: {
    upsertPlayer: Database.Statement;
    getPlayer: Database.Statement;
    getAllPlayers: Database.Statement;
    getOnlinePlayers: Database.Statement;
    getOnlinePlayersForDiff: Database.Statement;
    setPlayerOnline: Database.Statement;
    setAllOffline: Database.Statement;
    upsertPlayerLogStats: Database.Statement;
    getAllPlayerLogStats: Database.Statement;
    upsertPlayerPlaytime: Database.Statement;
    getAllPlayerPlaytime: Database.Statement;
    setServerPeak: Database.Statement;
    getServerPeak: Database.Statement;
    getAllServerPeaks: Database.Statement;
    upsertAlias: Database.Statement;
    clearCurrentAlias: Database.Statement;
    lookupBySteamId: Database.Statement;
    lookupByName: Database.Statement;
    lookupByNameLike: Database.Statement;
    getAllAliases: Database.Statement;
    getAliasStats: Database.Statement;
  };

  protected _prepareStatements(): void {
    // Player upsert — all columns
    this._stmts = {
      upsertPlayer: this._handle.prepare(`
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
        exp, level, exp_current, exp_required, skills_point,
        pos_x, pos_y, pos_z, rotation_yaw,
        respawn_x, respawn_y, respawn_z,
        cb_radio_cooldown, day_incremented, infection_timer,
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
        custom_data, first_seen, last_seen, updated_at
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
        @exp, @level, @exp_current, @exp_required, @skills_point,
        @pos_x, @pos_y, @pos_z, @rotation_yaw,
        @respawn_x, @respawn_y, @respawn_z,
        @cb_radio_cooldown, @day_incremented, @infection_timer,
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
        @custom_data, datetime('now'), datetime('now'), datetime('now')
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
        level = excluded.level,
        exp_current = excluded.exp_current,
        exp_required = excluded.exp_required,
        skills_point = excluded.skills_point,
        pos_x = excluded.pos_x,
        pos_y = excluded.pos_y,
        pos_z = excluded.pos_z,
        rotation_yaw = excluded.rotation_yaw,
        respawn_x = excluded.respawn_x,
        respawn_y = excluded.respawn_y,
        respawn_z = excluded.respawn_z,
        cb_radio_cooldown = excluded.cb_radio_cooldown,
        day_incremented = excluded.day_incremented,
        infection_timer = excluded.infection_timer,
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
        last_seen = datetime('now'),
        updated_at = datetime('now')
    `),

      // Fast lookups
      getPlayer: this._handle.prepare('SELECT * FROM players WHERE steam_id = ?'),
      getAllPlayers: this._handle.prepare('SELECT * FROM players ORDER BY lifetime_kills DESC'),
      getOnlinePlayers: this._handle.prepare('SELECT * FROM players WHERE online = 1'),
      getOnlinePlayersForDiff: this._handle.prepare(
        'SELECT steam_id, name, online, inventory, equipment, quick_slots, backpack_items, pos_x, pos_y, pos_z FROM players WHERE online = 1',
      ),
      setPlayerOnline: this._handle.prepare(
        "UPDATE players SET online = ?, last_seen = datetime('now') WHERE steam_id = ?",
      ),
      setAllOffline: this._handle.prepare('UPDATE players SET online = 0'),

      // Full log stats upsert — used by DB-first player-stats
      upsertPlayerLogStats: this._handle.prepare(`
      INSERT INTO players (steam_id, name, log_deaths, log_pvp_kills, log_pvp_deaths,
        log_builds, log_loots, log_damage_taken, log_raids_out, log_raids_in,
        log_connects, log_disconnects, log_admin_access, log_destroyed_out, log_destroyed_in,
        log_build_items, log_killed_by, log_damage_detail, log_cheat_flags, log_last_event,
        first_seen, last_seen, updated_at)
      VALUES (@steam_id, @name, @log_deaths, @log_pvp_kills, @log_pvp_deaths,
        @log_builds, @log_loots, @log_damage_taken, @log_raids_out, @log_raids_in,
        @log_connects, @log_disconnects, @log_admin_access, @log_destroyed_out, @log_destroyed_in,
        @log_build_items, @log_killed_by, @log_damage_detail, @log_cheat_flags, @log_last_event,
        datetime('now'), datetime('now'), datetime('now'))
      ON CONFLICT(steam_id) DO UPDATE SET
        name = CASE WHEN excluded.name != '' THEN excluded.name ELSE players.name END,
        log_deaths = excluded.log_deaths,
        log_pvp_kills = excluded.log_pvp_kills,
        log_pvp_deaths = excluded.log_pvp_deaths,
        log_builds = excluded.log_builds,
        log_loots = excluded.log_loots,
        log_damage_taken = excluded.log_damage_taken,
        log_raids_out = excluded.log_raids_out,
        log_raids_in = excluded.log_raids_in,
        log_connects = excluded.log_connects,
        log_disconnects = excluded.log_disconnects,
        log_admin_access = excluded.log_admin_access,
        log_destroyed_out = excluded.log_destroyed_out,
        log_destroyed_in = excluded.log_destroyed_in,
        log_build_items = excluded.log_build_items,
        log_killed_by = excluded.log_killed_by,
        log_damage_detail = excluded.log_damage_detail,
        log_cheat_flags = excluded.log_cheat_flags,
        log_last_event = excluded.log_last_event,
        updated_at = datetime('now')
    `),

      // Full playtime upsert — used by DB-first playtime-tracker
      // Uses MAX() to NEVER reduce existing values — prevents data loss if
      // the tracker restarts with empty in-memory state.
      upsertPlayerPlaytime: this._handle.prepare(`
      INSERT INTO players (steam_id, name, playtime_seconds, session_count,
        playtime_first_seen, playtime_last_login, playtime_last_seen,
        first_seen, last_seen, updated_at)
      VALUES (@steam_id, @name, @playtime_seconds, @session_count,
        @playtime_first_seen, @playtime_last_login, @playtime_last_seen,
        datetime('now'), datetime('now'), datetime('now'))
      ON CONFLICT(steam_id) DO UPDATE SET
        name = CASE WHEN excluded.name != '' THEN excluded.name ELSE players.name END,
        playtime_seconds = MAX(players.playtime_seconds, excluded.playtime_seconds),
        session_count = MAX(players.session_count, excluded.session_count),
        playtime_first_seen = CASE
          WHEN players.playtime_first_seen IS NULL THEN excluded.playtime_first_seen
          WHEN excluded.playtime_first_seen IS NULL THEN players.playtime_first_seen
          WHEN excluded.playtime_first_seen < players.playtime_first_seen THEN excluded.playtime_first_seen
          ELSE players.playtime_first_seen END,
        playtime_last_login = CASE
          WHEN excluded.playtime_last_login > COALESCE(players.playtime_last_login, '') THEN excluded.playtime_last_login
          ELSE players.playtime_last_login END,
        playtime_last_seen = CASE
          WHEN excluded.playtime_last_seen > COALESCE(players.playtime_last_seen, '') THEN excluded.playtime_last_seen
          ELSE players.playtime_last_seen END,
        updated_at = datetime('now')
    `),

      // Get all player log stats (for loading into in-memory cache)
      getAllPlayerLogStats: this._handle.prepare(`
      SELECT steam_id, name, log_deaths, log_pvp_kills, log_pvp_deaths,
        log_builds, log_loots, log_damage_taken, log_raids_out, log_raids_in,
        log_connects, log_disconnects, log_admin_access, log_destroyed_out, log_destroyed_in,
        log_build_items, log_killed_by, log_damage_detail, log_cheat_flags, log_last_event
      FROM players
      WHERE log_deaths > 0 OR log_pvp_kills > 0 OR log_builds > 0
        OR log_loots > 0 OR log_raids_out > 0 OR log_connects > 0
        OR log_admin_access > 0
    `),

      // Get all player playtime (for loading into in-memory cache)
      getAllPlayerPlaytime: this._handle.prepare(`
      SELECT steam_id, name, playtime_seconds, session_count,
        playtime_first_seen, playtime_last_login, playtime_last_seen
      FROM players
      WHERE playtime_seconds > 0 OR session_count > 0
    `),

      // Server peaks
      setServerPeak: this._handle.prepare(
        "INSERT OR REPLACE INTO server_peaks (key, value, updated_at) VALUES (?, ?, datetime('now'))",
      ),
      getServerPeak: this._handle.prepare('SELECT value FROM server_peaks WHERE key = ?'),
      getAllServerPeaks: this._handle.prepare('SELECT * FROM server_peaks'),

      // ── Player aliases (identity resolution) ──
      upsertAlias: this._handle.prepare(`
      INSERT INTO player_aliases (steam_id, name, name_lower, source, first_seen, last_seen, is_current)
      VALUES (?, ?, ?, ?, datetime('now'), datetime('now'), 1)
      ON CONFLICT(steam_id, name_lower) DO UPDATE SET
        name = excluded.name,
        last_seen = datetime('now'),
        source = CASE
          WHEN excluded.source IN ('idmap', 'connect_log') THEN excluded.source
          ELSE player_aliases.source
        END,
        is_current = excluded.is_current
    `),
      clearCurrentAlias: this._handle.prepare(
        'UPDATE player_aliases SET is_current = 0 WHERE steam_id = ? AND source = ?',
      ),
      lookupBySteamId: this._handle.prepare(
        'SELECT * FROM player_aliases WHERE steam_id = ? ORDER BY is_current DESC, last_seen DESC',
      ),
      lookupByName: this._handle.prepare(
        'SELECT * FROM player_aliases WHERE name_lower = ? ORDER BY is_current DESC, last_seen DESC',
      ),
      lookupByNameLike: this._handle.prepare(
        'SELECT * FROM player_aliases WHERE name_lower LIKE ? ORDER BY is_current DESC, last_seen DESC LIMIT 10',
      ),
      getAllAliases: this._handle.prepare('SELECT * FROM player_aliases ORDER BY steam_id, last_seen DESC'),
      getAliasStats: this._handle.prepare(
        'SELECT COUNT(DISTINCT steam_id) as unique_players, COUNT(*) as total_aliases FROM player_aliases',
      ),
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Player CRUD
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Upsert a player record from parsed save data.
   * @param {string} steamId
   * @param {object} data - Flat object matching column names (from save parser)
   */
  upsertPlayer(steamId: string, data: Record<string, unknown>) {
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
      max_health: data.maxHealth || 100,
      hunger: data.hunger || 0,
      max_hunger: data.maxHunger || 100,
      thirst: data.thirst || 0,
      max_thirst: data.maxThirst || 100,
      stamina: data.stamina || 0,
      max_stamina: data.maxStamina || 100,
      infection: data.infection || 0,
      max_infection: data.maxInfection || 100,
      battery: data.battery || 100,
      fatigue: data.fatigue || 0,
      infection_buildup: data.infectionBuildup || 0,
      well_rested: data.wellRested || 0,
      energy: data.energy || 0,
      hood: data.hood || 0,
      hypo_handle: data.hypoHandle || 0,
      exp: data.exp || 0,
      level: data.level || 0,
      exp_current: data.expCurrent || 0,
      exp_required: data.expRequired || 0,
      skills_point: data.skillPoints || 0,
      pos_x: data.x ?? null,
      pos_y: data.y ?? null,
      pos_z: data.z ?? null,
      rotation_yaw: data.rotationYaw ?? null,
      respawn_x: data.respawnX ?? null,
      respawn_y: data.respawnY ?? null,
      respawn_z: data.respawnZ ?? null,
      cb_radio_cooldown: data.cbRadioCooldown || 0,
      day_incremented: data.dayIncremented ? 1 : 0,
      infection_timer: data.infectionTimer || 0,
      player_states: _json(data.playerStates),
      body_conditions: _json(data.bodyConditions),
      crafting_recipes: _json(data.craftingRecipes),
      building_recipes: _json(data.buildingRecipes),
      unlocked_professions: _json(data.unlockedProfessions),
      unlocked_skills: _json(data.unlockedSkills),
      skills_data: _json(data.skillTree || data.skillsData),
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

    // Auto-register alias when a name is available
    if (data.name && /^\d{17}$/.test(steamId)) {
      this.registerAlias(steamId, data.name as string, 'save');
    }
  }

  getPlayer(steamId: string) {
    const row = this._stmts.getPlayer.get(steamId);
    return row ? _parsePlayerRow(row) : null;
  }

  getAllPlayers(): DbRow[] {
    return this._stmts.getAllPlayers
      .all()
      .map(_parsePlayerRow)
      .filter((r): r is DbRow => r !== null);
  }

  getOnlinePlayers(): DbRow[] {
    return this._stmts.getOnlinePlayers
      .all()
      .map(_parsePlayerRow)
      .filter((r): r is DbRow => r !== null);
  }

  /**
   * Lightweight query for diff engine — only columns needed for inventory comparison.
   * Returns online players with only inventory/equipment/quick_slots/backpack_items + identity/position.
   * Avoids the full 133-column SELECT * + 27-column JSON parse that causes OOM on large servers.
   */
  getOnlinePlayersForDiff() {
    return this._stmts.getOnlinePlayersForDiff.all().map(_parsePlayerRowForDiff);
  }

  setPlayerOnline(steamId: string, online: boolean) {
    this._stmts.setPlayerOnline.run(online ? 1 : 0, steamId);
  }

  setAllPlayersOffline() {
    this._stmts.setAllOffline.run();
  }

  /** Update kill tracker JSON for a player. */
  updateKillTracker(steamId: string, killData: Record<string, unknown>) {
    this._handle
      .prepare("UPDATE players SET kill_tracker = ?, updated_at = datetime('now') WHERE steam_id = ?")
      .run(JSON.stringify(killData), steamId);
  }

  /** Update name and name history. */
  updatePlayerName(steamId: string, name: string, nameHistory: unknown[]) {
    this._handle
      .prepare("UPDATE players SET name = ?, name_history = ?, updated_at = datetime('now') WHERE steam_id = ?")
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- defensive: untyped callers may pass null
      .run(name, JSON.stringify(nameHistory ?? []), steamId);
  }

  /**
   * Upsert full player log stats (DB-first — called by player-stats.js on every record call).
   * Creates the player row if it doesn't exist.
   */
  upsertFullLogStats(steamId: string, data: Record<string, unknown>) {
    this._stmts.upsertPlayerLogStats.run({
      steam_id: steamId,
      name: data.name || '',
      log_deaths: data.deaths || 0,
      log_pvp_kills: data.pvpKills || 0,
      log_pvp_deaths: data.pvpDeaths || 0,
      log_builds: data.builds || 0,
      log_loots: data.containersLooted || 0,
      log_damage_taken: data.damageTakenTotal || 0,
      log_raids_out: data.raidsOut || 0,
      log_raids_in: data.raidsIn || 0,
      log_connects: data.connects || 0,
      log_disconnects: data.disconnects || 0,
      log_admin_access: data.adminAccess || 0,
      log_destroyed_out: data.destroyedOut || 0,
      log_destroyed_in: data.destroyedIn || 0,
      log_build_items: JSON.stringify(data.buildItems || {}),
      log_killed_by: JSON.stringify(data.killedBy || {}),
      log_damage_detail: JSON.stringify(data.damageTaken || {}),
      log_cheat_flags: JSON.stringify(data.cheatFlags || []),
      log_last_event: data.lastEvent || null,
    });
  }

  /**
   * Get all player log stats from DB (for loading into PlayerStats cache on startup).
   * Returns an array of objects matching the DB columns.
   */
  getAllPlayerLogStats(): DbRow[] {
    return this._stmts.getAllPlayerLogStats.all() as DbRow[];
  }

  /**
   * Upsert full playtime data (DB-first — called by playtime-tracker.js).
   * Creates the player row if it doesn't exist.
   */
  upsertFullPlaytime(steamId: string, data: Record<string, unknown>) {
    this._stmts.upsertPlayerPlaytime.run({
      steam_id: steamId,
      name: data.name || '',
      playtime_seconds: Math.floor((Number(data.totalMs) || 0) / 1000),
      session_count: data.sessions || 0,
      playtime_first_seen: data.firstSeen || null,
      playtime_last_login: data.lastLogin || null,
      playtime_last_seen: data.lastSeen || null,
    });
  }

  /**
   * Get all player playtime from DB (for loading into PlaytimeTracker cache on startup).
   */
  getAllPlayerPlaytime(): DbRow[] {
    return this._stmts.getAllPlayerPlaytime.all() as DbRow[];
  }

  /**
   * Set a server peak value (e.g. all_time_peak, today_peak, unique_today).
   */
  setServerPeak(key: string, value: unknown): void {
    const stored =
      value != null && typeof value === 'object'
        ? JSON.stringify(value)
        : String((value ?? '') as string | number | boolean);
    this._stmts.setServerPeak.run(key, stored);
  }

  /**
   * Get a server peak value.
   */
  getServerPeak(key: string) {
    const r = this._stmts.getServerPeak.get(key) as DbRow | undefined;
    return r ? r.value : null;
  }

  /**
   * Get all server peak values as a flat object.
   */
  getAllServerPeaks() {
    const rows = this._stmts.getAllServerPeaks.all() as DbRow[];
    const result: Record<string, unknown> = {};
    for (const r of rows) result[r.key as string] = r.value;
    return result;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Player identity / alias resolution
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Register a name ↔ SteamID association from any data source.
   * This is the single entry point for building the identity graph.
   *
   * @param {string} steamId - 17-digit SteamID64
   * @param {string} name    - Player display name
   * @param {string} source  - Origin: 'idmap', 'save', 'connect_log', 'log', 'playtime', 'manual'
   */
  registerAlias(steamId: string, name: string, source: string = '') {
    if (!steamId || !name || !/^\d{17}$/.test(steamId)) return;
    const nameLower = name.toLowerCase().trim();
    if (!nameLower) return;

    // Mark previous aliases from this source as non-current
    this._stmts.clearCurrentAlias.run(steamId, source);
    // Upsert the new alias
    this._stmts.upsertAlias.run(steamId, name.trim(), nameLower, source);
  }

  /**
   * Bulk-register aliases from a parsed PlayerIDMapped.txt.
   * @param {Array<{steamId: string, name: string}>} entries
   */
  importIdMap(entries: Array<{ steamId: string; name: string }>): void {
    const tx = this._handle.transaction((list: Array<{ steamId: string; name: string }>) => {
      for (const { steamId, name } of list) {
        this.registerAlias(steamId, name, 'idmap');
      }
    });
    tx(entries);
  }

  /**
   * Bulk-register aliases from parsed PlayerConnectedLog.txt.
   * @param {Array<{steamId: string, name: string}>} entries
   */
  importConnectLog(entries: Array<{ steamId: string; name: string }>): void {
    const tx = this._handle.transaction((list: Array<{ steamId: string; name: string }>) => {
      for (const { steamId, name } of list) {
        this.registerAlias(steamId, name, 'connect_log');
      }
    });
    tx(entries);
  }

  /**
   * Register aliases from save parser output (keyed by SteamID, name from idMap).
   * @param {Map<string, object>} players - steamId → playerData (with .name if injected)
   */
  importFromSave(players: Map<string, Record<string, unknown>>) {
    const tx = this._handle.transaction(() => {
      for (const [steamId, data] of players) {
        if (typeof data.name === 'string') this.registerAlias(steamId, data.name, 'save');
      }
    });
    tx();
  }

  /**
   * Resolve a player name to a SteamID64.
   * Returns the best match: most recent, highest-priority source.
   *
   * @param {string} name - Player name (case-insensitive)
   * @returns {{ steamId: string, name: string, source: string, isCurrent: boolean } | null}
   */
  resolveNameToSteamId(name: string) {
    if (!name) return null;
    const nameLower = name.toLowerCase().trim();

    // If it's already a SteamID, return directly
    if (/^\d{17}$/.test(name)) return { steamId: name, name, source: 'direct', isCurrent: true };

    const rows = this._stmts.lookupByName.all(nameLower) as DbRow[];
    if (rows.length === 0) return null;

    // Prefer is_current=1 entries, then most recently seen
    const first = rows[0] as DbRow;
    return {
      steamId: first.steam_id,
      name: first.name,
      source: first.source,
      isCurrent: !!first.is_current,
    };
  }

  /**
   * Resolve a SteamID to the best current display name.
   *
   * Priority: idmap > connect_log > save > playtime > log
   *
   * @param {string} steamId
   * @returns {string} Display name, or the steamId itself as fallback
   */
  resolveSteamIdToName(steamId: string) {
    if (!steamId) return steamId;

    const rows = this._stmts.lookupBySteamId.all(steamId) as DbRow[];
    if (rows.length === 0) return steamId;

    // Source priority for "best name"
    const priority: Record<string, number> = { idmap: 5, connect_log: 4, save: 3, playtime: 2, log: 1, manual: 0 };

    // Among is_current=1 entries, pick the highest-priority source
    const current = rows.filter((r) => r.is_current);
    if (current.length > 0) {
      current.sort((a, b) => (priority[b.source as string] ?? 0) - (priority[a.source as string] ?? 0));
      return (current[0] as DbRow).name as string;
    }

    // Fallback: most recently seen alias
    return (rows[0] as DbRow).name as string;
  }

  /**
   * Get all known aliases for a SteamID.
   * @param {string} steamId
   * @returns {Array<{ name: string, source: string, firstSeen: string, lastSeen: string, isCurrent: boolean }>}
   */
  getPlayerAliases(steamId: string) {
    return (this._stmts.lookupBySteamId.all(steamId) as DbRow[]).map((r) => ({
      name: r.name,
      source: r.source,
      firstSeen: r.first_seen,
      lastSeen: r.last_seen,
      isCurrent: !!r.is_current,
    }));
  }

  /**
   * Search for players by partial name match.
   * @param {string} query - Partial name (case-insensitive)
   * @returns {Array<{ steamId: string, name: string, source: string }>}
   */
  searchPlayersByName(query: string) {
    if (!query) return [];
    const rows = this._stmts.lookupByNameLike.all(`%${query.toLowerCase().trim()}%`) as DbRow[];
    // Deduplicate by steamId, keeping the best for each
    const seen = new Map<unknown, { steamId: unknown; name: unknown; source: unknown }>();
    for (const r of rows) {
      if (!seen.has(r.steam_id) || r.is_current) {
        seen.set(r.steam_id, { steamId: r.steam_id, name: r.name, source: r.source });
      }
    }
    return [...seen.values()];
  }

  /**
   * Get summary stats about the alias table.
   * @returns {{ uniquePlayers: number, totalAliases: number }}
   */
  getAliasStats() {
    const row = this._stmts.getAliasStats.get() as DbRow | undefined;
    return { uniquePlayers: row?.unique_players || 0, totalAliases: row?.total_aliases || 0 };
  }
}

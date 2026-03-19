/**
 * SQLite schema for the HumanitZ bot database.
 *
 * Tables are grouped into three categories:
 *   1. Player data   — everything per-player from the save file + logs
 *   2. World data    — global server state, structures, vehicles, companions
 *   3. Game reference — static game data from extracted pak datatables
 *
 * Schema is applied via database.js on first run and auto-migrated on updates.
 */

const SCHEMA_VERSION = 15;

// ─── Player data ────────────────────────────────────────────────────────────

const PLAYERS = `
CREATE TABLE IF NOT EXISTS players (
  steam_id        TEXT PRIMARY KEY,
  name            TEXT NOT NULL DEFAULT '',
  name_history    TEXT DEFAULT '[]',           -- JSON array of { name, until }
  first_seen      TEXT,                        -- ISO timestamp
  last_seen       TEXT,                        -- ISO timestamp
  online          INTEGER DEFAULT 0,           -- 1 = currently online

  -- Character creation
  male            INTEGER DEFAULT 1,           -- boolean
  starting_perk   TEXT DEFAULT 'Unknown',      -- profession name (resolved)
  affliction      INTEGER DEFAULT 0,           -- affliction index
  char_profile    TEXT DEFAULT '{}',           -- JSON: appearance/customisation

  -- Current-life kill stats (GameStats map — resets on death)
  zeeks_killed    INTEGER DEFAULT 0,
  headshots       INTEGER DEFAULT 0,
  melee_kills     INTEGER DEFAULT 0,
  gun_kills       INTEGER DEFAULT 0,
  blast_kills     INTEGER DEFAULT 0,
  fist_kills      INTEGER DEFAULT 0,
  takedown_kills  INTEGER DEFAULT 0,
  vehicle_kills   INTEGER DEFAULT 0,

  -- Lifetime stats (Statistics array — persist across deaths)
  lifetime_kills          INTEGER DEFAULT 0,
  lifetime_headshots      INTEGER DEFAULT 0,
  lifetime_melee_kills    INTEGER DEFAULT 0,
  lifetime_gun_kills      INTEGER DEFAULT 0,
  lifetime_blast_kills    INTEGER DEFAULT 0,
  lifetime_fist_kills     INTEGER DEFAULT 0,
  lifetime_takedown_kills INTEGER DEFAULT 0,
  lifetime_vehicle_kills  INTEGER DEFAULT 0,
  lifetime_days_survived  INTEGER DEFAULT 0,
  has_extended_stats      INTEGER DEFAULT 0,

  -- Activity / survival
  days_survived   INTEGER DEFAULT 0,
  times_bitten    INTEGER DEFAULT 0,
  bites           INTEGER DEFAULT 0,           -- current bite count
  fish_caught     INTEGER DEFAULT 0,
  fish_caught_pike INTEGER DEFAULT 0,

  -- Vitals (snapshot)
  health          REAL DEFAULT 0,
  max_health      REAL DEFAULT 0,
  hunger          REAL DEFAULT 0,
  max_hunger      REAL DEFAULT 0,
  thirst          REAL DEFAULT 0,
  max_thirst      REAL DEFAULT 0,
  stamina         REAL DEFAULT 0,
  max_stamina     REAL DEFAULT 0,
  infection       REAL DEFAULT 0,
  max_infection   REAL DEFAULT 0,
  battery         REAL DEFAULT 100,

  -- Float data
  fatigue              REAL DEFAULT 0,
  infection_buildup    REAL DEFAULT 0,
  well_rested          REAL DEFAULT 0,
  energy               REAL DEFAULT 0,
  hood                 REAL DEFAULT 0,
  hypo_handle          REAL DEFAULT 0,

  -- Experience / progression
  exp             REAL DEFAULT 0,              -- XPGained (lifetime cumulative — misleading at 2M)
  level           INTEGER DEFAULT 0,           -- current player level
  exp_current     REAL DEFAULT 0,              -- XP progress toward next level
  exp_required    REAL DEFAULT 0,              -- XP needed for next level
  skills_point    INTEGER DEFAULT 0,           -- available skill points

  -- Position
  pos_x           REAL,
  pos_y           REAL,
  pos_z           REAL,
  rotation_yaw    REAL,

  -- Respawn point
  respawn_x       REAL,
  respawn_y       REAL,
  respawn_z       REAL,

  -- Day / infection timers
  day_incremented   INTEGER DEFAULT 0,        -- boolean: day counter incremented this life
  infection_timer   REAL DEFAULT 0,            -- current infection timer value

  -- CB Radio
  cb_radio_cooldown REAL DEFAULT 0,

  -- Status effects (JSON arrays of tag strings)
  player_states    TEXT DEFAULT '[]',
  body_conditions  TEXT DEFAULT '[]',

  -- Recipes (JSON arrays of recipe name strings)
  crafting_recipes TEXT DEFAULT '[]',
  building_recipes TEXT DEFAULT '[]',

  -- Skills & professions (JSON arrays)
  unlocked_professions TEXT DEFAULT '[]',      -- ByteProperty array
  unlocked_skills      TEXT DEFAULT '[]',      -- name strings
  skills_data          TEXT DEFAULT '[]',      -- full skill tree JSON

  -- Inventory (JSON arrays of { item, amount, durability })
  inventory       TEXT DEFAULT '[]',
  equipment       TEXT DEFAULT '[]',
  quick_slots     TEXT DEFAULT '[]',
  backpack_items  TEXT DEFAULT '[]',
  backpack_data   TEXT DEFAULT '{}',           -- full backpack save struct

  -- Lore collected (JSON array of lore IDs)
  lore            TEXT DEFAULT '[]',

  -- Unique items (JSON arrays)
  unique_loots    TEXT DEFAULT '[]',           -- found unique items
  crafted_uniques TEXT DEFAULT '[]',           -- crafted unique items
  loot_item_unique TEXT DEFAULT '[]',          -- unique loot items encountered

  -- Quest / challenge progress (JSON)
  quest_data      TEXT DEFAULT '[]',
  mini_quest      TEXT DEFAULT '{}',
  challenges      TEXT DEFAULT '[]',
  quest_spawner_done TEXT DEFAULT '[]',

  -- Companion data (JSON)
  companion_data  TEXT DEFAULT '[]',           -- dogs/animals following player
  horses          TEXT DEFAULT '[]',           -- horse data

  -- Extended stats (JSON — raw statistics array from save)
  extended_stats  TEXT DEFAULT '[]',

  -- Challenge progress (parsed from Statistics)
  challenge_kill_zombies     INTEGER DEFAULT 0,
  challenge_kill_50          INTEGER DEFAULT 0,
  challenge_catch_20_fish    INTEGER DEFAULT 0,
  challenge_regular_angler   INTEGER DEFAULT 0,
  challenge_kill_zombie_bear INTEGER DEFAULT 0,
  challenge_9_squares        INTEGER DEFAULT 0,
  challenge_craft_firearm    INTEGER DEFAULT 0,
  challenge_craft_furnace    INTEGER DEFAULT 0,
  challenge_craft_melee_bench INTEGER DEFAULT 0,
  challenge_craft_melee_weapon INTEGER DEFAULT 0,
  challenge_craft_rain_collector INTEGER DEFAULT 0,
  challenge_craft_tablesaw   INTEGER DEFAULT 0,
  challenge_craft_treatment  INTEGER DEFAULT 0,
  challenge_craft_weapons_bench INTEGER DEFAULT 0,
  challenge_craft_workbench  INTEGER DEFAULT 0,
  challenge_find_dog         INTEGER DEFAULT 0,
  challenge_find_heli        INTEGER DEFAULT 0,
  challenge_lockpick_suv     INTEGER DEFAULT 0,
  challenge_repair_radio     INTEGER DEFAULT 0,

  -- Custom data (JSON — game's CustomData map)
  custom_data     TEXT DEFAULT '{}',

  -- Kill tracking (for delta/accumulation across deaths)
  kill_tracker    TEXT DEFAULT '{}',           -- JSON: cumulative banks, snapshots, checkpoints

  -- Log-based stats (from LogWatcher / PlayerStats)
  log_deaths      INTEGER DEFAULT 0,
  log_pvp_kills   INTEGER DEFAULT 0,
  log_pvp_deaths  INTEGER DEFAULT 0,
  log_builds      INTEGER DEFAULT 0,
  log_loots       INTEGER DEFAULT 0,
  log_damage_taken INTEGER DEFAULT 0,
  log_raids_out   INTEGER DEFAULT 0,
  log_raids_in    INTEGER DEFAULT 0,
  log_last_event  TEXT,                        -- ISO timestamp
  log_connects    INTEGER DEFAULT 0,
  log_disconnects INTEGER DEFAULT 0,
  log_admin_access INTEGER DEFAULT 0,
  log_destroyed_out INTEGER DEFAULT 0,
  log_destroyed_in INTEGER DEFAULT 0,
  log_build_items TEXT DEFAULT '{}',           -- JSON: { itemName: count }
  log_killed_by   TEXT DEFAULT '{}',           -- JSON: { cause: count }
  log_damage_detail TEXT DEFAULT '{}',         -- JSON: { source: count }
  log_cheat_flags TEXT DEFAULT '[]',           -- JSON: [{ type, timestamp }]

  -- Playtime (from PlaytimeTracker)
  playtime_seconds   INTEGER DEFAULT 0,
  session_count      INTEGER DEFAULT 0,
  playtime_first_seen TEXT,                    -- ISO timestamp
  playtime_last_login TEXT,                    -- ISO timestamp
  playtime_last_seen  TEXT,                    -- ISO timestamp

  -- Metadata
  updated_at      TEXT DEFAULT (datetime('now'))
);
`;

// ─── Clans ──────────────────────────────────────────────────────────────────

const CLANS = `
CREATE TABLE IF NOT EXISTS clans (
  name       TEXT PRIMARY KEY,
  updated_at TEXT DEFAULT (datetime('now'))
);
`;

const CLAN_MEMBERS = `
CREATE TABLE IF NOT EXISTS clan_members (
  clan_name  TEXT NOT NULL REFERENCES clans(name) ON DELETE CASCADE,
  steam_id   TEXT NOT NULL,
  name       TEXT DEFAULT '',
  rank       TEXT DEFAULT 'Member',
  can_invite INTEGER DEFAULT 0,
  can_kick   INTEGER DEFAULT 0,
  PRIMARY KEY (clan_name, steam_id)
);
`;

// ─── Player aliases (unified identity resolution) ───────────────────────────

const PLAYER_ALIASES = `
CREATE TABLE IF NOT EXISTS player_aliases (
  steam_id    TEXT NOT NULL,
  name        TEXT NOT NULL,
  name_lower  TEXT NOT NULL,               -- pre-lowercased for fast lookup
  source      TEXT NOT NULL DEFAULT '',    -- 'idmap', 'save', 'connect_log', 'log', 'playtime', 'manual'
  first_seen  TEXT DEFAULT (datetime('now')),
  last_seen   TEXT DEFAULT (datetime('now')),
  is_current  INTEGER DEFAULT 1,           -- 1 = this is the player's current name from this source
  PRIMARY KEY (steam_id, name_lower)
);
CREATE INDEX IF NOT EXISTS idx_aliases_name_lower ON player_aliases(name_lower);
CREATE INDEX IF NOT EXISTS idx_aliases_steam ON player_aliases(steam_id);
`;

// ─── World state ────────────────────────────────────────────────────────────

const WORLD_STATE = `
CREATE TABLE IF NOT EXISTS world_state (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);
`;
// Stores: dedi_days_passed, current_season, current_season_day, random_seed,
//         uses_steam_uid, weather (UDS), game_diff, airdrop

// ─── Structures (buildings placed by players) ───────────────────────────────

const STRUCTURES = `
CREATE TABLE IF NOT EXISTS structures (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_class     TEXT NOT NULL,                -- blueprint path
  display_name    TEXT DEFAULT '',              -- resolved human name
  owner_steam_id  TEXT DEFAULT '',
  pos_x           REAL,
  pos_y           REAL,
  pos_z           REAL,
  current_health  REAL DEFAULT 0,
  max_health      REAL DEFAULT 0,
  upgrade_level   INTEGER DEFAULT 0,
  attached_to_trailer INTEGER DEFAULT 0,
  inventory       TEXT DEFAULT '[]',           -- JSON: items stored in structure
  no_spawn        INTEGER DEFAULT 0,           -- BuildActorsNoSpawn flag
  extra_data      TEXT DEFAULT '',              -- BuildActorData string
  updated_at      TEXT DEFAULT (datetime('now'))
);
`;

// ─── Vehicles ───────────────────────────────────────────────────────────────

const VEHICLES = `
CREATE TABLE IF NOT EXISTS vehicles (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  class           TEXT NOT NULL,                -- blueprint path
  display_name    TEXT DEFAULT '',              -- resolved human name
  pos_x           REAL,
  pos_y           REAL,
  pos_z           REAL,
  health          REAL DEFAULT 0,
  max_health      REAL DEFAULT 0,
  fuel            REAL DEFAULT 0,
  inventory       TEXT DEFAULT '[]',           -- JSON: trunk items
  upgrades        TEXT DEFAULT '[]',           -- JSON: installed upgrades
  extra           TEXT DEFAULT '{}',           -- JSON: any other car properties
  updated_at      TEXT DEFAULT (datetime('now'))
);
`;

// ─── Companions (dogs / animals in the world) ───────────────────────────────

const COMPANIONS = `
CREATE TABLE IF NOT EXISTS companions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  type            TEXT NOT NULL,                -- 'dog' | 'horse'
  actor_name      TEXT NOT NULL,                -- e.g. BP_GDog_Companion11_5
  owner_steam_id  TEXT DEFAULT '',
  pos_x           REAL,
  pos_y           REAL,
  pos_z           REAL,
  health          REAL DEFAULT 0,
  extra           TEXT DEFAULT '{}',
  updated_at      TEXT DEFAULT (datetime('now'))
);
`;

// ─── World horses (global horse entities with full state) ───────────────────

const WORLD_HORSES = `
CREATE TABLE IF NOT EXISTS world_horses (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_name      TEXT NOT NULL DEFAULT '',     -- unique horse actor name
  class           TEXT DEFAULT '',              -- blueprint class
  display_name    TEXT DEFAULT '',              -- human-readable horse name
  horse_name      TEXT DEFAULT '',              -- player-given name
  owner_steam_id  TEXT DEFAULT '',
  pos_x           REAL,
  pos_y           REAL,
  pos_z           REAL,
  health          REAL DEFAULT 0,
  max_health      REAL DEFAULT 0,
  energy          REAL DEFAULT 0,
  stamina         REAL DEFAULT 0,
  saddle_inventory TEXT DEFAULT '[]',           -- JSON: saddle items
  inventory       TEXT DEFAULT '[]',            -- JSON: horse inventory items
  extra           TEXT DEFAULT '{}',            -- JSON: any additional properties
  updated_at      TEXT DEFAULT (datetime('now'))
);
`;

// ─── Dead bodies / loot drops ───────────────────────────────────────────────

const DEAD_BODIES = `
CREATE TABLE IF NOT EXISTS dead_bodies (
  actor_name TEXT PRIMARY KEY,
  pos_x      REAL,
  pos_y      REAL,
  pos_z      REAL,
  updated_at TEXT DEFAULT (datetime('now'))
);
`;

// ─── Containers (global storage — not player inventory) ─────────────────────

const CONTAINERS = `
CREATE TABLE IF NOT EXISTS containers (
  actor_name TEXT PRIMARY KEY,
  items      TEXT DEFAULT '[]',                -- JSON array of inventory items
  quick_slots TEXT DEFAULT '[]',               -- JSON array of quick slot items
  locked     INTEGER DEFAULT 0,                -- container is locked
  does_spawn_loot INTEGER DEFAULT 0,           -- container spawns loot naturally
  alarm_off  INTEGER DEFAULT 0,                -- alarm disabled
  crafting_content TEXT DEFAULT '[]',           -- JSON: items being crafted
  pos_x      REAL,
  pos_y      REAL,
  pos_z      REAL,
  extra      TEXT DEFAULT '{}',                -- JSON: hackCoolDown, destroyTime, etc.
  updated_at TEXT DEFAULT (datetime('now'))
);
`;

// ─── Loot spawn points ─────────────────────────────────────────────────────

const LOOT_ACTORS = `
CREATE TABLE IF NOT EXISTS loot_actors (
  name       TEXT PRIMARY KEY,
  type       TEXT DEFAULT '',
  pos_x      REAL,
  pos_y      REAL,
  pos_z      REAL,
  items      TEXT DEFAULT '[]',
  updated_at TEXT DEFAULT (datetime('now'))
);
`;

// ─── Item groups (fungible item tracking) ───────────────────────────────────
//
// Fungible items (same fingerprint, e.g. identical Nails stacks) cannot be
// individually distinguished. Instead, we track them as counted *groups*:
// each unique (fingerprint, location_type, location_id, location_slot) tuple
// is one group with a quantity. When quantity decreases at location A and
// increases at location B → transfer event. When an item leaves a group,
// it gets its own instance or joins/creates a group at the destination.

const ITEM_GROUPS = `
CREATE TABLE IF NOT EXISTS item_groups (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  fingerprint     TEXT NOT NULL,               -- item identity hash (shared by all members)
  item            TEXT NOT NULL,               -- item name (RowName)
  durability      REAL DEFAULT 0,
  ammo            INTEGER DEFAULT 0,
  attachments     TEXT DEFAULT '[]',
  cap             REAL DEFAULT 0,
  max_dur         REAL DEFAULT 0,
  location_type   TEXT NOT NULL DEFAULT '',    -- 'player', 'container', 'vehicle', etc.
  location_id     TEXT DEFAULT '',             -- steam_id, actor_name, etc.
  location_slot   TEXT DEFAULT '',             -- 'inventory', 'equipment', etc.
  pos_x           REAL,
  pos_y           REAL,
  pos_z           REAL,
  quantity        INTEGER DEFAULT 1,           -- how many identical items are in this group
  stack_size      INTEGER DEFAULT 1,           -- per-item stack size (amount field from save)
  first_seen      TEXT DEFAULT (datetime('now')),
  last_seen       TEXT DEFAULT (datetime('now')),
  lost            INTEGER DEFAULT 0,           -- 1 = group disappeared from world
  lost_at         TEXT
);
CREATE INDEX IF NOT EXISTS idx_item_grp_fingerprint ON item_groups(fingerprint);
CREATE INDEX IF NOT EXISTS idx_item_grp_item ON item_groups(item);
CREATE INDEX IF NOT EXISTS idx_item_grp_location ON item_groups(location_type, location_id);
CREATE INDEX IF NOT EXISTS idx_item_grp_active ON item_groups(lost);
CREATE UNIQUE INDEX IF NOT EXISTS idx_item_grp_unique ON item_groups(fingerprint, location_type, location_id, location_slot) WHERE lost = 0;
`;

// ─── Item instance tracking (fingerprint-based identity) ────────────────────

const ITEM_INSTANCES = `
CREATE TABLE IF NOT EXISTS item_instances (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  fingerprint     TEXT NOT NULL,               -- hash of item+durability+ammo+attachments for matching
  item            TEXT NOT NULL,               -- item name (RowName)
  durability      REAL DEFAULT 0,              -- durability value (key fingerprint component)
  ammo            INTEGER DEFAULT 0,           -- loaded ammo count
  attachments     TEXT DEFAULT '[]',           -- JSON array of attachment names
  cap             REAL DEFAULT 0,              -- container capacity
  max_dur         REAL DEFAULT 0,              -- max durability
  location_type   TEXT NOT NULL DEFAULT '',    -- 'player', 'container', 'vehicle', 'horse', 'structure', 'world_drop', 'loot_actor', 'backpack', 'global_container'
  location_id     TEXT DEFAULT '',             -- steam_id, actor_name, vehicle id, etc.
  location_slot   TEXT DEFAULT '',             -- 'inventory', 'equipment', 'quick_slots', 'backpack', 'trunk', 'saddle'
  pos_x           REAL,                        -- position (from parent entity)
  pos_y           REAL,
  pos_z           REAL,
  amount          INTEGER DEFAULT 1,           -- stack size at this location
  group_id        INTEGER DEFAULT NULL,        -- FK to item_groups (set for fungible items in a group)
  first_seen      TEXT DEFAULT (datetime('now')),
  last_seen       TEXT DEFAULT (datetime('now')),
  lost            INTEGER DEFAULT 0,           -- 1 = not found in latest snapshot (despawned/consumed)
  lost_at         TEXT                         -- when the item was last seen before disappearing
);
CREATE INDEX IF NOT EXISTS idx_item_inst_fingerprint ON item_instances(fingerprint);
CREATE INDEX IF NOT EXISTS idx_item_inst_item ON item_instances(item);
CREATE INDEX IF NOT EXISTS idx_item_inst_location ON item_instances(location_type, location_id);
CREATE INDEX IF NOT EXISTS idx_item_inst_active ON item_instances(lost);
CREATE INDEX IF NOT EXISTS idx_item_inst_group ON item_instances(group_id);
`;

const ITEM_MOVEMENTS = `
CREATE TABLE IF NOT EXISTS item_movements (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_id     INTEGER REFERENCES item_instances(id),   -- NULL for group-level movements
  group_id        INTEGER REFERENCES item_groups(id),      -- set for group transfers
  move_type       TEXT DEFAULT 'move',         -- 'move', 'group_split', 'group_merge', 'group_transfer', 'group_adjust'
  item            TEXT NOT NULL,               -- denormalised for fast queries
  from_type       TEXT DEFAULT '',             -- location_type before move
  from_id         TEXT DEFAULT '',             -- location_id before move
  from_slot       TEXT DEFAULT '',             -- slot before move
  to_type         TEXT NOT NULL,               -- location_type after move
  to_id           TEXT NOT NULL,               -- location_id after move
  to_slot         TEXT DEFAULT '',             -- slot after move
  amount          INTEGER DEFAULT 1,           -- how many items moved
  attributed_steam_id TEXT DEFAULT '',         -- player who caused the move (if known)
  attributed_name TEXT DEFAULT '',             -- player name
  pos_x           REAL,                        -- position where the move occurred
  pos_y           REAL,
  pos_z           REAL,
  created_at      TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_item_mov_instance ON item_movements(instance_id);
CREATE INDEX IF NOT EXISTS idx_item_mov_group ON item_movements(group_id);
CREATE INDEX IF NOT EXISTS idx_item_mov_item ON item_movements(item);
CREATE INDEX IF NOT EXISTS idx_item_mov_created ON item_movements(created_at);
CREATE INDEX IF NOT EXISTS idx_item_mov_attributed ON item_movements(attributed_steam_id);
`;

// ─── World drops (LODPickups, dropped backpacks, global containers) ─────────

const WORLD_DROPS = `
CREATE TABLE IF NOT EXISTS world_drops (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  type            TEXT NOT NULL,               -- 'pickup', 'backpack', 'global_container'
  actor_name      TEXT DEFAULT '',             -- actor/entity identifier
  item            TEXT DEFAULT '',             -- item name (for single-item pickups)
  amount          INTEGER DEFAULT 0,
  durability      REAL DEFAULT 0,
  items           TEXT DEFAULT '[]',           -- JSON array (for backpacks/containers with multiple items)
  world_loot      INTEGER DEFAULT 0,           -- 1 = natural world spawn
  placed          INTEGER DEFAULT 0,           -- 1 = player-placed
  spawned         INTEGER DEFAULT 0,           -- 1 = server-spawned
  locked          INTEGER DEFAULT 0,
  does_spawn_loot INTEGER DEFAULT 0,
  pos_x           REAL,
  pos_y           REAL,
  pos_z           REAL,
  updated_at      TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_world_drops_type ON world_drops(type);
CREATE INDEX IF NOT EXISTS idx_world_drops_item ON world_drops(item);
CREATE INDEX IF NOT EXISTS idx_world_drops_pos ON world_drops(pos_x, pos_y);
`;

// ─── Quests (world quest state) ─────────────────────────────────────────────

const QUESTS = `
CREATE TABLE IF NOT EXISTS quests (
  id         TEXT PRIMARY KEY,                 -- quest GUID or name
  type       TEXT DEFAULT '',
  state      TEXT DEFAULT '',                  -- completed, active, etc.
  data       TEXT DEFAULT '{}',                -- full quest JSON
  updated_at TEXT DEFAULT (datetime('now'))
);
`;

// ─── Server settings (parsed GameServerSettings.ini) ────────────────────────

const SERVER_SETTINGS = `
CREATE TABLE IF NOT EXISTS server_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT DEFAULT '',
  updated_at TEXT DEFAULT (datetime('now'))
);
`;

// ─── Game reference data (from pak extraction) ──────────────────────────────

const GAME_ITEMS = `
CREATE TABLE IF NOT EXISTS game_items (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  description           TEXT DEFAULT '',
  type                  TEXT DEFAULT '',
  type_raw              TEXT DEFAULT '',
  specific_type         TEXT DEFAULT '',
  wear_position         TEXT DEFAULT '',
  category              TEXT DEFAULT '',
  chance_to_spawn       REAL DEFAULT 0,
  durability_loss        REAL DEFAULT 0,
  armor_protection      REAL DEFAULT 0,
  max_stack_size        INTEGER DEFAULT 1,
  can_stack             INTEGER DEFAULT 0,
  item_size             INTEGER DEFAULT 1,
  weight                REAL DEFAULT 0,
  first_value           REAL DEFAULT 0,
  second_item_type      TEXT DEFAULT '',
  second_value          REAL DEFAULT 0,
  value_to_trader       REAL DEFAULT 0,
  value_for_player      REAL DEFAULT 0,
  does_decay            INTEGER DEFAULT 0,
  decay_per_day         REAL DEFAULT 0,
  only_decay_if_opened  INTEGER DEFAULT 0,
  warmth_value          REAL DEFAULT 0,
  infection_protection  REAL DEFAULT 0,
  clothing_rain_mod     REAL DEFAULT 0,
  clothing_snow_mod     REAL DEFAULT 0,
  summer_cool_value     REAL DEFAULT 0,
  is_skill_book         INTEGER DEFAULT 0,
  no_pocket             INTEGER DEFAULT 0,
  exclude_from_vendor   INTEGER DEFAULT 0,
  exclude_from_ai       INTEGER DEFAULT 0,
  use_as_fertilizer     INTEGER DEFAULT 0,
  state                 TEXT DEFAULT '',
  tag                   TEXT DEFAULT '',
  open_item             TEXT DEFAULT '',
  body_attach_socket    TEXT DEFAULT '',
  supported_attachments TEXT DEFAULT '[]',
  items_inside          TEXT DEFAULT '[]',
  skill_book_data       TEXT DEFAULT '{}',
  extra                 TEXT DEFAULT '{}'
);
`;

const GAME_BUILDINGS = `
CREATE TABLE IF NOT EXISTS game_buildings (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  description           TEXT DEFAULT '',
  category              TEXT DEFAULT '',
  category_raw          TEXT DEFAULT '',
  health                REAL DEFAULT 0,
  show_in_build_menu    INTEGER DEFAULT 0,
  requires_build_tool   INTEGER DEFAULT 0,
  moveable              INTEGER DEFAULT 0,
  learned_building      INTEGER DEFAULT 0,
  landscape_only        INTEGER DEFAULT 0,
  water_only            INTEGER DEFAULT 0,
  structure_only        INTEGER DEFAULT 0,
  wall_placement        INTEGER DEFAULT 0,
  require_foundation    INTEGER DEFAULT 0,
  xp_multiplier         REAL DEFAULT 1,
  resources             TEXT DEFAULT '[]',
  upgrades              TEXT DEFAULT '[]'
);
`;

const GAME_LOOT_POOLS = `
CREATE TABLE IF NOT EXISTS game_loot_pools (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  item_count            INTEGER DEFAULT 0
);
`;

const GAME_LOOT_POOL_ITEMS = `
CREATE TABLE IF NOT EXISTS game_loot_pool_items (
  pool_id               TEXT NOT NULL,
  item_id               TEXT NOT NULL,
  name                  TEXT DEFAULT '',
  chance_to_spawn       REAL DEFAULT 0,
  type                  TEXT DEFAULT '',
  max_stack_size        INTEGER DEFAULT 1,
  PRIMARY KEY (pool_id, item_id)
);
CREATE INDEX IF NOT EXISTS idx_loot_pool ON game_loot_pool_items(pool_id);
`;

const GAME_VEHICLES_REF = `
CREATE TABLE IF NOT EXISTS game_vehicles_ref (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL
);
`;

const GAME_ANIMALS = `
CREATE TABLE IF NOT EXISTS game_animals (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  type                  TEXT DEFAULT '',
  hide_item_id          TEXT DEFAULT ''
);
`;

const GAME_CROPS = `
CREATE TABLE IF NOT EXISTS game_crops (
  id                    TEXT PRIMARY KEY,
  crop_id               INTEGER DEFAULT 0,
  growth_time_days      REAL DEFAULT 0,
  grid_columns          INTEGER DEFAULT 1,
  grid_rows             INTEGER DEFAULT 1,
  harvest_result        TEXT DEFAULT '',
  harvest_count         INTEGER DEFAULT 0,
  grow_seasons          TEXT DEFAULT '[]'
);
`;

const GAME_CAR_UPGRADES = `
CREATE TABLE IF NOT EXISTS game_car_upgrades (
  id                    TEXT PRIMARY KEY,
  type                  TEXT DEFAULT '',
  type_raw              TEXT DEFAULT '',
  level                 INTEGER DEFAULT 0,
  socket                TEXT DEFAULT '',
  tool_durability_lost  REAL DEFAULT 0,
  craft_time_minutes    REAL DEFAULT 0,
  health                REAL DEFAULT 0,
  craft_cost            TEXT DEFAULT '[]'
);
`;

const GAME_AMMO_TYPES = `
CREATE TABLE IF NOT EXISTS game_ammo_types (
  id                    TEXT PRIMARY KEY,
  damage                REAL DEFAULT 0,
  headshot_multiplier   REAL DEFAULT 1,
  range                 REAL DEFAULT 0,
  penetration           REAL DEFAULT 0
);
`;

const GAME_REPAIR_DATA = `
CREATE TABLE IF NOT EXISTS game_repair_data (
  id                    TEXT PRIMARY KEY,
  resource_type         TEXT DEFAULT '',
  resource_type_raw     TEXT DEFAULT '',
  amount                INTEGER DEFAULT 0,
  health_to_add         REAL DEFAULT 0,
  is_repairable         INTEGER DEFAULT 1,
  extra_resources       TEXT DEFAULT '[]'
);
`;

const GAME_FURNITURE = `
CREATE TABLE IF NOT EXISTS game_furniture (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  mesh_count            INTEGER DEFAULT 0,
  drop_resources        TEXT DEFAULT '[]'
);
`;

const GAME_TRAPS = `
CREATE TABLE IF NOT EXISTS game_traps (
  id                    TEXT PRIMARY KEY,
  item_id               TEXT DEFAULT '',
  requires_weapon       INTEGER DEFAULT 0,
  requires_ammo         INTEGER DEFAULT 0,
  requires_items        INTEGER DEFAULT 0,
  required_ammo_id      TEXT DEFAULT ''
);
`;

const GAME_SPRAYS = `
CREATE TABLE IF NOT EXISTS game_sprays (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  description           TEXT DEFAULT '',
  color                 TEXT DEFAULT ''
);
`;

const GAME_PROFESSIONS = `
CREATE TABLE IF NOT EXISTS game_professions (
  id          TEXT PRIMARY KEY,                -- e.g. 'Mechanic'
  enum_value  TEXT DEFAULT '',                 -- Enum_Professions::NewEnumeratorX
  enum_index  INTEGER DEFAULT 0,
  perk        TEXT DEFAULT '',                 -- perk description
  description TEXT DEFAULT '',
  affliction  TEXT DEFAULT '',
  skills      TEXT DEFAULT '[]'                -- JSON array of skill names
);
`;

const GAME_AFFLICTIONS = `
CREATE TABLE IF NOT EXISTS game_afflictions (
  idx         INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT DEFAULT '',
  icon        TEXT DEFAULT ''
);
`;

const GAME_SKILLS = `
CREATE TABLE IF NOT EXISTS game_skills (
  id          TEXT PRIMARY KEY,                -- e.g. 'CALLUSED'
  name        TEXT NOT NULL,
  description TEXT DEFAULT '',
  effect      TEXT DEFAULT '',
  category    TEXT DEFAULT '',
  icon        TEXT DEFAULT ''
);
`;

const GAME_CHALLENGES = `
CREATE TABLE IF NOT EXISTS game_challenges (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT DEFAULT '',
  save_field  TEXT DEFAULT '',                 -- field name in save parser
  target      INTEGER DEFAULT 0               -- target value (0 = boolean)
);
`;

const GAME_RECIPES = `
CREATE TABLE IF NOT EXISTS game_recipes (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  description           TEXT DEFAULT '',
  station               TEXT DEFAULT '',
  station_raw           TEXT DEFAULT '',
  recipe_type           TEXT DEFAULT '',
  craft_time            REAL DEFAULT 0,
  profession            TEXT DEFAULT '',
  profession_raw        TEXT DEFAULT '',
  requires_recipe       INTEGER DEFAULT 0,
  hidden                INTEGER DEFAULT 0,
  inventory_search_only INTEGER DEFAULT 0,
  xp_multiplier         REAL DEFAULT 1,
  use_any               INTEGER DEFAULT 0,
  copy_capacity         INTEGER DEFAULT 0,
  no_spoiled            INTEGER DEFAULT 0,
  ignore_melee_check    INTEGER DEFAULT 0,
  override_name         TEXT DEFAULT '',
  override_description  TEXT DEFAULT '',
  crafted_item          TEXT DEFAULT '{}',
  also_give_item        TEXT DEFAULT '{}',
  also_give_arr         TEXT DEFAULT '[]',
  ingredients           TEXT DEFAULT '[]'
);
`;

const GAME_QUESTS = `
CREATE TABLE IF NOT EXISTS game_quests (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT DEFAULT '',
  xp_reward   INTEGER DEFAULT 0,
  requirements TEXT DEFAULT '[]',
  rewards     TEXT DEFAULT '[]'
);
`;

const GAME_LORE = `
CREATE TABLE IF NOT EXISTS game_lore (
  id          TEXT PRIMARY KEY,
  title       TEXT DEFAULT '',
  text        TEXT DEFAULT '',
  category    TEXT DEFAULT '',
  sort_order  INTEGER DEFAULT 0
);
`;

const GAME_LOADING_TIPS = `
CREATE TABLE IF NOT EXISTS game_loading_tips (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  text        TEXT NOT NULL,
  category    TEXT DEFAULT ''                   -- general, controls, survival, etc.
);
`;

const GAME_SPAWN_LOCATIONS = `
CREATE TABLE IF NOT EXISTS game_spawn_locations (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT DEFAULT '',
  map         TEXT DEFAULT ''
);
`;

const GAME_SERVER_SETTINGS = `
CREATE TABLE IF NOT EXISTS game_server_setting_defs (
  key         TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  description TEXT DEFAULT '',
  type        TEXT DEFAULT 'string',           -- string, int, float, bool, enum
  default_val TEXT DEFAULT '',
  options     TEXT DEFAULT '[]'                -- JSON array for enum types
);
`;

// ─── Snapshots (for weekly/periodic leaderboard deltas) ─────────────────────

const SNAPSHOTS = `
CREATE TABLE IF NOT EXISTS snapshots (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  type        TEXT NOT NULL,                   -- 'weekly', 'daily', 'hourly'
  steam_id    TEXT NOT NULL,
  data        TEXT DEFAULT '{}',               -- JSON snapshot of relevant stats
  created_at  TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_snapshots_type_steam ON snapshots(type, steam_id);
CREATE INDEX IF NOT EXISTS idx_snapshots_created ON snapshots(created_at);
`;

// ─── Server peaks (playtime tracker peak stats) ─────────────────────────────

const SERVER_PEAKS = `
CREATE TABLE IF NOT EXISTS server_peaks (
  key         TEXT PRIMARY KEY,
  value       TEXT DEFAULT '',
  updated_at  TEXT DEFAULT (datetime('now'))
);
`;
// Stores: tracking_since, all_time_peak, all_time_peak_date, today_peak,
//         today_date, unique_today (JSON array), unique_day_peak,
//         unique_day_peak_date, yesterday_unique

// ─── Activity log (item movements, world events, state changes) ─────────────

const ACTIVITY_LOG = `
CREATE TABLE IF NOT EXISTS activity_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  type        TEXT NOT NULL,                   -- event type (see below)
  category    TEXT DEFAULT '',                 -- 'container', 'inventory', 'horse', 'vehicle', 'world', 'structure', 'session', 'death', 'build', 'loot', 'raid', 'combat', 'admin'
  actor       TEXT DEFAULT '',                 -- container actor_name, player steam_id, or entity id
  actor_name  TEXT DEFAULT '',                 -- human-readable label (player name, container name)
  steam_id    TEXT DEFAULT '',                 -- player steam ID (when available)
  target_name TEXT DEFAULT '',                 -- secondary actor (victim, owner, etc.)
  target_steam_id TEXT DEFAULT '',             -- secondary actor steam ID
  item        TEXT DEFAULT '',                 -- item name (for inventory changes)
  amount      INTEGER DEFAULT 0,              -- quantity changed
  details     TEXT DEFAULT '{}',              -- JSON: extra context (durability, ammo, etc.)
  source      TEXT DEFAULT 'save',            -- 'save' (diff engine), 'log' (SFTP logs), 'chat' (RCON chat)
  pos_x       REAL,
  pos_y       REAL,
  pos_z       REAL,
  created_at  TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_activity_type ON activity_log(type);
CREATE INDEX IF NOT EXISTS idx_activity_category ON activity_log(category);
CREATE INDEX IF NOT EXISTS idx_activity_actor ON activity_log(actor);
CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_log(created_at);
CREATE INDEX IF NOT EXISTS idx_activity_item ON activity_log(item);
CREATE INDEX IF NOT EXISTS idx_activity_steam_id ON activity_log(steam_id);
CREATE INDEX IF NOT EXISTS idx_activity_source ON activity_log(source);
`;

// Activity log event types:
//
// ─── Save-diff events (source: 'save') ───
// container_item_added      — item appeared in a container
// container_item_removed    — item disappeared from a container
// container_locked          — container was locked
// container_unlocked        — container was unlocked
// container_destroyed       — container destroyed (items lost)
// inventory_item_added      — item appeared in player inventory/equipment/backpack
// inventory_item_removed    — item disappeared from player inventory/equipment/backpack
// horse_appeared            — new horse in the world
// horse_disappeared         — horse removed from the world
// horse_health_changed      — horse took damage or healed
// horse_owner_changed       — horse ownership transferred
// vehicle_item_added        — item placed in vehicle trunk
// vehicle_item_removed      — item removed from vehicle trunk
// vehicle_health_changed    — vehicle damaged or repaired
// airdrop_spawned           — airdrop entered the world
// airdrop_despawned         — airdrop removed
// world_day_advanced        — in-game day counter increased
// world_season_changed      — season transition
//
// ─── Log-based events (source: 'log') ───
// player_connect            — player joined the server
// player_disconnect         — player left the server
// player_death              — player died (PvE or unknown)
// player_death_pvp          — player killed by another player
// death_loop                — rapid respawn deaths (summary)
// player_build              — player placed a building
// container_loot            — player opened another player's container
// raid_damage               — player damaged/destroyed another player's building
// building_destroyed        — unowned building destroyed
// damage_taken              — player took damage from a source
// admin_access              — player granted admin access
// anticheat_flag            — anti-cheat system flagged a player

// ─── Chat log ───────────────────────────────────────────────────────────────

const CHAT_LOG = `
CREATE TABLE IF NOT EXISTS chat_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  type         TEXT NOT NULL,                  -- 'player', 'admin_request', 'discord_to_game', 'join', 'leave', 'death'
  player_name  TEXT DEFAULT '',
  steam_id     TEXT DEFAULT '',
  message      TEXT DEFAULT '',
  direction    TEXT DEFAULT 'game',            -- 'game' (in-game→discord), 'discord' (discord→game)
  discord_user TEXT DEFAULT '',                -- for discord→game messages
  is_admin     INTEGER DEFAULT 0,             -- 1 if player has admin badge
  created_at   TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_chat_created ON chat_log(created_at);
CREATE INDEX IF NOT EXISTS idx_chat_type ON chat_log(type);
CREATE INDEX IF NOT EXISTS idx_chat_steam ON chat_log(steam_id);
CREATE INDEX IF NOT EXISTS idx_chat_player ON chat_log(player_name);
`;

// ═══════════════════════════════════════════════════════════════════════════
//  TIMELINE — full temporal tracking of every entity across save polls
// ═══════════════════════════════════════════════════════════════════════════

// ─── Timeline snapshots (one row per save poll — the master tick) ────────────

const TIMELINE_SNAPSHOTS = `
CREATE TABLE IF NOT EXISTS timeline_snapshots (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  game_day        INTEGER DEFAULT 0,           -- in-game day number
  game_time       REAL DEFAULT 0,              -- in-game time of day (0-2400 float)
  player_count    INTEGER DEFAULT 0,           -- total players in save
  online_count    INTEGER DEFAULT 0,           -- players currently online
  ai_count        INTEGER DEFAULT 0,           -- total AI spawns
  structure_count INTEGER DEFAULT 0,
  vehicle_count   INTEGER DEFAULT 0,
  container_count INTEGER DEFAULT 0,
  world_item_count INTEGER DEFAULT 0,          -- LOD pickups
  weather_type    TEXT DEFAULT '',              -- current weather (resolved)
  season          TEXT DEFAULT '',              -- current season
  airdrop_active  INTEGER DEFAULT 0,           -- 1 if airdrop exists
  airdrop_x       REAL,
  airdrop_y       REAL,
  airdrop_ai_alive INTEGER DEFAULT 0,
  summary         TEXT DEFAULT '{}',           -- JSON: game difficulty, misc world state
  created_at      TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tl_snap_created ON timeline_snapshots(created_at);
CREATE INDEX IF NOT EXISTS idx_tl_snap_day ON timeline_snapshots(game_day);
`;

// ─── Player positions / state over time ─────────────────────────────────────

const TIMELINE_PLAYERS = `
CREATE TABLE IF NOT EXISTS timeline_players (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_id     INTEGER NOT NULL REFERENCES timeline_snapshots(id) ON DELETE CASCADE,
  steam_id        TEXT NOT NULL,
  name            TEXT DEFAULT '',
  online          INTEGER DEFAULT 0,
  pos_x           REAL,
  pos_y           REAL,
  pos_z           REAL,
  health          REAL DEFAULT 0,
  max_health      REAL DEFAULT 100,
  hunger          REAL DEFAULT 0,
  thirst          REAL DEFAULT 0,
  infection       REAL DEFAULT 0,
  stamina         REAL DEFAULT 0,
  level           INTEGER DEFAULT 0,
  zeeks_killed    INTEGER DEFAULT 0,
  days_survived   INTEGER DEFAULT 0,
  lifetime_kills  INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_tl_players_snap ON timeline_players(snapshot_id);
CREATE INDEX IF NOT EXISTS idx_tl_players_steam ON timeline_players(steam_id);
`;

// ─── AI spawn positions / state over time ───────────────────────────────────

const TIMELINE_AI = `
CREATE TABLE IF NOT EXISTS timeline_ai (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_id     INTEGER NOT NULL REFERENCES timeline_snapshots(id) ON DELETE CASCADE,
  ai_type         TEXT NOT NULL,               -- 'ZombieDefault', 'ZombieRunner', 'AnimalWolf', 'BanditRifle', etc.
  category        TEXT NOT NULL DEFAULT '',     -- 'zombie', 'animal', 'bandit'
  display_name    TEXT DEFAULT '',              -- resolved human name: 'Runner', 'Wolf', 'Bandit (Rifle)'
  node_uid        TEXT DEFAULT '',              -- unique spawn node ID
  pos_x           REAL,
  pos_y           REAL,
  pos_z           REAL
);
CREATE INDEX IF NOT EXISTS idx_tl_ai_snap ON timeline_ai(snapshot_id);
CREATE INDEX IF NOT EXISTS idx_tl_ai_type ON timeline_ai(ai_type);
CREATE INDEX IF NOT EXISTS idx_tl_ai_cat ON timeline_ai(category);
`;

// ─── Vehicle positions / state over time ────────────────────────────────────

const TIMELINE_VEHICLES = `
CREATE TABLE IF NOT EXISTS timeline_vehicles (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_id     INTEGER NOT NULL REFERENCES timeline_snapshots(id) ON DELETE CASCADE,
  class           TEXT NOT NULL,
  display_name    TEXT DEFAULT '',
  pos_x           REAL,
  pos_y           REAL,
  pos_z           REAL,
  health          REAL DEFAULT 0,
  max_health      REAL DEFAULT 0,
  fuel            REAL DEFAULT 0,
  item_count      INTEGER DEFAULT 0            -- number of items in trunk
);
CREATE INDEX IF NOT EXISTS idx_tl_vehicles_snap ON timeline_vehicles(snapshot_id);
`;

// ─── Structure state over time ──────────────────────────────────────────────

const TIMELINE_STRUCTURES = `
CREATE TABLE IF NOT EXISTS timeline_structures (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_id     INTEGER NOT NULL REFERENCES timeline_snapshots(id) ON DELETE CASCADE,
  actor_class     TEXT NOT NULL,
  display_name    TEXT DEFAULT '',
  owner_steam_id  TEXT DEFAULT '',
  pos_x           REAL,
  pos_y           REAL,
  pos_z           REAL,
  current_health  REAL DEFAULT 0,
  max_health      REAL DEFAULT 0,
  upgrade_level   INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_tl_structures_snap ON timeline_structures(snapshot_id);
CREATE INDEX IF NOT EXISTS idx_tl_structures_owner ON timeline_structures(owner_steam_id);
`;

// ─── House state over time ──────────────────────────────────────────────────

const TIMELINE_HOUSES = `
CREATE TABLE IF NOT EXISTS timeline_houses (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_id     INTEGER NOT NULL REFERENCES timeline_snapshots(id) ON DELETE CASCADE,
  uid             TEXT NOT NULL,
  name            TEXT DEFAULT '',
  windows_open    INTEGER DEFAULT 0,
  windows_total   INTEGER DEFAULT 0,
  doors_open      INTEGER DEFAULT 0,
  doors_locked    INTEGER DEFAULT 0,
  doors_total     INTEGER DEFAULT 0,
  destroyed_furniture INTEGER DEFAULT 0,
  has_generator   INTEGER DEFAULT 0,
  sleepers        REAL DEFAULT 0,
  clean           REAL DEFAULT 0,
  pos_x           REAL,                        -- estimated from actor name hash (if available)
  pos_y           REAL
);
CREATE INDEX IF NOT EXISTS idx_tl_houses_snap ON timeline_houses(snapshot_id);
CREATE INDEX IF NOT EXISTS idx_tl_houses_uid ON timeline_houses(uid);
`;

// ─── Companion / horse positions over time ──────────────────────────────────

const TIMELINE_COMPANIONS = `
CREATE TABLE IF NOT EXISTS timeline_companions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_id     INTEGER NOT NULL REFERENCES timeline_snapshots(id) ON DELETE CASCADE,
  entity_type     TEXT NOT NULL,               -- 'dog', 'horse'
  actor_name      TEXT DEFAULT '',
  display_name    TEXT DEFAULT '',
  owner_steam_id  TEXT DEFAULT '',
  pos_x           REAL,
  pos_y           REAL,
  pos_z           REAL,
  health          REAL DEFAULT 0,
  extra           TEXT DEFAULT '{}'             -- JSON: energy, command, saddle, etc.
);
CREATE INDEX IF NOT EXISTS idx_tl_companions_snap ON timeline_companions(snapshot_id);
`;

// ─── Dropped backpacks over time ────────────────────────────────────────────

const TIMELINE_BACKPACKS = `
CREATE TABLE IF NOT EXISTS timeline_backpacks (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_id     INTEGER NOT NULL REFERENCES timeline_snapshots(id) ON DELETE CASCADE,
  class           TEXT DEFAULT '',
  pos_x           REAL,
  pos_y           REAL,
  pos_z           REAL,
  item_count      INTEGER DEFAULT 0,
  items_summary   TEXT DEFAULT '[]'            -- JSON: [{item, amount}] top items
);
CREATE INDEX IF NOT EXISTS idx_tl_backpacks_snap ON timeline_backpacks(snapshot_id);
`;

// ─── Death cause tracking (correlates damage→death events) ──────────────────

const DEATH_CAUSES = `
CREATE TABLE IF NOT EXISTS death_causes (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  victim_name     TEXT NOT NULL,
  victim_steam_id TEXT DEFAULT '',
  cause_type      TEXT NOT NULL,               -- 'zombie', 'animal', 'bandit', 'player', 'environment', 'unknown'
  cause_name      TEXT DEFAULT '',              -- classified name: 'Runner', 'Wolf', 'PlayerX'
  cause_raw       TEXT DEFAULT '',              -- raw BP_ name from log
  damage_total    REAL DEFAULT 0,
  pos_x           REAL,
  pos_y           REAL,
  pos_z           REAL,
  created_at      TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_death_cause_victim ON death_causes(victim_name);
CREATE INDEX IF NOT EXISTS idx_death_cause_type ON death_causes(cause_type);
CREATE INDEX IF NOT EXISTS idx_death_cause_created ON death_causes(created_at);
CREATE INDEX IF NOT EXISTS idx_death_cause_steam ON death_causes(victim_steam_id);
`;

// ─── Meta ───────────────────────────────────────────────────────────────────

const META = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`;

// ─── Bot State (key-value store for runtime operational state) ──────────────

const BOT_STATE = `
CREATE TABLE IF NOT EXISTS bot_state (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);
`;

// ─── Config Documents (DB-backed configuration storage) ──────────────────────

const CONFIG_DOCUMENTS = `
CREATE TABLE IF NOT EXISTS config_documents (
  scope      TEXT PRIMARY KEY,
  data       TEXT NOT NULL DEFAULT '{}',
  version    INTEGER DEFAULT 1,
  updated_at TEXT DEFAULT (datetime('now'))
);
`;

// ─── Anticheat — flag tracking, risk scores, universal fingerprints ─────────

const ANTICHEAT_FLAGS = `
CREATE TABLE IF NOT EXISTS anticheat_flags (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  steam_id        TEXT NOT NULL,
  player_name     TEXT DEFAULT '',
  detector        TEXT NOT NULL,               -- 'teleportation', 'speed_hack', 'impossible_kill_rate', etc.
  severity        TEXT DEFAULT 'low',          -- 'info', 'low', 'medium', 'high', 'critical'
  score           REAL DEFAULT 0,              -- anomaly score (0.0–1.0 normalised)
  details         TEXT DEFAULT '{}',           -- JSON: detector-specific evidence
  evidence        TEXT DEFAULT '[]',           -- JSON: [{table, id}] references to source rows
  status          TEXT DEFAULT 'open',         -- 'open', 'confirmed', 'dismissed', 'whitelisted'
  reviewed_by     TEXT,                        -- discord user ID who reviewed
  reviewed_at     TEXT,
  review_notes    TEXT,
  auto_escalated  INTEGER DEFAULT 0,           -- 1 if severity was auto-increased
  created_at      TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ac_flags_steam    ON anticheat_flags(steam_id);
CREATE INDEX IF NOT EXISTS idx_ac_flags_detector ON anticheat_flags(detector);
CREATE INDEX IF NOT EXISTS idx_ac_flags_status   ON anticheat_flags(status);
CREATE INDEX IF NOT EXISTS idx_ac_flags_severity ON anticheat_flags(severity);
CREATE INDEX IF NOT EXISTS idx_ac_flags_created  ON anticheat_flags(created_at);
`;

const PLAYER_RISK_SCORES = `
CREATE TABLE IF NOT EXISTS player_risk_scores (
  steam_id        TEXT PRIMARY KEY,
  risk_score      REAL DEFAULT 0,              -- 0.0 = clean, 1.0 = almost certainly cheating
  open_flags      INTEGER DEFAULT 0,
  confirmed_flags INTEGER DEFAULT 0,
  dismissed_flags INTEGER DEFAULT 0,
  last_flag_at    TEXT,
  last_scored_at  TEXT,
  baseline_data   TEXT DEFAULT '{}',           -- JSON: per-player baseline metrics
  updated_at      TEXT DEFAULT (datetime('now'))
);
`;

const ENTITY_FINGERPRINTS = `
CREATE TABLE IF NOT EXISTS entity_fingerprints (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type     TEXT NOT NULL,               -- 'player', 'structure', 'vehicle', 'horse', 'container',
                                               -- 'companion', 'loot_actor', 'world_drop', 'item'
  entity_id       TEXT NOT NULL,               -- steam_id, actor_name, instance_id, etc.
  fingerprint     TEXT NOT NULL,               -- hash of entity state at creation
  parent_id       INTEGER,                     -- FK: entity that created/spawned this one
  creator_steam_id TEXT,                       -- player who created this entity (if applicable)
  created_at      TEXT DEFAULT (datetime('now')),
  last_validated  TEXT,                        -- last time fingerprint matched expected state
  tamper_score    REAL DEFAULT 0,              -- 0.0 = clean, 1.0 = definitely tampered
  metadata        TEXT DEFAULT '{}'            -- JSON: entity-type-specific provenance data
);
CREATE INDEX IF NOT EXISTS idx_ef_type          ON entity_fingerprints(entity_type);
CREATE INDEX IF NOT EXISTS idx_ef_entity        ON entity_fingerprints(entity_id);
CREATE INDEX IF NOT EXISTS idx_ef_fingerprint   ON entity_fingerprints(fingerprint);
CREATE INDEX IF NOT EXISTS idx_ef_creator       ON entity_fingerprints(creator_steam_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ef_unique ON entity_fingerprints(entity_type, entity_id);
`;

const FINGERPRINT_EVENTS = `
CREATE TABLE IF NOT EXISTS fingerprint_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  fingerprint_id  INTEGER REFERENCES entity_fingerprints(id),
  event_type      TEXT NOT NULL,               -- 'created', 'moved', 'modified', 'damaged',
                                               -- 'repaired', 'transferred', 'duplicated', 'destroyed'
  old_state       TEXT,                        -- JSON snapshot before change
  new_state       TEXT,                        -- JSON snapshot after change
  attributed_to   TEXT,                        -- steam_id of player who caused the change
  source          TEXT,                        -- 'save_diff', 'log_event', 'rcon', 'inferred'
  confidence      REAL DEFAULT 1.0,            -- 1.0 = certain, 0.5 = inferred, 0.0 = unknown
  created_at      TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_fpe_fingerprint ON fingerprint_events(fingerprint_id);
CREATE INDEX IF NOT EXISTS idx_fpe_attributed  ON fingerprint_events(attributed_to);
CREATE INDEX IF NOT EXISTS idx_fpe_type        ON fingerprint_events(event_type);
CREATE INDEX IF NOT EXISTS idx_fpe_created     ON fingerprint_events(created_at);
`;

// ═══════════════════════════════════════════════════════════════════════════
//  HOWYAGARN — Faction PvP / MMOlite tables
//  All tables prefixed with hmz_ to avoid collision with core bot tables.
// ═══════════════════════════════════════════════════════════════════════════

// ─── Faction definitions (3 factions, static-ish but admin-editable) ────────

const HMZ_FACTIONS = `
CREATE TABLE IF NOT EXISTS hmz_factions (
  id              TEXT PRIMARY KEY,             -- 'reapers', 'wardens', 'drifters'
  name            TEXT NOT NULL,                -- 'Reapers'
  theme           TEXT DEFAULT '',              -- 'Aggressive raiders'
  color           TEXT DEFAULT '#ffffff',       -- hex color for embeds/map
  icon            TEXT DEFAULT '',              -- emoji or icon key
  strength_desc   TEXT DEFAULT '',              -- short description of faction bonus
  weakness_desc   TEXT DEFAULT '',              -- short description of faction penalty
  member_count    INTEGER DEFAULT 0,            -- denormalized count (updated on join/leave)
  total_kills     INTEGER DEFAULT 0,            -- aggregate across all members
  total_deaths    INTEGER DEFAULT 0,
  total_playtime  INTEGER DEFAULT 0,            -- seconds
  territories_held INTEGER DEFAULT 0,           -- denormalized count
  created_at      TEXT DEFAULT (datetime('now'))
);
`;

// ─── Player faction membership (1:1, permanent per wipe) ────────────────────

const HMZ_PLAYERS = `
CREATE TABLE IF NOT EXISTS hmz_players (
  steam_id        TEXT PRIMARY KEY,             -- FK to players.steam_id
  faction_id      TEXT NOT NULL,                -- FK to hmz_factions.id
  faction_rank    INTEGER DEFAULT 1,            -- 1-20
  faction_xp      INTEGER DEFAULT 0,            -- cumulative XP toward next rank
  season_tier     INTEGER DEFAULT 0,            -- 0-50 season pass tier
  season_xp       INTEGER DEFAULT 0,            -- XP toward next season tier
  credits         INTEGER DEFAULT 0,            -- faction currency
  lifetime_credits INTEGER DEFAULT 0,           -- total earned (never decreases)
  quests_completed INTEGER DEFAULT 0,
  bounties_claimed INTEGER DEFAULT 0,
  territories_captured INTEGER DEFAULT 0,
  pvp_kills_faction INTEGER DEFAULT 0,          -- kills against other factions
  deaths_faction  INTEGER DEFAULT 0,            -- deaths to other faction members
  titles          TEXT DEFAULT '[]',            -- JSON array of earned title strings
  active_title    TEXT DEFAULT '',              -- currently displayed title
  perks_unlocked  TEXT DEFAULT '[]',            -- JSON array of perk IDs
  joined_at       TEXT DEFAULT (datetime('now')),
  last_active     TEXT DEFAULT (datetime('now')),
  wipe_id         TEXT DEFAULT ''               -- tracks which wipe cycle this belongs to
);
CREATE INDEX IF NOT EXISTS idx_hmzp_faction ON hmz_players(faction_id);
CREATE INDEX IF NOT EXISTS idx_hmzp_rank    ON hmz_players(faction_rank DESC);
CREATE INDEX IF NOT EXISTS idx_hmzp_credits ON hmz_players(credits DESC);
`;

// ─── Territory zones (admin-defined map regions) ────────────────────────────

const HMZ_TERRITORIES = `
CREATE TABLE IF NOT EXISTS hmz_territories (
  id              TEXT PRIMARY KEY,             -- 'airport', 'military_base', 'harbor', etc.
  name            TEXT NOT NULL,                -- 'The Airport'
  description     TEXT DEFAULT '',
  center_x        REAL NOT NULL,                -- UE4 world X
  center_y        REAL NOT NULL,                -- UE4 world Y
  radius          REAL DEFAULT 15000,           -- capture radius in UE4 units (~150m)
  controlling_faction TEXT,                     -- FK to hmz_factions.id (NULL = contested)
  control_score_reapers  INTEGER DEFAULT 0,     -- scoring points per faction
  control_score_wardens  INTEGER DEFAULT 0,
  control_score_drifters INTEGER DEFAULT 0,
  last_contested  TEXT,                         -- when control last changed
  bonus_type      TEXT DEFAULT 'xp',            -- 'xp', 'loot', 'defense', 'speed'
  bonus_value     REAL DEFAULT 0.1,             -- percentage bonus (0.1 = +10%)
  tier            INTEGER DEFAULT 1,            -- 1=outpost, 2=strategic, 3=stronghold
  active          INTEGER DEFAULT 1             -- admin can disable zones
);
CREATE INDEX IF NOT EXISTS idx_hmzt_faction ON hmz_territories(controlling_faction);
`;

// ─── Quest definitions (template library) ───────────────────────────────────

const HMZ_QUESTS = `
CREATE TABLE IF NOT EXISTS hmz_quests (
  id              TEXT PRIMARY KEY,             -- 'daily_kill_20', 'faction_reapers_raid_3', 'story_ch1_s1'
  type            TEXT NOT NULL,                -- 'daily', 'faction', 'story'
  faction_id      TEXT,                         -- NULL for universal, or specific faction
  title           TEXT NOT NULL,                -- 'Zombie Cleanup Crew'
  description     TEXT NOT NULL,                -- 'Kill 20 zombies in any territory.'
  objective_type  TEXT NOT NULL,                -- 'kill_zombies', 'kill_pvp', 'fish', 'build', 'loot',
                                                -- 'travel', 'craft', 'capture_territory', 'raid', 'custom'
  objective_target INTEGER DEFAULT 1,           -- how many to complete
  objective_params TEXT DEFAULT '{}',           -- JSON: extra filters {zone, item, weapon, etc.}
  reward_xp       INTEGER DEFAULT 0,            -- faction XP
  reward_credits  INTEGER DEFAULT 0,            -- faction credits
  reward_title    TEXT,                         -- title string unlocked on completion (NULL = none)
  reward_items    TEXT DEFAULT '[]',            -- JSON: [{item, qty}] given via RCON spawnitem
  prerequisite_quest TEXT,                      -- must complete this quest first (story chains)
  min_rank        INTEGER DEFAULT 0,            -- minimum faction rank required
  cooldown_hours  INTEGER DEFAULT 24,           -- hours before this quest can be taken again
  active          INTEGER DEFAULT 1,
  sort_order      INTEGER DEFAULT 0             -- display ordering
);
CREATE INDEX IF NOT EXISTS idx_hmzq_type    ON hmz_quests(type);
CREATE INDEX IF NOT EXISTS idx_hmzq_faction ON hmz_quests(faction_id);
`;

// ─── Per-player quest progress (assigned / in-progress / completed) ─────────

const HMZ_QUEST_PROGRESS = `
CREATE TABLE IF NOT EXISTS hmz_quest_progress (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  steam_id        TEXT NOT NULL,                -- FK to players.steam_id
  quest_id        TEXT NOT NULL,                -- FK to hmz_quests.id
  status          TEXT DEFAULT 'active',        -- 'active', 'completed', 'expired', 'abandoned'
  progress        INTEGER DEFAULT 0,            -- current count toward objective_target
  assigned_at     TEXT DEFAULT (datetime('now')),
  completed_at    TEXT,
  expires_at      TEXT,                         -- NULL = no expiry, or ISO timestamp
  reward_claimed  INTEGER DEFAULT 0             -- 1 once rewards issued
);
CREATE INDEX IF NOT EXISTS idx_hmzqp_steam  ON hmz_quest_progress(steam_id);
CREATE INDEX IF NOT EXISTS idx_hmzqp_quest  ON hmz_quest_progress(quest_id);
CREATE INDEX IF NOT EXISTS idx_hmzqp_status ON hmz_quest_progress(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_hmzqp_active ON hmz_quest_progress(steam_id, quest_id)
  WHERE status = 'active';
`;

// ─── Bounties (PvP target system) ───────────────────────────────────────────

const HMZ_BOUNTIES = `
CREATE TABLE IF NOT EXISTS hmz_bounties (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  target_steam_id TEXT NOT NULL,                -- player with the bounty on them
  target_name     TEXT DEFAULT '',
  placed_by       TEXT,                         -- steam_id of placer (NULL = system/auto)
  placed_by_name  TEXT DEFAULT '',
  reward_credits  INTEGER DEFAULT 0,
  reason          TEXT DEFAULT '',              -- 'kill_streak', 'territory_defense', 'admin', 'player'
  status          TEXT DEFAULT 'active',        -- 'active', 'claimed', 'expired', 'cancelled'
  claimed_by      TEXT,                         -- steam_id of killer who claimed it
  claimed_by_name TEXT DEFAULT '',
  created_at      TEXT DEFAULT (datetime('now')),
  claimed_at      TEXT,
  expires_at      TEXT                          -- NULL = no expiry
);
CREATE INDEX IF NOT EXISTS idx_hmzb_target  ON hmz_bounties(target_steam_id);
CREATE INDEX IF NOT EXISTS idx_hmzb_status  ON hmz_bounties(status);
CREATE INDEX IF NOT EXISTS idx_hmzb_placed  ON hmz_bounties(placed_by);
`;

// ─── Economy transaction log ────────────────────────────────────────────────

const HMZ_TRANSACTIONS = `
CREATE TABLE IF NOT EXISTS hmz_transactions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  steam_id        TEXT NOT NULL,
  type            TEXT NOT NULL,                -- 'quest_reward', 'bounty_reward', 'bounty_place',
                                                -- 'territory_bonus', 'kill_reward', 'war_fund',
                                                -- 'trade', 'admin_grant', 'admin_deduct', 'season_reward'
  amount          INTEGER NOT NULL,             -- positive = earned, negative = spent
  balance_after   INTEGER DEFAULT 0,            -- snapshot of credits after this transaction
  description     TEXT DEFAULT '',              -- human-readable reason
  related_id      TEXT,                         -- quest_id, bounty_id, territory_id, etc.
  created_at      TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_hmztx_steam  ON hmz_transactions(steam_id);
CREATE INDEX IF NOT EXISTS idx_hmztx_type   ON hmz_transactions(type);
CREATE INDEX IF NOT EXISTS idx_hmztx_date   ON hmz_transactions(created_at);
`;

// ─── Scheduled / completed events ───────────────────────────────────────────

const HMZ_EVENTS = `
CREATE TABLE IF NOT EXISTS hmz_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  type            TEXT NOT NULL,                -- 'territory_war', 'supply_drop', 'assassination',
                                                -- 'world_boss', 'horde_night', 'custom'
  name            TEXT NOT NULL,                -- 'Territory War — Round 3'
  description     TEXT DEFAULT '',
  status          TEXT DEFAULT 'scheduled',     -- 'scheduled', 'active', 'completed', 'cancelled'
  territory_id    TEXT,                         -- FK for territory-specific events
  target_steam_id TEXT,                         -- FK for assassination contracts
  params          TEXT DEFAULT '{}',            -- JSON: event-specific config
  rewards         TEXT DEFAULT '{}',            -- JSON: rewards distributed
  winner_faction  TEXT,                         -- which faction won (after completion)
  scheduled_at    TEXT,                         -- when the event starts
  started_at      TEXT,
  ended_at        TEXT,
  created_at      TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_hmze_type    ON hmz_events(type);
CREATE INDEX IF NOT EXISTS idx_hmze_status  ON hmz_events(status);
CREATE INDEX IF NOT EXISTS idx_hmze_sched   ON hmz_events(scheduled_at);
`;

// ─── Territory war participation scores per event ───────────────────────────

const HMZ_EVENT_SCORES = `
CREATE TABLE IF NOT EXISTS hmz_event_scores (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id        INTEGER NOT NULL,             -- FK to hmz_events.id
  steam_id        TEXT NOT NULL,
  faction_id      TEXT NOT NULL,
  score           INTEGER DEFAULT 0,            -- contribution points
  kills           INTEGER DEFAULT 0,
  deaths          INTEGER DEFAULT 0,
  captures        INTEGER DEFAULT 0,
  created_at      TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_hmzes_event   ON hmz_event_scores(event_id);
CREATE INDEX IF NOT EXISTS idx_hmzes_steam   ON hmz_event_scores(steam_id);
CREATE INDEX IF NOT EXISTS idx_hmzes_faction ON hmz_event_scores(faction_id);
`;

// ─── Wipe tracking (seasons / wipe cycles) ──────────────────────────────────

const HMZ_WIPES = `
CREATE TABLE IF NOT EXISTS hmz_wipes (
  id              TEXT PRIMARY KEY,             -- 'wipe_2026_03_01' or uuid
  name            TEXT DEFAULT '',              -- 'Season 1'
  started_at      TEXT DEFAULT (datetime('now')),
  ended_at        TEXT,                         -- NULL = current wipe
  config          TEXT DEFAULT '{}'             -- JSON: wipe-specific config overrides
);
`;

// ─── Indexes ────────────────────────────────────────────────────────────────

const INDEXES = `
CREATE INDEX IF NOT EXISTS idx_players_name ON players(name);
CREATE INDEX IF NOT EXISTS idx_players_online ON players(online);
CREATE INDEX IF NOT EXISTS idx_players_lifetime_kills ON players(lifetime_kills DESC);
CREATE INDEX IF NOT EXISTS idx_players_playtime ON players(playtime_seconds DESC);
CREATE INDEX IF NOT EXISTS idx_structures_owner ON structures(owner_steam_id);
CREATE INDEX IF NOT EXISTS idx_clan_members_steam ON clan_members(steam_id);
`;

// ─── All tables in creation order ───────────────────────────────────────────

const ALL_TABLES = [
  META,
  BOT_STATE,
  PLAYERS,
  PLAYER_ALIASES,
  CLANS,
  CLAN_MEMBERS,
  WORLD_STATE,
  STRUCTURES,
  VEHICLES,
  COMPANIONS,
  WORLD_HORSES,
  DEAD_BODIES,
  CONTAINERS,
  LOOT_ACTORS,
  ITEM_GROUPS,
  ITEM_INSTANCES,
  ITEM_MOVEMENTS,
  WORLD_DROPS,
  QUESTS,
  SERVER_SETTINGS,
  GAME_ITEMS,
  GAME_BUILDINGS,
  GAME_LOOT_POOLS,
  GAME_LOOT_POOL_ITEMS,
  GAME_VEHICLES_REF,
  GAME_ANIMALS,
  GAME_CROPS,
  GAME_CAR_UPGRADES,
  GAME_AMMO_TYPES,
  GAME_REPAIR_DATA,
  GAME_FURNITURE,
  GAME_TRAPS,
  GAME_SPRAYS,
  GAME_PROFESSIONS,
  GAME_AFFLICTIONS,
  GAME_SKILLS,
  GAME_CHALLENGES,
  GAME_RECIPES,
  GAME_QUESTS,
  GAME_LORE,
  GAME_LOADING_TIPS,
  GAME_SPAWN_LOCATIONS,
  GAME_SERVER_SETTINGS,
  SNAPSHOTS,
  SERVER_PEAKS,
  ACTIVITY_LOG,
  CHAT_LOG,
  TIMELINE_SNAPSHOTS,
  TIMELINE_PLAYERS,
  TIMELINE_AI,
  TIMELINE_VEHICLES,
  TIMELINE_STRUCTURES,
  TIMELINE_HOUSES,
  TIMELINE_COMPANIONS,
  TIMELINE_BACKPACKS,
  DEATH_CAUSES,
  ANTICHEAT_FLAGS,
  PLAYER_RISK_SCORES,
  ENTITY_FINGERPRINTS,
  FINGERPRINT_EVENTS,
  HMZ_FACTIONS,
  HMZ_PLAYERS,
  HMZ_TERRITORIES,
  HMZ_QUESTS,
  HMZ_QUEST_PROGRESS,
  HMZ_BOUNTIES,
  HMZ_TRANSACTIONS,
  HMZ_EVENTS,
  HMZ_EVENT_SCORES,
  HMZ_WIPES,
  INDEXES,
  CONFIG_DOCUMENTS,
];

module.exports = { SCHEMA_VERSION, ALL_TABLES, CONFIG_DOCUMENTS };

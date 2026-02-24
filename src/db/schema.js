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

const SCHEMA_VERSION = 1;

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
  exp             REAL DEFAULT 0,

  -- Position
  pos_x           REAL,
  pos_y           REAL,
  pos_z           REAL,
  rotation_yaw    REAL,

  -- Respawn point
  respawn_x       REAL,
  respawn_y       REAL,
  respawn_z       REAL,

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

  -- Playtime (from PlaytimeTracker)
  playtime_seconds   INTEGER DEFAULT 0,
  session_count      INTEGER DEFAULT 0,

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
  pos_x      REAL,
  pos_y      REAL,
  pos_z      REAL,
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
  id          TEXT PRIMARY KEY,                -- internal name / row name
  name        TEXT NOT NULL,                   -- display name
  description TEXT DEFAULT '',
  category    TEXT DEFAULT '',                 -- weapon, food, medical, tool, etc.
  icon        TEXT DEFAULT '',                 -- icon asset path
  blueprint   TEXT DEFAULT '',                 -- blueprint class path
  stack_size  INTEGER DEFAULT 1,
  extra       TEXT DEFAULT '{}'                -- JSON: any additional properties
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
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  type        TEXT DEFAULT 'crafting',         -- crafting | building
  station     TEXT DEFAULT '',                 -- required crafting station
  ingredients TEXT DEFAULT '[]',               -- JSON array
  result      TEXT DEFAULT '',
  extra       TEXT DEFAULT '{}'
);
`;

const GAME_QUESTS = `
CREATE TABLE IF NOT EXISTS game_quests (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT DEFAULT '',
  objectives  TEXT DEFAULT '[]',               -- JSON array of objectives
  rewards     TEXT DEFAULT '[]',
  extra       TEXT DEFAULT '{}'
);
`;

const GAME_LORE = `
CREATE TABLE IF NOT EXISTS game_lore (
  id          TEXT PRIMARY KEY,
  title       TEXT DEFAULT '',
  text        TEXT DEFAULT '',
  location    TEXT DEFAULT ''
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
  type        TEXT DEFAULT '',                 -- starter, inland, coast
  image       TEXT DEFAULT ''
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

// ─── Meta ───────────────────────────────────────────────────────────────────

const META = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
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
  PLAYERS,
  CLANS,
  CLAN_MEMBERS,
  WORLD_STATE,
  STRUCTURES,
  VEHICLES,
  COMPANIONS,
  DEAD_BODIES,
  CONTAINERS,
  LOOT_ACTORS,
  QUESTS,
  SERVER_SETTINGS,
  GAME_ITEMS,
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
  INDEXES,
];

module.exports = { SCHEMA_VERSION, ALL_TABLES };

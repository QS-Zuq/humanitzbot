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
 *   const db = require('./database');
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
    this._stmts = {}; // cached prepared statements
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

      // Copy template DB on first run (pre-seeded with game reference data)
      if (!fs.existsSync(this._dbPath)) {
        const templatePath = path.join(path.dirname(this._dbPath), 'humanitz-template.db');
        if (fs.existsSync(templatePath)) {
          fs.copyFileSync(templatePath, this._dbPath);
          console.log(`[${this._label}] Copied template DB as starting point`);
        }
      }
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

  get db() {
    return this._db;
  }

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
      this._db.exec('BEGIN');
      const fromVersion = parseInt(currentVersion, 10);

      // v1 → v2: Add player_aliases table
      if (fromVersion < 2) {
        this._db.exec(`
          CREATE TABLE IF NOT EXISTS player_aliases (
            steam_id    TEXT NOT NULL,
            name        TEXT NOT NULL,
            name_lower  TEXT NOT NULL,
            source      TEXT NOT NULL DEFAULT '',
            first_seen  TEXT DEFAULT (datetime('now')),
            last_seen   TEXT DEFAULT (datetime('now')),
            is_current  INTEGER DEFAULT 1,
            PRIMARY KEY (steam_id, name_lower)
          );
          CREATE INDEX IF NOT EXISTS idx_aliases_name_lower ON player_aliases(name_lower);
          CREATE INDEX IF NOT EXISTS idx_aliases_steam ON player_aliases(steam_id);
        `);
        // Seed aliases from existing players table
        const players = this._db.prepare("SELECT steam_id, name, name_history FROM players WHERE name != ''").all();
        const insertAlias = this._db.prepare(`
          INSERT OR IGNORE INTO player_aliases (steam_id, name, name_lower, source, first_seen, last_seen, is_current)
          VALUES (?, ?, ?, 'save', datetime('now'), datetime('now'), ?)
        `);
        for (const p of players) {
          if (p.name) insertAlias.run(p.steam_id, p.name, p.name.toLowerCase(), 1);
          // Also import name history
          try {
            const history = JSON.parse(p.name_history || '[]');
            for (const h of history) {
              if (h.name) insertAlias.run(p.steam_id, h.name, h.name.toLowerCase(), 0);
            }
          } catch {
            /* ignore bad JSON */
          }
        }
        console.log(`[${this._label}] Migration v1→v2: created player_aliases (seeded ${players.length} players)`);
      }

      // v2 → v3: Add day_incremented + infection_timer columns to players
      if (fromVersion < 3) {
        // Use try/catch per column so migration is safe if columns already exist
        try {
          this._db.exec('ALTER TABLE players ADD COLUMN day_incremented INTEGER DEFAULT 0');
        } catch {
          /* already exists */
        }
        try {
          this._db.exec('ALTER TABLE players ADD COLUMN infection_timer REAL DEFAULT 0');
        } catch {
          /* already exists */
        }
        console.log(`[${this._label}] Migration v2→v3: added day_incremented + infection_timer columns`);
      }

      // v3 → v4: Add world_horses table, enrich containers, add activity_log
      if (fromVersion < 4) {
        // World horses table
        this._db.exec(`
          CREATE TABLE IF NOT EXISTS world_horses (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            actor_name      TEXT NOT NULL DEFAULT '',
            class           TEXT DEFAULT '',
            display_name    TEXT DEFAULT '',
            horse_name      TEXT DEFAULT '',
            owner_steam_id  TEXT DEFAULT '',
            pos_x           REAL,
            pos_y           REAL,
            pos_z           REAL,
            health          REAL DEFAULT 0,
            max_health      REAL DEFAULT 0,
            energy          REAL DEFAULT 0,
            stamina         REAL DEFAULT 0,
            saddle_inventory TEXT DEFAULT '[]',
            inventory       TEXT DEFAULT '[]',
            extra           TEXT DEFAULT '{}',
            updated_at      TEXT DEFAULT (datetime('now'))
          );
        `);

        // Enrich containers table with new columns
        try {
          this._db.exec("ALTER TABLE containers ADD COLUMN quick_slots TEXT DEFAULT '[]'");
        } catch {
          /* already exists */
        }
        try {
          this._db.exec('ALTER TABLE containers ADD COLUMN locked INTEGER DEFAULT 0');
        } catch {
          /* already exists */
        }
        try {
          this._db.exec('ALTER TABLE containers ADD COLUMN does_spawn_loot INTEGER DEFAULT 0');
        } catch {
          /* already exists */
        }
        try {
          this._db.exec('ALTER TABLE containers ADD COLUMN alarm_off INTEGER DEFAULT 0');
        } catch {
          /* already exists */
        }
        try {
          this._db.exec("ALTER TABLE containers ADD COLUMN crafting_content TEXT DEFAULT '[]'");
        } catch {
          /* already exists */
        }
        try {
          this._db.exec("ALTER TABLE containers ADD COLUMN extra TEXT DEFAULT '{}'");
        } catch {
          /* already exists */
        }

        // Activity log table
        this._db.exec(`
          CREATE TABLE IF NOT EXISTS activity_log (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            type        TEXT NOT NULL,
            category    TEXT DEFAULT '',
            actor       TEXT DEFAULT '',
            actor_name  TEXT DEFAULT '',
            item        TEXT DEFAULT '',
            amount      INTEGER DEFAULT 0,
            details     TEXT DEFAULT '{}',
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
        `);

        console.log(`[${this._label}] Migration v3→v4: added world_horses, enriched containers, added activity_log`);
      }

      // v4 → v5: Add steam_id + source + target columns to activity_log, create chat_log
      if (fromVersion < 5) {
        // New columns on activity_log
        try {
          this._db.exec("ALTER TABLE activity_log ADD COLUMN steam_id TEXT DEFAULT ''");
        } catch {
          /* already exists */
        }
        try {
          this._db.exec("ALTER TABLE activity_log ADD COLUMN source TEXT DEFAULT 'save'");
        } catch {
          /* already exists */
        }
        try {
          this._db.exec("ALTER TABLE activity_log ADD COLUMN target_name TEXT DEFAULT ''");
        } catch {
          /* already exists */
        }
        try {
          this._db.exec("ALTER TABLE activity_log ADD COLUMN target_steam_id TEXT DEFAULT ''");
        } catch {
          /* already exists */
        }
        // New indexes
        try {
          this._db.exec('CREATE INDEX IF NOT EXISTS idx_activity_steam_id ON activity_log(steam_id)');
        } catch {
          /* */
        }
        try {
          this._db.exec('CREATE INDEX IF NOT EXISTS idx_activity_source ON activity_log(source)');
        } catch {
          /* */
        }

        // Chat log table
        this._db.exec(`
          CREATE TABLE IF NOT EXISTS chat_log (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            type         TEXT NOT NULL,
            player_name  TEXT DEFAULT '',
            steam_id     TEXT DEFAULT '',
            message      TEXT DEFAULT '',
            direction    TEXT DEFAULT 'game',
            discord_user TEXT DEFAULT '',
            is_admin     INTEGER DEFAULT 0,
            created_at   TEXT DEFAULT (datetime('now'))
          );
          CREATE INDEX IF NOT EXISTS idx_chat_created ON chat_log(created_at);
          CREATE INDEX IF NOT EXISTS idx_chat_type ON chat_log(type);
          CREATE INDEX IF NOT EXISTS idx_chat_steam ON chat_log(steam_id);
          CREATE INDEX IF NOT EXISTS idx_chat_player ON chat_log(player_name);
        `);

        console.log(`[${this._label}] Migration v4→v5: enriched activity_log, added chat_log`);
      }

      // v5 → v6: Add level, exp_current, exp_required, skills_point columns to players
      if (fromVersion < 6) {
        try {
          this._db.exec('ALTER TABLE players ADD COLUMN level INTEGER DEFAULT 0');
        } catch {
          /* already exists */
        }
        try {
          this._db.exec('ALTER TABLE players ADD COLUMN exp_current REAL DEFAULT 0');
        } catch {
          /* already exists */
        }
        try {
          this._db.exec('ALTER TABLE players ADD COLUMN exp_required REAL DEFAULT 0');
        } catch {
          /* already exists */
        }
        try {
          this._db.exec('ALTER TABLE players ADD COLUMN skills_point INTEGER DEFAULT 0');
        } catch {
          /* already exists */
        }
        console.log(`[${this._label}] Migration v5→v6: added level, exp_current, exp_required, skills_point`);
      }

      // v6 → v7: Item instance tracking, item movements, world drops
      if (fromVersion < 7) {
        this._db.exec(`
          CREATE TABLE IF NOT EXISTS item_instances (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            fingerprint     TEXT NOT NULL,
            item            TEXT NOT NULL,
            durability      REAL DEFAULT 0,
            ammo            INTEGER DEFAULT 0,
            attachments     TEXT DEFAULT '[]',
            cap             REAL DEFAULT 0,
            max_dur         REAL DEFAULT 0,
            location_type   TEXT NOT NULL DEFAULT '',
            location_id     TEXT DEFAULT '',
            location_slot   TEXT DEFAULT '',
            pos_x           REAL,
            pos_y           REAL,
            pos_z           REAL,
            amount          INTEGER DEFAULT 1,
            first_seen      TEXT DEFAULT (datetime('now')),
            last_seen       TEXT DEFAULT (datetime('now')),
            lost            INTEGER DEFAULT 0,
            lost_at         TEXT
          );
          CREATE INDEX IF NOT EXISTS idx_item_inst_fingerprint ON item_instances(fingerprint);
          CREATE INDEX IF NOT EXISTS idx_item_inst_item ON item_instances(item);
          CREATE INDEX IF NOT EXISTS idx_item_inst_location ON item_instances(location_type, location_id);
          CREATE INDEX IF NOT EXISTS idx_item_inst_active ON item_instances(lost);
        `);

        this._db.exec(`
          CREATE TABLE IF NOT EXISTS item_movements (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            instance_id     INTEGER NOT NULL REFERENCES item_instances(id),
            item            TEXT NOT NULL,
            from_type       TEXT DEFAULT '',
            from_id         TEXT DEFAULT '',
            from_slot       TEXT DEFAULT '',
            to_type         TEXT NOT NULL,
            to_id           TEXT NOT NULL,
            to_slot         TEXT DEFAULT '',
            amount          INTEGER DEFAULT 1,
            attributed_steam_id TEXT DEFAULT '',
            attributed_name TEXT DEFAULT '',
            pos_x           REAL,
            pos_y           REAL,
            pos_z           REAL,
            created_at      TEXT DEFAULT (datetime('now'))
          );
          CREATE INDEX IF NOT EXISTS idx_item_mov_instance ON item_movements(instance_id);
          CREATE INDEX IF NOT EXISTS idx_item_mov_item ON item_movements(item);
          CREATE INDEX IF NOT EXISTS idx_item_mov_created ON item_movements(created_at);
          CREATE INDEX IF NOT EXISTS idx_item_mov_attributed ON item_movements(attributed_steam_id);
        `);

        this._db.exec(`
          CREATE TABLE IF NOT EXISTS world_drops (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            type            TEXT NOT NULL,
            actor_name      TEXT DEFAULT '',
            item            TEXT DEFAULT '',
            amount          INTEGER DEFAULT 0,
            durability      REAL DEFAULT 0,
            items           TEXT DEFAULT '[]',
            world_loot      INTEGER DEFAULT 0,
            placed          INTEGER DEFAULT 0,
            spawned         INTEGER DEFAULT 0,
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
        `);

        console.log(`[${this._label}] Migration v6→v7: added item_instances, item_movements, world_drops`);
      }

      // v7 → v8: Item groups (fungible item tracking) + schema updates
      if (fromVersion < 8) {
        this._db.exec(`
          CREATE TABLE IF NOT EXISTS item_groups (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            fingerprint     TEXT NOT NULL,
            item            TEXT NOT NULL,
            durability      REAL DEFAULT 0,
            ammo            INTEGER DEFAULT 0,
            attachments     TEXT DEFAULT '[]',
            cap             REAL DEFAULT 0,
            max_dur         REAL DEFAULT 0,
            location_type   TEXT NOT NULL DEFAULT '',
            location_id     TEXT DEFAULT '',
            location_slot   TEXT DEFAULT '',
            pos_x           REAL,
            pos_y           REAL,
            pos_z           REAL,
            quantity        INTEGER DEFAULT 1,
            stack_size      INTEGER DEFAULT 1,
            first_seen      TEXT DEFAULT (datetime('now')),
            last_seen       TEXT DEFAULT (datetime('now')),
            lost            INTEGER DEFAULT 0,
            lost_at         TEXT
          );
          CREATE INDEX IF NOT EXISTS idx_item_grp_fingerprint ON item_groups(fingerprint);
          CREATE INDEX IF NOT EXISTS idx_item_grp_item ON item_groups(item);
          CREATE INDEX IF NOT EXISTS idx_item_grp_location ON item_groups(location_type, location_id);
          CREATE INDEX IF NOT EXISTS idx_item_grp_active ON item_groups(lost);
          CREATE UNIQUE INDEX IF NOT EXISTS idx_item_grp_unique ON item_groups(fingerprint, location_type, location_id, location_slot) WHERE lost = 0;
        `);

        // Add group_id to item_instances if not present
        try {
          this._db.exec('ALTER TABLE item_instances ADD COLUMN group_id INTEGER DEFAULT NULL');
        } catch {
          /* already exists */
        }
        try {
          this._db.exec('CREATE INDEX IF NOT EXISTS idx_item_inst_group ON item_instances(group_id)');
        } catch {
          /* already exists */
        }

        // Add group_id + move_type to item_movements if not present
        try {
          this._db.exec('ALTER TABLE item_movements ADD COLUMN group_id INTEGER DEFAULT NULL');
        } catch {
          /* already exists */
        }
        try {
          this._db.exec("ALTER TABLE item_movements ADD COLUMN move_type TEXT DEFAULT 'move'");
        } catch {
          /* already exists */
        }
        try {
          this._db.exec('CREATE INDEX IF NOT EXISTS idx_item_mov_group ON item_movements(group_id)');
        } catch {
          /* already exists */
        }

        // Make instance_id nullable (group-level movements don't have an instance)
        // SQLite doesn't support ALTER COLUMN, but the column already allows NULL values
        // since the NOT NULL constraint is only enforced on INSERT

        console.log(`[${this._label}] Migration v7→v8: added item_groups, group_id columns`);
      }

      // v8 → v9: DB-first player stats & playtime — add detailed log columns + server_peaks
      if (fromVersion < 9) {
        // New detailed log stats columns on players
        try {
          this._db.exec('ALTER TABLE players ADD COLUMN log_connects INTEGER DEFAULT 0');
        } catch {
          /* already exists */
        }
        try {
          this._db.exec('ALTER TABLE players ADD COLUMN log_disconnects INTEGER DEFAULT 0');
        } catch {
          /* already exists */
        }
        try {
          this._db.exec('ALTER TABLE players ADD COLUMN log_admin_access INTEGER DEFAULT 0');
        } catch {
          /* already exists */
        }
        try {
          this._db.exec('ALTER TABLE players ADD COLUMN log_destroyed_out INTEGER DEFAULT 0');
        } catch {
          /* already exists */
        }
        try {
          this._db.exec('ALTER TABLE players ADD COLUMN log_destroyed_in INTEGER DEFAULT 0');
        } catch {
          /* already exists */
        }
        try {
          this._db.exec("ALTER TABLE players ADD COLUMN log_build_items TEXT DEFAULT '{}'");
        } catch {
          /* already exists */
        }
        try {
          this._db.exec("ALTER TABLE players ADD COLUMN log_killed_by TEXT DEFAULT '{}'");
        } catch {
          /* already exists */
        }
        try {
          this._db.exec("ALTER TABLE players ADD COLUMN log_damage_detail TEXT DEFAULT '{}'");
        } catch {
          /* already exists */
        }
        try {
          this._db.exec("ALTER TABLE players ADD COLUMN log_cheat_flags TEXT DEFAULT '[]'");
        } catch {
          /* already exists */
        }
        // New playtime detail columns on players
        try {
          this._db.exec('ALTER TABLE players ADD COLUMN playtime_first_seen TEXT');
        } catch {
          /* already exists */
        }
        try {
          this._db.exec('ALTER TABLE players ADD COLUMN playtime_last_login TEXT');
        } catch {
          /* already exists */
        }
        try {
          this._db.exec('ALTER TABLE players ADD COLUMN playtime_last_seen TEXT');
        } catch {
          /* already exists */
        }

        // Server peaks table
        this._db.exec(`
          CREATE TABLE IF NOT EXISTS server_peaks (
            key         TEXT PRIMARY KEY,
            value       TEXT DEFAULT '',
            updated_at  TEXT DEFAULT (datetime('now'))
          );
        `);

        console.log(`[${this._label}] Migration v8→v9: DB-first player stats & playtime`);
      }

      // v9 → v10: Timeline tables (full temporal tracking) + death causes
      if (fromVersion < 10) {
        this._db.exec(`
          CREATE TABLE IF NOT EXISTS timeline_snapshots (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            game_day        INTEGER DEFAULT 0,
            game_time       REAL DEFAULT 0,
            player_count    INTEGER DEFAULT 0,
            online_count    INTEGER DEFAULT 0,
            ai_count        INTEGER DEFAULT 0,
            structure_count INTEGER DEFAULT 0,
            vehicle_count   INTEGER DEFAULT 0,
            container_count INTEGER DEFAULT 0,
            world_item_count INTEGER DEFAULT 0,
            weather_type    TEXT DEFAULT '',
            season          TEXT DEFAULT '',
            airdrop_active  INTEGER DEFAULT 0,
            airdrop_x       REAL,
            airdrop_y       REAL,
            airdrop_ai_alive INTEGER DEFAULT 0,
            summary         TEXT DEFAULT '{}',
            created_at      TEXT DEFAULT (datetime('now'))
          );
          CREATE INDEX IF NOT EXISTS idx_tl_snap_created ON timeline_snapshots(created_at);
          CREATE INDEX IF NOT EXISTS idx_tl_snap_day ON timeline_snapshots(game_day);
        `);

        this._db.exec(`
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
        `);

        this._db.exec(`
          CREATE TABLE IF NOT EXISTS timeline_ai (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            snapshot_id     INTEGER NOT NULL REFERENCES timeline_snapshots(id) ON DELETE CASCADE,
            ai_type         TEXT NOT NULL,
            category        TEXT NOT NULL DEFAULT '',
            display_name    TEXT DEFAULT '',
            node_uid        TEXT DEFAULT '',
            pos_x           REAL,
            pos_y           REAL,
            pos_z           REAL
          );
          CREATE INDEX IF NOT EXISTS idx_tl_ai_snap ON timeline_ai(snapshot_id);
          CREATE INDEX IF NOT EXISTS idx_tl_ai_type ON timeline_ai(ai_type);
          CREATE INDEX IF NOT EXISTS idx_tl_ai_cat ON timeline_ai(category);
        `);

        this._db.exec(`
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
            item_count      INTEGER DEFAULT 0
          );
          CREATE INDEX IF NOT EXISTS idx_tl_vehicles_snap ON timeline_vehicles(snapshot_id);
        `);

        this._db.exec(`
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
        `);

        this._db.exec(`
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
            pos_x           REAL,
            pos_y           REAL
          );
          CREATE INDEX IF NOT EXISTS idx_tl_houses_snap ON timeline_houses(snapshot_id);
          CREATE INDEX IF NOT EXISTS idx_tl_houses_uid ON timeline_houses(uid);
        `);

        this._db.exec(`
          CREATE TABLE IF NOT EXISTS timeline_companions (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            snapshot_id     INTEGER NOT NULL REFERENCES timeline_snapshots(id) ON DELETE CASCADE,
            entity_type     TEXT NOT NULL,
            actor_name      TEXT DEFAULT '',
            display_name    TEXT DEFAULT '',
            owner_steam_id  TEXT DEFAULT '',
            pos_x           REAL,
            pos_y           REAL,
            pos_z           REAL,
            health          REAL DEFAULT 0,
            extra           TEXT DEFAULT '{}'
          );
          CREATE INDEX IF NOT EXISTS idx_tl_companions_snap ON timeline_companions(snapshot_id);
        `);

        this._db.exec(`
          CREATE TABLE IF NOT EXISTS timeline_backpacks (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            snapshot_id     INTEGER NOT NULL REFERENCES timeline_snapshots(id) ON DELETE CASCADE,
            class           TEXT DEFAULT '',
            pos_x           REAL,
            pos_y           REAL,
            pos_z           REAL,
            item_count      INTEGER DEFAULT 0,
            items_summary   TEXT DEFAULT '[]'
          );
          CREATE INDEX IF NOT EXISTS idx_tl_backpacks_snap ON timeline_backpacks(snapshot_id);
        `);

        this._db.exec(`
          CREATE TABLE IF NOT EXISTS death_causes (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            victim_name     TEXT NOT NULL,
            victim_steam_id TEXT DEFAULT '',
            cause_type      TEXT NOT NULL,
            cause_name      TEXT DEFAULT '',
            cause_raw       TEXT DEFAULT '',
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
        `);

        console.log(`[${this._label}] Migration v9→v10: timeline tables + death causes`);
      }

      // v10 → v11: Expanded game_items schema + new reference tables
      if (fromVersion < 11) {
        // Drop and recreate game_items with expanded columns
        this._db.exec('DROP TABLE IF EXISTS game_items');
        this._db.exec(`
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
            durability_loss       REAL DEFAULT 0,
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
        `);

        // New reference tables
        this._db.exec(`
          CREATE TABLE IF NOT EXISTS game_buildings (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '',
            category TEXT DEFAULT '', category_raw TEXT DEFAULT '', health REAL DEFAULT 0,
            show_in_build_menu INTEGER DEFAULT 0, requires_build_tool INTEGER DEFAULT 0,
            moveable INTEGER DEFAULT 0, learned_building INTEGER DEFAULT 0,
            landscape_only INTEGER DEFAULT 0, water_only INTEGER DEFAULT 0,
            structure_only INTEGER DEFAULT 0, wall_placement INTEGER DEFAULT 0,
            require_foundation INTEGER DEFAULT 0, xp_multiplier REAL DEFAULT 1,
            resources TEXT DEFAULT '[]', upgrades TEXT DEFAULT '[]'
          );
        `);

        this._db.exec(`
          CREATE TABLE IF NOT EXISTS game_loot_pools (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, item_count INTEGER DEFAULT 0
          );
        `);

        this._db.exec(`
          CREATE TABLE IF NOT EXISTS game_loot_pool_items (
            pool_id TEXT NOT NULL, item_id TEXT NOT NULL, name TEXT DEFAULT '',
            chance_to_spawn REAL DEFAULT 0, type TEXT DEFAULT '', max_stack_size INTEGER DEFAULT 1,
            PRIMARY KEY (pool_id, item_id)
          );
          CREATE INDEX IF NOT EXISTS idx_loot_pool ON game_loot_pool_items(pool_id);
        `);

        this._db.exec(`CREATE TABLE IF NOT EXISTS game_vehicles_ref (id TEXT PRIMARY KEY, name TEXT NOT NULL);`);
        this._db.exec(
          `CREATE TABLE IF NOT EXISTS game_animals (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT DEFAULT '', hide_item_id TEXT DEFAULT '');`,
        );
        this._db.exec(`
          CREATE TABLE IF NOT EXISTS game_crops (
            id TEXT PRIMARY KEY, crop_id INTEGER DEFAULT 0, growth_time_days REAL DEFAULT 0,
            grid_columns INTEGER DEFAULT 1, grid_rows INTEGER DEFAULT 1,
            harvest_result TEXT DEFAULT '', harvest_count INTEGER DEFAULT 0, grow_seasons TEXT DEFAULT '[]'
          );
        `);
        this._db.exec(`
          CREATE TABLE IF NOT EXISTS game_car_upgrades (
            id TEXT PRIMARY KEY, type TEXT DEFAULT '', type_raw TEXT DEFAULT '', level INTEGER DEFAULT 0,
            socket TEXT DEFAULT '', tool_durability_lost REAL DEFAULT 0, craft_time_minutes REAL DEFAULT 0,
            health REAL DEFAULT 0, craft_cost TEXT DEFAULT '[]'
          );
        `);
        this._db.exec(
          `CREATE TABLE IF NOT EXISTS game_ammo_types (id TEXT PRIMARY KEY, damage REAL DEFAULT 0, headshot_multiplier REAL DEFAULT 1, range REAL DEFAULT 0, penetration REAL DEFAULT 0);`,
        );
        this._db.exec(`
          CREATE TABLE IF NOT EXISTS game_repair_data (
            id TEXT PRIMARY KEY, resource_type TEXT DEFAULT '', resource_type_raw TEXT DEFAULT '',
            amount INTEGER DEFAULT 0, health_to_add REAL DEFAULT 0, is_repairable INTEGER DEFAULT 1,
            extra_resources TEXT DEFAULT '[]'
          );
        `);
        this._db.exec(
          `CREATE TABLE IF NOT EXISTS game_furniture (id TEXT PRIMARY KEY, name TEXT NOT NULL, mesh_count INTEGER DEFAULT 0, drop_resources TEXT DEFAULT '[]');`,
        );
        this._db.exec(
          `CREATE TABLE IF NOT EXISTS game_traps (id TEXT PRIMARY KEY, item_id TEXT DEFAULT '', requires_weapon INTEGER DEFAULT 0, requires_ammo INTEGER DEFAULT 0, requires_items INTEGER DEFAULT 0, required_ammo_id TEXT DEFAULT '');`,
        );
        this._db.exec(
          `CREATE TABLE IF NOT EXISTS game_sprays (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '', color TEXT DEFAULT '');`,
        );

        // Drop and recreate changed reference tables
        this._db.exec('DROP TABLE IF EXISTS game_recipes');
        this._db.exec(`
          CREATE TABLE IF NOT EXISTS game_recipes (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '',
            station TEXT DEFAULT '', station_raw TEXT DEFAULT '', recipe_type TEXT DEFAULT '',
            craft_time REAL DEFAULT 0, profession TEXT DEFAULT '', profession_raw TEXT DEFAULT '',
            requires_recipe INTEGER DEFAULT 0, hidden INTEGER DEFAULT 0,
            inventory_search_only INTEGER DEFAULT 0, xp_multiplier REAL DEFAULT 1,
            use_any INTEGER DEFAULT 0, copy_capacity INTEGER DEFAULT 0, no_spoiled INTEGER DEFAULT 0,
            ignore_melee_check INTEGER DEFAULT 0, override_name TEXT DEFAULT '',
            override_description TEXT DEFAULT '', crafted_item TEXT DEFAULT '{}',
            also_give_item TEXT DEFAULT '{}', also_give_arr TEXT DEFAULT '[]',
            ingredients TEXT DEFAULT '[]'
          );
        `);

        this._db.exec('DROP TABLE IF EXISTS game_lore');
        this._db.exec(`
          CREATE TABLE IF NOT EXISTS game_lore (
            id TEXT PRIMARY KEY, title TEXT DEFAULT '', text TEXT DEFAULT '',
            category TEXT DEFAULT '', sort_order INTEGER DEFAULT 0
          );
        `);

        this._db.exec('DROP TABLE IF EXISTS game_quests');
        this._db.exec(`
          CREATE TABLE IF NOT EXISTS game_quests (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '',
            xp_reward INTEGER DEFAULT 0, requirements TEXT DEFAULT '[]', rewards TEXT DEFAULT '[]'
          );
        `);

        this._db.exec('DROP TABLE IF EXISTS game_spawn_locations');
        this._db.exec(`
          CREATE TABLE IF NOT EXISTS game_spawn_locations (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '', map TEXT DEFAULT ''
          );
        `);

        console.log(`[${this._label}] Migration v10→v11: expanded game_items, added 11 new reference tables`);
      }

      // v11 → v12: bot_state key-value table for runtime operational state
      if (fromVersion < 12) {
        this._db.exec(`
          CREATE TABLE IF NOT EXISTS bot_state (
            key        TEXT PRIMARY KEY,
            value      TEXT,
            updated_at TEXT DEFAULT (datetime('now'))
          );
        `);
        console.log(`[${this._label}] Migration v11→v12: bot_state table`);
      }

      // v12 → v13: anticheat tables (flags, risk scores, entity fingerprints)
      if (fromVersion < 13) {
        this._db.exec(`
          CREATE TABLE IF NOT EXISTS anticheat_flags (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            steam_id        TEXT NOT NULL,
            player_name     TEXT DEFAULT '',
            detector        TEXT NOT NULL,
            severity        TEXT DEFAULT 'low',
            score           REAL DEFAULT 0,
            details         TEXT DEFAULT '{}',
            evidence        TEXT DEFAULT '[]',
            status          TEXT DEFAULT 'open',
            reviewed_by     TEXT,
            reviewed_at     TEXT,
            review_notes    TEXT,
            auto_escalated  INTEGER DEFAULT 0,
            created_at      TEXT DEFAULT (datetime('now'))
          );
          CREATE INDEX IF NOT EXISTS idx_ac_flags_steam    ON anticheat_flags(steam_id);
          CREATE INDEX IF NOT EXISTS idx_ac_flags_detector ON anticheat_flags(detector);
          CREATE INDEX IF NOT EXISTS idx_ac_flags_status   ON anticheat_flags(status);
          CREATE INDEX IF NOT EXISTS idx_ac_flags_severity ON anticheat_flags(severity);
          CREATE INDEX IF NOT EXISTS idx_ac_flags_created  ON anticheat_flags(created_at);

          CREATE TABLE IF NOT EXISTS player_risk_scores (
            steam_id        TEXT PRIMARY KEY,
            risk_score      REAL DEFAULT 0,
            open_flags      INTEGER DEFAULT 0,
            confirmed_flags INTEGER DEFAULT 0,
            dismissed_flags INTEGER DEFAULT 0,
            last_flag_at    TEXT,
            last_scored_at  TEXT,
            baseline_data   TEXT DEFAULT '{}',
            updated_at      TEXT DEFAULT (datetime('now'))
          );

          CREATE TABLE IF NOT EXISTS entity_fingerprints (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            entity_type     TEXT NOT NULL,
            entity_id       TEXT NOT NULL,
            fingerprint     TEXT NOT NULL,
            parent_id       INTEGER,
            creator_steam_id TEXT,
            created_at      TEXT DEFAULT (datetime('now')),
            last_validated  TEXT,
            tamper_score    REAL DEFAULT 0,
            metadata        TEXT DEFAULT '{}'
          );
          CREATE INDEX IF NOT EXISTS idx_ef_type          ON entity_fingerprints(entity_type);
          CREATE INDEX IF NOT EXISTS idx_ef_entity        ON entity_fingerprints(entity_id);
          CREATE INDEX IF NOT EXISTS idx_ef_fingerprint   ON entity_fingerprints(fingerprint);
          CREATE INDEX IF NOT EXISTS idx_ef_creator       ON entity_fingerprints(creator_steam_id);
          CREATE UNIQUE INDEX IF NOT EXISTS idx_ef_unique ON entity_fingerprints(entity_type, entity_id);

          CREATE TABLE IF NOT EXISTS fingerprint_events (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            fingerprint_id  INTEGER REFERENCES entity_fingerprints(id),
            event_type      TEXT NOT NULL,
            old_state       TEXT,
            new_state       TEXT,
            attributed_to   TEXT,
            source          TEXT,
            confidence      REAL DEFAULT 1.0,
            created_at      TEXT DEFAULT (datetime('now'))
          );
          CREATE INDEX IF NOT EXISTS idx_fpe_fingerprint ON fingerprint_events(fingerprint_id);
          CREATE INDEX IF NOT EXISTS idx_fpe_attributed  ON fingerprint_events(attributed_to);
          CREATE INDEX IF NOT EXISTS idx_fpe_type        ON fingerprint_events(event_type);
          CREATE INDEX IF NOT EXISTS idx_fpe_created     ON fingerprint_events(created_at);
        `);
        console.log(`[${this._label}] Migration v12→v13: anticheat flags, risk scores, entity fingerprints`);
      }

      // v14 → v15: config_documents table (DB-backed configuration storage)
      if (fromVersion < 15) {
        this._db.exec(`
          CREATE TABLE IF NOT EXISTS config_documents (
            scope      TEXT PRIMARY KEY,
            data       TEXT NOT NULL DEFAULT '{}',
            version    INTEGER DEFAULT 1,
            updated_at TEXT DEFAULT (datetime('now'))
          );
        `);
        console.log(`[${this._label}] Migration v14→v15: config_documents table`);
      }

      this._setMeta('schema_version', String(SCHEMA_VERSION));
      this._db.exec('COMMIT');
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
  getMeta(key) {
    return this._getMeta(key);
  }

  /** Public meta setter. */
  setMeta(key, value) {
    return this._setMeta(key, value);
  }

  _setMeta(key, value) {
    this._db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Bot State (key-value store for runtime operational state)
  // ═══════════════════════════════════════════════════════════════════════════

  /** Get a bot_state value by key. Returns null if not found. */
  getState(key) {
    const row = this._db.prepare('SELECT value FROM bot_state WHERE key = ?').get(key);
    return row ? row.value : null;
  }

  /** Set a bot_state value. Creates or replaces. */
  setState(key, value) {
    this._db
      .prepare("INSERT OR REPLACE INTO bot_state (key, value, updated_at) VALUES (?, ?, datetime('now'))")
      .run(key, value != null ? String(value) : null);
  }

  /** Get a bot_state value parsed as JSON. Returns defaultVal if not found or parse fails. */
  getStateJSON(key, defaultVal = null) {
    const raw = this.getState(key);
    if (raw == null) return defaultVal;
    try {
      return JSON.parse(raw);
    } catch {
      return defaultVal;
    }
  }

  /** Set a bot_state value as JSON. */
  setStateJSON(key, value) {
    this.setState(key, JSON.stringify(value));
  }

  /** Delete a bot_state key. */
  deleteState(key) {
    this._db.prepare('DELETE FROM bot_state WHERE key = ?').run(key);
  }

  /** Get all bot_state entries. Returns array of { key, value, updated_at }. */
  getAllState() {
    return this._db.prepare('SELECT key, value, updated_at FROM bot_state ORDER BY key').all();
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
    `);

    // Fast lookups
    this._stmts.getPlayer = this._db.prepare('SELECT * FROM players WHERE steam_id = ?');
    this._stmts.getAllPlayers = this._db.prepare('SELECT * FROM players ORDER BY lifetime_kills DESC');
    this._stmts.getOnlinePlayers = this._db.prepare('SELECT * FROM players WHERE online = 1');
    this._stmts.getOnlinePlayersForDiff = this._db.prepare(
      'SELECT steam_id, name, online, inventory, equipment, quick_slots, backpack_items, pos_x, pos_y, pos_z FROM players WHERE online = 1',
    );
    this._stmts.setPlayerOnline = this._db.prepare(
      "UPDATE players SET online = ?, last_seen = datetime('now') WHERE steam_id = ?",
    );
    this._stmts.setAllOffline = this._db.prepare('UPDATE players SET online = 0');

    // Full log stats upsert — used by DB-first player-stats
    this._stmts.upsertPlayerLogStats = this._db.prepare(`
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
    `);

    // Full playtime upsert — used by DB-first playtime-tracker
    // Uses MAX() to NEVER reduce existing values — prevents data loss if
    // the tracker restarts with empty in-memory state.
    this._stmts.upsertPlayerPlaytime = this._db.prepare(`
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
    `);

    // Get all player log stats (for loading into in-memory cache)
    this._stmts.getAllPlayerLogStats = this._db.prepare(`
      SELECT steam_id, name, log_deaths, log_pvp_kills, log_pvp_deaths,
        log_builds, log_loots, log_damage_taken, log_raids_out, log_raids_in,
        log_connects, log_disconnects, log_admin_access, log_destroyed_out, log_destroyed_in,
        log_build_items, log_killed_by, log_damage_detail, log_cheat_flags, log_last_event
      FROM players
      WHERE log_deaths > 0 OR log_pvp_kills > 0 OR log_builds > 0
        OR log_loots > 0 OR log_raids_out > 0 OR log_connects > 0
        OR log_admin_access > 0
    `);

    // Get all player playtime (for loading into in-memory cache)
    this._stmts.getAllPlayerPlaytime = this._db.prepare(`
      SELECT steam_id, name, playtime_seconds, session_count,
        playtime_first_seen, playtime_last_login, playtime_last_seen
      FROM players
      WHERE playtime_seconds > 0 OR session_count > 0
    `);

    // Server peaks
    this._stmts.setServerPeak = this._db.prepare(
      "INSERT OR REPLACE INTO server_peaks (key, value, updated_at) VALUES (?, ?, datetime('now'))",
    );
    this._stmts.getServerPeak = this._db.prepare('SELECT value FROM server_peaks WHERE key = ?');
    this._stmts.getAllServerPeaks = this._db.prepare('SELECT * FROM server_peaks');

    // Leaderboards
    this._stmts.topKillers = this._db.prepare(
      'SELECT steam_id, name, lifetime_kills, lifetime_headshots, lifetime_melee_kills, lifetime_gun_kills FROM players ORDER BY lifetime_kills DESC LIMIT ?',
    );
    this._stmts.topPlaytime = this._db.prepare(
      'SELECT steam_id, name, playtime_seconds, session_count FROM players ORDER BY playtime_seconds DESC LIMIT ?',
    );
    this._stmts.topSurvival = this._db.prepare(
      'SELECT steam_id, name, lifetime_days_survived, days_survived FROM players ORDER BY lifetime_days_survived DESC LIMIT ?',
    );
    this._stmts.topFish = this._db.prepare(
      'SELECT steam_id, name, fish_caught, fish_caught_pike FROM players WHERE fish_caught > 0 ORDER BY fish_caught DESC LIMIT ?',
    );
    this._stmts.topBitten = this._db.prepare(
      'SELECT steam_id, name, times_bitten FROM players WHERE times_bitten > 0 ORDER BY times_bitten DESC LIMIT ?',
    );
    this._stmts.topPvp = this._db.prepare(
      'SELECT steam_id, name, log_pvp_kills, log_pvp_deaths FROM players WHERE log_pvp_kills > 0 ORDER BY log_pvp_kills DESC LIMIT ?',
    );
    this._stmts.topBuilders = this._db.prepare(
      'SELECT steam_id, name, log_builds FROM players WHERE log_builds > 0 ORDER BY log_builds DESC LIMIT ?',
    );
    this._stmts.topDeaths = this._db.prepare(
      'SELECT steam_id, name, log_deaths, log_killed_by FROM players WHERE log_deaths > 0 ORDER BY log_deaths DESC LIMIT ?',
    );
    this._stmts.topLooters = this._db.prepare(
      'SELECT steam_id, name, log_loots FROM players WHERE log_loots > 0 ORDER BY log_loots DESC LIMIT ?',
    );

    // Clans
    this._stmts.upsertClan = this._db.prepare(
      "INSERT OR REPLACE INTO clans (name, updated_at) VALUES (?, datetime('now'))",
    );
    this._stmts.deleteClanMembers = this._db.prepare('DELETE FROM clan_members WHERE clan_name = ?');
    this._stmts.insertClanMember = this._db.prepare(
      'INSERT OR REPLACE INTO clan_members (clan_name, steam_id, name, rank, can_invite, can_kick) VALUES (?, ?, ?, ?, ?, ?)',
    );
    this._stmts.getAllClans = this._db.prepare('SELECT * FROM clans ORDER BY name');
    this._stmts.getClanMembers = this._db.prepare(
      'SELECT * FROM clan_members WHERE clan_name = ? ORDER BY rank DESC, name',
    );
    this._stmts.getClanForSteamId = this._db.prepare('SELECT clan_name FROM clan_members WHERE steam_id = ? LIMIT 1');
    this._stmts.areClanmates = this._db.prepare(
      `SELECT 1 FROM clan_members a JOIN clan_members b ON a.clan_name = b.clan_name WHERE a.steam_id = ? AND b.steam_id = ? LIMIT 1`,
    );

    // World state
    this._stmts.setWorldState = this._db.prepare(
      "INSERT OR REPLACE INTO world_state (key, value, updated_at) VALUES (?, ?, datetime('now'))",
    );
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
    this._stmts.countStructuresByOwner = this._db.prepare(
      'SELECT owner_steam_id, COUNT(*) as count FROM structures GROUP BY owner_steam_id ORDER BY count DESC',
    );

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

    // World horses
    this._stmts.clearWorldHorses = this._db.prepare('DELETE FROM world_horses');
    this._stmts.insertWorldHorse = this._db.prepare(`
      INSERT INTO world_horses (actor_name, class, display_name, horse_name, owner_steam_id, pos_x, pos_y, pos_z, health, max_health, energy, stamina, saddle_inventory, inventory, extra, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `);
    this._stmts.getAllWorldHorses = this._db.prepare('SELECT * FROM world_horses');

    // Dead bodies
    this._stmts.clearDeadBodies = this._db.prepare('DELETE FROM dead_bodies');
    this._stmts.insertDeadBody = this._db.prepare(
      "INSERT OR REPLACE INTO dead_bodies (actor_name, pos_x, pos_y, pos_z, updated_at) VALUES (?, ?, ?, ?, datetime('now'))",
    );

    // Containers
    this._stmts.clearContainers = this._db.prepare('DELETE FROM containers');
    this._stmts.insertContainer = this._db.prepare(`
      INSERT OR REPLACE INTO containers (actor_name, items, quick_slots, locked, does_spawn_loot, alarm_off, crafting_content, pos_x, pos_y, pos_z, extra, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `);
    this._stmts.getAllContainers = this._db.prepare('SELECT * FROM containers ORDER BY actor_name');
    this._stmts.getContainersWithItems = this._db.prepare(
      "SELECT * FROM containers WHERE items != '[]' ORDER BY actor_name",
    );

    // Loot actors
    this._stmts.clearLootActors = this._db.prepare('DELETE FROM loot_actors');
    this._stmts.insertLootActor = this._db.prepare(
      "INSERT INTO loot_actors (name, type, pos_x, pos_y, pos_z, items, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))",
    );

    // Item instances (fingerprint tracking)
    this._stmts.insertItemInstance = this._db.prepare(`
      INSERT INTO item_instances (fingerprint, item, durability, ammo, attachments, cap, max_dur, location_type, location_id, location_slot, pos_x, pos_y, pos_z, amount, group_id, first_seen, last_seen, lost)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), 0)
    `);
    this._stmts.updateItemInstanceLocation = this._db.prepare(`
      UPDATE item_instances SET location_type = ?, location_id = ?, location_slot = ?, pos_x = ?, pos_y = ?, pos_z = ?, amount = ?, group_id = ?, last_seen = datetime('now'), lost = 0, lost_at = NULL WHERE id = ?
    `);
    this._stmts.markItemInstanceLost = this._db.prepare(`
      UPDATE item_instances SET lost = 1, lost_at = datetime('now') WHERE id = ?
    `);
    this._stmts.markAllItemInstancesLost = this._db.prepare(`
      UPDATE item_instances SET lost = 1, lost_at = datetime('now') WHERE lost = 0
    `);
    this._stmts.touchItemInstance = this._db.prepare(`
      UPDATE item_instances SET last_seen = datetime('now'), lost = 0 WHERE id = ?
    `);
    this._stmts.findItemInstanceByFingerprint = this._db.prepare(
      'SELECT * FROM item_instances WHERE fingerprint = ? AND lost = 0 LIMIT 1',
    );
    this._stmts.findItemInstancesByFingerprint = this._db.prepare(
      'SELECT * FROM item_instances WHERE fingerprint = ? AND lost = 0',
    );
    this._stmts.findItemInstanceById = this._db.prepare('SELECT * FROM item_instances WHERE id = ?');
    this._stmts.getActiveItemInstances = this._db.prepare(
      'SELECT * FROM item_instances WHERE lost = 0 ORDER BY item, location_type',
    );
    this._stmts.getItemInstancesByItem = this._db.prepare(
      'SELECT * FROM item_instances WHERE item = ? AND lost = 0 ORDER BY location_type',
    );
    this._stmts.getItemInstancesByLocation = this._db.prepare(
      'SELECT * FROM item_instances WHERE location_type = ? AND location_id = ? AND lost = 0',
    );
    this._stmts.getItemInstanceCount = this._db.prepare('SELECT COUNT(*) as count FROM item_instances WHERE lost = 0');
    this._stmts.searchItemInstances = this._db.prepare(
      'SELECT * FROM item_instances WHERE (item LIKE ? OR fingerprint LIKE ?) AND lost = 0 ORDER BY item LIMIT ?',
    );
    this._stmts.purgeOldLostItems = this._db.prepare(
      "DELETE FROM item_instances WHERE lost = 1 AND lost_at < datetime('now', ?)",
    );
    this._stmts.getItemInstancesByGroup = this._db.prepare(
      'SELECT * FROM item_instances WHERE group_id = ? AND lost = 0',
    );

    // Item groups (fungible item tracking)
    this._stmts.insertItemGroup = this._db.prepare(`
      INSERT INTO item_groups (fingerprint, item, durability, ammo, attachments, cap, max_dur, location_type, location_id, location_slot, pos_x, pos_y, pos_z, quantity, stack_size, first_seen, last_seen, lost)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), 0)
    `);
    this._stmts.updateItemGroupQuantity = this._db.prepare(`
      UPDATE item_groups SET quantity = ?, last_seen = datetime('now'), lost = 0, lost_at = NULL WHERE id = ?
    `);
    this._stmts.updateItemGroupLocation = this._db.prepare(`
      UPDATE item_groups SET location_type = ?, location_id = ?, location_slot = ?, pos_x = ?, pos_y = ?, pos_z = ?, quantity = ?, last_seen = datetime('now'), lost = 0, lost_at = NULL WHERE id = ?
    `);
    this._stmts.markItemGroupLost = this._db.prepare(`
      UPDATE item_groups SET lost = 1, lost_at = datetime('now') WHERE id = ?
    `);
    this._stmts.markAllItemGroupsLost = this._db.prepare(`
      UPDATE item_groups SET lost = 1, lost_at = datetime('now') WHERE lost = 0
    `);
    this._stmts.touchItemGroup = this._db.prepare(`
      UPDATE item_groups SET last_seen = datetime('now'), lost = 0 WHERE id = ?
    `);
    this._stmts.findActiveGroupByLocation = this._db.prepare(
      'SELECT * FROM item_groups WHERE fingerprint = ? AND location_type = ? AND location_id = ? AND location_slot = ? AND lost = 0 LIMIT 1',
    );
    this._stmts.findActiveGroupsByFingerprint = this._db.prepare(
      'SELECT * FROM item_groups WHERE fingerprint = ? AND lost = 0',
    );
    this._stmts.findItemGroupById = this._db.prepare('SELECT * FROM item_groups WHERE id = ?');
    this._stmts.getActiveItemGroups = this._db.prepare(
      'SELECT * FROM item_groups WHERE lost = 0 ORDER BY item, location_type',
    );
    this._stmts.getItemGroupsByItem = this._db.prepare(
      'SELECT * FROM item_groups WHERE item = ? AND lost = 0 ORDER BY location_type',
    );
    this._stmts.getItemGroupsByLocation = this._db.prepare(
      'SELECT * FROM item_groups WHERE location_type = ? AND location_id = ? AND lost = 0',
    );
    this._stmts.getItemGroupCount = this._db.prepare('SELECT COUNT(*) as count FROM item_groups WHERE lost = 0');
    this._stmts.searchItemGroups = this._db.prepare(
      'SELECT * FROM item_groups WHERE (item LIKE ? OR fingerprint LIKE ?) AND lost = 0 ORDER BY item LIMIT ?',
    );
    this._stmts.purgeOldLostGroups = this._db.prepare(
      "DELETE FROM item_groups WHERE lost = 1 AND lost_at < datetime('now', ?)",
    );

    // Item movements (chain-of-custody)
    this._stmts.insertItemMovement = this._db.prepare(`
      INSERT INTO item_movements (instance_id, group_id, move_type, item, from_type, from_id, from_slot, to_type, to_id, to_slot, amount, attributed_steam_id, attributed_name, pos_x, pos_y, pos_z)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this._stmts.getItemMovements = this._db.prepare(
      'SELECT * FROM item_movements WHERE instance_id = ? ORDER BY created_at ASC',
    );
    this._stmts.getItemMovementsByGroup = this._db.prepare(
      'SELECT * FROM item_movements WHERE group_id = ? ORDER BY created_at ASC',
    );
    this._stmts.getRecentItemMovements = this._db.prepare(
      'SELECT * FROM item_movements ORDER BY created_at DESC LIMIT ?',
    );
    this._stmts.getItemMovementsByPlayer = this._db.prepare(
      'SELECT * FROM item_movements WHERE attributed_steam_id = ? ORDER BY created_at DESC LIMIT ?',
    );
    this._stmts.getItemMovementsByLocation = this._db.prepare(
      'SELECT * FROM item_movements WHERE (from_type = ? AND from_id = ?) OR (to_type = ? AND to_id = ?) ORDER BY created_at DESC LIMIT ?',
    );
    this._stmts.purgeOldMovements = this._db.prepare(
      "DELETE FROM item_movements WHERE created_at < datetime('now', ?)",
    );

    // World drops
    this._stmts.clearWorldDrops = this._db.prepare('DELETE FROM world_drops');
    this._stmts.insertWorldDrop = this._db.prepare(`
      INSERT INTO world_drops (type, actor_name, item, amount, durability, items, world_loot, placed, spawned, locked, does_spawn_loot, pos_x, pos_y, pos_z)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this._stmts.getAllWorldDrops = this._db.prepare('SELECT * FROM world_drops ORDER BY type, item');
    this._stmts.getWorldDropsByType = this._db.prepare('SELECT * FROM world_drops WHERE type = ? ORDER BY item');
    this._stmts.getWorldDropsWithItems = this._db.prepare(
      "SELECT * FROM world_drops WHERE (item != '' OR items != '[]') ORDER BY type",
    );

    // Quests
    this._stmts.clearQuests = this._db.prepare('DELETE FROM quests');
    this._stmts.insertQuest = this._db.prepare(
      "INSERT INTO quests (id, type, state, data, updated_at) VALUES (?, ?, ?, ?, datetime('now'))",
    );

    // Server settings
    this._stmts.upsertSetting = this._db.prepare(
      "INSERT OR REPLACE INTO server_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))",
    );
    this._stmts.getSetting = this._db.prepare('SELECT value FROM server_settings WHERE key = ?');
    this._stmts.getAllSettings = this._db.prepare('SELECT * FROM server_settings ORDER BY key');

    // Game reference
    this._stmts.upsertGameItem = this._db.prepare(`INSERT OR REPLACE INTO game_items (
      id, name, description, type, type_raw, specific_type, wear_position, category,
      chance_to_spawn, durability_loss, armor_protection, max_stack_size, can_stack,
      item_size, weight, first_value, second_item_type, second_value,
      value_to_trader, value_for_player,
      does_decay, decay_per_day, only_decay_if_opened,
      warmth_value, infection_protection, clothing_rain_mod, clothing_snow_mod, summer_cool_value,
      is_skill_book, no_pocket, exclude_from_vendor, exclude_from_ai, use_as_fertilizer,
      state, tag, open_item, body_attach_socket,
      supported_attachments, items_inside, skill_book_data, extra
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    this._stmts.getGameItem = this._db.prepare('SELECT * FROM game_items WHERE id = ?');
    this._stmts.searchGameItems = this._db.prepare('SELECT * FROM game_items WHERE name LIKE ? OR id LIKE ? LIMIT 20');

    // Snapshots
    this._stmts.insertSnapshot = this._db.prepare('INSERT INTO snapshots (type, steam_id, data) VALUES (?, ?, ?)');
    this._stmts.getLatestSnapshot = this._db.prepare(
      'SELECT * FROM snapshots WHERE type = ? AND steam_id = ? ORDER BY created_at DESC LIMIT 1',
    );
    this._stmts.purgeOldSnapshots = this._db.prepare("DELETE FROM snapshots WHERE created_at < datetime('now', ?)");

    // Activity log
    this._stmts.insertActivity = this._db.prepare(`
      INSERT INTO activity_log (type, category, actor, actor_name, item, amount, details, pos_x, pos_y, pos_z, steam_id, source, target_name, target_steam_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this._stmts.insertActivityAt = this._db.prepare(`
      INSERT INTO activity_log (type, category, actor, actor_name, item, amount, details, pos_x, pos_y, pos_z, created_at, steam_id, source, target_name, target_steam_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this._stmts.clearActivityLog = this._db.prepare('DELETE FROM activity_log');
    this._stmts.getRecentActivity = this._db.prepare(
      'SELECT * FROM activity_log ORDER BY created_at DESC, id DESC LIMIT ?',
    );
    this._stmts.getRecentActivityPaged = this._db.prepare(
      'SELECT * FROM activity_log ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?',
    );
    this._stmts.getActivityByCategory = this._db.prepare(
      'SELECT * FROM activity_log WHERE category = ? ORDER BY created_at DESC, id DESC LIMIT ?',
    );
    this._stmts.getActivityByCategoryPaged = this._db.prepare(
      'SELECT * FROM activity_log WHERE category = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?',
    );
    this._stmts.getActivityByActor = this._db.prepare(
      'SELECT * FROM activity_log WHERE actor = ? ORDER BY created_at DESC, id DESC LIMIT ?',
    );
    this._stmts.getActivityByActorPaged = this._db.prepare(
      'SELECT * FROM activity_log WHERE actor = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?',
    );
    this._stmts.getActivitySince = this._db.prepare(
      'SELECT * FROM activity_log WHERE created_at >= ? ORDER BY created_at ASC, id ASC',
    );
    this._stmts.getActivitySinceBySource = this._db.prepare(
      'SELECT * FROM activity_log WHERE created_at >= ? AND source = ? ORDER BY created_at ASC, id ASC',
    );
    this._stmts.purgeOldActivity = this._db.prepare("DELETE FROM activity_log WHERE created_at < datetime('now', ?)");
    this._stmts.countActivity = this._db.prepare('SELECT COUNT(*) as count FROM activity_log');
    this._stmts.countActivityBySource = this._db.prepare(
      'SELECT source, COUNT(*) as count FROM activity_log GROUP BY source',
    );

    // Chat log
    this._stmts.insertChat = this._db.prepare(`
      INSERT INTO chat_log (type, player_name, steam_id, message, direction, discord_user, is_admin)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    this._stmts.insertChatAt = this._db.prepare(`
      INSERT INTO chat_log (type, player_name, steam_id, message, direction, discord_user, is_admin, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this._stmts.getRecentChat = this._db.prepare('SELECT * FROM chat_log ORDER BY created_at DESC, id DESC LIMIT ?');
    this._stmts.searchChat = this._db.prepare(
      'SELECT * FROM chat_log WHERE (message LIKE ? OR player_name LIKE ?) ORDER BY created_at DESC, id DESC LIMIT ?',
    );
    this._stmts.getChatSince = this._db.prepare(
      'SELECT * FROM chat_log WHERE created_at >= ? ORDER BY created_at ASC, id ASC',
    );
    this._stmts.clearChatLog = this._db.prepare('DELETE FROM chat_log');
    this._stmts.purgeOldChat = this._db.prepare("DELETE FROM chat_log WHERE created_at < datetime('now', ?)");
    this._stmts.countChat = this._db.prepare('SELECT COUNT(*) as count FROM chat_log');

    // Meta
    this._stmts.getMeta = this._db.prepare('SELECT value FROM meta WHERE key = ?');
    this._stmts.setMeta = this._db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');

    // ── Player aliases (identity resolution) ──
    this._stmts.upsertAlias = this._db.prepare(`
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
    `);
    this._stmts.clearCurrentAlias = this._db.prepare(
      'UPDATE player_aliases SET is_current = 0 WHERE steam_id = ? AND source = ?',
    );
    this._stmts.lookupBySteamId = this._db.prepare(
      'SELECT * FROM player_aliases WHERE steam_id = ? ORDER BY is_current DESC, last_seen DESC',
    );
    this._stmts.lookupByName = this._db.prepare(
      'SELECT * FROM player_aliases WHERE name_lower = ? ORDER BY is_current DESC, last_seen DESC',
    );
    this._stmts.lookupByNameLike = this._db.prepare(
      'SELECT * FROM player_aliases WHERE name_lower LIKE ? ORDER BY is_current DESC, last_seen DESC LIMIT 10',
    );
    this._stmts.getAllAliases = this._db.prepare('SELECT * FROM player_aliases ORDER BY steam_id, last_seen DESC');
    this._stmts.getAliasStats = this._db.prepare(
      'SELECT COUNT(DISTINCT steam_id) as unique_players, COUNT(*) as total_aliases FROM player_aliases',
    );

    // ── Timeline snapshots ──
    this._stmts.insertTimelineSnapshot = this._db.prepare(`
      INSERT INTO timeline_snapshots (game_day, game_time, player_count, online_count,
        ai_count, structure_count, vehicle_count, container_count, world_item_count,
        weather_type, season, airdrop_active, airdrop_x, airdrop_y, airdrop_ai_alive, summary)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this._stmts.getTimelineSnapshots = this._db.prepare(
      'SELECT * FROM timeline_snapshots ORDER BY created_at DESC LIMIT ?',
    );
    this._stmts.getTimelineSnapshotRange = this._db.prepare(
      'SELECT * FROM timeline_snapshots WHERE created_at BETWEEN ? AND ? ORDER BY created_at ASC',
    );
    this._stmts.getTimelineSnapshotById = this._db.prepare('SELECT * FROM timeline_snapshots WHERE id = ?');
    this._stmts.getTimelineSnapshotCount = this._db.prepare('SELECT COUNT(*) as count FROM timeline_snapshots');
    this._stmts.purgeOldTimeline = this._db.prepare(
      "DELETE FROM timeline_snapshots WHERE created_at < datetime('now', ?)",
    );
    this._stmts.getTimelineSnapshotBounds = this._db.prepare(
      'SELECT MIN(created_at) as earliest, MAX(created_at) as latest, COUNT(*) as count FROM timeline_snapshots',
    );

    // ── Timeline entity inserts (bulk via transactions) ──
    this._stmts.insertTimelinePlayer = this._db.prepare(`
      INSERT INTO timeline_players (snapshot_id, steam_id, name, online, pos_x, pos_y, pos_z,
        health, max_health, hunger, thirst, infection, stamina, level, zeeks_killed, days_survived, lifetime_kills)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this._stmts.insertTimelineAI = this._db.prepare(`
      INSERT INTO timeline_ai (snapshot_id, ai_type, category, display_name, node_uid, pos_x, pos_y, pos_z)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this._stmts.insertTimelineVehicle = this._db.prepare(`
      INSERT INTO timeline_vehicles (snapshot_id, class, display_name, pos_x, pos_y, pos_z, health, max_health, fuel, item_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this._stmts.insertTimelineStructure = this._db.prepare(`
      INSERT INTO timeline_structures (snapshot_id, actor_class, display_name, owner_steam_id, pos_x, pos_y, pos_z, current_health, max_health, upgrade_level)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this._stmts.insertTimelineHouse = this._db.prepare(`
      INSERT INTO timeline_houses (snapshot_id, uid, name, windows_open, windows_total, doors_open, doors_locked, doors_total, destroyed_furniture, has_generator, sleepers, clean, pos_x, pos_y)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this._stmts.insertTimelineCompanion = this._db.prepare(`
      INSERT INTO timeline_companions (snapshot_id, entity_type, actor_name, display_name, owner_steam_id, pos_x, pos_y, pos_z, health, extra)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this._stmts.insertTimelineBackpack = this._db.prepare(`
      INSERT INTO timeline_backpacks (snapshot_id, class, pos_x, pos_y, pos_z, item_count, items_summary)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    // ── Timeline queries (for time-scroll API) ──
    this._stmts.getTimelinePlayers = this._db.prepare('SELECT * FROM timeline_players WHERE snapshot_id = ?');
    this._stmts.getTimelineAI = this._db.prepare('SELECT * FROM timeline_ai WHERE snapshot_id = ?');
    this._stmts.getTimelineVehicles = this._db.prepare('SELECT * FROM timeline_vehicles WHERE snapshot_id = ?');
    this._stmts.getTimelineStructures = this._db.prepare('SELECT * FROM timeline_structures WHERE snapshot_id = ?');
    this._stmts.getTimelineHouses = this._db.prepare('SELECT * FROM timeline_houses WHERE snapshot_id = ?');
    this._stmts.getTimelineCompanions = this._db.prepare('SELECT * FROM timeline_companions WHERE snapshot_id = ?');
    this._stmts.getTimelineBackpacks = this._db.prepare('SELECT * FROM timeline_backpacks WHERE snapshot_id = ?');

    // Player position history (for trails/heatmaps)
    this._stmts.getPlayerPositionHistory = this._db.prepare(`
      SELECT tp.pos_x, tp.pos_y, tp.pos_z, tp.health, tp.online, ts.created_at, ts.game_day
      FROM timeline_players tp
      JOIN timeline_snapshots ts ON tp.snapshot_id = ts.id
      WHERE tp.steam_id = ? AND ts.created_at BETWEEN ? AND ?
      ORDER BY ts.created_at ASC
    `);

    // AI population summary over time
    this._stmts.getAIPopulationHistory = this._db.prepare(`
      SELECT ts.id, ts.created_at, ts.game_day, ts.ai_count,
        (SELECT COUNT(*) FROM timeline_ai WHERE snapshot_id = ts.id AND category = 'zombie') as zombies,
        (SELECT COUNT(*) FROM timeline_ai WHERE snapshot_id = ts.id AND category = 'animal') as animals,
        (SELECT COUNT(*) FROM timeline_ai WHERE snapshot_id = ts.id AND category = 'bandit') as bandits
      FROM timeline_snapshots ts
      WHERE ts.created_at BETWEEN ? AND ?
      ORDER BY ts.created_at ASC
    `);

    // ── Death causes ──
    this._stmts.insertDeathCause = this._db.prepare(`
      INSERT INTO death_causes (victim_name, victim_steam_id, cause_type, cause_name, cause_raw, damage_total, pos_x, pos_y, pos_z)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this._stmts.getDeathCauses = this._db.prepare('SELECT * FROM death_causes ORDER BY created_at DESC LIMIT ?');
    this._stmts.getDeathCausesByPlayer = this._db.prepare(
      'SELECT * FROM death_causes WHERE victim_name = ? OR victim_steam_id = ? ORDER BY created_at DESC LIMIT ?',
    );
    this._stmts.getDeathCauseStats = this._db.prepare(
      'SELECT cause_type, cause_name, COUNT(*) as count FROM death_causes GROUP BY cause_type, cause_name ORDER BY count DESC',
    );
    this._stmts.getDeathCausesSince = this._db.prepare(
      'SELECT * FROM death_causes WHERE created_at >= ? ORDER BY created_at ASC',
    );

    // ── Anticheat: flags, risk scores, fingerprints ─────────────────────────
    this._stmts.insertAcFlag = this._db.prepare(`
      INSERT INTO anticheat_flags (steam_id, player_name, detector, severity, score, details, evidence, auto_escalated)
      VALUES (@steam_id, @player_name, @detector, @severity, @score, @details, @evidence, @auto_escalated)
    `);
    this._stmts.getAcFlags = this._db.prepare(
      'SELECT * FROM anticheat_flags WHERE status = ? ORDER BY created_at DESC LIMIT ?',
    );
    this._stmts.getAcFlagsBySteam = this._db.prepare(
      'SELECT * FROM anticheat_flags WHERE steam_id = ? ORDER BY created_at DESC LIMIT ?',
    );
    this._stmts.getAcFlagsByDetector = this._db.prepare(
      'SELECT * FROM anticheat_flags WHERE detector = ? AND status = ? ORDER BY created_at DESC LIMIT ?',
    );
    this._stmts.getAcFlagsSince = this._db.prepare(
      'SELECT * FROM anticheat_flags WHERE steam_id = ? AND created_at >= ? ORDER BY created_at ASC',
    );
    this._stmts.getAcFlagCount = this._db.prepare(
      'SELECT COUNT(*) as count FROM anticheat_flags WHERE steam_id = ? AND severity IN (?, ?) AND status = ? AND created_at >= ?',
    );
    this._stmts.updateAcFlagStatus = this._db.prepare(
      "UPDATE anticheat_flags SET status = ?, reviewed_by = ?, reviewed_at = datetime('now'), review_notes = ? WHERE id = ?",
    );
    this._stmts.escalateAcFlag = this._db.prepare(
      'UPDATE anticheat_flags SET severity = ?, auto_escalated = 1 WHERE id = ?',
    );

    this._stmts.upsertRiskScore = this._db.prepare(`
      INSERT INTO player_risk_scores (steam_id, risk_score, open_flags, confirmed_flags, dismissed_flags, last_flag_at, last_scored_at, baseline_data, updated_at)
      VALUES (@steam_id, @risk_score, @open_flags, @confirmed_flags, @dismissed_flags, @last_flag_at, datetime('now'), @baseline_data, datetime('now'))
      ON CONFLICT(steam_id) DO UPDATE SET
        risk_score = excluded.risk_score,
        open_flags = excluded.open_flags,
        confirmed_flags = excluded.confirmed_flags,
        dismissed_flags = excluded.dismissed_flags,
        last_flag_at = excluded.last_flag_at,
        last_scored_at = datetime('now'),
        baseline_data = excluded.baseline_data,
        updated_at = datetime('now')
    `);
    this._stmts.getRiskScore = this._db.prepare('SELECT * FROM player_risk_scores WHERE steam_id = ?');
    this._stmts.getAllRiskScores = this._db.prepare('SELECT * FROM player_risk_scores ORDER BY risk_score DESC');

    this._stmts.upsertFingerprint = this._db.prepare(`
      INSERT INTO entity_fingerprints (entity_type, entity_id, fingerprint, parent_id, creator_steam_id, last_validated, tamper_score, metadata)
      VALUES (@entity_type, @entity_id, @fingerprint, @parent_id, @creator_steam_id, datetime('now'), @tamper_score, @metadata)
      ON CONFLICT(entity_type, entity_id) DO UPDATE SET
        fingerprint = excluded.fingerprint,
        last_validated = datetime('now'),
        tamper_score = excluded.tamper_score,
        metadata = excluded.metadata
    `);
    this._stmts.getFingerprint = this._db.prepare(
      'SELECT * FROM entity_fingerprints WHERE entity_type = ? AND entity_id = ?',
    );
    this._stmts.getFingerprintsByType = this._db.prepare('SELECT * FROM entity_fingerprints WHERE entity_type = ?');
    this._stmts.insertFingerprintEvent = this._db.prepare(`
      INSERT INTO fingerprint_events (fingerprint_id, event_type, old_state, new_state, attributed_to, source, confidence)
      VALUES (@fingerprint_id, @event_type, @old_state, @new_state, @attributed_to, @source, @confidence)
    `);
    this._stmts.getFingerprintEvents = this._db.prepare(
      'SELECT * FROM fingerprint_events WHERE fingerprint_id = ? ORDER BY created_at DESC LIMIT ?',
    );
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
      this.registerAlias(steamId, data.name, 'save');
    }
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

  /**
   * Lightweight query for diff engine — only columns needed for inventory comparison.
   * Returns online players with only inventory/equipment/quick_slots/backpack_items + identity/position.
   * Avoids the full 133-column SELECT * + 27-column JSON parse that causes OOM on large servers.
   */
  getOnlinePlayersForDiff() {
    return this._stmts.getOnlinePlayersForDiff.all().map(_parsePlayerRowForDiff);
  }

  setPlayerOnline(steamId, online) {
    this._stmts.setPlayerOnline.run(online ? 1 : 0, steamId);
  }

  setAllPlayersOffline() {
    this._stmts.setAllOffline.run();
  }

  /** Update kill tracker JSON for a player. */
  updateKillTracker(steamId, killData) {
    this._db
      .prepare("UPDATE players SET kill_tracker = ?, updated_at = datetime('now') WHERE steam_id = ?")
      .run(JSON.stringify(killData), steamId);
  }

  /** Update name and name history. */
  updatePlayerName(steamId, name, nameHistory) {
    this._db
      .prepare("UPDATE players SET name = ?, name_history = ?, updated_at = datetime('now') WHERE steam_id = ?")
      .run(name, JSON.stringify(nameHistory || []), steamId);
  }

  /**
   * Upsert full player log stats (DB-first — called by player-stats.js on every record call).
   * Creates the player row if it doesn't exist.
   */
  upsertFullLogStats(steamId, data) {
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
  getAllPlayerLogStats() {
    return this._stmts.getAllPlayerLogStats.all();
  }

  /**
   * Upsert full playtime data (DB-first — called by playtime-tracker.js).
   * Creates the player row if it doesn't exist.
   */
  upsertFullPlaytime(steamId, data) {
    this._stmts.upsertPlayerPlaytime.run({
      steam_id: steamId,
      name: data.name || '',
      playtime_seconds: Math.floor((data.totalMs || 0) / 1000),
      session_count: data.sessions || 0,
      playtime_first_seen: data.firstSeen || null,
      playtime_last_login: data.lastLogin || null,
      playtime_last_seen: data.lastSeen || null,
    });
  }

  /**
   * Get all player playtime from DB (for loading into PlaytimeTracker cache on startup).
   */
  getAllPlayerPlaytime() {
    return this._stmts.getAllPlayerPlaytime.all();
  }

  /**
   * Set a server peak value (e.g. all_time_peak, today_peak, unique_today).
   */
  setServerPeak(key, value) {
    const stored = value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value ?? '');
    this._stmts.setServerPeak.run(key, stored);
  }

  /**
   * Get a server peak value.
   */
  getServerPeak(key) {
    const r = this._stmts.getServerPeak.get(key);
    return r ? r.value : null;
  }

  /**
   * Get all server peak values as a flat object.
   */
  getAllServerPeaks() {
    const rows = this._stmts.getAllServerPeaks.all();
    const result = {};
    for (const r of rows) result[r.key] = r.value;
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
  registerAlias(steamId, name, source = '') {
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
  importIdMap(entries) {
    const tx = this._db.transaction((list) => {
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
  importConnectLog(entries) {
    const tx = this._db.transaction((list) => {
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
  importFromSave(players) {
    const tx = this._db.transaction(() => {
      for (const [steamId, data] of players) {
        if (data.name) this.registerAlias(steamId, data.name, 'save');
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
  resolveNameToSteamId(name) {
    if (!name) return null;
    const nameLower = name.toLowerCase().trim();

    // If it's already a SteamID, return directly
    if (/^\d{17}$/.test(name)) return { steamId: name, name, source: 'direct', isCurrent: true };

    const rows = this._stmts.lookupByName.all(nameLower);
    if (rows.length === 0) return null;

    // Prefer is_current=1 entries, then most recently seen
    return {
      steamId: rows[0].steam_id,
      name: rows[0].name,
      source: rows[0].source,
      isCurrent: !!rows[0].is_current,
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
  resolveSteamIdToName(steamId) {
    if (!steamId) return steamId;

    const rows = this._stmts.lookupBySteamId.all(steamId);
    if (rows.length === 0) return steamId;

    // Source priority for "best name"
    const priority = { idmap: 5, connect_log: 4, save: 3, playtime: 2, log: 1, manual: 0 };

    // Among is_current=1 entries, pick the highest-priority source
    const current = rows.filter((r) => r.is_current);
    if (current.length > 0) {
      current.sort((a, b) => (priority[b.source] || 0) - (priority[a.source] || 0));
      return current[0].name;
    }

    // Fallback: most recently seen alias
    return rows[0].name;
  }

  /**
   * Get all known aliases for a SteamID.
   * @param {string} steamId
   * @returns {Array<{ name: string, source: string, firstSeen: string, lastSeen: string, isCurrent: boolean }>}
   */
  getPlayerAliases(steamId) {
    return this._stmts.lookupBySteamId.all(steamId).map((r) => ({
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
  searchPlayersByName(query) {
    if (!query) return [];
    const rows = this._stmts.lookupByNameLike.all(`%${query.toLowerCase().trim()}%`);
    // Deduplicate by steamId, keeping the best for each
    const seen = new Map();
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
    const row = this._stmts.getAliasStats.get();
    return { uniquePlayers: row?.unique_players || 0, totalAliases: row?.total_aliases || 0 };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Leaderboards
  // ═══════════════════════════════════════════════════════════════════════════

  topKillers(limit = 10) {
    return this._stmts.topKillers.all(limit);
  }
  topPlaytime(limit = 10) {
    return this._stmts.topPlaytime.all(limit);
  }
  topSurvival(limit = 10) {
    return this._stmts.topSurvival.all(limit);
  }
  topFish(limit = 10) {
    return this._stmts.topFish.all(limit);
  }
  topBitten(limit = 10) {
    return this._stmts.topBitten.all(limit);
  }
  topPvp(limit = 10) {
    return this._stmts.topPvp.all(limit);
  }
  topBuilders(limit = 10) {
    return this._stmts.topBuilders.all(limit);
  }
  topDeaths(limit = 10) {
    return this._stmts.topDeaths.all(limit);
  }
  topLooters(limit = 10) {
    return this._stmts.topLooters.all(limit);
  }

  /** Aggregate server totals. */
  getServerTotals() {
    return this._db
      .prepare(
        `
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
    `,
      )
      .get();
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
    return clans.map((c) => ({
      ...c,
      members: this._stmts.getClanMembers.all(c.name).map((m) => ({
        steamId: m.steam_id,
        name: m.name,
        rank: m.rank,
        canInvite: m.can_invite,
        canKick: m.can_kick,
        // Preserve snake_case for any code that still uses it
        steam_id: m.steam_id,
        can_invite: m.can_invite,
        can_kick: m.can_kick,
      })),
    }));
  }

  /**
   * Check if two steam IDs are in the same clan.
   * @param {string} steamId1
   * @param {string} steamId2
   * @returns {boolean}
   */
  areClanmates(steamId1, steamId2) {
    if (!steamId1 || !steamId2 || steamId1 === steamId2) return false;
    return !!this._stmts.areClanmates.get(steamId1, steamId2);
  }

  /**
   * Get the clan name for a steam ID, or null.
   * @param {string} steamId
   * @returns {string|null}
   */
  getClanForSteamId(steamId) {
    if (!steamId) return null;
    const row = this._stmts.getClanForSteamId.get(steamId);
    return row ? row.clan_name : null;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  World state
  // ═══════════════════════════════════════════════════════════════════════════

  setWorldState(key, value) {
    const stored = value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value);
    this._stmts.setWorldState.run(key, stored);
  }
  getWorldState(key) {
    const r = this._stmts.getWorldState.get(key);
    return r ? r.value : null;
  }
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
          s.actorClass,
          s.displayName || '',
          s.ownerSteamId || '',
          s.x ?? null,
          s.y ?? null,
          s.z ?? null,
          s.currentHealth || 0,
          s.maxHealth || 0,
          s.upgradeLevel || 0,
          s.attachedToTrailer ? 1 : 0,
          _json(s.inventory),
          s.noSpawn ? 1 : 0,
          s.extraData || '',
        );
      }
    });
    insert(structures);
  }

  getStructures() {
    return this._stmts.getStructures.all();
  }
  getStructuresByOwner(steamId) {
    return this._stmts.getStructuresByOwner.all(steamId);
  }
  getStructureCounts() {
    return this._stmts.countStructuresByOwner.all();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Vehicles
  // ═══════════════════════════════════════════════════════════════════════════

  replaceVehicles(vehicles) {
    const insert = this._db.transaction((items) => {
      this._stmts.clearVehicles.run();
      for (const v of items) {
        this._stmts.insertVehicle.run(
          v.class,
          v.displayName || '',
          v.x ?? null,
          v.y ?? null,
          v.z ?? null,
          v.health || 0,
          v.maxHealth || 0,
          v.fuel || 0,
          _json(v.inventory),
          _json(v.upgrades),
          _json(v.extra),
        );
      }
    });
    insert(vehicles);
  }

  getAllVehicles() {
    return this._stmts.getAllVehicles.all();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Companions
  // ═══════════════════════════════════════════════════════════════════════════

  replaceCompanions(companions) {
    const insert = this._db.transaction((items) => {
      this._stmts.clearCompanions.run();
      for (const c of items) {
        this._stmts.insertCompanion.run(
          c.type,
          c.actorName,
          c.ownerSteamId || '',
          c.x ?? null,
          c.y ?? null,
          c.z ?? null,
          c.health || 0,
          _json(c.extra),
        );
      }
    });
    insert(companions);
  }

  getAllCompanions() {
    return this._stmts.getAllCompanions.all();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  World horses
  // ═══════════════════════════════════════════════════════════════════════════

  replaceWorldHorses(horses) {
    const insert = this._db.transaction((items) => this._replaceWorldHorsesInner(items));
    insert(horses);
  }

  _replaceWorldHorsesInner(horses) {
    this._stmts.clearWorldHorses.run();
    for (const h of horses) {
      this._stmts.insertWorldHorse.run(
        h.actorName || h.class || '',
        h.class || '',
        h.displayName || '',
        h.name || '',
        h.ownerSteamId || '',
        h.x ?? null,
        h.y ?? null,
        h.z ?? null,
        h.health || 0,
        h.maxHealth || 0,
        h.energy || 0,
        h.stamina || 0,
        _json(h.saddleInventory),
        _json(h.inventory),
        _json(h.extra),
      );
    }
  }

  getAllWorldHorses() {
    return this._stmts.getAllWorldHorses.all();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Dead bodies
  // ═══════════════════════════════════════════════════════════════════════════

  replaceDeadBodies(bodies) {
    const insert = this._db.transaction((items) => this._replaceDeadBodiesInner(items));
    insert(bodies);
  }

  _replaceDeadBodiesInner(bodies) {
    this._stmts.clearDeadBodies.run();
    for (const b of bodies) {
      this._stmts.insertDeadBody.run(b.actorName, b.x ?? null, b.y ?? null, b.z ?? null);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Containers
  // ═══════════════════════════════════════════════════════════════════════════

  replaceContainers(containers) {
    const insert = this._db.transaction((items) => this._replaceContainersInner(items));
    insert(containers);
  }

  _replaceContainersInner(containers) {
    this._stmts.clearContainers.run();
    for (const c of containers) {
      const extra = {};
      if (c.hackCoolDown != null) extra.hackCoolDown = c.hackCoolDown;
      if (c.destroyTime != null) extra.destroyTime = c.destroyTime;
      if (c.extraFloats) extra.extraFloats = c.extraFloats;
      if (c.extraBools) extra.extraBools = c.extraBools;
      this._stmts.insertContainer.run(
        c.actorName,
        JSON.stringify(c.items || []),
        JSON.stringify(c.quickSlots || []),
        c.locked ? 1 : 0,
        c.doesSpawnLoot ? 1 : 0,
        c.alarmOff ? 1 : 0,
        JSON.stringify(c.craftingContent || []),
        c.x ?? null,
        c.y ?? null,
        c.z ?? null,
        JSON.stringify(extra),
      );
    }
  }

  getAllContainers() {
    return this._stmts.getAllContainers.all();
  }
  getContainersWithItems() {
    return this._stmts.getContainersWithItems.all();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Loot actors
  // ═══════════════════════════════════════════════════════════════════════════

  replaceLootActors(lootActors) {
    const insert = this._db.transaction((items) => this._replaceLootActorsInner(items));
    insert(lootActors);
  }

  _replaceLootActorsInner(lootActors) {
    this._stmts.clearLootActors.run();
    for (const la of lootActors) {
      this._stmts.insertLootActor.run(
        la.name,
        la.type,
        la.x ?? null,
        la.y ?? null,
        la.z ?? null,
        JSON.stringify(la.items),
      );
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Item instances (fingerprint tracking)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Create a new item instance and return its row id.
   * @param {object} item - { fingerprint, item, durability, ammo, attachments, cap, maxDur, locationType, locationId, locationSlot, x, y, z, amount }
   * @returns {number} The auto-incremented ID of the new instance
   */
  /**
   * Create a new item instance and return its row id.
   * @param {object} item - { fingerprint, item, durability, ammo, attachments, cap, maxDur, locationType, locationId, locationSlot, x, y, z, amount, groupId }
   * @returns {number} The auto-incremented ID of the new instance
   */
  createItemInstance(item) {
    const result = this._stmts.insertItemInstance.run(
      item.fingerprint,
      item.item,
      item.durability || 0,
      item.ammo || 0,
      _json(item.attachments),
      item.cap || 0,
      item.maxDur || 0,
      item.locationType,
      item.locationId || '',
      item.locationSlot || '',
      item.x ?? null,
      item.y ?? null,
      item.z ?? null,
      item.amount || 1,
      item.groupId ?? null,
    );
    return result.lastInsertRowid;
  }

  /**
   * Move an item instance to a new location and record the movement.
   * @param {number} instanceId - item_instances.id
   * @param {object} to - { locationType, locationId, locationSlot, x, y, z, amount, groupId }
   * @param {object} [attribution] - { steamId, name } of the player who caused the move
   * @param {string} [moveType='move'] - movement type
   */
  moveItemInstance(instanceId, to, attribution, moveType = 'move') {
    const old = this._stmts.findItemInstanceById.get(instanceId);
    if (!old) return;

    // Update location
    this._stmts.updateItemInstanceLocation.run(
      to.locationType,
      to.locationId || '',
      to.locationSlot || '',
      to.x ?? null,
      to.y ?? null,
      to.z ?? null,
      to.amount ?? old.amount,
      to.groupId ?? null,
      instanceId,
    );

    // Record movement
    this._stmts.insertItemMovement.run(
      instanceId,
      null,
      moveType,
      old.item,
      old.location_type,
      old.location_id,
      old.location_slot,
      to.locationType,
      to.locationId || '',
      to.locationSlot || '',
      to.amount ?? old.amount,
      attribution?.steamId || '',
      attribution?.name || '',
      to.x ?? null,
      to.y ?? null,
      to.z ?? null,
    );
  }

  /**
   * Mark an item instance as lost (no longer found in save data).
   */
  markItemLost(instanceId) {
    this._stmts.markItemInstanceLost.run(instanceId);
  }

  /**
   * Mark all active instances as lost (used before reconciliation).
   */
  markAllItemsLost() {
    this._stmts.markAllItemInstancesLost.run();
  }

  /**
   * Touch an instance (update last_seen, clear lost flag).
   */
  touchItemInstance(instanceId) {
    this._stmts.touchItemInstance.run(instanceId);
  }

  findItemByFingerprint(fingerprint) {
    return this._stmts.findItemInstanceByFingerprint.get(fingerprint);
  }

  findItemsByFingerprint(fingerprint) {
    return this._stmts.findItemInstancesByFingerprint.all(fingerprint);
  }

  getItemInstance(id) {
    return this._stmts.findItemInstanceById.get(id);
  }

  getActiveItemInstances() {
    return this._stmts.getActiveItemInstances.all();
  }

  getItemInstancesByItem(item) {
    return this._stmts.getItemInstancesByItem.all(item);
  }

  getItemInstancesByLocation(locationType, locationId) {
    return this._stmts.getItemInstancesByLocation.all(locationType, locationId);
  }

  getItemInstanceCount() {
    return this._stmts.getItemInstanceCount.get().count;
  }

  searchItemInstances(query, limit = 50) {
    const like = `%${query}%`;
    return this._stmts.searchItemInstances.all(like, like, limit);
  }

  purgeOldLostItems(age = '-30 days') {
    return this._stmts.purgeOldLostItems.run(age);
  }

  getItemInstancesByGroup(groupId) {
    return this._stmts.getItemInstancesByGroup.all(groupId);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Item groups (fungible item tracking)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Create or update an item group at a specific location.
   * If a group with the same fingerprint+location already exists (active), update its quantity.
   * Otherwise create a new group.
   * @returns {{ id: number, created: boolean }}
   */
  upsertItemGroup(group) {
    const existing = this._stmts.findActiveGroupByLocation.get(
      group.fingerprint,
      group.locationType,
      group.locationId || '',
      group.locationSlot || '',
    );
    if (existing) {
      this._stmts.updateItemGroupQuantity.run(group.quantity, existing.id);
      return { id: existing.id, created: false };
    }
    const result = this._stmts.insertItemGroup.run(
      group.fingerprint,
      group.item,
      group.durability || 0,
      group.ammo || 0,
      _json(group.attachments),
      group.cap || 0,
      group.maxDur || 0,
      group.locationType,
      group.locationId || '',
      group.locationSlot || '',
      group.x ?? null,
      group.y ?? null,
      group.z ?? null,
      group.quantity || 1,
      group.stackSize || 1,
    );
    return { id: Number(result.lastInsertRowid), created: true };
  }

  updateItemGroupQuantity(groupId, quantity) {
    this._stmts.updateItemGroupQuantity.run(quantity, groupId);
  }

  updateItemGroupLocation(groupId, to) {
    this._stmts.updateItemGroupLocation.run(
      to.locationType,
      to.locationId || '',
      to.locationSlot || '',
      to.x ?? null,
      to.y ?? null,
      to.z ?? null,
      to.quantity ?? 1,
      groupId,
    );
  }

  markItemGroupLost(groupId) {
    this._stmts.markItemGroupLost.run(groupId);
  }

  markAllItemGroupsLost() {
    this._stmts.markAllItemGroupsLost.run();
  }

  touchItemGroup(groupId) {
    this._stmts.touchItemGroup.run(groupId);
  }

  findActiveGroupByLocation(fingerprint, locationType, locationId, locationSlot) {
    return this._stmts.findActiveGroupByLocation.get(fingerprint, locationType, locationId || '', locationSlot || '');
  }

  findActiveGroupsByFingerprint(fingerprint) {
    return this._stmts.findActiveGroupsByFingerprint.all(fingerprint);
  }

  getItemGroup(id) {
    return this._stmts.findItemGroupById.get(id);
  }

  getActiveItemGroups() {
    return this._stmts.getActiveItemGroups.all();
  }

  getItemGroupsByItem(item) {
    return this._stmts.getItemGroupsByItem.all(item);
  }

  getItemGroupsByLocation(locationType, locationId) {
    return this._stmts.getItemGroupsByLocation.all(locationType, locationId);
  }

  getItemGroupCount() {
    return this._stmts.getItemGroupCount.get().count;
  }

  searchItemGroups(query, limit = 50) {
    const like = `%${query}%`;
    return this._stmts.searchItemGroups.all(like, like, limit);
  }

  purgeOldLostGroups(age = '-30 days') {
    return this._stmts.purgeOldLostGroups.run(age);
  }

  /**
   * Record a group-level movement (split, merge, transfer, adjust).
   * @param {object} opts
   * @param {number} [opts.instanceId] - individual instance (for splits)
   * @param {number} [opts.groupId] - group id
   * @param {string} opts.moveType - 'group_split', 'group_merge', 'group_transfer', 'group_adjust'
   * @param {string} opts.item - item name
   * @param {object} opts.from - { type, id, slot }
   * @param {object} opts.to - { type, id, slot }
   * @param {number} opts.amount - how many items moved
   * @param {object} [opts.attribution] - { steamId, name }
   * @param {{ x?: number, y?: number, z?: number }} [opts.pos] - position
   */
  recordGroupMovement(opts) {
    this._stmts.insertItemMovement.run(
      opts.instanceId ?? null,
      opts.groupId ?? null,
      opts.moveType,
      opts.item,
      opts.from?.type || '',
      opts.from?.id || '',
      opts.from?.slot || '',
      opts.to?.type || '',
      opts.to?.id || '',
      opts.to?.slot || '',
      opts.amount || 1,
      opts.attribution?.steamId || '',
      opts.attribution?.name || '',
      opts.pos?.x ?? null,
      opts.pos?.y ?? null,
      opts.pos?.z ?? null,
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Item movements (chain-of-custody)
  // ═══════════════════════════════════════════════════════════════════════════

  getItemMovements(instanceId) {
    return this._stmts.getItemMovements.all(instanceId);
  }

  getItemMovementsByGroup(groupId) {
    return this._stmts.getItemMovementsByGroup.all(groupId);
  }

  getRecentItemMovements(limit = 50) {
    return this._stmts.getRecentItemMovements.all(limit);
  }

  getItemMovementsByPlayer(steamId, limit = 50) {
    return this._stmts.getItemMovementsByPlayer.all(steamId, limit);
  }

  getItemMovementsByLocation(locationType, locationId, limit = 50) {
    return this._stmts.getItemMovementsByLocation.all(locationType, locationId, locationType, locationId, limit);
  }

  purgeOldMovements(age = '-30 days') {
    return this._stmts.purgeOldMovements.run(age);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  World drops (LODPickups, dropped backpacks, global containers)
  // ═══════════════════════════════════════════════════════════════════════════

  replaceWorldDrops(drops) {
    const insert = this._db.transaction((items) => this._replaceWorldDropsInner(items));
    insert(drops);
  }

  _replaceWorldDropsInner(drops) {
    this._stmts.clearWorldDrops.run();
    for (const d of drops) {
      this._stmts.insertWorldDrop.run(
        d.type,
        d.actorName || '',
        d.item || '',
        d.amount || 0,
        d.durability || 0,
        _json(d.items),
        d.worldLoot ? 1 : 0,
        d.placed ? 1 : 0,
        d.spawned ? 1 : 0,
        d.locked ? 1 : 0,
        d.doesSpawnLoot ? 1 : 0,
        d.x ?? null,
        d.y ?? null,
        d.z ?? null,
      );
    }
  }

  getAllWorldDrops() {
    return this._stmts.getAllWorldDrops.all();
  }
  getWorldDropsByType(type) {
    return this._stmts.getWorldDropsByType.all(type);
  }
  getWorldDropsWithItems() {
    return this._stmts.getWorldDropsWithItems.all();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Quests
  // ═══════════════════════════════════════════════════════════════════════════

  replaceQuests(quests) {
    const insert = this._db.transaction((items) => this._replaceQuestsInner(items));
    insert(quests);
  }

  _replaceQuestsInner(quests) {
    this._stmts.clearQuests.run();
    for (const q of quests) {
      this._stmts.insertQuest.run(q.id, q.type, q.state, JSON.stringify(q.data));
    }
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

  getSetting(key) {
    const r = this._stmts.getSetting.get(key);
    return r ? r.value : null;
  }
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
  //  Activity log
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Insert a single activity log entry.
   * @param {object} entry - { type, category, actor, actorName, item, amount, details, x, y, z, steamId, source, targetName, targetSteamId }
   */
  insertActivity(entry) {
    this._stmts.insertActivity.run(
      entry.type,
      entry.category || '',
      entry.actor || '',
      entry.actorName || '',
      entry.item || '',
      entry.amount || 0,
      JSON.stringify(entry.details || {}),
      entry.x ?? null,
      entry.y ?? null,
      entry.z ?? null,
      entry.steamId || '',
      entry.source || 'save',
      entry.targetName || '',
      entry.targetSteamId || '',
    );
  }

  /**
   * Insert multiple activity entries in a single transaction.
   * @param {Array<object>} entries
   */
  insertActivities(entries) {
    if (!entries || entries.length === 0) return;
    const tx = this._db.transaction((list) => {
      for (const entry of list) {
        this._stmts.insertActivity.run(
          entry.type,
          entry.category || '',
          entry.actor || '',
          entry.actorName || '',
          entry.item || '',
          entry.amount || 0,
          JSON.stringify(entry.details || {}),
          entry.x ?? null,
          entry.y ?? null,
          entry.z ?? null,
          entry.steamId || '',
          entry.source || 'save',
          entry.targetName || '',
          entry.targetSteamId || '',
        );
      }
    });
    tx(entries);
  }

  /**
   * Insert multiple activity entries with explicit timestamps (for backfill).
   * Each entry must have a `createdAt` ISO string.
   * @param {Array<object>} entries
   */
  insertActivitiesAt(entries) {
    if (!entries || entries.length === 0) return;
    const tx = this._db.transaction((list) => {
      for (const entry of list) {
        this._stmts.insertActivityAt.run(
          entry.type,
          entry.category || '',
          entry.actor || '',
          entry.actorName || '',
          entry.item || '',
          entry.amount || 0,
          JSON.stringify(entry.details || {}),
          entry.x ?? null,
          entry.y ?? null,
          entry.z ?? null,
          entry.createdAt,
          entry.steamId || '',
          entry.source || 'save',
          entry.targetName || '',
          entry.targetSteamId || '',
        );
      }
    });
    tx(entries);
  }

  /** Delete all activity log entries (used by setup --fix/--backfill). */
  clearActivityLog() {
    this._stmts.clearActivityLog.run();
  }

  /** Get the most recent N activity entries. */
  getRecentActivity(limit = 50, offset = 0) {
    if (offset > 0) return this._stmts.getRecentActivityPaged.all(limit, offset).map(_parseActivityRow);
    return this._stmts.getRecentActivity.all(limit).map(_parseActivityRow);
  }

  /** Get recent activity for a specific category. */
  getActivityByCategory(category, limit = 50, offset = 0) {
    if (offset > 0) return this._stmts.getActivityByCategoryPaged.all(category, limit, offset).map(_parseActivityRow);
    return this._stmts.getActivityByCategory.all(category, limit).map(_parseActivityRow);
  }

  /** Get recent activity for a specific actor (container name, steam ID, etc.). */
  getActivityByActor(actor, limit = 50, offset = 0) {
    if (offset > 0) return this._stmts.getActivityByActorPaged.all(actor, limit, offset).map(_parseActivityRow);
    return this._stmts.getActivityByActor.all(actor, limit).map(_parseActivityRow);
  }

  /** Get all activity since a given ISO timestamp. */
  getActivitySince(isoTimestamp) {
    return this._stmts.getActivitySince.all(isoTimestamp).map(_parseActivityRow);
  }

  /** Purge old activity entries (e.g. '-30 days'). */
  purgeOldActivity(olderThan) {
    this._stmts.purgeOldActivity.run(olderThan);
  }

  /** Count total activity entries. */
  getActivityCount() {
    const row = this._stmts.countActivity.get();
    return row?.count || 0;
  }

  /** Get activity counts grouped by source. */
  getActivityCountBySource() {
    return this._stmts.countActivityBySource.all();
  }

  /** Get all activity since a given ISO timestamp, filtered by source. */
  getActivitySinceBySource(isoTimestamp, source) {
    return this._stmts.getActivitySinceBySource.all(isoTimestamp, source).map(_parseActivityRow);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Chat log
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Insert a single chat log entry.
   * @param {object} entry - { type, playerName, steamId, message, direction, discordUser, isAdmin }
   */
  insertChat(entry) {
    this._stmts.insertChat.run(
      entry.type,
      entry.playerName || '',
      entry.steamId || '',
      entry.message || '',
      entry.direction || 'game',
      entry.discordUser || '',
      entry.isAdmin ? 1 : 0,
    );
  }

  /**
   * Insert a chat entry with explicit timestamp (for backfill).
   * @param {object} entry - includes createdAt ISO string
   */
  insertChatAt(entry) {
    this._stmts.insertChatAt.run(
      entry.type,
      entry.playerName || '',
      entry.steamId || '',
      entry.message || '',
      entry.direction || 'game',
      entry.discordUser || '',
      entry.isAdmin ? 1 : 0,
      entry.createdAt,
    );
  }

  /** Get the most recent N chat entries. */
  getRecentChat(limit = 50) {
    return this._stmts.getRecentChat.all(limit);
  }

  /** Search chat messages by text or player name. */
  searchChat(query, limit = 200) {
    const pattern = '%' + query + '%';
    return this._stmts.searchChat.all(pattern, pattern, limit);
  }

  /** Get all chat since a given ISO timestamp. */
  getChatSince(isoTimestamp) {
    return this._stmts.getChatSince.all(isoTimestamp);
  }

  /** Delete all chat log entries. */
  clearChatLog() {
    this._stmts.clearChatLog.run();
  }

  /** Purge old chat entries (e.g. '-30 days'). */
  purgeOldChat(olderThan) {
    this._stmts.purgeOldChat.run(olderThan);
  }

  /** Count total chat entries. */
  getChatCount() {
    const row = this._stmts.countChat.get();
    return row?.count || 0;
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
   * Full atomic save sync: replaces ALL world data in a single transaction.
   * This wraps syncFromSave + all replace* calls to prevent partial writes
   * on crash. Called by SaveService._poll() instead of individual methods.
   *
   * @param {object} data - { players, worldState, structures, vehicles, companions, clans,
   *                          deadBodies, containers, lootActors, quests, horses, worldDrops }
   */
  syncAllFromSave(data) {
    const tx = this._db.transaction(() => {
      // Core entity sync (players, world state, structures, vehicles, companions, clans)
      this._syncFromSaveInner(data);

      // Auxiliary entity sync — all in the SAME transaction
      if (data.deadBodies && data.deadBodies.length > 0) {
        this._replaceDeadBodiesInner(data.deadBodies);
      }
      if (data.containers && data.containers.length > 0) {
        this._replaceContainersInner(data.containers);
      }
      if (data.lootActors && data.lootActors.length > 0) {
        this._replaceLootActorsInner(data.lootActors);
      }
      if (data.quests && data.quests.length > 0) {
        this._replaceQuestsInner(data.quests);
      }
      if (data.horses && data.horses.length > 0) {
        this._replaceWorldHorsesInner(data.horses);
      }
      if (data.worldDrops && data.worldDrops.length > 0) {
        this._replaceWorldDropsInner(data.worldDrops);
      }
    });
    tx();
  }

  /**
   * Full save sync: replace all player data, structures, vehicles, etc.
   * Wraps in its own transaction when called standalone (backward compat).
   * When called from syncAllFromSave(), use _syncFromSaveInner() directly.
   */
  syncFromSave(parsed) {
    const tx = this._db.transaction(() => this._syncFromSaveInner(parsed));
    tx();
  }

  /** Inner sync logic — no transaction wrapper, safe to call inside an outer transaction. */
  _syncFromSaveInner(parsed) {
    // Players
    if (parsed.players) {
      for (const [steamId, data] of parsed.players) {
        this.upsertPlayer(steamId, data);
      }
    }

    // World state
    if (parsed.worldState) {
      for (const [key, value] of Object.entries(parsed.worldState)) {
        const stored = value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value);
        this._stmts.setWorldState.run(key, stored);
      }
    }

    // Structures
    if (parsed.structures) {
      this._stmts.clearStructures.run();
      for (const s of parsed.structures) {
        this._stmts.insertStructure.run(
          s.actorClass,
          s.displayName || '',
          s.ownerSteamId || '',
          s.x ?? null,
          s.y ?? null,
          s.z ?? null,
          s.currentHealth || 0,
          s.maxHealth || 0,
          s.upgradeLevel || 0,
          s.attachedToTrailer ? 1 : 0,
          _json(s.inventory),
          s.noSpawn ? 1 : 0,
          s.extraData || '',
        );
      }
    }

    // Vehicles
    if (parsed.vehicles) {
      this._stmts.clearVehicles.run();
      for (const v of parsed.vehicles) {
        this._stmts.insertVehicle.run(
          v.class,
          v.displayName || '',
          v.x ?? null,
          v.y ?? null,
          v.z ?? null,
          v.health || 0,
          v.maxHealth || 0,
          v.fuel || 0,
          _json(v.inventory),
          _json(v.upgrades),
          _json(v.extra),
        );
      }
    }

    // Companions
    if (parsed.companions) {
      this._stmts.clearCompanions.run();
      for (const c of parsed.companions) {
        this._stmts.insertCompanion.run(
          c.type,
          c.actorName,
          c.ownerSteamId || '',
          c.x ?? null,
          c.y ?? null,
          c.z ?? null,
          c.health || 0,
          _json(c.extra),
        );
      }
    }

    // Clans
    if (parsed.clans) {
      for (const clan of parsed.clans) {
        this._stmts.upsertClan.run(clan.name);
        this._stmts.deleteClanMembers.run(clan.name);
        for (const m of clan.members) {
          this._stmts.insertClanMember.run(
            clan.name,
            m.steamId,
            m.name,
            m.rank,
            m.canInvite ? 1 : 0,
            m.canKick ? 1 : 0,
          );
        }
      }
    }

    // Server settings
    if (parsed.serverSettings) {
      for (const [key, value] of Object.entries(parsed.serverSettings)) {
        this._stmts.upsertSetting.run(key, String(value));
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Game reference data seeding
  // ═══════════════════════════════════════════════════════════════════════════

  seedGameItems(items) {
    const tx = this._db.transaction((list) => {
      for (const item of list) {
        this._stmts.upsertGameItem.run(
          item.id,
          item.name || '',
          item.description || '',
          item.type || '',
          item.typeRaw || '',
          item.specificType || '',
          item.wearPosition || '',
          item.type || '', // category = type
          item.chanceToSpawn ?? 0,
          item.durabilityLoss ?? 0,
          item.armorProtection ?? 0,
          item.maxStackSize ?? 1,
          item.canStack ? 1 : 0,
          item.itemSize ?? 1,
          item.weight ?? 0,
          item.firstValue ?? 0,
          typeof item.secondItemType === 'string' ? item.secondItemType : '',
          item.secondValue ?? 0,
          item.valueToTrader ?? 0,
          item.valueForPlayer ?? 0,
          item.doesDecay ? 1 : 0,
          item.decayPerDay ?? 0,
          item.onlyDecayIfOpened ? 1 : 0,
          item.warmthValue ?? 0,
          item.infectionProtection ?? 0,
          item.clothingRainMod ?? 0,
          item.clothingSnowMod ?? 0,
          item.summerCoolValue ?? 0,
          item.isSkillBook ? 1 : 0,
          item.noPocket ? 1 : 0,
          item.excludeFromVendor ? 1 : 0,
          item.excludeFromAI ? 1 : 0,
          item.useAsFertilizer ? 1 : 0,
          String(item.state ?? ''),
          item.tag || '',
          typeof item.openItem === 'string' ? item.openItem : item.openItem ? '1' : '',
          item.bodyAttachSocket || '',
          _json(item.supportedAttachments),
          _json(item.itemsInside),
          _json(item.skillBookData),
          _json({}),
        );
      }
    });
    tx(items);
  }

  getGameItem(id) {
    return this._stmts.getGameItem.get(id);
  }
  searchGameItems(query) {
    const q = `%${query}%`;
    return this._stmts.searchGameItems.all(q, q);
  }

  seedGameProfessions(professions) {
    const stmt = this._db.prepare(
      'INSERT OR REPLACE INTO game_professions (id, enum_value, enum_index, perk, description, affliction, skills) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    const tx = this._db.transaction((list) => {
      for (const p of list) {
        stmt.run(
          p.id,
          p.enumValue || '',
          p.enumIndex || 0,
          p.perk || '',
          p.description || '',
          p.affliction || '',
          _json(p.skills),
        );
      }
    });
    tx(professions);
  }

  seedGameAfflictions(afflictions) {
    const stmt = this._db.prepare(
      'INSERT OR REPLACE INTO game_afflictions (idx, name, description, icon) VALUES (?, ?, ?, ?)',
    );
    const tx = this._db.transaction((list) => {
      for (const a of list) {
        stmt.run(a.idx, a.name, a.description || '', a.icon || '');
      }
    });
    tx(afflictions);
  }

  seedGameSkills(skills) {
    const stmt = this._db.prepare(
      'INSERT OR REPLACE INTO game_skills (id, name, description, effect, category, icon) VALUES (?, ?, ?, ?, ?, ?)',
    );
    const tx = this._db.transaction((list) => {
      for (const s of list) {
        stmt.run(s.id, s.name, s.description || '', s.effect || '', s.category || '', s.icon || '');
      }
    });
    tx(skills);
  }

  seedGameChallenges(challenges) {
    const stmt = this._db.prepare(
      'INSERT OR REPLACE INTO game_challenges (id, name, description, save_field, target) VALUES (?, ?, ?, ?, ?)',
    );
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

  // ─── New game reference seed methods (schema v11) ─────────────────────────

  seedGameBuildings(buildings) {
    const stmt = this._db.prepare(`INSERT OR REPLACE INTO game_buildings (
      id, name, description, category, category_raw, health,
      show_in_build_menu, requires_build_tool, moveable, learned_building,
      landscape_only, water_only, structure_only, wall_placement, require_foundation,
      xp_multiplier, resources, upgrades
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const tx = this._db.transaction((list) => {
      for (const b of list) {
        stmt.run(
          b.id,
          b.name || '',
          b.description || '',
          b.category || '',
          b.categoryRaw || '',
          b.health ?? 0,
          b.showInBuildMenu ? 1 : 0,
          b.requiresBuildTool ? 1 : 0,
          b.moveableAfterPlacement ? 1 : 0,
          b.learnedBuilding ? 1 : 0,
          b.placementOnLandscapeOnly ? 1 : 0,
          b.placementInWaterOnly ? 1 : 0,
          b.placementOnStructureOnly ? 1 : 0,
          b.wallPlacement ? 1 : 0,
          b.requireFoundation ? 1 : 0,
          b.xpMultiplier ?? 1,
          _json(b.resources),
          _json(b.upgrades),
        );
      }
    });
    tx(buildings);
  }

  seedGameLootPools(lootTables) {
    const poolStmt = this._db.prepare('INSERT OR REPLACE INTO game_loot_pools (id, name, item_count) VALUES (?, ?, ?)');
    const itemStmt = this._db.prepare(
      'INSERT OR REPLACE INTO game_loot_pool_items (pool_id, item_id, name, chance_to_spawn, type, max_stack_size) VALUES (?, ?, ?, ?, ?, ?)',
    );
    const tx = this._db.transaction((tables) => {
      for (const [poolId, pool] of Object.entries(tables)) {
        poolStmt.run(poolId, pool.name || poolId, pool.itemCount || 0);
        for (const [itemId, item] of Object.entries(pool.items || {})) {
          itemStmt.run(
            poolId,
            itemId,
            item.name || '',
            item.chanceToSpawn ?? 0,
            item.type || '',
            item.maxStackSize ?? 1,
          );
        }
      }
    });
    tx(lootTables);
  }

  seedGameVehiclesRef(vehicles) {
    const stmt = this._db.prepare('INSERT OR REPLACE INTO game_vehicles_ref (id, name) VALUES (?, ?)');
    const tx = this._db.transaction((list) => {
      for (const v of list) {
        stmt.run(v.id, v.name || v.id);
      }
    });
    tx(vehicles);
  }

  seedGameAnimals(animals) {
    const stmt = this._db.prepare(
      'INSERT OR REPLACE INTO game_animals (id, name, type, hide_item_id) VALUES (?, ?, ?, ?)',
    );
    const tx = this._db.transaction((list) => {
      for (const a of list) {
        stmt.run(a.id, a.name || a.id, a.type || '', a.hideItemId || '');
      }
    });
    tx(animals);
  }

  seedGameCrops(crops) {
    const stmt = this._db.prepare(`INSERT OR REPLACE INTO game_crops (
      id, crop_id, growth_time_days, grid_columns, grid_rows, harvest_result, harvest_count, grow_seasons
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    const tx = this._db.transaction((list) => {
      for (const c of list) {
        stmt.run(
          c.id,
          c.cropId ?? 0,
          c.growthTimeDays ?? 0,
          c.gridColumns ?? 1,
          c.gridRows ?? 1,
          c.harvestResult || '',
          c.harvestCount ?? 0,
          _json(c.growSeasons),
        );
      }
    });
    tx(crops);
  }

  seedGameCarUpgrades(upgrades) {
    const stmt = this._db.prepare(`INSERT OR REPLACE INTO game_car_upgrades (
      id, type, type_raw, level, socket, tool_durability_lost, craft_time_minutes, health, craft_cost
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const tx = this._db.transaction((list) => {
      for (const u of list) {
        stmt.run(
          u.id,
          u.type || '',
          u.typeRaw || '',
          u.level ?? 0,
          u.socket || '',
          u.toolDurabilityLost ?? 0,
          u.craftTimeMinutes ?? 0,
          u.health ?? 0,
          _json(u.craftCost),
        );
      }
    });
    tx(upgrades);
  }

  seedGameAmmoTypes(ammo) {
    const stmt = this._db.prepare(
      'INSERT OR REPLACE INTO game_ammo_types (id, damage, headshot_multiplier, range, penetration) VALUES (?, ?, ?, ?, ?)',
    );
    const tx = this._db.transaction((list) => {
      for (const a of list) {
        stmt.run(a.id, a.damage ?? 0, a.headshotMultiplier ?? 1, a.range ?? 0, a.penetration ?? 0);
      }
    });
    tx(ammo);
  }

  seedGameRepairData(repairs) {
    const stmt = this._db.prepare(`INSERT OR REPLACE INTO game_repair_data (
      id, resource_type, resource_type_raw, amount, health_to_add, is_repairable, extra_resources
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    const tx = this._db.transaction((list) => {
      for (const r of list) {
        stmt.run(
          r.id,
          r.resourceType || '',
          r.resourceTypeRaw || '',
          r.amount ?? 0,
          r.healthToAdd ?? 0,
          r.isRepairable ? 1 : 0,
          _json(r.extraResources),
        );
      }
    });
    tx(repairs);
  }

  seedGameFurniture(furniture) {
    const stmt = this._db.prepare(
      'INSERT OR REPLACE INTO game_furniture (id, name, mesh_count, drop_resources) VALUES (?, ?, ?, ?)',
    );
    const tx = this._db.transaction((list) => {
      for (const f of list) {
        stmt.run(f.id, f.name || f.id, f.meshCount ?? 0, _json(f.dropResources));
      }
    });
    tx(furniture);
  }

  seedGameTraps(traps) {
    const stmt = this._db.prepare(
      'INSERT OR REPLACE INTO game_traps (id, item_id, requires_weapon, requires_ammo, requires_items, required_ammo_id) VALUES (?, ?, ?, ?, ?, ?)',
    );
    const tx = this._db.transaction((list) => {
      for (const t of list) {
        stmt.run(
          t.id,
          t.itemId || '',
          t.requiresWeapon ? 1 : 0,
          t.requiresAmmo ? 1 : 0,
          t.requiresItems ? 1 : 0,
          t.requiredAmmoId || '',
        );
      }
    });
    tx(traps);
  }

  seedGameSprays(sprays) {
    const stmt = this._db.prepare(
      'INSERT OR REPLACE INTO game_sprays (id, name, description, color) VALUES (?, ?, ?, ?)',
    );
    const tx = this._db.transaction((list) => {
      for (const s of list) {
        stmt.run(s.id, s.name || s.id, s.description || '', s.color || '');
      }
    });
    tx(sprays);
  }

  seedGameRecipes(recipes) {
    const stmt = this._db.prepare(`INSERT OR REPLACE INTO game_recipes (
      id, name, description, station, station_raw, recipe_type, craft_time,
      profession, profession_raw, requires_recipe, hidden, inventory_search_only,
      xp_multiplier, use_any, copy_capacity, no_spoiled, ignore_melee_check,
      override_name, override_description, crafted_item, also_give_item, also_give_arr,
      ingredients
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const tx = this._db.transaction((list) => {
      for (const r of list) {
        stmt.run(
          r.id,
          r.name || '',
          r.description || '',
          r.station || '',
          r.stationRaw || '',
          r.recipeType || '',
          r.craftTime ?? 0,
          r.profession || '',
          r.professionRaw || '',
          r.requiresRecipe ? 1 : 0,
          r.hidden ? 1 : 0,
          r.inventorySearchOnly ? 1 : 0,
          r.xpMultiplier ?? 1,
          r.useAny ? 1 : 0,
          r.copyCapacity ? 1 : 0,
          r.noSpoiled ? 1 : 0,
          r.ignoreMeleeCheck ? 1 : 0,
          r.overrideName || '',
          r.overrideDescription || '',
          _json(r.craftedItem),
          _json(r.alsoGiveItem),
          _json(r.alsoGiveArr),
          _json(r.ingredients),
        );
      }
    });
    tx(recipes);
  }

  seedGameLore(lore) {
    const stmt = this._db.prepare(
      'INSERT OR REPLACE INTO game_lore (id, title, text, category, sort_order) VALUES (?, ?, ?, ?, ?)',
    );
    const tx = this._db.transaction((list) => {
      for (const l of list) {
        stmt.run(l.id, l.title || '', l.text || '', l.category || '', l.order ?? 0);
      }
    });
    tx(lore);
  }

  seedGameQuests(quests) {
    const stmt = this._db.prepare(
      'INSERT OR REPLACE INTO game_quests (id, name, description, xp_reward, requirements, rewards) VALUES (?, ?, ?, ?, ?, ?)',
    );
    const tx = this._db.transaction((list) => {
      for (const q of list) {
        stmt.run(q.id, q.name || '', q.description || '', q.xpReward ?? 0, _json(q.requirements), _json(q.rewards));
      }
    });
    tx(quests);
  }

  seedGameSpawnLocations(spawns) {
    const stmt = this._db.prepare(
      'INSERT OR REPLACE INTO game_spawn_locations (id, name, description, map) VALUES (?, ?, ?, ?)',
    );
    const tx = this._db.transaction((list) => {
      for (const s of list) {
        stmt.run(s.id, s.name || s.id, s.description || '', s.map || '');
      }
    });
    tx(spawns);
  }

  seedGameServerSettingDefs(settings) {
    const stmt = this._db.prepare(
      'INSERT OR REPLACE INTO game_server_setting_defs (key, label, description, type, default_val, options) VALUES (?, ?, ?, ?, ?, ?)',
    );
    const tx = this._db.transaction((list) => {
      for (const s of list) {
        stmt.run(s.key, s.label || '', s.description || '', s.type || 'string', s.defaultVal || '', _json(s.options));
      }
    });
    tx(settings);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Timeline — full temporal world state tracking
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Record a complete world snapshot (one timeline tick).
   * All entity arrays are written inside a single transaction for consistency.
   *
   * @param {object} data
   * @param {object} data.snapshot - { gameDday, gameTime, playerCount, onlineCount, aiCount, ... }
   * @param {Array}  data.players  - [{ steamId, name, online, x, y, z, health, ... }]
   * @param {Array}  data.ai       - [{ aiType, category, displayName, nodeUid, x, y, z }]
   * @param {Array}  data.vehicles - [{ class, displayName, x, y, z, health, ... }]
   * @param {Array}  data.structures - [{ actorClass, displayName, ownerSteamId, ... }]
   * @param {Array}  data.houses   - [{ uid, name, windowsOpen, ... }]
   * @param {Array}  data.companions - [{ entityType, actorName, ... }]
   * @param {Array}  data.backpacks - [{ class, x, y, z, itemCount, items }]
   * @returns {number} The snapshot ID
   */
  insertTimelineSnapshot(data) {
    const s = data.snapshot || {};
    const result = this._stmts.insertTimelineSnapshot.run(
      s.gameDay || 0,
      s.gameTime || 0,
      s.playerCount || 0,
      s.onlineCount || 0,
      s.aiCount || 0,
      s.structureCount || 0,
      s.vehicleCount || 0,
      s.containerCount || 0,
      s.worldItemCount || 0,
      s.weatherType || '',
      s.season || '',
      s.airdropActive ? 1 : 0,
      s.airdropX ?? null,
      s.airdropY ?? null,
      s.airdropAiAlive || 0,
      JSON.stringify(s.summary || {}),
    );
    const snapId = result.lastInsertRowid;

    const tx = this._db.transaction(() => {
      // Players
      if (data.players) {
        for (const p of data.players) {
          this._stmts.insertTimelinePlayer.run(
            snapId,
            p.steamId,
            p.name || '',
            p.online ? 1 : 0,
            p.x ?? null,
            p.y ?? null,
            p.z ?? null,
            p.health || 0,
            p.maxHealth || 100,
            p.hunger || 0,
            p.thirst || 0,
            p.infection || 0,
            p.stamina || 0,
            p.level || 0,
            p.zeeksKilled || 0,
            p.daysSurvived || 0,
            p.lifetimeKills || 0,
          );
        }
      }

      // AI spawns
      if (data.ai) {
        for (const a of data.ai) {
          this._stmts.insertTimelineAI.run(
            snapId,
            a.aiType,
            a.category || '',
            a.displayName || '',
            a.nodeUid || '',
            a.x ?? null,
            a.y ?? null,
            a.z ?? null,
          );
        }
      }

      // Vehicles
      if (data.vehicles) {
        for (const v of data.vehicles) {
          this._stmts.insertTimelineVehicle.run(
            snapId,
            v.class,
            v.displayName || '',
            v.x ?? null,
            v.y ?? null,
            v.z ?? null,
            v.health || 0,
            v.maxHealth || 0,
            v.fuel || 0,
            v.itemCount || 0,
          );
        }
      }

      // Structures
      if (data.structures) {
        for (const st of data.structures) {
          this._stmts.insertTimelineStructure.run(
            snapId,
            st.actorClass,
            st.displayName || '',
            st.ownerSteamId || '',
            st.x ?? null,
            st.y ?? null,
            st.z ?? null,
            st.currentHealth || 0,
            st.maxHealth || 0,
            st.upgradeLevel || 0,
          );
        }
      }

      // Houses
      if (data.houses) {
        for (const h of data.houses) {
          this._stmts.insertTimelineHouse.run(
            snapId,
            h.uid,
            h.name || '',
            h.windowsOpen || 0,
            h.windowsTotal || 0,
            h.doorsOpen || 0,
            h.doorsLocked || 0,
            h.doorsTotal || 0,
            h.destroyedFurniture || 0,
            h.hasGenerator ? 1 : 0,
            h.sleepers || 0,
            h.clean || 0,
            h.x ?? null,
            h.y ?? null,
          );
        }
      }

      // Companions + horses
      if (data.companions) {
        for (const c of data.companions) {
          this._stmts.insertTimelineCompanion.run(
            snapId,
            c.entityType,
            c.actorName || '',
            c.displayName || '',
            c.ownerSteamId || '',
            c.x ?? null,
            c.y ?? null,
            c.z ?? null,
            c.health || 0,
            JSON.stringify(c.extra || {}),
          );
        }
      }

      // Dropped backpacks
      if (data.backpacks) {
        for (const b of data.backpacks) {
          this._stmts.insertTimelineBackpack.run(
            snapId,
            b.class || '',
            b.x ?? null,
            b.y ?? null,
            b.z ?? null,
            b.itemCount || 0,
            JSON.stringify(b.items || []),
          );
        }
      }
    });

    tx();
    return Number(snapId);
  }

  /** Get recent timeline snapshots (metadata only). */
  getTimelineSnapshots(limit = 50) {
    return this._stmts.getTimelineSnapshots.all(limit).map((r) => {
      if (r.summary)
        try {
          r.summary = JSON.parse(r.summary);
        } catch {
          /* */
        }
      return r;
    });
  }

  /** Get timeline snapshots in a date range. */
  getTimelineSnapshotRange(from, to) {
    return this._stmts.getTimelineSnapshotRange.all(from, to).map((r) => {
      if (r.summary)
        try {
          r.summary = JSON.parse(r.summary);
        } catch {
          /* */
        }
      return r;
    });
  }

  /** Get full snapshot data by ID (all entities). */
  getTimelineSnapshotFull(snapshotId) {
    const snap = this._stmts.getTimelineSnapshotById.get(snapshotId);
    if (!snap) return null;
    if (snap.summary)
      try {
        snap.summary = JSON.parse(snap.summary);
      } catch {
        /* */
      }
    return {
      snapshot: snap,
      players: this._stmts.getTimelinePlayers.all(snapshotId),
      ai: this._stmts.getTimelineAI.all(snapshotId),
      vehicles: this._stmts.getTimelineVehicles.all(snapshotId),
      structures: this._stmts.getTimelineStructures.all(snapshotId),
      houses: this._stmts.getTimelineHouses.all(snapshotId),
      companions: this._stmts.getTimelineCompanions.all(snapshotId),
      backpacks: this._stmts.getTimelineBackpacks.all(snapshotId).map((b) => {
        if (b.items_summary)
          try {
            b.items_summary = JSON.parse(b.items_summary);
          } catch {
            /* */
          }
        return b;
      }),
    };
  }

  /** Get timeline bounds (earliest, latest, count). */
  getTimelineBounds() {
    return this._stmts.getTimelineSnapshotBounds.get();
  }

  /** Get player position history for trails. */
  getPlayerPositionHistory(steamId, from, to) {
    return this._stmts.getPlayerPositionHistory.all(steamId, from, to);
  }

  /** Get AI population history for charts. */
  getAIPopulationHistory(from, to) {
    return this._stmts.getAIPopulationHistory.all(from, to);
  }

  /** Purge old timeline data (default: keep 7 days). */
  purgeOldTimeline(olderThan = '-7 days') {
    return this._stmts.purgeOldTimeline.run(olderThan);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Death causes — who/what killed who
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Record a death cause attribution.
   * @param {object} data
   * @param {string} data.victimName
   * @param {string} [data.victimSteamId]
   * @param {string} data.causeType   - 'zombie', 'animal', 'bandit', 'player', 'environment', 'unknown'
   * @param {string} data.causeName   - classified name ('Runner', 'Wolf', 'PlayerX')
   * @param {string} [data.causeRaw]  - raw BP_ blueprint name
   * @param {number} [data.damageTotal]
   * @param {number} [data.x]
   * @param {number} [data.y]
   * @param {number} [data.z]
   */
  insertDeathCause(data) {
    this._stmts.insertDeathCause.run(
      data.victimName,
      data.victimSteamId || '',
      data.causeType,
      data.causeName || '',
      data.causeRaw || '',
      data.damageTotal || 0,
      data.x ?? null,
      data.y ?? null,
      data.z ?? null,
    );
  }

  /** Get recent death causes. */
  getDeathCauses(limit = 50) {
    return this._stmts.getDeathCauses.all(limit);
  }

  /** Get death causes for a specific player. */
  getDeathCausesByPlayer(nameOrSteamId, limit = 50) {
    return this._stmts.getDeathCausesByPlayer.all(nameOrSteamId, nameOrSteamId, limit);
  }

  /** Get death cause statistics (grouped by cause_type + cause_name). */
  getDeathCauseStats() {
    return this._stmts.getDeathCauseStats.all();
  }

  /** Get death causes since a timestamp. */
  getDeathCausesSince(since) {
    return this._stmts.getDeathCausesSince.all(since);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Anticheat — flags, risk scores, entity fingerprints
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Insert an anticheat flag.
   * @param {object} flag - { steam_id, player_name, detector, severity, score, details, evidence, auto_escalated }
   * @returns {number} The inserted flag ID
   */
  insertAcFlag(flag) {
    const info = this._stmts.insertAcFlag.run({
      steam_id: flag.steam_id,
      player_name: flag.player_name || '',
      detector: flag.detector,
      severity: flag.severity || 'low',
      score: flag.score || 0,
      details: typeof flag.details === 'string' ? flag.details : JSON.stringify(flag.details || {}),
      evidence: typeof flag.evidence === 'string' ? flag.evidence : JSON.stringify(flag.evidence || []),
      auto_escalated: flag.auto_escalated ? 1 : 0,
    });
    return info.lastInsertRowid;
  }

  /** Get flags by status ('open', 'confirmed', 'dismissed', 'whitelisted'). */
  getAcFlags(status = 'open', limit = 100) {
    return this._stmts.getAcFlags.all(status, limit).map(_parseAcFlagRow);
  }

  /** Get all flags for a specific player. */
  getAcFlagsBySteam(steamId, limit = 100) {
    return this._stmts.getAcFlagsBySteam.all(steamId, limit).map(_parseAcFlagRow);
  }

  /** Get flags by detector type and status. */
  getAcFlagsByDetector(detector, status = 'open', limit = 100) {
    return this._stmts.getAcFlagsByDetector.all(detector, status, limit).map(_parseAcFlagRow);
  }

  /** Get flags for a player since a timestamp. */
  getAcFlagsSince(steamId, since) {
    return this._stmts.getAcFlagsSince.all(steamId, since).map(_parseAcFlagRow);
  }

  /** Count flags for a player matching severities and status since a timestamp. */
  getAcFlagCount(steamId, sev1, sev2, status, since) {
    return this._stmts.getAcFlagCount.get(steamId, sev1, sev2, status, since).count;
  }

  /** Update a flag's review status. */
  updateAcFlagStatus(flagId, status, reviewedBy = null, notes = null) {
    this._stmts.updateAcFlagStatus.run(status, reviewedBy, notes, flagId);
  }

  /** Auto-escalate a flag's severity. */
  escalateAcFlag(flagId, newSeverity) {
    this._stmts.escalateAcFlag.run(newSeverity, flagId);
  }

  /**
   * Upsert a player risk score.
   * @param {object} data - { steam_id, risk_score, open_flags, confirmed_flags, dismissed_flags, last_flag_at, baseline_data }
   */
  upsertRiskScore(data) {
    this._stmts.upsertRiskScore.run({
      steam_id: data.steam_id,
      risk_score: data.risk_score || 0,
      open_flags: data.open_flags || 0,
      confirmed_flags: data.confirmed_flags || 0,
      dismissed_flags: data.dismissed_flags || 0,
      last_flag_at: data.last_flag_at || null,
      baseline_data:
        typeof data.baseline_data === 'string' ? data.baseline_data : JSON.stringify(data.baseline_data || {}),
    });
  }

  /** Get a player's risk score record. */
  getRiskScore(steamId) {
    const row = this._stmts.getRiskScore.get(steamId);
    return row ? _parseRiskRow(row) : null;
  }

  /** Get all player risk scores, highest first. */
  getAllRiskScores() {
    return this._stmts.getAllRiskScores.all().map(_parseRiskRow);
  }

  /**
   * Upsert an entity fingerprint.
   * @param {object} fp - { entity_type, entity_id, fingerprint, parent_id, creator_steam_id, tamper_score, metadata }
   */
  upsertFingerprint(fp) {
    this._stmts.upsertFingerprint.run({
      entity_type: fp.entity_type,
      entity_id: fp.entity_id,
      fingerprint: fp.fingerprint,
      parent_id: fp.parent_id || null,
      creator_steam_id: fp.creator_steam_id || null,
      tamper_score: fp.tamper_score || 0,
      metadata: typeof fp.metadata === 'string' ? fp.metadata : JSON.stringify(fp.metadata || {}),
    });
  }

  /** Get a fingerprint by entity type + id. */
  getFingerprint(entityType, entityId) {
    const row = this._stmts.getFingerprint.get(entityType, entityId);
    return row ? _parseFingerprintRow(row) : null;
  }

  /** Get all fingerprints for an entity type. */
  getFingerprintsByType(entityType) {
    return this._stmts.getFingerprintsByType.all(entityType).map(_parseFingerprintRow);
  }

  /**
   * Insert a fingerprint event (state change provenance).
   * @param {object} evt - { fingerprint_id, event_type, old_state, new_state, attributed_to, source, confidence }
   * @returns {number} The inserted event ID
   */
  insertFingerprintEvent(evt) {
    const info = this._stmts.insertFingerprintEvent.run({
      fingerprint_id: evt.fingerprint_id,
      event_type: evt.event_type,
      old_state: typeof evt.old_state === 'string' ? evt.old_state : JSON.stringify(evt.old_state || null),
      new_state: typeof evt.new_state === 'string' ? evt.new_state : JSON.stringify(evt.new_state || null),
      attributed_to: evt.attributed_to || null,
      source: evt.source || 'inferred',
      confidence: evt.confidence ?? 1.0,
    });
    return info.lastInsertRowid;
  }

  /** Get events for a fingerprint. */
  getFingerprintEvents(fingerprintId, limit = 50) {
    return this._stmts.getFingerprintEvents.all(fingerprintId, limit).map(_parseFingerprintEventRow);
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
  const parsed = { ...row };
  for (const col of jsonCols) {
    if (parsed[col] && typeof parsed[col] === 'string') {
      try {
        parsed[col] = JSON.parse(parsed[col]);
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
function _parsePlayerRowForDiff(row) {
  if (!row) return null;
  const parsed = {
    steam_id: row.steam_id,
    name: row.name,
    online: !!row.online,
    pos_x: row.pos_x,
    pos_y: row.pos_y,
    pos_z: row.pos_z,
    inventory: null,
    equipment: null,
    quick_slots: null,
    backpack_items: null,
  };
  for (const col of ['inventory', 'equipment', 'quick_slots', 'backpack_items']) {
    if (row[col] && typeof row[col] === 'string') {
      try {
        parsed[col] = JSON.parse(row[col]);
      } catch {
        parsed[col] = row[col];
      }
    }
  }
  return parsed;
}

function _parseActivityRow(row) {
  if (!row) return null;
  const parsed = { ...row };
  if (parsed.details && typeof parsed.details === 'string') {
    try {
      parsed.details = JSON.parse(parsed.details);
    } catch {
      /* leave as string */
    }
  }
  return parsed;
}

function _parseAcFlagRow(row) {
  if (!row) return null;
  const parsed = { ...row };
  for (const col of ['details', 'evidence']) {
    if (parsed[col] && typeof parsed[col] === 'string') {
      try {
        parsed[col] = JSON.parse(parsed[col]);
      } catch {
        /* leave as string */
      }
    }
  }
  parsed.auto_escalated = !!parsed.auto_escalated;
  return parsed;
}

function _parseRiskRow(row) {
  if (!row) return null;
  const parsed = { ...row };
  if (parsed.baseline_data && typeof parsed.baseline_data === 'string') {
    try {
      parsed.baseline_data = JSON.parse(parsed.baseline_data);
    } catch {
      /* leave as string */
    }
  }
  return parsed;
}

function _parseFingerprintRow(row) {
  if (!row) return null;
  const parsed = { ...row };
  if (parsed.metadata && typeof parsed.metadata === 'string') {
    try {
      parsed.metadata = JSON.parse(parsed.metadata);
    } catch {
      /* leave as string */
    }
  }
  return parsed;
}

function _parseFingerprintEventRow(row) {
  if (!row) return null;
  const parsed = { ...row };
  for (const col of ['old_state', 'new_state']) {
    if (parsed[col] && typeof parsed[col] === 'string') {
      try {
        parsed[col] = JSON.parse(parsed[col]);
      } catch {
        /* leave as string */
      }
    }
  }
  return parsed;
}

module.exports = HumanitZDB;

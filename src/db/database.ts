/**
 * Database manager for the HumanitZ bot.
 *
 * Thin facade over 12 domain repositories (see src/db/repositories/).
 * Handles lifecycle, schema migration, and delegates all domain queries.
 *
 *   - Auto-initialisation (creates tables on first run)
 *   - Schema versioning & migration
 *   - WAL mode for concurrent reads during bot operation
 *   - Facade delegation to domain repositories
 *
 * Usage:
 *   import HumanitZDB from './database.js';
 *   const db = new HumanitZDB();
 *   db.init();                           // create schema + repositories
 *   db.upsertPlayer(steamId, data);      // delegates to PlayerRepository
 *   const p = db.getPlayer(steamId);     // delegates to PlayerRepository
 *   db.close();                          // closes handle + nulls repos
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { SCHEMA_VERSION, ALL_TABLES } from './schema.js';
import { createLogger, type Logger } from '../utils/log.js';
import { getDirname } from '../utils/paths.js';
import { PlayerRepository } from './repositories/player-repository.js';
import { ClanRepository } from './repositories/clan-repository.js';
import { LeaderboardRepository } from './repositories/leaderboard-repository.js';
import { WorldObjectRepository } from './repositories/world-object-repository.js';
import { ItemRepository } from './repositories/item-repository.js';
import { ActivityLogRepository } from './repositories/activity-log-repository.js';
import { ChatLogRepository } from './repositories/chat-log-repository.js';
import { DeathCauseRepository } from './repositories/death-cause-repository.js';
import { AntiCheatRepository } from './repositories/anti-cheat-repository.js';
import { TimelineRepository } from './repositories/timeline-repository.js';
import { GameDataRepository } from './repositories/game-data-repository.js';
import { QuestRepository } from './repositories/quest-repository.js';
import { type DbRow } from './repositories/db-utils.js';

const __dirname = getDirname(import.meta.url);
const DEFAULT_DB_PATH = path.join(__dirname, '..', '..', 'data', 'humanitz.db');

/** Prepared statements that remain in the facade (not delegated to repositories). */
interface PreparedStatements {
  // Meta
  getMeta: Database.Statement;
  setMeta: Database.Statement;
  // World state
  setWorldState: Database.Statement;
  getWorldState: Database.Statement;
  getAllWorldState: Database.Statement;
  // Server settings
  upsertSetting: Database.Statement;
  getSetting: Database.Statement;
  getAllSettings: Database.Statement;
  // Snapshots
  insertSnapshot: Database.Statement;
  getLatestSnapshot: Database.Statement;
  purgeOldSnapshots: Database.Statement;
}

class HumanitZDB {
  _dbPath: string;
  _memory: boolean;
  _log: Logger;
  _db: Database.Database | null;
  _stmts: PreparedStatements;
  private _dbRaw: Database.Database | null;

  // ── Repository references ──
  private _playerRepo: PlayerRepository | null = null;
  private _clanRepo: ClanRepository | null = null;
  private _leaderboardRepo: LeaderboardRepository | null = null;
  private _worldObjectRepo: WorldObjectRepository | null = null;
  private _itemRepo: ItemRepository | null = null;
  private _activityLogRepo: ActivityLogRepository | null = null;
  private _chatLogRepo: ChatLogRepository | null = null;
  private _deathCauseRepo: DeathCauseRepository | null = null;
  private _antiCheatRepo: AntiCheatRepository | null = null;
  private _timelineRepo: TimelineRepository | null = null;
  private _gameDataRepo: GameDataRepository | null = null;
  private _questRepo: QuestRepository | null = null;

  constructor(options: { dbPath?: string; memory?: boolean; label?: string } = {}) {
    this._dbPath = options.dbPath ?? DEFAULT_DB_PATH;
    this._memory = options.memory ?? false;
    this._log = createLogger(options.label, 'DB');
    this._db = null;
    this._dbRaw = null;
    this._stmts = {} as PreparedStatements;
  }

  /** Get the active database handle. Throws if not initialized or closed. */
  private get _handle(): Database.Database {
    if (!this._db) throw new Error('Database not initialized — call init() first');
    return this._db;
  }

  /** PlayerRepository — player CRUD, playtime, aliases, peaks. */
  get player(): PlayerRepository {
    if (!this._playerRepo) throw new Error('Database not initialized — call init() first');
    return this._playerRepo;
  }
  /** ClanRepository — clan CRUD and membership. */
  get clan(): ClanRepository {
    if (!this._clanRepo) throw new Error('Database not initialized — call init() first');
    return this._clanRepo;
  }
  /** LeaderboardRepository — leaderboard queries. */
  get leaderboard(): LeaderboardRepository {
    if (!this._leaderboardRepo) throw new Error('Database not initialized — call init() first');
    return this._leaderboardRepo;
  }
  /** WorldObjectRepository — world objects and loot. */
  get worldObject(): WorldObjectRepository {
    if (!this._worldObjectRepo) throw new Error('Database not initialized — call init() first');
    return this._worldObjectRepo;
  }
  /** ItemRepository — item instances, groups, and movements. */
  get item(): ItemRepository {
    if (!this._itemRepo) throw new Error('Database not initialized — call init() first');
    return this._itemRepo;
  }
  /** ActivityLogRepository — activity log entries. */
  get activityLog(): ActivityLogRepository {
    if (!this._activityLogRepo) throw new Error('Database not initialized — call init() first');
    return this._activityLogRepo;
  }
  /** ChatLogRepository — chat log entries. */
  get chatLog(): ChatLogRepository {
    if (!this._chatLogRepo) throw new Error('Database not initialized — call init() first');
    return this._chatLogRepo;
  }
  /** DeathCauseRepository — death cause statistics. */
  get deathCause(): DeathCauseRepository {
    if (!this._deathCauseRepo) throw new Error('Database not initialized — call init() first');
    return this._deathCauseRepo;
  }
  /** AntiCheatRepository — anti-cheat flags and logs. */
  get antiCheat(): AntiCheatRepository {
    if (!this._antiCheatRepo) throw new Error('Database not initialized — call init() first');
    return this._antiCheatRepo;
  }
  /** TimelineRepository — timeline events and queries. */
  get timeline(): TimelineRepository {
    if (!this._timelineRepo) throw new Error('Database not initialized — call init() first');
    return this._timelineRepo;
  }
  /** GameDataRepository — game data tables (items, buildings, vehicles, etc.). */
  get gameData(): GameDataRepository {
    if (!this._gameDataRepo) throw new Error('Database not initialized — call init() first');
    return this._gameDataRepo;
  }
  /** QuestRepository — quest data. */
  get quest(): QuestRepository {
    if (!this._questRepo) throw new Error('Database not initialized — call init() first');
    return this._questRepo;
  }

  /**
   * Run a function inside a database transaction.
   * Use this when performing multi-repository writes that must be atomic.
   *
   * Note: `fn` must be synchronous. `better-sqlite3` transactions are
   * synchronous and will not await asynchronous work.
   *
   * @example
   * db.transaction(() => {
   *   db.player.upsertPlayer(steamId, data);
   *   db.activityLog.insertActivity(entry);
   * });
   */
  transaction<T>(fn: () => PromiseLike<T>): never;
  transaction<T>(fn: () => T): T;
  transaction<T>(fn: () => T | PromiseLike<T>): T {
    return this._handle.transaction(() => {
      const result = fn();
      if (
        result !== null &&
        typeof result === 'object' &&
        'then' in result &&
        typeof (result as unknown as Record<string, unknown>).then === 'function'
      ) {
        throw new TypeError('Database.transaction() callback must be synchronous and must not return a Promise');
      }
      return result as T;
    })();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Lifecycle
  // ═══════════════════════════════════════════════════════════════════════════

  init(): void {
    if (this._dbRaw) return;

    // Ensure data directory exists
    if (!this._memory) {
      const dir = path.dirname(this._dbPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      // Copy template DB on first run (pre-seeded with game reference data)
      if (!fs.existsSync(this._dbPath)) {
        const templatePath = path.join(path.dirname(this._dbPath), 'humanitz-template.db');
        if (fs.existsSync(templatePath)) {
          fs.copyFileSync(templatePath, this._dbPath);
          this._log.info('Copied template DB as starting point');
        }
      }
    }

    this._dbRaw = new Database(this._memory ? ':memory:' : this._dbPath);
    this._db = this._dbRaw;
    this._handle.pragma('journal_mode = WAL');
    this._handle.pragma('foreign_keys = ON');
    this._handle.pragma('busy_timeout = 5000');

    this._applySchema();
    this._prepareStatements();

    // Instantiate repositories
    this._playerRepo = new PlayerRepository(this._handle, this._log.label);
    this._clanRepo = new ClanRepository(this._handle, this._log.label);
    this._leaderboardRepo = new LeaderboardRepository(this._handle, this._log.label);
    this._worldObjectRepo = new WorldObjectRepository(this._handle, this._log.label);
    this._itemRepo = new ItemRepository(this._handle, this._log.label);
    this._activityLogRepo = new ActivityLogRepository(this._handle, this._log.label);
    this._chatLogRepo = new ChatLogRepository(this._handle, this._log.label);
    this._deathCauseRepo = new DeathCauseRepository(this._handle, this._log.label);
    this._antiCheatRepo = new AntiCheatRepository(this._handle, this._log.label);
    this._timelineRepo = new TimelineRepository(this._handle, this._log.label);
    this._gameDataRepo = new GameDataRepository(this._handle, this._log.label);
    this._questRepo = new QuestRepository(this._handle, this._log.label);

    const version = this._getMeta('schema_version');
    this._log.info(`Database ready (v${version}, ${this._memory ? 'in-memory' : this._dbPath})`);
  }

  close(): void {
    if (this._dbRaw) {
      this._dbRaw.close();
      this._db = null;
      this._dbRaw = null;
      this._stmts = {} as PreparedStatements;
      this._playerRepo = null;
      this._clanRepo = null;
      this._leaderboardRepo = null;
      this._worldObjectRepo = null;
      this._itemRepo = null;
      this._activityLogRepo = null;
      this._chatLogRepo = null;
      this._deathCauseRepo = null;
      this._antiCheatRepo = null;
      this._timelineRepo = null;
      this._gameDataRepo = null;
      this._questRepo = null;
    }
  }

  get db(): Database.Database | null {
    return this._db;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Schema management
  // ═══════════════════════════════════════════════════════════════════════════

  _applySchema() {
    const currentVersion = this._getMetaRaw('schema_version');

    if (!currentVersion) {
      // First run — create all tables
      this._handle.exec('BEGIN');
      for (const sql of ALL_TABLES) {
        this._handle.exec(sql);
      }
      this._setMeta('schema_version', String(SCHEMA_VERSION));
      this._handle.exec('COMMIT');
      this._log.info(`Schema created (v${SCHEMA_VERSION})`);
    } else if (parseInt(currentVersion, 10) < SCHEMA_VERSION) {
      this._handle.exec('BEGIN');
      const fromVersion = parseInt(currentVersion, 10);

      // v1 → v2: Add player_aliases table
      if (fromVersion < 2) {
        this._handle.exec(`
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
        const players = this._handle
          .prepare("SELECT steam_id, name, name_history FROM players WHERE name != ''")
          .all() as Array<{ steam_id: string; name: string; name_history: string }>;
        const insertAlias = this._handle.prepare(`
          INSERT OR IGNORE INTO player_aliases (steam_id, name, name_lower, source, first_seen, last_seen, is_current)
          VALUES (?, ?, ?, 'save', datetime('now'), datetime('now'), ?)
        `);
        for (const p of players) {
          if (p.name) insertAlias.run(p.steam_id, p.name, p.name.toLowerCase(), 1);
          // Also import name history
          try {
            const history = JSON.parse(p.name_history || '[]') as Array<{ name?: string }>;
            for (const h of history) {
              if (h.name) insertAlias.run(p.steam_id, h.name, h.name.toLowerCase(), 0);
            }
          } catch {
            /* ignore bad JSON */
          }
        }
        this._log.info(`Migration v1→v2: created player_aliases (seeded ${players.length} players)`);
      }

      // v2 → v3: Add day_incremented + infection_timer columns to players
      if (fromVersion < 3) {
        // Use try/catch per column so migration is safe if columns already exist
        try {
          this._handle.exec('ALTER TABLE players ADD COLUMN day_incremented INTEGER DEFAULT 0');
        } catch {
          /* already exists */
        }
        try {
          this._handle.exec('ALTER TABLE players ADD COLUMN infection_timer REAL DEFAULT 0');
        } catch {
          /* already exists */
        }
        this._log.info('Migration v2→v3: added day_incremented + infection_timer columns');
      }

      // v3 → v4: Add world_horses table, enrich containers, add activity_log
      if (fromVersion < 4) {
        // World horses table
        this._handle.exec(`
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
          this._handle.exec("ALTER TABLE containers ADD COLUMN quick_slots TEXT DEFAULT '[]'");
        } catch {
          /* already exists */
        }
        try {
          this._handle.exec('ALTER TABLE containers ADD COLUMN locked INTEGER DEFAULT 0');
        } catch {
          /* already exists */
        }
        try {
          this._handle.exec('ALTER TABLE containers ADD COLUMN does_spawn_loot INTEGER DEFAULT 0');
        } catch {
          /* already exists */
        }
        try {
          this._handle.exec('ALTER TABLE containers ADD COLUMN alarm_off INTEGER DEFAULT 0');
        } catch {
          /* already exists */
        }
        try {
          this._handle.exec("ALTER TABLE containers ADD COLUMN crafting_content TEXT DEFAULT '[]'");
        } catch {
          /* already exists */
        }
        try {
          this._handle.exec("ALTER TABLE containers ADD COLUMN extra TEXT DEFAULT '{}'");
        } catch {
          /* already exists */
        }

        // Activity log table
        this._handle.exec(`
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

        this._log.info('Migration v3→v4: added world_horses, enriched containers, added activity_log');
      }

      // v4 → v5: Add steam_id + source + target columns to activity_log, create chat_log
      if (fromVersion < 5) {
        // New columns on activity_log
        try {
          this._handle.exec("ALTER TABLE activity_log ADD COLUMN steam_id TEXT DEFAULT ''");
        } catch {
          /* already exists */
        }
        try {
          this._handle.exec("ALTER TABLE activity_log ADD COLUMN source TEXT DEFAULT 'save'");
        } catch {
          /* already exists */
        }
        try {
          this._handle.exec("ALTER TABLE activity_log ADD COLUMN target_name TEXT DEFAULT ''");
        } catch {
          /* already exists */
        }
        try {
          this._handle.exec("ALTER TABLE activity_log ADD COLUMN target_steam_id TEXT DEFAULT ''");
        } catch {
          /* already exists */
        }
        // New indexes
        try {
          this._handle.exec('CREATE INDEX IF NOT EXISTS idx_activity_steam_id ON activity_log(steam_id)');
        } catch {
          /* */
        }
        try {
          this._handle.exec('CREATE INDEX IF NOT EXISTS idx_activity_source ON activity_log(source)');
        } catch {
          /* */
        }

        // Chat log table
        this._handle.exec(`
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

        this._log.info('Migration v4→v5: enriched activity_log, added chat_log');
      }

      // v5 → v6: Add level, exp_current, exp_required, skills_point columns to players
      if (fromVersion < 6) {
        try {
          this._handle.exec('ALTER TABLE players ADD COLUMN level INTEGER DEFAULT 0');
        } catch {
          /* already exists */
        }
        try {
          this._handle.exec('ALTER TABLE players ADD COLUMN exp_current REAL DEFAULT 0');
        } catch {
          /* already exists */
        }
        try {
          this._handle.exec('ALTER TABLE players ADD COLUMN exp_required REAL DEFAULT 0');
        } catch {
          /* already exists */
        }
        try {
          this._handle.exec('ALTER TABLE players ADD COLUMN skills_point INTEGER DEFAULT 0');
        } catch {
          /* already exists */
        }
        this._log.info('Migration v5→v6: added level, exp_current, exp_required, skills_point');
      }

      // v6 → v7: Item instance tracking, item movements, world drops
      if (fromVersion < 7) {
        this._handle.exec(`
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

        this._handle.exec(`
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

        this._handle.exec(`
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

        this._log.info('Migration v6→v7: added item_instances, item_movements, world_drops');
      }

      // v7 → v8: Item groups (fungible item tracking) + schema updates
      if (fromVersion < 8) {
        this._handle.exec(`
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
          this._handle.exec('ALTER TABLE item_instances ADD COLUMN group_id INTEGER DEFAULT NULL');
        } catch {
          /* already exists */
        }
        try {
          this._handle.exec('CREATE INDEX IF NOT EXISTS idx_item_inst_group ON item_instances(group_id)');
        } catch {
          /* already exists */
        }

        // Add group_id + move_type to item_movements if not present
        try {
          this._handle.exec('ALTER TABLE item_movements ADD COLUMN group_id INTEGER DEFAULT NULL');
        } catch {
          /* already exists */
        }
        try {
          this._handle.exec("ALTER TABLE item_movements ADD COLUMN move_type TEXT DEFAULT 'move'");
        } catch {
          /* already exists */
        }
        try {
          this._handle.exec('CREATE INDEX IF NOT EXISTS idx_item_mov_group ON item_movements(group_id)');
        } catch {
          /* already exists */
        }

        // Make instance_id nullable (group-level movements don't have an instance)
        // SQLite doesn't support ALTER COLUMN, but the column already allows NULL values
        // since the NOT NULL constraint is only enforced on INSERT

        this._log.info('Migration v7→v8: added item_groups, group_id columns');
      }

      // v8 → v9: DB-first player stats & playtime — add detailed log columns + server_peaks
      if (fromVersion < 9) {
        // New detailed log stats columns on players
        try {
          this._handle.exec('ALTER TABLE players ADD COLUMN log_connects INTEGER DEFAULT 0');
        } catch {
          /* already exists */
        }
        try {
          this._handle.exec('ALTER TABLE players ADD COLUMN log_disconnects INTEGER DEFAULT 0');
        } catch {
          /* already exists */
        }
        try {
          this._handle.exec('ALTER TABLE players ADD COLUMN log_admin_access INTEGER DEFAULT 0');
        } catch {
          /* already exists */
        }
        try {
          this._handle.exec('ALTER TABLE players ADD COLUMN log_destroyed_out INTEGER DEFAULT 0');
        } catch {
          /* already exists */
        }
        try {
          this._handle.exec('ALTER TABLE players ADD COLUMN log_destroyed_in INTEGER DEFAULT 0');
        } catch {
          /* already exists */
        }
        try {
          this._handle.exec("ALTER TABLE players ADD COLUMN log_build_items TEXT DEFAULT '{}'");
        } catch {
          /* already exists */
        }
        try {
          this._handle.exec("ALTER TABLE players ADD COLUMN log_killed_by TEXT DEFAULT '{}'");
        } catch {
          /* already exists */
        }
        try {
          this._handle.exec("ALTER TABLE players ADD COLUMN log_damage_detail TEXT DEFAULT '{}'");
        } catch {
          /* already exists */
        }
        try {
          this._handle.exec("ALTER TABLE players ADD COLUMN log_cheat_flags TEXT DEFAULT '[]'");
        } catch {
          /* already exists */
        }
        // New playtime detail columns on players
        try {
          this._handle.exec('ALTER TABLE players ADD COLUMN playtime_first_seen TEXT');
        } catch {
          /* already exists */
        }
        try {
          this._handle.exec('ALTER TABLE players ADD COLUMN playtime_last_login TEXT');
        } catch {
          /* already exists */
        }
        try {
          this._handle.exec('ALTER TABLE players ADD COLUMN playtime_last_seen TEXT');
        } catch {
          /* already exists */
        }

        // Server peaks table
        this._handle.exec(`
          CREATE TABLE IF NOT EXISTS server_peaks (
            key         TEXT PRIMARY KEY,
            value       TEXT DEFAULT '',
            updated_at  TEXT DEFAULT (datetime('now'))
          );
        `);

        this._log.info('Migration v8→v9: DB-first player stats & playtime');
      }

      // v9 → v10: Timeline tables (full temporal tracking) + death causes
      if (fromVersion < 10) {
        this._handle.exec(`
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

        this._handle.exec(`
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

        this._handle.exec(`
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

        this._handle.exec(`
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

        this._handle.exec(`
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

        this._handle.exec(`
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

        this._handle.exec(`
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

        this._handle.exec(`
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

        this._handle.exec(`
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

        this._log.info('Migration v9→v10: timeline tables + death causes');
      }

      // v10 → v11: Expanded game_items schema + new reference tables
      if (fromVersion < 11) {
        // Drop and recreate game_items with expanded columns
        this._handle.exec('DROP TABLE IF EXISTS game_items');
        this._handle.exec(`
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
        this._handle.exec(`
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

        this._handle.exec(`
          CREATE TABLE IF NOT EXISTS game_loot_pools (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, item_count INTEGER DEFAULT 0
          );
        `);

        this._handle.exec(`
          CREATE TABLE IF NOT EXISTS game_loot_pool_items (
            pool_id TEXT NOT NULL, item_id TEXT NOT NULL, name TEXT DEFAULT '',
            chance_to_spawn REAL DEFAULT 0, type TEXT DEFAULT '', max_stack_size INTEGER DEFAULT 1,
            PRIMARY KEY (pool_id, item_id)
          );
          CREATE INDEX IF NOT EXISTS idx_loot_pool ON game_loot_pool_items(pool_id);
        `);

        this._handle.exec(`CREATE TABLE IF NOT EXISTS game_vehicles_ref (id TEXT PRIMARY KEY, name TEXT NOT NULL);`);
        this._handle.exec(
          `CREATE TABLE IF NOT EXISTS game_animals (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT DEFAULT '', hide_item_id TEXT DEFAULT '');`,
        );
        this._handle.exec(`
          CREATE TABLE IF NOT EXISTS game_crops (
            id TEXT PRIMARY KEY, crop_id INTEGER DEFAULT 0, growth_time_days REAL DEFAULT 0,
            grid_columns INTEGER DEFAULT 1, grid_rows INTEGER DEFAULT 1,
            harvest_result TEXT DEFAULT '', harvest_count INTEGER DEFAULT 0, grow_seasons TEXT DEFAULT '[]'
          );
        `);
        this._handle.exec(`
          CREATE TABLE IF NOT EXISTS game_car_upgrades (
            id TEXT PRIMARY KEY, type TEXT DEFAULT '', type_raw TEXT DEFAULT '', level INTEGER DEFAULT 0,
            socket TEXT DEFAULT '', tool_durability_lost REAL DEFAULT 0, craft_time_minutes REAL DEFAULT 0,
            health REAL DEFAULT 0, craft_cost TEXT DEFAULT '[]'
          );
        `);
        this._handle.exec(
          `CREATE TABLE IF NOT EXISTS game_ammo_types (id TEXT PRIMARY KEY, damage REAL DEFAULT 0, headshot_multiplier REAL DEFAULT 1, range REAL DEFAULT 0, penetration REAL DEFAULT 0);`,
        );
        this._handle.exec(`
          CREATE TABLE IF NOT EXISTS game_repair_data (
            id TEXT PRIMARY KEY, resource_type TEXT DEFAULT '', resource_type_raw TEXT DEFAULT '',
            amount INTEGER DEFAULT 0, health_to_add REAL DEFAULT 0, is_repairable INTEGER DEFAULT 1,
            extra_resources TEXT DEFAULT '[]'
          );
        `);
        this._handle.exec(
          `CREATE TABLE IF NOT EXISTS game_furniture (id TEXT PRIMARY KEY, name TEXT NOT NULL, mesh_count INTEGER DEFAULT 0, drop_resources TEXT DEFAULT '[]');`,
        );
        this._handle.exec(
          `CREATE TABLE IF NOT EXISTS game_traps (id TEXT PRIMARY KEY, item_id TEXT DEFAULT '', requires_weapon INTEGER DEFAULT 0, requires_ammo INTEGER DEFAULT 0, requires_items INTEGER DEFAULT 0, required_ammo_id TEXT DEFAULT '');`,
        );
        this._handle.exec(
          `CREATE TABLE IF NOT EXISTS game_sprays (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '', color TEXT DEFAULT '');`,
        );

        // Drop and recreate changed reference tables
        this._handle.exec('DROP TABLE IF EXISTS game_recipes');
        this._handle.exec(`
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

        this._handle.exec('DROP TABLE IF EXISTS game_lore');
        this._handle.exec(`
          CREATE TABLE IF NOT EXISTS game_lore (
            id TEXT PRIMARY KEY, title TEXT DEFAULT '', text TEXT DEFAULT '',
            category TEXT DEFAULT '', sort_order INTEGER DEFAULT 0
          );
        `);

        this._handle.exec('DROP TABLE IF EXISTS game_quests');
        this._handle.exec(`
          CREATE TABLE IF NOT EXISTS game_quests (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '',
            xp_reward INTEGER DEFAULT 0, requirements TEXT DEFAULT '[]', rewards TEXT DEFAULT '[]'
          );
        `);

        this._handle.exec('DROP TABLE IF EXISTS game_spawn_locations');
        this._handle.exec(`
          CREATE TABLE IF NOT EXISTS game_spawn_locations (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '', map TEXT DEFAULT ''
          );
        `);

        this._log.info('Migration v10→v11: expanded game_items, added 11 new reference tables');
      }

      // v11 → v12: bot_state key-value table for runtime operational state
      if (fromVersion < 12) {
        this._handle.exec(`
          CREATE TABLE IF NOT EXISTS bot_state (
            key        TEXT PRIMARY KEY,
            value      TEXT,
            updated_at TEXT DEFAULT (datetime('now'))
          );
        `);
        this._log.info('Migration v11→v12: bot_state table');
      }

      // v12 → v13: anticheat tables (flags, risk scores, entity fingerprints)
      if (fromVersion < 13) {
        this._handle.exec(`
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
        this._log.info('Migration v12→v13: anticheat flags, risk scores, entity fingerprints');
      }

      // v14 → v15: config_documents table (DB-backed configuration storage)
      if (fromVersion < 15) {
        this._handle.exec(`
          CREATE TABLE IF NOT EXISTS config_documents (
            scope      TEXT PRIMARY KEY,
            data       TEXT NOT NULL DEFAULT '{}',
            version    INTEGER DEFAULT 1,
            updated_at TEXT DEFAULT (datetime('now'))
          );
        `);
        this._log.info('Migration v14→v15: config_documents table');
      }

      this._setMeta('schema_version', String(SCHEMA_VERSION));
      this._handle.exec('COMMIT');
      this._log.info(`Schema migrated to v${SCHEMA_VERSION}`);
    }
  }

  _getMetaRaw(key: string) {
    try {
      // meta table may not exist yet on very first run
      const row = this._handle.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
        | { value: string }
        | undefined;
      return row ? row.value : null;
    } catch {
      return null;
    }
  }

  _getMeta(key: string) {
    const row = this._handle.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? row.value : null;
  }

  /** Public meta getter. */
  getMeta(key: string) {
    return this._getMeta(key);
  }

  /** Public meta setter. */
  setMeta(key: string, value: string | null) {
    this._setMeta(key, value);
  }

  _setMeta(key: string, value: string | null) {
    this._handle.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Bot State (key-value store for runtime operational state)
  // ═══════════════════════════════════════════════════════════════════════════

  /** Get a bot_state value by key. Returns null if not found. */
  getState(key: string) {
    const row = this._handle.prepare('SELECT value FROM bot_state WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row ? row.value : null;
  }

  /** Set a bot_state value. Creates or replaces. */
  setState(key: string, value: unknown): void {
    this._handle
      .prepare("INSERT OR REPLACE INTO bot_state (key, value, updated_at) VALUES (?, ?, datetime('now'))")
      .run(
        key,
        value != null
          ? typeof value === 'object'
            ? JSON.stringify(value)
            : String(value as string | number | boolean)
          : null,
      );
  }

  /** Get a bot_state value parsed as JSON. Returns defaultVal if not found or parse fails. */
  getStateJSON(key: string, defaultVal: unknown = null): unknown {
    const raw = this.getState(key);
    if (raw == null) return defaultVal;
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return defaultVal;
    }
  }

  /** Set a bot_state value as JSON. */
  setStateJSON(key: string, value: unknown) {
    this.setState(key, JSON.stringify(value));
  }

  /** Delete a bot_state key. */
  deleteState(key: string) {
    this._handle.prepare('DELETE FROM bot_state WHERE key = ?').run(key);
  }

  /** Get all bot_state entries. Returns array of { key, value, updated_at }. */
  getAllState() {
    return this._handle.prepare('SELECT key, value, updated_at FROM bot_state ORDER BY key').all();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Prepared statements
  // ═══════════════════════════════════════════════════════════════════════════

  _prepareStatements() {
    // Meta
    this._stmts.getMeta = this._handle.prepare('SELECT value FROM meta WHERE key = ?');
    this._stmts.setMeta = this._handle.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');

    // World state
    this._stmts.setWorldState = this._handle.prepare(
      "INSERT OR REPLACE INTO world_state (key, value, updated_at) VALUES (?, ?, datetime('now'))",
    );
    this._stmts.getWorldState = this._handle.prepare('SELECT value FROM world_state WHERE key = ?');
    this._stmts.getAllWorldState = this._handle.prepare('SELECT * FROM world_state');

    // Server settings
    this._stmts.upsertSetting = this._handle.prepare(
      "INSERT OR REPLACE INTO server_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))",
    );
    this._stmts.getSetting = this._handle.prepare('SELECT value FROM server_settings WHERE key = ?');
    this._stmts.getAllSettings = this._handle.prepare('SELECT * FROM server_settings ORDER BY key');

    // Snapshots
    this._stmts.insertSnapshot = this._handle.prepare('INSERT INTO snapshots (type, steam_id, data) VALUES (?, ?, ?)');
    this._stmts.getLatestSnapshot = this._handle.prepare(
      'SELECT * FROM snapshots WHERE type = ? AND steam_id = ? ORDER BY created_at DESC LIMIT 1',
    );
    this._stmts.purgeOldSnapshots = this._handle.prepare("DELETE FROM snapshots WHERE created_at < datetime('now', ?)");
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Player CRUD — delegation to PlayerRepository
  // ═══════════════════════════════════════════════════════════════════════════

  /** @deprecated Use `db.player.upsertPlayer(steamId, data)` instead. */
  upsertPlayer(steamId: string, data: Record<string, unknown>) {
    this.player.upsertPlayer(steamId, data);
  }
  /** @deprecated Use `db.player.getPlayer(steamId)` instead. */
  getPlayer(steamId: string) {
    return this.player.getPlayer(steamId);
  }
  /** @deprecated Use `db.player.getAllPlayers()` instead. */
  getAllPlayers(): DbRow[] {
    return this.player.getAllPlayers();
  }
  /** @deprecated Use `db.player.getOnlinePlayers()` instead. */
  getOnlinePlayers(): DbRow[] {
    return this.player.getOnlinePlayers();
  }
  /** @deprecated Use `db.player.getOnlinePlayersForDiff()` instead. */
  getOnlinePlayersForDiff() {
    return this.player.getOnlinePlayersForDiff();
  }
  /** @deprecated Use `db.player.setPlayerOnline(steamId, online)` instead. */
  setPlayerOnline(steamId: string, online: boolean) {
    this.player.setPlayerOnline(steamId, online);
  }
  /** @deprecated Use `db.player.setAllPlayersOffline()` instead. */
  setAllPlayersOffline() {
    this.player.setAllPlayersOffline();
  }
  /** @deprecated Use `db.player.updateKillTracker(steamId, killData)` instead. */
  updateKillTracker(steamId: string, killData: Record<string, unknown>) {
    this.player.updateKillTracker(steamId, killData);
  }
  /** @deprecated Use `db.player.updatePlayerName(steamId, name, nameHistory)` instead. */
  updatePlayerName(steamId: string, name: string, nameHistory: unknown[]) {
    this.player.updatePlayerName(steamId, name, nameHistory);
  }
  /** @deprecated Use `db.player.upsertFullLogStats(steamId, data)` instead. */
  upsertFullLogStats(steamId: string, data: Record<string, unknown>) {
    this.player.upsertFullLogStats(steamId, data);
  }
  /** @deprecated Use `db.player.getAllPlayerLogStats()` instead. */
  getAllPlayerLogStats(): DbRow[] {
    return this.player.getAllPlayerLogStats();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Player identity / alias resolution — delegation to PlayerRepository
  // ═══════════════════════════════════════════════════════════════════════════

  /** @deprecated Use `db.player.registerAlias(steamId, name, source)` instead. */
  registerAlias(steamId: string, name: string, source: string = '') {
    this.player.registerAlias(steamId, name, source);
  }
  /** @deprecated Use `db.player.importIdMap(entries)` instead. */
  importIdMap(entries: Array<{ steamId: string; name: string }>): void {
    this.player.importIdMap(entries);
  }
  /** @deprecated Use `db.player.importConnectLog(entries)` instead. */
  importConnectLog(entries: Array<{ steamId: string; name: string }>): void {
    this.player.importConnectLog(entries);
  }
  /** @deprecated Use `db.player.importFromSave(players)` instead. */
  importFromSave(players: Map<string, Record<string, unknown>>) {
    this.player.importFromSave(players);
  }
  /** @deprecated Use `db.player.resolveNameToSteamId(name)` instead. */
  resolveNameToSteamId(name: string) {
    return this.player.resolveNameToSteamId(name);
  }
  /** @deprecated Use `db.player.resolveSteamIdToName(steamId)` instead. */
  resolveSteamIdToName(steamId: string) {
    return this.player.resolveSteamIdToName(steamId);
  }
  /** @deprecated Use `db.player.getPlayerAliases(steamId)` instead. */
  getPlayerAliases(steamId: string) {
    return this.player.getPlayerAliases(steamId);
  }
  /** @deprecated Use `db.player.searchPlayersByName(query)` instead. */
  searchPlayersByName(query: string) {
    return this.player.searchPlayersByName(query);
  }
  /** @deprecated Use `db.player.getAliasStats()` instead. */
  getAliasStats() {
    return this.player.getAliasStats();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Leaderboards — delegation to LeaderboardRepository
  // ═══════════════════════════════════════════════════════════════════════════

  /** @deprecated Use `db.leaderboard.topKillers(limit)` instead. */
  topKillers(limit = 10) {
    return this.leaderboard.topKillers(limit);
  }
  /** @deprecated Use `db.leaderboard.topPlaytime(limit)` instead. */
  topPlaytime(limit = 10) {
    return this.leaderboard.topPlaytime(limit);
  }
  /** @deprecated Use `db.leaderboard.topSurvival(limit)` instead. */
  topSurvival(limit = 10) {
    return this.leaderboard.topSurvival(limit);
  }
  /** @deprecated Use `db.leaderboard.topFish(limit)` instead. */
  topFish(limit = 10) {
    return this.leaderboard.topFish(limit);
  }
  /** @deprecated Use `db.leaderboard.topBitten(limit)` instead. */
  topBitten(limit = 10) {
    return this.leaderboard.topBitten(limit);
  }
  /** @deprecated Use `db.leaderboard.topPvp(limit)` instead. */
  topPvp(limit = 10) {
    return this.leaderboard.topPvp(limit);
  }
  /** @deprecated Use `db.leaderboard.topBuilders(limit)` instead. */
  topBuilders(limit = 10) {
    return this.leaderboard.topBuilders(limit);
  }
  /** @deprecated Use `db.leaderboard.topDeaths(limit)` instead. */
  topDeaths(limit = 10) {
    return this.leaderboard.topDeaths(limit);
  }
  /** @deprecated Use `db.leaderboard.topLooters(limit)` instead. */
  topLooters(limit = 10) {
    return this.leaderboard.topLooters(limit);
  }
  /** @deprecated Use `db.leaderboard.getServerTotals()` instead. */
  getServerTotals() {
    return this.leaderboard.getServerTotals();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Clans — delegation to ClanRepository
  // ═══════════════════════════════════════════════════════════════════════════

  /** @deprecated Use `db.clan.upsertClan(name, members)` instead. */
  upsertClan(name: string, members: Array<Record<string, unknown>>) {
    this.clan.upsertClan(name, members);
  }
  /** @deprecated Use `db.clan.getAllClans()` instead. */
  getAllClans() {
    return this.clan.getAllClans();
  }
  /** @deprecated Use `db.clan.areClanmates(steamId1, steamId2)` instead. */
  areClanmates(steamId1: string, steamId2: string) {
    return this.clan.areClanmates(steamId1, steamId2);
  }
  /** @deprecated Use `db.clan.getClanForSteamId(steamId)` instead. */
  getClanForSteamId(steamId: string) {
    return this.clan.getClanForSteamId(steamId);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  World state
  // ═══════════════════════════════════════════════════════════════════════════

  setWorldState(key: string, value: unknown): void {
    const stored = value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value);
    this._stmts.setWorldState.run(key, stored);
  }
  getWorldState(key: string) {
    const r = this._stmts.getWorldState.get(key) as DbRow | undefined;
    return r ? r.value : null;
  }
  getAllWorldState() {
    const rows = this._stmts.getAllWorldState.all() as DbRow[];
    const result: Record<string, unknown> = {};
    for (const r of rows) result[r.key as string] = r.value;
    return result;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Structures — delegation to WorldObjectRepository
  // ═══════════════════════════════════════════════════════════════════════════

  /** @deprecated Use `db.worldObject.replaceStructures(structures)` instead. */
  replaceStructures(structures: Array<Record<string, unknown>>): void {
    this.worldObject.replaceStructures(structures);
  }
  /** @deprecated Use `db.worldObject.getStructures()` instead. */
  getStructures() {
    return this.worldObject.getStructures();
  }
  /** @deprecated Use `db.worldObject.getStructuresByOwner(steamId)` instead. */
  getStructuresByOwner(steamId: string) {
    return this.worldObject.getStructuresByOwner(steamId);
  }
  /** @deprecated Use `db.worldObject.getStructureCounts()` instead. */
  getStructureCounts() {
    return this.worldObject.getStructureCounts();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Vehicles — delegation to WorldObjectRepository
  // ═══════════════════════════════════════════════════════════════════════════

  /** @deprecated Use `db.worldObject.replaceVehicles(vehicles)` instead. */
  replaceVehicles(vehicles: Array<Record<string, unknown>>): void {
    this.worldObject.replaceVehicles(vehicles);
  }
  /** @deprecated Use `db.worldObject.getAllVehicles()` instead. */
  getAllVehicles() {
    return this.worldObject.getAllVehicles();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Companions — delegation to WorldObjectRepository
  // ═══════════════════════════════════════════════════════════════════════════

  /** @deprecated Use `db.worldObject.replaceCompanions(companions)` instead. */
  replaceCompanions(companions: Array<Record<string, unknown>>): void {
    this.worldObject.replaceCompanions(companions);
  }
  /** @deprecated Use `db.worldObject.getAllCompanions()` instead. */
  getAllCompanions() {
    return this.worldObject.getAllCompanions();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  World horses — delegation to WorldObjectRepository
  // ═══════════════════════════════════════════════════════════════════════════

  /** @deprecated Use `db.worldObject.replaceWorldHorses(horses)` instead. */
  replaceWorldHorses(horses: Array<Record<string, unknown>>): void {
    this.worldObject.replaceWorldHorses(horses);
  }
  /** @deprecated Use `db.worldObject.getAllWorldHorses()` instead. */
  getAllWorldHorses() {
    return this.worldObject.getAllWorldHorses();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Dead bodies — delegation to WorldObjectRepository
  // ═══════════════════════════════════════════════════════════════════════════

  /** @deprecated Use `db.worldObject.replaceDeadBodies(bodies)` instead. */
  replaceDeadBodies(bodies: Array<Record<string, unknown>>): void {
    this.worldObject.replaceDeadBodies(bodies);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Containers — delegation to WorldObjectRepository
  // ═══════════════════════════════════════════════════════════════════════════

  /** @deprecated Use `db.worldObject.replaceContainers(containers)` instead. */
  replaceContainers(containers: Array<Record<string, unknown>>): void {
    this.worldObject.replaceContainers(containers);
  }
  /** @deprecated Use `db.worldObject.getAllContainers()` instead. */
  getAllContainers() {
    return this.worldObject.getAllContainers();
  }
  /** @deprecated Use `db.worldObject.getContainersWithItems()` instead. */
  getContainersWithItems() {
    return this.worldObject.getContainersWithItems();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Loot actors — delegation to WorldObjectRepository
  // ═══════════════════════════════════════════════════════════════════════════

  /** @deprecated Use `db.worldObject.replaceLootActors(lootActors)` instead. */
  replaceLootActors(lootActors: Array<Record<string, unknown>>): void {
    this.worldObject.replaceLootActors(lootActors);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Item instances — delegation to ItemRepository
  // ═══════════════════════════════════════════════════════════════════════════

  /** @deprecated Use `db.item.markAllItemsLost()` instead. */
  markAllItemsLost() {
    this.item.markAllItemsLost();
  }
  /** @deprecated Use `db.item.findItemByFingerprint(fingerprint)` instead. */
  findItemByFingerprint(fingerprint: string) {
    return this.item.findItemByFingerprint(fingerprint);
  }
  /** @deprecated Use `db.item.findItemsByFingerprint(fingerprint)` instead. */
  findItemsByFingerprint(fingerprint: string) {
    return this.item.findItemsByFingerprint(fingerprint);
  }
  /** @deprecated Use `db.item.getItemInstance(id)` instead. */
  getItemInstance(id: number) {
    return this.item.getItemInstance(id);
  }
  /** @deprecated Use `db.item.getActiveItemInstances()` instead. */
  getActiveItemInstances() {
    return this.item.getActiveItemInstances();
  }
  /** @deprecated Use `db.item.getItemInstancesByItem(item)` instead. */
  getItemInstancesByItem(item: string) {
    return this.item.getItemInstancesByItem(item);
  }
  /** @deprecated Use `db.item.getItemInstancesByLocation(locationType, locationId)` instead. */
  getItemInstancesByLocation(locationType: string, locationId: string) {
    return this.item.getItemInstancesByLocation(locationType, locationId);
  }
  /** @deprecated Use `db.item.getItemInstanceCount()` instead. */
  getItemInstanceCount() {
    return this.item.getItemInstanceCount();
  }
  /** @deprecated Use `db.item.searchItemInstances(query, limit)` instead. */
  searchItemInstances(query: string, limit = 50) {
    return this.item.searchItemInstances(query, limit);
  }
  /** @deprecated Use `db.item.purgeOldLostItems(age)` instead. */
  purgeOldLostItems(age = '-30 days') {
    return this.item.purgeOldLostItems(age);
  }
  /** @deprecated Use `db.item.getItemInstancesByGroup(groupId)` instead. */
  getItemInstancesByGroup(groupId: number) {
    return this.item.getItemInstancesByGroup(groupId);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Item groups — delegation to ItemRepository
  // ═══════════════════════════════════════════════════════════════════════════

  /** @deprecated Use `db.item.updateItemGroupLocation(groupId, to)` instead. */
  updateItemGroupLocation(groupId: number, to: Record<string, unknown>) {
    this.item.updateItemGroupLocation(groupId, to);
  }
  /** @deprecated Use `db.item.markAllItemGroupsLost()` instead. */
  markAllItemGroupsLost() {
    this.item.markAllItemGroupsLost();
  }
  /** @deprecated Use `db.item.findActiveGroupByLocation(fingerprint, locationType, locationId, locationSlot)` instead. */
  findActiveGroupByLocation(fingerprint: string, locationType: string, locationId: string, locationSlot: string) {
    return this.item.findActiveGroupByLocation(fingerprint, locationType, locationId, locationSlot);
  }
  /** @deprecated Use `db.item.findActiveGroupsByFingerprint(fingerprint)` instead. */
  findActiveGroupsByFingerprint(fingerprint: string) {
    return this.item.findActiveGroupsByFingerprint(fingerprint);
  }
  /** @deprecated Use `db.item.getItemGroup(id)` instead. */
  getItemGroup(id: number) {
    return this.item.getItemGroup(id);
  }
  /** @deprecated Use `db.item.getActiveItemGroups()` instead. */
  getActiveItemGroups() {
    return this.item.getActiveItemGroups();
  }
  /** @deprecated Use `db.item.getItemGroupsByItem(item)` instead. */
  getItemGroupsByItem(item: string) {
    return this.item.getItemGroupsByItem(item);
  }
  /** @deprecated Use `db.item.getItemGroupsByLocation(locationType, locationId)` instead. */
  getItemGroupsByLocation(locationType: string, locationId: string) {
    return this.item.getItemGroupsByLocation(locationType, locationId);
  }
  /** @deprecated Use `db.item.getItemGroupCount()` instead. */
  getItemGroupCount() {
    return this.item.getItemGroupCount();
  }
  /** @deprecated Use `db.item.searchItemGroups(query, limit)` instead. */
  searchItemGroups(query: string, limit = 50) {
    return this.item.searchItemGroups(query, limit);
  }
  /** @deprecated Use `db.item.purgeOldLostGroups(age)` instead. */
  purgeOldLostGroups(age = '-30 days') {
    return this.item.purgeOldLostGroups(age);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Item movements — delegation to ItemRepository
  // ═══════════════════════════════════════════════════════════════════════════

  /** @deprecated Use `db.item.getItemMovements(instanceId)` instead. */
  getItemMovements(instanceId: number) {
    return this.item.getItemMovements(instanceId);
  }
  /** @deprecated Use `db.item.getItemMovementsByGroup(groupId)` instead. */
  getItemMovementsByGroup(groupId: number) {
    return this.item.getItemMovementsByGroup(groupId);
  }
  /** @deprecated Use `db.item.getRecentItemMovements(limit)` instead. */
  getRecentItemMovements(limit = 50) {
    return this.item.getRecentItemMovements(limit);
  }
  /** @deprecated Use `db.item.getItemMovementsByPlayer(steamId, limit)` instead. */
  getItemMovementsByPlayer(steamId: string, limit = 50) {
    return this.item.getItemMovementsByPlayer(steamId, limit);
  }
  /** @deprecated Use `db.item.getItemMovementsByLocation(locationType, locationId, limit)` instead. */
  getItemMovementsByLocation(locationType: string, locationId: string, limit = 50) {
    return this.item.getItemMovementsByLocation(locationType, locationId, limit);
  }
  /** @deprecated Use `db.item.purgeOldMovements(age)` instead. */
  purgeOldMovements(age = '-30 days') {
    return this.item.purgeOldMovements(age);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  World drops — delegation to WorldObjectRepository
  // ═══════════════════════════════════════════════════════════════════════════

  /** @deprecated Use `db.worldObject.replaceWorldDrops(drops)` instead. */
  replaceWorldDrops(drops: Array<Record<string, unknown>>): void {
    this.worldObject.replaceWorldDrops(drops);
  }
  /** @deprecated Use `db.worldObject.getAllWorldDrops()` instead. */
  getAllWorldDrops() {
    return this.worldObject.getAllWorldDrops();
  }
  /** @deprecated Use `db.worldObject.getWorldDropsByType(type)` instead. */
  getWorldDropsByType(type: string) {
    return this.worldObject.getWorldDropsByType(type);
  }
  /** @deprecated Use `db.worldObject.getWorldDropsWithItems()` instead. */
  getWorldDropsWithItems() {
    return this.worldObject.getWorldDropsWithItems();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Quests
  // ═══════════════════════════════════════════════════════════════════════════

  /** @deprecated Use `db.quest.replaceQuests(quests)` instead. */
  replaceQuests(quests: Array<Record<string, unknown>>): void {
    this.quest.replaceQuests(quests);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Server settings
  // ═══════════════════════════════════════════════════════════════════════════

  upsertSettings(settings: Record<string, string>): void {
    const upsert = this._handle.transaction((obj: Record<string, string>) => {
      for (const [key, value] of Object.entries(obj)) {
        this._stmts.upsertSetting.run(key, value);
      }
    });
    upsert(settings);
  }

  getSetting(key: string) {
    const r = this._stmts.getSetting.get(key) as DbRow | undefined;
    return r ? r.value : null;
  }
  getAllSettings() {
    const rows = this._stmts.getAllSettings.all() as DbRow[];
    const result: Record<string, unknown> = {};
    for (const r of rows) result[r.key as string] = r.value;
    return result;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Snapshots (for weekly/daily deltas)
  // ═══════════════════════════════════════════════════════════════════════════

  createSnapshot(type: string, steamId: string, data: Record<string, unknown>) {
    this._stmts.insertSnapshot.run(type, steamId, JSON.stringify(data));
  }

  getLatestSnapshot(type: string, steamId: string) {
    const row = this._stmts.getLatestSnapshot.get(type, steamId) as DbRow | undefined;
    return row ? { ...row, data: JSON.parse((row.data as string) || '{}') as unknown } : null;
  }

  purgeSnapshots(olderThan: string) {
    this._stmts.purgeOldSnapshots.run(olderThan);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Activity log — delegation to ActivityLogRepository
  // ═══════════════════════════════════════════════════════════════════════════

  /** @deprecated Use `db.activityLog.insertActivity(entry)` instead. */
  insertActivity(entry: Record<string, unknown>) {
    this.activityLog.insertActivity(entry);
  }
  /** @deprecated Use `db.activityLog.insertActivities(entries)` instead. */
  insertActivities(entries: Array<Record<string, unknown>>): void {
    this.activityLog.insertActivities(entries);
  }
  /** @deprecated Use `db.activityLog.insertActivitiesAt(entries)` instead. */
  insertActivitiesAt(entries: Array<Record<string, unknown>>): void {
    this.activityLog.insertActivitiesAt(entries);
  }
  /** @deprecated Use `db.activityLog.clearActivityLog()` instead. */
  clearActivityLog() {
    this.activityLog.clearActivityLog();
  }
  /** @deprecated Use `db.activityLog.getRecentActivity(limit, offset)` instead. */
  getRecentActivity(limit = 50, offset = 0) {
    return this.activityLog.getRecentActivity(limit, offset);
  }
  /** @deprecated Use `db.activityLog.getActivityByCategory(category, limit, offset)` instead. */
  getActivityByCategory(category: string, limit = 50, offset = 0) {
    return this.activityLog.getActivityByCategory(category, limit, offset);
  }
  /** @deprecated Use `db.activityLog.getActivityByActor(actor, limit, offset)` instead. */
  getActivityByActor(actor: string, limit = 50, offset = 0) {
    return this.activityLog.getActivityByActor(actor, limit, offset);
  }
  /** @deprecated Use `db.activityLog.getActivitySince(isoTimestamp)` instead. */
  getActivitySince(isoTimestamp: string) {
    return this.activityLog.getActivitySince(isoTimestamp);
  }
  /** @deprecated Use `db.activityLog.purgeOldActivity(olderThan)` instead. */
  purgeOldActivity(olderThan: string) {
    return this.activityLog.purgeOldActivity(olderThan);
  }
  /** @deprecated Use `db.activityLog.getActivityCount()` instead. */
  getActivityCount() {
    return this.activityLog.getActivityCount();
  }
  /** @deprecated Use `db.activityLog.getActivityCountBySource()` instead. */
  getActivityCountBySource() {
    return this.activityLog.getActivityCountBySource();
  }
  /** @deprecated Use `db.activityLog.getActivitySinceBySource(isoTimestamp, source)` instead. */
  getActivitySinceBySource(isoTimestamp: string, source: string) {
    return this.activityLog.getActivitySinceBySource(isoTimestamp, source);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Chat log — delegation to ChatLogRepository
  // ═══════════════════════════════════════════════════════════════════════════

  /** @deprecated Use `db.chatLog.insertChat(entry)` instead. */
  insertChat(entry: Record<string, unknown>) {
    this.chatLog.insertChat(entry);
  }
  /** @deprecated Use `db.chatLog.insertChatAt(entry)` instead. */
  insertChatAt(entry: Record<string, unknown>) {
    this.chatLog.insertChatAt(entry);
  }
  /** @deprecated Use `db.chatLog.getRecentChat(limit)` instead. */
  getRecentChat(limit = 50) {
    return this.chatLog.getRecentChat(limit);
  }
  /** @deprecated Use `db.chatLog.searchChat(query, limit)` instead. */
  searchChat(query: string, limit = 200) {
    return this.chatLog.searchChat(query, limit);
  }
  /** @deprecated Use `db.chatLog.getChatSince(isoTimestamp)` instead. */
  getChatSince(isoTimestamp: string) {
    return this.chatLog.getChatSince(isoTimestamp);
  }
  /** @deprecated Use `db.chatLog.clearChatLog()` instead. */
  clearChatLog() {
    this.chatLog.clearChatLog();
  }
  /** @deprecated Use `db.chatLog.purgeOldChat(olderThan)` instead. */
  purgeOldChat(olderThan: string) {
    return this.chatLog.purgeOldChat(olderThan);
  }
  /** @deprecated Use `db.chatLog.getChatCount()` instead. */
  getChatCount() {
    return this.chatLog.getChatCount();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Bulk operations (for save-to-DB sync)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Bulk-upsert all players from a parsed save file.
   * Runs in a single transaction for performance (~1ms for 50 players).
   * @param {Map<string, object>} players - steamId → parsed player data
   */
  bulkUpsertPlayers(players: Map<string, Record<string, unknown>>): void {
    this.transaction(() => {
      for (const [steamId, data] of players) {
        this.player.upsertPlayer(steamId, data);
      }
    });
  }

  /**
   * Full atomic save sync: replaces ALL world data in a single transaction.
   * This wraps syncFromSave + all replace* calls to prevent partial writes
   * on crash. Called by SaveService._poll() instead of individual methods.
   *
   * @param {object} data - { players, worldState, structures, vehicles, companions, clans,
   *                          deadBodies, containers, lootActors, quests, horses, worldDrops }
   */
  syncAllFromSave(data: Record<string, unknown>): void {
    this.transaction(() => {
      // Core entity sync (players, world state, structures, vehicles, companions, clans)
      this._syncFromSaveInner(data);

      // Auxiliary entity sync — all in the SAME transaction
      if (Array.isArray(data.deadBodies) && data.deadBodies.length > 0) {
        this.worldObject.innerReplaceDeadBodies(data.deadBodies as Array<Record<string, unknown>>);
      }
      if (Array.isArray(data.containers) && data.containers.length > 0) {
        this.worldObject.innerReplaceContainers(data.containers as Array<Record<string, unknown>>);
      }
      if (Array.isArray(data.lootActors) && data.lootActors.length > 0) {
        this.worldObject.innerReplaceLootActors(data.lootActors as Array<Record<string, unknown>>);
      }
      if (Array.isArray(data.quests) && data.quests.length > 0) {
        this.quest.innerReplaceQuests(data.quests as Array<Record<string, unknown>>);
      }
      if (Array.isArray(data.horses) && data.horses.length > 0) {
        this.worldObject.innerReplaceWorldHorses(data.horses as Array<Record<string, unknown>>);
      }
      if (Array.isArray(data.worldDrops) && data.worldDrops.length > 0) {
        this.worldObject.innerReplaceWorldDrops(data.worldDrops as Array<Record<string, unknown>>);
      }
    });
  }

  /**
   * Full save sync: replace all player data, structures, vehicles, etc.
   * Wraps in its own transaction when called standalone (backward compat).
   * When called from syncAllFromSave(), use _syncFromSaveInner() directly.
   */
  syncFromSave(parsed: Record<string, unknown>) {
    this.transaction(() => {
      this._syncFromSaveInner(parsed);
    });
  }

  /** Inner sync logic — no transaction wrapper, safe to call inside an outer transaction. */
  _syncFromSaveInner(parsed: Record<string, unknown>): void {
    // Players
    if (parsed.players) {
      const players = parsed.players as Map<string, Record<string, unknown>>;
      for (const [steamId, data] of players) {
        this.player.upsertPlayer(steamId, data);
      }
    }

    // World state
    if (parsed.worldState) {
      for (const [key, value] of Object.entries(parsed.worldState as Record<string, unknown>)) {
        const stored = value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value);
        this._stmts.setWorldState.run(key, stored);
      }
    }

    // Structures
    if (parsed.structures) {
      this.worldObject.innerReplaceStructures(parsed.structures as Array<Record<string, unknown>>);
    }

    // Vehicles
    if (parsed.vehicles) {
      this.worldObject.innerReplaceVehicles(parsed.vehicles as Array<Record<string, unknown>>);
    }

    // Companions
    if (parsed.companions) {
      this.worldObject.innerReplaceCompanions(parsed.companions as Array<Record<string, unknown>>);
    }

    // Clans
    if (parsed.clans) {
      for (const clan of parsed.clans as Array<Record<string, unknown>>) {
        this.clan.upsertClan(clan.name as string, clan.members as Array<Record<string, unknown>>);
      }
    }

    // Server settings
    if (parsed.serverSettings) {
      for (const [key, value] of Object.entries(parsed.serverSettings as Record<string, unknown>)) {
        this._stmts.upsertSetting.run(key, String(value));
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Game reference data seeding — delegation to GameDataRepository
  // ═══════════════════════════════════════════════════════════════════════════

  /** @deprecated Use `db.gameData.seedGameItems(items)` instead. */
  seedGameItems(items: Array<Record<string, unknown>>): void {
    this.gameData.seedGameItems(items);
  }
  /** @deprecated Use `db.gameData.getGameItem(id)` instead. */
  getGameItem(id: number) {
    return this.gameData.getGameItem(id);
  }
  /** @deprecated Use `db.gameData.searchGameItems(query)` instead. */
  searchGameItems(query: string) {
    return this.gameData.searchGameItems(query);
  }
  /** @deprecated Use `db.gameData.seedGameProfessions(professions)` instead. */
  seedGameProfessions(professions: Array<Record<string, unknown>>) {
    this.gameData.seedGameProfessions(professions);
  }
  /** @deprecated Use `db.gameData.seedGameAfflictions(afflictions)` instead. */
  seedGameAfflictions(afflictions: Array<Record<string, unknown>>) {
    this.gameData.seedGameAfflictions(afflictions);
  }
  /** @deprecated Use `db.gameData.seedGameSkills(skills)` instead. */
  seedGameSkills(skills: Array<Record<string, unknown>>) {
    this.gameData.seedGameSkills(skills);
  }
  /** @deprecated Use `db.gameData.seedGameChallenges(challenges)` instead. */
  seedGameChallenges(challenges: Array<Record<string, unknown>>) {
    this.gameData.seedGameChallenges(challenges);
  }
  /** @deprecated Use `db.gameData.seedLoadingTips(tips)` instead. */
  seedLoadingTips(tips: Array<Record<string, unknown> | string>): void {
    this.gameData.seedLoadingTips(tips);
  }
  /** @deprecated Use `db.gameData.getRandomTip()` instead. */
  getRandomTip() {
    return this.gameData.getRandomTip();
  }
  /** @deprecated Use `db.gameData.seedGameBuildings(buildings)` instead. */
  seedGameBuildings(buildings: Array<Record<string, unknown>>) {
    this.gameData.seedGameBuildings(buildings);
  }
  /** @deprecated Use `db.gameData.seedGameLootPools(lootTables)` instead. */
  seedGameLootPools(lootTables: Record<string, Record<string, unknown>>) {
    this.gameData.seedGameLootPools(lootTables);
  }
  /** @deprecated Use `db.gameData.seedGameVehiclesRef(vehicles)` instead. */
  seedGameVehiclesRef(vehicles: Array<Record<string, unknown>>) {
    this.gameData.seedGameVehiclesRef(vehicles);
  }
  /** @deprecated Use `db.gameData.seedGameAnimals(animals)` instead. */
  seedGameAnimals(animals: Array<Record<string, unknown>>) {
    this.gameData.seedGameAnimals(animals);
  }
  /** @deprecated Use `db.gameData.seedGameCrops(crops)` instead. */
  seedGameCrops(crops: Array<Record<string, unknown>>) {
    this.gameData.seedGameCrops(crops);
  }
  /** @deprecated Use `db.gameData.seedGameCarUpgrades(upgrades)` instead. */
  seedGameCarUpgrades(upgrades: Array<Record<string, unknown>>) {
    this.gameData.seedGameCarUpgrades(upgrades);
  }
  /** @deprecated Use `db.gameData.seedGameAmmoTypes(ammo)` instead. */
  seedGameAmmoTypes(ammo: Array<Record<string, unknown>>) {
    this.gameData.seedGameAmmoTypes(ammo);
  }
  /** @deprecated Use `db.gameData.seedGameRepairData(repairs)` instead. */
  seedGameRepairData(repairs: Array<Record<string, unknown>>) {
    this.gameData.seedGameRepairData(repairs);
  }
  /** @deprecated Use `db.gameData.seedGameFurniture(furniture)` instead. */
  seedGameFurniture(furniture: Array<Record<string, unknown>>) {
    this.gameData.seedGameFurniture(furniture);
  }
  /** @deprecated Use `db.gameData.seedGameTraps(traps)` instead. */
  seedGameTraps(traps: Array<Record<string, unknown>>) {
    this.gameData.seedGameTraps(traps);
  }
  /** @deprecated Use `db.gameData.seedGameSprays(sprays)` instead. */
  seedGameSprays(sprays: Array<Record<string, unknown>>) {
    this.gameData.seedGameSprays(sprays);
  }
  /** @deprecated Use `db.gameData.seedGameRecipes(recipes)` instead. */
  seedGameRecipes(recipes: Array<Record<string, unknown>>) {
    this.gameData.seedGameRecipes(recipes);
  }
  /** @deprecated Use `db.gameData.seedGameLore(lore)` instead. */
  seedGameLore(lore: Array<Record<string, unknown>>) {
    this.gameData.seedGameLore(lore);
  }
  /** @deprecated Use `db.gameData.seedGameQuests(quests)` instead. */
  seedGameQuests(quests: Array<Record<string, unknown>>) {
    this.gameData.seedGameQuests(quests);
  }
  /** @deprecated Use `db.gameData.seedGameSpawnLocations(spawns)` instead. */
  seedGameSpawnLocations(spawns: Array<Record<string, unknown>>) {
    this.gameData.seedGameSpawnLocations(spawns);
  }
  /** @deprecated Use `db.gameData.seedGameServerSettingDefs(settings)` instead. */
  seedGameServerSettingDefs(settings: Array<Record<string, unknown>>) {
    this.gameData.seedGameServerSettingDefs(settings);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Timeline — delegation to TimelineRepository
  // ═══════════════════════════════════════════════════════════════════════════

  /** @deprecated Use `db.timeline.insertTimelineSnapshot(data)` instead. */
  insertTimelineSnapshot(data: Record<string, unknown>): number {
    return this.timeline.insertTimelineSnapshot(data);
  }
  /** @deprecated Use `db.timeline.getTimelineSnapshots(limit)` instead. */
  getTimelineSnapshots(limit = 50): DbRow[] {
    return this.timeline.getTimelineSnapshots(limit);
  }
  /** @deprecated Use `db.timeline.getTimelineSnapshotRange(from, to)` instead. */
  getTimelineSnapshotRange(from: string, to: string): DbRow[] {
    return this.timeline.getTimelineSnapshotRange(from, to);
  }
  /** @deprecated Use `db.timeline.getTimelineSnapshotFull(snapshotId)` instead. */
  getTimelineSnapshotFull(snapshotId: number) {
    return this.timeline.getTimelineSnapshotFull(snapshotId);
  }
  /** @deprecated Use `db.timeline.getTimelineBounds()` instead. */
  getTimelineBounds() {
    return this.timeline.getTimelineBounds();
  }
  /** @deprecated Use `db.timeline.getPlayerPositionHistory(steamId, from, to)` instead. */
  getPlayerPositionHistory(steamId: string, from: string, to: string) {
    return this.timeline.getPlayerPositionHistory(steamId, from, to);
  }
  /** @deprecated Use `db.timeline.getAIPopulationHistory(from, to)` instead. */
  getAIPopulationHistory(from: string, to: string) {
    return this.timeline.getAIPopulationHistory(from, to);
  }
  /** @deprecated Use `db.timeline.purgeOldTimeline(olderThan)` instead. */
  purgeOldTimeline(olderThan: string = '-7 days') {
    return this.timeline.purgeOldTimeline(olderThan);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Death causes — delegation to DeathCauseRepository
  // ═══════════════════════════════════════════════════════════════════════════

  /** @deprecated Use `db.deathCause.insertDeathCause(data)` instead. */
  insertDeathCause(data: Record<string, unknown>): void {
    this.deathCause.insertDeathCause(data);
  }
  /** @deprecated Use `db.deathCause.getDeathCauses(limit)` instead. */
  getDeathCauses(limit = 50) {
    return this.deathCause.getDeathCauses(limit);
  }
  /** @deprecated Use `db.deathCause.getDeathCausesByPlayer(nameOrSteamId, limit)` instead. */
  getDeathCausesByPlayer(nameOrSteamId: string, limit = 50) {
    return this.deathCause.getDeathCausesByPlayer(nameOrSteamId, limit);
  }
  /** @deprecated Use `db.deathCause.getDeathCauseStats()` instead. */
  getDeathCauseStats() {
    return this.deathCause.getDeathCauseStats();
  }
  /** @deprecated Use `db.deathCause.getDeathCausesSince(since)` instead. */
  getDeathCausesSince(since: string) {
    return this.deathCause.getDeathCausesSince(since);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Anticheat — delegation to AntiCheatRepository
  // ═══════════════════════════════════════════════════════════════════════════

  /** @deprecated Use `db.antiCheat.insertAcFlag(input)` instead. */
  insertAcFlag(input: Record<string, unknown>): number | bigint {
    return this.antiCheat.insertAcFlag(input);
  }
  /** @deprecated Use `db.antiCheat.getAcFlags(status, limit)` instead. */
  getAcFlags(status: string = 'open', limit = 100) {
    return this.antiCheat.getAcFlags(status, limit);
  }
  /** @deprecated Use `db.antiCheat.getAcFlagsBySteam(steamId, limit)` instead. */
  getAcFlagsBySteam(steamId: string, limit = 100) {
    return this.antiCheat.getAcFlagsBySteam(steamId, limit);
  }
  /** @deprecated Use `db.antiCheat.getAcFlagsByDetector(detector, status, limit)` instead. */
  getAcFlagsByDetector(detector: string, status: string = 'open', limit = 100) {
    return this.antiCheat.getAcFlagsByDetector(detector, status, limit);
  }
  /** @deprecated Use `db.antiCheat.getAcFlagsSince(steamId, since)` instead. */
  getAcFlagsSince(steamId: string, since: string) {
    return this.antiCheat.getAcFlagsSince(steamId, since);
  }
  /** @deprecated Use `db.antiCheat.getAcFlagCount(steamId, sev1, sev2, status, since)` instead. */
  getAcFlagCount(steamId: string, sev1: string, sev2: string, status: string, since: string) {
    return this.antiCheat.getAcFlagCount(steamId, sev1, sev2, status, since);
  }
  /** @deprecated Use `db.antiCheat.updateAcFlagStatus(flagId, status, reviewedBy, notes)` instead. */
  updateAcFlagStatus(flagId: number, status: string, reviewedBy: string | null = null, notes: string | null = null) {
    this.antiCheat.updateAcFlagStatus(flagId, status, reviewedBy, notes);
  }
  /** @deprecated Use `db.antiCheat.escalateAcFlag(flagId, newSeverity)` instead. */
  escalateAcFlag(flagId: number, newSeverity: string) {
    this.antiCheat.escalateAcFlag(flagId, newSeverity);
  }
  /** @deprecated Use `db.antiCheat.upsertRiskScore(data)` instead. */
  upsertRiskScore(data: Record<string, unknown>): void {
    this.antiCheat.upsertRiskScore(data);
  }
  /** @deprecated Use `db.antiCheat.getRiskScore(steamId)` instead. */
  getRiskScore(steamId: string) {
    return this.antiCheat.getRiskScore(steamId);
  }
  /** @deprecated Use `db.antiCheat.getAllRiskScores()` instead. */
  getAllRiskScores() {
    return this.antiCheat.getAllRiskScores();
  }
  /** @deprecated Use `db.antiCheat.upsertFingerprint(fp)` instead. */
  upsertFingerprint(fp: Record<string, unknown>): void {
    this.antiCheat.upsertFingerprint(fp);
  }
  /** @deprecated Use `db.antiCheat.getFingerprint(entityType, entityId)` instead. */
  getFingerprint(entityType: string, entityId: string) {
    return this.antiCheat.getFingerprint(entityType, entityId);
  }
  /** @deprecated Use `db.antiCheat.getFingerprintsByType(entityType)` instead. */
  getFingerprintsByType(entityType: string) {
    return this.antiCheat.getFingerprintsByType(entityType);
  }
  /** @deprecated Use `db.antiCheat.insertFingerprintEvent(evt)` instead. */
  insertFingerprintEvent(evt: Record<string, unknown>): number | bigint {
    return this.antiCheat.insertFingerprintEvent(evt);
  }
  /** @deprecated Use `db.antiCheat.getFingerprintEvents(fingerprintId, limit)` instead. */
  getFingerprintEvents(fingerprintId: number, limit = 50) {
    return this.antiCheat.getFingerprintEvents(fingerprintId, limit);
  }
}

export default HumanitZDB;
export { HumanitZDB };

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
import { MetaRepository } from './repositories/meta-repository.js';
import { WorldStateRepository } from './repositories/world-state-repository.js';
import { BotStateRepository } from './repositories/bot-state-repository.js';
import { yieldToEventLoop } from '../utils/async.js';

const __dirname = getDirname(import.meta.url);
const DEFAULT_DB_PATH = path.join(__dirname, '..', '..', 'data', 'humanitz.db');
// Player upserts are independent rows, so save sync batches them to bound
// how long any single phase transaction can hold the event loop.
const SAVE_SYNC_PLAYER_BATCH_SIZE = 100;

const READ_ONLY_RAW_PRAGMAS = new Set([
  'table_info',
  'table_xinfo',
  'index_list',
  'index_info',
  'index_xinfo',
  'foreign_key_list',
  'database_list',
  'schema_version',
  'user_version',
  'integrity_check',
  'quick_check',
  'compile_options',
]);

class HumanitZDB {
  _dbPath: string;
  _memory: boolean;
  _log: Logger;
  private _db: Database.Database | null;

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
  private _metaRepo: MetaRepository | null = null;
  private _worldStateRepo: WorldStateRepository | null = null;
  private _botStateRepo: BotStateRepository | null = null;
  private _timelineRepo: TimelineRepository | null = null;
  private _gameDataRepo: GameDataRepository | null = null;
  private _questRepo: QuestRepository | null = null;

  constructor(options: { dbPath?: string; memory?: boolean; label?: string } = {}) {
    this._dbPath = options.dbPath ?? DEFAULT_DB_PATH;
    this._memory = options.memory ?? false;
    this._log = createLogger(options.label, 'DB');
    this._db = null;
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

  /** MetaRepository — schema metadata key-value store. */
  get meta(): MetaRepository {
    if (!this._metaRepo) throw new Error('Database not initialized — call init() first');
    return this._metaRepo;
  }

  /** WorldStateRepository — world state, server settings, and snapshots. */
  get worldState(): WorldStateRepository {
    if (!this._worldStateRepo) throw new Error('Database not initialized — call init() first');
    return this._worldStateRepo;
  }

  /** BotStateRepository — runtime operational state. */
  get botState(): BotStateRepository {
    if (!this._botStateRepo) throw new Error('Database not initialized — call init() first');
    return this._botStateRepo;
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

  /**
   * Controlled raw SQL escape hatch for admin/browser tooling.
   *
   * Prefer repository methods for domain reads/writes. Use this only for
   * bounded dynamic SQL surfaces where a repository cannot know the target
   * table/query shape ahead of time (for example the admin DB browser or the
   * local stdin SQL console). Every call must provide a `ctx` tag for audit
   * logging and future metrics.
   */
  rawQuery(
    sql: string,
    params: unknown[] | Record<string, unknown>,
    options: { ctx: string; mode?: 'all'; mutation?: false },
  ): Record<string, unknown>[];
  rawQuery(
    sql: string,
    params: unknown[] | Record<string, unknown>,
    options: { ctx: string; mode: 'get'; mutation?: false },
  ): Record<string, unknown> | undefined;
  rawQuery(
    sql: string,
    params: unknown[] | Record<string, unknown>,
    options: { ctx: string; mode: 'run'; mutation: true },
  ): Database.RunResult;
  rawQuery(
    sql: string,
    params: unknown[] | Record<string, unknown> = [],
    options: { ctx: string; mode?: 'all' | 'get' | 'run'; mutation?: boolean },
  ): Record<string, unknown>[] | Record<string, unknown> | Database.RunResult | undefined {
    const ctx = options.ctx.trim();
    if (!ctx) throw new Error('rawQuery requires a non-empty ctx');

    const mode = options.mode ?? 'all';
    const mutation = options.mutation === true;
    this._assertRawQueryAllowed(sql, mode, mutation);

    const stmt = this._handle.prepare(sql);
    const bind = (runner: (...values: unknown[]) => unknown): unknown => {
      if (Array.isArray(params)) return runner(...params);
      return runner(params);
    };

    if (mode === 'run') return bind(stmt.run.bind(stmt)) as Database.RunResult;
    if (mode === 'get') return bind(stmt.get.bind(stmt)) as Record<string, unknown> | undefined;
    return bind(stmt.all.bind(stmt)) as Record<string, unknown>[];
  }

  private _assertRawQueryAllowed(sql: string, mode: 'all' | 'get' | 'run', mutation: boolean): void {
    const stripped = sql
      .replace(/\/\*[^*]*(?:\*(?!\/)[^*]*)*\*\//g, '')
      .replace(/--[^\n]*/g, '')
      .trim();
    const upper = stripped.toUpperCase();

    if (mode === 'run' && !mutation) {
      throw new Error('rawQuery run mode requires mutation=true');
    }
    if (mutation) {
      if (mode !== 'run') throw new Error('rawQuery mutation=true requires run mode');
      return;
    }

    const isRead =
      upper.startsWith('SELECT') ||
      upper.startsWith('WITH') ||
      upper.startsWith('PRAGMA ') ||
      upper.startsWith('EXPLAIN');
    if (!isRead) {
      throw new Error('rawQuery read mode only allows SELECT/WITH/PRAGMA/EXPLAIN statements');
    }

    if (
      /\b(DROP|DELETE|INSERT|UPDATE|ALTER|CREATE|ATTACH|DETACH|REPLACE|VACUUM|ANALYZE|REINDEX|LOAD_EXTENSION)\b/i.test(
        stripped,
      )
    ) {
      throw new Error('rawQuery read mode rejected a statement containing mutation keywords');
    }
    if (upper.startsWith('PRAGMA')) {
      if (/\bPRAGMA\s+[\w.]+\s*=/i.test(stripped)) {
        throw new Error('rawQuery read mode rejected mutating PRAGMA assignment');
      }

      const match = stripped.match(/^PRAGMA\s+(?:(?:main|temp)\.)?([A-Za-z_][A-Za-z0-9_]*)\b/i);
      const pragmaName = match?.[1]?.toLowerCase();
      if (!pragmaName || !READ_ONLY_RAW_PRAGMAS.has(pragmaName)) {
        throw new Error(`rawQuery read mode rejected non-allowlisted PRAGMA: ${pragmaName ?? 'unknown'}`);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Lifecycle
  // ═══════════════════════════════════════════════════════════════════════════

  init(): void {
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
          this._log.info('Copied template DB as starting point');
        }
      }
    }

    this._db = new Database(this._memory ? ':memory:' : this._dbPath);
    this._handle.pragma('journal_mode = WAL');
    this._handle.pragma('synchronous = NORMAL');
    this._handle.pragma('foreign_keys = ON');
    this._handle.pragma('busy_timeout = 5000');
    this._handle.pragma('temp_store = MEMORY');
    this._handle.pragma('cache_size = -16000'); // negative = KiB, i.e. 16 MiB page cache
    this._handle.pragma('mmap_size = 268435456'); // 256 MiB

    this._applySchema();

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
    this._metaRepo = new MetaRepository(this._handle, this._log.label);
    this._worldStateRepo = new WorldStateRepository(this._handle, this._log.label);
    this._botStateRepo = new BotStateRepository(this._handle, this._log.label);

    const version = this._getMeta('schema_version');
    this._log.info(`Database ready (v${version}, ${this._memory ? 'in-memory' : this._dbPath})`);
  }

  close(): void {
    if (this._db) {
      this._db.close();
      this._db = null;
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
      this._metaRepo = null;
      this._worldStateRepo = null;
      this._botStateRepo = null;
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
        try {
          this._handle.exec(
            'CREATE INDEX IF NOT EXISTS idx_activity_recent_dedupe ON activity_log(type, steam_id, source, created_at DESC, id DESC)',
          );
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

      // v15 → v16: item tracker purge indexes for FK-safe retention cleanup
      if (fromVersion < 16) {
        this._handle.exec(`
          CREATE INDEX IF NOT EXISTS idx_item_inst_lost_at ON item_instances(lost, lost_at);
          CREATE INDEX IF NOT EXISTS idx_item_grp_lost_at ON item_groups(lost, lost_at);
          CREATE INDEX IF NOT EXISTS idx_item_mov_instance ON item_movements(instance_id);
          CREATE INDEX IF NOT EXISTS idx_item_mov_group ON item_movements(group_id);
        `);
        this._log.info('Migration v15→v16: item tracker purge indexes');
      }

      // v16 → v17: activity recent dedupe composite index
      if (fromVersion < 17) {
        this._handle.exec(`
          CREATE INDEX IF NOT EXISTS idx_activity_recent_dedupe ON activity_log(type, steam_id, source, created_at DESC, id DESC);
        `);
        this._log.info('Migration v16→v17: activity recent dedupe index');
      }

      // v17 → v18: item tracker paginated panel indexes
      if (fromVersion < 18) {
        this._handle.exec(`
          CREATE INDEX IF NOT EXISTS idx_item_inst_active_sort ON item_instances(lost, item, location_type, id);
          CREATE INDEX IF NOT EXISTS idx_item_inst_active_location_sort ON item_instances(lost, location_type, location_id, item, id);
          CREATE INDEX IF NOT EXISTS idx_item_grp_active_sort ON item_groups(lost, item, location_type, id);
          CREATE INDEX IF NOT EXISTS idx_item_grp_active_location_sort ON item_groups(lost, location_type, location_id, item, id);
        `);
        this._log.info('Migration v17→v18: item tracker paginated panel indexes');
      }

      // v18 → v20: replace partial sort indexes with composite indexes SQLite reliably uses for ORDER BY
      if (fromVersion < 20) {
        this._handle.exec(`
          DROP INDEX IF EXISTS idx_item_inst_active_sort;
          DROP INDEX IF EXISTS idx_item_inst_active_location_sort;
          DROP INDEX IF EXISTS idx_item_grp_active_sort;
          DROP INDEX IF EXISTS idx_item_grp_active_location_sort;
          CREATE INDEX IF NOT EXISTS idx_item_inst_active_sort ON item_instances(lost, item, location_type, id);
          CREATE INDEX IF NOT EXISTS idx_item_inst_active_location_sort ON item_instances(lost, location_type, location_id, item, id);
          CREATE INDEX IF NOT EXISTS idx_item_grp_active_sort ON item_groups(lost, item, location_type, id);
          CREATE INDEX IF NOT EXISTS idx_item_grp_active_location_sort ON item_groups(lost, location_type, location_id, item, id);
        `);
        this._log.info('Migration v18→v20: item tracker paginated panel composite indexes');
      }

      // v20 → v21: save-backed player marker + latest full player snapshot details
      if (fromVersion < 21) {
        // Conservative backfill policy: legacy rows may contain old default vitals,
        // but only a current cache.players sync proves a row is save-backed.
        // Keep has_save_snapshot=0 until the next successful save snapshot upsert.
        this._ensureSaveSnapshotSchema();
        this._log.info(
          'Migration v20→v21: added player_details and save snapshot markers; legacy rows remain unmarked until next cache.players sync',
        );
      }

      // v21 → v22: partial pos_x indexes for the positioned world object map queries
      if (fromVersion < 22) {
        this._handle.exec(`
          CREATE INDEX IF NOT EXISTS idx_structures_pos ON structures(pos_x) WHERE pos_x IS NOT NULL;
          CREATE INDEX IF NOT EXISTS idx_vehicles_pos ON vehicles(pos_x) WHERE pos_x IS NOT NULL;
          CREATE INDEX IF NOT EXISTS idx_companions_pos ON companions(pos_x) WHERE pos_x IS NOT NULL;
          CREATE INDEX IF NOT EXISTS idx_dead_bodies_pos ON dead_bodies(pos_x) WHERE pos_x IS NOT NULL;
          CREATE INDEX IF NOT EXISTS idx_containers_pos ON containers(pos_x) WHERE pos_x IS NOT NULL AND pos_x != 0;
        `);
        this._log.info('Migration v21→v22: partial pos_x indexes for positioned world object queries');
      }

      this._ensureItemMovementsInstanceIdNullable();
      this._setMeta('schema_version', String(SCHEMA_VERSION));
      this._handle.exec('COMMIT');
      this._log.info(`Schema migrated to v${SCHEMA_VERSION}`);
    } else {
      this._ensureItemMovementsInstanceIdNullable();
    }

    const repairedSaveSnapshotSchema = this._ensureSaveSnapshotSchema();
    if (repairedSaveSnapshotSchema) {
      this._log.info('Schema repair: ensured player_details and save snapshot marker columns');
    }
  }

  _ensureSaveSnapshotSchema(): boolean {
    let changed = false;
    const playerColumns = new Set(
      (this._handle.prepare('PRAGMA table_info(players)').all() as Array<{ name: string }>).map((row) => row.name),
    );

    if (!playerColumns.has('has_save_snapshot')) {
      this._handle.exec('ALTER TABLE players ADD COLUMN has_save_snapshot INTEGER DEFAULT 0');
      changed = true;
    }
    if (!playerColumns.has('last_save_snapshot_at')) {
      this._handle.exec('ALTER TABLE players ADD COLUMN last_save_snapshot_at TEXT');
      changed = true;
    }

    const detailTable = this._handle
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='player_details'")
      .get();
    if (!detailTable) {
      changed = true;
    }
    this._handle.exec(`
      CREATE TABLE IF NOT EXISTS player_details (
        steam_id          TEXT PRIMARY KEY REFERENCES players(steam_id) ON DELETE CASCADE,
        snapshot_json     TEXT NOT NULL DEFAULT '{}',
        source_file       TEXT,
        source_mtime_ms   REAL,
        source_size       INTEGER,
        cache_version     INTEGER,
        agent_version     INTEGER,
        parser_signature  TEXT,
        updated_at        TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_player_details_updated ON player_details(updated_at);
    `);

    return changed;
  }

  _ensureItemMovementsInstanceIdNullable() {
    const rebuildIfNeeded = () => {
      const exists = this._handle
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'item_movements'")
        .get();
      if (!exists) return;

      const columns = this._handle.prepare('PRAGMA table_info(item_movements)').all() as Array<{
        name: string;
        notnull: number;
      }>;
      const instanceId = columns.find((column) => column.name === 'instance_id');
      if (!instanceId || instanceId.notnull === 0) return;

      const columnNames = new Set(columns.map((column) => column.name));
      if (!columnNames.has('group_id')) {
        this._handle.exec('ALTER TABLE item_movements ADD COLUMN group_id INTEGER DEFAULT NULL');
      }
      if (!columnNames.has('move_type')) {
        this._handle.exec("ALTER TABLE item_movements ADD COLUMN move_type TEXT DEFAULT 'move'");
      }

      this._handle.exec(`
        ALTER TABLE item_movements RENAME TO item_movements_legacy_instance_notnull;

        DROP INDEX IF EXISTS idx_item_mov_instance;
        DROP INDEX IF EXISTS idx_item_mov_group;
        DROP INDEX IF EXISTS idx_item_mov_item;
        DROP INDEX IF EXISTS idx_item_mov_created;
        DROP INDEX IF EXISTS idx_item_mov_attributed;

        CREATE TABLE item_movements (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          instance_id     INTEGER REFERENCES item_instances(id),
          group_id        INTEGER REFERENCES item_groups(id),
          move_type       TEXT DEFAULT 'move',
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

        INSERT INTO item_movements (
          id, instance_id, group_id, move_type, item, from_type, from_id, from_slot, to_type, to_id, to_slot,
          amount, attributed_steam_id, attributed_name, pos_x, pos_y, pos_z, created_at
        )
        SELECT
          id, instance_id, group_id, COALESCE(move_type, 'move'), item,
          COALESCE(from_type, ''), COALESCE(from_id, ''), COALESCE(from_slot, ''),
          to_type, to_id, COALESCE(to_slot, ''), COALESCE(amount, 1),
          COALESCE(attributed_steam_id, ''), COALESCE(attributed_name, ''),
          pos_x, pos_y, pos_z, COALESCE(created_at, datetime('now'))
        FROM item_movements_legacy_instance_notnull;

        DROP TABLE item_movements_legacy_instance_notnull;

        CREATE INDEX IF NOT EXISTS idx_item_mov_instance ON item_movements(instance_id);
        CREATE INDEX IF NOT EXISTS idx_item_mov_group ON item_movements(group_id);
        CREATE INDEX IF NOT EXISTS idx_item_mov_item ON item_movements(item);
        CREATE INDEX IF NOT EXISTS idx_item_mov_created ON item_movements(created_at);
        CREATE INDEX IF NOT EXISTS idx_item_mov_attributed ON item_movements(attributed_steam_id);
      `);

      this._log.info('Rebuilt legacy item_movements table with nullable instance_id');
    };

    if (this._handle.inTransaction) {
      rebuildIfNeeded();
    } else {
      this._handle.transaction(rebuildIfNeeded)();
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
  //  Save sync (cross-repository orchestration)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Full save sync, split into one transaction per table (or per player batch)
   * with an event-loop yield between phases. better-sqlite3 is synchronous, so
   * a single giant transaction would block Discord heartbeats, RCON, and web
   * requests for the whole sync; phased commits keep each block short.
   *
   * Each table is still cleared and rebuilt atomically — readers never see an
   * empty-but-unfilled table — but a reader between phases may briefly observe
   * a cross-table mix of old and new data (acceptable for dashboard reads).
   * Called by SaveSyncPipeline instead of individual replace* methods.
   *
   * @param {object} data - { players, worldState, structures, vehicles, companions, clans,
   *                          deadBodies, containers, lootActors, quests, horses, worldDrops }
   */
  async syncAllFromSave(data: Record<string, unknown>): Promise<void> {
    const phases: Array<() => void> = [];

    if (data.players) {
      const players = data.players as Map<string, Record<string, unknown>>;
      const playerSources =
        data.playerSources instanceof Map
          ? (data.playerSources as Map<string, Record<string, unknown>>)
          : new Map<string, Record<string, unknown>>();
      const entries = [...players];
      for (let start = 0; start < entries.length; start += SAVE_SYNC_PLAYER_BATCH_SIZE) {
        const batch = entries.slice(start, start + SAVE_SYNC_PLAYER_BATCH_SIZE);
        phases.push(() => {
          for (const [steamId, playerData] of batch) {
            const source = playerSources.get(steamId);
            this.player.upsertPlayer(steamId, source ? { ...playerData, __saveSource: source } : playerData);
          }
        });
      }
    }

    if (data.worldState) {
      phases.push(() => {
        for (const [key, value] of Object.entries(data.worldState as Record<string, unknown>)) {
          this.worldState.innerSetWorldState(key, value);
        }
      });
    }

    if (data.structures) {
      phases.push(() => {
        this.worldObject.innerReplaceStructures(data.structures as Array<Record<string, unknown>>);
      });
    }

    if (data.vehicles) {
      phases.push(() => {
        this.worldObject.innerReplaceVehicles(data.vehicles as Array<Record<string, unknown>>);
      });
    }

    if (data.companions) {
      phases.push(() => {
        this.worldObject.innerReplaceCompanions(data.companions as Array<Record<string, unknown>>);
      });
    }

    if (data.clans) {
      phases.push(() => {
        for (const clan of data.clans as Array<Record<string, unknown>>) {
          this.clan.upsertClan(clan.name as string, clan.members as Array<Record<string, unknown>>);
        }
      });
    }

    if (data.serverSettings) {
      phases.push(() => {
        for (const [key, value] of Object.entries(data.serverSettings as Record<string, unknown>)) {
          this.worldState.innerUpsertSetting(key, String(value));
        }
      });
    }

    if (Array.isArray(data.deadBodies) && data.deadBodies.length > 0) {
      phases.push(() => {
        this.worldObject.innerReplaceDeadBodies(data.deadBodies as Array<Record<string, unknown>>);
      });
    }
    if (Array.isArray(data.containers) && data.containers.length > 0) {
      phases.push(() => {
        this.worldObject.innerReplaceContainers(data.containers as Array<Record<string, unknown>>);
      });
    }
    if (Array.isArray(data.lootActors) && data.lootActors.length > 0) {
      phases.push(() => {
        this.worldObject.innerReplaceLootActors(data.lootActors as Array<Record<string, unknown>>);
      });
    }
    if (Array.isArray(data.quests) && data.quests.length > 0) {
      phases.push(() => {
        this.quest.innerReplaceQuests(data.quests as Array<Record<string, unknown>>);
      });
    }
    if (Array.isArray(data.horses) && data.horses.length > 0) {
      phases.push(() => {
        this.worldObject.innerReplaceWorldHorses(data.horses as Array<Record<string, unknown>>);
      });
    }
    if (Array.isArray(data.worldDrops) && data.worldDrops.length > 0) {
      phases.push(() => {
        this.worldObject.innerReplaceWorldDrops(data.worldDrops as Array<Record<string, unknown>>);
      });
    }

    for (let i = 0; i < phases.length; i++) {
      if (i > 0) await yieldToEventLoop();
      const phase = phases[i];
      if (phase) this.transaction(phase);
    }
  }

  /**
   * Legacy core-entity sync: players, world state, structures, vehicles,
   * companions, clans, and server settings — auxiliary world objects
   * (dead bodies, containers, loot actors, quests, horses, world drops) are
   * only synced by syncAllFromSave(). Single-transaction variant kept for
   * standalone callers (currently tests only); the polling path uses the
   * phased syncAllFromSave() instead.
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
      const playerSources =
        parsed.playerSources instanceof Map
          ? (parsed.playerSources as Map<string, Record<string, unknown>>)
          : new Map<string, Record<string, unknown>>();
      for (const [steamId, data] of players) {
        const source = playerSources.get(steamId);
        this.player.upsertPlayer(steamId, source ? { ...data, __saveSource: source } : data);
      }
    }

    // World state
    if (parsed.worldState) {
      for (const [key, value] of Object.entries(parsed.worldState as Record<string, unknown>)) {
        this.worldState.innerSetWorldState(key, value);
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
        this.worldState.innerUpsertSetting(key, String(value));
      }
    }
  }
}

export default HumanitZDB;
export { HumanitZDB };

'use strict';

/**
 * Interactive stdin console for managing the bot on headless hosts (e.g. Bisect).
 *
 * Reads commands from process.stdin and prints results to stdout.
 * Designed for hosts where the only interface is the process console —
 * no SSH, no web panel, just stdin/stdout.
 *
 * All commands are read-only by default. Write operations (state.set, state.delete)
 * are gated behind an explicit flag.
 *
 * Usage:
 *   const StdinConsole = require('./stdin-console');
 *   const console = new StdinConsole({ db, rcon });
 *   console.start();
 *   // ...on shutdown:
 *   console.stop();
 */

import readline from 'node:readline';
import type { HumanitZDB } from './db/database.js';
import { errMsg } from './utils/error.js';

/** Generic row shape from DB queries. */
type DbRow = Record<string, unknown>;

/** Safely coerce a DB field to string. */
function s(val: unknown, fallback = ''): string {
  if (val == null) return fallback;
  if (typeof val === 'string') return val;
  if (typeof val === 'number' || typeof val === 'boolean' || typeof val === 'bigint') return `${val}`;
  return JSON.stringify(val);
}

/** Safely coerce a DB field to number. */
function n(val: unknown, fallback = 0): number {
  if (val == null) return fallback;
  const num = Number(val);
  return isNaN(num) ? fallback : num;
}

class StdinConsole {
  private _db: HumanitZDB | null;
  private _writable: boolean;
  private _rl: readline.Interface | null;
  private _started: boolean;

  /**
   * @param opts.db       - HumanitZDB instance
   * @param opts.writable - Allow write operations
   */
  constructor({ db, writable = false }: { db?: HumanitZDB | null; writable?: boolean } = {}) {
    this._db = db ?? null;
    this._writable = writable;
    this._rl = null;
    this._started = false;
  }

  start(): void {
    if (this._started) return;
    // Don't start if stdin is not a TTY and not piped (e.g. running under systemd without stdin)
    if (!process.stdin.readable) return;

    this._started = true;
    this._rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: 'bot> ',
      terminal: process.stdin.isTTY || false,
    });

    // Only show prompt on interactive terminals
    if (process.stdin.isTTY) {
      console.log('[CONSOLE] Interactive console ready. Type "help" for commands.');
      this._rl.prompt();
    }

    this._rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        this._prompt();
        return;
      }

      try {
        this._dispatch(trimmed);
      } catch (err: unknown) {
        this._print(`Error: ${errMsg(err)}`);
      }
      this._prompt();
    });

    this._rl.on('close', () => {
      this._started = false;
    });
  }

  stop(): void {
    if (this._rl) {
      this._rl.close();
      this._rl = null;
    }
    this._started = false;
  }

  private _prompt(): void {
    if (this._rl && process.stdin.isTTY) this._rl.prompt();
  }

  private _print(text: string): void {
    // Use raw stdout to avoid timestamped console.log prefix
    process.stdout.write(text + '\n');
  }

  // ── Command dispatch ──────────────────────────────────────

  private _dispatch(input: string): void {
    const parts = input.split(/\s+/);
    const cmd = (parts[0] ?? '').toLowerCase();
    const args = parts.slice(1);

    switch (cmd) {
      case 'help': {
        this._cmdHelp();
        return;
      }
      case 'players': {
        this._cmdPlayers(args);
        return;
      }
      case 'player': {
        this._cmdPlayer(args);
        return;
      }
      case 'online': {
        this._cmdOnline();
        return;
      }
      case 'search': {
        this._cmdSearch(args);
        return;
      }
      case 'activity': {
        this._cmdActivity(args);
        return;
      }
      case 'chat': {
        this._cmdChat(args);
        return;
      }
      case 'state': {
        this._cmdState(args);
        return;
      }
      case 'state.get': {
        this._cmdStateGet(args);
        return;
      }
      case 'state.set': {
        this._cmdStateSet(args);
        return;
      }
      case 'state.delete': {
        this._cmdStateDelete(args);
        return;
      }
      case 'state.list': {
        this._cmdStateList();
        return;
      }
      case 'stats': {
        this._cmdStats();
        return;
      }
      case 'tables': {
        this._cmdTables();
        return;
      }
      case 'sql': {
        this._cmdSql(args, input);
        return;
      }
      case 'world': {
        this._cmdWorld();
        return;
      }
      case 'clans': {
        this._cmdClans();
        return;
      }
      case 'vehicles': {
        this._cmdVehicles();
        return;
      }
      default:
        this._print(`Unknown command: ${cmd}. Type "help" for available commands.`);
    }
  }

  // ── Commands ──────────────────────────────────────────────

  private _cmdHelp(): void {
    this._print(
      `
Available commands:
  help                  Show this help
  players [limit]       List all players (default: 20)
  player <steamId>      Show detailed player info
  online                Show currently online players
  search <name>         Search players by name
  activity [limit]      Show recent activity log (default: 10)
  chat [limit]          Show recent chat messages (default: 10)
  stats                 Show database statistics (row counts)
  tables                List all database tables
  world                 Show world state
  clans                 Show all clans
  vehicles              Show all vehicles
  sql <query>           Run a read-only SQL query
  state.list            List all bot_state keys
  state.get <key>       Get a bot_state value
  state.set <key> <val> Set a bot_state value (requires --writable)
  state.delete <key>    Delete a bot_state key (requires --writable)
`.trim(),
    );
  }

  private _cmdPlayers(args: string[]): void {
    if (!this._db) {
      this._print('No database available.');
      return;
    }
    const limit = parseInt(args[0] ?? '', 10) || 20;
    const players = this._db.getAllPlayers() as DbRow[];
    const sorted = players.sort((a, b) => (s(b.last_seen, s(b.updated_at)) > s(a.last_seen, s(a.updated_at)) ? 1 : -1));
    const slice = sorted.slice(0, limit);

    if (slice.length === 0) {
      this._print('No players found.');
      return;
    }

    this._print(`Players (${slice.length}/${players.length}):`);
    const header = `${'SteamID'.padEnd(20)} ${'Name'.padEnd(24)} ${'Kills'.padStart(6)} ${'Level'.padStart(5)} ${'Last Seen'.padEnd(20)}`;
    this._print(header);
    this._print('-'.repeat(header.length));
    for (const p of slice) {
      const name = s(p.name, 'Unknown').slice(0, 23);
      const kills = String(n(p.zeeks_killed));
      const level = String(n(p.level));
      const seen = s(p.last_seen, s(p.updated_at, '-'));
      this._print(
        `${s(p.steam_id).padEnd(20)} ${name.padEnd(24)} ${kills.padStart(6)} ${level.padStart(5)} ${seen.slice(0, 20).padEnd(20)}`,
      );
    }
  }

  private _cmdPlayer(args: string[]): void {
    if (!this._db) {
      this._print('No database available.');
      return;
    }
    if (args.length === 0) {
      this._print('Usage: player <steamId>');
      return;
    }
    const steamId = args[0] ?? '';
    const p = this._db.getPlayer(steamId) as DbRow | null;
    if (!p) {
      this._print(`Player not found: ${steamId}`);
      return;
    }

    this._print(`Player: ${s(p.name, 'Unknown')}`);
    this._print(`  Steam ID:    ${s(p.steam_id)}`);
    this._print(`  Level:       ${String(n(p.level))}`);
    this._print(`  Kills:       ${String(n(p.zeeks_killed))}`);
    this._print(`  Headshots:   ${String(n(p.headshots))}`);
    this._print(`  Days Surv:   ${String(n(p.days_survived))}`);
    this._print(`  Health:      ${String(n(p.health))} / ${String(n(p.max_health))}`);
    this._print(`  Hunger:      ${String(n(p.hunger))}`);
    this._print(`  Thirst:      ${String(n(p.thirst))}`);
    this._print(`  Infection:   ${String(n(p.infection))}`);
    this._print(`  Online:      ${p.online ? 'Yes' : 'No'}`);
    this._print(`  Last Seen:   ${s(p.last_seen, '-')}`);
    this._print(`  Updated:     ${s(p.updated_at, '-')}`);

    // Aliases
    try {
      const aliases = this._db.getPlayerAliases(steamId) as DbRow[];
      if (aliases.length > 0) {
        this._print(`  Aliases:     ${aliases.map((a) => s(a.name, s(a.player_name))).join(', ')}`);
      }
    } catch {
      /* alias table may not exist */
    }
  }

  private _cmdOnline(): void {
    if (!this._db) {
      this._print('No database available.');
      return;
    }
    const players = this._db.getOnlinePlayers() as DbRow[];
    if (players.length === 0) {
      this._print('No players online.');
      return;
    }

    this._print(`Online players (${players.length}):`);
    for (const p of players) {
      this._print(`  ${s(p.steamId, s(p.steam_id)).padEnd(20)} ${s(p.name, s(p.player_name, 'Unknown'))}`);
    }
  }

  private _cmdSearch(args: string[]): void {
    if (!this._db) {
      this._print('No database available.');
      return;
    }
    if (args.length === 0) {
      this._print('Usage: search <name>');
      return;
    }
    const query = args.join(' ');

    try {
      const results = this._db.searchPlayersByName(query) as DbRow[];
      if (results.length === 0) {
        this._print(`No players found matching "${query}".`);
        return;
      }

      this._print(`Search results for "${query}" (${results.length}):`);
      for (const p of results) {
        this._print(`  ${s(p.steam_id).padEnd(20)} ${s(p.name, s(p.player_name, 'Unknown'))}`);
      }
    } catch {
      this._print(`Search failed. Try: sql SELECT steam_id, name FROM players WHERE name LIKE '%${query}%'`);
    }
  }

  private _cmdActivity(args: string[]): void {
    if (!this._db) {
      this._print('No database available.');
      return;
    }
    const limit = parseInt(args[0] ?? '', 10) || 10;

    try {
      const rows = this._db.getRecentActivity(limit) as DbRow[];
      if (rows.length === 0) {
        this._print('No activity found.');
        return;
      }

      this._print(`Recent activity (${rows.length}):`);
      for (const r of rows) {
        const ts = s(r.timestamp, s(r.created_at));
        const type = s(r.type, s(r.event_type, '?'));
        const actor = s(r.playerName, s(r.player_name, s(r.actor, '-')));
        const detail = s(r.details, s(r.detail, s(r.message)));
        this._print(`  [${ts.slice(0, 19)}] ${type.padEnd(22)} ${actor.padEnd(20)} ${detail.slice(0, 60)}`);
      }
    } catch (err: unknown) {
      this._print(`Activity query failed: ${errMsg(err)}`);
    }
  }

  private _cmdChat(args: string[]): void {
    if (!this._db) {
      this._print('No database available.');
      return;
    }
    const limit = parseInt(args[0] ?? '', 10) || 10;

    try {
      const rows = this._db.getRecentChat(limit) as DbRow[];
      if (rows.length === 0) {
        this._print('No chat messages found.');
        return;
      }

      this._print(`Recent chat (${rows.length}):`);
      for (const r of rows) {
        const ts = s(r.timestamp, s(r.created_at));
        const dir = r.direction === 'outbound' ? '→' : '←';
        const name = s(r.player_name, s(r.playerName, s(r.discord_user, '?')));
        const msg = s(r.message);
        this._print(`  [${ts.slice(0, 19)}] ${dir} ${name.padEnd(20)} ${msg.slice(0, 80)}`);
      }
    } catch (err: unknown) {
      this._print(`Chat query failed: ${errMsg(err)}`);
    }
  }

  private _cmdState(args: string[]): void {
    // "state" alone → list, "state <key>" → get
    if (args.length === 0) {
      this._cmdStateList();
      return;
    }
    this._cmdStateGet(args);
  }

  private _cmdStateList(): void {
    if (!this._db) {
      this._print('No database available.');
      return;
    }
    try {
      const rows = this._db.getAllState() as DbRow[];
      if (rows.length === 0) {
        this._print('No bot_state entries.');
        return;
      }

      this._print(`bot_state entries (${rows.length}):`);
      for (const r of rows) {
        const val = s(r.value).slice(0, 80);
        this._print(`  ${s(r.key).padEnd(30)} ${val}`);
      }
    } catch (err: unknown) {
      this._print(`State query failed: ${errMsg(err)}`);
    }
  }

  private _cmdStateGet(args: string[]): void {
    if (!this._db) {
      this._print('No database available.');
      return;
    }
    if (args.length === 0) {
      this._print('Usage: state.get <key>');
      return;
    }
    const key = args[0] ?? '';

    try {
      const val: string | null = this._db.getState(key);
      if (val === null) {
        this._print(`Key "${key}" not found.`);
      } else {
        // Try pretty-print JSON
        try {
          const parsed: unknown = JSON.parse(val);
          this._print(JSON.stringify(parsed, null, 2));
        } catch {
          this._print(val);
        }
      }
    } catch (err: unknown) {
      this._print(`State get failed: ${errMsg(err)}`);
    }
  }

  private _cmdStateSet(args: string[]): void {
    if (!this._writable) {
      this._print('Write operations disabled. Start with STDIN_CONSOLE_WRITABLE=true to enable.');
      return;
    }
    if (!this._db) {
      this._print('No database available.');
      return;
    }
    if (args.length < 2) {
      this._print('Usage: state.set <key> <value>');
      return;
    }
    const key = args[0] ?? '';
    const value = args.slice(1).join(' ');

    try {
      this._db.setState(key, value);
      this._print(`Set "${key}" = ${value}`);
    } catch (err: unknown) {
      this._print(`State set failed: ${errMsg(err)}`);
    }
  }

  private _cmdStateDelete(args: string[]): void {
    if (!this._writable) {
      this._print('Write operations disabled. Start with STDIN_CONSOLE_WRITABLE=true to enable.');
      return;
    }
    if (!this._db) {
      this._print('No database available.');
      return;
    }
    if (args.length === 0) {
      this._print('Usage: state.delete <key>');
      return;
    }
    const key = args[0] ?? '';

    try {
      this._db.deleteState(key);
      this._print(`Deleted key "${key}".`);
    } catch (err: unknown) {
      this._print(`State delete failed: ${errMsg(err)}`);
    }
  }

  private _cmdStats(): void {
    if (!this._db) {
      this._print('No database available.');
      return;
    }
    const raw = this._db.db;
    if (!raw) {
      this._print('Raw DB handle not available.');
      return;
    }

    try {
      const tables = raw
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all() as DbRow[];
      this._print(`Database statistics (${tables.length} tables):`);
      this._print(`${'Table'.padEnd(35)} ${'Rows'.padStart(10)}`);
      this._print('-'.repeat(46));

      let totalRows = 0;
      for (const tbl of tables) {
        try {
          const row = raw.prepare(`SELECT COUNT(*) as count FROM "${String(tbl.name)}"`).get() as
            | { count: number }
            | undefined;
          const count = row?.count ?? 0;
          totalRows += count;
          this._print(`${String(tbl.name).padEnd(35)} ${String(count).padStart(10)}`);
        } catch {
          this._print(`${String(tbl.name).padEnd(35)} ${'(error)'.padStart(10)}`);
        }
      }
      this._print('-'.repeat(46));
      this._print(`${'TOTAL'.padEnd(35)} ${String(totalRows).padStart(10)}`);
    } catch (err: unknown) {
      this._print(`Stats query failed: ${errMsg(err)}`);
    }
  }

  private _cmdTables(): void {
    if (!this._db) {
      this._print('No database available.');
      return;
    }
    const raw = this._db.db;
    if (!raw) {
      this._print('Raw DB handle not available.');
      return;
    }

    try {
      const tables = raw
        .prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all() as DbRow[];
      this._print(`Tables (${tables.length}):`);
      for (const tbl of tables) {
        this._print(`  ${String(tbl.name)}`);
      }
    } catch (err: unknown) {
      this._print(`Tables query failed: ${errMsg(err)}`);
    }
  }

  private _cmdSql(_args: string[], rawInput: string): void {
    if (!this._db) {
      this._print('No database available.');
      return;
    }
    const dbHandle = this._db.db;
    if (!dbHandle) {
      this._print('Raw DB handle not available.');
      return;
    }

    // Extract everything after "sql "
    const query = rawInput.slice(4).trim();
    if (!query) {
      this._print('Usage: sql <SELECT ...>');
      return;
    }

    // Safety: only allow read-only statements unless writable
    const upper = query.toUpperCase().trimStart();
    const isRead =
      upper.startsWith('SELECT') ||
      upper.startsWith('PRAGMA') ||
      upper.startsWith('EXPLAIN') ||
      upper.startsWith('WITH');
    if (!isRead && !this._writable) {
      this._print('Only SELECT/PRAGMA/EXPLAIN queries allowed. Enable writable mode for mutations.');
      return;
    }

    try {
      if (isRead) {
        const rows = dbHandle.prepare(query).all() as DbRow[];
        if (rows.length === 0) {
          this._print('(no rows)');
          return;
        }
        // Print as table
        const cols = Object.keys(rows[0] as object);
        const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => s(r[c]).length)));
        // Cap column widths
        const maxW = 40;
        const cappedWidths = widths.map((w) => Math.min(w, maxW));

        const header = cols.map((c, i) => c.padEnd(cappedWidths[i] ?? 0)).join(' | ');
        this._print(header);
        this._print(cappedWidths.map((w) => '-'.repeat(w)).join('-+-'));

        for (const row of rows.slice(0, 100)) {
          const line = cols
            .map((c, i) =>
              s(row[c])
                .slice(0, maxW)
                .padEnd(cappedWidths[i] ?? 0),
            )
            .join(' | ');
          this._print(line);
        }
        if (rows.length > 100) this._print(`... (${rows.length - 100} more rows)`);
        this._print(`(${rows.length} row${rows.length !== 1 ? 's' : ''})`);
      } else {
        const result = dbHandle.prepare(query).run();
        this._print(`OK — ${String(result.changes)} row(s) affected.`);
      }
    } catch (err: unknown) {
      this._print(`SQL error: ${errMsg(err)}`);
    }
  }

  private _cmdWorld(): void {
    if (!this._db) {
      this._print('No database available.');
      return;
    }
    try {
      const state: Record<string, unknown> = this._db.getAllWorldState();
      const entries = Object.entries(state);
      if (entries.length === 0) {
        this._print('No world state data.');
        return;
      }

      this._print('World state:');
      for (const [key, value] of entries) {
        this._print(`  ${key.padEnd(30)} ${s(value).slice(0, 60)}`);
      }
    } catch (err: unknown) {
      this._print(`World state query failed: ${errMsg(err)}`);
    }
  }

  private _cmdClans(): void {
    if (!this._db) {
      this._print('No database available.');
      return;
    }
    try {
      const clans = this._db.getAllClans() as DbRow[];
      if (clans.length === 0) {
        this._print('No clans found.');
        return;
      }

      this._print(`Clans (${clans.length}):`);
      for (const c of clans) {
        const name = s(c.name, s(c.clan_name, '?'));
        const members = s(c.member_count, s(c.members, '?'));
        this._print(`  ${name.padEnd(30)} ${members} member(s)`);
      }
    } catch (err: unknown) {
      this._print(`Clans query failed: ${errMsg(err)}`);
    }
  }

  private _cmdVehicles(): void {
    if (!this._db) {
      this._print('No database available.');
      return;
    }
    try {
      const vehicles = this._db.getAllVehicles() as DbRow[];
      if (vehicles.length === 0) {
        this._print('No vehicles found.');
        return;
      }

      this._print(`Vehicles (${vehicles.length}):`);
      for (const v of vehicles) {
        const name = s(v.name, s(v.vehicle_name, s(v.blueprint_name, '?')));
        const fuel = v.fuel !== undefined ? `${Math.round(Number(v.fuel))}%` : '?';
        const owner = s(v.owner_name, s(v.owner, '-'));
        this._print(`  ${name.padEnd(30)} fuel: ${fuel.padEnd(6)} owner: ${owner}`);
      }
    } catch (err: unknown) {
      this._print(`Vehicles query failed: ${errMsg(err)}`);
    }
  }
}

export default StdinConsole;
export { StdinConsole };

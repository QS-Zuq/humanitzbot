/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access,
   @typescript-eslint/no-unsafe-assignment,
   @typescript-eslint/no-explicit-any, @typescript-eslint/restrict-template-expressions, @typescript-eslint/no-unnecessary-condition, @typescript-eslint/no-misused-promises, @typescript-eslint/require-await, @typescript-eslint/no-confusing-void-expression, @typescript-eslint/no-base-to-string, @typescript-eslint/no-unnecessary-type-assertion */

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

class StdinConsole {
  private _db: any;
  private _writable: boolean;
  private _rl: readline.Interface | null;
  private _started: boolean;

  /**
   * @param opts.db       - HumanitZDB instance
   * @param opts.writable - Allow write operations
   */
  constructor({ db, writable = false }: { db?: any; writable?: boolean } = {}) {
    this._db = db;
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

    this._rl.on('line', async (line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        this._prompt();
        return;
      }

      try {
        await this._dispatch(trimmed);
      } catch (err: any) {
        this._print(`Error: ${String(err?.message ?? err)}`);
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

  private async _dispatch(input: string): Promise<void> {
    const parts = input.split(/\s+/);
    const cmd = (parts[0] ?? '').toLowerCase();
    const args = parts.slice(1);

    switch (cmd) {
      case 'help':
        return this._cmdHelp();
      case 'players':
        return this._cmdPlayers(args);
      case 'player':
        return this._cmdPlayer(args);
      case 'online':
        return this._cmdOnline();
      case 'search':
        return this._cmdSearch(args);
      case 'activity':
        return this._cmdActivity(args);
      case 'chat':
        return this._cmdChat(args);
      case 'state':
        return this._cmdState(args);
      case 'state.get':
        return this._cmdStateGet(args);
      case 'state.set':
        return this._cmdStateSet(args);
      case 'state.delete':
        return this._cmdStateDelete(args);
      case 'state.list':
        return this._cmdStateList();
      case 'stats':
        return this._cmdStats();
      case 'tables':
        return this._cmdTables();
      case 'sql':
        return this._cmdSql(args, input);
      case 'world':
        return this._cmdWorld();
      case 'clans':
        return this._cmdClans();
      case 'vehicles':
        return this._cmdVehicles();
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
    const players: any[] = this._db.getAllPlayers();
    const sorted = players.sort((a: any, b: any) =>
      (b.last_seen || b.updated_at || '') > (a.last_seen || a.updated_at || '') ? 1 : -1,
    );
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
      const name = String(p.name ?? 'Unknown').slice(0, 23);
      const kills = String(p.zeeks_killed ?? 0);
      const level = String(p.level ?? 0);
      const seen = p.last_seen ?? p.updated_at ?? '-';
      this._print(
        `${String(p.steam_id ?? '').padEnd(20)} ${name.padEnd(24)} ${kills.padStart(6)} ${level.padStart(5)} ${String(seen).slice(0, 20).padEnd(20)}`,
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
    const p: any = this._db.getPlayer(steamId);
    if (!p) {
      this._print(`Player not found: ${steamId}`);
      return;
    }

    this._print(`Player: ${String(p.name ?? 'Unknown')}`);
    this._print(`  Steam ID:    ${String(p.steam_id)}`);
    this._print(`  Level:       ${String(p.level ?? 0)}`);
    this._print(`  Kills:       ${String(p.zeeks_killed ?? 0)}`);
    this._print(`  Headshots:   ${String(p.headshots ?? 0)}`);
    this._print(`  Days Surv:   ${String(p.days_survived ?? 0)}`);
    this._print(`  Health:      ${String(p.health ?? 0)} / ${String(p.max_health ?? 0)}`);
    this._print(`  Hunger:      ${String(p.hunger ?? 0)}`);
    this._print(`  Thirst:      ${String(p.thirst ?? 0)}`);
    this._print(`  Infection:   ${String(p.infection ?? 0)}`);
    this._print(`  Online:      ${p.online ? 'Yes' : 'No'}`);
    this._print(`  Last Seen:   ${String(p.last_seen ?? '-')}`);
    this._print(`  Updated:     ${String(p.updated_at ?? '-')}`);

    // Aliases
    try {
      const aliases: any[] = this._db.getPlayerAliases(steamId);
      if (aliases && aliases.length > 0) {
        this._print(`  Aliases:     ${aliases.map((a: any) => String(a.name ?? a.player_name ?? '')).join(', ')}`);
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
    const players: any[] = this._db.getOnlinePlayers();
    if (players.length === 0) {
      this._print('No players online.');
      return;
    }

    this._print(`Online players (${players.length}):`);
    for (const p of players) {
      this._print(
        `  ${String(p.steamId ?? p.steam_id ?? '').padEnd(20)} ${String(p.name ?? p.player_name ?? 'Unknown')}`,
      );
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
      const results: any[] = this._db.searchPlayersByName(query);
      if (!results || results.length === 0) {
        this._print(`No players found matching "${query}".`);
        return;
      }

      this._print(`Search results for "${query}" (${results.length}):`);
      for (const p of results) {
        this._print(`  ${String(p.steam_id ?? '').padEnd(20)} ${String(p.name ?? p.player_name ?? 'Unknown')}`);
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
      const rows: any[] = this._db.getRecentActivity(limit);
      if (!rows || rows.length === 0) {
        this._print('No activity found.');
        return;
      }

      this._print(`Recent activity (${rows.length}):`);
      for (const r of rows) {
        const ts = r.timestamp ?? r.created_at ?? '';
        const type = String(r.type ?? r.event_type ?? '?');
        const actor = String(r.playerName ?? r.player_name ?? r.actor ?? '-');
        const detail = String(r.details ?? r.detail ?? r.message ?? '');
        this._print(`  [${String(ts).slice(0, 19)}] ${type.padEnd(22)} ${actor.padEnd(20)} ${detail.slice(0, 60)}`);
      }
    } catch (err: any) {
      this._print(`Activity query failed: ${String(err?.message ?? err)}`);
    }
  }

  private _cmdChat(args: string[]): void {
    if (!this._db) {
      this._print('No database available.');
      return;
    }
    const limit = parseInt(args[0] ?? '', 10) || 10;

    try {
      const rows: any[] = this._db.getRecentChat(limit);
      if (!rows || rows.length === 0) {
        this._print('No chat messages found.');
        return;
      }

      this._print(`Recent chat (${rows.length}):`);
      for (const r of rows) {
        const ts = r.timestamp ?? r.created_at ?? '';
        const dir = r.direction === 'outbound' ? '→' : '←';
        const name = String(r.player_name ?? r.playerName ?? r.discord_user ?? '?');
        const msg = String(r.message ?? '');
        this._print(`  [${String(ts).slice(0, 19)}] ${dir} ${name.padEnd(20)} ${msg.slice(0, 80)}`);
      }
    } catch (err: any) {
      this._print(`Chat query failed: ${String(err?.message ?? err)}`);
    }
  }

  private _cmdState(args: string[]): void {
    // "state" alone → list, "state <key>" → get
    if (args.length === 0) return this._cmdStateList();
    return this._cmdStateGet(args);
  }

  private _cmdStateList(): void {
    if (!this._db) {
      this._print('No database available.');
      return;
    }
    try {
      const rows: any[] = this._db.getAllState();
      if (!rows || rows.length === 0) {
        this._print('No bot_state entries.');
        return;
      }

      this._print(`bot_state entries (${rows.length}):`);
      for (const r of rows) {
        const val = String(r.value ?? '').slice(0, 80);
        this._print(`  ${String(r.key ?? '').padEnd(30)} ${val}`);
      }
    } catch (err: any) {
      this._print(`State query failed: ${String(err?.message ?? err)}`);
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
      const val: unknown = this._db.getState(key);
      if (val === undefined || val === null) {
        this._print(`Key "${key}" not found.`);
      } else {
        // Try pretty-print JSON
        try {
          const parsed: unknown = JSON.parse(String(val));
          this._print(JSON.stringify(parsed, null, 2));
        } catch {
          this._print(String(val));
        }
      }
    } catch (err: any) {
      this._print(`State get failed: ${String(err?.message ?? err)}`);
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
    } catch (err: any) {
      this._print(`State set failed: ${String(err?.message ?? err)}`);
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
    } catch (err: any) {
      this._print(`State delete failed: ${String(err?.message ?? err)}`);
    }
  }

  private _cmdStats(): void {
    if (!this._db) {
      this._print('No database available.');
      return;
    }
    const raw: any = this._db.db;
    if (!raw) {
      this._print('Raw DB handle not available.');
      return;
    }

    try {
      const tables: any[] = raw
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all();
      this._print(`Database statistics (${tables.length} tables):`);
      this._print(`${'Table'.padEnd(35)} ${'Rows'.padStart(10)}`);
      this._print('-'.repeat(46));

      let totalRows = 0;
      for (const t of tables) {
        try {
          const row: any = raw.prepare(`SELECT COUNT(*) as count FROM "${String(t.name)}"`).get();
          const count: number = row.count;
          totalRows += count;
          this._print(`${String(t.name).padEnd(35)} ${String(count).padStart(10)}`);
        } catch {
          this._print(`${String(t.name).padEnd(35)} ${'(error)'.padStart(10)}`);
        }
      }
      this._print('-'.repeat(46));
      this._print(`${'TOTAL'.padEnd(35)} ${String(totalRows).padStart(10)}`);
    } catch (err: any) {
      this._print(`Stats query failed: ${String(err?.message ?? err)}`);
    }
  }

  private _cmdTables(): void {
    if (!this._db) {
      this._print('No database available.');
      return;
    }
    const raw: any = this._db.db;
    if (!raw) {
      this._print('Raw DB handle not available.');
      return;
    }

    try {
      const tables: any[] = raw
        .prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all();
      this._print(`Tables (${tables.length}):`);
      for (const t of tables) {
        this._print(`  ${String(t.name)}`);
      }
    } catch (err: any) {
      this._print(`Tables query failed: ${String(err?.message ?? err)}`);
    }
  }

  private _cmdSql(_args: string[], raw: string): void {
    if (!this._db) {
      this._print('No database available.');
      return;
    }
    const dbHandle: any = this._db.db;
    if (!dbHandle) {
      this._print('Raw DB handle not available.');
      return;
    }

    // Extract everything after "sql "
    const query = raw.slice(4).trim();
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
        const rows: any[] = dbHandle.prepare(query).all();
        if (rows.length === 0) {
          this._print('(no rows)');
          return;
        }
        // Print as table
        const cols = Object.keys(rows[0] as object);
        const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => String((r as any)[c] ?? '').length)));
        // Cap column widths
        const maxW = 40;
        const cappedWidths = widths.map((w) => Math.min(w, maxW));

        const header = cols.map((c, i) => c.padEnd(cappedWidths[i] ?? 0)).join(' | ');
        this._print(header);
        this._print(cappedWidths.map((w) => '-'.repeat(w)).join('-+-'));

        for (const row of rows.slice(0, 100)) {
          const line = cols
            .map((c, i) =>
              String((row as any)[c] ?? '')
                .slice(0, maxW)
                .padEnd(cappedWidths[i] ?? 0),
            )
            .join(' | ');
          this._print(line);
        }
        if (rows.length > 100) this._print(`... (${rows.length - 100} more rows)`);
        this._print(`(${rows.length} row${rows.length !== 1 ? 's' : ''})`);
      } else {
        const result: any = dbHandle.prepare(query).run();
        this._print(`OK — ${String(result.changes)} row(s) affected.`);
      }
    } catch (err: any) {
      this._print(`SQL error: ${String(err?.message ?? err)}`);
    }
  }

  private _cmdWorld(): void {
    if (!this._db) {
      this._print('No database available.');
      return;
    }
    try {
      const state: Record<string, unknown> = this._db.getAllWorldState();
      const entries = Object.entries(state ?? {});
      if (entries.length === 0) {
        this._print('No world state data.');
        return;
      }

      this._print('World state:');
      for (const [key, value] of entries) {
        this._print(`  ${key.padEnd(30)} ${String(value ?? '').slice(0, 60)}`);
      }
    } catch (err: any) {
      this._print(`World state query failed: ${String(err?.message ?? err)}`);
    }
  }

  private _cmdClans(): void {
    if (!this._db) {
      this._print('No database available.');
      return;
    }
    try {
      const clans: any[] = this._db.getAllClans();
      if (!clans || clans.length === 0) {
        this._print('No clans found.');
        return;
      }

      this._print(`Clans (${clans.length}):`);
      for (const c of clans) {
        const name = String(c.name ?? c.clan_name ?? '?');
        const members = String(c.member_count ?? c.members ?? '?');
        this._print(`  ${name.padEnd(30)} ${members} member(s)`);
      }
    } catch (err: any) {
      this._print(`Clans query failed: ${String(err?.message ?? err)}`);
    }
  }

  private _cmdVehicles(): void {
    if (!this._db) {
      this._print('No database available.');
      return;
    }
    try {
      const vehicles: any[] = this._db.getAllVehicles();
      if (!vehicles || vehicles.length === 0) {
        this._print('No vehicles found.');
        return;
      }

      this._print(`Vehicles (${vehicles.length}):`);
      for (const v of vehicles) {
        const name = String(v.name ?? v.vehicle_name ?? v.blueprint_name ?? '?');
        const fuel = v.fuel !== undefined ? `${Math.round(Number(v.fuel))}%` : '?';
        const owner = String(v.owner_name ?? v.owner ?? '-');
        this._print(`  ${name.padEnd(30)} fuel: ${fuel.padEnd(6)} owner: ${owner}`);
      }
    } catch (err: any) {
      this._print(`Vehicles query failed: ${String(err?.message ?? err)}`);
    }
  }
}

export { StdinConsole };

const _mod = module as { exports: any };
_mod.exports = StdinConsole;

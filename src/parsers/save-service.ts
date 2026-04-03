/* eslint-disable @typescript-eslint/no-unnecessary-condition -- runtime data may differ from static types */
/* eslint-disable @typescript-eslint/no-non-null-assertion -- guarded by prior checks */

/**
 * Save-to-DB service for the HumanitZ bot.
 *
 * Orchestrates the save-file → database pipeline with three operating modes:
 *
 *   **Direct** (default): SFTP download of the full .sav file (~60MB), parsed locally.
 *   **Agent**:            Bot deploys a lightweight parser agent onto the game server.
 *   **Auto**:             Tries agent mode first, falls back to direct.
 */

import EventEmitter from 'events';
import fs from 'node:fs';
import path from 'node:path';
import { parseSave, parseClanData } from './save-parser.js';
import { createLogger, type Logger } from '../utils/log.js';

import { diffSaveState } from '../db/diff-engine.js';
import { reconcileItems } from '../db/item-tracker.js';

// Shell-safe single-quote escaping for SSH exec arguments
function shQuote(v: unknown): string {
  const s = String(v);
  if (/[\0\r\n]/.test(s)) throw new Error('Invalid shell argument: contains null/newline');
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

// ─── Types ─────────────────────────────────────────────────────────────────

interface SftpConfig {
  host: string;
  port?: number;
  sshPort?: number;
  username: string;
  password?: string;
  privateKey?: string | Buffer;
}

interface SshConfig {
  host: string;
  port?: number;
  username: string;
  password?: string;
  privateKey?: string | Buffer;
  readyTimeout?: number;
}

interface SshExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface PanelApi {
  available?: boolean;
  sendCommand: (cmd: string) => Promise<void>;
  listFiles: (dir: string) => Promise<Array<{ name: string; modified_at?: string }>>;
  downloadFile: (path: string) => Promise<Buffer>;
  readFile: (path: string) => Promise<string>;
}

interface RconModule {
  connected: boolean;
  send: (cmd: string) => Promise<void>;
}

interface SaveServiceOptions {
  sftpConfig?: SftpConfig;
  savePath?: string;
  clanSavePath?: string;
  localPath?: string;
  pollInterval?: number;
  idMap?: Record<string, string>;
  label?: unknown;
  agentMode?: 'auto' | 'agent' | 'direct';
  agentNodePath?: string;
  agentRemoteDir?: string;
  agentCachePath?: string;
  sshConfig?: SshConfig;
  agentTimeout?: number;
  agentTrigger?: 'auto' | 'rcon' | 'ssh' | 'panel' | 'none';
  agentPanelCommand?: string;
  agentPanelDelay?: number;
  panelApi?: PanelApi;
  dataDir?: string;
}

// Optional modules — preloaded at module scope, null if not installed
let _rconModule: RconModule | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- sync module-scope init, top-level await incompatible with CJS
  _rconModule = require('../rcon/rcon') as unknown as RconModule;
} catch {
  /* rcon not available */
}

let _panelApiModule: PanelApi | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- sync module-scope init, top-level await incompatible with CJS
  _panelApiModule = require('../server/panel-api') as unknown as PanelApi;
} catch {
  /* panel-api not available */
}

interface GameDB {
  db?: unknown;
  _db?: unknown;
  syncAllFromSave: (data: Record<string, unknown>) => void;
  setMeta: (key: string, value: string) => void;
  purgeOldLostItems: (age: string) => void;
  purgeOldLostGroups: (age: string) => void;
  purgeOldMovements: (age: string) => void;
  insertActivities: (events: unknown[]) => void;
  purgeOldActivity: (age: string) => void;
  getAllContainers?: () => unknown[];
  getAllWorldHorses?: () => unknown[];
  getAllWorldState?: () => Record<string, unknown>;
  getAllVehicles?: () => unknown[];
  getStructures?: () => unknown[];
  getOnlinePlayersForDiff?: () => unknown[];
  [key: string]: unknown;
}

class SaveService extends EventEmitter {
  private _db: GameDB;
  private _sftpConfig: SftpConfig | null;
  private _savePath: string;
  private _clanSavePath: string;
  private _localPath: string;
  private _pollInterval: number;
  private _idMap: Record<string, string>;
  private _log: Logger;
  private _dataDir: string;

  private _agentMode: string;
  private _agentNodePath: string;
  private _agentRemoteDir: string;
  private _agentCachePath: string;
  private _sshConfig: SshConfig | null;
  private _agentTimeout: number;

  private _agentTrigger: string;
  private _agentPanelCommand: string;
  private _agentPanelDelay: number;
  private _panelApi: PanelApi | null;
  private _rcon: RconModule | null;

  private _timer: ReturnType<typeof setInterval> | null;
  private _lastMtime: number | null;
  private _lastClanMtime: number | null;
  private _lastCacheMtime: number | null;
  private _syncing: boolean;
  private _syncCount: number;
  private _lastError: string | null;
  private _mode: string | null;

  private _agentDeployed: boolean;
  private _agentCapable: boolean | null;
  private _panelCapable: boolean | null;
  private _resolvedTrigger: string | null;
  private _agentPath: string;
  private _cachePath: string;
  private _runScriptPath: string;
  private _checkNodeScriptPath: string;

  constructor(db: GameDB, options: SaveServiceOptions = {}) {
    super();
    this._db = db;
    this._sftpConfig = options.sftpConfig ?? null;
    this._savePath = options.savePath ?? '';
    this._clanSavePath = options.clanSavePath ?? '';
    this._localPath = options.localPath ?? '';
    this._pollInterval = options.pollInterval ?? 60_000;
    this._idMap = options.idMap ?? {};
    this._log = createLogger(options.label, 'SaveService');
    this._dataDir = options.dataDir ?? path.join(__dirname, '..', '..');

    if (!options.idMap || Object.keys(this._idMap).length === 0) {
      this._loadLocalIdMap();
    }

    this._agentMode = options.agentMode ?? 'auto';
    this._agentNodePath = options.agentNodePath ?? 'node';
    this._agentRemoteDir = options.agentRemoteDir ?? '';
    this._agentCachePath = options.agentCachePath ?? '';
    this._sshConfig = options.sshConfig ?? null;
    this._agentTimeout = options.agentTimeout ?? 120_000;

    this._agentTrigger = options.agentTrigger ?? 'auto';
    this._agentPanelCommand = options.agentPanelCommand ?? 'createHZSocket';
    this._agentPanelDelay = options.agentPanelDelay ?? 3000;
    this._panelApi = options.panelApi ?? null;
    this._rcon = null;

    this._timer = null;
    this._lastMtime = null;
    this._lastClanMtime = null;
    this._lastCacheMtime = null;
    this._syncing = false;
    this._syncCount = 0;
    this._lastError = null;
    this._mode = null;

    this._agentDeployed = false;
    this._agentCapable = null;
    this._panelCapable = null;
    this._resolvedTrigger = null;
    this._agentPath = '';
    this._cachePath = '';
    this._runScriptPath = '';
    this._checkNodeScriptPath = '';
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Lifecycle
  // ═══════════════════════════════════════════════════════════════════════════

  async start(): Promise<void> {
    this._resolvePaths();
    this._repairSteamIdNames();

    const modeLabel =
      this._agentMode === 'direct'
        ? 'direct'
        : `${this._agentMode} (agent-capable: ${String(this._agentCapable ?? 'unknown')})`;
    this._log.info(`Starting save service — mode: ${modeLabel}, poll every ${String(this._pollInterval / 1000)}s`);
    await this._poll();
    this._timer = setInterval(() => {
      void this._poll();
    }, this._pollInterval);
  }

  stop(): void {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this._log.info(`Stopped (${String(this._syncCount)} syncs, mode: ${this._mode ?? this._agentMode})`);
  }

  async forceSync(): Promise<unknown> {
    return this._poll(true);
  }

  setIdMap(idMap: Record<string, string>): void {
    this._idMap = idMap;
  }

  _loadLocalIdMap(): void {
    try {
      const filePath = path.join(this._dataDir, 'data', 'logs', 'PlayerIDMapped.txt');
      const altPath = path.join(this._dataDir, 'logs', 'PlayerIDMapped.txt');
      const actualPath = fs.existsSync(filePath) ? filePath : fs.existsSync(altPath) ? altPath : null;
      if (!actualPath) return;
      const raw = fs.readFileSync(actualPath, 'utf8');
      const map: Record<string, string> = {};
      let count = 0;
      for (const line of raw.split(/\r?\n/)) {
        const m = line.trim().match(/^(\d{17})_\+_\|[^@]+@(.+)$/);
        if (m?.[1] && m[2]) {
          map[m[1]] = m[2].trim();
          count++;
        }
      }
      if (count > 0) {
        this._idMap = map;
        this._log.info(`Loaded ${String(count)} name(s) from cached PlayerIDMapped.txt`);
      }
    } catch (err: unknown) {
      this._log.warn('Could not load cached ID map:', (err as Error).message);
    }
  }

  _repairSteamIdNames(): void {
    if (!this._db || Object.keys(this._idMap).length === 0) return;
    try {
      const rawDb = (this._db.db ?? this._db._db ?? this._db) as Record<string, unknown>;
      if (typeof rawDb['prepare'] !== 'function') return;
      const prepare = rawDb['prepare'] as (sql: string) => {
        all: () => Array<{ actor: string }>;
        run: (name: string, actor: string) => { changes: number };
      };

      const rows = prepare(
        `SELECT DISTINCT actor FROM activity_log
         WHERE actor_name = actor AND actor GLOB '[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'`,
      ).all();

      let fixed = 0;
      const stmt = prepare('UPDATE activity_log SET actor_name = ? WHERE actor = ? AND actor_name = actor');

      for (const row of rows) {
        const name = this._idMap[row.actor];
        if (name) {
          const info = stmt.run(name, row.actor);
          fixed += info.changes;
        }
      }

      if (fixed > 0) {
        this._log.info(`Repaired ${String(fixed)} activity_log row(s) with resolved player names`);
      }
    } catch (err: unknown) {
      this._log.warn('DB name repair failed (non-fatal):', (err as Error).message);
    }
  }

  get stats(): Record<string, unknown> {
    return {
      syncCount: this._syncCount,
      lastError: this._lastError,
      lastMtime: this._lastMtime,
      syncing: this._syncing,
      mode: this._mode ?? this._agentMode,
      agentDeployed: this._agentDeployed,
      agentCapable: this._agentCapable,
      panelCapable: this._panelCapable,
      panelFileApi: this._hasPanelApi(),
      trigger: this._resolvedTrigger ?? this._agentTrigger,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Path resolution
  // ═══════════════════════════════════════════════════════════════════════════

  _resolvePaths(): void {
    if (this._savePath) {
      const dir = this._agentRemoteDir || this._savePath.replace(/[/\\][^/\\]+$/, '');
      this._agentRemoteDir = dir;
      this._agentPath = dir + '/humanitz-agent.js';
      this._cachePath = this._agentCachePath || dir + '/humanitz-cache.json';
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Agent deployment & execution
  // ═══════════════════════════════════════════════════════════════════════════

  async deployAgent(): Promise<void> {
    let SFTPClient: new () => {
      connect: (config: SftpConfig) => Promise<void>;
      put: (buf: Buffer, path: string) => Promise<void>;
      end: () => void;
    };
    try {
      const _sftpMod = (await import('ssh2-sftp-client')) as unknown as { default: typeof SFTPClient };
      SFTPClient = _sftpMod.default;
    } catch {
      throw new Error('ssh2-sftp-client not installed');
    }

    let buildAgentScript: () => string;
    try {
      ({ buildAgentScript } = (await import('./agent-builder.js')) as unknown as { buildAgentScript: () => string });
    } catch (err: unknown) {
      throw new Error(`Failed to load agent-builder: ${(err as Error).message}`, { cause: err });
    }

    const script = buildAgentScript();
    const sftp = new SFTPClient();

    try {
      await sftp.connect(this._sftpConfig!);
      await sftp.put(Buffer.from(script, 'utf-8'), this._agentPath);
      this._agentDeployed = true;
      this._log.info(`Agent deployed → ${this._agentPath} (${(script.length / 1024).toFixed(1)}KB)`);

      const runScript = this._generateRunScript();
      this._runScriptPath = path.dirname(this._agentPath) + '/run-agent.sh';
      await sftp.put(Buffer.from(runScript, 'utf-8'), this._runScriptPath);
      this._log.info(`Runner script deployed → ${this._runScriptPath}`);

      const checkScript = this._generateCheckNodeScript();
      const checkScriptPath = path.dirname(this._agentPath) + '/check-node.sh';
      await sftp.put(Buffer.from(checkScript, 'utf-8'), checkScriptPath);
      this._checkNodeScriptPath = checkScriptPath;
      this._log.info(`Check-node script deployed → ${checkScriptPath}`);
    } finally {
      sftp.end();
    }
  }

  _generateRunScript(): string {
    return (
      '#!/bin/bash\nexec ' +
      shQuote(this._agentNodePath) +
      ' ' +
      shQuote(this._agentPath) +
      ' --save ' +
      shQuote(this._savePath) +
      '\n'
    );
  }

  _generateCheckNodeScript(): string {
    return '#!/bin/bash\n' + shQuote(this._agentNodePath) + ' --version\n';
  }

  async executeAgent(): Promise<SshExecResult> {
    const scriptPath = this._runScriptPath || path.dirname(this._agentPath) + '/run-agent.sh';
    this._log.info(`Executing agent via runner script: ${scriptPath}`);
    const result = await this._sshExec('bash ' + shQuote(scriptPath));

    if (result.code !== 0) {
      const msg = (result.stderr || result.stdout || '').trim().slice(0, 300);
      throw new Error(`Agent exited with code ${String(result.code)}: ${msg}`);
    }

    this._log.info(`Agent output: ${result.stdout.trim().slice(0, 200)}`);
    return result;
  }

  async checkNodeAvailable(): Promise<boolean> {
    try {
      const scriptPath = this._checkNodeScriptPath || path.dirname(this._agentPath) + '/check-node.sh';
      const result = await this._sshExec('bash ' + shQuote(scriptPath));
      const version = (result.stdout || '').trim();
      if (result.code === 0 && version.startsWith('v')) {
        this._agentCapable = true;
        this._log.info(`Node.js available on game server: ${version}`);
        return true;
      }
    } catch (err: unknown) {
      this._log.info(`SSH check failed: ${(err as Error).message}`);
    }
    this._agentCapable = false;
    return false;
  }

  async _sshExec(command: string): Promise<SshExecResult> {
    let SSHClient: new () => {
      on: (event: string, cb: (...args: unknown[]) => void) => void;
      connect: (config: SshConfig) => void;
      exec: (
        cmd: string,
        cb: (
          err: Error | null,
          stream: NodeJS.ReadableStream & {
            stderr: NodeJS.ReadableStream;
            on: (event: string, cb: (...args: unknown[]) => void) => void;
          },
        ) => void,
      ) => void;
      end: () => void;
    };
    try {
      ({ Client: SSHClient } = (await import('ssh2')) as unknown as { Client: typeof SSHClient });
    } catch {
      throw new Error('ssh2 not installed — needed for SSH exec');
    }

    const config = this._sshConfig ?? this._buildSshConfig();
    if (!config?.host) {
      throw new Error('No SSH config available (need SFTP_HOST + SFTP_USER + SFTP_PASSWORD)');
    }

    return new Promise((resolve, reject) => {
      const conn = new SSHClient();
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        conn.end();
        reject(new Error(`SSH exec timed out after ${String(this._agentTimeout)}ms`));
      }, this._agentTimeout);

      conn.on('ready', () => {
        conn.exec(command, (err, stream) => {
          if (err) {
            clearTimeout(timer);
            conn.end();
            reject(err);
            return;
          }
          stream.on('data', (d: Buffer) => {
            stdout += d.toString();
          });
          stream.stderr.on('data', (d: Buffer) => {
            stderr += d.toString();
          });
          stream.on('close', (code: number | null) => {
            clearTimeout(timer);
            conn.end();
            resolve({ code: code ?? 1, stdout, stderr });
          });
        });
      });

      conn.on('error', (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
      conn.connect(config);
    });
  }

  _buildSshConfig(): SshConfig | null {
    if (!this._sftpConfig) return null;
    return {
      host: this._sftpConfig.host,
      port: this._sftpConfig.sshPort ?? this._sftpConfig.port ?? 22,
      username: this._sftpConfig.username,
      password: this._sftpConfig.password,
      privateKey: this._sftpConfig.privateKey,
      readyTimeout: 10000,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Polling
  // ═══════════════════════════════════════════════════════════════════════════

  async _poll(force = false): Promise<void> {
    if (this._syncing) return;
    this._syncing = true;

    try {
      if (this._localPath) {
        await this._pollDirect(force);
        return;
      }
      if (this._agentMode === 'direct') {
        await this._pollDirect(force);
      } else {
        const agentOk = await this._pollAgent(force);
        if (!agentOk && this._agentMode === 'auto') {
          if (!this._mode || this._mode === 'direct') {
            this._log.info('Agent unavailable — falling back to direct .sav download');
          }
          this._mode = 'direct';
          await this._pollDirect(force);
        } else if (agentOk) {
          this._mode = 'agent';
        }
      }
    } catch (err: unknown) {
      this._lastError = (err as Error).message;
      this._log.error('Sync error:', (err as Error).message);
      this.emit('error', err);
    } finally {
      this._syncing = false;
    }
  }

  async _pollDirect(force: boolean): Promise<void> {
    let buf: Buffer | null = null;
    let clanBuf: Buffer | null = null;

    if (this._localPath) {
      buf = this._readLocal(this._localPath, force);
      if (this._clanSavePath) {
        clanBuf = this._readLocal(this._clanSavePath, force);
      }
    } else if (this._sftpConfig && this._savePath) {
      const result = await this._readSftp(force);
      buf = result.saveBuf;
      clanBuf = result.clanBuf;
    } else if (this._hasPanelApi() && this._savePath) {
      const result = await this._readPanelApi(force);
      buf = result.saveBuf;
      clanBuf = result.clanBuf;
    }

    if (!buf) return;

    const parsed = parseSave(buf) as unknown as Record<string, unknown>;
    let clans: unknown[] = [];
    if (clanBuf) {
      try {
        clans = parseClanData(clanBuf);
      } catch (err: unknown) {
        this._log.warn('Failed to parse clan data:', (err as Error).message);
      }
    }

    this._syncParsedData(parsed, clans);
    this._syncCount++;
    this._lastError = null;
  }

  async _pollAgent(force: boolean): Promise<boolean> {
    try {
      const cache = await this._readCacheFromSftp(force);
      if (cache) {
        await this._syncFromCache(cache as Record<string, unknown>);
        this._syncCount++;
        this._lastError = null;
        return true;
      }

      const trigger = await this._resolveTrigger();

      if (trigger === 'rcon') {
        await this._triggerViaRcon();
      } else if (trigger === 'panel') {
        await this._triggerViaPanel();
      } else if (trigger === 'ssh') {
        if (!this._agentDeployed) await this.deployAgent();
        await this.executeAgent();
      } else {
        return false;
      }

      const freshCache = await this._readCacheFromSftp(true);
      if (freshCache) {
        await this._syncFromCache(freshCache as Record<string, unknown>);
        this._syncCount++;
        this._lastError = null;
        return true;
      }

      this._log.warn(`Agent triggered (${trigger}) but cache not found at ${this._cachePath}`);
      return false;
    } catch (err: unknown) {
      this._log.warn(`Agent mode failed: ${(err as Error).message}`);
      return false;
    }
  }

  async _resolveTrigger(): Promise<string> {
    if (this._resolvedTrigger) return this._resolvedTrigger;

    const requested = this._agentTrigger;

    if (requested === 'rcon') {
      this._resolvedTrigger = this._isRconAvailable() ? 'rcon' : 'none';
      return this._resolvedTrigger;
    }
    if (requested === 'panel') {
      this._resolvedTrigger = 'panel';
      return 'panel';
    }
    if (requested === 'ssh') {
      if (this._agentCapable === null) await this.checkNodeAvailable();
      this._resolvedTrigger = this._agentCapable ? 'ssh' : 'none';
      return this._resolvedTrigger;
    }
    if (requested === 'none') {
      this._resolvedTrigger = 'none';
      return 'none';
    }

    // 'auto'
    if (this._isRconAvailable() && this._checkPanelAvailable()) {
      this._log.info('Auto-selected RCON trigger (Panel API detected — Pterodactyl host)');
      this._resolvedTrigger = 'rcon';
      return 'rcon';
    }

    if (this._agentCapable === null) await this.checkNodeAvailable();
    if (this._agentCapable) {
      this._log.info('Auto-selected SSH trigger');
      this._resolvedTrigger = 'ssh';
      return 'ssh';
    }

    if (this._isRconAvailable()) {
      this._log.info('RCON available but no Panel API or SSH — agent trigger skipped');
    } else {
      this._log.info('No RCON, Panel API, or SSH available — will check for host-managed cache only');
    }
    this._resolvedTrigger = 'none';
    return 'none';
  }

  _checkPanelAvailable(): boolean {
    if (this._panelCapable !== null) return this._panelCapable;
    if (!this._panelApi) {
      this._panelCapable = false;
      return false;
    }
    this._panelCapable = !!this._panelApi.available;
    return this._panelCapable;
  }

  _isRconAvailable(): boolean {
    if (!this._rcon) {
      if (!_rconModule) return false;
      this._rcon = _rconModule;
    }
    if (!this._rcon) return false;
    return this._rcon.connected;
  }

  async _triggerViaRcon(): Promise<void> {
    if (!this._rcon) {
      if (!_rconModule) throw new Error('RCON module not available');
      this._rcon = _rconModule;
    }
    this._log.info(`Sending RCON command: "${this._agentPanelCommand}"`);
    await this._rcon.send(this._agentPanelCommand);
    if (this._agentPanelDelay > 0) {
      await new Promise<void>((r) => {
        setTimeout(r, this._agentPanelDelay);
      });
    }
  }

  async _triggerViaPanel(): Promise<void> {
    this._log.info(`Sending panel command: "${this._agentPanelCommand}"`);
    await this._panelApi!.sendCommand(this._agentPanelCommand);
    if (this._agentPanelDelay > 0) {
      await new Promise<void>((r) => {
        setTimeout(r, this._agentPanelDelay);
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Data reading
  // ═══════════════════════════════════════════════════════════════════════════

  _readLocal(filePath: string, force: boolean): Buffer | null {
    const resolvedPath = path.resolve(filePath);
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`Save file not found: ${resolvedPath}`);
    }
    const stat = fs.statSync(resolvedPath);
    const mtime = stat.mtimeMs;
    if (!force && this._lastMtime && mtime === this._lastMtime) return null;
    this._lastMtime = mtime;
    return fs.readFileSync(resolvedPath);
  }

  async _readSftp(force: boolean): Promise<{ saveBuf: Buffer | null; clanBuf: Buffer | null }> {
    let SFTPClient: new () => {
      connect: (config: SftpConfig) => Promise<void>;
      stat: (p: string) => Promise<{ modifyTime: number }>;
      get: (p: string) => Promise<Buffer>;
      end: () => void;
    };
    try {
      SFTPClient = ((await import('ssh2-sftp-client')) as unknown as { default: typeof SFTPClient }).default;
    } catch {
      throw new Error('ssh2-sftp-client not installed — needed for SFTP polling');
    }

    const sftp = new SFTPClient();
    try {
      await sftp.connect(this._sftpConfig!);
      const stat = await sftp.stat(this._savePath);
      const mtime = stat.modifyTime;
      if (!force && this._lastMtime && mtime === this._lastMtime) {
        return { saveBuf: null, clanBuf: null };
      }
      this._log.info('Downloading save file (direct mode)...');
      const saveBuf = await sftp.get(this._savePath);
      this._lastMtime = mtime;
      let clanBuf: Buffer | null = null;
      if (this._clanSavePath) {
        try {
          const clanStat = await sftp.stat(this._clanSavePath);
          if (!this._lastClanMtime || clanStat.modifyTime !== this._lastClanMtime) {
            clanBuf = await sftp.get(this._clanSavePath);
            this._lastClanMtime = clanStat.modifyTime;
          }
        } catch {
          /* Clan file may not exist yet */
        }
      }
      return { saveBuf, clanBuf };
    } finally {
      sftp.end();
    }
  }

  _hasPanelApi(): boolean {
    if (this._panelApi) return this._panelApi.available !== false;
    if (!_panelApiModule) return false;
    this._panelApi = _panelApiModule;
    return !!this._panelApi.available;
  }

  async _readPanelApi(force: boolean): Promise<{ saveBuf: Buffer | null; clanBuf: Buffer | null }> {
    const api = this._panelApi;
    if (!api?.available) throw new Error('Panel API not available');

    const saveDir = this._savePath.replace(/[/\\][^/\\]+$/, '') || '/';
    const saveFilename = this._savePath.split(/[/\\]/).pop();

    if (!force) {
      try {
        const files = await api.listFiles(saveDir);
        const saveFile = files.find((f) => f.name === saveFilename);
        if (saveFile?.modified_at) {
          const mtime = new Date(saveFile.modified_at).getTime();
          if (this._lastMtime && mtime === this._lastMtime) return { saveBuf: null, clanBuf: null };
          this._lastMtime = mtime;
        }
      } catch (err: unknown) {
        this._log.warn('Panel file list failed (will download anyway):', (err as Error).message);
      }
    }

    this._log.info('Downloading save file via Panel API (direct mode)...');
    const saveBuf = await api.downloadFile(this._savePath);
    if (!saveBuf || saveBuf.length === 0) throw new Error('Empty save file downloaded from Panel API');

    if (force) {
      try {
        const files = await api.listFiles(saveDir);
        const saveFile = files.find((f) => f.name === saveFilename);
        if (saveFile?.modified_at) this._lastMtime = new Date(saveFile.modified_at).getTime();
      } catch {
        /* non-critical */
      }
    }

    let clanBuf: Buffer | null = null;
    if (this._clanSavePath) {
      try {
        const clanDir = this._clanSavePath.replace(/[/\\][^/\\]+$/, '') || '/';
        const clanFilename = this._clanSavePath.split(/[/\\]/).pop();
        let shouldDownload = true;
        if (!force) {
          try {
            const clanFiles = await api.listFiles(clanDir);
            const clanFile = clanFiles.find((f) => f.name === clanFilename);
            if (clanFile?.modified_at) {
              const mtime = new Date(clanFile.modified_at).getTime();
              if (this._lastClanMtime && mtime === this._lastClanMtime) shouldDownload = false;
              else this._lastClanMtime = mtime;
            }
          } catch {
            /* download anyway */
          }
        }
        if (shouldDownload) clanBuf = await api.downloadFile(this._clanSavePath);
      } catch {
        /* Clan file may not exist */
      }
    }

    const sizeMB = (saveBuf.length / 1024 / 1024).toFixed(2);
    this._log.info(`Downloaded ${sizeMB}MB save via Panel API`);
    return { saveBuf, clanBuf };
  }

  async _readCacheFromSftp(force: boolean): Promise<unknown> {
    if (this._sftpConfig && this._cachePath) {
      const result = await this._readCacheViaSftp(force);
      if (result !== undefined) return result;
    }
    if (this._hasPanelApi() && this._cachePath) return this._readCacheViaPanelApi(force);
    return null;
  }

  async _readCacheViaSftp(force: boolean): Promise<unknown> {
    let SFTPClient: new () => {
      connect: (config: SftpConfig) => Promise<void>;
      stat: (p: string) => Promise<{ modifyTime: number }>;
      get: (p: string) => Promise<Buffer>;
      end: () => void;
    };
    try {
      SFTPClient = ((await import('ssh2-sftp-client')) as unknown as { default: typeof SFTPClient }).default;
    } catch {
      return undefined;
    }

    const sftp = new SFTPClient();
    try {
      await sftp.connect(this._sftpConfig!);
      let stat: { modifyTime: number };
      try {
        stat = await sftp.stat(this._cachePath);
      } catch {
        return null;
      }
      const mtime = stat.modifyTime;
      if (!force && this._lastCacheMtime && mtime === this._lastCacheMtime) return null;
      const buf = await sftp.get(this._cachePath);
      const json = buf.toString('utf-8');
      return this._parseCache(json, mtime);
    } finally {
      sftp.end();
    }
  }

  async _readCacheViaPanelApi(force: boolean): Promise<unknown> {
    const api = this._panelApi;
    if (!api?.available) return null;
    try {
      const cacheDir = this._cachePath.replace(/[/\\][^/\\]+$/, '') || '/';
      const cacheFilename = this._cachePath.split(/[/\\]/).pop();
      const files = await api.listFiles(cacheDir);
      const cacheFile = files.find((f) => f.name === cacheFilename);
      if (!cacheFile) return null;
      const mtime = cacheFile.modified_at ? new Date(cacheFile.modified_at).getTime() : null;
      if (!force && mtime && this._lastCacheMtime && mtime === this._lastCacheMtime) return null;
      const json = await api.readFile(this._cachePath);
      return this._parseCache(json, mtime);
    } catch (err: unknown) {
      this._log.warn('Panel cache read failed:', (err as Error).message);
      return null;
    }
  }

  _parseCache(json: string, mtime: number | null): Record<string, unknown> | null {
    let cache: Record<string, unknown>;
    try {
      cache = JSON.parse(json) as Record<string, unknown>;
    } catch (err: unknown) {
      this._log.warn(`Invalid cache JSON: ${(err as Error).message}`);
      return null;
    }
    if (!cache || typeof cache['v'] !== 'number' || cache['v'] < 1) {
      this._log.warn(`Invalid or missing cache version (got ${String(cache?.['v'])})`);
      return null;
    }
    if (mtime) this._lastCacheMtime = mtime;
    const sizeMB = (json.length / 1024 / 1024).toFixed(2);
    this._log.info(
      `Downloaded cache: ${sizeMB}MB (${String(Object.keys((cache['players'] as Record<string, unknown>) ?? {}).length)} players)`,
    );
    return cache;
  }

  async _fetchClanData(): Promise<unknown[]> {
    if (this._sftpConfig) {
      let SFTPClient: new () => {
        connect: (config: SftpConfig) => Promise<void>;
        stat: (p: string) => Promise<{ modifyTime: number }>;
        get: (p: string) => Promise<Buffer>;
        end: () => Promise<void>;
      };
      try {
        SFTPClient = ((await import('ssh2-sftp-client')) as unknown as { default: typeof SFTPClient }).default;
      } catch {
        /* ignore */
      }
      if (SFTPClient!) {
        const sftp = new SFTPClient();
        try {
          await sftp.connect(this._sftpConfig);
          const clanStat = await sftp.stat(this._clanSavePath);
          if (!this._lastClanMtime || clanStat.modifyTime !== this._lastClanMtime) {
            const clanBuf = await sftp.get(this._clanSavePath);
            this._lastClanMtime = clanStat.modifyTime;
            return parseClanData(clanBuf);
          }
        } catch {
          /* Clan file may not exist */
        } finally {
          try {
            await sftp.end();
          } catch {
            /* ignore */
          }
        }
        return [];
      }
    }
    if (this._hasPanelApi()) {
      try {
        const clanBuf = await this._panelApi!.downloadFile(this._clanSavePath);
        if (clanBuf && clanBuf.length > 0) return parseClanData(clanBuf);
      } catch {
        /* Clan file may not exist */
      }
    }
    return [];
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Data sync
  // ═══════════════════════════════════════════════════════════════════════════

  async _syncFromCache(cache: Record<string, unknown>): Promise<void> {
    const players = new Map<string, unknown>();
    for (const [steamId, data] of Object.entries((cache['players'] as Record<string, unknown>) ?? {})) {
      players.set(steamId, data);
    }
    const parsed = {
      players,
      worldState: (cache['worldState'] as Record<string, unknown>) ?? {},
      structures: (cache['structures'] as unknown[]) ?? [],
      vehicles: (cache['vehicles'] as unknown[]) ?? [],
      companions: (cache['companions'] as unknown[]) ?? [],
      deadBodies: (cache['deadBodies'] as unknown[]) ?? [],
      containers: (cache['containers'] as unknown[]) ?? [],
      lootActors: (cache['lootActors'] as unknown[]) ?? [],
      quests: (cache['quests'] as unknown[]) ?? [],
      horses: (cache['horses'] as unknown[]) ?? [],
    };
    let clans: unknown[] = [];
    if (this._clanSavePath) clans = await this._fetchClanData();
    this._syncParsedData(parsed, clans);
  }

  _syncParsedData(parsed: Record<string, unknown>, clans: unknown[]): Record<string, unknown> {
    const startTime = Date.now();
    const players = parsed['players'] as Map<string, Record<string, unknown>>;

    for (const [steamId, data] of players) {
      if (this._idMap[steamId]) data['name'] = this._idMap[steamId];
    }

    let diffEvents: unknown[] = [];
    const isFirstSync = this._syncCount === 0;
    try {
      const oldState = this._readOldStateForDiff();
      if (oldState && !isFirstSync) {
        const newState = {
          containers: (parsed['containers'] as unknown[]) ?? [],
          horses: (parsed['horses'] as unknown[]) ?? [],
          players,
          worldState: (parsed['worldState'] as Record<string, unknown>) ?? {},
          vehicles: (parsed['vehicles'] as unknown[]) ?? [],
          structures: (parsed['structures'] as unknown[]) ?? [],
        };
        const nameResolver = (steamId: string): string => {
          const p = players.get(steamId);
          return (p?.['name'] as string) || this._idMap[steamId] || steamId;
        };
        diffEvents = diffSaveState(oldState, newState, nameResolver);
      }
    } catch (err: unknown) {
      this._log.warn('Diff engine error (non-fatal):', (err as Error).message);
    }

    const worldDrops: unknown[] = [];
    try {
      const ws = (parsed['worldState'] as Record<string, unknown>) ?? {};
      if (ws['lodPickups']) {
        for (const p of ws['lodPickups'] as Array<Record<string, unknown>>) {
          worldDrops.push({
            type: 'pickup',
            actorName: '',
            item: p['item'],
            amount: p['amount'] ?? 1,
            durability: p['durability'] ?? 0,
            items: [],
            worldLoot: p['worldLoot'],
            placed: p['placed'],
            spawned: p['spawned'],
            x: p['x'],
            y: p['y'],
            z: p['z'],
          });
        }
      }
      if (ws['droppedBackpacks']) {
        for (let i = 0; i < (ws['droppedBackpacks'] as unknown[]).length; i++) {
          const bp = (ws['droppedBackpacks'] as Array<Record<string, unknown>>)[i]!;
          worldDrops.push({
            type: 'backpack',
            actorName: `backpack_${String(i)}`,
            item: '',
            amount: 0,
            durability: 0,
            items: bp['items'] ?? [],
            x: bp['x'],
            y: bp['y'],
            z: bp['z'],
          });
        }
      }
      if (ws['globalContainers']) {
        for (const gc of ws['globalContainers'] as Array<Record<string, unknown>>) {
          worldDrops.push({
            type: 'global_container',
            actorName: gc['actorName'] ?? '',
            item: '',
            amount: 0,
            durability: 0,
            items: gc['items'] ?? [],
            locked: gc['locked'],
            doesSpawnLoot: gc['doesSpawnLoot'],
            x: gc['x'] ?? null,
            y: gc['y'] ?? null,
            z: gc['z'] ?? null,
          });
        }
      }
    } catch (err: unknown) {
      this._log.warn('World drops build error (non-fatal):', (err as Error).message);
    }

    this._db.syncAllFromSave({
      players,
      worldState: parsed['worldState'],
      structures: parsed['structures'],
      vehicles: parsed['vehicles'],
      companions: parsed['companions'],
      clans,
      deadBodies: parsed['deadBodies'],
      containers: parsed['containers'],
      lootActors: parsed['lootActors'],
      quests: parsed['quests'],
      horses: parsed['horses'],
      worldDrops: worldDrops.length > 0 ? worldDrops : null,
    });

    let itemStats: Record<string, unknown> | null = null;
    try {
      const nameResolver = (steamId: string): string => {
        const p = players.get(steamId);
        return (p?.['name'] as string) || this._idMap[steamId] || steamId;
      };
      itemStats = reconcileItems(
        this._db,
        {
          players,
          containers: (parsed['containers'] as Record<string, unknown>[]) ?? [],
          vehicles: (parsed['vehicles'] as Record<string, unknown>[]) ?? [],
          horses: (parsed['horses'] as Record<string, unknown>[]) ?? [],
          structures: (parsed['structures'] as Record<string, unknown>[]) ?? [],
          worldState: (parsed['worldState'] as Record<string, unknown>) ?? {},
        },
        nameResolver,
      ) as unknown as Record<string, unknown>;
      if (this._syncCount % 100 === 0) {
        this._db.purgeOldLostItems('-7 days');
        this._db.purgeOldLostGroups('-7 days');
        this._db.purgeOldMovements('-30 days');
      }
    } catch (err: unknown) {
      this._log.warn('Item tracker error (non-fatal):', (err as Error).message);
    }

    if (diffEvents.length > 0) {
      try {
        this._db.insertActivities(diffEvents);
        this._log.info(`Activity log: ${String(diffEvents.length)} events recorded`);
      } catch (err: unknown) {
        this._log.warn('Failed to write activity log:', (err as Error).message);
      }
    }

    try {
      this._db.purgeOldActivity('-30 days');
    } catch {
      /* ignore */
    }

    this._db.setMeta('last_save_sync', new Date().toISOString());
    this._db.setMeta('last_save_players', String(players.size));

    const elapsed = Date.now() - startTime;
    const mode = this._mode ?? this._agentMode;
    const horsesArr = (parsed['horses'] as unknown[] | undefined) ?? [];
    const containersArr = (parsed['containers'] as unknown[] | undefined) ?? [];
    const horsesLabel = horsesArr.length ? `, ${String(horsesArr.length)} horses` : '';
    const containersLabel = containersArr.length ? `, ${String(containersArr.length)} containers` : '';
    const activityLabel = diffEvents.length ? `, ${String(diffEvents.length)} activity events` : '';
    const itemLabel = itemStats
      ? `, items: ${String(itemStats['matched'])}m/${String(itemStats['created'])}c/${String(itemStats['moved'])}v/${String(itemStats['lost'])}l` +
        (itemStats['groups']
          ? ` grp: ${String((itemStats['groups'] as Record<string, unknown>)['matched'])}m/${String((itemStats['groups'] as Record<string, unknown>)['created'])}c/${String((itemStats['groups'] as Record<string, unknown>)['adjusted'])}a/${String((itemStats['groups'] as Record<string, unknown>)['transferred'])}t/${String((itemStats['groups'] as Record<string, unknown>)['lost'])}l`
          : '')
      : '';
    this._log.info(
      `Sync complete (${mode}): ${String(players.size)} players, ${String((parsed['structures'] as unknown[]).length)} structures, ${String((parsed['vehicles'] as unknown[]).length)} vehicles, ${String(clans.length)} clans${horsesLabel}${containersLabel}${activityLabel}${itemLabel} (${String(elapsed)}ms)`,
    );

    this._writeSaveCache(parsed);

    const result = {
      playerCount: players.size,
      structureCount: (parsed['structures'] as unknown[]).length,
      vehicleCount: (parsed['vehicles'] as unknown[]).length,
      companionCount: (parsed['companions'] as unknown[]).length,
      clanCount: clans.length,
      horseCount: horsesArr.length,
      containerCount: containersArr.length,
      activityEvents: diffEvents.length,
      itemTracking: itemStats,
      worldState: parsed['worldState'],
      elapsed,
      steamIds: [...players.keys()],
      mode,
      diffEvents,
      syncTime: new Date(),
      parsed: {
        players,
        structures: parsed['structures'],
        vehicles: parsed['vehicles'],
        companions: parsed['companions'],
        horses: horsesArr,
        containers: containersArr,
      },
    };

    this.emit('sync', result);
    return result;
  }

  _readOldStateForDiff(): Record<string, unknown> | null {
    if (this._syncCount === 0) return null;
    try {
      const containers = this._db.getAllContainers ? this._db.getAllContainers() : [];
      const horses = this._db.getAllWorldHorses ? this._db.getAllWorldHorses() : [];
      const worldState = this._db.getAllWorldState ? this._db.getAllWorldState() : {};
      const vehiclesList = this._db.getAllVehicles ? this._db.getAllVehicles() : [];
      const structuresList = this._db.getStructures ? this._db.getStructures() : [];
      let playersList: unknown[] = [];
      try {
        playersList = this._db.getOnlinePlayersForDiff ? this._db.getOnlinePlayersForDiff() : [];
      } catch {
        /* empty */
      }
      return {
        containers,
        horses,
        players: playersList,
        worldState,
        vehicles: vehiclesList,
        structures: structuresList,
      };
    } catch (err: unknown) {
      this._log.warn('Could not read old state for diff:', (err as Error).message);
      return null;
    }
  }

  _writeSaveCache(parsed: Record<string, unknown>): void {
    try {
      const players = parsed['players'] as Map<string, unknown>;
      const cacheData: Record<string, unknown> = {
        updatedAt: new Date().toISOString(),
        playerCount: players.size,
        worldState: (parsed['worldState'] as Record<string, unknown>) ?? {},
        players: {} as Record<string, unknown>,
        structures: Array.isArray(parsed['structures']) ? parsed['structures'] : [],
        vehicles: Array.isArray(parsed['vehicles']) ? parsed['vehicles'] : [],
        horses: Array.isArray(parsed['horses']) ? parsed['horses'] : [],
        containers: Array.isArray(parsed['containers']) ? parsed['containers'] : [],
        companions: Array.isArray(parsed['companions']) ? parsed['companions'] : [],
      };
      if (players instanceof Map) {
        for (const [steamId, pData] of players) {
          (cacheData['players'] as Record<string, unknown>)[steamId] = pData;
        }
      } else if (players && typeof players === 'object') {
        cacheData['players'] = players;
      }
      const cachePath = path.join(__dirname, '..', '..', 'data', 'save-cache.json');
      fs.writeFileSync(cachePath, JSON.stringify(cacheData), 'utf8');
    } catch (err: unknown) {
      this._log.error('Failed to write save-cache.json:', (err as Error).message);
    }
  }
}

export default SaveService;
export { SaveService };

// CJS compatibility — .js consumers use require('./save-service')
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _mod = module as { exports: any };

_mod.exports = SaveService;

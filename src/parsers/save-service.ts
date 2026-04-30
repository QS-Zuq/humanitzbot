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
import { logRejection } from '../utils/log-rejection.js';

import { errMsg } from '../utils/error.js';
import _rconDefault from '../rcon/rcon.js';
import _panelApiDefault from '../server/panel-api.js';
import { importSftpClient, importSsh2Client, importBuildAgentScript } from '../utils/dynamic-imports.js';
import type { HumanitZDB } from '../db/database.js';
import {
  SaveSyncPipeline,
  type SaveCacheData,
  type SaveParsedDataInput,
  type SaveSyncResult,
} from './save-sync-pipeline.js';
import type { SaveReadResult } from './save-reader-types.js';

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

// Module-scope references to singletons (always available as internal modules)
const _rconModule: RconModule | null = _rconDefault as unknown as RconModule; // SAFETY: module default import shape
const _panelApiModule: PanelApi | null = _panelApiDefault as unknown as PanelApi; // SAFETY: module default import shape

class SaveService extends EventEmitter {
  private _db: HumanitZDB;
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
  private _syncPipeline: SaveSyncPipeline;

  constructor(db: HumanitZDB, options: SaveServiceOptions = {}) {
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
    this._syncPipeline = new SaveSyncPipeline({
      db: this._db,
      log: this._log,
      getIdMap: () => this._idMap,
      getMode: () => this._mode ?? this._agentMode,
      getSyncCount: () => this._syncCount,
      readOldStateForDiff: () => this._readOldStateForDiff(),
      writeSaveCache: (parsed) => {
        this._writeSaveCache(parsed);
      },
      emitSync: (result) => {
        this.emit('sync', result);
      },
      shouldFetchClanData: () => !!this._clanSavePath,
      fetchClanData: () => this._fetchClanData(),
    });
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
      logRejection(this._poll(), this._log, `${this._log.label}:poll`);
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
      this._log.warn('Could not load cached ID map:', errMsg(err));
    }
  }

  _repairSteamIdNames(): void {
    if (Object.keys(this._idMap).length === 0) return;
    try {
      const fixed = this._db.activityLog.repairActorNames(this._idMap);
      if (fixed > 0) {
        this._log.info(`Repaired ${String(fixed)} activity_log row(s) with resolved player names`);
      }
    } catch (err: unknown) {
      this._log.warn('DB name repair failed (non-fatal):', errMsg(err));
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

  /** Return the resolved sync mode string (e.g. 'direct', 'sftp', 'panel'). */
  getSyncMode(): string {
    return this._mode ?? this._agentMode;
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
    let SFTPClient: Awaited<ReturnType<typeof importSftpClient>>;
    try {
      SFTPClient = await importSftpClient();
    } catch {
      throw new Error('ssh2-sftp-client not installed');
    }

    let buildAgentScript: Awaited<ReturnType<typeof importBuildAgentScript>>;
    try {
      buildAgentScript = await importBuildAgentScript();
    } catch (err: unknown) {
      throw new Error(`Failed to load agent-builder: ${errMsg(err)}`, { cause: err });
    }

    const script = buildAgentScript();
    const sftp = new SFTPClient();

    try {
      if (!this._sftpConfig) throw new Error('SFTP config is required for agent deployment');
      await sftp.connect(this._sftpConfig);
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
      await sftp.end();
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
      this._log.info(`SSH check failed: ${errMsg(err)}`);
    }
    this._agentCapable = false;
    return false;
  }

  async _sshExec(command: string): Promise<SshExecResult> {
    let SSHClient: Awaited<ReturnType<typeof importSsh2Client>>;
    try {
      SSHClient = await importSsh2Client();
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
      this._lastError = errMsg(err);
      this._log.error('Sync error:', errMsg(err));
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

    const parsed = parseSave(buf) as unknown as SaveParsedDataInput; // SAFETY: parseSave returns untyped game data structure
    let clans: unknown[] = [];
    if (clanBuf) {
      try {
        clans = parseClanData(clanBuf);
      } catch (err: unknown) {
        this._log.warn('Failed to parse clan data:', errMsg(err));
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
      this._log.warn(`Agent mode failed: ${errMsg(err)}`);
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
    if (!this._panelApi) throw new Error('Panel API not configured');
    this._log.info(`Sending panel command: "${this._agentPanelCommand}"`);
    await this._panelApi.sendCommand(this._agentPanelCommand);
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

  async _readSftp(force: boolean): Promise<SaveReadResult> {
    let SFTPClient: Awaited<ReturnType<typeof importSftpClient>>;
    try {
      SFTPClient = await importSftpClient();
    } catch {
      throw new Error('ssh2-sftp-client not installed — needed for SFTP polling');
    }

    const sftp = new SFTPClient();
    if (!this._sftpConfig) throw new Error('SFTP config is required for direct download');
    try {
      await sftp.connect(this._sftpConfig);
      const stat = await sftp.stat(this._savePath);
      const mtime = stat.modifyTime;
      if (!force && this._lastMtime && mtime === this._lastMtime) {
        return { saveBuf: null, clanBuf: null };
      }
      this._log.info('Downloading save file (direct mode)...');
      const saveBuf = (await sftp.get(this._savePath)) as Buffer;
      this._lastMtime = mtime;
      let clanBuf: Buffer | null = null;
      if (this._clanSavePath) {
        try {
          const clanStat = await sftp.stat(this._clanSavePath);
          if (!this._lastClanMtime || clanStat.modifyTime !== this._lastClanMtime) {
            clanBuf = (await sftp.get(this._clanSavePath)) as Buffer;
            this._lastClanMtime = clanStat.modifyTime;
          }
        } catch {
          /* Clan file may not exist yet */
        }
      }
      return { saveBuf, clanBuf };
    } finally {
      await sftp.end();
    }
  }

  _hasPanelApi(): boolean {
    if (this._panelApi) return this._panelApi.available !== false;
    if (!_panelApiModule) return false;
    this._panelApi = _panelApiModule;
    return !!this._panelApi.available;
  }

  async _readPanelApi(force: boolean): Promise<SaveReadResult> {
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
        this._log.warn('Panel file list failed (will download anyway):', errMsg(err));
      }
    }

    this._log.info('Downloading save file via Panel API (direct mode)...');
    const saveBuf: Buffer | null = (await api.downloadFile(this._savePath)) as Buffer | null;
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
    let SFTPClient: Awaited<ReturnType<typeof importSftpClient>>;
    try {
      SFTPClient = await importSftpClient();
    } catch {
      return undefined;
    }

    const sftp = new SFTPClient();
    if (!this._sftpConfig) return undefined;
    try {
      await sftp.connect(this._sftpConfig);
      let stat: { modifyTime: number };
      try {
        stat = await sftp.stat(this._cachePath);
      } catch {
        return null;
      }
      const mtime = stat.modifyTime;
      if (!force && this._lastCacheMtime && mtime === this._lastCacheMtime) return null;
      const buf = (await sftp.get(this._cachePath)) as Buffer;
      const json = buf.toString('utf-8');
      return this._parseCache(json, mtime);
    } finally {
      await sftp.end();
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
      this._log.warn('Panel cache read failed:', errMsg(err));
      return null;
    }
  }

  _parseCache(json: string, mtime: number | null): Record<string, unknown> | null {
    let cache: Record<string, unknown>;
    try {
      cache = JSON.parse(json) as Record<string, unknown>;
    } catch (err: unknown) {
      this._log.warn(`Invalid cache JSON: ${errMsg(err)}`);
      return null;
    }
    if (typeof cache['v'] !== 'number' || cache['v'] < 1) {
      this._log.warn(`Invalid or missing cache version (got ${String(cache['v'])})`);
      return null;
    }
    if (mtime) this._lastCacheMtime = mtime;
    const sizeMB = (json.length / 1024 / 1024).toFixed(2);
    this._log.info(
      `Downloaded cache: ${sizeMB}MB (${String(Object.keys((cache['players'] as Record<string, unknown> | undefined) ?? {}).length)} players)`,
    );
    return cache;
  }

  async _fetchClanData(): Promise<unknown[]> {
    if (this._sftpConfig) {
      let SFTPClient: Awaited<ReturnType<typeof importSftpClient>> | undefined;
      try {
        SFTPClient = await importSftpClient();
      } catch {
        /* ignore */
      }
      if (SFTPClient) {
        const sftp = new SFTPClient();
        try {
          await sftp.connect(this._sftpConfig);
          const clanStat = await sftp.stat(this._clanSavePath);
          if (!this._lastClanMtime || clanStat.modifyTime !== this._lastClanMtime) {
            const clanBuf = (await sftp.get(this._clanSavePath)) as Buffer;
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
    if (this._hasPanelApi() && this._panelApi) {
      try {
        const clanBuf: Buffer | null = (await this._panelApi.downloadFile(this._clanSavePath)) as Buffer | null;
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
    await this._syncPipeline.syncFromCache(cache as SaveCacheData);
  }

  _syncParsedData(parsed: SaveParsedDataInput, clans: unknown[]): SaveSyncResult {
    return this._syncPipeline.syncParsedData(parsed, clans);
  }

  _readOldStateForDiff(): Record<string, unknown> | null {
    if (this._syncCount === 0) return null;
    try {
      const containers = this._db.worldObject.getAllContainers();
      const horses = this._db.worldObject.getAllWorldHorses();
      const worldState = this._db.worldState.getAllWorldState();
      const vehiclesList = this._db.worldObject.getAllVehicles();
      const structuresList = this._db.worldObject.getStructures();
      let playersList: unknown[] = [];
      try {
        playersList = this._db.player.getOnlinePlayersForDiff();
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
      this._log.warn('Could not read old state for diff:', errMsg(err));
      return null;
    }
  }

  _writeSaveCache(parsed: Record<string, unknown>): void {
    try {
      const players = parsed['players'] as Map<string, unknown>;
      const cacheData: Record<string, unknown> = {
        updatedAt: new Date().toISOString(),
        playerCount: players.size,
        worldState: (parsed['worldState'] as Record<string, unknown> | undefined) ?? {},
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
      } else if (typeof players === 'object') {
        cacheData['players'] = players;
      }
      const cachePath = path.join(__dirname, '..', '..', 'data', 'save-cache.json');
      fs.writeFileSync(cachePath, JSON.stringify(cacheData), 'utf8');
    } catch (err: unknown) {
      this._log.error('Failed to write save-cache.json:', errMsg(err));
    }
  }
}

export default SaveService;
export { SaveService };

/**
 * Save-to-DB service for the HumanitZ bot.
 *
 * Orchestrates the save-file → database pipeline with three operating modes:
 *
 *   **Direct** (default): SFTP download of the full .sav file (~60MB), parsed locally.
 *   **Agent**:            Bot deploys a lightweight parser agent onto the game server.
 *                         The agent parses the save locally and writes a compact JSON
 *                         cache (~200-500KB).  Bot downloads only the small cache via SFTP.
 *   **Auto**:             Tries agent mode first, falls back to direct if the game
 *                         server doesn't have Node.js or SSH exec support.
 *
 * Agent execution strategies (agentTrigger):
 *   **rcon**:  Bot sends an RCON/console command (e.g. `createHZSocket` on Bisect)
 *              that tells the server to write a pre-parsed JSON cache file.
 *              Fastest path — no SFTP or SSH needed.  (Bisect Hosting)
 *   **panel**: Bot sends a console command through the Pterodactyl wrapper API.
 *              The host intercepts it and runs the parser. (BisectHosting model)
 *   **ssh**:   Bot uploads agent via SFTP, executes via SSH exec.
 *   **none**:  Bot never triggers the agent — assumes the host runs it externally
 *              (cron, systemd, Pterodactyl schedule, etc.).
 *   **auto**:  Tries RCON (if connected) → SSH → none.
 *
 * Usage:
 *   const SaveService = require('./save-service');
 *   const service = new SaveService(db, { sftpConfig, remotePath, agentMode: 'auto' });
 *   service.on('sync', (result) => { ... });
 *   service.start();
 *   service.stop();
 */

const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const { parseSave, parseClanData } = require('./save-parser');
const { diffSaveState } = require('../db/diff-engine');
const { reconcileItems } = require('../db/item-tracker');
const { createLogger } = require('../utils/log');

// Shell-safe single-quote escaping for SSH exec arguments
function shQuote(v) {
  const s = String(v);
  if (/[\0\r\n]/.test(s)) throw new Error('Invalid shell argument: contains null/newline');
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

class SaveService extends EventEmitter {
  /**
   * @param {import('../db/database')} db - Initialised HumanitZDB instance
   * @param {object} options
   * @param {object}  [options.sftpConfig]      - { host, port, username, password/privateKey }
   * @param {string}  [options.savePath]         - Remote path to Save_DedicatedSaveMP.sav
   * @param {string}  [options.clanSavePath]     - Remote path to Save_ClanData.sav (optional)
   * @param {string}  [options.localPath]        - Local file path (for testing / manual import)
   * @param {number}  [options.pollInterval]     - ms between polls (default: 60000 = 1 min)
   * @param {object}  [options.idMap]            - SteamID → name map from PlayerIDMapped.txt
   * @param {string}  [options.label]            - Log prefix
   * @param {string}  [options.agentMode]        - 'auto' | 'agent' | 'direct' (default: 'auto')
   * @param {string}  [options.agentNodePath]    - Path to node binary on game server (default: 'node')
   * @param {string}  [options.agentRemoteDir]   - Remote dir for agent upload (default: derived from savePath)
   * @param {string}  [options.agentCachePath]   - Explicit remote path to humanitz-cache.json (for host-managed agents)
   * @param {object}  [options.sshConfig]        - { host, port, username, password } for SSH exec (optional; defaults to SFTP creds)
   * @param {number}  [options.agentTimeout]     - Max ms to wait for agent execution (default: 120000)
   * @param {string}  [options.agentTrigger]     - 'auto' | 'rcon' | 'ssh' | 'panel' | 'none' (default: 'auto')
   * @param {string}  [options.agentPanelCommand] - Console/RCON command for trigger (default: 'createHZSocket')
   * @param {number}  [options.agentPanelDelay]   - ms to wait after trigger command before reading cache (default: 3000)
   * @param {object}  [options.panelApi]          - PanelApi instance for panel trigger (optional; auto-loaded if available)
   */
  constructor(db, options = {}) {
    super();
    this._db = db;
    this._sftpConfig = options.sftpConfig || null;
    this._savePath = options.savePath || '';
    this._clanSavePath = options.clanSavePath || '';
    this._localPath = options.localPath || '';
    this._pollInterval = options.pollInterval || 60_000;
    this._idMap = options.idMap || {};
    this._log = createLogger(options.label, 'SaveService');
    this._dataDir = options.dataDir || path.join(__dirname, '..', '..');

    // Auto-load cached PlayerIDMapped.txt if no idMap provided
    if (!options.idMap || Object.keys(this._idMap).length === 0) {
      this._loadLocalIdMap();
    }

    // Agent mode
    this._agentMode = options.agentMode || 'auto'; // 'auto' | 'agent' | 'direct'
    this._agentNodePath = options.agentNodePath || 'node';
    this._agentRemoteDir = options.agentRemoteDir || ''; // derive from savePath if empty
    this._agentCachePath = options.agentCachePath || ''; // explicit cache path (host-managed)
    this._sshConfig = options.sshConfig || null;
    this._agentTimeout = options.agentTimeout || 120_000;

    // Agent trigger strategy
    this._agentTrigger = options.agentTrigger || 'auto'; // 'auto' | 'rcon' | 'ssh' | 'panel' | 'none'
    this._agentPanelCommand = options.agentPanelCommand || 'createHZSocket';
    this._agentPanelDelay = options.agentPanelDelay ?? 3000;
    this._panelApi = options.panelApi || null; // must be explicitly injected; null = no Panel API
    this._rcon = null; // lazy-loaded rcon singleton

    // Internal state
    this._timer = null;
    this._lastMtime = null;
    this._lastClanMtime = null;
    this._lastCacheMtime = null;
    this._syncing = false;
    this._syncCount = 0;
    this._lastError = null;
    this._mode = null; // actual mode after auto-detection: 'agent' | 'direct'

    // Agent state
    this._agentDeployed = false;
    this._agentCapable = null; // null = unknown, true/false after probe
    this._panelCapable = null; // null = unknown, true/false after probe
    this._resolvedTrigger = null; // actual trigger after auto-detection
    this._agentPath = ''; // full remote path to uploaded agent
    this._cachePath = ''; // full remote path to humanitz-cache.json
    this._runScriptPath = ''; // full remote path to run-agent.sh
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Lifecycle
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Start polling for save file changes.
   * Does an immediate first sync, then polls at the configured interval.
   */
  async start() {
    this._resolvePaths();

    // One-time DB repair: fix activity_log rows where actor_name is a raw SteamID
    this._repairSteamIdNames();

    const modeLabel =
      this._agentMode === 'direct'
        ? 'direct'
        : `${this._agentMode} (agent-capable: ${this._agentCapable ?? 'unknown'})`;
    this._log.info(`Starting save service — mode: ${modeLabel}, poll every ${this._pollInterval / 1000}s`);
    await this._poll();
    this._timer = setInterval(() => this._poll(), this._pollInterval);
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this._log.info(`Stopped (${this._syncCount} syncs, mode: ${this._mode || this._agentMode})`);
  }

  /** Force an immediate sync (for slash commands, etc.). */
  async forceSync() {
    return this._poll(true);
  }

  /** Update the ID map (called externally when PlayerIDMapped.txt is refreshed). */
  setIdMap(idMap) {
    this._idMap = idMap;
  }

  /**
   * Load PlayerIDMapped.txt from the local data/ cache.
   * Called on construction so names resolve from the very first sync.
   */
  _loadLocalIdMap() {
    try {
      const filePath = path.join(this._dataDir, 'data', 'logs', 'PlayerIDMapped.txt');
      // Also check per-server location (dataDir IS the data dir for multi-server)
      const altPath = path.join(this._dataDir, 'logs', 'PlayerIDMapped.txt');
      const actualPath = fs.existsSync(filePath) ? filePath : fs.existsSync(altPath) ? altPath : null;
      if (!actualPath) return;
      const raw = fs.readFileSync(actualPath, 'utf8');
      const map = {};
      let count = 0;
      for (const line of raw.split(/\r?\n/)) {
        const m = line.trim().match(/^(\d{17})_\+_\|[^@]+@(.+)$/);
        if (m) {
          map[m[1]] = m[2].trim();
          count++;
        }
      }
      if (count > 0) {
        this._idMap = map;
        this._log.info(`Loaded ${count} name(s) from cached PlayerIDMapped.txt`);
      }
    } catch (err) {
      // Non-critical — file may not exist yet
      this._log.warn('Could not load cached ID map:', err.message);
    }
  }

  /**
   * One-time repair: update activity_log rows where actor_name is a raw SteamID
   * (17-digit number) and we now have a proper name from the ID map.
   */
  _repairSteamIdNames() {
    if (!this._db || Object.keys(this._idMap).length === 0) return;
    try {
      const db = this._db.db || this._db._db || this._db;
      if (typeof db.prepare !== 'function') return;

      const rows = db
        .prepare(
          `SELECT DISTINCT actor FROM activity_log
         WHERE actor_name = actor AND actor GLOB '[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'`,
        )
        .all();

      let fixed = 0;
      const stmt = db.prepare('UPDATE activity_log SET actor_name = ? WHERE actor = ? AND actor_name = actor');

      for (const row of rows) {
        const name = this._idMap[row.actor];
        if (name) {
          const info = stmt.run(name, row.actor);
          fixed += info.changes;
        }
      }

      if (fixed > 0) {
        this._log.info(`Repaired ${fixed} activity_log row(s) with resolved player names`);
      }
    } catch (err) {
      this._log.warn('DB name repair failed (non-fatal):', err.message);
    }
  }

  get stats() {
    return {
      syncCount: this._syncCount,
      lastError: this._lastError,
      lastMtime: this._lastMtime,
      syncing: this._syncing,
      mode: this._mode || this._agentMode,
      agentDeployed: this._agentDeployed,
      agentCapable: this._agentCapable,
      panelCapable: this._panelCapable,
      panelFileApi: this._hasPanelApi(),
      trigger: this._resolvedTrigger || this._agentTrigger,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Path resolution
  // ═══════════════════════════════════════════════════════════════════════════

  _resolvePaths() {
    if (this._savePath) {
      // Derive agent remote dir and cache path from save path
      const dir = this._agentRemoteDir || this._savePath.replace(/[/\\][^/\\]+$/, '');
      this._agentRemoteDir = dir;
      this._agentPath = dir + '/humanitz-agent.js';
      this._cachePath = this._agentCachePath || dir + '/humanitz-cache.json';
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Agent deployment & execution
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Deploy the agent script to the game server via SFTP.
   * Generates the script on-the-fly from the current parser source.
   */
  async deployAgent() {
    let SFTPClient;
    try {
      SFTPClient = require('ssh2-sftp-client');
    } catch {
      throw new Error('ssh2-sftp-client not installed');
    }

    let buildAgentScript;
    try {
      ({ buildAgentScript } = require('./agent-builder'));
    } catch (err) {
      throw new Error(`Failed to load agent-builder: ${err.message}`, { cause: err });
    }

    const script = buildAgentScript();
    const sftp = new SFTPClient();

    try {
      await sftp.connect(this._sftpConfig);
      await sftp.put(Buffer.from(script, 'utf-8'), this._agentPath);
      this._agentDeployed = true;
      this._log.info(`Agent deployed → ${this._agentPath} (${(script.length / 1024).toFixed(1)}KB)`);

      const runScript = this._generateRunScript();
      this._runScriptPath = path.dirname(this._agentPath) + '/run-agent.sh';
      await sftp.put(Buffer.from(runScript, 'utf-8'), this._runScriptPath);
      this._log.info(`Runner script deployed → ${this._runScriptPath}`);
    } finally {
      sftp.end();
    }
  }

  _generateRunScript() {
    const lines = [
      '#!/bin/bash',
      'exec ' + shQuote(this._agentNodePath) + ' ' + shQuote(this._agentPath) + ' --save ' + shQuote(this._savePath),
    ];
    return lines.join('\n') + '\n';
  }

  /**
   * Execute the agent on the game server via SSH.
   * Returns the parsed stdout/stderr and exit code.
   */
  async executeAgent() {
    const scriptPath = this._runScriptPath || path.dirname(this._agentPath) + '/run-agent.sh';
    this._log.info(`Executing agent via runner script: ${scriptPath}`);
    const result = await this._sshExec('bash ' + shQuote(scriptPath));

    if (result.code !== 0) {
      const msg = (result.stderr || result.stdout || '').trim().slice(0, 300);
      throw new Error(`Agent exited with code ${result.code}: ${msg}`);
    }

    this._log.info(`Agent output: ${result.stdout.trim().slice(0, 200)}`);
    return result;
  }

  /**
   * Check if Node.js is available on the game server via SSH.
   * Caches the result in this._agentCapable.
   */
  async checkNodeAvailable() {
    try {
      const result = await this._sshExec('node --version');
      const version = (result.stdout || '').trim();
      if (result.code === 0 && version.startsWith('v')) {
        this._agentCapable = true;
        this._log.info(`Node.js available on game server: ${version}`);
        return true;
      }
    } catch (err) {
      this._log.info(`SSH check failed: ${err.message}`);
    }
    this._agentCapable = false;
    return false;
  }

  /**
   * Execute a command on the game server via SSH.
   * @param {string} command
   * @returns {Promise<{code: number, stdout: string, stderr: string}>}
   */
  async _sshExec(command) {
    let SSHClient;
    try {
      ({ Client: SSHClient } = require('ssh2'));
    } catch {
      throw new Error('ssh2 not installed — needed for SSH exec');
    }

    const config = this._sshConfig || this._buildSshConfig();
    if (!config || !config.host) {
      throw new Error('No SSH config available (need FTP_HOST + FTP_USER + FTP_PASSWORD)');
    }

    return new Promise((resolve, reject) => {
      const conn = new SSHClient();
      let stdout = '',
        stderr = '';
      const timer = setTimeout(() => {
        conn.end();
        reject(new Error(`SSH exec timed out after ${this._agentTimeout}ms`));
      }, this._agentTimeout);

      conn.on('ready', () => {
        conn.exec(command, (err, stream) => {
          if (err) {
            clearTimeout(timer);
            conn.end();
            return reject(err);
          }
          stream.on('data', (d) => {
            stdout += d;
          });
          stream.stderr.on('data', (d) => {
            stderr += d;
          });
          stream.on('close', (code) => {
            clearTimeout(timer);
            conn.end();
            resolve({ code: code ?? 1, stdout, stderr });
          });
        });
      });

      conn.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });

      conn.connect(config);
    });
  }

  /**
   * Build SSH config from SFTP credentials.
   * SFTP runs over SSH, so the same creds usually work.
   */
  _buildSshConfig() {
    if (!this._sftpConfig) return null;
    return {
      host: this._sftpConfig.host,
      port: this._sftpConfig.sshPort || this._sftpConfig.port || 22,
      username: this._sftpConfig.username,
      password: this._sftpConfig.password,
      privateKey: this._sftpConfig.privateKey,
      readyTimeout: 10000,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Polling
  // ═══════════════════════════════════════════════════════════════════════════

  async _poll(force = false) {
    if (this._syncing) return;
    this._syncing = true;

    try {
      // Local mode always uses direct (for testing / manual import)
      if (this._localPath) {
        await this._pollDirect(force);
        return;
      }

      // Choose mode
      if (this._agentMode === 'direct') {
        await this._pollDirect(force);
      } else {
        const agentOk = await this._pollAgent(force);
        if (!agentOk && this._agentMode === 'auto') {
          // Fallback to direct download
          if (!this._mode || this._mode === 'direct') {
            this._log.info('Agent unavailable — falling back to direct .sav download');
          }
          this._mode = 'direct';
          await this._pollDirect(force);
        } else if (agentOk) {
          this._mode = 'agent';
        }
      }
    } catch (err) {
      this._lastError = err.message;
      this._log.error('Sync error:', err.message);
      this.emit('error', err);
    } finally {
      this._syncing = false;
    }
  }

  /**
   * Direct mode: download full .sav via SFTP, Panel File API, or local file, then parse and sync.
   */
  async _pollDirect(force) {
    let buf = null;
    let clanBuf = null;

    if (this._localPath) {
      buf = await this._readLocal(this._localPath, force);
      if (this._clanSavePath) {
        clanBuf = await this._readLocal(this._clanSavePath, force);
      }
    } else if (this._sftpConfig && this._savePath) {
      const result = await this._readSftp(force);
      buf = result.saveBuf;
      clanBuf = result.clanBuf;
    } else if (this._hasPanelApi() && this._savePath) {
      // No SFTP credentials — try Panel File API (Bisect Hosting, etc.)
      const result = await this._readPanelApi(force);
      buf = result.saveBuf;
      clanBuf = result.clanBuf;
    }

    if (!buf) return; // no changes

    const parsed = parseSave(buf);
    let clans = [];
    if (clanBuf) {
      try {
        clans = parseClanData(clanBuf);
      } catch (err) {
        this._log.warn('Failed to parse clan data:', err.message);
      }
    }

    await this._syncParsedData(parsed, clans);
    this._syncCount++;
    this._lastError = null;
  }

  /**
   * Agent mode: check for cache file → trigger agent if needed → read cache.
   *
   * Trigger strategies (this._agentTrigger):
   *   'panel' — send a Pterodactyl console command (BisectHosting wrapper)
   *   'ssh'   — upload agent via SFTP, execute via SSH
   *   'none'  — never trigger, just check for cache (host runs agent externally)
   *   'auto'  — try panel → ssh → none, remembering what works
   *
   * @returns {boolean} true if sync succeeded via agent, false if agent is unavailable
   */
  async _pollAgent(force) {
    try {
      // ── Step 1: Check for an existing fresh cache ──
      const cache = await this._readCacheFromSftp(force);
      if (cache) {
        await this._syncFromCache(cache);
        this._syncCount++;
        this._lastError = null;
        return true;
      }

      // ── Step 2: Resolve trigger strategy (once) ──
      const trigger = await this._resolveTrigger();

      // ── Step 3: Trigger the agent based on strategy ──
      if (trigger === 'rcon') {
        await this._triggerViaRcon();
      } else if (trigger === 'panel') {
        await this._triggerViaPanel();
      } else if (trigger === 'ssh') {
        if (!this._agentDeployed) await this.deployAgent();
        await this.executeAgent();
      } else {
        // trigger === 'none' — nothing to do, cache wasn't there
        return false;
      }

      // ── Step 4: Read the freshly-written cache ──
      const freshCache = await this._readCacheFromSftp(true);
      if (freshCache) {
        await this._syncFromCache(freshCache);
        this._syncCount++;
        this._lastError = null;
        return true;
      }

      this._log.warn(`Agent triggered (${trigger}) but cache not found at ${this._cachePath}`);
      return false;
    } catch (err) {
      this._log.warn(`Agent mode failed: ${err.message}`);
      return false;
    }
  }

  /**
   * Resolve which trigger strategy to use.  Called once and cached.
   * @returns {Promise<'rcon'|'panel'|'ssh'|'none'>}
   */
  async _resolveTrigger() {
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

    // ── 'auto' — probe in priority order ──
    // RCON trigger (createHZSocket) only works on Pterodactyl hosts (Bisect) where
    // the panel wrapper intercepts the command. On a VPS/self-hosted server, RCON is
    // connected but the game server doesn't understand createHZSocket — so we only
    // pick RCON trigger when a Panel API is also configured (strong signal of Pterodactyl).

    // 1. Try RCON trigger — but only if Panel API is configured (Pterodactyl/Bisect)
    if (this._isRconAvailable() && this._checkPanelAvailable()) {
      this._log.info('Auto-selected RCON trigger (Panel API detected — Pterodactyl host)');
      this._resolvedTrigger = 'rcon';
      return 'rcon';
    }

    // 2. Try SSH (VPS / self-hosted — the normal agent path)
    if (this._agentCapable === null) await this.checkNodeAvailable();
    if (this._agentCapable) {
      this._log.info('Auto-selected SSH trigger');
      this._resolvedTrigger = 'ssh';
      return 'ssh';
    }

    // 3. RCON available but no Panel API and no SSH — skip agent entirely.
    //    Don't try createHZSocket on a non-Pterodactyl server.
    if (this._isRconAvailable()) {
      this._log.info('RCON available but no Panel API or SSH — agent trigger skipped');
    } else {
      this._log.info('No RCON, Panel API, or SSH available — will check for host-managed cache only');
    }
    this._resolvedTrigger = 'none';
    return 'none';
  }

  /**
   * Check if the Pterodactyl Panel API is configured and available.
   */
  _checkPanelAvailable() {
    if (this._panelCapable !== null) return this._panelCapable;

    // Only use an explicitly-injected panel API. Do NOT auto-require the module
    // singleton here — it would return `.available = true` on any host where
    // PANEL_API_KEY is configured (e.g. VPS with RCON), causing the RCON trigger
    // to be selected instead of SSH even though there is no Pterodactyl panel.
    if (!this._panelApi) {
      this._panelCapable = false;
      return false;
    }

    this._panelCapable = !!this._panelApi.available;
    return this._panelCapable;
  }

  /**
   * Check if RCON is connected and can send commands.
   */
  _isRconAvailable() {
    if (!this._rcon) {
      try {
        this._rcon = require('../rcon/rcon');
      } catch {
        return false;
      }
    }
    return this._rcon && this._rcon.connected;
  }

  /**
   * Trigger cache generation via RCON command (e.g. createHZSocket).
   * The game server writes humanitz-cache.json directly — fastest path.
   * We wait a configurable delay for the server to finish writing the cache.
   */
  async _triggerViaRcon() {
    if (!this._rcon) {
      try {
        this._rcon = require('../rcon/rcon');
      } catch {
        throw new Error('RCON module not available');
      }
    }
    this._log.info(`Sending RCON command: "${this._agentPanelCommand}"`);
    await this._rcon.send(this._agentPanelCommand);

    // Wait for the server to write the cache file
    if (this._agentPanelDelay > 0) {
      await new Promise((r) => setTimeout(r, this._agentPanelDelay));
    }
  }

  /**
   * Trigger the agent via a Pterodactyl panel console command.
   * The host wrapper intercepts this command and runs the parser.
   * We wait a configurable delay for the host to finish writing the cache.
   */
  async _triggerViaPanel() {
    this._log.info(`Sending panel command: "${this._agentPanelCommand}"`);
    await this._panelApi.sendCommand(this._agentPanelCommand);

    // Wait for the host to parse + write the cache
    if (this._agentPanelDelay > 0) {
      await new Promise((r) => setTimeout(r, this._agentPanelDelay));
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Data reading
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Read a local file.  Returns the buffer if file has changed since last read
   * (based on mtime), or null if unchanged.  force=true ignores mtime check.
   */
  async _readLocal(filePath, force) {
    const resolvedPath = path.resolve(filePath);
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`Save file not found: ${resolvedPath}`);
    }

    const stat = fs.statSync(resolvedPath);
    const mtime = stat.mtimeMs;

    if (!force && this._lastMtime && mtime === this._lastMtime) {
      return null; // no changes
    }

    this._lastMtime = mtime;
    return fs.readFileSync(resolvedPath);
  }

  /**
   * Read from SFTP.  Returns { saveBuf, clanBuf } or { saveBuf: null }
   * if the save file hasn't changed since the last poll.
   */
  async _readSftp(force) {
    let SFTPClient;
    try {
      SFTPClient = require('ssh2-sftp-client');
    } catch {
      throw new Error('ssh2-sftp-client not installed — needed for SFTP polling');
    }

    const sftp = new SFTPClient();
    try {
      await sftp.connect(this._sftpConfig);

      // Check mtime first to avoid downloading unchanged files
      const stat = await sftp.stat(this._savePath);
      const mtime = stat.modifyTime;

      if (!force && this._lastMtime && mtime === this._lastMtime) {
        return { saveBuf: null, clanBuf: null };
      }

      this._log.info('Downloading save file (direct mode)...');
      const saveBuf = await sftp.get(this._savePath);
      this._lastMtime = mtime;

      let clanBuf = null;
      if (this._clanSavePath) {
        try {
          const clanStat = await sftp.stat(this._clanSavePath);
          if (!this._lastClanMtime || clanStat.modifyTime !== this._lastClanMtime) {
            clanBuf = await sftp.get(this._clanSavePath);
            this._lastClanMtime = clanStat.modifyTime;
          }
        } catch {
          // Clan file may not exist yet — that's fine
        }
      }

      return { saveBuf, clanBuf };
    } finally {
      sftp.end();
    }
  }

  /**
   * Check if the Panel File API is available for downloading files.
   * Lazy-loads panel-api if not injected.
   */
  _hasPanelApi() {
    if (this._panelApi) return this._panelApi.available !== false;
    try {
      this._panelApi = require('../server/panel-api');
      return !!this._panelApi.available;
    } catch {
      return false;
    }
  }

  /**
   * Read save file via Panel File API (Pterodactyl hosts like Bisect).
   *
   * Uses the Panel API file list to check mtime (avoiding unnecessary
   * downloads), then downloads the save as a binary buffer via a signed URL.
   *
   * This is the fallback when SFTP isn't configured but the Panel API is.
   * @param {boolean} force - Skip mtime check and always download
   * @returns {Promise<{saveBuf: Buffer|null, clanBuf: Buffer|null}>}
   */
  async _readPanelApi(force) {
    const api = this._panelApi;
    if (!api || !api.available) {
      throw new Error('Panel API not available');
    }

    // Check mtime via file list to avoid downloading unchanged files
    const saveDir = this._savePath.replace(/[/\\][^/\\]+$/, '') || '/';
    const saveFilename = this._savePath.split(/[/\\]/).pop();

    if (!force) {
      try {
        const files = await api.listFiles(saveDir);
        const saveFile = files.find((f) => f.name === saveFilename);
        if (saveFile && saveFile.modified_at) {
          const mtime = new Date(saveFile.modified_at).getTime();
          if (this._lastMtime && mtime === this._lastMtime) {
            return { saveBuf: null, clanBuf: null };
          }
          // Store mtime for next check — set BEFORE download so a failed
          // download doesn't cause an infinite retry loop
          this._lastMtime = mtime;
        }
      } catch (err) {
        this._log.warn('Panel file list failed (will download anyway):', err.message);
      }
    }

    this._log.info('Downloading save file via Panel API (direct mode)...');
    const saveBuf = await api.downloadFile(this._savePath);
    if (!saveBuf || saveBuf.length === 0) {
      throw new Error('Empty save file downloaded from Panel API');
    }

    // Update mtime after successful download if force was used
    if (force) {
      try {
        const files = await api.listFiles(saveDir);
        const saveFile = files.find((f) => f.name === saveFilename);
        if (saveFile && saveFile.modified_at) {
          this._lastMtime = new Date(saveFile.modified_at).getTime();
        }
      } catch {
        /* non-critical */
      }
    }

    // Try to download clan save too
    let clanBuf = null;
    if (this._clanSavePath) {
      try {
        const clanDir = this._clanSavePath.replace(/[/\\][^/\\]+$/, '') || '/';
        const clanFilename = this._clanSavePath.split(/[/\\]/).pop();

        let shouldDownload = true;
        if (!force) {
          try {
            const clanFiles = await api.listFiles(clanDir);
            const clanFile = clanFiles.find((f) => f.name === clanFilename);
            if (clanFile && clanFile.modified_at) {
              const mtime = new Date(clanFile.modified_at).getTime();
              if (this._lastClanMtime && mtime === this._lastClanMtime) {
                shouldDownload = false;
              } else {
                this._lastClanMtime = mtime;
              }
            }
          } catch {
            /* download anyway */
          }
        }

        if (shouldDownload) {
          clanBuf = await api.downloadFile(this._clanSavePath);
        }
      } catch {
        // Clan file may not exist — that's fine
      }
    }

    const sizeMB = (saveBuf.length / 1024 / 1024).toFixed(2);
    this._log.info(`Downloaded ${sizeMB}MB save via Panel API`);
    return { saveBuf, clanBuf };
  }

  /**
   * Read the agent's JSON cache file from SFTP or Panel File API.
   * Returns the parsed cache object if the cache is fresh, or null.
   */
  async _readCacheFromSftp(force) {
    // Try SFTP first (preferred — faster, no URL signing overhead)
    if (this._sftpConfig && this._cachePath) {
      const result = await this._readCacheViaSftp(force);
      if (result !== undefined) return result; // null = no changes, object = cache data
    }

    // Fallback to Panel File API
    if (this._hasPanelApi() && this._cachePath) {
      return this._readCacheViaPanelApi(force);
    }

    return null;
  }

  /**
   * Read cache file via SFTP.
   * @returns {Promise<object|null|undefined>} cache object, null (no changes), or undefined (SFTP not available)
   */
  async _readCacheViaSftp(force) {
    let SFTPClient;
    try {
      SFTPClient = require('ssh2-sftp-client');
    } catch {
      return undefined;
    }

    const sftp = new SFTPClient();
    try {
      await sftp.connect(this._sftpConfig);

      // Check if cache file exists
      let stat;
      try {
        stat = await sftp.stat(this._cachePath);
      } catch {
        return null;
      } // file doesn't exist

      const mtime = stat.modifyTime;

      // Skip if we already synced this version
      if (!force && this._lastCacheMtime && mtime === this._lastCacheMtime) {
        return null;
      }

      // Download the small cache file
      const buf = await sftp.get(this._cachePath);
      const json = buf.toString('utf-8');

      return this._parseCache(json, mtime);
    } finally {
      sftp.end();
    }
  }

  /**
   * Read cache file via Panel File API.
   * @returns {Promise<object|null>} cache object or null
   */
  async _readCacheViaPanelApi(force) {
    const api = this._panelApi;
    if (!api || !api.available) return null;

    try {
      // Check mtime via file list
      const cacheDir = this._cachePath.replace(/[/\\][^/\\]+$/, '') || '/';
      const cacheFilename = this._cachePath.split(/[/\\]/).pop();

      const files = await api.listFiles(cacheDir);
      const cacheFile = files.find((f) => f.name === cacheFilename);
      if (!cacheFile) return null;

      const mtime = cacheFile.modified_at ? new Date(cacheFile.modified_at).getTime() : null;
      if (!force && mtime && this._lastCacheMtime && mtime === this._lastCacheMtime) {
        return null;
      }

      // Cache files are small text JSON — use readFile (text) instead of downloadFile (binary)
      const json = await api.readFile(this._cachePath);
      return this._parseCache(json, mtime);
    } catch (err) {
      this._log.warn('Panel cache read failed:', err.message);
      return null;
    }
  }

  /**
   * Parse and validate a cache JSON string.
   * @returns {object|null} Parsed cache object or null on invalid data
   */
  _parseCache(json, mtime) {
    let cache;
    try {
      cache = JSON.parse(json);
    } catch (err) {
      this._log.warn(`Invalid cache JSON: ${err.message}`);
      return null;
    }

    // Validate cache version — accept any v >= 1 for forward-compatibility
    if (!cache || typeof cache.v !== 'number' || cache.v < 1) {
      this._log.warn(`Invalid or missing cache version (got ${cache?.v})`);
      return null;
    }

    if (mtime) this._lastCacheMtime = mtime;
    const sizeMB = (json.length / 1024 / 1024).toFixed(2);
    this._log.info(`Downloaded cache: ${sizeMB}MB (${Object.keys(cache.players || {}).length} players)`);

    return cache;
  }

  /**
   * Fetch clan save data via SFTP or Panel API.
   * Used by _syncFromCache when clan save path is set.
   * @returns {Promise<Array>} Parsed clan data or empty array
   */
  async _fetchClanData() {
    // Try SFTP first
    if (this._sftpConfig) {
      let SFTPClient;
      try {
        SFTPClient = require('ssh2-sftp-client');
      } catch {
        /* ignore */
      }
      if (SFTPClient) {
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

    // Fallback to Panel File API
    if (this._hasPanelApi()) {
      try {
        const clanBuf = await this._panelApi.downloadFile(this._clanSavePath);
        if (clanBuf && clanBuf.length > 0) {
          return parseClanData(clanBuf);
        }
      } catch {
        /* Clan file may not exist */
      }
    }

    return [];
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Data sync
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Sync from the agent's JSON cache into the database.
   * Converts the plain-object format back to what _syncParsedData expects.
   */
  async _syncFromCache(cache) {
    // Convert players object back to Map
    const players = new Map();
    for (const [steamId, data] of Object.entries(cache.players || {})) {
      players.set(steamId, data);
    }

    const parsed = {
      players,
      worldState: cache.worldState || {},
      structures: cache.structures || [],
      vehicles: cache.vehicles || [],
      companions: cache.companions || [],
      deadBodies: cache.deadBodies || [],
      containers: cache.containers || [],
      lootActors: cache.lootActors || [],
      quests: cache.quests || [],
      horses: cache.horses || [],
    };

    // Agent cache doesn't include clan data — fetch it separately via SFTP or Panel API
    let clans = [];
    if (this._clanSavePath) {
      clans = await this._fetchClanData();
    }

    await this._syncParsedData(parsed, clans);
  }

  /**
   * Core sync: write parsed data into the database and emit events.
   * Shared by both direct mode (after parseSave) and agent mode (after cache read).
   *
   * Runs the diff engine to detect changes (item movements, horse changes,
   * world events) and writes activity_log entries before replacing the data.
   */
  async _syncParsedData(parsed, clans) {
    const startTime = Date.now();

    // Resolve player names from ID map
    for (const [steamId, data] of parsed.players) {
      if (this._idMap[steamId]) {
        data.name = this._idMap[steamId];
      }
    }

    // ── Diff engine: compare old state with new, generate activity log ──
    let diffEvents = [];
    const isFirstSync = this._syncCount === 0;
    try {
      const oldState = this._readOldStateForDiff();
      // Skip diff on first sync after restart — the "old state" from DB will differ
      // massively from live state, generating thousands of spurious events (OOM risk).
      if (oldState && !isFirstSync) {
        const newState = {
          containers: parsed.containers || [],
          horses: parsed.horses || [],
          players: parsed.players,
          worldState: parsed.worldState || {},
          vehicles: parsed.vehicles || [],
          structures: parsed.structures || [],
        };
        const nameResolver = (steamId) => {
          const p = parsed.players.get(steamId);
          return p?.name || this._idMap[steamId] || steamId;
        };
        diffEvents = diffSaveState(oldState, newState, nameResolver);
      }
    } catch (err) {
      this._log.warn('Diff engine error (non-fatal):', err.message);
    }

    // ── Write all data to DB ──

    // Build world drops array outside the transaction
    const worldDrops = [];
    try {
      const ws = parsed.worldState || {};

      // LOD Pickups — items on the ground
      if (ws.lodPickups) {
        for (const p of ws.lodPickups) {
          worldDrops.push({
            type: 'pickup',
            actorName: '',
            item: p.item,
            amount: p.amount || 1,
            durability: p.durability || 0,
            items: [],
            worldLoot: p.worldLoot,
            placed: p.placed,
            spawned: p.spawned,
            x: p.x,
            y: p.y,
            z: p.z,
          });
        }
      }

      // Dropped backpacks
      if (ws.droppedBackpacks) {
        for (let i = 0; i < ws.droppedBackpacks.length; i++) {
          const bp = ws.droppedBackpacks[i];
          worldDrops.push({
            type: 'backpack',
            actorName: `backpack_${i}`,
            item: '',
            amount: 0,
            durability: 0,
            items: bp.items || [],
            x: bp.x,
            y: bp.y,
            z: bp.z,
          });
        }
      }

      // Global containers (houses, stores, etc.)
      if (ws.globalContainers) {
        for (const gc of ws.globalContainers) {
          worldDrops.push({
            type: 'global_container',
            actorName: gc.actorName || '',
            item: '',
            amount: 0,
            durability: 0,
            items: gc.items || [],
            locked: gc.locked,
            doesSpawnLoot: gc.doesSpawnLoot,
            x: gc.x ?? null,
            y: gc.y ?? null,
            z: gc.z ?? null,
          });
        }
      }
    } catch (err) {
      this._log.warn('World drops build error (non-fatal):', err.message);
    }

    // Sync everything into the database in ONE atomic transaction
    this._db.syncAllFromSave({
      players: parsed.players,
      worldState: parsed.worldState,
      structures: parsed.structures,
      vehicles: parsed.vehicles,
      companions: parsed.companions,
      clans,
      deadBodies: parsed.deadBodies,
      containers: parsed.containers,
      lootActors: parsed.lootActors,
      quests: parsed.quests,
      horses: parsed.horses,
      worldDrops: worldDrops.length > 0 ? worldDrops : null,
    });

    // ── Item instance tracking (fingerprint reconciliation) ──
    let itemStats = null;
    try {
      const nameResolver = (steamId) => {
        const p = parsed.players.get(steamId);
        return p?.name || this._idMap[steamId] || steamId;
      };
      itemStats = reconcileItems(
        this._db,
        {
          players: parsed.players,
          containers: parsed.containers || [],
          vehicles: parsed.vehicles || [],
          horses: parsed.horses || [],
          structures: parsed.structures || [],
          worldState: parsed.worldState || {},
        },
        nameResolver,
      );

      // Periodic cleanup of old lost items
      if (this._syncCount % 100 === 0) {
        this._db.purgeOldLostItems('-7 days');
        this._db.purgeOldLostGroups('-7 days');
        this._db.purgeOldMovements('-30 days');
      }
    } catch (err) {
      this._log.warn('Item tracker error (non-fatal):', err.message);
    }

    // ── Write activity log entries from diff ──
    if (diffEvents.length > 0) {
      try {
        this._db.insertActivities(diffEvents);
        this._log.info(`Activity log: ${diffEvents.length} events recorded`);
      } catch (err) {
        this._log.warn('Failed to write activity log:', err.message);
      }
    }

    // Purge old activity entries (keep 30 days)
    try {
      this._db.purgeOldActivity('-30 days');
    } catch {
      /* ignore */
    }

    // Update meta timestamps
    this._db.setMeta('last_save_sync', new Date().toISOString());
    this._db.setMeta('last_save_players', String(parsed.players.size));

    const elapsed = Date.now() - startTime;
    const mode = this._mode || this._agentMode;
    const horsesLabel = parsed.horses?.length ? `, ${parsed.horses.length} horses` : '';
    const containersLabel = parsed.containers?.length ? `, ${parsed.containers.length} containers` : '';
    const activityLabel = diffEvents.length ? `, ${diffEvents.length} activity events` : '';
    const itemLabel = itemStats
      ? `, items: ${itemStats.matched}m/${itemStats.created}c/${itemStats.moved}v/${itemStats.lost}l` +
        (itemStats.groups
          ? ` grp: ${itemStats.groups.matched}m/${itemStats.groups.created}c/${itemStats.groups.adjusted}a/${itemStats.groups.transferred}t/${itemStats.groups.lost}l`
          : '')
      : '';
    this._log.info(
      `Sync complete (${mode}): ${parsed.players.size} players, ${parsed.structures.length} structures, ${parsed.vehicles.length} vehicles, ${clans.length} clans${horsesLabel}${containersLabel}${activityLabel}${itemLabel} (${elapsed}ms)`,
    );

    // Write save-cache.json for web map consumption BEFORE emitting sync,
    // while parsed data is in scope.  Writing here (instead of in a sync listener)
    // avoids creating a second large copy of the parsed data in memory.
    this._writeSaveCache(parsed);

    // Emit event with summary so other modules can react
    const result = {
      playerCount: parsed.players.size,
      structureCount: parsed.structures.length,
      vehicleCount: parsed.vehicles.length,
      companionCount: parsed.companions.length,
      clanCount: clans.length,
      horseCount: parsed.horses?.length || 0,
      containerCount: parsed.containers?.length || 0,
      activityEvents: diffEvents.length,
      itemTracking: itemStats,
      worldState: parsed.worldState,
      elapsed,
      steamIds: [...parsed.players.keys()],
      mode,
      diffEvents, // pass to listeners for real-time Discord updates
      syncTime: new Date(), // timestamp for activity log event display
      // Parsed data for timeline snapshots & module sync.
      // This is a REFERENCE, not a copy — listeners must not mutate.
      parsed: {
        players: parsed.players,
        structures: parsed.structures,
        vehicles: parsed.vehicles,
        companions: parsed.companions,
        horses: parsed.horses || [],
        containers: parsed.containers || [],
      },
    };

    this.emit('sync', result);
    return result;
  }

  /**
   * Read previous state from DB for diff comparison.
   * Returns null on first sync (no previous data).
   */
  _readOldStateForDiff() {
    // Only diff after first successful sync
    if (this._syncCount === 0) return null;

    try {
      const containers = this._db.getAllContainers ? this._db.getAllContainers() : [];
      const horses = this._db.getAllWorldHorses ? this._db.getAllWorldHorses() : [];
      const worldState = this._db.getAllWorldState ? this._db.getAllWorldState() : {};
      const vehicles = this._db.getAllVehicles ? this._db.getAllVehicles() : [];
      const structures = this._db.getStructures ? this._db.getStructures() : [];

      // Read only online player inventories — lightweight query for diff engine
      // (10 columns + 4 JSON parses vs full 133 columns + 27 JSON parses)
      let players = [];
      try {
        players = this._db.getOnlinePlayersForDiff ? this._db.getOnlinePlayersForDiff() : [];
      } catch {
        /* empty */
      }

      return { containers, horses, players, worldState, vehicles, structures };
    } catch (err) {
      this._log.warn('Could not read old state for diff:', err.message);
      return null;
    }
  }

  /**
   * Write save-cache.json for web map consumption.
   * Called inside _syncParsedData() while parsed data is still in scope,
   * avoiding the need for sync listeners to create copies.
   * @param {object} parsed - The full parsed save data
   */
  _writeSaveCache(parsed) {
    try {
      const cacheData = {
        updatedAt: new Date().toISOString(),
        playerCount: parsed.players.size,
        worldState: parsed.worldState || {},
        players: {},
        structures: Array.isArray(parsed.structures) ? parsed.structures : [],
        vehicles: Array.isArray(parsed.vehicles) ? parsed.vehicles : [],
        horses: Array.isArray(parsed.horses) ? parsed.horses : [],
        containers: Array.isArray(parsed.containers) ? parsed.containers : [],
        companions: Array.isArray(parsed.companions) ? parsed.companions : [],
      };
      if (parsed.players instanceof Map) {
        for (const [steamId, pData] of parsed.players) {
          cacheData.players[steamId] = pData;
        }
      } else if (parsed.players && typeof parsed.players === 'object') {
        cacheData.players = parsed.players;
      }
      const cachePath = path.join(__dirname, '..', '..', 'data', 'save-cache.json');
      fs.writeFileSync(cachePath, JSON.stringify(cacheData), 'utf8');
    } catch (err) {
      this._log.error('Failed to write save-cache.json:', err.message);
    }
  }
}

module.exports = SaveService;

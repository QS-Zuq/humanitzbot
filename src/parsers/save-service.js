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
 *   **ssh**:   Bot uploads agent via SFTP, executes via SSH exec.
 *   **panel**: Bot sends a console command through the Pterodactyl wrapper API.
 *              The host intercepts it and runs the parser. (BisectHosting model)
 *   **none**:  Bot never triggers the agent — assumes the host runs it externally
 *              (cron, systemd, Pterodactyl schedule, etc.).
 *   **auto**:  Tries panel command first (if Panel API configured), then SSH,
 *              then treats as 'none' (just checks for existing cache).
 *
 * Usage:
 *   const SaveService = require('./parsers/save-service');
 *   const service = new SaveService(db, { sftpConfig, remotePath, agentMode: 'auto' });
 *   service.on('sync', (result) => { ... });
 *   service.start();
 *   service.stop();
 */

const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const { parseSave, parseClanData } = require('./save-parser');

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
   * @param {string}  [options.agentTrigger]     - 'auto' | 'ssh' | 'panel' | 'none' (default: 'auto')
   * @param {string}  [options.agentPanelCommand] - Console command for panel trigger (default: 'parse-save')
   * @param {number}  [options.agentPanelDelay]   - ms to wait after panel command before reading cache (default: 5000)
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
    this._label = options.label || 'SaveService';

    // Agent mode
    this._agentMode = options.agentMode || 'auto';     // 'auto' | 'agent' | 'direct'
    this._agentNodePath = options.agentNodePath || 'node';
    this._agentRemoteDir = options.agentRemoteDir || ''; // derive from savePath if empty
    this._agentCachePath = options.agentCachePath || '';  // explicit cache path (host-managed)
    this._sshConfig = options.sshConfig || null;
    this._agentTimeout = options.agentTimeout || 120_000;

    // Agent trigger strategy
    this._agentTrigger = options.agentTrigger || 'auto';  // 'auto' | 'ssh' | 'panel' | 'none'
    this._agentPanelCommand = options.agentPanelCommand || 'parse-save';
    this._agentPanelDelay = options.agentPanelDelay ?? 5000;
    this._panelApi = options.panelApi || null;  // lazy-loaded if null

    // Internal state
    this._timer = null;
    this._lastMtime = null;
    this._lastClanMtime = null;
    this._lastCacheMtime = null;
    this._syncing = false;
    this._syncCount = 0;
    this._lastError = null;
    this._mode = null;                // actual mode after auto-detection: 'agent' | 'direct'

    // Agent state
    this._agentDeployed = false;
    this._agentCapable = null;        // null = unknown, true/false after probe
    this._panelCapable = null;        // null = unknown, true/false after probe
    this._resolvedTrigger = null;     // actual trigger after auto-detection
    this._agentPath = '';             // full remote path to uploaded agent
    this._cachePath = '';             // full remote path to humanitz-cache.json
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
    const modeLabel = this._agentMode === 'direct' ? 'direct' : `${this._agentMode} (agent-capable: ${this._agentCapable ?? 'unknown'})`;
    console.log(`[${this._label}] Starting save service — mode: ${modeLabel}, poll every ${this._pollInterval / 1000}s`);
    await this._poll();
    this._timer = setInterval(() => this._poll(), this._pollInterval);
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    console.log(`[${this._label}] Stopped (${this._syncCount} syncs, mode: ${this._mode || this._agentMode})`);
  }

  /** Force an immediate sync (for slash commands, etc.). */
  async forceSync() {
    return this._poll(true);
  }

  /** Update the ID map (called externally when PlayerIDMapped.txt is refreshed). */
  setIdMap(idMap) {
    this._idMap = idMap;
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
      this._cachePath = this._agentCachePath || (dir + '/humanitz-cache.json');
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
    try { SFTPClient = require('ssh2-sftp-client'); }
    catch { throw new Error('ssh2-sftp-client not installed'); }

    let buildAgentScript;
    try { ({ buildAgentScript } = require('./agent-builder')); }
    catch (err) { throw new Error(`Failed to load agent-builder: ${err.message}`); }

    const script = buildAgentScript();
    const sftp = new SFTPClient();

    try {
      await sftp.connect(this._sftpConfig);
      await sftp.put(Buffer.from(script, 'utf-8'), this._agentPath);
      this._agentDeployed = true;
      console.log(`[${this._label}] Agent deployed → ${this._agentPath} (${(script.length / 1024).toFixed(1)}KB)`);
    } finally {
      sftp.end();
    }
  }

  /**
   * Execute the agent on the game server via SSH.
   * Returns the parsed stdout/stderr and exit code.
   */
  async executeAgent() {
    const cmd = `${this._agentNodePath} "${this._agentPath}" --save "${this._savePath}"`;
    console.log(`[${this._label}] Executing agent: ${cmd}`);
    const result = await this._sshExec(cmd);

    if (result.code !== 0) {
      const msg = (result.stderr || result.stdout || '').trim().slice(0, 300);
      throw new Error(`Agent exited with code ${result.code}: ${msg}`);
    }

    console.log(`[${this._label}] Agent output: ${result.stdout.trim().slice(0, 200)}`);
    return result;
  }

  /**
   * Check if Node.js is available on the game server via SSH.
   * Caches the result in this._agentCapable.
   */
  async checkNodeAvailable() {
    try {
      const result = await this._sshExec(`${this._agentNodePath} --version`);
      const version = (result.stdout || '').trim();
      if (result.code === 0 && version.startsWith('v')) {
        this._agentCapable = true;
        console.log(`[${this._label}] Node.js available on game server: ${version}`);
        return true;
      }
    } catch (err) {
      console.log(`[${this._label}] SSH check failed: ${err.message}`);
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
    try { ({ Client: SSHClient } = require('ssh2')); }
    catch { throw new Error('ssh2 not installed — needed for SSH exec'); }

    const config = this._sshConfig || this._buildSshConfig();
    if (!config || !config.host) {
      throw new Error('No SSH config available (need FTP_HOST + FTP_USER + FTP_PASSWORD)');
    }

    return new Promise((resolve, reject) => {
      const conn = new SSHClient();
      let stdout = '', stderr = '';
      const timer = setTimeout(() => {
        conn.end();
        reject(new Error(`SSH exec timed out after ${this._agentTimeout}ms`));
      }, this._agentTimeout);

      conn.on('ready', () => {
        conn.exec(command, (err, stream) => {
          if (err) { clearTimeout(timer); conn.end(); return reject(err); }
          stream.on('data', (d) => { stdout += d; });
          stream.stderr.on('data', (d) => { stderr += d; });
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
            console.log(`[${this._label}] Agent unavailable — falling back to direct .sav download`);
          }
          this._mode = 'direct';
          await this._pollDirect(force);
        } else if (agentOk) {
          this._mode = 'agent';
        }
      }

    } catch (err) {
      this._lastError = err.message;
      console.error(`[${this._label}] Sync error:`, err.message);
      this.emit('error', err);
    } finally {
      this._syncing = false;
    }
  }

  /**
   * Direct mode: download full .sav via SFTP (or local), parse, sync.
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
    }

    if (!buf) return; // no changes

    const parsed = parseSave(buf);
    let clans = [];
    if (clanBuf) {
      try { clans = parseClanData(clanBuf); }
      catch (err) { console.warn(`[${this._label}] Failed to parse clan data:`, err.message); }
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
      if (trigger === 'panel') {
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

      console.warn(`[${this._label}] Agent triggered (${trigger}) but cache not found at ${this._cachePath}`);
      return false;

    } catch (err) {
      console.warn(`[${this._label}] Agent mode failed: ${err.message}`);
      return false;
    }
  }

  /**
   * Resolve which trigger strategy to use.  Called once and cached.
   * @returns {Promise<'panel'|'ssh'|'none'>}
   */
  async _resolveTrigger() {
    if (this._resolvedTrigger) return this._resolvedTrigger;

    const requested = this._agentTrigger;

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

    // 1. Try panel command if Panel API is available
    if (this._checkPanelAvailable()) {
      console.log(`[${this._label}] Panel API available — using panel command trigger ("${this._agentPanelCommand}")`);
      this._resolvedTrigger = 'panel';
      return 'panel';
    }

    // 2. Try SSH
    if (this._agentCapable === null) await this.checkNodeAvailable();
    if (this._agentCapable) {
      this._resolvedTrigger = 'ssh';
      return 'ssh';
    }

    // 3. Neither available — just check for cache (host-managed)
    console.log(`[${this._label}] No panel or SSH available — will check for host-managed cache only`);
    this._resolvedTrigger = 'none';
    return 'none';
  }

  /**
   * Check if the Pterodactyl Panel API is configured and available.
   */
  _checkPanelAvailable() {
    if (this._panelCapable !== null) return this._panelCapable;

    // Lazy-load panel-api if not injected
    if (!this._panelApi) {
      try { this._panelApi = require('../panel-api'); }
      catch { this._panelCapable = false; return false; }
    }

    this._panelCapable = !!this._panelApi.available;
    return this._panelCapable;
  }

  /**
   * Trigger the agent via a Pterodactyl panel console command.
   * NOTE: Requires host-side support (not yet implemented — pending Bisect partnership).
   * The host wrapper would intercept this command and run the parser.
   * We wait a configurable delay for the host to finish writing the cache.
   */
  async _triggerViaPanel() {
    console.log(`[${this._label}] Sending panel command: "${this._agentPanelCommand}"`);
    await this._panelApi.sendCommand(this._agentPanelCommand);

    // Wait for the host to parse + write the cache
    if (this._agentPanelDelay > 0) {
      await new Promise(r => setTimeout(r, this._agentPanelDelay));
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
    try { SFTPClient = require('ssh2-sftp-client'); }
    catch { throw new Error('ssh2-sftp-client not installed — needed for SFTP polling'); }

    const sftp = new SFTPClient();
    try {
      await sftp.connect(this._sftpConfig);

      // Check mtime first to avoid downloading unchanged files
      const stat = await sftp.stat(this._savePath);
      const mtime = stat.modifyTime;

      if (!force && this._lastMtime && mtime === this._lastMtime) {
        return { saveBuf: null, clanBuf: null };
      }

      console.log(`[${this._label}] Downloading save file (direct mode)...`);
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
   * Read the agent's JSON cache file from SFTP.
   * Returns the parsed cache object if the cache is fresh, or null.
   */
  async _readCacheFromSftp(force) {
    if (!this._sftpConfig || !this._cachePath) return null;

    let SFTPClient;
    try { SFTPClient = require('ssh2-sftp-client'); }
    catch { return null; }

    const sftp = new SFTPClient();
    try {
      await sftp.connect(this._sftpConfig);

      // Check if cache file exists
      let stat;
      try { stat = await sftp.stat(this._cachePath); }
      catch { return null; } // file doesn't exist

      const mtime = stat.modifyTime;

      // Skip if we already synced this version
      if (!force && this._lastCacheMtime && mtime === this._lastCacheMtime) {
        return null;
      }

      // Download the small cache file
      const buf = await sftp.get(this._cachePath);
      const json = buf.toString('utf-8');

      let cache;
      try { cache = JSON.parse(json); }
      catch (err) { console.warn(`[${this._label}] Invalid cache JSON: ${err.message}`); return null; }

      // Validate cache version — accept any v >= 1 for forward-compatibility
      // (host-managed agents may lag behind the bot's version)
      if (!cache || typeof cache.v !== 'number' || cache.v < 1) {
        console.warn(`[${this._label}] Invalid or missing cache version (got ${cache?.v})`);
        return null;
      }

      this._lastCacheMtime = mtime;
      const sizeMB = (json.length / 1024 / 1024).toFixed(2);
      console.log(`[${this._label}] Downloaded cache: ${sizeMB}MB (${Object.keys(cache.players || {}).length} players)`);

      return cache;
    } finally {
      sftp.end();
    }
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
    };

    await this._syncParsedData(parsed, []);
  }

  /**
   * Core sync: write parsed data into the database and emit events.
   * Shared by both direct mode (after parseSave) and agent mode (after cache read).
   */
  async _syncParsedData(parsed, clans) {
    const startTime = Date.now();

    // Resolve player names from ID map
    for (const [steamId, data] of parsed.players) {
      if (this._idMap[steamId]) {
        data.name = this._idMap[steamId];
      }
    }

    // Sync everything into the database in one transaction
    this._db.syncFromSave({
      players: parsed.players,
      worldState: parsed.worldState,
      structures: parsed.structures,
      vehicles: parsed.vehicles,
      companions: parsed.companions,
      clans,
    });

    // Sync dead bodies
    if (parsed.deadBodies && parsed.deadBodies.length > 0) {
      this._db.replaceDeadBodies(parsed.deadBodies);
    }

    // Sync containers
    if (parsed.containers && parsed.containers.length > 0) {
      this._db.replaceContainers(parsed.containers);
    }

    // Sync loot actors
    if (parsed.lootActors && parsed.lootActors.length > 0) {
      this._db.replaceLootActors(parsed.lootActors);
    }

    // Sync world quests
    if (parsed.quests && parsed.quests.length > 0) {
      this._db.replaceQuests(parsed.quests);
    }

    // Update meta timestamps
    this._db.setMeta('last_save_sync', new Date().toISOString());
    this._db.setMeta('last_save_players', String(parsed.players.size));

    const elapsed = Date.now() - startTime;
    const mode = this._mode || this._agentMode;
    console.log(`[${this._label}] Sync complete (${mode}): ${parsed.players.size} players, ${parsed.structures.length} structures, ${parsed.vehicles.length} vehicles, ${clans.length} clans (${elapsed}ms)`);

    // Emit event with summary so other modules can react
    const result = {
      playerCount: parsed.players.size,
      structureCount: parsed.structures.length,
      vehicleCount: parsed.vehicles.length,
      companionCount: parsed.companions.length,
      clanCount: clans.length,
      worldState: parsed.worldState,
      elapsed,
      steamIds: [...parsed.players.keys()],
      mode,
    };

    this.emit('sync', result);
    return result;
  }
}

module.exports = SaveService;

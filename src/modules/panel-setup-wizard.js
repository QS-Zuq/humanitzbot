/**
 * Panel Setup Wizard — guided first-run configuration via Discord.
 *
 * Extracted from panel-channel.js. These are PanelChannel prototype methods
 * for the interactive setup wizard that runs when RCON is not configured.
 *
 * Usage (in panel-channel.js):
 *   const setupWizardHandlers = require('./panel-setup-wizard');
 *   Object.assign(PanelChannel.prototype, setupWizardHandlers);
 */

'use strict';

const path = require('path');
const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle,
} = require('discord.js');
const { SETUP } = require('./panel-constants');
const { writeEnvValues } = require('./panel-env');
const { t, getLocale } = require('../i18n');

/**
 * Detect SSH private keys on the bot's host machine.
 * Scans ~/.ssh/ for common key files and returns the first found path,
 * or empty string if none found.
 */
function _detectSshKey() {
  const fs = require('fs');
  const os = require('os');
  const sshDir = path.join(os.homedir(), '.ssh');
  const candidates = ['id_ed25519', 'id_rsa', 'id_ecdsa'];
  for (const name of candidates) {
    const keyPath = path.join(sshDir, name);
    try {
      fs.accessSync(keyPath, fs.constants.R_OK);
      return keyPath;
    } catch { /* not found or not readable */ }
  }
  return '';
}

/** Find common parent directory from an array of absolute paths. */
function _findCommonParent(paths) {
  if (paths.length === 0) return '/';
  if (paths.length === 1) return path.dirname(paths[0]);
  const segments = paths.map(p => p.split('/').filter(Boolean));
  let depth = 0;
  const min = Math.min(...segments.map(s => s.length));
  for (let i = 0; i < min; i++) {
    if (segments.every(s => s[i] === segments[0][i])) depth = i + 1;
    else break;
  }
  return depth > 0 ? '/' + segments[0].slice(0, depth).join('/') : '/';
}

/**
 * Auto-detect game server on a local VPS by scanning common installation directories
 * and optionally checking Docker containers or running processes.
 *
 * Returns { serverRoot, rconPort, rconPassword, gamePort } or null.
 */
async function _detectLocalGameServer() {
  const fs = require('fs');

  // Common LinuxGSM / manual install paths
  const candidates = [
    '/home/steam/hzserver/serverfiles/HumanitZServer',
    '/home/linuxgsm/hzserver/serverfiles/HumanitZServer',
    '/home/steam/HumanitZServer',
    '/opt/hzserver/serverfiles/HumanitZServer',
    '/root/hzserver/serverfiles/HumanitZServer',
    '/srv/hzserver/serverfiles/HumanitZServer',
  ];

  // Also check Docker volume mounts — try to find HumanitZServer in common docker paths
  const dockerPaths = [
    '/app/HumanitZServer',
    '/data/HumanitZServer',
    '/home/container/HumanitZServer',
  ];

  const allPaths = [...candidates, ...dockerPaths];

  let serverRoot = null;
  let settingsContent = null;

  for (const dir of allPaths) {
    try {
      const settingsPath = path.join(dir, 'GameServerSettings.ini');
      if (fs.existsSync(settingsPath)) {
        serverRoot = dir;
        settingsContent = fs.readFileSync(settingsPath, 'utf8');
        break;
      }
    } catch { /* not here */ }
  }

  if (!serverRoot) return null;

  // Parse GameServerSettings.ini for RCON settings
  const result = { serverRoot };
  if (settingsContent) {
    const lines = settingsContent.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      const m = trimmed.match(/^(\w+)=(.*)$/);
      if (!m) continue;
      const [, key, val] = m;
      if (key === 'RCONPassword' || key === 'RconPassword') result.rconPassword = val.trim();
      if (key === 'RCONPort' || key === 'RconPort') result.rconPort = val.trim();
      if (key === 'Port' || key === 'GamePort') result.gamePort = val.trim();
    }
  }

  return result;
}

// ═════════════════════════════════════════════════════════════
// Setup wizard methods
// ═════════════════════════════════════════════════════════════

/**
 * Launch the setup wizard. Posts the initial profile selection embed.
 */
async function _startSetupWizard() {
  const locale = getLocale({ serverConfig: this._config });
  this._setupWizard = { step: 'profile', profile: null, rcon: null, sftp: null, panel: null, channels: {} };

  const embed = new EmbedBuilder()
    .setTitle(t('discord:panel_setup_wizard.wizard_title', locale))
    .setColor(0x5865f2)
    .setDescription([
      'Welcome! This wizard will help you configure your bot.',
      '',
      '**How is your game server hosted?**',
      '',
      '🖥️ **VPS / Self-hosted** — Bot and game server on the same machine (localhost RCON + SFTP)',
      '🌐 **Bisect / Remote host** — Game server on a remote host (Pterodactyl panel auto-detection)',
      '📡 **RCON only** — No file access, basic features only (chat relay, status, commands)',
    ].join('\n'))
    .setFooter({ text: t('discord:panel_setup_wizard.step_1_footer', locale) });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(SETUP.PROFILE_VPS).setLabel('VPS / Self-hosted').setStyle(ButtonStyle.Primary).setEmoji('🖥️'),
    new ButtonBuilder().setCustomId(SETUP.PROFILE_BISECT).setLabel('Bisect / Remote').setStyle(ButtonStyle.Primary).setEmoji('🌐'),
    new ButtonBuilder().setCustomId(SETUP.PROFILE_RCON).setLabel('RCON Only').setStyle(ButtonStyle.Secondary).setEmoji('📡'),
  );

  this.panelMessage = await this.channel.send({ embeds: [embed], components: [row] });
  this.botMessage = this.panelMessage;
}

/**
 * Route all interactions while setup wizard is active.
 */
async function _handleSetupInteraction(interaction) {
  // ── Buttons ──
  if (interaction.isButton()) {
    const id = interaction.customId;
    // Profile selection
    if ([SETUP.PROFILE_VPS, SETUP.PROFILE_BISECT, SETUP.PROFILE_RCON].includes(id)) {
      return this._handleSetupProfile(interaction, id);
    }
    // Step buttons
    if (id === SETUP.RCON_BTN) return this._handleSetupRconButton(interaction);
    if (id === SETUP.SFTP_BTN) return this._handleSetupSftpButton(interaction);
    if (id === SETUP.SKIP_SFTP_BTN) return this._handleSetupSkipSftp(interaction);
    if (id === SETUP.CHANNELS_BTN) return this._handleSetupChannelsButton(interaction);
    if (id === SETUP.APPLY_BTN) return this._handleSetupApply(interaction);
    // Bisect Panel API flow
    if (id === SETUP.PANEL_BTN) return this._handleSetupPanelButton(interaction);
    if (id === SETUP.PANEL_MANUAL_BTN) return this._handleSetupPanelManualFallback(interaction);
  }
  // ── Modals ──
  if (interaction.isModalSubmit()) {
    if (interaction.customId === SETUP.RCON_MODAL) return this._handleSetupRconModal(interaction);
    if (interaction.customId === SETUP.SFTP_MODAL) return this._handleSetupSftpModal(interaction);
    if (interaction.customId === SETUP.CHANNELS_MODAL) return this._handleSetupChannelsModal(interaction);
    if (interaction.customId === SETUP.PANEL_MODAL) return this._handleSetupPanelModal(interaction);
  }
  return false;
}

/**
 * Handle profile selection (VPS / Bisect / RCON-only).
 */
async function _handleSetupProfile(interaction, id) {
  const profileMap = {
    [SETUP.PROFILE_VPS]: 'vps',
    [SETUP.PROFILE_BISECT]: 'bisect',
    [SETUP.PROFILE_RCON]: 'rcon-only',
  };
  this._setupWizard.profile = profileMap[id];

  // Set profile-appropriate defaults
  const defaults = {
    vps: { rconHost: '127.0.0.1', rconPort: '8888', ftpHost: '127.0.0.1', ftpPort: '22' },
    bisect: { rconHost: '', rconPort: '27015', ftpHost: '', ftpPort: '8821' },
    'rcon-only': { rconHost: '', rconPort: '27015' },
  };
  this._setupWizard.defaults = defaults[this._setupWizard.profile] || {};

  // VPS profile: try auto-detecting local game server before showing RCON modal
  if (this._setupWizard.profile === 'vps') {
    try {
      const localServer = await _detectLocalGameServer();
      if (localServer) {
        this._setupWizard.localDetected = localServer;
        // Pre-populate RCON defaults from detected settings
        if (localServer.rconPassword) {
          this._setupWizard.defaults.rconPassword = localServer.rconPassword;
        }
        if (localServer.rconPort) {
          this._setupWizard.defaults.rconPort = localServer.rconPort;
        }
        if (localServer.gamePort) {
          this._setupWizard.defaults.gamePort = localServer.gamePort;
        }
      }
    } catch { /* auto-detect failed, proceed with manual */ }
  }

  // Bisect profile goes to Panel API step, others go to RCON
  this._setupWizard.step = this._setupWizard.profile === 'bisect' ? 'panel' : 'rcon';

  await this._updateSetupEmbed(interaction);
  return true;
}

// ═════════════════════════════════════════════════════════════
// Bisect Panel API auto-detection flow
// ═════════════════════════════════════════════════════════════

/**
 * Show Panel API credentials modal (Bisect auto-detect step).
 */
async function _handleSetupPanelButton(interaction) {
  const locale = getLocale({ serverConfig: this._config });
  const modal = new ModalBuilder()
    .setCustomId(SETUP.PANEL_MODAL)
    .setTitle(t('discord:panel_setup_wizard.panel_auto_detect_title', locale))
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('panel_url')
          .setLabel('Panel Server URL')
          .setPlaceholder(t('discord:panel_setup_wizard.placeholder_panel_url', locale))
          .setValue(this._setupWizard.panel?.url || '')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('api_key')
          .setLabel('Panel API Key')
          .setPlaceholder(t('discord:panel_setup_wizard.placeholder_panel_api_key', locale))
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
      ),
    );
  await interaction.showModal(modal);
  return true;
}

/**
 * Handle Panel API modal submission — auto-detect all server config.
 *
 * Uses the Pterodactyl API to discover:
 *   - RCON host (from server allocations — primary IP)
 *   - RCON port (Game Port + 2 for Bisect HumanitZ servers)
 *   - RCON password (from startup variables)
 *   - Game port (from allocations)
 *   - SFTP host + port (from server SFTP details)
 *   - File paths (via Panel API file listing)
 *   - WebSocket RCON availability (via WebSocket auth test)
 */
async function _handleSetupPanelModal(interaction) {
  await interaction.deferUpdate();

  const panelUrl = interaction.fields.getTextInputValue('panel_url').trim().replace(/\/+$/, '');
  const apiKey = interaction.fields.getTextInputValue('api_key').trim();

  this._setupWizard.panel = { url: panelUrl, apiKey, status: 'detecting', detected: {} };
  await this._updateSetupEmbed(interaction);

  const { createPanelApi } = require('../server/panel-api');
  const api = createPanelApi({ serverUrl: panelUrl, apiKey });

  if (!api) {
    this._setupWizard.panel.status = 'error';
    this._setupWizard.panel.error = 'Invalid Panel URL format. Expected: https://panel.host.com/server/SERVERID';
    await this._updateSetupEmbed(interaction);
    return true;
  }

  const detected = {};
  const errors = [];

  // ── Step 1: Get server details (allocations → IP + ports) ─
  try {
    const details = await api.getServerDetails();
    const allocs = details.relationships?.allocations?.data || [];
    const primary = allocs.find(a => (a.attributes || a).is_default) || allocs[0];
    const primaryAttrs = primary?.attributes || primary || {};

    if (primaryAttrs.ip || primaryAttrs.ip_alias) {
      detected.rconHost = primaryAttrs.ip_alias || primaryAttrs.ip;
      detected.gamePort = String(primaryAttrs.port || '');

      // Bisect HumanitZ: RCON port = Game Port + 2
      if (detected.gamePort) {
        detected.rconPort = String(parseInt(detected.gamePort, 10) + 2);
      }
    }

    // SFTP details from server meta
    if (details.sftp_details) {
      const sftp = details.sftp_details;
      if (sftp.ip) detected.sftpHost = sftp.ip;
      if (sftp.port) detected.sftpPort = String(sftp.port);
    }

    detected.serverName = details.name || '';
  } catch (err) {
    errors.push(`Server details: ${err.message}`);
  }

  // ── Step 2: Get startup variables (→ RCON password) ───────
  try {
    const vars = await api.getStartupVariables();
    for (const v of vars) {
      const key = (v.env_variable || '').toUpperCase();
      const val = v.server_value || v.default_value || '';
      if (key === 'RCON_PASSWORD' || key === 'RCONPASSWORD' || key === 'RCON_PASS') {
        detected.rconPassword = val;
      }
      // Some hosts use SERVER_PORT for game port — cross-reference
      if ((key === 'SERVER_PORT' || key === 'GAME_PORT') && !detected.gamePort) {
        detected.gamePort = val;
        if (val) detected.rconPort = String(parseInt(val, 10) + 2);
      }
      // Bisect may also have a dedicated RCON_PORT startup var
      if (key === 'RCON_PORT' || key === 'RCONPORT') {
        detected.rconPort = val;
      }
    }
  } catch (err) {
    errors.push(`Startup variables: ${err.message}`);
  }

  // ── Step 3: Verify WebSocket access ───────────────────────
  try {
    const wsAuth = await api.getWebsocketAuth();
    detected.hasWebSocket = !!(wsAuth.token && wsAuth.socket);
  } catch {
    detected.hasWebSocket = false;
  }

  // ── Step 4: Auto-discover game files via Panel API ────────
  try {
    const found = new Map();

    // Try the known Bisect layout first (fast path — 1-2 API calls instead of 8+).
    // Bisect HumanitZ servers have a consistent structure under /HumanitZServer/.
    const knownRoot = '/HumanitZServer';
    let serverRoot = null;

    // Known Bisect file layout — construct paths directly
    const knownLayout = (root) => ({
      'GameServerSettings.ini': `${root}/GameServerSettings.ini`,
      'PlayerIDMapped.txt':     `${root}/PlayerIDMapped.txt`,
      'PlayerConnectedLog.txt': `${root}/PlayerConnectedLog.txt`,
      'WelcomeMessage.txt':     `${root}/WelcomeMessage.txt`,
      'Save_DedicatedSaveMP.sav': `${root}/Saved/SaveGames/SaveList/Default/Save_DedicatedSaveMP.sav`,
      // HMZLog lives in HZLogs/ (per-restart rotated) or root (legacy)
    });

    try {
      const rootItems = await api.listFiles(knownRoot);
      const fileNames = new Set(rootItems.map(i => i.name));

      // If we can list the directory, this is our server root
      serverRoot = knownRoot;

      // Map known files that exist at the root level
      const layout = knownLayout(knownRoot);
      for (const [target, filePath] of Object.entries(layout)) {
        if (target === 'Save_DedicatedSaveMP.sav') continue; // checked separately below
        if (fileNames.has(target)) {
          found.set(target, filePath);
        }
      }

      // HZLogs/ — per-restart rotated logs (game update Feb 28 2026)
      if (fileNames.has('HZLogs')) {
        try {
          const logDir = `${knownRoot}/HZLogs`;
          const logItems = await api.listFiles(logDir);
          const hmzLogs = logItems.filter(f => f.name.endsWith('_HMZLog.log'));
          if (hmzLogs.length > 0) {
            hmzLogs.sort((a, b) => (b.modified_at || '').localeCompare(a.modified_at || ''));
            found.set('HMZLog.log', `${logDir}/${hmzLogs[0].name}`);
          }
          // ConnectLog in Login/ subdirectory
          try {
            const loginItems = await api.listFiles(`${logDir}/Login`);
            const connectLogs = loginItems.filter(f => f.name.endsWith('_ConnectLog.txt'));
            if (connectLogs.length > 0) {
              connectLogs.sort((a, b) => (b.modified_at || '').localeCompare(a.modified_at || ''));
              found.set('PlayerConnectedLog.txt', `${logDir}/Login/${connectLogs[0].name}`);
            }
          } catch { /* no Login/ subdir */ }
        } catch { /* no HZLogs dir */ }
      }

      // Legacy monolithic HMZLog.log at root (pre-rotation)
      if (!found.has('HMZLog.log') && fileNames.has('HMZLog.log')) {
        found.set('HMZLog.log', `${knownRoot}/HMZLog.log`);
      }

      // Save file in known subdirectory
      try {
        const saveDir = `${knownRoot}/Saved/SaveGames/SaveList/Default`;
        const saveItems = await api.listFiles(saveDir);
        if (saveItems.some(f => f.name === 'Save_DedicatedSaveMP.sav')) {
          found.set('Save_DedicatedSaveMP.sav', layout['Save_DedicatedSaveMP.sav']);
        }
      } catch { /* save dir doesn't exist yet (new server) */ }
    } catch {
      // /HumanitZServer doesn't exist — try alternate roots
    }

    // Fallback: search alternate root directories if known layout failed
    if (!serverRoot) {
      const altRoots = [
        '/serverfiles/HumanitZServer',
        '/home/container/HumanitZServer',
        '/app/HumanitZServer',
      ];
      for (const dir of altRoots) {
        try {
          const items = await api.listFiles(dir);
          serverRoot = dir;
          // Found a valid root — search for files
          for (const item of items) {
            const targets = ['GameServerSettings.ini', 'PlayerIDMapped.txt',
              'PlayerConnectedLog.txt', 'WelcomeMessage.txt', 'HMZLog.log'];
            if (targets.includes(item.name) && !found.has(item.name)) {
              found.set(item.name, `${dir}/${item.name}`);
            }
          }
          // Check subdirectories for save file and rotated logs
          if (!found.has('Save_DedicatedSaveMP.sav')) {
            try {
              const saveDir = `${dir}/Saved/SaveGames/SaveList/Default`;
              const saveItems = await api.listFiles(saveDir);
              if (saveItems.some(f => f.name === 'Save_DedicatedSaveMP.sav')) {
                found.set('Save_DedicatedSaveMP.sav', `${saveDir}/Save_DedicatedSaveMP.sav`);
              }
            } catch { /* no save dir */ }
          }
          if (!found.has('HMZLog.log')) {
            try {
              const logDir = `${dir}/HZLogs`;
              const logItems = await api.listFiles(logDir);
              const hmzLogs = logItems.filter(f => f.name.endsWith('_HMZLog.log'));
              if (hmzLogs.length > 0) {
                hmzLogs.sort((a, b) => (b.modified_at || '').localeCompare(a.modified_at || ''));
                found.set('HMZLog.log', `${logDir}/${hmzLogs[0].name}`);
              }
            } catch { /* no HZLogs dir */ }
          }
          break; // found valid root, stop searching
        } catch { /* dir doesn't exist */ }
      }
    }

    detected.serverRoot = serverRoot;
    detected.paths = Object.fromEntries(found);
    detected.foundCount = found.size;
  } catch (err) {
    errors.push(`File discovery: ${err.message}`);
    detected.paths = {};
    detected.foundCount = 0;
  }

  // ── Step 5: Auto-discover bot server + web panel port ─────
  // If the same API key controls multiple Pterodactyl servers (Bisect game + bot),
  // find the bot server and discover available port allocations for the web panel.
  try {
    const allServers = await api.listServers();
    if (allServers.length > 1) {
      // The game server is the one matching panelUrl — find it by identifier
      const panelId = panelUrl.split('/').pop();
      const botServer = allServers.find(s =>
        s.identifier !== panelId &&
        // Bot servers typically run Node.js/Python images or have 'bot' in name/description
        (/node|bot|discord/i.test(s.name || '') ||
         /node|bot|discord/i.test(s.description || '') ||
         /node|python|java/i.test(s.docker_image || ''))
      );
      if (botServer) {
        detected.botServer = {
          identifier: botServer.identifier,
          name: botServer.name,
          allocations: botServer.allocations || [],
        };
        // Find a non-default allocation for the web panel (default = bot's main port)
        const defaultAlloc = botServer.allocations.find(a => a.is_default);
        const extraAllocs = botServer.allocations.filter(a => !a.is_default);
        if (extraAllocs.length > 0) {
          // Use the first extra allocation for the web panel
          const webAlloc = extraAllocs[0];
          detected.webPanelPort = String(webAlloc.port);
          detected.webPanelIp = webAlloc.ip_alias || webAlloc.ip || (defaultAlloc?.ip_alias || defaultAlloc?.ip || '');
        } else if (defaultAlloc) {
          // Only one allocation — web panel can't get its own port
          // User will need to request an additional allocation from Bisect
          detected.webPanelNeedsAllocation = true;
        }
      }
    }
  } catch {
    // listServers() may fail (permissions, network) — non-critical
  }

  // ── Evaluate results ──────────────────────────────────────
  this._setupWizard.panel.detected = detected;
  this._setupWizard.panel.errors = errors;

  // Populate RCON and SFTP from detected values
  if (detected.rconHost && detected.rconPort) {
    this._setupWizard.rcon = {
      host: detected.rconHost,
      port: detected.rconPort,
      password: detected.rconPassword || '',
      status: detected.rconPassword ? 'ok' : 'warning',
      autoDetected: true,
    };
    if (!detected.rconPassword) {
      this._setupWizard.rcon.error = 'RCON password not found in startup variables — you may need to set it manually in Startup tab';
    }
  }

  // SFTP — for Bisect, we use the Panel API for file access (no SFTP creds needed)
  if (detected.hasWebSocket && detected.foundCount > 0) {
    this._setupWizard.sftp = {
      host: detected.sftpHost || detected.rconHost || '',
      port: detected.sftpPort || '2022',
      user: '',
      password: '',
      status: 'panel',
      paths: detected.paths,
      foundCount: detected.foundCount,
      panelFileAccess: true,
    };
  }

  if (detected.rconHost && (detected.rconPassword || detected.hasWebSocket)) {
    this._setupWizard.panel.status = 'ok';
    this._setupWizard.step = 'channels';
  } else if (errors.length > 0 && !detected.rconHost) {
    this._setupWizard.panel.status = 'error';
    this._setupWizard.panel.error = errors[0];
  } else {
    // Partial success — we have some info but not everything
    this._setupWizard.panel.status = 'partial';
    this._setupWizard.step = 'channels';
  }

  await this._updateSetupEmbed(interaction);
  return true;
}

/**
 * Fall back to manual RCON/SFTP setup from the Bisect flow.
 */
async function _handleSetupPanelManualFallback(interaction) {
  await interaction.deferUpdate();
  this._setupWizard.step = 'rcon';
  await this._updateSetupEmbed(interaction);
  return true;
}

// ═════════════════════════════════════════════════════════════
// Standard RCON / SFTP flow (VPS + RCON-only profiles)
// ═════════════════════════════════════════════════════════════

/**
 * Show RCON credentials modal.
 */
async function _handleSetupRconButton(interaction) {
  const locale = getLocale({ serverConfig: this._config });
  const d = this._setupWizard.defaults || {};
  const modal = new ModalBuilder()
    .setCustomId(SETUP.RCON_MODAL)
    .setTitle(t('discord:panel_setup_wizard.rcon_connection_title', locale))
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('host')
          .setLabel('RCON Host')
          .setPlaceholder(d.rconHost || t('discord:panel_setup_wizard.placeholder_rcon_host', locale))
          .setValue(this._setupWizard.rcon?.host || d.rconHost || '')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('port')
          .setLabel('RCON Port')
          .setPlaceholder(d.rconPort || t('discord:panel_setup_wizard.placeholder_rcon_port', locale))
          .setValue(this._setupWizard.rcon?.port || d.rconPort || '')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('password')
          .setLabel('RCON Password')
          .setPlaceholder(d.rconPassword ? '(auto-detected from settings)' : t('discord:panel_setup_wizard.placeholder_rcon_password', locale))
          .setValue(this._setupWizard.rcon?.password || d.rconPassword || '')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
      ),
    );
  await interaction.showModal(modal);
  return true;
}

/**
 * Handle RCON modal submission — test connection.
 */
async function _handleSetupRconModal(interaction) {
  await interaction.deferUpdate();

  const host = interaction.fields.getTextInputValue('host').trim();
  const port = interaction.fields.getTextInputValue('port').trim();
  const password = interaction.fields.getTextInputValue('password').trim();

  this._setupWizard.rcon = { host, port, password, status: 'testing' };
  await this._updateSetupEmbed(interaction);

  // Test RCON connection
  const net = require('net');
  try {
    await new Promise((resolve, reject) => {
      const socket = net.createConnection({ host, port: parseInt(port, 10), timeout: 8000 }, () => {
        socket.destroy();
        resolve();
      });
      socket.on('error', reject);
      socket.on('timeout', () => { socket.destroy(); reject(new Error('Connection timed out')); });
    });
    this._setupWizard.rcon.status = 'ok';
    this._setupWizard.step = this._setupWizard.profile === 'rcon-only' ? 'channels' : 'sftp';
  } catch (err) {
    this._setupWizard.rcon.status = 'error';
    this._setupWizard.rcon.error = err.message;
  }

  await this._updateSetupEmbed(interaction);
  return true;
}

/**
 * Show SFTP credentials modal.
 */
async function _handleSetupSftpButton(interaction) {
  const locale = getLocale({ serverConfig: this._config });
  const d = this._setupWizard.defaults || {};
  // For VPS, try to detect the current OS user for SFTP username default
  let defaultUser = '';
  if (this._setupWizard.profile === 'vps') {
    try { defaultUser = require('os').userInfo().username || ''; } catch { /* */ }
  }
  // Auto-detect SSH keys on the bot host
  const detectedKey = this._setupWizard.sftp?.privateKeyPath || _detectSshKey();
  const keyPlaceholder = detectedKey
    ? `Detected: ${detectedKey}`
    : 'No keys found — enter path or use password';
  const modal = new ModalBuilder()
    .setCustomId(SETUP.SFTP_MODAL)
    .setTitle(t('discord:panel_setup_wizard.sftp_connection_title', locale))
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('host')
          .setLabel('SFTP Host')
          .setPlaceholder(d.ftpHost || t('discord:panel_setup_wizard.placeholder_sftp_host', locale))
          .setValue(this._setupWizard.sftp?.host || d.ftpHost || this._setupWizard.rcon?.host || '')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('port')
          .setLabel('SFTP Port')
          .setPlaceholder(d.ftpPort || t('discord:panel_setup_wizard.placeholder_sftp_port', locale))
          .setValue(this._setupWizard.sftp?.port || d.ftpPort || '')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('user')
          .setLabel('SFTP Username')
          .setPlaceholder(defaultUser || 'root / steam / your username')
          .setValue(this._setupWizard.sftp?.user || defaultUser || '')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('password')
          .setLabel('SFTP Password (blank if using SSH key)')
          .setPlaceholder(t('discord:panel_setup_wizard.placeholder_sftp_passphrase', locale))
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('private_key_path')
          .setLabel('SSH Key Path on bot host (optional)')
          .setPlaceholder(keyPlaceholder)
          .setValue(detectedKey)
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
      ),
    );
  await interaction.showModal(modal);
  return true;
}

/**
 * Handle SFTP modal submission — test connection + auto-discover.
 */
async function _handleSetupSftpModal(interaction) {
  await interaction.deferUpdate();

  const host = interaction.fields.getTextInputValue('host').trim();
  const port = interaction.fields.getTextInputValue('port').trim();
  const user = interaction.fields.getTextInputValue('user').trim();
  const password = interaction.fields.getTextInputValue('password').trim();
  const privateKeyPath = interaction.fields.getTextInputValue('private_key_path').trim();

  if (!password && !privateKeyPath) {
    this._setupWizard.sftp = { host, port, user, password, privateKeyPath, status: 'error', error: 'Either a password or SSH private key path is required.', paths: null };
    await this._updateSetupEmbed(interaction);
    return true;
  }

  this._setupWizard.sftp = { host, port, user, password, privateKeyPath, status: 'testing', paths: null };
  await this._updateSetupEmbed(interaction);

  // Test SFTP connection + auto-discover paths
  const SftpClient = require('ssh2-sftp-client');
  const sftp = new SftpClient();
  try {
    const connectOpts = {
      host,
      port: parseInt(port, 10),
      username: user,
      readyTimeout: 10000,
      retries: 0,
    };
    if (privateKeyPath) {
      try {
        connectOpts.privateKey = require('fs').readFileSync(privateKeyPath);
        if (password) connectOpts.passphrase = password;
      } catch (keyErr) {
        this._setupWizard.sftp.status = 'error';
        this._setupWizard.sftp.error = `Could not read SSH key at ${privateKeyPath}: ${keyErr.message}`;
        await this._updateSetupEmbed(interaction);
        return true;
      }
    } else {
      connectOpts.password = password;
    }
    await sftp.connect(connectOpts);

    // Auto-discover game files via recursive search
    const targets = ['HMZLog.log', 'PlayerConnectedLog.txt', 'PlayerIDMapped.txt', 'Save_DedicatedSaveMP.sav', 'GameServerSettings.ini', 'WelcomeMessage.txt'];
    const found = new Map();

    // Quick check: common game server paths first (fast path)
    const searchDirs = [
      '/home/steam/hzserver/serverfiles/HumanitZServer',
      '/home/steam/HumanitZServer',
      '/HumanitZServer',
      '/serverfiles/HumanitZServer',
      '/home/container/HumanitZServer',
      '/app/serverfiles/HumanitZServer',
      '/app/HumanitZServer',
    ];

    for (const dir of searchDirs) {
      if (found.size >= targets.length) break;
      try {
        const items = await sftp.list(dir);
        for (const item of items) {
          if (targets.includes(item.name) && !found.has(item.name)) {
            found.set(item.name, `${dir}/${item.name}`);
          }
        }
        // Also check Saved/SaveGames subdirectories for the save file
        if (!found.has('Save_DedicatedSaveMP.sav')) {
          try {
            const saveDir = `${dir}/Saved/SaveGames/SaveList/Default`;
            const saveItems = await sftp.list(saveDir);
            for (const item of saveItems) {
              if (item.name === 'Save_DedicatedSaveMP.sav') {
                found.set(item.name, `${saveDir}/${item.name}`);
              }
            }
          } catch { /* save dir doesn't exist here */ }
        }
      } catch { /* dir doesn't exist */ }
    }

    // If quick check didn't find everything, do a full recursive search
    if (found.size < targets.length) {
      const _skip = /^(\.|node_modules|__pycache__|Engine|Content|Binaries|linux64|steamapps|proc|sys|run|tmp|lost\+found|snap|boot|usr)$/i;
      const _priority = /^(data|serverfiles|home|opt|root|app|HumanitZServer|hzserver|humanitz|container)/i;
      const _recurse = async (dir, depth) => {
        if (depth >= 8 || found.size >= targets.length) return;
        let items;
        try { items = await sftp.list(dir); } catch { return; }
        for (const item of items) {
          if (found.size >= targets.length) return;
          const fullPath = dir === '/' ? `/${item.name}` : `${dir}/${item.name}`;
          if (item.type === 'd') {
            if (_skip.test(item.name)) continue;
            if (_priority.test(item.name) || depth < 6) {
              await _recurse(fullPath, depth + 1);
            }
          } else if (targets.includes(item.name) && !found.has(item.name)) {
            found.set(item.name, fullPath);
          }
        }
      };
      await _recurse('/', 0);
    }

    await sftp.end();

    this._setupWizard.sftp.status = 'ok';
    this._setupWizard.sftp.paths = Object.fromEntries(found);
    this._setupWizard.sftp.foundCount = found.size;
    this._setupWizard.step = 'channels';
  } catch (err) {
    try { await sftp.end(); } catch { /* ignore */ }
    this._setupWizard.sftp.status = 'error';
    this._setupWizard.sftp.error = err.message;
  }

  await this._updateSetupEmbed(interaction);
  return true;
}

/**
 * Skip SFTP setup (user wants RCON-only even if they selected VPS/Bisect).
 */
async function _handleSetupSkipSftp(interaction) {
  await interaction.deferUpdate();
  this._setupWizard.sftp = null;
  this._setupWizard.step = 'channels';
  await this._updateSetupEmbed(interaction);
  return true;
}

/**
 * Show channel assignment modal.
 */
async function _handleSetupChannelsButton(interaction) {
  const locale = getLocale({ serverConfig: this._config });
  const ch = this._setupWizard.channels || {};
  const modal = new ModalBuilder()
    .setCustomId(SETUP.CHANNELS_MODAL)
    .setTitle(t('discord:panel_setup_wizard.channel_assignment_title', locale))
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('status')
          .setLabel('Server Status Channel ID')
          .setPlaceholder(t('discord:panel_setup_wizard.placeholder_copy_channel_id', locale))
          .setValue(ch.serverStatus || '')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('stats')
          .setLabel('Player Stats Channel ID')
          .setPlaceholder(t('discord:panel_setup_wizard.placeholder_copy_channel_id', locale))
          .setValue(ch.playerStats || '')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('log')
          .setLabel('Activity Log Channel ID')
          .setPlaceholder(t('discord:panel_setup_wizard.placeholder_copy_channel_id', locale))
          .setValue(ch.log || '')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('chat')
          .setLabel('Chat Relay Channel ID (also admin channel)')
          .setPlaceholder(t('discord:panel_setup_wizard.placeholder_copy_channel_id', locale))
          .setValue(ch.chat || '')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
      ),
    );
  await interaction.showModal(modal);
  return true;
}

/**
 * Handle channel assignment modal.
 */
async function _handleSetupChannelsModal(interaction) {
  await interaction.deferUpdate();

  const status = interaction.fields.getTextInputValue('status').trim();
  const stats = interaction.fields.getTextInputValue('stats').trim();
  const log = interaction.fields.getTextInputValue('log').trim();
  const chat = interaction.fields.getTextInputValue('chat').trim();

  this._setupWizard.channels = {
    serverStatus: status || '',
    playerStats: stats || '',
    log: log || '',
    chat: chat || '',
  };
  this._setupWizard.step = 'apply';

  await this._updateSetupEmbed(interaction);
  return true;
}

/**
 * Apply all wizard settings — write to .env and restart.
 */
async function _handleSetupApply(interaction) {
  const locale = getLocale({ serverConfig: this._config });
  await interaction.deferUpdate();

  const wiz = this._setupWizard;
  const envUpdates = {};

  // Panel API credentials (Bisect profile)
  if (wiz.panel && wiz.panel.status === 'ok') {
    envUpdates.PANEL_SERVER_URL = wiz.panel.url;
    envUpdates.PANEL_API_KEY = wiz.panel.apiKey;
  }

  // RCON
  if (wiz.rcon) {
    envUpdates.RCON_HOST = wiz.rcon.host;
    envUpdates.RCON_PORT = wiz.rcon.port;
    envUpdates.RCON_PASSWORD = wiz.rcon.password;
  }

  // Game port (from panel detection)
  if (wiz.panel?.detected?.gamePort) {
    envUpdates.GAME_PORT = wiz.panel.detected.gamePort;
  }

  // SFTP — different handling based on whether we use Panel API file access
  if (wiz.sftp && wiz.sftp.panelFileAccess) {
    // Bisect Panel API file access — SFTP not needed for file reading
    // But we still set SFTP creds if available for PvP scheduler / settings writes
    if (wiz.sftp.host) envUpdates.FTP_HOST = wiz.sftp.host;
    if (wiz.sftp.port) envUpdates.FTP_PORT = wiz.sftp.port;
    // Note: user/password not auto-detected from Panel API — left empty
    // Panel API readFile/writeFile handles file access instead
  } else if (wiz.sftp && wiz.sftp.status === 'ok') {
    envUpdates.FTP_HOST = wiz.sftp.host;
    envUpdates.FTP_PORT = wiz.sftp.port;
    envUpdates.FTP_USER = wiz.sftp.user;
    if (wiz.sftp.password) envUpdates.FTP_PASSWORD = wiz.sftp.password;
    if (wiz.sftp.privateKeyPath) envUpdates.FTP_PRIVATE_KEY_PATH = wiz.sftp.privateKeyPath;
  }

  // Set discovered file paths (from either Panel API or SFTP)
  const paths = wiz.sftp?.paths || {};
  if (paths['HMZLog.log']) envUpdates.FTP_LOG_PATH = paths['HMZLog.log'];
  if (paths['PlayerConnectedLog.txt']) envUpdates.FTP_CONNECT_LOG_PATH = paths['PlayerConnectedLog.txt'];
  if (paths['PlayerIDMapped.txt']) envUpdates.FTP_ID_MAP_PATH = paths['PlayerIDMapped.txt'];
  if (paths['Save_DedicatedSaveMP.sav']) envUpdates.FTP_SAVE_PATH = paths['Save_DedicatedSaveMP.sav'];
  if (paths['GameServerSettings.ini']) envUpdates.FTP_SETTINGS_PATH = paths['GameServerSettings.ini'];
  if (paths['WelcomeMessage.txt']) envUpdates.FTP_WELCOME_PATH = paths['WelcomeMessage.txt'];

  // VPS fallback: if SFTP file search found nothing but we detected a local server,
  // construct paths from the known server root (SFTP sees the same filesystem)
  if (Object.keys(paths).length === 0 && wiz.localDetected?.serverRoot) {
    const root = wiz.localDetected.serverRoot;
    envUpdates.FTP_SETTINGS_PATH = `${root}/GameServerSettings.ini`;
    envUpdates.FTP_ID_MAP_PATH = `${root}/PlayerIDMapped.txt`;
    envUpdates.FTP_SAVE_PATH = `${root}/Saved/SaveGames/SaveList/Default/Save_DedicatedSaveMP.sav`;
    envUpdates.FTP_WELCOME_PATH = `${root}/WelcomeMessage.txt`;
    // Log path — LogWatcher derives HZLogs/ from ftpLogPath's parent directory
    envUpdates.FTP_LOG_PATH = `${root}/HMZLog.log`;
    envUpdates.FTP_CONNECT_LOG_PATH = `${root}/PlayerConnectedLog.txt`;
  }

  // Auto-detect base path from discovered files
  const allPaths = Object.values(paths);
  if (allPaths.length > 0) {
    const common = _findCommonParent(allPaths);
    if (common && common !== '/') {
      envUpdates.FTP_BASE_PATH = common;
    }
  }

  // Profile-specific defaults
  if (wiz.profile === 'vps') {
    envUpdates.SAVE_POLL_INTERVAL = '30000';
  } else if (wiz.profile === 'bisect') {
    envUpdates.SAVE_POLL_INTERVAL = '300000';

    // Auto-configure web panel if bot server was detected with an available port
    const det = wiz.panel?.detected || {};
    if (det.webPanelPort && det.webPanelIp) {
      envUpdates.WEB_MAP_PORT = det.webPanelPort;
      envUpdates.WEB_MAP_TRUST_PROXY = '1';  // Pterodactyl Docker networking
      // Callback URL for Discord OAuth — use the bot server's public IP + port
      envUpdates.WEB_MAP_CALLBACK_URL = `http://${det.webPanelIp}:${det.webPanelPort}/auth/callback`;
    }
  }

  // Channels
  const ch = wiz.channels || {};
  if (ch.serverStatus) envUpdates.SERVER_STATUS_CHANNEL_ID = ch.serverStatus;
  if (ch.playerStats) envUpdates.PLAYER_STATS_CHANNEL_ID = ch.playerStats;
  if (ch.log) envUpdates.LOG_CHANNEL_ID = ch.log;
  if (ch.chat) {
    envUpdates.CHAT_CHANNEL_ID = ch.chat;
    envUpdates.ADMIN_CHANNEL_ID = ch.chat; // same channel by default
  }

  // Trigger initial import on restart
  envUpdates.FIRST_RUN = 'true';

  // Write all at once
  writeEnvValues(envUpdates);

  // Build success message based on what was detected
  const isBisect = wiz.profile === 'bisect' && wiz.panel?.status === 'ok';
  const successLines = [
    'Configuration has been saved. The bot will restart now to apply settings and run the initial data import.',
    '',
    '**What was configured:**',
  ];

  if (isBisect) {
    successLines.push('✅ Panel API — auto-detected server configuration');
    if (wiz.panel.detected.hasWebSocket) successLines.push('✅ WebSocket RCON — using panel console (no direct TCP needed)');
    if (wiz.rcon) successLines.push(`✅ RCON — \`${wiz.rcon.host}:${wiz.rcon.port}\``);
    if (wiz.panel.detected.foundCount > 0) successLines.push(`✅ Game files — found ${wiz.panel.detected.foundCount}/6 via Panel API`);
    if (wiz.panel.detected.webPanelPort) {
      successLines.push(`✅ Web panel — port ${wiz.panel.detected.webPanelPort} on bot server \`${wiz.panel.detected.botServer?.name || 'auto-detected'}\``);
    } else if (wiz.panel.detected.webPanelNeedsAllocation) {
      successLines.push('⚠️ Web panel — bot server has only one port allocation. Request an extra port from Bisect to enable the web panel.');
    }
  } else {
    if (wiz.localDetected) successLines.push(`✅ Local server — detected at \`${wiz.localDetected.serverRoot}\``);
    if (wiz.rcon?.status === 'ok') successLines.push(`✅ RCON — \`${wiz.rcon.host}:${wiz.rcon.port}\``);
    if (wiz.sftp?.status === 'ok') successLines.push(`✅ SFTP — \`${wiz.sftp.host}:${wiz.sftp.port}\` (${wiz.sftp.foundCount}/6 files)`);
    else if (wiz.localDetected) successLines.push('✅ File paths — set from detected server root');
  }

  const channelCount = [ch.serverStatus, ch.playerStats, ch.log, ch.chat].filter(Boolean).length;
  if (channelCount > 0) successLines.push(`✅ Channels — ${channelCount} configured`);

  successLines.push('', '**What happens next:**');
  successLines.push('1. Bot restarts with new configuration');
  if (wiz.sftp?.foundCount > 0 || isBisect) {
    successLines.push('2. Downloads server logs and parses player data');
    successLines.push('3. Builds statistics and posts embeds');
  } else {
    successLines.push('2. Connects to game server via RCON');
    successLines.push('3. Starts monitoring chat and server status');
  }
  successLines.push('4. This channel becomes your admin dashboard.');

  const successEmbed = new EmbedBuilder()
    .setTitle(t('discord:panel_setup_wizard.setup_complete_title', locale))
    .setColor(0x2ecc71)
    .setDescription(successLines.join('\n'))
    .setFooter({ text: t('discord:panel_setup_wizard.restarting', locale) });

  try {
    await this.panelMessage.edit({ embeds: [successEmbed], components: [] });
  } catch { /* message might be gone */ }

  // Restart
  setTimeout(() => process.exit(0), 2000);
  return true;
}

/**
 * Build and update the setup wizard embed based on current step.
 */
async function _updateSetupEmbed(interaction) {
  const locale = getLocale({ serverConfig: this._config });
  const wiz = this._setupWizard;
  const embed = new EmbedBuilder()
    .setTitle(t('discord:panel_setup_wizard.wizard_title', locale))
    .setColor(0x5865f2);

  const lines = [];
  const profileLabels = { vps: '🖥️ VPS / Self-hosted', bisect: '🌐 Bisect / Remote', 'rcon-only': '📡 RCON Only' };

  // Profile
  lines.push(`**Hosting:** ${profileLabels[wiz.profile] || 'Not selected'}`);
  lines.push('');

  // Panel API status (Bisect flow)
  if (wiz.profile === 'bisect') {
    if (wiz.panel) {
      if (wiz.panel.status === 'detecting') {
        lines.push('⏳ **Panel API:** Detecting server configuration...');
      } else if (wiz.panel.status === 'ok') {
        lines.push('✅ **Panel API:** Connected — auto-detected configuration');
        const d = wiz.panel.detected;
        if (d.serverName) lines.push(`  └ Server: ${d.serverName}`);
        if (d.rconHost) lines.push(`  └ Host: \`${d.rconHost}\``);
        if (d.gamePort) lines.push(`  └ Game port: \`${d.gamePort}\` → RCON port: \`${d.rconPort || '?'}\``);
        if (d.rconPassword) lines.push('  └ RCON password: detected ✓');
        else lines.push('  └ ⚠️ RCON password: not found in startup vars');
        if (d.hasWebSocket) lines.push('  └ WebSocket RCON: available ✓');
        if (d.foundCount > 0) lines.push(`  └ Game files: ${d.foundCount}/6 found via Panel API`);
        // Bot server + web panel auto-detection
        if (d.botServer) {
          lines.push(`  └ Bot server: \`${d.botServer.name}\` (${d.botServer.allocations.length} port(s))`);
          if (d.webPanelPort) {
            lines.push(`  └ Web panel: port \`${d.webPanelPort}\` auto-configured ✓`);
          } else if (d.webPanelNeedsAllocation) {
            lines.push('  └ ⚠️ Web panel: needs an extra port allocation from Bisect');
          }
        }
      } else if (wiz.panel.status === 'partial') {
        lines.push('⚠️ **Panel API:** Partially detected — some values may need manual entry');
        if (wiz.panel.errors?.length) lines.push(`  └ ${wiz.panel.errors[0]}`);
      } else if (wiz.panel.status === 'error') {
        lines.push('❌ **Panel API:** Connection failed');
        lines.push(`  └ ${wiz.panel.error}`);
      }
    } else if (wiz.step === 'panel') {
      lines.push('⬜ **Panel API:** Not configured — tap the button below');
      lines.push('');
      lines.push('**Where to find your Panel URL:**');
      lines.push('Log in to your panel → click your server → copy the URL from your browser');
      lines.push('Example: `https://games.bisecthosting.com/server/a1b2c3d4`');
      lines.push('');
      lines.push('**Where to find your API Key:**');
      lines.push('Panel → Account (top right) → API Credentials → Create new key');
    }
  }

  // RCON status (shown for non-Bisect, or if Bisect detected RCON)
  if (wiz.profile !== 'bisect' || wiz.step === 'rcon') {
    // Show VPS auto-detection hint
    if (wiz.profile === 'vps' && wiz.localDetected && wiz.step === 'rcon') {
      lines.push('💡 **Local server detected** — RCON settings pre-filled from `GameServerSettings.ini`');
      lines.push(`  └ Server root: \`${wiz.localDetected.serverRoot}\``);
      lines.push('');
    }
    if (wiz.rcon && !wiz.rcon.autoDetected) {
      const icon = wiz.rcon.status === 'ok' ? '✅' : wiz.rcon.status === 'error' ? '❌' : '⏳';
      lines.push(`${icon} **RCON:** \`${wiz.rcon.host}:${wiz.rcon.port}\``);
      if (wiz.rcon.status === 'error') {
        lines.push(`  └ ${wiz.rcon.error}`);
      }
    } else if (wiz.step === 'rcon') {
      lines.push('⬜ **RCON:** Not configured — tap the button below');
    }
  }

  // SFTP status (skip for rcon-only and Bisect with panel file access)
  if (wiz.profile !== 'rcon-only' && wiz.profile !== 'bisect') {
    if (wiz.sftp) {
      const icon = wiz.sftp.status === 'ok' ? '✅' : wiz.sftp.status === 'error' ? '❌' : '⏳';
      lines.push(`${icon} **SFTP:** \`${wiz.sftp.host}:${wiz.sftp.port}\``);
      if (wiz.sftp.status === 'ok' && wiz.sftp.foundCount !== undefined) {
        lines.push(`  └ Found ${wiz.sftp.foundCount}/6 game files`);
      }
      if (wiz.sftp.status === 'error') {
        lines.push(`  └ ${wiz.sftp.error}`);
      }
    } else if (wiz.step === 'sftp' || wiz.step === 'channels' || wiz.step === 'apply') {
      if (wiz.sftp === null && wiz.step !== 'sftp') {
        lines.push('⏭️ **SFTP:** Skipped');
      } else {
        lines.push('⬜ **SFTP:** Not configured');
      }
    }
  }

  // Channels
  const ch = wiz.channels || {};
  const channelCount = [ch.serverStatus, ch.playerStats, ch.log, ch.chat].filter(Boolean).length;
  if (channelCount > 0) {
    lines.push(`✅ **Channels:** ${channelCount} configured`);
    if (ch.serverStatus) lines.push(`  └ Status: <#${ch.serverStatus}>`);
    if (ch.playerStats) lines.push(`  └ Stats: <#${ch.playerStats}>`);
    if (ch.log) lines.push(`  └ Log: <#${ch.log}>`);
    if (ch.chat) lines.push(`  └ Chat: <#${ch.chat}>`);
  } else if (wiz.step === 'channels' || wiz.step === 'apply') {
    lines.push('⬜ **Channels:** None configured (optional)');
  }

  embed.setDescription(lines.join('\n'));

  // Step indicator
  const stepLabels = {
    profile: '1/4 — Profile',
    panel: '2/4 — Panel API',
    rcon: '2/4 — RCON',
    sftp: '3/4 — SFTP',
    channels: '3/4 — Channels',
    apply: '4/4 — Ready',
  };
  embed.setFooter({ text: `Step ${stepLabels[wiz.step] || wiz.step}` });

  // Build action rows based on current step
  const components = [];

  if (wiz.step === 'panel') {
    // Bisect Panel API flow
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(SETUP.PANEL_BTN).setLabel('Enter Panel Credentials').setStyle(ButtonStyle.Primary).setEmoji('🔑'),
      new ButtonBuilder().setCustomId(SETUP.PANEL_MANUAL_BTN).setLabel('Manual Setup').setStyle(ButtonStyle.Secondary).setEmoji('⚙️'),
    );
    components.push(row);
  } else if (wiz.step === 'rcon') {
    components.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(SETUP.RCON_BTN).setLabel('Configure RCON').setStyle(ButtonStyle.Primary).setEmoji('🔌'),
    ));
  } else if (wiz.step === 'sftp') {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(SETUP.SFTP_BTN).setLabel('Configure SFTP').setStyle(ButtonStyle.Primary).setEmoji('📂'),
      new ButtonBuilder().setCustomId(SETUP.SKIP_SFTP_BTN).setLabel('Skip SFTP').setStyle(ButtonStyle.Secondary),
    );
    // Allow re-testing RCON if it failed
    if (wiz.rcon?.status === 'error') {
      row.addComponents(
        new ButtonBuilder().setCustomId(SETUP.RCON_BTN).setLabel('Retry RCON').setStyle(ButtonStyle.Secondary),
      );
    }
    components.push(row);
  } else if (wiz.step === 'channels') {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(SETUP.CHANNELS_BTN).setLabel('Set Channels').setStyle(ButtonStyle.Primary).setEmoji('📺'),
      new ButtonBuilder().setCustomId(SETUP.APPLY_BTN).setLabel('Apply & Restart').setStyle(ButtonStyle.Success).setEmoji('🚀'),
    );
    // For Bisect: allow retry if panel detection had issues
    if (wiz.profile === 'bisect' && wiz.panel?.status === 'partial') {
      row.addComponents(
        new ButtonBuilder().setCustomId(SETUP.PANEL_BTN).setLabel('Retry Detection').setStyle(ButtonStyle.Secondary).setEmoji('🔄'),
      );
    }
    components.push(row);
  } else if (wiz.step === 'apply') {
    components.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(SETUP.CHANNELS_BTN).setLabel('Edit Channels').setStyle(ButtonStyle.Secondary).setEmoji('📺'),
      new ButtonBuilder().setCustomId(SETUP.APPLY_BTN).setLabel('Apply & Restart').setStyle(ButtonStyle.Success).setEmoji('🚀'),
    ));
  }

  try {
    await this.panelMessage.edit({ embeds: [embed], components });
  } catch (err) {
    console.error('[PANEL CH] Failed to update setup wizard embed:', err.message);
  }
}

// ═════════════════════════════════════════════════════════════
// Export all handlers for prototype assignment
// ═════════════════════════════════════════════════════════════

module.exports = {
  _startSetupWizard,
  _handleSetupInteraction,
  _handleSetupProfile,
  _handleSetupPanelButton,
  _handleSetupPanelModal,
  _handleSetupPanelManualFallback,
  _handleSetupRconButton,
  _handleSetupRconModal,
  _handleSetupSftpButton,
  _handleSetupSftpModal,
  _detectSshKey,
  _handleSetupSkipSftp,
  _handleSetupChannelsButton,
  _handleSetupChannelsModal,
  _handleSetupApply,
  _updateSetupEmbed,
};

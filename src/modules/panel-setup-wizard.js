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

// ═════════════════════════════════════════════════════════════
// Setup wizard methods
// ═════════════════════════════════════════════════════════════

/**
 * Launch the setup wizard. Posts the initial profile selection embed.
 */
async function _startSetupWizard() {
  this._setupWizard = { step: 'profile', profile: null, rcon: null, sftp: null, channels: {} };

  const embed = new EmbedBuilder()
    .setTitle('🔧 HumanitZ Bot — Setup Wizard')
    .setColor(0x5865f2)
    .setDescription([
      'Welcome! This wizard will help you configure your bot.',
      '',
      '**How is your game server hosted?**',
      '',
      '🖥️ **VPS / Self-hosted** — Bot and game server on the same machine (localhost RCON + SFTP)',
      '🌐 **Bisect / Remote host** — Game server on a remote host (remote RCON + SFTP)',
      '📡 **RCON only** — No file access, basic features only (chat relay, status, commands)',
    ].join('\n'))
    .setFooter({ text: 'Step 1 of 4 — Hosting Profile' });

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
  }
  // ── Modals ──
  if (interaction.isModalSubmit()) {
    if (interaction.customId === SETUP.RCON_MODAL) return this._handleSetupRconModal(interaction);
    if (interaction.customId === SETUP.SFTP_MODAL) return this._handleSetupSftpModal(interaction);
    if (interaction.customId === SETUP.CHANNELS_MODAL) return this._handleSetupChannelsModal(interaction);
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
  this._setupWizard.step = 'rcon';

  await this._updateSetupEmbed(interaction);
  return true;
}

/**
 * Show RCON credentials modal.
 */
async function _handleSetupRconButton(interaction) {
  const d = this._setupWizard.defaults || {};
  const modal = new ModalBuilder()
    .setCustomId(SETUP.RCON_MODAL)
    .setTitle('RCON Connection')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('host')
          .setLabel('RCON Host')
          .setPlaceholder(d.rconHost || '127.0.0.1')
          .setValue(this._setupWizard.rcon?.host || d.rconHost || '')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('port')
          .setLabel('RCON Port')
          .setPlaceholder(d.rconPort || '27015')
          .setValue(this._setupWizard.rcon?.port || d.rconPort || '')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('password')
          .setLabel('RCON Password')
          .setPlaceholder('Your RCON password')
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
  const d = this._setupWizard.defaults || {};
  const modal = new ModalBuilder()
    .setCustomId(SETUP.SFTP_MODAL)
    .setTitle('SFTP Connection')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('host')
          .setLabel('SFTP Host')
          .setPlaceholder(d.ftpHost || 'Same as RCON host')
          .setValue(this._setupWizard.sftp?.host || d.ftpHost || this._setupWizard.rcon?.host || '')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('port')
          .setLabel('SFTP Port')
          .setPlaceholder(d.ftpPort || '22')
          .setValue(this._setupWizard.sftp?.port || d.ftpPort || '')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('user')
          .setLabel('SFTP Username')
          .setPlaceholder('root / steam / your username')
          .setValue(this._setupWizard.sftp?.user || '')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('password')
          .setLabel('SFTP Password')
          .setPlaceholder('Your SFTP password')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
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

  this._setupWizard.sftp = { host, port, user, password, status: 'testing', paths: null };
  await this._updateSetupEmbed(interaction);

  // Test SFTP connection + auto-discover paths
  const SftpClient = require('ssh2-sftp-client');
  const sftp = new SftpClient();
  try {
    await sftp.connect({
      host,
      port: parseInt(port, 10),
      username: user,
      password,
      readyTimeout: 10000,
      retries: 0,
    });

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
  const ch = this._setupWizard.channels || {};
  const modal = new ModalBuilder()
    .setCustomId(SETUP.CHANNELS_MODAL)
    .setTitle('Channel Assignment')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('status')
          .setLabel('Server Status Channel ID')
          .setPlaceholder('Right-click channel → Copy Channel ID')
          .setValue(ch.serverStatus || '')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('stats')
          .setLabel('Player Stats Channel ID')
          .setPlaceholder('Right-click channel → Copy Channel ID')
          .setValue(ch.playerStats || '')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('log')
          .setLabel('Activity Log Channel ID')
          .setPlaceholder('Right-click channel → Copy Channel ID')
          .setValue(ch.log || '')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('chat')
          .setLabel('Chat Relay Channel ID (also admin channel)')
          .setPlaceholder('Right-click channel → Copy Channel ID')
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
  await interaction.deferUpdate();

  const wiz = this._setupWizard;
  const envUpdates = {};

  // RCON
  if (wiz.rcon) {
    envUpdates.RCON_HOST = wiz.rcon.host;
    envUpdates.RCON_PORT = wiz.rcon.port;
    envUpdates.RCON_PASSWORD = wiz.rcon.password;
  }

  // SFTP
  if (wiz.sftp && wiz.sftp.status === 'ok') {
    envUpdates.FTP_HOST = wiz.sftp.host;
    envUpdates.FTP_PORT = wiz.sftp.port;
    envUpdates.FTP_USER = wiz.sftp.user;
    envUpdates.FTP_PASSWORD = wiz.sftp.password;

    // Set discovered paths
    const paths = wiz.sftp.paths || {};
    if (paths['HMZLog.log']) envUpdates.FTP_LOG_PATH = paths['HMZLog.log'];
    if (paths['PlayerConnectedLog.txt']) envUpdates.FTP_CONNECT_LOG_PATH = paths['PlayerConnectedLog.txt'];
    if (paths['PlayerIDMapped.txt']) envUpdates.FTP_ID_MAP_PATH = paths['PlayerIDMapped.txt'];
    if (paths['Save_DedicatedSaveMP.sav']) envUpdates.FTP_SAVE_PATH = paths['Save_DedicatedSaveMP.sav'];
    if (paths['GameServerSettings.ini']) envUpdates.FTP_SETTINGS_PATH = paths['GameServerSettings.ini'];
    if (paths['WelcomeMessage.txt']) envUpdates.FTP_WELCOME_PATH = paths['WelcomeMessage.txt'];

    // Auto-detect base path
    const discovered = Object.values(paths);
    if (discovered.length > 0) {
      const common = _findCommonParent(discovered);
      if (common && common !== '/') {
        envUpdates.FTP_BASE_PATH = common;
      }
    }
  }

  // Profile-specific defaults
  if (wiz.profile === 'vps') {
    envUpdates.SAVE_POLL_INTERVAL = '30000';
  } else if (wiz.profile === 'bisect') {
    envUpdates.SAVE_POLL_INTERVAL = '300000';
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

  // Update embed with success message
  const successEmbed = new EmbedBuilder()
    .setTitle('✅ Setup Complete!')
    .setColor(0x2ecc71)
    .setDescription([
      'Configuration has been saved. The bot will restart now to apply settings and run the initial data import.',
      '',
      '**What happens next:**',
      '1. Bot restarts with new configuration',
      wiz.sftp?.status === 'ok' ? '2. Downloads server logs via SFTP' : '2. Connects to game server via RCON',
      wiz.sftp?.status === 'ok' ? '3. Parses player data and builds statistics' : '3. Starts monitoring chat and server status',
      '4. Posts embeds in your configured channels',
      '',
      'This channel will become your admin dashboard.',
    ].join('\n'))
    .setFooter({ text: 'Restarting...' });

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
  const wiz = this._setupWizard;
  const embed = new EmbedBuilder()
    .setTitle('🔧 HumanitZ Bot — Setup Wizard')
    .setColor(0x5865f2);

  const lines = [];
  const profileLabels = { vps: '🖥️ VPS / Self-hosted', bisect: '🌐 Bisect / Remote', 'rcon-only': '📡 RCON Only' };

  // Profile
  lines.push(`**Hosting:** ${profileLabels[wiz.profile] || 'Not selected'}`);
  lines.push('');

  // RCON status
  if (wiz.rcon) {
    const icon = wiz.rcon.status === 'ok' ? '✅' : wiz.rcon.status === 'error' ? '❌' : '⏳';
    lines.push(`${icon} **RCON:** \`${wiz.rcon.host}:${wiz.rcon.port}\``);
    if (wiz.rcon.status === 'error') {
      lines.push(`  └ ${wiz.rcon.error}`);
    }
  } else if (wiz.step === 'rcon') {
    lines.push('⬜ **RCON:** Not configured — tap the button below');
  }

  // SFTP status (skip for rcon-only)
  if (wiz.profile !== 'rcon-only') {
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
  const stepLabels = { profile: '1/4 — Profile', rcon: '2/4 — RCON', sftp: '3/4 — SFTP', channels: '3/4 — Channels', apply: '4/4 — Ready' };
  embed.setFooter({ text: `Step ${stepLabels[wiz.step] || wiz.step}` });

  // Build action rows based on current step
  const components = [];

  if (wiz.step === 'rcon') {
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
  _handleSetupRconButton,
  _handleSetupRconModal,
  _handleSetupSftpButton,
  _handleSetupSftpModal,
  _handleSetupSkipSftp,
  _handleSetupChannelsButton,
  _handleSetupChannelsModal,
  _handleSetupApply,
  _updateSetupEmbed,
};

/**
 * Panel Multi-Server Handlers — add, edit, remove, and configure managed servers.
 *
 * Extracted from panel-channel.js. These are PanelChannel prototype methods
 * that handle all multi-server Discord interactions (add wizard, edit modals,
 * game settings, welcome messages, auto-messages per server).
 *
 * Usage (in panel-channel.js):
 *   const multiServerHandlers = require('./panel-multi-server');
 *   Object.assign(PanelChannel.prototype, multiServerHandlers);
 */

'use strict';

const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  MessageFlags,
} = require('discord.js');
const config = require('../config');
const SftpClient = require('ssh2-sftp-client');
const { createServerConfig } = require('../server/multi-server');
const { GAME_SETTINGS_CATEGORIES } = require('./panel-constants');

/** Safely build a modal title within Discord's 45-char limit. */
function _modalTitle(prefix, name, suffix) {
  const maxName = 45 - prefix.length - suffix.length;
  const truncated = name.length > maxName ? name.slice(0, maxName - 1) + '…' : name;
  return `${prefix}${truncated}${suffix}`;
}

// ═════════════════════════════════════════════════════════════
// Add server wizard
// ═════════════════════════════════════════════════════════════

async function _handleAddServerButton(interaction) {
  if (!await this._requireAdmin(interaction, 'manage servers')) return true;

  const modal = new ModalBuilder()
    .setCustomId('panel_add_modal_step1')
    .setTitle('Add Server — Step 1: Connection');

  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('name').setLabel('Server Name').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('e.g. PvP Server')
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('rcon_host').setLabel('RCON Host').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('e.g. 192.168.1.100')
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('rcon_port').setLabel('RCON Port').setStyle(TextInputStyle.Short).setRequired(false).setValue('14541')
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('rcon_password').setLabel('RCON Password').setStyle(TextInputStyle.Short).setRequired(true)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('game_port').setLabel('Game Port').setStyle(TextInputStyle.Short).setRequired(false).setValue('14242')
    ),
  );

  await interaction.showModal(modal);
  return true;
}

async function _handleAddServerStep1Modal(interaction) {
  if (!await this._requireAdmin(interaction, 'manage servers')) return true;

  const name = interaction.fields.getTextInputValue('name').trim();
  const rconHost = interaction.fields.getTextInputValue('rcon_host').trim();
  const rconPort = parseInt(interaction.fields.getTextInputValue('rcon_port'), 10) || 14541;
  const rconPassword = interaction.fields.getTextInputValue('rcon_password').trim();
  const gamePort = parseInt(interaction.fields.getTextInputValue('game_port'), 10) || 14242;

  if (!name || !rconHost || !rconPassword) {
    await interaction.reply({ content: '❌ Name, RCON Host, and RCON Password are required.', flags: MessageFlags.Ephemeral });
    return true;
  }

  // Store partial config for step 2
  this._pendingServers.set(interaction.user.id, {
    name,
    rcon: { host: rconHost, port: rconPort, password: rconPassword },
    gamePort,
    _createdAt: Date.now(),
  });

  // Show step 2 button
  const sftpBtn = new ButtonBuilder()
    .setCustomId(`panel_add_sftp:${interaction.user.id}`)
    .setLabel('Configure SFTP')
    .setStyle(ButtonStyle.Primary);

  const continueBtn = new ButtonBuilder()
    .setCustomId(`panel_add_step2:${interaction.user.id}`)
    .setLabel('Configure Channels')
    .setStyle(ButtonStyle.Primary);

  const skipBtn = new ButtonBuilder()
    .setCustomId(`panel_srv_skip_channels:${interaction.user.id}`)
    .setLabel('Skip — Save Now')
    .setStyle(ButtonStyle.Secondary);

  await interaction.reply({
    content: `✅ **Step 1 complete!** Server "${name}" connection configured.\n\n` +
      `**Next:** Configure SFTP for log watching, player stats, and save reading (file paths auto-discover).\n` +
      `Or skip SFTP to inherit the primary server's connection.\n` +
      `You can also configure channels or save now.`,
    components: [new ActionRowBuilder().addComponents(sftpBtn, continueBtn, skipBtn)],
    flags: MessageFlags.Ephemeral,
  });
  return true;
}

async function _handleAddSftpButton(interaction, customId) {
  if (!await this._requireAdmin(interaction, 'manage servers')) return true;

  const userId = customId.replace('panel_add_sftp:', '');
  const pending = this._pendingServers.get(userId);
  if (!pending) {
    await interaction.reply({ content: '❌ Session expired. Please start over with "Add Server".', flags: MessageFlags.Ephemeral });
    return true;
  }

  const modal = new ModalBuilder()
    .setCustomId(`panel_add_sftp_modal:${userId}`)
    .setTitle('Add Server — SFTP Connection');

  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('sftp_host').setLabel('SFTP Host').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('e.g. atlas.realm.se')
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('sftp_port').setLabel('SFTP Port').setStyle(TextInputStyle.Short).setRequired(false).setValue('22')
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('sftp_user').setLabel('SFTP Username').setStyle(TextInputStyle.Short).setRequired(true)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('sftp_password').setLabel('SFTP Password').setStyle(TextInputStyle.Short).setRequired(true)
    ),
  );

  await interaction.showModal(modal);
  return true;
}

async function _handleAddSftpModal(interaction) {
  if (!await this._requireAdmin(interaction, 'manage servers')) return true;

  const userId = interaction.customId.replace('panel_add_sftp_modal:', '');
  const pending = this._pendingServers.get(userId);
  if (!pending) {
    await interaction.reply({ content: '❌ Session expired. Please start over with "Add Server".', flags: MessageFlags.Ephemeral });
    return true;
  }

  const host = interaction.fields.getTextInputValue('sftp_host').trim();
  const port = parseInt(interaction.fields.getTextInputValue('sftp_port'), 10) || 22;
  const user = interaction.fields.getTextInputValue('sftp_user').trim();
  const password = interaction.fields.getTextInputValue('sftp_password').trim();

  if (!host || !user || !password) {
    await interaction.reply({ content: '❌ SFTP host, username, and password are required.', flags: MessageFlags.Ephemeral });
    return true;
  }

  // Store SFTP config on the pending server definition
  pending.sftp = { host, port, user, password };

  // Show continue/skip buttons
  const continueBtn = new ButtonBuilder()
    .setCustomId(`panel_add_step2:${userId}`)
    .setLabel('Configure Channels')
    .setStyle(ButtonStyle.Primary);

  const skipBtn = new ButtonBuilder()
    .setCustomId(`panel_srv_skip_channels:${userId}`)
    .setLabel('Skip — Save Now')
    .setStyle(ButtonStyle.Secondary);

  await interaction.reply({
    content: `✅ **SFTP configured!** \`${host}:${port}\`\n` +
      `File paths will auto-discover when the server starts.\n\n` +
      `**Next:** Configure channels or save now.`,
    components: [new ActionRowBuilder().addComponents(continueBtn, skipBtn)],
    flags: MessageFlags.Ephemeral,
  });
  return true;
}

async function _handleAddServerStep2Button(interaction, customId) {
  if (!await this._requireAdmin(interaction, 'manage servers')) return true;

  const userId = customId.replace('panel_add_step2:', '');
  const pending = this._pendingServers.get(userId);
  if (!pending) {
    await interaction.reply({ content: '❌ Session expired. Please start over with "Add Server".', flags: MessageFlags.Ephemeral });
    return true;
  }

  const modal = new ModalBuilder()
    .setCustomId(`panel_add_modal_step2:${userId}`)
    .setTitle('Add Server — Step 2: Channels');

  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('ch_status').setLabel('Server Status Channel ID').setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder('Right-click channel → Copy Channel ID')
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('ch_stats').setLabel('Player Stats Channel ID').setStyle(TextInputStyle.Short).setRequired(false)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('ch_log').setLabel('Log Channel ID').setStyle(TextInputStyle.Short).setRequired(false)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('ch_chat').setLabel('Chat Relay Channel ID').setStyle(TextInputStyle.Short).setRequired(false)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('ch_admin').setLabel('Admin Channel ID').setStyle(TextInputStyle.Short).setRequired(false)
    ),
  );

  await interaction.showModal(modal);
  return true;
}

async function _handleAddServerStep2Modal(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (!this._isAdmin(interaction)) {
    await interaction.editReply('❌ Only administrators can manage servers.');
    return true;
  }

  const userId = interaction.customId.replace('panel_add_modal_step2:', '');
  const pending = this._pendingServers.get(userId);
  if (!pending) {
    await interaction.editReply('❌ Session expired. Please start over with "Add Server".');
    return true;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const channels = {};
  const chStatus = interaction.fields.getTextInputValue('ch_status').trim();
  const chStats = interaction.fields.getTextInputValue('ch_stats').trim();
  const chLog = interaction.fields.getTextInputValue('ch_log').trim();
  const chChat = interaction.fields.getTextInputValue('ch_chat').trim();
  const chAdmin = interaction.fields.getTextInputValue('ch_admin').trim();

  if (chStatus) channels.serverStatus = chStatus;
  if (chStats) channels.playerStats = chStats;
  if (chLog) channels.log = chLog;
  if (chChat) channels.chat = chChat;
  if (chAdmin) channels.admin = chAdmin;

  const serverDef = { ...pending, channels, enabled: true };
  this._pendingServers.delete(userId);

  try {
    if (!this.multiServerManager) {
      await interaction.editReply('❌ Multi-server manager not available.');
      return true;
    }

    const saved = await this.multiServerManager.addServer(serverDef);
    const channelCount = Object.keys(channels).length;

    // Post a per-server management embed
    try {
      const instance = this.multiServerManager.getInstance(saved.id);
      const embed = this._buildManagedServerEmbed(saved, instance);
      const components = this._buildManagedServerComponents(saved.id, instance?.running || false);
      const msg = await this.channel.send({ embeds: [embed], components });
      this._serverMessages.set(saved.id, msg);
      this._saveMessageIds();
    } catch (embedErr) {
      console.error(`[PANEL CH] Failed to post embed for new server ${saved.name}:`, embedErr.message);
    }

    await interaction.editReply(
      `✅ **${saved.name}** added and started!\n` +
      `• RCON: \`${saved.rcon.host}:${saved.rcon.port}\`\n` +
      `• Game Port: \`${saved.gamePort}\`\n` +
      `• Channels: ${channelCount} configured\n` +
      `• SFTP: Inherited from primary server`
    );

    // Refresh the bot controls embed
    setTimeout(() => this._update(true), 1000);
  } catch (err) {
    await interaction.editReply(`❌ Failed to add server: ${err.message}`);
  }

  return true;
}

// ═════════════════════════════════════════════════════════════
// Server management (select, start/stop/restart/remove/edit)
// ═════════════════════════════════════════════════════════════

async function _handleServerSelect(interaction) {
  if (!await this._requireAdmin(interaction, 'manage servers')) return true;

  const serverId = interaction.values[0];
  const servers = this.multiServerManager?.getAllServers() || [];
  const server = servers.find(s => s.id === serverId);
  if (!server) {
    await interaction.reply({ content: '❌ Server not found.', flags: MessageFlags.Ephemeral });
    return true;
  }

  const instance = this.multiServerManager.getInstance(serverId);
  const running = instance?.running || false;

  // Build management buttons
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`panel_srv_start:${serverId}`)
      .setLabel('Start')
      .setStyle(ButtonStyle.Success)
      .setDisabled(running),
    new ButtonBuilder()
      .setCustomId(`panel_srv_stop:${serverId}`)
      .setLabel('Stop')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(!running),
    new ButtonBuilder()
      .setCustomId(`panel_srv_edit:${serverId}`)
      .setLabel('Edit Connection')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`panel_srv_remove:${serverId}`)
      .setLabel('Remove')
      .setStyle(ButtonStyle.Danger),
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`panel_srv_channels:${serverId}`)
      .setLabel('Edit Channels')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`panel_srv_sftp:${serverId}`)
      .setLabel('Edit SFTP')
      .setStyle(ButtonStyle.Secondary),
  );

  // Build info text
  const ch = server.channels || {};
  const channelLines = [];
  if (ch.serverStatus) channelLines.push(`Status: <#${ch.serverStatus}>`);
  if (ch.playerStats) channelLines.push(`Stats: <#${ch.playerStats}>`);
  if (ch.log) channelLines.push(`Log: <#${ch.log}>`);
  if (ch.chat) channelLines.push(`Chat: <#${ch.chat}>`);
  if (ch.admin) channelLines.push(`Admin: <#${ch.admin}>`);

  const sftpInfo = server.sftp?.host ? `${server.sftp.host}:${server.sftp.port || 22}` : 'Inherited from primary';
  const moduleList = instance ? instance.getStatus().modules.join(', ') || 'None' : 'Not running';

  await interaction.reply({
    content: [
      `**${server.name}** ${running ? '🟢 Running' : '🔴 Stopped'}`,
      `• RCON: \`${server.rcon?.host || '?'}:${server.rcon?.port || 14541}\``,
      `• Game Port: \`${server.gamePort || 14242}\``,
      `• SFTP: ${sftpInfo}`,
      `• Channels: ${channelLines.length > 0 ? '\n' + channelLines.map(l => `  ${l}`).join('\n') : 'None configured'}`,
      `• Modules: ${moduleList}`,
    ].join('\n'),
    components: [row1, row2],
    flags: MessageFlags.Ephemeral,
  });
  return true;
}

async function _handleServerAction(interaction, customId) {
  if (!await this._requireAdmin(interaction, 'manage servers')) return true;

  // Handle skip channels button from add wizard
  if (customId.startsWith('panel_srv_skip_channels:')) {
    const userId = customId.replace('panel_srv_skip_channels:', '');
    const pending = this._pendingServers.get(userId);
    if (!pending) {
      await interaction.reply({ content: '❌ Session expired. Please start over.', flags: MessageFlags.Ephemeral });
      return true;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const serverDef = { ...pending, channels: {}, enabled: true };
    this._pendingServers.delete(userId);

    try {
      const saved = await this.multiServerManager.addServer(serverDef);
      // Post a per-server management embed
      try {
        const instance = this.multiServerManager.getInstance(saved.id);
        const embed = this._buildManagedServerEmbed(saved, instance);
        const components = this._buildManagedServerComponents(saved.id, instance?.running || false);
        const msg = await this.channel.send({ embeds: [embed], components });
        this._serverMessages.set(saved.id, msg);
        this._saveMessageIds();
      } catch (embedErr) {
        console.error(`[PANEL CH] Failed to post embed for new server ${saved.name}:`, embedErr.message);
      }
      await interaction.editReply(
        `✅ **${saved.name}** added (no channels configured).\n` +
        `Use the server embed buttons to configure channels.`
      );
      setTimeout(() => this._update(true), 1000);
    } catch (err) {
      await interaction.editReply(`❌ Failed to add server: ${err.message}`);
    }
    return true;
  }

  // Parse action and serverId from customId: panel_srv_<action>:<serverId>
  const match = customId.match(/^panel_srv_(\w+):(.+)$/);
  if (!match) return false;

  const [, action, serverId] = match;

  switch (action) {
    case 'start': {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        await this.multiServerManager.startServer(serverId);
        await interaction.editReply('✅ Server started.');
        setTimeout(() => this._update(true), 2000);
      } catch (err) {
        await interaction.editReply(`❌ Failed to start: ${err.message}`);
      }
      return true;
    }

    case 'stop': {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        await this.multiServerManager.stopServer(serverId);
        await interaction.editReply('✅ Server stopped.');
        setTimeout(() => this._update(true), 1000);
      } catch (err) {
        await interaction.editReply(`❌ Failed to stop: ${err.message}`);
      }
      return true;
    }

    case 'restart': {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        await this.multiServerManager.stopServer(serverId);
        await this.multiServerManager.startServer(serverId);
        await interaction.editReply('✅ Server restarted (modules stopped + started).');
        setTimeout(() => this._update(true), 2000);
      } catch (err) {
        await interaction.editReply(`❌ Failed to restart: ${err.message}`);
      }
      return true;
    }

    case 'remove': {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        const servers = this.multiServerManager.getAllServers();
        const server = servers.find(s => s.id === serverId);
        const name = server?.name || serverId;
        await this.multiServerManager.removeServer(serverId);
        // Delete the per-server embed message
        const srvMsg = this._serverMessages.get(serverId);
        if (srvMsg) {
          try { await srvMsg.delete(); } catch {}
          this._serverMessages.delete(serverId);
          this._lastServerKeys.delete(serverId);
          this._saveMessageIds();
        }
        await interaction.editReply(`✅ **${name}** removed.`);
        setTimeout(() => this._update(true), 1000);
      } catch (err) {
        await interaction.editReply(`❌ Failed to remove: ${err.message}`);
      }
      return true;
    }

    case 'edit': {
      // Show modal with current connection values
      const servers = this.multiServerManager.getAllServers();
      const server = servers.find(s => s.id === serverId);
      if (!server) {
        await interaction.reply({ content: '❌ Server not found.', flags: MessageFlags.Ephemeral });
        return true;
      }

      const modal = new ModalBuilder()
        .setCustomId(`panel_srv_edit_modal:${serverId}`)
        .setTitle(_modalTitle('Edit: ', server.name, ' (🔄 Server Restart)'));

      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('name').setLabel('Server Name').setStyle(TextInputStyle.Short).setValue(server.name || '')
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('rcon_host').setLabel('RCON Host').setStyle(TextInputStyle.Short).setValue(server.rcon?.host || '')
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('rcon_port').setLabel('RCON Port').setStyle(TextInputStyle.Short).setValue(String(server.rcon?.port || 14541))
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('rcon_password').setLabel('RCON Password (blank = keep current)').setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder(server.rcon?.password ? '(unchanged)' : 'Enter password')
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('game_port').setLabel('Game Port').setStyle(TextInputStyle.Short).setValue(String(server.gamePort || 14242))
        ),
      );

      await interaction.showModal(modal);
      return true;
    }

    case 'channels': {
      const servers = this.multiServerManager.getAllServers();
      const server = servers.find(s => s.id === serverId);
      if (!server) {
        await interaction.reply({ content: '❌ Server not found.', flags: MessageFlags.Ephemeral });
        return true;
      }

      const ch = server.channels || {};
      const modal = new ModalBuilder()
        .setCustomId(`panel_srv_channels_modal:${serverId}`)
        .setTitle(_modalTitle('Channels: ', server.name, ' (🔄 Server Restart)'));

      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('ch_status').setLabel('Server Status Channel ID').setStyle(TextInputStyle.Short).setValue(ch.serverStatus || '').setRequired(false)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('ch_stats').setLabel('Player Stats Channel ID').setStyle(TextInputStyle.Short).setValue(ch.playerStats || '').setRequired(false)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('ch_log').setLabel('Log Channel ID').setStyle(TextInputStyle.Short).setValue(ch.log || '').setRequired(false)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('ch_chat').setLabel('Chat Relay Channel ID').setStyle(TextInputStyle.Short).setValue(ch.chat || '').setRequired(false)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('ch_admin').setLabel('Admin Channel ID').setStyle(TextInputStyle.Short).setValue(ch.admin || '').setRequired(false)
        ),
      );

      await interaction.showModal(modal);
      return true;
    }

    case 'sftp': {
      const servers = this.multiServerManager.getAllServers();
      const server = servers.find(s => s.id === serverId);
      if (!server) {
        await interaction.reply({ content: '❌ Server not found.', flags: MessageFlags.Ephemeral });
        return true;
      }

      const sftp = server.sftp || {};
      const modal = new ModalBuilder()
        .setCustomId(`panel_srv_sftp_modal:${serverId}`)
        .setTitle(_modalTitle('SFTP: ', server.name, ' (🔄 Server Restart)'));

      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('sftp_host').setLabel('SFTP Host (blank = inherit primary)').setStyle(TextInputStyle.Short).setValue(sftp.host || '').setRequired(false)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('sftp_port').setLabel('SFTP Port').setStyle(TextInputStyle.Short).setValue(String(sftp.port || 22)).setRequired(false)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('sftp_user').setLabel('SFTP Username (blank = inherit)').setStyle(TextInputStyle.Short).setValue(sftp.user || '').setRequired(false)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('sftp_password').setLabel('SFTP Password (blank = inherit primary)').setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder(sftp.password ? '(unchanged)' : 'blank = inherit')
        ),
      );

      await interaction.showModal(modal);
      return true;
    }

    case 'welcome': {
      // Show modal to edit the server's WelcomeMessage.txt
      const servers = this.multiServerManager.getAllServers();
      const server = servers.find(s => s.id === serverId);
      if (!server) {
        await interaction.reply({ content: '❌ Server not found.', flags: MessageFlags.Ephemeral });
        return true;
      }

      const srvConfig = createServerConfig(server);
      if (!srvConfig.ftpHost || !srvConfig.ftpUser || (!srvConfig.ftpPassword && !srvConfig.ftpPrivateKeyPath)) {
        await interaction.reply({ content: '❌ No SFTP credentials configured for this server.', flags: MessageFlags.Ephemeral });
        return true;
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      let currentContent = '';
      try {
        const sftp = new SftpClient();
        await sftp.connect({ host: srvConfig.ftpHost, port: srvConfig.ftpPort, username: srvConfig.ftpUser, password: srvConfig.ftpPassword });
        const welcomePath = srvConfig.ftpWelcomePath || config.ftpWelcomePath;
        const buf = await sftp.get(welcomePath);
        currentContent = buf.toString('utf8');
        await sftp.end().catch(() => {});
      } catch (err) {
        await interaction.editReply(`❌ Could not read WelcomeMessage.txt: ${err.message}`);
        return true;
      }

      // Discord modal text inputs max 4000 chars
      if (currentContent.length > 4000) currentContent = currentContent.slice(0, 4000);

      const modal = new ModalBuilder()
        .setCustomId(`panel_srv_welcome_modal:${serverId}`)
        .setTitle(_modalTitle('Welcome: ', server.name, ''));

      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('welcome_content')
            .setLabel('Welcome Message')
            .setStyle(TextInputStyle.Paragraph)
            .setValue(currentContent)
            .setRequired(false)
            .setMaxLength(4000)
        ),
      );

      await interaction.showModal(modal);
      await interaction.deleteReply().catch(() => {});
      return true;
    }

    case 'automsg': {
      // Show modal to edit per-server auto-message settings
      const servers = this.multiServerManager.getAllServers();
      const server = servers.find(s => s.id === serverId);
      if (!server) {
        await interaction.reply({ content: '❌ Server not found.', flags: MessageFlags.Ephemeral });
        return true;
      }

      const am = server.autoMessages || {};
      const instance = this.multiServerManager.getInstance(serverId);
      const srvConfig = instance?.config || createServerConfig(server);

      const modal = new ModalBuilder()
        .setCustomId(`panel_srv_automsg_modal:${serverId}`)
        .setTitle(_modalTitle('Auto Msgs: ', server.name, ''));

      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('toggles')
            .setLabel('Toggles (welcome_msg,welcome_file,link,promo)')
            .setStyle(TextInputStyle.Short)
            .setValue([
              (am.enableWelcomeMsg  ?? srvConfig.enableWelcomeMsg  ?? true) ? '1' : '0',
              (am.enableWelcomeFile ?? srvConfig.enableWelcomeFile ?? true) ? '1' : '0',
              (am.enableAutoMsgLink ?? srvConfig.enableAutoMsgLink ?? true) ? '1' : '0',
              (am.enableAutoMsgPromo ?? srvConfig.enableAutoMsgPromo ?? true) ? '1' : '0',
            ].join(','))
            .setPlaceholder('1,1,1,1 (1=on, 0=off)')
            .setRequired(true)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('link_text')
            .setLabel('Discord Link Broadcast (blank = default)')
            .setStyle(TextInputStyle.Paragraph)
            .setValue(am.linkText || '')
            .setRequired(false)
            .setMaxLength(4000)
            .setPlaceholder('Join our Discord! {discord_link}')
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('promo_text')
            .setLabel('Promo Broadcast (blank = default)')
            .setStyle(TextInputStyle.Paragraph)
            .setValue(am.promoText || '')
            .setRequired(false)
            .setMaxLength(4000)
            .setPlaceholder('Have any issues? Join our Discord: {discord_link}')
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('discord_link')
            .setLabel('Discord Invite Link (blank = inherit)')
            .setStyle(TextInputStyle.Short)
            .setValue(am.discordLink || '')
            .setRequired(false)
            .setPlaceholder('https://discord.gg/...')
        ),
      );

      await interaction.showModal(modal);
      return true;
    }

    default:
      return false;
  }
}

// ═════════════════════════════════════════════════════════════
// Edit modals (connection, channels, SFTP)
// ═════════════════════════════════════════════════════════════

async function _handleEditServerModal(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (!this._isAdmin(interaction)) {
    await interaction.editReply('❌ Only administrators can manage servers.');
    return true;
  }

  const serverId = interaction.customId.replace('panel_srv_edit_modal:', '');

  try {
    const updates = {
      name: interaction.fields.getTextInputValue('name').trim(),
      gamePort: parseInt(interaction.fields.getTextInputValue('game_port'), 10) || 14242,
      rcon: {
        host: interaction.fields.getTextInputValue('rcon_host').trim(),
        port: parseInt(interaction.fields.getTextInputValue('rcon_port'), 10) || 14541,
      },
    };
    // Only update password if user typed something (blank = keep current)
    const rconPw = interaction.fields.getTextInputValue('rcon_password').trim();
    if (rconPw) updates.rcon.password = rconPw;

    const saved = await this.multiServerManager.updateServer(serverId, updates);
    await interaction.editReply(`✅ **${saved.name}** connection updated. Server restarted with new settings.`);
    setTimeout(() => this._update(true), 2000);
  } catch (err) {
    await interaction.editReply(`❌ Failed to update: ${err.message}`);
  }
  return true;
}

async function _handleEditChannelsModal(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (!this._isAdmin(interaction)) {
    await interaction.editReply('❌ Only administrators can manage servers.');
    return true;
  }

  const serverId = interaction.customId.replace('panel_srv_channels_modal:', '');

  try {
    const channels = {};
    const status = interaction.fields.getTextInputValue('ch_status').trim();
    const stats = interaction.fields.getTextInputValue('ch_stats').trim();
    const log = interaction.fields.getTextInputValue('ch_log').trim();
    const chat = interaction.fields.getTextInputValue('ch_chat').trim();
    const admin = interaction.fields.getTextInputValue('ch_admin').trim();

    if (status) channels.serverStatus = status;
    if (stats) channels.playerStats = stats;
    if (log) channels.log = log;
    if (chat) channels.chat = chat;
    if (admin) channels.admin = admin;

    const saved = await this.multiServerManager.updateServer(serverId, { channels });
    await interaction.editReply(`✅ **${saved.name}** channels updated. Server restarted with new settings.`);
    setTimeout(() => this._update(true), 2000);
  } catch (err) {
    await interaction.editReply(`❌ Failed to update: ${err.message}`);
  }
  return true;
}

async function _handleEditSftpModal(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (!this._isAdmin(interaction)) {
    await interaction.editReply('❌ Only administrators can manage servers.');
    return true;
  }

  const serverId = interaction.customId.replace('panel_srv_sftp_modal:', '');

  try {
    const sftp = {};
    const host = interaction.fields.getTextInputValue('sftp_host').trim();
    const port = interaction.fields.getTextInputValue('sftp_port').trim();
    const user = interaction.fields.getTextInputValue('sftp_user').trim();
    const password = interaction.fields.getTextInputValue('sftp_password').trim();

    if (host) sftp.host = host;
    if (port) sftp.port = parseInt(port, 10) || 22;
    if (user) sftp.user = user;
    if (password) sftp.password = password;

    // If SFTP host changed, clear old paths so auto-discovery re-runs on restart
    const servers = this.multiServerManager.getAllServers();
    const currentServer = servers.find(s => s.id === serverId);
    const hostChanged = host && currentServer?.sftp?.host !== host;
    const updates = { sftp };
    if (hostChanged) updates.paths = {};

    const saved = await this.multiServerManager.updateServer(serverId, updates);
    const sftpStatus = sftp.host ? `${sftp.host}:${sftp.port || 22}` : 'Inherited from primary';
    const extra = hostChanged ? ' Paths will auto-discover on startup.' : '';
    await interaction.editReply(`✅ **${saved.name}** SFTP updated to: ${sftpStatus}${extra}\nServer restarted with new settings.`);
    setTimeout(() => this._update(true), 2000);
  } catch (err) {
    await interaction.editReply(`❌ Failed to update: ${err.message}`);
  }
  return true;
}

// ═════════════════════════════════════════════════════════════
// Managed-server game settings editor (per-server SFTP)
// ═════════════════════════════════════════════════════════════

/** Get effective SFTP config for a managed server (own creds or inherited from primary). */
function _getSrvSftpConfig(serverDef) {
  const srvConfig = createServerConfig(serverDef);
  if (!srvConfig.ftpHost || !srvConfig.ftpUser || (!srvConfig.ftpPassword && !srvConfig.ftpPrivateKeyPath)) return null;
  return {
    host: srvConfig.ftpHost,
    port: srvConfig.ftpPort,
    username: srvConfig.ftpUser,
    password: srvConfig.ftpPassword,
    settingsPath: srvConfig.ftpSettingsPath || config.ftpSettingsPath,
    welcomePath: srvConfig.ftpWelcomePath || config.ftpWelcomePath,
  };
}

async function _handleSrvGameSettingsSelect(interaction) {
  if (!await this._requireAdmin(interaction, 'edit server settings')) return true;

  // customId = panel_srv_settings:<serverId>, value = categoryId
  const serverId = interaction.customId.replace('panel_srv_settings:', '');
  const categoryId = interaction.values[0];
  const category = GAME_SETTINGS_CATEGORIES.find(c => c.id === categoryId);
  if (!category) {
    await interaction.reply({ content: '❌ Unknown category.', flags: MessageFlags.Ephemeral });
    return true;
  }

  const servers = this.multiServerManager?.getAllServers() || [];
  const serverDef = servers.find(s => s.id === serverId);
  if (!serverDef) {
    await interaction.reply({ content: '❌ Server not found.', flags: MessageFlags.Ephemeral });
    return true;
  }

  const sftpCfg = this._getSrvSftpConfig(serverDef);
  if (!sftpCfg) {
    await interaction.reply({ content: '❌ No SFTP credentials for this server.', flags: MessageFlags.Ephemeral });
    return true;
  }

  // Read current settings from bot_state cache
  let cached = {};
  if (this._db) try { cached = this._db.getStateJSON(`server_settings_${serverId}`, {}) || {}; } catch {}

  const modal = new ModalBuilder()
    .setCustomId(`panel_srv_game_modal:${serverId}:${categoryId}`)
    .setTitle(_modalTitle(`${serverDef.name}: `, category.label, ' (🔄 Restart)'));

  for (const setting of category.settings) {
    const currentValue = cached[setting.ini] != null ? String(cached[setting.ini]) : '';
    const input = new TextInputBuilder()
      .setCustomId(setting.ini)
      .setLabel(setting.label)
      .setStyle(TextInputStyle.Short)
      .setValue(currentValue)
      .setRequired(false);
    modal.addComponents(new ActionRowBuilder().addComponents(input));
  }

  await interaction.showModal(modal);
  return true;
}

async function _handleSrvGameSettingsModal(interaction) {
  if (!await this._requireAdmin(interaction, 'edit server settings')) return true;

  // customId = panel_srv_game_modal:<serverId>:<categoryId>
  const parts = interaction.customId.replace('panel_srv_game_modal:', '').split(':');
  const serverId = parts[0];
  const categoryId = parts[1];
  const category = GAME_SETTINGS_CATEGORIES.find(c => c.id === categoryId);
  if (!category) {
    await interaction.reply({ content: '❌ Unknown category.', flags: MessageFlags.Ephemeral });
    return true;
  }

  const servers = this.multiServerManager?.getAllServers() || [];
  const serverDef = servers.find(s => s.id === serverId);
  if (!serverDef) {
    await interaction.reply({ content: '❌ Server not found.', flags: MessageFlags.Ephemeral });
    return true;
  }

  const sftpCfg = this._getSrvSftpConfig(serverDef);
  if (!sftpCfg) {
    await interaction.reply({ content: '❌ No SFTP credentials for this server.', flags: MessageFlags.Ephemeral });
    return true;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const sftp = new SftpClient();
    await sftp.connect({ host: sftpCfg.host, port: sftpCfg.port, username: sftpCfg.username, password: sftpCfg.password });

    let content;
    try {
      content = (await sftp.get(sftpCfg.settingsPath)).toString('utf8');
    } catch (readErr) {
      await sftp.end().catch(() => {});
      throw new Error(`Could not read settings file: ${readErr.message}`);
    }

    // Read/update cache
    let cached = {};
    if (this._db) try { cached = this._db.getStateJSON(`server_settings_${serverId}`, {}) || {}; } catch {}

    const changes = [];
    for (const setting of category.settings) {
      const newValue = interaction.fields.getTextInputValue(setting.ini).trim();
      const oldValue = cached[setting.ini] != null ? String(cached[setting.ini]) : '';

      if (newValue !== oldValue) {
        const regex = new RegExp(`^(${setting.ini}\\s*=\\s*).*$`, 'm');
        if (regex.test(content)) {
          content = content.replace(regex, `$1${newValue}`);
        }
        changes.push(`**${setting.label}:** \`${oldValue || '?'}\` → \`${newValue}\``);
        cached[setting.ini] = newValue;
      }
    }

    if (changes.length === 0) {
      await sftp.end().catch(() => {});
      await interaction.editReply('No changes detected.');
      return true;
    }

    await sftp.put(Buffer.from(content, 'utf8'), sftpCfg.settingsPath);
    await sftp.end().catch(() => {});

    if (this._db) try { this._db.setStateJSON(`server_settings_${serverId}`, cached); } catch (_) {}

    let msg = `✅ **${serverDef.name} — ${category.label}** updated:\n${changes.join('\n')}`;
    msg += '\n\n⚠️ **Restart the game server** for these changes to take effect.';

    await interaction.editReply(msg);
  } catch (err) {
    await interaction.editReply(`❌ Failed to save: ${err.message}`);
  }
  return true;
}

// ═════════════════════════════════════════════════════════════
// Per-server welcome & auto-message modals
// ═════════════════════════════════════════════════════════════

async function _handleSrvWelcomeModal(interaction) {
  if (!await this._requireAdmin(interaction, 'manage servers')) return true;

  const serverId = interaction.customId.replace('panel_srv_welcome_modal:', '');

  const servers = this.multiServerManager?.getAllServers() || [];
  const serverDef = servers.find(s => s.id === serverId);
  if (!serverDef) {
    await interaction.reply({ content: '❌ Server not found.', flags: MessageFlags.Ephemeral });
    return true;
  }

  const sftpCfg = this._getSrvSftpConfig(serverDef);
  if (!sftpCfg) {
    await interaction.reply({ content: '❌ No SFTP credentials for this server.', flags: MessageFlags.Ephemeral });
    return true;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const newContent = interaction.fields.getTextInputValue('welcome_content');
    const sftp = new SftpClient();
    await sftp.connect({ host: sftpCfg.host, port: sftpCfg.port, username: sftpCfg.username, password: sftpCfg.password });
    await sftp.put(Buffer.from(newContent, 'utf8'), sftpCfg.welcomePath);
    await sftp.end().catch(() => {});

    await interaction.editReply(`✅ **${serverDef.name}** welcome message updated (${newContent.length} chars).`);
  } catch (err) {
    await interaction.editReply(`❌ Failed to save welcome message: ${err.message}`);
  }
  return true;
}

async function _handleSrvAutoMsgModal(interaction) {
  if (!await this._requireAdmin(interaction, 'manage servers')) return true;

  const serverId = interaction.customId.replace('panel_srv_automsg_modal:', '');

  const servers = this.multiServerManager?.getAllServers() || [];
  const idx = servers.findIndex(s => s.id === serverId);
  if (idx === -1) {
    await interaction.reply({ content: '❌ Server not found.', flags: MessageFlags.Ephemeral });
    return true;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const togglesRaw = interaction.fields.getTextInputValue('toggles').trim();
    const linkText = interaction.fields.getTextInputValue('link_text').trim();
    const promoText = interaction.fields.getTextInputValue('promo_text').trim();
    const discordLink = interaction.fields.getTextInputValue('discord_link').trim();

    // Parse toggles: "1,1,0,1" → [true, true, false, true]
    const bits = togglesRaw.split(',').map(s => s.trim() === '1');
    const am = {
      enableWelcomeMsg:   bits[0] ?? true,
      enableWelcomeFile:  bits[1] ?? true,
      enableAutoMsgLink:  bits[2] ?? true,
      enableAutoMsgPromo: bits[3] ?? true,
    };
    if (linkText) am.linkText = linkText;
    if (promoText) am.promoText = promoText;
    if (discordLink) am.discordLink = discordLink;

    // Persist to servers.json
    const { loadServers, saveServers } = require('../server/multi-server');
    const allServers = loadServers();
    const srvIdx = allServers.findIndex(s => s.id === serverId);
    if (srvIdx !== -1) {
      allServers[srvIdx].autoMessages = am;
      saveServers(allServers);
    }

    // Hot-update the running instance's config
    const instance = this.multiServerManager.getInstance(serverId);
    if (instance) {
      instance.config.enableWelcomeMsg  = am.enableWelcomeMsg;
      instance.config.enableWelcomeFile = am.enableWelcomeFile;
      instance.config.enableAutoMsgLink = am.enableAutoMsgLink;
      instance.config.enableAutoMsgPromo = am.enableAutoMsgPromo;
      instance.config.autoMsgLinkText  = am.linkText || '';
      instance.config.autoMsgPromoText = am.promoText || '';
      if (am.discordLink) instance.config.discordInviteLink = am.discordLink;
    }

    // Build summary
    const labels = ['RCON Welcome', 'Welcome File', 'Link Broadcast', 'Promo Broadcast'];
    const summary = labels.map((l, i) => `${bits[i] ? '✅' : '❌'} ${l}`).join('\n');
    const extras = [];
    if (linkText) extras.push(`Link text: \`${linkText.slice(0, 60)}${linkText.length > 60 ? '...' : ''}\``);
    if (promoText) extras.push(`Promo text: \`${promoText.slice(0, 60)}${promoText.length > 60 ? '...' : ''}\``);
    if (discordLink) extras.push(`Discord: \`${discordLink}\``);

    await interaction.editReply(
      `✅ **Auto Messages updated for ${servers[idx].name}**\n${summary}` +
      (extras.length > 0 ? `\n${extras.join('\n')}` : '') +
      `\n\n⚠️ Restart the server to apply toggle changes.`
    );
  } catch (err) {
    await interaction.editReply(`❌ Failed to save: ${err.message}`);
  }
  return true;
}

// ═════════════════════════════════════════════════════════════
// Export all handlers for prototype assignment
// ═════════════════════════════════════════════════════════════

module.exports = {
  _handleAddServerButton,
  _handleAddServerStep1Modal,
  _handleAddSftpButton,
  _handleAddSftpModal,
  _handleAddServerStep2Button,
  _handleAddServerStep2Modal,
  _handleServerSelect,
  _handleServerAction,
  _handleEditServerModal,
  _handleEditChannelsModal,
  _handleEditSftpModal,
  _getSrvSftpConfig,
  _handleSrvGameSettingsSelect,
  _handleSrvGameSettingsModal,
  _handleSrvWelcomeModal,
  _handleSrvAutoMsgModal,
};

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
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
} = require('discord.js');
const config = require('../config');
const SftpClient = require('ssh2-sftp-client');
const { createServerConfig } = require('../server/multi-server');
const { GAME_SETTINGS_CATEGORIES } = require('./panel-constants');
const { _detectSshKey } = require('./panel-setup-wizard');

/** Safely build a modal title within Discord's 45-char limit. */
function _modalTitle(prefix, name, suffix) {
  const maxName = 45 - prefix.length - suffix.length;
  if (maxName <= 0) return `${prefix}${suffix}`.slice(0, 45);
  const chars = Array.from(name);
  const truncated = chars.length > maxName ? chars.slice(0, maxName - 1).join('') + '…' : name;
  return `${prefix}${truncated}${suffix}`;
}

// ═════════════════════════════════════════════════════════════
// Add server wizard
// ═════════════════════════════════════════════════════════════

async function _handleAddServerButton(interaction) {
  if (!(await this._requireAdmin(interaction, this._ti(interaction, 'ms_action_manage_servers')))) return true;

  const modal = new ModalBuilder()
    .setCustomId('panel_add_modal_step1')
    .setTitle(this._ti(interaction, 'ms_add_step1_title'));

  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('name')
        .setLabel(this._ti(interaction, 'ms_label_server_name'))
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder(this._ti(interaction, 'ms_placeholder_server_name')),
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('rcon_host')
        .setLabel(this._ti(interaction, 'ms_label_rcon_host'))
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder(this._ti(interaction, 'ms_placeholder_rcon_host')),
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('rcon_port')
        .setLabel(this._ti(interaction, 'ms_label_rcon_port'))
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setValue('14541'),
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('rcon_password')
        .setLabel(this._ti(interaction, 'ms_label_rcon_password'))
        .setStyle(TextInputStyle.Short)
        .setRequired(true),
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('game_port')
        .setLabel(this._ti(interaction, 'ms_label_game_port'))
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setValue('14242'),
    ),
  );

  await interaction.showModal(modal);
  return true;
}

async function _handleAddServerStep1Modal(interaction) {
  if (!(await this._requireAdmin(interaction, this._ti(interaction, 'ms_action_manage_servers')))) return true;

  const name = interaction.fields.getTextInputValue('name').trim();
  const rconHost = interaction.fields.getTextInputValue('rcon_host').trim();
  const rconPort = parseInt(interaction.fields.getTextInputValue('rcon_port'), 10) || 14541;
  const rconPassword = interaction.fields.getTextInputValue('rcon_password').trim();
  const gamePort = parseInt(interaction.fields.getTextInputValue('game_port'), 10) || 14242;

  if (!name || !rconHost || !rconPassword) {
    await interaction.reply({
      content: this._ti(interaction, 'ms_err_required_fields'),
      flags: MessageFlags.Ephemeral,
    });
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
    .setLabel(this._ti(interaction, 'ms_btn_configure_sftp'))
    .setStyle(ButtonStyle.Primary);

  const continueBtn = new ButtonBuilder()
    .setCustomId(`panel_add_step2:${interaction.user.id}`)
    .setLabel(this._ti(interaction, 'ms_btn_configure_channels'))
    .setStyle(ButtonStyle.Primary);

  const skipBtn = new ButtonBuilder()
    .setCustomId(`panel_srv_skip_channels:${interaction.user.id}`)
    .setLabel(this._ti(interaction, 'ms_btn_skip_save'))
    .setStyle(ButtonStyle.Secondary);

  await interaction.reply({
    content: this._ti(interaction, 'ms_ok_step1_complete', { name }),
    components: [new ActionRowBuilder().addComponents(sftpBtn, continueBtn, skipBtn)],
    flags: MessageFlags.Ephemeral,
  });
  return true;
}

async function _handleAddSftpButton(interaction, customId) {
  if (!(await this._requireAdmin(interaction, this._ti(interaction, 'ms_action_manage_servers')))) return true;

  const userId = customId.replace('panel_add_sftp:', '');
  const pending = this._pendingServers.get(userId);
  if (!pending) {
    await interaction.reply({
      content: this._ti(interaction, 'ms_err_session_expired'),
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  const modal = new ModalBuilder()
    .setCustomId(`panel_add_sftp_modal:${userId}`)
    .setTitle(this._ti(interaction, 'ms_add_sftp_title'));

  // Auto-detect SSH keys on the bot host
  const detectedKey = _detectSshKey();

  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('sftp_host')
        .setLabel(this._ti(interaction, 'ms_label_sftp_host'))
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder(this._ti(interaction, 'ms_placeholder_sftp_host')),
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('sftp_port')
        .setLabel(this._ti(interaction, 'ms_label_sftp_port'))
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setValue('22'),
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('sftp_user')
        .setLabel(this._ti(interaction, 'ms_label_sftp_username'))
        .setStyle(TextInputStyle.Short)
        .setRequired(true),
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('sftp_password')
        .setLabel(this._ti(interaction, 'ms_label_sftp_password_key'))
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setPlaceholder(this._ti(interaction, 'ms_placeholder_key_auth')),
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('sftp_key_path')
        .setLabel(this._ti(interaction, 'ms_label_ssh_key_path'))
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setValue(detectedKey)
        .setPlaceholder(
          detectedKey
            ? this._ti(interaction, 'ms_placeholder_detected_key', { key: detectedKey })
            : this._ti(interaction, 'ms_placeholder_no_keys'),
        ),
    ),
  );

  await interaction.showModal(modal);
  return true;
}

async function _handleAddSftpModal(interaction) {
  if (!(await this._requireAdmin(interaction, this._ti(interaction, 'ms_action_manage_servers')))) return true;

  const userId = interaction.customId.replace('panel_add_sftp_modal:', '');
  const pending = this._pendingServers.get(userId);
  if (!pending) {
    await interaction.reply({
      content: this._ti(interaction, 'ms_err_session_expired'),
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  const host = interaction.fields.getTextInputValue('sftp_host').trim();
  const port = parseInt(interaction.fields.getTextInputValue('sftp_port'), 10) || 22;
  const user = interaction.fields.getTextInputValue('sftp_user').trim();
  const password = interaction.fields.getTextInputValue('sftp_password').trim();
  const privateKeyPath = interaction.fields.getTextInputValue('sftp_key_path').trim();

  if (!host || !user || (!password && !privateKeyPath)) {
    await interaction.reply({
      content: this._ti(interaction, 'ms_err_sftp_required'),
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  // Store SFTP config on the pending server definition
  const sftp = { host, port, user };
  if (password) sftp.password = password;
  if (privateKeyPath) sftp.privateKeyPath = privateKeyPath;
  pending.sftp = sftp;

  // Show continue/skip buttons
  const continueBtn = new ButtonBuilder()
    .setCustomId(`panel_add_step2:${userId}`)
    .setLabel(this._ti(interaction, 'ms_btn_configure_channels'))
    .setStyle(ButtonStyle.Primary);

  const skipBtn = new ButtonBuilder()
    .setCustomId(`panel_srv_skip_channels:${userId}`)
    .setLabel(this._ti(interaction, 'ms_btn_skip_save'))
    .setStyle(ButtonStyle.Secondary);

  await interaction.reply({
    content: this._ti(interaction, 'ms_ok_sftp_configured', { host, port }),
    components: [new ActionRowBuilder().addComponents(continueBtn, skipBtn)],
    flags: MessageFlags.Ephemeral,
  });
  return true;
}

async function _handleAddServerStep2Button(interaction, customId) {
  if (!(await this._requireAdmin(interaction, this._ti(interaction, 'ms_action_manage_servers')))) return true;

  const userId = customId.replace('panel_add_step2:', '');
  const pending = this._pendingServers.get(userId);
  if (!pending) {
    await interaction.reply({
      content: this._ti(interaction, 'ms_err_session_expired'),
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  const modal = new ModalBuilder()
    .setCustomId(`panel_add_modal_step2:${userId}`)
    .setTitle(this._ti(interaction, 'ms_add_step2_title'));

  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('ch_status')
        .setLabel(this._ti(interaction, 'ms_label_status_channel'))
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setPlaceholder(this._ti(interaction, 'ms_placeholder_copy_channel')),
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('ch_stats')
        .setLabel(this._ti(interaction, 'ms_label_stats_channel'))
        .setStyle(TextInputStyle.Short)
        .setRequired(false),
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('ch_log')
        .setLabel(this._ti(interaction, 'ms_label_log_channel'))
        .setStyle(TextInputStyle.Short)
        .setRequired(false),
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('ch_chat')
        .setLabel(this._ti(interaction, 'ms_label_chat_channel'))
        .setStyle(TextInputStyle.Short)
        .setRequired(false),
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('ch_admin')
        .setLabel(this._ti(interaction, 'ms_label_admin_channel'))
        .setStyle(TextInputStyle.Short)
        .setRequired(false),
    ),
  );

  await interaction.showModal(modal);
  return true;
}

async function _handleAddServerStep2Modal(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (!this._isAdmin(interaction)) {
    await interaction.editReply(this._ti(interaction, 'ms_err_admin_only'));
    return true;
  }

  const userId = interaction.customId.replace('panel_add_modal_step2:', '');
  const pending = this._pendingServers.get(userId);
  if (!pending) {
    await interaction.editReply(this._ti(interaction, 'ms_err_session_expired'));
    return true;
  }

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

  if (!this.multiServerManager) {
    await interaction.editReply(this._ti(interaction, 'ms_err_manager_unavailable'));
    return true;
  }

  const channelCount = Object.keys(channels).length;

  // Reply immediately — addServer triggers SFTP auto-discovery which can take 60s+
  await interaction.editReply(this._ti(interaction, 'ms_saving_server', { name: serverDef.name }));

  // Run the long operation in the background so the user isn't staring at "thinking..."
  this.multiServerManager
    .addServer(serverDef)
    .then(async (saved) => {
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

      try {
        await interaction.editReply(
          this._ti(interaction, 'ms_ok_server_added', {
            name: saved.name,
            rcon: `${saved.rcon.host}:${saved.rcon.port}`,
            gamePort: saved.gamePort,
            channels: channelCount,
            sftp: serverDef.sftp
              ? this._ti(interaction, 'ms_sftp_configured_label')
              : this._ti(interaction, 'ms_sftp_inherited'),
          }),
        );
      } catch {
        /* interaction may have expired after 15 min */
      }

      // Refresh the bot controls embed
      setTimeout(() => this._update(true), 1000);
    })
    .catch(async (err) => {
      try {
        await interaction.editReply(this._ti(interaction, 'ms_err_add_failed', { message: err.message }));
      } catch {
        /* interaction may have expired */
      }
    });

  return true;
}

// ═════════════════════════════════════════════════════════════
// Server management (select, start/stop/restart/remove/edit)
// ═════════════════════════════════════════════════════════════

async function _handleServerSelect(interaction) {
  if (!(await this._requireAdmin(interaction, this._ti(interaction, 'ms_action_manage_servers')))) return true;

  const serverId = interaction.values[0];
  const servers = this.multiServerManager?.getAllServers() || [];
  const server = servers.find((s) => s.id === serverId);
  if (!server) {
    await interaction.reply({
      content: this._ti(interaction, 'ms_err_server_not_found'),
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  const instance = this.multiServerManager.getInstance(serverId);
  const running = instance?.running || false;

  // Build management buttons
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`panel_srv_start:${serverId}`)
      .setLabel(this._ti(interaction, 'ms_btn_start'))
      .setStyle(ButtonStyle.Success)
      .setDisabled(running),
    new ButtonBuilder()
      .setCustomId(`panel_srv_stop:${serverId}`)
      .setLabel(this._ti(interaction, 'ms_btn_stop'))
      .setStyle(ButtonStyle.Danger)
      .setDisabled(!running),
    new ButtonBuilder()
      .setCustomId(`panel_srv_edit:${serverId}`)
      .setLabel(this._ti(interaction, 'ms_btn_edit_connection'))
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`panel_srv_remove:${serverId}`)
      .setLabel(this._ti(interaction, 'ms_btn_remove'))
      .setStyle(ButtonStyle.Danger),
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`panel_srv_channels:${serverId}`)
      .setLabel(this._ti(interaction, 'ms_btn_edit_channels'))
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`panel_srv_sftp:${serverId}`)
      .setLabel(this._ti(interaction, 'ms_btn_edit_sftp'))
      .setStyle(ButtonStyle.Secondary),
  );

  // Build info text
  const ch = server.channels || {};
  const channelLines = [];
  if (ch.serverStatus) channelLines.push(this._ti(interaction, 'ms_channel_status', { channelId: ch.serverStatus }));
  if (ch.playerStats) channelLines.push(this._ti(interaction, 'ms_channel_stats', { channelId: ch.playerStats }));
  if (ch.log) channelLines.push(this._ti(interaction, 'ms_channel_log', { channelId: ch.log }));
  if (ch.chat) channelLines.push(this._ti(interaction, 'ms_channel_chat', { channelId: ch.chat }));
  if (ch.admin) channelLines.push(this._ti(interaction, 'ms_channel_admin', { channelId: ch.admin }));

  const sftpInfo = server.sftp?.host
    ? `${server.sftp.host}:${server.sftp.port || 22}`
    : this._ti(interaction, 'ms_sftp_inherited_short');
  const moduleList = instance
    ? instance.getStatus().modules.join(', ') || this._ti(interaction, 'ms_none')
    : this._ti(interaction, 'ms_not_running');

  const statusLabel = running ? this._ti(interaction, 'ms_server_running') : this._ti(interaction, 'ms_server_stopped');
  const channelsInfo =
    channelLines.length > 0
      ? '\n' + channelLines.map((l) => `  ${l}`).join('\n')
      : this._ti(interaction, 'ms_none_configured');

  await interaction.reply({
    content: [
      this._ti(interaction, 'ms_info_header', { name: server.name, status: statusLabel }),
      this._ti(interaction, 'ms_info_rcon', {
        host: server.rcon?.host || '?',
        port: server.rcon?.port || 14541,
      }),
      this._ti(interaction, 'ms_info_game_port', { port: server.gamePort || 14242 }),
      this._ti(interaction, 'ms_info_sftp', { info: sftpInfo }),
      this._ti(interaction, 'ms_info_channels', { info: channelsInfo }),
      this._ti(interaction, 'ms_info_modules', { list: moduleList }),
    ].join('\n'),
    components: [row1, row2],
    flags: MessageFlags.Ephemeral,
  });
  return true;
}

async function _handleServerAction(interaction, customId) {
  if (!(await this._requireAdmin(interaction, this._ti(interaction, 'ms_action_manage_servers')))) return true;

  // Handle skip channels button from add wizard
  if (customId.startsWith('panel_srv_skip_channels:')) {
    const userId = customId.replace('panel_srv_skip_channels:', '');
    const pending = this._pendingServers.get(userId);
    if (!pending) {
      await interaction.reply({
        content: this._ti(interaction, 'ms_err_session_expired_short'),
        flags: MessageFlags.Ephemeral,
      });
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
      await interaction.editReply(this._ti(interaction, 'ms_ok_server_added_no_channels', { name: saved.name }));
      setTimeout(() => this._update(true), 1000);
    } catch (err) {
      await interaction.editReply(this._ti(interaction, 'ms_err_add_failed', { message: err.message }));
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
        await interaction.editReply(this._ti(interaction, 'ms_ok_server_started'));
        setTimeout(() => this._update(true), 2000);
      } catch (err) {
        await interaction.editReply(this._ti(interaction, 'ms_err_start_failed', { message: err.message }));
      }
      return true;
    }

    case 'stop': {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        await this.multiServerManager.stopServer(serverId);
        await interaction.editReply(this._ti(interaction, 'ms_ok_server_stopped'));
        setTimeout(() => this._update(true), 1000);
      } catch (err) {
        await interaction.editReply(this._ti(interaction, 'ms_err_stop_failed', { message: err.message }));
      }
      return true;
    }

    case 'restart': {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        await this.multiServerManager.stopServer(serverId);
        await this.multiServerManager.startServer(serverId);
        await interaction.editReply(this._ti(interaction, 'ms_ok_server_restarted'));
        setTimeout(() => this._update(true), 2000);
      } catch (err) {
        await interaction.editReply(this._ti(interaction, 'ms_err_restart_failed', { message: err.message }));
      }
      return true;
    }

    case 'remove': {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        const servers = this.multiServerManager.getAllServers();
        const server = servers.find((s) => s.id === serverId);
        const name = server?.name || serverId;
        await this.multiServerManager.removeServer(serverId);
        // Delete the per-server embed message
        const srvMsg = this._serverMessages.get(serverId);
        if (srvMsg) {
          try {
            await srvMsg.delete();
          } catch {}
          this._serverMessages.delete(serverId);
          this._lastServerKeys.delete(serverId);
          this._saveMessageIds();
        }
        await interaction.editReply(this._ti(interaction, 'ms_ok_server_removed', { name }));
        setTimeout(() => this._update(true), 1000);
      } catch (err) {
        await interaction.editReply(this._ti(interaction, 'ms_err_remove_failed', { message: err.message }));
      }
      return true;
    }

    case 'edit': {
      // Show modal with current connection values
      const servers = this.multiServerManager.getAllServers();
      const server = servers.find((s) => s.id === serverId);
      if (!server) {
        await interaction.reply({
          content: this._ti(interaction, 'ms_err_server_not_found'),
          flags: MessageFlags.Ephemeral,
        });
        return true;
      }

      const modal = new ModalBuilder()
        .setCustomId(`panel_srv_edit_modal:${serverId}`)
        .setTitle(
          _modalTitle(
            this._ti(interaction, 'ms_modal_prefix_edit'),
            server.name,
            this._ti(interaction, 'ms_modal_suffix_server_restart'),
          ),
        );

      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('name')
            .setLabel(this._ti(interaction, 'ms_label_server_name'))
            .setStyle(TextInputStyle.Short)
            .setValue(server.name || ''),
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('rcon_host')
            .setLabel(this._ti(interaction, 'ms_label_rcon_host'))
            .setStyle(TextInputStyle.Short)
            .setValue(server.rcon?.host || ''),
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('rcon_port')
            .setLabel(this._ti(interaction, 'ms_label_rcon_port'))
            .setStyle(TextInputStyle.Short)
            .setValue(String(server.rcon?.port || 14541)),
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('rcon_password')
            .setLabel(this._ti(interaction, 'ms_label_rcon_password_keep'))
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setPlaceholder(
              server.rcon?.password
                ? this._ti(interaction, 'ms_placeholder_unchanged')
                : this._ti(interaction, 'ms_placeholder_enter_password'),
            ),
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('game_port')
            .setLabel(this._ti(interaction, 'ms_label_game_port'))
            .setStyle(TextInputStyle.Short)
            .setValue(String(server.gamePort || 14242)),
        ),
      );

      await interaction.showModal(modal);
      return true;
    }

    case 'channels': {
      const servers = this.multiServerManager.getAllServers();
      const server = servers.find((s) => s.id === serverId);
      if (!server) {
        await interaction.reply({
          content: this._ti(interaction, 'ms_err_server_not_found'),
          flags: MessageFlags.Ephemeral,
        });
        return true;
      }

      const ch = server.channels || {};
      const modal = new ModalBuilder()
        .setCustomId(`panel_srv_channels_modal:${serverId}`)
        .setTitle(
          _modalTitle(
            this._ti(interaction, 'ms_modal_prefix_channels'),
            server.name,
            this._ti(interaction, 'ms_modal_suffix_server_restart'),
          ),
        );

      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('ch_status')
            .setLabel(this._ti(interaction, 'ms_label_status_channel'))
            .setStyle(TextInputStyle.Short)
            .setValue(ch.serverStatus || '')
            .setRequired(false),
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('ch_stats')
            .setLabel(this._ti(interaction, 'ms_label_stats_channel'))
            .setStyle(TextInputStyle.Short)
            .setValue(ch.playerStats || '')
            .setRequired(false),
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('ch_log')
            .setLabel(this._ti(interaction, 'ms_label_log_channel'))
            .setStyle(TextInputStyle.Short)
            .setValue(ch.log || '')
            .setRequired(false),
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('ch_chat')
            .setLabel(this._ti(interaction, 'ms_label_chat_channel'))
            .setStyle(TextInputStyle.Short)
            .setValue(ch.chat || '')
            .setRequired(false),
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('ch_admin')
            .setLabel(this._ti(interaction, 'ms_label_admin_channel'))
            .setStyle(TextInputStyle.Short)
            .setValue(ch.admin || '')
            .setRequired(false),
        ),
      );

      await interaction.showModal(modal);
      return true;
    }

    case 'sftp': {
      const servers = this.multiServerManager.getAllServers();
      const server = servers.find((s) => s.id === serverId);
      if (!server) {
        await interaction.reply({
          content: this._ti(interaction, 'ms_err_server_not_found'),
          flags: MessageFlags.Ephemeral,
        });
        return true;
      }

      const sftp = server.sftp || {};
      const detectedKey = sftp.privateKeyPath || _detectSshKey();
      const modal = new ModalBuilder()
        .setCustomId(`panel_srv_sftp_modal:${serverId}`)
        .setTitle(
          _modalTitle(
            this._ti(interaction, 'ms_modal_prefix_sftp'),
            server.name,
            this._ti(interaction, 'ms_modal_suffix_server_restart'),
          ),
        );

      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('sftp_host')
            .setLabel(this._ti(interaction, 'ms_label_sftp_host_inherit'))
            .setStyle(TextInputStyle.Short)
            .setValue(sftp.host || '')
            .setRequired(false),
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('sftp_port')
            .setLabel(this._ti(interaction, 'ms_label_sftp_port'))
            .setStyle(TextInputStyle.Short)
            .setValue(String(sftp.port || 22))
            .setRequired(false),
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('sftp_user')
            .setLabel(this._ti(interaction, 'ms_label_sftp_user_inherit'))
            .setStyle(TextInputStyle.Short)
            .setValue(sftp.user || '')
            .setRequired(false),
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('sftp_password')
            .setLabel(this._ti(interaction, 'ms_label_sftp_password_inherit'))
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setPlaceholder(
              sftp.password
                ? this._ti(interaction, 'ms_placeholder_unchanged')
                : this._ti(interaction, 'ms_placeholder_blank_inherit'),
            ),
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('sftp_key_path')
            .setLabel(this._ti(interaction, 'ms_label_ssh_key_path'))
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setValue(detectedKey)
            .setPlaceholder(
              detectedKey
                ? this._ti(interaction, 'ms_placeholder_detected_key', { key: detectedKey })
                : this._ti(interaction, 'ms_placeholder_no_keys_password'),
            ),
        ),
      );

      await interaction.showModal(modal);
      return true;
    }

    case 'welcome': {
      // Show modal to edit the server's WelcomeMessage.txt
      const servers = this.multiServerManager.getAllServers();
      const server = servers.find((s) => s.id === serverId);
      if (!server) {
        await interaction.reply({
          content: this._ti(interaction, 'ms_err_server_not_found'),
          flags: MessageFlags.Ephemeral,
        });
        return true;
      }

      const sftpCfg = _getSrvSftpConfig(server);
      if (!sftpCfg) {
        await interaction.reply({
          content: this._ti(interaction, 'ms_err_no_sftp'),
          flags: MessageFlags.Ephemeral,
        });
        return true;
      }

      // We need to fetch the current welcome message via SFTP before showing the modal.
      // Since modals must be shown within 3s and SFTP may be slow, we show the modal
      // immediately with empty content, and the user can paste/type their message.
      // Store server ID in pending state so we can pre-fill if needed.
      let currentContent;
      try {
        // Try a quick SFTP fetch — if it takes too long, the modal will be empty
        const sftp = new SftpClient();
        const { settingsPath: _s, welcomePath, ...connectOpts } = sftpCfg;
        await sftp.connect(connectOpts);
        const buf = await sftp.get(welcomePath);
        currentContent = buf.toString('utf8');
        await sftp.end().catch(() => {});
      } catch (_err) {
        // Couldn't read — show modal with empty content, user can still type
        currentContent = '';
      }

      // Discord modal text inputs max 4000 chars
      if (currentContent.length > 4000) currentContent = currentContent.slice(0, 4000);

      const modal = new ModalBuilder()
        .setCustomId(`panel_srv_welcome_modal:${serverId}`)
        .setTitle(_modalTitle(this._ti(interaction, 'ms_modal_prefix_welcome'), server.name, ''));

      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('welcome_content')
            .setLabel(this._ti(interaction, 'ms_label_welcome_message'))
            .setStyle(TextInputStyle.Paragraph)
            .setValue(currentContent)
            .setRequired(false)
            .setMaxLength(4000),
        ),
      );

      await interaction.showModal(modal);
      return true;
    }

    case 'automsg': {
      // Show modal to edit per-server auto-message settings
      const servers = this.multiServerManager.getAllServers();
      const server = servers.find((s) => s.id === serverId);
      if (!server) {
        await interaction.reply({
          content: this._ti(interaction, 'ms_err_server_not_found'),
          flags: MessageFlags.Ephemeral,
        });
        return true;
      }

      const am = server.autoMessages || {};
      const instance = this.multiServerManager.getInstance(serverId);
      const srvConfig = instance?.config || createServerConfig(server);

      const modal = new ModalBuilder()
        .setCustomId(`panel_srv_automsg_modal:${serverId}`)
        .setTitle(_modalTitle(this._ti(interaction, 'ms_modal_prefix_automsg'), server.name, ''));

      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('toggles')
            .setLabel(this._ti(interaction, 'ms_label_toggles'))
            .setStyle(TextInputStyle.Short)
            .setValue(
              [
                (am.enableWelcomeMsg ?? srvConfig.enableWelcomeMsg ?? true) ? '1' : '0',
                (am.enableWelcomeFile ?? srvConfig.enableWelcomeFile ?? true) ? '1' : '0',
                (am.enableAutoMsgLink ?? srvConfig.enableAutoMsgLink ?? true) ? '1' : '0',
                (am.enableAutoMsgPromo ?? srvConfig.enableAutoMsgPromo ?? true) ? '1' : '0',
              ].join(','),
            )
            .setPlaceholder(this._ti(interaction, 'ms_placeholder_toggles'))
            .setRequired(true),
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('link_text')
            .setLabel(this._ti(interaction, 'ms_label_link_broadcast'))
            .setStyle(TextInputStyle.Paragraph)
            .setValue(am.linkText || '')
            .setRequired(false)
            .setMaxLength(4000)
            .setPlaceholder(this._ti(interaction, 'ms_placeholder_link_broadcast')),
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('promo_text')
            .setLabel(this._ti(interaction, 'ms_label_promo_broadcast'))
            .setStyle(TextInputStyle.Paragraph)
            .setValue(am.promoText || '')
            .setRequired(false)
            .setMaxLength(4000)
            .setPlaceholder(this._ti(interaction, 'ms_placeholder_promo_broadcast')),
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('discord_link')
            .setLabel(this._ti(interaction, 'ms_label_discord_link'))
            .setStyle(TextInputStyle.Short)
            .setValue(am.discordLink || '')
            .setRequired(false)
            .setPlaceholder(this._ti(interaction, 'ms_placeholder_discord_link')),
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
    await interaction.editReply(this._ti(interaction, 'ms_err_admin_only'));
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
    await interaction.editReply(this._ti(interaction, 'ms_ok_connection_updated', { name: saved.name }));
    setTimeout(() => this._update(true), 2000);
  } catch (err) {
    await interaction.editReply(this._ti(interaction, 'ms_err_update_failed', { message: err.message }));
  }
  return true;
}

async function _handleEditChannelsModal(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (!this._isAdmin(interaction)) {
    await interaction.editReply(this._ti(interaction, 'ms_err_admin_only'));
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
    await interaction.editReply(this._ti(interaction, 'ms_ok_channels_updated', { name: saved.name }));
    setTimeout(() => this._update(true), 2000);
  } catch (err) {
    await interaction.editReply(this._ti(interaction, 'ms_err_update_failed', { message: err.message }));
  }
  return true;
}

async function _handleEditSftpModal(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (!this._isAdmin(interaction)) {
    await interaction.editReply(this._ti(interaction, 'ms_err_admin_only'));
    return true;
  }

  const serverId = interaction.customId.replace('panel_srv_sftp_modal:', '');

  try {
    const sftp = {};
    const host = interaction.fields.getTextInputValue('sftp_host').trim();
    const port = interaction.fields.getTextInputValue('sftp_port').trim();
    const user = interaction.fields.getTextInputValue('sftp_user').trim();
    const password = interaction.fields.getTextInputValue('sftp_password').trim();
    const privateKeyPath = interaction.fields.getTextInputValue('sftp_key_path').trim();

    if (host) sftp.host = host;
    if (port) sftp.port = parseInt(port, 10) || 22;
    if (user) sftp.user = user;
    if (password) sftp.password = password;
    if (privateKeyPath) sftp.privateKeyPath = privateKeyPath;

    // If SFTP host changed, clear old paths so auto-discovery re-runs on restart
    const servers = this.multiServerManager.getAllServers();
    const currentServer = servers.find((s) => s.id === serverId);
    const hostChanged = host && currentServer?.sftp?.host !== host;
    const updates = { sftp };
    if (hostChanged) updates.paths = {};

    const saved = await this.multiServerManager.updateServer(serverId, updates);
    const sftpStatus = sftp.host ? `${sftp.host}:${sftp.port || 22}` : this._ti(interaction, 'ms_sftp_inherited_short');
    const extra = hostChanged ? this._ti(interaction, 'ms_paths_auto_discover') : '';
    await interaction.editReply(
      this._ti(interaction, 'ms_ok_sftp_updated', { name: saved.name, status: sftpStatus, extra }),
    );
    setTimeout(() => this._update(true), 2000);
  } catch (err) {
    await interaction.editReply(this._ti(interaction, 'ms_err_update_failed', { message: err.message }));
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
  const cfg = {
    host: srvConfig.ftpHost,
    port: srvConfig.ftpPort,
    username: srvConfig.ftpUser,
    settingsPath: srvConfig.ftpSettingsPath || config.ftpSettingsPath,
    welcomePath: srvConfig.ftpWelcomePath || config.ftpWelcomePath,
  };
  if (srvConfig.ftpPrivateKeyPath) {
    try {
      cfg.privateKey = require('fs').readFileSync(srvConfig.ftpPrivateKeyPath);
      if (srvConfig.ftpPassword) cfg.passphrase = srvConfig.ftpPassword;
    } catch (err) {
      console.error(`[MULTI-SRV] Could not read SSH key at ${srvConfig.ftpPrivateKeyPath}:`, err.message);
      cfg.password = srvConfig.ftpPassword;
    }
  } else {
    cfg.password = srvConfig.ftpPassword;
  }
  return cfg;
}

async function _handleSrvGameSettingsSelect(interaction) {
  if (!(await this._requireAdmin(interaction, this._ti(interaction, 'ms_action_edit_settings')))) return true;

  // customId = panel_srv_settings:<serverId>, value = categoryId
  const serverId = interaction.customId.replace('panel_srv_settings:', '');
  const categoryId = interaction.values[0];
  const category = GAME_SETTINGS_CATEGORIES.find((c) => c.id === categoryId);
  if (!category) {
    await interaction.reply({
      content: this._ti(interaction, 'ms_err_unknown_category'),
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  const servers = this.multiServerManager?.getAllServers() || [];
  const serverDef = servers.find((s) => s.id === serverId);
  if (!serverDef) {
    await interaction.reply({
      content: this._ti(interaction, 'ms_err_server_not_found'),
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  const sftpCfg = this._getSrvSftpConfig(serverDef);
  if (!sftpCfg) {
    await interaction.reply({
      content: this._ti(interaction, 'ms_err_no_sftp_short'),
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  // Read current settings from bot_state cache
  let cached = {};
  if (this._db)
    try {
      cached = this._db.getStateJSON(`server_settings_${serverId}`, {}) || {};
    } catch {}

  const modal = new ModalBuilder()
    .setCustomId(`panel_srv_game_modal:${serverId}:${categoryId}`)
    .setTitle(
      _modalTitle(
        `${serverDef.name}: `,
        this._ti(interaction, `game_cat_${category.id}`),
        this._ti(interaction, 'ms_modal_suffix_restart'),
      ),
    );

  for (const setting of category.settings) {
    const currentValue = cached[setting.ini] != null ? String(cached[setting.ini]) : '';
    const input = new TextInputBuilder()
      .setCustomId(setting.ini)
      .setLabel(this._ti(interaction, `field_${setting.ini.toLowerCase()}`))
      .setStyle(TextInputStyle.Short)
      .setValue(currentValue)
      .setRequired(false);
    modal.addComponents(new ActionRowBuilder().addComponents(input));
  }

  await interaction.showModal(modal);
  return true;
}

async function _handleSrvGameSettingsModal(interaction) {
  if (!(await this._requireAdmin(interaction, this._ti(interaction, 'ms_action_edit_settings')))) return true;

  // customId = panel_srv_game_modal:<serverId>:<categoryId>
  const parts = interaction.customId.replace('panel_srv_game_modal:', '').split(':');
  const serverId = parts[0];
  const categoryId = parts[1];
  const category = GAME_SETTINGS_CATEGORIES.find((c) => c.id === categoryId);
  if (!category) {
    await interaction.reply({
      content: this._ti(interaction, 'ms_err_unknown_category'),
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  const servers = this.multiServerManager?.getAllServers() || [];
  const serverDef = servers.find((s) => s.id === serverId);
  if (!serverDef) {
    await interaction.reply({
      content: this._ti(interaction, 'ms_err_server_not_found'),
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  const sftpCfg = this._getSrvSftpConfig(serverDef);
  if (!sftpCfg) {
    await interaction.reply({
      content: this._ti(interaction, 'ms_err_no_sftp_short'),
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const sftp = new SftpClient();
    const { settingsPath, welcomePath: _w, ...connectOpts } = sftpCfg;
    await sftp.connect(connectOpts);

    let content;
    try {
      content = (await sftp.get(settingsPath)).toString('utf8');
    } catch (readErr) {
      await sftp.end().catch(() => {});
      throw new Error(this._ti(interaction, 'ms_err_read_settings', { message: readErr.message }), {
        cause: readErr,
      });
    }

    // Read/update cache
    let cached = {};
    if (this._db)
      try {
        cached = this._db.getStateJSON(`server_settings_${serverId}`, {}) || {};
      } catch {}

    const changes = [];
    for (const setting of category.settings) {
      const newValue = interaction.fields.getTextInputValue(setting.ini).trim();
      const oldValue = cached[setting.ini] != null ? String(cached[setting.ini]) : '';

      if (newValue !== oldValue) {
        const regex = new RegExp(`^(${setting.ini}\\s*=\\s*).*$`, 'm');
        if (regex.test(content)) {
          content = content.replace(regex, `$1${newValue}`);
        }
        changes.push(
          this._ti(interaction, 'ms_setting_change', {
            label: this._ti(interaction, `field_${setting.ini.toLowerCase()}`),
            old: oldValue || '?',
            new: newValue,
          }),
        );
        cached[setting.ini] = newValue;
      }
    }

    if (changes.length === 0) {
      await sftp.end().catch(() => {});
      await interaction.editReply(this._ti(interaction, 'ms_no_changes'));
      return true;
    }

    await sftp.put(Buffer.from(content, 'utf8'), settingsPath);
    await sftp.end().catch(() => {});

    if (this._db)
      try {
        this._db.setStateJSON(`server_settings_${serverId}`, cached);
      } catch (_) {}

    let msg = this._ti(interaction, 'ms_ok_game_settings_updated', {
      name: serverDef.name,
      category: this._ti(interaction, `game_cat_${category.id}`),
      changes: changes.join('\n'),
    });
    msg += this._ti(interaction, 'ms_warn_restart_game_server');

    await interaction.editReply(msg);
  } catch (err) {
    await interaction.editReply(this._ti(interaction, 'ms_err_save_failed', { message: err.message }));
  }
  return true;
}

// ═════════════════════════════════════════════════════════════
// Per-server welcome & auto-message modals
// ═════════════════════════════════════════════════════════════

async function _handleSrvWelcomeModal(interaction) {
  if (!(await this._requireAdmin(interaction, this._ti(interaction, 'ms_action_manage_servers')))) return true;

  const serverId = interaction.customId.replace('panel_srv_welcome_modal:', '');

  const servers = this.multiServerManager?.getAllServers() || [];
  const serverDef = servers.find((s) => s.id === serverId);
  if (!serverDef) {
    await interaction.reply({
      content: this._ti(interaction, 'ms_err_server_not_found'),
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  const sftpCfg = this._getSrvSftpConfig(serverDef);
  if (!sftpCfg) {
    await interaction.reply({
      content: this._ti(interaction, 'ms_err_no_sftp_short'),
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const newContent = interaction.fields.getTextInputValue('welcome_content');
    const sftp = new SftpClient();
    const { settingsPath: _s, welcomePath, ...connectOpts } = sftpCfg;
    await sftp.connect(connectOpts);
    await sftp.put(Buffer.from(newContent, 'utf8'), welcomePath);
    await sftp.end().catch(() => {});

    await interaction.editReply(
      this._ti(interaction, 'ms_ok_welcome_updated', { name: serverDef.name, length: newContent.length }),
    );
  } catch (err) {
    await interaction.editReply(this._ti(interaction, 'ms_err_save_welcome_failed', { message: err.message }));
  }
  return true;
}

async function _handleSrvAutoMsgModal(interaction) {
  if (!(await this._requireAdmin(interaction, this._ti(interaction, 'ms_action_manage_servers')))) return true;

  const serverId = interaction.customId.replace('panel_srv_automsg_modal:', '');

  const servers = this.multiServerManager?.getAllServers() || [];
  const idx = servers.findIndex((s) => s.id === serverId);
  if (idx === -1) {
    await interaction.reply({
      content: this._ti(interaction, 'ms_err_server_not_found'),
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const togglesRaw = interaction.fields.getTextInputValue('toggles').trim();
    const linkText = interaction.fields.getTextInputValue('link_text').trim();
    const promoText = interaction.fields.getTextInputValue('promo_text').trim();
    const discordLink = interaction.fields.getTextInputValue('discord_link').trim();

    // Parse toggles: "1,1,0,1" → [true, true, false, true]
    const bits = togglesRaw.split(',').map((s) => s.trim() === '1');
    const am = {
      enableWelcomeMsg: bits[0] ?? true,
      enableWelcomeFile: bits[1] ?? true,
      enableAutoMsgLink: bits[2] ?? true,
      enableAutoMsgPromo: bits[3] ?? true,
    };
    if (linkText) am.linkText = linkText;
    if (promoText) am.promoText = promoText;
    if (discordLink) am.discordLink = discordLink;

    // Persist to DB via configRepo
    if (this._configRepo) {
      this._configRepo.update('server:' + serverId, { autoMessages: am });
    } else {
      // Legacy fallback: write to servers.json
      const { loadServers, saveServers } = require('../server/multi-server');
      const allServers = loadServers();
      const srvIdx = allServers.findIndex((s) => s.id === serverId);
      if (srvIdx !== -1) {
        allServers[srvIdx].autoMessages = am;
        saveServers(allServers);
      }
    }

    // Hot-update the running instance's config
    const instance = this.multiServerManager.getInstance(serverId);
    if (instance) {
      instance.config.enableWelcomeMsg = am.enableWelcomeMsg;
      instance.config.enableWelcomeFile = am.enableWelcomeFile;
      instance.config.enableAutoMsgLink = am.enableAutoMsgLink;
      instance.config.enableAutoMsgPromo = am.enableAutoMsgPromo;
      instance.config.autoMsgLinkText = am.linkText || '';
      instance.config.autoMsgPromoText = am.promoText || '';
      if (am.discordLink) instance.config.discordInviteLink = am.discordLink;
    }

    // Build summary
    const labels = [
      this._ti(interaction, 'ms_automsg_rcon_welcome'),
      this._ti(interaction, 'ms_automsg_welcome_file'),
      this._ti(interaction, 'ms_automsg_link_broadcast'),
      this._ti(interaction, 'ms_automsg_promo_broadcast'),
    ];
    const summary = labels.map((l, i) => `${bits[i] ? '✅' : '❌'} ${l}`).join('\n');
    const extras = [];
    if (linkText)
      extras.push(
        this._ti(interaction, 'ms_automsg_link_text', {
          value: linkText.slice(0, 60) + (linkText.length > 60 ? '...' : ''),
        }),
      );
    if (promoText)
      extras.push(
        this._ti(interaction, 'ms_automsg_promo_text', {
          value: promoText.slice(0, 60) + (promoText.length > 60 ? '...' : ''),
        }),
      );
    if (discordLink) extras.push(this._ti(interaction, 'ms_automsg_discord', { value: discordLink }));

    await interaction.editReply(
      this._ti(interaction, 'ms_ok_automsg_updated', { name: servers[idx].name, summary }) +
        (extras.length > 0 ? `\n${extras.join('\n')}` : '') +
        this._ti(interaction, 'ms_warn_restart_toggle'),
    );
  } catch (err) {
    await interaction.editReply(this._ti(interaction, 'ms_err_save_failed', { message: err.message }));
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

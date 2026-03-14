/**
 * Panel Channel  unified admin dashboard.
 *
 * Single message with stacked Components v2 containers showing bot,
 * primary server, and managed servers. A view selector switches which
 * controls are active. Admin-only channel. Requires PANEL_CHANNEL_ID.
 */

const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
  PermissionFlagsBits,
  MessageFlags,
} = require('discord.js');
const config = require('../config');
const { t, getLocale, fmtDate, fmtTime } = require('../i18n');
const panelApi = require('../server/panel-api');
const SftpClient = require('ssh2-sftp-client');
const { formatBytes, formatUptime } = require('../server/server-resources');
const { blockBar: _progressBar } = require('../server/server-display');
const { BTN, SELECT, ENV_CATEGORIES, GAME_SETTINGS_CATEGORIES } = require('./panel-constants');
const { buildDiagnostics } = require('./panel-diagnostics');
const { cleanOwnMessages } = require('./discord-utils');

//  State colour map 
const STATE_DISPLAY = {
  running:  { emoji: '🟢', key: 'running',  color: 0x2ecc71 },
  starting: { emoji: '🟡', key: 'starting', color: 0xf1c40f },
  stopping: { emoji: '🟠', key: 'stopping', color: 0xe67e22 },
  offline:  { emoji: '🔴', key: 'offline',  color: 0xe74c3c },
};

function _stateInfo(state, locale = 'en') {
  const info = STATE_DISPLAY[state] || { emoji: '⚪', key: 'unknown', color: 0x95a5a6 };
  return {
    emoji: info.emoji,
    label: t(`discord:panel_channel.state.${info.key}`, locale),
    color: info.color,
  };
}

//  .env file helpers (shared via panel-env.js) 
const {
  getEnvValue: _getEnvValue,
  writeEnvValues: _writeEnvValues,
  applyLiveConfig: _applyLiveConfig,
  getCachedSettings: _getCachedSettings,
} = require('./panel-env');

/** Format milliseconds as "2d 5h 12m" */
function _formatBotUptime(ms) {
  const s = Math.floor(ms / 1000);
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0 || days > 0) parts.push(`${hours}h`);
  parts.push(`${mins}m`);
  return parts.join(' ');
}

/**
 * Discord modal titles are limited to 45 chars.
 * Trim defensively so category labels can never crash interaction handlers.
 */
function _modalTitle(title, max = 45) {
  const text = String(title ?? '');
  if (text.length <= max) return text;
  const suffix = '...';
  const keep = Math.max(1, max - suffix.length);
  let base = text.slice(0, keep);
  // Avoid leaving a dangling high surrogate at the end.
  const last = base.charCodeAt(base.length - 1);
  if (last >= 0xD800 && last <= 0xDBFF) base = base.slice(0, -1);
  return `${base}${suffix}`;
}

// Components v2 helpers
const COMPONENTS_V2_FLAG = MessageFlags.IsComponentsV2 ?? (1 << 15);
const MAX_V2_COMPONENTS = 40;
const V2 = {
  ACTION_ROW: 1,
  TEXT_DISPLAY: 10,
  CONTAINER: 17,
};

function _toComponentJSON(component) {
  return typeof component?.toJSON === 'function' ? component.toJSON() : component;
}

function _textDisplay(content) {
  return { type: V2.TEXT_DISPLAY, content: String(content ?? '') };
}

function _container(textBlocks = [], rows = [], accentColor = null) {
  const components = [];
  for (const block of textBlocks) {
    if (!block) continue;
    components.push(_textDisplay(block));
  }
  for (const row of rows) {
    if (!row) continue;
    components.push(_toComponentJSON(row));
  }
  const c = { type: V2.CONTAINER, components };
  if (accentColor != null) c.accent_color = accentColor;
  return c;
}

function _componentsKey(components = []) {
  return JSON.stringify(components.map(c => _toComponentJSON(c)));
}

function _countComponents(components = []) {
  let total = 0;
  const stack = [...components];
  while (stack.length > 0) {
    const next = stack.pop();
    if (!next || typeof next !== 'object') continue;
    total += 1;
    if (Array.isArray(next.components)) {
      for (const child of next.components) stack.push(child);
    }
    if (next.accessory && typeof next.accessory === 'object') {
      stack.push(next.accessory);
    }
  }
  return total;
}

function _errorSummary(err) {
  const parts = [];
  if (err?.message) parts.push(err.message);
  if (err?.code) parts.push(`code=${err.code}`);
  const rawMessage = err?.rawError?.message;
  if (rawMessage) parts.push(`api=${rawMessage}`);
  if (err?.rawError?.errors) {
    try { parts.push(JSON.stringify(err.rawError.errors)); } catch {}
  }
  return parts.join(' | ');
}

function _diagnosticToMarkdown(diagnosticLike, emptyText = '', sectionLabel = '—') {
  const raw = typeof diagnosticLike?.toJSON === 'function'
    ? diagnosticLike.toJSON()
    : (diagnosticLike?.data || diagnosticLike || {});

  const parts = [];
  if (raw.title) parts.push(`## ${raw.title}`);
  if (raw.description) parts.push(raw.description);
  if (Array.isArray(raw.fields)) {
    for (const f of raw.fields) {
      if (!f) continue;
      const name = f.name || sectionLabel;
      const value = f.value || '-';
      parts.push(`### ${name}\n${value}`);
    }
  }
  if (raw.footer?.text) parts.push(`-# ${raw.footer.text}`);
  const text = parts.join('\n\n').trim();
  if (!text) return emptyText;
  return text.length > 3900 ? `${text.slice(0, 3897)}...` : text;
}

// 
// PanelChannel class
// 

class PanelChannel {

  /**
   * @param {import('discord.js').Client} client
   * @param {object} opts
   * @param {object} opts.moduleStatus - reference to the moduleStatus object from index.js
   * @param {Date}   opts.startedAt    - bot startup timestamp
   */
  constructor(client, { moduleStatus = {}, startedAt = new Date(), multiServerManager = null, db = null, saveService = null, logWatcher = null } = {}) {
    this.client = client;
    this.channel = null;
    this.panelMessage = null;  // single unified panel message
    this.botMessage = null;    // alias kept for interaction handler compat (points to panelMessage)
    this._serverMessages = new Map(); // serverId  Discord message (kept for compat, unused in unified mode)
    this._lastServerKeys = new Map(); // serverId  content hash
    this.interval = null;
    this.updateIntervalMs = parseInt(config.serverStatusInterval, 10) || 30000;
    this._lastBotKey = null;
    this._lastPanelKey = null;
    this._lastState = null;
    this._backupLimit = null;
    this._activeView = 'bot'; // 'bot' | 'server' | serverId
    this.moduleStatus = moduleStatus;
    this.startedAt = startedAt;
    this.multiServerManager = multiServerManager;
    this._db = db;
    this._saveService = saveService;
    this._logWatcher = logWatcher;
    this._pendingServers = new Map(); // userId  { ...partial server config, _createdAt }
    // Setup wizard state (when config.needsSetup is true)
    this._setupWizard = null; // { profile, rcon: {host,port,password}, sftp: {host,port,user,password}, channels: {...}, step }
    // Clean up stale pending entries every 5 minutes
    this._pendingCleanupTimer = setInterval(() => {
      const cutoff = Date.now() - 10 * 60 * 1000; // 10-min TTL
      for (const [uid, data] of this._pendingServers) {
        if ((data._createdAt || 0) < cutoff) this._pendingServers.delete(uid);
      }
    }, 5 * 60 * 1000);
  }

  /** Whether SFTP credentials are configured (needed for game settings editor). */
  get _hasSftp() {
    return !!(config.ftpHost && config.ftpUser && (config.ftpPassword || config.ftpPrivateKeyPath));
  }

  /**
   * Check admin permission (synchronous). Returns true if admin, false if not.
   * Caller must handle defer/reply themselves.
   * Usage: `if (!this._isAdmin(interaction)) { await interaction.editReply(' Admin only'); return; }`
   */
  _isAdmin(interaction) {
    return interaction.member?.permissions?.has(PermissionFlagsBits.Administrator) || false;
  }

  _sharedLocale() {
    return getLocale({ locale: config.botLocale });
  }

  _interactionLocale(interaction) {
    return getLocale({
      locale: interaction?.locale,
      serverConfig: { locale: config.botLocale },
    });
  }

  _tp(key, vars = {}, locale = this._sharedLocale()) {
    return t(`discord:panel_channel.${key}`, locale, vars);
  }

  _ti(interaction, key, vars = {}) {
    return this._tp(key, vars, this._interactionLocale(interaction));
  }

  /**
   * @deprecated Use _isAdmin() + manual editReply instead. This causes interaction timeout issues.
   * Check admin permission. Returns true if admin, false (with ephemeral reply) if not.
   * Usage: `if (!await this._requireAdmin(interaction, 'edit config')) return true;`
   */
  async _requireAdmin(interaction, action) {
    if (!interaction.member?.permissions?.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({
        content: this._ti(interaction, 'err_only_admin', { action }),
        flags: MessageFlags.Ephemeral,
      });
      return false;
    }
    return true;
  }

  async start() {
    console.log('[PANEL CH] Module starting...');

    if (!config.panelChannelId) {
      console.log('[PANEL CH] No PANEL_CHANNEL_ID set, skipping.');
      return;
    }

    try {
      this.channel = await this.client.channels.fetch(config.panelChannelId);
      if (!this.channel) {
        console.error('[PANEL CH] Channel not found! Check PANEL_CHANNEL_ID.');
        return;
      }

      //  Setup wizard mode 
      if (config.needsSetup) {
        console.log('[PANEL CH] RCON not configured - launching setup wizard');
        await this._cleanOwnMessages();
        await this._startSetupWizard();
        return;
      }

      const features = [];
      features.push('bot controls');
      features.push('env editor');
      if (this._hasSftp && config.enableGameSettingsEditor) features.push('game settings (SFTP)');
      if (panelApi.available) features.push('server panel (API)');
      if (this.multiServerManager) {
        const count = this.multiServerManager.getAllServers().length;
        if (count > 0) features.push(`${count} managed server(s)`);
      }
      console.log(`[PANEL CH] Posting unified panel in #${this.channel.name} - ${features.join(', ')} (every ${this.updateIntervalMs / 1000}s)`);
      await this._cleanOwnMessages();
      await this._cleanStalePanelMessages();

      //  Single unified message with Components v2 containers 
      const { components } = await this._buildUnifiedPanel();
      const locale = this._sharedLocale();
      try {
        this.panelMessage = await this.channel.send({ flags: COMPONENTS_V2_FLAG, components });
      } catch (sendErr) {
        console.error('[PANEL CH] Initial publish failed:', _errorSummary(sendErr));
        // Minimal fallback so the panel is always visible after restart.
        this.panelMessage = await this.channel.send({
          flags: COMPONENTS_V2_FLAG,
          components: [_container([this._tp('panel_layout_rejected_initial', {}, locale)], [], 0xe67e22)],
        });
      }
      this.botMessage = this.panelMessage; // alias for interaction handler compat
      await this._cleanStalePanelMessages(this.panelMessage.id);

      // Persist message ID
      this._saveMessageIds();

      // First real update
      await this._update(true);

      // Refresh loop
      this.interval = setInterval(() => this._update(), this.updateIntervalMs);
    } catch (err) {
      console.error('[PANEL CH] Failed to start:', _errorSummary(err));
    }
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    if (this._pendingCleanupTimer) {
      clearInterval(this._pendingCleanupTimer);
      this._pendingCleanupTimer = null;
    }
  }
  // 
  // Interaction router
  // 

  async handleInteraction(interaction) {
    //  Setup wizard interactions 
    if (this._setupWizard !== null) {
      return this._handleSetupInteraction(interaction);
    }

    //  Buttons 
    if (interaction.isButton()) {
      const id = interaction.customId;
      if ([BTN.START, BTN.STOP, BTN.RESTART, BTN.BACKUP, BTN.KILL].includes(id)) {
        return this._handlePowerButton(interaction, id);
      }
      if (id === BTN.BOT_RESTART) {
        return this._handleBotRestart(interaction);
      }
      if (id === BTN.NUKE) {
        return this._handleNukeButton(interaction);
      }
      if (id === BTN.REIMPORT) {
        return this._handleReimportButton(interaction);
      }
      if (id === BTN.DIAGNOSTICS) {
        return this._handleDiagnosticsButton(interaction);
      }
      if (id === BTN.ENV_SYNC) {
        return this._handleEnvSyncButton(interaction);
      }
      if (id === BTN.WELCOME_EDIT) {
        return this._handleWelcomeEditButton(interaction);
      }
      if (id === 'panel_welcome_open_modal') {
        return this._handleWelcomeOpenModal(interaction);
      }
      if (id === BTN.BROADCASTS) {
        return this._handleBroadcastsButton(interaction);
      }
      if (id === 'panel_broadcasts_open_modal') {
        return this._handleBroadcastsOpenModal(interaction);
      }
      if (id === BTN.ADD_SERVER) {
        return this._handleAddServerButton(interaction);
      }
      if (id.startsWith('panel_srv_')) {
        return this._handleServerAction(interaction, id);
      }
      if (id.startsWith('panel_add_sftp:')) {
        return this._handleAddSftpButton(interaction, id);
      }
      if (id.startsWith('panel_add_step2:')) {
        return this._handleAddServerStep2Button(interaction, id);
      }
      return false;
    }

    //  Select menus 
    if (interaction.isStringSelectMenu()) {
      if (interaction.customId === SELECT.VIEW) {
        return this._handleViewSelect(interaction);
      }
      if (interaction.customId === SELECT.ACTIONS_BOT) {
        return this._handleBotActionsSelect(interaction);
      }
      if (interaction.customId === SELECT.ACTIONS_SERVER) {
        return this._handleServerActionsSelect(interaction);
      }
      if (interaction.customId === SELECT.ACTIONS_MANAGED) {
        return this._handleManagedActionsSelect(interaction);
      }
      if (interaction.customId === SELECT.ENV || interaction.customId === SELECT.ENV2) {
        return this._handleEnvSelect(interaction);
      }
      if (interaction.customId === SELECT.SETTINGS) {
        return this._handleGameSettingsSelect(interaction);
      }
      if (interaction.customId.startsWith('panel_srv_settings:')) {
        return this._handleSrvGameSettingsSelect(interaction);
      }
      return false;
    }

    //  Modals 
    if (interaction.isModalSubmit()) {
      if (interaction.customId.startsWith('panel_env_modal:')) {
        return this._handleEnvModal(interaction);
      }
      if (interaction.customId === 'panel_nuke_confirm') {
        return this._handleNukeConfirmModal(interaction);
      }
      if (interaction.customId.startsWith('panel_game_modal:')) {
        return this._handleGameSettingsModal(interaction);
      }
      if (interaction.customId === 'panel_welcome_modal') {
        return this._handleWelcomeModal(interaction);
      }
      if (interaction.customId === 'panel_broadcasts_modal') {
        return this._handleBroadcastsModal(interaction);
      }
      if (interaction.customId === 'panel_add_modal_step1') {
        return this._handleAddServerStep1Modal(interaction);
      }
      if (interaction.customId.startsWith('panel_add_modal_step2:')) {
        return this._handleAddServerStep2Modal(interaction);
      }
      if (interaction.customId.startsWith('panel_add_sftp_modal:')) {
        return this._handleAddSftpModal(interaction);
      }
      if (interaction.customId.startsWith('panel_srv_edit_modal:')) {
        return this._handleEditServerModal(interaction);
      }
      if (interaction.customId.startsWith('panel_srv_channels_modal:')) {
        return this._handleEditChannelsModal(interaction);
      }
      if (interaction.customId.startsWith('panel_srv_sftp_modal:')) {
        return this._handleEditSftpModal(interaction);
      }
      if (interaction.customId.startsWith('panel_srv_game_modal:')) {
        return this._handleSrvGameSettingsModal(interaction);
      }
      if (interaction.customId.startsWith('panel_srv_welcome_modal:')) {
        return this._handleSrvWelcomeModal(interaction);
      }
      if (interaction.customId.startsWith('panel_srv_automsg_modal:')) {
        return this._handleSrvAutoMsgModal(interaction);
      }
      return false;
    }

    return false;
  }

  async _handleBotActionsSelect(interaction) {
    const action = interaction.values?.[0];
    switch (action) {
      case 'diagnostics':
        return this._handleDiagnosticsButton(interaction);
      case 'env_sync':
        return this._handleEnvSyncButton(interaction);
      case 'add_server':
        return this._handleAddServerButton(interaction);
      case 'restart_bot':
        return this._handleBotRestart(interaction);
      case 'reimport':
        return this._handleReimportButton(interaction);
      case 'factory_reset':
        return this._handleNukeButton(interaction);
      default:
        await interaction.reply({
          content: this._ti(interaction, 'err_unknown_action'),
          flags: MessageFlags.Ephemeral,
        });
        return true;
    }
  }

  async _handleServerActionsSelect(interaction) {
    const action = interaction.values?.[0];
    switch (action) {
      case 'start':
        return this._handlePowerButton(interaction, BTN.START);
      case 'stop':
        return this._handlePowerButton(interaction, BTN.STOP);
      case 'restart':
        return this._handlePowerButton(interaction, BTN.RESTART);
      case 'backup':
        return this._handlePowerButton(interaction, BTN.BACKUP);
      case 'kill':
        return this._handlePowerButton(interaction, BTN.KILL);
      case 'welcome':
        return this._handleWelcomeEditButton(interaction);
      case 'broadcasts':
        return this._handleBroadcastsButton(interaction);
      default:
        await interaction.reply({
          content: this._ti(interaction, 'err_unknown_action'),
          flags: MessageFlags.Ephemeral,
        });
        return true;
    }
  }

  async _handleManagedActionsSelect(interaction) {
    const raw = interaction.values?.[0] || '';
    const sep = raw.indexOf(':');
    if (sep <= 0 || sep === raw.length - 1) {
      await interaction.reply({
        content: this._ti(interaction, 'err_invalid_action'),
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }
    const action = raw.slice(0, sep);
    const serverId = raw.slice(sep + 1);
    const allowed = new Set(['start', 'stop', 'restart', 'edit', 'remove', 'channels', 'sftp', 'welcome', 'automsg']);
    if (!allowed.has(action)) {
      await interaction.reply({
        content: this._ti(interaction, 'err_unknown_action'),
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }
    return this._handleServerAction(interaction, `panel_srv_${action}:${serverId}`);
  }

  // 
  // Button handlers
  // 

  async _handlePowerButton(interaction, id) {
    // Defer immediately to prevent token expiry
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    if (!this._isAdmin(interaction)) {
      await interaction.editReply(this._ti(interaction, 'err_only_admin_panel_controls'));
      return true;
    }

    if (!panelApi.available) {
      await interaction.editReply(this._ti(interaction, 'err_panel_api_not_configured'));
      return true;
    }

    try {
      switch (id) {
        case BTN.START:
          await panelApi.sendPowerAction('start');
          await interaction.editReply(this._ti(interaction, 'ok_start_sent'));
          break;
        case BTN.STOP:
          await panelApi.sendPowerAction('stop');
          await interaction.editReply(this._ti(interaction, 'ok_stop_sent'));
          break;
        case BTN.RESTART:
          await panelApi.sendPowerAction('restart');
          await interaction.editReply(this._ti(interaction, 'ok_restart_sent'));
          break;
        case BTN.KILL:
          await panelApi.sendPowerAction('kill');
          await interaction.editReply(this._ti(interaction, 'warn_kill_sent'));
          break;
        case BTN.BACKUP:
          await panelApi.createBackup();
          await interaction.editReply(this._ti(interaction, 'ok_backup_started'));
          break;
      }
      setTimeout(() => this._update(true), 3000);
    } catch (err) {
      await interaction.editReply(this._ti(interaction, 'err_action_failed', { message: err.message }));
    }

    return true;
  }

  async _handleBotRestart(interaction) {
    if (!await this._requireAdmin(interaction, this._ti(interaction, 'action_restart_bot'))) return true;

    await interaction.reply({
      content: this._ti(interaction, 'restart_notice'),
      flags: MessageFlags.Ephemeral,
    });

    // Let Discord deliver the reply before exiting
    setTimeout(() => process.exit(0), 1500);
    return true;
  }

  async _handleNukeButton(interaction) {
    if (!await this._requireAdmin(interaction, this._ti(interaction, 'action_factory_reset_bot'))) return true;

    // Confirmation modal  user must type "NUKE" to proceed
    const modal = new ModalBuilder()
      .setCustomId('panel_nuke_confirm')
      .setTitle(this._ti(interaction, 'factory_reset_confirm_title'));

    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('confirm')
          .setLabel(this._ti(interaction, 'factory_reset_confirm_label'))
          .setStyle(TextInputStyle.Short)
          .setPlaceholder(this._ti(interaction, 'factory_reset_confirm_placeholder'))
          .setRequired(true)
          .setMinLength(4)
          .setMaxLength(4)
      )
    );

    await interaction.showModal(modal);
    return true;
  }

  async _handleNukeConfirmModal(interaction) {
    if (!await this._requireAdmin(interaction, this._ti(interaction, 'action_factory_reset_bot'))) return true;

    const confirm = interaction.fields.getTextInputValue('confirm').trim().toUpperCase();
    if (confirm !== 'NUKE') {
      await interaction.reply({
        content: this._ti(interaction, 'factory_reset_cancelled'),
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    // Set NUKE_BOT=true in .env and restart
    _writeEnvValues({ NUKE_BOT: 'true' });
    await interaction.reply({
      content: `${this._ti(interaction, 'nuke_started')}\n\n${this._ti(interaction, 'nuke_timing_notice')}`,
      flags: MessageFlags.Ephemeral,
    });

    setTimeout(() => process.exit(0), 1500);
    return true;
  }

  async _handleReimportButton(interaction) {
    if (!await this._requireAdmin(interaction, this._ti(interaction, 'action_reimport_data'))) return true;

    // Set FIRST_RUN=true and restart  re-downloads logs and rebuilds stats
    _writeEnvValues({ FIRST_RUN: 'true' });
    await interaction.reply({
      content: `${this._ti(interaction, 'reimport_started')}\n\n${this._ti(interaction, 'reimport_preserves_messages')}`,
      flags: MessageFlags.Ephemeral,
    });

    setTimeout(() => process.exit(0), 1500);
    return true;
  }

  // 
  // Diagnostics  delegates to panel-diagnostics.js
  // 

  async _handleDiagnosticsButton(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    if (!this._isAdmin(interaction)) {
      await interaction.editReply({
        flags: COMPONENTS_V2_FLAG,
        content: null,
        embeds: [],
        components: [_container([this._ti(interaction, 'err_only_admin_view_diagnostics')], [], 0xe74c3c)],
      });
      return true;
    }

    const diagnosticData = await buildDiagnostics({
      client: this.client,
      db: this._db,
      saveService: this._saveService,
      logWatcher: this._logWatcher,
      moduleStatus: this.moduleStatus,
      startedAt: this.startedAt,
      hasSftp: this._hasSftp,
    });

    const noDetails = this._ti(interaction, 'no_diagnostic_details');
    const sectionLabel = this._ti(interaction, 'diagnostic_section_fallback');
    const components = (diagnosticData || []).map(e => _container([_diagnosticToMarkdown(e, noDetails, sectionLabel)], [], 0x5865f2));
    if (components.length === 0) {
      components.push(_container([noDetails], [], 0x5865f2));
    }

    await interaction.editReply({
      flags: COMPONENTS_V2_FLAG,
      content: null,
      embeds: [],
      components,
    });
    return true;
  }


  // 
  // View selector handler
  // 

  async _handleViewSelect(interaction) {
    const selected = interaction.values[0];
    // Map 'srv_xxx'  'xxx' for managed server views
    this._activeView = selected.startsWith('srv_') ? selected.slice(4) : selected;
    // Rebuild panel with new view and update the message
    try {
      await interaction.deferUpdate();
      await this._update(true);
    } catch (err) {
      console.error('[PANEL CH] View switch error:', err.message);
    }
    return true;
  }

  // 
  // Select menu  modal handlers
  // 

  async _handleEnvSelect(interaction) {
    if (!await this._requireAdmin(interaction, this._ti(interaction, 'action_edit_bot_config'))) return true;

    const categoryId = interaction.values[0];
    const category = ENV_CATEGORIES.find(c => c.id === categoryId);
    if (!category) {
      await interaction.reply({
        content: this._ti(interaction, 'err_unknown_category'),
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    const restartTag = category.restart
      ? this._ti(interaction, 'modal_restart_tag_bot')
      : this._ti(interaction, 'modal_restart_tag_live');
    const modal = new ModalBuilder()
      .setCustomId(`panel_env_modal:${categoryId}`)
      .setTitle(_modalTitle(this._ti(interaction, 'modal_edit_category_title', { category: category.label, mode: restartTag })));

    for (const field of category.fields) {
      const style = field.style === 'paragraph' ? TextInputStyle.Paragraph : TextInputStyle.Short;
      const input = new TextInputBuilder()
        .setCustomId(field.env)
        .setLabel(field.label)
        .setStyle(style)
        .setRequired(false);

      if (field.sensitive) {
        const current = _getEnvValue(field);
        input.setPlaceholder(current
          ? this._ti(interaction, 'modal_sensitive_placeholder_keep_current')
          : this._ti(interaction, 'modal_sensitive_placeholder_enter_value'));
        input.setValue('');
      } else {
        input.setValue(_getEnvValue(field));
      }

      modal.addComponents(new ActionRowBuilder().addComponents(input));
    }

    await interaction.showModal(modal);
    return true;
  }

  async _handleGameSettingsSelect(interaction) {
    if (!await this._requireAdmin(interaction, this._ti(interaction, 'action_edit_server_settings'))) return true;

    if (!this._hasSftp) {
      await interaction.reply({
        content: this._ti(interaction, 'err_sftp_credentials_settings'),
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    const categoryId = interaction.values[0];
    const category = GAME_SETTINGS_CATEGORIES.find(c => c.id === categoryId);
    if (!category) {
      await interaction.reply({
        content: this._ti(interaction, 'err_unknown_category'),
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    const cached = _getCachedSettings(this._db);

    const modal = new ModalBuilder()
      .setCustomId(`panel_game_modal:${categoryId}`)
      .setTitle(_modalTitle(this._ti(interaction, 'modal_server_settings_title', { category: category.label, mode: this._ti(interaction, 'modal_restart_tag_server') })));

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

  // 
  // Modal submit handlers
  // 

  async _handleEnvModal(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    
    if (!this._isAdmin(interaction)) {
      await interaction.editReply(this._ti(interaction, 'err_only_admin_edit_bot_config'));
      return true;
    }

    const categoryId = interaction.customId.replace('panel_env_modal:', '');
    const category = ENV_CATEGORIES.find(c => c.id === categoryId);
    if (!category) {
      await interaction.editReply(this._ti(interaction, 'err_unknown_category'));
      return true;
    }

    try {
      const updates = {};
      const dbUpdates = {};
      const changes = [];

      for (const field of category.fields) {
        const newValue = interaction.fields.getTextInputValue(field.env);

        // Skip empty sensitive fields  keep current value unchanged
        if (field.sensitive && newValue === '') continue;

        const oldValue = _getEnvValue(field);

        if (newValue !== oldValue) {
          const emptyMarker = this._ti(interaction, 'value_empty_marker');
          const displayOld = field.sensitive ? '' : (oldValue || emptyMarker);
          const displayNew = field.sensitive ? '' : (newValue || emptyMarker);
          changes.push(`**${field.label}:** \`${displayOld}\`  \`${displayNew}\``);

          if (!category.restart) {
            // Live-apply display settings  save to DB, not .env
            _applyLiveConfig(field, newValue);
            if (field.cfg) dbUpdates[field.cfg] = config[field.cfg];
          } else {
            // Restart-required settings  write to .env
            updates[field.env] = newValue;
          }
        }
      }

      if (changes.length === 0) {
        await interaction.editReply(this._ti(interaction, 'info_no_changes_detected'));
        return true;
      }

      // Persist restart-required changes to .env
      if (Object.keys(updates).length > 0) {
        _writeEnvValues(updates);
      }
      // Persist display settings to DB
      if (Object.keys(dbUpdates).length > 0) {
        config.saveDisplaySettings(this._db, dbUpdates);
      }

      let msg = this._ti(interaction, 'ok_category_updated', {
        category: category.label,
        changes: changes.join('\n'),
      });
      if (category.restart) {
        msg += `\n\n${this._ti(interaction, 'warn_restart_bot_required')}`;
      } else {
        msg += `\n\n${this._ti(interaction, 'info_changes_applied_immediately')}`;
      }

      await interaction.editReply(msg);

      // Refresh panel containers to show changes
      if (!category.restart) {
        setTimeout(() => this._update(true), 1000);
      }
    } catch (err) {
      await interaction.editReply(this._ti(interaction, 'err_failed_to_save', { message: err.message }));
    }

    return true;
  }

  async _handleGameSettingsModal(interaction) {
    if (!await this._requireAdmin(interaction, this._ti(interaction, 'action_edit_server_settings'))) return true;

    if (!this._hasSftp) {
      await interaction.reply({
        content: this._ti(interaction, 'err_sftp_credentials_not_configured'),
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    const categoryId = interaction.customId.replace('panel_game_modal:', '');
    const category = GAME_SETTINGS_CATEGORIES.find(c => c.id === categoryId);
    if (!category) {
      await interaction.reply({
        content: this._ti(interaction, 'err_unknown_category'),
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      // Read fresh INI content via SFTP (panel file API is blocked on some hosts)
      const settingsPath = config.ftpSettingsPath;
      const sftp = new SftpClient();
      await sftp.connect({
        host: config.ftpHost,
        port: config.ftpPort,
        username: config.ftpUser,
        password: config.ftpPassword,
      });

      let content;
      try {
        content = (await sftp.get(settingsPath)).toString('utf8');
      } catch (readErr) {
        await sftp.end().catch(() => {});
        throw new Error(this._ti(interaction, 'err_could_not_read_settings_file', { message: readErr.message }));
      }

      const changes = [];
      const cached = _getCachedSettings(this._db);

      for (const setting of category.settings) {
        const newValue = interaction.fields.getTextInputValue(setting.ini).trim();
        const oldValue = cached[setting.ini] != null ? String(cached[setting.ini]) : '';

        if (newValue !== oldValue) {
          // Regex-replace in raw INI text to preserve comments/formatting
          const regex = new RegExp(`^(${setting.ini}\\s*=\\s*).*$`, 'm');
          if (regex.test(content)) {
            content = content.replace(regex, `$1${newValue}`);
          }
          changes.push(`**${setting.label}:** \`${oldValue || this._ti(interaction, 'value_unknown_marker')}\`  \`${newValue}\``);
          cached[setting.ini] = newValue;
        }
      }

      if (changes.length === 0) {
        await sftp.end().catch(() => {});
        await interaction.editReply(this._ti(interaction, 'info_no_changes_detected'));
        return true;
      }

      // Write modified INI back via SFTP
      await sftp.put(Buffer.from(content, 'utf8'), settingsPath);
      await sftp.end().catch(() => {});

      // Update local cache so subsequent reads are fresh
      if (this._db) try { this._db.setStateJSON('server_settings', cached); } catch (_) {}

      let msg = this._ti(interaction, 'ok_category_updated', {
        category: category.label,
        changes: changes.join('\n'),
      });
      msg += `\n\n${this._ti(interaction, 'warn_restart_server_required')}`;

      await interaction.editReply(msg);
    } catch (err) {
      await interaction.editReply(this._ti(interaction, 'err_failed_to_save', { message: err.message }));
    }

    return true;
  }

  // 
  // .env synchronization
  // 

  async _handleEnvSyncButton(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    
    if (!this._isAdmin(interaction)) {
      await interaction.editReply(this._ti(interaction, 'err_only_admin_sync_env'));
      return true;
    }

    const { needsSync, syncEnv, getVersion, getExampleVersion } = require('../env-sync');

    if (!needsSync()) {
      await interaction.editReply(this._ti(interaction, 'ok_env_already_up_to_date'));
      return true;
    }

    try {
      const currentVer = getVersion();
      const targetVer = getExampleVersion();
      const result = syncEnv();

      const changes = [];
      if (result.added > 0) {
        changes.push(this._ti(interaction, 'env_sync_change_added', { count: result.added }));
      }
      if (result.deprecated > 0) {
        changes.push(this._ti(interaction, 'env_sync_change_deprecated', { count: result.deprecated }));
      }

      await interaction.editReply(
        `${this._ti(interaction, 'ok_env_synchronized')}\n\n` +
        `${this._ti(interaction, 'env_sync_schema_line', { currentVer, targetVer })}\n` +
        `${this._ti(interaction, 'env_sync_changes_line', { changes: changes.join(', ') || this._ti(interaction, 'env_sync_no_changes') })}\n\n` +
        `${this._ti(interaction, 'env_sync_backup_line')}\n\n` +
        `${this._ti(interaction, 'warn_restart_bot_apply_env')}`
      );

      // Refresh panel to update action menu state
      setTimeout(() => this._update(true), 2000);
    } catch (err) {
      await interaction.editReply(this._ti(interaction, 'err_failed_to_sync_env', { message: err.message }));
    }

    return true;
  }

  // 
  // Welcome message editor
  // 

  async _handleWelcomeEditButton(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    
    if (!this._isAdmin(interaction)) {
      await interaction.editReply(this._ti(interaction, 'err_only_admin_edit_welcome'));
      return true;
    }

    if (!this._hasSftp) {
      await interaction.editReply(this._ti(interaction, 'err_sftp_credentials_not_configured'));
      return true;
    }

    // Read current WelcomeMessage.txt from server
    let currentContent = '';
    try {
      const sftp = new SftpClient();
      await sftp.connect({
        host: config.ftpHost,
        port: config.ftpPort,
        username: config.ftpUser,
        password: config.ftpPassword,
      });
      currentContent = (await sftp.get(config.ftpWelcomePath)).toString('utf8');
      await sftp.end().catch(() => {});
    } catch {
      // File may not exist yet  that's fine, start with empty
      currentContent = '';
    }

    // Discord modals can't be shown after deferReply  use a message with a button instead
    const helpText = [
      this._ti(interaction, 'welcome_help_title'),
      '',
      this._ti(interaction, 'welcome_help_intro_1'),
      this._ti(interaction, 'welcome_help_intro_2'),
      '',
      this._ti(interaction, 'welcome_help_color_tags_title'),
      this._ti(interaction, 'welcome_help_color_tag_pn'),
      this._ti(interaction, 'welcome_help_color_tag_pr'),
      this._ti(interaction, 'welcome_help_color_tag_sp'),
      this._ti(interaction, 'welcome_help_color_tag_fo'),
      this._ti(interaction, 'welcome_help_color_tag_cl'),
      '',
      this._ti(interaction, 'welcome_help_placeholders_title'),
      this._ti(interaction, 'welcome_help_placeholder_server_name'),
      this._ti(interaction, 'welcome_help_placeholder_day'),
      this._ti(interaction, 'welcome_help_placeholder_season'),
      this._ti(interaction, 'welcome_help_placeholder_weather'),
      this._ti(interaction, 'welcome_help_placeholder_pvp_schedule'),
      this._ti(interaction, 'welcome_help_placeholder_discord_link'),
      '',
      this._ti(interaction, 'welcome_help_tip'),
      '',
      this._ti(interaction, 'welcome_help_current_length', { length: currentContent.length }),
    ].join('\n');

    // Store current content for the modal
    this._pendingWelcome = { userId: interaction.user.id, content: currentContent };

    const openBtn = new ButtonBuilder()
      .setCustomId('panel_welcome_open_modal')
      .setLabel(this._ti(interaction, 'button_open_editor'))
      .setStyle(ButtonStyle.Primary);

    await interaction.editReply({
      content: helpText,
      components: [new ActionRowBuilder().addComponents(openBtn)],
    });
    return true;
  }

  async _handleWelcomeOpenModal(interaction) {
    if (!await this._requireAdmin(interaction, this._ti(interaction, 'action_edit_welcome_message'))) return true;

    const pending = this._pendingWelcome;
    // Truncate to Discord's 4000-char modal value limit
    const currentValue = (pending?.content || '').slice(0, 4000);

    const modal = new ModalBuilder()
      .setCustomId('panel_welcome_modal')
      .setTitle(this._ti(interaction, 'welcome_modal_title'));

    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('welcome_content')
          .setLabel(this._ti(interaction, 'welcome_modal_content_label'))
          .setStyle(TextInputStyle.Paragraph)
          .setValue(currentValue)
          .setRequired(false)
          .setMaxLength(4000)
      ),
    );

    await interaction.showModal(modal);
    return true;
  }

  async _handleWelcomeModal(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    
    if (!this._isAdmin(interaction)) {
      await interaction.editReply(this._ti(interaction, 'err_only_admin_edit_welcome'));
      return true;
    }

    const newContent = interaction.fields.getTextInputValue('welcome_content');

    try {
      if (newContent.trim()) {
        // Write custom content directly via SFTP
        const sftp = new SftpClient();
        await sftp.connect({
          host: config.ftpHost,
          port: config.ftpPort,
          username: config.ftpUser,
          password: config.ftpPassword,
        });
        await sftp.put(Buffer.from(newContent, 'utf8'), config.ftpWelcomePath);
        await sftp.end().catch(() => {});

        // Also save as WELCOME_FILE_LINES in .env so it persists across restarts
        _writeEnvValues({ WELCOME_FILE_LINES: newContent.split('\n').join('|') });

        await interaction.editReply(
          this._ti(interaction, 'ok_welcome_updated', {
            length: newContent.length,
            details: this._ti(interaction, 'welcome_updated_details'),
            next: this._ti(interaction, 'welcome_updated_next_join'),
          })
        );
      } else {
        // Clear custom  revert to auto-generated
        _writeEnvValues({ WELCOME_FILE_LINES: '' });
        config.welcomeFileLines = [];

        // Regenerate and write default content
        const { buildWelcomeContent } = require('./auto-messages');
        const autoContent = await buildWelcomeContent();

        const sftp = new SftpClient();
        await sftp.connect({
          host: config.ftpHost,
          port: config.ftpPort,
          username: config.ftpUser,
          password: config.ftpPassword,
        });
        await sftp.put(Buffer.from(autoContent, 'utf8'), config.ftpWelcomePath);
        await sftp.end().catch(() => {});

        await interaction.editReply(
          this._ti(interaction, 'ok_welcome_reset')
        );
      }
    } catch (err) {
      await interaction.editReply(this._ti(interaction, 'err_failed_to_save', { message: err.message }));
    }

    return true;
  }

  // 
  // Broadcast messages editor
  // 

  async _handleBroadcastsButton(interaction) {
    if (!await this._requireAdmin(interaction, this._ti(interaction, 'action_edit_broadcasts'))) return true;

    const linkText = config.autoMsgLinkText || '';
    const promoText = config.autoMsgPromoText || '';

    const helpText = [
      this._ti(interaction, 'broadcast_help_title'),
      '',
      this._ti(interaction, 'broadcast_help_intro_1'),
      this._ti(interaction, 'broadcast_help_intro_2'),
      '',
      this._ti(interaction, 'broadcast_help_defaults_title'),
      this._ti(interaction, 'broadcast_help_default_link'),
      this._ti(interaction, 'broadcast_help_default_promo'),
      '',
      this._ti(interaction, 'broadcast_help_placeholders_title'),
      this._ti(interaction, 'broadcast_help_placeholder_server_name'),
      this._ti(interaction, 'broadcast_help_placeholder_day_season'),
      this._ti(interaction, 'broadcast_help_placeholder_weather_pvp'),
      this._ti(interaction, 'broadcast_help_placeholder_discord_link'),
      '',
      this._ti(interaction, 'broadcast_help_note_1'),
      this._ti(interaction, 'broadcast_help_note_2'),
      '',
      this._ti(interaction, 'broadcast_help_link_value', {
        value: linkText
          ? `\`${linkText.slice(0, 80)}${linkText.length > 80 ? '...' : ''}\``
          : this._ti(interaction, 'broadcast_default_marker'),
      }),
      this._ti(interaction, 'broadcast_help_promo_value', {
        value: promoText
          ? `\`${promoText.slice(0, 80)}${promoText.length > 80 ? '...' : ''}\``
          : this._ti(interaction, 'broadcast_default_marker'),
      }),
    ].join('\n');

    this._pendingBroadcasts = { userId: interaction.user.id, linkText, promoText };

    const openBtn = new ButtonBuilder()
      .setCustomId('panel_broadcasts_open_modal')
      .setLabel(this._ti(interaction, 'button_open_editor'))
      .setStyle(ButtonStyle.Primary);

    await interaction.reply({
      content: helpText,
      components: [new ActionRowBuilder().addComponents(openBtn)],
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  async _handleBroadcastsOpenModal(interaction) {
    if (!await this._requireAdmin(interaction, this._ti(interaction, 'action_edit_broadcasts'))) return true;

    const pending = this._pendingBroadcasts;
    const linkVal = (pending?.linkText || '').slice(0, 4000);
    const promoVal = (pending?.promoText || '').slice(0, 4000);

    const modal = new ModalBuilder()
      .setCustomId('panel_broadcasts_modal')
      .setTitle(this._ti(interaction, 'broadcast_modal_title'));

    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('link_text')
          .setLabel(this._ti(interaction, 'broadcast_modal_link_label'))
          .setStyle(TextInputStyle.Paragraph)
          .setValue(linkVal)
          .setRequired(false)
          .setMaxLength(4000)
          .setPlaceholder(this._ti(interaction, 'broadcast_modal_link_placeholder'))
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('promo_text')
          .setLabel(this._ti(interaction, 'broadcast_modal_promo_label'))
          .setStyle(TextInputStyle.Paragraph)
          .setValue(promoVal)
          .setRequired(false)
          .setMaxLength(4000)
          .setPlaceholder(this._ti(interaction, 'broadcast_modal_promo_placeholder'))
      ),
    );

    await interaction.showModal(modal);
    return true;
  }

  async _handleBroadcastsModal(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    
    if (!this._isAdmin(interaction)) {
      await interaction.editReply(this._ti(interaction, 'err_only_admin_edit_broadcasts'));
      return true;
    }

    const linkText = interaction.fields.getTextInputValue('link_text').trim();
    const promoText = interaction.fields.getTextInputValue('promo_text').trim();

    try {
      const updates = {};
      if (linkText !== (config.autoMsgLinkText || '')) {
        updates.AUTO_MSG_LINK_TEXT = linkText;
        config.autoMsgLinkText = linkText;
      }
      if (promoText !== (config.autoMsgPromoText || '')) {
        updates.AUTO_MSG_PROMO_TEXT = promoText;
        config.autoMsgPromoText = promoText;
      }

      if (Object.keys(updates).length > 0) {
        _writeEnvValues(updates);
        const parts = [];
        if ('AUTO_MSG_LINK_TEXT' in updates) {
          parts.push(this._ti(interaction, 'broadcast_value_link', {
            value: linkText || this._ti(interaction, 'broadcast_default_marker'),
          }));
        }
        if ('AUTO_MSG_PROMO_TEXT' in updates) {
          parts.push(this._ti(interaction, 'broadcast_value_promo', {
            value: promoText || this._ti(interaction, 'broadcast_default_marker'),
          }));
        }
        await interaction.editReply(
          this._ti(interaction, 'ok_broadcasts_updated', {
            changes: parts.join('\n'),
            restart: this._ti(interaction, 'warn_restart_bot_apply_broadcasts'),
          })
        );
      } else {
        await interaction.editReply(this._ti(interaction, 'info_no_changes_detected'));
      }
    } catch (err) {
      await interaction.editReply(this._ti(interaction, 'err_failed_to_save', { message: err.message }));
    }

    return true;
  }

  // 
  // Update loop
  // 

  async _cleanOwnMessages() {
    const ids = this._loadMessageIds();
    const savedIds = [ids.panelBot, ids.panelServer].filter(Boolean);
    if (ids.servers) {
      for (const msgId of Object.values(ids.servers)) {
        if (msgId) savedIds.push(msgId);
      }
    }
    await cleanOwnMessages(this.channel, this.client, { savedIds, label: 'PANEL CH' });
  }

  _isPanelMessage(message) {
    if (!message) return false;
    const controlIds = new Set([...Object.values(BTN), ...Object.values(SELECT)]);
    const locale = this._sharedLocale();
    const markers = [
      this._tp('marker_control_center', {}, locale),
      this._tp('marker_bot_controls', {}, locale),
      this._tp('marker_primary_server', {}, locale),
      this._tp('marker_primary_server_panel', {}, locale),
      this._tp('marker_managed_server', {}, locale),
      this._tp('marker_panel_api', {}, locale),
    ].map(v => String(v || '').toLowerCase());

    // Legacy embeds/content (non-components-v2) can still be old panel messages.
    const messageContent = String(message.content || '').toLowerCase();
    if (markers.some(m => messageContent.includes(m))) return true;
    if (Array.isArray(message.embeds) && message.embeds.length > 0) {
      for (const e of message.embeds) {
        const title = String(e?.title || '').toLowerCase();
        const desc = String(e?.description || '').toLowerCase();
        if (markers.some(m => title.includes(m) || desc.includes(m))) return true;
      }
    }

    if (!Array.isArray(message.components) || message.components.length === 0) return false;
    const stack = [...message.components];
    while (stack.length > 0) {
      const c = stack.pop();
      if (!c || typeof c !== 'object') continue;
      const customId = c.customId || c.custom_id;
      if (typeof customId === 'string' && (customId.startsWith('panel_') || controlIds.has(customId))) {
        return true;
      }
      const content = String(c.content || c.data?.content || '').toLowerCase();
      if (markers.some(m => content.includes(m))) {
        return true;
      }
      const children = c.components || c.data?.components;
      if (Array.isArray(children)) stack.push(...children);
      const accessory = c.accessory || c.data?.accessory;
      if (accessory && typeof accessory === 'object') stack.push(accessory);
    }
    return false;
  }

  async _cleanStalePanelMessages(keepId = null) {
    try {
      if (!this.channel || !this.client?.user) return;
      const messages = await this.channel.messages.fetch({ limit: 100 });
      const stale = messages.filter(m =>
        m.author?.id === this.client.user.id &&
        m.id !== keepId &&
        this._isPanelMessage(m)
      );
      for (const [, msg] of stale) {
        try { await msg.delete(); } catch {}
      }
      if (stale.size > 0) {
        console.log(`[PANEL CH] Removed ${stale.size} stale panel message(s)`);
      }
    } catch (err) {
      console.log('[PANEL CH] Stale cleanup skipped:', err.message);
    }
  }

  _loadMessageIds() {
    try {
      if (this._db) {
        return {
          panelBot: this._db.getState('msg_id_panel_bot') || null,
          panelServer: this._db.getState('msg_id_panel_server') || null,
          servers: this._db.getStateJSON('msg_id_panel_servers', {}),
        };
      }
    } catch {}
    return { panelBot: null, panelServer: null, servers: {} };
  }

  _saveMessageIds() {
    try {
      if (this._db && this.panelMessage) {
        this._db.setState('msg_id_panel_bot', this.panelMessage.id);
        // Unified panel mode: clear deprecated split-panel IDs.
        this._db.setState('msg_id_panel_server', '');
        this._db.setStateJSON('msg_id_panel_servers', {});
      }
    } catch {}
  }

  async _update(force = false) {
    try {
      if (!this.panelMessage) return;

      const { components } = await this._buildUnifiedPanel();
      const locale = this._sharedLocale();
      const contentKey = _componentsKey(components);

      if (force || contentKey !== this._lastBotKey) {
        this._lastBotKey = contentKey;
        try {
          await this.panelMessage.edit({ components });
        } catch (editErr) {
          if (editErr.code === 10008 || editErr.message?.includes('Unknown Message')) {
            console.log('[PANEL CH] Panel message deleted, re-creating...');
            try {
              this.panelMessage = await this.channel.send({ flags: COMPONENTS_V2_FLAG, components });
            } catch (sendErr) {
              console.error('[PANEL CH] Re-create failed:', _errorSummary(sendErr));
              this.panelMessage = await this.channel.send({
                flags: COMPONENTS_V2_FLAG,
                components: [_container([this._tp('panel_layout_rejected_update', {}, locale)], [], 0xe74c3c)],
              });
            }
            this.botMessage = this.panelMessage;
            this._saveMessageIds();
            await this._cleanStalePanelMessages(this.panelMessage.id);
          } else throw editErr;
        }
      }
    } catch (err) {
      console.error('[PANEL CH] Update error:', _errorSummary(err));
    }
  }

  /**
   * Build the unified panel as Components v2 containers.
   * Returns { components: object[] }
   */
  async _buildUnifiedPanel() {
    const components = [];
    const locale = this._sharedLocale();
    const view = this._activeView || 'bot';
    const managedServers = this.multiServerManager?.getAllServers() || [];

    // Build controls first and inject them directly into Bot Controls container.
    const controlRows = this._buildViewComponents(view, managedServers);

    //  Container 1: Bot overview (always) 
    components.push(this._buildBotContainer(controlRows, view));

    //  Container 2: Primary server 
    let resources = null, details = null, backups = null, schedules = null;
    if (panelApi.available) {
      try {
        [resources, details, backups, schedules] = await Promise.all([
          panelApi.getResources().catch(() => null),
          panelApi.getServerDetails().catch(() => ({})),
          panelApi.listBackups().catch(() => []),
          panelApi.listSchedules().catch(() => []),
        ]);
        const state = resources?.state || 'offline';
        this._lastState = state;
        this._backupLimit = details?.feature_limits?.backups ?? null;
        components.push(this._buildServerContainer(resources, details, backups, schedules));
      } catch {
        // Panel API failed  skip server container
      }
    }

    //  Containers 3+: Managed servers 
    let omittedManaged = 0;
    for (const serverDef of managedServers) {
      const instance = this.multiServerManager.getInstance(serverDef.id);
      const serverContainer = this._buildManagedServerContainer(serverDef, instance);
      const nextCount = _countComponents([...components, serverContainer]);
      if (nextCount > MAX_V2_COMPONENTS) {
        omittedManaged++;
        continue;
      }
      components.push(serverContainer);
    }

    if (omittedManaged > 0) {
      const omittedNotice = _container(
        [this._tp('managed_servers_omitted_notice', { count: omittedManaged, limit: MAX_V2_COMPONENTS }, locale)],
        [],
        0xe67e22
      );
      if (_countComponents([...components, omittedNotice]) <= MAX_V2_COMPONENTS) {
        components.push(omittedNotice);
      }
    }

    return { components };
  }

  /**
   * Build action rows for the currently selected view.
   * Row 1 is always the view selector. Rows 2-5 depend on the view.
   */
  _buildViewComponents(view, managedServers = []) {
    const locale = this._sharedLocale();
    const rows = [];

    //  Row 1: View selector 
    const viewOptions = [
      { label: this._tp('view_option_bot_controls', {}, locale), value: 'bot', default: view === 'bot' },
    ];
    if (panelApi.available) {
      viewOptions.push({ label: this._tp('view_option_primary_server', {}, locale), value: 'server', default: view === 'server' });
    } else if (this._hasSftp) {
      viewOptions.push({ label: this._tp('view_option_server_tools', {}, locale), value: 'server', default: view === 'server' });
    }
    for (const s of managedServers) {
      viewOptions.push({
        label: s.name || s.id,
        value: `srv_${s.id}`,
        default: view === s.id,
      });
    }
    // Only show view selector if there's more than one option
    if (viewOptions.length > 1) {
      const viewSelect = new StringSelectMenuBuilder()
        .setCustomId(SELECT.VIEW)
        .setPlaceholder(this._tp('placeholder_select_panel_view', {}, locale))
        .addOptions(viewOptions);
      rows.push(new ActionRowBuilder().addComponents(viewSelect));
    }

    //  Rows 2-5: View-specific controls 
    const maxRemaining = 5 - rows.length;
    let viewRows = [];

    if (view === 'bot') {
      viewRows = this._buildBotComponents();
    } else if (view === 'server') {
      if (panelApi.available) {
        viewRows = this._buildServerComponents(this._lastState || 'offline');
      } else if (this._hasSftp) {
        viewRows = this._buildSftpOnlyServerComponents();
      }
    } else {
      // Managed server view
      const serverDef = managedServers.find(s => s.id === view);
      if (serverDef) {
        const instance = this.multiServerManager?.getInstance(serverDef.id);
        viewRows = this._buildManagedServerComponents(serverDef.id, instance?.running || false);
      }
    }

    // Trim to fit within Discord's 5 row limit
    for (let i = 0; i < Math.min(viewRows.length, maxRemaining); i++) {
      rows.push(viewRows[i]);
    }

    return rows;
  }

  /**
   * Build components for SFTP-only server view (no panel API).
   */
  _buildSftpOnlyServerComponents() {
    const locale = this._sharedLocale();
    const rows = [];
    const actionOptions = [];
    if (config.enableWelcomeFile) {
      actionOptions.push({
        label: this._tp('option_welcome_message', {}, locale),
        description: this._tp('option_desc_edit_welcome_message', {}, locale),
        value: 'welcome',
      });
    }
    if (config.enableAutoMessages) {
      actionOptions.push({
        label: this._tp('option_broadcasts', {}, locale),
        description: this._tp('option_desc_edit_auto_broadcasts', {}, locale),
        value: 'broadcasts',
      });
    }
    if (actionOptions.length > 0) {
      const actionSelect = new StringSelectMenuBuilder()
        .setCustomId(SELECT.ACTIONS_SERVER)
        .setPlaceholder(this._tp('placeholder_server_actions', {}, locale))
        .addOptions(actionOptions);
      rows.push(new ActionRowBuilder().addComponents(actionSelect));
    }
    if (config.enableGameSettingsEditor) {
      const settingsSelect = new StringSelectMenuBuilder()
        .setCustomId(SELECT.SETTINGS)
        .setPlaceholder(this._tp('placeholder_edit_game_settings', {}, locale))
        .addOptions(
          GAME_SETTINGS_CATEGORIES.map(c => ({
            label: c.label,
            value: c.id,
          }))
        );
      rows.push(new ActionRowBuilder().addComponents(settingsSelect));
    }
    return rows;
  }

  // 
  // Container builders
  // 

  /**
   * Build control container for the currently selected view.
   */
  _buildControlsContainer(view, rows = []) {
    const locale = this._sharedLocale();
    const labels = {
      bot: this._tp('view_option_bot_controls', {}, locale),
      server: panelApi.available
        ? this._tp('view_option_primary_server', {}, locale)
        : this._tp('view_option_server_tools', {}, locale),
    };
    const viewLabel = labels[view] || this._tp('view_label_managed_server', { id: view }, locale);
    return _container(
      [
        this._tp('control_center_heading', {}, locale),
        this._tp('control_center_active_view_help', { viewLabel }, locale),
      ],
      rows,
      0x5865f2
    );
  }

  /**
   * Build container for a managed (additional) server.
   * @param {object} serverDef - Server definition from servers.json
   * @param {object|undefined} instance - Running ServerInstance (or undefined)
   */
  _buildManagedServerContainer(serverDef, instance) {
    const locale = this._sharedLocale();
    const running = instance?.running || false;
    const statusIcon = running
      ? this._tp('managed_status_run_tag', {}, locale)
      : this._tp('managed_status_off_tag', {}, locale);
    const statusText = running
      ? this._tp('state.running', {}, locale)
      : this._tp('managed_status_stopped', {}, locale);
    const onOff = (enabled) => enabled
      ? this._tp('toggle_on', {}, locale)
      : this._tp('toggle_off', {}, locale);

    const blocks = [
      this._tp('managed_server_heading', { name: serverDef.name || serverDef.id }, locale),
      [
        this._tp('managed_server_status_line', { icon: statusIcon, status: statusText }, locale),
        this._tp('managed_server_rcon_line', {
          host: serverDef.rcon?.host || '?',
          port: serverDef.rcon?.port || 14541,
        }, locale),
        this._tp('managed_server_game_port_line', { port: serverDef.gamePort || 14242 }, locale),
        serverDef.sftp?.host
          ? this._tp('managed_server_sftp_line', {
            host: serverDef.sftp.host,
            port: serverDef.sftp.port || 22,
          }, locale)
          : this._tp('managed_server_sftp_inherited', {}, locale),
        this._tp('managed_server_id_line', { id: serverDef.id }, locale),
      ].join('\n'),
    ];

    const ch = serverDef.channels || {};
    const channelLines = [];
    if (ch.serverStatus) channelLines.push(this._tp('managed_server_channel_status', { channelId: ch.serverStatus }, locale));
    if (ch.playerStats) channelLines.push(this._tp('managed_server_channel_stats', { channelId: ch.playerStats }, locale));
    if (ch.log) channelLines.push(this._tp('managed_server_channel_log', { channelId: ch.log }, locale));
    if (ch.chat) channelLines.push(this._tp('managed_server_channel_chat', { channelId: ch.chat }, locale));
    if (ch.admin) channelLines.push(this._tp('managed_server_channel_admin', { channelId: ch.admin }, locale));
    blocks.push(`${this._tp('managed_server_channels_heading', {}, locale)}\n${channelLines.length > 0 ? channelLines.join('\n') : this._tp('managed_server_none_configured', {}, locale)}`);

    if (instance) {
      const status = instance.getStatus();
      const modLines = status.modules?.length > 0 ? status.modules.join('\n') : this._tp('managed_server_modules_none', {}, locale);
      blocks.push(`${this._tp('managed_server_modules_heading', {}, locale)}\n${modLines}`);
    } else {
      blocks.push(`${this._tp('managed_server_modules_heading', {}, locale)}\n${this._tp('managed_server_not_running', {}, locale)}`);
    }

    const am = serverDef.autoMessages || {};
    const cfg = instance?.config || {};
    const amLines = [];
    const welcomeMsg  = am.enableWelcomeMsg  ?? cfg.enableWelcomeMsg  ?? true;
    const welcomeFile = am.enableWelcomeFile ?? cfg.enableWelcomeFile ?? true;
    const linkBcast   = am.enableAutoMsgLink ?? cfg.enableAutoMsgLink ?? true;
    const promoBcast  = am.enableAutoMsgPromo ?? cfg.enableAutoMsgPromo ?? true;
    amLines.push(this._tp('managed_server_auto_rcon_welcome', { state: onOff(welcomeMsg) }, locale));
    amLines.push(this._tp('managed_server_auto_welcome_file', { state: onOff(welcomeFile) }, locale));
    amLines.push(this._tp('managed_server_auto_link_broadcast', { state: onOff(linkBcast) }, locale));
    amLines.push(this._tp('managed_server_auto_promo_broadcast', { state: onOff(promoBcast) }, locale));
    if (am.linkText) {
      amLines.push(this._tp('managed_server_auto_link_line', {
        value: `\`${am.linkText.slice(0, 40)}${am.linkText.length > 40 ? '...' : ''}\``,
      }, locale));
    }
    if (am.promoText) {
      amLines.push(this._tp('managed_server_auto_promo_line', {
        value: `\`${am.promoText.slice(0, 40)}${am.promoText.length > 40 ? '...' : ''}\``,
      }, locale));
    }
    if (am.discordLink) {
      amLines.push(this._tp('managed_server_auto_discord_line', {
        value: `\`${am.discordLink.slice(0, 40)}\``,
      }, locale));
    }
    blocks.push(`${this._tp('managed_server_auto_messages_heading', {}, locale)}\n${amLines.join('\n')}`);

    return _container(blocks, [], running ? 0x57f287 : 0xed4245);
  }

  /**
   * Build action-row controls for a managed server view.
   * @param {string} serverId
   * @param {boolean} running
   */
  _buildManagedServerComponents(serverId, running) {
    const locale = this._sharedLocale();
    const actionOptions = [];
    if (running) {
      actionOptions.push(
        { label: this._tp('option_stop', {}, locale), description: this._tp('option_desc_stop_managed_server', {}, locale), value: `stop:${serverId}` },
        { label: this._tp('option_restart', {}, locale), description: this._tp('option_desc_restart_managed_server', {}, locale), value: `restart:${serverId}` },
      );
    } else {
      actionOptions.push({ label: this._tp('option_start', {}, locale), description: this._tp('option_desc_start_managed_server', {}, locale), value: `start:${serverId}` });
    }
    actionOptions.push(
      { label: this._tp('option_edit_connection', {}, locale), description: this._tp('option_desc_edit_connection', {}, locale), value: `edit:${serverId}` },
      { label: this._tp('option_edit_channels', {}, locale), description: this._tp('option_desc_edit_channels', {}, locale), value: `channels:${serverId}` },
      { label: this._tp('option_edit_sftp', {}, locale), description: this._tp('option_desc_edit_sftp', {}, locale), value: `sftp:${serverId}` },
      { label: this._tp('option_welcome_message', {}, locale), description: this._tp('option_desc_edit_server_welcome_popup', {}, locale), value: `welcome:${serverId}` },
      { label: this._tp('option_auto_messages', {}, locale), description: this._tp('option_desc_edit_server_auto_messages', {}, locale), value: `automsg:${serverId}` },
      { label: this._tp('option_remove_server', {}, locale), description: this._tp('option_desc_remove_managed_server', {}, locale), value: `remove:${serverId}` },
    );

    const actionSelect = new StringSelectMenuBuilder()
      .setCustomId(SELECT.ACTIONS_MANAGED)
      .setPlaceholder(this._tp('placeholder_managed_server_actions', {}, locale))
      .addOptions(actionOptions);

    // Game settings dropdown (row 3)  uses server's SFTP
    const serverDef = this.multiServerManager?.getAllServers().find(s => s.id === serverId);
    const hasSftp = !!(serverDef?.sftp?.host || config.ftpHost);
    const rows = [new ActionRowBuilder().addComponents(actionSelect)];
    if (hasSftp) {
      const settingsSelect = new StringSelectMenuBuilder()
        .setCustomId(`panel_srv_settings:${serverId}`)
        .setPlaceholder(this._tp('placeholder_edit_game_settings', {}, locale))
        .addOptions(
          GAME_SETTINGS_CATEGORIES.map(c => ({
            label: c.label,
            value: c.id,
          }))
        );
      rows.push(new ActionRowBuilder().addComponents(settingsSelect));
    }

    return rows;
  }

  _buildBotContainer(rows = [], view = 'bot') {
    const locale = this._sharedLocale();
    const upMs = Date.now() - this.startedAt.getTime();
    const username = this.client.user?.tag || this._tp('bot_name_fallback', {}, locale);

    const infoLines = [
      this._tp('bot_controls_heading', {}, locale),
      `**${username}**`,
      this._tp('bot_status_line', { uptime: _formatBotUptime(upMs) }, locale),
      this._tp('bot_timezone_line', { timezone: config.botTimezone }, locale),
    ];

    const caps = [];
    if (panelApi.available) caps.push(this._tp('capability_panel_api', {}, locale));
    if (this._hasSftp) caps.push(this._tp('capability_sftp', {}, locale));
    if (caps.length > 0 && caps.length < 2) {
      infoLines.push(this._tp('bot_capabilities_line', { capabilities: caps.join(' | ') }, locale));
    }

    const statusLines = [];
    let skippedCount = 0;
    for (const [name, status] of Object.entries(this.moduleStatus)) {
      const raw = String(status || '').trim();
      const text = raw.toLowerCase();
      const ok = raw.startsWith('🟢') ||
        text.includes('ok') ||
        text.includes('active') ||
        text.includes('enabled') ||
        text.includes('running') ||
        text.includes('online');
      const off = raw.startsWith('⚫') ||
        raw.startsWith('🔴') ||
        text.includes('off') ||
        text.includes('disabled') ||
        text.includes('stopped') ||
        text.includes('offline');
      const icon = ok ? '🟢' : off ? '⚫' : '🟡';
      statusLines.push(`${icon} ${name}`);
      if (icon === '🟡') skippedCount++;
    }
    if (statusLines.length > 0) {
      let value = statusLines.join('\n');
      if (skippedCount > 0) {
        value += `\n${this._tp('modules_need_attention_note', { count: skippedCount }, locale)}`;
      }
      infoLines.push(`${this._tp('modules_heading', {}, locale)}\n${value}`);
    }

    infoLines.push([
      this._tp('quick_actions_heading', {}, locale),
      this._tp('quick_action_restart_bot_line', {}, locale),
      this._tp('quick_action_factory_reset_line', {}, locale),
      this._tp('quick_action_reimport_line', {}, locale),
      this._tp('quick_action_diagnostics_line', {}, locale),
    ].join('\n'));

    const viewLabels = {
      bot: this._tp('view_option_bot_controls', {}, locale),
      server: panelApi.available
        ? this._tp('view_option_primary_server', {}, locale)
        : this._tp('view_option_server_tools', {}, locale),
    };
    const viewLabel = viewLabels[view] || this._tp('view_label_managed_server', { id: view }, locale);
    infoLines.push(this._tp('control_center_active_view_block', { viewLabel }, locale));

    return _container(infoLines, rows, 0x5865f2);
  }

  _buildBotComponents() {
    const locale = this._sharedLocale();
    //  Select 1: Core & module settings 
    const coreCategories = ENV_CATEGORIES.filter(c => c.group === 1);
    const coreSelect = new StringSelectMenuBuilder()
      .setCustomId(SELECT.ENV)
      .setPlaceholder(this._tp('placeholder_core_module_settings', {}, locale))
      .addOptions(
        coreCategories.map(c => ({
          label: c.label,
          description: c.description,
          value: c.id,
        }))
      );

    //  Select 2: Display & schedule settings 
    const displayCategories = ENV_CATEGORIES.filter(c => c.group === 2);
    const displaySelect = new StringSelectMenuBuilder()
      .setCustomId(SELECT.ENV2)
      .setPlaceholder(this._tp('placeholder_display_schedule_settings', {}, locale))
      .addOptions(
        displayCategories.map(c => ({
          label: c.label,
          description: c.description,
          value: c.id,
        }))
      );

    const { needsSync } = require('../env-sync');
    const actionOptions = [
      { label: this._tp('option_system_diagnostics', {}, locale), description: this._tp('option_desc_run_live_health_checks', {}, locale), value: 'diagnostics' },
      {
        label: needsSync()
          ? this._tp('option_sync_env', {}, locale)
          : this._tp('option_env_synced', {}, locale),
        description: needsSync()
          ? this._tp('option_desc_apply_pending_env_schema_changes', {}, locale)
          : this._tp('option_desc_no_pending_env_changes', {}, locale),
        value: 'env_sync',
      },
    ];
    if (this.multiServerManager) {
      actionOptions.push({
        label: this._tp('option_add_server', {}, locale),
        description: this._tp('option_desc_add_managed_server', {}, locale),
        value: 'add_server',
      });
    }
    actionOptions.push(
      { label: this._tp('option_restart_bot', {}, locale), description: this._tp('option_desc_restart_bot_process', {}, locale), value: 'restart_bot' },
      { label: this._tp('option_reimport_data', {}, locale), description: this._tp('option_desc_rebuild_local_data', {}, locale), value: 'reimport' },
      { label: this._tp('option_factory_reset', {}, locale), description: this._tp('option_desc_factory_reset', {}, locale), value: 'factory_reset' },
    );

    const actionsSelect = new StringSelectMenuBuilder()
      .setCustomId(SELECT.ACTIONS_BOT)
      .setPlaceholder(this._tp('placeholder_quick_actions', {}, locale))
      .addOptions(actionOptions);

    const rows = [
      new ActionRowBuilder().addComponents(coreSelect),
      new ActionRowBuilder().addComponents(displaySelect),
      new ActionRowBuilder().addComponents(actionsSelect),
    ];

    return rows;
  }

  _buildServerComponents(state) {
    const locale = this._sharedLocale();
    const isRunning = state === 'running';
    const isOff = state === 'offline';
    const isTransitioning = state === 'starting' || state === 'stopping';

    const actionOptions = [];
    if (!isRunning && !isTransitioning) {
      actionOptions.push({ label: this._tp('option_start', {}, locale), description: this._tp('option_desc_start_game_server', {}, locale), value: 'start' });
    }
    if (!isOff && !isTransitioning) {
      actionOptions.push(
        { label: this._tp('option_stop', {}, locale), description: this._tp('option_desc_stop_game_server_gracefully', {}, locale), value: 'stop' },
        { label: this._tp('option_restart', {}, locale), description: this._tp('option_desc_restart_game_server', {}, locale), value: 'restart' },
      );
    }
    if (this._backupLimit !== 0) {
      actionOptions.push({ label: this._tp('option_backup', {}, locale), description: this._tp('option_desc_create_backup', {}, locale), value: 'backup' });
    }
    if (!isOff) {
      actionOptions.push({ label: this._tp('option_kill', {}, locale), description: this._tp('option_desc_force_kill_server', {}, locale), value: 'kill' });
    }
    if (this._hasSftp && config.enableWelcomeFile) {
      actionOptions.push({ label: this._tp('option_welcome_message', {}, locale), description: this._tp('option_desc_edit_welcome_message', {}, locale), value: 'welcome' });
    }
    if (config.enableAutoMessages) {
      actionOptions.push({ label: this._tp('option_broadcasts', {}, locale), description: this._tp('option_desc_edit_auto_broadcast_messages', {}, locale), value: 'broadcasts' });
    }

    const rows = [];
    if (actionOptions.length > 0) {
      const actionSelect = new StringSelectMenuBuilder()
        .setCustomId(SELECT.ACTIONS_SERVER)
        .setPlaceholder(this._tp('placeholder_server_actions', {}, locale))
        .addOptions(actionOptions);
      rows.push(new ActionRowBuilder().addComponents(actionSelect));
    }

    // Game settings dropdown if SFTP is configured and editor is enabled
    if (this._hasSftp && config.enableGameSettingsEditor) {
      const settingsSelect = new StringSelectMenuBuilder()
        .setCustomId(SELECT.SETTINGS)
        .setPlaceholder(this._tp('placeholder_edit_game_settings', {}, locale))
        .addOptions(
          GAME_SETTINGS_CATEGORIES.map(c => ({
            label: c.label,
            value: c.id,
          }))
        );
      rows.push(new ActionRowBuilder().addComponents(settingsSelect));
    }

    return rows;
  }

  _buildServerContainer(resources, details, backups, schedules) {
    const locale = this._sharedLocale();
    const state = resources?.state || 'offline';
    const si = _stateInfo(state, locale);

    const name = details?.name || this._tp('server_name_fallback', {}, locale);
    const desc = details?.description || '';
    let header = `${this._tp('primary_server_panel_heading', {}, locale)}\n**${name}**\n${si.emoji} **${si.label}**`;
    if (desc) header += `\n*${desc}*`;

    const blocks = [header, this._tp('primary_server_panel_subtitle', {}, locale)];

    if (resources && state === 'running') {
      const lines = [];

      if (resources.cpu != null) {
        const cpuLimit = details?.limits?.cpu || 100;
        const cpuRatio = Math.min(resources.cpu / cpuLimit, 1);
        lines.push(this._tp('server_resource_cpu', {
          bar: _progressBar(cpuRatio),
          value: resources.cpu,
          limit: cpuLimit,
        }, locale));
      }

      if (resources.memUsed != null && resources.memTotal != null) {
        const memRatio = resources.memTotal > 0 ? resources.memUsed / resources.memTotal : 0;
        lines.push(this._tp('server_resource_ram', {
          bar: _progressBar(memRatio),
          used: formatBytes(resources.memUsed),
          total: formatBytes(resources.memTotal),
        }, locale));
      }

      if (resources.diskUsed != null && resources.diskTotal != null) {
        const diskRatio = resources.diskTotal > 0 ? resources.diskUsed / resources.diskTotal : 0;
        lines.push(this._tp('server_resource_disk', {
          bar: _progressBar(diskRatio),
          used: formatBytes(resources.diskUsed),
          total: formatBytes(resources.diskTotal),
        }, locale));
      }

      if (resources.uptime != null) {
        const up = formatUptime(resources.uptime);
        if (up) lines.push(this._tp('server_resource_uptime', { uptime: up }, locale));
      }

      if (lines.length > 0) blocks.push(`${this._tp('server_live_resources_heading', {}, locale)}\n${lines.join('\n')}`);
    } else if (state !== 'running') {
      blocks.push(`${this._tp('server_resources_heading', {}, locale)}\n${this._tp('server_not_running_line', {}, locale)}`);
    }

    const allocs = details?.relationships?.allocations?.data || [];
    if (allocs.length > 0) {
      const allocLines = allocs.map(a => {
        const attr = a.attributes || a;
        const primary = attr.is_default ? this._tp('server_allocation_default_suffix', {}, locale) : '';
        const alias = attr.alias ? this._tp('server_allocation_alias_suffix', { alias: attr.alias }, locale) : '';
        const notes = attr.notes ? this._tp('server_allocation_notes_suffix', { notes: attr.notes }, locale) : '';
        return `\`${attr.ip}:${attr.port}\`${alias}${primary}${notes}`;
      });
      blocks.push(`${this._tp('server_allocations_heading', {}, locale)}\n${allocLines.join('\n')}`);
    }

    if (details?.node) {
      blocks.push(`${this._tp('server_node_heading', {}, locale)}\n${details.node}`);
    }

    const limits = details?.limits || {};
    const fl = details?.feature_limits || {};
    const planParts = [];
    if (limits.memory) planParts.push(this._tp('server_plan_ram', { memory: limits.memory }, locale));
    if (limits.disk != null) {
      const diskValue = limits.disk === 0
        ? this._tp('server_plan_disk_unlimited', {}, locale)
        : `${limits.disk} MB`;
      planParts.push(this._tp('server_plan_disk', { disk: diskValue }, locale));
    }
    if (limits.cpu) planParts.push(this._tp('server_plan_cpu', { cpu: limits.cpu }, locale));
    if (fl.backups != null) planParts.push(this._tp('server_plan_backups', { backups: fl.backups }, locale));
    if (fl.databases != null) planParts.push(this._tp('server_plan_dbs', { databases: fl.databases }, locale));
    if (fl.allocations != null) planParts.push(this._tp('server_plan_ports', { allocations: fl.allocations }, locale));
    if (planParts.length > 0) {
      blocks.push(`${this._tp('server_plan_heading', {}, locale)}\n${planParts.join('    ')}`);
    }

    if (backups && backups.length > 0) {
      const sorted = [...backups]
        .filter(b => b.completed_at)
        .sort((a, b) => new Date(b.completed_at) - new Date(a.completed_at));
      const successCount = backups.filter(b => b.is_successful).length;
      const totalSize = backups.reduce((sum, b) => sum + (b.bytes || 0), 0);
      const maxBackups = fl.backups || '?';

      const backupLines = sorted.slice(0, 5).map((b, i) => {
        const icon = b.is_successful ? '[OK]' : '[ERR]';
        const locked = b.is_locked ? this._tp('backup_locked_tag', {}, locale) : '';
        const completedAt = new Date(b.completed_at);
        const date = `${fmtDate(completedAt, locale)} ${fmtTime(completedAt, locale)}`;
        const backupName = b.name || this._tp('backup_name_fallback', { index: i + 1 }, locale);
        return `${icon} **${backupName}**${locked}\n ${formatBytes(b.bytes || 0)} - ${date}`;
      });

      const headerMeta = this._tp('backups_header_line', {
        success: successCount,
        max: maxBackups,
        total: formatBytes(totalSize),
      }, locale);
      blocks.push(`${this._tp('backups_heading_with_meta', { meta: headerMeta }, locale)}\n${backupLines.join('\n') || this._tp('backups_none', {}, locale)}`);
    } else {
      blocks.push(`${this._tp('backups_heading', {}, locale)}\n${this._tp('backups_empty_help', {}, locale)}`);
    }

    if (schedules && schedules.length > 0) {
      const activeCount = schedules.filter(s => s.is_active).length;
      const scheduleLines = schedules.slice(0, 8).map(s => {
        const active = s.is_active
          ? this._tp('schedule_active_tag', {}, locale)
          : this._tp('schedule_off_tag', {}, locale);
        const onlyOnline = s.only_when_online ? this._tp('schedule_online_only_tag', {}, locale) : '';
        let next = this._tp('schedule_next_pending', {}, locale);
        if (s.next_run_at) {
          const nextDate = new Date(s.next_run_at);
          const now = new Date();
          const diffMs = nextDate - now;
          if (diffMs > 0 && diffMs < 86400000) {
            const diffMins = Math.floor(diffMs / 60000);
            const diffHrs = Math.floor(diffMins / 60);
            const remMins = diffMins % 60;
            next = diffHrs > 0
              ? this._tp('schedule_next_in_hours_minutes', { hours: diffHrs, minutes: remMins }, locale)
              : this._tp('schedule_next_in_minutes', { minutes: diffMins }, locale);
          } else {
            next = `${fmtDate(nextDate, locale)} ${fmtTime(nextDate, locale)}`;
          }
        }
        return `${active} **${s.name}**${onlyOnline} - ${next}`;
      });
      blocks.push(`${this._tp('schedules_heading_with_meta', { active: activeCount, total: schedules.length }, locale)}\n${scheduleLines.join('\n')}`);
    }

    blocks.push([
      this._tp('commands_heading', {}, locale),
      this._tp('command_console', {}, locale),
      this._tp('command_schedules', {}, locale),
      this._tp('command_backup_delete', {}, locale),
    ].join('\n'));

    return _container(blocks, [], si.color);
  }
}

//  Setup wizard (extracted to panel-setup-wizard.js) 
Object.assign(PanelChannel.prototype, require('./panel-setup-wizard'));

//  Multi-server handlers (extracted to panel-multi-server.js) 
Object.assign(PanelChannel.prototype, require('./panel-multi-server'));

// Export custom IDs for the interaction handler
PanelChannel.BTN = BTN;
PanelChannel.SELECT = SELECT;
PanelChannel.ENV_CATEGORIES = ENV_CATEGORIES;
PanelChannel.GAME_SETTINGS_CATEGORIES = GAME_SETTINGS_CATEGORIES;

module.exports = PanelChannel;



import { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, MessageFlags } from 'discord.js';
import { t, getLocalizations, fmtDate, fmtTime } from '../i18n/index.js';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const panelApi = require('../server/panel-api') as {
  available: boolean;
  getResources(): Promise<{
    state: string;
    cpu?: number;
    memUsed?: number;
    memTotal?: number;
    memPercent?: number;
    diskUsed?: number;
    diskTotal?: number;
    diskPercent?: number;
    uptime?: number;
  }>;
  getServerDetails(): Promise<{
    name?: string;
    node?: string;
    limits?: { memory?: number; disk?: number; cpu?: number };
    feature_limits?: { databases?: number; allocations?: number; backups?: number };
  }>;
  sendPowerAction(signal: string): Promise<void>;
  sendCommand(command: string): Promise<void>;
  listBackups(): Promise<
    Array<{
      uuid: string;
      name?: string;
      bytes: number;
      is_successful: boolean;
      is_locked: boolean;
      completed_at?: string;
    }>
  >;
  createBackup(name: string): Promise<{ name?: string; uuid?: string }>;
  deleteBackup(uuid: string): Promise<void>;
  listSchedules(): Promise<
    Array<{
      name: string;
      is_active: boolean;
      only_when_online: boolean;
      cron?: { minute?: string; hour?: string; day_of_month?: string; month?: string; day_of_week?: string };
      last_run_at?: string;
      next_run_at?: string;
    }>
  >;
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const _serverResources = require('../server/server-resources') as {
  formatBytes: (bytes: number) => string;
  formatUptime: (seconds: number) => string;
};
const formatBytes = (bytes: number): string => _serverResources.formatBytes(bytes);
const formatUptime = (seconds: number): string => _serverResources.formatUptime(seconds);

const STATE_DISPLAY: Record<string, { emoji: string; key: string; color: number }> = {
  running: { emoji: '🟢', key: 'running', color: 0x2ecc71 },
  starting: { emoji: '🟡', key: 'starting', color: 0xf1c40f },
  stopping: { emoji: '🟠', key: 'stopping', color: 0xe67e22 },
  offline: { emoji: '🔴', key: 'offline', color: 0xe74c3c },
};

function _stateInfo(state: string, locale: string): { emoji: string; label: string; color: number } {
  const info = STATE_DISPLAY[state] ?? { emoji: '⚪', key: 'unknown', color: 0x95a5a6 };
  return {
    emoji: info.emoji,
    label: t(`commands:qspanel.state.${info.key}`, locale),
    color: info.color,
  };
}

export const data = new SlashCommandBuilder()
  .setName('qspanel')
  .setNameLocalizations(getLocalizations('commands:qspanel.name'))
  .setDescription(t('commands:qspanel.description', 'en'))
  .setDescriptionLocalizations(getLocalizations('commands:qspanel.description'))
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)

  .addSubcommand((sub) =>
    sub
      .setName('status')
      .setDescription(t('commands:qspanel.subcommands.status', 'en'))
      .setDescriptionLocalizations(getLocalizations('commands:qspanel.subcommands.status')),
  )

  .addSubcommand((sub) =>
    sub
      .setName('start')
      .setDescription(t('commands:qspanel.subcommands.start', 'en'))
      .setDescriptionLocalizations(getLocalizations('commands:qspanel.subcommands.start')),
  )

  .addSubcommand((sub) =>
    sub
      .setName('stop')
      .setDescription(t('commands:qspanel.subcommands.stop', 'en'))
      .setDescriptionLocalizations(getLocalizations('commands:qspanel.subcommands.stop')),
  )

  .addSubcommand((sub) =>
    sub
      .setName('restart')
      .setDescription(t('commands:qspanel.subcommands.restart', 'en'))
      .setDescriptionLocalizations(getLocalizations('commands:qspanel.subcommands.restart')),
  )

  .addSubcommand((sub) =>
    sub
      .setName('kill')
      .setDescription(t('commands:qspanel.subcommands.kill', 'en'))
      .setDescriptionLocalizations(getLocalizations('commands:qspanel.subcommands.kill')),
  )

  .addSubcommand((sub) =>
    sub
      .setName('console')
      .setDescription(t('commands:qspanel.subcommands.console', 'en'))
      .setDescriptionLocalizations(getLocalizations('commands:qspanel.subcommands.console'))
      .addStringOption((opt) =>
        opt
          .setName('command')
          .setDescription(t('commands:qspanel.options.command', 'en'))
          .setDescriptionLocalizations(getLocalizations('commands:qspanel.options.command'))
          .setRequired(true),
      ),
  )

  .addSubcommand((sub) =>
    sub
      .setName('backups')
      .setDescription(t('commands:qspanel.subcommands.backups', 'en'))
      .setDescriptionLocalizations(getLocalizations('commands:qspanel.subcommands.backups')),
  )

  .addSubcommand((sub) =>
    sub
      .setName('backup-create')
      .setDescription(t('commands:qspanel.subcommands.backup_create', 'en'))
      .setDescriptionLocalizations(getLocalizations('commands:qspanel.subcommands.backup_create'))
      .addStringOption((opt) =>
        opt
          .setName('name')
          .setDescription(t('commands:qspanel.options.backup_name', 'en'))
          .setDescriptionLocalizations(getLocalizations('commands:qspanel.options.backup_name'))
          .setRequired(false),
      ),
  )

  .addSubcommand((sub) =>
    sub
      .setName('backup-delete')
      .setDescription(t('commands:qspanel.subcommands.backup_delete', 'en'))
      .setDescriptionLocalizations(getLocalizations('commands:qspanel.subcommands.backup_delete'))
      .addStringOption((opt) =>
        opt
          .setName('uuid')
          .setDescription(t('commands:qspanel.options.backup_uuid', 'en'))
          .setDescriptionLocalizations(getLocalizations('commands:qspanel.options.backup_uuid'))
          .setRequired(true),
      ),
  )

  .addSubcommand((sub) =>
    sub
      .setName('schedules')
      .setDescription(t('commands:qspanel.subcommands.schedules', 'en'))
      .setDescriptionLocalizations(getLocalizations('commands:qspanel.subcommands.schedules')),
  );

export async function execute(interaction: import('discord.js').ChatInputCommandInteraction): Promise<void> {
  const locale = interaction.locale;
  if (!panelApi.available) {
    await interaction.reply({
      content: t('commands:qspanel.reply.panel_api_not_configured', locale),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const sub = interaction.options.getSubcommand();

  switch (sub) {
    case 'status':
      return _status(interaction);
    case 'start':
      return _power(interaction, 'start');
    case 'stop':
      return _power(interaction, 'stop');
    case 'restart':
      return _power(interaction, 'restart');
    case 'kill':
      return _power(interaction, 'kill');
    case 'console':
      return _console(interaction);
    case 'backups':
      return _backups(interaction);
    case 'backup-create':
      return _backupCreate(interaction);
    case 'backup-delete':
      return _backupDelete(interaction);
    case 'schedules':
      return _schedules(interaction);
    default:
      await interaction.reply({
        content: t('commands:qspanel.reply.unknown_subcommand', locale, { subcommand: sub }),
        flags: MessageFlags.Ephemeral,
      });
  }
}

async function _status(interaction: import('discord.js').ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply();
  const locale = interaction.locale;

  try {
    const [resources, details] = await Promise.all([panelApi.getResources(), panelApi.getServerDetails()]);

    const si = _stateInfo(resources.state, locale);
    const embed = new EmbedBuilder()
      .setTitle(t('commands:qspanel.embeds.status_title', locale))
      .setColor(si.color)
      .setTimestamp();

    const name = details.name ?? t('commands:qspanel.reply.game_server_fallback', locale);
    embed.setDescription(
      t('commands:qspanel.reply.status_header', locale, {
        name,
        emoji: si.emoji,
        label: si.label,
      }),
    );

    const resParts: string[] = [];
    if (resources.cpu != null) resParts.push(`🖥️ CPU: **${String(resources.cpu)}%**`);
    if (resources.memUsed != null && resources.memTotal != null) {
      resParts.push(
        `🧠 RAM: **${formatBytes(resources.memUsed)}** / ${formatBytes(resources.memTotal)} (${resources.memPercent != null ? String(resources.memPercent) : '?'}%)`,
      );
    }
    if (resources.diskUsed != null && resources.diskTotal != null) {
      resParts.push(
        `💾 Disk: **${formatBytes(resources.diskUsed)}** / ${formatBytes(resources.diskTotal)} (${resources.diskPercent != null ? String(resources.diskPercent) : '?'}%)`,
      );
    }
    if (resources.uptime != null) {
      const up = formatUptime(resources.uptime);
      if (up) resParts.push(`⏱️ Uptime: **${up}**`);
    }
    if (resParts.length > 0) {
      embed.addFields({ name: t('commands:qspanel.embeds.resources_field', locale), value: resParts.join('\n') });
    }

    const limits = details.limits ?? {};
    const limitParts: string[] = [];
    if (limits.memory != null) limitParts.push(`RAM: ${String(limits.memory)} MB`);
    if (limits.disk != null)
      limitParts.push(
        `Disk: ${limits.disk === 0 ? t('commands:qspanel.reply.unlimited', locale) : `${String(limits.disk)} MB`}`,
      );
    if (limits.cpu != null) limitParts.push(`CPU: ${String(limits.cpu)}%`);
    if (limitParts.length > 0) {
      embed.addFields({
        name: t('commands:qspanel.embeds.plan_limits_field', locale),
        value: limitParts.join('  ·  '),
        inline: true,
      });
    }

    const fl = details.feature_limits ?? {};
    const fParts: string[] = [];
    if (fl.databases != null) fParts.push(`Databases: ${String(fl.databases)}`);
    if (fl.allocations != null) fParts.push(`Ports: ${String(fl.allocations)}`);
    if (fl.backups != null) fParts.push(`Backups: ${String(fl.backups)}`);
    if (fParts.length > 0) {
      embed.addFields({
        name: t('commands:qspanel.embeds.features_field', locale),
        value: fParts.join('  ·  '),
        inline: true,
      });
    }

    if (details.node) {
      embed.addFields({ name: t('commands:qspanel.embeds.node_field', locale), value: details.node, inline: true });
    }

    embed.setFooter({ text: t('commands:qspanel.embeds.footer', locale) });

    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    console.error('[CMD:panel:status]', (err as Error).message);
    await interaction.editReply({
      content: t('commands:qspanel.reply.status_fetch_failed', locale, { error: (err as Error).message }),
    });
  }
}

async function _power(interaction: import('discord.js').ChatInputCommandInteraction, signal: string): Promise<void> {
  await interaction.deferReply();
  const locale = interaction.locale;

  const labels: Record<string, { verb: string; emoji: string; color: number }> = {
    start: { verb: t('commands:qspanel.power.starting', locale), emoji: '🟢', color: 0x2ecc71 },
    stop: { verb: t('commands:qspanel.power.stopping', locale), emoji: '🔴', color: 0xe74c3c },
    restart: { verb: t('commands:qspanel.power.restarting', locale), emoji: '🔄', color: 0xf39c12 },
    kill: { verb: t('commands:qspanel.power.killing', locale), emoji: '💀', color: 0xe74c3c },
  };
  const l = labels[signal] ?? { verb: signal, emoji: '⚪', color: 0x95a5a6 };

  try {
    await panelApi.sendPowerAction(signal);

    const embed = new EmbedBuilder()
      .setTitle(t('commands:qspanel.embeds.power_action_title', locale, { emoji: l.emoji, verb: l.verb }))
      .setDescription(t('commands:qspanel.reply.power_signal_sent', locale, { signal }))
      .setColor(l.color)
      .setFooter({ text: t('commands:qspanel.reply.requested_by', locale, { user: interaction.user.tag }) })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    console.error(`[CMD:panel:${signal}]`, (err as Error).message);
    await interaction.editReply({
      content: t('commands:qspanel.reply.power_action_failed', locale, { signal, error: (err as Error).message }),
    });
  }
}

async function _console(interaction: import('discord.js').ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const locale = interaction.locale;

  const command = interaction.options.getString('command') ?? '';

  try {
    await panelApi.sendCommand(command);

    const embed = new EmbedBuilder()
      .setTitle(t('commands:qspanel.embeds.console_title', locale))
      .setDescription(
        t('commands:qspanel.reply.console_sent_body', locale, {
          command,
          note: t('commands:qspanel.reply.panel_console_note', locale),
        }),
      )
      .setColor(0x3498db)
      .setFooter({ text: t('commands:qspanel.reply.sent_by', locale, { user: interaction.user.tag }) })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    console.error('[CMD:panel:console]', (err as Error).message);
    await interaction.editReply({
      content: t('commands:qspanel.reply.console_command_failed', locale, { error: (err as Error).message }),
    });
  }
}

async function _backups(interaction: import('discord.js').ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply();
  const locale = interaction.locale;

  try {
    const backups = await panelApi.listBackups();

    const embed = new EmbedBuilder()
      .setTitle(t('commands:qspanel.embeds.backups_title', locale))
      .setColor(0x3498db)
      .setTimestamp();

    if (backups.length === 0) {
      embed.setDescription(t('commands:qspanel.reply.no_backups_found', locale));
    } else {
      const lines = backups.map((b, i) => {
        const status = b.is_successful ? '✅' : '❌';
        const lock = b.is_locked ? ' 🔒' : '';
        const size = formatBytes(b.bytes);
        const date = b.completed_at
          ? `${fmtDate(new Date(b.completed_at), locale)} ${fmtTime(new Date(b.completed_at), locale)}`
          : t('commands:qspanel.reply.backup_in_progress', locale);
        return t('commands:qspanel.reply.backup_line', locale, {
          status,
          lock,
          name: b.name ?? t('commands:qspanel.reply.backup_fallback_name', locale, { index: i + 1 }),
          size,
          date,
          uuid: b.uuid,
        });
      });
      embed.setDescription(lines.join('\n\n'));
    }

    embed.setFooter({ text: t('commands:qspanel.reply.backups_footer', locale, { count: backups.length }) });

    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    console.error('[CMD:panel:backups]', (err as Error).message);
    await interaction.editReply({
      content: t('commands:qspanel.reply.backups_fetch_failed', locale, { error: (err as Error).message }),
    });
  }
}

async function _backupCreate(interaction: import('discord.js').ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply();
  const locale = interaction.locale;

  const name = interaction.options.getString('name') ?? '';

  try {
    const backup = await panelApi.createBackup(name);

    const embed = new EmbedBuilder()
      .setTitle(t('commands:qspanel.embeds.backup_created_title', locale))
      .setDescription(
        t('commands:qspanel.reply.backup_created_body', locale, {
          name: backup.name ?? t('commands:qspanel.reply.new_backup_name', locale),
          uuid: backup.uuid ?? t('commands:qspanel.reply.pending', locale),
        }),
      )
      .setColor(0x2ecc71)
      .setFooter({ text: t('commands:qspanel.reply.requested_by', locale, { user: interaction.user.tag }) })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    console.error('[CMD:panel:backup-create]', (err as Error).message);
    const msg =
      (err as Error).message.includes('409') || (err as Error).message.includes('limit')
        ? t('commands:qspanel.reply.backup_limit_reached', locale)
        : t('commands:qspanel.reply.backup_create_failed', locale, { error: (err as Error).message });
    await interaction.editReply({ content: msg });
  }
}

async function _backupDelete(interaction: import('discord.js').ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const locale = interaction.locale;

  const uuid = interaction.options.getString('uuid') ?? '';

  try {
    await panelApi.deleteBackup(uuid);
    await interaction.editReply({ content: t('commands:qspanel.reply.backup_deleted', locale, { uuid }) });
  } catch (err) {
    console.error('[CMD:panel:backup-delete]', (err as Error).message);
    await interaction.editReply({
      content: t('commands:qspanel.reply.backup_delete_failed', locale, { error: (err as Error).message }),
    });
  }
}

async function _schedules(interaction: import('discord.js').ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply();
  const locale = interaction.locale;

  try {
    const schedules = await panelApi.listSchedules();

    const embed = new EmbedBuilder()
      .setTitle(t('commands:qspanel.embeds.schedules_title', locale))
      .setColor(0x3498db)
      .setTimestamp();

    if (schedules.length === 0) {
      embed.setDescription(t('commands:qspanel.reply.schedules_none', locale));
    } else {
      const lines = schedules.map((schedule) => {
        const active = schedule.is_active ? '🟢' : '⚫';
        const onlineOnly = schedule.only_when_online ? t('commands:qspanel.reply.online_only_suffix', locale) : '';
        const cron = `${schedule.cron?.minute ?? '*'} ${schedule.cron?.hour ?? '*'} ${schedule.cron?.day_of_month ?? '*'} ${schedule.cron?.month ?? '*'} ${schedule.cron?.day_of_week ?? '*'}`;
        const lastRun = schedule.last_run_at
          ? `${fmtDate(new Date(schedule.last_run_at), locale)} ${fmtTime(new Date(schedule.last_run_at), locale)}`
          : t('commands:qspanel.reply.never', locale);
        const nextRun = schedule.next_run_at
          ? `${fmtDate(new Date(schedule.next_run_at), locale)} ${fmtTime(new Date(schedule.next_run_at), locale)}`
          : '--';
        return t('commands:qspanel.reply.schedule_line', locale, {
          active,
          name: schedule.name,
          onlineOnly,
          cron,
          lastRun,
          nextRun,
        });
      });
      embed.setDescription(lines.join('\n\n'));
    }

    embed.setFooter({ text: t('commands:qspanel.reply.schedules_footer', locale, { count: schedules.length }) });

    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    console.error('[CMD:panel:schedules]', (err as Error).message);
    await interaction.editReply({
      content: t('commands:qspanel.reply.schedules_fetch_failed', locale, { error: (err as Error).message }),
    });
  }
}

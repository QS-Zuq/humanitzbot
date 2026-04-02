import { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } from 'discord.js';
import rcon from '../rcon/rcon.js';
import { t, getLocalizations } from '../i18n/index.js';

// Commands that could disrupt the server — blocked from Discord execution
// Keep in sync with web panel blocklist in src/web-map/server.js
const BLOCKED_COMMANDS = new Set([
  'shutdown',
  'quit',
  'exit',
  'restartnow',
  'quickrestart',
  'cancelrestart',
  'destroyall',
  'destroy_all',
  'wipe',
  'reset',
]);

export const data = new SlashCommandBuilder()
  .setName('rcon')
  .setNameLocalizations(getLocalizations('commands:rcon.name'))
  .setDescription(t('commands:rcon.description', 'en'))
  .setDescriptionLocalizations(getLocalizations('commands:rcon.description'))
  .addStringOption((option) =>
    option
      .setName('command')
      .setDescription(t('commands:rcon.options.command', 'en'))
      .setDescriptionLocalizations(getLocalizations('commands:rcon.options.command'))
      .setRequired(true),
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

export async function execute(interaction: import('discord.js').ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const locale = interaction.locale;

  const command = interaction.options.getString('command') ?? '';

  const cmdWord = command.trim().toLowerCase().split(/\s+/)[0] ?? '';
  if (BLOCKED_COMMANDS.has(cmdWord)) {
    await interaction.editReply({
      content: t('commands:rcon.reply.blocked', locale, { command: cmdWord }),
    });
    return;
  }

  try {
    const response = await rcon.send(command);

    const output =
      response && response.trim()
        ? `\`\`\`\n${response.substring(0, 1900)}\n\`\`\``
        : t('commands:rcon.reply.no_response', locale);

    await interaction.editReply({
      content: t('commands:rcon.reply.response_template', locale, {
        command,
        response: output,
      }),
    });
  } catch (err) {
    console.error('[CMD:rcon]', (err as Error).message);
    await interaction.editReply({
      content: t('commands:rcon.reply.failed', locale, { error: (err as Error).message }),
    });
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _mod = module as { exports: any };
_mod.exports = { data, execute };

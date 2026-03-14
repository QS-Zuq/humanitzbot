const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const rcon = require('../rcon/rcon');
const { t, getLocalizations } = require('../i18n');

// Commands that could disrupt the server — blocked from Discord execution
// Keep in sync with web panel blocklist in src/web-map/server.js
const BLOCKED_COMMANDS = new Set([
  'shutdown', 'quit', 'exit', 'restartnow', 'quickrestart',
  'cancelrestart', 'destroyall', 'destroy_all', 'wipe', 'reset',
]);

module.exports = {
  data: new SlashCommandBuilder()
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
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const locale = interaction.locale || 'en';

    const command = interaction.options.getString('command');

    const cmdWord = command.trim().toLowerCase().split(/\s+/)[0];
    if (BLOCKED_COMMANDS.has(cmdWord)) {
      await interaction.editReply({
        content: t('commands:rcon.reply.blocked', locale, { command: cmdWord }),
      });
      return;
    }

    try {
      const response = await rcon.send(command);

      const output = response && response.trim()
        ? `\`\`\`\n${response.substring(0, 1900)}\n\`\`\``
        : t('commands:rcon.reply.no_response', locale);

      await interaction.editReply({
        content: t('commands:rcon.reply.response_template', locale, {
          command,
          response: output,
        }),
      });
    } catch (err) {
      console.error('[CMD:rcon]', err.message);
      await interaction.editReply({
        content: t('commands:rcon.reply.failed', locale, { error: err.message }),
      });
    }
  },
};

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const rcon = require('../rcon');

// Commands that could disrupt the server — blocked from Discord execution
const BLOCKED_COMMANDS = new Set([
  'shutdown', 'quit', 'exit', 'restartnow', 'quickrestart',
]);

module.exports = {
  data: new SlashCommandBuilder()
    .setName('rcon')
    .setDescription('Send a raw RCON command to the server (Admin only)')
    .addStringOption(option =>
      option
        .setName('command')
        .setDescription('The RCON command to send')
        .setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const command = interaction.options.getString('command');

    // Block destructive commands
    const cmdWord = command.trim().toLowerCase().split(/\s+/)[0];
    if (BLOCKED_COMMANDS.has(cmdWord)) {
      await interaction.editReply({
        content: `❌ The command \`${cmdWord}\` is blocked for safety. Use the server panel to perform this action.`,
      });
      return;
    }

    try {
      const response = await rcon.send(command);

      const output = response && response.trim()
        ? `\`\`\`\n${response.substring(0, 1900)}\n\`\`\``
        : '_No response from server._';

      await interaction.editReply({
        content: `**Command:** \`${command}\`\n**Response:**\n${output}`,
      });
    } catch (err) {
      console.error('[CMD:rcon]', err.message);
      await interaction.editReply({
        content: `❌ RCON command failed: ${err.message}`,
      });
    }
  },
};

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const rcon = require('../rcon');

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

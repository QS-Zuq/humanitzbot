const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getServerInfo, getPlayerList } = require('../server-info');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('server')
    .setDescription('Show HumanitZ server world info and player count'),

  async execute(interaction) {
    await interaction.deferReply();

    try {
      const [info, playerList] = await Promise.all([
        getServerInfo(),
        getPlayerList(),
      ]);

      const embed = new EmbedBuilder()
        .setTitle('🖥️ Server Info')
        .setColor(0x2ecc71)
        .setFooter({ text: 'HumanitZ Server • via RCON `info`' })
        .setTimestamp();

      // If the `info` command returned structured fields, display them all
      if (info.fields && Object.keys(info.fields).length > 0) {
        for (const [key, value] of Object.entries(info.fields)) {
          embed.addFields({ name: key, value: value, inline: true });
        }
      }

      // Always show player count from the Players command
      const playerCount = info.players != null
        ? (info.maxPlayers ? `${info.players} / ${info.maxPlayers}` : `${info.players}`)
        : `${playerList.count}`;
      embed.addFields({ name: 'Online Players', value: playerCount, inline: true });

      // If the raw response didn't parse to any fields, show it as-is
      if (!info.fields || Object.keys(info.fields).length === 0) {
        const rawText = info.raw && info.raw.trim()
          ? `\`\`\`\n${info.raw.substring(0, 1000)}\n\`\`\``
          : '_No data returned from server._';
        embed.setDescription(rawText);
      }

      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      console.error('[CMD:server]', err.message);
      await interaction.editReply({
        content: '❌ Could not reach the server. It may be offline or RCON is unavailable.',
      });
    }
  },
};

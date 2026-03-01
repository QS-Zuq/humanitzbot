/**
 * /players — Show online players with playtime context.
 *
 * Clean list: numbered, bold names, total playtime.
 * No SteamIDs exposed.
 */

'use strict';

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getPlayerList } = require('../rcon/server-info');
const playtime = require('../tracking/playtime-tracker');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('players')
    .setDescription('Show online players on the HumanitZ server'),

  async execute(interaction) {
    await interaction.deferReply();

    try {
      const list = await getPlayerList();

      const embed = new EmbedBuilder()
        .setTitle('\uD83D\uDC65 Online Players')
        .setColor(0x3498db)
        .setFooter({ text: 'HumanitZ Server' })
        .setTimestamp();

      if (list.count === 0 && list.players.length === 0) {
        embed.setDescription('No players currently online.');
      } else {
        embed.setDescription(`**${list.count}** player${list.count !== 1 ? 's' : ''} online`);

        if (list.players.length > 0) {
          const playerLines = list.players.map((p, i) => {
            const id = (p.steamId && p.steamId !== 'N/A') ? p.steamId : p.name;
            const pt = playtime.getPlaytime(id);
            const time = pt ? ` \u2014 ${pt.totalFormatted}` : '';
            return `\`${i + 1}.\` **${p.name}**${time}`;
          });

          const chunks = [];
          for (let i = 0; i < playerLines.length; i += 15) {
            chunks.push(playerLines.slice(i, i + 15));
          }
          chunks.forEach((chunk, idx) => {
            embed.addFields({
              name: chunks.length > 1 ? `Players (${idx + 1}/${chunks.length})` : 'Players',
              value: chunk.join('\n'),
            });
          });
        }
      }

      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      console.error('[CMD:players]', err.message);
      await interaction.editReply({
        content: '\u274C Could not fetch player list. The server may be offline.',
      });
    }
  },
};

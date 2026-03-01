/**
 * /playtime — Playtime leaderboard or player lookup.
 *
 * No SteamIDs exposed to non-admins. Clean, focused output.
 */

'use strict';

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const playtime = require('../tracking/playtime-tracker');
const config = require('../config');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('playtime')
    .setDescription('Show playtime leaderboard or look up a player')
    .addStringOption(option =>
      option
        .setName('player')
        .setDescription('Player name to look up (leave empty for leaderboard)')
        .setRequired(false)
    ),

  async execute(interaction) {
    await interaction.deferReply();

    try {
      const search = interaction.options.getString('player');
      const trackingSince = new Date(playtime.getTrackingSince())
        .toLocaleDateString('en-GB', { timeZone: config.botTimezone });

      if (search) {
        // ── Player lookup ──
        const leaderboard = playtime.getLeaderboard();
        const match = leaderboard.find(
          e => e.name.toLowerCase() === search.toLowerCase()
        ) || leaderboard.find(
          e => e.name.toLowerCase().includes(search.toLowerCase())
        );

        if (!match) {
          await interaction.editReply(`No playtime data found for **${search}**.`);
          return;
        }

        // Rank position
        const rank = leaderboard.indexOf(match) + 1;
        const rankStr = rank <= 3 ? ['\uD83E\uDD47', '\uD83E\uDD48', '\uD83E\uDD49'][rank - 1] : `#${rank}`;

        const embed = new EmbedBuilder()
          .setTitle(`\u23F1\uFE0F ${match.name}`)
          .setColor(0x9b59b6)
          .setDescription(`${rankStr} on the leaderboard`)
          .addFields(
            { name: 'Total Playtime', value: match.totalFormatted, inline: true },
            { name: 'Sessions', value: `${match.sessions}`, inline: true },
          )
          .setFooter({ text: `Tracking since ${trackingSince}` })
          .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
      } else {
        // ── Leaderboard ──
        const leaderboard = playtime.getLeaderboard();

        const embed = new EmbedBuilder()
          .setTitle('\u23F1\uFE0F Playtime Leaderboard')
          .setColor(0x9b59b6)
          .setFooter({ text: `Tracking since ${trackingSince}` })
          .setTimestamp();

        if (leaderboard.length === 0) {
          embed.setDescription('No playtime data recorded yet.');
        } else {
          const top = leaderboard.slice(0, 20);
          const medals = ['\uD83E\uDD47', '\uD83E\uDD48', '\uD83E\uDD49'];
          const lines = top.map((entry, i) => {
            const medal = medals[i] || `\`${i + 1}.\``;
            return `${medal} **${entry.name}** \u2014 ${entry.totalFormatted} (${entry.sessions} session${entry.sessions !== 1 ? 's' : ''})`;
          });

          embed.setDescription(lines.join('\n'));

          if (leaderboard.length > 20) {
            embed.addFields({ name: '\u200b', value: `*\u2026and ${leaderboard.length - 20} more*` });
          }
        }

        await interaction.editReply({ embeds: [embed] });
      }
    } catch (err) {
      console.error('[CMD:playtime]', err.message);
      await interaction.editReply('\u274C Failed to retrieve playtime data.');
    }
  },
};

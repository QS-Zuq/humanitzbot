/**
 * /playtime — Playtime leaderboard or player lookup.
 *
 * No SteamIDs exposed to non-admins. Clean, focused output.
 */

'use strict';

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const playtime = require('../tracking/playtime-tracker');
const { t, getLocalizations, fmtDate } = require('../i18n');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('playtime')
    .setNameLocalizations(getLocalizations('commands:playtime.name'))
    .setDescription(t('commands:playtime.description', 'en'))
    .setDescriptionLocalizations(getLocalizations('commands:playtime.description'))
    .addStringOption((option) =>
      option
        .setName('player')
        .setDescription(t('commands:playtime.options.player', 'en'))
        .setDescriptionLocalizations(getLocalizations('commands:playtime.options.player'))
        .setRequired(false),
    ),

  async execute(interaction) {
    await interaction.deferReply();
    const locale = interaction.locale || 'en';

    try {
      const search = interaction.options.getString('player');
      const trackingSince = fmtDate(new Date(playtime.getTrackingSince()), locale);

      if (search) {
        // Player lookup
        const leaderboard = playtime.getLeaderboard();
        const match = leaderboard.find(
          (e) => e.name.toLowerCase() === search.toLowerCase(),
        ) || leaderboard.find(
          (e) => e.name.toLowerCase().includes(search.toLowerCase()),
        );

        if (!match) {
          await interaction.editReply(t('commands:playtime.reply.not_found', locale, { player: search }));
          return;
        }

        const rank = leaderboard.indexOf(match) + 1;
        const rankStr = rank <= 3 ? ['🥇', '🥈', '🥉'][rank - 1] : `#${rank}`;

        const embed = new EmbedBuilder()
          .setTitle(t('commands:playtime.embeds.player_title', locale, { name: match.name }))
          .setColor(0x9b59b6)
          .setDescription(t('commands:playtime.reply.rank_description', locale, { rank: rankStr }))
          .addFields(
            { name: t('commands:playtime.embeds.total_playtime', locale), value: match.totalFormatted, inline: true },
            { name: t('commands:playtime.embeds.sessions', locale), value: `${match.sessions}`, inline: true },
          )
          .setFooter({ text: t('commands:playtime.embeds.tracking_since', locale, { date: trackingSince }) })
          .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
      } else {
        // Leaderboard
        const leaderboard = playtime.getLeaderboard();

        const embed = new EmbedBuilder()
          .setTitle(t('commands:playtime.embeds.leaderboard_title', locale))
          .setColor(0x9b59b6)
          .setFooter({ text: t('commands:playtime.embeds.tracking_since', locale, { date: trackingSince }) })
          .setTimestamp();

        if (leaderboard.length === 0) {
          embed.setDescription(t('commands:playtime.reply.no_data', locale));
        } else {
          const top = leaderboard.slice(0, 20);
          const medals = ['🥇', '🥈', '🥉'];
          const lines = top.map((entry, i) => {
            const medal = medals[i] || `\`${i + 1}.\``;
            return t('commands:playtime.reply.leaderboard_line', locale, {
              medal,
              name: entry.name,
              playtime: entry.totalFormatted,
              sessions: entry.sessions,
              suffix: entry.sessions !== 1 ? 's' : '',
            });
          });

          embed.setDescription(lines.join('\n'));

          if (leaderboard.length > 20) {
            embed.addFields({
              name: '\u200b',
              value: t('commands:playtime.reply.more', locale, { count: leaderboard.length - 20 }),
            });
          }
        }

        await interaction.editReply({ embeds: [embed] });
      }
    } catch (err) {
      console.error('[CMD:playtime]', err.message);
      await interaction.editReply(t('commands:playtime.reply.fetch_failed', locale));
    }
  },
};

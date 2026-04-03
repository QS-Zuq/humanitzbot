/**
 * /playtime — Playtime leaderboard or player lookup.
 *
 * No SteamIDs exposed to non-admins. Clean, focused output.
 */

import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import playtime from '../tracking/playtime-tracker.js';
import { t, getLocalizations, fmtDate } from '../i18n/index.js';
import config from '../config/index.js';
import { errMsg } from '../utils/error.js';

export const data = new SlashCommandBuilder()
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
  );

export async function execute(interaction: import('discord.js').ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply();
  const locale = interaction.locale;

  try {
    const search = interaction.options.getString('player');
    const trackingSince = fmtDate(new Date(playtime.getTrackingSince()), locale, config.botTimezone);

    if (search) {
      // Player lookup
      const leaderboard = playtime.getLeaderboard();
      const match =
        leaderboard.find((e) => e.name.toLowerCase() === search.toLowerCase()) ||
        leaderboard.find((e) => e.name.toLowerCase().includes(search.toLowerCase()));

      if (!match) {
        await interaction.editReply(t('commands:playtime.reply.not_found', locale, { player: search }));
        return;
      }

      const rank = leaderboard.indexOf(match) + 1;
      const medals = ['🥇', '🥈', '🥉'];
      const rankStr = rank <= 3 ? (medals[rank - 1] ?? `#${String(rank)}`) : `#${String(rank)}`;

      const embed = new EmbedBuilder()
        .setTitle(t('commands:playtime.embeds.player_title', locale, { name: match.name }))
        .setColor(0x9b59b6)
        .setDescription(t('commands:playtime.reply.rank_description', locale, { rank: rankStr }))
        .addFields(
          { name: t('commands:playtime.embeds.total_playtime', locale), value: match.totalFormatted, inline: true },
          { name: t('commands:playtime.embeds.sessions', locale), value: String(match.sessions), inline: true },
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
          const medal = medals[i] ?? `\`${String(i + 1)}.\``;
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
    console.error('[CMD:playtime]', errMsg(err));
    await interaction.editReply(t('commands:playtime.reply.fetch_failed', locale));
  }
}

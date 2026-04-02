/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * /players — Show online players with playtime context.
 *
 * Clean list: numbered, bold names, total playtime.
 * No SteamIDs exposed.
 */

import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { getPlayerList } from '../rcon/server-info.js';
const playtime = require('../tracking/playtime-tracker') as import('../tracking/playtime-tracker.js').PlaytimeTracker;
import { t, getLocalizations } from '../i18n/index.js';

export const data = new SlashCommandBuilder()
  .setName('players')
  .setNameLocalizations(getLocalizations('commands:players.name'))
  .setDescription(t('commands:players.description', 'en'))
  .setDescriptionLocalizations(getLocalizations('commands:players.description'));

export async function execute(interaction: import('discord.js').ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply();
  const locale = interaction.locale;

  try {
    const list = await getPlayerList();

    const embed = new EmbedBuilder()
      .setTitle(t('commands:players.embeds.title', locale))
      .setColor(0x3498db)
      .setFooter({ text: t('commands:players.embeds.footer', locale) })
      .setTimestamp();

    if (list.count === 0 && list.players.length === 0) {
      embed.setDescription(t('commands:players.reply.no_players_online', locale));
    } else {
      embed.setDescription(
        t('commands:players.reply.players_online_count', locale, {
          count: list.count,
          suffix: list.count !== 1 ? 's' : '',
        }),
      );

      if (list.players.length > 0) {
        const playerLines = list.players.map((p, i) => {
          const id = p.steamId && p.steamId !== 'N/A' ? p.steamId : p.name;
          const pt = playtime.getPlaytime(id);
          const time = pt ? ` \u2014 ${pt.totalFormatted}` : '';
          return `\`${String(i + 1)}.\` **${p.name}**${time}`;
        });

        const chunks: string[][] = [];
        for (let i = 0; i < playerLines.length; i += 15) {
          chunks.push(playerLines.slice(i, i + 15));
        }
        chunks.forEach((chunk, idx) => {
          embed.addFields({
            name:
              chunks.length > 1
                ? t('commands:players.reply.players_field_paged', locale, { page: idx + 1, total: chunks.length })
                : t('commands:players.reply.players_field', locale),
            value: chunk.join('\n'),
          });
        });
      }
    }

    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    console.error('[CMD:players]', (err as Error).message);
    await interaction.editReply({
      content: t('commands:players.reply.fetch_failed', locale),
    });
  }
}

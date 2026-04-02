/**
 * /playerstats — View player activity stats from the log.
 *
 * Uses the lightweight player-embed.js (log-only data).
 * The full save-enriched view is available via the #player-stats channel select menu.
 */

import {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ComponentType,
  type StringSelectMenuInteraction,
} from 'discord.js';
import playerStats from '../tracking/player-stats.js';
import playtime from '../tracking/playtime-tracker.js';
import { t, getLocalizations } from '../i18n/index.js';
import config from '../config/index.js';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { buildPlayerEmbed } = require('../modules/player-embed') as {
  buildPlayerEmbed: (stats: unknown, opts: { isAdmin: boolean }) => EmbedBuilder;
};

export const data = new SlashCommandBuilder()
  .setName('playerstats')
  .setNameLocalizations(getLocalizations('commands:playerstats.name'))
  .setDescription(t('commands:playerstats.description', 'en'))
  .setDescriptionLocalizations(getLocalizations('commands:playerstats.description'));

export async function execute(interaction: import('discord.js').ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply();
  const locale = interaction.locale;

  const allPlayers = playerStats.getAllPlayers();

  if (allPlayers.length === 0) {
    await interaction.editReply(t('commands:playerstats.reply.no_data', locale));
    return;
  }

  // Build select menu options (max 25 per Discord limit)
  const options = allPlayers.slice(0, 25).map((p) => {
    const pt = playtime.getPlaytime(p.id);
    const ptStr = pt ? ` · ${pt.totalFormatted}` : '';
    return {
      label: p.name.substring(0, 100),
      description: t('commands:playerstats.menus.player_option_description', locale, {
        deaths: p.deaths,
        builds: p.builds,
        playtime: ptStr,
      }).substring(0, 100),
      value: p.id,
    };
  });

  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId('playerstats_select')
    .setPlaceholder(t('commands:playerstats.menus.player_placeholder', locale))
    .addOptions(options);

  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);

  // Overview embed
  const totalDeaths = allPlayers.reduce((s, p) => s + p.deaths, 0);
  const totalBuilds = allPlayers.reduce((s, p) => s + p.builds, 0);
  const totalLoots = allPlayers.reduce((s, p) => s + p.containersLooted, 0);

  const embed = new EmbedBuilder()
    .setTitle(t('commands:playerstats.embeds.title', locale))
    .setDescription(t('commands:playerstats.embeds.tracked_survivors', locale, { count: allPlayers.length }))
    .setColor(0x5865f2)
    .setTimestamp();

  embed.addFields(
    { name: t('commands:playerstats.embeds.deaths', locale), value: String(totalDeaths), inline: true },
    { name: t('commands:playerstats.embeds.builds', locale), value: String(totalBuilds), inline: true },
    { name: t('commands:playerstats.embeds.looted', locale), value: String(totalLoots), inline: true },
  );

  // Top 5 most active
  const top5 = allPlayers.slice(0, 5).map((p, i) => {
    const medals = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'];
    const activity = p.deaths + p.builds + p.raidsOut + p.containersLooted;
    return `${medals[i] ?? String(i + 1)} **${p.name}** — ${t('commands:playerstats.reply.events_count', locale, { count: activity })}`;
  });
  if (top5.length > 0) {
    embed.addFields({ name: t('commands:playerstats.embeds.most_active', locale), value: top5.join('\n') });
  }

  const response = await interaction.editReply({ embeds: [embed], components: [row] });

  // Listen for select menu interactions (2 minute timeout)
  const collector = response.createMessageComponentCollector({
    componentType: ComponentType.StringSelect,
    time: 120_000,
  });

  collector.on('collect', (selectInteraction: StringSelectMenuInteraction) => {
    void (async () => {
      try {
        const selectedId = selectInteraction.values[0] ?? '';
        const stats = playerStats.getStats(selectedId);

        if (!stats) {
          await selectInteraction.update({
            embeds: [
              new EmbedBuilder()
                .setDescription(t('commands:playerstats.reply.player_not_found', locale))
                .setColor(0xe74c3c),
            ],
            components: [row],
          });
          return;
        }

        const adminFlag = config.isAdminView(selectInteraction.member as import('discord.js').GuildMember | null);
        const playerEmbed = buildPlayerEmbed(stats, { isAdmin: adminFlag });

        await selectInteraction.update({ embeds: [playerEmbed], components: [row] });
      } catch (err) {
        const code = (err as { code?: number }).code;
        if (![10062, 10008, 40060].includes(code ?? -1)) {
          console.error('[CMD:playerstats] Select interaction error:', (err as Error).message);
        }
      }
    })();
  });

  collector.on('end', () => {
    void (async () => {
      selectMenu.setDisabled(true);
      const disabledRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);
      await interaction.editReply({ components: [disabledRow] }).catch(() => {
        /* ignore */
      });
    })();
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _mod = module as { exports: any };
_mod.exports = { data, execute };

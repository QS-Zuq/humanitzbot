/**
 * /playerstats — View player activity stats from the log.
 *
 * Uses the lightweight player-embed.js (log-only data).
 * The full save-enriched view is available via the #player-stats channel select menu.
 */

'use strict';

const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ComponentType,
} = require('discord.js');
const playerStats = require('../tracking/player-stats');
const playtime    = require('../tracking/playtime-tracker');
const { buildPlayerEmbed } = require('../modules/player-embed');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('playerstats')
    .setDescription('View player activity stats (deaths, builds, raids, etc.)'),

  async execute(interaction) {
    await interaction.deferReply();

    const allPlayers = playerStats.getAllPlayers();

    if (allPlayers.length === 0) {
      await interaction.editReply('No player stats recorded yet. Stats are gathered from the game server log \u2014 play for a while and check back!');
      return;
    }

    // Build select menu options (max 25 per Discord limit)
    const options = allPlayers.slice(0, 25).map(p => {
      const pt = playtime.getPlaytime(p.id);
      const ptStr = pt ? ` \xB7 ${pt.totalFormatted}` : '';
      return {
        label: p.name.substring(0, 100),
        description: `\uD83D\uDC80 ${p.deaths} deaths \xB7 \uD83D\uDD28 ${p.builds} builds${ptStr}`.substring(0, 100),
        value: p.id,
      };
    });

    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId('playerstats_select')
      .setPlaceholder('Select a player to view their stats\u2026')
      .addOptions(options);

    const row = new ActionRowBuilder().addComponents(selectMenu);

    // Overview embed
    const totalDeaths = allPlayers.reduce((s, p) => s + p.deaths, 0);
    const totalBuilds = allPlayers.reduce((s, p) => s + p.builds, 0);
    const totalLoots  = allPlayers.reduce((s, p) => s + p.containersLooted, 0);

    const embed = new EmbedBuilder()
      .setTitle('\uD83D\uDCCA Player Activity')
      .setDescription(`**${allPlayers.length}** tracked survivors`)
      .setColor(0x5865F2)
      .setTimestamp();

    embed.addFields(
      { name: '\uD83D\uDC80 Deaths', value: `${totalDeaths}`, inline: true },
      { name: '\uD83D\uDD28 Builds', value: `${totalBuilds}`, inline: true },
      { name: '\uD83D\uDCE6 Looted', value: `${totalLoots}`, inline: true },
    );

    // Top 5 most active
    const top5 = allPlayers.slice(0, 5).map((p, i) => {
      const medals = ['\uD83E\uDD47', '\uD83E\uDD48', '\uD83E\uDD49', '4\uFE0F\u20E3', '5\uFE0F\u20E3'];
      const activity = p.deaths + p.builds + p.raidsOut + p.containersLooted;
      return `${medals[i]} **${p.name}** \u2014 ${activity} events`;
    });
    if (top5.length > 0) embed.addFields({ name: 'Most Active', value: top5.join('\n') });

    const response = await interaction.editReply({ embeds: [embed], components: [row] });

    // Listen for select menu interactions (2 minute timeout)
    const collector = response.createMessageComponentCollector({
      componentType: ComponentType.StringSelect,
      time: 120_000,
    });

    collector.on('collect', async (selectInteraction) => {
      try {
        const selectedId = selectInteraction.values[0];
        const stats = playerStats.getStats(selectedId);

        if (!stats) {
          await selectInteraction.update({
            embeds: [new EmbedBuilder().setDescription('Player not found.').setColor(0xe74c3c)],
            components: [row],
          });
          return;
        }

        const isAdmin = require('../config').isAdminView(selectInteraction.member);
        const playerEmbed = buildPlayerEmbed(stats, { isAdmin });

        await selectInteraction.update({ embeds: [playerEmbed], components: [row] });
      } catch (err) {
        if (![10062, 10008, 40060].includes(err.code)) {
          console.error('[CMD:playerstats] Select interaction error:', err.message);
        }
      }
    });

    collector.on('end', async () => {
      selectMenu.setDisabled(true);
      const disabledRow = new ActionRowBuilder().addComponents(selectMenu);
      await interaction.editReply({ components: [disabledRow] }).catch(() => {});
    });
  },
};

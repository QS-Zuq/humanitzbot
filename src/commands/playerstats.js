const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ComponentType,
} = require('discord.js');
const playerStats = require('../player-stats');
const playtime = require('../playtime-tracker');
const { buildPlayerEmbed } = require('../player-embed');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('playerstats')
    .setDescription('View player activity stats (deaths, builds, raids, etc.)'),

  async execute(interaction) {
    await interaction.deferReply();

    const allPlayers = playerStats.getAllPlayers();

    if (allPlayers.length === 0) {
      await interaction.editReply('No player stats recorded yet. Stats are gathered from the game server log — play for a while and check back!');
      return;
    }

    // Build select menu options (max 25 per Discord limit)
    const options = allPlayers.slice(0, 25).map(p => {
      const activity = p.deaths + p.builds + p.raidsOut + p.containersLooted;
      return {
        label: p.name.substring(0, 100),
        description: `Deaths: ${p.deaths} | Builds: ${p.builds} | Activity: ${activity}`,
        value: p.id,
      };
    });

    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId('playerstats_select')
      .setPlaceholder('Select a player to view their stats...')
      .addOptions(options);

    const row = new ActionRowBuilder().addComponents(selectMenu);

    // Show overview embed
    const overviewEmbed = buildOverviewEmbed(allPlayers);

    const response = await interaction.editReply({
      embeds: [overviewEmbed],
      components: [row],
    });

    // Listen for select menu interactions (2 minute timeout)
    const collector = response.createMessageComponentCollector({
      componentType: ComponentType.StringSelect,
      time: 120_000,
    });

    collector.on('collect', async (selectInteraction) => {
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
      const embed = buildPlayerEmbed(stats, { isAdmin });

      await selectInteraction.update({
        embeds: [embed],
        components: [row],
      });
    });

    collector.on('end', async () => {
      // Disable the select menu after timeout
      selectMenu.setDisabled(true);
      const disabledRow = new ActionRowBuilder().addComponents(selectMenu);
      await interaction.editReply({ components: [disabledRow] }).catch(() => {});
    });
  },
};

function buildOverviewEmbed(allPlayers) {
  const totalDeaths = allPlayers.reduce((s, p) => s + p.deaths, 0);
  const totalBuilds = allPlayers.reduce((s, p) => s + p.builds, 0);
  const totalRaids = allPlayers.reduce((s, p) => s + p.raidsOut, 0);
  const totalLoots = allPlayers.reduce((s, p) => s + p.containersLooted, 0);

  const embed = new EmbedBuilder()
    .setTitle('Player Stats')
    .setDescription('Select a player from the dropdown below to view their detailed stats.')
    .setColor(0x3498db)
    .setTimestamp();

  // Server-wide totals as compact code block
  const grid = [
    `**Players:** ${allPlayers.length}  ·  **Deaths:** ${totalDeaths}`,
    `**Builds:** ${totalBuilds}  ·  **Looted:** ${totalLoots}`,
  ];
  if (totalRaids > 0) grid.push(`**Raids:** ${totalRaids}`);
  embed.addFields({ name: 'Server Totals', value: grid.join('\n') });

  // Top 5 most active
  const top5 = allPlayers.slice(0, 5).map((p, i) => {
    const medals = ['🥇', '🥈', '🥉'];
    const medal = medals[i] || `\`${i + 1}.\``;
    const activity = p.deaths + p.builds + p.raidsOut + p.containersLooted;
    return `${medal} **${p.name}** — ${activity} events`;
  });
  if (top5.length > 0) {
    embed.addFields({ name: 'Most Active', value: top5.join('\n') });
  }

  return embed;
}

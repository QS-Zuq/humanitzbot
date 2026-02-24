const { SlashCommandBuilder, EmbedBuilder, AttachmentBuilder, PermissionFlagsBits } = require('discord.js');
const config = require('../config');
const playerMap = require('../player-map');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('map')
    .setDescription('Show player positions on the game map')
    .addSubcommand(sub => sub
      .setName('players')
      .setDescription('Show current/last-known player positions on the map')
      .addBooleanOption(opt => opt.setName('offline').setDescription('Include offline players (default: true)').setRequired(false))
      .addBooleanOption(opt => opt.setName('names').setDescription('Show player names (default: true)').setRequired(false))
    )
    .addSubcommand(sub => sub
      .setName('heatmap')
      .setDescription('Show player activity heatmap')
    )
    .addSubcommand(sub => sub
      .setName('trail')
      .setDescription('Show movement trail for a specific player')
      .addStringOption(opt => opt.setName('player').setDescription('Player name or Steam ID').setRequired(true))
    )
    .addSubcommand(sub => sub
      .setName('stats')
      .setDescription('Show tracking statistics')
    ),

  async execute(interaction) {
    // Check if player map is enabled
    if (!config.enablePlayerMap) {
      return interaction.reply({ content: '🗺️ Player map tracking is not enabled. Set `ENABLE_PLAYER_MAP=true` in your config.', ephemeral: true });
    }

    // Map overlay generation is not yet functional — notify the user
    const sub = interaction.options.getSubcommand();
    if (sub === 'players' || sub === 'heatmap' || sub === 'trail') {
      return interaction.reply({
        content: '🗺️ Map overlay commands are currently under development and not yet working.\nUse `/map stats` to see tracking statistics.',
        ephemeral: true,
      });
    }

    if (sub === 'players') {
      await interaction.deferReply();
      try {
        const showOffline = interaction.options.getBoolean('offline') ?? config.mapShowOffline;
        const showNames = interaction.options.getBoolean('names') ?? config.mapShowNames;

        const buf = await playerMap.generateMapOverlay({
          showOffline,
          showNames,
          width: config.mapWidth,
        });
        if (!buf) {
          return interaction.editReply('❌ Failed to generate map. The map image may not be available.');
        }

        const summary = playerMap.getSummary();
        const attachment = new AttachmentBuilder(buf, { name: 'player-map.png' });
        const embed = new EmbedBuilder()
          .setTitle('🗺️ Player Positions')
          .setColor(0x2ecc71)
          .setImage('attachment://player-map.png')
          .setDescription(`**${summary.online}** online · **${summary.offline}** offline · **${summary.totalPlayers}** tracked`)
          .setFooter({ text: summary.lastUpdated ? `Last save: ${new Date(summary.lastUpdated).toLocaleString('en-GB', { timeZone: config.botTimezone })}` : 'No save data yet' })
          .setTimestamp();

        return interaction.editReply({ embeds: [embed], files: [attachment] });
      } catch (err) {
        console.error('[MAP CMD] Error generating player map:', err);
        return interaction.editReply('❌ Failed to generate player map.');
      }
    }

    if (sub === 'heatmap') {
      await interaction.deferReply();
      try {
        const buf = await playerMap.generateHeatmap({ width: config.mapWidth });
        if (!buf) {
          return interaction.editReply('❌ Failed to generate heatmap. The map image may not be available.');
        }

        const summary = playerMap.getSummary();
        const attachment = new AttachmentBuilder(buf, { name: 'heatmap.png' });
        const embed = new EmbedBuilder()
          .setTitle('🔥 Player Activity Heatmap')
          .setColor(0xe74c3c)
          .setImage('attachment://heatmap.png')
          .setDescription(`**${summary.heatmapCells}** active zones · **${summary.totalPoints}** data points`)
          .setFooter({ text: 'Accumulated from all save file polls' })
          .setTimestamp();

        return interaction.editReply({ embeds: [embed], files: [attachment] });
      } catch (err) {
        console.error('[MAP CMD] Error generating heatmap:', err);
        return interaction.editReply('❌ Failed to generate heatmap.');
      }
    }

    if (sub === 'trail') {
      await interaction.deferReply();
      try {
        const query = interaction.options.getString('player');
        const locations = playerMap.getLocations();

        // Find player by name or Steam ID
        let steamID = null;
        for (const [id, data] of Object.entries(locations)) {
          if (id === query || data.name.toLowerCase() === query.toLowerCase()) {
            steamID = id;
            break;
          }
        }
        // Partial match fallback
        if (!steamID) {
          for (const [id, data] of Object.entries(locations)) {
            if (data.name.toLowerCase().includes(query.toLowerCase())) {
              steamID = id;
              break;
            }
          }
        }

        if (!steamID) {
          return interaction.editReply(`❌ Player "${query}" not found in tracking data.`);
        }

        const player = locations[steamID];
        if (!player.history || player.history.length < 2) {
          return interaction.editReply(`📍 **${player.name}** has only ${player.history?.length || 0} tracked position(s) — not enough for a trail.`);
        }

        const buf = await playerMap.generatePlayerTrail(steamID, { width: config.mapWidth });
        if (!buf) {
          return interaction.editReply('❌ Failed to generate trail image.');
        }

        const attachment = new AttachmentBuilder(buf, { name: 'trail.png' });
        const embed = new EmbedBuilder()
          .setTitle(`🛤️ Movement Trail: ${player.name}`)
          .setColor(0x3498db)
          .setImage('attachment://trail.png')
          .setDescription(`**${player.history.length}** positions tracked\n🟢 Current · 🔵 Start`)
          .setFooter({ text: player.online ? '🟢 Online' : `🔴 Last seen: ${new Date(player.lastSeen).toLocaleString('en-GB', { timeZone: config.botTimezone })}` })
          .setTimestamp();

        return interaction.editReply({ embeds: [embed], files: [attachment] });
      } catch (err) {
        console.error('[MAP CMD] Error generating trail:', err);
        return interaction.editReply('❌ Failed to generate movement trail.');
      }
    }

    if (sub === 'stats') {
      // Admin-only check for coordinates
      if (config.showCoordinatesAdminOnly) {
        const isAdmin = interaction.member?.permissions?.has(PermissionFlagsBits.Administrator);
        if (!isAdmin) {
          return interaction.reply({ content: '🔒 Player map is restricted to administrators.', ephemeral: true });
        }
      }

      const summary = playerMap.getSummary();
      const embed = new EmbedBuilder()
        .setTitle('🗺️ Map Tracking Statistics')
        .setColor(0x9b59b6)
        .addFields(
          { name: '👥 Total Players', value: `${summary.totalPlayers}`, inline: true },
          { name: '🟢 Online', value: `${summary.online}`, inline: true },
          { name: '🔴 Offline', value: `${summary.offline}`, inline: true },
          { name: '🛤️ With History', value: `${summary.withHistory}`, inline: true },
          { name: '📍 Total Points', value: `${summary.totalPoints}`, inline: true },
          { name: '🔥 Heatmap Cells', value: `${summary.heatmapCells}`, inline: true },
        )
        .setFooter({ text: summary.lastUpdated ? `Last update: ${new Date(summary.lastUpdated).toLocaleString('en-GB', { timeZone: config.botTimezone })}` : 'No data yet' })
        .setTimestamp();

      return interaction.reply({ embeds: [embed] });
    }
  },
};

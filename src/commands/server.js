/**
 * /server — Show server info, world state, and difficulty schedule.
 *
 * DB-first: reads from RCON for live data, cached settings from DB.
 * Schedule is the lead feature.
 */

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getServerInfo, getPlayerList } = require('../rcon/server-info');
const gameData = require('../parsers/game-data');
const { buildScheduleField } = require('../server/server-display');
const config = require('../config');

function _randomTip() {
  const tips = gameData.LOADING_TIPS.filter(t => t.length > 20 && t.length < 120);
  return tips.length > 0 ? tips[Math.floor(Math.random() * tips.length)] : null;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('server')
    .setDescription('Show server info, world state, and difficulty schedule'),

  async execute(interaction) {
    await interaction.deferReply();

    try {
      const [info, playerList] = await Promise.all([
        getServerInfo(),
        getPlayerList(),
      ]);

      const tip = _randomTip();
      const embed = new EmbedBuilder()
        .setTitle('🖥️ Server Info')
        .setColor(0x2ecc71)
        .setFooter({ text: tip ? `💡 ${tip}` : 'HumanitZ Server' })
        .setTimestamp();

      // ── 1. Schedule — always first ──
      const schedField = buildScheduleField(config);
      if (schedField) embed.addFields(schedField);

      // ── 2. Server fields from RCON ──
      if (info.fields && Object.keys(info.fields).length > 0) {
        for (const [key, value] of Object.entries(info.fields)) {
          embed.addFields({ name: key, value: value, inline: true });
        }
      }

      // Player count
      const playerCount = info.players != null
        ? (info.maxPlayers ? `${info.players} / ${info.maxPlayers}` : `${info.players}`)
        : `${playerList.count}`;
      embed.addFields({ name: '👥 Online', value: playerCount, inline: true });

      // Online player names
      if (playerList.players?.length > 0) {
        const names = playerList.players.map(p => p.name).join(', ');
        embed.addFields({ name: '🎮 Players', value: names.substring(0, 1024) });
      }

      // If no structured fields, show raw
      if (!info.fields || Object.keys(info.fields).length === 0) {
        const rawText = info.raw?.trim()
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

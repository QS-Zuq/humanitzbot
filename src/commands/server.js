const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getServerInfo, getPlayerList } = require('../server-info');
const gameData = require('../game-data');
const fs = require('fs');
const path = require('path');

const SETTINGS_FILE = path.join(__dirname, '..', '..', 'data', 'server-settings.json');

// Pick a random loading tip for the footer
function _randomTip() {
  const tips = gameData.LOADING_TIPS.filter(t => t.length > 20 && t.length < 120);
  return tips.length > 0 ? tips[Math.floor(Math.random() * tips.length)] : null;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('server')
    .setDescription('Show HumanitZ server world info and player count'),

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

      // If the `info` command returned structured fields, display them all
      if (info.fields && Object.keys(info.fields).length > 0) {
        for (const [key, value] of Object.entries(info.fields)) {
          embed.addFields({ name: key, value: value, inline: true });
        }
      }

      // Always show player count from the Players command
      const playerCount = info.players != null
        ? (info.maxPlayers ? `${info.players} / ${info.maxPlayers}` : `${info.players}`)
        : `${playerList.count}`;
      embed.addFields({ name: '👥 Online Players', value: playerCount, inline: true });

      // If the raw response didn't parse to any fields, show it as-is
      if (!info.fields || Object.keys(info.fields).length === 0) {
        const rawText = info.raw && info.raw.trim()
          ? `\`\`\`\n${info.raw.substring(0, 1000)}\n\`\`\``
          : '_No data returned from server._';
        embed.setDescription(rawText);
      }

      // Show server settings from cached INI if available
      try {
        if (fs.existsSync(SETTINGS_FILE)) {
          const settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
          const interestingKeys = [
            'MaxPlayers', 'ZombiePopulation', 'ZombieDifficulty', 'LootRespawnTime',
            'PvPEnabled', 'FriendlyFire', 'DropItemsOnDeath', 'XPMultiplier',
            'PlayerDamageMultiplier', 'ZombieDamageMultiplier', 'StaminaDrain',
            'HungerDrain', 'ThirstDrain', 'DayNightCycle',
          ];
          const settingLines = [];
          for (const key of interestingKeys) {
            if (settings[key] !== undefined) {
              const label = gameData.SERVER_SETTING_DESCRIPTIONS[key] || key.replace(/([a-z])([A-Z])/g, '$1 $2');
              settingLines.push(`**${label}:** ${settings[key]}`);
            }
          }
          if (settingLines.length > 0) {
            embed.addFields({ name: '⚙️ Server Settings', value: settingLines.join('\n').substring(0, 1024) });
          }
        }
      } catch (_) { /* settings not available yet */ }

      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      console.error('[CMD:server]', err.message);
      await interaction.editReply({
        content: '❌ Could not reach the server. It may be offline or RCON is unavailable.',
      });
    }
  },
};

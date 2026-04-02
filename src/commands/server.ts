/**
 * /server — Show server info, world state, and difficulty schedule.
 *
 * DB-first: reads from RCON for live data, cached settings from DB.
 * Schedule is the lead feature.
 */

import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { getServerInfo, getPlayerList } from '../rcon/server-info.js';
import { LOADING_TIPS } from '../parsers/game-data.js';
import config from '../config/index.js';
import { t, getLocalizations } from '../i18n/index.js';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { buildScheduleField } = require('../server/server-display') as {
  buildScheduleField: (cfg: unknown) => { name: string; value: string; inline?: boolean } | null;
};

function _randomTip(): string | null {
  const tips = LOADING_TIPS.filter((tip) => tip.length > 20 && tip.length < 120);
  return tips.length > 0 ? (tips[Math.floor(Math.random() * tips.length)] ?? null) : null;
}

export const data = new SlashCommandBuilder()
  .setName('server')
  .setNameLocalizations(getLocalizations('commands:server.name'))
  .setDescription(t('commands:server.description', 'en'))
  .setDescriptionLocalizations(getLocalizations('commands:server.description'));

export async function execute(interaction: import('discord.js').ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply();
  const locale = interaction.locale;

  try {
    const [info, playerList] = await Promise.all([getServerInfo(), getPlayerList()]);

    const tip = _randomTip();
    const embed = new EmbedBuilder()
      .setTitle(t('commands:server.embeds.title', locale))
      .setColor(0x2ecc71)
      .setFooter({
        text: tip
          ? t('commands:server.embeds.tip_footer', locale, { tip })
          : t('commands:server.embeds.footer', locale),
      })
      .setTimestamp();

    // Schedule always first
    const schedField = buildScheduleField(config);
    if (schedField) embed.addFields(schedField);

    // Server fields from RCON
    if (Object.keys(info.fields).length > 0) {
      for (const [key, value] of Object.entries(info.fields)) {
        embed.addFields({ name: key, value, inline: true });
      }
    }

    const playerCount =
      info.players != null
        ? info.maxPlayers != null
          ? `${String(info.players)} / ${String(info.maxPlayers)}`
          : String(info.players)
        : String(playerList.count);
    embed.addFields({ name: t('commands:server.embeds.online_field', locale), value: playerCount, inline: true });

    if (playerList.players.length > 0) {
      const names = playerList.players.map((p) => p.name).join(', ');
      embed.addFields({ name: t('commands:server.embeds.players_field', locale), value: names.substring(0, 1024) });
    }

    if (Object.keys(info.fields).length === 0) {
      const rawText = info.raw.trim()
        ? `\`\`\`\n${info.raw.substring(0, 1000)}\n\`\`\``
        : t('commands:server.reply.no_data_returned', locale);
      embed.setDescription(rawText);
    }

    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    console.error('[CMD:server]', (err as Error).message);
    await interaction.editReply({
      content: t('commands:server.reply.unreachable', locale),
    });
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _mod = module as { exports: any };
_mod.exports = { data, execute };

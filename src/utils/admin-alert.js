/**
 * Admin alert helper — sends embeds to all configured admin alert channels.
 *
 * Follows the multi-channel pattern from chat-relay.js with a single-channel
 * fallback.  Best-effort — never throws.
 */

'use strict';

/**
 * Send an embed to all configured admin alert channels.
 * Falls back to a single fallback channel if no alert channels are configured.
 *
 * @param {import('discord.js').Client} client
 * @param {import('discord.js').EmbedBuilder} embed
 * @param {object} opts
 * @param {string[]} [opts.adminAlertChannelIds]
 * @param {string}   [opts.fallbackChannelId]
 */
async function postAdminAlert(client, embed, opts = {}) {
  const channelIds =
    opts.adminAlertChannelIds?.length > 0
      ? opts.adminAlertChannelIds
      : opts.fallbackChannelId
        ? [opts.fallbackChannelId]
        : [];

  for (const channelId of channelIds) {
    try {
      const ch = await client.channels.fetch(channelId);
      if (ch) {
        await Promise.race([ch.send({ embeds: [embed] }), new Promise((resolve) => setTimeout(resolve, 3000))]);
      }
    } catch (_) {
      /* best-effort */
    }
  }
}

module.exports = { postAdminAlert };

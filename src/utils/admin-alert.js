/**
 * Admin alert helper — sends embeds to all configured admin alert channels.
 *
 * Iterates over alert channel IDs with a single-channel fallback.
 * Best-effort — never throws.
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
      if (!ch) {
        console.warn(`[ADMIN-ALERT] Channel ${channelId} not found or not accessible — skipping alert`);
        continue;
      }
      const sendPromise = ch.send({ embeds: [embed] });
      await Promise.race([sendPromise, new Promise((resolve) => setTimeout(resolve, 3000))]);
      // Prevent unhandled rejection if send rejects after the timeout won the race
      sendPromise.catch(() => {});
    } catch (sendErr) {
      console.warn(`[ADMIN-ALERT] Failed to send alert to channel ${channelId}:`, sendErr.message);
    }
  }
}

module.exports = { postAdminAlert };

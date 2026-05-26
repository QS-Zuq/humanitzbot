/**
 * Admin alert helper — sends embeds to all configured admin alert channels.
 *
 * Iterates over alert channel IDs with a single-channel fallback.
 * Best-effort — never throws.
 */

import type { Client, EmbedBuilder, SendableChannels } from 'discord.js';

interface AdminAlertOpts {
  adminAlertChannelIds?: string[] | string;
  fallbackChannelId?: string;
}

/**
 * Send an embed to all configured admin alert channels.
 * Falls back to a single fallback channel if no alert channels are configured.
 */
export async function postAdminAlert(client: Client, embed: EmbedBuilder, opts: AdminAlertOpts = {}): Promise<void> {
  // Normalize: if adminAlertChannelIds is a string (e.g. from DB live-apply), split into array
  let alertIds = opts.adminAlertChannelIds;
  if (typeof alertIds === 'string') {
    alertIds = alertIds
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const channelIds =
    alertIds && alertIds.length > 0 ? alertIds : opts.fallbackChannelId ? [opts.fallbackChannelId] : [];

  if (channelIds.length === 0) {
    console.warn('[ADMIN-ALERT] No alert channels configured — embed discarded. Set ADMIN_ALERT_CHANNEL_IDS in .env');
    return;
  }

  for (const channelId of channelIds) {
    try {
      const ch = await client.channels.fetch(channelId);
      if (!ch) {
        console.warn(`[ADMIN-ALERT] Channel ${channelId} not found or not accessible — skipping alert`);
        continue;
      }
      const sendPromise = (ch as SendableChannels).send({ embeds: [embed] });
      await Promise.race([sendPromise, new Promise((resolve) => setTimeout(resolve, 3000))]);
      // Prevent unhandled rejection if send rejects after the timeout won the race
      sendPromise.catch(() => {});
    } catch (sendErr) {
      const msg = sendErr instanceof Error ? sendErr.message : String(sendErr);
      console.warn(`[ADMIN-ALERT] Failed to send alert to channel ${channelId}:`, msg);
    }
  }
}

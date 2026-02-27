/**
 * Shared Discord utilities for all modules.
 *
 * Deduplicates common patterns:
 *   - _cleanOwnMessages() — delete previous bot embeds before posting fresh
 *   - embedContentKey()    — content hash for skip-if-unchanged logic
 *   - safeEditMessage()    — resilient message edit with re-create fallback
 */

// ═══════════════════════════════════════════════════════════════════════════
//  Clean own messages
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Delete bot's previous messages from a channel.
 *
 * Strategy: try saved message IDs first (fast, single API call each).
 * If any saved ID is stale (10008 Unknown Message), fall back to a
 * bulk sweep of the last `limit` messages — deleting ALL from the bot.
 * Per post-mortem rules: no timestamp filtering, no bootTime checks.
 *
 * @param {import('discord.js').TextChannel} channel
 * @param {import('discord.js').Client} client
 * @param {object} [options]
 * @param {string|string[]} [options.savedIds]  - Previously stored message IDs
 * @param {number}          [options.limit=20]  - Bulk fetch limit for sweep
 * @param {string}          [options.label='']  - Log prefix
 */
async function cleanOwnMessages(channel, client, options = {}) {
  const { savedIds: rawIds, limit = 20, label = 'UTIL' } = options;
  const savedIds = rawIds
    ? (Array.isArray(rawIds) ? rawIds : [rawIds]).filter(Boolean)
    : [];

  let allFound = savedIds.length > 0;

  if (savedIds.length > 0) {
    for (const savedId of savedIds) {
      try {
        const msg = await channel.messages.fetch(savedId);
        if (msg && msg.author.id === client.user.id) {
          await msg.delete();
          console.log(`[${label}] Cleaned previous message ${savedId}`);
        }
      } catch (err) {
        if (err.code === 10008) {
          allFound = false; // message gone — need bulk sweep
        } else {
          console.log(`[${label}] Could not clean saved message:`, err.message);
        }
      }
    }
    if (allFound) return; // all saved messages found and deleted
    console.log(`[${label}] Some saved messages already gone, sweeping channel...`);
  }

  // No saved IDs, or some were stale — sweep ALL old bot messages
  try {
    const messages = await channel.messages.fetch({ limit });
    const botMessages = messages.filter(m => m.author.id === client.user.id);
    if (botMessages.size > 0) {
      console.log(`[${label}] Cleaning ${botMessages.size} old bot message(s)`);
      for (const [, msg] of botMessages) {
        try { await msg.delete(); } catch (_) {}
      }
    }
  } catch (err) {
    console.log(`[${label}] Could not clean old messages:`, err.message);
  }
}


// ═══════════════════════════════════════════════════════════════════════════
//  Content hashing (skip-if-unchanged)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Generate a content key for an embed + optional components payload.
 * Used to skip redundant Discord API edits when nothing changed.
 *
 * @param {import('discord.js').EmbedBuilder|import('discord.js').EmbedBuilder[]} embeds
 * @param {import('discord.js').ActionRowBuilder[]} [components]
 * @returns {string}
 */
function embedContentKey(embeds, components) {
  const embedArr = Array.isArray(embeds) ? embeds : [embeds];
  let key = JSON.stringify(embedArr.map(e => e.data));
  if (components && components.length > 0) {
    key += JSON.stringify(components.map(c => c.toJSON()));
  }
  return key;
}


// ═══════════════════════════════════════════════════════════════════════════
//  Safe message edit with re-create fallback
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Edit a Discord message, or re-create it if it was deleted (10008).
 *
 * @param {import('discord.js').Message} message - The message to edit
 * @param {import('discord.js').TextChannel} channel - Channel to re-create in
 * @param {object} payload - { embeds, components, content }
 * @param {object} [options]
 * @param {string} [options.label='']
 * @param {function} [options.onRecreate] - Called with new message after re-create: (newMsg) => {}
 * @returns {Promise<import('discord.js').Message>} The (possibly new) message
 */
async function safeEditMessage(message, channel, payload, options = {}) {
  const { label = 'UTIL', onRecreate } = options;
  try {
    await message.edit(payload);
    return message;
  } catch (err) {
    if (err.code === 10008) {
      console.log(`[${label}] Message was deleted, re-creating...`);
      try {
        const newMsg = await channel.send(payload);
        if (typeof onRecreate === 'function') onRecreate(newMsg);
        return newMsg;
      } catch (createErr) {
        console.error(`[${label}] Failed to re-create message:`, createErr.message);
        throw createErr;
      }
    }
    throw err;
  }
}


module.exports = { cleanOwnMessages, embedContentKey, safeEditMessage };

/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any */

/**
 * Shared Discord utilities for all modules.
 *
 * Deduplicates common patterns:
 *   - _cleanOwnMessages() — delete previous bot embeds before posting fresh
 *   - embedContentKey()    — content hash for skip-if-unchanged logic
 *   - safeEditMessage()    — resilient message edit with re-create fallback
 */
import { createLogger } from '../utils/log.js';

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
async function cleanOwnMessages(channel: any, client: any, options: any = {}) {
  const { savedIds: rawIds, limit = 20, label = 'UTIL' } = options;
  const log = createLogger(label, 'UTIL');
  const savedIds = rawIds ? (Array.isArray(rawIds) ? rawIds : [rawIds]).filter(Boolean) : [];

  let allFound = savedIds.length > 0;

  if (savedIds.length > 0) {
    for (const savedId of savedIds) {
      try {
        const msg = await channel.messages.fetch(savedId);
        if (msg && msg.author.id === client.user.id) {
          await msg.delete();
          log.info(`Cleaned previous message ${savedId}`);
        }
      } catch (err: any) {
        if (err.code === 10008) {
          allFound = false; // message gone — need bulk sweep
        } else {
          log.info('Could not clean saved message:', err.message);
        }
      }
    }
    if (allFound) return; // all saved messages found and deleted
    log.info('Some saved messages already gone, sweeping channel...');
  }

  // No saved IDs, or some were stale — sweep ALL old bot messages
  try {
    const messages = await channel.messages.fetch({ limit });
    const botMessages = messages.filter((m: any) => m.author.id === client.user.id);
    if (botMessages.size > 0) {
      log.info(`Cleaning ${botMessages.size} old bot message(s)`);
      for (const [, msg] of botMessages) {
        try {
          await msg.delete();
        } catch (_: any) {}
      }
    }
  } catch (err: any) {
    log.info('Could not clean old messages:', err.message);
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
function embedContentKey(embeds: any, components?: any) {
  const embedArr = Array.isArray(embeds) ? embeds : [embeds];
  let key = JSON.stringify(embedArr.map((e: any) => e.data));
  if (components && components.length > 0) {
    key += JSON.stringify(components.map((c: any) => c.toJSON()));
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
 * @param {function} [options.onRecreate] - Called with new message after re-create: (newMsg: any) => {}
 * @returns {Promise<import('discord.js').Message>} The (possibly new) message
 */
async function safeEditMessage(message: any, channel: any, payload: any, options: any = {}) {
  const { label = 'UTIL', onRecreate } = options;
  const log = createLogger(label, 'UTIL');
  try {
    await message.edit(payload);
    return message;
  } catch (err: any) {
    if (err.code === 10008) {
      log.info('Message was deleted, re-creating...');
      try {
        const newMsg = await channel.send(payload);
        if (typeof onRecreate === 'function') onRecreate(newMsg);
        return newMsg;
      } catch (createErr: any) {
        log.error('Failed to re-create message:', createErr.message);
        throw createErr;
      }
    }
    throw err;
  }
}

/**
 * Safely build a modal title within Discord's 45-char limit.
 * Truncates `name` with '…' if needed.  Handles surrogate pairs by
 * slicing at the character level (Array.from) so emoji are not split.
 * @param {string} prefix
 * @param {string} name
 * @param {string} suffix
 * @returns {string}
 */
function modalTitle(prefix: any, name: any, suffix: any) {
  const maxName = 45 - prefix.length - suffix.length;
  if (maxName <= 0) return `${prefix}${suffix}`.slice(0, 45);
  const chars = Array.from(name);
  const truncated = chars.length > maxName ? chars.slice(0, maxName - 1).join('') + '…' : name;
  return `${prefix}${truncated}${suffix}`;
}

export { cleanOwnMessages, embedContentKey, safeEditMessage, modalTitle };

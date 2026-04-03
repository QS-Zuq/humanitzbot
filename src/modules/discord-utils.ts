/**
 * Shared Discord utilities for all modules.
 *
 * Deduplicates common patterns:
 *   - _cleanOwnMessages() — delete previous bot embeds before posting fresh
 *   - embedContentKey()    — content hash for skip-if-unchanged logic
 *   - safeEditMessage()    — resilient message edit with re-create fallback
 */
import type { Client, EmbedBuilder, Message, TextBasedChannel, ActionRowBuilder } from 'discord.js';
import { createLogger } from '../utils/log.js';
import { errMsg } from '../utils/error.js';

interface DiscordError extends Error {
  code?: number;
}

type FetchableChannel = TextBasedChannel & {
  messages: {
    fetch(
      idOrOpts: string | { limit: number },
    ): Promise<Map<string, Message> & { filter(fn: (m: Message) => boolean): Map<string, Message> & { size: number } }>;
  };
};

// ═══════════════════════════════════════════════════════════════════════════
//  Clean own messages
// ═══════════════════════════════════════════════════════════════════════════

interface CleanOptions {
  savedIds?: string | string[];
  limit?: number;
  label?: string;
}

/**
 * Delete bot's previous messages from a channel.
 *
 * Strategy: try saved message IDs first (fast, single API call each).
 * If any saved ID is stale (10008 Unknown Message), fall back to a
 * bulk sweep of the last `limit` messages — deleting ALL from the bot.
 * Per post-mortem rules: no timestamp filtering, no bootTime checks.
 */
async function cleanOwnMessages(channel: FetchableChannel, client: Client, options: CleanOptions = {}) {
  const { savedIds: rawIds, limit = 20, label = 'UTIL' } = options;
  const log = createLogger(label, 'UTIL');
  const savedIds: string[] = rawIds != null ? (Array.isArray(rawIds) ? rawIds : [rawIds]).filter(Boolean) : [];
  const botUserId = client.user?.id;

  let allFound = savedIds.length > 0;

  if (savedIds.length > 0) {
    for (const savedId of savedIds) {
      try {
        const msg = (await channel.messages.fetch(savedId)) as unknown as Message;
        if (msg.author.id === botUserId) {
          await msg.delete();
          log.info(`Cleaned previous message ${savedId}`);
        }
      } catch (err: unknown) {
        const dErr = err as DiscordError;
        if (dErr.code === 10008) {
          allFound = false; // message gone — need bulk sweep
        } else {
          log.info('Could not clean saved message:', dErr.message);
        }
      }
    }
    if (allFound) return; // all saved messages found and deleted
    log.info('Some saved messages already gone, sweeping channel...');
  }

  // No saved IDs, or some were stale — sweep ALL old bot messages
  try {
    const messages = await channel.messages.fetch({ limit });
    const botMessages = messages.filter((m: Message) => m.author.id === botUserId);
    if (botMessages.size > 0) {
      log.info(`Cleaning ${botMessages.size} old bot message(s)`);
      for (const [, msg] of botMessages) {
        try {
          await msg.delete();
        } catch {
          // ignore delete failures
        }
      }
    }
  } catch (err: unknown) {
    log.info('Could not clean old messages:', errMsg(err));
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  Content hashing (skip-if-unchanged)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Generate a content key for an embed + optional components payload.
 * Used to skip redundant Discord API edits when nothing changed.
 */
function embedContentKey(embeds: EmbedBuilder | EmbedBuilder[], components?: ActionRowBuilder[]) {
  const embedArr = Array.isArray(embeds) ? embeds : [embeds];
  let key = JSON.stringify(embedArr.map((e: EmbedBuilder) => e.data));
  if (components && components.length > 0) {
    key += JSON.stringify(components.map((c: ActionRowBuilder) => c.toJSON()));
  }
  return key;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Safe message edit with re-create fallback
// ═══════════════════════════════════════════════════════════════════════════

interface SafeEditOptions {
  label?: string;
  onRecreate?: (newMsg: Message) => void;
}

interface MessagePayload {
  embeds?: EmbedBuilder[];
  components?: ActionRowBuilder[];
  content?: string;
}

/**
 * Edit a Discord message, or re-create it if it was deleted (10008).
 */
async function safeEditMessage(
  message: Message,
  channel: TextBasedChannel,
  payload: MessagePayload,
  options: SafeEditOptions = {},
): Promise<Message> {
  const { label = 'UTIL', onRecreate } = options;
  const log = createLogger(label, 'UTIL');
  try {
    await message.edit(payload as Parameters<Message['edit']>[0]);
    return message;
  } catch (err: unknown) {
    const dErr = err as DiscordError;
    if (dErr.code === 10008) {
      log.info('Message was deleted, re-creating...');
      try {
        const newMsg: Message = await (channel as unknown as { send(p: MessagePayload): Promise<Message> }).send(
          payload,
        );
        if (typeof onRecreate === 'function') onRecreate(newMsg);
        return newMsg;
      } catch (createErr: unknown) {
        log.error('Failed to re-create message:', (createErr as Error).message);
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
 */
function modalTitle(prefix: string, name: string, suffix: string) {
  const maxName = 45 - prefix.length - suffix.length;
  if (maxName <= 0) return `${prefix}${suffix}`.slice(0, 45);
  const chars = Array.from(name);
  const truncated = chars.length > maxName ? chars.slice(0, maxName - 1).join('') + '…' : name;
  return `${prefix}${truncated}${suffix}`;
}

export { cleanOwnMessages, embedContentKey, safeEditMessage, modalTitle };

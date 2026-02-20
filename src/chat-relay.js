const { Events, EmbedBuilder } = require('discord.js');
const config = require('./config');
const rcon = require('./rcon');

/**
 * Bidirectional Chat Bridge:
 *
 * 1. INBOUND  — polls `fetchchat` via RCON every few seconds, parses the
 *               HumanitZ markup format, diffs against previous snapshot,
 *               and relays new player messages / join / leave / death events
 *               into a daily "💬 Chat Log" thread in the admin channel.
 *
 * 2. OUTBOUND — listens for Discord messages in the admin channel and sends
 *               them to the server as [Admin] using the `admin` RCON command.
 *
 * !admin alerts are posted in the daily chat thread (with @here ping).
 */

// ── Chat line parsers ────────────────────────────────────────
// Player chat:   <PN>PlayerName:</>Message text
const CHAT_RE = /^<PN>(.+?):<\/>(.+)$/;
// Player joined: Player Joined (<PN>PlayerName</>)
const JOIN_RE = /^Player Joined \(<PN>(.+?)<\/>\)$/;
// Player left:   Player Left (<PN>PlayerName</>)
const LEFT_RE = /^Player Left \(<PN>(.+?)<\/>\)$/;
// Player died:   Player Died (<PN>PlayerName</>)
const DIED_RE = /^Player Died \(<PN>(.+?)<\/>\)$/;
// Admin message — skip echoing these back (we sent them)
const ADMIN_RE = /^\[Admin\]/;

class ChatRelay {
  constructor(client) {
    this.client = client;
    this.adminChannel = null;
    this._lastLines = [];      // snapshot for diff
    this._pollTimer = null;
    this._chatThread = null;   // daily chat thread
    this._chatThreadDate = null;
  }

  async start() {
    try {
      // ── Admin channel (home for threads + outbound bridge) ──
      const chatId = config.chatChannelId || config.adminChannelId;
      if (!chatId) {
        console.log('[CHAT] No ADMIN_CHANNEL_ID or CHAT_CHANNEL_ID configured, skipping chat relay.');
        return;
      }
      this.adminChannel = await this.client.channels.fetch(chatId);
      if (!this.adminChannel) {
        console.error('[CHAT] Chat channel not found! Check ADMIN_CHANNEL_ID / CHAT_CHANNEL_ID.');
        return;
      }

      console.log(`[CHAT] Admin bridge: #${this.adminChannel.name} → server`);
      console.log(`[CHAT] Chat relay:   server → daily thread in #${this.adminChannel.name}`);

      // Create / find today's chat thread
      await this._getOrCreateChatThread();

      // Listen for outbound admin messages
      this.client.on(Events.MessageCreate, async (message) => {
        await this._onMessage(message);
      });

      // Start polling fetchchat
      const pollMs = config.chatPollInterval || 10000;
      this._pollTimer = setInterval(() => this._pollChat(), pollMs);
      console.log(`[CHAT] Polling fetchchat every ${pollMs / 1000}s`);
    } catch (err) {
      console.error('[CHAT] Failed to start:', err.message);
    }
  }

  stop() {
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
    console.log('[CHAT] Stopped.');
  }

  // ── Daily chat thread management ───────────────────────────

  async _getOrCreateChatThread() {
    const today = config.getToday(); // timezone-aware 'YYYY-MM-DD'

    // Already have today's thread
    if (this._chatThread && this._chatThreadDate === today) {
      return this._chatThread;
    }

    const dateLabel = config.getDateLabel();
    const threadName = `💬 Chat Log — ${dateLabel}`;

    try {
      // Check active threads
      const active = await this.adminChannel.threads.fetchActive();
      const existing = active.threads.find(t => t.name === threadName);
      if (existing) {
        this._chatThread = existing;
        this._chatThreadDate = today;
        console.log(`[CHAT] Using existing thread: ${threadName}`);
        return this._chatThread;
      }

      // Check archived threads (in case bot restarted mid-day)
      const archived = await this.adminChannel.threads.fetchArchived({ limit: 5 });
      const archivedMatch = archived.threads.find(t => t.name === threadName);
      if (archivedMatch) {
        await archivedMatch.setArchived(false);
        this._chatThread = archivedMatch;
        this._chatThreadDate = today;
        console.log(`[CHAT] Unarchived existing thread: ${threadName}`);
        return this._chatThread;
      }
    } catch (err) {
      console.warn('[CHAT] Could not search for threads:', err.message);
    }

    // Create a new thread (from a starter message so it appears inline in the channel)
    try {
      const starterMsg = await this.adminChannel.send({
        embeds: [
          new EmbedBuilder()
            .setTitle(`💬 Chat Log — ${dateLabel}`)
            .setDescription('All in-game chat messages for today are logged in this thread.')
            .setColor(0x3498db)
            .setTimestamp(),
        ],
      });
      this._chatThread = await starterMsg.startThread({
        name: threadName,
        autoArchiveDuration: 1440,
        reason: 'Daily chat log thread',
      });
      this._chatThreadDate = today;
      console.log(`[CHAT] Created daily thread: ${threadName}`);

      // Auto-join admin users so the thread stays visible for them
      for (const uid of config.adminUserIds) {
        this._chatThread.members.add(uid).catch(() => {});
      }
    } catch (err) {
      console.error('[CHAT] Failed to create chat thread:', err.message);
    }

    return this._chatThread;
  }

  // ── Inbound: fetchchat → Discord thread ────────────────────

  async _pollChat() {
    try {
      const raw = await rcon.send('fetchchat');
      if (!raw || !raw.trim()) return;

      const currentLines = raw.split('\n').map(l => l.trim()).filter(Boolean);
      const newLines = this._diff(currentLines);
      this._lastLines = currentLines;

      if (newLines.length === 0) return;

      // Ensure we have today's thread
      const thread = await this._getOrCreateChatThread();

      for (const line of newLines) {
        const msg = this._formatLine(line);
        if (msg && thread) {
          await thread.send(msg);
        }

        // Check for !admin command (posts to main channel, not thread)
        await this._checkAdminCall(line);
      }
    } catch (err) {
      // Don't spam on RCON issues — the RCON module already logs
      if (!err.message.includes('not connected') && !err.message.includes('No response')) {
        console.error('[CHAT] Poll error:', err.message);
      }
    }
  }

  /**
   * Diff two snapshots — return only lines that are new.
   * Uses reverse search so that duplicate lines (e.g. same player
   * saying the same thing) aren't lost.
   */
  _diff(currentLines) {
    if (this._lastLines.length === 0) {
      // First poll — don't replay the whole buffer
      return [];
    }

    // Find where the old snapshot ends in the new one
    // Walk backward through old lines to find the last matching line
    const lastOld = this._lastLines[this._lastLines.length - 1];
    let splitIdx = -1;

    // Search from end of current lines backwards for the last old line
    for (let i = currentLines.length - 1; i >= 0; i--) {
      if (currentLines[i] === lastOld) {
        // Verify the preceding lines match too (avoid false positives)
        let match = true;
        for (let j = 1; j <= Math.min(2, this._lastLines.length - 1); j++) {
          if (i - j < 0 || currentLines[i - j] !== this._lastLines[this._lastLines.length - 1 - j]) {
            match = false;
            break;
          }
        }
        if (match) {
          splitIdx = i;
          break;
        }
      }
    }

    if (splitIdx === -1) {
      // No overlap found — entire response is new (or buffer rotated)
      return currentLines;
    }

    return currentLines.slice(splitIdx + 1);
  }

  // ── !admin command detection ────────────────────────────────

  /**
   * Check if a player is calling for admin help via !admin.
   * Sends an alert embed to the MAIN admin channel (not the thread).
   */
  async _checkAdminCall(line) {
    const m = CHAT_RE.exec(line);
    if (!m) return;

    const name = m[1].trim();
    const text = m[2].trim();

    // Match !admin with optional message
    const adminMatch = text.match(/^!admin\s*(.*)/i);
    if (!adminMatch) return;

    const reason = adminMatch[1] || 'No reason given';
    console.log(`[CHAT] !admin call from ${name}: ${reason}`);

    // Alert in the daily chat thread (with @here so admins are notified)
    const embed = new EmbedBuilder()
      .setTitle('🚨 Admin Assistance Requested')
      .setColor(0xe74c3c)
      .addFields(
        { name: 'Player', value: name, inline: true },
        { name: 'Reason', value: reason, inline: true },
      )
      .setTimestamp();

    try {
      const thread = await this._getOrCreateChatThread();
      if (thread) {
        await thread.send({
          content: '@here',
          embeds: [embed],
        });
      } else {
        await this.adminChannel.send({
          content: '@here',
          embeds: [embed],
        });
      }
    } catch (err) {
      console.error('[CHAT] Failed to send admin alert:', err.message);
    }

    // Acknowledge in-game
    try {
      await rcon.send(`admin [Bot] ${name}, your request has been sent to the admins. Join our Discord for faster help: ${config.discordInviteLink}`);
    } catch (_) {}
  }

  /**
   * Parse a single chat line into a Discord-ready string.
   * Returns null for lines we don't want to relay.
   */
  _formatLine(line) {
    // Skip admin message echo
    if (ADMIN_RE.test(line)) return null;

    // Player chat
    let m = CHAT_RE.exec(line);
    if (m) {
      const name = m[1].trim();
      const text = this._sanitize(m[2].trim());
      return `💬 **${name}:** ${text}`;
    }

    // Player joined
    m = JOIN_RE.exec(line);
    if (m) return `📥 **${m[1]}** joined the server`;

    // Player left
    m = LEFT_RE.exec(line);
    if (m) return `📤 **${m[1]}** left the server`;

    // Player died
    m = DIED_RE.exec(line);
    if (m) return `💀 **${m[1]}** died`;

    // Unknown format — skip silently
    return null;
  }

  /** Sanitize text to prevent @mention abuse and markdown injection */
  _sanitize(text) {
    return text
      .replace(/@everyone/g, '@\u200beveryone')
      .replace(/@here/g, '@\u200bhere')
      .replace(/<@!?(\d+)>/g, '@user')
      .replace(/<@&(\d+)>/g, '@role')
      // Escape Discord markdown characters to prevent formatting injection
      .replace(/([*_~`|\\])/g, '\\$1');
  }

  // ── Outbound: Discord → [Admin] in-game ────────────────────

  async _onMessage(message) {
    if (message.author.bot) return;
    if (message.channelId !== this.adminChannel.id) return;
    if (!message.content || message.content.trim() === '') return;

    try {
      let text = message.content.trim();
      // Limit message length to prevent oversized RCON commands
      if (text.length > 500) {
        text = text.substring(0, 500);
      }
      await rcon.send(`admin ${text}`);
      await message.react('✅');
    } catch (err) {
      console.error('[CHAT] Failed to relay admin message:', err.message);
      await message.react('❌');
    }
  }
}

module.exports = ChatRelay;

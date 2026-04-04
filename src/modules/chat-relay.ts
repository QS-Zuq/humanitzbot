import {
  Events,
  EmbedBuilder,
  type Client,
  type TextChannel,
  type ThreadChannel,
  type Guild,
  type Message,
} from 'discord.js';
import _defaultConfig from '../config/index.js';
import _defaultRcon from '../rcon/rcon.js';
import { t, getLocale } from '../i18n/index.js';
import { createLogger, type Logger } from '../utils/log.js';
import { errMsg } from '../utils/error.js';

// Data-layer parser: regexes, line parsing, diffing, sanitisation
import * as chatParser from './chat-relay-parser.js';
const { stripAdminPrefix, CHAT_RE, PLAIN_CHAT_RE } = chatParser;

type ConfigType = typeof _defaultConfig;
type RconType = typeof _defaultRcon;

interface ChatEntry {
  type: string;
  playerName: string | undefined;
  message: string;
  direction: string;
  discordUser?: string;
  isAdmin: boolean;
}

interface ParsedLine {
  formatted: string;
  entry: ChatEntry;
}

interface ThreadLike {
  send(options: unknown): Promise<Message>;
  name?: string;
  archived?: boolean;
  id?: string;
  guild?: unknown;
  threads?: unknown;
  messages?: { fetch(options: { limit: number }): Promise<Map<string, Message>> };
  setArchived?(archived: boolean): Promise<unknown>;
}

interface ChatRelayDeps {
  config?: ConfigType;
  rcon?: RconType;
  db?: ChatRelayDB | null;
  label?: string;
}

interface ChatRelayDB {
  insertChat(entry: Record<string, unknown>): void;
}

class ChatRelay {
  private client: Client;
  private _config: ConfigType;
  private _rcon: RconType;
  private _db: ChatRelayDB | null;
  private _log: Logger;
  private adminChannel: ThreadLike | null;
  _lastLines: string[];
  private _pollTimer: ReturnType<typeof setInterval> | null;
  private _chatThread: ThreadLike | null;
  private _chatThreadDate: string | null;
  private _boundOnMessage: ((message: Message) => void) | null;
  private _rolloverPending: boolean;
  private _rolloverFallback: ReturnType<typeof setTimeout> | null;
  _nukeActive: boolean;
  private _healthy: boolean;
  private _headless: boolean;
  private _locale: string;
  private _logChatWarned: boolean;
  _awaitActivityThread: boolean;

  // Mixed-in from chat-relay-parser.ts via Object.assign
  declare _parseLine: (this: ChatRelay, line: string) => ParsedLine | null;
  declare _formatLine: (this: ChatRelay, line: string) => string | null;
  declare _diff: (this: ChatRelay, currentLines: string[]) => string[];
  declare _sanitize: (this: ChatRelay, text: string) => string;
  declare _sanitizeRcon: (this: ChatRelay, text: string) => string;

  constructor(client: Client, deps: ChatRelayDeps = {}) {
    this.client = client;
    this._config = deps.config ?? _defaultConfig;
    this._rcon = deps.rcon ?? _defaultRcon;
    this._db = deps.db ?? null;
    this._log = createLogger(deps.label, 'CHAT RELAY');
    this.adminChannel = null;
    this._lastLines = []; // snapshot for diff
    this._pollTimer = null;
    this._chatThread = null; // daily chat thread
    this._chatThreadDate = null;
    this._boundOnMessage = null; // stored listener ref for cleanup
    this._rolloverPending = false; // true = waiting for activity thread before creating chat thread
    this._rolloverFallback = null; // safety timer if LogWatcher callback never fires
    this._nukeActive = false; // true during NUKE_BOT — suppresses thread creation
    this._healthy = true; // false if start() failed — module appears active but isn't
    this._headless = false; // true when running without a Discord channel (DB-only data collection)
    this._locale = getLocale({ serverConfig: this._config });
    this._logChatWarned = false;
    this._awaitActivityThread = false;
  }

  /** Whether the chat relay started successfully. */
  get healthy() {
    return this._healthy;
  }

  async start() {
    try {
      // ── Admin channel (home for threads + outbound bridge) ──
      const chatId = this._config.chatChannelId || this._config.adminChannelId;
      if (!chatId) {
        // No Discord channel — run in headless mode (RCON polling + DB writes only).
        // Used by multi-server instances that only serve the web panel.
        this._headless = true;
        this._log.info('No CHAT_CHANNEL_ID — running in headless mode (DB-only, no Discord posting)');
      }

      if (!this._headless) {
        this.adminChannel = (await this.client.channels.fetch(chatId as string)) as ThreadLike | null;
        if (!this.adminChannel) {
          this._log.error('Chat channel not found! Check ADMIN_CHANNEL_ID / CHAT_CHANNEL_ID.');
          this._healthy = false;
          return;
        }

        this._log.info(`Admin bridge: #${String(this.adminChannel.name)} → server`);
        this._log.info(
          `Chat relay:   server → ${this._config.useChatThreads ? 'daily thread in' : ''} #${String(this.adminChannel.name)}`,
        );

        // Clean old bot starter messages (keep the channel tidy across restarts)
        await this._cleanOldMessages();

        // Create / find today's chat thread (or use channel directly)
        // During NUKE_BOT, defer thread creation — nuke phase 2 will recreate it
        // after activity threads and Bot Online embed so it appears in the right order.
        if (!this._config.nukeBot) {
          await this._getOrCreateChatThread();
        }

        // Listen for outbound admin messages
        this._boundOnMessage = (message: Message) => {
          void this._onMessage(message);
        };
        this.client.on(Events.MessageCreate, this._boundOnMessage);
      }

      // Start polling fetchchat (works in both normal and headless mode)
      const pollMs = this._config.chatPollInterval || 10000;
      this._pollTimer = setInterval(() => void this._pollChat(), pollMs);
      this._log.info(`Polling fetchchat every ${pollMs / 1000}s`);
    } catch (err: unknown) {
      this._healthy = false;
      this._log.error('Failed to start:', errMsg(err));
    }
  }

  stop() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
    if (this._boundOnMessage) {
      this.client.removeListener(Events.MessageCreate, this._boundOnMessage);
      this._boundOnMessage = null;
    }
    this._log.info('Stopped.');
  }

  /**
   * Delete old bot-posted starter messages (embeds without a thread) so the
   * channel stays clean across restarts. Keeps messages that have threads
   * attached (today's or historical).
   */
  async _cleanOldMessages() {
    // Only delete messages older than this process start to avoid wiping
    // sibling multi-server messages posted earlier in this same startup.
    const bootTime = Date.now() - process.uptime() * 1000;
    try {
      const channel = this.adminChannel as ThreadLike;
      if (!channel.messages) return;
      const messages = await channel.messages.fetch({ limit: 20 });
      const botId = this.client.user?.id;
      if (!botId) return;
      const botMessages = [...messages.values()].filter(
        (m: Message) => m.author.id === botId && !m.hasThread && m.createdTimestamp < bootTime,
      );
      if (botMessages.length > 0) {
        this._log.info(`Cleaning ${botMessages.length} orphaned bot message(s)`);
        for (const msg of botMessages) {
          try {
            await msg.delete();
          } catch (_: unknown) {}
        }
      }
    } catch (err: unknown) {
      this._log.info('Could not clean old messages:', errMsg(err));
    }
  }

  /** Clear cached thread reference so it will be re-fetched on next send. */
  resetThreadCache() {
    this._chatThread = null;
    this._chatThreadDate = null;
    if (this._rolloverFallback) {
      clearTimeout(this._rolloverFallback);
      this._rolloverFallback = null;
    }
    this._rolloverPending = false;
  }

  /** @internal Enable or disable nuke suppression mode. */
  setNukeActive(active: boolean): void {
    this._nukeActive = active;
  }

  /** @internal Re-create the chat thread (used after nuke reset). */
  async getOrCreateChatThread(): Promise<unknown> {
    return this._getOrCreateChatThread();
  }

  /**
   * Called by LogWatcher's day-rollover callback to signal that the
   * activity thread has been created and it's safe to create the chat thread.
   */
  async createDailyThread() {
    this.resetThreadCache();
    return this._getOrCreateChatThread();
  }

  // ── Daily chat thread management ───────────────────────────

  async _getOrCreateChatThread(): Promise<ThreadLike | null> {
    // Headless mode — no Discord channel, return null
    if (this._headless) return null;

    // During nuke phase 1→2, suppress thread creation so rebuild controls ordering
    if (this._nukeActive) {
      return this.adminChannel;
    }

    // No-thread mode — post straight to the channel
    if (!this._config.useChatThreads) {
      this._chatThread = this.adminChannel;
      return this._chatThread;
    }

    const today = this._config.getToday(); // timezone-aware 'YYYY-MM-DD'

    // If waiting for LogWatcher to create activity thread first, use main channel
    if (this._rolloverPending) {
      return this.adminChannel;
    }

    // Already have today's thread
    if (this._chatThread && this._chatThreadDate === today) {
      return this._chatThread;
    }

    // Archive yesterday's thread if it's still open
    if (this._chatThread && this._chatThreadDate && this._chatThreadDate !== today) {
      try {
        const thread = this._chatThread;
        if (!thread.archived && typeof thread.setArchived === 'function') {
          await thread.setArchived(true);
          this._log.info(`Archived previous thread: ${String(thread.name)}`);
        }
      } catch (e: unknown) {
        this._log.warn('Could not archive old thread:', errMsg(e));
      }
      this._chatThread = null;
      this._chatThreadDate = null;

      // If LogWatcher is managing thread ordering, defer creation
      // until the activity thread has been created first
      if (this._awaitActivityThread) {
        this._rolloverPending = true;
        // Safety fallback: create thread after 2 min if callback never fires
        this._rolloverFallback = setTimeout(() => {
          this._rolloverPending = false;
          this._rolloverFallback = null;
          this._log.info('Rollover fallback — creating chat thread now');
        }, 120_000);
        return this.adminChannel;
      }
    }

    const dateLabel = this._config.getDateLabel();
    const serverSuffix = this._config.serverName ? ` [${this._config.serverName}]` : '';
    const threadName = t('discord:chat_relay.chat_log_title', this._locale, {
      date_label: dateLabel,
      server_suffix: serverSuffix,
    });

    try {
      // Check active threads
      const channel = this.adminChannel as unknown as Record<string, unknown>;
      const threadManager = channel['threads'] as {
        fetchActive(): Promise<{ threads: Map<string, ThreadLike> }>;
        fetchArchived(opts: { limit: number }): Promise<{ threads: Map<string, ThreadLike> }>;
      };
      const active = await threadManager.fetchActive();
      const existing = [...active.threads.values()].find((th) => th.name === threadName);
      if (existing) {
        this._chatThread = existing;
        this._chatThreadDate = today;
        this._log.info(`Using existing thread: ${threadName}`);
        // Re-add admin members (they may have been removed if bot restarted)
        void this._config
          .addAdminMembers(this._chatThread as unknown as ThreadChannel, (channel as unknown as { guild: Guild }).guild)
          .catch(() => {});
        return this._chatThread;
      }

      // Check archived threads (in case bot restarted mid-day)
      const archived = await threadManager.fetchArchived({ limit: 5 });
      const archivedMatch = [...archived.threads.values()].find((th) => th.name === threadName);
      if (archivedMatch) {
        if (archivedMatch.setArchived) await archivedMatch.setArchived(false);
        this._chatThread = archivedMatch;
        this._chatThreadDate = today;
        this._log.info(`Unarchived existing thread: ${threadName}`);
        void this._config
          .addAdminMembers(this._chatThread as unknown as ThreadChannel, (channel as unknown as { guild: Guild }).guild)
          .catch(() => {});
        return this._chatThread;
      }
    } catch (err: unknown) {
      this._log.warn('Could not search for threads:', errMsg(err));
    }

    // Create a new thread (from a starter message so it appears inline in the channel)
    try {
      if (!this.adminChannel) throw new Error('No admin channel');
      const starterMsg = await this.adminChannel.send({
        embeds: [
          new EmbedBuilder()
            .setTitle(
              t('discord:chat_relay.chat_log_title', this._locale, {
                date_label: dateLabel,
                server_suffix: serverSuffix,
              }),
            )
            .setDescription(t('discord:chat_relay.chat_log_description', this._locale))
            .setColor(0x3498db)
            .setTimestamp(),
        ],
      });
      const started = await starterMsg.startThread({
        name: threadName,
        autoArchiveDuration: 1440,
        reason: t('discord:chat_relay.daily_thread_reason', this._locale),
      });
      this._chatThread = started as unknown as ThreadLike;
      this._chatThreadDate = today;
      this._log.info(`Created daily thread: ${threadName}`);

      // Auto-join admin users/roles so the thread stays visible for them
      void this._config
        .addAdminMembers(
          this._chatThread as unknown as ThreadChannel,
          (this.adminChannel as unknown as { guild: Guild }).guild,
        )
        .catch(() => {});
    } catch (err: unknown) {
      this._log.error('Failed to create chat thread:', errMsg(err));
      // Fallback — use the main channel directly so messages aren't dropped
      this._chatThread = this.adminChannel;
      this._chatThreadDate = today;
    }

    return this._chatThread;
  }

  // ── Inbound: fetchchat → Discord thread ────────────────────

  async _pollChat() {
    try {
      const raw = await this._rcon.send('fetchchat');
      if (!raw || !raw.trim()) return;

      const currentLines = raw
        .split('\n')
        .map((l: string) => l.trim())
        .filter(Boolean);
      const newLines = this._diff(currentLines);
      this._lastLines = currentLines;

      if (newLines.length === 0) return;

      // Ensure we have today's thread
      const thread = await this._getOrCreateChatThread();

      for (const line of newLines) {
        const parsed = this._parseLine(line);
        if (parsed) {
          // DB first — insert before posting to Discord
          this._logChat(parsed.entry);
          if (parsed.formatted && thread) {
            await thread.send(parsed.formatted);
          }
        }

        // Check for !admin command (posts to main channel, not thread)
        if (!this._headless) await this._checkAdminCall(line);
      }
    } catch (err: unknown) {
      // Don't spam on RCON issues — the RCON module already logs
      const msg = errMsg(err);
      if (!msg.includes('not connected') && !msg.includes('No response')) {
        this._log.error('Poll error:', msg);
      }
    }
  }

  // ── !admin command detection ────────────────────────────────

  async _checkAdminCall(line: string) {
    // Strip timestamp prefix (game update March 2026) and [Admin] prefix
    const stripped = chatParser.stripTimestamp(line);
    const cleaned = stripAdminPrefix(stripped);
    let m = CHAT_RE.exec(cleaned);
    if (!m) m = PLAIN_CHAT_RE.exec(cleaned);
    if (!m) return;

    const name = (m[1] ?? '').trim();
    const text = (m[2] ?? '').trim();

    // Match !admin with optional message
    const adminMatch = text.match(/^!admin\s*(.*)/i);
    if (!adminMatch) return;

    const reason = adminMatch[1] || t('discord:chat_relay.admin_call_no_reason', this._locale);
    this._log.info(`!admin call from ${name}: ${reason}`);

    // Alert in the daily chat thread (with @here so admins are notified)
    const embed = new EmbedBuilder()
      .setTitle(t('discord:chat_relay.admin_assistance_requested', this._locale))
      .setColor(0xe74c3c)
      .addFields(
        { name: t('discord:chat_relay.player', this._locale), value: name, inline: true },
        { name: t('discord:chat_relay.reason', this._locale), value: reason, inline: true },
      )
      .setTimestamp();

    const payload = { content: '@here', embeds: [embed] };

    // Send to configured alert channels if set, otherwise default to chat thread/admin channel
    const hasExtraChannels = this._config.adminAlertChannelIds.length > 0;

    if (hasExtraChannels) {
      // Send only to the designated alert channels (one @here, not duplicated)
      for (const channelId of this._config.adminAlertChannelIds) {
        try {
          const ch = (await this.client.channels.fetch(channelId)) as TextChannel | null;
          if (ch) await ch.send(payload);
        } catch (err: unknown) {
          this._log.error(`Failed to send admin alert to ${channelId}:`, errMsg(err));
        }
      }
    } else {
      // Default: send to chat thread or admin channel
      try {
        const thread = await this._getOrCreateChatThread();
        if (thread) {
          await thread.send(payload);
        } else if (this.adminChannel) {
          await this.adminChannel.send(payload);
        }
      } catch (err: unknown) {
        this._log.error('Failed to send admin alert:', errMsg(err));
      }
    }

    // Acknowledge in-game — name white, rest gray, discord blue
    try {
      const link = this._config.discordInviteLink || '';
      let linkPart = '';
      if (link) {
        const linkMatch = link.match(/^(.*?discord\.gg)(\/.*)$/i);
        linkPart = linkMatch ? ` </><CL>${linkMatch[1]}</><FO>${linkMatch[2] || ''}` : ` ${link}`;
      }
      await this._rcon.send(
        `admin </>${name}<FO>, ${t('discord:chat_relay.request_sent_notice', this._locale)}${linkPart}`,
      );
    } catch (_: unknown) {}
  }

  /** Insert a chat entry into the DB (best-effort, never throws). */
  _logChat(entry: ChatEntry) {
    if (!this._db) return;
    try {
      this._db.insertChat(entry as unknown as Record<string, unknown>);
    } catch (err: unknown) {
      if (!this._logChatWarned) {
        this._log.warn('DB chat insert failed:', errMsg(err));
        this._logChatWarned = true;
      }
    }
  }

  // ── Outbound: Discord → [Admin] in-game ────────────────────

  async _onMessage(message: Message) {
    if (message.author.bot) return;
    // Accept messages in the admin channel OR any of its threads (e.g. the chat thread)
    const isInChannel = message.channelId === this.adminChannel?.id;
    const msgChannel = message.channel as { isThread?: () => boolean; parentId?: string };
    const isInThread = msgChannel.isThread?.() === true && msgChannel.parentId === this.adminChannel?.id;
    if (!isInChannel && !isInThread) return;
    if (!message.content || message.content.trim() === '') return;

    try {
      let text = message.content.trim();
      // Limit message length to prevent oversized RCON commands
      if (text.length > 500) {
        text = text.substring(0, 500);
      }
      let displayName = message.member?.displayName || message.author.displayName || message.author.username;
      displayName =
        this._sanitizeRcon(displayName)
          .replace(/[^a-zA-Z0-9 _\-.']/g, '')
          .slice(0, 32) || 'User';
      text = this._sanitizeRcon(text);
      await this._rcon.send(`admin </><CL>[Discord]</> ${displayName}<FO>: ${text}`);

      // Log outbound message to DB
      this._logChat({
        type: 'discord_to_game',
        playerName: '',
        message: `${displayName}: ${text}`,
        direction: 'discord',
        discordUser: displayName,
        isAdmin: false,
      });
      await message.react('✅');
    } catch (err: unknown) {
      this._log.error('Failed to relay admin message:', errMsg(err));
      await message.react('❌');
    }
  }
}

// Mix in data-layer methods (parsing, diffing, sanitisation)
Object.assign(ChatRelay.prototype, {
  _parseLine: chatParser._parseLine,
  _formatLine: chatParser._formatLine,
  _diff: chatParser._diff,
  _sanitize: chatParser._sanitize,
  _sanitizeRcon: chatParser._sanitizeRcon,
});

export default ChatRelay;
export { ChatRelay };

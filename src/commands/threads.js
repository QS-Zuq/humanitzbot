const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, MessageFlags } = require('discord.js');
const SftpClient = require('ssh2-sftp-client');
const config = require('../config');
const { t, getLocalizations } = require('../i18n');

/**
 * /threads rebuild — Downloads full log history from SFTP, groups events by
 * date (in BOT_TIMEZONE), and creates one summary thread per day in the
 * activity log channel.
 *
 * Supports two data sources:
 *   - 'sftp' (default): Raw log files from game server
 *   - 'db': Activity and chat data from SQLite database
 */

// ── Log-line parsers (mirror the regexes in log-watcher.js) ──

const HMZ_LINE_RE = /^\((\d{1,2})[/\-.](\d{1,2})[/\-.](\d{1,2},?\d{3})\s+(\d{1,2}):(\d{1,2})(?::\d{1,2})?\)\s+(.+)$/;
const CONNECT_LINE_RE =
  /^Player (Connected|Disconnected)\s+(.+?)\s+NetID\((\d{17})[^)]*\)\s*\((\d{1,2})[/\-.](\d{1,2})[/\-.](\d{1,2},?\d{3})\s+(\d{1,2}):(\d{1,2})(?::\d{1,2})?\)/;

function _dateKey(ts) {
  // Return 'YYYY-MM-DD' in BOT_TIMEZONE
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: config.botTimezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(ts);
    const y = parts.find((p) => p.type === 'year').value;
    const m = parts.find((p) => p.type === 'month').value;
    const d = parts.find((p) => p.type === 'day').value;
    return `${y}-${m}-${d}`;
  } catch {
    return ts.toISOString().slice(0, 10);
  }
}

function _dateLabel(dateStr) {
  // 'YYYY-MM-DD' → friendly label via config
  return config.getDateLabel(new Date(dateStr + 'T12:00:00Z'));
}

/**
 * Parse HMZLog lines and group event counts by date.
 */
function _parseHmzLog(text) {
  const days = {};

  const ensure = (key) => {
    if (!days[key]) {
      days[key] = {
        deaths: 0,
        builds: 0,
        damage: 0,
        loots: 0,
        raidHits: 0,
        destroyed: 0,
        admin: 0,
        cheat: 0,
        players: new Set(),
      };
    }
    return days[key];
  };

  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/^\uFEFF/, '').trim();
    if (!line) continue;

    const m = line.match(HMZ_LINE_RE);
    if (!m) continue;

    const [, day, month, rawYear, hour, min, body] = m;
    const year = rawYear.replace(',', '');
    let ts;
    try {
      ts = config.parseLogTimestamp(year, month, day, hour, min);
    } catch {
      continue;
    }
    const key = _dateKey(ts);
    const d = ensure(key);

    // Player death
    const deathMatch = body.match(/^Player died \((.+)\)$/);
    if (deathMatch) {
      d.deaths++;
      d.players.add(deathMatch[1].trim());
      continue;
    }

    // Building completed
    const buildMatch = body.match(/^(.+?)\((\d{17})[^)]*\)\s*finished building\s+/);
    if (buildMatch) {
      d.builds++;
      d.players.add(buildMatch[1].trim());
      continue;
    }

    // Damage taken
    const dmgMatch = body.match(/^(.+?)\s+took\s+[\d.]+\s+damage from\s+/);
    if (dmgMatch) {
      d.damage++;
      d.players.add(dmgMatch[1].trim());
      continue;
    }

    // Container looted
    const lootMatch = body.match(/^(.+?)\s*\(\d{17}[^)]*\)\s*looted a container/);
    if (lootMatch) {
      d.loots++;
      d.players.add(lootMatch[1].trim());
      continue;
    }

    // Building damaged by player (raid)
    const raidMatch = body.match(/^Building \([^)]+\) owned by \((\d{17}[^)]*)\) damaged/);
    if (raidMatch) {
      const destroyed = /\(Destroyed\)\s*$/.test(body);
      if (destroyed) d.destroyed++;
      else d.raidHits++;
      continue;
    }

    // Admin access
    if (/gained admin access!$/.test(body)) {
      d.admin++;
      continue;
    }

    // Anti-cheat
    if (/^(Stack limit detected|Odd behavior.*?Cheat)/.test(body)) {
      d.cheat++;
      continue;
    }
  }

  return days;
}

/**
 * Parse PlayerConnectedLog lines and group connect/disconnect counts by date.
 */
function _parseConnectLog(text) {
  const days = {};

  const ensure = (key) => {
    if (!days[key]) {
      days[key] = { connects: 0, disconnects: 0, players: new Set() };
    }
    return days[key];
  };

  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/^\uFEFF/, '').trim();
    if (!line) continue;

    const m = line.match(CONNECT_LINE_RE);
    if (!m) continue;

    const [, action, name, , day, month, rawYear, hour, min] = m;
    const year = rawYear.replace(',', '');
    let ts;
    try {
      ts = config.parseLogTimestamp(year, month, day, hour, min);
    } catch {
      continue;
    }
    const key = _dateKey(ts);
    const d = ensure(key);

    d.players.add(name);
    if (action === 'Connected') d.connects++;
    else d.disconnects++;
  }

  return days;
}

/**
 * Merge HMZ + Connect day maps into unified summary objects.
 */
function _mergeDays(hmzDays, connectDays) {
  const allDates = new Set([...Object.keys(hmzDays), ...Object.keys(connectDays)]);
  const merged = {};

  for (const date of allDates) {
    const h = hmzDays[date] || {};
    const c = connectDays[date] || {};
    const players = new Set([...(h.players || []), ...(c.players || [])]);

    merged[date] = {
      connects: c.connects || 0,
      disconnects: c.disconnects || 0,
      deaths: h.deaths || 0,
      builds: h.builds || 0,
      damage: h.damage || 0,
      loots: h.loots || 0,
      raidHits: h.raidHits || 0,
      destroyed: h.destroyed || 0,
      admin: h.admin || 0,
      cheat: h.cheat || 0,
      uniquePlayers: players.size,
    };
  }

  return merged;
}

/**
 * Build exactly the same embed as LogWatcher._postDailySummary().
 */
function _buildSummaryEmbed(dateStr, counts) {
  const label = _dateLabel(dateStr);

  const lines = [];
  if (counts.connects > 0) lines.push(['Connections', counts.connects]);
  if (counts.disconnects > 0) lines.push(['Disconnections', counts.disconnects]);
  if (counts.deaths > 0) lines.push(['Deaths', counts.deaths]);
  if (counts.builds > 0) lines.push(['Items Built', counts.builds]);
  if (counts.damage > 0) lines.push(['Damage Hits', counts.damage]);
  if (counts.loots > 0) lines.push(['Containers Looted', counts.loots]);
  if (counts.raidHits > 0) lines.push(['Raid Hits', counts.raidHits]);
  if (counts.destroyed > 0) lines.push(['Structures Destroyed', counts.destroyed]);
  if (counts.admin > 0) lines.push(['Admin Access', counts.admin]);
  if (counts.cheat > 0) lines.push(['Anti-Cheat Flags', counts.cheat]);

  const total = lines.reduce((sum, [, v]) => sum + v, 0);

  const gridLines = lines.map(([l, v]) => `**${l}:** ${v}`);

  return new EmbedBuilder()
    .setTitle(`Daily Summary — ${label}`)
    .setDescription(gridLines.join('\n'))
    .setColor(0x3498db)
    .setFooter({ text: `${total} total events  •  ${counts.uniquePlayers} unique players` })
    .setTimestamp(new Date(dateStr + 'T23:59:59Z'));
}

/**
 * Fetch ALL messages from a thread, paginating backwards.
 * Returns messages in chronological order (oldest first).
 * Skips the thread starter message (the first embed posted by the bot to
 * create the thread) so it isn't duplicated in the rebuilt thread.
 */
async function _fetchThreadMessages(thread) {
  const messages = [];
  let lastId;

  while (true) {
    const opts = { limit: 100 };
    if (lastId) opts.before = lastId;
    const batch = await thread.messages.fetch(opts);
    if (batch.size === 0) break;
    messages.push(...batch.values());
    lastId = batch.last().id;
    if (batch.size < 100) break;
  }

  // Chronological order (oldest first)
  messages.reverse();

  // The very first message in most threads is the "starter" embed that
  // LogWatcher sends to create the thread.  We rebuild that ourselves via
  // _buildSummaryEmbed, so skip any messages that look like:
  //   • A single embed whose title starts with "📋 Activity Log"
  //   • A single embed whose description is the "Log watcher connected" startup notice
  const isStarter = (m) => {
    if (m.embeds.length !== 1 || m.content) return false;
    const title = m.embeds[0].data?.title || '';
    const desc = m.embeds[0].data?.description || '';
    if (title.startsWith('Daily Summary')) return true;
    if (title.startsWith('📋 Activity Log')) return true;
    if (desc.includes('Log watcher connected')) return true;
    return false;
  };

  return messages.filter((m) => !isStarter(m));
}

/**
 * Find all existing threads (active + archived) matching a thread name.
 * Returns an array of thread objects.
 */
async function _findMatchingThreads(channel, threadName, { dateLabel, serverSuffix = '' } = {}) {
  const found = [];

  // Build a set of name variants to match (current + legacy formats)
  const names = new Set([threadName]);
  if (dateLabel) {
    // Current format
    names.add(`Daily Summary — ${dateLabel}${serverSuffix}`);
    names.add(`Daily Summary — ${dateLabel}`);
    // Legacy formats with emoji prefix
    names.add(`📋 Activity Log — ${dateLabel}${serverSuffix}`);
    names.add(`📋 Activity Log — ${dateLabel}`);
    // Legacy format without emoji prefix
    names.add(`Activity Log — ${dateLabel}${serverSuffix}`);
    names.add(`Activity Log — ${dateLabel}`);
    // Very old format
    names.add(`Activity Log - ${dateLabel}${serverSuffix}`);
    names.add(`Activity Log - ${dateLabel}`);
  }

  try {
    const active = await channel.threads.fetchActive();
    for (const [, t] of active.threads) {
      if (names.has(t.name)) found.push(t);
    }
  } catch {
    /* ignore */
  }

  try {
    const archived = await channel.threads.fetchArchived({ limit: 100 });
    for (const [, t] of archived.threads) {
      if (names.has(t.name)) found.push(t);
    }
  } catch {
    /* ignore */
  }

  return found;
}

/**
 * Core rebuild logic — shared between the /threads command and NUKE_BOT startup.
 * @param {import('discord.js').Client} discordClient
 * @param {number|null} daysBack  Number of days to rebuild, or null for all.
 * @returns {{ created: number, deleted: number, preserved: number, error?: string }}
 */
async function rebuildThreads(discordClient, daysBack = null, configOverride = null) {
  const cfg = configOverride || config;
  const channelId = cfg.logChannelId;
  if (!channelId) return { created: 0, deleted: 0, preserved: 0, cleaned: 0, error: 'LOG_CHANNEL_ID is not set' };
  if (!cfg.sftpHost || !cfg.sftpUser || (!cfg.sftpPassword && !cfg.sftpPrivateKeyPath))
    return { created: 0, deleted: 0, preserved: 0, cleaned: 0, error: 'SFTP credentials not configured' };

  const channel = await discordClient.channels.fetch(channelId).catch(() => null);
  if (!channel) return { created: 0, deleted: 0, preserved: 0, cleaned: 0, error: 'Could not access log channel' };

  // ── Download logs via SFTP ─────────────────────────────
  let hmzText = '';
  let connectText = '';
  const sftp = new SftpClient();

  try {
    await sftp.connect(cfg.sftpConnectConfig());

    try {
      const buf = await sftp.get(cfg.sftpLogPath);
      hmzText = buf.toString('utf8');
    } catch (err) {
      console.warn('[THREADS] HMZLog not found:', err.message);
    }

    try {
      const buf = await sftp.get(cfg.sftpConnectLogPath);
      connectText = buf.toString('utf8');
    } catch (err) {
      console.warn('[THREADS] ConnectLog not found:', err.message);
    }
  } catch (err) {
    return { created: 0, deleted: 0, preserved: 0, cleaned: 0, error: `SFTP connection failed: ${err.message}` };
  } finally {
    await sftp.end().catch(() => {});
  }

  if (!hmzText && !connectText)
    return { created: 0, deleted: 0, preserved: 0, cleaned: 0, error: 'No log data found on the server' };

  // ── Parse & merge ──────────────────────────────────────
  const hmzDays = _parseHmzLog(hmzText);
  const connectDays = _parseConnectLog(connectText);
  const merged = _mergeDays(hmzDays, connectDays);

  let dates = Object.keys(merged).sort();
  if (dates.length === 0)
    return { created: 0, deleted: 0, preserved: 0, cleaned: 0, error: 'No events found in the logs' };

  if (daysBack) dates = dates.slice(-daysBack);

  // ── Clean up old bot messages in the channel ────────────
  // Delete Daily Summary embeds and old thread starters left behind from
  // previous bot versions. Only deletes messages from the bot itself.
  // When serverSuffix is set, only clean starters matching this server.
  const serverSuffix = cfg.serverName ? ` [${cfg.serverName}]` : '';
  let cleaned = 0;
  try {
    const botId = discordClient.user?.id;
    let lastId;
    // Scan up to 500 messages in the channel (5 pages)
    for (let page = 0; page < 5; page++) {
      const opts = { limit: 100 };
      if (lastId) opts.before = lastId;
      const batch = await channel.messages.fetch(opts);
      if (batch.size === 0) break;
      lastId = batch.last().id;

      for (const [, msg] of batch) {
        // Only delete bot-authored messages
        if (botId && msg.author.id !== botId) continue;
        if (msg.embeds.length !== 1 || msg.content) continue;

        const title = msg.embeds[0].data?.title || '';
        // Match: "Daily Summary — 19 Feb 2026", "📋 Activity Log — ...", old format starters
        if (/^Daily Summary/i.test(title) || /^📋 Activity Log/i.test(title) || /^Activity Log/i.test(title)) {
          // If this rebuild is for a specific server, only clean matching starters
          // (skip starters that belong to a different server or the primary)
          if (serverSuffix) {
            if (!title.includes(serverSuffix)) continue;
          } else {
            // Primary rebuild — only clean starters without a server tag
            if (/\[.+\]\s*$/.test(title)) continue;
          }
          await msg.delete().catch(() => {});
          cleaned++;
        }
      }

      if (batch.size < 100) break;
    }
    if (cleaned > 0) console.log(`[THREADS] Cleaned ${cleaned} old summary/starter messages from channel`);
  } catch (err) {
    console.warn('[THREADS] Could not clean channel messages:', err.message);
  }

  // ── Create threads (preserving existing content) ───────
  let created = 0;
  let deleted = 0;
  let preserved = 0;

  for (const dateStr of dates) {
    const label = _dateLabel(dateStr);
    const threadName = `Daily Summary — ${label}${serverSuffix}`;

    // 1. Find existing threads and harvest their messages before deletion
    const existingThreads = await _findMatchingThreads(channel, threadName, { dateLabel: label, serverSuffix });
    const savedMessages = [];

    for (const oldThread of existingThreads) {
      try {
        // Unarchive if needed so we can read messages
        if (oldThread.archived) {
          await oldThread.setArchived(false).catch(() => {});
        }
        const msgs = await _fetchThreadMessages(oldThread);
        savedMessages.push(...msgs);
      } catch (err) {
        console.warn(`[THREADS] Could not read messages from "${threadName}":`, err.message);
      }
    }

    // 2. Delete the old threads
    for (const oldThread of existingThreads) {
      await oldThread.delete('Replaced by thread rebuild').catch(() => {});
      deleted++;
    }

    // 3. Create the new thread with a fresh summary embed
    try {
      const embed = _buildSummaryEmbed(dateStr, merged[dateStr]);
      const starterMsg = await channel.send({ embeds: [embed] });
      const newThread = await starterMsg.startThread({
        name: threadName,
        autoArchiveDuration: 1440,
        reason: 'Rebuilt activity log thread',
      });
      created++;

      // 4. Re-post preserved messages into the new thread
      for (const msg of savedMessages) {
        try {
          const payload = {};

          // Preserve embeds
          if (msg.embeds.length > 0) {
            payload.embeds = msg.embeds.map((e) => EmbedBuilder.from(e));
          }

          // Preserve text content
          if (msg.content) {
            payload.content = msg.content;
          }

          // Skip empty messages (no content, no embeds)
          if (!payload.content && !payload.embeds) continue;

          await newThread.send(payload);
          preserved++;
        } catch (err) {
          console.warn(`[THREADS] Could not re-post message in "${threadName}":`, err.message);
        }
      }

      // Small delay to avoid Discord rate limits
      if (created % 3 === 0) {
        await new Promise((r) => setTimeout(r, 2000));
      }
    } catch (err) {
      console.error(`[THREADS] Failed to create thread for ${dateStr}:`, err.message);
    }
  }

  return { created, deleted, preserved, cleaned };
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('threads')
    .setNameLocalizations(getLocalizations('commands:threads.name'))
    .setDescription(t('commands:threads.description', 'en'))
    .setDescriptionLocalizations(getLocalizations('commands:threads.description'))
    .addIntegerOption((opt) =>
      opt
        .setName('days')
        .setDescription(t('commands:threads.options.days', 'en'))
        .setDescriptionLocalizations(getLocalizations('commands:threads.options.days'))
        .setMinValue(1)
        .setRequired(false),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const locale = interaction.locale || 'en';
    await interaction.editReply(t('commands:threads.reply.downloading', locale));

    const daysBack = interaction.options.getInteger('days');
    const result = await rebuildThreads(interaction.client, daysBack);

    if (result.error) {
      return interaction.editReply(t('commands:threads.reply.error', locale, { error: result.error }));
    }

    const parts = [];
    if (result.created > 0) parts.push(t('commands:threads.reply.created', locale, { count: result.created }));
    if (result.deleted > 0) parts.push(t('commands:threads.reply.replaced', locale, { count: result.deleted }));
    if (result.preserved > 0) parts.push(t('commands:threads.reply.preserved', locale, { count: result.preserved }));
    if (result.cleaned > 0) parts.push(t('commands:threads.reply.cleaned', locale, { count: result.cleaned }));
    if (result.created === 0 && result.deleted === 0) parts.push(t('commands:threads.reply.no_events', locale));
    parts.push(`\n${t('commands:threads.reply.chat_note', locale)}`);

    await interaction.editReply(parts.join('\n'));
  },

  // Export shared function + parsers for testing
  rebuildThreads,
  _fetchThreadMessages,
  _findMatchingThreads,
  _parseHmzLog,
  _parseConnectLog,
  _mergeDays,
  _buildSummaryEmbed,
  _dateKey,
};

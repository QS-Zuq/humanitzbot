const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const SftpClient = require('ssh2-sftp-client');
const config = require('../config');

/**
 * /threads rebuild — Downloads full log history from SFTP, groups events by
 * date (in BOT_TIMEZONE), and creates one summary thread per day in the
 * activity log channel.
 *
 * Chat threads cannot be rebuilt because chat is polled in real-time via RCON
 * and no historical chat data is stored.
 */

// ── Log-line parsers (mirror the regexes in log-watcher.js) ──

const HMZ_LINE_RE = /^\((\d{1,2})[/\-.](\d{1,2})[/\-.](\d{1,2},?\d{3})\s+(\d{1,2}):(\d{1,2})(?::\d{1,2})?\)\s+(.+)$/;
const CONNECT_LINE_RE = /^Player (Connected|Disconnected)\s+(.+?)\s+NetID\((\d{17})[^)]*\)\s*\((\d{1,2})[/\-.](\d{1,2})[/\-.](\d{1,2},?\d{3})\s+(\d{1,2}):(\d{1,2})(?::\d{1,2})?\)/;

function _dateKey(ts) {
  // Return 'YYYY-MM-DD' in BOT_TIMEZONE
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: config.botTimezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(ts);
    const y = parts.find(p => p.type === 'year').value;
    const m = parts.find(p => p.type === 'month').value;
    const d = parts.find(p => p.type === 'day').value;
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
      days[key] = { deaths: 0, builds: 0, damage: 0, loots: 0, raidHits: 0, destroyed: 0, admin: 0, cheat: 0, players: new Set() };
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
    try { ts = config.parseLogTimestamp(year, month, day, hour, min); } catch { continue; }
    const key = _dateKey(ts);
    const d = ensure(key);

    // Player death
    const deathMatch = body.match(/^Player died \((.+)\)$/);
    if (deathMatch) { d.deaths++; d.players.add(deathMatch[1].trim()); continue; }

    // Building completed
    const buildMatch = body.match(/^(.+?)\((\d{17})[^)]*\)\s*finished building\s+/);
    if (buildMatch) { d.builds++; d.players.add(buildMatch[1].trim()); continue; }

    // Damage taken
    const dmgMatch = body.match(/^(.+?)\s+took\s+[\d.]+\s+damage from\s+/);
    if (dmgMatch) { d.damage++; d.players.add(dmgMatch[1].trim()); continue; }

    // Container looted
    const lootMatch = body.match(/^(.+?)\s*\(\d{17}[^)]*\)\s*looted a container/);
    if (lootMatch) { d.loots++; d.players.add(lootMatch[1].trim()); continue; }

    // Building damaged by player (raid)
    const raidMatch = body.match(/^Building \([^)]+\) owned by \((\d{17}[^)]*)\) damaged/);
    if (raidMatch) {
      const destroyed = /\(Destroyed\)\s*$/.test(body);
      if (destroyed) d.destroyed++;
      else d.raidHits++;
      continue;
    }

    // Admin access
    if (/gained admin access!$/.test(body)) { d.admin++; continue; }

    // Anti-cheat
    if (/^(Stack limit detected|Odd behavior.*?Cheat)/.test(body)) { d.cheat++; continue; }
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
    try { ts = config.parseLogTimestamp(year, month, day, hour, min); } catch { continue; }
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
      connects:    c.connects || 0,
      disconnects: c.disconnects || 0,
      deaths:      h.deaths || 0,
      builds:      h.builds || 0,
      damage:      h.damage || 0,
      loots:       h.loots || 0,
      raidHits:    h.raidHits || 0,
      destroyed:   h.destroyed || 0,
      admin:       h.admin || 0,
      cheat:       h.cheat || 0,
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
  if (counts.connects > 0)    lines.push(['Connections',          counts.connects]);
  if (counts.disconnects > 0) lines.push(['Disconnections',       counts.disconnects]);
  if (counts.deaths > 0)      lines.push(['Deaths',               counts.deaths]);
  if (counts.builds > 0)      lines.push(['Items Built',          counts.builds]);
  if (counts.damage > 0)      lines.push(['Damage Hits',          counts.damage]);
  if (counts.loots > 0)       lines.push(['Containers Looted',    counts.loots]);
  if (counts.raidHits > 0)    lines.push(['Raid Hits',            counts.raidHits]);
  if (counts.destroyed > 0)   lines.push(['Structures Destroyed', counts.destroyed]);
  if (counts.admin > 0)       lines.push(['Admin Access',         counts.admin]);
  if (counts.cheat > 0)       lines.push(['Anti-Cheat Flags',     counts.cheat]);

  const total = lines.reduce((sum, [, v]) => sum + v, 0);

  const gridLines = lines.map(([l, v]) => `${l.padEnd(22)} ${String(v).padStart(5)}`);

  return new EmbedBuilder()
    .setTitle(`Daily Summary — ${label}`)
    .setDescription('```\n' + gridLines.join('\n') + '\n```')
    .setColor(0x3498db)
    .setFooter({ text: `${total} total events  •  ${counts.uniquePlayers} unique players` })
    .setTimestamp(new Date(dateStr + 'T23:59:59Z'));
}

/**
 * Core rebuild logic — shared between the /threads command and NUKE_THREADS startup.
 * @param {import('discord.js').Client} discordClient
 * @param {number|null} daysBack  Number of days to rebuild, or null for all.
 * @returns {{ created: number, deleted: number, error?: string }}
 */
async function rebuildThreads(discordClient, daysBack = null) {
  const channelId = config.logChannelId;
  if (!channelId) return { created: 0, deleted: 0, error: 'LOG_CHANNEL_ID is not set' };
  if (!config.ftpHost || !config.ftpUser || !config.ftpPassword) return { created: 0, deleted: 0, error: 'SFTP credentials not configured' };

  const channel = await discordClient.channels.fetch(channelId).catch(() => null);
  if (!channel) return { created: 0, deleted: 0, error: 'Could not access log channel' };

  // ── Download logs via SFTP ─────────────────────────────
  let hmzText = '';
  let connectText = '';
  const sftp = new SftpClient();

  try {
    await sftp.connect({
      host: config.ftpHost,
      port: config.ftpPort,
      username: config.ftpUser,
      password: config.ftpPassword,
    });

    try {
      const buf = await sftp.get(config.ftpLogPath);
      hmzText = buf.toString('utf8');
    } catch (err) {
      console.warn('[THREADS] HMZLog not found:', err.message);
    }

    try {
      const buf = await sftp.get(config.ftpConnectLogPath);
      connectText = buf.toString('utf8');
    } catch (err) {
      console.warn('[THREADS] ConnectLog not found:', err.message);
    }
  } catch (err) {
    return { created: 0, deleted: 0, error: `SFTP connection failed: ${err.message}` };
  } finally {
    await sftp.end().catch(() => {});
  }

  if (!hmzText && !connectText) return { created: 0, deleted: 0, error: 'No log data found on the server' };

  // ── Parse & merge ──────────────────────────────────────
  const hmzDays = _parseHmzLog(hmzText);
  const connectDays = _parseConnectLog(connectText);
  const merged = _mergeDays(hmzDays, connectDays);

  let dates = Object.keys(merged).sort();
  if (dates.length === 0) return { created: 0, deleted: 0, error: 'No events found in the logs' };

  if (daysBack) dates = dates.slice(-daysBack);

  // ── Create threads ─────────────────────────────────────
  let created = 0;
  let deleted = 0;

  for (const dateStr of dates) {
    const label = _dateLabel(dateStr);
    const threadName = `📋 Activity Log — ${label}`;

    // Delete any existing duplicate threads (active + archived)
    try {
      const active = await channel.threads.fetchActive();
      const dupes = active.threads.filter(t => t.name === threadName);
      for (const [, thread] of dupes) {
        await thread.delete('Replaced by thread rebuild').catch(() => {});
        deleted++;
      }
    } catch { /* ignore */ }

    try {
      const archived = await channel.threads.fetchArchived({ limit: 100 });
      const dupes = archived.threads.filter(t => t.name === threadName);
      for (const [, thread] of dupes) {
        await thread.delete('Replaced by thread rebuild').catch(() => {});
        deleted++;
      }
    } catch { /* ignore */ }

    // Create the thread
    try {
      const embed = _buildSummaryEmbed(dateStr, merged[dateStr]);
      const starterMsg = await channel.send({ embeds: [embed] });
      await starterMsg.startThread({
        name: threadName,
        autoArchiveDuration: 1440,
        reason: 'Rebuilt activity log thread',
      });
      created++;

      // Small delay to avoid Discord rate limits
      if (created % 3 === 0) {
        await new Promise(r => setTimeout(r, 2000));
      }
    } catch (err) {
      console.error(`[THREADS] Failed to create thread for ${dateStr}:`, err.message);
    }
  }

  return { created, deleted };
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('threads')
    .setDescription('Rebuild daily activity summary threads from log history (Admin only)')
    .addIntegerOption(opt =>
      opt
        .setName('days')
        .setDescription('How many days back to rebuild (default: all)')
        .setMinValue(1)
        .setRequired(false)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });
    await interaction.editReply('⏳ Downloading log files from server…');

    const daysBack = interaction.options.getInteger('days');
    const result = await rebuildThreads(interaction.client, daysBack);

    if (result.error) {
      return interaction.editReply(`❌ ${result.error}`);
    }

    const parts = [];
    if (result.created > 0) parts.push(`✅ Created **${result.created}** activity summary thread(s)`);
    if (result.deleted > 0) parts.push(`🗑️ Deleted **${result.deleted}** existing duplicate thread(s)`);
    if (result.created === 0 && result.deleted === 0) parts.push('ℹ️ No events found for the requested date range.');
    parts.push('\n💬 *Chat threads cannot be rebuilt (chat is polled live via RCON with no stored history).*');

    await interaction.editReply(parts.join('\n'));
  },

  // Export shared function + parsers for testing
  rebuildThreads,
  _parseHmzLog,
  _parseConnectLog,
  _mergeDays,
  _buildSummaryEmbed,
  _dateKey,
};

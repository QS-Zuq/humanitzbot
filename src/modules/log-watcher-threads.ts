/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment,
   @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call,
   @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return,
   @typescript-eslint/restrict-template-expressions,
   @typescript-eslint/restrict-plus-operands,
   @typescript-eslint/no-unnecessary-type-assertion */

/**
 * log-watcher-threads.js — Daily thread management for LogWatcher.
 *
 * Extracted from log-watcher.js to separate Discord thread lifecycle
 * (creation, lookup, archival, day-rollover summaries) from log parsing
 * and event handling.  Methods are mixed in via Object.assign so `this`
 * is the LogWatcher instance.
 */

import { EmbedBuilder } from 'discord.js';

// ═════════════════════════════════════════════════════════════════════
//  Day rollover detection
// ═════════════════════════════════════════════════════════════════════
async function _checkDayRollover(this: any) {
  if (!this._dailyDate) return; // not initialised yet
  const today = this._config.getToday();
  if (this._dailyDate !== today) {
    this._log.info(`Day rollover detected: ${this._dailyDate} → ${today}`);
    await this._getOrCreateDailyThread(); // triggers summary + new thread
  }
}

// ═════════════════════════════════════════════════════════════════════
//  Daily thread creation / lookup
// ═════════════════════════════════════════════════════════════════════
async function _getOrCreateDailyThread(this: any) {
  // Headless mode — no Discord channel, return null
  if (this._headless) return null;

  // During nuke phase 1→2, suppress thread creation so rebuildThreads controls ordering
  if (this._nukeActive) {
    this._dailyThread = this.logChannel;
    this._dailyDate = this._config.getToday();
    return this._dailyThread;
  }

  const today = this._config.getToday(); // timezone-aware 'YYYY-MM-DD'

  // Day rollover — post summary and reset counters (even in no-thread mode)
  if (this._dailyDate && this._dailyDate !== today) {
    await this._postDailySummary();
    this._dayCounts = {
      connects: 0,
      disconnects: 0,
      deaths: 0,
      builds: 0,
      damage: 0,
      loots: 0,
      raidHits: 0,
      destroyed: 0,
      admin: 0,
      cheat: 0,
      pvpKills: 0,
    };
    this._dayCountsDirty = true;
    this._saveDayCounts();
    this._dailyThread = null; // clear stale thread so a new one is created below
    this._dailyDate = today;
  }

  // First startup — check for stale day-counts from a previous session on a different day
  if (!this._dailyDate) {
    try {
      let raw = null;
      if (this._db) {
        raw = this._db.getStateJSON('day_counts', null);
      }
      if (raw && raw.date && raw.date !== today && raw.counts) {
        const total = (Object.values(raw.counts) as number[]).reduce(
          (s: any, v: any) => (s as number) + ((v as number) || 0),
          0,
        );
        if (total > 0) {
          // Post the old day's summary before creating today's thread
          this._dailyDate = raw.date;
          this._dayCounts = { ...this._dayCounts, ...raw.counts };
          await this._postDailySummary();
          this._dayCounts = {
            connects: 0,
            disconnects: 0,
            deaths: 0,
            builds: 0,
            damage: 0,
            loots: 0,
            raidHits: 0,
            destroyed: 0,
            admin: 0,
            cheat: 0,
            pvpKills: 0,
          };
          this._dayCountsDirty = true;
          this._saveDayCounts();
          this._dailyDate = null; // reset so normal flow continues
          this._log.info(`Posted stale daily summary for ${raw.date}`);
        }
      }
    } catch (err: any) {
      this._log.warn('Could not process stale day-counts:', err.message);
    }
  }

  // No-thread mode — post straight to the channel
  if (!this._config.useActivityThreads) {
    this._dailyThread = this.logChannel;
    this._dailyDate = today;
    return this._dailyThread;
  }

  // Already have today's thread
  if (this._dailyThread && this._dailyDate === today) {
    return this._dailyThread;
  }

  // Look for an existing thread for today
  const dateLabel = this._config.getDateLabel();
  const serverLabel = this._getServerLabel();
  const serverSuffix = serverLabel ? ` [${serverLabel}]` : '';
  const threadName = `Daily Summary — ${dateLabel}${serverSuffix}`;
  const legacyThreadName = `📋 Activity Log — ${dateLabel}${serverSuffix}`;

  try {
    // Check active threads (search new name first, then legacy)
    const active = await this.logChannel.threads.fetchActive();
    const existing =
      active.threads.find((t: any) => t.name === threadName) ||
      active.threads.find((t: any) => t.name === legacyThreadName);
    if (existing) {
      this._dailyThread = existing;
      this._dailyDate = today;
      this._log.info(`Using existing thread: ${threadName}`);
      // Re-add admin members (they may have been removed if bot restarted)
      this._config.addAdminMembers(this._dailyThread, this.logChannel.guild).catch(() => {});
      return this._dailyThread;
    }

    // Check archived threads (in case bot restarted mid-day)
    const archived = await this.logChannel.threads.fetchArchived({ limit: 5 });
    const archivedMatch =
      archived.threads.find((t: any) => t.name === threadName) ||
      archived.threads.find((t: any) => t.name === legacyThreadName);
    if (archivedMatch) {
      // Unarchive it
      await archivedMatch.setArchived(false);
      this._dailyThread = archivedMatch;
      this._dailyDate = today;
      this._log.info(`Unarchived existing thread: ${threadName}`);
      this._config.addAdminMembers(this._dailyThread, this.logChannel.guild).catch(() => {});
      return this._dailyThread;
    }
  } catch (err: any) {
    this._log.warn('Could not search for threads:', err.message);
  }

  // Create a new thread (from a starter message so it appears inline in the channel)
  try {
    const starterMsg = await this.logChannel.send({
      embeds: [
        new EmbedBuilder()
          .setTitle(`Daily Summary — ${dateLabel}${serverSuffix}`)
          .setDescription('Server activity, kills, building, and container changes for today.')
          .setColor(0x3498db)
          .setTimestamp(),
      ],
    });
    this._dailyThread = await starterMsg.startThread({
      name: threadName,
      autoArchiveDuration: 1440, // keep alive 24h
      reason: 'Daily summary thread',
    });
    this._dailyDate = today;
    this._log.info(`Created daily thread: ${threadName}`);

    // Auto-join admin users/roles so the thread stays visible for them
    this._config.addAdminMembers(this._dailyThread, this.logChannel.guild).catch(() => {});
  } catch (err: any) {
    this._log.error('Failed to create daily thread:', err.message);
    // Fallback — use the main channel directly
    this._dailyThread = this.logChannel;
    this._dailyDate = today;
  }

  // Notify listeners (e.g. ChatRelay) that the daily thread was created
  if (typeof this._dayRolloverCb === 'function') {
    try {
      await this._dayRolloverCb();
    } catch (e: any) {
      this._log.warn('Day rollover callback error:', e.message);
    }
  }

  return this._dailyThread;
}

// ═════════════════════════════════════════════════════════════════════
//  Daily summary embed
// ═════════════════════════════════════════════════════════════════════
async function _postDailySummary(this: any) {
  if (this._headless) return; // headless mode — no Discord posting
  const c = this._dayCounts;
  const logTotal =
    c.connects +
    c.disconnects +
    c.deaths +
    c.builds +
    c.damage +
    c.loots +
    c.raidHits +
    c.destroyed +
    c.cheat +
    c.admin +
    c.pvpKills;

  const dateLabel = this._dailyDate ? this._config.getDateLabel(new Date(this._dailyDate + 'T12:00:00Z')) : 'Unknown';

  // ── Log-based stats ──────────────────────────────
  const lines = [];
  if (c.connects > 0) lines.push(`**Connections:** ${c.connects}`);
  if (c.disconnects > 0) lines.push(`**Disconnections:** ${c.disconnects}`);
  if (c.deaths > 0) lines.push(`**Deaths:** ${c.deaths}`);
  if (c.builds > 0) lines.push(`**Items Built:** ${c.builds}`);
  if (c.damage > 0) lines.push(`**Damage Hits:** ${c.damage}`);
  if (c.loots > 0) lines.push(`**Containers Looted:** ${c.loots}`);
  if (c.raidHits > 0) lines.push(`**Raid Hits:** ${c.raidHits}`);
  if (c.destroyed > 0) lines.push(`**Structures Destroyed:** ${c.destroyed}`);
  if (c.admin > 0) lines.push(`**Admin Access:** ${c.admin}`);
  if (c.cheat > 0) lines.push(`**Anti-Cheat Flags:** ${c.cheat}`);
  if (c.pvpKills > 0) lines.push(`**PvP Kills:** ${c.pvpKills}`);

  // ── Save-derived stats (from activity_log DB) ────
  let dbTotal = 0;
  if (this._db && this._dailyDate) {
    try {
      const startOfDay = `${this._dailyDate}T00:00:00.000Z`;
      const events = this._db.getActivitySince(startOfDay);
      if (events.length > 0) {
        const counts = {};
        for (const e of events) {
          (counts as Record<string, number>)[e.type] = ((counts as Record<string, number>)[e.type] || 0) + 1;
        }
        dbTotal = events.length;

        // Container activity
        const containerAdded = (counts as any).container_item_added || 0;
        const containerRemoved = (counts as any).container_item_removed || 0;
        const containerMoves = containerAdded + containerRemoved;
        if (containerMoves > 0) lines.push(`**Container Items Moved:** ${containerMoves}`);
        if ((counts as any).container_locked) lines.push(`**Containers Locked:** ${(counts as any).container_locked}`);
        if ((counts as any).container_unlocked)
          lines.push(`**Containers Unlocked:** ${(counts as any).container_unlocked}`);
        if ((counts as any).container_destroyed)
          lines.push(`**Containers Destroyed:** ${(counts as any).container_destroyed}`);

        // Inventory activity
        const invAdded = (counts as any).inventory_item_added || 0;
        const invRemoved = (counts as any).inventory_item_removed || 0;
        const invMoves = invAdded + invRemoved;
        if (invMoves > 0) lines.push(`**Inventory Changes:** ${invMoves}`);

        // Vehicle activity
        const vehAdded = (counts as any).vehicle_item_added || 0;
        const vehRemoved = (counts as any).vehicle_item_removed || 0;
        const vehMoves = vehAdded + vehRemoved;
        if (vehMoves > 0) lines.push(`**Vehicle Items Moved:** ${vehMoves}`);

        // Horse activity
        const horseEvents =
          ((counts as any).horse_appeared || 0) +
          ((counts as any).horse_disappeared || 0) +
          ((counts as any).horse_health_changed || 0) +
          ((counts as any).horse_owner_changed || 0);
        if (horseEvents > 0) lines.push(`**Horse Events:** ${horseEvents}`);

        // World events
        if ((counts as any).world_day_advanced) lines.push(`**Day Advanced:** ${(counts as any).world_day_advanced}`);
        if ((counts as any).world_season_changed)
          lines.push(`**Season Changes:** ${(counts as any).world_season_changed}`);
        const airdrops = ((counts as any).airdrop_spawned || 0) + ((counts as any).airdrop_despawned || 0);
        if (airdrops > 0) lines.push(`**Airdrop Events:** ${airdrops}`);
      }
    } catch (err: any) {
      this._log.warn('Could not query DB for daily summary:', err.message);
    }
  }

  const total = logTotal + dbTotal;
  if (total === 0) return; // nothing happened

  // Count unique players from playtime tracker for the daily footer.
  // Use yesterdayUnique (snapshotted before day-rollover reset) to avoid
  // a race where RCON polling resets uniqueToday before this runs.
  const peaks = this._playtime.getPeaks();
  const uniqueCount = peaks.yesterdayUnique || peaks.uniqueToday || 0;
  const footerParts = [`${total} total events`];
  if (uniqueCount > 0) footerParts.push(`${uniqueCount} unique players`);

  const serverLabel = this._getServerLabel();
  const serverSuffix = serverLabel ? ` [${serverLabel}]` : '';
  const embed = new EmbedBuilder()
    .setTitle(`Daily Summary — ${dateLabel}${serverSuffix}`)
    .setDescription(lines.join('\n'))
    .setColor(0x3498db)
    .setFooter({ text: footerParts.join(' · ') })
    .setTimestamp();

  try {
    const target = this._dailyThread || this.logChannel;
    await target.send({ embeds: [embed] });
  } catch (err: any) {
    this._log.error('Failed to post daily summary:', err.message);
  }
}

// ═════════════════════════════════════════════════════════════════════
//  Thread send helpers
// ═════════════════════════════════════════════════════════════════════
function sendToThread(this: any, embed: any) {
  return this._sendToThread(embed);
}

/**
 * Look up who recently accessed a container type (for attribution).
 * Returns { player, steamId, ownerSteamId } or null if no recent access.
 * @param {string} actorName - Raw UE4 actor name of the container
 * @returns {object|null}
 */
function getRecentContainerAccess(this: any, actorName: any) {
  if (!actorName || this._recentContainerAccess.size === 0) return null;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { cleanName } = require('../parsers/ue4-names') as { cleanName: (s: string) => string };
  const clean = cleanName(actorName).toLowerCase();
  // Check exact match first
  if (this._recentContainerAccess.has(clean)) {
    const entry = this._recentContainerAccess.get(clean);
    if (Date.now() - entry.timestamp < 5 * 60 * 1000) return entry;
  }
  // Fuzzy match: check if any tracked type is a substring
  for (const [key, entry] of this._recentContainerAccess) {
    if (Date.now() - entry.timestamp > 5 * 60 * 1000) continue;
    if (clean.includes(key) || key.includes(clean)) return entry;
  }
  return null;
}

/**
 * Send an embed to a specific date's activity thread (e.g. previous day).
 * Falls back to today's thread if the target thread cannot be found.
 * @param {EmbedBuilder} embed
 * @param {string} dateStr  YYYY-MM-DD date for the target thread
 */
async function sendToDateThread(this: any, embed: any, dateStr: any) {
  const today = this._config.getToday();
  // If it's today, just use normal sendToThread
  if (dateStr === today) return this.sendToThread(embed);

  if (!this._config.useActivityThreads || !this.logChannel) {
    return this.sendToThread(embed);
  }

  // Build the thread name for the target date
  const targetDate = new Date(dateStr + 'T12:00:00Z');
  const dateLabel = this._config.getDateLabel(targetDate);
  const serverLabel = this._getServerLabel();
  const serverSuffix = serverLabel ? ` [${serverLabel}]` : '';
  const threadName = `Daily Summary — ${dateLabel}${serverSuffix}`;
  const legacyThreadName = `📋 Activity Log — ${dateLabel}${serverSuffix}`;

  try {
    // Check active threads (search new name first, then legacy)
    const active = await this.logChannel.threads.fetchActive();
    const match =
      active.threads.find((t: any) => t.name === threadName) ||
      active.threads.find((t: any) => t.name === legacyThreadName);
    if (match) {
      return await match.send({ embeds: [embed] });
    }

    // Check recently archived threads
    const archived = await this.logChannel.threads.fetchArchived({ limit: 10 });
    const archiveMatch =
      archived.threads.find((t: any) => t.name === threadName) ||
      archived.threads.find((t: any) => t.name === legacyThreadName);
    if (archiveMatch) {
      await archiveMatch.setArchived(false);
      const result = await archiveMatch.send({ embeds: [embed] });
      // Re-archive after posting to keep it tidy
      await archiveMatch.setArchived(true).catch(() => {});
      return result;
    }
  } catch (err: any) {
    this._log.warn(`Could not find thread for ${dateStr}:`, err.message);
  }

  // Fallback: post to today's thread
  this._log.info(`No thread found for ${dateStr}, using today's thread`);
  return this.sendToThread(embed);
}

/** Clear cached thread reference so it will be re-fetched on next send. */
function resetThreadCache(this: any) {
  this._dailyThread = null;
  this._dailyDate = null;
}

async function _sendToThread(this: any, embed: any) {
  if (this._headless) return; // headless mode — no Discord posting
  const thread = await this._getOrCreateDailyThread();
  if (!thread) return; // safety — no thread available
  try {
    return await thread.send({ embeds: [embed] });
  } catch (err: any) {
    // Self-heal: if the thread was deleted/recreated (e.g. NUKE_BOT), clear cache and retry once
    if (err.code === 10003 || err.message?.includes('Unknown Channel')) {
      this._log.warn('Thread gone — clearing cache and retrying...');
      this.resetThreadCache();
      const fresh = await this._getOrCreateDailyThread();
      return fresh.send({ embeds: [embed] }).catch((retryErr: any) => {
        this._log.error('Failed to send to thread (retry):', retryErr.message);
      });
    }
    this._log.error('Failed to send to thread:', err.message);
  }
}

// ─── Exports ─────────────────────────────────────────────────────────

export {
  _checkDayRollover,
  _getOrCreateDailyThread,
  _postDailySummary,
  sendToThread,
  getRecentContainerAccess,
  sendToDateThread,
  resetThreadCache,
  _sendToThread,
};

const _mod = module as { exports: any };

_mod.exports = {
  _checkDayRollover,
  _getOrCreateDailyThread,
  _postDailySummary,
  sendToThread,
  getRecentContainerAccess,
  sendToDateThread,
  resetThreadCache,
  _sendToThread,
};
/* eslint-enable @typescript-eslint/no-unsafe-member-access */

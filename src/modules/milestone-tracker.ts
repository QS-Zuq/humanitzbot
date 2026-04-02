/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment,
   @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call,
   @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return,
   @typescript-eslint/restrict-template-expressions */

/**
 * Milestone Tracker — detects and announces player achievements in Discord.
 *
 * Hooks into SaveService 'sync' events to check cumulative stats (kills,
 * playtime, challenges, professions, skills) and into LogWatcher events
 * for real-time milestones (deaths → survival streaks).
 *
 * All announced milestones are stored in `bot_state` (key: 'milestones')
 * to avoid repeat announcements across restarts.
 *
 * Milestone types:
 *   - Kill milestones (100, 500, 1K, 5K, 10K, 25K, 50K, 100K)
 *   - Survival streaks (1, 3, 7, 14, 30, 60, 100 days without death)
 *   - Playtime milestones (1h, 6h, 12h, 24h, 48h, 100h, 250h, 500h, 1000h)
 *   - Challenge completions (Bear Hunter, Fish Master, etc.)
 *   - Profession unlocks (first player to unlock each profession)
 *   - Clan milestones (5, 10, 15 members)
 */

import { EmbedBuilder } from 'discord.js';
import { t, getLocale, fmtNumber } from '../i18n/index.js';
import { createLogger } from '../utils/log.js';

// ── Milestone Thresholds ─────────────────────────────────────────────────────

const KILL_THRESHOLDS = [100, 500, 1000, 5000, 10000, 25000, 50000, 100000];
const PLAYTIME_THRESHOLDS_MS = [
  1 * 3600000, //   1h
  6 * 3600000, //   6h
  12 * 3600000, //  12h
  24 * 3600000, //  24h
  48 * 3600000, //  48h
  100 * 3600000, // 100h
  250 * 3600000, // 250h
  500 * 3600000, // 500h
  1000 * 3600000, // 1000h
];
const SURVIVAL_THRESHOLDS = [1, 3, 7, 14, 30, 60, 100];
const CLAN_MEMBER_THRESHOLDS = [5, 10, 15, 20];

// ── Formatting helpers ───────────────────────────────────────────────────────

function _fmtKills(this: any, n: any, locale: any = 'en') {
  if (n >= 1000) return `${fmtNumber(Math.floor(n / 1000), locale)}K`;
  return fmtNumber(n, locale);
}

function _fmtHours(this: any, ms: any, locale: any = 'en') {
  const h = Math.floor(ms / 3600000);
  if (h >= 1000) return `${(h / 1000).toFixed(1)}K`;
  return fmtNumber(h, locale);
}

// ── State key for bot_state ──────────────────────────────────────────────────

const STATE_KEY = 'milestones';

/**
 * Load announced milestones from DB. Returns a structured object.
 * @param {object} db - HumanitZDB instance
 * @returns {object} { kills: {steamId: [thresholds]}, playtime: {steamId: [thresholds]},
 *                     survival: {steamId: [thresholds]}, challenges: {steamId: [names]},
 *                     firsts: {category: [names]}, clans: {clanName: [thresholds]} }
 */
function _loadState(this: any, db: any) {
  const defaults = { kills: {}, playtime: {}, survival: {}, challenges: {}, firsts: {}, clans: {} };
  if (!db) return defaults;
  try {
    const raw = db.getStateJSON(STATE_KEY, null);
    if (!raw) return defaults;
    // Merge with defaults so new categories are covered
    return { ...defaults, ...raw };
  } catch {
    return defaults;
  }
}

function _saveState(this: any, db: any, state: any) {
  if (!db) return;
  try {
    db.setStateJSON(STATE_KEY, state);
  } catch (err: any) {
    console.error('[MILESTONES] Failed to save state:', err.message);
  }
}

// ── MilestoneTracker class ───────────────────────────────────────────────────

class MilestoneTracker {
  [key: string]: any;
  /**
   * @param {object} client - Discord.js Client
   * @param {object} opts
   * @param {object} opts.db - HumanitZDB instance
   * @param {object} [opts.logWatcher] - LogWatcher for daily thread posting
   * @param {object} [opts.config] - config object (for timezone, channel ID)
   */
  constructor(client: any, opts: any = {}) {
    this._client = client;
    this._db = opts.db || null;
    this._logWatcher = opts.logWatcher || null;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    this._config = opts.config || require('../config');
    this._log = createLogger(opts.label, 'MILESTONES');
    this._locale = getLocale({ serverConfig: this._config });

    // In-memory state (loaded from DB on start)
    this._state = _loadState(this._db);

    // First-run detection: if no milestone state exists in DB, we need to
    // backfill (silently record existing milestones without announcing them)
    this._needsBackfill = !this._db || !this._db.getState(STATE_KEY);

    // Queue of milestone embeds to post (batched per sync)
    this._pendingEmbeds = [];

    // Count of embeds queued in the last check() cycle (for testing)
    this._lastCheckCount = 0;
  }

  // ── Lifecycle ──────────────────────────────────────────────

  /**
   * Check all players for milestones. Called on SaveService 'sync' events.
   *
   * On the very first check (no state in DB), performs a silent backfill:
   * records all existing milestones as "already announced" so only future
   * milestones trigger Discord announcements. This prevents a flood of
   * old achievements when the feature is first enabled on a populated server.
   *
   * @param {object} [syncResult] - SaveService sync result (unused, we read DB directly)
   */
  async check(_syncResult: any) {
    if (!this._db) return;
    this._lastCheckCount = 0;

    try {
      const players = this._db.getAllPlayers() || [];

      // First-run backfill: if no state existed in DB, silently record all
      // existing milestones without posting announcements
      const isBackfill = this._needsBackfill;

      let changed = false;

      for (const p of players) {
        const sid = p.steam_id;
        const name = p.name || sid;

        // Kill milestones — uses lifetime_kills (persists across deaths)
        if (this._checkKills(sid, name, p.lifetime_kills)) changed = true;

        // Playtime milestones — playtime_seconds from PlaytimeTracker
        if (p.playtime_seconds > 0) {
          if (this._checkPlaytime(sid, name, p.playtime_seconds * 1000)) changed = true;
        }

        // Survival milestones — days_survived (current life)
        if (this._checkSurvival(sid, name, p.days_survived)) changed = true;

        // Challenge completions
        if (this._checkChallenges(sid, name, p)) changed = true;

        // First-to-unlock professions
        if (this._checkFirsts(sid, name, p)) changed = true;
      }

      // Clan milestones
      if (this._checkClans()) changed = true;

      if (changed) {
        _saveState(this._db, this._state);
      }

      // On backfill, discard all queued embeds — don't announce old milestones
      if (isBackfill) {
        const count = this._pendingEmbeds.length;
        this._lastCheckCount = count;
        this._pendingEmbeds = [];
        this._needsBackfill = false;
        if (count > 0) {
          this._log.info(`First run — silently recorded ${count} existing milestones (no announcements)`);
        }
        return;
      }

      // Record count before posting (flush empties the array)
      this._lastCheckCount = this._pendingEmbeds.length;

      // Post queued embeds
      await this._flushEmbeds();
    } catch (err: any) {
      this._log.error('Check error:', err.message);
    }
  }

  // ── Kill milestones ────────────────────────────────────────

  _checkKills(steamId: any, name: any, kills: any) {
    if (!kills || kills <= 0) return false;
    let changed = false;
    if (!this._state.kills[steamId]) this._state.kills[steamId] = [];
    const announced = this._state.kills[steamId];

    for (const threshold of KILL_THRESHOLDS) {
      if (kills >= threshold && !announced.includes(threshold)) {
        announced.push(threshold);
        this._queueEmbed(
          t('discord:milestone_tracker.kill_milestone', this._locale, {
            name,
            kills: _fmtKills(threshold, this._locale),
          }),
          0x3fb950,
          `${fmtNumber(kills, this._locale)} total kills`,
        );
        changed = true;
      }
    }
    return changed;
  }

  // ── Playtime milestones ────────────────────────────────────

  _checkPlaytime(steamId: any, name: any, playtimeMs: any) {
    if (!playtimeMs || playtimeMs <= 0) return false;
    let changed = false;
    if (!this._state.playtime[steamId]) this._state.playtime[steamId] = [];
    const announced = this._state.playtime[steamId];

    for (const threshold of PLAYTIME_THRESHOLDS_MS) {
      if (playtimeMs >= threshold && !announced.includes(threshold)) {
        announced.push(threshold);
        this._queueEmbed(
          t('discord:milestone_tracker.playtime_milestone', this._locale, {
            name,
            hours: _fmtHours(threshold, this._locale),
          }),
          0x5865f2,
          `${_fmtHours(playtimeMs, this._locale)} hours total`,
        );
        changed = true;
      }
    }
    return changed;
  }

  // ── Survival streak milestones ─────────────────────────────

  _checkSurvival(steamId: any, name: any, daysSurvived: any) {
    if (!daysSurvived || daysSurvived <= 0) return false;
    let changed = false;
    if (!this._state.survival[steamId]) this._state.survival[steamId] = [];
    const announced = this._state.survival[steamId];

    for (const threshold of SURVIVAL_THRESHOLDS) {
      if (daysSurvived >= threshold && !announced.includes(threshold)) {
        announced.push(threshold);
        const label = threshold === 1 ? '1 day' : `${threshold} days`;
        this._queueEmbed(
          t('discord:milestone_tracker.survival_milestone', this._locale, { name, days: label }),
          0xf59e0b,
          `Day ${daysSurvived}`,
        );
        changed = true;
      }
    }
    return changed;
  }

  // ── Challenge completions ──────────────────────────────────

  _checkChallenges(steamId: any, name: any, player: any) {
    // challenges is a JSON array: [{ name, progress, total }] or similar
    let challenges;
    try {
      challenges = typeof player.challenges === 'string' ? JSON.parse(player.challenges) : player.challenges;
    } catch {
      return false;
    }
    if (!Array.isArray(challenges) || challenges.length === 0) return false;

    let changed = false;
    if (!this._state.challenges[steamId]) this._state.challenges[steamId] = [];
    const announced = this._state.challenges[steamId];

    for (const ch of challenges) {
      // A challenge is "complete" when progress >= total and total > 0
      const cName = ch.name || ch.id || 'Unknown';
      if (!ch.total || ch.total <= 0) continue;
      if (ch.progress < ch.total) continue;
      if (announced.includes(cName)) continue;

      announced.push(cName);
      this._queueEmbed(
        t('discord:milestone_tracker.challenge_completed', this._locale, { name, challenge_name: cName }),
        0xeab308,
        null,
      );
      changed = true;
    }
    return changed;
  }

  // ── First-to-unlock milestones ─────────────────────────────

  _checkFirsts(_steamId: any, name: any, player: any) {
    let changed = false;

    // Professions
    let profs;
    try {
      profs =
        typeof player.unlocked_professions === 'string'
          ? JSON.parse(player.unlocked_professions)
          : player.unlocked_professions;
    } catch {
      profs = [];
    }
    if (Array.isArray(profs) && profs.length > 0) {
      if (!this._state.firsts.profession) this._state.firsts.profession = [];
      const announcedProfs = this._state.firsts.profession;
      for (const prof of profs) {
        const profName = typeof prof === 'string' ? prof : String(prof);
        if (!profName || announcedProfs.includes(profName)) continue;
        announcedProfs.push(profName);
        this._queueEmbed(
          t('discord:milestone_tracker.first_profession_unlock', this._locale, {
            name,
            profession_name: profName,
          }),
          0xa855f7,
          null,
        );
        changed = true;
      }
    }

    return changed;
  }

  // ── Clan milestones ────────────────────────────────────────

  _checkClans() {
    if (!this._db) return false;
    let changed = false;

    try {
      const clans = this._db.getAllClans ? this._db.getAllClans() : [];
      if (!Array.isArray(clans) || clans.length === 0) return false;

      if (!this._state.clans) this._state.clans = {};

      for (const clan of clans) {
        const clanName = clan.name || 'Unknown';
        const memberCount = Array.isArray(clan.members) ? clan.members.length : 0;
        if (!this._state.clans[clanName]) this._state.clans[clanName] = [];
        const announced = this._state.clans[clanName];

        for (const threshold of CLAN_MEMBER_THRESHOLDS) {
          if (memberCount >= threshold && !announced.includes(threshold)) {
            announced.push(threshold);
            this._queueEmbed(
              t('discord:milestone_tracker.clan_milestone', this._locale, {
                clan_name: clanName,
                members: threshold,
              }),
              0x6366f1,
              `${memberCount} members total`,
            );
            changed = true;
          }
        }
      }
    } catch {
      // getClans may not exist on all DB versions
    }

    return changed;
  }

  // ── Survival streak reset (called from LogWatcher on death) ─

  /**
   * When a player dies, reset their survival milestones so they can
   * earn them again on their next life. Called externally by LogWatcher.
   * @param {string} steamId
   */
  onPlayerDeath(steamId: any) {
    if (!steamId) return;
    if (this._state.survival[steamId] && this._state.survival[steamId].length > 0) {
      this._state.survival[steamId] = [];
      _saveState(this._db, this._state);
    }
  }

  // ── Embed queueing & posting ───────────────────────────────

  _queueEmbed(description: any, color: any, footer: any) {
    const embed = new EmbedBuilder().setDescription(description).setColor(color).setTimestamp();
    if (footer) embed.setFooter({ text: footer });
    this._pendingEmbeds.push(embed);
  }

  /**
   * Post all queued milestone embeds to the activity thread.
   * Groups into batches of up to 10 (Discord embed limit per message).
   */
  async _flushEmbeds() {
    if (this._pendingEmbeds.length === 0) return;

    const embeds = this._pendingEmbeds.splice(0);
    const target = this._getPostTarget();
    if (!target) {
      this._log.warn(`No channel/thread available — ${embeds.length} milestones dropped`);
      return;
    }

    // Discord allows max 10 embeds per message
    for (let i = 0; i < embeds.length; i += 10) {
      const batch = embeds.slice(i, i + 10);
      try {
        await target.send({ embeds: batch });
      } catch (err: any) {
        this._log.error('Failed to post milestones:', err.message);
      }
    }
  }

  /**
   * Get the best channel/thread to post milestones to.
   * Prefers LogWatcher's daily thread, falls back to the log channel.
   */
  _getPostTarget() {
    // Use LogWatcher's daily thread if available
    if (this._logWatcher && this._logWatcher._dailyThread) {
      return this._logWatcher._dailyThread;
    }
    // Fall back to log channel
    if (this._logWatcher && this._logWatcher.logChannel) {
      return this._logWatcher.logChannel;
    }
    // Try fetching the log channel directly
    const channelId = this._config.logChannelId;
    if (channelId && this._client) {
      try {
        return this._client.channels.cache.get(channelId) || null;
      } catch {
        return null;
      }
    }
    return null;
  }

  // ── State access (for testing) ─────────────────────────────

  /** Get the current milestone state (for testing/debugging). */
  getState() {
    return this._state;
  }

  /** Get pending embeds count (for testing — may be 0 after flush). */
  getPendingCount() {
    return this._pendingEmbeds.length;
  }

  /** Get the number of milestones queued during the last check() call. */
  getLastCheckCount() {
    return this._lastCheckCount;
  }

  /** Clear all pending embeds (for testing). */
  clearPending() {
    this._pendingEmbeds = [];
  }

  static KILL_THRESHOLDS = KILL_THRESHOLDS;
  static PLAYTIME_THRESHOLDS_MS = PLAYTIME_THRESHOLDS_MS;
  static SURVIVAL_THRESHOLDS = SURVIVAL_THRESHOLDS;
  static CLAN_MEMBER_THRESHOLDS = CLAN_MEMBER_THRESHOLDS;
  static STATE_KEY = STATE_KEY;
}

// Export thresholds for testing

export default MilestoneTracker;

const _mod = module as { exports: any };
_mod.exports = MilestoneTracker;

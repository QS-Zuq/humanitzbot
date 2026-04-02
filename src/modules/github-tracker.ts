/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment,
   @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call,
   @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return,
   @typescript-eslint/restrict-plus-operands, @typescript-eslint/no-misused-promises, @typescript-eslint/use-unknown-in-catch-callback-variable */

/**
 * GitHub Tracker — polls GitHub API for repository changes (PRs, pushes) and
 * posts updates to per-repository Discord threads in a configured channel.
 *
 * One persistent thread is maintained per tracked repository.  The thread
 * name is derived from the repository's full name (e.g. "owner/repo").
 * Pull-request events (opened, closed, merged, reopened) and branch push
 * events (new commits) are posted as embeds.
 *
 * Configuration (.env):
 *   ENABLE_GITHUB_TRACKER=true
 *   GITHUB_TOKEN=ghp_...            (personal access token, optional but recommended)
 *   GITHUB_REPOS=owner/repo,owner2/repo2
 *   GITHUB_CHANNEL_ID=123456789
 *   GITHUB_POLL_INTERVAL=60000      (ms, min 30 000)
 *
 * @module github-tracker
 */

import { EmbedBuilder } from 'discord.js';
import { t, getLocale } from '../i18n/index.js';
import { createLogger } from '../utils/log.js';

// ── Colours ──────────────────────────────────────────────────────────────────

const COLOR_PR_OPEN = 0x238636; // green
const COLOR_PR_MERGED = 0x8957e5; // purple
const COLOR_PR_CLOSED = 0xe74c3c; // red
const COLOR_PUSH = 0x3498db; // blue

// ── GitHubTracker ─────────────────────────────────────────────────────────────

class GitHubTracker {
  [key: string]: any;
  /**
   * @param {import('discord.js').Client} client
   * @param {object} deps
   * @param {object} [deps.config]   — config module (defaults to ../config)
   * @param {object} [deps.db]       — HumanitZDB instance
   */
  constructor(client: any, deps: any = {}) {
    this.client = client;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    this._config = deps.config || require('../config');
    this._db = deps.db || null;
    this._log = createLogger(null, 'GITHUB');
    this._locale = getLocale({ serverConfig: this._config });

    /** @type {Map<string, import('discord.js').ThreadChannel>} repo → thread */
    this._threads = new Map();

    this._pollTimer = null;
    this._channel = null;

    // Persisted state: { [repo]: { lastPrId: number, lastCommitShas: string[] } }
    this._state = {};
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async start() {
    const channelId = this._config.githubChannelId;
    if (!channelId) {
      this._log.info('No GITHUB_CHANNEL_ID — skipping');
      return;
    }

    const repos = this._config.githubRepos;
    if (!repos || repos.length === 0) {
      this._log.info('No GITHUB_REPOS configured — skipping');
      return;
    }

    try {
      this._channel = await this.client.channels.fetch(channelId);
    } catch (err: any) {
      this._log.error(`Could not fetch channel ${channelId}:`, err.message);
      return;
    }

    if (!this._channel) {
      this._log.error(`GitHub channel not found (${channelId})`);
      return;
    }

    // Load saved state from DB
    this._state = this._loadState();

    // Ensure threads exist for each repo and bootstrap last-seen IDs
    for (const repo of repos) {
      await this._ensureThread(repo);
      await this._bootstrapRepo(repo);
    }

    // Start polling — run an initial poll immediately, then on each interval
    const interval = this._config.githubPollInterval;
    this._poll().catch((e: any) => this._log.error('Initial poll error:', e.message));
    this._pollTimer = setInterval(
      () => this._poll().catch((e: any) => this._log.error('Poll error:', e.message)),
      interval,
    );
    this._log.info(`Tracking ${repos.length} repo(s) — polling every ${interval / 1000}s`);
  }

  stop() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
    this._log.info('Stopped.');
  }

  // ── GitHub API ────────────────────────────────────────────────────────────

  /**
   * Thin wrapper around the GitHub REST API.
   * Exposed as an instance method so tests can override it.
   * @param {string} path  — e.g. "/repos/owner/repo/pulls"
   * @returns {Promise<Response>}
   */
  async _ghFetch(path: any) {
    const token = this._config.githubToken;
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    return fetch(`https://api.github.com${path}`, { headers });
  }

  // ── Polling ───────────────────────────────────────────────────────────────

  async _poll() {
    for (const repo of this._config.githubRepos) {
      try {
        await this._pollRepo(repo);
      } catch (err: any) {
        this._log.error(`Error polling ${repo}:`, err.message);
      }
    }
  }

  async _pollRepo(repo: any) {
    await Promise.all([this._pollPRs(repo), this._pollPushes(repo)]);
  }

  // ── Pull-request polling ───────────────────────────────────────────────────

  async _pollPRs(repo: any) {
    const res = await this._ghFetch(`/repos/${repo}/pulls?state=all&sort=updated&per_page=25`);
    if (!res.ok) {
      if (res.status !== 404) this._log.warn(`PR fetch for ${repo} returned ${res.status}`);
      return;
    }
    const prs = await res.json();
    if (!Array.isArray(prs)) return;

    const repoState = this._repoState(repo);
    const seenIds = new Set(repoState.seenPrIds || []);

    // Process in ascending ID order so the oldest new PR is posted first
    const newPrs = prs.filter((pr: any) => !seenIds.has(pr.number)).sort((a: any, b: any) => a.number - b.number);

    for (const pr of newPrs) {
      const embed = this._buildPrEmbed(repo, pr);
      await this._sendToThread(repo, embed);
      seenIds.add(pr.number);
    }

    // Also check for state changes on already-seen PRs that were recently updated
    const recentlyClosed = prs.filter(
      (pr) => seenIds.has(pr.number) && pr.state === 'closed' && !repoState.closedPrIds?.includes(pr.number),
    );
    const closedIds = new Set(repoState.closedPrIds || []);
    for (const pr of recentlyClosed) {
      const embed = this._buildPrEmbed(repo, pr);
      await this._sendToThread(repo, embed);
      closedIds.add(pr.number);
    }

    repoState.seenPrIds = [...seenIds];
    repoState.closedPrIds = [...closedIds];
    this._saveState();
  }

  // ── Push / commit polling ─────────────────────────────────────────────────

  async _pollPushes(repo: any) {
    const res = await this._ghFetch(`/repos/${repo}/commits?per_page=10`);
    if (!res.ok) {
      if (res.status !== 404) this._log.warn(`Commit fetch for ${repo} returned ${res.status}`);
      return;
    }
    const commits = await res.json();
    if (!Array.isArray(commits)) return;

    const repoState = this._repoState(repo);
    const seenShas = new Set(repoState.seenCommitShas || []);

    // Process oldest-first
    const newCommits = commits.filter((c: any) => !seenShas.has(c.sha)).reverse();

    for (const commit of newCommits) {
      const embed = this._buildCommitEmbed(repo, commit);
      await this._sendToThread(repo, embed);
      seenShas.add(commit.sha);
    }

    // Keep only the last 100 SHAs to prevent unbounded growth
    repoState.seenCommitShas = [...seenShas].slice(-100);
    this._saveState();
  }

  // ── Bootstrap (seed seen-IDs without posting anything) ────────────────────

  /**
   * On first run for a repo (no saved state), silently record the current set
   * of open PRs and recent commits so we only post genuinely new events going
   * forward.
   */
  async _bootstrapRepo(repo: any) {
    const repoState = this._repoState(repo);
    if (repoState.bootstrapped) return;

    // Seed PR IDs
    try {
      const res = await this._ghFetch(`/repos/${repo}/pulls?state=all&sort=updated&per_page=50`);
      if (res.ok) {
        const prs = await res.json();
        if (Array.isArray(prs)) {
          repoState.seenPrIds = prs.map((pr: any) => pr.number);
          repoState.closedPrIds = prs.filter((pr: any) => pr.state === 'closed').map((pr: any) => pr.number);
        }
      }
    } catch (_: any) {}

    // Seed commit SHAs
    try {
      const res = await this._ghFetch(`/repos/${repo}/commits?per_page=25`);
      if (res.ok) {
        const commits = await res.json();
        if (Array.isArray(commits)) {
          repoState.seenCommitShas = commits.map((c: any) => c.sha);
        }
      }
    } catch (_: any) {}

    repoState.bootstrapped = true;
    this._saveState();
    this._log.info(
      `Bootstrapped ${repo} (${(repoState.seenPrIds || []).length} PR(s), ${(repoState.seenCommitShas || []).length} commit(s))`,
    );
  }

  // ── Thread management ─────────────────────────────────────────────────────

  async _ensureThread(repo: any) {
    if (this._threads.has(repo)) return this._threads.get(repo);

    const threadName = this._threadName(repo);

    // Search active threads
    try {
      const active = await this._channel.threads.fetchActive();
      const found = active.threads.find((th: any) => th.name === threadName);
      if (found) {
        this._threads.set(repo, found);
        this._log.info(`Using existing thread for ${repo}: ${threadName}`);
        return found;
      }
    } catch (err: any) {
      this._log.warn('Could not list active threads:', err.message);
    }

    // Search archived threads
    try {
      const archived = await this._channel.threads.fetchArchived({ limit: 25 });
      const found = archived.threads.find((th: any) => th.name === threadName);
      if (found) {
        await found.setArchived(false).catch(() => {});
        this._threads.set(repo, found);
        this._log.info(`Unarchived thread for ${repo}: ${threadName}`);
        return found;
      }
    } catch (err: any) {
      this._log.warn('Could not search archived threads:', err.message);
    }

    // Create a new thread
    try {
      const starterEmbed = new EmbedBuilder()
        .setTitle(t('discord:github_tracker.thread_title', this._locale, { repo }))
        .setDescription(t('discord:github_tracker.thread_description', this._locale, { repo }))
        .setColor(COLOR_PUSH)
        .setTimestamp();

      const starterMsg = await this._channel.send({ embeds: [starterEmbed] });
      const thread = await starterMsg.startThread({
        name: threadName,
        autoArchiveDuration: 10080, // 7 days
        reason: t('discord:github_tracker.thread_reason', this._locale, { repo }),
      });
      this._threads.set(repo, thread);
      this._log.info(`Created thread for ${repo}: ${threadName}`);
      return thread;
    } catch (err: any) {
      this._log.error(`Failed to create thread for ${repo}:`, err.message);
      // Fallback to main channel
      this._threads.set(repo, this._channel);
      return this._channel;
    }
  }

  async _sendToThread(repo: any, embed: any) {
    const thread = await this._ensureThread(repo);
    if (!thread) return;
    try {
      await thread.send({ embeds: [embed] });
    } catch (err: any) {
      // Thread may have been deleted — clear cache and retry once
      if (err.code === 10003 || err.message?.includes('Unknown Channel')) {
        this._threads.delete(repo);
        const fresh = await this._ensureThread(repo);
        if (fresh)
          await fresh.send({ embeds: [embed] }).catch((e: any) => this._log.error('Retry send failed:', e.message));
      } else {
        this._log.error(`Failed to send embed for ${repo}:`, err.message);
      }
    }
  }

  // ── Embed builders ────────────────────────────────────────────────────────

  _buildPrEmbed(repo: any, pr: any) {
    const isMerged = pr.pull_request?.merged_at != null || pr.merged_at != null || pr.merged;
    const isClosed = pr.state === 'closed';
    const color = isMerged ? COLOR_PR_MERGED : isClosed ? COLOR_PR_CLOSED : COLOR_PR_OPEN;

    let statusKey;
    if (isMerged) statusKey = 'discord:github_tracker.pr_merged';
    else if (isClosed) statusKey = 'discord:github_tracker.pr_closed';
    else statusKey = 'discord:github_tracker.pr_opened';

    const status = t(statusKey, this._locale);
    const author = pr.user?.login || t('discord:github_tracker.unknown_author', this._locale);
    const body = pr.body ? pr.body.slice(0, 300) + (pr.body.length > 300 ? '…' : '') : '';
    const avatarUrl = pr.user?.avatar_url || undefined;

    const embed = new EmbedBuilder()
      .setTitle(`${status} #${pr.number}: ${pr.title}`)
      .setURL(pr.html_url)
      .setColor(color)
      .setAuthor({ name: author, url: `https://github.com/${author}`, ...(avatarUrl ? { iconURL: avatarUrl } : {}) })
      .setTimestamp(new Date(pr.updated_at));

    if (body) embed.setDescription(body);

    embed.addFields(
      {
        name: t('discord:github_tracker.repository', this._locale),
        value: `[${repo}](https://github.com/${repo})`,
        inline: true,
      },
      { name: t('discord:github_tracker.branch', this._locale), value: pr.head?.ref || '—', inline: true },
    );

    const labels = (pr.labels || []).map((l: any) => l.name).join(', ');
    if (labels)
      embed.addFields({ name: t('discord:github_tracker.labels', this._locale), value: labels, inline: true });

    return embed;
  }

  _buildCommitEmbed(repo: any, commit: any) {
    const message = commit.commit?.message || '';
    const title = message.split('\n')[0].slice(0, 100);
    const body = message.split('\n').slice(1).join('\n').trim().slice(0, 300);
    const author =
      commit.author?.login || commit.commit?.author?.name || t('discord:github_tracker.unknown_author', this._locale);
    const shortSha = commit.sha?.slice(0, 7) || '';
    const avatarUrl = commit.author?.avatar_url || undefined;

    const embed = new EmbedBuilder()
      .setTitle(`📦 ${shortSha}: ${title}`)
      .setURL(commit.html_url)
      .setColor(COLOR_PUSH)
      .setAuthor({ name: author, url: `https://github.com/${author}`, ...(avatarUrl ? { iconURL: avatarUrl } : {}) })
      .addFields({
        name: t('discord:github_tracker.repository', this._locale),
        value: `[${repo}](https://github.com/${repo})`,
        inline: true,
      })
      .setTimestamp(new Date(commit.commit?.author?.date || Date.now()));

    if (body) embed.setDescription(body);

    return embed;
  }

  // ── State helpers ─────────────────────────────────────────────────────────

  _repoState(repo: any) {
    if (!this._state[repo]) this._state[repo] = {};
    return this._state[repo];
  }

  _loadState() {
    if (!this._db) return {};
    try {
      return this._db.getStateJSON('github_tracker', {}) || {};
    } catch {
      return {};
    }
  }

  _saveState() {
    if (!this._db) return;
    try {
      this._db.setStateJSON('github_tracker', this._state);
    } catch (err: any) {
      this._log.warn('Could not save state:', err.message);
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  _threadName(repo: any) {
    // Normalize repo to something Discord allows: max 100 chars, readable
    return `gh: ${repo}`.slice(0, 100);
  }
}

export { GitHubTracker };

const _mod = module as { exports: any };
_mod.exports = GitHubTracker;

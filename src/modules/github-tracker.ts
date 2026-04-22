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

import { EmbedBuilder, type Client, type Message } from 'discord.js';
import { t, getLocale } from '../i18n/index.js';
import { createLogger, type Logger } from '../utils/log.js';
import { errMsg } from '../utils/error.js';
import _defaultConfig from '../config/index.js';

// ── Colours ──────────────────────────────────────────────────────────────────

const COLOR_PR_OPEN = 0x238636; // green
const COLOR_PR_MERGED = 0x8957e5; // purple
const COLOR_PR_CLOSED = 0xe74c3c; // red
const COLOR_PUSH = 0x3498db; // blue

// ── Types ────────────────────────────────────────────────────────────────────

type ConfigType = typeof _defaultConfig;

interface GitHubTrackerDeps {
  config?: ConfigType;
  db?: GitHubTrackerDB | null;
}

interface GitHubTrackerDB {
  botState: {
    getStateJSON(key: string, defaultVal: unknown): unknown;
    setStateJSON(key: string, value: unknown): void;
  };
}

interface ThreadLike {
  send(options: unknown): Promise<Message>;
  name?: string;
  setArchived?(archived: boolean): Promise<unknown>;
}

interface ChannelLike extends ThreadLike {
  threads: {
    fetchActive(): Promise<{ threads: Map<string, ThreadLike> }>;
    fetchArchived(opts: { limit: number }): Promise<{ threads: Map<string, ThreadLike> }>;
  };
}

interface RepoState {
  seenPrIds?: number[];
  closedPrIds?: number[];
  seenCommitShas?: string[];
  bootstrapped?: boolean;
  _bootstrapAttempts?: number;
}

interface GhPullRequest {
  number: number;
  title: string;
  state: string;
  body: string | null;
  html_url: string;
  updated_at: string;
  merged_at?: string | null;
  merged?: boolean;
  pull_request?: { merged_at?: string | null };
  user?: { login: string; avatar_url?: string } | null;
  head?: { ref: string } | null;
  labels?: Array<{ name: string }>;
}

interface GhCommit {
  sha: string;
  html_url: string;
  commit?: {
    message?: string;
    author?: { name?: string; date?: string };
  };
  author?: { login?: string; avatar_url?: string } | null;
}

// ── GitHubTracker ─────────────────────────────────────────────────────────────

class GitHubTracker {
  private client: Client;
  private _config: ConfigType;
  private _db: GitHubTrackerDB | null;
  private _log: Logger;
  private _locale: string;
  private _threads: Map<string, ThreadLike>;
  private _pollTimer: ReturnType<typeof setInterval> | null;
  private _channel: ChannelLike | null;
  private _state: Record<string, RepoState>;
  private _polling: boolean;

  constructor(client: Client, deps: GitHubTrackerDeps = {}) {
    this.client = client;
    this._config = deps.config ?? _defaultConfig;
    this._db = deps.db ?? null;
    this._log = createLogger(null, 'GITHUB');
    this._locale = getLocale({ serverConfig: this._config });

    this._threads = new Map();

    this._pollTimer = null;
    this._channel = null;

    // Persisted state: { [repo]: { lastPrId: number, lastCommitShas: string[] } }
    this._state = {};

    this._polling = false;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async start() {
    const channelId = this._config.githubChannelId;
    if (!channelId) {
      this._log.info('No GITHUB_CHANNEL_ID — skipping');
      return;
    }

    const repos = this._config.githubRepos;
    if (repos.length === 0) {
      this._log.info('No GITHUB_REPOS configured — skipping');
      return;
    }

    try {
      this._channel = (await this.client.channels.fetch(channelId)) as ChannelLike | null;
    } catch (err: unknown) {
      this._log.error(`Could not fetch channel ${channelId}:`, errMsg(err));
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
    void this._poll().catch((e: unknown) => {
      this._log.error('Initial poll error:', errMsg(e));
    });
    this._pollTimer = setInterval(
      () =>
        void this._poll().catch((e: unknown) => {
          this._log.error('Poll error:', errMsg(e));
        }),
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
   */
  async _ghFetch(path: string): Promise<Response> {
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
    if (this._polling) {
      // Previous poll still running (slow GitHub response, many repos) — skip
      // this tick to avoid overlapping fetches and repeated bootstrap retries.
      return;
    }
    this._polling = true;
    try {
      for (const repo of this._config.githubRepos) {
        try {
          await this._pollRepo(repo);
        } catch (err: unknown) {
          this._log.error(`Error polling ${repo}:`, errMsg(err));
        }
      }
    } finally {
      this._polling = false;
    }
  }

  async _pollRepo(repo: string) {
    const repoState = this._repoState(repo);
    if (!repoState.bootstrapped) {
      // Not yet bootstrapped — retry seeding instead of entering normal poll,
      // otherwise pre-existing PRs/commits would be re-announced as "new".
      await this._bootstrapRepo(repo);
      return;
    }
    await Promise.all([this._pollPRs(repo), this._pollPushes(repo)]);
  }

  // ── Pull-request polling ───────────────────────────────────────────────────

  async _pollPRs(repo: string) {
    const res = await this._ghFetch(`/repos/${repo}/pulls?state=all&sort=updated&per_page=25`);
    if (!res.ok) {
      if (res.status !== 404) this._log.warn(`PR fetch for ${repo} returned ${res.status}`);
      return;
    }
    const prs = await res.json();
    if (!Array.isArray(prs)) return;

    const repoState = this._repoState(repo);
    const seenIds = new Set(repoState.seenPrIds ?? []);

    // Process in ascending ID order so the oldest new PR is posted first
    const newPrs = (prs as GhPullRequest[]).filter((pr) => !seenIds.has(pr.number)).sort((a, b) => a.number - b.number);

    for (const pr of newPrs) {
      const embed = this._buildPrEmbed(repo, pr);
      await this._sendToThread(repo, embed);
      seenIds.add(pr.number);
    }

    // Also check for state changes on already-seen PRs that were recently updated
    const recentlyClosed = (prs as GhPullRequest[]).filter(
      (pr) => seenIds.has(pr.number) && pr.state === 'closed' && !repoState.closedPrIds?.includes(pr.number),
    );
    const closedIds = new Set(repoState.closedPrIds ?? []);
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

  async _pollPushes(repo: string) {
    const res = await this._ghFetch(`/repos/${repo}/commits?per_page=10`);
    if (!res.ok) {
      if (res.status !== 404) this._log.warn(`Commit fetch for ${repo} returned ${res.status}`);
      return;
    }
    const commits = await res.json();
    if (!Array.isArray(commits)) return;

    const repoState = this._repoState(repo);
    const seenShas = new Set(repoState.seenCommitShas ?? []);

    // Process oldest-first
    const newCommits = (commits as GhCommit[]).filter((c) => !seenShas.has(c.sha)).reverse();

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
  async _bootstrapRepo(repo: string) {
    const repoState = this._repoState(repo);
    if (repoState.bootstrapped) return;

    // Throttle bootstrap warnings so they don't spam forever when GitHub is
    // unreachable for long periods. Keep retrying (bounded by poll interval);
    // do NOT force-mark bootstrapped=true on failure, which would re-announce
    // all existing PRs/commits once connectivity is restored.
    const attemptsSoFar = repoState._bootstrapAttempts ?? 0;
    const shouldWarn = attemptsSoFar < 5;

    let prFetched = false;
    let commitFetched = false;

    // Seed PR IDs
    try {
      const res = await this._ghFetch(`/repos/${repo}/pulls?state=all&sort=updated&per_page=50`);
      if (res.ok) {
        const prs = await res.json();
        if (Array.isArray(prs)) {
          repoState.seenPrIds = (prs as GhPullRequest[]).map((pr) => pr.number);
          repoState.closedPrIds = (prs as GhPullRequest[]).filter((pr) => pr.state === 'closed').map((pr) => pr.number);
          prFetched = true;
        } else if (shouldWarn) {
          this._log.warn(`[github-tracker:bootstrap-pr] ${repo}: unexpected non-array response body`);
        }
      } else if (shouldWarn) {
        this._log.warn(`[github-tracker:bootstrap-pr] ${repo}: HTTP ${String(res.status)}`);
      }
    } catch (err: unknown) {
      if (shouldWarn) {
        this._log.warn(`[github-tracker:bootstrap-pr] ${repo}: ${errMsg(err)}`);
      }
    }

    // Seed commit SHAs
    try {
      const res = await this._ghFetch(`/repos/${repo}/commits?per_page=25`);
      if (res.ok) {
        const commits = await res.json();
        if (Array.isArray(commits)) {
          repoState.seenCommitShas = (commits as GhCommit[]).map((c) => c.sha);
          commitFetched = true;
        } else if (shouldWarn) {
          this._log.warn(`[github-tracker:bootstrap-commit] ${repo}: unexpected non-array response body`);
        }
      } else if (shouldWarn) {
        this._log.warn(`[github-tracker:bootstrap-commit] ${repo}: HTTP ${String(res.status)}`);
      }
    } catch (err: unknown) {
      if (shouldWarn) {
        this._log.warn(`[github-tracker:bootstrap-commit] ${repo}: ${errMsg(err)}`);
      }
    }

    if (prFetched && commitFetched) {
      repoState.bootstrapped = true;
      repoState._bootstrapAttempts = 0;
      this._saveState();
      this._log.info(
        `Bootstrapped ${repo} (${String((repoState.seenPrIds ?? []).length)} PR(s), ${String((repoState.seenCommitShas ?? []).length)} commit(s))`,
      );
      return;
    }

    const attempts = attemptsSoFar + 1;
    repoState._bootstrapAttempts = attempts;
    if (attempts === 5) {
      this._log.warn(
        `[github-tracker:bootstrap] ${repo}: ${String(attempts)} failed attempt(s) \u2014 further warnings silenced until bootstrap succeeds`,
      );
    }
    this._saveState();
  }

  // ── Thread management ─────────────────────────────────────────────────────

  async _ensureThread(repo: string): Promise<ThreadLike | undefined> {
    if (this._threads.has(repo)) return this._threads.get(repo);
    if (!this._channel) return undefined;

    const threadName = this._threadName(repo);

    // Search active threads
    try {
      const active = await this._channel.threads.fetchActive();
      const found = [...active.threads.values()].find((th) => th.name === threadName);
      if (found) {
        this._threads.set(repo, found);
        this._log.info(`Using existing thread for ${repo}: ${threadName}`);
        return found;
      }
    } catch (err: unknown) {
      this._log.warn('Could not list active threads:', errMsg(err));
    }

    // Search archived threads
    try {
      const archived = await this._channel.threads.fetchArchived({ limit: 25 });
      const found = [...archived.threads.values()].find((th) => th.name === threadName);
      if (found) {
        if (found.setArchived) await found.setArchived(false).catch(() => {});
        this._threads.set(repo, found);
        this._log.info(`Unarchived thread for ${repo}: ${threadName}`);
        return found;
      }
    } catch (err: unknown) {
      this._log.warn('Could not search archived threads:', errMsg(err));
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
      this._threads.set(repo, thread as ThreadLike);
      this._log.info(`Created thread for ${repo}: ${threadName}`);
      return thread as ThreadLike;
    } catch (err: unknown) {
      this._log.error(`Failed to create thread for ${repo}:`, errMsg(err));
      // Fallback to main channel
      this._threads.set(repo, this._channel);
      return this._channel;
    }
  }

  async _sendToThread(repo: string, embed: EmbedBuilder) {
    const thread = await this._ensureThread(repo);
    if (!thread) return;
    try {
      await thread.send({ embeds: [embed] });
    } catch (err: unknown) {
      const e = err as { code?: number; message?: string };
      // Thread may have been deleted — clear cache and retry once
      if (e.code === 10003 || e.message?.includes('Unknown Channel')) {
        this._threads.delete(repo);
        const fresh = await this._ensureThread(repo);
        if (fresh)
          await fresh.send({ embeds: [embed] }).catch((retryErr: unknown) => {
            this._log.error('Retry send failed:', errMsg(retryErr));
          });
      } else {
        this._log.error(`Failed to send embed for ${repo}:`, errMsg(err));
      }
    }
  }

  // ── Embed builders ────────────────────────────────────────────────────────

  _buildPrEmbed(repo: string, pr: GhPullRequest): EmbedBuilder {
    const isMerged = pr.pull_request?.merged_at != null || pr.merged_at != null || pr.merged === true;
    const isClosed = pr.state === 'closed';
    const color = isMerged ? COLOR_PR_MERGED : isClosed ? COLOR_PR_CLOSED : COLOR_PR_OPEN;

    let statusKey: string;
    if (isMerged) statusKey = 'discord:github_tracker.pr_merged';
    else if (isClosed) statusKey = 'discord:github_tracker.pr_closed';
    else statusKey = 'discord:github_tracker.pr_opened';

    const status = t(statusKey, this._locale);
    const author = pr.user?.login ?? t('discord:github_tracker.unknown_author', this._locale);
    const body = pr.body ? pr.body.slice(0, 300) + (pr.body.length > 300 ? '…' : '') : '';
    const avatarUrl = pr.user?.avatar_url ?? undefined;

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
      { name: t('discord:github_tracker.branch', this._locale), value: pr.head?.ref ?? '—', inline: true },
    );

    const labels = (pr.labels ?? []).map((l) => l.name).join(', ');
    if (labels)
      embed.addFields({ name: t('discord:github_tracker.labels', this._locale), value: labels, inline: true });

    return embed;
  }

  _buildCommitEmbed(repo: string, commit: GhCommit): EmbedBuilder {
    const message = commit.commit?.message ?? '';
    const title = (message.split('\n')[0] ?? '').slice(0, 100);
    const body = message.split('\n').slice(1).join('\n').trim().slice(0, 300);
    const author =
      commit.author?.login ?? commit.commit?.author?.name ?? t('discord:github_tracker.unknown_author', this._locale);
    const shortSha = commit.sha.slice(0, 7);
    const avatarUrl = commit.author?.avatar_url ?? undefined;

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
      .setTimestamp(new Date(commit.commit?.author?.date ?? Date.now()));

    if (body) embed.setDescription(body);

    return embed;
  }

  // ── State helpers ─────────────────────────────────────────────────────────

  _repoState(repo: string): RepoState {
    if (!this._state[repo]) this._state[repo] = {};
    return this._state[repo];
  }

  _loadState(): Record<string, RepoState> {
    if (!this._db) return {};
    try {
      return this._db.botState.getStateJSON('github_tracker', {}) as Record<string, RepoState>;
    } catch {
      return {};
    }
  }

  _saveState() {
    if (!this._db) return;
    try {
      this._db.botState.setStateJSON('github_tracker', this._state);
    } catch (err: unknown) {
      this._log.warn('Could not save state:', errMsg(err));
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  _threadName(repo: string): string {
    // Normalize repo to something Discord allows: max 100 chars, readable
    return `gh: ${repo}`.slice(0, 100);
  }
}

export default GitHubTracker;
export { GitHubTracker };

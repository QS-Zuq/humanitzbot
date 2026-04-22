/**
 * Activity Log — save-file change tracking, posted to the daily thread.
 *
 * Listens for SaveService 'sync' events containing diffEvents and posts
 * batched embeds to the LogWatcher's daily activity thread.  Shows item
 * movements between containers, player inventory changes, horse state,
 * vehicle trunk changes, and world events (airdrops, day/season changes).
 *
 * Privacy model:
 *   - Container and world events: visible to all (public data)
 *   - Player inventory changes: only posted if SHOW_INVENTORY_LOG=true
 *   - Horse events: visible to all
 *   - Vehicle trunk changes: visible to all
 *
 * Usage:
 *   const ActivityLog = require('./activity-log');
 *   const activityLog = new ActivityLog(client, { db, saveService, logWatcher });
 *   activityLog.start();
 *
 * @module activity-log
 */

import { EmbedBuilder, type Client } from 'discord.js';
import config from '../config/index.js';
import { createLogger, type Logger } from '../utils/log.js';
import { cleanName, cleanItemName } from '../parsers/ue4-names.js';
import { t, getLocale, fmtNumber } from '../i18n/index.js';
import { errMsg } from '../utils/error.js';
import { logRejection } from '../utils/log-rejection.js';

function _activityLocale(): string {
  return getLocale();
}

// ─── Types ─────────────────────────────────────────────────────────────────

/** Channel-like object with a send method. */
interface Sendable {
  name?: string;
  send(options: { embeds: EmbedBuilder[] }): Promise<unknown>;
}

interface DiffEvent {
  type: string;
  category?: string;
  actor?: string;
  actorName?: string;
  item?: string;
  amount?: number;
  x?: number | null;
  y?: number | null;
  pos_x?: number | null;
  pos_y?: number | null;
  details?: Record<string, unknown>;
  attributedPlayer?: string;
  attributedSteamId?: string;
}

interface SyncResult {
  diffEvents?: DiffEvent[];
  syncTime?: Date;
}

interface ActivityLogWatcher {
  sendToThread(embed: EmbedBuilder): Promise<void>;
  getRecentContainerAccess(actor: string): { player: string } | null;
}

interface ActivitySaveService {
  on(event: string, handler: (result: SyncResult) => void): void;
  removeListener(event: string, handler: (result: SyncResult) => void): void;
}

interface ItemBatch {
  event: DiffEvent;
  items: Array<{
    item: string;
    amount?: number;
    durability?: number;
    attributedPlayer?: string;
    attributedSteamId?: string;
  }>;
}

interface CollapsedBatch {
  event: DiffEvent;
  count: number;
  isCollapsed: true;
}

type EventBatch = ItemBatch | CollapsedBatch;

// ─── Category colours ───────────────────────────────────────────────────────

const CATEGORY_COLORS: Record<string, number> = {
  container: 0xe67e22, // Orange
  inventory: 0x3498db, // Blue
  horse: 0x2ecc71, // Green
  vehicle: 0x9b59b6, // Purple
  world: 0xf1c40f, // Gold
  structure: 0xe74c3c, // Red
};

// ─── Category emoji ─────────────────────────────────────────────────────────

const EVENT_EMOJI: Record<string, string> = {
  container_item_added: '📦',
  container_item_removed: '📦',
  container_locked: '🔒',
  container_unlocked: '🔓',
  container_destroyed: '💥',
  inventory_item_added: '🎒',
  inventory_item_removed: '🎒',
  horse_appeared: '🐴',
  horse_disappeared: '🐴',
  horse_health_changed: '🐴',
  horse_owner_changed: '🐴',
  horse_item_added: '🐴',
  horse_item_removed: '🐴',
  vehicle_item_added: '🚗',
  vehicle_item_removed: '🚗',
  vehicle_health_changed: '🚗',
  vehicle_fuel_changed: '⛽',
  vehicle_appeared: '🚗',
  vehicle_destroyed: '💥',
  structure_damaged: '🏚️',
  structure_destroyed: '💥',
  structure_upgraded: '🔨',
  structure_built: '🏗️',
  airdrop_spawned: '🪂',
  airdrop_despawned: '🪂',
  world_day_advanced: '🌅',
  world_season_changed: '🍂',
};

class ActivityLog {
  private _client: Client;
  private _saveService: ActivitySaveService | null;
  private _logWatcher: ActivityLogWatcher | null;
  private _log: Logger;
  private _channel: Sendable | null;
  private _started: boolean;
  private _syncHandler: ((result: SyncResult) => void) | null;

  /**
   * @param client  Discord.js Client
   * @param options Module dependencies
   */
  constructor(
    client: Client,
    options: {
      db?: unknown;
      saveService?: ActivitySaveService | null;
      logWatcher?: unknown;
      label?: string;
    } = {},
  ) {
    this._client = client;
    this._saveService = options.saveService ?? null;
    this._logWatcher = (options.logWatcher as ActivityLogWatcher | null) ?? null;
    this._log = createLogger(options.label, 'ActivityLog');
    this._channel = null; // fallback channel when no logWatcher
    this._started = false;
    this._syncHandler = null;
  }

  async start(): Promise<void> {
    if (this._started) return;
    this._started = true;

    // If we have a LogWatcher, we route embeds to its daily thread — no channel needed
    if (!this._logWatcher) {
      const channelId = config.activityLogChannelId || config.adminChannelId;
      if (!channelId) {
        this._log.info('No logWatcher or channel configured \u2014 activity log disabled');
        return;
      }
      try {
        const fetched = await this._client.channels.fetch(channelId);
        if (!fetched) {
          this._log.warn(`Channel ${channelId} not found`);
          return;
        }
        this._channel = fetched as Sendable;
      } catch (err: unknown) {
        this._log.warn(`Failed to fetch channel ${channelId}:`, errMsg(err));
        return;
      }
    }

    // Listen for save sync events
    if (this._saveService) {
      this._syncHandler = (result: SyncResult) => {
        logRejection(this._onSync(result), this._log, 'activity-log:on-sync');
      };
      this._saveService.on('sync', this._syncHandler);
    }

    const channelName = this._channel?.name ?? 'unknown';
    const target = this._logWatcher ? 'daily thread (via LogWatcher)' : `#${channelName}`;
    this._log.info(`Started \u2014 posting to ${target}`);
  }

  stop(): void {
    this._started = false;
    if (this._saveService && this._syncHandler) {
      this._saveService.removeListener('sync', this._syncHandler);
      this._syncHandler = null;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Event handling
  // ═══════════════════════════════════════════════════════════════════════════

  async _onSync(result: SyncResult): Promise<void> {
    if (!result.diffEvents || result.diffEvents.length === 0) return;
    if (!this._logWatcher && !this._channel) return;

    try {
      const syncTime = result.syncTime ?? new Date();

      // Cap events to prevent OOM/rate-limit on first-sync diff storms
      const maxEvents = 200;
      const events = result.diffEvents.length > maxEvents ? result.diffEvents.slice(0, maxEvents) : result.diffEvents;

      const embeds = this._buildEmbeds(events, syncTime);

      // Send embeds with a small delay between each to avoid Discord rate limits
      for (const embed of embeds) {
        try {
          if (this._logWatcher) {
            await this._logWatcher.sendToThread(embed);
          } else if (this._channel) {
            await this._channel.send({ embeds: [embed] });
          }
        } catch (sendErr: unknown) {
          // Log individual embed failures but continue sending the rest
          this._log.warn('Embed send failed (continuing):', errMsg(sendErr));
        }
        // Small delay to respect Discord rate limits (1 embed per 500ms)
        if (embeds.length > 3) {
          await new Promise<void>((r) => setTimeout(r, 500));
        }
      }

      if (result.diffEvents.length > maxEvents) {
        this._log.info(`Capped activity batch: ${result.diffEvents.length} events \u2192 ${maxEvents} posted`);
      }
    } catch (err: unknown) {
      this._log.warn('Failed to post activity:', errMsg(err));
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Embed building
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Build Discord embeds from a list of diff events.
   * Groups events by category and builds one embed per category.
   * Filters out events based on config toggles.
   */
  _buildEmbeds(events: DiffEvent[], syncTime: Date): EmbedBuilder[] {
    const embeds: EmbedBuilder[] = [];
    const filtered = this._filterEvents(events);
    if (filtered.length === 0) return embeds;

    // Format sync timestamp for per-event display
    const timeStr = _formatTime(syncTime);

    // Group by category
    const groups = new Map<string, DiffEvent[]>();
    for (const event of filtered) {
      const cat = event.category ?? 'other';
      const existing = groups.get(cat);
      if (existing) {
        existing.push(event);
      } else {
        groups.set(cat, [event]);
      }
    }

    for (const [category, catEvents] of groups) {
      const embed = this._buildCategoryEmbed(category, catEvents, timeStr);
      if (embed) embeds.push(embed);
    }

    return embeds;
  }

  /**
   * Filter events based on config toggles.
   */
  _filterEvents(events: DiffEvent[]): DiffEvent[] {
    return events.filter((e) => {
      if (e.category === 'inventory') return config.showInventoryLog;
      if (e.category === 'container') return config.enableContainerLog;
      if (e.category === 'horse') return config.enableHorseLog;
      if (e.category === 'vehicle') return config.enableVehicleLog;
      if (e.category === 'world') return config.enableWorldEventFeed;
      if (e.category === 'structure')
        return (config as typeof config & Record<string, unknown>).enableStructureLog !== false;
      return true;
    });
  }

  /**
   * Build one embed for a category of events.
   * Events are batched by actor and formatted with clean names.
   */
  _buildCategoryEmbed(category: string, events: DiffEvent[], timeStr: string): EmbedBuilder | null {
    const clr = CATEGORY_COLORS[category] ?? 0x95a5a6;
    const title = _categoryTitle(category);

    const lines: string[] = [];
    const batchedItems = new Map<string, EventBatch>();

    for (const event of events) {
      const key = `${String(event.actor)}::${event.type}`;

      if (event.item) {
        if (!batchedItems.has(key)) {
          batchedItems.set(key, { event, items: [] });
        }
        const batch = batchedItems.get(key);
        if (batch && 'items' in batch) {
          batch.items.push({
            item: event.item,
            amount: event.amount,
            durability: event.details?.durability as number | undefined,
            attributedPlayer: event.attributedPlayer,
            attributedSteamId: event.attributedSteamId,
          });
        }
      } else {
        // Collapse duplicate non-item events (e.g. 30x "Barb Defence was destroyed")
        const dedupeKey = `${event.type}::${_cleanActorName(event.actorName ?? event.actor ?? '')}`;
        if (!batchedItems.has(dedupeKey)) {
          batchedItems.set(dedupeKey, { event, count: 1, isCollapsed: true });
        } else {
          const existing = batchedItems.get(dedupeKey);
          if (existing && 'isCollapsed' in existing) {
            existing.count++;
          }
        }
      }
    }

    // Format collapsed non-item events
    for (const [, batch] of batchedItems) {
      if (!('isCollapsed' in batch)) continue;
      const formatted = _formatEvent(batch.event, timeStr);
      if (batch.count > 1) {
        lines.push(formatted + ` ×${batch.count}`);
      } else {
        lines.push(formatted);
      }
    }

    // Format batched item events with clean names and player attribution
    for (const [, batch] of batchedItems) {
      if ('isCollapsed' in batch) continue; // already formatted above
      const e = batch.event;
      const emoji = EVENT_EMOJI[e.type] ?? '•';
      const itemList = batch.items
        .map((i) => {
          const cleaned = cleanItemName(i.item);
          let label = (i.amount ?? 0) > 1 ? `${cleaned} x${i.amount}` : cleaned;
          if (i.durability != null && i.durability < 100) label += ` (${Math.round(i.durability)}%)`;
          return label;
        })
        .join(', ');

      const actorLabel = _cleanActorName(e.actorName ?? e.actor ?? '');
      const loc = _formatLocation(e);

      // Player attribution: prefer cross-referenced data from diff-engine,
      // fall back to log-based container access tracking
      let playerTag = '';
      const crossRefPlayer = e.attributedPlayer ?? batch.items.find((i) => i.attributedPlayer)?.attributedPlayer;
      if (crossRefPlayer) {
        playerTag = ` — **${crossRefPlayer}**`;
      } else if (category === 'container' && this._logWatcher) {
        const access = this._logWatcher.getRecentContainerAccess(e.actorName ?? e.actor ?? '');
        if (access) playerTag = ` — **${access.player}**`;
      }

      const ts = timeStr ? `\`${timeStr}\` ` : '';
      if (e.type.includes('removed')) {
        // Item taken FROM container/vehicle — "Player took items from Container [C4]"
        if (playerTag) {
          lines.push(`${ts}${emoji}${playerTag} took ${itemList} from **${actorLabel}**${loc}`);
        } else {
          lines.push(`${ts}${emoji} ${itemList} removed from **${actorLabel}**${loc}`);
        }
      } else if (e.type.includes('added')) {
        // Item stored IN container/vehicle — "Player stored items in Container [C4]"
        if (playerTag) {
          lines.push(`${ts}${emoji}${playerTag} stored ${itemList} in **${actorLabel}**${loc}`);
        } else {
          lines.push(`${ts}${emoji} ${itemList} added to **${actorLabel}**${loc}`);
        }
      } else {
        lines.push(`${ts}${emoji} **${actorLabel}**${playerTag}: ${itemList}${loc}`);
      }
    }

    if (lines.length === 0) return null;

    // Truncate if too many lines (Discord embed limit)
    const maxLines = 25;
    let description = lines.slice(0, maxLines).join('\n');
    if (lines.length > maxLines) {
      description += `\n${t('discord:activity_log.and_more_events', _activityLocale(), { count: lines.length - maxLines })}`;
    }

    return new EmbedBuilder()
      .setTitle(title)
      .setDescription(description)
      .setColor(clr)
      .setTimestamp()
      .setFooter({
        text: t('discord:activity_log.events_footer', _activityLocale(), {
          count: events.length,
          plural_suffix: events.length === 1 ? '' : 's',
        }),
      });
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Clean raw UE4 actor names into human-readable labels.
 * Delegates to the shared cleanName() utility.
 */
function _cleanActorName(raw: unknown): string {
  return cleanName(raw);
}

/**
 * Format a Date or ISO string into a short HH:MM timestamp string.
 * Uses the bot's configured timezone.
 */
function _formatTime(dateOrIso: Date | string | null | undefined): string {
  if (!dateOrIso) return '';
  const d = dateOrIso instanceof Date ? dateOrIso : new Date(dateOrIso);
  if (isNaN(d.getTime())) return '';
  try {
    return new Intl.DateTimeFormat(_activityLocale(), {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: config.botTimezone || 'UTC',
    }).format(d);
  } catch {
    return d.toISOString().slice(11, 16);
  }
}

function _categoryTitle(category: string): string {
  switch (category) {
    case 'container':
      return t('discord:activity_log.container_activity', _activityLocale());
    case 'inventory':
      return t('discord:activity_log.inventory_changes', _activityLocale());
    case 'horse':
      return t('discord:activity_log.horse_activity', _activityLocale());
    case 'vehicle':
      return t('discord:activity_log.vehicle_activity', _activityLocale());
    case 'world':
      return t('discord:activity_log.world_events', _activityLocale());
    case 'structure':
      return t('discord:activity_log.structure_activity', _activityLocale());
    default:
      return t('discord:activity_log.activity', _activityLocale());
  }
}

function _formatEvent(event: DiffEvent, timeStr: string): string {
  const emoji = EVENT_EMOJI[event.type] ?? '•';
  const name = _cleanActorName(event.actorName ?? event.actor ?? '');
  const ts = timeStr ? `\`${timeStr}\` ` : '';
  const loc = _formatLocation(event);

  switch (event.type) {
    case 'container_locked':
      return `${ts}${emoji} **${name}** was locked${loc}`;
    case 'container_unlocked':
      return `${ts}${emoji} **${name}** was unlocked${loc}`;
    case 'container_destroyed': {
      // Show what items were lost (details.items is already captured by diff-engine)
      const items = event.details?.items;
      let lostList = '';
      if (Array.isArray(items) && items.length > 0) {
        const cleaned = items
          .slice(0, 5)
          .map((i: unknown) => cleanItemName(typeof i === 'string' ? i.replace(/ x\d+$/, '') : String(i)));
        lostList = `: ${cleaned.join(', ')}`;
        if (items.length > 5) lostList += ` +${items.length - 5} more`;
      }
      const amountLabel = event.amount === 1 ? 'item' : 'items';
      return `${ts}${emoji} **${name}** destroyed (${fmtNumber(event.amount ?? 0, _activityLocale())} ${amountLabel} lost${lostList})${loc}`;
    }
    case 'horse_appeared':
      return `${ts}${emoji} **${name}** appeared${loc}`;
    case 'horse_disappeared':
      return `${ts}${emoji} **${name}** disappeared (health: ${event.details?.lastHealth != null ? `${event.details.lastHealth as number}` : '?'})${loc}`;
    case 'horse_health_changed': {
      const delta = event.amount ?? 0;
      return `${ts}${emoji} **${name}** ${delta > 0 ? 'healed' : 'took damage'} (${delta > 0 ? '+' : ''}${delta} HP)${loc}`;
    }
    case 'horse_owner_changed':
      return `${ts}${emoji} **${name}** ownership changed${loc}`;
    case 'airdrop_spawned':
      return `${ts}${emoji} **Airdrop** has been spotted!${loc}`;
    case 'airdrop_despawned':
      return `${ts}${emoji} **Airdrop** has expired`;
    case 'world_day_advanced':
      return `${ts}${emoji} Day **${String(event.details?.newDay)}** has dawned (+${event.amount ?? 0})`;
    case 'world_season_changed':
      return `${ts}${emoji} Season changed to **${String(event.item)}**`;
    // ── New diff-engine event types ──
    case 'structure_damaged': {
      const pct =
        event.details?.healthPercent != null ? ` (${Math.round(Number(event.details.healthPercent))}% HP)` : '';
      return `${ts}🏚️ **${name}** took damage${pct}${loc}`;
    }
    case 'structure_destroyed':
      return `${ts}💥 **${name}** was destroyed${loc}`;
    case 'structure_upgraded':
      return `${ts}🔨 **${name}** upgraded to level ${event.details?.newLevel != null ? `${event.details.newLevel as number}` : '?'}${loc}`;
    case 'structure_built':
      return `${ts}🏗️ **${name}** was built${loc}`;
    case 'vehicle_health_changed': {
      const delta = event.amount ?? 0;
      const pct =
        event.details?.healthPercent != null ? ` (${Math.round(Number(event.details.healthPercent))}% HP)` : '';
      return `${ts}🚗 **${name}** ${delta > 0 ? 'repaired' : 'damaged'}${pct}${loc}`;
    }
    case 'vehicle_fuel_changed': {
      const delta = event.amount ?? 0;
      return `${ts}⛽ **${name}** ${delta > 0 ? 'refueled' : 'fuel consumed'} (${delta > 0 ? '+' : ''}${Math.round(delta)})${loc}`;
    }
    case 'vehicle_appeared':
      return `${ts}🚗 **${name}** appeared${loc}`;
    case 'vehicle_destroyed':
      return `${ts}💥 **${name}** was destroyed${loc}`;
    default:
      return `${ts}${emoji} ${event.type}: ${name}`;
  }
}

/**
 * Convert UE4 world coordinates to a grid reference string.
 * Returns " `[C4]`" or empty string if no coordinates.
 *
 * Grid: 8x8 (A-H columns, 1-8 rows) mapped to UE4 world bounds.
 * World bounds: Width 395900, Offset X=201200 Y=-200600 (developer-provided)
 */
function _formatLocation(event: Partial<DiffEvent>): string {
  const x = event.x ?? event.pos_x;
  const y = event.y ?? event.pos_y;
  if (x == null || y == null) return '';

  // UE4 coordinate ranges for HumanitZ map (developer-provided)
  const minX = 3250,
    maxX = 399150;
  const minY = -398550,
    maxY = -2650;

  // Clamp to map bounds
  const nx = Math.max(0, Math.min(7, Math.floor(((x - minX) / (maxX - minX)) * 8)));
  const ny = Math.max(0, Math.min(7, Math.floor(((y - minY) / (maxY - minY)) * 8)));

  const col = String.fromCharCode(65 + ny); // A-H
  const row = nx + 1; // 1-8
  return ` \`[${col}${row}]\``;
}

// ── Test escape hatch ────────────────────────────────────────────────────────

export default ActivityLog;
export { ActivityLog };

const _test = {
  _filterEvents: ActivityLog.prototype._filterEvents.bind(ActivityLog.prototype),
  _formatTime,
  _categoryTitle,
};

export { _cleanActorName, _formatLocation, _test };

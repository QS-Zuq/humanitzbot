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

const { EmbedBuilder } = require('discord.js');
const config = require('../config');
const { createLogger } = require('../utils/log');
const { cleanName, cleanItemName } = require('../parsers/ue4-names');
const { t, getLocale, fmtNumber } = require('../i18n');

function _activityLocale(cfg) {
  return getLocale({ serverConfig: cfg || config });
}

// ─── Category colours ───────────────────────────────────────────────────────

const CATEGORY_COLORS = {
  container: 0xe67e22, // Orange
  inventory: 0x3498db, // Blue
  horse: 0x2ecc71, // Green
  vehicle: 0x9b59b6, // Purple
  world: 0xf1c40f, // Gold
  structure: 0xe74c3c, // Red
};

// ─── Category emoji ─────────────────────────────────────────────────────────

const EVENT_EMOJI = {
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
  /**
   * @param {import('discord.js').Client} client
   * @param {object} options
   * @param {import('./db/database')} options.db
   * @param {import('./parsers/save-service')} options.saveService
   * @param {import('./log-watcher')} [options.logWatcher]  Route embeds to daily thread
   * @param {string} [options.label]
   */
  constructor(client, options = {}) {
    this._client = client;
    this._db = options.db;
    this._saveService = options.saveService;
    this._logWatcher = options.logWatcher || null;
    this._log = createLogger(options.label, 'ActivityLog');
    this._channel = null; // fallback channel when no logWatcher
    this._started = false;
  }

  async start() {
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
        this._channel = await this._client.channels.fetch(channelId);
        if (!this._channel) {
          this._log.warn(`Channel ${channelId} not found`);
          return;
        }
      } catch (err) {
        this._log.warn(`Failed to fetch channel ${channelId}:`, err.message);
        return;
      }
    }

    // Listen for save sync events
    if (this._saveService) {
      this._syncHandler = (result) => this._onSync(result);
      this._saveService.on('sync', this._syncHandler);
    }

    const target = this._logWatcher ? 'daily thread (via LogWatcher)' : `#${this._channel?.name || 'unknown'}`;
    this._log.info(`Started \u2014 posting to ${target}`);
  }

  stop() {
    this._started = false;
    if (this._saveService && this._syncHandler) {
      this._saveService.removeListener('sync', this._syncHandler);
      this._syncHandler = null;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Event handling
  // ═══════════════════════════════════════════════════════════════════════════

  async _onSync(result) {
    if (!result.diffEvents || result.diffEvents.length === 0) return;
    if (!this._logWatcher && !this._channel) return;

    try {
      const syncTime = result.syncTime || new Date();

      // Cap events to prevent OOM/rate-limit on first-sync diff storms
      const maxEvents = 200;
      const events = result.diffEvents.length > maxEvents ? result.diffEvents.slice(0, maxEvents) : result.diffEvents;

      const embeds = this._buildEmbeds(events, syncTime);

      // Send embeds with a small delay between each to avoid Discord rate limits
      for (const embed of embeds) {
        try {
          if (this._logWatcher) {
            await this._logWatcher.sendToThread(embed);
          } else {
            await this._channel.send({ embeds: [embed] });
          }
        } catch (sendErr) {
          // Log individual embed failures but continue sending the rest
          this._log.warn('Embed send failed (continuing):', sendErr.message);
        }
        // Small delay to respect Discord rate limits (1 embed per 500ms)
        if (embeds.length > 3) {
          await new Promise((r) => setTimeout(r, 500));
        }
      }

      if (result.diffEvents.length > maxEvents) {
        this._log.info(`Capped activity batch: ${result.diffEvents.length} events \u2192 ${maxEvents} posted`);
      }
    } catch (err) {
      this._log.warn('Failed to post activity:', err.message);
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
  _buildEmbeds(events, syncTime) {
    const embeds = [];
    const filtered = this._filterEvents(events);
    if (filtered.length === 0) return embeds;

    // Format sync timestamp for per-event display
    const timeStr = _formatTime(syncTime);

    // Group by category
    const groups = new Map();
    for (const event of filtered) {
      const cat = event.category || 'other';
      if (!groups.has(cat)) groups.set(cat, []);
      groups.get(cat).push(event);
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
  _filterEvents(events) {
    return events.filter((e) => {
      if (e.category === 'inventory') return config.showInventoryLog;
      if (e.category === 'container') return config.enableContainerLog !== false;
      if (e.category === 'horse') return config.enableHorseLog !== false;
      if (e.category === 'vehicle') return config.enableVehicleLog !== false;
      if (e.category === 'world') return config.enableWorldEventFeed !== false;
      if (e.category === 'structure') return config.enableStructureLog !== false;
      return true;
    });
  }

  /**
   * Build one embed for a category of events.
   * Events are batched by actor and formatted with clean names.
   */
  _buildCategoryEmbed(category, events, timeStr) {
    const clr = CATEGORY_COLORS[category] || 0x95a5a6;
    const title = _categoryTitle(category);

    const lines = [];
    const batchedItems = new Map(); // "actor::type" → aggregated

    for (const event of events) {
      const key = `${event.actor}::${event.type}`;

      if (event.item) {
        if (!batchedItems.has(key)) {
          batchedItems.set(key, { event, items: [] });
        }
        batchedItems.get(key).items.push({
          item: event.item,
          amount: event.amount,
          durability: event.details?.durability,
          attributedPlayer: event.attributedPlayer,
          attributedSteamId: event.attributedSteamId,
        });
      } else {
        // Collapse duplicate non-item events (e.g. 30x "Barb Defence was destroyed")
        const dedupeKey = `${event.type}::${_cleanActorName(event.actorName || event.actor || '')}`;
        if (!batchedItems.has(dedupeKey)) {
          batchedItems.set(dedupeKey, { event, count: 1, isCollapsed: true });
        } else if (batchedItems.get(dedupeKey).isCollapsed) {
          batchedItems.get(dedupeKey).count++;
        }
      }
    }

    // Format collapsed non-item events
    for (const [, batch] of batchedItems) {
      if (!batch.isCollapsed) continue;
      const formatted = _formatEvent(batch.event, timeStr);
      if (batch.count > 1) {
        lines.push(formatted + ` ×${batch.count}`);
      } else {
        lines.push(formatted);
      }
    }

    // Format batched item events with clean names and player attribution
    for (const [, batch] of batchedItems) {
      if (batch.isCollapsed) continue; // already formatted above
      const e = batch.event;
      const emoji = EVENT_EMOJI[e.type] || '•';
      const itemList = batch.items
        .map((i) => {
          const cleaned = cleanItemName(i.item);
          let label = i.amount > 1 ? `${cleaned} x${i.amount}` : cleaned;
          if (i.durability != null && i.durability < 100) label += ` (${Math.round(i.durability)}%)`;
          return label;
        })
        .join(', ');

      const actorLabel = _cleanActorName(e.actorName || e.actor || '');
      const loc = _formatLocation(e);

      // Player attribution: prefer cross-referenced data from diff-engine,
      // fall back to log-based container access tracking
      let playerTag = '';
      const crossRefPlayer = e.attributedPlayer || batch.items.find((i) => i.attributedPlayer)?.attributedPlayer;
      if (crossRefPlayer) {
        playerTag = ` — **${crossRefPlayer}**`;
      } else if (category === 'container' && this._logWatcher) {
        const access = this._logWatcher.getRecentContainerAccess(e.actorName || e.actor);
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
function _cleanActorName(raw) {
  return cleanName(raw);
}

/**
 * Format a Date or ISO string into a short HH:MM timestamp string.
 * Uses the bot's configured timezone.
 */
function _formatTime(dateOrIso) {
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

function _categoryTitle(category) {
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

function _formatEvent(event, timeStr) {
  const emoji = EVENT_EMOJI[event.type] || '•';
  const name = _cleanActorName(event.actorName || event.actor || '');
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
          .map((i) => cleanItemName(typeof i === 'string' ? i.replace(/ x\d+$/, '') : i));
        lostList = `: ${cleaned.join(', ')}`;
        if (items.length > 5) lostList += ` +${items.length - 5} more`;
      }
      const amountLabel = event.amount === 1 ? 'item' : 'items';
      return `${ts}${emoji} **${name}** destroyed (${fmtNumber(event.amount, _activityLocale())} ${amountLabel} lost${lostList})${loc}`;
    }
    case 'horse_appeared':
      return `${ts}${emoji} **${name}** appeared${loc}`;
    case 'horse_disappeared':
      return `${ts}${emoji} **${name}** disappeared (health: ${event.details?.lastHealth ?? '?'})${loc}`;
    case 'horse_health_changed': {
      const delta = event.amount;
      return `${ts}${emoji} **${name}** ${delta > 0 ? 'healed' : 'took damage'} (${delta > 0 ? '+' : ''}${delta} HP)${loc}`;
    }
    case 'horse_owner_changed':
      return `${ts}${emoji} **${name}** ownership changed${loc}`;
    case 'airdrop_spawned':
      return `${ts}${emoji} **Airdrop** has been spotted!${loc}`;
    case 'airdrop_despawned':
      return `${ts}${emoji} **Airdrop** has expired`;
    case 'world_day_advanced':
      return `${ts}${emoji} Day **${event.details?.newDay}** has dawned (+${event.amount})`;
    case 'world_season_changed':
      return `${ts}${emoji} Season changed to **${event.item}**`;
    // ── New diff-engine event types ──
    case 'structure_damaged': {
      const pct = event.details?.healthPercent != null ? ` (${Math.round(event.details.healthPercent)}% HP)` : '';
      return `${ts}🏚️ **${name}** took damage${pct}${loc}`;
    }
    case 'structure_destroyed':
      return `${ts}💥 **${name}** was destroyed${loc}`;
    case 'structure_upgraded':
      return `${ts}🔨 **${name}** upgraded to level ${event.details?.newLevel || '?'}${loc}`;
    case 'structure_built':
      return `${ts}🏗️ **${name}** was built${loc}`;
    case 'vehicle_health_changed': {
      const delta = event.amount;
      const pct = event.details?.healthPercent != null ? ` (${Math.round(event.details.healthPercent)}% HP)` : '';
      return `${ts}🚗 **${name}** ${delta > 0 ? 'repaired' : 'damaged'}${pct}${loc}`;
    }
    case 'vehicle_fuel_changed': {
      const delta = event.amount;
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
function _formatLocation(event) {
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

module.exports = ActivityLog;
module.exports._cleanActorName = _cleanActorName;
module.exports._formatLocation = _formatLocation;

// ── Test escape hatch ────────────────────────────────────────────────────────
module.exports._test = {
  _filterEvents: ActivityLog.prototype._filterEvents,
  _formatTime,
  _categoryTitle,
};

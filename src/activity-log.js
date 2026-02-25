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
const config = require('./config');
const { cleanName } = require('./ue4-names');

// ─── Category colours ───────────────────────────────────────────────────────

const CATEGORY_COLORS = {
  container: 0xE67E22,   // Orange
  inventory: 0x3498DB,   // Blue
  horse: 0x2ECC71,       // Green
  vehicle: 0x9B59B6,     // Purple
  world: 0xF1C40F,       // Gold
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
  vehicle_item_added: '🚗',
  vehicle_item_removed: '🚗',
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
    this._label = options.label || 'ActivityLog';
    this._channel = null;  // fallback channel when no logWatcher
    this._started = false;
  }

  async start() {
    if (this._started) return;
    this._started = true;

    // If we have a LogWatcher, we route embeds to its daily thread — no channel needed
    if (!this._logWatcher) {
      const channelId = config.activityLogChannelId || config.adminChannelId;
      if (!channelId) {
        console.log(`[${this._label}] No logWatcher or channel configured — activity log disabled`);
        return;
      }
      try {
        this._channel = await this._client.channels.fetch(channelId);
        if (!this._channel) {
          console.warn(`[${this._label}] Channel ${channelId} not found`);
          return;
        }
      } catch (err) {
        console.warn(`[${this._label}] Failed to fetch channel ${channelId}:`, err.message);
        return;
      }
    }

    // Listen for save sync events
    if (this._saveService) {
      this._syncHandler = (result) => this._onSync(result);
      this._saveService.on('sync', this._syncHandler);
    }

    const target = this._logWatcher ? 'daily thread (via LogWatcher)' : `#${this._channel?.name || 'unknown'}`;
    console.log(`[${this._label}] Started — posting to ${target}`);
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
      const embeds = this._buildEmbeds(result.diffEvents, syncTime);
      for (const embed of embeds) {
        if (this._logWatcher) {
          await this._logWatcher.sendToThread(embed);
        } else {
          await this._channel.send({ embeds: [embed] });
        }
      }
    } catch (err) {
      console.warn(`[${this._label}] Failed to post activity:`, err.message);
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
    return events.filter(e => {
      if (e.category === 'inventory') return config.showInventoryLog;
      if (e.category === 'container') return config.enableContainerLog !== false;
      if (e.category === 'horse')     return config.enableHorseLog !== false;
      if (e.category === 'vehicle')   return config.enableVehicleLog !== false;
      if (e.category === 'world')     return config.enableWorldEventFeed !== false;
      return true;
    });
  }

  /**
   * Build one embed for a category of events.
   * Events are batched by actor and formatted with clean names.
   */
  _buildCategoryEmbed(category, events, timeStr) {
    const clr = CATEGORY_COLORS[category] || 0x95A5A6;
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
        lines.push(_formatEvent(event, timeStr));
      }
    }

    // Format batched item events with clean names and player attribution
    for (const [, batch] of batchedItems) {
      const e = batch.event;
      const emoji = EVENT_EMOJI[e.type] || '•';
      const itemList = batch.items
        .map(i => {
          let label = i.amount > 1 ? `${i.item} x${i.amount}` : i.item;
          if (i.durability != null && i.durability < 100) label += ` (${Math.round(i.durability)}%)`;
          return label;
        })
        .join(', ');

      const actorLabel = _cleanActorName(e.actorName || e.actor || '');

      // Player attribution: prefer cross-referenced data from diff-engine,
      // fall back to log-based container access tracking
      let playerTag = '';
      const crossRefPlayer = e.attributedPlayer || batch.items.find(i => i.attributedPlayer)?.attributedPlayer;
      if (crossRefPlayer) {
        playerTag = ` (${crossRefPlayer})`;
      } else if (category === 'container' && this._logWatcher) {
        const access = this._logWatcher.getRecentContainerAccess(e.actorName || e.actor);
        if (access) playerTag = ` (${access.player})`;
      }

      const ts = timeStr ? `\`${timeStr}\` ` : '';
      if (e.type.includes('added')) {
        lines.push(`${ts}${emoji} **${actorLabel}**${playerTag} ← ${itemList}`);
      } else if (e.type.includes('removed')) {
        lines.push(`${ts}${emoji} **${actorLabel}**${playerTag} → ${itemList}`);
      } else {
        lines.push(`${ts}${emoji} **${actorLabel}**${playerTag}: ${itemList}`);
      }
    }

    if (lines.length === 0) return null;

    // Truncate if too many lines (Discord embed limit)
    const maxLines = 25;
    let description = lines.slice(0, maxLines).join('\n');
    if (lines.length > maxLines) {
      description += `\n*...and ${lines.length - maxLines} more events*`;
    }

    return new EmbedBuilder()
      .setTitle(title)
      .setDescription(description)
      .setColor(clr)
      .setTimestamp()
      .setFooter({ text: `${events.length} event${events.length === 1 ? '' : 's'}` });
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
    return d.toLocaleTimeString('en-GB', {
      hour: '2-digit', minute: '2-digit',
      timeZone: config.botTimezone || 'UTC',
    });
  } catch {
    return d.toISOString().slice(11, 16);
  }
}

function _categoryTitle(category) {
  switch (category) {
    case 'container': return '📦 Container Activity';
    case 'inventory': return '🎒 Inventory Changes';
    case 'horse':     return '🐴 Horse Activity';
    case 'vehicle':   return '🚗 Vehicle Activity';
    case 'world':     return '🌍 World Events';
    default:          return '📋 Activity';
  }
}

function _formatEvent(event, timeStr) {
  const emoji = EVENT_EMOJI[event.type] || '•';
  const name = _cleanActorName(event.actorName || event.actor || '');
  const ts = timeStr ? `\`${timeStr}\` ` : '';

  switch (event.type) {
    case 'container_locked':
      return `${ts}${emoji} **${name}** was locked`;
    case 'container_unlocked':
      return `${ts}${emoji} **${name}** was unlocked`;
    case 'container_destroyed':
      return `${ts}${emoji} **${name}** destroyed (had ${event.amount} item${event.amount === 1 ? '' : 's'})`;
    case 'horse_appeared':
      return `${ts}${emoji} **${name}** appeared in the world`;
    case 'horse_disappeared':
      return `${ts}${emoji} **${name}** disappeared (health: ${event.details?.lastHealth ?? '?'})`;
    case 'horse_health_changed': {
      const delta = event.amount;
      return `${ts}${emoji} **${name}** ${delta > 0 ? 'healed' : 'took damage'} (${delta > 0 ? '+' : ''}${delta} HP)`;
    }
    case 'horse_owner_changed':
      return `${ts}${emoji} **${name}** ownership changed`;
    case 'airdrop_spawned':
      return `${ts}${emoji} **Airdrop** has been spotted!`;
    case 'airdrop_despawned':
      return `${ts}${emoji} **Airdrop** has expired`;
    case 'world_day_advanced':
      return `${ts}${emoji} Day **${event.details?.newDay}** has dawned (+${event.amount})`;
    case 'world_season_changed':
      return `${ts}${emoji} Season changed to **${event.item}**`;
    default:
      return `${ts}${emoji} ${event.type}: ${name}`;
  }
}

module.exports = ActivityLog;
module.exports._cleanActorName = _cleanActorName;

/**
 * log-watcher-events.js — Event handler and batch-flush methods for LogWatcher.
 *
 * Extracted from log-watcher.js to separate Discord event posting and
 * batching logic from log parsing and SFTP polling.  Methods are mixed
 * in via Object.assign so `this` is the LogWatcher instance.
 */

import { EmbedBuilder } from 'discord.js';
import { t, getLocale, fmtNumber } from '../i18n/index.js';
import { errMsg } from '../utils/error.js';

// ── LogWatcher context type for mixin methods ───────────────────────────────

interface LogWatcherThis {
  _config: {
    locale?: string;
    enablePvpKillFeed: boolean;
    enableDeathLoopDetection: boolean;
    deathLoopWindow: number;
    deathLoopThreshold: number;
  };
  _playerStats: {
    recordBuild(name: string, steamId: string, item: string, ts: Date | null): void;
    recordDeath(name: string, ts: Date | null): void;
    recordRaid(
      attacker: string,
      attackerSteamId: string,
      ownerSteamId: string,
      destroyed: boolean,
      ts: Date | null,
    ): void;
    recordPvpKill(killer: string, victim: string, ts: Date | null): void;
    recordLoot(looter: string, looterId: string, ownerSteamId: string, ts: Date | null): void;
    getSteamId?(name: string): string | null;
  };
  _playtime: {
    getPlaytime(id: string): { name: string } | null;
  };
  _db: {
    deathCause: {
      insertDeathCause(data: Record<string, unknown>): void;
    };
    areClanmates?(steamId1: string, steamId2: string): boolean;
  } | null;
  _log: { warn(msg: string, ...args: unknown[]): void; error(msg: string, ...args: unknown[]): void };
  _simplifyBlueprintName(name: string): string;
  _simplifyContainerName(name: string): string;
  _incDayCount(key: string): void;
  _logEvent(data: Record<string, unknown>): void;
  _checkPvpKill(victim: string, ts: Date): PvpKillResult | null;
  _checkDeathCause(victim: string, ts: Date): DeathCause | null;
  _formatTime(ts: Date): string;
  _sendToThread(embed: EmbedBuilder): void;
  _buildBatch: Record<string, BuildBatchEntry>;
  _buildTimer: ReturnType<typeof setTimeout> | null;
  _flushBuildBatch(): void;
  _raidBatch: Record<string, RaidBatchEntry>;
  _raidTimer: ReturnType<typeof setTimeout> | null;
  _flushRaidBatch(): void;
  _lootBatch: Record<string, LootBatchEntry>;
  _lootTimer: ReturnType<typeof setTimeout> | null;
  _flushLootBatch(): void;
  _pvpKills: PvpKillEntry[];
  _pvpKillsDirty: boolean;
  _deathLoopTracker: Map<string, DeathLoopEntry>;
  _flushDeathLoop(key: string, playerName: string): void;
  _deathCauseWarnShown?: boolean;
  _recentContainerAccess: Map<string, { timestamp: number }>;
}

interface PvpKillResult {
  attacker: string;
  totalDamage: number;
}

interface DeathCause {
  type: string;
  name: string;
  raw: string;
  totalDamage: number;
}

interface DeathCauseRecord extends Record<string, unknown> {
  victimName: string;
  victimSteamId: string;
  causeType: string;
  causeName: string;
  causeRaw: string;
  damageTotal: number;
}

interface PvpKillEntry {
  killer: string;
  victim: string;
  damage: number;
  timestamp: string;
}

interface BuildBatchEntry {
  playerName: string;
  items: Record<string, number>;
  timestamp: Date | null;
}

interface RaidBatchEntry {
  attacker: string;
  attackerSteamId: string;
  ownerSteamId: string;
  buildings: Record<string, number>;
  destroyedCount: number;
  damagedCount: number;
  timestamp: Date | null;
}

interface LootBatchEntry {
  looter: string;
  looterId: string;
  ownerSteamId: string;
  count: number;
  containers: Set<string>;
  timestamp: Date | null;
}

interface DeathLoopEntry {
  count: number;
  firstTimestamp: number;
  lastTimestamp: number;
  timer: ReturnType<typeof setTimeout> | null;
}

function _te(locale: string, key: string, vars: Record<string, unknown> = {}): string {
  return t(`discord:events.${key}`, locale, vars);
}

function _insertDeathCause(this: LogWatcherThis, data: DeathCauseRecord) {
  if (!this._db) return;
  try {
    this._db.deathCause.insertDeathCause(data);
  } catch (err: unknown) {
    if (!this._deathCauseWarnShown) {
      this._log.warn('Failed to log death cause:', errMsg(err));
      this._deathCauseWarnShown = true;
    }
  }
}

// ═════════════════════════════════════════════════════════════════════
//  _onBuild — Build event handler (batched)
// ═════════════════════════════════════════════════════════════════════
function _onBuild(this: LogWatcherThis, playerName: string, steamId: string, itemName: string, timestamp: Date) {
  // Clean up item name — remove BP_ prefix and trailing IDs
  const cleanItem = this._simplifyBlueprintName(itemName);

  // Record stats
  this._playerStats.recordBuild(playerName, steamId, cleanItem, timestamp);
  this._incDayCount('builds');

  // DB: log build event
  this._logEvent({
    type: 'player_build',
    category: 'build',
    actorName: playerName,
    steamId,
    item: cleanItem,
    timestamp,
  });

  // Batch builds to reduce spam
  if (!this._buildBatch[steamId]) {
    this._buildBatch[steamId] = {
      playerName,
      items: {},
      timestamp,
    };
  }
  this._buildBatch[steamId].items[cleanItem] = (this._buildBatch[steamId].items[cleanItem] ?? 0) + 1;

  if (!this._buildTimer) {
    this._buildTimer = setTimeout(() => {
      this._flushBuildBatch();
      this._buildTimer = null;
    }, 60000);
  }
}

// ═════════════════════════════════════════════════════════════════════
//  _onDeath — Death event handler (PvP, PvE, death-loop detection)
// ═════════════════════════════════════════════════════════════════════
function _onDeath(this: LogWatcherThis, playerName: string, timestamp: Date) {
  const locale = getLocale({ serverConfig: this._config });
  // ALWAYS record stats — every death counts, no suppression
  this._playerStats.recordDeath(playerName, timestamp);
  this._incDayCount('deaths');

  // Check for death cause attribution (ALL damage sources)
  const deathCause = this._checkDeathCause(playerName, timestamp);

  // Check for PvP kill attribution
  const pvpKill = this._config.enablePvpKillFeed ? this._checkPvpKill(playerName, timestamp) : null;

  // Record death cause to DB (regardless of PvP or PvE)
  if (this._db) {
    const victimSteamId = this._playerStats.getSteamId?.(playerName) ?? '';
    _insertDeathCause.call(this, {
      victimName: playerName,
      victimSteamId,
      causeType: pvpKill ? 'player' : (deathCause?.type ?? 'unknown'),
      causeName: pvpKill ? pvpKill.attacker : (deathCause?.name ?? ''),
      causeRaw: deathCause?.raw ?? '',
      damageTotal: pvpKill ? pvpKill.totalDamage : (deathCause?.totalDamage ?? 0),
    });
  }

  if (pvpKill) {
    // PvP kill confirmed
    this._incDayCount('pvpKills');

    // DB: log PvP death event
    this._logEvent({
      type: 'player_death_pvp',
      category: 'death',
      actorName: playerName,
      targetName: pvpKill.attacker,
      details: { damage: pvpKill.totalDamage },
      timestamp,
    });

    const killEntry: PvpKillEntry = {
      killer: pvpKill.attacker,
      victim: playerName,
      damage: pvpKill.totalDamage,
      timestamp: timestamp.toISOString(),
    };
    this._pvpKills.push(killEntry);
    if (this._pvpKills.length > 50) this._pvpKills = this._pvpKills.slice(-50);
    this._pvpKillsDirty = true;

    this._playerStats.recordPvpKill(pvpKill.attacker, playerName, timestamp);

    // PvP kills always post individually (they're rare and important)
    const killEmbed = new EmbedBuilder()
      .setAuthor({ name: _te(locale, 'pvp_kill') })
      .setDescription(
        _te(locale, 'pvp_kill_description', {
          attacker: pvpKill.attacker,
          victim: playerName,
        }),
      )
      .setColor(0xe74c3c)
      .setFooter({
        text: _te(locale, 'pvp_kill_footer', {
          damage: fmtNumber(Math.round(pvpKill.totalDamage), locale),
          time: this._formatTime(timestamp),
        }),
      });
    this._sendToThread(killEmbed);

    const deathEmbed = new EmbedBuilder()
      .setAuthor({ name: _te(locale, 'player_death') })
      .setDescription(
        _te(locale, 'pvp_death_description', {
          victim: playerName,
          attacker: pvpKill.attacker,
        }),
      )
      .setColor(0x992d22)
      .setFooter({ text: this._formatTime(timestamp) });
    this._sendToThread(deathEmbed);
    return;
  }

  // ── Death loop detection: collapse rapid-fire embed spam ──
  // Stats are already recorded above — this only affects Discord embed output.
  if (this._config.enableDeathLoopDetection) {
    const key = playerName.toLowerCase();
    const windowMs = this._config.deathLoopWindow;
    const threshold = this._config.deathLoopThreshold;
    const existing = this._deathLoopTracker.get(key);

    if (existing && timestamp.getTime() - existing.firstTimestamp < windowMs) {
      existing.count++;
      existing.lastTimestamp = timestamp.getTime();

      if (existing.count >= threshold) {
        // In a loop — don't post individual embeds; _flushDeathLoop will summarise
        if (!existing.timer) {
          existing.timer = setTimeout(() => {
            this._flushDeathLoop(key, playerName);
          }, windowMs);
        }
        return; // suppress embed only, stats already recorded
      }
    } else {
      // New window — flush any previous loop for this player
      if (existing && existing.count >= threshold) {
        this._flushDeathLoop(key, playerName);
      }
      this._deathLoopTracker.set(key, {
        count: 1,
        firstTimestamp: timestamp.getTime(),
        lastTimestamp: timestamp.getTime(),
        timer: null,
      });
    }
  }

  // Build death description with cause attribution
  let deathDesc = _te(locale, 'death_plain', { victim: playerName });
  if (deathCause && deathCause.name !== 'Unknown') {
    deathDesc = _te(locale, 'death_with_cause', {
      victim: playerName,
      cause: deathCause.name,
    });
  }

  // DB: log PvE death event with cause details
  this._logEvent({
    type: 'player_death',
    category: 'death',
    actorName: playerName,
    item: deathCause ? deathCause.name : '',
    details: deathCause
      ? {
          causeType: deathCause.type,
          causeName: deathCause.name,
          causeRaw: deathCause.raw,
          damage: deathCause.totalDamage,
        }
      : {},
    timestamp,
  });

  // Normal death embed with cause attribution
  const embed = new EmbedBuilder()
    .setAuthor({ name: _te(locale, 'player_death') })
    .setDescription(deathDesc)
    .setColor(0x992d22)
    .setFooter({ text: this._formatTime(timestamp) });
  this._sendToThread(embed);
}

/** Post a single summary embed for a death loop, then clear the tracker entry. */
function _flushDeathLoop(this: LogWatcherThis, key: string, playerName: string) {
  const locale = getLocale({ serverConfig: this._config });
  const entry = this._deathLoopTracker.get(key);
  if (!entry || entry.count < this._config.deathLoopThreshold) return;
  if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }

  const elapsed = Math.round((entry.lastTimestamp - entry.firstTimestamp) / 1000);
  const embed = new EmbedBuilder()
    .setAuthor({ name: _te(locale, 'death_loop') })
    .setDescription(
      _te(locale, 'death_loop_description', {
        victim: playerName,
        count: fmtNumber(entry.count, locale),
        seconds: fmtNumber(elapsed, locale),
        hint: _te(locale, 'respawn_bug_hint'),
      }),
    )
    .setColor(0xf39c12)
    .setFooter({ text: this._formatTime(new Date(entry.lastTimestamp)) });
  this._sendToThread(embed);

  this._deathLoopTracker.delete(key);
}

// ═════════════════════════════════════════════════════════════════════
//  _onRaid — Raid event handler (batched)
// ═════════════════════════════════════════════════════════════════════
function _onRaid(
  this: LogWatcherThis,
  attackerName: string,
  attackerSteamId: string,
  ownerSteamId: string,
  buildingType: string,
  destroyed: boolean,
  timestamp: Date,
) {
  // Clean up attacker name
  const attacker = attackerName.replace(/\s*$/, '');
  const cleanBuilding = this._simplifyBlueprintName(buildingType);

  // Record stats
  this._playerStats.recordRaid(attacker, attackerSteamId, ownerSteamId, destroyed, timestamp);
  this._incDayCount('raidHits');

  // DB: log raid event
  this._logEvent({
    type: 'raid_damage',
    category: 'raid',
    actorName: attacker,
    steamId: attackerSteamId,
    targetSteamId: ownerSteamId,
    item: cleanBuilding,
    amount: destroyed ? 1 : 0,
    details: { destroyed },
    timestamp,
  });

  // Batch raid events to reduce spam — group by attacker|owner pair
  const key = `${attackerSteamId}|${ownerSteamId}`;
  if (!this._raidBatch[key]) {
    this._raidBatch[key] = {
      attacker,
      attackerSteamId,
      ownerSteamId,
      buildings: {},
      destroyedCount: 0,
      damagedCount: 0,
      timestamp,
    };
  }
  const batch = this._raidBatch[key];
  batch.buildings[cleanBuilding] = (batch.buildings[cleanBuilding] ?? 0) + 1;
  if (destroyed) batch.destroyedCount++;
  else batch.damagedCount++;

  if (!this._raidTimer) {
    this._raidTimer = setTimeout(() => {
      this._flushRaidBatch();
      this._raidTimer = null;
    }, 60000);
  }
}

// ═════════════════════════════════════════════════════════════════════
//  Batch helpers — Loot, Build, Raid flush
// ═════════════════════════════════════════════════════════════════════
function _batchLoot(
  this: LogWatcherThis,
  playerName: string,
  steamId: string,
  containerType: string,
  ownerSteamId: string,
  timestamp: Date,
) {
  // Don't report self-looting
  if (steamId === ownerSteamId) return;
  // Don't spam Discord with clan members accessing shared containers
  if (this._db?.areClanmates?.(steamId, ownerSteamId)) return;

  const key = `${steamId}|${ownerSteamId}`;
  if (!this._lootBatch[key]) {
    this._lootBatch[key] = {
      looter: playerName,
      looterId: steamId,
      ownerSteamId,
      count: 0,
      containers: new Set(),
      timestamp,
    };
  }
  this._lootBatch[key].count++;
  this._lootBatch[key].containers.add(this._simplifyContainerName(containerType));

  if (!this._lootTimer) {
    this._lootTimer = setTimeout(() => {
      this._flushLootBatch();
      this._lootTimer = null;
    }, 60000);
  }
}

function _flushLootBatch(this: LogWatcherThis) {
  const locale = getLocale({ serverConfig: this._config });
  const entries = Object.values(this._lootBatch);
  if (entries.length === 0) return;
  this._lootBatch = {};

  const lines = entries.map((entry) => {
    const ownerData = this._playtime.getPlaytime(entry.ownerSteamId);
    const ownerName = ownerData
      ? ownerData.name
      : _te(locale, 'unknown_owner', { owner_id: entry.ownerSteamId.slice(0, 8) });
    const containerList = [...entry.containers].join(', ');
    return _te(locale, 'container_activity_line', {
      looter: entry.looter,
      count: fmtNumber(entry.count, locale),
      owner: ownerName,
      container_list: containerList,
    });
  });

  const embed = new EmbedBuilder()
    .setAuthor({ name: _te(locale, 'container_activity') })
    .setDescription(lines.join('\n\n'))
    .setColor(0xe67e22)
    .setTimestamp();

  this._sendToThread(embed);
}

function _flushBuildBatch(this: LogWatcherThis) {
  const locale = getLocale({ serverConfig: this._config });
  const entries = Object.values(this._buildBatch);
  if (entries.length === 0) return;
  this._buildBatch = {};

  const lines = entries.map((entry) => {
    const itemList = Object.entries(entry.items)
      .map(([item, count]) => (count > 1 ? `${item} ×${count}` : item))
      .join(', ');
    return _te(locale, 'build_activity_line', {
      player: entry.playerName,
      item_list: itemList,
    });
  });

  const embed = new EmbedBuilder()
    .setAuthor({ name: _te(locale, 'build_activity') })
    .setDescription(lines.join('\n'))
    .setColor(0xf39c12)
    .setTimestamp();

  this._sendToThread(embed);
}

function _flushRaidBatch(this: LogWatcherThis) {
  const locale = getLocale({ serverConfig: this._config });
  const entries = Object.values(this._raidBatch);
  if (entries.length === 0) return;
  this._raidBatch = {};

  const lines = entries.map((entry) => {
    const ownerData = this._playtime.getPlaytime(entry.ownerSteamId);
    const ownerName = ownerData
      ? ownerData.name
      : _te(locale, 'unknown_owner', { owner_id: entry.ownerSteamId.slice(0, 8) });
    const buildingList = Object.entries(entry.buildings)
      .map(([b, count]) => (count > 1 ? `${b} ×${count}` : b))
      .join(', ');
    const summary: string[] = [];
    if (entry.destroyedCount > 0) {
      summary.push(_te(locale, 'raid_summary_destroyed', { count: fmtNumber(entry.destroyedCount, locale) }));
    }
    if (entry.damagedCount > 0) {
      summary.push(_te(locale, 'raid_summary_damaged', { count: fmtNumber(entry.damagedCount, locale) }));
    }
    return _te(locale, 'raid_activity_line', {
      attacker: entry.attacker,
      owner: ownerName,
      summary: summary.join(', '),
      building_list: buildingList,
    });
  });

  const hasDestruction = entries.some((e) => e.destroyedCount > 0);
  const embed = new EmbedBuilder()
    .setAuthor({ name: hasDestruction ? _te(locale, 'raid_alert') : _te(locale, 'raid_activity') })
    .setDescription(lines.join('\n\n'))
    .setColor(hasDestruction ? 0xe74c3c : 0xe67e22)
    .setTimestamp();

  this._sendToThread(embed);
}

// ─── Exports ─────────────────────────────────────────────────────────

export { _onBuild, _onDeath, _flushDeathLoop, _onRaid, _batchLoot, _flushLootBatch, _flushBuildBatch, _flushRaidBatch };

/**
 * KillTracker — lifetime stat accumulation across deaths.
 *
 * Tracks per-player kill/survival/activity deltas between save polls and
 * accumulates lifetime totals even when the game resets stats on death.
 * Handles two code paths:
 *   - ExtendedStats (newer saves): lifetime values in save, never reset
 *   - Legacy (older saves): GameStats resets on death, we "bank" pre-death values
 *
 * This is the shared data layer consumed by:
 *   - PlayerStatsChannel (Discord embeds + activity feed)
 *   - Web panel API endpoints
 *   - howyagarn features (player cards, newspaper, etc.)
 *
 * @module tracking/kill-tracker
 */

const _defaultConfig = require('../config');
const _defaultPlaytime = require('./playtime-tracker');
const _defaultPlayerStats = require('./player-stats');
const { createLogger } = require('../utils/log');

// ═══════════════════════════════════════════════════════════════════════════
//  Standalone player resolver — shared between KillTracker and PSC
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Cross-validated player name/timestamp resolver.
 * Picks the most-recent-event name from playtime and log sources.
 *
 * @param {string} steamId
 * @param {object} deps - { playtime, playerStats, saveData }
 * @returns {{ name, firstSeen, lastActive, playtime, log, save }}
 */
function resolvePlayer(steamId, { playtime, playerStats, saveData }) {
  const pt = playtime.getPlaytime(steamId);
  const log = playerStats.getStats(steamId);
  const save = saveData instanceof Map ? saveData.get(steamId) : null;

  // Name resolution: most-recent-event wins
  let name;
  const ptName = pt?.name;
  const logName = log?.name;

  if (ptName && logName) {
    if (ptName !== logName) {
      const ptTime = pt.lastSeen ? new Date(pt.lastSeen).getTime() : 0;
      const logTime = log.lastEvent ? new Date(log.lastEvent).getTime() : 0;
      name = ptTime >= logTime ? ptName : logName;
    } else {
      name = ptName;
    }
  } else {
    name = ptName || logName || playerStats.getNameForId(steamId) || steamId;
  }

  // Last active: max of both timestamps
  const ptLastSeen = pt?.lastSeen ? new Date(pt.lastSeen).getTime() : 0;
  const logLastEvent = log?.lastEvent ? new Date(log.lastEvent).getTime() : 0;
  const lastActiveMs = Math.max(ptLastSeen, logLastEvent);
  const lastActive = lastActiveMs > 0 ? new Date(lastActiveMs).toISOString() : null;

  const firstSeen = pt?.firstSeen || null;

  return { name, firstSeen, lastActive, playtime: pt, log, save };
}

// ═══════════════════════════════════════════════════════════════════════════
//  KillTracker
// ═══════════════════════════════════════════════════════════════════════════

class KillTracker {
  // ── Key arrays (shared between tracker and embeds) ──
  static KILL_KEYS = [
    'zeeksKilled',
    'headshots',
    'meleeKills',
    'gunKills',
    'blastKills',
    'fistKills',
    'takedownKills',
    'vehicleKills',
  ];
  static SURVIVAL_KEYS = ['daysSurvived'];
  static ACTIVITY_SCALAR_KEYS = ['fishCaught', 'fishCaughtPike', 'timesBitten'];
  static CHALLENGE_KEYS = [
    'challengeKillZombies',
    'challengeKill50',
    'challengeCatch20Fish',
    'challengeRegularAngler',
    'challengeKillZombieBear',
    'challenge9Squares',
    'challengeCraftFirearm',
    'challengeCraftFurnace',
    'challengeCraftMeleeBench',
    'challengeCraftMeleeWeapon',
    'challengeCraftRainCollector',
    'challengeCraftTablesaw',
    'challengeCraftTreatment',
    'challengeCraftWeaponsBench',
    'challengeCraftWorkbench',
    'challengeFindDog',
    'challengeFindHeli',
    'challengeLockpickSUV',
    'challengeRepairRadio',
  ];
  static ACTIVITY_ARRAY_KEYS = [
    'craftingRecipes',
    'buildingRecipes',
    'unlockedSkills',
    'unlockedProfessions',
    'lore',
    'lootItemUnique',
    'craftedUniques',
    'companionData',
    'horses',
  ];
  static LIFETIME_KEY_MAP = {
    zeeksKilled: 'lifetimeKills',
    headshots: 'lifetimeHeadshots',
    meleeKills: 'lifetimeMeleeKills',
    gunKills: 'lifetimeGunKills',
    blastKills: 'lifetimeBlastKills',
    fistKills: 'lifetimeFistKills',
    takedownKills: 'lifetimeTakedownKills',
    vehicleKills: 'lifetimeVehicleKills',
  };

  constructor(deps = {}) {
    this._config = deps.config || _defaultConfig;
    this._playtime = deps.playtime || _defaultPlaytime;
    this._playerStats = deps.playerStats || _defaultPlayerStats;
    this._db = deps.db || null;
    this._log = createLogger(deps.label, 'KillTracker');

    // { players: { steamId: { cumulative, lastSnapshot, survivalCumulative, ... } } }
    this._data = { players: {} };
    this._dirty = false;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Persistence
  // ═══════════════════════════════════════════════════════════════════════════

  load() {
    try {
      let raw = null;
      if (this._db) {
        raw = this._db.getStateJSON('kill_tracker', null);
        if (raw) {
          this._data = raw;
          const count = Object.keys(this._data.players || {}).length;
          this._log.info(`Loaded ${count} player(s) from kill tracker (DB)`);
        }
      }
      if (raw) {
        // Migrate old records: ensure all fields exist
        for (const record of Object.values(this._data.players)) {
          if (!record.survivalCumulative) record.survivalCumulative = KillTracker._emptyObj(KillTracker.SURVIVAL_KEYS);
          if (!record.survivalSnapshot) record.survivalSnapshot = KillTracker._emptyObj(KillTracker.SURVIVAL_KEYS);
          if (!record.deathCheckpoint) record.deathCheckpoint = null;
          if (record.lastKnownDeaths === undefined) record.lastKnownDeaths = 0;
          if (!record.lifetimeSnapshot) record.lifetimeSnapshot = null;
          if (!record.survivalLifetimeSnapshot) record.survivalLifetimeSnapshot = null;
          if (!record.lastLifetimeSnapshot)
            record.lastLifetimeSnapshot = record.lifetimeSnapshot ? { ...record.lifetimeSnapshot } : null;
          if (!record.lastSurvivalLifetimeSnapshot)
            record.lastSurvivalLifetimeSnapshot = record.survivalLifetimeSnapshot
              ? { ...record.survivalLifetimeSnapshot }
              : null;
          if (!record.activitySnapshot)
            record.activitySnapshot = KillTracker._emptyObj(KillTracker.ACTIVITY_SCALAR_KEYS);
          if (!record.activityArraySnapshot) {
            record.activityArraySnapshot = {};
            for (const k of KillTracker.ACTIVITY_ARRAY_KEYS) record.activityArraySnapshot[k] = [];
          }
          if (!record.challengeSnapshot) record.challengeSnapshot = KillTracker._emptyObj(KillTracker.CHALLENGE_KEYS);
        }
      }
    } catch (err) {
      this._log.error('Failed to load kill tracker, starting fresh:', err.message);
      this._data = { players: {} };
    }
  }

  save() {
    if (!this._dirty) return;
    try {
      if (this._db) this._db.setStateJSON('kill_tracker', this._data);
      this._dirty = false;
    } catch (err) {
      this._log.error('Failed to save kill tracker:', err.message);
    }
  }

  /** Expose raw data for PSC's _cacheWelcomeStats and embed builders */
  get players() {
    return this._data.players;
  }
  get lastPollDate() {
    return this._data.lastPollDate || null;
  }
  set lastPollDate(v) {
    this._data.lastPollDate = v;
    this._dirty = true;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Static helpers
  // ═══════════════════════════════════════════════════════════════════════════

  static _emptyObj(keys) {
    const obj = {};
    for (const k of keys) obj[k] = 0;
    return obj;
  }

  static _emptyKills() {
    return KillTracker._emptyObj(KillTracker.KILL_KEYS);
  }

  static _snapshotKills(save) {
    const obj = {};
    for (const k of KillTracker.KILL_KEYS) obj[k] = save[k] || 0;
    return obj;
  }

  static _snapshotSurvival(save) {
    const obj = {};
    for (const k of KillTracker.SURVIVAL_KEYS) obj[k] = save[k] || 0;
    return obj;
  }

  static _snapshotChallenges(save) {
    const obj = {};
    for (const k of KillTracker.CHALLENGE_KEYS) obj[k] = save[k] || 0;
    return obj;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Accumulation — compute deltas between save polls
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Process a new save poll: compute deltas, update snapshots, return arrays.
   *
   * @param {Map<string,object>} saveData - steamId → save data map
   * @param {object} [opts] - { gameData } for challenge descriptions
   * @returns {{ deltas: object, targetDate: string }} deltas object + which date they belong to
   */
  accumulate(saveData, opts = {}) {
    const today = this._config.getToday();
    const gameData = opts.gameData || null;

    // Determine which date's thread these deltas belong to.
    const lastPollDate = this._data.lastPollDate || null;
    const targetDate = lastPollDate && lastPollDate !== today ? lastPollDate : today;
    this._data.lastPollDate = today;
    this._dirty = true;

    if (targetDate !== today) {
      this._log.info(`First poll after restart — pending deltas for ${targetDate}`);
    }

    const killDeltas = [];
    const survivalDeltas = [];
    const fishingDeltas = [];
    const recipeDeltas = [];
    const skillDeltas = [];
    const professionDeltas = [];
    const loreDeltas = [];
    const uniqueDeltas = [];
    const companionDeltas = [];
    const challengeDeltas = [];

    for (const [id, save] of saveData) {
      const currentKills = KillTracker._snapshotKills(save);
      const currentSurvival = KillTracker._snapshotSurvival(save);

      if (!this._data.players[id]) {
        // First time seeing this player — initialise
        const logDeaths = this._playerStats.getStats(id)?.deaths || 0;
        const actSnapshot = {};
        for (const k of KillTracker.ACTIVITY_SCALAR_KEYS) actSnapshot[k] = save[k] || 0;
        const arrSnapshot = {};
        for (const k of KillTracker.ACTIVITY_ARRAY_KEYS) arrSnapshot[k] = Array.isArray(save[k]) ? [...save[k]] : [];
        this._data.players[id] = {
          cumulative: KillTracker._emptyKills(),
          lastSnapshot: currentKills,
          survivalCumulative: KillTracker._emptyObj(KillTracker.SURVIVAL_KEYS),
          survivalSnapshot: currentSurvival,
          hasExtendedStats: !!save.hasExtendedStats,
          deathCheckpoint: null,
          lastKnownDeaths: logDeaths,
          lifetimeSnapshot: null,
          survivalLifetimeSnapshot: null,
          lastLifetimeSnapshot: null,
          lastSurvivalLifetimeSnapshot: null,
          activitySnapshot: actSnapshot,
          activityArraySnapshot: arrSnapshot,
          challengeSnapshot: KillTracker._snapshotChallenges(save),
        };
        // Cache lifetime values if available
        if (save.hasExtendedStats) {
          const ls = {};
          for (const k of KillTracker.KILL_KEYS) {
            const lifetimeKey = KillTracker.LIFETIME_KEY_MAP[k];
            ls[k] = lifetimeKey ? save[lifetimeKey] || 0 : 0;
          }
          this._data.players[id].lifetimeSnapshot = ls;
          this._data.players[id].lastLifetimeSnapshot = { ...ls };
          this._data.players[id].survivalLifetimeSnapshot = {
            daysSurvived: save.lifetimeDaysSurvived || save.daysSurvived || 0,
          };
          this._data.players[id].lastSurvivalLifetimeSnapshot = {
            ...this._data.players[id].survivalLifetimeSnapshot,
          };
        }
        this._dirty = true;
        continue;
      }

      const record = this._data.players[id];
      const lastKills = record.lastSnapshot;
      const lastSurvival = record.survivalSnapshot || KillTracker._emptyObj(KillTracker.SURVIVAL_KEYS);
      const playerName = resolvePlayer(id, {
        playtime: this._playtime,
        playerStats: this._playerStats,
        saveData,
      }).name;

      // ExtendedStats path
      if (save.hasExtendedStats) {
        record.hasExtendedStats = true;
        // Clear stale cumulative data
        if (record.cumulative.zeeksKilled > 0 || record.survivalCumulative?.daysSurvived > 0) {
          this._log.info(`${id}: ExtendedStats available — clearing banked cumulative`);
          record.cumulative = KillTracker._emptyKills();
          record.survivalCumulative = KillTracker._emptyObj(KillTracker.SURVIVAL_KEYS);
        }
        // Cache lifetime values
        const ls = {};
        for (const k of KillTracker.KILL_KEYS) {
          const lifetimeKey = KillTracker.LIFETIME_KEY_MAP[k];
          ls[k] = lifetimeKey ? save[lifetimeKey] || 0 : 0;
        }
        record.lifetimeSnapshot = ls;
        record.survivalLifetimeSnapshot = {
          daysSurvived: save.lifetimeDaysSurvived || save.daysSurvived || 0,
        };

        // Death checkpoint
        const logDeaths = this._playerStats.getStats(id)?.deaths || 0;
        const prevDeaths = record.lastKnownDeaths || 0;
        if (logDeaths > prevDeaths) {
          const cp = {};
          for (const k of KillTracker.KILL_KEYS) {
            const lifetimeKey = KillTracker.LIFETIME_KEY_MAP[k];
            const lifetime = lifetimeKey ? save[lifetimeKey] || 0 : 0;
            cp[k] = lifetime - (currentKills[k] || 0);
          }
          record.deathCheckpoint = cp;
          record.lastKnownDeaths = logDeaths;
          this._log.info(
            `${id}: death #${logDeaths} — checkpoint set (lifetime ${save.lifetimeKills || 0}, session ${currentKills.zeeksKilled})`,
          );
          this._dirty = true;
        } else if (record.lastKnownDeaths !== logDeaths) {
          record.lastKnownDeaths = logDeaths;
          this._dirty = true;
        }
      } else {
        // Legacy fallback: detect death reset
        const deathReset = currentKills.zeeksKilled < lastKills.zeeksKilled;
        if (deathReset) {
          for (const k of KillTracker.KILL_KEYS) {
            record.cumulative[k] += lastKills[k];
          }
          if (!record.survivalCumulative) record.survivalCumulative = KillTracker._emptyObj(KillTracker.SURVIVAL_KEYS);
          for (const k of KillTracker.SURVIVAL_KEYS) {
            record.survivalCumulative[k] += lastSurvival[k];
          }
          this._log.info(
            `${id}: death detected — banked ${lastKills.zeeksKilled} kills, ${lastSurvival.daysSurvived} days`,
          );
          record.lastSnapshot = currentKills;
          record.survivalSnapshot = currentSurvival;
          this._dirty = true;
          continue;
        }
      }

      // ── Kill deltas ──
      const killDelta = {};
      let hasKills = false;
      if (record.hasExtendedStats && record.lifetimeSnapshot) {
        const prevLifetime = record.lastLifetimeSnapshot || KillTracker._emptyKills();
        for (const k of KillTracker.KILL_KEYS) {
          const diff = (record.lifetimeSnapshot[k] || 0) - (prevLifetime[k] || 0);
          if (diff > 0) {
            killDelta[k] = diff;
            hasKills = true;
          }
        }
        record.lastLifetimeSnapshot = { ...record.lifetimeSnapshot };
      } else {
        for (const k of KillTracker.KILL_KEYS) {
          const diff = currentKills[k] - lastKills[k];
          if (diff > 0) {
            killDelta[k] = diff;
            hasKills = true;
          }
        }
      }
      if (hasKills) {
        killDeltas.push({ steamId: id, name: playerName, delta: killDelta });
      }

      // ── Survival deltas ──
      const survDelta = {};
      let hasSurv = false;
      if (record.hasExtendedStats && record.survivalLifetimeSnapshot) {
        const prevSurvLifetime =
          record.lastSurvivalLifetimeSnapshot || KillTracker._emptyObj(KillTracker.SURVIVAL_KEYS);
        for (const k of KillTracker.SURVIVAL_KEYS) {
          const diff = (record.survivalLifetimeSnapshot[k] || 0) - (prevSurvLifetime[k] || 0);
          if (diff > 0) {
            survDelta[k] = diff;
            hasSurv = true;
          }
        }
        record.lastSurvivalLifetimeSnapshot = { ...record.survivalLifetimeSnapshot };
      } else {
        for (const k of KillTracker.SURVIVAL_KEYS) {
          const diff = currentSurvival[k] - lastSurvival[k];
          if (diff > 0) {
            survDelta[k] = diff;
            hasSurv = true;
          }
        }
      }
      if (hasSurv) {
        survivalDeltas.push({ steamId: id, name: playerName, delta: survDelta });
      }

      // ── Activity scalar diffs (fishing, bites) ──
      const prevAct = record.activitySnapshot || KillTracker._emptyObj(KillTracker.ACTIVITY_SCALAR_KEYS);
      const fishDelta = {};
      let hasFish = false;
      for (const k of KillTracker.ACTIVITY_SCALAR_KEYS) {
        const diff = (save[k] || 0) - (prevAct[k] || 0);
        if (diff > 0) {
          fishDelta[k] = diff;
          hasFish = true;
        }
      }
      if (hasFish) {
        fishingDeltas.push({ steamId: id, name: playerName, delta: fishDelta });
      }
      const newActSnapshot = {};
      for (const k of KillTracker.ACTIVITY_SCALAR_KEYS) newActSnapshot[k] = save[k] || 0;
      record.activitySnapshot = newActSnapshot;

      // ── Activity array diffs (recipes, skills, professions, lore, uniques, companions) ──
      const prevArr = record.activityArraySnapshot || {};
      const newArrSnapshot = {};
      for (const k of KillTracker.ACTIVITY_ARRAY_KEYS) {
        const current = Array.isArray(save[k]) ? save[k] : [];
        const prev = Array.isArray(prevArr[k]) ? prevArr[k] : [];
        newArrSnapshot[k] = [...current];

        if (current.length > prev.length) {
          const prevSet = new Set(prev.map((v) => (typeof v === 'object' ? JSON.stringify(v) : String(v))));
          const newItems = current.filter((v) => {
            const key = typeof v === 'object' ? JSON.stringify(v) : String(v);
            return !prevSet.has(key);
          });
          if (newItems.length > 0) {
            if (k === 'craftingRecipes' || k === 'buildingRecipes') {
              recipeDeltas.push({
                steamId: id,
                name: playerName,
                type: k === 'craftingRecipes' ? 'Crafting' : 'Building',
                items: newItems,
              });
            } else if (k === 'unlockedSkills') {
              skillDeltas.push({ steamId: id, name: playerName, items: newItems });
            } else if (k === 'unlockedProfessions') {
              professionDeltas.push({ steamId: id, name: playerName, items: newItems });
            } else if (k === 'lore') {
              loreDeltas.push({ steamId: id, name: playerName, items: newItems });
            } else if (k === 'lootItemUnique' || k === 'craftedUniques') {
              uniqueDeltas.push({
                steamId: id,
                name: playerName,
                type: k === 'lootItemUnique' ? 'found' : 'crafted',
                items: newItems,
              });
            } else if (k === 'companionData' || k === 'horses') {
              companionDeltas.push({
                steamId: id,
                name: playerName,
                type: k === 'horses' ? 'horse' : 'companion',
                items: newItems,
              });
            }
          }
        }
      }
      record.activityArraySnapshot = newArrSnapshot;

      // ── Challenge completion detection ──
      if (save.hasExtendedStats && gameData?.CHALLENGE_DESCRIPTIONS) {
        const prevChal = record.challengeSnapshot || KillTracker._emptyObj(KillTracker.CHALLENGE_KEYS);
        const completedNow = [];
        for (const k of KillTracker.CHALLENGE_KEYS) {
          const cur = save[k] || 0;
          const prev = prevChal[k] || 0;
          if (cur > prev) {
            const info = gameData.CHALLENGE_DESCRIPTIONS[k];
            if (info) {
              const wasComplete = info.target ? prev >= info.target : prev > 0;
              const isComplete = info.target ? cur >= info.target : cur > 0;
              if (!wasComplete && isComplete) {
                completedNow.push({ key: k, name: info.name, desc: info.desc });
              }
            }
          }
        }
        if (completedNow.length > 0) {
          challengeDeltas.push({ steamId: id, name: playerName, completed: completedNow });
        }
        record.challengeSnapshot = KillTracker._snapshotChallenges(save);
      }

      record.lastSnapshot = currentKills;
      record.survivalSnapshot = currentSurvival;
      this._dirty = true;
    }

    this.save();

    return {
      deltas: {
        killDeltas,
        survivalDeltas,
        fishingDeltas,
        recipeDeltas,
        skillDeltas,
        professionDeltas,
        loreDeltas,
        uniqueDeltas,
        companionDeltas,
        challengeDeltas,
      },
      targetDate,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Queries — all-time stats (persist across deaths)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get all-time kill totals for a player (lifetime across deaths).
   * @param {string} steamId
   * @param {Map<string,object>} saveData - current save data map
   * @returns {object|null} { zeeksKilled, headshots, ... }
   */
  getAllTimeKills(steamId, saveData) {
    const record = this._data.players[steamId];
    const save = saveData instanceof Map ? saveData.get(steamId) : null;
    if (!record && !save) return null;

    const allTime = KillTracker._emptyKills();

    // ExtendedStats lifetime values (persist across deaths)
    if (save?.hasExtendedStats) {
      allTime.zeeksKilled = save.lifetimeKills || 0;
      allTime.headshots = save.lifetimeHeadshots || 0;
      allTime.meleeKills = save.lifetimeMeleeKills || 0;
      allTime.gunKills = save.lifetimeGunKills || 0;
      allTime.blastKills = save.lifetimeBlastKills || 0;
      allTime.fistKills = save.lifetimeFistKills || 0;
      allTime.takedownKills = save.lifetimeTakedownKills || 0;
      allTime.vehicleKills = save.lifetimeVehicleKills || 0;
      return allTime;
    }

    // Offline but previously had ExtendedStats — use cached lifetime
    if (record?.hasExtendedStats && record.lifetimeSnapshot) {
      for (const k of KillTracker.KILL_KEYS) {
        allTime[k] = record.lifetimeSnapshot[k] || 0;
      }
      return allTime;
    }

    // Legacy fallback: cumulative (banked) + current save
    if (record) {
      for (const k of KillTracker.KILL_KEYS) {
        allTime[k] += record.cumulative[k];
      }
    }
    if (save) {
      for (const k of KillTracker.KILL_KEYS) {
        allTime[k] += save[k] || 0;
      }
    }
    return allTime;
  }

  /**
   * Get current-life kills for a player.
   * ExtendedStats: lifetime - deathCheckpoint.
   * Legacy: raw GameStats values.
   * @param {string} steamId
   * @param {Map<string,object>} saveData
   * @returns {object|null}
   */
  getCurrentLifeKills(steamId, saveData) {
    const record = this._data.players[steamId];
    const save = saveData instanceof Map ? saveData.get(steamId) : null;
    if (!save) return null;

    // ExtendedStats: compute from lifetime - checkpoint
    if (save.hasExtendedStats && record?.deathCheckpoint) {
      const life = {};
      for (const k of KillTracker.KILL_KEYS) {
        const lifetimeKey = KillTracker.LIFETIME_KEY_MAP[k];
        const lifetime = lifetimeKey ? save[lifetimeKey] || 0 : 0;
        life[k] = Math.max(0, lifetime - (record.deathCheckpoint[k] || 0));
      }
      return life;
    }

    // ExtendedStats, never died: all lifetime kills are current life
    if (save.hasExtendedStats) {
      const life = {};
      for (const k of KillTracker.KILL_KEYS) {
        const lifetimeKey = KillTracker.LIFETIME_KEY_MAP[k];
        life[k] = lifetimeKey ? save[lifetimeKey] || 0 : 0;
      }
      return life;
    }

    // Offline, previously ExtendedStats — cached lifetime - checkpoint
    if (record?.hasExtendedStats && record.lifetimeSnapshot) {
      if (record.deathCheckpoint) {
        const life = {};
        for (const k of KillTracker.KILL_KEYS) {
          life[k] = Math.max(0, (record.lifetimeSnapshot[k] || 0) - (record.deathCheckpoint[k] || 0));
        }
        return life;
      }
      return { ...record.lifetimeSnapshot };
    }

    // Legacy: GameStats is the current-life value
    return KillTracker._snapshotKills(save);
  }

  /**
   * Get all-time survival days for a player.
   * @param {string} steamId
   * @param {Map<string,object>} saveData
   * @returns {object|null} { daysSurvived }
   */
  getAllTimeSurvival(steamId, saveData) {
    const record = this._data.players[steamId];
    const save = saveData instanceof Map ? saveData.get(steamId) : null;
    if (!record && !save) return null;

    const allTime = KillTracker._emptyObj(KillTracker.SURVIVAL_KEYS);

    if (save?.hasExtendedStats) {
      allTime.daysSurvived = save.lifetimeDaysSurvived || save.daysSurvived || 0;
      return allTime;
    }

    if (record?.hasExtendedStats && record.survivalLifetimeSnapshot) {
      allTime.daysSurvived = record.survivalLifetimeSnapshot.daysSurvived || 0;
      return allTime;
    }

    // Legacy fallback
    if (record?.survivalCumulative) {
      for (const k of KillTracker.SURVIVAL_KEYS) {
        allTime[k] += record.survivalCumulative[k];
      }
    }
    if (save) {
      for (const k of KillTracker.SURVIVAL_KEYS) {
        allTime[k] += save[k] || 0;
      }
    }
    return allTime;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Weekly stats
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Compute weekly delta leaderboards by comparing current stats to a baseline.
   * Manages baseline persistence: loads/resets from DB on week rollover.
   *
   * @param {Map<string,object>} saveData
   * @returns {object|null} { weekStart, topKillers, topPvpKillers, topFishers, topBitten, topPlaytime }
   */
  computeWeeklyStats(saveData) {
    if (!this._config.showWeeklyStats) return null;

    let baseline = { weekStart: null, players: {} };
    try {
      if (this._db) {
        const saved = this._db.getStateJSON('weekly_baseline', null);
        if (saved) baseline = saved;
      }
    } catch (_) {}

    const now = new Date();
    const needsReset = !baseline.weekStart || this._isNewWeek(baseline.weekStart, now);

    if (needsReset) {
      baseline = { weekStart: now.toISOString(), players: {} };
      for (const [id] of saveData) {
        baseline.players[id] = this._snapshotPlayerStats(id, saveData);
      }
      try {
        if (this._db) this._db.setStateJSON('weekly_baseline', baseline);
        this._log.info('Weekly baseline reset');
      } catch (err) {
        this._log.error('Failed to write weekly baseline:', err.message);
      }
    }

    const allLog = this._playerStats.getAllPlayers();
    const logMap = new Map(allLog.map((p) => [p.id, p]));

    const weeklyKillers = [];
    const weeklyPvpKillers = [];
    const weeklyFishers = [];
    const weeklyBitten = [];
    const weeklyPlaytime = [];

    const allIds = new Set([...saveData.keys(), ...allLog.map((p) => p.id)]);
    for (const id of allIds) {
      const resolved = resolvePlayer(id, { playtime: this._playtime, playerStats: this._playerStats, saveData });
      const snap = baseline.players[id] || {};

      const at = this.getAllTimeKills(id, saveData);
      const kills = (at?.zeeksKilled || 0) - (snap.kills || 0);
      if (kills > 0) weeklyKillers.push({ name: resolved.name, kills });

      const log = logMap.get(id);
      const pvp = (log?.pvpKills || 0) - (snap.pvpKills || 0);
      if (pvp > 0) weeklyPvpKillers.push({ name: resolved.name, kills: pvp });

      const save = saveData.get(id);
      const fish = (save?.fishCaught || 0) - (snap.fish || 0);
      if (fish > 0) weeklyFishers.push({ name: resolved.name, count: fish });

      const bites = (save?.timesBitten || 0) - (snap.bitten || 0);
      if (bites > 0) weeklyBitten.push({ name: resolved.name, count: bites });

      const pt = this._playtime.getPlaytime(id);
      const ptMs = (pt?.totalMs || 0) - (snap.playtimeMs || 0);
      if (ptMs > 60000) weeklyPlaytime.push({ name: resolved.name, ms: ptMs });
    }

    weeklyKillers.sort((a, b) => b.kills - a.kills);
    weeklyPvpKillers.sort((a, b) => b.kills - a.kills);
    weeklyFishers.sort((a, b) => b.count - a.count);
    weeklyBitten.sort((a, b) => b.count - a.count);
    weeklyPlaytime.sort((a, b) => b.ms - a.ms);

    return {
      weekStart: baseline.weekStart,
      topKillers: weeklyKillers.slice(0, 5),
      topPvpKillers: weeklyPvpKillers.slice(0, 5),
      topFishers: weeklyFishers.slice(0, 5),
      topBitten: weeklyBitten.slice(0, 5),
      topPlaytime: weeklyPlaytime.slice(0, 5),
    };
  }

  /**
   * Snapshot a player's current stats for weekly baseline comparison.
   */
  _snapshotPlayerStats(id, saveData) {
    const at = this.getAllTimeKills(id, saveData);
    const log = this._playerStats.getStats(id);
    const save = saveData.get(id);
    const pt = this._playtime.getPlaytime(id);
    return {
      kills: at?.zeeksKilled || 0,
      pvpKills: log?.pvpKills || 0,
      fish: save?.fishCaught || 0,
      bitten: save?.timesBitten || 0,
      playtimeMs: pt?.totalMs || 0,
      craftingRecipes: save?.craftingRecipes?.length || 0,
      buildingRecipes: save?.buildingRecipes?.length || 0,
      unlockedSkills: save?.unlockedSkills?.length || 0,
      unlockedProfessions: save?.unlockedProfessions?.length || 0,
      lore: save?.lore?.length || 0,
      uniqueLoots: save?.uniqueLoots?.length || 0,
      craftedUniques: save?.craftedUniques?.length || 0,
      companions: (save?.companionData?.length || 0) + (save?.horses?.length || 0),
    };
  }

  /**
   * Check if the baseline's weekStart falls in a previous week.
   */
  _isNewWeek(weekStartIso, now) {
    const resetDay = this._config.weeklyResetDay;
    const dayStr = now.toLocaleDateString('en-US', {
      weekday: 'short',
      timeZone: this._config.botTimezone,
    });
    const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const currentDay = dayMap[dayStr] ?? now.getDay();
    const daysSinceReset = (currentDay - resetDay + 7) % 7;

    const todayStr = now.toLocaleDateString('en-CA', { timeZone: this._config.botTimezone });
    const [y, m, d] = todayStr.split('-').map(Number);
    const resetDate = new Date(Date.UTC(y, m - 1, d - daysSinceReset));
    const resetDateStr = resetDate.toISOString().slice(0, 10);

    const weekStart = new Date(weekStartIso);
    const weekStartDateStr = weekStart.toLocaleDateString('en-CA', { timeZone: this._config.botTimezone });

    return weekStartDateStr < resetDateStr;
  }
}

module.exports = KillTracker;
module.exports.resolvePlayer = resolvePlayer;

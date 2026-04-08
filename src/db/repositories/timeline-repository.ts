import type Database from 'better-sqlite3';
import { BaseRepository } from './base-repository.js';
import { type DbRow } from './db-utils.js';

export class TimelineRepository extends BaseRepository {
  declare private _stmts: {
    insertTimelineSnapshot: Database.Statement;
    getTimelineSnapshots: Database.Statement;
    getTimelineSnapshotRange: Database.Statement;
    getTimelineSnapshotById: Database.Statement;
    getTimelineSnapshotCount: Database.Statement;
    purgeOldTimeline: Database.Statement;
    getTimelineSnapshotBounds: Database.Statement;
    insertTimelinePlayer: Database.Statement;
    insertTimelineAI: Database.Statement;
    insertTimelineVehicle: Database.Statement;
    insertTimelineStructure: Database.Statement;
    insertTimelineHouse: Database.Statement;
    insertTimelineCompanion: Database.Statement;
    insertTimelineBackpack: Database.Statement;
    getTimelinePlayers: Database.Statement;
    getTimelineAI: Database.Statement;
    getTimelineVehicles: Database.Statement;
    getTimelineStructures: Database.Statement;
    getTimelineHouses: Database.Statement;
    getTimelineCompanions: Database.Statement;
    getTimelineBackpacks: Database.Statement;
    getPlayerPositionHistory: Database.Statement;
    getAIPopulationHistory: Database.Statement;
  };

  protected _prepareStatements(): void {
    this._stmts = {
      // ── Timeline snapshots ──
      insertTimelineSnapshot: this._handle.prepare(`
        INSERT INTO timeline_snapshots (game_day, game_time, player_count, online_count,
          ai_count, structure_count, vehicle_count, container_count, world_item_count,
          weather_type, season, airdrop_active, airdrop_x, airdrop_y, airdrop_ai_alive, summary)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      getTimelineSnapshots: this._handle.prepare('SELECT * FROM timeline_snapshots ORDER BY created_at DESC LIMIT ?'),
      getTimelineSnapshotRange: this._handle.prepare(
        'SELECT * FROM timeline_snapshots WHERE created_at BETWEEN ? AND ? ORDER BY created_at ASC',
      ),
      getTimelineSnapshotById: this._handle.prepare('SELECT * FROM timeline_snapshots WHERE id = ?'),
      getTimelineSnapshotCount: this._handle.prepare('SELECT COUNT(*) as count FROM timeline_snapshots'),
      purgeOldTimeline: this._handle.prepare("DELETE FROM timeline_snapshots WHERE created_at < datetime('now', ?)"),
      getTimelineSnapshotBounds: this._handle.prepare(
        'SELECT MIN(created_at) as earliest, MAX(created_at) as latest, COUNT(*) as count FROM timeline_snapshots',
      ),

      // ── Timeline entity inserts (bulk via transactions) ──
      insertTimelinePlayer: this._handle.prepare(`
        INSERT INTO timeline_players (snapshot_id, steam_id, name, online, pos_x, pos_y, pos_z,
          health, max_health, hunger, thirst, infection, stamina, level, zeeks_killed, days_survived, lifetime_kills)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      insertTimelineAI: this._handle.prepare(`
        INSERT INTO timeline_ai (snapshot_id, ai_type, category, display_name, node_uid, pos_x, pos_y, pos_z)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `),
      insertTimelineVehicle: this._handle.prepare(`
        INSERT INTO timeline_vehicles (snapshot_id, class, display_name, pos_x, pos_y, pos_z, health, max_health, fuel, item_count)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      insertTimelineStructure: this._handle.prepare(`
        INSERT INTO timeline_structures (snapshot_id, actor_class, display_name, owner_steam_id, pos_x, pos_y, pos_z, current_health, max_health, upgrade_level)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      insertTimelineHouse: this._handle.prepare(`
        INSERT INTO timeline_houses (snapshot_id, uid, name, windows_open, windows_total, doors_open, doors_locked, doors_total, destroyed_furniture, has_generator, sleepers, clean, pos_x, pos_y)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      insertTimelineCompanion: this._handle.prepare(`
        INSERT INTO timeline_companions (snapshot_id, entity_type, actor_name, display_name, owner_steam_id, pos_x, pos_y, pos_z, health, extra)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      insertTimelineBackpack: this._handle.prepare(`
        INSERT INTO timeline_backpacks (snapshot_id, class, pos_x, pos_y, pos_z, item_count, items_summary)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `),

      // ── Timeline queries (for time-scroll API) ──
      getTimelinePlayers: this._handle.prepare('SELECT * FROM timeline_players WHERE snapshot_id = ?'),
      getTimelineAI: this._handle.prepare('SELECT * FROM timeline_ai WHERE snapshot_id = ?'),
      getTimelineVehicles: this._handle.prepare('SELECT * FROM timeline_vehicles WHERE snapshot_id = ?'),
      getTimelineStructures: this._handle.prepare('SELECT * FROM timeline_structures WHERE snapshot_id = ?'),
      getTimelineHouses: this._handle.prepare('SELECT * FROM timeline_houses WHERE snapshot_id = ?'),
      getTimelineCompanions: this._handle.prepare('SELECT * FROM timeline_companions WHERE snapshot_id = ?'),
      getTimelineBackpacks: this._handle.prepare('SELECT * FROM timeline_backpacks WHERE snapshot_id = ?'),

      // Player position history (for trails/heatmaps)
      getPlayerPositionHistory: this._handle.prepare(`
        SELECT tp.pos_x, tp.pos_y, tp.pos_z, tp.health, tp.online, ts.created_at, ts.game_day
        FROM timeline_players tp
        JOIN timeline_snapshots ts ON tp.snapshot_id = ts.id
        WHERE tp.steam_id = ? AND ts.created_at BETWEEN ? AND ?
        ORDER BY ts.created_at ASC
      `),

      // AI population summary over time
      getAIPopulationHistory: this._handle.prepare(`
        SELECT ts.id, ts.created_at, ts.game_day, ts.ai_count,
          (SELECT COUNT(*) FROM timeline_ai WHERE snapshot_id = ts.id AND category = 'zombie') as zombies,
          (SELECT COUNT(*) FROM timeline_ai WHERE snapshot_id = ts.id AND category = 'animal') as animals,
          (SELECT COUNT(*) FROM timeline_ai WHERE snapshot_id = ts.id AND category = 'bandit') as bandits
        FROM timeline_snapshots ts
        WHERE ts.created_at BETWEEN ? AND ?
        ORDER BY ts.created_at ASC
      `),
    };
  }

  /**
   * Record a complete world snapshot (one timeline tick).
   * All entity arrays are written inside a single transaction for consistency.
   *
   * @param {object} data
   * @param {object} data.snapshot - { gameDday, gameTime, playerCount, onlineCount, aiCount, ... }
   * @param {Array}  data.players  - [{ steamId, name, online, x, y, z, health, ... }]
   * @param {Array}  data.ai       - [{ aiType, category, displayName, nodeUid, x, y, z }]
   * @param {Array}  data.vehicles - [{ class, displayName, x, y, z, health, ... }]
   * @param {Array}  data.structures - [{ actorClass, displayName, ownerSteamId, ... }]
   * @param {Array}  data.houses   - [{ uid, name, windowsOpen, ... }]
   * @param {Array}  data.companions - [{ entityType, actorName, ... }]
   * @param {Array}  data.backpacks - [{ class, x, y, z, itemCount, items }]
   * @returns {number} The snapshot ID
   */
  insertTimelineSnapshot(data: Record<string, unknown>): number {
    const s = (data.snapshot || {}) as Record<string, unknown>;
    const result = this._stmts.insertTimelineSnapshot.run(
      s.gameDay || 0,
      s.gameTime || 0,
      s.playerCount || 0,
      s.onlineCount || 0,
      s.aiCount || 0,
      s.structureCount || 0,
      s.vehicleCount || 0,
      s.containerCount || 0,
      s.worldItemCount || 0,
      s.weatherType || '',
      s.season || '',
      s.airdropActive ? 1 : 0,
      s.airdropX ?? null,
      s.airdropY ?? null,
      s.airdropAiAlive || 0,
      JSON.stringify(s.summary || {}),
    );
    const snapId = result.lastInsertRowid;

    const tx = this._handle.transaction(() => {
      // Players
      if (data.players) {
        for (const p of data.players as Array<Record<string, unknown>>) {
          this._stmts.insertTimelinePlayer.run(
            snapId,
            p.steamId,
            p.name || '',
            p.online ? 1 : 0,
            p.x ?? null,
            p.y ?? null,
            p.z ?? null,
            p.health || 0,
            p.maxHealth || 100,
            p.hunger || 0,
            p.thirst || 0,
            p.infection || 0,
            p.stamina || 0,
            p.level || 0,
            p.zeeksKilled || 0,
            p.daysSurvived || 0,
            p.lifetimeKills || 0,
          );
        }
      }

      // AI spawns
      if (data.ai) {
        for (const a of data.ai as Array<Record<string, unknown>>) {
          this._stmts.insertTimelineAI.run(
            snapId,
            a.aiType,
            a.category || '',
            a.displayName || '',
            a.nodeUid || '',
            a.x ?? null,
            a.y ?? null,
            a.z ?? null,
          );
        }
      }

      // Vehicles
      if (data.vehicles) {
        for (const v of data.vehicles as Array<Record<string, unknown>>) {
          this._stmts.insertTimelineVehicle.run(
            snapId,
            v.class,
            v.displayName || '',
            v.x ?? null,
            v.y ?? null,
            v.z ?? null,
            v.health || 0,
            v.maxHealth || 0,
            v.fuel || 0,
            v.itemCount || 0,
          );
        }
      }

      // Structures
      if (data.structures) {
        for (const st of data.structures as Array<Record<string, unknown>>) {
          this._stmts.insertTimelineStructure.run(
            snapId,
            st.actorClass,
            st.displayName || '',
            st.ownerSteamId || '',
            st.x ?? null,
            st.y ?? null,
            st.z ?? null,
            st.currentHealth || 0,
            st.maxHealth || 0,
            st.upgradeLevel || 0,
          );
        }
      }

      // Houses
      if (data.houses) {
        for (const h of data.houses as Array<Record<string, unknown>>) {
          this._stmts.insertTimelineHouse.run(
            snapId,
            h.uid,
            h.name || '',
            h.windowsOpen || 0,
            h.windowsTotal || 0,
            h.doorsOpen || 0,
            h.doorsLocked || 0,
            h.doorsTotal || 0,
            h.destroyedFurniture || 0,
            h.hasGenerator ? 1 : 0,
            h.sleepers || 0,
            h.clean || 0,
            h.x ?? null,
            h.y ?? null,
          );
        }
      }

      // Companions + horses
      if (data.companions) {
        for (const c of data.companions as Array<Record<string, unknown>>) {
          this._stmts.insertTimelineCompanion.run(
            snapId,
            c.entityType,
            c.actorName || '',
            c.displayName || '',
            c.ownerSteamId || '',
            c.x ?? null,
            c.y ?? null,
            c.z ?? null,
            c.health || 0,
            JSON.stringify(c.extra || {}),
          );
        }
      }

      // Dropped backpacks
      if (data.backpacks) {
        for (const b of data.backpacks as Array<Record<string, unknown>>) {
          this._stmts.insertTimelineBackpack.run(
            snapId,
            b.class || '',
            b.x ?? null,
            b.y ?? null,
            b.z ?? null,
            b.itemCount || 0,
            JSON.stringify(b.items || []),
          );
        }
      }
    });

    tx();
    return Number(snapId);
  }

  /** Get recent timeline snapshots (metadata only). */
  getTimelineSnapshots(limit = 50): DbRow[] {
    return (this._stmts.getTimelineSnapshots.all(limit) as DbRow[]).map((r) => {
      if (r.summary && typeof r.summary === 'string')
        try {
          r.summary = JSON.parse(r.summary) as unknown;
        } catch {
          /* */
        }
      return r;
    });
  }

  /** Get timeline snapshots in a date range. */
  getTimelineSnapshotRange(from: string, to: string): DbRow[] {
    return (this._stmts.getTimelineSnapshotRange.all(from, to) as DbRow[]).map((r) => {
      if (r.summary && typeof r.summary === 'string')
        try {
          r.summary = JSON.parse(r.summary) as unknown;
        } catch {
          /* */
        }
      return r;
    });
  }

  /** Get full snapshot data by ID (all entities). */
  getTimelineSnapshotFull(snapshotId: number) {
    const snap = this._stmts.getTimelineSnapshotById.get(snapshotId) as DbRow | undefined;
    if (!snap) return null;
    if (snap.summary)
      try {
        snap.summary = JSON.parse(snap.summary as string);
      } catch {
        /* */
      }
    return {
      snapshot: snap,
      players: this._stmts.getTimelinePlayers.all(snapshotId),
      ai: this._stmts.getTimelineAI.all(snapshotId),
      vehicles: this._stmts.getTimelineVehicles.all(snapshotId),
      structures: this._stmts.getTimelineStructures.all(snapshotId),
      houses: this._stmts.getTimelineHouses.all(snapshotId),
      companions: this._stmts.getTimelineCompanions.all(snapshotId),

      backpacks: (this._stmts.getTimelineBackpacks.all(snapshotId) as DbRow[]).map((b) => {
        if (b.items_summary && typeof b.items_summary === 'string')
          try {
            b.items_summary = JSON.parse(b.items_summary) as unknown;
          } catch {
            /* */
          }
        return b;
      }),
    };
  }

  /** Get timeline bounds (earliest, latest, count). */
  getTimelineBounds() {
    return this._stmts.getTimelineSnapshotBounds.get();
  }

  /** Get player position history for trails. */
  getPlayerPositionHistory(steamId: string, from: string, to: string) {
    return this._stmts.getPlayerPositionHistory.all(steamId, from, to);
  }

  /** Get AI population history for charts. */
  getAIPopulationHistory(from: string, to: string) {
    return this._stmts.getAIPopulationHistory.all(from, to);
  }

  /** Purge old timeline data (default: keep 7 days). */
  purgeOldTimeline(olderThan: string = '-7 days') {
    return this._stmts.purgeOldTimeline.run(olderThan);
  }
}

import type Database from 'better-sqlite3';
import { BaseRepository } from './base-repository.js';
import { _json } from './db-utils.js';

export class WorldObjectRepository extends BaseRepository {
  declare private _stmts: {
    // Structures
    clearStructures: Database.Statement;
    insertStructure: Database.Statement;
    getStructures: Database.Statement;
    getStructuresByOwner: Database.Statement;
    countStructuresByOwner: Database.Statement;
    // Vehicles
    clearVehicles: Database.Statement;
    insertVehicle: Database.Statement;
    getAllVehicles: Database.Statement;
    // Companions
    clearCompanions: Database.Statement;
    insertCompanion: Database.Statement;
    getAllCompanions: Database.Statement;
    // World horses
    clearWorldHorses: Database.Statement;
    insertWorldHorse: Database.Statement;
    getAllWorldHorses: Database.Statement;
    // Dead bodies
    clearDeadBodies: Database.Statement;
    insertDeadBody: Database.Statement;
    // Containers
    clearContainers: Database.Statement;
    insertContainer: Database.Statement;
    getAllContainers: Database.Statement;
    getContainersWithItems: Database.Statement;
    // Loot actors
    clearLootActors: Database.Statement;
    insertLootActor: Database.Statement;
    // World drops
    clearWorldDrops: Database.Statement;
    insertWorldDrop: Database.Statement;
    getAllWorldDrops: Database.Statement;
    getWorldDropsByType: Database.Statement;
    getWorldDropsWithItems: Database.Statement;
  };

  protected _prepareStatements(): void {
    this._stmts = {
      // Structures
      clearStructures: this._handle.prepare('DELETE FROM structures'),
      insertStructure: this._handle.prepare(`
        INSERT INTO structures (actor_class, display_name, owner_steam_id, pos_x, pos_y, pos_z,
          current_health, max_health, upgrade_level, attached_to_trailer, inventory, no_spawn, extra_data, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `),
      getStructures: this._handle.prepare('SELECT * FROM structures ORDER BY actor_class'),
      getStructuresByOwner: this._handle.prepare('SELECT * FROM structures WHERE owner_steam_id = ?'),
      countStructuresByOwner: this._handle.prepare(
        'SELECT owner_steam_id, COUNT(*) as count FROM structures GROUP BY owner_steam_id ORDER BY count DESC',
      ),

      // Vehicles
      clearVehicles: this._handle.prepare('DELETE FROM vehicles'),
      insertVehicle: this._handle.prepare(`
        INSERT INTO vehicles (class, display_name, pos_x, pos_y, pos_z, health, max_health, fuel, inventory, upgrades, extra, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `),
      getAllVehicles: this._handle.prepare('SELECT * FROM vehicles'),

      // Companions
      clearCompanions: this._handle.prepare('DELETE FROM companions'),
      insertCompanion: this._handle.prepare(`
        INSERT INTO companions (type, actor_name, owner_steam_id, pos_x, pos_y, pos_z, health, extra, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `),
      getAllCompanions: this._handle.prepare('SELECT * FROM companions'),

      // World horses
      clearWorldHorses: this._handle.prepare('DELETE FROM world_horses'),
      insertWorldHorse: this._handle.prepare(`
        INSERT INTO world_horses (actor_name, class, display_name, horse_name, owner_steam_id, pos_x, pos_y, pos_z, health, max_health, energy, stamina, saddle_inventory, inventory, extra, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `),
      getAllWorldHorses: this._handle.prepare('SELECT * FROM world_horses'),

      // Dead bodies
      clearDeadBodies: this._handle.prepare('DELETE FROM dead_bodies'),
      insertDeadBody: this._handle.prepare(
        "INSERT OR REPLACE INTO dead_bodies (actor_name, pos_x, pos_y, pos_z, updated_at) VALUES (?, ?, ?, ?, datetime('now'))",
      ),

      // Containers
      clearContainers: this._handle.prepare('DELETE FROM containers'),
      insertContainer: this._handle.prepare(`
        INSERT OR REPLACE INTO containers (actor_name, items, quick_slots, locked, does_spawn_loot, alarm_off, crafting_content, pos_x, pos_y, pos_z, extra, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `),
      getAllContainers: this._handle.prepare('SELECT * FROM containers ORDER BY actor_name'),
      getContainersWithItems: this._handle.prepare("SELECT * FROM containers WHERE items != '[]' ORDER BY actor_name"),

      // Loot actors
      clearLootActors: this._handle.prepare('DELETE FROM loot_actors'),
      insertLootActor: this._handle.prepare(
        "INSERT INTO loot_actors (name, type, pos_x, pos_y, pos_z, items, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))",
      ),

      // World drops
      clearWorldDrops: this._handle.prepare('DELETE FROM world_drops'),
      insertWorldDrop: this._handle.prepare(`
        INSERT INTO world_drops (type, actor_name, item, amount, durability, items, world_loot, placed, spawned, locked, does_spawn_loot, pos_x, pos_y, pos_z)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      getAllWorldDrops: this._handle.prepare('SELECT * FROM world_drops ORDER BY type, item'),
      getWorldDropsByType: this._handle.prepare('SELECT * FROM world_drops WHERE type = ? ORDER BY item'),
      getWorldDropsWithItems: this._handle.prepare(
        "SELECT * FROM world_drops WHERE (item != '' OR items != '[]') ORDER BY type",
      ),
    };
  }

  // ── Structures ──────────────────────────────────────────────────────────────

  replaceStructures(structures: Array<Record<string, unknown>>): void {
    this._handle.transaction(() => {
      this.innerReplaceStructures(structures);
    })();
  }

  innerReplaceStructures(structures: Array<Record<string, unknown>>): void {
    this._stmts.clearStructures.run();
    for (const s of structures) {
      this._stmts.insertStructure.run(
        s.actorClass,
        s.displayName || '',
        s.ownerSteamId || '',
        s.x ?? null,
        s.y ?? null,
        s.z ?? null,
        s.currentHealth || 0,
        s.maxHealth || 0,
        s.upgradeLevel || 0,
        s.attachedToTrailer ? 1 : 0,
        _json(s.inventory),
        s.noSpawn ? 1 : 0,
        s.extraData || '',
      );
    }
  }

  getStructures() {
    return this._stmts.getStructures.all();
  }

  getStructuresByOwner(steamId: string) {
    return this._stmts.getStructuresByOwner.all(steamId);
  }

  getStructureCounts() {
    return this._stmts.countStructuresByOwner.all();
  }

  // ── Vehicles ─────────────────────────────────────────────────────────────────

  replaceVehicles(vehicles: Array<Record<string, unknown>>): void {
    this._handle.transaction(() => {
      this.innerReplaceVehicles(vehicles);
    })();
  }

  innerReplaceVehicles(vehicles: Array<Record<string, unknown>>): void {
    this._stmts.clearVehicles.run();
    for (const v of vehicles) {
      this._stmts.insertVehicle.run(
        v.class,
        v.displayName || '',
        v.x ?? null,
        v.y ?? null,
        v.z ?? null,
        v.health || 0,
        v.maxHealth || 0,
        v.fuel || 0,
        _json(v.inventory),
        _json(v.upgrades),
        _json(v.extra),
      );
    }
  }

  getAllVehicles() {
    return this._stmts.getAllVehicles.all();
  }

  // ── Companions ───────────────────────────────────────────────────────────────

  replaceCompanions(companions: Array<Record<string, unknown>>): void {
    this._handle.transaction(() => {
      this.innerReplaceCompanions(companions);
    })();
  }

  innerReplaceCompanions(companions: Array<Record<string, unknown>>): void {
    this._stmts.clearCompanions.run();
    for (const c of companions) {
      this._stmts.insertCompanion.run(
        c.type,
        c.actorName,
        c.ownerSteamId || '',
        c.x ?? null,
        c.y ?? null,
        c.z ?? null,
        c.health || 0,
        _json(c.extra),
      );
    }
  }

  getAllCompanions() {
    return this._stmts.getAllCompanions.all();
  }

  // ── World horses ─────────────────────────────────────────────────────────────

  replaceWorldHorses(horses: Array<Record<string, unknown>>): void {
    this._handle.transaction(() => {
      this.innerReplaceWorldHorses(horses);
    })();
  }

  innerReplaceWorldHorses(horses: Array<Record<string, unknown>>): void {
    this._stmts.clearWorldHorses.run();
    for (const h of horses) {
      this._stmts.insertWorldHorse.run(
        h.actorName || h.class || '',
        h.class || '',
        h.displayName || '',
        h.name || '',
        h.ownerSteamId || '',
        h.x ?? null,
        h.y ?? null,
        h.z ?? null,
        h.health || 0,
        h.maxHealth || 0,
        h.energy || 0,
        h.stamina || 0,
        _json(h.saddleInventory),
        _json(h.inventory),
        _json(h.extra),
      );
    }
  }

  getAllWorldHorses() {
    return this._stmts.getAllWorldHorses.all();
  }

  // ── Dead bodies ───────────────────────────────────────────────────────────────

  replaceDeadBodies(bodies: Array<Record<string, unknown>>): void {
    this._handle.transaction(() => {
      this.innerReplaceDeadBodies(bodies);
    })();
  }

  innerReplaceDeadBodies(bodies: Array<Record<string, unknown>>): void {
    this._stmts.clearDeadBodies.run();
    for (const b of bodies) {
      this._stmts.insertDeadBody.run(b.actorName, b.x ?? null, b.y ?? null, b.z ?? null);
    }
  }

  // ── Containers ────────────────────────────────────────────────────────────────

  replaceContainers(containers: Array<Record<string, unknown>>): void {
    this._handle.transaction(() => {
      this.innerReplaceContainers(containers);
    })();
  }

  innerReplaceContainers(containers: Array<Record<string, unknown>>): void {
    this._stmts.clearContainers.run();
    for (const c of containers) {
      const extra: Record<string, unknown> = {};
      if (c.hackCoolDown != null) extra['hackCoolDown'] = c.hackCoolDown;
      if (c.destroyTime != null) extra['destroyTime'] = c.destroyTime;
      if (c.extraFloats) extra['extraFloats'] = c.extraFloats;
      if (c.extraBools) extra['extraBools'] = c.extraBools;
      this._stmts.insertContainer.run(
        c.actorName,
        JSON.stringify(c.items || []),
        JSON.stringify(c.quickSlots || []),
        c.locked ? 1 : 0,
        c.doesSpawnLoot ? 1 : 0,
        c.alarmOff ? 1 : 0,
        JSON.stringify(c.craftingContent || []),
        c.x ?? null,
        c.y ?? null,
        c.z ?? null,
        JSON.stringify(extra),
      );
    }
  }

  getAllContainers() {
    return this._stmts.getAllContainers.all();
  }

  getContainersWithItems() {
    return this._stmts.getContainersWithItems.all();
  }

  // ── Loot actors ───────────────────────────────────────────────────────────────

  replaceLootActors(lootActors: Array<Record<string, unknown>>): void {
    this._handle.transaction(() => {
      this.innerReplaceLootActors(lootActors);
    })();
  }

  innerReplaceLootActors(lootActors: Array<Record<string, unknown>>): void {
    this._stmts.clearLootActors.run();
    for (const la of lootActors) {
      this._stmts.insertLootActor.run(
        la.name,
        la.type,
        la.x ?? null,
        la.y ?? null,
        la.z ?? null,
        JSON.stringify(la.items),
      );
    }
  }

  // ── World drops ───────────────────────────────────────────────────────────────

  replaceWorldDrops(drops: Array<Record<string, unknown>>): void {
    this._handle.transaction(() => {
      this.innerReplaceWorldDrops(drops);
    })();
  }

  innerReplaceWorldDrops(drops: Array<Record<string, unknown>>): void {
    this._stmts.clearWorldDrops.run();
    for (const d of drops) {
      this._stmts.insertWorldDrop.run(
        d.type,
        d.actorName || '',
        d.item || '',
        d.amount || 0,
        d.durability || 0,
        _json(d.items),
        d.worldLoot ? 1 : 0,
        d.placed ? 1 : 0,
        d.spawned ? 1 : 0,
        d.locked ? 1 : 0,
        d.doesSpawnLoot ? 1 : 0,
        d.x ?? null,
        d.y ?? null,
        d.z ?? null,
      );
    }
  }

  getAllWorldDrops() {
    return this._stmts.getAllWorldDrops.all();
  }

  getWorldDropsByType(type: string) {
    return this._stmts.getWorldDropsByType.all(type);
  }

  getWorldDropsWithItems() {
    return this._stmts.getWorldDropsWithItems.all();
  }
}

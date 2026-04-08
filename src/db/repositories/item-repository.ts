import type Database from 'better-sqlite3';
import { BaseRepository } from './base-repository.js';
import { type DbRow, _json } from './db-utils.js';

export class ItemRepository extends BaseRepository {
  declare private _stmts: {
    // Item instances
    insertItemInstance: Database.Statement;
    updateItemInstanceLocation: Database.Statement;
    markItemInstanceLost: Database.Statement;
    markAllItemInstancesLost: Database.Statement;
    touchItemInstance: Database.Statement;
    findItemInstanceByFingerprint: Database.Statement;
    findItemInstancesByFingerprint: Database.Statement;
    findItemInstanceById: Database.Statement;
    getActiveItemInstances: Database.Statement;
    getItemInstancesByItem: Database.Statement;
    getItemInstancesByLocation: Database.Statement;
    getItemInstanceCount: Database.Statement;
    searchItemInstances: Database.Statement;
    purgeOldLostItems: Database.Statement;
    getItemInstancesByGroup: Database.Statement;
    // Item groups
    insertItemGroup: Database.Statement;
    updateItemGroupQuantity: Database.Statement;
    updateItemGroupLocation: Database.Statement;
    markItemGroupLost: Database.Statement;
    markAllItemGroupsLost: Database.Statement;
    touchItemGroup: Database.Statement;
    findActiveGroupByLocation: Database.Statement;
    findActiveGroupsByFingerprint: Database.Statement;
    findItemGroupById: Database.Statement;
    getActiveItemGroups: Database.Statement;
    getItemGroupsByItem: Database.Statement;
    getItemGroupsByLocation: Database.Statement;
    getItemGroupCount: Database.Statement;
    searchItemGroups: Database.Statement;
    purgeOldLostGroups: Database.Statement;
    // Item movements
    insertItemMovement: Database.Statement;
    getItemMovements: Database.Statement;
    getItemMovementsByGroup: Database.Statement;
    getRecentItemMovements: Database.Statement;
    getItemMovementsByPlayer: Database.Statement;
    getItemMovementsByLocation: Database.Statement;
    purgeOldMovements: Database.Statement;
  };

  protected _prepareStatements(): void {
    this._stmts = {
      // Item instances (fingerprint tracking)
      insertItemInstance: this._handle.prepare(`
      INSERT INTO item_instances (fingerprint, item, durability, ammo, attachments, cap, max_dur, location_type, location_id, location_slot, pos_x, pos_y, pos_z, amount, group_id, first_seen, last_seen, lost)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), 0)
    `),
      updateItemInstanceLocation: this._handle.prepare(`
      UPDATE item_instances SET location_type = ?, location_id = ?, location_slot = ?, pos_x = ?, pos_y = ?, pos_z = ?, amount = ?, group_id = ?, last_seen = datetime('now'), lost = 0, lost_at = NULL WHERE id = ?
    `),
      markItemInstanceLost: this._handle.prepare(`
      UPDATE item_instances SET lost = 1, lost_at = datetime('now') WHERE id = ?
    `),
      markAllItemInstancesLost: this._handle.prepare(`
      UPDATE item_instances SET lost = 1, lost_at = datetime('now') WHERE lost = 0
    `),
      touchItemInstance: this._handle.prepare(`
      UPDATE item_instances SET last_seen = datetime('now'), lost = 0 WHERE id = ?
    `),
      findItemInstanceByFingerprint: this._handle.prepare(
        'SELECT * FROM item_instances WHERE fingerprint = ? AND lost = 0 LIMIT 1',
      ),
      findItemInstancesByFingerprint: this._handle.prepare(
        'SELECT * FROM item_instances WHERE fingerprint = ? AND lost = 0',
      ),
      findItemInstanceById: this._handle.prepare('SELECT * FROM item_instances WHERE id = ?'),
      getActiveItemInstances: this._handle.prepare(
        'SELECT * FROM item_instances WHERE lost = 0 ORDER BY item, location_type',
      ),
      getItemInstancesByItem: this._handle.prepare(
        'SELECT * FROM item_instances WHERE item = ? AND lost = 0 ORDER BY location_type',
      ),
      getItemInstancesByLocation: this._handle.prepare(
        'SELECT * FROM item_instances WHERE location_type = ? AND location_id = ? AND lost = 0',
      ),
      getItemInstanceCount: this._handle.prepare('SELECT COUNT(*) as count FROM item_instances WHERE lost = 0'),
      searchItemInstances: this._handle.prepare(
        'SELECT * FROM item_instances WHERE (item LIKE ? OR fingerprint LIKE ?) AND lost = 0 ORDER BY item LIMIT ?',
      ),
      purgeOldLostItems: this._handle.prepare(
        "DELETE FROM item_instances WHERE lost = 1 AND lost_at < datetime('now', ?)",
      ),
      getItemInstancesByGroup: this._handle.prepare('SELECT * FROM item_instances WHERE group_id = ? AND lost = 0'),

      // Item groups (fungible item tracking)
      insertItemGroup: this._handle.prepare(`
      INSERT INTO item_groups (fingerprint, item, durability, ammo, attachments, cap, max_dur, location_type, location_id, location_slot, pos_x, pos_y, pos_z, quantity, stack_size, first_seen, last_seen, lost)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), 0)
    `),
      updateItemGroupQuantity: this._handle.prepare(`
      UPDATE item_groups SET quantity = ?, last_seen = datetime('now'), lost = 0, lost_at = NULL WHERE id = ?
    `),
      updateItemGroupLocation: this._handle.prepare(`
      UPDATE item_groups SET location_type = ?, location_id = ?, location_slot = ?, pos_x = ?, pos_y = ?, pos_z = ?, quantity = ?, last_seen = datetime('now'), lost = 0, lost_at = NULL WHERE id = ?
    `),
      markItemGroupLost: this._handle.prepare(`
      UPDATE item_groups SET lost = 1, lost_at = datetime('now') WHERE id = ?
    `),
      markAllItemGroupsLost: this._handle.prepare(`
      UPDATE item_groups SET lost = 1, lost_at = datetime('now') WHERE lost = 0
    `),
      touchItemGroup: this._handle.prepare(`
      UPDATE item_groups SET last_seen = datetime('now'), lost = 0 WHERE id = ?
    `),
      findActiveGroupByLocation: this._handle.prepare(
        'SELECT * FROM item_groups WHERE fingerprint = ? AND location_type = ? AND location_id = ? AND location_slot = ? AND lost = 0 LIMIT 1',
      ),
      findActiveGroupsByFingerprint: this._handle.prepare(
        'SELECT * FROM item_groups WHERE fingerprint = ? AND lost = 0',
      ),
      findItemGroupById: this._handle.prepare('SELECT * FROM item_groups WHERE id = ?'),
      getActiveItemGroups: this._handle.prepare(
        'SELECT * FROM item_groups WHERE lost = 0 ORDER BY item, location_type',
      ),
      getItemGroupsByItem: this._handle.prepare(
        'SELECT * FROM item_groups WHERE item = ? AND lost = 0 ORDER BY location_type',
      ),
      getItemGroupsByLocation: this._handle.prepare(
        'SELECT * FROM item_groups WHERE location_type = ? AND location_id = ? AND lost = 0',
      ),
      getItemGroupCount: this._handle.prepare('SELECT COUNT(*) as count FROM item_groups WHERE lost = 0'),
      searchItemGroups: this._handle.prepare(
        'SELECT * FROM item_groups WHERE (item LIKE ? OR fingerprint LIKE ?) AND lost = 0 ORDER BY item LIMIT ?',
      ),
      purgeOldLostGroups: this._handle.prepare(
        "DELETE FROM item_groups WHERE lost = 1 AND lost_at < datetime('now', ?)",
      ),

      // Item movements (chain-of-custody)
      insertItemMovement: this._handle.prepare(`
      INSERT INTO item_movements (instance_id, group_id, move_type, item, from_type, from_id, from_slot, to_type, to_id, to_slot, amount, attributed_steam_id, attributed_name, pos_x, pos_y, pos_z)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
      getItemMovements: this._handle.prepare(
        'SELECT * FROM item_movements WHERE instance_id = ? ORDER BY created_at ASC',
      ),
      getItemMovementsByGroup: this._handle.prepare(
        'SELECT * FROM item_movements WHERE group_id = ? ORDER BY created_at ASC',
      ),
      getRecentItemMovements: this._handle.prepare('SELECT * FROM item_movements ORDER BY created_at DESC LIMIT ?'),
      getItemMovementsByPlayer: this._handle.prepare(
        'SELECT * FROM item_movements WHERE attributed_steam_id = ? ORDER BY created_at DESC LIMIT ?',
      ),
      getItemMovementsByLocation: this._handle.prepare(
        'SELECT * FROM item_movements WHERE (from_type = ? AND from_id = ?) OR (to_type = ? AND to_id = ?) ORDER BY created_at DESC LIMIT ?',
      ),
      purgeOldMovements: this._handle.prepare("DELETE FROM item_movements WHERE created_at < datetime('now', ?)"),
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Item instances (fingerprint tracking)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Create a new item instance and return its row id.
   * @param {object} item - { fingerprint, item, durability, ammo, attachments, cap, maxDur, locationType, locationId, locationSlot, x, y, z, amount, groupId }
   * @returns {number} The auto-incremented ID of the new instance
   */
  createItemInstance(item: Record<string, unknown>) {
    const result = this._stmts.insertItemInstance.run(
      item.fingerprint,
      item.item,
      item.durability || 0,
      item.ammo || 0,
      _json(item.attachments),
      item.cap || 0,
      item.maxDur || 0,
      item.locationType,
      item.locationId || '',
      item.locationSlot || '',
      item.x ?? null,
      item.y ?? null,
      item.z ?? null,
      item.amount || 1,
      item.groupId ?? null,
    );
    return result.lastInsertRowid;
  }

  /**
   * Move an item instance to a new location and record the movement.
   * @param {number} instanceId - item_instances.id
   * @param {object} to - { locationType, locationId, locationSlot, x, y, z, amount, groupId }
   * @param {object} [attribution] - { steamId, name } of the player who caused the move
   * @param {string} [moveType='move'] - movement type
   */
  moveItemInstance(
    instanceId: number,
    to: Record<string, unknown>,
    attribution: Record<string, unknown> | null,
    moveType: string = 'move',
  ) {
    const old = this._stmts.findItemInstanceById.get(instanceId) as DbRow | undefined;
    if (!old) return;

    // Update location
    this._stmts.updateItemInstanceLocation.run(
      to.locationType,
      to.locationId || '',
      to.locationSlot || '',
      to.x ?? null,
      to.y ?? null,
      to.z ?? null,
      to.amount ?? old.amount,
      to.groupId ?? null,
      instanceId,
    );

    // Record movement
    this._stmts.insertItemMovement.run(
      instanceId,
      null,
      moveType,
      old.item,
      old.location_type,
      old.location_id,
      old.location_slot,
      to.locationType,
      to.locationId || '',
      to.locationSlot || '',
      to.amount ?? old.amount,
      attribution?.steamId || '',
      attribution?.name || '',
      to.x ?? null,
      to.y ?? null,
      to.z ?? null,
    );
  }

  /**
   * Mark an item instance as lost (no longer found in save data).
   */
  markItemLost(instanceId: number) {
    this._stmts.markItemInstanceLost.run(instanceId);
  }

  /**
   * Mark all active instances as lost (used before reconciliation).
   */
  markAllItemsLost() {
    this._stmts.markAllItemInstancesLost.run();
  }

  /**
   * Touch an instance (update last_seen, clear lost flag).
   */
  touchItemInstance(instanceId: number) {
    this._stmts.touchItemInstance.run(instanceId);
  }

  findItemByFingerprint(fingerprint: string) {
    return this._stmts.findItemInstanceByFingerprint.get(fingerprint);
  }

  findItemsByFingerprint(fingerprint: string) {
    return this._stmts.findItemInstancesByFingerprint.all(fingerprint);
  }

  getItemInstance(id: number) {
    return this._stmts.findItemInstanceById.get(id);
  }

  getActiveItemInstances() {
    return this._stmts.getActiveItemInstances.all();
  }

  getItemInstancesByItem(item: string) {
    return this._stmts.getItemInstancesByItem.all(item);
  }

  getItemInstancesByLocation(locationType: string, locationId: string) {
    return this._stmts.getItemInstancesByLocation.all(locationType, locationId);
  }

  getItemInstanceCount() {
    const row = this._stmts.getItemInstanceCount.get() as DbRow | undefined;
    return row?.count ?? 0;
  }

  searchItemInstances(query: string, limit = 50) {
    const like = `%${query}%`;
    return this._stmts.searchItemInstances.all(like, like, limit);
  }

  purgeOldLostItems(age = '-30 days') {
    return this._stmts.purgeOldLostItems.run(age);
  }

  getItemInstancesByGroup(groupId: number) {
    return this._stmts.getItemInstancesByGroup.all(groupId);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Item groups (fungible item tracking)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Create or update an item group at a specific location.
   * If a group with the same fingerprint+location already exists (active), update its quantity.
   * Otherwise create a new group.
   * @returns {{ id: number, created: boolean }}
   */
  upsertItemGroup(group: Record<string, unknown>) {
    const existing = this._stmts.findActiveGroupByLocation.get(
      group.fingerprint,
      group.locationType,
      group.locationId || '',
      group.locationSlot || '',
    ) as DbRow | undefined;
    if (existing) {
      this._stmts.updateItemGroupQuantity.run(group.quantity, existing.id);
      return { id: existing.id as number, created: false };
    }
    const result = this._stmts.insertItemGroup.run(
      group.fingerprint,
      group.item,
      group.durability || 0,
      group.ammo || 0,
      _json(group.attachments),
      group.cap || 0,
      group.maxDur || 0,
      group.locationType,
      group.locationId || '',
      group.locationSlot || '',
      group.x ?? null,
      group.y ?? null,
      group.z ?? null,
      group.quantity || 1,
      group.stackSize || 1,
    );
    return { id: Number(result.lastInsertRowid), created: true };
  }

  updateItemGroupQuantity(groupId: number, quantity: number) {
    this._stmts.updateItemGroupQuantity.run(quantity, groupId);
  }

  updateItemGroupLocation(groupId: number, to: Record<string, unknown>) {
    this._stmts.updateItemGroupLocation.run(
      to.locationType,
      to.locationId || '',
      to.locationSlot || '',
      to.x ?? null,
      to.y ?? null,
      to.z ?? null,
      to.quantity ?? 1,
      groupId,
    );
  }

  markItemGroupLost(groupId: number) {
    this._stmts.markItemGroupLost.run(groupId);
  }

  markAllItemGroupsLost() {
    this._stmts.markAllItemGroupsLost.run();
  }

  touchItemGroup(groupId: number) {
    this._stmts.touchItemGroup.run(groupId);
  }

  findActiveGroupByLocation(fingerprint: string, locationType: string, locationId: string, locationSlot: string) {
    return this._stmts.findActiveGroupByLocation.get(fingerprint, locationType, locationId || '', locationSlot || '');
  }

  findActiveGroupsByFingerprint(fingerprint: string) {
    return this._stmts.findActiveGroupsByFingerprint.all(fingerprint);
  }

  getItemGroup(id: number) {
    return this._stmts.findItemGroupById.get(id);
  }

  getActiveItemGroups() {
    return this._stmts.getActiveItemGroups.all();
  }

  getItemGroupsByItem(item: Record<string, unknown>) {
    return this._stmts.getItemGroupsByItem.all(item);
  }

  getItemGroupsByLocation(locationType: string, locationId: string) {
    return this._stmts.getItemGroupsByLocation.all(locationType, locationId);
  }

  getItemGroupCount() {
    const row = this._stmts.getItemGroupCount.get() as DbRow | undefined;
    return row?.count ?? 0;
  }

  searchItemGroups(query: string, limit = 50) {
    const like = `%${query}%`;
    return this._stmts.searchItemGroups.all(like, like, limit);
  }

  purgeOldLostGroups(age = '-30 days') {
    return this._stmts.purgeOldLostGroups.run(age);
  }

  /**
   * Record a group-level movement (split, merge, transfer, adjust).
   * @param {object} opts
   * @param {number} [opts.instanceId] - individual instance (for splits)
   * @param {number} [opts.groupId] - group id
   * @param {string} opts.moveType - 'group_split', 'group_merge', 'group_transfer', 'group_adjust'
   * @param {string} opts.item - item name
   * @param {object} opts.from - { type, id, slot }
   * @param {object} opts.to - { type, id, slot }
   * @param {number} opts.amount - how many items moved
   * @param {object} [opts.attribution] - { steamId, name }
   * @param {{ x?: number, y?: number, z?: number }} [opts.pos] - position
   */
  recordGroupMovement(opts: Record<string, unknown>): void {
    const from = (opts.from ?? {}) as Record<string, unknown>;
    const to = (opts.to ?? {}) as Record<string, unknown>;
    const attribution = (opts.attribution ?? {}) as Record<string, unknown>;
    const pos = (opts.pos ?? {}) as Record<string, unknown>;
    this._stmts.insertItemMovement.run(
      opts.instanceId ?? null,
      opts.groupId ?? null,
      opts.moveType,
      opts.item,
      from.type || '',
      from.id || '',
      from.slot || '',
      to.type || '',
      to.id || '',
      to.slot || '',
      opts.amount || 1,
      attribution.steamId || '',
      attribution.name || '',
      pos.x ?? null,
      pos.y ?? null,
      pos.z ?? null,
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Item movements (chain-of-custody)
  // ═══════════════════════════════════════════════════════════════════════════

  getItemMovements(instanceId: number) {
    return this._stmts.getItemMovements.all(instanceId);
  }

  getItemMovementsByGroup(groupId: number) {
    return this._stmts.getItemMovementsByGroup.all(groupId);
  }

  getRecentItemMovements(limit = 50) {
    return this._stmts.getRecentItemMovements.all(limit);
  }

  getItemMovementsByPlayer(steamId: string, limit = 50) {
    return this._stmts.getItemMovementsByPlayer.all(steamId, limit);
  }

  getItemMovementsByLocation(locationType: string, locationId: string, limit = 50) {
    return this._stmts.getItemMovementsByLocation.all(locationType, locationId, locationType, locationId, limit);
  }

  purgeOldMovements(age = '-30 days') {
    return this._stmts.purgeOldMovements.run(age);
  }
}

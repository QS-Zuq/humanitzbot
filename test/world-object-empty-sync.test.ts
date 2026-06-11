import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import HumanitZDB from '../src/db/database.js';

describe('syncAllFromSave empty-payload semantics', () => {
  let db: HumanitZDB;

  beforeEach(() => {
    db = new HumanitZDB({ memory: true, label: 'EmptySyncTest' });
    db.init();
  });

  afterEach(() => {
    db.close();
  });

  function seedPayload(): Record<string, unknown> {
    return {
      players: new Map(),
      containers: [{ actorName: 'crate_1', items: [{ item: 'Nails', amount: 3 }], x: 1, y: 2, z: 3 }],
      deadBodies: [{ actorName: 'body_1', x: 4, y: 5, z: 6 }],
      worldDrops: [{ type: 'pickup', actorName: 'drop_1', item: 'Rope', amount: 1 }],
    };
  }

  it('clears previously populated tables when an empty array is provided', async () => {
    await db.syncAllFromSave(seedPayload());
    assert.equal(db.worldObject.getAllContainers().length, 1);
    assert.equal(db.worldObject.getAllWorldDrops().length, 1);

    await db.syncAllFromSave({ players: new Map(), containers: [], deadBodies: [], worldDrops: [] });
    assert.equal(db.worldObject.getAllContainers().length, 0);
    assert.equal(db.worldObject.getAllWorldDrops().length, 0);
  });

  it('leaves tables untouched when a field is undefined (not provided)', async () => {
    await db.syncAllFromSave(seedPayload());

    await db.syncAllFromSave({ players: new Map() });
    assert.equal(db.worldObject.getAllContainers().length, 1);
    assert.equal(db.worldObject.getAllWorldDrops().length, 1);
  });

  it('treats null as an explicit empty array and clears only that table', async () => {
    await db.syncAllFromSave(seedPayload());

    await db.syncAllFromSave({ players: new Map(), worldDrops: null });
    assert.equal(db.worldObject.getAllWorldDrops().length, 0);
    assert.equal(db.worldObject.getAllContainers().length, 1);
  });

  it('applies the same array/null/undefined semantics to the core entity tables', async () => {
    await db.syncAllFromSave({
      players: new Map(),
      vehicles: [{ class: 'BP_Sedan_C', displayName: 'Sedan', x: 1, y: 2, z: 3 }],
      companions: [{ type: 'dog', actorName: 'BP_Dog_C_1', x: 4, y: 5, z: 6 }],
    });
    assert.equal(db.worldObject.getAllVehicles().length, 1);
    assert.equal(db.worldObject.getAllCompanions().length, 1);

    // undefined → untouched
    await db.syncAllFromSave({ players: new Map() });
    assert.equal(db.worldObject.getAllVehicles().length, 1);
    assert.equal(db.worldObject.getAllCompanions().length, 1);

    // null → explicit empty, clears only the targeted table
    await db.syncAllFromSave({ players: new Map(), vehicles: null });
    assert.equal(db.worldObject.getAllVehicles().length, 0);
    assert.equal(db.worldObject.getAllCompanions().length, 1);

    // empty array → authoritative clear
    await db.syncAllFromSave({ players: new Map(), companions: [] });
    assert.equal(db.worldObject.getAllCompanions().length, 0);
  });
});

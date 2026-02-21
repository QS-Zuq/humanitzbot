/**
 * Tests for player-stats.js — damage classification and record management.
 * Run: npm test
 */
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// The module exports a singleton instance — we use it directly.
// We just need to test the pure methods without triggering file I/O.
const playerStats = require('../src/player-stats');

// ══════════════════════════════════════════════════════════
// _classifyDamageSource — pure regex classifier
// ══════════════════════════════════════════════════════════

describe('_classifyDamageSource', () => {
  // Zombie variants
  it('classifies Dog Zombie', () => {
    assert.equal(playerStats._classifyDamageSource('BP_Dogzombie_C_123'), 'Dog Zombie');
  });

  it('classifies Zombie Bear', () => {
    assert.equal(playerStats._classifyDamageSource('BP_ZombieBear_C'), 'Zombie Bear');
  });

  it('classifies Mutant', () => {
    assert.equal(playerStats._classifyDamageSource('BP_Mutant_C_456'), 'Mutant');
  });

  it('classifies Runner', () => {
    assert.equal(playerStats._classifyDamageSource('BP_Runner_C'), 'Runner');
  });

  it('classifies Brute', () => {
    assert.equal(playerStats._classifyDamageSource('BP_Brute_C_789'), 'Brute');
  });

  it('classifies Runner Brute', () => {
    assert.equal(playerStats._classifyDamageSource('BP_RunnerBrute_C'), 'Runner Brute');
    assert.equal(playerStats._classifyDamageSource('BP_Runner_Brute_C'), 'Runner Brute');
  });

  it('classifies Bloater (Pudge/BellyToxic)', () => {
    assert.equal(playerStats._classifyDamageSource('BP_Pudge_C'), 'Bloater');
    assert.equal(playerStats._classifyDamageSource('BP_BellyToxic_C'), 'Bloater');
  });

  it('classifies Armoured variants', () => {
    assert.equal(playerStats._classifyDamageSource('BP_Police_Zombie_C'), 'Armoured');
    assert.equal(playerStats._classifyDamageSource('BP_Cop_C'), 'Armoured');
    assert.equal(playerStats._classifyDamageSource('BP_MilitaryArmoured_C'), 'Armoured');
    assert.equal(playerStats._classifyDamageSource('BP_Camo_Zombie_C'), 'Armoured');
    assert.equal(playerStats._classifyDamageSource('BP_Hazmat_C'), 'Armoured');
  });

  it('classifies generic Zombie', () => {
    assert.equal(playerStats._classifyDamageSource('BP_Zombie_C'), 'Zombie');
    assert.equal(playerStats._classifyDamageSource('BP_Zombie_Male_C'), 'Zombie');
  });

  // Animals
  it('classifies Wolf', () => {
    assert.equal(playerStats._classifyDamageSource('BP_Wolf_C'), 'Wolf');
  });

  it('classifies Bear', () => {
    assert.equal(playerStats._classifyDamageSource('BP_Bear_C'), 'Bear');
  });

  it('classifies Deer', () => {
    assert.equal(playerStats._classifyDamageSource('BP_Deer_C'), 'Deer');
  });

  it('classifies Snake', () => {
    assert.equal(playerStats._classifyDamageSource('BP_Snake_C'), 'Snake');
  });

  it('classifies Spider', () => {
    assert.equal(playerStats._classifyDamageSource('BP_Spider_C'), 'Spider');
  });

  // NPCs
  it('classifies Bandit (KaiHuman)', () => {
    assert.equal(playerStats._classifyDamageSource('BP_KaiHuman_C'), 'Bandit');
  });

  it('classifies NPC (Human)', () => {
    assert.equal(playerStats._classifyDamageSource('BP_Human_C'), 'NPC');
  });

  // Player
  it('classifies player names (no BP_ prefix) as Player', () => {
    assert.equal(playerStats._classifyDamageSource('SomePlayerName'), 'Player');
    assert.equal(playerStats._classifyDamageSource('Some Player Name'), 'Player');
  });

  // Other
  it('classifies unknown BP_ sources as Other', () => {
    assert.equal(playerStats._classifyDamageSource('BP_UnknownThing_C'), 'Other');
  });

  // Priority check: ZombieBear before Bear
  it('ZombieBear matches Zombie Bear, not Bear', () => {
    assert.equal(playerStats._classifyDamageSource('BP_ZombieBear_C'), 'Zombie Bear');
  });

  // Priority check: DogZombie before Zombie
  it('Dogzombie matches Dog Zombie, not Zombie', () => {
    assert.equal(playerStats._classifyDamageSource('BP_Dogzombie_C'), 'Dog Zombie');
  });
});

// ══════════════════════════════════════════════════════════
// _newRecord — record template
// ══════════════════════════════════════════════════════════

describe('_newRecord', () => {
  it('creates a default record with all expected fields', () => {
    const r = playerStats._newRecord('TestPlayer');
    assert.equal(r.name, 'TestPlayer');
    assert.equal(r.deaths, 0);
    assert.equal(r.builds, 0);
    assert.equal(r.raidsOut, 0);
    assert.equal(r.raidsIn, 0);
    assert.equal(r.destroyedOut, 0);
    assert.equal(r.destroyedIn, 0);
    assert.equal(r.containersLooted, 0);
    assert.equal(r.pvpKills, 0);
    assert.equal(r.pvpDeaths, 0);
    assert.equal(r.connects, 0);
    assert.equal(r.disconnects, 0);
    assert.equal(r.adminAccess, 0);
    assert.deepEqual(r.damageTaken, {});
    assert.deepEqual(r.buildItems, {});
    assert.deepEqual(r.nameHistory, []);
    assert.deepEqual(r.cheatFlags, []);
    assert.equal(r.lastEvent, null);
  });
});

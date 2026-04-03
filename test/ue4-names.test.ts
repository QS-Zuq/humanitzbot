/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-floating-promises */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import * as _ue4_names from '../src/parsers/ue4-names.js';
const { cleanName, cleanItemName, cleanItemArray, isHexGuid } = _ue4_names as any;

describe('cleanName', () => {
  it('handles Door_GEN_VARIABLE_BP_ pattern', () => {
    assert.equal(cleanName('Door_GEN_VARIABLE_BP_LockedMetalShutter_C_CAT_2147206852'), 'Locked Metal Shutter');
  });

  it('handles ChildActor_GEN_VARIABLE_BP_ pattern', () => {
    assert.equal(cleanName('ChildActor_GEN_VARIABLE_BP_VehicleStorage_C_CAT_2147253396'), 'Vehicle Storage');
  });

  it('handles Storage_GEN_VARIABLE_BP_ pattern', () => {
    assert.equal(cleanName('Storage_GEN_VARIABLE_BP_WoodCrate_C_2147261242'), 'Wood Crate');
  });

  it('handles BuildContainer_NNN', () => {
    assert.equal(cleanName('BuildContainer_147'), 'Container');
    assert.equal(cleanName('BuildContainer'), 'Container');
  });

  it('handles simple BP_ prefix', () => {
    assert.equal(cleanName('BP_WoodWall_C_12345'), 'Wood Wall');
  });

  it('handles BP_ prefix with _C suffix', () => {
    assert.equal(cleanName('BP_SandbagWall_C'), 'Sandbag Wall');
  });

  it('handles CupboardContainer', () => {
    assert.equal(cleanName('ChildActor_GEN_VARIABLE_BP_CupboardContainer_C_CAT_12345'), 'Cupboard');
  });

  it('handles VehicleStorage in actor name', () => {
    assert.equal(cleanName('Storage_GEN_VARIABLE_BP_VehicleStorage_C_2147261242'), 'Vehicle Storage');
  });

  it('handles Fridge', () => {
    assert.equal(cleanName('ChildActor_GEN_VARIABLE_BP_Fridge_C_CAT_999'), 'Fridge');
  });

  it('handles already clean names', () => {
    assert.equal(cleanName('Wood Wall'), 'Wood Wall');
    assert.equal(cleanName('Barrel'), 'Barrel');
  });

  it('handles CamelCase without underscores', () => {
    assert.equal(cleanName('LockedMetalShutter'), 'Locked Metal Shutter');
  });

  it('handles null/undefined/empty', () => {
    assert.equal(cleanName(null), 'Unknown');
    assert.equal(cleanName(undefined), 'Unknown');
    assert.equal(cleanName(''), 'Unknown');
  });

  it('handles full blueprint path', () => {
    assert.equal(cleanName('/Game/BuildingSystem/Blueprints/Buildings/BP_WoodWall.BP_WoodWall_C'), 'Wood Wall');
  });

  it('handles Window_GEN_VARIABLE_BP_ pattern', () => {
    assert.equal(cleanName('Window_GEN_VARIABLE_BP_GlassWindow_C_CAT_999'), 'Glass Window');
  });

  it('handles Lamp_GEN_VARIABLE_BP_ pattern', () => {
    assert.equal(cleanName('Lamp_GEN_VARIABLE_BP_FloorLamp_C_CAT_123'), 'Floor Lamp');
  });

  it('handles StorageContainer', () => {
    assert.equal(cleanName('ChildActor_GEN_VARIABLE_BP_StorageContainer_C_2147000000'), 'Storage Container');
  });

  it('strips trailing numeric IDs', () => {
    assert.equal(cleanName('BP_Item_Name_42'), 'Item Name');
  });

  it('handles ContainerEnemyAI (zombie loot drop)', () => {
    assert.equal(cleanName('BP_ContainerEnemyAI_C_2147478519'), 'Zombie Drop');
  });

  it('handles ContainerEnemyAI_Pistol (zombie pistol drop)', () => {
    assert.equal(cleanName('BP_ContainerEnemyAI_Pistol_C_2147478598'), 'Zombie Drop (Pistol)');
  });

  it('handles WeaponStash', () => {
    assert.equal(cleanName('BP_WeaponStash_C_2147000000'), 'Weapon Stash');
  });
});

describe('cleanItemName', () => {
  it('handles BP_ prefix items', () => {
    assert.equal(cleanItemName('BP_WoodPlank_C'), 'Wood Plank');
  });

  it('handles CamelCase items', () => {
    // ITEM_NAMES provides authoritative game name
    assert.equal(cleanItemName('WaterPurifyPills'), 'Purification Tablets');
  });

  it('handles full paths', () => {
    // ITEM_NAMES: Bandage → Rag (actual game name)
    assert.equal(cleanItemName('/Game/Items/BP_Bandage.BP_Bandage_C'), 'Rag');
  });

  it('handles null/undefined', () => {
    assert.equal(cleanItemName(null), 'Unknown');
    assert.equal(cleanItemName(undefined), 'Unknown');
  });

  it('handles simple names', () => {
    assert.equal(cleanItemName('Nails'), 'Nails');
  });

  // ── Screenshot-visible problems fixed ──

  it('cleans concatenated item names from screenshot', () => {
    assert.equal(cleanItemName('tacticalmachette'), 'Tactical Machete');
    assert.equal(cleanItemName('22ammo'), '.22 Ammo');
    assert.equal(cleanItemName('improaxe'), 'Improvised Axe');
    assert.equal(cleanItemName('improarrow'), 'Improvised Arrow');
    assert.equal(cleanItemName('drillkit'), 'Drill Kit');
    assert.equal(cleanItemName('lockpick'), 'Lock Pick');
    assert.equal(cleanItemName('binos'), 'Binoculars');
  });

  it('cleans attachment names', () => {
    // ITEM_NAMES provides authoritative game names for attachments
    assert.equal(cleanItemName('Att_Mag_Extended'), 'Pistol Extended Mag');
    assert.equal(cleanItemName('Att_Mag_Extended_Uzi'), 'Uzi Extended Mag');
  });

  it('strips trailing digit duplicates', () => {
    assert.equal(cleanItemName('Energy Drink2'), 'Energy Drink');
  });

  it('cleans impro compound names', () => {
    assert.equal(cleanItemName('Impro Backpack'), 'Improvised Backpack');
  });

  it('preserves already clean names', () => {
    assert.equal(cleanItemName('Revolver'), 'Revolver');
    assert.equal(cleanItemName('Bandage'), 'Rag'); // ITEM_NAMES: Bandage → Rag
    assert.equal(cleanItemName('Water'), 'Water Bottle'); // ITEM_NAMES: Water → Water Bottle
    assert.equal(cleanItemName('Fiber'), 'Fibers'); // ITEM_NAMES: Fiber → Fibers
    assert.equal(cleanItemName('Rope'), 'Rope');
  });

  // ── Lv → Lvl expansion ──

  it('expands Lv abbreviation', () => {
    assert.equal(cleanItemName('SwordLv3'), 'Sword Lvl 3');
    assert.equal(cleanItemName('ShieldLv2'), 'Shield Lvl 2');
    assert.equal(cleanItemName('ArmorLv1'), 'Armor Lvl 1');
  });

  // ── ABCDef → ABC Def (consecutive uppercase splitting) ──

  it('splits consecutive uppercase before lowercase', () => {
    // e.g. "USBDrive" → "USB Drive"
    assert.equal(cleanItemName('USBDrive'), 'USB Drive');
    assert.equal(cleanItemName('RPGLauncher'), 'RPG Launcher');
    assert.equal(cleanItemName('LEDFlashlight'), 'LED Flashlight');
  });

  // ── Trailing digit precision ──

  it('strips trailing digit glued to word but preserves spaced numbers', () => {
    // Glued: "Bandage2" → strip → "Bandage"
    assert.equal(cleanItemName('Bandage2'), 'Bandage');
    // Spaced (after Lv expansion): "SwordLv3" → "Sword Lvl 3" (number preserved)
    assert.equal(cleanItemName('SwordLv3'), 'Sword Lvl 3');
  });

  // ── Status effect patterns (used in player-stats-channel) ──

  it('cleans status effect names after prefix strip', () => {
    // These come in as the result of stripping "States.Player." prefix
    assert.equal(cleanItemName('IsExhausted'), 'Is Exhausted');
    assert.equal(cleanItemName('IsBleeding'), 'Is Bleeding');
    assert.equal(cleanItemName('HasFever'), 'Has Fever');
    assert.equal(cleanItemName('BrokenLeg'), 'Broken Leg');
  });
});

describe('isHexGuid', () => {
  it('detects hex GUIDs', () => {
    assert.ok(isHexGuid('92b0cc283720f24098060a59425d8394'));
    assert.ok(isHexGuid('58e2e591d493ba458b68a4c2b2404e9e'));
    assert.ok(isHexGuid('bc2c3bd26b0d254b88ac618295eca7b2'));
  });

  it('rejects non-GUIDs', () => {
    assert.ok(!isHexGuid('Bandage'));
    assert.ok(!isHexGuid('Stone Knife'));
    assert.ok(!isHexGuid('22ammo'));
    assert.ok(!isHexGuid(''));
    assert.ok(!isHexGuid(null));
  });
});

describe('cleanItemArray', () => {
  it('filters out hex GUIDs and cleans names', () => {
    const input = [
      '92b0cc283720f24098060a59425d8394',
      'Bandage',
      'Water',
      '58e2e591d493ba458b68a4c2b2404e9e',
      'Stone Knife',
      'improaxe',
    ];
    const result = cleanItemArray(input);
    assert.deepEqual(result, [
      'Rag', // ITEM_NAMES: Bandage → Rag
      'Water Bottle', // ITEM_NAMES: Water → Water Bottle
      'Stone Knife',
      'Improvised Axe',
    ]);
  });

  it('handles object items with GUIDs', () => {
    const input = [
      { item: '92b0cc283720f24098060a59425d8394', amount: 1 },
      { item: 'Bandage', amount: 3, durability: 100 },
    ];
    const result = cleanItemArray(input);
    assert.equal(result.length, 1);
    assert.equal(result[0].item, 'Rag'); // ITEM_NAMES: Bandage → Rag
    assert.equal(result[0].amount, 3);
  });
});

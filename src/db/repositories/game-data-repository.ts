import type Database from 'better-sqlite3';
import { BaseRepository } from './base-repository.js';
import { _json } from './db-utils.js';

export class GameDataRepository extends BaseRepository {
  declare private _stmts: {
    upsertGameItem: Database.Statement;
    getGameItem: Database.Statement;
    searchGameItems: Database.Statement;
  };

  protected _prepareStatements(): void {
    this._stmts = {
      upsertGameItem: this._handle.prepare(`INSERT OR REPLACE INTO game_items (
        id, name, description, type, type_raw, specific_type, wear_position, category,
        chance_to_spawn, durability_loss, armor_protection, max_stack_size, can_stack,
        item_size, weight, first_value, second_item_type, second_value,
        value_to_trader, value_for_player,
        does_decay, decay_per_day, only_decay_if_opened,
        warmth_value, infection_protection, clothing_rain_mod, clothing_snow_mod, summer_cool_value,
        is_skill_book, no_pocket, exclude_from_vendor, exclude_from_ai, use_as_fertilizer,
        state, tag, open_item, body_attach_socket,
        supported_attachments, items_inside, skill_book_data, extra
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      getGameItem: this._handle.prepare('SELECT * FROM game_items WHERE id = ?'),
      searchGameItems: this._handle.prepare('SELECT * FROM game_items WHERE name LIKE ? OR id LIKE ? LIMIT 20'),
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Game reference data seeding
  // ═══════════════════════════════════════════════════════════════════════════

  seedGameItems(items: Array<Record<string, unknown>>): void {
    const tx = this._handle.transaction((list: Array<Record<string, unknown>>) => {
      for (const item of list) {
        this._stmts.upsertGameItem.run(
          item.id,
          item.name || '',
          item.description || '',
          item.type || '',
          item.typeRaw || '',
          item.specificType || '',
          item.wearPosition || '',
          item.type || '', // category = type
          item.chanceToSpawn ?? 0,
          item.durabilityLoss ?? 0,
          item.armorProtection ?? 0,
          item.maxStackSize ?? 1,
          item.canStack ? 1 : 0,
          item.itemSize ?? 1,
          item.weight ?? 0,
          item.firstValue ?? 0,
          typeof item.secondItemType === 'string' ? item.secondItemType : '',
          item.secondValue ?? 0,
          item.valueToTrader ?? 0,
          item.valueForPlayer ?? 0,
          item.doesDecay ? 1 : 0,
          item.decayPerDay ?? 0,
          item.onlyDecayIfOpened ? 1 : 0,
          item.warmthValue ?? 0,
          item.infectionProtection ?? 0,
          item.clothingRainMod ?? 0,
          item.clothingSnowMod ?? 0,
          item.summerCoolValue ?? 0,
          item.isSkillBook ? 1 : 0,
          item.noPocket ? 1 : 0,
          item.excludeFromVendor ? 1 : 0,
          item.excludeFromAI ? 1 : 0,
          item.useAsFertilizer ? 1 : 0,
          typeof item.state === 'string' ? item.state : '',
          item.tag || '',
          typeof item.openItem === 'string' ? item.openItem : item.openItem ? '1' : '',
          item.bodyAttachSocket || '',
          _json(item.supportedAttachments),
          _json(item.itemsInside),
          _json(item.skillBookData),
          _json({}),
        );
      }
    });
    tx(items);
  }

  getGameItem(id: number) {
    return this._stmts.getGameItem.get(id);
  }

  searchGameItems(query: string) {
    const q = `%${query}%`;
    return this._stmts.searchGameItems.all(q, q);
  }

  seedGameProfessions(professions: Array<Record<string, unknown>>) {
    const stmt = this._handle.prepare(
      'INSERT OR REPLACE INTO game_professions (id, enum_value, enum_index, perk, description, affliction, skills) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    const tx = this._handle.transaction((list: Array<Record<string, unknown>>) => {
      for (const p of list) {
        stmt.run(
          p.id,
          p.enumValue || '',
          p.enumIndex || 0,
          p.perk || '',
          p.description || '',
          p.affliction || '',
          _json(p.skills),
        );
      }
    });
    tx(professions);
  }

  seedGameAfflictions(afflictions: Array<Record<string, unknown>>) {
    const stmt = this._handle.prepare(
      'INSERT OR REPLACE INTO game_afflictions (idx, name, description, icon) VALUES (?, ?, ?, ?)',
    );
    const tx = this._handle.transaction((list: Array<Record<string, unknown>>) => {
      for (const a of list) {
        stmt.run(a.idx, a.name, a.description || '', a.icon || '');
      }
    });
    tx(afflictions);
  }

  seedGameSkills(skills: Array<Record<string, unknown>>) {
    const stmt = this._handle.prepare(
      'INSERT OR REPLACE INTO game_skills (id, name, description, effect, category, icon) VALUES (?, ?, ?, ?, ?, ?)',
    );
    const tx = this._handle.transaction((list: Array<Record<string, unknown>>) => {
      for (const s of list) {
        stmt.run(s.id, s.name, s.description || '', s.effect || '', s.category || '', s.icon || '');
      }
    });
    tx(skills);
  }

  seedGameChallenges(challenges: Array<Record<string, unknown>>) {
    const stmt = this._handle.prepare(
      'INSERT OR REPLACE INTO game_challenges (id, name, description, save_field, target) VALUES (?, ?, ?, ?, ?)',
    );
    const tx = this._handle.transaction((list: Array<Record<string, unknown>>) => {
      for (const c of list) {
        stmt.run(c.id, c.name, c.description || '', c.saveField || '', c.target || 0);
      }
    });
    tx(challenges);
  }

  seedLoadingTips(tips: Array<Record<string, unknown> | string>): void {
    const stmt = this._handle.prepare('INSERT OR REPLACE INTO game_loading_tips (id, text, category) VALUES (?, ?, ?)');
    const tx = this._handle.transaction((list: Array<Record<string, unknown> | string>) => {
      for (let i = 0; i < list.length; i++) {
        const entry = list[i];
        if (entry == null) continue;
        if (typeof entry === 'string') {
          stmt.run(i + 1, entry, '');
        } else {
          stmt.run(i + 1, entry.text || '', entry.category || '');
        }
      }
    });
    tx(tips);
  }

  getRandomTip() {
    return this._handle.prepare('SELECT text FROM game_loading_tips ORDER BY RANDOM() LIMIT 1').get();
  }

  // ─── New game reference seed methods (schema v11) ─────────────────────────

  seedGameBuildings(buildings: Array<Record<string, unknown>>) {
    const stmt = this._handle.prepare(`INSERT OR REPLACE INTO game_buildings (
      id, name, description, category, category_raw, health,
      show_in_build_menu, requires_build_tool, moveable, learned_building,
      landscape_only, water_only, structure_only, wall_placement, require_foundation,
      xp_multiplier, resources, upgrades
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const tx = this._handle.transaction((list: Array<Record<string, unknown>>) => {
      for (const b of list) {
        stmt.run(
          b.id,
          b.name || '',
          b.description || '',
          b.category || '',
          b.categoryRaw || '',
          b.health ?? 0,
          b.showInBuildMenu ? 1 : 0,
          b.requiresBuildTool ? 1 : 0,
          b.moveableAfterPlacement ? 1 : 0,
          b.learnedBuilding ? 1 : 0,
          b.placementOnLandscapeOnly ? 1 : 0,
          b.placementInWaterOnly ? 1 : 0,
          b.placementOnStructureOnly ? 1 : 0,
          b.wallPlacement ? 1 : 0,
          b.requireFoundation ? 1 : 0,
          b.xpMultiplier ?? 1,
          _json(b.resources),
          _json(b.upgrades),
        );
      }
    });
    tx(buildings);
  }

  seedGameLootPools(lootTables: Record<string, Record<string, unknown>>) {
    const poolStmt = this._handle.prepare(
      'INSERT OR REPLACE INTO game_loot_pools (id, name, item_count) VALUES (?, ?, ?)',
    );
    const itemStmt = this._handle.prepare(
      'INSERT OR REPLACE INTO game_loot_pool_items (pool_id, item_id, name, chance_to_spawn, type, max_stack_size) VALUES (?, ?, ?, ?, ?, ?)',
    );
    const tx = this._handle.transaction((tables: Record<string, Record<string, unknown>>) => {
      for (const [poolId, pool] of Object.entries(tables)) {
        poolStmt.run(poolId, pool.name || poolId, pool.itemCount || 0);
        const items = (pool.items ?? {}) as Record<string, unknown>;
        for (const [itemId, itemRaw] of Object.entries(items)) {
          const item = itemRaw as Record<string, unknown>;
          itemStmt.run(
            poolId,
            itemId,
            item.name || '',
            item.chanceToSpawn ?? 0,
            item.type || '',
            item.maxStackSize ?? 1,
          );
        }
      }
    });
    tx(lootTables);
  }

  seedGameVehiclesRef(vehicles: Array<Record<string, unknown>>) {
    const stmt = this._handle.prepare('INSERT OR REPLACE INTO game_vehicles_ref (id, name) VALUES (?, ?)');
    const tx = this._handle.transaction((list: Array<Record<string, unknown>>) => {
      for (const v of list) {
        stmt.run(v.id, v.name || v.id);
      }
    });
    tx(vehicles);
  }

  seedGameAnimals(animals: Array<Record<string, unknown>>) {
    const stmt = this._handle.prepare(
      'INSERT OR REPLACE INTO game_animals (id, name, type, hide_item_id) VALUES (?, ?, ?, ?)',
    );
    const tx = this._handle.transaction((list: Array<Record<string, unknown>>) => {
      for (const a of list) {
        stmt.run(a.id, a.name || a.id, a.type || '', a.hideItemId || '');
      }
    });
    tx(animals);
  }

  seedGameCrops(crops: Array<Record<string, unknown>>) {
    const stmt = this._handle.prepare(`INSERT OR REPLACE INTO game_crops (
      id, crop_id, growth_time_days, grid_columns, grid_rows, harvest_result, harvest_count, grow_seasons
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    const tx = this._handle.transaction((list: Array<Record<string, unknown>>) => {
      for (const c of list) {
        stmt.run(
          c.id,
          c.cropId ?? 0,
          c.growthTimeDays ?? 0,
          c.gridColumns ?? 1,
          c.gridRows ?? 1,
          c.harvestResult || '',
          c.harvestCount ?? 0,
          _json(c.growSeasons),
        );
      }
    });
    tx(crops);
  }

  seedGameCarUpgrades(upgrades: Array<Record<string, unknown>>) {
    const stmt = this._handle.prepare(`INSERT OR REPLACE INTO game_car_upgrades (
      id, type, type_raw, level, socket, tool_durability_lost, craft_time_minutes, health, craft_cost
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const tx = this._handle.transaction((list: Array<Record<string, unknown>>) => {
      for (const u of list) {
        stmt.run(
          u.id,
          u.type || '',
          u.typeRaw || '',
          u.level ?? 0,
          u.socket || '',
          u.toolDurabilityLost ?? 0,
          u.craftTimeMinutes ?? 0,
          u.health ?? 0,
          _json(u.craftCost),
        );
      }
    });
    tx(upgrades);
  }

  seedGameAmmoTypes(ammo: Array<Record<string, unknown>>) {
    const stmt = this._handle.prepare(
      'INSERT OR REPLACE INTO game_ammo_types (id, damage, headshot_multiplier, range, penetration) VALUES (?, ?, ?, ?, ?)',
    );
    const tx = this._handle.transaction((list: Array<Record<string, unknown>>) => {
      for (const a of list) {
        stmt.run(a.id, a.damage ?? 0, a.headshotMultiplier ?? 1, a.range ?? 0, a.penetration ?? 0);
      }
    });
    tx(ammo);
  }

  seedGameRepairData(repairs: Array<Record<string, unknown>>) {
    const stmt = this._handle.prepare(`INSERT OR REPLACE INTO game_repair_data (
      id, resource_type, resource_type_raw, amount, health_to_add, is_repairable, extra_resources
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    const tx = this._handle.transaction((list: Array<Record<string, unknown>>) => {
      for (const r of list) {
        stmt.run(
          r.id,
          r.resourceType || '',
          r.resourceTypeRaw || '',
          r.amount ?? 0,
          r.healthToAdd ?? 0,
          r.isRepairable ? 1 : 0,
          _json(r.extraResources),
        );
      }
    });
    tx(repairs);
  }

  seedGameFurniture(furniture: Array<Record<string, unknown>>) {
    const stmt = this._handle.prepare(
      'INSERT OR REPLACE INTO game_furniture (id, name, mesh_count, drop_resources) VALUES (?, ?, ?, ?)',
    );
    const tx = this._handle.transaction((list: Array<Record<string, unknown>>) => {
      for (const f of list) {
        stmt.run(f.id, f.name || f.id, f.meshCount ?? 0, _json(f.dropResources));
      }
    });
    tx(furniture);
  }

  seedGameTraps(traps: Array<Record<string, unknown>>) {
    const stmt = this._handle.prepare(
      'INSERT OR REPLACE INTO game_traps (id, item_id, requires_weapon, requires_ammo, requires_items, required_ammo_id) VALUES (?, ?, ?, ?, ?, ?)',
    );
    const tx = this._handle.transaction((list: Array<Record<string, unknown>>) => {
      for (const t of list) {
        stmt.run(
          t.id,
          t.itemId || '',
          t.requiresWeapon ? 1 : 0,
          t.requiresAmmo ? 1 : 0,
          t.requiresItems ? 1 : 0,
          t.requiredAmmoId || '',
        );
      }
    });
    tx(traps);
  }

  seedGameSprays(sprays: Array<Record<string, unknown>>) {
    const stmt = this._handle.prepare(
      'INSERT OR REPLACE INTO game_sprays (id, name, description, color) VALUES (?, ?, ?, ?)',
    );
    const tx = this._handle.transaction((list: Array<Record<string, unknown>>) => {
      for (const s of list) {
        stmt.run(s.id, s.name || s.id, s.description || '', s.color || '');
      }
    });
    tx(sprays);
  }

  seedGameRecipes(recipes: Array<Record<string, unknown>>) {
    const stmt = this._handle.prepare(`INSERT OR REPLACE INTO game_recipes (
      id, name, description, station, station_raw, recipe_type, craft_time,
      profession, profession_raw, requires_recipe, hidden, inventory_search_only,
      xp_multiplier, use_any, copy_capacity, no_spoiled, ignore_melee_check,
      override_name, override_description, crafted_item, also_give_item, also_give_arr,
      ingredients
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const tx = this._handle.transaction((list: Array<Record<string, unknown>>) => {
      for (const r of list) {
        stmt.run(
          r.id,
          r.name || '',
          r.description || '',
          r.station || '',
          r.stationRaw || '',
          r.recipeType || '',
          r.craftTime ?? 0,
          r.profession || '',
          r.professionRaw || '',
          r.requiresRecipe ? 1 : 0,
          r.hidden ? 1 : 0,
          r.inventorySearchOnly ? 1 : 0,
          r.xpMultiplier ?? 1,
          r.useAny ? 1 : 0,
          r.copyCapacity ? 1 : 0,
          r.noSpoiled ? 1 : 0,
          r.ignoreMeleeCheck ? 1 : 0,
          r.overrideName || '',
          r.overrideDescription || '',
          _json(r.craftedItem),
          _json(r.alsoGiveItem),
          _json(r.alsoGiveArr),
          _json(r.ingredients),
        );
      }
    });
    tx(recipes);
  }

  seedGameLore(lore: Array<Record<string, unknown>>) {
    const stmt = this._handle.prepare(
      'INSERT OR REPLACE INTO game_lore (id, title, text, category, sort_order) VALUES (?, ?, ?, ?, ?)',
    );
    const tx = this._handle.transaction((list: Array<Record<string, unknown>>) => {
      for (const l of list) {
        stmt.run(l.id, l.title || '', l.text || '', l.category || '', l.order ?? 0);
      }
    });
    tx(lore);
  }

  seedGameQuests(quests: Array<Record<string, unknown>>) {
    const stmt = this._handle.prepare(
      'INSERT OR REPLACE INTO game_quests (id, name, description, xp_reward, requirements, rewards) VALUES (?, ?, ?, ?, ?, ?)',
    );
    const tx = this._handle.transaction((list: Array<Record<string, unknown>>) => {
      for (const q of list) {
        stmt.run(q.id, q.name || '', q.description || '', q.xpReward ?? 0, _json(q.requirements), _json(q.rewards));
      }
    });
    tx(quests);
  }

  seedGameSpawnLocations(spawns: Array<Record<string, unknown>>) {
    const stmt = this._handle.prepare(
      'INSERT OR REPLACE INTO game_spawn_locations (id, name, description, map) VALUES (?, ?, ?, ?)',
    );
    const tx = this._handle.transaction((list: Array<Record<string, unknown>>) => {
      for (const s of list) {
        stmt.run(s.id, s.name || s.id, s.description || '', s.map || '');
      }
    });
    tx(spawns);
  }

  seedGameServerSettingDefs(settings: Array<Record<string, unknown>>) {
    const stmt = this._handle.prepare(
      'INSERT OR REPLACE INTO game_server_setting_defs (key, label, description, type, default_val, options) VALUES (?, ?, ?, ?, ?, ?)',
    );
    const tx = this._handle.transaction((list: Array<Record<string, unknown>>) => {
      for (const s of list) {
        stmt.run(s.key, s.label || '', s.description || '', s.type || 'string', s.defaultVal || '', _json(s.options));
      }
    });
    tx(settings);
  }
}

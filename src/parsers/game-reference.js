/**
 * Game reference module — seeds static game data into SQLite.
 *
 * Uses the curated data from game-data.js (high quality, hand-verified)
 * and supplements with parsed pak datatable files where useful.
 *
 * Run once at startup via db.seedGameReference() or manually via
 *   node -e "require('./src/parsers/game-reference').seed(db)"
 *
 * Tables populated:
 *   - game_professions   (from PROFESSION_DETAILS)
 *   - game_afflictions    (from AFFLICTION_MAP)
 *   - game_skills         (from SKILL_EFFECTS)
 *   - game_challenges     (from CHALLENGES + CHALLENGE_DESCRIPTIONS)
 *   - game_loading_tips   (from LOADING_TIPS)
 *   - game_items          (from dt-itemdatabase.txt if available)
 *   - game_lore           (from dt-loredata.txt if available)
 *   - game_quests         (from dt-miniquest.txt if available)
 *   - game_spawn_locations (from dt-spawnlocationdemo.txt if available)
 *   - game_server_setting_defs (from SERVER_SETTING_DESCRIPTIONS)
 */

const fs = require('fs');
const path = require('path');
const {
  AFFLICTION_MAP,
  PROFESSION_DETAILS,
  CHALLENGES,
  CHALLENGE_DESCRIPTIONS,
  LOADING_TIPS,
  SKILL_EFFECTS,
  SERVER_SETTING_DESCRIPTIONS,
} = require('../game-data');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');

// ─── Seed all game reference data ──────────────────────────────────────────

/**
 * Seed all game reference data into the database.
 * Safe to call multiple times — uses INSERT OR REPLACE.
 *
 * @param {import('../db/database')} db - Initialised HumanitZDB instance
 */
function seed(db) {
  seedProfessions(db);
  seedAfflictions(db);
  seedSkills(db);
  seedChallenges(db);
  seedLoadingTips(db);
  seedServerSettingDefs(db);

  // Optional pak-derived data (may not exist)
  seedItemsFromPak(db);
  seedLoreFromPak(db);
  seedQuestsFromPak(db);
  seedSpawnLocationsFromPak(db);

  db._setMeta('game_ref_seeded', new Date().toISOString());
  console.log('[GameRef] All game reference data seeded');
}

// ─── Professions ────────────────────────────────────────────────────────────

function seedProfessions(db) {
  const { PERK_MAP } = require('./save-parser');

  // Build enum_value → name reverse map
  const enumToName = {};
  for (const [enumVal, name] of Object.entries(PERK_MAP)) {
    enumToName[name] = enumVal;
  }

  const professions = Object.entries(PROFESSION_DETAILS).map(([name, info]) => ({
    id: name,
    enumValue: enumToName[name] || '',
    enumIndex: _enumIndex(enumToName[name]),
    perk: info.perk || '',
    description: info.description || '',
    affliction: info.affliction || '',
    skills: info.unlockedSkills || [],
  }));

  db.seedGameProfessions(professions);
}

function _enumIndex(enumValue) {
  if (!enumValue) return 0;
  const m = enumValue.match(/(\d+)$/);
  return m ? parseInt(m[1], 10) : 0;
}

// ─── Afflictions ────────────────────────────────────────────────────────────

function seedAfflictions(db) {
  const afflictions = AFFLICTION_MAP.map((name, idx) => ({
    idx,
    name,
    description: '',  // Could be enhanced from pak data
    icon: '',
  }));
  db.seedGameAfflictions(afflictions);
}

// ─── Skills ─────────────────────────────────────────────────────────────────

function seedSkills(db) {
  const skills = Object.entries(SKILL_EFFECTS).map(([id, effect]) => ({
    id,
    name: id.charAt(0).toUpperCase() + id.slice(1).toLowerCase().replace(/_/g, ' '),
    description: '',
    effect,
    category: _inferSkillCategory(id),
    icon: '',
  }));
  db.seedGameSkills(skills);
}

function _inferSkillCategory(skillId) {
  const combat = ['CALLUSED', 'SPRINTER', 'WRESTLER', 'VITAL SHOT', 'REDEYE', 'RELOADER', 'MAG FLIP', 'CONTROLLED BREATHING'];
  const survival = ['BANDOLEER', 'HEALTHY GUT', 'INFECTION TREATMENT', 'BEAST OF BURDEN'];
  const stealth = ['SPEED STEALTH', 'DEEP POCKETS', 'LIGHTFOOT', 'HACKER'];
  const crafting = ['CARPENTRY', 'METAL WORKING', 'RING MY BELL'];
  const social = ['CHARISMA', 'HAGGLER'];

  if (combat.includes(skillId)) return 'combat';
  if (survival.includes(skillId)) return 'survival';
  if (stealth.includes(skillId)) return 'stealth';
  if (crafting.includes(skillId)) return 'crafting';
  if (social.includes(skillId)) return 'social';
  return 'general';
}

// ─── Challenges ─────────────────────────────────────────────────────────────

function seedChallenges(db) {
  // Merge CHALLENGES (from DT_StatConfig) with CHALLENGE_DESCRIPTIONS (from save field mapping)
  const merged = [];

  // From DT_StatConfig
  for (const ch of CHALLENGES) {
    merged.push({
      id: ch.id,
      name: ch.name,
      description: ch.description,
      saveField: '',
      target: 0,
    });
  }

  // From save field mapping (these have save_field keys)
  for (const [field, info] of Object.entries(CHALLENGE_DESCRIPTIONS)) {
    const existing = merged.find(m => m.name === info.name);
    if (existing) {
      existing.saveField = field;
      existing.target = info.target || 0;
      if (info.desc && !existing.description) existing.description = info.desc;
    } else {
      merged.push({
        id: field,
        name: info.name,
        description: info.desc || '',
        saveField: field,
        target: info.target || 0,
      });
    }
  }

  db.seedGameChallenges(merged);
}

// ─── Loading tips ───────────────────────────────────────────────────────────

function seedLoadingTips(db) {
  const categorized = LOADING_TIPS.map(text => {
    let category = 'general';
    if (/RMB|LMB|press|toggle|click|key|ctrl|shift|spacebar|hot key|button/i.test(text)) category = 'controls';
    else if (/health|thirst|hunger|stamina|infection|vital/i.test(text)) category = 'vitals';
    else if (/inventory|weapon|slot|backpack|carry/i.test(text)) category = 'inventory';
    else if (/fish|reel|tension|bait/i.test(text)) category = 'fishing';
    else if (/build|craft|station|structure|workbench/i.test(text)) category = 'crafting';
    else if (/vehicle|car|trunk|stall|horn|headlight/i.test(text)) category = 'vehicles';
    else if (/zeek|zombie|spawn/i.test(text)) category = 'combat';
    return { text, category };
  });
  db.seedLoadingTips(categorized);
}

// ─── Server setting definitions ─────────────────────────────────────────────

function seedServerSettingDefs(db) {
  const stmt = db.db.prepare(
    'INSERT OR REPLACE INTO game_server_setting_defs (key, label, description, type, default_val, options) VALUES (?, ?, ?, ?, ?, ?)'
  );

  const tx = db.db.transaction(() => {
    for (const [key, label] of Object.entries(SERVER_SETTING_DESCRIPTIONS)) {
      const type = _inferSettingType(key);
      stmt.run(key, label, '', type, '', '[]');
    }
  });
  tx();
}

function _inferSettingType(key) {
  if (/enabled|fire|anywhere|position|drop/i.test(key)) return 'bool';
  if (/max|time|drain|multiplier|population|difficulty/i.test(key)) return 'float';
  if (/mode|level/i.test(key)) return 'enum';
  if (/name/i.test(key)) return 'string';
  return 'string';
}

// ═══════════════════════════════════════════════════════════════════════════
//  Pak-derived data (optional — from dt-*.txt files in data/)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Parse a dt-*.txt file.
 * Format: rows separated by blank lines, each row has lines like "Key: Value" or RowName headers.
 */
function _parseDtFile(filename) {
  const filePath = path.join(DATA_DIR, filename);
  if (!fs.existsSync(filePath)) return [];

  const content = fs.readFileSync(filePath, 'utf-8');
  const blocks = content.split(/\n\s*\n/).filter(b => b.trim());

  return blocks.map(block => {
    const lines = block.trim().split('\n');
    const entry = {};

    for (const line of lines) {
      const colonIdx = line.indexOf(':');
      if (colonIdx === -1) {
        // Could be a header/row name
        if (line.startsWith('---')) continue;
        entry._header = line.trim();
        continue;
      }
      const key = line.substring(0, colonIdx).trim();
      const value = line.substring(colonIdx + 1).trim();
      entry[key] = value;
    }
    return entry;
  }).filter(e => Object.keys(e).length > 0);
}

function seedItemsFromPak(db) {
  const entries = _parseDtFile('dt-itemdatabase.txt');
  if (entries.length === 0) return;

  const items = [];
  for (const entry of entries) {
    const name = entry.ItemName || entry.Name || entry._header || '';
    const id = entry.RowName || entry._header || name;
    if (!name && !id) continue;

    items.push({
      id: _cleanId(id),
      name: _cleanName(name),
      description: entry.Description || '',
      category: entry.Category || entry.Type || '',
      icon: entry.Icon || '',
      blueprint: entry.Blueprint || entry.Class || '',
      stackSize: parseInt(entry.StackSize || entry.MaxStack || '1', 10) || 1,
      extra: {},
    });
  }

  if (items.length > 0) {
    db.seedGameItems(items);
    console.log(`[GameRef] Seeded ${items.length} items from dt-itemdatabase.txt`);
  }
}

function seedLoreFromPak(db) {
  const entries = _parseDtFile('dt-loredata.txt');
  if (entries.length === 0) return;

  const stmt = db.db.prepare(
    'INSERT OR REPLACE INTO game_lore (id, title, text, location) VALUES (?, ?, ?, ?)'
  );

  const tx = db.db.transaction(() => {
    for (const entry of entries) {
      const id = entry.RowName || entry._header || '';
      if (!id) continue;
      stmt.run(
        _cleanId(id),
        entry.Title || entry.Name || '',
        entry.Text || entry.Description || entry.Content || '',
        entry.Location || ''
      );
    }
  });
  tx();
}

function seedQuestsFromPak(db) {
  const entries = _parseDtFile('dt-miniquest.txt');
  if (entries.length === 0) return;

  const stmt = db.db.prepare(
    'INSERT OR REPLACE INTO game_quests (id, name, description, objectives, rewards, extra) VALUES (?, ?, ?, ?, ?, ?)'
  );

  const tx = db.db.transaction(() => {
    for (const entry of entries) {
      const id = entry.RowName || entry._header || '';
      if (!id) continue;
      stmt.run(
        _cleanId(id),
        entry.QuestName || entry.Name || id,
        entry.Description || '',
        JSON.stringify([]),  // would need structured parsing
        JSON.stringify([]),
        JSON.stringify(entry)
      );
    }
  });
  tx();
}

function seedSpawnLocationsFromPak(db) {
  const entries = _parseDtFile('dt-spawnlocationdemo.txt');
  if (entries.length === 0) return;

  const stmt = db.db.prepare(
    'INSERT OR REPLACE INTO game_spawn_locations (id, name, description, type, image) VALUES (?, ?, ?, ?, ?)'
  );

  const tx = db.db.transaction(() => {
    for (const entry of entries) {
      const id = entry.RowName || entry._header || '';
      if (!id) continue;
      stmt.run(
        _cleanId(id),
        entry.Name || entry.DisplayName || id,
        entry.Description || '',
        entry.Type || '',
        entry.Image || entry.Icon || ''
      );
    }
  });
  tx();
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function _cleanId(raw) {
  return raw.replace(/['"]/g, '').trim();
}

function _cleanName(raw) {
  return raw
    .replace(/['"]/g, '')
    .replace(/^BP_/, '')
    .replace(/_C$/, '')
    .replace(/_/g, ' ')
    .trim();
}

module.exports = { seed };

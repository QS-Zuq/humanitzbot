/**
 * Smart .env synchronization utility
 *
 * Keeps .env in sync with .env.example without losing user data:
 * - Adds new keys from .env.example with their default values
 * - Preserves all existing user-configured values
 * - Comments out deprecated keys (in .env but not in .example)
 * - Maintains section comments and organization
 * - Tracks schema version to detect when updates are needed
 *
 * Usage:
 *   const { syncEnv, needsSync } = require('./env-sync');
 *   if (needsSync()) {
 *     const changes = syncEnv();
 *     console.log(`Updated .env: ${changes.added} added, ${changes.deprecated} deprecated`);
 *   }
 */

const fs = require('fs');
const path = require('path');

let _envPath = path.join(__dirname, '..', '.env');
let _examplePath = path.join(__dirname, '..', '.env.example');
let _backupDir = path.join(__dirname, '..', 'data', 'backups');
const ENV_VERSION_KEY = 'ENV_SCHEMA_VERSION';

/**
 * Parse .env file into structured data
 * @returns {{ version: string|null, entries: Map<key, { value, comment, line }>, raw: string }}
 */
function parseEnv(filePath, { includeCommented = false } = {}) {
  if (!fs.existsSync(filePath)) return { version: null, entries: new Map(), raw: '' };

  const raw = fs.readFileSync(filePath, 'utf8');
  const entries = new Map();
  let version = null;

  const lines = raw.split('\n');
  let currentComment = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Parse active key=value
    const activeMatch = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (activeMatch) {
      const [, key, value] = activeMatch;
      entries.set(key, {
        value: value.trim(),
        comment: currentComment.join('\n'),
        line: i + 1,
        commented: false,
      });

      if (key === ENV_VERSION_KEY) {
        version = value.trim();
      }

      currentComment = [];
      continue;
    }

    // Parse commented-out key=value (e.g. #RESTART_TIMES=06:00,18:00)
    // Only when includeCommented is true (for .env.example parsing)
    if (includeCommented && line.startsWith('#')) {
      const commentedMatch = line.match(/^#\s*([A-Z_][A-Z0-9_]*)\s*=(.*)$/);
      if (commentedMatch) {
        const [, key, value] = commentedMatch;
        // Don't overwrite an active entry with a commented one
        if (!entries.has(key)) {
          entries.set(key, {
            value: value.trim(),
            comment: currentComment.join('\n'),
            line: i + 1,
            commented: true, // optional key — user can uncomment
          });
        }
        currentComment = [];
        continue;
      }
    }

    // Capture comments
    if (line.startsWith('#')) {
      currentComment.push(line);
      continue;
    }

    // Reset comment accumulator on blank lines
    if (line === '') {
      currentComment = [];
    }
  }

  return { version, entries, raw };
}

/**
 * Extract section headers from .env.example
 * Returns array of { title, startKey, endKey }
 */
function extractSections(examplePath) {
  const content = fs.readFileSync(examplePath, 'utf8');
  const sections = [];
  // Virtual preamble section for keys before the first real section header
  let currentSection = { title: null, startKey: null, keys: [] };
  let lastKey = null;

  for (const line of content.split('\n')) {
    const trimmed = line.trim();

    // Section header: # ── Section Name ──────...
    if (/^#\s*──\s*(.+?)\s*──+/.test(trimmed)) {
      if (currentSection) {
        currentSection.endKey = lastKey;
        sections.push(currentSection);
      }
      currentSection = {
        title: trimmed,
        startKey: null,
        keys: [],
      };
    }

    // Key=value (active or commented-out optional)
    const match = trimmed.match(/^#?\s*([A-Z_][A-Z0-9_]*)\s*=/);
    if (match) {
      const key = match[1];
      lastKey = key;
      if (currentSection) {
        if (!currentSection.startKey) currentSection.startKey = key;
        if (!currentSection.keys.includes(key)) currentSection.keys.push(key);
      }
    }
  }

  if (currentSection) {
    currentSection.endKey = lastKey;
    sections.push(currentSection);
  }

  return sections;
}

/**
 * Check if .env needs sync with .env.example
 * @returns {boolean}
 */
function needsSync() {
  if (!fs.existsSync(_envPath)) return true;
  if (!fs.existsSync(_examplePath)) return false;

  const env = parseEnv(_envPath);
  const example = parseEnv(_examplePath, { includeCommented: true });

  // Check version mismatch
  if (env.version !== example.version) return true;

  // Check for missing non-optional keys
  for (const [key, entry] of example.entries) {
    if (!entry.commented && !env.entries.has(key)) return true;
  }

  return false;
}

/**
 * Sync .env with .env.example, preserving user values
 * @returns {{ added: number, deprecated: number, updated: number }}
 */
function syncEnv() {
  if (!fs.existsSync(_examplePath)) {
    throw new Error('.env.example not found');
  }

  const env = parseEnv(_envPath);
  const example = parseEnv(_examplePath, { includeCommented: true });
  const sections = extractSections(_examplePath);

  const result = { added: 0, deprecated: 0, updated: 0 };
  const output = [];

  // Process each section from .env.example
  for (const section of sections) {
    if (section.title) {
      output.push(section.title);
      output.push('');
    }

    for (const key of section.keys) {
      const exampleEntry = example.entries.get(key);
      const envEntry = env.entries.get(key);
      if (!exampleEntry) continue; // safety

      // Add comment block from example, but strip the section header line
      // (parseEnv accumulates # lines as comments — section headers get captured too)
      if (exampleEntry.comment) {
        let commentBlock = exampleEntry.comment;
        // Strip leading section header line(s) since we already wrote section.title
        if (section.title) {
          const commentLines = commentBlock.split('\n');
          while (commentLines.length > 0 && /^#\s*──/.test(commentLines[0].trim())) {
            commentLines.shift();
          }
          commentBlock = commentLines.join('\n').replace(/^\n+/, '');
        }
        if (commentBlock) output.push(commentBlock);
      }

      if (envEntry) {
        // ENV_SCHEMA_VERSION always takes the example value (it's the target, not user data)
        if (key === ENV_VERSION_KEY) {
          output.push(`${key}=${exampleEntry.value}`);
        } else {
          // Preserve existing user value (whether example was commented or not)
          output.push(`${key}=${envEntry.value}`);
        }
      } else if (exampleEntry.commented) {
        // Optional key — keep it commented like in example
        output.push(`#${key}=${exampleEntry.value}`);
      } else {
        // Required key missing — add with example default
        output.push(`${key}=${exampleEntry.value}`);
        result.added++;
      }

      output.push('');
    }
  }

  // Handle deprecated keys (in .env but not in .example)
  // Keep dynamic keys that match known prefixes (e.g. RESTART_PROFILE_CALM, RESTART_PROFILE_HORDE)
  const DYNAMIC_PREFIXES = ['RESTART_PROFILE_', 'PVP_HOURS_', 'MULTI_SERVER_'];
  const deprecatedKeys = [];
  const dynamicKeys = [];
  for (const key of env.entries.keys()) {
    if (example.entries.has(key) || key === ENV_VERSION_KEY) continue;
    const isDynamic = DYNAMIC_PREFIXES.some((p) => key.startsWith(p));
    if (isDynamic) {
      dynamicKeys.push(key);
    } else {
      deprecatedKeys.push(key);
    }
  }

  // Preserve dynamic keys (user-defined profiles, per-day overrides, etc.)
  if (dynamicKeys.length > 0) {
    for (const key of dynamicKeys) {
      const entry = env.entries.get(key);
      if (entry.comment) output.push(entry.comment);
      output.push(`${key}=${entry.value}`);
      output.push('');
    }
  }

  if (deprecatedKeys.length > 0) {
    // When upgrading to v5+, non-bootstrap keys were migrated to DB
    const isMigratingToDb = parseInt(example.version, 10) >= 5;
    if (isMigratingToDb) {
      output.push('# ── Migrated to Database ─────────────────────────────────────');
      output.push('# These settings are now managed via the Panel Channel or Web Dashboard.');
      output.push('# You can safely remove these lines.');
    } else {
      output.push('# ── Deprecated Keys (no longer used) ──────────────────────────');
      output.push('# These keys are from an older version and can be safely removed.');
    }
    output.push('');

    for (const key of deprecatedKeys) {
      const entry = env.entries.get(key);
      const prefix = isMigratingToDb ? '[Migrated to DB] ' : '';
      output.push(`# ${prefix}${key}=${entry.value}`);
      result.deprecated++;
    }
    output.push('');
  }

  // Write updated .env
  const newContent = output.join('\n');

  // Backup old .env to data/backups/, keep last 2
  if (fs.existsSync(_envPath)) {
    if (!fs.existsSync(_backupDir)) fs.mkdirSync(_backupDir, { recursive: true });
    const backup = path.join(_backupDir, `.env.backup.${Date.now()}`);
    fs.copyFileSync(_envPath, backup);
    console.log(`[ENV-SYNC] Backed up old .env to: ${path.relative(path.join(__dirname, '..'), backup)}`);
    // Prune old backups — keep only the 2 most recent
    try {
      const backups = fs
        .readdirSync(_backupDir)
        .filter((f) => f.startsWith('.env.backup.'))
        .sort()
        .map((f) => path.join(_backupDir, f));
      while (backups.length > 2) {
        fs.unlinkSync(backups.shift());
      }
    } catch (_) {
      /* best effort */
    }
  }

  fs.writeFileSync(_envPath, newContent, 'utf8');

  return result;
}

/**
 * Get current .env schema version
 */
function getVersion() {
  const env = parseEnv(_envPath);
  return env.version || '0';
}

/**
 * Get .env.example schema version
 */
function getExampleVersion() {
  const example = parseEnv(_examplePath);
  return example.version || '0';
}

module.exports = {
  needsSync,
  syncEnv,
  getVersion,
  getExampleVersion,
  parseEnv,
};

// ── Test escape hatch ─────────────────────────────────────
const _defaultEnvPath = _envPath;
const _defaultExamplePath = _examplePath;
const _defaultBackupDir = _backupDir;
module.exports._test = {
  setPaths({ envPath, examplePath, backupDir } = {}) {
    if (envPath !== undefined) _envPath = envPath;
    if (examplePath !== undefined) _examplePath = examplePath;
    if (backupDir !== undefined) _backupDir = backupDir;
  },
  resetPaths() {
    _envPath = _defaultEnvPath;
    _examplePath = _defaultExamplePath;
    _backupDir = _defaultBackupDir;
  },
};

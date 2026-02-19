const rcon = require('./rcon');

/**
 * HumanitZ RCON command wrappers & response parsers.
 *
 * Official HumanitZ RCON commands (via Bisect Hosting docs):
 *   info              - Prints current world information
 *   Players           - Lists connected players (name/SteamID)
 *   admin [message]   - Send admin chat message
 *   kick [SteamID]    - Kick a player
 *   ban [SteamID]     - Ban a player
 *   unban [SteamID]   - Unban a player
 *   fetchbanned       - List banned SteamIDs
 *   teleport [SteamID]- Teleport player to nearest spawn
 *   unstuck [SteamID] - Unstuck a player
 *   season [name]     - Set the current season
 *   weather [name]    - Set the current weather
 *   restart [minutes] - Restart after X minutes
 *   QuickRestart      - Restart after 1 minute
 *   RestartNow        - Restart immediately
 *   CancelRestart     - Cancel a pending restart
 *   shutdown          - Shut down immediately
 *   fetchchat         - Fetch recent in-game chat messages
 *
 * NOTE: There is NO playerinfo command in HumanitZ RCON.
 */

const COMMANDS = {
  INFO: 'info',
  PLAYERS: 'Players',
  ADMIN_MSG: 'admin',
  KICK: 'kick',
  BAN: 'ban',
  UNBAN: 'unban',
  FETCH_BANNED: 'fetchbanned',
  TELEPORT: 'teleport',
  UNSTUCK: 'unstuck',
  SEASON: 'season',
  WEATHER: 'weather',
  RESTART: 'restart',
  QUICK_RESTART: 'QuickRestart',
  RESTART_NOW: 'RestartNow',
  CANCEL_RESTART: 'CancelRestart',
  SHUTDOWN: 'shutdown',
};

/**
 * Get server world info (day, season, weather, player count, etc.)
 * Returns parsed object + raw string.
 */
async function getServerInfo() {
  const raw = await rcon.sendCached(COMMANDS.INFO, 30000);
  return parseServerInfo(raw);
}

/**
 * Get a list of currently connected players.
 * Returns { count, players: [{ name, steamId }], raw }
 */
async function getPlayerList() {
  const raw = await rcon.sendCached(COMMANDS.PLAYERS, 15000);
  return parsePlayerList(raw);
}

/**
 * Send a message to server chat as [Admin].
 */
async function sendAdminMessage(message) {
  return rcon.send(`${COMMANDS.ADMIN_MSG} ${message}`);
}

// ── Parsers ─────────────────────────────────────────────────────────────

function parseServerInfo(raw) {
  const result = {
    raw: raw || '',
    fields: {},
  };

  if (!raw || raw.trim() === '') return result;

  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);

  for (const line of lines) {
    // Handle "X connected." format (no colon separator)
    const connectedMatch = line.match(/^(\d+)\s+connected\.?$/i);
    if (connectedMatch) {
      result.players = parseInt(connectedMatch[1], 10);
      result.fields['Connected'] = connectedMatch[1];
      continue;
    }

    // Handle "No players connected"
    if (line.toLowerCase().includes('no players connected')) {
      result.players = 0;
      continue;
    }

    // Try key: value format
    const kv = line.match(/^(.+?):\s*(.+)$/);
    if (!kv) continue;
    const key = kv[1].trim();
    const value = kv[2].trim();
    const k = key.toLowerCase();

    // Store all fields for generic display
    result.fields[key] = value;

    // Map to known semantic fields
    if (k === 'name') {
      result.name = value;
    } else if (k === 'time') {
      // Zero-pad minutes: "2:2" → "2:02", "14:5" → "14:05"
      const timeParts = value.match(/^(\d{1,2}):(\d{1,2})$/);
      if (timeParts) {
        result.time = `${timeParts[1]}:${timeParts[2].padStart(2, '0')}`;
        result.fields[key] = result.time;
      } else {
        result.time = value;
      }
    } else if (k === 'season') {
      result.season = value;
    } else if (k === 'weather') {
      result.weather = value;
    } else if (k === 'day') {
      result.day = value;
    } else if (k === 'fps') {
      result.fps = value;
    } else if (k === 'ai') {
      result.ai = value;
    } else if (k.includes('player')) {
      const pm = value.match(/(\d+)\s*(?:\/\s*(\d+))?/);
      if (pm) {
        result.players = parseInt(pm[1], 10);
        if (pm[2]) result.maxPlayers = parseInt(pm[2], 10);
      }
    } else if (k.includes('version')) {
      result.version = value;
    }
  }

  return result;
}

function parsePlayerList(raw) {
  if (!raw || raw.trim() === '') {
    return { count: 0, players: [], raw: '' };
  }

  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
  const players = [];
  let count = 0;

  for (const line of lines) {
    // Skip common non-player lines
    if (/no\s+players?\s+(connected|online|found)/i.test(line)) continue;
    if (/^players?\s*$/i.test(line)) continue;

    // Try to extract player count from a header like "Players: 5" or "Players: 5/32"
    const countMatch = line.match(/players?\s*[:\-]\s*(\d+)(?:\s*\/\s*(\d+))?/i);
    if (countMatch) {
      count = parseInt(countMatch[1], 10);
      continue;
    }

    // HumanitZ "Players" command returns lines like:
    //   "PlayerName (76561198000000000_+_|<guid>)"
    //   "PlayerName (76561198xxxxxxxxx)"
    //   or just "PlayerName"
    // Extract the name and the 17-digit SteamID64 from the parenthesized block.
    const playerMatch = line.match(
      /^(.+?)\s*\((\d{17})[^)]*\)\s*$/
    );

    if (playerMatch) {
      // Matched "Name (SteamID...)" format
      const name = playerMatch[1].trim();
      if (name) {
        players.push({ name, steamId: playerMatch[2] });
      }
    } else {
      // Fallback: line might just be a plain name
      const name = line.replace(/^[\d#.)\s]+/, '').trim();
      if (name && name !== '-' && !name.toLowerCase().startsWith('player') && !name.startsWith('=') && !name.startsWith('-') && !/no\s+players?/i.test(name)) {
        players.push({ name, steamId: 'N/A' });
      }
    }
  }

  if (count === 0) count = players.length;

  return { count, players, raw };
}

module.exports = {
  COMMANDS,
  getServerInfo,
  getPlayerList,
  sendAdminMessage,
};

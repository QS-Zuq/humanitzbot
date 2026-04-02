// eslint-disable-next-line @typescript-eslint/no-require-imports
const _defaultRcon = require('./rcon') as import('./rcon').RconManager;

export const COMMANDS = {
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
} as const;

interface RconLike {
  sendCached(command: string, ttl: number): Promise<string>;
  send(command: string): Promise<string>;
}

export interface ServerInfo {
  raw: string;
  fields: Record<string, string>;
  players?: number;
  maxPlayers?: number;
  name?: string;
  time?: string;
  season?: string;
  weather?: string;
  day?: string;
  fps?: string;
  ai?: string;
  version?: string;
}

export interface PlayerEntry {
  name: string;
  steamId: string;
}

export interface PlayerList {
  count: number;
  players: PlayerEntry[];
  raw: string;
}

export async function getServerInfo(rcon?: RconLike): Promise<ServerInfo> {
  const r = rcon ?? _defaultRcon;
  const raw = await r.sendCached(COMMANDS.INFO, 30000);
  return parseServerInfo(raw);
}

export async function getPlayerList(rcon?: RconLike): Promise<PlayerList> {
  const r = rcon ?? _defaultRcon;
  const raw = await r.sendCached(COMMANDS.PLAYERS, 30000);
  return parsePlayerList(raw);
}

export async function sendAdminMessage(message: string, rcon?: RconLike): Promise<string> {
  const r = rcon ?? _defaultRcon;
  // Lead with </> to close default yellow so color tags in message work.
  // Message should start with a color open tag (e.g. <FO>) not </><FO>.
  return r.send(`${COMMANDS.ADMIN_MSG} </>${message}`);
}

// ── Parsers ─────────────────────────────────────────────────────────────

export function parseServerInfo(raw: string | null | undefined): ServerInfo {
  const result: ServerInfo = {
    raw: raw ?? '',
    fields: {},
  };

  if (!raw || raw.trim() === '') return result;

  const lines = raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  for (const line of lines) {
    // Handle "X connected." format (no colon separator)
    const connectedMatch = line.match(/^(\d+)\s+connected\.?$/i);
    if (connectedMatch) {
      result.players = parseInt(connectedMatch[1] ?? '0', 10);
      result.fields['Connected'] = connectedMatch[1] ?? '';
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
    const key = kv[1]?.trim() ?? '';
    const value = kv[2]?.trim() ?? '';
    const k = key.toLowerCase();

    // Store all fields for generic display
    result.fields[key] = value;

    // Map to known semantic fields
    if (k === 'name' || k === 'nonename') {
      result.name = value;
    } else if (k === 'time') {
      // Zero-pad minutes: "2:2" → "2:02", "14:5" → "14:05"
      const timeParts = value.match(/^(\d{1,2}):(\d{1,2})$/);
      if (timeParts) {
        result.time = `${timeParts[1] ?? ''}:${(timeParts[2] ?? '').padStart(2, '0')}`;
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
        result.players = parseInt(pm[1] ?? '0', 10);
        if (pm[2]) result.maxPlayers = parseInt(pm[2], 10);
      }
    } else if (k.includes('version')) {
      result.version = value;
    }
  }

  return result;
}

export function parsePlayerList(raw: string | null | undefined): PlayerList {
  if (!raw || raw.trim() === '') {
    return { count: 0, players: [], raw: '' };
  }

  const lines = raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const players: PlayerEntry[] = [];
  let count = 0;

  for (const line of lines) {
    // Skip common non-player lines
    if (/no\s+players?\s+(connected|online|found)/i.test(line)) continue;
    if (/^players?\s*$/i.test(line)) continue;

    // Try to extract player count from a header like "Players: 5" or "Players: 5/32"
    const countMatch = line.match(/players?\s*[:-]\s*(\d+)(?:\s*\/\s*(\d+))?/i);
    if (countMatch) {
      count = parseInt(countMatch[1] ?? '0', 10);
      continue;
    }

    // HumanitZ "Players" command returns lines like:
    //   "PlayerName (76561198000000000_+_|<guid>) Lv:27 Clan:X DPassed:54"
    //   "PlayerName (76561198xxxxxxxxx)"
    //   or just "PlayerName"
    // Extract the name and the 17-digit SteamID64 from the parenthesized block.
    // Trailing metadata (Lv, Clan, DPassed) after the closing paren is ignored.
    const playerMatch = line.match(/^(.+?)\s*\((\d{17})[^)]*\)/);

    if (playerMatch) {
      // Matched "Name (SteamID...)" format
      const name = playerMatch[1]?.trim() ?? '';
      if (name) {
        players.push({ name, steamId: playerMatch[2] ?? '' });
      }
    } else {
      // Fallback: line might just be a plain name
      const name = line.replace(/^[\d#.)\s]+/, '').trim();
      // Reject lines that look like RCON admin messages or chat contamination
      if (
        name &&
        name !== '-' &&
        !name.toLowerCase().startsWith('player') &&
        !name.startsWith('=') &&
        !name.startsWith('-') &&
        !/no\s+players?/i.test(name) &&
        !/<(?:SP|FO|FR|CL|PR|FC|BG)>/.test(name) &&
        !/\[\d+\/\d+\/\d/.test(name) &&
        !/Admin:\s/.test(name) &&
        !/Welcome/.test(name)
      ) {
        players.push({ name, steamId: 'N/A' });
      }
    }
  }

  if (count === 0) count = players.length;

  return { count, players, raw };
}

// CJS compatibility — non-migrated .js files require() this module
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _mod = module as { exports: any };
_mod.exports = {
  COMMANDS,
  getServerInfo,
  getPlayerList,
  sendAdminMessage,
  // Exported for testing
  _parseServerInfo: parseServerInfo,
  _parsePlayerList: parsePlayerList,
};

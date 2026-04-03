/* eslint-disable @typescript-eslint/no-unnecessary-condition, @typescript-eslint/no-base-to-string, @typescript-eslint/no-unnecessary-type-conversion */
import { ActivityType, type Client } from 'discord.js';
import config from '../config/index.js';
import panelApi from '../server/panel-api.js';
import { getServerInfo as _getServerInfo } from '../rcon/server-info.js';

interface ActivityItem {
  type: ActivityType;
  name: string;
}

interface PresenceBase {
  mode: 'online' | 'offline' | 'degraded' | 'unknown';
  status: 'online' | 'idle' | 'dnd';
  activity: ActivityItem;
}

interface ServerInfo {
  players?: unknown;
  maxPlayers?: unknown;
  fields?: Record<string, unknown>;
  name?: unknown;
  day?: unknown;
  time?: unknown;
  season?: unknown;
  weather?: unknown;
  fps?: unknown;
  ai?: unknown;
  version?: unknown;
}

interface BotStatusManagerOptions {
  refreshMs?: number;
  staleInfoMs?: number;
  rotationIntervalMs?: number;
  getServerInfo?: () => Promise<ServerInfo | null>;
  getHasSftp?: () => boolean;
  getPanelAvailable?: () => boolean;
  getWebMapEnabled?: () => boolean;
  getModuleStatus?: () => Record<string, string>;
  getNow?: () => number;
}

interface BotStatusManager {
  start: () => void;
  stop: () => void;
  refreshNow: (forceRotate?: boolean) => Promise<void>;
}

function _toInt(value: unknown): number | null {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) ? n : null;
}

function _limitActivityName(name: unknown, max = 128): string {
  const text = String(name ?? '');
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3)}...`;
}

function _hasValue(value: unknown): boolean {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

function _moduleState(rawStatus: unknown): 'active' | 'disabled' | 'warning' | 'unknown' {
  const text = String(rawStatus ?? '').toLowerCase();
  if (!text) return 'unknown';
  if (/(active|running|online|healthy|ok)\b/.test(text)) return 'active';
  if (/(disabled|off|inactive|not set)\b/.test(text)) return 'disabled';
  if (/(skip|warning|error|failed|require|waiting|partial|degraded|unavailable|disconnected)\b/.test(text)) {
    return 'warning';
  }
  return 'unknown';
}

function _isModuleActive(moduleStatus: Record<string, string> | null | undefined, moduleName: string): boolean {
  const state = moduleStatus?.[moduleName];
  return _moduleState(state) === 'active';
}

function _extractPlayers(info: ServerInfo | null | undefined): { players: number | null; maxPlayers: number | null } {
  if (!info || typeof info !== 'object') {
    return { players: null, maxPlayers: null };
  }

  let players = _toInt(info.players);
  let maxPlayers = _toInt(info.maxPlayers);

  if (players !== null && maxPlayers !== null) {
    return { players, maxPlayers };
  }

  const fields = info.fields && typeof info.fields === 'object' ? info.fields : null;
  if (!fields) {
    return { players, maxPlayers };
  }

  for (const [key, value] of Object.entries(fields)) {
    if (!/player|connected/i.test(String(key))) continue;
    const m = String(value).match(/(\d+)\s*(?:\/\s*(\d+))?/);
    if (!m) continue;
    if (players === null) players = _toInt(m[1]);
    if (maxPlayers === null && m[2] !== undefined) maxPlayers = _toInt(m[2]);
  }

  return { players, maxPlayers };
}

function _activityKey(activity: ActivityItem): string {
  return `${String(activity.type)}|${activity.name}`;
}

function _uniqueActivities(activities: (ActivityItem | null | undefined)[] | null | undefined): ActivityItem[] {
  const unique: ActivityItem[] = [];
  const seen = new Set<string>();

  for (const item of activities ?? []) {
    if (!item || !_hasValue(item.name)) continue;
    const key = _activityKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }

  return unique;
}

function _buildModuleSummaryActivity(moduleStatus: Record<string, string> | null | undefined): ActivityItem | null {
  const entries = Object.entries(moduleStatus ?? {});
  if (entries.length === 0) return null;

  let active = 0;
  let warning = 0;
  let disabled = 0;
  let unknown = 0;

  for (const [, stateText] of entries) {
    const state = _moduleState(stateText);
    if (state === 'active') active += 1;
    else if (state === 'warning') warning += 1;
    else if (state === 'disabled') disabled += 1;
    else unknown += 1;
  }

  const parts = [`${active} active`];
  if (warning > 0) parts.push(`${warning} warning`);
  if (disabled > 0) parts.push(`${disabled} off`);
  if (unknown > 0) parts.push(`${unknown} unknown`);

  return {
    type: ActivityType.Competing,
    name: `Modules: ${parts.join(' | ')}`,
  };
}

function _buildWorldActivities(info: ServerInfo | null | undefined): ActivityItem[] {
  if (!info || typeof info !== 'object') return [];
  const activities: ActivityItem[] = [];

  if (_hasValue(info.name)) {
    activities.push({
      type: ActivityType.Playing,
      name: String(info.name).trim(),
    });
  }

  const worldParts: string[] = [];
  if (_hasValue(info.day)) worldParts.push(`Day ${String(info.day).trim()}`);
  if (_hasValue(info.time)) worldParts.push(String(info.time).trim());
  if (_hasValue(info.season)) worldParts.push(String(info.season).trim());
  if (_hasValue(info.weather)) worldParts.push(String(info.weather).trim());
  if (worldParts.length > 0) {
    activities.push({
      type: ActivityType.Watching,
      name: worldParts.join(' | '),
    });
  }

  const fps = _toInt(info.fps);
  const ai = _toInt(info.ai);
  if (fps !== null || ai !== null) {
    const perf: string[] = [];
    if (fps !== null) perf.push(`FPS ${fps}`);
    if (ai !== null) perf.push(`AI ${ai}`);
    activities.push({
      type: ActivityType.Playing,
      name: perf.join(' | '),
    });
  }

  if (_hasValue(info.version)) {
    activities.push({
      type: ActivityType.Playing,
      name: `Build ${String(info.version).trim()}`,
    });
  }

  return activities;
}

function _buildConnectActivity(): ActivityItem | null {
  const host = String(config.publicHost ?? '').trim();
  if (!host) return null;

  const port = String(config.gamePort ?? '').trim();
  const endpoint = port ? `${host}:${port}` : host;

  return {
    type: ActivityType.Playing,
    name: `Connect ${endpoint}`,
  };
}

function _buildPlayerActivity(info: ServerInfo | null | undefined, lastPlayers: number | null): ActivityItem | null {
  const { players, maxPlayers } = _extractPlayers(info);
  if (players === null) return null;

  let label = maxPlayers && maxPlayers > 0 ? `${players}/${maxPlayers} Survivors` : `${players} Survivors Online`;

  if (lastPlayers !== null && Number.isFinite(lastPlayers) && players !== lastPlayers) {
    const delta = players - lastPlayers;
    const signed = delta > 0 ? `+${delta}` : `${delta}`;
    label += ` (${signed})`;
  }

  return {
    type: ActivityType.Watching,
    name: label,
  };
}

function _buildRecoveryActivity(lastInfo: ServerInfo | null): ActivityItem {
  const playerActivity = _buildPlayerActivity(lastInfo, null);
  if (!playerActivity) {
    return { type: ActivityType.Playing, name: 'Reconnecting RCON...' };
  }

  return {
    type: ActivityType.Playing,
    name: `${playerActivity.name} | Reconnecting RCON`,
  };
}

function createBotStatusManager(client: Client, opts: BotStatusManagerOptions = {}): BotStatusManager {
  const refreshMs = Math.max(parseInt(String(opts.refreshMs ?? ''), 10) || 30000, 15000);
  const staleInfoMs = Math.max(
    parseInt(String(opts.staleInfoMs ?? ''), 10) || Math.max(refreshMs * 4, 90000),
    refreshMs,
  );
  const rotationIntervalMs = Math.max(parseInt(String(opts.rotationIntervalMs ?? ''), 10) || refreshMs, 5000);
  const getServerInfoFn = opts.getServerInfo ?? _getServerInfo;
  const getHasSftp = opts.getHasSftp ?? (() => false);
  const getPanelAvailable = opts.getPanelAvailable ?? (() => false);
  const getWebMapEnabled = opts.getWebMapEnabled ?? (() => false);
  const getModuleStatus = opts.getModuleStatus ?? (() => ({}));
  const getNow = opts.getNow ?? (() => Date.now());

  let timer: ReturnType<typeof setInterval> | null = null;
  let rotationIndex = 0;
  let lastRotationAt = 0;
  let lastActivityKey = '';
  let lastPresenceKey = '';
  let lastInfo: ServerInfo | null = null;
  let lastInfoAt = 0;
  let lastPlayers: number | null = null;
  let inFlight: Promise<void> | null = null;

  function _buildBasePresence(
    info: ServerInfo | null,
    err: unknown,
    now: number,
    usedCachedInfo: boolean,
  ): PresenceBase {
    if (err && usedCachedInfo && lastInfo && now - lastInfoAt <= staleInfoMs) {
      return {
        mode: 'degraded',
        status: 'idle',
        activity: _buildRecoveryActivity(lastInfo),
      };
    }

    const playerActivity = _buildPlayerActivity(info, lastPlayers);
    if (playerActivity) {
      return {
        mode: 'online',
        status: 'online',
        activity: playerActivity,
      };
    }

    if (err) {
      return {
        mode: 'offline',
        status: 'dnd',
        activity: { type: ActivityType.Playing, name: 'Server Offline' },
      };
    }

    return {
      mode: 'unknown',
      status: 'idle',
      activity: { type: ActivityType.Watching, name: 'Monitoring Server' },
    };
  }

  function _buildFeatureActivities(): ActivityItem[] {
    const moduleStatus = getModuleStatus() ?? {};
    const features: ActivityItem[] = [];

    const isOn = (moduleName: string, cfgValue: unknown): boolean => {
      if (Object.prototype.hasOwnProperty.call(moduleStatus, moduleName)) {
        return _isModuleActive(moduleStatus, moduleName);
      }
      return !!cfgValue;
    };

    if (_isModuleActive(moduleStatus, 'WebMap') || getWebMapEnabled()) {
      features.push({ type: ActivityType.Watching, name: 'Live Map & Timeline' });
    }
    if (isOn('Panel', _isModuleActive(moduleStatus, 'Panel') || panelApi.available)) {
      features.push({ type: ActivityType.Playing, name: '/qspanel Controls' });
    }
    if (isOn('Status Channels', config.enableStatusChannels)) {
      features.push({ type: ActivityType.Watching, name: 'Voice Status Dashboard' });
    }
    if (isOn('Server Status', config.enableServerStatus)) {
      features.push({ type: ActivityType.Watching, name: 'Live Server Monitoring' });
    }
    if (isOn('Player Stats', config.enablePlayerStats)) {
      features.push({ type: ActivityType.Competing, name: '/playerstats Leaderboards' });
    }
    if (isOn('Chat Relay', config.enableChatRelay)) {
      features.push({ type: ActivityType.Listening, name: 'Discord <-> In-Game Chat' });
    }
    if (isOn('Log Watcher', config.enableLogWatcher)) {
      features.push({ type: ActivityType.Watching, name: 'Activity Threads' });
    }
    if (isOn('Auto-Broadcasts', config.enableAutoMsgLink || config.enableAutoMsgPromo)) {
      features.push({ type: ActivityType.Playing, name: 'Automated Broadcasts' });
    }
    if (isOn('PvP Scheduler', config.enablePvpScheduler)) {
      features.push({ type: ActivityType.Playing, name: 'PvP Window Scheduler' });
    }
    if (isOn('Server Scheduler', config.enableServerScheduler)) {
      features.push({ type: ActivityType.Playing, name: 'Restart Profile Scheduler' });
    }
    if (isOn('Recaps', config.enableRecaps)) {
      features.push({ type: ActivityType.Playing, name: 'Daily & Weekly Recaps' });
    }
    if (isOn('Milestones', config.enableMilestones)) {
      features.push({ type: ActivityType.Competing, name: 'Milestone Tracking' });
    }
    if (isOn('Activity Log', config.enableActivityLog)) {
      features.push({ type: ActivityType.Watching, name: 'Base & World Activity Feed' });
    }
    if (isOn('Anticheat', config.enableAnticheat)) {
      features.push({ type: ActivityType.Watching, name: 'Behavioral Anticheat' });
    }
    if (isOn('Save Service', getHasSftp() || getPanelAvailable())) {
      features.push({ type: ActivityType.Playing, name: 'Save Parser Sync' });
    }
    if (_isModuleActive(moduleStatus, 'Timeline')) {
      features.push({ type: ActivityType.Watching, name: 'Historical World Timeline' });
    }
    if (_isModuleActive(moduleStatus, 'Console')) {
      features.push({ type: ActivityType.Playing, name: 'Headless Console Control' });
    }

    const connectActivity = _buildConnectActivity();
    if (connectActivity) features.push(connectActivity);

    return _uniqueActivities(features);
  }

  function _pickActivity(
    baseActivity: ActivityItem,
    extraActivities: ActivityItem[],
    now: number,
    forceRotate = false,
  ): ActivityItem {
    const extras = _uniqueActivities(extraActivities);
    if (extras.length === 0) {
      lastActivityKey = _activityKey(baseActivity);
      return baseActivity;
    }

    const pool = [baseActivity, ...extras, baseActivity];
    const canRotate = forceRotate || now - lastRotationAt >= rotationIntervalMs;

    if (!canRotate && _hasValue(lastActivityKey)) {
      const reused = pool.find((activity) => _activityKey(activity) === lastActivityKey);
      if (reused) return reused;
    }

    let chosen = pool[rotationIndex % pool.length] ?? baseActivity;
    rotationIndex += 1;
    lastRotationAt = now;

    if (pool.length > 1) {
      let guard = 0;
      while (_activityKey(chosen) === lastActivityKey && guard < pool.length) {
        chosen = pool[rotationIndex % pool.length] ?? baseActivity;
        rotationIndex += 1;
        guard += 1;
      }
    }

    lastActivityKey = _activityKey(chosen);
    return chosen;
  }

  function _presenceKey(status: string, activity: ActivityItem): string {
    return `${status}|${String(activity.type)}|${activity.name}`;
  }

  async function _refresh(forceRotate = false): Promise<void> {
    if (!client || !client.user) return;

    const now = getNow();
    let info: ServerInfo | null = null;
    let error: unknown = null;

    try {
      const result = await getServerInfoFn();
      if (result && typeof result === 'object') {
        info = result;
        lastInfo = result;
        lastInfoAt = now;
      }
    } catch (err) {
      error = err;
    }

    const effectiveInfo = info ?? (now - lastInfoAt <= staleInfoMs ? lastInfo : null);
    const usedCachedInfo = !info && !!effectiveInfo;
    const base = _buildBasePresence(effectiveInfo, error, now, usedCachedInfo);
    const features = _buildFeatureActivities();
    const world = _buildWorldActivities(effectiveInfo).slice(0, 2);
    const moduleSummary = _buildModuleSummaryActivity(getModuleStatus() ?? {});
    const extra = moduleSummary ? [moduleSummary, ...world, ...features] : [...world, ...features];

    let chosen = base.activity;
    if (base.mode === 'online') {
      chosen = _pickActivity(base.activity, extra, now, forceRotate);
    } else if (base.mode === 'degraded') {
      const degradedExtras = moduleSummary ? [moduleSummary] : [];
      chosen = _pickActivity(base.activity, degradedExtras, now, forceRotate);
    }

    const activity: ActivityItem = {
      type: chosen.type,
      name: _limitActivityName(chosen.name),
    };

    const presenceKey = _presenceKey(base.status, activity);
    if (presenceKey === lastPresenceKey) return;
    lastPresenceKey = presenceKey;

    client.user.setPresence({
      status: base.status,
      activities: [activity],
    });

    const { players } = _extractPlayers(effectiveInfo);
    if (players !== null) {
      lastPlayers = players;
    }
  }

  async function refreshNow(forceRotate = false): Promise<void> {
    if (inFlight) return inFlight;

    inFlight = _refresh(forceRotate).finally(() => {
      inFlight = null;
    });

    return inFlight;
  }

  function start(): void {
    if (timer) return;
    refreshNow().catch(() => {});
    timer = setInterval(() => {
      refreshNow().catch(() => {});
    }, refreshMs);
  }

  function stop(): void {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  return {
    start,
    stop,
    refreshNow,
  };
}

export { createBotStatusManager };
export type { BotStatusManager, BotStatusManagerOptions };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _mod = module as { exports: any };

_mod.exports = { createBotStatusManager };

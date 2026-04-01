/**
 * Panel Diagnostics — live health probes, module status, and suggestions.
 *
 * Extracted from panel-channel.js. Runs connectivity probes (RCON, SFTP,
 * DB, Panel API, Save Service), verifies channel assignments, and builds
 * rich diagnostic embeds with smart suggestions for common issues.
 *
 * Usage:
 *   const { buildDiagnostics } = require('./panel-diagnostics');
 *   const embeds = await buildDiagnostics({ client, db, ... });
 */

'use strict';

const fs = require('fs');
const { EmbedBuilder } = require('discord.js');
const config = require('../config');
const panelApi = require('../server/panel-api');
const { t, getLocale, fmtNumber } = require('../i18n');

// ── Uptime formatter ────────────────────────────────────────

function _formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0 || days > 0) parts.push(`${hours}h`);
  parts.push(`${mins}m`);
  return parts.join(' ');
}

// ── Probes ──────────────────────────────────────────────────

/** Run RCON connectivity probe. */
async function _probeRcon(rcon) {
  if (!config.rconHost || !config.rconPassword) {
    return { status: 'unconfigured' };
  }
  const start = Date.now();
  try {
    const resp = await Promise.race([
      rcon.send('info'),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000)),
    ]);
    return { status: 'ok', latency: Date.now() - start, response: (resp || '').slice(0, 60) };
  } catch (err) {
    return {
      status: rcon.connected ? 'error' : 'disconnected',
      latency: Date.now() - start,
      error: err.message,
    };
  }
}

/** Run SFTP connectivity probe. */
async function _probeSftp(hasSftp) {
  if (!hasSftp) return { status: 'unconfigured' };

  const SftpClient = require('ssh2-sftp-client');
  const sftp = new SftpClient();
  const start = Date.now();
  try {
    const connectOpts = {
      host: config.sftpHost,
      port: config.sftpPort || 2022,
      username: config.sftpUser,
      password: config.sftpPassword,
      readyTimeout: 8000,
      retries: 0,
    };
    if (config.sftpPrivateKeyPath) {
      try {
        connectOpts.privateKey = fs.readFileSync(config.sftpPrivateKeyPath);
      } catch (err) {
        console.warn(
          `[DIAG] Could not read SSH key at ${config.sftpPrivateKeyPath}: ${err.message} — trying password auth`,
        );
      }
    }
    await sftp.connect(connectOpts);
    let hasSave = false;
    let hasLog = false;
    try {
      await sftp.stat(config.sftpSavePath);
      hasSave = true;
    } catch {
      /* missing */
    }
    try {
      await sftp.stat(config.sftpLogPath);
      hasLog = true;
    } catch {
      /* missing */
    }
    // Also check HZLogs/ directory (per-restart rotated logs, game update March 2026)
    if (!hasLog) {
      try {
        let serverRoot = (config.sftpLogPath || '').replace(/\/[^/]+$/, '') || '/HumanitZServer';
        if (serverRoot.endsWith('/Saved/Logs')) serverRoot = serverRoot.replace(/\/Saved\/Logs$/, '');
        await sftp.stat(serverRoot + '/HZLogs');
        hasLog = true;
      } catch {
        /* no HZLogs either */
      }
    }
    await sftp.end();
    return { status: 'ok', latency: Date.now() - start, hasSave, hasLog };
  } catch (err) {
    try {
      await sftp.end();
    } catch {
      /* ignore */
    }
    return { status: 'error', latency: Date.now() - start, error: err.message };
  }
}

/** Run database health probe. */
function _probeDb(db) {
  if (!db || !db.db) return { status: 'unavailable' };
  try {
    const integrity = db.db.pragma('integrity_check');
    const ok = integrity?.[0]?.integrity_check === 'ok';
    const totals = db.getServerTotals();
    const aliases = db.getAliasStats();
    const version = db.getMeta('schema_version');
    let fileSize = 0;
    try {
      fileSize = fs.statSync(db._dbPath).size;
    } catch {
      /* in-memory */
    }
    return {
      status: ok ? 'ok' : 'degraded',
      integrity: ok,
      version,
      players: totals?.total_players || 0,
      online: totals?.online_players || 0,
      totalKills: totals?.total_kills || 0,
      aliases: aliases?.totalAliases || 0,
      uniquePlayers: aliases?.uniquePlayers || 0,
      fileSize,
    };
  } catch (err) {
    return { status: 'error', error: err.message };
  }
}

/** Run Panel API probe. */
async function _probePanelApi() {
  if (!panelApi.available) return { status: 'unconfigured' };
  const start = Date.now();
  try {
    const res = await Promise.race([
      panelApi.getResources(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000)),
    ]);
    return { status: 'ok', latency: Date.now() - start, state: res?.state || 'unknown' };
  } catch (err) {
    return { status: 'error', latency: Date.now() - start, error: err.message };
  }
}

/** Verify channel assignments. */
async function _probeChannels(client) {
  const defs = [
    { name: 'Admin', key: 'adminChannelId' },
    { name: 'Chat', key: 'chatChannelId' },
    { name: 'Server Status', key: 'serverStatusChannelId' },
    { name: 'Log (threads)', key: 'logChannelId' },
    { name: 'Activity Log', key: 'activityLogChannelId' },
    { name: 'Player Stats', key: 'playerStatsChannelId' },
    { name: 'Panel', key: 'panelChannelId' },
  ];
  const results = [];
  for (const { name, key } of defs) {
    const id = config[key];
    if (!id) {
      results.push({ name, status: 'not set' });
      continue;
    }
    try {
      const ch = await client.channels.fetch(id);
      results.push({ name, status: 'ok', channelName: ch?.name || id });
    } catch {
      results.push({ name, status: 'error', id });
    }
  }
  return results;
}

/** Get save service status. */
function _probeSaveService(saveService) {
  if (!saveService) return null;
  const st = saveService.stats;
  return {
    status: st.lastError ? 'error' : st.syncCount > 0 ? 'ok' : 'waiting',
    syncCount: st.syncCount,
    lastMtime: st.lastMtime,
    lastError: st.lastError,
    mode: st.mode,
    syncing: st.syncing,
  };
}

// ── Embed builders ──────────────────────────────────────────

/** Build connectivity status lines from probe results. */
function _buildConnectivityLines(results) {
  const lines = [];

  // RCON
  if (results.rcon.status === 'ok') {
    lines.push(`🟢 **RCON** — ${results.rcon.latency}ms · \`${results.rcon.response}\``);
  } else if (results.rcon.status === 'disconnected') {
    lines.push(`🔴 **RCON** — Disconnected (${results.rcon.error})`);
  } else if (results.rcon.status === 'error') {
    lines.push(`🟡 **RCON** — Error: ${results.rcon.error} (${results.rcon.latency}ms)`);
  } else {
    lines.push('⚫ **RCON** — Not configured');
  }

  // SFTP
  if (results.sftp.status === 'ok') {
    const extras = [];
    const missing = [];
    if (results.sftp.hasSave) extras.push('save ✓');
    else missing.push('save');
    if (results.sftp.hasLog) extras.push('log ✓');
    else missing.push('log');
    let line = `🟢 **SFTP** — ${results.sftp.latency}ms`;
    if (extras.length > 0) line += ` · ${extras.join(', ')}`;
    if (missing.length > 0) line += ` · ⚠️ **Missing:** ${missing.join(', ')}`;
    lines.push(line);
  } else if (results.sftp.status === 'error') {
    lines.push(`🔴 **SFTP** — ${results.sftp.error} (${results.sftp.latency}ms)`);
  } else {
    lines.push('⚫ **SFTP** — Not configured');
  }

  // Panel API
  if (results.panel.status === 'ok') {
    lines.push(`🟢 **Panel API** — ${results.panel.latency}ms · Server: ${results.panel.state}`);
  } else if (results.panel.status === 'error') {
    lines.push(`🔴 **Panel API** — ${results.panel.error} (${results.panel.latency}ms)`);
  } else {
    lines.push('⚫ **Panel API** — Not configured');
  }

  // Database
  if (results.db.status === 'ok') {
    const sizeMB = (results.db.fileSize / 1024 / 1024).toFixed(1);
    lines.push(
      `🟢 **Database** — v${results.db.version} · ${results.db.players} players · ${results.db.aliases} aliases · ${sizeMB} MB`,
    );
  } else if (results.db.status === 'degraded') {
    lines.push('🟡 **Database** — Integrity check failed');
  } else if (results.db.status === 'error') {
    lines.push(`🔴 **Database** — ${results.db.error}`);
  } else {
    lines.push('⚫ **Database** — Not initialised');
  }

  // Save service
  if (results.save) {
    if (results.save.status === 'ok') {
      const ago = results.save.lastMtime
        ? _formatUptime(Date.now() - new Date(results.save.lastMtime).getTime()) + ' ago'
        : 'unknown';
      lines.push(`🟢 **Save Service** — ${results.save.syncCount} syncs · Last: ${ago} · Mode: ${results.save.mode}`);
    } else if (results.save.status === 'error') {
      lines.push(`🔴 **Save Service** — ${results.save.lastError}`);
    } else {
      lines.push('🟡 **Save Service** — Waiting for first sync');
    }
  }

  return lines;
}

/** Build module status lines from moduleStatus map. */
function _buildModuleLines(moduleStatus, logWatcher) {
  const lines = [];
  for (const [name, status] of Object.entries(moduleStatus)) {
    const icon = status.startsWith('🟢') ? '🟢' : status.startsWith('⚫') ? '⚫' : '🟡';
    const detail = status.replace(/^(?:🟢|⚫|🟡)\s*/u, '');
    if (icon === '🟢') {
      lines.push(`${icon} **${name}** — ${detail}`);
    } else if (icon === '⚫') {
      lines.push(`${icon} **${name}** — Disabled in config`);
    } else {
      const reason = detail
        .replace(/^Skipped\s*/, '')
        .replace(/^\(/, '')
        .replace(/\)$/, '');
      lines.push(`${icon} **${name}** — ${reason || 'Skipped'}`);
    }
  }
  // Enrich with live data where available
  if (logWatcher) {
    const lwActive = !!logWatcher.interval;
    const lwInit = logWatcher.initialised;
    if (lwActive && !lwInit) {
      lines.push("-# Log Watcher is polling but hasn't received data yet");
    }
  }
  return lines;
}

/** Generate smart suggestions based on probe results. */
function _buildSuggestions(results, moduleStatus, saveResult) {
  const tips = [];
  const skippedModules = Object.entries(moduleStatus).filter(([, s]) => s.startsWith('🟡'));
  const disabledModules = Object.entries(moduleStatus).filter(([, s]) => s.startsWith('⚫'));

  // RCON issues
  if (results.rcon.status === 'disconnected') {
    tips.push(
      '🔌 **RCON disconnected** — The bot auto-reconnects every 15 seconds. ' +
        'If your game server restarted (e.g. Bisect 8h schedule), just wait for it to finish booting. ' +
        'The bot will automatically reconnect — no manual action needed. ' +
        'Chat relay and server status will resume once RCON is back.',
    );
  } else if (results.rcon.status === 'error') {
    tips.push(
      "⚠️ **RCON issues** — Connected but commands are failing. Check that `RCON_HOST`, `RCON_PORT`, and `RCON_PASSWORD` match your server's RCON settings.",
    );
  } else if (results.rcon.status === 'ok' && results.rcon.latency > 2000) {
    tips.push(
      '🐢 **RCON slow** — Response took ' +
        results.rcon.latency +
        'ms. ' +
        'This may cause delayed chat relay and status updates. ' +
        'Check server load or network latency to the game server.',
    );
  }

  // SFTP issues
  if (results.sftp.status === 'error') {
    tips.push(
      '🔴 **SFTP connection failed** — `' +
        results.sftp.error +
        '`. ' +
        'Verify `SFTP_HOST`, `SFTP_PORT`, `SFTP_USER`, `SFTP_PASSWORD` are correct. ' +
        'Common causes: wrong port (game SFTP is usually 2022), firewall blocking, incorrect credentials.',
    );
  } else if (results.sftp.status === 'ok' && !results.sftp.hasSave) {
    tips.push(
      '📁 **Save file not found** — SFTP connected but `SFTP_SAVE_PATH` does not exist on the server. ' +
        'Check that `SFTP_SAVE_PATH` points to the correct `.sav` file (default: `/HumanitZServer/Saved/SaveGames/SaveList/Default/Save_DedicatedSaveMP.sav`).',
    );
  } else if (results.sftp.status === 'ok' && !results.sftp.hasLog) {
    tips.push(
      '📁 **Log file not found** — `SFTP_LOG_PATH` does not exist on the server. ' +
        'Log Watcher needs this file. Set `SFTP_LOG_PATH` in `.env` to the full path of `HMZLog.log` on your server ' +
        "(e.g. `/home/steam/hzserver/serverfiles/HumanitZServer/HMZLog.log`). If you're unsure, run `npm run setup` to auto-discover.",
    );
  } else if (results.sftp.status === 'unconfigured' && skippedModules.some(([n]) => /log|save|stats|pvp/i.test(n))) {
    tips.push(
      '📡 **No SFTP configured** — Several modules need SFTP to read server files. ' +
        'Set `SFTP_HOST`, `SFTP_USER`, and `SFTP_PASSWORD` to enable log watching, player stats, and save syncing. ' +
        'The bot will work for chat relay and server status without SFTP, but advanced features require it.',
    );
  }

  // Save issues
  if (saveResult?.status === 'error') {
    tips.push('💾 **Save sync error** — `' + saveResult.lastError + '`. Check SFTP/agent configuration.');
  } else if (saveResult?.status === 'waiting') {
    tips.push(
      '💾 **Save service waiting** — No sync has completed yet. This is normal on fresh startup; data will appear after the first poll cycle.',
    );
  }

  // DB issues
  if (results.db.status === 'degraded') {
    tips.push(
      '🗄️ **DB integrity issue** — The database failed SQLite integrity_check. Consider using "Factory Reset" to rebuild.',
    );
  }
  if (results.db.status === 'ok' && results.db.players === 0 && saveResult?.syncCount > 0) {
    tips.push(
      '🗄️ **DB empty despite save syncs** — Save data was synced but no players in DB. The save file may be empty or corrupted.',
    );
  }

  // Panel API
  if (results.panel.status === 'error') {
    tips.push('🎛️ **Panel API error** — `' + results.panel.error + '`. Verify `PANEL_SERVER_URL` and `PANEL_API_KEY`.');
  }

  // Channel issues
  const brokenChannels = results.channels.filter((c) => c.status === 'error');
  if (brokenChannels.length > 0) {
    tips.push(
      '📺 **Invalid channel ID(s):** ' +
        brokenChannels.map((c) => c.name).join(', ') +
        '. ' +
        'The channel may have been deleted or the bot lacks access. Update in the Channels config category.',
    );
  }

  // Missing channel suggestions for skipped modules
  const missingChannels = skippedModules.filter(([, s]) => /CHANNEL_ID/i.test(s));
  if (missingChannels.length > 0) {
    const names = missingChannels.map(([n]) => n).join(', ');
    tips.push(
      '📺 **Missing channel IDs for:** ' +
        names +
        '. ' +
        'Set the corresponding channel IDs in the Channels config above to activate these modules.',
    );
  }

  // Data staleness
  if (results.db.status === 'ok' && results.db.players > 0 && results.psCount === 0) {
    tips.push(
      '📊 **Log stats empty** — DB has players but log-based stats (deaths, builds, loots) are empty. Enable Log Watcher with SFTP to track player activity.',
    );
  }
  if (results.db.status === 'ok' && results.db.players > 0 && results.ptCount === 0) {
    tips.push(
      '⏱️ **No playtime data** — Enable playtime tracking (`ENABLE_PLAYTIME=true`) and ensure RCON is connected to track player sessions.',
    );
  }

  // Disabled module suggestions
  if (disabledModules.length > 0) {
    const names = disabledModules.map(([n]) => n).join(', ');
    tips.push('⚫ **Disabled modules:** ' + names + '. These can be enabled via `ENABLE_*=true` in config if needed.');
  }

  // All-good
  if (tips.length === 0) {
    tips.push('✅ All systems operational — no issues detected.');
  }

  return tips;
}

// ── Main entry point ────────────────────────────────────────

/**
 * Run all diagnostics probes and build embed(s).
 *
 * @param {object} ctx
 * @param {import('discord.js').Client} ctx.client       - Discord client (for channel verification)
 * @param {object}  ctx.db              - HumanitZDB instance
 * @param {object}  ctx.saveService     - SaveService instance (optional)
 * @param {object}  ctx.logWatcher      - LogWatcher instance (optional)
 * @param {object}  ctx.moduleStatus    - { moduleName: statusString } map
 * @param {Date}    ctx.startedAt       - Bot startup timestamp
 * @param {boolean} ctx.hasSftp         - Whether SFTP credentials are configured
 * @returns {Promise<EmbedBuilder[]>}
 */
async function buildDiagnostics({ client, db, saveService, logWatcher, moduleStatus, startedAt, hasSftp }) {
  const locale = getLocale({ serverConfig: config });
  const rcon = require('../rcon/rcon');
  const playerStats = require('../tracking/player-stats');
  const playtime = require('../tracking/playtime-tracker');
  const upMs = Date.now() - startedAt.getTime();

  // ── Run probes in parallel ──
  const [rconResult, sftpResult, panelResult] = await Promise.allSettled([
    _probeRcon(rcon),
    _probeSftp(hasSftp),
    _probePanelApi(),
  ]);

  const results = {
    rcon: rconResult.value || { status: 'error', error: 'probe failed' },
    sftp: sftpResult.value || { status: 'error', error: 'probe failed' },
    db: _probeDb(db),
    panel: panelResult.value || { status: 'error', error: 'probe failed' },
    save: _probeSaveService(saveService),
    channels: await _probeChannels(client),
  };

  // Stats counts for suggestion logic
  const psCount = playerStats._data ? Object.keys(playerStats._data.players || {}).length : 0;
  const ptCount = playtime._data ? Object.keys(playtime._data.players || {}).length : 0;
  const ptActive = playtime._activeSessions?.size || 0;
  results.psCount = psCount;
  results.ptCount = ptCount;

  // ── Build lines ──
  const connLines = _buildConnectivityLines(results);
  const moduleLines = _buildModuleLines(moduleStatus, logWatcher);
  const tips = _buildSuggestions(results, moduleStatus, results.save);

  const chLines = results.channels.map((ch) => {
    if (ch.status === 'ok') return `🟢 ${ch.name} → #${ch.channelName}`;
    if (ch.status === 'not set') return `⚫ ${ch.name} — not configured`;
    return `🔴 ${ch.name} — channel ${ch.id} not found or inaccessible`;
  });

  const dataLines = [];
  if (results.db.status === 'ok' && results.db.players > 0) {
    dataLines.push(
      `👥 **${fmtNumber(results.db.players, locale)}** players in database (${fmtNumber(results.db.online, locale)} online)`,
    );
    dataLines.push(`🪦 **${fmtNumber(results.db.totalKills || 0, locale)}** lifetime kills tracked`);
  }
  if (psCount > 0) dataLines.push(`📊 **${fmtNumber(psCount, locale)}** players in log stats`);
  if (ptCount > 0)
    dataLines.push(
      `⏱️ **${fmtNumber(ptCount, locale)}** players with playtime (${fmtNumber(ptActive, locale)} active session${ptActive !== 1 ? 's' : ''})`,
    );
  if (dataLines.length === 0) dataLines.push('No player data loaded yet');

  // ── Build embeds ──
  const skippedModules = Object.entries(moduleStatus).filter(([, s]) => s.startsWith('🟡'));
  const embed = new EmbedBuilder()
    .setTitle(t('discord:panel_diagnostics.title', locale))
    .setColor(
      results.rcon.status === 'disconnected' || results.sftp.status === 'error' || results.db.status === 'error'
        ? 0xe74c3c
        : skippedModules.length > 0
          ? 0xf1c40f
          : 0x2ecc71,
    )
    .setDescription(
      t('discord:panel_diagnostics.uptime_modules', locale, {
        uptime: `**${_formatUptime(upMs)}**`,
        count: `**${fmtNumber(Object.keys(moduleStatus).length, locale)}**`,
      }),
    )
    .addFields(
      { name: `🔌 ${t('discord:panel_diagnostics.live_connectivity', locale)}`, value: connLines.join('\n') },
      {
        name: `📺 ${t('discord:panel_diagnostics.channels', locale)}`,
        value: chLines.join('\n') || t('discord:panel_diagnostics.none_configured', locale),
      },
      {
        name: `📦 ${t('discord:panel_diagnostics.modules', locale)}`,
        value: moduleLines.join('\n') || t('discord:panel_diagnostics.none_registered', locale),
      },
    )
    .setTimestamp()
    .setFooter({ text: t('discord:panel_diagnostics.visible_to_you', locale) });

  if (dataLines.length > 0) {
    embed.addFields({ name: `📈 ${t('discord:panel_diagnostics.data_summary', locale)}`, value: dataLines.join('\n') });
  }

  const tipsText = tips.join('\n\n');
  const embeds = [embed];
  if (tipsText.length > 0) {
    if (tipsText.length <= 1024) {
      embed.addFields({ name: `💡 ${t('discord:panel_diagnostics.suggestions_guidance', locale)}`, value: tipsText });
    } else {
      const tipsEmbed = new EmbedBuilder()
        .setTitle(`💡 ${t('discord:panel_diagnostics.suggestions_guidance', locale)}`)
        .setColor(0xf1c40f)
        .setDescription(tipsText.slice(0, 4096));
      embeds.push(tipsEmbed);
    }
  }

  return embeds;
}

module.exports = { buildDiagnostics };

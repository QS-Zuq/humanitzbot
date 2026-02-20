const { EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder } = require('discord.js');
const SftpClient = require('ssh2-sftp-client');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const playtime = require('./playtime-tracker');
const playerStats = require('./player-stats');
const { parseSave, parseClanData } = require('./save-parser');

const DATA_DIR = path.join(__dirname, '..', 'data');
const KILL_FILE = path.join(DATA_DIR, 'kill-tracker.json');

/**
 * PlayerStatsChannel — posts a persistent embed in a dedicated #player-stats
 * channel with a dropdown to view comprehensive per-player statistics.
 *
 * Periodically downloads and parses the server save file via SFTP to extract
 * kill stats, vitals, inventory, recipes, and more. Merges these with the
 * log-based stats (deaths, damage, builds, raids, looting, connections).
 */

class PlayerStatsChannel {
  constructor(client, logWatcher) {
    this.client = client;
    this._logWatcher = logWatcher || null; // for posting kill feed to activity thread
    this.channel = null;
    this.statusMessage = null; // the single embed we keep editing
    this.saveInterval = null;
    this._saveData = new Map(); // steamId -> save data
    this._clanData = [];           // array of { name, members: [{ name, steamId, rank }] }
    this._lastSaveUpdate = null;
    this._embedInterval = null;
    // Kill tracker: { players: { steamId: { cumulative: {...}, lastSnapshot: {...} } } }
    this._killData = { players: {} };
    this._killDirty = false;
  }

  async start() {
    if (!config.playerStatsChannelId) {
      console.log('[PLAYER STATS CH] No PLAYER_STATS_CHANNEL_ID set, skipping.');
      return;
    }

    try {
      this.channel = await this.client.channels.fetch(config.playerStatsChannelId);
      if (!this.channel) {
        console.error('[PLAYER STATS CH] Channel not found! Check PLAYER_STATS_CHANNEL_ID.');
        return;
      }
    } catch (err) {
      console.error('[PLAYER STATS CH] Failed to fetch channel:', err.message);
      return;
    }

    console.log(`[PLAYER STATS CH] Posting in #${this.channel.name}`);

    // Load persistent kill tracker
    this._loadKillData();

    // Clean old bot messages
    await this._cleanOldMessages();

    // Post the initial embed
    const embed = this._buildOverviewEmbed();
    const components = [...this._buildPlayerRow(), ...this._buildClanRow()];
    this.statusMessage = await this.channel.send({
      embeds: [embed],
      ...(components.length > 0 && { components }),
    });

    // Do initial save parse
    await this._pollSave();

    // Update the embed after initial parse
    await this._updateEmbed();

    // Start save poll loop (5 min default)
    const pollMs = Math.max(config.savePollInterval || 300000, 60000);
    this.saveInterval = setInterval(() => this._pollSave().then(() => this._updateEmbed()), pollMs);
    console.log(`[PLAYER STATS CH] Save poll every ${pollMs / 1000}s`);

    // Update embed every 60s (for playtime changes etc.)
    this._embedInterval = setInterval(() => this._updateEmbed(), 60000);
  }

  stop() {
    if (this.saveInterval) { clearInterval(this.saveInterval); this.saveInterval = null; }
    if (this._embedInterval) { clearInterval(this._embedInterval); this._embedInterval = null; }
    this._saveKillData();
  }

  /** Download and parse the server save file via SFTP */
  async _pollSave() {
    if (!config.ftpHost || config.ftpHost.startsWith('PASTE_')) return;

    const sftp = new SftpClient();
    try {
      await sftp.connect({
        host: config.ftpHost,
        port: config.ftpPort,
        username: config.ftpUser,
        password: config.ftpPassword,
      });

      const buf = await sftp.get(config.ftpSavePath);
      const players = parseSave(buf);
      this._saveData = players;
      this._lastSaveUpdate = new Date();
      console.log(`[PLAYER STATS CH] Parsed save: ${players.size} players (${(buf.length / 1024 / 1024).toFixed(1)}MB)`);

      // Accumulate lifetime stats across deaths (kills + survival)
      this._accumulateStats();

      // Parse clan data (separate small file)
      try {
        const clanPath = config.ftpSavePath.replace(/SaveList\/.*$/, 'Save_ClanData.sav');
        const clanBuf = await sftp.get(clanPath);
        this._clanData = parseClanData(clanBuf);
        console.log(`[PLAYER STATS CH] Parsed clans: ${this._clanData.length} clans`);
      } catch (err) {
        if (!err.message.includes('No such file')) {
          console.error('[PLAYER STATS CH] Clan data error:', err.message);
        }
      }
    } catch (err) {
      console.error('[PLAYER STATS CH] Save poll error:', err.message);
    } finally {
      await sftp.end().catch(() => {});
    }
  }

  /** Update the persistent embed and dropdown */
  async _updateEmbed() {
    if (!this.statusMessage) return;
    try {
      const embed = this._buildOverviewEmbed();
      const components = [...this._buildPlayerRow(), ...this._buildClanRow()];
      await this.statusMessage.edit({
        embeds: [embed],
        ...(components.length > 0 && { components }),
      });
    } catch (err) {
      console.error('[PLAYER STATS CH] Embed update error:', err.message);
    }
  }

  /** Delete old bot messages to keep the channel clean */
  async _cleanOldMessages() {
    try {
      const messages = await this.channel.messages.fetch({ limit: 20 });
      const botMessages = messages.filter(m => m.author.id === this.client.user.id);
      for (const [, msg] of botMessages) {
        try { await msg.delete(); } catch (_) {}
      }
    } catch (err) {
      console.log('[PLAYER STATS CH] Could not clean old messages:', err.message);
    }
  }

  // ── Lifetime Stat Tracker (accumulates across deaths) ─────

  static KILL_KEYS = ['zeeksKilled', 'headshots', 'meleeKills', 'gunKills', 'blastKills', 'fistKills', 'takedownKills', 'vehicleKills'];
  static SURVIVAL_KEYS = ['daysSurvived'];

  _loadKillData() {
    try {
      if (fs.existsSync(KILL_FILE)) {
        this._killData = JSON.parse(fs.readFileSync(KILL_FILE, 'utf8'));
        const count = Object.keys(this._killData.players).length;
        console.log(`[STAT TRACKER] Loaded ${count} player(s) from kill-tracker.json`);
        // Migrate old records: add survival fields if missing
        for (const record of Object.values(this._killData.players)) {
          if (!record.survivalCumulative) record.survivalCumulative = PlayerStatsChannel._emptyObj(PlayerStatsChannel.SURVIVAL_KEYS);
          if (!record.survivalSnapshot) record.survivalSnapshot = PlayerStatsChannel._emptyObj(PlayerStatsChannel.SURVIVAL_KEYS);
        }
      }
    } catch (err) {
      console.error('[STAT TRACKER] Failed to load, starting fresh:', err.message);
      this._killData = { players: {} };
    }
  }

  _saveKillData() {
    if (!this._killDirty) return;
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(KILL_FILE, JSON.stringify(this._killData, null, 2), 'utf8');
      this._killDirty = false;
    } catch (err) {
      console.error('[STAT TRACKER] Failed to save:', err.message);
    }
  }

  /** Make a zero-valued object for the given key set */
  static _emptyObj(keys) {
    const obj = {};
    for (const k of keys) obj[k] = 0;
    return obj;
  }

  /** Legacy alias */
  static _emptyKills() { return PlayerStatsChannel._emptyObj(PlayerStatsChannel.KILL_KEYS); }

  /**
   * Extract current kill values from save data.
   * When ExtendedStats is available, save fields already contain lifetime values
   * (ExtendedStats overwrites per-life GameStats values in the save parser).
   */
  static _snapshotKills(save) {
    const obj = {};
    for (const k of PlayerStatsChannel.KILL_KEYS) obj[k] = save[k] || 0;
    return obj;
  }

  /** Extract current survival values from save data */
  static _snapshotSurvival(save) {
    const obj = {};
    for (const k of PlayerStatsChannel.SURVIVAL_KEYS) obj[k] = save[k] || 0;
    return obj;
  }

  /**
   * On each save poll, compare current save kills to last snapshot.
   * If current < last for the main kill stat (zeeksKilled), the player died
   * and the game reset their stats — bank the last snapshot into cumulative.
   */
  _accumulateStats() {
    const killDeltas = [];    // per-player kill deltas for the kill feed
    const survivalDeltas = []; // per-player survival deltas for the survival feed

    for (const [id, save] of this._saveData) {
      const currentKills = PlayerStatsChannel._snapshotKills(save);
      const currentSurvival = PlayerStatsChannel._snapshotSurvival(save);

      if (!this._killData.players[id]) {
        // First time seeing this player — initialise both trackers
        this._killData.players[id] = {
          cumulative: PlayerStatsChannel._emptyKills(),
          lastSnapshot: currentKills,
          survivalCumulative: PlayerStatsChannel._emptyObj(PlayerStatsChannel.SURVIVAL_KEYS),
          survivalSnapshot: currentSurvival,
          hasExtendedStats: !!save.hasExtendedStats,
        };
        this._killDirty = true;
        continue;
      }

      const record = this._killData.players[id];
      const lastKills = record.lastSnapshot;
      const lastSurvival = record.survivalSnapshot || PlayerStatsChannel._emptyObj(PlayerStatsChannel.SURVIVAL_KEYS);
      const playerName = save.playerName || playtime.getPlaytime(id)?.name || playerStats.getNameForId(id);

      // ExtendedStats values are already lifetime cumulative — skip death detection
      if (save.hasExtendedStats) {
        record.hasExtendedStats = true;
        // Clear stale cumulative data (ExtendedStats replaces the banking system)
        if (record.cumulative.zeeksKilled > 0 || record.survivalCumulative?.daysSurvived > 0) {
          console.log(`[STAT TRACKER] ${id}: ExtendedStats available — clearing banked cumulative`);
          record.cumulative = PlayerStatsChannel._emptyKills();
          record.survivalCumulative = PlayerStatsChannel._emptyObj(PlayerStatsChannel.SURVIVAL_KEYS);
        }
      } else {
        // Legacy fallback: detect death reset (main kill count dropped)
        const deathReset = currentKills.zeeksKilled < lastKills.zeeksKilled;
        if (deathReset) {
          for (const k of PlayerStatsChannel.KILL_KEYS) {
            record.cumulative[k] += lastKills[k];
          }
          if (!record.survivalCumulative) record.survivalCumulative = PlayerStatsChannel._emptyObj(PlayerStatsChannel.SURVIVAL_KEYS);
          for (const k of PlayerStatsChannel.SURVIVAL_KEYS) {
            record.survivalCumulative[k] += lastSurvival[k];
          }
          console.log(`[STAT TRACKER] ${id}: death detected — banked ${lastKills.zeeksKilled} kills, ${lastSurvival.daysSurvived} days`);
          record.lastSnapshot = currentKills;
          record.survivalSnapshot = currentSurvival;
          this._killDirty = true;
          continue;
        }
      }

      // Compute kill deltas since last poll
      const killDelta = {};
      let hasKills = false;
      for (const k of PlayerStatsChannel.KILL_KEYS) {
        const diff = currentKills[k] - lastKills[k];
        if (diff > 0) { killDelta[k] = diff; hasKills = true; }
      }
      if (hasKills) {
        killDeltas.push({ steamId: id, name: playerName, delta: killDelta });
      }

      // Compute survival deltas since last poll
      const survDelta = {};
      let hasSurv = false;
      for (const k of PlayerStatsChannel.SURVIVAL_KEYS) {
        const diff = currentSurvival[k] - lastSurvival[k];
        if (diff > 0) { survDelta[k] = diff; hasSurv = true; }
      }
      if (hasSurv) {
        survivalDeltas.push({ steamId: id, name: playerName, delta: survDelta });
      }

      record.lastSnapshot = currentKills;
      record.survivalSnapshot = currentSurvival;
      this._killDirty = true;
    }

    this._saveKillData();

    // Post kill feed to activity thread if enabled
    if (killDeltas.length > 0 && config.enableKillFeed && this._logWatcher) {
      this._postKillFeed(killDeltas);
    }
    // Post survival feed to activity thread if enabled
    if (survivalDeltas.length > 0 && config.enableKillFeed && this._logWatcher) {
      this._postSurvivalFeed(survivalDeltas);
    }
  }

  /**
   * Post a batched kill feed embed to the log watcher's daily activity thread.
   * Groups all player kill deltas from this save poll into a single embed.
   */
  async _postKillFeed(deltas) {
    const lines = deltas.map(({ name, delta }) => {
      const total = delta.zeeksKilled || 0;
      const parts = [];
      if (delta.headshots)     parts.push(`${delta.headshots} headshot${delta.headshots > 1 ? 's' : ''}`);
      if (delta.meleeKills)    parts.push(`${delta.meleeKills} melee`);
      if (delta.gunKills)      parts.push(`${delta.gunKills} gun`);
      if (delta.blastKills)    parts.push(`${delta.blastKills} blast`);
      if (delta.fistKills)     parts.push(`${delta.fistKills} fist`);
      if (delta.takedownKills) parts.push(`${delta.takedownKills} takedown`);
      if (delta.vehicleKills)  parts.push(`${delta.vehicleKills} vehicle`);
      const detail = parts.length > 0 ? ` (${parts.join(', ')})` : '';
      return `**${name}** killed **${total} zeek${total !== 1 ? 's' : ''}**${detail}`;
    });

    const embed = new EmbedBuilder()
      .setAuthor({ name: '🧟 Kill Activity' })
      .setDescription(lines.join('\n'))
      .setColor(0x1abc9c)
      .setTimestamp();

    try {
      await this._logWatcher.sendToThread(embed);
    } catch (err) {
      console.error('[KILL FEED] Failed to post to activity thread:', err.message);
    }
  }

  /**
   * Post a batched survival feed embed to the log watcher's daily activity thread.
   */
  async _postSurvivalFeed(deltas) {
    const lines = deltas.map(({ name, delta }) => {
      const parts = [];
      if (delta.daysSurvived)  parts.push(`+${delta.daysSurvived} day${delta.daysSurvived > 1 ? 's' : ''} survived`);
      return `**${name}** — ${parts.join(', ')}`;
    });

    const embed = new EmbedBuilder()
      .setAuthor({ name: '🏕️ Survival Activity' })
      .setDescription(lines.join('\n'))
      .setColor(0x2ecc71)
      .setTimestamp();

    try {
      await this._logWatcher.sendToThread(embed);
    } catch (err) {
      console.error('[SURVIVAL FEED] Failed to post to activity thread:', err.message);
    }
  }

  /**
   * Get all-time kill stats for a player (cumulative + current life).
   * Returns null if no data.
   */
  getAllTimeKills(steamId) {
    const record = this._killData.players[steamId];
    const save = this._saveData.get(steamId);
    if (!record && !save) return null;

    const allTime = PlayerStatsChannel._emptyKills();

    // ExtendedStats lifetime values (persist across deaths)
    if (save?.hasExtendedStats) {
      allTime.zeeksKilled    = save.lifetimeKills        || 0;
      allTime.headshots      = save.lifetimeHeadshots    || 0;
      allTime.meleeKills     = save.lifetimeMeleeKills   || 0;
      allTime.gunKills       = save.lifetimeGunKills     || 0;
      allTime.blastKills     = save.lifetimeBlastKills   || 0;
      allTime.fistKills      = save.lifetimeFistKills    || 0;
      allTime.takedownKills  = save.lifetimeTakedownKills || 0;
      allTime.vehicleKills   = save.lifetimeVehicleKills || 0;
      return allTime;
    }

    // Fallback: cumulative (banked from deaths) + current save
    if (record) {
      for (const k of PlayerStatsChannel.KILL_KEYS) {
        allTime[k] += record.cumulative[k];
      }
    }
    if (save) {
      for (const k of PlayerStatsChannel.KILL_KEYS) {
        allTime[k] += (save[k] || 0);
      }
    }
    return allTime;
  }

  /**
   * Get all-time survival stats for a player (cumulative + current life).
   * Returns null if no data.
   */
  getAllTimeSurvival(steamId) {
    const record = this._killData.players[steamId];
    const save = this._saveData.get(steamId);
    if (!record && !save) return null;

    const allTime = PlayerStatsChannel._emptyObj(PlayerStatsChannel.SURVIVAL_KEYS);

    // ExtendedStats lifetime values (persist across deaths)
    if (save?.hasExtendedStats) {
      allTime.daysSurvived = save.lifetimeDaysSurvived || save.daysSurvived || 0;
      return allTime;
    }

    // Fallback: cumulative (banked from deaths) + current save
    if (record?.survivalCumulative) {
      for (const k of PlayerStatsChannel.SURVIVAL_KEYS) {
        allTime[k] += record.survivalCumulative[k];
      }
    }
    if (save) {
      for (const k of PlayerStatsChannel.SURVIVAL_KEYS) {
        allTime[k] += (save[k] || 0);
      }
    }
    return allTime;
  }

  /** Build the overview embed showing server-wide stats and leaderboards */
  _buildOverviewEmbed() {
    const embed = new EmbedBuilder()
      .setTitle('Player Statistics')
      .setColor(0x9b59b6)
      .setTimestamp()
      .setFooter({ text: 'Select a player below for full stats · Last updated' });

    // ── Merge all player data ──
    const allLog = playerStats.getAllPlayers();
    const allPlaytime = playtime.getLeaderboard();

    // Build merged roster
    const roster = new Map();
    for (const p of allLog) {
      roster.set(p.id, { name: p.name, log: p });
    }
    for (const p of allPlaytime) {
      if (!roster.has(p.id)) roster.set(p.id, { name: p.name });
      else roster.get(p.id).name = p.name; // playtime name is usually most current
    }
    for (const [id, save] of this._saveData) {
      if (!roster.has(id)) {
        // Resolve name from all available sources instead of falling back to raw SteamID
        const resolvedName = playerStats.getNameForId(id);
        roster.set(id, { name: resolvedName });
      }
      const entry = roster.get(id);
      entry.save = save;
      // If the entry name is still a raw SteamID, try to resolve it
      if (/^\d{17}$/.test(entry.name)) {
        const resolvedName = playerStats.getNameForId(id);
        if (resolvedName !== id) entry.name = resolvedName;
      }
    }

    const playerCount = roster.size;

    // Combined set of all known player IDs (save file + kill tracker)
    const allTrackedIds = new Set([
      ...this._saveData.keys(),
      ...Object.keys(this._killData.players || {}),
    ]);

    // ── Kill Leaderboard (all-time) ──
    if (allTrackedIds.size > 0) {
      const killers = [...allTrackedIds]
        .map(id => {
          const at = this.getAllTimeKills(id);
          return { id, name: roster.get(id)?.name || id, kills: at?.zeeksKilled || 0 };
        })
        .filter(e => e.kills > 0)
        .sort((a, b) => b.kills - a.kills);

      if (killers.length > 0) {
        const medals = ['🥇', '🥈', '🥉'];
        const lines = killers.slice(0, 5).map((e, i) => {
          const medal = medals[i] || `\`${i + 1}.\``;
          const at = this.getAllTimeKills(e.id);
          const life = this._saveData.get(e.id)?.zeeksKilled || 0;
          const detail = [];
          if (at.headshots > 0) detail.push(`${at.headshots} HS`);
          if (at.meleeKills > 0) detail.push(`${at.meleeKills} melee`);
          if (at.gunKills > 0) detail.push(`${at.gunKills} gun`);
          const extra = detail.length > 0 ? ` (${detail.join(', ')})` : '';
          const lifeNote = life !== e.kills ? ` [${life} this life]` : '';
          return `${medal} **${e.name}** — ${e.kills} kills${extra}${lifeNote}`;
        });
        embed.addFields({ name: 'Top Killers (All Time)', value: lines.join('\n') });
      }

      // Server totals (all-time)
      let totalKills = 0, totalHS = 0, totalMelee = 0, totalGun = 0;
      let totalDays = 0;
      for (const id of allTrackedIds) {
        const at = this.getAllTimeKills(id);
        if (at) {
          totalKills += at.zeeksKilled;
          totalHS += at.headshots;
          totalMelee += at.meleeKills;
          totalGun += at.gunKills;
        }
        const atSurv = this.getAllTimeSurvival(id);
        if (atSurv) {
          totalDays += atSurv.daysSurvived;
        }
      }
      const killParts = [
        `Total Kills: **${totalKills}**`,
        `Headshots: **${totalHS}**`,
        `Melee: **${totalMelee}**`,
      ];
      if (totalGun > 0) killParts.push(`Gun: **${totalGun}**`);
      embed.addFields({ name: `Kill Stats (${allTrackedIds.size} players)`, value: killParts.join('\n') });

      // Survival server totals
      const survParts = [`Days Survived: **${totalDays}**`];
      embed.addFields({ name: 'Survival Stats (All Time)', value: survParts.join('\n') });
    }

    // ── Top Playtime ──
    const leaderboard = playtime.getLeaderboard();
    if (leaderboard.length > 0) {
      const medals = ['🥇', '🥈', '🥉'];
      const top5 = leaderboard.slice(0, 5).map((entry, i) => {
        const medal = medals[i] || `\`${i + 1}.\``;
        return `${medal} **${entry.name}** — ${entry.totalFormatted}`;
      });
      embed.addFields({ name: 'Top Playtime', value: top5.join('\n') });
    }

    // ── Activity Stats (from logs) ──
    if (allLog.length > 0) {
      const totalDeaths = allLog.reduce((s, p) => s + p.deaths, 0);
      const totalBuilds = allLog.reduce((s, p) => s + p.builds, 0);
      const totalLoots = allLog.reduce((s, p) => s + p.containersLooted, 0);
      const totalDmg = allLog.reduce((s, p) => s + Object.values(p.damageTaken).reduce((a, b) => a + b, 0), 0);
      const totalPvpKills = allLog.reduce((s, p) => s + (p.pvpKills || 0), 0);
      const parts = [
        `Deaths: **${totalDeaths}**`,
        `Builds: **${totalBuilds}**`,
        `Looted: **${totalLoots}**`,
        `Hits Taken: **${totalDmg}**`,
      ];
      if (totalPvpKills > 0) parts.push(`PvP Kills: **${totalPvpKills}**`);
      if (config.showRaidStats) {
        const totalRaids = allLog.reduce((s, p) => s + p.raidsOut, 0);
        parts.push(`Raids: **${totalRaids}**`);
      }
      embed.addFields({ name: 'Log Activity', value: parts.join('\n') });
    }

    // ── Last 10 PvP Kills ──
    if (config.showPvpKills && this._logWatcher) {
      const recentKills = this._logWatcher.getPvpKills(10);
      if (recentKills.length > 0) {
        const killLines = recentKills.slice().reverse().map((k, i) => {
          const ts = new Date(k.timestamp);
          const timeStr = ts.toLocaleDateString('en-GB', { timeZone: config.botTimezone, day: 'numeric', month: 'short' }) +
            ' ' + ts.toLocaleTimeString('en-GB', { timeZone: config.botTimezone, hour: '2-digit', minute: '2-digit' });
          return `\`${i + 1}.\` **${k.killer}** ⚔️ **${k.victim}** — ${timeStr}`;
        });
        embed.addFields({ name: 'Last 10 PvP Kills', value: killLines.join('\n') });
      }
    }

    // ── Survival Leaderboard (all-time from tracker) ──
    if (allTrackedIds.size > 0) {
      const survivors = [...allTrackedIds]
        .map(id => {
          const atSurv = this.getAllTimeSurvival(id);
          return { id, name: roster.get(id)?.name || id, days: atSurv?.daysSurvived || 0 };
        })
        .filter(e => e.days > 0)
        .sort((a, b) => b.days - a.days);

      if (survivors.length > 0) {
        const medals = ['🥇', '🥈', '🥉'];
        const lines = survivors.slice(0, 5).map((e, i) => {
          const medal = medals[i] || `\`${i + 1}.\``;
          return `${medal} **${e.name}** — ${e.days} days`;
        });
        embed.addFields({ name: 'Longest Survivors (All Time)', value: lines.join('\n') });
      }



    }

    // ── Server Info ──
    const peaks = playtime.getPeaks();
    const trackingSince = new Date(playtime.getTrackingSince()).toLocaleDateString('en-GB');

    embed.addFields(
      { name: "Today's Peak", value: `${peaks.todayPeak}`, inline: true },
      { name: 'All-Time Peak', value: `${peaks.allTimePeak}`, inline: true },
      { name: 'Total Players', value: `${playerCount}`, inline: true },
    );

    const updateNote = this._lastSaveUpdate
      ? `Save data: ${this._lastSaveUpdate.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`
      : 'Save data: loading...';
    embed.setFooter({ text: `${updateNote} · Tracking since ${trackingSince} · Last updated` });

    return embed;
  }

  /** Build the select-menu row listing all tracked players */
  _buildPlayerRow() {
    const merged = new Map();

    // Add from player-stats
    for (const p of playerStats.getAllPlayers()) {
      const at = this.getAllTimeKills(p.id);
      const atSurv = this.getAllTimeSurvival(p.id);
      merged.set(p.id, {
        name: p.name,
        kills: at?.zeeksKilled || 0,
        deaths: p.deaths,
        days: atSurv?.daysSurvived || 0,
      });
    }

    // Add from playtime
    for (const p of playtime.getLeaderboard()) {
      if (!merged.has(p.id)) {
        const at = this.getAllTimeKills(p.id);
        const atSurv = this.getAllTimeSurvival(p.id);
        merged.set(p.id, {
          name: p.name,
          kills: at?.zeeksKilled || 0,
          deaths: 0,
          days: atSurv?.daysSurvived || 0,
        });
      }
    }

    // Add from save data (catch players only in save)
    for (const [id, save] of this._saveData) {
      if (!merged.has(id)) {
        const at = this.getAllTimeKills(id);
        const atSurv = this.getAllTimeSurvival(id);
        const resolvedName = playerStats.getNameForId(id);
        merged.set(id, {
          name: resolvedName,
          kills: at?.zeeksKilled || save.zeeksKilled,
          deaths: 0,
          days: atSurv?.daysSurvived || save.daysSurvived,
        });
      }
    }

    if (merged.size === 0) return [];

    // Sort by kills desc, then days, then name
    const sorted = [...merged.entries()].sort((a, b) => {
      if (b[1].kills !== a[1].kills) return b[1].kills - a[1].kills;
      if (b[1].days !== a[1].days) return b[1].days - a[1].days;
      return a[1].name.localeCompare(b[1].name);
    });

    const options = sorted.slice(0, 25).map(([id, p]) => ({
      label: p.name.substring(0, 100),
      description: `Kills: ${p.kills} | Deaths: ${p.deaths} | Days: ${p.days}`,
      value: id,
    }));

    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId('playerstats_player_select')
      .setPlaceholder('Select a player to view full stats...')
      .addOptions(options);

    return [new ActionRowBuilder().addComponents(selectMenu)];
  }

  /** Build the select-menu row listing all clans */
  _buildClanRow() {
    if (this._clanData.length === 0) return [];

    const options = this._clanData.map(clan => {
      // Aggregate kills and days for the description
      let totalKills = 0, totalDays = 0;
      for (const m of clan.members) {
        const at = this.getAllTimeKills(m.steamId);
        const atSurv = this.getAllTimeSurvival(m.steamId);
        totalKills += at?.zeeksKilled || 0;
        totalDays += atSurv?.daysSurvived || 0;
      }
      return {
        label: clan.name.substring(0, 100),
        description: `${clan.members.length} members · ${totalKills} kills · ${totalDays} days`,
        value: `clan:${clan.name}`,
      };
    });

    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId('playerstats_clan_select')
      .setPlaceholder('Select a clan to view group stats...')
      .addOptions(options.slice(0, 25));

    return [new ActionRowBuilder().addComponents(selectMenu)];
  }

  /**
   * Build a comprehensive embed for a clan showing aggregated stats + member breakdown.
   */
  buildClanEmbed(clanName) {
    const clan = this._clanData.find(c => c.name === clanName);
    if (!clan) {
      return new EmbedBuilder()
        .setDescription('Clan not found.')
        .setColor(0xe74c3c);
    }

    const embed = new EmbedBuilder()
      .setTitle(`${clan.name}`)
      .setColor(0xe67e22)
      .setTimestamp();

    // ── Aggregate stats from save data (all-time) ──
    let totalKills = 0, totalHS = 0, totalMelee = 0, totalGun = 0;
    let totalDays = 0;
    let membersWithSave = 0;

    for (const m of clan.members) {
      const at = this.getAllTimeKills(m.steamId);
      const atSurv = this.getAllTimeSurvival(m.steamId);
      if (at) {
        membersWithSave++;
        totalKills += at.zeeksKilled;
        totalHS += at.headshots;
        totalMelee += at.meleeKills;
        totalGun += at.gunKills;
      } else {
        const save = this._saveData.get(m.steamId);
        if (save) {
          membersWithSave++;
          totalKills += save.zeeksKilled;
          totalHS += save.headshots;
          totalMelee += save.meleeKills;
          totalGun += save.gunKills;
        }
      }
      if (atSurv) {
        totalDays += atSurv.daysSurvived;
      } else {
        const save = this._saveData.get(m.steamId);
        if (save) {
          totalDays += save.daysSurvived;
        }
      }
    }

    // ── Aggregate stats from logs ──
    let totalDeaths = 0, totalBuilds = 0, totalLoots = 0, totalDmg = 0;
    let totalRaidsOut = 0, totalRaidsIn = 0;
    let totalPlaytimeMs = 0;

    for (const m of clan.members) {
      const log = playerStats.getStats(m.steamId);
      if (log) {
        totalDeaths += log.deaths;
        totalBuilds += log.builds;
        totalLoots += log.containersLooted;
        totalDmg += Object.values(log.damageTaken).reduce((a, b) => a + b, 0);
        totalRaidsOut += log.raidsOut;
        totalRaidsIn += log.raidsIn;
      }
      const pt = playtime.getPlaytime(m.steamId);
      if (pt) totalPlaytimeMs += pt.totalMs;
    }

    // ── Overview line ──
    const ptHours = Math.floor(totalPlaytimeMs / 3600000);
    const ptMins = Math.floor((totalPlaytimeMs % 3600000) / 60000);
    const ptStr = ptHours > 0 ? `${ptHours}h ${ptMins}m` : `${ptMins}m`;
    embed.setDescription(`**${clan.members.length}** members · **${ptStr}** combined playtime`);

    // ── Kill Stats ──
    if (totalKills > 0) {
      const parts = [`Total: **${totalKills}**`];
      if (totalHS > 0) parts.push(`Headshots: **${totalHS}**`);
      if (totalMelee > 0) parts.push(`Melee: **${totalMelee}**`);
      if (totalGun > 0) parts.push(`Gun: **${totalGun}**`);
      embed.addFields({ name: 'Kill Stats', value: parts.join('\n') });
    }

    // ── Survival ──
    const survParts = [];
    if (totalDays > 0) survParts.push(`Days Survived: **${totalDays}**`);
    if (totalDeaths > 0) survParts.push(`Deaths: **${totalDeaths}**`);
    if (survParts.length > 0) {
      embed.addFields({ name: 'Survival', value: survParts.join('\n') });
    }

    // ── Activity ──
    const actParts = [];
    if (totalBuilds > 0) actParts.push(`Builds: **${totalBuilds}**`);
    if (totalLoots > 0) actParts.push(`Looted: **${totalLoots}**`);
    if (totalDmg > 0) actParts.push(`Hits Taken: **${totalDmg}**`);
    if (config.showRaidStats) {
      if (totalRaidsOut > 0) actParts.push(`Raids Out: **${totalRaidsOut}**`);
      if (totalRaidsIn > 0) actParts.push(`Raided: **${totalRaidsIn}**`);
    }
    if (actParts.length > 0) {
      embed.addFields({ name: 'Activity', value: actParts.join('\n') });
    }

    // ── Member List with individual stats ──
    const memberLines = clan.members.map(m => {
      const save = this._saveData.get(m.steamId);
      const at = this.getAllTimeKills(m.steamId);
      const pt = playtime.getPlaytime(m.steamId);
      const log = playerStats.getStats(m.steamId);

      const displayName = m.name;

      const parts = [];
      const kills = at?.zeeksKilled || save?.zeeksKilled || 0;
      if (kills > 0) parts.push(`${kills} kills`);
      const atSurv = this.getAllTimeSurvival(m.steamId);
      const days = atSurv?.daysSurvived || save?.daysSurvived || 0;
      if (days > 0) parts.push(`${days}d`);
      if (log && log.deaths > 0) parts.push(`${log.deaths} deaths`);
      if (pt) parts.push(pt.totalFormatted);

      const rankIcon = m.rank === 'Leader' ? '[Leader] ' : '';
      const stats = parts.length > 0 ? ` — ${parts.join(' · ')}` : '';
      return `${rankIcon}**${displayName}**${stats}`;
    });

    embed.addFields({ name: 'Members', value: memberLines.join('\n') || 'No members' });

    return embed;
  }

  /**
   * Build the full detailed embed for a single player.
   * Merges log stats + save data + playtime into one comprehensive view.
   */
  buildFullPlayerEmbed(steamId, { isAdmin = false } = {}) {
    const logData = playerStats.getStats(steamId);
    const saveData = this._saveData.get(steamId);
    const pt = playtime.getPlaytime(steamId);

    const name = logData?.name || pt?.name || steamId;
    const embed = new EmbedBuilder()
      .setTitle(name)
      .setColor(0x9b59b6)
      .setTimestamp();

    // ── Character Info ──
    const charParts = [];
    if (saveData) {
      charParts.push(saveData.male ? '♂ Male' : '♀ Female');
      if (saveData.startingPerk && saveData.startingPerk !== 'Unknown') {
        charParts.push(`Perk: ${saveData.startingPerk}`);
      }
    }
    if (pt) {
      charParts.push(`Playtime: ${pt.totalFormatted}`);
      charParts.push(`Sessions: ${pt.sessions}`);
    }
    if (charParts.length > 0) {
      embed.addFields({ name: 'Character', value: charParts.join('  ·  ') });
    }

    // ── Name History ──
    if (logData?.nameHistory && logData.nameHistory.length > 0) {
      const oldNames = logData.nameHistory.map(h => h.name).join(', ');
      embed.addFields({ name: 'Previous Names', value: oldNames });
    }

    // ── Kill Stats ──
    if (saveData) {
      const at = this.getAllTimeKills(steamId);

      // Current life kills
      const lifeLines = [];
      if (saveData.zeeksKilled > 0) lifeLines.push(`Zombie Kills: **${saveData.zeeksKilled}**`);
      if (saveData.headshots > 0) lifeLines.push(`Headshots: **${saveData.headshots}**`);
      if (saveData.meleeKills > 0) lifeLines.push(`Melee: **${saveData.meleeKills}**`);
      if (saveData.gunKills > 0) lifeLines.push(`Gun: **${saveData.gunKills}**`);
      if (saveData.blastKills > 0) lifeLines.push(`Blast: **${saveData.blastKills}**`);
      if (saveData.fistKills > 0) lifeLines.push(`Fist: **${saveData.fistKills}**`);
      if (saveData.takedownKills > 0) lifeLines.push(`Takedowns: **${saveData.takedownKills}**`);
      if (saveData.vehicleKills > 0) lifeLines.push(`Vehicle: **${saveData.vehicleKills}**`);

      if (lifeLines.length > 0) {
        embed.addFields({ name: 'Kills (This Life)', value: lifeLines.join('\n') });
      } else {
        embed.addFields({ name: 'Kills (This Life)', value: 'No kills yet' });
      }

      // All-time kills (always shown)
      const atLines = [];
      if (at) {
        if (at.zeeksKilled > 0) atLines.push(`Zombie Kills: **${at.zeeksKilled}**`);
        if (at.headshots > 0) atLines.push(`Headshots: **${at.headshots}**`);
        if (at.meleeKills > 0) atLines.push(`Melee: **${at.meleeKills}**`);
        if (at.gunKills > 0) atLines.push(`Gun: **${at.gunKills}**`);
        if (at.blastKills > 0) atLines.push(`Blast: **${at.blastKills}**`);
        if (at.fistKills > 0) atLines.push(`Fist: **${at.fistKills}**`);
        if (at.takedownKills > 0) atLines.push(`Takedowns: **${at.takedownKills}**`);
        if (at.vehicleKills > 0) atLines.push(`Vehicle: **${at.vehicleKills}**`);
      }
      embed.addFields({ name: 'Kills (All Time)', value: atLines.length > 0 ? atLines.join('\n') : 'Tracking started — accumulates across deaths' });
    }

    // ── Survival Stats (This Life) ──
    const survivalParts = [];
    if (saveData) {
      if (saveData.daysSurvived > 0) survivalParts.push(`Days Survived: **${saveData.daysSurvived}**`);
    }
    if (logData) {
      survivalParts.push(`Deaths: **${logData.deaths}**`);
    }
    if (survivalParts.length > 0) {
      embed.addFields({ name: 'Survival (This Life)', value: survivalParts.join('\n') });
    }

    // ── PvP Stats ──
    if (logData && ((logData.pvpKills || 0) > 0 || (logData.pvpDeaths || 0) > 0)) {
      const pvpParts = [];
      if (logData.pvpKills > 0) pvpParts.push(`PvP Kills: **${logData.pvpKills}**`);
      if (logData.pvpDeaths > 0) pvpParts.push(`PvP Deaths: **${logData.pvpDeaths}**`);
      const kd = logData.pvpDeaths > 0 ? (logData.pvpKills / logData.pvpDeaths).toFixed(2) : logData.pvpKills > 0 ? '∞' : '0';
      pvpParts.push(`K/D: **${kd}**`);
      embed.addFields({ name: '⚔️ PvP', value: pvpParts.join('\n') });
    }

    // ── Survival Stats (All Time) ──
    if (saveData) {
      const atSurv = this.getAllTimeSurvival(steamId);
      if (atSurv) {
        const atParts = [];
        if (atSurv.daysSurvived > 0) atParts.push(`Days Survived: **${atSurv.daysSurvived}**`);
        if (logData) atParts.push(`Deaths: **${logData.deaths}**`);
        embed.addFields({ name: 'Survival (All Time)', value: atParts.length > 0 ? atParts.join('\n') : 'Tracking started — accumulates across deaths' });
      }
    }

    // ── Vitals (from save snapshot) ──
    if (config.showVitals && saveData) {
      const bar = (val) => {
        const pct = Math.max(0, Math.min(100, val));
        const filled = Math.round(pct / 10);
        return '█'.repeat(filled) + '░'.repeat(10 - filled) + ` ${Math.round(pct)}%`;
      };
      const vitals = [
        `Health    ${bar(saveData.health)}`,
        `Hunger    ${bar(saveData.hunger)}`,
        `Thirst    ${bar(saveData.thirst)}`,
        `Stamina   ${bar(saveData.stamina)}`,
        `Immunity  ${bar(saveData.infection)}`,
        `Battery   ${bar(saveData.battery)}`,
      ];
      embed.addFields({ name: 'Vitals', value: '```\n' + vitals.join('\n') + '\n```' });
    }

    // ── Status Effects ──
    if (config.showStatusEffects && saveData) {
      const statuses = [];
      if (saveData.playerStates?.length > 0) {
        for (const s of saveData.playerStates) {
          const clean = s.replace('States.Player.', '');
          statuses.push(clean);
        }
      }
      if (saveData.bodyConditions?.length > 0) {
        for (const s of saveData.bodyConditions) {
          const clean = s.replace('Attributes.Health.', '');
          statuses.push(clean);
        }
      }
      if (saveData.infectionBuildup > 0) statuses.push(`Infection: ${saveData.infectionBuildup}%`);
      if (saveData.fatigue > 0.5) statuses.push(`Fatigued`);

      if (statuses.length > 0) {
        embed.addFields({ name: 'Status Effects', value: statuses.join(', ') });
      }
    }

    // ── Combat Log Stats (damage taken from logs) ──
    if (logData) {
      const dmgEntries = Object.entries(logData.damageTaken);
      const dmgTotal = dmgEntries.reduce((s, [, c]) => s + c, 0);

      if (dmgTotal > 0) {
        const dmgSorted = dmgEntries.sort((a, b) => b[1] - a[1]);
        const dmgLines = dmgSorted.slice(0, 10).map(([src, count]) => `${src}: **${count}**`);
        embed.addFields({ name: `Damage Taken (${dmgTotal} hits)`, value: dmgLines.join('\n') });
      }
    }

    // ── Building Stats (from logs) ──
    if (logData && logData.builds > 0) {
      const buildEntries = Object.entries(logData.buildItems);
      if (buildEntries.length > 0) {
        const topBuilds = buildEntries.sort((a, b) => b[1] - a[1]).slice(0, 10);
        const buildLines = topBuilds.map(([item, count]) => `${item}: **${count}**`);
        const rows = [];
        for (let i = 0; i < buildLines.length; i += 3) {
          rows.push(buildLines.slice(i, i + 3).join('  ·  '));
        }
        let buildValue = rows.join('\n');
        if (buildEntries.length > 10) {
          buildValue += `\n_...and ${buildEntries.length - 10} more types_`;
        }
        embed.addFields({ name: `Building (${logData.builds} total)`, value: buildValue });
      }
    }

    // ── Raid Stats (from logs, if enabled) ──
    if (config.showRaidStats && logData) {
      const raidParts = [];
      if (logData.raidsOut > 0) raidParts.push(`Attacked: **${logData.raidsOut}**`);
      if (logData.destroyedOut > 0) raidParts.push(`Destroyed: **${logData.destroyedOut}**`);
      if (logData.raidsIn > 0) raidParts.push(`Raided: **${logData.raidsIn}**`);
      if (logData.destroyedIn > 0) raidParts.push(`Lost: **${logData.destroyedIn}**`);
      if (raidParts.length > 0) {
        embed.addFields({ name: 'Raid Stats', value: raidParts.join('\n') });
      }
    }

    // ── Looting (from logs) ──
    if (logData && logData.containersLooted > 0) {
      embed.addFields({ name: 'Containers Looted', value: `${logData.containersLooted}`, inline: true });
    }

    // ── Inventory (from save) ──
    if (config.showInventory && saveData) {
      const allItems = [
        ...saveData.inventory.map(i => ({ ...i, slot: 'inv' })),
        ...saveData.quickSlots.map(i => ({ ...i, slot: 'quick' })),
        ...saveData.equipment.map(i => ({ ...i, slot: 'equip' })),
      ].filter(i => i.item);

      if (allItems.length > 0) {
        const invLines = allItems.map(i => {
          const amt = i.amount > 1 ? ` x${i.amount}` : '';
          const dur = i.durability > 0 ? ` (${i.durability}%)` : '';
          const tag = i.slot === 'equip' ? ' [E]' : i.slot === 'quick' ? ' [Q]' : '';
          return `${_cleanItemName(i.item)}${amt}${dur}${tag}`;
        });
        embed.addFields({ name: 'Inventory', value: invLines.join('\n').substring(0, 1024) });
      }
    }

    // ── Recipes (from save) ──
    if (config.showRecipes && saveData) {
      const recipeParts = [];
      if (saveData.craftingRecipes.length > 0) {
        recipeParts.push(`Crafting: ${saveData.craftingRecipes.map(_cleanItemName).join(', ')}`);
      }
      if (saveData.buildingRecipes.length > 0) {
        recipeParts.push(`Building: ${saveData.buildingRecipes.map(_cleanItemName).join(', ')}`);
      }
      if (recipeParts.length > 0) {
        embed.addFields({ name: 'Recipes', value: recipeParts.join('\n').substring(0, 1024) });
      }
    }

    // ── Lore (from save) ──
    if (config.showLore && saveData && saveData.lore.length > 0) {
      embed.addFields({ name: 'Lore', value: `${saveData.lore.length} entries`, inline: true });
    }

    // ── Connections (from logs) ──
    if (config.showConnections && logData) {
      const connParts = [];
      if (logData.connects > 0) connParts.push(`Connects: **${logData.connects}**`);
      if (logData.disconnects > 0) connParts.push(`Disconnects: **${logData.disconnects}**`);
      if (logData.adminAccess > 0) connParts.push(`Admin Logins: **${logData.adminAccess}**`);
      if (connParts.length > 0) {
        embed.addFields({ name: 'Connections', value: connParts.join('\n') });
      }
    }

    // ── Last Activity ──
    if (logData?.lastEvent) {
      const lastDate = new Date(logData.lastEvent);
      const dateStr = `${lastDate.toLocaleDateString('en-GB')} ${lastDate.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
      embed.addFields({ name: 'Last Active', value: dateStr, inline: true });
    }

    // ── Anti-Cheat Flags (admin only) ──
    if (isAdmin && logData?.cheatFlags && logData.cheatFlags.length > 0) {
      const flagLines = logData.cheatFlags.slice(-5).map(f => {
        const d = new Date(f.timestamp);
        const dateStr = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
        return `${dateStr} — \`${f.type}\``;
      });
      if (logData.cheatFlags.length > 5) {
        flagLines.unshift(`_Showing last 5 of ${logData.cheatFlags.length} flags_`);
      }
      embed.addFields({ name: 'Anti-Cheat Flags', value: flagLines.join('\n') });
    }

    return embed;
  }

  /** Get the current save data map (for external access) */
  getSaveData() { return this._saveData; }

  /** Get the current clan data (for external access) */
  getClanData() { return this._clanData; }
}

/**
 * Clean UE4 item names into readable format.
 * e.g. "ChainlinkFenceElectrified" → "Chainlink Fence Electrified"
 */
function _cleanItemName(name) {
  if (!name) return '';
  return name
    .replace(/([a-z])([A-Z])/g, '$1 $2')           // camelCase → words
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')     // ABCDef → ABC Def
    .replace(/^BP_|_C$/g, '')                        // strip UE prefixes
    .replace(/_/g, ' ')
    .replace(/Lv(\d)/, 'Lvl $1')
    .trim();
}

module.exports = PlayerStatsChannel;

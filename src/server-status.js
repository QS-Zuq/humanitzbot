const { EmbedBuilder } = require('discord.js');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { getServerInfo, getPlayerList } = require('./server-info');
const playtime = require('./playtime-tracker');
const playerStats = require('./player-stats');

const SETTINGS_FILE = path.join(__dirname, '..', 'data', 'server-settings.json');

function _formatTime(timeStr) {
  if (!timeStr) return null;
  const match = timeStr.match(/^(\d{1,2}):(\d{1,2})$/);
  if (match) {
    return `${match[1]}:${match[2].padStart(2, '0')}`;
  }
  return timeStr;
}

class ServerStatus {
  constructor(client) {
    this.client = client;
    this.channel = null;
    this.statusMessage = null; // the single embed we keep editing
    this.interval = null;
    this.updateIntervalMs = parseInt(config.serverStatusInterval, 10) || 30000; // 30s default
  }

  async start() {
    console.log('[SERVER STATUS] Module starting...');
    console.log(`[SERVER STATUS] Channel ID from config: "${config.serverStatusChannelId}"`);
    try {
      if (!config.serverStatusChannelId) {
        console.log('[SERVER STATUS] No SERVER_STATUS_CHANNEL_ID set, skipping.');
        return;
      }

      console.log(`[SERVER STATUS] Fetching channel ${config.serverStatusChannelId}...`);
      this.channel = await this.client.channels.fetch(config.serverStatusChannelId);
      if (!this.channel) {
        console.error('[SERVER STATUS] Channel not found! Check SERVER_STATUS_CHANNEL_ID.');
        return;
      }

      console.log(`[SERVER STATUS] Posting live status in #${this.channel.name} (every ${this.updateIntervalMs / 1000}s)`);

      // Delete previous bot messages to keep the channel clean
      await this._cleanOldMessages();

      // Post the initial embed
      const embed = this._buildEmbed(null, null);
      this.statusMessage = await this.channel.send({ embeds: [embed] });

      // First real update
      await this._update();

      // Start the loop
      this.interval = setInterval(() => this._update(), this.updateIntervalMs);
    } catch (err) {
      console.error('[SERVER STATUS] Failed to start:', err.message);
      console.error('[SERVER STATUS] Full error:', err);
    }
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  async _cleanOldMessages() {
    try {
      const messages = await this.channel.messages.fetch({ limit: 20 });
      const botMessages = messages.filter(m => m.author.id === this.client.user.id && !m.hasThread);
      console.log(`[SERVER STATUS] Cleaning ${botMessages.size} old bot message(s)`);
      for (const [, msg] of botMessages) {
        try { await msg.delete(); } catch (_) {}
      }
    } catch (err) {
      console.log('[SERVER STATUS] Could not clean old messages:', err.message);
    }
  }

  async _update() {
    try {
      const [info, playerList] = await Promise.all([
        getServerInfo(),
        getPlayerList(),
      ]);

      const embed = this._buildEmbed(info, playerList);

      if (this.statusMessage) {
        try {
          await this.statusMessage.edit({ embeds: [embed] });
        } catch (editErr) {
          // Message was deleted — re-create it
          if (editErr.code === 10008 || editErr.message?.includes('Unknown Message')) {
            console.log('[SERVER STATUS] Status message was deleted, re-creating...');
            try {
              this.statusMessage = await this.channel.send({ embeds: [embed] });
            } catch (createErr) {
              console.error('[SERVER STATUS] Failed to re-create message:', createErr.message);
            }
          } else {
            throw editErr;
          }
        }
      }
    } catch (err) {
      if (!err.message.includes('RCON not connected')) {
        console.error('[SERVER STATUS] Update error:', err.message);
      }
    }
  }

  _loadServerSettings() {
    try {
      if (fs.existsSync(SETTINGS_FILE)) {
        return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
      }
    } catch (_) {}
    return {};
  }

  _buildEmbed(info, playerList) {
    const embed = new EmbedBuilder()
      .setTitle('HumanitZ Server Status')
      .setColor(0x2ecc71)
      .setTimestamp()
      .setFooter({ text: 'Last updated' });

    if (!info || !playerList) {
      embed.setDescription('Fetching server data...');
      return embed;
    }

    // Server name as description
    if (info.name) {
      embed.setDescription(`**${info.name}**`);
    }

    // ── World Info (inline row) ──
    let playerCount = '--';
    let playerBar = '';
    if (info.players != null) {
      const max = parseInt(info.maxPlayers, 10) || 0;
      const cur = parseInt(info.players, 10) || 0;
      playerCount = max ? `${cur} / ${max}` : `${cur}`;
      if (max > 0) playerBar = `\n${_progressBar(cur / max, 12)}`;
    } else {
      playerCount = `${playerList.count}`;
    }

    const time = _formatTime(info.time) || '--';
    const season = info.season || '--';
    const weather = info.weather || '--';

    // Load settings early so we can use DaysPerSeason for season progress
    const settings = (config.showServerSettings || config.showLootScarcity || config.showSeasonProgress)
      ? this._loadServerSettings() : {};

    embed.addFields(
      { name: 'Players Online', value: `${playerCount}${playerBar}`, inline: true },
      { name: 'Time', value: time, inline: true },
    );

    // Day number (from RCON info)
    if (config.showServerDay && info.day) {
      embed.addFields({ name: 'Day', value: info.day, inline: true });
    }

    // Season progress: compute day within current season
    let seasonDisplay = season;
    if (config.showSeasonProgress && info.day && settings.DaysPerSeason) {
      const day = parseInt(info.day, 10);
      const dps = parseInt(settings.DaysPerSeason, 10);
      if (day > 0 && dps > 0) {
        const dayInSeason = ((day - 1) % dps) + 1;
        seasonDisplay = `${season} (Day ${dayInSeason}/${dps})`;
      }
    }

    embed.addFields(
      { name: 'Season / Weather', value: `${seasonDisplay} · ${weather}`, inline: true },
    );

    // FPS + AI (from RCON info)
    if (config.showServerPerformance) {
      const perfParts = [];
      if (info.fps) perfParts.push(`FPS: **${info.fps}**`);
      if (info.ai) perfParts.push(`AI: **${info.ai}**`);
      if (perfParts.length > 0) {
        embed.addFields({ name: 'Performance', value: perfParts.join('  ·  '), inline: true });
      }
    }

    // Version (from RCON info)
    if (config.showServerVersion && info.version) {
      embed.addFields({ name: 'Version', value: info.version, inline: true });
    }

    // ── Online Players ──
    if (playerList.players && playerList.players.length > 0) {
      const names = playerList.players.map(p => p.name).join(', ');
      embed.addFields({ name: 'Online Now', value: names.substring(0, 1024) });
    } else {
      embed.addFields({ name: 'Online Now', value: '*No players online*' });
    }

    // ── Server Settings (from GameServerSettings.ini) ──

    if (config.showServerSettings && Object.keys(settings).length > 0) {
      const grid = _buildSettingsGrid(settings);
      if (grid) {
        embed.addFields({ name: 'Server Settings', value: '```\n' + grid + '\n```' });
      }
    }

    // ── Loot Scarcity ──
    if (config.showLootScarcity && Object.keys(settings).length > 0) {
      const lootLine = _buildLootScarcity(settings);
      if (lootLine) {
        embed.addFields({ name: 'Loot Scarcity', value: lootLine });
      }
    }

    // ── Weather Odds ──
    if (config.showWeatherOdds && Object.keys(settings).length > 0) {
      const weatherLine = _buildWeatherOdds(settings);
      if (weatherLine) {
        embed.addFields({ name: 'Weather Odds', value: weatherLine });
      }
    }

    // ── Top 3 Playtime ──
    const leaderboard = playtime.getLeaderboard();
    if (leaderboard.length > 0) {
      const medals = ['🥇', '🥈', '🥉'];
      const top3 = leaderboard.slice(0, 3).map((entry, i) => {
        return `${medals[i]} **${entry.name}** — ${entry.totalFormatted}`;
      });
      embed.addFields({ name: 'Top Playtime', value: top3.join('\n') });
    }

    // ── Player Activity Stats ──
    const allTracked = playerStats.getAllPlayers();
    if (allTracked.length > 0) {
      const totalDeaths = allTracked.reduce((s, p) => s + p.deaths, 0);
      const totalBuilds = allTracked.reduce((s, p) => s + p.builds, 0);
      const totalLoots = allTracked.reduce((s, p) => s + p.containersLooted, 0);
      const parts = [
        `Deaths: **${totalDeaths}**`,
        `Builds: **${totalBuilds}**`,
        `Looted: **${totalLoots}**`,
      ];
      if (config.showRaidStats) {
        const totalRaids = allTracked.reduce((s, p) => s + p.raidsOut, 0);
        parts.push(`Raids: **${totalRaids}**`);
      }
      embed.addFields({ name: `Activity (${allTracked.length} players)`, value: parts.join('  ·  ') });
    }

    // ── Server Statistics ──
    const peaks = playtime.getPeaks();
    const trackingSince = new Date(playtime.getTrackingSince()).toLocaleDateString('en-GB');
    const peakDate = peaks.allTimePeakDate
      ? ` (${new Date(peaks.allTimePeakDate).toLocaleDateString('en-GB')})`
      : '';

    embed.addFields(
      { name: "Today's Peak", value: `${peaks.todayPeak}`, inline: true },
      { name: 'All-Time Peak', value: `${peaks.allTimePeak}${peakDate}`, inline: true },
      { name: 'Unique Today / Total', value: `${peaks.uniqueToday} / ${peaks.totalUniquePlayers}`, inline: true },
    );

    embed.setFooter({ text: `Tracking since ${trackingSince} · Last updated` });

    return embed;
  }
}

// ── Visual helpers ──────────────────────────────────────────

/** Unicode progress bar (thin style). filled/total in 0-1 range. */
function _progressBar(ratio, width = 10) {
  const r = Math.max(0, Math.min(1, ratio));
  const filled = Math.round(r * width);
  return '▓'.repeat(filled) + '░'.repeat(width - filled);
}

// ── Server Settings helpers ─────────────────────────────────

const DIFFICULTY_LABELS = ['Very Easy', 'Easy', 'Default', 'Hard', 'Very Hard', 'Nightmare'];
const SCARCITY_LABELS = ['Scarce', 'Low', 'Default', 'Plentiful', 'Abundant'];
const ON_DEATH_LABELS = ['Backpack + Weapon', 'Pockets + Backpack', 'Everything'];
const VITAL_DRAIN_LABELS = ['Slow', 'Normal', 'Fast'];
const SPAWN_LABELS = ['Low', 'Medium', 'High'];

function _spawnLabel(val) {
  if (val === undefined || val === null) return null;
  const num = parseFloat(val);
  if (isNaN(num)) return val;
  // Standard values: 0=Low, 1=Medium, 2=High; custom multipliers shown as "x0.5" etc.
  if (num === 0) return 'Low';
  if (num === 1) return 'Medium';
  if (num === 2) return 'High';
  return `x${num}`;
}

/** Compact difficulty bar: index 0-5 → "▓░░░░ V.Easy" */
function _difficultyBar(val) {
  if (val === undefined || val === null) return null;
  const idx = Math.round(parseFloat(val));
  if (isNaN(idx)) return val;
  const label = DIFFICULTY_LABELS[idx] || val;
  const bar = _progressBar((idx + 1) / DIFFICULTY_LABELS.length, 5);
  return `${bar} ${label}`;
}

/** Plain difficulty label without bar: index 0-5 → "Default" */
function _difficultyLabel(val) {
  if (val === undefined || val === null) return null;
  const idx = Math.round(parseFloat(val));
  if (isNaN(idx)) return val;
  return DIFFICULTY_LABELS[idx] || val;
}

function _settingBool(val) {
  if (val === undefined || val === null) return null;
  return val === '1' || val.toLowerCase() === 'true' ? 'On' : 'Off';
}

function _settingLabel(val, labels) {
  if (val === undefined || val === null) return null;
  const num = parseFloat(val);
  if (isNaN(num)) return val;
  const idx = Math.round(num);
  return labels[idx] || val;
}

function _buildSettingsGrid(s) {
  const rows = [];
  const L = 18; // label column width

  function row(label, val) {
    if (val == null) return;
    rows.push(`${label.padEnd(L)} ${val}`);
  }
  function spacer() { rows.push(''); }

  // ── General ──
  row('PvP',             _settingBool(s.PVP));
  row('Max Players',     s.MaxPlayers);
  row('On Death',        _settingLabel(s.OnDeath, ON_DEATH_LABELS));
  row('Perma Death',     _settingLabel(s.PermaDeath, ['Off', 'Individual', 'All']));
  row('Vital Drain',     _settingLabel(s.VitalDrain, VITAL_DRAIN_LABELS));
  row('XP Multiplier',   s.XpMultiplier != null ? `${s.XpMultiplier}x` : null);

  // ── Time & Seasons ──
  spacer();
  row('Day Length',      s.DayDur != null ? `${s.DayDur} min` : null);
  row('Night Length',    s.NightDur != null ? `${s.NightDur} min` : null);
  row('Season Length',   s.DaysPerSeason != null ? `${s.DaysPerSeason} days` : null);
  row('Start Season',    _settingLabel(s.StartingSeason, ['Summer', 'Autumn', 'Winter', 'Spring']));

  // ── Zombies ──
  spacer();
  row('Zombie Health',   _difficultyLabel(s.ZombieDiffHealth));
  row('Zombie Speed',    _difficultyLabel(s.ZombieDiffSpeed));
  row('Zombie Damage',   _difficultyLabel(s.ZombieDiffDamage));
  row('Zombie Spawns',   _spawnLabel(s.ZombieAmountMulti));
  row('Zombie Respawn',  s.ZombieRespawnTimer != null ? `${s.ZombieRespawnTimer} min` : null);

  // ── Items & Building ──
  spacer();
  row('Weapon Break',    _settingBool(s.WeaponBreak));
  row('Food Decay',      _settingBool(s.FoodDecay));
  row('Loot Respawn',    s.LootRespawnTimer != null ? `${s.LootRespawnTimer} min` : null);
  row('Air Drops',       _settingBool(s.AirDrop));
  if (s.AirDrop === '1' || s.AirDrop === 'true') {
    row('  Interval',    s.AirDropInterval != null ? `Every ${s.AirDropInterval} day${s.AirDropInterval === '1' ? '' : 's'}` : null);
  }
  row('Dog Companion',   _settingBool(s.DogEnabled));

  // ── Extended settings (toggled) ──
  if (config.showExtendedSettings) {
    // Bandits
    spacer();
    row('Bandit Health',   _difficultyLabel(s.HumanHealth));
    row('Bandit Speed',    _difficultyLabel(s.HumanSpeed));
    row('Bandit Damage',   _difficultyLabel(s.HumanDamage));
    row('Bandit Spawns',   _spawnLabel(s.HumanAmountMulti));
    row('Bandit Respawn',  s.HumanRespawnTimer != null ? `${s.HumanRespawnTimer} min` : null);
    row('AI Events',       _settingLabel(s.AIEvent, ['Off', 'Low', 'Default']));

    // Companions
    spacer();
    row('Companion HP',    _settingLabel(s.CompanionHealth, ['Low', 'Default', 'High']));
    row('Companion Dmg',   _settingLabel(s.CompanionDmg, ['Low', 'Default', 'High']));

    // Building & Territory
    spacer();
    row('Building HP',     _settingLabel(s.BuildingHealth, VITAL_DRAIN_LABELS));
    row('Building Decay',  _settingBool(s.BuildingDecay));
    row('Territory',       _settingBool(s.Territory));
    row('Dismantle Own',   _settingBool(s.AllowDismantle));
    row('Dismantle House', _settingBool(s.AllowHouseDismantle));

    // Vehicles & Misc
    spacer();
    row('Max Cars',        s.MaxOwnedCars != null ? (s.MaxOwnedCars === '0' ? 'Disabled' : s.MaxOwnedCars) : null);
    row('Gen Fuel Rate',   s.GenFuel != null ? `${s.GenFuel}x` : null);
    row('Animal Spawns',   _spawnLabel(s.AnimalMulti));
    row('Animal Respawn',  s.AnimalRespawnTimer != null ? `${s.AnimalRespawnTimer} min` : null);
    row('Zombie Dogs',     _spawnLabel(s.ZombieDogMulti));
  }

  // Strip trailing empty lines
  while (rows.length > 0 && rows[rows.length - 1] === '') rows.pop();
  return rows.length > 0 ? rows.join('\n') : null;
}

function _buildLootScarcity(s) {
  const map = [
    ['🍖', 'Food',      s.RarityFood],
    ['🥤', 'Drink',     s.RarityDrink],
    ['🔪', 'Melee',     s.RarityMelee],
    ['🔫', 'Ranged',    s.RarityRanged],
    ['🛡️', 'Armor',     s.RarityArmor],
    ['🧱', 'Resources', s.RarityResources],
    ['🎯', 'Ammo',      s.RarityAmmo],
    ['📦', 'Other',     s.RarityOther],
  ];

  // Scarcity index: 0=Scarce → 4=Abundant (5 levels)
  const rows = map
    .filter(([, , val]) => val != null)
    .map(([emoji, label, val]) => {
      const idx = Math.round(parseFloat(val)) || 0;
      const name = SCARCITY_LABELS[idx] || val;
      return `${emoji} ${label.padEnd(10)} ${name}`;
    });

  return rows.length > 0 ? '```\n' + rows.join('\n') + '\n```' : null;
}

/** Build weather odds section (toggled) */
function _buildWeatherOdds(s) {
  const weatherKeys = [
    ['☀️', 'Clear Sky',    s.Weather_ClearSky],
    ['☁️', 'Cloudy',       s.Weather_Cloudy],
    ['🌫️', 'Foggy',        s.Weather_Foggy],
    ['🌦️', 'Light Rain',   s.Weather_LightRain],
    ['🌧️', 'Rain',         s.Weather_Rain],
    ['⛈️', 'Thunderstorm', s.Weather_Thunderstorm],
    ['🌨️', 'Light Snow',   s.Weather_LightSnow],
    ['❄️', 'Snow',         s.Weather_Snow],
    ['🌪️', 'Blizzard',     s.Weather_Blizzard],
  ];

  const rows = weatherKeys
    .filter(([, , val]) => val != null)
    .map(([emoji, label, val]) => {
      const num = parseFloat(val);
      const pct = isNaN(num) ? val : `${Math.round(num * 100)}%`;
      return `${emoji} ${label.padEnd(14)} ${pct}`;
    });

  return rows.length > 0 ? '```\n' + rows.join('\n') + '\n```' : null;
}

module.exports = ServerStatus;

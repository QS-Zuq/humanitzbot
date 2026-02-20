const { EmbedBuilder } = require('discord.js');
const playtime = require('./playtime-tracker');
const config = require('./config');

function buildPlayerEmbed(stats, { isAdmin = false } = {}) {
  const embed = new EmbedBuilder()
    .setTitle(stats.name)
    .setColor(0x9b59b6)
    .setTimestamp();

  // Get playtime data if available
  const pt = playtime.getPlaytime(stats.id);

  // ── General Info (inline row) ──
  const infoFields = [];
  if (pt) {
    infoFields.push({ name: 'Playtime', value: pt.totalFormatted, inline: true });
    infoFields.push({ name: 'Sessions', value: `${pt.sessions}`, inline: true });
  }
  if (stats.lastEvent) {
    const lastDate = new Date(stats.lastEvent);
    const dateStr = `${lastDate.toLocaleDateString('en-GB')} ${lastDate.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
    infoFields.push({ name: 'Last Active', value: dateStr, inline: true });
  }
  if (infoFields.length > 0) embed.addFields(...infoFields);

  if (stats.nameHistory && stats.nameHistory.length > 0) {
    embed.addFields({ name: 'Previous Names', value: stats.nameHistory.map(h => h.name).join(', ') });
  }

  // ── Combat Stats ──
  const dmgEntries = Object.entries(stats.damageTaken);
  const dmgTotal = dmgEntries.reduce((s, [, c]) => s + c, 0);

  embed.addFields(
    { name: 'Deaths', value: `${stats.deaths}`, inline: true },
    { name: 'Hits Taken', value: `${dmgTotal}`, inline: true },
    { name: '\u200b', value: '\u200b', inline: true },
  );

  if (dmgEntries.length > 0) {
    const dmgSorted = dmgEntries.sort((a, b) => b[1] - a[1]);
    const dmgLines = dmgSorted.slice(0, 8).map(([src, count]) => `${src}: **${count}**`);
    if (dmgEntries.length > 8) dmgLines.push(`_+${dmgEntries.length - 8} more_`);
    embed.addFields({ name: 'Damage Breakdown', value: dmgLines.join('\n') });
  }

  // ── Building Stats ──
  const buildEntries = Object.entries(stats.buildItems);
  if (buildEntries.length > 0) {
    const topBuilds = buildEntries.sort((a, b) => b[1] - a[1]).slice(0, 8);
    const buildLines = topBuilds.map(([item, count]) => `${item}: **${count}**`);
    if (buildEntries.length > 8) buildLines.push(`_+${buildEntries.length - 8} more_`);
    embed.addFields({ name: `Building (${stats.builds} total)`, value: buildLines.join('\n') });
  } else {
    embed.addFields({ name: 'Building', value: `${stats.builds} total`, inline: true });
  }

  // ── Raid Stats ──
  if (config.showRaidStats) {
    embed.addFields(
      { name: 'Attacked', value: `${stats.raidsOut}`, inline: true },
      { name: 'Destroyed', value: `${stats.destroyedOut}`, inline: true },
      { name: 'Your Structures Hit', value: `${stats.raidsIn}`, inline: true },
    );
  }

  // ── Looting ──
  if (stats.containersLooted > 0) {
    embed.addFields({ name: 'Containers Looted', value: `${stats.containersLooted}`, inline: true });
  }

  // ── Connections ──
  if (config.showConnections) {
    const connParts = [];
    if (stats.connects !== undefined) connParts.push(`In: **${stats.connects}**`);
    if (stats.disconnects !== undefined) connParts.push(`Out: **${stats.disconnects}**`);
    if (stats.adminAccess !== undefined && stats.adminAccess > 0) connParts.push(`Admin: **${stats.adminAccess}**`);
    if (connParts.length > 0) embed.addFields({ name: 'Connections', value: connParts.join('  ·  '), inline: true });
  }

  // ── Anti-Cheat Flags (admin only) ──
  if (isAdmin && stats.cheatFlags && stats.cheatFlags.length > 0) {
    const flagLines = stats.cheatFlags.slice(-5).map(f => {
      const d = new Date(f.timestamp);
      const dateStr = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
      return `${dateStr} — \`${f.type}\``;
    });
    if (stats.cheatFlags.length > 5) flagLines.unshift(`_Showing last 5 of ${stats.cheatFlags.length} flags_`);
    embed.addFields({ name: 'Anti-Cheat Flags', value: flagLines.join('\n') });
  }

  return embed;
}

module.exports = { buildPlayerEmbed };

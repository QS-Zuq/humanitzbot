# HumanitZ Discord Bot

A comprehensive Discord bot for HumanitZ dedicated servers. Connects via RCON for live server data, SFTP for log parsing and save file analysis, and provides a full dashboard experience with player stats, clan tracking, bidirectional chat, and more.

## See It Live

| | |
|---|---|
| **Server** | `[EU] Howyagarn Newbies - PVE - Low Zombies / Long Seasons` |
| **Direct Connect** | `66.248.194.203:9098` |
| **Discord** | [Discord.gg/Dp2M2CaQhj](https://discord.gg/Dp2M2CaQhj) |

> **[Full documentation available on the Wiki →](../../wiki)**

## Features

- **Live Server Status** — Voice channel dashboard + auto-updating text embed with player count, time, weather, leaderboards, and peak stats
- **Player Statistics** — Per-player stats from save file parsing (kills, vitals, inventory, recipes) merged with log data (deaths, damage, builds). Includes clan stats from in-game clan groups
- **Bidirectional Chat** — Discord ↔ in-game chat bridge with `!admin` alerts
- **Activity Logging** — Deaths, damage, building, looting, raids, connects/disconnects posted to daily threads via SFTP log parsing
- **PvP Scheduler** — Automatic PvP on/off at scheduled hours with countdown warnings and server restart via SFTP
- **Auto-Messages** — Welcome messages for new/returning players, periodic Discord link broadcasts
- **Bot Lifecycle** — Online/offline notification embeds in admin channel with active modules and uptime
- **Slash Commands** — `/server`, `/players`, `/playtime`, `/playerstats`, `/rcon`
- **Save File Parser** — Custom UE4 GVAS binary parser for kill stats, vitals, inventory, clan data, and more

## Quick Start

Requires **Node.js 18+**.

```bash
cp .env.example .env    # Configure your settings
npm install
npm start               # Slash commands register automatically
```

At minimum, configure in `.env`:
```env
DISCORD_TOKEN=your_bot_token
DISCORD_CLIENT_ID=your_client_id
DISCORD_GUILD_ID=your_guild_id
ADMIN_CHANNEL_ID=your_admin_channel_id
RCON_HOST=your_server_ip
RCON_PORT=27015
RCON_PASSWORD=your_rcon_password
```

See [`.env.example`](.env.example) for the full list of options.

## Documentation

Detailed guides are available on the **[Wiki](../../wiki)**:

- [Setup Guide](../../wiki/Setup-Guide) — Discord bot creation, RCON/SFTP configuration, all `.env` options
- [Features](../../wiki/Features) — Detailed breakdown of every module and how they work
- [Commands](../../wiki/Commands) — Slash commands and supported RCON commands
- [Architecture](../../wiki/Architecture) — Project structure, data flow, and module reference
- [Setup Utility](../../wiki/Setup-Utility) — First-run import, validation, and data recovery
- [Troubleshooting](../../wiki/Troubleshooting) — Common issues and solutions

## License

MIT

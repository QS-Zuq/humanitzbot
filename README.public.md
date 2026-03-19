<p align="center">
  <img src="src/web-map/public/favicon.svg" width="80" height="80" alt="HumanitZ Bot" />
</p>

<h1 align="center">HumanitZ Bot</h1>

<p align="center">
  Discord bot and web panel for HumanitZ dedicated servers.
  <br />
  Player stats, chat relay, live map, activity logging, and full server management.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-18%2B-339933?logo=nodedotjs&logoColor=white" alt="Node.js 18+" />
  <img src="https://img.shields.io/badge/discord.js-v14-5865F2?logo=discord&logoColor=white" alt="discord.js v14" />
  <img src="https://img.shields.io/badge/SQLite-better--sqlite3-003B57?logo=sqlite&logoColor=white" alt="SQLite" />
  <img src="https://img.shields.io/badge/Express-v5-000000?logo=express&logoColor=white" alt="Express v5" />
  <img src="https://img.shields.io/badge/License-MIT-green" alt="MIT License" />
  <img src="https://img.shields.io/badge/Tests-1426_passing-brightgreen" alt="Tests" />
</p>

<p align="center">
  Want to support the project?
  <br />
  <a href="https://buymeacoffee.com/qszuq">
    <img src="https://img.shields.io/badge/%E2%80%8B-Buy_Me_a_Coffee-FF6D00?logo=buymeacoffee&logoColor=white" alt="Buy Me a Coffee" />
  </a>
</p>

<p align="center">
  <a href="https://play.qs-zuq.com/"><strong>🌐 See it in action</strong></a> — public web panel on a live server (survivor permissions)
</p>

## What It Does

Connects to your HumanitZ game server via RCON and SFTP, tracks everything that happens, and presents it through Discord and an authenticated web panel.

| Capability            | How                                                                               |
| --------------------- | --------------------------------------------------------------------------------- |
| **Server Status**     | Auto-updating embed with player count, world state, settings, performance         |
| **Chat Relay**        | Bidirectional bridge between Discord and in-game chat                             |
| **Activity Feed**     | Kills, deaths, PvP, building, looting, raids — logged to DB and posted to Discord |
| **Player Stats**      | Per-player profiles with kills, inventory, skills, vitals, recipes, challenges    |
| **Save File Parsing** | Custom UE4 GVAS binary parser reads the save file for deep game state             |
| **Live Web Map**      | Interactive Leaflet map with player positions, structures, vehicles, containers   |
| **Web Panel**         | 13-tab admin dashboard with Discord OAuth, RBAC, and rate limiting                |
| **PvP Scheduler**     | Automated PvP windows with per-day overrides and server restarts                  |
| **Server Scheduler**  | Timed restarts with difficulty profiles                                           |
| **Multi-Server**      | Manage multiple game servers from one bot instance                                |
| **Milestones**        | Automatic kill, survival, and playtime milestone announcements                    |
| **Game Data**         | 718 items, 122 buildings, 154 recipes, 68 loot tables — all queryable             |

## Requirements

- **Node.js 18+** (22 recommended)
- A Discord bot token ([Developer Portal](https://discord.com/developers/applications))
- A HumanitZ dedicated server with RCON enabled

SFTP access is optional but required for save file parsing, player stats, activity logging, and the PvP scheduler.

## Quick Start

```bash
git clone https://github.com/QS-Zuq/humanitzbot.git
cd humanitzbot
npm install
```

Edit `.env` with your Discord token and bot IDs. RCON, SFTP, and other settings are configured via the Discord setup wizard on first boot. Then:

```bash
npm start
```

The bot will start in **setup wizard mode** if RCON isn't configured yet. An interactive Discord panel walks you through connecting RCON, SFTP, and assigning channels — no manual file editing required.

For full setup instructions, see the **[Wiki](https://github.com/QS-Zuq/humanitzbot/wiki)**.

## Configuration

Core credentials live in `.env`. All other settings are stored in the SQLite database and managed through the Discord Panel or Web Dashboard. The bot creates `.env` from `.env.example` on first run. Key sections:

| Section            | What                                      |
| ------------------ | ----------------------------------------- |
| **Discord**        | Bot token, client ID, guild ID (`.env`)   |
| **Web Panel**      | Port, Discord OAuth credentials (`.env`)  |
| **RCON**           | Configured via setup wizard, stored in DB |
| **SFTP**           | Configured via setup wizard, stored in DB |
| **Channels**       | Assigned via setup wizard, stored in DB   |
| **Module Toggles** | Managed via Panel/Dashboard, stored in DB |

Display settings (what shows on embeds) are configurable at runtime through the panel channel in Discord — no restart needed.

Full reference: [Configuration](https://github.com/QS-Zuq/humanitzbot/wiki/Configuration)

## Architecture

```
Game Server ──RCON──► Bot ──► SQLite DB ──► Discord Embeds
      │                │                       Web Panel
      └──SFTP──────────┘
```

**DB-first**: All events are written to SQLite before being rendered anywhere. The database is the source of truth. Discord embeds and the web panel read from the DB.

Five dependencies. No bloat.

| Package            | Purpose            |
| ------------------ | ------------------ |
| `discord.js`       | Discord API        |
| `better-sqlite3`   | SQLite database    |
| `express`          | Web panel server   |
| `ssh2-sftp-client` | SFTP file access   |
| `dotenv`           | Environment config |

## Web Panel

Browser-based admin dashboard at `http://your-server:port`. Discord OAuth with four access tiers:

| Tier         | Access                                              |
| ------------ | --------------------------------------------------- |
| **Public**   | Landing page with server status                     |
| **Survivor** | Dashboard, players, clans, activity, chat           |
| **Mod**      | Live map, timeline, kick, chat send                 |
| **Admin**    | Console, settings editor, controls, database, items |

Requires `DISCORD_OAUTH_SECRET` and `WEB_MAP_PORT` in `.env`.

## Commands

| Command        | Description                                          |
| -------------- | ---------------------------------------------------- |
| `/server`      | Server info, world state, difficulty schedule        |
| `/players`     | Online player list with playtime                     |
| `/playerstats` | Player activity stats with detailed profiles         |
| `/playtime`    | Playtime leaderboard or player lookup                |
| `/rcon`        | Raw RCON command (admin only)                        |
| `/qspanel`     | Server power controls, backups, console (admin only) |
| `/threads`     | Rebuild activity summary threads (admin only)        |

## Development

```bash
npm run dev         # Start with --watch (auto-restart on changes)
npm test            # Run all 1426 tests
npm run setup       # First-run import (SFTP auto-discovery + data import)
npm run build:css   # Build Tailwind CSS for web panel
```

## License

[MIT](LICENSE)

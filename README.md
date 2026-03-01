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
  <img src="https://img.shields.io/badge/Tests-767_passing-brightgreen" alt="Tests" />
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

<p align="center">
  <a href="#features">Features</a> · <a href="#quick-start">Quick Start</a> · <a href="#web-dashboard">Web Dashboard</a> · <a href="#slash-commands">Commands</a> · <a href="#multi-server">Multi-Server</a> · <a href="#contributing">Contributing</a>
</p>

---

## Features

### 🎮 Discord Integration

| Feature | Description |
|---------|-------------|
| **Server Status** | Live embed with player count, game day, season, server health, and system resources |
| **Player Stats** | Per-player kill stats, playtime, profession, lifetime records, and progression tracking |
| **Chat Relay** | Bidirectional chat bridge between Discord and in-game with rich formatting |
| **Activity Log** | Real-time feeds for connects, deaths, builds, looting, raids, PvP kills, and anti-cheat flags |
| **Kill Feed** | PvP kill attribution with damage tracking, death cause classification, and death loop detection |
| **Auto Messages** | Welcome messages, Discord link broadcasts, and SFTP-hosted welcome files with leaderboard templates |
| **Milestones** | Automatic announcements when players hit kill milestones |
| **Recaps** | Periodic server summary recaps with trending stats |
| **Daily Threads** | Auto-created daily threads for activity and chat — keeps channels clean |
| **Status Channels** | Voice channel names that display live player count, game day, and season |
| **Panel Channel** | Interactive bot control panel in Discord with buttons for settings, diagnostics, and server management |

### 🗺️ Web Dashboard

| Feature | Description |
|---------|-------------|
| **Interactive Map** | Leaflet-based world map with live player positions, structures, vehicles, containers, horses, dead bodies, and AI entities |
| **Timeline Playback** | Scrub through historical world snapshots — watch your server evolve over time |
| **Admin Panel** | Server power controls, RCON console, player kick/ban, and game settings editor |
| **Item Tracking** | Fingerprint-based item movement tracking with full custody chains and ownership history |
| **Activity Feed** | Searchable, filterable event history with player attribution |
| **Chat History** | Full searchable chat log with Discord ↔ in-game indicators |
| **Database Browser** | Direct SQL queries against 60+ game data tables |
| **Clan Viewer** | Clan membership, territories, and member details |
| **Anti-Cheat Dashboard** | Flag browser, risk scores, and review/whitelist workflow |
| **Bot Config Editor** | Edit `.env` settings from the browser with validation |
| **Server Scheduler** | Visual restart schedule with profile rotation |
| **Discord OAuth2** | Role-based access tiers: public landing, survivor, mod, admin |

### ⚙️ Server Management

| Feature | Description |
|---------|-------------|
| **Multi-Server** | Manage multiple game servers from one bot — each gets its own DB, RCON, stats, and modules |
| **PvP Scheduler** | Automatic PvP on/off at scheduled hours via settings file edit + server restart with countdown warnings |
| **Server Scheduler** | Timed restarts with profile rotation, per-profile setting overrides, and daily/weekly schedules |
| **SFTP Auto-Discovery** | Automatically finds game files on your server — no manual path config needed |
| **Panel API** | Pterodactyl panel integration for hosted servers (Bisect, etc.) — power controls, file API, WebSocket RCON |
| **Env Sync** | Automatic `.env` management — new settings are added on updates, existing values are never overwritten |
| **Setup Wizard** | Interactive Discord wizard for first-time setup — RCON/SFTP testing, path discovery, channel assignment |
| **Save Parser** | Full binary `.sav` file parser — extracts players, structures, vehicles, containers, companions, world state |
| **Snapshot Service** | Periodic world state snapshots for timeline playback and historical analysis |
| **Diff Engine** | Tracks changes between save file parses for activity detection and item movement |

---

## Quick Start

### Prerequisites

- **Node.js** 18+ (22+ recommended)
- A HumanitZ dedicated server with **RCON** enabled
- **SFTP** access to the server (password or SSH key)
- A [Discord bot application](https://discord.com/developers/applications)

### Installation

```bash
git clone https://github.com/QS-Zuq/humanitzbot.git
cd humanitzbot
npm install
```

### Configuration

```bash
cp .env.example .env
```

Fill in the required values:

| Key | Description |
|-----|-------------|
| `DISCORD_TOKEN` | Your bot token |
| `DISCORD_CLIENT_ID` | Discord application ID |
| `DISCORD_GUILD_ID` | Your Discord server ID |
| `RCON_HOST` / `RCON_PORT` / `RCON_PASSWORD` | Game server RCON connection |
| `FTP_HOST` / `FTP_USER` / `FTP_PASSWORD` | SFTP access to the game server |
| `PANEL_CHANNEL_ID` | Discord channel for the bot control panel |

Everything else has sensible defaults or is auto-discovered on first run. See `.env.example` for the full list of 80+ configurable options.

### First Run

```bash
npm run setup
```

This will:
1. Connect to your game server via SFTP
2. Auto-discover file paths (saves, logs, settings)
3. Download initial data and seed the SQLite database
4. Deploy Discord slash commands

### Start

```bash
npm start
```

Development mode with auto-restart:

```bash
npm run dev
```

> **Tip:** If RCON credentials are missing on first boot, the bot starts in minimal mode and posts an interactive setup wizard in your panel channel.

---

## Web Dashboard

The dashboard runs on port `3000` by default (`WEB_MAP_PORT` in `.env`).

### Public Landing Page

The landing page is accessible without authentication and shows:
- Server status (online/offline, player count, game day)
- Connect info and Discord invite
- Multi-server overview

### Discord OAuth2 Authentication

For the full dashboard with role-based access:

```env
DISCORD_OAUTH_SECRET=your_oauth_secret
WEB_MAP_CALLBACK_URL=https://your-domain.com/auth/callback
WEB_MAP_SESSION_SECRET=a_random_secret_string
```

**Access Tiers:**
| Tier | Access |
|------|--------|
| **Public** | Landing page, server status |
| **Survivor** | Map, player list, activity feed, chat history |
| **Mod** | Kick players, send RCON messages, force snapshots |
| **Admin** | Ban, RCON console, settings editor, database browser, bot config, power controls |

### Reverse Proxy (Caddy)

```
your-domain.com {
    reverse_proxy localhost:3000
}
```

---

## Slash Commands

| Command | Description |
|---------|-------------|
| `/players` | List online players with stats |
| `/playerstats` | Detailed stats for a specific player |
| `/playtime` | Player playtime leaderboard |
| `/server` | Server info, status, and settings |
| `/rcon` | Execute RCON commands (admin) |
| `/panel` | Bot control panel link |
| `/threads` | Manage daily activity/chat threads |

---

## Multi-Server

Manage additional servers from the web panel or `data/servers.json`. Each server is fully isolated with its own:

- 📊 SQLite database
- 🔌 RCON connection (TCP or WebSocket via Pterodactyl)
- 📈 Player stats & playtime tracking
- 📋 Log watcher & chat relay
- ⏰ Independent scheduler & PvP config
- 📁 SFTP or Panel File API access

Supports self-hosted (Docker/VPS with SFTP) and managed hosting (Pterodactyl panel API).

---

## Project Structure

```
src/
├── index.js                # Bot entry point & module orchestration
├── config.js               # Environment config with 80+ options
├── deploy-commands.js      # Slash command registration
├── env-sync.js             # Automatic .env schema migration
├── commands/               # Discord slash commands (7 commands)
├── db/
│   ├── database.js         # SQLite wrapper (60+ tables, 200+ queries)
│   ├── schema.js           # Schema definitions & migrations
│   ├── diff-engine.js      # Save-to-save change detection
│   ├── item-fingerprint.js # Deterministic item fingerprinting
│   └── item-tracker.js     # Item movement & custody tracking
├── modules/
│   ├── log-watcher.js      # SFTP log tailing with event parsing
│   ├── chat-relay.js       # Bidirectional Discord ↔ game chat
│   ├── player-stats-channel.js  # Stats embeds & save file polling
│   ├── server-status.js    # Live server status embed
│   ├── pvp-scheduler.js    # Automated PvP time windows
│   ├── server-scheduler.js # Restart scheduling with profiles
│   ├── panel-channel.js    # Discord control panel with buttons
│   ├── activity-log.js     # DB-backed activity event processing
│   └── ...                 # 20+ module files
├── parsers/
│   ├── save-parser.js      # Binary .sav file parser
│   ├── save-service.js     # SFTP/Panel save polling & DB sync
│   ├── game-data.js        # Game enums, items, recipes
│   └── ue4-names.js        # UE4 blueprint name cleaning
├── rcon/
│   ├── rcon.js             # TCP RCON client with reconnection
│   ├── panel-rcon.js       # WebSocket RCON via Pterodactyl
│   └── server-info.js      # Player list, server info queries
├── server/
│   ├── multi-server.js     # Multi-server instance management
│   ├── panel-api.js        # Pterodactyl Panel API client
│   └── server-resources.js # System resource monitoring
├── tracking/
│   ├── player-stats.js     # Per-player stat aggregation
│   ├── playtime-tracker.js # Session-based playtime tracking
│   ├── kill-tracker.js     # Kill stat accumulation & deltas
│   └── snapshot-service.js # Periodic world state snapshots
└── web-map/
    ├── server.js           # Express API server (50+ endpoints)
    ├── auth.js             # Discord OAuth2 + role-based access
    └── public/             # Dashboard frontend (HTML/JS/CSS)
```

---

## Database

SQLite with **60+ tables** covering:

- **Players** — stats, aliases, risk scores, progression
- **World State** — structures, vehicles, containers, companions, horses, dead bodies, loot actors
- **Activity** — event log, chat log, kill tracking, item movements
- **Game Reference** — items, recipes, professions, skills, buildings, vehicles, loot pools, afflictions
- **Timeline** — periodic snapshots of all entity positions for playback
- **Anti-Cheat** — flags, risk scores, review status
- **Server** — settings, peaks, scheduler state

---

## Development

### Tests

```bash
npm test                 # 767 tests across 24 test files
```

### Build CSS

```bash
npm run build:css        # Production Tailwind build
npm run dev:css          # Watch mode
```

### Other Scripts

```bash
npm run setup            # First-run setup wizard
npm run setup:local      # Setup with local files (no SFTP)
npm run setup:find       # SFTP file path discovery only
npm run setup:validate   # Validate configuration
npm run deploy-commands  # Register slash commands
npm run build:template   # Rebuild template database
```

---

## Tech Stack

| Component | Technology |
|-----------|-----------|
| **Runtime** | Node.js 18+ |
| **Discord** | discord.js v14 |
| **Database** | SQLite via better-sqlite3 |
| **Web Server** | Express v5 |
| **Map** | Leaflet with CRS.Simple |
| **Styling** | Tailwind CSS |
| **SFTP** | ssh2-sftp-client |
| **RCON** | Custom TCP + WebSocket clients |
| **WebSocket** | ws (Pterodactyl console) |
| **Tests** | Node.js built-in test runner |

---

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Run tests (`npm test`)
4. Commit your changes
5. Push to the branch
6. Open a Pull Request

---

## License

[MIT](LICENSE)

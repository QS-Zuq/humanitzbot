# HumanitZ Discord Bot

A comprehensive Discord bot for HumanitZ dedicated servers. Connects via RCON for live server data, SFTP for log parsing and save file analysis, and provides a full dashboard experience with player stats, clan tracking, bidirectional chat, and more.

## Features

### Live Server Status

**Voice Channel Dashboard** — A locked category at the top of your Discord showing live server data:

```
📊 HumanitZ Server Info
├── 👥 Players: 5
├── 📅 Day: 42
├── 🍂 Season: Summer
└── 🌤️ Weather: Clear
```

**Server Status Embed** — A persistent text embed in a dedicated channel that auto-updates every 30 seconds with player count, time, weather, online players, playtime leaderboard, activity totals, and peak stats.

### Player Statistics

**Player Stats Channel** — A dedicated channel with a persistent embed showing server-wide leaderboards (top killers, playtime, survival) and aggregate stats. Features two dropdowns:

- **Player Select** — View comprehensive per-player stats including kill breakdown, survival, vitals bars, status effects, damage taken, building, raids, inventory, recipes, and connections. Data is merged from the save file (GVAS binary parser) and server logs.
- **Clan Select** — View aggregated clan stats (kills, survival, activity) with a member breakdown. Clan data is parsed directly from the game's `Save_ClanData.sav` file — these are actual in-game clan groups.

### Bidirectional Chat Bridge

- **Discord → Server** — Messages in the admin channel are broadcast in-game as `[Admin]` messages
- **Server → Discord** — In-game chat is polled via `fetchchat` RCON and relayed to a daily chat thread
- **Admin Alerts** — Players typing `!admin` in-game triggers an `@here` ping in the admin channel

### Activity Logging

Server logs are parsed via SFTP and posted to daily threads:

- **📋 Activity Log** — Deaths, damage, building, looting, raids, connects/disconnects, admin access
- **💬 Chat Log** — Full in-game chat history

### Auto-Messages

Periodic in-game broadcasts (Discord invite link, promo messages) and personalized welcome messages for new/returning players with their playtime stats.

### Slash Commands

| Command | Description |
|---------|-------------|
| `/server` | Show server world info (time, season, weather, player count) |
| `/players` | List all online players with Steam IDs |
| `/playtime [player]` | Playtime leaderboard or individual lookup |
| `/playerstats` | Player activity stats with interactive dropdown |
| `/rcon <command>` | Send any raw RCON command (Admin only, ephemeral) |

### Save File Parser

A custom UE4 GVAS binary parser that reads the dedicated server save file and extracts per-player data:

- Kill stats (zombie kills, headshots, melee, gun, blast, fist, takedown, vehicle)
- Survival (days survived, bites, affliction, fish caught)
- Vitals snapshot (health, hunger, thirst, stamina, immunity, battery)
- Character info (gender, starting perk)
- Inventory, equipment, and quick slots
- Unlocked recipes (crafting + building)
- Lore entries collected
- Player states and body conditions
- Clan membership and roles

---

## Supported RCON Commands

Based on the [HumanitZ RCON documentation](https://help.bisecthosting.com/hc/en-us/articles/46144468611483):

| Command | Description |
|---------|-------------|
| `info` | Prints current world information |
| `Players` | Lists connected players (name + SteamID) |
| `admin [message]` | Sends a message with [Admin] tag |
| `fetchchat` | Fetches recent in-game chat messages |
| `kick [SteamID]` | Kicks a player |
| `ban [SteamID]` | Bans a player |
| `unban [SteamID]` | Unbans a player |
| `fetchbanned` | Lists banned SteamIDs |
| `teleport [SteamID]` | Teleport to nearest spawn |
| `unstuck [SteamID]` | Unstucks a player |
| `season [name]` | Sets the current season |
| `weather [name]` | Sets the current weather |
| `restart [minutes]` | Restarts after X minutes |
| `QuickRestart` | Restarts after 1 minute |
| `RestartNow` | Restarts immediately |
| `CancelRestart` | Cancels a pending restart |
| `shutdown` | Shuts down immediately |

All of these can be used from Discord via the `/rcon` command.

---

## Setup Guide

### 1. Create a Discord Bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
2. Click **New Application** and give it a name
3. Go to the **Bot** tab and click **Reset Token** — copy the token
4. Under **Privileged Gateway Intents**, enable **Message Content Intent**
5. Go to **OAuth2 → URL Generator**:
   - Scopes: `bot`, `applications.commands`
   - Permissions: `Send Messages`, `Embed Links`, `Read Message History`, `Manage Channels`, `Add Reactions`, `Create Public Threads`, `Send Messages in Threads`
6. Copy the generated URL and open it in your browser to invite the bot to your server

### 2. Get Your Discord IDs

- **Client ID** — Discord Developer Portal → your app → General Information
- **Guild ID** — Right-click your Discord server name → Copy Server ID (enable Developer Mode in settings first)
- **Admin Channel ID** — Right-click the channel → Copy Channel ID
- **Server Status Channel ID** — A dedicated channel for the live embed
- **Player Stats Channel ID** — A dedicated channel for the stats embed + dropdowns
- **Chat Channel ID** *(optional)* — Separate channel for the in-game chat relay. If omitted, chat goes to the admin channel

### 3. Get RCON Details

1. Log in to your server hosting panel
2. Ensure **RCON** is enabled
3. Note the **RCON Password**
4. Copy the RCON **IP:Port** (on Bisect Hosting, this is the third address on the Network tab)

### 4. Get SFTP Details (for logs + save parsing)

SFTP access is needed for:
- Activity log parsing (deaths, damage, builds, raids)
- Playtime tracking (connect/disconnect events)
- Save file parsing (kill stats, vitals, inventory, clans)

Get SFTP credentials from your hosting panel. On Bisect Hosting, use the SFTP tab for host, port, username, and password.

### 5. Configure the Bot

```bash
cp .env.example .env
```

Edit `.env` and fill in your values. See `.env.example` for all available options with descriptions. At minimum you need:

```env
DISCORD_TOKEN=your_bot_token
DISCORD_CLIENT_ID=your_client_id
DISCORD_GUILD_ID=your_guild_id
ADMIN_CHANNEL_ID=your_admin_channel_id
RCON_HOST=your_server_ip
RCON_PORT=27015
RCON_PASSWORD=your_rcon_password
```

Notable optional settings:
- `SHOW_RAID_STATS=true` — Enable raid stats display (for PVP servers; off by default for PVE)
- `CHAT_CHANNEL_ID` — Separate channel for in-game chat relay
- `DISCORD_INVITE_LINK` — Discord invite link to broadcast in-game

See `.env.example` for the full list of options.

### Polling Intervals

All intervals are configurable via `.env` (values in milliseconds).

| System | Env Variable | Default | Description |
|--------|-------------|---------|-------------|
| Chat Relay | `CHAT_POLL_INTERVAL` | 10 s | Polls in-game chat via RCON `fetchchat` |
| Status Cache | `STATUS_CACHE_TTL` | 30 s | Refreshes the cached server info response |
| Server Status Embed | `SERVER_STATUS_INTERVAL` | 30 s | Updates the live server-status text embed |
| Status Voice Channels | `STATUS_CHANNEL_INTERVAL` | 5 min | Renames voice channels (player count, day, season, weather) |
| Log Watcher | `LOG_POLL_INTERVAL` | 30 s | Polls game logs via SFTP |
| Save File Parser | `SAVE_POLL_INTERVAL` | 5 min | Downloads and parses the save file via SFTP |
| Auto-Msg: Discord Link | `AUTO_MSG_LINK_INTERVAL` | 10 min | Broadcasts Discord invite link in-game |
| Auto-Msg: Promo | `AUTO_MSG_PROMO_INTERVAL` | 15 min | Broadcasts promo message in-game |
| Auto-Msg: Join Check | `AUTO_MSG_JOIN_CHECK` | 10 s | Checks for new player joins (welcome message) |

> **Note:** Discord rate-limits voice channel renames to ~2 per 10 minutes per channel. Keep `STATUS_CHANNEL_INTERVAL` at 5 minutes or higher.

### 6. Install & Run

Requires **Node.js 18+**.

```bash
npm install
npm start
```

Slash commands are automatically registered on startup.

---

## Project Structure

```
humanitzbot/
├── .env.example              # Template for environment variables
├── .gitignore
├── package.json
├── README.md
├── setup.js                  # Unified setup, import, and validation utility
├── data/                     # Runtime data (gitignored)
│   ├── player-stats.json     # Log-based player stats
│   ├── playtime.json         # Cumulative playtime records
│   └── kill-tracker.json     # Persistent all-time kill accumulator
└── src/
    ├── index.js              # Entry point — starts bot, wires modules, handles interactions
    ├── config.js             # Loads and validates .env configuration
    ├── rcon.js               # Source RCON client with auto-reconnect
    ├── server-info.js        # RCON command wrappers & response parsers
    ├── chat-relay.js         # Bidirectional chat bridge with daily threads
    ├── status-channels.js    # Live voice channel dashboard
    ├── server-status.js      # Live server status text embed
    ├── player-stats-channel.js # Player stats embed with player + clan dropdowns
    ├── player-stats.js       # Log-based per-player stat tracker
    ├── playtime-tracker.js   # Cumulative playtime tracker
    ├── log-watcher.js        # SFTP log parser with daily threads
    ├── save-parser.js        # UE4 GVAS binary save file parser
    ├── player-embed.js       # Player stat embed builder
    ├── auto-messages.js      # Periodic in-game broadcasts + join welcomes
    ├── deploy-commands.js    # Manual slash command registration script
    └── commands/
        ├── server.js         # /server
        ├── players.js        # /players
        ├── playtime.js       # /playtime
        ├── playerstats.js    # /playerstats
        └── rcon.js           # /rcon (admin only)
```

### Setup & Maintenance Script

`setup.js` is a standalone utility for first-run data import, validation, and recovery. It connects to your game server via SFTP, downloads all log files, and builds the data files the bot needs.

| Command | Description |
|---------|-------------|
| `node setup.js` | **First-run setup** — downloads `HMZLog.log`, `PlayerConnectedLog.txt`, and `PlayerIDMapped.txt` via SFTP, then imports player stats and playtime into `data/`. Backs up any existing data files before overwriting. |
| `node setup.js --find` | **Explore SFTP directories** — lists the server file tree to help you locate log and save files for your `.env` configuration. |
| `node setup.js --validate` | **Validate data** — downloads logs and compares against existing `player-stats.json`. Reports discrepancies without modifying any files. |
| `node setup.js --fix` | **Rebuild data** — same as default mode. Downloads logs and rebuilds all data files from scratch. |
| `node setup.js --local` | **Offline mode** — skips SFTP and uses previously downloaded files cached in `data/`. Useful if you already have the logs locally. |

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Bot comes online but commands don't appear | Slash commands register on startup. Guild commands can take a few minutes to propagate. Try restarting the bot. |
| "RCON not connected" errors | Check that RCON is enabled on your host and the host/port/password are correct. |
| Status channels not updating | Discord rate-limits channel renames to ~2 per 10 minutes per channel. Increase `STATUS_CHANNEL_INTERVAL` if needed. |
| Admin messages not reaching server | Enable **Message Content Intent** in the Discord Developer Portal under Bot settings. |
| Save file parsing fails | Verify `FTP_SAVE_PATH` points to the correct `.sav` file. Use `node setup.js --find` to explore the server file tree. |
| No chat relay | Ensure `fetchchat` RCON command works — run `/rcon fetchchat` to test. |
| Clan dropdown empty | The game's `Save_ClanData.sav` must exist. Players need to create clans in-game first. |

---

## License

MIT

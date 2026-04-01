<p align="center">
  <a href="README.md">English</a> | <a href="README.zh-TW.md">繁體中文</a> | <strong>简体中文</strong>
</p>

<p align="center">
  <img src="src/web-map/public/favicon.svg" width="80" height="80" alt="HumanitZ Bot" />
</p>

<h1 align="center">HumanitZ Bot</h1>

<p align="center">
  为 HumanitZ 专属服务器打造的 Discord Bot 与 Web 仪表盘。
  <br />
  包含玩家统计、聊天中继、实时地图、活动日志以及完整的服务器管理功能。
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-18%2B-339933?logo=nodedotjs&logoColor=white" alt="Node.js 18+" />
  <img src="https://img.shields.io/badge/discord.js-v14-5865F2?logo=discord&logoColor=white" alt="discord.js v14" />
  <img src="https://img.shields.io/badge/SQLite-better--sqlite3-003B57?logo=sqlite&logoColor=white" alt="SQLite" />
  <img src="https://img.shields.io/badge/Express-v5-000000?logo=express&logoColor=white" alt="Express v5" />
  <img src="https://img.shields.io/badge/i18n-EN_%7C_%E7%B9%81%E4%B8%AD_%7C_%E7%AE%80%E4%B8%AD-blue" alt="i18n: EN | 繁中 | 简中" />
  <img src="https://img.shields.io/badge/License-MIT-green" alt="MIT License" />
  <img src="https://img.shields.io/badge/Tests-1426_passing-brightgreen" alt="Tests" />
</p>

<p align="center">
  想要支持这个项目吗？
  <br />
  <a href="https://buymeacoffee.com/qszuq">
    <img src="https://img.shields.io/badge/%E2%80%8B-Buy_Me_a_Coffee-FF6D00?logo=buymeacoffee&logoColor=white" alt="Buy Me a Coffee" />
  </a>
</p>

<p align="center">
  <a href="https://play.qs-zuq.com/"><strong>🌐 查看实际效果</strong></a> — 真实运行服务器上的公开 Web 仪表盘（拥有幸存者权限）
</p>

<p align="center">
  <a href="#功能特性">功能特性</a> · <a href="#快速开始">快速开始</a> · <a href="#web-仪表盘">Web 仪表盘</a> · <a href="#斜杠指令">斜杠指令</a> · <a href="#多服务器支持">多服务器支持</a> · <a href="#贡献指南">贡献指南</a>
</p>

<p align="center">
  <a href="https://www.bisecthosting.com/zuq?r=github">
    <img src="https://www.bisecthosting.com/partners/custom-banners/e72be28f-6da0-41d2-a559-306c82ab47b3.webp" alt="BisectHosting Partner Banner" />
  </a>
</p>

---

## 功能特性

### 🎮 Discord 集成

| 功能           | 描述                                                                   |
| -------------- | ---------------------------------------------------------------------- |
| **服务器状态** | 实时显示玩家数量、游戏天数、季节、服务器健康状况及系统资源的嵌入消息   |
| **玩家统计**   | 每个玩家的击杀统计、游玩时间、职业、生涯记录及进度追踪                 |
| **聊天中继**   | Discord 与游戏内之间的双向聊天桥接，支持丰富的格式                     |
| **活动日志**   | 实时播报玩家连接、死亡、建筑建造、搜刮、突袭及 PvP 击杀事件            |
| **击杀播报**   | 包含伤害追踪、死因分类以及死亡循环检测的 PvP 击杀归属播报              |
| **自动消息**   | 欢迎消息、Discord 链接广播、以及通过 SFTP 托管包含排行榜模板的欢迎文件 |
| **里程碑**     | 当玩家达到特定的击杀里程碑时自动发布公告                               |
| **数据汇总**   | 定期发布服务器数据汇总报告及统计趋势                                   |
| **每日讨论串** | 自动创建用于活动播报和聊天的每日讨论串 — 保持频道整洁                  |
| **状态频道**   | 显示实时玩家数量、游戏天数和季节的语音频道名称                         |

### 🗺️ Web 仪表盘

| 功能                 | 描述                                                                                |
| -------------------- | ----------------------------------------------------------------------------------- |
| **交互式地图**       | 基于 Leaflet 的世界地图，实时显示玩家位置、建筑、载具、容器、马匹、尸体以及 AI 实体 |
| **时间轴回放**       | 拖动查看历史世界快照 — 观察你的服务器是如何随时间演变的                             |
| **管理员面板**       | 服务器电源控制、RCON 控制台、踢出/封禁玩家以及游戏设置编辑器                        |
| **物品追踪**         | 基于特征码的物品移动追踪，包含完整的保管链和所有权历史                              |
| **活动动态**         | 可搜索、可过滤的事件历史记录，并带有玩家归属信息                                    |
| **聊天历史**         | 完整可搜索的聊天日志，带有 Discord ↔ 游戏内来源指示                                 |
| **数据库浏览器**     | 直接对 60 多个游戏数据表执行 SQL 查询                                               |
| **公会查看器**       | 查看公会成员、领地及成员详情                                                        |
| **机器人配置编辑器** | 直接在浏览器中编辑机器人设置，支持即时应用与重启检测                                |
| **服务器调度器**     | 可视化的重启时间表及配置文件轮换功能                                                |
| **Discord OAuth2**   | 基于角色的访问层级：公开页面、幸存者、模组管理 (Mod)、管理员                        |
| **多语言支持**       | 完整的 i18n 支持 — 英文、繁體中文、简体中文，具备浏览器语言检测与即时切换功能       |

### ⚙️ 服务器管理

| 功能              | 描述                                                                                          |
| ----------------- | --------------------------------------------------------------------------------------------- |
| **多服务器支持**  | 通过一个机器人管理多个游戏服务器 — 每个服务器拥有独立的数据库、RCON、统计数据及模块           |
| **PvP 调度器**    | 通过编辑设置文件并结合重启倒计时警告，在指定时间段内自动开启/关闭 PvP                         |
| **服务器调度器**  | 带有配置文件轮换的定时重启功能、单配置的设置覆盖以及每日/每周计划                             |
| **SFTP 自动发现** | 自动查找服务器上的游戏文件 — 无需手动配置路径                                                 |
| **面板 API**      | 集成 Pterodactyl 面板（如 Bisect 等托管服务） — 提供电源控制、文件 API 及 WebSocket RCON 功能 |
| **环境同步**      | 自动配置迁移 — 首次启动时将 `.env` 的值自动迁移至 SQLite 数据库，并创建备份                   |
| **CLI 设置**      | 首次运行通过 `npm run setup` 进行设置 — SFTP 自动发现、数据导入与验证                         |
| **存档解析器**    | 完整的二进制 `.sav` 文件解析器 — 提取玩家、建筑、载具、容器、同伴及世界状态                   |
| **快照服务**      | 定期保存世界状态快照，用于时间轴回放与历史分析                                                |
| **差异引擎**      | 跟踪各存档解析间的变化，用于检测活动及物品移动                                                |

---

## 快速开始

### 前置要求

- **Node.js** 18+（推荐 22+）
- 已启用 **RCON** 的 HumanitZ 专属服务器
- 服务器的 **SFTP** 访问权限（密码或 SSH 密钥）
- 一个 [Discord bot 应用程序](https://discord.com/developers/applications)

### 安装

```bash
git clone https://github.com/QS-Zuq/humanitzbot.git
cd humanitzbot
npm install
```

### 配置

```bash
cp .env.example .env
```

填写必需的值：

| 键                  | 描述                   |
| ------------------- | ---------------------- |
| `DISCORD_TOKEN`     | 你的 Discord Bot Token |
| `DISCORD_CLIENT_ID` | Discord 应用程序 ID    |
| `DISCORD_GUILD_ID`  | 你的 Discord 服务器 ID |

其余所有设置（RCON、SFTP、频道、开关等）均可在 `.env` 中配置，或通过 Web 仪表盘进行配置。设置存储在 SQLite 数据库中。

#### 语言 / 区域设置

机器人语言可通过 Web 仪表盘进行配置。Web 仪表盘会自动检测你的浏览器语言，也可通过左下角的语言选择器手动切换。

### 首次运行

```bash
npm run setup
```

这将会：

1. 通过 SFTP 连接到你的游戏服务器
2. 自动发现文件路径（存档、日志、设置）
3. 下载初始数据并生成 SQLite 数据库种子
4. 部署 Discord 斜杠指令

### 启动

```bash
npm start
```

带有自动重启功能的开发模式：

```bash
npm run dev
```

---

## Web 仪表盘

仪表盘默认运行在 `3000` 端口（可在 `.env` 中配置 `WEB_MAP_PORT`）。

### 公开落地页

落地页无需身份验证即可访问，并显示：

- 服务器状态（在线/离线、玩家数量、游戏天数）
- 连接信息与 Discord 邀请链接
- 多服务器概览

### Discord OAuth2 身份验证

要启用具备基于角色访问权限的完整仪表盘：

```env
DISCORD_OAUTH_SECRET=your_oauth_secret
WEB_MAP_CALLBACK_URL=https://your-domain.com/auth/callback
WEB_MAP_SESSION_SECRET=a_random_secret_string
```

**访问层级：**
| 层级 | 权限 |
|------|--------|
| **Public (公开)** | 落地页、服务器状态 |
| **Survivor (幸存者)** | 地图、玩家列表、活动动态、聊天历史 |
| **Mod (模组管理员)** | 踢出玩家、发送 RCON 消息、强制生成快照 |
| **Admin (管理员)** | 封禁玩家、RCON 控制台、设置编辑器、数据库浏览器、机器人配置、电源控制 |

### 反向代理 (Caddy)

```
your-domain.com {
    reverse_proxy localhost:3000
}
```

---

## 斜杠指令

| 指令           | 描述                         |
| -------------- | ---------------------------- |
| `/players`     | 列出在线玩家及其统计数据     |
| `/playerstats` | 查看指定玩家的详细统计数据   |
| `/playtime`    | 玩家游玩时间排行榜           |
| `/server`      | 服务器信息、状态及设置       |
| `/rcon`        | 执行 RCON 指令（管理员专用） |
| `/panel`       | 获取机器人控制面板的链接     |
| `/threads`     | 管理每日活动/聊天讨论串      |

---

## 多服务器支持

通过 Web 仪表盘管理额外的服务器。每个服务器的配置存储在 SQLite 数据库中。每个服务器都是完全隔离的，拥有独立的：

- 📊 SQLite 数据库
- 🔌 RCON 连接（TCP 协议，或通过 Pterodactyl 的 WebSocket）
- 📈 玩家统计与游玩时间追踪
- 📋 日志监视器与聊天中继
- ⏰ 独立的调度器与 PvP 配置
- 📁 SFTP 或面板文件 API 访问权限

支持自托管（使用 Docker/VPS 并配合 SFTP）以及托管服务（通过 Pterodactyl 面板 API）。

---

## 项目结构

```
src/
├── index.js                # 机器人入口点与模块编排
├── config.js               # 配置单例（从 SQLite 数据库加载）
├── deploy-commands.js      # 斜杠指令注册
├── env-sync.js             # 自动 .env 架构迁移
├── commands/               # Discord 斜杠指令（7 个指令）
├── db/
│   ├── database.js         # SQLite 封装层（60+ 张表，200+ 个查询）
│   ├── schema.js           # 架构定义与迁移
│   ├── diff-engine.js      # 存档间的变更检测
│   ├── item-fingerprint.js # 确定性的物品特征码生成
│   └── item-tracker.js     # 物品移动与保管链追踪
├── modules/
│   ├── log-watcher.js      # 带事件解析的 SFTP 日志跟踪
│   ├── chat-relay.js       # Discord ↔ 游戏内双向聊天
│   ├── player-stats-channel.js  # 统计数据嵌入消息与存档文件轮询
│   ├── server-status.js    # 实时服务器状态嵌入消息
│   ├── pvp-scheduler.js    # 自动化的 PvP 时间窗口
│   ├── server-scheduler.js # 带配置轮换的重启调度
│   ├── activity-log.js     # 由数据库支持的活动事件处理
│   └── ...                 # 20+ 个模块文件
├── parsers/
│   ├── save-parser.js      # 二进制 .sav 文件解析器
│   ├── save-service.js     # SFTP/面板存档轮询与数据库同步
│   ├── game-data.js        # 游戏枚举、物品、配方
│   └── ue4-names.js        # UE4 蓝图名称清理
├── rcon/
│   ├── rcon.js             # 带重连功能的 TCP RCON 客户端
│   ├── panel-rcon.js       # 通过 Pterodactyl 提供的 WebSocket RCON
│   └── server-info.js      # 玩家列表、服务器信息查询
├── server/
│   ├── multi-server.js     # 多服务器实例管理
│   ├── panel-api.js        # Pterodactyl 面板 API 客户端
│   └── server-resources.js # 系统资源监控
├── tracking/
│   ├── player-stats.js     # 单个玩家统计数据聚合
│   ├── playtime-tracker.js # 基于会话的游玩时间追踪
│   ├── kill-tracker.js     # 击杀统计累积与增量计算
│   └── snapshot-service.js # 定期世界状态快照
└── web-map/
    ├── server.js           # Express API 服务器（50+ 个端点）
    ├── auth.js             # Discord OAuth2 + 基于角色的访问控制
    └── public/             # 仪表盘前端（HTML/JS/CSS）
```

---

## 数据库

使用 SQLite 管理 **60+ 张数据表**，涵盖：

- **Players (玩家)** — 统计数据、别名、风险评分、游戏进度
- **World State (世界状态)** — 建筑、载具、容器、同伴、马匹、尸体、战利品实体
- **Activity (活动)** — 事件日志、聊天日志、击杀追踪、物品移动
- **Game Reference (游戏参考)** — 物品、配方、职业、技能、建筑物、载具、战利品池、负面状态
- **Timeline (时间轴)** — 用于回放的所有实体位置定期快照
- **Server (服务器)** — 设置、峰值记录、调度器状态

---

## 开发

### 测试

```bash
npm test                 # 在 40 个测试文件中执行 1426 个测试
```

### 构建 CSS

```bash
npm run build:css        # 生产环境的 Tailwind 构建
npm run dev:css          # 监听模式 (Watch mode)
```

### 其他脚本

```bash
npm run setup            # 首次运行 CLI 设置 — SFTP 自动发现和数据导入
npm run setup:local      # 使用本地文件进行设置（无需 SFTP）
npm run setup:find       # 仅执行 SFTP 文件路径发现
npm run setup:validate   # 验证配置
npm run deploy-commands  # 注册斜杠指令
npm run build:template   # 重新构建模板数据库
```

---

## 技术栈

| 组件           | 技术                          |
| -------------- | ----------------------------- |
| **Runtime**    | Node.js 18+                   |
| **Discord**    | discord.js v14                |
| **Database**   | 使用 better-sqlite3 的 SQLite |
| **Web Server** | Express v5                    |
| **Map**        | 使用 CRS.Simple 的 Leaflet    |
| **Styling**    | Tailwind CSS                  |
| **SFTP**       | ssh2-sftp-client              |
| **RCON**       | 自定义 TCP + WebSocket 客户端 |
| **WebSocket**  | ws (Pterodactyl 控制台)       |
| **Tests**      | Node.js 内置的测试运行器      |

---

## 贡献指南

1. Fork 本仓库
2. 创建一个功能分支 (`git checkout -b feature/amazing-feature`)
3. 运行测试 (`npm test`)
4. 提交你的修改
5. 推送到分支
6. 提交一个 Pull Request (合并请求)

---

## 许可证

[MIT](LICENSE)

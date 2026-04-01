<p align="center">
  <a href="README.md">English</a> | <strong>繁體中文</strong> | <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <img src="src/web-map/public/favicon.svg" width="80" height="80" alt="HumanitZ Bot" />
</p>

<h1 align="center">HumanitZ Bot</h1>

<p align="center">
  專為 HumanitZ 專用伺服器設計的 Discord 機器人與網頁儀表板。
  <br />
  包含玩家統計、聊天轉發、即時地圖、活動日誌及完整的伺服器管理功能。
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
  想要支持這個專案嗎？
  <br />
  <a href="https://buymeacoffee.com/qszuq">
    <img src="https://img.shields.io/badge/%E2%80%8B-Buy_Me_a_Coffee-FF6D00?logo=buymeacoffee&logoColor=white" alt="Buy Me a Coffee" />
  </a>
</p>

<p align="center">
  <a href="https://play.qs-zuq.com/"><strong>🌐 查看實際運作</strong></a> — 在真實伺服器上的公開網頁儀表板（使用 survivor 權限）
</p>

<p align="center">
  <a href="#功能特色">功能特色</a> · <a href="#快速開始">快速開始</a> · <a href="#網頁儀表板">網頁儀表板</a> · <a href="#斜線指令">斜線指令</a> · <a href="#多伺服器支援">多伺服器支援</a> · <a href="#貢獻指南">貢獻指南</a>
</p>

<p align="center">
  <a href="https://www.bisecthosting.com/zuq?r=github">
    <img src="https://www.bisecthosting.com/partners/custom-banners/e72be28f-6da0-41d2-a559-306c82ab47b3.webp" alt="BisectHosting Partner Banner" />
  </a>
</p>

---

## 功能特色

### 🎮 Discord 整合

| 功能           | 說明                                                                       |
| -------------- | -------------------------------------------------------------------------- |
| **伺服器狀態** | 即時更新的嵌入訊息，包含玩家數量、遊戲天數、賽季、伺服器健康狀況與系統資源 |
| **玩家統計**   | 記錄每位玩家的擊殺數據、遊玩時間、職業、生涯紀錄與進度追蹤                 |
| **聊天轉發**   | 在 Discord 與遊戲內之間建立雙向聊天橋接，支援豐富的格式設定                |
| **活動日誌**   | 即時推播連線、死亡、建築、搜刮、突襲與 PvP 擊殺等事件                      |
| **擊殺動態**   | PvP 擊殺紀錄，支援傷害追蹤、死因分類及死亡循環偵測                         |
| **自動訊息**   | 歡迎訊息、Discord 連結廣播，以及透過 SFTP 託管並帶有排行榜模板的歡迎文件   |
| **里程碑**     | 玩家達到特定擊殺里程碑時自動發送公告                                       |
| **總結報告**   | 定期提供伺服器摘要與趨勢統計報告                                           |
| **每日討論串** | 自動建立每日活動與聊天討論串，保持頻道整潔                                 |
| **狀態頻道**   | 語音頻道名稱即時顯示玩家數量、遊戲天數與賽季資訊                           |

### 🗺️ 網頁儀表板

| 功能                 | 說明                                                                                         |
| -------------------- | -------------------------------------------------------------------------------------------- |
| **互動式即時地圖**   | 基於 Leaflet 的世界地圖，顯示玩家即時位置、建築、載具、容器、馬匹、屍體與 AI 實體            |
| **時間軸回放**       | 可拖曳查看歷史世界快照，觀看伺服器演進的過程                                                 |
| **管理員控制台**     | 包含伺服器電源控制、RCON 控制台、踢出/封禁玩家功能，以及遊戲設定編輯器                       |
| **物品追蹤**         | 基於指紋的物品移動追蹤，完整記錄轉手過程與所有權歷史                                         |
| **活動摘要**         | 可搜尋、篩選的事件歷史紀錄，並標明觸發玩家                                                   |
| **聊天紀錄**         | 完整且可搜尋的聊天紀錄，標示 Discord ↔ 遊戲內雙向來源                                        |
| **資料庫瀏覽器**     | 可直接對 60 多個遊戲資料表執行 SQL 查詢                                                      |
| **公會檢視器**       | 顯示公會成員、領地與成員詳細資訊                                                             |
| **機器人設定編輯器** | 從瀏覽器直接編輯機器人設定，支援即時套用與重啟偵測                                           |
| **伺服器排程器**     | 具備設定檔輪替功能的視覺化重啟排程                                                           |
| **Discord OAuth2**   | 基於身分組的存取層級：public（公開）、survivor（生存者）、mod（管理員）、admin（最高管理員） |
| **多國語言**         | 完整的 i18n 支援 — 英文、繁體中文、簡體中文，具備瀏覽器語言偵測與即時切換功能                |

### ⚙️ 伺服器管理

| 功能              | 說明                                                                                           |
| ----------------- | ---------------------------------------------------------------------------------------------- |
| **多伺服器支援**  | 透過一個機器人管理多個遊戲伺服器 — 每個伺服器皆有獨立的資料庫、RCON、統計數據與模組            |
| **PvP 排程器**    | 透過編輯設定檔與伺服器重啟自動在預定時間開關 PvP，並附帶倒數警告                               |
| **伺服器排程器**  | 帶有設定檔輪替、各設定檔覆蓋及每日/每週排程的定時重啟功能                                      |
| **SFTP 自動探索** | 自動尋找伺服器上的遊戲檔案 — 無需手動設定路徑                                                  |
| **面板 API**      | 整合 Pterodactyl 面板（適用於 Bisect 等託管伺服器） — 支援電源控制、檔案 API 與 WebSocket RCON |
| **環境變數同步**  | 自動設定遷移 — 首次啟動時將 `.env` 數值自動遷移至 SQLite 資料庫，並建立備份                    |
| **CLI 設定**      | 首次執行透過 `npm run setup` 進行設定 — SFTP 自動探索、資料匯入與驗證                          |
| **存檔解析器**    | 完整的二進位 `.sav` 檔案解析器 — 可提取玩家、建築、載具、容器、同伴與世界狀態                  |
| **快照服務**      | 定期建立世界狀態快照，支援時間軸回放與歷史分析                                                 |
| **差異比對引擎**  | 追蹤各次存檔解析之間的變更，用於活動偵測與物品移動紀錄                                         |

---

## 快速開始

### 系統需求

- **Node.js** 18+ (推薦 22+)
- 已啟用 **RCON** 的 HumanitZ 專用伺服器
- 擁有該伺服器的 **SFTP** 存取權限 (密碼或 SSH 金鑰)
- 一個 [Discord 機器人應用程式](https://discord.com/developers/applications)

### 安裝

```bash
git clone https://github.com/QS-Zuq/humanitzbot.git
cd humanitzbot
npm install
```

### 設定

```bash
cp .env.example .env
```

填寫以下必要數值：

| 鍵值 (Key)          | 說明                   |
| ------------------- | ---------------------- |
| `DISCORD_TOKEN`     | 你的機器人 Token       |
| `DISCORD_CLIENT_ID` | Discord 應用程式 ID    |
| `DISCORD_GUILD_ID`  | 你的 Discord 伺服器 ID |

所有其他設定（RCON、SFTP、頻道、開關等）均可在 `.env` 中設定，或透過網頁儀表板進行設定。設定値儲存於 SQLite 資料庫中。

#### 語言 / 區域設定

機器人語言可透過網頁儀表板進行設定。網頁儀表板會自動偵測你的瀏覽器語言，也可透過左下角的語言選擇器手動切換。

### 首次執行

```bash
npm run setup
```

這將會執行以下步驟：

1. 透過 SFTP 連線至你的遊戲伺服器
2. 自動探索檔案路徑 (存檔、日誌、設定檔)
3. 下載初始資料並建立 SQLite 資料庫種子
4. 部署 Discord 斜線指令

### 啟動

```bash
npm start
```

帶有自動重啟功能的開發模式：

```bash
npm run dev
```

---

## 網頁儀表板

儀表板預設於 `3000` 埠執行（於 `.env` 設定 `WEB_MAP_PORT`）。

### 公開登入頁面

登入頁面無需驗證即可訪問，並顯示：

- 伺服器狀態（上線/離線、玩家數量、遊戲天數）
- 連線資訊與 Discord 邀請連結
- 多伺服器總覽

### Discord OAuth2 驗證

若要啟用具備身分組存取權限的完整儀表板：

```env
DISCORD_OAUTH_SECRET=your_oauth_secret
WEB_MAP_CALLBACK_URL=https://your-domain.com/auth/callback
WEB_MAP_SESSION_SECRET=a_random_secret_string
```

**存取層級：**
| 層級 | 權限 |
|------|--------|
| **Public** (公開) | 登入頁面、伺服器狀態 |
| **Survivor** (生存者) | 地圖、玩家列表、活動摘要、聊天紀錄 |
| **Mod** (管理員) | 踢出玩家、發送 RCON 訊息、強制建立快照 |
| **Admin** (最高管理員) | 封禁、RCON 控制台、設定編輯器、資料庫瀏覽器、機器人設定、電源控制 |

### 反向代理 (Caddy)

```
your-domain.com {
    reverse_proxy localhost:3000
}
```

---

## 斜線指令

| 指令           | 說明                        |
| -------------- | --------------------------- |
| `/players`     | 列出線上玩家與其統計數據    |
| `/playerstats` | 查看特定玩家的詳細統計數據  |
| `/playtime`    | 玩家遊玩時間排行榜          |
| `/server`      | 伺服器資訊、狀態與設定      |
| `/rcon`        | 執行 RCON 指令 (管理員專用) |
| `/panel`       | 取得機器人控制台連結        |
| `/threads`     | 管理每日活動/聊天討論串     |

---

## 多伺服器支援

從網頁儀表板管理額外的伺服器。每個伺服器的設定儲存於 SQLite 資料庫中。每個伺服器皆完全獨立運作，並擁有專屬的：

- 📊 SQLite 資料庫
- 🔌 RCON 連線 (TCP 或透過 Pterodactyl 的 WebSocket)
- 📈 玩家統計與遊玩時間追蹤
- 📋 日誌監控與聊天轉發
- ⏰ 獨立排程器與 PvP 設定
- 📁 SFTP 或 Panel File API 存取

支援自行託管（Docker/VPS 搭配 SFTP）與代管服務（Pterodactyl 面板 API）。

---

## 專案結構

```
src/
├── index.js                # 機器人入口點與模組協調器
├── config.js               # 設定 Singleton（從 SQLite 資料庫載入）
├── deploy-commands.js      # 斜線指令註冊
├── env-sync.js             # 自動 .env 結構遷移
├── commands/               # Discord 斜線指令 (共 7 個)
├── db/
│   ├── database.js         # SQLite 封裝 (超過 60 個資料表、200 個以上的查詢)
│   ├── schema.js           # 結構定義與遷移
│   ├── diff-engine.js      # 存檔變更偵測
│   ├── item-fingerprint.js # 確定性物品指紋辨識
│   └── item-tracker.js     # 物品移動與保管紀錄追蹤
├── modules/
│   ├── log-watcher.js      # SFTP 日誌監控與事件解析
│   ├── chat-relay.js       # Discord ↔ 遊戲雙向聊天
│   ├── player-stats-channel.js  # 統計嵌入訊息與存檔輪詢
│   ├── server-status.js    # 即時伺服器狀態嵌入訊息
│   ├── pvp-scheduler.js    # 自動化 PvP 時間區段
│   ├── server-scheduler.js # 具備設定檔的重啟排程
│   ├── activity-log.js     # 由資料庫支援的活動事件處理
│   └── ...                 # 20 個以上的模組檔案
├── parsers/
│   ├── save-parser.js      # 二進位 .sav 檔案解析器
│   ├── save-service.js     # SFTP/面板存檔輪詢與資料庫同步
│   ├── game-data.js        # 遊戲列舉、物品、配方
│   └── ue4-names.js        # UE4 藍圖名稱清理
├── rcon/
│   ├── rcon.js             # 具備重新連線功能的 TCP RCON 客戶端
│   ├── panel-rcon.js       # 透過 Pterodactyl 的 WebSocket RCON
│   └── server-info.js      # 玩家列表與伺服器資訊查詢
├── server/
│   ├── multi-server.js     # 多伺服器實例管理
│   ├── panel-api.js        # Pterodactyl 面板 API 客戶端
│   └── server-resources.js # 系統資源監控
├── tracking/
│   ├── player-stats.js     # 個別玩家統計數據彙整
│   ├── playtime-tracker.js # 基於連線工作階段的遊玩時間追蹤
│   ├── kill-tracker.js     # 擊殺統計累積與差異計算
│   └── snapshot-service.js # 定期記錄世界狀態快照
└── web-map/
    ├── server.js           # Express API 伺服器 (超過 50 個端點)
    ├── auth.js             # Discord OAuth2 與基於身分組的權限控制
    └── public/             # 儀表板前端 (HTML/JS/CSS)
```

---

## 資料庫

使用 SQLite，包含**超過 60 個資料表**，涵蓋以下內容：

- **玩家** — 統計數據、別名、風險評分、進度
- **世界狀態** — 建築、載具、容器、同伴、馬匹、屍體、搜刮實體
- **活動** — 事件日誌、聊天紀錄、擊殺追蹤、物品移動
- **遊戲參考資料** — 物品、配方、職業、技能、建築、載具、戰利品池、狀態異常
- **時間軸** — 定期保存所有實體位置的快照以供回放
- **伺服器** — 設定、峰值數據、排程器狀態

---

## 開發

### 測試

```bash
npm test                 # 於 40 個測試檔案中執行 1426 項測試
```

### 建置 CSS

```bash
npm run build:css        # Tailwind 生產環境建置
npm run dev:css          # 監聽模式
```

### 其他腳本

```bash
npm run setup            # 首次執行 CLI 設定 — SFTP 自動探索與資料匯入
npm run setup:local      # 使用本機檔案設定 (無需 SFTP)
npm run setup:find       # 僅執行 SFTP 檔案路徑探索
npm run setup:validate   # 驗證設定
npm run deploy-commands  # 註冊斜線指令
npm run build:template   # 重建模板資料庫
```

---

## 技術堆疊

| 元件           | 技術                           |
| -------------- | ------------------------------ |
| **執行環境**   | Node.js 18+                    |
| **Discord**    | discord.js v14                 |
| **資料庫**     | SQLite via better-sqlite3      |
| **網頁伺服器** | Express v5                     |
| **地圖**       | Leaflet with CRS.Simple        |
| **樣式**       | Tailwind CSS                   |
| **SFTP**       | ssh2-sftp-client               |
| **RCON**       | Custom TCP + WebSocket clients |
| **WebSocket**  | ws (Pterodactyl console)       |
| **測試**       | Node.js built-in test runner   |

---

## 貢獻指南

1. Fork 這個儲存庫
2. 建立功能分支 (`git checkout -b feature/amazing-feature`)
3. 執行測試 (`npm test`)
4. 提交你的變更
5. 推送至該分支
6. 建立 Pull Request

---

## 授權條款

[MIT](LICENSE)

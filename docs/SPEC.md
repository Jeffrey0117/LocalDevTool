# LocalDevTool — 規格書

> Contextual Network Inspector（自架的 HTTP 流量觀測 + 右鍵挖掘工具）
> 一句話：**讓我知道網站為什麼會是這個樣子。**

來源：2026-11-16 與 ChatGPT 的設計討論（Project B）。姊妹專案是 LocalMonkey（改造網站）；這一個是**理解網站**。本檔是實作契約。

---

## 1. 產品定位

技術底層跟 LocalMonkey 一樣是 reverse proxy，但關注點相反：LocalMonkey 改寫回應，LocalDevTool **觀察**請求與回應。

它不是「DevTools 的替代介面」。DevTools 早就能看所有請求。它的價值是兩件 DevTools 做不到的事：

1. **觀測會持續發生、會被保存**。不用每次按 F12。B 電腦上瀏覽，A 電腦上查紀錄。可以搜尋、比較同一支 API 不同時間的回應。這是從 debugging tool 走向 observability system 的差別。
2. **右鍵挖掘（這是真正的特色）**。我在網頁上看到一個東西 — 一支影片、一個價格、一顆登入按鈕 — 直接右鍵它，就能看到它背後的 HTTP 流程：影片真正的來源、給出這個 URL 的 API、請求帶了什麼授權。

### 技術邊界（必須誠實呈現在產品裡，不准假裝沒有）

Reverse proxy **只看得到經過自己的流量**。原站 JS 如果直接 `fetch("https://api.other-cdn.com/x")`，那個請求不經過代理，proxy 看不到（DevTools 看得到）。
所以本專案有兩條觀測管線，各有適用範圍，UI 要標清楚資料是哪條來的：

- **Proxy pipeline**：經過代理的流量。即時、持續、可長期保存。
- **Playwright pipeline**（Inspector）：用受控 Chromium 開目標頁，監聽**所有**網路事件，含跨網域。一次性、要手動觸發。

### 刻意不做的事

- 不做批量擷取 / 爬蟲 / 下載器。核心不是把內容搬走，是理解實作。
- 不做 DRM 解密、不繞過付費牆。遇到 DRM 就誠實報告「受保護，無法分析內容」。
- 不做 JS breakpoint / DOM 編輯 / CSS 檢查 — 那些 DevTools 本來就強，別重造。

---

## 2. 技術約束（硬性）

| 項目 | 規定 |
|---|---|
| Runtime | Node 24（本機 v24.16.0） |
| 框架 | Express 5。wildcard 是 `/{*splat}` 不是 `/*` |
| 模組 | CommonJS。`package.json` **必須**顯式 `"type": "commonjs"` |
| DB | `better-sqlite3` 鎖 `^12`。**不准 ^13**（要 MSVC，這台沒有） |
| Playwright | **optionalDependencies**。沒裝也要能啟動，Inspector 端點回「需要先 `npx playwright install chromium`」的明確指示，不准整個 app crash |
| 其他依賴 | 零依賴優先，後台 UI 原生 HTML/JS，**不准有 build step** |
| 測試 | 內建 `node:test` + `--experimental-test-coverage` |
| Port | 預設 `30700`（實測空的）。`PORT` env 可覆蓋 |
| 綁定 | 預設 `127.0.0.1`。`HOST` 可改 |

多個小檔案 > 少數大檔案（單檔 200–400 行，上限 800）。函式 < 50 行。不可變寫法。

---

## 3. 架構

```
LocalDevTool
├── proxy/          經過代理的流量轉送 + 攔截紀錄
├── store/          SQLite 持久化 + 查詢 + 遮蔽
├── client/         注入到頁面的 inspector.js（右鍵挖掘）
├── inspector/      Playwright 管線（跨網域觀測、影片/API/授權分析）
└── admin/          /admin/network 面板 + REST API
```

Proxy 轉送邏輯**自己寫一份**，不要跟 LocalMonkey 共用模組。兩個專案現在刻意獨立發展，等真的出現重複再抽 `proxy-core`。

---

## 4. 資料模型（`data/localdevtool.db`，gitignore）

```
sites        id(slug) PK, name, target_origin, enabled, created_at, updated_at
sessions     id PK, site_id, label, started_at, ended_at
requests
  id            TEXT PK
  session_id    TEXT
  site_id       TEXT
  ts            TEXT NOT NULL          -- ISO
  source        TEXT NOT NULL          -- 'proxy' | 'playwright' | 'replay'
  method        TEXT NOT NULL
  url           TEXT NOT NULL
  host          TEXT NOT NULL
  path          TEXT NOT NULL
  status        INTEGER
  duration_ms   INTEGER                -- 見下方「duration 的真實含義」
  content_type  TEXT
  res_bytes     INTEGER
  req_headers   TEXT                   -- JSON，已遮蔽
  res_headers   TEXT                   -- JSON，已遮蔽
  req_body      TEXT                   -- 僅文字類型且 <= cap，否則 NULL
  res_body      TEXT
  body_truncated INTEGER NOT NULL DEFAULT 0
  auth_shape    TEXT                   -- 見 §5.2，例 'bearer:jwt-like'
  corr_id       TEXT                   -- 來自 client 的關聯 id
  replay_of     TEXT                   -- 若是 replay，指向原請求 id
findings     id PK, session_id, kind, label, detail(JSON), created_at
```

索引：`requests(ts)`、`requests(session_id, ts)`、`requests(host, path)`、`requests(corr_id)`。
res_body 的搜尋用 SQLite FTS5（內建，不需額外依賴）；建不起來就退回 `LIKE`，但要在 log 說一聲。

**duration 的真實含義**：這是 Node 發出上游請求到**取得回應標頭**的時間，不是 DevTools 顯示的完整瀏覽器載入時間。UI 的欄位名與 tooltip 必須講清楚，不要讓人誤讀。

保留策略：預設保留 7 天 / 50000 筆（取先到者），可用 env 調。啟動時與每小時清一次。

---

## 5. 遮蔽與機密處理（預設安全，這段不准偷工）

集中保存流量 = 集中保存憑證的風險。預設行為必須是安全的。

### 5.1 遮蔽清單（預設開啟）

這些 header 的值一律存成 `[REDACTED]`：
`cookie`、`set-cookie`、`authorization`、`proxy-authorization`、`x-api-key`、`x-auth-token`、`x-csrf-token`、`api-key`

回應 body 裡命中 `access_token`、`refresh_token`、`id_token`、`password`、`secret`、`client_secret` 這些 key 的值也要遮蔽（JSON 可解析時逐 key 處理；不可解析時跳過，不要用正則亂改 body）。

`LOCALDEVTOOL_CAPTURE_SECRETS=1` 可關閉遮蔽。README 要明確標示這是危險選項（會把憑證明文落地到 SQLite），且啟動時要在 log 印一行警告。

### 5.2 但要保留「形狀」——這才是使用者真正要的答案

使用者問「這站有沒有 JWT / session？」要回答得出來，但不需要存下 token 本身。所以遮蔽的同時把形狀記進 `auth_shape`：

- `bearer:jwt-like` — 三段 base64url，且第一段 decode 後是帶 `alg` 的 JSON
- `bearer:opaque` — Bearer 但不像 JWT
- `basic`
- `cookie:<name1,name2>` — 只記 cookie 名稱，不記值
- `signed-url` — URL query 帶 `token=` / `Expires=` / `Signature=` / `Policy=` / `hdnts=` / `X-Amz-Signature`

JWT 只 decode **header 與 payload**（它們不是機密、是 base64 不是加密），而且：
- **不准**聲稱簽章有效（我們沒有金鑰，驗不了）
- payload 裡的 `sub`/`email` 等個資要遮蔽，只呈現 `alg`、`typ`、`iss`、`exp`、`iat` 與「有哪些 claim」
- 措辭一律保守：「觀察到 Bearer Token，結構符合 JWT（未驗證簽章）」

### 5.3 Body 擷取上限

只擷取文字類型：`application/json`、`text/*`、`application/xml`、`application/javascript`、`application/vnd.apple.mpegurl`、`application/dash+xml`。
上限 256KB（`LOCALDEVTOOL_BODY_CAP` 可調），超過截斷並設 `body_truncated=1`。binary（影片、圖片）**只記 metadata，不存 body**。

---

## 6. Proxy pipeline

路由、header 過濾、HTML 根絕對路徑改寫、cookie 解析、3xx location 改寫、SSRF 防護 —— **與 LocalMonkey SPEC §4 和 §6.2 相同規則**，照同一套做（但程式碼各自一份）。差異只有兩點：

1. 每一筆轉送都要寫進 `requests`（寫入要非阻塞，不能拖慢代理；用同步 better-sqlite3 寫入但放在回應送出之後）
2. HTML 注入的是 `client/inspector.js`（固定一支），不是使用者腳本

被丟掉的回應 header 同 LocalMonkey（CSP、X-Frame-Options、content-encoding…）。CSP 一定要拿掉，不然注入的 inspector 會被擋。

---

## 7. 右鍵挖掘（Contextual Inspection）— 本專案的核心特色

### 7.1 注入端 `client/inspector.js`

必須是零依賴原生 JS，不污染頁面全域（全部包在 IIFE，唯一掛出去的是 `window.__LDT__`）。

- **攔截 `window.fetch` 與 `XMLHttpRequest`**：
  - 產生 `corr_id`（`crypto.randomUUID()`），塞進請求 header `x-ldt-corr`
  - 記錄：URL、method、發起時間、`new Error().stack`（JS 呼叫來源）、以及「當下的互動元素」
  - 包裝要**完全透明**：原本的回傳值、例外、`Response` 物件都不能被改變；任何自身錯誤都要吞掉並 `console.warn`，絕不能弄壞原站
- **互動元素追蹤**：全域 capture-phase 監聽 `pointerdown`/`click`/`contextmenu`，把 `event.target` 記成「最後互動元素」（含時間戳）。請求發生時若距最後互動 < 1500ms，就建立元素↔請求的關聯
- **媒體元素觀測**：
  - `MutationObserver` 看 `<video>`/`<audio>`/`<source>` 的 `src`/`poster` 變化
  - hook `HTMLMediaElement.prototype.src` setter 與 `.load()`
  - 偵測 `blob:` src → 代表走 MSE（hls.js / dash.js 之類），真正的來源要從被攔截到的 `.m3u8`/`.mpd`/segment 請求去推
  - hook `navigator.requestMediaKeySystemAccess` → 有呼叫就是 **EME/DRM** 跡象，記下 keySystem（`com.widevine.alpha` 等）
- **Overlay UI**：
  - `Alt + 點擊`任何元素，或原生右鍵選單旁的小浮動按鈕 → 開啟面板
  - 面板顯示三區：
    1. **這個元素本身的資源**：`src`、`srcset`、`poster`、`<source>`、CSS `background-image`、`currentSrc`
    2. **它觸發的請求**：時間窗內關聯到的請求（method / URL / status），點進去看詳情
    3. **追查結果**：按「追這個」→ 打 `POST /admin/api/trace`，server 端在已擷取的 response body 裡搜尋這個 URL/ID，找出「是哪支 API 給出這個網址的」
  - 面板要能關、不能卡住原站操作、z-index 夠高、`all: initial` 隔離樣式避免被原站 CSS 污染
- 上報走 `POST /__ldt/events`（`navigator.sendBeacon` 優先，失敗退 fetch），批次送、節流

### 7.2 Server 端關聯 `POST /admin/api/trace`

輸入：`{ url?, corrId?, sessionId?, needle? }`
做三件事並回傳證據鏈：
1. **誰給的**：在 `requests.res_body` 裡搜尋 needle（影片 URL、或它的檔名 / ID 片段）→ 回傳命中的那些 API 請求。這就是「看到影片 → 找出給它網址的 API」
2. **怎麼授權的**：那些命中的請求與媒體請求的 `auth_shape`、signed-url 參數
3. **時間線**：以 corr_id / 時間窗排序的請求序列

回傳要區分 **已證實**（body 裡真的找到）與 **疑似**（只是時間相近）。不准把猜測當事實。

---

## 8. Inspector pipeline（Playwright）— 補 proxy 看不到的部分

`POST /admin/api/inspect` `{ url, waitMs?, clickPlay? }` → 回報告 id；`GET /admin/api/inspect/:id` 取結果；`GET /admin/inspect/:id` 看 HTML 報告。

流程：Playwright 開 Chromium → 監聽 `request`/`response`/`requestfailed` → 載入頁面 → 等 `waitMs`（預設 8000）→（選擇性）嘗試點播放鍵 → 收集：

- **影片來源候選**：依副檔名與 content-type 命中 `.m3u8`、`.mpd`、`.mp4`、`.webm`、`.ts`、`video/*`、`application/vnd.apple.mpegurl`、`application/dash+xml`。m3u8 要抓下來解析：是 master 還是 media playlist、有哪些畫質變體、有沒有 `#EXT-X-KEY`（→ 加密）
- **相關 API**：回應 body 裡含有上述媒體 URL 的請求 → 標成「這支 API 給出了影片網址」
- **授權線索**：哪些請求帶了 `Authorization`（只記形狀，§5.2）、`Set-Cookie` 的 cookie 名、媒體 URL 的簽章參數
- **DRM 跡象**：EME 呼叫、`widevine`/`playready`/`fairplay` 字樣、licence 端點、`#EXT-X-KEY`
- **為什麼失敗**（很重要）：需要登入 → 要說「需要登入狀態才能分析」；有 DRM → 「受 DRM 保護，本工具不解密」；無媒體請求 → 「未觀察到媒體請求，可能需要互動或登入」

報告格式要像**證據表**而不是結論：每一項標 `confirmed` / `likely` / `unknown`，附上支撐它的請求 id。

Playwright 沒安裝時：`501` + `{ error, howToFix: 'npm i -D playwright && npx playwright install chromium' }`。不准 crash。
瀏覽器一定要在 `finally` 裡關掉（含 timeout 路徑），不能留孤兒 Chromium。單一時間最多 2 個並行 inspect job，超過排隊。

---

## 9. `/admin/network` 面板

- 表格：時間、method、host、path、status、content-type、大小、duration、來源（proxy/playwright/replay）
- 篩選：method、status（含 `2xx`/`4xx`/`5xx` 群組）、url 包含、content-type、時間範圍、session
- **搜尋 JSON 回應內容**（FTS5）
- 詳情：請求/回應 header、body（JSON 要 pretty print 並可折疊）、auth_shape、關聯的元素與 corr_id
- **比較**：選兩筆同 URL 的紀錄 → 文字 diff（自己寫簡單的 line diff，零依賴）。這是「比較同一支 API 不同時間的回應」
- **Replay**：重送某筆擷取到的請求，結果存成新紀錄並 `replay_of` 指回原本的。
  - ⚠️ Replay 是會產生副作用的動作（可能重複下單、重複發文）。UI 必須：非 GET/HEAD 要二次確認並顯示「這可能在目標網站產生真實副作用」；遮蔽過的 Authorization/Cookie **無法**重放（值已經不在了）→ 要明確說「此請求的憑證已遮蔽，replay 會以未授權狀態送出」，不要靜默送出一個一定失敗的請求讓人困惑
- 認證與 CORS 政策同 LocalMonkey SPEC §6.1（一律要 token、不設 CORS header、寫入檢查 Origin、`timingSafeEqual`、不准 localhost 免驗證）。`/__ldt/events` 是給被代理頁面打的，不需要 admin token，但要：只接受來自已登記 site 的 `Origin`/`Referer`、rate limit、payload 大小上限 64KB

---

## 10. 使用倫理（寫進 README 與啟動 log）

這是雙用途工具。定位必須清楚：

- 用在**自己擁有或已獲授權測試**的網站。README 開頭就要寫。
- 預設遮蔽憑證；不做 DRM 解密；不做批量下載。
- 啟動時印一行：`LocalDevTool — 僅用於自己擁有或已獲授權測試的網站。流量紀錄預設遮蔽憑證。`

---

## 11. 測試（必做，覆蓋率 ≥ 80%）

TDD：先紅後綠。server 綁 port 0 真的起起來，上游用假 origin server（不要 mock fetch）。Playwright 相關的測試用 fake 事件流（不要在 CI 真的開瀏覽器），但**要有一個** opt-in 的真實 smoke test（`TEST_PLAYWRIGHT=1` 才跑）。

必測清單：
- proxy：URL 組裝、header 過濾、CSP 被移除、HTML 注入 inspector、3xx location 改寫、set-cookie 改寫、非 HTML binary byte-for-byte 完整、上游掛掉回 502
- SSRF：各私網位址被拒、`ALLOW_PRIVATE=1` 放行、請求時再驗一次（DNS rebinding）
- **遮蔽（這組最重要，一條都不能漏）**：
  - `authorization` / `cookie` / `set-cookie` / `x-api-key` 在 DB 裡是 `[REDACTED]`
  - JSON body 裡的 `access_token` 被遮蔽，其他欄位完好
  - 不可解析的 body 不被破壞
  - `CAPTURE_SECRETS=1` 時才保留原值
  - **退化測試**：把遮蔽那行拿掉，這些測試要真的變紅（寫完後實際驗一次再還原，並在 commit message 說明驗過）
- `auth_shape` 判定：jwt-like（三段 + alg）、opaque bearer、basic、signed-url 各一例；JWT payload 的個資被遮蔽；**不得**出現任何聲稱簽章有效的字串
- body cap：超過 256KB 被截斷且 `body_truncated=1`；binary 不存 body
- trace：body 裡真的含該 URL → `confirmed`；只是時間相近 → `likely`
- m3u8 解析：master vs media、變體清單、`#EXT-X-KEY` → 標記加密
- inspect：Playwright 缺席時回 501 且帶 howToFix；fake 事件流能正確分類媒體/API/授權
- replay：GET 可重放；遮蔽過憑證的請求會帶警告；非 GET 需確認旗標
- 保留策略：超過上限的舊紀錄被清掉
- admin 認證：同 LocalMonkey 那組
- `/__ldt/events`：陌生 Origin 被拒、超大 payload 被拒

---

## 12. 交付物

- `README.md`：專業水準。開頭講清楚它不是 DevTools 替代品而是持續性觀測 + 右鍵挖掘；兩條管線的能力邊界表（哪些看得到、哪些看不到 — 這張表是誠實度的核心）；安裝、使用、倫理聲明、已知限制
- `CLAUDE.md`：架構、各檔責任、怎麼跑、踩過的坑
- `.env.example`、`.gitignore`（`node_modules`、`data/`、`*.db`、`.env`、`reports/`）
- `npm start`、`npm test`、`npm run test:coverage`

## 13. 完成的定義

1. `npm test` 全綠、覆蓋率 ≥ 80%，**把實際輸出貼出來**
2. 遮蔽的退化測試真的驗過（拿掉實作會變紅）
3. 真的起 server 跑一次端到端：登記一個公開網站 → 透過代理瀏覽 → `/admin/network` 看得到紀錄 → 紀錄裡的 cookie/authorization 是 `[REDACTED]`
4. commit + push 到 GitHub
5. 回報：做了什麼、沒做什麼、邊界在哪

commit 身分 `Jeffrey0117 <jeffby8@gmail.com>`，**不准**加任何 Claude / Co-Authored-By 署名。

# LocalDevTool

> Contextual Network Inspector — 自架的 HTTP 流量觀測 + 右鍵挖掘工具
>
> 一句話：**讓我知道網站為什麼會是這個樣子。**

---

## ⚖️ 先講使用倫理

**這個工具只能用在你自己擁有、或已獲明確授權測試的網站。**

它是一個雙用途工具，所以定位必須寫在最前面，而不是藏在文件最後：

- 預設**遮蔽憑證**。Cookie、Authorization、API key 一律存成 `[REDACTED]`。
- **不做 DRM 解密**、不繞過付費牆。遇到受保護的內容就誠實報告「受保護，無法分析內容」。
- **不做批量擷取 / 爬蟲 / 下載器**。核心不是把內容搬走，是理解實作。

這三條不是文件上的宣示，是實作出來的行為 —— 有測試在守，而且遮蔽那組測試做過
[退化驗證](#遮蔽的退化驗證)（把遮蔽程式碼拿掉，測試會真的變紅）。

啟動時也會印一次：

```
LocalDevTool — 僅用於自己擁有或已獲授權測試的網站。流量紀錄預設遮蔽憑證。
```

---

## 這不是 DevTools 的替代品

DevTools 早就能看所有請求，而且看得比這個工具更全。重造一個瀏覽器開發者工具沒有意義。

LocalDevTool 存在的理由是兩件 DevTools 做不到的事：

### 1. 觀測會持續發生、會被保存

不用每次按 F12。在 B 電腦上瀏覽，在 A 電腦上查紀錄。可以搜尋、可以比較**同一支 API
在不同時間的回應**。這是從「debugging tool」走向「observability system」的差別。

### 2. 右鍵挖掘（真正的特色）

你在網頁上看到一個東西 —— 一支影片、一個價格、一顆登入按鈕 —— 直接 `Alt + 點擊`
它，就能看到它背後的 HTTP 流程：

1. **這個元素本身的資源**：`src`、`srcset`、`poster`、`<source>`、CSS `background-image`、`currentSrc`
2. **它觸發的請求**：時間窗內關聯到的請求（method / URL / status）
3. **追查結果**：按「追這個」→ 在已擷取的回應內容裡搜尋這個網址，找出**是哪支 API 給出它的**

而且追查結果嚴格區分「已證實」與「疑似」—— 詳見 [不把猜測當事實](#不把猜測當事實)。

### 刻意不做的事

不做 JS breakpoint、DOM 編輯、CSS 檢查。那些 DevTools 本來就強。

姊妹專案 [LocalMonkey](https://github.com/Jeffrey0117/LocalMonkey) 是**改造**網站；
這一個是**理解**網站。技術底層一樣是 reverse proxy，關注點相反。

---

## 能力邊界（這張表是誠實度的核心）

Reverse proxy **只看得到經過自己的流量**。這是物理限制，不是 bug，所以必須講清楚。

原站 JS 如果直接 `fetch("https://api.other-cdn.com/x")`，那個請求從瀏覽器直接打到
別的網域，**不經過代理**，所以 Proxy 管線看不到（DevTools 看得到）。

所以本工具有兩條觀測管線：

| | **Proxy 管線** | **Inspector 管線（Playwright）** |
|---|---|---|
| **怎麼運作** | 你透過 `/p/<siteId>/` 瀏覽，流量經過代理 | 用受控 Chromium 開目標頁，監聽所有網路事件 |
| **同網域請求** | ✅ 看得到 | ✅ 看得到 |
| **跨網域請求**（CDN、第三方 API） | ❌ **看不到**（不經過代理） | ✅ 看得到 |
| **你自己的瀏覽行為** | ✅ 就是你在用的那個瀏覽器 | ❌ 是另一顆無頭瀏覽器，沒有你的登入狀態 |
| **登入後的頁面** | ✅ 你的 cookie 跟著走 | ❌ 需要登入狀態才能分析（會誠實回報） |
| **持續性** | ✅ 持續發生、長期保存、可搜尋可比較 | ❌ 一次性，要手動觸發 |
| **即時** | ✅ 邊逛邊記 | ❌ 跑完才有報告 |
| **回應內容（body）** | ✅ 文字類型（有上限） | ✅ 文字類型（有上限） |
| **WebSocket** | ❌ 不支援 | ❌ 沒有收集 |
| **瀏覽器快取命中的請求** | ❌ 根本沒發出來，誰都看不到 | ⚠️ 無頭瀏覽器是空快取，所以反而看得到 |
| **Service Worker 回應的請求** | ❌ 沒有出網路 | ⚠️ 部分看得到 |
| **DRM 保護的內容** | ⚠️ 看得到授權流程，看不到內容 | ⚠️ 同左。**本工具不解密** |
| **需要安裝** | 無（零依賴核心） | `npx playwright install chromium`（幾百 MB） |

**面板上的每一筆紀錄都標了 `來源`（proxy / playwright / replay）**，所以你永遠知道
眼前的資料是哪條管線來的 —— 不會把「proxy 沒看到」誤讀成「這個請求不存在」。

### `duration` 的真實含義

面板的欄位名叫 **「上游回應(ms)」**，不叫 "duration"，因為它不是你以為的那個東西：

> 這是 **Node 發出上游請求到取得回應標頭** 的時間。
>
> 它**不是** DevTools 顯示的完整瀏覽器載入時間，**也不含**下載 body 的時間，
> 更不含 DNS / TLS / 瀏覽器排隊 / 渲染。

欄位的 tooltip 也寫了同一段話。拿它跟 DevTools 的數字比對會對不上，那是正常的。

---

## 安裝

需要 **Node 24**（本機實測 v24.16.0）。

```bash
git clone https://github.com/Jeffrey0117/LocalDevTool.git
cd LocalDevTool
npm install --omit=optional   # 跳過 Playwright（它會下載幾百 MB 的 Chromium）
npm start
```

然後開啟啟動 log 裡印出的那個網址：

```
http://127.0.0.1:30700/admin/network?token=<你的 token>
```

`?token=` 只需要帶一次，之後會存成 cookie（`HttpOnly`、`SameSite=Strict`、`Path=/admin`）。

### 60 秒上手

1. 開 `/admin/network`，用 REST API 或面板登記一個網站：

   ```bash
   curl -X POST http://127.0.0.1:30700/admin/api/sites \
     -H "Authorization: Bearer $TOKEN" \
     -H "Origin: http://127.0.0.1:30700" \
     -H "Content-Type: application/json" \
     -d '{"id":"example","name":"Example","targetOrigin":"https://example.com"}'
   ```

   > ⚠️ Windows PowerShell 5.1 的 `curl.exe -d` 會吃掉內嵌的雙引號，JSON 會壞掉。
   > 在 Windows 上請用 git bash 的 curl，或寫一支 `.js` 用 `fetch`。

2. 瀏覽 `http://127.0.0.1:30700/p/example/` —— 你會看到 example.com，但流量已經被記下來了。

3. 回到 `/admin/network`，紀錄就在那裡。點任一列看詳情。

4. 在被代理的頁面上 `Alt + 點擊`任何元素 → 右鍵挖掘面板。

### 要用 Inspector（Playwright）管線的話

```bash
npm i -D playwright
npx playwright install chromium
```

沒裝也完全沒問題：app 照常啟動，流量面板照常運作，只有 `/admin/api/inspect`
會回 `501` 並附上上面這兩行指令。

```bash
curl -X POST http://127.0.0.1:30700/admin/api/inspect \
  -H "Authorization: Bearer $TOKEN" -H "Origin: http://127.0.0.1:30700" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/watch/42","waitMs":8000,"clickPlay":true}'
# → { "id": "insp_...", "reportUrl": "/admin/inspect/insp_..." }
```

報告是一張**證據表**：每一項都標 `confirmed` / `likely` / `unknown`，並附上支撐它的請求 id。

---

## 設定

所有設定都走環境變數，完整清單見 [`.env.example`](.env.example)。
這個專案**不會**自動載入 `.env`（零依賴，沒有 dotenv），請把變數設進環境再啟動。

| 變數 | 預設 | 說明 |
|---|---|---|
| `PORT` | `30700` | 監聽 port |
| `HOST` | `127.0.0.1` | 綁定位址。⚠️ 改成 `0.0.0.0` 等於把後台與流量紀錄曝露到區網 |
| `LOCALDEVTOOL_ADMIN_TOKEN` | 自動產生 | 沒設就產生 32 bytes 隨機 hex 寫進 `data/admin-token.txt` |
| `LOCALDEVTOOL_BODY_CAP` | `262144` | 單一 body 擷取上限（256KB） |
| `LOCALDEVTOOL_RETENTION_DAYS` | `7` | 保留天數 |
| `LOCALDEVTOOL_RETENTION_MAX` | `50000` | 保留筆數（與天數取先到者） |
| `LOCALDEVTOOL_CAPTURE_SECRETS` | 關閉 | **⚠️ 危險**，見下 |
| `LOCALDEVTOOL_ALLOW_PRIVATE` | 關閉 | **⚠️ 放寬 SSRF 防護**，見下 |

兩個危險開關刻意**只認字串 `"1"`** —— `"true"`、`"yes"` 一律視為關閉。
理由是「不小心打開」比「不小心沒打開」危險得多。

### ⚠️ `LOCALDEVTOOL_CAPTURE_SECRETS=1`

關閉憑證遮蔽。開啟後 **Cookie / Authorization / `access_token` 會以明文寫入 SQLite**。

那個 `.db` 檔從此等同一包憑證。請確認它不會被備份、不會被雲端同步、不會進 git
（`data/` 已經在 `.gitignore` 裡）。啟動時會印一段警告提醒你它是開著的。

只在你完全清楚自己在做什麼的時候用。多數情況你要的是 `auth_shape`（見下），不是 token 本身。

### ⚠️ `LOCALDEVTOOL_ALLOW_PRIVATE=1`

放行私網位址（loopback、`10.x`、`172.16-31.x`、`192.168.x`、link-local、CGNAT）。
代理自己的 dev server 需要這個，但它同時放寬了 SSRF 防護。

雲端 metadata 端點（`metadata.google.internal`、`metadata` 等）**不受此開關影響，一律封鎖**。

---

## 遮蔽與機密處理

集中保存流量 = 集中保存憑證的風險。所以預設行為必須是安全的。

### 這些 header 的值一律存成 `[REDACTED]`

`cookie`、`set-cookie`、`authorization`、`proxy-authorization`、`x-api-key`、
`x-auth-token`、`x-csrf-token`、`api-key`

### JSON body 裡這些 key 的值也一律遮蔽

`access_token`、`refresh_token`、`id_token`、`password`、`secret`、`client_secret`

遮蔽是**逐 key** 做的（遞迴進巢狀物件與陣列），而且**只在 body 可以解析成 JSON 時**才做。
不可解析的 body（HTML、JS、m3u8）**原樣保留、絕不用正則亂改** —— 寧可少遮也不要
悄悄破壞內容，讓你看到的紀錄與真實流量不符。

**順序很重要：先遮蔽，再截斷。** 反過來做的話，一個超過上限的 JSON 回應在截斷後
就不再是合法 JSON、遮蔽會整個跳過，尾端的 `access_token` 就明文落地了。有測試釘住這個順序。

### 但「形狀」會保留 —— 這才是你真正要的答案

你想問的通常不是「token 的值是什麼」，而是「這站用什麼在認人？」。所以遮蔽的同時
把形狀記進 `auth_shape`：

| `auth_shape` | 意思 |
|---|---|
| `bearer:jwt-like` | 三段 base64url，且第一段 decode 後是帶 `alg` 的 JSON |
| `bearer:opaque` | 是 Bearer，但不像 JWT |
| `basic` | HTTP Basic |
| `cookie:<name1,name2>` | 只記 cookie **名稱**，不記值 |
| `signed-url` | URL query 帶 `token=` / `Expires=` / `Signature=` / `Policy=` / `hdnts=` / `X-Amz-Signature` |
| `other` | 其他 scheme |

多種形狀同時成立時以 `+` 串接，顯著度高的排前面（例：`bearer:opaque+cookie:sid`）。
規格的範例是單值，但一支帶 Bearer 的請求同時用 cookie 維持 session 是常見事實，
丟掉其中一個會讓答案失真。

### JWT 的處理很保守

JWT 的 header 與 payload 是 base64url，**不是加密** —— 任何人都讀得到，所以 decode
它們本身不洩漏額外資訊。但本工具刻意：

- **只**輸出 `alg`、`typ`、`iss`、`exp`、`iat`，加上「有哪些 claim」的**名稱清單**
- `sub`、`email`、`name` 這類個資**只記名稱、不記值**
- **絕不聲稱簽章有效**（我們沒有金鑰，根本驗不了）

措辭一律是「觀察到 Bearer Token，結構符合 JWT（**未驗證簽章**）」。有測試在掃，
確保輸出裡不會出現任何「簽章有效 / valid signature / verified」之類的字串。

### Body 擷取上限

只擷取文字類型：`application/json`、`text/*`、`application/xml`、
`application/javascript`、`application/vnd.apple.mpegurl`、`application/dash+xml`
（以及 `*+json` / `*+xml` 後綴）。

上限 256KB，超過就截斷並設 `body_truncated=1`。
**binary（影片、圖片、字型）只記 metadata，不存 body。**

### 一個誠實的例外：完整 URL 會被保存

`requests.url` 存的是**完整網址，包含 query**。如果那是一個簽章網址，
簽章值就在裡面。

這是刻意的取捨：被觀測資源的網址**就是**「這個影片真正的來源是什麼」和「它怎麼授權的」
這兩個問題的答案，遮掉它等於廢掉本工具的核心功能。

我們做的是：`auth_shape` 會標成 `signed-url`、Inspector 報告的 `signedUrlParams`
只列**參數名稱不列值**，但網址本身保留。請把這個資料庫當成敏感資料看待。

---

## 不把猜測當事實

`POST /admin/api/trace` 回答「這個網址是誰給的」，回傳嚴格分成兩堆：

| | 意思 |
|---|---|
| **`confirmed`** | 在某筆已擷取的 `res_body` 裡**真的找到**這個網址。有證據。 |
| **`likely`** | 只是**時間相近**（3 秒內）。這不是證據，只是順序上有可能。 |

每一項都附 `evidence` 欄位說明憑什麼這樣說（例：`res_body 裡找到「master.m3u8」`）。

追查會由精確到寬鬆依序試幾個片段（完整 URL → pathname → 檔名），並回報
`needlesTried` 讓你知道它試過什麼。因為 API 回應裡常常只有相對路徑或 ID，
不會原封不動地寫出瀏覽器最後請求的完整 URL（簽章是 CDN 加的）。

Inspector 報告用同一套誠實度：每項標 `confirmed` / `likely` / `unknown`，
而且**為什麼失敗**會講清楚 —— 需要登入 / 受 DRM 保護 / 沒觀察到媒體請求（可能需要互動）。

---

## Replay 會產生真實副作用

面板可以重送任一筆擷取到的請求。這是一個**危險動作**，所以：

- **非 GET/HEAD 一定要二次確認**，確認框會明確寫「這可能在目標網站產生真實副作用
  （例如重複下單、重複發文）」
- **遮蔽過的憑證無法重放** —— 值已經不在資料庫裡了。這時候不會靜默送出一個註定
  失敗的請求讓你困惑，而是明確告訴你「此請求的 authorization 已遮蔽，replay 會以
  未授權狀態送出，目標很可能回 401/403」
- 字面的 `[REDACTED]` **絕不會**被當成憑證送出去（該 header 整個不送）
- 結果存成新紀錄，`source=replay`、`replay_of` 指回原本那筆

---

## 安全設計

### 管理後台一律要 token

- Token 來源：`LOCALDEVTOOL_ADMIN_TOKEN`，沒設就產生 32 bytes 隨機 hex 寫進
  `data/admin-token.txt`（已 gitignore）並印在 log
- **絕對沒有 hardcoded 預設 token**，也沒有「沒設就不驗證」
- 比對用 `crypto.timingSafeEqual`（長度不同先擋，避免它拋錯）

### 沒有「localhost 免驗證」

這條是刻意的，理由是真實事故：**本機免驗證 + 寬鬆 CORS = 你瀏覽器裡任何網頁都能
`fetch('http://127.0.0.1:30700/admin/api/requests')` 當管理員**，把你蒐集到的所有流量讀走。

所以三道防線是一起的：

1. 一律要 token
2. **不設任何 CORS header** → 別的 origin 即使騙到瀏覽器送出請求也讀不到回應內容
3. 寫入方法（POST/PUT/PATCH/DELETE）檢查 `Origin` 與 `Sec-Fetch-Site` → 跨站一律 403

### 注入的 inspector.js 裡沒有 admin token

被代理的頁面會跑原站的第三方 JS，和注入的腳本共用同一個執行環境。
**把 admin token 放進去等於把整個觀測資料庫交給原站。**

所以面板的「追這個」走 `/__ldt/trace`，不是 `/admin/api/trace`。那組端點：

- 不需要 admin token（注入腳本要打得到）
- 但 `Origin` 必須是代理自己的 origin
- 必須能從 `Referer` / `ldt_site` cookie 解析出一個**已登記且啟用**的 site
- 有 rate limit（預設 600 次/分鐘/IP）與 payload 上限（64KB）
- **只回摘要、不回 body**，而且**只看得到該 site 自己的紀錄**

完整的 header / body 要到 `/admin/network` 看，那裡要 admin token。

> 這是對規格的一個刻意偏離：規格 §7.1 寫面板按鈕打 `POST /admin/api/trace`，
> 但那會逼我們把 admin token 放進被代理的頁面。`/admin/api/trace` 仍然存在
> （面板自己用，回完整資料），只是注入腳本改走受限的 `/__ldt/trace`。

### SSRF 防護

- `target_origin` 只准 `http:` / `https:`
- **登記 site 時**和**每次代理請求時**都解析 DNS 並檢查
- 後者是關鍵：只在登記時檢查擋不住 **DNS rebinding**（第二次解析回 `127.0.0.1`）
- 擋掉：loopback、`10/8`、`172.16/12`、`192.168/16`、`169.254/16`、`0.0.0.0`、
  `100.64/10`、multicast、IPv6 `::1` / `fc00::/7` / `fe80::/10`，以及
  **IPv4-mapped IPv6**（`::ffff:127.0.0.1` 會穿透檢查）
- 判不出來的位址**保守擋下**，不是放行
- 雲端 metadata 主機名一律封鎖，不受 `ALLOW_PRIVATE` 影響

### Inspector 不留孤兒 Chromium

瀏覽器一律在 `finally` 裡關閉，含 timeout 與導航失敗路徑。
同一時間最多 2 個 inspect job（每個是一顆真的 Chromium，記憶體以百 MB 計），超過排隊。

---

## 架構

```
LocalDevTool
├── src/proxy/        經過代理的流量轉送 + 攔截紀錄
├── src/store/        SQLite 持久化 + 查詢 + 遮蔽呼叫點
├── src/redact/       遮蔽、auth_shape、JWT 保守解析
├── src/client/       注入到頁面的 inspector.js（右鍵挖掘）
├── src/inspector/    Playwright 管線（跨網域觀測、m3u8/API/授權分析）
├── src/events/       被代理頁面的上報端點
├── src/admin/        /admin/network 面板 + REST API
└── src/net/          SSRF 防護
```

轉送邏輯**自己寫一份**，不與 LocalMonkey 共用模組。兩個專案刻意獨立發展，
等真的出現重複再抽 `proxy-core`。

各檔責任與踩過的坑見 [CLAUDE.md](CLAUDE.md)。

---

## 測試

```bash
npm test              # 351 條，全綠
npm run test:coverage # 行覆蓋 93.6% / 分支 84.3% / 函式 92.7%
```

用 Node 內建的 `node:test`，不裝測試框架。Server 真的綁 port 0 起起來，
上游用同樣跑在 port 0 的**假 origin server**（不 mock fetch —— mock 掉就測不到
header 過濾、解壓、binary 完整性這些真東西）。

Playwright 相關的分析邏輯用 **fake 事件流**測，不在 CI 開瀏覽器。
另有一個 opt-in 的真實 smoke test：

```bash
TEST_PLAYWRIGHT=1 npm test   # 需要先 npx playwright install chromium
```

### 遮蔽的退化驗證

遮蔽那組測試做過**退化驗證** —— 這很重要，因為只對著正確程式碼寫的測試可能斷言了
完全錯的東西還一直綠燈，而在「憑證有沒有被遮蔽」這種地方，假的安全感比沒測試更糟。

做法：把遮蔽的實作**暫時拿掉**，確認測試真的變紅，再還原。

實測結果（拿掉 4 個遮蔽決策點：header 遮蔽分支、body 機密 key 分支、
JWT claim 白名單、擷取路徑的兩個 `redactHeaders` 呼叫）：

```
ℹ tests 351
ℹ pass 329
ℹ fail 21      ← 21 條轉紅
```

轉紅的涵蓋全部層次：純遮蔽模組、DB 落地、**真實代理整合路徑**
（「每一筆轉送都寫進 requests，且 cookie / authorization 在 DB 裡是 `[REDACTED]`」）、
以及 replay 的警告路徑。還原後 350 pass / 1 skipped。

---

## 已知限制

誠實清單，不假裝沒這回事：

1. **同一個瀏覽器同時開兩個代理網站會互搶 cookie。** 根路徑 fallback 靠 `ldt_site`
   cookie 認出「這個 `/assets/app.js` 屬於哪個站」，兩個站會互相覆蓋。
   解法是一次逛一個，或用不同的瀏覽器 profile。

2. **跨網域請求不經過 proxy 管線。** 見[能力邊界表](#能力邊界這張表是誠實度的核心)。
   這是 reverse proxy 的物理限制。要看跨網域請求用 Inspector 管線。

3. **`duration` 不是瀏覽器載入時間。** 見[上面的說明](#duration-的真實含義)。

4. **完整 URL（含簽章 query）會被保存。** 見[上面的說明](#一個誠實的例外完整-url-會被保存)。

5. **HTML 改寫是保守的、不是完整的。** 只改屬性（`src` / `href` / `action` /
   `poster` / `srcset`）裡的根絕對路徑。JS 在執行期用字串拼出來的 URL 不會被改寫，
   那些請求會直接打到原站（proxy 看不到）。刻意不改 inline script 裡的字串 ——
   那會把 `fetch("/api/x")` 一起改掉、弄壞原站邏輯。觀測工具把被觀測的站改壞是最糟的失敗。

6. **WebSocket 不支援。** proxy 不處理 upgrade，Inspector 也沒收集 WS 訊框。

7. **Inspector 的 Chromium 沒有你的登入狀態。** 需要登入的頁面會回報
   「需要登入狀態才能分析」。本工具不代為登入。

8. **`/__ldt/events` 的 rate limit 存在記憶體裡**，重啟歸零。為這個裝 Redis 不值得。

9. **Replay 不重放憑證。** 見[上面的說明](#replay-會產生真實副作用)。

10. **保留策略是「取先到者」**：7 天或 50000 筆，先到的那個生效。流量大的話
    實際保留時間會比 7 天短很多。

---

## 疑難排解

### `Could not locate the bindings file`（better-sqlite3）

**npm 12 預設封鎖依賴的 install script**，所以 `better-sqlite3` 的 `prebuild-install`
不會自動跑，原生模組就沒下載。

`package.json` 已經帶了 `allowScripts` 來核准它。如果還是壞掉（例如 npm 用
`node-gyp rebuild` 而這台沒有 MSVC），手動跑一次 prebuild：

```bash
cd node_modules/better-sqlite3
../.bin/prebuild-install
```

> ⚠️ `require('better-sqlite3')` 成功**不代表**它能用 —— 那只載入了 JS wrapper。
> 原生 binding 是 `new Database()` 的時候才載入的。要驗證就真的開一個 DB。

**不要**把 `better-sqlite3` 升到 `^13`。13 起拿掉了 prebuild，必須有 MSVC 才裝得起來。

### `port 30700 已被佔用`

```bash
PORT=41000 npm start
```

要找出佔用的程序（Windows）：

```powershell
Get-NetTCPConnection -LocalPort 30700 -State Listen | Select-Object OwningProcess
Stop-Process -Id <那個 PID>
```

用**確切 PID**，不要用 `taskkill /IM node.exe` —— 那會把其他 Node 程序一起殺掉。

### 面板是空的

- 確認你是透過 `/p/<siteId>/` 瀏覽，不是直接開原站網址
- 擷取是在回應送出**之後**才做的（刻意的，不能拖慢代理），所以會有幾百毫秒的延遲
- 看看 server log 有沒有 `流量紀錄寫入失敗` —— 擷取失敗不會弄壞代理，只會留 log

### 注入的 inspector 沒反應

- 確認回應的 `content-type` 含 `text/html`（只有 HTML 會被注入）
- 開 DevTools console 找 `[LocalDevTool] inspector 內部錯誤` —— 腳本的任何自身錯誤
  都會被吞掉並 `console.warn`，絕不會往上拋弄壞原站
- CSP 應該已經被代理移除；如果原站用 `<meta http-equiv>` 設 CSP，那個不在 header 裡，
  目前不會被移除

---

## 授權與免責

MIT。

這個工具描述的是它觀察到的 HTTP 行為。**它不是任何內容的使用授權。**
請只對自己擁有或已獲授權測試的網站使用。

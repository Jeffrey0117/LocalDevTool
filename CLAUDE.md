# CLAUDE.md — 給接手的 agent

LocalDevTool：自架的 HTTP 流量觀測 + 右鍵挖掘工具。
規格書是契約：[`docs/SPEC.md`](docs/SPEC.md)。使用者面向的說明在 [`README.md`](README.md)。

**動手前先讀規格 §5（遮蔽與機密處理）。** 那段是整個專案最不能偷工的地方，
而且它有退化測試在守 —— 改壞了測試會真的變紅。

---

## 怎麼跑

```bash
npm install --omit=optional   # 跳過 Playwright（它會下載幾百 MB Chromium）
npm start                     # 預設 127.0.0.1:30700
npm test                      # 351 條
npm run test:coverage         # 行 93.6% / 分支 84.3% / 函式 92.7%

TEST_PLAYWRIGHT=1 npm test    # 額外跑真實瀏覽器 smoke test（需先裝 chromium）
```

admin token 在啟動 log 或 `data/admin-token.txt`。

### 手動起長駐 server 的正確姿勢（Windows）

```powershell
Start-Process -WindowStyle Hidden cmd -ArgumentList '/c', "node C:\path\to\src\index.js > C:\path\to\log 2>&1"
```

收掉時用**確切 PID**：

```powershell
Get-NetTCPConnection -LocalPort 30700 -State Listen | Select-Object OwningProcess
Stop-Process -Id <PID>      # 父程序是 cmd.exe 的話也一起收
```

**嚴禁 `taskkill /IM node.exe`** —— 會把 agent 自己的 session 一起殺掉。

---

## 架構與各檔責任

```
src/
├── index.js              入口：banner（倫理宣告）、token 解析、保留迴圈、graceful shutdown
├── app.js                express 組裝。⚠️ 掛載順序會咬人，見下
├── config.js             env → 凍結的 config 物件。兩個危險開關只認字串 '1'
│
├── redact/               【規格 §5】整個專案的安全姿態都在這裡
│   ├── constants.js      REDACTED 標記 + 四組清單（header / body key / signed-url 參數 / JWT 白名單）
│   ├── headers.js        header 遮蔽。陣列值（多條 set-cookie）逐條遮，保留條目數
│   ├── body.js           JSON body 逐 key 遞迴遮蔽。不可解析就原樣回傳，絕不用正則改
│   ├── jwt.js            只 decode header/payload，白名單輸出，永不聲稱簽章有效
│   └── auth-shape.js     形狀判定。多形狀以 '+' 串接，顯著度高的在前
│
├── store/
│   ├── db.js             openDb：建目錄、WAL、foreign_keys、跑 migration
│   ├── schema.js         DDL + 四個索引 + PRAGMA user_version
│   ├── requests.js       ★ 擷取的單一入口：遮蔽 + body 上限 + auth_shape 一次做完
│   ├── request-filters.js 面板篩選 → SQL（全具名參數，零字串插值）
│   ├── search.js         FTS5（建不起來退 LIKE）+ 索引維護
│   ├── retention.js      保留策略（天數 / 筆數取先到者）+ 每小時迴圈
│   ├── sites.js          site CRUD + slug / origin 驗證 + 保留字
│   ├── sessions.js       觀測區段
│   └── findings.js       客戶端上報與 inspector 結論
│
├── proxy/                【規格 §6】轉送邏輯自己一份，不與 LocalMonkey 共用
│   ├── router.js         /p/:siteId/{*splat} 主路由 + 根路徑 fallback
│   ├── handler.js        ★ 轉送 + 回應組裝 + 回應送出後才擷取
│   ├── forward.js        實際 fetch。duration = 到「取得標頭」為止
│   ├── request-headers.js hop-by-hop 過濾。⚠️ accept-encoding 也要拿掉，見下
│   ├── response-headers.js CSP / content-encoding 等一律丟掉
│   ├── html-rewrite.js   根絕對路徑改寫 + inspector 注入。只認屬性，不認裸引號
│   ├── cookies.js        set-cookie 改寫（Domain / Secure 拿掉、SameSite=Lax）
│   ├── location.js       3xx location 改寫（同源改、跨域不改）
│   ├── site-resolver.js  fallback 的 siteId 解析：cookie > Referer > 放棄
│   ├── capture.js        組 record + 吞掉所有寫入錯誤
│   └── error-page.js     502 / 404 的人看得懂的頁面（不洩漏堆疊）
│
├── client/
│   ├── inspector.js      ★ 注入到頁面的腳本。⚠️ 裡面絕不能有 admin token
│   └── router.js         /__ldt/inspector.js 投遞
│
├── events/
│   ├── routes.js         /__ldt/events + /__ldt/trace（不需 admin token，三道限制）
│   └── rate-limit.js     記憶體固定視窗限流
│
├── inspector/            【規格 §8】Playwright 管線
│   ├── playwright.js     try/require。沒裝回 available:false，不讓 app 起不來
│   ├── run.js            收集事件。⚠️ 瀏覽器一律在 finally 關
│   ├── analyze.js        ★ 純函式：事件流 → 證據表。所以能用 fake 事件測
│   ├── m3u8.js           master vs media、變體、#EXT-X-KEY
│   ├── media-kind.js     副檔名優先、content-type 次之
│   ├── jobs.js           最多 2 並行。job 快照不可變
│   ├── api.js            端點。檢查順序有講究，見下
│   └── report-html.js    證據表 HTML
│
├── admin/                【規格 §9】
│   ├── auth.js           token + timingSafeEqual + 跨站寫入擋掉
│   ├── routes.js         組裝。/admin/api 之下才掛 express.json
│   ├── sites-api.js      site CRUD（登記時就做一次 SSRF 檢查）
│   ├── network-api.js    requests / search / compare / trace / replay
│   ├── trace.js          ★ confirmed vs likely 嚴格分開
│   ├── replay.js         副作用確認 + 遮蔽憑證的明確警告
│   ├── diff.js           零依賴 LCS 行 diff（2000 行上限）
│   ├── ui.js             面板靜態檔投遞
│   ├── panel.html        面板（原生 HTML，無 build step）
│   └── panel.js          面板前端
│
├── net/ssrf.js           登記時 + 每次請求時都驗 → 擋 DNS rebinding
└── util/
    ├── body-type.js      文字類型判定（規格 §5.3）
    └── ids.js            前綴 + UUID
```

★ = 改之前先讀完整個檔案與對應的測試。

---

## 踩過的坑（不要再踩一遍）

### 1. npm 12 封鎖依賴的 install script

`npm install` 之後 `better-sqlite3` 的原生 binding 可能根本沒下載。
`package.json` 已帶 `allowScripts` 核准它。

**`npm install-scripts approve better-sqlite3` 會回報成功但不一定真的裝好** ——
它跑的是 `node-gyp rebuild`，這台沒有 MSVC 所以會失敗，而 npm 仍然印
「Approved / added」。手動補：

```bash
cd node_modules/better-sqlite3 && ../.bin/prebuild-install
```

### 2. `require('better-sqlite3')` 成功不代表它能用

那只載入 JS wrapper。原生 binding 是 `new Database()` 才載入的。
我第一次驗證就是用 `require` 得到 "OK" 然後被騙了。**驗證原生模組一定要真的開一個 DB 並下一句 SQL。**

### 3. `accept-encoding` 必須從轉送清單移除

把瀏覽器的 `accept-encoding` 轉給上游，undici 就**不會**自動解壓（它只解自己協商
出來的編碼），而我們又固定丟掉 `content-encoding` → 瀏覽器把壓縮位元組當純文字看，整頁亂碼。

上游仍然會收到 `accept-encoding: gzip, deflate`，那是 **undici 自己加的**，是正確的。
測試斷言的是「客戶端帶來的值沒有被轉送」，不是「上游收不到這個 header」。

### 4. 遮蔽必須在截斷之前

超過上限的 JSON 回應截斷後就不是合法 JSON，`JSON.parse` 失敗 → 遮蔽整個跳過 →
尾端的 `access_token` 明文落地。`store/requests.js` 的 `prepareBody` 是「先遮再截」，
`test/store-requests.test.js` 的「遮蔽先於截斷」在釘住這個順序。**不要為了效能把順序換回來。**

### 5. Express 5 的 wildcard 與掛載後的 `req.path`

- wildcard 是 `/{*splat}`，不是 `/*`。`{}` 讓它可有可無，所以 `/p/demo` 也會中。
- **掛載過的 router 裡 `req.path` 是相對於掛載點的**（`/network` 而不是 `/admin/network`）。
  要完整路徑用 `req.originalUrl.split('?')[0]`。`?token=` 的 302 就是踩這個踩出來的。
- 代理的 upstream path 用 `req.originalUrl` 自己切，**不要用 `req.params`** ——
  params 會被解碼，而代理必須把百分號編碼原樣送到上游。

### 6. 根路徑 fallback 必須掛在最後

它會接住**所有**剩下的路徑。`app.js` 的掛載順序是
`client → events → admin → proxy 主路由 → 根 fallback`。
新增保留路徑一定要加在 fallback 之前，否則會被代理吃掉。

### 7. 擷取失敗不准弄壞代理

`handler.js` 用 `setImmediate` 在回應送出後才擷取，`capture.js` 的 `persistRecord`
吞掉所有錯誤只留 log。測試「擷取寫入失敗不會弄壞代理」用 `DROP TABLE requests`
來只弄壞寫入路徑 —— 直接 `db.close()` 會連 site 查詢都壞掉，就測到別的東西了。

### 8. HTML 改寫只認屬性

不要改成「裸引號後接單一斜線」。那會把 inline script 裡的 `fetch("/api/x")`
一起改掉、弄壞原站邏輯。觀測工具把被觀測的站改壞是最糟的失敗模式。

### 9. inspector.js 裡絕不能有 admin token

被代理頁面會跑原站的第三方 JS。面板的「追這個」走 `/__ldt/trace`（只回摘要、
只看得到該 site 的紀錄），不是 `/admin/api/trace`。這是對規格 §7.1 字面的刻意偏離，
README 有說明。

### 10. Inspector 端點的檢查順序

`url 存在 → 是 http(s) → Playwright 可用性 → SSRF(DNS)`。

可用性**要在 DNS 之前**：引擎不在的話沒必要解析 DNS，而且這樣 501 的測試就不依賴網路。

`api.js` 可注入 `inspectRunner` 與 `playwrightLoader`；注入 runner 時會**跳過**可用性
檢查（假 runner 不需要 Playwright）。測試靠這個用 fake 事件流跑完整路由。

### 11. `node --test` 的參數不是目錄

Node 24 把 `node --test test/` 的 `test/` 當成**檔案**去 require，會爆
`Cannot find module`。要用它自己的 glob：`node --test "test/**/*.test.js"`（要加引號）。

### 12. 測試不要留開著的 server

node:test 會等 event loop 清空。忘記 `close()` 的 server 會讓整個測試程序掛住不退出
（我就這樣讓一次 `npm test` 超時了）。每個起 server 的測試都要在結束前關掉。

### 13. Windows / PowerShell

- **PS 5.1 的 `curl.exe -d '{"a":"b"}'` 會吃掉內嵌雙引號** → 送到 server 變成非法
  JSON，看起來像 server 壞了其實是測試工具壞了。測 JSON API 用 git bash 的 curl
  或寫 `.js` 用 `fetch`。
- `node -e "..."` 在 PowerShell 裡會吃 backtick → 寫成 `.js` 檔再跑。
- 寫給 PS 5.1 吃的 `.ps1` 註解只用 ASCII（UTF-8 無 BOM 的中文註解會被 Big5 解碼、
  把下一行指令吃掉）。
- PowerShell 讀 UTF-8 的 log 檔會顯示成亂碼，那是**顯示**問題不是檔案問題。
- 任何 `spawn`/`exec` 都要帶 `windowsHide: true`（Node 預設 false，會閃黑窗搶焦點）。

---

## 改動時的紀律

### 遮蔽相關的改動要做退化驗證

不是「跑一下測試是綠的」就算。**把你改的那個遮蔽決策點暫時拿掉，確認測試真的變紅，再還原。**

理由：只對著正確程式碼寫的測試可能斷言了完全錯的東西還一直綠燈。在「憑證有沒有被
遮蔽」這種地方，假的安全感比沒測試更糟。

四個遮蔽決策點：
1. `redact/headers.js` 的 `SENSITIVE_HEADERS.has(...)` 分支
2. `redact/body.js` 的 `SENSITIVE_BODY_KEYS.has(...)` 分支
3. `redact/jwt.js` 的 `JWT_SAFE_CLAIMS` 白名單迴圈
4. `store/requests.js` 的兩個 `redactHeaders(...)` 呼叫

基準：全部拿掉 → 351 條裡有 **21 條**轉紅（涵蓋純模組、DB 落地、真實代理整合路徑、
replay 警告）。還原後 350 pass / 1 skipped。

**動手前先把檔案複製到暫存目錄**，免得還原失敗弄丟實作。

### 驗證「真的上線了」要看行為指紋

不要只看「指令回了成功」。原生模組那一題我就是被 npm 的成功訊息騙過一次。
要驗證就去量**只有新碼才會變的行為**。

### 風格

- 多個小檔案 > 少數大檔案（單檔 200–400 行為常態，上限 800）
- 函式 < 50 行，巢狀不超過 4 層
- 不可變寫法：展開成新物件，不原地改
- 錯誤處理要完整，不要空的 catch
- 沒有 hardcoded secret、沒有 hardcoded 預設 token
- 註解寫**為什麼**，不寫做了什麼（程式碼自己會說）

### commit

`<type>: <描述>`（feat / fix / refactor / docs / test / chore / perf）。
身分 `Jeffrey0117 <jeffby8@gmail.com>`，**不准**加任何 Claude / `Co-Authored-By` 署名。

---

## 還沒做的事

誠實清單，不是 TODO 承諾：

- **WebSocket**：proxy 不處理 upgrade，Inspector 也沒收集 WS 訊框。
- **`<meta http-equiv>` 的 CSP** 沒被移除（只處理 header 裡的）。
- **Session 的顆粒度只到「一次啟動」**：`index.js` 每次啟動開一個 session，
  該次所有 proxy 流量都掛在它底下（面板的 session 篩選因此有效）。
  但沒有「一次操作 = 一個 session」那種更細的框選，也沒有 UI 可以開新 session
  或結束它（`createSession` / `endSession` 在 store 層都有，只是沒接端點）。
- **Inspector 結果沒有寫進 `requests` 表**。它存在記憶體佇列裡（重啟即失，最多 50 筆），
  所以 `source='playwright'` 的紀錄實際上不會出現在流量面板。規格的資料模型
  允許這個來源，接起來是下一步。
- **`findings` 不受保留策略管**：`retention.sweep` 只清 `requests`。
  客戶端上報的 findings 會一直累積。
- **面板沒有 site 管理 UI**：REST API 齊全（`/admin/api/sites`），但面板只有流量表，
  建站要自己打 API。

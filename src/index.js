'use strict';

const path = require('node:path');

const { loadConfig } = require('./config');
const { openDb } = require('./store/db');
const { createApp } = require('./app');
const { resolveAdminToken } = require('./admin/auth');
const { createSession } = require('./store/sessions');
const { startRetentionLoop } = require('./store/retention');
const { isFtsAvailable } = require('./store/search');
const { loadPlaywright } = require('./inspector/playwright');

/**
 * 啟動入口。
 *
 * 規格 §10 要求啟動時印出倫理定位 —— 這不是裝飾品。這是一個雙用途工具，
 * 每次啟動都把定位說一次，是讓使用者（和未來接手的人）清楚它該用在哪裡。
 */

const ETHICS_LINE =
  'LocalDevTool — 僅用於自己擁有或已獲授權測試的網站。流量紀錄預設遮蔽憑證。';

function printBanner(config, token, db) {
  const origin = `http://${config.host === '0.0.0.0' ? '127.0.0.1' : config.host}:${config.port}`;

  console.log('');
  console.log(ETHICS_LINE);
  console.log('');
  console.log(`  流量面板   ${origin}/admin/network?token=${token.token}`);
  console.log(`  代理網址   ${origin}/p/<siteId>/`);
  console.log(`  資料庫     ${config.dbPath}`);
  console.log(
    `  admin token 來源：${
      { env: 'LOCALDEVTOOL_ADMIN_TOKEN 環境變數', file: token.file, generated: `新產生，已寫入 ${token.file}` }[
        token.source
      ]
    }`,
  );
  console.log(
    `  保留策略   ${config.retentionDays} 天 / ${config.retentionMax} 筆（取先到者）`,
  );
  console.log(
    `  body 搜尋  ${isFtsAvailable(db) ? 'FTS5' : 'LIKE（FTS5 不可用，較慢但功能相同）'}`,
  );

  const playwright = loadPlaywright();
  console.log(
    `  Inspector  ${
      playwright.available
        ? 'Playwright 可用'
        : `Playwright 未安裝 → /admin/api/inspect 會回 501（修復：${playwright.howToFix}）`
    }`,
  );

  if (config.captureSecrets) {
    console.warn('');
    console.warn('  ⚠  LOCALDEVTOOL_CAPTURE_SECRETS=1 已開啟：');
    console.warn('     Cookie / Authorization / access_token 會以**明文**寫入 SQLite。');
    console.warn('     這個資料庫檔案從此等同一包憑證，請確保它不會被備份或同步出去。');
  }
  if (config.allowPrivate) {
    console.warn('');
    console.warn('  ⚠  LOCALDEVTOOL_ALLOW_PRIVATE=1 已開啟：可代理私網位址（SSRF 防護放寬）。');
  }
  if (config.host !== '127.0.0.1') {
    console.warn('');
    console.warn(`  ⚠  綁定在 ${config.host}：管理後台與流量紀錄會曝露到網路上。`);
  }
  console.log('');
}

function main() {
  const config = loadConfig(process.env);

  let db;
  try {
    db = openDb(config.dbPath);
  } catch (error) {
    console.error(`[LocalDevTool] 啟動失敗：${error.message}`);
    process.exit(1);
    return;
  }

  const token = resolveAdminToken(config, { dataDir: path.dirname(config.dbPath) });

  // 每次啟動開一個 session，所有這次跑出來的流量都掛在它底下。
  // 這讓面板的 session 篩選有意義（= 篩「哪一次啟動」），也是比較
  // 「同一支 API 在不同時間的回應」時用來分組的依據。
  let sessionId = null;
  try {
    sessionId = createSession(db, { label: `啟動於 ${new Date().toISOString()}` }).id;
  } catch (error) {
    // 開不了 session 不該讓整個服務起不來，只是少了分組而已。
    console.warn(`[LocalDevTool] 無法建立 session（流量仍會記錄）：${error.message}`);
  }

  const app = createApp({ db, config, adminToken: token.token, sessionId });

  const stopRetention = startRetentionLoop(db, config);

  const server = app.listen(config.port, config.host, () => {
    printBanner(config, token, db);
  });

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(
        `[LocalDevTool] port ${config.port} 已被佔用。用 PORT=<其他> npm start 換一個，` +
          '或先停掉佔用的程序。',
      );
    } else {
      console.error('[LocalDevTool] 伺服器錯誤:', error);
    }
    process.exit(1);
  });

  const shutdown = (signal) => {
    console.log(`\n[LocalDevTool] 收到 ${signal}，正在關閉…`);
    stopRetention();
    server.close(() => {
      try {
        db.close();
      } catch (error) {
        console.error('[LocalDevTool] 關閉資料庫時出錯:', error.message);
      }
      process.exit(0);
    });
    // 連線沒收完也不要卡住不退出。
    setTimeout(() => process.exit(0), 5000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

if (require.main === module) main();

module.exports = { main, ETHICS_LINE };

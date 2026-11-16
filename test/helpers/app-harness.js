'use strict';

const { createApp } = require('../../src/app');
const { loadConfig } = require('../../src/config');
const { openDb } = require('../../src/store/db');
const { track } = require('./open-resources');

const ADMIN_TOKEN = 'test-token-not-a-real-secret';

/**
 * 起一台真的 LocalDevTool（綁 port 0）+ 記憶體 DB。
 *
 * @param {object} [envOverrides] 覆寫 env（例如 LOCALDEVTOOL_CAPTURE_SECRETS）
 * @param {object} [depOverrides] 注入依賴（inspectRunner / playwrightLoader）
 * @returns {Promise<{ baseUrl, db, config, close, app }>}
 */
async function startTestApp(envOverrides = {}, depOverrides = {}) {
  const config = loadConfig({
    LOCALDEVTOOL_ADMIN_TOKEN: ADMIN_TOKEN,
    // 測試的上游是 127.0.0.1 的假 origin server，不放行私網就什麼都測不到。
    LOCALDEVTOOL_ALLOW_PRIVATE: '1',
    ...envOverrides,
  });

  const db = openDb(':memory:');
  const app = createApp({ db, config, adminToken: ADMIN_TOKEN, ...depOverrides });

  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const { port } = server.address();

  return {
    app,
    db,
    config,
    adminToken: ADMIN_TOKEN,
    baseUrl: `http://127.0.0.1:${port}`,
    // track() 讓它同時登記進「還開著的資源」表，並且變成可重複呼叫。
    // 測試內原本的 await close() 照樣有效；測試檔的 after(closeAllOpen) 是失敗時的安全網。
    close: track(async () => {
      await new Promise((resolve) => server.close(resolve));
      db.close();
    }),
  };
}

/** 帶 admin token 的 fetch。 */
function adminFetch(baseUrl, path, options = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${ADMIN_TOKEN}`,
      // 寫入會檢查 Origin，同源才放行。
      origin: baseUrl,
      ...(options.headers || {}),
    },
  });
}

module.exports = { startTestApp, adminFetch, ADMIN_TOKEN };

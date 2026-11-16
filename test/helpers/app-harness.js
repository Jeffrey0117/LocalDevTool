'use strict';

const { createApp } = require('../../src/app');
const { loadConfig } = require('../../src/config');
const { openDb } = require('../../src/store/db');

const ADMIN_TOKEN = 'test-token-not-a-real-secret';

/**
 * 起一台真的 LocalDevTool（綁 port 0）+ 記憶體 DB。
 *
 * @param {object} [envOverrides] 覆寫 env（例如 LOCALDEVTOOL_CAPTURE_SECRETS）
 * @returns {Promise<{ baseUrl, db, config, close, app }>}
 */
async function startTestApp(envOverrides = {}) {
  const config = loadConfig({
    LOCALDEVTOOL_ADMIN_TOKEN: ADMIN_TOKEN,
    // 測試的上游是 127.0.0.1 的假 origin server，不放行私網就什麼都測不到。
    LOCALDEVTOOL_ALLOW_PRIVATE: '1',
    ...envOverrides,
  });

  const db = openDb(':memory:');
  const app = createApp({ db, config, adminToken: ADMIN_TOKEN });

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
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      db.close();
    },
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

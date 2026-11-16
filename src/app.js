'use strict';

const express = require('express');

const { createClientRouter } = require('./client/router');
const { createProxyRouter, createRootFallback } = require('./proxy/router');
const { createAdminRouter } = require('./admin/routes');
const { createEventsRouter } = require('./events/routes');

/**
 * 組裝 express app（規格 §3）。
 *
 * 掛載順序是會咬人的地方：代理的根路徑 fallback 會吃掉**所有**路徑，
 * 所以它必須是最後一個。保留路徑（/admin、/__ldt）一定要先註冊。
 *
 * @param {{ db: object, config: object, adminToken: string }} deps
 * @returns {import('express').Express}
 */
function createApp(deps) {
  const app = express();

  // 代理是這個產品的本體，Express 的美化沒有意義，也不要洩漏框架資訊。
  app.disable('x-powered-by');
  app.disable('etag');

  // 1. 保留路徑：注入腳本的投遞
  app.use(createClientRouter());

  // 2. 被代理頁面的上報端點（不需要 admin token，但有 Origin / site / rate limit 三道限制）
  app.use(createEventsRouter(deps));

  // 3. 管理後台（一律要 token，不設 CORS header，寫入檢查 Origin）
  app.use('/admin', createAdminRouter(deps));

  // 4. 代理主路由 /p/:siteId/*
  app.use(createProxyRouter(deps));

  // 5. 根路徑 fallback —— 必須最後，它會接住所有剩下的路徑
  app.use(createRootFallback(deps));

  // eslint-disable-next-line no-unused-vars -- express 靠四個參數認出 error handler
  app.use((error, req, res, next) => {
    console.error('[LocalDevTool] 未預期的錯誤:', error);
    if (res.headersSent) return;
    res.status(500).type('text/plain; charset=utf-8');
    res.send('LocalDevTool 內部錯誤，詳情請看伺服器 log。');
  });

  return app;
}

module.exports = { createApp };

'use strict';

const express = require('express');

const { createAdminAuth } = require('./auth');
const { createNetworkApi } = require('./network-api');
const { createSitesApi } = require('./sites-api');
const { renderNetworkPanel, renderPanelScript } = require('./ui');
const { createInspectorApi } = require('../inspector/api');
const { renderInspectReport } = require('../inspector/report-html');

/**
 * 管理後台的路由組裝（規格 §9）。
 *
 * 注意：這裡**不設任何 CORS header**。那不是忘了寫，是刻意的 ——
 * 不設 CORS，別的 origin 的網頁即使騙到瀏覽器送出請求也讀不到回應內容。
 */

/** @param {{ db: object, config: object, adminToken: string }} deps */
function createAdminRouter(deps) {
  const router = express.Router();

  router.use(createAdminAuth(deps.adminToken));

  // 面板本體（原生 HTML/JS，無 build step）
  router.get('/', (req, res) => {
    res.redirect(302, '/admin/network');
  });
  router.get('/network', (req, res) => {
    res.type('text/html; charset=utf-8').send(renderNetworkPanel());
  });
  router.get('/panel.js', (req, res) => {
    res.type('application/javascript; charset=utf-8').set('cache-control', 'no-cache');
    res.send(renderPanelScript());
  });

  const inspector = createInspectorApi(deps);

  // Inspect 報告的 HTML 版（規格 §8：證據表，不是結論）
  router.get('/inspect/:id', (req, res) => {
    const job = inspector.queue.get(req.params.id);
    if (job === null) {
      res.status(404).type('text/plain; charset=utf-8').send(`找不到 inspect 報告 ${req.params.id}`);
      return;
    }
    res.type('text/html; charset=utf-8').send(renderInspectReport(job));
  });

  const api = express.Router();
  api.use(express.json({ limit: '2mb' }));
  api.use(createSitesApi(deps));
  api.use(createNetworkApi(deps));
  api.use(inspector.api);

  // JSON 解析失敗要回 400，不是 500。
  // eslint-disable-next-line no-unused-vars -- express 靠四個參數認出 error handler
  api.use((error, req, res, next) => {
    if (error.type === 'entity.parse.failed') {
      res.status(400).json({ error: '請求 body 不是合法的 JSON' });
      return;
    }
    if (error.type === 'entity.too.large') {
      res.status(413).json({ error: '請求 body 太大' });
      return;
    }
    console.error('[LocalDevTool] admin API 錯誤:', error);
    res.status(500).json({ error: 'admin API 內部錯誤，詳情請看伺服器 log' });
  });

  router.use('/api', api);
  return router;
}

module.exports = { createAdminRouter };

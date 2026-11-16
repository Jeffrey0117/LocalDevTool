'use strict';

const express = require('express');

const { createJobQueue } = require('./jobs');
const { runInspection } = require('./run');
const { analyzeEvents } = require('./analyze');
const { loadPlaywright: defaultLoader } = require('./playwright');
const { assertSafeTarget } = require('../net/ssrf');

/**
 * Inspector 管線的端點（規格 §8）。
 *
 * 可注入 `inspectRunner`（怎麼跑一次觀測）與 `playwrightLoader`（怎麼判斷可用性），
 * 讓測試能用 fake 事件流完整驗證分析與路由，不必真的下載 Chromium。
 */

/**
 * @param {{ db: object, config: object, inspectRunner?: Function, playwrightLoader?: Function }} deps
 * @returns {{ api: import('express').Router, queue: object }}
 */
function createInspectorApi(deps) {
  const loader = deps.playwrightLoader || defaultLoader;
  const usingDefaultRunner = typeof deps.inspectRunner !== 'function';
  const runner = deps.inspectRunner || runInspection;

  const queue = createJobQueue({
    maxConcurrent: deps.config.maxInspectJobs,
    runner: async (input) => {
      const raw = await runner(input, { config: deps.config, loadPlaywright: loader });
      return analyzeEvents(raw.events, { pageUrl: raw.url, waitMs: input.waitMs });
    },
  });

  const api = express.Router();

  api.post('/inspect', async (req, res) => {
    const body = req.body || {};

    if (typeof body.url !== 'string' || body.url.trim() === '') {
      res.status(400).json({ error: '要帶 url（要分析哪一頁）' });
      return;
    }

    // 協定檢查放在最前面：便宜、不需要網路，而且錯得最明顯。
    let target;
    try {
      target = new URL(body.url);
    } catch {
      res.status(400).json({ error: `url 不是合法網址：${body.url}` });
      return;
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      res.status(400).json({ error: `只接受 http(s)，收到 ${target.protocol}` });
      return;
    }

    // 引擎不在就先說清楚 —— 不必為了一個跑不起來的 job 去解析 DNS。
    if (usingDefaultRunner) {
      const availability = loader();
      if (!availability.available) {
        res.status(501).json({
          error: `Inspector 需要 Playwright，但它不可用：${availability.error}`,
          howToFix: availability.howToFix,
        });
        return;
      }
    }

    try {
      await assertSafeTarget(target.origin, { allowPrivate: deps.config.allowPrivate });
    } catch (error) {
      res.status(400).json({ error: error.message, code: error.code });
      return;
    }

    const submitted = queue.submit({
      url: body.url,
      waitMs: Number.isFinite(Number(body.waitMs)) ? Number(body.waitMs) : undefined,
      clickPlay: body.clickPlay === true,
    });

    res.status(202).json({
      ...submitted,
      reportUrl: `/admin/inspect/${submitted.id}`,
      pollUrl: `/admin/api/inspect/${submitted.id}`,
    });
  });

  api.get('/inspect/:id', (req, res) => {
    const job = queue.get(req.params.id);
    if (job === null) {
      res.status(404).json({ error: `找不到 inspect 報告 ${req.params.id}` });
      return;
    }
    res.json(job);
  });

  return { api, queue };
}

module.exports = { createInspectorApi };

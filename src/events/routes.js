'use strict';

const express = require('express');

const { createFinding } = require('../store/findings');
const { resolveSiteFromHeaders } = require('../proxy/site-resolver');
const { createRateLimiter } = require('./rate-limit');
const { trace } = require('../admin/trace');

/**
 * 被代理頁面用的端點（規格 §7.1 / §9）。
 *
 * 這組**不需要 admin token** —— 它是給注入的 inspector.js 打的，而那支腳本跑在
 * 被代理的頁面上，和原站的第三方 JS 共用一個執行環境。把 admin token 放進去
 * 等於把整個觀測資料庫交給原站，所以絕對不做。
 *
 * 取而代之的三道限制：
 *  1. `Origin` 必須是代理自己的 origin（被代理頁面就是從這裡送出來的）
 *  2. 必須能從 Referer / `ldt_site` cookie 解析出一個**已登記且啟用**的 site
 *  3. rate limit + payload 大小上限
 *
 * 另外 /__ldt/trace 只回摘要、不回 body，而且只看得到該 site 自己的紀錄 ——
 * 不然一個惡意的原站頁面就能把你蒐集到的所有流量讀走。
 */

const MAX_EVENTS_PER_REQUEST = 200;

const KIND_MAP = {
  request: 'client-request',
  media: 'client-media',
  drm: 'client-drm',
};

/** 被代理頁面是從代理自己的 origin 載入的，所以 Origin 必須相符。 */
function hasAcceptableOrigin(req) {
  const origin = req.headers.origin;
  // sendBeacon / 某些瀏覽器情境可能不帶 Origin；這時靠第 2 道（site 解析）把關。
  if (typeof origin !== 'string' || origin === '') return true;
  return origin === `${req.protocol}://${req.headers.host}`;
}

/** @param {object} event @returns {string} */
function labelFor(event) {
  if (event.kind === 'drm') return `EME: ${event.keySystem || '(未知 keySystem)'}`;
  if (event.kind === 'media') return `media: ${String(event.url || '').slice(0, 300)}`;
  if (event.kind === 'request') {
    return `${event.method || 'GET'} ${String(event.url || '').slice(0, 300)}`;
  }
  return `client: ${event.kind || 'unknown'}`;
}

/** @param {{ db: object, config: object }} deps @returns {import('express').Router} */
function createEventsRouter(deps) {
  const router = express.Router();
  const limiter = createRateLimiter(deps.config.eventRateLimitPerMinute);

  const pruneTimer = setInterval(() => limiter.prune(), 5 * 60 * 1000);
  pruneTimer.unref();

  /** 共用的守門：Origin + 已登記 site + rate limit。 */
  function gate(req, res) {
    if (!hasAcceptableOrigin(req)) {
      res.status(403).json({ error: 'Origin 不是本代理，拒絕。' });
      return null;
    }

    const { site } = resolveSiteFromHeaders(deps.db, req.headers);
    if (site === null) {
      res.status(403).json({
        error:
          '無法確認這個請求來自已登記的 site（需要 /p/<siteId>/ 的 Referer 或 ldt_site cookie）。',
      });
      return null;
    }

    const verdict = limiter.check(req.ip || 'unknown');
    if (!verdict.allowed) {
      res.set('retry-after', String(verdict.retryAfterSeconds));
      res.status(429).json({ error: '上報太頻繁，請稍後再試。' });
      return null;
    }
    return site;
  }

  const parseJson = express.json({ limit: deps.config.eventPayloadCap, type: '*/*' });

  router.post('/__ldt/events', parseJson, (req, res) => {
    const site = gate(req, res);
    if (site === null) return;

    const body = req.body || {};
    if (!Array.isArray(body.events)) {
      res.status(400).json({ error: 'events 必須是陣列' });
      return;
    }

    const events = body.events.slice(0, MAX_EVENTS_PER_REQUEST);
    for (const event of events) {
      if (event === null || typeof event !== 'object') continue;
      try {
        createFinding(deps.db, {
          sessionId: typeof body.sessionId === 'string' ? body.sessionId : null,
          kind: KIND_MAP[event.kind] || 'client-event',
          label: labelFor(event),
          detail: { ...event, siteId: site.id },
        });
      } catch (error) {
        // 一筆壞事件不該讓整批失敗，也不該讓頁面看到錯誤。
        console.warn(`[LocalDevTool] 客戶端事件寫入失敗：${error.message}`);
      }
    }

    res.status(204).end();
  });

  router.post('/__ldt/trace', parseJson, (req, res) => {
    const site = gate(req, res);
    if (site === null) return;

    const body = req.body || {};
    // siteId 一律用伺服器端解析出來的，不信客戶端傳來的值。
    const result = trace(deps.db, {
      url: typeof body.url === 'string' ? body.url : undefined,
      needle: typeof body.needle === 'string' ? body.needle : undefined,
      corrId: typeof body.corrId === 'string' ? body.corrId : undefined,
      siteId: site.id,
    });

    res.json({
      needle: result.needle,
      confirmed: result.confirmed,
      likely: result.likely,
      auth: result.auth,
      note: result.note,
    });
  });

  // eslint-disable-next-line no-unused-vars -- express 靠四個參數認出 error handler
  router.use((error, req, res, next) => {
    if (error.type === 'entity.too.large') {
      res.status(413).json({ error: `payload 超過 ${deps.config.eventPayloadCap} bytes 上限` });
      return;
    }
    if (error.type === 'entity.parse.failed') {
      res.status(400).json({ error: '不是合法的 JSON' });
      return;
    }
    console.error('[LocalDevTool] /__ldt 端點錯誤:', error);
    res.status(500).json({ error: '內部錯誤' });
  });

  return router;
}

module.exports = { createEventsRouter, MAX_EVENTS_PER_REQUEST };

'use strict';

const express = require('express');

const { getSite } = require('../store/sites');
const { resolveSiteFromHeaders } = require('./site-resolver');
const { proxyRequest } = require('./handler');
const { renderSiteNotFoundPage } = require('./error-page');

/**
 * 代理路由（規格 §6 / LocalMonkey §4.1）。
 *
 * 兩條路：
 *  1. `/p/:siteId/*` — 主路由，siteId 明確寫在網址裡
 *  2. 其他所有路徑 — 根路徑 fallback，用來接住頁面裡「根絕對路徑」的資源請求
 *     （`/assets/app.js`）。siteId 靠 cookie / Referer 推。
 */

/** @param {string} path @returns {string} */
function notFound(res, requestPath, hint) {
  res.status(404).type('text/html; charset=utf-8');
  res.send(renderSiteNotFoundPage({ requestPath, hint }));
}

/**
 * 從 originalUrl 取出要轉送的 path（含 query），刻意不用 req.params ——
 * params 會被解碼，而代理必須把編碼原樣送到上游。
 *
 * @param {string} originalUrl 例 /p/demo/a/b%20c?q=1
 * @param {string} siteId
 * @returns {string} 例 /a/b%20c?q=1
 */
function stripSitePrefix(originalUrl, siteId) {
  const prefix = `/p/${siteId}`;
  const rest = originalUrl.slice(prefix.length);
  if (rest === '' ) return '/';
  if (rest.startsWith('?')) return `/${rest}`;
  return rest;
}

/**
 * @param {{ db: import('better-sqlite3').Database, config: object }} deps
 * @returns {import('express').Router}
 */
function createProxyRouter(deps) {
  const router = express.Router();

  // Express 5 的 wildcard 是 `{*splat}`（大括號讓它可有可無），不是 `/*`。
  router.all('/p/:siteId{/*splat}', async (req, res, next) => {
    const { siteId } = req.params;
    const site = getSite(deps.db, siteId);

    if (site === null) {
      notFound(res, req.originalUrl, `沒有登記 id 為「${siteId}」的 site。`);
      return;
    }
    if (site.enabled !== 1) {
      notFound(res, req.originalUrl, `site「${siteId}」目前是停用狀態。`);
      return;
    }

    try {
      await proxyRequest(deps, {
        req,
        res,
        site,
        pathWithQuery: stripSitePrefix(req.originalUrl, siteId),
        isMainRoute: true,
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

/**
 * 根路徑 fallback。必須掛在所有其他路由**之後**。
 * @param {{ db: import('better-sqlite3').Database, config: object }} deps
 * @returns {import('express').RequestHandler}
 */
function createRootFallback(deps) {
  return async (req, res, next) => {
    const { site, via } = resolveSiteFromHeaders(deps.db, req.headers);

    if (site === null) {
      notFound(
        res,
        req.originalUrl,
        '無法判斷這個請求屬於哪個 site：沒有 ldt_site cookie，Referer 裡也沒有 /p/<siteId>/。',
      );
      return;
    }

    try {
      await proxyRequest(deps, {
        req,
        res,
        site,
        pathWithQuery: req.originalUrl,
        isMainRoute: false,
        resolvedVia: via,
      });
    } catch (error) {
      next(error);
    }
  };
}

module.exports = { createProxyRouter, createRootFallback, stripSitePrefix };

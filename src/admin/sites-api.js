'use strict';

const express = require('express');

const { createSite, getSite, listSites, updateSite, deleteSite, normalizeOrigin } = require('../store/sites');
const { assertSafeTarget } = require('../net/ssrf');

/**
 * Site 管理 API（規格 §9）。
 *
 * 新增 / 更新時就做一次 SSRF 檢查 —— 不是因為它夠用（代理時還會再驗一次，
 * 那才是擋 DNS rebinding 的那道），而是為了讓使用者在登記的當下就知道這個目標不行，
 * 而不是等到瀏覽時才拿到一個莫名的 502。
 */

/** @param {{ db: object, config: object }} deps @returns {import('express').Router} */
function createSitesApi(deps) {
  const router = express.Router();

  router.get('/sites', (req, res) => {
    res.json({ rows: listSites(deps.db) });
  });

  router.get('/sites/:id', (req, res) => {
    const site = getSite(deps.db, req.params.id);
    if (site === null) {
      res.status(404).json({ error: `找不到 site ${req.params.id}` });
      return;
    }
    res.json(site);
  });

  router.post('/sites', async (req, res) => {
    const body = req.body || {};

    let origin;
    try {
      origin = normalizeOrigin(body.targetOrigin);
    } catch (error) {
      res.status(400).json({ error: error.message });
      return;
    }

    try {
      await assertSafeTarget(origin, { allowPrivate: deps.config.allowPrivate });
    } catch (error) {
      res.status(400).json({ error: error.message, code: error.code });
      return;
    }

    try {
      const site = createSite(deps.db, { ...body, targetOrigin: origin });
      res.status(201).json(site);
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  router.put('/sites/:id', async (req, res) => {
    const body = req.body || {};

    if (body.targetOrigin !== undefined) {
      try {
        const origin = normalizeOrigin(body.targetOrigin);
        await assertSafeTarget(origin, { allowPrivate: deps.config.allowPrivate });
      } catch (error) {
        res.status(400).json({ error: error.message, code: error.code });
        return;
      }
    }

    try {
      const site = updateSite(deps.db, req.params.id, body);
      if (site === null) {
        res.status(404).json({ error: `找不到 site ${req.params.id}` });
        return;
      }
      res.json(site);
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  router.delete('/sites/:id', (req, res) => {
    if (!deleteSite(deps.db, req.params.id)) {
      res.status(404).json({ error: `找不到 site ${req.params.id}` });
      return;
    }
    res.status(204).end();
  });

  return router;
}

module.exports = { createSitesApi };

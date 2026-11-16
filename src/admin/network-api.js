'use strict';

const express = require('express');

const { listRequests, getRequest } = require('../store/requests');
const { searchBodies, isFtsAvailable } = require('../store/search');
const { listSessions } = require('../store/sessions');
const { listFindings } = require('../store/findings');
const { lineDiff } = require('./diff');
const { trace } = require('./trace');
const { replayRequest } = require('./replay');

/**
 * 流量面板的 REST API（規格 §9）。
 * 掛在 /admin/api 之下，認證由上層的 createAdminAuth 負責。
 */

/** @param {{ db: object, config: object }} deps @returns {import('express').Router} */
function createNetworkApi(deps) {
  const router = express.Router();

  router.get('/requests', (req, res) => {
    res.json(listRequests(deps.db, req.query));
  });

  router.get('/requests/:id', (req, res) => {
    const found = getRequest(deps.db, req.params.id);
    if (found === null) {
      res.status(404).json({ error: `找不到 request ${req.params.id}` });
      return;
    }
    res.json(found);
  });

  router.get('/search', (req, res) => {
    const query = typeof req.query.q === 'string' ? req.query.q : '';
    res.json({
      query,
      ftsAvailable: isFtsAvailable(deps.db),
      rows: searchBodies(deps.db, query, { limit: Number(req.query.limit) || 50 }),
    });
  });

  router.get('/compare', (req, res) => {
    const first = getRequest(deps.db, String(req.query.a || ''));
    const second = getRequest(deps.db, String(req.query.b || ''));
    if (first === null || second === null) {
      res.status(404).json({ error: '兩筆紀錄都要存在才能比較' });
      return;
    }
    res.json({
      a: { id: first.id, ts: first.ts, url: first.url, status: first.status },
      b: { id: second.id, ts: second.ts, url: second.url, status: second.status },
      sameUrl: first.url === second.url,
      diff: lineDiff(first.resBody || '', second.resBody || ''),
    });
  });

  router.get('/sessions', (req, res) => {
    res.json({ rows: listSessions(deps.db, req.query.limit) });
  });

  router.get('/findings', (req, res) => {
    const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : null;
    res.json({ rows: listFindings(deps.db, sessionId, req.query.limit) });
  });

  router.post('/trace', (req, res) => {
    res.json(trace(deps.db, req.body || {}));
  });

  router.post('/replay', async (req, res, next) => {
    const body = req.body || {};
    if (typeof body.id !== 'string' || body.id === '') {
      res.status(400).json({ error: '要帶 id（要重放哪一筆）' });
      return;
    }

    let result;
    try {
      result = await replayRequest(deps.db, deps.config, body);
    } catch (error) {
      if (error.code === 'SSRF_BLOCKED' || error.code === 'UPSTREAM_FAILED') {
        res.status(502).json({ error: error.message });
        return;
      }
      next(error);
      return;
    }

    if (result.notFound) {
      res.status(404).json({ error: `找不到 request ${body.id}` });
      return;
    }
    if (result.needsConfirmation) {
      res.status(400).json(result);
      return;
    }
    if (result.badUrl) {
      res.status(400).json({ error: result.message });
      return;
    }
    res.json(result);
  });

  return router;
}

module.exports = { createNetworkApi };
